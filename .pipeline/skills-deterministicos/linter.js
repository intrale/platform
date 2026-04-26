#!/usr/bin/env node
/**
 * linter.js — Skill determinístico /linter (issue #2491)
 *
 * Separa la parte mecánica del review. Corre chequeos estáticos 100% en Node
 * (0 tokens LLM) y falla rápido si encuentra problemas bloqueantes (secretos,
 * strings prohibidos en UI, archivos sensibles). Si pasa, el flujo continúa a
 * la fase `aprobacion` donde el reviewer LLM se enfoca solo en calidad
 * semántica, recibiendo el reporte del linter como contexto.
 *
 * Contrato idéntico al resto de skills determinísticos:
 *   - Marker en `trabajando/<issue>.linter` (lo actualiza con resultado)
 *   - Heartbeat `agent-<issue>.heartbeat` cada 30s
 *   - Eventos `session:start` / `session:end` en activity-log
 *   - Exit 0 = linter OK (marker → aprobado), 1 = findings bloqueantes (rebote)
 *
 * CLI:
 *   node linter.js <issue> [--trabajando=<path>] [--base=origin/main]
 *
 * Env vars (pasadas por el Pulpo):
 *   PIPELINE_ISSUE, PIPELINE_SKILL, PIPELINE_FASE, PIPELINE_TRABAJANDO, PIPELINE_PIPELINE
 */

'use strict';

const fs = require('fs');
const path = require('path');
const trace = require('../lib/traceability');
const git = require('./lib/git-ops');
const checks = require('./lib/static-checks');

// REPO_ROOT → repo principal: donde el dashboard lee hooks (heartbeat) y
// logs (lint-<issue>-report.md). Siempre apunta al main worktree, aún si
// el linter se invoca desde un worktree paralelo del agente.
const REPO_ROOT = process.env.PIPELINE_REPO_ROOT || process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');
const HOOKS_DIR = path.join(REPO_ROOT, '.claude', 'hooks');
const LOG_DIR = path.join(REPO_ROOT, '.pipeline', 'logs');
// GIT_CWD → worktree del issue: el pulpo lanza el linter con cwd=worktreePath
// (fix #2537) para que `git log origin/main..HEAD` lea la rama correcta.
// Antes usábamos REPO_ROOT directo y el linter terminaba leyendo la rama
// arbitraria del repo principal (incidente #2407: branch=agent/2523-... para
// issue #2407, falso 'pr:no-commits'). Override por env var para tests.
const GIT_CWD = process.env.PIPELINE_GIT_CWD || process.cwd();
const HEARTBEAT_INTERVAL_MS = 30 * 1000;

function parseArgs(argv) {
    const args = { issue: null, trabajando: null, base: 'origin/main' };
    for (const a of argv.slice(2)) {
        if (/^\d+$/.test(a) && !args.issue) { args.issue = parseInt(a, 10); continue; }
        const kv = a.match(/^--([\w-]+)=(.+)$/);
        if (kv) {
            if (kv[1] === 'trabajando') args.trabajando = kv[2];
            else if (kv[1] === 'base') args.base = kv[2];
        }
    }
    args.issue = args.issue || (process.env.PIPELINE_ISSUE ? Number(process.env.PIPELINE_ISSUE) : null);
    args.trabajando = args.trabajando || process.env.PIPELINE_TRABAJANDO || null;
    return args;
}

function startHeartbeat(issue) {
    if (!issue) return { stop: () => {} };
    try { fs.mkdirSync(HOOKS_DIR, { recursive: true }); } catch {}
    const hbFile = path.join(HOOKS_DIR, `agent-${issue}.heartbeat`);
    const writeHb = () => {
        try {
            fs.writeFileSync(hbFile, JSON.stringify({
                issue, skill: 'linter', pid: process.pid, model: 'deterministic',
                ts: new Date().toISOString(),
            }) + '\n');
        } catch {}
    };
    writeHb();
    const iv = setInterval(writeHb, HEARTBEAT_INTERVAL_MS);
    iv.unref?.();
    return {
        stop: () => {
            clearInterval(iv);
            try { fs.unlinkSync(hbFile); } catch {}
        },
    };
}

function updateMarker(trabajandoPath, payload) {
    if (!trabajandoPath) return;
    try {
        let existing = '';
        if (fs.existsSync(trabajandoPath)) {
            existing = fs.readFileSync(trabajandoPath, 'utf8');
        }
        const lines = existing.split(/\r?\n/).filter(Boolean);
        const kept = [];
        for (const ln of lines) {
            const m = ln.match(/^([\w_]+)\s*:/);
            if (m && (m[1] in payload)) continue;
            kept.push(ln);
        }
        const appended = [];
        for (const [k, v] of Object.entries(payload)) {
            if (v === null || v === undefined) continue;
            const val = typeof v === 'string' ? JSON.stringify(v) : String(v);
            appended.push(`${k}: ${val}`);
        }
        fs.writeFileSync(trabajandoPath, [...kept, ...appended].join('\n') + '\n', 'utf8');
    } catch (e) {
        process.stderr.write(`[linter] No se pudo actualizar marker: ${e.message}\n`);
    }
}

function getCommitMessages(cwd, base) {
    const r = git.runGit(['log', `${base}..HEAD`, '--pretty=format:%B%n---COMMIT---'], { cwd });
    if (r.exit_code !== 0) return [];
    return (r.stdout || '')
        .split('---COMMIT---')
        .map((s) => s.trim())
        .filter(Boolean);
}

function getDiffText(cwd, base) {
    const r = git.runGit(['diff', `${base}...HEAD`], { cwd, timeoutMs: 60 * 1000 });
    return r.stdout || '';
}

function getChangedFilePaths(cwd, base) {
    const r = git.runGit(['diff', '--name-only', `${base}...HEAD`], { cwd });
    if (r.exit_code !== 0) return [];
    return (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Corre todos los chequeos estáticos sobre el estado actual del repo.
 * Separado para permitir tests con mocks sobre git-ops.
 */
function runAllChecks({ issue, cwd, base }) {
    const findings = [];
    const branch = git.getCurrentBranch(cwd);
    findings.push(...checks.checkBranchName(branch, { issue }));

    // Fetch origin/main — best-effort, no bloqueamos si falla
    const fetchRes = git.fetchOrigin(cwd);
    const hasBase = fetchRes.exit_code === 0;

    const commitMsgs = hasBase ? getCommitMessages(cwd, base) : [];
    const diffText = hasBase ? getDiffText(cwd, base) : '';
    const changedFiles = hasBase ? getChangedFilePaths(cwd, base) : [];
    const stats = hasBase ? git.getDiffStats(cwd, base) : { files_changed: 0, additions: 0, deletions: 0 };

    findings.push(...checks.checkClosesIssue(commitMsgs, issue));
    findings.push(...checks.checkCommitSubjects(commitMsgs));
    findings.push(...checks.checkSensitiveFiles(changedFiles));
    findings.push(...checks.checkSecretsInDiff(diffText));
    findings.push(...checks.checkForbiddenStringsInDiff(diffText));
    findings.push(...checks.checkDiffSize(stats));

    return { findings, branch, stats, commitCount: commitMsgs.length, fileCount: changedFiles.length };
}

async function main() {
    const args = parseArgs(process.argv);
    const issue = args.issue;

    if (!issue) {
        process.stderr.write('[linter] Falta issue (CLI o env PIPELINE_ISSUE).\n');
        process.exit(2);
    }

    try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
    const agentLog = path.join(LOG_DIR, `${issue}-linter.log`);
    const logAppend = (msg) => {
        try { fs.appendFileSync(agentLog, msg + '\n'); } catch {}
    };
    logAppend(`--- linter:#${issue} (deterministic) ${new Date().toISOString()} ---`);

    const hb = startHeartbeat(issue);
    const handle = trace.emitSessionStart({
        skill: 'linter', issue, phase: process.env.PIPELINE_FASE || 'linteo',
        model: 'deterministic',
    });

    const startedAt = Date.now();
    let exitCode = 0;
    let motivo = null;
    let result = null;
    let report = '';

    try {
        result = runAllChecks({ issue, cwd: GIT_CWD, base: args.base });
        logAppend(`[linter] branch=${result.branch} commits=${result.commitCount} files=${result.fileCount}`);
        logAppend(`[linter] diff=${result.stats.files_changed}f +${result.stats.additions} -${result.stats.deletions}`);

        const agg = checks.aggregate(result.findings);
        logAppend(`[linter] findings: errores=${agg.counts.error} warnings=${agg.counts.warn} info=${agg.counts.info}`);

        report = checks.renderMarkdownReport(result.findings, {
            issue,
            duration_ms: Date.now() - startedAt,
            branch: result.branch,
            stats: result.stats,
        });
        logAppend('[linter] --- REPORTE ---');
        logAppend(report);

        // Guardar reporte en ruta conocida para que el reviewer LLM pueda leerlo
        const reportPath = path.join(LOG_DIR, `lint-${issue}-report.md`);
        try { fs.writeFileSync(reportPath, report); } catch {}
        try {
            fs.writeFileSync(path.join(LOG_DIR, `lint-${issue}-report.json`), JSON.stringify({
                issue,
                branch: result.branch,
                stats: result.stats,
                findings: result.findings,
                aggregate: agg,
                generated_at: new Date().toISOString(),
            }, null, 2));
        } catch {}

        if (!agg.passed) {
            exitCode = 1;
            const firstError = result.findings.find((f) => f.severity === 'error');
            motivo = firstError
                ? `Linter bloqueó: ${firstError.rule} — ${firstError.message}${firstError.file ? ` (${firstError.file}${firstError.line ? `:${firstError.line}` : ''})` : ''}`
                : 'Linter bloqueó por findings de severidad error';
        } else if (agg.counts.warn > 0) {
            motivo = `Linter aprobado con ${agg.counts.warn} warning(s) — ver reporte`;
        } else {
            motivo = 'Linter aprobado sin findings bloqueantes';
        }
    } catch (e) {
        exitCode = 2;
        motivo = `Excepción en linter.js: ${e.message}`;
        logAppend(`[linter] EXCEPTION: ${e.stack || e.message}`);
    } finally {
        const totalMs = Date.now() - startedAt;
        const agg = result ? checks.aggregate(result.findings) : { counts: { error: 0, warn: 0, info: 0 }, total: 0 };

        updateMarker(args.trabajando, {
            resultado: exitCode === 0 ? 'aprobado' : 'rechazado',
            motivo: motivo || (exitCode === 0 ? 'Linter aprobado' : 'Linter rechazado'),
            linter_errors: agg.counts.error || 0,
            linter_warnings: agg.counts.warn || 0,
            linter_info: agg.counts.info || 0,
            linter_total_findings: agg.total || 0,
            linter_duration_ms: totalMs,
            linter_report_path: path.join(LOG_DIR, `lint-${issue}-report.md`),
            linter_mode: 'deterministic',
        });

        trace.emitSessionEnd(handle, {
            tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0,
            tool_calls: 1,
            exit_code: exitCode,
            duration_ms: totalMs,
        });

        hb.stop();
    }

    process.exit(exitCode);
}

if (require.main === module) {
    main().catch((e) => {
        process.stderr.write(`[linter] fatal: ${e.stack || e.message}\n`);
        process.exit(2);
    });
}

module.exports = {
    parseArgs,
    startHeartbeat,
    updateMarker,
    getCommitMessages,
    getDiffText,
    getChangedFilePaths,
    runAllChecks,
};

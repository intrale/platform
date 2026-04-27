#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const trace = require('../lib/traceability');
const git = require('./lib/git-ops');
const codeowners = require('./lib/codeowners');

// REPO_ROOT: ubicación central donde el pulpo escribe logs/heartbeats/markers.
// Siempre apunta al checkout principal del monorepo (no al worktree del agente),
// porque el pulpo lee/escribe esos archivos desde un único lugar.
const REPO_ROOT = process.env.PIPELINE_REPO_ROOT || process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');
const HOOKS_DIR = path.join(REPO_ROOT, '.claude', 'hooks');
const LOG_DIR = path.join(REPO_ROOT, '.pipeline', 'logs');

// WORK_DIR: directorio del worktree del agente — donde realmente vive la
// rama `agent/<issue>-*` y los cambios a entregar. Para fase `entrega` el
// pulpo nos spawnea con `cwd: <worktree>` (pulpo.js useExistingWorktree
// incluye 'entrega' desde #2519/#2547) y desde #2523 rev-1 además puede
// pasar PIPELINE_WORKTREE explícito.
//
// Sin esta separación, REPO_ROOT cae a `path.resolve(__dirname, '..', '..')`
// = `<monorepo>/platform` (el checkout principal compartido entre worktrees
// vía .git symlink) y todas las operaciones git corren contra la rama
// arbitraria del ROOT (típicamente `fix/dashboard-pause-optimistic-ui` o
// la sesión interactiva de Leo). Incidente real (#2523 rev-2, 2026-04-27
// 03:12 UTC):
//
//   delivery del #2523 corrió con cwd=ROOT y leyó branch=
//   `fix/dashboard-pause-optimistic-ui`, abortó con
//   `Worktree incorrecto: ... esperaba "agent/2523-"`.
//
// Mismo patrón de bug que linter.js #2523 rev-1 (ver linter.js L39-48).
const WORK_DIR = process.env.PIPELINE_WORKTREE || process.cwd() || REPO_ROOT;

const HEARTBEAT_INTERVAL_MS = 30 * 1000;

const QA_LABELS_OK = new Set(['qa:passed', 'qa:skipped']);

function parseArgs(argv) {
    const args = { issue: null, trabajando: null, autoMerge: true, dryRun: false };
    for (const a of argv.slice(2)) {
        if (/^\d+$/.test(a) && !args.issue) { args.issue = parseInt(a, 10); continue; }
        if (a === '--no-auto-merge') { args.autoMerge = false; continue; }
        if (a === '--dry-run') { args.dryRun = true; continue; }
        const kv = a.match(/^--([\w-]+)=(.+)$/);
        if (kv) {
            if (kv[1] === 'trabajando') args.trabajando = kv[2];
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
                issue, skill: 'delivery', pid: process.pid, model: 'deterministic',
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

function readMarker(trabajandoPath) {
    if (!trabajandoPath || !fs.existsSync(trabajandoPath)) return {};
    try {
        const txt = fs.readFileSync(trabajandoPath, 'utf8');
        const out = {};
        for (const ln of txt.split(/\r?\n/)) {
            const m = ln.match(/^([\w_]+)\s*:\s*(.*)$/);
            if (!m) continue;
            let v = m[2].trim();
            if (v.startsWith('"') && v.endsWith('"')) {
                try { v = JSON.parse(v); } catch {}
            }
            out[m[1]] = v;
        }
        return out;
    } catch { return {}; }
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
        process.stderr.write(`[delivery] No se pudo actualizar marker: ${e.message}\n`);
    }
}

function fetchIssueTitle(issue) {
    const r = git.runGh(['issue', 'view', String(issue), '--json', 'title,labels'], { cwd: WORK_DIR });
    if (r.exit_code !== 0) return { title: null, labels: [] };
    try {
        const json = JSON.parse(r.stdout);
        return {
            title: json.title || null,
            labels: (json.labels || []).map((l) => l.name),
        };
    } catch { return { title: null, labels: [] }; }
}

function findExistingPR(branch) {
    const r = git.runGh(['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,url,labels'], { cwd: WORK_DIR });
    if (r.exit_code !== 0) return null;
    try {
        const arr = JSON.parse(r.stdout);
        if (!arr.length) return null;
        return {
            number: arr[0].number,
            url: arr[0].url,
            labels: (arr[0].labels || []).map((l) => l.name),
        };
    } catch { return null; }
}

function getPRLabels(prNumber) {
    const r = git.runGh(['pr', 'view', String(prNumber), '--json', 'labels'], { cwd: WORK_DIR });
    if (r.exit_code !== 0) return [];
    try {
        return (JSON.parse(r.stdout).labels || []).map((l) => l.name);
    } catch { return []; }
}

function hasQaGate(labels) {
    return labels.some((l) => QA_LABELS_OK.has(l));
}

function getPRChangedPaths(prNumber) {
    const r = git.runGh(['pr', 'view', String(prNumber), '--json', 'files'], { cwd: WORK_DIR });
    if (r.exit_code !== 0) return [];
    try {
        return (JSON.parse(r.stdout).files || []).map((f) => f.path);
    } catch { return []; }
}

function applyNeedsHumanLabel(issue, prNumber, owners, repoRoot) {
    const lbl = git.runGh(
        ['issue', 'edit', String(issue), '--add-label', 'needs-human'],
        { cwd: repoRoot, timeoutMs: 30 * 1000 }
    );
    const ownersList = owners.join(' ');
    const body = `🛑 Merge bloqueado — este PR toca paths con CODEOWNERS humano (${ownersList}). Requiere review manual antes de mergear.`;
    const cmt = git.runGh(
        ['pr', 'comment', String(prNumber), '--body', body],
        { cwd: repoRoot, timeoutMs: 30 * 1000 }
    );
    return { labelExitCode: lbl.exit_code, commentExitCode: cmt.exit_code };
}

function tmpFile(prefix, content) {
    const file = path.join(LOG_DIR, `${prefix}-${process.pid}-${Date.now()}.tmp`);
    try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
    fs.writeFileSync(file, content, 'utf8');
    return file;
}

async function main() {
    const args = parseArgs(process.argv);
    const issue = args.issue;

    if (!issue) {
        process.stderr.write('[delivery] Falta issue (CLI o env PIPELINE_ISSUE).\n');
        process.exit(2);
    }

    try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
    const agentLog = path.join(LOG_DIR, `${issue}-delivery.log`);
    const logAppend = (msg) => {
        try { fs.appendFileSync(agentLog, msg + '\n'); } catch {}
    };
    logAppend(`--- delivery:#${issue} (deterministic) ${new Date().toISOString()} ---`);

    const hb = startHeartbeat(issue);
    const handle = trace.emitSessionStart({
        skill: 'delivery', issue, phase: process.env.PIPELINE_FASE || 'entrega',
        model: 'deterministic',
    });

    const startedAt = Date.now();
    const phases = {};
    let exitCode = 0;
    let motivo = null;
    let prNumber = null;
    let prUrl = null;
    let mergeSha = null;
    let labelsApplied = [];

    const phaseStart = () => Date.now();
    const phaseEnd = (key, t0) => { phases[key] = Date.now() - t0; };

    try {
        // ── Verificación previa ────────────────────────────────────────
        const branch = git.getCurrentBranch(WORK_DIR);
        if (!branch || branch === 'main' || branch === 'develop' || branch === 'HEAD') {
            throw new Error(`Rama inválida para delivery: "${branch}"`);
        }

        // #2519 (rev-1): salvaguarda contra ejecución desde el worktree equivocado.
        // Si delivery corre en ROOT (porque pulpo no resolvió el worktree del issue)
        // la rama detectada será la del repo principal, NO `agent/<issue>-*`.
        // En ese caso committeamos/rebaseamos/pusheamos a la rama de OTRO agente.
        // Mejor abortar fast-fail con mensaje claro que rebotar después de hacer
        // commits a la rama equivocada y recién fallar en el rebase.
        //
        // #2523 (rev-2): error message reporta WORK_DIR (no REPO_ROOT) porque
        // ese es el cwd real desde donde corrió git. REPO_ROOT siempre apunta
        // al checkout principal, lo cual confundía el diagnóstico.
        const expectedBranchPrefix = `agent/${issue}-`;
        if (!branch.startsWith(expectedBranchPrefix)) {
            throw new Error(
                `Worktree incorrecto: cwd=${WORK_DIR} está en rama "${branch}" pero ` +
                `delivery del #${issue} esperaba una rama que empiece con "${expectedBranchPrefix}". ` +
                `Probable causa: pulpo no resolvió el worktree del issue y delivery corrió en ROOT. ` +
                `Verificar pulpo.js useExistingWorktree incluye 'entrega'.`
            );
        }
        logAppend(`[delivery] cwd=${WORK_DIR} branch=${branch}`);

        const marker = readMarker(args.trabajando);
        const issueMeta = fetchIssueTitle(issue);
        const issueTitle = issueMeta.title || `entrega #${issue}`;
        logAppend(`[delivery] issue title="${issueTitle}" labels=${issueMeta.labels.join(',')}`);

        // ── Fase 1: stage + commit (si hay cambios sin commitear) ──────
        let t = phaseStart();
        const changed = git.getChangedFiles(WORK_DIR);
        const hasChanges = changed.length > 0;
        logAppend(`[delivery] cambios detectados: ${changed.length}`);

        if (hasChanges) {
            // Stagear todo lo modificado/untracked, EXCEPTO archivos sensibles del pipeline
            // que se mueven solos (heartbeats, registros internos, métricas, stackdumps).
            // #2519 (rev-1): ampliado a metrics-history.jsonl, *.heartbeat sueltos en root,
            // bash.exe.stackdump y otros artefactos no commiteables que aparecen en cualquier
            // worktree con pipeline en marcha.
            const SAFE_IGNORE = new RegExp(
                '^(?:' + [
                    '\\.claude\\/hooks\\/agent-\\d+\\.heartbeat',
                    '\\.claude\\/hooks\\/agent-registry\\.json',
                    '\\.claude\\/hooks\\/activity-log',
                    '\\.pipeline\\/metrics-history\\.jsonl',
                    '\\.pipeline\\/.*\\.heartbeat',
                    '.*\\.stackdump',
                ].join('|') + ')'
            );
            const stagePaths = changed
                .map((c) => c.path)
                .filter((p) => !SAFE_IGNORE.test(p));

            if (stagePaths.length) {
                const addRes = git.runGit(['add', '--', ...stagePaths], { cwd: WORK_DIR });
                if (addRes.exit_code !== 0) {
                    throw new Error(`git add falló: ${addRes.stderr || addRes.stdout}`);
                }
            }

            // Verificamos si quedó algo staged (puede ser que todo lo cambiado fuera ignored)
            const stagedCheck = git.runGit(['diff', '--cached', '--name-only'], { cwd: WORK_DIR });
            if (stagedCheck.stdout.trim()) {
                const commitMsg = git.buildCommitMessage({
                    issue, title: issueTitle,
                    body: `Entrega automatizada por pipeline V3 (delivery determinístico).`,
                    branch,
                    files: changed,
                });
                const msgFile = tmpFile('commit-msg', commitMsg);
                const commitRes = git.runGit(['commit', '-F', msgFile], { cwd: WORK_DIR });
                try { fs.unlinkSync(msgFile); } catch {}
                if (commitRes.exit_code !== 0) {
                    throw new Error(`git commit falló: ${commitRes.stderr || commitRes.stdout}`);
                }
                logAppend(`[delivery] commit creado`);
            } else {
                logAppend(`[delivery] no hay cambios staged tras filtrar archivos sensibles`);
            }
        }
        phaseEnd('stage_commit', t);

        // ── Fase 2: rebase contra origin/main ──────────────────────────
        // #2519 (rev-2): rebaseOnto usa --autostash. Necesario porque después
        // del commit pueden quedar archivos tracked modificados (heartbeats,
        // agent-registry, activity-logger, metrics-history) que SAFE_IGNORE
        // dejó fuera del staging — el pipeline sigue corriendo en paralelo y
        // los reescribe. Sin --autostash el rebase muere con "You have
        // unstaged changes" aunque sean estado transitorio.
        t = phaseStart();
        const fetchRes = git.fetchOrigin(WORK_DIR);
        if (fetchRes.exit_code !== 0) {
            logAppend(`[delivery] git fetch warning: ${fetchRes.stderr.slice(0, 200)}`);
        }
        const rebaseRes = git.rebaseOnto(WORK_DIR, 'origin/main');
        if (rebaseRes.exit_code !== 0) {
            // Conflicto irresoluble — abortar y rebote
            git.rebaseAbort(WORK_DIR);
            throw new Error(`Rebase conflict: ${rebaseRes.stderr.slice(0, 300) || rebaseRes.stdout.slice(0, 300)}`);
        }
        logAppend(`[delivery] rebase OK`);
        phaseEnd('rebase', t);

        // ── Fase 3: push ──────────────────────────────────────────────
        // #2523 (rev-3): pushAndVerify trata el caso "spawnSync devuelve error
        // pero el remote ya tiene el SHA" como éxito. Sin esto, pushes lentos
        // (~90-120s) en redes pesadas hacían rebotar al agente al circuit
        // breaker aunque el push hubiese completado en el remote.
        t = phaseStart();
        const pushRes = git.pushAndVerify(WORK_DIR, branch);
        if (pushRes.exit_code !== 0) {
            // Fallo real: remote no tiene nuestro SHA. Diagnóstico rico para
            // que el rebote sea accionable (signal, error, wall_ms, stderr).
            const diag = [
                `signal=${pushRes.signal || 'none'}`,
                `error=${pushRes.error || 'none'}`,
                `wall_ms=${pushRes.wall_ms}`,
                `local_sha=${(pushRes.local_sha || '').slice(0, 7) || 'n/a'}`,
                `remote_sha=${(pushRes.remote_sha || '').slice(0, 7) || 'n/a'}`,
            ].join(' ');
            const stderrMsg = (pushRes.stderr || '').slice(0, 200);
            throw new Error(`git push falló: ${stderrMsg || '(stderr vacío)'} [${diag}]`);
        }
        if (pushRes.recovered) {
            logAppend(`[delivery] push recovered: ${pushRes.recovered_reason}`);
        } else {
            logAppend(`[delivery] push OK`);
        }
        phaseEnd('push', t);

        // ── Fase 4: PR (crear o reutilizar) ───────────────────────────
        t = phaseStart();
        let pr = findExistingPR(branch);
        const stats = git.getDiffStats(WORK_DIR, 'origin/main');

        if (!pr) {
            // Determinar label QA: si el issue ya viene de un pipeline con QA, hereda;
            // si no, default qa:skipped (pipeline interno V3, sin impacto producto).
            const qaLabel = issueMeta.labels.includes('qa:passed') ? 'qa:passed'
                : issueMeta.labels.includes('qa:skipped') ? 'qa:skipped'
                : 'qa:skipped';

            const bodyTxt = git.buildPRBody({
                issue, title: issueTitle,
                summaryBullets: [
                    `Entrega automatizada por pipeline V3 (delivery determinístico)`,
                    `Cambios: ${stats.files_changed} archivos · +${stats.additions} -${stats.deletions}`,
                ],
                testPlan: [
                    `Pipeline V3 ejecutó builder + tester (gates verdes)`,
                    `QA: \`${qaLabel}\` aplicado por delivery`,
                ],
                qaLabel,
            });
            const bodyFile = tmpFile('pr-body', bodyTxt);
            const createArgs = [
                'pr', 'create',
                '--title', issueTitle,
                '--body-file', bodyFile,
                '--base', 'main',
                '--head', branch,
                '--assignee', 'leitolarreta',
                '--label', qaLabel,
            ];
            const createRes = git.runGh(createArgs, { cwd: WORK_DIR, timeoutMs: 90 * 1000 });
            try { fs.unlinkSync(bodyFile); } catch {}
            if (createRes.exit_code !== 0) {
                throw new Error(`gh pr create falló: ${createRes.stderr.slice(0, 300) || createRes.stdout.slice(0, 300)}`);
            }
            // gh imprime la URL del PR como última línea
            prUrl = (createRes.stdout || '').trim().split(/\r?\n/).pop().trim();
            const m = prUrl.match(/\/pull\/(\d+)/);
            prNumber = m ? parseInt(m[1], 10) : null;
            labelsApplied = [qaLabel];
            logAppend(`[delivery] PR #${prNumber} creado: ${prUrl}`);
        } else {
            prNumber = pr.number;
            prUrl = pr.url;
            labelsApplied = pr.labels;
            logAppend(`[delivery] PR existente #${prNumber}: ${prUrl}`);
        }
        phaseEnd('pr_create', t);

        // ── Fase 5: auto-merge si gate QA presente ────────────────────
        t = phaseStart();
        const finalLabels = getPRLabels(prNumber);
        labelsApplied = Array.from(new Set([...labelsApplied, ...finalLabels]));

        // #2652 — Detección de CODEOWNERS humano: si el PR toca paths protegidos
        // por un owner humano (ej. @leitolarreta), NO mergear automáticamente.
        // En su lugar: aplicar label `needs-human` al issue + comentar el PR
        // explicitando los owners requeridos. Esto evita merges silenciosos
        // sobre `.pipeline/` o `.github/` que requieren review manual.
        const ownerRules = codeowners.loadCodeowners(WORK_DIR);
        const changedForOwners = getPRChangedPaths(prNumber);
        const humanOwners = ownerRules.length && changedForOwners.length
            ? codeowners.getHumanOwners(ownerRules, changedForOwners)
            : [];
        if (humanOwners.length) {
            logAppend(`[delivery] CODEOWNERS humano detectado: ${humanOwners.join(' ')} — bloqueando auto-merge`);
        }

        if (!args.autoMerge) {
            logAppend(`[delivery] auto-merge desactivado por flag — PR queda abierto`);
            motivo = `PR #${prNumber} creado/actualizado. Auto-merge desactivado.`;
        } else if (!hasQaGate(finalLabels)) {
            // Sin gate QA → no mergeamos ciegamente; el delivery termina OK pero deja el PR abierto.
            motivo = `PR #${prNumber} creado pero sin label qa:passed/qa:skipped — merge bloqueado.`;
            logAppend(`[delivery] ${motivo}`);
        } else if (humanOwners.length) {
            applyNeedsHumanLabel(issue, prNumber, humanOwners, WORK_DIR);
            labelsApplied = Array.from(new Set([...labelsApplied, 'needs-human']));
            motivo = `PR #${prNumber} requiere review humano de ${humanOwners.join(' ')} — merge bloqueado, label needs-human aplicado.`;
            logAppend(`[delivery] ${motivo}`);
        } else {
            const mergeRes = git.runGh([
                'pr', 'merge', String(prNumber),
                '--squash', '--delete-branch',
                '--subject', `${issueTitle} (#${prNumber})`,
            ], { cwd: WORK_DIR, timeoutMs: 3 * 60 * 1000 });
            if (mergeRes.exit_code !== 0) {
                throw new Error(`gh pr merge falló: ${mergeRes.stderr.slice(0, 300) || mergeRes.stdout.slice(0, 300)}`);
            }
            // Resolver SHA del merge commit (best-effort)
            const fetchAfter = git.runGit(['fetch', 'origin', 'main'], { cwd: WORK_DIR });
            if (fetchAfter.exit_code === 0) {
                const sha = git.runGit(['rev-parse', 'origin/main'], { cwd: WORK_DIR });
                if (sha.exit_code === 0) mergeSha = sha.stdout.trim();
            }
            logAppend(`[delivery] PR #${prNumber} mergeado (squash) sha=${mergeSha || 'unknown'}`);
        }
        phaseEnd('pr_merge', t);

    } catch (e) {
        exitCode = 1;
        motivo = e.message.slice(0, 500);
        logAppend(`[delivery] ERROR: ${e.stack || e.message}`);
    } finally {
        const totalMs = Date.now() - startedAt;

        const reportLines = [
            `## Delivery: ${exitCode === 0 ? 'APROBADO ✅' : 'RECHAZADO ❌'}`,
            '',
            `- Issue: #${issue}  ·  PR: ${prNumber ? `#${prNumber}` : 'no creado'}  ·  Duración: ${(totalMs / 1000).toFixed(1)}s`,
            `- Modo: determinístico  ·  Auto-merge: ${args.autoMerge ? 'sí' : 'no'}`,
            `- Labels aplicados: ${labelsApplied.join(', ') || '(ninguno)'}`,
            `- Merge SHA: ${mergeSha || '(sin merge)'}`,
            '',
            '### Fases',
            ...Object.entries(phases).map(([k, ms]) => `- ${k}: ${(ms / 1000).toFixed(1)}s`),
            '',
        ];
        if (motivo) {
            reportLines.push('### Motivo / detalle');
            reportLines.push(`- ${motivo}`);
            reportLines.push('');
        }
        reportLines.push('### Veredicto');
        reportLines.push(exitCode === 0
            ? (mergeSha ? 'Entrega completada y mergeada a main.' : 'PR creado, esperando gate QA antes del merge.')
            : 'Delivery rechazado — ver motivo y rebote.');
        const report = reportLines.join('\n');
        logAppend('[delivery] --- REPORTE ---');
        logAppend(report);
        try {
            fs.writeFileSync(path.join(LOG_DIR, `delivery-${issue}-report.md`), report);
        } catch {}

        updateMarker(args.trabajando, {
            resultado: exitCode === 0 ? 'aprobado' : 'rechazado',
            motivo: motivo || (exitCode === 0 ? 'Entrega completada' : 'Delivery fallido'),
            delivery_pr_number: prNumber,
            delivery_pr_url: prUrl,
            delivery_merge_sha: mergeSha,
            delivery_labels: labelsApplied.join(','),
            delivery_duration_ms: totalMs,
            delivery_phases: JSON.stringify(phases),
            delivery_mode: 'deterministic',
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
        process.stderr.write(`[delivery] fatal: ${e.stack || e.message}\n`);
        process.exit(2);
    });
}

module.exports = {
    parseArgs,
    startHeartbeat,
    readMarker,
    updateMarker,
    fetchIssueTitle,
    findExistingPR,
    getPRLabels,
    getPRChangedPaths,
    applyNeedsHumanLabel,
    hasQaGate,
    QA_LABELS_OK,
    REPO_ROOT,
    WORK_DIR,
};

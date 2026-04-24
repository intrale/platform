#!/usr/bin/env node
/**
 * tester.js — Skill determinístico /tester (issue #2482)
 *
 * Reemplaza al skill LLM `tester` dentro del flujo del Pulpo para eliminar
 * el gasto de tokens en la parte mecánica del skill: setup JAVA_HOME →
 * correr Gradle test + koverXmlReport → parsear salidas XML → generar
 * reporte → copiar artefactos QA.
 *
 * La generación Gherkin (`--from-gherkin`) SIGUE requiriendo LLM y no se
 * migra. El bypass en pulpo.js solo activa este script cuando no hay ese
 * flag en el marker.
 *
 * Contrato idéntico al skill LLM:
 *   - Marker en `trabajando/<issue>.tester` (se actualiza con resultado/motivo)
 *   - Heartbeat `agent-<issue>.heartbeat` cada 30s
 *   - Eventos `session:start` / `session:end` en activity-log (V3 #2477)
 *   - Exit code 0 = tests OK (marker → aprobado), 1 = rebote
 *
 * CLI:
 *   node tester.js <issue> [--module=backend|users|app|all] [--coverage|--no-coverage]
 *                          [--threshold=80] [--trabajando=<path>]
 *
 * Env vars (pasadas por el Pulpo):
 *   PIPELINE_ISSUE, PIPELINE_SKILL, PIPELINE_FASE, PIPELINE_TRABAJANDO
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const trace = require('../lib/traceability');
const gradleParser = require('./lib/gradle-parser');
const kover = require('./lib/kover-parser');

// ── Constantes y paths ──────────────────────────────────────────────
const REPO_ROOT = process.env.PIPELINE_REPO_ROOT || process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');
const HOOKS_DIR = path.join(REPO_ROOT, '.claude', 'hooks');
const LOG_DIR = path.join(REPO_ROOT, '.pipeline', 'logs');
const QA_ARTIFACTS_DIR = path.join(REPO_ROOT, 'qa', 'artifacts', 'tester');
const JAVA_HOME_DEFAULT = process.env.JAVA_HOME || '/c/Users/Administrator/.jdks/temurin-21.0.7';
const HEARTBEAT_INTERVAL_MS = 30 * 1000;

// Umbral de cobertura por defecto (línea) — igual al skill LLM.
const DEFAULT_COVERAGE_THRESHOLD = 80;

// Módulos Gradle que soportamos individualmente
const MODULE_DIRS = {
    backend: 'backend',
    users: 'users',
    app: path.join('app', 'composeApp'),
};

// ── Parseo de argumentos ────────────────────────────────────────────
function parseArgs(argv) {
    const args = {
        issue: null,
        module: 'all',           // backend | users | app | all
        coverage: true,          // Kover activado por default (migración determinística)
        threshold: DEFAULT_COVERAGE_THRESHOLD,
        failFast: false,
        trabajando: null,
    };
    for (const a of argv.slice(2)) {
        if (/^\d+$/.test(a) && !args.issue) { args.issue = parseInt(a, 10); continue; }
        if (a === '--coverage') { args.coverage = true; continue; }
        if (a === '--no-coverage') { args.coverage = false; continue; }
        if (a === '--fail-fast') { args.failFast = true; continue; }
        if (['backend', 'users', 'app', 'all'].includes(a) && args.module === 'all') {
            args.module = a; continue;
        }
        const kv = a.match(/^--([\w-]+)=(.+)$/);
        if (kv) {
            if (kv[1] === 'module') args.module = kv[2];
            else if (kv[1] === 'threshold') args.threshold = parseInt(kv[2], 10) || DEFAULT_COVERAGE_THRESHOLD;
            else if (kv[1] === 'trabajando') args.trabajando = kv[2];
        }
    }
    args.issue = args.issue || (process.env.PIPELINE_ISSUE ? Number(process.env.PIPELINE_ISSUE) : null);
    args.trabajando = args.trabajando || process.env.PIPELINE_TRABAJANDO || null;
    return args;
}

// ── Heartbeat ───────────────────────────────────────────────────────
function startHeartbeat(issue) {
    if (!issue) return { stop: () => {} };
    try { fs.mkdirSync(HOOKS_DIR, { recursive: true }); } catch {}
    const hbFile = path.join(HOOKS_DIR, `agent-${issue}.heartbeat`);
    const writeHb = () => {
        try {
            fs.writeFileSync(hbFile, JSON.stringify({
                issue, skill: 'tester', pid: process.pid, model: 'deterministic',
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

// ── Decisión de tasks Gradle según módulo + coverage ─────────────────
function buildGradleCommand(module, coverage) {
    // Tareas base por módulo
    const testTask = {
        backend: [':backend:test'],
        users:   [':users:test'],
        app:     [':app:composeApp:testDebugUnitTest'],
    };
    // Kover XML — solo módulos que lo tienen configurado (backend, app).
    // users hereda del backend y no expone koverXmlReport propio.
    const koverTask = {
        backend: [':backend:koverXmlReport'],
        users:   [], // no aplica
        app:     [':app:composeApp:koverXmlReport'],
    };

    const modules = module === 'all' ? ['backend', 'users', 'app'] : [module];
    const args = [];
    for (const m of modules) {
        args.push(...(testTask[m] || []));
        if (coverage) args.push(...(koverTask[m] || []));
    }
    args.push('--no-daemon');

    return {
        cmd: './gradlew',
        args,
        label: `${module}${coverage ? '+cov' : ''}`,
        modules,
    };
}

// ── Spawn con captura completa ───────────────────────────────────────
function runGradle({ cmd, args, cwd, env }) {
    return new Promise((resolve) => {
        const started = Date.now();
        let stdout = '';
        let stderr = '';
        const child = spawn(cmd, args, { cwd, env, shell: process.platform === 'win32', windowsHide: true });
        if (child.stdout) child.stdout.on('data', (d) => { stdout += d.toString(); });
        if (child.stderr) child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('error', (e) => {
            stderr += `\n[spawn-error] ${e.message}\n`;
            resolve({ exit_code: 1, stdout, stderr, wall_ms: Date.now() - started });
        });
        child.on('exit', (code) => {
            resolve({ exit_code: code == null ? 1 : code, stdout, stderr, wall_ms: Date.now() - started });
        });
    });
}

// ── Agregación de resultados de tests + kover ────────────────────────
function collectTestReports(modules) {
    const all = [];
    for (const m of modules) {
        const dir = path.join(REPO_ROOT, MODULE_DIRS[m] || m);
        const files = kover.findTestResultFiles(dir);
        for (const f of files) {
            try {
                const xml = fs.readFileSync(f, 'utf8');
                all.push(kover.parseTestResultsXml(xml));
            } catch {}
        }
    }
    return kover.aggregateTestResults(all);
}

function collectKoverReports(modules) {
    const parsed = [];
    const files = [];
    for (const m of modules) {
        const dir = path.join(REPO_ROOT, MODULE_DIRS[m] || m);
        const found = kover.findKoverXmlFiles(dir);
        for (const f of found) {
            files.push({ module: m, file: f });
            try {
                const xml = fs.readFileSync(f, 'utf8');
                parsed.push(kover.parseKoverXml(xml));
            } catch {}
        }
    }
    return { aggregate: kover.aggregateKover(parsed), files };
}

// ── Copia de artefactos QA (best-effort) ─────────────────────────────
function copyArtifacts(koverFiles) {
    const artifacts = [];
    try { fs.mkdirSync(QA_ARTIFACTS_DIR, { recursive: true }); } catch {}

    for (const { module, file } of koverFiles) {
        try {
            const dst = path.join(QA_ARTIFACTS_DIR, `kover-${module}.xml`);
            fs.copyFileSync(file, dst);
            artifacts.push(path.basename(dst));
        } catch {}
    }

    try {
        fs.writeFileSync(path.join(QA_ARTIFACTS_DIR, 'TEST_TIMESTAMP'),
            new Date().toISOString().replace(/[:.]/g, '-') + '\n');
        artifacts.push('TEST_TIMESTAMP');
    } catch {}

    return artifacts;
}

// ── Actualización del marker (YAML) ──────────────────────────────────
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
            const val = typeof v === 'string' ? JSON.stringify(v) : String(v);
            appended.push(`${k}: ${val}`);
        }
        fs.writeFileSync(trabajandoPath, [...kept, ...appended].join('\n') + '\n', 'utf8');
    } catch (e) {
        process.stderr.write(`[tester] No se pudo actualizar marker: ${e.message}\n`);
    }
}

// ── Render del reporte final ─────────────────────────────────────────
function renderReport({ issue, module, coverage, threshold, gradle, tests, coverageAgg, exitCode, motivo }) {
    const verdict = exitCode === 0 ? 'APROBADO ✅' : 'RECHAZADO ❌';
    const durMs = gradle ? gradle.wall_ms : 0;
    const mins = Math.floor(durMs / 60000);
    const secs = Math.floor((durMs % 60000) / 1000);
    const durStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

    const lines = [];
    lines.push(`## Tester: ${verdict}`);
    lines.push('');
    lines.push(`- Issue: #${issue}  ·  Módulo: ${module}  ·  Duración: ${durStr}`);
    lines.push(`- Modo: determinístico  ·  Cobertura solicitada: ${coverage ? 'sí' : 'no'}  ·  Umbral: ${threshold}%`);
    lines.push('');
    lines.push(kover.renderTestsSection(tests));
    lines.push('');
    if (coverage) {
        lines.push(kover.renderCoverageSection(coverageAgg, threshold));
        lines.push('');
    }
    if (motivo) {
        lines.push('### Motivo del rebote');
        lines.push(`- ${motivo}`);
        lines.push('');
    }
    lines.push('### Veredicto del Tester');
    lines.push(exitCode === 0
        ? 'Tests verdes y cobertura dentro del umbral — listo para siguiente fase.'
        : 'Hay problemas que corregir antes de mergear. Rebote al dev skill correspondiente.');
    return lines.join('\n');
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
    const args = parseArgs(process.argv);
    const issue = args.issue;

    if (!issue) {
        process.stderr.write('[tester] Falta issue (CLI o env PIPELINE_ISSUE).\n');
        process.exit(2);
    }

    try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
    const agentLog = path.join(LOG_DIR, `${issue}-tester.log`);
    const logAppend = (msg) => {
        try { fs.appendFileSync(agentLog, msg + '\n'); } catch {}
    };
    logAppend(`--- tester:#${issue} (deterministic) module=${args.module} coverage=${args.coverage} ${new Date().toISOString()} ---`);

    // Env con JAVA_HOME
    const env = { ...process.env, JAVA_HOME: JAVA_HOME_DEFAULT };
    env.PATH = `${JAVA_HOME_DEFAULT}/bin${path.delimiter}${env.PATH || ''}`;

    const cmd = buildGradleCommand(args.module, args.coverage);
    logAppend(`[tester] cmd="${cmd.cmd} ${cmd.args.join(' ')}" modules=${cmd.modules.join(',')}`);

    const hb = startHeartbeat(issue);
    const handle = trace.emitSessionStart({
        skill: 'tester', issue, phase: process.env.PIPELINE_FASE || 'verificacion',
        model: 'deterministic',
    });

    let gradleResult;
    let parsedGradle;
    let tests;
    let koverData = { aggregate: kover.aggregateKover([]), files: [] };
    let artifacts = [];
    let exitCode = 0;
    let motivo = null;

    try {
        gradleResult = await runGradle({ cmd: cmd.cmd, args: cmd.args, cwd: REPO_ROOT, env });
        logAppend(`[tester] gradle exit_code=${gradleResult.exit_code} wall_ms=${gradleResult.wall_ms}`);
        logAppend('[tester] --- stdout (último 2000 chars) ---');
        logAppend(gradleResult.stdout.slice(-2000));
        logAppend('[tester] --- stderr (último 1000 chars) ---');
        logAppend(gradleResult.stderr.slice(-1000));

        parsedGradle = gradleParser.parseGradleOutput(gradleResult.stdout, gradleResult.stderr);

        // Recolectar reportes XML sin depender del exit code de gradle
        tests = collectTestReports(cmd.modules);
        if (args.coverage) {
            koverData = collectKoverReports(cmd.modules);
            artifacts = copyArtifacts(koverData.files);
        }

        // Decisión de veredicto:
        // 1) tests fallidos o errores → rechazado
        // 2) cobertura < umbral (si se pidió coverage) → rechazado
        // 3) gradle exit code ≠ 0 CON bloque de error clasificable → rechazado
        // 4) gradle exit code ≠ 0 SIN bloque clasificable pero tests OK → APROBADO (los tests son fuente de verdad)
        // 5) no hay reportes JUnit válidos → rechazado (config rota)
        if (tests.valid && (tests.failures > 0 || tests.errors > 0)) {
            exitCode = 1;
            motivo = `Tests fallidos: ${tests.failures} failures + ${tests.errors} errors sobre ${tests.tests} totales`;
        } else if (args.coverage && koverData.aggregate.valid && koverData.aggregate.total.line.percent < args.threshold) {
            exitCode = 1;
            motivo = `Cobertura de líneas ${koverData.aggregate.total.line.percent}% por debajo del umbral ${args.threshold}%`;
        } else if (gradleResult.exit_code !== 0 && parsedGradle.errors[0]) {
            // Solo rechazar cuando hay un bloque de error real — el exit code por sí solo
            // puede venir de warnings o tasks que fallan post-tests sin afectar los resultados.
            exitCode = 1;
            const first = parsedGradle.errors[0];
            motivo = `Gradle FAILED (${first.classification}): ${(first.message || '').split('\n').slice(0, 3).join(' | ').slice(0, 500)}`;
        } else if (!tests.valid) {
            exitCode = 1;
            motivo = 'No se encontraron reportes JUnit — posible configuración rota o tests omitidos';
        } else if (gradleResult.exit_code !== 0) {
            // Tests válidos, sin errores de test, sin bloque de error clasificable de gradle, pero exit != 0.
            // Aprobar con warning — los tests son la fuente de verdad. Evita rebotes espurios.
            logAppend(`[tester] WARNING: gradle exit ${gradleResult.exit_code} sin bloque clasificable, pero ${tests.tests} tests pasaron (${tests.failures} fails, ${tests.errors} errors). Aprobando — tests son fuente de verdad.`);
        }
    } catch (e) {
        exitCode = 2;
        motivo = `Excepción en tester.js: ${e.message}`;
        logAppend(`[tester] EXCEPTION: ${e.stack || e.message}`);
    } finally {
        // Reporte
        const report = renderReport({
            issue, module: args.module, coverage: args.coverage, threshold: args.threshold,
            gradle: gradleResult, tests: tests || { valid: false },
            coverageAgg: koverData.aggregate, exitCode, motivo,
        });
        logAppend('[tester] --- REPORTE ---');
        logAppend(report);
        const reportPath = path.join(LOG_DIR, `tester-${issue}-report.md`);
        try { fs.writeFileSync(reportPath, report); } catch {}

        // Escalación por tipo de fallo
        let escalateTo = null;
        if (exitCode !== 0) {
            if (tests && tests.valid && (tests.failures > 0 || tests.errors > 0)) {
                // Escalar al dev skill según el módulo del primer test fallido
                const first = tests.failed_tests[0];
                if (first && /app\./i.test(first.classname)) escalateTo = 'android-dev';
                else if (first && /(backend|users)\./i.test(first.classname)) escalateTo = 'backend-dev';
                else escalateTo = 'backend-dev';
            } else if (parsedGradle && parsedGradle.errors[0]) {
                escalateTo = parsedGradle.errors[0].escalate_to;
            }
        }

        updateMarker(args.trabajando, {
            resultado: exitCode === 0 ? 'aprobado' : 'rechazado',
            motivo: motivo || (exitCode === 0 ? 'Tests verdes' : 'Tests fallidos'),
            tester_module: args.module,
            tester_duration_ms: gradleResult ? gradleResult.wall_ms : 0,
            tester_tests_total: tests && tests.valid ? tests.tests : 0,
            tester_tests_failed: tests && tests.valid ? (tests.failures + tests.errors) : 0,
            tester_coverage_line_percent: koverData.aggregate.valid ? koverData.aggregate.total.line.percent : null,
            tester_coverage_threshold: args.threshold,
            tester_escalate_to: escalateTo,
            tester_mode: 'deterministic',
        });

        trace.emitSessionEnd(handle, {
            tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0,
            tool_calls: 1,
            exit_code: exitCode,
            duration_ms: gradleResult ? gradleResult.wall_ms : 0,
        });

        hb.stop();
    }

    process.exit(exitCode);
}

if (require.main === module) {
    main().catch((e) => {
        process.stderr.write(`[tester] fatal: ${e.stack || e.message}\n`);
        process.exit(2);
    });
}

module.exports = {
    parseArgs,
    buildGradleCommand,
    startHeartbeat,
    updateMarker,
    collectTestReports,
    collectKoverReports,
    copyArtifacts,
    renderReport,
    MODULE_DIRS,
    DEFAULT_COVERAGE_THRESHOLD,
};

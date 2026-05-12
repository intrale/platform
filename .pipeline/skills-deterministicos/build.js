#!/usr/bin/env node
/**
 * build.js — Skill determinístico /build (issue #2476, rename #3157)
 *
 * Reemplaza al skill LLM `build` dentro del flujo del Pulpo para eliminar
 * el gasto de tokens en un proceso 100% mecánico: setup JAVA_HOME → correr
 * Gradle → parsear output → generar reporte → copiar artefactos QA.
 *
 * Contrato idéntico al skill LLM:
 *   - Marker en `trabajando/<issue>.build` (lo lee y actualiza con resultado)
 *   - Heartbeat `agent-<issue>.heartbeat` cada 30s
 *   - Eventos `session:start` / `session:end` en activity-log
 *   - Exit code 0 = build OK (marker → aprobado), 1 = build FAIL (rebote)
 *
 * CLI:
 *   node build.js <issue> [--scope=smart|clean|fast|all] [--module=<name>] [--trabajando=<path>]
 *
 * Env vars (pasadas por el Pulpo):
 *   PIPELINE_ISSUE, PIPELINE_SKILL, PIPELINE_FASE, PIPELINE_TRABAJANDO, PIPELINE_PIPELINE
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const trace = require('../lib/traceability');
const { parseGradleOutput, renderMarkdownReport } = require('./lib/gradle-parser');

// ── Constantes y paths ──────────────────────────────────────────────
// REPO_ROOT: main checkout (shared outputs — logs, QA artifacts, hooks).
// WORKTREE_ROOT: agent's worktree (compilation source, gradle cwd, artifact sources).
// Cuando no hay worktree (test, scope all desde root) cae a REPO_ROOT.
//
// CRÍTICO: hasta este fix gradle se ejecutaba en cwd=REPO_ROOT siempre. Eso
// causaba dos regresiones acopladas (rebote build #3073 rev-1, 2026-05-12):
//   1. smart-build.sh calculaba `git diff origin/main...HEAD` desde el main
//      checkout (rama distinta a la del agente) → detectaba 1156 archivos
//      falsos y disparaba `./gradlew check` aunque el agente solo tocara
//      `.pipeline/*`.
//   2. Varios builds concurrentes compartían `platform/.gradle/` → colisión
//      en el lock `buildOutputCleanup` (PID 6400 vs 10720 en el incidente).
// Con PIPELINE_WORKTREE como cwd, cada worktree usa su propio `.gradle/`
// y el diff de smart-build resuelve contra la rama del agente.
const REPO_ROOT = process.env.PIPELINE_REPO_ROOT || process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');
const WORKTREE_ROOT = process.env.PIPELINE_WORKTREE || REPO_ROOT;
const HOOKS_DIR = path.join(REPO_ROOT, '.claude', 'hooks');
const LOG_DIR = path.join(REPO_ROOT, '.pipeline', 'logs');
const QA_ARTIFACTS_DIR = path.join(REPO_ROOT, 'qa', 'artifacts');
const JAVA_HOME_DEFAULT = process.env.JAVA_HOME || '/c/Users/Administrator/.jdks/temurin-21.0.7';
const HEARTBEAT_INTERVAL_MS = 30 * 1000;

// ── Parseo de argumentos ────────────────────────────────────────────
function parseArgs(argv) {
    const args = { issue: null, scope: 'smart', module: null, trabajando: null };
    for (const a of argv.slice(2)) {
        if (/^\d+$/.test(a) && !args.issue) { args.issue = parseInt(a, 10); continue; }
        if (a === '--clean') { args.scope = 'clean'; continue; }
        if (a === '--fast') { args.scope = 'fast'; continue; }
        if (a === '--all') { args.scope = 'all'; continue; }
        if (a === '--verify') { args.scope = 'verify'; continue; }
        const kv = a.match(/^--([\w-]+)=(.+)$/);
        if (kv) {
            if (kv[1] === 'scope') args.scope = kv[2];
            else if (kv[1] === 'module') args.module = kv[2];
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
                issue, skill: 'build', pid: process.pid, model: 'deterministic',
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

// ── Decisión de scope → comando Gradle ───────────────────────────────
function buildGradleCommand(scope, mod) {
    // Devuelve { cmd, args, label } — cmd es 'bash' o './gradlew'
    if (mod) {
        const moduleTask = mod === 'app' ? ':app:composeApp:check' : `:${mod}:check`;
        return { cmd: './gradlew', args: [moduleTask, '--no-daemon'], label: `module:${mod}` };
    }
    switch (scope) {
        case 'clean':
            return { cmd: './gradlew', args: ['clean', 'build', '--no-daemon'], label: 'clean-build' };
        case 'fast':
            return { cmd: './gradlew', args: [':app:composeApp:compileKotlinJvm', '--no-daemon'], label: 'fast' };
        case 'all':
            return { cmd: 'bash', args: ['scripts/smart-build.sh', '--all'], label: 'all' };
        case 'verify':
            return { cmd: './gradlew', args: ['verifyNoLegacyStrings', ':app:composeApp:validateComposeResources', ':app:composeApp:scanNonAsciiFallbacks', '--no-daemon'], label: 'verify' };
        case 'smart':
        default:
            return { cmd: 'bash', args: ['scripts/smart-build.sh'], label: 'smart' };
    }
}

// ── Resolución de `bash` en Windows ──────────────────────────────────
// Cuando `spawn('bash', args, { shell: true })` corre en Windows, Node
// delega a `cmd.exe /d /s /c "bash ..."`. cmd.exe busca `bash` en el PATH
// del sistema, donde típicamente aparece primero `C:\Windows\System32\
// bash.exe` (wrapper a WSL). Si la máquina no tiene una distro Linux
// instalada en WSL, ese wrapper falla con:
//   <3>WSL (9 - Relay) ERROR: CreateProcessCommon:818:
//     execvpe(/bin/bash) failed: No such file or directory
// y el build muere en ~4s sin output (regresión vista en builds desde
// que `build` pasó a determinístico — #3157).
//
// Solución: en Windows, resolver explícitamente a Git Bash (que viene
// con Git for Windows y está instalado en todos los workstations del
// pipeline). Se usa `shell: false` cuando hay path absoluto a bash.exe
// para que cmd.exe no se entrometa con la resolución (y para que no
// rompa el path con espacios de "Program Files").
//
// Devuelve { cmd, useShell } — el caller debe usar ambos al spawn.
function resolveBashCommand(cmd) {
    if (process.platform !== 'win32') {
        return { cmd, useShell: false };
    }
    if (cmd !== 'bash') {
        // ./gradlew y otros: usar shell para que cmd.exe encuentre .bat
        return { cmd, useShell: true };
    }
    const candidates = [
        process.env.GIT_BASH_PATH,
        'C:\\Program Files\\Git\\bin\\bash.exe',
        'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
        'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    ].filter(Boolean);
    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate)) {
                return { cmd: candidate, useShell: false };
            }
        } catch {}
    }
    // No se encontró Git Bash — fallback a 'bash' por PATH (puede caer
    // en WSL bash). Mejor fallar con stack trace claro que silenciosamente.
    return { cmd, useShell: true };
}

// ── Spawn con captura completa ───────────────────────────────────────
function runGradle({ cmd, args, cwd, env }) {
    return new Promise((resolve) => {
        const started = Date.now();
        let stdout = '';
        let stderr = '';
        const { cmd: resolvedCmd, useShell } = resolveBashCommand(cmd);
        const child = spawn(resolvedCmd, args, { cwd, env, shell: useShell, windowsHide: true });
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

// ── Copia de artefactos QA (best-effort) ─────────────────────────────
function copyArtifacts(result) {
    const artifacts = [];
    try { fs.mkdirSync(QA_ARTIFACTS_DIR, { recursive: true }); } catch {}

    const tryCopy = (src, dst) => {
        try {
            if (fs.existsSync(src)) {
                fs.copyFileSync(src, dst);
                artifacts.push(path.basename(dst));
            }
        } catch (e) {
            // no rompemos el build por un error de copia
        }
    };

    // Source paths viven en el worktree (la build corrió ahí); destino en el
    // main checkout (qa/artifacts/ es compartido). En tests sin PIPELINE_WORKTREE
    // WORKTREE_ROOT === REPO_ROOT, así que se mantiene compat con fixtures.
    if (result.modules.includes('users')) {
        tryCopy(path.join(WORKTREE_ROOT, 'users', 'build', 'libs', 'users-all.jar'),
            path.join(QA_ARTIFACTS_DIR, 'users-all.jar'));
    }

    if (result.modules.includes('app')) {
        // Buscar primer APK client debug
        try {
            const apkDir = path.join(WORKTREE_ROOT, 'app', 'composeApp', 'build', 'outputs', 'apk', 'client', 'debug');
            if (fs.existsSync(apkDir)) {
                const apk = fs.readdirSync(apkDir).find((f) => f.endsWith('.apk'));
                if (apk) tryCopy(path.join(apkDir, apk), path.join(QA_ARTIFACTS_DIR, 'composeApp-client-debug.apk'));
            }
        } catch {}
    }

    // Metadata (sin necesidad de git — el Pulpo ya valida la rama)
    try {
        fs.writeFileSync(path.join(QA_ARTIFACTS_DIR, 'BUILD_TIMESTAMP'),
            new Date().toISOString().replace(/[:.]/g, '-') + '\n');
        artifacts.push('BUILD_TIMESTAMP');
    } catch {}

    return artifacts;
}

// ── Actualización del marker (YAML trabajando/) ──────────────────────
function updateMarker(trabajandoPath, payload) {
    if (!trabajandoPath) return;
    try {
        let existing = '';
        if (fs.existsSync(trabajandoPath)) {
            existing = fs.readFileSync(trabajandoPath, 'utf8');
        }
        // Agregado simple — el pulpo lee con js-yaml; mantenemos formato key: value
        const lines = existing.split(/\r?\n/).filter(Boolean);
        const seen = new Set();
        const kept = [];
        for (const ln of lines) {
            const m = ln.match(/^([\w_]+)\s*:/);
            if (m && (m[1] in payload)) { seen.add(m[1]); continue; }
            kept.push(ln);
        }
        const appended = [];
        for (const [k, v] of Object.entries(payload)) {
            const val = typeof v === 'string' ? JSON.stringify(v) : String(v);
            appended.push(`${k}: ${val}`);
        }
        fs.writeFileSync(trabajandoPath, [...kept, ...appended].join('\n') + '\n', 'utf8');
    } catch (e) {
        process.stderr.write(`[build] No se pudo actualizar marker: ${e.message}\n`);
    }
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
    const args = parseArgs(process.argv);
    const issue = args.issue;
    const scope = args.scope;

    if (!issue) {
        process.stderr.write('[build] Falta issue (CLI o env PIPELINE_ISSUE).\n');
        process.exit(2);
    }

    // Log header al agent log
    try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
    const agentLog = path.join(LOG_DIR, `${issue}-build.log`);
    const logAppend = (msg) => {
        try { fs.appendFileSync(agentLog, msg + '\n'); } catch {}
    };
    logAppend(`--- build:#${issue} (deterministic) scope=${scope} ${new Date().toISOString()} ---`);

    // Env con JAVA_HOME
    const env = { ...process.env, JAVA_HOME: JAVA_HOME_DEFAULT };
    // PATH con JAVA_HOME/bin al frente (para que gradlew encuentre java)
    env.PATH = `${JAVA_HOME_DEFAULT}/bin${path.delimiter}${env.PATH || ''}`;

    const { cmd, args: gArgs, label } = buildGradleCommand(scope, args.module);
    logAppend(`[build] scope=${label} cmd="${cmd} ${gArgs.join(' ')}"`);

    // Heartbeat + session:start
    const hb = startHeartbeat(issue);
    const handle = trace.emitSessionStart({
        skill: 'build', issue, phase: process.env.PIPELINE_FASE || 'build',
        model: 'deterministic',
        provider: 'deterministic',
    });

    let gradleResult;
    let parsed;
    let report;
    let artifacts = [];
    let exitCode = 0;
    let motivo = null;

    try {
        // cwd: WORKTREE_ROOT — gradle corre en la rama del agente, no en main.
        // Ver constantes arriba para el contexto del incidente que motivó este split.
        gradleResult = await runGradle({ cmd, args: gArgs, cwd: WORKTREE_ROOT, env });
        logAppend(`[build] gradle exit_code=${gradleResult.exit_code} wall_ms=${gradleResult.wall_ms}`);
        logAppend('[build] --- stdout (último 2000 chars) ---');
        logAppend(gradleResult.stdout.slice(-2000));
        logAppend('[build] --- stderr (último 1000 chars) ---');
        logAppend(gradleResult.stderr.slice(-1000));

        parsed = parseGradleOutput(gradleResult.stdout, gradleResult.stderr);

        // Guard defensivo: si Gradle salió 0 pero el parser no detectó status,
        // asumimos no-op (smart-build sin módulos compilables). Evita rebote
        // espurio por output no reconocido. Si exit_code != 0, sí es fallo real.
        if (gradleResult.exit_code === 0 && parsed.build_status === 'UNKNOWN') {
            parsed.success = true;
            parsed.build_status = 'NO_OP';
            logAppend('[build] no-op detectado por exit_code=0 sin BUILD SUCCESSFUL/FAILED (heurística defensiva)');
        }

        if (parsed.success) {
            artifacts = copyArtifacts(parsed);
            logAppend(`[build] artefactos copiados: ${artifacts.join(', ') || '(ninguno)'}`);
            exitCode = 0;
        } else {
            exitCode = 1;
            const first = parsed.errors[0];
            motivo = first
                ? `Build FAILED (${first.classification}): ${(first.message || '').split('\n').slice(0, 3).join(' | ').slice(0, 500)}`
                : 'Build FAILED sin error clasificado';
        }

        report = renderMarkdownReport(parsed, {
            issue, scope: label, duration_override_ms: gradleResult.wall_ms,
        });
        // Escribir reporte al log + a disco
        logAppend('[build] --- REPORTE ---');
        logAppend(report);
        const reportPath = path.join(LOG_DIR, `build-${issue}-report.md`);
        try { fs.writeFileSync(reportPath, report); } catch {}
    } catch (e) {
        exitCode = 2;
        motivo = `Excepción en build.js: ${e.message}`;
        logAppend(`[build] EXCEPTION: ${e.stack || e.message}`);
    } finally {
        // Actualizar marker con resultado
        updateMarker(args.trabajando, {
            resultado: exitCode === 0 ? 'aprobado' : 'rechazado',
            motivo: motivo || (exitCode === 0 ? 'Build exitoso' : 'Build fallido'),
            build_scope: label,
            build_duration_ms: gradleResult ? gradleResult.wall_ms : 0,
            build_classification: parsed && parsed.errors[0] ? parsed.errors[0].classification : null,
            build_escalate_to: parsed && parsed.errors[0] ? parsed.errors[0].escalate_to : null,
            build_mode: 'deterministic',
        });

        // session:end
        trace.emitSessionEnd(handle, {
            tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0,
            tool_calls: 1, // 1 spawn de gradle
            exit_code: exitCode,
            duration_ms: gradleResult ? gradleResult.wall_ms : 0,
        });

        hb.stop();
    }

    process.exit(exitCode);
}

// Ejecutar solo si es invocado como CLI (no cuando es require()eado en tests)
if (require.main === module) {
    if (process.argv.includes('--self-check')) {
        const { runSelfCheck } = require('./lib/self-check');
        runSelfCheck('build', [
            { name: 'parseArgs sin argumentos', fn: () => {
                const a = parseArgs(['node', 'build.js']);
                if (typeof a !== 'object' || a === null) throw new Error('parseArgs no devuelve objeto');
                if (a.scope !== 'smart') throw new Error(`scope default esperado 'smart' got '${a.scope}'`);
            }},
            { name: 'parseArgs con --clean', fn: () => {
                const a = parseArgs(['node', 'build.js', '1234', '--clean']);
                if (a.issue !== 1234) throw new Error(`issue esperado 1234 got ${a.issue}`);
                if (a.scope !== 'clean') throw new Error(`scope esperado 'clean' got '${a.scope}'`);
            }},
            { name: 'buildGradleCommand devuelve cmd/args válidos', fn: () => {
                const r = buildGradleCommand('smart', null);
                if (!r || typeof r.cmd !== 'string' || !Array.isArray(r.args)) {
                    throw new Error(`buildGradleCommand devolvió ${JSON.stringify(r)}`);
                }
            }},
            { name: 'buildGradleCommand --clean incluye build task', fn: () => {
                const r = buildGradleCommand('clean', null);
                if (!r.args.includes('build') || !r.args.includes('clean')) {
                    throw new Error(`args sin clean+build: ${JSON.stringify(r.args)}`);
                }
            }},
            { name: 'gradle-parser carga', fn: () => {
                const gp = require('./lib/gradle-parser');
                if (!gp || typeof gp !== 'object') throw new Error('gradle-parser no exporta objeto');
            }},
        ]);
        return;
    }
    main().catch((e) => {
        process.stderr.write(`[build] fatal: ${e.stack || e.message}\n`);
        process.exit(2);
    });
}

module.exports = {
    parseArgs,
    buildGradleCommand,
    resolveBashCommand,
    startHeartbeat,
    copyArtifacts,
    updateMarker,
    // Exportados para tests de regresión del split REPO_ROOT/WORKTREE_ROOT
    // (rebote build #3073 rev-1).
    _paths: { REPO_ROOT, WORKTREE_ROOT, QA_ARTIFACTS_DIR, LOG_DIR },
};

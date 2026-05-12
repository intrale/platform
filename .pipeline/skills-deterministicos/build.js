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
const REPO_ROOT = process.env.PIPELINE_REPO_ROOT || process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');
const HOOKS_DIR = path.join(REPO_ROOT, '.claude', 'hooks');
const LOG_DIR = path.join(REPO_ROOT, '.pipeline', 'logs');
const QA_ARTIFACTS_DIR = path.join(REPO_ROOT, 'qa', 'artifacts');
const JAVA_HOME_DEFAULT = process.env.JAVA_HOME || '/c/Users/Administrator/.jdks/temurin-21.0.7';
const HEARTBEAT_INTERVAL_MS = 30 * 1000;

// ── Mutex de build (regresión #3078 segundo rebote) ─────────────────
//
// Problema: el pipeline puede lanzar builds en paralelo para distintos issues
// (cada uno en su worktree), pero todos invocan `./gradlew` contra el mismo
// REPO_ROOT/.gradle/. Cuando dos Gradle corren al mismo tiempo, el primero
// toma el lock de Build Output Cleanup Cache; el segundo timeoutea en ~60s
// con:
//   Timeout waiting to lock Build Output Cleanup Cache
//   (REPO_ROOT/.gradle/buildOutputCleanup). It is currently in use by
//   another Gradle instance. Owner PID: X Our PID: Y
// y rebota el issue por un fallo de infraestructura (no del código).
//
// Solución: serializar los builds a nivel pipeline con un lockfile en
// REPO_ROOT/.pipeline/build-skill.lock. El segundo build espera a que el
// primero libere antes de invocar gradle. Si el holder murió (process no
// existe), el lock se roba para evitar deadlock por procesos zombi.
const BUILD_LOCK_PATH = path.join(REPO_ROOT, '.pipeline', 'build-skill.lock');
const BUILD_LOCK_TIMEOUT_MS = Number(process.env.BUILD_LOCK_TIMEOUT_MS) > 0
    ? Number(process.env.BUILD_LOCK_TIMEOUT_MS)
    : 30 * 60 * 1000; // 30 min: cubre 2 builds largos seguidos.
const BUILD_LOCK_POLL_MS = Number(process.env.BUILD_LOCK_POLL_MS) > 0
    ? Number(process.env.BUILD_LOCK_POLL_MS)
    : 500;

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

// ── Helpers de mutex ────────────────────────────────────────────────
function isPidAlive(pid) {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try {
        // Signal 0 no envía señal, solo testea existencia/permiso.
        process.kill(pid, 0);
        return true;
    } catch (e) {
        // EPERM = el proceso existe pero no podemos señalizarlo → vivo.
        // ESRCH = no existe → muerto.
        return e.code === 'EPERM';
    }
}

/**
 * Adquiere el lock global del skill build. Espera hasta `timeoutMs` si otro
 * build lo tiene tomado, o roba el lock si el holder ya no existe.
 *
 * @returns {{lockPath: string|null, waited_ms: number, stolen: boolean, timedOut: boolean}}
 *   - lockPath: path al lockfile (para pasarlo a releaseBuildLock), o null si timeout.
 *   - waited_ms: tiempo total esperando.
 *   - stolen: true si se reclamó un lock stale.
 *   - timedOut: true si no se logró adquirir antes de timeoutMs.
 */
function acquireBuildLock(issue, opts) {
    const lockPath = (opts && opts.lockPath) || BUILD_LOCK_PATH;
    const timeoutMs = (opts && Number.isFinite(opts.timeoutMs)) ? opts.timeoutMs : BUILD_LOCK_TIMEOUT_MS;
    const pollMs = (opts && Number.isFinite(opts.pollMs)) ? opts.pollMs : BUILD_LOCK_POLL_MS;
    const start = Date.now();
    const myPid = process.pid;
    let stolen = false;

    try { fs.mkdirSync(path.dirname(lockPath), { recursive: true }); } catch {}

    while (true) {
        try {
            // wx = exclusive create; falla con EEXIST si ya existe.
            const fd = fs.openSync(lockPath, 'wx');
            fs.writeSync(fd, JSON.stringify({
                pid: myPid,
                issue: issue || null,
                skill: 'build',
                ts: Date.now(),
                iso: new Date().toISOString(),
            }));
            fs.closeSync(fd);
            return {
                lockPath,
                waited_ms: Date.now() - start,
                stolen,
                timedOut: false,
            };
        } catch (e) {
            if (e.code !== 'EEXIST') throw e;

            // Lock existe — chequear si el holder está vivo.
            let holderPid = null;
            try {
                const raw = fs.readFileSync(lockPath, 'utf8');
                const meta = JSON.parse(raw || '{}');
                holderPid = Number(meta.pid);
            } catch {
                // Lock corrupto o ilegible: borrarlo defensivamente y reintentar.
                try { fs.unlinkSync(lockPath); } catch {}
                stolen = true;
                continue;
            }

            if (Number.isFinite(holderPid) && holderPid > 0 && !isPidAlive(holderPid)) {
                // Holder muerto → robar lock.
                try { fs.unlinkSync(lockPath); } catch {}
                stolen = true;
                continue;
            }

            // Holder vivo — esperar.
            if (Date.now() - start > timeoutMs) {
                return {
                    lockPath: null,
                    waited_ms: Date.now() - start,
                    stolen: false,
                    timedOut: true,
                };
            }
            // Sleep no-bloqueante (sin event loop): sleep nativo.
            const until = Date.now() + pollMs;
            while (Date.now() < until) {
                // Busy wait acotado a pollMs (típicamente 500ms).
            }
        }
    }
}

function releaseBuildLock(lockPath) {
    if (!lockPath) return false;
    try {
        // Solo liberar si el lock es nuestro (defensivo — no borrar el de otro
        // proceso si por alguna razón nos pisaron).
        const raw = fs.readFileSync(lockPath, 'utf8');
        const meta = JSON.parse(raw || '{}');
        if (meta.pid && Number(meta.pid) !== process.pid) {
            // No es nuestro — no tocar.
            return false;
        }
    } catch {
        // Si no podemos leer, intentamos borrarlo igual (best-effort).
    }
    try { fs.unlinkSync(lockPath); return true; } catch { return false; }
}

// ── Resolución explícita de bash en Windows ─────────────────────────
//
// Problema: en Windows, spawn('bash', ..., { shell: true }) pasa por cmd.exe,
// que resuelve `bash` por PATH y suele encontrar `C:\Windows\System32\bash.exe`
// (relay a WSL) antes que `C:\Program Files\Git\bin\bash.exe` (Git Bash).
// Si la distro WSL no está sana, el spawn falla con:
//   <3>WSL (9 - Relay) ERROR: CreateProcessCommon:818: execvpe(/bin/bash) failed: No such file or directory
// y el build crashea sin clasificación (regresión observada en #3078 build phase).
//
// Solución: resolver bash explícitamente a Git Bash cuando estamos en Windows.
// Si no está en los paths conocidos, caemos a 'bash' (comportamiento previo).
// La variable GIT_BASH permite override manual desde el entorno.
function resolveBashOnWindows() {
    if (process.platform !== 'win32') return null;
    const candidates = [
        process.env.GIT_BASH,
        'C:\\Program Files\\Git\\bin\\bash.exe',
        'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
        'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    ].filter(Boolean);
    for (const p of candidates) {
        try { if (fs.existsSync(p)) return p; } catch {}
    }
    return null;
}

// ── Decisión de scope → comando Gradle ───────────────────────────────
function buildGradleCommand(scope, mod) {
    // Devuelve { cmd, args, label } — cmd es path a bash (explícito en Windows) o './gradlew'
    if (mod) {
        const moduleTask = mod === 'app' ? ':app:composeApp:check' : `:${mod}:check`;
        return { cmd: './gradlew', args: [moduleTask, '--no-daemon'], label: `module:${mod}` };
    }
    const bashCmd = resolveBashOnWindows() || 'bash';
    switch (scope) {
        case 'clean':
            return { cmd: './gradlew', args: ['clean', 'build', '--no-daemon'], label: 'clean-build' };
        case 'fast':
            return { cmd: './gradlew', args: [':app:composeApp:compileKotlinJvm', '--no-daemon'], label: 'fast' };
        case 'all':
            return { cmd: bashCmd, args: ['scripts/smart-build.sh', '--all'], label: 'all' };
        case 'verify':
            return { cmd: './gradlew', args: ['verifyNoLegacyStrings', ':app:composeApp:validateComposeResources', ':app:composeApp:scanNonAsciiFallbacks', '--no-daemon'], label: 'verify' };
        case 'smart':
        default:
            return { cmd: bashCmd, args: ['scripts/smart-build.sh'], label: 'smart' };
    }
}

// ── Spawn con captura completa ───────────────────────────────────────
function runGradle({ cmd, args, cwd, env }) {
    return new Promise((resolve) => {
        const started = Date.now();
        let stdout = '';
        let stderr = '';
        // shell:true en Windows es necesario para resolver './gradlew' → gradlew.bat.
        // Pero si cmd ya es un path absoluto (ej. Git Bash resuelto explícitamente),
        // shell:false evita que cmd.exe re-resuelva 'bash' por PATH y caiga en WSL
        // relay (regresión #3078 build phase).
        const useShell = process.platform === 'win32' && !path.isAbsolute(cmd);
        const child = spawn(cmd, args, { cwd, env, shell: useShell, windowsHide: true });
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

    if (result.modules.includes('users')) {
        tryCopy(path.join(REPO_ROOT, 'users', 'build', 'libs', 'users-all.jar'),
            path.join(QA_ARTIFACTS_DIR, 'users-all.jar'));
    }

    if (result.modules.includes('app')) {
        // Buscar primer APK client debug
        try {
            const apkDir = path.join(REPO_ROOT, 'app', 'composeApp', 'build', 'outputs', 'apk', 'client', 'debug');
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
        // (#3078) Provider explícito para que el aggregator dispatchee por
        // allowlist en vez de inferir por nombre del modelo.
        provider: 'deterministic',
    });

    let gradleResult;
    let parsed;
    let report;
    let artifacts = [];
    let exitCode = 0;
    let motivo = null;
    let buildLock = null;

    try {
        // Adquirir mutex de build antes de spawnear gradle (regresión #3078).
        // Sin esto, dos builds concurrentes contienden por el lock del
        // buildOutputCleanup cache y el segundo timeoutea en ~60s.
        const lockStartLog = `[build] Intentando adquirir mutex de build (${BUILD_LOCK_PATH})…`;
        logAppend(lockStartLog);
        buildLock = acquireBuildLock(issue, {});
        if (buildLock.timedOut) {
            logAppend(`[build] LOCK TIMEOUT tras ${buildLock.waited_ms}ms — abortando build con motivo claro (sin invocar gradle, evita rebote por error genérico).`);
            motivo = `Build mutex timeout (${buildLock.waited_ms}ms): otro build sigue tomando el lock ${BUILD_LOCK_PATH}. Posible build hung del pipeline.`;
            exitCode = 1;
            parsed = { success: false, modules: [], errors: [{ classification: 'pipeline-lock-timeout', message: motivo, escalate_to: 'pipeline-dev' }] };
            report = `## Build: BLOQUEADO ⏳\n\n${motivo}`;
            // Saltar el resto del try; el finally hace el cleanup.
        } else {
            logAppend(`[build] Lock adquirido tras ${buildLock.waited_ms}ms${buildLock.stolen ? ' (lock stale robado)' : ''}.`);
            gradleResult = await runGradle({ cmd, args: gArgs, cwd: REPO_ROOT, env });
            logAppend(`[build] gradle exit_code=${gradleResult.exit_code} wall_ms=${gradleResult.wall_ms}`);
            logAppend('[build] --- stdout (último 2000 chars) ---');
            logAppend(gradleResult.stdout.slice(-2000));
            logAppend('[build] --- stderr (último 1000 chars) ---');
            logAppend(gradleResult.stderr.slice(-1000));

            parsed = parseGradleOutput(gradleResult.stdout, gradleResult.stderr);

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
        }
    } catch (e) {
        exitCode = 2;
        motivo = `Excepción en build.js: ${e.message}`;
        logAppend(`[build] EXCEPTION: ${e.stack || e.message}`);
    } finally {
        // Liberar el mutex de build (idempotente, defensivo).
        if (buildLock && buildLock.lockPath) {
            const released = releaseBuildLock(buildLock.lockPath);
            logAppend(`[build] Mutex liberado: ${released ? 'OK' : 'no-op'} (path=${buildLock.lockPath})`);
        }

        // Actualizar marker con resultado
        updateMarker(args.trabajando, {
            resultado: exitCode === 0 ? 'aprobado' : 'rechazado',
            motivo: motivo || (exitCode === 0 ? 'Build exitoso' : 'Build fallido'),
            build_scope: label,
            build_duration_ms: gradleResult ? gradleResult.wall_ms : 0,
            build_classification: parsed && parsed.errors[0] ? parsed.errors[0].classification : null,
            build_escalate_to: parsed && parsed.errors[0] ? parsed.errors[0].escalate_to : null,
            build_mode: 'deterministic',
            build_lock_waited_ms: buildLock ? buildLock.waited_ms : 0,
            build_lock_stolen: buildLock ? buildLock.stolen : false,
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
    resolveBashOnWindows,
    startHeartbeat,
    copyArtifacts,
    updateMarker,
    // Mutex de build (regresión #3078 segundo rebote).
    acquireBuildLock,
    releaseBuildLock,
    isPidAlive,
    BUILD_LOCK_PATH,
    BUILD_LOCK_TIMEOUT_MS,
};

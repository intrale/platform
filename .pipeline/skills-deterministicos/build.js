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
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');
const trace = require('../lib/traceability');
const { writeDeliverable } = require('../lib/write-deliverable');
const { parseGradleOutput, renderMarkdownReport } = require('./lib/gradle-parser');
const { withGradleLock } = require('../lib/gradle-lock');

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
// `execSyncImpl`/`fsImpl` son parámetros de inyección OPCIONALES exclusivos para
// tests (#4898): permiten exercitar el fallback dinámico vía `git --exec-path` sin
// depender del Git Bash real de la máquina. SEGURIDAD: NUNCA leerse de env/config —
// solo se inyectan como argumento desde el test. El default preserva el comportamiento
// productivo exacto (execSync real + fs real).
function resolveBashCommand(cmd, { execSyncImpl, fsImpl } = {}) {
    const _execSync = execSyncImpl || execSync;
    const _fs = fsImpl || fs;
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
            if (_fs.existsSync(candidate)) {
                return { cmd: candidate, useShell: false };
            }
        } catch {}
    }
    // #4898 — Resolución dinámica vía `git` cuando los paths hardcoded fallan.
    // Regresión observada: el build de #4898 (cambio puro .pipeline/) rebotó con
    // `"bash" no se reconoce como un comando interno o externo` PESE a tener Git
    // Bash instalado en `C:\Program Files\Git\bin\bash.exe`. La causa: se alcanzó
    // este fallback (spawn de `bash` vía cmd.exe, que en máquinas sin WSL bash en
    // PATH muere en ~40ms). Los candidatos hardcoded pueden no cubrir instalaciones
    // en rutas no estándar, y un lock transitorio de FS/antivirus puede hacer que
    // `existsSync` devuelva false por un instante. `git` SIEMPRE está en el PATH del
    // pipeline (todo el flujo lo usa), así que derivamos la raíz de Git desde
    // `git --exec-path` (ej. `…/Git/mingw64/libexec/git-core` → raíz `…/Git`) y
    // ubicamos `bin/bash.exe` o `usr/bin/bash.exe`. Es una resolución robusta que
    // no depende de rutas fijas ni de una única lectura de existsSync.
    try {
        const execPath = String(_execSync('git --exec-path', {
            encoding: 'utf8', timeout: 5000, windowsHide: true,
        })).trim();
        if (execPath) {
            const gitRoot = path.resolve(execPath, '..', '..', '..');
            const derived = [
                path.join(gitRoot, 'bin', 'bash.exe'),
                path.join(gitRoot, 'usr', 'bin', 'bash.exe'),
            ];
            for (const candidate of derived) {
                try {
                    if (_fs.existsSync(candidate)) {
                        return { cmd: candidate, useShell: false };
                    }
                } catch {}
            }
        }
    } catch { /* git no disponible o error de spawn — cae al último recurso */ }
    // No se encontró Git Bash por ningún medio — fallback a 'bash' por PATH (puede
    // caer en WSL bash). Mejor fallar con stack trace claro que silenciosamente.
    return { cmd, useShell: true };
}

// ── Spawn con captura completa ───────────────────────────────────────
// #4155 — `runGradle` envuelve el spawn con el lock global de Gradle para que
// NUNCA corra en simultáneo con otra invocación pesada (build/tester) de otro
// agente (CA-4). Si el lock está tomado, encola hasta que se libera. El lock se
// libera en `finally` aunque el spawn falle (auto-release, CA-5).
// `spawnFn` es un parámetro de inyección OPCIONAL exclusivo para tests (#4164):
// permite reemplazar el `spawn` real por un stub in-process y volver determinista
// el test del probe. SEGURIDAD: NUNCA debe leerse de env/config/runtime — solo se
// inyecta como argumento de función desde el test — para no convertir la DI en un
// sink de RCE. El default preserva el comportamiento productivo exacto.
function runGradle({ cmd, args, cwd, env, spawnFn }) {
    return withGradleLock(() => spawnGradle({ cmd, args, cwd, env, spawnFn }));
}

function spawnGradle({ cmd, args, cwd, env, spawnFn }) {
    const _spawn = spawnFn || spawn;
    return new Promise((resolve) => {
        const started = Date.now();
        let stdout = '';
        let stderr = '';
        const { cmd: resolvedCmd, useShell } = resolveBashCommand(cmd);
        const child = _spawn(resolvedCmd, args, { cwd, env, shell: useShell, windowsHide: true });
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

function relativeRepoPath(absPath, root = REPO_ROOT) {
    return path.relative(root, absPath).replace(/\\/g, '/');
}

function fileSha256(file) {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(file));
    return hash.digest('hex');
}

function collectArtifactMetadata(artifactNames, opts = {}) {
    const qaDir = opts.qaArtifactsDir || QA_ARTIFACTS_DIR;
    const repoRoot = opts.repoRoot || REPO_ROOT;
    const names = Array.isArray(artifactNames) ? artifactNames : [];
    const out = [];
    for (const name of names) {
        if (!name || name === 'BUILD_TIMESTAMP') continue;
        const file = path.join(qaDir, name);
        try {
            const stat = fs.statSync(file);
            if (!stat.isFile()) continue;
            out.push({
                name,
                type: path.extname(name).replace(/^\./, '') || 'file',
                bytes: stat.size,
                sha256: fileSha256(file),
                path: relativeRepoPath(file, repoRoot),
            });
        } catch {}
    }
    return out;
}

function appendBuildDeliverableSections(report, meta = {}) {
    const lines = [report || '## Build: FALLIDO'];
    const artifacts = Array.isArray(meta.artifacts) ? meta.artifacts : [];
    const logPath = meta.logPath || null;
    const status = meta.status || 'desconocido';
    const timestamp = meta.timestamp || new Date().toISOString();

    lines.push('');
    lines.push('### Resumen operativo');
    lines.push(`- Issue: #${meta.issue}`);
    lines.push('- Fase/agente: build/build');
    lines.push(`- Estado: ${status}`);
    lines.push(`- Modulo/target: ${meta.scope || 'n/a'}`);
    lines.push(`- Timestamp: ${timestamp}`);

    lines.push('');
    lines.push('### Artefacto producido');
    if (artifacts.length === 0) {
        const reason = meta.noArtifactReason || 'No se produjo JAR/APK notificable para este cierre.';
        lines.push(`- Excepcion explicita: ${reason}`);
    } else {
        for (const artifact of artifacts) {
            lines.push(`- ${artifact.name}`);
            lines.push(`  - Tipo: ${artifact.type}`);
            lines.push(`  - Tamano: ${artifact.bytes} bytes`);
            lines.push(`  - SHA-256: ${artifact.sha256}`);
            lines.push(`  - Ruta relativa: ${artifact.path}`);
        }
    }

    if (meta.failureClassification) {
        lines.push('');
        lines.push('### Diagnostico de fallo');
        lines.push(`- Clasificacion: ${meta.failureClassification}`);
        if (meta.failureDetail) lines.push(`- Detalle: ${String(meta.failureDetail).slice(0, 500)}`);
    }

    lines.push('');
    lines.push('### Referencia al log local');
    lines.push(`- Log crudo local: ${logPath || 'no disponible'}`);
    lines.push('- Nota: el log crudo no se adjunta como entregable notificable.');

    return lines.join('\n');
}

function buildExceptionReport({ issue, scope, motivo, logPath, durationMs = 0, timestamp }) {
    const report = [
        '## Build: FALLIDO',
        '',
        '### Compilacion',
        '- Modulo(s): n/a',
        '- Resultado: FALLO',
        `- Tiempo: ${Math.floor(durationMs / 1000)}s`,
        `- Scope: ${scope || 'n/a'}${issue ? ` - issue #${issue}` : ''}`,
        '- Tareas: 0 ejecutadas - 0 up-to-date - 0 desde cache',
        '',
        '### Verificaciones',
        '- Strings legacy: no ejecutado',
        '- Recursos Compose: no ejecutado',
        '- ASCII fallbacks: no ejecutado',
        '',
        '### Errores',
        '- **[pipeline_exception]** (sin task)',
        `  - Detalle: ${motivo || 'Excepcion no clasificada en build.js'}`,
        '',
        '### Veredicto del Builder',
        'El build fallo antes de completar Gradle. Se persiste este reporte rojo para evitar silencio de fase.',
    ].join('\n');

    return appendBuildDeliverableSections(report, {
        issue,
        scope,
        status: 'rojo',
        artifacts: [],
        noArtifactReason: 'El build fallo antes de producir artefacto.',
        failureClassification: 'pipeline_exception',
        failureDetail: motivo,
        logPath,
        timestamp,
    });
}

function sanitizeBuildReportContent(content) {
    return String(content || '')
        .replace(/[A-Za-z]:[\\/][^\s`'")]+/g, '[ruta-local-redactada]')
        .replace(/\/(?:Users|home|tmp|var|private|mnt|c|Workspaces)\/[^\s`'")]+/g, '[ruta-local-redactada]');
}

function materializeBuildDeliverable(issue, report, opts = {}) {
    if (!report || !String(report).trim()) {
        throw new Error('reporte de build vacio');
    }
    return writeDeliverable('build', issue, {
        fase: 'build',
        md: sanitizeBuildReportContent(report),
        pipelineRoot: opts.pipelineRoot || REPO_ROOT,
        timestamp: opts.timestamp,
    });
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
    let report = '';
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
        report = appendBuildDeliverableSections(report, {
            issue,
            scope: label,
            status: parsed.build_status === 'NO_OP' ? 'no aplica' : (parsed.success ? 'verde' : 'rojo'),
            artifacts: collectArtifactMetadata(artifacts),
            noArtifactReason: parsed.build_status === 'NO_OP'
                ? 'Smart-build no encontro modulos compilables afectados.'
                : (parsed.success ? 'Build exitoso sin JAR/APK copiado a qa/artifacts.' : 'Build fallido antes de producir artefacto.'),
            failureClassification: parsed.errors[0] ? parsed.errors[0].classification : null,
            failureDetail: parsed.errors[0] ? parsed.errors[0].message : null,
            logPath: relativeRepoPath(agentLog),
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
        report = buildExceptionReport({
            issue,
            scope: label,
            motivo,
            logPath: relativeRepoPath(agentLog),
            durationMs: gradleResult ? gradleResult.wall_ms : 0,
        });
    } finally {
        try {
            const res = materializeBuildDeliverable(issue, report, { pipelineRoot: REPO_ROOT });
            logAppend(`[build] deliverable escrito: ${relativeRepoPath(res.path)} bytes=${res.bytes}`);
        } catch (e) {
            logAppend(`[build] writeDeliverable FAILED: ${e.message}`);
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
    collectArtifactMetadata,
    appendBuildDeliverableSections,
    buildExceptionReport,
    sanitizeBuildReportContent,
    materializeBuildDeliverable,
    updateMarker,
    // Exportados para tests del lock global de Gradle (#4155): `runGradle` es la
    // variante con lock, `spawnGradle` el spawn crudo sin lock.
    runGradle,
    spawnGradle,
    // Exportados para tests de regresión del split REPO_ROOT/WORKTREE_ROOT
    // (rebote build #3073 rev-1).
    _paths: { REPO_ROOT, WORKTREE_ROOT, QA_ARTIFACTS_DIR, LOG_DIR },
};

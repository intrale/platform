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
const os = require('os');
const { spawn, execFile, execSync, spawnSync } = require('child_process');
const trace = require('../lib/traceability');
const gradleParser = require('./lib/gradle-parser');
const kover = require('./lib/kover-parser');
const { ensureGitInEnv } = require('../lib/ensure-git-in-path');

// ── Constantes y paths ──────────────────────────────────────────────
const REPO_ROOT = process.env.PIPELINE_REPO_ROOT || process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');
const HOOKS_DIR = path.join(REPO_ROOT, '.claude', 'hooks');
const LOG_DIR = path.join(REPO_ROOT, '.pipeline', 'logs');
const QA_ARTIFACTS_DIR = path.join(REPO_ROOT, 'qa', 'artifacts', 'tester');
const JAVA_HOME_DEFAULT = process.env.JAVA_HOME || '/c/Users/Administrator/.jdks/temurin-21.0.7';
const HEARTBEAT_INTERVAL_MS = 30 * 1000;

// Umbral de cobertura por defecto (línea) — igual al skill LLM.
const DEFAULT_COVERAGE_THRESHOLD = 80;

// Anti-stale de XML reports (rebote #2892):
// Cuando gradle aborta antes de ejecutar tests (ej. cmd.exe no entiende
// `./gradlew` y devuelve `"." no se reconoce`), el exit_code es ≠0 y el
// wall_ms es muy bajo. En ese caso, los reportes XML que existen en
// `build/test-results/` pertenecen a runs PREVIOS y no reflejan el estado
// actual del worktree. Estos dos thresholds permiten:
//   1) Filtrar XMLs por mtime — solo tomar los escritos durante este run.
//   2) Detectar gradle "no ejecutó nada" y emitir motivo claro en vez de
//      reportar fallas de runs ajenos como propias.
const STALE_XML_GRACE_MS = 1000;        // tolerancia de skew para mtime
const GRADLE_INSTANT_FAIL_MS = 2000;    // <2s con exit≠0 = gradle no arrancó

// Rebote #2892 (rev-2 cross-phase): garantizar `git` en PATH del child node
// que corre `node --test`. Cuando pulpo arranca desde un contexto donde el
// PATH heredado no incluye el directorio de git.exe (por ejemplo restart
// disparado desde un shell con PATH stripped, o Windows Service con system
// PATH limitado), el child node no encuentra `git` y los tests del propio
// pipeline que usan `spawnSync('git', …)` o `execSync('git …')` fallan
// con "git no se reconoce como un comando interno o externo". Probamos
// `where git` primero, y si eso falla, caemos a las rutas de instalación
// estándar de Git for Windows.
const GIT_FALLBACK_DIRS_WIN32 = [
    'C:\\Program Files\\Git\\cmd',
    'C:\\Program Files\\Git\\bin',
    'C:\\Program Files\\Git\\mingw64\\bin',
    'C:\\Program Files (x86)\\Git\\cmd',
    'C:\\Program Files (x86)\\Git\\bin',
];

// Módulos Gradle que soportamos individualmente
const MODULE_DIRS = {
    backend: 'backend',
    users: 'users',
    app: path.join('app', 'composeApp'),
};

// ── Detección de cambios pipeline-only (issue #2891) ────────────────
// Para issues que solo tocan `.pipeline/`, `docs/`, `agents/` o `.github/`
// no tiene sentido correr Gradle: no hay código Kotlin que testear y no
// quedan reportes JUnit del build phase. En su lugar corremos `node --test`
// sobre los tests del propio pipeline (Node 24+ soporta --test-reporter=junit).
//
// El protocolo del rol pipeline-dev (`.pipeline/roles/pipeline-dev.md`)
// ya documenta este caso como `qa:skipped` con tests unitarios Node — acá
// lo automatizamos en el tester determinístico.

// Rebote #2895 rev-2: incluir archivos root-level que no afectan compilación
// Kotlin ni cobertura Kover. Síntoma: un commit que sumaba `.gitignore` a la
// par de cambios bajo `.pipeline/` rompía el match `every` y forzaba la ruta
// gradle completa, que rebotaba por cobertura Kotlin baseline (35.95% < 80%)
// totalmente ajena al cambio. Verificación empírica del rebote en
// .pipeline/logs/2895-tester.log:
//
//   [tester] git diff vs main: 10 archivos · pipeline_only=false
//   ...
//   - Cobertura de líneas 35.95% por debajo del umbral 80%
//
// Los archivos agregados acá NO pueden afectar Kotlin/coverage:
//   .gitignore       → solo afecta `git status`/staging, no compilación.
//   .gitattributes   → solo afecta diff/checkout/EOL, no compilación.
//   .editorconfig    → solo afecta editores; no genera bytecode ni cambia tests.
//
// Rebote #3072 rev-1 + #3081 rev-2 (mismo síntoma, archivos distintos):
//   - #3072 (H1 multi-provider) agregó `ajv` como dependencia npm necesaria
//     para validar el schema JSON; eso metió package.json + package-lock.json
//     en el diff, rompió el match `every` y forzó la ruta gradle. Gradle
//     corrió con todas las tasks UP-TO-DATE y no produjo JUnit reports →
//     rebote "[tester] No se encontraron reportes JUnit". Verificación en
//     .pipeline/logs/3072-tester.log:
//       [tester] git diff vs main: 7 archivos · pipeline_only=false
//       [tester] gradle exit_code=0 wall_ms=64180 (BUILD SUCCESSFUL, UP-TO-DATE)
//       ⏭️ No se encontraron reportes JUnit
//   - #3081 (S3 multi-provider) sumó `.husky/pre-commit` por integrar
//     validación schema en el git hook. Mismo síntoma:
//       [tester] git diff vs main: 8 archivos · pipeline_only=false
//       - No se encontraron reportes JUnit
//
// Estos archivos NO afectan compilación Kotlin/Java ni cobertura Kover:
//   .husky/          → git hooks (Node.js); se ejecutan en `git commit`,
//                      no participan del classpath ni del build Gradle.
//   package.json     → metadata npm del toolchain Node del pipeline;
//                      Gradle no lo lee. Verificado: `grep` por package*.json
//                      en *.gradle.kts/*.kt devuelve 0 referencias.
//   package-lock.json→ lockfile de npm; ídem. Solo lo consume `npm ci/install`.
//
// Excluido a propósito: `README.md` y otros .md root, `gradle.properties`,
// `settings.gradle.kts`, `build.gradle.kts`, `.claude/` (todos pueden afectar
// build/coverage). El test `paths fuera de los patrones permitidos rompen
// el match` documenta y protege esa frontera.
const PIPELINE_ONLY_PATTERNS = [
    /^\.pipeline\//,        // pipeline V3 (Node.js)
    /^docs\//,              // documentación pura
    /^agents\//,            // reglas para agentes
    /^\.github\//,          // GitHub Actions / templates
    /^\.gitignore$/,        // gitignore root — no afecta compilación Kotlin
    /^\.gitattributes$/,    // git attributes — no afecta compilación Kotlin
    /^\.editorconfig$/,     // editor config — no afecta cobertura
    /^\.husky\//,           // husky git hooks (Node.js) — fuera de classpath Gradle
    /^package\.json$/,      // npm manifest — usado solo por `.pipeline/` Node.js
    /^package-lock\.json$/, // npm lockfile — usado solo por `.pipeline/` Node.js
];

/**
 * Resuelve el directorio que contiene `git.exe`/`git` para asegurarse de que
 * los procesos hijos puedan ejecutar git aunque el PATH heredado del pulpo
 * no lo incluya (rebote #2892 rev-2). Estrategia:
 *   1) `where git` (Windows) o `which git` (Unix) usando el PATH actual.
 *   2) Caída a paths estándar de Git for Windows si el lookup falla.
 *   3) Devuelve `null` si nada funciona — el caller debe seguir adelante
 *      sin asumir que git esté disponible (los tests de pipeline emitirán
 *      fallas claras).
 */
function resolveGitDir() {
    const lookup = process.platform === 'win32' ? 'where' : 'which';
    try {
        const r = require('child_process').spawnSync(lookup, ['git'], {
            encoding: 'utf8', windowsHide: true, shell: false, timeout: 5000,
        });
        if (r && r.status === 0 && typeof r.stdout === 'string') {
            const firstLine = r.stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean);
            if (firstLine) {
                try {
                    const stat = fs.statSync(firstLine);
                    if (stat.isFile()) return path.dirname(firstLine);
                } catch { /* ignore */ }
            }
        }
    } catch { /* ignore */ }

    if (process.platform === 'win32') {
        for (const dir of GIT_FALLBACK_DIRS_WIN32) {
            try {
                if (fs.statSync(path.join(dir, 'git.exe')).isFile()) return dir;
            } catch { /* ignore */ }
        }
    }
    return null;
}

/**
 * Descubre el worktree del agente para un issue dado vía `git worktree list`.
 * Devuelve el path absoluto al worktree o `null` si no existe (rebote #2892
 * + issue #2893): la fase `verificacion` corre en ROOT (main worktree) que
 * está en main, así que el diff vs `origin/main` desde ahí siempre es vacío
 * y la detección pipeline-only fallaría. Necesitamos hacer el diff desde el
 * worktree del agente que SÍ tiene los commits del issue.
 *
 * Naming convention: los worktrees de agentes se llaman `platform.agent-<issue>-<skill>`
 * (ver pulpo.js → spawnCwd = worktreePath).
 */
function findIssueWorktree(repoRoot, issue) {
    if (!issue) return null;
    let raw;
    try {
        raw = execSync('git worktree list --porcelain', {
            cwd: repoRoot, encoding: 'utf8', timeout: 10000, windowsHide: true,
        });
    } catch {
        return null;
    }
    const needle = `platform.agent-${issue}-`;
    for (const line of raw.split('\n')) {
        if (!line.startsWith('worktree ')) continue;
        const wt = line.replace('worktree ', '').trim();
        // El worktree path contiene el slug `platform.agent-<issue>-<skill>`.
        if (wt && wt.includes(needle)) return wt;
    }
    return null;
}

/**
 * Devuelve la lista de archivos cambiados respecto a `origin/main` o `null`
 * si git no está disponible o el diff falla. Probamos varias bases en orden
 * para cubrir worktrees recién clonados que no tengan `origin/main` local.
 */
function getChangedFilesVsMain(repoRoot) {
    return new Promise((resolve) => {
        const bases = ['origin/main', 'main', 'origin/HEAD'];
        const tryNext = (idx) => {
            if (idx >= bases.length) return resolve(null);
            execFile('git', ['diff', '--name-only', `${bases[idx]}...HEAD`], {
                cwd: repoRoot, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
            }, (err, stdout) => {
                if (err) return tryNext(idx + 1);
                const files = String(stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
                resolve(files);
            });
        };
        tryNext(0);
    });
}

function isPipelineOnlyChange(files) {
    if (!Array.isArray(files) || files.length === 0) return false;
    return files.every((f) => PIPELINE_ONLY_PATTERNS.some((re) => re.test(f)));
}

/**
 * Encuentra recursivamente los archivos *.test.js dentro de `.pipeline/`,
 * excluyendo `node_modules` y directorios ocultos.
 */
function findNodeTestFiles(repoRoot) {
    const out = [];
    const root = path.join(repoRoot, '.pipeline');
    if (!fs.existsSync(root)) return out;
    const stack = [root];
    while (stack.length > 0) {
        const cur = stack.pop();
        let entries;
        try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
        for (const ent of entries) {
            const full = path.join(cur, ent.name);
            if (ent.isDirectory()) {
                if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
                // Excluir backlogs/estado del pipeline (no contienen tests)
                if (ent.name === 'desarrollo' || ent.name === 'definicion' || ent.name === 'logs') continue;
                stack.push(full);
            } else if (ent.isFile() && /\.test\.js$/i.test(ent.name)) {
                out.push(full);
            }
        }
    }
    return out;
}

/**
 * Parsea el reporte JUnit XML que escribe `node --test --test-reporter=junit`.
 * El formato difiere del JUnit/Surefire de Gradle: usa `<testsuites>` (plural)
 * sin el wrapper `<testsuite>` con totales. Los counters viajan en comentarios
 * al final del documento.
 */
function parseNodeTestJunit(xml) {
    const out = {
        valid: false,
        tests: 0,
        failures: 0,
        errors: 0,
        skipped: 0,
        time_seconds: 0,
        suites: 1,
        failed_tests: [],
    };
    if (!xml || typeof xml !== 'string') return out;

    const tm = xml.match(/<!--\s*tests\s+(\d+)\s*-->/);
    const fm = xml.match(/<!--\s*fail\s+(\d+)\s*-->/);
    const sm = xml.match(/<!--\s*skipped\s+(\d+)\s*-->/);
    const dm = xml.match(/<!--\s*duration_ms\s+([\d.]+)\s*-->/);

    if (tm) out.tests = parseInt(tm[1], 10);
    if (fm) out.failures = parseInt(fm[1], 10);
    if (sm) out.skipped = parseInt(sm[1], 10);
    if (dm) out.time_seconds = parseFloat(dm[1]) / 1000;
    out.valid = !!tm;

    // Recolectar testcases con <failure>/<error> para detalle del rebote.
    // Los atributos pueden contener `>` literal dentro de un valor quoted
    // (p. ej. `name="conserva &amp;quot;> Task ... FAILED&amp;quot;"`), así
    // que NO se puede usar `[^>]*?` para los atributos: trunca al primer `>`,
    // los matches subsiguientes pierden alineación y el reporte termina con
    // `name=(sin nombre)`. Permitimos cualquier secuencia de strings quoted
    // o caracteres no-`>` fuera de comillas.
    const ATTRS = `(?:"[^"]*"|'[^']*'|[^>"'])*?`;
    const tcRe = new RegExp(`<testcase\\b(${ATTRS})(?:\\/>|>([\\s\\S]*?)<\\/testcase>)`, 'g');
    const failRe = new RegExp(`<failure\\b(${ATTRS})(?:\\/>|>([\\s\\S]*?)<\\/failure>)`);
    const errRe = new RegExp(`<error\\b(${ATTRS})(?:\\/>|>([\\s\\S]*?)<\\/error>)`);
    let m;
    while ((m = tcRe.exec(xml)) !== null) {
        const attrs = m[1] || '';
        const body = m[2] || '';
        const failMatch = body.match(failRe);
        const errMatch = body.match(errRe);
        if (!failMatch && !errMatch) continue;
        const nameMatch = attrs.match(/\bname="([^"]*)"/);
        const cnameMatch = attrs.match(/\bclassname="([^"]*)"/);
        const fileMatch = attrs.match(/\bfile="([^"]*)"/);
        const failAttrs = (failMatch || errMatch)[1] || '';
        const msgMatch = failAttrs.match(/\bmessage="([^"]*)"/);
        out.failed_tests.push({
            classname: (cnameMatch && cnameMatch[1]) || (fileMatch && path.basename(fileMatch[1])) || 'node-test',
            name: (nameMatch && nameMatch[1]) || '(sin nombre)',
            time: 0,
            type: errMatch ? 'error' : 'failure',
            message: (msgMatch && msgMatch[1]) ? msgMatch[1].slice(0, 500) : '',
            stack_snippet: ((failMatch || errMatch)[2] || '').trim().split(/\r?\n/).slice(0, 3).join(' | ').slice(0, 500),
        });
    }

    return out;
}

/**
 * Garantiza que `git` sea ejecutable desde el child spawn (rebote #2891 rev-2/rev-3).
 *
 * Cuando el pulpo corre como servicio Windows, su `process.env.PATH` puede no
 * incluir el directorio de Git (`C:\Program Files\Git\cmd`). Los tests del
 * pipeline (ej. `git-context.test.js`, `backup-agent-branch.test.js`) hacen
 * `spawnSync('git', ...)` con `shell: false` y fallan con
 * `'git' no se reconoce como un comando interno o externo` o `r.stderr === undefined`.
 *
 * Wrapper sobre `ensureGitInEnv` (en `.pipeline/lib/ensure-git-in-path.js`)
 * para mantener compatibilidad con tests del tester. La implementación real
 * vive en el helper compartido para que los archivos de tests puedan importarla
 * directamente sin depender del tester (ver `.pipeline/lib/ensure-git-in-path.js`).
 *
 * Devuelve el env (mutado) listo para spawn.
 */
function ensureGitInPath(env) {
    return ensureGitInEnv(env);
}

/**
 * Corre `node --test --test-reporter=junit` sobre los tests del pipeline.
 * Devuelve resultado con shape compatible con `aggregateTestResults`.
 */
function runNodeTests(repoRoot, env) {
    return new Promise((resolve) => {
        const started = Date.now();
        const files = findNodeTestFiles(repoRoot);
        if (files.length === 0) {
            return resolve({
                exit_code: 0, no_tests: true,
                stdout: '', stderr: '',
                wall_ms: Date.now() - started,
                report_file: null, files: [],
                summary: { valid: false, tests: 0, failures: 0, errors: 0, skipped: 0,
                           time_seconds: 0, suites: 0, failed_tests: [] },
            });
        }
        const reportFile = path.join(repoRoot, '.pipeline', 'logs', 'node-tests-junit.xml');
        try { fs.mkdirSync(path.dirname(reportFile), { recursive: true }); } catch {}
        // Borrar reporte previo para evitar parsear cache de runs anteriores
        try { fs.unlinkSync(reportFile); } catch {}

        const args = [
            '--test',
            '--test-reporter=junit',
            `--test-reporter-destination=${reportFile}`,
            ...files,
        ];
        // Strip NODE_TEST_CONTEXT del env del child: si tester.js corre dentro
        // de `node --test` (caso típico en self-tests), Node propaga esa env
        // al child y el sub-runner rechaza ejecutar files con un warning
        // "node:test run() is being called recursively". Limpiarlo deja al
        // child correr como un top-level run.
        //
        // #2895 (rebote rev-1): además, garantizamos que `git.exe` esté en
        // PATH para los test child processes. Cuando el pulpo arranca como
        // servicio Windows, su PATH heredado puede no incluir `Program Files\
        // Git\cmd`, y los tests que hacen `spawnSync('git', ...)` o
        // `execSync('git ...')` fallan con ENOENT / "no se reconoce". El
        // helper resolveGitDir busca git.exe en PATH y en ubicaciones
        // conocidas y lo prepende. Idempotente y no muta el env recibido.
        let childEnv = { ...env };
        delete childEnv.NODE_TEST_CONTEXT;
        // Garantizar que `git` esté accesible para los tests que hacen
        // `spawnSync('git', ...)` (rebote #2891 rev-2 + #2895 rev-1). Cuando
        // el pulpo corre como service Windows, el PATH no incluye
        // `C:\Program Files\Git\cmd` y todos los tests basados en repos
        // temporales fallan con `'git' no se reconoce como un comando interno
        // o externo`. ensureGitInPath es un wrapper local sobre ensureGitInEnv.
        ensureGitInPath(childEnv);

        // #3091 rebote rev-1 (réplica del fix #3090 rev-1) — Garantizar que
        // los tests del worktree puedan resolver las dependencias instaladas
        // en el repo principal (`js-yaml`, `ajv`, etc.). Los worktrees creados
        // por `git worktree add` no incluyen `node_modules/` (sólo `.git`),
        // así que cuando el tester corre `node --test` desde un worktree, los
        // tests que hacen `require('../pulpo.js')` fallan con
        // `Cannot find module 'js-yaml'`.
        //
        // Causa raíz: tester.js#3081 movió la ejecución de `node --test` al
        // worktree del agente (para que el código testeado sea el del issue,
        // no el de main), pero los worktrees no tienen node_modules locales.
        //
        // Fix: prepender `<REPO_ROOT>/.pipeline/node_modules` y
        // `<REPO_ROOT>/node_modules` al NODE_PATH heredado por el child.
        // Sólo aplicamos cuando el repoRoot del run difiere de REPO_ROOT (i.e.
        // estamos corriendo desde un worktree); si coinciden, la resolución
        // normal de Node ya encuentra los módulos vía `node_modules` lookup.
        //
        // NOTA #3091: este fix duplica la solución que vive en la rama
        // agent/3090-pipeline-dev. Ambas ramas tocan exactamente la misma
        // sección y mergean limpio entre sí (mismo bloque, idéntico
        // contenido). Cuando #3090 mergee a main, este chunk va a quedar
        // de un lado u otro sin conflicto real.
        if (path.resolve(repoRoot) !== path.resolve(REPO_ROOT)) {
            const extraNodePaths = [
                path.join(REPO_ROOT, '.pipeline', 'node_modules'),
                path.join(REPO_ROOT, 'node_modules'),
            ].filter((p) => {
                try { return fs.statSync(p).isDirectory(); } catch { return false; }
            });
            if (extraNodePaths.length > 0) {
                const sep = path.delimiter;
                const prev = childEnv.NODE_PATH ? String(childEnv.NODE_PATH) : '';
                childEnv.NODE_PATH = prev
                    ? `${extraNodePaths.join(sep)}${sep}${prev}`
                    : extraNodePaths.join(sep);
            }
        }
        let stdout = '';
        let stderr = '';
        const child = spawn(process.execPath, args, {
            cwd: repoRoot, env: childEnv, shell: false, windowsHide: true,
        });
        if (child.stdout) child.stdout.on('data', (d) => { stdout += d.toString(); });
        if (child.stderr) child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('error', (e) => {
            stderr += `\n[spawn-error] ${e.message}\n`;
            resolve({
                exit_code: 2, stdout, stderr,
                wall_ms: Date.now() - started,
                report_file: reportFile, files,
                summary: { valid: false, tests: 0, failures: 0, errors: 0, skipped: 0,
                           time_seconds: 0, suites: 0, failed_tests: [] },
            });
        });
        child.on('exit', (code) => {
            let xml = '';
            try { xml = fs.readFileSync(reportFile, 'utf8'); } catch {}
            const summary = parseNodeTestJunit(xml);
            resolve({
                exit_code: code == null ? 1 : code,
                stdout, stderr,
                wall_ms: Date.now() - started,
                report_file: reportFile, files,
                summary,
            });
        });
    });
}

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
    // Tareas base por módulo.
    //
    // app: el módulo `:app:composeApp` define product flavors (Business,
    // Client, Delivery — ver `app/composeApp/build.gradle.kts:335`). Con
    // flavors activos, la tarea `testDebugUnitTest` no existe directamente
    // — Gradle genera `test<Flavor>DebugUnitTest` por flavor. Si pedimos
    // `:app:composeApp:testDebugUnitTest` Gradle aborta con
    //   "task 'testDebugUnitTest' is ambiguous … Candidates are:
    //    testBusinessDebugUnitTest, testClientDebugUnitTest, testDeliveryDebugUnitTest"
    // (rebote #3002). Solución: enumerar las tres tareas de flavor
    // explícitamente para cubrir todo el código Android del módulo y evitar
    // ambigüedad en la línea de comandos.
    const testTask = {
        backend: [':backend:test'],
        users:   [':users:test'],
        app:     [
            ':app:composeApp:testClientDebugUnitTest',
            ':app:composeApp:testBusinessDebugUnitTest',
            ':app:composeApp:testDeliveryDebugUnitTest',
        ],
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

    // Anti-stale + Windows fix (rebote #2892): el spawn corre con
    // `shell: true` en win32, lo que pasa el comando por cmd.exe. cmd.exe NO
    // entiende `./gradlew` (devuelve `"." no se reconoce`). Resultado: gradle
    // nunca arranca, el wall_ms es <100ms, y el tester levantaba XMLs viejos
    // de runs previos como si fueran del run actual. Solución: en Windows,
    // ejecutar el wrapper `.bat` con path absoluto desde REPO_ROOT.
    const cmd = process.platform === 'win32'
        ? path.join(REPO_ROOT, 'gradlew.bat')
        : './gradlew';

    return {
        cmd,
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
// `minMtimeMs` (opcional): solo considerar XMLs escritos en/después de ese
// timestamp. Evita reportar fallas de runs anteriores como del run actual
// cuando gradle abortó sin escribir nuevos resultados (rebote #2892).
function collectTestReports(modules, options = {}) {
    const { minMtimeMs } = options;
    const all = [];
    for (const m of modules) {
        const dir = path.join(REPO_ROOT, MODULE_DIRS[m] || m);
        const files = kover.findTestResultFiles(dir, { minMtimeMs });
        for (const f of files) {
            try {
                const xml = fs.readFileSync(f, 'utf8');
                all.push(kover.parseTestResultsXml(xml));
            } catch {}
        }
    }
    return kover.aggregateTestResults(all);
}

function collectKoverReports(modules, options = {}) {
    const { minMtimeMs } = options;
    const parsed = [];
    const files = [];
    for (const m of modules) {
        const dir = path.join(REPO_ROOT, MODULE_DIRS[m] || m);
        const found = kover.findKoverXmlFiles(dir, { minMtimeMs });
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

    // Rebote #2892 rev-2: garantizar `git` en PATH para los tests pipeline-only.
    // Cuando pulpo arranca desde un contexto con PATH stripped, los tests del
    // propio pipeline (git-context.test.js, backup-agent-branch.test.js,
    // tester.test.js) que invocan git via spawnSync/execSync fallan con
    // "git no se reconoce como un comando interno o externo".
    const gitDir = resolveGitDir();
    if (gitDir) {
        env.PATH = `${gitDir}${path.delimiter}${env.PATH}`;
        logAppend(`[tester] git detectado en ${gitDir} — agregado a PATH del child node`);
    } else {
        logAppend('[tester] WARNING: no se pudo localizar git.exe; los tests pipeline-only que dependen de git pueden fallar');
    }

    // ── Detección de cambios pipeline-only (issue #2891) ─────────────
    // Si todo el diff vs origin/main toca solo `.pipeline/`, `docs/`,
    // `agents/`, `.github/`, no tiene sentido correr Gradle: corremos
    // los tests del propio pipeline con `node --test`.
    //
    // En `verificacion` el tester corre en REPO_ROOT (main worktree, en main),
    // así que el diff desde ahí siempre sería vacío. Detectamos el worktree
    // del agente vía `git worktree list` y hacemos el diff desde ahí
    // (rebote #2892, técnica adoptada de #2893).
    const issueWorktree = findIssueWorktree(REPO_ROOT, issue);
    const diffCwd = issueWorktree || REPO_ROOT;
    if (issueWorktree) {
        logAppend(`[tester] worktree del agente detectado: ${issueWorktree}`);
    }
    const changedFiles = await getChangedFilesVsMain(diffCwd);
    const pipelineOnly = isPipelineOnlyChange(changedFiles);
    if (changedFiles) {
        logAppend(`[tester] git diff vs main: ${changedFiles.length} archivos · pipeline_only=${pipelineOnly}`);
        if (pipelineOnly) {
            logAppend(`[tester] archivos: ${changedFiles.slice(0, 10).join(', ')}${changedFiles.length > 10 ? ' …' : ''}`);
        }
    } else {
        logAppend('[tester] no se pudo determinar diff vs main; usando ruta gradle por defecto');
    }

    const cmd = buildGradleCommand(args.module, args.coverage);
    if (!pipelineOnly) {
        logAppend(`[tester] cmd="${cmd.cmd} ${cmd.args.join(' ')}" modules=${cmd.modules.join(',')}`);
    }

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
    let testRunner = pipelineOnly ? 'node-test' : 'gradle';

    // Captura del timestamp ANTES de spawn — los XMLs escritos antes de este
    // momento son de runs previos y no se deben mezclar con los del run actual
    // (rebote #2892).
    const gradleStartedAt = Date.now();
    const minMtimeMs = gradleStartedAt - STALE_XML_GRACE_MS;

    try {
        if (pipelineOnly) {
            // ── Ruta pipeline-only: node --test ───────────────────────
            // Si el tester corre desde main worktree (verificacion), los
            // *.test.js de main no tienen los cambios del issue. Correr desde
            // el worktree del agente cuando esté disponible.
            const nodeTestRoot = issueWorktree || REPO_ROOT;
            const nodeRes = await runNodeTests(nodeTestRoot, env);
            gradleResult = {
                exit_code: nodeRes.exit_code, wall_ms: nodeRes.wall_ms,
                stdout: nodeRes.stdout, stderr: nodeRes.stderr,
            };
            parsedGradle = { errors: [], warnings: [] };
            tests = nodeRes.summary;

            logAppend(`[tester] node --test exit_code=${nodeRes.exit_code} wall_ms=${nodeRes.wall_ms} files=${nodeRes.files.length}`);
            logAppend(`[tester] node --test summary: tests=${tests.tests} failures=${tests.failures} skipped=${tests.skipped}`);
            if (nodeRes.report_file) logAppend(`[tester] node --test report: ${nodeRes.report_file}`);
            logAppend('[tester] --- stdout (último 2000 chars) ---');
            logAppend((nodeRes.stdout || '').slice(-2000));
            if (nodeRes.stderr) {
                logAppend('[tester] --- stderr (último 1000 chars) ---');
                logAppend(nodeRes.stderr.slice(-1000));
            }

            // Decisión de veredicto para pipeline-only:
            // 1) tests fallidos → rechazado
            // 2) sin tests encontrados → APROBADO con qa:skipped (cambio sin lógica testeable)
            // 3) reporte no parseable pero exit 0 → APROBADO con warning
            // 4) reporte no parseable y exit ≠ 0 → rechazado
            if (tests.valid && (tests.failures > 0 || tests.errors > 0)) {
                exitCode = 1;
                motivo = `Tests Node fallidos: ${tests.failures} failures + ${tests.errors} errors sobre ${tests.tests} totales`;
            } else if (nodeRes.no_tests) {
                logAppend('[tester] pipeline-only sin tests Node detectados — aprobando con qa:skipped equivalente');
                // tests.valid queda en false; el report lo muestra como "skipped"
            } else if (!tests.valid && nodeRes.exit_code !== 0) {
                exitCode = 1;
                motivo = `node --test exit code ${nodeRes.exit_code} sin reporte JUnit parseable`;
            } else if (!tests.valid) {
                logAppend('[tester] WARNING: node --test exit 0 pero reporte no parseable; aprobando por exit code');
            }
            // else: tests OK, exit 0 → aprobado
        } else {
            // ── Ruta original: gradle ────────────────────────────────
            gradleResult = await runGradle({ cmd: cmd.cmd, args: cmd.args, cwd: REPO_ROOT, env });
            logAppend(`[tester] gradle exit_code=${gradleResult.exit_code} wall_ms=${gradleResult.wall_ms}`);
            logAppend('[tester] --- stdout (último 2000 chars) ---');
            logAppend(gradleResult.stdout.slice(-2000));
            logAppend('[tester] --- stderr (último 1000 chars) ---');
            logAppend(gradleResult.stderr.slice(-1000));

            parsedGradle = gradleParser.parseGradleOutput(gradleResult.stdout, gradleResult.stderr);

            // Recolectar reportes XML, filtrando por mtime para evitar leer
            // XMLs stale de runs previos (rebote #2892).
            tests = collectTestReports(cmd.modules, { minMtimeMs });
            if (args.coverage) {
                koverData = collectKoverReports(cmd.modules, { minMtimeMs });
                artifacts = copyArtifacts(koverData.files);
            }

            // Detección temprana: gradle abortó sin ejecutar tests.
            // Síntoma: exit_code ≠ 0 + wall_ms muy bajo (típicamente <2s) +
            // ningún XML fresco. Esto pasa cuando el shell no entiende
            // `./gradlew` (ej. cmd.exe en Windows: `"." no se reconoce`).
            // Sin este chequeo, el tester podría reportar fallas de runs
            // anteriores como si fueran del run actual (rebote #2892).
            const gradleAbortedEarly = gradleResult.exit_code !== 0
                && gradleResult.wall_ms < GRADLE_INSTANT_FAIL_MS
                && !tests.valid;

            // Decisión de veredicto:
            // 0) gradle abortó sin ejecutar tests → rechazado con motivo claro (rebote #2892)
            // 1) tests fallidos o errores → rechazado
            // 2) cobertura < umbral (si se pidió coverage) → rechazado
            // 3) gradle exit code ≠ 0 CON bloque de error clasificable → rechazado
            // 4) gradle exit code ≠ 0 SIN bloque clasificable pero tests OK → APROBADO (los tests son fuente de verdad)
            // 5) no hay reportes JUnit válidos → rechazado (config rota)
            if (gradleAbortedEarly) {
                exitCode = 1;
                const stderrTail = (gradleResult.stderr || '').trim().split('\n').slice(-3).join(' | ').slice(0, 300);
                motivo = `Gradle no ejecutó tests (exit=${gradleResult.exit_code}, ${gradleResult.wall_ms}ms, sin XMLs nuevos). Probable problema de shell/PATH. stderr: ${stderrTail || '(vacío)'}`;
            } else if (tests.valid && (tests.failures > 0 || tests.errors > 0)) {
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
            if (pipelineOnly) {
                // Cualquier fallo en ruta pipeline-only escala a pipeline-dev (issue #2891)
                escalateTo = 'pipeline-dev';
            } else if (gradleResult
                && gradleResult.exit_code !== 0
                && gradleResult.wall_ms < GRADLE_INSTANT_FAIL_MS
                && !(tests && tests.valid)
            ) {
                // Detectar gradle "instant fail" sin XMLs nuevos → es un problema de
                // infra/shell del propio tester, escalar a pipeline-dev (rebote #2892).
                escalateTo = 'pipeline-dev';
            } else if (tests && tests.valid && (tests.failures > 0 || tests.errors > 0)) {
                // Escalar al dev skill según el módulo del primer test fallido
                const first = tests.failed_tests[0];
                if (first && /app\./i.test(first.classname)) escalateTo = 'android-dev';
                else if (first && /(backend|users)\./i.test(first.classname)) escalateTo = 'backend-dev';
                else escalateTo = 'backend-dev';
            } else if (parsedGradle && parsedGradle.errors[0]) {
                escalateTo = parsedGradle.errors[0].escalate_to;
            }
        }

        // Para pipeline-only sin tests, generamos un motivo "qa:skipped" explícito
        let finalMotivo = motivo;
        if (exitCode === 0 && pipelineOnly && !(tests && tests.valid)) {
            finalMotivo = 'Pipeline-only sin tests Node ejecutables — qa:skipped equivalente';
        } else if (exitCode === 0 && pipelineOnly) {
            finalMotivo = `Tests Node verdes (${tests.tests} tests pasaron)`;
        } else if (exitCode === 0 && !finalMotivo) {
            finalMotivo = 'Tests verdes';
        } else if (!finalMotivo) {
            finalMotivo = 'Tests fallidos';
        }

        updateMarker(args.trabajando, {
            resultado: exitCode === 0 ? 'aprobado' : 'rechazado',
            motivo: finalMotivo,
            tester_module: pipelineOnly ? 'pipeline' : args.module,
            tester_runner: testRunner,
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
    if (process.argv.includes('--self-check')) {
        const { runSelfCheck } = require('./lib/self-check');
        runSelfCheck('tester', [
            { name: 'parseArgs sin argumentos', fn: () => {
                const a = parseArgs(['node', 'tester.js']);
                if (typeof a !== 'object' || a === null) throw new Error('parseArgs no devuelve objeto');
            }},
            { name: 'parseArgs con issue', fn: () => {
                const a = parseArgs(['node', 'tester.js', '1234', '--no-coverage']);
                if (a.issue !== 1234) throw new Error(`issue esperado 1234 got ${a.issue}`);
                if (a.coverage !== false) throw new Error('coverage debió quedar false');
            }},
            { name: 'gradle-parser carga', fn: () => {
                const gp = require('./lib/gradle-parser');
                if (!gp || typeof gp !== 'object') throw new Error('gradle-parser no exporta objeto');
            }},
            { name: 'kover-parser carga y parsea testsuite mínimo', fn: () => {
                const kp = require('./lib/kover-parser');
                const sample = '<?xml version="1.0"?><testsuite name="x" tests="1" failures="0" errors="0" skipped="0"></testsuite>';
                const r = kp.parseTestResultsXml(sample);
                if (!r || !r.valid || r.tests !== 1) throw new Error(`parseTestResultsXml devolvió ${JSON.stringify(r)}`);
            }},
            { name: 'kover-parser detecta failures con < y > en stack', fn: () => {
                const kp = require('./lib/kover-parser');
                const sample = '<?xml version="1.0"?><testsuite name="x" tests="1" failures="1" errors="0" skipped="0">'
                    + '<testcase classname="c" name="t" time="0.1">'
                    + '<failure message="boom" type="Error">at Promise.&lt;anonymous&gt; (foo.js:1:1)</failure>'
                    + '</testcase></testsuite>';
                const r = kp.parseTestResultsXml(sample);
                if (r.failed_tests.length !== 1) throw new Error('debió detectar 1 failed_test');
                if (r.failed_tests[0].name !== 't') throw new Error(`name esperado 't' got '${r.failed_tests[0].name}'`);
            }},
            { name: 'PIPELINE_ONLY_PATTERNS detecta .pipeline/', fn: () => {
                const isPipelineOnly = isPipelineOnlyChange(['.pipeline/foo.js', 'docs/bar.md']);
                if (!isPipelineOnly) throw new Error('debió detectar pipeline-only');
            }},
            { name: 'PIPELINE_ONLY_PATTERNS NO detecta cambio mixto', fn: () => {
                const isPipelineOnly = isPipelineOnlyChange(['.pipeline/foo.js', 'app/composeApp/x.kt']);
                if (isPipelineOnly) throw new Error('NO debió detectar pipeline-only (mixto)');
            }},
            { name: 'PIPELINE_ONLY_PATTERNS detecta package.json + package-lock.json junto con .pipeline/ (rebote #3072)', fn: () => {
                const isPipelineOnly = isPipelineOnlyChange([
                    '.pipeline/lib/agent-models.js',
                    '.pipeline/agent-models.json',
                    'package.json',
                    'package-lock.json',
                ]);
                if (!isPipelineOnly) throw new Error('debió detectar pipeline-only con npm manifest/lockfile');
            }},
            { name: 'PIPELINE_ONLY_PATTERNS sigue rechazando build.gradle.kts (frontera Kotlin)', fn: () => {
                const isPipelineOnly = isPipelineOnlyChange(['.pipeline/foo.js', 'app/composeApp/build.gradle.kts']);
                if (isPipelineOnly) throw new Error('NO debió detectar pipeline-only con build.gradle.kts');
            }},
        ]);
        return;
    }
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
    // Pipeline-only routing (issue #2891 + worktree fix #2892)
    isPipelineOnlyChange,
    findIssueWorktree,
    findNodeTestFiles,
    parseNodeTestJunit,
    runNodeTests,
    ensureGitInPath,
    getChangedFilesVsMain,
    resolveGitDir,
    PIPELINE_ONLY_PATTERNS,
    GIT_FALLBACK_DIRS_WIN32,
    MODULE_DIRS,
    DEFAULT_COVERAGE_THRESHOLD,
};

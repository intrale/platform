// Tests unitarios de .pipeline/skills-deterministicos/tester.js (issue #2482)
// No lanzamos gradle real: validamos parseArgs, buildGradleCommand, heartbeat,
// updateMarker, copyArtifacts y renderReport con filesystem aislado.
'use strict';

// Rebote #2892 rev-8: garantizar git en PATH antes de execSync('git …').
// El tester de main puede correr sin Git for Windows en PATH; este helper
// resuelve el directorio de git y lo prepende a process.env.PATH.
require('../../lib/_test-helpers/ensure-git-on-path');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// rebote #2891 rev-3: garantizar git en PATH antes de invocar `execSync('git ...')`.
// El test `findIssueWorktree` arma un repo temporal con `git init` y depende
// de que git esté en el PATH del proceso. Cuando el tester corre desde el
// pulpo como servicio Windows, el PATH heredado puede no incluir Git.
require('../../lib/ensure-git-in-path').ensureGitInProcessPath();

// Aislar REPO_ROOT a un tmp — el módulo resuelve paths a partir de env vars.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-tester-'));
fs.mkdirSync(path.join(TMP, '.claude', 'hooks'), { recursive: true });
fs.mkdirSync(path.join(TMP, '.pipeline', 'logs'), { recursive: true });
fs.mkdirSync(path.join(TMP, '.pipeline', 'verificacion', 'tester', 'trabajando'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'qa', 'artifacts', 'tester'), { recursive: true });
process.env.PIPELINE_REPO_ROOT = TMP;
process.env.CLAUDE_PROJECT_DIR = TMP;

delete require.cache[require.resolve('../tester')];
const tester = require('../tester');
const kover = require('../lib/kover-parser');

test('parseArgs — issue posicional + defaults (module=all, coverage=true)', () => {
    const a = tester.parseArgs(['node', 'tester.js', '2482']);
    assert.equal(a.issue, 2482);
    assert.equal(a.module, 'all');
    assert.equal(a.coverage, true);
    assert.equal(a.threshold, tester.DEFAULT_COVERAGE_THRESHOLD);
});

test('parseArgs — --module=backend|users|app posicional', () => {
    assert.equal(tester.parseArgs(['n', 'x', '1', 'backend']).module, 'backend');
    assert.equal(tester.parseArgs(['n', 'x', '1', 'users']).module, 'users');
    assert.equal(tester.parseArgs(['n', 'x', '1', 'app']).module, 'app');
});

test('parseArgs — --no-coverage desactiva Kover', () => {
    const a = tester.parseArgs(['n', 'x', '1', '--no-coverage']);
    assert.equal(a.coverage, false);
});

test('parseArgs — --threshold=85 ajusta el umbral de cobertura', () => {
    const a = tester.parseArgs(['n', 'x', '1', '--threshold=85']);
    assert.equal(a.threshold, 85);
});

test('parseArgs — fallback a PIPELINE_ISSUE si no hay argumento posicional', () => {
    const saved = process.env.PIPELINE_ISSUE;
    process.env.PIPELINE_ISSUE = '7777';
    try {
        const a = tester.parseArgs(['n', 'x']);
        assert.equal(a.issue, 7777);
    } finally {
        if (saved === undefined) delete process.env.PIPELINE_ISSUE;
        else process.env.PIPELINE_ISSUE = saved;
    }
});

test('buildGradleCommand — module=all incluye los tres módulos + kover backend/app', () => {
    const c = tester.buildGradleCommand('all', true);
    // En Windows el cmd debe ser path absoluto a gradlew.bat (rebote #2892
    // por cmd.exe no entiende `./gradlew`); en Unix sigue siendo `./gradlew`.
    if (process.platform === 'win32') {
        assert.match(c.cmd, /gradlew\.bat$/);
        assert.ok(path.isAbsolute(c.cmd), `cmd debe ser absoluto en Windows, fue: ${c.cmd}`);
    } else {
        assert.equal(c.cmd, './gradlew');
    }
    assert.ok(c.args.includes(':backend:test'));
    assert.ok(c.args.includes(':users:test'));
    // app/composeApp tiene product flavors (Business/Client/Delivery), por lo
    // que `testDebugUnitTest` es ambiguo y Gradle aborta el build (rebote
    // #3002). Enumeramos las tres tareas de flavor explícitamente.
    assert.ok(c.args.includes(':app:composeApp:testClientDebugUnitTest'));
    assert.ok(c.args.includes(':app:composeApp:testBusinessDebugUnitTest'));
    assert.ok(c.args.includes(':app:composeApp:testDeliveryDebugUnitTest'));
    assert.ok(!c.args.includes(':app:composeApp:testDebugUnitTest'),
        'no debe incluirse la tarea ambigua sin flavor');
    assert.ok(c.args.includes(':backend:koverXmlReport'));
    assert.ok(c.args.includes(':app:composeApp:koverXmlReport'));
    assert.ok(c.args.includes('--no-daemon'));
    assert.deepEqual(c.modules, ['backend', 'users', 'app']);
});

test('buildGradleCommand — module=app enumera las tres tareas de flavor (anti-ambiguity #3002)', () => {
    const c = tester.buildGradleCommand('app', false);
    // Con product flavors activos, `:app:composeApp:testDebugUnitTest` no
    // existe — Gradle aborta con "task is ambiguous" listando las 3 variantes.
    // Verificamos que las 3 variantes se incluyan y que la tarea ambigua NO.
    assert.ok(c.args.includes(':app:composeApp:testClientDebugUnitTest'));
    assert.ok(c.args.includes(':app:composeApp:testBusinessDebugUnitTest'));
    assert.ok(c.args.includes(':app:composeApp:testDeliveryDebugUnitTest'));
    assert.ok(!c.args.includes(':app:composeApp:testDebugUnitTest'),
        'no debe incluirse la tarea ambigua sin flavor');
    assert.deepEqual(c.modules, ['app']);
});

test('buildGradleCommand — module=backend incluye :backend:test + :backend:koverXmlReport', () => {
    const c = tester.buildGradleCommand('backend', true);
    assert.ok(c.args.includes(':backend:test'));
    assert.ok(c.args.includes(':backend:koverXmlReport'));
    assert.ok(!c.args.includes(':users:test'));
});

test('buildGradleCommand — module=users sin tarea kover propia', () => {
    const c = tester.buildGradleCommand('users', true);
    assert.ok(c.args.includes(':users:test'));
    assert.ok(!c.args.some((a) => a.includes(':users:koverXmlReport')));
});

test('buildGradleCommand — coverage=false omite todas las tareas Kover', () => {
    const c = tester.buildGradleCommand('all', false);
    assert.ok(c.args.includes(':backend:test'));
    assert.ok(!c.args.some((a) => a.includes('koverXmlReport')));
});

test('startHeartbeat — escribe agent-<issue>.heartbeat con skill=tester y lo limpia', () => {
    const hb = tester.startHeartbeat(2482);
    const hbFile = path.join(TMP, '.claude', 'hooks', 'agent-2482.heartbeat');
    assert.equal(fs.existsSync(hbFile), true);
    const content = JSON.parse(fs.readFileSync(hbFile, 'utf8').trim());
    assert.equal(content.issue, 2482);
    assert.equal(content.skill, 'tester');
    assert.equal(content.model, 'deterministic');
    hb.stop();
    assert.equal(fs.existsSync(hbFile), false);
});

test('startHeartbeat — issue null es no-op', () => {
    const hb = tester.startHeartbeat(null);
    hb.stop();
});

test('updateMarker — escribe resultado/motivo y métricas determinísticas', () => {
    const marker = path.join(TMP, '.pipeline', 'verificacion', 'tester', 'trabajando', '2482.tester');
    fs.writeFileSync(marker, 'issue: 2482\npipeline: verificacion\n');
    tester.updateMarker(marker, {
        resultado: 'aprobado',
        motivo: 'Tests verdes',
        tester_module: 'all',
        tester_duration_ms: 123456,
        tester_tests_total: 42,
        tester_tests_failed: 0,
        tester_coverage_line_percent: 87.5,
        tester_coverage_threshold: 80,
        tester_escalate_to: null,
        tester_mode: 'deterministic',
    });
    const after = fs.readFileSync(marker, 'utf8');
    assert.ok(after.includes('resultado:'));
    assert.ok(after.includes('"aprobado"'));
    assert.ok(after.includes('"Tests verdes"'));
    assert.ok(after.includes('tester_mode:'));
    assert.ok(after.includes('"deterministic"'));
    assert.ok(after.includes('tester_coverage_line_percent: 87.5'));
    // No duplicó issue/pipeline
    const issueLines = after.split('\n').filter((l) => l.startsWith('issue:'));
    assert.equal(issueLines.length, 1);
});

test('updateMarker — trabajandoPath null es no-op', () => {
    tester.updateMarker(null, { resultado: 'aprobado' });
});

test('copyArtifacts — copia kover XML por módulo y escribe TEST_TIMESTAMP', () => {
    const fixturesDir = path.join(__dirname, 'fixtures');
    const koverFixture = path.join(fixturesDir, 'kover-backend.xml');
    assert.equal(fs.existsSync(koverFixture), true, 'fixture kover-backend.xml debe existir');

    const artifacts = tester.copyArtifacts([
        { module: 'backend', file: koverFixture },
    ]);

    const dst = path.join(TMP, 'qa', 'artifacts', 'tester', 'kover-backend.xml');
    assert.ok(artifacts.includes('kover-backend.xml'));
    assert.equal(fs.existsSync(dst), true);
    assert.ok(artifacts.includes('TEST_TIMESTAMP'));
});

test('renderReport — verdict APROBADO cuando exitCode=0', () => {
    // Usamos aggregateKover con un fixture parseado para obtener el shape canónico
    const xml = fs.readFileSync(path.join(__dirname, 'fixtures', 'kover-backend.xml'), 'utf8');
    const parsed = kover.parseKoverXml(xml);
    const coverageAgg = kover.aggregateKover([parsed]);

    const report = tester.renderReport({
        issue: 2482,
        module: 'all',
        coverage: true,
        threshold: 80,
        gradle: { wall_ms: 65000 },
        tests: { valid: true, tests: 10, failures: 0, errors: 0, skipped: 0, time_seconds: 1.2, failed_tests: [] },
        coverageAgg,
        exitCode: 0,
        motivo: null,
    });
    assert.ok(report.includes('APROBADO'));
    assert.ok(report.includes('#2482'));
    assert.ok(report.includes('Módulo: all'));
});

test('renderReport — verdict RECHAZADO con motivo cuando exitCode!=0', () => {
    const coverageAgg = kover.aggregateKover([]); // valid=false → render skipea
    const report = tester.renderReport({
        issue: 2482,
        module: 'backend',
        coverage: true,
        threshold: 80,
        gradle: { wall_ms: 30000 },
        tests: { valid: true, tests: 10, failures: 2, errors: 0, skipped: 0, time_seconds: 1.5, failed_tests: [{ classname: 'a.B', name: 'falla', message: 'expected x got y' }] },
        coverageAgg,
        exitCode: 1,
        motivo: 'Tests fallidos: 2 failures + 0 errors sobre 10 totales',
    });
    assert.ok(report.includes('RECHAZADO'));
    assert.ok(report.includes('Motivo del rebote'));
    assert.ok(report.includes('2 failures'));
});

// ── findIssueWorktree (rebote #2892, técnica de #2893) ─────────────

test('findIssueWorktree — devuelve null si no hay issue', () => {
    assert.equal(tester.findIssueWorktree(TMP, null), null);
    assert.equal(tester.findIssueWorktree(TMP, 0), null);
    assert.equal(tester.findIssueWorktree(TMP, undefined), null);
});

test('findIssueWorktree — devuelve null si git falla / no hay worktrees', () => {
    // En un dir cualquiera sin git, debe devolver null sin tirar excepción
    const noGit = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-tester-nogit-'));
    assert.equal(tester.findIssueWorktree(noGit, 9999), null);
});

test('findIssueWorktree — encuentra worktree por convención platform.agent-<issue>-<skill>', () => {
    // Crear un fake repo con git init y un worktree adicional simulado
    const fakeRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-fakerepo-'));
    const { execSync } = require('child_process');
    try {
        execSync('git init -q', { cwd: fakeRepo, windowsHide: true });
        execSync('git config user.email "t@t"', { cwd: fakeRepo });
        execSync('git config user.name "t"', { cwd: fakeRepo });
        fs.writeFileSync(path.join(fakeRepo, 'README.md'), 'x');
        execSync('git add -A && git commit -qm init', { cwd: fakeRepo, shell: true });
        // Worktree con el naming que espera findIssueWorktree
        const wtPath = path.join(path.dirname(fakeRepo), `platform.agent-7777-pipeline-dev-${Date.now()}`);
        execSync(`git worktree add -q -b agent/7777-pipeline-dev "${wtPath}"`, { cwd: fakeRepo, shell: true });
        try {
            const found = tester.findIssueWorktree(fakeRepo, 7777);
            assert.ok(found, 'Debe encontrar el worktree del issue 7777');
            assert.ok(found.includes('platform.agent-7777-'), 'Debe contener el slug platform.agent-7777-');
            // Issue distinto → no encuentra
            assert.equal(tester.findIssueWorktree(fakeRepo, 9999), null);
        } finally {
            try { execSync(`git worktree remove --force "${wtPath}"`, { cwd: fakeRepo, shell: true, stdio: 'ignore' }); } catch {}
        }
    } catch (e) {
        // Si git no está disponible (rare), el test no aplica.
        // Cubrimos mensajes en inglés y español (Windows localizado).
        const m = e.message || '';
        if (/not found|no such|ENOENT|no se reconoce|is not recognized/i.test(m)) return;
        throw e;
    }
});

// ── collectTestReports — filtro mtime contra XMLs stale (rebote #2892) ─

function setMtime(filePath, msAgo) {
    const t = (Date.now() - msAgo) / 1000;
    fs.utimesSync(filePath, t, t);
}

test('collectTestReports — minMtimeMs descarta XMLs stale (rebote #2892)', () => {
    // Crear estructura backend/build/test-results/test/TEST-Stale.xml con
    // un junit válido que reporta failures, marcado con mtime viejo.
    // Sin filtro: lo lee y reporta failures. Con filtro: lo descarta.
    const moduleDir = path.join(TMP, 'backend');
    const dir = path.join(moduleDir, 'build', 'test-results', 'test');
    fs.mkdirSync(dir, { recursive: true });
    const xmlPath = path.join(dir, 'TEST-Stale.xml');
    // JUnit con 1 failure
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<testsuite name="StaleSuite" tests="1" failures="1" errors="0" skipped="0" time="0.1">\n' +
        '<testcase classname="ui.sc.business.zones.DeliveryZonesViewModelTest" name="stale" time="0.05">' +
        '<failure message="actual value is null" type="AssertionError">stack</failure>' +
        '</testcase>\n' +
        '</testsuite>\n';
    fs.writeFileSync(xmlPath, xml);
    setMtime(xmlPath, 60 * 60 * 1000); // 1h vieja

    // Sin filtro → ve la falla
    const sin = tester.collectTestReports(['backend']);
    assert.equal(sin.valid, true);
    assert.equal(sin.failures, 1);

    // Con filtro de "hace 5 minutos" → no debe verla
    const cutoff = Date.now() - 5 * 60 * 1000;
    const con = tester.collectTestReports(['backend'], { minMtimeMs: cutoff });
    assert.equal(con.valid, false, 'No debe encontrar reportes válidos cuando el XML es stale');
});

// ── Detección pipeline-only (issue #2891) ─────────────────────────

test('isPipelineOnlyChange — true cuando solo hay cambios en .pipeline/', () => {
    assert.equal(tester.isPipelineOnlyChange([
        '.pipeline/anomaly-detector.js',
        '.pipeline/tests/anomaly-detector.test.js',
        '.pipeline/config.yaml',
    ]), true);
});

test('isPipelineOnlyChange — true cuando combina .pipeline/ con docs/ y agents/', () => {
    assert.equal(tester.isPipelineOnlyChange([
        '.pipeline/anomaly-detector.js',
        'docs/pipeline/modo-descanso.md',
        'agents/pipeline-dev.md',
        '.github/workflows/ci.yml',
    ]), true);
});

test('isPipelineOnlyChange — false si hay archivos Kotlin/Compose', () => {
    assert.equal(tester.isPipelineOnlyChange([
        '.pipeline/anomaly-detector.js',
        'app/composeApp/src/commonMain/kotlin/asdo/Foo.kt',
    ]), false);
    assert.equal(tester.isPipelineOnlyChange([
        'backend/src/main/kotlin/Function.kt',
    ]), false);
});

test('isPipelineOnlyChange — false con null/undefined (diff no determinable)', () => {
    // null/undefined significan "no se pudo calcular el diff" (git falló, base
    // ausente, etc.). Conservamos el fallback a gradle por seguridad.
    assert.equal(tester.isPipelineOnlyChange(null), false);
    assert.equal(tester.isPipelineOnlyChange(undefined), false);
});

test('#3342 rev-1 — isPipelineOnlyChange devuelve true con array vacío (branch en sync con main)', () => {
    // Cuando el branch del agente está en sync con main (porque la impl fue
    // mergeada vía sibling branch — caso típico cuando el dev usa
    // `agent/<issue>-completion-client` como rama de trabajo y el worktree del
    // pipeline quedó en `agent/<issue>-pipeline-dev` sin commits), `git diff
    // origin/main...HEAD` devuelve []. Antes el tester rebotaba con
    // "No se encontraron reportes JUnit" porque caía a la ruta gradle, todo
    // estaba UP-TO-DATE y ningún XML JUnit fresco quedaba para parsear. Ahora
    // tratamos array vacío como vacuously pipeline-only (`every` sobre vacío
    // es true por definición) y ruteamos a `node --test` que aprueba limpio si
    // el pipeline está sano.
    //
    // Verificación empírica del bug original en `.pipeline/logs/3342-tester.log`:
    //   [tester] git diff vs main: 0 archivos · pipeline_only=false
    //   [tester] gradle exit_code=0 wall_ms=68724  (BUILD SUCCESSFUL UP-TO-DATE)
    //   - ⏭️ No se encontraron reportes JUnit
    assert.equal(tester.isPipelineOnlyChange([]), true);
});

test('isPipelineOnlyChange — paths fuera de los patrones permitidos rompen el match', () => {
    // README.md en raíz no está (puede ser parte del producto)
    assert.equal(tester.isPipelineOnlyChange(['README.md']), false);
    // gradle.properties / build.gradle.kts SÍ pueden afectar build, no son pipeline-only
    assert.equal(tester.isPipelineOnlyChange([
        '.pipeline/config.yaml',
        'gradle.properties',
    ]), false);
    assert.equal(tester.isPipelineOnlyChange([
        '.pipeline/config.yaml',
        'build.gradle.kts',
    ]), false);
    // settings.gradle.kts también afecta build
    assert.equal(tester.isPipelineOnlyChange([
        '.pipeline/config.yaml',
        'settings.gradle.kts',
    ]), false);
});

// #2895 rev-2 — regresión: cuando un commit toca `.gitignore` junto a
// archivos pipeline, el tester rebotaba porque `.gitignore` rompía el
// match `every` y caía a la ruta gradle, que rebotaba por cobertura
// Kotlin baseline (35.95% < 80%) ajena al cambio. Verificado en
// .pipeline/logs/2895-tester.log (pipeline_only=false con esos 10 archivos).
test('#2895 rev-2 — isPipelineOnlyChange acepta .gitignore root', () => {
    // .gitignore solo (sin código) → pipeline-only
    assert.equal(tester.isPipelineOnlyChange(['.gitignore']), true);
    // .gitignore + cambios .pipeline → pipeline-only (caso real del rebote)
    assert.equal(tester.isPipelineOnlyChange([
        '.gitignore',
        '.pipeline/dashboard.js',
        '.pipeline/lib/eta.js',
        '.pipeline/lib/__tests__/eta.test.js',
        '.pipeline/skills-deterministicos/tester.js',
    ]), true);
});

test('#2895 rev-2 — isPipelineOnlyChange acepta .gitattributes y .editorconfig root', () => {
    assert.equal(tester.isPipelineOnlyChange(['.gitattributes']), true);
    assert.equal(tester.isPipelineOnlyChange(['.editorconfig']), true);
    assert.equal(tester.isPipelineOnlyChange([
        '.editorconfig',
        '.gitattributes',
        '.pipeline/config.yaml',
    ]), true);
});

test('#2895 rev-2 — isPipelineOnlyChange NO confunde .gitignore en subdirectorios fuera de raíz', () => {
    // El patrón es `^\.gitignore$` — si alguien tiene un `.gitignore` adentro
    // de un módulo (ej. `app/.gitignore`), igual debe caer a la ruta gradle.
    assert.equal(tester.isPipelineOnlyChange([
        '.pipeline/config.yaml',
        'app/.gitignore',
    ]), false);
    assert.equal(tester.isPipelineOnlyChange([
        'backend/.gitignore',
    ]), false);
});

// #3072 rev-1 + #3081 rev-2 — regresión combinada: el H1 multi-provider (#3072)
// agregó `ajv` como dependencia npm necesaria para validar el schema, metiendo
// package.json + package-lock.json en el diff. Después #3081 (S3 multi-provider)
// sumó `.husky/pre-commit` por integrar la validación schema en el git hook.
// Ambos rompían el match `every` (los archivos no estaban en allowlist) y forzaban
// la ruta gradle. Gradle no encuentra Kotlin que compilar (cero diffs Kotlin),
// no escribe XMLs JUnit y el tester rebotaba con "No se encontraron reportes JUnit".
// Verificado:
//   .pipeline/logs/3072-tester.log:
//     [tester] git diff vs main: 7 archivos · pipeline_only=false
//     [tester] gradle exit_code=0 wall_ms=64180 (todo UP-TO-DATE)
//     ⏭️ No se encontraron reportes JUnit
//   .pipeline/logs/3081-tester.log:
//     [tester] git diff vs main: 8 archivos · pipeline_only=false
//     - No se encontraron reportes JUnit — posible configuración rota o tests omitidos
//
// El monorepo Intrale no usa npm desde Gradle: ningún build.gradle.kts referencia
// package.json. Por lo tanto package.json + package-lock.json + .husky/ son 100% pipeline.
test('#3072 rev-1 — isPipelineOnlyChange acepta package.json y package-lock.json root', () => {
    // package.json solo (cambio puro de deps npm del pipeline) → pipeline-only
    assert.equal(tester.isPipelineOnlyChange(['package.json']), true);
    assert.equal(tester.isPipelineOnlyChange(['package-lock.json']), true);
    // Caso real del rebote: H1 multi-provider con ajv como dep nueva
    assert.equal(tester.isPipelineOnlyChange([
        '.pipeline/agent-models.json',
        '.pipeline/agent-models.schema.json',
        '.pipeline/lib/__tests__/agent-models.test.js',
        '.pipeline/lib/agent-models.js',
        '.pipeline/pulpo.js',
        'package.json',
        'package-lock.json',
    ]), true);
});

test('#3072 rev-1 — isPipelineOnlyChange NO confunde package.json en subdirectorios', () => {
    // El patrón es `^package\.json$` — si algún módulo tuviera un package.json
    // local (no es el caso hoy, pero defensa en profundidad), debería caer a
    // la ruta gradle por las dudas.
    assert.equal(tester.isPipelineOnlyChange([
        '.pipeline/config.yaml',
        'app/composeApp/package.json',
    ]), false);
    assert.equal(tester.isPipelineOnlyChange([
        'tools/package-lock.json',
    ]), false);
});

test('#3081 rev-2 — isPipelineOnlyChange acepta .husky/, package.json y package-lock.json', () => {
    // Cada uno aislado debe dar pipeline-only.
    assert.equal(tester.isPipelineOnlyChange(['.husky/pre-commit']), true);
    assert.equal(tester.isPipelineOnlyChange(['.husky/pre-push']), true);
    assert.equal(tester.isPipelineOnlyChange(['package.json']), true);
    assert.equal(tester.isPipelineOnlyChange(['package-lock.json']), true);
    // Caso real del rebote #3081: 8 archivos exactos del diff vs origin/main.
    assert.equal(tester.isPipelineOnlyChange([
        '.husky/pre-commit',
        '.pipeline/agent-models.schema.json',
        '.pipeline/lib/__tests__/agent-models-validate.test.js',
        '.pipeline/lib/agent-models-validate.js',
        '.pipeline/pulpo.js',
        'docs/pipeline-multi-provider.md',
        'package-lock.json',
        'package.json',
    ]), true);
});

test('#3081 rev-2 — isPipelineOnlyChange NO acepta package.json en subdirectorios', () => {
    // El patrón es `^package\.json$` — un package.json dentro de un módulo Node
    // anidado en el repo (ej. `tools/forbidden-strings-processor/package.json`)
    // debe caer a la ruta gradle por las dudas: cualquier package.json fuera
    // de la raíz no es Node infra del pipeline y puede tener implicaciones
    // distintas (toolchain de KSP, plugins Gradle con npm wrapper, etc.).
    assert.equal(tester.isPipelineOnlyChange([
        '.pipeline/config.yaml',
        'tools/foo/package.json',
    ]), false);
    assert.equal(tester.isPipelineOnlyChange([
        'app/composeApp/package.json',
    ]), false);
});

test('#3081 rev-2 — isPipelineOnlyChange acepta .husky/ con sub-archivos pero no app/.husky/', () => {
    // El patrón `^\.husky\/` ancla a raíz del repo. Un `.husky/` dentro de
    // un submódulo (improbable pero posible) NO debe disparar pipeline-only.
    assert.equal(tester.isPipelineOnlyChange([
        '.husky/pre-commit',
        '.husky/_/husky.sh',
    ]), true);
    assert.equal(tester.isPipelineOnlyChange([
        'app/.husky/pre-commit',
    ]), false);
});

// ── Rebote #3092 rev-1 ────────────────────────────────────────────
// El M2 multi-provider commiteó un reporte estructural de QA bajo
// `qa/evidence/3092/qa-structural-report.txt`. Ese único path bajo
// `qa/evidence/` rompió el match `every` y forzó la ruta gradle, que
// rebotó por cobertura Kotlin baseline (35.95% < 80%) ajena al cambio.
// Verificación empírica en `.pipeline/logs/3092-tester.log`.
test('#3092 rev-1 — isPipelineOnlyChange acepta qa/evidence/<issue>/*', () => {
    // Reporte estructural solo (cambio puro de QA artifact) → pipeline-only.
    assert.equal(tester.isPipelineOnlyChange([
        'qa/evidence/3092/qa-structural-report.txt',
    ]), true);
    // Combinado con cambios .pipeline + docs (caso real del rebote #3092: 15
    // archivos del diff M2 multi-provider).
    assert.equal(tester.isPipelineOnlyChange([
        '.pipeline/lib/__tests__/quota-adapters/anthropic.test.js',
        '.pipeline/lib/__tests__/quota-adapters/dispatch.test.js',
        '.pipeline/lib/__tests__/quota-adapters/no-quota.test.js',
        '.pipeline/lib/__tests__/quota-adapters/openai-codex.test.js',
        '.pipeline/lib/__tests__/weekly-quota.test.js',
        '.pipeline/lib/quota-adapters/_shape.js',
        '.pipeline/lib/quota-adapters/anthropic.js',
        '.pipeline/lib/quota-adapters/deterministic.js',
        '.pipeline/lib/quota-adapters/gemini.js',
        '.pipeline/lib/quota-adapters/index.js',
        '.pipeline/lib/quota-adapters/ollama.js',
        '.pipeline/lib/quota-adapters/openai-codex.js',
        '.pipeline/lib/weekly-quota.js',
        'docs/operacion-pipeline.md',
        'qa/evidence/3092/qa-structural-report.txt',
    ]), true);
    // Múltiples issues acumulando evidencia QA.
    assert.equal(tester.isPipelineOnlyChange([
        'qa/evidence/3092/qa-structural-report.txt',
        'qa/evidence/3092/screenshot.png',
    ]), true);
});

test('#3092 rev-1 — isPipelineOnlyChange NO acepta otros subdirectorios de qa/', () => {
    // El patrón `^qa\/evidence\/` ancla SOLO al directorio de artifacts. Otros
    // contenidos de `qa/` pueden afectar build/coverage o testing real y NO
    // deben caer en pipeline-only:
    //   qa/build.gradle.kts         → módulo Gradle real (afecta build)
    //   qa/src/test/                → código Kotlin/JS de test
    //   qa/scripts/*.sh             → scripts shell de QA (pueden orquestar gradle)
    //   qa/test-cases/<id>.json     → casos consumidos por scripts QA
    //   qa/regression-suite.json    → catálogo de regresión
    //
    // Frontera afinada por rebote #3409: los archivos .js/.mjs/.cjs bajo
    // `qa/scripts/` ahora SÍ caen en pipeline-only (son hooks Node.js
    // puros que no consume Gradle), pero el resto sigue forzando ruta
    // gradle. El test `#3409 rev-1` documenta el nuevo branch positivo.
    assert.equal(tester.isPipelineOnlyChange([
        '.pipeline/config.yaml',
        'qa/build.gradle.kts',
    ]), false);
    assert.equal(tester.isPipelineOnlyChange([
        '.pipeline/config.yaml',
        'qa/src/test/foo.kt',
    ]), false);
    assert.equal(tester.isPipelineOnlyChange([
        '.pipeline/config.yaml',
        'qa/scripts/qa-android.sh',
    ]), false);
    assert.equal(tester.isPipelineOnlyChange([
        '.pipeline/config.yaml',
        'qa/test-cases/3092.json',
    ]), false);
    assert.equal(tester.isPipelineOnlyChange([
        '.pipeline/config.yaml',
        'qa/regression-suite.json',
    ]), false);
});

// ── Rebote #3409 rev-1 ────────────────────────────────────────────────
// El hook `qa/scripts/promote-screenshots.js` (Node.js puro, 434 líneas)
// + sus 18 tests bajo `qa/scripts/__tests__/promote-screenshots.test.js`
// + `.claude/skills/qa/SKILL.md` modificado + `docs/qa/screenshot-promotion.md`
// + `package.json` formaron un cambio puramente pipeline-only que el
// tester clasificó como mixto porque los .js bajo `qa/scripts/` no
// matcheaban ningún pattern. Resultado: ruta gradle, 0 JUnit reports,
// rebote por "No se encontraron reportes JUnit".
//
// Verificación de seguridad: `grep` por `qa/scripts` en `**/*.gradle*`
// devuelve 0 referencias — Gradle no consume estos scripts; los invoca
// el skill /qa (Node.js).
test('#3409 rev-1 — isPipelineOnlyChange acepta qa/scripts/*.js y __tests__/*.test.js', () => {
    // Hook Node.js bajo qa/scripts/ → pipeline-only.
    assert.equal(tester.isPipelineOnlyChange([
        'qa/scripts/promote-screenshots.js',
    ]), true);
    // Test del hook bajo qa/scripts/__tests__/ → pipeline-only.
    assert.equal(tester.isPipelineOnlyChange([
        'qa/scripts/__tests__/promote-screenshots.test.js',
    ]), true);
    // Variantes .mjs / .cjs también caen en pipeline-only.
    assert.equal(tester.isPipelineOnlyChange([
        'qa/scripts/some-hook.mjs',
    ]), true);
    assert.equal(tester.isPipelineOnlyChange([
        'qa/scripts/legacy-hook.cjs',
    ]), true);
    // Caso real del rebote #3409: 5 archivos exactos del diff vs origin/main.
    assert.equal(tester.isPipelineOnlyChange([
        '.claude/skills/qa/SKILL.md',
        'docs/qa/screenshot-promotion.md',
        'package.json',
        'qa/scripts/__tests__/promote-screenshots.test.js',
        'qa/scripts/promote-screenshots.js',
    ]), true);
});

test('#3409 rev-1 — isPipelineOnlyChange mantiene la frontera #3092 para shells/configs/casos QA', () => {
    // Los .sh bajo qa/scripts/ siguen forzando ruta gradle: pueden orquestar
    // ejecuciones gradle/emulador y un cambio ahí debe verificarse en flujo
    // QA real, no por tests Node aislados.
    assert.equal(tester.isPipelineOnlyChange([
        'qa/scripts/qa-android.sh',
    ]), false);
    assert.equal(tester.isPipelineOnlyChange([
        'qa/scripts/promote-screenshots.js',
        'qa/scripts/qa-android.sh',
    ]), false);
    // Subdirectorios anidados que NO son __tests__/ y archivos sin extensión
    // .js/.mjs/.cjs no califican (defensa contra typos / archivos opacos).
    assert.equal(tester.isPipelineOnlyChange([
        'qa/scripts/promote-screenshots',  // sin extensión
    ]), false);
    // qa/scripts/ anidado dentro de un módulo NO debe disparar pipeline-only
    // (mismo ancla a raíz que el resto de patrones #3092/#2398).
    assert.equal(tester.isPipelineOnlyChange([
        'app/qa/scripts/foo.js',
    ]), false);
});

test('#3092 rev-1 — isPipelineOnlyChange NO confunde qa/evidence en subdirectorios anidados', () => {
    // El patrón `^qa\/evidence\/` ancla a raíz. Un `qa/evidence/` dentro de
    // un módulo (improbable pero posible) NO debe disparar pipeline-only.
    assert.equal(tester.isPipelineOnlyChange([
        'app/qa/evidence/foo.png',
    ]), false);
    assert.equal(tester.isPipelineOnlyChange([
        'backend/qa/evidence/log.txt',
    ]), false);
});

// ── Rebote #3576 rev-1 ────────────────────────────────────────────────
// El #3576 (Hook onSpawnExit cross-skill + audit unificado) entregó un
// script bash auxiliar `scripts/diff-parser-codepaths.sh` que compara
// paridad entre los codepaths legacy y generalized leyendo el log textual
// del pulpo. Es 100% pipeline-only — un log-analyzer que ni siquiera está
// referenciado por Gradle — pero el archivo cae bajo `scripts/` que no
// tenía pattern de allowlist. El cambio del PR incluía:
//   .pipeline/lib/agent-launcher/...
//   .pipeline/lib/quota-exhausted.js
//   .pipeline/pulpo.js
//   docs/pipeline/multi-provider.md
//   scripts/diff-parser-codepaths.sh   ← rompía el `every` match
// El tester cayó a la ruta gradle, todo UP-TO-DATE, 0 JUnit reports →
// rebote "[tester] No se encontraron reportes JUnit". Verificación
// empírica en `.pipeline/logs/3576-tester.log`:
//   [tester] git diff vs main: 13 archivos · pipeline_only=false
//   [tester] gradle exit_code=0 wall_ms=65814 BUILD SUCCESSFUL UP-TO-DATE
//   - No se encontraron reportes JUnit
//
// Verificación de seguridad: `grep` por `scripts/diff-parser-codepaths`
// en `**/*.{kts,gradle,kt,properties}` devuelve 0 referencias — Gradle
// no consume este script; se invoca a mano por el operador (documentado
// en `docs/pipeline/multi-provider.md`).
test('#3576 rev-1 — isPipelineOnlyChange acepta scripts/diff-parser-codepaths.sh', () => {
    // Script aislado → pipeline-only.
    assert.equal(tester.isPipelineOnlyChange([
        'scripts/diff-parser-codepaths.sh',
    ]), true);
    // Caso real del rebote #3576: 13 archivos exactos del diff vs origin/main.
    assert.equal(tester.isPipelineOnlyChange([
        '.pipeline/lib/agent-launcher/__tests__/fixtures/skill-real/builder-timeout-noresult.json',
        '.pipeline/lib/agent-launcher/__tests__/fixtures/skill-real/commander-anthropic-result-event.json',
        '.pipeline/lib/agent-launcher/__tests__/fixtures/skill-real/guru-anthropic-cli-usage-limit.json',
        '.pipeline/lib/agent-launcher/__tests__/fixtures/skill-real/planner-anthropic-cli-credits-required.json',
        '.pipeline/lib/agent-launcher/__tests__/fixtures/skill-real/qa-openai-codex-sse-insufficient-quota.json',
        '.pipeline/lib/agent-launcher/__tests__/onSpawnExit.test.js',
        '.pipeline/lib/agent-launcher/__tests__/provider-error-parser.test.js',
        '.pipeline/lib/agent-launcher/dispatch-with-fallback.js',
        '.pipeline/lib/agent-launcher/providers/anthropic.js',
        '.pipeline/lib/quota-exhausted.js',
        '.pipeline/pulpo.js',
        'docs/pipeline/multi-provider.md',
        'scripts/diff-parser-codepaths.sh',
    ]), true);
});

test('#3576 rev-1 — isPipelineOnlyChange mantiene la frontera de scripts/ (resto sigue forzando gradle)', () => {
    // El pattern es exacto a `scripts/diff-parser-codepaths.sh` — el resto de
    // `scripts/` puede orquestar Gradle/AWS/emulador y debe seguir cayendo a
    // ruta gradle. Defensa contra falsos positivos.
    assert.equal(tester.isPipelineOnlyChange([
        'scripts/local-up.sh',
    ]), false);
    assert.equal(tester.isPipelineOnlyChange([
        'scripts/local-app.sh',
    ]), false);
    assert.equal(tester.isPipelineOnlyChange([
        'scripts/smart-build.sh',
    ]), false);
    // Variantes sospechosas — typos / renames — siguen forzando gradle.
    assert.equal(tester.isPipelineOnlyChange([
        'scripts/diff-parser-codepaths.bash',  // extensión distinta
    ]), false);
    assert.equal(tester.isPipelineOnlyChange([
        'scripts/diff-parser-codepaths',       // sin extensión
    ]), false);
    // Anidamiento bajo módulos (improbable pero posible) no debe disparar.
    assert.equal(tester.isPipelineOnlyChange([
        'app/scripts/diff-parser-codepaths.sh',
    ]), false);
});

// ── Rebote #2398 rev-1 ────────────────────────────────────────────
// El cambio del ghostbusters (#2398) tocó archivos puramente Node.js bajo
// `.pipeline/lib/` + `.pipeline/ghostbusters.js` + el archivo de
// instrucciones del skill `.claude/skills/ghostbusters/SKILL.md`. El path
// bajo `.claude/` rompió el match `every` y forzó la ruta gradle, que
// para un cambio sin código Kotlin no produjo reportes JUnit:
//   diff vs origin/main: 4 archivos
//   → tester rebote: "[tester] No se encontraron reportes JUnit"
test('#2398 rev-1 — isPipelineOnlyChange acepta .claude/skills/<skill>/SKILL.md', () => {
    // Archivo de instrucciones de skill solo (cambio puro de docs del skill) → pipeline-only.
    assert.equal(tester.isPipelineOnlyChange([
        '.claude/skills/ghostbusters/SKILL.md',
    ]), true);
    // Hooks Node.js del harness Claude Code → pipeline-only.
    assert.equal(tester.isPipelineOnlyChange([
        '.claude/hooks/agent-concurrency-check.js',
    ]), true);
    // Settings del harness → pipeline-only.
    assert.equal(tester.isPipelineOnlyChange([
        '.claude/settings.json',
    ]), true);
    assert.equal(tester.isPipelineOnlyChange([
        '.claude/settings.local.json',
    ]), true);
    // Caso real del rebote #2398: 4 archivos exactos del diff vs origin/main.
    assert.equal(tester.isPipelineOnlyChange([
        '.claude/skills/ghostbusters/SKILL.md',
        '.pipeline/ghostbusters.js',
        '.pipeline/lib/__tests__/stale-branches.test.js',
        '.pipeline/lib/stale-branches.js',
    ]), true);
});

test('#2398 rev-1 — isPipelineOnlyChange NO confunde .claude en subdirectorios anidados', () => {
    // El patrón `^\.claude\/` ancla a raíz. Un `.claude/` dentro de un
    // módulo (improbable pero posible) NO debe disparar pipeline-only.
    assert.equal(tester.isPipelineOnlyChange([
        'app/.claude/skills/foo.md',
    ]), false);
    assert.equal(tester.isPipelineOnlyChange([
        'backend/.claude/hooks/bar.js',
    ]), false);
});

test('parseNodeTestJunit — lee tests/pass/fail/skipped del comentario summary', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
\t<testcase name="t1" time="0.001" classname="test" file="x.test.js"/>
\t<testcase name="t2" time="0.002" classname="test" file="x.test.js"/>
\t<!-- tests 2 -->
\t<!-- pass 2 -->
\t<!-- fail 0 -->
\t<!-- skipped 0 -->
\t<!-- duration_ms 50.5 -->
</testsuites>`;
    const r = tester.parseNodeTestJunit(xml);
    assert.equal(r.valid, true);
    assert.equal(r.tests, 2);
    assert.equal(r.failures, 0);
    assert.equal(r.skipped, 0);
    assert.ok(r.time_seconds > 0);
});

test('parseNodeTestJunit — extrae failed_tests con name/classname/message', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
\t<testcase name="ok" time="0.001" classname="test" file="x.test.js"/>
\t<testcase name="rompe" time="0.002" classname="test" file="x.test.js">
\t\t<failure type="testCodeFailure" message="expected 1 to equal 2">
AssertionError: expected 1 to equal 2
    at Test.<anonymous> (x.test.js:10:5)
\t\t</failure>
\t</testcase>
\t<!-- tests 2 -->
\t<!-- fail 1 -->
</testsuites>`;
    const r = tester.parseNodeTestJunit(xml);
    assert.equal(r.tests, 2);
    assert.equal(r.failures, 1);
    assert.equal(r.failed_tests.length, 1);
    assert.equal(r.failed_tests[0].name, 'rompe');
    assert.equal(r.failed_tests[0].classname, 'test');
    assert.ok(r.failed_tests[0].message.includes('expected 1 to equal 2'));
});

test('parseNodeTestJunit — atributo name con `>` literal no rompe el parser (regresión #2892)', () => {
    // node --test escribe el name del test sin escapar `>` (XML lo permite
    // dentro de values de atributos). Antes del fix, el regex `[^>]*?`
    // truncaba el match al primer `>` y los testcases siguientes perdían
    // name/classname → el reporte mostraba "(sin nombre) > test failed"
    // y el dev no podía saber qué archivo abrir.
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
\t<testcase name="conserva &amp;quot;> Task :xxx FAILED&amp;quot;" time="0.001" classname="test" file="apk.test.js"/>
\t<testcase name="C:\\\\repo\\\\.pipeline\\\\tests\\\\sanitizer.test.js" time="0.7" classname="test" file="C:\\\\repo\\\\.pipeline\\\\tests\\\\sanitizer.test.js" failure="test failed">
\t\t<failure type="testCodeFailure" message="test failed">
[Error: test failed] { code: 'ERR_TEST_FAILURE' }
\t\t</failure>
\t</testcase>
\t<!-- tests 2 -->
\t<!-- fail 1 -->
</testsuites>`;
    const r = tester.parseNodeTestJunit(xml);
    assert.equal(r.failures, 1);
    assert.equal(r.failed_tests.length, 1);
    assert.ok(r.failed_tests[0].name.endsWith('sanitizer.test.js'),
        `name debería contener sanitizer.test.js, fue: ${r.failed_tests[0].name}`);
    assert.equal(r.failed_tests[0].classname, 'test');
    assert.equal(r.failed_tests[0].message, 'test failed');
    assert.ok(r.failed_tests[0].stack_snippet.includes('ERR_TEST_FAILURE'));
});

test('parseNodeTestJunit — XML vacío o malformado devuelve valid:false', () => {
    assert.equal(tester.parseNodeTestJunit('').valid, false);
    assert.equal(tester.parseNodeTestJunit(null).valid, false);
    assert.equal(tester.parseNodeTestJunit('<not-xml').valid, false);
});

test('findNodeTestFiles — encuentra *.test.js dentro de .pipeline/ y excluye node_modules/desarrollo', () => {
    // Crear estructura mock dentro de TMP
    const pipeRoot = path.join(TMP, '.pipeline');
    fs.mkdirSync(path.join(pipeRoot, 'tests'), { recursive: true });
    fs.mkdirSync(path.join(pipeRoot, 'metrics', '__tests__'), { recursive: true });
    fs.mkdirSync(path.join(pipeRoot, 'node_modules', 'foo'), { recursive: true });
    fs.mkdirSync(path.join(pipeRoot, 'desarrollo', 'dev', 'pendiente'), { recursive: true });
    fs.writeFileSync(path.join(pipeRoot, 'tests', 'a.test.js'), '// test');
    fs.writeFileSync(path.join(pipeRoot, 'metrics', '__tests__', 'b.test.js'), '// test');
    fs.writeFileSync(path.join(pipeRoot, 'node_modules', 'foo', 'c.test.js'), '// excluded');
    fs.writeFileSync(path.join(pipeRoot, 'desarrollo', 'dev', 'pendiente', 'd.test.js'), '// excluded');
    fs.writeFileSync(path.join(pipeRoot, 'utils.js'), '// no test');

    const found = tester.findNodeTestFiles(TMP).map((f) => path.relative(TMP, f).replace(/\\/g, '/'));
    assert.ok(found.includes('.pipeline/tests/a.test.js'));
    assert.ok(found.includes('.pipeline/metrics/__tests__/b.test.js'));
    assert.ok(!found.some((f) => f.includes('node_modules')), 'node_modules debe estar excluido');
    assert.ok(!found.some((f) => f.includes('desarrollo')), 'desarrollo/ debe estar excluido');
});

// Rebote #3409 rev-1: el tester corre `node --test` sobre los archivos que
// findNodeTestFiles le devuelve. Sin esta extensión, los 18 tests del hook
// `qa/scripts/promote-screenshots.js` no se ejecutaban en la ruta
// pipeline-only y el tester aprobaba como qa:skipped sin haber corrido tests
// reales. Acá validamos que el segundo root (`qa/scripts/__tests__/`) se
// escanea de forma simétrica a `.pipeline/`.
test('#3409 rev-1 — findNodeTestFiles escanea también qa/scripts/__tests__/', () => {
    // Crear un repo fresco para no contaminar con tests de los otros casos.
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-tester-3409-'));
    // .pipeline/ test
    fs.mkdirSync(path.join(fresh, '.pipeline', 'tests'), { recursive: true });
    fs.writeFileSync(path.join(fresh, '.pipeline', 'tests', 'pipe.test.js'), '// pipeline test');
    // qa/scripts/__tests__/ test (objetivo del rebote)
    fs.mkdirSync(path.join(fresh, 'qa', 'scripts', '__tests__'), { recursive: true });
    fs.writeFileSync(
        path.join(fresh, 'qa', 'scripts', '__tests__', 'promote-screenshots.test.js'),
        '// qa script test'
    );
    // Archivos no-test bajo qa/scripts/__tests__/ → ignorados (no terminan en .test.js)
    fs.writeFileSync(
        path.join(fresh, 'qa', 'scripts', '__tests__', 'helpers.js'),
        '// helper, sin sufijo .test.js'
    );
    // qa/scripts/promote-screenshots.js (NO está en __tests__/) → ignorado
    fs.writeFileSync(
        path.join(fresh, 'qa', 'scripts', 'promote-screenshots.js'),
        '// hook implementation, no tests'
    );
    // qa/evidence/ no debe contar como root de tests (no es escaneado).
    fs.mkdirSync(path.join(fresh, 'qa', 'evidence', '3409'), { recursive: true });
    fs.writeFileSync(
        path.join(fresh, 'qa', 'evidence', '3409', 'stray.test.js'),
        '// no debe levantarse'
    );

    const found = tester.findNodeTestFiles(fresh).map((f) => path.relative(fresh, f).replace(/\\/g, '/'));
    assert.ok(found.includes('.pipeline/tests/pipe.test.js'),
        `esperaba .pipeline/tests/pipe.test.js, fue: ${JSON.stringify(found)}`);
    assert.ok(found.includes('qa/scripts/__tests__/promote-screenshots.test.js'),
        `esperaba qa/scripts/__tests__/promote-screenshots.test.js, fue: ${JSON.stringify(found)}`);
    assert.ok(!found.some((f) => f.includes('helpers.js')), 'helpers.js no debe contarse como test');
    assert.ok(!found.some((f) => f.endsWith('promote-screenshots.js') && !f.endsWith('.test.js')),
        'el hook (no-test) no debe contarse');
    assert.ok(!found.some((f) => f.includes('qa/evidence')),
        'qa/evidence/ no debe escanearse aunque tenga *.test.js sueltos');
});

// Defensa: si qa/scripts/__tests__/ no existe en el repo, findNodeTestFiles
// no debe romper. Esto cubre repos que no usan el patrón QA Node aún (ej.
// worktrees viejos o forks limpios).
test('#3409 rev-1 — findNodeTestFiles tolera ausencia de qa/scripts/__tests__/', () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-tester-3409-empty-'));
    fs.mkdirSync(path.join(fresh, '.pipeline', 'tests'), { recursive: true });
    fs.writeFileSync(path.join(fresh, '.pipeline', 'tests', 'only-pipe.test.js'), '// solo pipeline');
    // qa/ NO existe.
    const found = tester.findNodeTestFiles(fresh).map((f) => path.relative(fresh, f).replace(/\\/g, '/'));
    assert.deepEqual(found, ['.pipeline/tests/only-pipe.test.js']);
});

test('runNodeTests — sin tests detectados devuelve no_tests:true y exit_code:0', async () => {
    // TMP en este punto puede tener tests del test anterior — usemos un repo fresco
    const fresh = fs.mkdtempSync(path.join(require('os').tmpdir(), 'v3-tester-fresh-'));
    fs.mkdirSync(path.join(fresh, '.pipeline'), { recursive: true });
    const r = await tester.runNodeTests(fresh, process.env);
    assert.equal(r.no_tests, true);
    assert.equal(r.exit_code, 0);
    assert.equal(r.summary.valid, false);
    assert.equal(r.summary.tests, 0);
});

test('runNodeTests — corre un test real, parsea JUnit y reporta tests/failures', async () => {
    const fresh = fs.mkdtempSync(path.join(require('os').tmpdir(), 'v3-tester-real-'));
    fs.mkdirSync(path.join(fresh, '.pipeline', 'tests'), { recursive: true });
    fs.mkdirSync(path.join(fresh, '.pipeline', 'logs'), { recursive: true });
    const testFile = path.join(fresh, '.pipeline', 'tests', 'sample.test.js');
    fs.writeFileSync(testFile, `
const test = require('node:test');
const assert = require('node:assert/strict');
test('suma básica', () => { assert.equal(1 + 1, 2); });
test('multiplicación', () => { assert.equal(2 * 3, 6); });
`);
    const r = await tester.runNodeTests(fresh, process.env);
    assert.equal(r.no_tests, undefined);
    assert.equal(r.exit_code, 0);
    assert.equal(r.summary.valid, true);
    assert.equal(r.summary.tests, 2);
    assert.equal(r.summary.failures, 0);
    assert.ok(r.report_file && fs.existsSync(r.report_file), 'report file debe existir');
});

test('runNodeTests — test fallido devuelve exit_code:1 y failures>0', async () => {
    const fresh = fs.mkdtempSync(path.join(require('os').tmpdir(), 'v3-tester-fail-'));
    fs.mkdirSync(path.join(fresh, '.pipeline', 'tests'), { recursive: true });
    fs.mkdirSync(path.join(fresh, '.pipeline', 'logs'), { recursive: true });
    const testFile = path.join(fresh, '.pipeline', 'tests', 'fail.test.js');
    fs.writeFileSync(testFile, `
const test = require('node:test');
const assert = require('node:assert/strict');
test('siempre rompe', () => { assert.equal(1, 2); });
`);
    const r = await tester.runNodeTests(fresh, process.env);
    assert.equal(r.exit_code, 1);
    assert.equal(r.summary.tests, 1);
    assert.equal(r.summary.failures, 1);
    assert.equal(r.summary.failed_tests[0].name, 'siempre rompe');
});

// #3344 — Antes de este fix, un test que dejaba un handle activo (timer,
// socket, server HTTP sin cerrar) hacía que `node --test` nunca terminara,
// porque el runner top-level espera a que todos los workers cierren sus
// handles. El tester quedaba colgado hasta que el watchdog del Pulpo lo
// mataba a los 45min, con reporte JUnit vacío. El fix: spawn lanza
// `--test-timeout=120000` (corta tests individuales), `runNodeTests` aplica
// wall-clock duro de 12min (mata el child con SIGKILL/taskkill /T /F) y
// emite heartbeat de progreso vía opts.onLog. Verificamos los hooks nuevos
// sobre un test normal sin alterar el éxito del run.
test('#3344 — runNodeTests acepta opts.onLog (heartbeat) sin romper runs normales', async () => {
    const fresh = fs.mkdtempSync(path.join(require('os').tmpdir(), 'v3-tester-3344-onlog-'));
    fs.mkdirSync(path.join(fresh, '.pipeline', 'tests'), { recursive: true });
    fs.mkdirSync(path.join(fresh, '.pipeline', 'logs'), { recursive: true });
    fs.writeFileSync(path.join(fresh, '.pipeline', 'tests', 'fast.test.js'), `
const test = require('node:test');
const assert = require('node:assert/strict');
test('ok', () => { assert.equal(1, 1); });
`);
    const logs = [];
    const r = await tester.runNodeTests(fresh, process.env, {
        onLog: (m) => logs.push(m),
    });
    assert.equal(r.exit_code, 0);
    assert.equal(r.timed_out, false);
    assert.equal(typeof r.last_progress_line, 'string');
    // El run termina rápido, así que el heartbeat (intervalo 30s) puede no
    // disparar nunca — sólo verificamos que el callback se aceptó sin error.
    assert.ok(Array.isArray(logs));
});

test('#3344 — runNodeTests setea timed_out:false en run normal y last_progress_line presente', async () => {
    const fresh = fs.mkdtempSync(path.join(require('os').tmpdir(), 'v3-tester-3344-fields-'));
    fs.mkdirSync(path.join(fresh, '.pipeline', 'tests'), { recursive: true });
    fs.mkdirSync(path.join(fresh, '.pipeline', 'logs'), { recursive: true });
    fs.writeFileSync(path.join(fresh, '.pipeline', 'tests', 'sample.test.js'), `
const test = require('node:test');
const assert = require('node:assert/strict');
test('ok', () => { assert.equal(2, 2); });
`);
    const r = await tester.runNodeTests(fresh, process.env);
    assert.equal(r.timed_out, false);
    assert.equal(r.exit_code, 0);
    assert.equal(typeof r.last_progress_line, 'string');
});

// #3737 (rebote rev-2) — Regresión del exit 124 "sin reporte JUnit parseable".
// Un *.test.js cuyos tests PASAN pero deja un handle activo (setInterval,
// socket, server sin cerrar) mantenía vivo su child process; el runner
// top-level esperaba indefinidamente, el wall-timeout de 12min mataba el
// árbol, y como el reporter junit bufferea todo el documento hasta el final
// del run, el XML quedaba en 52 bytes (solo el header <testsuites>) →
// tests=0 → rebote. El fix `--test-force-exit` fuerza la salida del child
// al completar sus tests. Sin el flag, este test colgaría hasta el
// --test-timeout del runner padre; con el flag termina en segundos.
test('#3737 rev-2 — runNodeTests termina y flushea JUnit aunque un test deje un handle abierto', async () => {
    const fresh = fs.mkdtempSync(path.join(require('os').tmpdir(), 'v3-tester-3737-handle-'));
    fs.mkdirSync(path.join(fresh, '.pipeline', 'tests'), { recursive: true });
    fs.mkdirSync(path.join(fresh, '.pipeline', 'logs'), { recursive: true });
    fs.writeFileSync(path.join(fresh, '.pipeline', 'tests', 'leaky.test.js'), `
const test = require('node:test');
const assert = require('node:assert/strict');
test('pasa pero deja un interval vivo', () => { assert.equal(1, 1); });
// Handle residual post-éxito: sin --test-force-exit este child nunca sale.
setInterval(() => {}, 1000);
`);
    fs.writeFileSync(path.join(fresh, '.pipeline', 'tests', 'normal.test.js'), `
const test = require('node:test');
const assert = require('node:assert/strict');
test('normal ok', () => { assert.equal(2, 2); });
`);
    const r = await tester.runNodeTests(fresh, process.env);
    assert.equal(r.timed_out, false, 'el run NO debe llegar al wall-timeout');
    assert.equal(r.exit_code, 0, 'ambos files pasan → exit 0');
    assert.equal(r.summary.valid, true, 'el JUnit debe flushearse completo (no 52 bytes)');
    assert.equal(r.summary.tests, 2, 'los 2 tests deben quedar reportados');
    assert.equal(r.summary.failures, 0);
});

// #3897 rev-2 — endurecimiento anti-cuelgue del runner.
//
// Contexto del rebote: 2/2 runs reales del tester sobre #3897 colgaron 12 min
// (exit 124) con JUnit de 52 bytes (solo header `<testsuites>`) y stdout
// vacío, mientras la MISMA batería de 279 archivos pasaba en ~79s corrida a
// mano. La clase de cuelgue: un .test.js cuyos tests PASAN pero cuyo proceso
// queda vivo por un handle no clausurado (timer/socket/watcher) — el runner
// top-level espera a ese worker para siempre y el reporter junit nunca
// flushea las suites. `--test-timeout` no cubre este caso (corta tests, no
// handles post-test). El fix: `--test-force-exit` (Node >= 22).
test('#3897 rev-2 — handle vivo post-test NO cuelga el run (--test-force-exit)', async () => {
    const fresh = fs.mkdtempSync(path.join(require('os').tmpdir(), 'v3-tester-3897-handle-'));
    fs.mkdirSync(path.join(fresh, '.pipeline', 'tests'), { recursive: true });
    fs.mkdirSync(path.join(fresh, '.pipeline', 'logs'), { recursive: true });
    // Test que pasa pero deja un setInterval SIN unref: sin --test-force-exit
    // el proceso del test queda vivo y runNodeTests solo terminaría por
    // wall-timeout de 12 min (exit 124, JUnit vacío — el síntoma del rebote).
    fs.writeFileSync(path.join(fresh, '.pipeline', 'tests', 'leaky.test.js'), `
const test = require('node:test');
const assert = require('node:assert/strict');
test('pasa pero deja un timer vivo', () => {
    setInterval(() => {}, 60 * 1000); // handle vivo a propósito (sin unref)
    assert.equal(1, 1);
});
`);
    const r = await tester.runNodeTests(fresh, process.env);
    assert.equal(r.timed_out, false, 'el run NO debe llegar al wall-timeout');
    assert.equal(r.exit_code, 0, 'los tests pasan y el runner sale igual');
    assert.equal(r.summary.valid, true, 'el JUnit debe quedar parseable (flusheado antes del force-exit)');
    assert.equal(r.summary.tests, 1);
    assert.equal(r.summary.failures, 0);
});

test('#3897 rev-2 — reporter dual: stdout trae progreso spec además del JUnit a archivo', async () => {
    const fresh = fs.mkdtempSync(path.join(require('os').tmpdir(), 'v3-tester-3897-spec-'));
    fs.mkdirSync(path.join(fresh, '.pipeline', 'tests'), { recursive: true });
    fs.mkdirSync(path.join(fresh, '.pipeline', 'logs'), { recursive: true });
    fs.writeFileSync(path.join(fresh, '.pipeline', 'tests', 'visible.test.js'), `
const test = require('node:test');
const assert = require('node:assert/strict');
test('progreso visible en stdout', () => { assert.equal(1, 1); });
`);
    const r = await tester.runNodeTests(fresh, process.env);
    assert.equal(r.exit_code, 0);
    // Antes del fix junit era el ÚNICO reporter → stdout vacío →
    // last_progress_line "" y el heartbeat no identificaba el archivo colgado.
    assert.ok(r.stdout.includes('progreso visible en stdout'),
        'el reporter spec debe volcar el progreso a stdout');
    assert.ok(r.last_progress_line.length > 0,
        'last_progress_line debe quedar poblada para el post-mortem del wall-timeout');
    // Y el JUnit del archivo sigue siendo la fuente parseable.
    assert.equal(r.summary.valid, true);
    assert.equal(r.summary.tests, 1);
});

// NOTA #3897 rev-2: el spawn de runNodeTests pasa `stdio: ['ignore', 'pipe',
// 'pipe']` como defensa adicional (stdin pipe nunca cerrado por el tester era
// un EOF que jamás llegaba). No hay test dedicado: el runner de node --test
// reconecta el stdin de sus workers a discreción, así que un test que lea
// stdin cuelga hasta el per-test timeout (120s) sin importar el stdio del
// runner — verificado empíricamente. La clase de cuelgue queda cubierta por
// `--test-force-exit` + `--test-timeout` (tests de arriba).

// #2895 (rebote rev-1): regresión empírica del rebote del 2026-04-30.
// Los tests del pipeline fallaban en producción cuando el pulpo arrancaba
// como servicio sin git en el PATH heredado. Este test simula ese caso
// empíricamente: spawnea node --test desde runNodeTests con un PATH
// inicialmente sin git, y verifica que el test child puede igual ejecutar
// `git --version` (porque ensureGitInPath lo prepende).
test('#2895 rev-1 — runNodeTests garantiza git accesible aunque PATH inicial no lo tenga', async () => {
    if (process.platform !== 'win32') return; // bug específico de Windows
    const fresh = fs.mkdtempSync(path.join(require('os').tmpdir(), 'v3-tester-gitpath-'));
    fs.mkdirSync(path.join(fresh, '.pipeline', 'tests'), { recursive: true });
    fs.mkdirSync(path.join(fresh, '.pipeline', 'logs'), { recursive: true });
    const testFile = path.join(fresh, '.pipeline', 'tests', 'git-needed.test.js');
    // Test que requiere git: si el child no tiene git en PATH, este test falla.
    fs.writeFileSync(testFile, `
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
test('git --version disponible en el child', () => {
    const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
    assert.equal(r.status, 0, 'git debe estar accesible. stderr=' + r.stderr + ' error=' + (r.error && r.error.code));
    assert.match(r.stdout || '', /git version/);
});
`);
    // Env tipo "pulpo arrancado como servicio Windows": PATH mínimo sin git
    const minimalEnv = {
        SystemRoot: process.env.SystemRoot || 'C:\\Windows',
        // PATH sin git (sólo system32 para que node y cmd.exe arranquen)
        PATH: 'C:\\Windows\\System32;C:\\Windows',
    };
    const r = await tester.runNodeTests(fresh, minimalEnv);
    assert.equal(r.summary.failures, 0,
        `el test debe pasar gracias a ensureGitInPath. failed_tests=${JSON.stringify(r.summary.failed_tests)}`);
    assert.equal(r.summary.tests, 1);
    assert.equal(r.exit_code, 0);
});

// #3091 rebote rev-1 (réplica del test #3090 rev-1) — Regresión empírica.
// El tester corre `node --test` desde el worktree del agente cuando éste
// existe (introducido por #3081), pero los worktrees creados por
// `git worktree add` NO incluyen `node_modules/` (sólo `.git`). Tests
// que hacen `require('../pulpo.js')` (que a su vez requiere `js-yaml`)
// fallaban con `Cannot find module 'js-yaml'`. El fix agrega
// `<REPO_ROOT>/.pipeline/node_modules` y `<REPO_ROOT>/node_modules` al
// NODE_PATH del child cuando `repoRoot !== REPO_ROOT` (i.e. estamos
// corriendo desde un worktree).
test('#3091 rev-1 — runNodeTests propaga node_modules de REPO_ROOT al worktree vía NODE_PATH', async () => {
    // 1. Sembrar un módulo "fake-yaml" en REPO_ROOT/.pipeline/node_modules
    const fakeMod = path.join(TMP, '.pipeline', 'node_modules', 'fake-yaml-3091');
    fs.mkdirSync(fakeMod, { recursive: true });
    fs.writeFileSync(path.join(fakeMod, 'package.json'),
        JSON.stringify({ name: 'fake-yaml-3091', main: 'index.js', version: '1.0.0' }));
    fs.writeFileSync(path.join(fakeMod, 'index.js'),
        'module.exports = { tag: "from-repo-root-pipeline-node-modules" };');

    // 2. Crear un "worktree" en otra ubicación (sin node_modules locales) y
    //    poner ahí un test que requiera `fake-yaml-3091`.
    const fakeWorktree = fs.mkdtempSync(path.join(require('os').tmpdir(), 'v3-tester-3091-wt-'));
    fs.mkdirSync(path.join(fakeWorktree, '.pipeline', 'tests'), { recursive: true });
    fs.mkdirSync(path.join(fakeWorktree, '.pipeline', 'logs'), { recursive: true });
    const wtTestFile = path.join(fakeWorktree, '.pipeline', 'tests', 'needs-yaml.test.js');
    fs.writeFileSync(wtTestFile, `
const test = require('node:test');
const assert = require('node:assert/strict');
test('puede resolver fake-yaml-3091 vía NODE_PATH heredado', () => {
    const m = require('fake-yaml-3091');
    assert.equal(m.tag, 'from-repo-root-pipeline-node-modules');
});
`);

    // 3. Pre-condición: sin el fix, el worktree no resuelve el módulo.
    //    (Probamos con NODE_PATH vacío para asegurar que el módulo no es
    //    visible por algún path heredado del runner.)
    const env = { ...process.env };
    delete env.NODE_PATH;

    // 4. Correr runNodeTests pasando el worktree como repoRoot. El fix
    //    debe agregar <TMP>/.pipeline/node_modules a NODE_PATH del child.
    const r = await tester.runNodeTests(fakeWorktree, env);
    assert.equal(r.summary.failures, 0,
        `el test del worktree debería resolver fake-yaml-3091 vía NODE_PATH. failed_tests=${JSON.stringify(r.summary.failed_tests)}`);
    assert.equal(r.summary.tests, 1);
    assert.equal(r.exit_code, 0);
});

test('#3091 rev-1 — runNodeTests NO toca NODE_PATH cuando repoRoot === REPO_ROOT', async () => {
    // Cuando el tester corre desde main (verificacion sin worktree),
    // repoRoot === REPO_ROOT y la resolución normal de Node ya encuentra
    // los módulos del .pipeline/node_modules vía lookup. No queremos
    // mutar NODE_PATH innecesariamente.
    const fresh = fs.mkdtempSync(path.join(require('os').tmpdir(), 'v3-tester-same-root-3091-'));
    fs.mkdirSync(path.join(fresh, '.pipeline', 'tests'), { recursive: true });
    fs.mkdirSync(path.join(fresh, '.pipeline', 'logs'), { recursive: true });
    const testFile = path.join(fresh, '.pipeline', 'tests', 'echo-nodepath.test.js');
    fs.writeFileSync(testFile, `
const test = require('node:test');
const assert = require('node:assert/strict');
test('NODE_PATH del child no fue mutado por el runner', () => {
    // Con repoRoot === REPO_ROOT, el wrapper no debe forzar NODE_PATH.
    // Permitimos que sea exactamente lo que el padre pasó (vacío/undefined).
    const np = process.env.NODE_PATH;
    assert.ok(np === undefined || np === '',
        'NODE_PATH debería estar sin tocar cuando repoRoot === REPO_ROOT, era=' + JSON.stringify(np));
});
`);
    // Forzar PIPELINE_REPO_ROOT al fresh para que tester lea REPO_ROOT === fresh,
    // y luego pasar fresh como repoRoot del run.
    const envChild = { ...process.env };
    delete envChild.NODE_PATH;
    // Necesitamos que el módulo tester ya cargado siga viendo TMP como REPO_ROOT
    // (no podemos remockear sin romper otros tests). Por eso comprobamos el
    // path "==" lógicamente: el tester compara path.resolve(repoRoot) vs
    // path.resolve(REPO_ROOT). Pasamos REPO_ROOT (que es TMP) como repoRoot
    // del run; al ser iguales, el fix NO debe tocar NODE_PATH.
    fs.mkdirSync(path.join(TMP, '.pipeline', 'tests'), { recursive: true });
    const tmpTestFile = path.join(TMP, '.pipeline', 'tests', '__same-root-nodepath-3091.test.js');
    fs.writeFileSync(tmpTestFile, fs.readFileSync(testFile, 'utf8'));
    try {
        const r = await tester.runNodeTests(TMP, envChild);
        // Nota: este test puede correr junto a otros tests de runNodeTests
        // que también escriben en TMP/.pipeline/tests. findNodeTestFiles
        // recoge todos. Solo verificamos que el nuestro pasó.
        const ourFailed = (r.summary.failed_tests || [])
            .find((ft) => String(ft.classname || '').includes('__same-root-nodepath-3091'));
        assert.equal(ourFailed, undefined,
            `NODE_PATH no debería ser mutado cuando repoRoot===REPO_ROOT. failed=${JSON.stringify(ourFailed)}`);
    } finally {
        try { fs.unlinkSync(tmpTestFile); } catch {}
    }
});

// ── ensureGitInPath (rebote #2891 rev-2) ─────────────────────────────
// Cuando el pulpo corre como service Windows, el PATH del child puede no
// incluir Git. Los tests del pipeline que hacen `spawnSync('git', ...)`
// fallan con `'git' no se reconoce`. ensureGitInPath debe garantizar que
// git sea ejecutable en el env devuelto.

test('ensureGitInPath — env con git en PATH lo deja inalterado', () => {
    // El env del runner ya tiene git (sino node --test no encontraría tampoco).
    const envBefore = { ...process.env };
    const pathBefore = envBefore.PATH;
    const result = tester.ensureGitInPath(envBefore);
    // Mismo objeto (mutable) y mismo PATH si git ya funciona.
    assert.equal(result, envBefore);
    assert.equal(result.PATH, pathBefore);
});

test('ensureGitInPath — sin git en PATH, prepende ubicación conocida (Windows)', () => {
    if (process.platform !== 'win32') {
        // En Linux/macOS las rutas de fallback son /usr/bin etc; el test
        // tiene sentido principalmente en Windows donde git suele NO estar
        // en system PATH para servicios.
        return;
    }
    // Construir un env "limpio": PATH sin Git, pero Git existe en el sistema.
    const cleanPath = (process.env.PATH || '')
        .split(';')
        .filter((seg) => !/[\\/]Git[\\/]/i.test(seg))
        .join(';');
    const env = { PATH: cleanPath };
    // Verificar pre-condición: git no debería ser visible.
    const { spawnSync } = require('child_process');
    const probeBefore = spawnSync('git', ['--version'], {
        env, shell: false, windowsHide: true, encoding: 'utf8',
    });
    if (probeBefore.status === 0) {
        // El sistema tiene git en una ubicación rara que sobrevive al filter;
        // skip silencioso para no fallar por entorno.
        return;
    }
    const result = tester.ensureGitInPath(env);
    // Debe haber agregado al menos un dir conocido al PATH.
    assert.ok(result.PATH.length > cleanPath.length, 'ensureGitInPath debe prepender al PATH');
    // Y git debe ser ejecutable ahora (si está instalado en una de las rutas conocidas).
    const probeAfter = spawnSync('git', ['--version'], {
        env: result, shell: false, windowsHide: true, encoding: 'utf8',
    });
    assert.equal(probeAfter.status, 0, 'git debe ser ejecutable después de ensureGitInPath');
});

// ── resolveGitDir (rebote #2892 rev-2) ──────────────────────────────
// Garantiza que el helper localice git.exe — vía `where`/`which` o caída
// a paths estándar de Git for Windows — para que el child node de
// `node --test` siempre tenga git accesible aunque el PATH heredado del
// pulpo lo haya perdido.

test('resolveGitDir — devuelve un directorio que contiene git.exe (o git en POSIX)', () => {
    const dir = tester.resolveGitDir();
    // En el entorno de CI/dev de Intrale git siempre está instalado;
    // si no se resuelve, el flow de tester pipeline-only se rompe y no
    // queremos enmascararlo con un test demasiado tolerante.
    assert.ok(dir, 'resolveGitDir debería localizar git en el entorno de tests');
    const gitBin = path.join(dir, process.platform === 'win32' ? 'git.exe' : 'git');
    assert.ok(fs.existsSync(gitBin), `${gitBin} debe existir`);
});

test('resolveGitDir — el directorio resuelto sirve para spawnear `git --version`', () => {
    const dir = tester.resolveGitDir();
    if (!dir) return; // ya cubierto por el test anterior; no duplicamos failure
    const env = { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH || ''}` };
    const r = require('child_process').spawnSync('git', ['--version'], {
        env, encoding: 'utf8', shell: false, windowsHide: true,
    });
    assert.equal(r.status, 0, `git --version debe correr OK (status=${r.status}, error=${r.error && r.error.message})`);
    assert.match(r.stdout, /git version/);
});

test('GIT_FALLBACK_DIRS_WIN32 — incluye Git for Windows estándar', () => {
    // Exporto la lista para auditoría. Si Git for Windows cambia de
    // ubicación canónica, este test forzará revisar la lista.
    assert.ok(Array.isArray(tester.GIT_FALLBACK_DIRS_WIN32));
    assert.ok(tester.GIT_FALLBACK_DIRS_WIN32.includes('C:\\Program Files\\Git\\cmd'));
    assert.ok(tester.GIT_FALLBACK_DIRS_WIN32.includes('C:\\Program Files\\Git\\mingw64\\bin'));
});

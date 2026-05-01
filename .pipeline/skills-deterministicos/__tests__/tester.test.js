// Tests unitarios de .pipeline/skills-deterministicos/tester.js (issue #2482)
// No lanzamos gradle real: validamos parseArgs, buildGradleCommand, heartbeat,
// updateMarker, copyArtifacts y renderReport con filesystem aislado.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

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
    assert.ok(c.args.includes(':app:composeApp:testDebugUnitTest'));
    assert.ok(c.args.includes(':backend:koverXmlReport'));
    assert.ok(c.args.includes(':app:composeApp:koverXmlReport'));
    assert.ok(c.args.includes('--no-daemon'));
    assert.deepEqual(c.modules, ['backend', 'users', 'app']);
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
        // Si git no está disponible (rare), el test no aplica
        if (/not found|no such/i.test(e.message)) return;
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

test('isPipelineOnlyChange — false con array vacío', () => {
    assert.equal(tester.isPipelineOnlyChange([]), false);
    assert.equal(tester.isPipelineOnlyChange(null), false);
    assert.equal(tester.isPipelineOnlyChange(undefined), false);
});

test('isPipelineOnlyChange — paths fuera de los patrones permitidos rompen el match', () => {
    // .claude/ NO está en pipeline-only (puede afectar build behavior)
    assert.equal(tester.isPipelineOnlyChange([
        '.pipeline/config.yaml',
        '.claude/settings.json',
    ]), false);
    // README.md en raíz no está
    assert.equal(tester.isPipelineOnlyChange(['README.md']), false);
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

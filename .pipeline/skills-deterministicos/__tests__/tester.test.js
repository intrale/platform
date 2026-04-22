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
    assert.equal(c.cmd, './gradlew');
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

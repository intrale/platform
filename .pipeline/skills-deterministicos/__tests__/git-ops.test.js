// Tests unitarios de .pipeline/skills-deterministicos/lib/git-ops.js (issue #2484)
// Validamos los builders puros (commit message + PR body) y heurísticas
// (inferCommitType, inferScope) sin tocar git ni gh.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ops = require('../lib/git-ops');

test('inferCommitType — agent/<n>-slug → feat', () => {
    assert.equal(ops.inferCommitType('agent/2484-delivery-deterministico'), 'feat');
});

test('inferCommitType — feature/x → feat', () => {
    assert.equal(ops.inferCommitType('feature/dark-mode'), 'feat');
});

test('inferCommitType — bugfix/x → fix', () => {
    assert.equal(ops.inferCommitType('bugfix/login-loop'), 'fix');
});

test('inferCommitType — docs/x → docs', () => {
    assert.equal(ops.inferCommitType('docs/runbook-pipeline'), 'docs');
});

test('inferCommitType — refactor/x → refactor', () => {
    assert.equal(ops.inferCommitType('refactor/user-service'), 'refactor');
});

test('inferCommitType — desconocido → chore', () => {
    assert.equal(ops.inferCommitType('cualquiera/raro'), 'chore');
});

test('inferScope — mayoría .pipeline → "pipeline"', () => {
    const files = [
        { path: '.pipeline/skills-deterministicos/delivery.js' },
        { path: '.pipeline/skills-deterministicos/lib/git-ops.js' },
        { path: 'docs/cambio.md' },
    ];
    assert.equal(ops.inferScope(files), 'pipeline');
});

test('inferScope — mayoría backend → "backend"', () => {
    const files = [
        { path: 'backend/src/main/kotlin/Foo.kt' },
        { path: 'backend/src/test/kotlin/FooTest.kt' },
        { path: 'docs/x.md' },
    ];
    assert.equal(ops.inferScope(files), 'backend');
});

test('inferScope — sin archivos → fallback', () => {
    assert.equal(ops.inferScope([], 'general'), 'general');
});

test('inferScope — directorio desconocido se devuelve tal cual', () => {
    const files = [{ path: 'random-dir/algo.txt' }];
    assert.equal(ops.inferScope(files), 'random-dir');
});

test('buildCommitMessage — incluye type(scope) + Closes #N', () => {
    const msg = ops.buildCommitMessage({
        issue: 2484,
        title: 'V3 delivery determinístico',
        body: 'Implementa delivery sin tokens.',
        branch: 'agent/2484-delivery-deterministico',
        files: [{ path: '.pipeline/skills-deterministicos/delivery.js' }],
    });
    assert.match(msg, /^feat\(pipeline\): V3 delivery determinístico/);
    assert.match(msg, /Implementa delivery sin tokens\./);
    assert.match(msg, /Closes #2484/);
});

test('buildCommitMessage — sin body sigue cerrando issue', () => {
    const msg = ops.buildCommitMessage({
        issue: 100,
        title: 'arreglar login',
        branch: 'bugfix/login',
        files: [{ path: 'app/composeApp/src/Main.kt' }],
    });
    assert.match(msg, /^fix\(app\): arreglar login/);
    assert.match(msg, /Closes #100/);
});

test('buildCommitMessage — quita prefijos [Tipo] del título', () => {
    const msg = ops.buildCommitMessage({
        issue: 50,
        title: '[Bug] fallback se rompe',
        branch: 'bugfix/fallback',
        files: [{ path: 'app/x.kt' }],
    });
    assert.match(msg, /^fix\(app\): fallback se rompe/);
});

test('buildPRBody — incluye Resumen, Plan de pruebas y Closes', () => {
    const body = ops.buildPRBody({
        issue: 2484,
        title: 'algo',
        summaryBullets: ['cambio uno', 'cambio dos'],
        testPlan: ['tests verdes', 'gates pasan'],
        qaLabel: 'qa:skipped',
    });
    assert.match(body, /## Resumen/);
    assert.match(body, /- cambio uno/);
    assert.match(body, /- cambio dos/);
    assert.match(body, /## Plan de pruebas/);
    assert.match(body, /- \[x\] tests verdes/);
    assert.match(body, /Closes #2484/);
});

test('buildPRBody — defaults razonables si faltan bullets/testPlan', () => {
    const body = ops.buildPRBody({ issue: 7, qaLabel: 'qa:passed' });
    assert.match(body, /pipeline V3/i);
    assert.match(body, /qa:passed/);
    assert.match(body, /Closes #7/);
});

test('runCmd — comando inexistente devuelve exit_code != 0 sin tirar', () => {
    const r = ops.runCmd('comando-que-no-existe-12345', [], { timeoutMs: 3000 });
    assert.notEqual(r.exit_code, 0);
    assert.equal(typeof r.wall_ms, 'number');
});

// =============================================================================
// canonical-entregable-squash-4074.test.js — Regresión del falso negativo
// `⚠️ s/main` por squash-merge + rama borrada (#4074).
//
// Caso real: PRs squash-mergeados cuya rama agent/<n>-* fue borrada tras el
// merge (flujo normal: squash + delete branch). El claim entregable_en_main
// resolvía `false` porque `git branch --merged --list *agent/<n>-*` no
// matcheaba ninguna rama → el cuadro de la ola mostraba `s/main` para
// entregables que SÍ estaban en main (#4052, #4051, #4039).
//
// El fix corrobora con señales alternativas (issue cerrado + PR mergeado atado
// por headRefName + commit squash en origin/main) y NUNCA introduce falsos
// positivos: ante la duda → not_verifiable, jamás `true` espurio.
//
// Fakes puros de gitImpl/ghApi — CERO red/FS/shell.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveClaim } = require('../canonical-facts');

// -----------------------------------------------------------------------------
// Helper: arma impls (gitImpl/ghApi) declarativos a partir de un estado.
//   merged   — stdout de `git branch --merged origin/main --list *agent/<n>-*`
//   anyBranch— stdout de `git branch --all --list *agent/<n>-*`
//   logMatch — true si `git log origin/main --grep (#<pr>)` encuentra el commit
//   issue    — objeto { state, closed } o null (gh issue view falla)
//   prs      — array para `gh pr list` o null (gh pr list falla)
// -----------------------------------------------------------------------------
function mkImpls({ merged = '\n', anyBranch = '\n', logMatch = '', issue, prs }) {
    const gitImpl = ({ args }) => {
        if (args.includes('--merged')) {
            return Promise.resolve({ ok: true, stdout: merged });
        }
        if (args[0] === 'log') {
            return Promise.resolve({ ok: true, stdout: logMatch });
        }
        // `branch --all --list *agent/<n>-*`
        return Promise.resolve({ ok: true, stdout: anyBranch });
    };
    const ghApi = ({ args }) => {
        if (args[0] === 'issue') {
            if (issue === null) return Promise.resolve({ ok: false, stdout: '' });
            return Promise.resolve({ ok: true, stdout: JSON.stringify(issue) });
        }
        if (args[0] === 'pr') {
            if (prs === null) return Promise.resolve({ ok: false, stdout: '' });
            return Promise.resolve({ ok: true, stdout: JSON.stringify(prs) });
        }
        return Promise.resolve({ ok: false, stdout: '' });
    };
    return { gitImpl, ghApi };
}

// -----------------------------------------------------------------------------
// CA-1 — Issue cerrado, PR squash-mergeado, rama borrada → entregable_en_main = true.
// -----------------------------------------------------------------------------
test('CA-1: squash-merge + rama borrada (issue cerrado, PR mergeado, commit en main) → true', async () => {
    const impls = mkImpls({
        merged: '\n',            // sin rama mergeada (fue borrada)
        anyBranch: '\n',         // tampoco existe la rama (borrada)
        issue: { state: 'CLOSED', closed: true },
        prs: [{ number: 4063, mergedAt: '2026-06-10T12:00:00Z', headRefName: 'agent/4052-fix' }],
        logMatch: 'edd4727fdd1ac9a568427cb7b7d8fab1474093e8\n', // (#4063) en origin/main
    });
    const r = await resolveClaim('entregable_en_main', { issue: 4052, expected: true }, impls);
    assert.equal(r.value, true, 'corrobora vía issue cerrado + PR mergeado + commit squash en main');
    assert.equal(r.status, 'consistent');
    assert.equal(r.source, 'git');
});

// -----------------------------------------------------------------------------
// CA-2 — Issue sin merge real (sin rama, sin PR mergeado) → NUNCA true espurio.
// -----------------------------------------------------------------------------
test('CA-2: issue sin merge real (sin rama, sin PR mergeado) → not_verifiable, jamás true', async () => {
    const impls = mkImpls({
        merged: '\n',
        anyBranch: '\n',
        issue: { state: 'CLOSED', closed: true },
        prs: [], // ningún PR
    });
    const r = await resolveClaim('entregable_en_main', { issue: 8888, expected: true }, impls);
    assert.notEqual(r.value, true, 'jamás true espurio');
    assert.equal(r.status, 'not_verifiable');
});

test('CA-2b: PR mergeado NO atado a este issue (headRefName de otro) → not_verifiable', async () => {
    const impls = mkImpls({
        merged: '\n',
        anyBranch: '\n',
        issue: { state: 'CLOSED', closed: true },
        // PR mergeado pero su rama pertenece a OTRO issue → no ata a 8888.
        prs: [{ number: 7777, mergedAt: '2026-06-10T12:00:00Z', headRefName: 'agent/9999-otra' }],
        logMatch: 'deadbeef\n',
    });
    const r = await resolveClaim('entregable_en_main', { issue: 8888, expected: true }, impls);
    assert.notEqual(r.value, true);
    assert.equal(r.status, 'not_verifiable');
});

test('CA-2c: PR mergeado atado pero commit squash NO está en origin/main → not_verifiable (anti-FP)', async () => {
    const impls = mkImpls({
        merged: '\n',
        anyBranch: '\n',
        issue: { state: 'CLOSED', closed: true },
        prs: [{ number: 4063, mergedAt: '2026-06-10T12:00:00Z', headRefName: 'agent/4052-fix' }],
        logMatch: '', // el commit (#4063) NO aparece en origin/main
    });
    const r = await resolveClaim('entregable_en_main', { issue: 4052, expected: true }, impls);
    assert.notEqual(r.value, true);
    assert.equal(r.status, 'not_verifiable');
});

// -----------------------------------------------------------------------------
// CA-3 — Rama mergeada presente: positivo fuerte directo (no toca GitHub).
// -----------------------------------------------------------------------------
test('CA-3: rama agent/<n>-* mergeada a origin/main → true sin consultar GitHub', async () => {
    let ghCalled = false;
    const impls = {
        gitImpl: ({ args }) => {
            if (args.includes('--merged')) {
                return Promise.resolve({ ok: true, stdout: '  remotes/origin/agent/4039-x\n' });
            }
            return Promise.resolve({ ok: true, stdout: '\n' });
        },
        ghApi: () => { ghCalled = true; return Promise.resolve({ ok: true, stdout: '[]' }); },
    };
    const r = await resolveClaim('entregable_en_main', { issue: 4039, expected: true }, impls);
    assert.equal(r.value, true);
    assert.equal(r.status, 'consistent');
    assert.equal(ghCalled, false, 'el positivo por rama mergeada no necesita GitHub');
});

// -----------------------------------------------------------------------------
// CA-4 — Rama existe pero NO mergeada → false legítimo (negativo real).
// -----------------------------------------------------------------------------
test('CA-4: rama agent/<n>-* existe pero NO mergeada → false (negativo real)', async () => {
    const impls = mkImpls({
        merged: '\n',                                   // no mergeada
        anyBranch: '  remotes/origin/agent/5555-wip\n',  // pero existe
        issue: { state: 'OPEN', closed: false },
        prs: [],
    });
    const r = await resolveClaim('entregable_en_main', { issue: 5555, expected: true }, impls);
    assert.equal(r.value, false);
    assert.equal(r.status, 'inconsistent');
});

// -----------------------------------------------------------------------------
// CA-5 — Issue abierto, sin rama → not_verifiable (no afirmar false espurio).
// -----------------------------------------------------------------------------
test('CA-5: issue abierto y sin rama → not_verifiable (no false espurio)', async () => {
    const impls = mkImpls({
        merged: '\n',
        anyBranch: '\n',
        issue: { state: 'OPEN', closed: false },
        prs: [],
    });
    const r = await resolveClaim('entregable_en_main', { issue: 6666, expected: true }, impls);
    assert.equal(r.status, 'not_verifiable');
    assert.notEqual(r.value, false);
});

// -----------------------------------------------------------------------------
// CA-6 — git caído (rate limit / herramienta ausente) → not_verifiable, fail-open.
// -----------------------------------------------------------------------------
test('CA-6: git no ejecutable → not_verifiable (fail-open, sin contradicción)', async () => {
    const impls = {
        gitImpl: () => Promise.resolve({ ok: false, stdout: '', stderr: 'fatal' }),
        ghApi: () => Promise.resolve({ ok: true, stdout: '[]' }),
    };
    const r = await resolveClaim('entregable_en_main', { issue: 4052, expected: true }, impls);
    assert.equal(r.status, 'not_verifiable');
});

test('CA-6b: gh caído tras descartar rama → not_verifiable', async () => {
    const impls = mkImpls({
        merged: '\n',
        anyBranch: '\n',
        issue: null,   // gh issue view falla
        prs: null,
    });
    const r = await resolveClaim('entregable_en_main', { issue: 4052, expected: true }, impls);
    assert.equal(r.status, 'not_verifiable');
});

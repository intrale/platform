// Tests del flow "allowlist" del wizard del Dashboard V3 (#3742).
//
// El contrato real de #3724 es {maxStep, validateStep, executeStep}; la base
// (wizard-session.js) resuelve CSRF, rate-limit, idempotencia, timeout y token
// de step. Estos tests cubren la lógica del FLOW (validación server-side,
// recursividad, TOCTOU y audit-then-apply). CSRF / rate-limit / step_token los
// cubre la suite de #3724.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const flow = require('../index');

function fakeSession() {
    return { flow: 'allowlist', createdAt: Date.now(), lastAccessAt: Date.now(), steps: new Map() };
}
function setStep(session, step, result) {
    session.steps.set(step, { status: 'ok', result });
}

// --------------------------------------------------------------------------
// validateStep — paso 0 (acción + issue_id)
// --------------------------------------------------------------------------

test('paso0 rechaza action distinta de add/remove', () => {
    assert.equal(flow.validateStep(0, { action: 'borrar', issue_id: 5 }), false);
});

test('paso0 rechaza issue_id no entero positivo (path-like / negativo / 0 / float)', () => {
    assert.equal(flow.validateStep(0, { action: 'add', issue_id: '../../etc/passwd' }), false);
    assert.equal(flow.validateStep(0, { action: 'add', issue_id: -3 }), false);
    assert.equal(flow.validateStep(0, { action: 'add', issue_id: 0 }), false);
    assert.equal(flow.validateStep(0, { action: 'add', issue_id: 2.5 }), false);
    assert.equal(flow.validateStep(0, { action: 'add', issue_id: 'abc' }), false);
});

test('paso0 acepta add/remove con issue_id entero positivo (number o string de dígitos)', () => {
    assert.equal(flow.validateStep(0, { action: 'add', issue_id: 1732 }), true);
    assert.equal(flow.validateStep(0, { action: 'remove', issue_id: '1732' }), true);
});

// --------------------------------------------------------------------------
// validateStep — paso 2 (motivo)
// --------------------------------------------------------------------------

test('paso2 rechaza motivo de menos de 10 chars', () => {
    assert.equal(flow.validateStep(2, { motivo: 'corto' }), false);
});

test('paso2 rechaza motivo con byte NUL', () => {
    assert.equal(flow.validateStep(2, { motivo: 'motivo largo y valido\x00inyectado' }), false);
});

test('paso2 rechaza motivo de mas de 500 chars', () => {
    assert.equal(flow.validateStep(2, { motivo: 'a'.repeat(501) }), false);
});

test('paso2 acepta motivo valido', () => {
    assert.equal(flow.validateStep(2, { motivo: 'destrabe del issue para la release del jueves' }), true);
});

// --------------------------------------------------------------------------
// validateStep — paso 3 (doble check + TOCTOU)
// --------------------------------------------------------------------------

test('paso3 rechaza sin doble confirmacion', () => {
    flow._setForTests({ partialPause: { readPreviousAllowlist: () => [1, 2] } });
    assert.equal(flow.validateStep(3, { confirm1: true, confirm2: false, previous_snapshot: [1, 2] }), false);
    assert.equal(flow.validateStep(3, { confirm1: false, confirm2: true, previous_snapshot: [1, 2] }), false);
    flow._resetForTests();
});

test('paso3 devuelve false (409 state_changed) cuando el snapshot del cliente difiere del estado en disco', () => {
    flow._setForTests({ partialPause: { readPreviousAllowlist: () => [1, 2, 3] } });
    assert.equal(flow.validateStep(3, { confirm1: true, confirm2: true, previous_snapshot: [1, 2] }), false);
    flow._resetForTests();
});

test('paso3 acepta cuando snapshot coincide (orden-independiente) y hay doble check', () => {
    flow._setForTests({ partialPause: { readPreviousAllowlist: () => [1, 2] } });
    assert.equal(flow.validateStep(3, { confirm1: true, confirm2: true, previous_snapshot: [2, 1] }), true);
    flow._resetForTests();
});

// --------------------------------------------------------------------------
// executeStep — paso 1 (recursividad)
// --------------------------------------------------------------------------

test('add con padre recursivo incluye hijos transitivamente en issues', async () => {
    flow._setForTests({
        deps: { resolveOpenDeps: () => ({ openDeps: [200, 201], chains: {}, truncated: false, reason: null, nodesVisited: 3 }) },
    });
    const s = fakeSession();
    setStep(s, 0, { action: 'add', issueId: 100 });
    const r = await flow.executeStep(s, 1, {});
    assert.deepEqual(r.issues, [100, 200, 201]);
    assert.equal(r.truncated, false);
    flow._resetForTests();
});

test('add con grafo ciclico no cuelga y devuelve truncated:true (reason cycle)', async () => {
    flow._setForTests({
        deps: { resolveOpenDeps: () => ({ openDeps: [201], chains: {}, truncated: true, reason: 'cycle', nodesVisited: 2 }) },
    });
    const s = fakeSession();
    setStep(s, 0, { action: 'add', issueId: 200 });
    const r = await flow.executeStep(s, 1, {});
    assert.equal(r.truncated, true);
    assert.equal(r.reason, 'cycle');
    flow._resetForTests();
});

test('add con grafo grande respeta el cap y marca truncated (reason max_nodes)', async () => {
    flow._setForTests({
        deps: { resolveOpenDeps: (id, opts) => {
            // El flow pasa maxNodes=200 por default.
            assert.equal(opts.maxNodes, flow.DEPS_MAX_NODES);
            assert.equal(opts.maxDepth, flow.DEPS_MAX_DEPTH);
            return { openDeps: [301, 302], chains: {}, truncated: true, reason: 'max_nodes', nodesVisited: 200 };
        } },
    });
    const s = fakeSession();
    setStep(s, 0, { action: 'add', issueId: 300 });
    const r = await flow.executeStep(s, 1, {});
    assert.equal(r.truncated, true);
    assert.equal(r.reason, 'max_nodes');
    flow._resetForTests();
});

test('remove NO aplica recursividad (solo el issue puntual)', async () => {
    let called = false;
    flow._setForTests({
        deps: { resolveOpenDeps: () => { called = true; return { openDeps: [999] }; } },
    });
    const s = fakeSession();
    setStep(s, 0, { action: 'remove', issueId: 100 });
    const r = await flow.executeStep(s, 1, {});
    assert.deepEqual(r.issues, [100]);
    assert.equal(called, false, 'resolveOpenDeps NO debe invocarse en remove');
    flow._resetForTests();
});

// --------------------------------------------------------------------------
// executeStep — preconditions
// --------------------------------------------------------------------------

test('executeStep lanza si el cliente salta pasos previos (precondition)', async () => {
    const s = fakeSession();
    await assert.rejects(() => flow.executeStep(s, 1, {}), /precondition/);
    await assert.rejects(() => flow.executeStep(s, 3, {}), /precondition/);
});

// --------------------------------------------------------------------------
// executeStep — paso 3 (audit-then-apply, módulos REALES sobre tmp dir)
// --------------------------------------------------------------------------

test('confirm: audit-then-apply produce UNA entry NDJSON rica y aplica el estado', async () => {
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wiz-allow-'));
    fs.mkdirSync(path.join(TMP, 'audit'), { recursive: true });
    const prevEnv = process.env.PIPELINE_DIR_OVERRIDE;
    process.env.PIPELINE_DIR_OVERRIDE = TMP;
    flow._resetForTests();
    // Sólo stub del grafo de deps; partialPause + audit son reales (escriben en TMP).
    flow._setForTests({
        deps: { resolveOpenDeps: () => ({ openDeps: [201], chains: {}, truncated: false, reason: null, nodesVisited: 2 }) },
    });
    try {
        const s = fakeSession();
        setStep(s, 0, { action: 'add', issueId: 200 });
        setStep(s, 1, { action: 'add', issueId: 200, issues: [200, 201], truncated: false, reason: null });
        setStep(s, 2, { motivo: 'destrabe del issue 200 para la release', previous_snapshot: [], next_proposed: [200, 201], diff: { added: [200, 201], removed: [] } });

        const r = await flow.executeStep(s, 3, { confirm1: true, confirm2: true, previous_snapshot: [] });
        assert.equal(r.ok, true);
        assert.deepEqual(r.applied, [200, 201]);

        // Audit NDJSON: la última entry (descartando el backfill) es la nuestra.
        const auditFile = path.join(TMP, 'audit', 'partial-pause-mutations.jsonl');
        const lines = fs.readFileSync(auditFile, 'utf8').split('\n').filter(Boolean);
        const last = JSON.parse(lines[lines.length - 1]);
        assert.equal(last.source, 'dashboard:wizard:allowlist');
        assert.equal(last.authorized_by, 'commander:leo');
        assert.ok(last.justification.includes('destrabe'));
        assert.deepEqual(last.diff.added, [200, 201]);
        assert.deepEqual(last.diff.removed, []);
        assert.equal(last.recursividad_aplicada, true);
        assert.equal(last.wizard_flow, 'allowlist');
        assert.ok(Number.isInteger(last.pid), 'pid agregado nativamente por appendMutation');

        // Estado aplicado en .partial-pause.json.
        const state = JSON.parse(fs.readFileSync(path.join(TMP, '.partial-pause.json'), 'utf8'));
        assert.deepEqual(state.allowed_issues, [200, 201]);

        // Exactamente UNA entry de nuestro source (no doble-audit).
        const mine = lines.map((l) => JSON.parse(l)).filter((e) => e.source === 'dashboard:wizard:allowlist');
        assert.equal(mine.length, 1, 'debe haber UNA sola entry del wizard (sin doble-audit)');
    } finally {
        if (prevEnv === undefined) delete process.env.PIPELINE_DIR_OVERRIDE;
        else process.env.PIPELINE_DIR_OVERRIDE = prevEnv;
        flow._resetForTests();
    }
});

test('confirm lanza (sin ok) cuando setPartialPause rechaza el apply; no devuelve exito silencioso', async () => {
    flow._setForTests({
        partialPause: {
            readPreviousAllowlist: () => [5],
            setPartialPause: () => ({ ok: false, rejected: true, msg: 'gate rechazó' }),
        },
        deps: { resolveOpenDeps: () => ({ openDeps: [] }) },
    });
    try {
        const s = fakeSession();
        setStep(s, 0, { action: 'remove', issueId: 5 });
        setStep(s, 1, { action: 'remove', issueId: 5, issues: [5], truncated: false, reason: null });
        setStep(s, 2, { motivo: 'remover el issue agregado por error', previous_snapshot: [5] });
        await assert.rejects(
            () => flow.executeStep(s, 3, { confirm1: true, confirm2: true, previous_snapshot: [5] }),
            /apply_rejected/,
        );
    } finally {
        flow._resetForTests();
    }
});

// --------------------------------------------------------------------------
// register — idempotente y seguro
// --------------------------------------------------------------------------

test('validateStep con step fuera de rango devuelve false', () => {
    assert.equal(flow.validateStep(99, {}), false);
    assert.equal(flow.validateStep(-1, {}), false);
});

test('executeStep con step fuera de rango lanza', async () => {
    const s = fakeSession();
    setStep(s, 0, { action: 'add', issueId: 1 });
    setStep(s, 1, { action: 'add', issueId: 1, issues: [1] });
    setStep(s, 2, { motivo: 'motivo valido de prueba', previous_snapshot: [] });
    await assert.rejects(() => flow.executeStep(s, 7, {}), /fuera de rango/);
});

test('computeNext: add une previous con issues; remove quita sin recursividad', () => {
    assert.deepEqual(flow.computeNext('add', 100, [100, 200, 201], [50]), [50, 100, 200, 201]);
    assert.deepEqual(flow.computeNext('remove', 50, [50], [50, 60]), [60]);
});

test('isPositiveInt cubre number/string/otros tipos', () => {
    assert.equal(flow.isPositiveInt(5), true);
    assert.equal(flow.isPositiveInt('5'), true);
    assert.equal(flow.isPositiveInt(0), false);
    assert.equal(flow.isPositiveInt(null), false);
    assert.equal(flow.isPositiveInt({}), false);
});

test('register en la base es idempotente (no rompe si el flow ya está registrado)', () => {
    const ws = require('../../../wizard-session');
    // Ya quedó registrado por el require del módulo; un segundo register → false, sin throw.
    assert.equal(flow.register(ws), false);
});

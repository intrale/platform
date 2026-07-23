// Tests del flow "pausa" del wizard del Dashboard V3 (#3741).
//
// El contrato real de #3724 es {maxStep, validateStep, executeStep}; la base
// (wizard-session.js) resuelve CSRF, rate-limit, idempotencia, timeout y token
// de step. Estos tests cubren la lógica del FLOW: validación server-side de
// combos acción×scope, doble confirmación de despausa, drift-check, deps
// recursivas, preservación de allowed_skills, audit-then-apply con
// `via: 'wizard-pausa'` y la pausa total gateada. CSRF / rate-limit / timeout
// los cubre la suite de #3724.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const flow = require('../index');

function fakeSession() {
    return { flow: 'pausa', createdAt: Date.now(), lastAccessAt: Date.now(), steps: new Map() };
}
function setStep(session, step, result) {
    session.steps.set(step, { status: 'ok', result });
}
function stubMode(mode, allowedIssues = [], allowedSkills = []) {
    return { getPipelineMode: () => ({ mode, allowedIssues, allowedSkills }) };
}

// ---------------------------------------------------------------------------
// validateStep — paso 0: combos acción × scope (CA-2)
// ---------------------------------------------------------------------------

test('paso0 rechaza action/scope fuera del enum', () => {
    flow._setForTests({ partialPause: stubMode('running') });
    assert.equal(flow.validateStep(0, { action: 'borrar', scope: 'issue', issue_id: 5 }), false);
    assert.equal(flow.validateStep(0, { action: 'pausar', scope: 'galaxia' }), false);
    flow._resetForTests();
});

test('paso0 pausar+issue exige issue_id entero positivo', () => {
    flow._setForTests({ partialPause: stubMode('running') });
    assert.equal(flow.validateStep(0, { action: 'pausar', scope: 'issue', issue_id: 1732 }), true);
    assert.equal(flow.validateStep(0, { action: 'pausar', scope: 'issue', issue_id: '../etc' }), false);
    assert.equal(flow.validateStep(0, { action: 'pausar', scope: 'issue', issue_id: 0 }), false);
    flow._resetForTests();
});

test('paso0 pausar+allowlist exige lista no vacía de enteros positivos', () => {
    flow._setForTests({ partialPause: stubMode('running') });
    assert.equal(flow.validateStep(0, { action: 'pausar', scope: 'allowlist', issues: [1, 2, 3] }), true);
    assert.equal(flow.validateStep(0, { action: 'pausar', scope: 'allowlist', issues: [] }), false);
    assert.equal(flow.validateStep(0, { action: 'pausar', scope: 'allowlist', issues: [1, -2] }), false);
    flow._resetForTests();
});

test('paso0 pausar+full válido sólo si NO estamos ya en pausa total', () => {
    flow._setForTests({ partialPause: stubMode('running') });
    assert.equal(flow.validateStep(0, { action: 'pausar', scope: 'full' }), true);
    flow._resetForTests();
    flow._setForTests({ partialPause: stubMode('paused') });
    assert.equal(flow.validateStep(0, { action: 'pausar', scope: 'full' }), false);
    flow._resetForTests();
});

test('paso0 despausar+full inválido sin pausa total activa (combo imposible CA-2)', () => {
    flow._setForTests({ partialPause: stubMode('running') });
    assert.equal(flow.validateStep(0, { action: 'despausar', scope: 'full' }), false);
    flow._resetForTests();
    flow._setForTests({ partialPause: stubMode('paused') });
    assert.equal(flow.validateStep(0, { action: 'despausar', scope: 'full' }), true);
    flow._resetForTests();
});

test('paso0 despausar+allowlist inválido sin pausa parcial activa', () => {
    flow._setForTests({ partialPause: stubMode('running') });
    assert.equal(flow.validateStep(0, { action: 'despausar', scope: 'allowlist' }), false);
    flow._resetForTests();
    flow._setForTests({ partialPause: stubMode('partial_pause', [10, 20]) });
    assert.equal(flow.validateStep(0, { action: 'despausar', scope: 'allowlist' }), true);
    flow._resetForTests();
});

test('paso0 despausar+issue exige que el issue esté en el allowlist parcial', () => {
    flow._setForTests({ partialPause: stubMode('partial_pause', [10, 20]) });
    assert.equal(flow.validateStep(0, { action: 'despausar', scope: 'issue', issue_id: 10 }), true);
    assert.equal(flow.validateStep(0, { action: 'despausar', scope: 'issue', issue_id: 99 }), false);
    flow._resetForTests();
});

// ---------------------------------------------------------------------------
// validateStep — paso 2 (motivo)
// ---------------------------------------------------------------------------

test('paso2 valida longitud del motivo y rechaza byte NUL', () => {
    assert.equal(flow.validateStep(2, { motivo: 'corto' }), false);
    assert.equal(flow.validateStep(2, { motivo: 'a'.repeat(501) }), false);
    assert.equal(flow.validateStep(2, { motivo: 'motivo valido\x00inyectado' }), false);
    assert.equal(flow.validateStep(2, { motivo: 'pausa por incidente en produccion' }), true);
});

// ---------------------------------------------------------------------------
// validateStep — paso 3 (doble confirmación + drift)
// ---------------------------------------------------------------------------

test('paso3 pausar requiere sólo confirm1 (1 check)', () => {
    flow._setForTests({ partialPause: stubMode('running') });
    const snap = { mode: 'running', allowed_issues: [] };
    assert.equal(flow.validateStep(3, { action: 'pausar', confirm1: true, previous_snapshot: snap }), true);
    assert.equal(flow.validateStep(3, { action: 'pausar', confirm1: false, previous_snapshot: snap }), false);
    flow._resetForTests();
});

test('paso3 despausar exige doble confirmación (CA-5)', () => {
    flow._setForTests({ partialPause: stubMode('partial_pause', [5]) });
    const snap = { mode: 'partial_pause', allowed_issues: [5] };
    assert.equal(flow.validateStep(3, { action: 'despausar', confirm1: true, confirm2: false, previous_snapshot: snap }), false);
    assert.equal(flow.validateStep(3, { action: 'despausar', confirm1: true, confirm2: true, previous_snapshot: snap }), true);
    flow._resetForTests();
});

test('paso3 drift-check: snapshot del cliente difiere del estado en disco → false (409)', () => {
    flow._setForTests({ partialPause: stubMode('partial_pause', [5, 6]) });
    // cliente vio [5], el disco tiene [5,6] → drift.
    assert.equal(flow.validateStep(3, { action: 'pausar', confirm1: true, previous_snapshot: { mode: 'partial_pause', allowed_issues: [5] } }), false);
    // snapshot coincidente (orden-independiente) → ok.
    assert.equal(flow.validateStep(3, { action: 'pausar', confirm1: true, previous_snapshot: { mode: 'partial_pause', allowed_issues: [6, 5] } }), true);
    flow._resetForTests();
});

// ---------------------------------------------------------------------------
// executeStep — paso 1 (deps recursivas y modo resultante)
// ---------------------------------------------------------------------------

test('paso1 pausar+issue arrastra deps recursivas y propone partial_pause', async () => {
    flow._setForTests({
        partialPause: stubMode('running'),
        deps: { resolveOpenDeps: () => ({ openDeps: [200, 201], chains: {}, truncated: false, reason: null, nodesVisited: 3 }) },
    });
    const s = fakeSession();
    setStep(s, 0, { action: 'pausar', scope: 'issue', issueId: 100 });
    const r = await flow.executeStep(s, 1, {});
    assert.deepEqual(r.affected, [100, 200, 201]);
    assert.deepEqual(r.next_allowlist, [100, 200, 201]);
    assert.equal(r.resulting_mode, 'partial_pause');
    flow._resetForTests();
});

test('paso1 pausar+full NO arrastra deps y propone paused', async () => {
    let called = false;
    flow._setForTests({
        partialPause: stubMode('running'),
        deps: { resolveOpenDeps: () => { called = true; return { openDeps: [9] }; } },
    });
    const s = fakeSession();
    setStep(s, 0, { action: 'pausar', scope: 'full' });
    const r = await flow.executeStep(s, 1, {});
    assert.equal(r.resulting_mode, 'paused');
    assert.equal(called, false, 'full pause no debe resolver deps');
    flow._resetForTests();
});

test('paso1 despausar+allowlist propone running (limpia la pausa parcial)', async () => {
    flow._setForTests({ partialPause: stubMode('partial_pause', [5, 6]) });
    const s = fakeSession();
    setStep(s, 0, { action: 'despausar', scope: 'allowlist' });
    const r = await flow.executeStep(s, 1, {});
    assert.deepEqual(r.next_allowlist, []);
    assert.equal(r.resulting_mode, 'running');
    flow._resetForTests();
});

test('paso1 grafo ciclico/grande no cuelga y marca truncated', async () => {
    flow._setForTests({
        partialPause: stubMode('running'),
        deps: { resolveOpenDeps: () => ({ openDeps: [201], chains: {}, truncated: true, reason: 'cycle', nodesVisited: 2 }) },
    });
    const s = fakeSession();
    setStep(s, 0, { action: 'pausar', scope: 'issue', issueId: 200 });
    const r = await flow.executeStep(s, 1, {});
    assert.equal(r.truncated, true);
    assert.equal(r.reason, 'cycle');
    flow._resetForTests();
});

// ---------------------------------------------------------------------------
// Helpers puros
// ---------------------------------------------------------------------------

test('modeForAllowlist: allowlist vacía + skills != bloqueo (feedback_partial-pause-empty-not-block / CA-12)', () => {
    assert.equal(flow.modeForAllowlist([], []), 'running');
    assert.equal(flow.modeForAllowlist([], ['backend-dev']), 'partial_pause');
    assert.equal(flow.modeForAllowlist([5], []), 'partial_pause');
});

test('computeNextAllowlist: pausar reemplaza, despausar issue quita uno, despausar allowlist limpia', () => {
    assert.deepEqual(flow.computeNextAllowlist({ action: 'pausar', scope: 'issue', issueId: 100 }, [100, 200], [50]), [100, 200]);
    assert.deepEqual(flow.computeNextAllowlist({ action: 'pausar', scope: 'full' }, [], [50, 60]), [50, 60]);
    assert.deepEqual(flow.computeNextAllowlist({ action: 'despausar', scope: 'issue', issueId: 50 }, [50], [50, 60]), [60]);
    assert.deepEqual(flow.computeNextAllowlist({ action: 'despausar', scope: 'allowlist' }, [], [50, 60]), []);
});

// ---------------------------------------------------------------------------
// executeStep — preconditions
// ---------------------------------------------------------------------------

test('executeStep lanza si el cliente salta pasos previos (precondition)', async () => {
    const s = fakeSession();
    await assert.rejects(() => flow.executeStep(s, 1, {}), /precondition/);
    await assert.rejects(() => flow.executeStep(s, 3, {}), /precondition/);
});

test('paso3 anti-downgrade: action del body distinta de la sesión → lanza', async () => {
    flow._setForTests({ partialPause: stubMode('partial_pause', [5]) });
    const s = fakeSession();
    setStep(s, 0, { action: 'despausar', scope: 'allowlist' });
    setStep(s, 1, { action: 'despausar', scope: 'allowlist', affected: [], openDeps: [], next_allowlist: [], resulting_mode: 'running' });
    setStep(s, 2, { motivo: 'reanudar el pipeline tras incidente', previous_snapshot: { mode: 'partial_pause', allowed_issues: [5] }, diff: { added: [], removed: [5] } });
    await assert.rejects(
        () => flow.executeStep(s, 3, { action: 'pausar', confirm1: true, confirm2: true }),
        /action mismatch/,
    );
    flow._resetForTests();
});

test('paso3 despausar sin confirm2 lanza (doble confirmación server-side)', async () => {
    flow._setForTests({ partialPause: stubMode('partial_pause', [5]) });
    const s = fakeSession();
    setStep(s, 0, { action: 'despausar', scope: 'allowlist' });
    setStep(s, 1, { action: 'despausar', scope: 'allowlist', affected: [], openDeps: [], next_allowlist: [], resulting_mode: 'running' });
    setStep(s, 2, { motivo: 'reanudar el pipeline tras incidente', previous_snapshot: { mode: 'partial_pause', allowed_issues: [5] }, diff: { added: [], removed: [5] } });
    await assert.rejects(
        () => flow.executeStep(s, 3, { action: 'despausar', confirm1: true, confirm2: false }),
        /doble confirmación/,
    );
    flow._resetForTests();
});

// ---------------------------------------------------------------------------
// executeStep — paso 3 (audit-then-apply, módulos REALES sobre tmp dir)
// ---------------------------------------------------------------------------

function withTmpPipeline(fn) {
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wiz-pausa-'));
    fs.mkdirSync(path.join(TMP, 'audit'), { recursive: true });
    const prevEnv = process.env.PIPELINE_DIR_OVERRIDE;
    process.env.PIPELINE_DIR_OVERRIDE = TMP;
    flow._resetForTests();
    try {
        return fn(TMP);
    } finally {
        if (prevEnv === undefined) delete process.env.PIPELINE_DIR_OVERRIDE;
        else process.env.PIPELINE_DIR_OVERRIDE = prevEnv;
        flow._resetForTests();
    }
}

function readAuditLines(TMP) {
    const auditFile = path.join(TMP, 'audit', 'partial-pause-mutations.jsonl');
    return fs.readFileSync(auditFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('pausar+allowlist: aplica partial_pause, preserva allowed_skills (CA-14) y audita con via wizard-pausa (CA-11)', async () => {
    await withTmpPipeline(async (TMP) => {
        const pp = require('../../../partial-pause');
        // Pre-set: allowlist con allowed_skills que el wizard NO debe pisar.
        pp.setPartialPause([99], { source: 'dashboard:wizard:pausa', authorizedBy: 'commander:leo', justification: 'seed inicial del test de regresion', allowedSkills: ['backend-dev'] });
        flow._setForTests({
            deps: { resolveOpenDeps: () => ({ openDeps: [201], chains: {}, truncated: false, reason: null, nodesVisited: 2 }) },
        });

        const s = fakeSession();
        setStep(s, 0, { action: 'pausar', scope: 'issue', issueId: 200 });
        setStep(s, 1, { action: 'pausar', scope: 'issue', affected: [200, 201], openDeps: [201], next_allowlist: [200, 201], resulting_mode: 'partial_pause' });
        setStep(s, 2, { motivo: 'pausar todo excepto el 200 para la release', previous_snapshot: { mode: 'partial_pause', allowed_issues: [99] }, diff: { added: [200, 201], removed: [99] } });

        const r = await flow.executeStep(s, 3, { action: 'pausar', confirm1: true });
        assert.equal(r.ok, true);
        assert.deepEqual(r.applied, [200, 201]);

        // Estado aplicado + allowed_skills preservado.
        const state = JSON.parse(fs.readFileSync(path.join(TMP, '.partial-pause.json'), 'utf8'));
        assert.deepEqual(state.allowed_issues, [200, 201]);
        assert.deepEqual(state.allowed_skills, ['backend-dev'], 'allowed_skills debe sobrevivir (CA-14)');

        // Audit: la entry del wizard lleva via: 'wizard-pausa'.
        const lines = readAuditLines(TMP);
        const mine = lines.filter((e) => e.via === 'wizard-pausa');
        assert.ok(mine.length >= 1, 'debe existir al menos una entry con via wizard-pausa');
        const last = mine[mine.length - 1];
        assert.equal(last.source, 'dashboard:wizard:pausa');
        assert.equal(last.authorized_by, 'commander:leo');
        assert.equal(last.wizard_flow, 'pausa');
        assert.equal(last.scope, 'issue');
        assert.equal(last.recursividad_aplicada, true);
        assert.ok(Number.isInteger(last.pid));
    });
});

test('pausar+full: setFullPause crea .paused y audita full_pause + via', async () => {
    await withTmpPipeline(async (TMP) => {
        flow._resetForTests();
        const s = fakeSession();
        setStep(s, 0, { action: 'pausar', scope: 'full' });
        setStep(s, 1, { action: 'pausar', scope: 'full', affected: [], openDeps: [], next_allowlist: [], resulting_mode: 'paused' });
        setStep(s, 2, { motivo: 'halt total por incidente de infraestructura', previous_snapshot: { mode: 'running', allowed_issues: [] }, diff: { added: [], removed: [] } });

        const r = await flow.executeStep(s, 3, { action: 'pausar', confirm1: true });
        assert.equal(r.ok, true);
        assert.equal(r.resulting_mode, 'paused');
        assert.ok(fs.existsSync(path.join(TMP, '.paused')), '.paused debe existir');

        const lines = readAuditLines(TMP);
        const mine = lines.filter((e) => e.via === 'wizard-pausa');
        assert.ok(mine.length >= 1);
        assert.equal(mine[mine.length - 1].full_pause, true);
    });
});

test('despausar+full: clearFullPause elimina .paused', async () => {
    await withTmpPipeline(async (TMP) => {
        const pp = require('../../../partial-pause');
        pp.setFullPause({ source: 'dashboard:wizard:pausa', authorizedBy: 'commander:leo', justification: 'seed de pausa total del test' });
        assert.ok(fs.existsSync(path.join(TMP, '.paused')));
        flow._resetForTests();

        const s = fakeSession();
        setStep(s, 0, { action: 'despausar', scope: 'full' });
        setStep(s, 1, { action: 'despausar', scope: 'full', affected: [], openDeps: [], next_allowlist: [], resulting_mode: 'running' });
        setStep(s, 2, { motivo: 'reanudar el pipeline tras resolver el incidente', previous_snapshot: { mode: 'paused', allowed_issues: [] }, diff: { added: [], removed: [] } });

        const r = await flow.executeStep(s, 3, { action: 'despausar', confirm1: true, confirm2: true });
        assert.equal(r.ok, true);
        assert.ok(!fs.existsSync(path.join(TMP, '.paused')), '.paused debe haberse eliminado');
    });
});

test('despausar+allowlist: clearPartialPause elimina el marker parcial', async () => {
    await withTmpPipeline(async (TMP) => {
        const pp = require('../../../partial-pause');
        pp.setPartialPause([5, 6], { source: 'dashboard:wizard:pausa', authorizedBy: 'commander:leo', justification: 'seed de pausa parcial del test' });
        assert.ok(fs.existsSync(path.join(TMP, '.partial-pause.json')));
        flow._resetForTests();

        const s = fakeSession();
        setStep(s, 0, { action: 'despausar', scope: 'allowlist' });
        setStep(s, 1, { action: 'despausar', scope: 'allowlist', affected: [], openDeps: [], next_allowlist: [], resulting_mode: 'running' });
        setStep(s, 2, { motivo: 'reanudar todos los issues tras la release', previous_snapshot: { mode: 'partial_pause', allowed_issues: [5, 6] }, diff: { added: [], removed: [5, 6] } });

        const r = await flow.executeStep(s, 3, { action: 'despausar', confirm1: true, confirm2: true });
        assert.equal(r.ok, true);
        assert.ok(!fs.existsSync(path.join(TMP, '.partial-pause.json')), 'el marker parcial debe haberse eliminado');
    });
});

test('confirm lanza (sin éxito silencioso) cuando el gate rechaza el apply', async () => {
    flow._setForTests({
        partialPause: Object.assign(stubMode('partial_pause', [5]), {
            readPreviousAllowlist: () => [5],
            setPartialPause: () => ({ ok: false, rejected: true, msg: 'gate rechazó' }),
        }),
        deps: { resolveOpenDeps: () => ({ openDeps: [] }) },
    });
    try {
        const s = fakeSession();
        setStep(s, 0, { action: 'despausar', scope: 'issue', issueId: 5 });
        setStep(s, 1, { action: 'despausar', scope: 'issue', affected: [5], openDeps: [], next_allowlist: [], resulting_mode: 'running' });
        setStep(s, 2, { motivo: 'sacar el 5 del allowlist por error', previous_snapshot: { mode: 'partial_pause', allowed_issues: [5] }, diff: { added: [], removed: [5] } });
        await assert.rejects(
            () => flow.executeStep(s, 3, { action: 'despausar', confirm1: true, confirm2: true }),
            /apply_rejected/,
        );
    } finally {
        flow._resetForTests();
    }
});

// ---------------------------------------------------------------------------
// register — idempotente
// ---------------------------------------------------------------------------

test('validateStep/executeStep fuera de rango', async () => {
    assert.equal(flow.validateStep(99, {}), false);
    const s = fakeSession();
    setStep(s, 0, { action: 'pausar', scope: 'full' });
    setStep(s, 1, { action: 'pausar', scope: 'full', next_allowlist: [], resulting_mode: 'paused' });
    setStep(s, 2, { motivo: 'motivo valido de prueba', previous_snapshot: { mode: 'running', allowed_issues: [] }, diff: {} });
    await assert.rejects(() => flow.executeStep(s, 7, {}), /fuera de rango/);
});

test('register en la base es idempotente (no rompe si ya está registrado)', () => {
    const ws = require('../../../wizard-session');
    assert.equal(flow.register(ws), false);
});

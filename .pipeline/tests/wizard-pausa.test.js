// Tests del flow "pausa" del wizard del Dashboard V3 (#3741).
//
// El contrato real de #3724 es {maxStep, validateStep, executeStep}; la base
// (wizard-session.js) resuelve CSRF, rate-limit, idempotencia (que cubre el
// replay del confirm_token), timeout y token de step. Estos tests cubren la
// lógica del FLOW: validación server-side, combinaciones acción/scope,
// recursividad de deps, XSS escape del preview, drift-check, doble confirmación,
// audit-then-apply (via:wizard-pausa), allowed_skills preservado y authorizedBy
// server-side. CSRF / rate-limit / idempotencia los cubre la suite de #3724.
//
// Convención de path: `.pipeline/tests/` (corrección del architect sobre la CA-18
// del PO, alineada con el runner `node --test .pipeline/lib/__tests__ .pipeline/tests`).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const flow = require('../lib/wizards/pausa/index');

function fakeSession() {
    return { flow: 'pausa', createdAt: Date.now(), lastAccessAt: Date.now(), steps: new Map() };
}
function setStep(session, step, result) {
    session.steps.set(step, { status: 'ok', result });
}
function modeStub(mode, allowedIssues = [], allowedSkills = []) {
    return { getPipelineMode: () => ({ mode, allowedIssues, allowedSkills }), readPreviousAllowlist: () => allowedIssues };
}

// ---------------------------------------------------------------------------
// validateStep — paso 0 (acción + scope)
// ---------------------------------------------------------------------------

test('paso0 rechaza acción inválida y scope inválido', () => {
    assert.equal(flow.validateStep(0, { action: 'borrar', scope: 'full' }), false);
    assert.equal(flow.validateStep(0, { action: 'pausar', scope: 'galaxia' }), false);
});

test('paso0 scope issue exige issue_id entero positivo', () => {
    assert.equal(flow.validateStep(0, { action: 'pausar', scope: 'issue', issue_id: '../etc' }), false);
    assert.equal(flow.validateStep(0, { action: 'pausar', scope: 'issue', issue_id: 0 }), false);
    assert.equal(flow.validateStep(0, { action: 'pausar', scope: 'issue', issue_id: 1732 }), true);
});

test('paso0 pausar+allowlist exige al menos un issue', () => {
    assert.equal(flow.validateStep(0, { action: 'pausar', scope: 'allowlist', issues: [] }), false);
    assert.equal(flow.validateStep(0, { action: 'pausar', scope: 'allowlist', issues: [10, 11] }), true);
});

test('paso0 pausar+full es válido sin issues', () => {
    assert.equal(flow.validateStep(0, { action: 'pausar', scope: 'full' }), true);
});

test('paso0 despausar requiere pausa activa (running → inválido)', () => {
    flow._setForTests({ partialPause: modeStub('running') });
    assert.equal(flow.validateStep(0, { action: 'despausar', scope: 'allowlist' }), false);
    flow._resetForTests();
});

test('paso0 despausar+full sólo válido si el modo es paused (no partial_pause)', () => {
    flow._setForTests({ partialPause: modeStub('partial_pause', [5]) });
    assert.equal(flow.validateStep(0, { action: 'despausar', scope: 'full' }), false);
    flow._resetForTests();
    flow._setForTests({ partialPause: modeStub('paused') });
    assert.equal(flow.validateStep(0, { action: 'despausar', scope: 'full' }), true);
    flow._resetForTests();
});

test('paso0 despausar+allowlist válido en partial_pause', () => {
    flow._setForTests({ partialPause: modeStub('partial_pause', [5, 6]) });
    assert.equal(flow.validateStep(0, { action: 'despausar', scope: 'allowlist' }), true);
    flow._resetForTests();
});

// ---------------------------------------------------------------------------
// validateStep — paso 2 (doble confirmación + drift + motivo)
// ---------------------------------------------------------------------------

test('paso2 pausar exige confirm1 (un solo check)', () => {
    flow._setForTests({ partialPause: modeStub('running') });
    const sig = flow.stateSignature({ mode: 'running' });
    assert.equal(flow.validateStep(2, { action: 'pausar', confirm1: false, previous_snapshot: sig }), false);
    assert.equal(flow.validateStep(2, { action: 'pausar', confirm1: true, previous_snapshot: sig }), true);
    flow._resetForTests();
});

test('paso2 despausar exige doble confirmación + motivo válido', () => {
    flow._setForTests({ partialPause: modeStub('partial_pause', [5]) });
    const sig = flow.stateSignature({ mode: 'partial_pause', allowedIssues: [5] });
    // Falta confirm2.
    assert.equal(flow.validateStep(2, { action: 'despausar', confirm1: true, confirm2: false, motivo: 'destrabe de la release', previous_snapshot: sig }), false);
    // Falta motivo (o muy corto).
    assert.equal(flow.validateStep(2, { action: 'despausar', confirm1: true, confirm2: true, motivo: 'corto', previous_snapshot: sig }), false);
    // OK.
    assert.equal(flow.validateStep(2, { action: 'despausar', confirm1: true, confirm2: true, motivo: 'reanudar pipeline para la release', previous_snapshot: sig }), true);
    flow._resetForTests();
});

test('paso2 rechaza motivo con byte NUL', () => {
    flow._setForTests({ partialPause: modeStub('partial_pause', [5]) });
    const sig = flow.stateSignature({ mode: 'partial_pause', allowedIssues: [5] });
    assert.equal(flow.validateStep(2, { action: 'despausar', confirm1: true, confirm2: true, motivo: 'motivo valido\x00inyectado', previous_snapshot: sig }), false);
    flow._resetForTests();
});

test('paso2 drift-check: 409 cuando la firma del cliente difiere del estado fresh', () => {
    flow._setForTests({ partialPause: modeStub('partial_pause', [5, 6]) });
    const stale = flow.stateSignature({ mode: 'partial_pause', allowedIssues: [5] }); // sin el 6
    assert.equal(flow.validateStep(2, { action: 'pausar', confirm1: true, previous_snapshot: stale }), false);
    flow._resetForTests();
});

// ---------------------------------------------------------------------------
// executeStep — paso 1 (preview: deps recursivas + XSS + modo resultante)
// ---------------------------------------------------------------------------

test('paso1 pausar+issue resuelve deps recursivas e incluye el padre + hijos', async () => {
    flow._setForTests({
        partialPause: modeStub('running', []),
        deps: { resolveOpenDeps: () => ({ openDeps: [200, 201], chains: { 100: { title: 'root' }, 200: { title: 'hijo' }, 201: { title: 'nieto' } }, truncated: false, reason: null, nodesVisited: 3 }) },
    });
    const s = fakeSession();
    setStep(s, 0, { action: 'pausar', scope: 'issue', issueId: 100, issues: [] });
    const r = await flow.executeStep(s, 1, {});
    assert.deepEqual(r.finalAllowlist, [100, 200, 201]);
    assert.equal(r.resultingMode, 'partial_pause');
    assert.equal(r.affected.length, 3);
    assert.equal(r.truncated, false);
    flow._resetForTests();
});

test('paso1 escapa el título malicioso del issue (CA-10 XSS)', async () => {
    flow._setForTests({
        partialPause: modeStub('running', []),
        deps: { resolveOpenDeps: () => ({ openDeps: [], chains: { 2901: { title: '<script>alert(1)</script>' } }, truncated: false, reason: null, nodesVisited: 1 }) },
    });
    const s = fakeSession();
    setStep(s, 0, { action: 'pausar', scope: 'issue', issueId: 2901, issues: [] });
    const r = await flow.executeStep(s, 1, {});
    const row = r.affected.find((a) => a.number === 2901);
    assert.ok(row.title_safe.includes('&lt;script&gt;'), 'el título debe quedar escapado');
    assert.ok(!row.title_safe.includes('<script>'), 'no debe haber <script> literal');
    flow._resetForTests();
});

test('paso1 partial-pause-empty-not-block: allowlist vacía + skills → partial_pause (CA-12)', async () => {
    flow._setForTests({ partialPause: modeStub('partial_pause', [], ['backend-dev']) });
    const s = fakeSession();
    // despausar+issue de un issue que no está en la allowlist → allowlist sigue [] pero hay skills.
    setStep(s, 0, { action: 'despausar', scope: 'issue', issueId: 999, issues: [] });
    const r = await flow.executeStep(s, 1, {});
    assert.deepEqual(r.finalAllowlist, []);
    assert.equal(r.resultingMode, 'partial_pause', 'allowlist vacía + skills != paused');
    flow._resetForTests();
});

test('paso1 pausar+full → modo resultante paused, sin deps', async () => {
    flow._setForTests({ partialPause: modeStub('running', []) });
    const s = fakeSession();
    setStep(s, 0, { action: 'pausar', scope: 'full', issueId: null, issues: [] });
    const r = await flow.executeStep(s, 1, {});
    assert.equal(r.resultingMode, 'paused');
    assert.deepEqual(r.affected, []);
    flow._resetForTests();
});

test('paso1 grafo cíclico no cuelga y marca truncated', async () => {
    flow._setForTests({
        partialPause: modeStub('running', []),
        deps: { resolveOpenDeps: () => ({ openDeps: [201], chains: { 200: { title: 'a' }, 201: { title: 'b' } }, truncated: true, reason: 'cycle', nodesVisited: 2 }) },
    });
    const s = fakeSession();
    setStep(s, 0, { action: 'pausar', scope: 'issue', issueId: 200, issues: [] });
    const r = await flow.executeStep(s, 1, {});
    assert.equal(r.truncated, true);
    assert.equal(r.reason, 'cycle');
    flow._resetForTests();
});

// ---------------------------------------------------------------------------
// executeStep — preconditions
// ---------------------------------------------------------------------------

test('executeStep lanza si el cliente salta pasos previos (precondition)', async () => {
    const s = fakeSession();
    await assert.rejects(() => flow.executeStep(s, 1, {}), /precondition/);
    await assert.rejects(() => flow.executeStep(s, 2, {}), /precondition/);
});

test('executeStep con step fuera de rango lanza', async () => {
    const s = fakeSession();
    setStep(s, 0, { action: 'pausar', scope: 'full', issueId: null, issues: [] });
    setStep(s, 1, { action: 'pausar', scope: 'full', resolvedIssues: [], finalAllowlist: [] });
    await assert.rejects(() => flow.executeStep(s, 9, {}), /fuera de rango/);
});

// ---------------------------------------------------------------------------
// executeStep — paso 2 (audit-then-apply, módulos REALES sobre tmp dir)
// ---------------------------------------------------------------------------

function withTmpPipeline(fn) {
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wiz-pausa-'));
    fs.mkdirSync(path.join(TMP, 'audit'), { recursive: true });
    fs.mkdirSync(path.join(TMP, 'logs'), { recursive: true });
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
    if (!fs.existsSync(auditFile)) return [];
    return fs.readFileSync(auditFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('confirm pausar+allowlist: aplica el estado y produce UNA entry con via:wizard-pausa', async () => {
    await withTmpPipeline(async (TMP) => {
        flow._setForTests({
            deps: { resolveOpenDeps: (id) => ({ openDeps: id === 100 ? [201] : [], chains: { 100: { title: 'root' }, 201: { title: 'dep' } }, truncated: false, reason: null, nodesVisited: 2 }) },
        });
        const s = fakeSession();
        setStep(s, 0, { action: 'pausar', scope: 'allowlist', issueId: null, issues: [100] });
        setStep(s, 1, { action: 'pausar', scope: 'allowlist', issueId: null, resolvedIssues: [100, 201], finalAllowlist: [100, 201] });
        const r = await flow.executeStep(s, 2, { confirm1: true, motivo: 'pausar el set para la release del jueves' });
        assert.equal(r.ok, true);
        assert.equal(r.resultingMode, 'partial_pause');

        const state = JSON.parse(fs.readFileSync(path.join(TMP, '.partial-pause.json'), 'utf8'));
        assert.deepEqual(state.allowed_issues, [100, 201]);

        const mine = readAuditLines(TMP).filter((e) => e.via === 'wizard-pausa');
        assert.equal(mine.length, 1, 'una sola entry del wizard (sin doble-audit)');
        assert.equal(mine[0].via, 'wizard-pausa');
        assert.equal(mine[0].wizard_flow, 'pausa');
        assert.equal(mine[0].authorized_by, 'commander:leo');
        assert.ok(mine[0].justification.includes('release'));
    });
});

test('confirm: authorizedBy del body se ignora; el log usa el server-side (CA-8)', async () => {
    await withTmpPipeline(async (TMP) => {
        flow._setForTests({ deps: { resolveOpenDeps: () => ({ openDeps: [], chains: { 50: { title: 't' } }, truncated: false, reason: null, nodesVisited: 1 }) } });
        const s = fakeSession();
        setStep(s, 0, { action: 'pausar', scope: 'issue', issueId: 50, issues: [] });
        setStep(s, 1, { action: 'pausar', scope: 'issue', issueId: 50, resolvedIssues: [50], finalAllowlist: [50] });
        await flow.executeStep(s, 2, { confirm1: true, motivo: 'pausar issue puntual', authorizedBy: 'commander:fake' });
        const mine = readAuditLines(TMP).filter((e) => e.via === 'wizard-pausa');
        assert.equal(mine[mine.length - 1].authorized_by, 'commander:leo', 'authorizedBy NUNCA del body');
    });
});

test('confirm pausar+issue preserva allowed_skills no manipulado (CA-14)', async () => {
    await withTmpPipeline(async (TMP) => {
        flow._resetForTests();
        // Pre-setear estado con skills.
        const pp = require('../lib/partial-pause');
        pp.setPartialPause([5], { source: 'seed', authorizedBy: 'commander:leo', justification: 'seed inicial', allowedSkills: ['backend-dev'] });
        flow._setForTests({ deps: { resolveOpenDeps: () => ({ openDeps: [], chains: { 7: { title: 't' } }, truncated: false, reason: null, nodesVisited: 1 }) } });
        const s = fakeSession();
        setStep(s, 0, { action: 'pausar', scope: 'issue', issueId: 7, issues: [] });
        setStep(s, 1, { action: 'pausar', scope: 'issue', issueId: 7, resolvedIssues: [7], finalAllowlist: [5, 7] });
        await flow.executeStep(s, 2, { confirm1: true, motivo: 'sumar el issue 7 a la ventana' });
        const state = JSON.parse(fs.readFileSync(path.join(TMP, '.partial-pause.json'), 'utf8'));
        assert.deepEqual(state.allowed_issues, [5, 7]);
        assert.deepEqual(state.allowed_skills, ['backend-dev'], 'allowed_skills debe sobrevivir');
    });
});

test('confirm pausar+full crea .paused vía gate y audita con via:wizard-pausa', async () => {
    await withTmpPipeline(async (TMP) => {
        const s = fakeSession();
        setStep(s, 0, { action: 'pausar', scope: 'full', issueId: null, issues: [] });
        setStep(s, 1, { action: 'pausar', scope: 'full', resolvedIssues: [], finalAllowlist: [] });
        const r = await flow.executeStep(s, 2, { confirm1: true, motivo: 'pausa total de emergencia' });
        assert.equal(r.ok, true);
        assert.ok(fs.existsSync(path.join(TMP, '.paused')), '.paused debe existir');
        const mine = readAuditLines(TMP).filter((e) => e.via === 'wizard-pausa');
        assert.equal(mine[mine.length - 1].via, 'wizard-pausa');
    });
});

test('confirm despausar+allowlist limpia la pausa parcial (clear)', async () => {
    await withTmpPipeline(async (TMP) => {
        flow._resetForTests();
        const pp = require('../lib/partial-pause');
        pp.setPartialPause([5, 6], { source: 'seed', authorizedBy: 'commander:leo', justification: 'seed inicial' });
        flow._setForTests({});
        const s = fakeSession();
        setStep(s, 0, { action: 'despausar', scope: 'allowlist', issueId: null, issues: [] });
        setStep(s, 1, { action: 'despausar', scope: 'allowlist', issueId: null, resolvedIssues: [], finalAllowlist: [] });
        const r = await flow.executeStep(s, 2, { confirm1: true, confirm2: true, motivo: 'reanudar el pipeline completo' });
        assert.equal(r.ok, true);
        assert.equal(fs.existsSync(path.join(TMP, '.partial-pause.json')), false, 'marker debe eliminarse');
    });
});

test('confirm lanza (sin éxito silencioso) cuando el gate rechaza el apply', async () => {
    flow._setForTests({
        partialPause: {
            getPipelineMode: () => ({ mode: 'partial_pause', allowedIssues: [5], allowedSkills: [] }),
            readPreviousAllowlist: () => [5],
            setPartialPause: () => ({ ok: false, rejected: true, msg: 'gate rechazó' }),
        },
    });
    try {
        const s = fakeSession();
        setStep(s, 0, { action: 'despausar', scope: 'issue', issueId: 5, issues: [] });
        setStep(s, 1, { action: 'despausar', scope: 'issue', issueId: 5, resolvedIssues: [], finalAllowlist: [] });
        // finalAllowlist quedará [] → cae a clearPartialPause; forzamos rechazo ahí.
        flow._setForTests({
            partialPause: {
                getPipelineMode: () => ({ mode: 'partial_pause', allowedIssues: [5], allowedSkills: ['x'] }),
                readPreviousAllowlist: () => [5],
                setPartialPause: () => ({ ok: false, rejected: true, msg: 'gate rechazó' }),
            },
        });
        await assert.rejects(
            () => flow.executeStep(s, 2, { confirm1: true, confirm2: true, motivo: 'remover el issue 5 de la ventana' }),
            /apply_rejected/,
        );
    } finally {
        flow._resetForTests();
    }
});

// ---------------------------------------------------------------------------
// Unidades puras
// ---------------------------------------------------------------------------

test('computeResultingMode respeta full > skills > running', () => {
    assert.equal(flow.computeResultingMode({ full: true }), 'paused');
    assert.equal(flow.computeResultingMode({ allowlist: [1] }), 'partial_pause');
    assert.equal(flow.computeResultingMode({ allowlist: [], allowedSkills: ['x'] }), 'partial_pause');
    assert.equal(flow.computeResultingMode({ allowlist: [], allowedSkills: [] }), 'running');
});

test('computeAllowlist: pausar issue une previous+deps; despausar issue quita', () => {
    assert.deepEqual(flow.computeAllowlist('pausar', 'issue', 100, [], [100, 201], [50]), [50, 100, 201]);
    assert.deepEqual(flow.computeAllowlist('pausar', 'allowlist', null, [10, 11], [10, 11, 12], [99]), [10, 11, 12]);
    assert.deepEqual(flow.computeAllowlist('despausar', 'issue', 50, [], [], [50, 60]), [60]);
    assert.deepEqual(flow.computeAllowlist('despausar', 'allowlist', null, [], [], [1, 2]), []);
});

test('stateSignature es orden-independiente y combina mode+issues+skills', () => {
    const a = flow.stateSignature({ mode: 'partial_pause', allowedIssues: [2, 1], allowedSkills: ['b', 'a'] });
    const b = flow.stateSignature({ mode: 'partial_pause', allowedIssues: [1, 2], allowedSkills: ['a', 'b'] });
    assert.equal(a, b);
    assert.notEqual(a, flow.stateSignature({ mode: 'paused' }));
});

test('register en la base es idempotente (no rompe si ya está registrado)', () => {
    const ws = require('../lib/wizard-session');
    assert.equal(flow.register(ws), false);
});

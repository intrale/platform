// =============================================================================
// operator-gate.test.js — Canal de firma del operador (issue #4579).
//
// Cubre las CA de seguridad no negociables:
//   CA-4 [A01/A07] autorización por operador (from.id) + binding tenant→operador
//   CA-5 [A08]     token firmado single-use; doble-tap/expirado rechazados
//   CA-6 [A09]     audit inmutable hash-chained; verifyChain detecta manipulación
//   CA-7 [A03/A04] allowlist cerrada de acciones + anti path-traversal
//   CA-8 [A02]     redacción de secrets en el audit
// Todo hermético: signer con secreto/clock inyectado, dirs temporales.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createOperatorGate, GATE_ACTIONS, OPAQUE_ID_RE } = require('../operator-gate');
const { createTokenSigner } = require('../action-token');
const auditLog = require('../audit-log');

const OPERATOR = '111222333';
const OTHER = '999888777';
const SECRET = 'test-secret-operator-gate';

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'opgate-'));
}

/**
 * Construye un gate hermético con dirs temporales, allowlist inyectado y un
 * signer con clock controlable. Devuelve { gate, dirs, clock, setClock }.
 */
function makeGate(overrides = {}) {
    const root = tmpDir();
    const dirs = {
        storeDir: path.join(root, 'store'),
        waitingDir: path.join(root, 'waiting-operator'),
        approvedDir: path.join(root, 'procesado'),
        rejectedDir: path.join(root, 'pendiente'),
        auditFile: path.join(root, 'audit', 'signatures.jsonl'),
        nonceFile: path.join(root, 'audit', 'tokens-used.jsonl'),
    };
    let clock = 1_000_000;
    const now = () => clock;
    const signer = overrides.signer || createTokenSigner({
        secret: SECRET,
        nonceFile: dirs.nonceFile,
        ttlMs: overrides.ttlMs || 60_000,
        now,
    });
    const gate = createOperatorGate({
        storeDir: dirs.storeDir,
        waitingDir: dirs.waitingDir,
        approvedDir: dirs.approvedDir,
        rejectedDir: dirs.rejectedDir,
        auditFile: dirs.auditFile,
        signer,
        operatorAllowlist: overrides.operatorAllowlist || [OPERATOR],
        tenantBinding: overrides.tenantBinding || {},
        now,
    });
    return { gate, dirs, now, setClock: (v) => { clock = v; }, advance: (ms) => { clock += ms; } };
}

/** Crea un ítem `waiting-operator/<issue>.json` para poder transicionarlo. */
function seedWaitingItem(dirs, issue) {
    fs.mkdirSync(dirs.waitingDir, { recursive: true });
    fs.writeFileSync(path.join(dirs.waitingDir, `${issue}.json`), JSON.stringify({ issue }));
}

// --- CA-4: autorización por operador + binding tenant ------------------------

test('isAuthorizedOperator acepta un operador del allowlist', () => {
    const { gate } = makeGate();
    assert.equal(gate.isAuthorizedOperator(OPERATOR), true);
    assert.equal(gate.isAuthorizedOperator(Number(OPERATOR)), true); // string/number
});

test('isAuthorizedOperator rechaza un from.id fuera del allowlist', () => {
    const { gate } = makeGate();
    assert.equal(gate.isAuthorizedOperator(OTHER), false);
    assert.equal(gate.isAuthorizedOperator(null), false);
    assert.equal(gate.isAuthorizedOperator(undefined), false);
});

test('allowlist vacío = fail-closed (nadie autorizado)', () => {
    const { gate } = makeGate({ operatorAllowlist: [] });
    assert.equal(gate.isAuthorizedOperator(OPERATOR), false);
});

test('binding tenant→operador: sólo el operador atado firma ese tenant', () => {
    const { gate } = makeGate({
        operatorAllowlist: [OPERATOR, OTHER],
        tenantBinding: { acme: [OPERATOR] },
    });
    assert.equal(gate.isAuthorizedOperator(OPERATOR, 'acme'), true);
    assert.equal(gate.isAuthorizedOperator(OTHER, 'acme'), false); // no atado a acme
    assert.equal(gate.isAuthorizedOperator(OTHER, 'sin-binding'), true); // default global
});

// --- CA-5 / A08: store id opaco + token single-use ---------------------------

test('register genera un callback_data opaco válido (≤64B) y resoluble', () => {
    const { gate } = makeGate();
    const { id, callbackData, token } = gate.register({ issue: 4579, action: 'approve' });
    assert.match(id, OPAQUE_ID_RE);
    assert.ok(Buffer.byteLength(callbackData) <= 64);
    assert.equal(callbackData, id);
    assert.ok(typeof token === 'string' && token.length > 64); // el token NO cabría en callback_data
    const entry = gate.resolve(id);
    assert.equal(entry.issue, 4579);
    assert.equal(entry.action, 'approve');
});

test('resolve devuelve null para id inexistente o con path-traversal', () => {
    const { gate } = makeGate();
    assert.equal(gate.resolve('deadbeefdeadbeef'), null);
    assert.equal(gate.resolve('../../etc/passwd'), null);
    assert.equal(gate.resolve('..\\..\\secrets'), null);
    assert.equal(gate.resolve(''), null);
    assert.equal(gate.resolve(null), null);
});

test('register rechaza issue/action/tenant inválidos (inputs no confiables)', () => {
    const { gate } = makeGate();
    assert.throws(() => gate.register({ issue: 0, action: 'approve' }), /issue inválido/);
    assert.throws(() => gate.register({ issue: 'x', action: 'approve' }), /issue inválido/);
    assert.throws(() => gate.register({ issue: 1, action: 'pausar' }), /action inválida/);
    assert.throws(() => gate.register({ issue: 1, action: 'unblock' }), /action inválida/); // fuera del subconjunto de gate
    assert.throws(() => gate.register({ issue: 1, action: 'approve', tenant: '../etc' }), /tenant inválido/);
});

// --- CA-7 / A03-A04: transición + anti path-traversal ------------------------

test('applyTransition approve mueve el ítem waiting-operator → procesado', () => {
    const { gate, dirs } = makeGate();
    seedWaitingItem(dirs, 4579);
    const r = gate.applyTransition({ issue: 4579, action: 'approve' });
    assert.equal(r.ok, true);
    assert.equal(r.gate, 'aprobado');
    assert.ok(!fs.existsSync(path.join(dirs.waitingDir, '4579.json')));
    assert.ok(fs.existsSync(path.join(dirs.approvedDir, '4579.json')));
});

test('applyTransition reject/adjust devuelven el ítem a pendiente', () => {
    for (const action of ['reject', 'adjust-definicion']) {
        const { gate, dirs } = makeGate();
        seedWaitingItem(dirs, 100);
        const r = gate.applyTransition({ issue: 100, action });
        assert.equal(r.ok, true);
        assert.ok(fs.existsSync(path.join(dirs.rejectedDir, '100.json')));
    }
});

test('applyTransition sin ítem devuelve not-found (gate productor aún OPEN)', () => {
    const { gate } = makeGate();
    const r = gate.applyTransition({ issue: 4579, action: 'approve' });
    assert.equal(r.ok, false);
    assert.equal(r.status, 'not-found');
});

test('applyTransition rechaza issue inválido y acción fuera del set', () => {
    const { gate } = makeGate();
    assert.equal(gate.applyTransition({ issue: 'x', action: 'approve' }).status, 'invalid-issue');
    assert.equal(gate.applyTransition({ issue: 1, action: 'unblock' }).status, 'invalid-action');
});

// --- handleSignature: orquestación completa ----------------------------------

test('handleSignature happy path: aprueba, transiciona, audita y consume', () => {
    const { gate, dirs } = makeGate();
    seedWaitingItem(dirs, 4579);
    const { id } = gate.register({ issue: 4579, action: 'approve' });

    const res = gate.handleSignature({ operatorId: OPERATOR, callbackData: id });
    assert.equal(res.ok, true);
    assert.equal(res.transitioned, true);
    assert.equal(res.editMessage, true);
    assert.equal(res.action, 'approve');
    assert.match(res.toast, /Aprobado/);
    // ítem movido
    assert.ok(fs.existsSync(path.join(dirs.approvedDir, '4579.json')));
    // store consumido
    assert.equal(gate.resolve(id), null);
    // audit escrito y chain íntegro
    const chain = auditLog.verifyChain(dirs.auditFile);
    assert.equal(chain.ok, true);
    assert.equal(chain.entriesChecked, 1);
});

test('handleSignature rechaza operador no autorizado sin transicionar ni consumir', () => {
    const { gate, dirs } = makeGate();
    seedWaitingItem(dirs, 4579);
    const { id } = gate.register({ issue: 4579, action: 'approve' });

    const res = gate.handleSignature({ operatorId: OTHER, callbackData: id });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'unauthorized');
    assert.match(res.toast, /No autorizado/);
    // no movió el ítem
    assert.ok(fs.existsSync(path.join(dirs.waitingDir, '4579.json')));
    // NO consumió el binding legítimo del operador real
    assert.ok(gate.resolve(id) !== null);
    // no auditó como éxito
    assert.equal(auditLog.verifyChain(dirs.auditFile).entriesChecked, 0);
});

test('handleSignature con id desconocido → unknown-id', () => {
    const { gate } = makeGate();
    const res = gate.handleSignature({ operatorId: OPERATOR, callbackData: 'aaaaaaaaaaaaaaaa' });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'unknown-id');
});

test('handleSignature es single-use: el segundo toque → replayed', () => {
    const { gate, dirs } = makeGate();
    seedWaitingItem(dirs, 4579);
    const { id } = gate.register({ issue: 4579, action: 'approve' });

    assert.equal(gate.handleSignature({ operatorId: OPERATOR, callbackData: id }).ok, true);
    // el binding se consumió → segundo toque no encuentra el id
    const r2 = gate.handleSignature({ operatorId: OPERATOR, callbackData: id });
    assert.equal(r2.ok, false);
    assert.equal(r2.reason, 'unknown-id');
});

test('handleSignature rechaza token expirado con toast humano', () => {
    const h = makeGate({ ttlMs: 1000 });
    seedWaitingItem(h.dirs, 4579);
    const { id } = h.gate.register({ issue: 4579, action: 'reject' });
    h.advance(5000); // más allá del ttl
    const res = h.gate.handleSignature({ operatorId: OPERATOR, callbackData: id });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'expired');
    assert.match(res.toast, /expirada/);
});

test('handleSignature audita incluso si el ítem no existe (constancia de firma)', () => {
    const { gate, dirs } = makeGate(); // sin seed → not-found
    const { id } = gate.register({ issue: 4579, action: 'approve' });
    const res = gate.handleSignature({ operatorId: OPERATOR, callbackData: id });
    assert.equal(res.ok, true);
    assert.equal(res.transitioned, false);
    assert.equal(res.editMessage, false); // no se editó porque no transicionó
    const chain = auditLog.verifyChain(dirs.auditFile);
    assert.equal(chain.ok, true);
    assert.equal(chain.entriesChecked, 1);
});

// --- CA-6 / A09: audit inmutable hash-chained --------------------------------

test('verifyChain detecta manipulación de una firma persistida', () => {
    const { gate, dirs } = makeGate();
    seedWaitingItem(dirs, 4579);
    const { id } = gate.register({ issue: 4579, action: 'approve' });
    gate.handleSignature({ operatorId: OPERATOR, callbackData: id });

    // Tamper: alterar el actor de la firma en disco.
    const raw = fs.readFileSync(dirs.auditFile, 'utf8').trim();
    const tampered = raw.replace(/"actor":"[^"]*"/, '"actor":"attacker"');
    fs.writeFileSync(dirs.auditFile, tampered + '\n');
    const chain = auditLog.verifyChain(dirs.auditFile);
    assert.equal(chain.ok, false);
});

// --- CA-8 / A02: redacción de secrets ----------------------------------------

test('auditSignature redacta secrets antes de persistir (no filtra AWS key)', () => {
    const { gate, dirs } = makeGate();
    const leaked = 'AKIAIOSFODNN7EXAMPLE';
    gate.auditSignature({
        actor: `op-${leaked}`,
        action: 'approve',
        issue: 4579,
        tenant: null,
        gate: 'aprobado',
        nonce: 'abc',
        result: 'aprobado',
    });
    const persisted = fs.readFileSync(dirs.auditFile, 'utf8');
    assert.ok(!persisted.includes(leaked), 'la AWS key no debe aparecer en el audit');
});

// --- CA-3: inline keyboard ---------------------------------------------------

test('buildInlineKeyboard usa emoji+texto, orden estable y ✏️ opcional', () => {
    const { gate } = makeGate();
    const kbNoAdjust = gate.buildInlineKeyboard({ approveId: 'a1', rejectId: 'r1' });
    assert.deepEqual(kbNoAdjust.inline_keyboard[0].map(b => b.text), ['✅ Aprobar', '❌ Rechazar']);
    const kb = gate.buildInlineKeyboard({ approveId: 'a1', rejectId: 'r1', adjustId: 'j1' });
    assert.deepEqual(kb.inline_keyboard[0].map(b => b.text), ['✅ Aprobar', '❌ Rechazar', '✏️ Ajustar']);
    assert.equal(kb.inline_keyboard[0][0].callback_data, 'a1');
});

test('GATE_ACTIONS es exactamente el subconjunto de firma', () => {
    assert.deepEqual([...GATE_ACTIONS].sort(), ['adjust-definicion', 'approve', 'reject']);
});

// Tests de .pipeline/lib/delegation-grant.js (issue #4630).
// Cubren: emisión (solo primary), delegate desconocido, gate no delegable
// (incl. GATE1/GATE2), grant válido, manipulado (tampered), expirado, replay,
// revocado, rotación de secretVersion (versión inválida), atomicidad del nonce,
// binding de delegate, y verificación del audit chain con verifyChain.
// Secretos, allowlist y stores inyectados → tests herméticos (no leen
// credentials.json ni .env).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const grants = require('../delegation-grant');
const { createAllowlist } = require('../operator-allowlist');
const auditLog = require('../audit-log');
const { REJECT_REASONS, AUDIT_EVENTS } = grants;

const SECRETS = { '1': 'secreto-v1-no-real', '2': 'secreto-v2-no-real' };

const ALLOWLIST = createAllowlist({ operators: [
    { id: 'alice', role: 'primary' },
    { id: 'bob', role: 'backup' },
    { id: 'carol', role: 'backup' },
] });

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'delgrant-'));
}

/**
 * Crea una autoridad hermética con stores en un tmpdir aislado y clock fijo
 * inyectable. `nowRef.t` permite avanzar el reloj para probar expiración.
 */
function makeAuthority(overrides = {}) {
    const dir = tmpDir();
    const nowRef = { t: 1_000_000 };
    const authority = grants.createGrantAuthority({
        secrets: SECRETS,
        activeSecretVersion: '1',
        allowlist: ALLOWLIST,
        ttlMs: 10 * 60 * 1000,
        now: () => nowRef.t,
        auditFile: path.join(dir, 'audit.jsonl'),
        nonceFile: path.join(dir, 'used.jsonl'),
        revocationFile: path.join(dir, 'revoked.jsonl'),
        ...overrides,
    });
    return { authority, nowRef, dir };
}

// ---------------------------------------------------------------------------
// Emisión
// ---------------------------------------------------------------------------

test('primary emite un grant firmado con todos los campos requeridos', () => {
    const { authority } = makeAuthority();
    const r = authority.issue({ grantor: 'alice', delegate: 'bob', gateClasses: ['realign-allowlist'] });
    assert.equal(r.ok, true);
    const { payload, signature } = r.grant;
    assert.equal(payload.grantor, 'alice');
    assert.equal(payload.delegate, 'bob');
    assert.deepEqual(payload.gateClasses, ['realign-allowlist']);
    assert.equal(typeof payload.exp, 'number');
    assert.equal(typeof payload.nonce, 'string');
    assert.equal(payload.secretVersion, '1');
    assert.equal(typeof signature, 'string');
    assert.ok(signature.length > 0);
});

test('backup NO puede emitir grants (rechazo not-primary, sin re-delegación)', () => {
    const { authority } = makeAuthority();
    const r = authority.issue({ grantor: 'bob', delegate: 'carol', gateClasses: ['realign-allowlist'] });
    assert.equal(r.ok, false);
    assert.equal(r.reason, REJECT_REASONS.NOT_PRIMARY);
});

test('operador desconocido NO puede emitir grants (unknown-operator)', () => {
    const { authority } = makeAuthority();
    const r = authority.issue({ grantor: 'mallory', delegate: 'bob', gateClasses: ['realign-allowlist'] });
    assert.equal(r.ok, false);
    assert.equal(r.reason, REJECT_REASONS.UNKNOWN_OPERATOR);
});

test('no se puede emitir grant a un delegate no registrado (unknown-delegate)', () => {
    const { authority } = makeAuthority();
    const r = authority.issue({ grantor: 'alice', delegate: 'nadie', gateClasses: ['realign-allowlist'] });
    assert.equal(r.ok, false);
    assert.equal(r.reason, REJECT_REASONS.UNKNOWN_DELEGATE);
});

test('emitir con GATE1/GATE2 se rechaza (no delegable, ni por config)', () => {
    const { authority } = makeAuthority();
    for (const gc of ['gate1-definition', 'gate2-acceptance']) {
        const r = authority.issue({ grantor: 'alice', delegate: 'bob', gateClasses: [gc] });
        assert.equal(r.ok, false, `gate ${gc} debería rechazarse`);
        assert.equal(r.reason, REJECT_REASONS.NON_DELEGABLE_GATE);
    }
});

test('emitir con gateClasses vacío o clase inexistente se rechaza', () => {
    const { authority } = makeAuthority();
    assert.equal(authority.issue({ grantor: 'alice', delegate: 'bob', gateClasses: [] }).reason, REJECT_REASONS.NON_DELEGABLE_GATE);
    assert.equal(authority.issue({ grantor: 'alice', delegate: 'bob', gateClasses: ['inventada'] }).reason, REJECT_REASONS.NON_DELEGABLE_GATE);
    assert.equal(authority.issue({ grantor: 'alice', delegate: 'bob', gateClasses: ['realign-allowlist', 'gate1-definition'] }).reason, REJECT_REASONS.NON_DELEGABLE_GATE);
});

// ---------------------------------------------------------------------------
// Validación / consumo
// ---------------------------------------------------------------------------

test('grant válido pasa validate y consume una sola vez', () => {
    const { authority } = makeAuthority();
    const { grant } = authority.issue({ grantor: 'alice', delegate: 'bob', gateClasses: ['reseed-wave'] });
    assert.equal(authority.validate(grant).ok, true);
    const c1 = authority.consume(grant, { delegate: 'bob' });
    assert.equal(c1.ok, true);
    assert.equal(c1.payload.nonce, grant.payload.nonce);
});

test('replay: segundo consume del mismo grant se rechaza (replayed)', () => {
    const { authority } = makeAuthority();
    const { grant } = authority.issue({ grantor: 'alice', delegate: 'bob', gateClasses: ['reseed-wave'] });
    assert.equal(authority.consume(grant).ok, true);
    const c2 = authority.consume(grant);
    assert.equal(c2.ok, false);
    assert.equal(c2.reason, REJECT_REASONS.REPLAYED);
});

test('grant manipulado (payload tampered) se rechaza con bad-signature', () => {
    const { authority } = makeAuthority();
    const { grant } = authority.issue({ grantor: 'alice', delegate: 'bob', gateClasses: ['realign-allowlist'] });
    // Escalar gateClasses manteniendo la firma original.
    const tampered = { payload: { ...grant.payload, gateClasses: ['worktree-reset', 'quota-flag'] }, signature: grant.signature };
    const r = authority.validate(tampered);
    assert.equal(r.ok, false);
    assert.equal(r.reason, REJECT_REASONS.BAD_SIGNATURE);
});

test('firma manipulada se rechaza con bad-signature', () => {
    const { authority } = makeAuthority();
    const { grant } = authority.issue({ grantor: 'alice', delegate: 'bob', gateClasses: ['realign-allowlist'] });
    const last = grant.signature.slice(-1);
    const flipped = grant.signature.slice(0, -1) + (last === 'a' ? 'b' : 'a');
    const r = authority.validate({ payload: grant.payload, signature: flipped });
    assert.equal(r.ok, false);
    assert.equal(r.reason, REJECT_REASONS.BAD_SIGNATURE);
});

test('grant expirado se rechaza con expired', () => {
    const { authority, nowRef } = makeAuthority();
    const { grant } = authority.issue({ grantor: 'alice', delegate: 'bob', gateClasses: ['realign-allowlist'] });
    nowRef.t += 11 * 60 * 1000; // pasa el TTL de 10min
    const r = authority.validate(grant);
    assert.equal(r.ok, false);
    assert.equal(r.reason, REJECT_REASONS.EXPIRED);
});

test('grant revocado se rechaza con revoked (antes de expirar)', () => {
    const { authority } = makeAuthority();
    const { grant } = authority.issue({ grantor: 'alice', delegate: 'bob', gateClasses: ['realign-allowlist'] });
    authority.revoke({ nonce: grant.payload.nonce, revokedBy: 'alice', reason: 'compromiso sospechado' });
    assert.equal(authority.validate(grant).reason, REJECT_REASONS.REVOKED);
    assert.equal(authority.consume(grant).reason, REJECT_REASONS.REVOKED);
});

test('rotación de secretVersion invalida grants de versión anterior (version-invalid)', () => {
    const { authority, dir } = makeAuthority();
    const { grant } = authority.issue({ grantor: 'alice', delegate: 'bob', gateClasses: ['realign-allowlist'] });
    assert.equal(authority.validate(grant).ok, true);
    // Nueva autoridad con versión activa rotada a '2', mismos stores.
    const rotated = grants.createGrantAuthority({
        secrets: SECRETS,
        activeSecretVersion: '2',
        allowlist: ALLOWLIST,
        auditFile: path.join(dir, 'audit.jsonl'),
        nonceFile: path.join(dir, 'used.jsonl'),
        revocationFile: path.join(dir, 'revoked.jsonl'),
    });
    const r = rotated.validate(grant);
    assert.equal(r.ok, false);
    assert.equal(r.reason, REJECT_REASONS.VERSION_INVALID);
});

test('grant firmado con secretVersion desconocida se rechaza version-invalid', () => {
    const { authority } = makeAuthority();
    const { grant } = authority.issue({ grantor: 'alice', delegate: 'bob', gateClasses: ['realign-allowlist'] });
    const forged = { payload: { ...grant.payload, secretVersion: '99' }, signature: grant.signature };
    assert.equal(authority.validate(forged).reason, REJECT_REASONS.VERSION_INVALID);
});

test('grant creado por no-primario (forjado en payload) se rechaza al validar', () => {
    const { authority } = makeAuthority();
    // Un backup no puede emitir; forjar el payload no ayuda porque no tiene la
    // clave para firmar. Firma inválida → bad-signature.
    const { grant } = authority.issue({ grantor: 'alice', delegate: 'bob', gateClasses: ['realign-allowlist'] });
    const forged = { payload: { ...grant.payload, grantor: 'bob' }, signature: grant.signature };
    assert.equal(authority.validate(forged).reason, REJECT_REASONS.BAD_SIGNATURE);
});

test('validate rechaza envelopes malformados con causa malformed', () => {
    const { authority } = makeAuthority();
    assert.equal(authority.validate(null).reason, REJECT_REASONS.MALFORMED);
    assert.equal(authority.validate({}).reason, REJECT_REASONS.MALFORMED);
    assert.equal(authority.validate({ payload: {}, signature: 'x' }).reason, REJECT_REASONS.MALFORMED);
    assert.equal(authority.validate({ payload: { grantor: 'alice' }, signature: '' }).reason, REJECT_REASONS.MALFORMED);
});

test('binding de delegate: consumir con delegate distinto se rechaza (delegate-mismatch)', () => {
    const { authority } = makeAuthority();
    const { grant } = authority.issue({ grantor: 'alice', delegate: 'bob', gateClasses: ['realign-allowlist'] });
    const r = authority.consume(grant, { delegate: 'carol' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, REJECT_REASONS.DELEGATE_MISMATCH);
    // No debe haberse consumido: el delegate correcto todavía puede usarlo.
    assert.equal(authority.consume(grant, { delegate: 'bob' }).ok, true);
});

// ---------------------------------------------------------------------------
// Canonicalización: la firma no depende del orden de keys del payload
// ---------------------------------------------------------------------------

test('la firma es reproducible sin importar el orden de keys del payload', () => {
    const { grant } = makeAuthority().authority.issue({ grantor: 'alice', delegate: 'bob', gateClasses: ['realign-allowlist'] });
    const p = grant.payload;
    // Reconstruir el payload con las keys en orden inverso.
    const reordered = {};
    for (const k of Object.keys(p).reverse()) reordered[k] = p[k];
    const sigA = grants.signPayload(p, SECRETS['1'], '1');
    const sigB = grants.signPayload(reordered, SECRETS['1'], '1');
    assert.equal(sigA, sigB);
    assert.equal(sigA, grant.signature);
});

// ---------------------------------------------------------------------------
// Atomicidad del nonce (anti-replay por carrera)
// ---------------------------------------------------------------------------

test('consumos concurrentes del mismo nonce: exactamente uno gana', () => {
    const { authority } = makeAuthority();
    const { grant } = authority.issue({ grantor: 'alice', delegate: 'bob', gateClasses: ['reseed-wave'] });
    // El consume es síncrono y atómico bajo lock; simulamos N intentos.
    const results = [];
    for (let i = 0; i < 5; i++) results.push(authority.consume(grant));
    const wins = results.filter(r => r.ok).length;
    const replays = results.filter(r => !r.ok && r.reason === REJECT_REASONS.REPLAYED).length;
    assert.equal(wins, 1);
    assert.equal(replays, 4);
});

// ---------------------------------------------------------------------------
// Audit tamper-evident
// ---------------------------------------------------------------------------

test('audit registra concesión, consumo, rechazo y revocación con cadena verificable', () => {
    const { authority } = makeAuthority();
    const { grant } = authority.issue({ grantor: 'alice', delegate: 'bob', gateClasses: ['realign-allowlist'] });
    authority.consume(grant);                 // grant-consumed
    authority.consume(grant);                 // grant-rejected (replayed)
    const { grant: g2 } = authority.issue({ grantor: 'alice', delegate: 'carol', gateClasses: ['quota-flag'] });
    authority.revoke({ nonce: g2.payload.nonce, revokedBy: 'alice' }); // grant-revoked

    const chain = authority.verifyAuditChain();
    assert.equal(chain.ok, true, JSON.stringify(chain));

    const entries = auditLog.readAll(authority.auditFile);
    const events = entries.map(e => e.event);
    assert.ok(events.includes(AUDIT_EVENTS.ISSUED));
    assert.ok(events.includes(AUDIT_EVENTS.CONSUMED));
    assert.ok(events.includes(AUDIT_EVENTS.REJECTED));
    assert.ok(events.includes(AUDIT_EVENTS.REVOKED));
});

test('el audit NUNCA persiste la firma ni el secreto del grant', () => {
    const { authority } = makeAuthority();
    const { grant } = authority.issue({ grantor: 'alice', delegate: 'bob', gateClasses: ['realign-allowlist'] });
    authority.consume(grant);
    const raw = fs.readFileSync(authority.auditFile, 'utf8');
    assert.ok(!raw.includes(grant.signature), 'la firma no debe aparecer en el audit');
    for (const secret of Object.values(SECRETS)) {
        assert.ok(!raw.includes(secret), 'ningún secreto debe aparecer en el audit');
    }
    // Sí deben aparecer los nombres de campo consistentes.
    const entries = auditLog.readAll(authority.auditFile);
    const issued = entries.find(e => e.event === AUDIT_EVENTS.ISSUED);
    assert.equal(issued.grantor, 'alice');
    assert.equal(issued.delegate, 'bob');
    assert.equal(issued.secretVersion, '1');
    assert.equal(typeof issued.nonce, 'string');
});

test('el flujo de grant no se rompe si el audit falla (best-effort, fail-safe)', () => {
    // auditFile apunta a un directorio → appendChained lanza al leer/escribir.
    // El grant igual se emite/consume; el fallo del audit se reporta a stderr.
    const dir = tmpDir();
    const errors = [];
    const originalErr = console.error;
    console.error = (msg) => errors.push(String(msg));
    try {
        const authority = grants.createGrantAuthority({
            secrets: SECRETS,
            activeSecretVersion: '1',
            allowlist: ALLOWLIST,
            auditFile: dir, // un directorio, no un archivo → appendChained falla
            nonceFile: path.join(dir, 'used.jsonl'),
            revocationFile: path.join(dir, 'revoked.jsonl'),
        });
        const r = authority.issue({ grantor: 'alice', delegate: 'bob', gateClasses: ['realign-allowlist'] });
        assert.equal(r.ok, true);
        assert.equal(authority.consume(r.grant).ok, true);
    } finally {
        console.error = originalErr;
    }
    assert.ok(errors.some(e => e.includes('[delegation-grant] audit')), 'debe reportar el fallo del audit a stderr');
});

test('detecta manipulación del audit (verifyChain rompe si se edita una línea)', () => {
    const { authority } = makeAuthority();
    const { grant } = authority.issue({ grantor: 'alice', delegate: 'bob', gateClasses: ['realign-allowlist'] });
    authority.consume(grant);
    // Tamper: reescribir una línea del audit.
    const lines = fs.readFileSync(authority.auditFile, 'utf8').split('\n').filter(Boolean);
    const obj = JSON.parse(lines[0]);
    obj.grantor = 'mallory';
    lines[0] = JSON.stringify(obj);
    fs.writeFileSync(authority.auditFile, lines.join('\n') + '\n');
    assert.equal(authority.verifyAuditChain().ok, false);
});

// ---------------------------------------------------------------------------
// Constantes y guards del constructor
// ---------------------------------------------------------------------------

test('GATE1/GATE2 nunca están en la lista delegable en código', () => {
    for (const g of grants.PERMANENTLY_NON_DELEGABLE_GATE_CLASSES) {
        assert.equal(grants.DELEGABLE_GATE_CLASSES.includes(g), false);
        assert.equal(grants.isDelegableGateClass(g), false);
    }
    assert.equal(grants.isDelegableGateClass('realign-allowlist'), true);
    assert.equal(grants.isDelegableGateClass(42), false);
});

test('createGrantAuthority falla cerrado si falta la versión activa o su secreto', () => {
    assert.throws(() => grants.createGrantAuthority({ secrets: SECRETS }), /activeSecretVersion/);
    assert.throws(() => grants.createGrantAuthority({ secrets: SECRETS, activeSecretVersion: '' }), /activeSecretVersion/);
    assert.throws(() => grants.createGrantAuthority({ secrets: SECRETS, activeSecretVersion: '9' }), /versión activa/);
});

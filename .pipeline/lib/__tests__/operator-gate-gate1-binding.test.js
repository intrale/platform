// =============================================================================
// Tests operator-gate — #6207 · `channel_gate` persistido, ruteo y revocación.
//
// Cubre:
//   CA-SEC-6 — tras re-emitir el teclado, los ids anteriores resuelven a
//              `unknown-id`: un episodio = un juego de botones vivos.
//   D-1      — `classifyCallback` devuelve `gate-signature` para bindings con
//              `channel_gate: 'definicion'` y `gate` para los legacy.
//   CA-SEC-1 — `handleSignature` RECHAZA sin consumir un binding con
//              `channel_gate`: el fallback nunca puede ser el camino que mueve
//              work-files.
//
// El teclado se construye con el builder REAL (`gate1-signature-keyboard`), no
// replicando su secuencia: eso es lo que este archivo tiene que probar.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const operatorGate = require('../operator-gate');
const keyboard = require('../gate1-signature-keyboard');
const actionToken = require('../action-token');

// Material de firma del signer hermético. No es una credencial: el signer real
// resuelve el suyo desde `credentials.js` y nunca sale del proceso.
const CLAVE_DE_PRUEBA = 'material-hmac-de-prueba-6207-binding';
const OPERATOR = '55501';
const ISSUE = 6207;

function mkGate() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate1-bind-'));
    const gate = operatorGate.createOperatorGate({
        pipelineDir: dir,
        operatorAllowlist: new Set([OPERATOR]),
        signer: actionToken.createTokenSigner({
            secret: CLAVE_DE_PRUEBA,
            nonceFile: path.join(dir, 'audit', 'tokens.jsonl'),
        }),
    });
    return {
        gate, dir,
        storeDir: path.join(dir, 'operator-gate', 'pending'),
        cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { } },
    };
}

/** Ids de los tres botones del teclado emitido por el builder real. */
function idsDelTeclado(kb) {
    return kb.keyboard.inline_keyboard[0].map(b => b.callback_data);
}

// -----------------------------------------------------------------------------
// D-1 · el `channel_gate` se persiste y decide el ruteo
// -----------------------------------------------------------------------------

test('D-1: register persiste `channel_gate` y classifyCallback devuelve gate-signature', () => {
    const env = mkGate();
    try {
        const r = env.gate.register({ issue: ISSUE, action: 'approve', channelGate: 'definicion' });
        assert.equal(r.channelGate, 'definicion');

        const entry = env.gate.resolve(r.callbackData);
        assert.equal(entry.channel_gate, 'definicion', 'queda PERSISTIDO server-side');
        assert.equal(entry.kind, 'gate', 'y el `kind` de #5458 se conserva');

        assert.equal(env.gate.classifyCallback(r.callbackData), 'gate-signature');
    } finally { env.cleanup(); }
});

test('D-1: un binding legacy (sin channel_gate) sigue clasificando como `gate`', () => {
    const env = mkGate();
    try {
        const legacy = env.gate.register({ issue: ISSUE, action: 'approve' });
        assert.equal(legacy.channelGate, null);
        assert.equal(env.gate.classifyCallback(legacy.callbackData), 'gate',
            'el camino de lifecycle de GATE 0/2 no cambia');
    } finally { env.cleanup(); }
});

test('D-1: `channel_gate` fuera del enum ⇒ null (fail-closed), no `gate`', () => {
    const env = mkGate();
    try {
        // Store manipulado: alguien escribe un `channel_gate` inventado.
        const r = env.gate.register({ issue: ISSUE, action: 'approve' });
        const file = path.join(env.storeDir, `${r.callbackData}.json`);
        const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const basura of ['lifecycle', 'DEFINICION', '../definicion', 42, {}, true]) {
            fs.writeFileSync(file, JSON.stringify({ ...entry, channel_gate: basura }), 'utf8');
            assert.equal(env.gate.classifyCallback(r.callbackData), null,
                `channel_gate ${JSON.stringify(basura)} no puede clasificar`);
        }
    } finally { env.cleanup(); }
});

test('D-1: `aceptacion` todavía no tiene adaptador ⇒ no se rutea a lifecycle', () => {
    const env = mkGate();
    try {
        const r = env.gate.register({ issue: ISSUE, action: 'approve', channelGate: 'aceptacion' });
        assert.equal(env.gate.classifyCallback(r.callbackData), null,
            'clasificarlo como `gate` lo mandaría a applyTransition, que es el ejecutor equivocado');
    } finally { env.cleanup(); }
});

test('register RECHAZA un channelGate fuera del enum (el typo duele acá, no en el click)', () => {
    const env = mkGate();
    try {
        for (const bad of ['lifecycle', 'DEFINICION', 'definicion ', 42, {}]) {
            assert.throws(
                () => env.gate.register({ issue: ISSUE, action: 'approve', channelGate: bad }),
                /channelGate inválido/,
                `channelGate ${JSON.stringify(bad)} debería lanzar`,
            );
        }
    } finally { env.cleanup(); }
});

// -----------------------------------------------------------------------------
// CA-SEC-1 · defensa en profundidad en handleSignature
// -----------------------------------------------------------------------------

test('CA-SEC-1: handleSignature rechaza un binding con channel_gate SIN consumirlo', () => {
    const env = mkGate();
    try {
        const r = env.gate.register({ issue: ISSUE, action: 'approve', channelGate: 'definicion' });
        const res = env.gate.handleSignature({ operatorId: OPERATOR, callbackData: r.callbackData });

        assert.equal(res.ok, false);
        assert.equal(res.reason, 'not-a-lifecycle-binding');
        assert.equal(res.editMessage, false);
        assert.ok(env.gate.resolve(r.callbackData), 'la capability sigue viva para su handler');
    } finally { env.cleanup(); }
});

test('CA-SEC-1: un `channel_gate` basura tampoco cae al camino de lifecycle', () => {
    const env = mkGate();
    try {
        const r = env.gate.register({ issue: ISSUE, action: 'approve' });
        const file = path.join(env.storeDir, `${r.callbackData}.json`);
        const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
        fs.writeFileSync(file, JSON.stringify({ ...entry, channel_gate: 'inventado' }), 'utf8');

        const res = env.gate.handleSignature({ operatorId: OPERATOR, callbackData: r.callbackData });
        assert.equal(res.ok, false);
        assert.equal(res.reason, 'not-a-lifecycle-binding');
    } finally { env.cleanup(); }
});

test('un binding de lifecycle legítimo SIGUE funcionando (sin regresión de GATE 0/2)', () => {
    const env = mkGate();
    try {
        const r = env.gate.register({ issue: ISSUE, action: 'approve' });
        const res = env.gate.handleSignature({ operatorId: OPERATOR, callbackData: r.callbackData });
        // No hay ítem en `waiting-operator/`, así que la transición reporta
        // `not-found` — pero el camino se recorrió y la firma se auditó, que es
        // lo que este test cuida: la guarda nueva no rompe el gate viejo.
        assert.equal(res.ok, true);
        assert.equal(res.transitioned, false);
        assert.equal(res.action, 'approve');
    } finally { env.cleanup(); }
});

// -----------------------------------------------------------------------------
// CA-SEC-6 · revocación del episodio anterior
// -----------------------------------------------------------------------------

test('CA-SEC-6: re-emitir el teclado invalida los ids del aviso anterior', () => {
    const env = mkGate();
    try {
        const primero = keyboard.buildGate1SignatureKeyboard(ISSUE, { gateFactory: () => env.gate });
        assert.equal(primero.ok, true, `el teclado debía emitirse: ${primero.code}`);
        const idsViejos = idsDelTeclado(primero);
        assert.equal(idsViejos.length, 3);

        const segundo = keyboard.buildGate1SignatureKeyboard(ISSUE, { gateFactory: () => env.gate });
        assert.equal(segundo.ok, true);
        const idsNuevos = idsDelTeclado(segundo);

        for (const viejo of idsViejos) {
            assert.equal(env.gate.resolve(viejo), null, 'el botón del aviso anterior ya no resuelve');
            assert.equal(env.gate.classifyCallback(viejo), null, 'y no se puede clasificar');
        }
        for (const nuevo of idsNuevos) {
            assert.ok(env.gate.resolve(nuevo), 'los botones nuevos sí');
            assert.equal(env.gate.classifyCallback(nuevo), 'gate-signature');
        }
        assert.equal(fs.readdirSync(env.storeDir).length, 3,
            'un episodio = tres bindings vivos, no seis');
    } finally { env.cleanup(); }
});

test('CA-SEC-6: veinte recordatorios no dejan sesenta capabilities en disco', () => {
    const env = mkGate();
    try {
        for (let i = 0; i < 20; i++) {
            const kb = keyboard.buildGate1SignatureKeyboard(ISSUE, { gateFactory: () => env.gate });
            assert.equal(kb.ok, true);
        }
        assert.equal(fs.readdirSync(env.storeDir).length, 3);
    } finally { env.cleanup(); }
});

test('revokeFor sólo toca el par (issue, channelGate) — no barre bindings ajenos', () => {
    const env = mkGate();
    try {
        const mio = env.gate.register({ issue: ISSUE, action: 'approve', channelGate: 'definicion' });
        const otroIssue = env.gate.register({ issue: 9999, action: 'approve', channelGate: 'definicion' });
        const lifecycle = env.gate.register({ issue: ISSUE, action: 'approve' });
        const operacional = env.gate.register({ issue: ISSUE, action: 'vault-cut-fallback' });

        const res = env.gate.revokeFor({ issue: ISSUE, channelGate: 'definicion' });
        assert.equal(res.revoked, 1);

        assert.equal(env.gate.resolve(mio.callbackData), null, 'el propio se revoca');
        assert.ok(env.gate.resolve(otroIssue.callbackData), 'el de otro issue sobrevive');
        assert.ok(env.gate.resolve(lifecycle.callbackData), 'el de lifecycle sobrevive');
        assert.ok(env.gate.resolve(operacional.callbackData), 'el operacional sobrevive');
    } finally { env.cleanup(); }
});

test('revokeFor con entradas inválidas no borra nada y no lanza', () => {
    const env = mkGate();
    try {
        const vivo = env.gate.register({ issue: ISSUE, action: 'approve', channelGate: 'definicion' });
        for (const p of [
            {}, { issue: ISSUE }, { channelGate: 'definicion' },
            { issue: ISSUE, channelGate: null },
            { issue: ISSUE, channelGate: 'inventado' },
            { issue: '../../etc', channelGate: 'definicion' },
            { issue: -1, channelGate: 'definicion' },
        ]) {
            const r = env.gate.revokeFor(p);
            assert.equal(r.revoked, 0, `revokeFor(${JSON.stringify(p)}) no debe borrar nada`);
        }
        assert.equal(env.gate.revokeFor().revoked, 0, 'sin argumentos tampoco lanza ni borra');
        assert.ok(env.gate.resolve(vivo.callbackData), 'el binding legítimo sigue vivo');
    } finally { env.cleanup(); }
});

test('revokeFor con un store ausente devuelve 0 sin lanzar', () => {
    const env = mkGate();
    try {
        // Nunca se registró nada: el storeDir ni existe.
        assert.equal(env.gate.revokeFor({ issue: ISSUE, channelGate: 'definicion' }).revoked, 0);
    } finally { env.cleanup(); }
});

test('el teclado emitido lleva los tres botones con callback_data opaco', () => {
    const env = mkGate();
    try {
        const kb = keyboard.buildGate1SignatureKeyboard(ISSUE, { gateFactory: () => env.gate });
        const fila = kb.keyboard.inline_keyboard[0];
        assert.equal(fila.length, 3);
        for (const boton of fila) {
            // A08: el `callback_data` es un id opaco, jamás la transición.
            assert.match(boton.callback_data, /^[a-f0-9]{16}$/);
            assert.doesNotMatch(boton.callback_data, /approve|reject|6207/);
        }
    } finally { env.cleanup(); }
});

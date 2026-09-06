// =============================================================================
// operator-gate-vault-cut-5458.test.js — Despacho operacional AISLADO del
// lifecycle (issue #5458, split de #5452).
//
// El CA central del split: `vault-cut-fallback` comparte la capability
// criptográfica del canal de firma (id opaco → HMAC → nonce single-use) pero NO
// comparte el ejecutor. Este archivo cementa el aislamiento:
//   - la acción NO está en `GATE_ACTIONS`
//   - `handleSignature()` la RECHAZA (ahí abajo vive `applyTransition()`)
//   - `applyTransition()` la rechaza aunque la llamen directo
//   - CERO renames / CERO work-files movidos en el camino operacional
//   - `handleOperationalCallback()` es terminal e idempotente
//   - firmante removido, HMAC inválido, expiración, replay y acción alterada
//     fallan CERRADO y el efecto NO se ejecuta
//   - las respuestas no exponen token, nonce, chat id ni paths (canarios)
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    createOperatorGate, GATE_ACTIONS, OPERATIONAL_ACTIONS, actionKind,
} = require('../operator-gate');
const { createTokenSigner } = require('../action-token');

const ACTION = 'vault-cut-fallback';
const OPERATOR = '111222333';
const OTHER = '999888777';
const SECRET = 'test-secret-5458';

/**
 * Gate hermético con dirs temporales. `allowlistResolver` es mutable para poder
 * simular que el firmante se remueve ENTRE la publicación del botón y el toque.
 */
function makeGate(overrides = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opgate-5458-'));
    const dirs = {
        root,
        storeDir: path.join(root, 'store'),
        waitingDir: path.join(root, 'waiting-operator'),
        approvedDir: path.join(root, 'procesado'),
        rejectedDir: path.join(root, 'pendiente'),
        auditFile: path.join(root, 'audit', 'signatures.jsonl'),
        nonceFile: path.join(root, 'audit', 'tokens-used.jsonl'),
    };
    let clock = 1_000_000;
    const estado = { allow: new Set(overrides.allow || [OPERATOR]) };
    const signer = createTokenSigner({
        secret: SECRET, nonceFile: dirs.nonceFile, ttlMs: 60_000, now: () => clock,
    });
    const gate = createOperatorGate({
        storeDir: dirs.storeDir,
        waitingDir: dirs.waitingDir,
        approvedDir: dirs.approvedDir,
        rejectedDir: dirs.rejectedDir,
        auditFile: dirs.auditFile,
        signer,
        operatorAllowlist: [...estado.allow],
        allowlistResolver: () => estado.allow,
        now: () => clock,
        ...(overrides.gateOpts || {}),
    });
    return {
        gate, dirs, estado,
        advance: (ms) => { clock += ms; },
        // Snapshot de TODO archivo bajo la raíz, para probar "cero movimientos".
        snapshot: () => listarArchivos(root),
    };
}

function listarArchivos(dir) {
    const out = [];
    const walk = (d) => {
        let entradas;
        try { entradas = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of entradas) {
            const full = path.join(d, e.name);
            if (e.isDirectory()) walk(full);
            else out.push(path.relative(dir, full));
        }
    };
    walk(dir);
    return out.sort();
}

/** Ejecutor fake que registra sus invocaciones. */
function fakeExecutor(resultado = { ok: true, status: 'cut' }) {
    const calls = [];
    const fn = (args) => { calls.push(args); return resultado; };
    fn.calls = calls;
    return fn;
}

// --- Aislamiento estructural -------------------------------------------------

test('#5458 `vault-cut-fallback` es operacional y NO es acción de gate', () => {
    assert.ok(OPERATIONAL_ACTIONS.includes(ACTION));
    assert.equal(GATE_ACTIONS.includes(ACTION), false);
    assert.equal(actionKind(ACTION), 'operational');
    for (const a of GATE_ACTIONS) assert.equal(actionKind(a), 'gate');
    assert.equal(actionKind('pausar'), null);
});

test('#5458 applyTransition() rechaza la acción operacional aunque la llamen directo', () => {
    const { gate, snapshot } = makeGate();
    const antes = snapshot();
    const r = gate.applyTransition({ issue: 5458, action: ACTION });
    assert.equal(r.ok, false);
    assert.equal(r.status, 'invalid-action');
    assert.deepEqual(snapshot(), antes, 'no debe tocar ni un archivo');
});

test('#5458 handleSignature() rechaza el binding operacional SIN consumirlo', () => {
    const { gate } = makeGate();
    const { callbackData } = gate.register({ issue: 5458, action: ACTION });

    const r = gate.handleSignature({ operatorId: OPERATOR, callbackData });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'not-a-gate-action');
    // NO se consume: la capability sigue viva para su handler dedicado.
    assert.ok(gate.resolve(callbackData), 'el binding no debe consumirse');
    // Y el handler correcto sí la puede usar después.
    const exec = fakeExecutor();
    const op = gate.handleOperationalCallback({ operatorId: OPERATOR, callbackData, executor: exec });
    assert.equal(op.ok, true);
    assert.equal(exec.calls.length, 1);
});

test('#5458 classifyCallback distingue gate / operacional / desconocido', () => {
    const { gate } = makeGate();
    const op = gate.register({ issue: 5458, action: ACTION });
    const gt = gate.register({ issue: 5458, action: 'approve' });
    assert.equal(gate.classifyCallback(op.callbackData), 'operational');
    assert.equal(gate.classifyCallback(gt.callbackData), 'gate');
    assert.equal(gate.classifyCallback('deadbeefdeadbeef'), null);
    assert.equal(gate.classifyCallback('../../etc/passwd'), null);
    assert.equal(gate.classifyCallback(undefined), null);
    // Clasificar NO consume nada.
    assert.ok(gate.resolve(op.callbackData));
});

test('#5458 un store manipulado no puede disfrazar un gate de acción operacional', () => {
    const { gate, dirs } = makeGate();
    const { callbackData } = gate.register({ issue: 5458, action: 'approve' });
    const file = path.join(dirs.storeDir, `${callbackData}.json`);
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    entry.kind = 'operational'; // el `kind` miente; la acción sigue siendo de gate
    fs.writeFileSync(file, JSON.stringify(entry));
    assert.equal(gate.classifyCallback(callbackData), null, 'kind incoherente → fail-closed');
    const r = gate.handleOperationalCallback({ operatorId: OPERATOR, callbackData, executor: fakeExecutor() });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'not-an-operational-action');
});

// --- Camino feliz: cero lifecycle -------------------------------------------

test('#5458 corte exitoso: ejecuta el executor y NO mueve un solo work-file', () => {
    const { gate, dirs, snapshot } = makeGate();
    // Se siembra un ítem en waiting-operator: si algo llamara applyTransition,
    // este archivo se movería y el snapshot lo delataría.
    fs.mkdirSync(dirs.waitingDir, { recursive: true });
    fs.writeFileSync(path.join(dirs.waitingDir, '5458.json'), '{"issue":5458}');

    const { callbackData } = gate.register({ issue: 5458, action: ACTION });
    const antes = snapshot();
    const exec = fakeExecutor({ ok: true, status: 'cut' });
    const r = gate.handleOperationalCallback({ operatorId: OPERATOR, callbackData, executor: exec });

    assert.equal(r.ok, true);
    assert.equal(r.status, 'cut');
    assert.equal(r.action, ACTION);
    assert.equal(r.issue, 5458);
    assert.equal(r.editMessage, true, 'la respuesta debe ser terminal (quita botones)');
    assert.match(r.toast, /Confirmado/);

    // El ejecutor recibió el binding SALIDO DEL TOKEN verificado.
    assert.equal(exec.calls.length, 1);
    assert.equal(exec.calls[0].issue, 5458);
    assert.equal(exec.calls[0].action, ACTION);

    // El ítem de waiting-operator sigue exactamente donde estaba.
    assert.ok(fs.existsSync(path.join(dirs.waitingDir, '5458.json')));
    assert.equal(fs.existsSync(path.join(dirs.approvedDir, '5458.json')), false);
    assert.equal(fs.existsSync(path.join(dirs.rejectedDir, '5458.json')), false);

    // Los únicos archivos nuevos son audit/nonce/claim; ninguno de lifecycle.
    const nuevos = snapshot().filter((f) => !antes.includes(f));
    for (const f of nuevos) {
        assert.ok(f.startsWith('audit'), `archivo inesperado fuera de audit/: ${f}`);
    }
    // Y el binding opaco se consumió (respuesta terminal).
    assert.equal(gate.resolve(callbackData), null);
});

test('#5458 estado ya cortado responde éxito idempotente sin repetir el efecto', () => {
    const { gate } = makeGate();
    const { callbackData } = gate.register({ issue: 5458, action: ACTION });
    const exec = fakeExecutor({ ok: true, status: 'already-cut' });
    const r = gate.handleOperationalCallback({ operatorId: OPERATOR, callbackData, executor: exec });
    assert.equal(r.ok, true);
    assert.equal(r.status, 'already-cut');
    assert.match(r.toast, /Ya estaba aplicado/);
    assert.equal(exec.calls.length, 1);
});

test('#5458 un SEGUNDO toque del mismo botón no vuelve a ejecutar (terminal)', () => {
    const { gate } = makeGate();
    const { callbackData } = gate.register({ issue: 5458, action: ACTION });
    const exec = fakeExecutor();
    const primero = gate.handleOperationalCallback({ operatorId: OPERATOR, callbackData, executor: exec });
    const segundo = gate.handleOperationalCallback({ operatorId: OPERATOR, callbackData, executor: exec });
    assert.equal(primero.ok, true);
    assert.equal(segundo.ok, false);
    assert.equal(segundo.reason, 'unknown-id');
    assert.equal(exec.calls.length, 1, 'el efecto se ejecuta una sola vez');
});

// --- Fallos cerrados ---------------------------------------------------------

test('#5458 firmante REMOVIDO entre la publicación y el toque: no autorizado, sin efecto', () => {
    const ctx = makeGate();
    const { callbackData } = ctx.gate.register({ issue: 5458, action: ACTION });
    // El operador se remueve DESPUÉS de que el botón salió publicado.
    ctx.estado.allow = new Set();
    const exec = fakeExecutor();
    const r = ctx.gate.handleOperationalCallback({ operatorId: OPERATOR, callbackData, executor: exec });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unauthorized');
    assert.equal(exec.calls.length, 0, 'el corte NO se ejecuta');
    assert.equal(r.editMessage, false, 'un no-autorizado no quema el botón legítimo');
    assert.ok(ctx.gate.resolve(callbackData), 'la capability legítima sobrevive');
});

test('#5458 otro usuario del grupo no puede confirmar el corte', () => {
    const { gate } = makeGate();
    const { callbackData } = gate.register({ issue: 5458, action: ACTION });
    const exec = fakeExecutor();
    const r = gate.handleOperationalCallback({ operatorId: OTHER, callbackData, executor: exec });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unauthorized');
    assert.equal(exec.calls.length, 0);
});

test('#5458 allowlist vacía rechaza TODO (fail-closed)', () => {
    const { gate } = makeGate({ allow: [] });
    const { callbackData } = gate.register({ issue: 5458, action: ACTION });
    const exec = fakeExecutor();
    const r = gate.handleOperationalCallback({ operatorId: OPERATOR, callbackData, executor: exec });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unauthorized');
    assert.equal(exec.calls.length, 0);
});

test('#5458 token EXPIRADO no ejecuta el corte', () => {
    const ctx = makeGate();
    const { callbackData } = ctx.gate.register({ issue: 5458, action: ACTION });
    ctx.advance(60 * 60 * 1000); // muy por encima del cap operacional
    const exec = fakeExecutor();
    const r = ctx.gate.handleOperationalCallback({ operatorId: OPERATOR, callbackData, executor: exec });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'expired');
    assert.equal(exec.calls.length, 0);
});

test('#5458 HMAC alterado en el store no ejecuta el corte', () => {
    const { gate, dirs } = makeGate();
    const { callbackData } = gate.register({ issue: 5458, action: ACTION });
    const file = path.join(dirs.storeDir, `${callbackData}.json`);
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    entry.token = entry.token.slice(0, -1) + (entry.token.slice(-1) === 'A' ? 'B' : 'A');
    fs.writeFileSync(file, JSON.stringify(entry));
    const exec = fakeExecutor();
    const r = gate.handleOperationalCallback({ operatorId: OPERATOR, callbackData, executor: exec });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid');
    assert.equal(exec.calls.length, 0);
});

test('#5458 REPLAY (nonce ya consumido) no ejecuta el corte', () => {
    const { gate, dirs } = makeGate();
    const primero = gate.register({ issue: 5458, action: ACTION });
    // Se clona el binding a un segundo id opaco: mismo token, otro botón.
    const clonId = 'aaaabbbbccccdddd';
    const entry = JSON.parse(fs.readFileSync(path.join(dirs.storeDir, `${primero.callbackData}.json`), 'utf8'));
    fs.writeFileSync(path.join(dirs.storeDir, `${clonId}.json`), JSON.stringify({ ...entry, id: clonId }));

    const exec = fakeExecutor();
    assert.equal(gate.handleOperationalCallback({ operatorId: OPERATOR, callbackData: primero.callbackData, executor: exec }).ok, true);
    const r = gate.handleOperationalCallback({ operatorId: OPERATOR, callbackData: clonId, executor: exec });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'replayed');
    assert.equal(exec.calls.length, 1, 'el corte se ejecutó una sola vez');
});

test('#5458 ACCIÓN ALTERADA en el store no redirige el efecto (binding íntegro)', () => {
    const { gate, dirs } = makeGate();
    // Se registra un corte y después se le cambia la acción a otra operacional
    // inexistente / a una de gate — el token firmado sigue diciendo la original.
    const { callbackData } = gate.register({ issue: 5458, action: ACTION });
    const file = path.join(dirs.storeDir, `${callbackData}.json`);
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    entry.issue = 9999; // se intenta redirigir el corte a otro issue
    fs.writeFileSync(file, JSON.stringify(entry));
    const exec = fakeExecutor();
    const r = gate.handleOperationalCallback({ operatorId: OPERATOR, callbackData, executor: exec });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'binding-mismatch');
    assert.equal(exec.calls.length, 0);
});

test('#5458 sin ejecutor disponible el fallback se conserva (fail-closed)', () => {
    const { gate } = makeGate();
    const { callbackData } = gate.register({ issue: 5458, action: ACTION });
    const r = gate.handleOperationalCallback({ operatorId: OPERATOR, callbackData });
    assert.equal(r.ok, false);
    assert.equal(r.status, 'executor-unavailable');
    assert.match(r.toast, /fallback se conserva/);
});

test('#5458 ejecutor que explota no reporta éxito ni filtra el error', () => {
    const { gate } = makeGate();
    const { callbackData } = gate.register({ issue: 5458, action: ACTION });
    const r = gate.handleOperationalCallback({
        operatorId: OPERATOR, callbackData,
        executor: () => { throw new Error('ENOSPC: no space left on device, open C:\\Users\\Administrator\\secreto'); },
    });
    assert.equal(r.ok, false);
    assert.match(r.toast, /fallback se conserva/);
    assert.doesNotMatch(JSON.stringify(r), /ENOSPC|Administrator|C:\\\\/);
});

test('#5458 cobertura caída: el ejecutor devuelve precondition-failed y no hay éxito', () => {
    const { gate } = makeGate();
    const { callbackData } = gate.register({ issue: 5458, action: ACTION });
    const r = gate.handleOperationalCallback({
        operatorId: OPERATOR, callbackData,
        executor: () => ({ ok: false, status: 'precondition-failed' }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.status, 'precondition-failed');
    assert.match(r.toast, /condiciones del corte ya no se cumplen/);
});

test('#5459 espera al ejecutor async antes de resolver el toast operacional', async () => {
    const { gate } = makeGate();
    const { callbackData } = gate.register({ issue: 5459, action: ACTION });
    let applied = false;
    const pending = gate.handleOperationalCallback({
        operatorId: OPERATOR,
        callbackData,
        executor: async () => {
            await new Promise((resolve) => setImmediate(resolve));
            applied = true;
            return { ok: true, status: 'cut' };
        },
    });
    assert.equal(typeof pending.then, 'function');
    assert.equal(applied, false);
    const result = await pending;
    assert.equal(applied, true);
    assert.equal(result.status, 'cut');
    assert.match(result.toast, /aplicado/);
});

// --- Auditoría y sanitización ------------------------------------------------

test('#5458 la auditoría registra el corte y NO contiene token ni firma', () => {
    const { gate, dirs } = makeGate();
    const { callbackData, token } = gate.register({ issue: 5458, action: ACTION });
    gate.handleOperationalCallback({ operatorId: OPERATOR, callbackData, executor: fakeExecutor() });

    const raw = fs.readFileSync(dirs.auditFile, 'utf8');
    const filas = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(filas.length >= 2, 'audit antes y después del efecto');
    const resultados = filas.map((f) => f.result);
    assert.ok(resultados.includes('accepted-before-operational-execution'));
    assert.ok(resultados.includes('cut'));
    // Ninguna fila lleva el token completo ni la firma. (El `nonce` y el actor
    // SÍ se registran: es el audit interno hash-chained de #4579, cuyo objetivo
    // es la accountability — no es la respuesta que ve el operador.)
    assert.equal(raw.includes(token), false);
    assert.equal(raw.includes(token.split('.')[2]), false);
    // Y todas son de la acción operacional, sin gate de lifecycle.
    for (const f of filas) {
        assert.equal(f.action, ACTION);
        assert.equal(f.gate, null);
    }
    // La cadena sigue íntegra tras las firmas operacionales.
    const { verifyChain } = require('../audit-log');
    assert.equal(verifyChain({ file: dirs.auditFile }).ok, true);
});

test('#5458 ningún toast expone token, nonce, chat id ni paths', () => {
    const { gate, dirs } = makeGate();
    const registro = gate.register({ issue: 5458, action: ACTION });
    const entry = JSON.parse(fs.readFileSync(path.join(dirs.storeDir, `${registro.callbackData}.json`), 'utf8'));
    const nonce = JSON.parse(Buffer.from(
        entry.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')).n;

    const toasts = [
        gate.handleOperationalCallback({ operatorId: OTHER, callbackData: registro.callbackData, executor: fakeExecutor() }).toast,
        gate.handleOperationalCallback({ operatorId: OPERATOR, callbackData: 'ffffffffffffffff', executor: fakeExecutor() }).toast,
        gate.handleOperationalCallback({ operatorId: OPERATOR, callbackData: registro.callbackData, executor: fakeExecutor() }).toast,
        ...OPERATIONAL_ACTIONS.map((a) => gate.operationalToast('unavailable', a)),
    ];
    for (const t of toasts) {
        assert.equal(typeof t, 'string');
        assert.ok(t.length > 0, 'siempre hay toast: el spinner se corta en todos los caminos');
        assert.equal(t.includes(entry.token), false);
        assert.equal(t.includes(nonce), false);
        assert.equal(t.includes(OPERATOR), false);
        assert.equal(t.includes(OTHER), false);
        assert.equal(t.includes(dirs.root), false);
        assert.doesNotMatch(t, /[A-Za-z]:\\|\/home\/|\/Users\/|arn:aws/);
    }
});

test('#5458 el toast operacional nunca usa el copy de `ajuste-definicion`', () => {
    const { gate } = makeGate();
    const { callbackData } = gate.register({ issue: 5458, action: ACTION });
    const r = gate.handleOperationalCallback({ operatorId: OPERATOR, callbackData, executor: fakeExecutor() });
    assert.doesNotMatch(r.toast, /definici/i);
    assert.doesNotMatch(r.toast, /Rechazado|Aprobado —/);
});

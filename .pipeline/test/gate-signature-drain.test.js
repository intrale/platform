// =============================================================================
// gate-signature-drain.test.js — Drenador de `gate-signature/pendiente` (#6208).
//
// Cubre los CAs del Bloque 2/3 de #6208:
//   CA-6  — el drenador existe y procesa lo encolado.
//   CA-7  — idempotente: un pedido → exactamente un efecto y un registro.
//   CA-8  — tolera basura sin caerse (aísla y sigue).
//   CA-9  — NO drena la cola equivocada (BLOQUEANTE · riesgo de pérdida de datos).
//   CA-11 — un pedido sin pendiente en el depósito es terminal y no revierte nada.
//   CA-12 / REQ-SEC-6208-2 — el dashboard encola, no firma: ningún campo en
//           banda (`actor`) deriva autoridad, y `submitSignature` NUNCA se llama.
//   CA-14 / REQ-SEC-6208-3 — `gate` se resuelve con el kernel, fail-closed y
//           antes de tocar el filesystem.
//   D-1   — sin carrier conectado el pedido queda en `pendiente/`, nunca firmado.
//
// Estrategia: tmpdir aislado por test. El depósito se siembra por el camino del
// KERNEL (`approval-channel.requestSignature`), nunca escribiendo el `.json` a
// mano — con signer inyectado para no depender del vault.
//
// Se ejecuta con: node --test .pipeline/test/gate-signature-drain.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const drainer = require('../lib/gate-signature-drainer');
const channel = require('../lib/approval-channel');
const actionToken = require('../lib/action-token');
const gsr = require('../lib/gate-signature-request');

const SECRET = 'secreto-de-test-6208';
const BODY = '## Criterios\n\n- [ ] CA-1 la bandeja muestra los pendientes reales\n';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function mkEnv() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-'));
    const depositDir = path.join(dir, 'approval-channel', 'pendiente');
    const queueDir = path.join(dir, 'gate-signature', 'pendiente');
    const dispatchedDir = path.join(dir, 'gate-signature', 'despachado');
    const processedDir = path.join(dir, 'gate-signature', 'procesado');
    const auditFile = path.join(dir, 'audit', 'gate-signature-drainer.jsonl');
    fs.mkdirSync(queueDir, { recursive: true });
    fs.mkdirSync(path.join(dir, 'audit'), { recursive: true });

    const channelDeps = {
        depositDir,
        auditFile: path.join(dir, 'audit', 'approval-channel.jsonl'),
        rejectFile: path.join(dir, 'audit', 'approval-channel-rejects.jsonl'),
        rateFile: path.join(dir, 'approval-channel', '.reject-rate.json'),
        signer: actionToken.createTokenSigner({
            secret: SECRET,
            nonceFile: path.join(dir, 'audit', 'canal-tokens.jsonl'),
        }),
        env: { TELEGRAM_LEO_OPERATOR_CHAT_ID: '12345678' },
        config: {
            operator_signoff: { enabled: true, gate_mode: 'dry-run' },
            operator_signature: { enabled: true, gate_mode: 'dry-run' },
            cua: { operator_chat_ids: [] },
        },
        writerPipelineDir: dir,
    };

    return { dir, depositDir, queueDir, dispatchedDir, processedDir, auditFile, channelDeps };
}

/** Siembra un pendiente REAL por el camino del kernel (nunca a mano). */
function seedPending(env, issue, gate = 'definicion') {
    const res = channel.requestSignature(
        {
            gate,
            issue,
            body: BODY,
            // El gate `aceptacion` ancla contra un commit-sha, no contra el body.
            commit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
            titleText: 'Bandeja de firma',
            evidence: [{ kind: 'issue', ref: '6199' }],
        },
        env.channelDeps,
    );
    assert.equal(res.ok, true, `no se pudo sembrar el pendiente: ${res.reason || ''}`);
    return res;
}

/** Encola un pedido por el camino del adaptador (`enqueueDecision`). */
function enqueue(env, args, now = Date.now()) {
    const out = gsr.enqueueDecision(args, {
        queueDir: env.queueDir,
        auditFile: path.join(env.dir, 'audit', 'gate-signature-requests.jsonl'),
        now: () => now,
    });
    assert.equal(out.ok, true, `no se pudo encolar: ${out.msg || ''}`);
    return out;
}

function opts(env) {
    return {
        queueDir: env.queueDir,
        dispatchedDir: env.dispatchedDir,
        processedDir: env.processedDir,
        auditFile: env.auditFile,
    };
}

/** Carrier de test: acepta siempre y cuenta las llamadas. */
function fakeCarrier() {
    const calls = [];
    const fn = (intent) => {
        calls.push(intent);
        return { ok: true, carrier: 'telegram', dispatched_at: 1700000000000 };
    };
    fn.calls = calls;
    return fn;
}

/**
 * `approvalImpl` con espía sobre `submitSignature`. El drenador NO debe
 * invocarlo jamás (D-1 / R3): el token con binding `(g,h)` no está en el
 * depósito a propósito, así que un drenador que firmara se rechazaría siempre.
 */
function spiedChannel() {
    const submitCalls = [];
    return {
        spy: submitCalls,
        impl: {
            listPending: channel.listPending,
            isValidIssueId: channel.isValidIssueId,
            resolveGate: channel.resolveGate,
            DEFAULT_DEPOSIT_DIR: channel.DEFAULT_DEPOSIT_DIR,
            submitSignature: (...a) => { submitCalls.push(a); throw new Error('el drenador NO debe firmar'); },
        },
    };
}

function drain(env, extraDeps = {}) {
    return drainer.drainGateSignatureQueue(opts(env), {
        approvalDeps: env.channelDeps,
        ...extraDeps,
    });
}

function readAudit(env) {
    if (!fs.existsSync(env.auditFile)) return [];
    return fs.readFileSync(env.auditFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

// -----------------------------------------------------------------------------
// CA-6 / CA-7 — drena un pedido válido y lo despacha exactamente una vez
// -----------------------------------------------------------------------------
test('drena un pedido válido y lo mueve a despachado exactamente una vez (CA-6, CA-7)', () => {
    const env = mkEnv();
    seedPending(env, 6208);
    enqueue(env, { issue: 6208, gate: 'definicion', decision: 'signed' });

    const carrier = fakeCarrier();
    const out = drain(env, { dispatchToCarrier: carrier });

    assert.equal(out.dispatched.length, 1);
    assert.equal(out.dispatched[0].issue, 6208);
    assert.equal(out.dispatched[0].gate, 'definicion');
    assert.equal(out.dispatched[0].verdict, 'signed');
    assert.equal(carrier.calls.length, 1);
    // Marker de despacho SIN timestamp: esa es la clave de idempotencia.
    assert.ok(fs.existsSync(path.join(env.dispatchedDir, '6208-definicion.json')));
    // El pedido salió de `pendiente/` y quedó en `procesado/`.
    assert.equal(fs.readdirSync(env.queueDir).filter(f => f.endsWith('.json')).length, 0);
    assert.equal(fs.readdirSync(env.processedDir).filter(f => f.endsWith('.json')).length, 1);
});

test('drenar dos veces el mismo (issue, gate) produce un único efecto y un único registro de audit (CA-7)', () => {
    const env = mkEnv();
    seedPending(env, 6208);
    enqueue(env, { issue: 6208, gate: 'definicion', decision: 'signed' }, 1000);

    const carrier = fakeCarrier();
    drain(env, { dispatchToCarrier: carrier });
    // Segundo pedido vivo del mismo (issue, gate): se supersede, no se re-despacha.
    enqueue(env, { issue: 6208, gate: 'definicion', decision: 'rejected' }, 2000);
    const out2 = drain(env, { dispatchToCarrier: carrier });

    assert.equal(carrier.calls.length, 1, 'el carrier se invoca UNA sola vez');
    assert.equal(out2.dispatched.length, 0);
    assert.equal(out2.superseded.length, 1);
    const dispatchedAudits = readAudit(env).filter(e => e.outcome === 'dispatched');
    assert.equal(dispatchedAudits.length, 1, 'un único registro de despacho en el audit');
});

test('dos pedidos del mismo (issue, gate) en la MISMA pasada despachan una sola vez (CA-7)', () => {
    const env = mkEnv();
    seedPending(env, 6208);
    enqueue(env, { issue: 6208, gate: 'definicion', decision: 'signed' }, 1000);
    enqueue(env, { issue: 6208, gate: 'definicion', decision: 'rejected' }, 2000);

    const carrier = fakeCarrier();
    const out = drain(env, { dispatchToCarrier: carrier });

    assert.equal(carrier.calls.length, 1);
    assert.equal(out.dispatched.length, 1);
    assert.equal(out.superseded.length, 1);
});

// -----------------------------------------------------------------------------
// CA-8 — tolera basura sin caerse
// -----------------------------------------------------------------------------
test('un archivo corrupto se aísla y el pedido sano de la misma pasada se procesa (CA-8)', () => {
    const env = mkEnv();
    seedPending(env, 6208);
    fs.writeFileSync(path.join(env.queueDir, '0000-corrupto.json'), '{ esto no es json', 'utf8');
    fs.writeFileSync(path.join(env.queueDir, '0001-vacio.json'), '', 'utf8');
    enqueue(env, { issue: 6208, gate: 'definicion', decision: 'signed' });

    const carrier = fakeCarrier();
    const out = drain(env, { dispatchToCarrier: carrier });

    assert.equal(out.dispatched.length, 1, 'el pedido sano de la misma pasada se procesa');
    assert.equal(out.rejected.filter(r => r.reason === 'unparseable').length, 2);
    // Los corruptos quedaron aislados en `procesado/`, no en la cola.
    assert.ok(fs.existsSync(path.join(env.processedDir, '0000-corrupto.json')));
    assert.ok(fs.existsSync(path.join(env.processedDir, '0001-vacio.json')));
});

test('un archivo que no es un pedido de firma NO se toca (otro tipo se ignora)', () => {
    const env = mkEnv();
    const ajeno = path.join(env.queueDir, 'ajeno.json');
    fs.writeFileSync(ajeno, JSON.stringify({ type: 'otro_tipo', issue: 1 }), 'utf8');

    drain(env, { dispatchToCarrier: fakeCarrier() });

    assert.ok(fs.existsSync(ajeno), 'el archivo ajeno sigue donde estaba');
});

test('el drenador nunca lanza al bucle de servicios con una cola inexistente (fail-open)', () => {
    const env = mkEnv();
    fs.rmSync(env.queueDir, { recursive: true, force: true });
    const out = drain(env, { dispatchToCarrier: fakeCarrier() });
    assert.deepEqual(out.dispatched, []);
    assert.deepEqual(out.errors, []);
});

// -----------------------------------------------------------------------------
// CA-9 — NO drena la cola equivocada (BLOQUEANTE)
// -----------------------------------------------------------------------------
test('tras una pasada completa, los archivos de approval-channel/pendiente siguen intactos (CA-9)', () => {
    const env = mkEnv();
    seedPending(env, 6208);
    seedPending(env, 6199);
    const antes = fs.readdirSync(env.depositDir).sort();
    const hashes = antes.map(f => fs.readFileSync(path.join(env.depositDir, f), 'utf8'));

    enqueue(env, { issue: 6208, gate: 'definicion', decision: 'signed' });
    drain(env, { dispatchToCarrier: fakeCarrier() });

    const despues = fs.readdirSync(env.depositDir).sort();
    assert.deepEqual(despues, antes, 'el depósito del kernel NO se toca');
    despues.forEach((f, i) => {
        assert.equal(fs.readFileSync(path.join(env.depositDir, f), 'utf8'), hashes[i]);
    });
});

test('un queueDir que apunta al depósito del kernel aborta ANTES de leer (CA-9)', () => {
    const env = mkEnv();
    seedPending(env, 6208);
    const antes = fs.readdirSync(env.depositDir);

    assert.throws(
        () => drainer.drainGateSignatureQueue(
            { ...opts(env), queueDir: env.depositDir },
            { approvalDeps: env.channelDeps, dispatchToCarrier: fakeCarrier() },
        ),
        /dep[óo]sito del kernel/i,
    );
    assert.deepEqual(fs.readdirSync(env.depositDir), antes, 'nada se borró del depósito');
});

test('assertNotKernelDeposit rechaza también un subdirectorio del depósito', () => {
    assert.throws(
        () => drainer.assertNotKernelDeposit(path.join('/tmp/dep', 'sub'), '/tmp/dep'),
        /dep[óo]sito del kernel/i,
    );
    assert.doesNotThrow(() => drainer.assertNotKernelDeposit('/tmp/cola', '/tmp/dep'));
});

// -----------------------------------------------------------------------------
// CA-12 / REQ-SEC-6208-2 — el dashboard encola, no firma
// -----------------------------------------------------------------------------
test('un pedido con actor de la allowlist NO obtiene autoridad ni produce firma (CA-12)', () => {
    const env = mkEnv();
    seedPending(env, 6208);
    // `actor` es un dato EN BANDA que escribe el cliente: acá se declara el
    // firmante real de la allowlist a ver si le compra la identidad.
    enqueue(env, { issue: 6208, gate: 'definicion', decision: 'signed', actor: '12345678', origen: 'dashboard' });

    const carrier = fakeCarrier();
    const { spy, impl } = spiedChannel();
    const out = drain(env, { dispatchToCarrier: carrier, approvalImpl: impl });

    assert.equal(spy.length, 0, 'submitSignature NUNCA se invoca');
    assert.equal(out.dispatched.length, 1);
    // La intención que viaja al carrier lleva SÓLO los tres campos validados.
    assert.deepEqual(Object.keys(carrier.calls[0]).sort(), ['gate', 'issue', 'pending', 'verdict']);
    assert.equal(carrier.calls[0].issue, 6208);
    assert.ok(!('actor' in carrier.calls[0]), 'el actor en banda NO llega al carrier');
    // El pendiente del depósito sigue ahí: nadie firmó nada.
    assert.ok(fs.existsSync(path.join(env.depositDir, '6208-definicion.json')));
    // El actor declarado queda en el AUDIT (no repudio), no en el camino de autoridad.
    const a = readAudit(env).find(e => e.outcome === 'dispatched');
    assert.equal(a.declared_actor, '12345678');
});

test('el drenador nunca invoca submitSignature (espía inyectado, cero llamadas)', () => {
    const env = mkEnv();
    seedPending(env, 6208);
    seedPending(env, 6199);
    enqueue(env, { issue: 6208, gate: 'definicion', decision: 'signed' }, 1000);
    enqueue(env, { issue: 6199, gate: 'definicion', decision: 'rejected' }, 2000);
    fs.writeFileSync(path.join(env.queueDir, 'basura.json'), 'xx', 'utf8');

    const { spy, impl } = spiedChannel();
    drain(env, { dispatchToCarrier: fakeCarrier(), approvalImpl: impl });

    assert.equal(spy.length, 0);
});

// -----------------------------------------------------------------------------
// CA-14 / REQ-SEC-6208-3 — gate contra el enum congelado
// -----------------------------------------------------------------------------
test('gate de path-traversal y gate inexistente se rechazan sin tocar el filesystem (CA-14)', () => {
    const env = mkEnv();
    seedPending(env, 6208);
    // Pedidos escritos a mano a propósito: `enqueueDecision` ya los rechaza, así
    // que el único modo de probar la defensa del DRENADOR es saltearlo.
    for (const [name, gate] of [['t1.json', '../../../etc'], ['t2.json', 'inexistente'], ['t3.json', 'defini cion']]) {
        fs.writeFileSync(path.join(env.queueDir, name), JSON.stringify({
            type: 'gate_signature_request', issue: 6208, gate, verdict: 'signed', created_at: 1,
        }), 'utf8');
    }

    const carrier = fakeCarrier();
    const out = drain(env, { dispatchToCarrier: carrier });

    assert.equal(carrier.calls.length, 0);
    assert.equal(out.rejected.filter(r => r.reason === 'gate-fuera-del-enum').length, 3);
    // No se creó ningún directorio derivado del gate hostil.
    assert.ok(!fs.existsSync(path.join(env.dispatchedDir, '..', '..', '..', 'etc')));
    assert.ok(!fs.existsSync(env.dispatchedDir) || fs.readdirSync(env.dispatchedDir).length === 0);
});

test('un issue inválido se rechaza sin construir path (REQ-SEC-4580-3)', () => {
    const env = mkEnv();
    fs.writeFileSync(path.join(env.queueDir, 'bad.json'), JSON.stringify({
        type: 'gate_signature_request', issue: '../etc/passwd', gate: 'definicion', verdict: 'signed',
    }), 'utf8');
    const out = drain(env, { dispatchToCarrier: fakeCarrier() });
    assert.equal(out.rejected.filter(r => r.reason === 'issue-invalido').length, 1);
});

test('un veredicto fuera del enum del gate se rechaza (CA-14)', () => {
    const env = mkEnv();
    seedPending(env, 6208, 'aceptacion');
    // `re-definition` NO existe en el gate `aceptacion` (sólo signed | rejected).
    fs.writeFileSync(path.join(env.queueDir, 'x.json'), JSON.stringify({
        type: 'gate_signature_request', issue: 6208, gate: 'aceptacion', verdict: 're-definition',
    }), 'utf8');
    const carrier = fakeCarrier();
    const out = drain(env, { dispatchToCarrier: carrier });
    assert.equal(carrier.calls.length, 0);
    assert.equal(out.rejected.filter(r => r.reason === 'veredicto-fuera-del-enum').length, 1);
});

test('el alias legacy aprobar/rechazar sigue mapeando al veredicto del kernel', () => {
    const env = mkEnv();
    seedPending(env, 6208);
    fs.writeFileSync(path.join(env.queueDir, 'legacy.json'), JSON.stringify({
        type: 'gate_signature_request', issue: 6208, gate: 'definicion', decision: 'aprobar',
    }), 'utf8');
    const carrier = fakeCarrier();
    const out = drain(env, { dispatchToCarrier: carrier });
    assert.equal(out.dispatched.length, 1);
    assert.equal(carrier.calls[0].verdict, 'signed');
});

// -----------------------------------------------------------------------------
// CA-11 — botón viejo: sin pendiente en el depósito es terminal
// -----------------------------------------------------------------------------
test('un pedido sin pendiente en el depósito es terminal y no revierte nada (CA-11)', () => {
    const env = mkEnv();
    seedPending(env, 6208);
    enqueue(env, { issue: 6208, gate: 'definicion', decision: 'signed' });
    // El pendiente se resuelve por OTRO medio antes de que corra el drenador.
    channel.resolvePending(6208, 'definicion', env.channelDeps);

    const carrier = fakeCarrier();
    const out = drain(env, { dispatchToCarrier: carrier });

    assert.equal(carrier.calls.length, 0, 'el botón viejo no produce un segundo efecto');
    assert.equal(out.rejected.filter(r => r.reason === 'no-pending').length, 1);
    assert.equal(fs.readdirSync(env.processedDir).filter(f => f.endsWith('.json')).length, 1);
    // No se recreó nada en el depósito: resolver no se revierte.
    assert.ok(!fs.existsSync(path.join(env.depositDir, '6208-definicion.json')));
});

// -----------------------------------------------------------------------------
// Carrier: fallo recuperable ≠ terminal · D-1: sin carrier no se despacha
// -----------------------------------------------------------------------------
test('un fallo del carrier deja el pedido en pendiente para el próximo ciclo (recuperable ≠ terminal)', () => {
    const env = mkEnv();
    seedPending(env, 6208);
    enqueue(env, { issue: 6208, gate: 'definicion', decision: 'signed' });

    const out = drain(env, { dispatchToCarrier: () => { throw new Error('red caída'); } });

    assert.equal(out.dispatched.length, 0);
    assert.equal(out.errors.length, 1);
    assert.match(out.errors[0].reason, /carrier-failed/);
    assert.equal(fs.readdirSync(env.queueDir).filter(f => f.endsWith('.json')).length, 1, 'sigue en pendiente');
    assert.ok(!fs.existsSync(path.join(env.dispatchedDir, '6208-definicion.json')));

    // Al ciclo siguiente, con el carrier sano, se despacha.
    const carrier = fakeCarrier();
    const out2 = drain(env, { dispatchToCarrier: carrier });
    assert.equal(out2.dispatched.length, 1);
});

test('un carrier que responde ok:false es recuperable, no terminal', () => {
    const env = mkEnv();
    seedPending(env, 6208);
    enqueue(env, { issue: 6208, gate: 'definicion', decision: 'signed' });
    const out = drain(env, { dispatchToCarrier: () => ({ ok: false, reason: 'sin chat' }) });
    assert.equal(out.dispatched.length, 0);
    assert.match(out.errors[0].reason, /carrier-no-ok/);
    assert.equal(fs.readdirSync(env.queueDir).filter(f => f.endsWith('.json')).length, 1);
});

test('D-1: sin carrier conectado el pedido queda en pendiente y NUNCA se marca firmado', () => {
    const env = mkEnv();
    seedPending(env, 6208);
    enqueue(env, { issue: 6208, gate: 'definicion', decision: 'signed' });

    const out = drain(env); // sin `dispatchToCarrier` — el default es null (#6207 abierta).

    assert.equal(out.dispatched.length, 0);
    assert.equal(out.waiting.length, 1);
    assert.equal(fs.readdirSync(env.queueDir).filter(f => f.endsWith('.json')).length, 1);
    assert.ok(!fs.existsSync(env.dispatchedDir) || fs.readdirSync(env.dispatchedDir).length === 0);
    // Y el pendiente del kernel sigue intacto: nadie firmó.
    assert.ok(fs.existsSync(path.join(env.depositDir, '6208-definicion.json')));
});

test('depósito ilegible ⇒ se retiene la cola, no se despacha nada (fail-closed)', () => {
    const env = mkEnv();
    enqueue(env, { issue: 6208, gate: 'definicion', decision: 'signed' });
    const carrier = fakeCarrier();
    const out = drainer.drainGateSignatureQueue(opts(env), {
        approvalDeps: env.channelDeps,
        dispatchToCarrier: carrier,
        approvalImpl: {
            listPending: () => ({ ok: false, pending: [], corrupt: [], degraded: true, alert: 'roto' }),
            isValidIssueId: channel.isValidIssueId,
            resolveGate: channel.resolveGate,
            DEFAULT_DEPOSIT_DIR: channel.DEFAULT_DEPOSIT_DIR,
        },
    });
    assert.equal(carrier.calls.length, 0);
    assert.equal(out.dispatched.length, 0);
    assert.match(out.errors[0].reason, /deposito-ilegible/);
    assert.equal(fs.readdirSync(env.queueDir).filter(f => f.endsWith('.json')).length, 1);
});

// -----------------------------------------------------------------------------
// Contrato del marker de despacho
// -----------------------------------------------------------------------------
test('el marker de despacho lleva el carrier que devolvió el medio, no un literal', () => {
    const env = mkEnv();
    seedPending(env, 6208);
    enqueue(env, { issue: 6208, gate: 'definicion', decision: 'signed' });
    drain(env, { dispatchToCarrier: () => ({ ok: true, carrier: 'signal', dispatched_at: 42 }) });

    const m = JSON.parse(fs.readFileSync(path.join(env.dispatchedDir, '6208-definicion.json'), 'utf8'));
    assert.equal(m.type, 'gate_signature_dispatch');
    assert.equal(m.carrier, 'signal');
    assert.equal(m.dispatched_at, 42);
    assert.equal(m.verdict, 'signed');
});

test('dispatchPathFor contiene el path dentro del directorio de despachos', () => {
    assert.equal(drainer.dispatchKey('6208', 'definicion'), '6208-definicion');
    assert.ok(drainer.dispatchPathFor(path.join(os.tmpdir(), 'd'), 6208, 'definicion').endsWith(`6208-definicion.json`));
});

// -----------------------------------------------------------------------------
// CA-8 — ningún fallo de infra tumba el bucle de servicios
// -----------------------------------------------------------------------------
test('un listPending que EXPLOTA se retiene sin lanzar al bucle de servicios (CA-8)', () => {
    const env = mkEnv();
    enqueue(env, { issue: 6208, gate: 'definicion', decision: 'signed' });
    const carrier = fakeCarrier();
    let out;
    assert.doesNotThrow(() => {
        out = drainer.drainGateSignatureQueue(opts(env), {
            approvalDeps: env.channelDeps,
            dispatchToCarrier: carrier,
            approvalImpl: {
                listPending: () => { throw new Error('depósito ilegible'); },
                isValidIssueId: channel.isValidIssueId,
                resolveGate: channel.resolveGate,
                DEFAULT_DEPOSIT_DIR: channel.DEFAULT_DEPOSIT_DIR,
            },
        });
    });
    assert.equal(carrier.calls.length, 0);
    assert.equal(out.dispatched.length, 0);
    assert.equal(fs.readdirSync(env.queueDir).filter(f => f.endsWith('.json')).length, 1, 'el pedido se retiene');
});

test('si no se puede escribir el marker de despacho, el pedido queda en pendiente (recuperable)', () => {
    const env = mkEnv();
    seedPending(env, 6208);
    enqueue(env, { issue: 6208, gate: 'definicion', decision: 'signed' });

    const carrier = fakeCarrier();
    const fsRoto = Object.create(fs);
    fsRoto.writeFileSync = (p, ...rest) => {
        if (String(p).includes('despachado')) throw new Error('disco lleno');
        return fs.writeFileSync(p, ...rest);
    };
    const out = drainer.drainGateSignatureQueue(opts(env), {
        approvalDeps: env.channelDeps,
        dispatchToCarrier: carrier,
        fsImpl: fsRoto,
    });

    assert.equal(out.dispatched.length, 0);
    assert.match(out.errors[0].reason, /marker-write-failed/);
    assert.equal(fs.readdirSync(env.queueDir).filter(f => f.endsWith('.json')).length, 1, 'se reintenta el próximo ciclo');
});

test('si el move a procesado falla, el efecto no se duplica en el próximo ciclo (CA-7)', () => {
    const env = mkEnv();
    seedPending(env, 6208);
    enqueue(env, { issue: 6208, gate: 'definicion', decision: 'signed' });

    const carrier = fakeCarrier();
    const fsRoto = Object.create(fs);
    fsRoto.renameSync = () => { throw new Error('EBUSY'); };
    const out = drainer.drainGateSignatureQueue(opts(env), {
        approvalDeps: env.channelDeps, dispatchToCarrier: carrier, fsImpl: fsRoto,
    });
    assert.equal(out.dispatched.length, 1);
    assert.match(out.errors[0].reason, /dispatched-but-move-failed/);

    // Próximo ciclo con el FS sano: el marker ya existe ⇒ superseded, sin
    // segundo despacho.
    const out2 = drain(env, { dispatchToCarrier: carrier });
    assert.equal(carrier.calls.length, 1, 'el carrier se invocó UNA sola vez en total');
    assert.equal(out2.superseded.length, 1);
});

// -----------------------------------------------------------------------------
// #6208 rev2 — `listPending` puede devolver `ok:true` CON `degraded:true`: el
// kernel abrió el depósito pero SABE que el índice quedó incompleto. Tratar la
// ausencia de un `(issue,gate)` como terminal en ese caso pierde en silencio una
// decisión REAL del operador. Regla: con el índice incompleto se RETIENE.
//
// `degraded` no se puede provocar por config hoy (ambos gates en `dry-run`, R7),
// así que se inyecta el retorno de `listPending` — que es exactamente la costura
// que el drenador consume.
// -----------------------------------------------------------------------------

/** `approvalImpl` real salvo `listPending`, que responde lo que pida el test. */
function channelConListPending(respuesta) {
    return {
        listPending: () => respuesta,
        isValidIssueId: channel.isValidIssueId,
        resolveGate: channel.resolveGate,
        DEFAULT_DEPOSIT_DIR: channel.DEFAULT_DEPOSIT_DIR,
        submitSignature: () => { throw new Error('el drenador NO debe firmar'); },
    };
}

test('#6208 rev2 · con el índice DEGRADADO un pedido sin match se retiene en pendiente/, no se cierra como no-pending', () => {
    const env = mkEnv();
    enqueue(env, { issue: 6208, gate: 'definicion', decision: 'signed' });

    const carrier = fakeCarrier();
    const out = drain(env, {
        // Índice incompleto y el kernel lo sabe: `ok:true` PERO `degraded:true`.
        approvalImpl: channelConListPending({
            ok: true, pending: [], corrupt: [{ file: 'roto.json' }], degraded: true,
            alert: 'No pude leer 1 pendiente del depósito.',
        }),
        dispatchToCarrier: carrier,
    });

    assert.equal(out.rejected.length, 0, 'con el índice incompleto NO se cierra como no-pending');
    assert.equal(out.retained.length, 1, 'se retiene explícitamente');
    assert.equal(out.retained[0].reason, 'deposito-degradado');
    assert.equal(out.retained[0].issue, 6208);
    assert.equal(out.retained[0].gate, 'definicion');
    assert.equal(carrier.calls.length, 0, 'sin certeza NO se despacha');

    // Lo único que importa de verdad: el pedido sigue vivo para el próximo ciclo.
    assert.equal(
        fs.readdirSync(env.queueDir).filter(f => f.endsWith('.json')).length, 1,
        'el pedido sigue en pendiente/',
    );
    assert.ok(
        !fs.existsSync(env.processedDir) || fs.readdirSync(env.processedDir).filter(f => f.endsWith('.json')).length === 0,
        'la decisión del operador NO se cierra en silencio',
    );

    // Y queda traza de por qué se retuvo.
    const retenciones = readAudit(env).filter(e => e.outcome === 'retained');
    assert.equal(retenciones.length, 1);
    assert.match(retenciones[0].reason, /degradado/);
});

test('#6208 rev2 · el índice degradado NO frena lo que SÍ está en el índice', () => {
    const env = mkEnv();
    const sembrado = seedPending(env, 6208);
    enqueue(env, { issue: 6208, gate: 'definicion', decision: 'signed' });

    // El depósito conoce ESTE pendiente, pero avisa que no pudo leer otro.
    const listado = channel.listPending({}, env.channelDeps);
    assert.equal(listado.ok, true);
    assert.ok(listado.pending.length >= 1, 'el sembrado tiene que estar en el índice');
    assert.equal(sembrado.ok, true);

    const carrier = fakeCarrier();
    const out = drain(env, {
        approvalImpl: channelConListPending({
            ok: true, pending: listado.pending, corrupt: [{ file: 'otro-roto.json' }], degraded: true,
        }),
        dispatchToCarrier: carrier,
    });

    // Fail-closed no es fail-stop: con match en el índice hay certeza y se despacha.
    assert.equal(out.retained.length, 0);
    assert.equal(out.dispatched.length, 1);
    assert.equal(carrier.calls.length, 1);
    assert.equal(carrier.calls[0].issue, 6208);
});

test('#6208 rev2 · sin degraded, el pedido sin pendiente sigue siendo TERMINAL (CA-11 no regresiona)', () => {
    const env = mkEnv();
    enqueue(env, { issue: 6208, gate: 'definicion', decision: 'signed' });

    const carrier = fakeCarrier();
    const out = drain(env, {
        // Índice COMPLETO y vacío: acá sí sabemos que ya no hace falta.
        approvalImpl: channelConListPending({ ok: true, pending: [], corrupt: [], degraded: false }),
        dispatchToCarrier: carrier,
    });

    assert.equal(out.retained.length, 0, 'un índice completo no retiene nada');
    assert.equal(out.rejected.filter(r => r.reason === 'no-pending').length, 1);
    assert.equal(carrier.calls.length, 0);
    assert.equal(fs.readdirSync(env.queueDir).filter(f => f.endsWith('.json')).length, 0);
    assert.equal(fs.readdirSync(env.processedDir).filter(f => f.endsWith('.json')).length, 1);
});

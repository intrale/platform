// =============================================================================
// listener-callback.test.js — Dispatch de `update.callback_query` en el listener
// (issue #4579).
//
// Verifica el cableado nuevo de `enqueueMessage`/`handleCallbackQuery` sin red
// ni secrets reales: se inyecta un transporte Telegram fake (deps.telegramRequest)
// y un operator-gate fake (deps.operatorGate). Cubre:
//   - rama nueva: un callback_query se deriva a handleCallbackQuery
//   - answerCallbackQuery SIEMPRE invocado (éxito y rechazo) — CA-9
//   - tras firma exitosa, editMessageText sobre el mensaje original — CA-10
//   - callback de usuario no autorizado: se responde el toast, NO se edita
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Aislar el estado del listener (history, media) a un dir temporal ANTES de
// importar el módulo — PIPELINE se resuelve en require-time desde el env.
process.env.PIPELINE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'listener-cb-'));

// El módulo NO arranca el polling al importarse (guard `require.main === module`).
const listener = require('../../listener-telegram');

/** Instala un transporte fake que captura cada llamada. */
function installFakeTransport() {
    const calls = [];
    listener.deps.telegramRequest = async (method, params) => {
        calls.push({ method, params });
        return { ok: true };
    };
    return calls;
}

/** Instala un operator-gate fake que devuelve `result` fijo. */
function installFakeGate(result, onCall) {
    listener.deps.operatorGate = {
        handleSignature: (args) => {
            if (onCall) onCall(args);
            return result;
        },
    };
}

// #4802 — helpers reales de membresía de namespace del Commander (single source
// of truth). Importados del módulo real para afirmar disjunción (CA-7) y usar la
// misma lógica de ruteo en el router fake que en producción.
const commanderHandler = require('../../../.claude/hooks/commander/callback-handler');

/** Instala un router del Commander fake que usa los helpers REALES de membresía. */
function installFakeCommanderRouter(onRoute, routeResult = true) {
    const calls = [];
    listener.deps.commanderRouter = {
        isCommanderNamespace: commanderHandler.isCommanderNamespace,
        isPrivilegedNamespace: commanderHandler.isPrivilegedNamespace,
        routeCallback: async (data, id, msg, fromId) => {
            calls.push({ data, id, msg, fromId });
            if (onRoute) onRoute({ data, id, msg, fromId });
            return routeResult;
        },
    };
    return calls;
}

function resetDeps() {
    listener.deps.operatorGate = null;
    listener.deps.commanderRouter = null;
    listener.deps.telegramRequest = async () => ({ ok: true });
    delete process.env.TELEGRAM_LEO_OPERATOR_CHAT_ID;
}

const CBQ = {
    id: 'cbq-1',
    data: 'abcabcabcabcabca',
    from: { id: 111222333, first_name: 'Leo' },
    message: {
        message_id: 42,
        chat: { id: 111222333 },
        text: 'Gate build · issue #4579 · tenant intrale · fase dev',
    },
};

test('enqueueMessage deriva un update.callback_query a handleCallbackQuery', async () => {
    const calls = installFakeTransport();
    let received = null;
    installFakeGate(
        { ok: true, transitioned: true, editMessage: true, toast: '✅ Aprobado — #4579 avanza', action: 'approve', issue: 4579 },
        (args) => { received = args; }
    );

    await listener.enqueueMessage({ callback_query: CBQ });

    // el gate recibió from.id (NO chat.id) y el callback_data crudo
    assert.equal(received.operatorId, 111222333);
    assert.equal(received.callbackData, 'abcabcabcabcabca');
    // answerCallbackQuery invocado (CA-9)
    assert.ok(calls.some(c => c.method === 'answerCallbackQuery'));
    resetDeps();
});

test('firma exitosa: answerCallbackQuery + editMessageText del mensaje original (CA-9/CA-10)', async () => {
    const calls = installFakeTransport();
    installFakeGate({ ok: true, transitioned: true, editMessage: true, toast: '✅ Aprobado', action: 'approve', issue: 4579 });

    await listener.handleCallbackQuery(CBQ);

    const methods = calls.map(c => c.method);
    assert.ok(methods.includes('answerCallbackQuery'), 'debe cortar el spinner');
    assert.ok(methods.includes('editMessageText'), 'debe editar el mensaje original con la constancia');
    assert.ok(!methods.includes('sendMessage'), 'no debe publicar la constancia como mensaje nuevo');
    const edit = calls.find(c => c.method === 'editMessageText');
    assert.equal(edit.params.chat_id, 111222333);
    assert.equal(edit.params.message_id, 42);
    assert.match(edit.params.text, /Gate build · issue #4579/);
    assert.match(edit.params.text, /Firmado por Leo/);
    assert.deepEqual(edit.params.reply_markup, { inline_keyboard: [] });
    // el answer lleva el callback_query_id correcto
    const answer = calls.find(c => c.method === 'answerCallbackQuery');
    assert.equal(answer.params.callback_query_id, 'cbq-1');
    resetDeps();
});

test('callback no autorizado: responde toast pero NO edita el mensaje', async () => {
    const calls = installFakeTransport();
    installFakeGate({ ok: false, reason: 'unauthorized', editMessage: false, toast: '🔒 No autorizado para firmar este issue' });

    await listener.handleCallbackQuery({ ...CBQ, from: { id: 999, first_name: 'Intruso' } });

    const methods = calls.map(c => c.method);
    assert.ok(methods.includes('answerCallbackQuery'), 'CA-9: siempre responde');
    assert.ok(!methods.includes('editMessageText'), 'no edita si no hubo transición');
    assert.ok(!methods.includes('editMessageReplyMarkup'), 'no remueve botones si no hubo transición');
    const answer = calls.find(c => c.method === 'answerCallbackQuery');
    assert.match(answer.params.text, /No autorizado/);
    resetDeps();
});

test('callback sin id se ignora sin explotar', async () => {
    const calls = installFakeTransport();
    installFakeGate({ ok: true, transitioned: true, editMessage: true, toast: 'x' });
    await listener.handleCallbackQuery({});
    assert.equal(calls.length, 0);
    resetDeps();
});

test('rechazo (expired) igual corta el spinner sin editar', async () => {
    const calls = installFakeTransport();
    installFakeGate({ ok: false, reason: 'expired', editMessage: false, toast: '⏱️ Acción expirada, pedí el gate de nuevo' });

    await listener.handleCallbackQuery(CBQ);

    const methods = calls.map(c => c.method);
    assert.ok(methods.includes('answerCallbackQuery'));
    assert.ok(!methods.includes('editMessageText'));
    assert.ok(!methods.includes('editMessageReplyMarkup'));
    resetDeps();
});

// =============================================================================
// #4802 — Ruteo por namespace del Commander en handleCallbackQuery.
// =============================================================================

test('#4802 ruteo: create_all_proposals invoca routeCallback y NO operator-gate', async () => {
    installFakeTransport();
    let gateCalled = false;
    installFakeGate({ ok: false, reason: 'unknown-id', editMessage: false, toast: 'Acción inválida o expirada' },
        () => { gateCalled = true; });
    const routed = installFakeCommanderRouter();

    // create_all_proposals NO es privilegiado → no requiere allowlist.
    await listener.handleCallbackQuery({ ...CBQ, data: 'create_all_proposals' });

    assert.equal(routed.length, 1, 'routeCallback debe invocarse una vez');
    assert.equal(routed[0].data, 'create_all_proposals');
    assert.equal(gateCalled, false, 'operator-gate.handleSignature NO debe invocarse');
    resetDeps();
});

test('#4802 ruteo: botones no privilegiados (reactivate:, show_detail) van al router', async () => {
    installFakeTransport();
    installFakeGate({ ok: false, toast: 'Acción inválida o expirada' });
    const routed = installFakeCommanderRouter();

    await listener.handleCallbackQuery({ ...CBQ, data: 'reactivate:4802' });
    await listener.handleCallbackQuery({ ...CBQ, data: 'show_detail' });

    assert.deepEqual(routed.map(r => r.data), ['reactivate:4802', 'show_detail']);
    resetDeps();
});

test('#4802 disjunción: COMMANDER_NAMESPACES no solapa pc:/pcx: ni formato de firma (CA-7)', () => {
    const { isCommanderNamespace, COMMANDER_NAMESPACES, PRIVILEGED_NAMESPACES } = commanderHandler;
    // product-aware
    assert.equal(isCommanderNamespace('pc:abc123'), false);
    assert.equal(isCommanderNamespace('pcx:abc123'), false);
    // formato de firma de operator-gate (id opaco tipo hex de 16 chars)
    assert.equal(isCommanderNamespace('abcabcabcabcabca'), false);
    assert.equal(isCommanderNamespace(''), false);
    assert.equal(isCommanderNamespace(undefined), false);
    // PRIVILEGED ⊂ COMMANDER
    for (const p of PRIVILEGED_NAMESPACES) {
        assert.ok(COMMANDER_NAMESPACES.includes(p), `privilegiado ${p} debe estar en COMMANDER_NAMESPACES`);
    }
    // los propios del Commander sí matchean
    assert.ok(isCommanderNamespace('create_all_proposals'));
    assert.ok(isCommanderNamespace('allow:req-1'));
    assert.ok(isCommanderNamespace('pq_next'));
    resetDeps();
});

test('#4802 authz: persist: (privilegiado) de from.id fuera del allowlist se rechaza fail-closed, NO invoca routeCallback (CA-6)', async () => {
    const calls = installFakeTransport();
    installFakeGate({ ok: false, toast: 'no debería llegar acá' });
    const routed = installFakeCommanderRouter();
    // allowlist = un id distinto al del callback
    process.env.TELEGRAM_LEO_OPERATOR_CHAT_ID = '111222333';

    await listener.handleCallbackQuery({ ...CBQ, data: 'persist:cGF0dGVybg', from: { id: 999, first_name: 'Intruso' } });

    assert.equal(routed.length, 0, 'routeCallback NO debe invocarse para privilegiado no autorizado');
    const answer = calls.find(c => c.method === 'answerCallbackQuery');
    assert.ok(answer, 'debe cortar el spinner');
    assert.match(answer.params.text, /Acción inválida o expirada/);
    resetDeps();
});

test('#4802 authz: persist: de from.id AUTORIZADO sí invoca routeCallback', async () => {
    installFakeTransport();
    installFakeGate({ ok: false, toast: 'x' });
    const routed = installFakeCommanderRouter();
    process.env.TELEGRAM_LEO_OPERATOR_CHAT_ID = '111222333';

    await listener.handleCallbackQuery({ ...CBQ, data: 'persist:cGF0dGVybg', from: { id: 111222333, first_name: 'Leo' } });

    assert.equal(routed.length, 1, 'privilegiado autorizado debe rutear');
    assert.equal(routed[0].fromId, 111222333, 'from.id se pasa a routeCallback');
    resetDeps();
});

test('#4802 fail-closed: allowlist vacío rechaza TODO callback privilegiado (CA-6)', async () => {
    const calls = installFakeTransport();
    installFakeGate({ ok: false, toast: 'x' });
    const routed = installFakeCommanderRouter();
    // sin TELEGRAM_LEO_OPERATOR_CHAT_ID → allowlist vacío

    await listener.handleCallbackQuery({ ...CBQ, data: 'relaunch_skill:builder', from: { id: 111222333 } });

    assert.equal(routed.length, 0, 'allowlist vacío → ningún privilegiado rutea');
    const answer = calls.find(c => c.method === 'answerCallbackQuery');
    assert.match(answer.params.text, /Acción inválida o expirada/);
    resetDeps();
});

test('#4802 fail-safe: callback desconocido cae a operator-gate (firma) sin romper (CA-4/CA-3)', async () => {
    installFakeTransport();
    let gateArgs = null;
    installFakeGate({ ok: false, reason: 'unknown-id', editMessage: false, toast: 'Acción inválida o expirada' },
        (args) => { gateArgs = args; });
    installFakeCommanderRouter();

    // 'abcabcabcabcabca' no es commander ni product → debe ir a operator-gate.
    await listener.handleCallbackQuery(CBQ);

    assert.ok(gateArgs, 'un callback no-commander sigue yendo a operator-gate (sin regresión de firma)');
    assert.equal(gateArgs.callbackData, 'abcabcabcabcabca');
    resetDeps();
});

test('#4802 router.routeCallback returns false → fail-safe toast', async () => {
    const calls = installFakeTransport();
    installFakeGate({ ok: false, toast: 'x' });
    // routeResult=false simula chat.id mismatch dentro del router
    installFakeCommanderRouter(null, false);

    await listener.handleCallbackQuery({ ...CBQ, data: 'tts_listen' });

    const answer = calls.find(c => c.method === 'answerCallbackQuery');
    assert.match(answer.params.text, /Acción inválida o expirada/);
    resetDeps();
});

// =============================================================================
// #5923 — Namespaces `hb:` / `pp:` de los botones degradados de `url` a
// `callback_data`. Ambos disparan acciones que destraban el pipeline o mutan el
// allowlist ⇒ privilegiados ⇒ authz fail-closed por `from.id` en el listener.
// =============================================================================

test('#5923 hb: y pp: son namespace del Commander Y privilegiado', () => {
    const { isCommanderNamespace, isPrivilegedNamespace, COMMANDER_NAMESPACES, PRIVILEGED_NAMESPACES } = commanderHandler;
    for (const data of [
        'hb:unblock:5923', 'hb:devolver-definicion:5923', 'hb:c:devolver-definicion:5923', 'hb:x:devolver-definicion:5923',
        'pp:include-deps:5923', 'pp:keep-original:5923', 'pp:cancel-partial-pause',
    ]) {
        assert.ok(isCommanderNamespace(data), `${data} debe rutear al Commander`);
        assert.ok(isPrivilegedNamespace(data), `${data} debe exigir authz`);
    }
    // PRIVILEGED ⊂ COMMANDER se mantiene con las 2 entradas nuevas.
    for (const p of PRIVILEGED_NAMESPACES) {
        assert.ok(COMMANDER_NAMESPACES.includes(p), `privilegiado ${p} debe estar en COMMANDER_NAMESPACES`);
    }
    // Sin solapamiento con los namespaces preexistentes.
    assert.equal(isCommanderNamespace('hbsomething'), false, 'exige el separador `:`');
    assert.equal(isCommanderNamespace('ppsomething'), false);
});

test('#5923 authz: hb: de un from.id fuera del allowlist NO llega al router (fail-closed)', async () => {
    const calls = installFakeTransport();
    installFakeGate({ ok: false, toast: 'no debería llegar acá' });
    const routed = installFakeCommanderRouter();
    process.env.TELEGRAM_LEO_OPERATOR_CHAT_ID = '111222333';

    await listener.handleCallbackQuery({ ...CBQ, data: 'hb:unblock:5923', from: { id: 999, first_name: 'Intruso' } });

    assert.equal(routed.length, 0, 'un intruso no puede desbloquear issues');
    const answer = calls.find(c => c.method === 'answerCallbackQuery');
    assert.ok(answer, 'igual se corta el spinner');
    assert.match(answer.params.text, /Acción inválida o expirada/, 'rechazo uniforme, no revela por qué');
    resetDeps();
});

test('#5923 authz: pp: con allowlist vacío se rechaza (fail-closed)', async () => {
    const calls = installFakeTransport();
    installFakeGate({ ok: false, toast: 'x' });
    const routed = installFakeCommanderRouter();
    // sin TELEGRAM_LEO_OPERATOR_CHAT_ID → allowlist vacío

    await listener.handleCallbackQuery({ ...CBQ, data: 'pp:cancel-partial-pause', from: { id: 111222333 } });

    assert.equal(routed.length, 0, 'allowlist vacío ⇒ nadie levanta la pausa parcial');
    const answer = calls.find(c => c.method === 'answerCallbackQuery');
    assert.match(answer.params.text, /Acción inválida o expirada/);
    resetDeps();
});

test('#5923 authz: hb:/pp: de un from.id AUTORIZADO sí llegan al router con el fromId', async () => {
    installFakeTransport();
    installFakeGate({ ok: false, toast: 'x' });
    const routed = installFakeCommanderRouter();
    process.env.TELEGRAM_LEO_OPERATOR_CHAT_ID = '111222333';

    await listener.handleCallbackQuery({ ...CBQ, data: 'hb:unblock:5923', from: { id: 111222333, first_name: 'Leo' } });
    await listener.handleCallbackQuery({ ...CBQ, data: 'pp:include-deps:5923', from: { id: 111222333, first_name: 'Leo' } });

    assert.deepEqual(routed.map(r => r.data), ['hb:unblock:5923', 'pp:include-deps:5923']);
    assert.ok(routed.every(r => r.fromId === 111222333), 'el operador real viaja al handler para el audit trail');
    resetDeps();
});

test('#5923 el listener NO emite toast propio cuando el router devuelve true (D5)', async () => {
    // Por eso el handler de `hb:`/`pp:` DEBE emitir el suyo: si no, el operador
    // se queda con el spinner girando y sin saber si su decisión se aplicó.
    const calls = installFakeTransport();
    installFakeGate({ ok: false, toast: 'x' });
    installFakeCommanderRouter(null, true);
    process.env.TELEGRAM_LEO_OPERATOR_CHAT_ID = '111222333';

    await listener.handleCallbackQuery({ ...CBQ, data: 'hb:unblock:5923', from: { id: 111222333 } });

    assert.equal(
        calls.filter(c => c.method === 'answerCallbackQuery').length, 0,
        'el listener delega el toast al handler en el camino handled===true',
    );
    resetDeps();
});

// =============================================================================
// #5458 — DESPACHO OPERACIONAL AISLADO (`vault-cut-fallback`).
//
// El listener debe clasificar el `callback_data` ANTES del gate de lifecycle y
// derivar las acciones operacionales a `handleOperationalCallback()`. Si eso no
// pasa, el callback cae en `handleSignature()` — donde vive `applyTransition()`
// — y el corte del fallback terminaría moviendo work-files.
// =============================================================================

/**
 * Gate fake que implementa las DOS superficies (firma + operacional) y registra
 * cuál se invocó. `kind` decide la clasificación del `callback_data`.
 */
function installFakeGateConClasificacion(kind, opResult) {
    const calls = { classify: [], signature: [], operational: [] };
    listener.deps.operatorGate = {
        classifyCallback: (data) => { calls.classify.push(data); return kind; },
        handleSignature: (args) => {
            calls.signature.push(args);
            return { ok: true, editMessage: true, toast: 'firma', action: 'approve', issue: 4579 };
        },
        handleOperationalCallback: (args) => {
            calls.operational.push(args);
            return opResult;
        },
    };
    return calls;
}

const OP_OK = {
    ok: true, editMessage: true, status: 'cut',
    toast: '✅ Confirmado — corte del fallback aplicado',
    action: 'vault-cut-fallback', issue: 5458, reason: null,
};

test('#5458 un callback operacional va al handler dedicado y NUNCA a handleSignature', async () => {
    const calls = installFakeTransport();
    const gateCalls = installFakeGateConClasificacion('operational', OP_OK);

    await listener.handleCallbackQuery({ ...CBQ, data: 'ffff0000ffff0000' });

    assert.equal(gateCalls.operational.length, 1, 'debe usar el handler operacional');
    assert.equal(gateCalls.signature.length, 0, 'NO debe pasar por el canal de firma');
    // Autorización por from.id (no chat.id) y callback_data crudo.
    assert.equal(gateCalls.operational[0].operatorId, 111222333);
    assert.equal(gateCalls.operational[0].callbackData, 'ffff0000ffff0000');
    // Respuesta terminal: se corta el spinner y se quitan los botones.
    const methods = calls.map(c => c.method);
    assert.ok(methods.includes('answerCallbackQuery'));
    assert.ok(methods.includes('editMessageText'));
    const edit = calls.find(c => c.method === 'editMessageText');
    assert.deepEqual(edit.params.reply_markup, { inline_keyboard: [] });
    assert.match(edit.params.text, /corte del fallback aplicado/);
    // Sin copy de lifecycle.
    assert.doesNotMatch(edit.params.text, /definici[oó]n|Firmado por/);
    resetDeps();
});

test('#5458 un callback de gate sigue yendo al canal de firma (sin regresión)', async () => {
    installFakeTransport();
    const gateCalls = installFakeGateConClasificacion('gate', OP_OK);

    await listener.handleCallbackQuery(CBQ);

    assert.equal(gateCalls.signature.length, 1);
    assert.equal(gateCalls.operational.length, 0);
    resetDeps();
});

test('#5458 un gate SIN classifyCallback (versión vieja) cae al canal de firma', async () => {
    const calls = installFakeTransport();
    installFakeGate({ ok: true, editMessage: false, toast: 'ok', action: 'approve', issue: 1 });

    await listener.handleCallbackQuery(CBQ);

    assert.ok(calls.some(c => c.method === 'answerCallbackQuery'), 'degradación sin romper');
    resetDeps();
});

test('#5458 rechazo operacional responde toast terminal y no toca el lifecycle', async () => {
    const calls = installFakeTransport();
    const gateCalls = installFakeGateConClasificacion('operational', {
        ok: false, editMessage: false, status: 'precondition-failed',
        reason: 'precondition-failed',
        toast: '🔒 Las condiciones del corte ya no se cumplen; el fallback se conserva',
    });

    await listener.handleCallbackQuery({ ...CBQ, data: 'ffff0000ffff0001' });

    assert.equal(gateCalls.signature.length, 0);
    const methods = calls.map(c => c.method);
    assert.ok(methods.includes('answerCallbackQuery'), 'CA-9: siempre corta el spinner');
    assert.ok(!methods.includes('editMessageText'), 'no edita si el resultado no es terminal');
    const answer = calls.find(c => c.method === 'answerCallbackQuery');
    assert.match(answer.params.text, /fallback se conserva/);
    resetDeps();
});

test('#5458 si el handler operacional explota, el spinner se corta igual', async () => {
    const calls = installFakeTransport();
    listener.deps.operatorGate = {
        classifyCallback: () => 'operational',
        handleSignature: () => { throw new Error('no debería llamarse'); },
        handleOperationalCallback: () => { throw new Error('boom C:\Users\Administrator\secreto'); },
    };

    await listener.handleCallbackQuery({ ...CBQ, data: 'ffff0000ffff0002' });

    const answer = calls.find(c => c.method === 'answerCallbackQuery');
    assert.ok(answer, 'CA-9: responde aunque el handler explote');
    assert.doesNotMatch(answer.params.text, /boom|Administrator/);
    resetDeps();
});

test('#5458 classifyCallback que explota degrada al canal de firma sin romper', async () => {
    const calls = installFakeTransport();
    const gateCalls = { signature: [] };
    listener.deps.operatorGate = {
        classifyCallback: () => { throw new Error('store ilegible'); },
        handleSignature: (args) => {
            gateCalls.signature.push(args);
            return { ok: false, editMessage: false, toast: 'Acción inválida o expirada', reason: 'unknown-id' };
        },
    };

    await listener.handleCallbackQuery(CBQ);

    assert.equal(gateCalls.signature.length, 1);
    const answer = calls.find(c => c.method === 'answerCallbackQuery');
    assert.match(answer.params.text, /inválida o expirada/);
    resetDeps();
});

test('#5458 integración con el operator-gate REAL: cero movimientos de work-files', async () => {
    const { createOperatorGate } = require('../operator-gate');
    const { createTokenSigner } = require('../action-token');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'listener-5458-'));
    const dirs = {
        storeDir: path.join(root, 'store'),
        waitingDir: path.join(root, 'waiting-operator'),
        approvedDir: path.join(root, 'procesado'),
        rejectedDir: path.join(root, 'pendiente'),
        auditFile: path.join(root, 'audit', 'sig.jsonl'),
        nonceFile: path.join(root, 'audit', 'nonces.jsonl'),
    };
    fs.mkdirSync(dirs.waitingDir, { recursive: true });
    fs.writeFileSync(path.join(dirs.waitingDir, '5458.json'), '{"issue":5458}');

    let ejecutado = 0;
    const gate = createOperatorGate({
        ...dirs,
        signer: createTokenSigner({ secret: 'listener-5458', nonceFile: dirs.nonceFile, ttlMs: 60_000 }),
        operatorAllowlist: ['111222333'],
        operationalExecutor: () => { ejecutado += 1; return { ok: true, status: 'cut' }; },
    });
    listener.deps.operatorGate = gate;
    const calls = installFakeTransport();

    const { callbackData } = gate.register({ issue: 5458, action: 'vault-cut-fallback' });
    await listener.handleCallbackQuery({ ...CBQ, data: callbackData });

    assert.equal(ejecutado, 1, 'el ejecutor operacional corrió una vez');
    // El work-file de waiting-operator NO se movió a ningún lado.
    assert.ok(fs.existsSync(path.join(dirs.waitingDir, '5458.json')));
    assert.equal(fs.existsSync(path.join(dirs.approvedDir, '5458.json')), false);
    assert.equal(fs.existsSync(path.join(dirs.rejectedDir, '5458.json')), false);
    const answer = calls.find(c => c.method === 'answerCallbackQuery');
    assert.match(answer.params.text, /Confirmado/);

    // Segundo toque: terminal e idempotente, sin volver a ejecutar.
    await listener.handleCallbackQuery({ ...CBQ, id: 'cbq-2', data: callbackData });
    assert.equal(ejecutado, 1, 'no se repite el efecto');
    resetDeps();
});

// --- #5458 rebote rev-1: el footer PERMANENTE no puede mentir -------------
// El bug original afirmaba "Confirmado por <operador>" en los 4 caminos
// terminales donde la acción NO se ejecutó. Los tests previos sólo cubrían
// fallos con `editMessage: false` (que ni siquiera escriben footer), así que
// el defecto pasó. Estos casos ejercitan fallo terminal CON edición.
const OP_FALLIDOS_TERMINALES = [
  { status: 'executor-unavailable', toast: '🔒 Ejecutor no disponible; el fallback se conserva' },
  { status: 'precondition-failed', toast: '🔒 Las condiciones del corte ya no se cumplen; el fallback se conserva' },
  { status: 'expired', toast: '⏱️ Acción expirada, pedí la confirmación de nuevo' },
  { status: 'unavailable', toast: '🔒 No se pudo confirmar de forma segura; el fallback se conserva' },
];

for (const caso of OP_FALLIDOS_TERMINALES) {
  test(`#5458 el footer NO dice "Confirmado" cuando la acción falló (${caso.status})`, async () => {
    const calls = installFakeTransport();
    installFakeGateConClasificacion('operational', {
      ok: false, editMessage: true, status: caso.status,
      reason: caso.status, toast: caso.toast,
      action: 'vault-cut-fallback', issue: 5458,
    });

    await listener.handleCallbackQuery({ ...CBQ, data: 'ffff0000ffff0003' });

    const edit = calls.find(c => c.method === 'editMessageText');
    assert.ok(edit, 'resultado terminal: debe dejar constancia en el chat');
    assert.doesNotMatch(
      edit.params.text, /Confirmado por/,
      'no puede afirmar una confirmación que no ocurrió',
    );
    assert.match(edit.params.text, /No aplicado/, 'debe decir que no se aplicó');
    // La atribución al operador se conserva (valor de auditoría).
    assert.match(edit.params.text, /Leo/);
    // El motivo real sigue visible.
    assert.ok(edit.params.text.includes(caso.toast.slice(2).trim()));
    resetDeps();
  });
}

test('#5458 el footer SÍ dice "Confirmado por" cuando el corte se aplicó', async () => {
  const calls = installFakeTransport();
  installFakeGateConClasificacion('operational', OP_OK);

  await listener.handleCallbackQuery({ ...CBQ, data: 'ffff0000ffff0004' });

  const edit = calls.find(c => c.method === 'editMessageText');
  assert.ok(edit);
  assert.match(edit.params.text, /✅ Confirmado por Leo/);
  assert.doesNotMatch(edit.params.text, /No aplicado/);
  resetDeps();
});

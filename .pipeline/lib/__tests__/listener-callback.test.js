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

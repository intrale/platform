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

function resetDeps() {
    listener.deps.operatorGate = null;
    listener.deps.telegramRequest = async () => ({ ok: true });
    listener.deps.commanderRouter = null;
    listener.deps.resolveOperatorAllowlist = null;
}

// #4802 — Helpers de ruteo del Commander. El router fake reusa los helpers REALES
// de membresía de namespace (`callback-handler`) para que el ruteo por prefijo se
// ejerza tal cual producción; sólo `routeCallback` se espía.
const callbackHandler = require('../../../.claude/hooks/commander/callback-handler');

function installFakeCommanderRouter(onRoute) {
    const routed = [];
    listener.deps.commanderRouter = {
        isCommanderNamespace: (d) => callbackHandler.isCommanderNamespace(d),
        isPrivilegedNamespace: (d) => callbackHandler.isPrivilegedNamespace(d),
        routeCallback: async (data, id, message, fromId) => {
            routed.push({ data, id, message, fromId });
            if (onRoute) return onRoute({ data, id, message, fromId });
            return true;
        },
    };
    return routed;
}

/** Instala un allowlist de operador fake (Set de ids como string). */
function installFakeAllowlist(ids) {
    const set = new Set((ids || []).map(String));
    listener.deps.resolveOperatorAllowlist = () => set;
    return set;
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
// #4802 — Ruteo por namespace del Commander (regresión de callbacks)
// =============================================================================

const CBQ_CMD = {
    id: 'cbq-cmd-1',
    data: 'create_all_proposals',
    from: { id: 111222333, first_name: 'Leo' },
    message: { message_id: 77, chat: { id: 111222333 } },
};

test('ruteo por namespace: create_all_proposals invoca routeCallback y NO operator-gate', async () => {
    installFakeTransport();
    const routed = installFakeCommanderRouter();
    let gateCalled = false;
    installFakeGate({ ok: true, toast: 'x' }, () => { gateCalled = true; });

    await listener.handleCallbackQuery(CBQ_CMD);

    assert.equal(routed.length, 1, 'routeCallback debe invocarse una vez');
    assert.equal(routed[0].data, 'create_all_proposals');
    assert.equal(routed[0].fromId, 111222333, 'pasa from.id a routeCallback');
    assert.equal(gateCalled, false, 'operator-gate.handleSignature NO debe invocarse');
    resetDeps();
});

test('disjunción: COMMANDER_NAMESPACES no matchea pc:/pcx: ni formato de firma', async () => {
    // ningún prefijo del Commander clasifica un callback product-aware
    assert.equal(callbackHandler.isCommanderNamespace('pc:abc123'), false);
    assert.equal(callbackHandler.isCommanderNamespace('pcx:abc123'), false);
    // ni un callback de firma (id opaco de operator-gate, hex de 16 chars)
    assert.equal(callbackHandler.isCommanderNamespace('abcabcabcabcabca'), false);
    // y a la inversa: los privilegiados son subconjunto de los del Commander
    for (const p of callbackHandler.PRIVILEGED_NAMESPACES) {
        assert.ok(callbackHandler.COMMANDER_NAMESPACES.includes(p),
            `privilegiado ${p} debe estar en COMMANDER_NAMESPACES`);
    }
});

test('authz from.id: privilegiado (persist:) fuera del allowlist se rechaza fail-closed', async () => {
    const calls = installFakeTransport();
    const routed = installFakeCommanderRouter();
    installFakeAllowlist(['111222333']); // Leo autorizado, el intruso no

    await listener.handleCallbackQuery({
        id: 'cbq-priv',
        data: 'persist:QmFzaCgqKQ',
        from: { id: 999, first_name: 'Intruso' },
        message: { message_id: 5, chat: { id: 999 } },
    });

    assert.equal(routed.length, 0, 'NO debe invocar routeCallback si no está autorizado');
    const answer = calls.find(c => c.method === 'answerCallbackQuery');
    assert.ok(answer, 'CA-9: siempre responde');
    assert.match(answer.params.text, /inválida o expirada/, 'toast neutro (UX-4)');
    resetDeps();
});

test('fail-closed: allowlist vacío rechaza todo callback privilegiado', async () => {
    const calls = installFakeTransport();
    const routed = installFakeCommanderRouter();
    installFakeAllowlist([]); // vacío → fail-closed

    await listener.handleCallbackQuery({
        id: 'cbq-priv2',
        data: 'restart_retry',
        from: { id: 111222333, first_name: 'Leo' },
        message: { message_id: 6, chat: { id: 111222333 } },
    });

    assert.equal(routed.length, 0, 'allowlist vacío → ni el operador pasa');
    const answer = calls.find(c => c.method === 'answerCallbackQuery');
    assert.match(answer.params.text, /inválida o expirada/);
    resetDeps();
});

test('authz from.id: privilegiado con operador autorizado SÍ invoca routeCallback', async () => {
    installFakeTransport();
    const routed = installFakeCommanderRouter();
    installFakeAllowlist(['111222333']);

    await listener.handleCallbackQuery({
        id: 'cbq-priv3',
        data: 'allow:req-42',
        from: { id: 111222333, first_name: 'Leo' },
        message: { message_id: 7, chat: { id: 111222333 } },
    });

    assert.equal(routed.length, 1, 'operador autorizado pasa el gate');
    assert.equal(routed[0].data, 'allow:req-42');
    resetDeps();
});

test('no privilegiado (tts_listen) NO exige allowlist', async () => {
    installFakeTransport();
    const routed = installFakeCommanderRouter();
    installFakeAllowlist([]); // vacío, pero tts_listen no es privilegiado

    await listener.handleCallbackQuery({
        id: 'cbq-tts',
        data: 'tts_listen',
        from: { id: 777, first_name: 'Cualquiera' },
        message: { message_id: 8, chat: { id: 777 } },
    });

    assert.equal(routed.length, 1, 'callback no privilegiado se rutea sin gate de allowlist');
    resetDeps();
});

test('fail-safe: callback_data desconocido devuelve "Acción inválida o expirada"', async () => {
    const calls = installFakeTransport();
    installFakeCommanderRouter(); // no matchea un dato desconocido
    // el gate simula el catch-all actual: dato no reconocido → unknown-id
    installFakeGate({ ok: false, reason: 'unknown-id', editMessage: false, toast: 'Acción inválida o expirada' });

    await listener.handleCallbackQuery({
        id: 'cbq-unknown',
        data: 'algo_totalmente_desconocido',
        from: { id: 111222333, first_name: 'Leo' },
        message: { message_id: 9, chat: { id: 111222333 } },
    });

    const answer = calls.find(c => c.method === 'answerCallbackQuery');
    assert.match(answer.params.text, /Acción inválida o expirada/);
    resetDeps();
});

test('sin regresión de firma: un callback de firma sigue yendo al operator-gate', async () => {
    installFakeTransport();
    const routed = installFakeCommanderRouter();
    let gateArgs = null;
    installFakeGate(
        { ok: true, transitioned: true, editMessage: true, toast: '✅ Aprobado', action: 'approve', issue: 4579 },
        (args) => { gateArgs = args; }
    );

    await listener.handleCallbackQuery(CBQ); // data = 'abcabcabcabcabca' (id de firma)

    assert.equal(routed.length, 0, 'un callback de firma NO se rutea al Commander');
    assert.ok(gateArgs, 'debe llegar al operator-gate');
    assert.equal(gateArgs.operatorId, 111222333);
    resetDeps();
});

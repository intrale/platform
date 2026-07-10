// =============================================================================
// listener-callback.test.js — Dispatch de `update.callback_query` en el listener
// (issue #4579).
//
// Verifica el cableado nuevo de `enqueueMessage`/`handleCallbackQuery` sin red
// ni secrets reales: se inyecta un transporte Telegram fake (deps.telegramRequest)
// y un operator-gate fake (deps.operatorGate). Cubre:
//   - rama nueva: un callback_query se deriva a handleCallbackQuery
//   - answerCallbackQuery SIEMPRE invocado (éxito y rechazo) — CA-9
//   - tras firma exitosa, editMessageReplyMarkup para quitar botones — CA-10
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
}

const CBQ = {
    id: 'cbq-1',
    data: 'abcabcabcabcabca',
    from: { id: 111222333, first_name: 'Leo' },
    message: { message_id: 42, chat: { id: 111222333 } },
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

test('firma exitosa: answerCallbackQuery + editMessageReplyMarkup (CA-9/CA-10)', async () => {
    const calls = installFakeTransport();
    installFakeGate({ ok: true, transitioned: true, editMessage: true, toast: '✅ Aprobado', action: 'approve', issue: 4579 });

    await listener.handleCallbackQuery(CBQ);

    const methods = calls.map(c => c.method);
    assert.ok(methods.includes('answerCallbackQuery'), 'debe cortar el spinner');
    assert.ok(methods.includes('editMessageReplyMarkup'), 'debe quitar los botones consumidos');
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
    assert.ok(!methods.includes('editMessageReplyMarkup'), 'no edita si no hubo transición');
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
    assert.ok(!methods.includes('editMessageReplyMarkup'));
    resetDeps();
});

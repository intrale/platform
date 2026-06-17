// =============================================================================
// need-human-audio.test.js — #4067 (split de #4050)
// Audio TTS best-effort en la alerta needs-human.
//
// Cubre el helper de orquestación `sendNeedHumanAudio` de lib/human-block.js:
//   - SEC-4 best-effort: si textToSpeechWithMeta lanza, la excepción NO se
//     propaga (el helper nunca throwea) y la notificación de texto previa queda
//     intacta. El send de voz no se intenta si el TTS falló.
//   - SEC-5 idempotencia: el helper solo se invoca en la transición (dentro del
//     gate `if (!yaBloqueado)`). Replicamos el gate del call-site y verificamos
//     que con `yaBloqueado` presente NO se invoca sendVoiceTelegram.
//   - SEC-3 (defensa en profundidad sobre el flujo real): el texto que llega a
//     textToSpeechWithMeta ya viene redactado (no contiene el secreto literal).
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const hb = require(path.join(__dirname, '..', 'lib', 'human-block.js'));

// --- SEC-4: best-effort, TTS que lanza no propaga ni rompe el texto ----------

test('SEC-4: si textToSpeechWithMeta lanza, sendNeedHumanAudio no propaga y el texto previo sobrevive', async () => {
    let textoEnviado = false;
    // Simulamos el call-site: el texto se envía ANTES del bloque de audio.
    const sendTelegram = () => { textoEnviado = true; };
    sendTelegram();

    let voiceInvocado = false;
    const res = await hb.sendNeedHumanAudio({
        reason: 'motivo del bloqueo',
        question: '¿qué hacemos?',
        botToken: 'TOKEN', chatId: 'CHAT',
        textToSpeechWithMeta: async () => { throw new Error('Edge TTS timeout'); },
        sendVoiceTelegram: async () => { voiceInvocado = true; return true; },
    });

    assert.equal(textoEnviado, true, 'la notificación de texto se ejecutó igual');
    assert.equal(res.sent, false, 'no se envió audio');
    assert.equal(res.error, 'Edge TTS timeout', 'el error quedó contenido en el resultado');
    assert.equal(voiceInvocado, false, 'no se intentó enviar voz tras fallar el TTS');
});

test('SEC-4: si sendVoiceTelegram resuelve false, no lanza y reporta sent=false', async () => {
    const res = await hb.sendNeedHumanAudio({
        reason: 'm', question: 'q',
        botToken: 'TOKEN', chatId: 'CHAT',
        textToSpeechWithMeta: async () => ({ buffer: Buffer.from('opus') }),
        sendVoiceTelegram: async () => false, // Telegram rechazó / red caída
    });
    assert.equal(res.sent, false);
    assert.ok(!res.error, 'sin error: el send resolvió false sin throw');
});

test('camino feliz: TTS ok + send ok → sent=true y se usó el perfil need-human', async () => {
    let perfilUsado = null;
    let bufferEnviado = null;
    const res = await hb.sendNeedHumanAudio({
        reason: 'el PR quedó bloqueado por CODEOWNERS',
        question: 'mergealo a mano',
        botToken: 'TOKEN', chatId: 'CHAT',
        textToSpeechWithMeta: async (text, opts) => { perfilUsado = opts && opts.profile; return { buffer: Buffer.from('opus') }; },
        sendVoiceTelegram: async (buf) => { bufferEnviado = buf; return true; },
    });
    assert.equal(res.sent, true);
    assert.equal(perfilUsado, 'need-human', 'sintetizó con el perfil de alerta');
    assert.ok(Buffer.isBuffer(bufferEnviado), 'envió el buffer en memoria (sin temp files)');
});

// --- SEC-4: credenciales/deps ausentes → skip silencioso, nunca throw ---------

test('SEC-4: sin botToken/chatId hace skip sin invocar TTS ni voz', async () => {
    let tts = false, voice = false;
    const res = await hb.sendNeedHumanAudio({
        reason: 'm', question: 'q',
        botToken: '', chatId: '',
        textToSpeechWithMeta: async () => { tts = true; return { buffer: Buffer.from('x') }; },
        sendVoiceTelegram: async () => { voice = true; return true; },
    });
    assert.equal(res.sent, false);
    assert.equal(res.skipped, 'no-credentials');
    assert.equal(tts, false);
    assert.equal(voice, false);
});

test('SEC-4: helper no lanza aunque falten las funciones de multimedia', async () => {
    const res = await hb.sendNeedHumanAudio({
        reason: 'm', question: 'q', botToken: 'T', chatId: 'C',
        textToSpeechWithMeta: undefined, sendVoiceTelegram: undefined,
    });
    assert.equal(res.sent, false);
    assert.equal(res.skipped, 'no-tts');
});

// --- SEC-3 sobre el flujo real: lo que llega al TTS ya está redactado ---------

test('SEC-3: el texto que recibe textToSpeechWithMeta no contiene el secreto literal', async () => {
    let textoSintetizado = null;
    await hb.sendNeedHumanAudio({
        reason: 'falló con AKIAIOSFODNN7EXAMPLE en deploy',
        question: 'rotá la credencial',
        botToken: 'T', chatId: 'C',
        textToSpeechWithMeta: async (text) => { textoSintetizado = text; return { buffer: Buffer.from('x') }; },
        sendVoiceTelegram: async () => true,
    });
    assert.ok(textoSintetizado, 'se llamó al TTS');
    assert.ok(!textoSintetizado.includes('AKIAIOSFODNN7EXAMPLE'), 'el secreto NO llega al sintetizador');
    assert.ok(textoSintetizado.includes('[REDACTED]'), 'el secreto fue redactado antes de sintetizar');
});

// --- SEC-5: idempotencia — el gate del call-site evita re-envío ---------------

test('SEC-5: con marker yaBloqueado presente NO se invoca el audio (replica del gate)', async () => {
    let voiceInvocado = false;
    const deps = {
        reason: 'm', question: 'q', botToken: 'T', chatId: 'C',
        textToSpeechWithMeta: async () => ({ buffer: Buffer.from('x') }),
        sendVoiceTelegram: async () => { voiceInvocado = true; return true; },
    };

    // Replica fiel del control-flow del barrido (pulpo.js): el bloque de audio
    // vive DENTRO de `if (!yaBloqueado)`. Si ya estaba bloqueado, ni se llama.
    async function barridoTick(yaBloqueado) {
        if (!yaBloqueado) {
            await hb.sendNeedHumanAudio(deps);
        }
    }

    // Primer tick: transición real → se envía.
    await barridoTick(false);
    assert.equal(voiceInvocado, true, 'transición: audio enviado una vez');

    // Ticks subsiguientes con marker presente → nunca re-envía.
    voiceInvocado = false;
    await barridoTick(true);
    await barridoTick(true);
    assert.equal(voiceInvocado, false, 'idempotencia: con yaBloqueado no se reinvoca sendVoiceTelegram');
});

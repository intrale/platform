// =============================================================================
// Tests resolucion de credenciales Telegram en qa-video-share.js — Issue #4907
//
// Cubre el bug real: telegram-config.json quedo con placeholders tras la
// unificacion de credenciales (#3311) y el script seguia leyendo el token de
// ahi, produciendo un 404 opaco de la API de Telegram que marcaba como fallido
// todo job de video (perdiendo la evidencia QA ya subida a Drive).
//
//   - deteccion de placeholder (MOVED_TO_HOME_DOT_CLAUDE_SECRETS) y de token
//     mal formado (sin ":") -> se descartan y se cae al store unificado
//   - precedencia env > store > legacy, validando FORMA en cada nivel
//   - sponsor_chat_id conserva prioridad sobre chat_id, con el mismo filtro
//   - ambas fuentes invalidas -> valid:false + mensaje explicito (no 404 opaco)
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    resolveTelegramCredentials,
    describeMissingTelegramCredentials,
    isValidBotToken,
    isValidChatId,
} = require('../qa-video-share');

// Tokens sinteticos con el formato real "<bot_id>:<secreto>" (no son credenciales).
const STORE_TOKEN = '6529617704:AAFakeStoreTokenForUnitTests_0123456789';
const ENV_TOKEN = '1111111111:AAFakeEnvTokenForUnitTests_98765432100';
const LEGACY_TOKEN = '2222222222:AAFakeLegacyTokenForUnitTests_1234567';

const PLACEHOLDER_CHAT = 'MOVED_TO_HOME_DOT_CLAUDE_SECRETS';
// El placeholder real del archivo versionado: 32 chars, sin ":".
const PLACEHOLDER_TOKEN = 'MOVED_TO_HOME_DOT_CLAUDE_SECRETS';

// Directorio temporal con un credentials.json canonico sintetico. `storeLegacyPath`
// apunta a un archivo inexistente para que el loader no caiga al ~/.claude real
// de la maquina que corre los tests.
let tmpDir = '';
let canonicalPath = '';
let storeLegacyPath = '';

test.before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-4907-'));
    canonicalPath = path.join(tmpDir, 'credentials.json');
    storeLegacyPath = path.join(tmpDir, 'no-existe-legacy.json');
    fs.writeFileSync(canonicalPath, JSON.stringify({
        telegram: { bot_token: STORE_TOKEN, chat_id: '6529617704' },
    }), 'utf8');
});

test.after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
});

function resolve(overrides = {}) {
    return resolveTelegramCredentials({
        env: {},
        canonicalPath,
        storeLegacyPath,
        ...overrides,
    });
}

test('isValidBotToken rechaza placeholder, vacio y tokens sin formato NNNN:AAA', () => {
    assert.equal(isValidBotToken(STORE_TOKEN), true);
    assert.equal(isValidBotToken(PLACEHOLDER_TOKEN), false);
    assert.equal(isValidBotToken(''), false);
    assert.equal(isValidBotToken(null), false);
    assert.equal(isValidBotToken(undefined), false);
    // Largo 32 sin ":" — exactamente el caso del archivo versionado.
    assert.equal(isValidBotToken('abcdefghijklmnopqrstuvwxyz012345'), false);
    // Con ":" pero secreto demasiado corto para ser un token real.
    assert.equal(isValidBotToken('123456:corto'), false);
});

test('isValidChatId rechaza el placeholder MOVED_TO_HOME_DOT_CLAUDE_SECRETS', () => {
    assert.equal(isValidChatId('6529617704'), true);
    assert.equal(isValidChatId('-1001234567890'), true);
    assert.equal(isValidChatId('@canal_qa'), true);
    assert.equal(isValidChatId(PLACEHOLDER_CHAT), false);
    assert.equal(isValidChatId(''), false);
    assert.equal(isValidChatId(null), false);
});

test('CA-1: con placeholders en telegram-config.json cae al store unificado', () => {
    const cred = resolve({
        legacyConfig: { bot_token: PLACEHOLDER_TOKEN, chat_id: PLACEHOLDER_CHAT },
    });

    assert.equal(cred.valid, true);
    assert.equal(cred.botToken, STORE_TOKEN);
    assert.equal(cred.chatId, '6529617704');
    assert.equal(cred.botTokenSource, 'store:credentials.json');
    assert.equal(cred.chatIdSource, 'store:credentials.json');
    assert.deepEqual(cred.missing, []);
});

test('el legacy se usa como fallback cuando el store no tiene credenciales', () => {
    const cred = resolve({
        store: {},
        legacyConfig: { bot_token: LEGACY_TOKEN, chat_id: '999' },
    });

    assert.equal(cred.valid, true);
    assert.equal(cred.botToken, LEGACY_TOKEN);
    assert.equal(cred.chatId, '999');
    assert.match(cred.botTokenSource, /^legacy:/);
});

test('process.env valido tiene precedencia sobre el store', () => {
    const cred = resolve({
        env: { TELEGRAM_BOT_TOKEN: ENV_TOKEN, TELEGRAM_CHAT_ID: '4242' },
        legacyConfig: { bot_token: PLACEHOLDER_TOKEN, chat_id: PLACEHOLDER_CHAT },
    });

    assert.equal(cred.botToken, ENV_TOKEN);
    assert.equal(cred.chatId, '4242');
    assert.equal(cred.botTokenSource, 'env:TELEGRAM_BOT_TOKEN');
});

test('env con placeholder no bloquea: se descarta y gana el store', () => {
    const cred = resolve({
        env: { TELEGRAM_BOT_TOKEN: PLACEHOLDER_TOKEN, TELEGRAM_CHAT_ID: PLACEHOLDER_CHAT },
        legacyConfig: {},
    });

    assert.equal(cred.botToken, STORE_TOKEN);
    assert.equal(cred.botTokenSource, 'store:credentials.json');
});

test('token y chat_id se resuelven de forma independiente', () => {
    // env trae un token valido pero un chat_id placeholder: el chat debe salir
    // del store sin arrastrar al token.
    const cred = resolve({
        env: { TELEGRAM_BOT_TOKEN: ENV_TOKEN, TELEGRAM_CHAT_ID: PLACEHOLDER_CHAT },
        legacyConfig: {},
    });

    assert.equal(cred.botTokenSource, 'env:TELEGRAM_BOT_TOKEN');
    assert.equal(cred.chatIdSource, 'store:credentials.json');
    assert.equal(cred.valid, true);
});

test('sponsor_chat_id conserva prioridad sobre chat_id en el legacy', () => {
    const cred = resolve({
        store: {},
        legacyConfig: { bot_token: LEGACY_TOKEN, sponsor_chat_id: '777', chat_id: '888' },
    });

    assert.equal(cred.chatId, '777');
    assert.match(cred.chatIdSource, /sponsor_chat_id$/);
});

test('sponsor_chat_id placeholder no pisa a un chat_id valido', () => {
    const cred = resolve({
        store: {},
        legacyConfig: { bot_token: LEGACY_TOKEN, sponsor_chat_id: PLACEHOLDER_CHAT, chat_id: '888' },
    });

    assert.equal(cred.chatId, '888');
});

test('CA-3: sin credenciales validas en ninguna fuente devuelve valid:false y mensaje explicito', () => {
    const cred = resolve({
        store: {},
        legacyConfig: { bot_token: PLACEHOLDER_TOKEN, chat_id: PLACEHOLDER_CHAT },
    });

    assert.equal(cred.valid, false);
    assert.equal(cred.botToken, '');
    assert.equal(cred.chatId, '');
    assert.deepEqual(cred.missing, ['bot_token', 'chat_id']);

    const msg = describeMissingTelegramCredentials(cred);
    assert.match(msg, /credenciales de Telegram no configuradas/);
    assert.match(msg, /bot_token y chat_id/);
    assert.match(msg, /credentials\.json/);
    assert.match(msg, /telegram-config\.json/);
    // El mensaje no debe filtrar ningun valor de credencial.
    assert.ok(!msg.includes(STORE_TOKEN));
});

test('legacy ilegible (archivo inexistente) no rompe: resuelve del store', () => {
    const cred = resolve({
        legacyConfigPath: path.join(tmpDir, 'telegram-config-inexistente.json'),
    });

    assert.equal(cred.valid, true);
    assert.equal(cred.botTokenSource, 'store:credentials.json');
});

test('store con credentials.json invalido no rompe: cae al legacy', () => {
    const brokenPath = path.join(tmpDir, 'credentials-roto.json');
    fs.writeFileSync(brokenPath, '{ esto no es json', 'utf8');

    const cred = resolveTelegramCredentials({
        env: {},
        canonicalPath: brokenPath,
        storeLegacyPath,
        legacyConfig: { bot_token: LEGACY_TOKEN, chat_id: '555' },
    });

    assert.equal(cred.valid, true);
    assert.equal(cred.botToken, LEGACY_TOKEN);
});

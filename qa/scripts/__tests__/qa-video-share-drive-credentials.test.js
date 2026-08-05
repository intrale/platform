// =============================================================================
// Tests resolucion de credenciales de Google Drive en qa-video-share.js — #5172
//
// Cubre el bug real que bloqueo la aprobacion del issue #5172: el job
// `.pipeline/servicios/drive/fallido/drive-5172-*.json` fallo con
// "Google Drive no configurado" aunque las credenciales existian en el store
// externo. Causa: Drive leia UNICAMENTE `.claude/hooks/telegram-config.json`,
// que es tracked por git y cuya copia commiteada NO tiene claves `google_*`.
// Cada respawn con `reset --hard` las borraba y la evidencia de QA se perdia.
//
//   - store externo como fuente canonica (sobrevive al respawn)
//   - precedencia env > store > legacy, con placeholders descartados
//   - regresion del bug: legacy vacio + store poblado => Drive configurado
//   - sin ninguna fuente => oauthReady:false + mensaje accionable que nombra
//     las tres fuentes y NO vuelca ningun valor secreto
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    resolveDriveCredentials,
    describeMissingDriveCredentials,
} = require('../qa-video-share');

// Valores sinteticos — no son credenciales reales.
const STORE_CLIENT_ID = '111111111111-storefake.apps.googleusercontent.com';
const STORE_SECRET = 'GOCSPX-storeFakeSecret0123456789';
const STORE_REFRESH = '1//0eStoreFakeRefreshToken-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const STORE_FOLDER = '1StoreFakeFolderIdForUnitTests0000';

const ENV_REFRESH = '1//0eEnvFakeRefreshToken-ZZZZZZZZZZZZZZZZZZZZZZ';
const LEGACY_REFRESH = '1//0eLegacyFakeRefreshToken-YYYYYYYYYYYYYYYYYY';

const PLACEHOLDER = 'MOVED_TO_HOME_DOT_CLAUDE_SECRETS';

let tmpDir = '';
let canonicalPath = '';
let storeLegacyPath = '';

test.before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-5172-'));
    canonicalPath = path.join(tmpDir, 'credentials.json');
    // Apunta a un archivo inexistente para que el loader no caiga al ~/.claude
    // real de la maquina que corre los tests.
    storeLegacyPath = path.join(tmpDir, 'no-existe-legacy.json');
    fs.writeFileSync(canonicalPath, JSON.stringify({
        google_drive: {
            oauth_client_id: STORE_CLIENT_ID,
            oauth_client_secret: STORE_SECRET,
            oauth_refresh_token: STORE_REFRESH,
            drive_folder_id: STORE_FOLDER,
        },
    }), 'utf8');
});

test.after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
});

function resolve(overrides = {}) {
    return resolveDriveCredentials({
        env: {},
        legacyConfig: {},
        canonicalPath,
        storeLegacyPath,
        ...overrides,
    });
}

test('el store externo alcanza para configurar Drive sin tocar el legacy', () => {
    const cred = resolve();
    assert.equal(cred.oauthReady, true);
    assert.deepEqual(cred.missing, []);
    assert.equal(cred.clientId, STORE_CLIENT_ID);
    assert.equal(cred.clientSecret, STORE_SECRET);
    assert.equal(cred.refreshToken, STORE_REFRESH);
    assert.equal(cred.refreshTokenSource, 'store:credentials.json');
});

test('el folder_id tambien se resuelve desde el store', () => {
    const cred = resolve();
    assert.equal(cred.folderId, STORE_FOLDER);
    assert.equal(cred.folderIdSource, 'store:credentials.json');
});

test('regresion #5172: legacy sin claves google_* (copia commiteada) NO apaga Drive', () => {
    // Estado exacto tras `git reset --hard` del respawn: el archivo versionado
    // existe pero solo tiene bot_token/chat_id, sin ninguna clave google_*.
    const cred = resolve({
        legacyConfig: { bot_token: 'x', chat_id: 'y' },
    });
    assert.equal(cred.oauthReady, true, 'con el store poblado Drive debe quedar configurado');
});

test('env tiene precedencia sobre el store', () => {
    const cred = resolve({
        env: { GOOGLE_OAUTH_REFRESH_TOKEN: ENV_REFRESH },
    });
    assert.equal(cred.refreshToken, ENV_REFRESH);
    assert.equal(cred.refreshTokenSource, 'env:GOOGLE_OAUTH_REFRESH_TOKEN');
    // Las otras dos siguen saliendo del store.
    assert.equal(cred.clientIdSource, 'store:credentials.json');
});

test('el store tiene precedencia sobre el legacy', () => {
    const cred = resolve({
        legacyConfig: { google_oauth_refresh_token: LEGACY_REFRESH },
    });
    assert.equal(cred.refreshToken, STORE_REFRESH);
    assert.equal(cred.refreshTokenSource, 'store:credentials.json');
});

test('el legacy sigue sirviendo de fallback cuando el store no tiene google_drive', () => {
    const vacio = path.join(tmpDir, 'store-sin-drive.json');
    fs.writeFileSync(vacio, JSON.stringify({ telegram: { bot_token: 'x' } }), 'utf8');
    const cred = resolve({
        canonicalPath: vacio,
        legacyConfig: {
            google_oauth_client_id: STORE_CLIENT_ID,
            google_oauth_client_secret: STORE_SECRET,
            google_oauth_refresh_token: LEGACY_REFRESH,
        },
    });
    assert.equal(cred.oauthReady, true);
    assert.equal(cred.refreshToken, LEGACY_REFRESH);
    assert.equal(cred.refreshTokenSource, 'legacy:telegram-config.json');
});

test('un placeholder en el store se descarta y cae al legacy', () => {
    const conPlaceholder = path.join(tmpDir, 'store-placeholder.json');
    fs.writeFileSync(conPlaceholder, JSON.stringify({
        google_drive: {
            oauth_client_id: STORE_CLIENT_ID,
            oauth_client_secret: STORE_SECRET,
            oauth_refresh_token: PLACEHOLDER,
        },
    }), 'utf8');
    const cred = resolve({
        canonicalPath: conPlaceholder,
        legacyConfig: { google_oauth_refresh_token: LEGACY_REFRESH },
    });
    assert.equal(cred.refreshToken, LEGACY_REFRESH);
    assert.equal(cred.refreshTokenSource, 'legacy:telegram-config.json');
});

test('sin ninguna fuente => oauthReady:false y lista de faltantes completa', () => {
    const vacio = path.join(tmpDir, 'store-vacio.json');
    fs.writeFileSync(vacio, JSON.stringify({}), 'utf8');
    const cred = resolve({ canonicalPath: vacio });
    assert.equal(cred.oauthReady, false);
    assert.deepEqual(
        cred.missing.sort(),
        ['oauth_client_id', 'oauth_client_secret', 'oauth_refresh_token'],
    );
});

test('el mensaje de fallo nombra las tres fuentes y NO vuelca valores secretos', () => {
    const vacio = path.join(tmpDir, 'store-vacio-2.json');
    fs.writeFileSync(vacio, JSON.stringify({}), 'utf8');
    const cred = resolve({ canonicalPath: vacio });
    const msg = describeMissingDriveCredentials(cred);

    // Accionable: dice que falta y donde se busco.
    assert.match(msg, /oauth_client_id/);
    assert.match(msg, /GOOGLE_OAUTH_REFRESH_TOKEN/);
    assert.match(msg, /credentials\.json/);
    assert.match(msg, /telegram-config\.json/);

    // Assert negativo explicito: ningun valor secreto en el mensaje.
    for (const secreto of [STORE_SECRET, STORE_REFRESH, ENV_REFRESH, LEGACY_REFRESH]) {
        assert.equal(msg.includes(secreto), false, 'el mensaje no debe volcar ' + secreto);
    }
});

test('resolver con credenciales presentes tampoco expone el refresh_token en el mensaje', () => {
    // Defensa en profundidad: aunque el llamador arme el mensaje por error con
    // credenciales validas, no debe filtrar el token.
    const cred = resolve();
    const msg = describeMissingDriveCredentials(cred);
    assert.equal(msg.includes(STORE_REFRESH), false);
});

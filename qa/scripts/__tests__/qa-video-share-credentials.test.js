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
const https = require('https');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const {
    resolveTelegramCredentials,
    describeMissingTelegramCredentials,
    isValidBotToken,
    isValidChatId,
    // #5217: resolvedor generico + specs de Drive y R2.
    resolveCredential,
    describeMissingCredentials,
    resolveDriveServiceAccountPath,
    warnIfDriveFolderMissing,
    driveGetOrCreateFolder,
    resolveDriveParentId,
    DRIVE_ROOT_FOLDER_ID,
    DRIVE_SPEC,
    R2_SPEC,
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

// =============================================================================
// #5217 — Google Drive y Cloudflare R2 sobre el MISMO resolvedor.
//
// El defecto que cierran estos tests: los valores de Drive estaban bien
// guardados en el store canonico (anidados bajo `google_drive`) y aun asi no
// llegaban, porque el consumidor los buscaba con los nombres flat del legacy en
// un archivo del repo que cada `reset --hard` restaura vacio. La cadena
// colapsaba a "" sin error.
//
// SEC-6: todos los valores de abajo son SINTETICOS y el store se inyecta por
// `storeData`. Ningun test lee `~/.claude/secrets/credentials.json` real.
// =============================================================================

const DRIVE_STORE = {
    google_drive: {
        oauth_client_id: 'store-client-id.apps.googleusercontent.com',
        oauth_client_secret: 'STORE-fake-client-secret-000',
        oauth_refresh_token: '1//store-fake-refresh-token-0000000000',
        drive_folder_id: '1StoreFakeFolderIdForUnitTests00',
    },
};

// Nombres flat del formato legacy (los del body original del issue).
const DRIVE_LEGACY = {
    google_oauth_client_id: 'legacy-client-id.apps.googleusercontent.com',
    google_oauth_client_secret: 'LEGACY-fake-client-secret-000',
    google_oauth_refresh_token: '1//legacy-fake-refresh-token-000000000',
    google_drive_folder_id: '1LegacyFakeFolderIdForUnitTest00',
};

function resolveDrive(overrides = {}) {
    return resolveCredential(DRIVE_SPEC, {
        env: {},
        legacyConfig: {},
        storeData: DRIVE_STORE,
        ...overrides,
    });
}

test('CA-1: Drive resuelve los 4 scopes desde el namespace google_drive del store', () => {
    const cred = resolveDrive();

    assert.equal(cred.valid, true);
    assert.deepEqual(cred.missing, []);
    assert.equal(cred.values.clientId, DRIVE_STORE.google_drive.oauth_client_id);
    assert.equal(cred.values.clientSecret, DRIVE_STORE.google_drive.oauth_client_secret);
    assert.equal(cred.values.refreshToken, DRIVE_STORE.google_drive.oauth_refresh_token);
    assert.equal(cred.values.folderId, DRIVE_STORE.google_drive.drive_folder_id);
    assert.equal(cred.stateLabel, 'configurado');
});

test('CA-1: los dot-paths son los anidados; los nombres flat NO resuelven desde el store', () => {
    // Reproduce el error del body original: buscar `google_oauth_client_id` como
    // clave top-level del store. getNested() devuelve undefined y se saltea en
    // silencio — el fix queda sin efecto.
    const cred = resolveDrive({ storeData: DRIVE_LEGACY });

    assert.equal(cred.valid, false);
    assert.deepEqual(cred.missing, [
        'oauth_client_id', 'oauth_client_secret', 'oauth_refresh_token', 'drive_folder_id',
    ]);
});

test('CA-3: precedencia env > store > legacy para Drive', () => {
    const cred = resolveDrive({
        env: { GOOGLE_OAUTH_CLIENT_ID: 'env-client-id.apps.googleusercontent.com' },
        legacyConfig: DRIVE_LEGACY,
    });

    assert.equal(cred.values.clientId, 'env-client-id.apps.googleusercontent.com');
    assert.equal(cred.sources.clientId, 'env:GOOGLE_OAUTH_CLIENT_ID');
    // Los otros tres siguen saliendo del store, que le gana al legacy.
    assert.equal(cred.sources.clientSecret, 'store:google_drive.oauth_client_secret');
    assert.equal(cred.values.refreshToken, DRIVE_STORE.google_drive.oauth_refresh_token);
});

test('CA-3: el legacy es el ultimo recurso cuando el store no tiene el namespace', () => {
    const cred = resolveDrive({ storeData: {}, legacyConfig: DRIVE_LEGACY });

    assert.equal(cred.valid, true);
    assert.equal(cred.values.clientId, DRIVE_LEGACY.google_oauth_client_id);
    assert.match(cred.sources.clientId, /^legacy:telegram-config\.json#google_oauth_client_id$/);
    assert.equal(cred.storeNamespaceFound, false);
});

test('CA-3: un placeholder en un nivel NO corta la cadena, cae al siguiente', () => {
    const cred = resolveDrive({
        env: { GOOGLE_OAUTH_CLIENT_ID: 'MOVED_TO_HOME_DOT_CLAUDE_SECRETS' },
        legacyConfig: DRIVE_LEGACY,
    });

    // El env con placeholder se descarta y gana el store — no se propaga vacio.
    assert.equal(cred.values.clientId, DRIVE_STORE.google_drive.oauth_client_id);
    assert.equal(cred.sources.clientId, 'store:google_drive.oauth_client_id');
});

test('CA-3: un placeholder EN EL STORE cae al legacy sin arrastrar a los demas campos', () => {
    const cred = resolveDrive({
        storeData: {
            google_drive: Object.assign({}, DRIVE_STORE.google_drive, {
                oauth_refresh_token: 'REVOKED',
            }),
        },
        legacyConfig: DRIVE_LEGACY,
    });

    assert.equal(cred.values.refreshToken, DRIVE_LEGACY.google_oauth_refresh_token);
    assert.match(cred.sources.refreshToken, /^legacy:/);
    // Los campos sanos siguen viniendo del store.
    assert.equal(cred.sources.clientId, 'store:google_drive.oauth_client_id');
});

test('CA-3: sources reporta el origen de CADA campo (diagnostico sin investigacion)', () => {
    const cred = resolveDrive({
        env: { GOOGLE_DRIVE_FOLDER_ID: '1EnvFakeFolderIdForUnitTests0000' },
        legacyConfig: { google_oauth_refresh_token: DRIVE_LEGACY.google_oauth_refresh_token },
        storeData: {
            google_drive: {
                oauth_client_id: DRIVE_STORE.google_drive.oauth_client_id,
                oauth_client_secret: DRIVE_STORE.google_drive.oauth_client_secret,
            },
        },
    });

    assert.deepEqual(cred.sources, {
        clientId: 'store:google_drive.oauth_client_id',
        clientSecret: 'store:google_drive.oauth_client_secret',
        refreshToken: 'legacy:telegram-config.json#google_oauth_refresh_token',
        folderId: 'env:GOOGLE_DRIVE_FOLDER_ID',
    });
    assert.equal(cred.valid, true);
});

test('CA-2: con el archivo del repo vacio de Drive, el store alcanza (sobrevive al respawn)', () => {
    // Estado exacto tras `git reset --hard`: el config trackeado no tiene
    // ninguna clave de Drive. Antes del fix, esto daba "" en los 4 campos.
    const cred = resolveDrive({ legacyConfig: {} });

    assert.equal(cred.valid, true);
    Object.values(cred.sources).forEach((s) => assert.match(s, /^store:google_drive\./));
});

test('CA-10: el mensaje de Drive nombra el store canonico, lista fuentes en orden y no filtra valores', () => {
    const cred = resolveDrive({ storeData: {}, legacyConfig: {} });
    const msg = describeMissingCredentials(cred);

    assert.match(msg, /credenciales de Google Drive no configuradas/);
    assert.match(msg, /Fuentes consultadas \(en orden\)/);
    assert.match(msg, /env GOOGLE_OAUTH_CLIENT_ID/);
    assert.match(msg, /credentials\.json#google_drive/);
    assert.match(msg, /telegram-config\.json \(legacy, solo lectura\)/);
    // Formato de #4907: que falta, fuentes en orden, como resolverlo.
    assert.match(msg, /Se resuelve escribiendo google_drive\.oauth_client_id/);

    // CA-9: el mensaje NO instruye a escribir en el archivo del repo ni a pasar
    // el secreto por linea de comandos.
    assert.ok(!/definir google_oauth_/i.test(msg));
    assert.ok(!/<CLIENT_SECRET>/.test(msg));

    // SEC-6: ningun valor de credencial en el texto.
    Object.values(DRIVE_STORE.google_drive).forEach((v) => assert.ok(!msg.includes(v)));
});

test('CA-13/CA-14: R2 sin ninguna clave en ningun almacen queda "no provisionado"', () => {
    const cred = resolveCredential(R2_SPEC, { env: {}, legacyConfig: {}, storeData: {} });

    assert.equal(cred.valid, false);
    assert.equal(cred.state, 'absent');
    assert.equal(cred.stateLabel, 'no provisionado');
    assert.equal(cred.storeNamespaceFound, false);
    // El bucket tiene default: es configuracion, no credencial.
    assert.equal(cred.values.bucket, 'intrale-qa-evidence');
    assert.ok(!cred.missing.includes('bucket'));
    // R2 no consulta el archivo del repo: no debe aparecer entre sus fuentes.
    assert.ok(!cred.sourcesConsulted.some((s) => /telegram-config\.json/.test(s)));
});

test('CA-14: R2 provisionado a medias reporta "configuracion incompleta", no "no provisionado"', () => {
    const cred = resolveCredential(R2_SPEC, {
        env: {}, legacyConfig: {},
        storeData: { r2: { account_id: 'fake-account-id-0000' } },
    });

    assert.equal(cred.state, 'partial');
    assert.equal(cred.stateLabel, 'configuracion incompleta');
    assert.deepEqual(cred.missing, ['access_key_id', 'secret_access_key']);
    assert.equal(cred.storeNamespaceFound, true);
});

test('CA-13: R2 resuelve desde el namespace r2 del store cuando existe', () => {
    const cred = resolveCredential(R2_SPEC, {
        env: {}, legacyConfig: {},
        storeData: {
            r2: {
                account_id: 'fake-account-id-0000',
                access_key_id: 'fake-access-key-id-0000',
                secret_access_key: 'fake-secret-access-key-0000',
                bucket: 'fake-bucket',
            },
        },
    });

    assert.equal(cred.valid, true);
    assert.equal(cred.stateLabel, 'configurado');
    assert.equal(cred.sources.secretAccessKey, 'store:r2.secret_access_key');
});

test('google_credentials_path se resuelve como CONFIG (no como scope del vault)', () => {
    // Es un path al JSON de service account, y el SA es el fallback (OAuth gana).
    // Se valida por forma y reporta fuente, sin cadena que colapse a "".
    assert.equal(
        resolveDriveServiceAccountPath({ env: { GOOGLE_CREDENTIALS_PATH: '/tmp/sa.json' }, legacyConfig: {} }),
        '/tmp/sa.json',
    );
    assert.equal(
        resolveDriveServiceAccountPath({ env: {}, legacyConfig: { google_credentials_path: '/tmp/legacy-sa.json' } }),
        '/tmp/legacy-sa.json',
    );
    // Placeholder en env no bloquea: cae al legacy.
    assert.equal(
        resolveDriveServiceAccountPath({
            env: { GOOGLE_CREDENTIALS_PATH: 'MOVED_TO_HOME_DOT_CLAUDE_SECRETS' },
            legacyConfig: { google_credentials_path: '/tmp/legacy-sa.json' },
        }),
        '/tmp/legacy-sa.json',
    );
    assert.equal(resolveDriveServiceAccountPath({ env: {}, legacyConfig: {} }), '');
});

test('R-5: los exports de #4907 conservan nombre y firma', () => {
    // Hay tests y consumidores que los importan por nombre: generalizar no puede
    // romperlos. El wrapper delega en el resolvedor generico.
    assert.equal(typeof resolveTelegramCredentials, 'function');
    assert.equal(typeof describeMissingTelegramCredentials, 'function');
    const cred = resolve({ store: {}, legacyConfig: { bot_token: LEGACY_TOKEN, chat_id: '123' } });
    assert.equal(cred.botToken, LEGACY_TOKEN);
    assert.equal(cred.chatId, '123');
    assert.equal(typeof cred.botTokenSource, 'string');
    assert.equal(cred.valid, true);
    assert.deepEqual(cred.missing, []);
});

// =============================================================================
// Correcciones de la revision de #5217 (defectos hallados en la auditoria del
// propio cambio, antes de commitear).
// =============================================================================

test('CA-10: sourcesConsulted nombra el store REALMENTE consultado, no el default del modulo', () => {
    // Si el mensaje nombra un store distinto del que se leyo, manda al operador
    // al lugar equivocado: el mismo modo de falla que #5217 cierra.
    const cred = resolveDrive({ canonicalPath: '/fixture/alt-store.json', storeData: undefined });
    assert.ok(
        cred.sourcesConsulted.some((x) => x.indexOf('/fixture/alt-store.json#google_drive') !== -1),
        'sourcesConsulted deberia nombrar el canonicalPath inyectado: ' + cred.sourcesConsulted.join(' > '),
    );
});

test('CA-10: el diagnostico de Drive nombra tambien el fallback de Service Account', () => {
    // `driveAvailable()` consulta el JSON de Service Account cuando el triplete
    // OAuth no resuelve. Si el diagnostico no lo nombra, el operador con el path
    // mal apuntado nunca ve la fuente que realmente fallo.
    const cred = resolveDrive({ storeData: {}, legacyConfig: {} });
    const msg = describeMissingCredentials(cred);
    assert.match(msg, /GOOGLE_CREDENTIALS_PATH/);
    assert.match(msg, /Service Account/i);
    // SEC-6: el mensaje no filtra ningun valor.
    assert.ok(msg.indexOf(DRIVE_STORE.google_drive.oauth_client_secret) === -1);
    assert.ok(msg.indexOf(DRIVE_STORE.google_drive.oauth_refresh_token) === -1);
});

test('describeMissingCredentials no explota con un objeto viejo o parcial', () => {
    // Corre en el camino de ERROR: un TypeError propio taparia el diagnostico
    // que el operador necesita para destrabarse.
    assert.doesNotThrow(() => describeMissingCredentials({ missing: ['bot_token'], valid: false }));
    assert.doesNotThrow(() => describeMissingCredentials({}));
    const msg = describeMissingCredentials({ label: 'X', missing: ['bot_token'], valid: false });
    assert.match(msg, /bot_token/);
});

test('drive_folder_id ausente avisa que la evidencia va a la RAIZ del Drive', () => {
    // Degradar en silencio (subir a la raiz sin decir nada) es exactamente el
    // modo de falla que #5217 cierra.
    const lines = [];
    const original = console.warn;
    console.warn = (m) => lines.push(String(m));
    try {
        const warned = warnIfDriveFolderMissing('', { force: true, canonicalPath: '/fixture/store.json' });
        assert.equal(warned, true);
        // Con folderId valido no avisa.
        assert.equal(warnIfDriveFolderMissing('1RealFolderId', { force: true }), false);
        // Un placeholder tampoco cuenta como configurado.
        assert.equal(warnIfDriveFolderMissing(PLACEHOLDER_CHAT, { force: true }), true);
    } finally {
        console.warn = original;
    }
    assert.equal(lines.length, 2);
    assert.match(lines[0], /RAIZ del Drive/);
    assert.match(lines[0], /GOOGLE_DRIVE_FOLDER_ID/);
    assert.match(lines[0], /\/fixture\/store\.json#google_drive\.drive_folder_id/);
    // CA-9: no propone escribirlo en el archivo trackeado del repo.
    assert.ok(!/escrib\w*\s+\w*\s*telegram-config/i.test(lines[0]));
});

async function captureDriveFolderRequests(parentId) {
    const requests = [];
    const originalRequest = https.request;

    https.request = (options, callback) => {
        const request = new EventEmitter();
        let body = '';
        request.write = (chunk) => { body += String(chunk); };
        request.destroy = () => {};
        request.end = () => {
            requests.push({ options, body });
            const response = new EventEmitter();
            callback(response);
            const payload = requests.length === 1
                ? JSON.stringify({ files: [] })
                : JSON.stringify({ id: 'created-folder', name: '#5217' });
            queueMicrotask(() => {
                response.emit('data', payload);
                response.emit('end');
            });
        };
        return request;
    };

    try {
        const folderId = await driveGetOrCreateFolder('fake-access-token', '#5217', parentId);
        assert.equal(folderId, 'created-folder');
    } finally {
        https.request = originalRequest;
    }
    return requests;
}

test('Drive representa el folder ausente como root en los requests de listar y crear', async () => {
    assert.equal(resolveDriveParentId(''), DRIVE_ROOT_FOLDER_ID);
    const requests = await captureDriveFolderRequests('');

    assert.equal(requests.length, 2);
    assert.match(decodeURIComponent(requests[0].options.path), /'root' in parents/);
    assert.deepEqual(JSON.parse(requests[1].body).parents, ['root']);
});

test('Drive preserva el folder configurado en los requests de listar y crear', async () => {
    const configuredFolderId = '1ConfiguredDriveFolder';
    assert.equal(resolveDriveParentId(configuredFolderId), configuredFolderId);
    const requests = await captureDriveFolderRequests(configuredFolderId);

    assert.equal(requests.length, 2);
    assert.match(
        decodeURIComponent(requests[0].options.path),
        new RegExp("'" + configuredFolderId + "' in parents")
    );
    assert.deepEqual(JSON.parse(requests[1].body).parents, [configuredFolderId]);
});

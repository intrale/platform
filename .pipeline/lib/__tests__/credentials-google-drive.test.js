// =============================================================================
// Tests de resolucion de credenciales de Google Drive — Issues #5172 y #5217
//
// #5172 (origen): las credenciales de Drive vivian SOLO en
// `.claude/hooks/telegram-config.json`, archivo tracked por git cuya copia
// commiteada no las contiene. Cada respawn con `reset --hard` las borraba y
// `qa-video-share` fallaba con "Google Drive no configurado", perdiendo la
// evidencia de QA. La cura fue moverlas al store canonico, que sobrevive al
// reset. ESO NO CAMBIA: sigue siendo el objetivo y lo cubren los tests de abajo.
//
// #5217 · CA-6 (que cambio): la primera implementacion las hidrataba via
// `ENV_MAPPING`, o sea `loadIntoEnv()` las escribia en el `process.env` global.
// Ese ambiente lo hereda TODO proceso hijo de TODO agente (`pulpo.js:18`,
// `restart.js:47`), incluidos los CLIs de providers de IA de terceros. Un
// refresh token de Google no tiene por que estar ahi: su unico consumidor es
// `qa/scripts/qa-video-share.js`, que desde #5217 lo resuelve BAJO DEMANDA por
// namespace con `resolveScopedRefs`, sin tocar `process.env`.
//
// Por eso este archivo verifica dos cosas a la vez:
//   1. que Drive resuelve desde el store canonico (objetivo de #5172), y
//   2. que NO se hidrata en el ambiente global (CA-6 de #5217).
// Las 4 claves siguen en `ENV_DESCRIPTORS` —o sea el vault las provisiona, las
// rota y la politica IAM las cubre—; lo unico que no ocurre es la inyeccion en
// el env. Ver `credentials-vault-5353.test.js` para el lado del inventario.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const credentials = require('../credentials');

const FAKE_CLIENT_ID = '111111111111-fake.apps.googleusercontent.com';
const FAKE_SECRET = 'GOCSPX-fakeSecretForUnitTests0123';
const FAKE_REFRESH = '1//0eFakeRefreshTokenForUnitTests-ABCDEFGHIJ';
const FAKE_FOLDER = '1FakeFolderIdForUnitTests000000000';

const DRIVE_SCOPES = [
    'oauth_client_id', 'oauth_client_secret', 'oauth_refresh_token', 'drive_folder_id',
];
const DRIVE_ENV_VARS = [
    'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET',
    'GOOGLE_OAUTH_REFRESH_TOKEN', 'GOOGLE_DRIVE_FOLDER_ID',
];

// Ref SIEMPRE en forma tilde: el regex de `parseSecretRef` no admite `\` ni
// `C:`, asi que armarlo con un path absoluto de Windows devuelve
// `{ok:false, namespace:null}` sin lanzar excepcion. El path real del SO viaja
// por `opts.canonicalPath`, que `resolveScopedRefs` prioriza. Es el RIESGO A-1
// de #5217 y tiene test propio en `credentials-scoped-refs.test.js`.
const STORE_REF = '~/.claude/secrets/credentials.json#google_drive';

let tmpDir = '';
let canonicalPath = '';
let legacyPath = '';

test.before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-5172-'));
    canonicalPath = path.join(tmpDir, 'credentials.json');
    legacyPath = path.join(tmpDir, 'no-existe-legacy.json');
    fs.writeFileSync(canonicalPath, JSON.stringify({
        google_drive: {
            oauth_client_id: FAKE_CLIENT_ID,
            oauth_client_secret: FAKE_SECRET,
            oauth_refresh_token: FAKE_REFRESH,
            drive_folder_id: FAKE_FOLDER,
        },
    }), 'utf8');
});

test.after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
});

function hydrate(env = {}) {
    const result = credentials.loadIntoEnv({
        env, canonicalPath, legacyPath, logger: () => {},
    });
    return { env, result };
}

function resolverDrive(over = {}) {
    return credentials.resolveScopedRefs(STORE_REF, DRIVE_SCOPES, {
        canonicalPath, ...over,
    });
}

// -----------------------------------------------------------------------------
// #5172 — el store canonico alcanza (el objetivo original, por el camino nuevo)
// -----------------------------------------------------------------------------

test('las cuatro claves de google_drive se resuelven desde el store canonico', () => {
    const r = resolverDrive();
    assert.equal(r.ok, true);
    assert.equal(r.namespace, 'google_drive');
    assert.deepEqual(r.missing, []);
    assert.equal(r.scopes.oauth_client_id, FAKE_CLIENT_ID);
    assert.equal(r.scopes.oauth_client_secret, FAKE_SECRET);
    assert.equal(r.scopes.oauth_refresh_token, FAKE_REFRESH);
    assert.equal(r.scopes.drive_folder_id, FAKE_FOLDER);
});

test('un store sin seccion google_drive no rompe ni inventa valores', () => {
    const sinDrive = path.join(tmpDir, 'sin-drive.json');
    fs.writeFileSync(sinDrive, JSON.stringify({ telegram: { bot_token: 'x' } }), 'utf8');

    const r = resolverDrive({ canonicalPath: sinDrive });
    assert.equal(r.ok, false, 'namespace ausente => no resuelve');
    assert.equal(r.scopes.oauth_refresh_token, undefined, 'no inventa un valor vacio');
});

test('el reporte de resolucion no vuelca valores de credenciales', () => {
    // `redactScoped` es el unico serializador permitido para este resultado: los
    // tests rojos se pegan en issues y en Telegram, asi que un assert que
    // imprima el objeto crudo publicaria el refresh token.
    const r = resolverDrive();
    const serializado = JSON.stringify(credentials.redactScoped(r));
    for (const secreto of [FAKE_SECRET, FAKE_REFRESH, FAKE_CLIENT_ID]) {
        assert.equal(serializado.includes(secreto), false,
            'el reporte redactado no debe contener ' + secreto);
    }
});

// -----------------------------------------------------------------------------
// #5217 · CA-6 — y NO se hidratan en el process.env global
// -----------------------------------------------------------------------------

test('CA-6 · loadIntoEnv NO escribe las credenciales de Drive en el ambiente', () => {
    const { env, result } = hydrate();

    // El store se leyo bien (Telegram y providers siguen hidratandose igual):
    // que Drive no aparezca no es un fallo de lectura, es la decision de CA-6.
    assert.equal(result.source, 'canonical');

    for (const v of DRIVE_ENV_VARS) {
        assert.equal(env[v], undefined, v + ' no debe inyectarse en el ambiente');
        assert.equal(result.hydrated.includes(v), false, v + ' no debe figurar como hidratada');
    }
});

test('CA-6 · las 4 claves siguen en el inventario del vault, fuera de ENV_MAPPING', () => {
    const dotPaths = DRIVE_SCOPES.map((s) => 'google_drive.' + s);
    for (const dotPath of dotPaths) {
        assert.ok(credentials.ENV_DESCRIPTORS[dotPath],
            dotPath + ' debe seguir en el inventario (provision, rotacion, IAM)');
        assert.equal(credentials.seHidrata(credentials.ENV_DESCRIPTORS[dotPath]), false,
            dotPath + ' no debe hidratarse');
        assert.equal(credentials.ENV_MAPPING[dotPath], undefined,
            dotPath + ' no puede estar en ENV_MAPPING');
    }
});

test('CA-6 · un override por ambiente sigue siendo posible, pero lo lee el consumidor', () => {
    // El operador puede exportar GOOGLE_OAUTH_REFRESH_TOKEN a mano: el resolvedor
    // de `qa-video-share.js` lo consulta primero. Lo que no ocurre es que el
    // pipeline lo PROPAGUE solo a todos los hijos.
    const { env, result } = hydrate({ GOOGLE_OAUTH_REFRESH_TOKEN: 'override-operativo' });
    assert.equal(env.GOOGLE_OAUTH_REFRESH_TOKEN, 'override-operativo', 'no se pisa el override');
    assert.equal(result.skipped_existing.includes('GOOGLE_OAUTH_REFRESH_TOKEN'), false,
        'no participa del ciclo de hidratacion en ninguna de sus ramas');
});

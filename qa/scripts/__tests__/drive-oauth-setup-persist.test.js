// =============================================================================
// drive-oauth-setup-persist.test.js — #5217
//
// Cobertura del cierre del flujo OAuth de Drive: `finishTokenExchange`, que es
// quien decide el codigo de salida del script de provision.
//
// El defecto que originaba estos tests: un unico `try` envolvia el parseo de la
// respuesta Y la persistencia, y su `catch` terminaba en `process.exit(0)`.
// Como `writeCanonicalPaths` es fail-closed (LANZA si el store es ilegible),
// "no se pudo guardar el refresh token" se reportaba como EXITO. El operador —o
// la automatizacion— se iba convencido de que Drive quedaba provisionado, y en
// el proximo respawn la evidencia de QA se perdia igual que antes: la misma
// falla silenciosa que #5217 existe para eliminar.
//
// SEC-6: fixtures sinteticos, ningun valor real. Las assertions son por FORMA
// (codigo de salida, presencia/ausencia de un substring); no se imprime ni se
// asierta el contenido de ningun token.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const setup = require(path.resolve(__dirname, '..', '..', '..', 'scripts', 'google-drive-oauth-setup.js'));
const { finishTokenExchange, CANONICAL_KEYS } = setup;

// Valores sinteticos con forma de credencial, generados aca. No salen de ningun
// store ni se parecen a una credencial real.
const FAKE = Object.freeze({
    clientId: 'fake-client-id.apps.googleusercontent.com',
    clientSecret: 'FAKE-secret-no-real',
    refreshToken: '1//FAKE-refresh-token-sintetico',
    accessToken: 'ya29.FAKE-access-token-sintetico',
    folderId: 'FAKEFOLDERID123',
});

function okBody(extra) {
    return JSON.stringify(Object.assign({
        access_token: FAKE.accessToken,
        refresh_token: FAKE.refreshToken,
        expires_in: 3599,
    }, extra || {}));
}

// Capturador de log: junta las lineas para poder asertar por forma.
function makeLog() {
    const lines = [];
    const log = (s) => { lines.push(String(s)); };
    log.text = () => lines.join('\n');
    return log;
}

// --- El camino feliz sigue devolviendo 0 ---

test('finishTokenExchange devuelve 0 y lista las claves escritas cuando persiste bien', () => {
    const log = makeLog();
    const calls = [];
    const code = finishTokenExchange(okBody(), {
        clientId: FAKE.clientId,
        clientSecret: FAKE.clientSecret,
        folderId: FAKE.folderId,
        log,
        persist: (cid, cs, rt, fid) => {
            calls.push({ cid, cs, rt, fid });
            return {
                targetPath: '/fake/credentials.json',
                written: [
                    CANONICAL_KEYS.clientId,
                    CANONICAL_KEYS.clientSecret,
                    CANONICAL_KEYS.refreshToken,
                    CANONICAL_KEYS.folderId,
                ],
                backupPath: '/fake/credentials.json.bak',
            };
        },
    });

    assert.equal(code, 0);
    assert.equal(calls.length, 1, 'tiene que persistir exactamente una vez');
    assert.equal(calls[0].rt, FAKE.refreshToken, 'persiste el refresh token recibido');
    assert.equal(calls[0].fid, FAKE.folderId);

    // CA-12: nombra destino y claves, sin valores.
    assert.match(log.text(), /Guardado en el store canonico: \/fake\/credentials\.json/);
    assert.match(log.text(), /google_drive\.oauth_refresh_token/);
    assert.match(log.text(), /Backup previo/);
});

// --- El defecto: fallo de persistencia NO puede reportarse como exito ---

test('#5217: si la persistencia falla, el codigo de salida es 1 (no 0)', () => {
    const log = makeLog();
    const code = finishTokenExchange(okBody(), {
        clientId: FAKE.clientId,
        clientSecret: FAKE.clientSecret,
        folderId: FAKE.folderId,
        log,
        // writeCanonicalPaths es fail-closed: lanza si el store es ilegible.
        persist: () => { throw new Error('store ilegible: JSON invalido'); },
    });

    assert.equal(code, 1, 'un fallo de persistencia reportado como exito deja Drive roto en silencio');
});

test('#5217: el fallo de persistencia se explica de forma accionable y no dice "Listo"', () => {
    const log = makeLog();
    finishTokenExchange(okBody(), {
        clientId: FAKE.clientId,
        clientSecret: FAKE.clientSecret,
        folderId: '',
        log,
        persist: () => { throw new Error('store ilegible: JSON invalido'); },
    });

    const text = log.text();
    assert.match(text, /NO se pudo guardar/i, 'tiene que decir que NO se guardo');
    assert.match(text, /store ilegible: JSON invalido/, 'propaga el motivo real');
    assert.match(text, /credentials\.json/, 'nombra el archivo a revisar');
    assert.ok(!/^Listo/m.test(text), 'no puede anunciar exito despues de fallar');
});

test('SEC-6: el mensaje de fallo de persistencia no filtra el refresh token', () => {
    const log = makeLog();
    finishTokenExchange(okBody(), {
        clientId: FAKE.clientId,
        clientSecret: FAKE.clientSecret,
        folderId: FAKE.folderId,
        log,
        persist: () => { throw new Error('EACCES'); },
    });

    const text = log.text();
    assert.equal(text.indexOf(FAKE.refreshToken), -1, 'no vuelca el refresh token');
    assert.equal(text.indexOf(FAKE.accessToken), -1, 'no vuelca el access token');
    assert.equal(text.indexOf(FAKE.clientSecret), -1, 'no vuelca el client secret');
    // CWE-532: tampoco prefijos.
    assert.equal(text.indexOf(FAKE.refreshToken.slice(0, 20)), -1, 'no vuelca prefijos');
});

test('SEC-6: el camino feliz confirma por forma, sin valores ni prefijos', () => {
    const log = makeLog();
    finishTokenExchange(okBody(), {
        clientId: FAKE.clientId,
        clientSecret: FAKE.clientSecret,
        folderId: FAKE.folderId,
        log,
        persist: () => ({ targetPath: '/fake/c.json', written: [CANONICAL_KEYS.refreshToken] }),
    });

    const text = log.text();
    assert.match(text, /access_token: presente/);
    assert.match(text, /refresh_token: presente/);
    assert.equal(text.indexOf(FAKE.refreshToken.slice(0, 20)), -1);
    assert.equal(text.indexOf(FAKE.accessToken.slice(0, 20)), -1);
});

// --- Respuestas invalidas del token endpoint ---

test('finishTokenExchange devuelve 1 si el cuerpo no es JSON, sin persistir', () => {
    const log = makeLog();
    let persisted = false;
    const code = finishTokenExchange('<html>502 Bad Gateway</html>', {
        clientId: FAKE.clientId, clientSecret: FAKE.clientSecret, folderId: '',
        log,
        persist: () => { persisted = true; return {}; },
    });

    assert.equal(code, 1);
    assert.equal(persisted, false, 'no puede escribir el store con una respuesta que no parseo');
    assert.match(log.text(), /Error procesando la respuesta/);
});

test('finishTokenExchange devuelve 1 si el endpoint responde error, sin persistir', () => {
    const log = makeLog();
    let persisted = false;
    const code = finishTokenExchange(
        JSON.stringify({ error: 'invalid_grant', error_description: 'Bad Request' }),
        {
            clientId: FAKE.clientId, clientSecret: FAKE.clientSecret, folderId: '',
            log,
            persist: () => { persisted = true; return {}; },
        },
    );

    assert.equal(code, 1);
    assert.equal(persisted, false);
    assert.match(log.text(), /invalid_grant/);
});

test('finishTokenExchange devuelve 1 si no vino refresh_token, sin persistir', () => {
    const log = makeLog();
    let persisted = false;
    const code = finishTokenExchange(
        JSON.stringify({ access_token: FAKE.accessToken, expires_in: 3599 }),
        {
            clientId: FAKE.clientId, clientSecret: FAKE.clientSecret, folderId: '',
            log,
            persist: () => { persisted = true; return {}; },
        },
    );

    assert.equal(code, 1);
    assert.equal(persisted, false, 'sin refresh token no hay nada util que guardar');
    assert.match(log.text(), /No se recibio refresh_token/);
});

// --- folderId opcional (CA-12) ---

test('sin folderId escrito, avisa que la evidencia va a la raiz del Drive', () => {
    const log = makeLog();
    const code = finishTokenExchange(okBody(), {
        clientId: FAKE.clientId, clientSecret: FAKE.clientSecret, folderId: '',
        log,
        persist: () => ({
            targetPath: '/fake/c.json',
            written: [CANONICAL_KEYS.clientId, CANONICAL_KEYS.clientSecret, CANONICAL_KEYS.refreshToken],
        }),
    });

    assert.equal(code, 0);
    assert.match(log.text(), /RAIZ del Drive/);
});

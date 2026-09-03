// =============================================================================
// __tests__/credential-death-detector.test.js — Issue #6238.
//
// Cobertura del detector ESTRUCTURAL de credencial rechazada. La apuesta del
// issue es que la detección NO se puede inducir desde contenido: por eso la
// mitad de esta suite son fixtures NEGATIVOS tomados de material real que
// contiene la frase de error (incluido el body del propio #6238).
//
// PROCEDENCIA DE LOS FIXTURES (versionados en fixtures/credential-death/,
// generados una vez por build-fixtures.js y sanitizados):
//   * real-frame-a.jsonl / real-frame-a-plus-b.jsonl
//       ← `.pipeline/logs/5213-pipeline-dev.attempt-1.log` líneas 760-761,
//         la única muerte por credencial real conservada. Sin session_id,
//         sin uuid, sin costos, sin permission_denials.
//   * healthy-401-and-other-tokens.jsonl
//       ← shape de los `.attempt-*.log` SANOS (26 de 40 contienen "401").
//   * issue-6238-body.jsonl / poisoned-*.jsonl
//       ← el vector de inyección que denunció `security` (SEC-1/SEC-CA-3).
//
// Los tests NO leen de `.pipeline/logs/`: esos archivos se rotan y se pisan
// (#6245); un test que los lea se rompe solo.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    detectCredentialDeath,
    CREDENTIAL_DEATH_TOKENS,
} = require('../credential-death-detector');

const FIXTURES = path.join(__dirname, 'fixtures', 'credential-death');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

// La frase de error real. Vive acá SÓLO como dato: si el detector la mirara,
// los tests negativos de abajo fallarían.
const PHRASE = 'Failed to authenticate: OAuth session expired and could not be refreshed';

// -----------------------------------------------------------------------------
// POSITIVOS — la firma estructural del CLI
// -----------------------------------------------------------------------------

test('frame A real (error top-level + is_api_error_message) → matched, signature A', () => {
    const r = detectCredentialDeath(fixture('real-frame-a.jsonl'));
    assert.equal(r.matched, true);
    assert.equal(r.token, 'authentication_failed');
    assert.equal(r.signature, 'A');
});

test('frame A + frame B terminal → signature A+B (el refuerzo eleva, no habilita)', () => {
    const r = detectCredentialDeath(fixture('real-frame-a-plus-b.jsonl'));
    assert.equal(r.matched, true);
    assert.equal(r.token, 'authentication_failed');
    assert.equal(r.signature, 'A+B');
});

test('el token devuelto sale de la tabla cerrada, no del payload', () => {
    // Frame forjado cuyo `error` matchea la tabla: el string devuelto debe ser
    // IDÉNTICO (misma referencia lógica) al de la tabla, no una copia del frame.
    const line = JSON.stringify({ error: 'authentication_failed', is_api_error_message: true });
    const r = detectCredentialDeath(line);
    assert.equal(r.matched, true);
    assert.ok(CREDENTIAL_DEATH_TOKENS.includes(r.token));
    // La tabla es inmutable: nadie puede ampliar la superficie en runtime.
    assert.ok(Object.isFrozen(CREDENTIAL_DEATH_TOKENS));
    assert.throws(() => { CREDENTIAL_DEATH_TOKENS.push('inyectado'); });
});

test('el frame A puede venir precedido de prosa y de líneas no-JSON', () => {
    const tail = [
        'Booting agent...',
        'no soy json',
        JSON.stringify({ type: 'system', subtype: 'init' }),
        JSON.stringify({ error: 'authentication_failed', is_api_error_message: true }),
    ].join('\n');
    assert.equal(detectCredentialDeath(tail).matched, true);
});

// -----------------------------------------------------------------------------
// NEGATIVOS — auto-envenenamiento e inyección adversaria (CA-2 / SEC-CA-3)
// -----------------------------------------------------------------------------

test('auto-envenenamiento: la frase en message.content[].text NO clasifica', () => {
    const tail = fixture('poisoned-assistant-text.jsonl');
    // Sanity del fixture: la frase está REALMENTE ahí (si no, el test pasaría
    // por vacuidad y no probaría nada).
    assert.ok(tail.includes(PHRASE));
    assert.equal(detectCredentialDeath(tail).matched, false);
});

test('inyección adversaria: la frase (y la firma JSON) dentro de un tool_result NO clasifica', () => {
    const tail = fixture('poisoned-tool-result.jsonl');
    assert.ok(tail.includes(PHRASE));
    // El fixture contiene la firma completa citada como texto dentro del
    // tool_result: es exactamente lo que un tercero puede escribir en un issue.
    // (En el .jsonl las comillas internas viajan escapadas — esa es justamente
    // la razón por la que `JSON.parse` de la línea deja `error` en undefined.)
    assert.ok(tail.includes('authentication_failed'));
    assert.ok(tail.includes('is_api_error_message'));
    assert.equal(detectCredentialDeath(tail).matched, false);
});

test('el body del propio #6238 embebido en un frame NO clasifica (fixture obligatorio CA-2)', () => {
    const tail = fixture('issue-6238-body.jsonl');
    assert.ok(tail.includes(PHRASE));
    assert.ok(tail.includes('401'));
    assert.equal(detectCredentialDeath(tail).matched, false);
});

test('el texto de este mismo archivo de test NO clasifica (prueba de auto-envenenamiento)', () => {
    // El archivo que estás leyendo contiene la frase, "401" y el token. Si el
    // detector fuera textual, el agente que implemente #6238 apagaría el motor.
    const selfText = fs.readFileSync(__filename, 'utf8');
    assert.ok(selfText.includes(PHRASE));
    assert.equal(detectCredentialDeath(selfText).matched, false);
});

// -----------------------------------------------------------------------------
// NEGATIVOS — firmas parciales y tokens fuera de la tabla
// -----------------------------------------------------------------------------

test('sólo frame B (5xx terminal) NO clasifica', () => {
    const r = detectCredentialDeath(fixture('frame-b-only-5xx.jsonl'));
    assert.equal(r.matched, false);
    assert.equal(r.signature, null);
});

test('"401" en prosa y error:"permission_error" en un log sano NO clasifican', () => {
    const tail = fixture('healthy-401-and-other-tokens.jsonl');
    assert.ok(tail.includes('401'));
    assert.ok(tail.includes('permission_error'));
    assert.equal(detectCredentialDeath(tail).matched, false);
});

test('error correcto pero sin is_api_error_message NO clasifica', () => {
    const line = JSON.stringify({ error: 'authentication_failed' });
    assert.equal(detectCredentialDeath(line).matched, false);
});

test('is_api_error_message truthy pero no === true NO clasifica', () => {
    const line = JSON.stringify({ error: 'authentication_failed', is_api_error_message: 'true' });
    assert.equal(detectCredentialDeath(line).matched, false);
});

test('error como OBJETO (no string) NO clasifica', () => {
    const line = JSON.stringify({ error: { type: 'authentication_failed' }, is_api_error_message: true });
    assert.equal(detectCredentialDeath(line).matched, false);
});

test('token fuera de la tabla cerrada NO clasifica', () => {
    for (const t of ['permission_error', 'invalid_api_key', 'authentication_error', '401', 'unknown']) {
        const line = JSON.stringify({ error: t, is_api_error_message: true });
        assert.equal(detectCredentialDeath(line).matched, false, `token "${t}" no debe clasificar`);
    }
});

test('firma anidada (no top-level) NO clasifica', () => {
    const line = JSON.stringify({
        type: 'assistant',
        message: { error: 'authentication_failed', is_api_error_message: true },
    });
    assert.equal(detectCredentialDeath(line).matched, false);
});

// -----------------------------------------------------------------------------
// FAIL-CLOSED (CA-7 / SEC-CA-4) — nunca tira, nunca clasifica por defecto
// -----------------------------------------------------------------------------

test('entradas inválidas → matched:false sin throw', () => {
    for (const bad of ['', null, undefined, 42, {}, [], true, NaN, Symbol('x')]) {
        let r;
        assert.doesNotThrow(() => { r = detectCredentialDeath(bad); });
        assert.deepEqual(r, { matched: false, token: null, signature: null });
    }
});

test('JSON truncado a mitad de línea → matched:false sin throw', () => {
    const full = JSON.stringify({ error: 'authentication_failed', is_api_error_message: true });
    const truncated = full.slice(0, full.length - 12);
    let r;
    assert.doesNotThrow(() => { r = detectCredentialDeath(truncated); });
    assert.equal(r.matched, false);
});

test('el slice del tail puede cortar la primera línea sin romper el barrido', () => {
    // Simula `raw.slice(-32*1024)`: la primera línea queda partida, la segunda
    // está entera y trae la firma.
    const tail = 'e":true,"session_id":"abc"}\n'
        + JSON.stringify({ error: 'authentication_failed', is_api_error_message: true });
    assert.equal(detectCredentialDeath(tail).matched, true);
});

test('línea JSON que parsea a array o a escalar se descarta', () => {
    const tail = [
        '[{"error":"authentication_failed","is_api_error_message":true}]',
        '"authentication_failed"',
        '123',
    ].join('\n');
    assert.equal(detectCredentialDeath(tail).matched, false);
});

test('el retorno es un objeto fresco (mutarlo no contamina la próxima llamada)', () => {
    const a = detectCredentialDeath('');
    a.matched = true;
    a.token = 'contaminado';
    const b = detectCredentialDeath('');
    assert.deepEqual(b, { matched: false, token: null, signature: null });
});

// -----------------------------------------------------------------------------
// INVARIANTE DE CÓDIGO — el módulo no decide por texto libre (CA-1)
// -----------------------------------------------------------------------------

test('el módulo no usa la frase ni "401" como control de flujo', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'credential-death-detector.js'), 'utf8');
    // Se permite mencionarlas en la cabecera de documentación, pero no puede
    // haber ninguna comparación textual en el cuerpo ejecutable.
    const body = src.split('\n')
        .filter((l) => {
            const t = l.trim();
            return t.length > 0 && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
        })
        .join('\n');
    assert.ok(!body.includes('OAuth session expired'), 'la frase no puede estar en el código ejecutable');
    assert.ok(!/\.includes\(\s*['"`]/.test(body), 'prohibido includes() sobre literal de texto');
    assert.ok(!/\bmatch\(|\btest\(\s*\w+\s*\)|RegExp\(/.test(body), 'prohibido regex sobre el log');
    assert.ok(!body.includes("'401'") && !body.includes('"401"'), 'el patrón 401 no se implementa (SEC-2)');
});

test('el módulo es puro: no requiere nada ni toca el filesystem', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'credential-death-detector.js'), 'utf8');
    const body = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.ok(!/\brequire\s*\(/.test(body), 'el detector no puede tener dependencias');
    assert.ok(!/\bfs\./.test(body), 'el detector no puede hacer IO');
});

// =============================================================================
// redact-secret-patterns.test.js — Tests DELTA de los patterns de valor
// agregados en #3724 (escaneo por VALOR + heurística de entropía).
//
// Cero-regresión sobre #2307: este archivo NO testea las funciones viejas
// (eso lo cubre `redact.test.js`, que debe seguir verde). Acá solo validamos
// lo nuevo: `redactObject`, `redactSecretValue`, `SECRET_VALUE_PATTERNS`.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const redact = require('../redact');

test('a · cada uno de los 5 patterns de proveedor es redactado', () => {
    const cases = {
        anthropic: 'sk-ant-api03-AbCdEf123456789_xyz',
        openai: 'sk-ABCDEFGHIJKLMNOPQRSTUVWX123456',
        groq: 'gsk_AbCd1234EfGh5678',
        aws: 'AKIAIOSFODNN7EXAMPLE',
        jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abcDEFsig123',
    };
    for (const [name, secret] of Object.entries(cases)) {
        const out = redact.redactObject({ note: secret });
        assert.equal(out.note.includes(secret), false, `${name}: el secreto no debe quedar en claro`);
        assert.ok(out.note.includes(redact.REDACTION_MARKER), `${name}: debe tener marcador`);
    }
});

test('a.2 · sk-ant- se prioriza sobre sk- genérico (no se rompe el match)', () => {
    const out = redact.redactObject({ k: 'sk-ant-api03-secretovalor1234567890' });
    assert.equal(out.k, redact.REDACTION_MARKER);
});

test('b · heurística entropía: token random >40 chars (entropy ≥ 4.5) → [REDACTED:high-entropy]', () => {
    // Token base64url de 48 bytes → ~64 chars, alta entropía, sin formato conocido.
    const highEntropy = 'Zk9pQ2xWb3JmN3RhU2RmZ0hqS2xQb1d4Q3pWYk5tQXNkRmdIakts';
    const out = redact.redactObject({ blob: highEntropy });
    assert.equal(out.blob, redact.HIGH_ENTROPY_MARKER);
});

test('c · string legítimo >40 chars con entropía baja → NO redactado', () => {
    const legit = 'Buenos Aires es la capital de la Republica Argentina';
    assert.ok(legit.length > 40);
    const out = redact.redactObject({ texto: legit });
    assert.equal(out.texto, legit, 'texto natural no debe redactarse');
});

test('d · redactObject combina redacción por clave + por valor + anidados', () => {
    const out = redact.redactObject({
        api_key: 'no-importa-el-valor',        // clave sensible → marcador
        nested: { token: 'x', free: 'sk-ant-abc123def456ghi789' },
        list: ['gsk_secret123456', 'texto normal corto'],
    });
    assert.equal(out.api_key, redact.REDACTION_MARKER);          // por clave
    assert.equal(out.nested.token, redact.REDACTION_MARKER);     // por clave anidada
    assert.equal(out.nested.free, redact.REDACTION_MARKER);      // por valor (pattern)
    assert.equal(out.list[0], redact.REDACTION_MARKER);          // por valor en array
    assert.equal(out.list[1], 'texto normal corto');            // intacto
});

test('e · SECRET_VALUE_PATTERNS está congelado y exportado', () => {
    assert.ok(Array.isArray(redact.SECRET_VALUE_PATTERNS));
    assert.equal(Object.isFrozen(redact.SECRET_VALUE_PATTERNS), true);
    assert.ok(redact.SECRET_VALUE_PATTERNS.length >= 5);
});

test('f · shannonEntropy: natural < umbral, random ≥ umbral', () => {
    const low = redact.shannonEntropy('aaaaaaaaaaaaaaaaaaaa');
    const high = redact.shannonEntropy('Zk9pQ2xWb3JmN3RhU2RmZ0hqS2xQb1d4Q3pWYk5tQXNkRmdIakts');
    assert.ok(low < redact.HIGH_ENTROPY_THRESHOLD);
    assert.ok(high >= redact.HIGH_ENTROPY_THRESHOLD);
});

// =============================================================================
// #5135 CA-7 — Topología AWS (ARN / account-id) como defensa EN PROFUNDIDAD.
//
// R4: estos patrones sólo los aplican `redactSecretValue` y `redactObject`.
// `redactSensitive(<string>)` va por otro camino y NUNCA los consulta, así que un
// test escrito contra `redactSensitive` seguiría mostrando el ARN (falso verde).
// Por eso todo lo de abajo va contra `redactSecretValue`.
//
// GURU-10: esto NO es la red de contención — el control primario es el template
// fijo de `kernel-degradation-alert.js`. Es la segunda capa.
// =============================================================================

// Stderr canónico del AWS CLI ante un AccessDenied, con ARN sintético.
const STDERR_ACCESS_DENIED = 'An error occurred (AccessDeniedException) when calling the Query operation: '
    + 'User: arn:aws:sts::000000000000:assumed-role/intrale-pipeline-role/pulpo-session is not authorized to '
    + 'perform: dynamodb:Query on resource: arn:aws:dynamodb:us-east-1:000000000000:table/intrale-kernel-store';

test('CA-7 (a) · redactSecretValue tapa el ARN y el account-id del stderr de AccessDenied', () => {
    const out = redact.redactSecretValue(STDERR_ACCESS_DENIED);
    assert.doesNotMatch(out, /arn:aws/i, 'el ARN no debe sobrevivir');
    // UX-5 · anclado: `\b\d{12}\b`. Sin anclar castigaría al correlationId del
    // pipeline (`kdeg-<epoch 13 díg>-<hex>`), que es una implementación correcta.
    assert.doesNotMatch(out, /\b\d{12}\b/, 'el account-id no debe sobrevivir');
    assert.ok(out.includes(redact.REDACTION_MARKER));
    // …pero lo que sirve para diagnosticar SIGUE ahí: lo que se pierde es
    // topología, no información útil para el operador.
    assert.match(out, /AccessDeniedException/);
    assert.match(out, /dynamodb:Query/);
});

test('CA-7 (a.2) · variantes de ARN (particiones, servicios, recursos con barra)', () => {
    const casos = [
        'arn:aws:dynamodb:us-east-1:000000000000:table/intrale-kernel-store',
        'arn:aws-cn:s3:::mi-bucket/objeto.json',
        'arn:aws-us-gov:iam::000000000000:role/pipeline',
        'arn:aws:sts::000000000000:assumed-role/intrale-pipeline-role/pulpo-session',
    ];
    for (const arn of casos) {
        const out = redact.redactSecretValue(`fallo sobre el recurso ${arn} al consultar`);
        assert.doesNotMatch(out, /arn:aws/i, `${arn} debe redactarse`);
        assert.doesNotMatch(out, /\b\d{12}\b/, `${arn}: tampoco el account-id`);
    }
});

test('CA-7 (b)/SEC-11 · un token de alta entropía en la misma línea que un ARN SIGUE cayendo en high-entropy', () => {
    // Antes de #5135 el gate de la heurística era `out === str`, o sea "ningún
    // patrón tocó el string". Con `aws_arn` —un patrón ANCHO que matchea texto
    // NO-secreto— ese gate se apagaba para cualquier string con un ARN, y el
    // residuo de alta entropía (el pedazo que puede ser el secreto real)
    // sobrevivía EN CLARO. Regresión sobre los 100+ callers de
    // redactSecretValue/redactObject. Este test es el que la ataja.
    const token = 'Zk9pQ2xWb3JmN3RhU2RmZ0hqS2xQb1d4Q3pWYk5tQXNkRmdIakts' + 'arn:aws:sts::000000000000:x';
    assert.ok(token.length > 40 && !/\s/.test(token));
    assert.ok(redact.shannonEntropy(token) >= redact.HIGH_ENTROPY_THRESHOLD);
    assert.equal(redact.redactSecretValue(token), redact.HIGH_ENTROPY_MARKER,
        'los patrones de TOPOLOGÍA no pueden desactivar la heurística de entropía');
});

test('CA-7 (b.2)/SEC-11 · un patrón de SECRETO sí sigue desactivando la heurística (no-regresión)', () => {
    // La otra mitad de SEC-11: el gate no se rompió, sólo se acotó a los patrones
    // que son de verdad secretos.
    const conSecreto = 'sk-ant-api03-AbCdEf123456789_xyzAbCdEf123456789_xyzAbCdEf12';
    assert.equal(redact.redactSecretValue(conSecreto), redact.REDACTION_MARKER,
        'un secreto conocido se redacta por patrón, no por entropía');
    // Y el string opaco sin ARN ni patrón conocido sigue yendo por entropía.
    assert.equal(
        redact.redactSecretValue('Zk9pQ2xWb3JmN3RhU2RmZ0hqS2xQb1d4Q3pWYk5tQXNkRmdIakts'),
        redact.HIGH_ENTROPY_MARKER,
    );
});

test('CA-7 (c)/R5 · un 123456789012 suelto en texto NO-AWS no se toca', () => {
    // Una regex `\b\d{12}\b` suelta redactaría ids, contadores y epochs recortados
    // de todo el pipeline y ensuciaría logs no relacionados. Los patrones están
    // anclados al contexto AWS a propósito.
    const casos = [
        'el contador llego a 123456789012 eventos procesados',
        'issue 123456789012 sin relacion con AWS',
        '{"total":123456789012}',
        'epoch 178526680141 y otro 123456789012 en la misma linea',
    ];
    for (const texto of casos) {
        assert.equal(redact.redactSecretValue(texto), texto, `no debe tocarse: ${texto}`);
    }
});

test('CA-7 (c.2)/R5 · el account-id sólo se redacta con sus delimitadores de ARN', () => {
    // Dentro de un ARN (delimitado por `::` … `:`) sí.
    assert.doesNotMatch(redact.redactSecretValue('arn:aws:iam::123456789012:role/x'), /\b\d{12}\b/);
    // Suelto, aunque esté pegado a la palabra "aws", no: sin ARN no hay topología.
    const suelto = 'la cuenta aws es 123456789012 segun el ticket';
    assert.equal(redact.redactSecretValue(suelto), suelto);
});

test('CA-7 (d) · los patrones nuevos están declarados como topología y el set sigue congelado', () => {
    const porNombre = Object.fromEntries(redact.SECRET_VALUE_PATTERNS.map((p) => [p.name, p]));
    assert.ok(porNombre.aws_arn, 'debe existir el patrón aws_arn');
    assert.ok(porNombre.aws_account_id, 'debe existir el patrón aws_account_id');
    assert.equal(porNombre.aws_arn.topology, true, 'aws_arn es topología, no secreto (SEC-11)');
    assert.equal(porNombre.aws_account_id.topology, true, 'aws_account_id es topología, no secreto (SEC-11)');
    // Los 5 patrones de secreto originales NO son topología: siguen gateando la heurística.
    for (const n of ['anthropic', 'openai', 'groq', 'aws_access_key', 'jwt']) {
        assert.notEqual(porNombre[n].topology, true, `${n} debe seguir contando como secreto`);
    }
    assert.equal(Object.isFrozen(redact.SECRET_VALUE_PATTERNS), true);
});

test('CA-7 (e) · redactObject también tapa la topología AWS (mismo motor de valor)', () => {
    const out = redact.redactObject({ detalle: STDERR_ACCESS_DENIED, nota: 'sin nada raro' });
    assert.doesNotMatch(out.detalle, /arn:aws/i);
    assert.doesNotMatch(out.detalle, /\b\d{12}\b/);
    assert.equal(out.nota, 'sin nada raro');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const evidencia = require('../kernel-audit-evidence');

const ACCOUNT = '123456789012';
const RUNTIME_ARN = `arn:aws:iam::${ACCOUNT}:user/intrale-kernel-runtime`;
const KEY_ARN = `arn:aws:kms:us-east-2:${ACCOUNT}:key/00000000-0000-4000-8000-000000000000`;

test('el principal pierde cuenta y partición pero conserva a quién identifica', () => {
    assert.equal(evidencia.redactPrincipal(RUNTIME_ARN), 'user/intrale-kernel-runtime');
    assert.equal(evidencia.redactPrincipal(`arn:aws:iam::${ACCOUNT}:user/claude-code`), 'user/claude-code');
});

test('el nombre de sesión de un rol asumido no sobrevive a la redacción', () => {
    // El nombre de sesión suele ser el mail del operador: PII que no aporta a la
    // correlación y que la CA prohíbe publicar.
    const asumido = `arn:aws:sts::${ACCOUNT}:assumed-role/KernelRole/leito.larreta@gmail.com`;
    assert.equal(evidencia.redactPrincipal(asumido), 'assumed-role/KernelRole');
});

test('la redacción del principal es idempotente', () => {
    // Regresión observada el 2026-08-05 sobre eventos reales: `extractCmkUsage`
    // ya proyecta el principal y `projectEvent` lo proyecta de nuevo. Sin
    // idempotencia, la segunda pasada devolvía `null` y la evidencia perdía el
    // principal justo en el campo que la CA pide correlacionar.
    const unaVez = evidencia.redactPrincipal(RUNTIME_ARN);
    assert.equal(evidencia.redactPrincipal(unaVez), unaVez);
    assert.equal(evidencia.redactPrincipal('user/intrale-kernel-runtime'), 'user/intrale-kernel-runtime');
    assert.equal(evidencia.redactPrincipal('assumed-role/KernelRole'), 'assumed-role/KernelRole');
    assert.equal(evidencia.redactPrincipal('AWSService'), 'AWSService');
});

test('un evento ya proyectado sobrevive a una segunda proyección', () => {
    const unaVez = evidencia.projectEvent({ eventName: 'Decrypt', principal: RUNTIME_ARN,
        principalExpected: true, invokedBy: 'dynamodb.amazonaws.com' });
    const dosVeces = evidencia.projectEvent(unaVez);
    assert.equal(dosVeces.principal, 'user/intrale-kernel-runtime');
    assert.deepEqual(dosVeces, unaVez);
});

test('la huella de la clave es estable y no reconstruye el ARN', () => {
    const primera = evidencia.keyFingerprint(KEY_ARN);
    assert.equal(primera, evidencia.keyFingerprint(KEY_ARN));
    assert.notEqual(primera, evidencia.keyFingerprint(`${KEY_ARN}-otra`));
    assert.ok(!primera.includes(ACCOUNT));
    assert.equal(primera.length, 12);
});

test('el nombre del bucket viaja sin el account-id que lleva embebido', () => {
    assert.equal(evidencia.redactResourceName(`intrale-kernel-cloudtrail-${ACCOUNT}-us-east-2`),
        'intrale-kernel-cloudtrail-<account>-us-east-2');
});

test('la proyección descarta por omisión todo campo no listado', () => {
    const proyectado = evidencia.projectEvent({
        eventTime: '2026-08-05T14:45:41Z', eventName: 'Decrypt', principal: RUNTIME_ARN,
        principalExpected: true, invokedBy: 'dynamodb.amazonaws.com',
        // Campos crudos de CloudTrail que NO deben sobrevivir.
        requestID: 'ab5cf2b1-0000-4000-8000-000000000001',
        eventID: 'cd5cf2b1-0000-4000-8000-000000000002',
        recipientAccountId: ACCOUNT,
        requestParameters: { encryptionContext: { 'aws:dynamodb:tableName': 'intrale-kernel-state' } },
    });
    assert.deepEqual(Object.keys(proyectado).sort(),
        ['errorCode', 'eventName', 'eventTime', 'invokedBy', 'outcome', 'principal', 'principalExpected']);
    assert.equal(proyectado.principal, 'user/intrale-kernel-runtime');
    assert.equal(proyectado.outcome, 'exitoso');
});

test('el resultado del evento es explícito y no se infiere de un campo ausente', () => {
    assert.equal(evidencia.projectEvent({ errorCode: 'AccessDenied' }).outcome, 'denegado');
    assert.equal(evidencia.projectEvent({}).outcome, 'exitoso');
});

test('la auditoría de la proyección caza cada identificador prohibido', () => {
    const casos = [
        ['arn-completo', { principal: RUNTIME_ARN }],
        ['account-id', { bucket: `intrale-kernel-cloudtrail-${ACCOUNT}-us-east-2` }],
        ['uuid-request-o-event-id', { requestID: 'ab5cf2b1-0000-4000-8000-000000000001' }],
        ['aws-access-key-id', { clave: 'AKIAIOSFODNN7EXAMPLE' }],
        ['jwt', { token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij' }],
    ];
    for (const [patron, objeto] of casos) {
        const encontrado = evidencia.findForbidden(objeto);
        assert.ok(encontrado.some((f) => f.pattern === patron), `no cazó ${patron}`);
        assert.throws(() => evidencia.assertRedacted(objeto), /identificadores prohibidos/);
    }
});

test('el error de la auditoría nombra la ruta pero nunca el valor que oculta', () => {
    // Un mensaje que imprime el ARN que estaba tratando de ocultar lo filtra por
    // el canal de la excepción, y las excepciones terminan en logs y en el issue.
    try {
        evidencia.assertRedacted({ usage: { Decrypt: [{ principal: RUNTIME_ARN }] } });
        assert.fail('debía tirar');
    } catch (error) {
        assert.match(error.message, /\$\.usage\.Decrypt\[0\]\.principal \(arn-completo\)/);
        assert.ok(!error.message.includes(ACCOUNT), 'el mensaje filtró el account-id');
        assert.ok(!error.message.includes('arn:aws'), 'el mensaje filtró el ARN');
    }
});

test('un token opaco de alta entropía se trata como material sensible', () => {
    const material = 'k7Qx2Vb9ZmR4tLpW8sNyE1jH6cUgA3dF5oI0PvXqB2ThYnMwKeZrSu';
    assert.ok(evidencia.findForbidden({ blob: material })
        .some((f) => f.pattern === 'token-opaco-alta-entropia'));
});

test('la evidencia completa se construye redactada de punta a punta', () => {
    const plan = { region: 'us-east-2', bucket: `intrale-kernel-cloudtrail-${ACCOUNT}-us-east-2`,
        trailName: 'intrale-kernel-kms', retentionDays: 365, accountId: ACCOUNT,
        trailArn: `arn:aws:cloudtrail:us-east-2:${ACCOUNT}:trail/intrale-kernel-kms` };
    const construida = evidencia.buildEvidence({
        plan, keyArn: KEY_ARN, keyAlias: 'alias/intrale-kernel-store',
        generatedAt: '2026-08-05T20:00:00Z',
        usage: { Decrypt: [{ eventTime: '2026-08-05T14:45:41Z', principal: RUNTIME_ARN,
            principalExpected: true, invokedBy: 'dynamodb.amazonaws.com' }], GenerateDataKey: [] },
    });
    const serializada = JSON.stringify(construida);
    assert.ok(!serializada.includes(ACCOUNT), 'la evidencia filtró el account-id');
    assert.ok(!serializada.includes('arn:aws'), 'la evidencia filtró un ARN');
    assert.equal(construida.plan.bucket, 'intrale-kernel-cloudtrail-<account>-us-east-2');
    assert.equal(construida.key.alias, 'alias/intrale-kernel-store');
    assert.equal(construida.usage.Decrypt[0].principal, 'user/intrale-kernel-runtime');
    // El ARN del trail no está en la allowlist del plan: se cae por omisión.
    assert.equal(construida.plan.trailArn, undefined);
});

test('el escaneo por valor tapa un ARN que llega por texto libre del CLI', () => {
    // `negativeTests` arrastra stderr del AWS CLI: texto libre que no pasa por
    // la proyección. La segunda capa lo tiene que cubrir sin abortar el reporte.
    const construida = evidencia.buildEvidence({
        plan: { region: 'us-east-2' },
        negativeTests: { results: [{ id: 'x', detalle: `denegado para ${RUNTIME_ARN}` }] },
    });
    assert.ok(!JSON.stringify(construida).includes('arn:aws'));
    assert.match(construida.negativeTests.results[0].detalle, /^denegado para \[REDACTED\]/);
});

test('la construcción falla cerrada ante lo que el escaneo por valor no cubre', () => {
    // Un account-id suelto (fuera de contexto ARN) no matchea ningún patrón de
    // secreto: si la auditoría no lo frenara, saldría en claro.
    assert.throws(() => evidencia.buildEvidence({
        plan: { region: 'us-east-2' },
        negativeTests: { results: [{ id: 'x', detalle: `cuenta ${ACCOUNT} denegada` }] },
    }), /identificadores prohibidos/);
});

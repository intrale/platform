'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const negativas = require('../kernel-audit-negative-tests');

const ACCOUNT = '123456789012';
const PLAN = Object.freeze({
    accountId: ACCOUNT, region: 'us-east-2', trailName: 'intrale-kernel-kms',
    bucket: `intrale-kernel-cloudtrail-${ACCOUNT}-us-east-2`,
    keyAlias: 'alias/intrale-kernel-store', runtimeUserName: 'intrale-kernel-runtime',
    keyId: '9d18ba4b-0000-4000-8000-000000000000',
    selector: [{ ReadWriteType: 'All', IncludeManagementEvents: true }],
});

const IDENTIDAD_RUNTIME = { status: 0, stdout: JSON.stringify({
    Arn: `arn:aws:iam::${ACCOUNT}:user/intrale-kernel-runtime` }), stderr: '' };
const DENEGADO = { status: 255, stdout: '',
    stderr: 'An error occurred (AccessDeniedException) when calling the StopLogging operation' };

function fakeAws(respuesta) {
    const calls = [];
    const aws = (args) => {
        calls.push(args);
        if (args[0] === 'sts') return IDENTIDAD_RUNTIME;
        return typeof respuesta === 'function' ? respuesta(args) : respuesta;
    };
    return { aws, calls };
}

test('la matriz cubre cada capacidad destructiva que exige la CA', () => {
    const ids = negativas.NEGATIVE_MATRIX.map((e) => e.id);
    for (const requerida of ['trail-stop-logging', 'trail-update', 'trail-delete',
        'trail-event-selectors', 'bucket-lifecycle-retention', 'bucket-delete-object',
        'bucket-policy-rewrite', 'kms-disable-key', 'kms-schedule-deletion']) {
        assert.ok(ids.includes(requerida), `falta la capacidad ${requerida}`);
    }
});

test('reconoce las tres formas en que AWS denomina una denegación', () => {
    assert.ok(negativas.esDenegacion('An error occurred (AccessDenied) when calling DeleteObject'));
    assert.ok(negativas.esDenegacion('(AccessDeniedException) when calling the StopLogging operation'));
    assert.ok(negativas.esDenegacion('User: ... is not authorized to perform: cloudtrail:DeleteTrail'));
    assert.ok(negativas.esDenegacion('with an explicit deny in an identity-based policy'));
    assert.ok(!negativas.esDenegacion('Could not connect to the endpoint URL'));
});

test('una operación permitida es un hallazgo crítico, no un éxito', () => {
    const clasificado = negativas.clasificar({ status: 0, stdout: '{}', stderr: '' });
    assert.equal(clasificado.outcome, 'NO-DENEGADO');
    assert.equal(clasificado.denied, false);
});

test('un error ajeno a la autorización es inconclusivo y no aprueba', () => {
    // Un timeout de red no puede leerse como "está protegido": sería aprobar la
    // auditoría por no haber podido probarla.
    const clasificado = negativas.clasificar({ status: 255, stdout: '',
        stderr: 'Could not connect to the endpoint URL: https://cloudtrail.us-east-2.amazonaws.com/' });
    assert.equal(clasificado.outcome, 'inconclusivo');
    assert.equal(clasificado.denied, false);
});

test('el detalle de un error inconclusivo sale redactado', () => {
    const clasificado = negativas.clasificar({ status: 255, stdout: '',
        stderr: `ValidationException: trail arn:aws:cloudtrail:us-east-2:${ACCOUNT}:trail/x inválido` });
    assert.ok(!clasificado.detalle.includes('arn:aws'));
    assert.ok(!clasificado.detalle.includes(ACCOUNT));
});

test('la matriz aprueba sólo si TODAS las operaciones fueron denegadas', () => {
    const { aws } = fakeAws(DENEGADO);
    const resultado = negativas.runNegativeMatrix(PLAN, { aws, nonce: 'n1' });
    assert.equal(resultado.results.length, negativas.NEGATIVE_MATRIX.length);
    assert.ok(resultado.allDenied);
    assert.deepEqual(resultado.notDenied, []);
});

test('una sola operación permitida arrastra el veredicto a rechazado', () => {
    const { aws } = fakeAws((args) => (args[1] === 'delete-object'
        ? { status: 0, stdout: '{}', stderr: '' } : DENEGADO));
    const resultado = negativas.runNegativeMatrix(PLAN, { aws, nonce: 'n1' });
    assert.equal(resultado.allDenied, false);
    assert.ok(resultado.notDenied.includes('bucket-delete-object'));
});

test('un servicio comprometido no escala a sus operaciones destructivas', () => {
    // Si `delete-object` no fue denegada, la barrera de S3 ya está probada como
    // ausente: correr igual el cambio de retención o el borrado de la policy
    // sólo agrega la chance de degradar la auditoría de verdad.
    const { aws, calls } = fakeAws((args) => (args[1] === 'delete-object'
        ? { status: 0, stdout: '{}', stderr: '' } : DENEGADO));
    const resultado = negativas.runNegativeMatrix(PLAN, { aws, nonce: 'n1' });
    const porId = Object.fromEntries(resultado.results.map((r) => [r.id, r]));
    assert.equal(porId['bucket-lifecycle-retention'].outcome, 'no-ejecutado');
    assert.equal(porId['bucket-policy-rewrite'].outcome, 'no-ejecutado');
    assert.ok(!calls.some((c) => c.join(' ').includes('put-bucket-lifecycle-configuration')),
        'no debió intentar reducir la retención');
    assert.ok(!calls.some((c) => c.join(' ').includes('delete-bucket-policy')),
        'no debió intentar borrar la policy');
    // El corte es por servicio: CloudTrail y KMS se siguen probando enteros.
    assert.equal(porId['trail-stop-logging'].denied, true);
    assert.equal(porId['kms-disable-key'].denied, true);
    // Y una omitida NO cuenta como aprobada.
    assert.equal(resultado.allDenied, false);
});

test('una operación omitida nunca se reporta como denegada', () => {
    const { aws } = fakeAws((args) => (args[0] === 'cloudtrail' && args[1] === 'update-trail'
        ? { status: 0, stdout: '{}', stderr: '' } : DENEGADO));
    const resultado = negativas.runNegativeMatrix(PLAN, { aws, nonce: 'n1' });
    const omitidas = resultado.results.filter((r) => r.outcome === 'no-ejecutado');
    assert.deepEqual(omitidas.map((r) => r.id), ['trail-stop-logging', 'trail-delete']);
    assert.ok(omitidas.every((r) => r.denied === false));
});

test('un inconclusivo tampoco aprueba', () => {
    const { aws } = fakeAws((args) => (args[0] === 'kms'
        ? { status: 255, stdout: '', stderr: 'Connection reset by peer' } : DENEGADO));
    const resultado = negativas.runNegativeMatrix(PLAN, { aws, nonce: 'n1' });
    assert.equal(resultado.allDenied, false);
    assert.deepEqual(resultado.notDenied, ['kms-disable-key', 'kms-schedule-deletion']);
});

test('la guarda de identidad impide correr la matriz como administrador', () => {
    // Sin esta guarda, `delete-trail` y `stop-logging` no serían denegados:
    // destruirían el trail de verdad en vez de probar que está protegido.
    const aws = () => ({ status: 0, stdout: JSON.stringify({
        Arn: `arn:aws:iam::${ACCOUNT}:user/admin` }), stderr: '' });
    assert.throws(() => negativas.runNegativeMatrix(PLAN, { aws }), /exige la identidad/);
    assert.throws(() => negativas.assertRuntimeIdentity('intrale-kernel-runtime', aws),
        /destruiría el trail/);
});

test('la matriz no corre a ciegas si no puede resolver la identidad', () => {
    const aws = () => ({ status: 255, stdout: '', stderr: 'ExpiredToken' });
    assert.throws(() => negativas.runNegativeMatrix(PLAN, { aws }), /identidad del llamador/);
});

test('las operaciones irreversibles usan parámetros que no destruyen si pasan', () => {
    const { aws, calls } = fakeAws(DENEGADO);
    negativas.runNegativeMatrix(PLAN, { aws, nonce: 'nonce-fijo' });
    const flat = calls.map((c) => c.join(' '));
    // update-trail reenvía la configuración vigente (no la degrada).
    assert.match(flat.find((c) => c.includes('update-trail')), /--enable-log-file-validation/);
    // put-event-selectors reenvía el selector vigente del plan.
    assert.match(flat.find((c) => c.includes('put-event-selectors')), /"ReadWriteType":"All"/);
    // delete-object apunta a una clave inexistente: si el permiso existiera, la
    // llamada tendría éxito sin borrar evidencia real.
    assert.match(flat.find((c) => c.includes('delete-object')), /negative-test-nonce-fijo/);
});

test('la evidencia de la matriz nombra el recurso sin el account-id', () => {
    const { aws } = fakeAws(DENEGADO);
    const resultado = negativas.runNegativeMatrix(PLAN, { aws, nonce: 'n1' });
    const serializada = JSON.stringify(resultado);
    assert.ok(!serializada.includes(ACCOUNT), 'la evidencia filtró el account-id');
    assert.ok(resultado.results.some((r) => r.resource === 's3/intrale-kernel-cloudtrail-<account>-us-east-2'));
});

test('las operaciones de KMS usan key id, no alias', () => {
    // Caso real observado el 2026-08-05: con alias, `DisableKey` devuelve
    // `InvalidArnException`, que NO es una denegación. La prueba quedaba
    // inconclusiva y, con un veredicto laxo, habría aprobado por accidente.
    const { aws, calls } = fakeAws(DENEGADO);
    negativas.runNegativeMatrix(PLAN, { aws, nonce: 'n1' });
    const kms = calls.filter((c) => c[0] === 'kms').map((c) => c.join(' '));
    assert.equal(kms.length, 2);
    assert.ok(kms.every((c) => c.includes(PLAN.keyId)), 'debe usar el key id');
    assert.ok(kms.every((c) => !c.includes('alias/')), 'no debe usar el alias');
});

test('sin key id las pruebas de KMS se reportan inconclusivas, no aprobadas', () => {
    const { aws, calls } = fakeAws(DENEGADO);
    const sinKeyId = { ...PLAN, keyId: undefined };
    const resultado = negativas.runNegativeMatrix(sinKeyId, { aws, nonce: 'n1' });
    const disable = resultado.results.find((r) => r.id === 'kms-disable-key');
    assert.equal(disable.outcome, 'inconclusivo');
    assert.equal(disable.denied, false);
    assert.match(disable.detalle, /--key-id/);
    assert.equal(resultado.allDenied, false);
    assert.ok(!calls.some((c) => c[0] === 'kms'), 'no debe llamar a KMS sin key id');
});

test('el key id no se filtra a la evidencia: el recurso va anonimizado', () => {
    const { aws } = fakeAws(DENEGADO);
    const resultado = negativas.runNegativeMatrix(PLAN, { aws, nonce: 'n1' });
    assert.ok(!JSON.stringify(resultado).includes(PLAN.keyId), 'la evidencia filtró el key id');
    assert.ok(resultado.results.some((r) => r.resource === 'kms/clave-del-store'));
});

test('un key id embebido en el stderr sale enmascarado', () => {
    const clasificado = negativas.clasificar({ status: 255, stdout: '',
        stderr: `KMSInvalidStateException: key ${PLAN.keyId} is not enabled` });
    assert.ok(!clasificado.detalle.includes(PLAN.keyId));
    assert.match(clasificado.detalle, /\[REDACTED:id\]/);
});

test('el post-check detecta que el trail dejó de loguear', () => {
    const activo = () => ({ status: 0, stdout: JSON.stringify({ IsLogging: true }), stderr: '' });
    assert.deepEqual(negativas.verificarTrailIntacto(PLAN, activo),
        { legible: true, logging: true, detalle: null });
    const detenido = () => ({ status: 0, stdout: JSON.stringify({ IsLogging: false }), stderr: '' });
    assert.equal(negativas.verificarTrailIntacto(PLAN, detenido).logging, false);
});

test('el post-check ilegible no se confunde con un trail sano', () => {
    // El runtime no puede leer el estado del trail (es parte de la separación):
    // eso es `legible: false`, no `logging: true`.
    const denegado = () => ({ status: 255, stdout: '', stderr: 'AccessDeniedException' });
    const resultado = negativas.verificarTrailIntacto(PLAN, denegado);
    assert.equal(resultado.legible, false);
    assert.equal(resultado.logging, null);
});

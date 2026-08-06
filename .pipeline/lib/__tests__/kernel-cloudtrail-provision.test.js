'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cloudtrail = require('../kernel-cloudtrail-provision');

test('construye nombres y ARN desde cuenta y región sin hardcodear cuenta', () => {
    const plan = cloudtrail.buildPlan({ accountId: '123456789012' });
    assert.equal(plan.bucket, 'intrale-kernel-cloudtrail-123456789012-us-east-2');
    assert.equal(plan.trailArn, 'arn:aws:cloudtrail:us-east-2:123456789012:trail/intrale-kernel-kms');
    assert.equal(plan.retentionDays, 365);
});

test('policy S3 limita escritura al trail y prefijo de la cuenta', () => {
    const plan = cloudtrail.buildPlan({ accountId: '123456789012' });
    const policy = cloudtrail.bucketPolicy(plan);
    assert.equal(policy.Statement[1].Principal.Service, 'cloudtrail.amazonaws.com');
    assert.equal(policy.Statement[1].Resource,
        'arn:aws:s3:::intrale-kernel-cloudtrail-123456789012-us-east-2/AWSLogs/123456789012/*');
    assert.equal(policy.Statement[1].Condition.StringEquals['AWS:SourceArn'], plan.trailArn);
});

test('la policy del destino exige TLS para cualquier principal', () => {
    // #5213 CA-4 — la garantía es del canal, no de quién llama: tiene que cubrir
    // también al propio servicio de CloudTrail.
    const policy = cloudtrail.bucketPolicy(cloudtrail.buildPlan({ accountId: '123456789012' }));
    const tls = policy.Statement.find((s) => s.Sid === 'DenyInsecureTransport');
    assert.equal(tls.Effect, 'Deny');
    assert.equal(tls.Principal, '*');
    assert.equal(tls.Condition.Bool['aws:SecureTransport'], 'false');
    assert.deepEqual(tls.Resource, ['arn:aws:s3:::intrale-kernel-cloudtrail-123456789012-us-east-2',
        'arn:aws:s3:::intrale-kernel-cloudtrail-123456789012-us-east-2/*']);
});

test('la policy niega al runtime borrar, degradar y hasta leer la auditoría', () => {
    const plan = cloudtrail.buildPlan({ accountId: '123456789012' });
    const deny = cloudtrail.bucketPolicy(plan).Statement.find((s) => s.Sid === 'DenyRuntimeAuditAccess');
    assert.equal(deny.Effect, 'Deny');
    assert.equal(deny.Principal.AWS, 'arn:aws:iam::123456789012:user/intrale-kernel-runtime');
    for (const accion of ['s3:DeleteObject', 's3:DeleteObjectVersion', 's3:PutLifecycleConfiguration',
        's3:PutBucketPolicy', 's3:DeleteBucket', 's3:GetObject', 's3:ListBucket']) {
        assert.ok(deny.Action.includes(accion), `falta negar ${accion}`);
    }
});

test('el acceso del auditor queda declarado, separado del runtime y de sólo lectura', () => {
    const plan = cloudtrail.buildPlan({ accountId: '123456789012' });
    const allow = cloudtrail.bucketPolicy(plan).Statement.find((s) => s.Sid === 'AllowAuditorRead');
    assert.equal(allow.Principal.AWS, 'arn:aws:iam::123456789012:user/claude-code');
    assert.notEqual(allow.Principal.AWS, plan.runtimePrincipalArn);
    assert.ok(allow.Action.every((a) => /^s3:(Get|List)/.test(a)), 'el auditor no debe poder escribir');
});

test('apply configura retención, management events KMS y logging', () => {
    const calls = [];
    const aws = (args) => {
        calls.push(args);
        if (args[0] === 'cloudtrail' && args[1] === 'get-trail-status') return { IsLogging: true };
        return {};
    };
    const plan = cloudtrail.buildPlan({ accountId: '123456789012' });
    assert.deepEqual(cloudtrail.applyPlan(plan, aws), { IsLogging: true });
    assert.match(calls.find((c) => c[1] === 'put-bucket-lifecycle-configuration').join(' '), /"Days":365/);
    assert.match(calls.find((c) => c[1] === 'put-event-selectors').join(' '), /"IncludeManagementEvents":true/);
    assert.ok(calls.some((c) => c[1] === 'start-logging'));
});

const KEY_ARN = 'arn:aws:kms:us-east-2:123456789012:key/00000000-0000-4000-8000-000000000000';

function trailRecord(eventName, overrides = {}) {
    return {
        eventSource: 'kms.amazonaws.com', eventName, eventTime: '2026-08-05T14:45:41Z',
        userIdentity: { arn: 'arn:aws:iam::123456789012:user/intrale-kernel-runtime' },
        sourceIPAddress: 'dynamodb.amazonaws.com',
        resources: [{ ARN: KEY_ARN, type: 'AWS::KMS::Key' }], ...overrides,
    };
}

test('el uso de la CMK se emite sobre la tabla de coordinación, nunca sobre la de no-repudio', () => {
    const calls = [];
    const emitted = cloudtrail.emitCmkUsage(cloudtrail.buildPlan({ accountId: '123456789012' }),
        { coordinationTableName: 'coordination' }, (args) => { calls.push(args); return {}; });
    assert.equal(emitted.table, 'coordination');
    assert.ok(calls.some((c) => c[0] === 'dynamodb' && c[1] === 'put-item'));
    assert.ok(calls.some((c) => c[0] === 'dynamodb' && c[1] === 'delete-item'));
    assert.ok(!calls.join(' ').includes('intrale-kernel-state'));
});

test('la emisión falla cerrada sin tabla de coordinación', () => {
    const plan = cloudtrail.buildPlan({ accountId: '123456789012' });
    assert.throws(() => cloudtrail.emitCmkUsage(plan, {}, () => ({})), /coordinationTableName/);
});

test('extrae de los registros del trail sólo los eventos KMS de la CMK del kernel', () => {
    const usage = cloudtrail.extractCmkUsage([
        trailRecord('Decrypt'),
        trailRecord('GenerateDataKey'),
        trailRecord('Decrypt', { resources: [{ ARN: 'arn:aws:kms:us-east-2:123456789012:key/otra' }] }),
        trailRecord('DescribeKey'),
        { eventSource: 's3.amazonaws.com', eventName: 'Decrypt', resources: [{ ARN: KEY_ARN }] },
    ], KEY_ARN);
    assert.equal(usage.Decrypt.length, 1);
    assert.equal(usage.GenerateDataKey.length, 1);
    // #5213 CA-3 — el evento sale proyectado: `user/<nombre>`, nunca el ARN
    // completo de `userIdentity.arn`, que lleva el account id adentro.
    assert.equal(usage.Decrypt[0].principal, 'user/intrale-kernel-runtime');
    assert.equal(usage.Decrypt[0].invokedBy, 'dynamodb.amazonaws.com');
    assert.ok(cloudtrail.isCmkUsageComplete(usage));
});

test('la extracción no deja el ARN ni el account-id en la evidencia', () => {
    const usage = cloudtrail.extractCmkUsage([trailRecord('Decrypt'), trailRecord('GenerateDataKey')], KEY_ARN);
    const serializada = JSON.stringify(usage);
    assert.ok(!serializada.includes('arn:aws'), 'la evidencia filtró un ARN');
    assert.ok(!serializada.includes('123456789012'), 'la evidencia filtró el account-id');
});

test('correlaciona el uso con el principal runtime esperado', () => {
    const usage = cloudtrail.extractCmkUsage([trailRecord('Decrypt')], KEY_ARN,
        { expectedPrincipalArn: 'arn:aws:iam::123456789012:user/intrale-kernel-runtime' });
    assert.equal(usage.Decrypt[0].principalExpected, true);
});

test('un uso exitoso de OTRO principal no cierra la correlación', () => {
    // Prueba que el trail funciona, pero no que la CMK la use el runtime del
    // kernel, que es lo que la CA pide demostrar.
    const ajeno = trailRecord('Decrypt', {
        userIdentity: { arn: 'arn:aws:iam::123456789012:user/otro-servicio' } });
    const usage = cloudtrail.extractCmkUsage([ajeno, trailRecord('GenerateDataKey')], KEY_ARN,
        { expectedPrincipalArn: 'arn:aws:iam::123456789012:user/intrale-kernel-runtime' });
    assert.equal(usage.Decrypt[0].principalExpected, false);
    assert.equal(cloudtrail.successfulCmkUsage(usage, 'Decrypt').length, 0);
    assert.equal(cloudtrail.isCmkUsageComplete(usage), false);
});

test('GenerateDataKey se correlaciona con DynamoDB, no con el usuario runtime', () => {
    // Verificado el 2026-08-05: el usuario runtime NO tiene `kms:GenerateDataKey`
    // en ninguna policy. La data key la genera DynamoDB en nombre de la tabla,
    // como `AWSService`. Exigir el ARN del runtime ahí sería exigir un evento
    // que AWS nunca emite, y dejaría la verificación imposible de cerrar.
    const porServicio = trailRecord('GenerateDataKey', {
        userIdentity: { type: 'AWSService', invokedBy: 'dynamodb.amazonaws.com' },
        sourceIPAddress: 'dynamodb.amazonaws.com' });
    const usage = cloudtrail.extractCmkUsage([trailRecord('Decrypt'), porServicio], KEY_ARN,
        { expectedPrincipalArn: 'arn:aws:iam::123456789012:user/intrale-kernel-runtime' });
    assert.equal(usage.GenerateDataKey[0].principalExpected, true);
    assert.equal(usage.Decrypt[0].principalExpected, true);
    assert.ok(cloudtrail.isCmkUsageComplete(usage));
});

test('una data key generada desde otro servicio NO correlaciona', () => {
    // Es justo lo que el `kms:ViaService` de la key policy debería impedir.
    const porOtroServicio = trailRecord('GenerateDataKey', {
        userIdentity: { type: 'AWSService', invokedBy: 's3.amazonaws.com' },
        sourceIPAddress: 's3.amazonaws.com' });
    const usage = cloudtrail.extractCmkUsage([trailRecord('Decrypt'), porOtroServicio], KEY_ARN,
        { expectedPrincipalArn: 'arn:aws:iam::123456789012:user/intrale-kernel-runtime' });
    assert.equal(usage.GenerateDataKey[0].principalExpected, false);
    assert.equal(cloudtrail.isCmkUsageComplete(usage), false);
});

test('sin expectativa declarada de principal la correlación no descarta eventos', () => {
    const usage = cloudtrail.extractCmkUsage([trailRecord('Decrypt')], KEY_ARN);
    assert.equal(usage.Decrypt[0].principalExpected, null);
    assert.equal(cloudtrail.successfulCmkUsage(usage, 'Decrypt').length, 1);
});

test('la verificación lee los objetos del trail en S3, no el Event history', () => {
    const calls = [];
    const plan = cloudtrail.buildPlan({ accountId: '123456789012' });
    const aws = (args) => {
        calls.push(args);
        if (args[1] === 'list-objects-v2') {
            return { Contents: [
                { Key: 'AWSLogs/123456789012/CloudTrail/us-east-2/2026/08/05/a.json.gz',
                    LastModified: '2026-08-05T14:50:00Z' },
                { Key: 'AWSLogs/123456789012/CloudTrail/us-east-2/2026/01/01/viejo.json.gz',
                    LastModified: '2026-01-01T00:00:00Z' },
                { Key: 'AWSLogs/123456789012/CloudTrail-Digest/x.json.gz.txt',
                    LastModified: '2026-08-05T14:50:00Z' },
            ] };
        }
        return {};
    };
    const usage = cloudtrail.verifyKmsEventsFromTrail(plan,
        { keyArn: KEY_ARN, sinceMs: Date.parse('2026-08-05T14:45:40Z') },
        { aws, readObject: (key) => {
            assert.match(key, /2026\/08\/05/);
            return [trailRecord('Decrypt'), trailRecord('GenerateDataKey')];
        } });
    assert.ok(cloudtrail.isCmkUsageComplete(usage));
    assert.ok(!calls.some((c) => c.includes('lookup-events')), 'no debe consultar el Event history');
});

test('la verificación falla cerrada si falta uno de los dos eventos', () => {
    const usage = cloudtrail.extractCmkUsage([trailRecord('Decrypt')], KEY_ARN);
    assert.equal(cloudtrail.isCmkUsageComplete(usage), false);
});

test('un evento denegado no cuenta como evidencia de uso real de la CMK', () => {
    // Caso real observado el 2026-08-05: el único GenerateDataKey del trail era un
    // AccessDenied de intrale-kernel-runtime. Contarlo dejaba la verificación
    // fail-open: daba la auditoría por probada sin que la clave se hubiera usado.
    const usage = cloudtrail.extractCmkUsage([
        trailRecord('Decrypt'),
        trailRecord('GenerateDataKey', { errorCode: 'AccessDenied', sourceIPAddress: '203.0.113.10' }),
    ], KEY_ARN);
    assert.equal(usage.GenerateDataKey.length, 1, 'el evento denegado se reporta...');
    assert.equal(cloudtrail.successfulCmkUsage(usage, 'GenerateDataKey').length, 0,
        '...pero no como uso exitoso');
    assert.equal(cloudtrail.isCmkUsageComplete(usage), false);
});

test('la evidencia completa exige un evento exitoso de cada operación', () => {
    const usage = cloudtrail.extractCmkUsage([
        trailRecord('Decrypt'),
        trailRecord('GenerateDataKey', { errorCode: 'AccessDenied' }),
        trailRecord('GenerateDataKey'),
    ], KEY_ARN);
    assert.ok(cloudtrail.isCmkUsageComplete(usage));
});

test('la verificación exige el ARN de la CMK', () => {
    const plan = cloudtrail.buildPlan({ accountId: '123456789012' });
    assert.throws(() => cloudtrail.verifyKmsEventsFromTrail(plan, {}, { aws: () => ({}) }), /keyArn/);
});

// #5213 CA-1/CA-4 — la postura se lee de AWS, no de la policy que creemos haber
// aplicado. `posturaSana` es el estado esperado; cada test lo degrada en UN
// punto para probar que ese punto se detecta.
function fakePostura(overrides = {}) {
    const plan = cloudtrail.buildPlan({ accountId: '123456789012' });
    const estado = {
        status: { IsLogging: true },
        trail: { HomeRegion: 'us-east-2', LogFileValidationEnabled: true },
        selector: { ReadWriteType: 'All', IncludeManagementEvents: true },
        block: { BlockPublicAcls: true, IgnorePublicAcls: true,
            BlockPublicPolicy: true, RestrictPublicBuckets: true },
        sse: { SSEAlgorithm: 'AES256' },
        lifecycle: { Rules: [{ Status: 'Enabled', Expiration: { Days: 365 } }] },
        sids: ['DenyInsecureTransport', 'DenyRuntimeAuditAccess', 'AllowAuditorRead'],
        ...overrides,
    };
    const aws = (args) => {
        const op = args[1];
        if (op === 'get-trail-status') return estado.status;
        if (op === 'describe-trails') return { trailList: [estado.trail] };
        if (op === 'get-event-selectors') return { EventSelectors: [estado.selector] };
        if (op === 'get-public-access-block') return { PublicAccessBlockConfiguration: estado.block };
        if (op === 'get-bucket-encryption') {
            return { ServerSideEncryptionConfiguration: {
                Rules: [{ ApplyServerSideEncryptionByDefault: estado.sse }] } };
        }
        if (op === 'get-bucket-lifecycle-configuration') return estado.lifecycle;
        if (op === 'get-bucket-policy') {
            return { Policy: JSON.stringify({ Statement: estado.sids.map((Sid) => ({ Sid })) }) };
        }
        return {};
    };
    return { plan, aws };
}

test('la postura sana del destino cumple todas las garantías de la CA', () => {
    const { plan, aws } = fakePostura();
    const postura = cloudtrail.verifyDestinationPosture(plan, { keyArn: KEY_ARN }, aws);
    assert.ok(cloudtrail.posturaCompleta(postura), JSON.stringify(postura));
    assert.equal(postura.managementEventsReadWrite, true);
    assert.equal(postura.logFileValidation, true);
    assert.equal(postura.tlsOnly, true);
});

test('cada degradación del destino se detecta por separado', () => {
    const casos = [
        ['trailLogging', { status: { IsLogging: false } }],
        ['logFileValidation', { trail: { HomeRegion: 'us-east-2', LogFileValidationEnabled: false } }],
        ['managementEventsReadWrite', { selector: { ReadWriteType: 'WriteOnly', IncludeManagementEvents: true } }],
        ['bucketPrivate', { block: { BlockPublicAcls: true, IgnorePublicAcls: true,
            BlockPublicPolicy: true, RestrictPublicBuckets: false } }],
        ['retentionDeclared', { lifecycle: { Rules: [{ Status: 'Enabled', Expiration: { Days: 1 } }] } }],
        ['tlsOnly', { sids: ['DenyRuntimeAuditAccess', 'AllowAuditorRead'] }],
        ['runtimeDeniedOnDestination', { sids: ['DenyInsecureTransport', 'AllowAuditorRead'] }],
        ['auditorAccessSeparated', { sids: ['DenyInsecureTransport', 'DenyRuntimeAuditAccess'] }],
    ];
    for (const [garantia, override] of casos) {
        const { plan, aws } = fakePostura(override);
        const postura = cloudtrail.verifyDestinationPosture(plan, { keyArn: KEY_ARN }, aws);
        assert.equal(postura[garantia], false, `no detectó la degradación de ${garantia}`);
        assert.equal(cloudtrail.posturaCompleta(postura), false);
    }
});

test('cifrar el destino con la CMK auditada NO cuenta como clave separada', () => {
    // Si fueran la misma, deshabilitar la clave para contener un incidente del
    // store dejaría ilegible la evidencia de ese mismo incidente.
    const { plan, aws } = fakePostura({ sse: { SSEAlgorithm: 'aws:kms', KMSMasterKeyID: KEY_ARN } });
    const postura = cloudtrail.verifyDestinationPosture(plan, { keyArn: KEY_ARN }, aws);
    assert.equal(postura.destinationKeySeparateFromCmk, false);
    assert.equal(postura.bucketEncrypted, true);
});

test('una KMS distinta de la CMK auditada sí es una clave de destino válida', () => {
    const { plan, aws } = fakePostura({ sse: { SSEAlgorithm: 'aws:kms',
        KMSMasterKeyID: 'arn:aws:kms:us-east-2:123456789012:key/otra-clave' } });
    const postura = cloudtrail.verifyDestinationPosture(plan, { keyArn: KEY_ARN }, aws);
    assert.equal(postura.destinationKeySeparateFromCmk, true);
});

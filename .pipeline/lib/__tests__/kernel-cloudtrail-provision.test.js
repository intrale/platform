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
    assert.equal(usage.Decrypt[0].principal, 'arn:aws:iam::123456789012:user/intrale-kernel-runtime');
    assert.equal(usage.Decrypt[0].invokedBy, 'dynamodb.amazonaws.com');
    assert.ok(cloudtrail.isCmkUsageComplete(usage));
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

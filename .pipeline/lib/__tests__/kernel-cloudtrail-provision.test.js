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

test('verificación usa tabla de coordinación y exige ambos eventos KMS', () => {
    const calls = [];
    const aws = (args) => {
        calls.push(args);
        if (args[0] === 'kms') return { KeyMetadata: { Arn: 'arn:aws:kms:us-east-2:123456789012:key/key-id' } };
        if (args[0] === 'cloudtrail') return { Events: [{
            CloudTrailEvent: 'arn:aws:kms:us-east-2:123456789012:key/key-id',
        }] };
        return {};
    };
    const plan = cloudtrail.buildPlan({ accountId: '123456789012' });
    assert.deepEqual(cloudtrail.verifyKmsEvents(plan, { coordinationTableName: 'coordination' }, aws),
        { Decrypt: true, GenerateDataKey: true });
    assert.ok(calls.some((c) => c[0] === 'dynamodb' && c[1] === 'delete-item'));
    assert.ok(!calls.join(' ').includes('intrale-kernel-state'));
});

test('verificación falla cerrada sin tabla de coordinación', () => {
    const plan = cloudtrail.buildPlan({ accountId: '123456789012' });
    assert.throws(() => cloudtrail.verifyKmsEvents(plan, {}, () => ({})), /coordinationTableName/);
});

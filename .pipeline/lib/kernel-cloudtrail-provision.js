'use strict';

// Paso ADMIN explícito para #5205. Es dry-run por defecto: solo --apply crea
// recursos y solo --verify escribe el ítem efímero de verificación.
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');

const DEFAULTS = Object.freeze({
    region: 'us-east-2', trailName: 'intrale-kernel-kms',
    keyAlias: 'alias/intrale-kernel-store', retentionDays: 365,
});

function runAws(args, options = {}) {
    const result = spawnSync('aws', [...args, '--output', 'json'], {
        encoding: 'utf8', env: options.env || process.env, shell: false,
    });
    if (result.status !== 0) {
        throw new Error(`aws ${args.slice(0, 2).join(' ')} falló: ${(result.stderr || '').trim()}`);
    }
    return result.stdout.trim() ? JSON.parse(result.stdout) : {};
}

function bucketName(accountId, region) {
    if (!/^\d{12}$/.test(String(accountId))) throw new Error('accountId AWS inválido');
    if (!/^[a-z0-9-]+$/.test(region)) throw new Error('region AWS inválida');
    return `intrale-kernel-cloudtrail-${accountId}-${region}`;
}

function bucketPolicy({ bucket, accountId, trailArn }) {
    return { Version: '2012-10-17', Statement: [
        { Sid: 'AWSCloudTrailAclCheck', Effect: 'Allow',
            Principal: { Service: 'cloudtrail.amazonaws.com' }, Action: 's3:GetBucketAcl',
            Resource: `arn:aws:s3:::${bucket}`,
            Condition: { StringEquals: { 'AWS:SourceArn': trailArn } } },
        { Sid: 'AWSCloudTrailWrite', Effect: 'Allow',
            Principal: { Service: 'cloudtrail.amazonaws.com' }, Action: 's3:PutObject',
            Resource: `arn:aws:s3:::${bucket}/AWSLogs/${accountId}/*`,
            Condition: { StringEquals: { 's3:x-amz-acl': 'bucket-owner-full-control',
                'AWS:SourceArn': trailArn } } },
    ] };
}

function buildPlan({ accountId, region = DEFAULTS.region, retentionDays = DEFAULTS.retentionDays } = {}) {
    const bucket = bucketName(accountId, region);
    const trailArn = `arn:aws:cloudtrail:${region}:${accountId}:trail/${DEFAULTS.trailName}`;
    return { accountId, region, bucket, trailArn, retentionDays,
        selector: [{ ReadWriteType: 'All', IncludeManagementEvents: true }] };
}

function ensureBucket(plan, aws = runAws) {
    try { aws(['s3api', 'head-bucket', '--bucket', plan.bucket, '--region', plan.region]); }
    catch (_) {
        aws(['s3api', 'create-bucket', '--bucket', plan.bucket, '--region', plan.region,
            '--create-bucket-configuration', `LocationConstraint=${plan.region}`]);
    }
    aws(['s3api', 'put-public-access-block', '--bucket', plan.bucket, '--region', plan.region,
        '--public-access-block-configuration',
        'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true']);
    aws(['s3api', 'put-bucket-encryption', '--bucket', plan.bucket, '--region', plan.region,
        '--server-side-encryption-configuration', JSON.stringify({ Rules: [{
            ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' }, BucketKeyEnabled: true,
        }] })]);
    aws(['s3api', 'put-bucket-lifecycle-configuration', '--bucket', plan.bucket,
        '--region', plan.region, '--lifecycle-configuration', JSON.stringify({ Rules: [{
            ID: 'ExpireKernelAuditAfterRetention', Status: 'Enabled', Filter: { Prefix: '' },
            Expiration: { Days: plan.retentionDays },
            NoncurrentVersionExpiration: { NoncurrentDays: plan.retentionDays },
        }] })]);
    aws(['s3api', 'put-bucket-policy', '--bucket', plan.bucket, '--region', plan.region,
        '--policy', JSON.stringify(bucketPolicy(plan))]);
}

function applyPlan(plan, aws = runAws) {
    ensureBucket(plan, aws);
    const described = aws(['cloudtrail', 'describe-trails', '--trail-name-list', DEFAULTS.trailName,
        '--region', plan.region]);
    const operation = (described.trailList || []).length ? 'update-trail' : 'create-trail';
    aws(['cloudtrail', operation, '--name', DEFAULTS.trailName,
        '--s3-bucket-name', plan.bucket, '--region', plan.region,
        '--include-global-service-events', '--no-is-multi-region-trail', '--enable-log-file-validation']);
    aws(['cloudtrail', 'put-event-selectors', '--trail-name', DEFAULTS.trailName,
        '--region', plan.region, '--event-selectors', JSON.stringify(plan.selector)]);
    aws(['cloudtrail', 'start-logging', '--name', DEFAULTS.trailName, '--region', plan.region]);
    return aws(['cloudtrail', 'get-trail-status', '--name', DEFAULTS.trailName, '--region', plan.region]);
}

function verifyKmsEvents(plan, config, aws = runAws) {
    const table = config.coordinationTableName;
    if (!table) throw new Error('kernel.coordinationTableName requerido para verificar sin tocar no-repudio');
    const nonce = crypto.randomUUID();
    const key = { PK: { S: `cloudtrail-smoke#${nonce}` }, SK: { S: 'verification' } };
    const item = { ...key, expiresAt: { N: String(Math.floor(Date.now() / 1000) + 3600) } };
    aws(['dynamodb', 'put-item', '--table-name', table, '--item', JSON.stringify(item), '--region', plan.region]);
    aws(['dynamodb', 'get-item', '--table-name', table, '--key', JSON.stringify(key),
        '--consistent-read', '--region', plan.region]);
    aws(['dynamodb', 'delete-item', '--table-name', table, '--key', JSON.stringify(key), '--region', plan.region]);
    const keyDescription = aws(['kms', 'describe-key', '--key-id', DEFAULTS.keyAlias, '--region', plan.region]);
    const keyArn = keyDescription.KeyMetadata && keyDescription.KeyMetadata.Arn;
    if (!keyArn) throw new Error(`no se pudo resolver ${DEFAULTS.keyAlias} a un ARN`);
    const found = {};
    for (const eventName of ['Decrypt', 'GenerateDataKey']) {
        const result = aws(['cloudtrail', 'lookup-events', '--region', plan.region,
            '--lookup-attributes', `AttributeKey=EventName,AttributeValue=${eventName}`, '--max-results', '50']);
        found[eventName] = (result.Events || []).some((event) => {
            const raw = event.CloudTrailEvent || '';
            return raw.includes(keyArn);
        });
    }
    return found;
}

module.exports = { DEFAULTS, runAws, bucketName, bucketPolicy, buildPlan, ensureBucket, applyPlan, verifyKmsEvents };

if (require.main === module) {
    const apply = process.argv.includes('--apply');
    const verify = process.argv.includes('--verify');
    try {
        const identity = runAws(['sts', 'get-caller-identity']);
        const plan = buildPlan({ accountId: identity.Account });
        if (!apply) process.stdout.write(`${JSON.stringify({ mode: 'dry-run', plan }, null, 2)}\n`);
        else {
            const status = applyPlan(plan);
            const evidence = verify ? verifyKmsEvents(plan, require('./config-resolver').resolve().kernel) : null;
            process.stdout.write(`${JSON.stringify({ mode: 'apply', status, evidence }, null, 2)}\n`);
            if (verify && Object.values(evidence).some((value) => !value)) process.exitCode = 2;
        }
    } catch (error) {
        process.stderr.write(`kernel-cloudtrail-provision: ${error.message}\n`);
        process.exitCode = 1;
    }
}

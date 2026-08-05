'use strict';

// Paso ADMIN explícito para #5205. Es dry-run por defecto: solo --apply crea
// recursos y solo --verify escribe el ítem efímero de verificación.
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const DEFAULTS = Object.freeze({
    region: 'us-east-2', trailName: 'intrale-kernel-kms',
    keyAlias: 'alias/intrale-kernel-store', retentionDays: 365,
});

// Las dos operaciones que delatan uso real de la clave (runbook §3).
const CMK_EVENT_NAMES = Object.freeze(['Decrypt', 'GenerateDataKey']);
// CloudTrail entrega en lotes: un objeto puede contener eventos anteriores a su
// LastModified. El colchón evita descartar el objeto que trae la evidencia.
const DELIVERY_SLACK_MS = 15 * 60 * 1000;

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

function resolveKeyArn(plan, aws = runAws) {
    const described = aws(['kms', 'describe-key', '--key-id', DEFAULTS.keyAlias, '--region', plan.region]);
    const keyArn = described.KeyMetadata && described.KeyMetadata.Arn;
    if (!keyArn) throw new Error(`no se pudo resolver ${DEFAULTS.keyAlias} a un ARN`);
    return keyArn;
}

// Genera uso real de la CMK: escribe, lee y borra un ítem efímero en la tabla de
// coordinación (nunca en la tabla append-only de no-repudio). Requiere una
// identidad con kms:Decrypt/GenerateDataKey sobre la CMK: la del pipeline NO la
// tiene a propósito.
function emitCmkUsage(plan, config, aws = runAws) {
    const table = config.coordinationTableName;
    if (!table) throw new Error('kernel.coordinationTableName requerido para verificar sin tocar no-repudio');
    const startedAtMs = Date.now();
    const nonce = crypto.randomUUID();
    const key = { PK: { S: `cloudtrail-smoke#${nonce}` }, SK: { S: 'verification' } };
    const item = { ...key, expiresAt: { N: String(Math.floor(startedAtMs / 1000) + 3600) } };
    aws(['dynamodb', 'put-item', '--table-name', table, '--item', JSON.stringify(item), '--region', plan.region]);
    aws(['dynamodb', 'get-item', '--table-name', table, '--key', JSON.stringify(key),
        '--consistent-read', '--region', plan.region]);
    aws(['dynamodb', 'delete-item', '--table-name', table, '--key', JSON.stringify(key), '--region', plan.region]);
    return { table, nonce, startedAtMs };
}

function listTrailObjects(plan, { sinceMs = 0 } = {}, aws = runAws) {
    const prefix = `AWSLogs/${plan.accountId}/CloudTrail/${plan.region}/`;
    const listed = aws(['s3api', 'list-objects-v2', '--bucket', plan.bucket,
        '--prefix', prefix, '--region', plan.region]);
    return (listed.Contents || [])
        .filter((entry) => String(entry.Key).endsWith('.json.gz'))
        .filter((entry) => !sinceMs || Date.parse(entry.LastModified) >= sinceMs - DELIVERY_SLACK_MS)
        .sort((a, b) => Date.parse(a.LastModified) - Date.parse(b.LastModified))
        .map((entry) => entry.Key);
}

function readTrailObject(plan, objectKey, aws = runAws) {
    const tmp = path.join(os.tmpdir(), `kernel-trail-${crypto.randomUUID()}.json.gz`);
    try {
        aws(['s3api', 'get-object', '--bucket', plan.bucket, '--key', objectKey,
            '--region', plan.region, tmp]);
        return JSON.parse(zlib.gunzipSync(fs.readFileSync(tmp)).toString('utf8')).Records || [];
    } finally {
        try { fs.unlinkSync(tmp); } catch (_) { /* el temporal es descartable */ }
    }
}

// Puro: filtra los eventos KMS del trail que tocan la CMK del kernel.
function extractCmkUsage(records, keyArn) {
    const keyId = String(keyArn).split('/').pop();
    const usage = Object.fromEntries(CMK_EVENT_NAMES.map((name) => [name, []]));
    for (const record of records || []) {
        if (record.eventSource !== 'kms.amazonaws.com') continue;
        if (!CMK_EVENT_NAMES.includes(record.eventName)) continue;
        const raw = JSON.stringify(record);
        if (!raw.includes(keyArn) && !raw.includes(keyId)) continue;
        usage[record.eventName].push({
            eventTime: record.eventTime,
            principal: (record.userIdentity && (record.userIdentity.arn || record.userIdentity.type)) || null,
            invokedBy: record.sourceIPAddress || null,
            errorCode: record.errorCode || null,
        });
    }
    return usage;
}

// Lee el TRAIL PERSISTENTE en S3, no el Event history de 90 días: es la única
// fuente con la retención que exige el runbook §3.
function verifyKmsEventsFromTrail(plan, { keyArn, sinceMs = 0 } = {}, deps = {}) {
    if (!keyArn) throw new Error('keyArn requerido para verificar el rastro de la CMK');
    const aws = deps.aws || runAws;
    const readObject = deps.readObject || ((objectKey) => readTrailObject(plan, objectKey, aws));
    const usage = Object.fromEntries(CMK_EVENT_NAMES.map((name) => [name, []]));
    for (const objectKey of listTrailObjects(plan, { sinceMs }, aws)) {
        const found = extractCmkUsage(readObject(objectKey), keyArn);
        for (const name of CMK_EVENT_NAMES) usage[name].push(...found[name]);
    }
    return usage;
}

// Un evento con errorCode prueba que el trail captura los intentos denegados,
// pero NO que la clave se haya usado. La evidencia que pide el runbook §3 es uso
// real, así que cada operación exige al menos un evento EXITOSO: contar los
// denegados dejaría la verificación fail-open (un AccessDenied daría por probada
// una postura de auditoría que nunca se ejerció).
function successfulCmkUsage(usage, name) {
    return (usage[name] || []).filter((event) => !event.errorCode);
}

function isCmkUsageComplete(usage) {
    return CMK_EVENT_NAMES.every((name) => successfulCmkUsage(usage, name).length > 0);
}

module.exports = {
    DEFAULTS, CMK_EVENT_NAMES, runAws, bucketName, bucketPolicy, buildPlan, ensureBucket, applyPlan,
    resolveKeyArn, emitCmkUsage, listTrailObjects, readTrailObject, extractCmkUsage,
    verifyKmsEventsFromTrail, isCmkUsageComplete, successfulCmkUsage,
};

function flagValue(name, fallback) {
    const index = process.argv.indexOf(name);
    return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

if (require.main === module) {
    const apply = process.argv.includes('--apply');
    const emit = process.argv.includes('--emit-usage');
    const verify = process.argv.includes('--verify');
    try {
        const identity = runAws(['sts', 'get-caller-identity']);
        const plan = buildPlan({ accountId: identity.Account });
        const report = { identity: identity.Arn, plan: undefined, status: undefined, emitted: undefined, evidence: undefined };
        if (!apply && !emit && !verify) {
            process.stdout.write(`${JSON.stringify({ mode: 'dry-run', plan }, null, 2)}\n`);
        } else {
            if (apply) report.status = applyPlan(plan);
            // El emisor necesita kms:Decrypt sobre la CMK; el verificador sólo lee S3.
            // Se corren con identidades distintas a propósito (runbook §3).
            let sinceMs = Date.parse(flagValue('--since', '')) || 0;
            if (emit) {
                report.emitted = emitCmkUsage(plan, require('./config-resolver').resolve().kernel);
                sinceMs = report.emitted.startedAtMs;
            }
            if (verify) {
                const keyArn = resolveKeyArn(plan);
                const deadline = Date.now() + Number(flagValue('--wait', '0')) * 1000;
                do {
                    report.evidence = verifyKmsEventsFromTrail(plan, { keyArn, sinceMs });
                    if (isCmkUsageComplete(report.evidence)) break;
                    if (Date.now() < deadline) sleepSync(60_000);
                } while (Date.now() < deadline);
                report.keyArn = keyArn;
                report.complete = isCmkUsageComplete(report.evidence);
            }
            process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
            // Exit 2 = falta evidencia todavía (reintentar), NO recrear el trail.
            if (verify && !report.complete) process.exitCode = 2;
        }
    } catch (error) {
        process.stderr.write(`kernel-cloudtrail-provision: ${error.message}\n`);
        process.exitCode = 1;
    }
}

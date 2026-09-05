'use strict';

// Paso ADMIN explícito para #5205. Es dry-run por defecto: solo --apply crea
// recursos y solo --verify escribe el ítem efímero de verificación.
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { redactPrincipal, buildEvidence } = require('./kernel-audit-evidence');

const DEFAULTS = Object.freeze({
    region: 'us-east-2', trailName: 'intrale-kernel-kms',
    keyAlias: 'alias/intrale-kernel-store', retentionDays: 365,
    // Separación de identidades del runbook §3: el runtime descifra el store
    // pero NO lee ni altera su propia auditoría; el auditor lee la auditoría
    // pero no puede descifrar. Ninguno de los dos puede aprovisionar.
    runtimeUserName: 'intrale-kernel-runtime', auditorUserName: 'claude-code',
});

// Las dos operaciones que delatan uso real de la clave (runbook §3).
const CMK_EVENT_NAMES = Object.freeze(['Decrypt', 'GenerateDataKey']);
// CloudTrail entrega en lotes: un objeto puede contener eventos anteriores a su
// LastModified. El colchón evita descartar el objeto que trae la evidencia.
const DELIVERY_SLACK_MS = 15 * 60 * 1000;

// #5207 — El bucket del trail crece de forma MONÓTONA: un `list-objects-v2` sin
// acotar sobre este destino ya devuelve >1 MiB, que es exactamente el `maxBuffer`
// por defecto de `spawnSync`. Al desbordar, Node NO llena `stderr`: devuelve
// `status: null` y pone el detalle en `result.error.code` (`ENOBUFS`).
//
// La versión anterior sólo miraba `status !== 0` e interpolaba un `stderr` vacío,
// así que `--verify` moría con el texto `aws s3api list-objects-v2 falló:` y NADA
// después. Es el peor modo de falla posible en una herramienta de auditoría: un
// error mudo se lee como "AWS denegó" cuando en realidad el comando nunca llegó a
// completarse, y manda a investigar permisos por un desborde local de buffer.
const AWS_MAX_BUFFER = 64 * 1024 * 1024;

function runAws(args, options = {}) {
    const result = spawnSync('aws', [...args, '--output', 'json'], {
        encoding: 'utf8',
        env: options.env || process.env,
        shell: false,
        maxBuffer: options.maxBuffer || AWS_MAX_BUFFER,
    });
    // `error` cubre lo que `status`/`stderr` no ven: ENOBUFS (salida desbordada),
    // ENOENT (aws CLI ausente del PATH), timeouts. Sin esta rama el diagnóstico
    // sale vacío y el operador no tiene por dónde empezar.
    if (result.error) {
        throw new Error(`aws ${args.slice(0, 2).join(' ')} no pudo ejecutarse: ${result.error.code || result.error.message}`);
    }
    if (result.status !== 0) {
        const detalle = (result.stderr || '').trim() || `exit ${result.status} sin stderr`;
        throw new Error(`aws ${args.slice(0, 2).join(' ')} falló: ${detalle}`);
    }
    return result.stdout.trim() ? JSON.parse(result.stdout) : {};
}

function bucketName(accountId, region) {
    if (!/^\d{12}$/.test(String(accountId))) throw new Error('accountId AWS inválido');
    if (!/^[a-z0-9-]+$/.test(region)) throw new Error('region AWS inválida');
    return `intrale-kernel-cloudtrail-${accountId}-${region}`;
}

// Las capacidades del runtime sobre el destino de auditoría que se niegan de
// forma explícita. Un deny explícito gana sobre cualquier allow, presente o
// futuro: si mañana alguien le adjunta una policy amplia al runtime, estas
// operaciones siguen bloqueadas. La lista es también el contrato que verifica
// la matriz de pruebas negativas (#5213 CA-5).
const RUNTIME_DENIED_BUCKET_ACTIONS = Object.freeze([
    's3:DeleteObject', 's3:DeleteObjectVersion', 's3:PutObject',
    's3:PutLifecycleConfiguration', 's3:PutBucketPolicy', 's3:DeleteBucketPolicy',
    's3:PutBucketVersioning', 's3:PutEncryptionConfiguration', 's3:DeleteBucket',
    // El runtime tampoco LEE la auditoría: quien genera la evidencia no es
    // quien la consulta (runbook §3).
    's3:GetObject', 's3:GetObjectVersion', 's3:ListBucket', 's3:ListBucketVersions',
]);

function bucketPolicy({ bucket, accountId, trailArn, runtimePrincipalArn, auditorPrincipalArn }) {
    const bucketArn = `arn:aws:s3:::${bucket}`;
    const statements = [
        { Sid: 'AWSCloudTrailAclCheck', Effect: 'Allow',
            Principal: { Service: 'cloudtrail.amazonaws.com' }, Action: 's3:GetBucketAcl',
            Resource: bucketArn,
            Condition: { StringEquals: { 'AWS:SourceArn': trailArn } } },
        { Sid: 'AWSCloudTrailWrite', Effect: 'Allow',
            Principal: { Service: 'cloudtrail.amazonaws.com' }, Action: 's3:PutObject',
            Resource: `${bucketArn}/AWSLogs/${accountId}/*`,
            Condition: { StringEquals: { 's3:x-amz-acl': 'bucket-owner-full-control',
                'AWS:SourceArn': trailArn } } },
        // TLS-only. Va sobre `Principal: '*'` a propósito: la garantía es del
        // canal, no de quién llama, y tiene que cubrir también al servicio.
        { Sid: 'DenyInsecureTransport', Effect: 'Deny', Principal: '*', Action: 's3:*',
            Resource: [bucketArn, `${bucketArn}/*`],
            Condition: { Bool: { 'aws:SecureTransport': 'false' } } },
    ];
    if (runtimePrincipalArn) {
        statements.push({ Sid: 'DenyRuntimeAuditAccess', Effect: 'Deny',
            Principal: { AWS: runtimePrincipalArn },
            Action: [...RUNTIME_DENIED_BUCKET_ACTIONS],
            Resource: [bucketArn, `${bucketArn}/*`] });
    }
    if (auditorPrincipalArn) {
        // Acceso de auditoría declarado en el destino, separado del runtime y
        // de sólo lectura: el auditor consulta el rastro, no lo modifica.
        statements.push({ Sid: 'AllowAuditorRead', Effect: 'Allow',
            Principal: { AWS: auditorPrincipalArn },
            Action: ['s3:GetObject', 's3:GetObjectVersion', 's3:ListBucket', 's3:GetBucketLocation'],
            Resource: [bucketArn, `${bucketArn}/*`] });
    }
    return { Version: '2012-10-17', Statement: statements };
}

function buildPlan({ accountId, region = DEFAULTS.region, retentionDays = DEFAULTS.retentionDays } = {}) {
    const bucket = bucketName(accountId, region);
    const trailArn = `arn:aws:cloudtrail:${region}:${accountId}:trail/${DEFAULTS.trailName}`;
    return { accountId, region, bucket, trailArn, retentionDays,
        trailName: DEFAULTS.trailName,
        runtimePrincipalArn: `arn:aws:iam::${accountId}:user/${DEFAULTS.runtimeUserName}`,
        auditorPrincipalArn: `arn:aws:iam::${accountId}:user/${DEFAULTS.auditorUserName}`,
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

// #5207 — Los prefijos de día que hay que listar para cubrir [desde, hasta].
// CloudTrail particiona por `YYYY/MM/DD` en UTC, así que acotar el prefijo mueve
// el filtro al SERVIDOR: se listan los 1-2 días relevantes en vez del bucket
// entero. Sin esto, el listado crece para siempre y el filtro por `LastModified`
// llega tarde — ya se descargaron y bufferearon todas las claves históricas.
function trailDayPrefixes(plan, desdeMs, hastaMs) {
    const base = `AWSLogs/${plan.accountId}/CloudTrail/${plan.region}/`;
    const prefijos = [];
    const DIA_MS = 24 * 60 * 60 * 1000;
    // Se recorre por día UTC inclusive en ambos extremos. El tope defensivo evita
    // que un `sinceMs` corrupto (o muy viejo) genere miles de llamadas a S3.
    const MAX_DIAS = 32;
    let cursor = Date.UTC(
        new Date(desdeMs).getUTCFullYear(),
        new Date(desdeMs).getUTCMonth(),
        new Date(desdeMs).getUTCDate(),
    );
    while (cursor <= hastaMs && prefijos.length < MAX_DIAS) {
        const d = new Date(cursor);
        const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(d.getUTCDate()).padStart(2, '0');
        prefijos.push(`${base}${d.getUTCFullYear()}/${mm}/${dd}/`);
        cursor += DIA_MS;
    }
    return prefijos;
}

// Lista un prefijo paginando. `list-objects-v2` corta en 1000 claves y devuelve
// `NextToken`; ignorarlo daba un listado SILENCIOSAMENTE incompleto — el modo de
// falla más peligroso acá, porque "no encontré el evento" se confunde con "el
// control no se ejerció".
function listPrefixPaginado(plan, prefix, aws) {
    const claves = [];
    let token = null;
    let vueltas = 0;
    do {
        const args = ['s3api', 'list-objects-v2', '--bucket', plan.bucket,
            '--prefix', prefix, '--region', plan.region];
        if (token) args.push('--starting-token', token);
        const listed = aws(args);
        claves.push(...(listed.Contents || []));
        token = listed.NextToken || null;
        vueltas += 1;
    } while (token && vueltas < 100);
    return claves;
}

function listTrailObjects(plan, { sinceMs = 0 } = {}, aws = runAws) {
    // Con ventana declarada se acota por prefijo de día (barato y estable en el
    // tiempo). Sin ventana no hay forma de acotar, así que se pagina el prefijo
    // completo: más caro, pero nunca trunca ni desborda.
    const prefijos = sinceMs
        ? trailDayPrefixes(plan, sinceMs - DELIVERY_SLACK_MS, Date.now())
        : [`AWSLogs/${plan.accountId}/CloudTrail/${plan.region}/`];

    // Dedupe por Key: los prefijos de día son disjuntos en S3, pero el listado
    // alimenta a `verifyKmsEventsFromTrail`, que ACUMULA los eventos de cada
    // objeto que lee. Procesar dos veces la misma clave inflaría el conteo de
    // uso de la CMK — evidencia de auditoría duplicada, que es peor que faltante
    // porque parece más sólida. El costo de garantizarlo acá es nulo.
    const porKey = new Map();
    for (const prefix of prefijos) {
        for (const entry of listPrefixPaginado(plan, prefix, aws)) {
            if (!porKey.has(entry.Key)) porKey.set(entry.Key, entry);
        }
    }

    return [...porKey.values()]
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

// Quién se espera que ejecute cada operación NO es el mismo principal, y tratarlo
// como si lo fuera hace la verificación imposible de satisfacer:
//
// - `Decrypt` lo pide el USUARIO runtime a través de DynamoDB: aparece con su ARN.
// - `GenerateDataKey` lo ejecuta DYNAMODB en nombre de la tabla, como `AWSService`.
//   El usuario runtime NO tiene `kms:GenerateDataKey` en ninguna policy —
//   verificado el 2026-08-05: `no identity-based policy allows the
//   kms:GenerateDataKey action`— así que exigir su ARN ahí sería exigir algo que
//   AWS nunca va a emitir.
//
// Lo que prueba uso legítimo en `GenerateDataKey` es que la invocación venga de
// DynamoDB, que es exactamente lo que ata el `kms:ViaService` de la key policy:
// una data key generada desde otro servicio sería el hallazgo.
const EXPECTED_INVOKED_BY = 'dynamodb.amazonaws.com';

function principalEsperado(record, eventName, expectedPrincipalArn) {
    const identity = record.userIdentity || {};
    if (eventName === 'GenerateDataKey') {
        return identity.invokedBy === EXPECTED_INVOKED_BY
            || record.sourceIPAddress === EXPECTED_INVOKED_BY;
    }
    if (!expectedPrincipalArn) return null;
    return redactPrincipal(identity.arn) === redactPrincipal(expectedPrincipalArn);
}

// Puro: filtra los eventos KMS del trail que tocan la CMK del kernel.
//
// #5213 CA-3 — el evento sale YA PROYECTADO: `principal` es `user/<nombre>`, no
// el ARN completo que trae `userIdentity.arn` (incluye el account id). La
// correlación con el principal esperado se resuelve acá, mientras todavía se
// tiene el ARN crudo en memoria, y viaja como el booleano `principalExpected`.
// Así ningún consumidor necesita el ARN, que es la única forma de garantizar
// que no termine escrito en un artefacto.
function extractCmkUsage(records, keyArn, { expectedPrincipalArn } = {}) {
    const keyId = String(keyArn).split('/').pop();
    const usage = Object.fromEntries(CMK_EVENT_NAMES.map((name) => [name, []]));
    for (const record of records || []) {
        if (record.eventSource !== 'kms.amazonaws.com') continue;
        if (!CMK_EVENT_NAMES.includes(record.eventName)) continue;
        const raw = JSON.stringify(record);
        if (!raw.includes(keyArn) && !raw.includes(keyId)) continue;
        const identity = record.userIdentity || {};
        usage[record.eventName].push({
            eventTime: record.eventTime,
            principal: redactPrincipal(identity.arn || identity.type || null),
            principalExpected: principalEsperado(record, record.eventName, expectedPrincipalArn),
            invokedBy: record.sourceIPAddress || null,
            errorCode: record.errorCode || null,
        });
    }
    return usage;
}

// Lee el TRAIL PERSISTENTE en S3, no el Event history de 90 días: es la única
// fuente con la retención que exige el runbook §3.
function verifyKmsEventsFromTrail(plan, { keyArn, sinceMs = 0, expectedPrincipalArn } = {}, deps = {}) {
    if (!keyArn) throw new Error('keyArn requerido para verificar el rastro de la CMK');
    const aws = deps.aws || runAws;
    const readObject = deps.readObject || ((objectKey) => readTrailObject(plan, objectKey, aws));
    const usage = Object.fromEntries(CMK_EVENT_NAMES.map((name) => [name, []]));
    for (const objectKey of listTrailObjects(plan, { sinceMs }, aws)) {
        const found = extractCmkUsage(readObject(objectKey), keyArn, { expectedPrincipalArn });
        for (const name of CMK_EVENT_NAMES) usage[name].push(...found[name]);
    }
    return usage;
}

// Un evento con errorCode prueba que el trail captura los intentos denegados,
// pero NO que la clave se haya usado. La evidencia que pide el runbook §3 es uso
// real, así que cada operación exige al menos un evento EXITOSO: contar los
// denegados dejaría la verificación fail-open (un AccessDenied daría por probada
// una postura de auditoría que nunca se ejerció).
//
// #5213 CA-2 — además del éxito se exige que el evento venga del principal
// esperado cuando la verificación declaró uno. Un `Decrypt` exitoso de OTRA
// identidad prueba que el trail funciona, pero no correlaciona el uso de la CMK
// con el runtime del kernel, que es lo que la CA pide demostrar.
// `principalExpected: null` significa "no se declaró expectativa" y no descarta.
function successfulCmkUsage(usage, name) {
    return (usage[name] || []).filter((event) => !event.errorCode && event.principalExpected !== false);
}

function isCmkUsageComplete(usage) {
    return CMK_EVENT_NAMES.every((name) => successfulCmkUsage(usage, name).length > 0);
}

// Postura efectiva del destino leída de AWS, no de la policy que creemos haber
// aplicado (#5213 CA-1/CA-4). Devuelve un objeto de booleanos: cada campo es
// una garantía de la CA, así que un `false` nombra exactamente qué se rompió.
function verifyDestinationPosture(plan, { keyArn } = {}, aws = runAws) {
    const status = aws(['cloudtrail', 'get-trail-status', '--name', plan.trailName, '--region', plan.region]);
    const described = aws(['cloudtrail', 'describe-trails', '--trail-name-list', plan.trailName,
        '--region', plan.region]);
    const trail = (described.trailList || [])[0] || {};
    const selectors = aws(['cloudtrail', 'get-event-selectors', '--trail-name', plan.trailName,
        '--region', plan.region]);
    const selector = (selectors.EventSelectors || [])[0] || {};
    const access = aws(['s3api', 'get-public-access-block', '--bucket', plan.bucket, '--region', plan.region]);
    const block = access.PublicAccessBlockConfiguration || {};
    const encryption = aws(['s3api', 'get-bucket-encryption', '--bucket', plan.bucket, '--region', plan.region]);
    const rule = ((encryption.ServerSideEncryptionConfiguration || {}).Rules || [])[0] || {};
    const sse = rule.ApplyServerSideEncryptionByDefault || {};
    const lifecycle = aws(['s3api', 'get-bucket-lifecycle-configuration', '--bucket', plan.bucket,
        '--region', plan.region]);
    const policy = JSON.parse((aws(['s3api', 'get-bucket-policy', '--bucket', plan.bucket,
        '--region', plan.region]).Policy) || '{}');
    const sids = new Set((policy.Statement || []).map((s) => s.Sid));

    return {
        trailLogging: status.IsLogging === true,
        trailRegion: trail.HomeRegion === plan.region,
        logFileValidation: trail.LogFileValidationEnabled === true,
        managementEventsReadWrite: selector.IncludeManagementEvents === true
            && selector.ReadWriteType === 'All',
        bucketPrivate: [block.BlockPublicAcls, block.IgnorePublicAcls,
            block.BlockPublicPolicy, block.RestrictPublicBuckets].every((flag) => flag === true),
        bucketEncrypted: Boolean(sse.SSEAlgorithm),
        // La clave del destino debe ser DISTINTA de la CMK auditada: si fuera la
        // misma, deshabilitarla para contener un incidente del store dejaría
        // ilegible la evidencia del propio incidente.
        destinationKeySeparateFromCmk: sse.SSEAlgorithm === 'AES256'
            || (Boolean(sse.KMSMasterKeyID) && String(sse.KMSMasterKeyID) !== String(keyArn || '')),
        retentionDeclared: ((lifecycle.Rules || []).some((r) => r.Status === 'Enabled'
            && r.Expiration && r.Expiration.Days === plan.retentionDays)),
        tlsOnly: sids.has('DenyInsecureTransport'),
        runtimeDeniedOnDestination: sids.has('DenyRuntimeAuditAccess'),
        auditorAccessSeparated: sids.has('AllowAuditorRead'),
    };
}

function posturaCompleta(postura) {
    return Object.values(postura).every(Boolean);
}

module.exports = {
    DEFAULTS, CMK_EVENT_NAMES, RUNTIME_DENIED_BUCKET_ACTIONS,
    runAws, bucketName, bucketPolicy, buildPlan, ensureBucket, applyPlan,
    resolveKeyArn, emitCmkUsage, listTrailObjects, readTrailObject, extractCmkUsage,
    trailDayPrefixes, listPrefixPaginado, AWS_MAX_BUFFER,
    verifyKmsEventsFromTrail, isCmkUsageComplete, successfulCmkUsage,
    verifyDestinationPosture, posturaCompleta, principalEsperado, EXPECTED_INVOKED_BY,
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
        // #5213 CA-3 — TODO lo que se imprime pasa por la proyección allowlist.
        // El plan crudo lleva el account id en el bucket y el ARN entero del
        // trail; la identidad, el ARN del llamador. Nada de eso puede quedar en
        // el stdout, que termina en logs y en el issue.
        const report = { identity: redactPrincipal(identity.Arn) };
        if (!apply && !emit && !verify) {
            process.stdout.write(`${JSON.stringify(buildEvidence({
                plan, keyAlias: DEFAULTS.keyAlias, generatedAt: new Date().toISOString(),
            }), null, 2)}\n`);
        } else {
            if (apply) report.status = { logging: applyPlan(plan).IsLogging === true };
            // El emisor necesita kms:Decrypt sobre la CMK; el verificador sólo lee S3.
            // Se corren con identidades distintas a propósito (runbook §3).
            let sinceMs = Date.parse(flagValue('--since', '')) || 0;
            if (emit) {
                const emitted = emitCmkUsage(plan, require('./config-resolver').resolve().kernel);
                sinceMs = emitted.startedAtMs;
                // El nonce y el nombre de tabla no aportan a la evidencia y sí
                // describen el store: alcanza con confirmar que se emitió.
                report.emitted = { emitido: true };
            }
            let usage;
            let keyArn;
            if (verify) {
                keyArn = resolveKeyArn(plan);
                const deadline = Date.now() + Number(flagValue('--wait', '0')) * 1000;
                do {
                    usage = verifyKmsEventsFromTrail(plan, { keyArn, sinceMs,
                        expectedPrincipalArn: plan.runtimePrincipalArn });
                    if (isCmkUsageComplete(usage)) break;
                    if (Date.now() < deadline) sleepSync(60_000);
                } while (Date.now() < deadline);
                report.complete = isCmkUsageComplete(usage);
                report.postura = verifyDestinationPosture(plan, { keyArn });
                report.posturaCompleta = posturaCompleta(report.postura);
            }
            const evidence = buildEvidence({ plan, keyArn, keyAlias: DEFAULTS.keyAlias,
                usage, generatedAt: new Date().toISOString() });
            process.stdout.write(`${JSON.stringify({ ...report, ...evidence }, null, 2)}\n`);
            // Exit 2 = falta evidencia todavía (reintentar), NO recrear el trail.
            if (verify && !report.complete) process.exitCode = 2;
            // Exit 3 = el trail existe pero la postura del destino no cumple.
            // Se distingue de 2 porque acá reintentar no sirve: hay que corregir.
            if (verify && report.complete && !report.posturaCompleta) process.exitCode = 3;
        }
    } catch (error) {
        // El stderr del AWS CLI llega crudo hasta acá y trae ARNs y account id
        // en los mensajes de autorización (#5213 CA-3): se redacta antes de
        // escribirlo, porque este stream también queda en los logs del pipeline.
        const { redactSecretValue } = require('./redact');
        process.stderr.write(`kernel-cloudtrail-provision: ${redactSecretValue(error.message)}\n`);
        process.exitCode = 1;
    }
}

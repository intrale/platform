'use strict';

// =============================================================================
// kernel-cmk-provision.js — CMK de KMS para el store durable del kernel
// (#5126 · runbook-cutover-durable.md §3)
//
// POR QUÉ EXISTE
// --------------
// Las tablas del kernel se crearon con cifrado **AWS-owned** (`SSEDescription:
// null`). El runbook §3 lo declara bloqueante del cutover, con tres motivos que
// no son estéticos:
//
//   - Una clave AWS-owned **no tiene key policy** → no hay dónde declarar quién
//     puede descifrar.
//   - **No registra uso en CloudTrail** → la reconciliación de §2 se queda sin
//     ancla de auditoría: no se puede demostrar quién leyó qué en la ventana.
//   - **No se puede deshabilitar** → el rollback queda sin kill-switch
//     criptográfico. Con una CMK se deshabilita la clave y todo el store queda
//     ilegible en un solo movimiento.
//
// Importa ANTES de la primera escritura, no después: los ítems `signature#` y
// `audit#` son append-only e imborrables por policy IAM (#5124). Lo que se
// escriba bajo una clave sin key policy queda así para siempre.
//
// QUÉ HACE (idempotente, dry-run por defecto)
//   1. Crea la CMK con key policy de principals explícitos y rotación anual.
//   2. Le pone el alias declarado.
//   3. Cambia el SSE de las dos tablas a KMS con esa CMK (`update-table`).
//   4. Crea/attacha una policy IAM **separada** (`IntraleKernelKms`) que le da al
//      runtime `Decrypt`/`GenerateDataKey`/`DescribeKey` acotados por
//      `kms:ViaService` a DynamoDB de la región.
//
// El paso 4 es una policy APARTE a propósito: no toca `IntraleKernelStore`, que
// ya está attachada y en uso. Sumar permisos por una policy nueva es aditivo y
// reversible con un `detach`; reescribir la existente no lo es.
//
// GUARDAS (mismas que kernel-aws-bootstrap.js, por los mismos motivos)
//   - Prefijo `intrale-kernel-` obligatorio en las tablas; aborta antes de AWS.
//   - Usuario objetivo acotado a `intrale-kernel-*`; principals de producción en
//     lista negra.
//   - `Principal: "*"` en la key policy es un error fatal, no una advertencia.
//   - Dry-run por defecto: sin `--apply` no hay una sola mutación.
//   - El account-id se deriva en runtime y no se imprime.
//
// USO
//   node .pipeline/lib/kernel-cmk-provision.js --admin-profile <admin>
//   node .pipeline/lib/kernel-cmk-provision.js --admin-profile <admin> --apply
// =============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TABLE_PREFIX = 'intrale-kernel-';
const USER_PREFIX = 'intrale-kernel-';
const FORBIDDEN_PRINCIPALS = Object.freeze(['claude-code', 'root', 'admin']);

const DEFAULTS = Object.freeze({
    region: 'us-east-2',
    table: 'intrale-kernel-state',
    coordinationTable: 'intrale-kernel-coordination',
    user: 'intrale-kernel-runtime',
    alias: 'alias/intrale-kernel-store',
    kmsPolicyName: 'IntraleKernelKms',
});

const AWS_CANDIDATES = [
    'C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe',
    'aws',
];

function resolveAwsBin() {
    for (const c of AWS_CANDIDATES) {
        if (c === 'aws') return c;
        try { if (fs.existsSync(c)) return c; } catch (_) { /* sigue */ }
    }
    return 'aws';
}

const AWS_BIN = resolveAwsBin();

function aws(args, opts = {}) {
    const full = opts.profile ? [...args, '--profile', opts.profile] : [...args];
    const res = spawnSync(AWS_BIN, full, {
        encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    });
    const stdout = res.stdout || '';
    let json = null;
    if (res.status === 0 && stdout.trim().startsWith('{')) {
        try { json = JSON.parse(stdout); } catch (_) { json = null; }
    }
    return { ok: res.status === 0, json, stdout, stderr: res.stderr || '', code: res.status };
}

function parseArgs(argv) {
    const out = {
        apply: false,
        region: DEFAULTS.region,
        table: DEFAULTS.table,
        coordinationTable: DEFAULTS.coordinationTable,
        user: DEFAULTS.user,
        alias: DEFAULTS.alias,
        kmsPolicyName: DEFAULTS.kmsPolicyName,
        adminProfile: process.env.AWS_PROFILE || 'default',
    };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        const next = () => argv[++i];
        switch (a) {
            case '--apply': out.apply = true; break;
            case '--region': out.region = next(); break;
            case '--table': out.table = next(); break;
            case '--coordination-table': out.coordinationTable = next(); break;
            case '--user': out.user = next(); break;
            case '--alias': out.alias = next(); break;
            case '--admin-profile': out.adminProfile = next(); break;
            default:
                if (a.startsWith('--')) throw new Error(`flag desconocido: ${a}`);
        }
    }
    return out;
}

function assertGuards(cfg) {
    for (const t of [cfg.table, cfg.coordinationTable]) {
        if (!t || !t.startsWith(TABLE_PREFIX)) {
            throw new Error(`G1: tabla "${t}" fuera del prefijo "${TABLE_PREFIX}"; abortado antes de tocar AWS`);
        }
    }
    if (!cfg.user || !cfg.user.startsWith(USER_PREFIX) || FORBIDDEN_PRINCIPALS.includes(cfg.user)) {
        throw new Error(`G4: usuario "${cfg.user}" no habilitado para este script`);
    }
    if (!/^alias\/[A-Za-z0-9/_-]+$/.test(cfg.alias)) {
        throw new Error(`alias inválido: ${cfg.alias}`);
    }
}

// -----------------------------------------------------------------------------
// Key policy — principals EXPLÍCITOS (runbook §3)
// -----------------------------------------------------------------------------

/**
 * En una key policy, `Resource: "*"` significa "esta clave" y es la forma
 * canónica: no es un comodín de recursos. Lo que el runbook prohíbe es un
 * `Principal` comodín, que es lo que acá se evita.
 *
 * El statement de administración delega en el IAM de la cuenta
 * (`arn:aws:iam::<acct>:root`). Es un ARN explícito, no `"*"`, y es necesario:
 * una CMK sin administrador declarado queda **inadministrable para siempre** —
 * no se puede cambiar su policy ni programar su borrado. Ese es el único
 * escenario peor que no tener CMK.
 */
function buildKeyPolicy(cfg, accountId) {
    const policy = {
        Version: '2012-10-17',
        Id: 'intrale-kernel-store-cmk',
        Statement: [
            {
                Sid: 'AdminDelegatedToAccountIAM',
                Effect: 'Allow',
                Principal: { AWS: `arn:aws:iam::${accountId}:root` },
                Action: 'kms:*',
                Resource: '*',
            },
            {
                Sid: 'RuntimeUseViaDynamoDBOnly',
                Effect: 'Allow',
                Principal: { AWS: `arn:aws:iam::${accountId}:user/${cfg.user}` },
                Action: [
                    'kms:Decrypt',
                    'kms:GenerateDataKey',
                    'kms:DescribeKey',
                ],
                Resource: '*',
                // La clave no sirve desde ningún otro servicio: si alguien roba la
                // credencial del runtime, no puede usar la CMK para descifrar nada
                // por fuera de DynamoDB de esta región.
                Condition: {
                    StringEquals: { 'kms:ViaService': `dynamodb.${cfg.region}.amazonaws.com` },
                },
            },
        ],
    };

    assertNoWildcardPrincipal(policy);
    return policy;
}

/** Un `Principal: "*"` en una key policy abre la clave a toda AWS. Fatal. */
function assertNoWildcardPrincipal(policy) {
    for (const st of policy.Statement || []) {
        const p = st.Principal;
        if (p === '*' || (p && (p.AWS === '*' || (Array.isArray(p.AWS) && p.AWS.includes('*'))))) {
            throw new Error(`key policy con Principal comodín en "${st.Sid}": prohibido por el runbook §3`);
        }
    }
}

/** Policy IAM separada y aditiva: no toca `IntraleKernelStore`. */
function buildKmsIamPolicy(cfg, keyArn) {
    return {
        Version: '2012-10-17',
        Statement: [
            {
                Sid: 'UseKernelCmkViaDynamoDB',
                Effect: 'Allow',
                Action: ['kms:Decrypt', 'kms:GenerateDataKey', 'kms:DescribeKey'],
                Resource: keyArn,
                Condition: {
                    StringEquals: { 'kms:ViaService': `dynamodb.${cfg.region}.amazonaws.com` },
                },
            },
        ],
    };
}

// -----------------------------------------------------------------------------
// Pasos
// -----------------------------------------------------------------------------

function stepIdentity(cfg, plan) {
    const res = aws(['sts', 'get-caller-identity', '--output', 'json'], { profile: cfg.adminProfile });
    if (!res.ok || !res.json) {
        throw new Error(`no se pudo verificar la identidad admin con el profile "${cfg.adminProfile}"`);
    }
    plan.steps.push({ step: 'identity', status: 'ok', detail: redact(res.json.Arn) });
    return res.json.Account;
}

function redact(s) {
    return String(s || '').replace(/\d{12}/g, '<ACCOUNT>');
}

function findExistingCmk(cfg) {
    const res = aws(['kms', 'describe-key', '--key-id', cfg.alias, '--region', cfg.region, '--output', 'json'],
        { profile: cfg.adminProfile });
    if (res.ok && res.json && res.json.KeyMetadata) return res.json.KeyMetadata;
    return null;
}

function stepCmk(cfg, plan, accountId, keyPolicy) {
    const existing = findExistingCmk(cfg);

    if (existing) {
        if (existing.KeyManager !== 'CUSTOMER') {
            throw new Error(`el alias ${cfg.alias} apunta a una clave gestionada por AWS, no a una CMK`);
        }
        plan.steps.push({
            step: 'cmk',
            status: 'ya-existe',
            detail: `${cfg.alias} · manager=${existing.KeyManager} · estado=${existing.KeyState}`,
        });
        return existing.Arn;
    }

    if (!cfg.apply) {
        plan.steps.push({ step: 'cmk', status: 'se-crearia', detail: `${cfg.alias} · SYMMETRIC_DEFAULT · rotación anual` });
        plan.steps.push({ step: 'alias', status: 'se-crearia', detail: cfg.alias });
        return null;
    }

    const tmp = writeTempJson(keyPolicy);
    let keyArn;
    try {
        const res = aws([
            'kms', 'create-key',
            '--description', 'CMK del store durable del kernel (Intrale pipeline) - #5126',
            '--key-usage', 'ENCRYPT_DECRYPT',
            '--key-spec', 'SYMMETRIC_DEFAULT',
            '--policy', `file://${tmp}`,
            '--tags', 'TagKey=proyecto,TagValue=intrale-pipeline', 'TagKey=issue,TagValue=5126',
            '--region', cfg.region, '--output', 'json',
        ], { profile: cfg.adminProfile });
        if (!res.ok || !res.json) {
            throw new Error(`create-key falló: ${firstLine(res.stderr)}`);
        }
        keyArn = res.json.KeyMetadata.Arn;
        plan.steps.push({ step: 'cmk', status: 'creada', detail: 'manager=CUSTOMER · SYMMETRIC_DEFAULT' });
    } finally {
        safeUnlink(tmp);
    }

    // Rotación anual (runbook §3, control no negociable).
    const rot = aws(['kms', 'enable-key-rotation', '--key-id', keyArn, '--region', cfg.region],
        { profile: cfg.adminProfile });
    plan.steps.push({ step: 'rotacion', status: rot.ok ? 'habilitada' : 'ERROR', detail: rot.ok ? 'anual' : firstLine(rot.stderr) });
    if (!rot.ok) throw new Error('no se pudo habilitar la rotación de la CMK');

    const al = aws(['kms', 'create-alias', '--alias-name', cfg.alias, '--target-key-id', keyArn,
        '--region', cfg.region], { profile: cfg.adminProfile });
    plan.steps.push({ step: 'alias', status: al.ok ? 'creado' : 'ERROR', detail: al.ok ? cfg.alias : firstLine(al.stderr) });
    if (!al.ok) throw new Error('no se pudo crear el alias de la CMK');

    return keyArn;
}

function currentSseKeyArn(cfg, table) {
    const res = aws(['dynamodb', 'describe-table', '--table-name', table, '--region', cfg.region, '--output', 'json'],
        { profile: cfg.adminProfile });
    const sse = res.json && res.json.Table && res.json.Table.SSEDescription;
    return sse && sse.KMSMasterKeyArn ? sse.KMSMasterKeyArn : null;
}

function stepTableSse(cfg, plan, table, keyArn) {
    const current = currentSseKeyArn(cfg, table);

    if (current && keyArn && current === keyArn) {
        plan.steps.push({ step: `sse:${table}`, status: 'ya-al-dia', detail: 'cifrada con la CMK del kernel' });
        return;
    }
    if (current) {
        plan.steps.push({
            step: `sse:${table}`,
            status: 'OTRA-CMK-no-se-toca',
            detail: 'la tabla ya usa una CMK distinta; se deja como está para no romper su cadena de claves',
        });
        return;
    }
    if (!cfg.apply) {
        plan.steps.push({ step: `sse:${table}`, status: 'se-cambiaria', detail: 'AWS-owned -> CMK del kernel' });
        return;
    }

    const res = aws([
        'dynamodb', 'update-table', '--table-name', table,
        '--sse-specification', `Enabled=true,SSEType=KMS,KMSMasterKeyId=${keyArn}`,
        '--region', cfg.region, '--output', 'json',
    ], { profile: cfg.adminProfile });
    if (!res.ok) throw new Error(`update-table SSE en ${table} falló: ${firstLine(res.stderr)}`);
    plan.steps.push({ step: `sse:${table}`, status: 'cambiada', detail: 'AWS-owned -> CMK (re-cifrado en background)' });
}

function stepKmsIamPolicy(cfg, plan, accountId, keyArn) {
    const arn = `arn:aws:iam::${accountId}:policy/${cfg.kmsPolicyName}`;
    const doc = buildKmsIamPolicy(cfg, keyArn);
    const got = aws(['iam', 'get-policy', '--policy-arn', arn, '--output', 'json'], { profile: cfg.adminProfile });

    if (!got.ok) {
        if (!cfg.apply) {
            plan.steps.push({ step: 'kms-iam-policy', status: 'se-crearia', detail: cfg.kmsPolicyName });
        } else {
            const tmp = writeTempJson(doc);
            try {
                const res = aws(['iam', 'create-policy', '--policy-name', cfg.kmsPolicyName,
                    '--policy-document', `file://${tmp}`, '--output', 'json'], { profile: cfg.adminProfile });
                if (!res.ok) throw new Error(`create-policy falló: ${firstLine(res.stderr)}`);
                plan.steps.push({ step: 'kms-iam-policy', status: 'creada', detail: cfg.kmsPolicyName });
            } finally { safeUnlink(tmp); }
        }
    } else {
        plan.steps.push({ step: 'kms-iam-policy', status: 'ya-existe', detail: cfg.kmsPolicyName });
    }

    const attached = aws(['iam', 'list-attached-user-policies', '--user-name', cfg.user, '--output', 'json'],
        { profile: cfg.adminProfile });
    const arns = (attached.json && attached.json.AttachedPolicies || []).map((p) => p.PolicyArn);
    if (arns.includes(arn)) {
        plan.steps.push({ step: 'kms-attach', status: 'ya-attachada' });
        return;
    }
    if (!cfg.apply) {
        plan.steps.push({ step: 'kms-attach', status: 'se-attacharia', detail: `a ${cfg.user}` });
        return;
    }
    const res = aws(['iam', 'attach-user-policy', '--user-name', cfg.user, '--policy-arn', arn],
        { profile: cfg.adminProfile });
    if (!res.ok) throw new Error(`attach-user-policy falló: ${firstLine(res.stderr)}`);
    plan.steps.push({ step: 'kms-attach', status: 'attachada', detail: `a ${cfg.user}` });
}

// -----------------------------------------------------------------------------
// Reparación del Deny catch-all de `IntraleKernelStore`
//
// La policy de runtime cierra con un Deny catch-all:
//
//   { Effect: Deny, NotAction: [sts:GetCallerIdentity], NotResource: [<2 tablas>] }
//
// Con cifrado AWS-owned eso era inocuo. Al pasar a CMK deja de serlo: el
// `kms:Decrypt` que DynamoDB necesita se evalúa contra el ARN de la CMK, que no
// es ninguna de las dos tablas ⇒ cae en el catch-all ⇒ **Deny explícito**, y un
// Deny explícito le gana a cualquier Allow, incluido el de `IntraleKernelKms`.
//
// Síntoma exacto:
//   AccessDeniedException: ... not authorized to perform: kms:Decrypt ...
//   with an explicit deny in an identity-based policy: .../IntraleKernelStore
//
// El arreglo es agregar el ARN de la CMK al `NotResource`. Es **aditivo**: acota
// el alcance del Deny, no amplía ningún Allow. El permiso efectivo sobre la CMK
// lo sigue dando `IntraleKernelKms`, restringido por `kms:ViaService`.
// -----------------------------------------------------------------------------

function stepFixDenyCatchAll(cfg, plan, accountId, keyArn) {
    const arn = `arn:aws:iam::${accountId}:policy/IntraleKernelStore`;
    const got = aws(['iam', 'get-policy', '--policy-arn', arn, '--output', 'json'], { profile: cfg.adminProfile });
    if (!got.ok) {
        plan.steps.push({ step: 'deny-catch-all', status: 'OMITIDO', detail: 'IntraleKernelStore no existe' });
        return;
    }
    const versionId = got.json.Policy.DefaultVersionId;
    const ver = aws(['iam', 'get-policy-version', '--policy-arn', arn, '--version-id', versionId, '--output', 'json'],
        { profile: cfg.adminProfile });
    const doc = ver.json && ver.json.PolicyVersion && ver.json.PolicyVersion.Document;
    if (!doc) {
        plan.steps.push({ step: 'deny-catch-all', status: 'ERROR', detail: 'no se pudo leer el documento vigente' });
        return;
    }

    const target = (doc.Statement || []).find((s) => s.Effect === 'Deny' && s.NotResource);
    if (!target) {
        plan.steps.push({ step: 'deny-catch-all', status: 'no-aplica', detail: 'la policy no tiene Deny con NotResource' });
        return;
    }

    const list = Array.isArray(target.NotResource) ? target.NotResource : [target.NotResource];
    if (list.includes(keyArn)) {
        plan.steps.push({ step: 'deny-catch-all', status: 'ya-al-dia', detail: 'la CMK ya está exceptuada del Deny' });
        return;
    }

    if (!cfg.apply) {
        plan.steps.push({
            step: 'deny-catch-all',
            status: 'se-corregiria',
            detail: 'agregar el ARN de la CMK al NotResource (sin esto el runtime no puede descifrar)',
        });
        return;
    }

    target.NotResource = [...list, keyArn];
    pruneOldPolicyVersions(cfg, arn);

    const tmp = writeTempJson(doc);
    try {
        const res = aws(['iam', 'create-policy-version', '--policy-arn', arn,
            '--policy-document', `file://${tmp}`, '--set-as-default', '--output', 'json'],
            { profile: cfg.adminProfile });
        if (!res.ok) throw new Error(`create-policy-version falló: ${firstLine(res.stderr)}`);
        plan.steps.push({ step: 'deny-catch-all', status: 'corregido', detail: 'CMK exceptuada del Deny catch-all' });
    } finally {
        safeUnlink(tmp);
    }
}

/** IAM admite 5 versiones por policy; libera lugar borrando la más vieja no-default. */
function pruneOldPolicyVersions(cfg, arn) {
    const list = aws(['iam', 'list-policy-versions', '--policy-arn', arn, '--output', 'json'],
        { profile: cfg.adminProfile });
    const versions = (list.json && list.json.Versions) || [];
    if (versions.length < 5) return;
    const oldest = versions
        .filter((v) => !v.IsDefaultVersion)
        .sort((a, b) => String(a.CreateDate).localeCompare(String(b.CreateDate)))[0];
    if (!oldest) return;
    aws(['iam', 'delete-policy-version', '--policy-arn', arn, '--version-id', oldest.VersionId],
        { profile: cfg.adminProfile });
}

// -----------------------------------------------------------------------------
// Utilidades
// -----------------------------------------------------------------------------

function firstLine(s) {
    return String(s || '').trim().split('\n')[0];
}

function writeTempJson(doc) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-cmk-'));
    const p = path.join(dir, 'policy.json');
    fs.writeFileSync(p, `${JSON.stringify(doc, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return p;
}

function safeUnlink(p) {
    try { fs.unlinkSync(p); fs.rmdirSync(path.dirname(p)); } catch (_) { /* best-effort */ }
}

// -----------------------------------------------------------------------------
// Orquestador
// -----------------------------------------------------------------------------

function provisionCmk(cfg) {
    assertGuards(cfg);
    const plan = { mode: cfg.apply ? 'APPLY' : 'DRY-RUN', steps: [] };

    try {
        const accountId = stepIdentity(cfg, plan);
        const keyPolicy = buildKeyPolicy(cfg, accountId);
        const keyArn = stepCmk(cfg, plan, accountId, keyPolicy);

        stepTableSse(cfg, plan, cfg.table, keyArn);
        stepTableSse(cfg, plan, cfg.coordinationTable, keyArn);

        if (keyArn) {
            stepKmsIamPolicy(cfg, plan, accountId, keyArn);
            // Sin esta corrección el Allow de arriba es inútil: el Deny catch-all
            // de IntraleKernelStore le gana y el runtime no puede descifrar.
            stepFixDenyCatchAll(cfg, plan, accountId, keyArn);
        } else {
            plan.steps.push({
                step: 'kms-iam-policy',
                status: 'se-crearia',
                detail: 'requiere el ARN de la CMK, que existe recién tras --apply',
            });
        }
    } catch (e) {
        e.plan = plan;
        throw e;
    }

    return plan;
}

module.exports = {
    provisionCmk,
    parseArgs,
    assertGuards,
    buildKeyPolicy,
    buildKmsIamPolicy,
    assertNoWildcardPrincipal,
    DEFAULTS,
};

if (require.main === module) {
    let cfg;
    try {
        cfg = parseArgs(process.argv.slice(2));
    } catch (e) {
        process.stderr.write(`kernel-cmk-provision: ${e.message}\n`);
        process.exit(2);
    }

    try {
        const plan = provisionCmk(cfg);
        const out = [''];
        out.push(`===== CMK DEL STORE DURABLE [${plan.mode}] =====`);
        out.push(`región : ${cfg.region}`);
        out.push(`alias  : ${cfg.alias}`);
        out.push(`tablas : ${cfg.table}, ${cfg.coordinationTable}`);
        out.push(`runtime: ${cfg.user}`);
        out.push('');
        for (const s of plan.steps) {
            out.push(`  [${s.status}] ${s.step}${s.detail ? ` — ${s.detail}` : ''}`);
        }
        out.push('');
        out.push(cfg.apply
            ? 'Listo. El re-cifrado de las tablas corre en background; describe-table lo refleja al terminar.'
            : 'Nada fue modificado. Para ejecutar: agregá --apply');
        out.push('');
        process.stdout.write(`${out.join('\n')}\n`);
        process.exit(0);
    } catch (e) {
        const done = (e.plan && e.plan.steps) || [];
        const out = [''];
        if (done.length) {
            out.push('Verificado antes de frenar:');
            for (const s of done) out.push(`  [${s.status}] ${s.step}${s.detail ? ` — ${s.detail}` : ''}`);
            out.push('');
        }
        out.push(`kernel-cmk-provision ABORTADO: ${e.message}`);
        out.push('');
        process.stderr.write(`${out.join('\n')}\n`);
        process.exit(1);
    }
}

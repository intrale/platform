'use strict';

// =============================================================================
// kernel-aws-bootstrap.js — Bootstrap ADMIN de un solo paso para el store
// durable del kernel (#5126 · CA-0 / CA-B1 / CA-B2)
//
// QUÉ HACE
// --------
// Deja el entorno AWS listo para el cutover, en una sola corrida idempotente:
//
//   1. Verifica la identidad admin y deriva el account-id (NUNCA hardcodeado).
//   2. Renderiza la policy de runtime desde `docs/pipeline/kernel-iam-policy.json`
//      (fuente de verdad testeada) resolviendo REGION/ACCOUNT/TABLE/COORD_TABLE.
//   3. Provisiona las DOS tablas (no-repudio + coordinación) con deletion
//      protection, y PITR sobre la de no-repudio.
//   4. Crea/actualiza el usuario IAM de runtime y le engancha la policy.
//   5. Genera la access key y la persiste sola: scope `aws` de
//      `~/.claude/secrets/credentials.json` + profile en `~/.aws/credentials`.
//      **El secreto nunca se imprime ni se loguea.**
//
// POR QUÉ EXISTE
// --------------
// `kernel-provision.js` (#4820) cubre el paso 3 para UNA tabla, asumiendo que
// ya hay credenciales de runtime en el ambiente. Los pasos 1, 2, 4 y 5 quedaban
// como trabajo manual del operador: crear el usuario a mano, copiar la key de la
// salida del CLI y pegarla en un archivo. Eso es exactamente donde se cuelan los
// errores y donde una key termina en un historial de terminal.
//
// SEGURIDAD — NO PISAR NADA EN USO (invariantes, todas fail-closed)
// -----------------------------------------------------------------
//   G1. Prefijo de tabla obligatorio (`intrale-kernel-`). Un nombre fuera del
//       prefijo aborta ANTES de tocar AWS. Contiene el radio de daño de un
//       nombre mal tipeado que apunte a una tabla de negocio.
//   G2. Tabla preexistente => NO se le escribe NADA. Sin round-trip, sin
//       put/delete de sondeo. Se verifica el key-schema y se sigue. (#5010)
//   G3. Nunca `DeleteTable`, nunca `DeleteItem`, nunca `PutItem` de datos.
//   G4. El usuario IAM debe matchear `intrale-kernel-*`. `claude-code` y
//       cualquier principal de producción están en lista negra explícita.
//   G5. Antes de cambiar la policy se listan sus entidades attachadas. Si toca
//       algún principal distinto del esperado, aborta sin modificar.
//   G6. `~/.aws/credentials` se modifica SOLO por append de un profile nuevo.
//       Jamás se reescribe el archivo (el profile `intrale` que usan el QA
//       remoto y el deploy de Lambda queda intacto). Profile ya existente =>
//       no se pisa sin `--force-profile`.
//   G7. `credentials.json` se escribe de forma atómica (tmp + rename) con
//       backup previo y re-parseo de validación. Las claves existentes
//       (`telegram`, `providers`, `multimedia`) se preservan tal cual.
//   G8. Dry-run por defecto: sin `--apply` no se ejecuta ninguna mutación.
//   G9. El secreto nunca se escribe a stdout/stderr ni a logs.
//
// USO
// ---
//   node .pipeline/lib/kernel-aws-bootstrap.js                 # plan (dry-run)
//   node .pipeline/lib/kernel-aws-bootstrap.js --apply         # ejecuta
//
// Flags: --region --table --coordination-table --user --policy-name
//        --admin-profile --rotate-key --force-profile
// =============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// -----------------------------------------------------------------------------
// Guardas de seguridad (G1 / G4) — constantes, no configurables por flag.
// -----------------------------------------------------------------------------

const TABLE_PREFIX = 'intrale-kernel-';
const USER_PREFIX = 'intrale-kernel-';

// Principals que este script NUNCA debe tocar, pase lo que pase.
const FORBIDDEN_PRINCIPALS = Object.freeze(['claude-code', 'root', 'admin']);

const DEFAULTS = Object.freeze({
    region: 'us-east-2',
    table: 'intrale-kernel-state',
    coordinationTable: 'intrale-kernel-coordination',
    user: 'intrale-kernel-runtime',
    policyName: 'IntraleKernelStore',
    profile: 'kernel-runtime',
    // Alias de la CMK del store (la crea kernel-cmk-provision.js · runbook §3).
    cmkAlias: 'alias/intrale-kernel-store',
});

const CRED_PATH = path.join(os.homedir(), '.claude', 'secrets', 'credentials.json');
const AWS_CRED_PATH = path.join(os.homedir(), '.aws', 'credentials');
const POLICY_TEMPLATE = path.join(__dirname, '..', '..', 'docs', 'pipeline', 'kernel-iam-policy.json');

// -----------------------------------------------------------------------------
// Runner del AWS CLI
// -----------------------------------------------------------------------------

const AWS_CANDIDATES = [
    'C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe',
    '/c/Program Files/Amazon/AWSCLIV2/aws.exe',
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

/**
 * Ejecuta el AWS CLI. Devuelve `{ ok, json, stdout, stderr, code }`.
 * NUNCA lanza por error del CLI — el llamador decide. Tampoco loguea el stdout
 * crudo (puede contener material sensible: G9).
 */
function aws(args, opts = {}) {
    const profile = opts.profile;
    const full = profile ? [...args, '--profile', profile] : [...args];
    const res = spawnSync(AWS_BIN, full, {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
    });
    const stdout = res.stdout || '';
    const stderr = res.stderr || '';
    const ok = res.status === 0;
    let json = null;
    if (ok && stdout.trim().startsWith('{')) {
        try { json = JSON.parse(stdout); } catch (_) { json = null; }
    }
    return { ok, json, stdout, stderr, code: res.status };
}

// -----------------------------------------------------------------------------
// Parseo de argumentos
// -----------------------------------------------------------------------------

function parseArgs(argv) {
    const out = {
        apply: false,
        rotateKey: false,
        forceProfile: false,
        updatePolicy: false,
        region: DEFAULTS.region,
        table: DEFAULTS.table,
        coordinationTable: DEFAULTS.coordinationTable,
        user: DEFAULTS.user,
        policyName: DEFAULTS.policyName,
        profile: DEFAULTS.profile,
        cmkAlias: DEFAULTS.cmkAlias,
        adminProfile: process.env.AWS_PROFILE || 'intrale',
    };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        const next = () => argv[++i];
        switch (a) {
            case '--apply': out.apply = true; break;
            case '--rotate-key': out.rotateKey = true; break;
            case '--force-profile': out.forceProfile = true; break;
            case '--update-policy': out.updatePolicy = true; break;
            case '--region': out.region = next(); break;
            case '--table': out.table = next(); break;
            case '--coordination-table': out.coordinationTable = next(); break;
            case '--user': out.user = next(); break;
            case '--policy-name': out.policyName = next(); break;
            case '--admin-profile': out.adminProfile = next(); break;
            case '--profile': out.profile = next(); break;
            default:
                if (a.startsWith('--')) throw new Error(`flag desconocido: ${a}`);
        }
    }
    return out;
}

// -----------------------------------------------------------------------------
// Validación de guardas ANTES de tocar AWS (G1 / G4) — fail-closed.
// -----------------------------------------------------------------------------

function assertGuards(cfg) {
    for (const t of [cfg.table, cfg.coordinationTable]) {
        if (!t || !t.startsWith(TABLE_PREFIX)) {
            throw new Error(
                `G1: nombre de tabla "${t}" fuera del prefijo obligatorio "${TABLE_PREFIX}". ` +
                'Abortado antes de tocar AWS para no operar sobre una tabla de negocio.');
        }
    }
    if (cfg.table === cfg.coordinationTable) {
        throw new Error('G1: la tabla de no-repudio y la de coordinación no pueden ser la misma.');
    }
    if (!cfg.user || !cfg.user.startsWith(USER_PREFIX)) {
        throw new Error(
            `G4: usuario IAM "${cfg.user}" fuera del prefijo obligatorio "${USER_PREFIX}".`);
    }
    if (FORBIDDEN_PRINCIPALS.includes(cfg.user)) {
        throw new Error(`G4: "${cfg.user}" está en la lista negra de principals; este script no lo toca.`);
    }
}

// -----------------------------------------------------------------------------
// Render de la policy desde la plantilla testeada de docs/
// -----------------------------------------------------------------------------

/**
 * Resuelve el ARN de la CMK del store si existe (alias creado por
 * kernel-cmk-provision.js). Devuelve null si todavía no hay CMK.
 *
 * Hace falta porque el Deny catch-all de abajo se arma con `NotResource`: si el
 * ARN de la CMK no está en esa lista, el `kms:Decrypt` que DynamoDB necesita cae
 * en el Deny y el runtime **pierde acceso a la tabla**. Regenerar la policy sin
 * consultar la CMK es la forma más fácil de romper el store con un comando que
 * parece inocuo.
 */
function resolveCmkArn(cfg) {
    const res = aws(['kms', 'describe-key', '--key-id', cfg.cmkAlias,
        '--region', cfg.region, '--output', 'json'], { profile: cfg.adminProfile });
    const md = res.json && res.json.KeyMetadata;
    if (!md || md.KeyManager !== 'CUSTOMER') return null;
    return md.Arn;
}

function renderPolicy(cfg, accountId, cmkArn) {
    const raw = fs.readFileSync(POLICY_TEMPLATE, 'utf8');
    const rendered = raw
        .replace(/REGION/g, cfg.region)
        .replace(/ACCOUNT/g, accountId)
        .replace(/table\/COORD_TABLE/g, `table/${cfg.coordinationTable}`)
        .replace(/table\/TABLE/g, `table/${cfg.table}`);

    const doc = JSON.parse(rendered);

    // Chequeo de que no quedó ningún placeholder sin resolver.
    const asText = JSON.stringify(doc);
    for (const ph of ['REGION', 'ACCOUNT', 'COORD_TABLE', 'table/TABLE']) {
        if (asText.includes(ph)) {
            throw new Error(`placeholder "${ph}" sin resolver en la policy renderizada`);
        }
    }

    // Statements operativos que la plantilla de docs no incluye (es la policy de
    // datos). Se agregan acá, explícitos y auditables:
    //   - el runtime necesita poder verificar su propia identidad;
    //   - Deny catch-all fuera de las dos tablas del kernel: convierte el
    //     deny-by-default (implícito) en un Deny explícito, que sobrevive a que
    //     alguien enganche otra policy con Allow al mismo usuario.
    const stateArn = `arn:aws:dynamodb:${cfg.region}:${accountId}:table/${cfg.table}`;
    const coordArn = `arn:aws:dynamodb:${cfg.region}:${accountId}:table/${cfg.coordinationTable}`;

    doc.Statement.push({
        Sid: 'AllowIdentityCheck',
        Effect: 'Allow',
        Action: ['sts:GetCallerIdentity'],
        Resource: '*',
    });
    // El ARN de la CMK va exceptuado del Deny. Sin esto, el `kms:Decrypt` que
    // DynamoDB hace en nombre del runtime cae en el catch-all y la tabla queda
    // inaccesible (con `SSEType: KMS` y una CMK propia, leer o escribir un ítem
    // implica una llamada a KMS).
    const notResource = [stateArn, coordArn];
    if (cmkArn) notResource.push(cmkArn);

    doc.Statement.push({
        Sid: 'DenyEverythingOutsideKernelTables',
        Effect: 'Deny',
        NotAction: ['sts:GetCallerIdentity'],
        NotResource: notResource,
    });

    return doc;
}

// -----------------------------------------------------------------------------
// Paso 1 — identidad admin
// -----------------------------------------------------------------------------

function stepIdentity(cfg, plan) {
    const res = aws(['sts', 'get-caller-identity', '--output', 'json'], { profile: cfg.adminProfile });
    if (!res.ok || !res.json) {
        throw new Error(
            `no se pudo verificar la identidad admin con el profile "${cfg.adminProfile}". ` +
            `Detalle: ${(res.stderr || '').trim().split('\n')[0]}`);
    }
    const { Account, Arn } = res.json;
    plan.accountId = Account;
    plan.adminArn = Arn;
    plan.steps.push({ step: 'identity', status: 'ok', detail: redactArn(Arn) });
    return Account;
}

function redactArn(arn) {
    return String(arn || '').replace(/\d{12}/g, '<ACCOUNT>');
}

/**
 * Distingue "no tengo permiso" de "no existe". Sin esto, un AccessDenied en
 * `get-policy` se leería como "la policy no existe" y el script intentaría
 * crearla — confundiendo un problema de permisos con un problema de estado.
 */
function isAccessDenied(res) {
    return /AccessDenied|not authorized|ExplicitDeny/i.test(res && res.stderr || '');
}

function assertNotDenied(res, cfg, what) {
    if (res.ok || !isAccessDenied(res)) return;
    throw new Error(
        `el profile admin "${cfg.adminProfile}" no tiene permisos IAM para ${what}. ` +
        'Este script necesita un principal con gestión IAM: correlo con --admin-profile <tu-profile-admin>. ' +
        'El usuario claude-code NO sirve (no tiene permisos IAM, ni para leer los propios).');
}

// -----------------------------------------------------------------------------
// Paso 2 — tablas (G2 / G3)
// -----------------------------------------------------------------------------

function describeTable(cfg, name) {
    const res = aws(
        ['dynamodb', 'describe-table', '--table-name', name, '--region', cfg.region, '--output', 'json'],
        { profile: cfg.adminProfile });
    if (res.ok && res.json && res.json.Table) return res.json.Table;
    return null;
}

/** Sleep síncrono sin dependencias ni proceso hijo. */
function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitTableActive(cfg, name, maxWaitMs = 120000) {
    const started = Date.now();
    for (;;) {
        const t = describeTable(cfg, name);
        if (t && t.TableStatus === 'ACTIVE') return t;
        if (Date.now() - started > maxWaitMs) {
            throw new Error(`la tabla ${name} no llegó a ACTIVE en ${maxWaitMs / 1000}s`);
        }
        sleepSync(3000);
    }
}

function stepTable(cfg, plan, name, { pitr }) {
    const existing = describeTable(cfg, name);

    if (existing) {
        // G2 — tabla preexistente: se INSPECCIONA, no se escribe nada.
        const keys = (existing.KeySchema || []).map((k) => `${k.AttributeName}:${k.KeyType}`).join(',');
        const expected = 'PK:HASH,SK:RANGE';
        const schemaOk = keys === expected;
        plan.steps.push({
            step: `table:${name}`,
            status: schemaOk ? 'ya-existe' : 'ya-existe-SCHEMA-DISTINTO',
            detail: schemaOk
                ? 'preexistente con el key-schema esperado; no se escribe nada (G2)'
                : `key-schema "${keys}" != esperado "${expected}" — revisar a mano antes de seguir`,
            deletionProtection: !!existing.DeletionProtectionEnabled,
        });
        if (!schemaOk) {
            throw new Error(
                `G2: la tabla ${name} ya existe con un key-schema distinto del esperado. ` +
                'Abortado sin escribir nada.');
        }
        return existing;
    }

    if (!cfg.apply) {
        plan.steps.push({ step: `table:${name}`, status: 'se-crearia', detail: 'PK/SK, PAY_PER_REQUEST, deletion protection ON' });
        return null;
    }

    const res = aws([
        'dynamodb', 'create-table',
        '--table-name', name,
        '--attribute-definitions', 'AttributeName=PK,AttributeType=S', 'AttributeName=SK,AttributeType=S',
        '--key-schema', 'AttributeName=PK,KeyType=HASH', 'AttributeName=SK,KeyType=RANGE',
        '--billing-mode', 'PAY_PER_REQUEST',
        '--deletion-protection-enabled',
        '--region', cfg.region,
        '--output', 'json',
    ], { profile: cfg.adminProfile });

    if (!res.ok) {
        throw new Error(`create-table ${name} falló: ${(res.stderr || '').trim().split('\n')[0]}`);
    }
    waitTableActive(cfg, name);
    plan.steps.push({ step: `table:${name}`, status: 'creada', detail: 'ACTIVE, deletion protection ON' });

    if (pitr) stepPitr(cfg, plan, name);
    return describeTable(cfg, name);
}

function stepPitr(cfg, plan, name) {
    const cur = aws(
        ['dynamodb', 'describe-continuous-backups', '--table-name', name, '--region', cfg.region, '--output', 'json'],
        { profile: cfg.adminProfile });
    const status = cur.json
        && cur.json.ContinuousBackupsDescription
        && cur.json.ContinuousBackupsDescription.PointInTimeRecoveryDescription
        && cur.json.ContinuousBackupsDescription.PointInTimeRecoveryDescription.PointInTimeRecoveryStatus;

    if (status === 'ENABLED') {
        plan.steps.push({ step: `pitr:${name}`, status: 'ya-habilitado' });
        return;
    }
    if (!cfg.apply) {
        plan.steps.push({ step: `pitr:${name}`, status: 'se-habilitaria' });
        return;
    }
    const res = aws([
        'dynamodb', 'update-continuous-backups',
        '--table-name', name,
        '--point-in-time-recovery-specification', 'PointInTimeRecoveryEnabled=true',
        '--region', cfg.region, '--output', 'json',
    ], { profile: cfg.adminProfile });
    plan.steps.push({
        step: `pitr:${name}`,
        status: res.ok ? 'habilitado' : 'ERROR',
        detail: res.ok ? undefined : (res.stderr || '').trim().split('\n')[0],
    });
    if (!res.ok) throw new Error(`no se pudo habilitar PITR en ${name}`);
}

// -----------------------------------------------------------------------------
// Paso 3 — policy IAM (G5)
// -----------------------------------------------------------------------------

function stepPolicy(cfg, plan, accountId, policyDoc) {
    const arn = `arn:aws:iam::${accountId}:policy/${cfg.policyName}`;
    const got = aws(['iam', 'get-policy', '--policy-arn', arn, '--output', 'json'], { profile: cfg.adminProfile });
    assertNotDenied(got, cfg, `leer la policy ${cfg.policyName}`);

    if (!got.ok) {
        if (!cfg.apply) {
            plan.steps.push({ step: 'policy', status: 'se-crearia', detail: cfg.policyName });
            return arn;
        }
        const tmp = writeTempJson(policyDoc);
        try {
            const res = aws([
                'iam', 'create-policy',
                '--policy-name', cfg.policyName,
                '--policy-document', `file://${tmp}`,
                '--output', 'json',
            ], { profile: cfg.adminProfile });
            if (!res.ok) throw new Error(`create-policy falló: ${(res.stderr || '').trim().split('\n')[0]}`);
            plan.steps.push({ step: 'policy', status: 'creada', detail: cfg.policyName });
        } finally {
            safeUnlink(tmp);
        }
        return arn;
    }

    // G5 — la policy ya existe: ver a quién afecta antes de cambiarla.
    const ents = aws(['iam', 'list-entities-for-policy', '--policy-arn', arn, '--output', 'json'],
        { profile: cfg.adminProfile });
    const users = (ents.json && ents.json.PolicyUsers || []).map((u) => u.UserName);
    const roles = (ents.json && ents.json.PolicyRoles || []).map((r) => r.RoleName);
    const groups = (ents.json && ents.json.PolicyGroups || []).map((g) => g.GroupName);

    const unexpected = [...users.filter((u) => u !== cfg.user), ...roles, ...groups];
    if (unexpected.length > 0) {
        throw new Error(
            `G5: la policy ${cfg.policyName} está attachada a entidades inesperadas [${unexpected.join(', ')}]. ` +
            'Abortado sin modificarla para no afectar algo en uso.');
    }

    // Si el documento vigente ya es idéntico al renderizado, no se crea versión
    // nueva: IAM admite sólo 5 por policy y una v3 igual a la v2 es basura que
    // después obliga a podar. Idempotencia real, no "vuelve a aplicar lo mismo".
    if (samePolicyDocument(cfg, arn, got.json, policyDoc)) {
        plan.steps.push({
            step: 'policy',
            status: 'ya-al-dia',
            detail: `documento idéntico al vigente; attachada a: [${users.join(', ') || 'nadie'}]`,
        });
        return arn;
    }

    // Difiere del documento renderizado. NO se pisa por default: la policy
    // vigente puede haber sido ajustada a mano por una razón que el repo no
    // conoce, y está attachada a un principal en uso. Actualizarla es opt-in.
    if (!cfg.updatePolicy) {
        plan.steps.push({
            step: 'policy',
            status: 'DIFIERE-no-se-toca',
            detail: 'el documento vigente no coincide con docs/pipeline/kernel-iam-policy.json. ' +
                'Se deja como está; usar --update-policy para sobrescribirlo.',
        });
        return arn;
    }

    if (!cfg.apply) {
        plan.steps.push({
            step: 'policy',
            status: 'se-actualizaria',
            detail: `nueva versión default; attachada hoy a: [${users.join(', ') || 'nadie'}]`,
        });
        return arn;
    }

    pruneOldPolicyVersions(cfg, arn);

    const tmp = writeTempJson(policyDoc);
    try {
        const res = aws([
            'iam', 'create-policy-version',
            '--policy-arn', arn,
            '--policy-document', `file://${tmp}`,
            '--set-as-default',
            '--output', 'json',
        ], { profile: cfg.adminProfile });
        if (!res.ok) throw new Error(`create-policy-version falló: ${(res.stderr || '').trim().split('\n')[0]}`);
        plan.steps.push({ step: 'policy', status: 'actualizada', detail: 'nueva versión default' });
    } finally {
        safeUnlink(tmp);
    }
    return arn;
}

/** Normaliza un documento de policy para compararlo sin ruido de orden/formato. */
function canonicalizePolicy(doc) {
    const sortDeep = (v) => {
        if (Array.isArray(v)) return v.map(sortDeep).slice().sort((a, b) =>
            JSON.stringify(a).localeCompare(JSON.stringify(b)));
        if (v && typeof v === 'object') {
            return Object.keys(v).sort().reduce((acc, k) => { acc[k] = sortDeep(v[k]); return acc; }, {});
        }
        return v;
    };
    return JSON.stringify(sortDeep(doc));
}

function samePolicyDocument(cfg, arn, getPolicyJson, rendered) {
    const versionId = getPolicyJson && getPolicyJson.Policy && getPolicyJson.Policy.DefaultVersionId;
    if (!versionId) return false;
    const res = aws(['iam', 'get-policy-version', '--policy-arn', arn,
        '--version-id', versionId, '--output', 'json'], { profile: cfg.adminProfile });
    const current = res.json && res.json.PolicyVersion && res.json.PolicyVersion.Document;
    if (!current) return false;
    return canonicalizePolicy(current) === canonicalizePolicy(rendered);
}

// IAM admite 5 versiones por policy. Si está lleno, borra la más vieja no-default.
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
// Paso 4 — usuario IAM
// -----------------------------------------------------------------------------

function stepUser(cfg, plan, policyArn) {
    const got = aws(['iam', 'get-user', '--user-name', cfg.user, '--output', 'json'],
        { profile: cfg.adminProfile });
    assertNotDenied(got, cfg, `leer el usuario ${cfg.user}`);

    if (!got.ok) {
        if (!cfg.apply) {
            plan.steps.push({ step: 'user', status: 'se-crearia', detail: cfg.user });
        } else {
            const res = aws(['iam', 'create-user', '--user-name', cfg.user, '--output', 'json'],
                { profile: cfg.adminProfile });
            if (!res.ok) throw new Error(`create-user falló: ${(res.stderr || '').trim().split('\n')[0]}`);
            plan.steps.push({ step: 'user', status: 'creado', detail: cfg.user });
        }
    } else {
        plan.steps.push({ step: 'user', status: 'ya-existe', detail: cfg.user });
    }

    // attach es idempotente en IAM, pero igual se consulta para reportar bien.
    const attached = aws(['iam', 'list-attached-user-policies', '--user-name', cfg.user, '--output', 'json'],
        { profile: cfg.adminProfile });
    const arns = (attached.json && attached.json.AttachedPolicies || []).map((p) => p.PolicyArn);

    if (arns.includes(policyArn)) {
        plan.steps.push({ step: 'attach', status: 'ya-attachada' });
        return;
    }
    if (!cfg.apply) {
        plan.steps.push({ step: 'attach', status: 'se-attacharia' });
        return;
    }
    const res = aws(['iam', 'attach-user-policy', '--user-name', cfg.user, '--policy-arn', policyArn],
        { profile: cfg.adminProfile });
    if (!res.ok) throw new Error(`attach-user-policy falló: ${(res.stderr || '').trim().split('\n')[0]}`);
    plan.steps.push({ step: 'attach', status: 'attachada' });
}

// -----------------------------------------------------------------------------
// Paso 5 — access key + persistencia (G6 / G7 / G9)
// -----------------------------------------------------------------------------

function currentCredsHaveAws() {
    try {
        const j = JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'));
        return !!(j && j.aws && j.aws.access_key_id && j.aws.secret_access_key);
    } catch (_) {
        return false;
    }
}

function stepAccessKey(cfg, plan) {
    const list = aws(['iam', 'list-access-keys', '--user-name', cfg.user, '--output', 'json'],
        { profile: cfg.adminProfile });
    assertNotDenied(list, cfg, `listar las access keys de ${cfg.user}`);
    const keys = (list.json && list.json.AccessKeyMetadata) || [];
    const active = keys.filter((k) => k.Status === 'Active');
    const alreadyWired = currentCredsHaveAws();

    if (alreadyWired && !cfg.rotateKey) {
        plan.steps.push({
            step: 'access-key',
            status: 'ya-cableada',
            detail: 'credentials.json ya tiene el scope aws; usar --rotate-key para rotarla',
        });
        return null;
    }

    if (active.length > 0 && !cfg.rotateKey) {
        plan.steps.push({
            step: 'access-key',
            status: 'BLOQUEADO',
            detail: `el usuario ya tiene ${active.length} key(s) activa(s) y el secreto no es recuperable de AWS. ` +
                'Correr con --rotate-key para generar una nueva y desactivar las viejas.',
        });
        return null;
    }

    if (!cfg.apply) {
        plan.steps.push({
            step: 'access-key',
            status: 'se-generaria',
            detail: active.length > 0
                ? `nueva key + desactivación de ${active.length} vieja(s)`
                : 'nueva key',
        });
        return null;
    }

    const res = aws(['iam', 'create-access-key', '--user-name', cfg.user, '--output', 'json'],
        { profile: cfg.adminProfile });
    if (!res.ok || !res.json || !res.json.AccessKey) {
        throw new Error(`create-access-key falló: ${(res.stderr || '').trim().split('\n')[0]}`);
    }

    // A partir de acá hay material sensible en memoria. No se imprime jamás (G9).
    const { AccessKeyId, SecretAccessKey } = res.json.AccessKey;

    persistToCredentialsJson(cfg, AccessKeyId, SecretAccessKey);
    persistToAwsProfile(cfg, plan, AccessKeyId, SecretAccessKey);

    plan.steps.push({ step: 'access-key', status: 'generada-y-guardada', detail: maskKeyId(AccessKeyId) });

    // Recién con la nueva ya persistida se desactivan las viejas.
    for (const k of active) {
        const r = aws(['iam', 'update-access-key', '--user-name', cfg.user,
            '--access-key-id', k.AccessKeyId, '--status', 'Inactive'], { profile: cfg.adminProfile });
        plan.steps.push({
            step: 'access-key:rotacion',
            status: r.ok ? 'vieja-desactivada' : 'ERROR',
            detail: maskKeyId(k.AccessKeyId),
        });
    }

    return AccessKeyId;
}

function maskKeyId(id) {
    const s = String(id || '');
    return s.length > 8 ? `${s.slice(0, 4)}…${s.slice(-4)}` : '<key>';
}

/** G7 — escritura atómica con backup y validación. Preserva el resto del JSON. */
function persistToCredentialsJson(cfg, accessKeyId, secret) {
    if (!fs.existsSync(CRED_PATH)) {
        throw new Error(`no existe ${CRED_PATH}; no se crea de cero para no romper el boot del Pulpo`);
    }

    const original = fs.readFileSync(CRED_PATH, 'utf8');
    let data;
    try {
        data = JSON.parse(original);
    } catch (e) {
        throw new Error(`${CRED_PATH} no es JSON válido; abortado sin tocarlo (${e.message})`);
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${CRED_PATH}.bak-${stamp}`;
    fs.copyFileSync(CRED_PATH, backup);

    // Sólo se agrega/reemplaza la clave `aws`. El resto queda intacto.
    data.aws = {
        access_key_id: accessKeyId,
        secret_access_key: secret,
        region: cfg.region,
        profile: cfg.profile,
        table_name: cfg.table,
        coordination_table_name: cfg.coordinationTable,
        _principal: cfg.user,
        _note: 'Runtime del store durable del kernel (#5126). Sin CreateTable ni IAM.',
    };

    const serialized = `${JSON.stringify(data, null, 2)}\n`;

    // Validación antes de reemplazar: si esto no parsea, no se toca el original.
    JSON.parse(serialized);

    const tmp = `${CRED_PATH}.tmp-${stamp}`;
    fs.writeFileSync(tmp, serialized, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, CRED_PATH);

    return backup;
}

/** G6 — append-only. Nunca reescribe el archivo ni toca otros profiles. */
function persistToAwsProfile(cfg, plan, accessKeyId, secret) {
    const dir = path.dirname(AWS_CRED_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const existing = fs.existsSync(AWS_CRED_PATH) ? fs.readFileSync(AWS_CRED_PATH, 'utf8') : '';
    const header = `[${cfg.profile}]`;
    const hasProfile = new RegExp(`^\\s*\\[${cfg.profile}\\]\\s*$`, 'm').test(existing);

    if (hasProfile && !cfg.forceProfile) {
        plan.steps.push({
            step: 'aws-profile',
            status: 'OMITIDO',
            detail: `el profile [${cfg.profile}] ya existe en ~/.aws/credentials; no se pisa (G6). ` +
                'La key nueva sí quedó en credentials.json. Usar --force-profile para reemplazarlo.',
        });
        return;
    }

    if (hasProfile && cfg.forceProfile) {
        const backup = `${AWS_CRED_PATH}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        fs.copyFileSync(AWS_CRED_PATH, backup);
        // Reemplazo acotado: sólo el bloque de ESE profile, hasta el próximo header.
        const re = new RegExp(`(^|\\n)\\[${cfg.profile}\\][^\\[]*`, 'm');
        const replaced = existing.replace(re, `$1${header}\naws_access_key_id = ${accessKeyId}\n` +
            `aws_secret_access_key = ${secret}\nregion = ${cfg.region}\n`);
        fs.writeFileSync(AWS_CRED_PATH, replaced, { encoding: 'utf8', mode: 0o600 });
        plan.steps.push({ step: 'aws-profile', status: 'reemplazado', detail: `[${cfg.profile}] (backup tomado)` });
        return;
    }

    const block = `${existing.endsWith('\n') || existing === '' ? '' : '\n'}\n${header}\n` +
        `aws_access_key_id = ${accessKeyId}\n` +
        `aws_secret_access_key = ${secret}\n` +
        `region = ${cfg.region}\n`;
    fs.appendFileSync(AWS_CRED_PATH, block, { encoding: 'utf8' });
    plan.steps.push({ step: 'aws-profile', status: 'agregado', detail: `[${cfg.profile}] (append, sin tocar otros profiles)` });
}

// -----------------------------------------------------------------------------
// Utilidades de archivo temporal para los documentos de policy
// -----------------------------------------------------------------------------

function writeTempJson(doc) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-iam-'));
    const p = path.join(dir, 'policy.json');
    fs.writeFileSync(p, `${JSON.stringify(doc, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return p;
}

function safeUnlink(p) {
    try {
        fs.unlinkSync(p);
        fs.rmdirSync(path.dirname(p));
    } catch (_) { /* best-effort */ }
}

// -----------------------------------------------------------------------------
// Orquestador
// -----------------------------------------------------------------------------

function bootstrap(cfg) {
    assertGuards(cfg);

    const plan = { mode: cfg.apply ? 'APPLY' : 'DRY-RUN', steps: [] };

    // Si un paso aborta, el error se lleva el plan parcial: lo ya verificado es
    // justamente el diagnóstico que sirve para entender por qué frenó.
    try {
        const accountId = stepIdentity(cfg, plan);
        const cmkArn = resolveCmkArn(cfg);
        plan.steps.push({
            step: 'cmk',
            status: cmkArn ? 'detectada' : 'no-hay',
            detail: cmkArn
                ? `${cfg.cmkAlias} — se exceptúa del Deny catch-all`
                : `${cfg.cmkAlias} inexistente; correr kernel-cmk-provision.js (runbook §3)`,
        });
        const policyDoc = renderPolicy(cfg, accountId, cmkArn);

        stepTable(cfg, plan, cfg.table, { pitr: true });
        stepTable(cfg, plan, cfg.coordinationTable, { pitr: false });

        const policyArn = stepPolicy(cfg, plan, accountId, policyDoc);
        stepUser(cfg, plan, policyArn);
        stepAccessKey(cfg, plan);
    } catch (e) {
        e.plan = plan;
        throw e;
    }

    return plan;
}

module.exports = {
    bootstrap,
    parseArgs,
    assertGuards,
    renderPolicy,
    TABLE_PREFIX,
    USER_PREFIX,
    FORBIDDEN_PRINCIPALS,
    DEFAULTS,
};

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

if (require.main === module) {
    let cfg;
    try {
        cfg = parseArgs(process.argv.slice(2));
    } catch (e) {
        process.stderr.write(`kernel-aws-bootstrap: ${e.message}\n`);
        process.exit(2);
    }

    try {
        const plan = bootstrap(cfg);
        const lines = [];
        lines.push('');
        lines.push(`===== BOOTSTRAP AWS DEL KERNEL [${plan.mode}] =====`);
        lines.push(`cuenta      : <ACCOUNT> (derivada, no se imprime)`);
        lines.push(`admin       : ${redactArn(plan.adminArn)}`);
        lines.push(`región      : ${cfg.region}`);
        lines.push(`tabla       : ${cfg.table}`);
        lines.push(`coordinación: ${cfg.coordinationTable}`);
        lines.push(`usuario     : ${cfg.user}`);
        lines.push('');
        for (const s of plan.steps) {
            const detail = s.detail ? ` — ${s.detail}` : '';
            lines.push(`  [${s.status}] ${s.step}${detail}`);
        }
        lines.push('');
        if (!cfg.apply) {
            lines.push('Nada fue modificado. Para ejecutar: agregá --apply');
        } else {
            lines.push('Listo. La key quedó en credentials.json y en el profile; nunca se imprimió.');
        }
        lines.push('');
        process.stdout.write(`${lines.join('\n')}\n`);
        process.exit(0);
    } catch (e) {
        const done = (e.plan && e.plan.steps) || [];
        const out = [''];
        if (done.length > 0) {
            out.push('Verificado antes de frenar:');
            for (const s of done) {
                out.push(`  [${s.status}] ${s.step}${s.detail ? ` — ${s.detail}` : ''}`);
            }
            out.push('');
        }
        out.push(`kernel-aws-bootstrap ABORTADO: ${e.message}`);
        out.push('');
        process.stderr.write(`${out.join('\n')}\n`);
        process.exit(1);
    }
}

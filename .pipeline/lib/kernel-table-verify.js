'use strict';

// =============================================================================
// kernel-table-verify.js — Verificador READ-ONLY de las tablas del kernel (#5210)
//
// CONTEXTO
// --------
// Las dos tablas del cutover durable (no-repudio + coordinación) YA están
// aprovisionadas en AWS (decisión del operador del 30/07). Lo que faltaba no era
// crearlas sino **probar su postura de seguridad y documentar honestamente lo que
// el perfil acotado NO deja probar**. Eso es exactamente lo que hace este módulo.
//
// QUÉ NO ES (CA-7 · límite explícito con #5203)
// ---------------------------------------------
// **NO aprovisiona nada.** No crea tablas, no crea/rota la CMK, no toca IAM. Ese
// camino vive en `kernel-aws-bootstrap.js` / `kernel-cmk-provision.js` (PR #5203,
// todavía abierto) y en `kernel-provision.js` (main). Reimplementarlo acá
// generaría conflicto al mergear ese PR. Este módulo sólo OBSERVA.
//
// LA IDEA CENTRAL: un AccessDenied NO es un hallazgo, es un GAP (CA-3)
// --------------------------------------------------------------------
// El perfil `kernel-runtime` es deliberadamente acotado y no puede leer PITR, la
// CMK ni CloudTrail. La tentación es tratar "no pude verificarlo" como "está
// bien" — es la falla de auditoría clásica. Acá se corta de raíz:
//
//   - `summarizeTable` sólo emite `verified: true` sobre campos OBSERVADOS en el
//     `describe-table`. Ningún control se infiere.
//   - Los controles no observables salen en `gaps[]` con `verified: null` — nunca
//     `true`, nunca `false`. `null` es "no sé", y eso es un estado legítimo.
//   - `assertNoUnverifiedClaims` es un fusible: si alguien mutara un gap a
//     `verified: true`, el render TIRA en vez de imprimir un verde falso.
//
// implicitDeny vs explicitDeny: la distinción que decide el remedio
// -----------------------------------------------------------------
// No es trivia IAM, cambia quién destraba y cómo:
//   - implicitDeny  → falta un `Allow`. Se destraba agregando permisos read-only.
//   - explicitDeny  → hay un `Deny` en `policy/IntraleKernelStore`. Un `Deny`
//     explícito GANA sobre cualquier `Allow` posterior: agregar permisos NO
//     alcanza, hay que editar esa policy con un principal con gestión IAM.
// Confundirlos manda al operador a una remediación que no puede funcionar.
//
// SEGURIDAD
// ---------
//   - **Allowlist de comandos** (`READONLY_COMMANDS`): cualquier verbo fuera de
//     la lista es rechazado ANTES de spawnear. Sin `shell:true`, args como array
//     ⇒ sin inyección de comandos (A03).
//   - **Sin hardcode** (A05): nombres/región salen EXCLUSIVAMENTE de la sección
//     `kernel:` de `config.yaml`. Fail-closed si faltan o si las dos tablas son
//     la misma (un fallback silencioso a tabla compartida rompería la separación
//     de no-repudio vs coordinación).
//   - **Redacción** (A09): account IDs y UUID de CMK se enmascaran; los patrones
//     de secreto de `redact.js` se reaplican encima. Se PRESERVAN servicio,
//     región y nombre de recurso: sin eso la evidencia no probaría nada.
// =============================================================================

const { SECRET_VALUE_PATTERNS, REDACTION_MARKER } = require('./redact');

// -----------------------------------------------------------------------------
// Allowlist de comandos: SÓLO lectura. Fail-closed ante cualquier otra cosa.
// -----------------------------------------------------------------------------

const READONLY_COMMANDS = Object.freeze([
    'dynamodb describe-table',
    'dynamodb describe-continuous-backups',
    'dynamodb describe-time-to-live',
    'kms describe-key',
    'kms list-aliases',
    'kms get-key-rotation-status',
    'cloudtrail lookup-events',
]);

const ACCOUNT_MASK = '<ACCT>';
const DEFAULT_PROFILE = 'kernel-runtime';

// -----------------------------------------------------------------------------
// Redacción de evidencia AWS
// -----------------------------------------------------------------------------

// `redactSecretValue` (redact.js) reemplaza el ARN ENTERO por `[REDACTED]`, que
// es correcto para un log de error pero destruye la evidencia: sin el ARN no se
// puede probar que el SSE es KMS ni que las dos tablas son distintas. Acá se
// enmascara SÓLO la parte sensible (account id, UUID de la clave) y se preserva
// la topología que el criterio pide demostrar.
const NON_TOPOLOGY_SECRET_PATTERNS = SECRET_VALUE_PATTERNS.filter((p) => !p.topology);

// Account id: los 12 dígitos entre `:` dentro de un ARN, y también la forma
// `iam::<acct>:` que aparece en los mensajes de AccessDenied.
const ARN_ACCOUNT_RE = /(arn:aws[a-z0-9-]*:[a-z0-9-]*:[a-z0-9-]*:)(\d{12})(?=:)/g;
const IAM_ACCOUNT_RE = /(arn:aws[a-z0-9-]*:iam::)(\d{12})(?=:)/g;
// UUID de una CMK: se conserva el primer bloque para poder correlacionar dos
// referencias a la MISMA clave (dato central: ambas tablas comparten key ARN)
// sin publicar el identificador completo.
const KMS_KEY_UUID_RE = /\bkey\/([0-9a-f]{8})-[0-9a-f-]{20,}\b/gi;

/**
 * Enmascara la topología sensible de un string de evidencia AWS.
 * Preserva servicio/región/nombre de recurso (lo que el CA-2 exige probar).
 * @param {string} value
 * @returns {string}
 */
function redactAwsEvidence(value) {
    if (typeof value !== 'string' || value.length === 0) return value;
    let out = value;
    out = out.replace(IAM_ACCOUNT_RE, `$1${ACCOUNT_MASK}`);
    out = out.replace(ARN_ACCOUNT_RE, `$1${ACCOUNT_MASK}`);
    out = out.replace(KMS_KEY_UUID_RE, 'key/$1-<REDACTED>');
    // Segunda capa: credenciales reales embebidas (AKIA…, JWT, api keys). Los
    // patrones `topology` se excluyen a propósito — ya los cubrimos arriba de
    // forma quirúrgica y aplicarlos borraría el ARN entero.
    for (const { re } of NON_TOPOLOGY_SECRET_PATTERNS) {
        out = out.replace(re, REDACTION_MARKER);
    }
    return out;
}

/**
 * Aplica `redactAwsEvidence` en profundidad sobre cualquier estructura.
 * @param {*} value
 * @returns {*}
 */
function redactDeep(value) {
    if (typeof value === 'string') return redactAwsEvidence(value);
    if (Array.isArray(value)) return value.map(redactDeep);
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v);
        return out;
    }
    return value;
}

// -----------------------------------------------------------------------------
// Clasificación del deny (CA-3)
// -----------------------------------------------------------------------------

/**
 * Clasifica el stderr de un AccessDeniedException.
 *
 * @param {string} text  stderr crudo del AWS CLI.
 * @returns {{type:'explicitDeny'|'implicitDeny'|'accessDenied'|'none'|'error',
 *            action:(string|null), policy:(string|null), message:(string|null)}}
 *   - `explicitDeny`: hay un `Deny` en una policy nombrada ⇒ NO se destraba con Allow.
 *   - `implicitDeny` : falta el `Allow` ⇒ se destraba con permisos read-only.
 *   - `accessDenied` : denegado pero sin forma reconocible (conservador: no se
 *                      afirma cuál de los dos remedios aplica).
 *   - `none`         : no hubo denegación.
 */
function classifyDeny(text) {
    const raw = typeof text === 'string' ? text : '';
    if (!raw) return { type: 'none', action: null, policy: null, message: null };
    if (!/AccessDenied/i.test(raw)) {
        return { type: 'error', action: null, policy: null, message: redactAwsEvidence(raw.trim()) };
    }

    const actionMatch = raw.match(/not authorized to perform:\s*([A-Za-z0-9:*-]+)/);
    const action = actionMatch ? actionMatch[1] : null;

    // Forma explícita: "...with an explicit deny in an identity-based policy: arn:...:policy/Nombre"
    const explicitMatch = raw.match(/with an explicit deny in[^:]*:\s*(arn:aws[^\s"'`,)\]}]*)/i);
    if (explicitMatch) {
        return {
            type: 'explicitDeny',
            action,
            policy: redactAwsEvidence(explicitMatch[1]),
            message: redactAwsEvidence(raw.trim()),
        };
    }
    if (/explicit deny/i.test(raw)) {
        return { type: 'explicitDeny', action, policy: null, message: redactAwsEvidence(raw.trim()) };
    }

    // Forma implícita: "...because no identity-based policy allows the X action"
    if (/no identity-based policy allows/i.test(raw)) {
        return { type: 'implicitDeny', action, policy: null, message: redactAwsEvidence(raw.trim()) };
    }

    return { type: 'accessDenied', action, policy: null, message: redactAwsEvidence(raw.trim()) };
}

// -----------------------------------------------------------------------------
// Config (fail-closed, sin hardcode · A05)
// -----------------------------------------------------------------------------

// #5172 — Ya no hace falta un `DEFAULT_CONFIG_PATH` propio: la resolución de la
// ruta (y su precedencia) es responsabilidad del punto único, `config-resolver`.

/**
 * Lee y valida la sección `kernel:` de config.yaml.
 * @param {object} [opts]
 * @param {string} [opts.configPath]
 * @param {object} [opts.kernelConfig]  override inyectable (tests).
 * @returns {{tableName:string, coordinationTableName:string, region:string, durable:boolean}}
 * @throws {Error} fail-closed si falta cualquier clave o si ambas tablas coinciden.
 */
function readKernelTablesConfig(opts = {}) {
    let kernel = opts.kernelConfig;
    if (!kernel) {
        // #5172 — La lectura pasa por el punto ÚNICO (`lib/config-resolver`), que
        // parsea, valida contra el schema y lanza errores tipados ya redactados.
        // Este módulo llegó desde #5276 con su propio `yaml.load` (el lector Nº29)
        // mientras #5172 estaba en vuelo; el guard CA-2 lo detectó. Migrarlo
        // preserva su fail-closed: un config ilegible ya no se hace pasar por
        // "sección kernel: ausente" (que acá degrada a "faltan claves").
        // eslint-disable-next-line global-require
        const configResolver = require('./config-resolver');
        const doc = configResolver.resolve(
            opts.configPath ? { configPath: opts.configPath } : {},
        ) || {};
        kernel = (doc && typeof doc.kernel === 'object' && doc.kernel) || {};
    }

    const str = (v) => (typeof v === 'string' ? v.trim() : '');
    const tableName = str(kernel.tableName);
    const coordinationTableName = str(kernel.coordinationTableName);
    const region = str(kernel.region);

    const faltantes = [];
    if (!tableName) faltantes.push('kernel.tableName');
    if (!coordinationTableName) faltantes.push('kernel.coordinationTableName');
    if (!region) faltantes.push('kernel.region');
    if (faltantes.length) {
        throw new Error(
            `kernel-table-verify: faltan claves de config (${faltantes.join(', ')}). `
            + 'Fail-closed: la tabla/región NUNCA se hardcodea, se define en '
            + '.pipeline/config.yaml (sección kernel:).',
        );
    }
    if (tableName === coordinationTableName) {
        throw new Error(
            'kernel-table-verify: kernel.tableName y kernel.coordinationTableName son la MISMA tabla. '
            + 'Fail-closed: la de no-repudio es append-only y la de coordinación necesita DeleteItem '
            + 'para liberar claims; compartirlas rompe esa separación.',
        );
    }
    // #5207 — `iamAdminProfile` habilita la SEGUNDA pasada (ver `verifyKernelTables`).
    // Su ausencia NO es fail-closed: sin él todo queda como gap no verificado,
    // que es el estado conservador. Lo mismo que ya hace `kernel-iam-verify` con
    // el chequeo de drift.
    return {
        tableName,
        coordinationTableName,
        region,
        durable: kernel.durable === true,
        iamAdminProfile: str(kernel.iamAdminProfile) || null,
    };
}

// -----------------------------------------------------------------------------
// Runner AWS CLI read-only (spawn inyectable, sin shell)
// -----------------------------------------------------------------------------

/**
 * Runner acotado a la allowlist read-only.
 * @param {object} [opts]
 * @param {string} [opts.profile]  perfil AWS (default `kernel-runtime`).
 * @param {function} [opts.spawn]  inyectable para tests.
 * @returns {{run:function(string[]):Promise<{code:number,stdout:string,stderr:string}>}}
 */
function createReadOnlyAwsRunner(opts = {}) {
    const profile = typeof opts.profile === 'string' && opts.profile ? opts.profile : DEFAULT_PROFILE;
    const spawn = typeof opts.spawn === 'function'
        ? opts.spawn
        // eslint-disable-next-line global-require
        : require('child_process').spawn;

    return {
        profile,
        run(args) {
            const list = Array.isArray(args) ? args.map(String) : [];
            const verb = `${list[0]} ${list[1]}`;
            if (!READONLY_COMMANDS.includes(verb)) {
                // Fail-closed ANTES de spawnear: este módulo sólo observa.
                return Promise.reject(new Error(
                    `kernel-table-verify: comando "${verb}" fuera de la allowlist read-only. `
                    + `Permitidos: ${READONLY_COMMANDS.join(', ')}. `
                    + 'El aprovisionamiento NO es alcance de este módulo (#5210 CA-7).',
                ));
            }
            return new Promise((resolve, reject) => {
                const child = spawn('aws', [...list, '--profile', profile, '--output', 'json'], {
                    shell: false, // PROHIBIDO shell:true (A03).
                });
                let stdout = '';
                let stderr = '';
                if (child.stdout) child.stdout.on('data', (d) => { stdout += d; });
                if (child.stderr) child.stderr.on('data', (d) => { stderr += d; });
                child.on('error', reject);
                child.on('close', (code) => resolve({
                    code: typeof code === 'number' ? code : 0,
                    stdout,
                    stderr,
                }));
            });
        },
    };
}

// -----------------------------------------------------------------------------
// Resumen de una tabla — SÓLO campos observados (CA-2)
// -----------------------------------------------------------------------------

/**
 * Extrae de un `describe-table` los cuatro controles verificables del CA-2.
 * No infiere ni completa nada que no esté en el output.
 *
 * @param {object} describeJson  payload parseado de `aws dynamodb describe-table`.
 * @param {object} [expected]    { tableName, region } para chequear coherencia.
 * @returns {object} resumen redactado con `verified` y `missing[]`.
 */
function summarizeTable(describeJson, expected = {}) {
    const table = (describeJson && describeJson.Table) || null;
    if (!table) {
        return {
            tableName: expected.tableName || null,
            exists: false,
            verified: false,
            missing: ['describe-table no devolvió `Table` (la tabla no existe o el output es inválido)'],
        };
    }

    const sse = table.SSEDescription || {};
    const status = table.TableStatus || null;
    const sseStatus = sse.Status || null;
    const sseType = sse.SSEType || null;
    // `DeletionProtectionEnabled` ausente NO es `false` para nosotros: es "no
    // observado". Se distinguen a propósito — asumir el default sería inferir.
    const delProt = Object.prototype.hasOwnProperty.call(table, 'DeletionProtectionEnabled')
        ? table.DeletionProtectionEnabled === true
        : null;

    const missing = [];
    if (status !== 'ACTIVE') missing.push(`TableStatus esperado ACTIVE, observado ${status === null ? 'ausente' : status}`);
    if (sseStatus !== 'ENABLED') missing.push(`SSEDescription.Status esperado ENABLED, observado ${sseStatus === null ? 'ausente' : sseStatus}`);
    if (sseType !== 'KMS') missing.push(`SSEDescription.SSEType esperado KMS, observado ${sseType === null ? 'ausente' : sseType}`);
    if (delProt !== true) missing.push(`DeletionProtectionEnabled esperado true, observado ${delProt === null ? 'ausente' : String(delProt)}`);
    if (expected.tableName && table.TableName !== expected.tableName) {
        missing.push(`TableName esperado ${expected.tableName}, observado ${table.TableName}`);
    }
    if (expected.region && typeof table.TableArn === 'string'
        && !table.TableArn.includes(`:${expected.region}:`)) {
        missing.push(`TableArn no corresponde a la región esperada ${expected.region}`);
    }

    return redactDeep({
        tableName: table.TableName || null,
        exists: true,
        status,
        tableArn: table.TableArn || null,
        billingMode: (table.BillingModeSummary && table.BillingModeSummary.BillingMode) || null,
        sse: { status: sseStatus, type: sseType, keyArn: sse.KMSMasterKeyArn || null },
        deletionProtection: delProt,
        verified: missing.length === 0,
        missing,
    });
}

// -----------------------------------------------------------------------------
// Sondas del gap (CA-3): comandos que el perfil acotado NO puede correr
// -----------------------------------------------------------------------------

/**
 * Controles que este perfil no puede observar. `verified` arranca en `null` y
 * NUNCA sube a `true` desde acá: sólo un output real podría hacerlo, y si el
 * comando devolviera datos el control dejaría de ser un gap.
 */
function buildGapProbes(cfg, keyArn) {
    const probes = [
        {
            key: 'pitr-no-repudio',
            control: 'PITR (point-in-time recovery)',
            args: ['dynamodb', 'describe-continuous-backups', '--table-name', cfg.tableName, '--region', cfg.region],
        },
        {
            key: 'pitr-coordinacion',
            control: 'PITR (point-in-time recovery)',
            args: ['dynamodb', 'describe-continuous-backups', '--table-name', cfg.coordinationTableName, '--region', cfg.region],
        },
        {
            key: 'ttl-coordinacion',
            control: 'TTL de la tabla de coordinación',
            args: ['dynamodb', 'describe-time-to-live', '--table-name', cfg.coordinationTableName, '--region', cfg.region],
        },
        {
            key: 'cloudtrail',
            control: 'Rastro de auditoría (CloudTrail)',
            args: ['cloudtrail', 'lookup-events', '--region', cfg.region, '--max-results', '1'],
        },
    ];
    if (keyArn) {
        probes.push(
            {
                key: 'cmk-propiedad',
                control: 'Propiedad de la CMK (gestionada propia vs aws/dynamodb)',
                args: ['kms', 'describe-key', '--key-id', keyArn, '--region', cfg.region],
            },
            {
                key: 'cmk-alias',
                control: 'Propiedad de la CMK (alias)',
                args: ['kms', 'list-aliases', '--key-id', keyArn, '--region', cfg.region],
            },
            {
                key: 'cmk-rotacion',
                control: 'Rotación de la CMK',
                args: ['kms', 'get-key-rotation-status', '--key-id', keyArn, '--region', cfg.region],
            },
        );
    }
    return probes;
}

// -----------------------------------------------------------------------------
// #5207 — Lectura de un control del gap con el perfil ADMIN de sólo lectura
// -----------------------------------------------------------------------------
//
// POR QUÉ HACE FALTA UNA SEGUNDA PASADA
//   El CA-2 del paraguas (#5207) exige outputs que PRUEBEN PITR, CMK y CloudTrail.
//   El perfil `kernel-runtime` no puede leer ninguno de los tres — y está bien que
//   no pueda: es mínimo privilegio, y ese `AccessDenied` es en sí mismo la
//   evidencia del CA de IAM. Pero entonces el control queda sin demostrar por
//   herramienta, y el CA-2 se cerraba a mano con comandos pegados en un issue.
//
//   La salida NO es aflojarle permisos al runtime: es leer esos controles con el
//   mismo perfil admin de sólo lectura que `kernel-iam-verify` ya usa para el
//   drift (`kernel.iamAdminProfile`). Dos pasadas, dos identidades, cada una
//   probando lo suyo: el runtime prueba que NO puede, el admin prueba que el
//   control ESTÁ.
//
// EL FAIL-CLOSED NO SE TOCA
//   `verified: true` sigue exigiendo un campo OBSERVADO en el output real. Si el
//   perfil admin no está configurado, si el comando falla, o si el campo no
//   aparece, el control vuelve a `null` ("no sé"). Nunca se infiere.
//
// Devuelve `null` si el output no permite afirmar nada.
function observeGapControl(key, json) {
    if (!json || typeof json !== 'object') return null;

    switch (key) {
        case 'pitr-no-repudio':
        case 'pitr-coordinacion': {
            const d = json.ContinuousBackupsDescription || {};
            const estado = (d.PointInTimeRecoveryDescription || {}).PointInTimeRecoveryStatus;
            if (typeof estado !== 'string') return null;
            return {
                // La tabla de no-repudio DEBE tener PITR; la de coordinación es
                // efímera y su postura documentada es no tenerlo. Por eso acá se
                // REPORTA el estado observado y no se juzga: quien juzga es el
                // criterio, con la postura de cada tabla a la vista.
                pointInTimeRecovery: estado,
                periodoRetencionDias: (d.PointInTimeRecoveryDescription || {}).RecoveryPeriodInDays || null,
            };
        }
        case 'ttl-coordinacion': {
            const estado = (json.TimeToLiveDescription || {}).TimeToLiveStatus;
            if (typeof estado !== 'string') return null;
            return { timeToLive: estado };
        }
        case 'cmk-propiedad': {
            const k = json.KeyMetadata || {};
            if (typeof k.KeyManager !== 'string') return null;
            return {
                // `CUSTOMER` es el dato que separa una CMK propia de la clave
                // `aws/dynamodb` administrada por AWS — que es exactamente lo
                // que el `describe-table` NO permite distinguir.
                keyManager: k.KeyManager,
                keyState: k.KeyState || null,
                enabled: k.Enabled === true,
            };
        }
        case 'cmk-alias': {
            const aliases = Array.isArray(json.Aliases) ? json.Aliases : null;
            if (!aliases || !aliases.length) return null;
            return { aliases: aliases.map((a) => a.AliasName).filter(Boolean) };
        }
        case 'cmk-rotacion': {
            const r = json.KeyRotationEnabled;
            if (typeof r !== 'boolean') return null;
            return { rotacionAutomatica: r };
        }
        // `cloudtrail` NO se resuelve acá a propósito: el rastro se verifica con
        // `kernel-cloudtrail-provision --verify`, que valida los 11 controles de
        // postura del destino (bucket privado, TLS-only, retención, separación de
        // identidades). Un `lookup-events` que devuelve 200 probaría muchísimo
        // menos y se leería como si probara lo mismo.
        default:
            return null;
    }
}

// -----------------------------------------------------------------------------
// Orquestación
// -----------------------------------------------------------------------------

function parseJsonSafe(stdout) {
    try {
        return JSON.parse(stdout);
    } catch (_) {
        return null;
    }
}

/**
 * Corre la verificación completa: describe-table de ambas tablas + sondas del gap.
 *
 * @param {object} deps
 * @param {object}  deps.runner  `{ run(args) }` (default: runner read-only real).
 * @param {object} [deps.config] override de config (tests).
 * @param {string} [deps.configPath]
 * @returns {Promise<object>} reporte estructurado y ya redactado.
 */
async function verifyKernelTables(deps = {}) {
    const cfg = deps.config || readKernelTablesConfig({ configPath: deps.configPath });
    const runner = deps.runner || createReadOnlyAwsRunner({ profile: deps.profile });

    const tables = [];
    let keyArnCrudo = null;
    const keyArnsPorTabla = [];

    for (const [rol, nombre] of [['no-repudio', cfg.tableName], ['coordinación', cfg.coordinationTableName]]) {
        const res = await runner.run(['dynamodb', 'describe-table', '--table-name', nombre, '--region', cfg.region]);
        const json = res.code === 0 ? parseJsonSafe(res.stdout) : null;
        if (!json) {
            const deny = classifyDeny(res.stderr);
            tables.push({
                rol,
                tableName: nombre,
                exists: false,
                verified: false,
                missing: [`describe-table falló (code ${res.code}): ${deny.message || 'sin detalle'}`],
                deny: deny.type === 'none' ? null : deny,
            });
            continue;
        }
        const crudo = json.Table && json.Table.SSEDescription && json.Table.SSEDescription.KMSMasterKeyArn;
        if (crudo) {
            keyArnCrudo = keyArnCrudo || crudo;
            keyArnsPorTabla.push(crudo);
        }
        tables.push({ rol, ...summarizeTable(json, { tableName: nombre, region: cfg.region }) });
    }

    // Dato relevante para el operador: si ambas tablas comparten key ARN, una
    // sola decisión sobre esa clave afecta a las dos. NO afirma nada sobre si la
    // clave es propia o administrada por AWS — eso es justamente el gap.
    const mismaCmk = keyArnsPorTabla.length === 2 && keyArnsPorTabla[0] === keyArnsPorTabla[1];

    const probes = buildGapProbes(cfg, keyArnCrudo);

    const gaps = [];
    for (const probe of probes) {
        let deny;
        try {
            const res = await runner.run(probe.args);
            deny = res.code === 0
                ? { type: 'none', action: null, policy: null, message: null }
                : classifyDeny(res.stderr);
        } catch (e) {
            deny = { type: 'error', action: null, policy: null, message: redactAwsEvidence(String(e && e.message)) };
        }
        gaps.push({
            key: probe.key,
            control: probe.control,
            comando: redactAwsEvidence(`aws ${probe.args.join(' ')} --profile ${runner.profile || DEFAULT_PROFILE}`),
            deny: deny.type,
            action: deny.action,
            policy: deny.policy,
            // `null` = NO VERIFICADO. Nunca `true` desde esta pasada: el criterio
            // prohíbe declarar cumplido lo que no se pudo observar.
            verified: deny.type === 'none' ? 'observado-revisar' : null,
            remediacion: deny.type === 'explicitDeny'
                ? 'Deny explícito: agregar permisos NO alcanza; hay que editar esa policy con un principal con gestión IAM.'
                : (deny.type === 'implicitDeny'
                    ? 'Falta un Allow: se destraba agregando el permiso read-only al perfil.'
                    : 'Sin clasificar: revisar el mensaje crudo antes de decidir remediación.'),
            detalle: deny.message,
            // Se completan en la segunda pasada (#5207) si hay perfil admin.
            observadoCon: null,
            evidencia: null,
        });
    }

    // -------------------------------------------------------------------------
    // Segunda pasada (#5207 · CA-2): los mismos controles, leídos con el perfil
    // ADMIN de sólo lectura. No afloja el mínimo privilegio del runtime — usa
    // OTRA identidad, que es justamente la separación que el CA quiere probar.
    // -------------------------------------------------------------------------
    const adminProfile = deps.adminProfile !== undefined ? deps.adminProfile : cfg.iamAdminProfile;
    let adminRunner = null;
    if (deps.adminRunner) {
        adminRunner = deps.adminRunner;
    } else if (adminProfile) {
        adminRunner = createReadOnlyAwsRunner({ profile: adminProfile, spawn: deps.spawn });
    }

    if (adminRunner) {
        const porKey = new Map(probes.map((p) => [p.key, p]));
        for (const gap of gaps) {
            const probe = porKey.get(gap.key);
            if (!probe) continue;
            let json = null;
            try {
                const res = await adminRunner.run(probe.args);
                json = res.code === 0 ? parseJsonSafe(res.stdout) : null;
            } catch (_) {
                json = null; // No poder observar sigue siendo "no sé", no un fallo.
            }
            const evidencia = observeGapControl(gap.key, json);
            if (!evidencia) continue; // El control sigue sin verificar.
            gap.verified = true;
            gap.observadoCon = adminRunner.profile || adminProfile;
            gap.evidencia = redactDeep(evidencia);
            // El comando publicado tiene que ser el que REPRODUCE la evidencia.
            // Dejarlo con `--profile kernel-runtime` mandaría a quien audite a
            // correr algo que devuelve AccessDenied, y a concluir que la
            // evidencia es falsa.
            gap.comandoObservacion = redactAwsEvidence(
                `aws ${probe.args.join(' ')} --profile ${gap.observadoCon}`,
            );
        }
    }

    const gapsPendientes = gaps.filter((g) => g.verified !== true);

    return {
        issue: 5210,
        config: {
            tableName: cfg.tableName,
            coordinationTableName: cfg.coordinationTableName,
            region: cfg.region,
            durable: cfg.durable,
        },
        perfil: runner.profile || DEFAULT_PROFILE,
        perfilAdmin: adminRunner ? (adminRunner.profile || adminProfile) : null,
        tables,
        mismaCmkEnAmbasTablas: mismaCmk,
        gaps,
        verificable: tables.length === 2 && tables.every((t) => t.verified === true),
        // #5207 — Cuántos controles del gap quedaron efectivamente sin observar.
        // Es el número que decide si el CA-2 está cerrado o no.
        gapsPendientes: gapsPendientes.length,
        // Recordatorio embebido en el propio artefacto: quien lea el JSON no
        // necesita leer el issue para saber que los gaps no son aprobaciones.
        nota: 'Los ítems de `gaps` con `verified: null` NO están verificados. Prohibido declararlos cumplidos (#5210 CA-3). '
            + 'Los que tienen `verified: true` traen el output observado en `evidencia` y la identidad que lo leyó en `observadoCon`.',
    };
}

/**
 * Fusible: aborta si algún gap fue marcado como cumplido sin observación.
 * Corre antes de renderizar para que un verde falso nunca llegue a un doc.
 * @param {object} report
 * @throws {Error}
 */
function assertNoUnverifiedClaims(report) {
    const gaps = (report && report.gaps) || [];
    for (const g of gaps) {
        // #5207 — El fusible ya no prohíbe `verified: true` de plano: prohíbe un
        // `true` SIN el output que lo respalde. La regla de fondo no cambió —
        // sigue sin poder declararse cumplido lo que no se observó— pero ahora
        // un control leído de verdad por el perfil admin puede cerrarse, y lo
        // que se exige es que traiga la evidencia y la identidad que la leyó.
        if (g.verified === true && !(g.evidencia && g.observadoCon)) {
            throw new Error(
                `kernel-table-verify: el control "${g.control}" está marcado como verificado sin evidencia observada. `
                + 'Prohibido declarar PITR/CMK/CloudTrail cumplidos sin haberlos podido observar (#5210 CA-3).',
            );
        }
    }
    return true;
}

/**
 * Render markdown del reporte (ya redactado).
 * @param {object} report
 * @returns {string}
 */
function renderMarkdown(report) {
    assertNoUnverifiedClaims(report);
    const l = [];
    l.push('## Verificación de tablas del kernel (#5210)');
    l.push('');
    l.push(`- Perfil AWS: \`${report.perfil}\``);
    l.push(`- Región: \`${report.config.region}\``);
    l.push(`- \`kernel.durable\`: \`${report.config.durable}\``);
    l.push('');
    l.push('### Verificable (CA-2)');
    l.push('');
    l.push('| Tabla | Rol | Existe | Status | SSE | Tipo | Deletion protection | Veredicto |');
    l.push('|---|---|---|---|---|---|---|---|');
    for (const t of report.tables) {
        l.push(`| \`${t.tableName}\` | ${t.rol} | ${t.exists ? 'sí' : 'NO'} | ${t.status || '—'} `
            + `| ${(t.sse && t.sse.status) || '—'} | ${(t.sse && t.sse.type) || '—'} `
            + `| ${t.deletionProtection === null ? 'no observado' : String(t.deletionProtection)} `
            + `| ${t.verified ? 'OK' : 'FALLA'} |`);
    }
    // #5207 — Los controles que el perfil admin SÍ pudo observar salen de la
    // tabla de gaps y pasan a una tabla propia, con el output que los respalda.
    const cerrados = report.gaps.filter((g) => g.verified === true);
    const pendientes = report.gaps.filter((g) => g.verified !== true);

    if (cerrados.length) {
        l.push('');
        l.push('### Verificado con el perfil admin de sólo lectura (CA-2 · #5207)');
        l.push('');
        l.push(`> Leído con \`${report.perfilAdmin}\`, NO con el runtime. El runtime sigue sin poder verlo`);
        l.push('> —ese `AccessDenied` es la evidencia del mínimo privilegio— y el control queda igual demostrado.');
        l.push('');
        l.push('| Control | Observado | Comando |');
        l.push('|---|---|---|');
        for (const g of cerrados) {
            const ev = Object.entries(g.evidencia || {})
                .map(([k, v]) => `${k}=\`${v}\``).join(' · ');
            l.push(`| ${g.control} | ${ev || '—'} | \`${g.comandoObservacion || g.comando}\` |`);
        }
    }

    l.push('');
    l.push('### Gap de verificación — NO verificado (CA-3)');
    l.push('');
    if (!pendientes.length) {
        l.push('> Sin gaps: todos los controles fueron observados.');
        return l.join('\n');
    }
    l.push('| Control | Comando | Tipo de deny | Se destraba con permisos |');
    l.push('|---|---|---|---|');
    for (const g of pendientes) {
        const destrababa = g.deny === 'explicitDeny' ? 'NO (Deny explícito)' : (g.deny === 'implicitDeny' ? 'sí (falta Allow)' : '—');
        l.push(`| ${g.control} | \`${g.comando}\` | \`${g.deny}\` | ${destrababa} |`);
    }
    l.push('');
    l.push('> Ningún control de esta tabla está verificado. No pueden declararse cumplidos.');
    return l.join('\n');
}

module.exports = {
    READONLY_COMMANDS,
    DEFAULT_PROFILE,
    ACCOUNT_MASK,
    redactAwsEvidence,
    redactDeep,
    classifyDeny,
    readKernelTablesConfig,
    createReadOnlyAwsRunner,
    summarizeTable,
    buildGapProbes,
    observeGapControl,
    verifyKernelTables,
    assertNoUnverifiedClaims,
    renderMarkdown,
};

// -----------------------------------------------------------------------------
// CLI: node .pipeline/lib/kernel-table-verify.js [--json] [--profile <p>]
// -----------------------------------------------------------------------------
if (require.main === module) {
    const argv = process.argv.slice(2);
    const asJson = argv.includes('--json');
    const pIdx = argv.indexOf('--profile');
    const profile = pIdx >= 0 ? argv[pIdx + 1] : undefined;

    verifyKernelTables({ profile })
        .then((report) => {
            process.stdout.write(asJson
                ? `${JSON.stringify(report, null, 2)}\n`
                : `${renderMarkdown(report)}\n`);
            // Exit 1 si lo verificable NO da OK. Los gaps no cambian el exit
            // code: no poder observar un control no es una falla del control.
            process.exitCode = report.verificable ? 0 : 1;
        })
        .catch((e) => {
            process.stderr.write(`kernel-table-verify: ${redactAwsEvidence(String(e && e.message))}\n`);
            process.exitCode = 2;
        });
}

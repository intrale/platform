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

// -----------------------------------------------------------------------------
// #5207 (rebote rev-2) — Controles DELEGADOS a otra herramienta
// -----------------------------------------------------------------------------
//
// EL DEFECTO QUE CIERRA ESTE BLOQUE
//   `cloudtrail` se sondeaba como si este módulo tuviera que cerrarlo, pero
//   `observeGapControl` nunca lo resuelve y `POSTURAS` no lo declara —a
//   propósito—. El control quedaba en `no-observado` PARA SIEMPRE, así que
//   `gapsPendientes >= 1` era una constante y `ca2Cerrado` no podía ser `true`
//   ni en un ambiente donde todo cumple. El artefacto que FIRMA UN OPERADOR
//   decía "CA-2 NO cerrado" con los siete controles en verde: exactamente la
//   desalineación que `ca2Cerrado` vino a eliminar.
//
// LA DISTINCIÓN QUE FALTABA
//   "No pude observarlo" y "no me toca observarlo acá" son dos cosas distintas y
//   se estaban contando igual. El rastro de auditoría SE PRUEBA, pero con
//   `kernel-cloudtrail-provision --verify`, que valida los 11 controles de
//   postura del destino (bucket privado, TLS-only, retención, separación de
//   identidades). Un `lookup-events` que devuelve 200 probaría muchísimo menos y
//   se leería como si probara lo mismo.
//
// QUÉ IMPLICA SER DELEGADO
//   - Estado propio `'delegado'`, fuera del cómputo de `gapsPendientes` y por lo
//     tanto de `ca2Cerrado`: este módulo no puede cerrarlo NI bloquearlo.
//   - `verified` sigue en `null`: delegar no es declarar cumplido. El cierre lo
//     da la otra herramienta, con su propio fusible.
//   - No se ejecuta el comando AWS: correrlo para tirar el resultado publicaba
//     un `deny: 'none'` con remediación de permisos sobre algo que salió 200.
//   - Sale en sección propia del markdown, NO en la tabla de gap de
//     observación, cuya leyenda ("ningún control de esta tabla está verificado")
//     no aplica a un control que se verifica en otro lado.
const CONTROLES_DELEGADOS = Object.freeze({
    cloudtrail: Object.freeze({
        herramienta: 'node .pipeline/lib/kernel-cloudtrail-provision.js --verify',
        porQue: 'El rastro se prueba por POSTURA DEL DESTINO (bucket privado, TLS-only, retención, '
            + 'separación de identidades: 11 controles), no por un `lookup-events` que devuelve 200. '
            + 'Ver docs/pipeline/kernel-cutover-evidencia-5207.md §3 y §6.4.',
    }),
});

/**
 * Controles que este perfil no puede observar. `verified` arranca en `null` y
 * NUNCA sube a `true` desde acá: sólo un output real podría hacerlo, y si el
 * comando devolviera datos el control dejaría de ser un gap.
 *
 * Los probes con `delegadoA` no se ejecutan: se publican para que el artefacto
 * nombre el control y diga con qué herramienta se prueba (#5207 rebote rev-2).
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
            // No se corre: el control lo cierra la herramienta de abajo.
            delegadoA: CONTROLES_DELEGADOS.cloudtrail,
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
// #5207 (rebote rev-1) — La POSTURA ESPERADA de cada control
// -----------------------------------------------------------------------------
//
// EL DEFECTO QUE CIERRA ESTE BLOQUE
//   La primera versión de la segunda pasada ponía `verified: true` apenas el
//   perfil admin lograba OBSERVAR el control. Observar y cumplir no son lo mismo.
//   Un ambiente con PITR `DISABLED` en la tabla de NO-REPUDIO, la clave
//   `aws/dynamodb` en vez de una CMK propia y la rotación apagada —los tres
//   controles del CA-2 en rojo— producía un artefacto con `gapsPendientes: 1` y
//   una sección titulada "el control queda igual demostrado".
//
//   Es el mismo modo de falla que #5210 cerró ("no pude verlo" ≠ "está bien"),
//   corrido un casillero: ahora era "lo vi" ≠ "cumple". Y pesa más, porque este
//   artefacto es la evidencia que firma un operador.
//
// LA REGLA
//   Cada control declara qué postura debe tener y POR QUÉ. `verified: true` exige
//   las dos cosas: evidencia OBSERVADA **y** que esa evidencia SATISFAGA la
//   postura. Si no la satisface, el control no se cierra: queda en
//   `estado: 'observado-incumple'` con `verified: false`, cuenta en
//   `gapsPendientes` y sale en una sección propia del markdown que dice que
//   incumple. Un control sin postura declarada tampoco cierra
//   (`observado-sin-postura`): el default es no dar nada por cumplido.
//
// POR QUÉ ALGUNAS POSTURAS ESPERAN UN `DISABLED`
//   Para la tabla de coordinación, `DISABLED` no es un hallazgo: es la postura
//   documentada en `docs/pipeline/kernel-tablas-cutover-5210.md` §4. Se codifica
//   igual que las demás para que una desviación —un PITR o un TTL que aparezcan
//   activados ahí— salga como algo a revisar en vez de pasar inadvertida.

// Los alias `alias/aws/*` los administra AWS. Anclado a inicio de string o al
// `:` de un ARN: un alias propio que contenga `/aws/` más adentro no es de AWS.
const ALIAS_ADMINISTRADO_POR_AWS_RE = /(?:^|:)alias\/aws\//i;

const POSTURAS = Object.freeze({
    'pitr-no-repudio': Object.freeze({
        esperado: 'PointInTimeRecoveryStatus = ENABLED',
        porQue: 'La tabla de no-repudio es append-only y su contenido ES la evidencia. '
            + 'Sin PITR no hay forma de recuperarla ante un borrado o una mutación no prevista.',
        evalua: (ev) => ev.pointInTimeRecovery === 'ENABLED',
    }),
    'pitr-coordinacion': Object.freeze({
        esperado: 'PointInTimeRecoveryStatus = DISABLED (postura documentada · §4)',
        porQue: 'Coordinación es efímera y sólo guarda claims vivos: restaurarla a un punto '
            + 'del pasado reinstalaría claims ya liberados, que es peor que perderla. Un '
            + 'ENABLED acá no es una mejora — contradice la postura documentada y hay que revisarla.',
        evalua: (ev) => ev.pointInTimeRecovery === 'DISABLED',
    }),
    'ttl-coordinacion': Object.freeze({
        esperado: 'TimeToLiveStatus = DISABLED (postura documentada · §4)',
        porQue: 'El espacio de claves es acotado y los claims se sobrescriben en vez de apilarse: '
            + 'el vencimiento es por lease de aplicación, no por TTL. Un TTL sumaría una segunda '
            + 'ruta de borrado, con su latencia de barrido, sobre un mecanismo que ya vence de '
            + 'forma determinística en el `claim()`.',
        evalua: (ev) => ev.timeToLive === 'DISABLED',
    }),
    'cmk-propiedad': Object.freeze({
        esperado: 'KeyManager = CUSTOMER, con la clave habilitada',
        porQue: '`CUSTOMER` es lo que separa una CMK propia de la clave `aws/dynamodb` '
            + 'administrada por AWS — exactamente la distinción que el `describe-table` NO '
            + 'permite hacer. Sobre la clave de AWS no hay key policy propia ni control de rotación.',
        evalua: (ev) => ev.keyManager === 'CUSTOMER'
            && ev.enabled === true
            && (ev.keyState === null || ev.keyState === undefined || ev.keyState === 'Enabled'),
    }),
    'cmk-alias': Object.freeze({
        esperado: 'al menos un alias propio, fuera del espacio `alias/aws/*`',
        porQue: 'Es la contraparte observable de `KeyManager=CUSTOMER`: si el único alias de la '
            + 'clave es `alias/aws/dynamodb`, la clave no es del kernel.',
        evalua: (ev) => Array.isArray(ev.aliases)
            && ev.aliases.some((a) => typeof a === 'string' && a && !ALIAS_ADMINISTRADO_POR_AWS_RE.test(a)),
    }),
    'cmk-rotacion': Object.freeze({
        esperado: 'KeyRotationEnabled = true',
        porQue: 'Sin rotación automática, el material de la clave que cifra el store de no-repudio '
            + 'no cambia nunca. Si el ambiente decide deliberadamente NO rotar, la salida es '
            + 'documentar esa postura y actualizarla acá —como se hizo con PITR/TTL de '
            + 'coordinación—, no dejar el control rotulado como demostrado.',
        evalua: (ev) => ev.rotacionAutomatica === true,
    }),
});

/**
 * Evalúa la evidencia observada contra la postura esperada del control.
 * @param {string} key            key del probe.
 * @param {object} evidenciaCruda salida de `observeGapControl` SIN redactar.
 * @returns {{esperado:string, porQue:string, cumple:boolean}|null}
 *   `null` si el control no declara postura ⇒ no puede cerrarse (fail-closed).
 */
function evaluarPostura(key, evidenciaCruda) {
    const postura = POSTURAS[key];
    if (!postura) return null;
    if (!evidenciaCruda || typeof evidenciaCruda !== 'object') return null;
    let cumple = false;
    try {
        cumple = postura.evalua(evidenciaCruda) === true;
    } catch (_) {
        // Una postura que revienta evaluando NO se da por cumplida.
        cumple = false;
    }
    return { esperado: postura.esperado, porQue: postura.porQue, cumple };
}

/**
 * Registra sobre el gap la observación de un control y su veredicto de postura.
 * Muta `gap`. Devuelve `true` si se pudo observar (cumpla o no).
 *
 * @param {object} gap     ítem de `gaps[]`.
 * @param {*} json         payload parseado del comando (o `null`).
 * @param {string} perfil  identidad que ejecutó la lectura.
 * @param {string[]} args  args del comando, para publicar el reproductor.
 * @returns {boolean}
 */
function aplicarObservacion(gap, json, perfil, args) {
    const evidenciaCruda = observeGapControl(gap.key, json);
    if (!evidenciaCruda) return false; // El control sigue sin observarse.

    // La postura se evalúa sobre la evidencia CRUDA: la redacción enmascara
    // account id y UUID de clave, y comparar contra un valor enmascarado daría
    // un veredicto sobre un dato que ya no es el observado.
    const postura = evaluarPostura(gap.key, evidenciaCruda);

    gap.observadoCon = perfil;
    gap.evidencia = redactDeep(evidenciaCruda);
    gap.postura = postura;
    if (!postura) {
        gap.estado = 'observado-sin-postura';
    } else {
        gap.estado = postura.cumple ? 'observado-cumple' : 'observado-incumple';
    }
    // `true` SÓLO cuando se observó Y la observación satisface la postura.
    gap.verified = gap.estado === 'observado-cumple';
    if (gap.estado === 'observado-incumple') {
        // La remediación por defecto habla de permisos IAM, y acá el permiso
        // sobró: el problema es el recurso en AWS. Mandar a revisar la policy
        // sería mandar a arreglar lo que no está roto.
        gap.remediacion = `Postura INCUMPLIDA: se esperaba ${postura.esperado} y se observó `
            + `${JSON.stringify(gap.evidencia)}. No se destraba con permisos: hay que corregir `
            + 'el recurso en AWS (o revisar y actualizar la postura documentada si cambió).';
    } else if (gap.estado === 'observado-sin-postura') {
        gap.remediacion = 'Control observado pero SIN postura esperada declarada: no puede darse '
            + `por cumplido. Declarar la postura de "${gap.key}" en POSTURAS (kernel-table-verify.js).`;
    }
    if (Array.isArray(args)) {
        // El comando publicado tiene que ser el que REPRODUCE la evidencia.
        // Dejarlo con `--profile kernel-runtime` mandaría a quien audite a
        // correr algo que devuelve AccessDenied, y a concluir que la
        // evidencia es falsa.
        gap.comandoObservacion = redactAwsEvidence(`aws ${args.join(' ')} --profile ${perfil}`);
    }
    return true;
}

// -----------------------------------------------------------------------------
// #5207 (rebote rev-2) — Estados de un control y qué cuenta como pendiente
// -----------------------------------------------------------------------------

const ESTADOS_GAP = Object.freeze({
    NO_OBSERVADO: 'no-observado',
    SIN_LECTURA: 'observado-sin-lectura',
    CUMPLE: 'observado-cumple',
    INCUMPLE: 'observado-incumple',
    SIN_POSTURA: 'observado-sin-postura',
    DELEGADO: 'delegado',
});

// Estados que la segunda pasada (perfil admin) puede reintentar. Un control ya
// resuelto NO se relee: hacerlo podría pisar un incumplimiento ya detectado. Un
// `observado-sin-lectura` sí se reintenta —el runtime salió 0 pero sin el campo,
// y el admin puede traerlo completo—.
const ESTADOS_REINTENTABLES = Object.freeze([ESTADOS_GAP.NO_OBSERVADO, ESTADOS_GAP.SIN_LECTURA]);

/**
 * ¿Este control cuenta contra el cierre del CA-2?
 * Los DELEGADOS no: este módulo no puede cerrarlos ni tiene por qué bloquearlos.
 * Todo lo demás que no esté en `verified: true` sí — fail-closed sin cambios.
 */
function cuentaComoPendiente(gap) {
    return gap.estado !== ESTADOS_GAP.DELEGADO && gap.verified !== true;
}

function remediacionPorDeny(tipo) {
    if (tipo === 'explicitDeny') {
        return 'Deny explícito: agregar permisos NO alcanza; hay que editar esa policy con un principal con gestión IAM.';
    }
    if (tipo === 'implicitDeny') {
        return 'Falta un Allow: se destraba agregando el permiso read-only al perfil.';
    }
    return 'Sin clasificar: revisar el mensaje crudo antes de decidir remediación.';
}

/**
 * #5207 (rebote rev-2) — El comando salió 0 pero el output no trae el campo que
 * prueba el control. Antes esto quedaba indistinguible de "no pude leerlo", con
 * una remediación que mandaba a revisar permisos (que sobraron) y un mensaje
 * crudo que no existía. Sigue sin cerrar nada: `verified` no se toca.
 */
function marcarLecturaSinObservacion(gap, perfil) {
    gap.estado = ESTADOS_GAP.SIN_LECTURA;
    gap.observadoCon = null; // No se observó el control: sólo corrió el comando.
    // Qué identidad llegó a correr el comando. `gap.deny` sigue siendo el de la
    // sonda del runtime (evidencia del mínimo privilegio), que puede ser otra:
    // sin este campo, un `deny: implicitDeny` al lado de "corrió sin error" se
    // lee como una contradicción en vez de como dos identidades distintas.
    gap.corrioSinObservarCon = perfil;
    gap.remediacion = `El comando corrió sin error con \`${perfil}\` pero el output NO trae el campo `
        + 'que prueba el control. No es un gap de permisos: revisar el output crudo del comando '
        + 'publicado (o si la API cambió de forma) antes de decidir remediación. Un HTTP 200 no es '
        + 'una observación.';
}

/**
 * #5207 (rebote rev-2) — Gap de un control que prueba OTRA herramienta.
 * `verified: null` porque delegar no es declarar cumplido: el cierre lo da la
 * herramienta delegada, con su propio fusible.
 */
function construirGapDelegado(probe) {
    return {
        key: probe.key,
        control: probe.control,
        comando: probe.delegadoA.herramienta,
        deny: null,
        action: null,
        policy: null,
        verified: null,
        estado: ESTADOS_GAP.DELEGADO,
        postura: null,
        delegadoA: { ...probe.delegadoA },
        corrioSinObservarCon: null,
        remediacion: `Se prueba con \`${probe.delegadoA.herramienta}\`, no con este verificador. `
            + probe.delegadoA.porQue,
        detalle: null,
        observadoCon: null,
        evidencia: null,
    };
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
        // #5207 (rebote rev-2) — Un control DELEGADO no se sondea acá. Correrlo
        // para descartar el resultado publicaba un `deny: 'none'` con
        // remediación de permisos sobre un comando que había salido 200.
        if (probe.delegadoA) {
            gaps.push(construirGapDelegado(probe));
            continue;
        }
        let deny;
        let json = null;
        let comandoOk = false;
        try {
            const res = await runner.run(probe.args);
            if (res.code === 0) {
                deny = { type: 'none', action: null, policy: null, message: null };
                comandoOk = true;
                json = parseJsonSafe(res.stdout);
            } else {
                deny = classifyDeny(res.stderr);
            }
        } catch (e) {
            deny = { type: 'error', action: null, policy: null, message: redactAwsEvidence(String(e && e.message)) };
        }
        const gap = {
            key: probe.key,
            control: probe.control,
            comando: redactAwsEvidence(`aws ${probe.args.join(' ')} --profile ${runner.profile || DEFAULT_PROFILE}`),
            deny: deny.type,
            action: deny.action,
            policy: deny.policy,
            // `null` = NO OBSERVADO. Nunca `true` sin evidencia: el criterio
            // prohíbe declarar cumplido lo que no se pudo observar.
            verified: null,
            // #5207 — Estados posibles del control (ver ESTADOS_GAP):
            //   'no-observado'          → no se pudo leer (el gap clásico de #5210).
            //   'observado-sin-lectura' → el comando salió 0 pero el output no trae el campo.
            //   'observado-cumple'      → se leyó Y satisface la postura esperada.
            //   'observado-incumple'    → se leyó y NO la satisface. Esto NO cierra nada.
            //   'observado-sin-postura' → se leyó pero el control no declara postura.
            //   'delegado'              → lo prueba otra herramienta (no se computa acá).
            estado: 'no-observado',
            postura: null,
            delegadoA: null,
            corrioSinObservarCon: null,
            remediacion: remediacionPorDeny(deny.type),
            detalle: deny.message,
            // Se completan en la segunda pasada (#5207) si hay perfil admin.
            observadoCon: null,
            evidencia: null,
        };
        // Si el propio runtime pudo leer el control (no hubo deny), la evidencia
        // se evalúa acá mismo: un comando que salió 200 no deja el control en un
        // limbo "salió bien pero no sé qué dijo".
        const observado = json ? aplicarObservacion(gap, json, runner.profile || DEFAULT_PROFILE, probe.args) : false;
        if (!observado && comandoOk) marcarLecturaSinObservacion(gap, runner.profile || DEFAULT_PROFILE);
        gaps.push(gap);
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
            // Si el runtime ya resolvió el control, ese veredicto manda: leerlo
            // de nuevo con otra identidad no cambiaría el valor y sí podría pisar
            // un incumplimiento ya detectado. Un control DELEGADO tampoco se
            // sondea acá: lo cierra su propia herramienta (#5207 rebote rev-2).
            if (!ESTADOS_REINTENTABLES.includes(gap.estado)) continue;
            let json = null;
            let comandoOk = false;
            try {
                const res = await adminRunner.run(probe.args);
                comandoOk = res.code === 0;
                json = comandoOk ? parseJsonSafe(res.stdout) : null;
            } catch (_) {
                json = null; // No poder observar sigue siendo "no sé", no un fallo.
            }
            const perfilAdminUsado = adminRunner.profile || adminProfile;
            const observado = aplicarObservacion(gap, json, perfilAdminUsado, probe.args);
            // Si el admin corrió OK y aun así no se pudo leer el control, eso es
            // "salió 200 sin el dato" — distinto de un AccessDenied. Si denegó,
            // el gap se queda con el estado que ya traía: no se degrada un
            // `observado-sin-lectura` del runtime a `no-observado`.
            if (!observado && comandoOk) marcarLecturaSinObservacion(gap, perfilAdminUsado);
        }
    }

    // #5207 (rebote rev-2) — Los controles DELEGADOS quedan fuera del cómputo:
    // no se pueden cerrar acá, así que contarlos como pendientes hacía que
    // `ca2Cerrado` fuera `false` por construcción, incluso con todo en verde.
    const delegados = gaps.filter((g) => g.estado === ESTADOS_GAP.DELEGADO);
    const gapsPendientes = gaps.filter(cuentaComoPendiente);
    const incumplidos = gaps.filter((g) => g.estado === ESTADOS_GAP.INCUMPLE);

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
        // #5207 — Cuántos controles del gap NO quedaron cerrados: los que no se
        // pudieron observar MÁS los que se observaron y no cumplen la postura.
        // NO incluye los delegados: ésos los cierra otra herramienta (rev-2).
        gapsPendientes: gapsPendientes.length,
        // #5207 (rebote rev-2) — Controles que este verificador NO resuelve por
        // diseño. Se publican para que el operador sepa que faltan pruebas, y
        // con qué herramienta se obtienen. No son un verde ni un pendiente.
        controlesDelegados: delegados.map((g) => ({
            key: g.key,
            control: g.control,
            herramienta: g.delegadoA.herramienta,
            porQue: g.delegadoA.porQue,
        })),
        // #5207 (rebote rev-1) — Contador propio para el caso que antes se
        // escondía: controles LEÍDOS cuyo valor INCUMPLE la postura esperada.
        // Un ambiente que falla el CA-2 tiene que gritarlo desde el JSON, no
        // quedar disuelto en un `gapsPendientes` bajo.
        posturasIncumplidas: incumplidos.length,
        // El CA-2 sólo cierra si lo verificable da OK, no quedan controles sin
        // observar y ninguno de los observados incumple su postura.
        ca2Cerrado: tables.length === 2
            && tables.every((t) => t.verified === true)
            && gapsPendientes.length === 0,
        // Recordatorio embebido en el propio artefacto: quien lea el JSON no
        // necesita leer el issue para saber que los gaps no son aprobaciones.
        nota: 'Los ítems de `gaps` con `verified: null` NO se pudieron observar y los que tienen '
            + '`verified: false` se observaron pero INCUMPLEN la postura esperada (`postura.esperado`). '
            + 'Ninguno de los dos puede declararse cumplido (#5210 CA-3, #5207 CA-2). Sólo los '
            + '`verified: true` están cerrados: traen el output en `evidencia`, la identidad que lo '
            + 'leyó en `observadoCon` y la postura que satisface en `postura`. Los que tienen '
            + '`estado: "delegado"` NO se prueban acá y tampoco se dan por cumplidos: su evidencia '
            + 'la produce la herramienta indicada en `delegadoA.herramienta`.',
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
        // #5207 (rebote rev-1) — Segunda mitad del fusible: tener la evidencia no
        // alcanza, la evidencia tiene que CUMPLIR la postura esperada. Sin esto,
        // un PITR `DISABLED` en la tabla de no-repudio salía como control
        // demostrado sólo por haber sido leído. Fail-closed: un `true` sin
        // postura declarada tampoco pasa.
        if (g.verified === true && !(g.postura && g.postura.cumple === true)) {
            const observado = g.evidencia ? JSON.stringify(g.evidencia) : 'sin evidencia';
            throw new Error(
                `kernel-table-verify: el control "${g.control}" está marcado como verificado pero su `
                + `evidencia no satisface la postura esperada (esperado: ${(g.postura && g.postura.esperado) || 'NO DECLARADA'}; `
                + `observado: ${observado}). Observar un control no es demostrarlo (#5207 CA-2).`,
            );
        }
        // #5207 (rebote rev-2) — Un control DELEGADO no puede cerrarse acá bajo
        // ninguna forma: su prueba vive en otra herramienta y este módulo no la
        // corrió. Delegar es sacarlo del cómputo, no darlo por bueno.
        if (g.estado === ESTADOS_GAP.DELEGADO && g.verified !== null) {
            throw new Error(
                `kernel-table-verify: el control "${g.control}" está delegado a `
                + `\`${(g.delegadoA && g.delegadoA.herramienta) || 'otra herramienta'}\` y no puede llevar `
                + `veredicto acá (verified: ${JSON.stringify(g.verified)}). El cierre lo da esa herramienta (#5207 CA-2).`,
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
    // #5207 — Los controles observados salen de la tabla de gaps y pasan a una
    // tabla propia, con el output que los respalda. #5207 (rebote rev-1): sólo
    // los que además CUMPLEN su postura; los que no, tienen sección propia.
    const evidencia = (g) => Object.entries(g.evidencia || {})
        .map(([k, v]) => `${k}=\`${v}\``).join(' · ') || '—';
    const cerrados = report.gaps.filter((g) => g.verified === true);
    const incumplen = report.gaps.filter((g) => g.estado === ESTADOS_GAP.INCUMPLE
        || g.estado === ESTADOS_GAP.SIN_POSTURA);
    const delegados = report.gaps.filter((g) => g.estado === ESTADOS_GAP.DELEGADO);
    // #5207 (rebote rev-2) — Los delegados NO entran acá: la leyenda de esta
    // tabla ("ningún control está verificado") no puede aplicarse a un control
    // que se verifica en otro lado.
    const noObservados = report.gaps.filter((g) => g.verified !== true
        && !incumplen.includes(g) && !delegados.includes(g));

    if (cerrados.length) {
        l.push('');
        l.push('### Verificado con el perfil admin de sólo lectura (CA-2 · #5207)');
        l.push('');
        l.push(`> Leído con \`${report.perfilAdmin}\`, NO con el runtime. El runtime sigue sin poder verlo`);
        l.push('> —ese `AccessDenied` es la evidencia del mínimo privilegio—. Cada fila trae la postura');
        l.push('> esperada del control y el valor observado que la satisface: sin esas dos cosas juntas');
        l.push('> el control NO figura acá.');
        l.push('');
        l.push('| Control | Postura esperada | Observado | Comando |');
        l.push('|---|---|---|---|');
        for (const g of cerrados) {
            const esperado = (g.postura && g.postura.esperado) || '—';
            l.push(`| ${g.control} | ${esperado} | ${evidencia(g)} | \`${g.comandoObservacion || g.comando}\` |`);
        }
    }

    // #5207 (rebote rev-1) — Un control leído cuyo valor NO cumple la postura es
    // un DEFECTO del ambiente, no un gap de permisos. Antes caía en la tabla de
    // verificados y el artefacto lo rotulaba como demostrado.
    if (incumplen.length) {
        l.push('');
        l.push('### Observado e INCUMPLE la postura esperada — el CA-2 NO cierra');
        l.push('');
        l.push('> Estos controles SÍ se pudieron leer, y lo que se leyó no cumple. No es un gap de');
        l.push('> permisos: agregar `Allow` no cambia nada. Hay que corregir el recurso en AWS (o');
        l.push('> revisar la postura documentada, si es ella la que cambió).');
        l.push('');
        l.push('| Control | Postura esperada | Observado | Por qué importa |');
        l.push('|---|---|---|---|');
        for (const g of incumplen) {
            const p = g.postura || {};
            l.push(`| ${g.control} | ${p.esperado || 'NO DECLARADA'} | ${evidencia(g)} `
                + `| ${p.porQue || 'Control sin postura declarada: no puede darse por cumplido.'} |`);
        }
    }

    // #5207 (rebote rev-2) — Los controles que prueba OTRA herramienta salen de
    // la tabla de gaps: no son "no pude leerlo", son "no me toca cerrarlo acá".
    if (delegados.length) {
        l.push('');
        l.push('### Delegado a otra herramienta — no se cierra ni se bloquea acá (CA-2 · #5207)');
        l.push('');
        l.push('> Estos controles SÍ se prueban, pero con la herramienta de la columna del medio.');
        l.push('> Este verificador no los observa a propósito, así que no cuentan como gap de');
        l.push('> observación ni pesan sobre `ca2Cerrado`. Su cierre se lee en el reporte de esa');
        l.push('> herramienta, que trae su propio fusible.');
        l.push('');
        l.push('| Control | Se prueba con | Por qué no acá |');
        l.push('|---|---|---|');
        for (const g of delegados) {
            const d = g.delegadoA || {};
            l.push(`| ${g.control} | \`${d.herramienta || '—'}\` | ${d.porQue || '—'} |`);
        }
    }

    l.push('');
    l.push('### Gap de verificación — NO verificado (CA-3)');
    l.push('');
    if (!noObservados.length) {
        l.push('> Sin gaps de observación: todos los controles que se resuelven acá pudieron leerse.');
    } else {
        l.push('| Control | Comando | Qué pasó | Tipo de deny | Se destraba con permisos |');
        l.push('|---|---|---|---|---|');
        for (const g of noObservados) {
            const destrababa = g.deny === 'explicitDeny' ? 'NO (Deny explícito)' : (g.deny === 'implicitDeny' ? 'sí (falta Allow)' : '—');
            // La distinción importa: "no pude correrlo" y "corrió pero el output
            // no traía el campo" mandan a lugares distintos a quien remedia.
            const quePaso = g.estado === ESTADOS_GAP.SIN_LECTURA
                ? `el comando salió 0 con \`${g.corrioSinObservarCon}\`, pero el output no trae el campo del control`
                : 'no se pudo leer el control';
            // El `deny` es siempre el de la sonda del runtime: si otra identidad
            // llegó a correr el comando, la columna de al lado lo dice.
            l.push(`| ${g.control} | \`${g.comando}\` | ${quePaso} | \`${g.deny}\` (runtime) | ${destrababa} |`);
        }
        l.push('');
        l.push('> Ningún control de esta tabla está verificado. No pueden declararse cumplidos.');
    }

    // Cierre explícito: el lector no tiene que sumar filas para saber si el CA-2
    // quedó cerrado. Es el número que el rechazo rev-1 encontró desalineado.
    l.push('');
    if (report.ca2Cerrado) {
        l.push('**CA-2 cerrado:** los dos `describe-table` dan OK y los controles del gap fueron');
        l.push('observados cumpliendo su postura esperada.');
        if (delegados.length) {
            // El cierre no se declara total: lo delegado sigue debiendo su prueba,
            // sólo que en otro reporte. Callarlo lo volvería un verde encubierto.
            l.push('');
            l.push(`> Queda(n) ${delegados.length} control(es) delegado(s) a otra herramienta `
                + `(${delegados.map((g) => g.control).join(', ')}). Este verificador no los cierra: `
                + 'su evidencia se lee en el reporte de esa herramienta.');
        }
    } else {
        const partes = [];
        if (report.posturasIncumplidas) partes.push(`${report.posturasIncumplidas} control(es) INCUMPLEN su postura`);
        if (noObservados.length) partes.push(`${noObservados.length} sin observar`);
        if (!report.verificable) partes.push('el `describe-table` de alguna tabla no da OK');
        l.push(`**CA-2 NO cerrado:** ${partes.join(', ') || 'quedan controles pendientes'}.`);
    }
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
    ESTADOS_GAP,
    CONTROLES_DELEGADOS,
    cuentaComoPendiente,
    POSTURAS,
    evaluarPostura,
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
            // Exit 1 si lo verificable NO da OK. Los gaps de OBSERVACIÓN no
            // cambian el exit code: no poder observar un control no es una falla
            // del control. Pero un control observado que INCUMPLE su postura sí
            // lo es —#5207 rebote rev-1— y no puede salir 0: ese exit code
            // termina en un gate y se lee como "el ambiente cumple".
            process.exitCode = (report.verificable && !report.posturasIncumplidas) ? 0 : 1;
        })
        .catch((e) => {
            process.stderr.write(`kernel-table-verify: ${redactAwsEvidence(String(e && e.message))}\n`);
            process.exitCode = 2;
        });
}

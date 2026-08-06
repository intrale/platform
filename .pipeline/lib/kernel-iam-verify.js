'use strict';

// =============================================================================
// kernel-iam-verify.js — Matriz empírica Allow/AccessDenied del principal
// runtime del kernel (#5211 · CA-2 / CA-3)
//
// CONTEXTO
// --------
// #5124 dejó la policy de datos escrita y testeada COMO DATO (el JSON dice lo
// que tiene que decir). Lo que ese test no puede probar es lo único que importa
// en producción: que **AWS efectivamente la esté aplicando** sobre el principal
// real. Un JSON correcto en el repo y una policy distinta adjunta al usuario es
// un estado perfectamente posible y completamente silencioso.
//
// Este módulo cierra ese hueco: ejecuta la matriz contra AWS con el principal
// runtime y clasifica cada resultado. Es el complemento empírico de
// `kernel-iam-policy.test.js`, no su reemplazo.
//
// LA REGLA DE ORO: NINGÚN PROBE PUEDE MUTAR NADA
// -----------------------------------------------
// Probar un `Deny` exige **intentar** la operación denegada. Si el `Deny` está
// bien, no pasa nada. El problema es el caso contrario: si el `Deny` regresó, el
// probe se ejecuta de verdad — y un probe de `DeleteItem` sobre la tabla de
// no-repudio borraría evidencia real. El verificador NO puede ser el vector del
// daño que busca detectar.
//
// La salida es que **todo probe mutante viaja con una `ConditionExpression`
// imposible** (`attribute_exists(PK)` sobre una clave canario que nunca existe).
// IAM evalúa la autorización ANTES que la condición, así que:
//
//   - `AccessDeniedException`        ⇒ el `Deny` está aplicado (lo que se busca).
//   - `ConditionalCheckFailedException` ⇒ la operación estaba AUTORIZADA y la
//     condición la frenó: hallazgo real, y aun así no se escribió nada.
//
// Las dos ramas son informativas y ninguna muta. Verificado a mano contra AWS
// antes de codificarlo (ver docs/pipeline/kernel-iam-matriz-5211.md, probe G).
//
// PROBES DE CONTROL PLANE: DECLARADOS, NO EJECUTADOS
// ---------------------------------------------------
// `DeleteTable`, `UpdateTable`, `UpdateContinuousBackups`, `ScheduleKeyDeletion`
// y `AttachUserPolicy` no admiten una condición que los vuelva inocuos: si el
// `Deny` regresó, se ejecutan y el daño es irreversible (tabla borrada, PITR
// apagado, escalada de privilegio). Por eso viven en `CONTROL_PLANE_PROBES` con
// `runnable: false` y evidencia manual fechada: se corren UNA vez, a mano, con
// el operador presente. Aparecen en el reporte como `manual` — nunca se omiten
// en silencio, que sería leerse como "cubierto".
// =============================================================================

const {
    redactAwsEvidence,
    classifyDeny,
    readKernelTablesConfig,
    DEFAULT_PROFILE,
} = require('./kernel-table-verify');

// -----------------------------------------------------------------------------
// Canario: una clave que NUNCA debe existir en ninguna de las dos tablas.
// -----------------------------------------------------------------------------

// El PK respeta `^[a-z0-9][a-z0-9-]{1,63}$` (contracts/kernel-store.schema.json):
// si algún día un probe se ejecutara de verdad, el ítem seguiría siendo válido
// para `validateItemOnRead` y no rompería un lector.
const CANARY_PK = 'canary-5211-verify';
const CANARY_SK = 'probe';

const CANARY_KEY = JSON.stringify({
    PK: { S: CANARY_PK },
    SK: { S: CANARY_SK },
});

// Condición imposible: la clave canario no existe, así que ninguna mutación
// puede aterrizar aunque IAM la autorice.
const IMPOSSIBLE_CONDITION = 'attribute_exists(PK)';

// -----------------------------------------------------------------------------
// Clasificación del resultado de un probe
// -----------------------------------------------------------------------------

const OUTCOME = Object.freeze({
    ALLOWED: 'allowed',
    CONDITION_FAILED: 'conditionFailed',
    EXPLICIT_DENY: 'explicitDeny',
    IMPLICIT_DENY: 'implicitDeny',
    ACCESS_DENIED: 'accessDenied',
    ERROR: 'error',
});

// Un `Deny` explícito gana sobre cualquier `Allow` futuro; uno implícito se
// deshace con agregar un `Allow` por error. Los dos satisfacen "está denegado
// hoy", pero sólo el explícito sobrevive a un cambio descuidado — por eso el
// reporte los distingue en vez de colapsarlos en un booleano.
const DENY_OUTCOMES = Object.freeze([
    OUTCOME.EXPLICIT_DENY,
    OUTCOME.IMPLICIT_DENY,
    OUTCOME.ACCESS_DENIED,
]);

/**
 * Clasifica el resultado crudo de un probe del AWS CLI.
 *
 * `conditionFailed` es una AUTORIZACIÓN concedida: la condición imposible fue lo
 * único que frenó la operación. Para un probe que espera `deny` eso es un
 * hallazgo, no un éxito.
 *
 * @param {{code:number, stdout:string, stderr:string}} res
 * @returns {{outcome:string, action:(string|null), policy:(string|null), message:(string|null)}}
 */
function classifyProbe(res) {
    const code = res && typeof res.code === 'number' ? res.code : 0;
    const stderr = (res && typeof res.stderr === 'string') ? res.stderr : '';

    if (code === 0 && !/Exception|error occurred/i.test(stderr)) {
        return { outcome: OUTCOME.ALLOWED, action: null, policy: null, message: null };
    }

    if (/ConditionalCheckFailedException/i.test(stderr)) {
        return {
            outcome: OUTCOME.CONDITION_FAILED,
            action: null,
            policy: null,
            message: redactAwsEvidence(stderr.trim()),
        };
    }

    const deny = classifyDeny(stderr);
    if (deny.type === 'explicitDeny') {
        return {
            outcome: OUTCOME.EXPLICIT_DENY, action: deny.action, policy: deny.policy, message: deny.message,
        };
    }
    if (deny.type === 'implicitDeny') {
        return {
            outcome: OUTCOME.IMPLICIT_DENY, action: deny.action, policy: null, message: deny.message,
        };
    }
    if (deny.type === 'accessDenied') {
        return {
            outcome: OUTCOME.ACCESS_DENIED, action: deny.action, policy: null, message: deny.message,
        };
    }
    return {
        outcome: OUTCOME.ERROR, action: null, policy: null, message: redactAwsEvidence(stderr.trim()),
    };
}

/**
 * ¿El resultado observado satisface lo que el probe esperaba?
 *
 * @param {'allow'|'deny'} expected
 * @param {string} outcome
 * @returns {boolean}
 */
function matchesExpectation(expected, outcome) {
    if (expected === 'deny') return DENY_OUTCOMES.includes(outcome);
    // `allow`: tanto la ejecución limpia como el freno por condición imposible
    // prueban que la autorización estaba concedida.
    if (expected === 'allow') {
        return outcome === OUTCOME.ALLOWED || outcome === OUTCOME.CONDITION_FAILED;
    }
    return false;
}

// -----------------------------------------------------------------------------
// Config de la matriz: TODO nombre de infra viene de config, sin fallback
// -----------------------------------------------------------------------------

/**
 * Lee la config que necesita la matriz IAM: las dos tablas (vía
 * `readKernelTablesConfig`) MÁS el alias de la CMK y el principal runtime.
 *
 * Fail-closed igual que el módulo hermano: un nombre de infra que no está en
 * config NO se completa con un literal. Un default silencioso apuntaría el probe
 * a un recurso que puede no existir, y un `AccessDenied` por recurso inexistente
 * se lee idéntico a un `Deny` aplicado — la matriz reportaría ✅ sobre un control
 * que nunca se probó.
 *
 * @param {object} [opts]
 * @param {object} [opts.kernelConfig]  override inyectable (tests).
 * @param {string} [opts.configPath]
 * @returns {{tableName:string, coordinationTableName:string, region:string,
 *            durable:boolean, cmkAlias:string, runtimePrincipal:string}}
 * @throws {Error} fail-closed si falta `kernel.cmkAlias` o `kernel.runtimePrincipal`.
 */
function readKernelIamConfig(opts = {}) {
    const base = readKernelTablesConfig(opts);

    let kernel = opts.kernelConfig;
    if (!kernel) {
        // Mismo punto único de lectura que `readKernelTablesConfig` (#5172).
        // eslint-disable-next-line global-require
        const configResolver = require('./config-resolver');
        const doc = configResolver.resolve(
            opts.configPath ? { configPath: opts.configPath } : {},
        ) || {};
        kernel = (doc && typeof doc.kernel === 'object' && doc.kernel) || {};
    }

    const str = (v) => (typeof v === 'string' ? v.trim() : '');
    const cmkAlias = str(kernel.cmkAlias);
    const runtimePrincipal = str(kernel.runtimePrincipal);

    const faltantes = [];
    if (!cmkAlias) faltantes.push('kernel.cmkAlias');
    if (!runtimePrincipal) faltantes.push('kernel.runtimePrincipal');
    if (faltantes.length) {
        throw new Error(
            `kernel-iam-verify: faltan claves de config (${faltantes.join(', ')}). `
            + 'Fail-closed: el alias de la CMK y el principal runtime NUNCA se hardcodean, '
            + 'se definen en .pipeline/config.yaml (sección kernel:). Un default silencioso '
            + 'apuntaría el probe a otro recurso y su AccessDenied se leería como control verificado.',
        );
    }

    return { ...base, cmkAlias, runtimePrincipal };
}

// -----------------------------------------------------------------------------
// La matriz de probes ejecutables (sin hardcode: los nombres vienen de config)
// -----------------------------------------------------------------------------

/**
 * Construye la matriz de probes ejecutables para las dos tablas del kernel.
 *
 * @param {{tableName:string, coordinationTableName:string, region:string,
 *          cmkAlias:string, runtimePrincipal:string}} cfg
 * @returns {Array<{id:string, ca:string, expect:'allow'|'deny', descripcion:string, args:string[]}>}
 * @throws {Error} fail-closed si falta cualquier nombre de infra.
 */
function buildProbeMatrix(cfg) {
    // Sin `||` de cortesía: un probe apuntado al recurso equivocado devuelve
    // AccessDenied por "no existe" y la matriz lo cuenta como Deny aplicado.
    const requerido = (valor, clave) => {
        const v = typeof valor === 'string' ? valor.trim() : '';
        if (!v) {
            throw new Error(
                `kernel-iam-verify: buildProbeMatrix requiere "${clave}" y llegó vacío. `
                + 'Fail-closed: los nombres de infra vienen de config (kernel:), no de un default.',
            );
        }
        return v;
    };

    const nr = requerido(cfg && cfg.tableName, 'tableName');
    const coord = requerido(cfg && cfg.coordinationTableName, 'coordinationTableName');
    const cmkAlias = requerido(cfg && cfg.cmkAlias, 'cmkAlias');
    const runtimePrincipal = requerido(cfg && cfg.runtimePrincipal, 'runtimePrincipal');

    return [
        // --- CA-2: la coordinación DEBE responder Allow --------------------------
        {
            id: 'coord-get-item',
            ca: 'CA-2',
            expect: 'allow',
            descripcion: 'lectura de coordinación (claims de fase)',
            args: ['dynamodb', 'get-item', '--table-name', coord, '--key', CANARY_KEY],
        },
        {
            id: 'coord-put-item',
            ca: 'CA-2',
            expect: 'allow',
            descripcion: 'toma de claim (PutItem condicional)',
            args: ['dynamodb', 'put-item', '--table-name', coord,
                '--item', CANARY_KEY, '--condition-expression', IMPOSSIBLE_CONDITION],
        },
        {
            id: 'coord-delete-item',
            ca: 'CA-2',
            expect: 'allow',
            descripcion: 'release de claim (DeleteItem acotado a coordinación)',
            args: ['dynamodb', 'delete-item', '--table-name', coord,
                '--key', CANARY_KEY, '--condition-expression', IMPOSSIBLE_CONDITION],
        },

        // --- CA-2: no-repudio permite leer y crear, jamás mutar ------------------
        {
            id: 'nonrepudio-get-item',
            ca: 'CA-2',
            expect: 'allow',
            descripcion: 'lectura de no-repudio (descifrado por CMK vía servicio)',
            args: ['dynamodb', 'get-item', '--table-name', nr, '--key', CANARY_KEY],
        },
        {
            id: 'nonrepudio-put-item',
            ca: 'CA-2',
            expect: 'allow',
            descripcion: 'append de firma/audit (PutItem: el runtime SÍ escribe evidencia)',
            args: ['dynamodb', 'put-item', '--table-name', nr,
                '--item', CANARY_KEY, '--condition-expression', IMPOSSIBLE_CONDITION],
        },
        {
            id: 'nonrepudio-update-item',
            ca: 'CA-2',
            expect: 'deny',
            descripcion: 'mutación de evidencia vía UpdateItem',
            args: ['dynamodb', 'update-item', '--table-name', nr, '--key', CANARY_KEY,
                '--update-expression', 'SET probe = :v',
                '--expression-attribute-values', '{":v":{"S":"x"}}',
                '--condition-expression', IMPOSSIBLE_CONDITION],
        },
        {
            id: 'nonrepudio-delete-item',
            ca: 'CA-2',
            expect: 'deny',
            descripcion: 'borrado de evidencia vía DeleteItem',
            args: ['dynamodb', 'delete-item', '--table-name', nr, '--key', CANARY_KEY,
                '--condition-expression', IMPOSSIBLE_CONDITION],
        },
        {
            id: 'nonrepudio-batch-write-item',
            ca: 'CA-2',
            expect: 'deny',
            descripcion: 'borrado de evidencia vía BatchWriteItem (no admite condición)',
            args: ['dynamodb', 'batch-write-item', '--request-items',
                JSON.stringify({
                    [nr]: [{ DeleteRequest: { Key: { PK: { S: CANARY_PK }, SK: { S: CANARY_SK } } } }],
                })],
        },
        {
            id: 'nonrepudio-transact-write-items',
            ca: 'CA-2',
            expect: 'deny',
            descripcion: 'borrado de evidencia vía TransactWriteItems',
            args: ['dynamodb', 'transact-write-items', '--transact-items',
                JSON.stringify([{
                    Delete: {
                        TableName: nr,
                        Key: { PK: { S: CANARY_PK }, SK: { S: CANARY_SK } },
                        ConditionExpression: IMPOSSIBLE_CONDITION,
                    },
                }])],
        },
        {
            id: 'nonrepudio-partiql-delete',
            ca: 'CA-2',
            expect: 'deny',
            descripcion: 'borrado de evidencia vía PartiQL',
            args: ['dynamodb', 'execute-statement', '--statement',
                `DELETE FROM "${nr}" WHERE PK='${CANARY_PK}' AND SK='${CANARY_SK}'`],
        },

        // --- CA-3: el runtime no administra nada --------------------------------
        {
            id: 'ddb-list-tables',
            ca: 'CA-3',
            expect: 'deny',
            descripcion: 'enumeración de tablas de la cuenta',
            args: ['dynamodb', 'list-tables'],
        },
        {
            id: 'kms-describe-key',
            ca: 'CA-3',
            expect: 'deny',
            descripcion: 'uso directo de la CMK fuera de DynamoDB (kms:ViaService)',
            args: ['kms', 'describe-key', '--key-id', `alias/${cmkAlias}`],
        },
        {
            id: 'iam-list-attached-user-policies',
            ca: 'CA-3',
            expect: 'deny',
            descripcion: 'lectura de su propia policy (reconocimiento previo a escalada)',
            args: ['iam', 'list-attached-user-policies', '--user-name', runtimePrincipal],
        },
    ];
}

// -----------------------------------------------------------------------------
// Probes de control plane: declarados con evidencia manual, NUNCA ejecutados
// -----------------------------------------------------------------------------

// Cada entrada lleva el resultado observado a mano y la fecha. No se ejecutan
// porque no hay condición que los vuelva reversibles: si el `Deny` regresó, el
// probe ES el incidente.
//
// EL ESTADO OBSERVADO ES `implicitDeny` EN LOS SIETE. No es un descuido: los tres
// statements Deny de control plane (`DenyDynamoDbControlPlane`,
// `DenyDynamoDbAccountLevelControlPlane`, `DenyKmsAdministration`,
// `DenyIamSelfAdministration`) son entregable NUEVO de #5211 y todavía **no están
// aplicados** sobre `policy/IntraleKernelStore` — aplicarlos requiere un principal
// con gestión IAM que el perfil disponible no tiene, a propósito. La policy que
// AWS evalúa hoy es la de `origin/main`: `RuntimeReadWrite`,
// `DenyMutateNonRepudiation` y `CoordinationReadWrite`, y ninguna alcanza el
// control plane.
//
// Por eso cada entrada declara además `explicitoTrasAplicar`: el Sid que va a
// convertir esa fila en `explicitDeny` cuando el operador aplique el artefacto.
// Afirmar hoy el explicitDeny sería exactamente el defecto que #5211 vino a
// matar: evidencia que dice más de lo que el estado real respalda.
const CONTROL_PLANE_PROBES = Object.freeze([
    {
        id: 'ddb-create-table',
        ca: 'CA-3',
        runnable: false,
        descripcion: 'crear tabla nueva en la cuenta',
        evidenciaManual: 'implicitDeny · dynamodb:CreateTable',
        explicitoTrasAplicar: 'DenyDynamoDbControlPlane',
        fecha: '2026-08-06',
    },
    {
        id: 'ddb-delete-table',
        ca: 'CA-3',
        runnable: false,
        descripcion: 'borrar la tabla de no-repudio entera',
        evidenciaManual: 'implicitDeny · dynamodb:DeleteTable',
        explicitoTrasAplicar: 'DenyDynamoDbControlPlane',
        fecha: '2026-08-06',
    },
    {
        id: 'ddb-update-table',
        ca: 'CA-3',
        runnable: false,
        descripcion: 'apagar deletion protection',
        evidenciaManual: 'implicitDeny · dynamodb:UpdateTable',
        explicitoTrasAplicar: 'DenyDynamoDbControlPlane',
        fecha: '2026-08-06',
    },
    {
        id: 'ddb-update-continuous-backups',
        ca: 'CA-3',
        runnable: false,
        descripcion: 'apagar PITR',
        evidenciaManual: 'implicitDeny · dynamodb:UpdateContinuousBackups',
        explicitoTrasAplicar: 'DenyDynamoDbControlPlane',
        fecha: '2026-08-06',
    },
    {
        id: 'kms-schedule-key-deletion',
        ca: 'CA-3',
        runnable: false,
        descripcion: 'programar borrado de la CMK (haría ilegible toda la evidencia)',
        evidenciaManual: 'implicitDeny · kms:ScheduleKeyDeletion',
        explicitoTrasAplicar: 'DenyKmsAdministration',
        fecha: '2026-08-06',
    },
    {
        id: 'kms-disable-key',
        ca: 'CA-3',
        runnable: false,
        descripcion: 'deshabilitar la CMK',
        evidenciaManual: 'implicitDeny · kms:DisableKey',
        explicitoTrasAplicar: 'DenyKmsAdministration',
        fecha: '2026-08-06',
    },
    {
        id: 'iam-attach-user-policy',
        ca: 'CA-3',
        runnable: false,
        descripcion: 'auto-adjuntarse AdministratorAccess (escalada de privilegio)',
        evidenciaManual: 'implicitDeny · iam:AttachUserPolicy',
        explicitoTrasAplicar: 'DenyIamSelfAdministration',
        fecha: '2026-08-06',
    },
]);

// -----------------------------------------------------------------------------
// Runner: SIN shell, args como array, profile explícito
// -----------------------------------------------------------------------------

/**
 * Crea el runner del AWS CLI para la matriz.
 *
 * A diferencia de `createReadOnlyAwsRunner` (kernel-table-verify), acá SÍ se
 * emiten verbos mutantes: probar un `Deny` exige intentarlo. La contención no es
 * una allowlist de verbos sino la condición imposible que lleva cada probe.
 *
 * @param {{profile?:string, region?:string, spawn?:Function}} [opts]
 */
function createProbeRunner(opts = {}) {
    const profile = typeof opts.profile === 'string' && opts.profile ? opts.profile : DEFAULT_PROFILE;
    const region = typeof opts.region === 'string' ? opts.region : '';
    const spawn = typeof opts.spawn === 'function'
        // eslint-disable-next-line global-require
        ? opts.spawn : require('child_process').spawn;

    return {
        profile,
        run(args) {
            const list = Array.isArray(args) ? args.map(String) : [];
            const full = [...list, '--profile', profile, '--output', 'json'];
            if (region) full.push('--region', region);
            return new Promise((resolve, reject) => {
                // shell:false — args como array, jamás interpolación (A03).
                const child = spawn('aws', full, { shell: false });
                let stdout = '';
                let stderr = '';
                if (child.stdout) child.stdout.on('data', (d) => { stdout += d; });
                if (child.stderr) child.stderr.on('data', (d) => { stderr += d; });
                child.on('error', reject);
                child.on('close', (code) => resolve({
                    code: typeof code === 'number' ? code : 0, stdout, stderr,
                }));
            });
        },
    };
}

// -----------------------------------------------------------------------------
// Ejecución de la matriz
// -----------------------------------------------------------------------------

/**
 * Corre la matriz completa y devuelve el reporte redactado.
 *
 * @param {object} [opts]
 * @param {string} [opts.profile]  perfil AWS del principal runtime.
 * @param {object} [opts.kernelConfig]  override de config (tests).
 * @param {object} [opts.runner]  override del runner (tests).
 * @returns {Promise<object>} reporte con `probes[]`, `controlPlane[]` y `ok`.
 */
async function verifyKernelIam(opts = {}) {
    const cfg = readKernelIamConfig(opts);
    const runner = opts.runner || createProbeRunner({
        profile: opts.profile, region: cfg.region, spawn: opts.spawn,
    });

    const matrix = buildProbeMatrix({ ...cfg, ...(opts.extras || {}) });
    const probes = [];

    for (const probe of matrix) {
        let res;
        try {
            // eslint-disable-next-line no-await-in-loop
            res = await runner.run(probe.args);
        } catch (e) {
            res = { code: 1, stdout: '', stderr: (e && e.message) || String(e) };
        }
        const clasificado = classifyProbe(res);
        probes.push({
            id: probe.id,
            ca: probe.ca,
            descripcion: probe.descripcion,
            expect: probe.expect,
            outcome: clasificado.outcome,
            action: clasificado.action,
            policy: clasificado.policy,
            ok: matchesExpectation(probe.expect, clasificado.outcome),
            evidencia: clasificado.message,
        });
    }

    const fallidos = probes.filter((p) => !p.ok);
    return {
        profile: runner.profile,
        region: cfg.region,
        probes,
        controlPlane: CONTROL_PLANE_PROBES.map((p) => ({ ...p })),
        resumen: {
            total: probes.length,
            ok: probes.length - fallidos.length,
            fallidos: fallidos.length,
            manuales: CONTROL_PLANE_PROBES.length,
        },
        ok: fallidos.length === 0,
    };
}

// -----------------------------------------------------------------------------
// Render
// -----------------------------------------------------------------------------

/**
 * Render markdown del reporte. Los probes manuales salen SIEMPRE, marcados como
 * tales: omitirlos haría leer la matriz como más completa de lo que es.
 *
 * @param {object} report
 * @returns {string}
 */
function renderMarkdown(report) {
    const L = [];
    L.push('# Matriz IAM/KMS del runtime del kernel (#5211)');
    L.push('');
    L.push(`- Perfil: \`${report.profile}\` · Región: \`${report.region}\``);
    L.push(`- Probes ejecutados: ${report.resumen.ok}/${report.resumen.total} OK`);
    L.push(`- Probes manuales (control plane, no ejecutables): ${report.resumen.manuales}`);
    L.push('');
    L.push('## Probes ejecutados');
    L.push('');
    L.push('| Probe | CA | Espera | Resultado | OK |');
    L.push('|---|---|---|---|---|');
    for (const p of report.probes) {
        L.push(`| \`${p.id}\` — ${p.descripcion} | ${p.ca} | ${p.expect} | ${p.outcome} | ${p.ok ? '✅' : '❌'} |`);
    }
    L.push('');
    L.push('## Probes de control plane (evidencia manual — NO se ejecutan)');
    L.push('');
    L.push('> No admiten una condición que los vuelva reversibles: si el `Deny`');
    L.push('> regresó, el probe **es** el incidente. Se corren a mano con el operador.');
    L.push('>');
    L.push('> La columna **Tras aplicar** dice qué Sid del artefacto versionado');
    L.push('> convierte esa fila en `explicitDeny`. Mientras diga algo, ese statement');
    L.push('> NO está aplicado en AWS y la fila sigue en `implicitDeny`: denegado hoy,');
    L.push('> pero un `Allow` de más lo deshace en silencio.');
    L.push('');
    L.push('| Probe | CA | Evidencia observada | Tras aplicar | Fecha |');
    L.push('|---|---|---|---|---|');
    for (const p of report.controlPlane) {
        const pendiente = p.explicitoTrasAplicar ? `\`${p.explicitoTrasAplicar}\`` : '— (ya explícito)';
        L.push(`| \`${p.id}\` — ${p.descripcion} | ${p.ca} | ${p.evidenciaManual} | ${pendiente} | ${p.fecha} |`);
    }
    return L.join('\n');
}

module.exports = {
    CANARY_PK,
    CANARY_SK,
    IMPOSSIBLE_CONDITION,
    OUTCOME,
    DENY_OUTCOMES,
    CONTROL_PLANE_PROBES,
    classifyProbe,
    matchesExpectation,
    readKernelIamConfig,
    buildProbeMatrix,
    createProbeRunner,
    verifyKernelIam,
    renderMarkdown,
};

// -----------------------------------------------------------------------------
// CLI: node .pipeline/lib/kernel-iam-verify.js [--json] [--profile <p>]
// -----------------------------------------------------------------------------
if (require.main === module) {
    const argv = process.argv.slice(2);
    const asJson = argv.includes('--json');
    const pIdx = argv.indexOf('--profile');
    const profile = pIdx >= 0 ? argv[pIdx + 1] : undefined;

    verifyKernelIam({ profile })
        .then((report) => {
            process.stdout.write(asJson
                ? `${JSON.stringify(report, null, 2)}\n`
                : `${renderMarkdown(report)}\n`);
            process.exit(report.ok ? 0 : 1);
        })
        .catch((e) => {
            process.stderr.write(`${redactAwsEvidence((e && e.message) || String(e))}\n`);
            process.exit(2);
        });
}

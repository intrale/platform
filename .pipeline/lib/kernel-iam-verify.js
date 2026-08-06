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
// PROBES DE CONTROL PLANE: PROBADOS O EVALUADOS, NUNCA ESCRITOS A MANO
// ---------------------------------------------------------------------
// Una versión anterior de este módulo llevaba el resultado del control plane
// como STRING HARDCODEADO (`evidenciaManual: 'implicitDeny · dynamodb:...'`),
// deducido leyendo el artefacto del repo en vez de observando AWS. La deducción
// era falsa —la policy aplicada resultó ser un documento distinto del artefacto—
// y el markdown que el operador firma repetía la mentira. Ese es exactamente el
// defecto que #5211 existe para eliminar, cometido por el verificador que lo
// denuncia. La corrección es estructural: **acá ya no se escribe a mano ningún
// resultado**. Cada fila de control plane sale de una de dos fuentes:
//
//   1. `probe`           — se ejecuta contra AWS con una variante NO destructiva
//                          (ver abajo). Es la fuente preferida.
//   2. `policy-document` — se EVALÚA con `classifyFromPolicyDocument()` sobre el
//                          documento que AWS devuelve por `iam:GetPolicyVersion`.
//                          Autoritativo, y no requiere ejecutar la operación.
//
// LA VARIANTE NO DESTRUCTIVA: probar el control sin ser el incidente
// -------------------------------------------------------------------
// No hace falta ejecutar la operación destructiva; hace falta ejecutarla contra
// un objetivo donde el éxito sea demostrablemente un no-op:
//
//   - `CreateTable` con el nombre de una tabla que YA existe  ⇒ ResourceInUse.
//   - `UpdateContinuousBackups PITR=true` con PITR ya ENABLED ⇒ idempotente.
//   - `UpdateTable --deletion-protection-enabled` ya activo   ⇒ idempotente.
//   - `AttachUserPolicy` con un ARN de policy inexistente      ⇒ NoSuchEntity.
//
// Si el `Deny` regresó, el peor caso es una operación sin efecto — nunca el daño
// que el probe busca detectar.
//
// IN-SCOPE vs OUT-SCOPE: por qué el objetivo del probe importa tanto
// ------------------------------------------------------------------
// La policy aplicada deniega por `NotResource`: todo lo que NO sea una de las
// dos tablas o la CMK cae en `Deny`. Consecuencia contraintuitiva y central:
// **la misma acción da `explicitDeny` sobre una tabla cualquiera e
// `implicitDeny` sobre la tabla de evidencia**, que es justamente el recurso que
// CA-3 quiere proteger. Un probe apuntado a un recurso fuera de alcance reporta
// un control verificado que sobre el recurso real no existe. Por eso cada probe
// de control plane declara su `alcance` y los que importan corren `in-scope`.
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

// Objetivos canario del control plane. NO son nombres de infra (no van a
// config): son objetivos elegidos justamente porque NO EXISTEN, y su
// inexistencia es lo que vuelve inocuo al probe. Si algún día existieran, el
// probe dejaría de ser seguro — por eso llevan un nombre que nadie usaría.
const CANARY_TABLE = 'intrale-kernel-canary-5211-nonexistent';
// Namespace `aws` (policies administradas de AWS): no filtra el account-id y
// garantiza que el ARN no pueda resolver a una policy de la cuenta.
const CANARY_POLICY_ARN = 'arn:aws:iam::aws:policy/IntraleCanary5211DoesNotExist';

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

// Veredicto de un probe respecto de su expectativa. Son TRES estados, no dos:
// colapsar `pendiente` en `fallido` haría ilegible el reporte (todo rojo), y
// colapsarlo en `ok` es el bug que trajo este rebote — un control denegado sólo
// por ausencia de `Allow` se reportaba como control verificado.
const VEREDICTO = Object.freeze({
    OK: 'ok',
    // Denegado hoy, pero por `implicitDeny`: un `Allow` de más lo deshace en
    // silencio. NO cierra CA-3.
    PENDIENTE: 'pendiente',
    // La autorización estaba concedida donde se esperaba un `Deny`: hallazgo.
    FALLIDO: 'fallido',
});

/**
 * ¿El resultado observado satisface lo que el probe esperaba?
 *
 * `denyExplicito` es la expectativa de los controles de CA-3: para esos, un
 * `implicitDeny` no alcanza — es el estado que un `Allow` futuro revierte sin
 * que nadie se entere, y CA-3 pide que el runtime NO PUEDA administrar, no que
 * "hoy no le alcance el permiso".
 *
 * @param {'allow'|'deny'|'denyExplicito'} expected
 * @param {string} outcome
 * @returns {'ok'|'pendiente'|'fallido'}
 */
function evaluateExpectation(expected, outcome) {
    const autorizado = outcome === OUTCOME.ALLOWED || outcome === OUTCOME.CONDITION_FAILED;

    if (expected === 'allow') return autorizado ? VEREDICTO.OK : VEREDICTO.FALLIDO;

    if (expected === 'denyExplicito') {
        if (outcome === OUTCOME.EXPLICIT_DENY) return VEREDICTO.OK;
        // `accessDenied` sin discriminar tampoco cierra: no se sabe si sobrevive
        // a un `Allow` futuro.
        if (DENY_OUTCOMES.includes(outcome)) return VEREDICTO.PENDIENTE;
        return VEREDICTO.FALLIDO;
    }

    if (expected === 'deny') {
        return DENY_OUTCOMES.includes(outcome) ? VEREDICTO.OK : VEREDICTO.FALLIDO;
    }

    return VEREDICTO.FALLIDO;
}

/**
 * Compat: veredicto booleano. `pendiente` NO es `true` — ver el comentario de
 * `VEREDICTO`.
 *
 * @param {'allow'|'deny'|'denyExplicito'} expected
 * @param {string} outcome
 * @returns {boolean}
 */
function matchesExpectation(expected, outcome) {
    return evaluateExpectation(expected, outcome) === VEREDICTO.OK;
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

    // `iamPolicyName` / `iamAdminProfile` habilitan el chequeo de drift contra la
    // policy realmente adjunta. NO son fail-closed como las dos de arriba, y la
    // diferencia es deliberada: sin ellas los probes siguen siendo válidos (lo
    // que observan contra AWS no depende de poder leer el documento), sólo se
    // pierde la comparación. Su ausencia se reporta como "drift no verificado",
    // que impide `cerrado: true` — nunca como "sin drift".
    return {
        ...base,
        cmkAlias,
        runtimePrincipal,
        iamPolicyName: str(kernel.iamPolicyName),
        iamAdminProfile: str(kernel.iamAdminProfile),
    };
}

/**
 * Carga el artefacto de policy versionado en el repo.
 *
 * @param {string} [rutaOverride]
 * @returns {object}
 */
function loadArtifactPolicy(rutaOverride) {
    // eslint-disable-next-line global-require
    const fs = require('node:fs');
    // eslint-disable-next-line global-require
    const path = require('node:path');
    const ruta = rutaOverride || path.resolve(
        __dirname, '..', '..', 'docs', 'pipeline', 'kernel-iam-policy.json',
    );
    return JSON.parse(fs.readFileSync(ruta, 'utf8'));
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
        // `expect: 'denyExplicito'` y no `'deny'`: CA-3 pide que el runtime NO
        // PUEDA administrar. Un `implicitDeny` cumple "hoy no puede" pero se
        // deshace con un `Allow` de más — sale como `pendiente`, nunca como ✅.
        {
            id: 'ddb-list-tables',
            ca: 'CA-3',
            expect: 'denyExplicito',
            alcance: 'cuenta',
            descripcion: 'enumeración de tablas de la cuenta',
            args: ['dynamodb', 'list-tables'],
        },
        {
            // Única fila de CA-3 con `deny` y no `denyExplicito`, y la excepción
            // es de diseño: `DescribeKey` NO es una acción de administración. La
            // garantía de que la CMK no se use fuera de DynamoDB la da la
            // condición `kms:ViaService` de la KEY POLICY, más el hecho de que
            // la identity policy no concede un solo `kms:` (test dedicado en
            // kernel-iam-policy.test.js). Exigir `explicitDeny` acá obligaría a
            // meter `DescribeKey` en un Deny, que es precisamente el efecto
            // colateral que analiza #5660.
            id: 'kms-describe-key',
            ca: 'CA-3',
            expect: 'deny',
            alcance: 'in-scope',
            descripcion: 'uso directo de la CMK fuera de DynamoDB (garantía: key policy, no identity)',
            args: ['kms', 'describe-key', '--key-id', `alias/${cmkAlias}`],
        },
        {
            id: 'iam-list-attached-user-policies',
            ca: 'CA-3',
            expect: 'denyExplicito',
            alcance: 'cuenta',
            descripcion: 'lectura de su propia policy (reconocimiento previo a escalada)',
            args: ['iam', 'list-attached-user-policies', '--user-name', runtimePrincipal],
        },

        // --- CA-3 · control plane, variantes NO destructivas ---------------------
        // Ver el encabezado del archivo. Cada una se ejecuta contra un objetivo
        // donde el éxito es demostrablemente un no-op, así que probar el `Deny`
        // no puede provocar el daño que el `Deny` previene.

        // PITR sobre la tabla de EVIDENCIA. Es el control más importante de CA-3:
        // apagar PITR deja la evidencia de no-repudio destruible por otra vía, y
        // entonces el append-only del plano de datos no vale nada.
        // `PointInTimeRecoveryEnabled=true` con PITR ya ENABLED es idempotente:
        // el probe JAMÁS puede apagarlo, que es lo que busca detectar.
        {
            id: 'ddb-update-continuous-backups-inscope',
            ca: 'CA-3',
            expect: 'denyExplicito',
            alcance: 'in-scope',
            descripcion: 'administrar PITR sobre la tabla de evidencia (variante idempotente)',
            args: ['dynamodb', 'update-continuous-backups', '--table-name', nr,
                '--point-in-time-recovery-specification', 'PointInTimeRecoveryEnabled=true'],
        },
        // La MISMA acción, fuera de alcance. No es redundante: es el discriminante
        // que expone el agujero. Si esta fila da `explicitDeny` y la de arriba
        // `implicitDeny`, el `Deny` aplicado protege todo MENOS el recurso que
        // importa — y una matriz que sólo hubiera corrido esta fila reportaría el
        // control como verificado.
        {
            id: 'ddb-update-continuous-backups-outscope',
            ca: 'CA-3',
            expect: 'denyExplicito',
            alcance: 'out-scope',
            descripcion: 'administrar PITR sobre una tabla fuera de alcance (contraste)',
            args: ['dynamodb', 'update-continuous-backups', '--table-name', CANARY_TABLE,
                '--point-in-time-recovery-specification', 'PointInTimeRecoveryEnabled=true'],
        },
        // Deletion protection ya está activa ⇒ activarla de nuevo es idempotente.
        {
            id: 'ddb-update-table-inscope',
            ca: 'CA-3',
            expect: 'denyExplicito',
            alcance: 'in-scope',
            descripcion: 'administrar deletion protection sobre la tabla de evidencia (idempotente)',
            args: ['dynamodb', 'update-table', '--table-name', nr, '--deletion-protection-enabled'],
        },
        // Crear una tabla con un nombre YA EXISTENTE: si estuviera autorizado,
        // AWS responde ResourceInUseException y no se crea nada.
        {
            id: 'ddb-create-table-inscope',
            ca: 'CA-3',
            expect: 'denyExplicito',
            alcance: 'in-scope',
            descripcion: 'crear tabla usando un nombre ya existente (no puede crear nada)',
            args: ['dynamodb', 'create-table', '--table-name', nr,
                '--attribute-definitions', 'AttributeName=PK,AttributeType=S',
                '--key-schema', 'AttributeName=PK,KeyType=HASH',
                '--billing-mode', 'PAY_PER_REQUEST'],
        },
        // Borrar una tabla que NO existe: si estuviera autorizado, responde
        // ResourceNotFoundException. Nunca apunta a una tabla real.
        {
            id: 'ddb-delete-table-outscope',
            ca: 'CA-3',
            expect: 'denyExplicito',
            alcance: 'out-scope',
            descripcion: 'borrar una tabla inexistente (no puede borrar nada real)',
            args: ['dynamodb', 'delete-table', '--table-name', CANARY_TABLE],
        },
        // Escalada de privilegio con un ARN de policy inexistente: si estuviera
        // autorizado, responde NoSuchEntity — jamás adjunta AdministratorAccess.
        {
            id: 'iam-attach-user-policy',
            ca: 'CA-3',
            expect: 'denyExplicito',
            alcance: 'cuenta',
            descripcion: 'auto-adjuntarse una policy (ARN inexistente: no puede escalar)',
            args: ['iam', 'attach-user-policy', '--user-name', runtimePrincipal,
                '--policy-arn', CANARY_POLICY_ARN],
        },
    ];
}

// -----------------------------------------------------------------------------
// Control plane no probeable: EVALUADO contra el documento de policy aplicado
// -----------------------------------------------------------------------------

// Estas operaciones no tienen variante inocua: no existe forma de intentar
// `ScheduleKeyDeletion` sobre la CMK real donde el éxito no sea el incidente.
// Antes se declaraban con un string escrito a mano; ese string mintió y provocó
// el rebote. Ahora NO llevan resultado: llevan el `action` y el `resourceRef`, y
// el resultado lo calcula `classifyFromPolicyDocument()` sobre el documento que
// AWS devuelve. Si no se pudo leer el documento, la fila sale `desconocido` —
// nunca `implicitDeny` ni `explicitDeny` por defecto.
//
// `resourceRef` es simbólico y lo resuelve `resolveResourceRef()` con los datos
// de config: acá no se hardcodea ningún ARN.
const CONTROL_PLANE_PROBES = Object.freeze([
    {
        id: 'ddb-delete-table-inscope',
        ca: 'CA-3',
        runnable: false,
        alcance: 'in-scope',
        descripcion: 'borrar la tabla de evidencia entera',
        action: 'dynamodb:DeleteTable',
        resourceRef: 'tablaNoRepudio',
        motivoNoEjecutable: 'no hay variante inocua: si el Deny regresó, borra la evidencia',
    },
    {
        id: 'kms-schedule-key-deletion',
        ca: 'CA-3',
        runnable: false,
        alcance: 'in-scope',
        descripcion: 'programar borrado de la CMK (haría ilegible toda la evidencia)',
        action: 'kms:ScheduleKeyDeletion',
        resourceRef: 'cmk',
        motivoNoEjecutable: 'no admite objetivo canario: la API rechaza alias y sólo opera sobre la CMK real',
    },
    {
        id: 'kms-disable-key',
        ca: 'CA-3',
        runnable: false,
        alcance: 'in-scope',
        descripcion: 'deshabilitar la CMK',
        action: 'kms:DisableKey',
        resourceRef: 'cmk',
        motivoNoEjecutable: 'no admite objetivo canario: la API rechaza alias y sólo opera sobre la CMK real',
    },
    {
        id: 'kms-put-key-policy',
        ca: 'CA-3',
        runnable: false,
        alcance: 'in-scope',
        descripcion: 'reescribir la key policy de la CMK (se auto-concedería uso directo)',
        action: 'kms:PutKeyPolicy',
        resourceRef: 'cmk',
        motivoNoEjecutable: 'no admite objetivo canario: la API rechaza alias y sólo opera sobre la CMK real',
    },
    {
        id: 'iam-create-access-key',
        ca: 'CA-3',
        runnable: false,
        alcance: 'cuenta',
        descripcion: 'emitir credenciales nuevas para sí mismo',
        action: 'iam:CreateAccessKey',
        resourceRef: 'runtimePrincipal',
        motivoNoEjecutable: 'si estuviera autorizado, el probe FILTRA una credencial válida',
    },
]);

// -----------------------------------------------------------------------------
// Mini evaluador IAM sobre el documento de policy REALMENTE aplicado
// -----------------------------------------------------------------------------

/**
 * ¿El patrón IAM (con comodines `*` y `?`) matchea el valor?
 *
 * @param {string} pattern
 * @param {string} value
 * @returns {boolean}
 */
function iamMatch(pattern, value) {
    if (typeof pattern !== 'string' || typeof value !== 'string') return false;
    if (pattern === '*') return true;

    // Se arma el regex carácter por carácter en vez de con un `replace` de
    // escapes: los ARN traen `.`, `$`, `[`, `|` y `+` con frecuencia, y una
    // clase de escape mal cerrada acá convierte un patrón que no matchea en uno
    // que matchea todo — o sea, un Deny que se lee como aplicado sin serlo.
    const ESPECIALES = '.+^${}()|[]\\/';
    let rx = '^';
    for (const ch of pattern) {
        if (ch === '*') rx += '.*';
        else if (ch === '?') rx += '.';
        else if (ESPECIALES.includes(ch)) rx += `\\${ch}`;
        else rx += ch;
    }
    rx += '$';
    return new RegExp(rx, 'i').test(value);
}

const asList = (v) => {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') return [v];
    return [];
};

/**
 * ¿El statement alcanza a (action, resource)?
 *
 * Soporta las cuatro formas: `Action`/`NotAction` y `Resource`/`NotResource`.
 * `NotResource` es la forma que usa el catch-all aplicado hoy, y es justamente
 * la que la versión anterior de este módulo no modelaba — por eso no podía
 * explicar que la misma acción diera `explicitDeny` afuera e `implicitDeny`
 * sobre la tabla de evidencia.
 *
 * @param {object} st
 * @param {string} action
 * @param {string} resourceArn
 * @returns {boolean}
 */
function statementMatches(st, action, resourceArn) {
    if (!st || typeof st !== 'object') return false;

    const actions = asList(st.Action);
    const notActions = asList(st.NotAction);
    let accionAlcanzada;
    if (notActions.length) accionAlcanzada = !notActions.some((p) => iamMatch(p, action));
    else if (actions.length) accionAlcanzada = actions.some((p) => iamMatch(p, action));
    else return false;
    if (!accionAlcanzada) return false;

    const resources = asList(st.Resource);
    const notResources = asList(st.NotResource);
    if (notResources.length) return !notResources.some((p) => iamMatch(p, resourceArn));
    if (resources.length) return resources.some((p) => iamMatch(p, resourceArn));
    return false;
}

/**
 * Clasifica (action, resource) contra un documento de policy, con la semántica
 * de evaluación de IAM: `Deny` explícito gana; si no hay `Allow`, `implicitDeny`.
 *
 * Ojo con el alcance de lo que esto prueba: evalúa UNA policy de identidad. No
 * modela SCPs, permission boundaries ni resource policies. Sirve para decir
 * "esta policy deniega explícitamente X", que es lo que pide CA-3; no sirve para
 * afirmar que algo está permitido de punta a punta.
 *
 * @param {object} doc  documento IAM (`{Version, Statement:[...]}`)
 * @param {string} action
 * @param {string} resourceArn
 * @returns {{outcome:string, sid:(string|null)}}
 */
function classifyFromPolicyDocument(doc, action, resourceArn) {
    const stmts = (doc && Array.isArray(doc.Statement)) ? doc.Statement : [];

    for (const st of stmts) {
        if (st && st.Effect === 'Deny' && statementMatches(st, action, resourceArn)) {
            return { outcome: OUTCOME.EXPLICIT_DENY, sid: st.Sid || null };
        }
    }
    for (const st of stmts) {
        if (st && st.Effect === 'Allow' && statementMatches(st, action, resourceArn)) {
            return { outcome: OUTCOME.ALLOWED, sid: st.Sid || null };
        }
    }
    return { outcome: OUTCOME.IMPLICIT_DENY, sid: null };
}

// -----------------------------------------------------------------------------
// Drift: el artefacto del repo contra la policy REALMENTE adjunta al principal
// -----------------------------------------------------------------------------

// El entregable central de #5211 es que el repo represente lo aplicado. Hasta
// este rebote eso se afirmaba en prosa, y la afirmación era falsa: la policy
// adjunta era un documento con otros Sids y otra estructura (un catch-all por
// `NotResource`) que el artefacto no modelaba en absoluto. Nadie lo detectó
// porque NADA lo comparaba. Esto lo compara.
//
// Las dos direcciones del drift NO son igual de graves:
//
//   - `soloEnArtefacto`  ⇒ endurecimiento versionado y todavía no aplicado.
//                          Pendiente del operador. La postura real es más débil
//                          que la que el repo declara.
//   - `soloEnAplicada`   ⇒ **REGRESIÓN**: statements que hoy protegen y que
//                          aplicar el artefacto BORRARÍA. Es el caso peligroso,
//                          porque el razonamiento habitual ("el diff sólo agrega
//                          Deny, la postura sólo puede mejorar") es falso cuando
//                          el artefacto REEMPLAZA la policy entera en vez de
//                          sumarse a ella. Aplicar es un `create-policy-version`,
//                          no un merge.

/**
 * Enmascara los valores reales de infra de un documento de policy y los cambia
 * por los placeholders del artefacto, para poder compararlos.
 *
 * Además de habilitar la comparación, esto es lo que permite mostrar el
 * documento aplicado en un reporte sin filtrar account-id, región ni el UUID de
 * la CMK.
 *
 * @param {object} doc
 * @param {{region:string, tableName:string, coordinationTableName:string, accountId?:string}} cfg
 * @returns {object}
 */
function maskPolicyDocument(doc, cfg) {
    let raw = JSON.stringify(doc || {});
    const sub = (valor, ph) => {
        if (typeof valor === 'string' && valor) raw = raw.split(valor).join(ph);
    };
    // Orden: primero los nombres de tabla (más específicos), después región y
    // cuenta. Al revés, `TABLE` quedaría dentro de un ARN ya enmascarado.
    sub(cfg && cfg.tableName, 'TABLE');
    sub(cfg && cfg.coordinationTableName, 'COORD_TABLE');
    sub(cfg && cfg.accountId, 'ACCOUNT');
    sub(cfg && cfg.region, 'REGION');
    // El id de la CMK es un UUID y no viene de config: se enmascara por forma.
    raw = raw.replace(/key\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'key/CMK_KEY_ID');
    // Cualquier otro id de 12 dígitos que se haya escapado (defensa en profundidad).
    raw = raw.replace(/\b\d{12}\b/g, 'ACCOUNT');
    return JSON.parse(raw);
}

/**
 * Firma comparable de un statement: ordena listas para que un reordenamiento
 * cosmético no se reporte como drift.
 *
 * @param {object} st
 * @returns {string}
 */
function statementSignature(st) {
    const norm = (v) => asList(v).slice().sort();
    return JSON.stringify({
        Effect: (st && st.Effect) || null,
        Action: norm(st && st.Action),
        NotAction: norm(st && st.NotAction),
        Resource: norm(st && st.Resource),
        NotResource: norm(st && st.NotResource),
        Condition: (st && st.Condition) || null,
    });
}

/**
 * Compara el artefacto versionado contra el documento aplicado (ya enmascarado).
 *
 * @param {object} artefacto
 * @param {object} aplicada
 * @returns {{sinDrift:boolean, regresion:boolean, soloEnArtefacto:Array, soloEnAplicada:Array, divergentes:Array}}
 */
function diffPolicyDocuments(artefacto, aplicada) {
    const index = (doc) => {
        const m = new Map();
        const stmts = (doc && Array.isArray(doc.Statement)) ? doc.Statement : [];
        stmts.forEach((st, i) => m.set((st && st.Sid) || `#${i}`, st));
        return m;
    };
    const A = index(artefacto);
    const B = index(aplicada);

    const soloEnArtefacto = [];
    const soloEnAplicada = [];
    const divergentes = [];

    for (const [sid, st] of A) {
        if (!B.has(sid)) soloEnArtefacto.push({ sid, efecto: st && st.Effect });
        else if (statementSignature(st) !== statementSignature(B.get(sid))) {
            divergentes.push({ sid, efecto: st && st.Effect });
        }
    }
    for (const [sid, st] of B) {
        if (!A.has(sid)) soloEnAplicada.push({ sid, efecto: st && st.Effect });
    }

    // Un `Deny` aplicado que el artefacto no tiene desaparecería al aplicar.
    const regresion = soloEnAplicada.some((s) => s.efecto === 'Deny')
        || divergentes.some((s) => s.efecto === 'Deny');

    return {
        sinDrift: !soloEnArtefacto.length && !soloEnAplicada.length && !divergentes.length,
        regresion,
        soloEnArtefacto,
        soloEnAplicada,
        divergentes,
    };
}

/**
 * Lee de AWS el documento de la policy adjunta y lo devuelve enmascarado.
 *
 * Usa un perfil ADMINISTRATIVO distinto del runtime: el runtime tiene denegado
 * `iam:GetPolicyVersion` a propósito (no debe poder leer su propia policy), así
 * que no puede auditarse a sí mismo. Todo lo que emite es de sólo lectura.
 *
 * NUNCA lanza por falta de permisos o de config: devuelve `{disponible:false}`
 * con el motivo. Un chequeo de drift que no se pudo correr tiene que reportarse
 * como no corrido — colapsarlo en "sin drift" sería el mismo falso verde que
 * trajo este rebote.
 *
 * @param {object} opts
 * @returns {Promise<{disponible:boolean, motivo?:string, versionId?:string, documento?:object}>}
 */
async function fetchAppliedPolicy(opts = {}) {
    const policyName = typeof opts.policyName === 'string' ? opts.policyName.trim() : '';
    if (!policyName) {
        return { disponible: false, motivo: 'falta kernel.iamPolicyName en config.yaml' };
    }
    const adminProfile = typeof opts.adminProfile === 'string' ? opts.adminProfile.trim() : '';
    if (!adminProfile) {
        return { disponible: false, motivo: 'falta kernel.iamAdminProfile en config.yaml' };
    }

    const runner = opts.runner || createProbeRunner({
        profile: adminProfile, region: opts.region, spawn: opts.spawn,
    });

    const json = (res) => {
        try { return JSON.parse(res.stdout); } catch (e) { return null; }
    };

    const ident = await runner.run(['sts', 'get-caller-identity']);
    const identDoc = json(ident);
    const accountId = identDoc && identDoc.Account;
    if (!accountId) {
        return {
            disponible: false,
            motivo: `el perfil admin "${adminProfile}" no resolvió el account-id`,
        };
    }

    const arn = `arn:aws:iam::${accountId}:policy/${policyName}`;
    const meta = await runner.run(['iam', 'get-policy', '--policy-arn', arn]);
    const metaDoc = json(meta);
    const versionId = metaDoc && metaDoc.Policy && metaDoc.Policy.DefaultVersionId;
    if (!versionId) {
        return {
            disponible: false,
            motivo: redactAwsEvidence(`no se pudo leer iam:GetPolicy de ${policyName}: ${(meta.stderr || '').trim()}`),
        };
    }

    const ver = await runner.run(['iam', 'get-policy-version', '--policy-arn', arn, '--version-id', versionId]);
    const verDoc = json(ver);
    const documento = verDoc && verDoc.PolicyVersion && verDoc.PolicyVersion.Document;
    if (!documento) {
        return {
            disponible: false,
            motivo: redactAwsEvidence(`no se pudo leer iam:GetPolicyVersion ${versionId}: ${(ver.stderr || '').trim()}`),
        };
    }

    return {
        disponible: true,
        policyName,
        versionId,
        adjuntaA: (metaDoc.Policy && metaDoc.Policy.AttachmentCount) || 0,
        documento: maskPolicyDocument(documento, { ...opts, accountId }),
        // Los ARN reales quedan disponibles para evaluar los probes no
        // ejecutables, pero NO se emiten en el reporte.
        _accountId: accountId,
    };
}

/**
 * Resuelve la referencia simbólica de recurso de un probe no ejecutable al ARN
 * **enmascarado**, para evaluarlo contra el documento aplicado (que también se
 * evalúa enmascarado).
 *
 * Se evalúa en el espacio de placeholders a propósito: así el evaluador nunca
 * necesita el account-id ni el UUID de la CMK, y ningún valor real puede
 * filtrarse al reporte por esta vía.
 *
 * @param {string} ref
 * @param {object} cfg
 * @returns {string|null}
 */
function resolveResourceRef(ref, cfg) {
    const runtimePrincipal = (cfg && cfg.runtimePrincipal) || '';
    switch (ref) {
        case 'tablaNoRepudio':
            return 'arn:aws:dynamodb:REGION:ACCOUNT:table/TABLE';
        case 'tablaCoordinacion':
            return 'arn:aws:dynamodb:REGION:ACCOUNT:table/COORD_TABLE';
        case 'cmk':
            return 'arn:aws:kms:REGION:ACCOUNT:key/CMK_KEY_ID';
        case 'runtimePrincipal':
            return `arn:aws:iam::ACCOUNT:user/${runtimePrincipal}`;
        default:
            return null;
    }
}

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
        const veredicto = evaluateExpectation(probe.expect, clasificado.outcome);
        probes.push({
            id: probe.id,
            ca: probe.ca,
            descripcion: probe.descripcion,
            alcance: probe.alcance || null,
            expect: probe.expect,
            outcome: clasificado.outcome,
            action: clasificado.action,
            policy: clasificado.policy,
            veredicto,
            ok: veredicto === VEREDICTO.OK,
            evidencia: clasificado.message,
        });
    }

    // --- Policy aplicada: drift + clasificación de lo no ejecutable -------------
    const aplicada = opts.appliedPolicy || await fetchAppliedPolicy({
        policyName: cfg.iamPolicyName,
        adminProfile: cfg.iamAdminProfile,
        region: cfg.region,
        tableName: cfg.tableName,
        coordinationTableName: cfg.coordinationTableName,
        runner: opts.adminRunner,
        spawn: opts.spawn,
    });

    let drift = { disponible: false, motivo: aplicada.motivo || 'no se pudo leer la policy aplicada' };
    if (aplicada.disponible) {
        drift = {
            disponible: true,
            versionId: aplicada.versionId,
            ...diffPolicyDocuments(opts.artifactPolicy || loadArtifactPolicy(), aplicada.documento),
        };
    }

    const controlPlane = CONTROL_PLANE_PROBES.map((p) => {
        const resourceArn = resolveResourceRef(p.resourceRef, cfg);
        if (!aplicada.disponible || !resourceArn) {
            return {
                ...p,
                fuente: 'policy-document',
                outcome: 'desconocido',
                sid: null,
                veredicto: VEREDICTO.PENDIENTE,
                nota: aplicada.disponible
                    ? `resourceRef "${p.resourceRef}" no resuelve`
                    : `no se pudo leer la policy aplicada (${drift.motivo})`,
            };
        }
        const clas = classifyFromPolicyDocument(aplicada.documento, p.action, resourceArn);
        return {
            ...p,
            fuente: 'policy-document',
            resourceArn,
            outcome: clas.outcome,
            sid: clas.sid,
            veredicto: evaluateExpectation('denyExplicito', clas.outcome),
        };
    });

    const cuenta = (lista, v) => lista.filter((p) => p.veredicto === v).length;
    const fallidos = cuenta(probes, VEREDICTO.FALLIDO) + cuenta(controlPlane, VEREDICTO.FALLIDO);
    const pendientes = cuenta(probes, VEREDICTO.PENDIENTE) + cuenta(controlPlane, VEREDICTO.PENDIENTE);
    const oks = cuenta(probes, VEREDICTO.OK) + cuenta(controlPlane, VEREDICTO.OK);

    return {
        profile: runner.profile,
        region: cfg.region,
        probes,
        controlPlane,
        drift,
        resumen: {
            total: probes.length + controlPlane.length,
            ok: oks,
            pendientes,
            fallidos,
            ejecutados: probes.length,
            evaluados: controlPlane.length,
        },
        // `ok`: ningún control está ABIERTO (nada autorizado donde se esperaba
        // Deny). Es la condición de "no hay incidente".
        ok: fallidos === 0,
        // `cerrado`: además, todo control de CA-3 es `explicitDeny` y el repo
        // representa lo aplicado. Es la condición para firmar CA-1/CA-3.
        // Se reportan por separado a propósito: colapsarlas fue el bug.
        cerrado: fallidos === 0 && pendientes === 0 && drift.disponible === true && drift.sinDrift === true,
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
const ICONO = Object.freeze({
    [VEREDICTO.OK]: '✅',
    [VEREDICTO.PENDIENTE]: '⏳',
    [VEREDICTO.FALLIDO]: '❌',
});

function renderMarkdown(report) {
    const L = [];
    const R = report.resumen;
    L.push('# Matriz IAM/KMS del runtime del kernel (#5211)');
    L.push('');
    L.push(`- Perfil: \`${report.profile}\` · Región: \`${report.region}\``);
    L.push(`- Controles: ${R.ok} ✅ · ${R.pendientes} ⏳ pendientes · ${R.fallidos} ❌ abiertos `
        + `(de ${R.total}: ${R.ejecutados} probados contra AWS, ${R.evaluados} evaluados sobre la policy aplicada)`);
    L.push('');

    // El veredicto va PRIMERO y en una sola línea. Este documento se lee para
    // firmar un gate humano: si el estado real hay que deducirlo leyendo tablas,
    // se deduce mal.
    if (report.cerrado) {
        L.push('> **CA-3 CERRADO.** Todo control de control plane es `explicitDeny` sobre el');
        L.push('> recurso real, y el artefacto versionado coincide con la policy aplicada.');
    } else if (!report.ok) {
        L.push('> ❌ **HALLAZGO ABIERTO.** Hay operaciones AUTORIZADAS donde se esperaba `Deny`.');
        L.push('> Ver las filas ❌. Esto no es un pendiente: es un control que hoy no existe.');
    } else {
        L.push('> ⏳ **CA-3 NO CERRADO.** Nada está autorizado indebidamente, pero hay controles');
        L.push('> que dependen de `implicitDeny` (denegado por ausencia de `Allow`, no por');
        L.push('> `Deny`): un `Allow` de más los deshace en silencio y nadie se entera.');
        L.push('> **Un `implicitDeny` no cuenta como control verificado.**');
    }
    L.push('');

    // --- Drift: lo primero que el operador tiene que saber ---------------------
    L.push('## Artefacto versionado vs. policy aplicada');
    L.push('');
    if (!report.drift.disponible) {
        L.push(`> ⏳ **NO VERIFICADO** — ${report.drift.motivo}.`);
        L.push('>');
        L.push('> Sin esta comparación no se puede afirmar que el repo represente lo aplicado,');
        L.push('> que es el entregable central de #5211. No se asume "sin drift".');
    } else if (report.drift.sinDrift) {
        L.push(`> ✅ El artefacto coincide con la versión \`${report.drift.versionId}\` aplicada.`);
    } else {
        L.push(`> Comparado contra la versión \`${report.drift.versionId}\`, hoy adjunta al principal.`);
        L.push('');
        if (report.drift.regresion) {
            L.push('> ❌ **APLICAR EL ARTEFACTO TAL CUAL SERÍA UNA REGRESIÓN.** Hay `Deny` vigentes');
            L.push('> que el artefacto no contiene. Aplicar una policy es `create-policy-version`:');
            L.push('> **reemplaza el documento entero, no se fusiona**. Todo statement que sólo');
            L.push('> exista del lado aplicado se PIERDE.');
            L.push('');
        }
        const fila = (t, arr) => {
            if (!arr.length) return;
            L.push(`- **${t}:** ${arr.map((s) => `\`${s.sid}\` (${s.efecto})`).join(', ')}`);
        };
        fila('Sólo en la policy aplicada — se perderían al aplicar', report.drift.soloEnAplicada);
        fila('Sólo en el artefacto — endurecimiento pendiente de aplicar', report.drift.soloEnArtefacto);
        fila('Mismo Sid, contenido distinto', report.drift.divergentes);
    }
    L.push('');

    L.push('## Controles probados contra AWS');
    L.push('');
    L.push('> `alcance` no es decorativo. La policy aplicada deniega por `NotResource`, así que');
    L.push('> **la misma acción puede dar `explicitDeny` fuera de alcance e `implicitDeny` sobre');
    L.push('> el recurso que se quiere proteger.** Sólo las filas `in-scope` dicen algo sobre la');
    L.push('> evidencia de no-repudio.');
    L.push('');
    L.push('| Probe | CA | Alcance | Espera | Resultado | |');
    L.push('|---|---|---|---|---|---|');
    for (const p of report.probes) {
        L.push(`| \`${p.id}\` — ${p.descripcion} | ${p.ca} | ${p.alcance || '—'} | ${p.expect} `
            + `| ${p.outcome} | ${ICONO[p.veredicto] || '?'} |`);
    }
    L.push('');

    L.push('## Controles evaluados sobre la policy aplicada (no ejecutables)');
    L.push('');
    L.push('> Estas operaciones no tienen variante inocua: intentarlas contra el recurso real');
    L.push('> **es** el incidente que buscan prevenir. No se ejecutan y **tampoco se declaran a');
    L.push('> mano**: se evalúan con la semántica de IAM sobre el documento que AWS devuelve por');
    L.push('> `iam:GetPolicyVersion`. Si ese documento no se pudo leer, la fila sale');
    L.push('> `desconocido` — nunca con un resultado supuesto.');
    L.push('');
    L.push('| Control | CA | Alcance | Resultado | Statement | |');
    L.push('|---|---|---|---|---|---|');
    for (const p of report.controlPlane) {
        const sid = p.sid ? `\`${p.sid}\`` : (p.nota ? `— ${p.nota}` : '— ninguno');
        L.push(`| \`${p.id}\` — ${p.descripcion} | ${p.ca} | ${p.alcance || '—'} `
            + `| ${p.outcome} | ${sid} | ${ICONO[p.veredicto] || '?'} |`);
    }
    return L.join('\n');
}

module.exports = {
    CANARY_PK,
    CANARY_SK,
    CANARY_TABLE,
    CANARY_POLICY_ARN,
    IMPOSSIBLE_CONDITION,
    OUTCOME,
    DENY_OUTCOMES,
    VEREDICTO,
    CONTROL_PLANE_PROBES,
    classifyProbe,
    matchesExpectation,
    evaluateExpectation,
    readKernelIamConfig,
    loadArtifactPolicy,
    buildProbeMatrix,
    createProbeRunner,
    verifyKernelIam,
    renderMarkdown,
    // Evaluador y drift (#5211 · rebote de verificación)
    iamMatch,
    statementMatches,
    classifyFromPolicyDocument,
    maskPolicyDocument,
    statementSignature,
    diffPolicyDocuments,
    fetchAppliedPolicy,
    resolveResourceRef,
};

// -----------------------------------------------------------------------------
// CLI: node .pipeline/lib/kernel-iam-verify.js [--json] [--profile <p>]
// -----------------------------------------------------------------------------
if (require.main === module) {
    const argv = process.argv.slice(2);
    const asJson = argv.includes('--json');
    const pIdx = argv.indexOf('--profile');
    const profile = pIdx >= 0 ? argv[pIdx + 1] : undefined;

    // `--strict` exige CA-3 cerrado (todo explicitDeny + repo == aplicado), no
    // sólo "nada abierto". Es el modo que corresponde en un gate: sin él, un
    // `implicitDeny` sale exit 0 y alguien lo cita como verde.
    const strict = argv.includes('--strict');

    verifyKernelIam({ profile })
        .then((report) => {
            process.stdout.write(asJson
                ? `${JSON.stringify(report, null, 2)}\n`
                : `${renderMarkdown(report)}\n`);
            if (!report.ok) process.exit(1);
            process.exit(strict && !report.cerrado ? 1 : 0);
        })
        .catch((e) => {
            process.stderr.write(`${redactAwsEvidence((e && e.message) || String(e))}\n`);
            process.exit(2);
        });
}

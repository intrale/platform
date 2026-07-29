'use strict';

// =============================================================================
// kernel-provision.js — Paso ADMIN de aprovisionamiento de la tabla del kernel
// (split 1/3 de #4804 · #4820)
//
// CONTEXTO
// --------
// Aprovisiona la tabla single-table DynamoDB (PK/SK) que respalda el store
// durable del kernel (`kernel-store.js`). Reutiliza el orquestador genérico
// `provisionResource(contract, { driver })` (provisioner-infra.js) + el driver
// real AWS CLI (`createAwsCliRunner` → `createAwsCliDynamoDriver`).
//
// INVARIANTES (#4820 CA-2 / CA-3 / CA-5, SEC-A02/A03/A09):
//   - **NO corre en el boot del pulpo.** Es un paso admin explícito: se dispara
//     por CLI (`node .pipeline/lib/kernel-provision.js`) o por require + llamada
//     explícita, con credenciales AWS admin en el ambiente. El pipeline normal
//     nunca lo invoca; con `kernel.durable: false` no hay ningún llamador.
//   - **Sin hardcode (CA-2 / A05):** `tableName`/`region` vienen EXCLUSIVAMENTE
//     de la sección `kernel:` de `config.yaml`. Nada de tabla/región/ARN/account
//     literal en el código.
//   - **Credenciales por canal confiable (CA-3 / SEC-A02):** el runner toma las
//     credenciales del scope `aws` (build-child-env.js) del ambiente; fail-closed
//     si faltan (lo garantiza `createAwsCliRunner`).
//   - **No-log de secretos (SEC-A09):** nunca se vuelca el `env` ni las salidas
//     crudas del CLI a logs compartidos.
//   - **IAM least-privilege append-only (CA-5):** la policy de la tabla vive en
//     `docs/pipeline/kernel-iam-policy.json` (Deny explícito sobre
//     UpdateItem/DeleteItem para `signature#*`/`audit#*`). El principal de
//     provisioning (admin, con CreateTable) es DISTINTO del principal de runtime
//     del driver (sólo PutItem/GetItem/Query/ConditionCheck).
// =============================================================================

// #5172 — `path` ya no se importa: la única ruta que este módulo armaba era la
// del `config.yaml` por default, y esa resolución ahora es del config-resolver.
const {
    createAwsCliRunner,
    createAwsCliDynamoDriver,
    provisionResource,
    RESOURCE_TYPE,
    DELIVERABLE_TYPE,
} = require('./provisioner-infra');
const { CREDENTIAL_SCOPES } = require('./build-child-env');

// -----------------------------------------------------------------------------
// #5172 — Carga de config vía el punto ÚNICO (`lib/config-resolver.js`).
// FAIL-CLOSED: sin config no hay tabla.
//
// Se eliminó el `|| {}` que seguía al `yaml.load`: un archivo vacío o a medio
// escribir se volvía `{}` y de ahí `kernel: {}` — indistinguible de una config
// válida que simplemente no declara la sección `kernel:`. Ahora eso es
// `ConfigParseViolation` y se propaga (igual que un YAML roto o un schema
// inválido), en vez de disfrazarse de "no hay tabla configurada".
//
// La inyección por firma (`cfgPath`, ruta de ARCHIVO) se conserva tal cual: es
// código, no entorno — CA-12 restringe lo que puede aportar el ENTORNO.
//
// La AUSENCIA de la sección `kernel:` NO es error: devuelve `{}` y
// `buildKernelTableContract` falla ruidoso por `tableName` requerido (CA-2/A05).
// -----------------------------------------------------------------------------

function loadKernelConfig(cfgPath) {
    // eslint-disable-next-line global-require
    const configResolver = require('./config-resolver');
    const doc = configResolver.resolve(cfgPath ? { configPath: cfgPath } : {});
    return (doc && typeof doc.kernel === 'object' && doc.kernel) || {};
}

// -----------------------------------------------------------------------------
// Contrato de recurso: tabla single-table PK/SK (mismo schema que kernel-store)
// -----------------------------------------------------------------------------

function buildKernelTableContract(kernelCfg) {
    const cfg = kernelCfg && typeof kernelCfg === 'object' ? kernelCfg : {};
    const tableName = typeof cfg.tableName === 'string' ? cfg.tableName : '';
    if (!tableName) {
        // CA-2 / A05: la tabla NUNCA se hardcodea; sin config no se aprovisiona.
        throw new Error(
            'kernel-provision: config.kernel.tableName requerido y no vacío '
            + '(la tabla se define por config, nunca hardcode — A05/CA-2). '
            + 'Definilo en config.yaml (sección kernel:) antes de aprovisionar.',
        );
    }
    return {
        version: '0.1.0',
        tipo_entregable: DELIVERABLE_TYPE.RECURSO_PROVISIONADO,
        definicion_de_listo: ['La tabla single-table PK/SK existe y responde el round-trip'],
        evidencia_requerida: {
            tipo: 'describe_table_round_trip',
            detalle: 'describe-table + smoke round-trip (create/read/delete)',
        },
        ejecutor: { tipo: 'provisioner_infra' },
        recurso: {
            tipo: RESOURCE_TYPE.DYNAMODB_TABLE,
            nombre: tableName,
            schema: {
                hashKey: { nombre: 'PK', tipo: 'S' },
                rangeKey: { nombre: 'SK', tipo: 'S' },
            },
        },
    };
}

// -----------------------------------------------------------------------------
// Env del scope `aws` — SÓLO las vars allowlisted, nunca process.env crudo.
// La región de config completa AWS_REGION si el ambiente no la trae (config
// manda; sigue sin hardcode porque el valor viene de config.yaml).
// -----------------------------------------------------------------------------

function buildAwsScopedEnv(sourceEnv, region) {
    const src = sourceEnv && typeof sourceEnv === 'object' ? sourceEnv : process.env;
    const out = {};
    for (const name of CREDENTIAL_SCOPES.aws) {
        const val = src[name];
        if (val != null && val !== '') out[name] = val;
    }
    if (region && !out.AWS_REGION) out.AWS_REGION = region;
    return out;
}

// -----------------------------------------------------------------------------
// Orquestador del paso admin. NUNCA se llama en boot; requiere invocación
// explícita con credenciales admin. Devuelve el resultado estructurado de
// `provisionResource` (nunca lanza por fallo del driver; sí lanza fail-closed
// si faltan tableName o credenciales, ANTES de tocar AWS).
// -----------------------------------------------------------------------------

async function provisionKernelTable(deps = {}) {
    const kernelCfg = deps.kernelConfig || loadKernelConfig(deps.configPath);
    const contract = buildKernelTableContract(kernelCfg);

    // Driver inyectable para tests (run fake). En producción se arma el runner
    // real (fail-closed de credenciales dentro de createAwsCliRunner).
    let driver = deps.driver;
    if (!driver) {
        const env = buildAwsScopedEnv(deps.env, kernelCfg.region);
        const { run } = createAwsCliRunner(env);
        driver = createAwsCliDynamoDriver({ run });
    }

    return provisionResource(contract, {
        driver,
        now: typeof deps.now === 'function' ? deps.now : undefined,
    });
}

module.exports = {
    provisionKernelTable,
    buildKernelTableContract,
    buildAwsScopedEnv,
    loadKernelConfig,
};

// -----------------------------------------------------------------------------
// CLI: `node .pipeline/lib/kernel-provision.js` (paso admin explícito).
// -----------------------------------------------------------------------------
if (require.main === module) {
    provisionKernelTable()
        .then((res) => {
            // No se vuelca el env ni las salidas crudas del CLI (SEC-A09): sólo
            // el status y la evidencia de alto nivel del round-trip.
            const summary = {
                status: res.status,
                driver: res.driver,
                tableName: res.evidence && res.evidence.resource && res.evidence.resource.tableName,
                roundTrip: res.evidence && res.evidence.roundTrip,
                diagnostics: (res.diagnostics || []).map((d) => d.stage),
            };
            process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
            process.exit(res.status === 'ok' ? 0 : 1);
        })
        .catch((err) => {
            // Error accionable (fail-closed): tableName o credenciales faltantes.
            process.stderr.write(`kernel-provision: ${err.message}\n`);
            process.exit(1);
        });
}

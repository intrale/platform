'use strict';

// =============================================================================
// provisioner-infra.js — Ejecutor genérico `provisioner_infra` (H2 · #4718)
//
// CONTEXTO
// --------
// H1 (#4717, doc `docs/pipeline/contrato-tarea-generico.md`) definió el
// **contrato de tarea genérico**: cuatro campos que separan *"qué prueba que la
// tarea está lista"* (`definicion_de_listo` + `evidencia_requerida`) de *"quién
// la ejecuta y qué produce"* (`tipo_entregable` + `ejecutor`). El diseño elevó
// los roles de código (`backend-dev`, `android-dev`, …) a **un** tipo de
// ejecutor entre varios: `dev_codigo`, que produce `tipo_entregable: codigo`.
//
// Este módulo implementa el **primer ejecutor de otro tipo** — `provisioner_infra`
// — que consume un contrato con `tipo_entregable: recurso_provisionado` y:
//   1. provisiona el recurso descripto (caso base: una tabla DynamoDB con el
//      schema pedido), y
//   2. genera la evidencia `describe_table_round_trip` (contrato §2.3): el
//      `describe-table` del recurso + un smoke test de round-trip
//      (escribo un ítem → lo leo → lo borro → confirmo que ya no está).
//
// El registro (§5 del contrato H1) agrega este tipo **sin tocar** el camino de
// los ejecutores de código: `resolveExecutorType()` devuelve `dev_codigo` para
// cualquier contrato ausente o de tipo `codigo` (retrocompat total — CA-3).
//
// DISEÑO — Ports & Adapters (contrato-kernel-adaptador.md §3)
// ----------------------------------------------------------
// El corazón es un **driver port** (`ResourceDriver`): la interfaz mínima que el
// provisioner necesita de un backend de recursos (createTable / describeTable /
// putItem / getItem / deleteItem). El módulo trae dos adapters:
//   - `createInMemoryDynamoDriver()`  — determinístico, sin red; base de los
//     tests y del smoke offline.
//   - `createAwsCliDynamoDriver({ run })` — adapter real que delega en la AWS
//     CLI (`aws dynamodb …`) vía un runner inyectable. `run` se inyecta para
//     testear sin AWS y para aislar el efecto (spawn con args, nunca shell).
//
// Convención de resultado (contrato §3): los errores se modelan como **datos**
// en el resultado (`status: 'failed'` + `diagnostics[]`), no como excepciones
// que crucen la frontera del puerto. `provisionResource()` nunca lanza por un
// contrato inválido o un fallo del driver: devuelve `status: 'failed'`.
// =============================================================================

const { Logger } = (() => {
    // Logger opcional: el pipeline no siempre expone LoggerFactory en Node.
    // Mantenemos un logger no-op silencioso; la trazabilidad real vive en el
    // resultado estructurado (artifacts/diagnostics/evidence).
    const noop = () => {};
    return { Logger: { info: noop, warn: noop, error: noop } };
})();

// -----------------------------------------------------------------------------
// Error tipado — fallo de escritura condicional (concurrencia optimista)
// -----------------------------------------------------------------------------

/**
 * Se lanza cuando un `putItem` con `ConditionExpression` NO cumple la condición
 * (p.ej. `attribute_not_exists(<pk>)` sobre una clave que ya existe). Es la
 * primitiva de coordinación segura multi-instancia (locking distribuido /
 * leader-election / dedup / firmas append-only).
 *
 * Es un error **tipado y exportado** a propósito: el consumidor lo distingue por
 * `instanceof ConditionalCheckFailedError` — nunca parseando strings de stderr
 * (#4743 REQ-3). Ambos adapters (in-memory y aws-cli) lanzan ESTE mismo tipo
 * para tener paridad de contrato (REQ-5). El manejo debe ser explícito
 * (retry/rechazo); prohibido swallow silencioso.
 */
class ConditionalCheckFailedError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ConditionalCheckFailedError';
    }
}

// -----------------------------------------------------------------------------
// Constantes del ejecutor / contrato
// -----------------------------------------------------------------------------

// Tipos de ejecutor del catálogo (contrato H1 §5). Abierto: se extiende sin
// romper el contrato. `dev_codigo` es el ejecutor histórico (cableado hoy).
const EXECUTOR_TYPE = Object.freeze({
    DEV_CODIGO: 'dev_codigo',
    PROVISIONER_INFRA: 'provisioner_infra',
});

// Tipos de entregable que este módulo entiende (contrato H1 §2.1).
const DELIVERABLE_TYPE = Object.freeze({
    CODIGO: 'codigo',
    RECURSO_PROVISIONADO: 'recurso_provisionado',
});

// Tipo de recurso soportado por el caso base (§ "Cambios requeridos" de #4718).
const RESOURCE_TYPE = Object.freeze({
    DYNAMODB_TABLE: 'dynamodb_table',
});

// Tipo de evidencia que produce este ejecutor (contrato H1 §2.3).
const EVIDENCE_TYPE = 'describe_table_round_trip';

// Estados del resultado (contrato-kernel-adaptador §3).
const STATUS = Object.freeze({ OK: 'ok', FAILED: 'failed', SKIPPED: 'skipped' });

// Tipos de atributo DynamoDB válidos para una key (S=string, N=number, B=binary).
const KEY_ATTR_TYPES = Object.freeze(['S', 'N', 'B']);

// Naming de tabla DynamoDB: 3–255 chars de [A-Za-z0-9_.-]. Se valida por
// corrección (no por shell: el driver CLI usa spawn con args, no string).
const TABLE_NAME_RE = /^[A-Za-z0-9_.-]{3,255}$/;
const ATTR_NAME_RE = /^[A-Za-z0-9_.-]{1,255}$/;

// -----------------------------------------------------------------------------
// Normalización del contrato (retrocompat — contrato H1 §4)
// -----------------------------------------------------------------------------

/**
 * Devuelve el `ejecutor.tipo` que corresponde a un contrato.
 *
 * Retrocompatibilidad (CA-3): un contrato **ausente**, vacío, o con
 * `tipo_entregable: codigo` resuelve a `dev_codigo` — exactamente el
 * comportamiento cableado de hoy. Sólo `tipo_entregable: recurso_provisionado`
 * (o un `ejecutor.tipo` explícito) enruta a un ejecutor distinto.
 *
 * @param {object|null|undefined} contract
 * @returns {string} un valor de EXECUTOR_TYPE
 */
function resolveExecutorType(contract) {
    if (!contract || typeof contract !== 'object') return EXECUTOR_TYPE.DEV_CODIGO;

    // `ejecutor.tipo` explícito manda si está presente y es conocido.
    const explicit = contract.ejecutor && contract.ejecutor.tipo;
    if (explicit === EXECUTOR_TYPE.PROVISIONER_INFRA) return EXECUTOR_TYPE.PROVISIONER_INFRA;
    if (explicit === EXECUTOR_TYPE.DEV_CODIGO) return EXECUTOR_TYPE.DEV_CODIGO;

    // Si no hay ejecutor explícito, se deriva del tipo de entregable.
    if (contract.tipo_entregable === DELIVERABLE_TYPE.RECURSO_PROVISIONADO) {
        return EXECUTOR_TYPE.PROVISIONER_INFRA;
    }

    // Ausente / `codigo` / desconocido ⇒ default histórico `codigo`.
    return EXECUTOR_TYPE.DEV_CODIGO;
}

/**
 * `true` si el contrato lo maneja el lifecycle de código actual (rama → diff →
 * build → QA → PR). Los ejecutores de código NO deben pasar por este módulo.
 */
function isCodeExecutor(contract) {
    return resolveExecutorType(contract) === EXECUTOR_TYPE.DEV_CODIGO;
}

// -----------------------------------------------------------------------------
// Validación del contrato de recurso provisionado
// -----------------------------------------------------------------------------

/**
 * Valida la porción del contrato que describe el recurso a provisionar.
 * Devuelve `{ ok, errors[], spec }` — NUNCA lanza (errores como datos).
 *
 * Forma esperada del contrato:
 *   tipo_entregable: recurso_provisionado
 *   recurso:
 *     tipo: dynamodb_table
 *     nombre: <TableName>
 *     schema:
 *       hashKey:  { nombre: pk, tipo: S }
 *       rangeKey: { nombre: sk, tipo: S }   # opcional
 */
function validateResourceContract(contract) {
    const errors = [];
    if (!contract || typeof contract !== 'object') {
        return { ok: false, errors: ['contrato ausente o no es un objeto'], spec: null };
    }
    if (contract.tipo_entregable !== DELIVERABLE_TYPE.RECURSO_PROVISIONADO) {
        errors.push(
            `tipo_entregable debe ser "${DELIVERABLE_TYPE.RECURSO_PROVISIONADO}", ` +
            `recibido "${contract.tipo_entregable}"`,
        );
    }
    const recurso = contract.recurso;
    if (!recurso || typeof recurso !== 'object') {
        errors.push('falta la sección "recurso" que describe el recurso a provisionar');
        return { ok: false, errors, spec: null };
    }
    if (recurso.tipo !== RESOURCE_TYPE.DYNAMODB_TABLE) {
        errors.push(
            `recurso.tipo no soportado: "${recurso.tipo}" ` +
            `(soportado: ${RESOURCE_TYPE.DYNAMODB_TABLE})`,
        );
    }
    if (typeof recurso.nombre !== 'string' || !TABLE_NAME_RE.test(recurso.nombre)) {
        errors.push(
            `recurso.nombre inválido: "${recurso.nombre}" ` +
            '(3–255 chars de [A-Za-z0-9_.-])',
        );
    }

    const schema = recurso.schema;
    const keys = [];
    if (!schema || typeof schema !== 'object') {
        errors.push('falta recurso.schema con al menos hashKey');
    } else {
        const hk = validateKey(schema.hashKey, 'hashKey', 'HASH', errors);
        if (hk) keys.push(hk);
        if (schema.rangeKey != null) {
            const rk = validateKey(schema.rangeKey, 'rangeKey', 'RANGE', errors);
            if (rk) keys.push(rk);
        }
    }

    if (errors.length) return { ok: false, errors, spec: null };

    return {
        ok: true,
        errors: [],
        spec: {
            type: RESOURCE_TYPE.DYNAMODB_TABLE,
            tableName: recurso.nombre,
            keys, // [{ name, attributeType, keyType }]
        },
    };
}

function validateKey(raw, label, keyType, errors) {
    if (!raw || typeof raw !== 'object') {
        errors.push(`schema.${label} ausente o no es un objeto`);
        return null;
    }
    if (typeof raw.nombre !== 'string' || !ATTR_NAME_RE.test(raw.nombre)) {
        errors.push(`schema.${label}.nombre inválido: "${raw.nombre}"`);
        return null;
    }
    const attrType = raw.tipo;
    if (!KEY_ATTR_TYPES.includes(attrType)) {
        errors.push(
            `schema.${label}.tipo inválido: "${attrType}" ` +
            `(válidos: ${KEY_ATTR_TYPES.join(', ')})`,
        );
        return null;
    }
    return { name: raw.nombre, attributeType: attrType, keyType };
}

// -----------------------------------------------------------------------------
// Driver in-memory (base de tests y smoke offline)
// -----------------------------------------------------------------------------

/**
 * Driver de recursos en memoria. Implementa el `ResourceDriver` port de forma
 * determinística y sin red. Cada método devuelve un objeto plano; los métodos
 * de lectura/escritura pueden lanzar si se los usa mal — el orquestador los
 * envuelve y convierte a diagnostics.
 */
function createInMemoryDynamoDriver() {
    /** @type {Map<string, {description: object, items: Map<string, object>}>} */
    const tables = new Map();

    function keyOf(spec, item) {
        return spec.keys.map((k) => `${k.name}=${JSON.stringify(item[k.name])}`).join('|');
    }

    return {
        kind: 'in-memory',

        async createTable(spec) {
            if (!tables.has(spec.tableName)) {
                tables.set(spec.tableName, {
                    description: buildTableDescription(spec, 'ACTIVE'),
                    items: new Map(),
                });
            }
            return { created: true, existed: tables.has(spec.tableName) };
        },

        async describeTable(spec) {
            const t = tables.get(spec.tableName);
            if (!t) throw new Error(`tabla inexistente: ${spec.tableName}`);
            return { Table: t.description };
        },

        async putItem(spec, item, opts = {}) {
            const t = tables.get(spec.tableName);
            if (!t) throw new Error(`tabla inexistente: ${spec.tableName}`);
            // Concurrencia optimista: si el caller pide una condición, replicamos
            // la semántica `attribute_not_exists(<pk>)` — la escritura sólo
            // procede si la clave NO existe todavía. Da paridad con aws-cli para
            // testear append-only / leader-election sin AWS (#4743 REQ-5).
            if (opts.conditionExpression && t.items.has(keyOf(spec, item))) {
                throw new ConditionalCheckFailedError(
                    `condición fallida en put-item ${spec.tableName}: ${opts.conditionExpression}`);
            }
            t.items.set(keyOf(spec, item), JSON.parse(JSON.stringify(item)));
            return { ok: true };
        },

        async getItem(spec, key) {
            const t = tables.get(spec.tableName);
            if (!t) throw new Error(`tabla inexistente: ${spec.tableName}`);
            const found = t.items.get(keyOf(spec, key));
            return { item: found ? JSON.parse(JSON.stringify(found)) : null };
        },

        async deleteItem(spec, key) {
            const t = tables.get(spec.tableName);
            if (!t) throw new Error(`tabla inexistente: ${spec.tableName}`);
            t.items.delete(keyOf(spec, key));
            return { ok: true };
        },
    };
}

/** Construye la descripción de tabla al estilo `describe-table` de DynamoDB. */
function buildTableDescription(spec, status) {
    return {
        TableName: spec.tableName,
        TableStatus: status,
        KeySchema: spec.keys.map((k) => ({ AttributeName: k.name, KeyType: k.keyType })),
        AttributeDefinitions: spec.keys.map((k) => ({
            AttributeName: k.name,
            AttributeType: k.attributeType,
        })),
    };
}

// -----------------------------------------------------------------------------
// Driver AWS CLI (adapter real, runner inyectable)
// -----------------------------------------------------------------------------

/**
 * Driver que delega en la AWS CLI (`aws dynamodb …`). El efecto se aísla en un
 * runner `run(args) => Promise<{ code, stdout, stderr }>` inyectable:
 *   - en producción, `run` hace `spawn('aws', ['dynamodb', ...args])` (nunca
 *     shell string ⇒ sin inyección de comandos, contrato §"seguridad").
 *   - en test, `run` es un fake que devuelve JSON canned.
 *
 * Se mantiene fino a propósito: traduce el `spec`/`item` al vocabulario CLI y
 * parsea el JSON de salida. Los nombres ya vienen validados por
 * `validateResourceContract` (allowlist de chars), así que no se interpolan
 * datos crudos del issue.
 */
function createAwsCliDynamoDriver({ run } = {}) {
    if (typeof run !== 'function') {
        throw new Error('createAwsCliDynamoDriver requiere un runner `run(args)`');
    }

    async function cli(args) {
        const res = await run(args);
        const code = res && typeof res.code === 'number' ? res.code : 0;
        if (code !== 0) {
            const err = (res && res.stderr) || `aws dynamodb ${args[0]} exit ${code}`;
            const raw = String(err).trim();
            // Mapeo fail-closed (#4743 REQ-4): sólo un match preciso con
            // word-boundary de `ConditionalCheckFailedException` se degrada al
            // error tipado. Cualquier otro stderr (AccessDenied, throttling,
            // ResourceInUse…) se re-lanza como Error genérico preservando el
            // stderr original — nunca se confunde un fallo real de infra con
            // una condición fallida.
            if (/\bConditionalCheckFailedException\b/.test(raw)) {
                throw new ConditionalCheckFailedError(raw);
            }
            throw new Error(raw);
        }
        const out = (res && res.stdout) || '';
        return out.trim() ? JSON.parse(out) : {};
    }

    return {
        kind: 'aws-cli',

        async createTable(spec) {
            const attrDefs = spec.keys.map((k) => `AttributeName=${k.name},AttributeType=${k.attributeType}`);
            const keySchema = spec.keys.map((k) => `AttributeName=${k.name},KeyType=${k.keyType}`);
            await cli([
                'create-table',
                '--table-name', spec.tableName,
                '--attribute-definitions', ...attrDefs,
                '--key-schema', ...keySchema,
                '--billing-mode', 'PAY_PER_REQUEST',
            ]);
            return { created: true };
        },

        async describeTable(spec) {
            return cli(['describe-table', '--table-name', spec.tableName]);
        },

        async putItem(spec, item, opts = {}) {
            const args = ['put-item', '--table-name', spec.tableName,
                '--item', JSON.stringify(toAttrValues(item))];
            // Escritura condicional (concurrencia optimista). Cada flag va como
            // ELEMENTO SEPARADO del array `args` que consume `run(args)` →
            // `spawn` — cero interpolación en shell string (#4743 REQ-1, A03).
            // El `conditionExpression` es constante de código con placeholders
            // (`#pk`, `:v`); los valores se serializan con `toAttrValues`
            // (formato AttributeValue), nunca como string plano (REQ-2).
            if (opts.conditionExpression) {
                args.push('--condition-expression', opts.conditionExpression);
                if (opts.expressionAttributeValues) {
                    args.push('--expression-attribute-values',
                        JSON.stringify(toAttrValues(opts.expressionAttributeValues)));
                }
                if (opts.expressionAttributeNames) {
                    args.push('--expression-attribute-names',
                        JSON.stringify(opts.expressionAttributeNames));
                }
            }
            await cli(args);
            return { ok: true };
        },

        async getItem(spec, key) {
            const res = await cli([
                'get-item', '--table-name', spec.tableName,
                '--key', JSON.stringify(toAttrValues(key)), '--consistent-read',
            ]);
            return { item: res && res.Item ? fromAttrValues(res.Item) : null };
        },

        async deleteItem(spec, key) {
            await cli(['delete-item', '--table-name', spec.tableName, '--key', JSON.stringify(toAttrValues(key))]);
            return { ok: true };
        },
    };
}

/** Convierte un ítem plano a formato AttributeValue de DynamoDB (S/N/BOOL). */
function toAttrValues(item) {
    const out = {};
    for (const [k, v] of Object.entries(item)) {
        if (typeof v === 'number') out[k] = { N: String(v) };
        else if (typeof v === 'boolean') out[k] = { BOOL: v };
        else out[k] = { S: String(v) };
    }
    return out;
}

/** Inverso de `toAttrValues` para un ítem devuelto por get-item. */
function fromAttrValues(attrItem) {
    const out = {};
    for (const [k, v] of Object.entries(attrItem)) {
        if (v == null) continue;
        if ('N' in v) out[k] = Number(v.N);
        else if ('BOOL' in v) out[k] = Boolean(v.BOOL);
        else out[k] = v.S;
    }
    return out;
}

// -----------------------------------------------------------------------------
// Smoke item determinístico
// -----------------------------------------------------------------------------

/**
 * Construye el ítem de smoke a partir de las keys del schema. Valores acordes al
 * tipo de atributo para que el round-trip funcione con cualquier key válida.
 */
function buildSmokeItem(spec, marker) {
    const item = {};
    for (const k of spec.keys) {
        if (k.attributeType === 'N') item[k.name] = 0;
        else item[k.name] = `provisioner-smoke-${k.keyType.toLowerCase()}`;
    }
    // Atributo-sonda no-key: prueba que el ítem se persiste completo.
    item.__provisioner_smoke = marker;
    return item;
}

/** Extrae sólo los atributos-key de un ítem (para get/delete). */
function keyOnly(spec, item) {
    const key = {};
    for (const k of spec.keys) key[k.name] = item[k.name];
    return key;
}

// -----------------------------------------------------------------------------
// Orquestador: provisión + evidencia
// -----------------------------------------------------------------------------

/**
 * Provisiona el recurso descripto en el contrato y genera la evidencia
 * `describe_table_round_trip`. NUNCA lanza: devuelve un resultado estructurado
 * con `status` (`ok`/`failed`), `artifacts[]`, `diagnostics[]` y `evidence`.
 *
 * @param {object} contract  Contrato de tarea con tipo_entregable=recurso_provisionado.
 * @param {object} deps
 * @param {object} deps.driver  ResourceDriver (default: in-memory).
 * @param {function} [deps.now] Fuente de tiempo para el marker del smoke (test).
 * @returns {Promise<object>} resultado estructurado.
 */
async function provisionResource(contract, deps = {}) {
    const driver = deps.driver || createInMemoryDynamoDriver();
    const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
    const diagnostics = [];

    const base = {
        tipo_entregable: DELIVERABLE_TYPE.RECURSO_PROVISIONADO,
        ejecutor: EXECUTOR_TYPE.PROVISIONER_INFRA,
        driver: driver.kind || 'unknown',
        evidenceType: EVIDENCE_TYPE,
    };

    // 1. Validación del contrato (errores como datos, no excepción).
    const { ok, errors, spec } = validateResourceContract(contract);
    if (!ok) {
        return {
            ...base,
            status: STATUS.FAILED,
            artifacts: [],
            diagnostics: errors.map((e) => ({ stage: 'validate', message: e })),
            evidence: null,
        };
    }

    const evidence = {
        type: EVIDENCE_TYPE,
        resource: { type: spec.type, tableName: spec.tableName },
        describeTable: null,
        roundTrip: {
            create: false,
            read: false,
            delete: false,
            confirmedGone: false,
        },
    };

    try {
        // 2. Provisión (idempotente).
        await driver.createTable(spec);

        // 3. Evidencia: describe-table con el schema pedido.
        const described = await driver.describeTable(spec);
        evidence.describeTable = described;

        // Aserción de schema: el describe refleja las keys pedidas.
        assertSchemaMatches(spec, described, diagnostics);

        // 4. Smoke round-trip: create → read → delete → confirmar ausencia.
        const marker = `rt-${now()}`;
        const item = buildSmokeItem(spec, marker);
        const key = keyOnly(spec, item);

        await driver.putItem(spec, item);
        evidence.roundTrip.create = true;

        const read = await driver.getItem(spec, key);
        const readItem = read && read.item;
        evidence.roundTrip.read =
            !!readItem && readItem.__provisioner_smoke === marker;
        if (!evidence.roundTrip.read) {
            diagnostics.push({
                stage: 'round-trip:read',
                message: 'el ítem leído no coincide con el escrito (marker mismatch)',
            });
        }

        await driver.deleteItem(spec, key);
        evidence.roundTrip.delete = true;

        const afterDelete = await driver.getItem(spec, key);
        evidence.roundTrip.confirmedGone = !(afterDelete && afterDelete.item);
        if (!evidence.roundTrip.confirmedGone) {
            diagnostics.push({
                stage: 'round-trip:confirm',
                message: 'el ítem sigue presente tras el delete',
            });
        }
    } catch (e) {
        diagnostics.push({ stage: 'provision', message: String(e && e.message ? e.message : e) });
        return {
            ...base,
            status: STATUS.FAILED,
            artifacts: [artifactFromEvidence(evidence)],
            diagnostics,
            evidence,
        };
    }

    const roundTripOk =
        evidence.roundTrip.create &&
        evidence.roundTrip.read &&
        evidence.roundTrip.delete &&
        evidence.roundTrip.confirmedGone;
    const schemaOk = !diagnostics.some((d) => d.stage === 'describe');
    const status = roundTripOk && schemaOk ? STATUS.OK : STATUS.FAILED;

    return {
        ...base,
        status,
        artifacts: [artifactFromEvidence(evidence)],
        diagnostics,
        evidence,
    };
}

/** Compara el describe-table contra el schema pedido; anota diagnostics. */
function assertSchemaMatches(spec, described, diagnostics) {
    const table = described && described.Table;
    if (!table) {
        diagnostics.push({ stage: 'describe', message: 'describe-table sin campo Table' });
        return;
    }
    if (table.TableName !== spec.tableName) {
        diagnostics.push({
            stage: 'describe',
            message: `TableName esperado "${spec.tableName}", recibido "${table.TableName}"`,
        });
    }
    const keySchema = Array.isArray(table.KeySchema) ? table.KeySchema : [];
    for (const k of spec.keys) {
        const match = keySchema.find(
            (ks) => ks.AttributeName === k.name && ks.KeyType === k.keyType,
        );
        if (!match) {
            diagnostics.push({
                stage: 'describe',
                message: `falta key ${k.keyType} "${k.name}" en el describe-table`,
            });
        }
    }
}

/** Representa la evidencia como un artefacto observable (contrato §2.3). */
function artifactFromEvidence(evidence) {
    return {
        type: EVIDENCE_TYPE,
        tableName: evidence.resource.tableName,
        describeTable: evidence.describeTable,
        roundTrip: evidence.roundTrip,
    };
}

// -----------------------------------------------------------------------------
// Registro de ejecutores (contrato H1 §5) — aditivo, no rompe code executors
// -----------------------------------------------------------------------------

// Handler del ejecutor de código: passthrough explícito. NO ejecuta lógica de
// provisión; declara que el contrato lo maneja el lifecycle de código actual
// (rama → diff → build → QA → PR). Existe para que el registro sea completo sin
// alterar el camino cableado (CA-3).
function codeExecutorHandler() {
    return {
        status: STATUS.SKIPPED,
        ejecutor: EXECUTOR_TYPE.DEV_CODIGO,
        tipo_entregable: DELIVERABLE_TYPE.CODIGO,
        reason: 'ejecutor de código: lo maneja el lifecycle cableado (rama/diff/build/QA/PR)',
        handledByCodeLifecycle: true,
    };
}

// Registro tipo → handler. Abierto a nuevos tipos sin tocar los existentes.
const EXECUTOR_REGISTRY = Object.freeze({
    [EXECUTOR_TYPE.DEV_CODIGO]: codeExecutorHandler,
    [EXECUTOR_TYPE.PROVISIONER_INFRA]: provisionResource,
});

/** Devuelve el handler registrado para un tipo de ejecutor, o `null`. */
function getExecutor(type) {
    return Object.prototype.hasOwnProperty.call(EXECUTOR_REGISTRY, type)
        ? EXECUTOR_REGISTRY[type]
        : null;
}

/**
 * Punto de entrada del registro: resuelve el ejecutor por contrato y lo corre.
 *
 * - Contrato ausente / `codigo` ⇒ `dev_codigo` passthrough (`status: skipped`,
 *   `handledByCodeLifecycle: true`): el lifecycle de código sigue intacto.
 * - `recurso_provisionado` ⇒ `provisioner_infra`: provisiona + evidencia.
 *
 * @param {object} contract
 * @param {object} deps  se pasa tal cual al handler (driver, now, …).
 */
async function runExecutor(contract, deps = {}) {
    const type = resolveExecutorType(contract);
    const handler = getExecutor(type);
    if (!handler) {
        return {
            status: STATUS.FAILED,
            ejecutor: type,
            diagnostics: [{ stage: 'resolve', message: `ejecutor no registrado: ${type}` }],
        };
    }
    return handler(contract, deps);
}

// -----------------------------------------------------------------------------
module.exports = {
    // constantes
    EXECUTOR_TYPE,
    DELIVERABLE_TYPE,
    RESOURCE_TYPE,
    EVIDENCE_TYPE,
    STATUS,
    // resolución / retrocompat
    resolveExecutorType,
    isCodeExecutor,
    // validación
    validateResourceContract,
    // drivers
    createInMemoryDynamoDriver,
    createAwsCliDynamoDriver,
    buildTableDescription,
    toAttrValues,
    fromAttrValues,
    ConditionalCheckFailedError,
    // ejecución
    provisionResource,
    buildSmokeItem,
    // registro
    EXECUTOR_REGISTRY,
    getExecutor,
    runExecutor,
    // logger (para testear que existe la convención)
    Logger,
};

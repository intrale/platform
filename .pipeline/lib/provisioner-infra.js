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

// Marcador para condiciones que el evaluador in-memory NO sabe interpretar
// (p.ej. `OR`, comparadores `<`/`>`). En ese caso se cae al comportamiento
// legacy conservador (rechazar sólo si la clave ya existe), que preserva la
// semántica histórica de `attribute_not_exists(...)` sin sobre-prometer CAS.
const _UNSUPPORTED_CONDITION = Symbol('unsupported-condition');

// Resuelve una referencia de atributo (posiblemente anidada `#a.#b`) a la lista
// de segmentos reales, traduciendo cada `#name` por `expressionAttributeNames`.
function _resolveAttrRef(ref, names) {
    return String(ref).split('.').map((seg) => {
        const s = seg.trim();
        if (s.startsWith('#')) {
            const mapped = names && Object.prototype.hasOwnProperty.call(names, s) ? names[s] : null;
            return mapped != null ? mapped : s.slice(1);
        }
        return s;
    });
}

// Navega `obj` por la lista de segmentos; devuelve undefined si el path no existe.
function _getByPath(obj, segments) {
    let cur = obj;
    for (const seg of segments) {
        if (cur == null || typeof cur !== 'object') return undefined;
        cur = cur[seg];
    }
    return cur;
}

/**
 * Evalúa una ConditionExpression de DynamoDB de forma offline y determinística.
 * Soporta el subconjunto que usa el kernel para writes atómicos:
 *   - `attribute_not_exists(<ref>)` / `attribute_exists(<ref>)`
 *   - igualdad `<ref> = :placeholder` (incluye paths anidados `#b.#v`)
 *   - conjunción por ` AND `
 * Devuelve `true`/`false`, o `_UNSUPPORTED_CONDITION` si la expresión usa formas
 * que este evaluador no interpreta (OR, comparadores relacionales, etc.).
 *
 * `existing` es el ítem persistido (o `undefined` si la clave no existe).
 */
function _evaluateCondition(opts, existing) {
    const expr = String(opts.conditionExpression || '').trim();
    if (!expr) return true;
    // Formas no soportadas → delegar a la política legacy del caller.
    if (/\bOR\b/i.test(expr) || /[<>]/.test(expr)) return _UNSUPPORTED_CONDITION;

    const names = opts.expressionAttributeNames || {};
    const values = opts.expressionAttributeValues || {};
    const terms = expr.split(/\bAND\b/i).map((t) => t.trim()).filter(Boolean);

    for (const term of terms) {
        let m;
        if ((m = /^attribute_not_exists\(\s*(.+?)\s*\)$/i.exec(term))) {
            const v = existing === undefined ? undefined : _getByPath(existing, _resolveAttrRef(m[1], names));
            if (v !== undefined) return false;
        } else if ((m = /^attribute_exists\(\s*(.+?)\s*\)$/i.exec(term))) {
            const v = existing === undefined ? undefined : _getByPath(existing, _resolveAttrRef(m[1], names));
            if (v === undefined) return false;
        } else if ((m = /^(.+?)\s*=\s*(:[A-Za-z0-9_]+)$/.exec(term))) {
            if (existing === undefined) return false;
            const actual = _getByPath(existing, _resolveAttrRef(m[1].trim(), names));
            const expected = values[m[2]];
            if (!Object.is(actual, expected)) return false;
        } else {
            return _UNSUPPORTED_CONDITION;
        }
    }
    return true;
}

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
            // Concurrencia optimista: replicamos la semántica de la
            // ConditionExpression para dar paridad con aws-cli (#4743 REQ-5).
            // Además de `attribute_not_exists(<pk>)` (create-once / leader
            // election), ahora evaluamos igualdad (`#b.#v = :ev`) para que el
            // CAS atómico por versión/owner sea real offline (#4777 CA-1/CA-3,
            // R1/SEC-2: sin esto el test de concurrencia daba falso verde).
            if (opts.conditionExpression) {
                const k = keyOf(spec, item);
                const existing = t.items.get(k);
                const verdict = _evaluateCondition(opts, existing);
                // Forma no soportada → política legacy conservadora: rechazar
                // sólo si la clave ya existe (preserva el comportamiento
                // histórico de `attribute_not_exists(...) OR ...`).
                const pass = verdict === _UNSUPPORTED_CONDITION ? existing === undefined : verdict;
                if (!pass) {
                    throw new ConditionalCheckFailedError(
                        `condición fallida en put-item ${spec.tableName}: ${opts.conditionExpression}`);
                }
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

        // #5209 — Query paginada por partición + prefijo de sort key.
        //
        // La reconciliación de `signature#`/`audit#` (append-only, no-repudio)
        // necesita LEER TODO lo escrito, y `getItem` sólo sabe traer una clave
        // conocida. Sin esta primitiva el export salía vacío y la paridad daba
        // falso verde por conjunto vacío, que es exactamente el riesgo que
        // #5209 existe para cerrar.
        //
        // Contrato (idéntico en ambos drivers): filtra por PK exacta y
        // `begins_with(SK, prefix)`, ordena por SK ascendente (determinístico) y
        // devuelve `{ items, lastEvaluatedKey }`. `lastEvaluatedKey` es `null`
        // cuando NO quedan páginas — el caller pagina hasta verlo en `null`.
        async query(spec, params = {}) {
            const t = tables.get(spec.tableName);
            if (!t) throw new Error(`tabla inexistente: ${spec.tableName}`);
            const pk = params.partitionKey;
            const prefix = typeof params.skPrefix === 'string' ? params.skPrefix : '';
            const all = [];
            for (const it of t.items.values()) {
                if (it.PK !== pk) continue;
                if (prefix && !String(it.SK).startsWith(prefix)) continue;
                all.push(JSON.parse(JSON.stringify(it)));
            }
            all.sort((a, b) => (String(a.SK) < String(b.SK) ? -1 : String(a.SK) > String(b.SK) ? 1 : 0));
            const startSk = params.exclusiveStartKey && params.exclusiveStartKey.SK;
            const from = startSk == null ? 0 : all.findIndex((it) => String(it.SK) > String(startSk));
            const rest = from < 0 ? [] : all.slice(from);
            const limit = Number.isFinite(params.limit) && params.limit > 0 ? Math.floor(params.limit) : rest.length;
            const page = rest.slice(0, limit);
            const hasMore = rest.length > page.length;
            const last = hasMore && page.length ? { PK: page[page.length - 1].PK, SK: page[page.length - 1].SK } : null;
            return { items: page, lastEvaluatedKey: last };
        },

        async deleteItem(spec, key, opts = {}) {
            const t = tables.get(spec.tableName);
            if (!t) throw new Error(`tabla inexistente: ${spec.tableName}`);
            const k = keyOf(spec, key);
            // Delete condicional (ownership atómico del release, #4777 CA-3):
            // sólo borra si la condición se cumple sobre el ítem persistido.
            if (opts.conditionExpression) {
                const existing = t.items.get(k);
                const verdict = _evaluateCondition(opts, existing);
                const pass = verdict === _UNSUPPORTED_CONDITION ? existing !== undefined : verdict;
                if (!pass) {
                    throw new ConditionalCheckFailedError(
                        `condición fallida en delete-item ${spec.tableName}: ${opts.conditionExpression}`);
                }
            }
            t.items.delete(k);
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
// Runner de producción AWS CLI (adapter real del puerto `run`)
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// #5113 - Armado de args de DynamoDB: FUENTE UNICA compartida async/sync
// -----------------------------------------------------------------------------
//
// El driver async (`createAwsCliDynamoDriver`) y el sincrono (`...Sync`, que
// consume `operational-state-backend.js`) comparten ESTAS funciones. Es
// deliberado: dos implementaciones del mismo `ConditionExpression` derivan con
// el tiempo y una de las dos termina perdiendo la garantia anti-inyeccion. La
// garantia vive aca, una sola vez:
//   - cada flag y cada valor viaja como ELEMENTO SEPARADO del array -> `spawn`
//     con `shell: false`; jamas se interpola en un shell string (A03).
//   - las expresiones son CONSTANTES de codigo con placeholders (`#pk`, `:ev`);
//     los valores se serializan con `toAttrValues` (formato AttributeValue).
// Un test compara los args de los dos caminos: si divergen, falla.

function appendConditionArgs(args, opts) {
    if (!opts || !opts.conditionExpression) return args;
    args.push('--condition-expression', opts.conditionExpression);
    if (opts.expressionAttributeValues) {
        args.push('--expression-attribute-values',
            JSON.stringify(toAttrValues(opts.expressionAttributeValues)));
    }
    if (opts.expressionAttributeNames) {
        args.push('--expression-attribute-names',
            JSON.stringify(opts.expressionAttributeNames));
    }
    return args;
}

/** Args de `aws dynamodb put-item` (con escritura condicional opcional). */
function buildPutItemArgs(spec, item, opts = {}) {
    const args = ['put-item', '--table-name', spec.tableName,
        '--item', JSON.stringify(toAttrValues(item))];
    return appendConditionArgs(args, opts);
}

/** Args de `aws dynamodb get-item` (siempre `--consistent-read`). */
function buildGetItemArgs(spec, key) {
    return ['get-item', '--table-name', spec.tableName,
        '--key', JSON.stringify(toAttrValues(key)), '--consistent-read'];
}

/** Args de `aws dynamodb delete-item` (con delete condicional opcional). */
function buildDeleteItemArgs(spec, key, opts = {}) {
    const args = ['delete-item', '--table-name', spec.tableName,
        '--key', JSON.stringify(toAttrValues(key))];
    return appendConditionArgs(args, opts);
}

/**
 * Traduce el resultado crudo de la CLI (`{code, stdout, stderr}`) al contrato
 * del driver. Compartido async/sync para que el mapeo fail-closed de
 * `ConditionalCheckFailedException` (#4743 REQ-4) tenga UNA definicion.
 */
function parseCliResult(res, args) {
    const code = res && typeof res.code === 'number' ? res.code : 0;
    if (code !== 0) {
        const err = (res && res.stderr) || `aws dynamodb ${args[0]} exit ${code}`;
        const raw = String(err).trim();
        // Mapeo fail-closed (#4743 REQ-4): solo un match preciso con
        // word-boundary de `ConditionalCheckFailedException` se degrada al
        // error tipado. Cualquier otro stderr (AccessDenied, throttling,
        // ResourceInUse) se re-lanza como Error generico preservando el stderr
        // original: nunca se confunde un fallo real de infra con una condicion
        // fallida.
        if (/\bConditionalCheckFailedException\b/.test(raw)) {
            throw new ConditionalCheckFailedError(raw);
        }
        throw new Error(raw);
    }
    const out = (res && res.stdout) || '';
    return out.trim() ? JSON.parse(out) : {};
}

/**
 * Runner de producción que materializa el puerto `run(args)` que consume
 * `createAwsCliDynamoDriver({ run })`. Hace `spawn('aws', ['dynamodb', ...args])`
 * (async, promisificado) y resuelve `{ code, stdout, stderr }`.
 *
 * Contratos de seguridad (#4820 CA-1/CA-3, SEC-A02/A03):
 *   - `args` viaja como ELEMENTOS SEPARADOS del array a `spawn`; nunca se
 *     interpola en un shell string. `shell: false` explícito ⇒ sin inyección
 *     de comandos (A03), aunque un valor traiga metacaracteres (`;`, `$()`,
 *     backtick) llegan literales al proceso hijo.
 *   - Fail-closed de credenciales ANTES de spawnear: si el `env` (scope `aws`
 *     del ambiente hijo, `build-child-env.js`) no aporta `AWS_ACCESS_KEY_ID` +
 *     `AWS_SECRET_ACCESS_KEY`, lanza un error accionable y NO invoca el CLI
 *     con credenciales vacías (evita prompts interactivos / uso de credenciales
 *     ambientales inesperadas).
 *   - Sólo el `env` explícito del scope `aws` llega al hijo; NUNCA se mergea
 *     `process.env` crudo. El `env`/salidas crudas no se loggean acá (SEC-A09):
 *     el mapeo `{code, stdout, stderr}` se devuelve al caller, que decide qué
 *     registrar (redactando).
 *
 * @param {object} env  Env del scope `aws` (AWS_ACCESS_KEY_ID/…); NO `process.env`.
 * @param {object} [deps]
 * @param {function} [deps.spawn]  Inyección de `child_process.spawn` (tests).
 * @returns {{ run: (args: string[]) => Promise<{code:number,stdout:string,stderr:string}> }}
 */
function createAwsCliRunner(env, deps = {}) {
    // Fail-closed de credenciales ANTES de spawnear (SEC-A02 / CA-3).
    if (!env || !env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
        throw new Error(
            'createAwsCliRunner: faltan credenciales AWS (scope `aws` del ambiente hijo, '
            + 'build-child-env.js: AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY). Fail-closed: '
            + 'no se invoca la AWS CLI con credenciales vacías.',
        );
    }
    // Lazy require: mantiene el módulo cargable en cualquier contexto Node y
    // permite inyectar un `spawn` fake en tests sin mockear el módulo global.
    const spawn = typeof deps.spawn === 'function'
        ? deps.spawn
        : require('child_process').spawn;

    return {
        run(args) {
            return new Promise((resolve, reject) => {
                // `dynamodb` es el token fijo; `args` (flags como elementos
                // separados) NO se interpolan en shell string (A03 / CA-1).
                const child = spawn('aws', ['dynamodb', ...args], {
                    env,           // SÓLO el scope `aws`; nunca merge con process.env crudo.
                    shell: false,  // PROHIBIDO shell:true (evita inyección de comandos).
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

    // #5113 - el mapeo fail-closed de `ConditionalCheckFailedException` vive
    // en `parseCliResult`, compartido con el driver sincrono.
    async function cli(args) {
        return parseCliResult(await run(args), args);
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

        // #5113 - args armados por la funcion pura compartida con el driver sync.
        async putItem(spec, item, opts = {}) {
            await cli(buildPutItemArgs(spec, item, opts));
            return { ok: true };
        },

        async getItem(spec, key) {
            const res = await cli(buildGetItemArgs(spec, key));
            return { item: res && res.Item ? fromAttrValues(res.Item) : null };
        },

        // #5209 — Query paginada (ver contrato en el driver in-memory).
        //
        // `--key-condition-expression` es una CONSTANTE de código con
        // placeholders (`#pk`, `#sk`, `:pk`, `:pfx`): ni el nombre de atributo
        // ni los valores se interpolan en el string, y cada flag viaja como
        // ELEMENTO SEPARADO del array que consume `run(args)` → `spawn`. Cero
        // superficie de inyección de shell / de expresión (A03).
        async query(spec, params = {}) {
            const args = [
                'query', '--table-name', spec.tableName,
                '--key-condition-expression', '#pk = :pk AND begins_with(#sk, :pfx)',
                '--expression-attribute-names', JSON.stringify({ '#pk': 'PK', '#sk': 'SK' }),
                '--expression-attribute-values', JSON.stringify(toAttrValues({
                    ':pk': params.partitionKey,
                    ':pfx': typeof params.skPrefix === 'string' ? params.skPrefix : '',
                })),
                '--consistent-read',
            ];
            if (Number.isFinite(params.limit) && params.limit > 0) {
                args.push('--limit', String(Math.floor(params.limit)));
            }
            if (params.exclusiveStartKey) {
                args.push('--exclusive-start-key', JSON.stringify(toAttrValues(params.exclusiveStartKey)));
            }
            const res = await cli(args);
            const items = Array.isArray(res && res.Items) ? res.Items.map(fromAttrValues) : [];
            const lek = res && res.LastEvaluatedKey ? fromAttrValues(res.LastEvaluatedKey) : null;
            return { items, lastEvaluatedKey: lek };
        },

        // #5113 - delete condicional (ownership atomico del release, #4777 CA-3)
        // con los mismos args puros que usa el camino sincrono.
        async deleteItem(spec, key, opts = {}) {
            await cli(buildDeleteItemArgs(spec, key, opts));
            return { ok: true };
        },
    };
}

// -----------------------------------------------------------------------------
// #5113 - Espejos SINCRONOS del runner y del driver
// -----------------------------------------------------------------------------
//
// Por que sincrono: el gate de dispatch (`isIssueAllowed`) tiene que seguir
// devolviendo `boolean` estricto con el estado operativo viviendo en DynamoDB.
// Convertir la cadena a `async` obligaria a `await` en los consumidores y
// CUALQUIER olvido es fail-OPEN silencioso (`if (promise)` es siempre `true`):
// el incidente #5060 reproducido por un cambio de tipo de retorno.
//
// El patron `spawnSync` ya esta vigente en el repo (`kernel-aws-bootstrap.js`,
// `kernel-cmk-provision.js`). El costo lo absorben el cache de 2 s de
// `waves.js` y `isIssueAllowedInState(issue, state)`, que lee el estado UNA vez
// por tick y lo reusa para N issues.

/**
 * Espejo sincrono de `createAwsCliRunner`. Mismo fail-closed de credenciales,
 * mismo `shell: false`, mismos args como elementos separados del array.
 *
 * @param {object} env  Env del scope `aws`; NO `process.env`.
 * @param {object} [deps] { spawnSync, timeoutMs } inyectables para tests.
 * @returns {{ runSync: (args: string[]) => {code:number,stdout:string,stderr:string} }}
 */
function createAwsCliRunnerSync(env, deps = {}) {
    // Fail-closed de credenciales ANTES de spawnear (SEC-A02 / CA-3): identico
    // al runner async, a proposito.
    if (!env || !env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
        throw new Error(
            'createAwsCliRunnerSync: faltan credenciales AWS (scope `aws` del ambiente hijo, '
            + 'build-child-env.js: AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY). Fail-closed: '
            + 'no se invoca la AWS CLI con credenciales vacias.',
        );
    }
    const spawnSyncImpl = typeof deps.spawnSync === 'function'
        ? deps.spawnSync
        : require('child_process').spawnSync;
    const timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : 20000;

    return {
        runSync(args) {
            const res = spawnSyncImpl('aws', ['dynamodb', ...args], {
                env,           // SOLO el scope `aws`; nunca merge con process.env crudo.
                shell: false,  // PROHIBIDO shell:true (evita inyeccion de comandos).
                encoding: 'utf8',
                windowsHide: true,
                maxBuffer: 16 * 1024 * 1024,
                timeout: timeoutMs,
            });
            // `spawnSync` reporta el fallo de spawn en `res.error` (ENOENT del
            // binario, timeout). Se propaga como stderr para que
            // `classifyDegradation` lo clasifique igual que en el camino async.
            if (res && res.error) {
                return { code: 127, stdout: '', stderr: String(res.error.message || res.error) };
            }
            return {
                code: typeof (res && res.status) === 'number' ? res.status : 0,
                stdout: (res && res.stdout) || '',
                stderr: (res && res.stderr) || '',
            };
        },
    };
}

/**
 * Espejo sincrono de `createAwsCliDynamoDriver`. Comparte EXACTAMENTE las
 * mismas funciones de armado de args (`buildPutItemArgs` / `buildGetItemArgs` /
 * `buildDeleteItemArgs`) y el mismo `parseCliResult`.
 *
 * Superficie acotada a lo que necesita el estado operativo: get/put/delete. No
 * expone `createTable` ni `query`: la tabla la aprovisiona el bootstrap y el
 * backend del estado operativo nunca escanea.
 *
 * @param {object} deps { runSync }
 */
function createAwsCliDynamoDriverSync({ runSync } = {}) {
    if (typeof runSync !== 'function') {
        throw new Error('createAwsCliDynamoDriverSync requiere un runner `runSync(args)`');
    }
    function cliSync(args) {
        return parseCliResult(runSync(args), args);
    }
    return {
        kind: 'aws-cli-sync',
        putItem(spec, item, opts = {}) {
            cliSync(buildPutItemArgs(spec, item, opts));
            return { ok: true };
        },
        getItem(spec, key) {
            const res = cliSync(buildGetItemArgs(spec, key));
            return { item: res && res.Item ? fromAttrValues(res.Item) : null };
        },
        deleteItem(spec, key, opts = {}) {
            cliSync(buildDeleteItemArgs(spec, key, opts));
            return { ok: true };
        },
    };
}

/**
 * Convierte un valor JS a un AttributeValue de DynamoDB. Soporta escalares
 * (S/N/BOOL) y —recursivamente— objetos anidados (M) y arrays (L). El envelope
 * del kernel-store lleva un campo `body` OBJETO (#4820): sin el mapeo recursivo,
 * `body` se aplastaba a `{ S: "[object Object]" }` y el round-trip por el driver
 * real perdía el contenido. El comportamiento para escalares queda idéntico al
 * previo (retrocompat con el smoke del provisioner y #4743/#4777).
 */
function toAttrValue(v) {
    if (typeof v === 'number') return { N: String(v) };
    if (typeof v === 'boolean') return { BOOL: v };
    if (typeof v === 'string') return { S: v };
    if (Array.isArray(v)) return { L: v.map(toAttrValue) };
    if (v !== null && typeof v === 'object') {
        const m = {};
        for (const [k, val] of Object.entries(v)) m[k] = toAttrValue(val);
        return { M: m };
    }
    // null/undefined/otros → preserva el comportamiento previo (`{ S: String(v) }`).
    return { S: String(v) };
}

/** Convierte un ítem plano a formato AttributeValue de DynamoDB (S/N/BOOL/M/L). */
function toAttrValues(item) {
    const out = {};
    for (const [k, v] of Object.entries(item)) out[k] = toAttrValue(v);
    return out;
}

/** Inverso de `toAttrValue`: decodifica un AttributeValue a valor JS. */
function fromAttrValue(v) {
    if (v == null) return undefined;
    if ('S' in v) return v.S;
    if ('N' in v) return Number(v.N);
    if ('BOOL' in v) return Boolean(v.BOOL);
    if ('NULL' in v) return null;
    if ('M' in v) {
        const out = {};
        for (const [k, val] of Object.entries(v.M)) out[k] = fromAttrValue(val);
        return out;
    }
    if ('L' in v) return v.L.map(fromAttrValue);
    return undefined;
}

/** Inverso de `toAttrValues` para un ítem devuelto por get-item. */
function fromAttrValues(attrItem) {
    const out = {};
    for (const [k, v] of Object.entries(attrItem)) {
        if (v == null) continue;
        out[k] = fromAttrValue(v);
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
    createAwsCliRunner,
    createAwsCliDynamoDriver,
    // #5113 - espejos sincronos + armado de args puro compartido por ambos caminos.
    createAwsCliRunnerSync,
    createAwsCliDynamoDriverSync,
    buildPutItemArgs,
    buildGetItemArgs,
    buildDeleteItemArgs,
    parseCliResult,
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

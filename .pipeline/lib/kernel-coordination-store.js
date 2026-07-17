'use strict';

// =============================================================================
// kernel-coordination-store.js — Estado de coordinación de alto write del kernel
// (Ola Puente P3 · #4744)
//
// Estado de coordinación namespaceado por `projectId`, seguro entre instancias
// vía conditional writes: `waves`, `blocked`, `health`. A diferencia del store
// durable (`kernel-store.js`), acá el patrón dominante es el UPDATE optimista con
// versión (compare-and-set), no el append-only.
//
// LÍMITE EXPLÍCITO (issue #4744): el estado EFÍMERO — `cooldowns.json`,
// `listener-offset.json`, circuit-breaker — NO se toca ni se migra acá. Sigue
// viviendo local. Este módulo sólo cubre el estado de coordinación que DEBE ser
// consistente entre instancias del kernel.
//
// SEGURIDAD
//   A01/A07  aislamiento por projectId: `contextProjectId` deriva de la credencial
//            de la instancia; PK = projectId; se valida projectId === contexto.
//   A08      fail-closed: cada ítem leído pasa por el schema del store (envelope
//            `kernel-store.schema.json`, entityType `coordination`).
//   Concurrencia: `initState` (create-once, attribute_not_exists) y `compareAndSet`
//            (optimista por versión). Con el driver real (aws-cli) el CAS es
//            atómico vía `ConditionExpression #v = :ev`; con el driver in-memory
//            —que sólo evalúa attribute_not_exists— el CAS se resuelve a nivel
//            store (read + check de versión) de forma determinística offline.
// =============================================================================

const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv');

const {
  createInMemoryDynamoDriver,
  ConditionalCheckFailedError,
} = require('./provisioner-infra');
const { isSafeId } = require('./project-descriptor');
const {
  KernelStoreError,
  KernelStoreValidationError,
  KernelStoreIsolationError,
  SCHEMA_VERSION,
} = require('./kernel-store');

const SCHEMA_PATH = path.resolve(__dirname, '..', 'contracts', 'kernel-store.schema.json');
const itemSchema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
const ajv = new Ajv({ allErrors: true, verbose: false });
const validateItemSchema = ajv.compile(itemSchema);

const ENTITY_COORDINATION = 'coordination';
const DEFAULT_INMEMORY_TABLE = 'kernel-coordination-local';

// Claves de coordinación reconocidas por el kernel (dato de config confiable —
// NUNCA se deriva del ítem leído). Ampliable por config.
const DEFAULT_KNOWN_KEYS = Object.freeze(['waves', 'blocked', 'health']);

function skFor(key) {
  return `coord#${key}`;
}

/**
 * Crea el store de coordinación sobre un driver DynamoDB inyectado.
 *
 * @param {object} deps
 * @param {object} [deps.driver]            ResourceDriver (default: in-memory).
 * @param {string}  deps.contextProjectId   projectId de la instancia (deriva de la credencial).
 * @param {string} [deps.instanceId]        id de la instancia que escribe.
 * @param {object} [deps.config]            { kernel?: { coordinationTableName } }.
 * @param {string[]} [deps.knownKeys]       allowlist de claves (default: waves/blocked/health).
 * @param {boolean} [deps.atomicUpdate]     forzar CAS atómico por ConditionExpression
 *                                          (default: driver != in-memory).
 * @param {function} [deps.now]             fuente de tiempo (ms).
 * @param {function} [deps.onAlert]         callback de alerta ante rechazo fail-closed.
 */
function createCoordinationStore(deps = {}) {
  const driver = deps.driver || createInMemoryDynamoDriver();
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const onAlert = typeof deps.onAlert === 'function' ? deps.onAlert : () => {};

  const contextProjectId = deps.contextProjectId;
  if (!isSafeId(contextProjectId)) {
    throw new KernelStoreError(
      'contextProjectId inválido o ausente: debe derivarse de la credencial de la instancia (A01/A07), nunca en banda',
      { contextProjectId: contextProjectId == null ? null : String(contextProjectId) },
    );
  }
  const instanceId = isSafeId(deps.instanceId) ? deps.instanceId : contextProjectId;

  const knownKeys = new Set(
    (Array.isArray(deps.knownKeys) && deps.knownKeys.length) ? deps.knownKeys : DEFAULT_KNOWN_KEYS,
  );

  const cfg = (deps.config && (deps.config.kernel || deps.config)) || {};
  const isInMemory = driver.kind === 'in-memory';
  const tableName = typeof cfg.coordinationTableName === 'string' && cfg.coordinationTableName
    ? cfg.coordinationTableName
    : (isInMemory ? DEFAULT_INMEMORY_TABLE : null);
  if (!tableName) {
    throw new KernelStoreError(
      'config.coordinationTableName requerido para el driver real (no hardcode de tabla/naming — A05)',
      {},
    );
  }
  const atomicUpdate = typeof deps.atomicUpdate === 'boolean' ? deps.atomicUpdate : !isInMemory;

  const spec = {
    type: 'dynamodb_table',
    tableName,
    keys: [
      { name: 'PK', attributeType: 'S', keyType: 'HASH' },
      { name: 'SK', attributeType: 'S', keyType: 'RANGE' },
    ],
  };

  let ensured = false;
  async function ensureTable() {
    if (ensured) return;
    if (isInMemory) await driver.createTable(spec);
    ensured = true;
  }

  function assertKnownKey(key) {
    if (!knownKeys.has(key)) {
      throw new KernelStoreError(`clave de coordinación fuera de allowlist: ${JSON.stringify(key)}`, { key });
    }
  }

  function envelope(key, value, version) {
    return {
      PK: contextProjectId,
      SK: skFor(key),
      entityType: ENTITY_COORDINATION,
      projectId: contextProjectId,
      schemaVersion: SCHEMA_VERSION,
      body: { key, value, version, updatedBy: instanceId, updatedAt: Math.floor(now()) },
    };
  }

  function assertWritable(item) {
    if (!validateItemSchema(item)) {
      throw new KernelStoreValidationError('ítem de coordinación no cumple el schema al escribir', {
        stage: 'schema',
        errors: (validateItemSchema.errors || []).map((e) => ({ path: e.instancePath || '(root)', detail: e.message })),
      });
    }
  }

  // Lectura fail-closed: schema + aislamiento + entityType.
  async function readValidated(key) {
    await ensureTable();
    const res = await driver.getItem(spec, { PK: contextProjectId, SK: skFor(key) });
    const raw = res && res.item;
    if (!raw) return null;
    if (!validateItemSchema(raw)) {
      const errors = (validateItemSchema.errors || []).map((e) => ({ path: e.instancePath || '(root)', detail: e.message }));
      onAlert({ projectId: raw.projectId, entityType: raw.entityType, sk: raw.SK, stage: 'schema', errors });
      throw new KernelStoreValidationError(`ítem de coordinación rechazado (fail-closed): schema`, { stage: 'schema', errors });
    }
    if (raw.projectId !== contextProjectId || raw.PK !== contextProjectId) {
      onAlert({ projectId: raw.projectId, entityType: raw.entityType, sk: raw.SK, stage: 'isolation' });
      throw new KernelStoreIsolationError('ítem de coordinación de otra partición (anti-IDOR)', {
        requested: contextProjectId, found: raw.projectId,
      });
    }
    if (raw.entityType !== ENTITY_COORDINATION) {
      throw new KernelStoreValidationError('entityType inesperado en store de coordinación', {
        stage: 'entityType', found: raw.entityType,
      });
    }
    return raw;
  }

  // ---- API -------------------------------------------------------------------

  async function getState(key) {
    assertKnownKey(key);
    const raw = await readValidated(key);
    if (!raw) return null;
    return { value: raw.body.value, version: raw.body.version, updatedBy: raw.body.updatedBy, updatedAt: raw.body.updatedAt };
  }

  /**
   * Crea el estado por primera vez (create-once). Sólo una instancia gana la
   * carrera vía `attribute_not_exists(PK)`.
   * @returns {{ ok:boolean, created?:boolean, exists?:boolean, version?:number }}
   */
  async function initState(key, value) {
    assertKnownKey(key);
    assertObject(value);
    await ensureTable();
    const item = envelope(key, value, 1);
    assertWritable(item);
    try {
      await driver.putItem(spec, item, {
        conditionExpression: 'attribute_not_exists(#pk)',
        expressionAttributeNames: { '#pk': 'PK' },
      });
      return { ok: true, created: true, version: 1 };
    } catch (e) {
      if (e instanceof ConditionalCheckFailedError) return { ok: false, exists: true };
      throw e;
    }
  }

  /**
   * Compare-and-set optimista por versión. Escribe `value` sólo si la versión
   * actual coincide con `expectedVersion`; incrementa la versión.
   *
   * @param {string} key
   * @param {object} value
   * @param {number} expectedVersion  0 para "no existe todavía" (create).
   * @returns {{ ok:boolean, version:number, conflict?:boolean }}
   */
  async function compareAndSet(key, value, expectedVersion) {
    assertKnownKey(key);
    assertObject(value);
    await ensureTable();
    const cur = await readValidated(key);

    if (!cur) {
      if (expectedVersion != null && expectedVersion !== 0) {
        return { ok: false, conflict: true, version: 0 };
      }
      const created = await initState(key, value);
      return created.ok ? { ok: true, version: 1 } : { ok: false, conflict: true, version: 0 };
    }

    const currentVersion = cur.body.version;
    if (currentVersion !== expectedVersion) {
      return { ok: false, conflict: true, version: currentVersion };
    }

    const nextVersion = currentVersion + 1;
    const item = envelope(key, value, nextVersion);
    assertWritable(item);

    // Con el driver real, el CAS es atómico (AWS evalúa `#v = :ev`). Con el
    // in-memory —que sólo evalúa attribute_not_exists— NO se pasa la condición
    // (rompería con CCFE al existir la clave); la consistencia se apoya en la
    // lectura previa (determinística offline, un solo hilo).
    const opts = atomicUpdate
      ? {
        conditionExpression: '#v = :ev',
        expressionAttributeNames: { '#v': 'version' },
        expressionAttributeValues: { ':ev': expectedVersion },
      }
      : {};
    try {
      await driver.putItem(spec, item, opts);
      return { ok: true, version: nextVersion };
    } catch (e) {
      if (e instanceof ConditionalCheckFailedError) return { ok: false, conflict: true, version: currentVersion };
      throw e;
    }
  }

  function assertObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new KernelStoreError('el valor de coordinación debe ser un objeto', {});
    }
  }

  return {
    contextProjectId,
    tableName,
    knownKeys: [...knownKeys],
    getState,
    initState,
    compareAndSet,
  };
}

module.exports = {
  createCoordinationStore,
  DEFAULT_KNOWN_KEYS,
  SCHEMA_PATH,
};

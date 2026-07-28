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

// -----------------------------------------------------------------------------
// #5124 CA-UX-1 — mensaje de claim legible para el operador
// -----------------------------------------------------------------------------
//
// `claim()` tiene tres ramas de `!ok` y NO todas devuelven `owner`/`expiresAt`:
// la de conflicto de versión devuelve `{ ok:false, exists:true, conflict:true }`
// pelado, y la de carrera perdida puede devolver `owner: null`. Interpolar esos
// campos a ciegas renderiza "lo tiene undefined hasta undefined" justo en el
// escenario que esta función existe para explicar.
//
// Regla dura: el string devuelto NUNCA contiene `undefined` ni `null`. Cuando el
// store no dice quién tiene el claim, no se inventa un owner — se dice que está
// en disputa y que se reintente, que es la acción real del operador.
//
// El vencimiento se emite en tiempo RELATIVO: `expiresAt` es un epoch en ms y un
// `1785312041234` crudo no es información para un humano.

function labelForKey(key) {
  const k = typeof key === 'string' && key ? key : 'desconocida';
  // `phase-dev` → "fase dev"; cualquier otra clave se nombra tal cual.
  const m = /^phase-(.+)$/.exec(k);
  return m ? `fase ${m[1]}` : `clave de coordinación ${k}`;
}

/**
 * Traduce el resultado de `claim()` a una línea accionable para el operador.
 *
 * @param {string} key   la clave reclamada (p. ej. `phase-dev`).
 * @param {object} res   el objeto devuelto por `claim()`.
 * @param {object} [opts] { now: function|number } — fuente de tiempo (test override).
 * @returns {string} mensaje sin `undefined`/`null` interpolados.
 */
function describeClaimFailure(key, res, opts = {}) {
  const label = labelForKey(key);
  if (!res || typeof res !== 'object') {
    return `${label}: el claim no devolvió resultado — reintentar`;
  }
  if (res.ok) {
    return res.reclaimed
      ? `${label} adquirida (el lease anterior estaba vencido, se reclamó)`
      : `${label} adquirida`;
  }

  const nowMs = typeof opts.now === 'function' ? Math.floor(opts.now())
    : (Number.isFinite(opts.now) ? Math.floor(opts.now) : Date.now());

  // Owner válido = string no vacío. `null`/`undefined` caen a la rama de disputa.
  const owner = (typeof res.owner === 'string' && res.owner) ? res.owner : null;
  const expiresAt = Number.isFinite(res.expiresAt) ? res.expiresAt : null;

  if (owner && expiresAt !== null) {
    const restanteS = Math.round((expiresAt - nowMs) / 1000);
    if (restanteS > 0) {
      return `${label} tomada por ${owner}, lease vence en ${restanteS}s`;
    }
    // Lease ya vencido pero el claim sigue puesto: el próximo intento lo reclama.
    return `${label} tomada por ${owner} con el lease ya vencido — reintentar para reclamarla`;
  }
  if (owner) {
    return `${label} tomada por ${owner}, sin vencimiento conocido — reintentar`;
  }
  // Conflicto de versión o carrera perdida: el store no sabe quién la tiene.
  return `${label} en disputa — reintentar`;
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
    // #5124 CA-UX-2 — el operador tiene que poder arreglarlo SIN abrir el código:
    // el mensaje nombra el archivo y la clave exacta, y el `meta` transporta el
    // driver que disparó el fail-closed (KernelStoreError hace Object.assign).
    throw new KernelStoreError(
      'falta la tabla de coordinación del kernel: definí `kernel.coordinationTableName` '
      + 'en `.pipeline/config.yaml` (no se hardcodea el naming de tabla — A05). '
      + 'Es una tabla DISTINTA de `kernel.tableName`: la de no-repudio no admite borrado.',
      { driverKind: driver.kind, configPath: '.pipeline/config.yaml', configKey: 'kernel.coordinationTableName' },
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

  // Claves dinámicas de claim/cuota: NO están en la allowlist fija de estado
  // (waves/blocked/health), pero deben ser ids seguros (no inyectables, A05) y
  // NO colisionar con las claves reservadas de coordinación.
  function assertSafeKey(key) {
    if (!isSafeId(key)) {
      throw new KernelStoreError(
        `clave dinámica de coordinación inválida (isSafeId): ${JSON.stringify(key)}`, { key },
      );
    }
    if (knownKeys.has(key)) {
      throw new KernelStoreError(
        `clave reservada de coordinación no usable como claim/cuota: ${JSON.stringify(key)}`, { key },
      );
    }
  }

  // `extra` transporta los campos del claim (owner/expiresAt). Sólo se agregan
  // al body cuando vienen definidos, para no ensuciar el estado de coordinación
  // clásico (waves/blocked/health) ni forzar cambios en ítems que no son claims.
  function envelope(key, value, version, extra = {}) {
    const body = { key, value, version, updatedBy: instanceId, updatedAt: Math.floor(now()) };
    if (extra.owner !== undefined) body.owner = extra.owner;
    if (extra.expiresAt !== undefined) body.expiresAt = extra.expiresAt;
    return {
      PK: contextProjectId,
      SK: skFor(key),
      entityType: ENTITY_COORDINATION,
      projectId: contextProjectId,
      schemaVersion: SCHEMA_VERSION,
      body,
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

  // Shape de lectura común (incluye owner/expiresAt del claim si están).
  function shapeState(raw) {
    if (!raw) return null;
    const out = {
      value: raw.body.value,
      version: raw.body.version,
      updatedBy: raw.body.updatedBy,
      updatedAt: raw.body.updatedAt,
    };
    if (raw.body.owner !== undefined) out.owner = raw.body.owner;
    if (raw.body.expiresAt !== undefined) out.expiresAt = raw.body.expiresAt;
    return out;
  }

  // ---- Núcleo (sin validación de allowlist; los callers validan la clave) ----

  async function initStateCore(key, value, extra) {
    assertObject(value);
    await ensureTable();
    const item = envelope(key, value, 1, extra);
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

  async function compareAndSetCore(key, value, expectedVersion, extra) {
    assertObject(value);
    await ensureTable();
    const cur = await readValidated(key);

    if (!cur) {
      if (expectedVersion != null && expectedVersion !== 0) {
        return { ok: false, conflict: true, version: 0 };
      }
      const created = await initStateCore(key, value, extra);
      return created.ok ? { ok: true, version: 1 } : { ok: false, conflict: true, version: 0 };
    }

    const currentVersion = cur.body.version;
    if (currentVersion !== expectedVersion) {
      return { ok: false, conflict: true, version: currentVersion };
    }

    const nextVersion = currentVersion + 1;
    const item = envelope(key, value, nextVersion, extra);
    assertWritable(item);

    // CAS atómico sobre `body.version` (path anidado `#b.#v`). Con
    // `atomicUpdate` (driver real o in-memory forzado, #4777 R1/SEC-2) la
    // condición se evalúa en el write y cierra el TOCTOU read→write. Sin
    // `atomicUpdate` (in-memory single-instance por default) la consistencia se
    // apoya en la lectura previa monohilo (determinística offline).
    const opts = atomicUpdate
      ? {
        conditionExpression: '#b.#v = :ev',
        expressionAttributeNames: { '#b': 'body', '#v': 'version' },
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

  // ---- API pública de estado de coordinación (allowlist waves/blocked/health) -

  async function getState(key) {
    assertKnownKey(key);
    return shapeState(await readValidated(key));
  }

  /**
   * Crea el estado por primera vez (create-once). Sólo una instancia gana la
   * carrera vía `attribute_not_exists(PK)`.
   * @returns {{ ok:boolean, created?:boolean, exists?:boolean, version?:number }}
   */
  async function initState(key, value) {
    assertKnownKey(key);
    return initStateCore(key, value);
  }

  /**
   * Crea/asocia la PRIMERA ola del producto (#4809). Envuelve `initStateCore`
   * sobre la clave reservada `waves` => `attribute_not_exists(PK)` garantiza
   * UNA sola primera ola por producto sin lógica de app (CA-3). Un segundo
   * intento colisiona y devuelve `{ ok:false, exists:true }` (idempotente/
   * rechazo explícito), NUNCA duplica ni sobreescribe.
   *
   * La ola queda namespaceada por `contextProjectId` (PK) — jamás en el
   * `waves.json` global mono-producto de Intrale (CA-4, aislamiento).
   *
   * @param {object} wave   payload de la ola (objeto; ej. { descriptorRef, ... }).
   * @returns {{ ok:boolean, created?:boolean, exists?:boolean, version?:number }}
   */
  async function associateFirstWave(wave) {
    // `waves` está en la allowlist fija (DEFAULT_KNOWN_KEYS); validamos igual
    // por si el caller reconfiguró `knownKeys` sin incluirla (fail-closed).
    assertKnownKey('waves');
    // `updatedBy`/`updatedAt` los sella el envelope con `instanceId`/`now()`;
    // no se pasan campos de claim (owner/expiresAt) — la ola no es un lease.
    return initStateCore('waves', wave);
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
    return compareAndSetCore(key, value, expectedVersion);
  }

  // ---- CA-1 · Débito de cuota de pagos central y atómico -----------------------

  /**
   * Debita `deltaTokens` de un contador central único (coordination store) de
   * forma atómica vía `compareAndSet` con reintento acotado por conflicto de
   * versión (NUNCA last-write-wins). Ningún débito concurrente se pierde.
   *
   * SEC-1: al store SÓLO viaja el contador `{ consumed }` (más versión/metadata
   * del envelope). NUNCA credenciales, tokens, keys ni `cost_usd` crudo.
   *
   * @param {string} key            clave de cuota (isSafeId; ej. `quota-anthropic`).
   * @param {number} deltaTokens    delta a sumar (>= 0).
   * @param {object} [opts] { maxRetries=5 }
   * @returns {{ ok:true, consumed:number, version:number }}
   */
  async function debitPaid(key, deltaTokens, opts = {}) {
    assertSafeKey(key);
    const delta = Number(deltaTokens);
    if (!Number.isFinite(delta) || delta < 0) {
      throw new KernelStoreError('debitPaid requiere deltaTokens finito y >= 0', { deltaTokens });
    }
    const maxRetries = Number.isFinite(opts.maxRetries) && opts.maxRetries > 0 ? Math.floor(opts.maxRetries) : 5;
    await ensureTable();

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const cur = await readValidated(key);
      const base = cur ? (Number(cur.body.value && cur.body.value.consumed) || 0) : 0;
      const expectedVersion = cur ? cur.body.version : 0;
      const res = await compareAndSetCore(key, { consumed: base + delta }, expectedVersion);
      if (res.ok) return { ok: true, consumed: base + delta, version: res.version };
      // conflict → otra instancia debitó primero: reintentar sobre la versión fresca.
    }
    throw new KernelStoreError('debitPaid: conflicto de versión sostenido tras reintentos', { key, maxRetries });
  }

  // ---- CA-2/CA-3/CA-4 · Claim cloud-ready con lease + release con ownership ----

  /**
   * Reserva atómica de un trabajo por `attribute_not_exists` (create-once). Si
   * el claim ya existe pero su lease venció, se reclama de forma atómica por
   * `compareAndSet` sobre la versión (sin doble ejecución en el solapamiento).
   *
   * @param {string} key   clave del trabajo (isSafeId).
   * @param {object} opts  { owner (isSafeId, no adivinable), leaseMs (>0) }
   * @returns {{ ok:boolean, owner?, expiresAt?, version?, reclaimed?, exists?, conflict? }}
   */
  async function claim(key, opts = {}) {
    assertSafeKey(key);
    const owner = opts.owner;
    if (!isSafeId(owner)) {
      throw new KernelStoreError('claim requiere un owner válido (isSafeId, no adivinable)', {
        owner: owner == null ? null : String(owner),
      });
    }
    const leaseMs = Number.isFinite(opts.leaseMs) ? Math.floor(opts.leaseMs) : 0;
    if (!(leaseMs > 0)) {
      throw new KernelStoreError('claim requiere leaseMs > 0 (evita lock huérfano permanente)', { leaseMs: opts.leaseMs });
    }
    await ensureTable();
    const nowMs = Math.floor(now());
    const expiresAt = nowMs + leaseMs;
    const value = { claimed: true };
    const extra = { owner, expiresAt };

    const cur = await readValidated(key);
    if (!cur) {
      const created = await initStateCore(key, value, extra);
      if (created.ok) return { ok: true, owner, expiresAt, version: 1, reclaimed: false };
      // Perdimos la carrera de create-once → alguien más lo tiene.
      const fresh = await readValidated(key);
      return {
        ok: false, exists: true,
        owner: fresh && fresh.body.owner,
        expiresAt: fresh && fresh.body.expiresAt,
      };
    }

    // Claim vigente (owner presente y lease no vencido) → no se toca.
    const curOwner = cur.body.owner;
    const curExpires = cur.body.expiresAt;
    const held = curOwner != null && Number.isFinite(curExpires) && curExpires > nowMs;
    if (held) {
      return { ok: false, exists: true, owner: curOwner, expiresAt: curExpires };
    }

    // Libre o expirado → reclamo atómico por versión (un solo ganador).
    const res = await compareAndSetCore(key, value, cur.body.version, extra);
    if (res.ok) return { ok: true, owner, expiresAt, version: res.version, reclaimed: true };
    return { ok: false, exists: true, conflict: true };
  }

  /**
   * Libera un claim validando ownership de forma atómica (delete condicional
   * sobre el atributo `owner`, NUNCA read-then-delete ciego). Una instancia B
   * NO puede liberar el claim de A.
   *
   * @param {string} key   clave del trabajo (isSafeId).
   * @param {object} opts  { expectedOwner (isSafeId) }
   * @returns {{ ok:boolean, released:boolean, reason?, owner? }}
   */
  async function release(key, opts = {}) {
    assertSafeKey(key);
    const expectedOwner = opts.expectedOwner;
    if (!isSafeId(expectedOwner)) {
      throw new KernelStoreError('release requiere expectedOwner válido (isSafeId)', {
        expectedOwner: expectedOwner == null ? null : String(expectedOwner),
      });
    }
    await ensureTable();
    const cur = await readValidated(key);
    if (!cur) return { ok: true, released: false, reason: 'absent' };
    if (cur.body.owner !== expectedOwner) {
      return { ok: false, released: false, reason: 'not-owner', owner: cur.body.owner };
    }

    // Ownership atómico: la autoridad la da la condición sobre `body.owner` en
    // el delete (no la lectura previa). Con `atomicUpdate` la evalúa el write;
    // sin él (in-memory single-instance) el delete es directo tras el chequeo.
    const delOpts = atomicUpdate ? {
      conditionExpression: '#b.#o = :owner',
      expressionAttributeNames: { '#b': 'body', '#o': 'owner' },
      expressionAttributeValues: { ':owner': expectedOwner },
    } : {};
    try {
      await driver.deleteItem(spec, { PK: contextProjectId, SK: skFor(key) }, delOpts);
      return { ok: true, released: true };
    } catch (e) {
      if (e instanceof ConditionalCheckFailedError) return { ok: false, released: false, reason: 'conflict' };
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
    associateFirstWave,
    compareAndSet,
    debitPaid,
    claim,
    release,
  };
}

module.exports = {
  createCoordinationStore,
  describeClaimFailure,
  DEFAULT_KNOWN_KEYS,
  SCHEMA_PATH,
};

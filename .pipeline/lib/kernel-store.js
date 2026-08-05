'use strict';

// =============================================================================
// kernel-store.js — Capa de acceso al store durable del kernel (Ola Puente P3 · #4744)
//
// El kernel multi-producto necesita persistir de forma durable y recuperable por
// clave: descriptores, catálogo de productos, firmas/autoridad y un audit-log
// append-only, todo namespaceado por `projectId` sobre DynamoDB single-table.
//
// Este módulo es una SUPERFICIE DE CONFIANZA: envuelve el driver DynamoDB de
// `provisioner-infra` (inyectado, nunca instanciado acá) y aplica validación
// FAIL-CLOSED en CADA lectura antes de que el kernel consuma el dato. Reusa
// `validateDescriptor` (Ajv + checksum + prompt-injection + path-traversal) y la
// allowlist fija `KERNEL_SKILLS` de `project-descriptor.js` — no re-implementa
// ninguna de esas verificaciones (A08 / #4744 reuso obligatorio).
//
// MODELO DE DATOS (CA-gate guru/arquitecto/security · comentarios de definición)
//   PK = projectId
//   SK = "<entityType>#<id>"
//     - descriptor#self            (mutable por versión, no firma)
//     - product#<productId>        (mutable por versión)
//     - catalog#index              (índice mutable de productIds — habilita list)
//     - signature#<ULID>           (append-only, attribute_not_exists)
//     - audit#<ULID>               (append-only, attribute_not_exists)
//     - claim#<phase>              (conditional write optimista + lease)
//
// SEGURIDAD (mapa OWASP 2021 del análisis de definición)
//   A01/A07  aislamiento por projectId: `contextProjectId` deriva de la credencial
//            de la instancia (NUNCA en banda); toda operación valida
//            `item.projectId === contextProjectId` como defensa en profundidad.
//   A02      la BD guarda REFS namespaceadas de credenciales, nunca valores; la
//            ref se valida contra un allowlist de namespaces al leer/escribir.
//   A03/A08  fail-closed al leer: ítem corrupto/inyectado/con campo desconocido o
//            skill fuera de allowlist ⇒ NO procede + alerta + escala (no parcial).
//   A04      límite de tamaño de ítem antes de escribir (evita drenar free tier).
//   A09      firmas/audit append-only vía `attribute_not_exists(PK)` (sin
//            UpdateItem/DeleteItem sobre firmas); garantía reforzada por IAM en
//            despliegue (fuera de código, documentado en el issue).
//
// Convención de errores: los fallos de VALIDACIÓN al leer se propagan como
// `KernelStoreValidationError` tipado con `stage`/`errors`/`projectId`/`entityType`
// para una alerta accionable (CA-3). NUNCA se retorna un ítem parcial.
// =============================================================================

const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv');

const {
  createInMemoryDynamoDriver,
  ConditionalCheckFailedError,
} = require('./provisioner-infra');
const projectDescriptor = require('./project-descriptor');
const { validateDescriptor, isSafeId, isReservedProjectId, redactAjvErrors, CONTROL_PLANE_PROJECT_ID } = projectDescriptor;
const { detectInjection } = require('./handoff');
const { parseSecretRef } = require('./credentials');

// -----------------------------------------------------------------------------
// Constantes
// -----------------------------------------------------------------------------

const SCHEMA_VERSION = '1.0';
const SCHEMA_PATH = path.resolve(__dirname, '..', 'contracts', 'kernel-store.schema.json');
const itemSchema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
const ajv = new Ajv({ allErrors: true, verbose: false });
const validateItemSchema = ajv.compile(itemSchema);

const ENTITY = Object.freeze({
  DESCRIPTOR: 'descriptor',
  PRODUCT: 'product',
  CATALOG: 'catalog',
  SIGNATURE: 'signature',
  AUDIT: 'audit',
  // #5124 — `claim` queda SÓLO para poder LEER ítems legacy escritos antes de que
  // la coordinación saliera de esta tabla (Opción B′-1). Nada lo escribe ya: el
  // claim de fase vive en `kernel-coordination-store.js` (tabla dedicada). Su
  // retiro del schema es alcance de la migración (#5125).
  CLAIM: 'claim',
});

// Techo por defecto para el tamaño de un ítem (A04). DynamoDB tope 400KB; dejamos
// margen y permitimos ajustar por config para tests / políticas más estrictas.
const DEFAULT_MAX_ITEM_BYTES = 300 * 1024;
const DEFAULT_LEASE_MS = 60 * 1000;
// Nombre lógico SOLO válido para el driver in-memory (tests/offline). El driver
// real EXIGE tableName por config (no hardcode de tabla/naming — A05/CA-9).
const DEFAULT_INMEMORY_TABLE = 'kernel-store-local';

// SK builders (única fuente de las claves — nunca se derivan de datos en banda).
const SK = Object.freeze({
  descriptor: () => 'descriptor#self',
  product: (id) => `product#${id}`,
  catalog: () => 'catalog#index',
  signature: (ulid) => `signature#${ulid}`,
  audit: (ulid) => `audit#${ulid}`,
});

// -----------------------------------------------------------------------------
// Errores tipados
// -----------------------------------------------------------------------------

class KernelStoreError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'KernelStoreError';
    Object.assign(this, meta);
  }
}

// Fail-closed al leer/escribir: el ítem no cumple una verificación de integridad.
class KernelStoreValidationError extends KernelStoreError {
  constructor(message, meta = {}) {
    super(message, meta);
    this.name = 'KernelStoreValidationError';
  }
}

// Anti-IDOR (A01): la instancia intenta operar sobre otra partición de producto.
class KernelStoreIsolationError extends KernelStoreError {
  constructor(message, meta = {}) {
    super(message, meta);
    this.name = 'KernelStoreIsolationError';
  }
}

// Control de costos (A04): el ítem supera el techo de tamaño antes de escribir.
class KernelStoreSizeError extends KernelStoreError {
  constructor(message, meta = {}) {
    super(message, meta);
    this.name = 'KernelStoreSizeError';
  }
}

// -----------------------------------------------------------------------------
// ULID-ish monótono y único (id de firmas/audit, apto multi-instancia)
// -----------------------------------------------------------------------------

/**
 * Genera un id monótono creciente (ordenable por tiempo) y único por invocación,
 * sin coordinación entre instancias. Deriva de la fuente de tiempo inyectada +
 * secuencia intra-ms + entropía. Sólo produce [a-z0-9], compatible con el patrón
 * de SK del schema.
 */
function createUlidFactory(now) {
  let last = -1;
  let seq = 0;
  let entropy = 0;
  return () => {
    const t = Math.max(0, Math.floor(now()));
    if (t === last) seq += 1;
    else { last = t; seq = 0; }
    entropy = (entropy + 1) % 0xffffff;
    const rand = ((entropy * 2654435761) >>> 0).toString(36);
    return `${t.toString(36)}${seq.toString(36).padStart(2, '0')}${rand}`;
  };
}

// -----------------------------------------------------------------------------
// Config del kernel (región/tabla/naming por config — NO hardcode · A05/CA-9)
// -----------------------------------------------------------------------------

function normalizeConfig(cfg, driver) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const kernel = c.kernel && typeof c.kernel === 'object' ? c.kernel : c;
  const isInMemory = driver && driver.kind === 'in-memory';
  const tableName = typeof kernel.tableName === 'string' && kernel.tableName
    ? kernel.tableName
    : (isInMemory ? DEFAULT_INMEMORY_TABLE : null);
  if (!tableName) {
    throw new KernelStoreError(
      'config.tableName requerido para el driver real: la tabla/naming/región del kernel se define por config, nunca hardcode (A05/CA-9)',
      {},
    );
  }
  return {
    tableName,
    region: typeof kernel.region === 'string' ? kernel.region : null,
    leaseMs: Number.isFinite(kernel.leaseMs) ? kernel.leaseMs : DEFAULT_LEASE_MS,
    maxItemBytes: Number.isFinite(kernel.maxItemBytes) ? kernel.maxItemBytes : DEFAULT_MAX_ITEM_BYTES,
  };
}

// -----------------------------------------------------------------------------
// Factory del store
// -----------------------------------------------------------------------------

/**
 * Crea el store durable del kernel sobre un driver DynamoDB inyectado.
 *
 * @param {object} deps
 * @param {object} [deps.driver]           ResourceDriver de provisioner-infra (default: in-memory).
 * @param {string}  deps.contextProjectId  projectId de la instancia — DEBE derivar de la credencial
 *                                          (namespace), NUNCA venir en banda (A01/A07).
 * @param {object} [deps.config]           { kernel?: { tableName, region, leaseMs, maxItemBytes } }.
 * @param {string[]} [deps.allowedNamespaces] namespaces de credencial permitidos (default: [contextProjectId]).
 * @param {function} [deps.now]            fuente de tiempo (ms).
 * @param {function} [deps.idFactory]      generador de ULIDs (test override).
 * @param {function} [deps.onAlert]        callback de alerta ante rechazo fail-closed (CA-3).
 * @returns {object} API del store.
 */
function createKernelStore(deps = {}) {
  const driver = deps.driver || createInMemoryDynamoDriver();
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const idFactory = typeof deps.idFactory === 'function' ? deps.idFactory : createUlidFactory(now);
  const config = normalizeConfig(deps.config, driver);
  const onAlert = typeof deps.onAlert === 'function' ? deps.onAlert : () => {};

  const contextProjectId = deps.contextProjectId;
  if (!isSafeId(contextProjectId)) {
    throw new KernelStoreError(
      'contextProjectId inválido o ausente: debe derivarse de la credencial de la instancia (A01/A07), nunca en banda',
      { contextProjectId: contextProjectId == null ? null : String(contextProjectId) },
    );
  }
  const allowedNamespaces = (Array.isArray(deps.allowedNamespaces) && deps.allowedNamespaces.length)
    ? deps.allowedNamespaces.slice()
    : [contextProjectId];

  const spec = {
    type: 'dynamodb_table',
    tableName: config.tableName,
    keys: [
      { name: 'PK', attributeType: 'S', keyType: 'HASH' },
      { name: 'SK', attributeType: 'S', keyType: 'RANGE' },
    ],
  };

  // El driver in-memory exige la tabla creada antes de leer/escribir; el driver
  // real la recibe provisionada externamente (provisioner-infra). Idempotente.
  let ensured = false;
  async function ensureTable() {
    if (ensured) return;
    if (driver.kind === 'in-memory') await driver.createTable(spec);
    ensured = true;
  }

  // ---- helpers de aislamiento / claves --------------------------------------

  function assertSameProject(projectId, op) {
    if (projectId !== contextProjectId) {
      throw new KernelStoreIsolationError(
        `aislamiento A01: la instancia "${contextProjectId}" no puede operar la partición de "${projectId}"`,
        { op, requested: projectId == null ? null : String(projectId), context: contextProjectId },
      );
    }
  }

  function envelope(entityType, sk, body) {
    return {
      PK: contextProjectId,
      SK: sk,
      entityType,
      projectId: contextProjectId,
      schemaVersion: SCHEMA_VERSION,
      body,
    };
  }

  function keyOf(sk) {
    return { PK: contextProjectId, SK: sk };
  }

  const appendOnlyOpts = () => ({
    conditionExpression: 'attribute_not_exists(#pk)',
    expressionAttributeNames: { '#pk': 'PK' },
  });

  // ---- validación fail-closed al leer (A08 / CA-2 / CA-3) -------------------

  function scanText(hits, label, value) {
    if (typeof value === 'string' && value !== '') {
      const res = detectInjection(value);
      if (res.hits.length > 0) hits.push({ path: label, keyword: 'promptInjection', detail: 'dato no confiable con patrón de prompt-injection' });
    }
  }

  function collectInjectionHits(item) {
    const hits = [];
    const b = item.body || {};
    if (item.entityType === ENTITY.PRODUCT) {
      scanText(hits, 'body.name', b.name);
    } else if (item.entityType === ENTITY.AUDIT) {
      scanText(hits, 'body.action', b.action);
      scanText(hits, 'body.actor', b.actor);
      scanText(hits, 'body.detail', b.detail);
    } else if (item.entityType === ENTITY.SIGNATURE) {
      scanText(hits, 'body.target', b.target);
    }
    // El body descriptor lo cubre validateDescriptor (su propio scan de injection).
    return hits;
  }

  // Refs de credenciales: SIEMPRE namespaceadas y contra un allowlist (A02/CA-7).
  // Un ítem manipulado no puede apuntar la resolución a un secreto de otro scope.
  function collectRefHits(item) {
    const hits = [];
    if (item.entityType === ENTITY.DESCRIPTOR) {
      const creds = (item.body && item.body.credentials) || [];
      if (Array.isArray(creds)) {
        creds.forEach((c, i) => {
          const parsed = parseSecretRef(c && c.ref);
          if (!parsed) {
            hits.push({ path: `credentials[${i}].ref`, keyword: 'ref', detail: 'ref de credencial no namespaceada (se esperaba path#namespace)' });
            return;
          }
          if (!allowedNamespaces.includes(parsed.namespace)) {
            hits.push({ path: `credentials[${i}].ref`, keyword: 'ref', detail: `namespace de credencial fuera de allowlist: ${parsed.namespace}` });
          }
        });
      }
    }
    return hits;
  }

  function alertPayload(item, stage, errors) {
    return {
      projectId: item && item.projectId,
      entityType: item && item.entityType,
      sk: item && item.SK,
      stage,
      errors,
    };
  }

  /**
   * Valida un ítem crudo leído del store, fail-closed y en orden estricto.
   * @returns {{ valid:boolean, stage:string|null, errors:Array, item:object|null, alert?:object }}
   */
  function validateItemOnRead(raw, expected = {}) {
    // 1. Envelope schema (Ajv): rechaza campo desconocido (A06), tipos, patrones.
    if (!validateItemSchema(raw)) {
      const errors = redactAjvErrors(validateItemSchema.errors);
      return { valid: false, stage: 'schema', errors, item: null, alert: alertPayload(raw, 'schema', errors) };
    }
    // 2. Aislamiento (A01/A07): la partición y el projectId deben ser los de ESTA instancia.
    if (raw.projectId !== contextProjectId || raw.PK !== contextProjectId) {
      const errors = [{ path: 'projectId', keyword: 'isolation', detail: 'ítem de otra partición / PK≠projectId (anti-IDOR)' }];
      return { valid: false, stage: 'isolation', errors, item: null, alert: alertPayload(raw, 'isolation', errors) };
    }
    // 3. entityType esperado (defensa contra key-confusion).
    if (expected.entityType && raw.entityType !== expected.entityType) {
      const errors = [{ path: 'entityType', keyword: 'entityType', detail: `se esperaba entityType "${expected.entityType}", leído "${raw.entityType}"` }];
      return { valid: false, stage: 'entityType', errors, item: null, alert: alertPayload(raw, 'entityType', errors) };
    }
    // 4. Prompt-injection sobre campos de texto no confiables (A03/A08).
    const injHits = collectInjectionHits(raw);
    if (injHits.length) {
      return { valid: false, stage: 'injection', errors: injHits, item: null, alert: alertPayload(raw, 'injection', injHits) };
    }
    // 5. Refs de credenciales namespaceadas + allowlist (A02/CA-7).
    const refHits = collectRefHits(raw);
    if (refHits.length) {
      return { valid: false, stage: 'ref', errors: refHits, item: null, alert: alertPayload(raw, 'ref', refHits) };
    }
    // 6. Payload descriptor ⇒ validación profunda REUSANDO validateDescriptor (A08)
    //    + allowlist KERNEL_SKILLS + identidad ligada al contexto.
    if (raw.entityType === ENTITY.DESCRIPTOR) {
      const dres = validateDescriptor(raw.body);
      if (!dres.valid) {
        const stage = `descriptor:${dres.stage}`;
        return { valid: false, stage, errors: dres.errors, item: null, alert: alertPayload(raw, stage, dres.errors) };
      }
      const allow = projectDescriptor.assertCapabilitiesAllowlisted(raw.body);
      if (!allow.ok) {
        const errors = allow.rejected.map((r) => ({ path: 'capabilities', keyword: 'allowlist', detail: `skill fuera de KERNEL_SKILLS: ${r.skill || r.interface}` }));
        return { valid: false, stage: 'allowlist', errors, item: null, alert: alertPayload(raw, 'allowlist', errors) };
      }
      const bodyPid = raw.body && raw.body.identity && raw.body.identity.projectId;
      if (bodyPid !== contextProjectId) {
        const errors = [{ path: 'identity.projectId', keyword: 'isolation', detail: 'identidad del descriptor no coincide con el contexto de la instancia' }];
        return { valid: false, stage: 'isolation', errors, item: null, alert: alertPayload(raw, 'isolation', errors) };
      }
    }
    return { valid: true, stage: null, errors: [], item: raw };
  }

  /**
   * Lee un ítem por clave y lo valida fail-closed. `null` si no existe (ausencia
   * legítima). Si existe pero NO valida ⇒ NO procede: alerta + escala + lanza
   * (CA-3: nunca retorno parcial ni "seguir con lo que se pueda leer").
   */
  async function readItem(sk, expected) {
    await ensureTable();
    const res = await driver.getItem(spec, keyOf(sk));
    const raw = res && res.item;
    if (!raw) return null;
    const v = validateItemOnRead(raw, expected || {});
    if (!v.valid) {
      onAlert(v.alert);
      throw new KernelStoreValidationError(
        `ítem del kernel rechazado (fail-closed al leer): ${v.stage}`,
        { stage: v.stage, errors: v.errors, projectId: raw.projectId, entityType: raw.entityType, sk: raw.SK },
      );
    }
    return v.item;
  }

  // ---- guardas de escritura --------------------------------------------------

  function assertWritable(item) {
    // Techo de tamaño ANTES de escribir (A04).
    const bytes = Buffer.byteLength(JSON.stringify(item), 'utf8');
    if (bytes > config.maxItemBytes) {
      throw new KernelStoreSizeError(
        `ítem excede el tamaño máximo (${bytes} > ${config.maxItemBytes} bytes) — rechazado antes de escribir (A04)`,
        { bytes, maxItemBytes: config.maxItemBytes, sk: item.SK },
      );
    }
    // Fail-closed también al escribir: el envelope debe cumplir el schema.
    if (!validateItemSchema(item)) {
      const errors = redactAjvErrors(validateItemSchema.errors);
      throw new KernelStoreValidationError('ítem no cumple el schema del store al escribir', { stage: 'schema', errors, sk: item.SK });
    }
  }

  // ---- API pública -----------------------------------------------------------

  async function getDescriptor(projectId) {
    assertSameProject(projectId, 'getDescriptor');
    return readItem(SK.descriptor(), { entityType: ENTITY.DESCRIPTOR });
  }

  async function putDescriptor(desc) {
    // Fail-closed al escribir: el descriptor debe validar antes de persistir (A08).
    const dres = validateDescriptor(desc);
    if (!dres.valid) {
      throw new KernelStoreValidationError('descriptor inválido al escribir', { stage: dres.stage, errors: dres.errors });
    }
    const canonical = dres.descriptor; // forma migrada/canónica
    const pid = canonical.identity && canonical.identity.projectId;
    assertSameProject(pid, 'putDescriptor');
    const allow = projectDescriptor.assertCapabilitiesAllowlisted(canonical);
    if (!allow.ok) {
      throw new KernelStoreValidationError('descriptor con skill fuera de KERNEL_SKILLS', { stage: 'allowlist', errors: allow.rejected });
    }
    const item = envelope(ENTITY.DESCRIPTOR, SK.descriptor(), canonical);
    const refHits = collectRefHits(item);
    if (refHits.length) {
      throw new KernelStoreValidationError('descriptor con ref de credencial fuera de allowlist', { stage: 'ref', errors: refHits });
    }
    await ensureTable();
    assertWritable(item);
    await driver.putItem(spec, item); // mutable por versión (no es firma append-only)
    return { ok: true, sk: item.SK };
  }

  async function putProduct(product) {
    const productId = product && product.productId;
    const projectId = product && product.projectId;
    if (isReservedProjectId(productId) || isReservedProjectId(projectId)) {
      throw new KernelStoreValidationError('id de producto/proyecto reservado', {
        stage: 'reserved-id',
        errors: [{ path: 'productId/projectId', detail: 'id reservado' }],
      });
    }
    const item = envelope(ENTITY.PRODUCT, SK.product(productId), sanitizeProduct(product));
    await ensureTable();
    assertWritable(item); // schema-valida el body product (rechaza campo extra)
    // injection defensa-en-profundidad también al escribir
    const inj = collectInjectionHits(item);
    if (inj.length) throw new KernelStoreValidationError('product con patrón de prompt-injection', { stage: 'injection', errors: inj });
    await driver.putItem(spec, item);
    await addToCatalog(productId);
    return { ok: true, sk: item.SK };
  }

  function sanitizeProduct(product) {
    const p = product && typeof product === 'object' ? product : {};
    const out = { productId: p.productId, name: p.name };
    if (p.status != null) out.status = p.status;
    if (p.descriptorRef != null) out.descriptorRef = p.descriptorRef;
    return out;
  }

  // Índice mutable de productIds (habilita listProducts sin query/scan en el
  // driver). Escritura de baja frecuencia; la mutación aplica sólo al índice, no
  // a firmas.
  //
  // A08 · #4811 CA-6/CA-9: dos altas concurrentes de productos distintos
  // (`Promise.all([putProduct(A), putProduct(B)])`) hacían read-modify-write SIN
  // escritura condicional → ventana last-write-wins reproducida en vivo (B pisaba
  // el índice recién escrito por A y perdía a A). Ahora el índice lleva `version`
  // y la escritura es un CAS optimista (`#b.#v = :ev`) con reintento acotado —
  // mismo idiom que `kernel-coordination-store.compareAndSetCore`. No se apoya en
  // el "único escritor lógico" del comentario original: la atomicidad es real.
  const CATALOG_CAS_MAX_RETRIES = 16;

  async function addToCatalog(productId) {
    for (let attempt = 0; ; attempt++) {
      const res = await driver.getItem(spec, keyOf(SK.catalog()));
      const cur = res && res.item;
      let ids = [];
      let expectedVersion = 0;
      let curHasVersion = false;
      if (cur) {
        const v = validateItemOnRead(cur, { entityType: ENTITY.CATALOG });
        if (!v.valid) {
          onAlert(v.alert);
          throw new KernelStoreValidationError(`catálogo corrupto: ${v.stage}`, { stage: v.stage, errors: v.errors });
        }
        ids = (v.item.body.productIds || []).slice();
        if (Number.isInteger(v.item.body.version)) {
          expectedVersion = v.item.body.version;
          curHasVersion = true;
        }
      }
      // Idempotente: si el id ya está registrado, no reescribimos el índice.
      if (ids.includes(productId)) return;
      ids.push(productId);
      const nextVersion = expectedVersion + 1;
      const item = envelope(ENTITY.CATALOG, SK.catalog(), { productIds: ids, version: nextVersion });
      assertWritable(item);
      // Selección de la condición de CAS según el estado leído:
      //   - sin índice previo        → create-once (attribute_not_exists(PK)).
      //   - índice legacy sin version → upgrade atómico único (existe PK y aún no
      //                                 tiene body.version).
      //   - índice versionado        → CAS por versión (#b.#v = :ev).
      let opts;
      if (!cur) {
        opts = appendOnlyOpts();
      } else if (curHasVersion) {
        opts = {
          conditionExpression: '#b.#v = :ev',
          expressionAttributeNames: { '#b': 'body', '#v': 'version' },
          expressionAttributeValues: { ':ev': expectedVersion },
        };
      } else {
        opts = {
          conditionExpression: 'attribute_exists(#pk) AND attribute_not_exists(#b.#v)',
          expressionAttributeNames: { '#pk': 'PK', '#b': 'body', '#v': 'version' },
        };
      }
      try {
        await driver.putItem(spec, item, opts);
        return;
      } catch (e) {
        if (e instanceof ConditionalCheckFailedError) {
          // Otra escritura ganó la carrera: re-leemos el índice actualizado y
          // reintentamos el merge (sin perder ninguna entrada).
          if (attempt < CATALOG_CAS_MAX_RETRIES) continue;
          throw new KernelStoreError(
            `contención persistente en catalog#index tras ${CATALOG_CAS_MAX_RETRIES} reintentos de CAS`,
            { sk: item.SK, productId },
          );
        }
        throw e;
      }
    }
  }

  async function listProducts() {
    await ensureTable();
    const res = await driver.getItem(spec, keyOf(SK.catalog()));
    const idx = res && res.item;
    if (!idx) return [];
    const v = validateItemOnRead(idx, { entityType: ENTITY.CATALOG });
    if (!v.valid) {
      onAlert(v.alert);
      throw new KernelStoreValidationError(`catálogo corrupto: ${v.stage}`, { stage: v.stage, errors: v.errors });
    }
    const out = [];
    for (const pid of v.item.body.productIds || []) {
      const p = await readItem(SK.product(pid), { entityType: ENTITY.PRODUCT });
      if (p) out.push(p.body);
    }
    return out;
  }

  async function putSignature(sig) {
    const ulid = idFactory();
    const item = envelope(ENTITY.SIGNATURE, SK.signature(ulid), sanitizeSignature(sig));
    await ensureTable();
    assertWritable(item);
    try {
      // Append-only real: attribute_not_exists(PK) sobre la clave compuesta.
      // El SK ULID único garantiza que dos firmas legítimas no colisionen; la
      // condición bloquea cualquier sobrescritura de una entrada ya escrita (A09).
      await driver.putItem(spec, item, appendOnlyOpts());
    } catch (e) {
      if (e instanceof ConditionalCheckFailedError) {
        throw new KernelStoreError('colisión append-only en firma (SK duplicado) — no se sobrescribe (A09)', { sk: item.SK });
      }
      throw e;
    }
    return { ok: true, sk: item.SK, signatureId: ulid };
  }

  function sanitizeSignature(sig) {
    const s = sig && typeof sig === 'object' ? sig : {};
    const out = { signer: s.signer, target: s.target, checksum: s.checksum };
    if (s.algorithm != null) out.algorithm = s.algorithm;
    if (s.signedAt != null) out.signedAt = s.signedAt;
    return out;
  }

  async function getSignature(signatureId) {
    return readItem(SK.signature(signatureId), { entityType: ENTITY.SIGNATURE });
  }

  async function appendAuditEntry(entry) {
    const ulid = idFactory();
    const e = entry && typeof entry === 'object' ? entry : {};
    const body = { action: e.action, actor: e.actor, at: e.at != null ? String(e.at) : String(Math.floor(now())) };
    if (e.detail != null) body.detail = String(e.detail);
    const item = envelope(ENTITY.AUDIT, SK.audit(ulid), body);
    await ensureTable();
    assertWritable(item);
    const inj = collectInjectionHits(item);
    if (inj.length) throw new KernelStoreValidationError('audit con patrón de prompt-injection', { stage: 'injection', errors: inj });
    try {
      await driver.putItem(spec, item, appendOnlyOpts());
    } catch (err) {
      if (err instanceof ConditionalCheckFailedError) {
        throw new KernelStoreError('colisión append-only en audit (SK duplicado)', { sk: item.SK });
      }
      throw err;
    }
    return { ok: true, sk: item.SK, auditId: ulid };
  }

  // #5124 (Opción B′-1) — `claim()` fue RETIRADO de este módulo a propósito.
  //
  // Este store es la partición de **no-repudio** (firmas + audit). Mientras los
  // claims vivían acá, el `Deny` de IAM que los protege no podía ser efectivo:
  // `dynamodb:LeadingKeys` condiciona por **partition key** y los prefijos del
  // schema (`signature#`/`audit#`/`claim#`) viven en la **sort key**, así que la
  // `Condition` no matcheaba nunca. Sacar la coordinación de esta tabla permite
  // que el `Deny` sea incondicional sobre `table/TABLE` — trivialmente efectivo
  // y sin poder volver a quedar inerte por un cambio de schema.
  //
  // El claim de fase se resuelve ahora con `kernel-coordination-store.js`, que ya
  // corre sobre tabla dedicada (`kernel.coordinationTableName`) y reclama por
  // `compareAndSet` sobre **versión** (fencing token) en vez de comparar el reloj
  // del cliente — inmune al drift de NTP entre hosts:
  //
  //   const res = await coord.claim(`phase-${phase}`, { owner: instanceId, leaseMs });
  //   if (!res.ok) log(describeClaimFailure(`phase-${phase}`, res, { now }));
  //   // …y al terminar:
  //   await coord.release(`phase-${phase}`, { expectedOwner: instanceId });
  //
  // NO reintroducir coordinación acá: obliga a conceder `DeleteItem` sobre la
  // tabla de no-repudio, que es exactamente lo que el `Deny` existe para impedir.
  // Ver `docs/pipeline/kernel-iam-policy.md`.

  return {
    // metadata
    contextProjectId,
    tableName: config.tableName,
    ENTITY,
    // descriptores
    getDescriptor,
    putDescriptor,
    // catálogo
    putProduct,
    listProducts,
    // firmas / audit (append-only)
    putSignature,
    getSignature,
    appendAuditEntry,
    // validación (expuesta para reuso/tests)
    validateItemOnRead,
  };
}

module.exports = {
  createKernelStore,
  createUlidFactory,
  normalizeConfig,
  SCHEMA_PATH,
  SCHEMA_VERSION,
  ENTITY,
  // #5204 — re-export por ergonomía: los callers del store (boot, alta durable,
  // drainer) necesitan la MISMA constante de partición del control-plane. La
  // autoridad sigue siendo `project-descriptor.js` (donde vive la política de
  // ids reservados); acá sólo se reexporta para no obligar a importar dos libs.
  CONTROL_PLANE_PROJECT_ID,
  KernelStoreError,
  KernelStoreValidationError,
  KernelStoreIsolationError,
  KernelStoreSizeError,
};

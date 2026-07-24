'use strict';

// =============================================================================
// provider-quota-central.test.js — #4777 CA-1/CA-5
//
// Cobertura:
//   - Pagos (Anthropic/Codex) → contador CENTRAL único vía debitPaidQuota.
//   - Free tiers (Gemini/Cerebras/NVIDIA) → medición LOCAL (recordSample),
//     nunca al contador central.
//   - SEC-1 (OWASP A02, bloqueante): el ítem persistido en el store SÓLO
//     contiene contadores/versión/metadatos; ningún campo (recursivo) matchea
//     patrones de secreto (AWS keys, JWT, sk-, Bearer, password).
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createInMemoryDynamoDriver } = require('../provisioner-infra');
const { createCoordinationStore } = require('../kernel-coordination-store');
const {
  isPaidProvider,
  isFreeProvider,
  debitPaidQuota,
  recordSample,
  _quotaKeyFor,
  PAID_PROVIDERS,
  FREE_PROVIDERS,
} = require('../provider-quota');

const CTX = 'acme-store';
const TABLE = 'kernel-coordination-local';

function makeStore(extra = {}) {
  const driver = extra.driver || createInMemoryDynamoDriver();
  const store = createCoordinationStore({
    driver, contextProjectId: CTX, now: () => 1000, atomicUpdate: true, ...extra,
  });
  return { store, driver };
}

const specFor = () => ({
  type: 'dynamodb_table',
  tableName: TABLE,
  keys: [
    { name: 'PK', attributeType: 'S', keyType: 'HASH' },
    { name: 'SK', attributeType: 'S', keyType: 'RANGE' },
  ],
});

async function rawItem(driver, key) {
  let res;
  try {
    res = await driver.getItem(specFor(), { PK: CTX, SK: `coord#${key}` });
  } catch (e) {
    // Tabla inexistente ⇒ nunca hubo write central para esta clave.
    if (/tabla inexistente/.test(e.message)) return null;
    throw e;
  }
  return res && res.item;
}

// Recolecta todos los valores string de un objeto de forma recursiva (para el
// escaneo de secretos SEC-1).
function collectStrings(obj, out = []) {
  if (obj == null) return out;
  if (typeof obj === 'string') { out.push(obj); return out; }
  if (typeof obj !== 'object') return out;
  for (const k of Object.keys(obj)) {
    out.push(k); // también inspeccionamos las claves
    collectStrings(obj[k], out);
  }
  return out;
}

const SECRET_PATTERNS = [
  /AKIA[0-9A-Z]{16}/,            // AWS access key id
  /aws_secret/i,
  /eyJ[A-Za-z0-9_-]{10,}/,      // JWT
  /\bsk-[A-Za-z0-9]{8,}/,       // OpenAI-style key
  /\bBearer\s+\S+/i,
  /password/i,
  /cost_usd/i,
];

test('clasificación de proveedores: pagos vs free (sin solapamiento)', () => {
  assert.equal(isPaidProvider('anthropic'), true);
  assert.equal(isPaidProvider('openai-codex'), true);
  assert.equal(isPaidProvider('gemini-google'), false);
  assert.equal(isFreeProvider('cerebras'), true);
  assert.equal(isFreeProvider('anthropic'), false);
  const overlap = PAID_PROVIDERS.filter((p) => FREE_PROVIDERS.includes(p));
  assert.deepEqual(overlap, []);
});

test('CA-1 · debitPaidQuota enruta pagos al contador central', async () => {
  const { store, driver } = makeStore();
  const r1 = await debitPaidQuota(store, { provider: 'anthropic', deltaTokens: 100 });
  assert.equal(r1.consumed, 100);
  const r2 = await debitPaidQuota(store, { provider: 'anthropic', deltaTokens: 50 });
  assert.equal(r2.consumed, 150);

  const item = await rawItem(driver, _quotaKeyFor('anthropic'));
  assert.equal(item.body.value.consumed, 150);
  assert.equal(item.entityType, 'coordination');
});

test('CA-1 · débitos concurrentes de pagos: total exacto en el contador central', async () => {
  const driver = createInMemoryDynamoDriver();
  const stores = Array.from({ length: 8 }, (_, i) =>
    makeStore({ driver, instanceId: `inst-${i}` }).store);
  await Promise.all(stores.map((s) => debitPaidQuota(s, { provider: 'openai-codex', deltaTokens: 25, maxRetries: 200 })));
  const item = await rawItem(driver, _quotaKeyFor('openai-codex'));
  assert.equal(item.body.value.consumed, 8 * 25);
});

test('routing: debitPaidQuota rechaza proveedores free (usan medición local)', async () => {
  const { store } = makeStore();
  await assert.rejects(() => debitPaidQuota(store, { provider: 'gemini-google', deltaTokens: 10 }), /sólo aplica a proveedores pagos/);
  await assert.rejects(() => debitPaidQuota(store, { provider: 'cerebras', deltaTokens: 10 }), /pagos/);
});

test('routing: free tier usa recordSample local, NUNCA el contador central', async () => {
  const { store, driver } = makeStore();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pq-central-'));
  try {
    const ok = recordSample({
      provider: 'gemini-google', bucketKind: 'short',
      remaining: 900, limit: 1000, now: 1000, pipelineDir: tmpDir,
    });
    assert.equal(ok, true);
    // Se escribió local.
    assert.equal(fs.existsSync(path.join(tmpDir, 'state', 'provider-quota.json')), true);
    // El store central NO tiene contador para el free tier.
    assert.equal(await rawItem(driver, _quotaKeyFor('gemini-google')), null);
    // Y el store sigue vacío mientras sólo hubo medición local.
    void store;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('SEC-1 · el ítem persistido SÓLO contiene contadores/metadata, ningún secreto', async () => {
  const { store, driver } = makeStore();
  // El caller intenta colar material sensible por params; NO debe persistirse.
  await debitPaidQuota(store, {
    provider: 'anthropic',
    deltaTokens: 100,
    apiKey: 'sk-supersecretkey123456',
    token: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig',
    awsKey: 'AKIAIOSFODNN7EXAMPLE',
    cost_usd: 4.2,
    password: 'hunter2',
  });

  const item = await rawItem(driver, _quotaKeyFor('anthropic'));
  assert.ok(item, 'el contador central debe existir');

  // El body.value SÓLO tiene el contador.
  assert.deepEqual(Object.keys(item.body.value), ['consumed']);
  assert.equal(item.body.value.consumed, 100);

  // Escaneo recursivo de secretos sobre TODO el ítem persistido.
  const strings = collectStrings(item);
  for (const s of strings) {
    for (const re of SECRET_PATTERNS) {
      assert.equal(re.test(s), false, `patrón de secreto ${re} encontrado en: ${s}`);
    }
  }
});

test('SEC-1 · las claves del envelope son sólo estructura/metadata conocida', async () => {
  const { store, driver } = makeStore();
  await debitPaidQuota(store, { provider: 'openai-codex', deltaTokens: 10 });
  const item = await rawItem(driver, _quotaKeyFor('openai-codex'));

  assert.deepEqual(Object.keys(item).sort(), ['PK', 'SK', 'body', 'entityType', 'projectId', 'schemaVersion']);
  const bodyKeys = Object.keys(item.body).sort();
  // Sólo contador (value), versión y metadata de escritura. Nada de secretos.
  assert.deepEqual(bodyKeys, ['key', 'updatedAt', 'updatedBy', 'value', 'version']);
});

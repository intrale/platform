// =============================================================================
// commander-delivery-state.test.js — #6458.
//
// Cubre el contrato del estado de ENTREGA del Commander en el audit:
//
//   T-1  Coherencia cross-source del enum `DELIVERY_STATES` entre
//        `multi-provider.js` e `inflight-fallback.js` (están duplicados a
//        propósito para no crear un require circular; si se toca uno sin el
//        otro, este test rompe).
//   T-2  `auditCommanderRequest` emite `commander_req_id` / `delivery_state`
//        ESTRICTAMENTE al final del entry (patrón aditivo #4413/#4438).
//   T-3  No-regresión del shape canónico + hash-chain: `audit-log.readAll`
//        parsea y `verifyChain` verifica con y sin los campos nuevos.
//   T-4  `readCommanderStats` devuelve el MISMO conteo con y sin campos nuevos.
//   T-5  Fail-closed: `deliveryState` fuera del enum ⇒ `null`, nunca crudo.
//   T-6  El `commander_req_id` que se emite jamás lleva el chat id crudo.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mp = require('../multi-provider');
const inflight = require('../inflight-fallback');
const requestLog = require('../request-log');
const auditLog = require('../../audit-log');

function tmpPipelineDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-state-'));
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  return dir;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

function auditFileOf(dir, now) {
  const d = now ? new Date(now) : new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return path.join(dir, 'logs', `commander-dispatch-${yyyy}-${mm}-${dd}.jsonl`);
}

// --- T-1 ---------------------------------------------------------------------
test('#6458: el enum DELIVERY_STATES es idéntico en multi-provider e inflight-fallback', () => {
  const a = [...mp.DELIVERY_STATES].sort();
  const b = [...inflight.DELIVERY_STATES].sort();
  assert.deepEqual(a, b, 'los dos sets tienen que moverse juntos');
  assert.deepEqual(a, ['delivery_failed', 'delivery_observed', 'delivery_pending']);
});

test('#6458: `delivery_observed` y `delivery_failed` NO se emiten en este bloque', () => {
  // Este issue sólo deja de AFIRMAR una entrega. Quien resuelve el estado
  // terminal es #6459 vía `noteFallbackDeliveryResolved`. El enum ya los
  // contempla para que el consumidor no tenga que ampliarlo después.
  assert.ok(mp.DELIVERY_STATES.has('delivery_observed'));
  assert.ok(mp.DELIVERY_STATES.has('delivery_failed'));
});

// --- T-2 ---------------------------------------------------------------------
test('#6458: auditCommanderRequest pone commander_req_id / delivery_state al FINAL del entry', () => {
  const dir = tmpPipelineDir();
  try {
    const ok = mp.auditCommanderRequest({
      pipelineDir: dir,
      event: 'dispatch',
      providerEffective: 'anthropic',
      chatId: 'c1',
      prompt: 'hola',
      commanderReqId: 'abc123def456-1756039552000',
      deliveryState: 'delivery_pending',
    });
    assert.equal(ok, true);

    const entries = auditLog.readAll(auditFileOf(dir));
    assert.equal(entries.length, 1);
    const keys = Object.keys(entries[0]);
    assert.ok(keys.indexOf('commander_req_id') > keys.indexOf('chain_evaluated'),
      'commander_req_id va DESPUÉS del último campo aditivo previo (#4438)');
    assert.ok(keys.indexOf('delivery_state') > keys.indexOf('commander_req_id'));
    assert.equal(entries[0].commander_req_id, 'abc123def456-1756039552000');
    assert.equal(entries[0].delivery_state, 'delivery_pending');
  } finally { cleanup(dir); }
});

test('#6458: sin los campos nuevos, el entry los trae en null (shape canónico preservado)', () => {
  const dir = tmpPipelineDir();
  try {
    mp.auditCommanderRequest({
      pipelineDir: dir, event: 'dispatch', providerEffective: 'anthropic', chatId: 'c1', prompt: '',
    });
    const e = auditLog.readAll(auditFileOf(dir))[0];
    assert.equal(e.commander_req_id, null);
    assert.equal(e.delivery_state, null);
  } finally { cleanup(dir); }
});

// --- T-3 ---------------------------------------------------------------------
test('#6458: la hash-chain verifica mezclando entradas con y sin los campos nuevos', () => {
  const dir = tmpPipelineDir();
  try {
    mp.auditCommanderRequest({ pipelineDir: dir, event: 'dispatch', providerEffective: 'anthropic', chatId: 'c', prompt: 'a' });
    mp.auditCommanderRequest({
      pipelineDir: dir, event: 'fallback_used', providerEffective: 'openai-codex', chatId: 'c', prompt: 'b',
      commanderReqId: 'h-1', deliveryState: 'delivery_pending',
    });
    mp.auditCommanderRequest({ pipelineDir: dir, event: 'commander_response', providerEffective: 'anthropic', chatId: 'c', prompt: '' });

    const file = auditFileOf(dir);
    const entries = auditLog.readAll(file);
    assert.equal(entries.length, 3, 'readAll parsea las 3 entradas');
    const res = auditLog.verifyChain(file);
    assert.equal(res.ok, true, JSON.stringify(res));
  } finally { cleanup(dir); }
});

// --- T-4 ---------------------------------------------------------------------
test('#6458: readCommanderStats devuelve el mismo conteo con y sin campos nuevos', () => {
  const sinCampos = tmpPipelineDir();
  const conCampos = tmpPipelineDir();
  try {
    for (const [dir, extra] of [[sinCampos, {}], [conCampos, { commanderReqId: 'h-1', deliveryState: 'delivery_pending' }]]) {
      mp.auditCommanderRequest({ pipelineDir: dir, event: 'dispatch', providerEffective: 'anthropic', chatId: 'c', prompt: '', ...extra });
      mp.auditCommanderRequest({ pipelineDir: dir, event: 'dispatch', providerEffective: 'anthropic', chatId: 'c', prompt: '', ...extra });
      mp.auditCommanderRequest({ pipelineDir: dir, event: 'dispatch', providerEffective: 'openai-codex', chatId: 'c', prompt: '', ...extra });
    }
    const a = mp.readCommanderStats({ pipelineDir: sinCampos, windowDays: 7 });
    const b = mp.readCommanderStats({ pipelineDir: conCampos, windowDays: 7 });
    assert.equal(a.totalRequests, b.totalRequests);
    assert.deepEqual(Object.keys(a.byProvider).sort(), Object.keys(b.byProvider).sort());
    assert.equal(a.byProvider.anthropic.count, b.byProvider.anthropic.count);
  } finally { cleanup(sinCampos); cleanup(conCampos); }
});

// --- T-5 ---------------------------------------------------------------------
test('#6458: auditCommanderRequest es fail-closed con deliveryState fuera del enum', () => {
  const dir = tmpPipelineDir();
  try {
    for (const malo of ['entregado', 'DELIVERY_PENDING', 42, {}, '../../etc/passwd']) {
      mp.auditCommanderRequest({
        pipelineDir: dir, event: 'dispatch', providerEffective: 'anthropic', chatId: 'c', prompt: '',
        deliveryState: malo,
      });
    }
    const entries = auditLog.readAll(auditFileOf(dir));
    assert.equal(entries.length, 5);
    for (const e of entries) assert.equal(e.delivery_state, null);
    assert.equal(JSON.stringify(entries).includes('etc/passwd'), false);
  } finally { cleanup(dir); }
});

// --- T-6 ---------------------------------------------------------------------
test('#6458 CA-9: el commander_req_id derivado no filtra el chat id crudo al audit', () => {
  const dir = tmpPipelineDir();
  const chatId = -1001234567890;
  try {
    const reqId = requestLog.buildRequestId(chatId, 1756039552000);
    assert.ok(reqId.includes(String(chatId)), 'el reqId CRUDO sí lo contiene (por eso hay que seudonimizar)');

    mp.auditCommanderRequest({
      pipelineDir: dir, event: 'dispatch', providerEffective: 'anthropic', chatId, prompt: '',
      commanderReqId: requestLog.buildAuditReqRef(reqId),
    });
    const raw = fs.readFileSync(auditFileOf(dir), 'utf8');
    assert.equal(raw.includes('1001234567890'), false, 'cero chat ids crudos en la cadena');

    const e = auditLog.readAll(auditFileOf(dir))[0];
    assert.equal(e.commander_req_id.split('-')[0], e.chat_id_hash,
      'el 1er segmento coincide con el chat_id_hash de la MISMA entrada');
  } finally { cleanup(dir); }
});

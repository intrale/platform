// =============================================================================
// telegram-receipt.js — Bus de recibos cross-proceso de entrega Telegram (#4082)
// =============================================================================
//
// Problema que resuelve (incidente real 2026-06-18): el Commander (`pulpo.js`)
// registraba un saliente como `enviado` en el instante en que lo ENCOLABA en la
// cola de archivos, antes de que `svc-telegram` lo entregara al API. Cuando la
// entrega fallaba (HTTP_TIMEOUT / ENOTFOUND), el mensaje nunca llegaba pero el
// historial decía "enviado" → el Commander afirmaba "ya te respondí" en falso.
//
// El Commander y `svc-telegram` son PROCESOS DISTINTOS: no comparten memoria.
// Este módulo centraliza un **bus de recibos por filesystem** (mismo patrón que
// el resto del pipeline) que liga ambos lados por un `correlationId`:
//
//   1. El Commander estampa un `correlationId` en el dropfile y registra el
//      saliente como `encolado` (no `enviado`).
//   2. `svc-telegram` entrega el mensaje y SOLO cuando el API responde
//      `ok:true` con `message_id` escribe un recibo `enviado` con los ids.
//      Si la entrega falla de forma terminal, escribe un recibo `fallido`.
//   3. El Commander, en su loop, lee `recibos/`, reconcilia el historial
//      (`encolado` → `enviado`/`fallido`) ligado por `correlationId`, y archiva
//      el recibo consumido.
//
// Reglas inquebrantables (SEC-2, fail-closed):
//
//  R1. **`message_id` es la única prueba de entrega.** Un recibo `enviado` SIN
//      `messageIds` (array no vacío de números) es inválido. El nombre de archivo
//      NUNCA es prueba.
//  R2. **Fail-closed:** `parseReceipt` rechaza recibo malformado / forjado /
//      parcial / con `correlationId` inválido y devuelve `null`. NUNCA hace
//      default a `enviado`. El caller trata `null` como cuarentena/fallido.
//  R3. **`correlationId` sin path-traversal:** validado contra una regex
//      estricta (`[A-Za-z0-9._-]`, sin `..`) porque deriva el nombre de archivo
//      del recibo. Patrón copiado de la familia `validateIssueId` del pipeline.
//  R4. **Módulo puro:** sin side-effects al requerir, sin credenciales, sin red.
//      Toda la lógica testeable con `node --test`. Espeja `architect-audit.js` /
//      `telegram-burst-grouper.js`.
//
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// -----------------------------------------------------------------------------
// Constantes
// -----------------------------------------------------------------------------
const STATUS_ENVIADO = 'enviado';
const STATUS_FALLIDO = 'fallido';
const VALID_STATUSES = [STATUS_ENVIADO, STATUS_FALLIDO];

// `correlationId` deriva un nombre de archivo: solo chars seguros, 6-128 de
// largo, y rechazo explícito de `..` (defensa path-traversal — R3).
const CORRELATION_ID_RE = /^[A-Za-z0-9._-]{6,128}$/;

// -----------------------------------------------------------------------------
// Validación de correlationId (R3)
// -----------------------------------------------------------------------------
function isValidCorrelationId(id) {
  if (typeof id !== 'string') return false;
  if (!CORRELATION_ID_RE.test(id)) return false;
  if (id.includes('..')) return false; // path-traversal defensivo
  return true;
}

/**
 * Genera un correlationId único para un saliente. Formato:
 *   `cmd-<epochMs>-<8 hex random>`
 * Determinístico-seguro para nombre de archivo (R3).
 */
function generateCorrelationId(prefix = 'cmd') {
  const safePrefix = String(prefix).replace(/[^A-Za-z0-9]+/g, '').slice(0, 16) || 'cmd';
  const rand = crypto.randomBytes(4).toString('hex');
  return `${safePrefix}-${Date.now()}-${rand}`;
}

// -----------------------------------------------------------------------------
// Validación de messageIds: array de números finitos. Para `enviado` debe ser
// NO vacío (R1). Para `fallido` se acepta vacío (no hubo entrega).
// -----------------------------------------------------------------------------
function isValidMessageIds(ids, { requireNonEmpty }) {
  if (!Array.isArray(ids)) return false;
  if (requireNonEmpty && ids.length === 0) return false;
  return ids.every((n) => typeof n === 'number' && Number.isFinite(n));
}

// -----------------------------------------------------------------------------
// buildReceipt — productor. Valida fail-closed y lanza ante datos inválidos
// (un productor NUNCA debe poder emitir un recibo `enviado` sin prueba — R1/R2).
// -----------------------------------------------------------------------------
function buildReceipt({ correlationId, status, messageIds, at } = {}) {
  if (!isValidCorrelationId(correlationId)) {
    throw new Error(`telegram-receipt: correlationId inválido: ${JSON.stringify(correlationId)}`);
  }
  if (!VALID_STATUSES.includes(status)) {
    throw new Error(`telegram-receipt: status inválido: ${JSON.stringify(status)}`);
  }
  const ids = Array.isArray(messageIds) ? messageIds.slice() : [];
  const requireNonEmpty = status === STATUS_ENVIADO;
  if (!isValidMessageIds(ids, { requireNonEmpty })) {
    throw new Error(
      `telegram-receipt: messageIds inválido para status=${status}: ${JSON.stringify(messageIds)}`,
    );
  }
  const ts = typeof at === 'string' && at.length > 0 ? at : new Date().toISOString();
  return { correlationId, status, messageIds: ids, at: ts };
}

// -----------------------------------------------------------------------------
// isValidReceipt — predicado fail-closed sobre un objeto ya parseado.
// -----------------------------------------------------------------------------
function isValidReceipt(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if (!isValidCorrelationId(obj.correlationId)) return false;
  if (!VALID_STATUSES.includes(obj.status)) return false;
  const requireNonEmpty = obj.status === STATUS_ENVIADO;
  if (!isValidMessageIds(obj.messageIds, { requireNonEmpty })) return false;
  if (typeof obj.at !== 'string' || obj.at.length === 0) return false;
  return true;
}

/**
 * parseReceipt — consumidor fail-closed (R2). Acepta un string JSON o un objeto.
 * Devuelve el recibo normalizado SOLO si es válido; en cualquier otro caso
 * (JSON roto, esquema inválido, `enviado` sin `messageIds`, `correlationId`
 * traversal, etc.) devuelve `null`. NUNCA hace default a `enviado`.
 *
 * @param {string|object} raw
 * @returns {{correlationId:string,status:string,messageIds:number[],at:string}|null}
 */
function parseReceipt(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isValidReceipt(obj)) return null;
  // Normalizar: copiar solo los campos canónicos (descartar payload extra
  // que un recibo forjado pudiera arrastrar).
  return {
    correlationId: obj.correlationId,
    status: obj.status,
    messageIds: obj.messageIds.slice(),
    at: obj.at,
  };
}

// -----------------------------------------------------------------------------
// Paths del bus de recibos
// -----------------------------------------------------------------------------
function receiptsDir(pipelineDir) {
  return path.join(pipelineDir, 'servicios', 'telegram', 'recibos');
}

function archivedReceiptsDir(pipelineDir) {
  return path.join(receiptsDir(pipelineDir), 'archivado');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * writeReceipt — escribe (atómicamente) un recibo en `recibosDir`. Valida vía
 * `buildReceipt` antes de tocar disco (R1/R2): si los datos son inválidos lanza
 * y NO deja un archivo a medias. El nombre de archivo es `<correlationId>.json`.
 *
 * @returns {string} path del recibo escrito
 */
function writeReceipt(recibosDir, fields) {
  const receipt = buildReceipt(fields);
  ensureDir(recibosDir);
  const finalPath = path.join(recibosDir, `${receipt.correlationId}.json`);
  const tmpPath = `${finalPath}.tmp-${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmpPath, JSON.stringify(receipt, null, 2));
  fs.renameSync(tmpPath, finalPath);
  return finalPath;
}

function listReceiptFiles(recibosDir) {
  try {
    return fs.readdirSync(recibosDir)
      .filter((f) => !f.startsWith('.') && f.endsWith('.json'))
      .map((f) => ({ name: f, path: path.join(recibosDir, f) }));
  } catch {
    return [];
  }
}

/**
 * readReceiptFile — lee y parsea fail-closed (R2). Devuelve `null` si el archivo
 * no existe, no parsea, o el esquema es inválido.
 */
function readReceiptFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  return parseReceipt(raw);
}

/**
 * resolveMessageId — #4105 (EP2-H5b · CA-6). Resuelve el `message_id` real de
 * entrega dado un `correlationId`, leyendo el bus de recibos. El `message_id` es
 * la ÚNICA prueba de entrega (R1 #4082): solo un recibo `enviado` válido con
 * `messageIds` no vacío resuelve. Nunca deriva el id del nombre de archivo.
 *
 * Propiedades (necesarias para la corrección async idempotente del modelo
 * optimista):
 *  - **Idempotente:** dado el mismo `correlationId` devuelve siempre el mismo id
 *    (el primero del array `messageIds`); no muta estado.
 *  - **Fail-closed:** recibo ausente / malformado / forjado / `fallido` /
 *    `correlationId` inválido → `null` (cuarentena). Reusa `parseReceipt` (R2).
 *  - **Out-of-order safe:** lee el recibo por nombre `<correlationId>.json`; si
 *    aún no llegó, devuelve `null` y el caller reintenta cuando el recibo exista.
 *
 * @param {string} recibosDir directorio del bus de recibos
 * @param {string} correlationId id de correlación del saliente
 * @returns {number|null} message_id de entrega, o `null` si aún no hay prueba
 */
function resolveMessageId(recibosDir, correlationId) {
  if (!isValidCorrelationId(correlationId)) return null;
  if (typeof recibosDir !== 'string' || recibosDir.length === 0) return null;
  const filePath = path.join(recibosDir, `${correlationId}.json`);
  const receipt = readReceiptFile(filePath); // fail-closed (R2)
  if (!receipt) return null;
  if (receipt.status !== STATUS_ENVIADO) return null; // solo entrega probada
  if (receipt.correlationId !== correlationId) return null; // sanity vs forja
  if (!isValidMessageIds(receipt.messageIds, { requireNonEmpty: true })) return null;
  return receipt.messageIds[0];
}

/**
 * archiveReceipt — mueve un recibo consumido a `recibos/archivado/`. Best-effort:
 * si no se puede mover (otro proceso lo tomó), devuelve false sin lanzar.
 */
function archiveReceipt(filePath, archivedDir) {
  try {
    ensureDir(archivedDir);
    const dest = path.join(archivedDir, path.basename(filePath));
    fs.renameSync(filePath, dest);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  STATUS_ENVIADO,
  STATUS_FALLIDO,
  VALID_STATUSES,
  isValidCorrelationId,
  generateCorrelationId,
  buildReceipt,
  isValidReceipt,
  parseReceipt,
  receiptsDir,
  archivedReceiptsDir,
  writeReceipt,
  listReceiptFiles,
  readReceiptFile,
  resolveMessageId,
  archiveReceipt,
};

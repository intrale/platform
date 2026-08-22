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
// #4750 — Dimensión de CHUNK de audio (part_index / part_total).
//
// Cuando una respuesta de voz se fragmenta en M audios, cada chunk lleva un
// `partIndex` (0..M-1) y `partTotal` (M) atados al mismo `correlationId` padre.
// Estos valores derivan el NOMBRE del archivo del recibo (`<cid>-p<idx>.json`),
// por eso deben coercionarse a entero y acotarse antes de usarse — SEC-R2:
// evita path-traversal en el nombre del recibo e inyección CRLF.
// -----------------------------------------------------------------------------

// coercePartInt — devuelve un entero >= 0 o null (fail-closed). Rechaza
// decimales, negativos, strings no-numéricas, NaN, Infinity. Acepta un string
// de solo dígitos (`"3"`) porque un dropfile es JSON y podría traerlo así, pero
// NUNCA texto libre (SEC-R2).
function coercePartInt(v) {
  if (typeof v === 'number') {
    return Number.isInteger(v) && v >= 0 ? v : null;
  }
  if (typeof v === 'string' && /^\d+$/.test(v)) {
    const n = Number.parseInt(v, 10);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  }
  return null;
}

// isValidPartDims — coerción + acotado: ambos enteros >= 0, partTotal >= 1 y
// `0 <= partIndex < partTotal`. Es el invariante que hace seguro derivar el
// nombre de archivo del recibo por-parte.
function isValidPartDims(partIndex, partTotal) {
  const i = coercePartInt(partIndex);
  const t = coercePartInt(partTotal);
  if (i == null || t == null) return false;
  if (t < 1) return false;
  if (i < 0 || i >= t) return false;
  return true;
}

// Variante estricta (sin coerción): exige enteros reales. La usa `isValidReceipt`
// sobre un recibo YA persistido, que SIEMPRE guarda enteros (buildReceipt
// coerciona al construir). Un recibo forjado con strings en las dims → inválido.
function isStrictPartDims(partIndex, partTotal) {
  if (!Number.isInteger(partIndex) || !Number.isInteger(partTotal)) return false;
  if (partTotal < 1) return false;
  if (partIndex < 0 || partIndex >= partTotal) return false;
  return true;
}

// ¿el objeto trae dimensión de chunk declarada? (cualquiera de las dos claves).
function hasPartDims(obj) {
  return obj != null && (obj.partIndex !== undefined || obj.partTotal !== undefined);
}

// -----------------------------------------------------------------------------
// buildReceipt — productor. Valida fail-closed y lanza ante datos inválidos
// (un productor NUNCA debe poder emitir un recibo `enviado` sin prueba — R1/R2).
// -----------------------------------------------------------------------------
function buildReceipt({ correlationId, status, messageIds, at, partIndex, partTotal } = {}) {
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
  const receipt = { correlationId, status, messageIds: ids, at: ts };
  // #4750 — dimensión de chunk opcional. Si viene UNA de las dos claves, exigimos
  // AMBAS válidas (fail-closed): un recibo `enviado` de un chunk sin acotar sería
  // un vector de path-traversal en el nombre del recibo (SEC-R2). Se coercionan a
  // entero y se persisten como enteros (no como el string crudo del dropfile).
  if (hasPartDims({ partIndex, partTotal })) {
    if (!isValidPartDims(partIndex, partTotal)) {
      throw new Error(
        `telegram-receipt: partIndex/partTotal inválido: ${JSON.stringify({ partIndex, partTotal })}`,
      );
    }
    receipt.partIndex = coercePartInt(partIndex);
    receipt.partTotal = coercePartInt(partTotal);
  }
  return receipt;
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
  // #4750 — si el recibo persistido declara dimensión de chunk, DEBE traer
  // enteros reales acotados (fail-closed R2/SEC-R2). Strings o decimales en un
  // recibo persistido → forjado/corrupto → inválido; NUNCA default a `enviado`.
  if (hasPartDims(obj)) {
    if (!isStrictPartDims(obj.partIndex, obj.partTotal)) return false;
  }
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
  const out = {
    correlationId: obj.correlationId,
    status: obj.status,
    messageIds: obj.messageIds.slice(),
    at: obj.at,
  };
  // #4750 — arrastrar la dimensión de chunk cuando está presente y válida
  // (ya garantizado por `isValidReceipt`).
  if (hasPartDims(obj)) {
    out.partIndex = obj.partIndex;
    out.partTotal = obj.partTotal;
  }
  return out;
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
  const finalPath = path.join(recibosDir, receiptFileName(receipt));
  const tmpPath = `${finalPath}.tmp-${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmpPath, JSON.stringify(receipt, null, 2));
  fs.renameSync(tmpPath, finalPath);
  return finalPath;
}

// #4750 — Nombre de archivo del recibo. Con dimensión de chunk usa
// `<correlationId>-p<partIndex>.json` (partIndex ya coercionado a entero por
// `buildReceipt`, sin traversal). Sin chunk conserva `<correlationId>.json`
// (retrocompatible con los recibos de texto de #4082).
function receiptFileName(receipt) {
  if (Number.isInteger(receipt.partIndex) && Number.isInteger(receipt.partTotal)) {
    return `${receipt.correlationId}-p${receipt.partIndex}.json`;
  }
  return `${receipt.correlationId}.json`;
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

/**
 * resolveMessageId — #4105 (CA-6). Dado un `correlationId`, devuelve el primer
 * `message_id` de un recibo `enviado` VÁLIDO en `recibosDir`. Es la base de la
 * captura asíncrona del `message_id` para el camino optimista de Sherlock: el
 * Commander obtiene un `correlationId` al encolar, y el `message_id` (única
 * prueba de entrega — R1) llega después por recibo.
 *
 * Fail-closed (R1/R2/R3):
 *   - `correlationId` inválido / con path-traversal → `null` (NUNCA toca disco
 *     con un nombre derivado de input inseguro).
 *   - recibo ausente / malformado / forjado → `null` (parseReceipt fail-closed).
 *   - recibo `fallido` o `enviado` sin `messageIds` → `null` (no hubo entrega).
 *   - El `message_id` se deriva SOLO del contenido del recibo, NUNCA del nombre
 *     de archivo.
 *
 * Idempotente y determinístico: ante el MISMO recibo `enviado` válido devuelve
 * siempre el mismo `message_id` (el primero del array). El llamador (registry)
 * dedupea ediciones por `verificationId`+`correlationId`, así que una resolución
 * repetida (recibo duplicado / fuera de orden) nunca dispara una doble edición.
 *
 * @param {string} correlationId
 * @param {string} recibosDir   directorio del bus de recibos.
 * @returns {number|null} el message_id, o null si no se puede resolver.
 */
function resolveMessageId(correlationId, recibosDir) {
  if (!isValidCorrelationId(correlationId)) return null;
  if (typeof recibosDir !== 'string' || recibosDir.length === 0) return null;
  const filePath = path.join(recibosDir, `${correlationId}.json`);
  const receipt = readReceiptFile(filePath);
  if (!receipt) return null; // ausente / malformado / forjado (R2)
  if (receipt.status !== STATUS_ENVIADO) return null; // solo entrega confirmada (R1)
  if (!Array.isArray(receipt.messageIds) || receipt.messageIds.length === 0) return null;
  const id = receipt.messageIds[0];
  return Number.isFinite(id) ? id : null;
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
  // #4750 — dimensión de chunk de audio (coerción/validación fail-closed + nombre).
  coercePartInt,
  isValidPartDims,
  hasPartDims,
  receiptFileName,
  listReceiptFiles,
  readReceiptFile,
  archiveReceipt,
  // #4105 — captura async del message_id para el camino optimista (CA-6).
  resolveMessageId,
};

// =============================================================================
// voice-delivery-audit.js — Traza append-only de entrega de partes de voz (#5573)
// =============================================================================
//
// PROBLEMA QUE RESUELVE
//
// 1. Duplicados invisibles. El recibo por parte (`<cid>-p<idx>.json`) se
//    SOBRESCRIBE en cada envío: sólo sobrevive el último `message_id`. Cuando el
//    sweep reenviaba una parte que seguía en vuelo, el operador recibía el audio
//    2-4 veces y en disco no quedaba rastro de los envíos intermedios. Un
//    `(correlationId, partIndex)` con más de un evento `sent` en este JSONL ES,
//    por definición, un duplicado entregado — detectable en auditoría.
//
// 2. Backoff calibrado a ojo. `telegram_voice_outbound.backoff_base_ms` se fijó
//    con una medición manual puntual (~62-74s). El evento `confirmed` lleva
//    `latencyMs` desde `firstEnqueuedAt`, así que el p50/p95 real se computa
//    offline sobre la serie y la política se recalibra con dato.
//
// DECISIONES DE DISEÑO (no negociables)
//
//   - APPEND-ONLY, nunca read-modify-write (SEC-D). La alternativa "acumular los
//     message_id dentro del recibo" obligaría a un RMW desde DOS procesos
//     (svc-telegram escribe recibos, el commander los reconcilia) → race que
//     puede PERDER una confirmación → reenvío eterno, agravando el mismo bug que
//     este issue viene a matar. Por eso `receiptFileName` no se toca: el nombre
//     `<cid>-p<idx>.json` es contrato con el reconciliador.
//
//   - SÓLO IDENTIFICADORES Y TIMINGS (SEC-E / R7). Prohibido el texto de la
//     respuesta, el path del `.ogg` y cualquier contenido del chat. El JSONL vive
//     en disco con retención de 30 días: cuanto menos haya adentro, menor el
//     blast radius. `redact: true` en la rotación como segunda barrera.
//
//   - BEST-EFFORT SIEMPRE. Auditar NUNCA puede romper una entrega: todo va
//     envuelto en try/catch y cualquier fallo se traga en silencio.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

const rotation = require('./jsonl-rotation');
const rec = require('./telegram-receipt');

const AUDIT_BASENAME = 'telegram-voice-delivery';
const RETENTION_DAYS = 30;

const EVENT_SENT = 'sent';
const EVENT_CONFIRMED = 'confirmed';
const VALID_EVENTS = [EVENT_SENT, EVENT_CONFIRMED];

function auditDir(pipelineDir) {
  return path.join(pipelineDir, 'audit');
}

function auditFilePath(pipelineDir) {
  return path.join(auditDir(pipelineDir), `${AUDIT_BASENAME}.jsonl`);
}

// -----------------------------------------------------------------------------
// buildEvent — PURA. Normaliza y ACOTA el evento fail-closed: devuelve `null` si
// no cumple el contrato mínimo, en vez de escribir una línea basura que después
// envenene el cómputo de p50/p95.
//
// Los campos numéricos opcionales sólo se emiten si son enteros >= 0. Nada de
// campos libres: la whitelist de abajo es el contrato completo (SEC-E).
// -----------------------------------------------------------------------------
function buildEvent(ev = {}) {
  if (!VALID_EVENTS.includes(ev.event)) return null;
  if (!rec.isValidCorrelationId(ev.correlationId)) return null;
  const partIndex = rec.coercePartInt(ev.partIndex);
  const partTotal = rec.coercePartInt(ev.partTotal);
  if (partIndex == null || partTotal == null) return null;

  const out = {
    ts: typeof ev.ts === 'string' && ev.ts.length > 0 ? ev.ts : new Date().toISOString(),
    event: ev.event,
    correlationId: ev.correlationId,
    partIndex,
    partTotal,
  };
  // `messageId` viene de Telegram: puede ser un entero grande, no se coerciona
  // con `coercePartInt` (que exige >= 0 y es para dims de parte).
  if (Number.isFinite(ev.messageId)) out.messageId = ev.messageId;
  const attempt = rec.coercePartInt(ev.attempt);
  if (attempt != null) out.attempt = attempt;
  const retries = rec.coercePartInt(ev.retries);
  if (retries != null) out.retries = retries;
  // Latencia negativa = reloj corrido o `firstEnqueuedAt` corrupto → se omite
  // antes que contaminar la serie con un outlier imposible.
  if (Number.isFinite(ev.latencyMs) && ev.latencyMs >= 0) out.latencyMs = Math.round(ev.latencyMs);
  return out;
}

// -----------------------------------------------------------------------------
// appendVoiceDeliveryEvent — I/O best-effort. Rota si hace falta y appendea UNA
// línea. Nunca lanza.
// -----------------------------------------------------------------------------
function appendVoiceDeliveryEvent(pipelineDir, ev) {
  const line = buildEvent(ev);
  if (!line) return false;
  try {
    const dir = auditDir(pipelineDir);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const filePath = auditFilePath(pipelineDir);
    rotation.rotateIfNeeded({ path: filePath, redact: true });
    fs.appendFileSync(filePath, `${JSON.stringify(line)}\n`);
    return true;
  } catch {
    // Auditar nunca rompe la entrega.
    return false;
  }
}

// -----------------------------------------------------------------------------
// cleanupVoiceDeliveryArchives — retención de 30 días de los `.gz` rotados
// (cierra el requisito de rotación de SEC-E). Se llama en el mismo tick del
// sweep. Best-effort.
// -----------------------------------------------------------------------------
function cleanupVoiceDeliveryArchives(pipelineDir) {
  try {
    return rotation.cleanupOldArchives({
      dir: auditDir(pipelineDir),
      basename: AUDIT_BASENAME,
      retentionDays: RETENTION_DAYS,
    });
  } catch {
    return { deleted: 0 };
  }
}

// -----------------------------------------------------------------------------
// computeLatencyStats — PURA. p50/p95 sobre una serie de eventos `confirmed`.
// Es la herramienta con la que se recalibra `backoff_base_ms` (cambio 4 de
// #5573): hoy ese valor es provisional y se fijó con una medición manual.
//
// Acepta las líneas ya parseadas (el caller decide de dónde salen: archivo
// activo, `.gz` rotado, o un array de test).
// -----------------------------------------------------------------------------
function computeLatencyStats(events) {
  const samples = (events || [])
    .filter((e) => e && e.event === EVENT_CONFIRMED && Number.isFinite(e.latencyMs) && e.latencyMs >= 0)
    .map((e) => e.latencyMs)
    .sort((a, b) => a - b);
  if (samples.length === 0) return { count: 0, p50: null, p95: null, max: null };
  // Percentil por nearest-rank: índice = ceil(p * n) - 1, acotado al rango.
  const at = (p) => samples[Math.min(samples.length - 1, Math.max(0, Math.ceil(p * samples.length) - 1))];
  return {
    count: samples.length,
    p50: at(0.5),
    p95: at(0.95),
    max: samples[samples.length - 1],
  };
}

// -----------------------------------------------------------------------------
// findDuplicateSends — PURA. Devuelve los `(correlationId, partIndex)` con más de
// un evento `sent`: cada uno es un audio que el operador recibió repetido. Es la
// consulta de auditoría que este issue habilita (antes el dato no existía).
// -----------------------------------------------------------------------------
function findDuplicateSends(events) {
  const counts = new Map();
  for (const e of (events || [])) {
    if (!e || e.event !== EVENT_SENT) continue;
    if (!Number.isInteger(e.partIndex)) continue;
    const key = `${e.correlationId}#${e.partIndex}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const out = [];
  for (const [key, count] of counts) {
    if (count <= 1) continue;
    const sep = key.lastIndexOf('#');
    out.push({ correlationId: key.slice(0, sep), partIndex: Number(key.slice(sep + 1)), sends: count });
  }
  return out.sort((a, b) => b.sends - a.sends);
}

// readVoiceDeliveryEvents — I/O best-effort: parsea el JSONL ACTIVO (no los
// `.gz`). Líneas corruptas se saltean, nunca rompen la lectura.
function readVoiceDeliveryEvents(pipelineDir) {
  let raw;
  try { raw = fs.readFileSync(auditFilePath(pipelineDir), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* línea corrupta: se saltea */ }
  }
  return out;
}

module.exports = {
  AUDIT_BASENAME,
  RETENTION_DAYS,
  EVENT_SENT,
  EVENT_CONFIRMED,
  auditDir,
  auditFilePath,
  buildEvent,
  appendVoiceDeliveryEvent,
  cleanupVoiceDeliveryArchives,
  computeLatencyStats,
  findDuplicateSends,
  readVoiceDeliveryEvents,
};

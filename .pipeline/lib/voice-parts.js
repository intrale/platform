// =============================================================================
// voice-parts.js — Contabilidad + reconciliación de chunks de audio (#4750)
// =============================================================================
//
// Problema (incidente real #4748): cuando una respuesta de voz se fragmenta en
// M audios, cada chunk se enviaba fire-and-forget. Si una parte se perdía en la
// entrega (llegó solo la 2/2), nada lo detectaba ni la reenviaba — hueco
// silencioso. Este módulo lleva la contabilidad POR RESPUESTA de las M partes,
// ligadas a UN `correlationId` padre, y decide reenvíos/aviso.
//
// Enfoque (Opción A del arquitecto): el audio se enruta por la cola
// `servicio-telegram.js` (rama multipart `voice`) para heredar `assertDelivered`
// (fail-closed: `ok:true` + `message_id`) y `writeSentReceiptIfAny`. Cada chunk
// escribe un recibo por-parte (`<cid>-p<idx>.json`, con `partIndex`/`partTotal`).
// El Commander, en su tick de reconciliación:
//   1. lee los recibos por-parte y marca la parte confirmada en el estado, y
//   2. barre los estados: si falta una parte tras el timeout la reenvía (tope N
//      reintentos + backoff, misma política que texto — #4082); si se agotan los
//      reintentos avisa al usuario en el chat del padre (nunca hueco silencioso).
//
// Reglas fail-closed (espeja telegram-receipt.js):
//   - Una parte se marca `confirmed` SOLO por un recibo `enviado` con message_id
//     (lo garantiza svc-telegram antes de escribir el recibo — SEC-R1). Este
//     módulo nunca fabrica confirmaciones.
//   - `correlationId` valida contra la regex estricta del bus de recibos (no
//     path-traversal): deriva el nombre del archivo de estado.
//   - `partIndex`/`partTotal` se coercionan y acotan (SEC-R2).
//
// Módulo con I/O acotado (lee/escribe `servicios/telegram/voice-parts/`), pero la
// lógica de decisión (`planSweep`, `formatMissingNotice`) es PURA y testeable con
// `node --test` sin tocar disco ni red.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const rec = require('./telegram-receipt');

// -----------------------------------------------------------------------------
// Paths del estado de contabilidad
// -----------------------------------------------------------------------------
function voicePartsDir(pipelineDir) {
  return path.join(pipelineDir, 'servicios', 'telegram', 'voice-parts');
}
function archivedVoicePartsDir(pipelineDir) {
  return path.join(voicePartsDir(pipelineDir), 'archivado');
}
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// -----------------------------------------------------------------------------
// ¿un recibo (ya parseado por telegram-receipt) es de un chunk de audio?
// -----------------------------------------------------------------------------
function isVoicePartReceipt(receipt) {
  return !!receipt
    && Number.isInteger(receipt.partIndex)
    && Number.isInteger(receipt.partTotal);
}

// -----------------------------------------------------------------------------
// Estado de contabilidad por respuesta padre.
//   { correlationId, partTotal, chatId, createdAt, notified, parts: {
//       "<idx>": { path, enqueuedAt, retries, confirmed } } }
// -----------------------------------------------------------------------------
function statePath(dir, correlationId) {
  if (!rec.isValidCorrelationId(correlationId)) return null;
  return path.join(dir, `${correlationId}.json`);
}

// isValidState — fail-closed. Un estado corrupto/forjado → false (el caller lo
// pone en cuarentena, nunca lo trata como válido).
function isValidState(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if (!rec.isValidCorrelationId(obj.correlationId)) return false;
  if (!Number.isInteger(obj.partTotal) || obj.partTotal < 1) return false;
  if (!obj.parts || typeof obj.parts !== 'object') return false;
  return true;
}

function readState(dir, correlationId) {
  const p = statePath(dir, correlationId);
  if (!p) return null;
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch { return null; }
  let obj;
  try { obj = JSON.parse(raw); } catch { return null; }
  return isValidState(obj) ? obj : null;
}

function writeState(dir, state) {
  if (!isValidState(state)) throw new Error('voice-parts: estado inválido, no se escribe');
  ensureDir(dir);
  const finalPath = path.join(dir, `${state.correlationId}.json`);
  const tmpPath = `${finalPath}.tmp-${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2));
  fs.renameSync(tmpPath, finalPath);
  return finalPath;
}

function archiveState(dir, archivedDir, correlationId) {
  const p = statePath(dir, correlationId);
  if (!p) return false;
  try {
    ensureDir(archivedDir);
    const dest = path.join(archivedDir, `${correlationId}.json`);
    fs.renameSync(p, dest);
    return true;
  } catch { return false; }
}

// -----------------------------------------------------------------------------
// initState — crea el estado al producir la respuesta de voz. `parts` es
// `[{ partIndex, path, enqueuedAt? }]`. Persiste y devuelve el estado.
// -----------------------------------------------------------------------------
function buildInitialState({ correlationId, partTotal, chatId, parts, now }) {
  if (!rec.isValidCorrelationId(correlationId)) {
    throw new Error(`voice-parts: correlationId inválido: ${JSON.stringify(correlationId)}`);
  }
  const pt = rec.coercePartInt(partTotal);
  if (pt == null || pt < 1) {
    throw new Error(`voice-parts: partTotal inválido: ${JSON.stringify(partTotal)}`);
  }
  const createdAt = new Date(Number.isFinite(now) ? now : Date.now()).toISOString();
  const state = {
    correlationId,
    partTotal: pt,
    chatId: chatId != null ? chatId : null,
    createdAt,
    notified: false,
    parts: {},
  };
  for (const p of (parts || [])) {
    const idx = rec.coercePartInt(p.partIndex);
    if (idx == null || idx >= pt) continue; // acotado (SEC-R2)
    state.parts[String(idx)] = {
      path: typeof p.path === 'string' ? p.path : null,
      enqueuedAt: typeof p.enqueuedAt === 'string' && p.enqueuedAt.length > 0 ? p.enqueuedAt : createdAt,
      retries: 0,
      confirmed: false,
    };
  }
  return state;
}

function initState({ pipelineDir, correlationId, partTotal, chatId, parts, now }) {
  const state = buildInitialState({ correlationId, partTotal, chatId, parts, now });
  writeState(voicePartsDir(pipelineDir), state);
  return state;
}

// -----------------------------------------------------------------------------
// applyConfirmation — marca una parte confirmada (idempotente). PURA: muta el
// estado recibido y devuelve true si cambió algo.
// -----------------------------------------------------------------------------
function applyConfirmation(state, partIndex) {
  const idx = rec.coercePartInt(partIndex);
  if (idx == null || !state || !state.parts) return false;
  const p = state.parts[String(idx)];
  if (!p) return false;
  if (p.confirmed) return false;
  p.confirmed = true;
  return true;
}

// recordPartConfirmation — lee el estado, marca la parte, persiste. Best-effort.
function recordPartConfirmation({ pipelineDir, correlationId, partIndex }) {
  const dir = voicePartsDir(pipelineDir);
  const state = readState(dir, correlationId);
  if (!state) return false;
  if (applyConfirmation(state, partIndex)) {
    try { writeState(dir, state); return true; } catch { return false; }
  }
  return false;
}

// -----------------------------------------------------------------------------
// planSweep — DECISIÓN PURA para un estado. Dado `now` y la política de
// reintentos, devuelve qué reenviar, si avisar, el estado actualizado y si el
// estado quedó terminal (el caller lo archiva). No toca disco ni red.
//
// Política por parte no confirmada:
//   - backoff efectivo = min(backoff_max, backoff_base * 2^retries).
//   - si `now - enqueuedAt >= backoff`:
//       - retries < max_retries → reenviar (retries++, enqueuedAt = now).
//       - retries >= max_retries → parte FALLIDA (no hay más reintentos).
//   - si todavía no venció el backoff → sigue pendiente (esperar).
// Además: si el estado es más viejo que `stale_ttl_ms`, se fuerza terminal
// (todas las no confirmadas se dan por fallidas) para no filtrar estados.
//
// Terminal:
//   - todas confirmadas → terminal, sin aviso.
//   - ninguna pendiente y hay fallidas → terminal + aviso consolidado (una vez).
// -----------------------------------------------------------------------------
function planSweep(state, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const maxRetries = Number.isFinite(opts.maxRetries) ? opts.maxRetries : 5;
  const base = Number.isFinite(opts.backoffBaseMs) ? opts.backoffBaseMs : 5000;
  const maxBackoff = Number.isFinite(opts.backoffMaxMs) ? opts.backoffMaxMs : 300000;
  const staleTtl = Number.isFinite(opts.staleTtlMs) ? opts.staleTtlMs : 86400000;

  // Clon defensivo: no mutamos el estado del caller.
  const s = JSON.parse(JSON.stringify(state));
  const resends = [];
  const failedIdx = [];
  let allConfirmed = true;
  let anyPending = false;

  const createdMs = Date.parse(s.createdAt);
  const stale = Number.isFinite(createdMs) && (now - createdMs) >= staleTtl;

  for (let i = 0; i < s.partTotal; i++) {
    const p = s.parts[String(i)];
    if (!p) { continue; } // parte no registrada (no producida) → no cuenta
    if (p.confirmed) { continue; }
    allConfirmed = false;

    if (stale) { failedIdx.push(i); continue; }

    const retries = Number.isInteger(p.retries) ? p.retries : 0;
    const backoff = Math.min(maxBackoff, base * Math.pow(2, retries));
    const enqMs = Date.parse(p.enqueuedAt);
    const elapsed = Number.isFinite(enqMs) ? (now - enqMs) : Infinity;

    if (elapsed >= backoff) {
      if (retries < maxRetries) {
        p.retries = retries + 1;
        p.enqueuedAt = new Date(now).toISOString();
        resends.push({ partIndex: i, path: p.path });
        anyPending = true;
      } else {
        failedIdx.push(i);
      }
    } else {
      anyPending = true; // dentro de la ventana de backoff: esperar
    }
  }

  let terminal = false;
  let notify = null;
  if (allConfirmed) {
    terminal = true;
  } else if (!anyPending) {
    // No quedan reintentos posibles: las no confirmadas son fallidas.
    terminal = true;
    if (failedIdx.length > 0 && !s.notified) {
      notify = {
        partNumbers: failedIdx.map((i) => i + 1), // 1-based, humano
        partTotal: s.partTotal,
        chatId: s.chatId,
      };
      s.notified = true;
    }
  }

  return { resends, notify, state: s, terminal };
}

// -----------------------------------------------------------------------------
// formatMissingNotice — copy del aviso al usuario (CA-4 + guidelines UX). Humano,
// sin jerga: referencia la(s) parte(s) por número (1-based) y aclara que el texto
// completo sí llegó (el contenido no se pierde; el audio es complementario).
// NO expone `correlationId`/`partIndex` crudos. PURA.
// -----------------------------------------------------------------------------
function formatMissingNotice(partNumbers, partTotal) {
  const nums = (partNumbers || []).slice().sort((a, b) => a - b);
  let ref;
  if (nums.length === 0) {
    ref = `una parte del audio`;
  } else if (nums.length === 1) {
    ref = `la parte ${nums[0]} de ${partTotal} del audio`;
  } else {
    const last = nums[nums.length - 1];
    const rest = nums.slice(0, -1);
    ref = `las partes ${rest.join(', ')} y ${last} de ${partTotal} del audio`;
  }
  return `Che, no te pude hacer llegar ${ref} de mi última respuesta después de varios intentos. `
    + `Igual quedate tranquilo: el texto completo sí te lo mandé, así que no perdiste nada del contenido.`;
}

// -----------------------------------------------------------------------------
// sweepVoiceStates — orquesta el barrido de TODOS los estados (I/O + DI). Lee
// cada estado, corre `planSweep`, ejecuta los reenvíos vía `enqueue(...)`, avisa
// vía `notify(...)` y archiva los terminales. Las dependencias se inyectan para
// testear el flujo end-to-end sin tocar la cola real ni Telegram.
//
//   enqueue({ correlationId, partIndex, partTotal, path, chatId })  → reenvía un chunk
//   notify(text, chatId)                                            → avisa al usuario
//   logFn(msg)                                                      → log best-effort
// -----------------------------------------------------------------------------
function sweepVoiceStates({ pipelineDir, now, config = {}, enqueue, notify, logFn }) {
  const dir = voicePartsDir(pipelineDir);
  const archivedDir = archivedVoicePartsDir(pipelineDir);
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => !f.startsWith('.') && f.endsWith('.json'));
  } catch { return { swept: 0, resent: 0, notified: 0, closed: 0, quarantined: 0 }; }

  const nowMs = Number.isFinite(now) ? now : Date.now();
  let resent = 0; let notified = 0; let closed = 0; let quarantined = 0;

  for (const f of files) {
    const correlationId = f.replace(/\.json$/, '');
    const state = readState(dir, correlationId);
    if (!state) {
      // Estado corrupto/forjado → cuarentena (fail-closed), nunca reenvío ciego.
      try {
        ensureDir(archivedDir);
        fs.renameSync(path.join(dir, f), path.join(archivedDir, f.replace(/\.json$/, `-invalid-${nowMs}.json`)));
      } catch { /* best-effort */ }
      quarantined++;
      continue;
    }

    const plan = planSweep(state, {
      now: nowMs,
      maxRetries: config.max_retries,
      backoffBaseMs: config.backoff_base_ms,
      backoffMaxMs: config.backoff_max_ms,
      staleTtlMs: config.stale_ttl_ms,
    });

    for (const r of plan.resends) {
      try {
        enqueue({
          correlationId: state.correlationId,
          partIndex: r.partIndex,
          partTotal: state.partTotal,
          path: r.path,
          chatId: state.chatId,
        });
        resent++;
        if (logFn) logFn(`reenvío parte ${r.partIndex + 1}/${state.partTotal} (cid=${state.correlationId})`);
      } catch (e) {
        if (logFn) logFn(`reenvío falló (cid=${state.correlationId}, parte ${r.partIndex + 1}): ${e.message}`);
      }
    }

    if (plan.terminal) {
      if (plan.notify) {
        try {
          notify(formatMissingNotice(plan.notify.partNumbers, plan.notify.partTotal), plan.notify.chatId);
          notified++;
          if (logFn) logFn(`aviso de faltante enviado (cid=${state.correlationId}, partes ${plan.notify.partNumbers.join(',')})`);
        } catch (e) {
          if (logFn) logFn(`aviso de faltante falló (cid=${state.correlationId}): ${e.message}`);
        }
      }
      // Persistimos el flag `notified` (por si el archive fallara) y archivamos.
      try { writeState(dir, plan.state); } catch { /* best-effort */ }
      archiveState(dir, archivedDir, state.correlationId);
      closed++;
    } else {
      // Persistir retries/enqueuedAt actualizados para el próximo tick.
      try { writeState(dir, plan.state); } catch (e) { if (logFn) logFn(`persist estado falló (cid=${state.correlationId}): ${e.message}`); }
    }
  }

  return { swept: files.length, resent, notified, closed, quarantined };
}

module.exports = {
  voicePartsDir,
  archivedVoicePartsDir,
  isVoicePartReceipt,
  isValidState,
  statePath,
  readState,
  writeState,
  archiveState,
  buildInitialState,
  initState,
  applyConfirmation,
  recordPartConfirmation,
  planSweep,
  formatMissingNotice,
  sweepVoiceStates,
};

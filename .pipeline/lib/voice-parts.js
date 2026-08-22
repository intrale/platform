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
//      reintentos + backoff, política PROPIA de voz — `telegram_voice_outbound`,
//      #5573); si se agotan los reintentos avisa al usuario en el chat del padre
//      (nunca hueco silencioso).
//
// #5573 — El sweep además distingue "todavía en vuelo" de "perdido": una parte
// cuyo dropfile sigue vivo en la cola de svc-telegram NO se reenvía (ver
// `scanInFlightParts` + `planSweep(opts.inFlight)`), con un techo absoluto para
// que un job atascado no suprima la entrega para siempre.
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
  // #4903 — `dedupeKey` es OPCIONAL (backward-compat con estados previos que no lo
  // llevan). Si está presente debe ser string no vacío; cualquier otra cosa → inválido.
  if (obj.dedupeKey != null && (typeof obj.dedupeKey !== 'string' || obj.dedupeKey.length === 0)) return false;
  // #5573 — `firstEnqueuedAt` por parte es OPCIONAL (R10: retrocompat con los
  // estados YA en disco al desplegar; invalidarlos los mandaría a cuarentena y
  // perdería entregas en vuelo). Si está presente debe ser string no vacío; el
  // consumidor cae a `enqueuedAt` cuando falta.
  if (obj.parts && typeof obj.parts === 'object' && !Array.isArray(obj.parts)) {
    for (const p of Object.values(obj.parts)) {
      if (!p || typeof p !== 'object') continue;
      if (p.firstEnqueuedAt != null
        && (typeof p.firstEnqueuedAt !== 'string' || p.firstEnqueuedAt.length === 0)) return false;
    }
  }
  return true;
}

// -----------------------------------------------------------------------------
// #4903 — Deduplicación cross-retry de audios ya entregados.
//
// Problema (incidente real cmd-1784896035259-a7b1accb): cuando la confirmación de
// entrega de un turno falla pero los audios SÍ llegaron, el reintento re-despacha
// la respuesta completa con un `correlationId` NUEVO — el estado fresco no conoce
// las partes ya entregadas y las reenvía → el usuario recibe la misma serie de
// audios 2-3 veces.
//
// Fix: atar el audio a una IDENTIDAD ESTABLE de la respuesta que sobreviva al
// reintento (el `correlationId` cambia por dispatch; el texto verificado no). El
// audio es TTS del texto de respuesta → misma (chat, texto) ⇒ mismo audio lógico,
// mismo split de chunks ⇒ mismos `partIndex`. Antes de reenviar, se consultan los
// estados (activos + archivados) con el mismo `dedupeKey` y se omiten las partes
// ya confirmadas (entregadas). PURA.
// -----------------------------------------------------------------------------
function computeDedupeKey({ chatId, text }) {
  const norm = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (norm.length === 0) return null;
  const h = crypto.createHash('sha256').update(`${chatId == null ? '' : chatId}\n${norm}`).digest('hex');
  return `vk_${h.slice(0, 32)}`;
}

// isFullyDelivered — PURA: todas las partes registradas están confirmadas y hay al
// menos `partTotal` partes registradas (respuesta entregada completa).
function isFullyDelivered(state) {
  if (!isValidState(state)) return false;
  for (let i = 0; i < state.partTotal; i++) {
    const p = state.parts[String(i)];
    if (!p || !p.confirmed) return false;
  }
  return true;
}

// confirmedIndexes — PURA: Set de índices de parte confirmados en un estado.
function confirmedIndexes(state) {
  const out = new Set();
  if (!state || !state.parts || typeof state.parts !== 'object') return out;
  for (const [k, p] of Object.entries(state.parts)) {
    if (p && p.confirmed) {
      const n = Number(k);
      if (Number.isInteger(n) && n >= 0) out.add(n);
    }
  }
  return out;
}

// findDeliveredParts — I/O acotado: busca en estados ACTIVOS + ARCHIVADOS los que
// comparten `dedupeKey` dentro de la ventana `ttlMs` y consolida qué índices de
// parte ya fueron entregados (confirmados). Base de la deduplicación cross-retry:
// al reintentar un turno, los audios ya entregados no se reenvían (CA-1/CA-2). Un
// `dedupeKey` fuera de ventana o inexistente → `{ found:false, confirmed:∅ }`.
function findDeliveredParts({ pipelineDir, dedupeKey, now, ttlMs }) {
  const res = { found: false, partTotal: 0, confirmed: new Set() };
  if (!dedupeKey || typeof dedupeKey !== 'string') return res;
  const nowMs = Number.isFinite(now) ? now : Date.now();
  const ttl = Number.isFinite(ttlMs) ? ttlMs : 86400000;
  const dirs = [voicePartsDir(pipelineDir), archivedVoicePartsDir(pipelineDir)];
  for (const dir of dirs) {
    let files;
    try {
      files = fs.readdirSync(dir).filter((f) => !f.startsWith('.') && f.endsWith('.json'));
    } catch { continue; }
    for (const f of files) {
      let obj;
      try { obj = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
      if (!isValidState(obj) || obj.dedupeKey !== dedupeKey) continue;
      const createdMs = Date.parse(obj.createdAt);
      if (Number.isFinite(createdMs) && (nowMs - createdMs) > ttl) continue; // fuera de ventana
      res.found = true;
      if (obj.partTotal > res.partTotal) res.partTotal = obj.partTotal;
      for (const idx of confirmedIndexes(obj)) res.confirmed.add(idx);
    }
  }
  return res;
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
function buildInitialState({ correlationId, partTotal, chatId, parts, now, dedupeKey }) {
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
  // #4903 — identidad estable de la respuesta para dedup cross-retry (opcional).
  if (typeof dedupeKey === 'string' && dedupeKey.length > 0) state.dedupeKey = dedupeKey;
  for (const p of (parts || [])) {
    const idx = rec.coercePartInt(p.partIndex);
    if (idx == null || idx >= pt) continue; // acotado (SEC-R2)
    const enqueuedAt = typeof p.enqueuedAt === 'string' && p.enqueuedAt.length > 0 ? p.enqueuedAt : createdAt;
    state.parts[String(idx)] = {
      path: typeof p.path === 'string' ? p.path : null,
      enqueuedAt,
      // #5573 — ancla INMUTABLE del primer encolado. `enqueuedAt` se pisa en cada
      // reenvío (planSweep), así que no sirve ni para el techo absoluto de
      // supresión por "en vuelo" (SEC-A) ni para medir la latencia real de entrega
      // punta a punta. `firstEnqueuedAt` no se toca nunca después de nacer.
      firstEnqueuedAt: enqueuedAt,
      retries: 0,
      // #4903 — una parte puede nacer ya `confirmed` cuando se sabe que fue
      // entregada en una pasada anterior (dedup): no se reenvía, solo se contabiliza.
      confirmed: p.confirmed === true,
    };
  }
  return state;
}

function initState({ pipelineDir, correlationId, partTotal, chatId, parts, now, dedupeKey }) {
  const state = buildInitialState({ correlationId, partTotal, chatId, parts, now, dedupeKey });
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
//
// #5573 — Señal EN VUELO. El backoff solo mide "cuánto hace que encolé", no
// distingue "perdido" de "todavía en la cola de svc-telegram". Con la latencia
// real de un `.ogg` (~62-74s medidos) contra un backoff de texto de 5s, el sweep
// disparaba reenvíos sobre envíos aún en vuelo → el operador recibía el mismo
// audio 2-4 veces. `opts.inFlight` (Set de partIndex con dropfile vivo en la
// cola) suprime el reenvío de esas partes. `opts.inFlightMaxMs` es el TECHO
// ABSOLUTO de esa supresión, medido desde `firstEnqueuedAt`: sin él, un job
// atascado en `trabajando/` (nada lo barre con el servicio vivo — `recoverOrphans`
// corre SOLO al boot) suprimiría el reenvío para siempre, degradando la garantía
// de #4750 a un hueco silencioso permanente.
// -----------------------------------------------------------------------------
function planSweep(state, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const maxRetries = Number.isFinite(opts.maxRetries) ? opts.maxRetries : 5;
  const base = Number.isFinite(opts.backoffBaseMs) ? opts.backoffBaseMs : 5000;
  const maxBackoff = Number.isFinite(opts.backoffMaxMs) ? opts.backoffMaxMs : 300000;
  const staleTtl = Number.isFinite(opts.staleTtlMs) ? opts.staleTtlMs : 86400000;
  // #5573 — partes con dropfile vivo en `pendiente/` ∪ `trabajando/`. Ausente o
  // mal tipado → Set vacío = comportamiento previo (nunca supresión por accidente).
  const inFlight = opts.inFlight instanceof Set ? opts.inFlight : new Set();
  const inFlightMaxMs = Number.isFinite(opts.inFlightMaxMs) ? opts.inFlightMaxMs : 600000;

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

    // #5573 / SEC-A — techo absoluto de la supresión por "en vuelo", anclado en el
    // PRIMER encolado (no en `enqueuedAt`, que los reenvíos pisan). R10: si el
    // estado viene de antes del fix y no trae `firstEnqueuedAt`, cae a `enqueuedAt`.
    const firstMs = Date.parse(p.firstEnqueuedAt || p.enqueuedAt);
    const heldTooLong = Number.isFinite(firstMs) && (now - firstMs) >= inFlightMaxMs;

    if (inFlight.has(i) && !heldTooLong) {
      // Sigue en la cola: NO es una pérdida. No se reencola, NO se incrementa
      // `retries` ni se pisa `enqueuedAt` (hacerlo corrompe el backoff y la
      // métrica de latencia). Cuenta como pendiente → el estado no cierra terminal
      // ni dispara el aviso de faltante prematuramente.
      anyPending = true;
      continue;
    }

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
// #5573 — scanInFlightParts: qué partes de audio siguen VIVAS en la cola de
// `svc-telegram`. I/O (NO pura, a diferencia de `planSweep`, que recibe el Set ya
// armado y sigue siendo el activo testeable del módulo).
//
// "En vuelo" ≡ existe un dropfile de esa parte en `pendiente/` ∪ `trabajando/`.
// `fallido/` NO cuenta: es terminal hasta el barredor de boot ⇒ pérdida real, y
// el reenvío debe ocurrir (CA-3, no se debilita #4750).
//
// UNIÓN DE TRES LECTURAS, en orden `pendiente → trabajando → pendiente`. La regla
// es leer el ORIGEN antes que el DESTINO, y la cola se mueve en AMBOS sentidos
// (`pendiente→trabajando` al tomar el job; `trabajando→pendiente` al reintentar
// con `_nextRetryAt`). Con un solo par de lecturas, un archivo que se mueve entre
// medio no aparece en ninguna → falso "perdido" → justo el duplicado que este
// issue viene a matar. Con las tres, un move en cualquier dirección cae en al
// menos una lectura: es imposible que se escape por el race.
//
// Devuelve Map<correlationId, Set<partIndex>>.
// -----------------------------------------------------------------------------
function scanInFlightParts({ pipelineDir }) {
  const base = path.join(pipelineDir, 'servicios', 'telegram');
  const pendienteDir = path.join(base, 'pendiente');
  const trabajandoDir = path.join(base, 'trabajando');
  const map = new Map();

  for (const dir of [pendienteDir, trabajandoDir, pendienteDir]) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      // SEC-C / R2 — un error de I/O NO cuenta como "en vuelo". Fail-OPEN hacia la
      // entrega (a lo sumo un duplicado), fail-CLOSED hacia la confirmación. Tratar
      // un readdir roto como "en vuelo" convertiría una falla de disco en supresión
      // de entrega, que es exactamente el hueco silencioso que #4750 prohíbe.
      continue;
    }
    for (const name of names) {
      // Única lectura del nombre. Un dropfile que no matchea (texto, o formato
      // legacy pre-#5573 sin cid) se ignora → degrada al comportamiento actual
      // (a lo sumo un duplicado), NUNCA a supresión. R10: cubre la ventana de deploy.
      const m = /^\d+-voice-(.+)-p(\d+)\.json$/.exec(name);
      if (!m) continue;
      const cid = m[1];
      const idx = rec.coercePartInt(m[2]);
      // SEC-B / R3 — `pendiente/` es un bus con muchos escritores: un dropfile
      // forjado podría suprimir la parte de una respuesta en vuelo. Se valida
      // SIEMPRE. El nombre no es fuente de verdad ni se concatena a ningún
      // `path.join` de salida: sólo se usa para matchear contra el estado.
      if (!rec.isValidCorrelationId(cid) || idx == null) continue;
      if (!map.has(cid)) map.set(cid, new Set());
      map.get(cid).add(idx);
    }
  }
  return map;
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

  // #5573 / SEC-G — escaneo de la cola UNA SOLA VEZ por barrido (nunca por estado)
  // y sólo si hay estados de voz vivos: sin esto, cada tick pagaría 3 readdir por
  // estado. `files.length === 0` ya devolvió arriba si el dir no existe.
  const inFlightByCid = files.length > 0
    ? (() => { try { return scanInFlightParts({ pipelineDir }); } catch { return new Map(); } })()
    : new Map();

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
      // #5573 — partes de ESTE correlationId todavía vivas en la cola.
      inFlight: inFlightByCid.get(state.correlationId) || new Set(),
      inFlightMaxMs: config.in_flight_max_ms,
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
  // #5573 — señal "en vuelo" (anti reenvío sobre envío no perdido)
  scanInFlightParts,
  // #4903 — dedup cross-retry
  computeDedupeKey,
  isFullyDelivered,
  confirmedIndexes,
  findDeliveredParts,
};

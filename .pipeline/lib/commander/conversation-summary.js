// =============================================================================
// conversation-summary.js — Resumen incremental de la conversación del Commander
// (#3935 / EP4-H2).
//
// Compacta los turnos VIEJOS de la conversación a un bloque "resumen" para
// acotar el tamaño del prompt sin perder coherencia, manteniendo los últimos K
// turnos VERBATIM. Construye sobre el sustrato de #3934 (conversación
// estructurada user/assistant persistida por chat sobre `commander-history.jsonl`,
// keyed por `chat_id` — helper `selectCommanderHistoryForChat`).
//
// Patrón: rolling con recompactación POR UMBRAL (no por turno → controla
// costo/latencia). El módulo es PURO y DETERMINÍSTICO (sin estado global): recibe
// la conversación ya seleccionada por chat y devuelve el contexto a inyectar.
//
//   buildContext(conversation, opts) -> { verbatimTail, summaryBlock, provenance, meta }
//       SÍNCRONO. Nunca llama al LLM. Lee el resumen persistido (validándolo /
//       sanitizándolo en lectura, no se confía en el archivo) y arma el contexto.
//       Si no hay resumen fresco para el segmento viejo actual → degradación
//       elegante: devuelve TODO verbatim (== comportamiento previo de "últimas N
//       líneas crudas"), sin summaryBlock.
//
//   recompactIfNeeded(conversation, opts) -> Promise<{ recompacted, provenance, reason }>
//       ASÍNCRONO. Sólo recompacta si se cruzó el umbral Y el segmento viejo
//       cambió respecto del resumen persistido (hash distinto). Doble
//       sanitización (input antes de enviar al provider + output antes de
//       persistir/reinyectar), detección anti prompt-injection sobre material y
//       resumen, restricción de providers de confianza (Claude/Codex), y
//       persistencia atómica del provenance. FAIL-OPEN: nunca lanza; ante
//       cualquier error devuelve `{ recompacted:false, reason:'...' }` y el
//       `buildContext` cae al fallback verbatim.
//
// Requisitos de seguridad incorporados (security — fase definición EP4-H2):
//   SEC-1 (doble sanitización): `sanitize()` sobre input ANTES del provider y
//         sobre el output ANTES de persistir/reinyectar.
//   SEC-2 (providers elegibles): summarization SOLO sobre provider de confianza
//         (Claude/Codex). Output de provider no confiable NO se persiste.
//   SEC-3 (stored prompt-injection): `detectInjection()` sobre material a
//         resumir y sobre el resumen resultante; reinyección envuelta en
//         `<resumen_no_autoritativo>…</resumen_no_autoritativo>` (lo hace el
//         caller vía `renderInjection`).
//   SEC-4 (tamper-evidence): provenance con `input_sha256` (SHA-256 del input
//         crudo del segmento resumido) + modelo + provider + rango de turnos.
//   SEC-5 (superficie de archivo): el resumen persistido se valida/sanitiza al
//         LEER (no se confía en que lo escribió el propio pipeline).
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { sanitize } = require('../../sanitizer');
const handoff = require('../handoff');

// -----------------------------------------------------------------------------
// Configuración
// -----------------------------------------------------------------------------

const DEFAULTS = Object.freeze({
  // Cantidad de turnos recientes que se mantienen SIEMPRE verbatim (UX-1:
  // continuidad percibida — lo reciente nunca se degrada).
  verbatimK: 12,
  // Umbral total de turnos por encima del cual se compacta el segmento viejo.
  // Por debajo del umbral todo va verbatim y NO se invoca al LLM (control de
  // costo/latencia, CA-2).
  recompactThreshold: 30,
  // Delimitadores no-autoritativos (SEC-3). El resumen se trata como dato no
  // confiable, nunca como instrucción.
  openTag: '<resumen_no_autoritativo>',
  closeTag: '</resumen_no_autoritativo>',
  verbatimHeader: 'Historial reciente (24hs):',
  // Providers de confianza para summarization (SEC-2 / CA-3). Sólo Claude/Codex.
  trustedProviders: ['anthropic', 'claude', 'codex', 'openai-codex'],
  // Validez del resumen persistido (días). Coherente con la retención del
  // historial conversacional de #3934.
  retentionDays: 30,
});

// Nombre del store por defecto (un subdocumento por chat dentro de un JSON map).
const DEFAULT_STORE_FILENAME = 'commander-summary.json';

// -----------------------------------------------------------------------------
// Estimación de tamaño de prompt (CA-2) — heurística chars/4, determinística.
// -----------------------------------------------------------------------------

/**
 * Estima tokens de un texto. Heurística reproducible (≈ chars/4) — suficiente
 * para "medir antes/después" la reducción de tamaño del prompt (CA-2). No
 * pretende exactitud por-tokenizer: lo que importa es la comparación relativa.
 * @param {string} text
 * @returns {number}
 */
function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

// -----------------------------------------------------------------------------
// Normalización de la conversación
// -----------------------------------------------------------------------------

/**
 * Normaliza la conversación de entrada a una lista de turnos `{ raw, text,
 * direction, timestamp, chat_id }`. Acepta:
 *   - array de strings (líneas JSONL crudas de `selectCommanderHistoryForChat`).
 *   - array de objetos ya parseados.
 * Las líneas inválidas se conservan como turno crudo (no se pierden), porque el
 * fallback verbatim debe reproducir EXACTAMENTE lo que se inyectaba antes.
 * @param {Array<string|object>} conversation
 * @returns {Array<{raw:string, text:string, direction:?string, timestamp:?string, chat_id:?(string|number)}>}
 */
function normalizeConversation(conversation) {
  if (!Array.isArray(conversation)) return [];
  const turns = [];
  for (const item of conversation) {
    if (item == null) continue;
    if (typeof item === 'string') {
      let parsed = null;
      try { parsed = JSON.parse(item); } catch { /* línea no-JSON: turno crudo */ }
      if (parsed && typeof parsed === 'object') {
        turns.push({
          raw: item,
          text: typeof parsed.text === 'string' ? parsed.text : item,
          direction: parsed.direction != null ? String(parsed.direction) : null,
          timestamp: parsed.timestamp != null ? String(parsed.timestamp) : null,
          chat_id: parsed.chat_id != null ? parsed.chat_id : null,
        });
      } else {
        turns.push({ raw: item, text: item, direction: null, timestamp: null, chat_id: null });
      }
    } else if (typeof item === 'object') {
      const raw = typeof item.raw === 'string'
        ? item.raw
        : (() => { try { return JSON.stringify(item); } catch { return String(item.text || ''); } })();
      turns.push({
        raw,
        text: typeof item.text === 'string' ? item.text : raw,
        direction: item.direction != null ? String(item.direction) : null,
        timestamp: item.timestamp != null ? String(item.timestamp) : null,
        chat_id: item.chat_id != null ? item.chat_id : null,
      });
    }
  }
  return turns;
}

/**
 * Parte la conversación normalizada en `{ older, tail }`:
 *   - Si total <= recompactThreshold → todo va a `tail` (verbatim), `older` vacío
 *     (no se invoca al LLM).
 *   - Si total > recompactThreshold → `tail` = últimos `verbatimK`, `older` = el
 *     resto (a resumir).
 * @param {Array} turns  conversación normalizada
 * @param {object} cfg   { verbatimK, recompactThreshold }
 * @returns {{ older: Array, tail: Array }}
 */
function splitConversation(turns, cfg) {
  const verbatimK = cfg.verbatimK;
  const threshold = cfg.recompactThreshold;
  if (turns.length <= threshold) {
    return { older: [], tail: turns.slice() };
  }
  const cut = Math.max(0, turns.length - verbatimK);
  return { older: turns.slice(0, cut), tail: turns.slice(cut) };
}

// -----------------------------------------------------------------------------
// Hash determinístico del input (SEC-4 / CA-3)
// -----------------------------------------------------------------------------

/**
 * SHA-256 del input crudo del segmento a resumir. Serialización canónica: cada
 * turno por su `raw` (la línea JSONL original tal cual), unidos por `\n`. Mismo
 * material ⇒ mismo hash (tamper-evident, reproducible).
 * @param {Array<{raw:string}>} olderTurns
 * @returns {string} hex sha256
 */
function hashInput(olderTurns) {
  const canonical = (olderTurns || []).map(t => (t && typeof t.raw === 'string' ? t.raw : '')).join('\n');
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Rango de turnos cubierto por el segmento viejo: timestamps de la primera y
 * última entrada + count. Usamos timestamps (no índices) porque los índices se
 * corren a medida que el historial crece.
 * @param {Array} olderTurns
 * @returns {{from:?string, to:?string, count:number}}
 */
function turnRange(olderTurns) {
  const arr = olderTurns || [];
  return {
    from: arr.length ? (arr[0].timestamp || null) : null,
    to: arr.length ? (arr[arr.length - 1].timestamp || null) : null,
    count: arr.length,
  };
}

// -----------------------------------------------------------------------------
// Persistencia del store (map keyed por chat_id) — atómica + fail-open
// -----------------------------------------------------------------------------

function resolveStoreFile(opts) {
  if (opts && typeof opts.storeFile === 'string' && opts.storeFile) return opts.storeFile;
  const dir = (opts && opts.pipelineDir) ? opts.pipelineDir : process.cwd();
  return path.join(dir, DEFAULT_STORE_FILENAME);
}

function chatKey(chatId) {
  return chatId == null ? '__default__' : String(chatId);
}

/**
 * Lee el store completo. FAIL-OPEN: si no existe o está corrupto, devuelve `{}`.
 * @param {string} storeFile
 * @returns {object} map chatKey -> provenance
 */
function loadSummaryStore(storeFile) {
  try {
    if (!fs.existsSync(storeFile)) return {};
    const raw = fs.readFileSync(storeFile, 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Escribe el store de forma ATÓMICA (temp + rename). FAIL-OPEN: ante error deja
 * el archivo intacto y devuelve false (el pipeline no puede morir por esto).
 * @param {string} storeFile
 * @param {object} store
 * @returns {boolean} ok
 */
function saveSummaryStore(storeFile, store) {
  try {
    const dir = path.dirname(storeFile);
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
    const tmp = storeFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, storeFile);
    return true;
  } catch {
    return false;
  }
}

/**
 * Valida un record de provenance persistido. Defensivo (SEC-5): no se confía en
 * la forma del archivo. Devuelve el record sólo si tiene los campos mínimos.
 * @param {*} record
 * @returns {?object}
 */
function validateRecord(record) {
  if (!record || typeof record !== 'object') return null;
  if (typeof record.summary !== 'string' || record.summary.length === 0) return null;
  if (typeof record.input_sha256 !== 'string' || record.input_sha256.length === 0) return null;
  return record;
}

/**
 * Re-sanitiza en LECTURA el texto del resumen persistido (SEC-1 + SEC-3 + SEC-5).
 * Doble pasada: `sanitize()` (secrets) + `detectInjection()` (anti prompt-
 * injection horneado). No confiamos en que el archivo lo escribió el pipeline.
 * @param {string} summary
 * @returns {string}
 */
function sanitizeStoredSummary(summary) {
  let out = sanitize(summary);
  try { out = handoff.detectInjection(out).text; } catch { /* best-effort */ }
  return out;
}

// -----------------------------------------------------------------------------
// Render de turnos (fallback verbatim == comportamiento previo)
// -----------------------------------------------------------------------------

function renderTurns(turns) {
  return (turns || []).map(t => (t && typeof t.raw === 'string' ? t.raw : '')).join('\n');
}

// -----------------------------------------------------------------------------
// buildContext — SÍNCRONO, nunca llama al LLM
// -----------------------------------------------------------------------------

/**
 * Construye el contexto conversacional a inyectar.
 *
 * @param {Array<string|object>} conversation  turnos del chat activo (#3934).
 * @param {object} [opts]
 * @param {string|number} [opts.chatId]
 * @param {string} [opts.storeFile]      path al store (default `<pipelineDir>/commander-summary.json`)
 * @param {string} [opts.pipelineDir]
 * @param {object} [opts.config]         overrides de DEFAULTS
 * @param {number} [opts.now]            epoch ms (inyectable para tests)
 * @returns {{ verbatimTail:string, summaryBlock:string, provenance:?object,
 *            meta:{ mode:string, verbatimCount:number, summarizedCount:number,
 *                   rawTokens:number, compactedTokens:number, reductionRatio:number } }}
 */
function buildContext(conversation, opts = {}) {
  const cfg = Object.assign({}, DEFAULTS, opts.config || {});
  const turns = normalizeConversation(conversation);
  const { older, tail } = splitConversation(turns, cfg);

  const fullRaw = renderTurns(turns);
  const rawTokens = estimateTokens(fullRaw);

  // Sin segmento viejo (por debajo del umbral): todo verbatim, sin resumen.
  if (older.length === 0) {
    const verbatimTail = renderTurns(tail);
    return {
      verbatimTail,
      summaryBlock: '',
      provenance: null,
      meta: {
        mode: 'verbatim',
        verbatimCount: tail.length,
        summarizedCount: 0,
        rawTokens,
        compactedTokens: estimateTokens(verbatimTail),
        reductionRatio: 0,
      },
    };
  }

  // Hay segmento viejo: buscamos un resumen FRESCO (hash coincidente) para él.
  const storeFile = resolveStoreFile(opts);
  const store = loadSummaryStore(storeFile);
  const record = validateRecord(store[chatKey(opts.chatId)]);
  const expectedSha = hashInput(older);

  let fresh = false;
  if (record && record.input_sha256 === expectedSha) {
    // Validez temporal (retención): un resumen muy viejo se ignora.
    fresh = isRecordWithinRetention(record, cfg, opts.now);
  }

  if (fresh) {
    const summaryBlock = sanitizeStoredSummary(record.summary);
    const verbatimTail = renderTurns(tail);
    const compactedTokens = estimateTokens(summaryBlock) + estimateTokens(verbatimTail);
    return {
      verbatimTail,
      summaryBlock,
      provenance: {
        turn_range: record.turn_range || turnRange(older),
        model: record.model || null,
        provider: record.provider || null,
        input_sha256: record.input_sha256,
        generated_at: record.generated_at || null,
      },
      meta: {
        mode: 'summarized',
        verbatimCount: tail.length,
        summarizedCount: older.length,
        rawTokens,
        compactedTokens,
        reductionRatio: rawTokens > 0 ? +(1 - compactedTokens / rawTokens).toFixed(4) : 0,
      },
    };
  }

  // No hay resumen fresco para el segmento viejo actual → DEGRADACIÓN ELEGANTE
  // (CA-5 / UX-4): inyectamos TODO verbatim, igual que el comportamiento previo
  // de "últimas N líneas crudas". El usuario no percibe la falla; la
  // recompactación corre aparte (recompactIfNeeded) para el próximo turno.
  const verbatimTail = renderTurns(turns);
  return {
    verbatimTail,
    summaryBlock: '',
    provenance: null,
    meta: {
      mode: 'verbatim_fallback',
      verbatimCount: turns.length,
      summarizedCount: 0,
      rawTokens,
      compactedTokens: estimateTokens(verbatimTail),
      reductionRatio: 0,
    },
  };
}

function isRecordWithinRetention(record, cfg, now) {
  try {
    if (!record.generated_at) return true; // sin fecha: no lo descartamos
    const ts = new Date(record.generated_at).getTime();
    if (!Number.isFinite(ts)) return true;
    const nowMs = Number.isFinite(now) ? now : Date.now();
    return (nowMs - ts) <= cfg.retentionDays * 24 * 60 * 60 * 1000;
  } catch {
    return true;
  }
}

// -----------------------------------------------------------------------------
// renderInjection — arma el string final a inyectar (con delimitadores SEC-3)
// -----------------------------------------------------------------------------

/**
 * Convierte el resultado de `buildContext` en el string listo para inyectar al
 * prompt. Si hay resumen, lo envuelve en los delimitadores no-autoritativos
 * (SEC-3) y antepone al historial reciente verbatim. Si no hay resumen, devuelve
 * sólo el historial reciente (== comportamiento previo). Cadena vacía si no hay
 * nada que inyectar.
 * @param {object} ctx  resultado de buildContext
 * @param {object} [opts] { config }
 * @returns {string}
 */
function renderInjection(ctx, opts = {}) {
  if (!ctx || typeof ctx !== 'object') return '';
  const cfg = Object.assign({}, DEFAULTS, opts.config || {});
  const parts = [];
  if (ctx.summaryBlock && ctx.summaryBlock.trim().length > 0) {
    parts.push(`${cfg.openTag}\n${ctx.summaryBlock}\n${cfg.closeTag}`);
  }
  if (ctx.verbatimTail && ctx.verbatimTail.trim().length > 0) {
    parts.push(`${cfg.verbatimHeader}\n${ctx.verbatimTail}`);
  }
  if (parts.length === 0) return '';
  return '\n' + parts.join('\n');
}

// -----------------------------------------------------------------------------
// recompactIfNeeded — ASÍNCRONO, fail-open
// -----------------------------------------------------------------------------

/**
 * Recompacta el segmento viejo de la conversación a un resumen, SÓLO si:
 *   - se cruzó el umbral (hay segmento viejo), y
 *   - el segmento viejo cambió respecto del resumen persistido (hash distinto).
 *
 * Doble sanitización (SEC-1), anti-injection (SEC-3), provider de confianza
 * (SEC-2), persistencia atómica con provenance (SEC-4).
 *
 * FAIL-OPEN: nunca lanza. Devuelve `{ recompacted:false, reason }` ante cualquier
 * problema; `buildContext` cae al fallback verbatim sin error visible (CA-5).
 *
 * @param {Array<string|object>} conversation
 * @param {object} opts
 * @param {string|number} [opts.chatId]
 * @param {string} [opts.storeFile]
 * @param {string} [opts.pipelineDir]
 * @param {object} [opts.config]
 * @param {number} [opts.now]
 * @param {function} opts.summarizer  async ({ input, sha, chatId }) =>
 *        { text, model, provider } | string. OBLIGATORIO para recompactar; si
 *        falta → `{ recompacted:false, reason:'no_summarizer' }`.
 * @returns {Promise<{recompacted:boolean, provenance:?object, reason:string}>}
 */
async function recompactIfNeeded(conversation, opts = {}) {
  try {
    const cfg = Object.assign({}, DEFAULTS, opts.config || {});
    const turns = normalizeConversation(conversation);
    const { older } = splitConversation(turns, cfg);

    if (older.length === 0) {
      return { recompacted: false, provenance: null, reason: 'below_threshold' };
    }

    const sha = hashInput(older);
    const storeFile = resolveStoreFile(opts);
    const store = loadSummaryStore(storeFile);
    const existing = validateRecord(store[chatKey(opts.chatId)]);
    if (existing && existing.input_sha256 === sha && isRecordWithinRetention(existing, cfg, opts.now)) {
      return { recompacted: false, provenance: existing, reason: 'fresh' };
    }

    if (typeof opts.summarizer !== 'function') {
      return { recompacted: false, provenance: null, reason: 'no_summarizer' };
    }

    // --- SEC-1 (input) + SEC-3: sanitizar y desinfectar el material ANTES de
    // mandarlo al provider. El input efectivo es el saneado, nunca el crudo.
    const rawInput = renderTurns(older);
    let safeInput = sanitize(rawInput);
    try { safeInput = handoff.detectInjection(safeInput).text; } catch { /* best-effort */ }

    // --- Invocación del summarizer (provider de confianza, temp=0, modelo
    // fijado — responsabilidad del caller). Time-box / errores → fail-open.
    let result;
    try {
      result = await opts.summarizer({ input: safeInput, sha, chatId: opts.chatId });
    } catch (e) {
      return { recompacted: false, provenance: null, reason: 'summarizer_failed:' + safeReason(e) };
    }

    const summaryText = typeof result === 'string' ? result : (result && result.text);
    const model = (result && typeof result === 'object' && result.model) ? String(result.model) : null;
    const provider = (result && typeof result === 'object' && result.provider) ? String(result.provider) : null;

    if (typeof summaryText !== 'string' || summaryText.trim().length === 0) {
      return { recompacted: false, provenance: null, reason: 'empty_summary' };
    }

    // --- SEC-2: provider de confianza. Si el resumen vino de un provider no
    // confiable (free-tier), NO lo persistimos ni lo reinyectamos.
    if (!isTrustedProvider(provider, cfg)) {
      return { recompacted: false, provenance: null, reason: 'untrusted_provider:' + (provider || 'unknown') };
    }

    // --- SEC-1 (output) + SEC-3: re-sanitizar y desinfectar el resumen ANTES de
    // persistir y antes de reinyectar.
    let safeSummary = sanitize(summaryText);
    try { safeSummary = handoff.detectInjection(safeSummary).text; } catch { /* best-effort */ }
    if (safeSummary.trim().length === 0) {
      return { recompacted: false, provenance: null, reason: 'empty_after_sanitize' };
    }

    const generatedAt = isoFromNow(opts.now);
    const record = {
      summary: safeSummary,
      turn_range: turnRange(older),
      model,
      provider,
      input_sha256: sha,
      generated_at: generatedAt,
    };

    const nextStore = Object.assign({}, store);
    nextStore[chatKey(opts.chatId)] = record;
    const ok = saveSummaryStore(storeFile, nextStore);
    if (!ok) {
      return { recompacted: false, provenance: record, reason: 'persist_failed' };
    }

    return { recompacted: true, provenance: record, reason: 'ok' };
  } catch (e) {
    // FAIL-OPEN absoluto.
    return { recompacted: false, provenance: null, reason: 'error:' + safeReason(e) };
  }
}

function isTrustedProvider(provider, cfg) {
  if (!provider) return false;
  const p = String(provider).toLowerCase();
  return (cfg.trustedProviders || []).some(t => String(t).toLowerCase() === p);
}

function safeReason(e) {
  const msg = (e && e.message) ? String(e.message) : String(e || 'unknown');
  return msg.slice(0, 80).replace(/[^A-Za-z0-9 _:.\-]/g, '_');
}

function isoFromNow(now) {
  try {
    const ms = Number.isFinite(now) ? now : Date.now();
    return new Date(ms).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

// -----------------------------------------------------------------------------
// measure — helper de CA-2 (tamaño antes/después)
// -----------------------------------------------------------------------------

/**
 * Mide el tamaño del prompt (en tokens estimados) antes y después de compactar,
 * para CA-2 (tamaño acotado y medido). "Antes" = todo verbatim; "después" = el
 * contexto efectivo de `buildContext`.
 * @param {Array<string|object>} conversation
 * @param {object} [opts] mismas opciones que buildContext
 * @returns {{ rawTokens:number, compactedTokens:number, reductionRatio:number, mode:string }}
 */
function measure(conversation, opts = {}) {
  const ctx = buildContext(conversation, opts);
  return {
    rawTokens: ctx.meta.rawTokens,
    compactedTokens: ctx.meta.compactedTokens,
    reductionRatio: ctx.meta.reductionRatio,
    mode: ctx.meta.mode,
  };
}

module.exports = {
  DEFAULTS,
  DEFAULT_STORE_FILENAME,
  buildContext,
  recompactIfNeeded,
  renderInjection,
  measure,
  estimateTokens,
  // Exportados para test / reuso interno:
  normalizeConversation,
  splitConversation,
  hashInput,
  turnRange,
  loadSummaryStore,
  saveSummaryStore,
  resolveStoreFile,
  chatKey,
  isTrustedProvider,
};

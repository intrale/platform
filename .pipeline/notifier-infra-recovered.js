#!/usr/bin/env node
// =============================================================================
// notifier-infra-recovered.js — Notificador Telegram + audio para
// `connectivity_restored` (Historia #2336, hija 2 de #2329).
//
// Responsabilidades (CA2-CA6 de la madre):
//   CA2: Mensaje unico consolidado con variantes rotables, prefijo emoji,
//        tono calmo, formato corto si >5 issues.
//   CA3: Escape MarkdownV2 robusto (encapsulado aca, no migra callers legacy).
//   CA4: Dedup por sha256(sorted(issues).join(',') + bucket_5min) con TTL 5 min.
//        Si llega evento con set parcialmente nuevo, se menciona "solo los nuevos".
//   CA5: Rate limit TTS per-issue (1 cada 10 min) + global (10/h) con
//        persistencia atomica (tmp + rename) + fail-closed + alerta unica/hora.
//   CA6: Audio narrado espanol argentino, calmo, completo, acotado a 500 chars.
//
// Disenno:
//   - Modulo sin side-effects en `require` (safe para unit tests).
//   - Los colaboradores externos (fs/clock/sender/tts) se inyectan por opciones;
//     los defaults apuntan a helpers reales de `.pipeline/`.
//   - Robusto: archivos corruptos -> estado vacio en memoria, clamp defensivo
//     ante NaN/negativos, purga de entradas vencidas antes de escribir.
//
// Uso en runtime (ej. desde pulpo.js al recibir transition fail-to-ok):
//     const notifier = require('./notifier-infra-recovered');
//     await notifier.notify(event);
//
// Estructura del evento (producido por connectivity-state.js del #2335):
//   { type: 'connectivity_restored',
//     ts: '<iso8601>',
//     requeued: { count: N, issues: [numbers] }, ... }
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PIPELINE_DIR = path.resolve(__dirname);
const DEFAULT_DEDUP_FILE = path.join(PIPELINE_DIR, 'dedup-connectivity.json');
const DEFAULT_RATE_LIMIT_FILE = path.join(PIPELINE_DIR, 'rate-limit-tts.json');
const DEFAULT_TELEGRAM_DROP_DIR = path.join(PIPELINE_DIR, 'servicios', 'telegram', 'pendiente');

// Ventanas (ms)
const DEDUP_BUCKET_MS = 5 * 60 * 1000;     // bucket de 5 min (CA4)
const DEDUP_TTL_MS = 10 * 60 * 1000;       // retener hashes 10 min (doble bucket)
const TTS_WINDOW_PER_ISSUE_MS = 10 * 60 * 1000;  // 10 min (CA5)
const TTS_WINDOW_GLOBAL_MS = 60 * 60 * 1000;     // 1 h   (CA5)
const TTS_LIMIT_PER_ISSUE = 1;
const TTS_LIMIT_GLOBAL = 10;
const MAX_TTS_INPUT_CHARS = 500; // defensa denial-of-wallet (CA5 + UX10)
const GLOBAL_ALERT_WINDOW_MS = 60 * 60 * 1000;   // 1 alerta global por hora

// --- Helpers de MarkdownV2 (CA3) ---

// Caracteres que Telegram obliga a escapar en MarkdownV2:
// https://core.telegram.org/bots/api#markdownv2-style
const MARKDOWN_V2_SPECIAL = /[_*\[\]()~`>#+\-=|{}.!\\]/g;

/**
 * Escapa caracteres especiales de MarkdownV2. Entrada siempre coerced a string.
 * Resistente a `null`/`undefined`/objetos (devuelve cadena vacia).
 */
function escapeMarkdownV2(input) {
  if (input == null) return '';
  const s = typeof input === 'string' ? input : String(input);
  return s.replace(MARKDOWN_V2_SPECIAL, (ch) => '\\' + ch);
}

// --- Helpers de formateo de mensajes (CA2) ---

// Prefijo emoji semantico de red (no celebratorio, consistente con otros
// notifiers de infra). Va separado por espacio y sin bold en la palabra
// siguiente (guideline UX4/UX5).
const INFRA_EMOJI = '\u{1F4E1}'; // 📡

// 5 variantes estructuralmente diversas (guideline UX2 — supera las 3 minimas).
// Cada variante recibe {issuesList, count}. El prefijo emoji lo agrega el caller.
const MESSAGE_VARIANTS = [
  // A: Hecho + accion
  (ctx) => `Volvio la red, retomando los issues ${ctx.issuesList}`,
  // B: Accion + hecho
  (ctx) => `Reencolando ${ctx.issuesList} \u2014 red restaurada`,
  // C: Contexto + accion
  (ctx) => `Red de vuelta. Retomo ${ctx.issuesList}`,
  // D: Telegrafico
  (ctx) => `Conectividad OK. Retomando ${ctx.issuesList}`,
  // E: Descriptivo corto
  (ctx) => `Ya hay red. Vuelvo a procesar ${ctx.issuesList}`,
];

// Variantes cuando solo hay issues nuevos respecto al mensaje previo (CA4).
const NEW_ONLY_VARIANTS = [
  (ctx) => `Tambien retomando ${ctx.issuesList}`,
  (ctx) => `Sumo tambien ${ctx.issuesList}`,
  (ctx) => `Agrego ${ctx.issuesList} al reencolado`,
];

// Variantes del microcopy de rate-limit per-issue (CA5 + UX3).
const RATE_LIMIT_PER_ISSUE_NOTES = [
  '(sin audio esta vez, llegue al limite de generacion)',
  '(sin audio esta vez, llegue al limite)',
  '(esta vez sin voz, alcance el tope)',
  '(solo texto, rate limit alcanzado)',
];

/**
 * Arma la representacion textual de la lista de issues segun CA2:
 *  - <=5 issues: enumera todos con `#N`
 *  - >5 issues: formato corto `7 issues: #A, #B, #C y K mas`
 */
function formatIssueList(issues) {
  const ids = (issues || []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  const sorted = [...ids].sort((a, b) => a - b);
  if (sorted.length === 0) return '(sin issues)';
  if (sorted.length === 1) return `#${sorted[0]}`;
  if (sorted.length === 2) return `#${sorted[0]} y #${sorted[1]}`;
  if (sorted.length <= 5) {
    const head = sorted.slice(0, -1).map((n) => `#${n}`).join(', ');
    return `${head} y #${sorted[sorted.length - 1]}`;
  }
  const first = sorted.slice(0, 3).map((n) => `#${n}`).join(', ');
  const rest = sorted.length - 3;
  return `${sorted.length} issues: ${first} y ${rest} mas`;
}

/**
 * Elige variante determinista por hash del bucket + set de issues. No cae dos
 * veces seguidas en la misma variante consecutiva cuando llegan eventos
 * distintos (la rotacion se percibe organica).
 */
function pickVariant(variants, seed) {
  if (!Array.isArray(variants) || variants.length === 0) return null;
  const idx = Math.abs(hashInt(seed)) % variants.length;
  return variants[idx];
}

function hashInt(s) {
  let h = 0;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) | 0;
  }
  return h;
}

/**
 * Formatea el mensaje MarkdownV2 listo para enviar.
 *   @param {object} opts
 *   @param {number[]} opts.issues issues a listar
 *   @param {boolean} [opts.newOnly=false] si es el "segundo evento con set distinto"
 *   @param {string}  [opts.rateLimitNote] nota de rate limit per-issue (si aplica)
 *   @param {number}  [opts.seed] semilla para la rotacion
 */
function formatMessage({ issues, newOnly = false, rateLimitNote, seed }) {
  const issuesList = formatIssueList(issues);
  const variants = newOnly ? NEW_ONLY_VARIANTS : MESSAGE_VARIANTS;
  const variant = pickVariant(variants, seed != null ? seed : issuesList);
  const body = variant({ issuesList, count: issues.length });

  // Escape MarkdownV2 sobre el body completo. Las secuencias `#NNNN` se
  // escapan literalmente (Telegram no autolinkea issues en modo MarkdownV2,
  // queda como texto escaneable — esto es aceptado por UX5 / CA3).
  const escapedBody = escapeMarkdownV2(body);

  let text = `${INFRA_EMOJI} ${escapedBody}`;
  if (rateLimitNote) {
    // Linea aparte, minuscula, entre parentesis (CA5 + UX3)
    text += '\n' + escapeMarkdownV2(rateLimitNote);
  }
  return text;
}

/**
 * Formatea el guion del audio narrado (CA6). Usa tono calmo, sin numerales
 * literales, sin timestamps.
 */
function formatAudioScript({ issues, newOnly = false }) {
  const sorted = [...(issues || [])].map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (sorted.length === 0) return 'Volvio la conectividad.';
  const issuesWord = sorted.length === 1 ? 'issue' : 'issues';

  let body;
  if (sorted.length <= 3) {
    // Enumerar (lectura natural al oido)
    const list = sorted.map((n) => `issue ${n}`).join(', ');
    body = newOnly
      ? `Tambien retomo ${list}.`
      : `Reencole estos ${issuesWord}: ${list}.`;
  } else {
    // Solo cantidad (UX6.3)
    body = newOnly
      ? `Sumo tambien ${sorted.length} issues mas.`
      : `Reencole ${sorted.length} ${issuesWord}.`;
  }

  let script;
  if (newOnly) {
    script = body;
  } else {
    script = `Volvio la conectividad. ${body}`;
  }
  // Clamp defensivo: nunca exceder MAX_TTS_INPUT_CHARS.
  return script.length > MAX_TTS_INPUT_CHARS
    ? script.substring(0, MAX_TTS_INPUT_CHARS)
    : script;
}

// --- Helpers de dedup sha256 (CA4) ---

/**
 * Hash canonico: sha256(sorted_ids + '|' + bucket_5min).
 * `bucket_5min = Math.floor(nowMs / 300_000)` — NO incluye timestamps
 * granulares (CA4).
 */
function computeDedupHash(issues, nowMs) {
  const sortedIds = [...(issues || [])]
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b)
    .join(',');
  const bucket = Math.floor(Number(nowMs) / DEDUP_BUCKET_MS);
  return crypto.createHash('sha256').update(`${sortedIds}|${bucket}`).digest('hex');
}

// --- Escritura atomica (CA5) ---

/**
 * Escribe JSON al filesystem de forma atomica: write tmp + fsync + rename.
 * Reintenta EBUSY/EPERM una sola vez (Windows puede tener el handle ocupado
 * si otro proceso esta leyendo — pattern recomendado por Guru).
 */
function writeJsonAtomic(filepath, data, injected) {
  const fsMod = (injected && injected.fs) || fs;
  const tmp = `${filepath}.tmp.${process.pid}.${Date.now()}`;
  const payload = JSON.stringify(data, null, 2);

  fsMod.writeFileSync(tmp, payload, { mode: 0o600 });
  try {
    fsMod.renameSync(tmp, filepath);
  } catch (e) {
    if (e.code === 'EBUSY' || e.code === 'EPERM') {
      // Breve pausa busy-wait (evitamos require('child_process') en tests).
      const until = Date.now() + 50;
      while (Date.now() < until) { /* spin */ }
      fsMod.renameSync(tmp, filepath);
    } else {
      try { fsMod.unlinkSync(tmp); } catch { /* best-effort */ }
      throw e;
    }
  }
}

/**
 * Lee JSON "fail-closed": si no existe o esta corrupto, devuelve el default.
 */
function readJsonSafe(filepath, defaultValue, injected) {
  const fsMod = (injected && injected.fs) || fs;
  try {
    if (!fsMod.existsSync(filepath)) return clone(defaultValue);
    const raw = fsMod.readFileSync(filepath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed == null || typeof parsed !== 'object') return clone(defaultValue);
    return parsed;
  } catch {
    return clone(defaultValue);
  }
}

function clone(v) { return JSON.parse(JSON.stringify(v)); }

// --- Estado: dedup ---

/**
 * Estructura: { entries: [{ hash, ts, issues: [numbers] }] }
 * Purga entradas vencidas antes de cada escritura (observacion Security #2).
 */
function loadDedupState(filepath, nowMs, injected) {
  const raw = readJsonSafe(filepath, { entries: [] }, injected);
  if (!Array.isArray(raw.entries)) raw.entries = [];
  // Purga entradas con ts < now - TTL
  raw.entries = raw.entries.filter((e) => {
    if (!e || typeof e !== 'object') return false;
    const ts = Number(e.ts);
    if (!Number.isFinite(ts)) return false;
    return ts >= nowMs - DEDUP_TTL_MS;
  });
  return raw;
}

function findDedupEntry(state, hash) {
  return state.entries.find((e) => e && e.hash === hash) || null;
}

/**
 * Devuelve los issues nuevos respecto a cualquier entrada no vencida que
 * comparta al menos un issue (CA4 "solo los nuevos"). Se considera "match
 * parcial" cualquier entrada cuyo set de issues intersecte con el actual y
 * haya ocurrido dentro del bucket actual o el anterior.
 */
function diffAgainstRecent(state, currentIssues, nowMs) {
  const curSet = new Set((currentIssues || []).map(Number).filter((n) => Number.isFinite(n)));
  if (curSet.size === 0) return { newOnly: false, newIssues: [] };
  // Buscar entrada reciente que comparta al menos 1 issue
  for (const entry of state.entries) {
    if (!entry || !Array.isArray(entry.issues)) continue;
    const prev = new Set(entry.issues.map(Number));
    let shares = false;
    for (const i of prev) { if (curSet.has(i)) { shares = true; break; } }
    if (!shares) continue;
    // Si hay issues en curSet que no estan en prev -> es "nuevo set parcial"
    const onlyNew = [...curSet].filter((i) => !prev.has(i));
    if (onlyNew.length > 0 && onlyNew.length < curSet.size) {
      return { newOnly: true, newIssues: onlyNew.sort((a, b) => a - b) };
    }
  }
  return { newOnly: false, newIssues: [...curSet].sort((a, b) => a - b) };
}

// --- Estado: rate limit TTS ---

/**
 * Schema:
 *   { perIssue: { "2296": [ts, ts, ...] },
 *     global:   [ts, ts, ...],
 *     lastGlobalAlertTs: number }
 *
 * Todos los timestamps son ms-epoch. Las listas se purgan en cada load.
 */
function loadRateLimitState(filepath, nowMs, injected) {
  const defaults = { perIssue: {}, global: [], lastGlobalAlertTs: 0 };
  const raw = readJsonSafe(filepath, defaults, injected);
  // Clamp defensivo (observacion Security #3)
  if (!raw.perIssue || typeof raw.perIssue !== 'object') raw.perIssue = {};
  if (!Array.isArray(raw.global)) raw.global = [];
  if (!Number.isFinite(Number(raw.lastGlobalAlertTs))) raw.lastGlobalAlertTs = 0;

  // Purgar global (> 1h)
  raw.global = raw.global
    .map(Number)
    .filter((ts) => Number.isFinite(ts) && ts >= nowMs - TTS_WINDOW_GLOBAL_MS);

  // Purgar per-issue (> 10 min) y normalizar keys
  const purgedPerIssue = {};
  for (const [k, v] of Object.entries(raw.perIssue)) {
    const key = String(k);
    if (!Array.isArray(v)) continue;
    const filtered = v
      .map(Number)
      .filter((ts) => Number.isFinite(ts) && ts >= nowMs - TTS_WINDOW_PER_ISSUE_MS);
    if (filtered.length > 0) purgedPerIssue[key] = filtered;
  }
  raw.perIssue = purgedPerIssue;

  // Clamp lastGlobalAlertTs negativo/NaN -> 0
  raw.lastGlobalAlertTs = Math.max(0, Number(raw.lastGlobalAlertTs) || 0);
  return raw;
}

/**
 * Evalua si podemos generar audio para este evento. Decide segun:
 *   - Global: si ya hay TTS_LIMIT_GLOBAL en la ultima hora -> fail-closed.
 *   - Per-issue: para cada issue del evento, si ya emitio en los ultimos 10
 *     min -> sin audio. Basta que CUALQUIER issue este rate-limited para
 *     suprimir el audio (criterio conservador para proteger denial-of-wallet).
 *
 * Devuelve { allowed, reason } donde reason ∈ {'global'|'per-issue'|null}.
 */
function evaluateTtsLimit(state, issues, nowMs) {
  if (state.global.length >= TTS_LIMIT_GLOBAL) {
    return { allowed: false, reason: 'global' };
  }
  for (const id of issues) {
    const key = String(id);
    const arr = state.perIssue[key] || [];
    if (arr.length >= TTS_LIMIT_PER_ISSUE) {
      return { allowed: false, reason: 'per-issue' };
    }
  }
  return { allowed: true, reason: null };
}

function registerTtsEmission(state, issues, nowMs) {
  state.global.push(nowMs);
  for (const id of issues) {
    const key = String(id);
    if (!Array.isArray(state.perIssue[key])) state.perIssue[key] = [];
    state.perIssue[key].push(nowMs);
  }
}

// --- Envio (drops a servicio-telegram) ---

/**
 * Default sender: escribe un drop JSON en `.pipeline/servicios/telegram/pendiente/`
 * con parse_mode=MarkdownV2 (CA3).
 */
function defaultSendTelegramMessage(text, opts, injected) {
  const fsMod = (injected && injected.fs) || fs;
  const dropDir = (opts && opts.dropDir) || DEFAULT_TELEGRAM_DROP_DIR;
  try { fsMod.mkdirSync(dropDir, { recursive: true }); } catch { /* exists */ }
  const name = `notifier-${Date.now()}-${process.pid}.json`;
  const filepath = path.join(dropDir, name);
  writeJsonAtomic(filepath, { text, parse_mode: 'MarkdownV2' }, injected);
  return { droppedAt: filepath };
}

/**
 * Default TTS sender: usa multimedia.js (sendVoiceTelegram + textToSpeech).
 * Fallo silencioso ante errores de red (el texto ya fue enviado).
 */
async function defaultSendTtsAudio(script, opts) {
  let multimedia;
  try { multimedia = require('./multimedia'); } catch { return { sent: false, reason: 'multimedia-not-available' }; }
  if (!multimedia.textToSpeech || !multimedia.sendVoiceTelegram) {
    return { sent: false, reason: 'multimedia-api-missing' };
  }
  try {
    const audio = await multimedia.textToSpeech(script);
    if (!audio) return { sent: false, reason: 'tts-empty' };
    const botToken = opts && opts.botToken;
    const chatId = opts && opts.chatId;
    if (!botToken || !chatId) return { sent: false, reason: 'missing-telegram-config' };
    const ok = await multimedia.sendVoiceTelegram(audio, botToken, chatId);
    return { sent: !!ok };
  } catch (e) {
    return { sent: false, reason: `tts-error: ${e.message}` };
  }
}

// --- Entry point principal ---

/**
 * Procesa un evento `connectivity_restored` y decide que notificar.
 *
 *   @param {object} event evento emitido por connectivity-state.js
 *   @param {object} [opts]
 *     @param {string} [opts.dedupFile]
 *     @param {string} [opts.rateLimitFile]
 *     @param {string} [opts.dropDir]
 *     @param {string} [opts.botToken]
 *     @param {string} [opts.chatId]
 *     @param {function} [opts.now] -> ms epoch (default Date.now)
 *     @param {function} [opts.sendTelegramMessage]
 *     @param {function} [opts.sendTtsAudio]
 *     @param {object}   [opts.fs] filesystem module (para tests)
 *   @returns {Promise<object>} resumen { sent, audio, dedup, message, script }
 */
async function notify(event, opts = {}) {
  const now = (opts.now || Date.now)();
  const dedupFile = opts.dedupFile || DEFAULT_DEDUP_FILE;
  const rateFile = opts.rateLimitFile || DEFAULT_RATE_LIMIT_FILE;
  const injected = { fs: opts.fs };

  const issues = [...new Set(
    ((event && event.requeued && event.requeued.issues) || [])
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0)
  )].sort((a, b) => a - b);

  if (issues.length === 0) {
    return { sent: false, reason: 'empty-issues' };
  }

  // --- Dedup (CA4) ---
  const dedupState = loadDedupState(dedupFile, now, injected);
  const currentHash = computeDedupHash(issues, now);
  const existing = findDedupEntry(dedupState, currentHash);
  if (existing) {
    return { sent: false, reason: 'duplicate', dedupHash: currentHash };
  }

  // Buscar si hay entrada reciente con intersection parcial -> "solo nuevos"
  const diff = diffAgainstRecent(dedupState, issues, now);
  let activeIssues = issues;
  let newOnly = false;
  if (diff.newOnly) {
    activeIssues = diff.newIssues;
    newOnly = true;
  }

  // --- Rate limit TTS (CA5) ---
  const rateState = loadRateLimitState(rateFile, now, injected);
  const evalRes = evaluateTtsLimit(rateState, activeIssues, now);

  let rateLimitNote = null;
  let globalAlertText = null;
  if (!evalRes.allowed) {
    if (evalRes.reason === 'per-issue') {
      const seedNote = hashInt(`note|${activeIssues.join(',')}|${Math.floor(now / TTS_WINDOW_PER_ISSUE_MS)}`);
      rateLimitNote = RATE_LIMIT_PER_ISSUE_NOTES[
        Math.abs(seedNote) % RATE_LIMIT_PER_ISSUE_NOTES.length
      ];
    } else if (evalRes.reason === 'global') {
      // Alerta unica por hora (CA5). Tono informativo (UX8).
      if (now - rateState.lastGlobalAlertTs >= GLOBAL_ALERT_WINDOW_MS) {
        globalAlertText = '\u{1F4C9} Toque el limite de 10 audios por hora. '
          + 'Los proximos eventos van solo con texto hasta que baje la ventana.';
      }
    }
  }

  // --- Armar mensaje ---
  const seed = `${activeIssues.join(',')}|${Math.floor(now / DEDUP_BUCKET_MS)}`;
  const messageText = formatMessage({
    issues: activeIssues,
    newOnly,
    rateLimitNote,
    seed,
  });

  // --- Enviar mensaje ---
  const sendMessage = opts.sendTelegramMessage || ((t, o) => defaultSendTelegramMessage(t, o, injected));
  const messageResult = await Promise.resolve(sendMessage(messageText, opts));

  // --- Enviar alerta global (si aplica) ---
  if (globalAlertText) {
    try {
      await Promise.resolve(sendMessage(escapeMarkdownV2(globalAlertText), opts));
    } catch (_) { /* best-effort — el objetivo es no re-emitir, no garantizar entrega */ }
    // Reescribimos ts aca para evitar spam aun si el send falla.
    rateState.lastGlobalAlertTs = now;
  }

  // --- Enviar audio (si se permite) ---
  let audioResult = null;
  let script = null;
  if (evalRes.allowed) {
    script = formatAudioScript({ issues: activeIssues, newOnly });
    const sendTts = opts.sendTtsAudio || defaultSendTtsAudio;
    audioResult = await Promise.resolve(sendTts(script, opts));
    if (audioResult && audioResult.sent !== false) {
      registerTtsEmission(rateState, activeIssues, now);
    }
  }

  // --- Persistir estado (dedup + rate limit) ---
  dedupState.entries.push({ hash: currentHash, ts: now, issues: activeIssues });
  try { writeJsonAtomic(dedupFile, dedupState, injected); } catch { /* best-effort */ }
  try { writeJsonAtomic(rateFile, rateState, injected); } catch { /* best-effort */ }

  return {
    sent: true,
    newOnly,
    activeIssues,
    dedupHash: currentHash,
    message: messageText,
    script,
    audioSent: audioResult ? audioResult.sent !== false : false,
    audioReason: audioResult ? audioResult.reason : null,
    rateLimitReason: evalRes.reason,
    globalAlert: !!globalAlertText,
  };
}

// --- Exports ---

module.exports = {
  notify,
  // Helpers exportados para tests
  escapeMarkdownV2,
  formatIssueList,
  formatMessage,
  formatAudioScript,
  computeDedupHash,
  loadDedupState,
  findDedupEntry,
  diffAgainstRecent,
  loadRateLimitState,
  evaluateTtsLimit,
  registerTtsEmission,
  writeJsonAtomic,
  readJsonSafe,
  // Constantes
  INFRA_EMOJI,
  DEDUP_BUCKET_MS,
  DEDUP_TTL_MS,
  TTS_WINDOW_PER_ISSUE_MS,
  TTS_WINDOW_GLOBAL_MS,
  TTS_LIMIT_PER_ISSUE,
  TTS_LIMIT_GLOBAL,
  MAX_TTS_INPUT_CHARS,
  GLOBAL_ALERT_WINDOW_MS,
  MESSAGE_VARIANTS,
  NEW_ONLY_VARIANTS,
  RATE_LIMIT_PER_ISSUE_NOTES,
};

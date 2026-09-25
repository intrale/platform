// =============================================================================
// quota-ledger.js — Serie temporal de cuota por proveedor (#6560): el DEBE
// observado del libro contable, más los lectores de las fuentes externas que
// alimentan las series derivadas y el snapshot append-only de esas series.
//
// Por qué existe: TODAS las fuentes de % del pipeline son "último valor
// sobreescrito" (`metrics/anthropic-usage.json`, `state/multi-provider-health.json`,
// `.provider-quota-guard-state.json`). Sin serie no hay ritmo ni proyección.
// Este módulo persiste una muestra por proveedor × bucket cada vez que el
// poll de `/api/dash/quota` (`quotaSlice`, misma cadencia que el guard #4282 y
// el pacing #4289) trae un valor nuevo, con debounce para no inflar el archivo.
//
// Archivos (todos bajo el dir que resuelve `write-target`, canal `estado`):
//
//   state/quota-ledger.jsonl — UNA línea por muestra:
//     { ts, provider, bucket, pct, reset_at, confidence, source, window_reset, reset_motivo }
//     · `bucket`: 'weekly' (ventana larga = período declarado en #6559) | 'session'.
//     · `window_reset: true` marca la muestra POSTERIOR a un reinicio de ventana
//       (reposición o crédito de reset de codex #7185, `reset_motivo`). La caída
//       del % NO es consumo negativo (CA-7).
//     · Se escribe siempre que hay reinicio; si no, sólo cuando cambió el valor
//       o pasó `minIntervalMs` (default 15 min) desde la última muestra del par.
//
//   state/quota-series.jsonl — snapshot de las cuatro series derivadas
//     (`quota-series.computeSeries`), debounceado a ~1/hora. Append-only con
//     timestamp, para que #6809 concluya sin cruzar logs a mano (CA-6).
//
// Lectura acotada (SEC): los JSONL se leen por la COLA (`maxBytes`, default
// 4 MB) para que un archivo que creció un año no cargue entero en cada poll.
// Todo lector devuelve objetos construidos por asignación literal de campos
// whitelist (nunca `{...raw}`): `raw_excerpt` del detector ya viene sanitizado
// por `quota-exhausted.appendAudit`, pero acá además se trunca.
//
// NEVER-THROWS en escritura (best-effort, misma regla que provider-cost.js):
// la contabilidad jamás rompe el slice de cuota ni el pulpo.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { normalizeProviderId } = require('./validate-quota-ceilings');

const LEDGER_FILE = 'quota-ledger.jsonl';
const SERIES_FILE = 'quota-series.jsonl';
const BUCKETS = Object.freeze(['weekly', 'session']);
const DEFAULT_MIN_INTERVAL_MS = 15 * 60000;       // muestra sin cambio: 1 cada 15 min
const DEFAULT_SERIES_INTERVAL_MS = 60 * 60000;    // snapshot de series: 1/hora
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;        // cola leída por poll
const DEFAULT_RESET_DROP_PTS = 2;
const DEFAULT_CREDITO_WINDOW_MS = 15 * 60000;
const RAW_EXCERPT_MAX = 200;

// -----------------------------------------------------------------------------
// Paths
// -----------------------------------------------------------------------------

// #6565 — SEC (OWASP A05 / CWE-538): un `pipelineDir` RELATIVO se resuelve contra
// el CWD, que en el pipeline es el working tree del repo. El estado runtime
// aterriza entonces DENTRO del repo, en una carpeta cuyo nombre la regla
// `.pipeline/state/` de .gitignore ya no reconoce, y entra al índice de un repo
// público. Caso real: `PIPELINE_DIR_OVERRIDE` con backslashes de Windows
// consumidos como escapes por el shell POSIX -> ruta colapsada y relativa.
// Fail-closed: sin ruta absoluta no se escribe nada.
function assertPipelineDirAbsoluto(dir) {
  const d = typeof dir === 'string' ? dir.trim() : '';
  if (!d || !path.isAbsolute(d)) {
    throw new TypeError(
      `[quota-ledger] pipelineDir debe ser una ruta ABSOLUTA; recibido ${JSON.stringify(dir)}. ` +
      'Un dir relativo se resuelve contra el CWD (el working tree del repo) y versiona estado runtime. ' +
      'Si viene de PIPELINE_DIR_OVERRIDE en un shell POSIX, pasalo en formato POSIX (/c/Users/...): ' +
      'los backslashes de Windows se consumen como escapes y dejan un path relativo.'
    );
  }
  return d;
}

function resolvePipelineDir(opts) {
  if (opts && opts.pipelineDir) return assertPipelineDirAbsoluto(opts.pipelineDir);
  // #7112 — resolución POR LLAMADA vía el envoltorio (SEC-13): sin ambiente
  // declarado ni dir de pruebas avisa por stderr y LANZA (CA-3), nunca `__dirname`.
  return require('../write-target').writeDir(process.env, { canal: 'estado', destino: 'state/quota-ledger.jsonl' });
}

function ledgerPath(opts) { return path.join(resolvePipelineDir(opts), 'state', LEDGER_FILE); }
function seriesPath(opts) { return path.join(resolvePipelineDir(opts), 'state', SERIES_FILE); }
function logsDir(opts) { return path.join(resolvePipelineDir(opts), 'logs'); }
function healthAuditPath(opts) { return path.join(resolvePipelineDir(opts), 'audit', 'multi-provider-health.jsonl'); }
function schedulePath(opts) { return path.join(resolvePipelineDir(opts), 'provider-schedule.json'); }
function creditStatePath(opts) { return path.join(resolvePipelineDir(opts), 'state', 'codex-reset-credit.json'); }
function providerCostPath(opts) { return path.join(resolvePipelineDir(opts), 'state', 'provider-cost.jsonl'); }

// -----------------------------------------------------------------------------
// Helpers de lectura
// -----------------------------------------------------------------------------

function toMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/**
 * Lee las últimas `maxBytes` de un archivo y devuelve sus líneas completas
 * (descarta la primera si quedó cortada). `[]` si el archivo no existe.
 */
function readTailLines(file, maxBytes) {
  const max = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES;
  let fd = null;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size === 0) return [];
    const start = Math.max(0, st.size - max);
    const len = st.size - start;
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    return text.split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch { /* noop */ } }
  }
}

function parseJsonLines(lines) {
  const out = [];
  for (const line of lines) {
    try { out.push(JSON.parse(line)); } catch { /* línea corrupta: se saltea */ }
  }
  return out;
}

function appendLine(file, record) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// Ledger de muestras
// -----------------------------------------------------------------------------

/** Normaliza una línea del ledger a la forma canónica (whitelist). */
function normalizeLedgerRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const provider = normalizeProviderId(raw.provider);
  const ts = toMs(raw.ts);
  const pct = Number(raw.pct);
  if (!provider || ts == null || !Number.isFinite(pct)) return null;
  return {
    ts: new Date(ts).toISOString(),
    provider,
    bucket: BUCKETS.includes(raw.bucket) ? raw.bucket : 'weekly',
    pct,
    reset_at: toMs(raw.reset_at) != null ? new Date(toMs(raw.reset_at)).toISOString() : null,
    confidence: raw.confidence === 'fresh' || raw.confidence === 'stale' ? raw.confidence : 'missing',
    source: typeof raw.source === 'string' ? raw.source.slice(0, 40) : null,
    window_reset: raw.window_reset === true,
    reset_motivo: raw.reset_motivo === 'credito' || raw.reset_motivo === 'reposicion' ? raw.reset_motivo : null,
  };
}

/**
 * Lee las muestras del ledger (cola acotada), normalizadas y en orden de
 * archivo. Never-throws.
 *
 * @param {object} [opts] - { pipelineDir, file, sinceMs, maxBytes, providers }
 */
function readSamples(opts = {}) {
  const file = opts.file || ledgerPath(opts);
  const since = Number.isFinite(opts.sinceMs) ? opts.sinceMs : null;
  const wanted = Array.isArray(opts.providers) ? opts.providers.map(normalizeProviderId) : null;
  const out = [];
  for (const raw of parseJsonLines(readTailLines(file, opts.maxBytes))) {
    const rec = normalizeLedgerRecord(raw);
    if (!rec) continue;
    if (since != null && toMs(rec.ts) < since) continue;
    if (wanted && !wanted.includes(rec.provider)) continue;
    out.push(rec);
  }
  return out;
}

/** Última muestra persistida por `provider|bucket`, leída de la cola del archivo. */
function lastSamplesByKey(opts) {
  const map = {};
  for (const rec of readSamples({ ...opts, maxBytes: 256 * 1024 })) map[`${rec.provider}|${rec.bucket}`] = rec;
  return map;
}

/**
 * Persiste UNA muestra (append-only, never-throws). Detecta reinicio de ventana
 * contra la última muestra del mismo par y lo marca.
 *
 * @param {object} sample - { provider, bucket, pct, reset_at, confidence, source, ts? }
 * @param {object} [opts] - { pipelineDir, file, now, minIntervalMs, resetDropPts,
 *                            creditRedemptions, last (override de la última muestra) }
 * @returns {object|null} el registro escrito, o null si se debounceó/falló.
 */
function recordSample(sample, opts = {}) {
  try {
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const s = sample && typeof sample === 'object' ? sample : {};
    // Asignación literal de campos (nunca `{...sample}`): el llamador puede
    // arrastrar objetos del adapter con material que no debe persistirse.
    const rec = normalizeLedgerRecord({
      ts: s.ts != null ? s.ts : now,
      provider: s.provider,
      bucket: s.bucket,
      pct: s.pct,
      reset_at: s.reset_at,
      confidence: s.confidence,
      source: s.source,
    });
    if (!rec) return null;
    const key = `${rec.provider}|${rec.bucket}`;
    const last = opts.last !== undefined ? opts.last : lastSamplesByKey(opts)[key];
    const minInterval = Number.isFinite(opts.minIntervalMs) ? opts.minIntervalMs : DEFAULT_MIN_INTERVAL_MS;
    const dropPts = Number.isFinite(opts.resetDropPts) ? opts.resetDropPts : DEFAULT_RESET_DROP_PTS;

    if (last) {
      const lastTs = toMs(last.ts);
      const lastReset = toMs(last.reset_at);
      const curReset = toMs(rec.reset_at);
      const resetMoved = lastReset != null && curReset != null && curReset > lastReset;
      const dropped = last.pct - rec.pct >= dropPts;
      if (resetMoved || dropped) {
        rec.window_reset = true;
        rec.reset_motivo = creditoCerca(opts.creditRedemptions, rec, opts) ? 'credito' : 'reposicion';
      } else {
        const same = last.pct === rec.pct && last.confidence === rec.confidence && lastReset === curReset;
        if (same && Number.isFinite(lastTs) && (toMs(rec.ts) - lastTs) < minInterval) return null; // debounce
        if (Number.isFinite(lastTs) && toMs(rec.ts) <= lastTs) return null;                       // reloj hacia atrás
      }
    }
    const file = opts.file || ledgerPath(opts);
    return appendLine(file, rec) ? rec : null;
  } catch {
    return null;
  }
}

function creditoCerca(redemptions, rec, opts) {
  const win = Number.isFinite(opts && opts.creditoWindowMs) ? opts.creditoWindowMs : DEFAULT_CREDITO_WINDOW_MS;
  const ts = toMs(rec.ts);
  for (const r of Array.isArray(redemptions) ? redemptions : []) {
    if (!r || normalizeProviderId(r.provider) !== rec.provider) continue;
    const at = toMs(r.redeemed_at);
    if (at != null && Math.abs(at - ts) <= win) return true;
  }
  return false;
}

/**
 * Persiste las muestras de TODOS los proveedores a partir del shape normalizado
 * que sirve `quotaSlice` (`out.providers[p].{weekly,session}.{pct,confidence,resetAt}`).
 * Es el hook de ingesta: una llamada por poll, best-effort.
 *
 * @param {object} providersClient - `slice.providers`.
 * @param {object} [opts] - { pipelineDir, now, minIntervalMs, creditRedemptions, source }
 * @returns {number} muestras escritas.
 */
function recordSamplesFromSlice(providersClient, opts = {}) {
  let written = 0;
  try {
    if (!providersClient || typeof providersClient !== 'object') return 0;
    const last = lastSamplesByKey(opts);
    const redemptions = opts.creditRedemptions !== undefined ? opts.creditRedemptions : readCreditRedemptions(opts);
    for (const [prov, data] of Object.entries(providersClient)) {
      if (!data || typeof data !== 'object') continue;
      for (const bucket of BUCKETS) {
        const b = data[bucket];
        if (!b || typeof b !== 'object' || !Number.isFinite(Number(b.pct)) || b.pct == null) continue;
        const rec = recordSample({
          provider: prov,
          bucket,
          pct: Number(b.pct),
          reset_at: b.resetAt || null,
          confidence: b.confidence,
          source: opts.source || 'quota-slice',
          ts: opts.now,
        }, { ...opts, creditRedemptions: redemptions, last: last[`${normalizeProviderId(prov)}|${bucket}`] || null });
        if (rec) written += 1;
      }
    }
  } catch { /* never-throws */ }
  return written;
}

// -----------------------------------------------------------------------------
// Snapshot de series derivadas
// -----------------------------------------------------------------------------

function lastSeriesTs(opts) {
  const lines = readTailLines(opts.file || seriesPath(opts), 64 * 1024);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { const t = toMs(JSON.parse(lines[i]).ts); if (t != null) return t; } catch { /* sigue */ }
  }
  return null;
}

/**
 * Persiste un snapshot de las series derivadas (append-only, debounce ~1 h).
 * @returns {object|null} registro escrito o null si se debounceó/falló.
 */
function recordSeriesSnapshot(series, opts = {}) {
  try {
    if (!series || typeof series !== 'object') return null;
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const minInterval = Number.isFinite(opts.minIntervalMs) ? opts.minIntervalMs : DEFAULT_SERIES_INTERVAL_MS;
    const last = lastSeriesTs(opts);
    if (last != null && now - last < minInterval) return null;
    const rec = {
      ts: new Date(now).toISOString(),
      schema: 1,
      ventana: series.ventana || null,
      gateado: series.gateado || {},
      cadena_agotada: series.cadena_agotada || null,
      unica_pata: series.unica_pata || null,
      trabajo_por_cuota: series.trabajo_por_cuota || {},
    };
    return appendLine(opts.file || seriesPath(opts), rec) ? rec : null;
  } catch {
    return null;
  }
}

/** Lee los snapshots persistidos (cola acotada), ordenados por ts. */
function readSeriesSnapshots(opts = {}) {
  const since = Number.isFinite(opts.sinceMs) ? opts.sinceMs : null;
  const out = [];
  for (const raw of parseJsonLines(readTailLines(opts.file || seriesPath(opts), opts.maxBytes))) {
    const t = toMs(raw && raw.ts);
    if (t == null || (since != null && t < since)) continue;
    out.push(raw);
  }
  out.sort((a, b) => toMs(a.ts) - toMs(b.ts));
  return out;
}

// -----------------------------------------------------------------------------
// Lectores de fuentes externas (read-only, whitelist de campos)
// -----------------------------------------------------------------------------

function ymd(ms) { return new Date(ms).toISOString().slice(0, 10); }

/**
 * Eventos del audit del detector (`logs/quota-detector-YYYY-MM-DD.log`) entre
 * `desde − lookbackDays` y `hasta` (el lookback permite cerrar gates abiertos
 * antes del rango). Campos whitelist: timestamp, event, agent, provider,
 * error_type, raw_excerpt (truncado), flag_set.
 */
function readDetectorEvents(opts = {}) {
  const hasta = Number.isFinite(opts.hasta) ? opts.hasta : Date.now();
  const desde = Number.isFinite(opts.desde) ? opts.desde : hasta - 24 * 3600 * 1000;
  const lookback = (Number.isFinite(opts.lookbackDays) ? opts.lookbackDays : 8) * 24 * 3600 * 1000;
  const dir = opts.logsDir || logsDir(opts);
  const out = [];
  const firstDay = ymd(desde - lookback);
  const lastDay = ymd(hasta);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const name of names.sort()) {
    const m = /^quota-detector-(\d{4}-\d{2}-\d{2})\.log$/.exec(name);
    if (!m || m[1] < firstDay || m[1] > lastDay) continue;
    let text = '';
    try { text = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
    for (const raw of parseJsonLines(text.split(/\r?\n/).filter(Boolean))) {
      const t = toMs(raw && raw.timestamp);
      if (t == null || t > hasta) continue;
      out.push({
        timestamp: new Date(t).toISOString(),
        event: typeof raw.event === 'string' ? raw.event.slice(0, 40) : null,
        agent: typeof raw.agent === 'string' ? raw.agent.slice(0, 40) : null,
        provider: typeof raw.provider === 'string' ? raw.provider.slice(0, 40) : null,
        error_type: typeof raw.error_type === 'string' ? raw.error_type.slice(0, 60) : null,
        raw_excerpt: typeof raw.raw_excerpt === 'string' ? raw.raw_excerpt.replace(/[\r\n\t]+/g, ' ').slice(0, RAW_EXCERPT_MAX) : null,
        flag_set: raw.flag_set === true,
      });
    }
  }
  return out;
}

/** Transiciones de health (`audit/multi-provider-health.jsonl`) desde `desde − lookback`. */
function readHealthEvents(opts = {}) {
  const hasta = Number.isFinite(opts.hasta) ? opts.hasta : Date.now();
  const desde = Number.isFinite(opts.desde) ? opts.desde : hasta - 24 * 3600 * 1000;
  const lookback = (Number.isFinite(opts.lookbackDays) ? opts.lookbackDays : 8) * 24 * 3600 * 1000;
  const out = [];
  for (const raw of parseJsonLines(readTailLines(opts.file || healthAuditPath(opts), opts.maxBytes))) {
    if (!raw || raw.type !== 'health_state_transition') continue;
    const t = toMs(raw.created_at);
    if (t == null || t < desde - lookback || t > hasta) continue;
    out.push({
      type: 'health_state_transition',
      provider: typeof raw.provider === 'string' ? raw.provider.slice(0, 40) : null,
      from_state: typeof raw.from_state === 'string' ? raw.from_state.slice(0, 20) : null,
      to_state: typeof raw.to_state === 'string' ? raw.to_state.slice(0, 20) : null,
      reason_code: typeof raw.reason_code === 'string' ? raw.reason_code.slice(0, 60) : null,
      created_at: t,
    });
  }
  return out;
}

/** `provider-schedule.json` → `{ [provider]: entry }` (o `{}`). */
function readScheduleEntries(opts = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(opts.file || schedulePath(opts), 'utf8'));
    return parsed && parsed.providers && typeof parsed.providers === 'object' ? parsed.providers : {};
  } catch {
    return {};
  }
}

/** Canjes de crédito de reset de codex (#7185) → `[{ provider, redeemed_at }]`. */
function readCreditRedemptions(opts = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(opts.file || creditStatePath(opts), 'utf8'));
    const list = parsed && Array.isArray(parsed.redemptions) ? parsed.redemptions : [];
    return list
      .map(r => ({ provider: 'openai-codex', redeemed_at: r && r.redeemed_at ? String(r.redeemed_at) : null }))
      .filter(r => toMs(r.redeemed_at) != null);
  } catch {
    return [];
  }
}

/** Registros v2 de `provider-cost.jsonl` (vía el reader canónico de #6558). */
function readCostRecords(opts = {}) {
  try {
    const pc = require('../metrics/provider-cost');
    return pc.readProviderCostRecords({ file: opts.file || providerCostPath(opts) });
  } catch {
    return [];
  }
}

module.exports = {
  LEDGER_FILE,
  SERIES_FILE,
  BUCKETS,
  DEFAULT_MIN_INTERVAL_MS,
  DEFAULT_SERIES_INTERVAL_MS,
  assertPipelineDirAbsoluto,
  ledgerPath,
  seriesPath,
  readTailLines,
  normalizeLedgerRecord,
  readSamples,
  recordSample,
  recordSamplesFromSlice,
  recordSeriesSnapshot,
  readSeriesSnapshots,
  readDetectorEvents,
  readHealthEvents,
  readScheduleEntries,
  readCreditRedemptions,
  readCostRecords,
};

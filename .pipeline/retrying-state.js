#!/usr/bin/env node
// =============================================================================
// retrying-state.js — Estado `reintentando` por issue (#2337, CA7/CA8).
//
// Persiste en `.pipeline/retrying-state.json` la ventana de anti-parpadeo
// (`retryingUntil`) + metadata del ultimo transicion. Lo consume:
//   - pulpo.js: al reencolar issues tras `connectivity_restored`, escribe
//     `retryingUntil = now + MIN_RETRY_MS` ANTES de encolar el cmd.json de
//     Telegram (orden FS-first CA7.1 / REQ-SEC-6).
//   - dashboard.js: al renderizar lane cards, chequea si el issue esta
//     en ventana `retrying` (mientras `now < retryingUntil`) y aplica el
//     estado visual `lc-retrying` (CA8).
//
// Schema (versionado para forward-compat con hija B de #2319):
//
//   {
//     "version": 1,
//     "issues": {
//       "<number>": {
//         "retryingUntil": <epoch ms>,
//         "since":         <epoch ms>,
//         "reason":        "connectivity_restored" | ...,
//         "previousState": "blocked:infra" | ...
//       }
//     },
//     "lastUpdate": <epoch ms>
//   }
//
// Anti-parpadeo: la ventana default es 2000ms (CA7.4). Se calcula
// server-side con timestamp absoluto para que el dashboard pueda refrescar
// sin perder la transicion.
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

const PIPELINE_DIR = path.resolve(__dirname);
const DEFAULT_STATE_FILE = path.join(PIPELINE_DIR, 'retrying-state.json');
const SCHEMA_VERSION = 1;

// CA7.4: ventana minima visible del estado `reintentando`.
// 2000ms por guideline PO; configurable para tests/smoke.
const DEFAULT_MIN_RETRY_MS = 2000;

// Razones conocidas (enum abierto — se podran agregar mas)
const REASON_CONNECTIVITY_RESTORED = 'connectivity_restored';

function emptyState() {
  return { version: SCHEMA_VERSION, issues: {}, lastUpdate: 0 };
}

function readState(filePath, fsMod) {
  try {
    if (!fsMod.existsSync(filePath)) return emptyState();
    const raw = fsMod.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return emptyState();
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return emptyState();
    if (data.version !== SCHEMA_VERSION) return emptyState();
    if (!data.issues || typeof data.issues !== 'object') data.issues = {};
    return data;
  } catch {
    return emptyState();
  }
}

function writeStateAtomic(filePath, data, fsMod) {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  const payload = JSON.stringify(data, null, 2);
  fsMod.writeFileSync(tmp, payload, { mode: 0o600 });
  try {
    fsMod.renameSync(tmp, filePath);
  } catch (e) {
    try { fsMod.unlinkSync(tmp); } catch { /* best-effort */ }
    throw e;
  }
}

/**
 * Purga entradas con `retryingUntil` vencido hace mas de GRACE_MS.
 * Mantiene un pequeno margen para que consumidores con refresh lento
 * puedan observar la transicion. No elimina entradas de otros issues.
 */
function purgeExpired(state, nowMs, graceMs = 60 * 1000) {
  const kept = {};
  for (const [k, v] of Object.entries(state.issues || {})) {
    if (!v || typeof v !== 'object') continue;
    const until = Number(v.retryingUntil) || 0;
    if (Number.isFinite(until) && until + graceMs >= nowMs) {
      kept[k] = v;
    }
  }
  state.issues = kept;
  return state;
}

/**
 * Marca un conjunto de issues como `reintentando` hasta `now + minRetryMs`.
 *
 * CA7.1 — esta funcion es el unico entry point que escribe el estado. El
 * caller (pulpo.js) DEBE invocarla ANTES de encolar el cmd.json de Telegram.
 * De esta forma, si el proceso crashea entre ambos writes, el dashboard
 * refleja `reintentando` pero Telegram no se envio; el proximo ciclo recupera.
 *
 *   @param {number[]} issues lista de numeros de issues
 *   @param {object}   [opts]
 *     @param {string}  [opts.stateFile]
 *     @param {object}  [opts.fs]
 *     @param {number}  [opts.now]         epoch ms (default Date.now)
 *     @param {number}  [opts.minRetryMs]  ventana visible (default 2000)
 *     @param {string}  [opts.reason]      default 'connectivity_restored'
 *     @param {string}  [opts.previousState] default 'blocked:infra'
 *   @returns {{ written: object[], retryingUntil: number, filePath: string }}
 */
function markRetrying(issues, opts = {}) {
  const fsMod = opts.fs || fs;
  const filePath = opts.stateFile || DEFAULT_STATE_FILE;
  const nowMs = Number(opts.now) || Date.now();
  const minRetryMs = Number.isFinite(opts.minRetryMs) ? opts.minRetryMs : DEFAULT_MIN_RETRY_MS;
  const reason = typeof opts.reason === 'string' && opts.reason.length > 0
    ? opts.reason
    : REASON_CONNECTIVITY_RESTORED;
  const previousState = typeof opts.previousState === 'string'
    ? opts.previousState
    : 'blocked:infra';

  const clean = [...new Set((issues || [])
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0))];

  if (clean.length === 0) {
    return { written: [], retryingUntil: 0, filePath };
  }

  const state = readState(filePath, fsMod);
  purgeExpired(state, nowMs);

  const retryingUntil = nowMs + Math.max(0, minRetryMs);

  const written = [];
  for (const n of clean) {
    const key = String(n);
    state.issues[key] = {
      retryingUntil,
      since: nowMs,
      reason,
      previousState,
    };
    written.push({ number: n, ...state.issues[key] });
  }
  state.lastUpdate = nowMs;
  writeStateAtomic(filePath, state, fsMod);
  return { written, retryingUntil, filePath };
}

/**
 * Devuelve el mapa de issues en ventana `retrying` activo en `nowMs`.
 *
 *   @returns {{ [issueNum: string]: RetryingState }}
 *
 * Solo incluye issues cuyo `retryingUntil > nowMs`.
 *
 * @typedef {Object} RetryingState
 * @property {number} retryingUntil  epoch ms hasta mostrar como reintentando
 * @property {string} reason         "connectivity_restored" | otros
 * @property {number} since          epoch ms de inicio del estado
 * @property {string} [previousState] estado previo: "blocked:infra" | otros
 */
function getActiveRetrying(opts = {}) {
  const fsMod = opts.fs || fs;
  const filePath = opts.stateFile || DEFAULT_STATE_FILE;
  const nowMs = Number(opts.now) || Date.now();
  const state = readState(filePath, fsMod);
  const active = {};
  for (const [k, v] of Object.entries(state.issues || {})) {
    if (!v || typeof v !== 'object') continue;
    const until = Number(v.retryingUntil) || 0;
    if (until > nowMs) active[k] = v;
  }
  return active;
}

/**
 * Remueve las entradas vencidas (mtime > retryingUntil + graceMs) del archivo.
 * Util para el sweep periodico del pulpo/dashboard — no bloqueante.
 */
function sweepExpired(opts = {}) {
  const fsMod = opts.fs || fs;
  const filePath = opts.stateFile || DEFAULT_STATE_FILE;
  const nowMs = Number(opts.now) || Date.now();
  const graceMs = Number.isFinite(opts.graceMs) ? opts.graceMs : 60 * 1000;

  const state = readState(filePath, fsMod);
  const before = Object.keys(state.issues || {}).length;
  purgeExpired(state, nowMs, graceMs);
  const after = Object.keys(state.issues || {}).length;
  if (after !== before) {
    state.lastUpdate = nowMs;
    try { writeStateAtomic(filePath, state, fsMod); } catch { /* best-effort */ }
  }
  return { removed: before - after, remaining: after };
}

// --- Exports ---

module.exports = {
  // API principal
  markRetrying,
  getActiveRetrying,
  sweepExpired,
  // Helpers de bajo nivel (tests)
  readState,
  writeStateAtomic,
  purgeExpired,
  emptyState,
  // Constantes publicas
  DEFAULT_STATE_FILE,
  SCHEMA_VERSION,
  DEFAULT_MIN_RETRY_MS,
  REASON_CONNECTIVITY_RESTORED,
};

// --- CLI (smoke/debug) ---
if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === 'active') {
    console.log(JSON.stringify(getActiveRetrying(), null, 2));
    process.exit(0);
  }
  if (cmd === 'sweep') {
    console.log(JSON.stringify(sweepExpired(), null, 2));
    process.exit(0);
  }
  console.error('uso: node retrying-state.js [active|sweep]');
  process.exit(2);
}

'use strict';

const fs = require('fs');
const path = require('path');
const trace = require('./traceability');
const { readJsonSafe, writeJsonAtomic } = require('./atomic-json');
const DEFAULT_FILE = path.join(trace.REPO_ROOT, '.pipeline', 'audit', 'merge-race-reclaims.json');
// #6432 CA-21 / CA-24 — traza append-only POR INTENTO. Es el canal donde va la
// historia completa (incluidos los intentos fallidos intermedios, que a Telegram
// NO salen). Nunca el JSON crudo del PR: sólo escalares ya clasificados.
const DEFAULT_JSONL = path.join(trace.REPO_ROOT, '.pipeline', 'audit', 'merge-race-reclaims.jsonl');

function readLedger(file = DEFAULT_FILE) {
  const value = readJsonSafe(file, {});
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function writeLedger(ledger, file = DEFAULT_FILE) {
  return writeJsonAtomic(file, ledger && typeof ledger === 'object' ? ledger : {}, { indent: 2 });
}
function getEntry(issue, file = DEFAULT_FILE) { return readLedger(file)[String(Number(issue))] || null; }

/** Escalar corto de una línea: el ledger no guarda objetos ni multilínea. */
function _scalar(value, maxLength = 200) {
  if (value == null || typeof value === 'object') return null;
  const text = String(value).replace(/[\r\n]+/g, ' ').trim();
  if (!text) return null;
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function recordAttempt({ issue, pr, head_sha, now = new Date(), file = DEFAULT_FILE }) {
  const ledger = readLedger(file); const key = String(Number(issue)); const previous = ledger[key];
  const samePair = previous && Number(previous.pr) === Number(pr) && String(previous.head_sha || '').toLowerCase() === String(head_sha || '').toLowerCase();
  ledger[key] = {
    pr: Number(pr), head_sha: String(head_sha || '').toLowerCase(),
    attempts: samePair ? Number(previous.attempts || 0) + 1 : 1,
    degraded: Boolean(samePair && previous.degraded === true),
    last_attempt_at: now.toISOString(),
    // #6432 CA-23 — el desenlace del intento anterior sólo sobrevive si el par
    // (pr, head_sha) es el mismo; con head nuevo la historia arranca limpia.
    last_status: samePair ? (previous.last_status || null) : null,
    last_gate: samePair ? (previous.last_gate || null) : null,
    last_reason: samePair ? (previous.last_reason || null) : null,
  };
  return writeLedger(ledger, file) ? ledger[key] : null;
}

/**
 * #6432 CA-23 — Persiste el DESENLACE del intento recién corrido (`gate` y
 * `reason` del hijo). Sin esto, el aviso de degradación —que puede dispararse
 * varios ticks después— no tiene con qué llenar dos de sus seis campos y el
 * operador vuelve a quedarse sin saber en qué frenó.
 *
 * NO toca `attempts`: el contador ya lo movió `recordAttempt` ANTES de lanzar el
 * hijo (CA-17). Si la entrada no existe (ledger borrado en medio del intento),
 * no la inventa: devuelve `null` y el caller degrada con `desconocido`.
 */
function recordOutcome({ issue, pr, head_sha, status, gate, reason, now = new Date(), file = DEFAULT_FILE }) {
  const ledger = readLedger(file); const key = String(Number(issue)); const previous = ledger[key];
  if (!previous) return null;
  const samePair = Number(previous.pr) === Number(pr) && String(previous.head_sha || '').toLowerCase() === String(head_sha || '').toLowerCase();
  if (!samePair) return null;
  ledger[key] = {
    ...previous,
    last_status: _scalar(status),
    last_gate: _scalar(gate),
    last_reason: _scalar(reason),
    last_attempt_at: now.toISOString(),
  };
  return writeLedger(ledger, file) ? ledger[key] : null;
}

function markDegraded({ issue, pr, head_sha, now = new Date(), file = DEFAULT_FILE }) {
  const ledger = readLedger(file); const key = String(Number(issue)); const previous = ledger[key] || {};
  ledger[key] = {
    pr: Number(pr), head_sha: String(head_sha || '').toLowerCase(),
    attempts: Number(previous.attempts || 0), degraded: true, last_attempt_at: now.toISOString(),
    // #6432 CA-23 — el desenlace del último intento se CONSERVA al degradar: es
    // el insumo del aviso accionable. Antes se perdía acá y el aviso no existía.
    last_status: previous.last_status || null,
    last_gate: previous.last_gate || null,
    last_reason: previous.last_reason || null,
  };
  return writeLedger(ledger, file);
}

function clearEntry(issue, file = DEFAULT_FILE) { const ledger = readLedger(file); delete ledger[String(Number(issue))]; return writeLedger(ledger, file); }

/**
 * #6432 CA-21 / CA-24 — Append de una línea de traza por intento/desenlace.
 * Fail-closed benigno: si no se puede escribir, devuelve `false` y el barrido
 * sigue (perder la traza no puede frenar el rescate ni el aviso).
 */
function appendAudit(event, file = DEFAULT_JSONL) {
  try {
    const safe = {};
    for (const [k, v] of Object.entries(event || {})) safe[k] = (v == null || typeof v === 'object') ? null : _scalar(v);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...safe }) + '\n');
    return true;
  } catch { return false; }
}

module.exports = { DEFAULT_FILE, DEFAULT_JSONL, readLedger, writeLedger, getEntry, recordAttempt, recordOutcome, markDegraded, clearEntry, appendAudit };

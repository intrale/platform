// =============================================================================
// blocked-infra-state.js
// -----------------------------------------------------------------------------
// Reader + writer safe para `.pipeline/blocked-infra-state.json`.
//
// Contexto (issue #2328):
//   Archivo nuevo, separado de `blocked-issues.json` (que tiene otro schema:
//   grafo de dependencias entre issues). Este archivo captura el ESTADO DE
//   BLOQUEO INFRA POR ISSUE: motivo, endpoint que falló, timestamp del último
//   intento y padre (para drill-down).
//
//   La historia hermana #2317 (productor real de la clasificación infra vs
//   código) todavía está OPEN. Hasta que se integre, el dashboard consume
//   este archivo si existe, o stubs por contrato si no.
//
// Schema v1 (documentado como JSDoc typedefs):
//
//   @typedef {Object} InfraStateEntry
//   @property {'infra'|'code'} blocked_reason  Enum estricto.
//   @property {string} endpoint                URL sanitizada (sin query sensible).
//   @property {string} timestamp               ISO 8601 del último intento.
//   @property {number} parent_issue            Issue padre (entero > 0).
//
//   @typedef {Object} InfraStateFile
//   @property {number} version                 Versión del schema (1).
//   @property {string} updatedAt               ISO 8601 de última actualización.
//   @property {Object<string, InfraStateEntry>} issues  Mapa issue_num → entry.
//
// Seguridad (CA4/CA5):
//   - `writeInfraState` sanitiza cada endpoint con `sanitizeEndpoint()`.
//   - Valida cada campo y descarta entries inválidas con log (nunca lanza).
//   - TODO #2317: reemplazar `readInfraStateFromDisk` con la integración real.
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const {
  sanitizeEndpoint,
  validateParentIssue,
  validateBlockedReason,
  validateTimestamp,
} = require('./sanitize-endpoint');

const SCHEMA_VERSION = 1;
const DEFAULT_FILENAME = 'blocked-infra-state.json';
const MAX_FILE_SIZE = 64 * 1024; // 64KB — defensivo contra DoS de archivos inflados

/**
 * Resuelve el path absoluto del archivo de estado.
 * @param {string} [pipelineDir] Directorio raíz del pipeline (default: `.pipeline/`).
 * @returns {string}
 */
function resolvePath(pipelineDir) {
  const base = pipelineDir || path.resolve(__dirname, '..');
  return path.join(base, DEFAULT_FILENAME);
}

/**
 * Sanitiza y valida una entry antes de aceptarla. Devuelve la entry
 * normalizada o `null` si es inválida.
 *
 * @param {unknown} raw
 * @returns {InfraStateEntry|null}
 */
function validateEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const reason = validateBlockedReason(raw.blocked_reason);
  if (!reason) return null;
  const endpoint = sanitizeEndpoint(raw.endpoint);
  if (!endpoint) return null;
  const ts = validateTimestamp(raw.timestamp);
  if (!ts) return null;
  const parent = validateParentIssue(raw.parent_issue);
  if (parent === null) return null;
  return {
    blocked_reason: reason,
    endpoint,
    timestamp: ts,
    parent_issue: parent,
  };
}

/**
 * Lee y parsea el archivo de estado infra.
 * Lectura defensiva: try/catch + límite de tamaño + validación de entries.
 * Nunca lanza; en caso de error devuelve `{ issues: {}, error: <motivo> }`.
 *
 * @param {string} [pipelineDir]
 * @returns {{issues: Object<string, InfraStateEntry>, error?: string, mtimeMs?: number}}
 */
function readInfraStateFromDisk(pipelineDir) {
  const file = resolvePath(pipelineDir);
  try {
    if (!fs.existsSync(file)) return { issues: {} };
    const stat = fs.statSync(file);
    if (stat.size > MAX_FILE_SIZE) return { issues: {}, error: 'file-too-large', mtimeMs: stat.mtimeMs };
    if (stat.size === 0) return { issues: {}, error: 'empty', mtimeMs: stat.mtimeMs };
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    const rawIssues = (parsed && typeof parsed === 'object' && parsed.issues && typeof parsed.issues === 'object')
      ? parsed.issues
      : {};
    const out = {};
    for (const [k, v] of Object.entries(rawIssues)) {
      const issueNum = validateParentIssue(k);
      if (issueNum === null) continue;
      const entry = validateEntry(v);
      if (!entry) continue;
      out[String(issueNum)] = entry;
    }
    return { issues: out, mtimeMs: stat.mtimeMs };
  } catch (e) {
    return { issues: {}, error: 'invalid-json' };
  }
}

/**
 * Escribe el archivo de estado con cada entry sanitizada. Atomico: escribe
 * a `<file>.tmp` y luego renombra.
 *
 * @param {Object<string, unknown>} issues  Mapa issueNum→entry (se valida cada entrada).
 * @param {string} [pipelineDir]
 * @returns {{ok: boolean, written: number, dropped: number, error?: string}}
 */
function writeInfraState(issues, pipelineDir) {
  const file = resolvePath(pipelineDir);
  try {
    let written = 0, dropped = 0;
    const out = {};
    for (const [k, v] of Object.entries(issues || {})) {
      const issueNum = validateParentIssue(k);
      if (issueNum === null) { dropped++; continue; }
      const entry = validateEntry(v);
      if (!entry) { dropped++; continue; }
      out[String(issueNum)] = entry;
      written++;
    }
    const payload = {
      version: SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      issues: out,
    };
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true, written, dropped };
  } catch (e) {
    return { ok: false, written: 0, dropped: 0, error: e?.message || 'write-failed' };
  }
}

module.exports = {
  SCHEMA_VERSION,
  DEFAULT_FILENAME,
  MAX_FILE_SIZE,
  resolvePath,
  validateEntry,
  readInfraStateFromDisk,
  writeInfraState,
};

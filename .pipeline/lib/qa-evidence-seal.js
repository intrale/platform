'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { redactSensitive } = require('./redact');

const MAX_EVIDENCE_FIELDS = 8;
const MAX_GLOB_FILES = 64;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const SKIPPED_VALUES = new Set(['', '-', 'no-aplica', 'no aplica', 'n/a', 'null']);

class SealError extends Error {
  constructor(reason, declaredPath = '') {
    super(reason);
    this.reason = reason;
    this.declaredPath = declaredPath;
  }
}

function normalizeHash(value) {
  const match = String(value || '').trim().toLowerCase().match(/^(?:sha256:)?([a-f0-9]{64})$/);
  return match ? `sha256:${match[1]}` : null;
}

function isSensitivePath(value) {
  return /(^|[\\/._-])(credentials?|secrets?|passwords?|\.env|id_rsa)([\\/._-]|$)|\.(?:pem|key|p12)$/i.test(String(value));
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/**
 * Resuelve artefactos exclusivamente contra root/qa/evidence/<issue>.
 * El cwd no participa: queda reservado para deriveHead y nunca se toma de data.
 */
function resolveConfined(root, issue, declaredPath) {
  if (typeof declaredPath !== 'string' || path.isAbsolute(declaredPath)) {
    throw new SealError('fuera-de-recinto', declaredPath);
  }
  const segments = declaredPath.split(/[\\/]/);
  if (segments.includes('..')) throw new SealError('traversal', declaredPath);
  if (isSensitivePath(declaredPath)) throw new SealError('fuera-de-recinto', declaredPath);

  const evidenceDir = path.join(root, 'qa', 'evidence', String(issue));
  const absolute = path.resolve(root, declaredPath);
  if (!isInside(evidenceDir, absolute)) throw new SealError('fuera-de-recinto', declaredPath);

  let realEvidenceDir;
  let real;
  try {
    realEvidenceDir = fs.realpathSync(evidenceDir);
    real = fs.realpathSync(absolute);
  } catch {
    // No distingue ausencia de rechazo: evita usar el motivo como oráculo.
    throw new SealError('fuera-de-recinto', declaredPath);
  }
  if (!isInside(realEvidenceDir, real)) throw new SealError('fuera-de-recinto', declaredPath);
  return { absolute, real, evidenceDir: realEvidenceDir };
}

function deriveHead(cwd) {
  let output;
  try {
    // #6495 (rebote de seguridad): `execFileSync` manda el stderr del hijo al
    // stderr del padre por default, así que un `fatal: ...` de git escribía en
    // el mismo sink SIN pasar por sanitizeLogField. Se descarta: el único dato
    // que este módulo necesita es el stdout, y el motivo ya es categórico
    // ('head-invalido').
    output = execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], {
      encoding: 'utf8', timeout: 10000, windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw new SealError('head-invalido');
  }
  if (!/^[a-f0-9]{40}$/i.test(output)) throw new SealError('head-invalido');
  return output.toLowerCase();
}

function expandGlob(root, issue, declaredPath) {
  if (!/[?*]/.test(declaredPath)) return [declaredPath];
  if (declaredPath.includes('?') || (declaredPath.match(/\*/g) || []).length !== 1) {
    throw new SealError('glob-invalido', declaredPath);
  }
  const directory = path.dirname(declaredPath);
  const basename = path.basename(declaredPath);
  const confinedDir = resolveConfined(root, issue, path.join(directory, '.'));
  const escaped = basename.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace('*', '.*');
  const matcher = new RegExp(`^${escaped}$`);
  let names;
  try { names = fs.readdirSync(confinedDir.real).filter(name => matcher.test(name)).sort(); }
  catch { throw new SealError('glob-vacio', declaredPath); }
  if (names.length === 0) throw new SealError('glob-vacio', declaredPath);
  if (names.length > MAX_GLOB_FILES) throw new SealError('glob-oversize', declaredPath);
  return names.map(name => path.join(directory, name).replace(/\\/g, '/'));
}

function readAndHash(confined, declaredPath, remainingBytes) {
  let fd = null;
  try {
    fd = fs.openSync(confined.absolute, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new SealError('no-regular', declaredPath);
    if (stat.size === 0) throw new SealError('vacio', declaredPath);
    if (stat.size > MAX_FILE_BYTES || stat.size > remainingBytes) throw new SealError('oversize', declaredPath);

    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, stat.size));
    let position = 0;
    while (position < stat.size) {
      const read = fs.readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - position), position);
      if (read <= 0) throw new SealError('no-regular', declaredPath);
      hash.update(buffer.subarray(0, read));
      position += read;
    }
    if (fs.realpathSync(confined.absolute) !== confined.real) throw new SealError('fuera-de-recinto', declaredPath);
    const finalStat = fs.fstatSync(fd);
    if (finalStat.size !== stat.size || finalStat.mtimeMs !== stat.mtimeMs) throw new SealError('fuera-de-recinto', declaredPath);
    return { sha256: `sha256:${hash.digest('hex')}`, bytes: stat.size, mtime_ms: stat.mtimeMs };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
}

function evidenceFields(data) {
  return Object.keys(data || {}).filter(key => key === 'screenshot' || /^evidencia(?:_|$)/.test(key))
    .filter(key => !/_sha256$/.test(key));
}

function artifactSpec(value) {
  if (typeof value === 'string') return { ruta: value, tipo: 'original' };
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { ruta: value.ruta || value.path, tipo: value.tipo || 'original', derivado_de: value.derivado_de, sha256: value.sha256 };
  }
  return null;
}

// #6495 (rebote de seguridad) — El campo de evidencia lo escribe el YAML del
// agente QA: es entrada hostil y NO puede llegar cruda a un sink de log.
//
// El sanitizado es por ALLOWLIST, no por denylist. El denylist ya se mostró
// insuficiente dos veces sobre este mismo sink:
//   1. Cubría sólo drive letters de Windows (`C:\...`), así que toda ruta
//      absoluta POSIX (`/var/lib/...`) o UNC se emitía entera, y un CR/LF en la
//      ruta partía el mensaje en dos líneas permitiendo forjar entradas
//      ("[INFO] sellado aprobado por operador").
//   2. Aun cerrando CR/LF y los controles C0/C1 quedaban afuera tres clases:
//      la coerción de valores no string (`{ruta: ['ok','/var/lib/secreto']}`
//      pasaba por String() y quedaba `ok,/var/lib/secreto`, que ya no empieza
//      con `/` y esquivaba el marcador), los overrides bidireccionales
//      (U+202E invierte visualmente el resto de la línea para el operador) y el
//      envenenamiento dentro de una sola línea (`x) sellado OK campo=(y`).
//
// Una ruta legítima de evidencia vive confinada en `qa/evidence/<issue>/` y sólo
// necesita `[A-Za-z0-9._-]`, `/` y el `*` del glob. Todo lo demás —espacios,
// `:`, backslash, paréntesis, `=`, comas, bidi, cualquier no-ASCII— se
// reemplaza ENTERO por un marcador categórico. Nunca se emite una porción del
// valor original: un escape parcial es exactamente lo que reabre la inyección.
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;
// Marcas bidi/invisibles: no son control C0/C1, pero reescriben la línea que ve
// el operador, que es el daño concreto que este sanitizado tiene que evitar.
const BIDI_CHARS = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/;
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|[\\/])/;
// Allowlist: el alfabeto mínimo de una ruta de evidencia confinada.
const SAFE_PATH_CHARS = /^[A-Za-z0-9._\-/*]+$/;
const MAX_LOG_FIELD_CHARS = 120;

// Los motivos son literales internos, pero el sink no confía en eso: sólo se
// emite un motivo de la lista conocida.
const KNOWN_REASONS = new Set([
  'sin-evidencia', 'campos-oversize', 'tipo-invalido', 'traversal', 'fuera-de-recinto',
  'no-regular', 'vacio', 'oversize', 'head-invalido', 'glob-invalido', 'glob-vacio',
  'glob-oversize', 'hash-divergente', 'sellado-invalido',
]);

/**
 * Normaliza un valor controlado por el YAML antes de mandarlo a un log.
 * Garantiza: una sola línea, sin caracteres de control ni bidi, sin rutas
 * absolutas, sin caracteres fuera del alfabeto de una ruta de evidencia y
 * acotado en largo.
 *
 * Fail-closed: ante cualquier duda devuelve un marcador categórico ENTERO, no
 * una versión "limpiada" del valor.
 *
 * @param {*} value valor declarado por el agente (no confiable)
 * @returns {string} valor seguro para concatenar en una línea de log
 */
function sanitizeLogField(value) {
  if (value === undefined || value === null) return '';
  // Sin coerción: String(['ok','/var/lib/secreto']) producía una línea que
  // filtraba la ruta absoluta porque el valor unido ya no empieza con `/`.
  if (typeof value !== 'string') return '<valor-no-textual>';
  if (value === '') return '';
  // El trim va ANTES del test de ruta: "  /etc/passwd" sigue siendo absoluta,
  // y "\n/etc/passwd" no puede esquivar el marcador por un prefijo en blanco.
  const trimmed = value.trim();
  if (trimmed === '') return '<ruta-vacia>';
  if (ABSOLUTE_PATH.test(trimmed)) return '<ruta-absoluta>';
  if (CONTROL_CHARS.test(trimmed) || BIDI_CHARS.test(trimmed)) return '<ruta-no-imprimible>';
  if (!SAFE_PATH_CHARS.test(trimmed)) return '<ruta-no-representable>';
  const redacted = String(redactSensitive(trimmed));
  // Defensa en profundidad: si la redacción reintrodujera un carácter de
  // control o bidi, el valor entero se descarta igual.
  if (CONTROL_CHARS.test(redacted) || BIDI_CHARS.test(redacted)) return '<ruta-no-imprimible>';
  if (redacted.length > MAX_LOG_FIELD_CHARS) return `${redacted.slice(0, MAX_LOG_FIELD_CHARS)}<truncado>`;
  return redacted;
}

function sanitizeReason(reason) {
  return KNOWN_REASONS.has(reason) ? reason : 'sellado-invalido';
}

function logFailure(error) {
  const campo = sanitizeLogField(error && error.declaredPath);
  const reason = sanitizeReason(error && error.reason);
  console.error(`[qa-evidence-seal] sellado rechazado (${reason})${campo ? ` campo=${campo}` : ''}`);
}

function sealQaVerdict({ root, issue, data, cwd } = {}) {
  if (!data || data.resultado !== 'aprobado') return { sealed: false, manifest: null, descartes: [], reason: 'no-aplica' };
  try {
    const fields = evidenceFields(data);
    if (fields.length === 0) throw new SealError('sin-evidencia');
    if (fields.length > MAX_EVIDENCE_FIELDS) throw new SealError('campos-oversize');
    const head = deriveHead(cwd);
    const artifacts = [];
    const discards = [];
    let totalBytes = 0;

    for (const field of fields) {
      const spec = artifactSpec(data[field]);
      if (!spec || SKIPPED_VALUES.has(String(spec.ruta || '').trim().toLowerCase())) continue;
      if (!['original', 'copia', 'derivado'].includes(spec.tipo)) throw new SealError('tipo-invalido');
      const expanded = expandGlob(root, issue, spec.ruta);
      for (const route of expanded) {
        const confined = resolveConfined(root, issue, route);
        const hashed = readAndHash(confined, route, MAX_TOTAL_BYTES - totalBytes);
        totalBytes += hashed.bytes;
        const artifact = { campo: field, ruta: route.replace(/\\/g, '/'), ...hashed, tipo: spec.tipo };
        if (spec.tipo === 'derivado') {
          const source = normalizeHash(spec.derivado_de);
          if (!source) throw new SealError('hash-divergente');
          artifact.derivado_de = source;
        }
        const declared = normalizeHash(spec.sha256 || data[`${field}_sha256`]);
        if (spec.tipo === 'copia') {
          const source = normalizeHash(spec.derivado_de) || declared;
          if (!source || source !== hashed.sha256) throw new SealError('hash-divergente');
          artifact.derivado_de = source;
        }
        if (declared && declared !== hashed.sha256) {
          discards.push({ campo: `${field}_sha256`, declarado: declared, real: hashed.sha256 });
        }
        artifacts.push(artifact);
      }
    }
    if (artifacts.length === 0) throw new SealError('sin-evidencia');
    const manifest = { version: 1, derivado_por: 'qa-evidence-seal', head, artefactos: artifacts, descartes: discards };
    data.sello = manifest;
    const primary = artifacts.find(item => item.campo === 'evidencia') || artifacts[0];
    data.evidencia_sha256 = primary.sha256;
    return { sealed: true, manifest, descartes: discards, reason: null };
  } catch (error) {
    const safeError = error instanceof SealError ? error : new SealError('sellado-invalido');
    logFailure(safeError);
    return { sealed: false, manifest: null, descartes: [], reason: safeError.reason };
  }
}

module.exports = {
  sealQaVerdict, normalizeHash, resolveConfined, deriveHead, sanitizeLogField,
  MAX_EVIDENCE_FIELDS, MAX_GLOB_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES, MAX_LOG_FIELD_CHARS,
};

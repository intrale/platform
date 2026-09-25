// =============================================================================
// policy.js — Evaluador único de la política de licencias (#7592)
//
// Evalúa cada entrada del inventario (Gradle y npm) contra
// config/licenses/policy.json:
//   - `denied`                  → prohibida (gana sobre cualquier otra lista)
//   - `allowed_with_obligation` → permitida, con obligación registrada
//   - `allowed`                 → permitida
//   - cualquier otra cosa       → DESCONOCIDA (fail-closed, SR-4)
//
// Expresiones SPDX: `A OR B` toma la mejor alternativa; `A AND B` la peor;
// `A WITH X` se busca explícitamente en `with_exceptions` y, si no está, vale lo
// que vale `A` (una excepción SPDX sólo agrega permisos, nunca los quita).
//
// Excepciones (CA-5): válidas sólo con `paquete@versión` exacta, `licencia`,
// `justificacion`, `aprobado_por` y `revisar_antes` (fecha ISO AAAA-MM-DD).
// Inválida o vencida ⇒ falla. `now` es inyectable para tests deterministas.
// =============================================================================
'use strict';

const { parseExpression } = require('./spdx');

const RANK = Object.freeze({ allowed: 0, obligation: 1, unknown: 2, denied: 3 });
const DAY_MS = 24 * 60 * 60 * 1000;
const SOON_DAYS = 30;
const EXCEPTION_FIELDS = Object.freeze(['paquete', 'licencia', 'justificacion', 'aprobado_por', 'revisar_antes']);
const EXCEPTIONS_ANCHOR = 'docs/legal/licencias-terceros.md#excepciones';

function assertPolicyShape(policy) {
  if (!policy || typeof policy !== 'object') throw new Error('política inválida: se esperaba un objeto JSON');
  for (const key of ['allowed', 'allowed_with_obligation', 'denied', 'exceptions']) {
    if (!Array.isArray(policy[key])) throw new Error(`política inválida: "${key}" debe ser un array`);
  }
  for (const d of policy.denied) {
    if (!d || typeof d.regla !== 'string' || !d.regla || typeof d.motivo !== 'string' || !d.motivo.trim()) {
      throw new Error('política inválida: cada regla de "denied" necesita "regla" y "motivo"');
    }
  }
}

/** Indexa las listas de la política para clasificar identificadores SPDX. */
function buildIndex(policy) {
  assertPolicyShape(policy);
  const allowed = new Map();
  for (const a of policy.allowed) {
    const id = typeof a === 'string' ? a : a && a.id;
    if (id) allowed.set(id, { obligacion: (a && a.obligacion) || null });
  }
  const obligation = new Map();
  for (const a of policy.allowed_with_obligation) {
    if (a && a.id) obligation.set(a.id, { obligacion: a.obligacion || null, motivo: a.motivo || null });
  }
  const withExceptions = new Map();
  for (const w of Array.isArray(policy.with_exceptions) ? policy.with_exceptions : []) {
    if (w && typeof w.expresion === 'string') withExceptions.set(w.expresion.replace(/\s+/g, ' ').trim(), w);
  }
  return { allowed, obligation, denied: policy.denied, withExceptions };
}

function classifyId(id, idx) {
  for (const rule of idx.denied) {
    const ids = Array.isArray(rule.ids) ? rule.ids : [];
    const prefixes = Array.isArray(rule.prefijos) ? rule.prefijos : [];
    if (ids.includes(id) || prefixes.some((p) => id.startsWith(p))) {
      return { status: 'denied', license: id, rule: rule.regla, motivo: rule.motivo, obligaciones: [] };
    }
  }
  if (idx.obligation.has(id)) {
    const o = idx.obligation.get(id);
    return { status: 'obligation', license: id, rule: null, motivo: null, obligaciones: o.obligacion ? [o.obligacion] : [] };
  }
  if (idx.allowed.has(id)) {
    const o = idx.allowed.get(id);
    return { status: 'allowed', license: id, rule: null, motivo: null, obligaciones: o.obligacion ? [o.obligacion] : [] };
  }
  return {
    status: 'unknown',
    license: id,
    rule: null,
    motivo: `"${id}" no figura en allowed, allowed_with_obligation ni denied`,
    obligaciones: [],
  };
}

function evaluateAst(ast, idx) {
  switch (ast.kind) {
    case 'license':
      return classifyId(ast.id, idx);
    case 'with': {
      const key = `${ast.license} WITH ${ast.exception}`;
      const w = idx.withExceptions.get(key);
      if (w) {
        const status = w.categoria === 'allowed' ? 'allowed'
          : w.categoria === 'allowed_with_obligation' ? 'obligation'
            : w.categoria === 'denied' ? 'denied' : 'unknown';
        return {
          status,
          license: key,
          rule: status === 'denied' ? (w.regla || 'with_exceptions') : null,
          motivo: w.motivo || null,
          obligaciones: w.obligacion ? [w.obligacion] : [],
        };
      }
      const base = classifyId(ast.license, idx);
      return { ...base, license: key };
    }
    case 'or': {
      const results = ast.args.map((a) => evaluateAst(a, idx));
      return results.reduce((best, r) => (RANK[r.status] < RANK[best.status] ? r : best));
    }
    case 'and': {
      const results = ast.args.map((a) => evaluateAst(a, idx));
      const worst = results.reduce((w, r) => (RANK[r.status] > RANK[w.status] ? r : w));
      if (worst.status === 'allowed' || worst.status === 'obligation') {
        const obligaciones = [...new Set(results.flatMap((r) => r.obligaciones))];
        return { ...worst, obligaciones };
      }
      return worst;
    }
    case 'unknown':
    default:
      return { status: 'unknown', license: null, rule: null, motivo: ast.reason || 'expresión no evaluable', obligaciones: [] };
  }
}

/** Evalúa la licencia de una entrada del inventario (sin excepciones). */
function evaluateLicense(entry, idx) {
  if (!entry.expression) {
    return { status: 'unknown', license: null, rule: null, motivo: entry.unknownReason || 'sin licencia declarada', obligaciones: [] };
  }
  const ast = parseExpression(entry.expression);
  if (ast.kind === 'unknown') {
    return { status: 'unknown', license: null, rule: null, motivo: ast.reason, obligaciones: [] };
  }
  return evaluateAst(ast, idx);
}

/** Etiqueta de licencia de una entrada: la expresión normalizada o lo declarado. */
function licenseLabel(entry) {
  return entry.expression || entry.declared || '';
}

function splitPackage(paquete) {
  if (typeof paquete !== 'string') return null;
  const at = paquete.lastIndexOf('@');
  if (at <= 0 || at === paquete.length - 1) return null;
  return { name: paquete.slice(0, at), version: paquete.slice(at + 1) };
}

const EXACT_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.\-+_]*$/;

function parseIsoDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return t;
}

/**
 * Valida una excepción y calcula su vigencia.
 * @returns {{ valid: boolean, errors: string[], expired: boolean, daysLeft: number|null, name?: string, version?: string }}
 */
function validateException(exc, now) {
  const errors = [];
  if (!exc || typeof exc !== 'object' || Array.isArray(exc)) {
    return { valid: false, errors: ['la excepción no es un objeto'], expired: false, daysLeft: null };
  }
  for (const f of EXCEPTION_FIELDS) {
    if (typeof exc[f] !== 'string' || exc[f].trim() === '') errors.push(`falta "${f}"`);
  }
  let name;
  let version;
  if (typeof exc.paquete === 'string' && exc.paquete.trim()) {
    const parts = splitPackage(exc.paquete.trim());
    if (!parts) {
      errors.push('"paquete" debe tener la forma paquete@versión');
    } else {
      ({ name, version } = parts);
      if (name.includes('*') || version.includes('*')) errors.push('"paquete" no admite comodines');
      else if (!EXACT_VERSION_RE.test(version) || /(^|\.)[xX](\.|$)/.test(version)) {
        errors.push(`"paquete" necesita una versión exacta (encontrado: ${version})`);
      }
    }
  }
  let expired = false;
  let daysLeft = null;
  if (typeof exc.revisar_antes === 'string' && exc.revisar_antes.trim()) {
    const t = parseIsoDate(exc.revisar_antes.trim());
    if (t === null) {
      errors.push(`"revisar_antes" no es una fecha ISO válida (AAAA-MM-DD): ${exc.revisar_antes}`);
      expired = true; // SR-3: una fecha que no parsea se trata como vencida
    } else {
      const endOfDay = t + DAY_MS;
      const nowMs = now instanceof Date ? now.getTime() : Number(now);
      expired = nowMs >= endOfDay;
      daysLeft = Math.floor((endOfDay - nowMs) / DAY_MS);
    }
  }
  return { valid: errors.length === 0, errors, expired, daysLeft, name, version };
}

function sameLicense(a, b) {
  return String(a || '').replace(/\s+/g, ' ').trim() === String(b || '').replace(/\s+/g, ' ').trim();
}

/**
 * Evalúa el inventario completo contra la política.
 *
 * @param {object[]} entries  inventario normalizado
 * @param {object} policy     contenido de config/licenses/policy.json
 * @param {{ now: Date|number }} opts
 * @returns {{ results: object[], findings: object[], warnings: object[], exceptions: object[] }}
 */
function evaluate(entries, policy, { now }) {
  if (now === undefined || now === null) throw new Error('evaluate: falta "now"');
  const idx = buildIndex(policy);
  const findings = [];
  const warnings = [];

  const exceptions = policy.exceptions.map((exc, i) => ({ index: i, exc, check: validateException(exc, now), used: false }));
  for (const e of exceptions) {
    if (!e.check.valid) {
      findings.push({
        type: 'EXCEPCIÓN INVÁLIDA',
        coordinate: (e.exc && e.exc.paquete) || `exceptions[${e.index}]`,
        detail: e.check.errors.join('; '),
        action: 'Completá los 5 campos obligatorios con una versión exacta y fecha AAAA-MM-DD',
      });
    } else if (e.check.expired) {
      findings.push({
        type: 'EXCEPCIÓN VENCIDA',
        coordinate: e.exc.paquete,
        detail: `revisar_antes ${e.exc.revisar_antes} (hace ${Math.max(1, -e.check.daysLeft)} día(s))`,
        action: 'Renová la fecha con una justificación nueva o sacá la dependencia',
      });
    }
  }

  const results = entries.map((entry) => {
    const verdict = evaluateLicense(entry, idx);
    const result = { entry, verdict, status: verdict.status, exception: null };
    if (verdict.status !== 'denied' && verdict.status !== 'unknown') return result;

    const match = exceptions.find((e) => e.check.name === entry.coordinate
      && e.check.version === entry.version
      && sameLicense(e.exc.licencia, licenseLabel(entry)));
    if (match) {
      match.used = true;
      if (match.check.valid && !match.check.expired) {
        result.status = 'exception';
        result.exception = match.exc;
        return result;
      }
      // Excepción inválida o vencida: ya quedó reportada arriba; la dependencia
      // no queda cubierta pero no se duplica la línea.
      return result;
    }

    const ref = `${entry.coordinate}@${entry.version}`;
    if (verdict.status === 'denied') {
      findings.push({
        type: 'LICENCIA PROHIBIDA',
        coordinate: ref,
        license: verdict.license,
        rule: `denied[${verdict.rule}]`,
        detail: verdict.motivo,
        action: `Reemplazá la dependencia o pedí una excepción (${EXCEPTIONS_ANCHOR})`,
      });
    } else {
      findings.push({
        type: 'LICENCIA DESCONOCIDA',
        coordinate: ref,
        license: licenseLabel(entry) || '(sin licencia declarada)',
        detail: verdict.motivo,
        action: 'Agregá un alias en config/licenses/policy.json#aliases si es una licencia conocida; si no, pedí una excepción',
      });
    }
    return result;
  });

  for (const e of exceptions) {
    if (e.check.valid && !e.used) {
      warnings.push({
        type: 'EXCEPCIÓN SIN USO',
        coordinate: e.exc.paquete,
        detail: 'ninguna dependencia del inventario coincide con paquete@versión y licencia',
      });
    }
  }

  return { results, findings, warnings, exceptions };
}

/** Excepciones vigentes ordenadas por fecha de revisión (para el Step Summary). */
function activeExceptions(policy, now) {
  return (Array.isArray(policy.exceptions) ? policy.exceptions : [])
    .map((exc) => ({ exc, check: validateException(exc, now) }))
    .filter((x) => x.check.valid && !x.check.expired)
    .sort((a, b) => (a.exc.revisar_antes < b.exc.revisar_antes ? -1 : a.exc.revisar_antes > b.exc.revisar_antes ? 1 : 0))
    .map((x) => ({ ...x.exc, vence_pronto: x.check.daysLeft !== null && x.check.daysLeft <= SOON_DAYS, dias: x.check.daysLeft }));
}

/**
 * Categoría estática (sin fecha) de una entrada, para el reporte versionado:
 * no depende de `now`, así el reporte es determinista. Una excepción vencida
 * igual hace fallar el gate en `check`.
 */
function staticCategory(entry, policy, idx = buildIndex(policy)) {
  const verdict = evaluateLicense(entry, idx);
  if (verdict.status === 'allowed' || verdict.status === 'obligation') {
    return { category: verdict.status, obligaciones: verdict.obligaciones };
  }
  const exc = policy.exceptions.find((x) => {
    const p = x && splitPackage(String(x.paquete || '').trim());
    return p && p.name === entry.coordinate && p.version === entry.version && sameLicense(x.licencia, licenseLabel(entry));
  });
  if (exc) return { category: 'exception', obligaciones: [] };
  return { category: verdict.status, obligaciones: [] };
}

module.exports = {
  EXCEPTION_FIELDS,
  EXCEPTIONS_ANCHOR,
  activeExceptions,
  buildIndex,
  evaluate,
  evaluateLicense,
  licenseLabel,
  parseIsoDate,
  splitPackage,
  staticCategory,
  validateException,
};

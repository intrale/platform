// =============================================================================
// spdx.js — Parser chico de expresiones SPDX + normalización por alias (#7592)
//
// Soporta: identificadores (incluye `+` y `LicenseRef-*`), `AND`, `OR`, `WITH`
// y paréntesis. Precedencia SPDX: WITH > AND > OR.
//
// Fail-closed (SR-4 / CA-4): todo lo que no parsea, no mapea o es un centinela
// sin información (vacío, UNLICENSED, NOASSERTION, NONE, "SEE LICENSE IN …")
// devuelve `{ kind: 'unknown', reason }`. Nunca se asume "permitida".
//
// Sin dependencias npm.
// =============================================================================
'use strict';

// Centinelas que declaran "no hay licencia utilizable". `UNLICENSED` (npm:
// software propietario, sin permiso de uso) NO es `Unlicense` (dominio público).
const SENTINELS = Object.freeze({
  UNLICENSED: 'el paquete se declara UNLICENSED (sin permiso de uso)',
  NOASSERTION: 'la licencia se declara NOASSERTION (no determinada)',
  NONE: 'el paquete declara NONE (sin licencia)',
});

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9.\-+:]*$/;

function normalizeKey(s) {
  return String(s).trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Construye el índice de alias (clave normalizada → expresión SPDX canónica).
 * Las claves se comparan sin mayúsculas y con espacios colapsados; las URLs
 * además se comparan sin esquema ni barra final.
 */
function buildAliasIndex(aliases) {
  const index = new Map();
  if (!aliases || typeof aliases !== 'object') return index;
  for (const [from, to] of Object.entries(aliases)) {
    if (typeof to !== 'string' || !to.trim()) continue;
    index.set(normalizeKey(from), to.trim());
    const url = normalizeUrl(from);
    if (url) index.set(url, to.trim());
  }
  return index;
}

function normalizeUrl(s) {
  const m = /^\s*https?:\/\/(.+?)\/*\s*$/i.exec(String(s));
  return m ? 'url:' + m[1].toLowerCase() : null;
}

function lookupAlias(raw, aliasIndex) {
  if (!aliasIndex || aliasIndex.size === 0) return null;
  const url = normalizeUrl(raw);
  if (url && aliasIndex.has(url)) return aliasIndex.get(url);
  const key = normalizeKey(raw);
  return aliasIndex.has(key) ? aliasIndex.get(key) : null;
}

function tokenize(text) {
  const tokens = [];
  const re = /\s*(\(|\)|[^\s()]+)/g;
  let m;
  let consumed = 0;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) break;
    consumed = re.lastIndex;
    const t = m[1];
    const upper = t.toUpperCase();
    if (t === '(' || t === ')') tokens.push({ type: t });
    else if (upper === 'AND' || upper === 'OR' || upper === 'WITH') tokens.push({ type: upper });
    else tokens.push({ type: 'ID', value: t });
  }
  if (text.slice(consumed).trim() !== '') throw new Error('caracteres sobrantes');
  return tokens;
}

// Gramática: or := and ('OR' and)* ; and := with ('AND' with)* ;
//            with := atom ('WITH' ID)? ; atom := ID | '(' or ')'
function parseTokens(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const take = (type) => {
    const t = tokens[pos];
    if (!t || t.type !== type) throw new Error(`se esperaba ${type}`);
    pos++;
    return t;
  };

  function parseOr() {
    const args = [parseAnd()];
    while (peek() && peek().type === 'OR') { pos++; args.push(parseAnd()); }
    return args.length === 1 ? args[0] : { kind: 'or', args };
  }
  function parseAnd() {
    const args = [parseWith()];
    while (peek() && peek().type === 'AND') { pos++; args.push(parseWith()); }
    return args.length === 1 ? args[0] : { kind: 'and', args };
  }
  function parseWith() {
    const base = parseAtom();
    if (peek() && peek().type === 'WITH') {
      pos++;
      const exc = take('ID');
      if (base.kind !== 'license') throw new Error('WITH sólo aplica a una licencia simple');
      if (!ID_RE.test(exc.value)) throw new Error('excepción SPDX inválida');
      return { kind: 'with', license: base.id, exception: exc.value };
    }
    return base;
  }
  function parseAtom() {
    const t = peek();
    if (!t) throw new Error('expresión incompleta');
    if (t.type === '(') {
      pos++;
      const inner = parseOr();
      take(')');
      return inner;
    }
    if (t.type === 'ID') {
      pos++;
      if (!ID_RE.test(t.value)) throw new Error(`identificador inválido: ${t.value}`);
      return { kind: 'license', id: t.value };
    }
    throw new Error(`token inesperado: ${t.type}`);
  }

  const ast = parseOr();
  if (pos !== tokens.length) throw new Error('tokens sobrantes');
  return ast;
}

/**
 * Parsea una expresión SPDX ya normalizada. Devuelve el AST o
 * `{ kind: 'unknown', reason }` si no parsea.
 */
function parseExpression(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { kind: 'unknown', reason: 'licencia vacía' };
  }
  try {
    return parseTokens(tokenize(text));
  } catch (e) {
    return { kind: 'unknown', reason: `expresión SPDX inválida (${e.message})` };
  }
}

/**
 * Normaliza una licencia declarada por un tercero a un AST SPDX.
 *
 * @param {unknown} declared  lo que declaró el paquete (string u objeto legacy {type})
 * @param {Map} aliasIndex    resultado de buildAliasIndex
 * @returns {{ ast: object, expression: string|null, declared: string }}
 */
function normalizeLicense(declared, aliasIndex) {
  let raw = declared;
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && typeof raw.type === 'string') {
    raw = raw.type; // formato legacy de package.json: { type, url }
  }
  if (typeof raw !== 'string') {
    return {
      ast: { kind: 'unknown', reason: 'sin licencia declarada' },
      expression: null,
      declared: raw === undefined || raw === null ? '' : String(JSON.stringify(raw)),
    };
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { ast: { kind: 'unknown', reason: 'sin licencia declarada' }, expression: null, declared: '' };
  }
  const upper = trimmed.toUpperCase();
  if (Object.prototype.hasOwnProperty.call(SENTINELS, upper)) {
    return { ast: { kind: 'unknown', reason: SENTINELS[upper] }, expression: null, declared: trimmed };
  }
  if (/^SEE LICEN[SC]E IN\b/i.test(trimmed)) {
    return {
      ast: { kind: 'unknown', reason: 'la licencia remite a un archivo ("SEE LICENSE IN …") y no mapea a SPDX' },
      expression: null,
      declared: trimmed,
    };
  }
  const alias = lookupAlias(trimmed, aliasIndex);
  const expression = alias || trimmed;
  const ast = parseExpression(expression);
  return { ast, expression: ast.kind === 'unknown' ? null : toString(ast), declared: trimmed };
}

/** Serializa el AST a una expresión SPDX canónica (con paréntesis mínimos). */
function toString(ast, parent) {
  switch (ast.kind) {
    case 'license': return ast.id;
    case 'with': return `${ast.license} WITH ${ast.exception}`;
    case 'and': {
      const s = ast.args.map((a) => toString(a, 'and')).join(' AND ');
      return parent === 'with' ? `(${s})` : s;
    }
    case 'or': {
      const s = ast.args.map((a) => toString(a, 'or')).join(' OR ');
      return parent === 'and' || parent === 'or' ? `(${s})` : s;
    }
    case 'unknown': return `<desconocida: ${ast.reason}>`;
    default: return '<desconocida>';
  }
}

module.exports = {
  SENTINELS,
  buildAliasIndex,
  lookupAlias,
  normalizeLicense,
  parseExpression,
  toString,
};

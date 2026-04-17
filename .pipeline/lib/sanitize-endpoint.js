// =============================================================================
// sanitize-endpoint.js
// -----------------------------------------------------------------------------
// Sanitización de URLs/endpoints antes de persistir en blocked-infra-state.json.
//
// Requisitos de seguridad (issue #2328 — CA4):
// - Strip case-insensitive de query strings con claves sensibles (deny-list).
// - Strip de basic auth embebido (user:pass@host → host).
// - Strip de fragmento (#...) si contiene `=`.
// - Strip de caracteres de control (\r, \n, \t, \x00-\x1F) y unicode bidi
//   (\u202A-\u202E, \u2066-\u2069) — evita log injection y homoglyph attacks.
// - Truncar a 500 chars máx (DoS por logs gigantes).
// - Nunca conservar puertos (spec de tooltip: solo host + path base).
//
// El resultado es siempre una string ASCII-safe, segura para escribir a disco
// y para renderizar con `textContent` en el tooltip del dashboard.
// =============================================================================

'use strict';

/**
 * Deny-list completo de claves de query string consideradas sensibles.
 * Comparación case-insensitive contra el nombre del parámetro.
 * @type {string[]}
 */
const SENSITIVE_QUERY_KEYS = Object.freeze([
  'api_key', 'apikey',
  'token', 'access_token', 'refresh_token',
  'auth', 'authorization',
  'password', 'pwd', 'passwd',
  'secret', 'client_secret',
  'key', 'private_key',
  'sig', 'signature', 'hmac',
  'jwt', 'bearer',
  'session', 'sessionid', 'sid',
  'cookie',
  'x-api-key', 'x-auth-token',
]);

const SENSITIVE_SET = new Set(SENSITIVE_QUERY_KEYS.map(k => k.toLowerCase()));

const MAX_ENDPOINT_LENGTH = 500;

// Control chars (U+0000..U+001F incluyendo \r, \n, \t) + DEL (U+007F)
// y unicode bidi (bidi-overrides y isolates) — lint off de no-control-regex por diseño.
const CONTROL_AND_BIDI_RE = /[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g;

/**
 * Strippea caracteres de control y unicode bidi de una string.
 * @param {string} s
 * @returns {string}
 */
function stripControlAndBidi(s) {
  if (typeof s !== 'string') return '';
  return s.replace(CONTROL_AND_BIDI_RE, '');
}

/**
 * Determina si una clave de query debe ser strippeada.
 * @param {string} rawKey
 * @returns {boolean}
 */
function isSensitiveKey(rawKey) {
  if (!rawKey) return false;
  return SENSITIVE_SET.has(rawKey.toLowerCase());
}

/**
 * Filtra las claves sensibles de una query string (sin el `?` inicial).
 * Preserva el orden relativo del resto. Conserva el valor decodificado pero
 * no re-encodea — solo las claves cuyo nombre está en el deny-list se descartan.
 *
 * @param {string} queryString
 * @returns {string} Query string reconstruida (sin `?`), o string vacía si no queda nada.
 */
function filterSensitiveQuery(queryString) {
  if (!queryString) return '';
  const parts = queryString.split('&');
  const kept = [];
  for (const p of parts) {
    if (!p) continue;
    const eqIdx = p.indexOf('=');
    const rawKey = eqIdx === -1 ? p : p.slice(0, eqIdx);
    const decodedKey = (() => {
      try { return decodeURIComponent(rawKey); } catch { return rawKey; }
    })();
    if (isSensitiveKey(decodedKey)) continue;
    kept.push(p);
  }
  return kept.join('&');
}

/**
 * Strippea el basic auth embebido de una URL tipo `scheme://user:pass@host/...`.
 * Retorna la URL sin la parte `user:pass@`. Si no hay basic auth, retorna la URL tal cual.
 *
 * @param {string} url
 * @returns {string}
 */
function stripBasicAuth(url) {
  // Matchea "scheme://user:pass@host..." capturando scheme + host-and-rest.
  // Es case-insensitive en el scheme.
  return url.replace(/^([a-zA-Z][a-zA-Z0-9+.\-]*:\/\/)[^\/\s@]+@/, '$1');
}

/**
 * Strippea el puerto de una URL con scheme (`https://host:8443/path` → `https://host/path`).
 * Si la URL es host-only (`host:8443/path`), también strippea.
 * Conserva el path, query y fragmento intactos.
 *
 * @param {string} url
 * @returns {string}
 */
function stripPort(url) {
  // URL con scheme
  const withScheme = url.match(/^([a-zA-Z][a-zA-Z0-9+.\-]*:\/\/)([^\/\?#]+)(.*)$/);
  if (withScheme) {
    const host = withScheme[2].replace(/:(\d+)$/, '');
    return withScheme[1] + host + withScheme[3];
  }
  // URL sin scheme — tratar todo antes del primer `/`, `?` o `#` como host:port
  const hostOnly = url.match(/^([^\/\?#]+)(.*)$/);
  if (hostOnly) {
    const host = hostOnly[1].replace(/:(\d+)$/, '');
    return host + hostOnly[2];
  }
  return url;
}

/**
 * Sanitiza un endpoint/URL arbitrario para persistirlo en `blocked-infra-state.json`
 * y renderizarlo en el tooltip del dashboard.
 *
 * Reglas aplicadas (en orden):
 *  1. Coerce a string; no-strings → cadena vacía.
 *  2. Strip de caracteres de control y unicode bidi.
 *  3. Trim de whitespace en ambos extremos.
 *  4. Strip de basic auth embebido en la URL.
 *  5. Strip de puerto del host.
 *  6. Filtrado de query string contra el deny-list (claves sensibles).
 *     Si la query queda vacía, se remueve también el `?`.
 *  7. Strip del fragmento `#...` si contiene `=` (evita leak de hash-params con tokens).
 *  8. Truncate a 500 chars.
 *
 * @param {unknown} input Endpoint/URL crudo. Cualquier tipo: string, número, null, etc.
 * @returns {string} Endpoint sanitizado, ASCII-safe y seguro para logs/tooltips. Puede ser "".
 */
function sanitizeEndpoint(input) {
  if (input == null) return '';
  let s = typeof input === 'string' ? input : String(input);
  s = stripControlAndBidi(s).trim();
  if (!s) return '';

  // 4. Basic auth
  s = stripBasicAuth(s);

  // 5. Puerto
  s = stripPort(s);

  // 6. Query string (filtrar claves sensibles)
  const qIdx = s.indexOf('?');
  let hash = '';
  const hIdx = s.indexOf('#');
  if (hIdx !== -1) {
    hash = s.slice(hIdx);
    s = s.slice(0, hIdx);
  }
  if (qIdx !== -1 && (hIdx === -1 || qIdx < hIdx)) {
    const base = s.slice(0, qIdx);
    const query = s.slice(qIdx + 1);
    const filtered = filterSensitiveQuery(query);
    s = filtered ? `${base}?${filtered}` : base;
  }

  // 7. Fragmento con `=` → drop
  if (hash && hash.includes('=')) {
    hash = '';
  }
  s = s + hash;

  // 8. Truncate
  if (s.length > MAX_ENDPOINT_LENGTH) {
    s = s.slice(0, MAX_ENDPOINT_LENGTH);
  }
  return s;
}

/**
 * Valida un `parent_issue` contra ataques de open redirect.
 * Debe ser entero positivo acotado (0 < n <= 999999).
 *
 * @param {unknown} input
 * @returns {number|null} Número válido o null si falla validación.
 */
function validateParentIssue(input) {
  if (input == null) return null;
  const n = typeof input === 'number' ? input : Number(input);
  if (!Number.isInteger(n) || n <= 0 || n > 999999) return null;
  return n;
}

/**
 * Enum estricto de motivos de bloqueo renderizados en el dashboard.
 * @type {Set<string>}
 */
const BLOCKED_REASONS = new Set(['infra', 'code']);

/**
 * Valida un `blocked_reason` contra el enum permitido.
 *
 * @param {unknown} input
 * @returns {'infra'|'code'|null}
 */
function validateBlockedReason(input) {
  if (typeof input !== 'string') return null;
  return BLOCKED_REASONS.has(input) ? input : null;
}

/**
 * Valida un timestamp ISO 8601 dentro de ±365 días del actual.
 * Rechaza valores no-string, no-parseables o fuera de ventana.
 *
 * @param {unknown} input
 * @param {number} [nowMs] Timestamp actual en ms (para tests).
 * @returns {string|null} Timestamp ISO válido o null.
 */
function validateTimestamp(input, nowMs = Date.now()) {
  if (typeof input !== 'string' || !input) return null;
  const t = Date.parse(input);
  if (Number.isNaN(t)) return null;
  const windowMs = 365 * 24 * 3600 * 1000;
  if (Math.abs(nowMs - t) > windowMs) return null;
  // Normalizar a ISO
  return new Date(t).toISOString();
}

module.exports = {
  sanitizeEndpoint,
  validateParentIssue,
  validateBlockedReason,
  validateTimestamp,
  SENSITIVE_QUERY_KEYS,
  BLOCKED_REASONS,
  MAX_ENDPOINT_LENGTH,
};

'use strict';

// =============================================================================
// secret-scan-lint.js — calibración del detector en MODO LINT (#5244 rev-2)
//
// Por qué existe
// --------------
// `sanitizer.js` se diseñó para MODO REDACCIÓN: tapar secretos en mensajes de
// Telegram y en archivos de estado. Ahí sobre-redactar cuesta cero, así que
// tiene patrones deliberadamente genéricos (`token = <lo que sea>`,
// `authorization: <lo que sea>`).
//
// El secret-scan reusa el mismo motor como criterio de BLOQUEO sobre código
// fuente y documentación, donde sobre-redactar cuesta un dev frenado. Medido
// sobre los últimos 60 commits no-merge de `main`, los genéricos bloqueaban 13
// commits (21,7 %) y 6 de ellos SÓLO por ruido benigno:
//
//   const token = String(errors[0]).trim().split(/\s+/)[0];   (operational-state.js)
//   val token = this["Authorization"] ?: this["authorization"] (OperatorIdentity.kt)
//   ... `contents: write` + `id-token: write`.                 (un .md de doc)
//
// CA-8d del body es explícito: "un lint que nace ruidoso lo desactivan, y eso
// es peor que no tenerlo". Este módulo separa los dos conjuntos:
//
//   LINT_ALWAYS  — patrones con forma propia de secreto (prefijo de proveedor,
//                  estructura PEM/JWT, userinfo de URL). Corren en TODO archivo.
//   CONFIG_ONLY  — patrones genéricos por nombre de clave, sin forma propia.
//                  Corren SÓLO en archivos de configuración (.json/.yml/.env/…),
//                  que es donde nacieron y donde no hay sintaxis de lenguaje que
//                  los confunda.
//   LINT_EXTRA   — reemplazos de alta especificidad para no perder cobertura en
//                  código fuente: exigen literal entrecomillado, longitud, charset
//                  de secreto y entropía mínima.
//
// Escape por línea
// ----------------
// `secret-scan:ignore` en la propia línea la excluye del escaneo. Es el escape
// mínimo viable: sin él, el único camino para un falso positivo era allowlistear
// el ARCHIVO ENTERO (la allowlist es strict, no admite ignore por línea), o sea
// apagar el gate para siempre en, por ejemplo, un archivo de auth del backend.
// La marca queda en el diff y la ve el reviewer.
// =============================================================================

// Marca de escape por línea. Se compara sobre la línea cruda del hunk.
const IGNORE_MARKER = 'secret-scan:ignore';

// Extensiones donde los patrones genéricos por nombre de clave SÍ aplican.
// Son formatos `clave = valor` sin sintaxis de lenguaje que genere homónimos.
const CONFIG_EXTENSIONS = new Set([
  '.json', '.jsonc', '.json5', '.yml', '.yaml', '.env', '.conf', '.config',
  '.properties', '.ini', '.cfg', '.toml', '.tfvars', '.plist', '.netrc',
]);

// Basenames sin extensión útil que igual son configuración.
const CONFIG_BASENAMES = new Set([
  '.env', '.npmrc', '.netrc', 'credentials', 'config', '.pgpass',
]);

// Patrones de `sanitizer.js` con forma propia de secreto: el match no depende
// del nombre de la clave, sino de la estructura del valor. Corren siempre.
const LINT_ALWAYS = new Set([
  'PRIVATE_KEY', 'BASIC_AUTH', 'DB_URL_QUERY', 'SLACK_WEBHOOK',
  'AWS_ACCESS_KEY', 'AWS_SECRET_KEY', 'AWS_SESSION_TOKEN', 'GITHUB_TOKEN',
  'JWT', 'TELEGRAM_BOT_TOKEN', 'GOOGLE_API_KEY', 'GOOGLE_OAUTH_REFRESH',
  'ANTHROPIC_KEY', 'OPENAI_PROJECT_KEY', 'OPENAI_KEY', 'GOOGLE_OAUTH_TOKEN',
  'GROQ_API_KEY', 'CEREBRAS_API_KEY', 'NVIDIA_NIM_API_KEY', 'COGNITO_SECRET',
]);

// Patrones genéricos por nombre de clave: sólo en archivos de configuración.
// En `.js` / `.kt` / `.md` son ruido puro (ver cabecera).
const CONFIG_ONLY = new Set([
  'CONF_STRUCTURED', 'HEADER_AUTHORIZATION', 'HEADER_X_API_KEY', 'HEADER_COOKIE',
]);

// Valores que tienen forma de secreto pero son evidentemente marcadores.
const PLACEHOLDER_RE = /(redacted|example|changeme|placeholder|your[_-]?|dummy|fake|sample|todo|xxxx|0000000|1234567|aaaaaaa)/i;
// Un slug/identificador en minúsculas separado por - o _ nunca es un secreto.
const SLUG_RE = /^[a-z]+(?:[-_][a-z]+)+$/;

function shannonEntropy(value) {
  const counts = new Map();
  for (const ch of value) counts.set(ch, (counts.get(ch) || 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

// Criterio de "esto parece un secreto de verdad" para los patrones genéricos
// que corren sobre código fuente. Deliberadamente conservador: en la duda NO
// matchea, porque el costo del falso positivo acá es un dev bloqueado.
function looksLikeSecret(value, { minLength = 24, minEntropy = 3 } = {}) {
  const candidate = String(value);
  if (candidate.length < minLength) return false;
  if (!/[0-9]/.test(candidate) || !/[A-Za-z]/.test(candidate)) return false;
  if (SLUG_RE.test(candidate)) return false;
  if (PLACEHOLDER_RE.test(candidate)) return false;
  if (/^\[REDACTED:/.test(candidate)) return false;
  return shannonEntropy(candidate) >= minEntropy;
}

// Reemplazan la cobertura que los genéricos daban sobre código fuente, pero
// exigiendo literal entrecomillado + charset de secreto + longitud + entropía.
const LINT_EXTRA = [
  // `apiKey = "<48 chars opacos>"` en cualquier lenguaje. El valor tiene que
  // ser un literal cerrado: `token = obtenerToken()` no matchea.
  {
    name: 'HARDCODED_SECRET',
    re: /\b(password|passwd|secret|token|apiKey|api[_-]?key|client[_-]?secret|private[_-]?key|access[_-]?key|auth[_-]?token)["']?\s*[:=]\s*(["'])([A-Za-z0-9+/=_.-]{24,})\2/gi,
    replace: (match, key, quote, value) => (
      looksLikeSecret(value) ? `${key}=${quote}[REDACTED:HARDCODED_SECRET]${quote}` : match
    ),
  },
  // `Authorization: Bearer <token opaco>` embebido en código o doc. Exige el
  // esquema explícito: `val token = this["Authorization"]` no matchea.
  {
    name: 'AUTH_HEADER_LITERAL',
    re: /\b(authorization)\s*[:=]\s*["']?\s*(bearer|basic|token)\s+([A-Za-z0-9+/=_.~-]{20,})/gi,
    replace: (match, key, scheme, value) => (
      looksLikeSecret(value, { minLength: 20 })
        ? `${key}: ${scheme} [REDACTED:AUTH_HEADER]`
        : match
    ),
  },
];

function isConfigPath(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase();
  if (CONFIG_BASENAMES.has(base)) return true;
  // `.env.local`, `.env.production`, `application.conf.example`…
  if (base.startsWith('.env')) return true;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return false;
  return CONFIG_EXTENSIONS.has(base.slice(dot));
}

// Devuelve el texto sin las líneas marcadas con `secret-scan:ignore`. Se
// preserva la cantidad de líneas para que los patrones multilínea no se
// "peguen" a través del hueco y el número de línea reportado no se corra.
function stripIgnoredLines(text) {
  const lines = String(text).split('\n');
  let ignored = 0;
  const kept = lines.map((line) => {
    if (!line.includes(IGNORE_MARKER)) return line;
    ignored += 1;
    return '';
  });
  return { text: kept.join('\n'), ignored };
}

// Clasifica un patrón de `sanitizer.js`. Un nombre desconocido se trata como
// LINT_ALWAYS: fail-closed. La deriva la caza `secret-scan-lint.test.js`, que
// exige que todo patrón esté clasificado explícitamente en una de las dos listas.
function appliesTo(patternName, { config }) {
  if (CONFIG_ONLY.has(patternName)) return config;
  return true;
}

function selectPatterns(patterns, filePath) {
  const config = isConfigPath(filePath);
  return (patterns || []).filter(({ name }) => appliesTo(name, { config }));
}

/**
 * createLintSanitizer(sanitizerModule) → (text, filePath) => string
 *
 * Mantiene el contrato fail-closed de `sanitize()`: ante cualquier excepción
 * devuelve `[SANITIZER_ERROR:<reason>]`, nunca el input original.
 */
function createLintSanitizer(sanitizerModule) {
  const internals = sanitizerModule && sanitizerModule.__forTestsOnly__;
  if (!internals || !Array.isArray(internals.PATTERNS) || typeof internals.normalizeForMatching !== 'function') {
    throw new Error('secret-scan: el sanitizer no expone PATTERNS/normalizeForMatching para modo lint');
  }
  return function sanitizeForLint(text, filePath) {
    if (typeof text !== 'string' || text.length === 0) return text || '';
    try {
      let out = internals.normalizeForMatching(text);
      for (const pattern of selectPatterns(internals.PATTERNS, filePath)) {
        out = out.replace(pattern.re, pattern.replace);
      }
      for (const pattern of LINT_EXTRA) {
        out = out.replace(pattern.re, pattern.replace);
      }
      return out;
    } catch (error) {
      const reason = error && error.message
        ? String(error.message).slice(0, 80).replace(/[^A-Za-z0-9 _-]/g, '_')
        : 'unknown';
      return `[SANITIZER_ERROR:${reason}]`;
    }
  };
}

module.exports = {
  CONFIG_BASENAMES,
  CONFIG_EXTENSIONS,
  CONFIG_ONLY,
  IGNORE_MARKER,
  LINT_ALWAYS,
  LINT_EXTRA,
  appliesTo,
  createLintSanitizer,
  isConfigPath,
  looksLikeSecret,
  selectPatterns,
  shannonEntropy,
  stripIgnoredLines,
};

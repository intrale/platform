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
//                  En archivos de configuración (.json/.yml/.env/…) corren CRUDOS.
//   LINT_EXTRA   — reemplazos de alta especificidad para no perder cobertura en
//                  código fuente: exigen literal entrecomillado, longitud, charset
//                  de secreto y entropía mínima.
//
// #5244 rev-3 — CONFIG_ONLY ya NO significa "apagado fuera de config". rev-2 lo
// apagaba y eso abría un hueco: `val dbPassword = "..."` en `.kt` pasaba el gate
// mientras el MISMO valor en `.json` bloqueaba — la extensión decidía, no el
// contenido, en tensión con CA-8a. Ahora fuera de config el patrón corre con
// GUARDA (`GUARDED_IN_SOURCE` + `looksLikeSecret`) cuando su regex captura el
// valor, y donde no lo captura (los header genéricos) la cobertura la da una
// variante de LINT_EXTRA. La extensión gradúa la exigencia; no decide si se mira.
//
// Escape por línea
// ----------------
// `secret-scan:ignore` en la propia línea la excluye del escaneo. Es el escape
// mínimo viable: sin él, el único camino para un falso positivo era allowlistear
// el ARCHIVO ENTERO (la allowlist es strict, no admite ignore por línea), o sea
// apagar el gate para siempre en, por ejemplo, un archivo de auth del backend.
//
// #5244 rev-3 — el escape NO es silencioso. Toda supresión se ANUNCIA en la
// salida del scanner (stderr en `text`, `::warning` en `github`), así que queda
// en el log de Actions aunque nadie mire el diff. Apoyarse en "la ve el
// reviewer" no se sostenía: CODEOWNERS no cubre `.pipeline/` ni `.claude/hooks/`,
// donde un PR puede mergear sin ojos humanos. Y sobre CONTROL_PATHS la marca
// directamente NO se honra: el gate no se apaga a sí mismo.
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

// Patrones genéricos por nombre de clave. En archivos de configuración corren
// CRUDOS (ahí `clave = valor` no tiene homónimos). Fuera de config NO se apagan:
// corren con GUARDA (ver GUARDED_IN_SOURCE) o los reemplaza una variante de alta
// especificidad en LINT_EXTRA. La extensión del archivo gradúa la exigencia, no
// decide si se escanea o no (CA-8a: escaneo por contenido, no filtro por path).
const CONFIG_ONLY = new Set([
  'CONF_STRUCTURED', 'HEADER_AUTHORIZATION', 'HEADER_X_API_KEY', 'HEADER_COOKIE',
]);

// Patrones de CONFIG_ONLY que SÍ corren sobre código fuente, pasando el valor
// capturado por `looksLikeSecret()`. `valueGroup` es el índice del grupo con el
// VALOR dentro de los argumentos del callback de `String.replace`.
//
// #5244 rev-3 — rev-2 apagó la clase entera fuera de config y abrió un hueco:
// una credencial hardcodeada en `.kt`/`.js`/`.py` pasaba el gate mientras el
// MISMO valor en `.json` bloqueaba. Los header genéricos siguen sin guarda
// posible (`[^\r\n]+` no captura el valor); su cobertura en código fuente la da
// LINT_EXTRA con regex que sí capturan.
const GUARDED_IN_SOURCE = {
  CONF_STRUCTURED: { valueGroup: 3 },
};

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

// Longitud mínima para considerar opaco un valor en código fuente.
//
// #5244 rev-3 — bajada de 24 a 16. 24 dejaba pasar cualquier contraseña humana
// (`Intr4le#Prod2026` son 16). 16 es el PISO MEDIDO, no una estimación: en la
// muestra de 60 commits, `const token = String(errors[0]).trim().split(...)` de
// `operational-state.js` hace que CONF_STRUCTURED capture `String(errors[0` —
// 15 chars, entropía 3,37 — así que con 15 o menos ese falso positivo vuelve.
// Lo fija como regresión `secret-scan-lint.test.js`.
const SOURCE_GUARD = { minLength: 16, minEntropy: 3 };

// Guarda para los patrones que exigen un LITERAL ENTRECOMILLADO Y CERRADO
// (LINT_EXTRA). Ahí el umbral puede ser más bajo sin ruido: una expresión de
// código no queda encerrada entre comillas, así que `String(errors[0` — el
// falso positivo que fija el piso de SOURCE_GUARD — no puede llegar a estos
// patrones. Con 14, la revalidación sobre los 60 commits de `main` da el MISMO
// resultado que rev-2 (7/60, la misma lista, todos fixtures de test con
// secretos falsos): delta de ruido cero. Ver PR body.
const LITERAL_GUARD = { minLength: 14, minEntropy: 3 };

// Criterio de "esto parece un secreto de verdad" para los patrones genéricos
// que corren sobre código fuente. Deliberadamente conservador: en la duda NO
// matchea, porque el costo del falso positivo acá es un dev bloqueado.
function looksLikeSecret(value, { minLength = SOURCE_GUARD.minLength, minEntropy = 3 } = {}) {
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
// Nombres de clave que anuncian una credencial. Se admite prefijo de
// identificador (`dbPassword`, `myApiKey`, `PROD_SECRET`): la palabra clave
// pegada a un prefijo es exactamente cómo se escribe en código real, y `\b`
// la perdía.
const SECRET_KEY_RE = '[A-Za-z0-9_.$-]*(?:password|passwd|secret|token|apikey|api[_-]key|client[_-]?secret|private[_-]?key|access[_-]?key|auth[_-]?token|credentials?)';

const LINT_EXTRA = [
  // `apiKey = "<literal opaco>"` en cualquier lenguaje. El valor tiene que ser
  // un literal cerrado: `token = obtenerToken()` no matchea.
  //
  // #5244 rev-3 — el charset era `[A-Za-z0-9+/=_.-]{24,}`, o sea castigaba a la
  // contraseña MÁS fuerte: con `#`, `$` o `!` el literal dejaba de matchear
  // entero y pasaba. Ahora el valor es "cualquier cosa menos comillas, espacio
  // o backslash"; el filtro de ruido lo hace `looksLikeSecret`, no el charset.
  {
    name: 'HARDCODED_SECRET',
    re: new RegExp(`\\b(${SECRET_KEY_RE})["']?\\s*[:=]\\s*(["'])([^"'\\s\\\\]{${LITERAL_GUARD.minLength},})\\2`, 'gi'),
    replace: (match, key, quote, value) => (
      looksLikeSecret(value, LITERAL_GUARD) ? `${key}=${quote}[REDACTED:HARDCODED_SECRET]${quote}` : match
    ),
  },
  // `x-api-key: <valor opaco>` embebido en código o doc. Reemplaza en código
  // fuente la cobertura de HEADER_X_API_KEY, que es CONFIG_ONLY porque su regex
  // se come la línea entera sin capturar el valor.
  {
    name: 'API_KEY_LITERAL',
    re: new RegExp(`\\b(x[-_]?api[-_]?key)\\s*[:=]\\s*["']?\\s*([^"'\\s,;]{${LITERAL_GUARD.minLength},})`, 'gi'),
    replace: (match, key, value) => (
      looksLikeSecret(value, LITERAL_GUARD) ? `${key}: [REDACTED:API_KEY]` : match
    ),
  },
  // `Cookie: <nombre>=<valor opaco>` embebido en código o doc. Ídem
  // HEADER_COOKIE: acá se exige el par `clave=valor` y valor opaco.
  {
    name: 'COOKIE_LITERAL',
    re: new RegExp(`\\b(set-cookie|cookie)\\s*[:=]\\s*["']?\\s*([A-Za-z0-9_.-]+=)([^"'\\s;,]{${LITERAL_GUARD.minLength},})`, 'gi'),
    replace: (match, key, name, value) => (
      looksLikeSecret(value, LITERAL_GUARD) ? `${key}: ${name}[REDACTED:COOKIE]` : match
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
//
// #5244 rev-3 — además de `ignored` (cuántas), devuelve `ignoredLines` (cuáles,
// en numeración del archivo nuevo a partir de `startLine`). Sin eso el escape
// era un bypass SILENCIOSO: el consumidor no tenía con qué reportarlo.
function stripIgnoredLines(text, { startLine = 1 } = {}) {
  const lines = String(text).split('\n');
  const ignoredLines = [];
  const kept = lines.map((line, index) => {
    if (!line.includes(IGNORE_MARKER)) return line;
    ignoredLines.push(Number(startLine) + index);
    return '';
  });
  return { text: kept.join('\n'), ignored: ignoredLines.length, ignoredLines };
}

// Líneas del hunk que llevan la marca, sin suprimirlas. Lo usa el reporte para
// anunciar supresiones incluso donde la marca NO se honra (paths de control).
function markedLines(text, startLine = 1) {
  return stripIgnoredLines(text, { startLine }).ignoredLines;
}

// Clasifica un patrón de `sanitizer.js`. Un nombre desconocido se trata como
// LINT_ALWAYS: fail-closed. La deriva la caza `secret-scan-lint.test.js`, que
// exige que todo patrón esté clasificado explícitamente en una de las dos listas.
function appliesTo(patternName, { config }) {
  if (CONFIG_ONLY.has(patternName)) return config || Boolean(GUARDED_IN_SOURCE[patternName]);
  return true;
}

// Envuelve un patrón para que sólo redacte si el VALOR capturado pasa
// `looksLikeSecret`. La regex es la misma; cambia el criterio de aceptación.
function guardPattern(pattern, { valueGroup }, guard = SOURCE_GUARD) {
  return {
    name: pattern.name,
    re: pattern.re,
    guarded: true,
    replace: (...args) => (
      looksLikeSecret(args[valueGroup], guard) ? pattern.replace(...args) : args[0]
    ),
  };
}

function selectPatterns(patterns, filePath) {
  const config = isConfigPath(filePath);
  const selected = [];
  for (const pattern of patterns || []) {
    if (!appliesTo(pattern.name, { config })) continue;
    const guard = !config && GUARDED_IN_SOURCE[pattern.name];
    selected.push(guard ? guardPattern(pattern, guard) : pattern);
  }
  return selected;
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
  LITERAL_GUARD,
  SOURCE_GUARD,
  appliesTo,
  createLintSanitizer,
  guardPattern,
  isConfigPath,
  looksLikeSecret,
  markedLines,
  selectPatterns,
  shannonEntropy,
  stripIgnoredLines,
};

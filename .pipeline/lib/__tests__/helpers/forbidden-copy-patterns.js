'use strict';

// =============================================================================
// forbidden-copy-patterns.js — Lista CENTRALIZADA de lo que nunca puede
// aparecer en un texto que ve el operador (#6179, CA-8 / SEC-7).
//
// Por qué centralizada
// --------------------
// Antes de este helper había tres tests anti-jerga con tres listas propias
// (`commander-multi-provider.test.js`, `commander-inflight-fallback.test.js`,
// `reduced-mode.test.js`). Tres copias divergentes de un control es la forma
// más barata de que el control no exista: alcanza con que la lista nueva se
// agregue en una sola de las tres para que las otras dos den verde sobre una
// fuga real.
//
// Los patrones de SECRETO (`sk-`, `Bearer `, `api_key`, `AKIA`, `eyJ`) tienen
// costo marginal cero acá y convierten un test de estilo en un control de fuga
// permanente: cualquier copy nuevo que se valide con este helper queda cubierto
// el día que se escribe, sin que nadie tenga que acordarse.
//
// Uso:
//   const { assertCopyLimpio } = require('./helpers/forbidden-copy-patterns');
//   assertCopyLimpio(assert, texto, 'aviso de episodio');
// =============================================================================

/**
 * Jerga operativa e identificadores internos. Lo que el operador no puede
 * accionar no le sirve, y encima le enseña que el canal es para otro.
 */
const JERGA_PATTERNS = Object.freeze([
    { re: /skill=/i, label: 'skill=' },
    { re: /primary=/i, label: 'primary=' },
    { re: /fallback=/i, label: 'fallback=' },
    { re: /\bgated\b/i, label: 'gated' },
    { re: /índice|indice\s*\d/i, label: 'índice' },
    { re: /\bcross-provider\b/i, label: 'cross-provider' },
    { re: /model=/i, label: 'model=' },
]);

/** Identificadores crudos de modelo. */
const MODEL_ID_PATTERNS = Object.freeze([
    { re: /deepseek|gpt-\d|claude-[a-z0-9-]+|gemini-|llama-/i, label: 'id crudo de modelo' },
]);

/**
 * Identificadores internos de proveedor. La única forma legítima de nombrar un
 * motor es `publicProviderLabel`, cuya allowlist tiene dos entradas y las dos
 * son de proveedores pagos (`Anthropic`, `Codex`) — por eso las etiquetas
 * públicas NO matchean estos patrones.
 */
const PROVIDER_ID_PATTERNS = Object.freeze([
    { re: /openai-codex|gemini-google|nvidia-nim|kimi-moonshot|\bcerebras\b|\bmoonshot\b|\bgroq\b/i, label: 'id interno de proveedor' },
]);

/** `errorCode` crudo y payload del proveedor: nunca se interpolan (CA-9). */
const RAW_ERROR_PATTERNS = Object.freeze([
    { re: /quota_exhausted|rate_limit|raw_excerpt|\b5xx\b|weekly_limit/i, label: 'errorCode/payload crudo' },
]);

/**
 * SEC-7 — patrones de secreto. No se espera que aparezcan nunca; están para que
 * el día que alguien interpole una variable equivocada, falle un test en vez de
 * salir un mensaje al chat.
 */
const SECRET_PATTERNS = Object.freeze([
    { re: /\bsk-[A-Za-z0-9_-]{3,}/, label: 'API key estilo sk-' },
    { re: /Bearer\s+\S+/, label: 'Bearer token' },
    { re: /api[_-]?key/i, label: 'api_key' },
    { re: /\bAKIA[0-9A-Z]{6,}/, label: 'AWS access key' },
    { re: /\beyJ[A-Za-z0-9_-]{5,}/, label: 'JWT' },
]);

/** Restos de render que delatan un bug de interpolación. */
const RENDER_LEAK_PATTERNS = Object.freeze([
    { re: /function Object\(\)/, label: 'Function del prototype (#5667)' },
    { re: /\[object Object\]/, label: '[object Object]' },
    { re: /\{[A-Z_]{3,}\}/, label: 'placeholder sin resolver' },
    { re: /\bundefined\b|\bNaN\b/, label: 'valor sin resolver' },
]);

/** Todo junto, que es como se usa el 99 % de las veces. */
const ALL_FORBIDDEN = Object.freeze([
    ...JERGA_PATTERNS,
    ...MODEL_ID_PATTERNS,
    ...PROVIDER_ID_PATTERNS,
    ...RAW_ERROR_PATTERNS,
    ...SECRET_PATTERNS,
    ...RENDER_LEAK_PATTERNS,
]);

/**
 * Devuelve la lista de etiquetas que matchearon. Vacía = texto limpio.
 *
 * @param {string} texto
 * @param {Array<{re:RegExp,label:string}>} [patterns]
 * @returns {string[]}
 */
function findForbidden(texto, patterns = ALL_FORBIDDEN) {
    const s = String(texto == null ? '' : texto);
    return patterns.filter((p) => p.re.test(s)).map((p) => p.label);
}

/**
 * Assert helper. Recibe el `assert` del test para no imponer un runner.
 *
 * @param {object} assert   `node:assert/strict`
 * @param {string} texto    texto visible a validar
 * @param {string} [contexto] nombre para el mensaje de error
 * @param {Array} [patterns]
 */
function assertCopyLimpio(assert, texto, contexto = 'texto visible', patterns = ALL_FORBIDDEN) {
    const hits = findForbidden(texto, patterns);
    assert.deepEqual(
        hits, [],
        `${contexto}: contiene patrones prohibidos [${hits.join(', ')}]\n---\n${texto}\n---`,
    );
}

module.exports = {
    JERGA_PATTERNS,
    MODEL_ID_PATTERNS,
    PROVIDER_ID_PATTERNS,
    RAW_ERROR_PATTERNS,
    SECRET_PATTERNS,
    RENDER_LEAK_PATTERNS,
    ALL_FORBIDDEN,
    findForbidden,
    assertCopyLimpio,
};

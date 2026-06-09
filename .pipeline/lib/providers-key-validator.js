// =============================================================================
// providers-key-validator.js — Validación de formato de API keys por provider
// (#3740, split de #3715 / paraguas #3669).
//
// Responsabilidad ÚNICA: dado un `provider` y una key cruda, decir si el formato
// es válido y devolver SOLO el `last4` — NUNCA loguea, ecoa ni captura grupos de
// la key cruda (security R#1 del épico padre). Si rechaza, retorna
// `{ ok:false, reason }` sin incluir el input.
//
// Las regex son deliberadamente laxas en longitud mínima (los providers cambian
// formato sin avisar) pero estrictas en el prefijo conocido, que es lo que evita
// confundir una key de un provider con la de otro. La fuente de verdad de QUÉ
// providers existen es `ENV_MAPPING` de `lib/credentials.js`; este módulo solo
// aporta el patrón por NOMBRE de provider (`anthropic`, `openai`, ...).
//
// Sin deps npm — sólo lógica pura. Exportado para test directo.
// =============================================================================
'use strict';

// Caracter de masking unificado. 5 bullets + last4 → `sk-•••••ABCD` (CA-3/CA-5).
const MASK_BULLETS = '•••••';

// Regex por NOMBRE de provider (segmento `providers.<name>.api_key` de ENV_MAPPING).
// `openai` y `google` son intencionalmente genéricas: las keys de esos providers
// no tienen un prefijo tan estable como Anthropic/Cerebras/NVIDIA.
const PROVIDER_REGEX = Object.freeze({
    anthropic: /^sk-ant-[A-Za-z0-9_-]{40,}$/,
    openai:    /^sk-[A-Za-z0-9_-]{40,}$/,
    google:    /^[A-Za-z0-9_-]{30,}$/,          // GEMINI_API_KEY (Google AI Studio, formato variable).
    cerebras:  /^csk-[A-Za-z0-9_-]{32,}$/,
    nvidia:    /^nvapi-[A-Za-z0-9_-]{32,}$/,
});

/**
 * Valida el formato de una API key contra la regex del provider.
 *
 * NO loguea, NO ecoa, NO captura grupos del `raw`. En caso de rechazo retorna
 * únicamente `{ ok:false, reason }` — el caller jamás recibe el input crudo de
 * vuelta (defensa contra leaks en error-paths).
 *
 * @param {string} provider — nombre del provider (`anthropic`, `openai`, ...).
 * @param {string} raw — la API key candidata.
 * @returns {{ok:true, last4:string} | {ok:false, reason:'unknown_provider'|'format_invalid'}}
 */
function validateProviderKey(provider, raw) {
    const re = PROVIDER_REGEX[provider];
    if (!re) return { ok: false, reason: 'unknown_provider' };
    if (typeof raw !== 'string' || !re.test(raw)) {
        // NO echo del input. NO logger.info(raw). NO captura de grupos.
        return { ok: false, reason: 'format_invalid' };
    }
    return { ok: true, last4: raw.slice(-4) };
}

/**
 * Devuelve los últimos 4 chars de una key, o `null` si no hay key configurada.
 * @param {*} value — el valor crudo del provider en credentials.json (string|null).
 * @returns {string|null}
 */
function last4Of(value) {
    if (typeof value !== 'string') return null;
    if (value.length < 4) return null;
    return value.slice(-4);
}

/**
 * Masking unificado: `sk-•••••<last4>`. Si `last4` es null/vacío → `null`
 * (la UI muestra "sin key — usar terminal Windows" en ese caso).
 *
 * Prohibido reconstruir el masking inline en otros módulos: éste es el helper
 * único (CA-3 / CA-5 / security R#3). El render del DOM debe pasar el resultado
 * por `escapeHtmlText` igualmente (defensa en profundidad).
 *
 * @param {string|null|undefined} last4
 * @returns {string|null}
 */
function maskKey(last4) {
    if (last4 == null || String(last4).length === 0) return null;
    const tail = String(last4).slice(-4);
    return 'sk-' + MASK_BULLETS + tail;
}

module.exports = {
    PROVIDER_REGEX,
    validateProviderKey,
    last4Of,
    maskKey,
    MASK_BULLETS,
};

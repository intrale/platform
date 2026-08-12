// =============================================================================
// providers/kimi-moonshot.js — Handler del provider Kimi (Moonshot) (#4880)
//
// Kimi se integra como DROP-IN de Claude Code: expone un endpoint
// Anthropic-compatible (`https://api.moonshot.ai/anthropic`) y se invoca con el
// MISMO launcher `claude` que Anthropic, apuntado a esa base URL vía
// `ANTHROPIC_BASE_URL` (que inyecta `build-child-env.js`, scopeado a este
// provider — SEC-2) y autenticado con `ANTHROPIC_AUTH_TOKEN` (el token de Kimi,
// NUNCA la key real de Anthropic — SEC-1).
//
// Por eso este handler DELEGA en el handler de Anthropic todo lo que es
// idéntico al drop-in:
//   - detectLauncher  → misma detección multi-tier del binario Claude Code.
//   - buildSpawn      → mismo objeto de spawn (los args son estilo Claude CLI).
//   - parseTokensFromLog → mismo stream-json (`assistant`/`usage`).
//
// Lo ÚNICO propio es `detectQuotaExhausted`: el endpoint de Moonshot devuelve
// errores con SU allowlist de tipos (`KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER
// ['kimi-moonshot']`), distinta de la de Anthropic MAX. Reusa el mismo parser
// estructural Anthropic-shaped (`_detectAnthropic`) porque el shape del error
// es Anthropic-compatible, pero con el provider/allowlist de Kimi.
// =============================================================================
'use strict';

const fs = require('node:fs');
const anthropic = require('./anthropic');
// #5795 — contrato compartido de la clase cerrada 'authentication_rejected'.
const authRejection = require('../auth-rejection');

// -----------------------------------------------------------------------------
// detectQuotaExhausted — igual que el de Anthropic pero con provider
// 'kimi-moonshot' (su propia allowlist de quota_error_types). El shape del
// error es Anthropic-compatible, así que reusamos `_detectAnthropic`.
//
// Contrato preservado: {matched, errorType, resetsAt, rawLine, evt} |
// {matched:false}. Nunca lanza (try/catch por lectura y por línea — I5).
// -----------------------------------------------------------------------------
function detectQuotaExhausted(logPath, cfg, quotaExhaustedModule, fsImpl, parserModuleOverride) {
    const _fs = fsImpl || fs;
    if (!quotaExhaustedModule || typeof quotaExhaustedModule._detectAnthropic !== 'function') {
        return { matched: false };
    }
    let raw = '';
    try { raw = _fs.readFileSync(logPath, 'utf8'); } catch { return { matched: false }; }
    if (!raw) return { matched: false };

    const parser = parserModuleOverride || require('../provider-error-parser');
    let verdict;
    try {
        verdict = parser.parseProviderError(raw, {
            provider: 'kimi-moonshot',
            transport: 'cli',
            _quotaModule: quotaExhaustedModule,
        });
    } catch {
        return { matched: false };
    }

    if (!verdict || verdict.errorClass !== 'quota_exhausted') {
        return { matched: false };
    }

    // Recuperamos el evt completo + errorType byte-idéntico al detector legacy,
    // usando la allowlist canónica de Kimi.
    const allowlist = (quotaExhaustedModule.KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER || {})['kimi-moonshot']
        || (cfg && cfg.error_types)
        || [];
    for (const line of raw.split('\n')) {
        if (!line.startsWith('{')) continue;
        let evt;
        try { evt = JSON.parse(line); } catch { continue; }
        const r = quotaExhaustedModule._detectAnthropic(evt, allowlist);
        if (r && r.matched) {
            return {
                matched: true,
                errorType: r.errorType,
                resetsAt: evt.resets_at,
                rawLine: line,
                evt,
            };
        }
    }

    return { matched: false };
}

// -----------------------------------------------------------------------------
// detectAuthenticationRejected (#5795) — clase cerrada `authentication_rejected`.
//
// Moonshot (Kimi) devuelve `{error:{type:'invalid_authentication_error',
// message:'Invalid Authentication'}}` con HTTP 401 para credencial inválida.
// El endpoint es Anthropic-compatible para el spawn, pero la taxonomía de
// errores es propia — por eso este adapter NO reusa la tabla de Anthropic.
//
// POSITIVOS: invalid_authentication_error, invalid_api_key, authentication_error
// NEGATIVOS: los tipos de Moonshot para cuota, permisos y transitorios, que
// también viajan con 401/403 en algunos casos.
// -----------------------------------------------------------------------------
const detectAuthenticationRejected = authRejection.makeDetector({
    adapter: 'kimi-moonshot',
    positives: ['invalid_authentication_error', 'invalid_api_key', 'authentication_error'],
    negatives: [
        'exceeded_current_quota_error', 'rate_limit_reached_error', 'quota_exceeded',
        'insufficient_quota', 'rate_limit_exceeded', 'permission_denied_error',
        'permission_denied', 'forbidden', 'content_filter_error',
        'engine_overloaded_error', 'server_error',
        'exceeded_current_token_quota_error',
        // `invalid_request_error` queda AFUERA a propósito: Moonshot también
        // sirve el shape OpenAI, donde ese `type` acompaña a
        // `code: invalid_api_key`. Vetarlo mataría el positivo legítimo.
    ],
});

module.exports = {
    name: 'kimi-moonshot',
    // Drop-in: delega en Anthropic el launcher/spawn/token-parsing.
    detectLauncher: anthropic.detectLauncher,
    buildSpawn: anthropic.buildSpawn,
    parseTokensFromLog: anthropic.parseTokensFromLog,
    // Propio de Kimi: allowlist de quota distinta de Anthropic MAX.
    detectQuotaExhausted,
    // Propio de Kimi: tabla de auth distinta de Anthropic (#5795). NO se delega
    // en el adapter de Anthropic — Moonshot documenta sus propios tipos y el
    // aislamiento cross-provider exige que cada uno responda por su nombre.
    detectAuthenticationRejected,
    // exports internos para tests (delegados al de Anthropic).
    _detectLauncherFresh: anthropic._detectLauncherFresh,
    _setLauncherForTesting: anthropic._setLauncherForTesting,
    _resetLauncherCacheForTesting: anthropic._resetLauncherCacheForTesting,
};

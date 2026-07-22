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

module.exports = {
    name: 'kimi-moonshot',
    // Drop-in: delega en Anthropic el launcher/spawn/token-parsing.
    detectLauncher: anthropic.detectLauncher,
    buildSpawn: anthropic.buildSpawn,
    parseTokensFromLog: anthropic.parseTokensFromLog,
    // Propio de Kimi: allowlist de quota distinta de Anthropic MAX.
    detectQuotaExhausted,
    // exports internos para tests (delegados al de Anthropic).
    _detectLauncherFresh: anthropic._detectLauncherFresh,
    _setLauncherForTesting: anthropic._setLauncherForTesting,
    _resetLauncherCacheForTesting: anthropic._resetLauncherCacheForTesting,
};

// =============================================================================
// agent-launcher/provider-spawn-health.js — Health/backoff por PROVIDER ante
// muertes al spawn. Issue #4648 (Capa 3).
//
// PROBLEMA QUE RESUELVE
// ---------------------
// Un provider de fallback (ej. `gemini-google`) que "resuelve como viable" pero
// muere al spawn en 4-5s debe marcarse INVÁLIDO para que el resolver lo saltee,
// igual que ya hace con los providers gated o apagados. El cooldown por
// muerte-de-provider se registra a nivel PROVIDER (backoff), no al (skill,issue):
// así ningún issue queda congelado por la fragilidad de la cadena de providers.
//
// MECÁNICA
// --------
// - `recordProviderSpawnDeath` incrementa un contador de muertes consecutivas
//   por provider dentro de una ventana deslizante. Cuando alcanza el umbral,
//   apaga el provider vía `provider-disabled.setProviderDisabled` (source
//   `spawn-death`, con TTL). `dispatch-with-fallback` ya saltea providers
//   apagados → el fail-closed de Capa 1 emerge por reuse (primary gateado +
//   fallbacks apagados ⇒ `gated:true` ⇒ el Pulpo NO spawnea, sin penalizar al
//   issue).
// - `recordProviderHealthy` resetea el contador cuando un agente corre bien con
//   ese provider (exit 0 o vida ≥ umbral). Evita apagados por muertes viejas.
//
// PERSISTENCIA: `.pipeline/state/provider-spawn-health.json`
//   {
//     "providers": {
//       "gemini-google": {
//         "consecutiveDeaths": 2,
//         "firstDeathAt": "2026-07-11T...", "lastDeathAt": "2026-07-11T...",
//         "windowExpiresAt": "2026-07-11T..."
//       }
//     }
//   }
//
// GARANTÍAS
// ---------
// - Fail-open: cualquier error de IO/parseo → no-op (jamás rompe el lifecycle).
// - 0o600, escritura atómica (espejo de spawn-failure-state.js).
// - El disable se delega a `provider-disabled` (módulo inyectable para tests).
// - Sin secrets: sólo metadata de control (provider, timestamps, contador).
//
// Sin dependencias externas más allá de `provider-disabled` (Node puro: fs, path).
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Umbral de muertes consecutivas al spawn antes de apagar el provider. ≥ 2 para
// no apagar por un fluke único ("muere REITERADAMENTE" del issue).
const DEFAULT_DEATH_THRESHOLD = 2;

// Ventana deslizante: muertes separadas por más que esto reinician el contador
// (una muerte vieja no debe sumar con una nueva no relacionada).
const DEFAULT_WINDOW_MS = 15 * 60 * 1000; // 15 min

// TTL del apagado del provider (backoff a nivel provider). Modesto: si el
// provider se recupera, vuelve a la cadena en el próximo ciclo.
const DEFAULT_DISABLE_TTL_MS = 30 * 60 * 1000; // 30 min

function stateFile(pipelineDir) {
    return path.join(pipelineDir, 'state', 'provider-spawn-health.json');
}

// -----------------------------------------------------------------------------
// Lectura defensiva. Cualquier error → { providers: {} }. NUNCA lanza.
// -----------------------------------------------------------------------------
function readRaw(pipelineDir, fsImpl) {
    const _fs = fsImpl || fs;
    try {
        const file = stateFile(pipelineDir);
        if (!_fs.existsSync(file)) return { providers: {} };
        const parsed = JSON.parse(_fs.readFileSync(file, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || !parsed.providers || typeof parsed.providers !== 'object') {
            return { providers: {} };
        }
        return { providers: parsed.providers };
    } catch {
        return { providers: {} };
    }
}

// Escritura atómica con 0o600 (espejo de spawn-failure-state.js). Best-effort.
function writeAtomic(pipelineDir, data, fsImpl) {
    const _fs = fsImpl || fs;
    try {
        const file = stateFile(pipelineDir);
        const dir = path.dirname(file);
        _fs.mkdirSync(dir, { recursive: true });
        const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
        const fd = _fs.openSync(tmp, 'w', 0o600);
        try {
            _fs.writeSync(fd, JSON.stringify(data, null, 2));
            try { _fs.fsyncSync(fd); } catch { /* best-effort */ }
        } finally {
            try { _fs.closeSync(fd); } catch { /* best-effort */ }
        }
        _fs.renameSync(tmp, file);
        return true;
    } catch {
        return false;
    }
}

/**
 * recordProviderSpawnDeath — registra una muerte al spawn atribuida al provider
 * e, idempotente por provider, incrementa el contador dentro de la ventana. Si
 * alcanza el umbral, apaga el provider (backoff a nivel provider).
 *
 * @param {object} opts
 * @param {string} opts.pipelineDir
 * @param {string} opts.provider          provider efectivo que murió al spawn.
 * @param {string} [opts.skill]           sólo para audit del disable (no penaliza).
 * @param {number|string} [opts.issue]    idem (contexto, no key de penalización).
 * @param {number} [opts.threshold]       muertes consecutivas para apagar (default 2).
 * @param {number} [opts.windowMs]        ventana deslizante (default 15min).
 * @param {number} [opts.disableTtlMs]    TTL del apagado (default 30min).
 * @param {number} [opts.now]
 * @param {object} [opts.fsImpl]
 * @param {object} [opts.disabledModule]  inyectable en tests (provider-disabled).
 * @returns {{ consecutiveDeaths:number, disabled:boolean, threshold:number }}
 */
function recordProviderSpawnDeath(opts = {}) {
    const { pipelineDir, provider } = opts;
    const result = { consecutiveDeaths: 0, disabled: false, threshold: DEFAULT_DEATH_THRESHOLD };
    if (!pipelineDir || !provider || typeof provider !== 'string') return result;

    const _fs = opts.fsImpl || fs;
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const threshold = Number.isFinite(opts.threshold) && opts.threshold > 0
        ? opts.threshold : DEFAULT_DEATH_THRESHOLD;
    const windowMs = Number.isFinite(opts.windowMs) && opts.windowMs > 0
        ? opts.windowMs : DEFAULT_WINDOW_MS;
    const disableTtlMs = Number.isFinite(opts.disableTtlMs) && opts.disableTtlMs > 0
        ? opts.disableTtlMs : DEFAULT_DISABLE_TTL_MS;
    result.threshold = threshold;

    try {
        const { providers } = readRaw(pipelineDir, _fs);
        const prev = providers[provider];
        // Si la ventana venció (o no había registro), arrancamos de cero.
        const windowAlive = prev
            && prev.windowExpiresAt
            && now < Date.parse(prev.windowExpiresAt);
        const consecutiveDeaths = (windowAlive ? (prev.consecutiveDeaths || 0) : 0) + 1;

        providers[provider] = {
            consecutiveDeaths,
            firstDeathAt: windowAlive && prev.firstDeathAt ? prev.firstDeathAt : new Date(now).toISOString(),
            lastDeathAt: new Date(now).toISOString(),
            windowExpiresAt: new Date(now + windowMs).toISOString(),
        };
        writeAtomic(pipelineDir, { providers }, _fs);
        result.consecutiveDeaths = consecutiveDeaths;

        if (consecutiveDeaths >= threshold) {
            const disabledModule = opts.disabledModule || _loadDisabledModule();
            if (disabledModule && typeof disabledModule.setProviderDisabled === 'function') {
                // provider-disabled valida contra su allowlist; un provider fuera
                // de ella devuelve {ok:false} y no rompe nada (fail-open).
                const r = disabledModule.setProviderDisabled(provider, {
                    ttlMs: disableTtlMs,
                    source: 'spawn-death',
                    now,
                });
                result.disabled = !!(r && r.ok);
            }
        }
    } catch {
        // fail-open
    }
    return result;
}

/**
 * recordProviderHealthy — resetea el contador de muertes de un provider cuando
 * corrió bien (exit 0 o vida ≥ umbral). Idempotente. Fail-open.
 *
 * @param {object} opts { pipelineDir, provider, now, fsImpl }
 * @returns {boolean} true si había estado que limpiar.
 */
function recordProviderHealthy(opts = {}) {
    const { pipelineDir, provider } = opts;
    if (!pipelineDir || !provider || typeof provider !== 'string') return false;
    const _fs = opts.fsImpl || fs;
    try {
        const { providers } = readRaw(pipelineDir, _fs);
        if (!providers[provider]) return false;
        delete providers[provider];
        writeAtomic(pipelineDir, { providers }, _fs);
        return true;
    } catch {
        return false;
    }
}

/**
 * peekProviderSpawnHealth — devuelve el estado actual del provider (sin mutar).
 * null si no hay registro. Útil para diagnóstico/tests.
 */
function peekProviderSpawnHealth(opts = {}) {
    const { pipelineDir, provider } = opts;
    if (!pipelineDir || !provider) return null;
    try {
        const { providers } = readRaw(pipelineDir, opts.fsImpl);
        return providers[provider] || null;
    } catch {
        return null;
    }
}

// Carga perezosa de provider-disabled (evita ciclo de require en boot). Devuelve
// null si no está disponible (fail-open: no se apaga, pero tampoco rompe).
function _loadDisabledModule() {
    try {
        return require('../provider-disabled');
    } catch {
        return null;
    }
}

module.exports = {
    recordProviderSpawnDeath,
    recordProviderHealthy,
    peekProviderSpawnHealth,
    stateFile,
    DEFAULT_DEATH_THRESHOLD,
    DEFAULT_WINDOW_MS,
    DEFAULT_DISABLE_TTL_MS,
    // internos para tests
    _readRaw: readRaw,
};

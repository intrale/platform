// =============================================================================
// cli-oauth-probe.js — Probe compartido de providers CLI-OAuth (#3802 / #4402).
//
// Anthropic (Claude Code) y OpenAI/Codex NO se usan por API key: corren por la
// CLI con OAuth (`claude` MAX login / `codex login`). Pinear su API key da un
// falso ROJO (la key está ausente o devuelve 403) aunque la CLI funcione bien.
// Para esos providers validamos que el binario de la CLI esté disponible en el
// PATH — el camino real — en lugar de la key.
//
// Determinístico (scan de PATH, sin red, sin consumir cuota) e inyectable en
// tests vía `opts.cliProbe`.
//
// #4402 — Este módulo es la FUENTE ÚNICA de la lógica OAuth. Antes vivía en
// `health-cron.js`; se extrajo acá porque `live-ping.js` también la necesita
// pero NO puede `require('./health-cron')` (health-cron ya hace
// `require('./live-ping')` → dependencia circular). health-cron re-exporta
// `isBinaryOnPath`/`probeCliProvider` para back-compat de tests/consumers.
//
// SEGURIDAD (RS-5.1 / RS-5.2): este probe NUNCA lee ni devuelve la API key ni
// el token OAuth. Sólo verifica la presencia del binario y devuelve un status
// derivado (`cli_oauth_ok` / `cli_unavailable` / `cli_binary_undeclared`).
//
// #6857 — Providers con `catalog_probe` en el spec (hoy sólo `gemini-google`
// → `'agy'`) tienen ADEMÁS un round-trip real al CLI (`agy models`) que
// distingue "instalado sin licencia" de "instalado y con licencia". Ese camino
// es async y vive en `probeCliProviderLive`; `probeCliProvider` (sync) sigue
// existiendo para la presencia del binario y la back-compat de tests. El flag
// `AGY_LICENSE_READY` (`readiness_env`) se ELIMINÓ: un flag de entorno local no
// puede saber si la licencia está activa (#6225).
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Resuelve si un binario es invocable buscándolo en el PATH. Windows-aware
 * (respeta PATHEXT). No spawnea nada — sólo `fs.existsSync` sobre los candidatos.
 *
 * @param {string} binary — nombre del binario (ej. 'claude', 'codex').
 * @param {object} [opts]
 * @param {object} [opts.env=process.env]
 * @param {object} [opts.fsImpl=fs]
 * @returns {boolean}
 */
function isBinaryOnPath(binary, { env = process.env, fsImpl = fs } = {}) {
    if (!binary || typeof binary !== 'string') return false;
    const pathVar = env.PATH || env.Path || '';
    const dirs = pathVar.split(path.delimiter).filter(Boolean);
    const isWin = process.platform === 'win32';
    const exts = isWin
        ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map(e => e.toLowerCase())
        : [''];
    for (const dir of dirs) {
        // Binario tal cual (sirve para *nix y para .exe ya con extensión en Win).
        const direct = path.join(dir, binary);
        try { if (fsImpl.existsSync(direct)) return true; } catch { /* ignore */ }
        if (isWin) {
            for (const ext of exts) {
                try { if (fsImpl.existsSync(direct + ext)) return true; } catch { /* ignore */ }
            }
        }
    }
    return false;
}

/**
 * Probe de salud para un provider CLI-OAuth. Devuelve un objeto con la misma
 * forma que `live-ping.ping` (`{ ok, reason, ... }`) para que `classifyState`
 * lo trate igual. NUNCA lee ni devuelve la key/token (RS-5.1 / RS-5.2).
 *
 * @param {object} spec — `{ provider, cli_binary }`.
 * @param {object} [opts]
 * @param {object} [opts.env=process.env]
 * @param {object} [opts.fsImpl=fs]
 * @param {(binary:string)=>boolean} [opts.cliProbe] — override inyectable (tests).
 * @returns {{ ok:boolean, reason:string, provider:string, cli_oauth:boolean }}
 */
function probeCliProvider(spec, { env = process.env, fsImpl = fs, cliProbe } = {}) {
    const binary = spec.cli_binary || null;
    if (!binary) {
        return { ok: false, reason: 'cli_binary_undeclared', provider: spec.provider, cli_oauth: true };
    }
    const available = typeof cliProbe === 'function'
        ? !!cliProbe(binary)
        : isBinaryOnPath(binary, { env, fsImpl });
    if (!available) {
        return { ok: false, reason: 'cli_unavailable', provider: spec.provider, cli_oauth: true };
    }
    return { ok: true, reason: 'cli_oauth_ok', provider: spec.provider, cli_oauth: true };
}

// Registro CERRADO de probes con round-trip por nombre de spec. Lazy require
// para no cargar child_process ni el handler de Gemini en consumidores que
// sólo necesitan `isBinaryOnPath`.
const CATALOG_PROBES = Object.freeze({
    agy: () => require('./agy-catalog-probe').probeAgyCatalog,
});

/**
 * #6857 — Probe de salud CON round-trip para providers CLI-OAuth que lo
 * declaran (`spec.catalog_probe`). Devuelve la misma forma que
 * `probeCliProvider` más `cli_probe` con la evidencia del round-trip.
 *
 * Cuatro estados: versión fuera de contrato → cli_contract_mismatch (rojo durable).
 * Estados restantes para `gemini-google`:
 *   - binario ausente                → `{ ok:false, reason:'cli_unavailable' }`
 *   - instalado, catálogo vacío/err  → `{ ok:false, reason:'cli_license_unavailable' }`
 *   - instalado, catálogo poblado    → `{ ok:true,  reason:'cli_catalog_ok' }`
 *
 * Para specs SIN `catalog_probe` (anthropic / codex) se comporta exactamente
 * igual que `probeCliProvider` (sin red, sin spawn).
 *
 * @param {object} spec — `{ provider, cli_binary, catalog_probe? }`.
 * @param {object} [opts]
 * @param {object}   [opts.env=process.env]
 * @param {object}   [opts.fsImpl=fs]
 * @param {Function} [opts.cliProbe]     — override de presencia del binario (tests).
 * @param {Function} [opts.catalogProbe] — override del round-trip (tests). Recibe `opts`.
 * @param {boolean}  [opts.force]        — ignora la cache del round-trip.
 * @param {string}   [opts.stateDir] / [opts.cachePath] — ubicación de la cache.
 * @returns {Promise<{ ok:boolean, reason:string, provider:string, cli_oauth:boolean,
 *           latency_ms?:number|null, cli_probe?:object }>}
 */
async function probeCliProviderLive(spec, opts = {}) {
    const { env = process.env, fsImpl = fs, cliProbe, catalogProbe } = opts;
    const probeName = spec && spec.catalog_probe;
    if (!probeName) {
        return probeCliProvider(spec, { env, fsImpl, cliProbe });
    }
    if (!spec.cli_binary) {
        return { ok: false, reason: 'cli_binary_undeclared', provider: spec.provider, cli_oauth: true };
    }
    // Con `cliProbe` inyectado (tests / consumers legacy) se respeta primero:
    // si dice que el binario no está, no hay round-trip que hacer.
    if (typeof cliProbe === 'function' && !cliProbe(spec.cli_binary)) {
        return { ok: false, reason: 'cli_unavailable', provider: spec.provider, cli_oauth: true };
    }
    let probeFn = typeof catalogProbe === 'function' ? catalogProbe : null;
    if (!probeFn) {
        const factory = CATALOG_PROBES[probeName];
        if (!factory) {
            // Spec mal declarado: fail-closed, nunca verde por omisión.
            return { ok: false, reason: 'cli_binary_undeclared', provider: spec.provider, cli_oauth: true };
        }
        probeFn = factory();
    }
    let r;
    try {
        r = await probeFn({
            env, fsImpl,
            force: opts.force === true,
            stateDir: opts.stateDir,
            cachePath: opts.cachePath,
            nowMs: opts.nowMs,
            ttlMs: opts.ttlMs,
            timeoutMs: opts.timeoutMs,
            spawnImpl: opts.spawnImpl,
            noCache: opts.noCache,
            contract: spec.cli_contract,
        });
    } catch {
        r = null;
    }
    if (!r || typeof r.reason !== 'string') {
        // El probe no pudo observar nada: instalado (el binario pasó) pero no
        // verificable → mismo tratamiento que "sin licencia" (fail-closed).
        return { ok: false, reason: 'cli_license_unavailable', provider: spec.provider, cli_oauth: true };
    }
    return {
        ok: r.ok === true,
        reason: r.reason,
        provider: spec.provider,
        cli_oauth: true,
        latency_ms: typeof r.latency_ms === 'number' ? r.latency_ms : null,
        // Evidencia del round-trip para el snapshot / dashboard. Sólo datos
        // derivados: conteo, ids saneados, timestamps. Nunca texto del CLI.
        cli_probe: {
            kind: probeName,
            cli_version: /^\d+\.\d+\.\d+$/.test(r.cli_version || '') ? r.cli_version : null,
            detail: r.detail || null,
            model_count: Number.isFinite(r.model_count) ? r.model_count : 0,
            models: Array.isArray(r.models) ? r.models.slice(0, 64) : [],
            checked_at: r.checked_at || null,
            cached: r.cached === true,
            launcher_kind: r.launcher_kind || null,
        },
    };
}

module.exports = {
    isBinaryOnPath,
    probeCliProvider,
    probeCliProviderLive,
};

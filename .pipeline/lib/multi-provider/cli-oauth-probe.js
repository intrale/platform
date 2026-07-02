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
    return available
        ? { ok: true, reason: 'cli_oauth_ok', provider: spec.provider, cli_oauth: true }
        : { ok: false, reason: 'cli_unavailable', provider: spec.provider, cli_oauth: true };
}

module.exports = {
    isBinaryOnPath,
    probeCliProvider,
};

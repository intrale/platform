// =============================================================================
// agy-catalog-probe.js — Health con round-trip REAL al proveedor Google
// (Antigravity CLI, `agy`) — #6857 (split de #6856), cierra #6225.
//
// HASTA #6857 el health de `gemini-google` se resolvía leyendo un flag de
// entorno local (`AGY_LICENSE_READY === '1'`): sin round-trip al proveedor. Un
// flag puede estar puesto con la licencia vencida, o vacío con la licencia
// activa — que era exactamente el estado en producción ("pagaba una licencia y
// esa licencia no se reflejaba"). Ambos casos mienten.
//
// Este módulo reemplaza el flag por una observación empírica: invoca
// `agy models` (no interactivo, no consume cuota de generación, ~2 s) y
// considera SANO al provider sólo si el CLI devuelve un catálogo NO vacío.
//
// TRES ESTADOS, no dos (CA-4):
//
//   | Estado real                          | reason_code               | ok    |
//   |--------------------------------------|---------------------------|-------|
//   | binario ausente                      | cli_unavailable           | false |
//   | instalado, sin licencia / sin sesión | cli_license_unavailable   | false |
//   | instalado y con licencia (catálogo)  | cli_catalog_ok            | true  |
//
// "Sin licencia" agrupa: rc≠0, timeout (agy deslogueado BLOQUEA en OAuth hasta
// timeout — #4869), catálogo vacío o salida no parseable. Todos comparten la
// misma acción del operador ("reautenticá o revisá el billing") y el mismo
// gateo durable en el dispatch.
//
// RESOLUCIÓN DEL BINARIO (CA-2): se usa EXACTAMENTE el `cmd` que devuelve
// `detectLauncher()` del handler (`AGY_BIN` → `%LOCALAPPDATA%\agy\bin\agy.exe`
// → PATH). Así el probe y el launcher miran el mismo binario, y un `AGY_BIN`
// apuntando a un archivo inexistente cae en `cli_unavailable` sin lógica extra.
// `%LOCALAPPDATA%\agy\bin` NO está en el PATH de máquina, sólo en el de
// usuario: por eso el `path-fallback` a `agy` pelado no sirve desde los
// servicios del pipeline y la ubicación oficial va antes que el PATH.
//
// CACHE CON TTL: `agy models` hace red. El health-cron corre cada ~5 min y el
// dispatch considera fresco un snapshot hasta 20 min (`HEALTH_FRESHNESS_MS`);
// un TTL de 15 min mantiene coherentes ambas ventanas y paga UN round-trip
// cada 3 ticks. El resultado se persiste en `state/agy-catalog-probe.json`
// (filesystem = fuente de verdad, sobrevive a un respawn del Pulpo). La cache
// se INVALIDA cuando un spawn real devuelve `authentication_rejected` (#5795),
// para que un deslogueo se refleje antes de que venza el TTL.
//
// SEGURIDAD (RS-5.1 / RS-5.2): este probe NUNCA lee ni persiste el token OAuth.
// Sólo guarda ids de modelos (strings cortos, saneados) y un `detail` tomado de
// una tabla cerrada — jamás texto libre del CLI.
//
// FAIL-CLOSED: cualquier error inesperado (spawn ENOENT, excepción del parser,
// cache ilegible) se traduce a `ok:false`. Nunca se declara disponible un
// provider que no se pudo observar.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const { isBinaryOnPath } = require('./cli-oauth-probe');

const CACHE_FILENAME = 'agy-catalog-probe.json';
const CACHE_VERSION = 1;

// TTL del cache (15 min). Ver cabecera: 5 min de tick × 3 = 15 < 20 min de
// frescura del dispatch.
const DEFAULT_TTL_MS = 15 * 60 * 1000;

// TTL para resultados NEGATIVOS (sin licencia / rc≠0 / timeout): 4 min, es
// decir menos de un tick del cron. Un rojo cacheado 15 min retrasaría 15 min
// la recuperación después de que el operador reautentique o vuelva la red;
// un verde cacheado 15 min sólo ahorra round-trips. La asimetría es a
// propósito: el costo de un rojo viejo es no usar un provider sano.
const DEFAULT_NEGATIVE_TTL_MS = 4 * 60 * 1000;

// Timeout duro del round-trip. `agy` deslogueado bloquea en OAuth hasta
// timeout (#4869): sin esto el probe colgaría el tick del Pulpo.
const DEFAULT_TIMEOUT_MS = 30 * 1000;

// Cota superior de salida aceptada del CLI. Un catálogo real pesa < 2 KB;
// esto sólo evita que un binario roto llene memoria.
const MAX_STDOUT_BYTES = 64 * 1024;

// Ids de modelo: sólo caracteres seguros, largo acotado. Nada del CLI llega al
// snapshot sin pasar por acá.
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/:]{0,79}$/;

// Tabla CERRADA de `detail` (secundario, nunca gobierna el estado).
const DETAIL = Object.freeze({
    BINARY_MISSING: 'binary_missing',
    EXIT_NONZERO: 'exit_nonzero',
    TIMEOUT: 'timeout',
    EMPTY_CATALOG: 'empty_catalog',
    SPAWN_ERROR: 'spawn_error',
    CATALOG_OK: 'catalog_ok',
});

const REASON = Object.freeze({
    UNAVAILABLE: 'cli_unavailable',
    LICENSE: 'cli_license_unavailable',
    OK: 'cli_catalog_ok',
});

function defaultStateDir() {
    return process.env.PIPELINE_STATE_DIR
        || path.resolve(__dirname, '..', '..', 'state');
}

function cachePathFor(opts = {}) {
    if (opts.cachePath) return opts.cachePath;
    return path.join(opts.stateDir || defaultStateDir(), CACHE_FILENAME);
}

// -----------------------------------------------------------------------------
// resolveAgyBinary — mismo orden que `detectLauncher()` del handler, pero
// además VERIFICA que el binario exista (el launcher sólo lo elige).
// -----------------------------------------------------------------------------
function resolveAgyBinary({ env = process.env, fsImpl = fs, platform = process.platform } = {}) {
    let launcher;
    try {
        // Lazy: el handler no depende de este módulo, no hay ciclo. Se usa la
        // variante SIN cache (`_detectLauncherFresh`): el export `detectLauncher`
        // memoiza el resultado del primer llamado y no acepta env inyectado, y
        // el probe tiene que ver un cambio de `AGY_BIN` en el próximo tick.
        const handler = require('../agent-launcher/providers/gemini-google');
        launcher = handler._detectLauncherFresh(env, fsImpl, platform);
    } catch {
        launcher = null;
    }
    if (!launcher || typeof launcher.cmd !== 'string' || !launcher.cmd) {
        return { cmd: null, kind: 'unresolved', available: false };
    }
    let available = false;
    if (launcher.kind === 'path-fallback') {
        // `agy` pelado: sólo es invocable si está en el PATH del proceso.
        available = isBinaryOnPath(launcher.cmd, { env, fsImpl });
    } else {
        // Ruta absoluta (AGY_BIN o ubicación oficial): tiene que existir.
        try { available = !!fsImpl.existsSync(launcher.cmd); } catch { available = false; }
    }
    return { cmd: launcher.cmd, kind: launcher.kind, available };
}

// -----------------------------------------------------------------------------
// parseModelsOutput — `agy models` escribe a stdout una línea por modelo con
// el shape `id<TAB>label` (la línea "Fetching available models..." va a
// stderr). Se acepta también una línea sin TAB con sólo el id, por si una
// versión futura cambia el formato de la etiqueta. Devuelve ids saneados,
// únicos, en orden.
// -----------------------------------------------------------------------------
function parseModelsOutput(stdout) {
    if (!stdout || typeof stdout !== 'string') return [];
    const seen = new Set();
    const out = [];
    for (const rawLine of stdout.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        if (/^fetching\b/i.test(line)) continue;
        const id = line.split('\t')[0].trim();
        if (!MODEL_ID_RE.test(id)) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(id);
    }
    return out;
}

// -----------------------------------------------------------------------------
// runAgyModels — spawn con timeout duro. Resuelve SIEMPRE (nunca rechaza).
// -----------------------------------------------------------------------------
function runAgyModels({ cmd, env, spawnImpl, timeoutMs }) {
    const _spawn = spawnImpl || childProcess.spawn;
    const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    return new Promise((resolve) => {
        let stdout = '';
        let settled = false;
        let timedOut = false;
        let child;
        const done = (result) => {
            if (settled) return;
            settled = true;
            resolve(result);
        };
        try {
            child = _spawn(cmd, ['models'], {
                shell: false,
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
                env,
            });
        } catch {
            return done({ rc: null, stdout: '', timedOut: false, spawnError: true });
        }
        const timer = setTimeout(() => {
            timedOut = true;
            try { child.kill(); } catch { /* best-effort */ }
            // Si `kill` no dispara `close` (Windows con handle colgado), no
            // esperamos: el veredicto ya es "sin respuesta".
            setTimeout(() => done({ rc: null, stdout, timedOut: true, spawnError: false }), 2000).unref();
        }, timeout);
        if (child.stdout) {
            child.stdout.on('data', (d) => {
                if (stdout.length < MAX_STDOUT_BYTES) stdout += String(d);
            });
        }
        // stderr se drena y se descarta: nunca se persiste texto libre del CLI.
        if (child.stderr) child.stderr.on('data', () => {});
        child.on('error', () => {
            clearTimeout(timer);
            done({ rc: null, stdout, timedOut, spawnError: true });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            done({ rc: code, stdout, timedOut, spawnError: false });
        });
    });
}

// -----------------------------------------------------------------------------
// Cache en filesystem
// -----------------------------------------------------------------------------
function readCache(cachePath, fsImpl) {
    try {
        if (!fsImpl.existsSync(cachePath)) return null;
        const parsed = JSON.parse(fsImpl.readFileSync(cachePath, 'utf8'));
        if (!parsed || parsed.version !== CACHE_VERSION || typeof parsed.checked_at_ms !== 'number') return null;
        if (!Object.values(REASON).includes(parsed.reason)) return null;
        return parsed;
    } catch {
        return null;
    }
}

function writeCache(cachePath, data, fsImpl) {
    try {
        const dir = path.dirname(cachePath);
        if (!fsImpl.existsSync(dir)) fsImpl.mkdirSync(dir, { recursive: true });
        const tmp = `${cachePath}.tmp.${process.pid}.${Date.now()}`;
        fsImpl.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
        fsImpl.renameSync(tmp, cachePath);
        return true;
    } catch {
        return false;
    }
}

/**
 * Invalida la cache del probe (best-effort, idempotente). Se llama cuando un
 * spawn real del provider devuelve `authentication_rejected`: la próxima
 * lectura del health vuelve a hacer round-trip aunque el TTL no haya vencido.
 */
function invalidateCache(opts = {}) {
    const fsImpl = opts.fsImpl || fs;
    const cachePath = cachePathFor(opts);
    try {
        if (fsImpl.existsSync(cachePath)) fsImpl.unlinkSync(cachePath);
        return true;
    } catch {
        return false;
    }
}

function fromCache(entry, nowMs) {
    return {
        ok: entry.reason === REASON.OK,
        reason: entry.reason,
        detail: entry.detail || null,
        models: Array.isArray(entry.models) ? entry.models.slice() : [],
        model_count: Array.isArray(entry.models) ? entry.models.length : 0,
        latency_ms: typeof entry.latency_ms === 'number' ? entry.latency_ms : null,
        checked_at: new Date(entry.checked_at_ms).toISOString(),
        age_ms: Math.max(0, nowMs - entry.checked_at_ms),
        cached: true,
        launcher_kind: entry.launcher_kind || null,
    };
}

// -----------------------------------------------------------------------------
// probeAgyCatalog — entrada principal.
//
// @param {object} [opts]
// @param {object}   [opts.env=process.env]
// @param {object}   [opts.fsImpl=fs]
// @param {Function} [opts.spawnImpl]      — inyectable (tests): child_process.spawn-like.
// @param {number}   [opts.timeoutMs=30000]
// @param {number}   [opts.ttlMs=900000]         — TTL de un resultado verde.
// @param {number}   [opts.negativeTtlMs=240000] — TTL de un resultado rojo.
// @param {number}   [opts.nowMs=Date.now()]
// @param {string}   [opts.cachePath]      — default `<stateDir>/agy-catalog-probe.json`.
// @param {string}   [opts.stateDir]
// @param {boolean}  [opts.force=false]    — ignora la cache (ping manual).
// @param {boolean}  [opts.noCache=false]  — no lee ni escribe cache (tests).
// @returns {Promise<{ok:boolean, reason:string, detail:string|null, models:string[],
//           model_count:number, latency_ms:number|null, checked_at:string,
//           age_ms:number, cached:boolean, launcher_kind:string|null}>}
// -----------------------------------------------------------------------------
async function probeAgyCatalog(opts = {}) {
    const env = opts.env || process.env;
    const fsImpl = opts.fsImpl || fs;
    const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
    const ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs >= 0 ? opts.ttlMs : DEFAULT_TTL_MS;
    const negativeTtlMs = Number.isFinite(opts.negativeTtlMs) && opts.negativeTtlMs >= 0
        ? opts.negativeTtlMs
        : Math.min(DEFAULT_NEGATIVE_TTL_MS, ttlMs);
    const useCache = opts.noCache !== true;
    const cachePath = useCache ? cachePathFor(opts) : null;

    // 1. Binario — se resuelve SIEMPRE, sin cache: un `AGY_BIN` roto o un
    //    binario desinstalado tiene que verse en el próximo tick (CA-2).
    const bin = resolveAgyBinary({ env, fsImpl, platform: opts.platform });
    if (!bin.available) {
        const result = {
            ok: false,
            reason: REASON.UNAVAILABLE,
            detail: DETAIL.BINARY_MISSING,
            models: [],
            model_count: 0,
            latency_ms: null,
            checked_at: new Date(nowMs).toISOString(),
            age_ms: 0,
            cached: false,
            launcher_kind: bin.kind,
        };
        // Un binario ausente invalida cualquier verde cacheado.
        if (useCache) invalidateCache({ cachePath, fsImpl });
        return result;
    }

    // 2. Cache vigente → sin round-trip. Sólo si el binario cacheado es el
    //    mismo que resolvimos ahora (cambiar AGY_BIN fuerza re-probe).
    if (useCache && opts.force !== true) {
        const cached = readCache(cachePath, fsImpl);
        const effectiveTtl = cached && cached.reason === REASON.OK ? ttlMs : negativeTtlMs;
        if (cached && cached.cmd === bin.cmd && (nowMs - cached.checked_at_ms) < effectiveTtl) {
            return fromCache(cached, nowMs);
        }
    }

    // 3. Round-trip real.
    const t0 = Date.now();
    const run = await runAgyModels({ cmd: bin.cmd, env, spawnImpl: opts.spawnImpl, timeoutMs: opts.timeoutMs });
    const latency = Date.now() - t0;
    let reason;
    let detail;
    let models = [];
    if (run.spawnError) {
        reason = REASON.LICENSE; detail = DETAIL.SPAWN_ERROR;
    } else if (run.timedOut) {
        reason = REASON.LICENSE; detail = DETAIL.TIMEOUT;
    } else if (run.rc !== 0) {
        reason = REASON.LICENSE; detail = DETAIL.EXIT_NONZERO;
    } else {
        models = parseModelsOutput(run.stdout);
        if (models.length === 0) {
            reason = REASON.LICENSE; detail = DETAIL.EMPTY_CATALOG;
        } else {
            reason = REASON.OK; detail = DETAIL.CATALOG_OK;
        }
    }

    const entry = {
        version: CACHE_VERSION,
        provider: 'gemini-google',
        cmd: bin.cmd,
        launcher_kind: bin.kind,
        reason,
        detail,
        models,
        latency_ms: latency,
        checked_at_ms: nowMs,
    };
    if (useCache) writeCache(cachePath, entry, fsImpl);
    return { ...fromCache(entry, nowMs), cached: false };
}

module.exports = {
    probeAgyCatalog,
    resolveAgyBinary,
    parseModelsOutput,
    invalidateCache,
    cachePathFor,
    CACHE_FILENAME,
    DEFAULT_TTL_MS,
    DEFAULT_NEGATIVE_TTL_MS,
    DEFAULT_TIMEOUT_MS,
    REASON,
    DETAIL,
    // internos, expuestos para tests
    _runAgyModels: runAgyModels,
};

// =============================================================================
// anthropic-usage.js — Lectura del uso REAL del Plan Max de Anthropic (#4597).
//
// PROBLEMA QUE RESUELVE
//   La cuota Anthropic se estimaba sumando `duration_ms` de sesiones
//   (`weekly-quota.js#computeQuota`) + una calibración manual con factor EMA +
//   un snapshot OCR del panel "Uso" de Claude Desktop. Todo frágil: el número
//   oscilaba 51–98% cuando el real era ~62%.
//
// APPROACH (confirmado en vivo, CLI 2.1.204 — ver #4597)
//   `claude -p "/usage"` corre el slash-command CLIENT-SIDE (no consume turno de
//   modelo, lo computa del historial local) y devuelve:
//
//     Current session: 20% used · resets Jul 8, 10pm (America/Buenos_Aires)
//     Current week (all models): 64% used · resets Jul 12, 9pm (America/Buenos_Aires)
//     Current week (Fable): 0% used
//
//   El semanal (all models) coincide con la app de Claude. Es fuente suficiente-
//   mente fiel — no una aproximación descartable.
//
// DISEÑO — el pipeline no puede morir (regla inquebrantable pipeline-dev #1)
//   * NUNCA se spawnea en el hot-path de forma bloqueante. `getUsage()` es
//     síncrono, sólo LEE el cache. Cuando el cache está viejo dispara un refresh
//     ASÍNCRONO fire-and-forget (spawn con timeout + kill), que escribe el cache
//     al terminar. El caller siempre recibe el último valor conocido al instante.
//   * Throttle: no se re-spawnea más seguido que THROTTLE_MS (default 3 min),
//     aunque `getUsage` se llame en cada poll del dashboard/health.
//   * Fallback seguro: si el CLI no responde / el parse falla, el cache no se
//     actualiza; `getUsage` devuelve el último dato marcado como `stale` (o
//     `data:null` si nunca hubo). El adapter degrada a `adapterStatus:'unknown'`
//     — NUNCA congela el pipeline ni presenta un número viejo como fresco.
//   * Sin shell cuando el launcher lo permite (evita el MSYS path-mangling de
//     Git Bash que convertía `/usage` → `C:/Program Files/Git/usage`). Reusa el
//     `detectLauncher()` multi-tier de agent-launcher/providers/anthropic.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

// No re-spawnear más seguido que esto, aunque getUsage se llame en cada poll.
const THROTTLE_MS = 3 * 60 * 1000;
// ≤ FRESH_MS → dato confiable/fresh.
const FRESH_MS = 5 * 60 * 1000;
// > STALE_MS → dato demasiado viejo; el adapter degrada a 'unknown'.
const STALE_MS = 30 * 60 * 1000;
// Corte duro del spawn: /usage es client-side y rápido; si cuelga, lo matamos.
const SPAWN_TIMEOUT_MS = 30 * 1000;
// Cota de stdout para no volar memoria si el CLI escupe basura.
const MAX_STDOUT_BYTES = 1 * 1024 * 1024;

const CACHE_FILE = 'anthropic-usage.json';
const CACHE_SCHEMA = 1;

// Guard en-memoria: evita spawns concurrentes DENTRO del mismo proceso. Entre
// procesos distintos, el throttle por edad del cache serializa de facto.
let _refreshing = false;

function cachePath(metricsDir) {
    return path.join(metricsDir, CACHE_FILE);
}

// -----------------------------------------------------------------------------
// parseUsageOutput — parsea la salida textual de `claude -p /usage`.
//
// Tolerante: line-by-line, insensible a mayúsculas, ignora códigos ANSI. Sólo
// mira "Current session" y "Current week (all models)" — el bucket por-modelo
// (Fable) se ignora a propósito (el operador razona sobre el agregado).
//
// @param {string} text
// @returns {{sessionPct:number|null, weeklyPct:number|null,
//            sessionResetsRaw:string|null, weeklyResetsRaw:string|null}|null}
//          null si no se pudo extraer NINGÚN porcentaje.
// -----------------------------------------------------------------------------
function parseUsageOutput(text) {
    if (typeof text !== 'string' || text.length === 0) return null;
    // Quitar secuencias de escape ANSI (colores/cursor) que ensucian el parse.
    const clean = text.replace(/\x1B\[[0-9;?]*[A-Za-z]/g, '');
    const out = {
        sessionPct: null,
        weeklyPct: null,
        sessionResetsRaw: null,
        weeklyResetsRaw: null,
    };
    for (const rawLine of clean.split(/\r?\n/)) {
        const line = rawLine.trim();
        let m;
        if ((m = line.match(/Current session:\s*(\d+(?:\.\d+)?)\s*%\s*used/i))) {
            out.sessionPct = Number(m[1]);
            const r = line.match(/resets?\s+(.+)$/i);
            if (r) out.sessionResetsRaw = r[1].trim();
        } else if ((m = line.match(/Current week\s*\(all models\):\s*(\d+(?:\.\d+)?)\s*%\s*used/i))) {
            out.weeklyPct = Number(m[1]);
            const r = line.match(/resets?\s+(.+)$/i);
            if (r) out.weeklyResetsRaw = r[1].trim();
        }
    }
    if (out.sessionPct === null && out.weeklyPct === null) return null;
    return out;
}

// -----------------------------------------------------------------------------
// parseResetToIso — best-effort de "Jul 12, 9pm (America/Buenos_Aires)" → ISO.
//
// El texto de /usage no trae año y la TZ va entre paréntesis; el parse es
// imperfecto por diseño. Devolvemos ISO cuando Date lo entiende, sino null (el
// raw se conserva aparte). NO es dato crítico — los resets son informativos.
// -----------------------------------------------------------------------------
function parseResetToIso(raw, refMs) {
    if (typeof raw !== 'string' || raw.length === 0) return null;
    // Descartar el paréntesis de TZ (no interpretable por Date sin libs).
    const noTz = raw.replace(/\s*\([^)]*\)\s*$/, '').trim();
    if (!noTz) return null;
    const ref = Number.isFinite(refMs) ? new Date(refMs) : new Date();
    const year = ref.getUTCFullYear();
    // Date.parse necesita un espacio antes de am/pm: "8:59pm" → "8:59 pm".
    const spaced = noTz.replace(/(\d)\s*(am|pm)\b/i, '$1 $2');
    // "Jul 12, 8:59 pm" → "Jul 12, 2026 8:59 pm"
    const withYear = spaced.replace(/,/, `, ${year}`);
    let ts = Date.parse(withYear);
    if (!Number.isFinite(ts)) ts = Date.parse(spaced);
    if (!Number.isFinite(ts)) return null;
    return new Date(ts).toISOString();
}

// -----------------------------------------------------------------------------
// Cache read/write — .pipeline/metrics/anthropic-usage.json
// -----------------------------------------------------------------------------
function readCache(metricsDir) {
    try {
        const raw = fs.readFileSync(cachePath(metricsDir), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && Number.isFinite(parsed.capturedAtMs)) {
            return parsed;
        }
        return null;
    } catch {
        return null;
    }
}

function writeCache(metricsDir, parsed, nowMs) {
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const data = {
        schema: CACHE_SCHEMA,
        source: 'claude -p /usage',
        capturedAt: new Date(now).toISOString(),
        capturedAtMs: now,
        sessionPct: Number.isFinite(parsed.sessionPct) ? parsed.sessionPct : null,
        weeklyPct: Number.isFinite(parsed.weeklyPct) ? parsed.weeklyPct : null,
        sessionResetsRaw: parsed.sessionResetsRaw || null,
        weeklyResetsRaw: parsed.weeklyResetsRaw || null,
        sessionResetsAt: parseResetToIso(parsed.sessionResetsRaw, now),
        weeklyResetsAt: parseResetToIso(parsed.weeklyResetsRaw, now),
    };
    try {
        fs.mkdirSync(metricsDir, { recursive: true });
        fs.writeFileSync(cachePath(metricsDir), JSON.stringify(data, null, 2));
    } catch { /* best-effort: si no se puede escribir, el próximo tick reintenta */ }
    return data;
}

// -----------------------------------------------------------------------------
// resolveLauncher — reusa la detección multi-tier del provider anthropic para
// spawnear el mismo binario de Claude Code que usa el resto del pipeline.
// -----------------------------------------------------------------------------
function resolveLauncher() {
    try {
        const prov = require('./agent-launcher/providers/anthropic');
        if (prov && typeof prov.detectLauncher === 'function') {
            const l = prov.detectLauncher();
            if (l && l.cmd) return l;
        }
    } catch { /* cae al fallback de abajo */ }
    return { cmd: process.env.CLAUDE_BIN || 'claude', prefixArgs: [], shell: true };
}

// -----------------------------------------------------------------------------
// triggerRefreshAsync — spawn fire-and-forget de `claude -p /usage`.
//
// NUNCA bloquea ni lanza. Guarda contra spawns concurrentes con `_refreshing`.
// Al cerrar el proceso, parsea stdout y (si hubo dato) reescribe el cache.
//
// @param {object} opts { metricsDir, spawnImpl?, launcher?, env? }
// -----------------------------------------------------------------------------
function triggerRefreshAsync(opts) {
    if (_refreshing) return;
    const metricsDir = opts && opts.metricsDir;
    if (typeof metricsDir !== 'string' || metricsDir.length === 0) return;

    const spawnImpl = (opts && opts.spawnImpl)
        || require('child_process').spawn;
    const launcher = (opts && opts.launcher) || resolveLauncher();

    _refreshing = true;
    let done = false;
    const finish = () => { if (!done) { done = true; _refreshing = false; } };

    let child;
    try {
        child = spawnImpl(launcher.cmd, [...launcher.prefixArgs, '-p', '/usage'], {
            shell: !!launcher.shell,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: (opts && opts.env) || process.env,
        });
    } catch {
        finish();
        return;
    }
    if (!child || typeof child.on !== 'function') { finish(); return; }

    let stdout = '';
    const timer = setTimeout(() => {
        try { child.kill(); } catch { /* noop */ }
        finish();
    }, SPAWN_TIMEOUT_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();

    if (child.stdout && typeof child.stdout.on === 'function') {
        child.stdout.on('data', (d) => {
            stdout += d.toString();
            if (stdout.length > MAX_STDOUT_BYTES) {
                try { child.kill(); } catch { /* noop */ }
            }
        });
    }
    child.on('error', () => { clearTimeout(timer); finish(); });
    child.on('close', () => {
        clearTimeout(timer);
        const parsed = parseUsageOutput(stdout);
        if (parsed) writeCache(metricsDir, parsed);
        finish();
    });
}

// -----------------------------------------------------------------------------
// getUsage — API pública SÍNCRONA que consume el adapter. Sólo LEE el cache;
// dispara refresh async si está viejo (throttle). Nunca bloquea ni lanza.
//
// @param {object} opts
//   @property {string}  metricsDir       path a .pipeline/metrics (requerido)
//   @property {number}  [now]            reloj override (tests)
//   @property {boolean} [autoRefresh]    default FALSE — getUsage sólo LEE. El
//                                        refresh lo dispara el poller del
//                                        dashboard (triggerRefreshAsync). Pasar
//                                        true sólo si un caller quiere refrescar.
//   @property {function}[spawnImpl]      inyección de child_process.spawn (tests)
//   @property {object}  [launcher]       launcher override (tests)
// @returns {{data:object|null, ageMs:number|null, fresh:boolean, stale:boolean,
//            reason?:string}}
// -----------------------------------------------------------------------------
function getUsage(opts) {
    opts = opts || {};
    const metricsDir = opts.metricsDir;
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();

    if (typeof metricsDir !== 'string' || metricsDir.length === 0) {
        return { data: null, ageMs: null, fresh: false, stale: true, reason: 'metricsDir requerido' };
    }

    const cache = readCache(metricsDir);
    const ageMs = cache ? (now - cache.capturedAtMs) : null;
    const needsRefresh = !cache || ageMs >= THROTTLE_MS || ageMs < 0;

    // getUsage sólo LEE por default (nunca spawnea en el hot path del dashboard/
    // health/tests). El refresh lo dispara el poller del dashboard llamando
    // triggerRefreshAsync. `autoRefresh: true` es opt-in explícito.
    if (needsRefresh && opts.autoRefresh === true) {
        try { triggerRefreshAsync(opts); } catch { /* best-effort */ }
    }

    if (!cache) {
        return { data: null, ageMs: null, fresh: false, stale: true, reason: 'sin snapshot de /usage todavía' };
    }
    return {
        data: cache,
        ageMs,
        fresh: ageMs >= 0 && ageMs <= FRESH_MS,
        stale: ageMs > STALE_MS || ageMs < 0,
    };
}

// Para tests: resetea el guard en-memoria entre casos.
function _resetRefreshingForTesting() { _refreshing = false; }

module.exports = {
    getUsage,
    parseUsageOutput,
    parseResetToIso,
    readCache,
    writeCache,
    triggerRefreshAsync,
    resolveLauncher,
    _resetRefreshingForTesting,
    // Constantes expuestas para tests/consumidores.
    THROTTLE_MS,
    FRESH_MS,
    STALE_MS,
    SPAWN_TIMEOUT_MS,
    CACHE_FILE,
};

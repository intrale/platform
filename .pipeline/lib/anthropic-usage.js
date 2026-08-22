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
// imperfecto por diseño. Devolvemos ISO cuando el texto es interpretable, sino
// null (el raw se conserva aparte).
//
// #5455 — ESTE ES EL ÚNICO PARSER DE RESET del pipeline. El detector del canal
// de contenido de Anthropic (`quota-exhausted.js`) delega acá en vez de crear un
// segundo parser: el aviso semanal trae el reset en los mismos formatos que
// `/usage`. Antes de #5455 el helper devolvía `null` para los dos formatos
// reales observados —hora sola ("9pm") y mes/día sin minutos ("Aug 9, 9pm")—
// porque `Date.parse` no los entiende; por eso se agregan dos paths
// estructurados ANTES del fallback legacy:
//
//   1. MES/DÍA (+ hora opcional): "Aug 9, 9pm", "Jul 12, 8:59pm". El texto no
//      trae año → se asume el del reloj de referencia y, si la fecha ya pasó,
//      se elige la próxima ocurrencia (año siguiente). Cubre el wrap Dic→Ene.
//   2. HORA SOLA: "9pm", "21:00". Se resuelve sobre el día del reloj de
//      referencia y, si esa hora YA PASÓ, rollover al día siguiente (CA: "elige
//      la próxima ocurrencia").
//
// El reloj es inyectable vía `refMs` (tests determinísticos). Toda entrada no
// interpretable devuelve `null` — NUNCA se inventa una fecha. Aguas abajo,
// `setFlag`/`capResetsAt` clampean igual el TTL efectivo, así que un reset
// textual jamás prolonga un gate por sí solo.
//
// La TZ entre paréntesis se descarta y el cálculo queda en hora local, igual
// que antes de #5455 (parse imperfecto por diseño, sin libs de timezone).
// -----------------------------------------------------------------------------
const _MONTH_INDEX = Object.freeze({
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
});

// Cuantificadores acotados en ambos regex (defensa ReDoS): el input puede venir
// del canal de contenido del modelo vía #5455.
const _TIME_ONLY_RE = /^(\d{1,2})(?::(\d{2}))?\s{0,2}(am|pm)?$/i;
const _MONTH_DAY_RE = /^([a-z]{3,9})\.?\s{1,2}(\d{1,2})\s{0,2},?\s{0,2}(.{0,20})$/i;

const _DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Normaliza hora + meridiano a hora 24h. Devuelve null si es inválida.
 */
function _toHour24(hourRaw, meridiem) {
    const h = Number(hourRaw);
    if (!Number.isInteger(h)) return null;
    if (meridiem) {
        if (h < 1 || h > 12) return null;
        return (h % 12) + (meridiem.toLowerCase() === 'pm' ? 12 : 0);
    }
    return h >= 0 && h <= 23 ? h : null;
}

/**
 * Parsea "9pm" / "8:59 pm" / "21:00" → { hour, minute } o null.
 * `requireQualifier` exige minutos o meridiano, para que un número suelto
 * ("9") NO se interprete como hora (fail-closed).
 */
function _parseTimeOfDay(text, requireQualifier) {
    const m = _TIME_ONLY_RE.exec(String(text).trim());
    if (!m) return null;
    if (requireQualifier && !m[2] && !m[3]) return null;
    const hour = _toHour24(m[1], m[3]);
    if (hour === null) return null;
    const minute = m[2] ? Number(m[2]) : 0;
    if (!Number.isInteger(minute) || minute > 59) return null;
    return { hour, minute };
}

/**
 * #5455 — ¿El texto contiene un token de mes conocido ("jul", "august", …)?
 *
 * Guarda de entrada del fallback legacy `Date.parse` (ver más abajo). Recorre
 * sólo secuencias alfabéticas de 3+ letras y compara su prefijo de 3 contra
 * `_MONTH_INDEX`. Cuantificador acotado: el input puede venir del canal de
 * contenido del modelo.
 */
function _hasKnownMonthToken(text) {
    const tokens = String(text).match(/[a-z]{3,9}/gi);
    if (!tokens) return false;
    return tokens.some((t) => _MONTH_INDEX[t.slice(0, 3).toLowerCase()] !== undefined);
}

function parseResetToIso(raw, refMs) {
    if (typeof raw !== 'string' || raw.length === 0) return null;
    // Descartar el paréntesis de TZ (no interpretable por Date sin libs).
    const noTz = raw.replace(/\s*\([^)]*\)\s*$/, '').trim();
    if (!noTz) return null;
    // Tolerar el prefijo "resets " del texto crudo (CLI y /usage lo anteponen).
    const body = noTz.replace(/^resets?\s+/i, '').trim();
    if (!body) return null;
    const ref = Number.isFinite(refMs) ? new Date(refMs) : new Date();
    const refTs = ref.getTime();
    if (!Number.isFinite(refTs)) return null;

    // 1. Mes/día explícito (+ hora opcional).
    const md = _MONTH_DAY_RE.exec(body);
    if (md) {
        const month = _MONTH_INDEX[md[1].slice(0, 3).toLowerCase()];
        const day = Number(md[2]);
        const tail = md[3] ? md[3].trim() : '';
        if (month !== undefined && Number.isInteger(day) && day >= 1 && day <= 31) {
            // Sin hora → medianoche; con hora → debe parsear o el input es inválido.
            const time = tail ? _parseTimeOfDay(tail, false) : { hour: 0, minute: 0 };
            if (time) {
                const build = (y) => new Date(y, month, day, time.hour, time.minute, 0, 0);
                let d = build(ref.getFullYear());
                // Rechazar días que no existen en el mes ("Feb 31" → marzo).
                if (d.getMonth() === month && d.getDate() === day) {
                    if (d.getTime() < refTs) {
                        const next = build(ref.getFullYear() + 1);
                        if (next.getMonth() === month && next.getDate() === day) d = next;
                    }
                    return new Date(d.getTime()).toISOString();
                }
                return null;
            }
            return null;
        }
    }

    // 2. Hora sola → próxima ocurrencia (rollover al día siguiente si ya pasó).
    const timeOnly = _parseTimeOfDay(body, true);
    if (timeOnly) {
        let d = new Date(
            ref.getFullYear(), ref.getMonth(), ref.getDate(),
            timeOnly.hour, timeOnly.minute, 0, 0,
        );
        if (d.getTime() <= refTs) d = new Date(d.getTime() + _DAY_MS);
        return d.toISOString();
    }

    // 3. Fallback legacy: delegar en Date.parse para shapes no contemplados.
    //
    // #5455 — GUARDA DE ENTRADA. `Date.parse` es extremadamente permisivo con
    // tokens numéricos sueltos y los resuelve a fechas PASADAS e inventadas:
    //   "9" → 2001-09-01 · "2020" → 2020-01-01 · "9 9" → 2001-09-09
    // Antes de #5455 esto sólo veía texto de `/usage` (siempre con mes), pero
    // ahora el helper también recibe el reset capturado del canal de CONTENIDO,
    // que es controlable por el modelo: un aviso truncado como
    // "...· resets 9" produciría un `resetsAt` en el pasado y, tras el clamp de
    // `capResetsAt`, un gate de 5 minutos en vez del gate corto esperado.
    // El CA exige `null` ante un reset inválido, sin inventar fecha.
    //
    // Los dos formatos REALES ya los resuelven los paths estructurados de
    // arriba, así que este fallback queda sólo para variantes con nombre de mes
    // que `Date.parse` sepa interpretar. Exigimos entonces un token de mes
    // conocido y fallamos cerrado ante cualquier otra cosa; un input sin mes no
    // es un formato de reset de Anthropic, es ruido.
    if (!_hasKnownMonthToken(body)) return null;
    const year = ref.getUTCFullYear();
    // Date.parse necesita un espacio antes de am/pm: "8:59pm" → "8:59 pm".
    const spaced = body.replace(/(\d)\s*(am|pm)\b/i, '$1 $2');
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
// @param {object} opts { metricsDir, spawnImpl?, launcher?, env?, onDone? }
//   @property {function} [onDone]  callback opcional invocado 1 vez al terminar
//                                  el refresh (para esperar el fin de forma
//                                  determinística en tests). Best-effort.
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
    // onDone: callback opcional de completitud (tests). Se invoca exactamente
    // una vez al terminar el refresh (close/error/timeout/spawn-throw), después
    // de haber (o no) reescrito el cache. Permite esperar el fin de forma
    // determinística en vez de un setTimeout fijo. NUNCA lanza hacia afuera.
    const onDone = (opts && typeof opts.onDone === 'function') ? opts.onDone : null;
    const finish = () => {
        if (done) return;
        done = true;
        _refreshing = false;
        if (onDone) { try { onDone(); } catch { /* best-effort */ } }
    };

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

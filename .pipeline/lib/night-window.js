// =============================================================================
// night-window.js — Ventana nocturna de presión de recursos (#4051).
//
// Problema que resuelve:
//   Durante la ventana de inactividad de Anthropic (22:00–07:00) el trabajo cae
//   a la cadena de respaldo (Codex / free tiers), de menor throughput. Si encima
//   la RAM baseline nocturna (70–77%) clava el gate de presión del Pulpo en
//   ORANGE, el techo de 1 agente total deja al pipeline avanzando a ~0,67
//   agentes promedio. Este helper detecta la franja nocturna para que el Pulpo
//   aplique umbrales relajados + un piso de concurrencia garantizado.
//
// Responsabilidad ÚNICA:
//   - `isNightWindow(now, cfg)` — predicado puro que dice si `now` cae dentro de
//     la franja nocturna definida por `cfg` ({start, end, timezone, enabled}),
//     con manejo de cruce de medianoche (22:00 → 07:00) y timezone vía
//     `Intl.DateTimeFormat`.
//
// Lo que este módulo NO hace (a propósito, para no acoplar):
//   - NO lee ni escribe `.pipeline/rest-mode.json` ni su `schedule`. La ventana
//     nocturna de presión es un mecanismo NUEVO e INDEPENDIENTE del modo
//     descanso (`rest_mode`), que corre 24/7 con schedule vacío.
//   - NO tiene side effects: es una función pura sobre (now, cfg).
//
// Filosofía (igual que rest-mode-window.js):
//   - Fail-open a "no es ventana nocturna" ante cualquier error (timezone
//     inválida, cfg corrupto). NUNCA tira: una excepción acá no debe alterar
//     el gate de recursos del Pulpo. Si el helper falla, el caller mantiene
//     los umbrales diurnos.
// =============================================================================

'use strict';

// Validación HH:MM 24h (00:00 → 23:59). Espejo de rest-mode-window.js.
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const DEFAULT_TIMEZONE = 'America/Argentina/Buenos_Aires';

/**
 * Convierte 'HH:MM' a minutos desde medianoche. Devuelve NaN si el formato es
 * inválido (el caller decide qué hacer; isNightWindow fail-open a false).
 */
function hhmmToMinutes(hhmm) {
    if (typeof hhmm !== 'string' || !HHMM_RE.test(hhmm)) return NaN;
    const [h, m] = hhmm.split(':').map(n => parseInt(n, 10));
    return h * 60 + m;
}

/**
 * Verifica que una timezone sea aceptada por `Intl.DateTimeFormat`. Cubre
 * nombres canónicos (`America/Buenos_Aires`) y alias IANA históricos
 * (`America/Argentina/Buenos_Aires`, `UTC`). Strings random → false.
 */
function timezoneIsSupported(tz) {
    if (typeof tz !== 'string' || !tz) return false;
    try {
        if (typeof Intl.supportedValuesOf === 'function') {
            const list = Intl.supportedValuesOf('timeZone');
            if (Array.isArray(list) && list.indexOf(tz) >= 0) return true;
        }
    } catch (e) { /* ignore — fallback abajo */ }
    try {
        // eslint-disable-next-line no-new
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Devuelve 'HH:MM' del instante `now` en la timezone `tz`. Usa
 * `Intl.DateTimeFormat` (no offset fijo) para respetar DST automáticamente.
 *
 * @param {number|Date} now
 * @param {string} tz
 * @returns {string} 'HH:MM' (ej. '23:14')
 */
function nowHHMMInTz(now, tz) {
    const d = (now instanceof Date) ? now
        : (typeof now === 'number' ? new Date(now) : new Date());
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).formatToParts(d);
    const map = Object.create(null);
    for (const p of parts) map[p.type] = p.value;
    let hour = parseInt(map.hour, 10);
    if (hour === 24) hour = 0; // algunos motores devuelven '24' para medianoche
    const minute = parseInt(map.minute, 10);
    const hh = String(hour).padStart(2, '0');
    const mm = String(minute).padStart(2, '0');
    return `${hh}:${mm}`;
}

/**
 * ¿El instante `now` cae dentro de la ventana nocturna definida por `cfg`?
 *
 * @param {number|Date} now  — instante a evaluar (default: ahora).
 * @param {object} cfg       — sub-bloque `night_window` de resource_limits:
 *   @param {boolean} [cfg.enabled]  — si es `false`, siempre devuelve false.
 *   @param {string}  cfg.start      — 'HH:MM' inicio (ej. '22:00').
 *   @param {string}  cfg.end        — 'HH:MM' fin (ej. '07:00').
 *   @param {string}  [cfg.timezone] — IANA tz (default Buenos Aires).
 *
 * @returns {boolean}
 *   - false si cfg es falsy, `enabled === false`, start/end mal formados, o la
 *     timezone no es soportada (fail-open).
 *   - true si la hora actual en la tz cae en [start, end) considerando el
 *     cruce de medianoche (start > end → [start, 1440) ∪ [0, end)).
 *
 * Semántica de bordes (consistente con el gate de presión): el inicio es
 * inclusivo y el fin exclusivo. Con start='22:00'/end='07:00':
 *   21:59 → false, 22:00 → true, 03:00 → true, 06:59 → true, 07:00 → false.
 */
function isNightWindow(now, cfg) {
    try {
        if (!cfg || typeof cfg !== 'object') return false;
        if (cfg.enabled === false) return false;

        const tz = (typeof cfg.timezone === 'string' && cfg.timezone)
            ? cfg.timezone : DEFAULT_TIMEZONE;
        if (!timezoneIsSupported(tz)) return false; // fail-open

        const startMin = hhmmToMinutes(cfg.start);
        const endMin = hhmmToMinutes(cfg.end);
        if (Number.isNaN(startMin) || Number.isNaN(endMin)) return false;
        if (startMin === endMin) return false; // ventana degenerada → desactivada

        const cur = hhmmToMinutes(nowHHMMInTz(now, tz));
        if (Number.isNaN(cur)) return false;

        return startMin < endMin
            ? (cur >= startMin && cur < endMin)   // mismo día
            : (cur >= startMin || cur < endMin);  // cruza medianoche (22→07)
    } catch (e) {
        return false; // fail-open: nunca alterar el gate por un error acá
    }
}

module.exports = {
    isNightWindow,
    DEFAULT_TIMEZONE,
    HHMM_RE,
    // Exportados para tests:
    __forTestsOnly__: {
        hhmmToMinutes,
        nowHHMMInTz,
        timezoneIsSupported,
    },
};

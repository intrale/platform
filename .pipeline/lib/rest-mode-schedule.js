// =============================================================================
// rest-mode-schedule.js — Validación del schema semanal del modo descanso (#3230).
//
// Hija frontend #3242: este módulo expone la lógica de validación del nuevo
// schema con N periodos por día. Está pensado para ser usado tanto por el
// backend (hija #3241, source of truth de la validación — SEC-9) como por el
// cliente del dashboard (UX, para evitar 400 round-trips cosméticos).
//
// Schema del payload:
//   schedule: {
//     monday:    [{start: 'HH:MM', end: 'HH:MM'}, ...],
//     tuesday:   [...],
//     wednesday: [...],
//     thursday:  [...],
//     friday:    [...],
//     saturday:  [...],
//     sunday:    [...],
//   }
//
// Reglas de validación:
//   - SEC-1 · allow-list de keys del día con Object.freeze (anti-prototype-pollution).
//   - SEC-2 · cap 24 periodos/día.
//   - SEC-3 · overlap cross-midnight con intervalos absolutos en minutos
//             relativos al "ancla" del día (lunes 00:00 = minuto 0, etc.).
//   - SEC-4 · start === end inválido salvo "día completo" (00:00 → 23:59).
//   - SEC-9 · validación cliente es UX, el backend revalida igual.
//
// Hay un nivel de complejidad extra: un periodo cross-midnight (start > end) en
// día N también ocupa el rango [00:00, end) del día N+1. Para detectar
// solapamientos entre días distintos, el algoritmo expande cada periodo a su
// intervalo absoluto en la semana (minuto 0 = lunes 00:00, total 7×1440 minutos).
//
// El módulo NUNCA tira: errores se reportan en `errors[]`.
// =============================================================================

'use strict';

// CA-Sec-A03 mantenida: las keys del día son una allow-list congelada.
const DAY_KEYS = Object.freeze(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']);

// Mapeo de las keys del schedule al Date.getDay() (0=domingo, 1=lunes, ...).
const DAY_KEY_TO_DOW = Object.freeze({
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
});

const DOW_TO_DAY_KEY = Object.freeze(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']);

// SEC-2: cap defensivo de 24 periodos/día.
const MAX_PERIODS_PER_DAY = 24;

// HH:MM 24h (00:00 → 23:59).
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// "Día completo" — única excepción permitida para start === end (CA-Sec-A04/SEC-4).
const FULL_DAY_START = '00:00';
const FULL_DAY_END = '23:59';

const MIN_PER_DAY = 24 * 60;
const MIN_PER_WEEK = 7 * MIN_PER_DAY;

/**
 * Parsea HH:MM a minutos del día (0..1439). Devuelve null si no matchea.
 */
function hhmmToMin(hhmm) {
    if (typeof hhmm !== 'string' || !HHMM_RE.test(hhmm)) return null;
    const [h, m] = hhmm.split(':').map(n => parseInt(n, 10));
    return h * 60 + m;
}

/**
 * Inverso de hhmmToMin (para mensajes de error). Acepta minutos 0..1439.
 */
function minToHhmm(min) {
    const m = ((Math.floor(min) % MIN_PER_DAY) + MIN_PER_DAY) % MIN_PER_DAY;
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return String(h).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}

/**
 * ¿Este periodo es "día completo" (00:00 → 23:59)?
 */
function isFullDay(period) {
    return period && period.start === FULL_DAY_START && period.end === FULL_DAY_END;
}

/**
 * ¿Este periodo cruza medianoche? Asume periodo bien-formado (start/end válidos).
 * Día completo (00:00 → 23:59) NO es cross-midnight (queda intra-día).
 */
function crossesMidnight(period) {
    if (isFullDay(period)) return false;
    const s = hhmmToMin(period.start);
    const e = hhmmToMin(period.end);
    return s !== null && e !== null && s > e;
}

/**
 * Expande un periodo al intervalo absoluto en la semana (minuto 0 = lunes 00:00).
 * Devuelve un array con 1 ó 2 intervalos [{ startAbs, endAbs }, ...].
 *
 * Convención: usamos `endAbs` exclusivo (half-open). Esto simplifica el
 * solapamiento: dos intervalos solapan si `a.startAbs < b.endAbs && b.startAbs < a.endAbs`.
 *
 * Día completo (00:00 → 23:59): tratado como [00:00, 24:00) — ocupa el día
 * entero sin tocar el siguiente.
 *
 * Cross-midnight (start > end): se parte en [start, 24:00) del día N y
 * [00:00, end) del día N+1.
 */
function expandPeriod(dayKey, period) {
    const dow = DAY_KEY_TO_DOW[dayKey];
    if (dow == null) return [];
    // En el espacio absoluto usamos lunes como minuto 0, luego sábado y
    // por último domingo. Esto es solo una convención interna; el wrap
    // domingo→lunes se maneja con módulo MIN_PER_WEEK.
    const dowAbsBase = ((dow + 6) % 7) * MIN_PER_DAY; // lunes=0, mar=1440, ..., dom=8640
    const sMin = hhmmToMin(period.start);
    const eMin = hhmmToMin(period.end);
    if (sMin === null || eMin === null) return [];
    if (isFullDay(period)) {
        return [{ startAbs: dowAbsBase, endAbs: dowAbsBase + MIN_PER_DAY }];
    }
    if (sMin < eMin) {
        // Intra-día normal.
        return [{ startAbs: dowAbsBase + sMin, endAbs: dowAbsBase + eMin }];
    }
    // Cross-midnight: parte 1 = [start, 24:00) del día actual,
    //                 parte 2 = [00:00, end) del día siguiente (con wrap semanal).
    const part1Start = dowAbsBase + sMin;
    const part1End = dowAbsBase + MIN_PER_DAY;
    const part2Start = (dowAbsBase + MIN_PER_DAY) % MIN_PER_WEEK;
    const part2End = part2Start + eMin;
    return [
        { startAbs: part1Start, endAbs: part1End },
        { startAbs: part2Start, endAbs: part2End },
    ];
}

/**
 * ¿Dos intervalos absolutos (half-open) solapan? Maneja wrap semanal.
 */
function intervalsOverlap(a, b) {
    // Caso sin wrap: comparación standard half-open.
    if (a.endAbs <= MIN_PER_WEEK && b.endAbs <= MIN_PER_WEEK) {
        return a.startAbs < b.endAbs && b.startAbs < a.endAbs;
    }
    // Si alguno cruza el wrap semanal (domingo→lunes), lo dividimos.
    const split = (iv) => {
        if (iv.endAbs <= MIN_PER_WEEK) return [iv];
        return [
            { startAbs: iv.startAbs, endAbs: MIN_PER_WEEK },
            { startAbs: 0, endAbs: iv.endAbs - MIN_PER_WEEK },
        ];
    };
    const as = split(a);
    const bs = split(b);
    for (const ai of as) {
        for (const bi of bs) {
            if (ai.startAbs < bi.endAbs && bi.startAbs < ai.endAbs) return true;
        }
    }
    return false;
}

/**
 * Valida un único periodo. Devuelve `{ ok, errors }`. NO chequea overlap (es
 * por-día/semanal y se hace en validateSchedule).
 */
function validatePeriod(period, context) {
    const errors = [];
    const ctx = context || '';
    if (!period || typeof period !== 'object') {
        errors.push(ctx + 'periodo no es un objeto');
        return { ok: false, errors };
    }
    if (typeof period.start !== 'string' || !HHMM_RE.test(period.start)) {
        errors.push(ctx + 'start invalido (HH:MM 00:00-23:59)');
    }
    if (typeof period.end !== 'string' || !HHMM_RE.test(period.end)) {
        errors.push(ctx + 'end invalido (HH:MM 00:00-23:59)');
    }
    if (errors.length === 0) {
        // SEC-4: start === end solo es válido como "día completo".
        if (period.start === period.end && !isFullDay(period)) {
            errors.push(ctx + 'start === end solo es valido como dia completo (00:00 -> 23:59)');
        }
    }
    return { ok: errors.length === 0, errors };
}

/**
 * Valida el schedule completo. Devuelve `{ ok, errors, normalized }`.
 *
 * `normalized.schedule` es un objeto con todas las DAY_KEYS presentes
 * (días sin periodos se devuelven como `[]`), y los periodos quedan
 * ordenados por `start` para facilitar el render.
 *
 * `errors` es un array de strings legibles, prefijados por día/índice.
 * NUNCA tira.
 */
function validateSchedule(schedule) {
    const errors = [];
    const normalized = { schedule: {} };

    if (schedule == null || typeof schedule !== 'object') {
        errors.push('schedule no es un objeto');
        return { ok: false, errors, normalized: null };
    }

    // Inicializar todas las keys del día.
    for (const k of DAY_KEYS) normalized.schedule[k] = [];

    // SEC-1: solo iterar sobre las keys conocidas; ignorar el resto.
    for (const day of DAY_KEYS) {
        const raw = schedule[day];
        if (raw === undefined || raw === null) continue;
        if (!Array.isArray(raw)) {
            errors.push(`${day}: debe ser un array de periodos`);
            continue;
        }
        // SEC-2: cap.
        if (raw.length > MAX_PERIODS_PER_DAY) {
            errors.push(`${day}: maximo ${MAX_PERIODS_PER_DAY} periodos por dia (recibidos ${raw.length})`);
        }
        // Validar cada periodo.
        const cleaned = [];
        for (let i = 0; i < raw.length; i++) {
            const p = raw[i];
            const v = validatePeriod(p, `${day}[${i}]: `);
            if (!v.ok) {
                for (const err of v.errors) errors.push(err);
                continue;
            }
            cleaned.push({ start: p.start, end: p.end });
        }
        // Orden estable por start para renders predecibles.
        cleaned.sort((a, b) => {
            const am = hhmmToMin(a.start);
            const bm = hhmmToMin(b.start);
            return am - bm;
        });
        normalized.schedule[day] = cleaned;
    }

    // SEC-3: overlap absoluto en la semana. Expandimos cada periodo a sus
    // intervalos absolutos y los comparamos todos contra todos. O(N^2) está
    // bien porque N <= 7×24 = 168.
    const expanded = [];
    for (const day of DAY_KEYS) {
        const periods = normalized.schedule[day] || [];
        for (let i = 0; i < periods.length; i++) {
            const ivs = expandPeriod(day, periods[i]);
            for (const iv of ivs) {
                expanded.push({ day, idx: i, period: periods[i], iv });
            }
        }
    }

    // Comparar pares; reportar overlap solo una vez por par.
    const seen = new Set();
    for (let i = 0; i < expanded.length; i++) {
        for (let j = i + 1; j < expanded.length; j++) {
            const a = expanded[i];
            const b = expanded[j];
            if (a.day === b.day && a.idx === b.idx) continue;
            if (intervalsOverlap(a.iv, b.iv)) {
                const key = a.day + ':' + a.idx + '<->' + b.day + ':' + b.idx;
                const keyRev = b.day + ':' + b.idx + '<->' + a.day + ':' + a.idx;
                if (seen.has(key) || seen.has(keyRev)) continue;
                seen.add(key);
                if (a.day === b.day) {
                    errors.push(`${a.day}: solapamiento entre ${a.period.start}-${a.period.end} y ${b.period.start}-${b.period.end}`);
                } else {
                    // Cross-midnight overlap: el operador necesita ver los dos lados.
                    errors.push(`${a.day} ${a.period.start}-${a.period.end} solapa con ${b.day} ${b.period.start}-${b.period.end} (cruza medianoche)`);
                }
            }
        }
    }

    if (errors.length > 0) {
        return { ok: false, errors, normalized: null };
    }
    return { ok: true, errors: [], normalized };
}

/**
 * Resuelve el periodo activo "ahora" del schedule (si lo hay). Devuelve
 * `{day, period, end}` con `end` siendo la hora HH:MM en la que termina
 * (cross-midnight devuelve la hora del día siguiente sin reescribirla).
 *
 * `nowParts` debe traer `{hour, minute, weekday}` con weekday 0=domingo
 * (mismo formato que `Date.getDay()` y que `partsInTz` del módulo window).
 *
 * Si ningún periodo aplica, devuelve null.
 */
function getCurrentPeriod(schedule, nowParts) {
    if (!schedule || !nowParts) return null;
    const nowMin = nowParts.hour * 60 + nowParts.minute;
    const nowWeekday = nowParts.weekday;
    const todayKey = DOW_TO_DAY_KEY[nowWeekday];
    const yesterdayKey = DOW_TO_DAY_KEY[(nowWeekday + 6) % 7];

    // 1. Periodos intra-día del día actual.
    const todayPeriods = Array.isArray(schedule[todayKey]) ? schedule[todayKey] : [];
    for (const p of todayPeriods) {
        const s = hhmmToMin(p.start);
        const e = hhmmToMin(p.end);
        if (s === null || e === null) continue;
        if (isFullDay(p)) return { day: todayKey, period: p };
        if (s < e && nowMin >= s && nowMin < e) return { day: todayKey, period: p };
        // Cross-midnight del día actual: nowMin >= start (mitad nocturna).
        if (s > e && nowMin >= s) return { day: todayKey, period: p };
    }

    // 2. Cross-midnight del día anterior: nowMin < end (mitad matinal).
    const yesterdayPeriods = Array.isArray(schedule[yesterdayKey]) ? schedule[yesterdayKey] : [];
    for (const p of yesterdayPeriods) {
        const s = hhmmToMin(p.start);
        const e = hhmmToMin(p.end);
        if (s === null || e === null) continue;
        if (s > e && nowMin < e) return { day: yesterdayKey, period: p };
    }

    return null;
}

/**
 * Resuelve el próximo periodo a iniciar a partir de "ahora" (no incluye el
 * actual). Devuelve `{day, period}` o null si no hay periodos en los próximos
 * 7 días. Los periodos se evalúan por la hora de inicio absoluta en la semana.
 */
function getNextPeriod(schedule, nowParts) {
    if (!schedule || !nowParts) return null;
    const nowAbs = (((nowParts.weekday + 6) % 7) * MIN_PER_DAY) + nowParts.hour * 60 + nowParts.minute;

    // Recolectar todos los inicios absolutos.
    const starts = [];
    for (const day of DAY_KEYS) {
        const periods = Array.isArray(schedule[day]) ? schedule[day] : [];
        for (const p of periods) {
            const s = hhmmToMin(p.start);
            if (s === null) continue;
            const dayAbsBase = ((DAY_KEY_TO_DOW[day] + 6) % 7) * MIN_PER_DAY;
            starts.push({ day, period: p, startAbs: dayAbsBase + s });
        }
    }
    if (starts.length === 0) return null;

    // Buscar el primero estrictamente mayor a nowAbs. Si no hay, wrap a la
    // semana siguiente (mínimo + MIN_PER_WEEK).
    starts.sort((a, b) => a.startAbs - b.startAbs);
    for (const s of starts) {
        if (s.startAbs > nowAbs) return { day: s.day, period: s.period };
    }
    // Wrap: primero de la lista.
    return { day: starts[0].day, period: starts[0].period };
}

/**
 * Cantidad de periodos del día actual (incluye el activo si lo hay).
 */
function countPeriodsToday(schedule, nowParts) {
    if (!schedule || !nowParts) return 0;
    const todayKey = DOW_TO_DAY_KEY[nowParts.weekday];
    const list = Array.isArray(schedule[todayKey]) ? schedule[todayKey] : [];
    return list.length;
}

/**
 * ¿El schedule tiene al menos un periodo en la semana? Útil para decidir si
 * mostrar el pill del header como "configurado" o no.
 */
function hasAnyPeriod(schedule) {
    if (!schedule || typeof schedule !== 'object') return false;
    for (const day of DAY_KEYS) {
        const list = schedule[day];
        if (Array.isArray(list) && list.length > 0) return true;
    }
    return false;
}

module.exports = {
    DAY_KEYS,
    DAY_KEY_TO_DOW,
    DOW_TO_DAY_KEY,
    MAX_PERIODS_PER_DAY,
    HHMM_RE,
    FULL_DAY_START,
    FULL_DAY_END,
    MIN_PER_DAY,
    MIN_PER_WEEK,
    hhmmToMin,
    minToHhmm,
    isFullDay,
    crossesMidnight,
    expandPeriod,
    intervalsOverlap,
    validatePeriod,
    validateSchedule,
    getCurrentPeriod,
    getNextPeriod,
    countPeriodsToday,
    hasAnyPeriod,
};

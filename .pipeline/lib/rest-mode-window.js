// =============================================================================
// rest-mode-window.js — Modo descanso del pipeline (gating horario).
// PR-A del épico #2882 (issue #2890), refactor a schedule semanal (#3241).
//
// Responsabilidades:
//   - Persistir la configuración de la ventana en `.pipeline/rest-mode.json`
//     con el modelo `schedule:{day:[periods]}` (campos `active`, `schedule`,
//     `timezone`, `manual`, `updatedAt`).
//   - Mantener compatibilidad hacia atrás con el formato legacy
//     (`start`, `end`, `days[]`) — se lee en boot y se migra lazy al primer
//     `setWindow` (CA-2 del #3241).
//   - Determinar si una skill puede ejecutarse "ahora" según la ventana —
//     `isSkillAllowedNow(skill, now, opts)` (firma intacta, PO-API-1).
//   - Mantener un audit trail append-only en `.pipeline/rest-mode-audit.jsonl`
//     con el `schedule` completo en `prev`/`next` (CA-7 del #3241).
//
// Coexiste con `lib/rest-mode-state.js` (PR-C, campo `alert`) en el mismo
// archivo `.pipeline/rest-mode.json`. Ambos módulos leen el archivo entero
// y preservan los campos del otro al escribir — la regla es "tocá solo lo tuyo".
//
// Tipos:
//   - DETERMINISTIC_SKILLS: skills que el gating SIEMPRE permite (se replican
//     del set de pulpo.js para evitar acoplar pulpo a este módulo).
//   - actor: 'manual'|'api'|'cron'|'config-reload'|'init' — origen del cambio.
//
// Modelo schedule (#3241):
//   {
//     active: true,
//     schedule: {
//       monday:    [{start:'22:00', end:'07:00'}, {start:'13:00', end:'14:00'}],
//       tuesday:   [...],
//       wednesday: [...],
//       thursday:  [...],
//       friday:    [...],
//       saturday:  [],
//       sunday:    [{start:'00:00', end:'23:59'}]
//     },
//     timezone: 'America/Argentina/Buenos_Aires',
//     manual: false,
//     updatedAt: '...'
//   }
//
// Semántica de periodos:
//   - `start < end`: intra-día, activo en [startMin, endMin).
//   - `start > end`: cross-midnight, activo en [startMin, 1440) del día origen
//                    y residual [0, endMin) del día siguiente.
//   - `start === end`: PROHIBIDO (CA-6) salvo {start:'00:00', end:'23:59'} para
//                      representar día completo.
//
// Filosofía:
//   - Si el archivo no existe o está corrupto → ventana inactiva (fail-open).
//   - Si la config está rota → ventana inactiva + warning a stderr.
//   - El módulo NUNCA tira: una excepción acá no debe matar el pipeline.
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_PIPELINE_DIR = path.resolve(__dirname, '..');

// Mismo set que pulpo.js — duplicado a propósito para no introducir un
// require circular (pulpo → este módulo → pulpo). Si se cambia uno, cambiar
// el otro. Test de coherencia en `__tests__/rest-mode-window.test.js`.
const DETERMINISTIC_SKILLS = Object.freeze(['delivery', 'build', 'linter', 'tester']);

const DEFAULT_TIMEZONE = 'America/Argentina/Buenos_Aires';

// Días legacy (legacy `days[]` usa enteros 0..6 estilo Date.getDay():
// 0=domingo, 1=lunes, ..., 6=sábado).
const DEFAULT_DAYS = Object.freeze([0, 1, 2, 3, 4, 5, 6]);

// Allow-list de días para el modelo schedule (#3241 SEC-1, CA-6).
// Object.freeze + indexOf como única vía de iteración para evitar prototype
// pollution (`__proto__`, `constructor`, etc.).
const VALID_DAYS = Object.freeze([
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
]);

// Mapping bidireccional entre día int (0=domingo...) y día string del schedule.
const DAY_TO_INT = Object.freeze({
    sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
    thursday: 4, friday: 5, saturday: 6,
});
const INT_TO_DAY = Object.freeze([
    'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
]);

// Cap de periodos por día (#3241 SEC-2, CA-6). 24 cubre el caso extremo de
// "un periodo por hora del día" sin abrir DoS.
const MAX_PERIODS_PER_DAY = 24;

// Nombre del archivo de audit. Vive al lado de rest-mode.json y crece append-only.
const AUDIT_FILENAME = 'rest-mode-audit.jsonl';

// Validación HH:MM 24h (00:00 → 23:59).
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function statePath(pipelineDir) {
    return path.join(pipelineDir || DEFAULT_PIPELINE_DIR, 'rest-mode.json');
}

function auditPath(pipelineDir) {
    return path.join(pipelineDir || DEFAULT_PIPELINE_DIR, AUDIT_FILENAME);
}

function readStateRaw(file) {
    try {
        const raw = fs.readFileSync(file, 'utf8');
        const parsed = JSON.parse(raw);
        return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (e) {
        return {};
    }
}

function writeStateRaw(file, state) {
    const dir = path.dirname(file);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, file);
}

function hhmmToMinutes(hhmm) {
    const [h, m] = hhmm.split(':').map(n => parseInt(n, 10));
    return h * 60 + m;
}

function isValidDayInt(n) {
    return Number.isInteger(n) && n >= 0 && n <= 6;
}

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Schedule helpers
// ---------------------------------------------------------------------------

/**
 * Devuelve el array de periodos para un día (con `Object.hasOwn` para evitar
 * leer propiedades heredadas del prototipo).
 */
function periodsForDayName(schedule, dayName) {
    if (!isPlainObject(schedule)) return [];
    if (!Object.prototype.hasOwnProperty.call(schedule, dayName)) return [];
    const arr = schedule[dayName];
    return Array.isArray(arr) ? arr : [];
}

/**
 * Convierte un schedule a los campos legacy `start`/`end`/`days` para que
 * consumidores viejos (ej. el pill del header en `views/dashboard/home.js`,
 * o `dashboard-slices.js` durante la transición) sigan recibiendo algo
 * coherente mientras la hija de UI (#3242) todavía no mergeó.
 *
 * Estrategia: primer día con periodos (en orden Mon..Sun) → primer periodo
 * → eso provee `start`/`end`. `days` queda como el set de día-ints con
 * periodos.
 */
function synthesizeLegacy(schedule) {
    const days = [];
    let start = null;
    let end = null;
    if (isPlainObject(schedule)) {
        for (const dayName of VALID_DAYS) {
            const periods = periodsForDayName(schedule, dayName);
            if (periods.length > 0) {
                days.push(DAY_TO_INT[dayName]);
                if (start === null) {
                    start = periods[0].start;
                    end = periods[0].end;
                }
            }
        }
    }
    days.sort((a, b) => a - b);
    return { start, end, days };
}

/**
 * Migra un objeto legacy `{start, end, days[]}` al modelo schedule semanal.
 * `start === end` en legacy era ventana de 24h → se mapea a {00:00→23:59}.
 */
function legacyToSchedule(legacy) {
    const schedule = {};
    for (const dayName of VALID_DAYS) {
        schedule[dayName] = [];
    }
    if (!legacy || typeof legacy.start !== 'string' || typeof legacy.end !== 'string'
        || !HHMM_RE.test(legacy.start) || !HHMM_RE.test(legacy.end)) {
        return schedule;
    }
    const days = Array.isArray(legacy.days) ? legacy.days.filter(isValidDayInt) : DEFAULT_DAYS.slice();
    for (const dayInt of days) {
        const dayName = INT_TO_DAY[dayInt];
        if (!dayName) continue;
        if (legacy.start === legacy.end) {
            schedule[dayName] = [{ start: '00:00', end: '23:59' }];
        } else {
            schedule[dayName] = [{ start: legacy.start, end: legacy.end }];
        }
    }
    return schedule;
}

// ---------------------------------------------------------------------------
// getWindow / getFullState / getSchedule
// ---------------------------------------------------------------------------

/**
 * Devuelve la configuración de la ventana — siempre con shape unificado
 * `{ active, start, end, timezone, days, manual, schedule, updatedAt }`.
 *
 * - Si el archivo tiene `schedule`: se devuelve tal cual; los campos
 *   `start`/`end`/`days` se sintetizan para retrocompat (no son canónicos).
 * - Si el archivo tiene formato legacy `{start,end,days}`: se sintetiza
 *   `schedule` en memoria. La migración a disco ocurre en el primer write.
 * - Si el archivo no existe o está corrupto: shape inactivo con schedule
 *   vacío (todos los días `[]`).
 *
 * Nunca tira.
 */
function getWindow(opts) {
    const _opts = opts || {};
    const file = _opts.statePath || statePath(_opts.pipelineDir);
    const raw = readStateRaw(file);

    const active = raw.active === true;
    const timezone = typeof raw.timezone === 'string' && raw.timezone ? raw.timezone : DEFAULT_TIMEZONE;
    const manual = raw.manual === true;
    const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : null;

    // Caso 1: archivo trae `schedule` (modelo nuevo) — lo usamos canónico.
    if (isPlainObject(raw.schedule)) {
        const schedule = sanitizeScheduleForRead(raw.schedule);
        const legacy = synthesizeLegacy(schedule);
        return {
            active,
            start: legacy.start,
            end: legacy.end,
            timezone,
            days: legacy.days.length ? legacy.days : DEFAULT_DAYS.slice(),
            manual,
            schedule,
            updatedAt,
        };
    }

    // Caso 2: archivo trae formato legacy → sintetizamos schedule en memoria.
    const legacyStart = typeof raw.start === 'string' && HHMM_RE.test(raw.start) ? raw.start : null;
    const legacyEnd = typeof raw.end === 'string' && HHMM_RE.test(raw.end) ? raw.end : null;
    const legacyDaysFiltered = Array.isArray(raw.days) ? raw.days.filter(isValidDayInt) : null;
    const legacyDays = legacyDaysFiltered && legacyDaysFiltered.length
        ? legacyDaysFiltered : DEFAULT_DAYS.slice();

    if (legacyStart && legacyEnd) {
        const schedule = legacyToSchedule({
            start: legacyStart, end: legacyEnd, days: legacyDays,
        });
        return {
            active,
            start: legacyStart,
            end: legacyEnd,
            timezone,
            days: legacyDays.slice(),
            manual,
            schedule,
            updatedAt,
        };
    }

    // Caso 3: archivo vacío/corrupto o sin definir.
    return {
        active,
        start: null,
        end: null,
        timezone,
        days: DEFAULT_DAYS.slice(),
        manual,
        schedule: emptySchedule(),
        updatedAt,
    };
}

function emptySchedule() {
    const sched = {};
    for (const dayName of VALID_DAYS) sched[dayName] = [];
    return sched;
}

/**
 * Limpia un schedule leído de disco — descarta claves inválidas y periodos
 * mal formados sin tirar. Defensivo contra archivos corruptos. Sólo se usa
 * en READ; el write valida estrictamente.
 */
function sanitizeScheduleForRead(rawSchedule) {
    const clean = emptySchedule();
    if (!isPlainObject(rawSchedule)) return clean;
    for (const dayName of VALID_DAYS) {
        if (!Object.prototype.hasOwnProperty.call(rawSchedule, dayName)) continue;
        const arr = rawSchedule[dayName];
        if (!Array.isArray(arr)) continue;
        const valid = [];
        for (const p of arr) {
            if (!isPlainObject(p)) continue;
            if (typeof p.start !== 'string' || !HHMM_RE.test(p.start)) continue;
            if (typeof p.end !== 'string' || !HHMM_RE.test(p.end)) continue;
            if (p.start === p.end) continue; // rechaza explícitamente
            valid.push({ start: p.start, end: p.end });
            if (valid.length >= MAX_PERIODS_PER_DAY) break;
        }
        clean[dayName] = valid;
    }
    return clean;
}

/**
 * Devuelve únicamente el `schedule` canónico. Útil para consumidores nuevos
 * (UI de #3242, slice enriquecido).
 */
function getSchedule(opts) {
    return getWindow(opts).schedule;
}

/**
 * Estado completo del archivo (campos PR-A + alert de PR-C). Útil para el
 * dashboard que consume todo en una sola request.
 */
function getFullState(opts) {
    const _opts = opts || {};
    const file = _opts.statePath || statePath(_opts.pipelineDir);
    const raw = readStateRaw(file);
    return {
        window: getWindow({ pipelineDir: _opts.pipelineDir, statePath: file }),
        alert: raw.alert && typeof raw.alert === 'object' ? raw.alert : null,
    };
}

// ---------------------------------------------------------------------------
// Validación
// ---------------------------------------------------------------------------

/**
 * Whitelist de timezones válidos (CA-Sec-A03). El criterio de aceptación
 * es: la zona debe estar en `Intl.supportedValuesOf('timeZone')` *o* ser
 * un alias IANA aceptado por `new Intl.DateTimeFormat`. Esto cubre nombres
 * canónicos modernos (`America/Buenos_Aires`) y los alias históricos
 * (`America/Argentina/Buenos_Aires`, `UTC`) que el motor JS sigue
 * resolviendo correctamente.
 *
 * Strings random como `Foo/Bar` siguen rechazándose porque
 * `Intl.DateTimeFormat` lanza `RangeError` cuando la zona no es válida.
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
 * Valida un periodo individual `{start, end}`. Rechaza:
 *  - tipo distinto a object plano,
 *  - campos extras (anti payload smuggling),
 *  - start/end ausente o mal formado,
 *  - start === end (salvo {00:00, 23:59} representando día completo).
 */
function validatePeriod(period, dayName, idx) {
    const errors = [];
    if (!isPlainObject(period)) {
        errors.push(`schedule.${dayName}[${idx}] no es un objeto plano`);
        return { ok: false, errors };
    }
    const allowed = ['start', 'end'];
    for (const k of Object.keys(period)) {
        if (allowed.indexOf(k) < 0) {
            errors.push(`schedule.${dayName}[${idx}] tiene campo desconocido "${k}"`);
        }
    }
    if (typeof period.start !== 'string' || !HHMM_RE.test(period.start)) {
        errors.push(`schedule.${dayName}[${idx}].start debe ser HH:MM (00:00-23:59)`);
    }
    if (typeof period.end !== 'string' || !HHMM_RE.test(period.end)) {
        errors.push(`schedule.${dayName}[${idx}].end debe ser HH:MM (00:00-23:59)`);
    }
    if (errors.length === 0 && period.start === period.end) {
        errors.push(`schedule.${dayName}[${idx}] tiene start === end (${period.start}) — usá {start:'00:00', end:'23:59'} para día completo`);
    }
    if (errors.length > 0) {
        return { ok: false, errors };
    }
    return { ok: true, errors: [], normalized: { start: period.start, end: period.end } };
}

/**
 * Detecta solapamientos dentro de los periodos de un mismo día, considerando
 * la wrap-around de periodos que cruzan medianoche.
 *
 * Algoritmo (O(N log N)):
 *  - Cada periodo se proyecta a sub-intervalos `[a,b)` en [0, 1440):
 *      - Intra-día (end > start)        → [start, end)
 *      - Cross-midnight (end <= start)  → [start, 1440) ∪ [0, end)
 *  - Ordenar todos los sub-intervalos por `start`.
 *  - Recorrer adyacentes; si `intervals[i].end > intervals[i+1].start` y
 *    pertenecen a distintos periodos fuente → SOLAPAN.
 *
 * Este algoritmo cierra el test `{22:00→07:00} + {06:00→08:00}` que un
 * detector ingenuo (sólo `start+dur`) NO detecta. Cubre #3241 SEC-3.
 */
function detectOverlapsInDay(periods, dayName) {
    if (!periods.length) return null;
    const intervals = [];
    for (const p of periods) {
        const sMin = hhmmToMinutes(p.start);
        const eMin = hhmmToMinutes(p.end);
        if (eMin > sMin) {
            intervals.push({ start: sMin, end: eMin, src: p });
        } else {
            // Cross-midnight: split en dos sub-intervalos.
            intervals.push({ start: sMin, end: 1440, src: p });
            if (eMin > 0) {
                intervals.push({ start: 0, end: eMin, src: p });
            }
        }
    }
    intervals.sort((a, b) => a.start - b.start);
    for (let i = 0; i < intervals.length - 1; i++) {
        if (intervals[i].end > intervals[i + 1].start) {
            const a = intervals[i].src;
            const b = intervals[i + 1].src;
            // El mismo periodo cruzando medianoche genera 2 sub-intervalos
            // que nunca solapan entre sí (separados por la línea 1440 vs 0).
            // Pero si por algún motivo sí lo hicieran (no debería pasar),
            // tampoco lo reportamos contra sí mismo.
            if (a === b) continue;
            return `schedule.${dayName} tiene periodos solapados: {${a.start}→${a.end}} y {${b.start}→${b.end}}`;
        }
    }
    return null;
}

/**
 * Valida el schedule completo. Rechaza claves no listadas en VALID_DAYS,
 * arrays con > MAX_PERIODS_PER_DAY periodos, periodos individualmente
 * inválidos, y solapamientos por día.
 *
 * Devuelve `{ ok, errors, normalized }` donde `normalized` tiene todos los
 * días (incluyendo los `[]` para días sin periodos).
 */
function validateSchedule(schedule) {
    const errors = [];
    if (!isPlainObject(schedule)) {
        errors.push('schedule debe ser un objeto plano');
        return { ok: false, errors, normalized: null };
    }
    // Allow-list de claves (SEC-1): rechaza `__proto__`, `constructor`, etc.
    for (const k of Object.keys(schedule)) {
        if (VALID_DAYS.indexOf(k) < 0) {
            errors.push(`schedule contiene clave inválida "${k}" (días válidos: ${VALID_DAYS.join(', ')})`);
        }
    }
    if (errors.length > 0) {
        return { ok: false, errors, normalized: null };
    }

    const normalized = emptySchedule();
    for (const dayName of VALID_DAYS) {
        if (!Object.prototype.hasOwnProperty.call(schedule, dayName)) {
            continue; // queda `[]` por default
        }
        const periods = schedule[dayName];
        if (!Array.isArray(periods)) {
            errors.push(`schedule.${dayName} debe ser un array (recibido ${typeof periods})`);
            continue;
        }
        if (periods.length > MAX_PERIODS_PER_DAY) {
            errors.push(`schedule.${dayName} tiene ${periods.length} periodos, máximo permitido es ${MAX_PERIODS_PER_DAY}`);
            continue;
        }
        const cleanPeriods = [];
        let dayHadError = false;
        for (let i = 0; i < periods.length; i++) {
            const pres = validatePeriod(periods[i], dayName, i);
            if (!pres.ok) {
                errors.push(...pres.errors);
                dayHadError = true;
            } else {
                cleanPeriods.push(pres.normalized);
            }
        }
        if (dayHadError) continue;
        const overlapErr = detectOverlapsInDay(cleanPeriods, dayName);
        if (overlapErr) {
            errors.push(overlapErr);
            continue;
        }
        normalized[dayName] = cleanPeriods;
    }

    if (errors.length > 0) {
        return { ok: false, errors, normalized: null };
    }
    return { ok: true, errors: [], normalized };
}

/**
 * Valida el subset legacy del payload (`start`, `end`, `days`) — mismas
 * reglas que la implementación previa. Permite que clientes viejos sigan
 * posteando con ese shape (CA-2).
 */
function validateLegacyPayload(payload) {
    const errors = [];
    let start = null;
    if (typeof payload.start !== 'string' || !HHMM_RE.test(payload.start)) {
        errors.push('start debe ser HH:MM (00:00-23:59)');
    } else {
        start = payload.start;
    }
    let end = null;
    if (typeof payload.end !== 'string' || !HHMM_RE.test(payload.end)) {
        errors.push('end debe ser HH:MM (00:00-23:59)');
    } else {
        end = payload.end;
    }
    let days = DEFAULT_DAYS.slice();
    if (payload.days !== undefined) {
        if (!Array.isArray(payload.days) || payload.days.length === 0) {
            errors.push('days debe ser un array no vacio de enteros [0..6]');
        } else {
            const filtered = payload.days.filter(isValidDayInt);
            if (filtered.length !== payload.days.length) {
                errors.push('days contiene valores fuera de [0..6]');
            }
            days = [...new Set(filtered)].sort((a, b) => a - b);
        }
    }
    if (errors.length > 0) {
        return { ok: false, errors, normalized: null };
    }
    return { ok: true, errors: [], normalized: { start, end, days } };
}

/**
 * Valida un payload entrante. Acepta dos shapes:
 *  - Nuevo: `{active, schedule:{...}, timezone, manual}` (CA-1, CA-8.6).
 *  - Legacy: `{active, start, end, timezone, days, manual}` (CA-2).
 *  - Mixto: ambos campos. `schedule` toma precedencia, se ignora legacy
 *    con warning (CA-8.6, PO-SEC-5).
 *
 * Cualquier campo extra (fuera del shape) se ignora silenciosamente — sólo
 * los periodos individuales rechazan claves extras (anti payload smuggling).
 *
 * Devuelve `{ ok, errors, warnings, normalized }`. `normalized` incluye
 * siempre el `schedule` canónico (sintetizado desde legacy si fue necesario).
 */
function validatePayload(payload) {
    if (!isPlainObject(payload)) {
        return { ok: false, errors: ['payload no es un objeto plano'], warnings: [], normalized: null };
    }
    const errors = [];
    const warnings = [];

    const active = payload.active === true;
    const timezone = typeof payload.timezone === 'string' && payload.timezone
        ? payload.timezone : DEFAULT_TIMEZONE;
    if (!timezoneIsSupported(timezone)) {
        errors.push(`timezone "${timezone}" no esta en Intl.supportedValuesOf('timeZone')`);
    }
    const manual = payload.manual === true;

    const hasSchedule = payload.schedule !== undefined && payload.schedule !== null;
    const hasLegacy = payload.start !== undefined || payload.end !== undefined || payload.days !== undefined;

    let scheduleNormalized = null;
    let legacyNormalized = null;

    if (hasSchedule) {
        if (hasLegacy) {
            warnings.push('payload contiene schedule y campos legacy (start/end/days) — schedule toma precedencia, ignorando legacy (PO-SEC-5)');
        }
        const sres = validateSchedule(payload.schedule);
        if (!sres.ok) {
            errors.push(...sres.errors);
        } else {
            scheduleNormalized = sres.normalized;
        }
    } else if (hasLegacy) {
        const lres = validateLegacyPayload(payload);
        if (!lres.ok) {
            errors.push(...lres.errors);
        } else {
            legacyNormalized = lres.normalized;
            scheduleNormalized = legacyToSchedule(legacyNormalized);
        }
    } else {
        // Ni schedule ni legacy → schedule vacío.
        scheduleNormalized = emptySchedule();
    }

    if (errors.length > 0) {
        return { ok: false, errors, warnings, normalized: null };
    }

    const normalized = {
        active,
        schedule: scheduleNormalized,
        timezone,
        manual,
    };
    return { ok: true, errors: [], warnings, normalized };
}

// ---------------------------------------------------------------------------
// setWindow + audit
// ---------------------------------------------------------------------------

/**
 * Persiste la configuración (preservando `alert` y cualquier otro campo
 * que ya esté en el archivo). El archivo SIEMPRE queda en el shape nuevo
 * `{active, schedule, timezone, manual, updatedAt}` — los campos legacy
 * (`start`, `end`, `days`) del archivo previo se eliminan en cada write
 * (migración lazy, CA-2).
 *
 * Escribe el audit trail con `prev`/`next` conteniendo `schedule` completo
 * (CA-7).
 */
function setWindow(payload, opts) {
    const _opts = opts || {};
    const file = _opts.statePath || statePath(_opts.pipelineDir);
    const audit = _opts.auditPath || auditPath(_opts.pipelineDir);
    const now = typeof _opts.now === 'function' ? _opts.now() : Date.now();
    const actor = typeof _opts.actor === 'string' ? _opts.actor : 'unknown';

    const validation = validatePayload(payload);
    if (!validation.ok) {
        return { ok: false, state: null, errors: validation.errors, warnings: validation.warnings || [] };
    }

    const prev = readStateRaw(file);
    const prevWindow = getWindow({ statePath: file });

    // Construir el nuevo state preservando campos ajenos (ej. `alert` de PR-C)
    // y eliminando legacy fields para forzar la migración en disco.
    const next = Object.assign({}, prev);
    delete next.start;
    delete next.end;
    delete next.days;
    next.active = validation.normalized.active;
    next.schedule = validation.normalized.schedule;
    next.timezone = validation.normalized.timezone;
    next.manual = validation.normalized.manual;
    next.updatedAt = new Date(now).toISOString();

    writeStateRaw(file, next);

    // Audit trail (CA-7). No es bloqueante: si falla, logueamos a stderr
    // pero el cambio queda persistido (que es lo importante).
    try {
        const nextWindow = getWindow({ statePath: file });
        appendAudit(audit, {
            ts: new Date(now).toISOString(),
            actor,
            prev: extractWindowFields(prevWindow),
            next: extractWindowFields(nextWindow),
        });
    } catch (e) {
        if (process.env.PIPELINE_DEBUG) {
            console.warn(`[rest-mode-window] audit write failed: ${e.message}`);
        }
    }

    return {
        ok: true,
        state: getWindow({ statePath: file }),
        errors: [],
        warnings: validation.warnings || [],
    };
}

/**
 * Snapshot serializable para el audit. Incluye `schedule` completo (CA-7)
 * + los campos legacy sintetizados para que un operador pueda leer la
 * entry sin necesidad de procesar el schedule.
 */
function extractWindowFields(w) {
    const schedule = isPlainObject(w.schedule) ? w.schedule : emptySchedule();
    // Clonar el schedule por seguridad (evita aliasing del objeto vivo).
    const scheduleCopy = {};
    for (const dayName of VALID_DAYS) {
        const arr = periodsForDayName(schedule, dayName);
        scheduleCopy[dayName] = arr.map(p => ({ start: p.start, end: p.end }));
    }
    return {
        active: !!w.active,
        schedule: scheduleCopy,
        start: w.start || null,
        end: w.end || null,
        timezone: w.timezone || null,
        days: Array.isArray(w.days) ? w.days.slice() : [],
        manual: !!w.manual,
    };
}

function appendAudit(file, entry) {
    const dir = path.dirname(file);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// partsInTz + isWithinWindow
// ---------------------------------------------------------------------------

/**
 * Devuelve { hour, minute, weekday } en la zona horaria pedida.
 * weekday: 0=domingo, 1=lunes, ..., 6=sabado (consistente con Date.getDay()).
 */
function partsInTz(timezone, dateMs) {
    const d = typeof dateMs === 'number' ? new Date(dateMs) : (dateMs || new Date());
    let parts;
    try {
        parts = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
            weekday: 'short',
        }).formatToParts(d);
    } catch (e) {
        parts = new Intl.DateTimeFormat('en-US', {
            timeZone: 'UTC',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
            weekday: 'short',
        }).formatToParts(d);
    }
    const map = Object.create(null);
    for (const p of parts) map[p.type] = p.value;
    let hour = parseInt(map.hour, 10);
    if (hour === 24) hour = 0;
    const minute = parseInt(map.minute, 10);
    const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const weekday = weekdayMap[map.weekday] != null ? weekdayMap[map.weekday] : 0;
    return { hour, minute, weekday };
}

/**
 * Evalúa si `nowMin` cae dentro de un periodo del día actual.
 * Devuelve true si:
 *   - intra-día y nowMin ∈ [startMin, endMin), o
 *   - cross-midnight y nowMin ∈ [startMin, 1440) (residual de hoy).
 * No considera el residual del día anterior (eso se hace aparte).
 */
function periodActiveTodayAt(period, nowMin) {
    const sMin = hhmmToMinutes(period.start);
    const eMin = hhmmToMinutes(period.end);
    if (eMin > sMin) {
        return nowMin >= sMin && nowMin < eMin;
    }
    // cross-midnight
    return nowMin >= sMin;
}

/**
 * Evalúa si un periodo (que cruza medianoche) está activo en la "mañana"
 * del día siguiente: nowMin ∈ [0, endMin).
 */
function periodActiveResidualAt(period, nowMin) {
    const sMin = hhmmToMinutes(period.start);
    const eMin = hhmmToMinutes(period.end);
    if (eMin > sMin) return false; // no es cross-midnight
    return nowMin < eMin;
}

/**
 * ¿La ventana está activa "ahora" en su timezone?
 *
 * Modelo schedule (#3241):
 *   - Evaluar todos los periodos del día actual.
 *   - Evaluar los periodos cross-midnight del día anterior (residual).
 *
 * Compat legacy: si la window viene sin `schedule` (override en tests con
 * `{active, start, end, days}`), se evalúa con el algoritmo de single-window
 * pre-refactor.
 */
function isWithinWindow(window, nowMs) {
    if (!window || !window.active) return false;

    const tz = window.timezone || DEFAULT_TIMEZONE;
    const parts = partsInTz(tz, nowMs);
    const nowMin = parts.hour * 60 + parts.minute;

    // Rama nueva: schedule presente.
    if (isPlainObject(window.schedule)) {
        const todayName = INT_TO_DAY[parts.weekday];
        const yesterdayName = INT_TO_DAY[(parts.weekday + 6) % 7];

        for (const p of periodsForDayName(window.schedule, todayName)) {
            if (periodActiveTodayAt(p, nowMin)) return true;
        }
        for (const p of periodsForDayName(window.schedule, yesterdayName)) {
            if (periodActiveResidualAt(p, nowMin)) return true;
        }
        return false;
    }

    // Rama legacy: single window con start/end/days.
    if (!window.start || !window.end) return false;
    const startMin = hhmmToMinutes(window.start);
    const endMin = hhmmToMinutes(window.end);
    const days = Array.isArray(window.days) && window.days.length ? window.days : DEFAULT_DAYS;

    if (startMin === endMin) {
        return days.indexOf(parts.weekday) >= 0;
    }
    if (startMin < endMin) {
        const inWindow = nowMin >= startMin && nowMin < endMin;
        return inWindow && days.indexOf(parts.weekday) >= 0;
    }
    // Cross-midnight legacy
    if (nowMin >= startMin) {
        return days.indexOf(parts.weekday) >= 0;
    }
    if (nowMin < endMin) {
        const yesterday = (parts.weekday + 6) % 7;
        return days.indexOf(yesterday) >= 0;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Slice enriquecido (CA-Slice del #3241)
// ---------------------------------------------------------------------------

/**
 * Devuelve el shape que la UI consume sin tener que recomputar:
 *   { active, isWithinNow, currentPeriod, nextPeriod, periodsToday, manual }
 *
 * - `currentPeriod`: el periodo activo ahora (de hoy o residual de ayer),
 *   o null si no hay.
 * - `nextPeriod`: el próximo periodo que empezará. `when` es:
 *     - 'today'    si empieza más tarde hoy,
 *     - 'tomorrow' si empieza mañana (día siguiente),
 *     - day-name   ('monday'..'sunday') si es más de 1 día hacia adelante.
 * - `periodsToday`: cantidad de periodos definidos para el día actual.
 */
function describeRestModeNow(window, nowMs) {
    const w = window || {};
    const baseInactive = {
        active: !!w.active,
        isWithinNow: false,
        currentPeriod: null,
        nextPeriod: null,
        periodsToday: 0,
        manual: !!w.manual,
    };
    if (!isPlainObject(w.schedule)) return baseInactive;

    const tz = w.timezone || DEFAULT_TIMEZONE;
    const parts = partsInTz(tz, nowMs);
    const nowMin = parts.hour * 60 + parts.minute;
    const todayName = INT_TO_DAY[parts.weekday];
    const yesterdayName = INT_TO_DAY[(parts.weekday + 6) % 7];

    const todayPeriods = periodsForDayName(w.schedule, todayName);
    const periodsToday = todayPeriods.length;

    let currentPeriod = null;
    let isWithinNow = false;

    if (w.active) {
        for (const p of todayPeriods) {
            if (periodActiveTodayAt(p, nowMin)) {
                currentPeriod = { start: p.start, end: p.end };
                isWithinNow = true;
                break;
            }
        }
        if (!isWithinNow) {
            for (const p of periodsForDayName(w.schedule, yesterdayName)) {
                if (periodActiveResidualAt(p, nowMin)) {
                    currentPeriod = { start: p.start, end: p.end };
                    isWithinNow = true;
                    break;
                }
            }
        }
    }

    // nextPeriod: primer periodo cuyo `start` es estrictamente futuro.
    let nextPeriod = null;
    const futureToday = todayPeriods
        .map(p => ({ p, sMin: hhmmToMinutes(p.start) }))
        .filter(x => x.sMin > nowMin)
        .sort((a, b) => a.sMin - b.sMin);
    if (futureToday.length > 0) {
        const { p } = futureToday[0];
        nextPeriod = { start: p.start, end: p.end, when: 'today' };
    } else {
        for (let d = 1; d <= 7; d++) {
            const futureWeekday = (parts.weekday + d) % 7;
            const futureName = INT_TO_DAY[futureWeekday];
            const fp = periodsForDayName(w.schedule, futureName);
            if (fp.length > 0) {
                const earliest = fp.slice().sort((a, b) =>
                    hhmmToMinutes(a.start) - hhmmToMinutes(b.start)
                )[0];
                nextPeriod = {
                    start: earliest.start,
                    end: earliest.end,
                    when: d === 1 ? 'tomorrow' : futureName,
                };
                break;
            }
        }
    }

    return {
        active: !!w.active,
        isWithinNow,
        currentPeriod,
        nextPeriod,
        periodsToday,
        manual: !!w.manual,
    };
}

// ---------------------------------------------------------------------------
// Gate principal (API estable consumida por pulpo.js:4019)
// ---------------------------------------------------------------------------

/**
 * Decide si una skill puede correr ahora. Devuelve un objeto con campos
 * útiles para logging y para que el caller decida.
 *
 * API estable (#3241 CA-API-Estable / PO-API-1) — pulpo.js:4019 depende
 * de esta firma exacta.
 *
 * @param {string} skill
 * @param {number|Date} [now]
 * @param {object} [opts]
 *   @param {string[]} [opts.bypassLabels]  — labels del issue. Si alguno
 *                                            coincide con `cfg.bypass_labels`,
 *                                            el gate no se aplica.
 *   @param {object}   [opts.cfg]           — bloque `rest_mode` de config.yaml.
 *                                            Contiene `bypass_labels`, opcional.
 *   @param {object}   [opts.window]        — override para tests.
 *   @param {string}   [opts.pipelineDir]
 *
 * @returns {{ allowed: boolean, reason: string, withinWindow: boolean,
 *             matchedBypassLabel: string|null, deterministic: boolean }}
 */
function isSkillAllowedNow(skill, now, opts) {
    const _opts = opts || {};
    const cfg = _opts.cfg || {};
    const bypassLabels = Array.isArray(cfg.bypass_labels) ? cfg.bypass_labels : ['priority:critical'];
    const issueLabels = Array.isArray(_opts.bypassLabels) ? _opts.bypassLabels : [];
    const window = _opts.window || getWindow({ pipelineDir: _opts.pipelineDir });
    const nowMs = (now instanceof Date) ? now.getTime()
        : (typeof now === 'number' ? now : Date.now());

    const within = isWithinWindow(window, nowMs);
    const isDeterministic = DETERMINISTIC_SKILLS.indexOf(String(skill)) >= 0;

    if (!within) {
        return {
            allowed: true,
            reason: 'outside_window',
            withinWindow: false,
            matchedBypassLabel: null,
            deterministic: isDeterministic,
        };
    }
    if (isDeterministic) {
        return {
            allowed: true,
            reason: 'deterministic_skill',
            withinWindow: true,
            matchedBypassLabel: null,
            deterministic: true,
        };
    }
    const match = issueLabels.find(l => bypassLabels.indexOf(l) >= 0);
    if (match) {
        return {
            allowed: true,
            reason: 'bypass_label',
            withinWindow: true,
            matchedBypassLabel: match,
            deterministic: false,
        };
    }
    return {
        allowed: false,
        reason: 'within_window_non_deterministic',
        withinWindow: true,
        matchedBypassLabel: null,
        deterministic: false,
    };
}

module.exports = {
    DEFAULT_TIMEZONE,
    DEFAULT_DAYS,
    DETERMINISTIC_SKILLS,
    HHMM_RE,
    AUDIT_FILENAME,
    VALID_DAYS,
    DAY_TO_INT,
    INT_TO_DAY,
    MAX_PERIODS_PER_DAY,
    statePath,
    auditPath,
    getWindow,
    getSchedule,
    getFullState,
    setWindow,
    validatePayload,
    validateSchedule,
    legacyToSchedule,
    synthesizeLegacy,
    timezoneIsSupported,
    isWithinWindow,
    isSkillAllowedNow,
    describeRestModeNow,
    partsInTz,
    // Solo para tests:
    __forTestsOnly__: {
        readStateRaw, writeStateRaw, appendAudit, hhmmToMinutes,
        detectOverlapsInDay, validatePeriod, emptySchedule,
        sanitizeScheduleForRead,
    },
};

// =============================================================================
// rest-mode-window.js — Modo descanso del pipeline (gating horario).
// PR-A del épico #2882 (issue #2890).
//
// Responsabilidades:
//   - Persistir la configuración de la ventana en `.pipeline/rest-mode.json`
//     (campos `active`, `start`, `end`, `timezone`, `days`, `manual`, `updatedAt`).
//   - Determinar si una skill puede ejecutarse "ahora" según la ventana —
//     `isSkillAllowedNow(skill, now, opts)`.
//   - Mantener un audit trail append-only en `.pipeline/rest-mode-audit.jsonl`.
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
const DETERMINISTIC_SKILLS = Object.freeze(['delivery', 'builder', 'linter', 'tester']);

const DEFAULT_TIMEZONE = 'America/Argentina/Buenos_Aires';
const DEFAULT_DAYS = Object.freeze([0, 1, 2, 3, 4, 5, 6]);

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

/**
 * Devuelve la configuración de la ventana — campos PR-A del archivo.
 * Si el archivo no existe o no tiene los campos, devuelve un default
 * inactivo. Nunca tira.
 */
function getWindow(opts) {
    const _opts = opts || {};
    const file = _opts.statePath || statePath(_opts.pipelineDir);
    const raw = readStateRaw(file);
    const days = Array.isArray(raw.days) ? raw.days.filter(isValidDayInt) : null;
    return {
        active: raw.active === true,
        start: typeof raw.start === 'string' && HHMM_RE.test(raw.start) ? raw.start : null,
        end: typeof raw.end === 'string' && HHMM_RE.test(raw.end) ? raw.end : null,
        timezone: typeof raw.timezone === 'string' && raw.timezone ? raw.timezone : DEFAULT_TIMEZONE,
        days: days && days.length ? days : DEFAULT_DAYS.slice(),
        manual: raw.manual === true,
        updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    };
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

function isValidDayInt(n) {
    return Number.isInteger(n) && n >= 0 && n <= 6;
}

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
    // Doble criterio: lista canónica O alias resoluble por el engine.
    try {
        if (typeof Intl.supportedValuesOf === 'function') {
            const list = Intl.supportedValuesOf('timeZone');
            if (Array.isArray(list) && list.indexOf(tz) >= 0) return true;
        }
    } catch (e) { /* ignore — caemos al fallback */ }
    try {
        // eslint-disable-next-line no-new
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Valida un payload entrante (CA-Sec-A03). Devuelve `{ ok, errors, normalized }`.
 *
 * Reglas:
 *   - `active` boolean obligatorio.
 *   - `start`, `end` HH:MM 24h. Pueden ser iguales (ventana de 24h) — no se
 *     valida orden porque las ventanas que cruzan medianoche son legítimas.
 *   - `timezone` debe estar en `Intl.supportedValuesOf('timeZone')`.
 *   - `days` array de enteros [0..6], no vacío. Default si falta.
 *   - `manual` boolean opcional, default false.
 *
 * Cualquier campo extra se ignora silenciosamente para mantener compat.
 */
function validatePayload(payload) {
    const errors = [];
    if (!payload || typeof payload !== 'object') {
        return { ok: false, errors: ['payload no es un objeto'], normalized: null };
    }

    const active = payload.active === true;

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

    const timezone = typeof payload.timezone === 'string' && payload.timezone
        ? payload.timezone : DEFAULT_TIMEZONE;
    if (!timezoneIsSupported(timezone)) {
        errors.push(`timezone "${timezone}" no esta en Intl.supportedValuesOf('timeZone')`);
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

    const manual = payload.manual === true;

    if (errors.length > 0) {
        return { ok: false, errors, normalized: null };
    }

    return {
        ok: true,
        errors: [],
        normalized: { active, start, end, timezone, days, manual },
    };
}

/**
 * Persiste la configuración (preservando `alert` y cualquier otro campo
 * que ya esté en el archivo). Escribe el audit trail si `actor` está
 * presente. Devuelve `{ ok, state, errors }`.
 */
function setWindow(payload, opts) {
    const _opts = opts || {};
    const file = _opts.statePath || statePath(_opts.pipelineDir);
    const audit = _opts.auditPath || auditPath(_opts.pipelineDir);
    const now = typeof _opts.now === 'function' ? _opts.now() : Date.now();
    const actor = typeof _opts.actor === 'string' ? _opts.actor : 'unknown';

    const validation = validatePayload(payload);
    if (!validation.ok) {
        return { ok: false, state: null, errors: validation.errors };
    }

    const prev = readStateRaw(file);
    const prevWindow = getWindow({ statePath: file });
    const next = Object.assign({}, prev, validation.normalized, {
        updatedAt: new Date(now).toISOString(),
    });

    writeStateRaw(file, next);

    // Audit trail (CA-Sec-A08). No es bloqueante: si falla, logueamos a stderr
    // pero el cambio queda persistido (que es lo importante).
    try {
        appendAudit(audit, {
            ts: new Date(now).toISOString(),
            actor,
            prev: extractWindowFields(prevWindow),
            next: extractWindowFields(getWindow({ statePath: file })),
        });
    } catch (e) {
        if (process.env.PIPELINE_DEBUG) {
            console.warn(`[rest-mode-window] audit write failed: ${e.message}`);
        }
    }

    return { ok: true, state: getWindow({ statePath: file }), errors: [] };
}

function extractWindowFields(w) {
    return {
        active: !!w.active,
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
        // Timezone inválido: caemos a UTC. El validador ya rechaza zonas
        // raras al guardar, pero defendemos contra archivos corruptos.
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
    if (hour === 24) hour = 0; // algunos locales reportan "24:00" para medianoche.
    const minute = parseInt(map.minute, 10);
    const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const weekday = weekdayMap[map.weekday] != null ? weekdayMap[map.weekday] : 0;
    return { hour, minute, weekday };
}

function hhmmToMinutes(hhmm) {
    const [h, m] = hhmm.split(':').map(n => parseInt(n, 10));
    return h * 60 + m;
}

/**
 * ¿La ventana está activa "ahora" en su timezone?
 *
 * Soporta ventanas que cruzan la medianoche (ej. start=22:00, end=08:00).
 * El día se evalúa contra `start`: una ventana 22:00→08:00 con days=[1]
 * (lunes) es válida desde lunes 22:00 hasta martes 08:00.
 */
function isWithinWindow(window, nowMs) {
    if (!window || !window.active) return false;
    if (!window.start || !window.end) return false;

    const { hour, minute, weekday } = partsInTz(window.timezone || DEFAULT_TIMEZONE, nowMs);
    const nowMin = hour * 60 + minute;
    const startMin = hhmmToMinutes(window.start);
    const endMin = hhmmToMinutes(window.end);
    const days = Array.isArray(window.days) && window.days.length ? window.days : DEFAULT_DAYS;

    if (startMin === endMin) {
        // Ventana de 24h en los días configurados.
        return days.indexOf(weekday) >= 0;
    }

    if (startMin < endMin) {
        // Ventana intra-día (ej. 13:00 → 17:00).
        const inWindow = nowMin >= startMin && nowMin < endMin;
        return inWindow && days.indexOf(weekday) >= 0;
    }

    // Cross-midnight (ej. 22:00 → 08:00).
    if (nowMin >= startMin) {
        // Estamos en la primera mitad: el "día" es weekday.
        return days.indexOf(weekday) >= 0;
    }
    if (nowMin < endMin) {
        // Estamos en la segunda mitad: el "día" lógico es el anterior.
        const yesterday = (weekday + 6) % 7;
        return days.indexOf(yesterday) >= 0;
    }
    return false;
}

/**
 * Decide si una skill puede correr ahora. Devuelve un objeto con campos
 * útiles para logging y para que el caller decida.
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

    // Dentro de la ventana: el orden de evaluación importa.
    // 1. Si la skill es determinística, pasa siempre.
    if (isDeterministic) {
        return {
            allowed: true,
            reason: 'deterministic_skill',
            withinWindow: true,
            matchedBypassLabel: null,
            deterministic: true,
        };
    }
    // 2. Si el issue trae un bypass label, pasa.
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
    // 3. Resto: bloqueado.
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
    statePath,
    auditPath,
    getWindow,
    getFullState,
    setWindow,
    validatePayload,
    timezoneIsSupported,
    isWithinWindow,
    isSkillAllowedNow,
    partsInTz,
    // Solo para tests:
    __forTestsOnly__: { readStateRaw, writeStateRaw, appendAudit, hhmmToMinutes },
};

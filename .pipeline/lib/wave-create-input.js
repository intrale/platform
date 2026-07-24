// =============================================================================
// wave-create-input.js — Parseo + validación compartida de la creación de olas
// planificadas (#4376, split de #4351 · Parte A).
//
// Fuente única de verdad para las validaciones de input de `crear-ola` (CLI) y
// `/wave create` (Commander/Telegram). Ambas superficies DEBEN aplicar las
// MISMAS validaciones (CA-4 BLOQUEANTE / Security A03-A08): fallar temprano y con
// mensaje accionable ANTES de tocar el estado (`createPlannedWave`).
//
// Reglas de seguridad replicadas del núcleo endurecido `waves.js`:
//   - Enteros DECIMAL-PURO con bounds (window 5..1440, concurrency 1..techo,
//     cap 999999). Nada de `parseInt` laxo (rechaza floats/hex/negativos).
//   - Texto libre (nombre/objetivo): length-bound, strip de control chars,
//     rechazo de patrones prompt-injection (reusa `handoff.detectInjection`).
//   - `issues`: lista `#?\d+` única, no vacía, con cap defensivo.
//
// Diseño: módulo PURO (sin I/O salvo lectura del techo de concurrencia desde
// `waves.readWaveMaxConcurrency`, que ya lee `config.yaml` server-side). NO
// construye paths ni comandos shell con input de usuario (A03 command/path).
// =============================================================================
'use strict';

const waves = require('./waves');
const handoff = require('./handoff');

// Cap defensivo de la cantidad de issues por ola (DoS / resource exhaustion).
// El núcleo no lo limita explícitamente; lo acotamos en la capa de parseo.
const WAVE_MAX_ISSUES = 200;
// Cap de longitud del objetivo (texto libre). El núcleo solo hace NFC+trim; acá
// lo acotamos para no aceptar payloads arbitrariamente largos desde Telegram.
const WAVE_GOAL_MAX_LEN = 280;
// Techo absoluto de enteros aceptados en la capa de parseo (Security CA-SEC-3).
const INT_HARD_CAP = 999999;

// Flags aceptados (ES + EN) → clave canónica.
const FLAG_ALIASES = {
    nombre: 'name',
    name: 'name',
    objetivo: 'goal',
    goal: 'goal',
    concurrency: 'concurrency',
    concurrencia: 'concurrency',
    window: 'window',
    ventana: 'window',
    issues: 'issues',
};

/**
 * Quita comillas simples/dobles que envuelvan el valor completo.
 * @param {string} v
 * @returns {string}
 */
function stripSurroundingQuotes(v) {
    const s = String(v == null ? '' : v).trim();
    if (s.length >= 2) {
        const first = s[0];
        const last = s[s.length - 1];
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
            return s.slice(1, -1);
        }
    }
    return s;
}

/**
 * Elimina caracteres de control (C0 + DEL) del texto. Preserva el resto tal
 * cual (el NFC/trim y el escape MarkdownV2 los hace el consumidor/render).
 * @param {string} v
 * @returns {string}
 */
function stripControlChars(v) {
    // eslint-disable-next-line no-control-regex
    return String(v == null ? '' : v).replace(/[\x00-\x1F\x7F]/g, '');
}

/**
 * Parsea una cadena de flags nombrados con valores que pueden contener espacios.
 * Ej: `--nombre Ola X --objetivo cerrar Y --concurrency 3 --window 60 --issues #1,#2`
 *
 * Cada `--flag` captura todo hasta el próximo ` --flag` o el fin de la cadena.
 * Devuelve un objeto `{name?, goal?, concurrency?, window?, issues?}` con los
 * valores crudos (strings, sin comillas envolventes). Flags desconocidos se
 * ignoran. NO valida — solo separa.
 *
 * @param {string} raw
 * @returns {{name?:string, goal?:string, concurrency?:string, window?:string, issues?:string}}
 */
function parseNamedFlags(raw) {
    const out = {};
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return out;
    const re = /--([a-zA-Z][a-zA-Z0-9_-]*)(?:\s+([\s\S]*?))?(?=\s+--[a-zA-Z]|$)/g;
    let m;
    while ((m = re.exec(s)) !== null) {
        const rawKey = String(m[1] || '').toLowerCase();
        const canonical = FLAG_ALIASES[rawKey];
        if (!canonical) continue;
        const value = stripSurroundingQuotes(m[2] || '');
        // Primer flag gana (no sobrescribir si aparece repetido).
        if (!(canonical in out)) out[canonical] = value;
    }
    return out;
}

/**
 * Parsea la lista de issues: acepta separadores coma y/o espacio, cada token
 * con `#` opcional. Devuelve array de enteros>0 únicos (en orden de aparición)
 * o `null` si algún token es inválido, la lista está vacía o excede el cap.
 *
 * @param {string} raw
 * @returns {number[]|null}
 */
function parseIssuesList(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return null;
    const tokens = s.split(/[\s,]+/).filter(Boolean);
    if (tokens.length === 0) return null;
    const seen = new Set();
    const nums = [];
    for (const t of tokens) {
        const bare = t.startsWith('#') ? t.slice(1) : t;
        if (!/^\d+$/.test(bare)) return null; // decimal puro, sin `#3500a`, floats, hex
        const n = parseInt(bare, 10);
        if (!Number.isInteger(n) || n < 1 || n > INT_HARD_CAP) return null;
        if (seen.has(n)) return null; // duplicado explícito → rechazo temprano
        seen.add(n);
        nums.push(n);
    }
    if (nums.length > WAVE_MAX_ISSUES) return null;
    return nums;
}

/**
 * Valida un entero decimal-puro dentro de `[min, max]` (además del techo duro).
 * @param {string} raw
 * @param {number} min
 * @param {number} max
 * @returns {number|null}
 */
function parseBoundedInt(raw, min, max) {
    const s = String(raw == null ? '' : raw).trim();
    if (!/^\d+$/.test(s)) return null;
    const n = parseInt(s, 10);
    if (!Number.isInteger(n)) return null;
    if (n > INT_HARD_CAP) return null;
    if (n < min || n > max) return null;
    return n;
}

/**
 * Valida un bloque de texto libre: strip de control chars + NFC/trim + bounds de
 * longitud + rechazo de prompt-injection.
 *
 * @param {string} raw
 * @param {number} maxLen
 * @param {boolean} required
 * @returns {{ok:true, value:string|null} | {ok:false, error:string}}
 */
function validateFreeText(raw, maxLen, required) {
    const cleaned = stripControlChars(raw).normalize('NFC').trim();
    if (cleaned.length === 0) {
        if (required) return { ok: false, error: 'el texto es obligatorio y no puede estar vacío' };
        return { ok: true, value: null };
    }
    if (cleaned.length > maxLen) {
        return { ok: false, error: `el texto supera el máximo de ${maxLen} caracteres (tiene ${cleaned.length})` };
    }
    const inj = handoff.detectInjection(cleaned);
    if (inj.hits && inj.hits.length > 0) {
        return { ok: false, error: 'el texto contiene patrones no permitidos (posible inyección de instrucciones)' };
    }
    return { ok: true, value: cleaned };
}

/**
 * Valida el input crudo de creación de ola y devuelve un spec listo para
 * `createPlannedWave` o un error accionable.
 *
 * Aplica TODAS las validaciones del núcleo, fallando temprano (CA-4). El techo
 * de concurrencia se lee server-side (`config.yaml`), jamás del input.
 *
 * @param {{name?:string, goal?:string, concurrency?:string|number, window?:string|number, issues?:string|number[]}} raw
 * @returns {{ok:true, spec:{name:string, goal:string|null, concurrency_max:number, window_minutes:number, issues:number[]}} | {ok:false, error:string, field:string}}
 */
function validateCreateInput(raw) {
    const input = raw && typeof raw === 'object' ? raw : {};

    // --- nombre (obligatorio) ---
    const nameRes = validateFreeText(input.name, waves.WAVE_NAME_MAX_LEN, true);
    if (!nameRes.ok) return { ok: false, field: 'nombre', error: `Nombre inválido: ${nameRes.error}.` };

    // --- objetivo (opcional) ---
    const goalRes = validateFreeText(input.goal, WAVE_GOAL_MAX_LEN, false);
    if (!goalRes.ok) return { ok: false, field: 'objetivo', error: `Objetivo inválido: ${goalRes.error}.` };

    // --- concurrency (obligatorio, decimal-puro, 1..techo) ---
    const maxConcurrency = waves.readWaveMaxConcurrency();
    const conc = parseBoundedInt(input.concurrency, 1, maxConcurrency);
    if (conc === null) {
        return {
            ok: false,
            field: 'concurrency',
            error: `Concurrency inválido: debe ser un entero entre 1 y ${maxConcurrency}.`,
        };
    }

    // --- window (obligatorio, decimal-puro, 5..1440) ---
    const win = parseBoundedInt(input.window, waves.WAVE_WINDOW_MIN_MINUTES, waves.WAVE_WINDOW_MAX_MINUTES);
    if (win === null) {
        return {
            ok: false,
            field: 'window',
            error: `Window inválido: debe ser un entero entre ${waves.WAVE_WINDOW_MIN_MINUTES} y ${waves.WAVE_WINDOW_MAX_MINUTES} minutos.`,
        };
    }

    // --- issues (obligatorio, lista única no vacía) ---
    const issues = Array.isArray(input.issues)
        ? parseIssuesList(input.issues.join(','))
        : parseIssuesList(input.issues);
    if (!issues) {
        return {
            ok: false,
            field: 'issues',
            error: `Issues inválidos: indicá una lista no vacía de números (\`#123 #456\`), sin duplicados, máx ${WAVE_MAX_ISSUES}.`,
        };
    }

    return {
        ok: true,
        spec: {
            name: nameRes.value,
            goal: goalRes.value,
            concurrency_max: conc,
            window_minutes: win,
            issues,
        },
    };
}

module.exports = {
    parseNamedFlags,
    parseIssuesList,
    parseBoundedInt,
    validateFreeText,
    validateCreateInput,
    stripControlChars,
    stripSurroundingQuotes,
    WAVE_MAX_ISSUES,
    WAVE_GOAL_MAX_LEN,
    INT_HARD_CAP,
};

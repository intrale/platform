// =============================================================================
// wizards/ola/index.js — Flow "Crear nueva ola de trabajo" del Dashboard V3.
//
// Issue #3738 (split de #3715 / paraguas #3669). Wizard paso-a-paso para
// materializar una ola planificada con N issues. Se registra en la infra de
// #3724 (`wizard-session.js`) vía `registerFlow('ola', {...})`.
//
// CONTRATO REAL (#3724): el flow aporta SOLO `{maxStep, validateStep, executeStep}`.
// La base resuelve CSRF (HttpOnly+HMAC), Origin/Sec-Fetch allowlist, rate-limit,
// idempotencia por (session, step), timeout 15min y el audit NDJSON de cada step.
// Por eso este módulo NO maneja req/res ni tokens directamente (a diferencia del
// snippet hipotético del architect en el body del issue, que asumía la API
// `register(router, ctx)` de la hija wizards-base — la base terminó usando el
// endpoint único `POST /dashboard/wizard/ola/step` con `step` + `params`).
//
// Pasos (0-indexados según la base):
//   0 — seleccionar issues candidatos (elegibles: no asignados a otra ola).
//   1 — configurar nombre + concurrencia + ventana → devuelve PREVIEW + snapshot.
//   2 — confirmación final (anti-TOCTOU vía snapshot) → crea la ola atómicamente.
//
// MUTACIÓN EXCLUSIVA VÍA GATE: la creación pasa SIEMPRE por
// `waves.createPlannedWave(spec, meta)` (#3738), que corre bajo
// `withLockSync(wavesFile())` con validación estricta de shape/bounds/duplicados
// y persistencia atómica (tmp+fsync+rename + backup). El wizard NUNCA escribe
// `waves.json` por su cuenta.
//
// DEFENSA EN PROFUNDIDAD (security #3738):
//   - El techo de concurrencia se lee de `config.yaml` server-side (vía
//     `waves.readWaveMaxConcurrency`), NUNCA del body (req 6/security).
//   - Tooltips/labels son constantes locales estáticas — nunca echo del input
//     (la vista escapa todo dato dinámico; R7/XSS).
//   - Audit-then-apply (R5): NDJSON `crear_ola` ANTES del write productivo.
//   - Anti-TOCTOU (R2): snapshot del estado en el preview se re-valida fresco en
//     el confirm; si `waves.json` cambió entre medio → la base responde 409.
//   - NUNCA importa `lib/credentials.js` ni lee `.env` (defensa Gemini: el
//     wizard corre dentro del dashboard full-Anthropic).
//
// Sin deps npm: sólo módulos del pipeline.
// =============================================================================
'use strict';

const path = require('node:path');

// Dependencias inyectables (defaults = módulos reales). Los tests las sustituyen
// con `_setForTests` para no tocar el `waves.json` ni los logs reales.
let wavesApi = require('../../waves');
let auditApi = require('../../audit-log');
let auditDir = path.join(__dirname, '..', '..', '..', 'logs'); // .pipeline/logs

// --- Constantes --------------------------------------------------------------
const FLOW = 'ola';
const MAX_STEP = 2;                 // 3 pasos: 0 select, 1 config+preview, 2 confirm.
const ISSUES_MAX = 200;             // cap de issues seleccionables por ola.
const SOURCE = 'dashboard:wizard:ola';
const ACTOR = 'operator-local';
const ACTION = 'crear_ola';

// Tooltips estáticos server-side (la vista los escapa; nunca echo del input).
const TOOLTIPS = Object.freeze({
    issues: 'Issues a incluir en la ola. Sólo elegibles: no pueden estar ya en la ola activa ni en otra planificada.',
    nombre_ola: 'Identificador legible de la ola. NFC, máximo 80 caracteres. No edita olas existentes.',
    concurrencia: 'Cantidad de agentes en paralelo. Acotado server-side a [1, MAX_CONFIGURED] (config.yaml).',
    ventana_minutos: 'Duración objetivo de la ola, en minutos. Rango válido [5, 1440].',
});

// --- Bounds (server-side; reusan los de waves.js para una sola fuente) --------
function nameMax() { return wavesApi.WAVE_NAME_MAX_LEN; }
function winMin() { return wavesApi.WAVE_WINDOW_MIN_MINUTES; }
function winMax() { return wavesApi.WAVE_WINDOW_MAX_MINUTES; }
function maxConcurrency() { return wavesApi.readWaveMaxConcurrency(); }

// --- Helpers de validación ---------------------------------------------------

function isPositiveInt(v) {
    if (typeof v === 'number') return Number.isInteger(v) && v > 0;
    if (typeof v === 'string') return /^\d+$/.test(v) && Number(v) > 0;
    return false;
}

function toInt(v) {
    return typeof v === 'number' ? Math.trunc(v) : parseInt(String(v), 10);
}

/** Normaliza una lista de issues a enteros>0 únicos, ordenados asc. */
function normalizeIssues(arr) {
    const out = [];
    const seen = new Set();
    for (const it of (Array.isArray(arr) ? arr : [])) {
        if (!isPositiveInt(it)) continue;
        const n = toInt(it);
        if (!seen.has(n)) { seen.add(n); out.push(n); }
    }
    return out.sort((a, b) => a - b);
}

/** Lista de issues no vacía, dentro del cap, todos enteros positivos. */
function isPositiveIntList(v) {
    return Array.isArray(v) && v.length > 0 && v.length <= ISSUES_MAX && v.every(isPositiveInt);
}

function normalizeName(s) {
    return String(s == null ? '' : s).normalize('NFC').trim();
}

function hasNullByte(s) {
    return String(s == null ? '' : s).indexOf('\x00') >= 0;
}

// --- Snapshot de estado (guard anti-TOCTOU, R2) ------------------------------

/**
 * Fingerprint del estado de olas relevante a la elegibilidad: el set de issues
 * ocupados (activa + planificadas) y todos los nombres en uso (activa +
 * planificadas + archivadas, NFC lowercase). Si CUALQUIER mutación de
 * `waves.json` cambia esto entre el preview (paso 1) y el confirm (paso 2), el
 * snapshot difiere → 409 `state_changed`. Es lectura global: no depende de la
 * sesión, así que `validateStep` (que no recibe `session`) puede compararlo.
 *
 * @returns {{ occupied: number[], names: string[] }}
 */
function stateSnapshot() {
    const st = wavesApi.loadWaves();
    const occupied = [];
    const names = [];
    const collect = (w, countIssues) => {
        if (!w) return;
        if (w.name) names.push(String(w.name).normalize('NFC').toLowerCase());
        if (countIssues && Array.isArray(w.issues)) {
            for (const i of w.issues) {
                const n = Number(i && i.number);
                if (Number.isInteger(n)) occupied.push(n);
            }
        }
    };
    collect(st.active_wave, true);
    for (const w of (st.planned_waves || [])) collect(w, true);
    // Archivadas: el nombre sigue reservado (dup-name), pero sus issues ya no ocupan.
    for (const w of (st.archived_waves || [])) collect(w, false);
    occupied.sort((a, b) => a - b);
    names.sort();
    return { occupied, names };
}

/** Compara dos snapshots por valor (orden-independiente). */
function snapshotEqual(a, b) {
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    const norm = (s) => JSON.stringify({
        o: (Array.isArray(s.occupied) ? s.occupied.slice() : []).map(Number).sort((x, y) => x - y),
        n: (Array.isArray(s.names) ? s.names.slice() : []).map(String).sort(),
    });
    return norm(a) === norm(b);
}

/**
 * Chequea elegibilidad server-side de un set de issues + nombre contra el
 * estado fresco en disco. Autoritativo: no confía en nada del cliente.
 *
 * @param {number[]} selectedIssues
 * @param {string|null} name
 * @returns {{ ok: boolean, conflicts: number[], nameTaken: boolean }}
 */
function checkEligibility(selectedIssues, name) {
    const snap = stateSnapshot();
    const occ = new Set(snap.occupied);
    const conflicts = (selectedIssues || []).filter((n) => occ.has(n)).sort((a, b) => a - b);
    const nameTaken = name ? snap.names.includes(String(name).normalize('NFC').toLowerCase()) : false;
    return { ok: conflicts.length === 0 && !nameTaken, conflicts, nameTaken };
}

// --- Audit (R5: audit-then-apply, NDJSON encadenado) -------------------------

function appendAudit(entry) {
    try {
        const ymd = new Date().toISOString().slice(0, 10);
        const file = path.join(auditDir, `wizard-audit-${ymd}.ndjson`);
        auditApi.appendChained({ file, entry: Object.assign({ ts: Date.now() }, entry) });
        return true;
    } catch {
        // Best-effort: un fallo del audit no debe tumbar el flow. La base además
        // audita cada step (action 'wizard.step') de forma independiente.
        return false;
    }
}

// --- Contrato del flow -------------------------------------------------------

/**
 * Validación server-side por step. `false` → la base responde 409 (no cachea:
 * el cliente corrige y reintenta). Los chequeos de elegibilidad/drift leen el
 * estado en disco (mismo patrón que el wizard de pausa, paso 3).
 *
 * @param {number} step
 * @param {object} params
 * @returns {boolean}
 */
function validateStep(step, params) {
    const p = params || {};
    switch (step) {
        case 0: {
            // Selección de issues: shape + elegibilidad (ninguno ya ocupado).
            if (!isPositiveIntList(p.issues)) return false;
            const issues = normalizeIssues(p.issues);
            if (issues.length === 0) return false;
            return checkEligibility(issues, null).ok;
        }
        case 1: {
            // Config: nombre NFC ≤80, concurrencia ∈ [1, MAX], ventana ∈ [5, 1440].
            // Bounds server-side: el techo de concurrencia sale de config.yaml,
            // NUNCA del body (R6/security).
            if (hasNullByte(p.name)) return false;
            const name = normalizeName(p.name);
            if (name.length < 1 || name.length > nameMax()) return false;
            if (checkEligibility([], name).nameTaken) return false;
            const conc = p.concurrency_max;
            if (!Number.isInteger(conc) || conc < 1 || conc > maxConcurrency()) return false;
            const win = p.window_minutes;
            if (!Number.isInteger(win) || win < winMin() || win > winMax()) return false;
            return true;
        }
        case 2: {
            // Confirmación: confirm explícito + guard anti-TOCTOU. El cliente
            // reenvía el snapshot visto en el preview (paso 1); si el estado en
            // disco cambió → mismatch → 409 state_changed (R2).
            if (p.confirm !== true) return false;
            return snapshotEqual(stateSnapshot(), p.previous_snapshot);
        }
        default:
            return false;
    }
}

/**
 * Ejecuta el step (post-validación). La base cachea el resultado como `ok` y lo
 * devuelve en replays idempotentes. Fallos de precondición o de apply lanzan →
 * 500 (NO se cachean → reintentables).
 *
 * @param {object} session
 * @param {number} step
 * @param {object} params
 * @returns {Promise<object>}
 */
async function executeStep(session, step, params) {
    const p = params || {};
    const steps = session.steps;

    switch (step) {
        case 0: {
            const issues = normalizeIssues(p.issues);
            return { issues, count: issues.length, eligible: true };
        }

        case 1: {
            const s0 = steps.get(0);
            if (!s0 || !s0.result) throw new Error('precondition: falta el paso 0');
            const name = normalizeName(p.name);
            const goal = (typeof p.goal === 'string' && p.goal.trim().length > 0) ? normalizeName(p.goal) : null;
            const concurrency_max = toInt(p.concurrency_max);
            const window_minutes = toInt(p.window_minutes);
            const issues = s0.result.issues;
            return {
                name,
                goal,
                concurrency_max,
                window_minutes,
                issues,
                // Preview autoritativo de lo que se va a crear.
                preview: {
                    name,
                    goal,
                    issues,
                    count: issues.length,
                    concurrencia: concurrency_max,
                    ventana_minutos: window_minutes,
                },
                // Snapshot para el guard anti-TOCTOU del paso 2 (lo reenvía el cliente).
                previous_snapshot: stateSnapshot(),
            };
        }

        case 2: {
            const s0 = steps.get(0);
            const s1 = steps.get(1);
            if (!s0 || !s0.result || !s1 || !s1.result) {
                throw new Error('precondition: faltan pasos previos');
            }
            const issues = s0.result.issues;
            const { name, goal, concurrency_max, window_minutes } = s1.result;

            const auditBase = {
                actor: ACTOR,
                action: ACTION,
                wizard_flow: FLOW,
                issues_seleccionados: issues,
                config: { concurrencia: concurrency_max, ventana_minutos: window_minutes },
            };

            // R5 — audit-then-apply: la entrada `confirm` se persiste ANTES del
            // write productivo. Si el proceso muere en el medio, queda traza del
            // intento.
            appendAudit(Object.assign({ step: 'confirm' }, auditBase));

            try {
                const result = wavesApi.createPlannedWave(
                    {
                        name,
                        goal,
                        issues: issues.map((n) => ({ number: n, status: 'pending' })),
                        concurrency_max,
                        window_minutes,
                    },
                    { updated_by: ACTOR, source: SOURCE, note: `wizard ola (${name})` },
                );
                appendAudit(Object.assign({ step: 'applied', wave_id_creado: result.waveNumber }, auditBase));
                return {
                    ok: true,
                    wave_id: result.waveNumber,
                    name,
                    issues,
                    config: { concurrencia: concurrency_max, ventana_minutos: window_minutes },
                };
            } catch (err) {
                appendAudit(Object.assign({ step: 'apply_failed', error: err && (err.code || err.message) }, auditBase));
                throw err;
            }
        }

        default:
            throw new Error('step fuera de rango');
    }
}

// --- Registro en la base -----------------------------------------------------

const flowDef = Object.freeze({ maxStep: MAX_STEP, validateStep, executeStep });

/**
 * Registra el flow en la infra de wizards (#3724). Idempotente y best-effort:
 * si la base no está disponible o el flow ya está registrado, no rompe el boot.
 *
 * @param {object} [ws] — módulo wizard-session (inyectable en tests).
 * @returns {boolean} true si registró.
 */
function register(ws) {
    let mod = ws;
    if (!mod) {
        try { mod = require('../../wizard-session'); } catch { return false; }
    }
    try {
        mod.registerFlow(FLOW, flowDef);
        return true;
    } catch {
        return false;
    }
}

// Auto-registro al require (lo dispara dashboard.js al cargar el módulo).
register();

// --- Test helpers (NO usar en runtime) ---------------------------------------
function _setForTests(overrides = {}) {
    if (overrides.waves) wavesApi = overrides.waves;
    if (overrides.audit) auditApi = overrides.audit;
    if (overrides.auditDir) auditDir = overrides.auditDir;
}

function _resetForTests() {
    wavesApi = require('../../waves');
    auditApi = require('../../audit-log');
    auditDir = path.join(__dirname, '..', '..', '..', 'logs');
}

module.exports = {
    FLOW,
    MAX_STEP,
    ISSUES_MAX,
    SOURCE,
    ACTOR,
    ACTION,
    TOOLTIPS,
    flowDef,
    register,
    validateStep,
    executeStep,
    stateSnapshot,
    snapshotEqual,
    checkEligibility,
    normalizeIssues,
    isPositiveIntList,
    isPositiveInt,
    _setForTests,
    _resetForTests,
};

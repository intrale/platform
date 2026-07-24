// =============================================================================
// wizards/allowlist/index.js — Flow "Triaje de allowlist" del Dashboard V3.
//
// Issue #3742 (split de #3715 / paraguas #3669). Wizard paso-a-paso para mutar
// `.pipeline/.partial-pause.json` con motivo obligatorio, recursividad de
// dependencias y audit NDJSON. Se registra en la infra de #3724
// (`wizard-session.js`) vía `registerFlow('allowlist', {...})`.
//
// CONTRATO REAL (#3724): el flow aporta SOLO `{maxStep, validateStep, executeStep}`.
// La base resuelve CSRF (HttpOnly+HMAC), Origin/Sec-Fetch allowlist, rate-limit
// (30/min por Origin), idempotencia por (session, step), timeout 15min y el
// audit NDJSON de cada step. Por eso este módulo NO maneja req/res ni tokens
// directamente (a diferencia del snippet hipotético del architect, que defería
// explícitamente "al contrato que defina la hija wizards-base").
//
// Pasos (0-indexados según la base):
//   0 — acción (add|remove) + issue_id.
//   1 — detección recursiva de dependencias (sólo para add).
//   2 — motivo obligatorio (validación server-side) + preview del diff.
//   3 — doble confirmación + audit-then-apply.
//
// INVARIANTE audit-then-apply (CA-6): `partial-pause.setPartialPause()` ya audita
// ANTES de escribir (vía `evaluateAndAudit` → `partial-pause-audit.appendMutation`).
// Llamar `appendMutation` por separado duplicaría la entry; en su lugar pasamos
// `extra` a través de `setPartialPause` para una única entry autoritativa rica
// (CA-7). El `pid` lo agrega `appendMutation` nativamente.
//
// Sin deps npm: sólo módulos del pipeline.
// =============================================================================
'use strict';

const previewDiff = require('./preview-diff');

// Dependencias inyectables (defaults = módulos reales del pipeline). Los tests
// las sustituyen con `_setForTests` para no tocar gh ni el FS real.
let deps = require('../../partial-pause-deps');
let partialPause = require('../../partial-pause');

// Opts extra para `resolveOpenDeps` (tests inyectan ghRunner / cacheFile).
let resolveDepsOpts = {};

// --- Constantes --------------------------------------------------------------
const FLOW = 'allowlist';
const MAX_STEP = 3;
const MOTIVO_MIN = 10;
const MOTIVO_MAX = 500;            // alineado con MAX_JUSTIFICATION_LEN del audit.
const DEPS_MAX_DEPTH = 10;
const DEPS_MAX_NODES = 200;
const SOURCE = 'dashboard:wizard:allowlist';
const AUTHORIZED_BY = 'commander:leo';   // enum estático de partial-pause-audit.

// --- Helpers de validación ---------------------------------------------------

/** Entero positivo: number entero > 0, o string de sólo dígitos > 0. */
function isPositiveInt(v) {
    if (typeof v === 'number') return Number.isInteger(v) && v > 0;
    if (typeof v === 'string') return /^\d+$/.test(v) && Number(v) > 0;
    return false;
}

function toInt(v) {
    return typeof v === 'number' ? Math.trunc(v) : parseInt(String(v), 10);
}

function normalizeMotivo(s) {
    return String(s == null ? '' : s).normalize('NFC');
}

function hasNullByte(s) {
    return String(s == null ? '' : s).indexOf('\x00') >= 0;
}

/**
 * Calcula el allowlist propuesto server-side (autoritativo).
 * add → unión de `previous` con `issues` (que ya incluye el root + sus deps).
 * remove → `previous` sin `issueId` (sin recursividad).
 */
function computeNext(action, issueId, issues, previous) {
    if (action === 'remove') {
        return previewDiff.normalizeList(previous).filter((n) => n !== issueId);
    }
    return previewDiff.normalizeList([...(previous || []), ...(issues || [])]);
}

// --- Contrato del flow -------------------------------------------------------

/**
 * Validación server-side por step. Devuelve `false` → la base responde 409
 * (no cachea: el cliente puede corregir y reintentar). Bajo el contrato real
 * de #3724 las validaciones de input colapsan a 409 (no a los 400 granulares
 * del snippet hipotético del architect); el código de error específico viaja
 * en el render de la SPA, no en el status HTTP.
 * @param {number} step
 * @param {object} params
 * @returns {boolean}
 */
function validateStep(step, params) {
    const p = params || {};
    switch (step) {
        case 0:
            return (p.action === 'add' || p.action === 'remove') && isPositiveInt(p.issue_id);
        case 1:
            // Prerequisito (paso 0) se valida en executeStep (sin acceso a session aquí).
            return true;
        case 2: {
            const raw = String(p.motivo == null ? '' : p.motivo);
            if (hasNullByte(raw)) return false;                 // NUL → inválido.
            const m = normalizeMotivo(raw);
            return m.length >= MOTIVO_MIN && m.length <= MOTIVO_MAX;
        }
        case 3: {
            if (p.confirm1 !== true || p.confirm2 !== true) return false;   // doble check.
            // Anti-TOCTOU (paso 3↔4): el cliente envía el `previous` que vio en el
            // paso 2; si el estado en disco cambió desde entonces → 409.
            const current = partialPause.readPreviousAllowlist();
            return previewDiff.equalsList(current, p.previous_snapshot);
        }
        default:
            return false;
    }
}

/**
 * Ejecuta el step (post-validación). La base cachea el resultado como `ok` y lo
 * devuelve en replays idempotentes. Los fallos de precondición (cliente saltó
 * pasos) o de apply lanzan → 500 (NO se cachean → reintentables).
 * @param {object} session — registro de sesión de la base (con `.steps` Map).
 * @param {number} step
 * @param {object} params
 * @returns {Promise<object>}
 */
async function executeStep(session, step, params) {
    const p = params || {};
    const steps = session.steps;

    switch (step) {
        case 0: {
            return { action: p.action, issueId: toInt(p.issue_id) };
        }

        case 1: {
            const s0 = steps.get(0);
            if (!s0 || !s0.result) throw new Error('precondition: falta el paso 0');
            const { action, issueId } = s0.result;
            if (action === 'remove') {
                // Remove NO aplica recursividad: sólo el issue puntual.
                return { action, issueId, issues: [issueId], openDeps: [], truncated: false, reason: null, nodesVisited: 0, chains: {} };
            }
            const res = deps.resolveOpenDeps(issueId, Object.assign(
                { maxDepth: DEPS_MAX_DEPTH, maxNodes: DEPS_MAX_NODES },
                resolveDepsOpts,
            ));
            const issues = previewDiff.normalizeList([issueId, ...(res.openDeps || [])]);
            return {
                action,
                issueId,
                issues,
                openDeps: res.openDeps || [],
                truncated: !!res.truncated,
                reason: res.reason || null,
                nodesVisited: res.nodesVisited || 0,
                chains: res.chains || {},
            };
        }

        case 2: {
            const s0 = steps.get(0);
            const s1 = steps.get(1);
            if (!s0 || !s0.result || !s1 || !s1.result) throw new Error('precondition: faltan pasos previos');
            const motivo = normalizeMotivo(p.motivo);
            const { action, issueId } = s0.result;
            const previous = partialPause.readPreviousAllowlist();
            const nextProposed = computeNext(action, issueId, s1.result.issues, previous);
            const diff = previewDiff(previous, nextProposed);
            // `previous_snapshot` lo reenvía el cliente en el paso 3 para el guard TOCTOU.
            return { motivo, previous_snapshot: previous, next_proposed: nextProposed, diff };
        }

        case 3: {
            const s0 = steps.get(0);
            const s1 = steps.get(1);
            const s2 = steps.get(2);
            if (!s0 || !s0.result || !s1 || !s1.result || !s2 || !s2.result) {
                throw new Error('precondition: faltan pasos previos');
            }
            const { action, issueId } = s0.result;
            const motivo = s2.result.motivo;
            // Recálculo autoritativo server-side (no confiar en lo cacheado del cliente).
            const previous = partialPause.readPreviousAllowlist();
            const nextProposed = computeNext(action, issueId, s1.result.issues, previous);
            const diff = previewDiff(previous, nextProposed);
            const recursividadAplicada = action === 'add' && Array.isArray(s1.result.issues) && s1.result.issues.length > 1;

            // setPartialPause() audita (appendMutation) ANTES de escribir. Si el
            // apply falla, la entry queda en el NDJSON (trazabilidad del intento).
            const apply = partialPause.setPartialPause(nextProposed, {
                source: SOURCE,
                authorizedBy: AUTHORIZED_BY,
                justification: motivo,
                extra: {
                    wizard_flow: FLOW,
                    recursividad_aplicada: recursividadAplicada,
                    recursive_truncated: !!s1.result.truncated,
                    recursive_reason: s1.result.reason || null,
                },
            });
            if (!apply || apply.rejected === true || apply.ok === false) {
                throw new Error('apply_rejected: ' + (apply && apply.msg ? apply.msg : 'gate'));
            }
            return { ok: true, applied: apply.allowedIssues, diff };
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
        // Ya registrado o flow no permitido → no-op.
        return false;
    }
}

// Auto-registro al require (lo dispara dashboard.js al cargar el módulo).
register();

// --- Test helpers (NO usar en runtime) ---------------------------------------
function _setForTests(overrides = {}) {
    if (overrides.deps) deps = overrides.deps;
    if (overrides.partialPause) partialPause = overrides.partialPause;
    if (overrides.resolveDepsOpts) resolveDepsOpts = overrides.resolveDepsOpts;
}

function _resetForTests() {
    deps = require('../../partial-pause-deps');
    partialPause = require('../../partial-pause');
    resolveDepsOpts = {};
}

module.exports = {
    FLOW,
    MAX_STEP,
    MOTIVO_MIN,
    MOTIVO_MAX,
    DEPS_MAX_DEPTH,
    DEPS_MAX_NODES,
    SOURCE,
    AUTHORIZED_BY,
    flowDef,
    register,
    validateStep,
    executeStep,
    computeNext,
    isPositiveInt,
    _setForTests,
    _resetForTests,
};

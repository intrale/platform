// =============================================================================
// wizards/pausa/index.js — Flow "Pausar / despausar issues parciales" del
// Dashboard V3.
//
// Issue #3741 (split de #3715 / paraguas #3669). Wizard paso-a-paso para la
// operación más sensible del Pulpo: entrar o salir de un estado de pausa.
// Doble confirmación server-side para la despausa (acción destructiva: reactiva
// el pipeline). Se registra en la infra de #3724 (`wizard-session.js`) vía
// `registerFlow('pausa', {...})`.
//
// CONTRATO REAL (#3724): el flow aporta SOLO `{maxStep, validateStep, executeStep}`.
// La base resuelve CSRF (HttpOnly+HMAC), Origin/Sec-Fetch allowlist, rate-limit,
// idempotencia por (session, step), timeout 15min y el audit NDJSON de cada step.
// Por eso este módulo NO maneja req/res ni tokens directamente (a diferencia del
// snippet hipotético del architect en el body, que defería al contrato de la
// hija wizards-base — y la base terminó usando el endpoint único con `step`).
//
// Pasos (0-indexados según la base):
//   0 — acción (pausar|despausar) + scope (issue|allowlist|full) [+ issue_id/issues].
//   1 — preview: issues afectados + dependencias recursivas + modo resultante.
//   2 — motivo obligatorio (validación server-side) + snapshot del estado.
//   3 — doble confirmación (2 checks para despausar) + drift-check + apply.
//
// MUTACIÓN EXCLUSIVA VÍA GATE (#3625, security A08): toda mutación pasa por
//   - partial-pause.setPartialPause / clearPartialPause   (pausa parcial)
//   - partial-pause.setFullPause   / clearFullPause        (pausa total `.paused`)
// El wizard NUNCA escribe `.partial-pause.json` ni `.paused` por su cuenta. El
// `extra: { via: 'wizard-pausa', ... }` viaja al audit NDJSON (CA-11) — una sola
// entry autoritativa, sin doble-auditar.
//
// Sin deps npm: sólo módulos del pipeline.
// =============================================================================
'use strict';

// Reuso del helper puro del wizard de allowlist (#3742): normalizeList / diff /
// equalsList. Es código sin I/O, perfectamente compartible (DRY).
const previewDiff = require('../allowlist/preview-diff');

// Dependencias inyectables (defaults = módulos reales). Los tests las sustituyen
// con `_setForTests` para no tocar gh ni el FS real.
let deps = require('../../partial-pause-deps');
let partialPause = require('../../partial-pause');

let resolveDepsOpts = {};

// --- Constantes --------------------------------------------------------------
const FLOW = 'pausa';
const MAX_STEP = 3;
const MOTIVO_MIN = 10;
const MOTIVO_MAX = 500;            // alineado con MAX_JUSTIFICATION_LEN del audit.
const DEPS_MAX_DEPTH = 10;
const DEPS_MAX_NODES = 200;
const SOURCE = 'dashboard:wizard:pausa';
const AUTHORIZED_BY = 'commander:leo';   // enum estático de partial-pause-audit.
const VIA = 'wizard-pausa';

const ACTIONS = Object.freeze(['pausar', 'despausar']);
const SCOPES = Object.freeze(['issue', 'allowlist', 'full']);

// --- Helpers de validación ---------------------------------------------------

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

/** Lista de issues no vacía, todos enteros positivos. */
function isPositiveIntList(v) {
    return Array.isArray(v) && v.length > 0 && v.every(isPositiveInt);
}

/**
 * Modo resultante del pipeline para un allowlist propuesto, respetando los
 * skills co-existentes (#3680 CA-A15: allowlist vacía + skills != bloqueo).
 * NO infiere del cliente — se calcula server-side.
 * @param {number[]} allowlist
 * @param {string[]} allowedSkills
 * @returns {'running'|'partial_pause'}
 */
function modeForAllowlist(allowlist, allowedSkills) {
    const hasIssues = Array.isArray(allowlist) && allowlist.length > 0;
    const hasSkills = Array.isArray(allowedSkills) && allowedSkills.length > 0;
    return (hasIssues || hasSkills) ? 'partial_pause' : 'running';
}

/**
 * Snapshot del estado actual para el guard anti-drift (CA-6). Captura `mode` +
 * `allowedIssues`: la despausa total depende de `.paused`, que sólo se refleja
 * en `mode`.
 * @returns {{ mode: string, allowed_issues: number[] }}
 */
function currentSnapshot() {
    const st = partialPause.getPipelineMode();
    return { mode: st.mode, allowed_issues: previewDiff.normalizeList(st.allowedIssues) };
}

/** Compara dos snapshots por valor (orden-independiente). */
function sameSnapshot(a, b) {
    if (!a || !b) return false;
    return a.mode === b.mode && previewDiff.equalsList(a.allowed_issues, b.allowed_issues);
}

// --- Contrato del flow -------------------------------------------------------

/**
 * Validación server-side por step. `false` → la base responde 409 (no cachea:
 * el cliente corrige y reintenta). Algunos chequeos dependen del estado en
 * disco (combos imposibles, drift) — leer estado en validateStep es el patrón
 * ya usado por el wizard de allowlist (paso 3 TOCTOU).
 * @param {number} step
 * @param {object} params
 * @returns {boolean}
 */
function validateStep(step, params) {
    const p = params || {};
    switch (step) {
        case 0: {
            if (!ACTIONS.includes(p.action) || !SCOPES.includes(p.scope)) return false;
            // Forma del input según acción + scope.
            if (p.action === 'pausar') {
                if (p.scope === 'issue') return isPositiveInt(p.issue_id);
                if (p.scope === 'allowlist') return isPositiveIntList(p.issues);
                // pausar + full: válido sólo si no estamos ya en pausa total.
                return partialPause.getPipelineMode().mode !== 'paused';
            }
            // despausar: chequeos dependientes del estado (combos imposibles, CA-2).
            const st = partialPause.getPipelineMode();
            if (p.scope === 'full') return st.mode === 'paused';
            if (p.scope === 'allowlist') return st.mode === 'partial_pause';
            // despausar + issue: el issue debe estar en el allowlist parcial actual.
            if (!isPositiveInt(p.issue_id)) return false;
            return st.mode === 'partial_pause' && st.allowedIssues.includes(toInt(p.issue_id));
        }
        case 1:
            // Preconditions (paso 0) se validan en executeStep (sin session aquí).
            return true;
        case 2: {
            const raw = String(p.motivo == null ? '' : p.motivo);
            if (hasNullByte(raw)) return false;
            const m = normalizeMotivo(raw);
            return m.length >= MOTIVO_MIN && m.length <= MOTIVO_MAX;
        }
        case 3: {
            // confirm1 siempre obligatorio; confirm2 sólo para despausar (acción
            // destructiva → doble confirmación, CA-5). El `action` lo reenvía el
            // cliente para gatear la validación y executeStep lo cruza contra el
            // valor autoritativo de la sesión (anti-downgrade).
            if (p.confirm1 !== true) return false;
            if (p.action === 'despausar' && p.confirm2 !== true) return false;
            // Drift-check (CA-6): el snapshot del cliente (visto en paso 2) debe
            // coincidir con el estado fresco en disco. Si otro operador mutó entre
            // medio → 409.
            return sameSnapshot(currentSnapshot(), p.previous_snapshot);
        }
        default:
            return false;
    }
}

/**
 * Resuelve los issues afectados + dependencias recursivas para el preview del
 * paso 1. Sólo `pausar` con scope issue/allowlist arrastra dependencias.
 * @param {object} s0result
 * @returns {{ issues: number[], openDeps: number[], truncated: boolean, reason: string|null, nodesVisited: number, chains: object }}
 */
function resolveAffected(s0result) {
    const { action, scope, issueId, issues } = s0result;
    if (action === 'despausar' || scope === 'full') {
        const base = scope === 'issue' ? [issueId] : previewDiff.normalizeList(issues);
        return { issues: base, openDeps: [], truncated: false, reason: null, nodesVisited: 0, chains: {} };
    }
    // pausar + issue/allowlist: resolver deps recursivas de cada raíz.
    const roots = scope === 'issue' ? [issueId] : previewDiff.normalizeList(issues);
    const allOpen = [];
    const chains = {};
    let truncated = false;
    let reason = null;
    let nodesVisited = 0;
    for (const root of roots) {
        const res = deps.resolveOpenDeps(root, Object.assign(
            { maxDepth: DEPS_MAX_DEPTH, maxNodes: DEPS_MAX_NODES },
            resolveDepsOpts,
        ));
        for (const d of (res.openDeps || [])) allOpen.push(d);
        if (res.chains) Object.assign(chains, res.chains);
        if (res.truncated) { truncated = true; reason = reason || res.reason || 'truncated'; }
        nodesVisited += res.nodesVisited || 0;
    }
    const allIssues = previewDiff.normalizeList([...roots, ...allOpen]);
    return { issues: allIssues, openDeps: previewDiff.normalizeList(allOpen), truncated, reason, nodesVisited, chains };
}

/**
 * Calcula el allowlist propuesto server-side (autoritativo) para una acción.
 * @param {object} s0result
 * @param {number[]} affectedIssues — salida de resolveAffected (con deps).
 * @param {number[]} previousAllowlist
 * @returns {number[]}
 */
function computeNextAllowlist(s0result, affectedIssues, previousAllowlist) {
    const { action, scope, issueId } = s0result;
    const prev = previewDiff.normalizeList(previousAllowlist);
    if (action === 'pausar') {
        if (scope === 'full') return prev;   // la pausa total no toca el allowlist.
        // issue/allowlist: el allowlist resultante es EXACTAMENTE el set elegido +
        // sus deps (reemplaza). "Pausá todo excepto estos issues".
        return previewDiff.normalizeList(affectedIssues);
    }
    // despausar:
    if (scope === 'full') return prev;                       // sólo levanta `.paused`.
    if (scope === 'allowlist') return [];                    // limpia la pausa parcial entera.
    return prev.filter((n) => n !== issueId);                // issue: saca uno del allowlist.
}

/**
 * Ejecuta el step (post-validación). La base cachea el resultado como `ok` y lo
 * devuelve en replays idempotentes. Fallos de precondición o de apply lanzan →
 * 500 (NO se cachean → reintentables).
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
            const action = p.action;
            const scope = p.scope;
            const out = { action, scope };
            if (scope === 'issue') out.issueId = toInt(p.issue_id);
            if (scope === 'allowlist' && Array.isArray(p.issues)) {
                out.issues = previewDiff.normalizeList(p.issues);
            }
            return out;
        }

        case 1: {
            const s0 = steps.get(0);
            if (!s0 || !s0.result) throw new Error('precondition: falta el paso 0');
            const affected = resolveAffected(s0.result);
            const current = partialPause.getPipelineMode();
            const nextAllowlist = computeNextAllowlist(s0.result, affected.issues, current.allowedIssues);
            const resultingMode = s0.result.action === 'pausar' && s0.result.scope === 'full'
                ? 'paused'
                : (s0.result.action === 'despausar' && s0.result.scope === 'full'
                    // despausar full → cae a lo que quede de la pausa parcial.
                    ? modeForAllowlist(current.allowedIssues, current.allowedSkills)
                    : modeForAllowlist(nextAllowlist, current.allowedSkills));
            return {
                action: s0.result.action,
                scope: s0.result.scope,
                affected: affected.issues,
                openDeps: affected.openDeps,
                truncated: affected.truncated,
                reason: affected.reason,
                nodesVisited: affected.nodesVisited,
                chains: affected.chains,
                next_allowlist: nextAllowlist,
                resulting_mode: resultingMode,
            };
        }

        case 2: {
            const s0 = steps.get(0);
            const s1 = steps.get(1);
            if (!s0 || !s0.result || !s1 || !s1.result) throw new Error('precondition: faltan pasos previos');
            const motivo = normalizeMotivo(p.motivo);
            const previous = previewDiff.normalizeList(partialPause.readPreviousAllowlist());
            const diff = previewDiff(previous, s1.result.next_allowlist);
            // `previous_snapshot` lo reenvía el cliente en el paso 3 (guard anti-drift).
            return {
                motivo,
                previous_snapshot: currentSnapshot(),
                next_allowlist: s1.result.next_allowlist,
                resulting_mode: s1.result.resulting_mode,
                diff,
            };
        }

        case 3: {
            const s0 = steps.get(0);
            const s1 = steps.get(1);
            const s2 = steps.get(2);
            if (!s0 || !s0.result || !s1 || !s1.result || !s2 || !s2.result) {
                throw new Error('precondition: faltan pasos previos');
            }
            const { action, scope, issueId } = s0.result;
            // Anti-downgrade: el `action` echo del cliente debe coincidir con el
            // autoritativo de la sesión, y la despausa exige el segundo check.
            if (p.action !== action) throw new Error('precondition: action mismatch');
            if (action === 'despausar' && p.confirm2 !== true) {
                throw new Error('precondition: despausar requiere doble confirmación');
            }
            const motivo = s2.result.motivo;
            // Recálculo autoritativo server-side (no confiar en lo cacheado del cliente).
            const current = partialPause.getPipelineMode();
            const affected = resolveAffected(s0.result);
            const nextAllowlist = computeNextAllowlist(s0.result, affected.issues, current.allowedIssues);
            const recursividadAplicada = action === 'pausar'
                && (scope === 'issue' || scope === 'allowlist')
                && Array.isArray(affected.openDeps) && affected.openDeps.length > 0;

            const extra = {
                wizard_flow: FLOW,
                via: VIA,
                scope,
                wizard_action: action,
                recursividad_aplicada: recursividadAplicada,
                recursive_truncated: !!affected.truncated,
                recursive_reason: affected.reason || null,
            };
            const gateOpts = {
                source: SOURCE,
                authorizedBy: AUTHORIZED_BY,
                justification: motivo,
                extra,
            };

            let apply;
            let resultingMode;
            if (action === 'pausar') {
                if (scope === 'full') {
                    apply = partialPause.setFullPause(gateOpts);
                    resultingMode = 'paused';
                } else {
                    // Preservar allowed_skills no manipulado por el wizard (#3680 CA-14).
                    apply = partialPause.setPartialPause(nextAllowlist, Object.assign({
                        allowedSkills: current.allowedSkills,
                    }, gateOpts));
                    resultingMode = modeForAllowlist(nextAllowlist, current.allowedSkills);
                }
            } else { // despausar
                if (scope === 'full') {
                    apply = partialPause.clearFullPause(gateOpts);
                } else if (scope === 'allowlist') {
                    apply = partialPause.clearPartialPause(gateOpts);
                } else { // issue → saca uno del allowlist (puede vaciarlo → clear)
                    apply = partialPause.setPartialPause(nextAllowlist, Object.assign({
                        allowedSkills: current.allowedSkills,
                    }, gateOpts));
                }
                resultingMode = partialPause.getPipelineMode().mode;
            }

            if (!apply || apply.rejected === true || apply.ok === false) {
                throw new Error('apply_rejected: ' + (apply && apply.msg ? apply.msg : 'gate'));
            }
            return {
                ok: true,
                action,
                scope,
                applied: nextAllowlist,
                resulting_mode: resultingMode,
                diff: s2.result.diff,
            };
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
    VIA,
    ACTIONS,
    SCOPES,
    flowDef,
    register,
    validateStep,
    executeStep,
    resolveAffected,
    computeNextAllowlist,
    modeForAllowlist,
    isPositiveInt,
    isPositiveIntList,
    _setForTests,
    _resetForTests,
};

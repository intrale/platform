// =============================================================================
// wizards/pausa/index.js — Flow "Pausar / despausar issues parciales" (#3741).
//
// Split de #3715 / paraguas #3669. Wizard paso-a-paso para la operación más
// sensible del Pulpo: activar / desactivar la pausa del pipeline con preview de
// impacto, dependencias recursivas, drift-check y doble confirmación para la
// dirección destructiva (despausar). Se registra en la infra de #3724
// (`wizard-session.js`) vía `registerFlow('pausa', {...})`.
//
// CONTRATO REAL (#3724): el flow aporta SOLO `{maxStep, validateStep, executeStep}`.
// La base resuelve CSRF (HttpOnly+HMAC), Origin/Sec-Fetch allowlist, rate-limit
// (30/min por Origin), idempotencia por (session, step) — que cubre el replay del
// `confirm_token` de un solo uso sin store propio —, timeout 15min y el audit
// NDJSON de cada step. Por eso este módulo NO maneja req/res ni tokens
// directamente (a diferencia del snippet hipotético del architect, que asumía
// endpoints `/step/{1,2,3}` y un `wizard-pausa-session.js` aparte: la base
// mergeada por #3724 los hizo innecesarios).
//
// Pasos (0-indexados según la base, mapeados a los 3 pasos de UI del mockup UX):
//   0 — acción (pausar|despausar) + scope (issue|allowlist|full).      (UI "Paso 1")
//   1 — preview: deps recursivas + estado resultante + snapshot drift. (UI "Paso 2")
//   2 — doble confirmación + drift-check + audit-then-apply.           (UI "Paso 3")
//
// INVARIANTE audit-then-apply (CA-7/CA-11): las mutaciones pasan EXCLUSIVAMENTE
// por el gate #3625 (`setPartialPause` / `clearPartialPause` / `setFullPause` /
// `resumeAll`), que audita ANTES de escribir. Nunca se invoca `appendMutation`
// directo ni se escribe `.partial-pause.json` / `.paused` a mano. El contexto del
// wizard (`via: 'wizard-pausa'`, scope, action) viaja por `opts.extra` → una sola
// entry autoritativa, sin doble-audit.
//
// `authorizedBy` se deriva SERVER-SIDE de la constante del enum cerrado
// (`partial-pause-audit.AUTHORIZED_BY_STATIC`), NUNCA del body (CA-8): el handler
// ignora cualquier `params.authorizedBy`.
//
// Sin deps npm: sólo módulos del pipeline.
// =============================================================================
'use strict';

const { escapeHtmlText } = require('../../escape-html');

// Dependencias inyectables (defaults = módulos reales del pipeline). Los tests
// las sustituyen con `_setForTests` para no tocar gh ni el FS real.
let deps = require('../../partial-pause-deps');
let partialPause = require('../../partial-pause');

// Opts extra para `resolveOpenDeps` (tests inyectan ghRunner / cacheFile).
let resolveDepsOpts = {};

// --- Constantes --------------------------------------------------------------
const FLOW = 'pausa';
const MAX_STEP = 2;
const VIA = 'wizard-pausa';                  // CA-11 — campo `via` del audit log.
const MOTIVO_MIN = 10;
const MOTIVO_MAX = 500;                       // alineado con MAX_JUSTIFICATION_LEN del audit.
const DEPS_MAX_DEPTH = 10;
const DEPS_MAX_NODES = 200;
const SOURCE = 'dashboard:wizard:pausa';      // enum KNOWN_SOURCES del audit (#3741).
const AUTHORIZED_BY = 'commander:leo';        // enum estático de partial-pause-audit (server-side).

const ACTIONS = Object.freeze(['pausar', 'despausar']);
const SCOPES = Object.freeze(['issue', 'allowlist', 'full']);

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

function normalizeList(arr) {
    const out = (Array.isArray(arr) ? arr : [])
        .map(toInt)
        .filter((n) => Number.isInteger(n) && n > 0);
    return [...new Set(out)].sort((a, b) => a - b);
}

function equalsList(a, b) {
    const x = normalizeList(a);
    const y = normalizeList(b);
    if (x.length !== y.length) return false;
    return x.every((n, i) => n === y[i]);
}

function normalizeMotivo(s) {
    return String(s == null ? '' : s).normalize('NFC');
}

function hasNullByte(s) {
    return String(s == null ? '' : s).indexOf('\x00') >= 0;
}

function motivoValid(raw) {
    if (hasNullByte(raw)) return false;
    const m = normalizeMotivo(raw);
    return m.length >= MOTIVO_MIN && m.length <= MOTIVO_MAX;
}

/**
 * Firma estable del estado del pipeline para el drift-check (CA-6).
 * Combina `mode` + allowlist de issues + allowed_skills. Comparar firmas evita
 * falsos negativos por orden y cubre las 3 dimensiones del estado.
 * @param {{mode:string, allowedIssues?:number[], allowedSkills?:string[]}} mode
 * @returns {string}
 */
function stateSignature(mode) {
    const m = mode || {};
    const issues = normalizeList(m.allowedIssues).join(',');
    const skills = [...new Set((Array.isArray(m.allowedSkills) ? m.allowedSkills : []).map(String))]
        .sort()
        .join(',');
    return `${m.mode || 'unknown'}|i:${issues}|s:${skills}`;
}

/**
 * Calcula el modo resultante a partir del estado propuesto (server-side,
 * autoritativo). Respeta `feedback_partial-pause-empty-not-block` (CA-12):
 * allowlist vacía + allowed_skills no vacío == `partial_pause`, NO `paused`.
 * @param {{full?:boolean, allowlist?:number[], allowedSkills?:string[]}} proposed
 * @returns {'running'|'paused'|'partial_pause'}
 */
function computeResultingMode(proposed) {
    if (proposed.full === true) return 'paused';
    const hasIssues = normalizeList(proposed.allowlist).length > 0;
    const hasSkills = Array.isArray(proposed.allowedSkills) && proposed.allowedSkills.length > 0;
    return (hasIssues || hasSkills) ? 'partial_pause' : 'running';
}

/**
 * Construye la allowlist propuesta server-side según action + scope.
 *   pausar  + issue     → unión(previous, [issue, ...deps]).
 *   pausar  + allowlist → unión([...issues, ...deps]) (reemplazo del set).
 *   despausar + issue   → previous sin el issue.
 *   despausar + allowlist/full → [] (clear / resume lo resuelve el apply).
 * @returns {number[]}
 */
function computeAllowlist(action, scope, issueId, issues, resolvedIssues, previous) {
    const prev = normalizeList(previous);
    if (action === 'pausar') {
        if (scope === 'full') return [];
        if (scope === 'issue') return normalizeList([...prev, ...resolvedIssues]);
        // scope === 'allowlist' → reemplaza el set por los issues + sus deps.
        return normalizeList(resolvedIssues);
    }
    // despausar
    if (scope === 'issue') return prev.filter((n) => n !== issueId);
    return [];
}

// --- Contrato del flow -------------------------------------------------------

/**
 * Validación server-side por step. `false` → la base responde 409 (no cachea:
 * el cliente puede corregir y reintentar). Bajo el contrato real de #3724 las
 * validaciones de input colapsan a 409; el código de error específico (DRIFT,
 * combinación inválida) viaja en el render de la SPA, no en el status HTTP.
 * @param {number} step
 * @param {object} params
 * @returns {boolean}
 */
function validateStep(step, params) {
    const p = params || {};
    switch (step) {
        case 0: {
            if (!ACTIONS.includes(p.action) || !SCOPES.includes(p.scope)) return false;
            if (p.scope === 'issue' && !isPositiveInt(p.issue_id)) return false;
            if (p.scope === 'allowlist' && p.action === 'pausar') {
                // Pausar por allowlist exige al menos un issue.
                if (normalizeList(p.issues).length === 0) return false;
            }
            // Combinación imposible: despausar sin pausa activa (CA-2).
            if (p.action === 'despausar') {
                const mode = partialPause.getPipelineMode().mode;
                if (mode === 'running') return false;
                if (p.scope === 'full' && mode !== 'paused') return false;
            }
            return true;
        }
        case 1:
            // Precondición (paso 0) se valida en executeStep (sin acceso a session aquí).
            return true;
        case 2: {
            // Doble confirmación: confirm1 siempre; confirm2 sólo para despausar.
            if (p.confirm1 !== true) return false;
            // El motivo es obligatorio para despausar (destructiva); para pausar,
            // si viene se valida igual (defensa en profundidad).
            if (p.action === 'despausar') {
                if (p.confirm2 !== true) return false;
                if (!motivoValid(p.motivo)) return false;
            } else if (p.motivo != null && p.motivo !== '') {
                if (!motivoValid(p.motivo)) return false;
            }
            // Drift-check (CA-6): el cliente reenvía la firma del estado que vio en
            // el paso 1; si el estado en disco cambió desde entonces → 409 DRIFT.
            const fresh = stateSignature(partialPause.getPipelineMode());
            return fresh === String(p.previous_snapshot == null ? '' : p.previous_snapshot);
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
            const action = p.action;
            const scope = p.scope;
            const issueId = scope === 'issue' ? toInt(p.issue_id) : null;
            const issues = scope === 'allowlist' ? normalizeList(p.issues) : [];
            return { action, scope, issueId, issues };
        }

        case 1: {
            const s0 = steps.get(0);
            if (!s0 || !s0.result) throw new Error('precondition: falta el paso 0');
            const { action, scope, issueId, issues } = s0.result;

            // Snapshot del estado actual (para el drift-check del paso 2).
            const snapshot = partialPause.getPipelineMode();
            const previous = partialPause.readPreviousAllowlist();
            const allowedSkills = Array.isArray(snapshot.allowedSkills) ? snapshot.allowedSkills : [];

            // Resolución recursiva de dependencias (sólo cuando pausamos sumando
            // issues a la allowlist). NO se reimplementa: viene de partial-pause-deps.
            let resolvedIssues = [];
            let affected = [];
            let truncated = false;
            let reason = null;
            let nodesVisited = 0;

            const needsDeps = action === 'pausar' && (scope === 'issue' || scope === 'allowlist');
            if (needsDeps) {
                const roots = scope === 'issue' ? [issueId] : issues;
                const seen = new Set();
                for (const root of roots) {
                    const res = deps.resolveOpenDeps(root, Object.assign(
                        { maxDepth: DEPS_MAX_DEPTH, maxNodes: DEPS_MAX_NODES },
                        resolveDepsOpts,
                    ));
                    truncated = truncated || !!res.truncated;
                    reason = reason || res.reason || null;
                    nodesVisited += res.nodesVisited || 0;
                    const chains = res.chains || {};
                    const localOrder = [root, ...(res.openDeps || [])];
                    for (const num of localOrder) {
                        const n = toInt(num);
                        if (!Number.isInteger(n) || n <= 0 || seen.has(n)) continue;
                        seen.add(n);
                        const chain = chains[String(n)] || {};
                        affected.push({
                            number: n,
                            // CA-10: el título viene crudo de GitHub; se escapa SIEMPRE
                            // antes de exponerlo al render (defensa server-side).
                            title_safe: escapeHtmlText(chain.title || ''),
                            via_dep: n !== root && !roots.includes(n),
                        });
                    }
                }
                resolvedIssues = [...seen];
            }

            const finalAllowlist = computeAllowlist(action, scope, issueId, issues, resolvedIssues, previous);
            const proposed = {
                full: action === 'pausar' && scope === 'full',
                allowlist: action === 'despausar' ? finalAllowlist : finalAllowlist,
                // `allowed_skills` se preserva siempre (CA-14) salvo despausa total.
                allowedSkills: (action === 'despausar' && scope === 'full') ? [] : allowedSkills,
            };
            const resultingMode = computeResultingMode(proposed);

            return {
                action,
                scope,
                issueId,
                affected,
                resolvedIssues,
                finalAllowlist,
                allowedSkills,
                resultingMode,
                truncated,
                reason,
                nodesVisited,
                snapshotMode: snapshot.mode,
                snapshotSignature: stateSignature(snapshot),
            };
        }

        case 2: {
            const s0 = steps.get(0);
            const s1 = steps.get(1);
            if (!s0 || !s0.result || !s1 || !s1.result) {
                throw new Error('precondition: faltan pasos previos');
            }
            const { action, scope, issueId } = s0.result;
            const { resolvedIssues } = s1.result;
            const motivo = (p.motivo != null && p.motivo !== '')
                ? normalizeMotivo(p.motivo)
                : `Wizard pausa: ${action} (${scope})`;

            // Recálculo autoritativo server-side (no confiar en lo cacheado del cliente).
            const snapshot = partialPause.getPipelineMode();
            const previous = partialPause.readPreviousAllowlist();
            const allowedSkills = Array.isArray(snapshot.allowedSkills) ? snapshot.allowedSkills : [];
            const finalAllowlist = computeAllowlist(action, scope, issueId, s0.result.issues, resolvedIssues, previous);

            // Contexto del audit log (CA-11): una sola entry rica vía `extra`.
            const extra = {
                via: VIA,
                wizard_flow: FLOW,
                action,
                scope,
                issues_afectados: action === 'despausar' && scope !== 'issue' ? previous : finalAllowlist,
                recursividad_aplicada: action === 'pausar' && Array.isArray(resolvedIssues) && resolvedIssues.length > 1,
            };
            const auditOpts = { source: SOURCE, authorizedBy: AUTHORIZED_BY, justification: motivo, extra };

            let result;
            let applied;
            if (action === 'pausar') {
                if (scope === 'full') {
                    result = partialPause.setFullPause(auditOpts);
                    applied = { mode: 'paused' };
                } else {
                    // Preserva allowed_skills no manipulado por el wizard (CA-14).
                    result = partialPause.setPartialPause(finalAllowlist, Object.assign({}, auditOpts, { allowedSkills }));
                    applied = { mode: 'partial_pause', allowedIssues: finalAllowlist };
                }
            } else { // despausar
                if (scope === 'full') {
                    result = partialPause.resumeAll(auditOpts);
                    applied = { mode: 'running' };
                } else if (scope === 'allowlist') {
                    result = partialPause.clearPartialPause(auditOpts);
                    applied = { mode: 'running' };
                } else { // despausar issue puntual
                    if (finalAllowlist.length === 0 && allowedSkills.length === 0) {
                        result = partialPause.clearPartialPause(auditOpts);
                        applied = { mode: 'running' };
                    } else {
                        result = partialPause.setPartialPause(finalAllowlist, Object.assign({}, auditOpts, { allowedSkills }));
                        applied = { mode: 'partial_pause', allowedIssues: finalAllowlist };
                    }
                }
            }

            if (!result || result.rejected === true || result.ok === false) {
                throw new Error('apply_rejected: ' + (result && result.msg ? result.msg : 'gate'));
            }
            return { ok: true, action, scope, applied, resultingMode: applied.mode };
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
    VIA,
    MOTIVO_MIN,
    MOTIVO_MAX,
    DEPS_MAX_DEPTH,
    DEPS_MAX_NODES,
    SOURCE,
    AUTHORIZED_BY,
    ACTIONS,
    SCOPES,
    flowDef,
    register,
    validateStep,
    executeStep,
    computeAllowlist,
    computeResultingMode,
    stateSignature,
    normalizeList,
    equalsList,
    isPositiveInt,
    motivoValid,
    _setForTests,
    _resetForTests,
};

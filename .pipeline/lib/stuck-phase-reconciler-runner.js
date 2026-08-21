// =============================================================================
// stuck-phase-reconciler-runner.js — Integración FS del reconciler de fases
// varadas (#4614). Arma el CONTEXTO real (deliverables + liveness + cross-phase
// + retry state) desde el filesystem del pipeline y ejecuta el plan.
//
// Todo el IO entra por `deps` inyectables → el flujo end-to-end se testea con
// mocks, sin tocar el FS real. `pulpo.js` cablea los deps reales y lo llama en
// un tick throttled.
//
// Liveness (Arq P1-3): un `pendiente/` siempre cuenta como vivo; un `trabajando/`
// cuenta como vivo SOLO si `deps.livenessOk(name, mtimeMs)` (mtime reciente / PID
// vivo). Un `trabajando/` huérfano de agente muerto NO cuenta → la fase se cura.
// =============================================================================

'use strict';

const { planReconciliation, executeDecisions } = require('./stuck-phase-reconciler');

const DELIVERABLE_STATES = ['listo', 'procesado', 'archivado'];
const LIVE_STATES = ['pendiente', 'trabajando'];

function issueFromName(name) { return String(name).split('.')[0]; }
function skillFromName(name) { const p = String(name).split('.'); return p.length > 1 ? p[1] : null; }

/**
 * Arma el contexto de issues varados desde el FS (vía deps).
 * @returns {Array} issues para planReconciliation
 */
function buildIssuesContext(deps) {
    const out = [];
    const phases = Array.isArray(deps.parallelPhases) ? deps.parallelPhases : [];

    for (const { pipeline, fase } of phases) {
        const required = deps.requiredSkillsFor(pipeline, fase);
        if (!Array.isArray(required) || required.length === 0) continue;

        const map = new Map(); // issue → { deliverables:[], liveSkills:Set }
        const ensure = (issue) => {
            if (!map.has(issue)) map.set(issue, { deliverables: [], liveSkills: new Set() });
            return map.get(issue);
        };

        // Deliverables (listo/procesado/archivado).
        for (const state of DELIVERABLE_STATES) {
            for (const f of (deps.listPhaseFiles(pipeline, fase, state) || [])) {
                const issue = issueFromName(f.name);
                const skill = skillFromName(f.name);
                if (!issue || !skill) continue;
                ensure(issue).deliverables.push({
                    skill, state,
                    yaml: deps.readYaml(pipeline, fase, state, f.name),
                    mtimeMs: f.mtimeMs,
                });
            }
        }

        // Live skills: pendiente siempre vivo; trabajando solo si liveness OK.
        for (const state of LIVE_STATES) {
            for (const f of (deps.listPhaseFiles(pipeline, fase, state) || [])) {
                const issue = issueFromName(f.name);
                const skill = skillFromName(f.name);
                if (!issue || !skill) continue;
                const alive = state === 'pendiente' || deps.livenessOk(f.name, f.mtimeMs);
                if (!alive) continue; // trabajando huérfano → no cuenta (P1-3)
                ensure(issue).liveSkills.add(skill);
            }
        }

        for (const [issue, data] of map) {
            // Un issue sin deliverables (solo pendiente/trabajando) lo maneja el
            // flujo normal, no el reconciler.
            if (data.deliverables.length === 0) continue;
            const retryKey = `${issue}|${fase}`;
            // #5396 — `hasNeedsHuman` ya no es booleano: devuelve el ORIGEN de la
            // supresión (`'marker'|'cola'|'cache-label'|'cache-desconocida'|false`)
            // para que el dedupe sea auditable y `cache-desconocida` (fail-closed)
            // se distinga de un dedupe legítimo. Un dep legacy que devuelva boolean
            // sigue funcionando: `needsHumanSource` queda en null.
            const nh = deps.hasNeedsHuman(issue);
            out.push({
                issue: Number(issue),
                pipeline, fase,
                requiredSkills: required,
                deliverables: data.deliverables,
                liveSkills: data.liveSkills,
                liveElsewhere: !!deps.issueLiveElsewhere(issue, pipeline, fase),
                hasNeedsHuman: !!nh,
                needsHumanSource: (typeof nh === 'string' && nh) ? nh : null,
                retryCounts: (deps.retryState && deps.retryState[retryKey]) || {},
                allowed: deps.isAllowed ? !!deps.isAllowed(issue) : true,
                // active: solo actuar sobre issues confirmados OPEN (no residuo
                // de cerrados). Sin dep → asume activo (para tests puros).
                active: deps.isIssueOpen ? !!deps.isIssueOpen(issue) : true,
                isMonoSkill: false, // los phases mono-skill no se pasan en parallelPhases
            });
        }
    }
    return out;
}

/**
 * Corre una pasada del reconciler. Deps inyectables (ver pulpo.js para el cableado).
 * @returns {{requeued:number, escalated:number, skipped:number, decisions:Array}}
 */
function runStuckPhaseReconciler(deps, opts = {}) {
    deps.retryState = (deps.loadRetryState && deps.loadRetryState()) || {};

    const issues = buildIssuesContext(deps);
    if (issues.length === 0) {
        // #5396 CA-7 — el agregado viaja SIEMPRE, incluso en el tick vacío: el
        // caller loguea `evaluados: 0` y así se distingue "no había nada varado"
        // de "el reconciler está muerto".
        return {
            requeued: 0, escalated: 0, rebotes: 0, skipped: 0, decisions: [],
            evaluados: 0,
            suppressed: { ola: 0, cache: 0, dedupe: 0, cerrado: 0, otro: 0 },
        };
    }

    const { decisions, retryUpdates } = planReconciliation({
        issues,
        nowMs: Number.isFinite(deps.nowMs) ? deps.nowMs : Date.now(),
        paused: deps.isPaused ? !!deps.isPaused() : false,
        maxRequeueAttempts: opts.maxRequeueAttempts,
        capPerTick: opts.capPerTick,
        staleThresholdMs: opts.staleThresholdMs,
        // #6296 — resolutor del destino del rebote por severidad. Si el cableado
        // no lo provee, el plan cae a `escalate` (fail-closed), nunca inventa fase.
        resolveRebote: deps.resolveRebote,
    });

    const summary = executeDecisions(decisions, {
        requeueWorkItem: deps.requeueWorkItem,
        escalate: deps.escalate,
        // #6296 — materialización del rebote grave y publicación de la
        // observación del carril leve.
        rebote: deps.rebote,
        publicarObservacion: deps.publicarObservacion,
        notify: deps.notify,
        audit: deps.audit,
        workItemExists: deps.workItemExists,
        issueTitle: deps.issueTitle,
    });

    // Persistir contadores de reintento (merge). Clave de retryUpdates:
    // `${issue}|${fase}|${skill}` → nuevo count.
    let changed = false;
    for (const [key, val] of Object.entries(retryUpdates)) {
        const idx1 = key.indexOf('|');
        const idx2 = key.indexOf('|', idx1 + 1);
        const issue = key.slice(0, idx1);
        const fase = key.slice(idx1 + 1, idx2);
        const skill = key.slice(idx2 + 1);
        const k = `${issue}|${fase}`;
        deps.retryState[k] = deps.retryState[k] || {};
        deps.retryState[k][skill] = val;
        changed = true;
    }
    // Limpieza: al re-encolar o escalar exitosamente, los contadores viejos de un
    // issue que ya salió de la fase se podan por el caller (no acá) para no perder
    // el histórico dentro de una misma corrida.
    if (changed && deps.saveRetryState) deps.saveRetryState(deps.retryState);

    return { ...summary, decisions };
}

module.exports = { runStuckPhaseReconciler, buildIssuesContext };

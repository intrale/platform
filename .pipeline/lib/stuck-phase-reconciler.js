// =============================================================================
// stuck-phase-reconciler.js — Reconciliador de fases varadas (#4614, parte B de
// #4612). Envuelve al detector puro (`stuck-phase-detector`) con TODAS las
// guardas de seguridad exigidas por el review de arquitecto + PO antes de tocar
// el estado real del pipeline.
//
// Separado en dos capas para testeo exhaustivo:
//   1. `planReconciliation(ctx)`  → PURO. Dado el estado completo (issues +
//      deliverables + liveness + retry counts + flags), produce una lista de
//      DECISIONES (`requeue`/`escalate`/`none`). Sin IO. Acá viven las guardas.
//   2. `executeDecisions(decisions, deps)` → shell de IO (escribe work-items,
//      escala needs-human, notifica, audita). Deps inyectables → mockeable.
//
// GUARDAS (review):
//   - Cross-phase (Arq P0-2): issue vivo en OTRA fase → `none` (evita doble-track
//     con el issue que ya rebotó a `dev`).
//   - Mono-skill (Arq P0-1): fases `dev`/`build`/`entrega` corren 1 solo skill
//     ruteado por labels → el reconciler NO las toca (evita lanzar devs errados).
//   - Cap de reintentos persistente (Arq P0-3 + PO SG-1): máx N requeue por
//     (issue,fase,skill); al agotarse → `escalate`. El contador lo persiste el
//     shell (sobrevive restarts).
//   - Dedupe de escalate (Arq P1-1): no re-escalar si ya tiene `needs-human`.
//   - Cap por tick + orden determinista (Arq P2-3 + PO SG-4): máx N acciones por
//     corrida, issues en orden asc (sin starvation).
//   - Respetar pausa/allowlist (PO SG-5): en `.paused` o fuera de allowlist NO
//     re-encola (no spawnea agentes); escalar/notificar sí está permitido.
//   - Liveness real (Arq P1-3): el shell construye `liveSkills`/`liveElsewhere`
//     validando mtime/PID; un `trabajando/` huérfano NO cuenta como vivo.
//   - Nunca fabricar aprobaciones (PO línea roja): solo re-encola (re-corre el
//     agente) o escala; jamás escribe `resultado: aprobado`.
// =============================================================================

'use strict';

const { analyzeStuckIssue } = require('./stuck-phase-detector');

const DEFAULT_MAX_REQUEUE_ATTEMPTS = 2;
const DEFAULT_CAP_PER_TICK = 5;
const MONO_SKILL_PHASES = new Set(['dev', 'build', 'entrega']);

/**
 * Decide la acción efectiva para UN issue aplicando las guardas.
 * @returns {{action:'requeue'|'escalate'|'none', skills?:string[], reason:string, consumesTick:boolean}}
 */
function decideForIssue(it, cfg) {
    const base = (action, reason, extra) => ({ action, reason, consumesTick: false, ...extra });

    // Guard mono-skill (Arq P0-1)
    if (cfg.monoSkillPhases.has(it.fase) || it.isMonoSkill) {
        return base('none', 'fase-mono-skill');
    }
    // Guard cross-phase (Arq P0-2)
    if (it.liveElsewhere) {
        return base('none', 'vivo-en-otra-fase');
    }

    const analysis = analyzeStuckIssue({
        requiredSkills: it.requiredSkills || [],
        deliverables: it.deliverables || [],
        liveSkills: it.liveSkills || new Set(),
        nowMs: cfg.nowMs,
        staleThresholdMs: Number.isFinite(it.staleThresholdMs) ? it.staleThresholdMs : cfg.staleThresholdMs,
    });

    if (analysis.action === 'none') return base('none', analysis.reason);

    if (analysis.action === 'escalate') {
        if (it.hasNeedsHuman) return base('none', 'ya-escalado (dedupe)');
        return base('escalate', analysis.reason, { consumesTick: true });
    }

    // requeue
    const retryCounts = it.retryCounts || {};
    const skills = analysis.requeueSkills || [];
    const capped = skills.filter((s) => (retryCounts[s] || 0) >= cfg.maxRequeueAttempts);
    if (capped.length > 0) {
        // Skill(s) agotaron reintentos → escalar (no re-encolar para siempre, Arq P0-3).
        if (it.hasNeedsHuman) return base('none', 'tope-reintentos + ya-escalado (dedupe)');
        return base('escalate', `tope de reintentos (${cfg.maxRequeueAttempts}) alcanzado para: ${capped.join(',')}`, { consumesTick: true });
    }
    // Pausa / allowlist: no re-encolar (no spawnear), PO SG-5.
    if (cfg.paused) return base('none', 'pipeline-en-pausa (no re-encola)');
    if (it.allowed === false) return base('none', 'issue-fuera-de-allowlist (no re-encola)');

    return base('requeue', analysis.reason, { skills, consumesTick: true });
}

/**
 * PURO: plan de reconciliación para un set de issues varados.
 * @param {object} ctx
 * @param {Array} ctx.issues  [{issue,pipeline,fase,requiredSkills,deliverables,liveSkills,liveElsewhere,hasNeedsHuman,retryCounts,isMonoSkill,allowed,staleThresholdMs}]
 * @param {number} [ctx.nowMs]
 * @param {number} [ctx.staleThresholdMs]
 * @param {number} [ctx.maxRequeueAttempts]
 * @param {number} [ctx.capPerTick]
 * @param {boolean} [ctx.paused]
 * @param {Set<string>} [ctx.monoSkillPhases]
 * @returns {{decisions:Array, retryUpdates:object}}
 */
function planReconciliation(ctx = {}) {
    const cfg = {
        nowMs: Number.isFinite(ctx.nowMs) ? ctx.nowMs : Date.now(),
        staleThresholdMs: ctx.staleThresholdMs,
        maxRequeueAttempts: Number.isFinite(ctx.maxRequeueAttempts) && ctx.maxRequeueAttempts > 0 ? ctx.maxRequeueAttempts : DEFAULT_MAX_REQUEUE_ATTEMPTS,
        capPerTick: Number.isFinite(ctx.capPerTick) && ctx.capPerTick > 0 ? ctx.capPerTick : DEFAULT_CAP_PER_TICK,
        paused: !!ctx.paused,
        monoSkillPhases: ctx.monoSkillPhases instanceof Set ? ctx.monoSkillPhases : MONO_SKILL_PHASES,
    };

    const issues = Array.isArray(ctx.issues) ? ctx.issues : [];
    // Orden determinista por número de issue asc (evita starvation bajo cap).
    const sorted = [...issues].sort((a, b) => Number(a.issue) - Number(b.issue));

    const decisions = [];
    const retryUpdates = {};
    let actionsThisTick = 0;

    for (const it of sorted) {
        const base = { issue: it.issue, pipeline: it.pipeline, fase: it.fase };
        const d = decideForIssue(it, cfg);

        // Cap por tick: solo las acciones REALES (escalate/requeue) consumen cupo.
        if (d.consumesTick && actionsThisTick >= cfg.capPerTick) {
            decisions.push({ ...base, action: 'none', reason: 'cap-por-tick-alcanzado' });
            continue;
        }

        decisions.push({ ...base, action: d.action, skills: d.skills, reason: d.reason });
        if (d.consumesTick) {
            actionsThisTick += 1;
            if (d.action === 'requeue') {
                for (const s of (d.skills || [])) {
                    retryUpdates[`${it.issue}|${it.fase}|${s}`] = ((it.retryCounts || {})[s] || 0) + 1;
                }
            }
        }
    }

    return { decisions, retryUpdates };
}

/**
 * Shell de IO: ejecuta las decisiones vía deps inyectables. NUNCA fabrica
 * aprobaciones. Cada dep es best-effort: un fallo no aborta el resto.
 * @param {Array} decisions  salida de planReconciliation
 * @param {object} deps
 *   @param {(pipeline,fase,skill,issue)=>void} deps.requeueWorkItem  (idempotente por nombre)
 *   @param {(issue,reason)=>void} deps.escalate  (agrega needs-human, idempotente)
 *   @param {(msg)=>void} [deps.notify]
 *   @param {(record)=>void} [deps.audit]
 *   @param {(pipeline,fase,skill,issue)=>boolean} [deps.workItemExists] re-check idempotente
 * @returns {{requeued:number, escalated:number, skipped:number}}
 */
function executeDecisions(decisions, deps = {}) {
    let requeued = 0, escalated = 0, skipped = 0;
    const audit = (rec) => { try { if (deps.audit) deps.audit(rec); } catch { /* best-effort */ } };
    const notify = (msg) => { try { if (deps.notify) deps.notify(msg); } catch { /* best-effort */ } };

    for (const d of (decisions || [])) {
        if (d.action === 'requeue') {
            for (const skill of (d.skills || [])) {
                try {
                    // Re-check idempotente justo antes de escribir (Arq P1-2): no
                    // duplicar si ya existe el work-item (agente arrancó en paralelo).
                    if (deps.workItemExists && deps.workItemExists(d.pipeline, d.fase, skill, d.issue)) continue;
                    deps.requeueWorkItem(d.pipeline, d.fase, skill, d.issue);
                } catch (e) {
                    audit({ ...d, skill, error: String(e && e.message).slice(0, 120) });
                    continue;
                }
            }
            requeued += 1;
            audit({ action: 'requeue', issue: d.issue, fase: d.fase, skills: d.skills, reason: d.reason });
            notify(`🔧 Self-healing: re-encolé ${(d.skills || []).join(',')} de #${d.issue} (${d.fase}) — ${d.reason}`);
        } else if (d.action === 'escalate') {
            try { deps.escalate(d.issue, d.reason); } catch (e) { audit({ ...d, error: String(e && e.message).slice(0, 120) }); }
            escalated += 1;
            audit({ action: 'escalate', issue: d.issue, fase: d.fase, reason: d.reason });
            notify(`🙋 Self-healing: #${d.issue} (${d.fase}) necesita tu decisión — ${d.reason}`);
        } else {
            skipped += 1;
            // Los `none` se auditan a nivel debug (razón) pero no notifican.
            audit({ action: 'none', issue: d.issue, fase: d.fase, reason: d.reason });
        }
    }
    return { requeued, escalated, skipped };
}

module.exports = {
    planReconciliation,
    executeDecisions,
    decideForIssue,
    MONO_SKILL_PHASES,
    DEFAULT_MAX_REQUEUE_ATTEMPTS,
    DEFAULT_CAP_PER_TICK,
};

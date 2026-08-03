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
// #5396 CA-7 — causas de silencio que el tick reporta por separado.
const SUPPRESSION_BUCKETS = new Set(['ola', 'cache', 'dedupe', 'cerrado', 'otro']);

/** Normaliza texto libre a una línea (el `reason` interpola nombres de archivo). */
function oneLine(s, max = 220) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * #5396 CA-UX-2 — mensaje de escalación legible para el operador: número,
 * título (sólo si hay entrada FRESCA en caché), fase y la pregunta concreta de
 * destrabe. Sin Markdown — la estructura la dan los saltos de línea y los emojis
 * (CA-8/SEC-4: el `reason` interpola un skill derivado de un nombre de archivo,
 * contenido no confiable, y viaja en texto plano).
 */
function buildEscalationMessage(d, title) {
    const lines = [`🙋 Self-healing: #${d.issue} necesita tu decisión`];
    if (title) lines.push(`📌 ${oneLine(title, 120)}`);
    lines.push(`📂 ${d.pipeline ? `${d.pipeline}/` : ''}${d.fase}`);
    lines.push(`❓ ¿Cómo destrabo #${d.issue}? (rechazo / cancelado / corrupto)`);
    lines.push(`ℹ️ ${oneLine(d.reason)}`);
    return lines.join('\n');
}

/**
 * Decide la acción efectiva para UN issue aplicando las guardas.
 * @returns {{action:'requeue'|'escalate'|'none', skills?:string[], reason:string, consumesTick:boolean}}
 */
function decideForIssue(it, cfg) {
    const base = (action, reason, extra) => ({ action, reason, consumesTick: false, ...extra });

    // Guard mono-skill (Arq P0-1)
    if (cfg.monoSkillPhases.has(it.fase) || it.isMonoSkill) {
        return base('none', 'fase-mono-skill', { suppression: 'otro' });
    }
    // Guard cross-phase (Arq P0-2)
    if (it.liveElsewhere) {
        return base('none', 'vivo-en-otra-fase', { suppression: 'otro' });
    }
    // Guard allowlist: solo la OLA ACTUAL. Los issues fuera de la allowlist son
    // backlog dormido que el operador excluyó a propósito — el reconciler NO los
    // toca (ni requeue ni escalate), sino spamea needs-human sobre issues muertos.
    // (Hallazgo del dry-run contra estado real; endurece PO SG-5.)
    // #5396 CA-3 — el filtro de ola ahora aplica SIEMPRE (antes `isAllowed` sólo
    // se poblaba bajo pausa parcial y fuera de pausa el reconciler barría todo el
    // backlog histórico). `suppression: 'ola'` distingue este silencio del resto.
    if (it.allowed === false) {
        return base('none', 'fuera-de-allowlist (backlog dormido, no tocar)', { suppression: 'ola' });
    }
    // Guard issue-cerrado: las fases se llenan de RESIDUO de issues ya CLOSED/
    // mergeados (work-items stub). Escalar/re-encolar un issue cerrado es ruido.
    // Actuar SOLO sobre issues confirmados OPEN. `active !== true` (cerrado,
    // notFound, o desconocido) → no tocar. (Hallazgo del dry-run: #4510/#4533/#4536
    // CLOSED con residuo se escalaban.)
    if (it.active !== true) {
        return base('none', 'issue-cerrado-o-inactivo (residuo, no tocar)', { suppression: 'cerrado' });
    }

    const analysis = analyzeStuckIssue({
        requiredSkills: it.requiredSkills || [],
        deliverables: it.deliverables || [],
        liveSkills: it.liveSkills || new Set(),
        nowMs: cfg.nowMs,
        staleThresholdMs: Number.isFinite(it.staleThresholdMs) ? it.staleThresholdMs : cfg.staleThresholdMs,
    });

    if (analysis.action === 'none') return base('none', analysis.reason, { suppression: 'otro' });

    // #5396 CA-1/CA-2 — el dedupe deja explícito DE DÓNDE viene la supresión.
    // `needsHumanSource` es el origen que reporta el dep `hasNeedsHuman`:
    //   'marker'            → marker físico en `bloqueado-humano/` (fuente de verdad)
    //   'cola'              → orden de label todavía sin drenar
    //   'cache-label'       → entrada FRESCA del title-cache con el label puesto
    //   'cache-desconocida' → entrada ausente o stale ⇒ fail-closed hacia el
    //                          SILENCIO, nunca hacia el ruido (CA-2)
    const dedupe = (prefix) => {
        const src = it.needsHumanSource;
        if (src === 'cache-desconocida') {
            return base('none', 'cache-desconocida', { suppression: 'cache' });
        }
        return base('none', `${prefix} (dedupe: ${src || 'desconocido'})`, { suppression: 'dedupe' });
    };

    if (analysis.action === 'escalate') {
        if (it.hasNeedsHuman) return dedupe('ya-escalado');
        return base('escalate', analysis.reason, { consumesTick: true });
    }

    // requeue
    const retryCounts = it.retryCounts || {};
    const skills = analysis.requeueSkills || [];
    const capped = skills.filter((s) => (retryCounts[s] || 0) >= cfg.maxRequeueAttempts);
    if (capped.length > 0) {
        // Skill(s) agotaron reintentos → escalar (no re-encolar para siempre, Arq P0-3).
        if (it.hasNeedsHuman) return dedupe('tope-reintentos + ya-escalado');
        return base('escalate', `tope de reintentos (${cfg.maxRequeueAttempts}) alcanzado para: ${capped.join(',')}`, { consumesTick: true });
    }
    // #5396 — un issue con bloqueo humano vigente NO se re-encola. Antes de este
    // issue el dedupe sólo cubría el carril `escalate`, porque `escalate` encolaba
    // el label y casi nunca existía un marker físico. Ahora que `escalate` planta
    // marker vía `reportHumanBlock` (con `moveFromActive: false`, o sea el
    // deliverable sigue en `listo/` y el issue se sigue evaluando), el carril
    // `requeue` pasó a ser alcanzable con un bloqueo vivo: spawnearía un agente
    // sobre un issue que está esperando decisión humana. Eso viola la línea roja
    // del issue ("ante duda: humano"), así que el bloqueo gana sobre el reintento.
    if (it.hasNeedsHuman) return dedupe('bloqueado-humano');

    // Pausa: no re-encolar (no spawnear), PO SG-5. El escalate SÍ sigue permitido
    // para issues de la ola (ya filtrados por allowlist arriba).
    if (cfg.paused) return base('none', 'pipeline-en-pausa (no re-encola)', { suppression: 'otro' });

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
            decisions.push({ ...base, action: 'none', reason: 'cap-por-tick-alcanzado', suppression: 'otro' });
            continue;
        }

        decisions.push({ ...base, action: d.action, skills: d.skills, reason: d.reason, suppression: d.suppression });
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
 *   @param {(issue,reason)=>boolean|void} deps.escalate  false si no pudo registrar needs-human
 *   @param {(msg)=>void} [deps.notify]
 *   @param {(record)=>void} [deps.audit]
 *   @param {(pipeline,fase,skill,issue)=>boolean} [deps.workItemExists] re-check idempotente
 *   @param {(issue)=>string|null} [deps.issueTitle] título para el mensaje (CA-UX-2)
 * @returns {{requeued:number, escalated:number, skipped:number, evaluados:number,
 *            suppressed:{ola:number,cache:number,dedupe:number,cerrado:number,otro:number}}}
 */
function executeDecisions(decisions, deps = {}) {
    let requeued = 0, escalated = 0, skipped = 0;
    // #5396 CA-7 (SEC-3) — desglose de POR QUÉ el tick estuvo callado. Sin esto,
    // "no notificó nada" es indistinguible entre "todo sano" y "el self-healing
    // está muerto" — que es exactamente el estado que nadie detectó en producción.
    const suppressed = { ola: 0, cache: 0, dedupe: 0, cerrado: 0, otro: 0 };
    const audit = (rec) => { try { if (deps.audit) deps.audit(rec); } catch { /* best-effort */ } };
    const notify = (msg, meta) => { try { if (deps.notify) deps.notify(msg, meta); } catch { /* best-effort */ } };
    const titleOf = (issue) => {
        try { return (deps.issueTitle && deps.issueTitle(issue)) || null; } catch { return null; }
    };

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
            notify(
                `🔧 Self-healing: re-encolé ${(d.skills || []).join(',')} de #${d.issue} (${d.fase}) — ${d.reason}`,
                { issue: d.issue, fase: d.fase, pipeline: d.pipeline, action: 'requeue' },
            );
        } else if (d.action === 'escalate') {
            // El escalate necesita `pipeline`/`fase` explícitos: sin ellos
            // `reportHumanBlock` buscaría el work-item activo y podría MOVER el
            // deliverable de `listo/`, destruyendo la evidencia (riesgo #1).
            let escalationSucceeded = false;
            try {
                // `false` es un fallo observable. Se conserva compatibilidad con
                // deps anteriores que no retornaban valor; el cableado real de
                // #5396 retorna true/false explícitamente.
                escalationSucceeded = deps.escalate(d.issue, d.reason, {
                    pipeline: d.pipeline, fase: d.fase,
                }) !== false;
            } catch (e) {
                audit({ ...d, error: String(e && e.message).slice(0, 120) });
            }
            if (!escalationSucceeded) {
                audit({ ...d, error: 'no se pudo registrar el bloqueo humano' });
                skipped += 1;
                continue;
            }
            escalated += 1;
            audit({ action: 'escalate', issue: d.issue, fase: d.fase, reason: d.reason });
            notify(buildEscalationMessage(d, titleOf(d.issue)), {
                issue: d.issue, fase: d.fase, pipeline: d.pipeline, action: 'escalate',
            });
        } else {
            skipped += 1;
            const bucket = SUPPRESSION_BUCKETS.has(d.suppression) ? d.suppression : 'otro';
            suppressed[bucket] += 1;
            // Los `none` se auditan a nivel debug (razón) pero no notifican.
            audit({ action: 'none', issue: d.issue, fase: d.fase, reason: d.reason, suppression: bucket });
        }
    }
    return { requeued, escalated, skipped, suppressed, evaluados: (decisions || []).length };
}

module.exports = {
    planReconciliation,
    executeDecisions,
    decideForIssue,
    buildEscalationMessage,
    SUPPRESSION_BUCKETS,
    MONO_SKILL_PHASES,
    DEFAULT_MAX_REQUEUE_ATTEMPTS,
    DEFAULT_CAP_PER_TICK,
};

// =============================================================================
// stuck-phase-detector.js — Self-healing del estado de fase post-crash (#4614,
// parte B de #4612).
//
// Cuando el Pulpo se cae/reinicia (o un fast-fail-rebote deja artefactos a
// medias), un issue puede quedar VARADO en una fase: tiene deliverables pero la
// fase nunca completa ni avanza, y como el issue "está activo" el intake no lo
// re-admite. Ejemplos reales: #4507 (skill `ux` faltante), #4534 (po/ux
// `cancelado_por: fast-fail-rebote`).
//
// Este módulo es un DETECTOR PURO: dado el estado de una fase para un issue,
// decide una acción SEGURA:
//   - `requeue`  → re-encolar los skills requeridos faltantes/cancelados
//                  (acción segura: re-corre el agente, NO fabrica aprobaciones).
//   - `escalate` → marcar `needs-human` cuando hay un RECHAZO real (no re-encolar
//                  para no loopear) o estado indeterminado.
//   - `none`     → fase completa, hay trabajo vivo, o el deliverable es muy
//                  reciente (aún puede avanzar solo).
//
// Correctitud (CA de #4614): NUNCA auto-completa una fase. `archivado` NO se
// cuenta como "hecho" salvo que el propio artefacto sea `resultado: aprobado`
// (reusa `isApprovedArtifact`, que ya excluye `cancelado_por`). Ante ambigüedad,
// escala a humano.
//
// PURO: sin IO. El caller lee el FS y pasa el estado + `nowMs`.
// =============================================================================

'use strict';

const { isApprovedArtifact } = require('./phase-completion');

const DEFAULT_STALE_THRESHOLD_MS = 15 * 60 * 1000; // 15 min sin avance

/**
 * Clasifica el estado de UN skill requerido en la fase.
 * @param {string} skill
 * @param {Array<{skill:string,state:string,yaml:object,mtimeMs:number}>} deliverables
 * @param {Set<string>} liveSkills  skills en pendiente/trabajando (activos)
 * @returns {{skill:string, status:'live'|'done'|'cancelled'|'rejected'|'corrupt'|'missing', state?:string}}
 */
function classifySkill(skill, deliverables, liveSkills) {
    if (liveSkills.has(skill)) return { skill, status: 'live' };

    // Prioridad listo > procesado > archivado (mismo criterio que la promoción).
    const byState = {};
    for (const d of deliverables) {
        if (d && d.skill === skill && !byState[d.state]) byState[d.state] = d;
    }
    for (const st of ['listo', 'procesado', 'archivado']) {
        const d = byState[st];
        if (!d) continue;
        const y = (d && d.yaml) || {};
        if (isApprovedArtifact(y)) return { skill, status: 'done', state: st };
        if (y.cancelado_por != null && y.cancelado_por !== '') return { skill, status: 'cancelled', state: st };
        if (y.resultado === 'rechazado') return { skill, status: 'rejected', state: st };
        return { skill, status: 'corrupt', state: st }; // presente pero indeterminado
    }
    return { skill, status: 'missing' };
}

/**
 * Analiza un issue en una fase y decide la acción de self-healing.
 * @param {object} args
 * @param {string[]} args.requiredSkills
 * @param {Array<{skill:string,state:string,yaml:object,mtimeMs:number}>} args.deliverables
 * @param {Set<string>|string[]} [args.liveSkills]
 * @param {number} args.nowMs
 * @param {number} [args.staleThresholdMs]
 * @returns {{stuck:boolean, action:'requeue'|'escalate'|'none', requeueSkills?:string[], reason:string}}
 */
function analyzeStuckIssue(args = {}) {
    const requiredSkills = Array.isArray(args.requiredSkills) ? args.requiredSkills : [];
    const deliverables = Array.isArray(args.deliverables) ? args.deliverables : [];
    const liveSkills = args.liveSkills instanceof Set
        ? args.liveSkills
        : new Set(Array.isArray(args.liveSkills) ? args.liveSkills : []);
    const nowMs = Number.isFinite(args.nowMs) ? args.nowMs : Date.now();
    const staleThresholdMs = Number.isFinite(args.staleThresholdMs) && args.staleThresholdMs > 0
        ? args.staleThresholdMs : DEFAULT_STALE_THRESHOLD_MS;

    if (requiredSkills.length === 0) return { stuck: false, action: 'none', reason: 'sin-skills-requeridos' };

    const classes = requiredSkills.map((s) => classifySkill(s, deliverables, liveSkills));
    const done = classes.filter((c) => c.status === 'done');
    const live = classes.filter((c) => c.status === 'live');
    const rejected = classes.filter((c) => c.status === 'rejected');
    const corrupt = classes.filter((c) => c.status === 'corrupt');
    const cancelled = classes.filter((c) => c.status === 'cancelled');
    const missing = classes.filter((c) => c.status === 'missing');

    // Fase completa → no stuck (la promoción normal debería llevarlo).
    if (done.length === requiredSkills.length) return { stuck: false, action: 'none', reason: 'completo' };
    // Hay trabajo vivo (encolado/corriendo) → no interferir.
    // NOTA: el caller DEBE construir `liveSkills` con liveness real (mtime reciente
    // o PID vivo); un `trabajando/` huérfano de agente muerto NO debe pasar acá
    // (arquitecto P1-3), sino la fase varada nunca se cura.
    if (live.length > 0) return { stuck: false, action: 'none', reason: 'trabajo-vivo' };

    // Antigüedad: si no hay deliverables, no es un varado de FASE (lo maneja el
    // intake re-admitiendo). Si el más nuevo es reciente, darle tiempo.
    const mtimes = deliverables.map((d) => d && d.mtimeMs).filter(Number.isFinite);
    if (mtimes.length === 0) return { stuck: false, action: 'none', reason: 'sin-deliverables' };
    const age = nowMs - Math.max(...mtimes);
    if (age < staleThresholdMs) return { stuck: false, action: 'none', reason: 'reciente' };

    // AMBIGÜEDAD → escalar a humano, NUNCA re-encolar a ciegas (review PO+arquitecto):
    //   - `rejected`: decisión válida, no es limbo; re-encolar loopearía.
    //   - `cancelled`: un cancelado implica que hubo un rechazo en la fase; puede
    //     estar en doble-track (el caller ya filtró los vivos cross-fase). Solo/humano.
    //   - `corrupt`: verdict ilegible → indeterminado, no re-correr sobre trabajo
    //     posiblemente bueno.
    // La línea roja del PO: jamás auto-completar; ante duda, humano.
    const ambiguous = [...rejected, ...cancelled, ...corrupt];
    if (ambiguous.length > 0) {
        const detail = ambiguous.map((c) => `${c.skill}:${c.status}`).join(',');
        return { stuck: true, action: 'escalate', reason: `ambigüedad (rechazo/cancelado/corrupto): ${detail}` };
    }

    // Único caso de auto-remediación: skill(s) GENUINAMENTE faltante(s) (nunca
    // corrió, no hay artefacto en ningún lado) → re-encolar (re-corre el agente).
    if (missing.length > 0) {
        const skills = missing.map((c) => c.skill);
        return { stuck: true, action: 'requeue', requeueSkills: skills, reason: `re-encolar skills faltantes (nunca corrieron): ${skills.join(',')}` };
    }

    return { stuck: true, action: 'escalate', reason: 'estado indeterminado' };
}

module.exports = { analyzeStuckIssue, classifySkill, DEFAULT_STALE_THRESHOLD_MS };

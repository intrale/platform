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
 * #5641 — Resuelve EL deliverable vigente de un skill (prioridad
 * listo > procesado > archivado, mismo criterio que la promoción).
 *
 * Extraído para que `classifySkill` y `classifyPhase` compartan una única forma
 * de elegir el artefacto. Duplicarla abriría una tercera fuente de verdad, que
 * es exactamente la clase de bug que este módulo viene a cerrar.
 *
 * @returns {{state:string, yaml:object}|null}
 */
function resolveDeliverable(skill, deliverables) {
    const byState = {};
    for (const d of (deliverables || [])) {
        if (d && d.skill === skill && !byState[d.state]) byState[d.state] = d;
    }
    for (const st of ['listo', 'procesado', 'archivado']) {
        const d = byState[st];
        if (d) return { state: st, yaml: (d && d.yaml) || {} };
    }
    return null;
}

/** Exit code del agente, sólo si el veredicto lo sintetizó el Pulpo. */
function exitCodeOf(y) {
    const n = Number(y && y.agente_exit_code);
    return Number.isFinite(n) ? n : null;
}

/**
 * Clasifica el estado de UN skill requerido en la fase.
 * @param {string} skill
 * @param {Array<{skill:string,state:string,yaml:object,mtimeMs:number}>} deliverables
 * @param {Set<string>} liveSkills  skills en pendiente/trabajando (activos)
 * @returns {{skill:string, status:'live'|'done'|'infra-failed'|'cancelled'|'rejected'|'corrupt'|'missing', state?:string, exitCode?:number|null}}
 */
function classifySkill(skill, deliverables, liveSkills) {
    if (liveSkills.has(skill)) return { skill, status: 'live' };

    const found = resolveDeliverable(skill, deliverables);
    if (!found) return { skill, status: 'missing' };
    const { state: st, yaml: y } = found;

    if (isApprovedArtifact(y)) return { skill, status: 'done', state: st };

    // #5641 CA-5 — CAÍDA DE INFRA, no veredicto de contenido.
    //
    // El Pulpo sintetiza `resultado: rechazado` cuando el proceso del agente
    // muere con exit code ≠ 0, y marca ese deliverable con
    // `veredicto_sintetizado_por: 'pulpo'`. Ahí NO hubo decisión de review: el
    // agente nunca llegó a opinar. Contarlo como rechazo frenaba el issue
    // pidiendo humano por algo que el pipeline puede reintentar solo.
    //
    // La guarda va PRIMERA (después de `done`) a propósito — R-2: el drenaje
    // fast-fail hace `writeYaml(dst, { ...prev, cancelado_por })`, un spread que
    // PRESERVA el veredicto previo. Un deliverable con procedencia Y
    // `cancelado_por` caería en `cancelled` con el orden viejo y esta rama sería
    // inalcanzable justo en el shape que motivó el issue.
    //
    // CA-6 / SEC-1 — se discrimina por el CAMPO ESTRUCTURADO, jamás por el texto
    // del `motivo`: ese campo lo escribe el agente. Un rechazo de contenido que
    // CITE el literal `Agente terminó con código 1` sigue siendo `rejected`.
    if (y.veredicto_sintetizado_por === 'pulpo') {
        return { skill, status: 'infra-failed', state: st, exitCode: exitCodeOf(y) };
    }

    if (y.cancelado_por != null && y.cancelado_por !== '') return { skill, status: 'cancelled', state: st };
    if (y.resultado === 'rechazado') return { skill, status: 'rejected', state: st };
    return { skill, status: 'corrupt', state: st }; // presente pero indeterminado
}

/**
 * #5641 CA-9 — Clasifica LA FASE COMPLETA en dos pasadas.
 *
 * POR QUÉ NO ALCANZA `classifySkill`
 * ----------------------------------
 * El re-mapeo `cancelled → missing` depende de la clasificación de OTRO skill de
 * la fase (el que disparó el fast-fail), y `classifySkill(skill, ...)` no puede
 * ver a sus hermanos. Además hay DOS consumidores que deben coincidir:
 * `analyzeStuckIssue` (acá) y `ambiguousSkillsOf` (en el reconciler). Si el
 * re-mapeo viviera sólo en uno, el otro seguiría viendo `cancelled` y los dos
 * gates se desincronizarían — que es el bug de fondo del issue. Por eso ambos
 * consumen esta función.
 *
 * Un hermano drenado por fast-fail NUNCA emitió veredicto propio: su
 * `cancelado_por` es consecuencia, no decisión. Si el que disparó ese drenaje se
 * cayó por infra, el hermano es equivalente a "nunca corrió" ⇒ `missing`.
 *
 * FAIL-CLOSED en las cuatro puertas: sin `fast-fail-rebote`, sin
 * `cancelado_disparador_infra === true` (los deliverables legacy no lo tienen),
 * sin disparadores nombrados, o con un solo disparador que NO sea `infra-failed`
 * ⇒ se mantiene `cancelled` ⇒ escala a humano.
 *
 * PURO: sin IO, sin `require` del clasificador de rebotes (CA-8).
 *
 * @returns {Array} mismas entradas que `classifySkill`, con `remappedFrom` en las re-mapeadas
 */
function classifyPhase(requiredSkills, deliverables, liveSkills) {
    const required = Array.isArray(requiredSkills) ? requiredSkills : [];
    const dels = Array.isArray(deliverables) ? deliverables : [];
    const live = liveSkills instanceof Set
        ? liveSkills
        : new Set(Array.isArray(liveSkills) ? liveSkills : []);

    const first = required.map((s) => classifySkill(s, dels, live));
    const infraFailed = new Set(first.filter((c) => c.status === 'infra-failed').map((c) => c.skill));
    if (infraFailed.size === 0) return first; // nada que re-mapear

    return first.map((c) => {
        if (c.status !== 'cancelled') return c;
        const found = resolveDeliverable(c.skill, dels);
        const y = (found && found.yaml) || {};
        if (y.cancelado_por !== 'fast-fail-rebote') return c;
        if (y.cancelado_disparador_infra !== true) return c;
        const trigs = String(y.cancelado_disparado_por || '')
            .split(',').map((s) => s.trim()).filter(Boolean);
        if (trigs.length === 0) return c;
        return trigs.every((t) => infraFailed.has(t))
            ? { ...c, status: 'missing', remappedFrom: 'cancelled' }
            : c;
    });
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

    // #5641 — `classifyPhase` (no `classifySkill` suelto): el re-mapeo de los
    // hermanos drenados necesita ver toda la fase. Misma función que usa
    // `ambiguousSkillsOf` en el reconciler → los dos gates no pueden divergir.
    const classes = classifyPhase(requiredSkills, deliverables, liveSkills);
    const done = classes.filter((c) => c.status === 'done');
    const live = classes.filter((c) => c.status === 'live');
    const rejected = classes.filter((c) => c.status === 'rejected');
    const corrupt = classes.filter((c) => c.status === 'corrupt');
    const cancelled = classes.filter((c) => c.status === 'cancelled');
    const missing = classes.filter((c) => c.status === 'missing');
    const infraFailed = classes.filter((c) => c.status === 'infra-failed');

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
    //
    // #5641 — `infra-failed` NO entra acá: no es un veredicto ambiguo, es la
    // ausencia de veredicto. `rejected` (contenido real, incluido cualquier
    // rechazo de `security`) sigue escalando exactamente igual que antes.
    const ambiguous = [...rejected, ...cancelled, ...corrupt];
    if (ambiguous.length > 0) {
        const detail = ambiguous.map((c) => `${c.skill}:${c.status}`).join(',');
        return { stuck: true, action: 'escalate', reason: `ambigüedad (rechazo/cancelado/corrupto): ${detail}` };
    }

    // #5641 CA-10 — CARRIL DE INFRA: al agente se le cayó el proceso y arrastró
    // a los hermanos por fast-fail. Se re-encola el que se cayó + los drenados
    // por su culpa. No hay decisión de contenido que preservar.
    //
    // CA-UX-2: el `reason` es PROPIO — distinto del de skills genuinamente
    // faltantes, que afirma "nunca corrieron". Acá el agente SÍ corrió (y se
    // cayó), y los hermanos no son lo mismo que él. El contador `intento N/M` lo
    // agrega el reconciler, que es quien conoce el presupuesto.
    if (infraFailed.length > 0) {
        const caidos = infraFailed.map((c) => c.skill);
        const arrastrados = missing.filter((c) => c.remappedFrom === 'cancelled').map((c) => c.skill);
        const faltantes = missing.filter((c) => c.remappedFrom !== 'cancelled').map((c) => c.skill);
        const exitCodes = {};
        for (const c of infraFailed) exitCodes[c.skill] = c.exitCode;
        const detalleCaidos = caidos
            .map((s) => (exitCodes[s] == null ? s : `${s} (exit ${exitCodes[s]})`))
            .join(', ');
        const partes = [`re-encolo ${caidos.join(',')}`];
        if (arrastrados.length > 0) partes.push(`los drenados por fast-fail (${arrastrados.join(',')})`);
        if (faltantes.length > 0) partes.push(`los que nunca corrieron (${faltantes.join(',')})`);
        return {
            stuck: true,
            action: 'requeue',
            requeueSkills: [...caidos, ...arrastrados, ...faltantes],
            infra: { skills: caidos, drained: arrastrados, missing: faltantes, exitCodes },
            reason: `caída de infra: ${detalleCaidos} — ${partes.join(' + ')}`,
        };
    }

    // Único caso de auto-remediación: skill(s) GENUINAMENTE faltante(s) (nunca
    // corrió, no hay artefacto en ningún lado) → re-encolar (re-corre el agente).
    if (missing.length > 0) {
        const skills = missing.map((c) => c.skill);
        return { stuck: true, action: 'requeue', requeueSkills: skills, reason: `re-encolar skills faltantes (nunca corrieron): ${skills.join(',')}` };
    }

    return { stuck: true, action: 'escalate', reason: 'estado indeterminado' };
}

module.exports = { analyzeStuckIssue, classifySkill, classifyPhase, DEFAULT_STALE_THRESHOLD_MS };

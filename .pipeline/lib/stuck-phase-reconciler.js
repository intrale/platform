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

const { analyzeStuckIssue, classifyPhase } = require('./stuck-phase-detector');

const DEFAULT_MAX_REQUEUE_ATTEMPTS = 2;
const DEFAULT_CAP_PER_TICK = 5;
const MONO_SKILL_PHASES = new Set(['dev', 'build', 'entrega']);
// #5396 CA-7 — causas de silencio que el tick reporta por separado.
const SUPPRESSION_BUCKETS = new Set(['ola', 'cache', 'dedupe', 'cerrado', 'otro']);
// #5396 rev-1 — estados que el detector considera AMBIGUOS y por los que escala.
// Son los mismos que `analyzeStuckIssue` agrupa en su rama `escalate`.
//
// #5641 CA-16 — `infra-failed` NO va acá, y no es un olvido: no es un veredicto
// ambiguo, es la AUSENCIA de veredicto (el agente se cayó antes de opinar). Su
// carril es `requeue`. Agregarlo "por prolijidad" haría que `ambiguousSkillsOf`
// devolviera skills en un camino que no escala, y la rama de escalate por
// presupuesto agotado usa `capped` — no esta lista.
//
// #6296 — `rejected` SALE de esta lista. Es el GATE ESPEJO del cambio en
// `analyzeStuckIssue`: un rechazo ya no escala, tiene carril `rebote` propio.
// Dejarlo acá haría que `ambiguousSkillsOf` devolviera el skill que rechazó como
// "ambiguo" en un camino que ya no escala — exactamente la divergencia
// detector↔reconciler que #5641 vino a cerrar. Los dos cambios entran en el
// mismo commit y hay un test de contrato que los compara.
const AMBIGUOUS_STATUSES = new Set(['cancelled', 'corrupt']);

/** #6296 — estados que representan una DECISIÓN de validador (carril `rebote`). */
const REJECTED_STATUSES = new Set(['rejected']);

/**
 * #5396 rev-1 — skills REALES de la fase que motivaron la escalación.
 *
 * POR QUÉ EXISTE
 * --------------
 * El marker de bloqueo se plantaba con un skill sintético (`reconciler`) que no
 * pertenece a `skills_por_fase[fase]`. Al destrabar (`unblockIssue` o los
 * quick-actions de Telegram) el marker se mueve a `pendiente/` y entra al
 * despacho del Pulpo, donde el INVARIANTE skill∈fase lo rebota y manda un
 * Telegram POR TICK — exactamente el ruido que este issue viene a eliminar.
 *
 * Devolver los skills ambiguos reales (`rejected`/`cancelled`/`corrupt`) le da
 * al marker un camino de dispatch válido: son los mismos que el carril
 * `requeue` ya usa, y al destrabar re-corre el agente que quedó sin veredicto.
 *
 * Se reusa la clasificación del detector en vez de parsear el `reason`.
 *
 * #5641 R-1 — usa `classifyPhase`, NO `classifySkill` suelto. El re-mapeo
 * `cancelled → missing` de los hermanos drenados por una caída de infra depende
 * de la clasificación de OTRO skill de la fase, así que sólo existe a nivel
 * fase. Si esta función siguiera clasificando skill por skill, vería `cancelled`
 * donde `analyzeStuckIssue` ya ve `missing`, y el marker de escalación se
 * plantaría con skills que el detector considera re-encolables: los dos gates
 * divergirían — exactamente el bug de fondo que #5641 viene a cerrar.
 *
 * @returns {string[]} subconjunto ORDENADO de `requiredSkills` (determinista)
 */
function ambiguousSkillsOf(it) {
    const classes = classifyPhase(it.requiredSkills, it.deliverables, it.liveSkills);
    return classes.filter((c) => AMBIGUOUS_STATUSES.has(c.status)).map((c) => c.skill);
}

/**
 * #6296 — skills que RECHAZARON en la fase. Hermana de `ambiguousSkillsOf`.
 *
 * Misma disciplina: se deriva de `classifyPhase` (la misma función que consume
 * `analyzeStuckIssue`), NUNCA parseando el `reason`. El `reason` es texto libre
 * que interpola el `motivo` del agente; leerlo para tomar decisiones sería una
 * fuente de verdad spoofeable.
 *
 * Se usa como `skills` del marker cuando el carril `rebote` NO puede resolver un
 * destino válido y cae a `escalate`: el marker necesita un skill REAL de la fase
 * para tener camino de dispatch al destrabar.
 *
 * @returns {string[]} subconjunto ORDENADO de `requiredSkills` (determinista)
 */
function rejectedSkillsOf(it) {
    const classes = classifyPhase(it.requiredSkills, it.deliverables, it.liveSkills);
    return classes.filter((c) => REJECTED_STATUSES.has(c.status)).map((c) => c.skill);
}

/**
 * #6296 — skills de la fase SIN veredicto propio (carril leve).
 *
 * Un rechazo leve no frena el issue, pero los hermanos `cancelled` TAMPOCO son
 * aprobación: la fase se re-corre completa. Estos son los que hay que volver a
 * lanzar: todo lo que no sea `done` ni `live` (incluye al que rechazó leve, que
 * tiene que volver a opinar sobre el estado corregido).
 *
 * @returns {string[]} subconjunto ORDENADO de `requiredSkills`
 */
function skillsSinVeredictoPropio(it) {
    const classes = classifyPhase(it.requiredSkills, it.deliverables, it.liveSkills);
    return classes.filter((c) => c.status !== 'done' && c.status !== 'live').map((c) => c.skill);
}

/** Normaliza texto libre a una línea (el `reason` interpola nombres de archivo). */
function oneLine(s, max = 220) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
}

// #5641 — causas de decisión. Manejan el texto que ve el operador (CA-UX-1/2/4).
const CAUSE_INFRA_REQUEUE = 'infra-requeue';
const CAUSE_INFRA_EXHAUSTED = 'infra-reintentos-agotados';
// #6296 — causas del carril de rechazo por severidad.
const CAUSE_REJECT_GRAVE = 'rechazo-grave';
const CAUSE_REJECT_LEVE = 'rechazo-leve';
const CAUSE_REJECT_SIN_DESTINO = 'rechazo-sin-destino';

// #6296 — `security` NUNCA entra al carril leve, y tampoco publica su motivo en
// un comentario PÚBLICO del PR: el motivo de un hallazgo de seguridad es un mapa
// de vulnerabilidad abierto. El piso `security ⇒ grave` de `rejection-severity`
// ya lo mantiene fuera de este carril; esta lista es defensa en profundidad para
// el texto que efectivamente se publica.
const SKILLS_SIN_OBSERVACION_PUBLICA = new Set(['security']);

/**
 * #6296 — payload de la observación al PR del carril leve.
 *
 * PURO: arma el dato, NO publica. El texto lo sanitiza y publica el dep (los
 * motivos están OBLIGADOS por el protocolo de rebote a pegar output de comandos,
 * así que pueden arrastrar secretos).
 */
function buildObservacion(analysis, it) {
    const skills = ((analysis.rebote && analysis.rebote.skills) || [])
        .filter((r) => !SKILLS_SIN_OBSERVACION_PUBLICA.has(String(r.skill || '').toLowerCase()));
    return {
        issue: it.issue,
        pipeline: it.pipeline,
        fase: it.fase,
        severidad: 'leve',
        items: skills.map((r) => ({ skill: r.skill, motivo: r.motivo || null })),
    };
}

/**
 * Exit code representativo para el audit (CA-17). Devuelve el escalar cuando
 * todos los agentes caídos coinciden, `null` si difieren o no hay dato — el mapa
 * completo viaja aparte en `agente_exit_codes`.
 */
function infraExitCode(infra) {
    const codes = [...new Set(Object.values((infra && infra.exitCodes) || {}).filter((c) => c != null))];
    return codes.length === 1 ? codes[0] : null;
}

/** Lista legible: `po`, `po y ux`, `po, ux y guru`. */
function humanList(arr) {
    const a = (arr || []).filter(Boolean);
    if (a.length === 0) return '';
    if (a.length === 1) return a[0];
    return `${a.slice(0, -1).join(', ')} y ${a[a.length - 1]}`;
}

/**
 * #5641 CA-UX-1 — La pregunta de destrabe se DERIVA de la causa.
 *
 * Antes estaba hardcodeada con las tres causas históricas (`rechazo / cancelado
 * / corrupto`) y duplicada en dos call sites que ya habían divergido en el
 * prefijo de contexto. Este issue agrega una CUARTA causa —presupuesto de
 * reintentos por infra agotado— donde ninguna de las tres aplica: ofrecerle al
 * operador tres opciones equivocadas es el peor modo de falla de un mensaje de
 * escalación, porque mueve el forense manual de lugar en vez de eliminarlo.
 *
 * Fuente única: la consumen `buildEscalationMessage` (acá) y el dep `escalate`
 * de `stuck-reconciler-deps.js`.
 *
 * @param {object} d       decisión (`issue`, `pipeline`, `fase`, `cause`, `infra`)
 * @param {object} [opts]  `includeContext` (default true) — el mensaje de Telegram
 *                         ya trae el `📂 pipeline/fase` en su propia línea.
 */
function buildEscalationQuestion(d = {}, opts = {}) {
    const includeContext = opts.includeContext !== false;
    const ctx = `${d.pipeline ? `${d.pipeline}/` : ''}${d.fase || ''}`;
    const en = includeContext && ctx ? ` en ${ctx}` : '';

    if (d.cause === CAUSE_INFRA_EXHAUSTED) {
        const inf = d.infra || {};
        const skills = humanList(inf.skills) || 'el agente';
        const n = Number(inf.attempts);
        const veces = Number.isFinite(n) && n > 0
            ? ` ${n} ${n === 1 ? 'vez' : 'veces'} seguidas`
            : ' varias veces seguidas';
        const codes = [...new Set(Object.values(inf.exitCodes || {}).filter((c) => c != null))];
        const exit = codes.length === 1 ? ` (exit code ${codes[0]})` : '';
        return `¿Cómo destrabo #${d.issue}${en}? El agente de ${skills} se cayó${veces}${exit} y se agotó el presupuesto de reintentos automáticos.`;
    }
    return `¿Cómo destrabo #${d.issue}${en}? (rechazo / cancelado / corrupto)`;
}

/**
 * #5641 CA-UX-4 — Línea `💡` accionable. `null` cuando no hay nada útil que
 * decir: la guideline UX de #5337 es OMITIR la línea entera, nunca gastar un
 * renglón en "sin recomendación".
 *
 * Para el presupuesto de infra agotado la recomendación es determinista y
 * barata: dos caídas seguidas del mismo agente casi siempre son cuota o crash de
 * arranque, y el operador tiene un log concreto para mirar.
 */
function buildEscalationRecommendation(d = {}) {
    if (d.cause !== CAUSE_INFRA_EXHAUSTED) return null;
    const inf = d.infra || {};
    const skills = humanList(inf.skills);
    if (!skills) return null;
    const n = Number(inf.attempts);
    const caidas = Number.isFinite(n) && n > 0 ? `${n} caídas seguidas` : 'las caídas repetidas';
    return `Revisá el log del agente ${skills} de #${d.issue} — ${caidas} suelen ser cuota agotada o crash de arranque, no un problema del issue.`;
}

/**
 * #5396 CA-UX-2 — mensaje de escalación legible para el operador: número,
 * título (sólo si hay entrada FRESCA en caché), fase y la pregunta concreta de
 * destrabe. Sin Markdown — la estructura la dan los saltos de línea y los emojis
 * (CA-8/SEC-4: el `reason` interpola un skill derivado de un nombre de archivo,
 * contenido no confiable, y viaja en texto plano).
 *
 * #5641 CA-UX-1/CA-UX-4 — la pregunta sale de `buildEscalationQuestion` (una
 * sola fuente para los dos call sites) y se suma la línea `💡` cuando hay
 * recomendación.
 */
function buildEscalationMessage(d, title) {
    const lines = [`🙋 Self-healing: #${d.issue} necesita tu decisión`];
    if (title) lines.push(`📌 ${oneLine(title, 120)}`);
    lines.push(`📂 ${d.pipeline ? `${d.pipeline}/` : ''}${d.fase}`);
    lines.push(`❓ ${buildEscalationQuestion(d, { includeContext: false })}`);
    lines.push(`ℹ️ ${oneLine(d.reason)}`);
    const rec = buildEscalationRecommendation(d);
    if (rec) lines.push(`💡 ${oneLine(rec, 240)}`);
    return lines.join('\n');
}

/**
 * Decide la acción efectiva para UN issue aplicando las guardas.
 * @returns {{action:'requeue'|'escalate'|'rebote'|'none', skills?:string[],
 *            dest?:{faseDestino:string,skillsDestino:string[]}, rebote?:object,
 *            observacion?:object, reason:string, consumesTick:boolean}}
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

    // #6296 — CARRIL DE RECHAZO. Un validador decidió; el pipeline respeta esa
    // decisión en vez de pedir humano. Va ANTES de `escalate` porque el detector
    // ya garantiza que las acciones son exclusivas; el orden acá sólo documenta
    // la precedencia conceptual (decisión > ambigüedad).
    if (analysis.action === 'rebote') {
        // El reconciler tampoco resuelve el destino a mano: lo delega en el dep
        // que envuelve `rebote-destino.js` (fase_rechazo + determinarDevSkill).
        // Reimplementar el mapeo acá sería una tercera fuente de verdad.
        let dest = null;
        try { dest = cfg.resolveRebote ? cfg.resolveRebote(it) : null; }
        catch { dest = null; } // dep roto ⇒ tratar como destino inválido (fail-closed)

        // SEC-D — destino inválido o nulo (p.ej. `definicion`, con
        // `fase_rechazo: null`) ⇒ ESCALATE, jamás "seguir curso". Un rebote sin
        // destino que se convirtiera en `none` dejaría el issue varado en
        // silencio, que es peor que el bug original.
        if (!dest || !dest.faseDestino || !Array.isArray(dest.skillsDestino) || dest.skillsDestino.length === 0) {
            if (it.hasNeedsHuman) return dedupe('ya-escalado');
            return base('escalate', `${analysis.reason} — destino de rebote inválido, escalo`, {
                consumesTick: true,
                skills: rejectedSkillsOf(it),
                cause: CAUSE_REJECT_SIN_DESTINO,
            });
        }

        if (analysis.rebote && analysis.rebote.severidadEfectiva === 'leve') {
            // SEC-C(c1) — carril LEVE: la observación no frena el issue, pero
            // "seguir su curso" NO es `promote`/`done`. Los hermanos `cancelled`
            // no son aprobación: promover fabricaría un gate aprobado con
            // veredictos cancelados y saltearía el gate de QA que `CLAUDE.md`
            // declara no negociable. Por eso: `requeue` de la fase COMPLETA +
            // observación publicada en el PR.
            //
            // Reusa el presupuesto de requeue existente (`maxRequeueAttempts`):
            // un contador nuevo sería otro camino para loopear.
            const skillsLeve = skillsSinVeredictoPropio(it);
            if (skillsLeve.length === 0) {
                // Nada que re-correr y sin embargo la fase no completó: estado
                // indeterminado ⇒ humano (fail-closed).
                if (it.hasNeedsHuman) return dedupe('ya-escalado');
                return base('escalate', `${analysis.reason} — leve sin skills re-encolables, escalo`, {
                    consumesTick: true, skills: rejectedSkillsOf(it), cause: CAUSE_REJECT_SIN_DESTINO,
                });
            }
            const cappedLeve = skillsLeve.filter((sk) => ((it.retryCounts || {})[sk] || 0) >= cfg.maxRequeueAttempts);
            if (cappedLeve.length > 0) {
                if (it.hasNeedsHuman) return dedupe('tope-reintentos + ya-escalado');
                return base('escalate', `${analysis.reason} — tope de reintentos (${cfg.maxRequeueAttempts}) en el carril leve para: ${cappedLeve.join(',')}`, {
                    consumesTick: true, skills: cappedLeve, cause: CAUSE_REJECT_LEVE,
                });
            }
            if (it.hasNeedsHuman) return dedupe('bloqueado-humano');
            if (cfg.paused) return base('none', 'pipeline-en-pausa (no re-encola)', { suppression: 'otro' });
            return base('requeue', `${analysis.reason} — leve: re-corro la fase y publico observación`, {
                consumesTick: true,
                skills: skillsLeve,
                cause: CAUSE_REJECT_LEVE,
                observacion: buildObservacion(analysis, it),
            });
        }

        // Carril GRAVE → rebote de código a `dev`.
        //
        // Dedupe: un bloqueo humano VIGENTE gana sobre el rebote. Materializarlo
        // escribiría un work-item en `dev/pendiente` sobre un issue que está
        // esperando decisión de una persona — la misma línea roja que #5396 fijó
        // para el carril `requeue`. No hay regresión sobre el CA del issue: el
        // carril de rechazo corre ANTES de que exista escalación por rechazo, así
        // que el `needs-human` que llegue acá lo puso otra cosa (o un humano).
        if (it.hasNeedsHuman) return dedupe('bloqueado-humano');
        // Pausa: escribir en `pendiente/` ES re-encolar (PO SG-5). El escalate
        // sigue permitido bajo pausa; spawnear un dev, no.
        if (cfg.paused) return base('none', 'pipeline-en-pausa (no re-encola)', { suppression: 'otro' });
        return base('rebote', `${analysis.reason} → ${dest.faseDestino}/${dest.skillsDestino.join(',')}`, {
            consumesTick: true,
            dest,
            rebote: analysis.rebote,
            cause: CAUSE_REJECT_GRAVE,
        });
    }

    if (analysis.action === 'escalate') {
        if (it.hasNeedsHuman) return dedupe('ya-escalado');
        // #5396 rev-1 — `skills` viaja hasta el dep `escalate` para que el marker
        // se plante con un skill REAL de la fase (camino de dispatch válido al
        // destrabar). Puede venir vacío en el caso 'estado indeterminado'; el
        // cableado resuelve el fallback contra `skills_por_fase`.
        return base('escalate', analysis.reason, { consumesTick: true, skills: ambiguousSkillsOf(it) });
    }

    // requeue
    const retryCounts = it.retryCounts || {};
    const skills = analysis.requeueSkills || [];
    // #5641 — carril de infra: el detector imputó una caída de proceso (veredicto
    // sintetizado por el Pulpo), no una ausencia de trabajo. Cambia el texto que
    // ve el operador y el registro de auditoría, NO el presupuesto: el corte
    // sigue siendo el `maxRequeueAttempts` ya existente (default 2).
    const infra = (analysis.infra && Array.isArray(analysis.infra.skills) && analysis.infra.skills.length > 0)
        ? analysis.infra
        : null;
    const capped = skills.filter((s) => (retryCounts[s] || 0) >= cfg.maxRequeueAttempts);
    if (capped.length > 0) {
        // Skill(s) agotaron reintentos → escalar (no re-encolar para siempre, Arq P0-3).
        if (it.hasNeedsHuman) return dedupe('tope-reintentos + ya-escalado');
        // #5396 rev-1 — los skills que agotaron reintentos SON los del carril
        // requeue: ya están en `skills_por_fase[fase]`, así que el marker que se
        // planta con ellos es despachable al destrabar. `capped` nunca es vacío
        // acá (CA-16): el marker siempre tiene camino de dispatch.
        if (infra) {
            // #5641 CA-14 — la escalación por infra dice POR QUÉ se agotó, no sólo
            // que se agotó. Sin reintentos "de gracia": el presupuesto se acabó.
            const foco = infra.skills.filter((s) => capped.includes(s));
            const focoSkills = foco.length > 0 ? foco : capped;
            const attempts = Math.max(0, ...focoSkills.map((s) => retryCounts[s] || 0));
            const exitCodes = {};
            for (const s of focoSkills) {
                if (infra.exitCodes && infra.exitCodes[s] != null) exitCodes[s] = infra.exitCodes[s];
            }
            return base(
                'escalate',
                `se agotó el presupuesto de reintentos por infra (${cfg.maxRequeueAttempts}) para: ${capped.join(',')}`,
                {
                    consumesTick: true,
                    skills: capped,
                    cause: CAUSE_INFRA_EXHAUSTED,
                    infra: { skills: focoSkills, attempts, max: cfg.maxRequeueAttempts, exitCodes },
                },
            );
        }
        return base('escalate', `tope de reintentos (${cfg.maxRequeueAttempts}) alcanzado para: ${capped.join(',')}`, { consumesTick: true, skills: capped });
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

    // #5641 CA-UX-2 — el contador `intento N/M` lo agrega el reconciler, que es
    // quien conoce el presupuesto (el detector es puro y no lo ve). Que el
    // operador VEA venir la escalación antes de que ocurra es la diferencia entre
    // un aviso que puede ignorar y uno que lo sorprende.
    if (infra) {
        const intento = Math.max(0, ...infra.skills.map((s) => retryCounts[s] || 0)) + 1;
        return base('requeue', `${analysis.reason} · intento ${intento}/${cfg.maxRequeueAttempts}`, {
            skills,
            consumesTick: true,
            cause: CAUSE_INFRA_REQUEUE,
            infra: {
                skills: infra.skills,
                drained: infra.drained || [],
                attempts: intento,
                max: cfg.maxRequeueAttempts,
                exitCodes: infra.exitCodes || {},
            },
        });
    }

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
 * @param {(it:object)=>{faseDestino:string,skillsDestino:string[]}|null} [ctx.resolveRebote]
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
        // #6296 — resolutor del destino del rebote (envuelve `rebote-destino.js`).
        // Sin él, el carril grave no tiene destino ⇒ escala (fail-closed): el
        // plan NUNCA inventa una fase destino por su cuenta.
        resolveRebote: typeof ctx.resolveRebote === 'function' ? ctx.resolveRebote : null,
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

        // #5641 — `cause`/`infra` viajan hasta el shell: alimentan el texto que ve
        // el operador (CA-UX-1/2/4) y el registro de auditoría (CA-17).
        decisions.push({
            ...base,
            action: d.action,
            skills: d.skills,
            reason: d.reason,
            suppression: d.suppression,
            cause: d.cause,
            infra: d.infra,
            // #6296 — el destino resuelto, la severidad y la observación viajan
            // hasta el shell: es el shell quien materializa el rebote y publica.
            dest: d.dest,
            rebote: d.rebote,
            observacion: d.observacion,
        });
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
 *   @param {(issue,meta)=>boolean} [deps.rebote]  #6296 — materializa el rebote a `dev`; false si no pudo
 *   @param {(msg)=>void} [deps.notify]
 *   @param {(record)=>void} [deps.audit]
 *   @param {(pipeline,fase,skill,issue)=>boolean} [deps.workItemExists] re-check idempotente
 *   @param {(issue)=>string|null} [deps.issueTitle] título para el mensaje (CA-UX-2)
 * @returns {{requeued:number, escalated:number, rebotes:number, skipped:number, evaluados:number,
 *            suppressed:{ola:number,cache:number,dedupe:number,cerrado:number,otro:number}}}
 */
function executeDecisions(decisions, deps = {}) {
    let requeued = 0, escalated = 0, skipped = 0, rebotes = 0;
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
            // #5641 CA-17 — el requeue por infra deja rastro forense: qué skill se
            // cayó, con qué exit code, cuántos hermanos arrastró y en qué punto del
            // presupuesto quedó (antes/después). Sin esto, una caída sistemática es
            // indistinguible de una puntual hasta que agota los reintentos.
            audit({
                action: 'requeue',
                issue: d.issue,
                pipeline: d.pipeline,
                fase: d.fase,
                skills: d.skills,
                reason: d.reason,
                cause: d.cause || null,
                ...(d.infra ? {
                    infra_skills: d.infra.skills || [],
                    drenados_por_fast_fail: d.infra.drained || [],
                    agente_exit_code: infraExitCode(d.infra),
                    agente_exit_codes: d.infra.exitCodes || {},
                    reintentos_antes: Math.max(0, (Number(d.infra.attempts) || 1) - 1),
                    reintentos_despues: Number(d.infra.attempts) || 1,
                    max_reintentos: d.infra.max,
                    // CA-15 — contador de AUDITORÍA/observabilidad únicamente. El
                    // presupuesto efectivo es `maxRequeueAttempts` (default 2); esto
                    // no consume el circuit breaker de código ni se cablea al tope
                    // global de rebotes de infra (default 20, que habilitaría 20
                    // re-ejecuciones de fase completa por issue).
                    rebote_numero_infra: Number(d.infra.attempts) || 1,
                } : {}),
            });
            // #6296 — carril LEVE: la observación va al PR. Best-effort: si la
            // publicación falla, el requeue YA ocurrió y no se revierte (la fase
            // se re-corre igual). Se audita para que el silencio sea visible.
            if (d.observacion) {
                let obsOk = false;
                try { obsOk = deps.publicarObservacion ? deps.publicarObservacion(d.observacion) !== false : false; }
                catch (e) { audit({ ...d, action: 'requeue', error: `observación: ${String(e && e.message).slice(0, 120)}` }); }
                if (!obsOk) audit({ action: 'requeue', issue: d.issue, fase: d.fase, error: 'observación al PR no publicada' });
            }
            // CA-UX-3 — UNA notificación por decisión, no una por skill: el `join`
            // es lo que evita el Telegram-por-tick que cerró #5396. En el shape de
            // #5175 son 3 skills re-encolados y 1 solo mensaje.
            notify(
                `🔧 Self-healing: re-encolé ${(d.skills || []).join(',')} de #${d.issue} (${d.fase}) — ${d.reason}`,
                { issue: d.issue, fase: d.fase, pipeline: d.pipeline, action: 'requeue' },
            );
        } else if (d.action === 'rebote') {
            // #6296 — MATERIALIZACIÓN DEL REBOTE. Mismo patrón fail-observable que
            // `escalate`: el dep devuelve `false` cuando no pudo escribir (destino
            // inválido, circuit breaker agotado, issue inválido) y entonces NO se
            // cuenta como hecho — se audita y se saltea. Un rebote "contado" que
            // nunca tocó el FS deja el issue varado sin rastro.
            let reboteOk = false;
            try {
                reboteOk = deps.rebote && deps.rebote(d.issue, {
                    pipeline: d.pipeline,
                    fase: d.fase,
                    dest: d.dest,
                    rebote: d.rebote,
                    reason: d.reason,
                    cause: d.cause || null,
                }) !== false;
            } catch (e) {
                audit({ ...d, error: String(e && e.message).slice(0, 120) });
            }
            if (!reboteOk) {
                audit({ ...d, action: 'rebote', error: 'no se pudo materializar el rebote' });
                skipped += 1;
                continue;
            }
            rebotes += 1;
            audit({
                action: 'rebote',
                issue: d.issue,
                pipeline: d.pipeline,
                fase: d.fase,
                reason: d.reason,
                cause: d.cause || null,
                fase_destino: (d.dest && d.dest.faseDestino) || null,
                skills_destino: (d.dest && d.dest.skillsDestino) || [],
                severidad: (d.rebote && d.rebote.severidadEfectiva) || null,
                rechazaron: ((d.rebote && d.rebote.skills) || []).map((r) => `${r.skill}:${r.severidad}`),
                arrastrados: (d.rebote && d.rebote.arrastrados) || [],
            });
            // CA-UX-3 — UNA notificación por decisión, no una por skill.
            notify(
                `⏪ Self-healing: #${d.issue} rebota de ${d.fase} a ${(d.dest && d.dest.faseDestino) || '?'} — ${oneLine(d.reason)}`,
                { issue: d.issue, fase: d.fase, pipeline: d.pipeline, action: 'rebote' },
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
                    // #5396 rev-1 — skills reales que motivaron la escalación. El
                    // cableado elige entre ellos el que planta en el marker, para
                    // que al destrabar el work-item tenga dispatch válido.
                    skills: d.skills || [],
                    // #5641 CA-UX-1 — la causa viaja al dep para que la pregunta de
                    // destrabe del marker se derive de ella en vez de enumerar las
                    // tres causas históricas, que acá no aplican.
                    cause: d.cause || null,
                    infra: d.infra || null,
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
            audit({
                action: 'escalate', issue: d.issue, pipeline: d.pipeline, fase: d.fase,
                reason: d.reason, cause: d.cause || null, skills: d.skills || [],
                ...(d.infra ? {
                    infra_skills: d.infra.skills || [],
                    agente_exit_code: infraExitCode(d.infra),
                    agente_exit_codes: d.infra.exitCodes || {},
                    reintentos_agotados: Number(d.infra.attempts) || null,
                    max_reintentos: d.infra.max,
                } : {}),
            });
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
    return { requeued, escalated, rebotes, skipped, suppressed, evaluados: (decisions || []).length };
}

module.exports = {
    planReconciliation,
    executeDecisions,
    decideForIssue,
    buildEscalationMessage,
    buildEscalationQuestion,
    buildEscalationRecommendation,
    ambiguousSkillsOf,
    rejectedSkillsOf,
    skillsSinVeredictoPropio,
    buildObservacion,
    AMBIGUOUS_STATUSES,
    REJECTED_STATUSES,
    CAUSE_REJECT_GRAVE,
    CAUSE_REJECT_LEVE,
    CAUSE_REJECT_SIN_DESTINO,
    SKILLS_SIN_OBSERVACION_PUBLICA,
    CAUSE_INFRA_REQUEUE,
    CAUSE_INFRA_EXHAUSTED,
    SUPPRESSION_BUCKETS,
    MONO_SKILL_PHASES,
    DEFAULT_MAX_REQUEUE_ATTEMPTS,
    DEFAULT_CAP_PER_TICK,
};

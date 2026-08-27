'use strict';

// =============================================================================
// lib/delivery/freshness-gate.js — GATE 3 (#6496): caducidad del veredicto
// sellado de QA, en UN SOLO lugar.
//
// POR QUÉ EXISTE ESTE ARCHIVO (rebote rev-2 desde `aprobacion`)
// -----------------------------------------------------------------------------
// La primera implementación puso el gate inline en `.pipeline/delivery.js`, que
// NO es el camino que corre la fase `entrega`. La fase corre el skill
// determinístico `.pipeline/skills-deterministicos/delivery.js`
// (`lib/agent-launcher/providers/deterministic.js` → `DETERMINISTIC_SKILLS`),
// donde no existía ninguna llamada al gate: los tests pasaban y en producción un
// veredicto caduco se integraba igual.
//
// Los dos caminos siguen existiendo y los dos tocan el remoto:
//   · `.pipeline/skills-deterministicos/delivery.js` — camino REAL de la fase
//     `entrega` (Node puro, sin LLM). Es el que corre el Pulpo.
//   · `.pipeline/delivery.js` — CLI de `/delivery`: el fallback LLM
//     (`.claude/skills/delivery/SKILL.md`) y el uso manual del operador. Sigue
//     vivo: borrar el script determinístico devuelve el control a este camino
//     por diseño (rollout reversible de #2476/#2482/#2484).
//
// Por eso la decisión NO se duplica: vive acá y los dos la consumen. Este módulo
// es la política; cada orquestador sólo la traduce a su propio contrato de
// salida (exit code, marker, reporte).
//
// Contrato: NO imprime, NO hace `process.exit`, NO muta el lifecycle de ningún
// dropfile (CA-13 — el Pulpo es el único dueño del work-file). Devuelve datos.
// =============================================================================

const path = require('path');
const qaEvidenceSeal = require('../qa-evidence-seal');

/**
 * Raíz del ESTADO del pipeline.
 *
 * `entrega` corre en el WORKTREE del issue (`lib/phase-workspace.js` →
 * `EXISTING_WORKTREE_PHASES`), así que el `.pipeline/` local es un árbol con la
 * estructura versionada pero SIN estado vivo y SIN servicios drenándolo. Los
 * dropfiles de `desarrollo/verificacion/procesado/`, el contador de caducidad y
 * la cola de `servicios/github` viven en el `.pipeline/` del REPO PRINCIPAL, que
 * el Pulpo le pasa a todo agente en `PIPELINE_REPO_ROOT`.
 *
 * Misma convención de env que los servicios (`servicio-github.js`).
 *
 * @param {{env?: object, fallbackDir?: string}} params
 * @returns {string}
 */
function resolveStatePipelineDir({ env = process.env, fallbackDir } = {}) {
    if (env.PIPELINE_STATE_DIR) return path.resolve(env.PIPELINE_STATE_DIR);
    if (env.PIPELINE_MAIN_ROOT) return path.join(path.resolve(env.PIPELINE_MAIN_ROOT), '.pipeline');
    if (env.PIPELINE_REPO_ROOT) return path.join(path.resolve(env.PIPELINE_REPO_ROOT), '.pipeline');
    if (fallbackDir) return path.resolve(fallbackDir);
    return path.resolve(__dirname, '..', '..');
}

/**
 * Evalúa GATE 3 y, si el veredicto caducó, encola la reparación.
 *
 * Orden de las cosas (importa): el chequeo corre ANTES de tocar el remoto
 * (CA-15). Un chequeo posterior al push no sirve —el remoto ya se movió— y uno
 * anterior al GATE 2 de firma gastaría trabajo en issues que la firma frena
 * igual.
 *
 * Fail-closed en todos los bordes:
 *   · `issue` no normalizable ⇒ `{aplica:false, issueInvalido:true, caduco:true}`;
 *     el llamador DEBE abortar sin tocar el remoto (con un `--issue` que no es un
 *     número no se puede ni resolver el veredicto ni nombrar el contador).
 *   · HEAD no derivable, veredicto ilegible, sin sello ⇒ caduco
 *     (`checkVerdictFreshness` ya resuelve esto; acá no se ablanda nada).
 *   · No se pudo encolar la reparación ⇒ igual caduco: lo que no se puede hacer
 *     es integrar un HEAD que nadie verificó.
 *
 * @param {{pipelineDir?: string, issue: number|string, cwd: string,
 *          seal?: object, env?: object, fallbackDir?: string}} params
 * @returns {{
 *   aplica: boolean, issueInvalido: boolean, caduco: boolean,
 *   issue: number|null, pipelineDir: string|null,
 *   shaVerificado: string|null, motivo: string|null, motivoLegible: string|null,
 *   headSellado: string|null, headActual: string|null,
 *   escalado: boolean, intentos: number|null, reparacionOk: boolean,
 *   reparacionError: string|null,
 *   contrato: object|null, stderr: string[]
 * }}
 */
function evaluateFreshnessGate({
    pipelineDir, issue, cwd, seal = qaEvidenceSeal, env = process.env, fallbackDir,
} = {}) {
    const base = {
        aplica: false, issueInvalido: false, caduco: false,
        issue: null, pipelineDir: null,
        shaVerificado: null, motivo: null, motivoLegible: null,
        headSellado: null, headActual: null,
        escalado: false, intentos: null, reparacionOk: false, reparacionError: null,
        contrato: null, stderr: [],
    };

    // SEC-B — el issue se normaliza a entero ANTES de construir cualquier path
    // (`.<issue>.seal-retries`, dropfiles). Mismo criterio que
    // `buildPrGatePropagation`; no se inventa otro.
    const issueNum = seal.normalizeIssueNumber(issue);
    if (issueNum === null) {
        return {
            ...base,
            issueInvalido: true,
            caduco: true,
            motivo: 'issue-invalido',
            motivoLegible: seal.describeFreshnessFailure('issue-invalido'),
            stderr: ['⛔ --issue inválido: no se puede verificar la frescura del veredicto de QA'],
        };
    }

    const dir = pipelineDir || resolveStatePipelineDir({ env, fallbackDir });

    // SEC-A — el módulo deriva el HEAD él mismo (`execFileSync` sin shell +
    // `/^[0-9a-f]{40}$/`). NUNCA se le pasa un head del snapshot: `snap.head` no
    // existe en `lib/delivery/git-context.js`, así que el snippet original de la
    // historia nacía fail-open (`undefined === undefined`) o fail-siempre-caduco.
    const stale = seal.checkVerdictFreshness({ pipelineDir: dir, issue: issueNum, cwd });

    if (!stale.caduco) {
        // CA-15 — el SHA verificado es lo que se integra. `head_actual` viene
        // null sólo en el carril de exención de migración pre-sellado (CA-4),
        // donde no hay nada sellado contra qué pinnear.
        return {
            ...base,
            aplica: true, caduco: false,
            issue: issueNum, pipelineDir: dir,
            shaVerificado: stale.head_actual || null,
            headSellado: stale.head_sellado || null,
            headActual: stale.head_actual || null,
        };
    }

    // CA-13 — encola la orden, NO mueve el dropfile: el Pulpo es el único dueño
    // del lifecycle del work-file y escanea `procesado/` en su loop de routing.
    let repar = null;
    let reparacionError = null;
    try {
        repar = seal.requeueVerification({
            pipelineDir: dir,
            issue: issueNum,
            motivo: stale.motivo,
            headSellado: stale.head_sellado,
            headActual: stale.head_actual,
        });
    } catch (e) {
        reparacionError = (e && e.message ? String(e.message) : String(e)).slice(0, 300);
    }

    const escalado = !!(repar && repar.escalado === true);
    const intentos = repar && Number.isInteger(repar.intentos) ? repar.intentos : null;
    const motivoLegible = seal.describeFreshnessFailure(stale.motivo);

    const stderr = [`⛔ Entrega frenada — ${motivoLegible}`];
    if (reparacionError) {
        stderr.push(`⛔ veredicto caduco y no se pudo encolar la reparación: ${reparacionError}`);
    } else {
        stderr.push(`⛔ veredicto caduco — ${escalado
            ? `escalado a needs-human tras ${intentos} re-encolado(s) automático(s)`
            : `re-encolado a verificación (${intentos}/${seal.MAX_SEAL_REQUEUES})`}`);
    }
    stderr.push('⛔ NO se pushó nada y NO se creó/mergeó ningún PR.');

    return {
        ...base,
        aplica: true, caduco: true,
        issue: issueNum, pipelineDir: dir,
        motivo: stale.motivo, motivoLegible,
        headSellado: stale.head_sellado || null,
        headActual: stale.head_actual || null,
        escalado, intentos,
        reparacionOk: !!(repar && repar.ok),
        reparacionError,
        // CA-14 — contrato machine-readable. Quien consume esta salida (un agente
        // LLM en el camino CLI, el marker del skill determinístico en el camino
        // real) necesita distinguir "veredicto caduco" de "entrega exitosa" sin
        // parsear prosa: ese es el falso positivo de R3 en `delivery-status.js`
        // (#5220/#5244, markers `aprobado` cuyo motivo confiesa "merge bloqueado").
        contrato: {
            estado: 'veredicto_caduco',
            issue: issueNum,
            motivo: stale.motivo,
            escalado,
            intentos,
        },
        stderr,
    };
}

/**
 * CA-8 — regla de reset ÚNICA del contador de caducidad: se borra recién cuando
 * un veredicto FRESCO efectivamente se integró (push del SHA verificado). NO lo
 * resetean un re-encolado exitoso, una aprobación nueva de QA por sí sola, un
 * rebote de otra fase, ni el paso del tiempo.
 *
 * Best-effort: no poder borrarlo no puede tumbar una entrega ya consumada (a lo
 * sumo el próximo caduco escala una vuelta antes).
 */
function clearRetriesAfterIntegration({ pipelineDir, issue, seal = qaEvidenceSeal } = {}) {
    const issueNum = seal.normalizeIssueNumber(issue);
    if (issueNum === null || !pipelineDir) return false;
    try {
        seal.clearSealRetries({ pipelineDir, issue: issueNum });
        return true;
    } catch {
        return false;
    }
}

/**
 * CA-12 / SEC-C — mientras haya un re-encolado de verificación ABIERTO, el gate
 * del issue no viaja al PR. Propagar `qa:passed` —o cualquier gate— durante una
 * ventana de re-verificación convierte un estado en disputa en una afirmación
 * sobre el PR que nadie hizo.
 *
 * Fail-closed: `hasOpenRequeue` contesta `true` ante cualquier error que no sea
 * "la cola no existe".
 */
function isRequeueOpen({ pipelineDir, issue, seal = qaEvidenceSeal, env = process.env, fallbackDir } = {}) {
    const dir = pipelineDir || resolveStatePipelineDir({ env, fallbackDir });
    return seal.hasOpenRequeue({ pipelineDir: dir, issue }) === true;
}

/**
 * Fase donde vive el gate. El veredicto caduco sólo puede nacer en `entrega`,
 * que es la única que corre el chequeo antes de tocar el remoto.
 */
const GATE_PHASE = 'entrega';

/**
 * ¿Este conjunto de rechazos es "la entrega se frenó sola por caducidad"?
 *
 * Lo usa el barrido del Pulpo para NO rebotar a `dev` (rev++, circuit breaker)
 * ni escalar a `needs-human`: la reparación ya está encolada y
 * `drenarRequeueVerificacion` la convierte en un work-file de `verificacion`.
 *
 * Reglas, todas fail-closed:
 *   · Sólo en la fase `entrega`. Ninguna otra corre el gate, así que un
 *     `veredicto_caduco` en otra fase es ruido y NO puede cancelar un rechazo.
 *   · El flag tiene que ser el booleano `true` ESTRUCTURADO. Nunca se infiere
 *     del texto del `motivo`: ese campo lo escribe el agente y sería el vector
 *     para auto-cancelarse un rechazo real.
 *   · TODOS los rechazos del lote tienen que serlo. Si `delivery` caducó pero
 *     otro skill de la fase rechazó por contenido, el rechazo real manda.
 *   · Lote vacío ⇒ false (no hay nada que cancelar).
 *
 * @param {{fase: string, rechazados: Array<object>}} params
 * @returns {boolean}
 */
function isStaleVerdictRejection({ fase, rechazados } = {}) {
    if (fase !== GATE_PHASE) return false;
    if (!Array.isArray(rechazados) || rechazados.length === 0) return false;
    return rechazados.every((r) => r && r.veredicto_caduco === true);
}

module.exports = {
    resolveStatePipelineDir,
    evaluateFreshnessGate,
    clearRetriesAfterIntegration,
    isRequeueOpen,
    isStaleVerdictRejection,
    GATE_PHASE,
};

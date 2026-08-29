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
        contrato: null, stderr: [], exento: false,
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
        // CA-15 — el SHA verificado es lo que se integra.
        //
        // rebote security rev-3 (F4): el carril de exención de migración
        // pre-sellado (CA-4) también pinnea. Antes devolvía `head_actual: null`
        // y con eso el push volvía al nombre simbólico de la rama y el merge
        // perdía el pinneo de head (`if (expectedHeadSha)`): el carril con la
        // verificación más débil era el único además sin anti-TOCTOU. La
        // exención dispensa de tener sello contra qué comparar, no de integrar
        // exactamente lo que se miró. `exento` queda expuesto para que el
        // llamador siga pudiendo distinguir los dos carriles en el log.
        return {
            ...base,
            aplica: true, caduco: false,
            issue: issueNum, pipelineDir: dir,
            shaVerificado: stale.head_actual || null,
            headSellado: stale.head_sellado || null,
            headActual: stale.head_actual || null,
            exento: stale.exento === true,
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
 * CA-12 sobre el PR (rebote security rev-3 — F2). Retracta el gate de QA ya
 * estampado en un PR cuando el veredicto caducó DESPUÉS de la propagación.
 *
 * `requeueVerification` degrada el label del ISSUE; esto degrada el del PR, que
 * es el que `hasQaGate` lee como autoridad de merge. Sin esto el issue quedaba en
 * `qa:pending` y el PR en `qa:passed` sobre un commit que nadie verificó.
 *
 * Best-effort: no poder retractar no puede convertirse en "entonces mergeá". El
 * merge ya está frenado por el gate; esto sólo evita dejar la afirmación colgada.
 */
function retractPrGate({ pipelineDir, prNumber, prLabels, seal = qaEvidenceSeal, env = process.env, fallbackDir } = {}) {
    const dir = pipelineDir || resolveStatePipelineDir({ env, fallbackDir });
    try {
        return seal.retractPrGateLabels({ pipelineDir: dir, prNumber, prLabels });
    } catch (e) {
        return { ok: false, ordenes: [], error: (e && e.message ? String(e.message) : String(e)).slice(0, 200) };
    }
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
 *   · CORROBORACIÓN CONTRA ESTADO DEL PIPELINE (SEC #6496, rebote security —
 *     A04). El flag no se cree por sí solo: ver abajo.
 *
 * SEC (#6496, rebote security — A04: Insecure Design)
 * -----------------------------------------------------------------------------
 * El comentario original justificaba la seguridad diciendo que `veredicto_caduco`
 * es un campo ESTRUCTURADO y que sólo el texto libre lo escribe el agente. Esa
 * justificación se refutaba sola: `rechazados` sale del YAML del work-file, y
 * `roles/delivery.md` le ordena literalmente al agente LLM de `entrega` escribir
 * `veredicto_caduco: true` en su archivo de trabajo. Estructurado no es lo mismo
 * que confiable — es exactamente la clase de input contra la que existe
 * `stripDeclaredSeal` (CA-5).
 *
 * Consecuencia del agujero: un agente de `entrega` cuya entrega falló DE VERDAD
 * (conflictos, CI en rojo) escribía `resultado: rechazado` + `veredicto_caduco:
 * true` y el Pulpo no rebotaba a dev, no incrementaba rev, no tocaba el circuit
 * breaker y no escalaba a `needs-human`: archivaba todo con
 * `cancelado_por: 'veredicto-caduco'` y seguía de largo. Como no había orden real
 * en la cola, nadie re-encolaba nada y el issue desaparecía del pipeline en
 * silencio. No es bypass de merge (el veredicto sigue en `rechazado` y `main`
 * queda intacto), pero sí supresión de la escalada y del control de rebotes.
 *
 * Por eso el flag se cruza contra estado que SÓLO escribe el pipeline: el
 * contador `.<issue>.seal-retries`. Si el pipeline no puede confirmar que la
 * reparación existe, esto NO es un caduco: es un rechazo normal y sigue el camino
 * de rechazo normal (fail-closed).
 *
 * Deliberadamente NO se usa `hasOpenRequeue`: ese helper es fail-closed para el
 * gate de entrega (devuelve `true` ante cualquier error de lectura que no sea
 * ENOENT), y acá `true` significa "cancelá el rechazo" — o sea que un directorio
 * ilegible corroboraría el dicho del agente. Mismo valor, sentido opuesto.
 *
 * POR QUÉ EL CONTADOR SOLO NO ALCANZA (rebote security rev-3 — F3)
 * -----------------------------------------------------------------------------
 * La versión anterior corroboraba con `readSealRetries().intentos > 0` y nada
 * más. Pero el contador NO SE CONSUME NI EXPIRA: queda en >0 desde la primera
 * caducidad legítima hasta que un push exitoso lo limpia (CA-8). En toda esa
 * ventana la corroboración estaba satisfecha DE ANTEMANO, así que el agujero
 * quedaba reducido a una precondición ("que el issue haya caducado una vez"), no
 * eliminado: un issue que ya caducó y cuya entrega después falla DE VERDAD
 * (conflicto, CI en rojo) podía escribir `veredicto_caduco: true` y cancelarse el
 * rechazo igual — sin rebote, sin rev++, sin circuit breaker, sin escalada y sin
 * re-verificación viva encolada.
 *
 * Por eso el testigo autoritativo es el STAMP DE UN SOLO USO
 * (`.<issue>.seal-caduco-stamp`), que escribe únicamente `requeueVerification` —
 * o sea, sólo una caducidad REAL — y que se BORRA al leerse. Un flag declarado
 * sin gate detrás no encuentra stamp y sigue el camino de rechazo normal. El
 * contador se sigue exigiendo como segunda condición (barata y consistente con
 * CA-6/CA-9), pero ya no es la única.
 *
 * Orden de evaluación: el stamp se consume ÚLTIMO, recién cuando todo lo demás
 * ya dio positivo, para no quemarlo en un lote que igual iba a rechazarse.
 *
 * @param {{fase: string, rechazados: Array<object>, issue?: string|number, pipelineDir?: string, seal?: object, env?: object, fallbackDir?: string}} params
 * @returns {boolean}
 */
function isStaleVerdictRejection({
    fase, rechazados, issue, pipelineDir, seal = qaEvidenceSeal, env = process.env, fallbackDir,
} = {}) {
    if (fase !== GATE_PHASE) return false;
    if (!Array.isArray(rechazados) || rechazados.length === 0) return false;
    if (!rechazados.every((r) => r && r.veredicto_caduco === true)) return false;

    // Desde acá abajo: lo declarado por el agente ya no alcanza.
    const issueNum = seal.normalizeIssueNumber(issue);
    if (issueNum === null) return false;
    const dir = pipelineDir || resolveStatePipelineDir({ env, fallbackDir });
    try {
        // `intentos > 0` cubre las dos ramas de `requeueVerification`: el
        // re-encolado (contador recién incrementado) y la escalada (contador ya en
        // el tope, o corrupto — que `readSealRetries` lee como agotado, CA-10).
        // Ausente ⇒ `0` ⇒ nadie encoló ninguna reparación ⇒ el flag no vale.
        if (!(seal.readSealRetries({ pipelineDir: dir, issue: issueNum }).intentos > 0)) return false;
        // Testigo de UN SOLO USO de que el gate disparó en este episodio. Se
        // consume acá, último, y sólo si todo lo anterior ya dio positivo.
        return seal.consumeStaleStamp({ pipelineDir: dir, issue: issueNum }) === true;
    } catch {
        // Sin poder consultar el estado no se puede afirmar la reparación.
        return false;
    }
}

module.exports = {
    resolveStatePipelineDir,
    evaluateFreshnessGate,
    clearRetriesAfterIntegration,
    isRequeueOpen,
    retractPrGate,
    isStaleVerdictRejection,
    GATE_PHASE,
};

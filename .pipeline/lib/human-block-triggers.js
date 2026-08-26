// =============================================================================
// human-block-triggers.js — Detectores de bloqueo humano por ESTADO OBJETIVO
// (#5337, CA-3). Complementa la heurística textual de `isHumanBlockReason()`.
//
// El problema que resuelve: el 2026-08-01 hubo 4 issues frenados esperando al
// operador (#5217, #5220, #5242, #5244) y no salió ni una notificación. El
// canal de aviso ya funcionaba (pulpo.js → buildBlockedSummaryMarkdown →
// Telegram + botonera + audio); lo que faltaba era la DETECCIÓN: nada llegaba
// a `reportHumanBlock`. Los cuatro casos:
//
//   1. Hallazgos de seguridad sin resolver que el ruleset de `main` exige.
//   2. Conflicto de merge real contra `main`.
//   3. PO/UX/QA devolviendo el issue pidiendo una DECISIÓN (no una corrección).
//   4. Review manual exigido por CODEOWNERS.
//
// Todo acá es PURO: recibe estado ya consultado (JSON de `gh`) y devuelve un
// veredicto. Sin red, sin filesystem, sin `gh` en proceso → testeable en
// milisegundos y sin riesgo de colgar el barrido (regla "el pipeline no puede
// morir": ninguna syscall bloqueante vive en este módulo).
//
// -----------------------------------------------------------------------------
// DOS RIESGOS QUE ESTE MÓDULO EVITA A PROPÓSITO
// -----------------------------------------------------------------------------
//
// R1 — Falso positivo masivo por deuda preexistente de `main`.
//   `/repos/:owner/:repo/code-scanning/alerts` devuelve TODAS las alertas del
//   repo, incluidas las `open` sobre `refs/heads/main` (al 2026-08-01 existen:
//   p.ej. alert #109 de Semgrep). Si el trigger no filtra por ref, TODO PR
//   queda bloqueado por deuda que no introdujo → el pipeline se autobloquea
//   entero. Por eso `detectSecurityFindingBlock` exige que la alerta esté
//   instanciada en el ref DEL PR (`refs/pull/<N>/head` o su head branch).
//
// R2 — `mergeable` es asíncrono en GitHub.
//   Mientras GitHub recalcula, la API devuelve `UNKNOWN`/`null`. Tratarlo como
//   conflicto genera bloqueos espurios; tratarlo como limpio es fail-open y
//   contradice la política del pipeline. Por eso existe un tercer veredicto:
//   `inconclusive` → NO se bloquea NI se aprueba, se reintenta en el barrido
//   siguiente. Un estado desconocido nunca es un veredicto.
// =============================================================================

'use strict';

// -----------------------------------------------------------------------------
// Catálogo de triggers. FUENTE ÚNICA: la tabla del contrato en
// `docs/pipeline/human-in-the-loop.md` se deriva de acá. Agregar un trigger =
// agregar una entrada acá + su detector + su test.
// -----------------------------------------------------------------------------
const TRIGGERS = Object.freeze({
    SECURITY_FINDINGS: 'security-findings',
    MERGE_CONFLICT: 'merge-conflict',
    CODEOWNERS_REVIEW: 'codeowners-review',
    DECISION_REQUESTED: 'decision-requested',
    REPEATED_REJECTION: 'repeated-rejection',
    DESIGN_DECISION: 'design-decision',
    // Agregado por el rebote del review de #5337: `BLOCKED` con un check
    // requerido en rojo NO es una review pendiente. Ver `classifyChecks`.
    CHECKS_FAILING: 'checks-failing',
});

// -----------------------------------------------------------------------------
// Estado de los checks del PR (corrección del review de #5337)
//
// EL DEFECTO QUE ARREGLA: `mergeStateStatus === 'BLOCKED'` se reportaba como
// "sólo falta la review", y el mensaje al operador afirmaba textualmente "El PR
// no tiene conflictos ni checks en rojo". GitHub también devuelve BLOCKED
// cuando un check REQUERIDO está fallando o pendiente. Medido sobre los PRs
// abiertos del repo el 2026-08-05:
//
//     PR #5277  BLOCKED  checks: SUCCESS,...,FAILURE   <- check en rojo
//     PR #5278  BLOCKED  checks: SUCCESS,...,FAILURE   <- check en rojo
//     PR #5202  BLOCKED  checks: SUCCESS,...,SUCCESS   <- CODEOWNERS real
//
// Para #5277 el pipeline le decía al operador que no había checks en rojo
// habiendo uno en FAILURE, y lo invitaba a aprobar un merge a `main`. Una
// recomendación activamente engañosa sobre la rama protegida.
//
// El dato para desambiguar ya viajaba gratis: `statusCheckRollup` está en
// `FIELDS` de `pr-info-fetcher.js` desde antes de #5337 y llega en el mismo
// `prInfo`. No cuesta una request extra.
//
// `statusCheckRollup` mezcla dos formas según el proveedor del check:
//   - CheckRun     → `{name, status, conclusion}`
//   - StatusContext→ `{context, state}`
// `classifyChecks` normaliza ambas.
// -----------------------------------------------------------------------------
const CHECK_FAIL_CONCLUSIONS = Object.freeze([
    'FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'CANCELLED', 'STALE',
]);
const CHECK_FAIL_STATES = Object.freeze(['FAILURE', 'ERROR']);
const CHECK_PENDING_STATUSES = Object.freeze(['QUEUED', 'IN_PROGRESS', 'WAITING', 'PENDING', 'REQUESTED']);
const CHECK_PENDING_STATES = Object.freeze(['PENDING', 'EXPECTED']);

/**
 * Normaliza `statusCheckRollup` a un veredicto sobre los checks.
 *
 * @param {Array} [rollup] — `prInfo.statusCheckRollup`.
 * @param {Set<string>|null} [requiredContexts] — #6612. Contextos que la
 *        protección de rama REALMENTE exige, YA COTEJADOS POR APP por
 *        `required-checks.js` (SEC-D: nunca nombres crudos del rollup).
 * @returns {{state:'failing'|'pending'|'green'|'unknown', failing:string[],
 *            pending:string[], failingNonRequired:string[],
 *            pendingNonRequired:string[], total:number}}
 *
 * `unknown` es un estado de primera clase a propósito: si no se puede leer el
 * rollup, el mensaje NO debe afirmar que los checks están en verde. Ése fue
 * exactamente el defecto — afirmar un hecho no verificado.
 *
 * -------------------------------------------------------------------------
 * #6612 — ACOTAMIENTO POR REQUERIDOS
 * -------------------------------------------------------------------------
 * El ruleset de `main` exige UN solo contexto (`pr-status`). Sin el Set, un
 * escáner que tarda 3 h y no bloquea nada hace que este clasificador devuelva
 * `pending`, y `delivery` agota su presupuesto (7 esperas / 6 min) contra un
 * check que la protección de rama nunca va a exigir.
 *
 * Con el Set presente:
 *   - `pending`  → SÓLO los requeridos. Es el acotamiento: un check no
 *                  requerido en curso no aporta al veredicto `pending`.
 *   - `failing`  → TODO el rollup, con Set o sin él (SEC-B). Un check en ROJO
 *                  no se ignora nunca; lo que cambia es cómo se ROTULA, y para
 *                  eso está `failingNonRequired`. El acotamiento aplica sólo a
 *                  `pending`.
 *
 * Con `requiredContexts === null` (default) el comportamiento es el ANTERIOR,
 * byte por byte: rollup entero, fail-closed. Ausencia de dato nunca se traduce
 * a "no se exige nada" — un ruleset ilegible tiene que frenar más, no menos.
 * (SEC-C: `fetchRequiredContexts` ya devuelve `ok:false` para el ruleset sin
 * requeridos; esa rama no se debilita.)
 *
 * Las listas se devuelven SEGREGADAS y nunca fusionadas en una bolsa única
 * (UX-4): el mensaje al operador tiene que poder decir cuál es cuál, que es
 * justo lo que hoy no puede y por eso inventa el adjetivo "requerido".
 */
function classifyChecks(rollup, requiredContexts = null) {
    // Un Set VACÍO no habilita el acotamiento: "leí el ruleset y no exige nada"
    // por este camino sería indistinguible de "no lo leí", y la lectura segura
    // de las dos es la misma — fail-closed sobre el rollup entero.
    const acotar = requiredContexts instanceof Set && requiredContexts.size > 0;
    if (!Array.isArray(rollup) || rollup.length === 0) {
        return {
            state: 'unknown', failing: [], pending: [],
            failingNonRequired: [], pendingNonRequired: [], total: 0,
        };
    }
    const failing = [];
    const pending = [];
    const failingNonRequired = [];
    const pendingNonRequired = [];
    let indeterminados = 0;
    for (const chk of rollup) {
        if (!chk || typeof chk !== 'object') { indeterminados++; continue; }
        const nombre = String(chk.name || chk.context || 'check sin nombre');
        // Sin acotamiento TODO cuenta como requerido: así el resto del cuerpo
        // queda idéntico al legacy sin duplicar ramas.
        const esRequerido = !acotar || requiredContexts.has(nombre);
        const conclusion = String(chk.conclusion || '').toUpperCase();
        const status = String(chk.status || '').toUpperCase();
        const state = String(chk.state || '').toUpperCase();

        if (CHECK_FAIL_CONCLUSIONS.includes(conclusion) || CHECK_FAIL_STATES.includes(state)) {
            // SEC-B — el rojo entra SIEMPRE en `failing`, requerido o no.
            failing.push(nombre);
            if (!esRequerido) failingNonRequired.push(nombre);
        } else if (CHECK_PENDING_STATUSES.includes(status) || CHECK_PENDING_STATES.includes(state)) {
            if (esRequerido) pending.push(nombre);
            else pendingNonRequired.push(nombre);
        } else if (!conclusion && !state) {
            // Ni conclusión ni estado: el check existe pero todavía no dijo nada.
            // Con acotamiento, que un check NO requerido no haya dicho nada no
            // vuelve indeterminado al conjunto: no lo estamos esperando.
            if (esRequerido) indeterminados++;
        }
        // El resto (SUCCESS / NEUTRAL / SKIPPED) cuenta como no-bloqueante.
    }
    const base = { failing, pending, failingNonRequired, pendingNonRequired, total: rollup.length };
    if (failing.length) return { state: 'failing', ...base };
    if (pending.length) return { state: 'pending', ...base };
    if (indeterminados) return { state: 'unknown', ...base };
    return { state: 'green', ...base };
}

// -----------------------------------------------------------------------------
// 1. Hallazgos de seguridad sin resolver (CA-3)
// -----------------------------------------------------------------------------

/**
 * ¿La alerta de code-scanning está instanciada en el ref de ESTE PR?
 *
 * Acepta las dos formas con las que GitHub identifica el ref de un PR:
 *   - `refs/pull/<N>/head`  (la que usa el análisis sobre el merge del PR)
 *   - `refs/heads/<branch>` (cuando el análisis corrió sobre la rama del agente)
 *
 * Cualquier otro ref — `refs/heads/main` en particular — es deuda preexistente
 * y NO bloquea (R1).
 */
function alertBelongsToPr(alert, { prNumber, headRefName } = {}) {
    const ref = alert
        && alert.most_recent_instance
        && typeof alert.most_recent_instance.ref === 'string'
        ? alert.most_recent_instance.ref
        : '';
    if (!ref) return false;
    if (Number.isInteger(Number(prNumber)) && Number(prNumber) > 0) {
        if (ref === `refs/pull/${Number(prNumber)}/head`) return true;
        if (ref === `refs/pull/${Number(prNumber)}/merge`) return true;
    }
    if (headRefName && ref === `refs/heads/${headRefName}`) return true;
    return false;
}

/**
 * Detecta bloqueo por hallazgos de seguridad que el ruleset de `main` exige
 * resolver antes de mergear.
 *
 * @param {object} args
 * @param {number} args.prNumber
 * @param {string} [args.headRefName]  — rama del PR (`agent/<issue>-<slug>`).
 * @param {Array}  args.alerts         — respuesta de `/code-scanning/alerts`.
 * @returns {object|null} veredicto o `null` si no hay bloqueo.
 */
function detectSecurityFindingBlock({ prNumber, headRefName, alerts } = {}) {
    if (!Array.isArray(alerts) || alerts.length === 0) return null;
    const propias = alerts.filter((a) => {
        if (!a || a.state !== 'open') return false;
        return alertBelongsToPr(a, { prNumber, headRefName });
    });
    if (propias.length === 0) return null;

    const detalle = propias.slice(0, 5).map((a) => {
        const rule = (a.rule && (a.rule.id || a.rule.name)) || 'regla desconocida';
        const sev = (a.rule && (a.rule.security_severity_level || a.rule.severity)) || 's/d';
        return `#${a.number} ${rule} (${sev})`;
    }).join(', ');
    const extra = propias.length > 5 ? ` y ${propias.length - 5} más` : '';

    return {
        trigger: TRIGGERS.SECURITY_FINDINGS,
        reason: `PR #${prNumber}: ${propias.length} hallazgo(s) de code-scanning sin resolver introducidos por esta rama — ${detalle}${extra}. El ruleset de main exige resolverlos antes del merge.`,
        question: `¿Resolvemos los hallazgos de seguridad del PR #${prNumber}, o los descartás como falso positivo para que el merge avance?`,
        recommendation: 'Revisar los hallazgos antes de descartarlos: son de código que introdujo esta rama, no deuda preexistente de main.',
        count: propias.length,
        alerts: propias.map((a) => a.number),
    };
}

// -----------------------------------------------------------------------------
// 2 y 4. Estado de merge del PR: conflicto real vs review pendiente (CA-3)
// -----------------------------------------------------------------------------

/**
 * Clasifica el estado de merge de un PR en: conflicto real, review humana
 * exigida, no concluyente, o limpio.
 *
 * `mergeStateStatus` distingue exactamente lo que el issue pide:
 *   - `DIRTY`   → conflicto de merge real contra la base.
 *   - `BLOCKED` → falta una aprobación / check requerido (CODEOWNERS, ruleset).
 *   - `UNKNOWN` → GitHub todavía está calculando (R2) → NO concluyente.
 *
 * @param {object} args
 * @param {number} args.prNumber
 * @param {string} [args.mergeable]         — MERGEABLE | CONFLICTING | UNKNOWN
 * @param {string} [args.mergeStateStatus]  — CLEAN | DIRTY | BLOCKED | UNKNOWN | ...
 * @param {string} [args.reviewDecision]    — APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | ''
 * @param {Array}  [args.statusCheckRollup] — checks del PR. BLOCKED sin esto no
 *   permite afirmar nada sobre el estado de los checks (ver `classifyChecks`).
 * @returns {object|null} veredicto, `{inconclusive:true}`, o `null` si está limpio.
 */
// -----------------------------------------------------------------------------
// #6612 UX-1 — LOS TRES RÓTULOS. Nunca se fusionan en una bolsa única.
//
// El defecto que cierran: el template de la rama BLOCKED le agregaba el
// adjetivo "requerido(s)" a un `classifyChecks` que jamás cotejó contra el
// ruleset. Con el rollup real de #6602 (`runtime-state-guard`=FAILURE,
// `pr-status`=SUCCESS) el operador leía "1 check requerido en rojo:
// runtime-state-guard" — y ese check NO es requerido por el ruleset de `main`.
// Un mensaje que afirma un hecho falso manda al operador a investigar el lugar
// equivocado; eso es un defecto, no un detalle de redacción.
//
// Un cuarto caso NO tiene rótulo a propósito: cuando la lista de requeridos no
// se pudo leer, el mensaje lo DICE y no usa ninguno de los tres. El precedente
// ya está escrito en la rama (c) de esta misma función.
// -----------------------------------------------------------------------------
const CHECK_ROTULOS = Object.freeze({
    REQUERIDO: 'requerido(s) por la protección de rama',
    SEGURIDAD: 'bloqueante(s) por seguridad',
    INFORMATIVO: 'informativo(s)',
});

// UX-4 — Listas acotadas, mismo criterio (`slice(0,5)` + "y N más") que ya usaba
// la rama BLOCKED: un mensaje de Telegram con 40 nombres no se lee.
function listarChecks(items, max = 5) {
    const lista = items.slice(0, max).join(', ');
    const extra = items.length > max ? ` y ${items.length - max} más` : '';
    return `${lista}${extra}`;
}

/**
 * Rama BLOCKED con el veredicto de `required-checks.js` disponible (#6612).
 *
 * `rc` decide EN EXCLUSIVA la dimensión "requerido": qué exige el ruleset sale
 * de ahí y de ningún otro lado. El rollup se usa SÓLO para rotular lo que el
 * ruleset no exige (seguridad / informativo), nunca para recalcular la
 * requeridez — eso reabriría la ventana TOCTOU (SEC-F).
 *
 * SEC-E — Sólo viajan `context` y estado observado. Nunca el JSON del ruleset:
 * trae `allowed_actors`, `required_reviewers` y `dismissal_restriction`, que son
 * política de rama y no tienen por qué salir a Telegram.
 */
function blockedConRequeridos({ prNumber, review, rc, statusCheckRollup, estado }) {
    // Lazy require a propósito: `security-blocking-checks.js` importa los enums
    // de ESTE módulo (CA-23, para que no existan dos copias de la tabla). Con un
    // require de tope de archivo el ciclo devolvería un `module.exports` a medio
    // poblar y los enums llegarían `undefined`.
    const { classifySecurityBlockingChecks } = require('./security-blocking-checks');

    const requeridosRojo = Array.isArray(rc.failing) ? rc.failing.slice() : [];
    const requeridosPend = Array.isArray(rc.pending) ? rc.pending.slice() : [];
    const requeridosVerde = Array.isArray(rc.green) ? rc.green : [];

    const sec = classifySecurityBlockingChecks({ rollup: statusCheckRollup });
    const rollupLegible = sec.verdict !== 'unusable';
    // El rollup sólo se mira para ROTULAR: todos los rojos observados, menos los
    // que `rc` ya acreditó como requeridos.
    const rojosRollup = rollupLegible ? classifyChecks(statusCheckRollup).failing : [];
    const segRojo = (sec.failing || []).filter((c) => !requeridosRojo.includes(c));
    const infoRojo = rojosRollup.filter(
        (c) => !requeridosRojo.includes(c) && !segRojo.includes(c)
    );

    const grupos = [];
    if (requeridosRojo.length) {
        grupos.push(`${requeridosRojo.length} ${CHECK_ROTULOS.REQUERIDO}: ${listarChecks(requeridosRojo)}`);
    }
    if (segRojo.length) {
        grupos.push(
            `${segRojo.length} ${CHECK_ROTULOS.SEGURIDAD} (el ruleset de main no los exige, `
            + `pero el pipeline no mergea con un escáner en rojo): ${listarChecks(segRojo)}`
        );
    }
    if (infoRojo.length) {
        grupos.push(`${infoRojo.length} ${CHECK_ROTULOS.INFORMATIVO}, que no frenan el merge: ${listarChecks(infoRojo)}`);
    }

    // (a) Algo en rojo que SÍ frena: requerido por el ruleset, o de la allowlist
    //     de seguridad. Los informativos solos no llegan acá — son constancia.
    if (requeridosRojo.length || segRojo.length) {
        const primarioEsRequerido = requeridosRojo.length > 0;
        // UX-2 — La recomendación cambia con el rótulo. "Devolver el issue a
        // desarrollo" es correcta para un test requerido en rojo y EQUIVOCADA
        // para un hallazgo del escáner: ahí lo que corresponde es mirar QUÉ
        // encontró, no rehacer la feature.
        const recomendacionRequerido = 'NO aprobar el PR para destrabarlo: la firma no arregla un check en rojo y el ruleset lo va a seguir frenando. Lo que corresponde es devolver el issue a desarrollo.';
        const recomendacionSeguridad = `Mirá QUÉ encontró el escáner antes de decidir (${listarChecks(segRojo)}): el ruleset de main no exige ese check, así que aprobar el PR no destraba nada — el pipeline lo frena igual. Y rehacer la feature tampoco lo arregla si el hallazgo es real.`;
        const recommendation = primarioEsRequerido
            ? (segRojo.length ? `${recomendacionRequerido} Además, ${recomendacionSeguridad}` : recomendacionRequerido)
            : recomendacionSeguridad;
        const question = primarioEsRequerido
            ? `El PR #${prNumber} tiene checks en rojo que el ruleset de main exige. ¿Lo devolvemos a desarrollo para que los arregle, o los mirás vos?`
            : `El PR #${prNumber} tiene un escáner de seguridad en rojo (${listarChecks(segRojo)}). ¿Mirás qué encontró, o lo devolvemos a desarrollo?`;
        return {
            trigger: TRIGGERS.CHECKS_FAILING,
            reason: `PR #${prNumber} está BLOCKED con checks en rojo — ${grupos.join(' · ')}. No es una review pendiente.`,
            question,
            recommendation,
            checks: {
                state: 'failing',
                failing: requeridosRojo.concat(segRojo),
                requeridos: requeridosRojo,
                seguridad: segRojo,
                informativos: infoRojo,
            },
        };
    }

    // (b) No se pudo leer qué exige main. NO se usa ninguno de los tres rótulos:
    //     rotular sin haber cotejado es exactamente el defecto de G-4/UX-1.
    if (rc.verdict === 'unusable') {
        return {
            trigger: TRIGGERS.CODEOWNERS_REVIEW,
            reason: `PR #${prNumber} está BLOCKED y no pude leer la lista de checks que exige main [causa técnica: ${rc.cause || 's/d'}]: no puedo afirmar si lo que falta es tu firma o un check.`,
            question: `¿Podés mirar el PR #${prNumber} en GitHub y decidir? No pude leer qué checks exige main, así que no sé si falta tu firma o falta un check.`,
            recommendation: 'No pude leer la lista de checks que exige main: miralos en GitHub antes de aprobar.',
            checks: { state: 'unknown' },
        };
    }

    // (c) Requeridos todavía en curso → NO concluyente (mismo criterio que R2).
    //     Acá vive el acotamiento: un check que main no exige y sigue corriendo
    //     NO llega hasta este punto, porque `rc.pending` sólo trae requeridos.
    if (requeridosPend.length) {
        return {
            inconclusive: true,
            trigger: null,
            prNumber,
            mergeStateStatus: estado,
            checks: { state: 'pending', pending: requeridosPend },
        };
    }

    // (d) Todo lo que main exige está en verde → recién acá es review humana.
    //     Si hay rojos que main no exige, quedan como CONSTANCIA explícita: ni
    //     se ignoran en silencio (punto 3 del issue) ni frenan el merge.
    const porReview = review === 'REVIEW_REQUIRED' || review === '' || review === 'CHANGES_REQUESTED';
    let recommendation = `Los ${requeridosVerde.length} check(s) que exige main están en verde: sólo falta la review. Si el diff te cierra, aprobarlo destraba el issue.`;
    if (infoRojo.length) {
        recommendation += ` Constancia: ${infoRojo.length} ${CHECK_ROTULOS.INFORMATIVO} terminaron en rojo (${listarChecks(infoRojo)}) y NO frenan el merge porque main no los exige.`;
    }
    if (!rollupLegible) {
        recommendation += ' No pude leer el rollup de checks del PR, así que no puedo afirmar nada sobre los checks que main no exige.';
    }
    return {
        trigger: TRIGGERS.CODEOWNERS_REVIEW,
        reason: `PR #${prNumber} está mergeable pero BLOCKED: el ruleset de main exige una aprobación humana${porReview ? ` (reviewDecision=${review || 'sin review'})` : ''}. CODEOWNERS cubre las rutas tocadas.`,
        question: `¿Podés revisar y aprobar el PR #${prNumber}? Sin tu firma el merge no avanza y el pipeline queda esperando.`,
        recommendation,
        checks: { state: 'green', informativos: infoRojo },
    };
}

function detectMergeStateBlock({
    prNumber, mergeable, mergeStateStatus, reviewDecision, statusCheckRollup,
    // #6612 G-4/UX-1 — Veredicto YA calculado por `createRequiredChecksReader()`
    // (`lib/required-checks.js`). OPCIONAL, y el patrón es exactamente el de
    // `delivery.js` (rama BLOCKED de `classifyMergeFailure`), copiado y no
    // reinventado, con sus tres invariantes:
    //   1. sin él ⇒ comportamiento legacy byte por byte;
    //   2. presente ⇒ decide EN EXCLUSIVA la dimensión "requerido" (nunca dos
    //      clasificadores para la misma rama);
    //   3. forma inesperada ⇒ tratada como AUSENTE, nunca como vía libre.
    // Se recibe ya calculado —y no se calcula acá— por dos razones: este módulo
    // es PURO (sin red), y el reader coteja rollup + `oid` JUNTOS contra
    // `headRefOid`. Filtrar acá el rollup viejo del snapshot con una lista de
    // requeridos leída fresca reabriría la ventana TOCTOU que cerró #5420 (SEC-F).
    requiredChecks,
} = {}) {
    const estado = String(mergeStateStatus || '').toUpperCase();
    const merg = String(mergeable || '').toUpperCase();
    const review = String(reviewDecision || '').toUpperCase();

    // R2 — dato todavía no calculado por GitHub. Ni bloqueo ni vía libre: se
    // reintenta en el barrido siguiente. NUNCA un veredicto.
    if (!estado || estado === 'UNKNOWN' || merg === 'UNKNOWN') {
        return { inconclusive: true, trigger: null, prNumber, mergeStateStatus: estado || null };
    }

    if (estado === 'DIRTY' || merg === 'CONFLICTING') {
        return {
            trigger: TRIGGERS.MERGE_CONFLICT,
            reason: `PR #${prNumber} tiene conflicto de merge real contra la base (mergeStateStatus=${estado}, mergeable=${merg || 's/d'}). El pipeline no resuelve conflictos semánticos por su cuenta.`,
            question: `¿Resolvés el conflicto del PR #${prNumber} a mano, o preferís que devolvamos el issue a desarrollo para rehacerlo sobre main actualizado?`,
            recommendation: 'Si el conflicto es de un archivo de estado o de un import, suele salir más barato devolver a desarrollo que resolverlo a mano.',
        };
    }

    if (estado === 'BLOCKED') {
        // #6612 G-4 — Con el veredicto del reader presente, la rama BLOCKED se
        // resuelve con datos COTEJADOS contra el ruleset. Sin él, cae al camino
        // legacy de más abajo, idéntico al anterior.
        const rc = requiredChecks;
        if (rc && typeof rc === 'object' && typeof rc.verdict === 'string') {
            return blockedConRequeridos({ prNumber, review, rc, statusCheckRollup, estado });
        }

        // BLOCKED es ambiguo: puede ser "falta la firma humana" o "hay un check
        // requerido en rojo/pendiente". Antes de hablarle al operador de review,
        // hay que LEER los checks — no suponerlos.
        const checks = classifyChecks(statusCheckRollup);

        // (a) Checks en rojo → esto NO es una firma que el operador deba dar.
        // Invitarlo a aprobar sería empujar un merge roto a `main`. Se notifica
        // igual (el silencio es el bug que #5337 arregla) pero con el encuadre
        // correcto: lo que corresponde es volver a desarrollo, no firmar.
        if (checks.state === 'failing') {
            const lista = checks.failing.slice(0, 5).join(', ');
            const extra = checks.failing.length > 5 ? ` y ${checks.failing.length - 5} más` : '';
            return {
                trigger: TRIGGERS.CHECKS_FAILING,
                reason: `PR #${prNumber} está BLOCKED con ${checks.failing.length} check(s) requerido(s) en rojo: ${lista}${extra}. El ruleset de main no lo deja mergear hasta que pasen — no es una review pendiente.`,
                question: `El PR #${prNumber} tiene checks en rojo. ¿Lo devolvemos a desarrollo para que los arregle, o los mirás vos?`,
                recommendation: 'NO aprobar el PR para destrabarlo: la firma no arregla un check en rojo y el ruleset lo va a seguir frenando. Lo que corresponde es devolver el issue a desarrollo.',
                checks: { state: checks.state, failing: checks.failing },
            };
        }

        // (b) Checks todavía corriendo → no concluyente (mismo criterio que R2).
        // Si en el barrido siguiente terminan en verde, recién ahí es CODEOWNERS.
        if (checks.state === 'pending') {
            return {
                inconclusive: true,
                trigger: null,
                prNumber,
                mergeStateStatus: estado,
                checks: { state: checks.state, pending: checks.pending },
            };
        }

        // (c) Checks verdes (o rollup ilegible) → recién acá es review humana.
        // La recomendación sólo afirma el estado de los checks si se pudo LEER;
        // si no, lo dice explícitamente en vez de inventarlo.
        const porReview = review === 'REVIEW_REQUIRED' || review === '' || review === 'CHANGES_REQUESTED';
        const checksVerdes = checks.state === 'green';
        const recommendation = checksVerdes
            ? `El PR no tiene conflictos y sus ${checks.total} checks están en verde: sólo falta la review. Si el diff te cierra, aprobarlo destraba el issue.`
            : 'El PR no tiene conflictos de merge, pero no pude leer el estado de sus checks: miralos en GitHub antes de aprobar.';
        return {
            trigger: TRIGGERS.CODEOWNERS_REVIEW,
            reason: `PR #${prNumber} está mergeable pero BLOCKED: el ruleset de main exige una aprobación humana${porReview ? ` (reviewDecision=${review || 'sin review'})` : ''}. CODEOWNERS cubre las rutas tocadas.`,
            question: `¿Podés revisar y aprobar el PR #${prNumber}? Sin tu firma el merge no avanza y el pipeline queda esperando.`,
            recommendation,
            checks: { state: checks.state },
        };
    }

    return null;
}

// -----------------------------------------------------------------------------
// 3. PO/UX/QA devuelven el issue pidiendo una DECISIÓN (CA-3)
// -----------------------------------------------------------------------------

// Skills cuya devolución puede ser "necesito que decidas", no "arreglá el código".
const DECISION_SKILLS = Object.freeze(['po', 'ux', 'qa', 'review', 'security', 'architect']);

// Señales de que lo que se pide es una DECISIÓN del operador. Enumeradas y
// explícitas a propósito (mismo criterio que CA-4a): una heurística amplia
// frenaría issues sanos, que es el problema inverso al que este issue arregla.
const DECISION_REQUEST_PATTERNS = Object.freeze([
    /\bdecisi[oó]n\s+(?:del?\s+)?(?:operador|humano|negocio|producto|leo)\b/i,
    /\brequiere\s+(?:una\s+)?decisi[oó]n\b/i,
    /\bhay\s+que\s+decidir\b/i,
    /\bnecesitamos\s+que\s+(?:decidas|definas|elijas)\b/i,
    /\bdefinici[oó]n\s+de\s+producto\s+pendiente\b/i,
    /\bno\s+corresponde\s+(?:que\s+)?(?:lo\s+)?(?:decida|resuelva)\s+(?:el\s+)?(?:agente|pipeline)\b/i,
    /\bescalar?\s+(?:la\s+)?decisi[oó]n\b/i,
    /\bcriterio\s+de\s+negocio\s+pendiente\b/i,
]);

// Contraseñal: si el motivo pide una corrección concreta de código, NO es una
// decisión — es un rebote técnico normal y debe seguir su camino.
const CODE_FIX_PATTERNS = Object.freeze([
    /\bfalta(?:n)?\s+tests?\b/i,
    /\bno\s+compila\b/i,
    /\btest(?:s)?\s+(?:fallan|en\s+rojo|rotos)\b/i,
    /\bcorregir\s+(?:el\s+)?(?:c[oó]digo|bug|import)\b/i,
]);

/**
 * Detecta que un gate (PO/UX/QA/review) devolvió el issue pidiendo una decisión
 * del operador en vez de una corrección de código.
 *
 * @param {object} args
 * @param {string} args.skill   — skill que emitió el rechazo.
 * @param {string} args.motivo  — texto del rechazo.
 * @param {number} [args.issue]
 * @returns {object|null}
 */
function detectDecisionRequestBlock({ skill, motivo, issue } = {}) {
    const txt = String(motivo || '').trim();
    if (!txt) return null;
    const s = String(skill || '').trim().toLowerCase();
    if (!DECISION_SKILLS.includes(s)) return null;
    // Precedencia: una corrección de código concreta nunca es una decisión.
    for (const re of CODE_FIX_PATTERNS) {
        if (re.test(txt)) return null;
    }
    const matched = DECISION_REQUEST_PATTERNS.find((re) => re.test(txt));
    if (!matched) return null;

    return {
        trigger: TRIGGERS.DECISION_REQUESTED,
        reason: `El gate \`${s}\` devolvió${issue ? ` #${issue}` : ''} pidiendo una decisión del operador, no una corrección de código: ${txt.slice(0, 400)}`,
        question: `¿Qué decidimos acá? El agente \`${s}\` no puede avanzar sin tu criterio.`,
        recommendation: `Leé la devolución de \`${s}\` completa antes de destrabar: si respondés la decisión con \`/unblock\`, el texto viaja como orientación al agente.`,
    };
}

// -----------------------------------------------------------------------------
// 5. Rebotado N veces por la MISMA causa (CA-3)
// -----------------------------------------------------------------------------

/**
 * Normaliza un motivo para comparar "misma causa" sin depender de detalles
 * volátiles (números de línea, timestamps, hashes) que cambian entre rebotes
 * y harían que dos fallas idénticas parezcan distintas.
 */
function normalizeCause(motivo) {
    return String(motivo || '')
        .toLowerCase()
        .replace(/\b[0-9a-f]{7,40}\b/g, '#')   // sha / hashes
        .replace(/\d+/g, '#')                   // números (líneas, issues, ms)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200);
}

/**
 * Si un issue rebotó `threshold` veces o más por la misma causa, el rebote
 * automático dejó de ser útil: cada pasada quema tokens para volver a fallar
 * igual. Escala a humano.
 *
 * @param {object} args
 * @param {number} [args.issue]
 * @param {Array<string|{motivo?:string}>} args.motivos — histórico de rechazos.
 * @param {number} [args.threshold=3]
 * @returns {object|null}
 */
function detectRepeatedRejectionBlock({ issue, motivos, threshold = 3 } = {}) {
    const list = Array.isArray(motivos) ? motivos : [];
    if (list.length < threshold) return null;
    const counts = new Map();
    for (const m of list) {
        const txt = typeof m === 'string' ? m : (m && m.motivo);
        const key = normalizeCause(txt);
        if (!key) continue;
        counts.set(key, (counts.get(key) || 0) + 1);
    }
    let peorKey = null;
    let peorCount = 0;
    for (const [k, c] of counts) {
        if (c > peorCount) { peorCount = c; peorKey = k; }
    }
    if (peorCount < threshold) return null;

    // Texto original del último rechazo de esa causa (más legible que el
    // normalizado, que tiene los números reemplazados por `#`).
    let ejemplo = '';
    for (let i = list.length - 1; i >= 0; i--) {
        const txt = typeof list[i] === 'string' ? list[i] : (list[i] && list[i].motivo);
        if (normalizeCause(txt) === peorKey) { ejemplo = String(txt || ''); break; }
    }

    return {
        trigger: TRIGGERS.REPEATED_REJECTION,
        reason: `${issue ? `#${issue} ` : ''}rebotó ${peorCount} veces por la misma causa. El rebote automático ya no está aportando: cada pasada vuelve a fallar igual. Último motivo: ${ejemplo.slice(0, 400)}`,
        question: '¿Cómo destrabamos esto? El pipeline no está convergiendo por su cuenta.',
        recommendation: 'Si la causa es de definición y no de código, devolver a definición suele cortar el ciclo mejor que un rebote más.',
        repeats: peorCount,
    };
}

// -----------------------------------------------------------------------------
// Orquestador sobre el estado de un PR
// -----------------------------------------------------------------------------

/**
 * Corre los detectores que dependen del estado del PR y devuelve el PRIMER
 * bloqueo encontrado, en orden de gravedad: seguridad → conflicto/review.
 *
 * Contrato de tres valores (fail-closed sin ser fail-noisy):
 *   - objeto con `trigger` → hay bloqueo humano, notificar.
 *   - `{inconclusive:true}` → dato no disponible todavía, reintentar (R2).
 *   - `null`               → PR sano, seguir el flujo normal.
 *
 * @param {object} prState  — `{number, headRefName, mergeable, mergeStateStatus, reviewDecision}`
 * @param {object} [opts]
 * @param {Array}  [opts.securityAlerts]
 * @returns {object|null}
 */
function detectPrHumanBlock(prState = {}, opts = {}) {
    const prNumber = Number(prState.number || prState.prNumber);
    if (!Number.isInteger(prNumber) || prNumber <= 0) return null;

    const sec = detectSecurityFindingBlock({
        prNumber,
        headRefName: prState.headRefName,
        alerts: opts.securityAlerts,
    });
    if (sec) return sec;

    return detectMergeStateBlock({
        prNumber,
        mergeable: prState.mergeable,
        mergeStateStatus: prState.mergeStateStatus,
        reviewDecision: prState.reviewDecision,
        // Viene en el MISMO `prInfo` (ya está en FIELDS de pr-info-fetcher):
        // sin esto, BLOCKED no se puede desambiguar y el mensaje afirmaría el
        // estado de los checks sin haberlo leído.
        statusCheckRollup: prState.statusCheckRollup,
        // #6612 UX-1 — Veredicto de `createRequiredChecksReader()`, si el call
        // site pudo leerlo. Ausente ⇒ el mensaje dice que no pudo leer qué
        // exige main, NUNCA inventa el adjetivo "requerido".
        requiredChecks: opts.requiredChecks,
    });
}

module.exports = {
    TRIGGERS,
    DECISION_SKILLS,
    DECISION_REQUEST_PATTERNS,
    CODE_FIX_PATTERNS,
    CHECK_FAIL_CONCLUSIONS,
    CHECK_PENDING_STATUSES,
    // #6431 — `required-checks.js` clasifica los mismos estados sobre los checks
    // REQUERIDOS del ruleset. Los enums salen de aca, no se re-escriben: dos
    // copias de la misma tabla divergen en cuanto GitHub agrega un valor, y la
    // que quede vieja lee ese valor como "no bloqueante" (fail-open).
    CHECK_FAIL_STATES,
    CHECK_PENDING_STATES,
    CHECK_ROTULOS,
    alertBelongsToPr,
    classifyChecks,
    normalizeCause,
    detectSecurityFindingBlock,
    detectMergeStateBlock,
    detectDecisionRequestBlock,
    detectRepeatedRejectionBlock,
    detectPrHumanBlock,
};

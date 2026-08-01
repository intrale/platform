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
});

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
 * @returns {object|null} veredicto, `{inconclusive:true}`, o `null` si está limpio.
 */
function detectMergeStateBlock({ prNumber, mergeable, mergeStateStatus, reviewDecision } = {}) {
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
        // CODEOWNERS / ruleset: el PR está sano pero exige una firma humana.
        const porReview = review === 'REVIEW_REQUIRED' || review === '' || review === 'CHANGES_REQUESTED';
        return {
            trigger: TRIGGERS.CODEOWNERS_REVIEW,
            reason: `PR #${prNumber} está mergeable pero BLOCKED: el ruleset de main exige una aprobación humana${porReview ? ` (reviewDecision=${review || 'sin review'})` : ''}. CODEOWNERS cubre las rutas tocadas.`,
            question: `¿Podés revisar y aprobar el PR #${prNumber}? Sin tu firma el merge no avanza y el pipeline queda esperando.`,
            recommendation: 'El PR no tiene conflictos ni checks en rojo: sólo falta la review. Si el diff te cierra, aprobarlo destraba el issue.',
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
    });
}

module.exports = {
    TRIGGERS,
    DECISION_SKILLS,
    DECISION_REQUEST_PATTERNS,
    CODE_FIX_PATTERNS,
    alertBelongsToPr,
    normalizeCause,
    detectSecurityFindingBlock,
    detectMergeStateBlock,
    detectDecisionRequestBlock,
    detectRepeatedRejectionBlock,
    detectPrHumanBlock,
};

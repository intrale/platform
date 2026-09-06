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
    // #6612 UX-1/UX-2 — check de la allowlist de `security-blocking-checks.js`
    // en rojo. Trigger PROPIO y no `CHECKS_FAILING` porque la accion que se le
    // pide al operador es otra (mirar el hallazgo del escáner, no devolver la
    // feature a desarrollo) y porque el ruleset NO lo exige: fusionarlo con
    // `checks-failing` es la bolsa unica que UX-1 prohibe.
    SECURITY_CHECK_RED: 'security-check-red',
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

// -----------------------------------------------------------------------------
// #6599 - No todo check del rollup tiene poder de veto
//
// EL DEFECTO QUE ARREGLA: `classifyChecks` recorria el rollup COMPLETO del PR.
// Un check que la proteccion de rama no exige - `OWASP Dependency Check`, que
// vive en `security-sast.yml` con `continue-on-error: true` y
// `failBuildOnCVSS = 11.0`, o sea no vetante POR DISENO - devolvia
// `state: 'pending'`, y ese veredicto alimentaba `detectMergeStateBlock()` y el
// camino BLOCKED de `delivery.js`. Medido el 2026-08-25: 3 h 10 m (17:18 ->
// 20:29) de espera por un control informativo. El unico requerido del ruleset
// de `main` es `pr-status`.
//
// La correccion NO es una lista hardcodeada ni un bypass: la autoridad sigue
// siendo GitHub, que rechaza el merge si un requerido esta en rojo. Se cotejan
// los checks contra la lista de contextos requeridos LEIDA de la proteccion de
// la rama base (`lib/required-checks.js`), y solo esos aportan al `state` que
// puede frenar el merge. El resto se devuelve aparte en `informational` para no
// perder visibilidad.
//
// FAIL-CLOSED (CA-5): el filtro se aplica SOLO con `requiredContextsRead ===
// true` y una lista NO vacia. Si el ruleset no se pudo leer (403, rate limit,
// forma inesperada), pesa todo el rollup - exactamente el comportamiento
// anterior a este cambio. "No pude leer que se exige" jamas significa "no se
// exige nada": ese fail-open convertiria el filtro en un bypass.
// -----------------------------------------------------------------------------

/**
 * Nombre normalizado de un nodo del rollup. GitHub usa `name` para `CheckRun` y
 * `context` para `StatusContext`; aca se leen las dos formas.
 */
function checkNodeName(chk) {
    if (!chk || typeof chk !== 'object') return '';
    const name = typeof chk.name === 'string' ? chk.name.trim() : '';
    if (name) return name;
    const context = typeof chk.context === 'string' ? chk.context.trim() : '';
    return context;
}

/**
 * Este nodo del rollup corresponde al contexto requerido `context`?
 *
 * FUENTE UNICA del cotejo por nombre: `required-checks.js` importa esta funcion
 * en vez de reescribir el `n.name === ctx || n.context === ctx`. Dos copias del
 * mismo matcher divergen en cuanto una de las dos aprende a normalizar algo
 * (espacios al borde, por ejemplo) y la otra no - y la que quede vieja lee un
 * requerido como "ausente", que rio abajo es fail-open.
 */
function checkMatchesContext(chk, context) {
    const ctx = typeof context === 'string' ? context.trim() : '';
    if (!ctx || !chk || typeof chk !== 'object') return false;
    const name = typeof chk.name === 'string' ? chk.name.trim() : '';
    if (name && name === ctx) return true;
    const own = typeof chk.context === 'string' ? chk.context.trim() : '';
    return Boolean(own) && own === ctx;
}

/**
 * Normaliza la lista de contextos requeridos a `string[]` sin duplicados.
 *
 * Acepta las dos formas con las que viaja: los `{context, integration_id}` de
 * `fetchRequiredContexts` y el array de strings pelado. Devuelve `null` si el
 * argumento no es una lista - `null` ("no hay lista") y `[]` ("lista leida y
 * vacia") NO son lo mismo, y esa distincion es la que decide el fail-closed.
 */
function normalizeRequiredContexts(requiredContexts) {
    if (!Array.isArray(requiredContexts)) return null;
    const out = [];
    const vistos = new Set();
    for (const item of requiredContexts) {
        let ctx = '';
        if (typeof item === 'string') ctx = item.trim();
        else if (item && typeof item === 'object' && typeof item.context === 'string') ctx = item.context.trim();
        if (!ctx || vistos.has(ctx)) continue;
        vistos.add(ctx);
        out.push(ctx);
    }
    return out;
}

/**
 * Normaliza `statusCheckRollup` a un veredicto sobre los checks.
 *
 * @param {Array} [rollup] - `prInfo.statusCheckRollup`.
 * @param {object} [opts]
 * @param {Array<string|{context:string}>} [opts.requiredContexts] - contextos
 *   exigidos por la proteccion de la rama BASE (`lib/required-checks.js`).
 * @param {boolean} [opts.requiredContextsRead] - `true` SOLO si la lista se
 *   pudo leer de verdad. Cualquier otro valor desactiva el filtro (fail-closed).
 * @returns {{
 *   state:'failing'|'pending'|'green'|'unknown',
 *   failing:string[], pending:string[], total:number,
 *   informational:{failing:string[], pending:string[]},
 *   requiredFilterApplied:boolean, requiredFilterCause:string|null
 * }}
 *
 * `unknown` es un estado de primera clase a proposito: si no se puede leer el
 * rollup, el mensaje NO debe afirmar que los checks estan en verde. Ese fue
 * exactamente el defecto - afirmar un hecho no verificado.
 *
 * Con el filtro activo, `state` lo determinan SOLO los requeridos y `total`
 * cuenta solo esos. Los no requeridos salen por `informational` y no aportan al
 * veredicto: no frenan el merge ni extienden la espera.
 */
function classifyChecks(rollup, opts = {}) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const leida = o.requiredContextsRead === true;
    const lista = leida ? normalizeRequiredContexts(o.requiredContexts) : null;
    // Lista vacia con lectura OK: no se filtra. Filtrar contra `[]` dejaria CERO
    // checks pesando y todo PR saldria `green` - el fail-open exacto que
    // `required-checks.js` evita con `ruleset-sin-requeridos`.
    const filtrar = Array.isArray(lista) && lista.length > 0;
    const cause = filtrar
        ? null
        : (leida ? 'lista-de-requeridos-vacia' : 'requeridos-no-leidos');
    const meta = {
        informational: { failing: [], pending: [] },
        requiredFilterApplied: filtrar,
        requiredFilterCause: cause,
    };

    if (!Array.isArray(rollup) || rollup.length === 0) {
        return { state: 'unknown', failing: [], pending: [], total: 0, ...meta };
    }
    const failing = [];
    const pending = [];
    const infoFailing = [];
    const infoPending = [];
    let indeterminados = 0;
    let considerados = 0;
    for (const chk of rollup) {
        // Un nodo ilegible no se puede atribuir ni a requerido ni a informativo:
        // pesa SIEMPRE, con filtro o sin el. Descartarlo por "no matchea ningun
        // requerido" seria tratar la ignorancia como via libre.
        if (!chk || typeof chk !== 'object') { indeterminados++; continue; }
        const nombre = String(checkNodeName(chk) || 'check sin nombre');
        const conclusion = String(chk.conclusion || '').toUpperCase();
        const status = String(chk.status || '').toUpperCase();
        const state = String(chk.state || '').toUpperCase();
        const requerido = !filtrar || lista.some((ctx) => checkMatchesContext(chk, ctx));
        if (requerido) considerados++;

        if (CHECK_FAIL_CONCLUSIONS.includes(conclusion) || CHECK_FAIL_STATES.includes(state)) {
            (requerido ? failing : infoFailing).push(nombre);
        } else if (CHECK_PENDING_STATUSES.includes(status) || CHECK_PENDING_STATES.includes(state)) {
            (requerido ? pending : infoPending).push(nombre);
        } else if (!conclusion && !state) {
            // Ni conclusion ni estado: el check existe pero todavia no dijo nada.
            // Solo cuenta si puede vetar; si es informativo, no dice nada que
            // importe para el merge.
            if (requerido) indeterminados++;
        }
        // El resto (SUCCESS / NEUTRAL / SKIPPED) cuenta como no-bloqueante.
    }
    // Filtro activo y NINGUN requerido presente en el rollup: no hay evidencia
    // sobre lo unico que puede vetar. `unknown`, jamas `green` por descarte.
    if (filtrar && considerados === 0) indeterminados++;

    const total = filtrar ? considerados : rollup.length;
    meta.informational = { failing: infoFailing, pending: infoPending };
    if (failing.length) return { state: 'failing', failing, pending, total, ...meta };
    if (pending.length) return { state: 'pending', failing, pending, total, ...meta };
    if (indeterminados) return { state: 'unknown', failing, pending, total, ...meta };
    return { state: 'green', failing, pending, total, ...meta };
}

/**
 * Frase con los checks SIN poder de veto que fallaron o quedaron colgados.
 * Cadena vacia si no hay ninguno.
 *
 * Va en su PROPIA linea a proposito (guideline de UX de #6599): mezclar
 * requeridos e informativos en la misma oracion es lo que hacia que el operador
 * leyera un OWASP colgado como si frenara el merge. Y dice explicitamente que
 * no frenan, en vez de dejarlo implicito en un listado pelado.
 */
function describeInformationalChecks(checks) {
    const info = (checks && checks.informational) || null;
    if (!info) return '';
    const recorte = (arr) => {
        const l = Array.isArray(arr) ? arr : [];
        const head = l.slice(0, 5).join(', ');
        return l.length > 5 ? `${head} y ${l.length - 5} más` : head;
    };
    const partes = [];
    if (Array.isArray(info.failing) && info.failing.length) partes.push(`en rojo: ${recorte(info.failing)}`);
    if (Array.isArray(info.pending) && info.pending.length) partes.push(`todavía corriendo: ${recorte(info.pending)}`);
    if (!partes.length) return '';
    return `\nChecks informativos — la protección de rama no los exige, así que no frenan el merge — ${partes.join('; ')}.`;
}

// -----------------------------------------------------------------------------
// Rotulado de checks para el mensaje al operador (UX-1 / UX-2 de #6612)
//
// EL DEFECTO QUE ARREGLA. `classifyChecks` parte el rollup en dos: los que
// pesan para el veredicto (`failing`/`pending`) y el resto (`informational`).
// Esa particion es correcta PARA DECIDIR, pero es mentira PARA ROTULAR: hay una
// tercera clase de check que el ruleset de `main` no exige y que el pipeline
// igual NO deja mergear — la allowlist de `security-blocking-checks.js`. Hoy
// `runtime-state-guard` (el secret scan del diff del PR, unico contexto de esa
// allowlist) cae en `informational`, y el mensaje al operador le dice que "no
// frena el merge" y que "aprobarlo destraba el issue", mientras el gate (5c) de
// `delivery.js` lo bloquea sin reintento. Es el fail-open de #6602 corrido de
// la maquina al humano: el operador aprueba, el merge no avanza, y nada en el
// texto explica por que.
//
// TRES ROTULOS, NUNCA FUSIONADOS (UX-1):
//   - `requerido`                -> lo exige la proteccion de la rama base.
//   - `bloqueante por seguridad` -> no lo exige el ruleset, pero el pipeline no
//                                   mergea con el en rojo (allowlist de codigo).
//   - `informativo`              -> ni lo uno ni lo otro: constancia, no decision.
//
// Y si la lista de requeridos NO se pudo leer, el mensaje lo dice y no usa el
// adjetivo "requerido" para nada (UX-2): con el filtro apagado `checks.failing`
// trae TODO el rollup, asi que llamar "requeridos" a esos nombres es afirmar un
// hecho no verificado. La rama (c) ya lo resolvia; la (a) se lo pegaba
// incondicionalmente.
// -----------------------------------------------------------------------------

/**
 * ¿Este contexto esta en la allowlist de seguridad del pipeline?
 *
 * REQUIRE DIFERIDO A PROPOSITO. `security-blocking-checks.js` importa los enums
 * de ESTE modulo en su top-level (CA-23 de #6431: los enums se importan, nunca
 * se re-declaran, porque dos copias divergen). Un `require` top-level en esta
 * direccion cerraria el ciclo y dejaria a uno de los dos leyendo un `exports` a
 * medio poblar. Diferido dentro de la funcion no hay ciclo: para cuando alguien
 * clasifica un check, los dos modulos ya estan cargados y cacheados.
 *
 * FAIL-SAFE, NO FAIL-OPEN: si el require fallara, `false` degrada el ROTULO (el
 * check se lee como informativo), nunca el GATE — quien bloquea el merge es
 * `delivery.js` con `classifySecurityBlockingChecks`, no este texto.
 */
function defaultIsSecurityBlockingContext(context) {
    try {
        // eslint-disable-next-line global-require
        return require('./security-blocking-checks').isSecurityBlockingContext(context);
    } catch (_) {
        return false;
    }
}

/**
 * Reparte los nombres que devolvio `classifyChecks` en los tres rotulos de UX-1.
 *
 * @param {object} checks — salida de `classifyChecks`.
 * @param {function} [esSeguridad] — predicado de allowlist (inyectable en tests).
 * @returns {{required:{failing:string[],pending:string[]},
 *            securityBlocking:{failing:string[],pending:string[]},
 *            informational:{failing:string[],pending:string[]}}}
 *
 * PRECEDENCIA: la allowlist gana sobre "requerido". Un contexto que fuera las
 * dos cosas bloquea igual por los dos lados, asi que el rotulo se elige por cual
 * RECOMENDACION le sirve al operador: mirar el hallazgo del escaner es una
 * accion concreta; "devolver a desarrollo" no lo es para un secreto filtrado.
 *
 * Con el filtro de requeridos APAGADO, `checks.failing`/`pending` traen todo el
 * rollup. El reparto sigue siendo valido: la allowlist es una constante de
 * codigo y no depende de haber podido leer el ruleset. Lo que cambia es el
 * adjetivo del grupo `required`, que en ese caso no se escribe.
 */
function groupChecksByLabel(checks, esSeguridad) {
    const pred = typeof esSeguridad === 'function' ? esSeguridad : defaultIsSecurityBlockingContext;
    const c = checks && typeof checks === 'object' ? checks : {};
    const info = (c.informational && typeof c.informational === 'object') ? c.informational : {};
    const out = {
        required: { failing: [], pending: [] },
        securityBlocking: { failing: [], pending: [] },
        informational: { failing: [], pending: [] },
    };
    const lista = (v) => (Array.isArray(v) ? v : []);
    for (const clase of ['failing', 'pending']) {
        for (const nombre of lista(c[clase])) {
            (pred(nombre) ? out.securityBlocking : out.required)[clase].push(nombre);
        }
        for (const nombre of lista(info[clase])) {
            (pred(nombre) ? out.securityBlocking : out.informational)[clase].push(nombre);
        }
    }
    return out;
}

/** Recorte compartido de listas largas: 5 nombres + "y N más" (UX-4). */
function recortarLista(arr) {
    const l = Array.isArray(arr) ? arr : [];
    const head = l.slice(0, 5).join(', ');
    return l.length > 5 ? `${head} y ${l.length - 5} más` : head;
}

/**
 * Adjetivo "requerido"/"requeridos" — SOLO si la lista de requeridos se leyo.
 *
 * UX-2. Sin filtro aplicado, `checks.failing` es el rollup entero y ninguno de
 * esos nombres esta cotejado contra la proteccion de rama. Pegarle el adjetivo
 * igual manda al operador a investigar el lugar equivocado: es exactamente lo
 * que paso con #6602, donde el texto decia "1 check requerido en rojo:
 * runtime-state-guard" y ese check no es requerido por el ruleset.
 */
function adjetivoRequerido(cantidad, filtroAplicado) {
    if (filtroAplicado !== true) return '';
    return cantidad === 1 ? ' requerido' : ' requeridos';
}

/**
 * Aclaracion explicita para cuando NO se pudo leer que exige la rama base.
 * Cadena vacia si el filtro se aplico.
 *
 * UX-1 exige que en ese caso el mensaje lo DIGA y no use ninguno de los tres
 * rotulos por su cuenta. Mismo encuadre que la rama (c) ya usaba para el mismo
 * hecho, en vez de inventar un texto nuevo.
 */
function describeUnreadableRequiredList(checks) {
    if (!checks || typeof checks !== 'object') return '';
    if (checks.requiredFilterApplied === true) return '';
    const causa = checks.requiredFilterCause ? ` (${checks.requiredFilterCause})` : '';
    return `\nNo pude leer qué checks exige la protección de main${causa}, así que peso todos los del PR: no puedo afirmar cuáles son requeridos.`;
}

/**
 * Frase para los checks de la allowlist de seguridad. Cadena vacia si no hay.
 *
 * Linea propia, igual que `describeInformationalChecks` y por el mismo motivo:
 * mezclarlos en la misma oracion es lo que hace que el operador lea un escaner
 * con poder de veto como si fuera decorativo. Y dice explicitamente que aprobar
 * el PR no lo destraba, porque esa es justo la accion equivocada que el texto
 * viejo sugeria.
 */
function describeSecurityBlockingChecks(grupos) {
    const sec = (grupos && grupos.securityBlocking) || null;
    if (!sec) return '';
    const partes = [];
    if (Array.isArray(sec.failing) && sec.failing.length) partes.push(`en rojo: ${recortarLista(sec.failing)}`);
    if (Array.isArray(sec.pending) && sec.pending.length) partes.push(`todavía corriendo: ${recortarLista(sec.pending)}`);
    if (!partes.length) return '';
    return `\nChecks bloqueantes por seguridad — la protección de rama no los exige, pero el pipeline NO mergea con uno en rojo, así que aprobar el PR no lo destraba — ${partes.join('; ')}.`;
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
function detectMergeStateBlock({
    prNumber, mergeable, mergeStateStatus, reviewDecision, statusCheckRollup,
    // #6599 - lista de contextos exigidos por la proteccion de la rama BASE.
    // Ausente o con `requiredContextsRead !== true` => pesa todo el rollup,
    // igual que antes de #6599 (fail-closed, CA-5).
    requiredContexts = null, requiredContextsRead = null,
    // #6612 UX-1 — predicado de la allowlist de seguridad, INYECTABLE.
    // Se pasa por el objeto de entrada (y no con un `require` top-level) porque
    // `security-blocking-checks.js` ya importa este modulo: el require en la
    // otra direccion cerraria el ciclo. Ausente => se usa el default diferido.
    isSecurityBlockingContext = null,
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
        // BLOCKED es ambiguo: puede ser "falta la firma humana" o "hay un check
        // requerido en rojo/pendiente". Antes de hablarle al operador de review,
        // hay que LEER los checks — no suponerlos.
        const checks = classifyChecks(statusCheckRollup, { requiredContexts, requiredContextsRead });
        // #6612 UX-1 — tres rotulos, nunca fusionados. `classifyChecks` decide
        // bien pero rotula mal: mete la allowlist de seguridad en la misma bolsa
        // que un check decorativo. El reparto se hace aca, sobre su salida, para
        // no tocar el clasificador (sus suites y el camino de `delivery.js`
        // dependen de que devuelva byte por byte lo mismo).
        const grupos = groupChecksByLabel(checks, isSecurityBlockingContext);
        const filtroOk = checks.requiredFilterApplied === true;
        // Los no requeridos NUNCA son la causa del bloqueo, pero se nombran:
        // sin esto, un OWASP en rojo desaparece del reporte al operador.
        const infoLinea = describeInformationalChecks({ informational: grupos.informational });
        // Linea propia para la allowlist: NO frena por ruleset, SI frena por
        // pipeline. Decirlo junto con los informativos es la contradiccion que
        // el rebote de la review marco.
        const secLinea = describeSecurityBlockingChecks(grupos);
        // UX-1 — sin lista de requeridos legible no se usa ninguno de los tres
        // rotulos por cuenta propia: se dice que no se pudo leer.
        const sinLista = describeUnreadableRequiredList(checks);
        const infoDetalle = { ...grupos.informational };
        const secDetalle = { ...grupos.securityBlocking };
        // CA-5 - la desactivacion del filtro nunca es muda.
        const filtroRequeridos = {
            applied: checks.requiredFilterApplied === true,
            cause: checks.requiredFilterCause || null,
        };

        // (a) Checks en rojo → esto NO es una firma que el operador deba dar.
        // Invitarlo a aprobar sería empujar un merge roto a `main`. Se notifica
        // igual (el silencio es el bug que #5337 arregla) pero con el encuadre
        // correcto: lo que corresponde es volver a desarrollo, no firmar.
        if (grupos.required.failing.length) {
            const n = grupos.required.failing.length;
            // UX-2 — el adjetivo "requerido(s)" SOLO con el filtro aplicado.
            const adj = adjetivoRequerido(n, filtroOk);
            return {
                trigger: TRIGGERS.CHECKS_FAILING,
                reason: `PR #${prNumber} está BLOCKED con ${n} check(s)${adj} en rojo: ${recortarLista(grupos.required.failing)}. El ruleset de main no lo deja mergear hasta que pasen — no es una review pendiente.${sinLista}${secLinea}${infoLinea}`,
                question: `El PR #${prNumber} tiene checks en rojo. ¿Lo devolvemos a desarrollo para que los arregle, o los mirás vos?`,
                recommendation: 'NO aprobar el PR para destrabarlo: la firma no arregla un check en rojo y el ruleset lo va a seguir frenando. Lo que corresponde es devolver el issue a desarrollo.',
                checks: { state: checks.state, failing: checks.failing },
                informational: infoDetalle,
                securityBlocking: secDetalle,
                requiredFilter: filtroRequeridos,
            };
        }

        // (a2) #6612 UX-1/UX-2 — Ningun requerido en rojo, pero SI un check de la
        // allowlist de seguridad. Antes caia en la rama (c) y el operador leia
        // "sus checks están en verde: si el diff te cierra, aprobarlo destraba el
        // issue" — mientras el gate (5c) de `delivery.js` bloquea el merge sin
        // reintento. Dos afirmaciones opuestas sobre el mismo check.
        //
        // Rotulo, `question` y `recommendation` PROPIOS (UX-2): la recomendacion
        // de la rama (a) —devolver el issue a desarrollo— es correcta para un
        // test requerido en rojo y equivocada para un hallazgo de escaner, donde
        // lo que corresponde es mirar el hallazgo, no rehacer la feature.
        if (grupos.securityBlocking.failing.length) {
            const n = grupos.securityBlocking.failing.length;
            const lista = recortarLista(grupos.securityBlocking.failing);
            return {
                trigger: TRIGGERS.SECURITY_CHECK_RED,
                reason: `PR #${prNumber} está BLOCKED con ${n} check(s) bloqueante(s) por seguridad en rojo: ${lista}. La protección de rama no los exige, pero el pipeline no mergea con un escáner de seguridad en rojo, así que aprobar el PR NO destraba el merge.${sinLista}${infoLinea}`,
                question: `El PR #${prNumber} tiene un escáner de seguridad en rojo (${lista}). ¿Miramos el hallazgo, o confirmás que es un falso positivo?`,
                recommendation: 'Mirar primero el hallazgo del escáner, no el código de la feature: casi siempre es un secreto o un archivo de estado que se coló en el diff. Aprobar el PR no lo destraba — el pipeline bloquea el merge igual hasta que el check pase.',
                checks: { state: checks.state, failing: checks.failing },
                informational: infoDetalle,
                securityBlocking: secDetalle,
                requiredFilter: filtroRequeridos,
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
                informational: infoDetalle,
                securityBlocking: secDetalle,
                requiredFilter: filtroRequeridos,
            };
        }

        // (c) Checks verdes (o rollup ilegible) → recién acá es review humana.
        // La recomendación sólo afirma el estado de los checks si se pudo LEER;
        // si no, lo dice explícitamente en vez de inventarlo.
        const porReview = review === 'REVIEW_REQUIRED' || review === '' || review === 'CHANGES_REQUESTED';
        const checksVerdes = checks.state === 'green';
        // Concordancia: con el filtro activo `total` suele ser 1 (el ruleset de
        // `main` exige un solo contexto), y "sus 1 checks" se lee como un bug.
        const unico = checks.total === 1;
        const sufijoReq = checks.requiredFilterApplied !== true ? '' : (unico ? ' requerido' : ' requeridos');
        const sujeto = unico
            ? `su único check${sufijoReq} está en verde`
            : `sus ${checks.total} checks${sufijoReq} están en verde`;
        const recommendation = checksVerdes
            ? `El PR no tiene conflictos y ${sujeto}: sólo falta la review. Si el diff te cierra, aprobarlo destraba el issue.`
            : 'El PR no tiene conflictos de merge, pero no pude leer el estado de sus checks: miralos en GitHub antes de aprobar.';
        return {
            trigger: TRIGGERS.CODEOWNERS_REVIEW,
            reason: `PR #${prNumber} está mergeable pero BLOCKED: el ruleset de main exige una aprobación humana${porReview ? ` (reviewDecision=${review || 'sin review'})` : ''}. CODEOWNERS cubre las rutas tocadas.${secLinea}${infoLinea}`,
            question: `¿Podés revisar y aprobar el PR #${prNumber}? Sin tu firma el merge no avanza y el pipeline queda esperando.`,
            recommendation,
            checks: { state: checks.state },
            informational: infoDetalle,
            securityBlocking: secDetalle,
            requiredFilter: filtroRequeridos,
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
 * @param {Array}  [opts.requiredContexts]      — #6599, contextos del ruleset base.
 * @param {boolean}[opts.requiredContextsRead]  — #6599, `true` sólo si se leyeron.
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
        // #6599 — sin esta lista el filtro queda desactivado y pesa todo el
        // rollup: el default es el comportamiento previo, nunca un relajo.
        requiredContexts: opts.requiredContexts,
        requiredContextsRead: opts.requiredContextsRead,
        // #6612 UX-1 — override del predicado de allowlist. Opcional: ausente,
        // se usa el default diferido de `security-blocking-checks.js`. Existe
        // para que las suites puedan inyectar una allowlist de prueba sin
        // acoplarse a la lista real (que es una constante congelada a proposito).
        isSecurityBlockingContext: opts.isSecurityBlockingContext,
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
    alertBelongsToPr,
    classifyChecks,
    // #6599 — cotejo de nombres y normalización de la lista de requeridos.
    // `required-checks.js` los IMPORTA en vez de reescribirlos.
    checkNodeName,
    checkMatchesContext,
    normalizeRequiredContexts,
    describeInformationalChecks,
    // #6612 UX-1/UX-2 — rotulado de checks para el mensaje al operador.
    groupChecksByLabel,
    describeSecurityBlockingChecks,
    describeUnreadableRequiredList,
    adjetivoRequerido,
    normalizeCause,
    detectSecurityFindingBlock,
    detectMergeStateBlock,
    detectDecisionRequestBlock,
    detectRepeatedRejectionBlock,
    detectPrHumanBlock,
};

// =============================================================================
// security-blocking-checks.js — Allowlist de checks que el pipeline NO mergea
// en rojo, aunque la protección de rama no los exija (#6612, SEC-A).
//
// EL DEFECTO QUE ARREGLA. El ruleset de `main` exige UN solo contexto:
//
//     $ gh api repos/intrale/platform/rules/branches/main \
//         --jq '[.[]|select(.type=="required_status_checks")
//                |.parameters.required_status_checks[].context]'
//     ["pr-status"]
//
// Es decir: TODOS los controles de seguridad del repo son "no requeridos".
// #6612 acota la espera de `delivery` a los checks requeridos — y hacerlo solo,
// sin este módulo, convierte a los escáneres en decorativos. No es hipotético:
// el PR #6602 ya se mergeó con `runtime-state-guard` (el secret scan del diff
// del PR) en FAILURE.
//
// "No requerido por el ruleset" != "no bloqueante para el pipeline". Son dos
// listas con ciclos de vida OPUESTOS y por eso viven en archivos distintos
// (G-5): la de requeridos es dinámica y se lee del ruleset en cada pasada; ésta
// es constante, inmutable y versionada con el código.
//
// POR QUÉ ES UNA CONSTANTE DE CÓDIGO Y NO CONFIG (SEC-A). Si la lista saliera
// de `config.yaml` o de una variable de entorno, cualquier agente con permiso
// de escritura sobre el repo —o sobre el entorno del proceso— podría vaciar el
// gate de seguridad con un commit de una línea y mergear con el escáner en
// rojo. Un gate que el sujeto controlado puede desactivar no es un gate.
//
// PURO: sin red, sin `gh`, sin filesystem. Recibe el rollup ya leído y devuelve
// un veredicto. Testeable en milisegundos (misma disciplina que
// `human-block-triggers.js`).
// =============================================================================

'use strict';

// #6612 CA-23 de #6431 — Los enums de estado se IMPORTAN, nunca se re-declaran.
// Dos copias de la misma tabla divergen en cuanto GitHub agrega un valor de
// `conclusion`, y la copia que quede vieja lee ese valor como "no bloqueante":
// un fail-open silencioso, con los tests de las dos copias en verde.
const { CHECK_FAIL_CONCLUSIONS, CHECK_FAIL_STATES } = require('./human-block-triggers');

// -----------------------------------------------------------------------------
// LA ALLOWLIST. Sólo entra un contexto que cumple LAS DOS condiciones:
//
//   (1) es un control de seguridad, y
//   (2) puede VETAR de verdad — o sea, su job NO corre en modo warning.
//
// La (2) no es un tecnicismo. Un job con `continue-on-error: true` le reporta
// `SUCCESS` a GitHub AUNQUE sus pasos fallen, así que un contexto en modo
// warning es estructuralmente incapaz de aparecer en rojo en el rollup.
// Verificado contra los rollups reales (no contra el YAML):
//
//   $ gh pr view 6602 --json statusCheckRollup   # el PR del fail-open
//     runtime-state-guard      => COMPLETED/FAILURE   <-- unico rojo
//     OWASP Dependency Check   => COMPLETED/SUCCESS
//     Semgrep Static Analysis  => COMPLETED/SUCCESS
//     detect-secrets Scan      => COMPLETED/SUCCESS
//     pr-status                => COMPLETED/SUCCESS   <-- el unico requerido
//
// Ese es exactamente el merge que #6612 viene a impedir: el secret scan del
// diff en FAILURE, el único requerido en verde, y el PR mergeado igual.
//
//   runtime-state-guard → .github/workflows/runtime-state-guard.yml:10 (job key;
//                         el job no declara `name:`, así que el contexto
//                         publicado es la key). Corre `precommit-secret-scan.js`
//                         sobre el diff del PR y NO declara `continue-on-error`:
//                         es el único escáner con poder de veto hoy.
//
// `Object.freeze` no es decorativo: sin él, un `push()` desde cualquier módulo
// del proceso agranda el gate en caliente, y un `splice()` lo vacía.
// -----------------------------------------------------------------------------
const SECURITY_BLOCKING_CONTEXTS = Object.freeze([
    'runtime-state-guard',
]);

// -----------------------------------------------------------------------------
// LOS ESCÁNERES EN MODO WARNING. No están en la allowlist a propósito, y esto
// NO es un olvido: es el estado declarado del repo.
//
//   OWASP Dependency Check   → security-sast.yml:21  `continue-on-error: true`
//   Semgrep Static Analysis  → security-sast.yml:77  `continue-on-error: true`
//   detect-secrets Scan      → security-sast.yml:135 `continue-on-error: true`
//
// Meterlos en la allowlist sería un gate que no puede dispararse (reportan
// SUCCESS aunque fallen) y además contradiría un criterio YA MERGEADO: #6599
// CA-3 (`delivery-merge-6599.test.js`) fija que un check no requerido en rojo
// —y usa justamente el OWASP como ejemplo— MERGEA y queda registrado.
//
// Quien los saca de modo warning es #6615. Cuando eso pase, pasan a cumplir la
// condición (2) y el cambio es mover el nombre de esta lista a la de arriba;
// hay un test que ancla las dos listas para que la mudanza sea consciente.
//
// Mientras tanto NO desaparecen: un rojo suyo cae en la constancia de UX-3
// (comentario en el PR) igual que cualquier otro check no requerido en rojo, y
// `classifySecurityBlockingChecks` lo devuelve en `warningMode` para que el
// log diga por qué no frenó en vez de callarse.
// -----------------------------------------------------------------------------
const WARNING_MODE_SECURITY_CONTEXTS = Object.freeze([
    'OWASP Dependency Check',
    'Semgrep Static Analysis',
    'detect-secrets Scan',
]);

/**
 * ¿Hay algún check de la allowlist terminado en ROJO?
 *
 * @param {{rollup: Array|null}} args — `rollup` es `statusCheckRollup` tal como
 *        lo dejó `getPRSnapshot`: array (leído) o `null` (no se pudo leer).
 * @returns {{verdict:'block'|'clear'|'unusable', failing:string[],
 *            warningMode:string[], cause:string|null}}
 *
 * `warningMode` lista los escáneres que fallaron pero corren con
 * `continue-on-error: true` (#6615). NO cambian el veredicto — se devuelven
 * para que el log pueda decir "esto está en rojo y no frenó, y este es el
 * motivo" en vez de omitirlos.
 *
 * DISCIPLINA DE DOS VALORES (G-3). `null` = "no lo leí" y `[]` = "lo leí y está
 * vacío" son estados DISTINTOS, y colapsarlos es el fail-open exacto que este
 * módulo tiene que evitar: leer "no pude consultar los checks" como "ningún
 * escáner está en rojo". La disciplina ya está escrita y documentada en
 * `delivery.js` (bloque `statusCheckRollup` de `getPRSnapshot`) — se reusa, no
 * se reinventa.
 *
 * SÓLO MIRA `failure` (SEC-B). Un check de la allowlist EN CURSO no frena nada:
 * para eso está el acotamiento por requeridos de #6612. Si esta función también
 * bloqueara por `pending`, el escáner OWASP de 3 h volvería a frenar el merge
 * por la puerta de al lado y el issue no arreglaría nada.
 */
function classifySecurityBlockingChecks({ rollup } = {}) {
    if (!Array.isArray(rollup)) {
        return { verdict: 'unusable', failing: [], warningMode: [], cause: 'rollup-no-legible' };
    }
    if (rollup.length === 0) {
        return { verdict: 'clear', failing: [], warningMode: [], cause: null };
    }

    const failing = [];
    const warningMode = [];
    let ilegibles = 0;
    for (const chk of rollup) {
        if (!chk || typeof chk !== 'object') {
            // Una entrada que no se puede inspeccionar no se puede descartar:
            // podría ser justo el escáner en rojo. Se cuenta y, si no hubo
            // ningún rojo confirmado, el veredicto es `unusable` — nunca
            // `clear`.
            ilegibles++;
            continue;
        }
        // `statusCheckRollup` mezcla dos formas según el proveedor:
        //   CheckRun      → {name, status, conclusion}
        //   StatusContext → {context, state}
        const nombre = String(chk.name || chk.context || '');
        const bloqueante = SECURITY_BLOCKING_CONTEXTS.includes(nombre);
        const enWarning = WARNING_MODE_SECURITY_CONTEXTS.includes(nombre);
        if (!bloqueante && !enWarning) continue;

        const conclusion = String(chk.conclusion || '').toUpperCase();
        const state = String(chk.state || '').toUpperCase();
        if (CHECK_FAIL_CONCLUSIONS.includes(conclusion) || CHECK_FAIL_STATES.includes(state)) {
            (bloqueante ? failing : warningMode).push(nombre);
        }
    }

    if (failing.length) {
        return { verdict: 'block', failing, warningMode, cause: 'check-de-seguridad-en-rojo' };
    }
    if (ilegibles) {
        return {
            verdict: 'unusable', failing: [], warningMode,
            cause: 'entradas-del-rollup-ilegibles',
        };
    }
    return { verdict: 'clear', failing: [], warningMode, cause: null };
}

/**
 * ¿Este contexto está en la allowlist de seguridad?
 * Sirve para ROTULAR (UX-1): separar "bloqueante por seguridad" de "informativo".
 */
function isSecurityBlockingContext(context) {
    return SECURITY_BLOCKING_CONTEXTS.includes(String(context || ''));
}

module.exports = {
    SECURITY_BLOCKING_CONTEXTS,
    WARNING_MODE_SECURITY_CONTEXTS,
    classifySecurityBlockingChecks,
    isSecurityBlockingContext,
};

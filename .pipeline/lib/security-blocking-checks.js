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
// La allowlist. PISO MÍNIMO, verificado contra los workflows del repo:
//
//   runtime-state-guard      → .github/workflows/runtime-state-guard.yml:10
//                              (job key; el job no declara `name:`, así que el
//                              contexto publicado es la key). Corre
//                              `precommit-secret-scan.js` sobre el diff del PR.
//   OWASP Dependency Check   → .github/workflows/security-sast.yml:19 (`name:`)
//   Semgrep Static Analysis  → .github/workflows/security-sast.yml:75 (`name:`)
//   detect-secrets Scan      → .github/workflows/security-sast.yml:133 (`name:`)
//
// `Object.freeze` no es decorativo: sin él, un `push()` desde cualquier módulo
// del proceso agranda el gate en caliente, y un `splice()` lo vacía.
// -----------------------------------------------------------------------------
const SECURITY_BLOCKING_CONTEXTS = Object.freeze([
    'runtime-state-guard',
    'OWASP Dependency Check',
    'Semgrep Static Analysis',
    'detect-secrets Scan',
]);

/**
 * ¿Hay algún check de la allowlist terminado en ROJO?
 *
 * @param {{rollup: Array|null}} args — `rollup` es `statusCheckRollup` tal como
 *        lo dejó `getPRSnapshot`: array (leído) o `null` (no se pudo leer).
 * @returns {{verdict:'block'|'clear'|'unusable', failing:string[], cause:string|null}}
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
        return { verdict: 'unusable', failing: [], cause: 'rollup-no-legible' };
    }
    if (rollup.length === 0) {
        return { verdict: 'clear', failing: [], cause: null };
    }

    const failing = [];
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
        if (!SECURITY_BLOCKING_CONTEXTS.includes(nombre)) continue;

        const conclusion = String(chk.conclusion || '').toUpperCase();
        const state = String(chk.state || '').toUpperCase();
        if (CHECK_FAIL_CONCLUSIONS.includes(conclusion) || CHECK_FAIL_STATES.includes(state)) {
            failing.push(nombre);
        }
    }

    if (failing.length) {
        return { verdict: 'block', failing, cause: 'check-de-seguridad-en-rojo' };
    }
    if (ilegibles) {
        return { verdict: 'unusable', failing: [], cause: 'entradas-del-rollup-ilegibles' };
    }
    return { verdict: 'clear', failing: [], cause: null };
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
    classifySecurityBlockingChecks,
    isSecurityBlockingContext,
};

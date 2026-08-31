'use strict';

// =============================================================================
// .pipeline/lib/test-helpers/with-env.js
//
// QUE ES: el helper de AISLAMIENTO DE `process.env` para las suites `node:test`
// del pipeline (#6258). Guarda / muta / restaura un conjunto ACOTADO y EXPLICITO
// de variables de entorno alrededor de una funcion bajo prueba, para que el
// resultado de un test deje de depender del entorno del proceso que lo corre.
//
// QUE NO ES — hay otras dos rutas con nombre parecido en este repo (R-4). Ninguna
// de las dos se toca desde aca; la unificacion se discute en #6261:
//   * `.pipeline/lib/_test-helpers/` (CON guion bajo) — helpers de infraestructura
//     de test no relacionados con el entorno (hoy: `ensure-git-on-path.js`).
//   * `.pipeline/lib/__tests__/_test-helpers.js` — modulo suelto de utilidades de
//     las suites que viven en `__tests__/`. Se diferencia de la anterior por un
//     unico caracter; no confundir.
// Este archivo es el tercero y unico camino para aislar `process.env`. Si
// necesitas aislar `require.cache`, un tmpdir o el reloj, eso NO va aca.
//
// Los criterios vigentes son `CA-6258-1..22` y las decisiones `D-6258-1..10`:
//   https://github.com/intrale/platform/issues/6258#issuecomment-5371827269
// =============================================================================

/**
 * SEC-6 / H-5 — CONTRATO EXPORTADO: array de `RegExp` (NO de strings).
 *
 * Lo consume el guardrail de #6260. Si alguien cambia el shape (a strings, a un
 * Set, a un objeto), ese guardrail deja de matchear y **falla abierto en
 * silencio**. Hay un test de contrato en `lib/__tests__/with-env.test.js` que
 * rompe si la forma cambia: no lo "arregles" relajandolo.
 *
 * SEC-6 / R-8 — la resolucion es POR PATRON, no por enumeracion: el proximo
 * `PULPO_SKIP_*` que alguien agregue nace ya cubierto por el control.
 *
 * Los patrones son case-insensitive porque `process.env` en Windows tambien lo
 * es: una clave en minusculas no puede evadir el control y habilitar su alias.
 *
 * @type {ReadonlyArray<RegExp>}
 */
const SECURITY_CONTROL_VARS = Object.freeze([
    /^PULPO_SKIP_[A-Z0-9_]+$/i,              // PULPO_SKIP_DATA_RESIDENCY_VALIDATE, PULPO_SKIP_SECRETS_HALT, ...
    /^PULPO_NO_[A-Z0-9_]+$/i,                // PULPO_NO_AUTOSTART y los que vengan
    /^[A-Z0-9_]*GATE[0-9A-Z_]*_ENABLED$/i,   // PIPELINE_GATE0_ENABLED, QUOTA_SNAPSHOT_GATE_ENABLED, ...
]);

/**
 * Es el nombre de una variable de control de seguridad?
 * `PIPELINE_DIR_OVERRIDE` deliberadamente NO lo es (CA-6258-9): sin eso las
 * suites `waves-*` no podrian usar este helper para lo que motiva la historia.
 *
 * @param {string} name
 * @returns {boolean}
 */
function isSecurityControlVar(name) {
    if (typeof name !== 'string' || !name) return false;
    return SECURITY_CONTROL_VARS.some((re) => re.test(name));
}

/**
 * Valor efectivo que terminaria en `process.env`.
 * D-6258-5: `null` se trata como `undefined` — BORRA la variable. Nunca se
 * escribe el string literal `"null"` en el entorno.
 *
 * @param {*} v
 * @returns {string|undefined} `undefined` = la variable queda ausente.
 */
function effectiveValue(v) {
    return (v === undefined || v === null) ? undefined : String(v);
}

/**
 * SEC-7 — este valor deja la variable HABILITADA?
 * Se evalua sobre el EFECTO (que queda en el entorno), no sobre la sintaxis:
 * `undefined`, `null`, `'0'`, el numero `0` y `''` son todos deshabilitantes.
 *
 * @param {*} v
 * @returns {boolean}
 */
function isEnablingValue(v) {
    const eff = effectiveValue(v);
    return !(eff === undefined || eff === '0' || eff === '');
}

// UX / CA-6258-13 (D-6258-6) — copy afirmativo, ASCII puro, sin depender de una
// tilde para leerse bien. Enumera las TRES salidas permitidas y nombra la
// variable bloqueada; NUNCA su valor (CA-6258-10).
function buildSecurityControlMessage(bloqueadas) {
    return 'withEnv: prohibido habilitar variables de control de seguridad ('
        + bloqueadas.join(', ')
        + '). Hay tres alternativas permitidas: (1) pasar el env como parametro '
        + 'explicito a la funcion bajo prueba; (2) forzar la ausencia de la variable '
        + 'con undefined o null; (3) desactivarla con "0". Lo unico bloqueado es el '
        + 'sentido que la habilita.';
}

/**
 * SEC-1 — snapshot de un conjunto EXPLICITO de variables.
 *
 * Devuelve SOLO las claves pedidas. Nunca clona el entorno completo: un spread
 * de `process.env` arrastraria `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, etc.
 * al primer `assert` que falle y los volcaria al log del agente.
 *
 * Fail-closed (CA-6258-7 / UX-1): sin un array NO VACIO de nombres validos tira
 * `TypeError`. No existe ningun camino que degrade a clonar todo el entorno.
 *
 * @param {string[]} names
 * @returns {Object<string, string|undefined>} `undefined` = estaba ausente.
 */
function snapshotEnv(names) {
    if (!Array.isArray(names) || names.length === 0
        || names.some((n) => typeof n !== 'string' || n.length === 0)) {
        throw new TypeError(
            'snapshotEnv(names): se espera un array NO VACIO de nombres de variable (string no vacio). '
            + 'Es fail-closed a proposito: no hay fallback que clone process.env completo.',
        );
    }
    const snap = Object.create(null);
    for (const n of names) snap[n] = process.env[n];
    return snap;
}

/**
 * Restaura el entorno a partir de un snapshot de `snapshotEnv`.
 * `undefined` en el snapshot = la variable estaba ausente -> se BORRA (nunca se
 * repone como el string `'undefined'`).
 *
 * @param {Object<string, string|undefined>} snap
 */
function restoreEnv(snap) {
    if (!snap || typeof snap !== 'object') {
        throw new TypeError('restoreEnv(snap): se espera el objeto devuelto por snapshotEnv().');
    }
    for (const n of Object.keys(snap)) {
        if (snap[n] === undefined) delete process.env[n];
        else process.env[n] = snap[n];
    }
}

/**
 * Corre `fn` con `vars` aplicadas sobre `process.env` y restaura el entorno al
 * salir — pase lo que pase.
 *
 * - `undefined` / `null` como valor -> la variable queda AUSENTE durante `fn`.
 * - `fn` sincronica que lanza -> se restaura y la excepcion se propaga SIN
 *   envolver (misma instancia).
 * - `fn` async -> se devuelve la promesa y la restauracion ocurre DESPUES del
 *   settle (durante el `await` las variables siguen vigentes).
 * - SEC-7: habilitar una variable de control de seguridad tira ANTES de mutar
 *   nada, asi que ante ese error el entorno nunca se toco.
 * - D-6258-4: `vars` vacio tira. Un no-op silencioso que aparenta aislar es el
 *   peor modo de fallo posible en una herramienta de hermeticidad.
 *
 * @template T
 * @param {Object<string, string|number|null|undefined>} vars
 * @param {() => T} fn
 * @returns {T}
 */
function withEnv(vars, fn) {
    if (!vars || typeof vars !== 'object' || Array.isArray(vars)) {
        throw new TypeError('withEnv(vars, fn): `vars` debe ser un objeto plano de nombre -> valor.');
    }
    const names = Object.keys(vars);
    if (names.length === 0) {
        throw new TypeError(
            'withEnv(vars, fn): `vars` no puede estar vacio. Sin variables que aislar el helper seria '
            + 'un no-op silencioso que aparenta aislar; si no necesitas aislar nada, llama a `fn` directo.',
        );
    }
    if (typeof fn !== 'function') {
        throw new TypeError('withEnv(vars, fn): `fn` debe ser una funcion.');
    }

    // SEC-7 + D-3: validar ANTES de mutar. Si tira, el entorno quedo intacto.
    const bloqueadas = names.filter((n) => isSecurityControlVar(n) && isEnablingValue(vars[n]));
    if (bloqueadas.length) {
        // CA-6258-10: se nombra la clave, NUNCA el valor. Prohibido serializar `vars`.
        throw new Error(buildSecurityControlMessage(bloqueadas));
    }

    const snap = snapshotEnv(names);
    for (const n of names) {
        const eff = effectiveValue(vars[n]);
        if (eff === undefined) delete process.env[n];
        else process.env[n] = eff;
    }

    let result;
    try {
        result = fn();
    } catch (e) {
        restoreEnv(snap);
        throw e;                                  // propaga SIN envolver
    }
    if (result && typeof result.then === 'function') {
        return result.then(                       // restaura DESPUES del settle
            (v) => { restoreEnv(snap); return v; },
            (e) => { restoreEnv(snap); throw e; },
        );
    }
    restoreEnv(snap);
    return result;
}

module.exports = {
    withEnv,
    snapshotEnv,
    restoreEnv,
    SECURITY_CONTROL_VARS,
    isSecurityControlVar,
};

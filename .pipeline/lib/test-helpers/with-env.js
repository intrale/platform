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
//
// #6260 — este archivo YA NO MANTIENE LISTA PROPIA. La resolucion de "que es
// una variable de control" y "cual es su sentido inseguro" sale del registro
// unico `lib/test-env-lint.protected.json`, via `lib/test-env-lint.js`. Dos
// listas divergentes (el patron de aca vs. el registro del guardrail) fueron la
// causa raiz del hallazgo `alta` de `security`: separar el registro de su unico
// otro consumidor GARANTIZA que vuelvan a divergir (R-A12).
// =============================================================================

const { getRegistry, esSentidoInseguro } = require('../test-env-lint');

/**
 * SEC-6 / H-5 — CONTRATO EXPORTADO: array de `RegExp` (NO de strings).
 *
 * Lo consume el guardrail de #6260. Si alguien cambia el shape (a strings, a un
 * Set, a un objeto), ese guardrail deja de matchear y **falla abierto en
 * silencio**. Hay un test de contrato en `lib/__tests__/with-env.test.js` que
 * rompe si la forma cambia: no lo "arregles" relajandolo.
 *
 * SEC-6 / R-8 + #6260 — la resolucion es POR PATRON **Y** POR ENUMERACION
 * NOMINAL, ambos DERIVADOS DE UN REGISTRO UNICO. La cobertura es la UNION de
 * las dos formas: una nunca resta cobertura a la otra. Las familias siguen
 * abiertas — el proximo `PULPO_SKIP_*` que alguien agregue nace ya cubierto por
 * el control, sin tocar ninguna lista.
 *
 * Los patrones son case-insensitive porque `process.env` en Windows tambien lo
 * es: una clave en minusculas no puede evadir el control y habilitar su alias.
 * Eso vale TAMBIEN para las entradas nominales, que se derivan a
 * `new RegExp('^' + escapeRegExp(nombre) + '$', 'i')`.
 *
 * @type {ReadonlyArray<RegExp>}
 */
const SECURITY_CONTROL_VARS = getRegistry().regexes;

/**
 * Es el nombre de una variable de control de seguridad?
 * `PIPELINE_DIR_OVERRIDE` deliberadamente NO lo es (CA-6258-9): sin eso las
 * suites `waves-*` no podrian usar este helper para lo que motiva la historia.
 * Desde #6260 eso esta blindado ESTRUCTURALMENTE por la lista negra de
 * no-captura del validador del registro (CA-27.4), no por convencion.
 *
 * @param {string} name
 * @returns {boolean}
 */
function isSecurityControlVar(name) {
    if (typeof name !== 'string' || !name) return false;
    return getRegistry().direction(name) !== null;
}

/** Direccion insegura declarada para `name`, o `null` si no es de control. */
function direccionDe(name) {
    if (typeof name !== 'string' || !name) return null;
    return getRegistry().direction(name);
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

// UX / CA-6258-13 (D-6258-6) + #6260 seccion 10 — copy afirmativo, ASCII puro,
// sin depender de una tilde para leerse bien. Nombra la variable bloqueada;
// NUNCA su valor (CA-6258-10).
//
// La salida por valor se DERIVA DE LA DIRECCION de cada variable. El texto fijo
// anterior era falso para 9 de las 16 entradas del registro: ofrecia como salida
// exactamente lo que el guardrail bloquea. Un mensaje de guardrail que instruye
// mal consume el intento del dev y empuja al `--no-verify` que el hook existe
// para evitar.
//
// (c): si el mismo `throw` agrupa variables de direcciones distintas, la salida
// por valor se enumera POR VARIABLE — nunca una sugerencia unica que sea falsa
// para alguna de ellas.
function salidaPorValor(sentido) {
    if (sentido === 'apagar') {
        return 'la unica salida por valor es "1"; lo bloqueado es el sentido que la apaga';
    }
    if (sentido === 'cualquiera') {
        return 'no hay salida por valor porque toda escritura es insegura; lo bloqueado es cualquier escritura';
    }
    return 'forzar la ausencia de la variable con undefined o null, o desactivarla con "0"; '
        + 'lo bloqueado es el sentido que la habilita';
}

function buildSecurityControlMessage(bloqueadas) {
    const detalle = bloqueadas
        .map((b) => `${b.nombre}: ${salidaPorValor(b.sentido)}`)
        .join('. ');
    return 'withEnv: prohibido escribir variables de control de seguridad en su sentido inseguro ('
        + bloqueadas.map((b) => b.nombre).join(', ')
        + '). Hay dos alternativas permitidas siempre, en cualquier direccion: (1) pasar el env como '
        + 'parametro explicito a la funcion bajo prueba; (2) el opt-in nominal de withEnv, '
        + '{ permitirApagarControl: [...], motivo: "..." }, cuando el test necesita esa posicion a '
        + 'proposito. Salida por valor, enumerada por variable: ' + detalle + '.';
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
 * - SEC-7: escribir una variable de control en su SENTIDO INSEGURO tira ANTES
 *   de mutar nada, asi que ante ese error el entorno nunca se toco.
 * - D-6258-4: `vars` vacio tira. Un no-op silencioso que aparenta aislar es el
 *   peor modo de fallo posible en una herramienta de hermeticidad.
 *
 * #6260 seccion 9 — OPT-IN NOMINAL. "Estricta" significa *no perdonable por
 * allowlist*, NO *prohibido*. Un test que prueba el comportamiento con un gate
 * apagado es legitimo; sin salida, el remedio del equipo es `--no-verify`.
 *
 *     withEnv({ PIPELINE_GATE0_ENABLED: undefined }, fn, {
 *         permitirApagarControl: ['PIPELINE_GATE0_ENABLED'],
 *         motivo: 'ejercita la rama default-arg de isGate0Enabled() con el flag ausente',
 *     });
 *
 * Es UN SOLO punto de entrada (no se duplica la API ni el contrato exportado) y
 * obliga a nombrar la variable y a escribir el motivo. `motivo` ausente o vacio
 * tira: deliberado y auditable con `grep -rn "permitirApagarControl" .pipeline`.
 *
 * "Reconocida" = que el REGISTRO la resuelva por CUALQUIERA de sus dos formas,
 * entrada `nombre` o entrada `patron` — operativamente `isSecurityControlVar(v)`.
 * El adjetivo "nominal" califica a la FORMA del opt-in (hay que escribir el
 * nombre literal de la variable, nunca un patron), NO al modo en que esa
 * variable entro al registro: `PIPELINE_GATE0_ENABLED` no figura en la tabla
 * nominal y resuelve por familia, y aun asi el opt-in la acepta (CA-40.5).
 *
 * @template T
 * @param {Object<string, string|number|null|undefined>} vars
 * @param {() => T} fn
 * @param {{permitirApagarControl?: string[], motivo?: string}} [opts]
 * @returns {T}
 */
function withEnv(vars, fn, opts = {}) {
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
    if (!opts || typeof opts !== 'object' || Array.isArray(opts)) {
        throw new TypeError('withEnv(vars, fn, opts): `opts` debe ser un objeto plano.');
    }

    const optIn = opts.permitirApagarControl;
    if (optIn !== undefined && (!Array.isArray(optIn) || optIn.some((n) => typeof n !== 'string' || !n))) {
        throw new TypeError(
            'withEnv(..., { permitirApagarControl }): se espera un array de NOMBRES literales de variable. '
            + 'La forma del opt-in es nominal: nunca un patron.',
        );
    }
    // `process.env` en Windows es case-insensitive: el opt-in tambien, para que
    // una diferencia de casing no se lea como "esta variable no estaba listada".
    const permitidas = new Set((optIn || []).map((n) => n.toUpperCase()));
    if (permitidas.size > 0) {
        if (!String(opts.motivo === undefined || opts.motivo === null ? '' : opts.motivo).trim()) {
            throw new Error(
                'withEnv: el opt-in `permitirApagarControl` exige `motivo` no vacio. Apagar un control de '
                + 'seguridad en un test es legitimo, pero tiene que quedar escrito POR QUE: es lo que hace '
                + 'la excepcion auditable en vez de invisible.',
            );
        }
        for (const n of optIn) {
            if (!isSecurityControlVar(n)) {
                throw new Error(
                    'withEnv: `' + n + '` no es una variable de control de seguridad, asi que listarla en '
                    + '`permitirApagarControl` no habilita nada. El opt-in no es un comodin: para una '
                    + 'variable corriente usa `withEnv` normal.',
                );
            }
        }
    }

    // SEC-7 + D-3: validar ANTES de mutar. Si tira, el entorno quedo intacto.
    const bloqueadas = [];
    for (const n of names) {
        if (permitidas.has(n.toUpperCase())) continue;
        const sentido = direccionDe(n);
        if (sentido === null) continue;
        if (esSentidoInseguro(vars[n], sentido)) bloqueadas.push({ nombre: n, sentido });
    }
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

// =============================================================================
// #6192 — Teclado de firma del GATE 1 · capability + botones.
//
// POR QUÉ ES UN MÓDULO Y NO UNA FUNCIÓN DENTRO DE `pulpo.js`
// ----------------------------------------------------------
// Vivía como función privada del monolito, y por eso su test la REPLICABA en
// vez de invocarla: el test armaba un gate hermético y repetía la secuencia
// `register×3 → buildInlineKeyboard`. Una réplica no es una prueba. Verificaba
// que `operator-gate` sabe armar un teclado —cosa que ya se sabía— y no que
// ESTE camino lo arme. El resultado fue que el camino real devolvía `null` en
// todos los barridos mientras la suite pasaba en verde.
//
// Acá la dependencia entra por parámetro (`gateFactory`), así que el test
// ejercita la MISMA función que corre en producción y sólo cambia de dónde sale
// el gate. Es la diferencia entre probar el código y probar una copia suya.
//
// POR QUÉ DEVUELVE `{ok, keyboard, code}` Y NO SÓLO EL TECLADO
// ------------------------------------------------------------
// Porque "no hay botones" no es un detalle de presentación: cambia lo que el
// aviso puede prometer. El caller necesita distinguir "hay botones" de "no se
// pudo emitir ninguna firma" para clasificar la ficha, y con un `null` pelado
// esa distinción se pierde. Un `null` silencioso fue exactamente lo que dejó
// salir un aviso que pedía firmar sin dar con qué firmar.
//
// CUÁNDO FALLA (y por qué no se arregla acá)
// -------------------------------------------
// `operator-gate.getDefault()` construye su firmador con `createTokenSigner()`,
// que resuelve el material de firma con `credentials.resolveVaultOnly(...)`.
// Esa resolución es vault-only DELIBERADAMENTE (#5451/#5635): un fallo del
// vault se propaga como fallo y NO cae al archivo local. Con el vault cerrado
// no hay firma posible, y fabricar una clave local acá sería revertir esa
// decisión de seguridad de contrabando, desde un helper de UI de notificación.
// Se degrada con gracia y se dice la verdad; no se simula la capability.
// =============================================================================

/** Las tres acciones del gate de firma, en el orden en que se muestran. */
const ACCIONES_GATE1 = Object.freeze(['approve', 'reject', 'adjust-definicion']);

/**
 * Registra las tres capabilities de firma del GATE 1 y arma el teclado inline.
 *
 * El `callback_data` de cada botón es el id opaco que devuelve
 * `operator-gate.register()`: 16 hex sin issue, ni acción, ni tenant adentro.
 * El binding vive server-side en disco. Está prohibido construir un
 * `callback_data` propio — sería un dato client-controlled decidiendo qué se
 * firma — y por eso acá no se compone ninguna cadena.
 *
 * La AUTORIZACIÓN no se decide en este módulo: `operator-gate.handleSignature()`
 * valida `from.id` contra la allowlist resuelta server-side, re-resolviéndola en
 * el instante de la ejecución, y es fail-closed con allowlist vacía. Este
 * módulo sólo emite la capability y dibuja.
 *
 * NUNCA lanza: el aviso de una retención tiene que salir aunque los botones no
 * se puedan emitir. Perder la alerta entera por no poder registrar una
 * capability sería cambiar un problema por uno estrictamente peor.
 *
 * @param {number} issue
 * @param {object} [deps]
 * @param {function} [deps.gateFactory]  devuelve la instancia de `operator-gate`.
 * @param {function} [deps.log]          `(mensaje) => void` para diagnóstico.
 * @returns {{ok: boolean, keyboard: object|null, code: string|null}}
 *   `ok:true` → `keyboard` es un `reply_markup` con los tres botones.
 *   `ok:false` → `keyboard` es `null` y `code` es el código acotado del fallo.
 */
function buildGate1SignatureKeyboard(issue, deps = {}) {
    const gateFactory = typeof deps.gateFactory === 'function'
        ? deps.gateFactory
        : () => require('./operator-gate').getDefault();
    const log = typeof deps.log === 'function' ? deps.log : () => {};

    try {
        const gate = gateFactory();
        if (!gate || typeof gate.register !== 'function' || typeof gate.buildInlineKeyboard !== 'function') {
            throw Object.assign(new Error('gate sin register/buildInlineKeyboard'), { code: 'GATE_UNAVAILABLE' });
        }

        const [approve, reject, adjust] = ACCIONES_GATE1
            .map((action) => gate.register({ issue, action }));

        const keyboard = gate.buildInlineKeyboard({
            approveId: approve.callbackData,
            rejectId: reject.callbackData,
            adjustId: adjust.callbackData,
        });

        // Un teclado vacío o mal formado es un fallo, no un éxito: si se
        // devolviera `ok:true` con esto, el aviso volvería a prometer botones
        // que no están. Se valida la forma, no sólo la ausencia de excepción.
        const fila = keyboard && Array.isArray(keyboard.inline_keyboard)
            ? keyboard.inline_keyboard[0]
            : null;
        if (!Array.isArray(fila) || fila.length !== ACCIONES_GATE1.length) {
            throw Object.assign(new Error('teclado sin los tres botones'), { code: 'KEYBOARD_MALFORMED' });
        }

        return { ok: true, keyboard, code: null };
    } catch (e) {
        // Se loguea el `code` acotado (VAULT_DISABLED, VAULT_FAILURE…), NO el
        // `message` crudo: el mensaje de un error arbitrario puede arrastrar
        // material sensible al log. Mismo criterio que #5461.
        const code = (e && typeof e.code === 'string' && e.code) ? e.code : 'unknown';
        log(`#${issue} GATE 1: no pude emitir la capability de firma (${code}) — el aviso sale sin botones`);
        return { ok: false, keyboard: null, code };
    }
}

/**
 * ¿Puede el pipeline emitir HOY una capability de firma? Responde SIN efectos:
 * construye el gate —que es donde falla la resolución del material de firma— y
 * no registra nada.
 *
 * Existe porque el aviso necesita saber si va a haber botones ANTES de redactar
 * el texto (el tipo de ficha depende de eso), pero el registro real sólo debe
 * ocurrir cuando el aviso efectivamente se emite: el dedupe silencia la enorme
 * mayoría de los barridos, y registrar en cada uno dejaría tres bindings
 * huérfanos en disco por barrido silenciado.
 *
 * No garantiza que el registro posterior funcione (puede fallar por disco); el
 * caller igual tiene que contemplar el fallo tardío. Lo que sí hace es detectar
 * la causa dominante y estable: sin material de firma no hay capability, y eso
 * no cambia entre el sondeo y el registro.
 *
 * @param {object} [deps]  `{ gateFactory, log }` — igual que el builder.
 * @returns {{ok: boolean, code: string|null}}
 */
function probeGate1SignatureCapability(deps = {}) {
    const gateFactory = typeof deps.gateFactory === 'function'
        ? deps.gateFactory
        : () => require('./operator-gate').getDefault();
    try {
        const gate = gateFactory();
        if (!gate || typeof gate.register !== 'function') {
            return { ok: false, code: 'GATE_UNAVAILABLE' };
        }
        return { ok: true, code: null };
    } catch (e) {
        const code = (e && typeof e.code === 'string' && e.code) ? e.code : 'unknown';
        return { ok: false, code };
    }
}

module.exports = {
    buildGate1SignatureKeyboard,
    probeGate1SignatureCapability,
    ACCIONES_GATE1,
};

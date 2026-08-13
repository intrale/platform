'use strict';

// =============================================================================
// pause-notice.js — Copy para el operador sobre el estado de la pausa total
// (#5399 · UX-1/UX-2/UX-3).
//
// EL PROBLEMA QUE RESUELVE
// ------------------------
// El 2026-08-02 el pipeline quedó 1h33 sin despachar tras un `/restart`, y el
// único mensaje que el operador recibió fue:
//
//     🚀 *Pipeline reiniciado y listo* (modo pausado)
//     _Todo en marcha para nuevas pruebas._
//
// El `(modo pausado)` estaba, pero el copy que lo rodeaba lo cancelaba: una
// confirmación de éxito con emoji de cohete sobre un pipeline que no iba a
// despachar nada. Nadie miró porque **el sistema avisó que estaba todo bien**.
//
// #5399 hace que la autoría de la pausa sobreviva al restart; este módulo hace
// que ese dato llegue al canal que el operador realmente lee (Telegram). El log
// de `restart.js` NO alcanza: `/restart` desde Telegram spawnea el proceso
// detached con stdout redirigido a `logs/restart-spawn.log`.
//
// DISEÑO — espejo de `lib/dispatch-cause.js`:
//   1. Funciones PURAS, sin I/O y sin dependencias: el caller lee el marker y
//      pasa los datos ya resueltos. Testeable sin tmpdir ni mocks.
//   2. Mapa cerrado de labels humanos: NUNCA se expone el enum crudo
//      (`config-corruption-halt` no significa nada para el operador), igual que
//      `dispatch-cause.js:87`. Un `source` desconocido cae al fallback genérico
//      en vez de volcarse tal cual — el marker es un archivo que cualquier
//      proceso del host puede escribir, no una fuente confiable de copy.
//   3. El copy da TRES datos y nada más, en este orden (guía de `ux`):
//      qué pasa → por qué → qué tiene que hacer el operador.
//
// GUARDRAILS DE COPY (bloqueantes, verificados por test)
//   - UX-1: con el pipeline pausado, nada de emoji de éxito (🚀/✅). El cohete
//     queda reservado para el restart COMPLETO que sí despacha.
//   - UX-2: ningún texto instruye borrar `.pipeline/.paused`. Este issue
//     convierte el marker en el portador de la autoría: mandar a borrarlo a mano
//     es instruir a destruir el dato que la historia crea. El destrabe se nombra
//     por su comando (`/reanudar`).
//   - UX-3: el camino degradado (lock no adquirido ⇒ no quedó anotado
//     `preservedFrom`) NO se comunica como falla. La pausa se preservó bien; un
//     texto tipo error empuja al `rm` manual que UX-2 prohíbe.
// =============================================================================

// Labels humanos de la autoría de la pausa. Clave = `source` del marker.
// NUNCA exponer el enum crudo al operador (mismo criterio que
// `dispatch-cause.js:LABELS`).
const PAUSE_SOURCE_LABELS = Object.freeze({
    // Automáticas.
    'config-corruption-halt': 'el config.yaml no parseaba',
    'kernel-cutover-degraded-halt': 'el cutover del kernel quedó degradado',
    // #5243 — entra junto con `AUTO_LIFTABLE_SOURCES` de `partial-pause.js`. Sin
    // esta línea, tras un halt por secretos el restart le dice al operador
    // "no se pudo identificar el origen" sobre una pausa que el pipeline
    // mismo puso y sabe explicar.
    'secrets-health-halt': 'faltaba un secreto que el pipeline necesita',
    // Humanas explícitas.
    'telegram': 'la pusiste vos con /pausar',
    'restart': 'la pediste vos al reiniciar',
    'wizard': 'la pusiste vos desde el wizard',
    'dashboard': 'la pusiste vos desde el dashboard',
    'commander': 'la puso el commander a pedido tuyo',
    // Fail-closed del lector.
    'manual': 'la puso una persona',
    'unknown': 'no quedó registrado quién la puso',
});

// Un `source` fuera del mapa jamás se vuelca crudo: el operador no lee enums, y
// el marker no es una fuente confiable de texto.
const PAUSE_SOURCE_LABEL_FALLBACK = 'no se pudo identificar el origen';

// Qué tiene que hacer el operador. Es la parte accionable del copy.
const RESOLUCION_AUTO_CONFIG = 'Se levanta sola cuando el config vuelva a parsear. No hace falta que hagas nada.';
const RESOLUCION_AUTO_GENERICA = 'Se levanta sola cuando la causa se resuelva. No hace falta que hagas nada.';
const RESOLUCION_MANUAL = 'Sigue frenado hasta que mandes /reanudar.';

/**
 * Traduce el `source` del marker a lenguaje de operador.
 *
 * @param {unknown} source `source` literal del marker (o null).
 * @returns {string} label humano, nunca el enum crudo.
 */
function labelForSource(source) {
    if (typeof source !== 'string') return PAUSE_SOURCE_LABEL_FALLBACK;
    return Object.prototype.hasOwnProperty.call(PAUSE_SOURCE_LABELS, source)
        ? PAUSE_SOURCE_LABELS[source]
        : PAUSE_SOURCE_LABEL_FALLBACK;
}

/**
 * Qué tiene que hacer el operador con esta pausa.
 *
 * @param {{ source?: string|null, autoLiftable?: boolean }} [opts]
 * @returns {string}
 */
function resolucionParaPausa(opts = {}) {
    if (!opts.autoLiftable) return RESOLUCION_MANUAL;
    return opts.source === 'config-corruption-halt'
        ? RESOLUCION_AUTO_CONFIG
        : RESOLUCION_AUTO_GENERICA;
}

/**
 * Construye el mensaje de confirmación de restart que recibe el operador por
 * Telegram (UX-1). Función PURA.
 *
 * IMPORTANTE — `autoLiftable` lo decide el caller con
 * `partialPause.isAutoLiftableSource(origin.source)`, es decir sobre el veredicto
 * FAIL-CLOSED del lector, no sobre el `source` literal. Este módulo sólo redacta:
 * no participa de la decisión de auto-levantado (CA-8).
 *
 * @param {Object} [opts]
 * @param {'pausado'|'completo'} [opts.mode] Modo con el que se pidió el restart.
 * @param {boolean} [opts.pauseActive] ¿Hay marker `.paused` vivo AHORA?
 * @param {string|null} [opts.source] `source` literal del marker (para el label).
 * @param {boolean} [opts.autoLiftable] ¿Esa pausa se auto-levanta?
 * @param {boolean} [opts.preserved] ¿El marker trae `preservedFrom` del restart?
 * @returns {string} mensaje listo para `sendTelegram` (markdown de Telegram).
 */
function buildRestartNotice(opts = {}) {
    const mode = opts.mode === 'pausado' ? 'pausado' : 'completo';
    const pauseActive = !!opts.pauseActive;

    // Caso feliz: el pipeline despacha. Acá SÍ va el cohete.
    if (!pauseActive && mode === 'completo') {
        return '🚀 *Pipeline reiniciado y listo* (modo completo)\n'
            + '_Todo en marcha para nuevas pruebas._';
    }

    // Se pidió pausado pero ya no hay pausa: la heredada se auto-levantó dentro
    // del arranque (exactamente lo que #5399 viene a habilitar). Es buena
    // noticia y hay que decirlo, porque el operador esperaba un pipeline frenado.
    if (!pauseActive) {
        return '🚀 *Pipeline reiniciado* — la pausa que traía ya se levantó sola\n'
            + '_Volvió a despachar. No hace falta que hagas nada._';
    }

    // Pausado de verdad: nada de emoji de éxito (UX-1).
    const label = labelForSource(opts.source);
    const resolucion = resolucionParaPausa({ source: opts.source, autoLiftable: !!opts.autoLiftable });
    const origen = opts.preserved ? 'pausa heredada' : 'pausa activa';
    return `⏸️ *Pipeline reiniciado en modo PAUSADO* — ${origen} (${label})\n${resolucion}`;
}

module.exports = {
    buildRestartNotice,
    labelForSource,
    resolucionParaPausa,
    PAUSE_SOURCE_LABELS,
    PAUSE_SOURCE_LABEL_FALLBACK,
};

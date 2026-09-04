// =============================================================================
// credential-retry-settlement.js — #5796 (fix rev-3)
//
// QUÉ RESUELVE
// ------------
// Cuando una corrida de agente muere por credencial vencida y el gate de retry
// está abierto, hay DOS actores que pueden querer cerrar esa corrida:
//
//   1. `cerrarPorCredencialVencida(nota)` — el cierre de siempre: apaga el
//      provider, avisa al operador y devuelve el dropfile a `pendiente/`.
//   2. `reencolarPorReintento()` — el `retryExecute` del coordinador: devuelve
//      el dropfile a `pendiente/` para el único reintento, SIN apagar nada.
//
// Ambos ejecutan efectos observables sobre estado de PROCESO —mover el dropfile
// fuera de `trabajando/`, soltar el slot de `activeProcesses`, matar daemons y
// salir del canal de contexto— y el `Promise.race` que acota el replay
// introduce un tercer orden posible: el coordinador puede settlear DESPUÉS de
// que el timeout ya cerró la corrida (el race no cancela el trabajo en vuelo,
// no hay `AbortController` del otro lado del vault).
//
// Ese settlement tardío es el bug del rechazo rev-2: con el dropfile ya de
// vuelta en `pendiente/` y `poll_interval_seconds: 30`, el Pulpo relanza el
// issue en ≤30s sobre el MISMO `trabajando/<issue>.<skill>` y la MISMA clave
// `processKey(skill, issue)`. Si el `retryExecute` tardío ejecuta igual sus
// efectos, le arranca el dropfile al agente vivo (que al salir pierde su
// veredicto) y libera un slot que está ocupado, habilitando un SEGUNDO proceso
// `claude` sobre el mismo issue y el mismo worktree.
//
// LA GARANTÍA
// -----------
// Este módulo es la barrera dura: los dos cierres son MUTUAMENTE EXCLUYENTES y
// ejecutables UNA sola vez EN TOTAL, gane quien gane la carrera. El que llega
// segundo no toca nada y deja traza en el log. No alcanza con que el segundo
// "sepa" que hubo un primero: lo que se protege es estado de proceso, no un
// log, así que la barrera va en la ENTRADA de cada camino de efecto.
//
// El módulo es puro: no toca filesystem, ni `process.env`, ni el reloj. Todo
// entra por parámetro (efectos, log, timers), que es lo que lo hace ejercitable
// por comportamiento — contando efectos reales — y no por regex sobre el fuente.
// =============================================================================

'use strict';

/** Presupuesto por defecto del replay. Un vault sano resuelve en segundos. */
const REPLAY_TIMEOUT_MS_DEFAULT = 60 * 1000;

/**
 * Timeout efectivo del replay. Inyectable por env para que los tests de
 * comportamiento puedan ejercitar el settlement tardío sin esperar 60s reales.
 * Fail-safe: cualquier valor no numérico, cero o negativo cae al default.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {number} milisegundos
 */
function resolveReplayTimeoutMs(env) {
    const fuente = env || process.env || {};
    const crudo = Number(fuente.PIPELINE_CREDENTIAL_REPLAY_TIMEOUT_MS);
    if (Number.isFinite(crudo) && crudo > 0) return crudo;
    return REPLAY_TIMEOUT_MS_DEFAULT;
}

/**
 * Coordinador de cierre ÚNICO de una corrida cerrada por credencial vencida.
 *
 * @param {object} opts
 * @param {(nota: string|null) => void} opts.cerrar    Efectos del cierre por credencial vencida.
 * @param {() => void} opts.reencolar                  Efectos del re-encolado por reintento.
 * @param {(msg: string) => void} [opts.log]           Log de línea (best-effort, nunca rompe).
 * @param {string} [opts.etiqueta]                     `skill:#issue`, sólo para el log.
 */
function crearCoordinadorDeCierreDeCorrida({ cerrar, reencolar, log, etiqueta } = {}) {
    if (typeof cerrar !== 'function' || typeof reencolar !== 'function') {
        throw new TypeError('[credential-retry-settlement] se requieren `cerrar` y `reencolar` como funciones');
    }
    const anotar = typeof log === 'function' ? log : () => {};
    const quien = etiqueta || 'la corrida';

    // La bandera vive acá adentro y NO se expone para escritura: un caller no
    // puede marcarla sin haber ejecutado el cierre (que fue exactamente el modo
    // de falla del rev-2, donde `retryExecute` la escribía pero nunca la leía).
    let cerrada = false;
    let ganador = null;
    const tomarElTurno = (nombre) => {
        if (cerrada) return false;
        cerrada = true;
        ganador = nombre;
        return true;
    };

    return {
        /** `true` si algún camino ya ejecutó los efectos de cierre. */
        get cerrada() { return cerrada; },
        /** Quién los ejecutó: `'cierre'`, `'reintento'` o `null`. */
        get ganador() { return ganador; },

        /**
         * Cierre por credencial vencida. Idempotente: sólo el primer llamado
         * ejecuta efectos.
         * @returns {boolean} `true` si ESTE llamado ejecutó los efectos.
         */
        cerrarPorCredencialVencida(nota) {
            if (!tomarElTurno('cierre')) return false;
            cerrar(nota == null ? null : nota);
            return true;
        },

        /**
         * Re-encolado por el `retryExecute` del coordinador. Barrera dura de
         * entrada: si la corrida ya se cerró (típicamente por el timeout del
         * replay), este camino NO toca el dropfile ni el slot — el issue ya
         * volvió a la cola y probablemente ya tenga un agente vivo encima.
         * @returns {boolean} `true` si ESTE llamado ejecutó los efectos.
         */
        reencolarPorReintento() {
            if (!tomarElTurno('reintento')) {
                anotar(`credential-retry: el replay de ${quien} settleó después del cierre — no se re-encola `
                    + '(el dropfile ya volvió a pendiente/ y el slot puede tener otro agente vivo)');
                return false;
            }
            reencolar();
            return true;
        },
    };
}

/**
 * Corre el replay del coordinador con settlement GARANTIZADO.
 *
 * Contrato:
 *   * el replay queda acotado por un temporizador (`unref`: no sostiene vivo el
 *     event loop del Pulpo ni un milisegundo de más);
 *   * TODO desenlace —timeout, fallo tipado, OK sin reintento, excepción
 *     inesperada— termina con la corrida cerrada, así que el dropfile nunca
 *     queda huérfano en `trabajando/` ni el slot ocupado;
 *   * el cierre pasa SIEMPRE por el coordinador, así que un settlement tardío
 *     del replay no puede duplicar efectos.
 *
 * @param {object} opts
 * @param {Promise<any>} opts.replay
 * @param {ReturnType<crearCoordinadorDeCierreDeCorrida>} opts.coordinador
 * @param {number} [opts.timeoutMs]
 * @param {(msg: string) => void} [opts.log]
 * @param {{setTimeout: Function, clearTimeout: Function}} [opts.timers]
 * @returns {Promise<void>} resuelve cuando la corrida quedó cerrada.
 */
function correrReplayAcotado({ replay, coordinador, timeoutMs, log, timers } = {}) {
    if (!coordinador || typeof coordinador.cerrarPorCredencialVencida !== 'function') {
        throw new TypeError('[credential-retry-settlement] `coordinador` inválido');
    }
    const anotar = typeof log === 'function' ? log : () => {};
    const reloj = timers || { setTimeout, clearTimeout };
    const presupuesto = Number.isFinite(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : resolveReplayTimeoutMs();

    let temporizadorDelReplay = null;
    const vencimiento = new Promise((resolverVencimiento) => {
        temporizadorDelReplay = reloj.setTimeout(() => resolverVencimiento({ timeout: true }), presupuesto);
        if (temporizadorDelReplay && typeof temporizadorDelReplay.unref === 'function') {
            temporizadorDelReplay.unref();
        }
    });

    const enVuelo = Promise.resolve(replay).then(() => ({ ok: true }), (e) => ({ error: e }));

    return Promise.race([enVuelo, vencimiento]).then((desenlace) => {
        if (desenlace && desenlace.timeout) {
            // El coordinador nunca settleó. No sabemos si invalidó o no, así que
            // el issue vuelve a la cola por el camino conservador.
            coordinador.cerrarPorCredencialVencida(
                `el reintento no resolvió en ${Math.round(presupuesto / 1000)}s (vault sin respuesta) — cierre por timeout`,
            );
            return;
        }
        if (desenlace && desenlace.error) {
            // Fallo CERRADO del coordinador (presupuesto agotado, invalidación o
            // re-resolución fallida, segundo rechazo): el cierre de siempre, con
            // el motivo TIPADO del catálogo `CLOSE_REASONS` —nunca texto libre—
            // para que el operador rutee sin leer el stack.
            const e = desenlace.error;
            const motivo = (e && e.reason) || (e && e.code) || 'error_no_tipado';
            coordinador.cerrarPorCredencialVencida(`no se reintentó (${motivo})`);
            return;
        }
        // Camino feliz: no-op si el reintento ya cerró la corrida. Cubre el caso
        // en que el coordinador resuelve OK sin haber reintentado (su `classify`
        // no reconoció la señal): sin esto, ese camino dejaba el dropfile
        // huérfano en `trabajando/`.
        coordinador.cerrarPorCredencialVencida('el coordinador resolvió sin reintentar');
    }).catch((e) => {
        // Red de última instancia: ni el `race` ni el cierre pueden dejar el
        // dropfile en `trabajando/`.
        anotar(`⚠️ credential-retry: el cierre del replay falló (${e && e.message})`);
        try { coordinador.cerrarPorCredencialVencida('error inesperado cerrando el reintento'); } catch { /* best-effort */ }
    }).finally(() => {
        try { reloj.clearTimeout(temporizadorDelReplay); } catch { /* best-effort */ }
    });
}

module.exports = {
    REPLAY_TIMEOUT_MS_DEFAULT,
    resolveReplayTimeoutMs,
    crearCoordinadorDeCierreDeCorrida,
    correrReplayAcotado,
};

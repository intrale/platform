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
// Y hay un TERCER actor, que fue el bug del rechazo rev-3: el barrido de
// huérfanos (`brazoHuerfanos`), que corre en otro tick, mira el mismo dropfile
// en `trabajando/` y la misma clave de `activeProcesses`, y cuyos guards —edad
// del archivo y proceso vivo— dan luz verde exactamente durante el replay: el
// proceso YA murió (por eso corre este brazo) y la edad del dropfile se preserva
// entre movimientos (`fs.renameSync` no toca el mtime), así que con
// `orphan_timeout_minutes: 10` cualquier issue que esperó en cola entra al
// barrido desde el instante en que arranca su agente. Ver
// `crearRegistroDeCorridasEnSettlement` más abajo.
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
function crearCoordinadorDeCierreDeCorrida({ cerrar, reencolar, log, etiqueta, alCerrar } = {}) {
    if (typeof cerrar !== 'function' || typeof reencolar !== 'function') {
        throw new TypeError('[credential-retry-settlement] se requieren `cerrar` y `reencolar` como funciones');
    }
    const anotar = typeof log === 'function' ? log : () => {};
    const quien = etiqueta || 'la corrida';
    const avisarCierre = typeof alCerrar === 'function' ? alCerrar : () => {};

    // La bandera vive acá adentro y NO se expone para escritura: un caller no
    // puede marcarla sin haber ejecutado el cierre (que fue exactamente el modo
    // de falla del rev-2, donde `retryExecute` la escribía pero nunca la leía).
    let cerrada = false;
    let ganador = null;
    const tomarElTurno = (nombre) => {
        if (cerrada) return false;
        cerrada = true;
        ganador = nombre;
        // La corrida dejó de tener un cierre pendiente: el registro de
        // settlements en vuelo se libera acá, en el MISMO tick en que se toma el
        // turno, y no cuando settlea una promesa. Best-effort: la contabilidad
        // del registro nunca puede romper el cierre real de la corrida.
        try { avisarCierre(nombre); } catch { /* noop */ }
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

        /**
         * #5796 (fix rev-4) — TURNO PARA UN TERCER ACTOR.
         *
         * El barrido de huérfanos (`brazoHuerfanos` del Pulpo) es un tercer
         * actor que ejecuta los MISMOS efectos de proceso que los dos cierres
         * de acá —devolver el dropfile a `pendiente/`, soltar el slot de
         * `activeProcesses`— pero desde otro tick del event loop y sin acceso
         * al closure de este coordinador. Si actúa mientras el replay está en
         * vuelo, duplica efectos exactamente como lo hacía el settlement tardío
         * del rev-2.
         *
         * La defensa primaria es que el barrido NO toque una corrida con cierre
         * en vuelo (ver `crearRegistroDeCorridasEnSettlement`). Este método es
         * la salida de emergencia de esa defensa: si el cierre se pasó de su
         * presupuesto —un coordinador colgado más allá de todo timeout— el
         * barrido recupera el slot, y para hacerlo TOMA el turno acá. Así, si
         * el replay settlea después, encuentra la corrida cerrada y no ejecuta
         * ningún efecto.
         *
         * NO ejecuta los efectos de este coordinador: quien toma el turno se
         * hace cargo de cerrar la corrida por su cuenta.
         *
         * @param {string} [nombre] Quién lo toma, sólo para trazabilidad.
         * @returns {boolean} `true` si ESTE llamado se quedó con el turno.
         */
        tomarElTurnoDeCierreExterno(nombre) {
            const quienLoToma = nombre || 'actor-externo';
            if (!tomarElTurno(quienLoToma)) return false;
            anotar(`credential-retry: ${quienLoToma} tomó el cierre de ${quien} — el replay ya no puede ejecutar efectos`);
            return true;
        },
    };
}

/**
 * Margen de gracia sobre el presupuesto del replay antes de considerar que un
 * cierre en vuelo se colgó. `correrReplayAcotado` garantiza el cierre dentro del
 * presupuesto; este margen sólo cubre demoras del event loop (el Pulpo hace
 * trabajo sincrónico pesado en cada tick) para no declarar vencido un cierre que
 * está por ejecutarse.
 */
const MARGEN_DE_GRACIA_MS = 30 * 1000;

/**
 * #5796 (fix rev-4) — REGISTRO DE CORRIDAS CON CIERRE EN VUELO.
 *
 * Publica, por clave de proceso (`processKey(skill, issue)`), qué corridas
 * tienen su cierre en manos de un coordinador que todavía no settleó. Existe
 * porque la bandera `cerrada` vive en un closure privado del coordinador y el
 * barrido de huérfanos —que corre en otro tick, sobre el mismo dropfile y la
 * misma clave de `activeProcesses`— no tiene forma de verla.
 *
 * Contrato:
 *   * `marcar()` se llama SINCRÓNICAMENTE en el mismo tick en que arranca el
 *     replay, antes de devolver el control al event loop: no hay ventana en la
 *     que el barrido pueda ver la corrida sin marcar;
 *   * la entrada se libera sola cuando el coordinador toma su turno (vía el
 *     `alCerrar` que se le inyecta al crearlo), así que nada queda colgado si
 *     un camino de cierre olvida limpiar;
 *   * `hayCierreEnVuelo()` es fail-SAFE, no fail-closed: ante una entrada
 *     vencida el barrido recupera el slot (tomando el turno del coordinador),
 *     porque el modo de falla de bloquear para siempre es peor —un slot de los
 *     3 del pipeline perdido hasta el próximo restart.
 *
 * Módulo puro: el reloj entra por parámetro.
 *
 * @param {object} [opts]
 * @param {() => number} [opts.now]
 * @param {number} [opts.margenMs] Margen de gracia sobre el presupuesto.
 */
function crearRegistroDeCorridasEnSettlement({ now, margenMs } = {}) {
    const reloj = typeof now === 'function' ? now : () => Date.now();
    const margen = Number.isFinite(margenMs) && margenMs >= 0 ? margenMs : MARGEN_DE_GRACIA_MS;
    /** @type {Map<string, {coordinador: any, inicioMs: number, presupuestoMs: number, etiqueta: string}>} */
    const corridas = new Map();

    return {
        /** Cantidad de corridas con cierre en vuelo (para tests y diagnóstico). */
        get tamanio() { return corridas.size; },

        /**
         * @param {object} opts
         * @param {string} opts.clave           `processKey(skill, issue)`.
         * @param {object} opts.coordinador     Coordinador dueño del cierre.
         * @param {number} [opts.presupuestoMs] Timeout del replay.
         * @param {string} [opts.etiqueta]      `skill:#issue`, sólo para el log.
         */
        marcar({ clave, coordinador, presupuestoMs, etiqueta } = {}) {
            if (!clave || !coordinador) return false;
            corridas.set(clave, {
                coordinador,
                inicioMs: reloj(),
                presupuestoMs: Number.isFinite(presupuestoMs) && presupuestoMs > 0
                    ? presupuestoMs
                    : REPLAY_TIMEOUT_MS_DEFAULT,
                etiqueta: etiqueta || clave,
            });
            return true;
        },

        /** Olvida la corrida. Idempotente. */
        olvidar(clave) {
            return corridas.delete(clave);
        },

        /**
         * ¿Hay un cierre en vuelo para esta clave?
         *
         * `true` obliga al tercer actor a NO tocar la corrida en este tick.
         * `false` puede significar tres cosas, y en todas el tercer actor queda
         * habilitado a ejecutar sus efectos sin duplicar los del coordinador:
         * no había cierre en vuelo, el coordinador ya cerró, o el cierre venció
         * su presupuesto y este llamado le arrancó el turno.
         *
         * @param {string} clave
         * @returns {boolean}
         */
        hayCierreEnVuelo(clave) {
            const corrida = corridas.get(clave);
            if (!corrida) return false;

            // El coordinador ya cerró: la entrada es un residuo (el `alCerrar`
            // debería haberla borrado, pero no dependemos de eso).
            if (corrida.coordinador && corrida.coordinador.cerrada) {
                corridas.delete(clave);
                return false;
            }

            const edadMs = reloj() - corrida.inicioMs;
            if (edadMs <= corrida.presupuestoMs + margen) return true;

            // Vencido: `correrReplayAcotado` tenía que haber cerrado hace rato.
            // El tercer actor se queda con el turno para que un settlement
            // posterior no pueda ejecutar efectos sobre la corrida relanzada.
            try {
                if (corrida.coordinador && typeof corrida.coordinador.tomarElTurnoDeCierreExterno === 'function') {
                    corrida.coordinador.tomarElTurnoDeCierreExterno('barrido-huerfanos');
                }
            } catch { /* best-effort: el barrido recupera el slot igual */ }
            corridas.delete(clave);
            return false;
        },
    };
}

/**
 * Instancia compartida por el proceso: el brazo de credential-death la marca y
 * el barrido de huérfanos la consulta. Son dos puntos muy lejanos del mismo
 * `pulpo.js`, y el `require` cacheado garantiza que ven el MISMO registro.
 */
const corridasEnSettlement = crearRegistroDeCorridasEnSettlement();

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
    MARGEN_DE_GRACIA_MS,
    resolveReplayTimeoutMs,
    crearCoordinadorDeCierreDeCorrida,
    correrReplayAcotado,
    crearRegistroDeCorridasEnSettlement,
    corridasEnSettlement,
};

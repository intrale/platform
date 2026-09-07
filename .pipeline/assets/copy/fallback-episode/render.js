// =============================================================================
// render.js — Renderer de REFERENCIA del aviso por episodio (#6179, UX)
//
// Implementación de referencia de `formatEpisodeNotice(episode, { now })`.
// El dev la porta a `.pipeline/lib/commander/multi-provider.js` (~:2054) y la
// exporta desde ahí. Este archivo es el contrato de UX: si el texto que emite
// producción difiere del que emite este renderer, el que está mal es producción.
//
// Propiedades que NO se negocian:
//   - PURA: sin I/O, sin Date.now() adentro. El reloj entra por `opts.now`.
//   - Vocabulario cerrado: todo string visible sale de copy.json. Nada se
//     interpola desde el episodio salvo hora y antigüedad, que son números
//     formateados por este mismo módulo (CA-9).
//   - Fail-closed de enums: un `tier`/`cause`/`evento` desconocido NO se
//     interpola, cae al valor genérico (CA-5 / CA-9 / D9).
// =============================================================================

'use strict';

const COPY = require('./copy.json');

const TIERS = ['respaldo_pago', 'gratuito_con_herramientas', 'gratuito_sin_herramientas'];
const CAUSAS = ['reposo', 'cuota', 'transitoria', 'auth', 'desconocida'];
const EVENTOS = ['entra_respaldo', 'baja_escalon', 'vuelve_principal', 'sostenido'];

// Lookup fail-closed: nunca hereda de Object.prototype (D8 / #5667).
function pick(obj, key, fallback) {
    const k = String(key == null ? '' : key);
    return Object.prototype.hasOwnProperty.call(obj, k) ? obj[k] : fallback;
}

function normTier(tier) {
    // Un tier fuera del enum se trata como el escalón MÁS degradado: describir
    // de menos la degradación es peor que describirla de más.
    return TIERS.includes(tier) ? tier : 'gratuito_sin_herramientas';
}

function normCause(cause) {
    // `null` es el caso "no se pudo determinar" de CA-12, no un error a tapar.
    return CAUSAS.includes(cause) ? cause : 'desconocida';
}

function dosDigitos(n) {
    return String(n).padStart(2, '0');
}

// Hora local HH:MM del inicio del episodio.
function horaDe(sinceMs) {
    const d = new Date(sinceMs);
    return `${dosDigitos(d.getHours())}:${dosDigitos(d.getMinutes())}`;
}

function lapso(ms, claves) {
    const min = Math.floor(ms / 60000);
    if (min < 1) return COPY.antiguedad[claves.cero];
    if (min < 60) return COPY.antiguedad[claves.min].replace('{N}', String(min));

    const horas = Math.floor(min / 60);
    if (horas >= 24) {
        return COPY.antiguedad[claves.dia]
            .replace('{D}', String(Math.floor(horas / 24)))
            .replace('{H}', String(horas % 24));
    }
    // Lapso redondo: "6 h", nunca "6 h 0 min" (suena a reloj de máquina).
    if (min % 60 === 0) return COPY.antiguedad[claves.horaExacta].replace('{H}', String(horas));
    return COPY.antiguedad[claves.hora]
        .replace('{H}', String(horas))
        .replace('{M}', String(min % 60));
}

const antiguedadDe = (ms) => lapso(ms, {
    cero: 'menos_de_un_minuto', min: 'minutos',
    hora: 'horas', horaExacta: 'horas_exactas', dia: 'dias',
});
const duracionDe = (ms) => lapso(ms, {
    cero: 'duracion_menos_de_un_minuto', min: 'duracion_minutos',
    hora: 'duracion_horas', horaExacta: 'duracion_horas_exactas', dia: 'duracion_dias',
});

/**
 * @param {object} episode  { evento, tier, cause, since, heartbeatMs? }
 *        evento: 'entra_respaldo' | 'baja_escalon' | 'vuelve_principal' | 'sostenido'
 *        tier:   enum de TIERS (ignorado en 'vuelve_principal')
 *        cause:  enum de CAUSAS o null (=> 'desconocida')
 *        since:  epoch ms del inicio del episodio vigente
 * @param {object} opts     { now: epoch ms }
 * @returns {string} texto plano listo para Telegram (plain:true)
 */
function formatEpisodeNotice(episode, opts) {
    const ep = episode || {};
    const now = (opts && Number.isFinite(opts.now)) ? opts.now : 0;
    const since = Number.isFinite(ep.since) ? ep.since : now;
    const transcurrido = Math.max(0, now - since);

    const evento = EVENTOS.includes(ep.evento) ? ep.evento : 'entra_respaldo';
    const tier = normTier(ep.tier);
    const cause = normCause(ep.cause);

    // --- Vuelta a la normalidad: no lleva motivo ni consecuencia negativa. ---
    if (evento === 'vuelve_principal') {
        return COPY.plantillas.normalidad
            .replace('{MARCADOR}', COPY.marcadores.normalidad)
            .replace('{TITULAR}', COPY.titulares.vuelve_principal)
            .replace('{DURACION}', duracionDe(transcurrido))
            .replace('{CIERRE}', COPY.cierres.normalidad);
    }

    // --- Marcador: destacado si hay que mirarlo (CA-12) o si no hay tools. ---
    const destacado = cause === 'auth'
        || cause === 'desconocida'
        || tier === 'gratuito_sin_herramientas';
    const marcador = evento === 'sostenido'
        ? COPY.marcadores.sostenido
        : (destacado ? COPY.marcadores.destacado : COPY.marcadores.degradacion);

    // --- Cierre: sólo pide acción cuando existe una (CA-7). ---
    let cierre;
    if (evento === 'sostenido') {
        const ventana = duracionDe(
            Number.isFinite(ep.heartbeatMs) ? ep.heartbeatMs : 6 * 3600 * 1000,
        );
        cierre = COPY.cierres.sostenido.replace('{VENTANA}', ventana);
    } else if (cause === 'auth') {
        cierre = COPY.cierres.auth;
    } else if (cause === 'desconocida') {
        cierre = COPY.cierres.desconocida;
    } else {
        cierre = COPY.cierres.sin_accion;
    }

    const titular = pick(
        COPY.titulares[evento], tier, COPY.titulares.entra_respaldo.gratuito_sin_herramientas,
    );

    return COPY.plantillas.degradacion
        .replace('{MARCADOR}', marcador)
        .replace('{TITULAR}', titular)
        .replace('{MOTIVO}', pick(COPY.motivos, cause, COPY.motivos.desconocida))
        .replace('{HORA}', horaDe(since))
        .replace('{ANTIGUEDAD}', antiguedadDe(transcurrido))
        .replace('{CONSECUENCIA}', pick(COPY.consecuencias, tier, COPY.consecuencias.gratuito_sin_herramientas))
        .replace('{CIERRE}', cierre);
}

module.exports = { formatEpisodeNotice, TIERS, CAUSAS, EVENTOS, COPY };

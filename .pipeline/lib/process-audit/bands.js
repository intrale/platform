// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// =============================================================================
// process-audit / bands — bandas congeladas para la dedup de propuestas (#6809)
// =============================================================================
//
// El registro de propuestas (#6807) deduplica por `productor + tipo + accion +
// evidencia.tipo + evidencia.referencia`, NO por el valor medido. Para que una
// propuesta rechazada no vuelva a salir mientras "la métrica no cambie" (CA de
// #6809) y para que el ruido de medición no la reabra, la referencia lleva la
// métrica CUANTIZADA en una banda ancha:
//
//     evidencia.referencia = "<eje>:<metrica>:banda-<lo>-<hi>"
//
// Con la misma banda `publicar()` devuelve `duplicada` / `rechazada_previamente`;
// si la banda cambia, el id es nuevo y la propuesta vuelve a evaluarse.
//
// Las bandas viven SÓLO acá, congeladas (D6 / SEC-6809-10): nunca salen de la
// telemetría ni de la config, así un valor fabricado no puede reabrir una
// propuesta rechazada en loop ni agotar la cuota diaria del productor.
//
// Una métrica sin banda declarada ⇒ `null` ⇒ el hallazgo no se publica
// (fail-closed: sin banda no hay dedup confiable).

/** Tramos de 10 puntos porcentuales (ruido de ±2 pp cae en la misma banda salvo en el borde). */
const PCT = Object.freeze([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
/** Horas: escala casi logarítmica (una hora más o menos no reabre nada). */
const HORAS = Object.freeze([0, 1, 3, 6, 12, 24, 48, 96, 168, 336, 720]);
/** Conteos de eventos / corridas. */
const CONTEO = Object.freeze([0, 5, 10, 20, 50, 100, 200, 500, 1000]);
/** Días de antigüedad. */
const DIAS = Object.freeze([0, 14, 30, 60, 90, 180, 365]);
/** Puntos de RAM por agente (costo marginal). */
const PUNTOS = Object.freeze([0, 1, 2, 3, 5, 8, 13, 21]);
/** Semanas completas de evidencia. */
const SEMANAS = Object.freeze([0, 1, 2, 3, 4, 6, 8]);

/** Tabla congelada métrica → cortes. Nombres en snake_case, cerrados. */
const BANDAS = Object.freeze({
    // eje proceso
    corridas_mismo_resultado: CONTEO,
    ocurrencias_fallo: CONTEO,
    pct_costo_fase: PCT,
    dias_control_apagado: DIAS,
    // eje capacidad
    pct_tiempo_cero_agentes: PCT,
    pct_horas_en_cap: PCT,
    mem_p95_en_cap: PCT,
    mem_max_en_cap: PCT,
    costo_marginal_ram: PUNTOS,
    // eje proveedores
    horas_flag_sin_agotamiento: HORAS,
    horas_unica_pata_gateada: HORAS,
    horas_gateado_con_otra_pata: HORAS,
    horas_cadena_agotada: HORAS,
    semanas_agotadas: SEMANAS,
    pct_consumo_semanal_max: PCT,
});

/**
 * Banda de un valor para una métrica conocida.
 *
 * @param {string} metrica
 * @param {number} valor
 * @returns {string|null} `banda-<lo>-<hi>` (o `banda-<lo>-mas` por encima del
 *   último corte); `null` si la métrica no tiene banda o el valor no es finito.
 */
function bandOf(metrica, valor) {
    if (typeof metrica !== 'string' || !Object.prototype.hasOwnProperty.call(BANDAS, metrica)) return null;
    if (typeof valor !== 'number' || !Number.isFinite(valor) || valor < 0) return null;
    const cortes = BANDAS[metrica];
    for (let i = 0; i < cortes.length - 1; i++) {
        if (valor >= cortes[i] && valor < cortes[i + 1]) return `banda-${cortes[i]}-${cortes[i + 1]}`;
    }
    return `banda-${cortes[cortes.length - 1]}-mas`;
}

/** `<eje>:<metrica>:<banda>` o `null` si no hay banda. */
function referenciaDe(eje, metrica, valor) {
    const banda = bandOf(metrica, valor);
    if (!banda) return null;
    return `${eje}:${metrica}:${banda}`;
}

module.exports = { BANDAS, bandOf, referenciaDe };

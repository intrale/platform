// =============================================================================
// orphan-guard — decide si una corrida en `trabajando/` es realmente huérfana.
//
// EL AGUJERO QUE CIERRA (incidente 2026-09-08)
// --------------------------------------------
// `brazoHuerfanos` declaraba huérfana una corrida con dos señales:
//   1. `fileAgeMinutes(dropfile) >= orphan_timeout_minutes`
//   2. no hay proceso vivo para (skill, issue) en `activeProcesses`
//
// Las dos fallan juntas después de un reinicio del Pulpo:
//
//   * `moveFile` es `fs.renameSync`, que PRESERVA el mtime. Un dropfile que
//     esperó horas en `pendiente/` entra a `trabajando/` ya vencido: nace con
//     `age` mayor al timeout aunque su corrida tenga segundos de vida.
//   * `activeProcesses` es un Map en memoria SIN rehidratación. Tras un boot
//     está vacío, así que ninguna corrida en vuelo es "conocida" y todas dan
//     "sin proceso" — incluso las que están corriendo perfectamente.
//
// Resultado medido el 2026-09-08: el Pulpo reinició 10:09:23 y a las 10:09:43
// —veinte segundos después— empezó a rebotar fases sanas. Los tres reintentos
// de #5801 y #6239 se consumieron entre las 10:09 y las 11:09, con la edad
// creciendo 592 → 617 → 638 min (el mtime nunca se refrescaba), hasta
// `excedió 3 reintentos → rechazado`. Trabajo sano, rechazado por infra.
//
// LA REGLA
// --------
// Nunca declarar huérfano lo que no se puede conocer. Si el registro de
// corridas está frío (recién booteado) no hay forma de distinguir "el proceso
// murió" de "yo no lo lancé": en esa ventana el barrido se abstiene y deja que
// la rehidratación o el propio agente resuelvan. Es fail-safe hacia no tocar:
// una corrida muerta se recupera en el barrido siguiente, mientras que una
// corrida sana rebotada quema un reintento que no vuelve.
// =============================================================================
'use strict';

const fs = require('fs');

// Ventana de gracia tras el boot del Pulpo. Cubre el arranque de los agentes
// que quedaron en vuelo del proceso anterior y el tiempo que tarda la
// rehidratación en confirmar PIDs. Por debajo de esto el barrido no declara
// huérfano a una corrida que no tiene registrada.
const GRACIA_POST_BOOT_MINUTOS = 15;

const MOTIVOS = Object.freeze({
    JOVEN: 'joven',
    PROCESO_VIVO: 'proceso-vivo',
    GRACIA_POST_BOOT: 'gracia-post-boot',
    HUERFANO: 'huerfano',
});

/**
 * Decide si una corrida debe tratarse como huérfana.
 *
 * @param {object} ctx
 * @param {number} ctx.ageMinutes           edad de la corrida EN `trabajando/`
 * @param {number} ctx.timeoutMinutes       umbral configurado
 * @param {boolean} ctx.registroConocido    ¿hay entrada en el registro de corridas?
 * @param {boolean} ctx.procesoVivo         ¿ese PID sigue vivo?
 * @param {number} ctx.minutosDesdeBoot     vida del proceso Pulpo actual
 * @param {number} [ctx.graciaBootMinutos]  override de la ventana de gracia
 * @returns {{ huerfano: boolean, motivo: string }}
 */
function decidirHuerfano(ctx = {}) {
    const {
        ageMinutes,
        timeoutMinutes,
        registroConocido,
        procesoVivo,
        minutosDesdeBoot,
        graciaBootMinutos = GRACIA_POST_BOOT_MINUTOS,
    } = ctx;

    const edad = Number.isFinite(ageMinutes) ? ageMinutes : 0;
    const umbral = Number.isFinite(timeoutMinutes) ? timeoutMinutes : 10;

    // Todavía dentro de su ventana normal de trabajo.
    if (edad < umbral) return { huerfano: false, motivo: MOTIVOS.JOVEN };

    // La conocemos y sigue corriendo.
    if (registroConocido && procesoVivo) {
        return { huerfano: false, motivo: MOTIVOS.PROCESO_VIVO };
    }

    // No la conocemos Y el registro está frío: no podemos distinguir muerte de
    // desconocimiento. Nos abstenemos — ver cabecera.
    const vidaDelPulpo = Number.isFinite(minutosDesdeBoot) ? minutosDesdeBoot : Infinity;
    if (!registroConocido && vidaDelPulpo < graciaBootMinutos) {
        return { huerfano: false, motivo: MOTIVOS.GRACIA_POST_BOOT };
    }

    return { huerfano: true, motivo: MOTIVOS.HUERFANO };
}

/**
 * Marca el instante en que una corrida entra a `trabajando/`.
 *
 * `fs.renameSync` preserva el mtime, así que sin esto `fileAgeMinutes` mide la
 * antigüedad del dropfile (cuándo se escribió el YAML) en vez de la antigüedad
 * de LA CORRIDA, que es lo que el barrido cree estar midiendo.
 *
 * Best-effort: si el touch falla, el barrido sigue funcionando con la ventana
 * de gracia y el registro persistente como redes de contención.
 *
 * @param {string} filePath
 * @param {object} [deps]
 * @param {typeof fs} [deps.fsImpl]
 * @param {number} [deps.now]
 * @returns {boolean} true si pudo marcar
 */
function marcarEntradaEnTrabajando(filePath, deps = {}) {
    const _fs = deps.fsImpl || fs;
    const _now = Number.isFinite(deps.now) ? deps.now : Date.now();
    try {
        const ts = new Date(_now);
        _fs.utimesSync(filePath, ts, ts);
        return true;
    } catch {
        return false;
    }
}

module.exports = {
    decidirHuerfano,
    marcarEntradaEnTrabajando,
    GRACIA_POST_BOOT_MINUTOS,
    MOTIVOS,
};

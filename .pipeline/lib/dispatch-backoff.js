// =============================================================================
// dispatch-backoff — espera entre reintentos cuando la cadena de providers
// quedó agotada.
//
// EL AGUJERO QUE CIERRA (incidente 2026-09-08)
// --------------------------------------------
// Cuando `resolveSpawnWithFallback` devuelve `gated` (primario fuera de su
// ventana horaria + todos los fallbacks bloqueados), el Pulpo devolvía el
// dropfile a `pendiente/` y lo reintentaba en el tick siguiente — cada 30
// segundos, sin espera. Con Anthropic apagado de 20:00 a 07:00 y ningún
// fallback de pie, eso fueron ~170 `chain_exhausted` por hora durante diez
// horas: 7538 eventos de dispatch en el día, de los cuales apenas 51 llegaron a
// lanzar un agente.
//
// El reintento inmediato no aporta nada: lo que bloquea el despacho es una
// ventana horaria o una cuota, y ninguna de las dos se resuelve en 30 segundos.
//
// POR QUÉ NO REUSA `registerFastFail`
// -----------------------------------
// El cooldown de fast-fail del Pulpo describe otra cosa: "el agente arrancó y
// se murió enseguida", y por eso escala hasta 60 minutos y alimenta el circuit
// breaker del issue. Acá el agente NI ARRANCÓ y la culpa no es del issue:
// mezclarlos le cobraría al código un problema de disponibilidad de provider.
// Techo más corto (15 min) porque la espera sólo tiene que cubrir el hueco
// hasta que un provider vuelva, no penalizar a nadie.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

const BASE_MS = 60 * 1000;        // primera espera: 1 minuto
const TECHO_MS = 15 * 60 * 1000;  // techo: 15 minutos
const ARCHIVO = 'dispatch-backoff.json';

function rutaArchivo(pipelineDir) {
    return path.join(pipelineDir, 'state', ARCHIVO);
}

function leer(pipelineDir, fsImpl) {
    try {
        return JSON.parse(fsImpl.readFileSync(rutaArchivo(pipelineDir), 'utf8')) || {};
    } catch {
        return {};
    }
}

function escribir(pipelineDir, datos, fsImpl) {
    const file = rutaArchivo(pipelineDir);
    try {
        fsImpl.mkdirSync(path.dirname(file), { recursive: true });
        fsImpl.writeFileSync(file, JSON.stringify(datos, null, 2), 'utf8');
        return true;
    } catch {
        return false;
    }
}

function clave(skill, issue) {
    return `${skill}:${issue}`;
}

/**
 * La cadena quedó agotada para este (skill, issue): programa la próxima ventana
 * de reintento. Cada agotamiento consecutivo duplica la espera hasta el techo.
 *
 * @returns {{ esperaMs: number, esperaMin: number, consecutivos: number }}
 */
function registrarCadenaAgotada(pipelineDir, skill, issue, deps = {}) {
    const _fs = deps.fsImpl || fs;
    const ahora = Number.isFinite(deps.now) ? deps.now : Date.now();
    const datos = leer(pipelineDir, _fs);
    const k = clave(skill, issue);

    const consecutivos = ((datos[k] && datos[k].consecutivos) || 0) + 1;
    const esperaMs = Math.min(BASE_MS * Math.pow(2, consecutivos - 1), TECHO_MS);

    datos[k] = {
        consecutivos,
        esperarHasta: ahora + esperaMs,
        ultimoAgotamiento: new Date(ahora).toISOString(),
    };
    escribir(pipelineDir, datos, _fs);

    return { esperaMs, esperaMin: Math.round(esperaMs / 60000), consecutivos };
}

/**
 * ¿Este (skill, issue) todavía está esperando? El Pulpo lo consulta ANTES de
 * mover el dropfile a `trabajando/`, así se evita también el ida-y-vuelta de
 * archivos que ensuciaba el kanban en cada tick.
 *
 * @returns {{ esperando: boolean, restanteMin: number }}
 */
function estaEsperando(pipelineDir, skill, issue, deps = {}) {
    const _fs = deps.fsImpl || fs;
    const ahora = Number.isFinite(deps.now) ? deps.now : Date.now();
    const entrada = leer(pipelineDir, _fs)[clave(skill, issue)];
    if (!entrada || !Number.isFinite(entrada.esperarHasta)) {
        return { esperando: false, restanteMin: 0 };
    }
    const restante = entrada.esperarHasta - ahora;
    if (restante <= 0) return { esperando: false, restanteMin: 0 };
    return { esperando: true, restanteMin: Math.ceil(restante / 60000) };
}

/**
 * Hubo despacho efectivo (o el operador destrabó): la cuenta vuelve a cero para
 * que el próximo agotamiento empiece por 1 minuto y no arrastre el techo.
 */
function limpiar(pipelineDir, skill, issue, deps = {}) {
    const _fs = deps.fsImpl || fs;
    const datos = leer(pipelineDir, _fs);
    const k = clave(skill, issue);
    if (!datos[k]) return false;
    delete datos[k];
    escribir(pipelineDir, datos, _fs);
    return true;
}

module.exports = {
    registrarCadenaAgotada,
    estaEsperando,
    limpiar,
    BASE_MS,
    TECHO_MS,
};

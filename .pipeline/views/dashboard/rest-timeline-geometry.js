'use strict';

// =============================================================================
// rest-timeline-geometry.js — EP8-H11 (#3964, épica #3952)
// -----------------------------------------------------------------------------
// Geometría PURA del timeline semanal de modo descanso (7 días × 24 h). Toda la
// matemática de posicionamiento (minuto → píxel y viceversa), snap a resolución,
// rectángulos de bloque (incluyendo cruce de medianoche) y detección de overlap
// vive acá, SIN tocar el DOM. Eso la hace unit-testeable con `node --test`
// (CA-1/CA-2/CA-3), a diferencia del string del `<script>` de descanso.js.
//
// El módulo se consume de dos formas:
//   1. Node (tests): `require()` directo de las funciones puras.
//   2. Browser (descanso.js): se inyecta `REST_TIMELINE_GEOMETRY_JS` dentro del
//      `<script>`. Es un IIFE que expone `RestTimelineGeo.{...}` — namespaced
//      para no colisionar con los identificadores ya declarados en el script de
//      descanso.js (hhmmToMin, MIN_PER_DAY, HHMM_RE, isFullDay, etc.).
//
// El snippet del browser se GENERA desde el `.toString()` de las mismas
// funciones (abajo), de modo que NO hay dos copias del algoritmo que puedan
// driftear: una sola fuente de verdad, dos formas de empaquetarla.
//
// IMPORTANTE (FE-SEC-2): esta geometría es SOLO UX. El invariante de
// no-superposición real lo enforza el backend en `setWindow`/`validateSchedule`.
// `wouldOverlap` evita construir agendas inválidas desde la UI, pero un POST
// directo con overlap DEBE seguir siendo rechazado server-side.
// =============================================================================

const MIN_PER_DAY = 1440;
const DEFAULT_PX_PER_HOUR = 40;
const DEFAULT_SNAP_MIN = 30;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const FULL_DAY_START = '00:00';
const FULL_DAY_END = '23:59';

// "HH:MM" → minutos desde medianoche (0..1439). null si el formato es inválido.
function hhmmToMin(hhmm) {
    if (typeof hhmm !== 'string' || !HHMM_RE.test(hhmm)) return null;
    const parts = hhmm.split(':');
    return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}

// minutos (cualquier entero) → "HH:MM" normalizado al rango del día.
function minToHhmm(min) {
    let m = Math.round(min);
    m = ((m % MIN_PER_DAY) + MIN_PER_DAY) % MIN_PER_DAY;
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return (h < 10 ? '0' + h : '' + h) + ':' + (mm < 10 ? '0' + mm : '' + mm);
}

// minutos desde medianoche → coordenada Y (px) en la columna del día.
function minToY(min, pxPerHour) {
    const pph = pxPerHour || DEFAULT_PX_PER_HOUR;
    return (min / 60) * pph;
}

// coordenada Y (px) → minutos desde medianoche. Inversa exacta de minToY.
function yToMin(y, pxPerHour) {
    const pph = pxPerHour || DEFAULT_PX_PER_HOUR;
    return (y / pph) * 60;
}

// Redondea a la resolución de snap (default 30'). El resultado se acota al
// rango [0, MIN_PER_DAY] para no salirse de la columna del día.
function snapMin(min, step) {
    const s = step || DEFAULT_SNAP_MIN;
    let snapped = Math.round(min / s) * s;
    if (snapped <= 0) snapped = 0;  // normaliza también -0
    if (snapped > MIN_PER_DAY) snapped = MIN_PER_DAY;
    return snapped;
}

function isFullDay(p) {
    return !!p && p.start === FULL_DAY_START && p.end === FULL_DAY_END;
}

// Devuelve los rectángulos a dibujar para un período. Un período intra-día es
// un solo rect; el día completo (00:00–23:59) ocupa toda la columna; el cruce
// de medianoche (start > end) se PARTE en dos segmentos: la cola del día actual
// (head) y el arranque del día siguiente (tail), cada uno con su top/height en
// px. Devuelve [] si el período es inválido.
function blockRect(period, pxPerHour) {
    const pph = pxPerHour || DEFAULT_PX_PER_HOUR;
    const s = hhmmToMin(period && period.start);
    const e = hhmmToMin(period && period.end);
    if (s === null || e === null) return [];
    if (isFullDay(period)) {
        return [{
            startMin: 0, endMin: MIN_PER_DAY,
            top: minToY(0, pph), height: minToY(MIN_PER_DAY, pph),
            crossesMidnight: false, segment: 'full',
        }];
    }
    if (s < e) {
        return [{
            startMin: s, endMin: e,
            top: minToY(s, pph), height: minToY(e - s, pph),
            crossesMidnight: false, segment: 'single',
        }];
    }
    if (s === e) return []; // mismo horario sin ser día completo → inválido
    // Cruce de medianoche: head [s, 1440) en el día, tail [0, e) en el siguiente.
    return [
        {
            startMin: s, endMin: MIN_PER_DAY,
            top: minToY(s, pph), height: minToY(MIN_PER_DAY - s, pph),
            crossesMidnight: true, segment: 'head',
        },
        {
            startMin: 0, endMin: e,
            top: minToY(0, pph), height: minToY(e, pph),
            crossesMidnight: true, segment: 'tail',
        },
    ];
}

// Intervalos lineales [start, end) (en minutos) que ocupa un período. El cruce
// de medianoche se modela como un único intervalo continuo que se derrama al
// día siguiente (end = 1440 + e), para que el overlap intra-día lo detecte sin
// casos especiales. Devuelve [] si el período es inválido.
function periodIntervals(period) {
    const s = hhmmToMin(period && period.start);
    const e = hhmmToMin(period && period.end);
    if (s === null || e === null) return [];
    if (isFullDay(period)) return [[0, MIN_PER_DAY]];
    if (s < e) return [[s, e]];
    if (s === e) return [];
    return [[s, MIN_PER_DAY + e]];
}

function intervalsCollide(a, b) {
    return a[0] < b[1] && b[0] < a[1];
}

// ¿El período `candidate` se solaparía con alguno de los ya existentes en `day`?
// `ignoreIdx` excluye un índice (típicamente el bloque que se está moviendo).
// Considera el derrame de cruce de medianoche en ambos sentidos (±1 día) para
// detectar colisiones entre la cola de un cruce y un período temprano.
function wouldOverlap(schedule, day, candidate, ignoreIdx) {
    const list = (schedule && schedule[day]) || [];
    const candIvs = periodIntervals(candidate);
    if (!candIvs.length) return false;
    for (let i = 0; i < list.length; i++) {
        if (ignoreIdx != null && i === ignoreIdx) continue;
        const ivs = periodIntervals(list[i]);
        for (let a = 0; a < candIvs.length; a++) {
            for (let b = 0; b < ivs.length; b++) {
                const ca = candIvs[a];
                const ce = ivs[b];
                if (intervalsCollide(ca, ce)) return true;
                // Comparar también el derrame ±1 día (cruce de medianoche).
                if (intervalsCollide([ca[0] - MIN_PER_DAY, ca[1] - MIN_PER_DAY], ce)) return true;
                if (intervalsCollide(ca, [ce[0] - MIN_PER_DAY, ce[1] - MIN_PER_DAY])) return true;
            }
        }
    }
    return false;
}

// --- Snippet para el browser ------------------------------------------------
// Se construye desde el `.toString()` de las funciones puras de arriba, así no
// duplicamos el algoritmo. Las constantes del módulo se re-declaran como `var`
// dentro del IIFE (los identificadores quedan scopeados, sin colisión con el
// script de descanso.js). Se expone `RestTimelineGeo.{...}` global.
function buildBrowserSnippet() {
    const fns = [
        hhmmToMin, minToHhmm, minToY, yToMin, snapMin,
        isFullDay, blockRect, periodIntervals, intervalsCollide, wouldOverlap,
    ].map(f => f.toString()).join('\n');
    return [
        'var RestTimelineGeo = (function(){',
        '  var MIN_PER_DAY = ' + MIN_PER_DAY + ';',
        '  var DEFAULT_PX_PER_HOUR = ' + DEFAULT_PX_PER_HOUR + ';',
        '  var DEFAULT_SNAP_MIN = ' + DEFAULT_SNAP_MIN + ';',
        '  var HHMM_RE = ' + HHMM_RE.toString() + ';',
        "  var FULL_DAY_START = '" + FULL_DAY_START + "';",
        "  var FULL_DAY_END = '" + FULL_DAY_END + "';",
        fns,
        '  return {',
        '    MIN_PER_DAY: MIN_PER_DAY, DEFAULT_PX_PER_HOUR: DEFAULT_PX_PER_HOUR,',
        '    DEFAULT_SNAP_MIN: DEFAULT_SNAP_MIN,',
        '    hhmmToMin: hhmmToMin, minToHhmm: minToHhmm, minToY: minToY, yToMin: yToMin,',
        '    snapMin: snapMin, isFullDay: isFullDay, blockRect: blockRect,',
        '    periodIntervals: periodIntervals, wouldOverlap: wouldOverlap',
        '  };',
        '})();',
    ].join('\n');
}

const REST_TIMELINE_GEOMETRY_JS = buildBrowserSnippet();

module.exports = {
    MIN_PER_DAY,
    DEFAULT_PX_PER_HOUR,
    DEFAULT_SNAP_MIN,
    FULL_DAY_START,
    FULL_DAY_END,
    hhmmToMin,
    minToHhmm,
    minToY,
    yToMin,
    snapMin,
    isFullDay,
    blockRect,
    periodIntervals,
    wouldOverlap,
    REST_TIMELINE_GEOMETRY_JS,
};

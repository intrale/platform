// Tests del módulo PURO de geometría del timeline de modo descanso (#3964,
// EP8-H11). Cubre la matemática min↔px, snap, blockRect (incluido cruce de
// medianoche) y wouldOverlap (colisión en el mismo día). Sin DOM — todo es
// función pura, por eso vive acá y se levanta con `node --test`.
//
// El módulo está en `.pipeline/views/dashboard/rest-timeline-geometry.js`; el
// test se ubica junto a la familia rest-mode (convención `guru` en validación).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const geo = require(path.resolve(__dirname, '..', '..', 'views', 'dashboard', 'rest-timeline-geometry.js'));

test('minToY y yToMin son inversas exactas (round-trip)', () => {
    for (const min of [0, 30, 90, 645, 720, 1320, 1439, 1440]) {
        const y = geo.minToY(min, 40);
        assert.equal(geo.yToMin(y, 40), min, 'round-trip falla para ' + min);
    }
});

test('minToY usa pxPerHour por defecto cuando no se pasa', () => {
    assert.equal(geo.minToY(60), geo.DEFAULT_PX_PER_HOUR);
    assert.equal(geo.minToY(120), geo.DEFAULT_PX_PER_HOUR * 2);
});

test('snapMin redondea a la resolución de 30 minutos por defecto', () => {
    assert.equal(geo.snapMin(14), 0);
    assert.equal(geo.snapMin(15), 30);
    assert.equal(geo.snapMin(44), 30);
    assert.equal(geo.snapMin(46), 60);
    assert.equal(geo.snapMin(100), 90);
});

test('snapMin respeta un step custom y acota al rango del día', () => {
    assert.equal(geo.snapMin(100, 15), 105);
    assert.equal(geo.snapMin(-10), 0);
    assert.equal(geo.snapMin(2000), geo.MIN_PER_DAY);
});

test('blockRect de un período intra-día devuelve un solo rectángulo', () => {
    const rects = geo.blockRect({ start: '10:00', end: '12:00' }, 40);
    assert.equal(rects.length, 1);
    assert.equal(rects[0].crossesMidnight, false);
    assert.equal(rects[0].startMin, 600);
    assert.equal(rects[0].endMin, 720);
    assert.equal(rects[0].top, geo.minToY(600, 40));
    assert.equal(rects[0].height, geo.minToY(120, 40));
});

test('blockRect del día completo ocupa toda la columna', () => {
    const rects = geo.blockRect({ start: '00:00', end: '23:59' }, 40);
    assert.equal(rects.length, 1);
    assert.equal(rects[0].segment, 'full');
    assert.equal(rects[0].height, geo.minToY(geo.MIN_PER_DAY, 40));
});

test('blockRect parte el cruce de medianoche en head + tail', () => {
    const rects = geo.blockRect({ start: '22:00', end: '07:00' }, 40);
    assert.equal(rects.length, 2);
    const head = rects.find(r => r.segment === 'head');
    const tail = rects.find(r => r.segment === 'tail');
    assert.ok(head && tail, 'faltan segmentos head/tail');
    assert.equal(head.startMin, 1320);
    assert.equal(head.endMin, geo.MIN_PER_DAY);
    assert.equal(tail.startMin, 0);
    assert.equal(tail.endMin, 420);
    assert.equal(head.crossesMidnight, true);
    assert.equal(tail.crossesMidnight, true);
});

test('blockRect devuelve [] para períodos inválidos', () => {
    assert.deepEqual(geo.blockRect({ start: '25:00', end: '07:00' }), []);
    assert.deepEqual(geo.blockRect({ start: '10:00', end: '10:00' }), []);
    assert.deepEqual(geo.blockRect(null), []);
});

test('wouldOverlap detecta colisión en el mismo día', () => {
    const schedule = { monday: [{ start: '10:00', end: '12:00' }] };
    assert.equal(geo.wouldOverlap(schedule, 'monday', { start: '11:00', end: '13:00' }), true);
    assert.equal(geo.wouldOverlap(schedule, 'monday', { start: '11:30', end: '11:45' }), true);
});

test('wouldOverlap NO marca bloques adyacentes que se tocan en el borde', () => {
    const schedule = { monday: [{ start: '10:00', end: '12:00' }] };
    assert.equal(geo.wouldOverlap(schedule, 'monday', { start: '12:00', end: '13:00' }), false);
    assert.equal(geo.wouldOverlap(schedule, 'monday', { start: '08:00', end: '10:00' }), false);
});

test('wouldOverlap ignora el índice del bloque que se está moviendo', () => {
    const schedule = { monday: [{ start: '10:00', end: '12:00' }, { start: '14:00', end: '15:00' }] };
    // mover el bloque 0 dentro de sí mismo no debe contar como overlap
    assert.equal(geo.wouldOverlap(schedule, 'monday', { start: '10:30', end: '12:30' }, 0), false);
    // pero si pisa al bloque 1 sí
    assert.equal(geo.wouldOverlap(schedule, 'monday', { start: '13:30', end: '14:30' }, 0), true);
});

test('wouldOverlap considera el derrame del cruce de medianoche', () => {
    const schedule = { monday: [{ start: '22:00', end: '07:00' }] };
    // un bloque temprano choca con la cola del cruce
    assert.equal(geo.wouldOverlap(schedule, 'monday', { start: '06:00', end: '06:30' }), true);
    // un bloque en la tarde no choca
    assert.equal(geo.wouldOverlap(schedule, 'monday', { start: '12:00', end: '13:00' }), false);
});

test('wouldOverlap es false cuando el día no tiene períodos', () => {
    assert.equal(geo.wouldOverlap({ monday: [] }, 'monday', { start: '10:00', end: '12:00' }), false);
    assert.equal(geo.wouldOverlap({}, 'tuesday', { start: '10:00', end: '12:00' }), false);
});

test('hhmmToMin y minToHhmm round-trip', () => {
    for (const hhmm of ['00:00', '07:30', '12:00', '23:59']) {
        assert.equal(geo.minToHhmm(geo.hhmmToMin(hhmm)), hhmm);
    }
    assert.equal(geo.hhmmToMin('bad'), null);
    assert.equal(geo.hhmmToMin('24:00'), null);
});

test('el snippet del browser (REST_TIMELINE_GEOMETRY_JS) parsea y expone RestTimelineGeo', () => {
    assert.equal(typeof geo.REST_TIMELINE_GEOMETRY_JS, 'string');
    // eslint-disable-next-line no-new-func
    const RestTimelineGeo = new Function(geo.REST_TIMELINE_GEOMETRY_JS + '; return RestTimelineGeo;')();
    assert.equal(typeof RestTimelineGeo.minToY, 'function');
    assert.equal(typeof RestTimelineGeo.wouldOverlap, 'function');
    // la versión browser debe dar el mismo resultado que la de Node
    assert.equal(RestTimelineGeo.minToY(90, 40), geo.minToY(90, 40));
    assert.equal(
        RestTimelineGeo.wouldOverlap({ monday: [{ start: '10:00', end: '12:00' }] }, 'monday', { start: '11:00', end: '13:00' }),
        true,
    );
});

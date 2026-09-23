'use strict';

// #6809 H3 — eje capacidad: los tres Gherkin de capacidad + bajar + sin evidencia.

const test = require('node:test');
const assert = require('node:assert/strict');

const cap = require('../axis-capacity');
const { construirPayload } = require('../publish');

const H = 3600 * 1000;
const T0 = Date.parse('2026-09-01T00:00:00.000Z');
const CFG = {
    resource_limits: {
        yellow_max_percent: 78, orange_max_percent: 88, max_concurrent_devs: 1,
        night_window: { yellow_max_percent: 78, orange_max_percent: 88, max_concurrent_devs: 2 },
    },
};

/** Hora sintética del rollup. */
function hora(i, o = {}) {
    const n = o.n || 120;
    return {
        ts: T0 + i * H,
        n_muestras: n,
        muestras_cero_agentes: o.cero !== undefined ? o.cero : 0,
        por_agentes: o.por || { 0: { n: 60, mem_p50: 64, mem_p95: 70, mem_max: 72, cpu_p50: 5, cpu_max: 10 } },
        elegibles_p50: o.eleg !== undefined ? o.eleg : 0,
        elegibles_max: o.eleg !== undefined ? o.eleg : 0,
        elegibles_p50_cero: o.elegCero !== undefined ? o.elegCero : 0,
        causa_moda: o.causa || 'partial-pause',
        cap_efectivo: o.cap || 1,
        nocturna: o.nocturna === true,
        muestras_en_cap: o.enCap || 0,
        en_cap: { n: o.enCap || 0, mem_p95: o.p95 !== undefined ? o.p95 : null, mem_max: o.max !== undefined ? o.max : null },
    };
}

test('Gherkin: cola ociosa por falta de trabajo (dataset 03/09) ⇒ NO sube el paralelismo y ataca la causa', () => {
    // 80 % de la ventana con cero agentes, recursos holgados, trabajo frenado.
    const horas = Array.from({ length: 48 }, (_, i) => hora(i, {
        cero: 96, elegCero: 0, causa: 'partial-pause', enCap: 24, p95: 66, max: 70,
        por: { 0: { n: 96, mem_p50: 63.8, mem_p95: 70, mem_max: 79, cpu_p50: 5, cpu_max: 9 },
            2: { n: 12, mem_p50: 69.7, mem_p95: 72, mem_max: 76, cpu_p50: 31, cpu_max: 40 },
            3: { n: 12, mem_p50: 72.5, mem_p95: 76, mem_max: 81, cpu_p50: 25, cpu_max: 40 } },
    }));
    const r = cap.evaluarCapacidad({ horas, cfgRoot: CFG, ventana: '14d hasta 2026-09-03' });
    assert.ok(!r.hallazgos.some((h) => h.clave === 'concurrencia_subir'), 'subir prohibido');
    const h = r.hallazgos.find((x) => x.clave === 'ociosidad_sin_trabajo');
    assert.ok(h, 'propone atacar la causa');
    assert.equal(h.metrica.valor, 80);
    assert.equal(h.params.causa, 'partial-pause');
    assert.equal(h.sube_costo_o_riesgo, false);
    const p = construirPayload(h);
    assert.equal(p.ok, true);
    assert.match(p.payload.evidencia.resumen, /pct_tiempo_cero_agentes 80% en 14d hasta 2026-09-03/);
    assert.match(p.payload.accion, /en lugar de subir el limite/);
    // Regresión sobre los buckets 0/2/3 de la medición del 03/09: ~3 pp por
    // agente (el issue midió ~2,4 incluyendo el bucket de 4 agentes).
    assert.ok(r.detalle.costo_marginal_ram >= 2 && r.detalle.costo_marginal_ram <= 3.5, `costo marginal ${r.detalle.costo_marginal_ram}`);
});

test('ociosidad CON trabajo elegible esperando ⇒ revisar el gate, tampoco sube', () => {
    const horas = Array.from({ length: 48 }, (_, i) => hora(i, { cero: 100, elegCero: 4, causa: 'quota' }));
    const r = cap.evaluarCapacidad({ horas, cfgRoot: CFG, ventana: 'v' });
    assert.deepEqual(r.hallazgos.map((h) => h.clave), ['ociosidad_con_trabajo']);
    assert.equal(r.hallazgos[0].params.causa, 'quota');
});

test('Gherkin: capacidad saturada con margen medido ⇒ subir +1 gradual con reversión, como cambio de configuración', () => {
    const por = { 0: { n: 40, mem_p50: 58, mem_p95: 60, mem_max: 62, cpu_p50: 5, cpu_max: 9 },
        1: { n: 80, mem_p50: 61, mem_p95: 63, mem_max: 66, cpu_p50: 30, cpu_max: 50 } };
    const horas = Array.from({ length: 48 }, (_, i) => hora(i, { cero: 40, eleg: 3, elegCero: 3, enCap: 80, p95: 63, max: 66, por }));
    const r = cap.evaluarCapacidad({ horas, cfgRoot: CFG, ventana: '14d hasta 2026-09-23' });
    assert.equal(r.veredicto, 'subir');
    const h = r.hallazgos.find((x) => x.clave === 'concurrencia_subir');
    assert.ok(h);
    assert.equal(h.params.cap, 1);
    assert.equal(h.params.objetivo, 2, 'paso +1, nunca un salto');
    assert.equal(h.params.costo_marginal, 3);
    assert.equal(h.params.margen, 12);
    assert.equal(h.sube_costo_o_riesgo, true);
    const p = construirPayload(h);
    assert.equal(p.payload.tipo, 'cambio-de-configuracion');
    assert.match(p.payload.accion, /Condicion de reversion: volver a 1 si mem_p95 >= yellow_max_percent \(78%\) durante 2 h seguidas/);
    assert.match(p.payload.costo.detalle, /3 pp de RAM por agente/);
});

test('Gherkin: evidencia ambigua (cap poco usado) ⇒ mantener, nada publicable', () => {
    const horas = Array.from({ length: 48 }, (_, i) => hora(i, { cero: 30, eleg: 2, elegCero: 2, enCap: 10, p95: 63, max: 66 }));
    const r = cap.evaluarCapacidad({ horas, cfgRoot: CFG, ventana: 'v' });
    assert.equal(r.veredicto, 'mantener');
    assert.deepEqual(r.hallazgos, []);
});

test('sin costo marginal medible (un solo bucket) no sube aunque el cap esté lleno', () => {
    const horas = Array.from({ length: 48 }, (_, i) => hora(i, { cero: 0, eleg: 3, elegCero: 3, enCap: 100, p95: 60, max: 62,
        por: { 1: { n: 120, mem_p50: 60, mem_p95: 60, mem_max: 62, cpu_p50: 5, cpu_max: 9 } } }));
    const r = cap.evaluarCapacidad({ horas, cfgRoot: CFG, ventana: 'v' });
    assert.equal(r.veredicto, 'mantener');
});

test('pico de RAM con el cap lleno en naranja ⇒ bajar (gana sobre subir por sesgo a la estabilidad)', () => {
    const por = { 0: { n: 40, mem_p50: 58, mem_p95: 60, mem_max: 62, cpu_p50: 5, cpu_max: 9 },
        2: { n: 80, mem_p50: 64, mem_p95: 66, mem_max: 90, cpu_p50: 30, cpu_max: 50 } };
    const horas = Array.from({ length: 48 }, (_, i) => hora(i, { cero: 40, eleg: 3, elegCero: 3, enCap: 80, p95: 66, max: 90, nocturna: true, cap: 2, por }));
    const r = cap.evaluarCapacidad({ horas, cfgRoot: CFG, ventana: 'v' });
    const h = r.hallazgos.find((x) => x.clave === 'concurrencia_bajar');
    assert.ok(h);
    assert.equal(h.params.clave_config, 'night_window.max_concurrent_devs');
    assert.equal(h.params.objetivo, 1);
    assert.ok(!r.hallazgos.some((x) => x.clave === 'concurrencia_subir'));
    assert.equal(r.veredicto, 'bajar');
});

test('pocas horas válidas ⇒ sin_evidencia_suficiente (D7)', () => {
    const horas = Array.from({ length: 10 }, (_, i) => hora(i));
    assert.equal(cap.evaluarCapacidad({ horas, cfgRoot: CFG, ventana: 'v' }).veredicto, 'sin_evidencia_suficiente');
    const flacas = Array.from({ length: 48 }, (_, i) => hora(i, { n: 10 }));
    assert.equal(cap.evaluarCapacidad({ horas: flacas, cfgRoot: CFG, ventana: 'v', minSamplesHora: 60 }).veredicto, 'sin_evidencia_suficiente');
    assert.equal(cap.evaluarCapacidad({}).veredicto, 'sin_evidencia_suficiente');
});

test('sin umbrales de recursos en la config no propone nada (no inventa umbrales)', () => {
    const horas = Array.from({ length: 48 }, (_, i) => hora(i, { cero: 0, eleg: 3, elegCero: 3, enCap: 100, p95: 60, max: 99 }));
    const r = cap.evaluarCapacidad({ horas, cfgRoot: {}, ventana: 'v' });
    assert.deepEqual(r.hallazgos, []);
});

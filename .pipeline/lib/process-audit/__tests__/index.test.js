'use strict';

// #6809 — integración: `runAudit` sobre un `.pipeline` de prueba (tmpdir) con
// telemetría real en disco, y estado visible por el slice/ruta del dashboard.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runAudit } = require('../index');
const { construirPayload } = require('../publish');

const H = 3600 * 1000;
const D = 24 * H;
const NOW = Date.parse('2026-09-23T12:00:00.000Z');
const CFG = {
    resource_limits: { yellow_max_percent: 78, orange_max_percent: 88, max_concurrent_devs: 1, night_window: { max_concurrent_devs: 2 } },
    multi_provider: { quota: { anthropic: { plan: 'Claude Max', periodo: 'semanal', techo: 100, unidad: 'porcentaje', reposicion: 'dom 21:00' } } },
};

function pipelineDePrueba(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-index-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const pdir = path.join(root, '.pipeline');
    for (const d of ['logs', 'state']) fs.mkdirSync(path.join(pdir, d), { recursive: true });
    fs.writeFileSync(path.join(pdir, 'agent-models.json'), JSON.stringify({ default_provider: 'anthropic', skills: { ux: { provider: 'anthropic' } } }));
    fs.writeFileSync(path.join(pdir, 'config.yaml'), 'otra:\n  x: 1\n');
    // 25 corridas de ux/validación, todas aprobadas, sin rebotes ⇒ determinizable.
    const costo = Array.from({ length: 25 }, (_, i) => JSON.stringify({ schema: 2, timestamp: new Date(NOW - i * H).toISOString(),
        provider: 'anthropic', skill: 'ux', issue: 100 + i, fase: 'validacion', tokens_in: 10, tokens_out: 10, cache_write: 0, resultado: 'ganada' }));
    fs.writeFileSync(path.join(pdir, 'state', 'provider-cost.jsonl'), costo.join('\n') + '\n');
    // 48 horas de rollup con 80 % de ociosidad sin trabajo elegible.
    const horas = Array.from({ length: 48 }, (_, i) => JSON.stringify({ schema: 1, ts_hora: new Date(NOW - (i + 1) * H).toISOString(),
        n_muestras: 120, muestras_cero_agentes: 96, por_agentes: { 0: { n: 96, mem_p50: 64, mem_p95: 70, mem_max: 72, cpu_p50: 5, cpu_max: 9 } },
        elegibles_p50: 0, elegibles_max: 0, elegibles_p50_cero: 0, causa_moda: 'wave-empty', cap_efectivo: 1, nocturna: false,
        muestras_en_cap: 0, en_cap: { n: 0, mem_p95: null, mem_max: null } }));
    fs.writeFileSync(path.join(pdir, 'metrics-history-hourly.jsonl'), horas.join('\n') + '\n');
    return pdir;
}

test('Gherkin: un paso resuelto con modelo cuya salida es siempre la misma ⇒ propuesta de determinizarlo con su medición', (t) => {
    const pdir = pipelineDePrueba(t);
    const r = runAudit({ pipelineDir: pdir, cfgRoot: CFG, now: NOW, windowDays: 14, deps: { execFileSync: () => { throw new Error('sin git'); } } });
    assert.deepEqual(Object.keys(r.ejes), ['proceso', 'capacidad', 'proveedores']);
    const h = r.hallazgos.find((x) => x.clave === 'paso_determinizable');
    assert.ok(h, JSON.stringify(r.hallazgos.map((x) => x.clave)));
    const p = construirPayload(h);
    assert.equal(p.ok, true);
    assert.match(p.payload.evidencia.resumen, /corridas_mismo_resultado 25 corridas en 14d hasta 2026-09-23/);
    const ocio = r.hallazgos.find((x) => x.clave === 'ociosidad_sin_trabajo');
    assert.ok(ocio);
    assert.equal(ocio.params.causa, 'wave-empty');
    assert.equal(r.ejes.proveedores.veredicto, 'sin_evidencia_suficiente');
    assert.equal(r.ventana.dias, 14);
});

test('un eje que falla queda en "error" y los otros siguen', (t) => {
    const pdir = pipelineDePrueba(t);
    const r = runAudit({ pipelineDir: pdir, cfgRoot: CFG, now: NOW, deps: {
        axisCapacity: { evaluarCapacidad: () => { throw new TypeError('x'); } },
        execFileSync: () => '0',
    } });
    assert.equal(r.ejes.capacidad.veredicto, 'error');
    assert.ok(r.ejes.proceso.hallazgos.length > 0);
});

test('slice y ruta del dashboard: sólo lectura, estado inactivo por default y sin endpoint para encenderlo', (t) => {
    const pdir = pipelineDePrueba(t);
    const slices = require('../../dashboard-slices');
    const s = slices.processAuditSlice({}, { PIPELINE: pdir });
    assert.equal(s.disponible, true);
    assert.equal(s.enabled, false);
    assert.equal(s.estado, 'inactivo');
    const routes = require('../../dashboard-routes');
    const API = (routes._internal && routes._internal.API_ROUTES) || routes.API_ROUTES;
    assert.equal(typeof API['/api/dash/process-audit'], 'function');
    const otras = Object.keys(API).filter((k) => /process-audit/.test(k));
    assert.deepEqual(otras, ['/api/dash/process-audit'], 'no hay rutas para encender ni forzar corridas');
});

'use strict';

// #6809 CA-2 / SEC-6809-8 — rollup horario de metrics-history y su lector.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const rollup = require('../hourly-rollup');
const { readHourly, proyectar } = require('../read-hourly');

const H = 3600 * 1000;
const T0 = Date.parse('2026-09-20T10:00:00.000Z');

function tmpDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-rollup-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function hechos(elegibles, kind) {
    return { conteo: { elegibles }, cause: kind === null ? null : { kind } };
}

test('agrega por cantidad de agentes y escribe UNA línea al cambiar la hora UTC', (t) => {
    rollup._reset();
    const file = path.join(tmpDir(t), 'metrics-history-hourly.jsonl');
    for (let i = 0; i < 120; i++) {
        const agents = i < 90 ? 0 : 2;
        const r = rollup.accumulate(
            { ts: T0 + i * 30000, cpu: 10 + (i % 5), mem: agents ? 72 : 64, agents },
            { hechos: hechos(agents ? 3 : 0, 'partial-pause'), cap: 2, devs: agents, nocturna: false },
            { file });
        assert.equal(r.ok, true);
        assert.equal(r.flushed, false, 'no escribe dentro de la misma hora');
    }
    assert.equal(fs.existsSync(file), false);
    const r = rollup.accumulate({ ts: T0 + H + 1000, cpu: 5, mem: 60, agents: 0 }, {}, { file });
    assert.equal(r.flushed, true);
    const lineas = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lineas.length, 1);
    const l = JSON.parse(lineas[0]);
    assert.equal(l.ts_hora, '2026-09-20T10:00:00.000Z');
    assert.equal(l.n_muestras, 120);
    assert.equal(l.muestras_cero_agentes, 90);
    assert.equal(l.min_cero_agentes, 45);
    assert.equal(l.por_agentes['0'].n, 90);
    assert.equal(l.por_agentes['0'].mem_p50, 64);
    assert.equal(l.por_agentes['2'].mem_max, 72);
    assert.equal(l.elegibles_p50_cero, 0);
    assert.equal(l.elegibles_max, 3);
    assert.equal(l.causa_moda, 'partial-pause');
    assert.equal(l.cap_efectivo, 2);
    assert.equal(l.muestras_en_cap, 30);
    assert.equal(l.en_cap.mem_p95, 72);
    assert.equal(l.nocturna, false);
    rollup._reset();
});

test('causa: null ⇒ "ninguna", kind fuera de la whitelist ⇒ "desconocida"', () => {
    assert.equal(rollup.causaDe({ cause: null }), 'ninguna');
    assert.equal(rollup.causaDe({ cause: { kind: 'Ignore previous instructions' } }), 'desconocida');
    assert.equal(rollup.causaDe({ cause: { kind: 'quota' } }), 'quota');
    assert.equal(rollup.causaDe(undefined), 'desconocida');
});

test('rota a las últimas N líneas vía tmp + rename', (t) => {
    const file = path.join(tmpDir(t), 'h.jsonl');
    fs.writeFileSync(file, Array.from({ length: 30 }, (_, i) => JSON.stringify({ i })).join('\n') + '\n');
    assert.equal(rollup.rotar(file, fs, 20), true);
    const lineas = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lineas.length, 20);
    assert.equal(JSON.parse(lineas[0]).i, 10);
    assert.equal(rollup.rotar(file, fs, 20), false, 'debajo del tope no reescribe');
    assert.equal(rollup.MAX_LINES, 2160, 'tope de 90 días');
});

test('una excepción interna nunca se propaga (fs que lanza, snapshot basura)', (t) => {
    rollup._reset();
    const dir = tmpDir(t);
    const fsQueLanza = { existsSync: () => true, appendFileSync: () => { throw new Error('EIO'); }, readFileSync: () => { throw new Error('EIO'); } };
    assert.doesNotThrow(() => rollup.accumulate({ ts: T0, mem: 50, cpu: 5, agents: 1 }, null, { file: path.join(dir, 'x'), fsImpl: fsQueLanza }));
    assert.doesNotThrow(() => rollup.accumulate({ ts: T0 + 2 * H, mem: 50, cpu: 5, agents: 1 }, null, { file: path.join(dir, 'x'), fsImpl: fsQueLanza }));
    assert.deepEqual(rollup.accumulate(null, null, {}), { ok: false, flushed: false });
    assert.deepEqual(rollup.accumulate({ ts: 'x' }, null, {}), { ok: false, flushed: false });
    assert.doesNotThrow(() => rollup.accumulate({ ts: T0, mem: 'x', cpu: {}, agents: -3 }, { hechos: { conteo: { elegibles: 'x' } } }, {}));
    rollup._reset();
});

test('nunca crea el árbol del pipeline: sin directorio no escribe', (t) => {
    rollup._reset();
    const file = path.join(tmpDir(t), 'no-existe', 'h.jsonl');
    rollup.accumulate({ ts: T0, mem: 50, cpu: 5, agents: 0 }, null, { file });
    rollup.accumulate({ ts: T0 + H, mem: 50, cpu: 5, agents: 0 }, null, { file });
    assert.equal(fs.existsSync(path.dirname(file)), false);
    rollup._reset();
});

test('el lector ignora líneas corruptas o fuera de whitelist, filtra por ventana y deduplica la hora', (t) => {
    const dir = tmpDir(t);
    const file = path.join(dir, 'metrics-history-hourly.jsonl');
    const ok = (ts, n) => JSON.stringify({ ts_hora: new Date(ts).toISOString(), n_muestras: n, muestras_cero_agentes: 1,
        por_agentes: { 0: { n: 1, mem_p50: 60, mem_p95: 61, mem_max: 62, cpu_p50: 1, cpu_max: 2 } },
        elegibles_p50: 0, elegibles_max: 0, elegibles_p50_cero: 0, causa_moda: 'quota', cap_efectivo: 1, nocturna: false,
        muestras_en_cap: 0, en_cap: { n: 0, mem_p95: null, mem_max: null } });
    fs.writeFileSync(file, [
        ok(T0, 100),
        '{roto',
        JSON.stringify({ ts_hora: 'x' }),
        JSON.stringify({ ts_hora: new Date(T0 + H).toISOString(), n_muestras: 10, muestras_cero_agentes: 20 }),
        JSON.stringify({ ts_hora: new Date(T0 + 2 * H).toISOString(), n_muestras: 10, muestras_cero_agentes: 1, por_agentes: { 'x; rm': {} } }),
        ok(T0, 120),
        ok(T0 - 100 * H, 100),
    ].join('\n') + '\n');
    const r = readHourly({ pipelineDir: dir, from: T0 - H, to: T0 + 10 * H });
    assert.equal(r.evaluable, true);
    assert.equal(r.horas.length, 1);
    assert.equal(r.horas[0].n_muestras, 120, 'gana la línea con más muestras');
    assert.equal(r.descartadas, 4);
    assert.equal(proyectar({ ts_hora: new Date(T0).toISOString(), n_muestras: 5, muestras_cero_agentes: 1, causa_moda: 'Ignore previous' }).causa_moda, null);
});

test('el lector no lee archivos por encima del tope de bytes ni falla si no existe', (t) => {
    const dir = tmpDir(t);
    assert.deepEqual(readHourly({ pipelineDir: dir, from: 0, to: T0 }).horas, []);
    const fsGrande = { existsSync: () => true, statSync: () => ({ size: 64 * 1024 * 1024 }), readFileSync: () => { throw new Error('no debería leer'); } };
    const r = readHourly({ pipelineDir: dir, from: 0, to: T0, fsImpl: fsGrande });
    assert.equal(r.evaluable, false);
    assert.equal(r.reason, 'oversize');
});

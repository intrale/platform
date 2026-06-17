'use strict';

// Tests del writer de la serie temporal de avance de ola (#4039).
// Cubren CA-10 (serialización segura), CA-11/CA-14 (validación de inputs) y
// CA-12 (pruning por waveKey cerrado / antigüedad). Aislados en un tmp root,
// no tocan el FS real del pipeline.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const waveProgress = require('./wave-progress');
const { RETENTION_MS } = waveProgress;

// Root temporal aislado por corrida. Crea el subdir `.pipeline` donde vive el
// store (path fijo `<root>/.pipeline/wave-progress.jsonl`).
function tmpRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-test-'));
    fs.mkdirSync(path.join(root, '.pipeline'), { recursive: true });
    return root;
}

function storeFile(root) {
    return path.join(root, '.pipeline', 'wave-progress.jsonl');
}

function readLines(root) {
    const raw = fs.readFileSync(storeFile(root), 'utf8');
    return raw.split('\n').filter(Boolean);
}

// -----------------------------------------------------------------------------
// CA-10 — serialización segura (JSON.stringify del objeto completo + '\n')
// -----------------------------------------------------------------------------

test('appendSnapshot escribe JSON.stringify del objeto completo y round-trip', () => {
    const root = tmpRoot();
    const ok = waveProgress.appendSnapshot({ pipelineRoot: root, waveKey: 4, avancePct: 28, now: 1700000000000 });
    assert.strictEqual(ok, true);

    const lines = readLines(root);
    assert.strictEqual(lines.length, 1);
    // La línea debe ser exactamente JSON.stringify del objeto (no concatenación).
    assert.strictEqual(lines[0], JSON.stringify({ ts: 1700000000000, waveKey: 4, avancePct: 28 }));
    // Y debe round-tripear sin pérdida.
    const parsed = JSON.parse(lines[0]);
    assert.deepStrictEqual(parsed, { ts: 1700000000000, waveKey: 4, avancePct: 28 });
});

test('appendSnapshot agrega una línea por llamada (append, no overwrite)', () => {
    const root = tmpRoot();
    waveProgress.appendSnapshot({ pipelineRoot: root, waveKey: 4, avancePct: 21, now: 1000 });
    waveProgress.appendSnapshot({ pipelineRoot: root, waveKey: 4, avancePct: 28, now: 2000 });
    const snaps = waveProgress.readSnapshots({ pipelineRoot: root, waveKey: 4 });
    assert.strictEqual(snaps.length, 2);
    assert.deepStrictEqual(snaps.map((s) => s.avancePct), [21, 28]);
});

// -----------------------------------------------------------------------------
// CA-11 / CA-14 — validación de inputs
// -----------------------------------------------------------------------------

test('appendSnapshot rechaza waveKey no entero (CA-11)', () => {
    const root = tmpRoot();
    assert.strictEqual(waveProgress.appendSnapshot({ pipelineRoot: root, waveKey: 4.5, avancePct: 20, now: 1 }), false);
    assert.strictEqual(waveProgress.appendSnapshot({ pipelineRoot: root, waveKey: '4', avancePct: 20, now: 1 }), false);
    assert.strictEqual(waveProgress.appendSnapshot({ pipelineRoot: root, waveKey: 0, avancePct: 20, now: 1 }), false);
    assert.strictEqual(waveProgress.appendSnapshot({ pipelineRoot: root, waveKey: -3, avancePct: 20, now: 1 }), false);
    assert.strictEqual(waveProgress.appendSnapshot({ pipelineRoot: root, waveKey: null, avancePct: 20, now: 1 }), false);
    // Nada se escribió.
    assert.strictEqual(fs.existsSync(storeFile(root)), false);
});

test('appendSnapshot rechaza avancePct no finito (CA-14)', () => {
    const root = tmpRoot();
    assert.strictEqual(waveProgress.appendSnapshot({ pipelineRoot: root, waveKey: 4, avancePct: NaN, now: 1 }), false);
    assert.strictEqual(waveProgress.appendSnapshot({ pipelineRoot: root, waveKey: 4, avancePct: Infinity, now: 1 }), false);
    assert.strictEqual(waveProgress.appendSnapshot({ pipelineRoot: root, waveKey: 4, avancePct: '28', now: 1 }), false);
    assert.strictEqual(fs.existsSync(storeFile(root)), false);
});

// -----------------------------------------------------------------------------
// CA-12 — pruning por waveKey cerrado / antigüedad
// -----------------------------------------------------------------------------

test('pruneStore mantiene la ola activa y descarta olas viejas (CA-12)', () => {
    const root = tmpRoot();
    const now = 1700000000000;
    const old = now - RETENTION_MS - 1000;  // más viejo que la retención
    const recent = now - 1000;              // dentro de la retención

    // Ola activa = 5. Líneas:
    //  - waveKey 5 viejo  → SE MANTIENE (es la ola activa, nunca se poda)
    //  - waveKey 3 viejo  → SE DESCARTA (ola no activa + viejo)
    //  - waveKey 3 reciente → SE MANTIENE (no activa pero reciente)
    fs.writeFileSync(storeFile(root), [
        JSON.stringify({ ts: old, waveKey: 5, avancePct: 10 }),
        JSON.stringify({ ts: old, waveKey: 3, avancePct: 90 }),
        JSON.stringify({ ts: recent, waveKey: 3, avancePct: 95 }),
    ].join('\n') + '\n');

    const res = waveProgress.pruneStore({ pipelineRoot: root, activeWaveKey: 5, now });
    assert.strictEqual(res.dropped, 1);

    const lines = readLines(root).map((l) => JSON.parse(l));
    assert.strictEqual(lines.length, 2);
    // La línea vieja de la ola 5 (activa) sobrevive.
    assert.ok(lines.some((r) => r.waveKey === 5 && r.ts === old));
    // La línea vieja de la ola 3 fue descartada; la reciente sobrevive.
    assert.ok(!lines.some((r) => r.waveKey === 3 && r.ts === old));
    assert.ok(lines.some((r) => r.waveKey === 3 && r.ts === recent));
});

test('pruneStore descarta líneas corruptas sin crashear (SEC-6)', () => {
    const root = tmpRoot();
    const now = 1700000000000;
    fs.writeFileSync(storeFile(root), [
        JSON.stringify({ ts: now, waveKey: 5, avancePct: 10 }),
        '{ esto no es json valido',
        '{"ts":123}',  // falta waveKey/avancePct
    ].join('\n') + '\n');

    const res = waveProgress.pruneStore({ pipelineRoot: root, activeWaveKey: 5, now });
    assert.strictEqual(res.dropped, 2);
    const lines = readLines(root);
    assert.strictEqual(lines.length, 1);
    assert.deepStrictEqual(JSON.parse(lines[0]), { ts: now, waveKey: 5, avancePct: 10 });
});

// -----------------------------------------------------------------------------
// readSnapshots — tolerancia y filtrado por waveKey
// -----------------------------------------------------------------------------

test('readSnapshots filtra por waveKey y descarta líneas inválidas (SEC-6)', () => {
    const root = tmpRoot();
    fs.writeFileSync(storeFile(root), [
        JSON.stringify({ ts: 3, waveKey: 4, avancePct: 30 }),
        JSON.stringify({ ts: 1, waveKey: 4, avancePct: 10 }),
        JSON.stringify({ ts: 2, waveKey: 9, avancePct: 50 }),
        'línea corrupta',
    ].join('\n') + '\n');

    const snaps = waveProgress.readSnapshots({ pipelineRoot: root, waveKey: 4 });
    // Ordenados por ts asc, solo waveKey 4.
    assert.deepStrictEqual(snaps, [
        { ts: 1, waveKey: 4, avancePct: 10 },
        { ts: 3, waveKey: 4, avancePct: 30 },
    ]);
});

test('readSnapshots devuelve [] si el archivo no existe', () => {
    const root = tmpRoot();
    assert.deepStrictEqual(waveProgress.readSnapshots({ pipelineRoot: root, waveKey: 4 }), []);
});

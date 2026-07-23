'use strict';

// Tests de la migración de índices stray → canónico (#4504, CA-4).
// Cubren: merge por clave `agente::fase` sin pérdida (caso 4502), move directo
// cuando no hay canónico, idempotencia, y borrado del dir stray.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { migrateStrayDeliverables } = require('./migrate-stray-deliverables');

function tmpRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'msd-test-'));
}

function writeIndex(dir, issue, entries) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
        path.join(dir, `${issue}.json`),
        JSON.stringify({ issue: Number(issue), entries }, null, 2),
        'utf8',
    );
}

function readIndex(dir, issue) {
    return JSON.parse(fs.readFileSync(path.join(dir, `${issue}.json`), 'utf8'));
}

test('CA-4 · merge de 4502 (existe en ambos) NO pierde la entry preexistente del canónico', () => {
    const root = tmpRoot();
    const strayDir = path.join(root, 'deliverables');
    const canonicalDir = path.join(root, '.pipeline', 'deliverables');

    // Canónico: guru/analisis. Stray: ux/criterios. Deben convivir tras el merge.
    writeIndex(canonicalDir, '4502', [
        { issue: 4502, fase: 'analisis', agente: 'guru', tipo: 'document', path: 'guru-analisis-4502.md', timestamp: 'T1' },
    ]);
    writeIndex(strayDir, '4502', [
        { issue: 4502, fase: 'criterios', agente: 'ux', tipo: 'document', path: 'ux-criterios-4502.md', timestamp: 'T2' },
    ]);

    const report = migrateStrayDeliverables({ repoRoot: root });
    assert.ok(report.merged.includes('4502.json'));

    const merged = readIndex(canonicalDir, '4502');
    assert.equal(merged.entries.length, 2, 'ambas fases deben convivir');
    const keys = merged.entries.map((e) => `${e.agente}::${e.fase}`).sort();
    assert.deepEqual(keys, ['guru::analisis', 'ux::criterios']);
});

test('CA-4 · conflicto de misma clave: gana la entry preexistente del canónico', () => {
    const root = tmpRoot();
    const strayDir = path.join(root, 'deliverables');
    const canonicalDir = path.join(root, '.pipeline', 'deliverables');

    writeIndex(canonicalDir, '4500', [
        { issue: 4500, fase: 'analisis', agente: 'guru', tipo: 'document', path: 'CANONICAL.md', timestamp: 'T1' },
    ]);
    writeIndex(strayDir, '4500', [
        { issue: 4500, fase: 'analisis', agente: 'guru', tipo: 'document', path: 'STRAY.md', timestamp: 'T2' },
    ]);

    migrateStrayDeliverables({ repoRoot: root });
    const merged = readIndex(canonicalDir, '4500');
    assert.equal(merged.entries.length, 1);
    assert.equal(merged.entries[0].path, 'CANONICAL.md', 'canonical preexistente no se pierde');
});

test('CA-4 · stray sin canónico se mueve directo', () => {
    const root = tmpRoot();
    const strayDir = path.join(root, 'deliverables');
    const canonicalDir = path.join(root, '.pipeline', 'deliverables');

    writeIndex(strayDir, '4492', [
        { issue: 4492, fase: 'analisis', agente: 'guru', tipo: 'document', path: 'guru-analisis-4492.md', timestamp: 'T1' },
    ]);

    const report = migrateStrayDeliverables({ repoRoot: root });
    assert.ok(report.moved.includes('4492.json'));
    assert.ok(fs.existsSync(path.join(canonicalDir, '4492.json')));
});

test('CA-4 · borra el dir stray y es idempotente (no genera nuevos strays)', () => {
    const root = tmpRoot();
    const strayDir = path.join(root, 'deliverables');

    writeIndex(strayDir, '4493', [
        { issue: 4493, fase: 'analisis', agente: 'guru', tipo: 'document', path: 'x.md', timestamp: 'T1' },
    ]);

    const r1 = migrateStrayDeliverables({ repoRoot: root });
    assert.equal(r1.removedStrayDir, true);
    assert.ok(!fs.existsSync(strayDir), 'el dir stray debe quedar eliminado');

    // Segunda corrida: no-op limpio (idempotente).
    const r2 = migrateStrayDeliverables({ repoRoot: root });
    assert.deepEqual(r2.moved, []);
    assert.deepEqual(r2.merged, []);
    assert.equal(r2.removedStrayDir, false);
    assert.ok(!fs.existsSync(strayDir));
});

test('CA-4 · sin dir stray no hace nada (idempotente desde cero)', () => {
    const root = tmpRoot();
    const report = migrateStrayDeliverables({ repoRoot: root });
    assert.deepEqual(report, { moved: [], merged: [], skipped: [], removedStrayDir: false });
});

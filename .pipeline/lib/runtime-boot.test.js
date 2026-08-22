'use strict';

// Tests de runtime-boot.js (#4460) — trust anchor del SHA vivo.
// node --test .pipeline/lib/runtime-boot.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const runtimeBoot = require('./runtime-boot');

// Crea un pipelineDir temporal aislado por test.
function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-boot-'));
}

test('round-trip: writeBootMarker luego readBootMarker devuelve el mismo sha', () => {
    const dir = tmpDir();
    const sha = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
    const w = runtimeBoot.writeBootMarker(sha, { pipelineDir: dir });
    assert.strictEqual(w.ok, true);
    assert.strictEqual(w.sha, sha);
    assert.ok(w.startedAt, 'startedAt presente');

    const r = runtimeBoot.readBootMarker({ pipelineDir: dir });
    assert.ok(r, 'marker legible');
    assert.strictEqual(r.sha, sha);
    assert.strictEqual(r.startedAt, w.startedAt);
});

test('acepta SHA short (7 chars)', () => {
    const dir = tmpDir();
    const w = runtimeBoot.writeBootMarker('abc1234', { pipelineDir: dir });
    assert.strictEqual(w.ok, true);
    const r = runtimeBoot.readBootMarker({ pipelineDir: dir });
    assert.strictEqual(r.sha, 'abc1234');
});

test('escritura atómica: no deja archivos .tmp tras el write', () => {
    const dir = tmpDir();
    runtimeBoot.writeBootMarker('deadbeef', { pipelineDir: dir });
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
    assert.deepStrictEqual(leftovers, [], 'sin archivos temporales huérfanos');
});

test('writeBootMarker rechaza sha no-hex sin escribir archivo', () => {
    const dir = tmpDir();
    const w = runtimeBoot.writeBootMarker('HEAD; rm -rf .', { pipelineDir: dir });
    assert.strictEqual(w.ok, false);
    assert.ok(!fs.existsSync(runtimeBoot._markerPath({ pipelineDir: dir })), 'no crea marker');
});

test('writeBootMarker rechaza no-string', () => {
    const dir = tmpDir();
    assert.strictEqual(runtimeBoot.writeBootMarker(null, { pipelineDir: dir }).ok, false);
    assert.strictEqual(runtimeBoot.writeBootMarker(12345, { pipelineDir: dir }).ok, false);
    assert.strictEqual(runtimeBoot.writeBootMarker('', { pipelineDir: dir }).ok, false);
});

test('readBootMarker devuelve null si el marker no existe', () => {
    const dir = tmpDir();
    assert.strictEqual(runtimeBoot.readBootMarker({ pipelineDir: dir }), null);
});

test('readBootMarker devuelve null ante JSON corrupto (no lanza)', () => {
    const dir = tmpDir();
    fs.writeFileSync(runtimeBoot._markerPath({ pipelineDir: dir }), '{ esto no es json ');
    assert.strictEqual(runtimeBoot.readBootMarker({ pipelineDir: dir }), null);
});

test('readBootMarker devuelve null ante sha no-hex tampereado', () => {
    const dir = tmpDir();
    fs.writeFileSync(
        runtimeBoot._markerPath({ pipelineDir: dir }),
        JSON.stringify({ sha: 'HEAD; rm -rf .', startedAt: '2026-01-01T00:00:00Z' })
    );
    assert.strictEqual(runtimeBoot.readBootMarker({ pipelineDir: dir }), null);
});

test('readBootMarker devuelve null ante sha ausente en el JSON', () => {
    const dir = tmpDir();
    fs.writeFileSync(
        runtimeBoot._markerPath({ pipelineDir: dir }),
        JSON.stringify({ startedAt: '2026-01-01T00:00:00Z' })
    );
    assert.strictEqual(runtimeBoot.readBootMarker({ pipelineDir: dir }), null);
});

// --- ensureBootMarker (boot de dashboard/pulpo) ---

test('ensureBootMarker: marker ausente → escribe el HEAD real', () => {
    const dir = tmpDir();
    const head = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
    const res = runtimeBoot.ensureBootMarker({ pipelineDir: dir, resolveHead: () => head });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.wrote, true);
    assert.strictEqual(runtimeBoot.readBootMarker({ pipelineDir: dir }).sha, head);
});

test('ensureBootMarker: marker al día → NO reescribe (wrote:false)', () => {
    const dir = tmpDir();
    const head = 'abc1234';
    runtimeBoot.writeBootMarker(head, { pipelineDir: dir });
    const res = runtimeBoot.ensureBootMarker({ pipelineDir: dir, resolveHead: () => head });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.wrote, false);
});

test('ensureBootMarker: marker stale → reescribe con el HEAD nuevo', () => {
    const dir = tmpDir();
    runtimeBoot.writeBootMarker('0000000', { pipelineDir: dir });
    const head = 'fedcba9';
    const res = runtimeBoot.ensureBootMarker({ pipelineDir: dir, resolveHead: () => head });
    assert.strictEqual(res.wrote, true);
    assert.strictEqual(runtimeBoot.readBootMarker({ pipelineDir: dir }).sha, head);
});

test('ensureBootMarker: HEAD no resoluble → {ok:false} sin lanzar', () => {
    const dir = tmpDir();
    const res = runtimeBoot.ensureBootMarker({ pipelineDir: dir, resolveHead: () => { throw new Error('no git'); } });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.wrote, false);
});

test('readBootMarker tolera startedAt ausente (devuelve null en ese campo)', () => {
    const dir = tmpDir();
    fs.writeFileSync(
        runtimeBoot._markerPath({ pipelineDir: dir }),
        JSON.stringify({ sha: 'abc1234' })
    );
    const r = runtimeBoot.readBootMarker({ pipelineDir: dir });
    assert.ok(r);
    assert.strictEqual(r.sha, 'abc1234');
    assert.strictEqual(r.startedAt, null);
});

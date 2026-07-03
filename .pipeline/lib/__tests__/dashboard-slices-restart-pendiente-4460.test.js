'use strict';

// Tests del restartPendienteSlice (#4460).
// node --test .pipeline/lib/__tests__/dashboard-slices-restart-pendiente-4460.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const slices = require('../dashboard-slices');
const runtimeBoot = require('../runtime-boot');
const drift = require('../operativo-drift');

// pipelineDir temporal que hace de "PIPELINE" para el marker.
function tmpPipelineDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'slice-restart-'));
}

test('_sanitizeRestartItem: no propaga paths ni SHAs, recorta longitudes', () => {
    const out = slices._sanitizeRestartItem({
        issue: 4460,
        componente: '../../etc/passwd dashboard',
        motivo: 'tocó dashboard ' + 'x'.repeat(500),
    });
    assert.strictEqual(out.issue, 4460);
    assert.ok(!out.componente.includes('/'), 'componente sin slashes');
    assert.ok(out.componente.length <= 40);
    assert.ok(out.motivo.length <= 120);
});

test('_sanitizeRestartItem: issue no-entero → null', () => {
    assert.strictEqual(slices._sanitizeRestartItem({ issue: 'x', componente: 'a', motivo: 'b' }).issue, null);
    assert.strictEqual(slices._sanitizeRestartItem({ issue: -3, componente: 'a', motivo: 'b' }).issue, null);
    assert.strictEqual(slices._sanitizeRestartItem(null), null);
});

test('_sanitizeRestartItem: componente vacío tras saneo → "pipeline"', () => {
    const out = slices._sanitizeRestartItem({ issue: 1, componente: '/////', motivo: '' });
    assert.strictEqual(out.componente, 'pipeline');
});

test('restartPendienteSlice: marker ausente → unknown:true (CA-8), nunca "sin pendientes"', () => {
    const dir = tmpPipelineDir();
    const res = slices.restartPendienteSlice({}, { PIPELINE: dir, ROOT: dir });
    assert.strictEqual(res.unknown, true);
    assert.deepStrictEqual(res.items, []);
});

test('restartPendienteSlice: marker corrupto → unknown:true', () => {
    const dir = tmpPipelineDir();
    fs.writeFileSync(path.join(dir, 'runtime-boot.json'), '{ corrupto');
    const res = slices.restartPendienteSlice({}, { PIPELINE: dir, ROOT: dir });
    assert.strictEqual(res.unknown, true);
});

test('restartPendienteSlice: marker con sha hex inalcanzable → unknown:true (no miente)', () => {
    drift._clearCache();
    const dir = tmpPipelineDir();
    // marker válido (hex) pero el repoRoot real no conoce ese sha → git falla →
    // detectPendingRestart devuelve unknown:true → el slice lo propaga.
    runtimeBoot.writeBootMarker('abcdef1234567890abcdef1234567890abcdef12', { pipelineDir: dir });
    const res = slices.restartPendienteSlice({}, { PIPELINE: dir, ROOT: dir });
    assert.strictEqual(res.unknown, true);
    assert.deepStrictEqual(res.items, []);
});

test('restartPendienteSlice: sin drift real (bootSHA=HEAD del repo) → items:[] + unknown:false (CA-2)', () => {
    drift._clearCache();
    const dir = tmpPipelineDir();
    // Usamos el repo real del proyecto como repoRoot. bootSHA = HEAD actual →
    // el rango HEAD..origin/main normalmente está vacío o sólo con commits que
    // no tocan operativo desde este HEAD. Para determinismo forzamos bootSHA a
    // origin/main mismo si existe; si no, aceptamos unknown (git no disponible).
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    let head;
    try {
        head = require('node:child_process')
            .execFileSync('git', ['rev-parse', 'origin/main'], { cwd: repoRoot, encoding: 'utf8' })
            .trim();
    } catch {
        // git no disponible en este entorno → el test de rango vacío no aplica.
        return;
    }
    runtimeBoot.writeBootMarker(head, { pipelineDir: dir });
    const res = slices.restartPendienteSlice({}, { PIPELINE: dir, ROOT: repoRoot });
    // bootSHA == origin/main → rango vacío → sin drift, botón NO se renderiza.
    assert.strictEqual(res.unknown, false);
    assert.deepStrictEqual(res.items, []);
});

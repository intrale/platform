// =============================================================================
// wave-resolver.test.js — Tests del resolver de ola activa (#3262).
//
// Cubre la cascada de fuentes:
//   1. active-wave.json (preferido)
//   2. .partial-pause.json (fallback)
//   3. filesystem scan (último recurso, CA-15 fallback grácil)
//
// Ejecutar:  node --test .pipeline/lib/__tests__/wave-resolver.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveActiveWave } = require('../wave-resolver');

function mkTmpPipeline() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-resolver-'));
    // Estructura mínima esperada por el fallback FS.
    for (const pipeline of ['definicion', 'desarrollo']) {
        for (const phase of ['analisis', 'dev', 'verificacion']) {
            for (const state of ['pendiente', 'trabajando', 'listo', 'procesado']) {
                fs.mkdirSync(path.join(dir, pipeline, phase, state), { recursive: true });
            }
        }
    }
    return dir;
}

function rmrf(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

test('resolveActiveWave: prioriza active-wave.json sobre partial-pause', () => {
    const dir = mkTmpPipeline();
    try {
        fs.writeFileSync(path.join(dir, 'active-wave.json'), JSON.stringify({
            label: 'N+5',
            issues: [3253, 3257, 3262],
            opened_at: '2026-05-16T23:48:00Z',
        }));
        fs.writeFileSync(path.join(dir, '.partial-pause.json'), JSON.stringify({
            allowed_issues: [9999], // Si gana, falla el assert.
            created_at: '2026-05-16T20:00:00Z',
        }));
        const r = resolveActiveWave({ pipelineRoot: dir });
        assert.equal(r.source, 'active-wave.json');
        assert.equal(r.label, 'N+5');
        assert.deepEqual(r.issues, [3253, 3257, 3262]);
        assert.equal(r.resolved, true);
    } finally { rmrf(dir); }
});

test('resolveActiveWave: cae a partial-pause cuando no hay active-wave.json', () => {
    const dir = mkTmpPipeline();
    try {
        fs.writeFileSync(path.join(dir, '.partial-pause.json'), JSON.stringify({
            allowed_issues: [3253, 3257, '3262', '#3260'],
            created_at: '2026-05-16T20:00:00Z',
            source: 'telegram',
        }));
        const r = resolveActiveWave({ pipelineRoot: dir });
        assert.equal(r.source, 'partial-pause.json');
        assert.equal(r.label, 'Ola actual');
        // Normaliza strings/leading # y deduplica.
        assert.deepEqual(r.issues, [3253, 3257, 3260, 3262]);
        assert.equal(r.resolved, true);
        assert.equal(r.openedAt, '2026-05-16T20:00:00Z');
    } finally { rmrf(dir); }
});

test('resolveActiveWave: fallback FS cuando no hay ningún marker', () => {
    const dir = mkTmpPipeline();
    try {
        // Sin marker files. Creamos archivos de pipeline activos.
        fs.writeFileSync(path.join(dir, 'desarrollo/dev/trabajando/3262.pipeline-dev'), '');
        fs.writeFileSync(path.join(dir, 'desarrollo/dev/pendiente/3253.android-dev'), '');
        fs.writeFileSync(path.join(dir, 'definicion/analisis/listo/3260.guru'), '');
        const r = resolveActiveWave({ pipelineRoot: dir });
        assert.equal(r.source, 'fs-fallback');
        assert.equal(r.label, 'Ola actual (sin label)');
        assert.deepEqual(r.issues, [3253, 3260, 3262]);
        assert.equal(r.resolved, true);
    } finally { rmrf(dir); }
});

test('resolveActiveWave: degrada a issues:[] cuando no hay nada', () => {
    const dir = mkTmpPipeline();
    try {
        const r = resolveActiveWave({ pipelineRoot: dir });
        assert.equal(r.source, 'fs-fallback');
        assert.deepEqual(r.issues, []);
        assert.equal(r.resolved, false);
    } finally { rmrf(dir); }
});

test('resolveActiveWave: ignora active-wave.json mal formado y sigue cascada', () => {
    const dir = mkTmpPipeline();
    try {
        fs.writeFileSync(path.join(dir, 'active-wave.json'), '{not-json,');
        fs.writeFileSync(path.join(dir, '.partial-pause.json'), JSON.stringify({
            allowed_issues: [9999],
            created_at: 'x',
        }));
        const r = resolveActiveWave({ pipelineRoot: dir });
        assert.equal(r.source, 'partial-pause.json');
        assert.deepEqual(r.issues, [9999]);
    } finally { rmrf(dir); }
});

test('resolveActiveWave: active-wave.json sin label o sin issues se descarta', () => {
    const dir = mkTmpPipeline();
    try {
        // Sin label → inválido.
        fs.writeFileSync(path.join(dir, 'active-wave.json'), JSON.stringify({ issues: [1, 2] }));
        // Y sin partial-pause → cae a FS fallback.
        const r = resolveActiveWave({ pipelineRoot: dir });
        assert.equal(r.source, 'fs-fallback');
    } finally { rmrf(dir); }
});

test('resolveActiveWave: tolera ausencia de directorios de pipeline', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-resolver-empty-'));
    try {
        const r = resolveActiveWave({ pipelineRoot: dir });
        assert.equal(r.source, 'fs-fallback');
        assert.deepEqual(r.issues, []);
    } finally { rmrf(dir); }
});

test('resolveActiveWave: sin pipelineRoot devuelve resultado seguro', () => {
    const r = resolveActiveWave({});
    assert.equal(r.resolved, false);
    assert.deepEqual(r.issues, []);
});

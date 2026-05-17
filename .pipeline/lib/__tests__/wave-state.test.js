// =============================================================================
// wave-state.test.js — Tests del builder de state para el snapshot (#3262).
//
// El builder replica el subset de getPipelineState() de dashboard.js que el
// snapshot necesita, sin pagar el side effect de arrancar HTTP server.
//
// Ejecutar:  node --test .pipeline/lib/__tests__/wave-state.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildWaveState, getCachedWaveState, clearCache, ALL_FASES } = require('../wave-state');

function mkTmpPipeline() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-state-'));
    for (const { pipeline, fase } of ALL_FASES) {
        for (const state of ['pendiente', 'trabajando', 'listo', 'procesado']) {
            fs.mkdirSync(path.join(dir, pipeline, fase, state), { recursive: true });
        }
    }
    return dir;
}

function rmrf(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }

test('buildWaveState: arma issueMatrix con faseActual y estadoActual', () => {
    const dir = mkTmpPipeline();
    try {
        fs.writeFileSync(path.join(dir, 'desarrollo/dev/trabajando/3262.pipeline-dev'), 'issue: 3262');
        const s = buildWaveState({ pipelineRoot: dir });
        const data = s.issueMatrix['3262'];
        assert.ok(data, 'issue 3262 debe estar en la matriz');
        assert.equal(data.faseActual, 'desarrollo/dev');
        assert.equal(data.estadoActual, 'trabajando');
        assert.equal(data.fases['desarrollo/dev'].length, 1);
        assert.equal(data.fases['desarrollo/dev'][0].skill, 'pipeline-dev');
    } finally { rmrf(dir); }
});

test('buildWaveState: enriquecimiento con .issue-title-cache.json', () => {
    const dir = mkTmpPipeline();
    try {
        fs.writeFileSync(path.join(dir, 'desarrollo/dev/trabajando/3262.pipeline-dev'), '');
        fs.writeFileSync(path.join(dir, '.issue-title-cache.json'), JSON.stringify({
            '3262': { title: 'Hello world', labels: ['Ready', 'enhancement'] },
        }));
        const s = buildWaveState({ pipelineRoot: dir });
        assert.equal(s.issueMatrix['3262'].title, 'Hello world');
        assert.deepEqual(s.issueMatrix['3262'].labels, ['Ready', 'enhancement']);
    } finally { rmrf(dir); }
});

test('buildWaveState: prioriza estado trabajando sobre pendiente para faseActual', () => {
    const dir = mkTmpPipeline();
    try {
        fs.writeFileSync(path.join(dir, 'desarrollo/dev/trabajando/100.android-dev'), '');
        fs.writeFileSync(path.join(dir, 'desarrollo/build/pendiente/100.build'), '');
        const s = buildWaveState({ pipelineRoot: dir });
        assert.equal(s.issueMatrix['100'].estadoActual, 'trabajando');
        assert.equal(s.issueMatrix['100'].faseActual, 'desarrollo/dev');
    } finally { rmrf(dir); }
});

test('buildWaveState: ignora archivos artefacto (.reason.json, .guidance.txt)', () => {
    const dir = mkTmpPipeline();
    try {
        fs.writeFileSync(path.join(dir, 'desarrollo/dev/trabajando/100.android-dev.reason.json'), '{}');
        fs.writeFileSync(path.join(dir, 'desarrollo/dev/trabajando/100.android-dev.guidance.txt'), 'guidance');
        const s = buildWaveState({ pipelineRoot: dir });
        assert.equal(s.issueMatrix['100'], undefined);
    } finally { rmrf(dir); }
});

test('buildWaveState: etaAverages aproximados desde mtime/ctime de procesado', () => {
    const dir = mkTmpPipeline();
    try {
        // No podemos forzar birthtime/ctime reliable cross-OS — confirmamos
        // que la estructura existe y es consultable.
        fs.writeFileSync(path.join(dir, 'desarrollo/dev/procesado/100.android-dev'), '');
        const s = buildWaveState({ pipelineRoot: dir });
        assert.ok(typeof s.etaAverages === 'object');
        assert.ok(Array.isArray(s.allFases));
    } finally { rmrf(dir); }
});

test('buildWaveState: tolera ausencia de directorios sin throw', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-state-empty-'));
    try {
        const s = buildWaveState({ pipelineRoot: dir });
        assert.deepEqual(s.issueMatrix, {});
        assert.deepEqual(s.etaAverages, {});
    } finally { rmrf(dir); }
});

test('getCachedWaveState: re-usa cache dentro del TTL', () => {
    const dir = mkTmpPipeline();
    try {
        clearCache();
        fs.writeFileSync(path.join(dir, 'desarrollo/dev/trabajando/100.skill-a'), '');
        const s1 = getCachedWaveState({ pipelineRoot: dir });
        // Modificar después — el cache debe seguir devolviendo lo anterior.
        fs.writeFileSync(path.join(dir, 'desarrollo/dev/trabajando/200.skill-b'), '');
        const s2 = getCachedWaveState({ pipelineRoot: dir });
        assert.equal(Object.keys(s2.issueMatrix).length, 1, 'cache hit no debería ver el nuevo archivo');
        assert.strictEqual(s1, s2);
    } finally { rmrf(dir); clearCache(); }
});

test('getCachedWaveState: sin pipelineRoot retorna state directo', () => {
    const s = getCachedWaveState({});
    assert.deepEqual(s.issueMatrix, {});
});

test('buildWaveState: incluye issueTitles para que snapshot pueda enriquecer issues sin matriz', () => {
    const dir = mkTmpPipeline();
    try {
        fs.writeFileSync(path.join(dir, '.issue-title-cache.json'), JSON.stringify({
            '9999': { title: 'No matrix', labels: ['needs-human'] },
        }));
        const s = buildWaveState({ pipelineRoot: dir });
        assert.ok(s.issueTitles, 'issueTitles debe estar expuesto');
        assert.equal(s.issueTitles['9999'].title, 'No matrix');
    } finally { rmrf(dir); }
});

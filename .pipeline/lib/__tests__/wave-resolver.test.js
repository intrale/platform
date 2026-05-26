// =============================================================================
// wave-resolver.test.js — Tests del resolver de ola activa.
//
// Cubre la cascada de fuentes post-#3502:
//   1. waves.json (vía `lib/waves.js`, source-of-truth canónica)
//   2. .partial-pause.json (legacy, mientras waves.json no esté poblado)
//   3. filesystem scan (último recurso, CA-15 fallback grácil)
//
// Adicionalmente cubre el normalizador defensivo (CA-4) que tolera AMBOS
// shapes de issues que aparecen en el wild:
//   - { number: N }  ← shape canónico que `lib/waves.js` declara.
//   - N              ← shape "flat" del waves.json real en disco.
//
// Ejecutar:  node --test .pipeline/lib/__tests__/wave-resolver.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveActiveWave, _internal } = require('../wave-resolver');
const waves = require('../waves');

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

function writeWavesJson(dir, active_wave, extra = {}) {
    const state = {
        version: '1.0',
        meta: {
            created_at: '2026-05-01T00:00:00Z',
            updated_at: '2026-05-01T00:00:00Z',
            updated_by: 'test',
            source: 'manual',
            note: 'fixture',
        },
        active_wave,
        planned_waves: [],
        archived_waves: [],
        dependencies: [],
        ...extra,
    };
    fs.writeFileSync(path.join(dir, 'waves.json'), JSON.stringify(state, null, 2));
}

// Invalida la cache de waves.js entre tests para evitar que un test arrastre
// estado al siguiente — el resolver hace invalidate post-call, pero validamos
// también acá por defensa en profundidad.
function resetCache() {
    waves.invalidateCache();
}

// -----------------------------------------------------------------------------
// CA-1 — waves.json es source-of-truth primario
// -----------------------------------------------------------------------------

test('resolveActiveWave: usa waves.json como fuente primaria (CA-1)', () => {
    const dir = mkTmpPipeline();
    try {
        writeWavesJson(dir, {
            number: 5,
            name: 'N+5',
            started_at: '2026-05-16T23:48:00Z',
            issues: [
                { number: 3253 },
                { number: 3257 },
                { number: 3262 },
            ],
        });
        // Aunque exista partial-pause con datos distintos, waves.json debe ganar.
        fs.writeFileSync(path.join(dir, '.partial-pause.json'), JSON.stringify({
            allowed_issues: [9999],
            created_at: '2026-05-16T20:00:00Z',
        }));
        const r = resolveActiveWave({ pipelineRoot: dir });
        assert.equal(r.source, 'waves.json');
        assert.equal(r.label, 'N+5');
        assert.deepEqual(r.issues, [3253, 3257, 3262]);
        assert.equal(r.openedAt, '2026-05-16T23:48:00Z');
        assert.equal(r.resolved, true);
    } finally { resetCache(); rmrf(dir); }
});

test('resolveActiveWave: label cae a "Ola N" si name está ausente', () => {
    const dir = mkTmpPipeline();
    try {
        writeWavesJson(dir, {
            number: 7,
            started_at: '2026-05-20T00:00:00Z',
            issues: [{ number: 3500 }],
        });
        const r = resolveActiveWave({ pipelineRoot: dir });
        assert.equal(r.source, 'waves.json');
        assert.equal(r.label, 'Ola 7');
        assert.deepEqual(r.issues, [3500]);
    } finally { resetCache(); rmrf(dir); }
});

// -----------------------------------------------------------------------------
// CA-4 — Normalizador defensivo (schema drift)
// -----------------------------------------------------------------------------

test('resolveActiveWave: tolera issues como int planos (CA-4 schema drift)', () => {
    // Reproduce el shape REAL de .pipeline/waves.json hoy en disco (issues como
    // enteros planos, key `id` en vez de `number`). Sin el normalizador
    // defensivo el resolver degradaría silenciosamente al fallback con NaN.
    const dir = mkTmpPipeline();
    try {
        writeWavesJson(dir, {
            id: 'N+10',
            name: 'N+10',
            started_at: '2026-05-22T00:00:00Z',
            issues: [3501, 3502, 3503, 3504],
        });
        const r = resolveActiveWave({ pipelineRoot: dir });
        assert.equal(r.source, 'waves.json');
        assert.deepEqual(r.issues, [3501, 3502, 3503, 3504]);
        assert.equal(r.resolved, true);
    } finally { resetCache(); rmrf(dir); }
});

test('resolveActiveWave: tolera mix de shapes (objetos y enteros) y strings con #', () => {
    const dir = mkTmpPipeline();
    try {
        writeWavesJson(dir, {
            number: 8,
            name: 'Mix',
            issues: [
                { number: 3100 },
                3200,
                '3300',
                '#3400',
            ],
        });
        const r = resolveActiveWave({ pipelineRoot: dir });
        assert.equal(r.source, 'waves.json');
        assert.deepEqual(r.issues, [3100, 3200, 3300, 3400]);
    } finally { resetCache(); rmrf(dir); }
});

test('normalizeIssueNumber: cubre los shapes esperados y rechaza inválidos', () => {
    const { normalizeIssueNumber } = _internal;
    // Válidos
    assert.equal(normalizeIssueNumber(3501), 3501);
    assert.equal(normalizeIssueNumber('3501'), 3501);
    assert.equal(normalizeIssueNumber(' #3501 '), 3501);
    assert.equal(normalizeIssueNumber({ number: 3501 }), 3501);
    assert.equal(normalizeIssueNumber({ number: '3501' }), 3501);
    // Inválidos → null
    assert.equal(normalizeIssueNumber(null), null);
    assert.equal(normalizeIssueNumber(undefined), null);
    assert.equal(normalizeIssueNumber(''), null);
    assert.equal(normalizeIssueNumber('abc'), null);
    assert.equal(normalizeIssueNumber(-1), null);
    assert.equal(normalizeIssueNumber(0), null);
    assert.equal(normalizeIssueNumber({ number: 'abc' }), null);
    assert.equal(normalizeIssueNumber({}), null);
});

// -----------------------------------------------------------------------------
// CA-2 — Fallback a partial-pause cuando waves.json está vacío
// -----------------------------------------------------------------------------

test('resolveActiveWave: cae a partial-pause cuando waves.json tiene active_wave=null (CA-2)', () => {
    const dir = mkTmpPipeline();
    try {
        writeWavesJson(dir, null);
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
    } finally { resetCache(); rmrf(dir); }
});

test('resolveActiveWave: cae a partial-pause cuando waves.json no existe', () => {
    const dir = mkTmpPipeline();
    try {
        // Sin waves.json en disco.
        fs.writeFileSync(path.join(dir, '.partial-pause.json'), JSON.stringify({
            allowed_issues: [4001, 4002],
            created_at: '2026-05-26T00:00:00Z',
        }));
        const r = resolveActiveWave({ pipelineRoot: dir });
        assert.equal(r.source, 'partial-pause.json');
        assert.deepEqual(r.issues, [4001, 4002]);
    } finally { resetCache(); rmrf(dir); }
});

test('resolveActiveWave: cae a partial-pause cuando waves.json tiene issues:[]', () => {
    const dir = mkTmpPipeline();
    try {
        writeWavesJson(dir, {
            number: 5,
            name: 'Vacía',
            issues: [],
        });
        fs.writeFileSync(path.join(dir, '.partial-pause.json'), JSON.stringify({
            allowed_issues: [5001],
            created_at: 'x',
        }));
        const r = resolveActiveWave({ pipelineRoot: dir });
        assert.equal(r.source, 'partial-pause.json');
        assert.deepEqual(r.issues, [5001]);
    } finally { resetCache(); rmrf(dir); }
});

// -----------------------------------------------------------------------------
// CA-3 — Fallback FS cuando no hay waves.json activa ni partial-pause
// -----------------------------------------------------------------------------

test('resolveActiveWave: fallback FS cuando no hay ningún marker (CA-3)', () => {
    const dir = mkTmpPipeline();
    try {
        // Sin waves.json, sin partial-pause. Creamos archivos de pipeline activos.
        fs.writeFileSync(path.join(dir, 'desarrollo/dev/trabajando/3262.pipeline-dev'), '');
        fs.writeFileSync(path.join(dir, 'desarrollo/dev/pendiente/3253.android-dev'), '');
        fs.writeFileSync(path.join(dir, 'definicion/analisis/listo/3260.guru'), '');
        const r = resolveActiveWave({ pipelineRoot: dir });
        assert.equal(r.source, 'fs-fallback');
        assert.equal(r.label, 'Ola actual (sin label)');
        assert.deepEqual(r.issues, [3253, 3260, 3262]);
        assert.equal(r.resolved, true);
    } finally { resetCache(); rmrf(dir); }
});

test('resolveActiveWave: degrada a issues:[] cuando no hay nada', () => {
    const dir = mkTmpPipeline();
    try {
        const r = resolveActiveWave({ pipelineRoot: dir });
        assert.equal(r.source, 'fs-fallback');
        assert.deepEqual(r.issues, []);
        assert.equal(r.resolved, false);
    } finally { resetCache(); rmrf(dir); }
});

// -----------------------------------------------------------------------------
// Robustez frente a entrada corrupta
// -----------------------------------------------------------------------------

test('resolveActiveWave: ignora waves.json mal formado y sigue cascada', () => {
    const dir = mkTmpPipeline();
    try {
        fs.writeFileSync(path.join(dir, 'waves.json'), '{not-json,');
        fs.writeFileSync(path.join(dir, '.partial-pause.json'), JSON.stringify({
            allowed_issues: [9999],
            created_at: 'x',
        }));
        const r = resolveActiveWave({ pipelineRoot: dir });
        assert.equal(r.source, 'partial-pause.json');
        assert.deepEqual(r.issues, [9999]);
    } finally { resetCache(); rmrf(dir); }
});

test('resolveActiveWave: tolera ausencia de directorios de pipeline', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-resolver-empty-'));
    try {
        const r = resolveActiveWave({ pipelineRoot: dir });
        assert.equal(r.source, 'fs-fallback');
        assert.deepEqual(r.issues, []);
    } finally { resetCache(); rmrf(dir); }
});

test('resolveActiveWave: sin pipelineRoot devuelve resultado seguro', () => {
    const r = resolveActiveWave({});
    assert.equal(r.resolved, false);
    assert.deepEqual(r.issues, []);
    assert.equal(r.source, 'fs-fallback');
});

// -----------------------------------------------------------------------------
// CA-5 — `readActiveWaveFile` eliminada
// -----------------------------------------------------------------------------

test('CA-5: readActiveWaveFile fue eliminada del módulo', () => {
    // El módulo legacy exportaba `_internal.readActiveWaveFile`. Post-#3502
    // esa función no debe existir más.
    assert.equal(typeof _internal.readActiveWaveFile, 'undefined');
    // Y readFromWavesJson debe existir como su reemplazo.
    assert.equal(typeof _internal.readFromWavesJson, 'function');
});

// -----------------------------------------------------------------------------
// CA-6 — Shape externo preservado para backward compat
// -----------------------------------------------------------------------------

test('CA-6: shape externo { label, issues, openedAt, source, resolved } preservado', () => {
    const dir = mkTmpPipeline();
    try {
        writeWavesJson(dir, {
            number: 9,
            name: 'N+9',
            started_at: '2026-05-20T00:00:00Z',
            issues: [{ number: 3500 }],
        });
        const r = resolveActiveWave({ pipelineRoot: dir });
        // Estas son las 5 keys que wave-snapshot.js y wave-renderer.js consumen.
        assert.ok('label' in r);
        assert.ok('issues' in r);
        assert.ok('openedAt' in r);
        assert.ok('source' in r);
        assert.ok('resolved' in r);
        assert.equal(typeof r.label, 'string');
        assert.ok(Array.isArray(r.issues));
        assert.equal(typeof r.resolved, 'boolean');
    } finally { resetCache(); rmrf(dir); }
});

// =============================================================================
// Tests deliverable-index.js — upsertDeliverableException (#4507)
//
// Cubre CA-3 / CA-5 del issue:
//   - Valida enums (issue ^\d+$, fase enum cerrado, agente en SKILL_SOURCES).
//   - Redacta el motivo (secrets + emails) antes de persistir (SEC-1).
//   - Trunca el motivo a 2048 chars con marcador visible (SEC-2).
//   - Persiste tipo:"exception", path:null, bytes:0.
//   - Upsert idempotente por clave `agente::fase` (último write por fase) y
//     convivencia con entries físicas de `upsertDeliverableIndex`.
//
// Estrategia: pipelineRoot temporal con fs.mkdtempSync; `phaseEnum` inyectado
// para no depender de config.yaml ni del cache por proceso.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const di = require('../deliverable-index');

const PHASE_ENUM = ['dev', 'analisis', 'criterios'];

function mkTmpRoot() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'deliverable-index-test-'));
    // `pipelineRoot` del índice = el dir `.pipeline` (contrato de deliverable-index,
    // #4507). En producción pulpo pasa `PIPELINE` (= dir `.pipeline`) a
    // `upsertDeliverableException`. `resolvePipelineDir` normaliza tolerante
    // repo-root → `.pipeline`, así que apuntar el root del test directo al dir
    // `.pipeline` es idempotente y modela el callsite real.
    const dir = path.join(base, '.pipeline');
    fs.mkdirSync(dir, { recursive: true });
    return {
        root: dir,
        cleanup: () => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} },
    };
}

function readIndex(root, issue) {
    const file = path.join(root, 'deliverables', `${issue}.json`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// -----------------------------------------------------------------------------
// Validación de enums
// -----------------------------------------------------------------------------

test('upsertDeliverableException rechaza issue no ^\\d+$', () => {
    assert.throws(() => di.upsertDeliverableException({
        issue: '12a', fase: 'dev', agente: 'android-dev', motivo: 'x',
        phaseEnum: PHASE_ENUM,
    }), /issue inválido/);
});

test('upsertDeliverableException rechaza fase fuera del enum cerrado', () => {
    assert.throws(() => di.upsertDeliverableException({
        issue: '4507', fase: 'fase-inexistente', agente: 'android-dev', motivo: 'x',
        phaseEnum: PHASE_ENUM,
    }), /fase fuera del enum/);
});

test('upsertDeliverableException rechaza agente sin perfil en SKILL_SOURCES', () => {
    assert.throws(() => di.upsertDeliverableException({
        issue: '4507', fase: 'dev', agente: 'agente-fantasma', motivo: 'x',
        phaseEnum: PHASE_ENUM,
    }), /agente sin perfil/);
});

test('upsertDeliverableException rechaza motivo vacío', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        assert.throws(() => di.upsertDeliverableException({
            issue: '4507', fase: 'dev', agente: 'android-dev', motivo: '   ',
            pipelineRoot: root, phaseEnum: PHASE_ENUM,
        }), /motivo/);
    } finally { cleanup(); }
});

// -----------------------------------------------------------------------------
// Persistencia: forma de la entry
// -----------------------------------------------------------------------------

test('upsertDeliverableException persiste tipo:"exception", path:null, bytes:0', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const rec = di.upsertDeliverableException({
            issue: '4507', fase: 'dev', agente: 'android-dev',
            motivo: 'Issue de solo-docs, sin cambios de código de app.',
            timestamp: '2026-07-06T00:00:00.000Z',
            pipelineRoot: root, phaseEnum: PHASE_ENUM,
        });
        assert.equal(rec.tipo, 'exception');
        // Schema #4524: la excepción NO lleva key `path` (antes se persistía
        // `path:null`). El motivo canónico vive en `motivo_no_aplica`.
        assert.ok(!('path' in rec), 'la excepción no lleva key path');
        assert.equal(rec.motivo_no_aplica, 'Issue de solo-docs, sin cambios de código de app.');
        assert.equal(rec.bytes, 0);
        assert.equal(rec.agente, 'android-dev');
        assert.equal(rec.fase, 'dev');
        assert.equal(rec.issue, 4507);

        const idx = readIndex(root, 4507);
        assert.equal(idx.entries.length, 1);
        assert.equal(idx.entries[0].tipo, 'exception');
        assert.ok(!('path' in idx.entries[0]), 'la entry persistida no lleva key path');
    } finally { cleanup(); }
});

// -----------------------------------------------------------------------------
// SEC-1 — redacción del motivo
// -----------------------------------------------------------------------------

test('upsertDeliverableException redacta secrets y emails del motivo', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const rec = di.upsertDeliverableException({
            issue: '4507', fase: 'dev', agente: 'android-dev',
            motivo: 'Contacto leito.larreta@gmail.com y key AKIAIOSFODNN7EXAMPLE en el motivo',
            pipelineRoot: root, phaseEnum: PHASE_ENUM,
        });
        assert.doesNotMatch(rec.motivo, /AKIAIOSFODNN7EXAMPLE/);
        assert.doesNotMatch(rec.motivo, /leito\.larreta@gmail\.com/);
        assert.match(rec.motivo, /\[REDACTED\]/);
    } finally { cleanup(); }
});

// -----------------------------------------------------------------------------
// SEC-2 — truncado a 2048 con marcador
// -----------------------------------------------------------------------------

test('upsertDeliverableException trunca motivo largo a 2048 chars con marcador', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const largo = 'a'.repeat(5000);
        const rec = di.upsertDeliverableException({
            issue: '4507', fase: 'dev', agente: 'android-dev',
            motivo: largo, pipelineRoot: root, phaseEnum: PHASE_ENUM,
        });
        // Doble salvaguarda (#4524): `upsertDeliverableIndex` capa SIEMPRE el
        // motivo de la excepción con `capMotivo` a MOTIVO_MAX_CHARS (marcador `…`
        // en límite de palabra), aun después del truncado previo. El invariante
        // es que nunca supere el máximo y conserve el prefijo del motivo.
        assert.ok(rec.motivo.length <= di.MOTIVO_MAX_CHARS, `capado: ${rec.motivo.length}`);
        assert.ok(rec.motivo_no_aplica.length <= di.MOTIVO_MAX_CHARS, `canónico capado: ${rec.motivo_no_aplica.length}`);
        assert.ok(rec.motivo.startsWith('a'.repeat(2000)), 'conserva el prefijo del motivo');
        assert.ok(rec.motivo.length < largo.length, 'fue truncado respecto del original');
    } finally { cleanup(); }
});

test('upsertDeliverableException NO trunca motivo corto', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const rec = di.upsertDeliverableException({
            issue: '4507', fase: 'dev', agente: 'android-dev',
            motivo: 'Motivo breve', pipelineRoot: root, phaseEnum: PHASE_ENUM,
        });
        assert.equal(rec.motivo, 'Motivo breve');
        assert.doesNotMatch(rec.motivo, /truncado/);
    } finally { cleanup(); }
});

// -----------------------------------------------------------------------------
// Upsert idempotente por agente::fase
// -----------------------------------------------------------------------------

test('upsertDeliverableException: segundo write misma fase pisa al anterior', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        di.upsertDeliverableException({
            issue: '4507', fase: 'dev', agente: 'android-dev',
            motivo: 'Primer motivo', pipelineRoot: root, phaseEnum: PHASE_ENUM,
        });
        di.upsertDeliverableException({
            issue: '4507', fase: 'dev', agente: 'android-dev',
            motivo: 'Segundo motivo', pipelineRoot: root, phaseEnum: PHASE_ENUM,
        });
        const idx = readIndex(root, 4507);
        assert.equal(idx.entries.length, 1);
        assert.equal(idx.entries[0].motivo, 'Segundo motivo');
    } finally { cleanup(); }
});

test('upsertDeliverableException convive con una entry física del mismo agente en otra fase', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        di.upsertDeliverableIndex({
            issue: '4507', fase: 'analisis', agente: 'android-dev',
            tipo: 'document', path: '.pipeline/assets/docs/4507/android-dev-analisis-4507.md',
            bytes: 100, timestamp: '2026-07-06T00:00:00.000Z',
            pipelineRoot: root, phaseEnum: PHASE_ENUM,
        });
        di.upsertDeliverableException({
            issue: '4507', fase: 'dev', agente: 'android-dev',
            motivo: 'No aplica en dev', pipelineRoot: root, phaseEnum: PHASE_ENUM,
        });
        const idx = readIndex(root, 4507);
        assert.equal(idx.entries.length, 2);
        const dev = idx.entries.find((e) => e.fase === 'dev');
        const ana = idx.entries.find((e) => e.fase === 'analisis');
        assert.equal(dev.tipo, 'exception');
        assert.ok(!('path' in dev), 'la excepción no lleva key path');
        assert.equal(ana.tipo, 'document');
        assert.equal(typeof ana.path, 'string');
    } finally { cleanup(); }
});

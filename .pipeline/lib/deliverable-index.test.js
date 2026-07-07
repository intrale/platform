'use strict';

// Tests del índice de entregables por issue (#4255).
// Cubren: upsert por clave skill+fase, último-write-gana, convivencia multi-fase
// del mismo agente, enum cerrado de fase (SEC-2), issue `^\d+$` (CA-5), enum de
// agente (SEC-2), flag `sensible` (SEC-1), y las consultas queryByPhase/Agent.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const idx = require('./deliverable-index');
const {
    upsertDeliverableIndex,
    upsertException,
    readDeliverableIndex,
    queryByPhase,
    queryByAgent,
    validatePhase,
    validateAgent,
    validateIssueId,
    FALLBACK_PHASES,
} = idx;

// Root temporal aislado por corrida — no toca el FS real del pipeline.
function tmpRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'di-test-'));
}

const TS = '2026-07-01T10:00:00.000Z';

// -----------------------------------------------------------------------------
// upsert: crea entry por skill+fase
// -----------------------------------------------------------------------------

test('upsert crea entry por skill+fase y la persiste', () => {
    const root = tmpRoot();
    const rec = upsertDeliverableIndex({
        issue: '4255', fase: 'criterios', agente: 'po', tipo: 'document',
        path: '.pipeline/assets/docs/4255/po-criterios-4255.md', bytes: 42,
        timestamp: TS, pipelineRoot: root,
    });
    assert.equal(rec.issue, 4255);
    assert.equal(rec.fase, 'criterios');
    assert.equal(rec.agente, 'po');
    assert.equal(rec.sensible, false);

    const read = readDeliverableIndex('4255', { pipelineRoot: root });
    assert.equal(read.issue, 4255);
    assert.equal(read.entries.length, 1);
    assert.equal(read.entries[0].fase, 'criterios');
    // El archivo existe en el path esperado.
    const file = idx.indexPathFor('4255', { pipelineRoot: root });
    assert.ok(fs.existsSync(file), file);
});

// -----------------------------------------------------------------------------
// último-write-gana por misma fase
// -----------------------------------------------------------------------------

test('segundo write de la misma fase sobrescribe (último gana)', () => {
    const root = tmpRoot();
    upsertDeliverableIndex({
        issue: '10', fase: 'dev', agente: 'pipeline-dev', tipo: 'document',
        path: 'a.md', bytes: 1, timestamp: TS, pipelineRoot: root,
    });
    upsertDeliverableIndex({
        issue: '10', fase: 'dev', agente: 'pipeline-dev', tipo: 'document',
        path: 'b.md', bytes: 2, timestamp: TS, pipelineRoot: root,
    });
    const read = readDeliverableIndex('10', { pipelineRoot: root });
    assert.equal(read.entries.length, 1, 'no debe duplicar la misma fase');
    assert.equal(read.entries[0].path, 'b.md');
    assert.equal(read.entries[0].bytes, 2);
});

// -----------------------------------------------------------------------------
// convivencia multi-fase del mismo agente (PO Definición + Aprobación)
// -----------------------------------------------------------------------------

test('dos fases del mismo agente NO colisionan (PO criterios + aprobacion)', () => {
    const root = tmpRoot();
    upsertDeliverableIndex({
        issue: '20', fase: 'criterios', agente: 'po', tipo: 'document',
        path: 'po-criterios-20.md', bytes: 1, timestamp: TS, pipelineRoot: root,
    });
    upsertDeliverableIndex({
        issue: '20', fase: 'aprobacion', agente: 'po', tipo: 'document',
        path: 'po-aprobacion-20.md', bytes: 2, timestamp: TS, pipelineRoot: root,
    });
    const read = readDeliverableIndex('20', { pipelineRoot: root });
    assert.equal(read.entries.length, 2, 'las dos fases del PO deben convivir');
    const fases = read.entries.map((e) => e.fase).sort();
    assert.deepEqual(fases, ['aprobacion', 'criterios']);
});

// -----------------------------------------------------------------------------
// enum cerrado de fase (SEC-2)
// -----------------------------------------------------------------------------

test('fase fuera del enum lanza excepción (SEC-2)', () => {
    const root = tmpRoot();
    assert.throws(
        () => upsertDeliverableIndex({
            issue: '30', fase: '../etc', agente: 'po', tipo: 'document',
            path: 'x.md', timestamp: TS, pipelineRoot: root,
        }),
        /fase fuera del enum/,
    );
    assert.throws(() => validatePhase('no-existe', { pipelineRoot: root }), /fase fuera del enum/);
    // Todas las fases del fallback son válidas.
    for (const f of FALLBACK_PHASES) {
        assert.equal(validatePhase(f, { pipelineRoot: root }), f);
    }
});

// -----------------------------------------------------------------------------
// enum de agente (SEC-2)
// -----------------------------------------------------------------------------

test('agente fuera de SKILL_SOURCES lanza excepción (SEC-2)', () => {
    const root = tmpRoot();
    assert.throws(
        () => upsertDeliverableIndex({
            issue: '31', fase: 'dev', agente: 'hacker', tipo: 'document',
            path: 'x.md', timestamp: TS, pipelineRoot: root,
        }),
        /agente sin perfil/,
    );
    assert.equal(validateAgent('pipeline-dev'), 'pipeline-dev');
});

// -----------------------------------------------------------------------------
// issue no ^\d+$ lanza excepción (CA-5)
// -----------------------------------------------------------------------------

test('issue no ^\\d+$ lanza excepción (CA-5)', () => {
    const root = tmpRoot();
    for (const bad of ['abc', '../../etc', '12/34', '0', '']) {
        assert.throws(
            () => upsertDeliverableIndex({
                issue: bad, fase: 'dev', agente: 'po', tipo: 'document',
                path: 'x.md', timestamp: TS, pipelineRoot: root,
            }),
            /issue inválido/,
            `esperaba rechazo para issue="${bad}"`,
        );
    }
    assert.equal(validateIssueId('4255'), '4255');
});

// -----------------------------------------------------------------------------
// flag sensible se persiste (SEC-1)
// -----------------------------------------------------------------------------

test('flag sensible se persiste (SEC-1)', () => {
    const root = tmpRoot();
    upsertDeliverableIndex({
        issue: '40', fase: 'verificacion', agente: 'security', tipo: 'document',
        path: 'security-verificacion-40.md', sensible: true, timestamp: TS, pipelineRoot: root,
    });
    const read = readDeliverableIndex('40', { pipelineRoot: root });
    assert.equal(read.entries[0].sensible, true);
});

// -----------------------------------------------------------------------------
// redacción de metadata (CA-6)
// -----------------------------------------------------------------------------

test('redacta secrets embebidos en metadata (path)', () => {
    const root = tmpRoot();
    const rec = upsertDeliverableIndex({
        issue: '50', fase: 'dev', agente: 'po', tipo: 'document',
        path: 'nota-AKIAIOSFODNN7EXAMPLE.md', timestamp: TS, pipelineRoot: root,
    });
    assert.ok(!rec.path.includes('AKIAIOSFODNN7EXAMPLE'), `no debe filtrar AWS key: ${rec.path}`);
});

// -----------------------------------------------------------------------------
// #4504 CA-3 — tipo:'exception' (registro de "no aplica" con motivo, sin binario)
// -----------------------------------------------------------------------------

test('exception: upsert con tipo:exception sin path NO lanza y persiste motivo', () => {
    const root = tmpRoot();
    const rec = upsertDeliverableIndex({
        issue: '70', fase: 'analisis', agente: 'guru', tipo: 'exception',
        motivo: 'issue puramente mecánico; no amerita dossier', timestamp: TS, pipelineRoot: root,
    });
    assert.equal(rec.tipo, 'exception');
    assert.equal(rec.motivo, 'issue puramente mecánico; no amerita dossier');
    assert.ok(!('path' in rec), 'la excepción no debe llevar path');

    const read = readDeliverableIndex('70', { pipelineRoot: root });
    assert.equal(read.entries.length, 1);
    assert.equal(read.entries[0].tipo, 'exception');
    assert.ok(read.entries[0].motivo.length > 0);
});

test('exception: upsert con tipo:exception sin motivo lanza', () => {
    const root = tmpRoot();
    assert.throws(
        () => upsertDeliverableIndex({
            issue: '71', fase: 'analisis', agente: 'guru', tipo: 'exception',
            timestamp: TS, pipelineRoot: root,
        }),
        /motivo requerido para tipo=exception/,
    );
    assert.throws(
        () => upsertDeliverableIndex({
            issue: '71', fase: 'analisis', agente: 'guru', tipo: 'exception',
            motivo: '   ', timestamp: TS, pipelineRoot: root,
        }),
        /motivo requerido para tipo=exception/,
    );
});

test('exception: motivo entra a redactMeta (secrets redactados)', () => {
    const root = tmpRoot();
    const rec = upsertDeliverableIndex({
        issue: '72', fase: 'analisis', agente: 'guru', tipo: 'exception',
        motivo: 'contexto con AWS=AKIAIOSFODNN7EXAMPLE dentro', timestamp: TS, pipelineRoot: root,
    });
    assert.ok(!rec.motivo.includes('AKIAIOSFODNN7EXAMPLE'), `motivo no debe filtrar la key: ${rec.motivo}`);
});

test('exception y document del mismo agente+fase: último write gana (clave agente::fase)', () => {
    const root = tmpRoot();
    upsertDeliverableIndex({
        issue: '73', fase: 'analisis', agente: 'guru', tipo: 'document',
        path: 'guru-analisis-73.md', timestamp: TS, pipelineRoot: root,
    });
    upsertDeliverableIndex({
        issue: '73', fase: 'analisis', agente: 'guru', tipo: 'exception',
        motivo: 'reemplazo por excepción', timestamp: TS, pipelineRoot: root,
    });
    const read = readDeliverableIndex('73', { pipelineRoot: root });
    assert.equal(read.entries.length, 1, 'misma clave agente::fase no duplica');
    assert.equal(read.entries[0].tipo, 'exception');
});

// -----------------------------------------------------------------------------
// consultas
// -----------------------------------------------------------------------------

test('queryByPhase y queryByAgent filtran correctamente', () => {
    const root = tmpRoot();
    upsertDeliverableIndex({ issue: '60', fase: 'criterios', agente: 'po', tipo: 'document', path: 'a.md', timestamp: TS, pipelineRoot: root });
    upsertDeliverableIndex({ issue: '60', fase: 'criterios', agente: 'ux', tipo: 'image', path: 'b.png', timestamp: TS, pipelineRoot: root });
    upsertDeliverableIndex({ issue: '60', fase: 'aprobacion', agente: 'po', tipo: 'document', path: 'c.md', timestamp: TS, pipelineRoot: root });

    const criterios = queryByPhase('60', 'criterios', { pipelineRoot: root });
    assert.equal(criterios.length, 2);

    const poEntries = queryByAgent('60', 'po', { pipelineRoot: root });
    assert.equal(poEntries.length, 2);
    assert.deepEqual(poEntries.map((e) => e.fase).sort(), ['aprobacion', 'criterios']);
});

// -----------------------------------------------------------------------------
// upsertException — entry tipo:'exception' sin path, con motivo (#4502)
// -----------------------------------------------------------------------------

test('upsertException escribe entry tipo:exception sin path, con motivo', () => {
    const root = tmpRoot();
    const rec = upsertException({
        issue: '4502', fase: 'criterios', agente: 'po',
        motivo: 'El issue no tiene criterios de negocio para documentar.',
        timestamp: TS, pipelineRoot: root,
    });
    assert.equal(rec.tipo, 'exception');
    assert.ok(!('path' in rec), 'la excepción no lleva path');
    assert.equal(rec.sensible, false);
    assert.ok(rec.motivo.includes('criterios de negocio'));

    const entries = queryByPhase('4502', 'criterios', { pipelineRoot: root });
    const ex = entries.find((e) => e.tipo === 'exception');
    assert.ok(ex, 'queryByPhase debe devolver la excepción');
    assert.equal(ex.agente, 'po');
});

test('upsertException exige motivo legible (rechaza vacío)', () => {
    const root = tmpRoot();
    assert.throws(
        () => upsertException({ issue: '4502', fase: 'criterios', agente: 'po', motivo: '', pipelineRoot: root }),
        /motivo requerido/,
    );
    assert.throws(
        () => upsertException({ issue: '4502', fase: 'criterios', agente: 'po', motivo: '   ', pipelineRoot: root }),
        /motivo requerido/,
    );
});

test('upsertException redacta secrets embebidos en el motivo (CA-6)', () => {
    const root = tmpRoot();
    const rec = upsertException({
        issue: '4502', fase: 'criterios', agente: 'po',
        motivo: 'no aplica; contexto AKIAIOSFODNN7EXAMPLE del deploy',
        timestamp: TS, pipelineRoot: root,
    });
    assert.ok(!rec.motivo.includes('AKIAIOSFODNN7EXAMPLE'), `no debe filtrar AWS key: ${rec.motivo}`);
});

test('upsertException es idempotente por clave agente::fase (último gana)', () => {
    const root = tmpRoot();
    upsertException({ issue: '77', fase: 'criterios', agente: 'po', motivo: 'primer motivo del registro', timestamp: TS, pipelineRoot: root });
    upsertException({ issue: '77', fase: 'criterios', agente: 'po', motivo: 'segundo motivo que reemplaza', timestamp: TS, pipelineRoot: root });
    const entries = queryByPhase('77', 'criterios', { pipelineRoot: root });
    assert.equal(entries.length, 1, 'la misma clave agente::fase no duplica');
    assert.ok(entries[0].motivo.includes('segundo motivo'));
});

test('una excepción y un entregable real del mismo agente en fases distintas conviven', () => {
    const root = tmpRoot();
    upsertException({ issue: '88', fase: 'criterios', agente: 'po', motivo: 'no aplica en definicion', timestamp: TS, pipelineRoot: root });
    upsertDeliverableIndex({ issue: '88', fase: 'aprobacion', agente: 'po', tipo: 'document', path: 'po-aprobacion-88.md', timestamp: TS, pipelineRoot: root });
    const read = readDeliverableIndex('88', { pipelineRoot: root });
    assert.equal(read.entries.length, 2);
});

// -----------------------------------------------------------------------------
// lectura defensiva
// -----------------------------------------------------------------------------

test('readDeliverableIndex sobre issue inexistente devuelve shape vacío', () => {
    const root = tmpRoot();
    const read = readDeliverableIndex('999', { pipelineRoot: root });
    assert.deepEqual(read, { issue: 999, entries: [] });
});

test('readDeliverableIndex sobre JSON corrupto no tira y degrada a vacío', () => {
    const root = tmpRoot();
    const file = idx.indexPathFor('998', { pipelineRoot: root });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ esto no es json ', 'utf8');
    const read = readDeliverableIndex('998', { pipelineRoot: root });
    assert.deepEqual(read.entries, []);
});

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
    upsertDeliverableException,
    readDeliverableIndex,
    queryByPhase,
    queryByAgent,
    validatePhase,
    validateAgent,
    validateIssueId,
    FALLBACK_PHASES,
    MOTIVO_MAX_CHARS,
} = idx;

// Root temporal aislado por corrida — no toca el FS real del pipeline.
// `pipelineRoot` del índice = el dir `.pipeline` (contrato de deliverable-index,
// #4507): `resolvePipelineDir` normaliza tolerante repo-root → `.pipeline`, así
// que apuntar el root directo al dir `.pipeline` es idempotente y modela el
// callsite real (pulpo pasa `PIPELINE` = dir `.pipeline`).
function tmpRoot() {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'di-test-')), '.pipeline');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
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
    // Persiste el campo canónico `motivo_no_aplica` aunque el input use el alias `motivo`.
    assert.equal(rec.motivo_no_aplica, 'issue puramente mecánico; no amerita dossier');
    assert.ok(!('path' in rec), 'la excepción no debe llevar path');

    const read = readDeliverableIndex('70', { pipelineRoot: root });
    assert.equal(read.entries.length, 1);
    assert.equal(read.entries[0].tipo, 'exception');
    assert.ok(read.entries[0].motivo_no_aplica.length > 0);
});

test('exception: input con `motivo_no_aplica` (naming del contrato #4524) persiste el campo canónico', () => {
    const root = tmpRoot();
    const rec = upsertDeliverableIndex({
        issue: '70', fase: 'analisis', agente: 'guru', tipo: 'exception',
        motivo_no_aplica: 'no aplica dossier técnico', timestamp: TS, pipelineRoot: root,
    });
    assert.equal(rec.motivo_no_aplica, 'no aplica dossier técnico');
    // Compat #4504/#4506: además del campo canónico, la entry mantiene `motivo`
    // (mismo valor) + `estado:'no_aplica'` para no romper consumidores previos.
    assert.equal(rec.motivo, 'no aplica dossier técnico', 'mantiene alias `motivo` por compat');
    assert.equal(rec.estado, 'no_aplica');
});

test('exception: upsert con tipo:exception sin motivo lanza', () => {
    const root = tmpRoot();
    assert.throws(
        () => upsertDeliverableIndex({
            issue: '71', fase: 'analisis', agente: 'guru', tipo: 'exception',
            timestamp: TS, pipelineRoot: root,
        }),
        /motivo_no_aplica requerido para tipo=exception/,
    );
    assert.throws(
        () => upsertDeliverableIndex({
            issue: '71', fase: 'analisis', agente: 'guru', tipo: 'exception',
            motivo: '   ', timestamp: TS, pipelineRoot: root,
        }),
        /motivo_no_aplica requerido para tipo=exception/,
    );
});

test('exception: motivo entra a redactMeta (secrets redactados)', () => {
    const root = tmpRoot();
    const rec = upsertDeliverableIndex({
        issue: '72', fase: 'analisis', agente: 'guru', tipo: 'exception',
        motivo: 'contexto con AWS=AKIAIOSFODNN7EXAMPLE dentro', timestamp: TS, pipelineRoot: root,
    });
    assert.ok(!rec.motivo_no_aplica.includes('AKIAIOSFODNN7EXAMPLE'), `motivo no debe filtrar la key: ${rec.motivo_no_aplica}`);
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
    assert.equal(rec.path, null, 'la excepción no porta binario');
    assert.equal(rec.sensible, false);
    assert.ok(rec.motivo_no_aplica.includes('criterios de negocio'));

    const entries = queryByPhase('4502', 'criterios', { pipelineRoot: root });
    const ex = entries.find((e) => e.tipo === 'exception');
    assert.ok(ex, 'queryByPhase debe devolver la excepción');
    assert.equal(ex.agente, 'po');
});

test('upsertException exige motivo legible (rechaza vacío)', () => {
    const root = tmpRoot();
    assert.throws(
        () => upsertException({ issue: '4502', fase: 'criterios', agente: 'po', motivo: '', pipelineRoot: root }),
        /motivo_no_aplica requerido/,
    );
    assert.throws(
        () => upsertException({ issue: '4502', fase: 'criterios', agente: 'po', motivo: '   ', pipelineRoot: root }),
        /motivo_no_aplica requerido/,
    );
});

test('upsertException redacta secrets embebidos en el motivo (CA-6)', () => {
    const root = tmpRoot();
    const rec = upsertException({
        issue: '4502', fase: 'criterios', agente: 'po',
        motivo: 'no aplica; contexto AKIAIOSFODNN7EXAMPLE del deploy',
        timestamp: TS, pipelineRoot: root,
    });
    assert.ok(!rec.motivo_no_aplica.includes('AKIAIOSFODNN7EXAMPLE'), `no debe filtrar AWS key: ${rec.motivo_no_aplica}`);
});

test('upsertException es idempotente por clave agente::fase (último gana)', () => {
    const root = tmpRoot();
    upsertException({ issue: '77', fase: 'criterios', agente: 'po', motivo: 'primer motivo del registro', timestamp: TS, pipelineRoot: root });
    upsertException({ issue: '77', fase: 'criterios', agente: 'po', motivo: 'segundo motivo que reemplaza', timestamp: TS, pipelineRoot: root });
    const entries = queryByPhase('77', 'criterios', { pipelineRoot: root });
    assert.equal(entries.length, 1, 'la misma clave agente::fase no duplica');
    assert.ok(entries[0].motivo_no_aplica.includes('segundo motivo'));
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

// -----------------------------------------------------------------------------
// #4505 · CA-4 — entry de excepción (tipo:'exception' + motivo, sin path)
// -----------------------------------------------------------------------------

test('upsertException persiste tipo:"exception" con motivo y sin path', () => {
    const root = tmpRoot();
    const rec = upsertException({
        issue: '4505', fase: 'criterios', agente: 'architect',
        motivo: 'issue sin seccion Detalles Tecnicos al cerrar criterios',
        timestamp: TS, pipelineRoot: root,
    });
    assert.equal(rec.tipo, 'exception');
    assert.equal(rec.agente, 'architect');
    assert.equal(rec.fase, 'criterios');
    assert.equal(rec.path, null);
    assert.ok(rec.motivo_no_aplica.includes('Detalles Tecnicos'));

    const read = readDeliverableIndex('4505', { pipelineRoot: root });
    assert.equal(read.entries.length, 1);
    assert.equal(read.entries[0].tipo, 'exception');
});

test('upsertDeliverableIndex con tipo:"exception" sin motivo lanza', () => {
    const root = tmpRoot();
    assert.throws(
        () => upsertDeliverableIndex({ issue: '10', fase: 'criterios', agente: 'architect', tipo: 'exception', timestamp: TS, pipelineRoot: root }),
        /motivo_no_aplica requerido/,
    );
    assert.throws(
        () => upsertException({ issue: '10', fase: 'criterios', agente: 'architect', motivo: '   ', timestamp: TS, pipelineRoot: root }),
        /motivo_no_aplica requerido/,
    );
});

test('exception es DISTINGUIBLE de un document en el índice (CA-4 / A09)', () => {
    const root = tmpRoot();
    upsertException({ issue: '20', fase: 'criterios', agente: 'architect', motivo: 'no aplica en criterios', timestamp: TS, pipelineRoot: root });
    upsertDeliverableIndex({ issue: '20', fase: 'aprobacion', agente: 'architect', tipo: 'document', path: 'architect-aprobacion-20.md', timestamp: TS, pipelineRoot: root });
    const read = readDeliverableIndex('20', { pipelineRoot: root });
    assert.equal(read.entries.length, 2);
    assert.equal(read.entries.filter((e) => e.tipo === 'exception').length, 1);
    assert.equal(read.entries.filter((e) => e.tipo === 'document').length, 1);
});

test('upsertException es idempotente por clave agente::fase (último-write-gana)', () => {
    const root = tmpRoot();
    upsertException({ issue: '30', fase: 'criterios', agente: 'architect', motivo: 'primer motivo del registro', timestamp: TS, pipelineRoot: root });
    upsertException({ issue: '30', fase: 'criterios', agente: 'architect', motivo: 'segundo motivo que reemplaza', timestamp: TS, pipelineRoot: root });
    const entries = queryByPhase('30', 'criterios', { pipelineRoot: root });
    assert.equal(entries.length, 1);
    assert.ok(entries[0].motivo_no_aplica.includes('segundo motivo'));
});

test('el motivo de la excepción se redacta (secrets no se filtran)', () => {
    const root = tmpRoot();
    const rec = upsertException({
        issue: '40', fase: 'criterios', agente: 'architect',
        motivo: 'contexto con AKIAIOSFODNN7EXAMPLE embebido',
        timestamp: TS, pipelineRoot: root,
    });
    assert.ok(!rec.motivo_no_aplica.includes('AKIAIOSFODNN7EXAMPLE'), `motivo no debe filtrar la key: ${rec.motivo_no_aplica}`);
});

// -----------------------------------------------------------------------------
// #4524 · CA-5 — redacción de secreto opaco EMBEBIDO en oración (RE-1/RE-3)
// -----------------------------------------------------------------------------

test('exception: secreto opaco embebido en oración se redacta (RE-1, no sólo patrón AKIA/JWT)', () => {
    const root = tmpRoot();
    const rec = upsertDeliverableIndex({
        issue: '4524', fase: 'dev', agente: 'pipeline-dev', tipo: 'exception',
        motivo_no_aplica:
            'No aplica porque el deploy usa la key wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY manual',
        timestamp: TS, pipelineRoot: root,
    });
    assert.ok(
        !rec.motivo_no_aplica.includes('wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY'),
        `el secreto opaco embebido debe salir redactado: ${rec.motivo_no_aplica}`,
    );
    // La redacción no destruye la utilidad del motivo (RE-1/UX): resto de la oración intacto.
    assert.ok(rec.motivo_no_aplica.includes('No aplica porque el deploy usa la key'));
    assert.ok(rec.motivo_no_aplica.includes('manual'));
});

test('exception para pipeline-dev::dev: persiste motivo_no_aplica, sin path, e idempotente (CA-1/CA-2/CA-3)', () => {
    const root = tmpRoot();
    const first = upsertDeliverableIndex({
        issue: '4524', fase: 'dev', agente: 'pipeline-dev', tipo: 'exception',
        motivo_no_aplica: 'issue de infra sin entregable físico', timestamp: TS, pipelineRoot: root,
    });
    assert.equal(first.tipo, 'exception');
    assert.equal(first.motivo_no_aplica, 'issue de infra sin entregable físico');
    assert.ok(!('path' in first), 'la excepción no lleva path');

    // Segundo upsert misma clave agente::fase → pisa, no duplica (CA-3).
    upsertDeliverableIndex({
        issue: '4524', fase: 'dev', agente: 'pipeline-dev', tipo: 'exception',
        motivo_no_aplica: 'motivo actualizado', timestamp: TS, pipelineRoot: root,
    });
    const read = readDeliverableIndex('4524', { pipelineRoot: root });
    const devEntries = read.entries.filter((e) => e.fase === 'dev' && e.agente === 'pipeline-dev');
    assert.equal(devEntries.length, 1, 'no debe duplicar la clave pipeline-dev::dev');
    assert.equal(devEntries[0].motivo_no_aplica, 'motivo actualizado');
});

// -----------------------------------------------------------------------------
// CA-3 (#4506) — excepción explícita `no_aplica`
// -----------------------------------------------------------------------------

test('upsertDeliverableIndex escribe entry no_aplica con motivo redactado y sin path binario', () => {
    const root = tmpRoot();
    const rec = upsertDeliverableIndex({
        issue: '4506', fase: 'dev', agente: 'backend-dev', tipo: 'exception',
        motivo: 'entregable no aplica: cierre sin nota sustantiva',
        timestamp: TS, pipelineRoot: root,
    });
    assert.equal(rec.tipo, 'exception');
    assert.equal(rec.estado, 'no_aplica');
    assert.equal(rec.motivo, 'entregable no aplica: cierre sin nota sustantiva');
    assert.equal(rec.path, null, 'la excepción no porta binario');

    const read = readDeliverableIndex('4506', { pipelineRoot: root });
    assert.equal(read.entries.length, 1);
    assert.equal(read.entries[0].estado, 'no_aplica');
    assert.equal(read.entries[0].agente, 'backend-dev');
    assert.equal(read.entries[0].fase, 'dev');
});

test('el motivo de la excepción se capa a MOTIVO_MAX_CHARS (REQ-SEC-3)', () => {
    const root = tmpRoot();
    // Motivo gigante sin espacios cerca del final para forzar el corte duro.
    const huge = 'x'.repeat(MOTIVO_MAX_CHARS + 5000);
    const rec = upsertDeliverableIndex({
        issue: '4507', fase: 'dev', agente: 'backend-dev', tipo: 'exception',
        motivo: huge, timestamp: TS, pipelineRoot: root,
    });
    assert.ok(
        rec.motivo.length <= MOTIVO_MAX_CHARS,
        `motivo capado: ${rec.motivo.length} <= ${MOTIVO_MAX_CHARS}`,
    );
    assert.ok(rec.motivo.endsWith('…'), 'debe llevar marcador de truncado');
});

test('un JWT/AWS key en el motivo se redacta antes de persistir (REQ-SEC-1)', () => {
    const root = tmpRoot();
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const aws = 'AKIAIOSFODNN7EXAMPLE';
    const rec = upsertDeliverableIndex({
        issue: '4508', fase: 'dev', agente: 'backend-dev', tipo: 'exception',
        motivo: `no aplica, falló auth con token ${jwt} y key ${aws}`,
        timestamp: TS, pipelineRoot: root,
    });
    assert.ok(!rec.motivo.includes(jwt), `no debe filtrar JWT: ${rec.motivo}`);
    assert.ok(!rec.motivo.includes(aws), `no debe filtrar AWS key: ${rec.motivo}`);
    // La frase sigue siendo legible tras redactar (UX G-3).
    assert.ok(rec.motivo.includes('no aplica'), 'la frase debe seguir siendo comprensible');

    const read = readDeliverableIndex('4508', { pipelineRoot: root });
    assert.ok(!read.entries[0].motivo.includes(jwt), 'el índice persistido no filtra el JWT');
});

test('tipo distinto de exception sigue exigiendo path no vacío (no-regresión)', () => {
    const root = tmpRoot();
    for (const tipo of ['document', 'image', 'video', 'animation']) {
        assert.throws(
            () => upsertDeliverableIndex({
                issue: '4509', fase: 'dev', agente: 'backend-dev', tipo,
                timestamp: TS, pipelineRoot: root,
            }),
            /path inválido/,
            `tipo=${tipo} debe exigir path`,
        );
    }
});

test('un entregable real posterior pisa la entry no_aplica del mismo agente::fase (idempotencia)', () => {
    const root = tmpRoot();
    upsertDeliverableIndex({
        issue: '4510', fase: 'dev', agente: 'backend-dev', tipo: 'exception',
        motivo: 'no aplica por ahora', timestamp: TS, pipelineRoot: root,
    });
    upsertDeliverableIndex({
        issue: '4510', fase: 'dev', agente: 'backend-dev', tipo: 'document',
        path: 'backend-dev-dev-4510.md', bytes: 128, timestamp: TS, pipelineRoot: root,
    });
    const read = readDeliverableIndex('4510', { pipelineRoot: root });
    assert.equal(read.entries.length, 1, 'la misma clave agente::fase no debe duplicar');
    assert.equal(read.entries[0].tipo, 'document');
    assert.equal(read.entries[0].path, 'backend-dev-dev-4510.md');
    assert.ok(!('estado' in read.entries[0]) || read.entries[0].estado !== 'no_aplica',
        'el entregable real reemplaza al no_aplica');
});

// -----------------------------------------------------------------------------
// #4507 · CA-1 — excepciones android-dev/dev en store canónico
// -----------------------------------------------------------------------------

test('upsertDeliverableException aterriza en .pipeline/deliverables (layout de pulpo)', () => {
    const repoRoot = tmpRoot();
    const pipelineDir = path.join(repoRoot, '.pipeline');
    fs.mkdirSync(pipelineDir, { recursive: true });

    const rec = upsertDeliverableException({
        issue: '4507', fase: 'dev', agente: 'android-dev',
        motivo: 'issue puramente mecánico; no amerita nota de implementación',
        timestamp: TS, pipelineRoot: pipelineDir,
    });
    assert.equal(rec.tipo, 'exception');
    assert.equal(rec.agente, 'android-dev');
    assert.equal(rec.path, null);
    assert.equal(rec.estado, 'no_aplica');

    const canonical = path.join(pipelineDir, 'deliverables', '4507.json');
    assert.ok(fs.existsSync(canonical), `debe existir el índice canónico: ${canonical}`);

    const stray = path.join(repoRoot, 'deliverables', '4507.json');
    assert.ok(!fs.existsSync(stray), `no debe crear índice stray en la raíz: ${stray}`);
});

test('upsertDeliverableException fusiona la excepción con entries físicas previas (CA-1)', () => {
    const repoRoot = tmpRoot();
    const pipelineDir = path.join(repoRoot, '.pipeline');
    fs.mkdirSync(pipelineDir, { recursive: true });

    upsertDeliverableIndex({
        issue: '4507', fase: 'dev', agente: 'pipeline-dev', tipo: 'document',
        path: '.pipeline/assets/docs/4507/pipeline-dev-dev-4507.md', bytes: 1542,
        timestamp: TS, pipelineRoot: pipelineDir,
    });
    upsertDeliverableException({
        issue: '4507', fase: 'dev', agente: 'android-dev',
        motivo: 'no aplica nota de implementación en este cierre',
        timestamp: TS, pipelineRoot: pipelineDir,
    });

    const read = readDeliverableIndex('4507', { pipelineRoot: pipelineDir });
    assert.equal(read.entries.length, 2, 'ambas entries viven en el mismo índice canónico');
    assert.equal(read.entries.filter((e) => e.tipo === 'document').length, 1);
    assert.equal(read.entries.filter((e) => e.tipo === 'exception').length, 1);
});

test('CONTRATO: pasar el repo root crudo caería en un índice stray (regresión #4507)', () => {
    const repoRoot = tmpRoot();
    const strayPath = idx.indexPathFor('4507', { pipelineRoot: repoRoot });
    const canonicalPath = idx.indexPathFor('4507', { pipelineRoot: path.join(repoRoot, '.pipeline') });
    assert.equal(strayPath, path.join(repoRoot, 'deliverables', '4507.json'));
    assert.equal(canonicalPath, path.join(repoRoot, '.pipeline', 'deliverables', '4507.json'));
    assert.notEqual(strayPath, canonicalPath);
});

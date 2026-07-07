'use strict';

// Tests de la garantía determinística de la CONSTANCIA DE ENTREGA (#4517).
// Cubren los criterios de aceptación del issue:
//   - CA-1: constancia incondicional al cerrar la fase entrega (sin umbral).
//   - CA-1 (defensa Opción B): notas < 80 chars igual se persisten.
//   - CA-4: excepción explícita cuando no hay contenido (nunca silencio).
//   - SEC-DEL-3: presigned URL redactada, PR URL intacta.
//   - SEC-DEL-5: idempotencia ante rebote (dos pasadas → sin acumular).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ensureDeliveryConstancia } = require('./delivery-constancia');
const deliverableIndex = require('./deliverable-index');

// Root temporal aislado por corrida — no toca el FS real del pipeline.
function tmpRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'dc-test-'));
}

// El adapter recibe REPO ROOT y traduce a dir `.pipeline` antes de poblar el
// índice. Para leer el índice canónico desde los tests hay que apuntar al dir
// `.pipeline`, no al repo root.
function pipelineDirOf(root) {
    return path.join(root, '.pipeline');
}

const TS = '2026-07-07T10:00:00.000Z';

// -----------------------------------------------------------------------------
// CA-1 — constancia incondicional al cerrar la fase entrega
// -----------------------------------------------------------------------------

test('CA-1 · delivery escribe constancia incondicional al cerrar (indexada + .md phase-scoped)', () => {
    const root = tmpRoot();
    const notas = [
        '# Constancia de entrega — issue #4517',
        '## PR',
        '- Nº: #900',
        '- Link: https://github.com/intrale/platform/pull/900',
        '## Gates de merge',
        '- QA: qa:skipped',
    ].join('\n');

    const res = ensureDeliveryConstancia('4517', { notas, pipelineRoot: root, timestamp: TS });
    assert.equal(res.action, 'materialized');

    // El .md phase-scoped existe en disco.
    assert.ok(
        res.path.replace(/\\/g, '/').endsWith('.pipeline/assets/docs/4517/delivery-entrega-4517.md'),
        res.path,
    );
    assert.ok(fs.existsSync(res.path), res.path);

    // El índice tiene la entrada { fase: entrega, skill: delivery }.
    const read = deliverableIndex.readDeliverableIndex('4517', { pipelineRoot: pipelineDirOf(root) });
    assert.equal(read.entries.length, 1);
    assert.equal(read.entries[0].agente, 'delivery');
    assert.equal(read.entries[0].fase, 'entrega');
    assert.equal(read.entries[0].tipo, 'document');
});

test('CA-1 (defensa Opción B) · constancia con notas < 80 chars igual se persiste (sin umbral anti-ruido)', () => {
    const root = tmpRoot();
    const notasCortas = 'Aprobado. PR #901 mergeado.'; // < 80 chars
    assert.ok(notasCortas.length < 80, 'la nota debe ser corta para el test');

    const res = ensureDeliveryConstancia('901', { notas: notasCortas, pipelineRoot: root, timestamp: TS });
    assert.equal(res.action, 'materialized');

    const read = deliverableIndex.readDeliverableIndex('901', { pipelineRoot: pipelineDirOf(root) });
    assert.equal(read.entries.length, 1);
    assert.equal(read.entries[0].agente, 'delivery');
    assert.equal(read.entries[0].fase, 'entrega');
});

test('CA-1 · usa `motivo` como contenido cuando no hay `notas`', () => {
    const root = tmpRoot();
    const res = ensureDeliveryConstancia('902', {
        motivo: 'Constancia derivada del motivo del resultado del delivery.',
        pipelineRoot: root,
        timestamp: TS,
    });
    assert.equal(res.action, 'materialized');
    const read = deliverableIndex.readDeliverableIndex('902', { pipelineRoot: pipelineDirOf(root) });
    assert.equal(read.entries.length, 1);
    assert.equal(read.entries[0].tipo, 'document');
});

// -----------------------------------------------------------------------------
// CA-4 — excepción explícita cuando la constancia no aplica (no silencio)
// -----------------------------------------------------------------------------

test('CA-4 · sin notas ni motivo → excepción explícita indexada (nunca silencio)', () => {
    const root = tmpRoot();
    const res = ensureDeliveryConstancia('903', { pipelineRoot: root, timestamp: TS });
    assert.equal(res.action, 'exception');

    const read = deliverableIndex.readDeliverableIndex('903', { pipelineRoot: pipelineDirOf(root) });
    assert.equal(read.entries.length, 1);
    assert.equal(read.entries[0].agente, 'delivery');
    assert.equal(read.entries[0].fase, 'entrega');
    assert.equal(read.entries[0].tipo, 'exception');
    assert.ok(read.entries[0].motivo && read.entries[0].motivo.length > 0, 'la excepción lleva motivo');
});

test('CA-4 · notas en blanco (solo whitespace) también caen a excepción', () => {
    const root = tmpRoot();
    const res = ensureDeliveryConstancia('904', { notas: '   \n\t', pipelineRoot: root, timestamp: TS });
    assert.equal(res.action, 'exception');
    const read = deliverableIndex.readDeliverableIndex('904', { pipelineRoot: pipelineDirOf(root) });
    assert.equal(read.entries[0].tipo, 'exception');
});

// -----------------------------------------------------------------------------
// SEC-DEL-3 — redacción: presigned URL redactada, PR URL intacta
// -----------------------------------------------------------------------------

test('SEC-DEL-3 · presigned S3 URL redactada, PR URL de GitHub intacta', () => {
    const root = tmpRoot();
    const prUrl = 'https://github.com/intrale/platform/pull/905';
    const presigned =
        'https://bucket.s3.amazonaws.com/artifact.apk?X-Amz-Signature=abcdef0123456789deadbeef'
        + '&X-Amz-Credential=AKIAEXAMPLE/us-east-1';
    const notas = [
        '# Constancia de entrega — issue #905',
        `## PR`,
        `- Link: ${prUrl}`,
        `## Artefacto desplegado`,
        `- ${presigned}`,
    ].join('\n');

    const res = ensureDeliveryConstancia('905', { notas, pipelineRoot: root, timestamp: TS });
    assert.equal(res.action, 'materialized');

    const written = fs.readFileSync(res.path, 'utf8');
    // La URL de PR (sin query-params sensibles) sobrevive intacta.
    assert.ok(written.includes(prUrl), `la URL de PR debe sobrevivir: ${written}`);
    // La firma presigned queda redactada.
    assert.ok(!written.includes('abcdef0123456789deadbeef'), `la firma presigned NO debe filtrarse: ${written}`);
});

// -----------------------------------------------------------------------------
// SEC-DEL-5 — idempotencia ante rebote (dos pasadas, sin acumular)
// -----------------------------------------------------------------------------

test('SEC-DEL-5 · dos pasadas de delivery → una sola entrada, sin concatenación', () => {
    const root = tmpRoot();
    const notas = '# Constancia\nPR #906 mergeado en main con qa:skipped.';

    const r1 = ensureDeliveryConstancia('906', { notas, pipelineRoot: root, timestamp: TS });
    assert.equal(r1.action, 'materialized');

    // Segunda pasada (rebote): la constancia ya está indexada → no duplica.
    const r2 = ensureDeliveryConstancia('906', { notas, pipelineRoot: root, timestamp: TS });
    assert.equal(r2.action, 'already-indexed');

    const read = deliverableIndex.readDeliverableIndex('906', { pipelineRoot: pipelineDirOf(root) });
    assert.equal(read.entries.length, 1, 'no debe acumular filas por fase');

    // El .md no se concatenó: sigue siendo el snapshot original.
    const filePath = path.join(root, '.pipeline', 'assets', 'docs', '906', 'delivery-entrega-906.md');
    const written = fs.readFileSync(filePath, 'utf8');
    const ocurrencias = (written.match(/PR #906 mergeado/g) || []).length;
    assert.equal(ocurrencias, 1, 'el contenido no debe duplicarse (snapshot overwrite, no append)');
});

// -----------------------------------------------------------------------------
// Idempotencia frente a la Opción A (SKILL.md ya escribió) — no duplica
// -----------------------------------------------------------------------------

test('no duplica cuando el SKILL.md ya dejó la constancia (Opción A previa)', () => {
    const root = tmpRoot();
    // Simula que la Opción A (SKILL.md) ya escribió e indexó la constancia rica.
    const { writeDeliverable } = require('./write-deliverable');
    writeDeliverable('delivery', '907', {
        fase: 'entrega',
        md: '# Constancia rica del SKILL.md',
        pipelineRoot: root,
        timestamp: TS,
    });

    // El backstop de pulpo ve la entrada indexada y no re-escribe.
    const res = ensureDeliveryConstancia('907', { notas: 'nota corta', pipelineRoot: root, timestamp: TS });
    assert.equal(res.action, 'already-indexed');

    const read = deliverableIndex.readDeliverableIndex('907', { pipelineRoot: pipelineDirOf(root) });
    assert.equal(read.entries.length, 1);
});

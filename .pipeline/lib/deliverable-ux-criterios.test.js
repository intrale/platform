'use strict';

// =============================================================================
// deliverable-ux-criterios.test.js — Garantía de entregable de UX en Definición
//
// #4503 — "Definición · UX debe entregar SIEMPRE pantalla actual + mockup
// objetivo + nota". El pulpo, al cerrar `definicion/criterios`, garantiza que
// quede indexado `document` o `exception` para `ux/criterios` (barrido de
// notificación en pulpo.js, mismo patrón que la garantía guru/analisis de
// #4504). Este test dogfooda el MECANISMO subyacente que ese bloque invoca:
//
//   - CA-1: writeDeliverable('ux', issue, { fase:'criterios', ... }) materializa
//     el artefacto y lo indexa como `document` queryable por agente=ux/fase=criterios.
//   - CA-3: writeDeliverableException('ux', ...) registra la excepción con motivo
//     (nunca un cierre silencioso).
//
// La lógica inline del pulpo (check-indexado → materializar | excepción) no se
// unit-testea directamente (pulpo.js no es require-able en aislamiento); acá se
// verifica el contrato de los helpers que esa lógica usa, replicando la misma
// traducción de root repo → dir `.pipeline` que hace el pulpo.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { writeDeliverable, writeDeliverableException } = require('./write-deliverable');
const { readDeliverableIndex, queryByAgent } = require('./deliverable-index');

function tmpRoot() {
    // Root de repo aislado con `.pipeline/` dentro (contrato de write-deliverable).
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ux-crit-'));
    fs.mkdirSync(path.join(root, '.pipeline'), { recursive: true });
    return root;
}

// pipelineRoot que espera el índice (el pulpo pasa `path.join(ROOT, '.pipeline')`).
function indexOpts(root) {
    return { pipelineRoot: path.join(root, '.pipeline') };
}

test('ux/criterios con contenido → indexa document queryable por agente=ux (CA-1)', () => {
    const root = tmpRoot();
    const res = writeDeliverable('ux', '4503', {
        fase: 'criterios',
        md: '# UX · Definición\n- Pantalla actual: login\n- Mockup objetivo: nuevo CTA\n- Nota: se agrega botón',
        pipelineRoot: root,
    });
    assert.ok(res.indexed === true, 'debe quedar indexado');

    const idx = readDeliverableIndex('4503', indexOpts(root));
    const uxEntry = idx.entries.find((e) => e.agente === 'ux' && e.fase === 'criterios');
    assert.ok(uxEntry, 'debe existir entry ux/criterios en el índice');
    assert.strictEqual(uxEntry.tipo, 'document');
    assert.ok(typeof uxEntry.path === 'string' && uxEntry.path.length > 0);
});

test('ux/criterios con mockup SVG → indexa image saneada (CA-1)', () => {
    const root = tmpRoot();
    const res = writeDeliverable('ux', '4503', {
        fase: 'criterios',
        svg: '<svg><script>evil()</script><rect width="10" height="10"/></svg>',
        pipelineRoot: root,
    });
    assert.ok(res.path.endsWith('.svg'), res.path);
    const written = fs.readFileSync(res.path, 'utf8');
    assert.ok(!/script/i.test(written), 'SVG saneado, sin <script>');

    const idx = readDeliverableIndex('4503', indexOpts(root));
    const uxEntry = idx.entries.find((e) => e.agente === 'ux' && e.fase === 'criterios');
    assert.ok(uxEntry && uxEntry.tipo === 'image', 'entry ux/criterios tipo image');
});

test('ux/criterios sin contenido → excepción explícita con motivo (CA-3)', () => {
    const root = tmpRoot();
    writeDeliverableException('ux', '4503', {
        fase: 'criterios',
        motivo: 'Issue sin superficie visual en Definición; entregable de UX no aplica.',
        pipelineRoot: root,
    });

    const idx = readDeliverableIndex('4503', indexOpts(root));
    const uxEntry = idx.entries.find((e) => e.agente === 'ux' && e.fase === 'criterios');
    assert.ok(uxEntry, 'debe existir entry ux/criterios');
    assert.strictEqual(uxEntry.tipo, 'exception');
    assert.ok(uxEntry.motivo_no_aplica && uxEntry.motivo_no_aplica.length > 0, 'la excepción persiste motivo, no silencio');
    assert.ok(uxEntry.path == null, 'la excepción no apunta a binario');
});

test('excepción de ux exige motivo no vacío (no degrada a silencio)', () => {
    const root = tmpRoot();
    assert.throws(
        () => writeDeliverableException('ux', '4503', { fase: 'criterios', motivo: '   ', pipelineRoot: root }),
        /motivo/,
    );
});

test('la garantía es idempotente por clave agente::fase (último write pisa)', () => {
    const root = tmpRoot();
    // Primero se registra excepción, luego llega contenido real → document pisa.
    writeDeliverableException('ux', '4503', {
        fase: 'criterios', motivo: 'aún no hay mockup', pipelineRoot: root,
    });
    writeDeliverable('ux', '4503', {
        fase: 'criterios', md: '# mockup final', pipelineRoot: root,
    });

    const uxEntries = queryByAgent('4503', 'ux', indexOpts(root))
        .filter((e) => e.fase === 'criterios');
    assert.strictEqual(uxEntries.length, 1, 'una sola entry ux/criterios (upsert por clave)');
    assert.strictEqual(uxEntries[0].tipo, 'document', 'el document real pisa la excepción previa');
});

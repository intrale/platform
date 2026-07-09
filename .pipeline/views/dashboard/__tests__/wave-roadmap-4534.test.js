// =============================================================================
// wave-roadmap-4534.test.js — Rediseño de la ventana Roadmap como gestión de
// olas (4 vistas). Verifica la estructura SSR nueva (tira en curso, filas
// planificadas con drag + acciones, ejecutadas) y el cableado del cliente a los
// endpoints transaccionales (buscar, agregar, quitar, eliminar, reordenar, ABM).
//
// Ejecutar:  node --test .pipeline/views/dashboard/__tests__/wave-roadmap-4534.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const v = require('../wave-roadmap');

function state() {
    return {
        active_wave: { number: 1, name: 'Ola en curso', goal: 'x', issues: [{ number: 100, status: 'in-progress' }, { number: 101, status: 'completed' }] },
        planned_waves: [
            { number: 2, name: 'Planif A', goal: 'obj A', issues: [{ number: 200 }] },
            { number: 3, name: 'Planif B', issues: [] },
        ],
        archived_waves: [
            { number: 0, name: 'Ola vieja', closed_at: '2026-07-05T00:00:00Z', issues: [{ number: 1, status: 'completed' }] },
        ],
    };
}

test('SSR: la tira en curso muestra el destino por defecto y "Ver issues", sin avance', () => {
    const html = v.renderRoadmapSsr({ wavesState: state() });
    assert.ok(html.includes('destino por defecto'));
    assert.ok(html.includes("rwOpenDetail(1, 'active')"), 'link Ver issues de la ola en curso');
    assert.ok(!/cerrados ·/.test(html), 'sin avance en la tira');
});

test('SSR: las olas planificadas son arrastrables y traen acciones Ver/Editar/Promover/Eliminar', () => {
    const html = v.renderRoadmapSsr({ wavesState: state() });
    assert.ok(html.includes('data-wave="2"'), 'fila de la ola planificada 2');
    assert.ok(html.includes('draggable="true"'), 'la fila es arrastrable');
    assert.ok(html.includes('ondrop="rwDrop(event, 2)"'), 'drop handler con el número de ola');
    assert.ok(html.includes("rwOpenDetail(2, 'planned')"), 'acción Ver');
    assert.ok(html.includes('rwOpenEdit(2)'), 'acción Editar');
    assert.ok(html.includes('roadmapPromote(2)'), 'acción Promover');
    assert.ok(html.includes('rwDeleteWave(2)'), 'acción Eliminar');
});

test('SSR: la sección de alta expone "+ Nueva ola" (ABM)', () => {
    const html = v.renderRoadmapSsr({ wavesState: state() });
    assert.ok(html.includes('rwOpenCreate()'), 'botón Nueva ola');
    assert.ok(html.includes('id="rw-view-form"'), 'contenedor del ABM');
    assert.ok(html.includes('id="rw-form-pos"'), 'selector de posición en el orden');
});

test('cliente: buscador cablea /api/waves/issue-search con auto-exclusión', () => {
    const cs = v.renderRoadmapClientScript();
    assert.ok(cs.includes('/api/waves/issue-search?q='), 'busca por query');
    assert.ok(cs.includes('rw-excl'), 'marca visualmente los no elegibles');
    assert.ok(cs.includes('r.eligible'), 'usa la elegibilidad del backend');
});

test('cliente: mutaciones usan los endpoints transaccionales con If-Match', () => {
    const cs = v.renderRoadmapClientScript();
    // Baja de ola.
    assert.ok(/rwMutate\('DELETE','\/api\/waves\/'\+num/.test(cs), 'DELETE de ola planificada');
    // Reorden de olas.
    assert.ok(cs.includes("rwMutate('PUT','/api/waves/order'"), 'PUT reorden de olas');
    // Asociar issue a planificada.
    assert.ok(cs.includes("'/api/waves/'+t.num+'/issues'"), 'asociar issue');
    // Agregar a la ola en curso vía allowlist (gate partial-pause).
    assert.ok(cs.includes("'/api/roadmap/allowlist/add'"), 'agregar a la ola en curso');
    // If-Match presente en las mutaciones sobre recursos existentes.
    assert.ok(cs.includes("headers['If-Match']"), 'concurrencia optimista If-Match');
    // Crear ola.
    assert.ok(cs.includes("rwMutate('POST','/api/waves', body)"), 'crear ola');
    // Editar ola.
    assert.ok(/rwMutate\('PATCH','\/api\/waves\/'\+RW\.formWave/.test(cs), 'editar ola');
});

test('cliente: quitar issue confirma antes de mutar (destructivo)', () => {
    const cs = v.renderRoadmapClientScript();
    const block = cs.slice(cs.indexOf('async function rwRemoveIssue'), cs.indexOf('async function rwDeleteWave'));
    assert.ok(block.includes('inConfirm('), 'pide confirmación');
    assert.ok(/danger:\s*true/.test(block), 'confirmación destructiva');
});

test('cliente: expone los handlers en window para los onclick del SSR', () => {
    const cs = v.renderRoadmapClientScript();
    ['rwOpenDetail', 'rwOpenAdd', 'rwOpenCreate', 'rwOpenEdit', 'rwDeleteWave', 'rwDrop', 'rwAddSelected', 'rwSaveForm']
        .forEach((fn) => assert.ok(cs.includes('window.' + fn + '=' + fn), 'window.' + fn));
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { renderEstadoProductosSsr } = require('..' + path.sep + 'estado-productos.js');

test('#4806 rebote: status archived es autoritativo aunque el runtime siga active', () => {
    const html = renderEstadoProductosSsr({
        products: [{ projectId: 'acme-store', name: 'ACME', status: 'archived' }],
        productState: { 'acme-store': { state: 'active', metrics: {} } },
    });
    const buttonSeg = (action) => html.split(`data-action="${action}"`)[0].split('<button').pop();

    assert.ok(html.includes('Archivado'), 'muestra el estado durable archivado');
    assert.ok(!html.includes('Operando'), 'no prioriza el estado runtime active');
    assert.ok(/data-state="archived"/.test(html), 'la card queda marcada como archived');
    for (const action of ['edit', 'deactivate', 'activate', 'start', 'pause', 'create-wave']) {
        assert.ok(/disabled/.test(buttonSeg(action)), `${action} queda deshabilitado`);
    }
});

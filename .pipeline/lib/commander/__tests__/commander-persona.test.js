// =============================================================================
// commander-persona.test.js - Regression del contrato conversacional del
// Telegram Commander en providers de fallback.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('la persona del Commander prohibe narrar el procedimiento antes de responder', () => {
    const pulpo = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'pulpo.js'), 'utf8');

    assert.match(
        pulpo,
        /No narres tu procedimiento interno antes de contestar/,
        'falta la regla anti-bitacora en la persona del Commander'
    );
    assert.match(
        pulpo,
        /primero va la respuesta concreta o conclusi.n .til/i,
        'la respuesta debe arrancar por lo util, no por el paso a paso'
    );
    assert.match(
        pulpo,
        /No mandes actualizaciones de progreso, bit.cora ni "voy a\.\.\."/,
        'el fallback no debe filtrar updates incrementales a Telegram'
    );
    assert.match(
        pulpo,
        /En resumen:/,
        'el cierre resumido debe seguir siendo obligatorio en fallback'
    );
});

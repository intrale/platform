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

// =============================================================================
// #3936 EP4-H3 — el bloque de estado determinístico se inyecta en la persona
// ENTRE el ítem 6 y el 7, conservando los 7 ítems, vía augmentCommanderPersona.
// =============================================================================
test('CA-1 — la persona aumentada conserva ítems 1-7 e inserta el estado entre el 6 y el 7', () => {
    const psp = require('../project-state-pack');
    // Persona representativa con los 7 ítems (los relevantes 6 y 7 literales).
    const persona = [
        'Sos el Commander del pipeline V2 de Intrale.',
        'REGLAS:',
        '1. ...', '2. ...', '3. ...', '4. ...', '5. ...',
        '6. Contexto del entorno:',
        '   - Pipeline dir: /x',
        '7. CIERRE OBLIGATORIO — al FINAL de CUALQUIER respuesta...',
    ].join('\n');
    const pack = `${psp.STATE_GUARDRAIL}\n\n${psp.DELIM_OPEN}\n## Issues abiertos\n- #1 t\n${psp.DELIM_CLOSE}`;
    const out = psp.augmentCommanderPersona(persona, { pack });

    // Los 7 ítems siguen presentes.
    for (const it of ['1.', '2.', '3.', '4.', '5.', '6. Contexto del entorno', '7. CIERRE OBLIGATORIO']) {
        assert.ok(out.includes(it), `conserva el ítem "${it}"`);
    }
    // El bloque de estado queda entre el ítem 6 y el 7.
    const idx6 = out.indexOf('6. Contexto del entorno');
    const idxState = out.indexOf(psp.DELIM_OPEN);
    const idx7 = out.indexOf('7. CIERRE OBLIGATORIO');
    assert.ok(idx6 < idxState && idxState < idx7, 'el estado va después del 6 y antes del 7');
});

test('#3936 — pulpo.js inyecta el pack en la persona del Commander', () => {
    const pulpo = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'pulpo.js'), 'utf8');
    assert.match(pulpo, /commanderProjectState\.buildProjectStatePack/, 'arma el pack de estado');
    assert.match(pulpo, /commanderProjectState\.augmentCommanderPersona/, 'aumenta la persona con el pack');
    assert.match(pulpo, /commanderProjectState\.buildSystemStateSnapshot/, 'unifica el systemState de Sherlock (CA-4)');
    assert.match(pulpo, /systemPrompt: commanderPersonaAugmented/, 'usa la persona aumentada como system prompt');
});

// =============================================================================
// wizard-providers-view.test.js — CA-2/CA-3/CA-8/CA-13 (verificación estática).
//
// Puppeteer NO está disponible en el entorno del pipeline, así que las garantías
// de runtime (no-storage, toggle press-to-view) se verifican estáticamente sobre
// el HTML/JS renderizado server-side: el input password, el toggle con los 4
// listeners, el banner terminal-only, la ausencia de acción "crear/nueva", y que
// el script NO referencia localStorage / sessionStorage.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const view = require('../../views/dashboard/wizard-providers');

const HTML = view.renderWizardProviders({ csrfToken: 'tok"123<x>' });

test('emite meta csrf escapado', () => {
    assert.ok(HTML.includes('<meta name="csrf-token"'));
    // El token se escapa como atributo (no aparece la comilla cruda dentro del value).
    assert.ok(HTML.includes('tok&quot;123&lt;x&gt;'));
    assert.ok(!HTML.includes('content="tok"123'));
});

test('step 3 tiene input password con name api_key y autocomplete off (CA-3)', () => {
    assert.match(HTML, /type="password"[^>]*name="api_key"|name="api_key"[^>]*type="password"/);
    assert.ok(HTML.includes('autocomplete="off"'));
    assert.ok(HTML.includes('spellcheck="false"'));
});

test('toggle press-to-view monta los 4 listeners (CA-3)', () => {
    assert.ok(HTML.includes('data-action="toggle-password"'));
    for (const ev of ['mousedown', 'mouseup', 'mouseleave', 'blur']) {
        assert.ok(HTML.includes(`addEventListener('${ev}'`), `falta listener ${ev}`);
    }
});

test('banner terminal-only presente y sin acción crear/nueva (CA-2)', () => {
    assert.ok(/terminal/i.test(HTML));
    assert.ok(HTML.includes('setx'));
    // Las tres acciones existen.
    for (const act of ['metadata', 'rotate', 'deactivate']) {
        assert.ok(HTML.includes(`data-act="${act}"`), `falta acción ${act}`);
    }
    // NO existe acción de creación de key nueva.
    assert.ok(!/data-act="(crear|nueva|create|new)"/i.test(HTML));
});

test('el cliente NUNCA usa localStorage ni sessionStorage (CA-8)', () => {
    assert.ok(!/localStorage/.test(HTML), 'el script referencia localStorage');
    assert.ok(!/sessionStorage/.test(HTML), 'el script referencia sessionStorage');
});

test('no se renderiza ninguna key completa, sólo masking sk-•••••', () => {
    // No hay secuencias largas tipo key (≥20 chars alfanum contiguos) en el HTML.
    const longToken = HTML.match(/[A-Za-z0-9_-]{24,}/g) || [];
    // Filtramos los que son claramente CSS/identificadores benignos no-key:
    const suspicious = longToken.filter((t) => /^sk-/.test(t) || /^csk-/.test(t) || /^nvapi-/.test(t));
    assert.equal(suspicious.length, 0, `posible key en el HTML: ${suspicious.join(', ')}`);
});

test('terminalBanner es el helper único del texto', () => {
    assert.ok(/terminal/i.test(view.terminalBanner()));
});

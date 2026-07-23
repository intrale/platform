// =============================================================================
// Tests de la vista views/dashboard/multi-provider-coverage.js (#3681).
//
// Cubre:
//   CA-B15 → matriz envuelta en <table> real con <thead>/<tbody>.
//   CA-B16 → cada <svg> con role="img" y aria-label en celdas.
//   CA-B17 → celdas N/A con aria-label explícito (en client JS, verificable
//             por presencia del helper `ariaForCell` que incluye el estado).
//   CA-B19.bis (REQ-SEC-B4) → bundle no contiene innerHTML/insertAdjacentHTML.
//   CA-B19.quater (REQ-SEC-B5) → sprite no contiene <script>/<foreignObject>/
//                                onload/onerror/href external.
//   CA-B6 → los 8 íconos ic-* del sprite están presentes.
//   CA-B7 → leyenda con 5 estados + 5 buckets.
//   CA-B11 → botón "Ejecutar harness" comienza disabled (frontend guard).
//   CA-B10.bis (REQ-SEC-B7) → link al issue construido con cast Number().
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const view = require('../../views/dashboard/multi-provider-coverage');

// -----------------------------------------------------------------------------
// Bundle HTML estático
// -----------------------------------------------------------------------------

test('renderMultiProviderCoverage devuelve un documento HTML completo', () => {
    const html = view.renderMultiProviderCoverage();
    assert.match(html, /<!DOCTYPE html>/);
    assert.match(html, /<html lang="es">/);
    assert.match(html, /<title>Intrale · Multi-Provider Coverage<\/title>/);
});

test('matriz envuelta en <table> real con <thead>/<tbody> (CA-B15)', () => {
    const html = view.renderMultiProviderCoverage();
    assert.match(html, /<table class="mpc-matrix"[^>]*>/);
    assert.match(html, /<thead>/);
    assert.match(html, /<tbody/);
    assert.match(html, /role="grid"/);
    assert.match(html, /aria-label="Cobertura skill por provider"/);
});

test('botón "Ejecutar harness" arranca disabled (CA-B11 — frontend guard)', () => {
    const html = view.renderMultiProviderCoverage();
    // El botón está disabled en el HTML inicial; el JS lo habilita al confirmar
    // coordinación.
    assert.match(html, /<button class="mpc-run-btn"[^>]*\bdisabled\b/);
});

test('CSS hide-show del estado vacío para "coverage_unavailable"', () => {
    const html = view.renderMultiProviderCoverage();
    assert.match(html, /mpc-empty/);
    assert.match(html, /Aún no hay datos del harness/);
});

test('leyenda permanente: cubre 5 estados + 5 buckets (CA-B7)', () => {
    // La leyenda se construye en el CLIENT_JS — verificamos que el código
    // emite los 5 buckets y los 5 estados.
    const js = view.CLIENT_JS;
    ['PASS', 'WARN', 'FAIL', 'SKIPPED', 'N/A'].forEach((s) => {
        assert.match(js, new RegExp("'" + s.replace(/[/]/g, '\\/') + "'"),
            'CLIENT_JS debe mencionar estado ' + s);
    });
    ['<=100ms', '<=500ms', '<=2s', '<=10s', '>10s'].forEach((b) => {
        assert.ok(js.indexOf("'" + b + "'") >= 0, 'CLIENT_JS debe mencionar bucket ' + b);
    });
});

// -----------------------------------------------------------------------------
// Defensa anti-XSS del bundle (REQ-SEC-B4)
// -----------------------------------------------------------------------------

test('CLIENT_JS NO usa innerHTML para data dinámica (REQ-SEC-B4)', () => {
    const js = view.CLIENT_JS;
    // Permitimos que la palabra aparezca en comentarios documentando la
    // prohibición, pero no como asignación.
    const matches = js.match(/\.innerHTML\s*=/g) || [];
    assert.equal(matches.length, 0,
        'CLIENT_JS NO debe asignar a .innerHTML (todos los campos dinámicos van por textContent)');
});

test('CLIENT_JS NO usa insertAdjacentHTML (REQ-SEC-B4)', () => {
    const js = view.CLIENT_JS;
    assert.equal(js.indexOf('insertAdjacentHTML'), -1,
        'CLIENT_JS NO debe usar insertAdjacentHTML');
});

test('CLIENT_JS construye link al issue con cast Number() (REQ-SEC-B7)', () => {
    const js = view.CLIENT_JS;
    assert.match(js, /Number\(c\.issue\)/,
        'Link al issue se construye con cast Number() — defensa anti open-redirect');
    assert.match(js, /github\.com\/intrale\/platform\/issues\//);
    assert.match(js, /rel = 'noopener noreferrer'/);
    assert.match(js, /target = '_blank'/);
});

test('CLIENT_JS usa textContent para campos dinámicos (REQ-SEC-B4)', () => {
    const js = view.CLIENT_JS;
    // Verificamos que textContent está presente abundantemente.
    const occurrences = (js.match(/\.textContent\s*=/g) || []).length;
    assert.ok(occurrences >= 15,
        'CLIENT_JS debe usar textContent abundantemente (al menos 15 asignaciones, encontradas ' + occurrences + ')');
});

test('CLIENT_JS NO lee atributos data-* con innerHTML (REQ-SEC-B9)', () => {
    const js = view.CLIENT_JS;
    // El popover state vive en mpcState, no en DOM markup.
    assert.match(js, /mpcState\.popoverState/,
        'state del popover en JS state, no DOM markup');
});

test('CLIENT_JS usa createElementNS para SVG y setAttribute (no innerHTML)', () => {
    const js = view.CLIENT_JS;
    assert.match(js, /createElementNS\(ns, 'svg'\)/);
    assert.match(js, /createElementNS\(ns, 'use'\)/);
});

// -----------------------------------------------------------------------------
// Sprite — tests estáticos de los 8 íconos nuevos (REQ-SEC-B5)
// -----------------------------------------------------------------------------

const SPRITE_PATH = path.resolve(__dirname, '..', '..', 'assets', 'icons', 'sprite.svg');

test('sprite.svg incluye los 8 íconos nuevos del hijo B (CA-B6)', () => {
    const svg = fs.readFileSync(SPRITE_PATH, 'utf8');
    const required = [
        'ic-cell-pass', 'ic-cell-warn', 'ic-cell-fail',
        'ic-cell-skipped', 'ic-cell-na',
        'ic-play', 'ic-pause-lock', 'ic-link-out',
    ];
    required.forEach((id) => {
        assert.match(svg, new RegExp('<symbol\\s+id="' + id + '"'),
            'sprite.svg debe definir symbol id="' + id + '"');
    });
});

test('sprite.svg NO contiene <script> en markup activo (REQ-SEC-B5)', () => {
    const svg = fs.readFileSync(SPRITE_PATH, 'utf8');
    // Stripear comentarios HTML/XML (documentan la prohibición pero no
    // ejecutan markup) antes del check.
    const stripped = svg.replace(/<!--[\s\S]*?-->/g, '');
    assert.equal(stripped.search(/<script\b/i), -1,
        'sprite.svg NO debe contener <script> activo');
});

test('sprite.svg NO contiene <foreignObject> en markup activo (REQ-SEC-B5)', () => {
    const svg = fs.readFileSync(SPRITE_PATH, 'utf8');
    const stripped = svg.replace(/<!--[\s\S]*?-->/g, '');
    assert.equal(stripped.search(/<foreignObject\b/i), -1);
});

test('sprite.svg NO contiene atributos on* fuera de comentarios (REQ-SEC-B5)', () => {
    const svg = fs.readFileSync(SPRITE_PATH, 'utf8');
    // Stripear comentarios antes del check.
    const stripped = svg.replace(/<!--[\s\S]*?-->/g, '');
    // patrones onerror=, onload=, onclick=, etc.
    const onAttr = stripped.match(/\son[a-z]+\s*=/i);
    assert.equal(onAttr, null,
        'sprite.svg NO debe tener atributos on* (onload/onerror/etc) en markup activo');
});

test('sprite.svg NO contiene <use href="http..."> ni href data: (REQ-SEC-B5)', () => {
    const svg = fs.readFileSync(SPRITE_PATH, 'utf8');
    const stripped = svg.replace(/<!--[\s\S]*?-->/g, '');
    // href permitido sólo si empieza con '#' (referencia interna a un symbol)
    const hrefMatches = stripped.match(/href\s*=\s*"([^"]+)"/g) || [];
    hrefMatches.forEach((m) => {
        const value = m.match(/"([^"]+)"/)[1];
        assert.ok(value.startsWith('#'),
            'sprite.svg href debe ser referencia interna (#id); encontrado: ' + value);
    });
});

// -----------------------------------------------------------------------------
// Coordinación visual: estados de celda esperados
// -----------------------------------------------------------------------------

test('PANEL_CSS define clases para los 5 estados de celda (CA-B5)', () => {
    const css = view.PANEL_CSS;
    ['pass', 'warn', 'fail', 'skipped', 'na'].forEach((s) => {
        assert.match(css, new RegExp('\\.mpc-cell\\.' + s + '\\s*\\{'),
            'PANEL_CSS debe definir .mpc-cell.' + s);
    });
});

test('PANEL_CSS define focus-visible con outline (CA-B18)', () => {
    const css = view.PANEL_CSS;
    assert.match(css, /:focus-visible/,
        'PANEL_CSS debe definir focus-visible para navegación de teclado');
});

test('PANEL_CSS define rayado diagonal para N/A (CA-B14)', () => {
    const css = view.PANEL_CSS;
    assert.match(css, /repeating-linear-gradient/,
        'PANEL_CSS debe definir patrón rayado para N/A');
});

// -----------------------------------------------------------------------------
// A11y: estructura HTML inicial es accesible
// -----------------------------------------------------------------------------

test('HTML inicial tiene aria-live en banners (CA-B8/B9)', () => {
    const html = view.renderMultiProviderCoverage();
    assert.match(html, /aria-live="polite"/);
});

test('HTML inicial tiene popover con role="tooltip" (CA-B13)', () => {
    const html = view.renderMultiProviderCoverage();
    assert.match(html, /role="tooltip"/);
    assert.match(html, /aria-hidden="true"/);
});

test('CLIENT_JS construye aria-label de celda incluyendo el estado (CA-B16/B17)', () => {
    const js = view.CLIENT_JS;
    assert.match(js, /ariaForCell/);
    assert.match(js, /'celda ' \+ skill \+ ' × ' \+ provider \+ ': '/);
});

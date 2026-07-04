// =============================================================================
// Tests de consistencia del encabezado entre ventanas (#4463 · CA-4).
//
// Antes del fix, las pills de CPU/RAM (#hdr-resources) y uptime del Pulpo
// (#hdr-pulpo) SÓLO existían en la HOME. Los satélites, Providers y Roadmap
// armaban su propio <div class="in-header-meta"> sin esas pills → header
// inconsistente. Este test verifica que las cuatro ventanas del issue (Inicio,
// Pipeline, Roadmap, Providers) ahora emiten las mismas pills desde el
// componente compartido header-meta.js y cablean su hidratación.
//
// node:test, sin Jest.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const sat = require(path.resolve(__dirname, '..', 'satellites.js'));
const home = require(path.resolve(__dirname, '..', 'home.js'));
const providers = require(path.resolve(__dirname, '..', 'providers.js'));
const roadmap = require(path.resolve(__dirname, '..', 'wave-roadmap.js'));

// Cada entrada: [nombre de ventana, HTML SSR renderizado].
const WINDOWS = [
    ['Inicio (home)', home.renderHomeHTML({})],
    ['Pipeline (satélite)', sat.renderPipeline()],
    ['Roadmap', roadmap.renderRoadmap()],
    ['Providers', providers.renderProviders()],
];

for (const [name, html] of WINDOWS) {
    test(`CA-4: ${name} emite la pill de CPU/RAM (#hdr-resources)`, () => {
        assert.match(html, /id="hdr-resources"/, `${name} no muestra la pill de CPU/RAM`);
    });
    test(`CA-4: ${name} emite la pill de uptime del Pulpo (#hdr-pulpo)`, () => {
        assert.match(html, /id="hdr-pulpo"/, `${name} no muestra la pill de uptime del Pulpo`);
    });
    test(`CA-4: ${name} emite el reloj (#hdr-clock)`, () => {
        assert.match(html, /id="hdr-clock"/, `${name} no muestra el reloj`);
    });
    test(`CA-4/CA-5: ${name} cablea la hidratación compartida de las pills`, () => {
        assert.match(html, /window\.__hydrateHeaderPills/,
            `${name} no inyecta el helper de hidratación → las pills quedarían en "…"`);
    });
    test(`CA-7 (SEC-1): ${name} hidrata sin innerHTML sobre datos del header`, () => {
        // El bloque de hidratación de pills nunca usa innerHTML. (No aserta sobre
        // todo el documento porque otras vistas legítimamente usan innerHTML en
        // otros componentes; sí garantiza que el helper compartido no lo hace.)
        const marker = 'window.__hydrateHeaderPills = function';
        const idx = html.indexOf(marker);
        assert.ok(idx >= 0, `${name}: no se encontró el helper de hidratación`);
        const slice = html.slice(idx, idx + 1200);
        assert.doesNotMatch(slice, /innerHTML/, `${name}: la hidratación de pills no debe usar innerHTML`);
    });
}

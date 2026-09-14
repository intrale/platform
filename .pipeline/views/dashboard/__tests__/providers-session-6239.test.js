// =============================================================================
// #6239 — Línea de vigencia de la sesión de Claude Code en la pantalla
// Providers (CA-12) y su degradación (CA-A3 / patrón #3177).
//
// El caso que motiva este archivo es una regresión real detectada en la pasada
// de corrección: `providers.js` requería el módulo de vigencia y su copy con
// requires pelados en el tope del archivo, así que cualquier falla de carga
// (copy.json ausente o corrupto, módulo movido) tumbaba el panel ENTERO en vez
// de dejar la pantalla sin esa línea. El resto del archivo ya carga sus fuentes
// de datos con guarda por ese mismo motivo.
//
// La degradación se prueba en un proceso hijo, con un hook de `Module._load`
// que hace fallar el require: así el require.cache del runner no queda
// contaminado y el escenario es el mismo que el de producción.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PROVIDERS_PATH = path.resolve(__dirname, '..', 'providers.js');
const providers = require(PROVIDERS_PATH);

function filaDe(key, session) {
    const model = providers.buildProvidersModel();
    const fila = (model.providers || []).find((p) => p.key === key);
    assert.ok(fila, `la fila de ${key} debe existir en el modelo`);
    if (session !== undefined) fila.session = session;
    return providers.renderProviderRow(fila, Date.now());
}

function lineaSesion(html) {
    const m = html.match(/<span class="prov-session[^>]*>([^<]*)<\/span>/);
    return m ? { clase: m[0], texto: m[1] } : null;
}

test('CA-12 · la línea de sesión sale sólo en anthropic, con clase propia', () => {
    const conDatos = lineaSesion(filaDe('anthropic', { available: true, minutesLeft: 425 }));
    assert.ok(conDatos, 'anthropic debe mostrar la línea de sesión');
    assert.match(conDatos.texto, /sesión/i, 'el texto visible nombra la sesión (UX-9)');
    assert.doesNotMatch(conDatos.clase, /prov-vigencia/, 'no reusa la clase del cruce de catálogo');

    // El resto de los proveedores no tiene sesión OAuth que mostrar.
    for (const otro of ['openai', 'gemini-google', 'cerebras', 'nvidia-nim']) {
        assert.equal(lineaSesion(filaDe(otro)), null, `${otro} no debe mostrar línea de sesión`);
    }
});

test('CA-12 · sin datos de vigencia la línea sigue estando, sin romper la fila', () => {
    const sinDatos = lineaSesion(filaDe('anthropic', { available: false, minutesLeft: null }));
    assert.ok(sinDatos, 'el estado "sin datos" también se muestra (los cinco estados)');
    assert.match(sinDatos.texto, /sesión/i);
});

test('CA-11 · la línea de sesión no expone la credencial', () => {
    const html = filaDe('anthropic', { available: true, minutesLeft: 425 });
    assert.doesNotMatch(html, /eyJ[A-Za-z0-9_-]{6,}/, 'nada con forma de JWT');
    assert.doesNotMatch(html, /sk-ant-|refreshToken|accessToken/i, 'ningún campo de la credencial');
});

test('CA-A3 · si el módulo de vigencia no carga, el panel sigue renderizando', () => {
    const script = `
        const Module = require('module');
        const orig = Module._load;
        Module._load = function (req) {
            if (/oauth-session-expiry/.test(req)) throw new Error('fallo simulado de carga');
            return orig.apply(this, arguments);
        };
        const p = require(${JSON.stringify(PROVIDERS_PATH)});
        const html = p.bodyHtml(p.buildProvidersModel());
        process.stdout.write(JSON.stringify({
            largo: html.length,
            tieneSesion: html.includes('prov-session'),
            tieneFilas: html.includes('prov-row'),
        }));
    `;
    const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    const r = JSON.parse(out);
    assert.equal(r.tieneSesion, false, 'sin el módulo no se dibuja la línea de sesión');
    assert.equal(r.tieneFilas, true, 'pero el panel sigue mostrando las filas de proveedores');
    assert.ok(r.largo > 1000, 'la pantalla no queda en blanco');
});

'use strict';

// #4249 + #4533 — Matriz de cuota DISPONIBLE por proveedor × ventana en la home
// MIZPÁ. El % real por proveedor lo hidrata el slice `/api/dash/quota`; el SSR
// entrega el skeleton correcto: una fila por proveedor activo, cada una con dos
// celdas de ventana (corta/larga) e ids canónicos para hidratación.
//
// Cubre:
//   * CA-A1 — aparece una fila por cada proveedor activo (≥5); NO aparece Groq.
//   * CA-A2 — la lista se deriva de una fuente única (MZ_PROVIDER_META), no de
//             un array fijo de 3: el render no se rompe al sumar un proveedor.
//   * CA-A3 — cada celda usa el id canónico `mz-qm-${key}-${slot}-{tag,bar,pct,rst}`.
//   * #4533 — cada celda rotula su ventana real (5h/Sem, Min/Día, Roll).
//   * CA-A5 / security — un label con markup no produce HTML ejecutable (XSS).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    _mzWinCell,
    _mzProviderMatrixRow,
    _mzProviderMatrix,
    MZ_PROVIDER_META,
    MZ_PROVIDER_WINDOWS,
    MZ_ACTIVE_PROVIDERS,
} = require('../views/dashboard/home');

// Proveedores activos esperados, alineados con multi-provider-health.json y
// ALLOWED_PROVIDERS (ids canónicos). Groq queda fuera (descontinuado #3353).
const EXPECTED_PROVIDERS = ['anthropic', 'openai-codex', 'gemini-google', 'cerebras', 'nvidia-nim'];

test('CA-A1 — _mzProviderMatrix renderiza una fila por cada proveedor activo (≥5)', () => {
    const html = _mzProviderMatrix();
    const rowCount = (html.match(/class="mz-qm-row"/g) || []).length;
    assert.ok(rowCount >= 5, `esperaba ≥5 filas de proveedor, hubo ${rowCount}`);
    assert.equal(rowCount, MZ_ACTIVE_PROVIDERS.length, 'la cantidad de filas debe igualar a los proveedores activos');
});

test('CA-A1 — Cerebras y NVIDIA NIM presentes; Groq ausente', () => {
    const html = _mzProviderMatrix();
    assert.match(html, /Cerebras/, 'falta la fila de Cerebras');
    assert.match(html, /NVIDIA NIM/, 'falta la fila de NVIDIA NIM');
    assert.doesNotMatch(html, /Groq/i, 'Groq fue descontinuado (#3353) y no debe renderizarse');
});

test('CA-A2 — la lista deriva de fuente única (MZ_PROVIDER_META), no de 3 hardcodeados', () => {
    assert.deepEqual(MZ_ACTIVE_PROVIDERS.slice().sort(), EXPECTED_PROVIDERS.slice().sort());
    assert.ok(MZ_ACTIVE_PROVIDERS.length > 3, 'la lista no puede ser un array fijo de 3');
    // Sumar un proveedor a la fuente debe reflejarse en el render sin tocar
    // _mzProviderMatrix. Simulamos derivando a mano desde la misma fuente.
    const derived = MZ_ACTIVE_PROVIDERS.map(_mzProviderMatrixRow).join('');
    assert.equal(derived, _mzProviderMatrix(), '_mzProviderMatrix debe derivar de MZ_ACTIVE_PROVIDERS');
});

test('CA-A3 — cada celda usa el id canónico mz-qm-${key}-${slot}-{tag,bar,pct,rst}', () => {
    const html = _mzProviderMatrix();
    for (const key of MZ_ACTIVE_PROVIDERS) {
        for (const slot of ['short', 'long']) {
            for (const part of ['tag', 'bar', 'pct', 'rst']) {
                assert.ok(
                    html.includes(`id="mz-qm-${key}-${slot}-${part}"`),
                    `falta id mz-qm-${key}-${slot}-${part}`,
                );
            }
        }
    }
});

test('#4533 — cada proveedor rotula su ventana real (5h/Sem, Min/Día, Roll)', () => {
    const anth = _mzProviderMatrixRow('anthropic');
    assert.match(anth, />5h</, 'Anthropic ventana corta = 5h');
    assert.match(anth, />Sem</, 'Anthropic ventana larga = Sem');
    const codex = _mzProviderMatrixRow('openai-codex');
    assert.match(codex, />Roll</, 'Codex ventana corta = Roll');
    const gem = _mzProviderMatrixRow('gemini-google');
    assert.match(gem, />Min</, 'Gemini ventana corta = Min');
    assert.match(gem, />Día</, 'Gemini ventana larga = Día');
    // Los labels del skeleton derivan de MZ_PROVIDER_WINDOWS (fuente única SSR).
    assert.equal(MZ_PROVIDER_WINDOWS.anthropic.short, '5h');
    assert.equal(MZ_PROVIDER_WINDOWS['nvidia-nim'].long, 'Día');
});

test('#4533 — la fila muestra la fuente fidedigna del proveedor (CLI/API/headers)', () => {
    assert.match(_mzProviderMatrixRow('anthropic'), /· CLI/, 'Anthropic: fuente CLI');
    assert.match(_mzProviderMatrixRow('gemini-google'), /· API/, 'Gemini: fuente API');
    assert.match(_mzProviderMatrixRow('cerebras'), /· headers/, 'Cerebras: fuente headers');
    // La fuente declarada en la meta coincide con lo renderizado.
    assert.equal(MZ_PROVIDER_META['nvidia-nim'].src, 'headers');
});

test('CA-A5 / security — un label con markup no produce HTML ejecutable (XSS)', () => {
    const evil = '<script>alert(1)</script>';
    const html = _mzWinCell('evilkey', 'short', evil);
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/, 'el markup no debe quedar sin escapar');
    assert.match(html, /&lt;script&gt;/, 'el label debe escaparse (escapeHtmlText)');
});

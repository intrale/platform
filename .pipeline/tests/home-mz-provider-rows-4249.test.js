'use strict';

// #4249 + #4533 — Matriz de cuota DISPONIBLE por proveedor × ventana en la home
// MIZPÁ. El % real por proveedor lo hidrata el slice `/api/dash/quota`; el SSR
// entrega el skeleton correcto: una fila por proveedor activo, cada una con dos
// celdas de ventana (corta/larga) e ids canónicos para hidratación.
//
// Cubre:
//   * CA-A1 — aparece una fila por cada proveedor activo (los 3 vigentes tras
//             #6563); NO aparece ningún retirado (Groq, Cerebras, NVIDIA NIM).
//   * CA-A2 — la lista se deriva de una fuente única (MZ_PROVIDER_META), no de
//             un array fijo: el render no se rompe al sumar un proveedor.
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

// Proveedores activos esperados, alineados con agent-models.json y
// ALLOWED_PROVIDERS (ids canónicos). Los gratuitos retirados quedan fuera
// (Groq en #3353; Cerebras y NVIDIA NIM en #6563).
const EXPECTED_PROVIDERS = ['anthropic', 'openai-codex', 'antigravity'];

test('CA-A1 — _mzProviderMatrix renderiza una fila por cada proveedor activo (3)', () => {
    const html = _mzProviderMatrix();
    const rowCount = (html.match(/class="mz-qm-row"/g) || []).length;
    assert.equal(rowCount, EXPECTED_PROVIDERS.length, `esperaba ${EXPECTED_PROVIDERS.length} filas de proveedor, hubo ${rowCount}`);
    assert.equal(rowCount, MZ_ACTIVE_PROVIDERS.length, 'la cantidad de filas debe igualar a los proveedores activos');
});

test('CA-A1 — Anthropic, Codex y Antigravity presentes; ningún retirado (Groq, Cerebras, NVIDIA)', () => {
    const html = _mzProviderMatrix();
    assert.match(html, /Anthropic/, 'falta la fila de Anthropic');
    assert.match(html, /Codex/, 'falta la fila de Codex');
    // #6861 — la fila del provider renombrado se rotula `Antigravity`.
    assert.match(html, /Antigravity/, 'falta la fila de Antigravity');
    assert.doesNotMatch(html, /Gemini/, 'el rótulo viejo `Gemini` no debe renderizarse (#6861)');
    assert.doesNotMatch(html, /Groq|Cerebras|NVIDIA/i, 'los proveedores retirados (#3353, #6563) no deben renderizarse');
});

test('CA-A2 — la lista deriva de fuente única (MZ_PROVIDER_META), no de un array hardcodeado', () => {
    assert.deepEqual(MZ_ACTIVE_PROVIDERS.slice().sort(), EXPECTED_PROVIDERS.slice().sort());
    assert.deepEqual(MZ_ACTIVE_PROVIDERS, Object.keys(MZ_PROVIDER_META), 'la lista se deriva de MZ_PROVIDER_META');
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
    const agy = _mzProviderMatrixRow('antigravity');
    assert.match(agy, />Min</, 'Antigravity ventana corta = Min');
    assert.match(agy, />Día</, 'Antigravity ventana larga = Día');
    // Los labels del skeleton derivan de MZ_PROVIDER_WINDOWS (fuente única SSR).
    assert.equal(MZ_PROVIDER_WINDOWS.anthropic.short, '5h');
    assert.equal(MZ_PROVIDER_WINDOWS['antigravity'].long, 'Día');
});

test('#4533 — la fila muestra la fuente fidedigna del proveedor (CLI/API)', () => {
    assert.match(_mzProviderMatrixRow('anthropic'), /· CLI/, 'Anthropic: fuente CLI');
    assert.match(_mzProviderMatrixRow('openai-codex'), /· CLI/, 'Codex: fuente CLI');
    // #6861 — Antigravity autentica y mide cuota por el CLI `agy` (OAuth), ya
    // no por la API HTTP de AI Studio.
    assert.match(_mzProviderMatrixRow('antigravity'), /· CLI/, 'Antigravity: fuente CLI');
    // La fuente declarada en la meta coincide con lo renderizado.
    assert.equal(MZ_PROVIDER_META['antigravity'].src, 'CLI');
});

test('CA-A5 / security — un label con markup no produce HTML ejecutable (XSS)', () => {
    const evil = '<script>alert(1)</script>';
    const html = _mzWinCell('evilkey', 'short', evil);
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/, 'el markup no debe quedar sin escapar');
    assert.match(html, /&lt;script&gt;/, 'el label debe escaparse (escapeHtmlText)');
});

'use strict';

// #4249 — Bloque A: desglose de cuota POR PROVEEDOR en la home MIZPÁ.
//
// Contexto: el % real por proveedor depende del backend de extracción #4202
// (OPEN); hasta entonces las filas muestran "—" por diseño. Lo entregable AHORA
// (independiente de #4202) es la lista correcta de proveedores, derivada de una
// fuente única, con ids canónicos para hidratación futura y escapado seguro.
//
// Cubre:
//   * CA-A1 — aparece una fila por cada proveedor activo (≥5); NO aparece Groq.
//   * CA-A2 — la lista se deriva de una fuente única (MZ_PROVIDER_META), no de
//             un array fijo de 3: el render no se rompe al sumar un proveedor.
//   * CA-A3 — cada fila usa el id canónico `mz-quota-${bucket}-${key}-{bar,pct}`.
//   * CA-A5 / security — un `name` con markup no produce HTML ejecutable (XSS).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    _mzProviderRow,
    _mzProviderRows,
    MZ_PROVIDER_META,
    MZ_ACTIVE_PROVIDERS,
} = require('../views/dashboard/home');

// Proveedores activos esperados, alineados con multi-provider-health.json y
// ALLOWED_PROVIDERS (ids canónicos). Groq queda fuera (descontinuado #3353).
const EXPECTED_PROVIDERS = ['anthropic', 'openai-codex', 'gemini-google', 'cerebras', 'nvidia-nim'];

test('CA-A1 — _mzProviderRows renderiza una fila por cada proveedor activo (≥5)', () => {
    const html = _mzProviderRows('session');
    const rowCount = (html.match(/class="mz-prow"/g) || []).length;
    assert.ok(rowCount >= 5, `esperaba ≥5 filas de proveedor, hubo ${rowCount}`);
    assert.equal(rowCount, MZ_ACTIVE_PROVIDERS.length, 'la cantidad de filas debe igualar a los proveedores activos');
});

test('CA-A1 — Cerebras y NVIDIA NIM presentes; Groq ausente', () => {
    const html = _mzProviderRows('session');
    assert.match(html, /Cerebras/, 'falta la fila de Cerebras');
    assert.match(html, /NVIDIA NIM/, 'falta la fila de NVIDIA NIM');
    assert.doesNotMatch(html, /Groq/i, 'Groq fue descontinuado (#3353) y no debe renderizarse');
});

test('CA-A2 — la lista deriva de fuente única (MZ_PROVIDER_META), no de 3 hardcodeados', () => {
    // La fuente única debe contener exactamente los proveedores canónicos.
    assert.deepEqual(MZ_ACTIVE_PROVIDERS.slice().sort(), EXPECTED_PROVIDERS.slice().sort());
    assert.ok(MZ_ACTIVE_PROVIDERS.length > 3, 'la lista no puede ser un array fijo de 3');
    // Sumar un proveedor a la fuente debe reflejarse en el render sin tocar
    // _mzProviderRows. Simulamos derivando a mano desde la misma fuente.
    const derived = MZ_ACTIVE_PROVIDERS
        .map((k) => _mzProviderRow('session', k, MZ_PROVIDER_META[k].name, MZ_PROVIDER_META[k].color))
        .join('');
    assert.equal(derived, _mzProviderRows('session'), '_mzProviderRows debe derivar de MZ_PROVIDER_META');
});

test('CA-A3 — cada fila usa el id canónico mz-quota-${bucket}-${key}-{bar,pct}', () => {
    for (const bucket of ['session', 'week']) {
        const html = _mzProviderRows(bucket);
        for (const key of MZ_ACTIVE_PROVIDERS) {
            assert.ok(
                html.includes(`id="mz-quota-${bucket}-${key}-pct"`),
                `falta id de % para ${key} en bucket ${bucket}`,
            );
            assert.ok(
                html.includes(`id="mz-quota-${bucket}-${key}-bar"`),
                `falta id de barra para ${key} en bucket ${bucket}`,
            );
        }
    }
});

test('CA-A3 — el bucket distingue session de week en los ids', () => {
    const sess = _mzProviderRows('session');
    const week = _mzProviderRows('week');
    assert.match(sess, /id="mz-quota-session-anthropic-pct"/);
    assert.match(week, /id="mz-quota-week-anthropic-pct"/);
    assert.doesNotMatch(sess, /mz-quota-week-/);
});

test('CA-A5 / security — un name con markup no produce HTML ejecutable (XSS)', () => {
    const evil = '<script>alert(1)</script>';
    const html = _mzProviderRow('session', 'evilkey', evil, 'var(--in-warn,#d29922)');
    // El payload crudo no debe aparecer como tag ejecutable.
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/, 'el markup no debe quedar sin escapar');
    // Debe estar presente en forma escapada.
    assert.match(html, /&lt;script&gt;/, 'el name debe escaparse (escapeHtmlText)');
});

test('CA-UX2 — el estado pendiente "—" se marca como atenuado, no como 0%', () => {
    const html = _mzProviderRows('session');
    assert.match(html, /class="mz-ppct mz-ppct-pending"/, 'el % stub debe llevar la clase pending');
    assert.match(html, /Pendiente/, 'el title debe comunicar estado pendiente');
});

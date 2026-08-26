// =============================================================================
// result-badge.test.js — Cobertura del render PURO de badges del Historial del
// Commander (#3951 / EP7-H4).
//
// Estructura:
//   T-1  back-compat: meta null/no-objeto → '' (render sin badge, CA-5).
//   T-2  cada valor del enum produce su badge con glyph + label.
//   T-3  resultado fuera del enum → sin badge (lectura defensiva).
//   T-4  provider se renderiza como chip.
//   T-5  chip cross/same según sameProviderVerification; ausente → sin chip.
//   T-6  escape HTML de TODO campo dinámico (CA-4, stored XSS).
//   T-7  #6459 — el badge `huerfano` renderiza propio y no reusa el de error.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildResultBadges, RESULT_BADGES } = require('../result-badge');

// escapeHtml real inyectado (réplica del de dashboard.js) para verificar el
// contrato de escape sin depender de levantar el server del dashboard.
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// --- T-1 back-compat ----------------------------------------------------------
test('meta null/undefined/no-objeto → cadena vacía (sin badge, CA-5)', () => {
  assert.equal(buildResultBadges(null, escapeHtml), '');
  assert.equal(buildResultBadges(undefined, escapeHtml), '');
  assert.equal(buildResultBadges('no-objeto', escapeHtml), '');
  assert.equal(buildResultBadges(42, escapeHtml), '');
});

// --- T-2 enum → badge ---------------------------------------------------------
test('cada valor del enum produce badge con glyph + label + clase semántica', () => {
  for (const resultado of Object.keys(RESULT_BADGES)) {
    const html = buildResultBadges({ resultado }, escapeHtml);
    const { glyph, label } = RESULT_BADGES[resultado];
    assert.ok(html.includes(`cmd-result-${resultado}`), `falta clase para ${resultado}`);
    assert.ok(html.includes(glyph), `falta glyph para ${resultado}`);
    assert.ok(html.includes(label), `falta label para ${resultado}`);
  }
});

// --- T-3 valor fuera del enum -------------------------------------------------
test('resultado fuera del enum → sin badge de resultado (defensivo)', () => {
  const html = buildResultBadges({ resultado: 'inventado' }, escapeHtml);
  assert.ok(!html.includes('cmd-result-inventado'));
  assert.ok(!html.includes('cmd-result '));
});

// --- T-4 provider chip --------------------------------------------------------
test('provider se renderiza como chip cmd-provider', () => {
  const html = buildResultBadges({ resultado: 'ok', provider: 'gemini-google' }, escapeHtml);
  assert.ok(html.includes('cmd-provider'));
  assert.ok(html.includes('gemini-google'));
});

test('sin provider → no se renderiza chip de provider', () => {
  const html = buildResultBadges({ resultado: 'ok' }, escapeHtml);
  assert.ok(!html.includes('cmd-provider'));
});

// --- T-5 chip cross/same ------------------------------------------------------
test('sameProviderVerification true → chip same-provider', () => {
  const html = buildResultBadges({ resultado: 'ok', sameProviderVerification: true }, escapeHtml);
  assert.ok(html.includes('cmd-verif-same'));
  assert.ok(html.includes('same-provider'));
  assert.ok(!html.includes('cmd-verif-cross'));
});

test('sameProviderVerification false → chip cross-provider', () => {
  const html = buildResultBadges({ resultado: 'ok', sameProviderVerification: false }, escapeHtml);
  assert.ok(html.includes('cmd-verif-cross'));
  assert.ok(html.includes('cross-provider'));
  assert.ok(!html.includes('cmd-verif-same'));
});

test('sameProviderVerification ausente (no boolean) → sin chip de verificación', () => {
  const html = buildResultBadges({ resultado: 'ok' }, escapeHtml);
  assert.ok(!html.includes('cmd-verif'));
});

// --- T-6 escape HTML (CA-4 / stored XSS) --------------------------------------
test('todo campo dinámico pasa por escapeHtml — provider malicioso se escapa', () => {
  const html = buildResultBadges({ resultado: 'ok', provider: '<img src=x onerror=alert(1)>' }, escapeHtml);
  assert.ok(!html.includes('<img'), 'el HTML crudo del provider NO debe aparecer sin escapar');
  assert.ok(html.includes('&lt;img'), 'el provider debe aparecer escapado');
});

test('caso completo (ok + provider + cross) produce los 3 fragmentos', () => {
  const html = buildResultBadges({
    resultado: 'fallback',
    provider: 'cerebras',
    sameProviderVerification: false,
  }, escapeHtml);
  assert.ok(html.includes('cmd-result-fallback'));
  assert.ok(html.includes('cmd-provider'));
  assert.ok(html.includes('cerebras'));
  assert.ok(html.includes('cmd-verif-cross'));
});

test('funciona con el escape interno por defecto (sin inyectar escapeHtml)', () => {
  const html = buildResultBadges({ resultado: 'ok', provider: '<x>' });
  assert.ok(html.includes('&lt;x&gt;'));
});

// --- T-7 #6459 · badge `huerfano` ---------------------------------------------
test('#6459: huerfano renderiza badge PROPIO (no cadena vacía) con su clase', () => {
  const html = buildResultBadges({ resultado: 'huerfano' }, escapeHtml);
  assert.notEqual(html, '', 'el badge no puede quedar vacío: sería indistinguible de un log viejo');
  assert.ok(html.includes('cmd-result-huerfano'), 'falta la clase semántica');
  assert.ok(html.includes('∅'), 'falta el glifo');
  assert.ok(html.includes('hu&#233;rfano') || html.includes('huérfano'), 'falta la etiqueta');
  // CA-4: el color no es la única señal — glifo + etiqueta siempre presentes.
  assert.ok(!html.includes('cmd-result-error'), 'no reusa el badge de error');
});

test('#6459: R-7 — la clase CSS sale del enum SIN tilde, la tilde vive en el texto', () => {
  const { glyph, label, title } = RESULT_BADGES.huerfano;
  assert.equal(glyph, '∅');
  assert.equal(label, 'huérfano');       // texto para el operador: CON tilde
  assert.ok(/nunca se confirm/.test(title));
  const html = buildResultBadges({ resultado: 'huerfano' }, escapeHtml);
  assert.ok(!html.includes('cmd-result-huérfano'), 'la clase NO puede llevar tilde');
});

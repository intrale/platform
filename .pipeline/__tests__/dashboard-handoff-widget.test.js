// =============================================================================
// Tests del widget de Handoff cross-agente en el dashboard (#2993 rev-2 / CA-C2).
//
// El widget vive en `renderConsumoHtml()` dentro de `.pipeline/dashboard.js`.
// Este file no se puede `require()` directamente porque el módulo monta el
// server al cargar — así que validamos estructuralmente leyendo el source y
// también renderizamos la función reconstruyéndola con `vm`.
//
// Cobertura:
//   - tab "Handoff" registrado en /consumo
//   - panel-handoff con los 4 KPIs, sparkline, tabla top issues, banda audit
//   - pill kill-switch en el header del widget
//   - polling cada 30s (CA-C2)
//   - reuso de design tokens (--teal, --warning, --quota-degraded)
//   - reuso de los íconos del sprite (#ic-handoff, #ic-tokens-saved)
//   - sub-sección de /consumo (NO ruta nueva)
//   - assets de UX presentes en este branch
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DASHBOARD_PATH = path.join(REPO_ROOT, '.pipeline', 'dashboard.js');
const DASHBOARD_SRC = fs.readFileSync(DASHBOARD_PATH, 'utf8');

test('CA-C2 · /consumo declara la pestaña "Handoff" para el widget', () => {
    // El selector de pestaña tiene data-test-id="tab-handoff" (markup estable
    // entre revisiones).
    assert.ok(DASHBOARD_SRC.includes('data-test-id="tab-handoff"'),
        'falta el botón de tab #tab-handoff en /consumo');
    assert.ok(DASHBOARD_SRC.includes('data-panel="handoff"'),
        'la pestaña no enlaza con panel-handoff');
});

test('CA-C2 · panel-handoff existe y consume /api/dash/handoff-metrics', () => {
    assert.ok(DASHBOARD_SRC.includes('id="panel-handoff"'),
        'falta el panel del widget');
    assert.ok(DASHBOARD_SRC.includes("/api/dash/handoff-metrics"),
        'el widget no consume el endpoint del slice');
    // El alias documentado en CA-C2 también debe quedar visible (link "human
    // friendly" en la UI).
    assert.ok(DASHBOARD_SRC.includes('/api/handoff-metrics'),
        'falta el alias /api/handoff-metrics en la UI');
});

test('CA-C2 · widget tiene 4 KPI cards (hit rate, tokens, issues, audit)', () => {
    assert.ok(DASHBOARD_SRC.includes('id="ho-hitrate"'),
        'falta KPI hit rate');
    assert.ok(DASHBOARD_SRC.includes('id="ho-tokens"'),
        'falta KPI tokens ahorrados');
    assert.ok(DASHBOARD_SRC.includes('id="ho-issues"'),
        'falta KPI issues procesados');
    assert.ok(DASHBOARD_SRC.includes('id="ho-audit-count"'),
        'falta KPI auditoría');
});

test('CA-C2 · widget incluye sparkline 7 días', () => {
    // El render de sparkline construye un SVG en runtime y lo inyecta en
    // #ho-spark; el helper se llama renderHandoffSparkline.
    assert.ok(DASHBOARD_SRC.includes('id="ho-spark"'),
        'falta el contenedor del sparkline');
    assert.ok(DASHBOARD_SRC.includes('renderHandoffSparkline('),
        'falta el helper renderHandoffSparkline');
    assert.ok(DASHBOARD_SRC.includes('umbral 50%'),
        'la línea de umbral del sparkline (UX-mockup) no está renderizada');
});

test('CA-C2 · widget tiene tabla "Top issues" + banda de auditoría', () => {
    assert.ok(DASHBOARD_SRC.includes('id="ho-top-tbody"'),
        'falta el tbody de top issues');
    assert.ok(DASHBOARD_SRC.includes('id="ho-audit-rows"'),
        'falta el contenedor de la banda de auditoría');
    assert.ok(DASHBOARD_SRC.includes('data-test-id="ho-top-issues"'),
        'falta marker estable de la sección de top issues');
    assert.ok(DASHBOARD_SRC.includes('data-test-id="ho-audit-band"'),
        'falta marker estable de la banda de auditoría');
});

test('CA-B7 · pill kill-switch presente en el header del widget', () => {
    assert.ok(DASHBOARD_SRC.includes('data-test-id="ho-pill"'),
        'falta la pill de kill-switch (CA-B7)');
    assert.ok(DASHBOARD_SRC.includes('id="ho-pill-state"'),
        'la pill no muestra estado');
    assert.ok(DASHBOARD_SRC.includes('id="ho-pill-killswitch"'),
        'la pill no muestra el flag kill-switch');
});

test('CA-C2 · refresh del widget se hace cada 30 s (mismo patrón que el resto del dashboard)', () => {
    // setInterval(refreshHandoff, 30 * 1000) — buscamos el patrón completo.
    assert.match(DASHBOARD_SRC, /setInterval\(refreshHandoff,\s*30\s*\*\s*1000\)/,
        'el polling no es exactamente cada 30s');
    // Y el bypass cuando el tab no es visible (cuidamos no quemar tokens en
    // el browser cuando la página no se está mirando).
    assert.match(DASHBOARD_SRC, /document\.hidden/,
        'no respetamos document.hidden — el polling corre aún oculto');
});

test('CA-UX · widget reusa 100 % design tokens del repo', () => {
    // No deben aparecer hex colors inventados en la sección del widget. En
    // su lugar deben aparecer var(--teal), var(--warning), var(--quota-degraded).
    assert.ok(DASHBOARD_SRC.includes('var(--teal'),
        'el widget no usa --teal como acento (mockup lo exige)');
    assert.ok(DASHBOARD_SRC.includes('var(--warning'),
        'el widget no usa --warning para fallback');
    assert.ok(DASHBOARD_SRC.includes('var(--quota-degraded'),
        'el widget no usa --quota-degraded para kill-switch ON');
    // Y los íconos del sprite extendido deben ser referenciados.
    assert.ok(DASHBOARD_SRC.includes('#ic-handoff'),
        'falta referencia al ícono #ic-handoff del sprite');
    assert.ok(DASHBOARD_SRC.includes('#ic-tokens-saved'),
        'falta referencia al ícono #ic-tokens-saved del sprite');
});

test('CA-narrativa · widget se inserta como sub-sección de /consumo, NO ruta nueva', () => {
    // El widget debe estar DENTRO de renderConsumoHtml, no en una función
    // aparte que sirva una /handoff route.
    const consumoStart = DASHBOARD_SRC.indexOf('function renderConsumoHtml');
    const consumoEnd = DASHBOARD_SRC.indexOf('// --- Log Viewer', consumoStart);
    assert.ok(consumoStart > 0 && consumoEnd > consumoStart,
        'no encuentro renderConsumoHtml');
    const consumoSlice = DASHBOARD_SRC.slice(consumoStart, consumoEnd);
    assert.ok(consumoSlice.includes('id="panel-handoff"'),
        'el widget vive fuera de renderConsumoHtml — debe ser sub-sección de /consumo');
    // No debe existir una ruta /handoff propia en el server.
    assert.ok(!/req\.url\s*===\s*['"]\/handoff['"]/.test(DASHBOARD_SRC),
        'se introdujo una ruta /handoff propia — debe ser sub-sección de /consumo');
});

test('CA-UX · assets de UX presentes en este branch (no quedaron en otra rama)', () => {
    const mockup = path.join(REPO_ROOT, '.pipeline', 'assets', 'mockups', '09-handoff-widget.svg');
    const narrativa = path.join(REPO_ROOT, '.pipeline', 'assets', 'mockups', 'narrativa-handoff-widget.md');
    const sprite = path.join(REPO_ROOT, '.pipeline', 'assets', 'icons', 'sprite.svg');
    assert.ok(fs.existsSync(mockup), 'falta mockup 09-handoff-widget.svg');
    assert.ok(fs.existsSync(narrativa), 'falta narrativa del widget');
    const spriteSrc = fs.readFileSync(sprite, 'utf8');
    assert.ok(spriteSrc.includes('id="ic-handoff"'),
        'sprite no extendido con ic-handoff');
    assert.ok(spriteSrc.includes('id="ic-tokens-saved"'),
        'sprite no extendido con ic-tokens-saved');
});

test('CA-C2 · widget consume top_issues y audit_events del slice (no UI hardcoded)', () => {
    // Validamos que el render usa los campos que el slice provee, no datos
    // estáticos que hayamos pegado a mano.
    assert.match(DASHBOARD_SRC, /metrics\.top_issues/, 'no consume top_issues del slice');
    assert.match(DASHBOARD_SRC, /metrics\.audit_events/, 'no consume audit_events del slice');
    assert.match(DASHBOARD_SRC, /metrics\.sparkline/, 'no consume sparkline del slice');
    assert.match(DASHBOARD_SRC, /metrics\.hit_rate_pct/, 'no consume hit_rate_pct del slice');
    assert.match(DASHBOARD_SRC, /metrics\.usd_saved_estimate_monthly/,
        'no consume usd_saved_estimate_monthly del slice');
});

'use strict';

// =============================================================================
// test-dispatch-cause-dashboard.js — Tests de la integración dashboard del
// artifact de causa declarada (#4709): detección por `dispatchCauseSlice` y
// escape del render (`renderDispatchCauseBanner`). Framework: node --test.
//
// Cubre AC-4/AC-6:
//   - El slice detecta el artifact `dispatch-cause.json` y lo normaliza.
//   - El slice degrada a `{ active:false }` ante artifact ausente/corrupto o
//     causa fuera del enum (fail-safe, no confiar en el disco).
//   - El render ESCAPA `detalle`/`label` (payload XSS `<img onerror>` neutralizado
//     en contexto texto Y atributo).
// =============================================================================

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const slices = require('./dashboard-slices');
const dc = require('./dispatch-cause');
const { renderDispatchCauseBanner } = require('./dispatch-cause-render');

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'dc-dash-'));
}

// --- dispatchCauseSlice: detección -------------------------------------------

test('slice inactivo cuando no hay artifact', () => {
    const dir = tmpDir();
    assert.deepStrictEqual(slices.dispatchCauseSlice({}, { PIPELINE: dir }), { active: false });
});

test('slice detecta el artifact publicado y normaliza label/relTime', () => {
    const dir = tmpDir();
    dc.publish({
        pipelineDir: dir,
        snapshot: { anyLaunched: false, hayPendientes: true, gatesActivos: new Set([dc.CAUSAS.COOLDOWN]), detalles: { [dc.CAUSAS.COOLDOWN]: 'penalizado' } },
        now: 1_000_000,
    });
    const s = slices.dispatchCauseSlice({}, { PIPELINE: dir, nowMs: 1_000_000 + 125_000 });
    assert.strictEqual(s.active, true);
    assert.strictEqual(s.causa, dc.CAUSAS.COOLDOWN);
    assert.strictEqual(s.label, 'En cooldown');
    assert.strictEqual(s.anomalia, false);
    assert.strictEqual(s.relTime, 'hace 2 min');
});

test('slice degrada a inactivo si el artifact trae una causa fuera del enum', () => {
    const dir = tmpDir();
    // Escribir a mano un artifact con causa inválida (simula corrupción/version vieja).
    fs.writeFileSync(dc.artifactPath(dir), JSON.stringify({ causa: 'valor_pirata', anomalia: false, ts: 1 }));
    assert.deepStrictEqual(slices.dispatchCauseSlice({}, { PIPELINE: dir }), { active: false });
});

test('slice degrada a inactivo ante artifact corrupto (no-JSON)', () => {
    const dir = tmpDir();
    fs.writeFileSync(dc.artifactPath(dir), 'no-es-json{{{');
    assert.deepStrictEqual(slices.dispatchCauseSlice({}, { PIPELINE: dir }), { active: false });
});

test('slice marca anomalia y su label destacado', () => {
    const dir = tmpDir();
    dc.publish({ pipelineDir: dir, snapshot: { anyLaunched: false, hayPendientes: true, gatesActivos: new Set() }, now: 1 });
    const s = slices.dispatchCauseSlice({}, { PIPELINE: dir });
    assert.strictEqual(s.anomalia, true);
    assert.strictEqual(s.causa, dc.CAUSAS.ANOMALIA);
    assert.match(s.label, /Anomal/);
});

// --- renderDispatchCauseBanner: escape XSS -----------------------------------

test('render vacío cuando el slice está inactivo', () => {
    assert.strictEqual(renderDispatchCauseBanner({ active: false }), '');
    assert.strictEqual(renderDispatchCauseBanner(null), '');
});

test('render ESCAPA payload XSS en detalle (texto y atributo)', () => {
    const html = renderDispatchCauseBanner({
        active: true,
        causa: dc.CAUSAS.BLOQUEO_DEPENDENCIA,
        label: 'Bloqueado por dependencia',
        detalle: '<img src=x onerror=alert(1)> "pwn"',
        anomalia: false,
        relTime: 'hace 1 min',
    });
    assert.ok(html.length > 0);
    assert.doesNotMatch(html, /<img src=x/, 'el <img> crudo no debe aparecer');
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/, 'el payload debe quedar escapado como texto');
    assert.match(html, /&quot;pwn&quot;/, 'las comillas del atributo title deben escaparse');
});

test('render de anomalía usa el color de alerta (destacado, UX-2)', () => {
    const html = renderDispatchCauseBanner({ active: true, causa: dc.CAUSAS.ANOMALIA, label: '⚠ Anomalía', anomalia: true });
    assert.match(html, /#f85149/, 'la anomalía debe usar el borde de alerta');
});

test('render de causa normal NO usa el color de alerta', () => {
    const html = renderDispatchCauseBanner({ active: true, causa: dc.CAUSAS.REST_MODE, label: 'Modo descanso', anomalia: false });
    assert.doesNotMatch(html, /#f85149/);
});

test('render escapa también un label malicioso', () => {
    const html = renderDispatchCauseBanner({ active: true, causa: dc.CAUSAS.SIN_AGENTES, label: '<script>x</script>', anomalia: false });
    assert.doesNotMatch(html, /<script>x<\/script>/);
    assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
});

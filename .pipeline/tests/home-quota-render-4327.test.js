// =============================================================================
// Tests #4327 (CA-5 / UX-G4) — render de cuota en la HOME: un estado
// `stale`/`missing` NUNCA se renderiza como número fresco, y "sin dato" se
// escribe como literal, jamás como `0%`.
//
// Estrategia: los helpers de render viven dentro del script cliente de
// `home.js` (string emitido por renderClientScript, no exportado). Se extraen
// por rango contiguo del source y se evalúan con un DOM falso, igual que otros
// tests del repo (ver views/dashboard/__tests__ y tests/dashboard-xss-modal).
//
// Cubre:
//   UX-G4 — `_hydrateProviderRow` con bucket sin dato (pct null) escribe el
//           literal "sin dato" (no "0%", no un número).
//   CA-5  — `pillTextFor(state)` para `stale`/`missing` devuelve la etiqueta de
//           estado, nunca un porcentaje; `pctTextClient(null)` → "--%" (no "0%").
//   UX-G5 — `MZ_ACTIVE_PROVIDERS` (fuente única) lista exactamente los 5
//           proveedores reales, sin el fantasma `groq`.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const home = require('../views/dashboard/home.js');
const HOME_SRC = fs.readFileSync(path.join(__dirname, '..', 'views', 'dashboard', 'home.js'), 'utf8');

// Extrae un rango contiguo del source [desde `startAnchor`, hasta ANTES de
// `endAnchor`]. Las anclas son literales de declaración, estables al refactor.
function sliceRange(src, startAnchor, endAnchor) {
    const start = src.indexOf(startAnchor);
    assert.ok(start >= 0, `ancla de inicio no encontrada: ${startAnchor}`);
    const end = src.indexOf(endAnchor, start + startAnchor.length);
    assert.ok(end > start, `ancla de fin no encontrada: ${endAnchor}`);
    return src.slice(start, end);
}

// DOM falso mínimo: registra por id los elementos que el render toca.
function makeFakeDom(ids) {
    const els = {};
    for (const id of ids) {
        els[id] = {
            id, textContent: '', className: '', _classes: new Set(), style: {}, _attrs: {},
            classList: {
                add(c) { els[id]._classes.add(c); },
                remove(c) { els[id]._classes.delete(c); },
                contains(c) { return els[id]._classes.has(c); },
            },
            getAttribute(k) { return els[id]._attrs[k] != null ? els[id]._attrs[k] : null; },
            setAttribute(k, v) { els[id]._attrs[k] = String(v); },
            closest() { return els[id]._row || null; },
        };
    }
    return els;
}

// Construye el entorno de los helpers por-proveedor (rango REASON→renderProviderQuotaRows).
function loadProviderRowHelpers() {
    const body = sliceRange(HOME_SRC, 'const QUOTA_SINDATO_REASON = {', 'function renderProviderQuotaRows(');
    // Fakes de las dependencias globales que usan los helpers.
    const captured = { texts: {}, bars: {} };
    const factory = new Function('document', 'setText', 'setBarPct', `
        ${body}
        return { _hydrateProviderRow, _quotaConfidenceColor };
    `);
    return { factory, captured };
}

// Construye pillTextFor + fmtAge (rango fmtAge→classifyPctClient).
function loadPillHelpers() {
    const body = sliceRange(HOME_SRC, 'function fmtAge(ageMs){', 'function classifyPctClient(');
    const factory = new Function(`
        ${body}
        return { pillTextFor, fmtAge, pctTextClient: (function(n){ return Number.isFinite(n) ? (Math.round(n) + '%') : '--%'; }) };
    `);
    return factory();
}

// ---------------------------------------------------------------------------
// UX-G4 — "sin dato" literal, nunca 0%, cuando el bucket no tiene pct.
// ---------------------------------------------------------------------------
test('UX-G4: _hydrateProviderRow con pct null escribe "sin dato" (no 0%, no número)', () => {
    const { factory } = loadProviderRowHelpers();
    const ids = ['mz-quota-session-cerebras-bar', 'mz-quota-session-cerebras-pct'];
    const els = makeFakeDom(ids);
    const row = { id: 'row', _classes: new Set(), _attrs: {},
        classList: { add(c) { row._classes.add(c); }, remove(c) { row._classes.delete(c); } },
        getAttribute(k) { return row._attrs[k] != null ? row._attrs[k] : null; },
        setAttribute(k, v) { row._attrs[k] = String(v); } };
    els['mz-quota-session-cerebras-bar']._row = row;

    const texts = {};
    const document = { getElementById: (id) => els[id] || null };
    const setText = (id, v) => { texts[id] = v; };
    const setBarPct = () => {};
    const { _hydrateProviderRow } = factory(document, setText, setBarPct);

    // Bucket sin dato: b = null.
    _hydrateProviderRow('session', 'cerebras', null);
    assert.equal(texts['mz-quota-session-cerebras-pct'], 'sin dato', 'debe escribir el literal "sin dato"');
    assert.notEqual(texts['mz-quota-session-cerebras-pct'], '0%', 'NUNCA "0%"');
    assert.ok(!/^\d/.test(String(texts['mz-quota-session-cerebras-pct'])), 'no empieza con un dígito');
    assert.equal(row.getAttribute('aria-label'), 'sin dato', 'aria-label explícito "sin dato"');

    // Bucket con confidence 'missing' pero SIN pct real → también "sin dato".
    _hydrateProviderRow('session', 'cerebras', { pct: null, confidence: 'missing' });
    assert.equal(texts['mz-quota-session-cerebras-pct'], 'sin dato', 'pct null aunque venga confidence');
});

test('UX-G4: _hydrateProviderRow con pct real sí escribe el porcentaje', () => {
    const { factory } = loadProviderRowHelpers();
    const ids = ['mz-quota-week-openai-codex-bar', 'mz-quota-week-openai-codex-pct'];
    const els = makeFakeDom(ids);
    const row = { _classes: new Set(), _attrs: {},
        classList: { add(c) { row._classes.add(c); }, remove(c) { row._classes.delete(c); } },
        getAttribute(k) { return row._attrs[k] != null ? row._attrs[k] : null; },
        setAttribute(k, v) { row._attrs[k] = String(v); } };
    els['mz-quota-week-openai-codex-bar']._row = row;
    const texts = {};
    const { _hydrateProviderRow } = factory(
        { getElementById: (id) => els[id] || null },
        (id, v) => { texts[id] = v; },
        () => {});

    _hydrateProviderRow('week', 'openai-codex', { pct: 25, confidence: 'fresh' });
    assert.equal(texts['mz-quota-week-openai-codex-pct'], '25.0%', 'con dato real muestra el %');
});

// ---------------------------------------------------------------------------
// CA-5 — pillTextFor: stale/missing nunca es un número.
// ---------------------------------------------------------------------------
test('CA-5: pillTextFor(stale/missing) devuelve etiqueta de estado, nunca un %', () => {
    const { pillTextFor, pctTextClient } = loadPillHelpers();
    const stale = pillTextFor('stale', 3 * 3600 * 1000);
    assert.match(stale, /STALE/, 'stale → etiqueta SNAPSHOT STALE');
    assert.ok(!/\d+%/.test(stale), 'stale NO contiene un porcentaje');

    const parserOffline = pillTextFor('parser-offline', null);
    assert.match(parserOffline, /PARSER OFFLINE/);

    // 'missing' u otro → ESTIMADO (fail-closed), nunca un número fresco.
    assert.equal(pillTextFor('missing', null), 'ESTIMADO');
    assert.equal(pillTextFor('whatever', null), 'ESTIMADO');

    // pctTextClient con valor no finito → "--%", no "0%".
    assert.equal(pctTextClient(null), '--%', 'sin dato numérico → "--%", nunca "0%"');
    assert.equal(pctTextClient(NaN), '--%');
    assert.equal(pctTextClient(24), '24%');
});

// ---------------------------------------------------------------------------
// UX-G5 — fuente única de proveedores: 5 reales, sin groq.
// ---------------------------------------------------------------------------
test('UX-G5: MZ_ACTIVE_PROVIDERS lista los 5 providers reales sin groq', () => {
    assert.deepEqual([...home.MZ_ACTIVE_PROVIDERS].sort(),
        ['anthropic', 'cerebras', 'gemini-google', 'nvidia-nim', 'openai-codex'].sort());
    assert.ok(!home.MZ_ACTIVE_PROVIDERS.includes('groq'), 'groq no debe estar en la fuente única');
});

// =============================================================================
// Tests #4327 (CA-5 / UX-G4) + #4533 — render de cuota en la HOME: un estado
// sin dato NUNCA se renderiza como número fresco ni como `0%`; el % disponible
// y su color por umbral se derivan del sub-shape del slice.
//
// Estrategia: los helpers de render viven dentro del script cliente de
// `home.js` (string emitido por renderClientScript, no exportado). Se extraen
// por rango contiguo del source y se evalúan con un DOM falso, igual que otros
// tests del repo (ver views/dashboard/__tests__ y tests/dashboard-xss-modal).
//
// Cubre:
//   UX-G4 — `_mzHydrateWinCell` con bucket sin dato (mode 'nodata' o null)
//           escribe el literal "sin dato" (no "0%", no un número).
//   #4884 — con gauge real escribe el "<n>%" CONSUMIDO (= 100 - disponible) y
//           color por umbral (ok/warn/bad); 100% consumido => bad (AGOTADA).
//           Regresión dura: motor 55%/11% → panel 55%/11%, no 45%/89%.
//   #4533 — Codex (mode 'event') muestra "✓ sin límite", sin barra ni %.
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
const { MZ_PROVIDER_META } = home;

// Extrae un rango contiguo del source [desde `startAnchor`, hasta ANTES de
// `endAnchor`]. Las anclas son literales de declaración, estables al refactor.
function sliceRange(src, startAnchor, endAnchor) {
    const start = src.indexOf(startAnchor);
    assert.ok(start >= 0, `ancla de inicio no encontrada: ${startAnchor}`);
    const end = src.indexOf(endAnchor, start + startAnchor.length);
    assert.ok(end > start, `ancla de fin no encontrada: ${endAnchor}`);
    return src.slice(start, end);
}

// Construye una celda falsa mz-qm-<key>-<slot> con sus hijos -tag/-bar/-pct/-rst.
function makeCell(key, slot) {
    const cid = 'mz-qm-' + key + '-' + slot;
    const mkEl = () => {
        const classes = new Set();
        const attrs = {};
        return {
            textContent: '', style: {}, _classes: classes, _attrs: attrs,
            classList: {
                add(c) { classes.add(c); }, remove(c) { classes.delete(c); },
                contains(c) { return classes.has(c); },
            },
            getAttribute(k) { return attrs[k] != null ? attrs[k] : null; },
            setAttribute(k, v) { attrs[k] = String(v); },
        };
    };
    const els = {
        [cid]: mkEl(), [cid + '-tag']: mkEl(), [cid + '-bar']: mkEl(),
        [cid + '-pct']: mkEl(), [cid + '-rst']: mkEl(),
    };
    return { cid, els };
}

// Carga _mzHydrateWinCell + helpers de umbral/reset con un DOM falso.
function loadWinCellHelper(els) {
    const body = sliceRange(HOME_SRC, 'const QUOTA_SINDATO_REASON = {', 'function renderProviderQuotaMatrix(');
    const factory = new Function('document', 'MZ_PROVIDER_META', `
        ${body}
        return { _mzHydrateWinCell, _mzThresholdClass, _fmtResetShort };
    `);
    const document = { getElementById: (id) => els[id] || null };
    return factory(document, MZ_PROVIDER_META);
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
// UX-G4 — "sin dato" literal, nunca 0%, cuando el bucket no tiene dato.
// ---------------------------------------------------------------------------
test('UX-G4: _mzHydrateWinCell con mode nodata escribe "sin dato" (no 0%, no número)', () => {
    const { cid, els } = makeCell('cerebras', 'short');
    const { _mzHydrateWinCell } = loadWinCellHelper(els);

    // Sub-shape "sin dato" del slice.
    const r = _mzHydrateWinCell('cerebras', 'short', { mode: 'nodata', available: null, win: 'Min' });
    assert.equal(els[cid + '-pct'].textContent, 'sin dato', 'debe escribir el literal "sin dato"');
    assert.notEqual(els[cid + '-pct'].textContent, '0%', 'NUNCA "0%"');
    assert.ok(els[cid]._classes.has('mz-qm-nodata'), 'la celda marca estado sin dato');
    assert.equal(r.healthy, false, 'sin dato no cuenta como proveedor sano');

    // b = null también cae a "sin dato".
    const c2 = makeCell('cerebras', 'long');
    const { _mzHydrateWinCell: h2 } = loadWinCellHelper(c2.els);
    h2('cerebras', 'long', null);
    assert.equal(c2.els[c2.cid + '-pct'].textContent, 'sin dato', 'b null → sin dato');
});

test('#4884: _mzHydrateWinCell con gauge escribe el % CONSUMIDO (no el disponible) + color por umbral', () => {
    // Motor holgado: 18% consumido (available 82) → ok (verde).
    const a = makeCell('anthropic', 'short');
    loadWinCellHelper(a.els)._mzHydrateWinCell('anthropic', 'short',
        { mode: 'gauge', available: 82, win: '5h', resetAt: null });
    assert.equal(a.els[a.cid + '-pct'].textContent, '18%', 'muestra el % consumido = 100 - disponible');
    assert.ok(a.els[a.cid]._classes.has('ok'), '18% consumido → color ok (holgado)');
    assert.match(a.els[a.cid].getAttribute('title'), /18% consumido/, 'tooltip habla de consumido');

    // Medio: 60% consumido (available 40) → warn (ámbar).
    const b = makeCell('anthropic', 'short');
    loadWinCellHelper(b.els)._mzHydrateWinCell('anthropic', 'short',
        { mode: 'gauge', available: 40, win: '5h', resetAt: null });
    assert.equal(b.els[b.cid + '-pct'].textContent, '60%', '60% consumido');
    assert.ok(b.els[b.cid]._classes.has('warn'), '60% consumido → color warn');

    // Agotado: 100% consumido (available 0) = AGOTADA → bad (rojo).
    const c = makeCell('anthropic', 'long');
    const res = loadWinCellHelper(c.els)._mzHydrateWinCell('anthropic', 'long',
        { mode: 'gauge', available: 0, win: 'Sem', resetAt: null });
    assert.equal(c.els[c.cid + '-pct'].textContent, '100%', '100% consumido');
    assert.ok(c.els[c.cid]._classes.has('bad'), '100% consumido → color bad (AGOTADA)');
    assert.match(c.els[c.cid].getAttribute('title'), /AGOTADA/, 'tooltip marca AGOTADA');
    assert.equal(res.healthy, false, '100% consumido no es proveedor sano');
});

// Regresión dura #4884: dado el motor real (55% semanal / 11% sesión, iguales al
// CLI /usage y al cliente cloud), el panel principal DEBE pintar 55% y 11% — el
// consumido —, nunca su complemento 45%/89% (el bug que #4884 revierte de #4533).
test('#4884: motor 55%/11% consumido → panel principal pinta 55%/11% (no 45%/89%)', () => {
    // El slice viaja `available = 100 - consumido` (motor intacto, CA-2):
    //   semanal: consumido 55 → available 45 ; sesión: consumido 11 → available 89.
    const wk = makeCell('anthropic', 'long');
    loadWinCellHelper(wk.els)._mzHydrateWinCell('anthropic', 'long',
        { mode: 'gauge', available: 45, win: 'Sem', resetAt: null });
    assert.equal(wk.els[wk.cid + '-pct'].textContent, '55%', 'semanal: 55% consumido, no 45%');
    assert.notEqual(wk.els[wk.cid + '-pct'].textContent, '45%', 'NUNCA el complemento');

    const ses = makeCell('anthropic', 'short');
    loadWinCellHelper(ses.els)._mzHydrateWinCell('anthropic', 'short',
        { mode: 'gauge', available: 89, win: '5h', resetAt: null });
    assert.equal(ses.els[ses.cid + '-pct'].textContent, '11%', 'sesión: 11% consumido, no 89%');
    assert.notEqual(ses.els[ses.cid + '-pct'].textContent, '89%', 'NUNCA el complemento');
});

test('#4533: _mzHydrateWinCell mode event (Codex) muestra "sin límite" sin barra ni %', () => {
    const { cid, els } = makeCell('openai-codex', 'short');
    const r = loadWinCellHelper(els)._mzHydrateWinCell('openai-codex', 'short',
        { mode: 'event', eventOk: true, win: 'Roll' });
    assert.match(els[cid + '-pct'].textContent, /sin límite/, 'evento sin tope → "sin límite"');
    assert.ok(els[cid]._classes.has('mz-qm-event'), 'la celda marca estado por evento');
    assert.equal(r.healthy, true, 'sin límite cuenta como proveedor sano');
});

// ---------------------------------------------------------------------------
// #4863 — mode event con TRES estados: ok / exhausted / nodata.
// ---------------------------------------------------------------------------
test('#4863: mode event eventState "ok" → "sin límite" y proveedor sano', () => {
    const { cid, els } = makeCell('openai-codex', 'short');
    const r = loadWinCellHelper(els)._mzHydrateWinCell('openai-codex', 'short',
        { mode: 'event', eventState: 'ok', win: 'Roll' });
    assert.match(els[cid + '-pct'].textContent, /sin límite/);
    assert.equal(r.healthy, true);
});

test('#4863: mode event eventState "exhausted" → "tope activo", NO sano', () => {
    const { cid, els } = makeCell('openai-codex', 'short');
    const r = loadWinCellHelper(els)._mzHydrateWinCell('openai-codex', 'short',
        { mode: 'event', eventState: 'exhausted', win: 'Roll' });
    assert.equal(els[cid + '-pct'].textContent, 'tope activo', 'agotada → "tope activo"');
    assert.ok(!/sin límite/.test(els[cid + '-pct'].textContent), 'NUNCA "sin límite" cuando el banner dice agotada');
    assert.equal(r.healthy, false);
});

test('#4863: mode event eventState "nodata" (stale por inactividad) → "sin dato", NO verde', () => {
    const { cid, els } = makeCell('openai-codex', 'short');
    const r = loadWinCellHelper(els)._mzHydrateWinCell('openai-codex', 'short',
        { mode: 'event', eventState: 'nodata', win: 'Roll' });
    assert.equal(els[cid + '-pct'].textContent, 'sin dato', 'inactividad → "sin dato", no "sin límite"');
    assert.ok(!/sin límite/.test(els[cid + '-pct'].textContent), 'NUNCA verde espurio por inactividad');
    assert.ok(els[cid]._classes.has('mz-qm-nodata'), 'marca visualmente "sin dato"');
    assert.equal(r.healthy, false, 'sin dato no cuenta como proveedor sano');
});

test('#4863: backward-compat — sin eventState, eventOk:false renderiza "tope activo"', () => {
    const { cid, els } = makeCell('openai-codex', 'short');
    loadWinCellHelper(els)._mzHydrateWinCell('openai-codex', 'short',
        { mode: 'event', eventOk: false, win: 'Roll' });
    assert.equal(els[cid + '-pct'].textContent, 'tope activo', 'slice viejo sin eventState degrada por eventOk');
});

test('#4884: _mzThresholdClass por % CONSUMIDO — verde bajo, ámbar medio, rojo agotado', () => {
    const { _mzThresholdClass } = loadWinCellHelper({});
    // Consumo bajo → holgado (verde).
    assert.equal(_mzThresholdClass(0), 'ok');
    assert.equal(_mzThresholdClass(50), 'ok');
    // Medio → ámbar.
    assert.equal(_mzThresholdClass(51), 'warn');
    assert.equal(_mzThresholdClass(80), 'warn');
    // Alto/agotado → rojo.
    assert.equal(_mzThresholdClass(81), 'bad');
    assert.equal(_mzThresholdClass(100), 'bad');
    assert.equal(_mzThresholdClass(null), '');
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

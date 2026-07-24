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
//   #4533 — con % disponible real escribe "<n>%" y color por umbral
//           (ok/warn/bad); 0% disponible => bad (AGOTADA).
//   #4900 — Codex fresco sincroniza porcentaje, barra, color y accesibilidad.
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

test('#4533: _mzHydrateWinCell con % disponible real escribe el porcentaje + color por umbral', () => {
    // Holgado → ok (verde).
    const a = makeCell('anthropic', 'short');
    loadWinCellHelper(a.els)._mzHydrateWinCell('anthropic', 'short',
        { mode: 'gauge', available: 82, win: '5h', resetAt: null });
    assert.equal(a.els[a.cid + '-pct'].textContent, '82%', 'con dato real muestra el % disponible');
    assert.ok(a.els[a.cid]._classes.has('ok'), '82% disponible → color ok');

    // Medio → warn (ámbar).
    const b = makeCell('anthropic', 'short');
    loadWinCellHelper(b.els)._mzHydrateWinCell('anthropic', 'short',
        { mode: 'gauge', available: 40, win: '5h', resetAt: null });
    assert.ok(b.els[b.cid]._classes.has('warn'), '40% disponible → color warn');

    // Agotado → bad (rojo), 0% disponible = AGOTADA.
    const c = makeCell('anthropic', 'long');
    const res = loadWinCellHelper(c.els)._mzHydrateWinCell('anthropic', 'long',
        { mode: 'gauge', available: 0, win: 'Sem', resetAt: null });
    assert.equal(c.els[c.cid + '-pct'].textContent, '0%', '0% disponible');
    assert.ok(c.els[c.cid]._classes.has('bad'), '0% disponible → color bad (AGOTADA)');
    assert.match(c.els[c.cid].getAttribute('title'), /AGOTADA/, 'tooltip marca AGOTADA');
    assert.equal(res.healthy, false, '0% disponible no es proveedor sano');
});

test('#4900: Codex fresco sincroniza porcentaje, barra, color, title y aria-label', () => {
    const { cid, els } = makeCell('openai-codex', 'short');
    const r = loadWinCellHelper(els)._mzHydrateWinCell('openai-codex', 'short',
        { mode: 'event', eventState: 'ok', pct: 72.4, win: 'Roll' });
    assert.equal(els[cid + '-pct'].textContent, '72%');
    assert.equal(els[cid + '-bar'].style.width, '72%');
    assert.ok(els[cid]._classes.has('ok'));
    assert.match(els[cid].getAttribute('title'), /72%/);
    assert.match(els[cid].getAttribute('aria-label'), /72%/);
    assert.ok(els[cid]._classes.has('mz-qm-event'), 'la celda marca estado por evento');
    // #4900 rebote QA: el estado fresco DEBE marcarse con mz-qm-fresh para que el
    // CSS le muestre la mini-barra y el color por umbral (el override de evento
    // .mz-qm-event:not(.mz-qm-fresh) los ocultaba). Sin este marcador, el render
    // real muestra sólo el texto, sin barra ni color.
    assert.ok(els[cid]._classes.has('mz-qm-fresh'), 'estado fresco marca mz-qm-fresh (habilita barra+color)');
    assert.equal(r.healthy, true);
});

test('#4900 rebote QA: el CSS de evento excluye el estado fresco (barra+color visibles)', () => {
    // Regresión de la causa raíz del rechazo: las reglas .mz-qm-event ocultaban
    // la barra y forzaban color info, neutralizando lo que setea el JS. El fix
    // scopea esas reglas con :not(.mz-qm-fresh). Este test lee la fuente real
    // (no el DOM falso) para que un revert del CSS rompa la suite.
    assert.match(HOME_SRC, /\.mz-qm-cell\.mz-qm-event:not\(\.mz-qm-fresh\)\s+\.mz-qm-mini/,
        'el ocultado de la mini-barra debe excluir .mz-qm-fresh');
});

test('#4900 rebote PO: los estados categóricos coinciden con el mockup (exhausted rojo, sin dato gris)', () => {
    // Regresión del rechazo del PO (render vs mockup codex-quota-states.svg):
    // "tope activo" (exhausted) debe ser texto ROJO #f85149 y "sin dato" (nodata)
    // texto GRIS #6e7681, NO el chip azul info que aplicaba antes. Se lee la fuente
    // real para que revertir el color rompa la suite.
    // exhausted → rojo crítico (--in-bad / #f85149), sin chip azul.
    assert.match(HOME_SRC, /\.mz-qm-cell\.mz-qm-event\.mz-qm-exhausted\s+\.mz-qm-pct\s*\{[^}]*color:\s*var\(--in-bad,#f85149\)/,
        'exhausted debe renderizarse en rojo #f85149 (mockup), no como chip azul');
    // nodata → gris neutro (--in-fg-soft / #6e7681).
    assert.match(HOME_SRC, /\.mz-qm-cell\.mz-qm-nodata\s+\.mz-qm-pct\s*\{[^}]*color:\s*var\(--in-fg-soft,#6e7681\)/,
        'sin dato debe renderizarse en gris #6e7681 (mockup)');
    // El chip azul info (#58a6ff) ya NO debe aplicar a los estados categóricos.
    assert.doesNotMatch(HOME_SRC, /\.mz-qm-cell\.mz-qm-event:not\(\.mz-qm-fresh\)\s+\.mz-qm-pct\s*\{[^}]*#58a6ff/,
        'ningún estado categórico debe quedar con el chip azul info preexistente');
});

test('#4900: Codex fresco cubre límites 0/100 y umbrales cromáticos', () => {
    for (const [pct, cls, healthy] of [[0, 'bad', false], [20, 'warn', true], [50, 'ok', true], [100, 'ok', true]]) {
        const { cid, els } = makeCell('openai-codex', 'short');
        const r = loadWinCellHelper(els)._mzHydrateWinCell('openai-codex', 'short',
            { mode: 'event', eventState: 'ok', pct, win: 'Roll' });
        assert.equal(els[cid + '-pct'].textContent, pct + '%');
        assert.equal(els[cid + '-bar'].style.width, pct + '%');
        assert.ok(els[cid]._classes.has(cls));
        assert.equal(r.healthy, healthy);
    }
});

test('#4863: mode event eventState "exhausted" → "tope activo", NO sano', () => {
    const { cid, els } = makeCell('openai-codex', 'short');
    const r = loadWinCellHelper(els)._mzHydrateWinCell('openai-codex', 'short',
        { mode: 'event', eventState: 'exhausted', pct: 70, win: 'Roll' });
    assert.equal(els[cid + '-pct'].textContent, 'tope activo', 'agotada → "tope activo"');
    assert.ok(!/sin límite/.test(els[cid + '-pct'].textContent), 'NUNCA "sin límite" cuando el banner dice agotada');
    // exhausted es categórico: NO debe llevar mz-qm-fresh, así el override de
    // evento (sin barra) sigue aplicando en el render real.
    assert.ok(!els[cid]._classes.has('mz-qm-fresh'), 'exhausted no es estado fresco');
    // #4900 rebote PO: marca mz-qm-exhausted para que el CSS lo pinte en rojo
    // (#f85149, mockup) en vez del chip azul info preexistente.
    assert.ok(els[cid]._classes.has('mz-qm-exhausted'), 'exhausted marca mz-qm-exhausted (color rojo del mockup)');
    assert.equal(r.healthy, false);
});

test('#4863: mode event eventState "nodata" (stale por inactividad) → "sin dato", NO verde', () => {
    const { cid, els } = makeCell('openai-codex', 'short');
    const r = loadWinCellHelper(els)._mzHydrateWinCell('openai-codex', 'short',
        { mode: 'event', eventState: 'nodata', pct: 88, win: 'Roll' });
    assert.equal(els[cid + '-pct'].textContent, 'sin dato', 'inactividad → "sin dato", no "sin límite"');
    assert.ok(!/sin límite/.test(els[cid + '-pct'].textContent), 'NUNCA verde espurio por inactividad');
    assert.ok(els[cid]._classes.has('mz-qm-nodata'), 'marca visualmente "sin dato"');
    assert.equal(els[cid + '-bar'].style.width, '0%');
    assert.match(els[cid].getAttribute('title'), /sin dato/);
    assert.match(els[cid].getAttribute('aria-label'), /sin dato/);
    assert.equal(r.healthy, false, 'sin dato no cuenta como proveedor sano');
});

test('#4900: porcentaje Codex inválido degrada a "sin dato"', () => {
    for (const pct of [undefined, null, NaN, Infinity, -1, 101, '<img src=x onerror=alert(1)>']) {
        const { cid, els } = makeCell('openai-codex', 'short');
        const r = loadWinCellHelper(els)._mzHydrateWinCell('openai-codex', 'short',
            { mode: 'event', eventState: 'ok', pct, win: 'Roll' });
        assert.equal(els[cid + '-pct'].textContent, 'sin dato');
        assert.equal(els[cid + '-bar'].style.width, '0%');
        assert.ok(els[cid]._classes.has('mz-qm-nodata'));
        assert.ok(!els[cid]._classes.has('mz-qm-fresh'), 'sin dato no es estado fresco');
        assert.equal(r.healthy, false);
    }
});

test('#4863: backward-compat — sin eventState, eventOk:false renderiza "tope activo"', () => {
    const { cid, els } = makeCell('openai-codex', 'short');
    loadWinCellHelper(els)._mzHydrateWinCell('openai-codex', 'short',
        { mode: 'event', eventOk: false, win: 'Roll' });
    assert.equal(els[cid + '-pct'].textContent, 'tope activo', 'slice viejo sin eventState degrada por eventOk');
});

test('#4533: _mzThresholdClass respeta los umbrales verde/ámbar/rojo', () => {
    const { _mzThresholdClass } = loadWinCellHelper({});
    assert.equal(_mzThresholdClass(80), 'ok');
    assert.equal(_mzThresholdClass(50), 'ok');
    assert.equal(_mzThresholdClass(49), 'warn');
    assert.equal(_mzThresholdClass(20), 'warn');
    assert.equal(_mzThresholdClass(19), 'bad');
    assert.equal(_mzThresholdClass(0), 'bad');
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

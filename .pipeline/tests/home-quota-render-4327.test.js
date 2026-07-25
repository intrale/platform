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
//   #4884 — ANTHROPIC (y solo Anthropic) con gauge real escribe el "<n>%"
//           CONSUMIDO y su color por umbral (ok/warn/bad); 100% consumido =>
//           bad (AGOTADA). Regresión dura: motor 55%/11% → panel 55%/11%, no
//           45%/89%.
//   #4884 CA-5 — ALCANCE: los demás gauge (free-tiers gemini/cerebras/nvidia/
//           kimi) siguen pintando su % DISPONIBLE sin invertir, y su copy sigue
//           diciendo "disponible" (celda + skeleton).
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
        return { _mzHydrateWinCell, _mzThresholdClass, _mzConsumedClass, _fmtResetShort };
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

test('#4884: ANTHROPIC gauge escribe el % CONSUMIDO (no el disponible) + color por umbral', () => {
    // El slice de Anthropic viaja `pct` (consumido crudo del motor) y
    // `available = 100 - pct` (provider-quota.js:340). Se pinta `pct`.
    // Motor holgado: 18% consumido → ok (verde).
    const a = makeCell('anthropic', 'short');
    loadWinCellHelper(a.els)._mzHydrateWinCell('anthropic', 'short',
        { mode: 'gauge', pct: 18, available: 82, win: '5h', resetAt: null });
    assert.equal(a.els[a.cid + '-pct'].textContent, '18%', 'muestra el % consumido del motor');
    assert.ok(a.els[a.cid]._classes.has('ok'), '18% consumido → color ok (holgado)');
    assert.match(a.els[a.cid].getAttribute('title'), /18% consumido/, 'tooltip habla de consumido');

    // Medio: 60% consumido → warn (ámbar).
    const b = makeCell('anthropic', 'short');
    loadWinCellHelper(b.els)._mzHydrateWinCell('anthropic', 'short',
        { mode: 'gauge', pct: 60, available: 40, win: '5h', resetAt: null });
    assert.equal(b.els[b.cid + '-pct'].textContent, '60%', '60% consumido');
    assert.ok(b.els[b.cid]._classes.has('warn'), '60% consumido → color warn');

    // Agotado: 100% consumido (available 0) = AGOTADA → bad (rojo).
    const c = makeCell('anthropic', 'long');
    const res = loadWinCellHelper(c.els)._mzHydrateWinCell('anthropic', 'long',
        { mode: 'gauge', pct: 100, available: 0, win: 'Sem', resetAt: null });
    assert.equal(c.els[c.cid + '-pct'].textContent, '100%', '100% consumido');
    assert.ok(c.els[c.cid]._classes.has('bad'), '100% consumido → color bad (AGOTADA)');
    assert.match(c.els[c.cid].getAttribute('title'), /AGOTADA/, 'tooltip marca AGOTADA');
    assert.equal(res.healthy, false, '100% consumido no es proveedor sano');
});

// Degradación defensiva: si el slice de Anthropic llegara SIN `pct` (p.ej. un
// bucket hidratado por el seam de cache), la vista-consumido cae a
// `100 - available`, que es su equivalente exacto. Nunca pinta el disponible.
test('#4884: ANTHROPIC gauge sin `pct` en el slice degrada a 100 - available (nunca el disponible)', () => {
    const { cid, els } = makeCell('anthropic', 'long');
    loadWinCellHelper(els)._mzHydrateWinCell('anthropic', 'long',
        { mode: 'gauge', available: 45, win: 'Sem', resetAt: null });
    assert.equal(els[cid + '-pct'].textContent, '55%', 'sin pct → 100 - 45 = 55% consumido');
    assert.notEqual(els[cid + '-pct'].textContent, '45%', 'NUNCA el disponible');
});

// ---------------------------------------------------------------------------
// #4884 CA-5 — ALCANCE "SOLO Anthropic". Los free-tiers en mode 'gauge'
// (gemini-google, cerebras, nvidia-nim, kimi-moonshot) NO se invierten: su
// `available` es la disponibilidad GENUINA (100*remaining/limit,
// provider-quota.js:166), no un `100 - consumido`. Invertirlos sería un bug
// nuevo de la misma clase que #4884 corrige. Estos casos son la red de
// seguridad: hoy los free-tiers están en 'nodata', pero `recordSample()` es
// código vivo y en cuanto reporten headers x-ratelimit-* la celda se hidrata.
// ---------------------------------------------------------------------------
test('#4884 CA-5: cerebras gauge available=70 sigue mostrando 70% DISPONIBLE (no invertido a 30%)', () => {
    const { cid, els } = makeCell('cerebras', 'short');
    const r = loadWinCellHelper(els)._mzHydrateWinCell('cerebras', 'short',
        { mode: 'gauge', available: 70, win: 'Min', resetAt: null });
    assert.equal(els[cid + '-pct'].textContent, '70%', 'free-tier: pinta su DISPONIBLE tal cual');
    assert.notEqual(els[cid + '-pct'].textContent, '30%', 'NUNCA invertido (regresión del rebote rev-1)');
    assert.equal(els[cid + '-bar'].style.width, '70%', 'la barra mide el disponible, no el consumo');
    assert.match(els[cid].getAttribute('title'), /70% disponible/, 'copy del free-tier dice "disponible"');
    assert.ok(!/consumido/.test(els[cid].getAttribute('title')), 'el copy del free-tier NUNCA dice "consumido"');
    assert.match(els[cid].getAttribute('aria-label'), /70% disponible/, 'aria-label coherente con el número');
    assert.equal(r.healthy, true, '70% disponible es un proveedor sano');
});

test('#4884 CA-5: los 4 free-tiers gauge conservan la semántica DISPONIBLE + color por umbral #4533', () => {
    // [key, available, % esperado, clase esperada] — la clase sale de
    // _mzThresholdClass (avail<20→bad, avail<50→warn, resto ok), intacta.
    const CASOS = [
        ['gemini-google', 70, '70%', 'ok'],
        ['cerebras',      45, '45%', 'warn'],
        ['nvidia-nim',    15, '15%', 'bad'],
        ['kimi-moonshot', 95, '95%', 'ok'],
    ];
    for (const [key, available, esperado, cls] of CASOS) {
        const { cid, els } = makeCell(key, 'short');
        loadWinCellHelper(els)._mzHydrateWinCell(key, 'short',
            { mode: 'gauge', available, win: 'Min', resetAt: null });
        assert.equal(els[cid + '-pct'].textContent, esperado, `${key}: muestra su disponible sin invertir`);
        assert.ok(els[cid]._classes.has(cls), `${key}: color por umbral DISPONIBLE (#4533) intacto`);
        assert.match(els[cid].getAttribute('title'), /disponible/, `${key}: copy dice "disponible"`);
    }
});

test('#4884 CA-5: free-tier con available=0 marca "AGOTADA (0% disponible)" y NO sano', () => {
    const { cid, els } = makeCell('cerebras', 'long');
    const r = loadWinCellHelper(els)._mzHydrateWinCell('cerebras', 'long',
        { mode: 'gauge', available: 0, win: 'Día', resetAt: null });
    assert.equal(els[cid + '-pct'].textContent, '0%');
    assert.match(els[cid].getAttribute('title'), /AGOTADA \(0% disponible\)/, 'agotada en semántica disponible');
    assert.ok(els[cid]._classes.has('bad'), '0% disponible → bad');
    assert.equal(r.healthy, false, '0% disponible no es proveedor sano');
});

// CA-4 — el copy del skeleton acompaña la semántica real de cada fila.
test('#4884 CA-4: el skeleton _mzWinCell dice "consumida" solo en Anthropic; el resto "disponible"', () => {
    assert.match(home._mzWinCell('anthropic', 'short', '5h'), /cuota consumida real/,
        'la fila Anthropic anuncia consumido');
    for (const key of ['cerebras', 'gemini-google', 'nvidia-nim', 'openai-codex']) {
        const html = home._mzWinCell(key, 'short', 'Min');
        assert.match(html, /cuota disponible real/, `${key}: el skeleton sigue diciendo "disponible"`);
        assert.ok(!/cuota consumida/.test(html), `${key}: el skeleton NUNCA dice "consumida"`);
    }
});

test('#4884 CA-4: el header visible usa copy neutral para la matriz de semántica mixta', () => {
    const html = home.renderSystemQuotaPanel({ semaforo: { level: 'ok', label: 'SALUDABLE' } });
    assert.match(html, /CUOTA POR PROVEEDOR/, 'el header no atribuye una semántica única a toda la matriz');
    assert.doesNotMatch(html, /CUOTA DISPONIBLE POR PROVEEDOR/,
        'el header no presenta el consumo de Anthropic como cuota disponible');
});

// Regresión dura #4884: dado el motor real (55% semanal / 11% sesión, iguales al
// CLI /usage y al cliente cloud), el panel principal DEBE pintar 55% y 11% — el
// consumido —, nunca su complemento 45%/89% (el bug que #4884 revierte de #4533).
test('#4884: motor 55%/11% consumido → panel principal pinta 55%/11% (no 45%/89%)', () => {
    // El slice viaja `available = 100 - consumido` (motor intacto, CA-2):
    //   semanal: consumido 55 → available 45 ; sesión: consumido 11 → available 89.
    const wk = makeCell('anthropic', 'long');
    loadWinCellHelper(wk.els)._mzHydrateWinCell('anthropic', 'long',
        { mode: 'gauge', pct: 55, available: 45, win: 'Sem', resetAt: null });
    assert.equal(wk.els[wk.cid + '-pct'].textContent, '55%', 'semanal: 55% consumido, no 45%');
    assert.notEqual(wk.els[wk.cid + '-pct'].textContent, '45%', 'NUNCA el complemento');
    assert.equal(wk.els[wk.cid + '-bar'].style.width, '55%', 'la barra crece con el consumo');

    const ses = makeCell('anthropic', 'short');
    loadWinCellHelper(ses.els)._mzHydrateWinCell('anthropic', 'short',
        { mode: 'gauge', pct: 11, available: 89, win: '5h', resetAt: null });
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

// #4533 — _mzThresholdClass conserva su semántica DISPONIBLE (sirve a los
// free-tiers gauge). #4884 NO la muta (CA-5): agrega _mzConsumedClass aparte.
test('#4533: _mzThresholdClass por % DISPONIBLE — verde holgado, ámbar medio, rojo agotado', () => {
    const { _mzThresholdClass } = loadWinCellHelper({});
    // Disponible alto → holgado (verde).
    assert.equal(_mzThresholdClass(100), 'ok');
    assert.equal(_mzThresholdClass(70), 'ok');
    assert.equal(_mzThresholdClass(50), 'ok');
    // Medio → ámbar.
    assert.equal(_mzThresholdClass(49), 'warn');
    assert.equal(_mzThresholdClass(20), 'warn');
    // Bajo/agotado → rojo.
    assert.equal(_mzThresholdClass(19), 'bad');
    assert.equal(_mzThresholdClass(0), 'bad');
    assert.equal(_mzThresholdClass(null), '');
});

// #4884 — helper DEDICADO para la vista-consumido de Anthropic. Sus cortes son
// el complemento exacto de los de _mzThresholdClass, así ninguna celda cambia
// de color respecto de #4533 (verificable: avail 70↔consumed 30 → ambos 'ok';
// avail 45↔consumed 55 → ambos 'warn'; avail 15↔consumed 85 → ambos 'bad').
test('#4884: _mzConsumedClass por % CONSUMIDO — verde bajo, ámbar medio, rojo agotado', () => {
    const { _mzConsumedClass } = loadWinCellHelper({});
    // Casos exigidos por CA-7.
    assert.equal(_mzConsumedClass(11), 'ok');
    assert.equal(_mzConsumedClass(55), 'warn');
    assert.equal(_mzConsumedClass(85), 'bad');
    assert.equal(_mzConsumedClass(100), 'bad');
    // Bordes de cada rama (cobertura 100%).
    assert.equal(_mzConsumedClass(0), 'ok');
    assert.equal(_mzConsumedClass(50), 'ok');
    assert.equal(_mzConsumedClass(51), 'warn');
    assert.equal(_mzConsumedClass(80), 'warn');
    assert.equal(_mzConsumedClass(81), 'bad');
    assert.equal(_mzConsumedClass(120), 'bad');
    assert.equal(_mzConsumedClass(null), '');
});

// Complementariedad exacta: para cualquier par (avail, 100-avail) ambos helpers
// devuelven la MISMA clase. Es la garantía formal de "ninguna celda cambia de
// color" que el PO verificó a mano en el ciclo anterior.
test('#4884: _mzConsumedClass(100-a) === _mzThresholdClass(a) para todo a en 0..100', () => {
    const { _mzThresholdClass, _mzConsumedClass } = loadWinCellHelper({});
    for (let a = 0; a <= 100; a++) {
        assert.equal(_mzConsumedClass(100 - a), _mzThresholdClass(a),
            `disponible ${a}% y consumido ${100 - a}% deben pintar igual`);
    }
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

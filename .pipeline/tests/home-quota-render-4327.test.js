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
//   #4884 — ANTHROPIC (y solo Anthropic) con gauge real escribe el "<n>%"
//           CONSUMIDO y su color por umbral (ok/warn/bad); 100% consumido =>
//           bad (AGOTADA). Regresión dura: motor 55%/11% → panel 55%/11%, no
//           45%/89%.
//   #4884 CA-5 — ALCANCE: los demás gauge (free-tiers gemini/cerebras/nvidia/
//           kimi) siguen pintando su % DISPONIBLE sin invertir, y su copy sigue
//           diciendo "disponible" (celda + skeleton).
//   #4900 — Codex fresco (mode 'event') sincroniza porcentaje, barra, color y
//           accesibilidad, SIEMPRE con semántica DISPONIBLE (= 100 - consumo
//           del slice). Reemplaza el "✓ sin límite" legacy de #4533.
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

test('#4900: Codex fresco sincroniza porcentaje DISPONIBLE, barra, color, title y aria-label', () => {
    // POLARIDAD (causa raíz del bug padre #4885): `b.pct` es CONSUMO. La celda
    // debe pintar DISPONIBLE = 100 - consumo, igual que la rama `gauge` y que el
    // mockup versionado (codex-quota-states.svg rotula "72% disponible" en verde).
    const { cid, els } = makeCell('openai-codex', 'short');
    const r = loadWinCellHelper(els)._mzHydrateWinCell('openai-codex', 'short',
        { mode: 'event', eventState: 'ok', pct: 27.6, win: 'Roll' });
    assert.equal(els[cid + '-pct'].textContent, '72%', '27.6% consumido → 72% disponible');
    assert.equal(els[cid + '-bar'].style.width, '72%', 'la barra usa la MISMA magnitud que el texto');
    assert.ok(els[cid]._classes.has('ok'), '72% disponible → verde (no rojo por leer consumo)');
    assert.match(els[cid].getAttribute('title'), /72% disponible/);
    assert.match(els[cid].getAttribute('aria-label'), /72% disponible/);
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

test('#4900: Codex fresco cubre límites 0/100 y umbrales cromáticos (semántica disponible)', () => {
    // [consumo, disponible esperado, clase, healthy]. Los extremos son la
    // afirmación anti-inversión: consumo 0 → 100% verde/sano; consumo 100 →
    // 0% rojo/no sano. Con la polaridad invertida ambas filas fallan.
    const CASES = [
        [0, 100, 'ok', true],
        [50, 50, 'ok', true],
        [51, 49, 'warn', true],
        [80, 20, 'warn', true],
        [81, 19, 'bad', true],
        [100, 0, 'bad', false],
    ];
    for (const [pct, avail, cls, healthy] of CASES) {
        const { cid, els } = makeCell('openai-codex', 'short');
        const r = loadWinCellHelper(els)._mzHydrateWinCell('openai-codex', 'short',
            { mode: 'event', eventState: 'ok', pct, win: 'Roll' });
        assert.equal(els[cid + '-pct'].textContent, avail + '%',
            'consumo ' + pct + '% → texto ' + avail + '%');
        assert.equal(els[cid + '-bar'].style.width, avail + '%',
            'consumo ' + pct + '% → barra ' + avail + '%');
        assert.ok(els[cid]._classes.has(cls),
            'consumo ' + pct + '% (disponible ' + avail + '%) → clase ' + cls);
        assert.equal(r.healthy, healthy, 'consumo ' + pct + '% → healthy=' + healthy);
    }
});

test('#4900: los extremos NO se leen con la polaridad invertida (anti-regresión #4885)', () => {
    // Cuota libre: NUNCA rojo ni "no sano".
    const libre = makeCell('openai-codex', 'short');
    const rLibre = loadWinCellHelper(libre.els)._mzHydrateWinCell('openai-codex', 'short',
        { mode: 'event', eventState: 'ok', pct: 0, win: 'Roll' });
    assert.equal(libre.els[libre.cid + '-pct'].textContent, '100%');
    assert.ok(!libre.els[libre.cid]._classes.has('bad'), 'cuota 100% libre nunca es roja');
    assert.equal(rLibre.healthy, true);

    // Cuota agotada: NUNCA verde ni "sano", y la copia iguala a la rama gauge.
    const agotada = makeCell('openai-codex', 'long');
    const rAgot = loadWinCellHelper(agotada.els)._mzHydrateWinCell('openai-codex', 'long',
        { mode: 'event', eventState: 'ok', pct: 100, win: 'Sem' });
    assert.equal(agotada.els[agotada.cid + '-pct'].textContent, '0%');
    assert.ok(!agotada.els[agotada.cid]._classes.has('ok'), 'cuota agotada nunca es verde');
    assert.ok(agotada.els[agotada.cid]._classes.has('bad'));
    assert.match(agotada.els[agotada.cid].getAttribute('title'), /AGOTADA \(0% disponible\)/,
        'copia coherente con la rama gauge');
    assert.match(agotada.els[agotada.cid].getAttribute('aria-label'), /AGOTADA \(0% disponible\)/);
    assert.equal(rAgot.healthy, false, 'agotada no cuenta en mz-sig-healthy');
});

test('#4900: el rótulo accesible del estado fresco dice "disponible" (igual que gauge)', () => {
    // Baseline de comparación: un gauge de vista DISPONIBLE. Desde #4884 CA-5
    // `anthropic` es la ÚNICA celda que pinta CONSUMIDO, así que no sirve como
    // referencia de polaridad; los free-tiers (gemini-google, cerebras,
    // nvidia-nim) siguen pintando disponible y son la matriz con la que la
    // celda Codex debe leerse igual.
    const evt = makeCell('openai-codex', 'short');
    loadWinCellHelper(evt.els)._mzHydrateWinCell('openai-codex', 'short',
        { mode: 'event', eventState: 'ok', pct: 28, win: '5H' });
    const gauge = makeCell('gemini-google', 'short');
    loadWinCellHelper(gauge.els)._mzHydrateWinCell('gemini-google', 'short',
        { mode: 'gauge', available: 72, win: '5h', resetAt: null });

    // Misma magnitud y mismo rótulo para la misma situación real (72% libre).
    assert.equal(evt.els[evt.cid + '-pct'].textContent, gauge.els[gauge.cid + '-pct'].textContent);
    assert.match(evt.els[evt.cid].getAttribute('aria-label'), /: 72% disponible$/);
    assert.match(gauge.els[gauge.cid].getAttribute('aria-label'), /: 72% disponible$/);

    // Anti-regresión de alcance (#4884 CA-5): la excepción CONSUMIDO es sólo de
    // anthropic y NO debe filtrarse a la rama event de Codex.
    const anth = makeCell('anthropic', 'short');
    loadWinCellHelper(anth.els)._mzHydrateWinCell('anthropic', 'short',
        { mode: 'gauge', available: 72, pct: 28, win: '5h', resetAt: null });
    assert.equal(anth.els[anth.cid + '-pct'].textContent, '28%',
        'anthropic sigue en vista CONSUMIDO (#4884)');
    assert.notEqual(evt.els[evt.cid + '-pct'].textContent, anth.els[anth.cid + '-pct'].textContent,
        'Codex fresco NO adopta la vista consumido de anthropic');
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

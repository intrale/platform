'use strict';

// #4900 (rebote QA visual) — Anti-regresión del harness de evidencia visual.
//
// El rechazo del PO fue causado por un harness que HARDCODEABA una copia del CSS
// (sin `:not(.mz-qm-fresh)`) y armaba la celda fresca sin la clase `mz-qm-fresh`,
// reproduciendo el DEFECTO en vez del fix (escape #4531). Estos tests garantizan
// que el nuevo harness deriva TODO de `views/dashboard/home.js` (fuente única) y
// que nunca vuelve a incrustar el CSS defectuoso.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const home = require('../views/dashboard/home');
const { buildHarnessHtml, SCENARIOS } = require('../tools/render-quota-evidence-4900');

const HOME_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'views', 'dashboard', 'home.js'), 'utf8');

// Elementos del DOM falso compartido por escenario (mismo contrato mínimo que
// usa `_mzHydrateWinCell`: classList, style, textContent, get/setAttribute).
const FAKE_ELS = Object.create(null);

function mkEl() {
    const classes = new Set();
    const attrs = {};
    return {
        textContent: '', style: {}, _classes: classes,
        classList: {
            add(c) { classes.add(c); }, remove(c) { classes.delete(c); },
            contains(c) { return classes.has(c); },
        },
        getAttribute(k) { return attrs[k] != null ? attrs[k] : null; },
        setAttribute(k, v) { attrs[k] = String(v); },
    };
}

// Registra la celda `mz-qm-<id>-short` con sus hijos y devuelve las referencias.
function installFakeCell(id) {
    const cid = 'mz-qm-' + id + '-short';
    const refs = { cell: mkEl(), tag: mkEl(), bar: mkEl(), pct: mkEl(), rst: mkEl() };
    FAKE_ELS[cid] = refs.cell;
    FAKE_ELS[cid + '-tag'] = refs.tag;
    FAKE_ELS[cid + '-bar'] = refs.bar;
    FAKE_ELS[cid + '-pct'] = refs.pct;
    FAKE_ELS[cid + '-rst'] = refs.rst;
    return refs;
}

// Extrae del source REAL de home.js el bloque que define `_mzHydrateWinCell`
// (vive en el script cliente, no se exporta) y lo evalúa con el DOM falso.
function loadRealHydrator() {
    const start = HOME_SRC.indexOf('const QUOTA_SINDATO_REASON = {');
    assert.ok(start >= 0, 'ancla de inicio no encontrada en home.js');
    const end = HOME_SRC.indexOf('function renderProviderQuotaMatrix(', start);
    assert.ok(end > start, 'ancla de fin no encontrada en home.js');
    const factory = new Function('document', 'MZ_PROVIDER_META', `
        ${HOME_SRC.slice(start, end)}
        return { _mzHydrateWinCell, _mzThresholdClass };
    `);
    return factory({ getElementById: (id) => FAKE_ELS[id] || null }, home.MZ_PROVIDER_META);
}

test('home.js exporta homeStyles y renderClientScript para harnesses de QA visual', () => {
    assert.strictEqual(typeof home.homeStyles, 'function');
    assert.strictEqual(typeof home.renderClientScript, 'function');
});

test('el harness incrusta el CSS REAL con la regla del fix :not(.mz-qm-fresh)', () => {
    const html = buildHarnessHtml();
    assert.ok(html.includes(home.homeStyles()),
        'el harness debe incrustar homeStyles() verbatim (sin copias)');
    assert.match(html, /\.mz-qm-cell\.mz-qm-event:not\(\.mz-qm-fresh\)/,
        'debe estar la regla del fix que excluye el estado fresco del override de evento');
});

test('el harness NO contiene la regla CSS defectuosa (evento sin :not)', () => {
    const html = buildHarnessHtml();
    // La versión defectuosa ocultaba la barra para TODO .mz-qm-event
    // (`.mz-qm-event .mz-qm-mini`, con espacio directo, sin `:not(.mz-qm-fresh)`).
    assert.doesNotMatch(html, /\.mz-qm-event\s+\.mz-qm-mini/,
        'no debe existir la regla vieja que oculta la barra en el estado fresco');
});

test('el harness incrusta el script cliente REAL que marca el estado fresco', () => {
    const html = buildHarnessHtml();
    assert.ok(html.includes(home.renderClientScript()),
        'el harness debe incrustar renderClientScript() verbatim (sin copias)');
    assert.ok(html.includes("classList.add('mz-qm-fresh')"),
        'el JS real debe agregar la clase mz-qm-fresh al estado fresco');
    assert.ok(html.includes('function _mzHydrateWinCell'),
        'el JS real de hidratación debe estar presente');
});

test('las celdas usan el markup real de home._mzWinCell y se hidratan por escenario', () => {
    const html = buildHarnessHtml();
    for (const s of SCENARIOS) {
        // Markup real del skeleton (ids de barra/pct por celda).
        assert.ok(html.includes('id="mz-qm-' + s.id + '-short-bar"'),
            'falta la celda real para el escenario ' + s.id);
    }
    // La hidratación corre con la misma función del dashboard.
    assert.match(html, /_mzHydrateWinCell\(s\.id, 'short', s\.b\)/);
});

test('cubre los estados frescos por umbral y los límites 0/100 pedidos por el PO', () => {
    // Los escenarios se declaran en DISPONIBLE (lo que se ve en pantalla y lo
    // que rotula el mockup); el shape del slice lleva el CONSUMO equivalente.
    const avails = SCENARIOS.filter((s) => s.b.eventState === 'ok').map((s) => s.avail).sort((a, b) => a - b);
    for (const needed of [0, 12, 35, 72, 100]) {
        assert.ok(avails.includes(needed), 'falta el escenario fresco ' + needed + '% disponible');
    }
    // Y los estados categóricos, para contraste con el mockup.
    assert.ok(SCENARIOS.some((s) => s.b.eventState === 'nodata'));
    assert.ok(SCENARIOS.some((s) => s.b.eventState === 'exhausted'));
});

test('#4900 polaridad: cada escenario fresco alimenta el CONSUMO complementario del disponible', () => {
    // Anti-regresión del bug padre #4885: si alguien vuelve a cargar el
    // disponible como si fuera `pct`, el harness volvería a "confirmar" el
    // defecto (12% consumido pintado en rojo) y el QA visual mentiría.
    for (const s of SCENARIOS.filter((x) => x.b.eventState === 'ok')) {
        assert.strictEqual(s.b.pct + s.avail, 100,
            'escenario ' + s.id + ': pct (consumo) + avail (disponible) debe dar 100');
    }
});

test('#4900 polaridad: la hidratación real del harness pinta el disponible esperado', () => {
    // Ejecuta la MISMA función del dashboard sobre un DOM falso y verifica que
    // lo que el harness va a capturar coincide con el disponible declarado.
    const { _mzHydrateWinCell } = loadRealHydrator();
    for (const s of SCENARIOS.filter((x) => x.b.eventState === 'ok')) {
        const dom = installFakeCell(s.id);
        const r = _mzHydrateWinCell(s.id, 'short', s.b);
        assert.strictEqual(dom.pct.textContent, s.avail + '%',
            'escenario ' + s.id + ' debe mostrar ' + s.avail + '% disponible');
        assert.strictEqual(dom.bar.style.width, s.avail + '%');
        const expectedCls = s.avail < 20 ? 'bad' : (s.avail < 50 ? 'warn' : 'ok');
        assert.ok(dom.cell.classList.contains(expectedCls),
            'escenario ' + s.id + ' debe pintar ' + expectedCls);
        assert.strictEqual(r.healthy, s.avail > 0);
    }
});

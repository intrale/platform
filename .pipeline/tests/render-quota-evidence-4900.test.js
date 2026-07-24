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

const home = require('../views/dashboard/home');
const { buildHarnessHtml, SCENARIOS } = require('../tools/render-quota-evidence-4900');

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
    const pcts = SCENARIOS.filter((s) => s.b.eventState === 'ok').map((s) => s.b.pct).sort((a, b) => a - b);
    for (const needed of [0, 12, 35, 72, 100]) {
        assert.ok(pcts.includes(needed), 'falta el escenario fresco ' + needed + '%');
    }
    // Y los estados categóricos, para contraste con el mockup.
    assert.ok(SCENARIOS.some((s) => s.b.eventState === 'nodata'));
    assert.ok(SCENARIOS.some((s) => s.b.eventState === 'exhausted'));
});

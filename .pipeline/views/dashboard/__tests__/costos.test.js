// =============================================================================
// Tests SSR de la ventana Costos (#3735, split del épico #3715).
//
// Cubre los criterios mínimos de la narrativa-costos-v3.md (Bloque G / CA-4.1):
//   1. renderCostosBanner / renderCostosPill con state vacío → '' (no visible).
//   2. render con anomalía activa → banner con id canónico + tooltips PO.
//   3. Payload XSS canónico en skill name + ratio NO renderiza HTML ejecutable
//      (CA-D1 / CA-B3 — escape vía lib/escape-html.js).
//   4. renderInert() retorna banner inerte visible "Ventana Costos no disponible"
//      preservando el id `cost-anomaly-banner` (CA-A3).
//   5. No-regresión de reuso: las funciones son puras y reusables desde home.js
//      sin doble fetch (opción A del riesgo #3 del architect).
//
// node:test (sin Jest). No arranca dashboard.js (side effects); usa el render
// directo de las funciones del módulo.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const COSTOS_PATH = path.resolve(__dirname, '..', 'costos.js');
const costos = require(COSTOS_PATH);

// Payloads XSS canónicos (paridad con home.test.js / ops.test.js).
const XSS_BODY = '<script>alert(1)</script>';
const XSS_ATTR = '"><img src=x onerror=alert(1)>';

function anomalyState(overrides) {
    return {
        costAnomaly: {
            visible: true,
            alert: Object.assign({
                ratio: 1.42,
                actual_usd: 4.72,
                baseline_usd: 3.33,
                hour: 14,
                top_skills: [
                    { skill: 'backend-dev', cost_usd: 2.10 },
                    { skill: 'android-dev', cost_usd: 1.40 },
                ],
            }, overrides || {}),
        },
    };
}

test('renderCostosBanner devuelve string vacío cuando no hay anomalía visible', () => {
    assert.equal(costos.renderCostosBanner({}), '');
    assert.equal(costos.renderCostosBanner({ costAnomaly: { visible: false } }), '');
    assert.equal(costos.renderCostosBanner(null), '');
});

test('renderCostosPill devuelve string vacío cuando no hay anomalía visible', () => {
    assert.equal(costos.renderCostosPill({}), '');
    assert.equal(costos.renderCostosPill({ costAnomaly: { visible: false } }), '');
});

test('renderCostosBanner con anomalía activa incluye id canónico y datos', () => {
    const html = costos.renderCostosBanner(anomalyState());
    assert.match(html, /id="cost-anomaly-banner"/);
    assert.match(html, /\+42%/);                 // ratio 1.42 → +42%
    assert.match(html, /4\.72 USD\/h/);          // actual
    assert.match(html, /3\.33 USD\/h/);          // baseline
    assert.match(html, /14:00–15:00/);           // franja horaria
    assert.match(html, /backend-dev/);           // top skill
});

test('renderCostosBanner incluye los 4 tooltips operativos acordados con PO', () => {
    const html = costos.renderCostosBanner(anomalyState());
    assert.match(html, new RegExp(costos.TOOLTIPS.ack.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(html, /Silencia una hora/);
    assert.match(html, /Silencia cuatro horas/);
    assert.match(html, /Cap máximo permitido/);
    // Cada acción operativa lleva un title= (CA-C1).
    const titleCount = (html.match(/title="/g) || []).length;
    assert.ok(titleCount >= 4, `esperaba >=4 tooltips, encontré ${titleCount}`);
});

test('renderCostosPill con anomalía activa incluye tooltip y porcentaje', () => {
    const html = costos.renderCostosPill(anomalyState());
    assert.match(html, /class="anomaly-pill"/);
    assert.match(html, /CONSUMO ANÓMALO/);
    assert.match(html, /\+42%/);
    assert.match(html, new RegExp(costos.TOOLTIPS.pill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('ratio inválido degrada a +?% sin romper', () => {
    const html = costos.renderCostosBanner(anomalyState({ ratio: null }));
    assert.match(html, /\+\?%/);
});

test('XSS canónico en skill name NO renderiza HTML ejecutable (CA-D1)', () => {
    const html = costos.renderCostosBanner(anomalyState({
        top_skills: [{ skill: XSS_BODY, cost_usd: 9.99 }],
    }));
    assert.ok(!html.includes('<script>alert(1)</script>'), 'el <script> no debe quedar crudo');
    assert.match(html, /&lt;script&gt;/);
});

test('XSS en atributo (tooltip vía ic ariaLabel) queda escapado', () => {
    // Inyectamos un ic custom para forzar ariaLabel con payload de atributo.
    const html = costos.renderCostosBanner(anomalyState(), {
        ic: (name, aria) => `<svg aria-label="${String(aria || '').replace(/"/g, '&quot;')}"></svg>`,
    });
    assert.ok(!html.includes('onerror=alert(1)>'), 'no debe haber atributo onerror ejecutable crudo');
});

test('renderInert retorna banner inerte visible preservando el id canónico (CA-A3)', () => {
    const html = costos.renderInert();
    assert.match(html, /id="cost-anomaly-banner"/);
    assert.match(html, /Ventana Costos no disponible/);
});

test('renderInert escapa el mensaje recibido', () => {
    const html = costos.renderInert(XSS_BODY);
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.match(html, /&lt;script&gt;/);
});

test('las funciones son reusables (puras, sin estado): doble invocación idéntica', () => {
    const a = costos.renderCostosBanner(anomalyState());
    const b = costos.renderCostosBanner(anomalyState());
    assert.equal(a, b);
});

// --- CA-3.3 / R2 — sin handlers onclick inline (prerrequisito CSP #3688) ----

test('renderCostosBanner NO emite ningún onclick inline (CA-3.3)', () => {
    const html = costos.renderCostosBanner(anomalyState());
    assert.ok(!/onclick=/i.test(html), 'el banner no debe contener onclick inline');
});

test('renderCostosPill NO emite ningún onclick inline (CA-3.3)', () => {
    const html = costos.renderCostosPill(anomalyState());
    assert.ok(!/onclick=/i.test(html), 'la pill no debe contener onclick inline');
});

test('los botones usan data-ca-action en vez de onclick', () => {
    const banner = costos.renderCostosBanner(anomalyState());
    const pill = costos.renderCostosPill(anomalyState());
    assert.match(pill, /data-ca-action="scroll-banner"/);
    assert.match(banner, /data-ca-action="ack"/);
    assert.match(banner, /data-ca-action="snooze" data-ca-hours="1"/);
    assert.match(banner, /data-ca-action="snooze" data-ca-hours="4"/);
    assert.match(banner, /data-ca-action="snooze" data-ca-hours="24"/);
});

test('renderCostosClientScript cablea la delegación CSP-safe (addEventListener)', () => {
    const script = costos.renderCostosClientScript();
    assert.match(script, /<script>/);
    assert.match(script, /addEventListener\('click'/);
    assert.match(script, /data-ca-action/);
    // No reintroduce onclick ni inline handlers.
    assert.ok(!/onclick=/i.test(script), 'el client script no debe emitir onclick');
    // Llama a las funciones globales del shell sin redefinirlas.
    assert.match(script, /costAnomalyAck/);
    assert.match(script, /costAnomalySnooze/);
});

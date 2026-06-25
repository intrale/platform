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

// =============================================================================
// #4194 EP7.1 — Rediseño integral MIZPÁ: banner de misión (alarma), gráfico de
// barras apiladas 14d por proveedor + línea de presupuesto, proyecciones + mix,
// detalle por skill con columna de proveedor, «Cuota por proveedor» (5 tarjetas).
// =============================================================================
function makeSlice(overrides) {
    return Object.assign({
        dailyByProvider: [
            { day: '2026-06-09', provider: 'anthropic', cost_usd: 3.5, sessions: 2 },
            { day: '2026-06-09', provider: 'groq', cost_usd: 0.4, sessions: 1 },
            { day: '2026-06-10', provider: 'anthropic', cost_usd: 2.1, sessions: 1 },
        ],
        budget: { monthly_usd: 120, source: 'persisted', actor: 'operador-local' },
        anomaly: { active: false, startTs: null },
        snooze: { until: null },
        projections: {
            tokens: {
                weekly_projection_usd: 14, monthly_forecast_usd: 60, monthly_projection_usd: 62,
                month_to_date_usd: 5.6,
                method: { weekly: 'promedio diario × 7', monthly: 'promedio diario × días del mes', deviation: '(proyección mensual ÷ presupuesto) − 1' },
                quota: { monthly_usd: 120, ratio: 0.5, status: 'ok' },
            },
        },
        sessionsBySkill: {
            guru: [
                { provider: 'anthropic', cost_usd: 1.2, duration_ms: 5000, ts: '2026-06-09T10:00:00Z' },
                { provider: 'groq', cost_usd: 0.4, duration_ms: 2000, ts: '2026-06-09T11:00:00Z' },
            ],
        },
        byProvider: {
            anthropic: { sessions: 3, cost_usd: 5.6, duration_ms: 7000 },
            'openai-codex': { sessions: 2, cost_usd: 1.4, duration_ms: 500 },
            groq: { sessions: 4, cost_usd: 0, duration_ms: 300 },
        },
        claudeQuota: { sessionPct: 1.2, sessionStatus: 'ok', weeklyPct: 38.2, weeklyStatus: 'ok', daysToReset: 3.1, calibrated: true },
    }, overrides || {});
}

test('renderCostosChart: barras apiladas por proveedor + línea de presupuesto (CA-3)', () => {
    const chart = costos.renderCostosChart(makeSlice());
    // Segmentos por proveedor presentes (Claude=cl, Groq=gq).
    assert.match(chart, /cz-seg cz-seg-cl/);
    assert.match(chart, /cz-seg cz-seg-gq/);
    assert.match(chart, /cz-budget-line/);
    // Barras: 14 días → 14 contenedores .cz-bar.
    const bars = (chart.match(/class="cz-bar"/g) || []).length;
    assert.equal(bars, 14, `esperaba 14 barras, encontré ${bars}`);
});

test('renderCostosChart: leyenda incluye los 5 proveedores + deterministas, FREE en $0 visibles (CA-6)', () => {
    const chart = costos.renderCostosChart(makeSlice());
    for (const p of ['Claude', 'Codex', 'Groq', 'Gemini', 'Cerebras', 'Deterministas']) {
        assert.match(chart, new RegExp(p), `falta el proveedor ${p} en la leyenda`);
    }
    // FREE tier visible aunque su gasto sea $0 (nunca se truncan — CA-6).
    assert.match(chart, /cz-freetag/);
    assert.match(chart, /\$0\.00/);
});

test('renderMissionBanner: desvío vs presupuesto + gastado hoy/mes + el que más pesa (CA-4)', () => {
    // Slice "over budget": ratio > 1 → alarma.
    const over = makeSlice({ projections: { tokens: { weekly_projection_usd: 1017, monthly_forecast_usd: 800, monthly_projection_usd: 800, month_to_date_usd: 436.28, method: {}, quota: { monthly_usd: 100, ratio: 8.73, status: 'over' } } }, budget: { monthly_usd: 100, source: 'persisted' } });
    const banner = costos.renderMissionBanner(over);
    assert.match(banner, /cz-mission-alarm/);
    assert.match(banner, /Estás gastando por encima del presupuesto/);
    assert.match(banner, /GASTADO HOY/);
    assert.match(banner, /GASTADO ESTE MES/);
    assert.match(banner, /PRESUPUESTO DIARIO/);
    assert.match(banner, /EL QUE MÁS PESA/);
    assert.match(banner, /\+773%/); // round((8.73-1)*100)
    // Slice "in range": ratio < 1 → variante OK, sin clave alarma.
    const ok = costos.renderMissionBanner(makeSlice());
    assert.match(ok, /cz-mission-ok/);
    assert.ok(!/cz-mission-alarm/.test(ok));
});

test('renderProviderQuota: una tarjeta por cada uno de los 5 proveedores con su tier (CA-2)', () => {
    const q = costos.renderProviderQuota(makeSlice());
    // Las 5 tarjetas presentes.
    const cards = (q.match(/class="cz-pq /g) || []).length;
    assert.equal(cards, 5, `esperaba 5 tarjetas de cuota, encontré ${cards}`);
    // Cada proveedor con su modelo de límite (tier).
    assert.match(q, /Claude[\s\S]*PLAN MAX/);
    assert.match(q, /Codex[\s\S]*PAGO/);
    // Los free tier marcados FREE.
    assert.match(q, /Groq[\s\S]*FREE/);
    assert.match(q, /Gemini[\s\S]*FREE/);
    assert.match(q, /Cerebras[\s\S]*FREE/);
    // Claude muestra su % estimado de la cuota (sesión/semanal).
    assert.match(q, /38\.2%/);
});

test('renderBudgetForm: "Silenciada hasta HH:MM" derivado del snooze server-side (CA-5)', () => {
    const until = new Date(Date.now() + 3600 * 1000).toISOString();
    const form = costos.renderBudgetForm(makeSlice({ snooze: { until } }));
    const d = new Date(until);
    const pad = (n) => String(n).padStart(2, '0');
    const expected = pad(d.getHours()) + ':' + pad(d.getMinutes());
    assert.match(form, new RegExp('Silenciada hasta ' + expected));
    // Sin snooze → sin chip.
    assert.ok(!/Silenciada hasta/.test(costos.renderBudgetForm(makeSlice())));
});

test('renderProjectionsCards: muestra la etiqueta del método + nota de mix', () => {
    const cards = costos.renderProjectionsCards(makeSlice());
    assert.match(cards, /promedio diario × 7/);
    assert.match(cards, /promedio diario × días del mes/);
    assert.match(cards, /÷ presupuesto/);
    // Nota de mix de proveedores (Claude + Codex pagos vs free).
    assert.match(cards, /Mix de proveedores/);
    assert.match(cards, /Claude \+ Codex/);
});

test('renderDrillDown: detalle por skill con columna de proveedor, agregado, saneado (CA-5)', () => {
    const drill = costos.renderDrillDown(makeSlice());
    assert.match(drill, /guru/);
    // Columna de proveedor por fila (chip con el proveedor dominante).
    assert.match(drill, /cz-pchip/);
    assert.match(drill, /Claude/);
    // Costo AGREGADO por skill (1.2 + 0.4 = 1.6), no por sesión.
    assert.match(drill, /\$1\.60/);
    // Nunca se trunca: nota explícita.
    assert.match(drill, /nunca se truncan/);
    // No expone campos sensibles en los DATOS.
    assert.ok(!/\/Users|\/c\/|tokens_in|tokens_out|"issue"|prompt"/.test(drill));
});

test('renderDrillDown: payload XSS en nombre de skill no renderiza HTML ejecutable', () => {
    const drill = costos.renderDrillDown(makeSlice({
        sessionsBySkill: { '<script>alert(1)</script>': [{ provider: 'anthropic', cost_usd: 1, duration_ms: 1 }] },
    }));
    assert.ok(!drill.includes('<script>alert(1)</script>'), 'el <script> no debe quedar crudo');
    assert.match(drill, /&lt;script&gt;/);
});

test('renderCostosRedesign: compone todo con el contenedor morphing-target', () => {
    const html = costos.renderCostosRedesign(makeSlice());
    assert.match(html, /id="costos-redesign"/);
    assert.match(html, /cz-mission/);                 // banner de misión
    assert.match(html, /cz-budget-line/);             // gráfico
    assert.match(html, /Cuota por proveedor/);        // sección de cuotas
    assert.match(html, /cz-budget-save/);             // presupuesto
    assert.match(html, /id="cz-budget-input"/);
    // Calibración de Claude preservada con IDs invariantes (binding del shell).
    assert.match(html, /id="calib-weekly"/);
    assert.match(html, /id="calib-save"/);
});

test('renderCostosRedesign: NO re-renderiza la chrome del shell (sin onclick inline)', () => {
    const html = costos.renderCostosRedesign(makeSlice());
    // El fragmento se inyecta en el shell satélite; no incluye su propia top bar.
    assert.ok(!/onclick=/i.test(html), 'el rediseño no debe emitir onclick inline (CSP)');
});

test('renderBudgetClientScript: CSP-safe (sin onclick), postea same-origin', () => {
    const script = costos.renderBudgetClientScript();
    assert.match(script, /addEventListener\('click'/);
    assert.ok(!/onclick=/i.test(script));
    assert.match(script, /\/dashboard\/costos\/budget/);
    assert.match(script, /monthlyUsd/);
});

test('renders degradan a aviso visible ante slice vacío (no rompen)', () => {
    assert.doesNotThrow(() => costos.renderMissionBanner({}));
    assert.doesNotThrow(() => costos.renderCostosChart({}));
    assert.doesNotThrow(() => costos.renderBudgetForm({}));
    assert.doesNotThrow(() => costos.renderProjectionsCards({}));
    assert.doesNotThrow(() => costos.renderDrillDown({}));
    assert.doesNotThrow(() => costos.renderProviderQuota({}));
    assert.doesNotThrow(() => costos.renderCalibrationTool());
    assert.doesNotThrow(() => costos.renderCostosRedesign({}));
});

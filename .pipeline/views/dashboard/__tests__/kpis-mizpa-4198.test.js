// =============================================================================
// kpis-mizpa-4198.test.js — #4198 (Ola 7.1). Rediseño integral MIZPÁ de la
// pantalla KPIs: shell heredado + banner de misión que diagnostica + alertas
// con botón de salto + cards DORA con objetivo/tendencia/sparkline/badge.
//
// Cubre los criterios de aceptación del issue:
//   CA-1 → shell MIZPÁ heredado (marca/tagline, multiproyecto, nav 5+«⋯ Más»,
//          miga de pan `⋯ Más › 📊 KPIs`, tooltips).
//   CA-2 → banner de misión con medidor de salud (0–100) + lectura diagnóstica
//          en una frase + conclusión accionable.
//   CA-3 → cada alerta declara métrica rota, umbral superado y botón de salto.
//   CA-4 → métricas DORA con objetivo, tendencia, sparkline y badge de estado.
//   CA-5 → datos no disponibles se muestran explícitamente como tales (N/A).
//
// Framework: node:test + node:assert/strict (sin Jest).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function freshView() {
    delete require.cache[require.resolve('../kpis')];
    return require('../kpis');
}

const XSS_IMG = '<img src=x onerror=alert(1)>';

// Slice con cuello de botella claro: lead time alto + throughput en piso.
function bottleneckOpts() {
    return {
        kpisSlice: {
            prsLast7d: 51,
            tokens24h: { total: 130300, by_provider: { claude: 130300 } },
            agentDurationMedianMs: null,
            issueCycleTimeMs: 27 * 3600000, // 27 h
            bouncePct: { overall: 0 },
        },
        dora: { leadTimeMs: 27 * 3600000, throughputPerDay: 0, failRatePct: 0 },
        alertTray: {
            threshold_alerts: [
                { id: 'dora_lead_time', kpi: 'dora_lead_time', severity: 'bad', message: 'Lead time 27,1 h supera el umbral de 6 h' },
                { id: 'dora_throughput', kpi: 'dora_throughput', severity: 'bad', message: 'Throughput 0/día por debajo del piso de 2/día' },
                { id: 'android_dev_deliverables', kpi: 'android_dev_deliverables', skill: 'android-dev', severity: 'warn', message: 'Entregables de android-dev al 0% · por debajo del 80%' },
            ],
        },
        deliverablesBySkill: { skills: [{ skill: 'android-dev', pct: 0, delivered: 0, total: 1, severity: 'bad' }] },
        sysMini: { cpu: 38, mem: 54, health: 'Óptimo' },
        thresholds: {},
        currentView: 'kpis',
    };
}

// -----------------------------------------------------------------------------
// CA-1 — shell MIZPÁ heredado.
// -----------------------------------------------------------------------------
test('CA-1: el shell hereda marca/tagline MIZPÁ + selector multiproyecto', () => {
    const view = freshView();
    const html = view.renderKpis(bottleneckOpts());
    assert.match(html, /class="mz-name">MIZPÁ</, 'marca MIZPÁ presente');
    assert.match(html, /Que el Señor vigile/, 'tagline Génesis 31:49 presente');
    assert.match(html, /mz-projsel/, 'selector multiproyecto presente');
    assert.match(html, /mz-proj-badge">1 \/ 3/, 'badge 1/3 multiproyecto');
});

test('CA-1: miga de pan `⋯ Más › 📊 KPIs` presente', () => {
    const view = freshView();
    const html = view.renderKpis(bottleneckOpts());
    assert.match(html, /mz-crumb/, 'contenedor de miga de pan');
    assert.match(html, /⋯ Más/, 'segmento ⋯ Más');
    assert.match(html, /📊 KPIs/, 'segmento KPIs');
});

test('CA-1: nav unificada (v3-nav + «⋯ Más») con KPIs activa', () => {
    const view = freshView();
    const html = view.renderKpis(bottleneckOpts());
    assert.match(html, /class="v3-nav"/, 'nav unificada presente');
    assert.match(html, /v3-more/, 'popover «⋯ Más» presente');
    assert.match(html, /v3-tab-active[^>]*>|aria-current="page"/, 'una tab marcada activa');
});

// -----------------------------------------------------------------------------
// CA-2 — banner de misión que diagnostica.
// -----------------------------------------------------------------------------
test('CA-2: el banner muestra un medidor de salud con score 0–100', () => {
    const view = freshView();
    const html = view.renderKpis(bottleneckOpts());
    assert.match(html, /kpis-mission/, 'banner de misión presente');
    assert.match(html, /kpis-gauge-ring/, 'medidor (gauge) presente');
    assert.match(html, /kpis-gauge-val">\d+</, 'score numérico 0–100 en el gauge');
    assert.match(html, /conic-gradient/, 'arco del gauge proporcional al score');
});

test('CA-2: lectura diagnóstica en una frase + conclusión accionable', () => {
    const view = freshView();
    const d = view._computeHealthDiagnosis(bottleneckOpts());
    assert.equal(d.na, false, 'con señal NO es N/A');
    assert.ok(d.score >= 0 && d.score <= 100, 'score en rango');
    assert.match(d.headline, /produce, pero va lento/, 'lectura del cuello de botella');
    assert.ok(d.reco && d.reco.href && d.reco.btnLabel, 'conclusión accionable con botón de salto');
    assert.match(d.reco.href, /^\/(matriz|issues|pipeline|ops)$/, 'salto a una ruta interna conocida');
});

test('CA-2: el banner penaliza el score ante alertas rojas y lead time alto', () => {
    const view = freshView();
    const d = view._computeHealthDiagnosis(bottleneckOpts());
    assert.ok(d.score < 80, `score degradado por el cuello de botella (got ${d.score})`);
});

// -----------------------------------------------------------------------------
// CA-3 — alertas con métrica, umbral y botón de salto.
// -----------------------------------------------------------------------------
test('CA-3: cada alerta declara métrica + umbral y ofrece botón de salto', () => {
    const view = freshView();
    const html = view.renderThresholdAlertsHTML(bottleneckOpts().alertTray);
    assert.match(html, /supera el umbral de 6 h/, 'métrica rota + umbral en el mensaje');
    assert.match(html, /kpis-alert-jump/, 'botón de salto presente');
    assert.match(html, /href="\/matriz"/, 'salto contextual a Matriz (lead time)');
    assert.match(html, /href="\/pipeline"/, 'salto contextual a Pipeline (throughput)');
    assert.match(html, /href="\/issues"/, 'salto contextual a Issues (entregables)');
});

test('CA-3: el destino del salto se clasifica por la métrica de la alerta', () => {
    const view = freshView();
    assert.equal(view._alertJumpTarget({ kpi: 'dora_lead_time' }).href, '/matriz');
    assert.equal(view._alertJumpTarget({ kpi: 'dora_throughput' }).href, '/pipeline');
    assert.equal(view._alertJumpTarget({ kpi: 'android_deliverables', skill: 'android-dev' }).href, '/issues');
    assert.equal(view._alertJumpTarget({ kpi: 'voice_p95' }).href, '/ops');
    assert.equal(view._alertJumpTarget({}).href, '/pipeline', 'default conservador');
});

test('CA-3: el botón de salto NO refleja datos de la alerta (anti-XSS)', () => {
    const view = freshView();
    const html = view.renderThresholdAlertsHTML({
        threshold_alerts: [{ id: XSS_IMG, kpi: XSS_IMG, severity: 'warn', message: 'x', provider: XSS_IMG }],
    });
    assert.ok(!html.includes(XSS_IMG), 'payload crudo no aparece');
    // El href del salto es una ruta interna constante, nunca el kpi/id del alert.
    assert.ok(/href="\/(pipeline|matriz|issues|ops|multi-provider)"/.test(html), 'href constante interno');
});

// -----------------------------------------------------------------------------
// CA-4 — cards DORA con objetivo, tendencia, sparkline y badge.
// -----------------------------------------------------------------------------
test('CA-4: cada card DORA lleva objetivo, badge de estado y sparkline', () => {
    const view = freshView();
    const o = bottleneckOpts();
    const html = view.renderDoraAndCommanderHTML({
        kpisSlice: o.kpisSlice, routingMetrics: {}, dora: o.dora, thresholds: o.thresholds,
        doraSpark: { cycle: [10, 12, 15, 20, 27], bounce: [2, 1, 0], prs: [40, 45, 51], duration: null },
    });
    assert.match(html, /dora-mini-grid/, 'grid DORA presente');
    assert.match(html, /dora-badge/, 'badge de estado presente');
    assert.match(html, /objetivo ≤/, 'objetivo declarado');
    assert.match(html, /dora-trend/, 'flecha de tendencia presente');
    assert.match(html, /kpi-spark|kpi-spark-empty/, 'sparkline presente');
    // Cycle time 27h vs objetivo 6h → badge de exceso (×).
    assert.match(html, /× alto/, 'cycle time sobre objetivo marcado con badge de exceso');
});

test('CA-4/CA-5: dato DORA sin muestra → badge "muestra insuf." y card .na', () => {
    const view = freshView();
    const html = view.renderDoraAndCommanderHTML({
        kpisSlice: { issueCycleTimeMs: null, agentDurationMedianMs: null, bouncePct: {}, prsLast7d: null },
        routingMetrics: {}, dora: {}, thresholds: {}, doraSpark: {},
    });
    assert.match(html, /dora-badge b-na/, 'badge N/A presente');
    assert.match(html, /muestra insuf\./, 'texto de muestra insuficiente');
    assert.match(html, /dora-mini-card na/, 'card marcada como N/A (.na)');
});

// -----------------------------------------------------------------------------
// CA-5 — N/A honesto en el banner cuando no hay señal.
// -----------------------------------------------------------------------------
test('CA-5: sin señal medible el banner degrada a N/A (no inventa score)', () => {
    const view = freshView();
    const d = view._computeHealthDiagnosis({});
    assert.equal(d.na, true, 'sin datos → N/A');
    assert.equal(d.score, null, 'no inventa un score');
    assert.match(d.headline, /insuficientes/i, 'lo dice explícitamente');
});

test('CA-5: el banner N/A renderiza un gauge "—" sin arco', () => {
    const view = freshView();
    const html = view.renderMissionBannerHTML({});
    assert.match(html, /kpis-gauge-val">—</, 'gauge muestra — en N/A');
    assert.match(html, /sev-na/, 'estilo N/A aplicado');
});

// -----------------------------------------------------------------------------
// Robustez — el banner no rompe con opts ausente y es seguro.
// -----------------------------------------------------------------------------
test('renderMissionBannerHTML no lanza con opts ausente', () => {
    const view = freshView();
    const html = view.renderMissionBannerHTML();
    assert.ok(typeof html === 'string' && html.includes('kpis-mission'));
});

test('CA-2 (XSS): un health malicioso en sysMini no rompe el banner', () => {
    const view = freshView();
    const html = view.renderMissionBannerHTML({
        sysMini: { health: XSS_IMG }, alertTray: { threshold_alerts: [] },
    });
    assert.ok(!html.includes(XSS_IMG), 'no refleja el payload crudo');
});

// -----------------------------------------------------------------------------
// _trendArrow — degrade honesto y semántica de color.
// -----------------------------------------------------------------------------
test('_trendArrow: serie corta → null (sin señal falsa)', () => {
    const view = freshView();
    assert.equal(view._trendArrow([1], true), null);
    assert.equal(view._trendArrow(null, true), null);
});

test('_trendArrow: subida con higherIsWorse pinta rojo (up)', () => {
    const view = freshView();
    const t = view._trendArrow([5, 10, 20], true);
    assert.equal(t.cls, 'up', 'peor → clase up (rojo)');
    const g = view._trendArrow([20, 10, 5], false);
    assert.equal(g.cls, 'up', 'baja con higherIsBetter → peor (rojo)');
});

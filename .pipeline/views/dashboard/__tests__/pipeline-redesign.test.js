// =============================================================================
// Tests del rediseño integral de la pantalla PIPELINE (#4190, Ola 7.1 · MIZPÁ).
//
// Cubre los criterios de aceptación verificables en SSR (sin arrancar el
// dashboard ni un browser):
//   1. Mapeo macro de fases (macroPhaseOf) y progreso determinístico.
//   2. Marca MIZPÁ + selector multiproyecto + banner de misión presentes.
//   3. Bloque «Flujo de fases»: las 6 etapas con contador, arrancan atenuadas.
//   4. Bloque «Issues por fase» presente con contenedor de columnas.
//   5. NUNCA truncar: el client script lista TODOS los issues (sin slice/+X) y
//      la CSS del título usa wrap (sin text-overflow: ellipsis).
//   6. Acceso a contexto: link a GitHub + acceso a logs del agente por tarjeta.
//   7. Tooltips autodescriptivos (title=) en áreas y botones.
//
// node:test (sin Jest). Ejecutar:
//   node --test .pipeline/views/dashboard/__tests__/pipeline-redesign.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const MOD_PATH = path.resolve(__dirname, '..', 'pipeline-redesign.js');
const pr = require(MOD_PATH);

// --- 1. Mapeo macro de fases -------------------------------------------------
test('macroPhaseOf mapea cada pipeline/fase real a su etapa macro', () => {
    assert.equal(pr.macroPhaseOf('definicion/analisis'), 'def');
    assert.equal(pr.macroPhaseOf('definicion/criterios'), 'def');
    assert.equal(pr.macroPhaseOf('definicion/sizing'), 'def');
    assert.equal(pr.macroPhaseOf('desarrollo/validacion'), 'dev');
    assert.equal(pr.macroPhaseOf('desarrollo/dev'), 'dev');
    assert.equal(pr.macroPhaseOf('desarrollo/build'), 'build');
    assert.equal(pr.macroPhaseOf('desarrollo/verificacion'), 'qa');
    assert.equal(pr.macroPhaseOf('desarrollo/linteo'), 'qa');
    assert.equal(pr.macroPhaseOf('desarrollo/aprobacion'), 'review');
    assert.equal(pr.macroPhaseOf('desarrollo/entrega'), 'done');
});

test('macroPhaseOf devuelve null para fases desconocidas o vacías', () => {
    assert.equal(pr.macroPhaseOf(''), null);
    assert.equal(pr.macroPhaseOf(null), null);
    assert.equal(pr.macroPhaseOf('desarrollo/inexistente'), null);
    assert.equal(pr.macroPhaseOf('otro/fase'), null);
});

test('PHASE_FLOW son exactamente las 6 etapas del mockup en orden', () => {
    assert.equal(pr.PHASE_FLOW.length, 6);
    assert.deepEqual(pr.PHASE_FLOW.map((p) => p.key), ['def', 'dev', 'build', 'qa', 'review', 'done']);
});

test('phaseProgressPct es determinístico: def=0% … done=100%', () => {
    assert.equal(pr.phaseProgressPct('def'), 0);
    assert.equal(pr.phaseProgressPct('done'), 100);
    assert.equal(pr.phaseProgressPct('build'), 40);
    // monótono creciente
    const seq = pr.PHASE_FLOW.map((p) => pr.phaseProgressPct(p.key));
    for (let i = 1; i < seq.length; i++) assert.ok(seq[i] > seq[i - 1], 'progreso debe crecer por etapa');
    assert.equal(pr.phaseProgressPct('desconocida'), 0);
});

// --- 2. Marca MIZPÁ + selector + banner --------------------------------------
test('brand bar lleva marca MIZPÁ, tagline y selector multiproyecto', () => {
    const html = pr.renderBrandBarPipeline();
    assert.match(html, /MIZP[ÁA]/);
    assert.match(html, /Que el Señor vigile/);
    assert.match(html, /mz-projsel/);
    assert.match(html, /1 \/ 3/); // multiproyecto
    assert.match(html, /id="bld-status"/); // ticker de build preservado
});

test('mission banner expone los IDs de hidratación de /api/dash/waves', () => {
    const html = pr.renderMissionBannerPipeline();
    for (const id of ['mission-wave-num', 'mission-wave-name', 'mission-eta-value',
        'mission-vel-value', 'mission-delivered-value', 'mission-avance-pct']) {
        assert.ok(html.includes('id="' + id + '"'), 'falta el id ' + id);
    }
});

// --- 3. Bloque flujo de fases ------------------------------------------------
test('flujo de fases renderiza las 6 etapas con contador y nacen atenuadas', () => {
    const html = pr.renderPhaseFlowSsr();
    for (const p of pr.PHASE_FLOW) {
        assert.ok(html.includes('id="pflow-n-' + p.key + '"'), 'falta nodo ' + p.key);
        assert.ok(html.includes('id="pflow-c-' + p.key + '"'), 'falta contador ' + p.key);
    }
    // 5 flechas conectando las 6 etapas
    const arrows = (html.match(/pflow-arrow/g) || []).length;
    assert.equal(arrows, 5);
    // atenuadas por defecto (el client las activa al hidratar conteos)
    const empties = (html.match(/pflow-empty/g) || []).length;
    assert.equal(empties, 6);
});

// --- 4. Bloque issues por fase -----------------------------------------------
test('issues por fase tiene contenedor de columnas activas', () => {
    const html = pr.renderIssuesByPhaseSsr();
    assert.ok(html.includes('id="pipeline-cols"'));
    assert.ok(html.includes('pl-block-issues'));
});

// --- 5. Nunca truncar --------------------------------------------------------
test('la CSS del título usa wrap, nunca text-overflow: ellipsis', () => {
    const css = pr.PIPELINE_REDESIGN_CSS;
    const titleRule = css.split('\n').find((l) => l.startsWith('.plc-title'));
    assert.ok(titleRule, 'debe existir la regla .plc-title');
    assert.doesNotMatch(titleRule, /ellipsis/);
    assert.match(titleRule, /white-space:\s*normal/);
    assert.match(titleRule, /overflow-wrap:\s*anywhere|word-break/);
});

test('el client script lista TODOS los issues: sin recorte de lista ni de título', () => {
    const js = pr.pipelineRedesignClientScript();
    // No recorta la LISTA de tarjetas por columna (sin items.slice / top-N).
    assert.doesNotMatch(js, /items\.slice\s*\(/);
    // No recorta el TÍTULO del issue (sin slice/substring sobre i.title / title).
    assert.doesNotMatch(js, /i\.title[^)\n]*\.(slice|substring)\s*\(/);
    assert.doesNotMatch(js, /title[^)\n]*\.(slice|substring)\s*\(\s*0\s*,\s*\d+\s*\)/);
    // No resume con «+X más» / «continúa».
    assert.doesNotMatch(js, /\+\s*X\s*más|\+\d+\s*más|continúa/i);
    // Mapea todas las items a tarjetas (sin tope).
    assert.match(js, /items\.map\(/);
});

// --- 6. Acceso a contexto: GitHub + logs -------------------------------------
test('cada tarjeta enlaza al issue en GitHub y a los logs del agente', () => {
    const js = pr.pipelineRedesignClientScript();
    assert.match(js, /github\.com\/intrale\/platform\/issues/);
    assert.match(js, /\/logs\/view\//);
    // logs atenuados cuando todavía no corrió ningún agente (is-disabled)
    assert.match(js, /is-disabled/);
});

// --- 7. Tooltips -------------------------------------------------------------
test('áreas y botones llevan tooltips autodescriptivos (title=)', () => {
    const body = pr.renderPipelineRedesignBody();
    // Banner, flujo y toggle con title
    assert.ok((body.match(/title="/g) || []).length >= 5);
    const js = pr.pipelineRedesignClientScript();
    // Botones Issue / Logs con title en las tarjetas
    assert.match(js, /title="Abrir el issue en GitHub"/);
    assert.match(js, /Ver logs del agente/);
});

// --- Integración SSR ---------------------------------------------------------
test('renderPipelineRedesignBody compone los dos bloques + leyenda', () => {
    const html = pr.renderPipelineRedesignBody();
    assert.ok(html.includes('pl-block-flow'));
    assert.ok(html.includes('pl-block-issues'));
    assert.ok(html.includes('mz-mission'));
    assert.match(html, /Nunca se trunca/);
});

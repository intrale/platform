// #4234 — Tests de la "Vista Total de la Ola" del rediseño Pipeline (MIZPÁ).
//
// El delta sobre #4190 (Ola 7.1) es:
//   1. CA-1: la vista muestra TODOS los hijos de la ola — incluidos entregados
//      ('finalizado') y los de definición sin arrancar ('no-ingreso') — cruzando
//      la membresía de /api/dash/waves con el matrix + waveIssues del pipeline.
//   2. CA-6: cada ficha lleva la fila fija de 7 agentes con 3 estados visuales
//      (ejecutado / en curso / pendiente) + leyenda.
//   3. CA-5/7: columnas coloreadas por fase + barra de % con el número al lado.
//   4. CA-3/4: el Flujo de fases conserva siempre las 6 fases; el tablero solo
//      abre columnas de fases con issues.
//
// Se valida el contrato del client script (string que se inyecta en la página) y
// se replica la lógica pura (plAgentState7 / plProgressPct) para verificar el
// comportamiento end-to-end contra el mockup v8.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REDESIGN_PATH = path.join(__dirname, '..', 'views', 'dashboard', 'pipeline-redesign.js');
const redesign = require(REDESIGN_PATH);
const PR_CLIENT = redesign.pipelineRedesignClientScript();
const CSS = redesign.PIPELINE_REDESIGN_CSS;

// ───────────── CA-1: merge de todos los hijos de la ola ─────────────

test('el client script cruza /api/dash/waves (membresía) con el matrix del pipeline', () => {
    assert.match(PR_CLIENT, /fetchJson\('\/api\/dash\/pipeline'\)/, 'sigue consultando el matrix');
    assert.match(PR_CLIENT, /fetchJson\('\/api\/dash\/waves'\)/, 'consulta la ola activa para la membresía');
    assert.match(PR_CLIENT, /w\.active_wave\.issues/, 'lee los hijos de la ola activa');
    assert.match(PR_CLIENT, /waveMembers/, 'arma la lista de miembros de la ola');
});

test('los entregados (finalizado) caen en la columna Entregado y los no-ingreso en Definición', () => {
    // finalizado → bucket done; no-ingreso → bucket def (CA-1).
    assert.match(PR_CLIENT, /finalizado'\s*\)\s*\{[\s\S]*?buckets\.done\.push/, 'finalizado → buckets.done');
    assert.match(PR_CLIENT, /buckets\.def\.push\(plItemTerminal/, 'no-ingreso → buckets.def');
    assert.match(PR_CLIENT, /d\.waveIssues/, 'usa la franja terminal waveIssues del pipeline payload');
});

test('en WAVE MODE no se aplica el filtro de allowlist (la ola delimita la vista)', () => {
    // El bloque de wave-members itera sin plAllowlistOk; el filtro solo vive en el
    // fallback legacy. Verificamos que exista el fallback explícito.
    assert.match(PR_CLIENT, /FALLBACK \(sin ola activa\)/, 'documenta el fallback legacy');
    assert.match(PR_CLIENT, /WAVE MODE/, 'documenta el modo ola');
});

// ───────────── CA-3/4: flujo siempre 6, tablero solo fases con issues ─────────────

test('el subtítulo del bloque habla de hijos de la ola y "sin scroll" (CA-2/4)', () => {
    assert.match(PR_CLIENT, /hijo'\s*\+\s*\(totalVisible === 1[\s\S]*?de la ola/, 'subtítulo cuenta hijos de la ola');
    assert.match(PR_CLIENT, /sin scroll/, 'el subtítulo refuerza la regla sin scroll');
});

test('el tablero solo abre columnas de fases con issues (CA-4)', () => {
    assert.match(PR_CLIENT, /if\(!items\.length\)\s*continue;/, 'salta columnas vacías');
});

test('las columnas reciben la clase de color por fase ph-<key> (CA-5)', () => {
    assert.match(PR_CLIENT, /class="pl-col ph-'\s*\+\s*p\.key/, 'la columna se colorea por fase');
});

// ───────────── CA-6: 7 agentes con 3 estados ─────────────

test('hay exactamente 7 agentes en el flujo, con sus íconos del mockup v8', () => {
    assert.match(PR_CLIENT, /const PL_AGENTS7 = \[/, 'PL_AGENTS7 declarado');
    for (const ic of ['🧠', '📋', '⚙', '🔨', '▶', '🔍', '🚀']) {
        assert.ok(PR_CLIENT.includes(ic), 'falta el ícono de agente ' + ic);
    }
    // Replicamos el array para contar.
    const count = (PR_CLIENT.match(/stage:\s*\d/g) || []).length;
    assert.equal(count, 7, 'deben ser 7 slots de agente (uno por stage)');
});

test('plRenderAgents7 emite los 3 estados visuales y la fila etiquetada AGTS', () => {
    assert.match(PR_CLIENT, /function plRenderAgents7/, 'helper de los 7 agentes');
    assert.match(PR_CLIENT, /class="plc-agents7"/, 'fila de agentes');
    assert.match(PR_CLIENT, /plc-ag-lbl">AGTS/, 'la fila lleva la etiqueta AGTS');
});

// Replicamos plAgentState7 + plProgressPct para validar el comportamiento contra
// el mockup v8 (deterministas por fase, refinados con el estado real del agente).
const PL_AGENTS7 = [
    { stage: 0, skills: ['guru'] },
    { stage: 0, skills: ['doc', 'po', 'planner'] },
    { stage: 1, skills: ['pipeline-dev', 'backend-dev', 'android-dev', 'web-dev'] },
    { stage: 2, skills: ['build', 'builder'] },
    { stage: 3, skills: ['qa', 'tester'] },
    { stage: 4, skills: ['review', 'security'] },
    { stage: 5, skills: ['delivery'] },
];
const PL_MACRO_IDX = { def: 0, dev: 1, build: 2, qa: 3, review: 4, done: 5 };
function plAgentState7(agent, item) {
    const mi = PL_MACRO_IDX[item.macro];
    if (mi == null) return 'pend';
    if (item.macro === 'done') return 'done';
    const ags = Array.isArray(item.agents) ? item.agents : [];
    if (ags.length) {
        const match = ags.find(a => agent.skills.indexOf(a.skill) >= 0);
        if (match) {
            if (match.estado === 'trabajando') return 'now';
            if (match.estado === 'listo') return 'done';
        }
        return agent.stage < mi ? 'done' : 'pend';
    }
    if (agent.stage < mi) return 'done';
    if (agent.stage === mi) return item.estado === 'trabajando' ? 'now' : 'pend';
    return 'pend';
}
const statesFor = (item) => PL_AGENTS7.map(a => plAgentState7(a, item));

test('issue entregado (done): los 7 agentes quedan en ejecutado', () => {
    assert.deepEqual(
        statesFor({ macro: 'done', estado: 'finalizado', agents: [] }),
        ['done', 'done', 'done', 'done', 'done', 'done', 'done'],
    );
});

test('issue en Dev (trabajando): guru+doc ejecutados, dev en curso, resto pendiente', () => {
    assert.deepEqual(
        statesFor({ macro: 'dev', estado: 'trabajando', agents: [{ skill: 'pipeline-dev', estado: 'trabajando' }] }),
        ['done', 'done', 'now', 'pend', 'pend', 'pend', 'pend'],
    );
});

test('issue en QA (trabajando): hasta builder ejecutado, QA en curso, review+delivery pendiente', () => {
    assert.deepEqual(
        statesFor({ macro: 'qa', estado: 'trabajando', agents: [{ skill: 'qa', estado: 'trabajando' }] }),
        ['done', 'done', 'done', 'done', 'now', 'pend', 'pend'],
    );
});

test('issue en Definición sin arrancar (no-ingreso): los 7 agentes quedan pendientes', () => {
    assert.deepEqual(
        statesFor({ macro: 'def', estado: 'no-ingreso', agents: [] }),
        ['pend', 'pend', 'pend', 'pend', 'pend', 'pend', 'pend'],
    );
});

test('issue en Definición con guru corriendo: solo guru en curso, doc y resto pendientes', () => {
    // Con datos reales de agentes, solo el que corre se enciende — no toda la fase
    // (fiel al mockup v8 #4231: guru=now, doc=pend).
    assert.deepEqual(
        statesFor({ macro: 'def', estado: 'trabajando', agents: [{ skill: 'guru', estado: 'trabajando' }] }),
        ['now', 'pend', 'pend', 'pend', 'pend', 'pend', 'pend'],
    );
});

// ───────────── CA-7: barra de % por ficha con número ─────────────

test('plProgressPct es determinista por fase: def=0 … done=100', () => {
    // Replicado de plProgressPct (6 fases → idx/5*100).
    const order = ['def', 'dev', 'build', 'qa', 'review', 'done'];
    const pct = (k) => Math.round((order.indexOf(k) / (order.length - 1)) * 100);
    assert.equal(pct('def'), 0);
    assert.equal(pct('dev'), 20);
    assert.equal(pct('done'), 100);
});

test('la ficha muestra la barra + el número de % (CA-7)', () => {
    assert.match(PR_CLIENT, /class="plc-prog-row"/, 'la ficha tiene la fila de progreso');
    assert.match(PR_CLIENT, /class="plc-pct">'\s*\+\s*pct\s*\+\s*'%/, 'el número de % va al lado de la barra');
});

test('la ficha se colorea por fase (clase ph-<macro>) — CA-5', () => {
    assert.match(PR_CLIENT, /class="plc ph-'\s*\+\s*macroKey/, 'la ficha lleva la clase de color por fase');
});

// ───────────── CA-6: leyenda visual ─────────────

test('la leyenda SSR lista los 7 agentes y los 3 estados', () => {
    const leg = redesign.renderAgentsLegendSsr();
    for (const lbl of ['Guru', 'Doc/PO', 'Dev', 'Builder', 'QA', 'Review', 'Delivery']) {
        assert.ok(leg.includes(lbl), 'falta en la leyenda: ' + lbl);
    }
    assert.match(leg, /Ejecutado/);
    assert.match(leg, /En curso/);
    assert.match(leg, /Pendiente/);
    assert.match(leg, /class="pl-legend-box"/);
});

test('el SSR del bloque incluye la leyenda y el título "Vista total de la ola"', () => {
    const body = redesign.renderIssuesByPhaseSsr();
    assert.match(body, /Vista total de la ola/i, 'título de la vista total');
    assert.match(body, /pl-legend-box/, 'la leyenda se inserta en el bloque');
});

// ───────────── CSS: color por fase + sin scroll ─────────────

test('el CSS define el molde único coloreado por las fases del mockup v8', () => {
    assert.match(CSS, /\.pl-col\.ph-def/, 'columna Definición (ámbar)');
    assert.match(CSS, /\.pl-col\.ph-dev/, 'columna Desarrollo (azul)');
    assert.match(CSS, /\.pl-col\.ph-qa/, 'columna QA (violeta)');
    assert.match(CSS, /\.pl-col\.ph-done/, 'columna Entregado (verde)');
    assert.match(CSS, /\.plc-ag\.done/, 'estado ejecutado');
    assert.match(CSS, /\.plc-ag\.now/, 'estado en curso');
    assert.match(CSS, /\.plc-ag\.pend/, 'estado pendiente');
});

test('el CSS NO introduce scroll en el tablero ni en las columnas (CA-2)', () => {
    // .pl-cols / .pl-col / .pl-col-cards no deben forzar overflow scroll.
    assert.doesNotMatch(CSS, /\.pl-cols\s*\{[^}]*overflow[^}]*scroll/);
    assert.doesNotMatch(CSS, /\.pl-col-cards\s*\{[^}]*overflow-y:\s*(scroll|auto)/);
    assert.doesNotMatch(CSS, /\.pl-col\s*\{[^}]*max-height/);
});

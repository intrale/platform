// =============================================================================
// wave-roadmap-lifecycle.test.js — #4436.
//
// Render de los controles de ciclo de vida en la tarjeta de la ola activa +
// handlers cliente. Verifica (CA-1/CA-2/CA-3/CA-4/CA-5, CA-Q2, CA-UX-*):
//   - renderActiveCard muestra Pausar con mode:'running'/'partial_pause' y
//     Reanudar con mode:'paused'; Relanzar despacho siempre.
//   - El pill de estado en vivo usa las clases in-mode-* (color+glyph+texto).
//   - Los botones usan exclusivamente iconos del sprite (ic-pause-lock/ic-play/
//     ic-restart) — no emojis del SO como iconografía primaria.
//   - Los handlers cliente disparan inConfirm antes del fetch, con danger:true en
//     las destructivas (Pausar/Relanzar) y danger:false en Reanudar.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const v = require('../wave-roadmap');

function activeWave() {
    return { number: 8, name: 'Ola 8', goal: 'Cerrar gaps', issues: [{ number: 100, status: 'in-progress' }] };
}

test('CA-1: mode running → botón Pausar visible, Reanudar oculto', () => {
    const html = v.renderActiveCard(activeWave(), { mode: 'running' });
    assert.ok(html.includes('roadmapPause()'), 'Pausar presente');
    assert.equal(html.includes('roadmapResume()'), false, 'Reanudar ausente');
    assert.ok(html.includes('roadmapDispatch()'), 'Relanzar despacho presente');
});

test('CA-1: mode partial_pause → también muestra Pausar', () => {
    const html = v.renderActiveCard(activeWave(), { mode: 'partial_pause' });
    assert.ok(html.includes('roadmapPause()'), 'Pausar presente con partial_pause');
    assert.equal(html.includes('roadmapResume()'), false, 'Reanudar ausente');
});

test('CA-2: mode paused → botón Reanudar visible, Pausar oculto', () => {
    const html = v.renderActiveCard(activeWave(), { mode: 'paused' });
    assert.ok(html.includes('roadmapResume()'), 'Reanudar presente');
    assert.equal(html.includes('roadmapPause()'), false, 'Pausar ausente');
    assert.ok(html.includes('roadmapDispatch()'), 'Relanzar despacho presente');
});

test('CA-3: Relanzar despacho visible en cualquier mode', () => {
    for (const mode of ['running', 'paused', 'partial_pause']) {
        const html = v.renderActiveCard(activeWave(), { mode });
        assert.ok(html.includes('roadmapDispatch()'), `dispatch presente con ${mode}`);
    }
});

test('CA-4: pill de estado con clase in-mode-* + glyph + texto (nunca color-only)', () => {
    const running = v.renderActiveCard(activeWave(), { mode: 'running' });
    assert.ok(/wr-state-pill in-mode-running/.test(running));
    assert.ok(running.includes('🟢 Corriendo'));
    assert.ok(running.includes('id="wr-active-state"'), 'pill con id para refresco en vivo');

    const paused = v.renderActiveCard(activeWave(), { mode: 'paused' });
    assert.ok(/wr-state-pill in-mode-paused/.test(paused));
    assert.ok(paused.includes('⏸ Pausada'));

    const partial = v.renderActiveCard(activeWave(), { mode: 'partial_pause' });
    assert.ok(/wr-state-pill in-mode-partial/.test(partial));
    assert.ok(partial.includes('⏸ Parcial'));
});

test('CA-4: mode desconocido/ausente degrada a running (defensivo)', () => {
    const noMode = v.renderActiveCard(activeWave(), {});
    assert.ok(noMode.includes('roadmapPause()'), 'sin mode asume running → Pausar');
    assert.ok(/in-mode-running/.test(noMode));
    const weird = v.renderActiveCard(activeWave(), { mode: 'garbage' });
    assert.ok(/in-mode-running/.test(weird), 'mode inválido → running');
});

test('CA-UX-1: botones usan iconos del sprite (ic-pause-lock/ic-play/ic-restart)', () => {
    assert.ok(v.renderActiveCard(activeWave(), { mode: 'running' }).includes('#ic-pause-lock'));
    assert.ok(v.renderActiveCard(activeWave(), { mode: 'paused' }).includes('#ic-play'));
    assert.ok(v.renderActiveCard(activeWave(), { mode: 'running' }).includes('#ic-restart'));
});

test('accesibilidad: cada botón lleva aria-label descriptivo', () => {
    const html = v.renderActiveCard(activeWave(), { mode: 'running' });
    assert.ok(/aria-label="[^"]*Pausar la ola activa[^"]*"/.test(html));
    assert.ok(/aria-label="[^"]*Relanzar el despacho de la ola activa[^"]*"/.test(html));
});

// --- Handlers cliente ---

test('CA-5/CA-Q2: handlers cliente disparan inConfirm antes del fetch', () => {
    const cs = v.renderRoadmapClientScript();
    // Cada handler existe y llama inConfirm antes de _roadmapLifecyclePost.
    for (const fn of ['roadmapPause', 'roadmapResume', 'roadmapDispatch']) {
        const re = new RegExp(`async function ${fn}\\(\\)[\\s\\S]*?inConfirm\\([\\s\\S]*?_roadmapLifecyclePost`);
        assert.ok(re.test(cs), `${fn} confirma antes de postear`);
    }
});

test('CA-5: destructivas con danger:true; Reanudar con danger:false', () => {
    const cs = v.renderRoadmapClientScript();
    const pauseBlock = cs.slice(cs.indexOf('async function roadmapPause'), cs.indexOf('async function roadmapResume'));
    const resumeBlock = cs.slice(cs.indexOf('async function roadmapResume'), cs.indexOf('async function roadmapDispatch'));
    const dispatchBlock = cs.slice(cs.indexOf('async function roadmapDispatch'), cs.indexOf('async function roadmapTickState'));
    assert.ok(/danger:\s*true/.test(pauseBlock), 'Pausar danger:true');
    assert.ok(/danger:\s*false/.test(resumeBlock), 'Reanudar danger:false');
    assert.ok(/danger:\s*true/.test(dispatchBlock), 'Relanzar danger:true');
});

test('handlers registrados en window + tick de estado en vivo', () => {
    const cs = v.renderRoadmapClientScript();
    assert.ok(cs.includes('window.roadmapPause = roadmapPause'));
    assert.ok(cs.includes('window.roadmapResume = roadmapResume'));
    assert.ok(cs.includes('window.roadmapDispatch = roadmapDispatch'));
    assert.ok(cs.includes('roadmapTickState'), 'refresco en vivo del pill');
    // POST al endpoint correcto vía nhCsrfHeaders (mismo gate que archive).
    assert.ok(cs.includes("'/dashboard/wave/pause'"));
    assert.ok(cs.includes("'/dashboard/wave/resume'"));
    assert.ok(cs.includes("'/dashboard/wave/dispatch'"));
    assert.ok(cs.includes('nhCsrfHeaders()'));
});

test('sin ola activa → empty state (no rompe, no botones de ciclo de vida)', () => {
    const html = v.renderActiveCard(null, { mode: 'running' });
    assert.ok(html.includes('Sin ola activa'));
    assert.equal(html.includes('roadmapPause()'), false);
});

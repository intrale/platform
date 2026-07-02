// =============================================================================
// Tests de la vista operativa consolidada del Roadmap de olas (#4373, Ola 8.3).
//
// Sobre la base de #4378 (wave-roadmap.js), #4373 enriquece la vista cuando el
// caller pasa `opts.roadmap` (payload del `roadmapSlice`):
//   CA-1/CA-2/CA-3/CA-4 → render SSR con ola activa + planificadas + archivadas
//                         + issues hijos (número, título, estado).
//   CA-5 → prioridad por issue como badge con texto (no color-only).
//   CA-6 → barra de avance "cerrados/total · %".
//   CA-7 → panel de bloqueos con motivo/blocker textual + marca en el chip.
//   CA-8 → ETA p50/p75/p90; aviso "estimación con poca muestra" si lowSample.
//   CA-S1 → escapado XSS de TODO texto dinámico (título, goal, motivo, nombre).
//   Degradación → sin opts.roadmap y sin datos, render vacío sin throw.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const view = require('../wave-roadmap');

function fixtureRoadmap() {
    return {
        activeWave: {
            number: 8,
            name: 'Ola 8.3',
            goal: 'Roadmap operativo',
            issues: [
                { id: 4373, title: 'Vista roadmap', priority: 'medium', status: 'in-progress', merged: false },
                { id: 4360, title: 'Otra cosa', priority: 'high', status: 'blocked', merged: false },
                { id: 4300, title: 'Ya hecho', priority: 'low', status: 'completed', merged: true },
            ],
        },
        plannedWaves: [
            { number: 9, name: 'Ola 9', goal: 'Siguiente', issues: [{ id: 5000, title: 'Futuro', priority: 'low', status: 'queued' }] },
        ],
        archivedWaves: [
            { number: 7, name: 'Ola 7', goal: 'Cerrada', closedAt: '2026-06-30T02:15:00Z', issuesCompleted: 5, issuesFailed: 1, issues: [{ id: 4000, title: 'Viejo', status: 'completed' }] },
        ],
        blocked: [
            { issue: 4360, blocker: 4350, reason: 'espera schema waves.json' },
        ],
        eta: { ready: true, lowSample: false, p50: 45, p75: 90, p90: 150, totalPct: 33 },
        avance: { closed: 1, total: 3, pct: 33 },
        updatedAt: '2026-07-02T10:00:00Z',
    };
}

test('CA-1/2/3/4: render enriquecido muestra activa, planificadas, archivadas e hijos', () => {
    const html = view.renderRoadmapSsr({ roadmap: fixtureRoadmap() });
    // Ola activa + nombre + goal.
    assert.ok(html.includes('Ola 8.3'), 'muestra nombre de la ola activa');
    assert.ok(html.includes('Roadmap operativo'), 'muestra el goal de la ola activa');
    // Issues hijos (número + título).
    assert.ok(html.includes('#4373'), 'muestra issue hijo de la activa');
    assert.ok(html.includes('Vista roadmap'), 'muestra título del hijo');
    // Planificada + archivada.
    assert.ok(html.includes('Ola 9'), 'muestra ola planificada');
    assert.ok(html.includes('Ola 7'), 'muestra ola archivada');
    assert.ok(html.includes('#4000'), 'muestra issue de la archivada');
});

test('CA-3: la ola archivada muestra la fecha de cierre (closed_at)', () => {
    const html = view.renderRoadmapSsr({ roadmap: fixtureRoadmap() });
    assert.ok(html.includes('2026-06-30T02:15:00Z'), 'muestra closed_at de la archivada');
});

test('CA-5: prioridad por issue como badge con texto', () => {
    const html = view.renderRoadmapSsr({ roadmap: fixtureRoadmap() });
    assert.ok(html.includes('wr-prio-medium'), 'badge de prioridad medium presente');
    assert.ok(html.includes('wr-prio-high'), 'badge de prioridad high presente');
    // El texto de la prioridad (no solo color) debe estar visible.
    assert.ok(/>medium</.test(html), 'texto "medium" visible en el badge');
});

test('renderPriorityBadge ignora prioridades fuera de whitelist', () => {
    assert.equal(view.renderPriorityBadge('devastating'), '');
    assert.equal(view.renderPriorityBadge(''), '');
    assert.equal(view.renderPriorityBadge(null), '');
    assert.ok(view.renderPriorityBadge('CRITICAL').includes('wr-prio-critical'), 'normaliza case');
});

test('CA-6: barra de avance muestra cerrados/total · %', () => {
    const html = view.renderRoadmapSsr({ roadmap: fixtureRoadmap() });
    assert.ok(html.includes('1 / 3 cerrados · 33%'), 'lectura numérica del avance');
    assert.ok(html.includes('wr-avance-fill'), 'barra de avance presente');
});

test('CA-7: panel de bloqueos con motivo + blocker textual y marca en el chip', () => {
    const html = view.renderRoadmapSsr({ roadmap: fixtureRoadmap() });
    assert.ok(html.includes('Bloqueos activos'), 'panel de bloqueos presente');
    assert.ok(html.includes('espera schema waves.json'), 'muestra el motivo del bloqueo');
    assert.ok(html.includes('#4350'), 'muestra el blocker');
    assert.ok(html.includes('wr-chip-is-blocked'), 'el chip del issue bloqueado se marca');
});

test('CA-8: ETA muestra p50/p75/p90 formateados cuando hay muestra', () => {
    const html = view.renderRoadmapSsr({ roadmap: fixtureRoadmap() });
    assert.ok(html.includes('ETA de ejecución'), 'panel ETA presente');
    assert.ok(html.includes('45m'), 'p50 formateado a minutos');
    assert.ok(html.includes('1h 30m'), 'p90 formateado a h/m');
    assert.ok(!html.includes('estimación con poca muestra'), 'sin aviso de poca muestra cuando hay samples');
});

test('CA-8: aviso "estimación con poca muestra" cuando ETA sin samples (lowSample)', () => {
    const rm = fixtureRoadmap();
    rm.eta = { ready: true, lowSample: true, p50: null, p75: null, p90: null, totalPct: null };
    const html = view.renderRoadmapSsr({ roadmap: rm });
    assert.ok(html.includes('estimación con poca muestra'), 'muestra el aviso honesto');
    assert.ok(!/>45m</.test(html), 'no muestra un número de ETA engañoso');
});

test('CA-8: aviso también cuando ETA no está lista (ready=false)', () => {
    const rm = fixtureRoadmap();
    rm.eta = { ready: false, lowSample: true };
    const html = view.renderRoadmapSsr({ roadmap: rm });
    assert.ok(html.includes('estimación con poca muestra'));
});

test('fmtEtaMinutes formatea minutos correctamente', () => {
    assert.equal(view.fmtEtaMinutes(45), '45m');
    assert.equal(view.fmtEtaMinutes(60), '1h');
    assert.equal(view.fmtEtaMinutes(90), '1h 30m');
    assert.equal(view.fmtEtaMinutes(0), '—');
    assert.equal(view.fmtEtaMinutes(-5), '—');
    assert.equal(view.fmtEtaMinutes('abc'), '—');
});

test('CA-S1: XSS — título de issue con <script> sale escapado, no crudo', () => {
    const rm = fixtureRoadmap();
    rm.activeWave.issues[0].title = '<script>alert(1)</script>';
    const html = view.renderRoadmapSsr({ roadmap: rm });
    assert.ok(!html.includes('<script>alert(1)</script>'), 'NO debe contener el tag crudo');
    assert.ok(html.includes('&lt;script&gt;'), 'debe contener el título escapado');
});

test('CA-S1: XSS — goal y motivo de bloqueo con <img onerror> salen escapados', () => {
    const rm = fixtureRoadmap();
    rm.activeWave.goal = '<img src=x onerror=alert(1)>';
    rm.blocked[0].reason = '<img src=x onerror=alert(2)>';
    rm.archivedWaves[0].name = '<b>evil</b>';
    const html = view.renderRoadmapSsr({ roadmap: rm });
    assert.ok(!html.includes('<img src=x onerror=alert(1)>'), 'goal crudo no aparece');
    assert.ok(!html.includes('<img src=x onerror=alert(2)>'), 'motivo crudo no aparece');
    assert.ok(!html.includes('<b>evil</b>'), 'nombre de archivada crudo no aparece');
    assert.ok(html.includes('&lt;img'), 'texto escapado presente');
});

test('degradación: sin opts.roadmap ni datos, render vacío sin throw', () => {
    const html = view.renderRoadmapSsr({ wavesState: { active_wave: null, planned_waves: [], archived_waves: [] } });
    assert.ok(html.includes('Sin ola activa'), 'empty-state de ola activa');
    assert.ok(html.includes('No hay olas planificadas'), 'sin planificadas');
    assert.ok(html.includes('No hay olas archivadas'), 'sin archivadas');
    // No debe haber avance/ETA/bloqueos en el modo degradado.
    assert.ok(!html.includes('estimación con poca muestra'), 'sin panel ETA en degradado');
    assert.ok(!html.includes('Bloqueos activos'), 'sin panel de bloqueos en degradado');
});

test('degradación: roadmap con activeWave null no rompe y muestra empty-state', () => {
    const html = view.renderRoadmapSsr({ roadmap: { activeWave: null, plannedWaves: [], archivedWaves: [], blocked: [], eta: { ready: false, lowSample: true }, avance: { closed: 0, total: 0, pct: 0 } } });
    assert.ok(html.includes('Sin ola activa'));
});

test('renderRoadmap documento completo incluye nav, sprite y fragmento', () => {
    const html = view.renderRoadmap({ roadmap: fixtureRoadmap() });
    assert.ok(html.startsWith('<!DOCTYPE html>'), 'documento SSR completo');
    assert.ok(html.includes('data-slug="roadmap"'), 'fragmento con slug roadmap');
    assert.ok(html.includes('Ola 8.3'), 'incluye datos enriquecidos');
});

'use strict';

// =============================================================================
// #4362 — Tests del helper `progress-state.js`: derivación del estado de avance
// de un issue sin marcador de fase activo (entre fases), y las señales que la
// alimentan (fase terminal del flujo, actividad reciente).
// node --test .pipeline/lib/__tests__/progress-state.test.js
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const prog = require('../progress-state');

const FLOW = [
    { pipeline: 'definicion', fase: 'analisis' },
    { pipeline: 'definicion', fase: 'criterios' },
    { pipeline: 'desarrollo', fase: 'dev' },
    { pipeline: 'desarrollo', fase: 'build' },
    { pipeline: 'desarrollo', fase: 'entrega' },   // ← terminal del flujo
];

test('terminalFaseKeySet = última fase del último pipeline (no las intermedias)', () => {
    const set = prog.terminalFaseKeySet(FLOW);
    assert.ok(set.has('desarrollo/entrega'));
    // NO debe tratar la terminal de un pipeline intermedio como terminal del flujo.
    assert.ok(!set.has('definicion/criterios'));
    assert.equal(set.size, 1);
});

test('terminalFaseKeySet degrada a set vacío con allFases inválido/vacío', () => {
    assert.equal(prog.terminalFaseKeySet([]).size, 0);
    assert.equal(prog.terminalFaseKeySet(null).size, 0);
    assert.equal(prog.terminalFaseKeySet(undefined).size, 0);
});

test('deriveProgressState: estadoActual presente → activo (no aplica el derivado)', () => {
    const out = prog.deriveProgressState(
        { estadoActual: 'trabajando', fases: {} },
        { terminalFaseKeys: prog.terminalFaseKeySet(FLOW), recentActivity: false },
    );
    assert.equal(out, 'activo');
});

test('deriveProgressState: procesado intermedio + actividad reciente → entre-fases', () => {
    const out = prog.deriveProgressState(
        { fases: { 'desarrollo/dev': [{ estado: 'procesado' }] } },
        { terminalFaseKeys: prog.terminalFaseKeySet(FLOW), recentActivity: true },
    );
    assert.equal(out, 'entre-fases');
});

test('deriveProgressState (CA-3): procesado intermedio SIN actividad reciente → sin-arrancar', () => {
    const out = prog.deriveProgressState(
        { fases: { 'desarrollo/dev': [{ estado: 'procesado' }] } },
        { terminalFaseKeys: prog.terminalFaseKeySet(FLOW), recentActivity: false },
    );
    assert.equal(out, 'sin-arrancar');
});

test('deriveProgressState: procesado en fase terminal → terminado (aunque haya actividad)', () => {
    const out = prog.deriveProgressState(
        { fases: { 'desarrollo/entrega': [{ estado: 'procesado' }] } },
        { terminalFaseKeys: prog.terminalFaseKeySet(FLOW), recentActivity: true },
    );
    assert.equal(out, 'terminado');
});

test('deriveProgressState: closed en GitHub → terminado', () => {
    const out = prog.deriveProgressState(
        { state: 'CLOSED', fases: { 'desarrollo/dev': [{ estado: 'procesado' }] } },
        { terminalFaseKeys: prog.terminalFaseKeySet(FLOW), recentActivity: true },
    );
    assert.equal(out, 'terminado');
});

test('deriveProgressState: sin fases procesadas → sin-arrancar', () => {
    const out = prog.deriveProgressState(
        { fases: {} },
        { terminalFaseKeys: prog.terminalFaseKeySet(FLOW), recentActivity: true },
    );
    assert.equal(out, 'sin-arrancar');
});

// CA-5 — un issue "entre-fases" NO es terminado (queda fuera de doneIssueIds,
// que sólo empuja los `progressState === 'terminado'`).
test('CA-5: entre-fases NO clasifica como terminado (excluido de done)', () => {
    const terminalFaseKeys = prog.terminalFaseKeySet(FLOW);
    const matrix = {
        '10': { fases: { 'desarrollo/dev': [{ estado: 'procesado' }] } },       // entre-fases (con actividad)
        '11': { fases: { 'desarrollo/entrega': [{ estado: 'procesado' }] } },   // terminado
        '12': { fases: {} },                                                     // sin-arrancar
    };
    const recent = new Set(['10']);
    const done = [];
    for (const [id, data] of Object.entries(matrix)) {
        const ps = prog.deriveProgressState(data, { terminalFaseKeys, recentActivity: recent.has(id) });
        if (ps === 'terminado') done.push(Number(id));
    }
    assert.deepEqual(done, [11], 'sólo el terminado entra en done; entre-fases y sin-arrancar quedan fuera');
});

// ------------------------------------------------------------------------------
// readRecentActivityIssues — lectura del activity-log y ventana temporal.
// ------------------------------------------------------------------------------
function tempRepo(lines) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prog-log-'));
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'activity-log.jsonl'), lines.join('\n') + '\n');
    return dir;
}

test('readRecentActivityIssues: incluye issue con session:* dentro de ventana, excluye fuera', () => {
    const now = Date.now();
    const dir = tempRepo([
        JSON.stringify({ event: 'session:start', issue: 100, ts: new Date(now - 5 * 60000).toISOString() }),
        JSON.stringify({ event: 'session:end', issue: 200, ts: new Date(now - 90 * 60000).toISOString() }),
        JSON.stringify({ event: 'tts:generated', issue: 300, ts: new Date(now).toISOString() }),   // no session → ignorar
    ]);
    const set = prog.readRecentActivityIssues(dir, { now, windowMin: 30 });
    assert.ok(set.has('100'), 'dentro de ventana');
    assert.ok(!set.has('200'), 'fuera de ventana');
    assert.ok(!set.has('300'), 'evento no-session ignorado');
});

test('readRecentActivityIssues: archivo ausente → set vacío (no lanza)', () => {
    const set = prog.readRecentActivityIssues(path.join(os.tmpdir(), 'no-existe-repo-xyz'), { now: Date.now() });
    assert.equal(set.size, 0);
});

test('readRecentActivityIssues (CA-6): descarta issue id no numérico / líneas malformadas', () => {
    const now = Date.now();
    const dir = tempRepo([
        JSON.stringify({ event: 'session:start', issue: '../etc', ts: new Date(now).toISOString() }),
        '{ json roto',
        JSON.stringify({ event: 'session:start', issue: 42, ts: new Date(now).toISOString() }),
    ]);
    const set = prog.readRecentActivityIssues(dir, { now, windowMin: 30 });
    assert.ok(set.has('42'));
    assert.ok(!set.has('../etc'));
    assert.equal(set.size, 1);
});

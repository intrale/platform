// =============================================================================
// planner-waves.test.js — Tests de la lógica de composición multi-ola del
// skill `/planner` (#3488 H2 Spike #3378).
//
// Cubre:
//   - CA funcionales del issue (composición carry-over + Ready + needs-def,
//     orden por prioridad, capacidad, ola vacía).
//   - CA de UX (render olas vacío, escape de títulos con caracteres especiales,
//     truncado, paginación 0/100 olas).
//   - 7 requisitos de seguridad del análisis security:
//     SEC-1 parseo seguro de num/horizon (injection, path traversal, fuera de rango).
//     SEC-2 escape markdown en títulos (link injection, control chars, zero-width).
//     SEC-3 JSON via JSON.stringify (no concatenación).
//     SEC-7 assertWaveState (schema corrupto, shape inesperado).
//
// Ejecutar:  node --test .pipeline/lib/__tests__/planner-waves.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const pw = require('../planner-waves');

// ─── SEC-1: parseo seguro ──────────────────────────────────────────────────

test('parseWaveNum acepta entero positivo en rango', () => {
    assert.equal(pw.parseWaveNum('5'), 5);
    assert.equal(pw.parseWaveNum(7), 7);
    assert.equal(pw.parseWaveNum('#42'), 42);
    assert.equal(pw.parseWaveNum('  3 '), 3);
    assert.equal(pw.parseWaveNum(1), 1);
    assert.equal(pw.parseWaveNum(9999), 9999);
});

test('parseWaveNum rechaza command injection', () => {
    assert.throws(() => pw.parseWaveNum('5; rm -rf /'), /solo enteros/);
    assert.throws(() => pw.parseWaveNum('5 && echo hi'), /solo enteros/);
    assert.throws(() => pw.parseWaveNum('5|cat'), /solo enteros/);
    assert.throws(() => pw.parseWaveNum('`whoami`'), /solo enteros/);
});

test('parseWaveNum rechaza path traversal', () => {
    assert.throws(() => pw.parseWaveNum('../../etc/passwd'), /solo enteros/);
    assert.throws(() => pw.parseWaveNum('./5'), /solo enteros/);
});

test('parseWaveNum rechaza floats y notación científica', () => {
    assert.throws(() => pw.parseWaveNum('5.0'), /solo enteros/);
    assert.throws(() => pw.parseWaveNum('5e2'), /solo enteros/);
    assert.throws(() => pw.parseWaveNum('0x10'), /solo enteros/);
});

test('parseWaveNum rechaza valores fuera de rango', () => {
    assert.throws(() => pw.parseWaveNum('0'), /fuera de rango/);
    assert.throws(() => pw.parseWaveNum('10000'), /fuera de rango/);
    assert.throws(() => pw.parseWaveNum('9999999999'), /fuera de rango/);
});

test('parseWaveNum rechaza negativos (sin tilde)', () => {
    // "-1" no matchea /^\d+$/ → solo enteros (no rango)
    assert.throws(() => pw.parseWaveNum('-1'), /solo enteros/);
});

test('parseWaveNum rechaza null/undefined/objetos', () => {
    assert.throws(() => pw.parseWaveNum(null), /requerido/);
    assert.throws(() => pw.parseWaveNum(undefined), /requerido/);
    assert.throws(() => pw.parseWaveNum({}), /tipo inválido/);
    assert.throws(() => pw.parseWaveNum([5]), /tipo inválido/);
});

test('parseHorizon acepta valores válidos', () => {
    assert.equal(pw.parseHorizon('3'), 3);
    assert.equal(pw.parseHorizon(1), 1);
    assert.equal(pw.parseHorizon(12), 12);
});

test('parseHorizon rechaza fuera de rango y formato', () => {
    assert.throws(() => pw.parseHorizon('0'), /fuera de rango/);
    assert.throws(() => pw.parseHorizon('13'), /fuera de rango/);
    assert.throws(() => pw.parseHorizon('100'), /fuera de rango/);
    assert.throws(() => pw.parseHorizon('abc'), /solo enteros/);
});

// ─── SEC-2: escape markdown ────────────────────────────────────────────────

test('escapeMd neutraliza link injection', () => {
    const titulo = '[click](javascript:alert(1))';
    const out = pw.escapeMd(titulo);
    assert.ok(out.includes('\\['), 'debe escapar [');
    assert.ok(out.includes('\\]'), 'debe escapar ]');
    assert.ok(out.includes('\\('), 'debe escapar (');
    assert.ok(out.includes('\\)'), 'debe escapar )');
    // El string resultado NO debe ser parseable como link markdown.
    assert.equal(out.match(/(?<!\\)\[.+?\]\(.+?\)/), null);
});

test('escapeMd neutraliza bold/italic injection', () => {
    const out = pw.escapeMd('**bold** _italic_ ~strike~');
    assert.ok(out.includes('\\*\\*bold\\*\\*'));
    assert.ok(out.includes('\\_italic\\_'));
    assert.ok(out.includes('\\~strike\\~'));
});

test('escapeMd neutraliza HTML/MDX (< >)', () => {
    const out = pw.escapeMd('<script>alert(1)</script>');
    assert.ok(out.includes('\\<script\\>'));
    assert.ok(!out.includes('<script>'), 'no debe quedar HTML crudo');
});

test('escapeMd colapsa newlines y tabs internos', () => {
    const out = pw.escapeMd('linea1\n\n# Inyección\nlinea3');
    assert.ok(!out.includes('\n'), 'sin newlines');
    assert.ok(out.includes('linea1'));
    assert.ok(out.includes('linea3'));
    // El "#" debe quedar escapado para no romper headers
    assert.ok(out.includes('\\#'));
});

test('escapeMd strip de zero-width chars (puede ocultar texto)', () => {
    const out = pw.escapeMd('vis​ib‌le');
    assert.equal(out, 'visible');
});

test('escapeMd strip de control chars', () => {
    const out = pw.escapeMd('a\x01b\x1Fc\x7Fd');
    assert.equal(out, 'abcd');
});

test('escapeMd maneja null/undefined sin crashear', () => {
    assert.equal(pw.escapeMd(null), '');
    assert.equal(pw.escapeMd(undefined), '');
    assert.equal(pw.escapeMd(123), '123');
});

test('truncateTitle agrega ellipsis cuando excede', () => {
    const t = 'a'.repeat(50);
    const out = pw.truncateTitle(t, 40);
    assert.equal(out.length, 40);
    assert.ok(out.endsWith('…'));
});

test('truncateTitle no toca strings cortos', () => {
    assert.equal(pw.truncateTitle('hola', 40), 'hola');
});

// ─── SEC-7: schema validation ──────────────────────────────────────────────

test('assertWaveState acepta esqueleto vacío', () => {
    assert.doesNotThrow(() => pw.assertWaveState({
        version: '1.0',
        active_wave: null,
        planned_waves: [],
        archived_waves: [],
    }));
});

test('assertWaveState rechaza no-objetos', () => {
    assert.throws(() => pw.assertWaveState(null), /not an object/);
    assert.throws(() => pw.assertWaveState('string'), /not an object/);
    assert.throws(() => pw.assertWaveState(42), /not an object/);
});

test('assertWaveState rechaza planned_waves no-array', () => {
    assert.throws(() => pw.assertWaveState({
        active_wave: null, planned_waves: 'not-array', archived_waves: [],
    }), /planned_waves/);
});

test('assertWaveState rechaza active_wave shape inválido', () => {
    assert.throws(() => pw.assertWaveState({
        active_wave: 42, planned_waves: [], archived_waves: [],
    }), /active_wave/);
});

// ─── Composición ────────────────────────────────────────────────────────────

function makeIssue(number, label = 'priority:medium', size = 'size:medium', extraLabels = []) {
    return {
        number,
        title: `Issue ${number}`,
        labels: [{ name: label }, { name: size }, ...extraLabels.map((n) => ({ name: n }))],
    };
}

function emptyState() {
    return {
        version: '1.0',
        active_wave: null,
        planned_waves: [],
        archived_waves: [],
        dependencies: [],
    };
}

test('composeWave: ola vacía sin issues disponibles → warning EMPTY_WAVE', () => {
    const res = pw.composeWave({
        waveNumber: 10,
        previousWave: null,
        readyIssues: [],
        needsDefIssues: [],
        wavesState: emptyState(),
        capacity: 9,
    });
    assert.equal(res.issues.length, 0);
    assert.ok(res.warnings.some((w) => w.code === 'EMPTY_WAVE'));
});

test('composeWave: solo Ready, ordena por prioridad y respeta capacidad', () => {
    const ready = [
        makeIssue(101, 'priority:low'),
        makeIssue(102, 'priority:high'),
        makeIssue(103, 'priority:medium'),
        makeIssue(104, 'priority:high'),
    ];
    const res = pw.composeWave({
        waveNumber: 1,
        previousWave: null,
        readyIssues: ready,
        needsDefIssues: [],
        wavesState: emptyState(),
        capacity: 3,
    });
    assert.equal(res.issues.length, 3);
    // Orden: high (102), high (104, desempate por número), medium (103). Low queda afuera.
    assert.deepEqual(res.issues.map((i) => i.number), [102, 104, 103]);
    assert.equal(res.backlog_remaining.ready, 1); // 101 (low) afuera
});

test('composeWave: carry-over va primero, antes que Ready aunque Ready sea high', () => {
    const previousWave = {
        number: 0,
        issues: [
            { number: 50, status: 'in_progress' },
            { number: 51, status: 'completed' }, // no entra a carry-over
        ],
    };
    const ready = [makeIssue(60, 'priority:high')];
    const res = pw.composeWave({
        waveNumber: 1,
        previousWave,
        readyIssues: ready,
        needsDefIssues: [],
        wavesState: emptyState(),
        openIssueNumbers: new Set([50, 60]),
        capacity: 9,
    });
    assert.equal(res.issues.length, 2);
    assert.equal(res.issues[0].number, 50);
    assert.equal(res.issues[0].source, 'carry_over');
    assert.equal(res.issues[1].number, 60);
    assert.equal(res.issues[1].source, 'ready');
});

test('composeWave: orden estricto carry-over → Ready → needs-definition', () => {
    const previousWave = { number: 0, issues: [{ number: 10, status: 'in_progress' }] };
    const ready = [makeIssue(20, 'priority:low')];
    const needsDef = [makeIssue(30, 'priority:high')];
    const res = pw.composeWave({
        waveNumber: 1,
        previousWave,
        readyIssues: ready,
        needsDefIssues: needsDef,
        wavesState: emptyState(),
        openIssueNumbers: new Set([10, 20, 30]),
        capacity: 9,
    });
    assert.deepEqual(res.issues.map((i) => i.source), ['carry_over', 'ready', 'needs_definition']);
});

test('composeWave: alerta CARRY_OVER_DOMINANT cuando >50%', () => {
    const previousWave = {
        number: 0,
        issues: [
            { number: 1, status: 'in_progress' },
            { number: 2, status: 'in_progress' },
            { number: 3, status: 'in_progress' },
            { number: 4, status: 'in_progress' },
            { number: 5, status: 'in_progress' },
            { number: 6, status: 'in_progress' },
        ],
    };
    const res = pw.composeWave({
        waveNumber: 2,
        previousWave,
        readyIssues: [],
        needsDefIssues: [],
        wavesState: emptyState(),
        openIssueNumbers: new Set([1, 2, 3, 4, 5, 6]),
        capacity: 9,
    });
    assert.ok(res.warnings.some((w) => w.code === 'CARRY_OVER_DOMINANT'));
});

test('composeWave: filtra carry-over de issues ya cerrados (no en openIssueNumbers)', () => {
    const previousWave = {
        number: 0,
        issues: [
            { number: 10, status: 'in_progress' }, // cerrado en GH, no entra
            { number: 11, status: 'in_progress' }, // sigue open
        ],
    };
    const res = pw.composeWave({
        waveNumber: 1,
        previousWave,
        readyIssues: [],
        needsDefIssues: [],
        wavesState: emptyState(),
        openIssueNumbers: new Set([11]),
        capacity: 9,
    });
    assert.equal(res.issues.length, 1);
    assert.equal(res.issues[0].number, 11);
});

test('composeWave: NO duplica issues ya en otra ola', () => {
    const state = emptyState();
    state.planned_waves = [
        { number: 2, issues: [{ number: 99 }] },
    ];
    const ready = [makeIssue(99, 'priority:high'), makeIssue(100, 'priority:medium')];
    const res = pw.composeWave({
        waveNumber: 3,
        previousWave: null,
        readyIssues: ready,
        needsDefIssues: [],
        wavesState: state,
        capacity: 9,
    });
    // #99 está en ola 2 → no entra; #100 sí.
    assert.deepEqual(res.issues.map((i) => i.number), [100]);
});

test('composeWave: needs-def por prioridad high > medium > low + desempate por número', () => {
    const needsDef = [
        makeIssue(500, 'priority:medium'),
        makeIssue(501, 'priority:high'),
        makeIssue(502, 'priority:low'),
        makeIssue(503, 'priority:high'),
        makeIssue(504, 'priority:high'),
    ];
    const res = pw.composeWave({
        waveNumber: 1,
        previousWave: null,
        readyIssues: [],
        needsDefIssues: needsDef,
        wavesState: emptyState(),
        capacity: 9,
    });
    assert.deepEqual(res.issues.map((i) => i.number), [501, 503, 504, 500, 502]);
});

test('composeWave: rechaza inputs corruptos', () => {
    assert.throws(() => pw.composeWave({ waveNumber: 'abc' }), /waveNumber/);
    assert.throws(() => pw.composeWave({ waveNumber: 1, wavesState: null }), /wavesState/);
    assert.throws(() => pw.composeWave({ waveNumber: 1, wavesState: emptyState(), capacity: -1 }), /capacity/);
});

// ─── composeHorizon ────────────────────────────────────────────────────────

test('composeHorizon: consume issues entre olas sin duplicar', () => {
    const ready = [
        makeIssue(1, 'priority:high'),
        makeIssue(2, 'priority:high'),
        makeIssue(3, 'priority:medium'),
        makeIssue(4, 'priority:low'),
    ];
    const horizon = pw.composeHorizon({
        startWaveNumber: 5,
        horizon: 2,
        wavesState: emptyState(),
        readyIssues: ready,
        needsDefIssues: [],
        capacity: 2,
    });
    assert.equal(horizon.length, 2);
    // Ola 5: 2 issues (cap=2) → high #1, #2
    assert.deepEqual(horizon[0].issues.map((i) => i.number), [1, 2]);
    // Ola 6: los siguientes 2 — pero entran como carry-over virtual (de la "previa")
    // En la simulación, los issues consumidos no aparecen otra vez en ready.
    const issueNumsOla6 = horizon[1].issues.map((i) => i.number);
    assert.ok(!issueNumsOla6.includes(1) && !issueNumsOla6.includes(2), 'no duplica issues consumidos');
});

// ─── Render ────────────────────────────────────────────────────────────────

test('renderOlasList: 0 olas → mensaje claro de bootstrap', () => {
    const md = pw.renderOlasList([]);
    assert.match(md, /⚠️ No hay olas registradas/);
    assert.match(md, /componer-ola 1/);
});

test('renderOlasList: orden activa → planned (asc) → archived (desc)', () => {
    const list = [
        { number: 3, status: 'planned', issues: [] },
        { number: 1, status: 'archived', issues_completed: 5 },
        { number: 5, status: 'active', issues: [] },
        { number: 4, status: 'planned', issues: [] },
        { number: 2, status: 'archived', issues_completed: 3 },
    ];
    const md = pw.renderOlasList(list, '2026-05-24T00:00:00Z');
    const order = ['| 5 ', '| 3 ', '| 4 ', '| 2 ', '| 1 '];
    let prev = -1;
    for (const marker of order) {
        const idx = md.indexOf(marker);
        assert.notEqual(idx, -1, `${marker} debe aparecer en el output`);
        assert.ok(idx > prev, `${marker} debe ir después del anterior`);
        prev = idx;
    }
});

test('renderOlasList: render con 100 olas no crashea (paginación trivial = todas)', () => {
    const list = Array.from({ length: 100 }, (_, i) => ({
        number: i + 1, status: 'archived', issues_completed: 5, issues_failed: 0,
        closed_at: '2026-01-01',
    }));
    const md = pw.renderOlasList(list);
    assert.ok(md.length > 0);
    assert.match(md, /\| 100 \|/);
    assert.match(md, /100 cerrada/);
});

test('renderOlasList: título con caracteres especiales NO rompe markdown', () => {
    const list = [{
        number: 1, status: 'active',
        goal: '**bold** [link](evil) `code` <script>',
        issues: [],
    }];
    const md = pw.renderOlasList(list);
    // No debe quedar bold/link/code raw.
    assert.ok(!md.match(/(?<!\\)\[link\]\(evil\)/));
    assert.ok(md.includes('\\*'));
});

test('renderComposeWave: bloque JSON es parseable (SEC-3)', () => {
    const result = pw.composeWave({
        waveNumber: 2,
        previousWave: null,
        readyIssues: [makeIssue(1, 'priority:high')],
        needsDefIssues: [],
        wavesState: emptyState(),
        capacity: 9,
    });
    const md = pw.renderComposeWave(result);
    const m = md.match(/```json\n([\s\S]+?)\n```/);
    assert.ok(m, 'debe tener bloque json');
    const parsed = JSON.parse(m[1]);
    assert.equal(parsed.wave, 2);
    assert.equal(parsed.issues.length, 1);
    assert.equal(parsed.issues[0].number, 1);
});

test('renderComposeWave: títulos con comillas/backslash NO rompen el JSON', () => {
    const ready = [{
        number: 1,
        title: 'Bug "weird" with \\backslash and "double quotes"',
        labels: [{ name: 'priority:high' }, { name: 'size:medium' }],
    }];
    const result = pw.composeWave({
        waveNumber: 1, previousWave: null, readyIssues: ready, needsDefIssues: [],
        wavesState: emptyState(), capacity: 9,
    });
    const md = pw.renderComposeWave(result);
    const m = md.match(/```json\n([\s\S]+?)\n```/);
    assert.ok(m);
    // JSON debe parsear sin throw aun con esos caracteres en el title.
    // (Aunque title no va en el payload JSON, validamos la robustez igual).
    assert.doesNotThrow(() => JSON.parse(m[1]));
});

test('renderEmptyBacklog: mensaje con sugerencias', () => {
    const md = pw.renderEmptyBacklog(5, { ready: 0, needs_definition: 0 });
    assert.match(md, /⛔ No hay issues disponibles/);
    assert.match(md, /Backlog actual: 0 Ready · 0 needs-definition/);
    assert.match(md, /\/doc nueva/);
});

test('renderAlreadyComposed: mensaje idempotente con sugerencia --force', () => {
    const md = pw.renderAlreadyComposed({ number: 3, status: 'planned', issues: [{}, {}, {}] });
    assert.match(md, /Ola 3 ya está compuesta/);
    assert.match(md, /3 issues/);
    assert.match(md, /componer-ola 3 --force/);
});

// ─── Clasificación ─────────────────────────────────────────────────────────

test('priorityLabel y priorityRank son consistentes', () => {
    const high = [{ name: 'priority:high' }];
    const med = [{ name: 'priority:medium' }];
    const low = [{ name: 'priority:low' }];
    const none = [{ name: 'enhancement' }];
    assert.equal(pw.priorityLabel(high), 'high');
    assert.equal(pw.priorityLabel(med), 'medium');
    assert.equal(pw.priorityLabel(low), 'low');
    assert.equal(pw.priorityLabel(none), 'medium'); // default
    assert.ok(pw.priorityRank(high) < pw.priorityRank(med));
    assert.ok(pw.priorityRank(med) < pw.priorityRank(low));
});

test('sizeLetter mapea labels correctamente', () => {
    assert.equal(pw.sizeLetter([{ name: 'size:small' }]), 'S');
    assert.equal(pw.sizeLetter([{ name: 'size:medium' }]), 'M');
    assert.equal(pw.sizeLetter([{ name: 'size:large' }]), 'L');
    assert.equal(pw.sizeLetter([{ name: 'size:xl' }]), 'XL');
    assert.equal(pw.sizeLetter([]), '?');
});

test('streamFromLabels: pipeline → E, backend → A, client → B', () => {
    assert.equal(pw.streamFromLabels([{ name: 'area:backend' }]), 'A');
    assert.equal(pw.streamFromLabels([{ name: 'app:client' }]), 'B');
    assert.equal(pw.streamFromLabels([{ name: 'app:business' }]), 'C');
    assert.equal(pw.streamFromLabels([{ name: 'app:delivery' }]), 'D');
    assert.equal(pw.streamFromLabels([{ name: 'area:pipeline' }]), 'E');
    assert.equal(pw.streamFromLabels([{ name: 'random' }]), '?');
});

test('labelNames acepta strings o {name}', () => {
    assert.deepEqual(pw.labelNames(['a', 'b']), ['a', 'b']);
    assert.deepEqual(pw.labelNames([{ name: 'a' }, { name: 'b' }]), ['a', 'b']);
    assert.deepEqual(pw.labelNames([{ name: 'a' }, 'b', null, {}]), ['a', 'b']);
    assert.deepEqual(pw.labelNames(null), []);
});

test('isInAnyWave: detecta presencia en activa o planeada', () => {
    const state = {
        active_wave: { number: 1, issues: [{ number: 100 }] },
        planned_waves: [{ number: 2, issues: [{ number: 200 }] }],
        archived_waves: [],
    };
    assert.equal(pw.isInAnyWave(100, state), true);
    assert.equal(pw.isInAnyWave(200, state), true);
    assert.equal(pw.isInAnyWave(999, state), false);
});

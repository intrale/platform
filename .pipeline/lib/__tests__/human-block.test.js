// Tests de .pipeline/lib/human-block.js (issue #2478)
// Valida marker en disco, schema de eventos human:blocked/unblocked y comandos.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Aislar PIPELINE_DIR a un tmp por test setup
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-humanblock-'));
fs.mkdirSync(path.join(TMP_DIR, '.claude'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.pipeline', 'desarrollo', 'dev', 'trabajando'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.pipeline', 'desarrollo', 'dev', 'pendiente'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.pipeline', 'desarrollo', 'verificacion', 'trabajando'), { recursive: true });
process.env.CLAUDE_PROJECT_DIR = TMP_DIR;
process.env.PIPELINE_REPO_ROOT = TMP_DIR;

delete require.cache[require.resolve('../traceability')];
delete require.cache[require.resolve('../human-block')];
const trace = require('../traceability');
const hb = require('../human-block');

function readEvents() {
    if (!fs.existsSync(trace.LOG_FILE)) return [];
    return fs.readFileSync(trace.LOG_FILE, 'utf8')
        .split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function resetFs() {
    // limpiar todos los markers
    for (const phase of ['dev', 'verificacion']) {
        for (const state of ['pendiente', 'trabajando', 'listo', 'bloqueado-humano']) {
            const dir = path.join(TMP_DIR, '.pipeline', 'desarrollo', phase, state);
            try {
                for (const f of fs.readdirSync(dir)) {
                    try { fs.unlinkSync(path.join(dir, f)); } catch {}
                }
            } catch {}
        }
    }
    try { fs.unlinkSync(trace.LOG_FILE); } catch {}
}

test('reportHumanBlock crea marker en bloqueado-humano/ y emite evento', () => {
    resetFs();
    const src = path.join(TMP_DIR, '.pipeline', 'desarrollo', 'dev', 'trabajando', '2478.po');
    fs.writeFileSync(src, 'issue: 2478\n');

    const result = hb.reportHumanBlock({
        issue: 2478, skill: 'po', phase: 'dev',
        reason: 'Criterio contradictorio entre AC#2 y AC#5',
        question: '¿Cuál tiene prioridad si chocan?',
    });

    assert.equal(result.issue, 2478);
    assert.equal(result.skill, 'po');
    assert.equal(result.phase, 'dev');
    assert.equal(result.pipeline, 'desarrollo');
    assert.equal(fs.existsSync(src), false, 'src debe haberse movido');
    assert.equal(fs.existsSync(result.marker_path), true);
    assert.match(result.marker_path, /bloqueado-humano[\\/]2478\.po$/);

    const reasonFile = result.marker_path + '.reason.json';
    assert.equal(fs.existsSync(reasonFile), true);
    const reason = JSON.parse(fs.readFileSync(reasonFile, 'utf8'));
    assert.equal(reason.reason, 'Criterio contradictorio entre AC#2 y AC#5');
    assert.equal(reason.question, '¿Cuál tiene prioridad si chocan?');

    const events = readEvents();
    const blocked = events.find(e => e.event === 'human:blocked' && e.issue === 2478);
    assert.ok(blocked, 'evento human:blocked emitido');
    assert.equal(blocked.skill, 'po');
    assert.equal(blocked.phase, 'dev');
    assert.equal(blocked.pipeline, 'desarrollo');
    assert.equal(blocked.reason, 'Criterio contradictorio entre AC#2 y AC#5');
});

test('reportHumanBlock requiere reason y question', () => {
    resetFs();
    assert.throws(() => hb.reportHumanBlock({ issue: 1, skill: 'po', phase: 'dev', reason: '', question: 'x' }),
        /reason y question/);
    assert.throws(() => hb.reportHumanBlock({ issue: 1, skill: 'po', phase: 'dev', reason: 'x', question: '' }),
        /reason y question/);
});

test('reportHumanBlock requiere issue, skill, phase', () => {
    resetFs();
    assert.throws(() => hb.reportHumanBlock({ skill: 'po', phase: 'dev', reason: 'x', question: 'y' }),
        /issue, skill, phase/);
});

test('reportHumanBlock funciona aunque no exista marker activo', () => {
    resetFs();
    const result = hb.reportHumanBlock({
        issue: 9999, skill: 'qa', phase: 'verificacion',
        reason: 'Falta credencial AWS', question: '¿Quién regenera el token?',
        pipeline: 'desarrollo',
    });
    assert.equal(fs.existsSync(result.marker_path), true);
});

test('listBlockedIssues retorna todos los markers con metadata', () => {
    resetFs();
    hb.reportHumanBlock({
        issue: 1001, skill: 'po', phase: 'dev', pipeline: 'desarrollo',
        reason: 'r1', question: 'q1',
    });
    hb.reportHumanBlock({
        issue: 1002, skill: 'qa', phase: 'verificacion', pipeline: 'desarrollo',
        reason: 'r2', question: 'q2',
    });

    const list = hb.listBlockedIssues();
    assert.equal(list.length, 2);
    const issues = list.map(i => i.issue).sort();
    assert.deepEqual(issues, [1001, 1002]);
    const item = list.find(i => i.issue === 1001);
    assert.equal(item.skill, 'po');
    assert.equal(item.phase, 'dev');
    assert.equal(item.reason, 'r1');
    assert.equal(item.question, 'q1');
    assert.ok(typeof item.age_hours === 'number');
});

test('unblockIssue mueve marker a pendiente/ del target_phase y emite evento', () => {
    resetFs();
    hb.reportHumanBlock({
        issue: 2222, skill: 'po', phase: 'dev', pipeline: 'desarrollo',
        reason: 'r', question: 'q',
    });

    const res = hb.unblockIssue({
        issue: 2222, guidance: 'Aplicá AC#5 que es más reciente', unlocker: 'leo',
    });

    assert.equal(res.ok, true);
    assert.equal(res.issue, 2222);
    assert.equal(res.skill, 'po');
    assert.equal(res.from_phase, 'dev');
    assert.equal(res.to_phase, 'dev');
    assert.match(res.marker_path, /pendiente[\\/]2222\.po$/);
    assert.equal(fs.existsSync(res.marker_path), true);

    const guidanceFile = res.marker_path + '.guidance.txt';
    assert.equal(fs.existsSync(guidanceFile), true);
    assert.equal(fs.readFileSync(guidanceFile, 'utf8'), 'Aplicá AC#5 que es más reciente');

    // marker de bloqueado debe haber desaparecido
    const list = hb.listBlockedIssues();
    assert.equal(list.find(i => i.issue === 2222), undefined);

    const events = readEvents();
    const unblocked = events.find(e => e.event === 'human:unblocked' && e.issue === 2222);
    assert.ok(unblocked);
    assert.equal(unblocked.guidance, 'Aplicá AC#5 que es más reciente');
    assert.equal(unblocked.unlocker, 'leo');
    assert.equal(unblocked.target_phase, 'dev');
});

test('unblockIssue puede redirigir a otra fase con target_phase', () => {
    resetFs();
    hb.reportHumanBlock({
        issue: 3333, skill: 'qa', phase: 'verificacion', pipeline: 'desarrollo',
        reason: 'r', question: 'q',
    });

    const res = hb.unblockIssue({
        issue: 3333, guidance: 'Volver a dev por refactor', target_phase: 'dev',
    });

    assert.equal(res.ok, true);
    assert.equal(res.from_phase, 'verificacion');
    assert.equal(res.to_phase, 'dev');
    assert.match(res.marker_path, /desarrollo[\\/]dev[\\/]pendiente[\\/]3333\.qa$/);
});

test('unblockIssue retorna error si issue no está bloqueado', () => {
    resetFs();
    const res = hb.unblockIssue({ issue: 4444, guidance: 'x' });
    assert.equal(res.ok, false);
    assert.match(res.error, /no está en bloqueado-humano/);
});

test('findBlockedMarker localiza marker existente', () => {
    resetFs();
    hb.reportHumanBlock({
        issue: 5555, skill: 'tester', phase: 'dev', pipeline: 'desarrollo',
        reason: 'r', question: 'q',
    });
    const found = hb.findBlockedMarker(5555);
    assert.ok(found);
    assert.equal(found.skill, 'tester');
    assert.equal(found.phase, 'dev');
    assert.equal(found.pipeline, 'desarrollo');
});

test('listBlockedIssues ignora archivos .reason.json y .gitkeep', () => {
    resetFs();
    const dir = path.join(TMP_DIR, '.pipeline', 'desarrollo', 'dev', 'bloqueado-humano');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.gitkeep'), '');
    hb.reportHumanBlock({
        issue: 6666, skill: 'po', phase: 'dev', pipeline: 'desarrollo',
        reason: 'r', question: 'q',
    });
    const list = hb.listBlockedIssues();
    assert.equal(list.filter(i => i.issue === 6666).length, 1);
    assert.equal(list.find(i => String(i.issue) === '.gitkeep'), undefined);
});

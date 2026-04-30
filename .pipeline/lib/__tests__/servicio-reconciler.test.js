// Tests de .pipeline/servicio-reconciler.js (issue #2880)
// Valida las 3 reglas de reconciliación + heurística de fase para placeholders.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-reconciler-'));
fs.mkdirSync(path.join(TMP_DIR, '.claude'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.pipeline', 'desarrollo', 'dev', 'pendiente'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.pipeline', 'desarrollo', 'validacion', 'bloqueado-humano'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.pipeline', 'definicion', 'analisis', 'bloqueado-humano'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.pipeline', 'servicios', 'github', 'pendiente'), { recursive: true });

process.env.CLAUDE_PROJECT_DIR = TMP_DIR;
process.env.PIPELINE_REPO_ROOT = TMP_DIR;
process.env.PIPELINE_STATE_DIR = path.join(TMP_DIR, '.pipeline');
process.env.PIPELINE_MAIN_ROOT = TMP_DIR;

delete require.cache[require.resolve('../traceability')];
delete require.cache[require.resolve('../human-block')];
delete require.cache[require.resolve('../../servicio-reconciler')];

const humanBlock = require('../human-block');
const reconciler = require('../../servicio-reconciler');

const PIPELINE = path.join(TMP_DIR, '.pipeline');
const GH_QUEUE = path.join(PIPELINE, 'servicios', 'github', 'pendiente');

function clearGhQueue() {
    for (const f of fs.readdirSync(GH_QUEUE)) {
        if (f.endsWith('.json')) try { fs.unlinkSync(path.join(GH_QUEUE, f)); } catch {}
    }
}

function clearAllMarkers() {
    for (const pipeline of ['desarrollo', 'definicion']) {
        const root = path.join(PIPELINE, pipeline);
        for (const phase of fs.readdirSync(root)) {
            const blockedDir = path.join(root, phase, 'bloqueado-humano');
            if (!fs.existsSync(blockedDir)) continue;
            for (const f of fs.readdirSync(blockedDir)) {
                try { fs.unlinkSync(path.join(blockedDir, f)); } catch {}
            }
        }
    }
}

function listGhQueueLabels() {
    return fs.readdirSync(GH_QUEUE)
        .filter(f => f.endsWith('.json'))
        .map(f => JSON.parse(fs.readFileSync(path.join(GH_QUEUE, f), 'utf8')))
        .filter(c => c.action === 'label');
}

test('decidirFasePlaceholder mapea ready → desarrollo/dev', () => {
    const r = reconciler.decidirFasePlaceholder(['ready', 'app:client']);
    assert.equal(r.pipeline, 'desarrollo');
    assert.equal(r.phase, 'dev');
});

test('decidirFasePlaceholder default → definicion/analisis', () => {
    const r = reconciler.decidirFasePlaceholder(['needs-definition']);
    assert.equal(r.pipeline, 'definicion');
    assert.equal(r.phase, 'analisis');
    const r2 = reconciler.decidirFasePlaceholder([]);
    assert.equal(r2.pipeline, 'definicion');
    assert.equal(r2.phase, 'analisis');
});

test('reconcileLabelToFilesystem crea placeholder cuando label sin marker', () => {
    clearAllMarkers();
    clearGhQueue();
    const ghIssues = [
        { number: 9001, labels: ['ready'] },
        { number: 9002, labels: ['needs-definition'] },
    ];
    const created = reconciler.reconcileLabelToFilesystem(ghIssues, new Map());

    assert.equal(created, 2);
    const m1 = path.join(PIPELINE, 'desarrollo', 'dev', 'bloqueado-humano', '9001.guru');
    const m2 = path.join(PIPELINE, 'definicion', 'analisis', 'bloqueado-humano', '9002.guru');
    assert.equal(fs.existsSync(m1), true, 'marker 9001 creado');
    assert.equal(fs.existsSync(m1 + '.reason.json'), true, 'reason.json creado');
    assert.equal(fs.existsSync(m2), true, 'marker 9002 creado');

    const reason = JSON.parse(fs.readFileSync(m1 + '.reason.json', 'utf8'));
    assert.equal(reason.blocked_by, 'svc-reconciler');
    assert.match(reason.reason, /placeholder/i);
});

test('reconcileLabelToFilesystem omite issues que ya tienen marker', () => {
    clearAllMarkers();
    clearGhQueue();
    const blockedByIssue = new Map([[8500, [{ issue: 8500, skill: 'po', phase: 'validacion', pipeline: 'desarrollo' }]]]);
    const ghIssues = [{ number: 8500, labels: ['ready'] }];
    const created = reconciler.reconcileLabelToFilesystem(ghIssues, blockedByIssue);
    assert.equal(created, 0);
});

test('reconcileMarkerToLabel encolar label cuando marker sin label en GitHub', () => {
    clearAllMarkers();
    clearGhQueue();
    const markers = [
        { issue: 7001, skill: 'po', phase: 'validacion', pipeline: 'desarrollo' },
        { issue: 7002, skill: 'guru', phase: 'analisis', pipeline: 'definicion' },
    ];
    const ghSet = new Set([]); // ningún issue tiene el label
    const stateFn = () => 'OPEN';
    const enqueued = reconciler.reconcileMarkerToLabel(markers, ghSet, stateFn);

    assert.equal(enqueued, 2);
    const labels = listGhQueueLabels();
    assert.equal(labels.length, 2);
    assert.equal(labels.every(l => l.label === 'needs-human'), true);
    assert.deepEqual(labels.map(l => l.issue).sort(), [7001, 7002]);
});

test('reconcileMarkerToLabel deduplica markers del mismo issue (1 enqueue por issue)', () => {
    clearAllMarkers();
    clearGhQueue();
    const markers = [
        { issue: 6500, skill: 'po', phase: 'validacion', pipeline: 'desarrollo' },
        { issue: 6500, skill: 'ux', phase: 'validacion', pipeline: 'desarrollo' },
        { issue: 6500, skill: 'guru', phase: 'validacion', pipeline: 'desarrollo' },
    ];
    const enqueued = reconciler.reconcileMarkerToLabel(markers, new Set(), () => 'OPEN');
    assert.equal(enqueued, 1);
});

test('reconcileMarkerToLabel no encola si issue ya tiene label en GitHub', () => {
    clearAllMarkers();
    clearGhQueue();
    const markers = [{ issue: 5500, skill: 'po', phase: 'validacion', pipeline: 'desarrollo' }];
    const enqueued = reconciler.reconcileMarkerToLabel(markers, new Set([5500]), () => 'OPEN');
    assert.equal(enqueued, 0);
});

test('reconcileMarkerToLabel skip CLOSED y UNKNOWN', () => {
    clearAllMarkers();
    clearGhQueue();
    const markers = [
        { issue: 4001, skill: 'po', phase: 'validacion', pipeline: 'desarrollo' },
        { issue: 4002, skill: 'po', phase: 'validacion', pipeline: 'desarrollo' },
        { issue: 4003, skill: 'po', phase: 'validacion', pipeline: 'desarrollo' },
    ];
    const states = { 4001: 'OPEN', 4002: 'CLOSED', 4003: 'UNKNOWN' };
    const enqueued = reconciler.reconcileMarkerToLabel(markers, new Set(), n => states[n]);
    assert.equal(enqueued, 1, 'solo el OPEN encola');
});

test('reconcileClosedMarkers archiva markers de issues cerrados', () => {
    clearAllMarkers();
    clearGhQueue();
    const blockedDir = path.join(PIPELINE, 'desarrollo', 'validacion', 'bloqueado-humano');
    const archDir = path.join(PIPELINE, 'desarrollo', 'validacion', 'archivado');
    const markerFile = path.join(blockedDir, '3001.po');
    const reasonFile = markerFile + '.reason.json';
    fs.writeFileSync(markerFile, '');
    fs.writeFileSync(reasonFile, '{}');

    const markers = [{ issue: 3001, skill: 'po', phase: 'validacion', pipeline: 'desarrollo' }];
    const archived = reconciler.reconcileClosedMarkers(markers, new Set(), () => 'CLOSED');

    assert.equal(archived, 1);
    assert.equal(fs.existsSync(markerFile), false, 'marker movido fuera de bloqueado-humano/');
    assert.equal(fs.existsSync(reasonFile), false, 'reason borrado');
    assert.equal(fs.existsSync(path.join(archDir, '3001.po')), true, 'archivo movido a archivado/');
});

test('reconcileClosedMarkers omite markers de issues abiertos', () => {
    clearAllMarkers();
    clearGhQueue();
    const blockedDir = path.join(PIPELINE, 'desarrollo', 'validacion', 'bloqueado-humano');
    const markerFile = path.join(blockedDir, '2001.po');
    fs.writeFileSync(markerFile, '');
    fs.writeFileSync(markerFile + '.reason.json', '{}');

    const markers = [{ issue: 2001, skill: 'po', phase: 'validacion', pipeline: 'desarrollo' }];
    const archived = reconciler.reconcileClosedMarkers(markers, new Set(), () => 'OPEN');
    assert.equal(archived, 0);
    assert.equal(fs.existsSync(markerFile), true, 'marker no se movió');
});

test('enqueueLabelApply genera JSON con shape correcto', () => {
    clearGhQueue();
    reconciler.enqueueLabelApply(1234, 'needs-human');
    const files = fs.readdirSync(GH_QUEUE).filter(f => f.endsWith('.json'));
    assert.equal(files.length, 1);
    const cmd = JSON.parse(fs.readFileSync(path.join(GH_QUEUE, files[0]), 'utf8'));
    assert.deepEqual(cmd, { action: 'label', issue: 1234, label: 'needs-human' });
});

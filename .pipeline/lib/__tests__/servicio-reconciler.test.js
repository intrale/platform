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

test('reconcileLabelToFilesystem NO crea placeholder para issues con source:recommendation', () => {
    clearAllMarkers();
    clearGhQueue();
    const ghIssues = [
        { number: 3146, labels: ['enhancement', 'source:recommendation', 'needs-human', 'tipo:recomendacion'] },
        { number: 3147, labels: ['ready', 'source:recommendation', 'needs-human'] },
        { number: 9999, labels: ['ready', 'needs-human'] }, // este sí debería crearse
    ];
    const created = reconciler.reconcileLabelToFilesystem(ghIssues, new Map());

    assert.equal(created, 1, 'solo el issue sin label de recomendación crea placeholder');
    const m3146 = path.join(PIPELINE, 'definicion', 'analisis', 'bloqueado-humano', '3146.guru');
    const m3147 = path.join(PIPELINE, 'desarrollo', 'dev', 'bloqueado-humano', '3147.guru');
    const m9999 = path.join(PIPELINE, 'desarrollo', 'dev', 'bloqueado-humano', '9999.guru');
    assert.equal(fs.existsSync(m3146), false, '#3146 no debe tener marker fantasma (es recomendación)');
    assert.equal(fs.existsSync(m3147), false, '#3147 no debe tener marker fantasma (es recomendación)');
    assert.equal(fs.existsSync(m9999), true, '#9999 sí debe tener placeholder (agente real bloqueado)');
});

test('reconcileLabelToFilesystem también skipea tipo:recomendacion (alias en español)', () => {
    clearAllMarkers();
    clearGhQueue();
    const ghIssues = [
        { number: 4242, labels: ['tipo:recomendacion', 'needs-human'] },
    ];
    const created = reconciler.reconcileLabelToFilesystem(ghIssues, new Map());
    assert.equal(created, 0);
    const m = path.join(PIPELINE, 'definicion', 'analisis', 'bloqueado-humano', '4242.guru');
    assert.equal(fs.existsSync(m), false);
});

test('isRecommendationIssue detecta los dos labels de recomendación', () => {
    assert.equal(reconciler.isRecommendationIssue(['source:recommendation']), true);
    assert.equal(reconciler.isRecommendationIssue(['tipo:recomendacion']), true);
    assert.equal(reconciler.isRecommendationIssue(['enhancement', 'source:recommendation']), true);
    assert.equal(reconciler.isRecommendationIssue(['ready', 'app:client']), false);
    assert.equal(reconciler.isRecommendationIssue([]), false);
    assert.equal(reconciler.isRecommendationIssue(undefined), false);
    assert.equal(reconciler.isRecommendationIssue(null), false);
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

// =============================================================================
// #2994 — CA1/CA2: enqueueLabelApply persiste metadata + reconcileMarkerToLabel
// la pasa para que el worker pueda hacer guardia idempotente.
// =============================================================================

test('#2994 enqueueLabelApply persiste meta opcional (marker_path/snapshot_at/mtime)', () => {
    clearGhQueue();
    const meta = {
        marker_path: '/tmp/fake-marker',
        snapshot_at: '2026-05-05T19:30:00Z',
        marker_mtime: 1714935000000.5,
    };
    reconciler.enqueueLabelApply(5555, 'needs-human', meta);
    const files = fs.readdirSync(GH_QUEUE).filter(f => f.endsWith('.json'));
    const cmd = JSON.parse(fs.readFileSync(path.join(GH_QUEUE, files[0]), 'utf8'));
    assert.equal(cmd.marker_path, '/tmp/fake-marker');
    assert.equal(cmd.snapshot_at, '2026-05-05T19:30:00Z');
    assert.equal(cmd.marker_mtime, 1714935000000.5);
});

test('#2994 enqueueLabelApply ignora meta no-objeto (backward-compat)', () => {
    clearGhQueue();
    reconciler.enqueueLabelApply(5556, 'needs-human', null);
    const files = fs.readdirSync(GH_QUEUE).filter(f => f.endsWith('.json'));
    const cmd = JSON.parse(fs.readFileSync(path.join(GH_QUEUE, files[0]), 'utf8'));
    // Sin meta → shape clásico exacto, sin campos extra.
    assert.deepEqual(cmd, { action: 'label', issue: 5556, label: 'needs-human' });
});

test('#2994 reconcileMarkerToLabel persiste marker_path/mtime de cada marker', () => {
    clearAllMarkers();
    clearGhQueue();
    const dir = path.join(PIPELINE, 'desarrollo', 'validacion', 'bloqueado-humano');
    const markerFile = path.join(dir, '8800.po');
    fs.writeFileSync(markerFile, '');
    fs.writeFileSync(markerFile + '.reason.json', '{}');

    const markers = [{ issue: 8800, skill: 'po', phase: 'validacion', pipeline: 'desarrollo' }];
    const enqueued = reconciler.reconcileMarkerToLabel(markers, new Set(), () => 'OPEN');
    assert.equal(enqueued, 1);

    const files = fs.readdirSync(GH_QUEUE).filter(f => f.endsWith('.json'));
    const cmd = JSON.parse(fs.readFileSync(path.join(GH_QUEUE, files[0]), 'utf8'));
    assert.equal(cmd.marker_path, markerFile);
    assert.ok(typeof cmd.marker_mtime === 'number' && cmd.marker_mtime > 0);
    assert.ok(typeof cmd.snapshot_at === 'string' && /^\d{4}-/.test(cmd.snapshot_at));
});

// =============================================================================
// #2994 — CA3: reconcileHumanUnblockDetected detecta destrabe humano y mueve
// el marker fuera de bloqueado-humano/ siguiendo a GitHub como autoritativo.
// =============================================================================

test('#2994 CA3 detecta destrabe humano: label ausente + blocked_at viejo + no svc-reconciler', () => {
    clearAllMarkers();
    const dir = path.join(PIPELINE, 'desarrollo', 'validacion', 'bloqueado-humano');
    const pendDir = path.join(PIPELINE, 'desarrollo', 'validacion', 'pendiente');
    fs.mkdirSync(pendDir, { recursive: true });
    const markerFile = path.join(dir, '4400.po');
    fs.writeFileSync(markerFile, '');
    // blocked_at hace 5 min — bien fuera de la ventana de gracia (60s)
    const oldTs = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    fs.writeFileSync(markerFile + '.reason.json', JSON.stringify({
        issue: 4400, skill: 'po', phase: 'validacion', pipeline: 'desarrollo',
        blocked_at: oldTs, blocked_by: 'po', // skill original, NO reconciler
    }));

    const markers = [{ issue: 4400, skill: 'po', phase: 'validacion', pipeline: 'desarrollo' }];
    const ghIssueSet = new Set([]); // label NO está en GitHub
    const result = reconciler.reconcileHumanUnblockDetected(markers, ghIssueSet);

    assert.equal(result.detected, 1);
    assert.equal(result.movedIssues.has(4400), true);
    assert.equal(fs.existsSync(markerFile), false, 'marker debe haberse movido');
    assert.equal(fs.existsSync(path.join(pendDir, '4400.po')), true, 'marker debe estar en pendiente/');
    assert.equal(fs.existsSync(markerFile + '.reason.json'), false, 'reason.json eliminado');
});

test('#2994 CA3 NO destraba placeholders del propio reconciler (blocked_by=svc-reconciler)', () => {
    clearAllMarkers();
    const dir = path.join(PIPELINE, 'desarrollo', 'validacion', 'bloqueado-humano');
    const markerFile = path.join(dir, '4401.guru');
    fs.writeFileSync(markerFile, '');
    const oldTs = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    fs.writeFileSync(markerFile + '.reason.json', JSON.stringify({
        issue: 4401, skill: 'guru', phase: 'validacion', pipeline: 'desarrollo',
        blocked_at: oldTs, blocked_by: 'svc-reconciler',
    }));

    const markers = [{ issue: 4401, skill: 'guru', phase: 'validacion', pipeline: 'desarrollo' }];
    const result = reconciler.reconcileHumanUnblockDetected(markers, new Set([]));
    assert.equal(result.detected, 0);
    assert.equal(fs.existsSync(markerFile), true, 'placeholder propio NO debe moverse');
});

test('#2994 CA3 respeta ventana de gracia de 60s (blocked_at reciente)', () => {
    clearAllMarkers();
    const dir = path.join(PIPELINE, 'desarrollo', 'validacion', 'bloqueado-humano');
    const markerFile = path.join(dir, '4402.po');
    fs.writeFileSync(markerFile, '');
    const recentTs = new Date(Date.now() - 10 * 1000).toISOString(); // 10s atrás
    fs.writeFileSync(markerFile + '.reason.json', JSON.stringify({
        issue: 4402, skill: 'po', phase: 'validacion', pipeline: 'desarrollo',
        blocked_at: recentTs, blocked_by: 'po',
    }));

    const markers = [{ issue: 4402, skill: 'po', phase: 'validacion', pipeline: 'desarrollo' }];
    const result = reconciler.reconcileHumanUnblockDetected(markers, new Set([]));
    assert.equal(result.detected, 0);
    assert.equal(fs.existsSync(markerFile), true, 'marker fresco NO debe destrabarse');
});

test('#2994 CA3 no toca markers cuyo label sí está en GitHub', () => {
    clearAllMarkers();
    const dir = path.join(PIPELINE, 'desarrollo', 'validacion', 'bloqueado-humano');
    const markerFile = path.join(dir, '4403.po');
    fs.writeFileSync(markerFile, '');
    fs.writeFileSync(markerFile + '.reason.json', JSON.stringify({
        issue: 4403, blocked_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        blocked_by: 'po',
    }));
    const markers = [{ issue: 4403, skill: 'po', phase: 'validacion', pipeline: 'desarrollo' }];
    const result = reconciler.reconcileHumanUnblockDetected(markers, new Set([4403]));
    assert.equal(result.detected, 0);
});

// =============================================================================
// #2994 — CA5: appendStaleOrderLog escribe JSONL en logs/stale-orders.log
// =============================================================================

test('#2994 CA5 appendStaleOrderLog persiste línea JSONL', () => {
    const logFile = path.join(PIPELINE, 'logs', 'stale-orders.log');
    try { fs.unlinkSync(logFile); } catch {}
    reconciler.appendStaleOrderLog({
        reason: 'stale-mtime',
        issue: 9999,
        label: 'needs-human',
        snapshot_at: '2026-05-05T19:30:00Z',
        current_mtime: 12345.67,
        detail: 'test',
    });
    const raw = fs.readFileSync(logFile, 'utf8').trim();
    const ev = JSON.parse(raw);
    assert.equal(ev.reason, 'stale-mtime');
    assert.equal(ev.issue, 9999);
    assert.equal(ev.label, 'needs-human');
    assert.equal(ev.current_mtime, 12345.67);
    assert.equal(ev.snapshot_at, '2026-05-05T19:30:00Z');
    assert.ok(/^\d{4}-/.test(ev.ts));
});

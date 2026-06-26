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
// #3186 — reconcileResolvedMarkers archiva markers cuando el guardian
// re-aprueba (listo/ o procesado/ posterior) o aplica TTL como red de seguridad.
// =============================================================================

function ensurePhaseDirs(pipeline, phase) {
    const phaseRoot = path.join(PIPELINE, pipeline, phase);
    fs.mkdirSync(path.join(phaseRoot, 'bloqueado-humano'), { recursive: true });
    fs.mkdirSync(path.join(phaseRoot, 'pendiente'), { recursive: true });
    fs.mkdirSync(path.join(phaseRoot, 'listo'), { recursive: true });
    fs.mkdirSync(path.join(phaseRoot, 'procesado'), { recursive: true });
    fs.mkdirSync(path.join(phaseRoot, 'archivado'), { recursive: true });
}

function writeMarker(pipeline, phase, issue, skill, mtimeMs) {
    const dir = path.join(PIPELINE, pipeline, phase, 'bloqueado-humano');
    fs.mkdirSync(dir, { recursive: true });
    const markerPath = path.join(dir, `${issue}.${skill}`);
    fs.writeFileSync(markerPath, '');
    fs.writeFileSync(markerPath + '.reason.json', JSON.stringify({
        issue, skill, phase, pipeline,
        blocked_at: new Date(mtimeMs || Date.now()).toISOString(),
        blocked_by: skill,
    }));
    if (mtimeMs) {
        const secs = mtimeMs / 1000;
        fs.utimesSync(markerPath, secs, secs);
    }
    return markerPath;
}

function writeStateFile(pipeline, phase, state, issue, skill, mtimeMs) {
    const dir = path.join(PIPELINE, pipeline, phase, state);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${issue}.${skill}`);
    fs.writeFileSync(filePath, '');
    if (mtimeMs) {
        const secs = mtimeMs / 1000;
        fs.utimesSync(filePath, secs, secs);
    }
    return filePath;
}

function clearStateDirs(pipeline, phase) {
    const phaseRoot = path.join(PIPELINE, pipeline, phase);
    for (const state of ['listo', 'procesado', 'archivado']) {
        const dir = path.join(phaseRoot, state);
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir)) {
            try { fs.unlinkSync(path.join(dir, f)); } catch {}
        }
    }
}

test('#3186 reconcileResolvedMarkers archiva marker cuando guardian dropea listo/ posterior', () => {
    clearAllMarkers();
    clearGhQueue();
    ensurePhaseDirs('definicion', 'analisis');
    clearStateDirs('definicion', 'analisis');

    // Marker viejo (5 min atrás)
    const markerMtime = Date.now() - 5 * 60 * 1000;
    writeMarker('definicion', 'analisis', 3082, 'guru', markerMtime);
    // Guardian re-aprobó: listo/ con mtime POSTERIOR al marker
    writeStateFile('definicion', 'analisis', 'listo', 3082, 'guru', Date.now() - 60 * 1000);

    const markers = [{ issue: 3082, skill: 'guru', phase: 'analisis', pipeline: 'definicion' }];
    const result = reconciler.reconcileResolvedMarkers(markers);

    assert.equal(result.archived, 1);
    assert.equal(result.archivedIssues.has(3082), true);
    assert.equal(result.removeLabelsEnqueued, 1, 'sin otros markers → remove-label encolado');

    // Marker movido a archivado/ con sufijo guardian-resolved
    const archivedDir = path.join(PIPELINE, 'definicion', 'analisis', 'archivado');
    const archivedFiles = fs.readdirSync(archivedDir).filter(f => f.startsWith('3082.guru.'));
    assert.equal(archivedFiles.length, 1);
    assert.match(archivedFiles[0], /^3082\.guru\.guardian-resolved-/);

    // reason.json eliminado
    const blockedDir = path.join(PIPELINE, 'definicion', 'analisis', 'bloqueado-humano');
    assert.equal(fs.existsSync(path.join(blockedDir, '3082.guru.reason.json')), false);

    // Orden remove-label encolada
    const orders = fs.readdirSync(GH_QUEUE)
        .filter(f => f.endsWith('.json'))
        .map(f => JSON.parse(fs.readFileSync(path.join(GH_QUEUE, f), 'utf8')));
    const removeOrders = orders.filter(o => o.action === 'remove-label');
    assert.equal(removeOrders.length, 1);
    assert.equal(removeOrders[0].issue, 3082);
    assert.equal(removeOrders[0].label, 'needs-human');
});

test('#3186 reconcileResolvedMarkers también detecta resolución en procesado/ (no solo listo/)', () => {
    clearAllMarkers();
    clearGhQueue();
    ensurePhaseDirs('definicion', 'analisis');
    clearStateDirs('definicion', 'analisis');

    const markerMtime = Date.now() - 5 * 60 * 1000;
    writeMarker('definicion', 'analisis', 3083, 'guru', markerMtime);
    // El pulpo movió listo/ → procesado/ al promover. Reconciler corre tarde.
    writeStateFile('definicion', 'analisis', 'procesado', 3083, 'guru', Date.now() - 60 * 1000);

    const markers = [{ issue: 3083, skill: 'guru', phase: 'analisis', pipeline: 'definicion' }];
    const result = reconciler.reconcileResolvedMarkers(markers);

    assert.equal(result.archived, 1, 'también archiva si la resolución está en procesado/');
});

test('#3186 reconcileResolvedMarkers NO archiva si listo/ no existe', () => {
    clearAllMarkers();
    clearGhQueue();
    ensurePhaseDirs('definicion', 'analisis');
    clearStateDirs('definicion', 'analisis');

    writeMarker('definicion', 'analisis', 3084, 'guru', Date.now() - 5 * 60 * 1000);
    // NO escribimos archivo en listo/ ni procesado/

    const markers = [{ issue: 3084, skill: 'guru', phase: 'analisis', pipeline: 'definicion' }];
    const result = reconciler.reconcileResolvedMarkers(markers, { ttlMs: 30 * 24 * 60 * 60 * 1000 });

    assert.equal(result.archived, 0);
    assert.equal(result.removeLabelsEnqueued, 0);
    const blockedDir = path.join(PIPELINE, 'definicion', 'analisis', 'bloqueado-humano');
    assert.equal(fs.existsSync(path.join(blockedDir, '3084.guru')), true, 'marker intacto');
});

test('#3186 reconcileResolvedMarkers NO archiva si listo/ existe pero mtime ANTERIOR al marker', () => {
    clearAllMarkers();
    clearGhQueue();
    ensurePhaseDirs('definicion', 'analisis');
    clearStateDirs('definicion', 'analisis');

    // Caso: el guardian aprobó antes, después rechazó (marker más nuevo que listo/).
    const oldListoMtime = Date.now() - 10 * 60 * 1000;
    const newerMarkerMtime = Date.now() - 2 * 60 * 1000;
    writeStateFile('definicion', 'analisis', 'listo', 3085, 'guru', oldListoMtime);
    writeMarker('definicion', 'analisis', 3085, 'guru', newerMarkerMtime);

    const markers = [{ issue: 3085, skill: 'guru', phase: 'analisis', pipeline: 'definicion' }];
    const result = reconciler.reconcileResolvedMarkers(markers, { ttlMs: 30 * 24 * 60 * 60 * 1000 });

    assert.equal(result.archived, 0, 'listo/ más viejo que marker no cuenta como resolución');
});

test('#3186 reconcileResolvedMarkers aplica TTL como red de seguridad (7d sin movimiento)', () => {
    clearAllMarkers();
    clearGhQueue();
    ensurePhaseDirs('definicion', 'analisis');
    clearStateDirs('definicion', 'analisis');

    // Marker de hace 10 días, sin archivo en listo/ ni procesado/
    const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
    writeMarker('definicion', 'analisis', 3086, 'guru', tenDaysAgo);

    const markers = [{ issue: 3086, skill: 'guru', phase: 'analisis', pipeline: 'definicion' }];
    const result = reconciler.reconcileResolvedMarkers(markers); // ttl default 7d

    assert.equal(result.archived, 1, 'marker stale debe archivarse por TTL');
    assert.equal(result.removeLabelsEnqueued, 1);

    const archivedDir = path.join(PIPELINE, 'definicion', 'analisis', 'archivado');
    const archivedFiles = fs.readdirSync(archivedDir).filter(f => f.startsWith('3086.guru.'));
    assert.equal(archivedFiles.length, 1);
    assert.match(archivedFiles[0], /^3086\.guru\.ttl-expired-/);
});

test('#3186 reconcileResolvedMarkers NO aplica TTL si está dentro del límite', () => {
    clearAllMarkers();
    clearGhQueue();
    ensurePhaseDirs('definicion', 'analisis');
    clearStateDirs('definicion', 'analisis');

    // Marker de 3 días — dentro del TTL de 7d
    const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
    writeMarker('definicion', 'analisis', 3087, 'guru', threeDaysAgo);

    const markers = [{ issue: 3087, skill: 'guru', phase: 'analisis', pipeline: 'definicion' }];
    const result = reconciler.reconcileResolvedMarkers(markers);

    assert.equal(result.archived, 0, 'TTL aún no se cumplió');
});

test('#3186 reconcileResolvedMarkers solo encola remove-label si NO quedan otros markers cross-fase', () => {
    clearAllMarkers();
    clearGhQueue();
    ensurePhaseDirs('definicion', 'analisis');
    ensurePhaseDirs('desarrollo', 'dev');
    clearStateDirs('definicion', 'analisis');
    clearStateDirs('desarrollo', 'dev');

    // Issue #3088 tiene markers en DOS fases. Resolvemos solo el de definicion.
    const markerMtime = Date.now() - 5 * 60 * 1000;
    writeMarker('definicion', 'analisis', 3088, 'guru', markerMtime);
    writeMarker('desarrollo', 'dev', 3088, 'po', markerMtime); // otro marker activo

    // Resolución del guardian guru en definicion
    writeStateFile('definicion', 'analisis', 'listo', 3088, 'guru', Date.now() - 60 * 1000);

    const markers = [
        { issue: 3088, skill: 'guru', phase: 'analisis', pipeline: 'definicion' },
        { issue: 3088, skill: 'po', phase: 'dev', pipeline: 'desarrollo' },
    ];
    const result = reconciler.reconcileResolvedMarkers(markers);

    assert.equal(result.archived, 1, 'archiva solo el resuelto');
    assert.equal(result.removeLabelsEnqueued, 0, 'NO encola remove-label porque queda el de po');

    // Verificar que no hay orden remove-label en la queue
    const orders = fs.readdirSync(GH_QUEUE)
        .filter(f => f.endsWith('.json'))
        .map(f => JSON.parse(fs.readFileSync(path.join(GH_QUEUE, f), 'utf8')));
    const removeOrders = orders.filter(o => o.action === 'remove-label');
    assert.equal(removeOrders.length, 0);
});

test('#3186 reconcileResolvedMarkers encola remove-label cuando archiva el ÚLTIMO marker del issue', () => {
    clearAllMarkers();
    clearGhQueue();
    ensurePhaseDirs('definicion', 'analisis');
    ensurePhaseDirs('desarrollo', 'dev');
    clearStateDirs('definicion', 'analisis');
    clearStateDirs('desarrollo', 'dev');

    const markerMtime = Date.now() - 5 * 60 * 1000;
    writeMarker('definicion', 'analisis', 3089, 'guru', markerMtime);
    writeMarker('desarrollo', 'dev', 3089, 'po', markerMtime);

    // Ambos guardians re-aprobaron
    writeStateFile('definicion', 'analisis', 'listo', 3089, 'guru', Date.now() - 60 * 1000);
    writeStateFile('desarrollo', 'dev', 'listo', 3089, 'po', Date.now() - 60 * 1000);

    const markers = [
        { issue: 3089, skill: 'guru', phase: 'analisis', pipeline: 'definicion' },
        { issue: 3089, skill: 'po', phase: 'dev', pipeline: 'desarrollo' },
    ];
    const result = reconciler.reconcileResolvedMarkers(markers);

    assert.equal(result.archived, 2);
    assert.equal(result.removeLabelsEnqueued, 1, 'todos archivados → un único remove-label');

    const orders = fs.readdirSync(GH_QUEUE)
        .filter(f => f.endsWith('.json'))
        .map(f => JSON.parse(fs.readFileSync(path.join(GH_QUEUE, f), 'utf8')));
    const removeOrders = orders.filter(o => o.action === 'remove-label');
    assert.equal(removeOrders.length, 1);
    assert.equal(removeOrders[0].issue, 3089);
});

test('#3186 reconcileResolvedMarkers log con reason=guardian-resolved escribe stale-orders.log', () => {
    clearAllMarkers();
    clearGhQueue();
    ensurePhaseDirs('definicion', 'analisis');
    clearStateDirs('definicion', 'analisis');

    const logFile = path.join(PIPELINE, 'logs', 'stale-orders.log');
    try { fs.unlinkSync(logFile); } catch {}

    const markerMtime = Date.now() - 5 * 60 * 1000;
    writeMarker('definicion', 'analisis', 3090, 'guru', markerMtime);
    writeStateFile('definicion', 'analisis', 'listo', 3090, 'guru', Date.now() - 60 * 1000);

    const markers = [{ issue: 3090, skill: 'guru', phase: 'analisis', pipeline: 'definicion' }];
    reconciler.reconcileResolvedMarkers(markers);

    const raw = fs.readFileSync(logFile, 'utf8').trim();
    const lines = raw.split('\n').filter(Boolean);
    assert.ok(lines.length >= 1);
    const ev = JSON.parse(lines[lines.length - 1]);
    assert.equal(ev.reason, 'guardian-resolved');
    assert.equal(ev.issue, 3090);
    assert.equal(ev.label, 'needs-human');
    assert.match(ev.detail, /definicion\/analisis\/listo\/3090\.guru/);
});

test('#3186 safeTsSuffix produce filename Windows-safe (sin : ni .)', () => {
    const suffix = reconciler.safeTsSuffix(Date.parse('2026-05-14T22:30:45.123Z'));
    assert.equal(suffix.includes(':'), false, 'sin dos puntos');
    assert.equal(suffix.includes('.'), false, 'sin punto');
    assert.match(suffix, /^2026-05-14T22-30-45-123Z$/);
});

test('#3186 findGuardianResolution prefiere listo/ sobre procesado/ cuando ambos existen', () => {
    clearAllMarkers();
    clearGhQueue();
    ensurePhaseDirs('definicion', 'analisis');
    clearStateDirs('definicion', 'analisis');

    const markerMtime = Date.now() - 10 * 60 * 1000;
    const listoMtime = Date.now() - 5 * 60 * 1000;
    const procesadoMtime = Date.now() - 3 * 60 * 1000;
    writeStateFile('definicion', 'analisis', 'listo', 3091, 'guru', listoMtime);
    writeStateFile('definicion', 'analisis', 'procesado', 3091, 'guru', procesadoMtime);

    const result = reconciler.findGuardianResolution(
        { issue: 3091, skill: 'guru', phase: 'analisis', pipeline: 'definicion' },
        markerMtime,
    );
    assert.ok(result, 'encuentra resolución');
    assert.equal(result.state, 'listo', 'primero busca en listo/');
});

test('#3186 enqueueLabelRemove escribe JSON con shape correcto', () => {
    clearGhQueue();
    reconciler.enqueueLabelRemove(7777, 'needs-human');
    const files = fs.readdirSync(GH_QUEUE).filter(f => f.endsWith('.json'));
    assert.equal(files.length, 1);
    const cmd = JSON.parse(fs.readFileSync(path.join(GH_QUEUE, files[0]), 'utf8'));
    assert.deepEqual(cmd, { action: 'remove-label', issue: 7777, label: 'needs-human' });
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

// =============================================================================
// #4222 — Cruce label needs-human ↔ avance físico de fases (anti bloqueo fantasma)
// =============================================================================

// Crea un marker físico de avance (`listo/` o `procesado/`) para un issue en una
// fase concreta del pipeline desarrollo/definicion.
function writeProgressMarker(pipeline, phase, state, issue, skill) {
    const dir = path.join(PIPELINE, pipeline, phase, state);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${issue}.${skill}`), '');
}

function clearProgressMarkers() {
    for (const pipeline of ['desarrollo', 'definicion']) {
        const root = path.join(PIPELINE, pipeline);
        if (!fs.existsSync(root)) continue;
        for (const phase of fs.readdirSync(root)) {
            for (const state of ['listo', 'procesado']) {
                const dir = path.join(root, phase, state);
                if (!fs.existsSync(dir)) continue;
                for (const f of fs.readdirSync(dir)) {
                    try { fs.unlinkSync(path.join(dir, f)); } catch {}
                }
            }
        }
    }
}

function listGhQueueRemoveLabels() {
    return fs.readdirSync(GH_QUEUE)
        .filter(f => f.endsWith('.json'))
        .map(f => JSON.parse(fs.readFileSync(path.join(GH_QUEUE, f), 'utf8')))
        .filter(c => c.action === 'remove-label');
}

test('#4222 findFurthestPhysicalPhaseIndex devuelve la fase física más avanzada', () => {
    clearProgressMarkers();
    const order = reconciler.loadGlobalPhaseOrder();
    // Sin markers → -1
    assert.equal(reconciler.findFurthestPhysicalPhaseIndex(4191, order), -1);
    // Marker en verificacion/listo → índice de desarrollo/verificacion
    writeProgressMarker('desarrollo', 'verificacion', 'listo', 4191, 'tester');
    const idxVerif = reconciler.globalPhaseIndex(order, 'desarrollo', 'verificacion');
    assert.equal(reconciler.findFurthestPhysicalPhaseIndex(4191, order), idxVerif);
    // Agregar marker más avanzado (aprobacion/procesado) → debe ganar el más avanzado
    writeProgressMarker('desarrollo', 'aprobacion', 'procesado', 4191, 'review');
    const idxAprob = reconciler.globalPhaseIndex(order, 'desarrollo', 'aprobacion');
    assert.equal(reconciler.findFurthestPhysicalPhaseIndex(4191, order), idxAprob);
    clearProgressMarkers();
});

test('#4222 findFurthestPhysicalPhaseIndex ignora artifacts (.reason.json)', () => {
    clearProgressMarkers();
    const order = reconciler.loadGlobalPhaseOrder();
    const dir = path.join(PIPELINE, 'desarrollo', 'verificacion', 'listo');
    fs.mkdirSync(dir, { recursive: true });
    // Solo un artifact, sin marker base → no cuenta como avance
    fs.writeFileSync(path.join(dir, '4191.tester.reason.json'), '{}');
    assert.equal(reconciler.findFurthestPhysicalPhaseIndex(4191, order), -1);
    clearProgressMarkers();
});

test('#4222 isNeedsHumanStaleByProgress: stale cuando progresó más allá del placeholder', () => {
    clearProgressMarkers();
    // Placeholder de un issue Ready cae en desarrollo/dev. Marker físico en
    // verificacion (posterior) → stale.
    writeProgressMarker('desarrollo', 'verificacion', 'listo', 4191, 'tester');
    const r = reconciler.isNeedsHumanStaleByProgress(4191, 'desarrollo', 'dev');
    assert.equal(r.stale, true);
    assert.equal(r.furthestPhase, 'desarrollo/verificacion');
    clearProgressMarkers();
});

test('#4222 isNeedsHumanStaleByProgress: NO stale cuando avance == fase del placeholder', () => {
    clearProgressMarkers();
    // Marker en la MISMA fase del placeholder (dev) — done con dev pero el bloqueo
    // en dev sigue siendo consistente. Conservador: no stale.
    writeProgressMarker('desarrollo', 'dev', 'listo', 4300, 'pipeline-dev');
    const r = reconciler.isNeedsHumanStaleByProgress(4300, 'desarrollo', 'dev');
    assert.equal(r.stale, false);
    clearProgressMarkers();
});

test('#4222 isNeedsHumanStaleByProgress: NO stale sin markers de avance', () => {
    clearProgressMarkers();
    const r = reconciler.isNeedsHumanStaleByProgress(4301, 'desarrollo', 'dev');
    assert.equal(r.stale, false);
    clearProgressMarkers();
});

// Escenario Gherkin 1: Label needs-human stale no genera bloqueo fantasma
test('#4222 Gherkin: needs-human stale NO crea bloqueo y limpia el label', () => {
    clearAllMarkers();
    clearGhQueue();
    clearProgressMarkers();
    const logFile = path.join(PIPELINE, 'logs', 'stale-orders.log');
    try { fs.unlinkSync(logFile); } catch {}

    // Issue #4191: markers físicos en fase posterior (verificacion + aprobacion + listo),
    // pero label needs-human viejo en GitHub (Ready → placeholder en dev).
    writeProgressMarker('desarrollo', 'verificacion', 'procesado', 4191, 'tester');
    writeProgressMarker('desarrollo', 'aprobacion', 'listo', 4191, 'review');

    const ghIssues = [{ number: 4191, labels: ['ready', 'needs-human'] }];
    const created = reconciler.reconcileLabelToFilesystem(ghIssues, new Map());

    // No crea placeholder
    assert.equal(created, 0, 'no debe crear placeholder para label stale');
    const marker = path.join(PIPELINE, 'desarrollo', 'dev', 'bloqueado-humano', '4191.guru');
    assert.equal(fs.existsSync(marker), false, 'no debe existir marker de bloqueo');

    // Limpia el label stale (encola remove-label)
    const removes = listGhQueueRemoveLabels();
    assert.equal(removes.length, 1, 'debe encolar un remove-label');
    assert.equal(removes[0].issue, 4191);
    assert.equal(removes[0].label, 'needs-human');

    // Registra el destrabe en el log para auditoría (CA-3)
    const logRaw = fs.readFileSync(logFile, 'utf8').trim();
    const ev = JSON.parse(logRaw.split('\n').pop());
    assert.equal(ev.reason, 'stale-needs-human-phase-progress');
    assert.equal(ev.issue, 4191);
    assert.match(ev.detail, /progres/i);

    clearProgressMarkers();
});

// Escenario Gherkin 2: Label needs-human legítimo mantiene el bloqueo
test('#4222 Gherkin: needs-human legítimo (sin avance) mantiene el bloqueo', () => {
    clearAllMarkers();
    clearGhQueue();
    clearProgressMarkers();

    // Issue cuya fase física actual justifica decisión humana: sin markers de
    // avance posterior. Mantiene el comportamiento actual (crea placeholder).
    const ghIssues = [{ number: 4400, labels: ['ready', 'needs-human'] }];
    const created = reconciler.reconcileLabelToFilesystem(ghIssues, new Map());

    assert.equal(created, 1, 'debe crear placeholder legítimo');
    const marker = path.join(PIPELINE, 'desarrollo', 'dev', 'bloqueado-humano', '4400.guru');
    assert.equal(fs.existsSync(marker), true, 'debe existir marker de bloqueo');

    // No limpia ningún label
    const removes = listGhQueueRemoveLabels();
    assert.equal(removes.length, 0, 'no debe encolar remove-label para bloqueo legítimo');

    clearProgressMarkers();
    clearAllMarkers();
});

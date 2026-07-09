'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { analyzeStuckIssue, classifySkill, DEFAULT_STALE_THRESHOLD_MS } = require('./stuck-phase-detector');

const NOW = 1_800_000_000_000;
const OLD = NOW - 20 * 60 * 1000;   // 20 min → stale
const RECENT = NOW - 60 * 1000;      // 1 min → reciente
const APROB = { resultado: 'aprobado' };
const CANCEL = { cancelado_por: 'fast-fail-rebote', cancelado_ts: 'x' };
const RECHAZO = { resultado: 'rechazado', motivo: 'x' };
const CORRUPT = { issue: 1, fase: 'validacion' }; // sin resultado

function deliv(skill, state, yaml, mtimeMs = OLD) { return { skill, state, yaml, mtimeMs }; }

// ─── classifySkill ──────────────────────────────────────────────────────────
test('classifySkill: aprobado en listo → done', () => {
    assert.equal(classifySkill('po', [deliv('po', 'listo', APROB)], new Set()).status, 'done');
});
test('classifySkill: cancelado → cancelled', () => {
    assert.equal(classifySkill('po', [deliv('po', 'procesado', CANCEL)], new Set()).status, 'cancelled');
});
test('classifySkill: rechazado → rejected', () => {
    assert.equal(classifySkill('po', [deliv('po', 'listo', RECHAZO)], new Set()).status, 'rejected');
});
test('classifySkill: presente sin resultado → corrupt', () => {
    assert.equal(classifySkill('po', [deliv('po', 'listo', CORRUPT)], new Set()).status, 'corrupt');
});
test('classifySkill: ausente → missing', () => {
    assert.equal(classifySkill('ux', [deliv('po', 'listo', APROB)], new Set()).status, 'missing');
});
test('classifySkill: en pendiente/trabajando → live (gana sobre todo)', () => {
    assert.equal(classifySkill('po', [deliv('po', 'listo', APROB)], new Set(['po'])).status, 'live');
});
test('classifySkill: prioridad listo(aprobado) > procesado(cancelado)', () => {
    const dels = [deliv('po', 'procesado', CANCEL), deliv('po', 'listo', APROB)];
    assert.equal(classifySkill('po', dels, new Set()).status, 'done');
});
test('classifySkill: archivado aprobado cuenta como done', () => {
    assert.equal(classifySkill('po', [deliv('po', 'archivado', APROB)], new Set()).status, 'done');
});
test('classifySkill: archivado cancelado NO es done', () => {
    assert.equal(classifySkill('po', [deliv('po', 'archivado', CANCEL)], new Set()).status, 'cancelled');
});

// ─── analyzeStuckIssue: no-stuck ────────────────────────────────────────────
test('completo → none', () => {
    const r = analyzeStuckIssue({
        requiredSkills: ['po', 'ux', 'guru'],
        deliverables: [deliv('po', 'listo', APROB), deliv('ux', 'listo', APROB), deliv('guru', 'listo', APROB)],
        nowMs: NOW,
    });
    assert.deepEqual([r.stuck, r.action], [false, 'none']);
});
test('hay trabajo vivo → none (no interferir)', () => {
    const r = analyzeStuckIssue({
        requiredSkills: ['po', 'ux'],
        deliverables: [deliv('po', 'listo', APROB)],
        liveSkills: ['ux'],
        nowMs: NOW,
    });
    assert.equal(r.action, 'none');
    assert.equal(r.reason, 'trabajo-vivo');
});
test('deliverable reciente (< threshold) → none (darle tiempo)', () => {
    const r = analyzeStuckIssue({
        requiredSkills: ['po', 'ux'],
        deliverables: [deliv('po', 'listo', APROB, RECENT), deliv('ux', 'procesado', CANCEL, RECENT)],
        nowMs: NOW,
    });
    assert.equal(r.action, 'none');
    assert.equal(r.reason, 'reciente');
});
test('sin deliverables → none (lo maneja el intake)', () => {
    const r = analyzeStuckIssue({ requiredSkills: ['po'], deliverables: [], nowMs: NOW });
    assert.equal(r.action, 'none');
});
test('sin skills requeridos → none', () => {
    const r = analyzeStuckIssue({ requiredSkills: [], deliverables: [deliv('po', 'listo', APROB)], nowMs: NOW });
    assert.equal(r.action, 'none');
});

// ─── analyzeStuckIssue: requeue ─────────────────────────────────────────────
test('CASO #4534: guru aprobado + po/ux cancelados (stale) → ESCALATE (cancelado = ambiguo)', () => {
    const r = analyzeStuckIssue({
        requiredSkills: ['po', 'ux', 'guru'],
        deliverables: [
            deliv('guru', 'listo', APROB),
            deliv('po', 'procesado', CANCEL),
            deliv('ux', 'procesado', CANCEL),
        ],
        nowMs: NOW,
    });
    assert.equal(r.action, 'escalate', 'un cancelado implica rechazo previo → humano decide, no re-encolar a ciegas');
    assert.match(r.reason, /cancel/);
});
test('CASO #4507: review aprobado + po/architect archivado-aprobado + ux faltante → requeue [ux]', () => {
    const r = analyzeStuckIssue({
        requiredSkills: ['review', 'po', 'ux', 'architect'],
        deliverables: [
            deliv('review', 'listo', APROB),
            deliv('po', 'archivado', APROB),
            deliv('architect', 'archivado', APROB),
        ],
        nowMs: NOW,
    });
    assert.equal(r.action, 'requeue');
    assert.deepEqual(r.requeueSkills, ['ux']);
});
test('skill missing (stale, no live) → requeue', () => {
    const r = analyzeStuckIssue({
        requiredSkills: ['po', 'ux'],
        deliverables: [deliv('po', 'listo', APROB)],
        nowMs: NOW,
    });
    assert.equal(r.action, 'requeue');
    assert.deepEqual(r.requeueSkills, ['ux']);
});
test('skill corrupto (sin resultado) → ESCALATE (indeterminado, no re-correr a ciegas)', () => {
    const r = analyzeStuckIssue({
        requiredSkills: ['po', 'ux'],
        deliverables: [deliv('po', 'listo', APROB), deliv('ux', 'listo', CORRUPT)],
        nowMs: NOW,
    });
    assert.equal(r.action, 'escalate');
});
test('mixto: faltante + cancelado → ESCALATE (la ambigüedad gana sobre requeue)', () => {
    const r = analyzeStuckIssue({
        requiredSkills: ['po', 'ux', 'guru'],
        deliverables: [deliv('po', 'listo', APROB), deliv('ux', 'procesado', CANCEL)], // guru missing
        nowMs: NOW,
    });
    assert.equal(r.action, 'escalate', 'si hay cualquier ambigüedad, no auto-remediar parcial');
});

// ─── analyzeStuckIssue: escalate ────────────────────────────────────────────
test('rechazo REAL → escalate (NO re-encolar, evita loop)', () => {
    const r = analyzeStuckIssue({
        requiredSkills: ['po', 'ux'],
        deliverables: [deliv('po', 'listo', APROB), deliv('ux', 'listo', RECHAZO)],
        nowMs: NOW,
    });
    assert.equal(r.action, 'escalate');
    assert.match(r.reason, /rechazo/);
});
test('rechazo + faltante → escalate gana (el rechazo manda)', () => {
    const r = analyzeStuckIssue({
        requiredSkills: ['po', 'ux', 'guru'],
        deliverables: [deliv('po', 'listo', RECHAZO)],
        nowMs: NOW,
    });
    assert.equal(r.action, 'escalate');
});

// ─── boundaries ─────────────────────────────────────────────────────────────
test('boundary: 1ms bajo el threshold → none (aún no stale)', () => {
    const r = analyzeStuckIssue({
        requiredSkills: ['po', 'ux'],
        deliverables: [deliv('po', 'listo', APROB, NOW - DEFAULT_STALE_THRESHOLD_MS + 1)],
        nowMs: NOW,
    });
    assert.equal(r.action, 'none', 'edad < threshold no es stale');
});
test('boundary: exactamente en el threshold → stale (age >= threshold)', () => {
    const r = analyzeStuckIssue({
        requiredSkills: ['po', 'ux'],
        deliverables: [deliv('po', 'listo', APROB, NOW - DEFAULT_STALE_THRESHOLD_MS)],
        nowMs: NOW,
    });
    assert.equal(r.stuck, true);
    assert.equal(r.action, 'requeue');
});
test('threshold custom respetado', () => {
    const r = analyzeStuckIssue({
        requiredSkills: ['po', 'ux'],
        deliverables: [deliv('po', 'listo', APROB, NOW - 5 * 60 * 1000)],
        nowMs: NOW,
        staleThresholdMs: 3 * 60 * 1000,
    });
    assert.equal(r.action, 'requeue', '5min > threshold custom de 3min');
});

// ─── robustez de inputs ─────────────────────────────────────────────────────
test('inputs vacíos/undefined no tiran', () => {
    assert.doesNotThrow(() => analyzeStuckIssue());
    assert.doesNotThrow(() => analyzeStuckIssue({ requiredSkills: ['po'], deliverables: null, nowMs: NOW }));
    assert.doesNotThrow(() => analyzeStuckIssue({ requiredSkills: ['po'], deliverables: [{ skill: 'po' }], nowMs: NOW }));
});
test('yaml faltante en deliverable no tira y cuenta como corrupt → escalate', () => {
    const r = analyzeStuckIssue({
        requiredSkills: ['po'],
        deliverables: [{ skill: 'po', state: 'listo', mtimeMs: OLD }], // sin yaml
        nowMs: NOW,
    });
    assert.equal(r.action, 'escalate'); // corrupt → indeterminado → humano
});

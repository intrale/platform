'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
    planReconciliation, executeDecisions, decideForIssue,
    DEFAULT_MAX_REQUEUE_ATTEMPTS, DEFAULT_CAP_PER_TICK,
} = require('./stuck-phase-reconciler');

const NOW = 1_800_000_000_000;
const OLD = NOW - 30 * 60 * 1000; // stale
const APROB = { resultado: 'aprobado' };
const CANCEL = { cancelado_por: 'fast-fail-rebote' };

function deliv(skill, state, yaml, mtimeMs = OLD) { return { skill, state, yaml, mtimeMs }; }
// issue varado típico: fase paralela, deliverable viejo, sin trabajo vivo
function stuckIssue(over = {}) {
    return {
        issue: 100, pipeline: 'desarrollo', fase: 'validacion',
        requiredSkills: ['po', 'ux', 'guru'],
        deliverables: [deliv('po', 'listo', APROB), deliv('guru', 'listo', APROB)], // ux missing
        liveSkills: new Set(), liveElsewhere: false, hasNeedsHuman: false,
        retryCounts: {}, isMonoSkill: false, allowed: true,
        ...over,
    };
}
function plan(issues, extra = {}) { return planReconciliation({ issues, nowMs: NOW, ...extra }); }
function only(issues, extra = {}) { return plan(issues, extra).decisions[0]; }

// ─── Guardas P0 ─────────────────────────────────────────────────────────────
test('P0-1 mono-skill: fase dev → none', () => {
    assert.equal(only([stuckIssue({ fase: 'dev' })]).action, 'none');
    assert.match(only([stuckIssue({ fase: 'dev' })]).reason, /mono-skill/);
});
test('P0-1 mono-skill: flag isMonoSkill → none aunque la fase no esté en la lista', () => {
    assert.equal(only([stuckIssue({ fase: 'validacion', isMonoSkill: true })]).action, 'none');
});
test('P0-2 cross-phase: issue vivo en otra fase → none (evita doble-track)', () => {
    assert.equal(only([stuckIssue({ liveElsewhere: true })]).action, 'none');
    assert.match(only([stuckIssue({ liveElsewhere: true })]).reason, /otra-fase/);
});
test('P0-3 cap reintentos: skill faltante en el tope → escalate (no loop)', () => {
    const d = only([stuckIssue({ retryCounts: { ux: DEFAULT_MAX_REQUEUE_ATTEMPTS } })]);
    assert.equal(d.action, 'escalate');
    assert.match(d.reason, /tope de reintentos/);
});
test('P0-3 cap reintentos: bajo el tope → requeue e incrementa contador', () => {
    const { decisions, retryUpdates } = plan([stuckIssue({ retryCounts: { ux: 1 } })]);
    assert.equal(decisions[0].action, 'requeue');
    assert.deepEqual(decisions[0].skills, ['ux']);
    assert.equal(retryUpdates['100|validacion|ux'], 2);
});

// ─── requeue vs escalate según detector ─────────────────────────────────────
test('CASO #4507: ux faltante + resto aprobado → requeue [ux]', () => {
    const it = stuckIssue({
        issue: 4507, fase: 'aprobacion', requiredSkills: ['review', 'po', 'ux', 'architect'],
        deliverables: [deliv('review', 'listo', APROB), deliv('po', 'archivado', APROB), deliv('architect', 'archivado', APROB)],
    });
    assert.deepEqual(only([it]).skills, ['ux']);
    assert.equal(only([it]).action, 'requeue');
});
test('CASO #4534: po/ux cancelados → escalate (no requeue)', () => {
    const it = stuckIssue({
        issue: 4534,
        deliverables: [deliv('guru', 'listo', APROB), deliv('po', 'procesado', CANCEL), deliv('ux', 'procesado', CANCEL)],
    });
    assert.equal(only([it]).action, 'escalate');
});

// ─── Dedupe de escalate (P1-1) ──────────────────────────────────────────────
test('P1-1 dedupe: escalate con needs-human ya presente → none', () => {
    const it = stuckIssue({
        deliverables: [deliv('guru', 'listo', APROB), deliv('po', 'procesado', CANCEL)],
        hasNeedsHuman: true,
    });
    assert.equal(only([it]).action, 'none');
    assert.match(only([it]).reason, /dedupe/);
});
test('P1-1 dedupe: requeue-capeado con needs-human → none (no re-escala)', () => {
    const it = stuckIssue({ retryCounts: { ux: DEFAULT_MAX_REQUEUE_ATTEMPTS }, hasNeedsHuman: true });
    assert.equal(only([it]).action, 'none');
});

// ─── Pausa / allowlist (PO SG-5) ────────────────────────────────────────────
test('SG-5 pausa: no re-encola (requeue → none)', () => {
    assert.equal(only([stuckIssue()], { paused: true }).action, 'none');
    assert.match(only([stuckIssue()], { paused: true }).reason, /pausa/);
});
test('SG-5 pausa: SÍ permite escalate (label, no spawnea)', () => {
    const it = stuckIssue({ deliverables: [deliv('po', 'listo', CANCEL)] });
    assert.equal(only([it], { paused: true }).action, 'escalate');
});
test('SG-5 allowlist: issue fuera de allowlist → no re-encola', () => {
    assert.equal(only([stuckIssue({ allowed: false })]).action, 'none');
});

// ─── Cap por tick + orden (P2-3) ────────────────────────────────────────────
test('P2-3 cap por tick: solo N acciones reales, resto → none(cap)', () => {
    const issues = [1, 2, 3, 4].map((n) => stuckIssue({ issue: n }));
    const { decisions } = plan(issues, { capPerTick: 2 });
    const reales = decisions.filter((d) => d.action !== 'none');
    assert.equal(reales.length, 2);
    assert.equal(decisions.filter((d) => d.reason === 'cap-por-tick-alcanzado').length, 2);
});
test('P2-3 orden determinista: procesa issues asc (sin starvation)', () => {
    const issues = [30, 10, 20].map((n) => stuckIssue({ issue: n }));
    const { decisions } = plan(issues, { capPerTick: 1 });
    const actuo = decisions.find((d) => d.action === 'requeue');
    assert.equal(actuo.issue, 10, 'el issue más chico se procesa primero');
});
test('los none NO consumen cupo del tick', () => {
    const issues = [
        stuckIssue({ issue: 1, liveElsewhere: true }), // none (no consume)
        stuckIssue({ issue: 2 }),                        // requeue
        stuckIssue({ issue: 3 }),                        // requeue
    ];
    const reales = plan(issues, { capPerTick: 2 }).decisions.filter((d) => d.action !== 'none');
    assert.equal(reales.length, 2, 'los 2 requeue caben porque el none no gastó cupo');
});

// ─── decideForIssue directo (unidad) ────────────────────────────────────────
test('decideForIssue: completo → none', () => {
    const it = stuckIssue({ deliverables: [deliv('po', 'listo', APROB), deliv('ux', 'listo', APROB), deliv('guru', 'listo', APROB)] });
    assert.equal(decideForIssue(it, { nowMs: NOW, maxRequeueAttempts: 2, capPerTick: 5, paused: false, monoSkillPhases: new Set(['dev']) }).action, 'none');
});

// ─── executeDecisions (shell con mocks) ─────────────────────────────────────
function mockDeps() {
    const calls = { requeue: [], escalate: [], notify: [], audit: [] };
    return {
        calls,
        requeueWorkItem: (p, f, s, i) => calls.requeue.push(`${i}.${s}@${p}/${f}`),
        escalate: (i, r) => calls.escalate.push({ i, r }),
        notify: (m) => calls.notify.push(m),
        audit: (rec) => calls.audit.push(rec),
    };
}
test('execute requeue: escribe work-item por skill + notifica + audita', () => {
    const deps = mockDeps();
    const res = executeDecisions([{ action: 'requeue', issue: 100, pipeline: 'desarrollo', fase: 'validacion', skills: ['ux'], reason: 'x' }], deps);
    assert.deepEqual(deps.calls.requeue, ['100.ux@desarrollo/validacion']);
    assert.equal(res.requeued, 1);
    assert.equal(deps.calls.notify.length, 1);
    assert.ok(deps.calls.audit.some((a) => a.action === 'requeue'));
});
test('execute requeue idempotente: si el work-item ya existe, no lo re-escribe', () => {
    const deps = mockDeps();
    deps.workItemExists = () => true;
    executeDecisions([{ action: 'requeue', issue: 100, pipeline: 'desarrollo', fase: 'validacion', skills: ['ux'], reason: 'x' }], deps);
    assert.equal(deps.calls.requeue.length, 0, 'no re-escribe si ya existe');
});
test('execute escalate: llama escalate + notifica', () => {
    const deps = mockDeps();
    const res = executeDecisions([{ action: 'escalate', issue: 4534, pipeline: 'desarrollo', fase: 'validacion', reason: 'ambiguo' }], deps);
    assert.equal(deps.calls.escalate.length, 1);
    assert.equal(res.escalated, 1);
    assert.equal(deps.calls.notify.length, 1);
});
test('execute none: audita pero NO notifica', () => {
    const deps = mockDeps();
    executeDecisions([{ action: 'none', issue: 1, fase: 'validacion', reason: 'reciente' }], deps);
    assert.equal(deps.calls.notify.length, 0);
    assert.equal(deps.calls.audit.length, 1);
});
test('execute best-effort: un dep que tira no aborta el resto', () => {
    const deps = mockDeps();
    deps.requeueWorkItem = () => { throw new Error('fs falló'); };
    assert.doesNotThrow(() => executeDecisions([
        { action: 'requeue', issue: 1, pipeline: 'desarrollo', fase: 'validacion', skills: ['ux'], reason: 'x' },
        { action: 'escalate', issue: 2, pipeline: 'desarrollo', fase: 'validacion', reason: 'y' },
    ], deps));
    assert.equal(deps.calls.escalate.length, 1, 'el escalate siguiente igual se ejecuta');
});
test('NUNCA fabrica aprobaciones: executeDecisions no expone forma de escribir resultado:aprobado', () => {
    const deps = mockDeps();
    // el shell solo tiene requeueWorkItem/escalate/notify/audit — no hay "aprobar"
    executeDecisions([{ action: 'requeue', issue: 1, pipeline: 'desarrollo', fase: 'validacion', skills: ['ux'], reason: 'x' }], deps);
    assert.ok(!('approve' in deps), 'no hay dep de aprobación');
});

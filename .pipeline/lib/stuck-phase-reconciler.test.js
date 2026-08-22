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
        retryCounts: {}, isMonoSkill: false, allowed: true, active: true,
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
test('allowlist: issue fuera de allowlist (requeue) → none (backlog dormido)', () => {
    const d = only([stuckIssue({ allowed: false })]);
    assert.equal(d.action, 'none');
    assert.match(d.reason, /allowlist/);
});
test('allowlist: issue fuera de allowlist que ESCALARÍA → none (no spamea backlog)', () => {
    const it = stuckIssue({ allowed: false, deliverables: [deliv('po', 'listo', CANCEL)] });
    assert.equal(only([it]).action, 'none', 'ni siquiera escala si está fuera de la ola');
});
test('issue CERRADO (active=false) → none (residuo, no tocar)', () => {
    const it = stuckIssue({ active: false, deliverables: [deliv('po', 'listo', CANCEL)] });
    assert.equal(only([it]).action, 'none');
    assert.match(only([it]).reason, /cerrado/);
});
test('issue con active undefined → none (desconocido = no tocar)', () => {
    const it = stuckIssue({ active: undefined });
    assert.equal(only([it]).action, 'none', 'sin confirmación de OPEN, no actúa');
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
test('execute escalate: si no registra el bloqueo, no contabiliza ni notifica', () => {
    const deps = mockDeps();
    deps.escalate = () => false;
    const res = executeDecisions([{ action: 'escalate', issue: 4534, pipeline: 'desarrollo', fase: 'validacion', reason: 'ambiguo' }], deps);
    assert.equal(res.escalated, 0);
    assert.equal(res.skipped, 1);
    assert.equal(deps.calls.notify.length, 0);
    assert.ok(deps.calls.audit.some((a) => a.error === 'no se pudo registrar el bloqueo humano'));
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

// ═══════════════════════════════════════════════════════════════════════════
// #5641 — carril de infra: presupuesto, ambigüedad, auditoría y textos
// ═══════════════════════════════════════════════════════════════════════════

const {
    ambiguousSkillsOf, AMBIGUOUS_STATUSES,
    buildEscalationMessage, buildEscalationQuestion, buildEscalationRecommendation,
    CAUSE_INFRA_EXHAUSTED,
} = require('./stuck-phase-reconciler');

const INFRA = {
    resultado: 'rechazado',
    motivo: 'Agente terminó con código 1',
    veredicto_sintetizado_por: 'pulpo',
    agente_exit_code: 1,
};
const DRENADO = (porQuien = 'po') => ({
    cancelado_por: 'fast-fail-rebote',
    cancelado_ts: 'x',
    cancelado_disparado_por: porQuien,
    cancelado_disparador_infra: true,
});
// Issue con el shape real de #5175 en fase paralela.
function infraIssue(over = {}) {
    return stuckIssue({
        fase: 'aprobacion',
        requiredSkills: ['po', 'review', 'ux', 'architect'],
        deliverables: [
            deliv('po', 'procesado', INFRA),
            deliv('review', 'procesado', DRENADO('po')),
            deliv('ux', 'procesado', DRENADO('po')),
            deliv('architect', 'procesado', APROB),
        ],
        ...over,
    });
}

// ─── R-1: los dos gates ven lo mismo ───────────────────────────────────────
test('R-1 ambiguousSkillsOf sobre el shape de #5175 → [] (no diverge del detector)', () => {
    // Si esta función siguiera clasificando skill por skill vería `cancelled`
    // donde el detector ya ve `missing`, y el marker se plantaría con skills que
    // el detector considera re-encolables: los dos gates divergirían.
    assert.deepEqual(ambiguousSkillsOf(infraIssue()), []);
});
test('R-1 ambiguousSkillsOf sigue detectando un rechazo de contenido real', () => {
    const it = infraIssue({
        deliverables: [
            deliv('po', 'procesado', { resultado: 'rechazado', motivo: 'CA-2 incumplido' }),
            deliv('review', 'procesado', DRENADO('po')),
            deliv('ux', 'procesado', APROB),
            deliv('architect', 'procesado', APROB),
        ],
    });
    assert.deepEqual(ambiguousSkillsOf(it), ['po', 'review']);
});
test('CA-16 AMBIGUOUS_STATUSES no contiene infra-failed', () => {
    assert.ok(!AMBIGUOUS_STATUSES.has('infra-failed'),
        'infra-failed no es un veredicto ambiguo: es la AUSENCIA de veredicto');
    assert.deepEqual([...AMBIGUOUS_STATUSES].sort(), ['cancelled', 'corrupt', 'rejected']);
});

// ─── CA-10 / CA-UX-2: el carril de requeue por infra ───────────────────────
test('CA-10 #5175 → requeue de po,review,ux sin needs-human', () => {
    const d = only([infraIssue()]);
    assert.equal(d.action, 'requeue');
    assert.deepEqual(d.skills, ['po', 'review', 'ux']);
});
test('CA-UX-2 el reason trae el contador de intento (el operador ve venir la escalación)', () => {
    assert.match(only([infraIssue()]).reason, /· intento 1\/2$/);
    const d = only([infraIssue({ retryCounts: { po: 1 } })]);
    assert.match(d.reason, /· intento 2\/2$/);
});
test('CA-UX-2 el requeue de skills faltantes NO recibe contador (no-regresión)', () => {
    const d = only([stuckIssue()]); // ux missing, sin infra
    assert.equal(d.reason, 're-encolar skills faltantes (nunca corrieron): ux');
    assert.equal(d.cause, undefined);
});

// ─── CA-13 / CA-14: presupuesto ────────────────────────────────────────────
test('CA-13/CA-14 presupuesto agotado → escalate con motivo explícito de infra', () => {
    const d = only([infraIssue({ retryCounts: { po: DEFAULT_MAX_REQUEUE_ATTEMPTS } })]);
    assert.equal(d.action, 'escalate');
    assert.match(d.reason, /presupuesto de reintentos por infra \(2\)/);
    assert.equal(d.cause, CAUSE_INFRA_EXHAUSTED);
});
test('CA-16 el escalate por presupuesto lleva lista de skills NO vacía', () => {
    const d = only([infraIssue({ retryCounts: { po: DEFAULT_MAX_REQUEUE_ATTEMPTS } })]);
    assert.ok(Array.isArray(d.skills) && d.skills.length > 0,
        'sin skills el marker no tendría dispatch al destrabar (ruido por tick de #5396)');
    assert.deepEqual(d.skills, ['po']);
});
test('CA-13 el corte es maxRequeueAttempts, configurable desde el call site', () => {
    const d = only([infraIssue({ retryCounts: { po: 1 } })], { maxRequeueAttempts: 1 });
    assert.equal(d.action, 'escalate');
    assert.match(d.reason, /presupuesto de reintentos por infra \(1\)/);
});
test('CA-13 no se cablea MAX_REBOTES_INFRA: el reconciler no lo menciona', () => {
    const fs = require('fs'); const path = require('path');
    for (const f of ['stuck-phase-detector.js', 'stuck-phase-reconciler.js']) {
        const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
        assert.ok(!/MAX_REBOTES_INFRA/.test(src), `${f} no debe cablear MAX_REBOTES_INFRA (default 20)`);
    }
});
test('el escalate genérico por tope conserva su texto (no-regresión)', () => {
    const d = only([stuckIssue({ retryCounts: { ux: DEFAULT_MAX_REQUEUE_ATTEMPTS } })]);
    assert.match(d.reason, /tope de reintentos/);
    assert.equal(d.cause, undefined);
});

// ─── CA-15: contadores ─────────────────────────────────────────────────────
test('CA-15 retryUpdates usa la clave issue|fase|skill y no toca contadores de código', () => {
    const { retryUpdates } = plan([infraIssue()]);
    assert.deepEqual(retryUpdates, {
        '100|aprobacion|po': 1,
        '100|aprobacion|review': 1,
        '100|aprobacion|ux': 1,
    });
    const claves = Object.keys(retryUpdates).join(' ');
    assert.ok(!/rebote_numero(?!_infra)/.test(claves), 'no incrementa el contador de rebotes de código');
});
test('CA-15 el contador de infra respeta el valor previo de cada skill', () => {
    const { retryUpdates } = plan([infraIssue({ retryCounts: { po: 1 } })]);
    assert.equal(retryUpdates['100|aprobacion|po'], 2);
    assert.equal(retryUpdates['100|aprobacion|ux'], 1);
});

// ─── CA-17: auditoría ──────────────────────────────────────────────────────
test('CA-17 el audit del requeue por infra trae exit code y contador antes/después', () => {
    const deps = mockDeps();
    executeDecisions(plan([infraIssue()]).decisions, deps);
    const rec = deps.calls.audit.find((a) => a.action === 'requeue');
    assert.ok(rec, 'hay registro de requeue');
    assert.equal(rec.agente_exit_code, 1);
    assert.deepEqual(rec.infra_skills, ['po']);
    assert.deepEqual(rec.drenados_por_fast_fail, ['review', 'ux']);
    assert.equal(rec.reintentos_antes, 0);
    assert.equal(rec.reintentos_despues, 1);
    assert.equal(rec.max_reintentos, 2);
    assert.equal(rec.rebote_numero_infra, 1, 'contador de auditoría (CA-15)');
});
test('CA-17 el audit del escalate por presupuesto trae la causa y el exit code', () => {
    const deps = mockDeps();
    executeDecisions(plan([infraIssue({ retryCounts: { po: 2 } })]).decisions, deps);
    const rec = deps.calls.audit.find((a) => a.action === 'escalate');
    assert.equal(rec.cause, CAUSE_INFRA_EXHAUSTED);
    assert.equal(rec.agente_exit_code, 1);
    assert.equal(rec.reintentos_agotados, 2);
});
test('CA-17 el audit del requeue genérico no inventa campos de infra', () => {
    const deps = mockDeps();
    executeDecisions(plan([stuckIssue()]).decisions, deps);
    const rec = deps.calls.audit.find((a) => a.action === 'requeue');
    assert.equal(rec.cause, null);
    assert.ok(!('agente_exit_code' in rec));
});

// ─── CA-UX-3: volumen de notificaciones ────────────────────────────────────
test('CA-UX-3 tres skills re-encolados producen UNA sola notificación', () => {
    const deps = mockDeps();
    const res = executeDecisions(plan([infraIssue()]).decisions, deps);
    assert.equal(deps.calls.requeue.length, 3, 'se escriben los 3 work-items');
    assert.equal(deps.calls.notify.length, 1, 'pero un solo mensaje al operador (#5396)');
    assert.equal(res.requeued, 1);
    assert.match(deps.calls.notify[0], /re-encolé po,review,ux/);
});
test('CA-UX-3 un tick posterior con los work-items ya presentes no re-notifica de más', () => {
    const deps = mockDeps();
    deps.workItemExists = () => true; // el requeue anterior ya los escribió
    executeDecisions(plan([infraIssue()]).decisions, deps);
    assert.equal(deps.calls.requeue.length, 0, 'idempotente: no re-escribe');
});

// ─── CA-UX-1 / CA-UX-4: textos al operador ─────────────────────────────────
test('CA-UX-1 la pregunta de destrabe se deriva de la causa', () => {
    const d = {
        issue: 5175, pipeline: 'desarrollo', fase: 'aprobacion',
        cause: CAUSE_INFRA_EXHAUSTED,
        infra: { skills: ['po'], attempts: 2, max: 2, exitCodes: { po: 1 } },
    };
    const q = buildEscalationQuestion(d);
    assert.match(q, /El agente de po se cayó 2 veces seguidas \(exit code 1\)/);
    assert.match(q, /se agotó el presupuesto de reintentos automáticos/);
    assert.doesNotMatch(q, /rechazo \/ cancelado \/ corrupto/,
        'ofrecerle tres causas que no aplican es el peor modo de falla de una escalación');
});
test('CA-UX-1 no-regresión: las causas viejas conservan su texto', () => {
    const q = buildEscalationQuestion({ issue: 42, pipeline: 'desarrollo', fase: 'validacion' });
    assert.equal(q, '¿Cómo destrabo #42 en desarrollo/validacion? (rechazo / cancelado / corrupto)');
});
test('CA-UX-1 fuente única: el dep escalate consume buildEscalationQuestion', () => {
    const fs = require('fs'); const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, 'stuck-reconciler-deps.js'), 'utf8');
    assert.ok(/buildEscalationQuestion\(/.test(src), 'el call site del marker usa la función compartida');
    assert.ok(!/¿Cómo destrabo #\$\{n\}/.test(src), 'ya no hay texto hardcodeado duplicado');
});
test('CA-UX-4 la escalación por infra incluye la línea 💡 accionable', () => {
    const d = {
        issue: 5175, pipeline: 'desarrollo', fase: 'aprobacion', reason: 'presupuesto agotado',
        cause: CAUSE_INFRA_EXHAUSTED,
        infra: { skills: ['po'], attempts: 2, max: 2, exitCodes: { po: 1 } },
    };
    const msg = buildEscalationMessage(d, null);
    assert.match(msg, /💡 Revisá el log del agente po de #5175/);
    assert.match(msg, /cuota agotada o crash de arranque/);
});
test('CA-UX-4 sin recomendación la línea se omite entera (no "sin recomendación")', () => {
    const msg = buildEscalationMessage({ issue: 1, pipeline: 'desarrollo', fase: 'validacion', reason: 'ambigüedad' }, null);
    assert.ok(!msg.includes('💡'), 'nunca gastar un renglón para no decir nada (#5337)');
    assert.equal(buildEscalationRecommendation({ issue: 1 }), null);
});

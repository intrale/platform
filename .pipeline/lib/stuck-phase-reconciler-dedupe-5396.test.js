// =============================================================================
// stuck-phase-reconciler-dedupe-5396.test.js — #5396
//
// El self-healing de fases varadas re-escalaba y re-notificaba el MISMO issue
// cada 10 minutos: 36 notificaciones para 8 decisiones reales (78% de ruido).
// Dos defectos de cableado:
//   1. el dedupe miraba sólo señales TRANSITORIAS (cola de GitHub sin drenar);
//      drenada la cola, volvía a escalar en cada tick.
//   2. el filtro de ola sólo aplicaba bajo pausa parcial; fuera de pausa barría
//      todo el backlog histórico.
//
// Estos tests son PUROS (planReconciliation / executeDecisions), sin FS.
// El cableado real se verifica en `__tests__/stuck-reconciler-wiring-5396.test.js`.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
    planReconciliation,
    executeDecisions,
    buildEscalationMessage,
} = require('./stuck-phase-reconciler');

const HOUR = 3600000;
const NOW = 1_800_000_000_000;

/**
 * Issue varado "canónico": un skill entregó rechazo, el otro nunca entregó y no
 * hay trabajo vivo. El detector decide `escalate` (ambigüedad → humano).
 */
function stuckIssue(over = {}) {
    return {
        issue: 5209,
        pipeline: 'desarrollo',
        fase: 'verificacion',
        requiredSkills: ['qa', 'tester'],
        deliverables: [
            { skill: 'qa', state: 'listo', yaml: { resultado: 'rechazado' }, mtimeMs: NOW - HOUR },
        ],
        liveSkills: new Set(),
        liveElsewhere: false,
        hasNeedsHuman: false,
        needsHumanSource: null,
        retryCounts: {},
        allowed: true,
        active: true,
        ...over,
    };
}

function plan(issues) {
    return planReconciliation({ issues, nowMs: NOW, staleThresholdMs: 15 * 60 * 1000 });
}
function only(issues) {
    const { decisions } = plan(issues);
    assert.equal(decisions.length, 1, 'se esperaba una sola decisión');
    return decisions[0];
}

/** Shell de IO con spies; `escalate`/`notify` registran cada llamada. */
function spyDeps(over = {}) {
    const calls = { escalate: [], notify: [], requeue: [], audit: [] };
    return {
        calls,
        deps: {
            escalate: (issue, reason, meta) => calls.escalate.push({ issue, reason, meta }),
            notify: (msg, meta) => calls.notify.push({ msg, meta }),
            requeueWorkItem: (p, f, s, i) => calls.requeue.push({ p, f, s, i }),
            audit: (rec) => calls.audit.push(rec),
            ...over,
        },
    };
}

// -----------------------------------------------------------------------------
// CA-1 — el dedupe sobrevive al drenado de la cola
// -----------------------------------------------------------------------------

test('CA-1: issue ya escalado con marker y cola drenada → none con dedupe: marker, sin notificar', () => {
    const d = only([stuckIssue({ hasNeedsHuman: true, needsHumanSource: 'marker' })]);
    assert.equal(d.action, 'none');
    assert.equal(d.reason, 'ya-escalado (dedupe: marker)');
    assert.equal(d.suppression, 'dedupe');

    const { calls, deps } = spyDeps();
    const res = executeDecisions([d], deps);
    assert.equal(calls.notify.length, 0, 'un issue ya escalado NO debe re-notificar');
    assert.equal(calls.escalate.length, 0);
    assert.equal(res.suppressed.dedupe, 1);
});

test('CA-1: el origen de la supresión queda explícito para cada fuente', () => {
    for (const src of ['marker', 'cola', 'cache-label']) {
        const d = only([stuckIssue({ hasNeedsHuman: true, needsHumanSource: src })]);
        assert.equal(d.reason, `ya-escalado (dedupe: ${src})`, `fuente ${src}`);
        assert.equal(d.suppression, 'dedupe');
    }
});

test('CA-1: dep legacy que devuelve boolean sigue deduplicando (compat)', () => {
    // `needsHumanSource: null` = dep viejo. No debe escalar igual.
    const d = only([stuckIssue({ hasNeedsHuman: true, needsHumanSource: null })]);
    assert.equal(d.action, 'none');
    assert.match(d.reason, /dedupe/);
});

// -----------------------------------------------------------------------------
// CA-2 — fail-closed ante caché desconocida o vencida
// -----------------------------------------------------------------------------

test('CA-2: caché ausente o stale → none con razón cache-desconocida, sin notificar', () => {
    const d = only([stuckIssue({ hasNeedsHuman: true, needsHumanSource: 'cache-desconocida' })]);
    assert.equal(d.action, 'none');
    assert.equal(d.reason, 'cache-desconocida');
    assert.equal(d.suppression, 'cache', 'se contabiliza aparte del dedupe legítimo');

    const { calls } = (() => {
        const s = spyDeps();
        executeDecisions([d], s.deps);
        return s;
    })();
    assert.equal(calls.notify.length, 0, 'fail-closed va hacia el SILENCIO, no hacia el ruido');
});

test('CA-2: la caché nunca habilita un escalado — sólo suprime de más', () => {
    // `false` = entrada FRESCA que explícitamente NO tiene el label → sí escala.
    const escala = only([stuckIssue({ hasNeedsHuman: false, needsHumanSource: null })]);
    assert.equal(escala.action, 'escalate');
    // Cualquier string (incluida la desconocida) suprime.
    const suprime = only([stuckIssue({ hasNeedsHuman: true, needsHumanSource: 'cache-desconocida' })]);
    assert.equal(suprime.action, 'none');
});

test('CA-2: el tope de reintentos también respeta el fail-closed de caché', () => {
    const d = only([stuckIssue({
        requiredSkills: ['qa'],
        deliverables: [{ skill: 'qa', state: 'listo', yaml: { resultado: 'rechazado' }, mtimeMs: NOW - HOUR }],
        retryCounts: { qa: 99 },
        hasNeedsHuman: true,
        needsHumanSource: 'cache-desconocida',
    })]);
    assert.equal(d.action, 'none');
    assert.equal(d.suppression, 'cache');
});

// -----------------------------------------------------------------------------
// CA-3 — filtro de ola siempre activo
// -----------------------------------------------------------------------------

test('CA-3: issue varado fuera de la allowlist → none por ola, sin notificar', () => {
    const d = only([stuckIssue({ issue: 742, allowed: false })]);
    assert.equal(d.action, 'none');
    assert.match(d.reason, /^fuera-de-allowlist/);
    assert.equal(d.suppression, 'ola');

    const { calls, deps } = spyDeps();
    const res = executeDecisions([d], deps);
    assert.equal(calls.notify.length, 0, 'el residuo fuera de ola no molesta al operador');
    assert.equal(res.suppressed.ola, 1);
});

test('CA-3: el filtro de ola gana sobre cualquier análisis del detector', () => {
    // Aunque el issue esté perfectamente varado, fuera de ola no se toca.
    const d = only([stuckIssue({ allowed: false, hasNeedsHuman: false })]);
    assert.equal(d.action, 'none');
    assert.equal(d.suppression, 'ola');
});

// -----------------------------------------------------------------------------
// CA-4 — escalada única dentro de la ola
// -----------------------------------------------------------------------------

test('CA-4: issue varado de la ola escala UNA vez y el tick siguiente calla', () => {
    // Tick 1: sin marker todavía.
    const t1 = only([stuckIssue()]);
    assert.equal(t1.action, 'escalate');

    const s1 = spyDeps();
    executeDecisions([t1], s1.deps);
    assert.equal(s1.calls.escalate.length, 1);
    assert.equal(s1.calls.notify.length, 1, 'exactamente UNA notificación');

    // Tick 2: `escalate` plantó el marker → el dep lo reporta.
    const t2 = only([stuckIssue({ hasNeedsHuman: true, needsHumanSource: 'marker' })]);
    assert.equal(t2.action, 'none');

    const s2 = spyDeps();
    executeDecisions([t2], s2.deps);
    assert.equal(s2.calls.notify.length, 0, 'el segundo tick NO vuelve a notificar');
});

// -----------------------------------------------------------------------------
// CA-6 — escalar no destruye evidencia (contrato del shell)
// -----------------------------------------------------------------------------

test('CA-6: executeDecisions pasa pipeline y fase explícitos a escalate', () => {
    // Sin `pipeline` explícito, `reportHumanBlock` buscaría el work-item activo
    // y MOVERÍA el deliverable de `listo/` — la evidencia que el detector usa.
    const d = only([stuckIssue()]);
    const { calls, deps } = spyDeps();
    executeDecisions([d], deps);

    assert.equal(calls.escalate.length, 1);
    assert.deepEqual(calls.escalate[0].meta, { pipeline: 'desarrollo', fase: 'verificacion' });
});

// -----------------------------------------------------------------------------
// CA-7 / SEC-3 — el silencio es observable
// -----------------------------------------------------------------------------

test('CA-7: el agregado del tick distingue las tres causas de supresión', () => {
    const { decisions } = plan([
        stuckIssue({ issue: 742, allowed: false }),                                          // ola
        stuckIssue({ issue: 1094, allowed: false }),                                         // ola
        stuckIssue({ issue: 5209, hasNeedsHuman: true, needsHumanSource: 'cache-desconocida' }), // cache
        stuckIssue({ issue: 5211, hasNeedsHuman: true, needsHumanSource: 'marker' }),         // dedupe
        stuckIssue({ issue: 5242, active: false }),                                          // cerrado
    ]);
    const { deps } = spyDeps();
    const res = executeDecisions(decisions, deps);

    assert.equal(res.evaluados, 5);
    assert.equal(res.escalated, 0);
    assert.equal(res.requeued, 0);
    assert.deepEqual(res.suppressed, { ola: 2, cache: 1, dedupe: 1, cerrado: 1, otro: 0 });
});

test('CA-7: un tick con evaluados > 0 y cero acciones deja rastro auditable', () => {
    const d = only([stuckIssue({ allowed: false })]);
    const { calls, deps } = spyDeps();
    const res = executeDecisions([d], deps);

    assert.equal(res.evaluados, 1);
    assert.equal(res.escalated + res.requeued, 0);
    const rec = calls.audit.find((r) => r && r.action === 'none');
    assert.ok(rec, 'el `none` se audita aunque no notifique');
    assert.equal(rec.suppression, 'ola', 'la causa del silencio queda en el registro');
});

test('CA-7: tick sin issues devuelve el agregado en cero (no undefined)', () => {
    const { deps } = spyDeps();
    const res = executeDecisions([], deps);
    assert.equal(res.evaluados, 0);
    assert.deepEqual(res.suppressed, { ola: 0, cache: 0, dedupe: 0, cerrado: 0, otro: 0 });
});

// -----------------------------------------------------------------------------
// CA-UX-2 / CA-8 — el mensaje de escalación
// -----------------------------------------------------------------------------

test('CA-UX-2: el mensaje trae número, título, fase y la pregunta de destrabe', () => {
    const msg = buildEscalationMessage(
        { issue: 5209, pipeline: 'desarrollo', fase: 'verificacion', reason: 'ambigüedad' },
        'fix(pipeline): algo que se varó',
    );
    assert.match(msg, /#5209/);
    assert.match(msg, /fix\(pipeline\): algo que se varó/);
    assert.match(msg, /desarrollo\/verificacion/);
    assert.match(msg, /¿Cómo destrabo #5209\?/);
    assert.ok(msg.split('\n').length >= 4, 'estructura por saltos de línea, no por Markdown');
});

test('CA-UX-2: sin título fresco en caché el mensaje sale igual (no inventa)', () => {
    const msg = buildEscalationMessage(
        { issue: 742, pipeline: 'desarrollo', fase: 'verificacion', reason: 'ambigüedad' },
        null,
    );
    assert.match(msg, /#742/);
    assert.ok(!msg.includes('📌'), 'no emite línea de título vacía');
});

test('CA-8: el mensaje no usa sintaxis Markdown para estructurar', () => {
    const msg = buildEscalationMessage(
        { issue: 5209, pipeline: 'desarrollo', fase: 'verificacion', reason: 'skill `raro`' },
        'titulo',
    );
    assert.ok(!/\*\*|__|\[.+\]\(.+\)/.test(msg), 'sin negritas ni links Markdown');
});

test('CA-8: el reason se normaliza a una línea (viene de un nombre de archivo)', () => {
    const msg = buildEscalationMessage(
        { issue: 5209, pipeline: 'desarrollo', fase: 'verificacion', reason: 'linea1\nlinea2\n\nlinea3' },
        null,
    );
    const infoLine = msg.split('\n').find((l) => l.startsWith('ℹ️'));
    assert.equal(infoLine, 'ℹ️ linea1 linea2 linea3');
});

test('el título se usa sólo si `issueTitle` lo provee (dep opcional)', () => {
    const d = only([stuckIssue()]);
    const s = spyDeps();
    executeDecisions([d], { ...s.deps, issueTitle: () => 'Titulo desde caché fresca' });
    assert.match(s.calls.notify[0].msg, /Titulo desde caché fresca/);
});

test('un `issueTitle` que tira no rompe la notificación', () => {
    const d = only([stuckIssue()]);
    const s = spyDeps();
    executeDecisions([d], { ...s.deps, issueTitle: () => { throw new Error('cache rota'); } });
    assert.equal(s.calls.notify.length, 1, 'igual notifica: mejor sin título que sin alerta');
});

// -----------------------------------------------------------------------------
// Línea roja (PO) — el fix es sobre a quién se avisa, nunca sobre auto-resolver
// -----------------------------------------------------------------------------

test('línea roja: ninguna supresión produce una acción de aprobación', () => {
    const { decisions } = plan([
        stuckIssue({ issue: 742, allowed: false }),
        stuckIssue({ issue: 5209, hasNeedsHuman: true, needsHumanSource: 'cache-desconocida' }),
    ]);
    for (const d of decisions) {
        assert.equal(d.action, 'none', 'suprimir = callarse, nunca completar la fase');
        assert.ok(!('resultado' in d));
    }
});

// -----------------------------------------------------------------------------
// #5396 — un bloqueo humano vigente gana sobre el re-encolado
//
// Antes de este issue el dedupe sólo cubría el carril `escalate`: `escalate`
// encolaba el label y casi nunca existía un marker físico, así que el carril
// `requeue` con bloqueo vivo era teórico. Ahora `escalate` planta marker vía
// `reportHumanBlock` con `moveFromActive: false` — el deliverable sigue en
// `listo/` y el issue se sigue evaluando tick a tick —, y `bloqueado-humano/`
// no es ni deliverable-state ni live-state para el runner. Resultado: un issue
// esperando decisión humana podía re-encolarse y spawnear un agente encima.
// -----------------------------------------------------------------------------

/**
 * Issue varado cuyo análisis da `requeue` (no `escalate`): `qa` entregó aprobado
 * hace rato y `tester` nunca corrió. Sin ambigüedad ⇒ el detector re-encola el
 * faltante, que es el único caso de auto-remediación que la línea roja permite.
 */
function requeueIssue(over = {}) {
    return stuckIssue({
        deliverables: [
            { skill: 'qa', state: 'listo', yaml: { resultado: 'aprobado' }, mtimeMs: NOW - HOUR },
        ],
        ...over,
    });
}

test('sanity: sin bloqueo humano, el skill faltante SÍ se re-encola', () => {
    const d = only([requeueIssue()]);
    assert.equal(d.action, 'requeue', 'el carril requeue debe seguir vivo (si no, el test de abajo no prueba nada)');
    assert.deepEqual(d.skills, ['tester']);
});

test('#5396: issue con marker de bloqueo humano NO se re-encola (none, dedupe)', () => {
    const d = only([requeueIssue({ hasNeedsHuman: true, needsHumanSource: 'marker' })]);
    assert.equal(d.action, 'none', 'un issue esperando decisión humana no se toca');
    assert.equal(d.reason, 'bloqueado-humano (dedupe: marker)');
    assert.equal(d.suppression, 'dedupe');
});

test('#5396: el bloqueo bloquea el requeue también con la caché desconocida (fail-closed)', () => {
    const d = only([requeueIssue({ hasNeedsHuman: true, needsHumanSource: 'cache-desconocida' })]);
    assert.equal(d.action, 'none');
    assert.equal(d.reason, 'cache-desconocida');
    assert.equal(d.suppression, 'cache');
});

test('#5396: ejecutar la decisión no escribe work-item ni notifica', () => {
    const d = only([requeueIssue({ hasNeedsHuman: true, needsHumanSource: 'marker' })]);
    const s = spyDeps();
    const res = executeDecisions([d], s.deps);
    assert.equal(s.calls.requeue.length, 0, 'no spawnea agente sobre un issue bloqueado');
    assert.equal(s.calls.escalate.length, 0, 'ya estaba escalado: no re-escala');
    assert.equal(s.calls.notify.length, 0, 'y sobre todo no re-notifica');
    assert.equal(res.requeued, 0);
    assert.equal((res.suppressed || {}).dedupe, 1, 'queda contabilizado como supresión por dedupe');
});

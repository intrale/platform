// =============================================================================
// wizards/ola/index.test.js — Tests del flow "Crear nueva ola" (#3738).
//
// Cubre la lógica propia del flow: validateStep/executeStep, bounds server-side,
// elegibilidad, guard anti-TOCTOU (snapshot) y la integración audit-then-apply
// con `waves.createPlannedWave`. Las garantías de la base (CSRF, Sec-Fetch,
// idempotencia, timeout 15min → 410) las cubre wizard-session.test.js — acá no
// se re-testean porque NO viven en esta capa.
//
// Aislamiento total: el flow recibe un `waves` fake vía `_setForTests`, así que
// no toca `waves.json` ni los logs reales. El audit también es un fake que
// captura las entradas en memoria.
//
// Ejecutar:  node --test .pipeline/lib/wizards/ola/__tests__/index.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ola = require('../index');

// --- Fakes -------------------------------------------------------------------

function makeFakeWaves(opts = {}) {
    const state = {
        active_wave: opts.active || null,
        planned_waves: opts.planned || [],
        archived_waves: opts.archived || [],
    };
    const created = [];
    return {
        state,
        created,
        // Bounds reusados por el flow.
        WAVE_NAME_MAX_LEN: 80,
        WAVE_WINDOW_MIN_MINUTES: 5,
        WAVE_WINDOW_MAX_MINUTES: 1440,
        readWaveMaxConcurrency: () => opts.maxConcurrency || 10,
        loadWaves: () => JSON.parse(JSON.stringify(state)),
        createPlannedWave(spec, meta) {
            if (opts.throwOnCreate) {
                const e = new Error('forced'); e.code = opts.throwOnCreate; throw e;
            }
            const waveNumber = created.length + 1;
            created.push({ spec, meta, waveNumber });
            return { waveNumber, wave: { number: waveNumber, name: spec.name } };
        },
    };
}

function makeFakeAudit() {
    const entries = [];
    return {
        entries,
        appendChained({ entry }) { entries.push(entry); },
    };
}

function makeSession() {
    return { steps: new Map() };
}

function withFlow(opts, fn) {
    const waves = makeFakeWaves(opts);
    const audit = makeFakeAudit();
    ola._setForTests({ waves, audit, auditDir: opts.auditDir || '/tmp/__ola_test__' });
    try {
        return fn(waves, audit);
    } finally {
        ola._resetForTests();
    }
}

// --- validateStep ------------------------------------------------------------

test('validateStep step0 acepta issues elegibles y rechaza no enteros / vacío', () => {
    withFlow({}, () => {
        assert.equal(ola.validateStep(0, { issues: [3801, 3802] }), true);
        assert.equal(ola.validateStep(0, { issues: [] }), false);
        assert.equal(ola.validateStep(0, { issues: ['x', -1] }), false);
        assert.equal(ola.validateStep(0, {}), false);
    });
});

test('validateStep step0 rechaza issue ya ocupado en otra ola (elegibilidad)', () => {
    withFlow({ planned: [{ number: 5, name: 'Vieja', issues: [{ number: 3801 }] }] }, () => {
        // 3801 ya está en la ola planificada 5 → no elegible.
        assert.equal(ola.validateStep(0, { issues: [3801, 3802] }), false);
        // 3802/3803 sí elegibles.
        assert.equal(ola.validateStep(0, { issues: [3802, 3803] }), true);
    });
});

test('validateStep step1 valida bounds server-side y nombre único', () => {
    withFlow({ maxConcurrency: 8, planned: [{ number: 5, name: 'Tomado', issues: [] }] }, () => {
        const okBase = { name: 'Ola Nueva', concurrency_max: 3, window_minutes: 60 };
        assert.equal(ola.validateStep(1, okBase), true);
        // concurrencia fuera del techo (8).
        assert.equal(ola.validateStep(1, { ...okBase, concurrency_max: 999 }), false);
        assert.equal(ola.validateStep(1, { ...okBase, concurrency_max: 0 }), false);
        // ventana fuera de [5, 1440].
        assert.equal(ola.validateStep(1, { ...okBase, window_minutes: 0 }), false);
        assert.equal(ola.validateStep(1, { ...okBase, window_minutes: 99999 }), false);
        // nombre vacío y > 80.
        assert.equal(ola.validateStep(1, { ...okBase, name: '   ' }), false);
        assert.equal(ola.validateStep(1, { ...okBase, name: 'a'.repeat(81) }), false);
        // nombre con NUL byte.
        assert.equal(ola.validateStep(1, { ...okBase, name: 'mala\x00ola' }), false);
        // nombre duplicado (case-insensitive).
        assert.equal(ola.validateStep(1, { ...okBase, name: 'tomado' }), false);
    });
});

test('validateStep step2 exige confirm true y snapshot fresco (anti-TOCTOU)', () => {
    withFlow({ planned: [{ number: 5, name: 'X', issues: [{ number: 10 }] }] }, (waves) => {
        const snap = ola.stateSnapshot();
        assert.equal(ola.validateStep(2, { confirm: true, previous_snapshot: snap }), true);
        // confirm ausente.
        assert.equal(ola.validateStep(2, { previous_snapshot: snap }), false);
        // snapshot stale: simulamos una mutación posterior (otro issue ocupado).
        waves.state.planned_waves.push({ number: 6, name: 'Y', issues: [{ number: 20 }] });
        assert.equal(ola.validateStep(2, { confirm: true, previous_snapshot: snap }), false);
    });
});

// --- executeStep -------------------------------------------------------------

test('executeStep step0 normaliza issues; step1 produce preview + snapshot', async () => {
    await withFlow({}, async () => {
        const session = makeSession();
        const r0 = await ola.executeStep(session, 0, { issues: [3803, 3801, 3802, 3801] });
        session.steps.set(0, { status: 'ok', result: r0 });
        assert.deepEqual(r0.issues, [3801, 3802, 3803]);

        const r1 = await ola.executeStep(session, 1, { name: 'Ola N+9', concurrency_max: 3, window_minutes: 60 });
        session.steps.set(1, { status: 'ok', result: r1 });
        assert.equal(r1.name, 'Ola N+9');
        assert.equal(r1.preview.count, 3);
        assert.deepEqual(r1.preview.issues, [3801, 3802, 3803]);
        assert.ok(r1.previous_snapshot && Array.isArray(r1.previous_snapshot.occupied));
    });
});

test('executeStep step2 crea la ola y audita audit-then-apply (confirm → applied)', async () => {
    await withFlow({}, async (waves, audit) => {
        const session = makeSession();
        session.steps.set(0, { status: 'ok', result: { issues: [3801, 3802] } });
        session.steps.set(1, {
            status: 'ok',
            result: { name: 'Ola N+9', goal: null, concurrency_max: 2, window_minutes: 30, issues: [3801, 3802] },
        });
        const r2 = await ola.executeStep(session, 2, { confirm: true });
        assert.equal(r2.ok, true);
        assert.equal(r2.wave_id, 1);
        // createPlannedWave fue invocado con el spec correcto.
        assert.equal(waves.created.length, 1);
        assert.deepEqual(waves.created[0].spec.issues.map((i) => i.number), [3801, 3802]);
        assert.equal(waves.created[0].meta.source, 'dashboard:wizard:ola');
        // Audit: primero confirm (antes del apply), luego applied.
        const steps = audit.entries.map((e) => e.step);
        assert.deepEqual(steps, ['confirm', 'applied']);
        assert.equal(audit.entries[0].action, 'crear_ola');
        assert.deepEqual(audit.entries[0].issues_seleccionados, [3801, 3802]);
        assert.equal(audit.entries[1].wave_id_creado, 1);
    });
});

test('executeStep step2 audita apply_failed y propaga si createPlannedWave throwea', async () => {
    await withFlow({ throwOnCreate: 'EWAVES_DUPLICATE_ISSUE' }, async (waves, audit) => {
        const session = makeSession();
        session.steps.set(0, { status: 'ok', result: { issues: [3801] } });
        session.steps.set(1, {
            status: 'ok',
            result: { name: 'Ola', goal: null, concurrency_max: 1, window_minutes: 10, issues: [3801] },
        });
        await assert.rejects(() => ola.executeStep(session, 2, { confirm: true }), /forced|EWAVES/);
        const steps = audit.entries.map((e) => e.step);
        assert.deepEqual(steps, ['confirm', 'apply_failed']);
        assert.equal(audit.entries[1].error, 'EWAVES_DUPLICATE_ISSUE');
    });
});

test('executeStep step1 sin paso0 previo lanza precondition', async () => {
    await withFlow({}, async () => {
        const session = makeSession();
        await assert.rejects(
            () => ola.executeStep(session, 1, { name: 'X', concurrency_max: 1, window_minutes: 10 }),
            /precondition/,
        );
    });
});

test('flowDef expone maxStep 2 y registra el flow ola', () => {
    assert.equal(ola.flowDef.maxStep, 2);
    assert.equal(ola.FLOW, 'ola');
    // register es idempotente: el auto-registro ya corrió al require; un segundo
    // intento devuelve false (ya registrado) sin romper.
    const second = ola.register();
    assert.equal(typeof second, 'boolean');
});

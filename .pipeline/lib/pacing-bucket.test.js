// =============================================================================
// pacing-bucket.test.js — Tests del presupuesto de ritmo por proveedor (#4289)
//
// Cobertura (CA-1..CA-8):
//   - Acreditación: el crédito proporcional por hora SE ACUMULA (CA-1).
//   - Clasificación: yellow (adelantado con saldo), red (saldo agotado),
//     green (en ritmo) (CA-2/CA-3).
//   - Rotación semanal: cruzar el reset domingo-21:00-ART reinicia el bucket
//     sin arrastrar consumo (anclaje a weekly-quota.js).
//   - Recuperación: bucket recargado ⇒ vuelve a verde + limpia el disable (CA-4).
//   - Fail-open: estado corrupto/ausente ⇒ no de-prioriza ni apaga (CA-7).
//   - Distinción de origen: no re-habilita entradas con source ≠ pacing (CA-8).
//   - Rojo escribe provider-disabled con source 'pacing'.
//   - Kill-switch: enabled:false ⇒ evaluate es no-op.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pb = require('./pacing-bucket');
const wq = require('./weekly-quota');

const HOUR = 3600 * 1000;
const WEEK_MS = pb.WEEK_HOURS * HOUR;

// Timestamp determinista (no Date.now()): mié 2026-06-24 ~12:00 UTC.
const NOW0 = Date.parse('2026-06-24T12:00:00.000Z');
const WS = wq.getLastWeeklyResetMs(NOW0); // inicio de la semana ancla.

function freshBucket(provider = 'anthropic', quota = 100) {
    return pb.resetBucket(provider, WS, quota);
}

// Sandbox: dir temporal + provider-disabled fresco apuntado por override.
function withSandbox(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pacing-bucket-'));
    const prev = process.env.PIPELINE_DIR_OVERRIDE;
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    delete require.cache[require.resolve('./provider-disabled')];
    const disabled = require('./provider-disabled');
    try {
        fn({ dir, disabled });
    } finally {
        if (prev === undefined) delete process.env.PIPELINE_DIR_OVERRIDE;
        else process.env.PIPELINE_DIR_OVERRIDE = prev;
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
    }
}

// -----------------------------------------------------------------------------
// CA-1 — Acreditación proporcional acumulativa
// -----------------------------------------------------------------------------

test('accrue acredita crédito proporcional por hora (CA-1)', () => {
    const bucket = freshBucket('anthropic', 100);
    bucket.last_accrual_ms = WS;
    const after = pb.accrue(bucket, WS + 10 * HOUR);
    const expected = (100 / pb.WEEK_HOURS) * 10;
    assert.ok(Math.abs(after.accrued_credit - expected) < 1e-9,
        `accrued=${after.accrued_credit} esperado≈${expected}`);
    // El consumo NO se toca al acreditar.
    assert.equal(after.real_consumed, 0);
});

test('accrue acumula el saldo entre llamadas (día tranquilo deja saldo) (CA-1)', () => {
    const bucket = freshBucket('anthropic', 100);
    bucket.last_accrual_ms = WS;
    pb.accrue(bucket, WS + 5 * HOUR);
    const a1 = bucket.accrued_credit;
    pb.accrue(bucket, WS + 12 * HOUR); // +7 horas más
    const a2 = bucket.accrued_credit;
    assert.ok(a2 > a1, 'el crédito se acumula entre llamadas');
    const expected = (100 / pb.WEEK_HOURS) * 12;
    assert.ok(Math.abs(a2 - expected) < 1e-9);
});

test('accrue no acredita fracciones de hora (sólo horas completas)', () => {
    const bucket = freshBucket('anthropic', 100);
    bucket.last_accrual_ms = WS;
    const after = pb.accrue(bucket, WS + 30 * 60 * 1000); // 30 min
    assert.equal(after.accrued_credit, 0);
});

test('accrue cap-ea el crédito al cupo semanal completo', () => {
    const bucket = freshBucket('anthropic', 100);
    bucket.last_accrual_ms = WS;
    bucket.accrued_credit = 99; // ya cerca del tope
    const after = pb.accrue(bucket, WS + 10 * HOUR); // +~5.95 ⇒ supera 100
    assert.equal(after.accrued_credit, 100);
});

// -----------------------------------------------------------------------------
// CA-2 / CA-3 — Clasificación
// -----------------------------------------------------------------------------

test('classify: consumo real > esperado con crédito disponible ⇒ yellow (CA-2)', () => {
    const bucket = freshBucket('anthropic', 100);
    bucket.accrued_credit = 50;   // saldo disponible
    bucket.real_consumed = 40;    // balance = 10 > 0
    const now = WS + 0.2 * WEEK_MS; // esperado 20%, real 40% ⇒ adelantado
    assert.equal(pb.classify(bucket, now, { yellowMargin: 0.05 }), 'yellow');
});

test('classify: crédito acumulado agotado ⇒ red (CA-3)', () => {
    const bucket = freshBucket('anthropic', 100);
    bucket.accrued_credit = 20;
    bucket.real_consumed = 30;    // balance = -10 ⇒ rojo
    const now = WS + 0.2 * WEEK_MS;
    assert.equal(pb.classify(bucket, now, { yellowMargin: 0.05 }), 'red');
});

test('classify: en ritmo ⇒ green', () => {
    const bucket = freshBucket('anthropic', 100);
    bucket.accrued_credit = 50;
    bucket.real_consumed = 10;    // realRatio 0.10 < esperado 0.20 + margen
    const now = WS + 0.2 * WEEK_MS;
    assert.equal(pb.classify(bucket, now, { yellowMargin: 0.05 }), 'green');
});

test('classify: fail-open con cupo inválido ⇒ green (CA-7)', () => {
    assert.equal(pb.classify({ weekly_quota: 0, accrued_credit: 1, real_consumed: 5 }, WS), 'green');
    assert.equal(pb.classify(null, WS), 'green');
});

// -----------------------------------------------------------------------------
// Rotación semanal — anclaje a weekly-quota.js
// -----------------------------------------------------------------------------

test('accrue reinicia el bucket al rotar la semana sin arrastrar consumo', () => {
    const bucket = freshBucket('anthropic', 100);
    bucket.week_start_ms = WS - WEEK_MS; // semana anterior
    bucket.real_consumed = 80;
    bucket.accrued_credit = 90;
    bucket.state = 'red';
    const after = pb.accrue(bucket, NOW0); // getLastWeeklyResetMs(NOW0) === WS
    assert.equal(after.week_start_ms, WS, 'ancla a la semana vigente');
    assert.equal(after.real_consumed, 0, 'no arrastra consumo');
    assert.equal(after.accrued_credit, 0, 'crédito reiniciado');
    assert.equal(after.state, 'green');
});

// -----------------------------------------------------------------------------
// getPacingState — read-only, FAIL-OPEN (CA-7)
// -----------------------------------------------------------------------------

test('getPacingState: store ausente ⇒ green (fail-open, CA-7)', () => {
    withSandbox(({ dir }) => {
        assert.equal(pb.getPacingState('anthropic', { pipelineDir: dir, now: NOW0 }), 'green');
    });
});

test('getPacingState: store corrupto ⇒ green (fail-open, CA-7)', () => {
    withSandbox(({ dir }) => {
        const f = pb.stateFile(dir);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, '{ esto no es json válido', 'utf8');
        assert.equal(pb.getPacingState('anthropic', { pipelineDir: dir, now: NOW0 }), 'green');
    });
});

test('getPacingState: provider inválido ⇒ green', () => {
    assert.equal(pb.getPacingState('groq', { now: NOW0 }), 'green');
});

test('getPacingState lee el estado persistido del bucket', () => {
    withSandbox(({ dir }) => {
        const store = { schema_version: 1, providers: { anthropic: { state: 'yellow' } } };
        pb.saveStore(dir, store);
        assert.equal(pb.getPacingState('anthropic', { pipelineDir: dir, now: NOW0 }), 'yellow');
    });
});

// -----------------------------------------------------------------------------
// evaluate — transiciones, disable, recuperación
// -----------------------------------------------------------------------------

function sliceWith(pct, confidence = 'fresh') {
    return { providers: { anthropic: { weekly: { pct, confidence } } } };
}

const CFG_ON = { enabled: true, weeklyQuota: 100, yellowMargin: 0.05, ttlRedMin: 60 };

test('evaluate: kill-switch enabled:false ⇒ no-op', () => {
    withSandbox(({ dir, disabled }) => {
        const res = pb.evaluate({
            slice: sliceWith(90),
            config: { enabled: false, weeklyQuota: 100, yellowMargin: 0.05, ttlRedMin: 60 },
            pipelineDir: dir, now: NOW0, disabledModule: disabled,
            sendTelegram: () => {},
        });
        assert.equal(res.enabled, false);
        assert.equal(res.transitions.length, 0);
        assert.equal(fs.existsSync(pb.stateFile(dir)), false, 'no escribe estado');
    });
});

test('evaluate: rojo escribe provider-disabled con source pacing', () => {
    withSandbox(({ dir, disabled }) => {
        // Bucket inicial con poco crédito (balance se va a negativo con pct=50).
        const store = { schema_version: 1, providers: {
            anthropic: {
                provider: 'anthropic', week_start_ms: WS, weekly_quota: 100,
                accrued_credit: 10, real_consumed: 0, state: 'green',
                last_accrual_ms: NOW0, last_transition: null,
            },
        } };
        const tg = [];
        const res = pb.evaluate({
            slice: sliceWith(50), config: CFG_ON, store,
            pipelineDir: dir, now: NOW0, disabledModule: disabled,
            sendTelegram: (t) => tg.push(t), auditLogEnabled: false,
        });
        const t = res.transitions.find((x) => x.provider === 'anthropic');
        assert.equal(t.to, 'red');
        assert.equal(disabled.isProviderDisabled('anthropic', { now: NOW0, auditLogEnabled: false }), true);
        const entry = disabled.getDisabledEntry('anthropic', { now: NOW0, auditLogEnabled: false });
        assert.equal(entry.source, 'pacing');
        assert.ok(tg.length >= 1, 'notifica por Telegram');
    });
});

test('evaluate: recuperación de rojo limpia el disable de pacing (CA-4)', () => {
    withSandbox(({ dir, disabled }) => {
        // Pre-condición: anthropic apagado por pacing + bucket en rojo.
        disabled.setProviderDisabled('anthropic', { source: 'pacing', ttlMs: 60 * 60 * 1000, now: NOW0, auditLogEnabled: false });
        const store = { schema_version: 1, providers: {
            anthropic: {
                provider: 'anthropic', week_start_ms: WS, weekly_quota: 100,
                accrued_credit: 100, real_consumed: 95, state: 'red',
                last_accrual_ms: NOW0, last_transition: null,
            },
        } };
        const res = pb.evaluate({
            slice: sliceWith(5), config: CFG_ON, store, // consumo bajó a 5%
            pipelineDir: dir, now: NOW0, disabledModule: disabled,
            sendTelegram: () => {}, auditLogEnabled: false,
        });
        const t = res.transitions.find((x) => x.provider === 'anthropic');
        assert.equal(t.to, 'green');
        assert.equal(disabled.isProviderDisabled('anthropic', { now: NOW0, auditLogEnabled: false }), false,
            'el disable de pacing se limpió al recuperar');
    });
});

test('evaluate: recuperación NO toca un disable de otro origen (CA-8)', () => {
    withSandbox(({ dir, disabled }) => {
        // anthropic apagado MANUALMENTE (kill-switch #3811), no por pacing.
        disabled.setProviderDisabled('anthropic', { source: 'manual', ttlMs: 60 * 60 * 1000, now: NOW0, auditLogEnabled: false });
        const store = { schema_version: 1, providers: {
            anthropic: {
                provider: 'anthropic', week_start_ms: WS, weekly_quota: 100,
                accrued_credit: 100, real_consumed: 95, state: 'red',
                last_accrual_ms: NOW0, last_transition: null,
            },
        } };
        pb.evaluate({
            slice: sliceWith(5), config: CFG_ON, store,
            pipelineDir: dir, now: NOW0, disabledModule: disabled,
            sendTelegram: () => {}, auditLogEnabled: false,
        });
        // El disable manual NO debe ser limpiado por la recuperación de pacing.
        assert.equal(disabled.isProviderDisabled('anthropic', { now: NOW0, auditLogEnabled: false }), true,
            'el disable manual sobrevive a la recuperación de pacing (CA-8)');
        const entry = disabled.getDisabledEntry('anthropic', { now: NOW0, auditLogEnabled: false });
        assert.equal(entry.source, 'manual');
    });
});

test('evaluate: granular — sólo afecta al proveedor excedido (CA-5)', () => {
    withSandbox(({ dir, disabled }) => {
        const store = { schema_version: 1, providers: {
            anthropic: { provider: 'anthropic', week_start_ms: WS, weekly_quota: 100, accrued_credit: 10, real_consumed: 0, state: 'green', last_accrual_ms: NOW0, last_transition: null },
            'openai-codex': { provider: 'openai-codex', week_start_ms: WS, weekly_quota: 100, accrued_credit: 90, real_consumed: 5, state: 'green', last_accrual_ms: NOW0, last_transition: null },
        } };
        const slice = { providers: {
            anthropic: { weekly: { pct: 50, confidence: 'fresh' } },
            'openai-codex': { weekly: { pct: 5, confidence: 'fresh' } },
        } };
        pb.evaluate({ slice, config: CFG_ON, store, pipelineDir: dir, now: NOW0, disabledModule: disabled, sendTelegram: () => {}, auditLogEnabled: false });
        assert.equal(pb.getPacingState('anthropic', { pipelineDir: dir, now: NOW0 }), 'red');
        assert.equal(pb.getPacingState('openai-codex', { pipelineDir: dir, now: NOW0 }), 'green');
        assert.equal(disabled.isProviderDisabled('openai-codex', { now: NOW0, auditLogEnabled: false }), false);
    });
});

test('evaluate: dato no-fresh NO actualiza el consumo (igual invariante #4282)', () => {
    withSandbox(({ dir, disabled }) => {
        const store = { schema_version: 1, providers: {
            anthropic: { provider: 'anthropic', week_start_ms: WS, weekly_quota: 100, accrued_credit: 50, real_consumed: 10, state: 'green', last_accrual_ms: NOW0, last_transition: null },
        } };
        const res = pb.evaluate({
            slice: sliceWith(99, 'stale'), config: CFG_ON, store,
            pipelineDir: dir, now: NOW0, disabledModule: disabled, sendTelegram: () => {}, auditLogEnabled: false,
        });
        // El consumo se mantiene en 10 (no salta a 99 por dato stale).
        assert.equal(res.providers.anthropic.real_consumed, 10);
        assert.equal(res.providers.anthropic.state, 'green');
    });
});

test('buildTransitionMessage no contiene secretos y es categórico', () => {
    const msg = pb.buildTransitionMessage({ provider: 'anthropic', from: 'green', to: 'red', realPct: 80, expectedPct: 20 });
    assert.ok(/Anthropic/.test(msg));
    assert.equal(pb.containsSecret(msg), false);
});

// -----------------------------------------------------------------------------
// readPacingSlice — shape para el dashboard
// -----------------------------------------------------------------------------

test('readPacingSlice expone estado + saldo por proveedor', () => {
    withSandbox(({ dir }) => {
        const store = { schema_version: 1, providers: {
            anthropic: { provider: 'anthropic', week_start_ms: WS, weekly_quota: 100, accrued_credit: 30, real_consumed: 40, state: 'red' },
        } };
        pb.saveStore(dir, store);
        const slice = pb.readPacingSlice({ pipelineDir: dir, now: WS + 0.2 * WEEK_MS });
        assert.equal(slice.providers.anthropic.state, 'red');
        assert.equal(slice.providers.anthropic.balance, -10);
        assert.equal(slice.providers.anthropic.real_pct, 40);
    });
});

test('readPacingSlice fail-open ⇒ providers vacío ante error', () => {
    const slice = pb.readPacingSlice({ pipelineDir: '/no/existe/aca', now: NOW0 });
    assert.deepEqual(slice.providers, {});
});

// -----------------------------------------------------------------------------
// loadPacingConfig — fail-safe
// -----------------------------------------------------------------------------

test('loadPacingConfig: bloque ausente ⇒ defaults conservadores (enabled false)', () => {
    const cfg = pb.loadPacingConfig({});
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.weeklyQuota, pb.DEFAULT_WEEKLY_QUOTA);
});

test('loadPacingConfig: lee enabled + cupo + márgenes', () => {
    const cfg = pb.loadPacingConfig({ pacing: { enabled: true, weekly_quota_pct_per_provider: 100, yellow_margin_pct: 5, ttl_red_min: 30 } });
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.weeklyQuota, 100);
    assert.ok(Math.abs(cfg.yellowMargin - 0.05) < 1e-9);
    assert.equal(cfg.ttlRedMin, 30);
});

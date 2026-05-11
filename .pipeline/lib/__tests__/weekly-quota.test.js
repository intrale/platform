// =============================================================================
// Tests weekly-quota.js — refactor multi-provider M2 (#3092)
//
// Cubre:
//
//   * Re-export de `quotaUsage(provider, sessionData)` desde el módulo
//     weekly-quota (callers viejos pueden migrar progresivo sin importar
//     dos paquetes).
//   * Migración lazy del state v1 → v2 (schema_version) — no rompe archivos
//     existentes ni cambia la interpretación de los campos legacy.
//   * Regresión cero del banner del dashboard: shape devuelto por
//     `quotaUsage('anthropic', ...)` con `adapterStatus: 'ok'` contiene
//     **byte-a-byte** todos los campos que `computeQuota(...)` ya devolvía
//     antes de M2 (CA-original "regresión cero" + UX G5 + security CA-#7).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function makeTmpDir(prefix = 'wq-3092-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJsonl(filePath, events) {
    fs.writeFileSync(filePath, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

function freshWeekly() {
    delete require.cache[require.resolve('../weekly-quota')];
    delete require.cache[require.resolve('../quota-adapters')];
    delete require.cache[require.resolve('../quota-adapters/anthropic')];
    delete require.cache[require.resolve('../quota-adapters/_shape')];
    return require('../weekly-quota');
}

test('weekly-quota expone quotaUsage y STATE_SCHEMA_VERSION', () => {
    const wq = freshWeekly();
    assert.equal(typeof wq.quotaUsage, 'function');
    assert.equal(wq.STATE_SCHEMA_VERSION, 2);
});

test('quotaUsage re-exportado dispatcha al adapter Anthropic correctamente', () => {
    const tmp = makeTmpDir();
    const metricsDir = path.join(tmp, 'metrics');
    fs.mkdirSync(metricsDir);
    const log = path.join(tmp, 'activity-log.jsonl');
    writeJsonl(log, [
        { event: 'session:end', ts: new Date().toISOString(), duration_ms: 3600000, model: 'claude' },
    ]);

    const wq = freshWeekly();
    const result = wq.quotaUsage('anthropic', { metricsDir, activityLogPath: log });

    assert.equal(result.provider, 'anthropic');
    assert.equal(result.adapterStatus, 'ok');
    assert.equal(result.errorReason, null);
    assert.equal(result.schemaVersion, 2);
    assert.ok(Array.isArray(result.breakdown));
});

test('quotaUsage rechaza provider fuera de allowlist con adapterStatus error', () => {
    const wq = freshWeekly();
    const result = wq.quotaUsage('hackerprovider', {});
    assert.equal(result.adapterStatus, 'error');
    assert.equal(result.pct, null, 'pct debe ser null, NO 0 — distinguir degradado de "0% real"');
    assert.match(result.errorReason, /allowlist/);
});

test('migración lazy v1 → v2: state sin schema_version se completa con 2 al leer', () => {
    const tmp = makeTmpDir();
    const metricsDir = path.join(tmp, 'metrics');
    fs.mkdirSync(metricsDir);
    // Simular state v1 (sin schema_version) que ya existía en producción.
    const v1State = {
        config_limit_hours: 40,
        effective_limit_hours: 50,
        observed_max_hours: 38.2,
        observed_max_at: '2026-04-01T12:00:00.000Z',
        adjustments: [],
        calibration: null,
        calibrations: [],
    };
    fs.writeFileSync(path.join(metricsDir, 'weekly-quota.json'), JSON.stringify(v1State));

    const wq = freshWeekly();
    const loaded = wq.loadState(metricsDir);
    assert.equal(loaded.schema_version, 2, 'schema_version debe completarse lazy a 2');
    // Campos legacy intactos
    assert.equal(loaded.effective_limit_hours, 50);
    assert.equal(loaded.observed_max_hours, 38.2);
});

test('state nuevo (sin archivo) se inicializa con schema_version: 2 explícito', () => {
    const tmp = makeTmpDir();
    const metricsDir = path.join(tmp, 'metrics');
    fs.mkdirSync(metricsDir);
    const wq = freshWeekly();
    const fresh = wq.loadState(metricsDir);
    assert.equal(fresh.schema_version, 2);
    assert.equal(fresh.calibration, null);
    assert.deepEqual(fresh.calibrations, []);
});

test('regresión cero del banner: quotaUsage(anthropic) wrappea computeQuota sin alterar campos legacy', () => {
    const tmp = makeTmpDir();
    const metricsDir = path.join(tmp, 'metrics');
    fs.mkdirSync(metricsDir);
    const log = path.join(tmp, 'activity-log.jsonl');
    const now = Date.now();
    writeJsonl(log, [
        { event: 'session:end', ts: new Date(now - 3600000).toISOString(), duration_ms: 7200000, model: 'claude' },
        { event: 'session:end', ts: new Date(now - 7200000).toISOString(), duration_ms: 5400000, model: 'claude' },
        // Determinístico debe excluirse igual que en legacy.
        { event: 'session:end', ts: new Date(now - 10800000).toISOString(), duration_ms: 9000000, model: 'deterministic' },
    ]);

    const wq = freshWeekly();
    const legacy = wq.computeQuota(metricsDir, log);
    const wrapped = wq.quotaUsage('anthropic', { metricsDir, activityLogPath: log });

    // Campos del banner que NO pueden romper (UX G5 + security CA-#7).
    // `observedMaxAt` se actualiza con `new Date().toISOString()` cada llamada
    // que detecta nuevo máximo; entre dos invocaciones consecutivas puede
    // diferir en ms aunque la lógica sea idéntica → lo verificamos por tipo.
    const bannerFieldsExact = [
        'hoursUsed7d', 'sessionsCount7d', 'hoursLast24h',
        'effectiveLimitHours', 'configLimitHours',
        'pct', 'realPct', 'realPctRaw', 'realPctCapped', 'realStatus',
        'hoursRemaining', 'burnRatePerDay', 'daysToLimit', 'status',
        'adjustmentsCount', 'observedMaxHours', 'autoAdjusted',
        'lastResetAt', // depende del día/hora, no del ms — estable.
        'calibrationAgeDays', 'calibrationStale',
        'sessionResetsAt', 'weeklyResetsAtReported',
        'weeklyResetDriftMin',
    ];
    for (const f of bannerFieldsExact) {
        assert.deepEqual(wrapped[f], legacy[f], `campo "${f}" debe coincidir byte-a-byte`);
    }
    // Campos timestamp-dependent: misma forma + tolerancia razonable (< 1s).
    if (legacy.observedMaxAt) {
        assert.ok(wrapped.observedMaxAt, 'observedMaxAt debe estar presente igual que en legacy');
        const dt = Math.abs(new Date(wrapped.observedMaxAt).getTime() - new Date(legacy.observedMaxAt).getTime());
        assert.ok(dt < 1000, `observedMaxAt debe estar dentro de 1s del legacy (delta=${dt}ms)`);
    } else {
        assert.equal(wrapped.observedMaxAt, null);
    }
    // nextResetAt/daysToReset se computan con Date.now() puro pero el "día"
    // del próximo domingo 21:00 no cambia entre llamadas consecutivas.
    assert.equal(wrapped.nextResetAt, legacy.nextResetAt, 'nextResetAt debe ser estable');
    // daysToReset: tolerancia 0.001 días (~1.4 min) — puede diferir por el ms entre llamadas.
    assert.ok(Math.abs(wrapped.daysToReset - legacy.daysToReset) < 0.001,
        `daysToReset debe coincidir con tolerancia (legacy=${legacy.daysToReset}, wrapped=${wrapped.daysToReset})`);
    // session.* también debe coincidir
    assert.deepEqual(wrapped.session, legacy.session);
    // calibration y calibrations también
    assert.deepEqual(wrapped.calibration, legacy.calibration);
    assert.deepEqual(wrapped.calibrations, legacy.calibrations);

    // Y los nuevos campos del envelope multi-provider
    assert.equal(wrapped.provider, 'anthropic');
    assert.equal(wrapped.adapterStatus, 'ok');
    assert.equal(wrapped.errorReason, null);
    assert.equal(wrapped.schemaVersion, 2);
    assert.deepEqual(wrapped.breakdown, []);
});

test('quotaUsage(anthropic) sin metricsDir devuelve adapterStatus error con errorReason accionable', () => {
    const wq = freshWeekly();
    const result = wq.quotaUsage('anthropic', {});
    assert.equal(result.provider, 'anthropic');
    assert.equal(result.adapterStatus, 'error');
    assert.equal(result.pct, null);
    assert.match(result.errorReason, /metricsDir/);
});

test('quotaUsage(anthropic) con activity-log corrupto NO lanza, devuelve estado consistente', () => {
    const tmp = makeTmpDir();
    const metricsDir = path.join(tmp, 'metrics');
    fs.mkdirSync(metricsDir);
    const log = path.join(tmp, 'activity-log.jsonl');
    fs.writeFileSync(log, 'this is not json\n{"broken": "yes"}\n{"event": "session:end"}\n');

    const wq = freshWeekly();
    const result = wq.quotaUsage('anthropic', { metricsDir, activityLogPath: log });
    // computeQuota tolera líneas corruptas (las saltea) → adapter ok.
    assert.equal(result.adapterStatus, 'ok');
    assert.equal(result.hoursUsed7d, 0);
});

test('computeQuota legacy sigue funcionando sin cambios (no breaking)', () => {
    const tmp = makeTmpDir();
    const metricsDir = path.join(tmp, 'metrics');
    fs.mkdirSync(metricsDir);
    const log = path.join(tmp, 'activity-log.jsonl');
    writeJsonl(log, [
        { event: 'session:end', ts: new Date().toISOString(), duration_ms: 3600000, model: 'claude' },
    ]);

    const wq = freshWeekly();
    const result = wq.computeQuota(metricsDir, log);
    // Shape legacy intacto — NO tiene los campos del envelope multi-provider.
    assert.equal(typeof result.pct, 'number');
    assert.equal(typeof result.status, 'string');
    assert.equal(typeof result.session, 'object');
    // Estos campos son nuevos del envelope; la API legacy NO los expone.
    assert.equal(result.provider, undefined);
    assert.equal(result.adapterStatus, undefined);
    assert.equal(result.schemaVersion, undefined);
});

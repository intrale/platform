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
    const now = Date.now();
    // Cache de /usage fresco (fuente de verdad #4597).
    fs.writeFileSync(path.join(metricsDir, 'anthropic-usage.json'), JSON.stringify({
        schema: 1, capturedAtMs: now, sessionPct: 10, weeklyPct: 42,
    }));

    const wq = freshWeekly();
    const result = wq.quotaUsage('anthropic', { metricsDir, autoRefresh: false, now });

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

test('#4597: quotaUsage(anthropic) mapea el número REAL de /usage (pct=semanal, session.pct=sesión)', () => {
    const tmp = makeTmpDir();
    const metricsDir = path.join(tmp, 'metrics');
    fs.mkdirSync(metricsDir);
    const now = Date.now();
    // Cache de /usage escrito por lib/anthropic-usage.js — fresco (age 0).
    fs.writeFileSync(path.join(metricsDir, 'anthropic-usage.json'), JSON.stringify({
        schema: 1,
        source: 'claude -p /usage',
        capturedAt: new Date(now).toISOString(),
        capturedAtMs: now,
        sessionPct: 20,
        weeklyPct: 64,
        sessionResetsRaw: 'Jul 8, 10pm (America/Buenos_Aires)',
        weeklyResetsRaw: 'Jul 12, 9pm (America/Buenos_Aires)',
        sessionResetsAt: null,
        weeklyResetsAt: null,
    }));

    const wq = freshWeekly();
    const r = wq.quotaUsage('anthropic', { metricsDir, autoRefresh: false, now });

    assert.equal(r.provider, 'anthropic');
    assert.equal(r.adapterStatus, 'ok');
    assert.equal(r.errorReason, null);
    assert.equal(r.schemaVersion, 2);
    // El % semanal ES el real de /usage (64%) — NADA de heurística de duración.
    assert.equal(r.pct, 64);
    assert.equal(r.status, 'normal'); // 50 ≤ 64 < 75
    assert.equal(r.session.pct, 20);
    assert.equal(r.session.status, 'ok'); // < 50
    // Ya no hay calibración: realPct null, pct ES el real.
    assert.equal(r.realPct, null);
    assert.equal(r.calibration, null);
    // Sin heurística de duración → campos de horas nulos.
    assert.equal(r.hoursUsed7d, null);
    assert.equal(r.effectiveLimitHours, null);
    assert.deepEqual(r.breakdown, []);
});

test('quotaUsage(anthropic) sin metricsDir devuelve adapterStatus error con errorReason accionable', () => {
    const wq = freshWeekly();
    const result = wq.quotaUsage('anthropic', {});
    assert.equal(result.provider, 'anthropic');
    assert.equal(result.adapterStatus, 'error');
    assert.equal(result.pct, null);
    assert.match(result.errorReason, /metricsDir/);
});

test('#4597: quotaUsage(anthropic) SIN cache de /usage degrada a unknown (fallback seguro, no lanza, pct null)', () => {
    const tmp = makeTmpDir();
    const metricsDir = path.join(tmp, 'metrics');
    fs.mkdirSync(metricsDir);

    const wq = freshWeekly();
    // Sin cache de /usage y sin spawnear (autoRefresh false): fallback degradado.
    const result = wq.quotaUsage('anthropic', { metricsDir, autoRefresh: false });
    assert.equal(result.adapterStatus, 'unknown');
    assert.equal(result.pct, null); // nunca 0 silencioso
    assert.match(result.errorReason, /fallback degradado/);
});

test('#4861: computeQuota/saveCalibration/clearCalibration ya NO se exportan (heurística/EMA retiradas)', () => {
    const wq = freshWeekly();
    // La heurística de duration_ms y la calibración manual EMA salieron del
    // módulo: la fuente única de cuota Anthropic es claude -p /usage.
    assert.equal(wq.computeQuota, undefined, 'computeQuota debe estar retirada');
    assert.equal(wq.saveCalibration, undefined, 'saveCalibration debe estar retirada');
    assert.equal(wq.clearCalibration, undefined, 'clearCalibration debe estar retirada');
});

test('#4861: helpers de reset semanal siguen exportados (pacing/exhaustion los consumen)', () => {
    const wq = freshWeekly();
    assert.equal(typeof wq.getLastWeeklyResetMs, 'function', 'getLastWeeklyResetMs debe seguir exportado');
    assert.equal(typeof wq.getNextWeeklyResetMs, 'function', 'getNextWeeklyResetMs debe seguir exportado');
    const now = Date.now();
    const last = wq.getLastWeeklyResetMs(now);
    const next = wq.getNextWeeklyResetMs(now);
    assert.equal(typeof last, 'number');
    assert.equal(typeof next, 'number');
    assert.ok(next > last, 'el próximo reset debe ser posterior al último');
    // Los módulos que dependen de estos helpers deben resolverlos sin romperse.
    assert.doesNotThrow(() => {
        require('../pacing-bucket');
        require('../quota-exhausted');
    });
});

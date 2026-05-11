// =============================================================================
// Tests quota-adapters/anthropic.js — adapter Anthropic Plan Max (#3092)
//
// Cubre los CAs verificables del adapter (delega lógica a `computeQuota`,
// los tests bordes finos de reset/calibración ya están en otros archivos):
//
//   * Shape envelope correcto cuando OK (provider/adapterStatus/...).
//   * Errores controlados → fail-secure con `pct: null`, NO 0.
//   * Reset boundary, salto de mes, snapshot integration están cubiertos
//     en quota-snapshot-integration.test.js (que ya pasa) — acá nos
//     concentramos en lo nuevo del adapter.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function makeTmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'quota-anthropic-')); }
function writeJsonl(filePath, events) {
    fs.writeFileSync(filePath, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

function freshAdapter() {
    delete require.cache[require.resolve('../../quota-adapters/anthropic')];
    delete require.cache[require.resolve('../../quota-adapters/_shape')];
    delete require.cache[require.resolve('../../weekly-quota')];
    return require('../../quota-adapters/anthropic');
}

test('anthropic adapter devuelve adapterStatus=ok y campos legacy completos cuando hay datos', () => {
    const tmp = makeTmpDir();
    const metricsDir = path.join(tmp, 'metrics');
    fs.mkdirSync(metricsDir);
    const log = path.join(tmp, 'activity-log.jsonl');
    writeJsonl(log, [
        { event: 'session:end', ts: new Date().toISOString(), duration_ms: 3600000, model: 'claude' },
    ]);

    const adapter = freshAdapter();
    const r = adapter({ metricsDir, activityLogPath: log });

    assert.equal(r.provider, 'anthropic');
    assert.equal(r.adapterStatus, 'ok');
    assert.equal(r.errorReason, null);
    assert.equal(r.schemaVersion, 2);
    assert.deepEqual(r.breakdown, []);
    // Campos legacy presentes
    assert.equal(typeof r.pct, 'number');
    assert.equal(typeof r.status, 'string');
    assert.equal(typeof r.session, 'object');
});

test('anthropic adapter sin metricsDir devuelve error explícito (no lanza)', () => {
    const adapter = freshAdapter();
    const r = adapter({ activityLogPath: '/tmp/x.jsonl' });
    assert.equal(r.adapterStatus, 'error');
    assert.match(r.errorReason, /metricsDir/);
    assert.equal(r.pct, null);
});

test('anthropic adapter sin activityLogPath devuelve error explícito (no lanza)', () => {
    const tmp = makeTmpDir();
    const metricsDir = path.join(tmp, 'metrics');
    fs.mkdirSync(metricsDir);
    const adapter = freshAdapter();
    const r = adapter({ metricsDir });
    assert.equal(r.adapterStatus, 'error');
    assert.match(r.errorReason, /activityLogPath/);
});

test('anthropic adapter excluye eventos model:deterministic igual que computeQuota legacy', () => {
    const tmp = makeTmpDir();
    const metricsDir = path.join(tmp, 'metrics');
    fs.mkdirSync(metricsDir);
    const log = path.join(tmp, 'activity-log.jsonl');
    const now = Date.now();
    writeJsonl(log, [
        { event: 'session:end', ts: new Date(now - 3600000).toISOString(), duration_ms: 3600000, model: 'claude' },
        { event: 'session:end', ts: new Date(now - 7200000).toISOString(), duration_ms: 9000000, model: 'deterministic' },
    ]);

    const adapter = freshAdapter();
    const r = adapter({ metricsDir, activityLogPath: log });
    assert.equal(r.adapterStatus, 'ok');
    // 1h Claude + 0h determinístico (excluido) = 1h total — no 3.5h.
    assert.ok(r.hoursUsed7d <= 1.1, `hoursUsed7d (${r.hoursUsed7d}) debe contar solo Claude`);
});

test('anthropic adapter respeta configLimitHours opcional', () => {
    const tmp = makeTmpDir();
    const metricsDir = path.join(tmp, 'metrics');
    fs.mkdirSync(metricsDir);
    const log = path.join(tmp, 'activity-log.jsonl');
    fs.writeFileSync(log, '');

    const adapter = freshAdapter();
    const r = adapter({ metricsDir, activityLogPath: log, configLimitHours: 80 });
    assert.equal(r.adapterStatus, 'ok');
    assert.equal(r.configLimitHours, 80);
    assert.ok(r.effectiveLimitHours >= 80);
});

test('anthropic adapter es resiliente a JSONL corrupto (no lanza, devuelve ok con counts=0)', () => {
    const tmp = makeTmpDir();
    const metricsDir = path.join(tmp, 'metrics');
    fs.mkdirSync(metricsDir);
    const log = path.join(tmp, 'activity-log.jsonl');
    fs.writeFileSync(log, 'this is not json\n{"missing": true}\n');

    const adapter = freshAdapter();
    const r = adapter({ metricsDir, activityLogPath: log });
    assert.equal(r.adapterStatus, 'ok');
    assert.equal(r.hoursUsed7d, 0);
    assert.equal(r.sessionsCount7d, 0);
});

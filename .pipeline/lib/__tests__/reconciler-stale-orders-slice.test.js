// =============================================================================
// CA5 (#2994) — Slice del dashboard que cuenta órdenes stale en últimas 24h.
//
// Verifica:
//   - Sin archivo de log → totales en 0 (no rompe el dashboard).
//   - Con eventos viejos (>24h) → no se cuentan.
//   - Con eventos recientes → total + breakdown por reason.
//   - Líneas inválidas (JSON corrupto) se ignoran sin tirar el slice.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Setup ANTES del require para que el slice resuelva PIPELINE_STATE_DIR.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'slice-stale-'));
const PIPELINE = path.join(TMP_DIR, '.pipeline');
const LOG_DIR = path.join(PIPELINE, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
process.env.PIPELINE_STATE_DIR = PIPELINE;

const slices = require('../dashboard-slices');

const LOG_FILE = path.join(LOG_DIR, 'stale-orders.log');
const STATE = {}; // El slice no usa state, pero la firma lo recibe.
const CTX = { PIPELINE };

function clearLog() {
    try { fs.unlinkSync(LOG_FILE); } catch {}
}

function writeLog(events) {
    const lines = events.map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.writeFileSync(LOG_FILE, lines);
}

function appendLog(events) {
    const lines = events.map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.appendFileSync(LOG_FILE, lines);
}

test('#2994 slice sin archivo → totales en 0', () => {
    clearLog();
    const r = slices.reconcilerStaleOrdersSlice(STATE, CTX);
    assert.equal(r.total_24h, 0);
    assert.deepEqual(r.by_reason, {});
    assert.ok(/^\d{4}-/.test(r.updated_at));
});

test('#2994 slice cuenta eventos recientes y desglosa por reason', () => {
    clearLog();
    const now = new Date();
    writeLog([
        { ts: now.toISOString(), reason: 'stale-marker-missing', issue: 1, label: 'needs-human' },
        { ts: now.toISOString(), reason: 'stale-marker-missing', issue: 2, label: 'needs-human' },
        { ts: now.toISOString(), reason: 'stale-mtime', issue: 3, label: 'needs-human' },
        { ts: now.toISOString(), reason: 'human-unblock-detected', issue: 4, label: 'needs-human' },
    ]);
    const r = slices.reconcilerStaleOrdersSlice(STATE, CTX);
    assert.equal(r.total_24h, 4);
    assert.equal(r.by_reason['stale-marker-missing'], 2);
    assert.equal(r.by_reason['stale-mtime'], 1);
    assert.equal(r.by_reason['human-unblock-detected'], 1);
});

test('#2994 slice ignora eventos más viejos que 24h', () => {
    clearLog();
    const old = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    const now = new Date().toISOString();
    writeLog([
        { ts: old, reason: 'stale-marker-missing', issue: 1 },
        { ts: old, reason: 'stale-mtime', issue: 2 },
        { ts: now, reason: 'stale-marker-missing', issue: 3 },
    ]);
    const r = slices.reconcilerStaleOrdersSlice(STATE, CTX);
    assert.equal(r.total_24h, 1, 'solo el evento de hoy entra');
    assert.equal(r.by_reason['stale-marker-missing'], 1);
});

test('#2994 slice tolera líneas corruptas', () => {
    clearLog();
    const now = new Date().toISOString();
    fs.writeFileSync(LOG_FILE,
        'esto-no-es-json\n' +
        JSON.stringify({ ts: now, reason: 'stale-mtime', issue: 1 }) + '\n' +
        '{partial json\n' +
        JSON.stringify({ ts: now, reason: 'stale-mtime', issue: 2 }) + '\n'
    );
    const r = slices.reconcilerStaleOrdersSlice(STATE, CTX);
    assert.equal(r.total_24h, 2);
    assert.equal(r.by_reason['stale-mtime'], 2);
});

test('#2994 slice ignora eventos sin ts válido', () => {
    clearLog();
    writeLog([
        { reason: 'stale-mtime', issue: 1 }, // sin ts
        { ts: 'not-a-date', reason: 'stale-mtime', issue: 2 },
        { ts: new Date().toISOString(), reason: 'stale-mtime', issue: 3 },
    ]);
    const r = slices.reconcilerStaleOrdersSlice(STATE, CTX);
    assert.equal(r.total_24h, 1);
});

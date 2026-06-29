// =============================================================================
// dispatch-quota-real-gate.test.js — Router descarta candidatos de fallback
// sin cuota real usable (#4283, CA-3 / CA-4).
//
// El gate de fallback (`evaluateHealthGate`) descarta un candidato cuando su
// entrada en el snapshot (state/multi-provider-health.json) trae state 'red'
// FRESCO con reason_code durable. #4283 suma 'quota_exhausted_real' al set
// durable: un provider logueado pero sin cuota real (≥90%) debe salir de la
// cascada de fallback.
//
// El "primario NO se gatea por health" lo garantiza el call-site del dispatch
// (solo evalúa candidatos de fallback). Acá probamos la unidad del gate.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateHealthGate } = require('../lib/agent-launcher/dispatch-with-fallback');

const NOW = 1_700_000_000_000;

function snapshotWith(entry) {
    return { ts: new Date(NOW).toISOString(), providers: [entry] };
}

test('CA-3: candidato de fallback rojo-fresco con quota_exhausted_real → gated', () => {
    const snap = snapshotWith({
        provider: 'gemini-google',
        state: 'red',
        reason_code: 'quota_exhausted_real',
        last_checked_at: new Date(NOW - 60 * 1000).toISOString(), // 1 min — fresco
    });
    const res = evaluateHealthGate('gemini-google', snap, NOW);
    assert.equal(res.gated, true, 'cuota real agotada es causa durable → se descarta del fallback');
    assert.equal(res.reason, 'quota_exhausted_real');
});

test('CA-3: rojo por quota_exhausted_real pero STALE → fail-open (no gatea)', () => {
    const snap = snapshotWith({
        provider: 'cerebras',
        state: 'red',
        reason_code: 'quota_exhausted_real',
        last_checked_at: new Date(NOW - 60 * 60 * 1000).toISOString(), // 1h — viejo
    });
    const res = evaluateHealthGate('cerebras', snap, NOW);
    assert.equal(res.gated, false, 'un rojo viejo no es confiable → fail-open preserva cobertura');
    assert.equal(res.reason, 'red_stale');
});

test('CA-3: provider sano (green) con cuota OK no se gatea', () => {
    const snap = snapshotWith({
        provider: 'gemini-google',
        state: 'green',
        reason_code: 'authenticated',
        last_checked_at: new Date(NOW - 60 * 1000).toISOString(),
    });
    const res = evaluateHealthGate('gemini-google', snap, NOW);
    assert.equal(res.gated, false);
});

test('CA-3: alias openai-codex → openai resuelve la entrada del snapshot del cron', () => {
    const snap = snapshotWith({
        provider: 'openai', // el cron nombra a Codex como 'openai'
        state: 'red',
        reason_code: 'quota_exhausted_real',
        last_checked_at: new Date(NOW - 30 * 1000).toISOString(),
    });
    const res = evaluateHealthGate('openai-codex', snap, NOW);
    assert.equal(res.gated, true, 'el gate debe encontrar la entrada via alias y descartar el candidato');
});

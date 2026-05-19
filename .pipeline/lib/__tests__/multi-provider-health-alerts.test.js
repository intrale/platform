// =============================================================================
// multi-provider-health-alerts.test.js — Tests del dedupe + back-off + redact
// del módulo health-alerts (#3260 CA-4).
//
// No hace I/O real: trabajamos sobre tmp file y dedupFile inyectado.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const alerts = require('../multi-provider/health-alerts');

function tmpFile(name = 'dedup.json') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-alerts-'));
    return path.join(dir, name);
}

test('decide emite primera alerta cuando no hay registro previo', () => {
    const f = tmpFile();
    const r = alerts.decide({
        provider: 'cerebras',
        state: 'red',
        reasonCode: 'invalid_credentials',
        dedupFile: f,
    });
    assert.equal(r.shouldEmit, true);
    assert.equal(r.payload.provider, 'cerebras');
    assert.equal(r.payload.state, 'red');
    assert.equal(r.payload.reason_code, 'invalid_credentials');
    assert.ok(r.payload.observed_at, 'observed_at debe estar presente');
});

test('record + decide aplica dedupe dentro de 10 min', () => {
    const f = tmpFile();
    const now = Date.now();
    alerts.record({ provider: 'gemini-google', state: 'green', sent: true, dedupFile: f, now });
    const r = alerts.decide({
        provider: 'gemini-google',
        state: 'green',
        reasonCode: 'authenticated',
        dedupFile: f,
        now: now + 5 * 60 * 1000, // 5 min después
    });
    assert.equal(r.shouldEmit, false);
    assert.equal(r.reasonNoEmit, 'dedup_window');
});

test('record + decide pasa el dedupe a los 11 min', () => {
    const f = tmpFile();
    const now = Date.now();
    alerts.record({ provider: 'nvidia-nim', state: 'green', sent: true, dedupFile: f, now });
    const r = alerts.decide({
        provider: 'nvidia-nim',
        state: 'green',
        reasonCode: 'authenticated',
        dedupFile: f,
        now: now + 11 * 60 * 1000,
    });
    assert.equal(r.shouldEmit, true);
});

test('back-off exponencial: estado red persistente espera 30/60/120 min', () => {
    const f = tmpFile();
    let now = Date.now();
    // 1er envío (consecutive_count=1)
    alerts.record({ provider: 'cerebras', state: 'red', sent: true, dedupFile: f, now });

    // 5 min después: suprimido (back-off mínimo es 30min)
    let r = alerts.decide({ provider: 'cerebras', state: 'red', reasonCode: 'invalid_credentials', dedupFile: f, now: now + 5 * 60 * 1000 });
    assert.equal(r.shouldEmit, false);

    // 31 min después: pasó el nivel 1 (30min) → emitir
    r = alerts.decide({ provider: 'cerebras', state: 'red', reasonCode: 'invalid_credentials', dedupFile: f, now: now + 31 * 60 * 1000 });
    assert.equal(r.shouldEmit, true);
});

test('decide sanitiza provider con caracteres extraños', () => {
    const f = tmpFile();
    const r = alerts.decide({
        provider: '../evil',
        state: 'red',
        reasonCode: 'unknown',
        dedupFile: f,
    });
    assert.equal(r.shouldEmit, false);
    assert.equal(r.reasonNoEmit, 'invalid_input');
});

test('decide sanitiza state inválido', () => {
    const f = tmpFile();
    const r = alerts.decide({
        provider: 'cerebras',
        state: 'critical', // no en ALLOWED_STATES
        reasonCode: 'unknown',
        dedupFile: f,
    });
    assert.equal(r.shouldEmit, false);
    assert.equal(r.reasonNoEmit, 'invalid_input');
});

test('decide mapea reason code provider-specific a unknown', () => {
    const f = tmpFile();
    const r = alerts.decide({
        provider: 'cerebras',
        state: 'red',
        reasonCode: 'gemini_v1beta_safety_block', // intentional leak attempt
        dedupFile: f,
    });
    assert.equal(r.shouldEmit, true);
    assert.equal(r.payload.reason_code, 'unknown', 'reason code provider-specific debe mapearse a unknown');
});

test('payload NO incluye API key, fingerprint, body ni headers', () => {
    const f = tmpFile();
    const r = alerts.decide({
        provider: 'cerebras',
        state: 'red',
        reasonCode: 'invalid_credentials',
        dedupFile: f,
    });
    assert.equal(r.shouldEmit, true);
    const serialized = JSON.stringify(r.payload);
    // No debe contener claves sensibles
    assert.ok(!/api_key|apiKey|fingerprint|masked|body|stack|headers/i.test(serialized), 'payload no debe filtrar campos sensibles');
});

test('decideMultiDown emite cuando 3+ free providers en rojo', () => {
    const f = tmpFile();
    const snapshot = {
        providers: [
            { provider: 'cerebras', state: 'red' },
            { provider: 'gemini-google', state: 'red' },
            { provider: 'nvidia-nim', state: 'red' },
            { provider: 'anthropic', state: 'green' },
        ],
    };
    const r = alerts.decideMultiDown({ snapshot, dedupFile: f });
    assert.equal(r.shouldEmit, true);
    assert.equal(r.red_count, 3);
    assert.deepEqual(r.payload.providers_red, ['cerebras', 'gemini-google', 'nvidia-nim']);
});

test('decideMultiDown NO emite cuando solo 2 free providers en rojo', () => {
    const f = tmpFile();
    const snapshot = {
        providers: [
            { provider: 'cerebras', state: 'red' },
            { provider: 'nvidia-nim', state: 'red' },
            { provider: 'gemini-google', state: 'green' },
        ],
    };
    const r = alerts.decideMultiDown({ snapshot, dedupFile: f });
    assert.equal(r.shouldEmit, false);
    assert.equal(r.reasonNoEmit, 'below_threshold');
});

test('decideMultiDown ignora providers paid en el conteo', () => {
    const f = tmpFile();
    const snapshot = {
        providers: [
            { provider: 'anthropic', state: 'red' },
            { provider: 'openai', state: 'red' },
            { provider: 'elevenlabs', state: 'red' },
        ],
    };
    const r = alerts.decideMultiDown({ snapshot, dedupFile: f });
    assert.equal(r.shouldEmit, false, 'multi-down solo cuenta free providers');
});

test('recordMultiDown + decideMultiDown aplica dedupe 10 min', () => {
    const f = tmpFile();
    const now = Date.now();
    const snapshot = {
        providers: [
            { provider: 'cerebras', state: 'red' },
            { provider: 'gemini-google', state: 'red' },
            { provider: 'nvidia-nim', state: 'red' },
        ],
    };
    alerts.recordMultiDown({ sent: true, dedupFile: f, now });
    const r = alerts.decideMultiDown({ snapshot, dedupFile: f, now: now + 5 * 60 * 1000 });
    assert.equal(r.shouldEmit, false);
    assert.equal(r.reasonNoEmit, 'dedup_window');
});

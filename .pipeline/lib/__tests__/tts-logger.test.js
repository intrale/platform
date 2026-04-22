// Tests de .pipeline/lib/tts-logger.js (issue #2477)
// Valida schema de eventos tts:generated, cálculo de costos y estimación audio_seconds.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-tts-'));
fs.mkdirSync(path.join(TMP_DIR, '.claude'), { recursive: true });
process.env.CLAUDE_PROJECT_DIR = TMP_DIR;
process.env.PIPELINE_REPO_ROOT = TMP_DIR;

delete require.cache[require.resolve('../traceability')];
delete require.cache[require.resolve('../tts-logger')];
const trace = require('../traceability');
const ttsLogger = require('../tts-logger');

function readEvents() {
    if (!fs.existsSync(trace.LOG_FILE)) return [];
    return fs.readFileSync(trace.LOG_FILE, 'utf8')
        .split('\n').filter(Boolean).map(l => JSON.parse(l));
}

test('emitTtsGenerated emite schema correcto', () => {
    const evt = ttsLogger.emitTtsGenerated({
        skill: 'qa', issue: 2476, phase: 'qa',
        provider: 'openai', chars: 420, audio_seconds: 30, voice: 'ash',
    });
    assert.equal(evt.event, 'tts:generated');
    assert.equal(evt.skill, 'qa');
    assert.equal(evt.issue, 2476);
    assert.equal(evt.phase, 'qa');
    assert.equal(evt.provider, 'openai');
    assert.equal(evt.chars, 420);
    assert.equal(evt.audio_seconds, 30);
    assert.equal(evt.voice, 'ash');
    assert.ok(evt.cost_estimate_usd > 0, 'costo OpenAI > 0');
    assert.ok(evt.ts);
});

test('estimateAudioSeconds: 140 chars → 10s (14 chars/s)', () => {
    assert.equal(ttsLogger.estimateAudioSeconds(140), 10);
    assert.equal(ttsLogger.estimateAudioSeconds(0), 0);
    assert.equal(ttsLogger.estimateAudioSeconds(-5), 0);
});

test('emitTtsGenerated usa estimación si no se provee audio_seconds', () => {
    const evt = ttsLogger.emitTtsGenerated({
        skill: 's', issue: 1, phase: 'dev', provider: 'openai', chars: 280,
    });
    assert.equal(evt.audio_seconds, 20); // 280 / 14 = 20
});

test('estimateTtsCost: OpenAI 60s ≈ $0.015', () => {
    const cost = ttsLogger.estimateTtsCost('openai', 60, 0);
    assert.equal(cost, 0.015);
});

test('estimateTtsCost: edge-tts es gratis', () => {
    const cost = ttsLogger.estimateTtsCost('edge-tts', 120, 5000);
    assert.equal(cost, 0);
});

test('estimateTtsCost: provider desconocido fallback a pricing OpenAI', () => {
    const cost = ttsLogger.estimateTtsCost('mystery', 60, 0);
    assert.equal(cost, 0.015);
});

test('wrapTts ejecuta el generator y emite evento con audio_seconds estimado', async () => {
    const before = readEvents().length;
    const result = await ttsLogger.wrapTts(
        { skill: 's', issue: 99, phase: 'qa', provider: 'openai', chars: 700, voice: 'alloy' },
        async () => 'fake-audio-result',
    );
    assert.equal(result, 'fake-audio-result');
    const events = readEvents();
    const last = events[events.length - 1];
    assert.equal(last.event, 'tts:generated');
    assert.equal(last.skill, 's');
    assert.equal(last.chars, 700);
    assert.equal(last.audio_seconds, 50); // 700 / 14
    assert.ok(events.length > before);
});

test('wrapTts provider edge-tts produce costo 0', async () => {
    await ttsLogger.wrapTts(
        { skill: 'status', issue: null, phase: 'ops', provider: 'edge-tts', chars: 1400, voice: 'Lorenzo' },
        async () => Buffer.alloc(0),
    );
    const events = readEvents();
    const last = events[events.length - 1];
    assert.equal(last.provider, 'edge-tts');
    assert.equal(last.cost_estimate_usd, 0);
});

test('TTS_PRICING define providers esperados', () => {
    assert.ok(ttsLogger.TTS_PRICING.openai);
    assert.ok(ttsLogger.TTS_PRICING['edge-tts']);
    assert.ok(ttsLogger.TTS_PRICING.unknown);
    assert.equal(ttsLogger.TTS_PRICING['edge-tts'].per_audio_second, 0);
});

test('audioSecondsFromBuffer retorna null si buffer vacío', () => {
    assert.equal(ttsLogger.audioSecondsFromBuffer(null), null);
    assert.equal(ttsLogger.audioSecondsFromBuffer(Buffer.alloc(0)), null);
    assert.equal(ttsLogger.audioSecondsFromBuffer('no buffer'), null);
});

test.after(() => {
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch(_) {}
});

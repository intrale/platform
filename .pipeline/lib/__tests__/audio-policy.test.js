// =============================================================================
// Tests audio-policy.js + wiring #4586 — Audio TTS por tipo de evento.
//
// Cubre:
//   - shouldEmitAudio: defaults por evento, override by_event, kill_switch,
//     enabled=false, política ausente, eventos desconocidos.
//   - deliverable-notify.resolveEventAudio: precedencia política > flag legacy.
//   - deliverable-notify.resolveThreadId: normalización del thread id.
//   - servicio-telegram.normalizeThreadId: normalización defensiva.
//   - notify(): con audioPolicy `agent_deliverable: false` NO dispara audio,
//     y con `telegram_thread_id` inyecta `message_thread_id` en el dropfile.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ap = require('../audio-policy');
const dn = require('../deliverable-notify');
const st = require('../../servicio-telegram');

function mkTmpRoot() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-policy-test-'));
    return {
        root: dir,
        cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} },
    };
}

// Política que refleja el config default del #4586.
function defaultPolicy(overrides) {
    return Object.assign({
        enabled: true,
        kill_switch: false,
        by_event: {
            commander_reply: true,
            rejection_report: true,
            status: true,
            gate_signature: true,
            agent_deliverable: false,
            cua_stage: false,
        },
    }, overrides || {});
}

// -----------------------------------------------------------------------------
// shouldEmitAudio — defaults por evento
// -----------------------------------------------------------------------------

test('shouldEmitAudio · sin política usa DEFAULT_BY_EVENT (atención=on, firehose=off)', () => {
    assert.equal(ap.shouldEmitAudio(null, ap.EVENT.COMMANDER_REPLY), true);
    assert.equal(ap.shouldEmitAudio(undefined, ap.EVENT.REJECTION_REPORT), true);
    assert.equal(ap.shouldEmitAudio(null, ap.EVENT.STATUS), true);
    assert.equal(ap.shouldEmitAudio(null, ap.EVENT.GATE_SIGNATURE), true);
    assert.equal(ap.shouldEmitAudio(null, ap.EVENT.AGENT_DELIVERABLE), false);
    assert.equal(ap.shouldEmitAudio(null, ap.EVENT.CUA_STAGE), false);
});

test('shouldEmitAudio · evento desconocido cae a false (conservador)', () => {
    assert.equal(ap.shouldEmitAudio(defaultPolicy(), 'evento_inexistente'), false);
    assert.equal(ap.shouldEmitAudio(null, undefined), false);
});

test('shouldEmitAudio · by_event declarado gana sobre el default del módulo', () => {
    // agent_deliverable default false, pero la política lo fuerza a true.
    const pol = defaultPolicy({ by_event: { agent_deliverable: true } });
    assert.equal(ap.shouldEmitAudio(pol, ap.EVENT.AGENT_DELIVERABLE), true);
    // status no declarado en este by_event → cae al DEFAULT_BY_EVENT (true).
    assert.equal(ap.shouldEmitAudio(pol, ap.EVENT.STATUS), true);
});

test('shouldEmitAudio · by_event con valor no-true se interpreta como false', () => {
    const pol = defaultPolicy({ by_event: { status: 'yes' } });
    assert.equal(ap.shouldEmitAudio(pol, ap.EVENT.STATUS), false);
});

test('shouldEmitAudio · kill_switch corta TODO el audio', () => {
    const pol = defaultPolicy({ kill_switch: true });
    assert.equal(ap.shouldEmitAudio(pol, ap.EVENT.COMMANDER_REPLY), false);
    assert.equal(ap.shouldEmitAudio(pol, ap.EVENT.STATUS), false);
    assert.equal(ap.shouldEmitAudio(pol, ap.EVENT.AGENT_DELIVERABLE), false);
});

test('shouldEmitAudio · enabled=false apaga la política', () => {
    const pol = defaultPolicy({ enabled: false });
    assert.equal(ap.shouldEmitAudio(pol, ap.EVENT.STATUS), false);
    assert.equal(ap.shouldEmitAudio(pol, ap.EVENT.COMMANDER_REPLY), false);
});

test('shouldEmitAudio · config default del #4586 → agente silencioso, resto con audio', () => {
    const pol = defaultPolicy();
    assert.equal(ap.shouldEmitAudio(pol, ap.EVENT.AGENT_DELIVERABLE), false);
    assert.equal(ap.shouldEmitAudio(pol, ap.EVENT.CUA_STAGE), false);
    assert.equal(ap.shouldEmitAudio(pol, ap.EVENT.COMMANDER_REPLY), true);
    assert.equal(ap.shouldEmitAudio(pol, ap.EVENT.REJECTION_REPORT), true);
    assert.equal(ap.shouldEmitAudio(pol, ap.EVENT.STATUS), true);
});

// -----------------------------------------------------------------------------
// resolveEventAudio — precedencia política vs flag legacy
// -----------------------------------------------------------------------------

test('resolveEventAudio · con política presente, ignora el flag legacy audio_enabled', () => {
    // Legacy diría true, pero la política dice false para agent_deliverable.
    const r = dn.resolveEventAudio(
        { audio_enabled: true }, defaultPolicy(), ap.EVENT.AGENT_DELIVERABLE,
    );
    assert.equal(r, false);
});

test('resolveEventAudio · sin política cae al flag legacy (back-compat)', () => {
    assert.equal(
        dn.resolveEventAudio({ audio_enabled: true }, null, ap.EVENT.AGENT_DELIVERABLE),
        true,
    );
    assert.equal(
        dn.resolveEventAudio({ audio_enabled: false }, null, ap.EVENT.AGENT_DELIVERABLE),
        false,
    );
    assert.equal(
        dn.resolveEventAudio({ audio_enabled: true, kill_switch_audio: true }, null, ap.EVENT.AGENT_DELIVERABLE),
        false,
    );
});

// -----------------------------------------------------------------------------
// resolveThreadId / normalizeThreadId — Palanca 2a
// -----------------------------------------------------------------------------

test('resolveThreadId · entero positivo → tal cual; inválidos → null', () => {
    assert.equal(dn.resolveThreadId({ telegram_thread_id: 42 }), 42);
    assert.equal(dn.resolveThreadId({ telegram_thread_id: '7' }), 7);
    assert.equal(dn.resolveThreadId({ telegram_thread_id: null }), null);
    assert.equal(dn.resolveThreadId({ telegram_thread_id: 0 }), null);
    assert.equal(dn.resolveThreadId({ telegram_thread_id: -3 }), null);
    assert.equal(dn.resolveThreadId({ telegram_thread_id: 'abc' }), null);
    assert.equal(dn.resolveThreadId({}), null);
    assert.equal(dn.resolveThreadId(null), null);
});

test('normalizeThreadId (servicio-telegram) · idem contract que resolveThreadId', () => {
    assert.equal(st.normalizeThreadId(42), 42);
    assert.equal(st.normalizeThreadId('7'), 7);
    assert.equal(st.normalizeThreadId(null), null);
    assert.equal(st.normalizeThreadId(undefined), null);
    assert.equal(st.normalizeThreadId(0), null);
    assert.equal(st.normalizeThreadId(-1), null);
    assert.equal(st.normalizeThreadId('no'), null);
});

// -----------------------------------------------------------------------------
// notify() — integración con la política #4586
// -----------------------------------------------------------------------------

function deliverableCfg(overrides) {
    return Object.assign({
        enabled: true,
        kill_switch: false,
        skills: ['guru', 'po', 'ux', 'planner'],
        truncate_chars: 1500,
        dedup_window_hours: 24,
        audit_file: '.pipeline/audit/deliverable-notifications.jsonl',
        // El flag legacy en true a propósito: la política debe ganarle.
        audio_enabled: true,
        kill_switch_audio: false,
        audio_root: '.pipeline/audio/notifications',
        max_tts_chunks: 3,
        tts_chunk_timeout_ms: 30000,
    }, overrides || {});
}

test('notify · con audioPolicy agent_deliverable:false NO dispara audio (firehose silencioso)', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const calls = [];
        const result = dn.notify({
            issue: 4586, skill: 'guru', fase: 'analisis', pipeline: 'definicion',
            yaml: { notas: 'preview del entregable' },
            config: deliverableCfg(),
            audioPolicy: defaultPolicy(),
            pipelineRoot: root,
            telegramQueueDir: path.join(root, 'tg'),
            deps: { writeQueueFile: (p, payload) => calls.push({ p, payload }) },
        });
        assert.equal(result.ok, true);
        assert.equal(result.audioTask, null, 'sin audioTask pese a audio_enabled:true legacy');
        assert.equal(result.audit.audio_pending, undefined);
        // El texto igual se encoló.
        assert.equal(calls.length, 1);
        assert.ok(calls[0].payload.text, 'dropfile de texto presente');
    } finally { cleanup(); }
});

test('notify · con telegram_thread_id inyecta message_thread_id en el dropfile', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const calls = [];
        dn.notify({
            issue: 4586, skill: 'guru', fase: 'analisis', pipeline: 'definicion',
            yaml: { notas: 'preview' },
            config: deliverableCfg({ telegram_thread_id: 99 }),
            audioPolicy: defaultPolicy(),
            pipelineRoot: root,
            telegramQueueDir: path.join(root, 'tg'),
            deps: { writeQueueFile: (p, payload) => calls.push({ p, payload }) },
        });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].payload.message_thread_id, 99,
            'el firehose se enruta al topic separado');
    } finally { cleanup(); }
});

test('notify · sin telegram_thread_id NO agrega message_thread_id (General, back-compat)', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const calls = [];
        dn.notify({
            issue: 4586, skill: 'guru', fase: 'analisis', pipeline: 'definicion',
            yaml: { notas: 'preview' },
            config: deliverableCfg(),
            audioPolicy: defaultPolicy(),
            pipelineRoot: root,
            telegramQueueDir: path.join(root, 'tg'),
            deps: { writeQueueFile: (p, payload) => calls.push({ p, payload }) },
        });
        assert.equal(calls.length, 1);
        assert.equal(
            Object.prototype.hasOwnProperty.call(calls[0].payload, 'message_thread_id'),
            false,
        );
    } finally { cleanup(); }
});

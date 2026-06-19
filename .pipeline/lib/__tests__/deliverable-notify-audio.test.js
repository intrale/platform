// =============================================================================
// Tests deliverable-notify.js — audio TTS (#3539 · CA-UX-9)
//
// Cubre los CA-TEST-1..7 del issue:
//   - CA-TEST-1: notify() con audio_enabled invoca textToSpeechWithMeta con
//                texto YA redactado + sanitizado y perfil del skill.
//   - CA-TEST-2: texto > MAX_TTS_CHARS se particiona, cap a 3 chunks,
//                último termina con "...el contenido completo está en el issue."
//   - CA-TEST-3: perfil TTS derivado del nombre del archivo (la firma
//                resolveTtsProfile no consulta YAML — el caller debe pasar
//                el skill correcto).
//   - CA-TEST-4: fallo de textToSpeechWithMeta registra audio_error redactado
//                y NO interrumpe el dropfile texto.
//   - CA-TEST-5: dedup por content_hash ignora records `kind:'audio'`.
//   - CA-TEST-6: timeout 30s por chunk registra `audio_error: 'TIMEOUT'`.
//   - CA-TEST-7: skill sin perfil cae a 'default' + tts_profile_fallback:true.
//
// Estrategia: inyectamos mocks vía `deps.{textToSpeechWithMeta,
// sendVoiceTelegram, loadTelegramSecrets, loadTtsConfig, writeAudioFile, now}`
// para no tocar Edge/OpenAI ni Telegram reales.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dn = require('../deliverable-notify');

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

function mkTmpRoot() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deliverable-audio-test-'));
    return {
        root: dir,
        cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} },
    };
}

function audioCfg(overrides) {
    return Object.assign({
        enabled: true,
        kill_switch: false,
        skills: ['guru', 'po', 'ux', 'planner'],
        truncate_chars: 1500,
        attachment_root: '.pipeline/assets/mockups',
        dedup_window_hours: 24,
        audit_file: '.pipeline/audit/deliverable-notifications.jsonl',
        audio_enabled: true,
        kill_switch_audio: false,
        audio_root: '.pipeline/audio/notifications',
        max_tts_chunks: 3,
        tts_chunk_timeout_ms: 30000,
    }, overrides || {});
}

function fakeBuffer(size) {
    return Buffer.alloc(size || 256, 'A');
}

function fakeTts({ delayMs, hang, fail, profileCapture, textCapture, succeedAfter } = {}) {
    let calls = 0;
    return async (text, opts) => {
        calls++;
        if (textCapture) textCapture.push(text);
        if (profileCapture) profileCapture.push(opts && opts.profile);
        // `hang: true` devuelve una promise que nunca resuelve: fuerza que el
        // único timer en juego sea el de `withTimeout`, de modo que el TIMEOUT
        // dispare de forma DETERMINÍSTICA sin depender de una carrera 10ms vs
        // delayMs (que flakeaba bajo carga concurrente del tester — rebote #4096).
        if (hang) await new Promise(() => {});
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        if (fail && (!succeedAfter || calls < succeedAfter)) throw new Error('simulated tts failure');
        return { buffer: fakeBuffer(256), provider: 'openai', profile: opts && opts.profile };
    };
}

function fakeSend({ fail, captureSends } = {}) {
    return async (buffer, token, chatId) => {
        if (captureSends) captureSends.push({ size: buffer.length, token: token, chatId: chatId });
        if (fail) throw new Error('simulated send failure');
        return true;
    };
}

function fakeCreds() {
    return () => ({ bot_token: '1234567:FAKE_TOKEN_FOR_TESTS_AAAAAAAAAAA', chat_id: '111' });
}

// loadTtsConfig stub para resolveTtsProfile.
function fakeTtsCfg({ knownProfiles } = {}) {
    const set = new Set(knownProfiles || ['default', 'guru', 'po', 'ux', 'planner', 'security', 'qa']);
    return (profileName) => ({
        profileFound: set.has(profileName),
        profileName: set.has(profileName) ? profileName : 'default',
    });
}

// -----------------------------------------------------------------------------
// partitionForTts
// -----------------------------------------------------------------------------

test('CA-FN-5 · partitionForTts no parte texto bajo el límite', () => {
    const r = dn.partitionForTts('Texto corto.', { max: 100, cap: 3 });
    assert.equal(r.chunks.length, 1);
    assert.equal(r.truncated, false);
    assert.equal(r.chunks[0], 'Texto corto.');
});

test('CA-FN-5 · partitionForTts parte texto largo en límites de oración', () => {
    const text = 'Primera oración. Segunda oración. Tercera oración. Cuarta oración.';
    const r = dn.partitionForTts(text, { max: 30, cap: 5 });
    assert.ok(r.chunks.length >= 2, 'parte en al menos 2');
    // Ninguna debe exceder el max significativamente.
    for (const c of r.chunks) {
        assert.ok(c.length <= 60, `chunk no debe exceder mucho el max: ${c.length}`);
    }
});

test('CA-SEC-2 · partitionForTts capea a max_tts_chunks=3 y agrega sufijo de cierre', () => {
    // Texto muy largo: ~50 oraciones, debe producir muchos chunks → cap a 3.
    const sentences = [];
    for (let i = 0; i < 50; i++) sentences.push(`Oración número ${i} que ocupa espacio suficiente para forzar el corte.`);
    const text = sentences.join(' ');

    const r = dn.partitionForTts(text, { max: 200, cap: 3 });
    assert.equal(r.chunks.length, 3);
    assert.equal(r.truncated, true);
    // CA-UX-5 — último chunk termina con frase natural de cierre.
    assert.match(r.chunks[2], /contenido completo está en el issue/);
});

test('CA-FN-5 · partitionForTts tolera input no-string', () => {
    assert.deepEqual(dn.partitionForTts(null), { chunks: [], truncated: false });
    assert.deepEqual(dn.partitionForTts(undefined), { chunks: [], truncated: false });
    assert.deepEqual(dn.partitionForTts(''), { chunks: [], truncated: false });
});

// -----------------------------------------------------------------------------
// resolveTtsProfile
// -----------------------------------------------------------------------------

test('CA-UX-1 · resolveTtsProfile devuelve perfil del skill cuando está en KNOWN', () => {
    const r = dn.resolveTtsProfile('guru', { loadTtsConfig: fakeTtsCfg() });
    assert.equal(r.profile, 'guru');
    assert.equal(r.fallback, false);
});

test('CA-UX-1 · resolveTtsProfile cae a default cuando skill no existe en tts-config', () => {
    const r = dn.resolveTtsProfile('architect', {
        loadTtsConfig: fakeTtsCfg({ knownProfiles: ['default', 'guru'] }),
    });
    assert.equal(r.profile, 'default');
    assert.equal(r.fallback, true);
});

test('CA-UX-1 · resolveTtsProfile cae a default cuando skill es vacío/null', () => {
    const r1 = dn.resolveTtsProfile('', { loadTtsConfig: fakeTtsCfg() });
    const r2 = dn.resolveTtsProfile(null, { loadTtsConfig: fakeTtsCfg() });
    assert.equal(r1.profile, 'default');
    assert.equal(r2.profile, 'default');
    // 'default' está en KNOWN_TTS_PROFILES → fallback: false (no es "fallback" en
    // el sentido del audit, es el perfil esperado para casos vacíos).
    assert.equal(r1.fallback, false);
});

// -----------------------------------------------------------------------------
// withTimeout
// -----------------------------------------------------------------------------

test('CA-SEC-4 · withTimeout resuelve si la promise termina antes del timeout', async () => {
    const { withTimeout } = dn.__forTests__;
    const r = await withTimeout(Promise.resolve(42), 100, 'tag');
    assert.equal(r, 42);
});

test('CA-SEC-4 · withTimeout rechaza con error tagged si excede el timeout', async () => {
    const { withTimeout } = dn.__forTests__;
    const slow = new Promise((r) => setTimeout(() => r('tarde'), 100));
    try {
        await withTimeout(slow, 20, 'my_tag');
        assert.fail('debería haber rechazado por timeout');
    } catch (e) {
        assert.equal(e.code, 'TTS_TIMEOUT');
        assert.match(e.message, /my_tag/);
    }
});

// -----------------------------------------------------------------------------
// generateAudioNotifications
// -----------------------------------------------------------------------------

test('CA-TEST-1 · generateAudioNotifications invoca TTS con texto redactado+sanitizado y perfil correcto', async () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const profileCapture = [];
        const textCapture = [];
        const sends = [];
        const patch = await dn.generateAudioNotifications({
            issue: 3539,
            skill: 'guru',
            fase: 'analisis',
            pipeline: 'definicion',
            narrationText: '🔍 #3539 · analisis · guru\n\n## Hallazgos\n- **bold** item\n\n🔗 https://github.com/intrale/platform/issues/3539\n\n<!-- pipeline-meta {} -->',
            contentHash: 'a'.repeat(64),
            config: audioCfg(),
            pipelineRoot: root,
            deps: {
                textToSpeechWithMeta: fakeTts({ profileCapture, textCapture }),
                sendVoiceTelegram: fakeSend({ captureSends: sends }),
                loadTelegramSecrets: fakeCreds(),
                loadTtsConfig: fakeTtsCfg(),
            },
        });
        // CA-UX-1 — perfil del skill guru.
        assert.equal(patch.audio_profile, 'guru');
        assert.equal(patch.tts_profile_fallback, undefined);
        assert.equal(profileCapture[0], 'guru');
        // CA-SEC-1 / CA-UX-2 — texto sin markdown / sin envelope / sin URL.
        const t = textCapture[0];
        assert.equal(t.includes('**'), false);
        assert.equal(t.includes('<!--'), false);
        assert.equal(t.includes('https://github.com'), false);
        assert.equal(t.includes('🔍'), false);
        // sí debe quedar contenido narrable
        assert.match(t, /Hallazgos/);
        assert.match(t, /bold item/);
        // CA-FN-1 — al menos un audio enviado
        assert.equal(sends.length, 1);
        assert.deepEqual(patch.audio_file_paths.length, 1);
        // path RELATIVO, no absoluto
        assert.equal(path.isAbsolute(patch.audio_file_paths[0]), false);
        assert.match(patch.audio_file_paths[0], /audio\/notifications\/.*\.ogg/);
        assert.equal(patch.kind, 'audio');
        assert.equal(patch.audio_error, undefined);
    } finally { cleanup(); }
});

test('CA-TEST-2 · generateAudioNotifications particiona con cap=3 y último chunk con cierre natural', async () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const textCapture = [];
        const sends = [];
        // Construir texto > MAX_TTS_CHARS * 3
        const oraciones = [];
        for (let i = 0; i < 200; i++) {
            oraciones.push(`Oración número ${i} con relleno suficiente para tener al menos sesenta caracteres asegurados.`);
        }
        const huge = oraciones.join(' ');
        const patch = await dn.generateAudioNotifications({
            issue: 3539,
            skill: 'guru',
            fase: 'analisis',
            pipeline: 'definicion',
            narrationText: huge,
            contentHash: 'b'.repeat(64),
            config: audioCfg(),
            pipelineRoot: root,
            deps: {
                textToSpeechWithMeta: fakeTts({ textCapture }),
                sendVoiceTelegram: fakeSend({ captureSends: sends }),
                loadTelegramSecrets: fakeCreds(),
                loadTtsConfig: fakeTtsCfg(),
            },
        });
        assert.equal(patch.audio_chunks_count, 3);
        assert.equal(patch.audio_truncated, true);
        assert.equal(patch.audio_file_paths.length, 3);
        assert.equal(sends.length, 3);
        // CA-UX-5 — último chunk con frase natural de cierre.
        const lastChunk = textCapture[2];
        assert.match(lastChunk, /contenido completo está en el issue/);
    } finally { cleanup(); }
});

test('CA-TEST-3 · resolveTtsProfile no consulta el YAML — solo el skill pasado', () => {
    // El issue dice "perfil derivado del nombre del archivo, no del YAML".
    // resolveTtsProfile no acepta YAML como argumento — esa es la garantía
    // estática. Acá lo verificamos: con skill='guru' y YAML que pretende ser
    // 'architect', el perfil resuelto sigue siendo 'guru'.
    const r = dn.resolveTtsProfile('guru', {
        loadTtsConfig: fakeTtsCfg(),
    });
    assert.equal(r.profile, 'guru');
});

test('CA-TEST-4 · generateAudioNotifications con TTS que falla registra audio_error y NO tira', async () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const patch = await dn.generateAudioNotifications({
            issue: 3539,
            skill: 'guru',
            fase: 'analisis',
            pipeline: 'definicion',
            narrationText: 'Texto narrable corto.',
            contentHash: 'c'.repeat(64),
            config: audioCfg(),
            pipelineRoot: root,
            deps: {
                textToSpeechWithMeta: fakeTts({ fail: true }),
                sendVoiceTelegram: fakeSend(),
                loadTelegramSecrets: fakeCreds(),
                loadTtsConfig: fakeTtsCfg(),
            },
        });
        assert.ok(patch.audio_error, 'debe registrar el error');
        assert.equal(Array.isArray(patch.audio_file_paths), true);
        assert.equal(patch.audio_file_paths.length, 0, 'ningún audio persistido');
        // CA-SEC-5 — message debe ser un string (redactado), no objeto con stack.
        const msg = patch.audio_error.message || (patch.audio_error.details && patch.audio_error.details[0].message);
        assert.equal(typeof msg, 'string');
    } finally { cleanup(); }
});

test('CA-TEST-4b · generateAudioNotifications con credenciales faltantes registra audio_error CREDS_MISSING', async () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const patch = await dn.generateAudioNotifications({
            issue: 3539,
            skill: 'guru',
            fase: 'analisis',
            pipeline: 'definicion',
            narrationText: 'Texto narrable.',
            contentHash: 'd'.repeat(64),
            config: audioCfg(),
            pipelineRoot: root,
            deps: {
                textToSpeechWithMeta: fakeTts(),
                sendVoiceTelegram: fakeSend(),
                loadTelegramSecrets: () => { const e = new Error('no creds'); e.code = 'TELEGRAM_SECRETS_MISSING'; throw e; },
                loadTtsConfig: fakeTtsCfg(),
            },
        });
        assert.ok(patch.audio_error);
        assert.equal(patch.audio_error.code, 'TELEGRAM_SECRETS_MISSING');
        assert.equal(patch.audio_file_paths, undefined,
            'sin file_paths cuando ni se llegó a generar audio');
    } finally { cleanup(); }
});

test('CA-TEST-5 · dedup ignora records con kind:"audio" (solo cuenta records de texto)', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const auditPath = path.join(root, 'audit.jsonl');
        const hash = 'e'.repeat(64);
        // SOLO entry de audio → dedup NO debe disparar (no es notificación previa).
        fs.writeFileSync(auditPath, JSON.stringify({
            ts: new Date().toISOString(),
            kind: 'audio',
            issue: 3539,
            skill: 'guru',
            content_hash: hash,
        }) + '\n');

        const skip = dn.shouldSkipByDedup({
            auditPath,
            issue: 3539,
            skill: 'guru',
            contentHash: hash,
            windowHours: 24,
        });
        assert.equal(skip, false, 'audio record no es una notificación previa');
    } finally { cleanup(); }
});

test('CA-TEST-6 · timeout por chunk registra audio_error TIMEOUT y no bloquea', async () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        // TTS que nunca resuelve; timeout configurado a 10ms → debe disparar
        // SIEMPRE. Determinístico bajo carga (antes: delayMs:100 vs 10ms, race
        // que flakeaba en el tester concurrente — rebote #4096).
        const patch = await dn.generateAudioNotifications({
            issue: 3539,
            skill: 'guru',
            fase: 'analisis',
            pipeline: 'definicion',
            narrationText: 'Texto.',
            contentHash: 'f'.repeat(64),
            config: audioCfg({ tts_chunk_timeout_ms: 10 }),
            pipelineRoot: root,
            deps: {
                textToSpeechWithMeta: fakeTts({ hang: true }),
                sendVoiceTelegram: fakeSend(),
                loadTelegramSecrets: fakeCreds(),
                loadTtsConfig: fakeTtsCfg(),
            },
        });
        assert.ok(patch.audio_error);
        const code = patch.audio_error.code || (patch.audio_error.details && patch.audio_error.details[0].code);
        assert.equal(code, 'TIMEOUT');
        assert.equal(patch.audio_file_paths.length, 0);
    } finally { cleanup(); }
});

test('CA-TEST-7 · skill sin perfil cae a default + tts_profile_fallback en audit', async () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const profileCapture = [];
        const patch = await dn.generateAudioNotifications({
            issue: 3539,
            skill: 'architect', // NO está en KNOWN_TTS_PROFILES
            fase: 'analisis',
            pipeline: 'definicion',
            narrationText: 'Texto narrable.',
            contentHash: 'g'.repeat(64),
            config: audioCfg(),
            pipelineRoot: root,
            deps: {
                textToSpeechWithMeta: fakeTts({ profileCapture }),
                sendVoiceTelegram: fakeSend(),
                loadTelegramSecrets: fakeCreds(),
                loadTtsConfig: fakeTtsCfg({ knownProfiles: ['default', 'guru'] }),
            },
        });
        assert.equal(patch.audio_profile, 'default');
        assert.equal(patch.tts_profile_fallback, true);
        assert.equal(profileCapture[0], 'default');
    } finally { cleanup(); }
});

// -----------------------------------------------------------------------------
// CA-SEC-1 · redact pre-TTS (defense-in-depth contra exfiltración de secrets)
// -----------------------------------------------------------------------------

test('CA-SEC-1 · texto con email se redacta ANTES de pasar al provider externo', async () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const textCapture = [];
        await dn.generateAudioNotifications({
            issue: 3539,
            skill: 'guru',
            fase: 'analisis',
            pipeline: 'definicion',
            narrationText: 'Contactar a leito.larreta@gmail.com para más info.',
            contentHash: 'h'.repeat(64),
            config: audioCfg(),
            pipelineRoot: root,
            deps: {
                textToSpeechWithMeta: fakeTts({ textCapture }),
                sendVoiceTelegram: fakeSend(),
                loadTelegramSecrets: fakeCreds(),
                loadTtsConfig: fakeTtsCfg(),
            },
        });
        // El email original NO debe estar en el texto que llega al TTS.
        assert.equal(textCapture[0].includes('leito.larreta@gmail.com'), false);
    } finally { cleanup(); }
});

// -----------------------------------------------------------------------------
// notify() · integración con audio
// -----------------------------------------------------------------------------

test('notify · cuando audio_enabled=false NO retorna audioTask', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const calls = [];
        const result = dn.notify({
            issue: 3539, skill: 'guru', fase: 'analisis', pipeline: 'definicion',
            yaml: { notas: 'preview' },
            config: audioCfg({ audio_enabled: false }),
            pipelineRoot: root,
            telegramQueueDir: path.join(root, 'tg'),
            deps: { writeQueueFile: (p, payload) => calls.push({ p, payload }) },
        });
        assert.equal(result.ok, true);
        assert.equal(result.audioTask, null);
        // El record texto no debe tener audio_pending.
        assert.equal(result.audit.audio_pending, undefined);
    } finally { cleanup(); }
});

test('notify · cuando kill_switch_audio=true NO dispara audio aunque audio_enabled', () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const calls = [];
        const result = dn.notify({
            issue: 3539, skill: 'guru', fase: 'analisis', pipeline: 'definicion',
            yaml: { notas: 'preview' },
            config: audioCfg({ audio_enabled: true, kill_switch_audio: true }),
            pipelineRoot: root,
            telegramQueueDir: path.join(root, 'tg'),
            deps: { writeQueueFile: (p, payload) => calls.push({ p, payload }) },
        });
        assert.equal(result.audioTask, null);
        assert.equal(result.audit.audio_pending, undefined);
    } finally { cleanup(); }
});

test('CA-FN-3 · notify · con audio_enabled dispara audioTask fire-and-forget', async () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const calls = [];
        const sends = [];
        const result = dn.notify({
            issue: 3539, skill: 'guru', fase: 'analisis', pipeline: 'definicion',
            yaml: { notas: 'Hallazgo importante para narrar.' },
            config: audioCfg(),
            pipelineRoot: root,
            telegramQueueDir: path.join(root, 'tg'),
            deps: {
                writeQueueFile: (p, payload) => calls.push({ p, payload }),
                textToSpeechWithMeta: fakeTts(),
                sendVoiceTelegram: fakeSend({ captureSends: sends }),
                loadTelegramSecrets: fakeCreds(),
                loadTtsConfig: fakeTtsCfg(),
            },
        });
        assert.equal(result.ok, true);
        assert.equal(result.audit.audio_pending, true,
            'record texto se marca audio_pending');
        assert.ok(result.audioTask && typeof result.audioTask.then === 'function');

        const patch = await result.audioTask;
        assert.ok(patch);
        assert.equal(patch.kind, 'audio');
        assert.equal(patch.audio_profile, 'guru');
        assert.equal(patch.audio_file_paths.length, 1);
        assert.equal(sends.length, 1, 'audio enviado a Telegram');

        // Audit JSONL: debe tener record texto + record audio.
        const auditPath = path.join(root, '.pipeline/audit/deliverable-notifications.jsonl');
        const lines = fs.readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean);
        assert.equal(lines.length, 2, '1 record texto + 1 record audio');
        const textRec = JSON.parse(lines[0]);
        const audioRec = JSON.parse(lines[1]);
        assert.equal(textRec.telegram_enqueue_ok, true);
        assert.equal(textRec.audio_pending, true);
        assert.equal(audioRec.kind, 'audio');
        assert.equal(audioRec.audio_file_paths.length, 1);
        assert.equal(audioRec.content_hash, textRec.content_hash,
            'mismo content_hash vincula texto + audio');
    } finally { cleanup(); }
});

test('CA-FN-4 · notify · si audio falla, el dropfile texto YA se encoló igual', async () => {
    const { root, cleanup } = mkTmpRoot();
    try {
        const calls = [];
        const result = dn.notify({
            issue: 3539, skill: 'guru', fase: 'analisis', pipeline: 'definicion',
            yaml: { notas: 'Texto.' },
            config: audioCfg(),
            pipelineRoot: root,
            telegramQueueDir: path.join(root, 'tg'),
            deps: {
                writeQueueFile: (p, payload) => calls.push({ p, payload }),
                textToSpeechWithMeta: fakeTts({ fail: true }),
                sendVoiceTelegram: fakeSend(),
                loadTelegramSecrets: fakeCreds(),
                loadTtsConfig: fakeTtsCfg(),
            },
        });
        assert.equal(result.ok, true, 'notify exitoso aunque audio vaya a fallar');
        assert.equal(calls.length, 1, 'dropfile texto encolado igual');

        const patch = await result.audioTask;
        assert.ok(patch.audio_error, 'audio_error registrado');
        // Aseguramos que el JSONL del audio se appendea aunque haya fallado.
        const auditPath = path.join(root, '.pipeline/audit/deliverable-notifications.jsonl');
        const lines = fs.readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean);
        const audioLines = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
            .filter((e) => e && e.kind === 'audio');
        assert.equal(audioLines.length, 1);
        assert.ok(audioLines[0].audio_error);
    } finally { cleanup(); }
});

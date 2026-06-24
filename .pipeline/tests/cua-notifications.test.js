// =============================================================================
// cua-notifications.test.js — Tests de notificaciones CUA (issue #3541).
//
// Cubre:
//   - CA-FUNC-1 / CA-SEC-4: schema válido pasa, schema inválido → fail closed.
//   - CA-FUNC-2: skill ficticio cua + envelope con `command` y `issue: null`.
//   - CA-FUNC-5: kill_switch + enabled + notifiable_stages se respetan.
//   - CA-FUNC-7 / CA-SEC-8: dedup CUA por (command, stage, ts_minuto, preview).
//   - CA-FUNC-9 / CA-UX-8: fire-and-forget (audioTask es Promise).
//   - CA-SEC-1: whitelist de extensiones; .exe/.sh/.html rechazados.
//   - CA-SEC-1 defense in depth: extensión declarada vs real.
//   - CA-SEC-2: cap de tamaño de adjunto.
//   - CA-SEC-3: command whitelist + regex.
//   - CA-SEC-5: path traversal rechazado, root hardcodeado.
//   - CA-SEC-7: redactSensitive aplicado antes del TTS.
//   - CA-UX-1: emojis correctos por (stage, status).
//   - CA-UX-2: preview con emoji inicial y trunc por chars.
//   - CA-UX-3: sanitizeCuaForTts elimina emojis y paths largos.
//   - CA-UX-5: header inequívoco `⚙️ /<cmd> — <stage>`, sin `#NNNN`.
//   - CA-UX-7: dedup window default 1h, no 24h.
//   - parseCuaTextArgs: branch CUA vs branch issue.
//   - `/rechazar` CUA sin chat_id autorizado → unauthorized_rebobinar.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const dn = require('../lib/deliverable-notify');
const cd = require('../lib/commander-deterministic');
const rh = require('../lib/commander/rechazar-handler');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkTmp(name) {
    const dir = path.join(os.tmpdir(), `cua-test-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, 'queue'), { recursive: true });
    return dir;
}

function baseConfig(overrides) {
    return Object.assign({
        enabled: true,
        kill_switch: false,
        notifiable_stages: ['init', 'validation', 'analysis', 'completion'],
        allowed_commands: ['load-wave', 'wave', 'validate-issue'],
        truncate_chars: 1500,
        dedup_window_hours: 1,
        max_attachment_bytes: 5 * 1024 * 1024,
        attachment_subroot: '',
        audit_file: null,
        audio_enabled: false,
    }, overrides || {});
}

function notifyArgs(tmpDir, entregable, configOverrides) {
    const cfg = baseConfig(Object.assign({
        audit_file: path.join(tmpDir, 'audit.jsonl'),
    }, configOverrides || {}));
    return {
        entregable,
        config: cfg,
        pipelineRoot: tmpDir,
        telegramQueueDir: path.join(tmpDir, 'queue'),
    };
}

function readAudit(tmpDir) {
    const auditPath = path.join(tmpDir, 'audit.jsonl');
    if (!fs.existsSync(auditPath)) return [];
    return fs.readFileSync(auditPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// CA-FUNC-1 / CA-SEC-4 — Schema validation
// ---------------------------------------------------------------------------

test('schema válido pasa y enqueua dropfile', () => {
    const tmp = mkTmp('schema-ok');
    const r = dn.notifyCua(notifyArgs(tmp, {
        command: 'load-wave',
        stage: 'validation',
        status: 'ok',
        preview: '✅ Ola N+11 validada — 9 issues, 0 bloqueados',
    }));
    assert.equal(r.ok, true);
    assert.equal(r.action, 'enqueued');
    const queueFiles = fs.readdirSync(path.join(tmp, 'queue'));
    assert.equal(queueFiles.length, 1);
    assert.match(queueFiles[0], /^\d+-cua-load-wave-validation\.json$/);
});

test('schema inválido (stage no enum) → fail closed con audit schema_invalid', () => {
    const tmp = mkTmp('schema-fail');
    const r = dn.notifyCua(notifyArgs(tmp, {
        command: 'load-wave',
        stage: 'eviction',     // no es enum
        status: 'ok',
    }));
    assert.equal(r.ok, false);
    assert.equal(r.action, 'rejected');
    assert.equal(r.reason, 'schema_invalid');
    const audit = readAudit(tmp);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].rejected, true);
    assert.equal(audit[0].reject_reason, 'schema_invalid');
    assert.equal(audit[0].issue, null);
    assert.equal(audit[0].command, 'load-wave');
});

test('schema inválido (status no enum) → fail closed', () => {
    const tmp = mkTmp('schema-status');
    const r = dn.notifyCua(notifyArgs(tmp, {
        command: 'load-wave',
        stage: 'validation',
        status: 'invented',     // no es ok|fail|in_progress
    }));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'schema_invalid');
});

test('schema falta `command` → fail closed', () => {
    const tmp = mkTmp('schema-no-cmd');
    const r = dn.notifyCua(notifyArgs(tmp, {
        stage: 'validation',
        status: 'ok',
    }));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'schema_invalid');
});

// ---------------------------------------------------------------------------
// CA-FUNC-2 — Envelope con command + issue:null
// ---------------------------------------------------------------------------

test('envelope incluye command + issue:null + skill:cua + pipeline:cua', () => {
    const tmp = mkTmp('envelope');
    const r = dn.notifyCua(notifyArgs(tmp, {
        command: 'load-wave',
        stage: 'completion',
        status: 'ok',
        preview: 'Comando completado.',
    }));
    assert.equal(r.ok, true);
    const m = r.payload.text.match(/<!-- pipeline-meta (\{.*?\}) -->/);
    assert.ok(m, 'envelope HTML comment debe estar presente');
    const env = JSON.parse(m[1]);
    assert.equal(env.issue, null);
    assert.equal(env.command, 'load-wave');
    assert.equal(env.stage, 'completion');
    assert.equal(env.skill, 'cua');
    assert.equal(env.pipeline, 'cua');
    assert.ok(Number.isFinite(env.ts));
});

// ---------------------------------------------------------------------------
// CA-FUNC-5 — Flags de config respetados
// ---------------------------------------------------------------------------

test('enabled:false → action skipped reason disabled', () => {
    const tmp = mkTmp('disabled');
    const r = dn.notifyCua(notifyArgs(tmp, {
        command: 'load-wave', stage: 'validation', status: 'ok',
    }, { enabled: false }));
    assert.equal(r.ok, false);
    assert.equal(r.action, 'skipped');
    assert.equal(r.reason, 'disabled');
});

test('kill_switch:true → action skipped reason kill_switch', () => {
    const tmp = mkTmp('killsw');
    const r = dn.notifyCua(notifyArgs(tmp, {
        command: 'load-wave', stage: 'validation', status: 'ok',
    }, { kill_switch: true }));
    assert.equal(r.action, 'skipped');
    assert.equal(r.reason, 'kill_switch');
});

test('stage no notifiable → action skipped reason stage_not_notifiable', () => {
    const tmp = mkTmp('stage-filter');
    const r = dn.notifyCua(notifyArgs(tmp, {
        command: 'load-wave', stage: 'analysis', status: 'ok',
    }, { notifiable_stages: ['completion'] }));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'stage_not_notifiable');
});

// ---------------------------------------------------------------------------
// CA-FUNC-7 / CA-SEC-8 — Dedup CUA
// ---------------------------------------------------------------------------

test('dedup: dos notificaciones idénticas en el mismo minuto → segunda deduplicada', () => {
    const tmp = mkTmp('dedup');
    const args = notifyArgs(tmp, {
        command: 'load-wave', stage: 'validation', status: 'ok',
        preview: '✅ Misma cosa',
    });
    const r1 = dn.notifyCua(args);
    const r2 = dn.notifyCua(args);
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, false);
    assert.equal(r2.reason, 'dedup');
});

test('dedup: preview distinto → ambas notificadas (no es la misma key)', () => {
    const tmp = mkTmp('dedup-diff');
    const r1 = dn.notifyCua(notifyArgs(tmp, {
        command: 'load-wave', stage: 'validation', status: 'ok',
        preview: 'A',
    }));
    const r2 = dn.notifyCua(notifyArgs(tmp, {
        command: 'load-wave', stage: 'validation', status: 'ok',
        preview: 'B',
    }));
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
});

test('default dedup window es 1h (CA-UX-7), no 24h', () => {
    assert.equal(dn.DEFAULT_CUA_DEDUP_HOURS, 1);
});

// ---------------------------------------------------------------------------
// CA-SEC-1 — Whitelist de extensiones
// ---------------------------------------------------------------------------

test('whitelist de extensiones — .exe rechazado', () => {
    const tmp = mkTmp('ext-exe');
    fs.mkdirSync(path.join(tmp, '.pipeline', 'cua-outputs'), { recursive: true });
    const malware = path.join(tmp, '.pipeline', 'cua-outputs', 'mal.exe');
    fs.writeFileSync(malware, 'X');
    const r = dn.notifyCua(notifyArgs(tmp, {
        command: 'load-wave', stage: 'validation', status: 'ok',
        preview: 'OK',
        attachment: { type: 'exe', path: '.pipeline/cua-outputs/mal.exe' },
    }));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'schema_invalid');  // schema enum bloquea antes que el code
});

test('whitelist de extensiones — declared json + real exe rechazado por extension_mismatch', () => {
    const tmp = mkTmp('ext-mismatch');
    fs.mkdirSync(path.join(tmp, '.pipeline', 'cua-outputs'), { recursive: true });
    // attachment.type='json' es válido para schema, pero el archivo es .exe →
    // defense in depth rechaza por extension_mismatch.
    const fakeExe = path.join(tmp, '.pipeline', 'cua-outputs', 'fake.exe');
    fs.writeFileSync(fakeExe, '{}');
    const built = dn.buildCuaPayload({
        entregable: {
            command: 'load-wave', stage: 'validation', status: 'ok',
            preview: 'OK',
            attachment: { type: 'json', path: '.pipeline/cua-outputs/fake.exe' },
        },
        config: baseConfig(),
        pipelineRoot: tmp,
    });
    assert.equal(built.ok, true);
    assert.equal(built.attachmentRejected, true);
    assert.equal(built.rejectionReason, 'extension_mismatch');
});

test('ALLOWED_CUA_EXTENSIONS const incluye todas las del spec', () => {
    const expected = ['json', 'csv', 'xlsx', 'pdf', 'txt', 'md', 'log'];
    for (const ext of expected) {
        assert.ok(dn.ALLOWED_CUA_EXTENSIONS.includes(ext), `${ext} debe estar en ALLOWED_CUA_EXTENSIONS`);
    }
    // Y NO debe estar: .exe / .sh / etc
    for (const banned of ['exe', 'sh', 'bat', 'cmd', 'ps1', 'scr', 'js', 'html', 'lnk']) {
        assert.ok(!dn.ALLOWED_CUA_EXTENSIONS.includes(banned), `${banned} NO debe estar`);
    }
});

// ---------------------------------------------------------------------------
// CA-SEC-2 — Cap de tamaño
// ---------------------------------------------------------------------------

test('cap de tamaño: archivo más grande que cua.max_attachment_bytes → rechazo', () => {
    const tmp = mkTmp('size-cap');
    fs.mkdirSync(path.join(tmp, '.pipeline', 'cua-outputs'), { recursive: true });
    const big = path.join(tmp, '.pipeline', 'cua-outputs', 'big.json');
    fs.writeFileSync(big, '{"x":1}\n'.repeat(2000)); // ~16KB
    const built = dn.buildCuaPayload({
        entregable: {
            command: 'load-wave', stage: 'validation', status: 'ok',
            preview: 'OK',
            attachment: { type: 'json', path: '.pipeline/cua-outputs/big.json' },
        },
        config: baseConfig({ max_attachment_bytes: 1024 }), // cap 1KB
        pipelineRoot: tmp,
    });
    assert.equal(built.attachmentRejected, true);
    assert.equal(built.rejectionReason, 'attachment_too_large');
});

// ---------------------------------------------------------------------------
// CA-SEC-3 — Command whitelist + regex
// ---------------------------------------------------------------------------

test('command no en whitelist → command_not_in_whitelist', () => {
    const v = dn.validateCuaCommand('comando-no-conocido', ['load-wave']);
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'command_not_in_whitelist');
});

test('command con caracteres inválidos → regex mismatch (vía schema)', () => {
    const tmp = mkTmp('cmd-regex');
    const r = dn.notifyCua(notifyArgs(tmp, {
        command: '../etc/passwd', stage: 'validation', status: 'ok',
    }));
    assert.equal(r.ok, false);
    // schema bloquea por pattern antes que validateCuaCommand.
    assert.equal(r.reason, 'schema_invalid');
});

test('command vacío → empty_command', () => {
    const v = dn.validateCuaCommand('', ['load-wave']);
    assert.equal(v.ok, false);
});

test('command válido y en whitelist → ok', () => {
    const v = dn.validateCuaCommand('load-wave', ['load-wave', 'wave']);
    assert.equal(v.ok, true);
});

test('whitelist vacía → fail closed', () => {
    const v = dn.validateCuaCommand('load-wave', []);
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'no_allowed_commands_configured');
});

// ---------------------------------------------------------------------------
// CA-SEC-5 — Path traversal + root hardcodeado
// ---------------------------------------------------------------------------

test('path traversal con ../ → parent_segment', () => {
    const tmp = mkTmp('traversal');
    fs.mkdirSync(path.join(tmp, '.pipeline', 'cua-outputs'), { recursive: true });
    const v = dn.validateCuaAttachment(
        { type: 'json', path: '../../../etc/passwd' },
        { pipelineRoot: tmp },
    );
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'parent_segment');
});

test('path fuera del root hardcodeado → outside_root', () => {
    const tmp = mkTmp('outside');
    const v = dn.validateCuaAttachment(
        { type: 'json', path: '.pipeline/audit/secret.json' },
        { pipelineRoot: tmp },
    );
    assert.equal(v.ok, false);
    // .pipeline/audit no está bajo .pipeline/cua-outputs.
    assert.ok(v.reason === 'outside_root' || v.reason === 'file_not_found');
});

test('CUA_ATTACHMENT_ROOT está hardcodeado en código', () => {
    assert.equal(dn.CUA_ATTACHMENT_ROOT, '.pipeline/cua-outputs');
});

// ---------------------------------------------------------------------------
// CA-UX-1 — Emojis por stage/status
// ---------------------------------------------------------------------------

test('emojis por (stage, status)', () => {
    const e = dn.__forTests__.emojiForCuaStatus;
    assert.equal(e('init', 'ok'), '⏳');
    assert.equal(e('init', 'in_progress'), '🔄');
    assert.equal(e('validation', 'ok'), '✅');
    assert.equal(e('validation', 'fail'), '❌');
    assert.equal(e('analysis', 'ok'), '🔍');
    assert.equal(e('completion', 'ok'), '🎯');
    assert.equal(e('completion', 'fail'), '⚠️');
});

// ---------------------------------------------------------------------------
// CA-UX-3 — sanitizeCuaForTts
// ---------------------------------------------------------------------------

test('sanitizeCuaForTts elimina emojis', () => {
    const s = dn.__forTests__.sanitizeCuaForTts('✅ Ola validada 🎯');
    assert.ok(!s.includes('✅'));
    assert.ok(!s.includes('🎯'));
    assert.match(s, /Ola validada/);
});

test('sanitizeCuaForTts reemplaza paths/hashes largos', () => {
    const s = dn.__forTests__.sanitizeCuaForTts('Generado /home/leo/very/long/path/to/file.txt OK');
    assert.match(s, /archivo adjunto/);
    assert.ok(!s.includes('/home/leo'));
});

// ---------------------------------------------------------------------------
// CA-UX-5 — Header inequívoco
// ---------------------------------------------------------------------------

test('header incluye ⚙️ /<command> + stage, NO #NNNN', () => {
    const h = dn.__forTests__.buildCuaHeader('load-wave', 'validation', 'n11');
    assert.match(h, /^⚙️ \/load-wave n11/);
    assert.ok(!/#\d/.test(h));
});

// ---------------------------------------------------------------------------
// CA-FUNC-9 / CA-UX-8 — Fire-and-forget
// ---------------------------------------------------------------------------

test('audioTask es Promise (fire-and-forget) cuando audio_enabled', async () => {
    const tmp = mkTmp('audio');
    // Fakes: TTS y send que resuelven rápido sin tocar red.
    const fakeTts = async () => ({ buffer: Buffer.from('FAKE_OGG'), profile: 'default' });
    const fakeSend = async () => ({ ok: true });
    const fakeCreds = () => ({ bot_token: 'X', chat_id: '1' });
    const r = dn.notifyCua({
        entregable: {
            command: 'load-wave', stage: 'validation', status: 'ok',
            preview: 'OK validada',
        },
        config: baseConfig({
            audio_enabled: true,
            audit_file: path.join(tmp, 'audit.jsonl'),
            audio_root: path.join(tmp, 'audio'),
        }),
        pipelineRoot: tmp,
        telegramQueueDir: path.join(tmp, 'queue'),
        deps: {
            textToSpeechWithMeta: fakeTts,
            sendVoiceTelegram: fakeSend,
            loadTelegramSecrets: fakeCreds,
        },
    });
    assert.equal(r.ok, true);
    assert.ok(r.audioTask, 'audioTask debe estar presente cuando audio_enabled');
    assert.equal(typeof r.audioTask.then, 'function');
    const patch = await r.audioTask;
    assert.ok(patch, 'patch debe resolverse');
    assert.equal(patch.kind, 'audio_cua');
});

// ---------------------------------------------------------------------------
// CA-SEC-7 — redactSensitive aplicado antes del TTS
// ---------------------------------------------------------------------------

test('redactSensitive se aplica al texto pre-TTS', async () => {
    const tmp = mkTmp('redact');
    let ttsReceived = null;
    const fakeTts = async (text) => {
        ttsReceived = text;
        return { buffer: Buffer.from('OK') };
    };
    const fakeSend = async () => ({ ok: true });
    const fakeCreds = () => ({ bot_token: 'X', chat_id: '1' });
    const secret = 'AKIAIOSFODNN7EXAMPLE';
    const r = dn.notifyCua({
        entregable: {
            command: 'load-wave', stage: 'validation', status: 'ok',
            preview: `Token ${secret} OK`,
        },
        config: baseConfig({
            audio_enabled: true,
            audit_file: path.join(tmp, 'audit.jsonl'),
            audio_root: path.join(tmp, 'audio'),
        }),
        pipelineRoot: tmp,
        telegramQueueDir: path.join(tmp, 'queue'),
        deps: {
            textToSpeechWithMeta: fakeTts,
            sendVoiceTelegram: fakeSend,
            loadTelegramSecrets: fakeCreds,
        },
    });
    assert.equal(r.ok, true);
    await r.audioTask;
    assert.ok(ttsReceived, 'TTS debió recibir texto');
    assert.ok(!ttsReceived.includes(secret), `el secreto NO debe estar en el texto TTS: ${ttsReceived}`);
});

// ---------------------------------------------------------------------------
// commander-deterministic — createCuaEmitter + auto-emit
// ---------------------------------------------------------------------------

test('createCuaEmitter con enabled:false es noop seguro', () => {
    const e = cd.createCuaEmitter({ config: { enabled: false } });
    const r = e.emit({ command: 'load-wave', stage: 'init', status: 'in_progress' });
    assert.equal(r.action, 'skipped');
    assert.equal(r.reason, 'disabled');
});

test('createCuaEmitter filtra stages en el caller (CA-TEC-2)', () => {
    const calls = [];
    const fakeMod = {
        notifyCua: (a) => { calls.push(a); return { ok: true, action: 'enqueued' }; },
    };
    const e = cd.createCuaEmitter({
        config: { enabled: true, notifiable_stages: ['completion'] },
        deps: { deliverableNotify: fakeMod },
    });
    const r1 = e.emit({ command: 'load-wave', stage: 'init', status: 'ok' });
    assert.equal(r1.reason, 'stage_not_notifiable');
    assert.equal(calls.length, 0, 'notifyCua NO debe haber sido invocada');
    const r2 = e.emit({ command: 'load-wave', stage: 'completion', status: 'ok' });
    assert.equal(r2.ok, true);
    assert.equal(calls.length, 1);
});

test('dispatcher auto-emite init y completion para comandos en allowed_commands', async () => {
    const tmp = mkTmp('disp');
    const calls = [];
    const fakeMod = {
        notifyCua: (a) => { calls.push(a.entregable); return { ok: true, action: 'enqueued' }; },
    };
    // Necesitamos sumar el slash al set ANTES de crear el dispatcher.
    cd.DETERMINISTIC_SLASH.add('load-wave');
    try {
        const d = cd.createDispatcher({
            pipelineRoot: tmp,
            logsDir: tmp,
            expectedChatId: '1',
            handlers: { 'load-wave': () => ({ reply: 'OK' }) },
            cua: {
                config: {
                    enabled: true,
                    allowed_commands: ['load-wave'],
                    notifiable_stages: ['init', 'completion'],
                    audit_file: path.join(tmp, 'audit.jsonl'),
                },
                pipelineRoot: tmp,
                telegramQueueDir: path.join(tmp, 'queue'),
                deps: { deliverableNotify: fakeMod },
            },
        });
        const r = await d.dispatch({ chat_id: '1', text: '/load-wave', from: 'tester' });
        assert.equal(r.status, 'ok');
        assert.equal(calls.length, 2, 'init + completion');
        assert.equal(calls[0].stage, 'init');
        assert.equal(calls[1].stage, 'completion');
        assert.equal(calls[1].status, 'ok');
    } finally {
        cd.DETERMINISTIC_SLASH.delete('load-wave');
    }
});

test('handler puede emitir stages intermedios via ctx.cuaEmit', async () => {
    const tmp = mkTmp('disp2');
    const calls = [];
    const fakeMod = {
        notifyCua: (a) => { calls.push(a.entregable); return { ok: true, action: 'enqueued' }; },
    };
    cd.DETERMINISTIC_SLASH.add('load-wave');
    try {
        const d = cd.createDispatcher({
            pipelineRoot: tmp,
            logsDir: tmp,
            expectedChatId: '1',
            handlers: {
                'load-wave': ({ cuaEmit }) => {
                    cuaEmit({ command: 'load-wave', stage: 'validation', status: 'ok', preview: '✅' });
                    cuaEmit({ command: 'load-wave', stage: 'analysis', status: 'ok', preview: '🔍' });
                    return { reply: 'OK' };
                },
            },
            cua: {
                config: {
                    enabled: true,
                    allowed_commands: ['load-wave'],
                    notifiable_stages: ['init', 'validation', 'analysis', 'completion'],
                    audit_file: path.join(tmp, 'audit.jsonl'),
                },
                pipelineRoot: tmp,
                telegramQueueDir: path.join(tmp, 'queue'),
                deps: { deliverableNotify: fakeMod },
            },
        });
        const r = await d.dispatch({ chat_id: '1', text: '/load-wave', from: 'tester' });
        assert.equal(r.status, 'ok');
        assert.equal(calls.length, 4);
        const stages = calls.map((c) => c.stage);
        assert.deepEqual(stages, ['init', 'validation', 'analysis', 'completion']);
    } finally {
        cd.DETERMINISTIC_SLASH.delete('load-wave');
    }
});

// ---------------------------------------------------------------------------
// #4145 — comandos query-only saltean el auto-emit init/completion
// ---------------------------------------------------------------------------

test('#4145 — createCuaEmitter expone queryOnlyCommands desde config', () => {
    const e = cd.createCuaEmitter({ config: { enabled: true, query_only_commands: ['wave', 'status'] } });
    assert.deepEqual(e.queryOnlyCommands, ['wave', 'status']);
    // Ausente o no-array → default [] (rollout seguro: comportamiento previo).
    const e2 = cd.createCuaEmitter({ config: { enabled: true } });
    assert.deepEqual(e2.queryOnlyCommands, []);
    const e3 = cd.createCuaEmitter({ config: { enabled: true, query_only_commands: 'wave' } });
    assert.deepEqual(e3.queryOnlyCommands, []);
});

test('#4145 — comando query-only (wave) NO dispara auto-emit init/completion', async () => {
    const tmp = mkTmp('query-only');
    const calls = [];
    const fakeMod = {
        notifyCua: (a) => { calls.push(a.entregable); return { ok: true, action: 'enqueued' }; },
    };
    cd.DETERMINISTIC_SLASH.add('wave');
    try {
        const d = cd.createDispatcher({
            pipelineRoot: tmp,
            logsDir: tmp,
            expectedChatId: '1',
            handlers: { 'wave': () => ({ reply: 'TABLA DE ESTADO' }) },
            cua: {
                config: {
                    enabled: true,
                    allowed_commands: ['wave'],
                    query_only_commands: ['wave'],
                    notifiable_stages: ['init', 'completion'],
                    audit_file: path.join(tmp, 'audit.jsonl'),
                },
                pipelineRoot: tmp,
                telegramQueueDir: path.join(tmp, 'queue'),
                deps: { deliverableNotify: fakeMod },
            },
        });
        const r = await d.dispatch({ chat_id: '1', text: '/wave', from: 'tester' });
        assert.equal(r.status, 'ok');
        assert.equal(r.reply, 'TABLA DE ESTADO', 'la tabla del handler llega intacta');
        assert.equal(calls.length, 0, 'query-only NO debe emitir notis CUA (sin init/completion ni envelope)');
        // CA-3: ninguna noti se encoló → la tabla queda como único contenido.
        const queueFiles = fs.readdirSync(path.join(tmp, 'queue'));
        assert.equal(queueFiles.length, 0, 'no debe encolarse ninguna noti CUA para wave');
    } finally {
        cd.DETERMINISTIC_SLASH.delete('wave');
    }
});

test('#4145 — comando mutador (pausar) SIGUE emitiendo init/completion (no-regresión)', async () => {
    const tmp = mkTmp('mutator');
    const calls = [];
    const fakeMod = {
        notifyCua: (a) => { calls.push(a.entregable); return { ok: true, action: 'enqueued' }; },
    };
    cd.DETERMINISTIC_SLASH.add('pausar');
    try {
        const d = cd.createDispatcher({
            pipelineRoot: tmp,
            logsDir: tmp,
            expectedChatId: '1',
            handlers: { 'pausar': () => ({ reply: 'OK' }) },
            cua: {
                config: {
                    enabled: true,
                    // `pausar` está en allowed pero NO en query_only → mutador.
                    allowed_commands: ['pausar', 'wave'],
                    query_only_commands: ['wave'],
                    notifiable_stages: ['init', 'completion'],
                    audit_file: path.join(tmp, 'audit.jsonl'),
                },
                pipelineRoot: tmp,
                telegramQueueDir: path.join(tmp, 'queue'),
                deps: { deliverableNotify: fakeMod },
            },
        });
        const r = await d.dispatch({ chat_id: '1', text: '/pausar', from: 'tester' });
        assert.equal(r.status, 'ok');
        assert.equal(calls.length, 2, 'init + completion siguen emitiéndose para mutadores');
        assert.equal(calls[0].stage, 'init');
        assert.equal(calls[1].stage, 'completion');
        assert.equal(calls[1].status, 'ok');
    } finally {
        cd.DETERMINISTIC_SLASH.delete('pausar');
    }
});

// ---------------------------------------------------------------------------
// parseCuaTextArgs
// ---------------------------------------------------------------------------

test('parseCuaTextArgs detecta command + stage + motivo', () => {
    const p = rh.parseCuaTextArgs('load-wave validation no me cierra la ola');
    assert.equal(p.ok, true);
    assert.equal(p.command, 'load-wave');
    assert.equal(p.stage, 'validation');
    assert.equal(p.motivo, 'no me cierra la ola');
});

test('parseCuaTextArgs rechaza issue numérico (lo deja al parser regular)', () => {
    const p = rh.parseCuaTextArgs('3541 ux mockup feo');
    assert.equal(p.ok, false);
    assert.equal(p.error, 'not_cua_command');
});

test('parseCuaTextArgs rechaza stage no enum', () => {
    const p = rh.parseCuaTextArgs('load-wave eviction motivo cualquiera');
    assert.equal(p.ok, false);
    assert.equal(p.error, 'invalid_stage');
});

// ---------------------------------------------------------------------------
// CA-SEC-6 — /rechazar CUA con allowlist de operadores
// ---------------------------------------------------------------------------

test('/rechazar CUA sin chat_id en operatorChatIds → unauthorized_rebobinar', async () => {
    const tmp = mkTmp('reject-cua-noauth');
    fs.mkdirSync(path.join(tmp, 'audit'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'rejections'), { recursive: true });
    const handler = rh.createRechazarHandler({
        pipelineRoot: tmp,
        auditDir: path.join(tmp, 'audit'),
        rejectionsDir: path.join(tmp, 'rejections'),
        redactSensitive: (s) => s,
        whisperLocal: { transcribeLocal: async () => ({ ok: false }), isAvailable: () => false },
        githubClient: { viewIssue: () => ({ ok: false, error: 'no gh' }) },
        randomVariant: () => 1,
        cuaOperatorChatIds: ['9999'],
        allowedCuaCommands: ['load-wave'],
    });
    const reply = await handler.handle({
        args: 'load-wave validation no me cierra',
        message: { chat_id: '1', from: 'mal', text: '/rechazar load-wave validation no me cierra' },
        intent: { rawTruncated: '/rechazar load-wave validation no me cierra' },
    });
    assert.match(reply, /No autorizado/);
});

test('/rechazar CUA con chat_id autorizado → ok + evento JSON', async () => {
    const tmp = mkTmp('reject-cua-ok');
    fs.mkdirSync(path.join(tmp, 'audit'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'rejections'), { recursive: true });
    const handler = rh.createRechazarHandler({
        pipelineRoot: tmp,
        auditDir: path.join(tmp, 'audit'),
        rejectionsDir: path.join(tmp, 'rejections'),
        redactSensitive: (s) => s,
        whisperLocal: { transcribeLocal: async () => ({ ok: false }), isAvailable: () => false },
        githubClient: { viewIssue: () => ({ ok: false, error: 'no gh' }) },
        randomVariant: () => 1,
        cuaOperatorChatIds: ['1'],
        allowedCuaCommands: ['load-wave'],
    });
    const reply = await handler.handle({
        args: 'load-wave validation no me cierra la ola',
        message: { chat_id: '1', from: 'leo', text: '/rechazar load-wave validation no me cierra la ola' },
        intent: { rawTruncated: '/rechazar load-wave validation no me cierra la ola' },
    });
    assert.match(reply, /rebobinado/);
    assert.match(reply, /load-wave/);
    assert.match(reply, /validation/);
    // Debe haber un archivo de evento JSON
    const evts = fs.readdirSync(path.join(tmp, 'rejections'));
    assert.equal(evts.length, 1);
    assert.match(evts[0], /^cua-load-wave-validation-\d+\.json$/);
});

test('/rechazar issue regular sigue funcionando (backward compat)', async () => {
    const tmp = mkTmp('reject-issue-compat');
    fs.mkdirSync(path.join(tmp, 'audit'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'rejections'), { recursive: true });
    const handler = rh.createRechazarHandler({
        pipelineRoot: tmp,
        auditDir: path.join(tmp, 'audit'),
        rejectionsDir: path.join(tmp, 'rejections'),
        redactSensitive: (s) => s,
        whisperLocal: { transcribeLocal: async () => ({ ok: false }), isAvailable: () => false },
        githubClient: { viewIssue: () => ({ ok: true, state: 'OPEN', labels: [] }) },
        randomVariant: () => 1,
        cuaOperatorChatIds: ['1'],
        allowedCuaCommands: ['load-wave'],
    });
    // input regular: `<issue> <fase> <motivo>`
    const reply = await handler.handle({
        args: '3541 ux mockup feo',
        message: { chat_id: '1', from: 'leo', text: '/rechazar 3541 ux mockup feo' },
        intent: { rawTruncated: '/rechazar 3541 ux mockup feo' },
    });
    // El template ok contiene la palabra 3541 o un mensaje de éxito; alcanza
    // con que NO sea unauthorized ni invalid_cua_command.
    assert.ok(!/No autorizado/.test(reply), `inesperado: ${reply}`);
    assert.ok(!/No conozco el comando CUA/.test(reply), `inesperado: ${reply}`);
});

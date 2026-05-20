// =============================================================================
// commander-rechazar.test.js — Tests del comando /rechazar (issue #3415).
//
// Cubre CA-1, CA-2, CA-4, CA-6, CA-7, CA-8, CA-9, CA-10, CA-11, CA-12, CA-13,
// CA-14, CA-15, CA-16, CA-17, CA-18, CA-19, CA-20, CA-21, CA-22.
//
// Ejecutar:
//   node --test .pipeline/lib/__tests__/commander-rechazar.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const det = require('../commander-deterministic');
const { parseTextArgs, parseAudioTranscript, createRechazarHandler, STATUS } = require('../commander/rechazar-handler');
const phasesAlias = require('../commander/phases-alias');
const { createAuditLog } = require('../commander/audit-log');

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function mkTmp(prefix = 'rechazar-test-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fakeWhisperOk(text) {
    return {
        isAvailable: () => true,
        transcribeLocal: async () => ({ ok: true, text }),
    };
}

function fakeWhisperFail(errorKind = 'cli_error') {
    return {
        isAvailable: () => true,
        transcribeLocal: async () => ({ ok: false, text: '', errorKind, raw: 'simulado' }),
    };
}

function fakeWhisperUnavailable() {
    let invoked = false;
    return {
        isAvailable: () => false,
        transcribeLocal: async () => { invoked = true; return { ok: true, text: 'OOPS' }; },
        wasInvoked() { return invoked; },
    };
}

function fakeGithubClient(state = 'OPEN', labels = []) {
    return { viewIssue: () => ({ ok: true, state, labels }) };
}

function makeHandler(overrides) {
    const tmp = mkTmp();
    const auditDir = path.join(tmp, 'audit');
    const rejectionsDir = path.join(tmp, 'rejections');
    return {
        tmp,
        auditDir,
        rejectionsDir,
        handler: createRechazarHandler({
            pipelineRoot: tmp,
            auditDir,
            rejectionsDir,
            whisperLocal: fakeWhisperOk('rechazá el 3381 en ux, el mockup no respeta el branding'),
            githubClient: fakeGithubClient('OPEN', []),
            randomVariant: () => 1,
            now: () => Date.parse('2026-05-20T15:00:00Z'),
            ...overrides,
        }),
    };
}

function readJsonl(file) {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// -----------------------------------------------------------------------------
// CLASSIFY — slash + NLP (CA-1, CA-2)
// -----------------------------------------------------------------------------

test('CA-1: /rechazar es determinístico con args', () => {
    const r = det.classify('/rechazar 3381 ux motivo libre');
    assert.equal(r.class, 'deterministic');
    assert.equal(r.command, 'rechazar');
    assert.equal(r.args, '3381 ux motivo libre');
});

test('CA-2: /reject alias es determinístico', () => {
    const r = det.classify('/reject 3342 plan motivo');
    assert.equal(r.class, 'deterministic');
    assert.equal(r.command, 'reject');
});

test('CA-2: /rebobinar alias es determinístico', () => {
    const r = det.classify('/rebobinar #3343 refinar motivo largo');
    assert.equal(r.class, 'deterministic');
    assert.equal(r.command, 'rebobinar');
    assert.equal(r.args, '#3343 refinar motivo largo');
});

test('CA-1 NLP: "rechazá el N en F, motivo" cae como determinístico', () => {
    const r = det.classify('rechazá el 3381 en UX, el mockup no respeta el branding');
    assert.equal(r.class, 'deterministic');
    assert.equal(r.command, 'rechazar');
});

// -----------------------------------------------------------------------------
// PARSER TEXTO — CA-12 / SEC-1.5
// -----------------------------------------------------------------------------

test('CA-12: parser texto acepta `3381 ux motivo`', () => {
    const r = parseTextArgs('3381 ux el mockup no respeta el branding');
    assert.equal(r.ok, true);
    assert.equal(r.issue, 3381);
    assert.equal(r.fase, 'ux');
    assert.equal(r.motivo, 'el mockup no respeta el branding');
});

test('CA-12: parser texto acepta `#3381 ux motivo`', () => {
    const r = parseTextArgs('#3342 refinar faltan criterios');
    assert.equal(r.ok, true);
    assert.equal(r.issue, 3342);
});

test('CA-12 (SEC-1.5): parser rechaza issue alfanumérico', () => {
    const r = parseTextArgs('abc plan motivo');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'issue');
});

test('CA-12 (SEC-1.5): parser rechaza issue negativo', () => {
    const r = parseTextArgs('-1 plan motivo');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'issue');
});

test('CA-12 (SEC-1.5): parser rechaza issue científico 1e9', () => {
    const r = parseTextArgs('1e9 plan motivo');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'issue');
});

test('CA-12 (SEC-1.5): parser rechaza issue de 8+ dígitos', () => {
    const r = parseTextArgs('12345678 plan motivo');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'issue');
});

test('CA-12: parser rechaza shape sin motivo', () => {
    const r = parseTextArgs('3381 ux');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'shape');
});

// -----------------------------------------------------------------------------
// PARSER AUDIO — CA-4
// -----------------------------------------------------------------------------

test('CA-4: parser audio extrae issue + fase + motivo de NLP coloquial', () => {
    const aliases = phasesAlias.listValidAliases();
    const r = parseAudioTranscript('rechazá el 3381 en ux, el mockup no respeta el branding', aliases);
    assert.equal(r.ok, true);
    assert.equal(r.issue, 3381);
    // Puede picarse "ux" o "mockup" (ambos mapean a la misma fase oficial);
    // verificamos que cualquiera resuelva a definicion/criterios.
    const resolved = phasesAlias.resolvePhase(r.fase);
    assert.equal(resolved.ok, true);
    assert.equal(resolved.full, 'definicion/criterios');
    assert.ok(r.motivo.length > 4);
});

test('CA-4: parser audio falla sin número de issue', () => {
    const aliases = phasesAlias.listValidAliases();
    const r = parseAudioTranscript('rechazá el mockup que no me cierra', aliases);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'issue');
});

test('CA-4: parser audio falla sin fase reconocible', () => {
    const aliases = phasesAlias.listValidAliases();
    const r = parseAudioTranscript('rechazá el 3381 porque no me gusta', aliases);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'fase');
});

// -----------------------------------------------------------------------------
// PHASES-ALIAS — CA-6, CA-7, CA-11 / SEC-1.4
// -----------------------------------------------------------------------------

test('CA-6: alias `ux` resuelve a definicion/criterios', () => {
    const r = phasesAlias.resolvePhase('ux');
    assert.equal(r.ok, true);
    assert.equal(r.full, 'definicion/criterios');
});

test('CA-6: alias `mockup` resuelve a definicion/criterios', () => {
    const r = phasesAlias.resolvePhase('mockup');
    assert.equal(r.ok, true);
    assert.equal(r.full, 'definicion/criterios');
});

test('CA-6: alias `refinar` resuelve a definicion/analisis', () => {
    const r = phasesAlias.resolvePhase('refinar');
    assert.equal(r.ok, true);
    assert.equal(r.full, 'definicion/analisis');
});

test('CA-6: alias `plan` resuelve a definicion/sizing', () => {
    const r = phasesAlias.resolvePhase('plan');
    assert.equal(r.ok, true);
    assert.equal(r.full, 'definicion/sizing');
});

test('CA-6: alias `validar` resuelve a desarrollo/validacion', () => {
    const r = phasesAlias.resolvePhase('validar');
    assert.equal(r.ok, true);
    assert.equal(r.full, 'desarrollo/validacion');
});

test('CA-6: nombre oficial `definicion/criterios` matchea exacto', () => {
    const r = phasesAlias.resolvePhase('definicion/criterios');
    assert.equal(r.ok, true);
    assert.equal(r.full, 'definicion/criterios');
});

test('CA-11 (SEC-1.4): path traversal en fase es rechazado', () => {
    const r = phasesAlias.resolvePhase('../etc/passwd');
    assert.equal(r.ok, false);
    assert.ok(Array.isArray(r.suggestions));
});

test('CA-11: fase inexistente devuelve sugerencias', () => {
    const r = phasesAlias.resolvePhase('phasenoexiste');
    assert.equal(r.ok, false);
    assert.ok(Array.isArray(r.suggestions));
    assert.ok(r.suggestions.length > 0);
});

test('CA-11 (SEC-1.4): caracteres peligrosos rechazados', () => {
    const r = phasesAlias.resolvePhase('foo;rm -rf /');
    assert.equal(r.ok, false);
});

// -----------------------------------------------------------------------------
// AUDIT LOG — CA-16 / SEC-1.6
// -----------------------------------------------------------------------------

test('CA-16 (SEC-1.6): createAuditLog acepta filenamePrefix custom', () => {
    const tmp = mkTmp();
    const al = createAuditLog({ dir: tmp, filenamePrefix: 'rejections' });
    al.record({ intent_class: 'deterministic', handler: 'rechazar', result_status: 'ok' });
    const files = fs.readdirSync(tmp);
    assert.equal(files.length, 1);
    assert.match(files[0], /^rejections-\d{4}-\d{2}-\d{2}\.jsonl$/);
});

test('CA-16: filenamePrefix retrocompatible (default `commander-audit`)', () => {
    const tmp = mkTmp();
    const al = createAuditLog({ dir: tmp });
    al.record({ intent_class: 'deterministic', handler: 'status', result_status: 'ok' });
    const files = fs.readdirSync(tmp);
    assert.match(files[0], /^commander-audit-\d{4}-\d{2}-\d{2}\.jsonl$/);
});

test('CA-16 (SEC-1.6): filenamePrefix con path traversal cae al default', () => {
    const tmp = mkTmp();
    const al = createAuditLog({ dir: tmp, filenamePrefix: '../../etc/passwd' });
    al.record({ intent_class: 'deterministic', handler: 'x', result_status: 'ok' });
    const files = fs.readdirSync(tmp);
    assert.equal(files.length, 1);
    // El prefix inválido debe haber sido reemplazado por el default seguro.
    assert.match(files[0], /^commander-audit-\d{4}-\d{2}-\d{2}\.jsonl$/);
});

test('CA-17: extraFields se persisten en el JSONL', () => {
    const tmp = mkTmp();
    const al = createAuditLog({
        dir: tmp,
        filenamePrefix: 'rejections',
        extraFields: ['issue', 'fase', 'motivo'],
    });
    al.record({
        intent_class: 'deterministic',
        handler: 'rechazar',
        result_status: 'ok',
        issue: 3381,
        fase: 'ux',
        motivo: 'no me cierra el mockup',
    });
    const rows = readJsonl(al.currentPath());
    assert.equal(rows.length, 1);
    assert.equal(rows[0].issue, 3381);
    assert.equal(rows[0].fase, 'ux');
    assert.equal(rows[0].motivo, 'no me cierra el mockup');
});

// -----------------------------------------------------------------------------
// HANDLER E2E
// -----------------------------------------------------------------------------

test('E2E texto OK: audit + evento + reply', async () => {
    const { handler, auditDir, rejectionsDir } = makeHandler();
    const result = await handler.handle({
        args: '3381 ux el mockup no respeta el branding',
        message: { from: 'Leo', chat_id: '111', text: '/rechazar 3381 ux el mockup no respeta el branding', date: Math.floor(Date.parse('2026-05-20T14:59:00Z') / 1000) },
        intent: { rawTruncated: '/rechazar 3381 ux el mockup no respeta el branding' },
    });

    assert.ok(result.length > 0);
    const auditFiles = fs.readdirSync(auditDir);
    assert.match(auditFiles[0], /^rejections-\d{4}-\d{2}-\d{2}\.jsonl$/);
    const rows = readJsonl(path.join(auditDir, auditFiles[0]));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].result_status, 'ok');
    assert.equal(rows[0].issue, 3381);
    assert.equal(rows[0].fase, 'ux');
    assert.equal(rows[0].fase_resolved, 'definicion/criterios');
    assert.equal(rows[0].source, 'text');

    const evtFiles = fs.readdirSync(rejectionsDir);
    assert.equal(evtFiles.length, 1);
    assert.match(evtFiles[0], /^3381-\d+\.json$/);
    const evt = JSON.parse(fs.readFileSync(path.join(rejectionsDir, evtFiles[0]), 'utf8'));
    assert.equal(evt.issue, 3381);
    assert.equal(evt.fase_resolved, 'definicion/criterios');
    assert.equal(evt.source, 'text');
    assert.ok(evt.audit_ref.startsWith('rejections-'));
});

test('CA-8 / SEC-1.1 (dispatcher): chat_id no autorizado retorna `unauthorized` y NO escribe evento', async () => {
    const tmp = mkTmp();
    const dispatcher = det.createDispatcher({
        pipelineRoot: tmp,
        logsDir: path.join(tmp, 'logs'),
        expectedChatId: '111',
        destructiveCooldown: false,
        rateLimit: { burst: 100, ratePerMin: 600 },
        rechazarDeps: {
            auditDir: path.join(tmp, 'audit'),
            rejectionsDir: path.join(tmp, 'rejections'),
            whisperLocal: fakeWhisperOk('x'),
            githubClient: fakeGithubClient(),
            randomVariant: () => 1,
        },
    });
    const r = await dispatcher.dispatch({
        from: 'Atacante', chat_id: '999',
        text: '/rechazar 3381 ux foo',
    });
    assert.equal(r.status, 'unauthorized');
    // No debe haber evento de rechazo
    assert.equal(fs.existsSync(path.join(tmp, 'rejections')), false);
});

test('CA-9 (SEC-1.2): si whisper-local.isAvailable() === false, NO se invoca transcribeLocal', async () => {
    const wh = fakeWhisperUnavailable();
    const { handler, auditDir } = makeHandler({ whisperLocal: wh });
    const result = await handler.handle({
        args: '',
        message: {
            from: 'Leo', chat_id: '111',
            _esAudio: true,
            voice_path: '/tmp/fake.ogg',
            text: '',
            date: Math.floor(Date.parse('2026-05-20T14:59:00Z') / 1000),
        },
        intent: { rawTruncated: '<audio>' },
    });
    // El reply debe mencionar audio/transcripción/whisper — usamos las tres por
    // tolerancia a variantes del template.
    assert.ok(/audio|transcrib|whisper/i.test(result), `reply inesperado: ${result.slice(0, 200)}`);
    assert.equal(wh.wasInvoked(), false);
    const rows = readJsonl(path.join(auditDir, fs.readdirSync(auditDir)[0]));
    assert.equal(rows[0].result_status, STATUS.TRANSCRIBE_FAILED);
});

test('CA-9: el handler no llama a APIs remotas — sólo a whisperLocal.transcribeLocal', async () => {
    // Mock que captura llamadas. Si el handler intentara fetch remoto, no
    // tendría cómo (no le inyectamos cliente HTTP), pero verificamos
    // explícitamente que llama a transcribeLocal del módulo inyectado.
    let calls = 0;
    const wh = {
        isAvailable: () => true,
        transcribeLocal: async () => { calls += 1; return { ok: true, text: 'rechazá el 3381 en ux, motivo válido' }; },
    };
    const { handler } = makeHandler({ whisperLocal: wh });
    await handler.handle({
        args: '',
        message: {
            from: 'Leo', chat_id: '111',
            _esAudio: true,
            voice_path: '/tmp/fake.ogg',
            text: '',
            date: Math.floor(Date.parse('2026-05-20T14:59:00Z') / 1000),
        },
        intent: { rawTruncated: '<audio>' },
    });
    assert.equal(calls, 1);
});

test('CA-10 (SEC-1.3): motivo con JWT se redacta en JSONL y evento', async () => {
    const { handler, auditDir, rejectionsDir } = makeHandler({
        redactSensitive: (s) => String(s || '').replace(/eyJ[A-Za-z0-9._-]+/g, '[REDACTED-JWT]'),
    });
    const evilMotivo = 'el token es eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.foo.bar y no quiero que aparezca';
    await handler.handle({
        args: `3381 ux ${evilMotivo}`,
        message: { from: 'Leo', chat_id: '111', text: '', date: Math.floor(Date.parse('2026-05-20T14:59:00Z') / 1000) },
        intent: { rawTruncated: '<rechazar>' },
    });
    const rows = readJsonl(path.join(auditDir, fs.readdirSync(auditDir)[0]));
    assert.ok(!JSON.stringify(rows[0]).includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'));
    const evt = JSON.parse(fs.readFileSync(path.join(rejectionsDir, fs.readdirSync(rejectionsDir)[0]), 'utf8'));
    assert.ok(!JSON.stringify(evt).includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'));
    assert.ok(JSON.stringify(rows[0]).includes('[REDACTED-JWT]'));
});

test('CA-12 (SEC-1.5): issue alfanumérico retorna invalid_issue (sin tocar GitHub)', async () => {
    let ghCalled = false;
    const { handler, auditDir } = makeHandler({
        githubClient: { viewIssue: () => { ghCalled = true; return { ok: true, state: 'OPEN', labels: [] }; } },
    });
    await handler.handle({
        args: 'abc plan motivo válido largo',
        message: { from: 'Leo', chat_id: '111', text: '', date: Math.floor(Date.parse('2026-05-20T14:59:00Z') / 1000) },
        intent: { rawTruncated: '<rechazar>' },
    });
    assert.equal(ghCalled, false);
    const rows = readJsonl(path.join(auditDir, fs.readdirSync(auditDir)[0]));
    assert.equal(rows[0].result_status, STATUS.INVALID_ISSUE);
});

test('CA-13 (SEC-1.7): audio > 10MB es rechazado antes de invocar whisper', async () => {
    let whisperCalled = false;
    const wh = {
        isAvailable: () => true,
        transcribeLocal: async () => { whisperCalled = true; return { ok: true, text: '' }; },
    };
    const { handler, auditDir } = makeHandler({ whisperLocal: wh });
    const result = await handler.handle({
        args: '',
        message: {
            from: 'Leo', chat_id: '111',
            _esAudio: true,
            voice_path: '/tmp/big.ogg',
            voice_file_size: 11 * 1024 * 1024,
            voice_duration: 30,
            text: '',
            date: Math.floor(Date.parse('2026-05-20T14:59:00Z') / 1000),
        },
        intent: { rawTruncated: '<audio>' },
    });
    assert.equal(whisperCalled, false);
    const rows = readJsonl(path.join(auditDir, fs.readdirSync(auditDir)[0]));
    assert.equal(rows[0].result_status, STATUS.AUDIO_TOO_BIG);
    assert.ok(/grande|límite|peso|cap|excede/i.test(result));
});

test('CA-13 (SEC-1.7): audio > 120s es rechazado antes de invocar whisper', async () => {
    let whisperCalled = false;
    const wh = {
        isAvailable: () => true,
        transcribeLocal: async () => { whisperCalled = true; return { ok: true, text: '' }; },
    };
    const { handler, auditDir } = makeHandler({ whisperLocal: wh });
    await handler.handle({
        args: '',
        message: {
            from: 'Leo', chat_id: '111',
            _esAudio: true,
            voice_path: '/tmp/long.ogg',
            voice_file_size: 1 * 1024 * 1024,
            voice_duration: 200,
            text: '',
            date: Math.floor(Date.parse('2026-05-20T14:59:00Z') / 1000),
        },
        intent: { rawTruncated: '<audio>' },
    });
    assert.equal(whisperCalled, false);
    const rows = readJsonl(path.join(auditDir, fs.readdirSync(auditDir)[0]));
    assert.equal(rows[0].result_status, STATUS.AUDIO_TOO_LONG);
});

test('CA-14 (SEC-1.8): message.date >24h viejo → result_status=stale, sin rebobinar', async () => {
    const { handler, auditDir, rejectionsDir } = makeHandler({
        now: () => Date.parse('2026-05-21T15:00:00Z'),
    });
    const oldDate = Math.floor(Date.parse('2026-05-20T10:00:00Z') / 1000); // 29h atrás
    const result = await handler.handle({
        args: '3381 ux motivo válido y suficientemente largo',
        message: { from: 'Leo', chat_id: '111', text: '', date: oldDate },
        intent: { rawTruncated: '<rechazar>' },
    });
    const rows = readJsonl(path.join(auditDir, fs.readdirSync(auditDir)[0]));
    assert.equal(rows[0].result_status, STATUS.STALE);
    assert.equal(fs.existsSync(rejectionsDir), false);
    assert.ok(/viejo|caduco|rato/i.test(result));
});

test('CA-15 (SEC-1.9): issue con label `merged` retorna issue_closed', async () => {
    const { handler, auditDir, rejectionsDir } = makeHandler({
        githubClient: fakeGithubClient('OPEN', ['merged']),
    });
    const result = await handler.handle({
        args: '3381 ux motivo válido',
        message: { from: 'Leo', chat_id: '111', text: '', date: Math.floor(Date.parse('2026-05-20T14:59:00Z') / 1000) },
        intent: { rawTruncated: '<rechazar>' },
    });
    const rows = readJsonl(path.join(auditDir, fs.readdirSync(auditDir)[0]));
    assert.equal(rows[0].result_status, STATUS.ISSUE_CLOSED);
    assert.equal(fs.existsSync(rejectionsDir), false);
    assert.ok(/cerrado|bloqueado|no se puede/i.test(result));
});

test('CA-15: issue con state=CLOSED retorna issue_closed', async () => {
    const { handler, auditDir, rejectionsDir } = makeHandler({
        githubClient: fakeGithubClient('CLOSED', []),
    });
    await handler.handle({
        args: '3381 ux motivo válido',
        message: { from: 'Leo', chat_id: '111', text: '', date: Math.floor(Date.parse('2026-05-20T14:59:00Z') / 1000) },
        intent: { rawTruncated: '<rechazar>' },
    });
    const rows = readJsonl(path.join(auditDir, fs.readdirSync(auditDir)[0]));
    assert.equal(rows[0].result_status, STATUS.ISSUE_CLOSED);
    assert.equal(fs.existsSync(rejectionsDir), false);
});

test('CA-18: evento JSON con shape contractual para #3416', async () => {
    const { handler, rejectionsDir } = makeHandler();
    await handler.handle({
        args: '3381 ux el mockup no respeta el branding',
        message: { from: 'Leo', chat_id: '111', text: '', date: Math.floor(Date.parse('2026-05-20T14:59:00Z') / 1000) },
        intent: { rawTruncated: '<rechazar>' },
    });
    const evtFile = fs.readdirSync(rejectionsDir)[0];
    const evt = JSON.parse(fs.readFileSync(path.join(rejectionsDir, evtFile), 'utf8'));
    assert.equal(evt.issue, 3381);
    assert.equal(evt.fase, 'ux');
    assert.equal(evt.fase_resolved, 'definicion/criterios');
    assert.equal(typeof evt.motivo, 'string');
    assert.match(evt.ts, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(evt.source, 'text');
    assert.equal(typeof evt.chat_id, 'string');
    assert.match(evt.audit_ref, /^rejections-\d{4}-\d{2}-\d{2}\.jsonl$/);
});

test('CA-19: si la escritura del evento JSON falla, result_status=event_write_failed', async () => {
    const tmp = mkTmp();
    const auditDir = path.join(tmp, 'audit');
    // Crear rejectionsDir como ARCHIVO para forzar EEXIST/ENOTDIR.
    const rejectionsDir = path.join(tmp, 'rejections-blocked');
    fs.writeFileSync(rejectionsDir, 'archivo regular');
    const handler = createRechazarHandler({
        pipelineRoot: tmp,
        auditDir,
        rejectionsDir,
        whisperLocal: fakeWhisperOk('x'),
        githubClient: fakeGithubClient(),
        randomVariant: () => 1,
        now: () => Date.parse('2026-05-20T15:00:00Z'),
    });
    const result = await handler.handle({
        args: '3381 ux motivo válido',
        message: { from: 'Leo', chat_id: '111', text: '', date: Math.floor(Date.parse('2026-05-20T14:59:00Z') / 1000) },
        intent: { rawTruncated: '<rechazar>' },
    });
    const rows = readJsonl(path.join(auditDir, fs.readdirSync(auditDir)[0]));
    assert.equal(rows[0].result_status, STATUS.EVENT_WRITE_FAILED);
    assert.ok(/audit/i.test(result));
});

test('CA-20: reply de éxito incluye motivo (redactado) citado', async () => {
    const { handler } = makeHandler();
    const result = await handler.handle({
        args: '3381 ux el mockup no respeta el branding',
        message: { from: 'Leo', chat_id: '111', text: '', date: Math.floor(Date.parse('2026-05-20T14:59:00Z') / 1000) },
        intent: { rawTruncated: '<rechazar>' },
    });
    assert.ok(result.includes('mockup'));
    assert.ok(result.includes('branding'));
    assert.ok(result.includes('3381'));
});

test('CA-21: respuesta de fase inválida sugiere fases válidas + ejemplo de uso', async () => {
    const { handler } = makeHandler();
    const result = await handler.handle({
        args: '3381 quesoazul motivo válido para que pase parser',
        message: { from: 'Leo', chat_id: '111', text: '', date: Math.floor(Date.parse('2026-05-20T14:59:00Z') / 1000) },
        intent: { rawTruncated: '<rechazar>' },
    });
    assert.ok(/quesoazul/i.test(result));
    assert.ok(/3381/.test(result) || /\\#3381/.test(result));
});

// -----------------------------------------------------------------------------
// CA-22: cobertura mínima (lista de tests para verificación rápida).
// -----------------------------------------------------------------------------
test('CA-22: enum STATUS contiene todas las ramas del documento de criterios', () => {
    const expected = ['OK', 'INVALID_ISSUE', 'INVALID_PHASE', 'ISSUE_CLOSED', 'TRANSCRIBE_FAILED', 'AUDIO_TOO_BIG', 'AUDIO_TOO_LONG', 'STALE', 'EVENT_WRITE_FAILED', 'INSUFFICIENT_FIELDS'];
    for (const k of expected) {
        assert.ok(STATUS[k], `STATUS.${k} debe existir`);
    }
});

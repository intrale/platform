// =============================================================================
// commander-router.test.js — Tests del router determinístico (issue #3257)
//
// Cubre CA-6 (≥ 20 ejemplos clasificados correctamente) y CA-14 (≥ 5 ejemplos
// adversariales: path traversal, markdown injection, command chaining, control
// chars, fuzz). Todos los fixtures usan datos sintéticos — sin chat_id reales
// ni tokens copiados del audit log.
//
// Ejecutar:  node --test .pipeline/lib/__tests__/commander-router.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const commanderDet = require('../commander-deterministic');
const { fillTemplate, escapeMarkdownV2, clearCache } = require('../commander/fill-template');
const { createRateLimiter } = require('../commander/rate-limit');
const { createAuditLog, sha256Hex } = require('../commander/audit-log');
const { redactReadOutput } = require('../commander/redact-read');

// -----------------------------------------------------------------------------
// CLASSIFY — slash commands deterministas (CA-1, CA-7)
// -----------------------------------------------------------------------------

test('classify: slash /status es determinístico', () => {
    const r = commanderDet.classify('/status');
    assert.equal(r.class, 'deterministic');
    assert.equal(r.command, 'status');
});

test('classify: slash /snapshot es determinístico', () => {
    const r = commanderDet.classify('/snapshot');
    assert.equal(r.class, 'deterministic');
    assert.equal(r.command, 'snapshot');
});

test('classify: slash /allowlist es determinístico', () => {
    const r = commanderDet.classify('/allowlist');
    assert.equal(r.class, 'deterministic');
});

test('classify: slash /tail con archivo es determinístico', () => {
    const r = commanderDet.classify('/tail commander.log');
    assert.equal(r.class, 'deterministic');
    assert.equal(r.command, 'tail');
    assert.equal(r.args, 'commander.log');
});

test('classify: slash /dashboard-up es determinístico', () => {
    const r = commanderDet.classify('/dashboard-up');
    assert.equal(r.class, 'deterministic');
    assert.equal(r.command, 'dashboard-up');
});

test('classify: slash /procesos es determinístico', () => {
    const r = commanderDet.classify('/procesos');
    assert.equal(r.class, 'deterministic');
});

test('classify: slash /salud es determinístico', () => {
    const r = commanderDet.classify('/salud');
    assert.equal(r.class, 'deterministic');
});

test('classify: slash /descanso es determinístico', () => {
    const r = commanderDet.classify('/descanso');
    assert.equal(r.class, 'deterministic');
});

test('classify: slash /pausar (legacy) sigue siendo determinístico — CA-18', () => {
    const r = commanderDet.classify('/pausar');
    assert.equal(r.class, 'deterministic');
});

test('classify: slash /ghostbusters (legacy) sigue siendo determinístico — CA-18', () => {
    const r = commanderDet.classify('/ghostbusters');
    assert.equal(r.class, 'deterministic');
});

// -----------------------------------------------------------------------------
// CLASSIFY — slash commands LLM (creación, análisis)
// -----------------------------------------------------------------------------

test('classify: slash /intake va al LLM (creación)', () => {
    const r = commanderDet.classify('/intake 1234');
    assert.equal(r.class, 'llm');
    assert.equal(r.command, 'intake');
});

test('classify: slash /proponer va al LLM (análisis)', () => {
    const r = commanderDet.classify('/proponer');
    assert.equal(r.class, 'llm');
});

// -----------------------------------------------------------------------------
// CLASSIFY — NLP / lenguaje natural (legacy + nuevos)
// -----------------------------------------------------------------------------

test('classify NLP: "qué hay en el pipeline" → status', () => {
    const r = commanderDet.classify('qué hay en el pipeline');
    assert.equal(r.class, 'deterministic');
    assert.equal(r.command, 'status');
});

test('classify NLP: "pausá el pulpo" → pausar (legacy)', () => {
    const r = commanderDet.classify('pausá el pulpo');
    assert.equal(r.class, 'deterministic');
    assert.equal(r.command, 'pausar');
});

test('classify NLP: "levantá el dashboard" → dashboard-up', () => {
    const r = commanderDet.classify('levantá el dashboard');
    assert.equal(r.class, 'deterministic');
    assert.equal(r.command, 'dashboard-up');
});

test('classify NLP: "modo descanso" → descanso', () => {
    const r = commanderDet.classify('modo descanso');
    assert.equal(r.class, 'deterministic');
    assert.equal(r.command, 'descanso');
});

test('classify NLP: "tail commander.log" extrae args correctamente', () => {
    const r = commanderDet.classify('tail commander.log');
    assert.equal(r.class, 'deterministic');
    assert.equal(r.command, 'tail');
    assert.equal(r.args, 'commander.log');
});

// -----------------------------------------------------------------------------
// CLASSIFY — texto libre / desconocido
// -----------------------------------------------------------------------------

test('classify: texto largo (>80 chars) cae a LLM', () => {
    const longText = 'Necesito que crees una historia de usuario que cubra el caso del repartidor que cancela una entrega después de aceptarla pero antes de salir del comercio';
    const r = commanderDet.classify(longText);
    assert.equal(r.class, 'llm');
});

test('classify: slash desconocido cae a unknown (NO LLM — CA-7)', () => {
    const r = commanderDet.classify('/garbageino');
    assert.equal(r.class, 'unknown');
});

test('classify: input vacío → unknown', () => {
    const r = commanderDet.classify('');
    assert.equal(r.class, 'unknown');
});

// -----------------------------------------------------------------------------
// VALIDACIÓN DE ARGS (CA-8)
// -----------------------------------------------------------------------------

test('validateArgs tail: rechaza archivo fuera de la allowlist', () => {
    const v = commanderDet.validateArgs('tail', 'random.log');
    assert.equal(v.ok, false);
    assert.match(v.usage, /tail/);
});

test('validateArgs tail: acepta commander.log', () => {
    const v = commanderDet.validateArgs('tail', 'commander.log');
    assert.equal(v.ok, true);
});

test('validateArgs listado: acepta filtros conocidos', () => {
    assert.equal(commanderDet.validateArgs('listado', 'pendientes').ok, true);
    assert.equal(commanderDet.validateArgs('listado', '').ok, true);
});

test('validateArgs listado: rechaza filtro arbitrario', () => {
    const v = commanderDet.validateArgs('listado', 'random-stuff');
    assert.equal(v.ok, false);
});

// -----------------------------------------------------------------------------
// ADVERSARIALES (CA-14) — al menos 5
// -----------------------------------------------------------------------------

test('adversarial #1: path traversal en tail "../../etc/passwd"', () => {
    const intent = commanderDet.classify('tail ../../etc/passwd');
    // El NLP extrae args=".." (válido como string), pero el validator lo rechaza.
    assert.equal(intent.class, 'deterministic');
    const v = commanderDet.validateArgs(intent.command, intent.args);
    assert.equal(v.ok, false, 'el validator debe rechazar path traversal');
});

test('adversarial #2: command chaining con ";"  → no se ejecuta nada', () => {
    const r = commanderDet.classify('/status; rm -rf /');
    // /status con args="; rm -rf /" — el handler de status ignora args, no hay shell.
    assert.equal(r.class, 'deterministic');
    assert.equal(r.command, 'status');
    assert.equal(r.args, '; rm -rf /', 'args se preserva como string, no se interpreta');
});

test('adversarial #3: markdown injection escapa metacaracteres MarkdownV2', () => {
    // Input con metacaracteres MarkdownV2: *, _, ], >, |
    const malicious = 'attack: *bold* _italic_ ]close >quote |pipe';
    const escaped = escapeMarkdownV2(malicious);
    assert.ok(escaped.includes('\\*'), 'asterisco escapado');
    assert.ok(escaped.includes('\\_'), 'underscore escapado');
    assert.ok(escaped.includes('\\]'), 'cierre de corchete escapado');
    assert.ok(escaped.includes('\\>'), 'mayor escapado (quote injection)');
    assert.ok(escaped.includes('\\|'), 'pipe escapado');
    // Render: el output NO debe contener un `*` desnudo (sería negrita Telegram).
    assert.ok(!/(?<!\\)\*/.test(escaped), 'no hay asteriscos sin escape');
});

test('adversarial #4: control chars (NUL, \\x01) no rompen clasificador', () => {
    const fuzzy = 'status\x00\x01\x02';
    const r = commanderDet.classify(fuzzy);
    // No tira excepción y devuelve un objeto válido.
    assert.ok(['deterministic', 'llm', 'unknown'].includes(r.class));
});

test('adversarial #5: AWS key en raw_command se redacta en audit', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-audit-'));
    const log = createAuditLog({
        dir: tmpDir,
        redact: (s) => s.replace(/AKIA[0-9A-Z]{16}/g, '[REDACTED]'),
    });
    log.record({
        from: 'attacker',
        chat_id: '999',
        raw_command: 'echo my key is AKIAIOSFODNN7EXAMPLE',
        intent_class: 'unknown',
        handler: null,
        args: 'AKIAIOSFODNN7EXAMPLE',
        result_status: 'ok',
        duration_ms: 1,
    });
    const today = new Date().toISOString().slice(0, 10);
    const content = fs.readFileSync(path.join(tmpDir, `commander-audit-${today}.jsonl`), 'utf8');
    assert.ok(!content.includes('AKIAIOSFODNN7EXAMPLE'), 'la AWS key NO aparece en el audit log crudo');
    assert.ok(content.includes('[REDACTED]'), 'el marker REDACTED está presente');
    // Args se persiste como hash, no como string.
    assert.ok(content.includes(sha256Hex('AKIAIOSFODNN7EXAMPLE')), 'args_hash sha256 presente');
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('adversarial #6: telegram bot token en log se redacta vía redactReadOutput', () => {
    const dirty = 'Token activo: 123456789:ABCdefGHIjklMNOpqrsTUVwxyz12345678901';
    const { text, redactedCount } = redactReadOutput(dirty);
    assert.ok(redactedCount >= 1, 'redacta al menos 1 valor');
    assert.ok(!text.includes('ABCdefGHIjklMNOpqrsTUVwxyz12345678901'), 'token no aparece en plain');
    assert.ok(text.includes('[REDACTED]'));
});

// -----------------------------------------------------------------------------
// RATE LIMIT (CA-11)
// -----------------------------------------------------------------------------

test('rate limit: burst 3 y luego bloqueo', () => {
    let nowMs = 0;
    const rl = createRateLimiter({ burst: 3, ratePerMin: 60, now: () => nowMs });
    assert.equal(rl.consume('user1').allowed, true);
    assert.equal(rl.consume('user1').allowed, true);
    assert.equal(rl.consume('user1').allowed, true);
    const fourth = rl.consume('user1');
    assert.equal(fourth.allowed, false);
    assert.ok(fourth.retryAfterMs > 0);
});

test('rate limit: chats distintos no se contaminan', () => {
    const rl = createRateLimiter({ burst: 1, ratePerMin: 60 });
    assert.equal(rl.consume('a').allowed, true);
    assert.equal(rl.consume('b').allowed, true);
    assert.equal(rl.consume('a').allowed, false);
});

// -----------------------------------------------------------------------------
// DISPATCHER (integración liviana)
// -----------------------------------------------------------------------------

test('dispatcher: comando determinístico responde sin handler legacy → no_handler para los nuevos', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-disp-'));
    const dispatcher = commanderDet.createDispatcher({
        pipelineRoot: tmpDir,
        logsDir: path.join(tmpDir, 'logs'),
        rateLimit: { burst: 100, ratePerMin: 600 },
    });
    // Comando con handler default registrado: descanso (handler nuevo del módulo).
    const r = await dispatcher.dispatch({ text: '/descanso', chat_id: '1' });
    assert.equal(r.intent.class, 'deterministic');
    assert.equal(r.intent.command, 'descanso');
    assert.equal(r.status, 'ok');
    assert.ok(r.reply && r.reply.includes('Modo descanso'));
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('dispatcher: rate limit gatea y plantilla de error responde', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-disp-'));
    const dispatcher = commanderDet.createDispatcher({
        pipelineRoot: tmpDir,
        logsDir: path.join(tmpDir, 'logs'),
        rateLimit: { burst: 1, ratePerMin: 60 },
    });
    const first = await dispatcher.dispatch({ text: '/descanso', chat_id: 'rl' });
    assert.equal(first.status, 'ok');
    const second = await dispatcher.dispatch({ text: '/descanso', chat_id: 'rl' });
    assert.equal(second.status, 'rate_limited');
    assert.ok(second.reply.includes('Calma'));
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('dispatcher: comando unknown devuelve plantilla error-unknown con sugerencias', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-disp-'));
    const dispatcher = commanderDet.createDispatcher({
        pipelineRoot: tmpDir,
        logsDir: path.join(tmpDir, 'logs'),
        rateLimit: { burst: 100, ratePerMin: 600 },
    });
    const r = await dispatcher.dispatch({ text: '/inexistente', chat_id: '1' });
    assert.equal(r.intent.class, 'unknown');
    assert.equal(r.status, 'ok');
    assert.ok(r.reply.includes('No te entendí'));
    assert.ok(r.reply.includes('Determinísticos'));
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('dispatcher: comando llm devuelve reply=null (caller llama a Claude)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-disp-'));
    const dispatcher = commanderDet.createDispatcher({
        pipelineRoot: tmpDir,
        logsDir: path.join(tmpDir, 'logs'),
        rateLimit: { burst: 100, ratePerMin: 600 },
    });
    const r = await dispatcher.dispatch({ text: 'creá una historia para el módulo de notificaciones automáticas del repartidor', chat_id: '1' });
    assert.equal(r.intent.class, 'llm');
    assert.equal(r.reply, null);
    assert.equal(r.status, 'delegated_to_llm');
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

// -----------------------------------------------------------------------------
// FILL TEMPLATE (CA-3 / CA-12)
// -----------------------------------------------------------------------------

test('fillTemplate: each con primitivos resuelve {{this}} correctamente', () => {
    clearCache();
    const out = fillTemplate('error-invalid-args', {
        command: 'tail',
        'validation-error-message': 'foo',
        'usage-example': 'tail <archivo>',
        'allowed-values': ['commander.log', 'pulpo.log'],
        hint: null,
    });
    assert.ok(out.includes('commander\\.log'));
    assert.ok(out.includes('pulpo\\.log'));
    assert.ok(!out.includes('[object Object]'));
});

test('fillTemplate: if/else binario', () => {
    clearCache();
    const out = fillTemplate('modo-descanso', {
        timestamp: '2026-05-17',
        active: false,
        'window-start': '22:00',
        'window-end': '08:00',
        timezone: 'America/Argentina/Buenos_Aires',
        'days-display': 'L-V',
        'snooze-cap-h': 24,
        'has-snooze': false,
    });
    assert.ok(out.includes('inactivo'));
    assert.ok(!out.includes('ACTIVO'));
});

// -----------------------------------------------------------------------------
// MÉTRICAS (CA-4)
// -----------------------------------------------------------------------------

test('computeRoutingMetrics: cuenta entradas por clase', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-metrics-'));
    const today = new Date().toISOString().slice(0, 10);
    const file = path.join(tmpDir, `commander-audit-${today}.jsonl`);
    const entries = [
        { intent_class: 'deterministic' },
        { intent_class: 'deterministic' },
        { intent_class: 'deterministic' },
        { intent_class: 'llm' },
        { intent_class: 'unknown' },
    ];
    fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const m = commanderDet.computeRoutingMetrics(tmpDir, { days: 1 });
    assert.equal(m.buckets.length, 1);
    assert.equal(m.buckets[0].deterministic, 3);
    assert.equal(m.buckets[0].llm, 1);
    assert.equal(m.buckets[0].unknown, 1);
    assert.equal(m.buckets[0].total, 5);
    assert.equal(m.buckets[0].percentDeterministic, 60);
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

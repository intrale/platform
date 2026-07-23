// =============================================================================
// notify-telegram.test.js — Tests de lib/notify-telegram.js (issue #3518 CA-9).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function setupTmp() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-tg-test-'));
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    delete require.cache[require.resolve('../notify-telegram')];
    return { dir, mod: require('../notify-telegram') };
}

function teardownTmp(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    delete process.env.PIPELINE_DIR_OVERRIDE;
}

test('notifyTelegram rechaza payload sin component/message', () => {
    const { dir, mod } = setupTmp();
    try {
        assert.deepEqual(mod.notifyTelegram(null), { ok: false, reason: 'invalid_payload' });
        assert.deepEqual(mod.notifyTelegram({}), { ok: false, reason: 'missing_required_fields' });
        assert.deepEqual(mod.notifyTelegram({ component: 'x' }), { ok: false, reason: 'missing_required_fields' });
        assert.deepEqual(mod.notifyTelegram({ message: 'x' }), { ok: false, reason: 'missing_required_fields' });
    } finally { teardownTmp(dir); }
});

test('notifyTelegram crea drop en servicios/telegram/pendiente/ con shape {text, parse_mode}', () => {
    const { dir, mod } = setupTmp();
    try {
        const res = mod.notifyTelegram({
            level: 'error',
            component: 'test-component',
            message: 'algo falló',
            action: 'mirá los logs',
            diag: 'ls -la /tmp',
        });
        assert.equal(res.ok, true);
        assert.ok(res.dropPath);
        assert.equal(fs.existsSync(res.dropPath), true);

        const parsed = JSON.parse(fs.readFileSync(res.dropPath, 'utf8'));
        assert.ok(typeof parsed.text === 'string');
        assert.equal(parsed.parse_mode, 'Markdown');
        // El texto incluye los pedazos esperables.
        assert.ok(parsed.text.includes('test-component'));
        assert.ok(parsed.text.includes('algo falló'));
        assert.ok(parsed.text.includes('mirá los logs'));
        assert.ok(parsed.text.includes('(diag: ls -la /tmp)'));
        // Severidad error → 🚨.
        assert.ok(parsed.text.startsWith('\u{1F6A8}'));
    } finally { teardownTmp(dir); }
});

test('buildMessage incluye contexto, holder, emisor', () => {
    const { dir, mod } = setupTmp();
    try {
        const text = mod._internal.buildMessage({
            level: 'warn',
            component: 'waves-lock',
            message: 'lock timeout',
            holder: { pid: 12345, hostname: 'host-a', startTime: '2026-05-26T10:00:00Z' },
            context: { archivo: 'waves.json', retries: 3 },
            ts: '2026-05-26T13:42:18Z',
            diag: 'cat waves.json.lock',
            action: 'Liberá el lock manual',
        });
        assert.ok(text.includes('pid=12345'));
        assert.ok(text.includes('host=host-a'));
        assert.ok(text.includes('start=2026-05-26T10:00:00Z'));
        assert.ok(text.includes('archivo: waves.json'));
        assert.ok(text.includes('retries: 3'));
        assert.ok(text.includes(`emisor: pid=${process.pid}`));
        assert.ok(text.includes('host=' + os.hostname()));
        assert.ok(text.includes('ts=2026-05-26T13:42:18Z'));
        assert.ok(text.includes('Liberá el lock manual'));
        assert.ok(text.includes('(diag: cat waves.json.lock)'));
    } finally { teardownTmp(dir); }
});

test('emoji por severidad: error 🚨, warn ⚠️, info ℹ️ (default)', () => {
    const { dir, mod } = setupTmp();
    try {
        assert.equal(mod._internal.emojiFor('error'), '\u{1F6A8}');
        assert.equal(mod._internal.emojiFor('warn'), '\u{26A0}\u{FE0F}');
        assert.equal(mod._internal.emojiFor('info'), '\u{2139}\u{FE0F}');
        assert.equal(mod._internal.emojiFor('unknown'), '\u{2139}\u{FE0F}');
    } finally { teardownTmp(dir); }
});

test('notifyTelegram no incluye stacktraces (detail trunca a 400 chars)', () => {
    const { dir, mod } = setupTmp();
    try {
        const longDetail = 'a'.repeat(800);
        const res = mod.notifyTelegram({
            level: 'error',
            component: 'x',
            message: 'y',
            detail: longDetail,
        });
        const parsed = JSON.parse(fs.readFileSync(res.dropPath, 'utf8'));
        const m = parsed.text.match(/detalle: (.+)/);
        assert.ok(m);
        assert.ok(m[1].length <= 400, `detalle truncado, len=${m[1].length}`);
    } finally { teardownTmp(dir); }
});

test('notifyTelegram crea el directorio servicios/telegram/pendiente/ si no existe', () => {
    const { dir, mod } = setupTmp();
    try {
        // El directorio no existe al arrancar.
        const queueDir = path.join(dir, 'servicios', 'telegram', 'pendiente');
        assert.equal(fs.existsSync(queueDir), false);
        const res = mod.notifyTelegram({ component: 'a', message: 'b' });
        assert.equal(res.ok, true);
        assert.equal(fs.existsSync(queueDir), true);
    } finally { teardownTmp(dir); }
});

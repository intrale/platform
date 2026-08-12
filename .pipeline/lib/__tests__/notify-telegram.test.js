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

// =============================================================================
// #5400 / SEC-1 — El aviso tiene que LLEGAR.
//
// `servicio-telegram` hace `data.parse_mode || 'Markdown'`, reintenta con el
// mismo parse_mode y archiva en `fallido/`. Un `_` impar en una causa o un `*`
// desbalanceado en un título produce `400 can't parse entities` y la alerta de
// "pipeline parado" se pierde — el modo de falla exacto que el issue cierra.
// =============================================================================

test('el aviso se entrega aunque la causa, la autoría o el título contengan guion bajo, asterisco y backtick', () => {
    const { dir, mod } = setupTmp();
    try {
        const res = mod.notifyTelegram({
            level: 'error',
            component: 'wave-stall-watchdog',
            message: 'Causa: modo_ola sin allowlist *urgente* con `backtick` y [corchete',
            context: { causa: 'human_halt', autoria: 'user_name_con_guiones' },
            detail: 'issue #5400: pausa_preservada_por_restart',
        });
        assert.equal(res.ok, true);
        const parsed = JSON.parse(fs.readFileSync(res.dropPath, 'utf8'));

        // Todo metacarácter de Markdown legacy queda escapado: Telegram parsea
        // el mensaje sin error y lo renderiza literal.
        for (const meta of ['_', '*', '`', '[']) {
            const sueltos = parsed.text.split('').filter((c, i) => c === meta && parsed.text[i - 1] !== '\\');
            assert.equal(sueltos.length, 0, `quedó un '${meta}' sin escapar: ${parsed.text}`);
        }
        // El contenido sigue siendo legible (Telegram renderiza \_ como _).
        assert.ok(parsed.text.includes('modo\\_ola'), parsed.text);
        assert.ok(parsed.text.includes('user\\_name\\_con\\_guiones'), parsed.text);
        // Y el drop nunca queda sin texto ni cambia de shape.
        assert.equal(parsed.parse_mode, 'Markdown');
        assert.ok(parsed.text.length > 0);
    } finally { teardownTmp(dir); }
});

test('el escape no altera el texto que ya era seguro', () => {
    const { dir, mod } = setupTmp();
    try {
        const res = mod.notifyTelegram({ component: 'x', message: 'todo bien, sin metacaracteres' });
        const parsed = JSON.parse(fs.readFileSync(res.dropPath, 'utf8'));
        assert.ok(parsed.text.includes('todo bien, sin metacaracteres'));
        assert.ok(!parsed.text.includes('\\'), 'no debe meter backslashes de más');
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

// =============================================================================
// sanitize-payload.test.js — Tests de los wrappers por servicio (#2334)
//
// Ejecución: `node .pipeline/tests/sanitize-payload.test.js`
// Sin dependencias externas — usa el mismo runner minimal que
// sanitizer.test.js.
// =============================================================================
'use strict';

const assert = require('assert');
const path = require('path');

const modPath = path.join(__dirname, '..', 'lib', 'sanitize-payload.js');
const {
    sanitizeTelegramPayload,
    sanitizeGithubPayload,
    sanitizeDrivePayload,
    sanitizeDriveFilename,
    filenameHasSecret,
} = require(modPath);

// ─── Runner minimal ─────────────────────────────────────────────────────────
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
async function runAll() {
    let passed = 0; let failed = 0; const errors = [];
    for (const t of tests) {
        try {
            await t.fn();
            passed++;
            console.log(`  ✓ ${t.name}`);
        } catch (e) {
            failed++;
            errors.push({ name: t.name, err: e });
            console.log(`  ✗ ${t.name}`);
            console.log(`     ${e && e.message}`);
        }
    }
    console.log(`\n${passed} passed, ${failed} failed (${tests.length} total)`);
    if (failed > 0) process.exit(1);
}

// Secretos ficticios (ver comentario en sanitizer.test.js — ninguno es real).
const FAKE_AWS_AK = 'AKIAIOSFODNN7EXAMPLE';
const FAKE_GITHUB = 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaXX';
const FAKE_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abc123_xyz';
const FAKE_TG_BOT = '1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const FAKE_GOOGLE_API = 'AIzaSyA-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

// =============================================================================
// sanitizeTelegramPayload
// =============================================================================

test('telegram: sanitiza text con JWT', () => {
    const out = sanitizeTelegramPayload({ text: `Fallo auth con token ${FAKE_JWT}` });
    assert.ok(!out.text.includes(FAKE_JWT), `leak: ${out.text}`);
    assert.ok(out.text.includes('[REDACTED:JWT]'), out.text);
});

test('telegram: sanitiza caption con AWS access key', () => {
    const out = sanitizeTelegramPayload({ caption: `key=${FAKE_AWS_AK}` });
    assert.ok(!out.caption.includes(FAKE_AWS_AK));
    assert.ok(out.caption.includes('[REDACTED:AWS_ACCESS_KEY]'));
});

test('telegram: pass-through de campos no sensibles', () => {
    const payload = { document: 'C:/path/to/file.pdf', parse_mode: 'Markdown', text: 'sin secreto' };
    const out = sanitizeTelegramPayload(payload);
    assert.strictEqual(out.document, payload.document);
    assert.strictEqual(out.parse_mode, payload.parse_mode);
    assert.strictEqual(out.text, 'sin secreto');
});

test('telegram: NO muta input original (copia)', () => {
    const payload = { text: `leak ${FAKE_JWT}` };
    const out = sanitizeTelegramPayload(payload);
    assert.ok(payload.text.includes(FAKE_JWT), 'input original fue mutado');
    assert.ok(!out.text.includes(FAKE_JWT));
});

test('telegram: null-safe (devuelve input si no es objeto)', () => {
    assert.strictEqual(sanitizeTelegramPayload(null), null);
    assert.strictEqual(sanitizeTelegramPayload(undefined), undefined);
    assert.strictEqual(sanitizeTelegramPayload('string'), 'string');
});

// =============================================================================
// sanitizeGithubPayload
// =============================================================================

test('github: sanitiza body de un comment', () => {
    const out = sanitizeGithubPayload({
        action: 'comment', issue: 123,
        body: `Rechazado por error: token ${FAKE_GITHUB}`,
    });
    assert.ok(!out.body.includes(FAKE_GITHUB), `leak: ${out.body}`);
    assert.ok(out.body.includes('[REDACTED:GITHUB_TOKEN]'));
    assert.strictEqual(out.issue, 123, 'issue number no debe mutar');
});

test('github: sanitiza title + body de create-issue', () => {
    const out = sanitizeGithubPayload({
        action: 'create-issue',
        title: `Error con ${FAKE_TG_BOT}`,
        body: `Ver token ${FAKE_TG_BOT}`,
        labels: 'bug,area:pipeline',
    });
    assert.ok(!out.title.includes(FAKE_TG_BOT), `title leak: ${out.title}`);
    assert.ok(!out.body.includes(FAKE_TG_BOT), `body leak: ${out.body}`);
    assert.strictEqual(out.labels, 'bug,area:pipeline');
});

test('github: pass-through para action/issue sin campos sensibles', () => {
    const payload = { action: 'label', issue: 42, label: 'qa:passed' };
    const out = sanitizeGithubPayload(payload);
    assert.strictEqual(out.action, 'label');
    assert.strictEqual(out.issue, 42);
    assert.strictEqual(out.label, 'qa:passed');
});

test('github: no tira con payload vacío', () => {
    assert.deepStrictEqual(sanitizeGithubPayload({}), {});
});

// =============================================================================
// sanitizeDrivePayload
// =============================================================================

test('drive: sanitiza description con Google API key', () => {
    const out = sanitizeDrivePayload({
        file: 'qa/evidence/2015/qa-2015-video.mp4',
        description: `QA #2015 — usado ${FAKE_GOOGLE_API} en la corrida`,
    });
    assert.ok(!out.description.includes(FAKE_GOOGLE_API), `leak: ${out.description}`);
    assert.ok(out.description.includes('[REDACTED:GOOGLE_API_KEY]'));
});

test('drive: sanitiza title con Telegram bot token', () => {
    const out = sanitizeDrivePayload({
        title: `Video fail con bot${FAKE_TG_BOT}`,
    });
    assert.ok(!out.title.includes(FAKE_TG_BOT), `leak: ${out.title}`);
    assert.ok(out.title.includes('[REDACTED:TELEGRAM_BOT_TOKEN]'));
});

test('drive: pass-through de file path', () => {
    const payload = { file: 'qa/evidence/2015/video.mp4' };
    const out = sanitizeDrivePayload(payload);
    assert.strictEqual(out.file, payload.file);
});

// =============================================================================
// sanitizeDriveFilename
// =============================================================================

test('filename: pass-through si no hay secreto', () => {
    assert.strictEqual(sanitizeDriveFilename('qa-2015-video.mp4'), 'qa-2015-video.mp4');
    assert.strictEqual(sanitizeDriveFilename('reporte-login.pdf'), 'reporte-login.pdf');
});

test('filename: detecta AWS key en basename y trunca con hash', () => {
    const out = sanitizeDriveFilename(`video-${FAKE_AWS_AK}.mp4`);
    assert.ok(!out.includes(FAKE_AWS_AK), `leak: ${out}`);
    assert.ok(out.endsWith('.mp4'), `ext no preservada: ${out}`);
    assert.ok(/^redacted-[0-9a-f]{8}\.mp4$/.test(out), `formato inesperado: ${out}`);
});

test('filename: detecta GitHub token y trunca con hash', () => {
    const out = sanitizeDriveFilename(`leak-${FAKE_GITHUB}.pdf`);
    assert.ok(!out.includes(FAKE_GITHUB));
    assert.ok(out.endsWith('.pdf'));
});

test('filename: detecta JWT y trunca', () => {
    const out = sanitizeDriveFilename(`jwt-${FAKE_JWT}.txt`);
    assert.ok(!out.includes(FAKE_JWT));
    assert.ok(out.endsWith('.txt'));
});

test('filename: hash es determinístico (mismo input → mismo output)', () => {
    const name = `video-${FAKE_AWS_AK}.mp4`;
    assert.strictEqual(sanitizeDriveFilename(name), sanitizeDriveFilename(name));
});

test('filename: hash difiere entre distintos inputs', () => {
    const a = sanitizeDriveFilename(`a-${FAKE_AWS_AK}.mp4`);
    const b = sanitizeDriveFilename(`b-${FAKE_AWS_AK}.mp4`);
    assert.notStrictEqual(a, b, 'dos filenames distintos no deben colisionar');
});

test('filenameHasSecret: detector simple', () => {
    assert.strictEqual(filenameHasSecret('qa-2015-video.mp4'), false);
    assert.strictEqual(filenameHasSecret(`leak-${FAKE_AWS_AK}.mp4`), true);
    assert.strictEqual(filenameHasSecret(''), false);
    assert.strictEqual(filenameHasSecret(null), false);
});

// ─── Run ────────────────────────────────────────────────────────────────────
runAll();

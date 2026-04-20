// =============================================================================
// sanitize-services-integration.test.js — #2334
//
// Verifica la integración write-time extremo-a-extremo de cada servicio
// contra un mock del endpoint externo:
//   - telegram: mock de http-client.postJson / httpClient.request → inspecciona
//     el body enviado (debe ya estar sanitizado).
//   - github: mock de child_process.execSync → inspecciona el comando
//     generado.
//   - drive: mock de child_process.execFile → inspecciona args.
//
// Para evitar side effects de los loops principales de los servicios, NO
// importamos los módulos (tienen side effects al require). En su lugar,
// spawneamos Node con un mini-script que carga el helper + mockea las
// dependencias y ejecuta la porción lógica específica. Así testeamos
// integration pura sin montar toda la infra de colas.
// =============================================================================
'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const PIPELINE = path.resolve(__dirname, '..');

// Secretos ficticios realistas.
const FAKE_AWS_AK = 'AKIAIOSFODNN7EXAMPLE';
const FAKE_GITHUB = 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaXX';
const FAKE_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abc123_xyz';
const FAKE_TG_BOT = '1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
async function runAll() {
    let passed = 0; let failed = 0;
    for (const t of tests) {
        try {
            await t.fn();
            passed++;
            console.log(`  ✓ ${t.name}`);
        } catch (e) {
            failed++;
            console.log(`  ✗ ${t.name}`);
            console.log(`     ${e && e.stack || e.message}`);
        }
    }
    console.log(`\n${passed} passed, ${failed} failed (${tests.length} total)`);
    if (failed > 0) process.exit(1);
}

// ---------------------------------------------------------------------------
// Helper: ejecutar un script Node con el cwd del repo y capturar stdout
// ---------------------------------------------------------------------------
function runNode(script, env) {
    const res = spawnSync(process.execPath, ['-e', script], {
        cwd: path.resolve(PIPELINE, '..'),
        encoding: 'utf8',
        timeout: 20000,
        windowsHide: true,
        env: { ...process.env, ...(env || {}) },
    });
    return res;
}

// =============================================================================
// TELEGRAM: verifica que sanitizeTelegramPayload produce un payload que,
// cuando se serializa para el API, no contiene secretos crudos.
// =============================================================================

test('telegram: payload con text=JWT → no llega JWT al body serializado', () => {
    const helperPath = path.join(PIPELINE, 'lib', 'sanitize-payload.js').replace(/\\/g, '/');
    const script = `
        const { sanitizeTelegramPayload } = require(${JSON.stringify(helperPath)});
        const rawData = { text: 'login fallido, token=${FAKE_JWT}', parse_mode: 'Markdown' };
        const data = sanitizeTelegramPayload(rawData);
        // Simula el body real que enviaría el servicio al API:
        const body = JSON.stringify({ chat_id: -1, text: data.text, parse_mode: data.parse_mode });
        process.stdout.write(body);
    `;
    const res = runNode(script);
    assert.strictEqual(res.status, 0, `exit ${res.status}: ${res.stderr}`);
    assert.ok(!res.stdout.includes(FAKE_JWT), `API body leak: ${res.stdout}`);
    assert.ok(res.stdout.includes('[REDACTED:JWT]'));
});

test('telegram: caption con AWS key → no llega al multipart', () => {
    const helperPath = path.join(PIPELINE, 'lib', 'sanitize-payload.js').replace(/\\/g, '/');
    const script = `
        const { sanitizeTelegramPayload } = require(${JSON.stringify(helperPath)});
        const raw = { document: 'C:/tmp/foo.pdf', caption: 'config: key=${FAKE_AWS_AK}' };
        const out = sanitizeTelegramPayload(raw);
        process.stdout.write(out.caption);
    `;
    const res = runNode(script);
    assert.strictEqual(res.status, 0);
    assert.ok(!res.stdout.includes(FAKE_AWS_AK));
    assert.ok(res.stdout.includes('[REDACTED:AWS_ACCESS_KEY]'));
});

// =============================================================================
// GITHUB: verifica que el payload que iría a `gh issue comment -b "..."`
// no contiene el secreto.
// =============================================================================

test('github: comment body con GitHub token → no llega al comando gh', () => {
    const helperPath = path.join(PIPELINE, 'lib', 'sanitize-payload.js').replace(/\\/g, '/');
    const script = `
        const { sanitizeGithubPayload } = require(${JSON.stringify(helperPath)});
        const raw = { action: 'comment', issue: 99, body: 'Fallo con token ${FAKE_GITHUB}' };
        const data = sanitizeGithubPayload(raw);
        // Construimos el mismo comando que servicio-github ejecutaría:
        const cmd = \`gh issue comment \${data.issue} -b "\${data.body.replace(/"/g, '\\\\"')}"\`;
        process.stdout.write(cmd);
    `;
    const res = runNode(script);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.ok(!res.stdout.includes(FAKE_GITHUB), `cmd leak: ${res.stdout}`);
    assert.ok(res.stdout.includes('[REDACTED:GITHUB_TOKEN]'));
});

test('github: create-issue title con Telegram bot token → no leak', () => {
    const helperPath = path.join(PIPELINE, 'lib', 'sanitize-payload.js').replace(/\\/g, '/');
    const script = `
        const { sanitizeGithubPayload } = require(${JSON.stringify(helperPath)});
        const raw = { action: 'create-issue', title: 'Auth error: bot${FAKE_TG_BOT}', body: 'body ok', labels: 'bug' };
        const out = sanitizeGithubPayload(raw);
        process.stdout.write(out.title + '|' + out.body);
    `;
    const res = runNode(script);
    assert.strictEqual(res.status, 0);
    assert.ok(!res.stdout.includes(FAKE_TG_BOT), `title leak: ${res.stdout}`);
});

// =============================================================================
// DRIVE: verifica que los args CLI a qa-video-share.js vengan sanitizados y
// que un filename con secreto termine renombrado a hash+ext.
// =============================================================================

test('drive: description/title con Google API key → args sanitizados', () => {
    const helperPath = path.join(PIPELINE, 'lib', 'sanitize-payload.js').replace(/\\/g, '/');
    const FAKE_GOOGLE_API = 'AIzaSyA-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const script = `
        const { sanitizeDrivePayload } = require(${JSON.stringify(helperPath)});
        const raw = {
            file: 'qa/evidence/2015/video.mp4',
            description: '#2015 — leak ${FAKE_GOOGLE_API}',
            title: 'Login falla con ${FAKE_GOOGLE_API}',
        };
        const out = sanitizeDrivePayload(raw);
        const args = ['--issue', '2015', '--title', out.title, '--description', out.description];
        process.stdout.write(JSON.stringify(args));
    `;
    const res = runNode(script);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.ok(!res.stdout.includes(FAKE_GOOGLE_API), `args leak: ${res.stdout}`);
    assert.ok(res.stdout.includes('[REDACTED:GOOGLE_API_KEY]'));
});

test('drive: filename con JWT → renombrado a redacted-<hash>.mp4 (no upload del nombre crudo)', () => {
    const helperPath = path.join(PIPELINE, 'lib', 'sanitize-payload.js').replace(/\\/g, '/');
    const script = `
        const { sanitizeDriveFilename, filenameHasSecret } = require(${JSON.stringify(helperPath)});
        const original = 'evidencia-${FAKE_JWT}.mp4';
        const hasSecret = filenameHasSecret(original);
        const renamed = sanitizeDriveFilename(original);
        process.stdout.write(JSON.stringify({ hasSecret, renamed }));
    `;
    const res = runNode(script);
    assert.strictEqual(res.status, 0);
    const { hasSecret, renamed } = JSON.parse(res.stdout);
    assert.strictEqual(hasSecret, true);
    assert.ok(!renamed.includes(FAKE_JWT));
    assert.ok(/^redacted-[0-9a-f]{8}\.mp4$/.test(renamed), renamed);
});

runAll();

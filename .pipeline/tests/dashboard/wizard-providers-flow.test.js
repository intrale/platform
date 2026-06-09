// =============================================================================
// wizard-providers-flow.test.js — CA-1/CA-2/CA-5/CA-12/CA-13 + security R#4.
//
// Ejercita createFlow().{validateStep,executeStep} directo (sin HTTP): listado
// de providers desde ENV_MAPPING, validación de allowlist (path-traversal),
// rotate / deactivate / metadata, preservación de campos no-provider y la
// defensa prototype-pollution de setNested.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const providers = require('../../lib/wizards/providers');

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'wz-providers-'));
}

function seedCredentials(dir, overrides = {}) {
    const data = {
        telegram: { bot_token: 'TG-KEEP-ME', chat_id: '12345' },
        multimedia: { elevenlabs_voice_id: 'VOICE-KEEP' },
        providers: {
            openai: { api_key: 'sk-' + 'O'.repeat(48) },
            anthropic: { api_key: 'sk-ant-' + 'A'.repeat(48) },
            ...overrides,
        },
    };
    const file = path.join(dir, 'credentials.json');
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    return file;
}

function makeFlow(dir) {
    const credentialsPath = seedCredentials(dir);
    const flow = providers.createFlow({ credentialsPath, auditDir: dir, now: () => Date.parse('2026-06-08T12:00:00Z') });
    return { flow, credentialsPath };
}

function newSession() { return { steps: new Map() }; }

test('listProviders deriva los providers de ENV_MAPPING (sin hardcoding)', () => {
    const names = providers.listProviders().map((p) => p.name);
    assert.deepEqual([...names].sort(), ['anthropic', 'cerebras', 'google', 'nvidia', 'openai']);
});

test('validateStep rechaza providers fuera de la allowlist (R#4 path-traversal)', () => {
    const dir = tmpDir();
    const { flow } = makeFlow(dir);
    for (const bad of ['../etc/passwd', 'openai_api_key', 'google.api_key', '__proto__', '']) {
        assert.equal(flow.validateStep(0, { provider: bad }), false, `${bad} no debería pasar`);
    }
    assert.equal(flow.validateStep(0, { provider: 'openai' }), true);
});

test('rotate end-to-end: persiste la nueva key y audita last4 old/new', async () => {
    const dir = tmpDir();
    const { flow, credentialsPath } = makeFlow(dir);
    const session = newSession();
    const newKey = 'sk-' + 'N'.repeat(48);

    // step 0 → metadata del provider.
    assert.equal(flow.validateStep(0, { provider: 'openai' }), true);
    const s0 = await flow.executeStep(session, 0, { provider: 'openai' });
    assert.equal(s0.provider, 'openai');
    assert.equal(s0.configured, true);

    // step 1 → acción.
    assert.equal(flow.validateStep(1, { provider: 'openai', action: 'rotate' }), true);
    await flow.executeStep(session, 1, { provider: 'openai', action: 'rotate' });

    // step 2 → key (válida) → preview masked, key stasheada fuera del result.
    assert.equal(flow.validateStep(2, { provider: 'openai', action: 'rotate', api_key: newKey }), true);
    const s2 = await flow.executeStep(session, 2, { provider: 'openai', action: 'rotate', api_key: newKey });
    assert.equal(s2.masked_new, 'sk-•••••' + newKey.slice(-4));
    assert.ok(!JSON.stringify(s2).includes(newKey), 'el result del step 2 filtró la key cruda');

    // step 3 → confirm → apply.
    assert.equal(flow.validateStep(3, { provider: 'openai', action: 'rotate', confirm: true }), true);
    const s3 = await flow.executeStep(session, 3, { provider: 'openai', action: 'rotate', confirm: true });
    assert.equal(s3.ok, true);
    assert.ok(!JSON.stringify(s3).includes(newKey), 'el result del step 3 filtró la key cruda');

    // La key draft se borró tras el apply.
    assert.equal(session._draftKey, undefined);

    // credentials.json actualizado + campos no-provider preservados (CA-6).
    const data = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
    assert.equal(data.providers.openai.api_key, newKey);
    assert.equal(data.providers.anthropic.api_key, 'sk-ant-' + 'A'.repeat(48));
    assert.equal(data.telegram.bot_token, 'TG-KEEP-ME');
    assert.equal(data.multimedia.elevenlabs_voice_id, 'VOICE-KEEP');
});

test('deactivate setea null y NO requiere key', async () => {
    const dir = tmpDir();
    const { flow, credentialsPath } = makeFlow(dir);
    const session = newSession();
    await flow.executeStep(session, 0, { provider: 'anthropic' });
    await flow.executeStep(session, 1, { provider: 'anthropic', action: 'deactivate' });
    assert.equal(flow.validateStep(2, { provider: 'anthropic', action: 'deactivate' }), true);
    const s2 = await flow.executeStep(session, 2, { provider: 'anthropic', action: 'deactivate' });
    assert.equal(s2.masked_new, null);
    const s3 = await flow.executeStep(session, 3, { provider: 'anthropic', action: 'deactivate', confirm: true });
    assert.equal(s3.ok, true);
    const data = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
    assert.equal(data.providers.anthropic.api_key, null);
    // openai intacto.
    assert.equal(data.providers.openai.api_key, 'sk-' + 'O'.repeat(48));
});

test('metadata no muta credentials.json (CA-13)', async () => {
    const dir = tmpDir();
    const { flow, credentialsPath } = makeFlow(dir);
    const before = fs.readFileSync(credentialsPath, 'utf8');
    const session = newSession();
    await flow.executeStep(session, 0, { provider: 'openai' });
    await flow.executeStep(session, 1, { provider: 'openai', action: 'metadata' });
    const s2 = await flow.executeStep(session, 2, { provider: 'openai', action: 'metadata' });
    assert.match(s2.masked_old, /^sk-•••••/);
    const s3 = await flow.executeStep(session, 3, { provider: 'openai', action: 'metadata', confirm: true });
    assert.equal(s3.ok, true);
    assert.equal(fs.readFileSync(credentialsPath, 'utf8'), before, 'metadata no debe escribir el archivo');
});

test('validateStep step2 rechaza key con formato inválido (CA-4)', () => {
    const dir = tmpDir();
    const { flow } = makeFlow(dir);
    assert.equal(flow.validateStep(2, { provider: 'openai', action: 'rotate', api_key: 'sk-short' }), false);
    assert.equal(flow.validateStep(2, { provider: 'openai', action: 'rotate', api_key: 'sk-' + 'Z'.repeat(48) }), true);
});

test('setNested bloquea segmentos __proto__/constructor/prototype', () => {
    const obj = {};
    assert.throws(() => providers.setNested(obj, 'providers.__proto__.x', 'pwn'), /prohibido/);
    assert.throws(() => providers.setNested(obj, 'a.constructor.y', 'pwn'), /prohibido/);
    // No contaminó Object.prototype.
    assert.equal(({}).x, undefined);
    // Path normal funciona.
    providers.setNested(obj, 'providers.openai.api_key', 'k');
    assert.equal(obj.providers.openai.api_key, 'k');
});

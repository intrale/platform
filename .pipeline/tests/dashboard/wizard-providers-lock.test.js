// =============================================================================
// wizard-providers-lock.test.js — CA-6 (file-lock + concurrencia).
//
// Dos rotaciones concurrentes a providers distintos → ambas persisten. Dos al
// mismo provider → la última gana sin corromper el JSON. El archivo nunca queda
// con BOM (riesgo Windows del épico padre).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const providers = require('../../lib/wizards/providers');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'wz-providers-lock-')); }

function seed(dir) {
    const data = {
        telegram: { bot_token: 'TG' },
        providers: {
            openai: { api_key: 'sk-' + 'O'.repeat(48) },
            anthropic: { api_key: 'sk-ant-' + 'A'.repeat(48) },
        },
    };
    const file = path.join(dir, 'credentials.json');
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    return file;
}

async function rotate(flow, provider, key) {
    const session = { steps: new Map() };
    await flow.executeStep(session, 2, { provider, action: 'rotate', api_key: key });
    return flow.executeStep(session, 3, { provider, action: 'rotate', confirm: true });
}

test('rotaciones paralelas a providers distintos: ambas persisten', async () => {
    const dir = tmpDir();
    const credentialsPath = seed(dir);
    const flow = providers.createFlow({ credentialsPath, auditDir: dir });
    const keyO = 'sk-' + 'X'.repeat(48);
    const keyA = 'sk-ant-' + 'Y'.repeat(48);

    await Promise.all([rotate(flow, 'openai', keyO), rotate(flow, 'anthropic', keyA)]);

    const data = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
    assert.equal(data.providers.openai.api_key, keyO);
    assert.equal(data.providers.anthropic.api_key, keyA);
    // El campo no-provider sigue ahí (no hubo overwrite ciego).
    assert.equal(data.telegram.bot_token, 'TG');
});

test('rotaciones paralelas al mismo provider: última gana, JSON íntegro', async () => {
    const dir = tmpDir();
    const credentialsPath = seed(dir);
    const flow = providers.createFlow({ credentialsPath, auditDir: dir });
    const k1 = 'sk-' + '1'.repeat(48);
    const k2 = 'sk-' + '2'.repeat(48);

    await Promise.all([rotate(flow, 'openai', k1), rotate(flow, 'openai', k2)]);

    const raw = fs.readFileSync(credentialsPath, 'utf8');
    // JSON parseable (sin corrupción).
    const data = JSON.parse(raw);
    // Quedó una de las dos (la que escribió de última bajo el lock).
    assert.ok([k1, k2].includes(data.providers.openai.api_key));
    // Sin BOM al inicio (riesgo CRLF/BOM en Windows).
    assert.notEqual(raw.charCodeAt(0), 0xFEFF);
    assert.equal(raw[0], '{');
});

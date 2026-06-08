// =============================================================================
// wizard-providers-audit.test.js — CA-10 + security R#6.
//
// Tras rotar/desactivar, el audit NDJSON tiene la entry con last4_old/last4_new
// y action correcta, NUNCA la key cruda ni un campo api_key, y la hash-chain
// (verifyChain) se mantiene íntegra a lo largo de N operaciones.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const providers = require('../../lib/wizards/providers');
const auditLog = require('../../lib/audit-log');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'wz-providers-audit-')); }

function seed(dir) {
    const data = { providers: { openai: { api_key: 'sk-' + 'O'.repeat(48) }, anthropic: { api_key: 'sk-ant-' + 'A'.repeat(48) } } };
    const file = path.join(dir, 'credentials.json');
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    return file;
}

function readEntries(auditFile) {
    return fs.readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function rotate(flow, provider, key) {
    const session = { steps: new Map() };
    await flow.executeStep(session, 2, { provider, action: 'rotate', api_key: key });
    return flow.executeStep(session, 3, { provider, action: 'rotate', confirm: true });
}

test('rotación deja entry con last4 old/new y action rotate_provider', async () => {
    const dir = tmpDir();
    const credentialsPath = seed(dir);
    const flow = providers.createFlow({ credentialsPath, auditDir: dir, now: () => Date.parse('2026-06-08T00:00:00Z') });
    const newKey = 'sk-' + 'N'.repeat(44) + 'WXYZ';

    await rotate(flow, 'openai', newKey);

    const entries = readEntries(flow.auditFile);
    assert.equal(entries.length, 1);
    const e = entries[0];
    assert.equal(e.action, 'rotate_provider');
    assert.equal(e.provider, 'openai');
    assert.equal(e.last4_old, 'OOOO');
    assert.equal(e.last4_new, 'WXYZ');
    assert.equal(e.outcome, 'success');
    // NUNCA la key cruda ni campo api_key.
    assert.ok(!('api_key' in e));
    assert.ok(!JSON.stringify(e).includes(newKey));
});

test('desactivación deja action deactivate_provider con last4_new null', async () => {
    const dir = tmpDir();
    const credentialsPath = seed(dir);
    const flow = providers.createFlow({ credentialsPath, auditDir: dir });
    const session = { steps: new Map() };
    await flow.executeStep(session, 3, { provider: 'anthropic', action: 'deactivate', confirm: true });
    const e = readEntries(flow.auditFile)[0];
    assert.equal(e.action, 'deactivate_provider');
    assert.equal(e.last4_new, null);
    assert.equal(e.last4_old, 'AAAA');
});

test('N operaciones mantienen la hash-chain (verifyChain ok)', async () => {
    const dir = tmpDir();
    const credentialsPath = seed(dir);
    const flow = providers.createFlow({ credentialsPath, auditDir: dir });
    for (let i = 0; i < 5; i++) {
        await rotate(flow, 'openai', 'sk-' + String(i).repeat(48).slice(0, 48));
    }
    const res = auditLog.verifyChain(flow.auditFile);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(readEntries(flow.auditFile).length, 5);
});

// =============================================================================
// wizard-providers-no-leak.test.js — security R#1 (no-log de key cruda).
//
// Espía console.{log,info,warn,error,debug} durante validación + rotación con una
// key dummy que contiene el marcador `PROBE`. NINGUNA llamada al spy debe
// contener `PROBE`, y el audit NDJSON tampoco. El credentials.json SÍ debe
// contenerla (es el destino legítimo).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const providers = require('../../lib/wizards/providers');
const validator = require('../../lib/providers-key-validator');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'wz-providers-leak-')); }

const PROBE_KEY = 'sk-PROBE' + 'X'.repeat(44); // válida para openai, contiene PROBE.

test('validación + rotación no loguean la key cruda en ningún canal', async () => {
    const dir = tmpDir();
    const credentialsPath = path.join(dir, 'credentials.json');
    fs.writeFileSync(credentialsPath, JSON.stringify({ providers: { openai: { api_key: 'sk-' + 'O'.repeat(48) } } }, null, 2), 'utf8');

    const calls = [];
    const methods = ['log', 'info', 'warn', 'error', 'debug'];
    const originals = {};
    for (const m of methods) {
        originals[m] = console[m];
        console[m] = (...args) => { calls.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
    }

    try {
        // Validación directa.
        validator.validateProviderKey('openai', PROBE_KEY);
        // Flow completo.
        const flow = providers.createFlow({ credentialsPath, auditDir: dir });
        const session = { steps: new Map() };
        await flow.executeStep(session, 2, { provider: 'openai', action: 'rotate', api_key: PROBE_KEY });
        await flow.executeStep(session, 3, { provider: 'openai', action: 'rotate', confirm: true });

        for (const line of calls) {
            assert.ok(!line.includes('PROBE'), `log filtró la key: ${line}`);
        }

        // El audit NDJSON no contiene PROBE.
        const flow2 = flow; // mismo auditFile
        const auditRaw = fs.readFileSync(flow2.auditFile, 'utf8');
        assert.ok(!auditRaw.includes('PROBE'), 'el audit filtró la key cruda');

        // credentials.json SÍ la tiene (destino legítimo).
        const data = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
        assert.equal(data.providers.openai.api_key, PROBE_KEY);
    } finally {
        for (const m of methods) console[m] = originals[m];
    }
});

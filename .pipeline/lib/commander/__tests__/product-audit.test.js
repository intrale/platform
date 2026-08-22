// =============================================================================
// product-audit.test.js — Recorder product-aware tamper-evident (#4780 SR-7).
// Verifica que createProductAudit encadena y redacta, reusando lib/audit-log.js.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createProductAudit, ORIGEN_TELEGRAM } = require('../audit-log');
const chainedAudit = require('../../audit-log');

function tmpFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prodaudit-'));
    return path.join(dir, 'audit.jsonl');
}

test('record: entry lleva actor+productId+origen=telegram+action+result+ts y encadena', () => {
    const file = tmpFile();
    let clock = 1000;
    const audit = createProductAudit({ file, now: () => clock });
    audit.record({ actor: '111', productId: 'Intrale', action: 'pause', result: 'ok' });
    clock = 2000;
    audit.record({ actor: '111', productId: 'Comercios-AR', action: 'status', result: 'ok' });

    const entries = chainedAudit.readAll(file);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].actor, '111');
    assert.equal(entries[0].productId, 'Intrale');
    assert.equal(entries[0].origen, ORIGEN_TELEGRAM);
    assert.equal(entries[0].action, 'pause');
    assert.ok(entries[0].hash_self);
    assert.equal(entries[1].hash_prev, entries[0].hash_self); // chain
});

test('verify: chain íntegro → ok; tras editar → roto', () => {
    const file = tmpFile();
    const audit = createProductAudit({ file, now: () => 1000 });
    audit.record({ actor: '111', productId: 'Intrale', action: 'pause', result: 'ok' });
    audit.record({ actor: '111', productId: 'Intrale', action: 'resume', result: 'ok' });
    assert.equal(audit.verify().ok, true);

    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const e0 = JSON.parse(lines[0]);
    e0.actor = '000'; // tamper
    lines[0] = JSON.stringify(e0);
    fs.writeFileSync(file, lines.join('\n') + '\n');
    assert.equal(audit.verify().ok, false);
});

test('record: redacta secrets via redactor inyectado', () => {
    const file = tmpFile();
    const audit = createProductAudit({
        file,
        now: () => 1000,
        redact: (s) => String(s).replace(/SECRET/g, '[REDACTED]'),
    });
    audit.record({ actor: 'SECRET-user', productId: 'Intrale', action: 'pause', result: 'ok' });
    const entries = chainedAudit.readAll(file);
    assert.equal(entries[0].actor, '[REDACTED]-user');
});

test('createProductAudit: file obligatorio', () => {
    assert.throws(() => createProductAudit({}), /file es obligatorio/);
});

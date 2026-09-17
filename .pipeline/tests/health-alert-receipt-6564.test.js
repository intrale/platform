'use strict';

// #6564 CA-3 — Las alertas del canal *Multi-Provider Health* salen con un
// `_correlationId` válido para que `svc-telegram` escriba el recibo `enviado`
// con el `message_id` real (bus de recibos #4082). Es la evidencia de recepción
// aceptada por el operador (17/9, opción A): `ok:true` + `message_id`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const healthCron = require('../lib/multi-provider/health-cron');
const telegramReceipt = require('../lib/telegram-receipt');

function tmpRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'mp-health-receipt-6564-'));
}

function readOnlyDropfile(root) {
    const dir = path.join(root, 'servicios', 'telegram', 'pendiente');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('mp-health.json'));
    assert.equal(files.length, 1, 'debe haber exactamente un dropfile');
    return JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
}

const PAYLOAD = {
    event: 'plan_tier_unknown', provider: 'gemini-google', provider_state: 'green',
    consecutive_count: 2, observed_at: '2026-09-17T12:00:00.000Z',
};

test('health-cron · el dropfile de una alerta lleva un _correlationId válido generado', () => {
    const root = tmpRoot();
    try {
        assert.equal(healthCron.defaultTelegramSender(PAYLOAD, { pipelineDir: root }), true);
        const msg = readOnlyDropfile(root);
        assert.ok(telegramReceipt.isValidCorrelationId(msg._correlationId), `cid inválido: ${msg._correlationId}`);
        assert.match(msg._correlationId, /^mphealth-\d+-[0-9a-f]{8}$/);
        assert.equal(msg.parse_mode, 'Markdown');
        assert.match(msg.text, /no pudo verificar la cuota del plan/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('health-cron · un _correlationId externo válido se respeta (lo usa la evidencia de #6564)', () => {
    const root = tmpRoot();
    try {
        const cid = telegramReceipt.generateCorrelationId('ev6564');
        healthCron.defaultTelegramSender(PAYLOAD, { pipelineDir: root, correlationId: cid });
        assert.equal(readOnlyDropfile(root)._correlationId, cid);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('health-cron · un _correlationId externo inválido se reemplaza, nunca se omite (R3)', () => {
    const root = tmpRoot();
    try {
        healthCron.defaultTelegramSender(PAYLOAD, { pipelineDir: root, correlationId: '../../etc' });
        const cid = readOnlyDropfile(root)._correlationId;
        assert.ok(telegramReceipt.isValidCorrelationId(cid));
        assert.notEqual(cid, '../../etc');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('health-cron · el recibo enviado que escribiría svc-telegram para ese cid es válido y lleva message_id', () => {
    const root = tmpRoot();
    try {
        const cid = telegramReceipt.generateCorrelationId('ev6564');
        healthCron.defaultTelegramSender(PAYLOAD, { pipelineDir: root, correlationId: cid });
        const msg = readOnlyDropfile(root);
        // Mismo contrato que `servicio-telegram.js::writeSentReceiptIfAny`.
        const recibos = telegramReceipt.receiptsDir(root);
        const file = telegramReceipt.writeReceipt(recibos, {
            correlationId: msg._correlationId, status: telegramReceipt.STATUS_ENVIADO, messageIds: [4242],
        });
        const receipt = telegramReceipt.parseReceipt(fs.readFileSync(file, 'utf8'));
        assert.ok(receipt, 'recibo parseable');
        assert.equal(receipt.correlationId, cid);
        assert.deepEqual(receipt.messageIds, [4242]);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

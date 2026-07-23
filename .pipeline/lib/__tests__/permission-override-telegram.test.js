// =============================================================================
// permission-override-telegram.test.js — formato natural y enqueue
// Issue #3082 — CA-17 + G2 (UX).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const telegramHelper = require('../permission-override-telegram');

function sampleEntry(overrides = {}) {
    return {
        type: 'permission_override',
        skill: 'qa',
        provider: 'openai-codex',
        mode_requerido: 'bypassPermissions',
        mode_otorgado: 'full-auto',
        capabilities_diff: ['tool_use_gated'],
        justificacion: 'Necesitamos QA en codex porque la cuota Anthropic se agotó y la window QA está activa.',
        autor: 'leito.larreta@gmail.com',
        ttl_horas: 24,
        created_at: Date.now(),
        hash_self: 'abcdef0123456789' + 'f'.repeat(48),
        hash_prev: 'GENESIS',
        ...overrides,
    };
}

test('formatOverrideMessage produce un texto Markdown natural con bloques requeridos (G2)', () => {
    const payload = telegramHelper.formatOverrideMessage(sampleEntry());
    assert.equal(payload.parse_mode, 'Markdown');
    const text = payload.text;
    // Bloques obligatorios G2
    assert.match(text, /qa/);
    assert.match(text, /openai-codex/);
    assert.match(text, /24h/);
    assert.match(text, /tool_use_gated/);
    assert.match(text, /leito\.larreta/);
    assert.match(text, /Para revocar antes del TTL/);
    assert.match(text, /revoke-permission\.js/);
});

test('formatOverrideMessage incluye fecha absoluta + relativa (G3)', () => {
    const payload = telegramHelper.formatOverrideMessage(sampleEntry());
    assert.match(payload.text, /UTC/);
    assert.match(payload.text, /vence en \d+h \d+m/);
});

test('formatOverrideMessage varía el verbo de apertura según hash (anti-template robótico, G2)', () => {
    const verbs = new Set();
    for (let i = 0; i < 50; i++) {
        const hash = i.toString(16).padStart(4, '0') + 'f'.repeat(60);
        const payload = telegramHelper.formatOverrideMessage(sampleEntry({ hash_self: hash }));
        // El verbo de apertura es lo que viene después de la 🛂 antes del * de cierre
        const m = payload.text.match(/🛂 \*(.+?)\*/);
        if (m) verbs.add(m[1]);
    }
    assert.ok(verbs.size >= 2, `Esperaba varios verbos rotativos, encontré: ${[...verbs].join(', ')}`);
});

test('formatOverrideMessage trunca justificación larga a 80 chars con elipsis', () => {
    const long = 'a'.repeat(200);
    const payload = telegramHelper.formatOverrideMessage(sampleEntry({ justificacion: long }));
    assert.match(payload.text, /…/);
});

test('enqueueTelegramNotification escribe en pendiente/ y crea dir si falta', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-tlg-'));
    const queued = telegramHelper.enqueueTelegramNotification({
        payload: { text: 'hola', parse_mode: 'Markdown' },
        pipelineRoot: tmp,
    });
    assert.ok(fs.existsSync(queued));
    const content = JSON.parse(fs.readFileSync(queued, 'utf8'));
    assert.equal(content.text, 'hola');
});

test('notifyOverrideCreated combina format + enqueue en una sola llamada', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-tlg2-'));
    const queued = telegramHelper.notifyOverrideCreated(sampleEntry(), { pipelineRoot: tmp });
    assert.ok(fs.existsSync(queued));
    const content = JSON.parse(fs.readFileSync(queued, 'utf8'));
    assert.match(content.text, /qa/);
});

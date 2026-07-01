// =============================================================================
// Tests sherlock-presence.js (#4335) — canal de presencia observacional.
//
// Cubre:
//   - writePresence descarta campos no whitelisteados (SEC-1: sin PII).
//   - readPresence aplica TTL (presencia stale se ignora).
//   - clearPresence es idempotente.
//   - fase inválida es rechazada.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const presence = require('../sherlock-presence');

function tmpRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'sherlock-presence-'));
}

test('writePresence: solo persiste petitionId/fase/startedAt (SEC-1, sin PII)', () => {
    const root = tmpRoot();
    presence.writePresence({
        petitionId: 'opaque-hex',
        fase: 'verificando',
        // Campos NO whitelisteados que NO deben llegar a disco:
        chatId: -100999,
        texto: 'mensaje secreto del usuario',
        tokens: 12345,
    }, { pipelineRoot: root, now: () => 1000 });

    const raw = JSON.parse(fs.readFileSync(presence.presencePath(root), 'utf8'));
    assert.deepEqual(Object.keys(raw).sort(), ['fase', 'petitionId', 'startedAt']);
    assert.equal(raw.petitionId, 'opaque-hex');
    assert.equal(raw.fase, 'verificando');
    assert.equal(raw.startedAt, 1000);
    assert.ok(!('chatId' in raw) && !('texto' in raw) && !('tokens' in raw));

    fs.rmSync(root, { recursive: true, force: true });
});

test('writePresence: fase por defecto "verificando" si no se pasa', () => {
    const root = tmpRoot();
    const rec = presence.writePresence({ petitionId: 'x' }, { pipelineRoot: root, now: () => 5 });
    assert.equal(rec.fase, 'verificando');
    fs.rmSync(root, { recursive: true, force: true });
});

test('writePresence: fase inválida lanza', () => {
    const root = tmpRoot();
    assert.throws(() => presence.writePresence({ petitionId: 'x', fase: 'pensando' }, { pipelineRoot: root }),
        /fase inválida/);
    fs.rmSync(root, { recursive: true, force: true });
});

test('writePresence: petitionId ausente lanza', () => {
    const root = tmpRoot();
    assert.throws(() => presence.writePresence({ fase: 'verificando' }, { pipelineRoot: root }),
        /petitionId requerido/);
    fs.rmSync(root, { recursive: true, force: true });
});

test('readPresence: aplica TTL — presencia fresca se lee, stale se ignora', () => {
    const root = tmpRoot();
    presence.writePresence({ petitionId: 'op', fase: 'verificando' }, { pipelineRoot: root, now: () => 10_000 });

    const fresh = presence.readPresence({ pipelineRoot: root, now: () => 12_000, ttlMs: 5000 });
    assert.ok(fresh, 'dentro del TTL debe leerse');
    assert.equal(fresh.petitionId, 'op');
    assert.equal(fresh.durationMs, 2000);

    const stale = presence.readPresence({ pipelineRoot: root, now: () => 20_000, ttlMs: 5000 });
    assert.equal(stale, null, 'fuera del TTL debe ignorarse');

    fs.rmSync(root, { recursive: true, force: true });
});

test('clearPresence: idempotente (no lanza si no existe)', () => {
    const root = tmpRoot();
    assert.doesNotThrow(() => presence.clearPresence({ pipelineRoot: root }));
    presence.writePresence({ petitionId: 'op', fase: 'verificando' }, { pipelineRoot: root });
    presence.clearPresence({ pipelineRoot: root });
    assert.equal(presence.readPresence({ pipelineRoot: root }), null);
    assert.doesNotThrow(() => presence.clearPresence({ pipelineRoot: root }));
    fs.rmSync(root, { recursive: true, force: true });
});

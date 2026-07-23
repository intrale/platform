// =============================================================================
// Tests `commander-presence` — #3948 (EP-7 / #3947)
//
// Cubre los criterios de aceptación verificables del helper de presencia
// observacional del Commander:
//   - CA-1: write → readPresence → clear (idempotente)
//   - CA-5: enum cerrado de fase (rechazo de fases fuera del set, al escribir)
//   - CA-6 / SEC-1: NO persiste campos PII (texto, chat_id, from, tokens)
//   - CA-8 / SEC-4: TTL — presencia stale se ignora en lectura
//   - CA-9 / SEC-5: escritura atómica (sin temp leftover; nunca JSON parcial)
//   - updatePhase preserva petitionId/startedAt y es no-op sin presencia previa
//
// Todo se aísla en un tmp dir vía `pipelineRoot` — jamás toca el
// `commander-presence.json` real del repo.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const presence = require('../commander-presence');

function mkTmpRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'commander-presence-'));
}

test('writePresence persiste petitionId/fase/startedAt y readPresence lo recupera', () => {
    const root = mkTmpRoot();
    const rec = presence.writePresence({ petitionId: 'abc123', fase: 'pensando' }, { pipelineRoot: root, now: () => 1000 });
    assert.equal(rec.petitionId, 'abc123');
    assert.equal(rec.fase, 'pensando');
    assert.equal(rec.startedAt, 1000);

    const read = presence.readPresence({ pipelineRoot: root, now: () => 1500 });
    assert.ok(read);
    assert.equal(read.petitionId, 'abc123');
    assert.equal(read.fase, 'pensando');
    assert.equal(read.durationMs, 500);
});

test('CA-5: writePresence rechaza fases fuera del enum cerrado', () => {
    const root = mkTmpRoot();
    assert.throws(() => presence.writePresence({ petitionId: 'x', fase: 'bailando' }, { pipelineRoot: root }), /fase inválida/);
    assert.throws(() => presence.writePresence({ petitionId: 'x', fase: '' }, { pipelineRoot: root }), /fase inválida/);
    // El archivo no debe haberse creado tras el rechazo.
    assert.equal(fs.existsSync(presence.presencePath(root)), false);
});

test('writePresence exige petitionId opaco (string no vacío)', () => {
    const root = mkTmpRoot();
    assert.throws(() => presence.writePresence({ fase: 'pensando' }, { pipelineRoot: root }), /petitionId/);
    assert.throws(() => presence.writePresence({ petitionId: '', fase: 'pensando' }, { pipelineRoot: root }), /petitionId/);
});

test('CA-6 / SEC-1: NO persiste campos PII aunque el caller los pase', () => {
    const root = mkTmpRoot();
    presence.writePresence({
        petitionId: 'opaque-id',
        fase: 'transcribiendo',
        // Campos PII que NO deben tocar disco:
        text: 'creá un issue para el bug de login',
        chat_id: 123456789,
        from: 'leito',
        username: 'leitolarreta',
        token: 'ghp_secret',
        startedAt: 42,
    }, { pipelineRoot: root });

    const onDisk = JSON.parse(fs.readFileSync(presence.presencePath(root), 'utf8'));
    assert.deepEqual(Object.keys(onDisk).sort(), ['fase', 'petitionId', 'startedAt']);
    assert.equal(onDisk.text, undefined);
    assert.equal(onDisk.chat_id, undefined);
    assert.equal(onDisk.from, undefined);
    assert.equal(onDisk.username, undefined);
    assert.equal(onDisk.token, undefined);
    // El JSON crudo no contiene ningún rastro de los valores PII.
    const rawText = fs.readFileSync(presence.presencePath(root), 'utf8');
    assert.equal(rawText.includes('login'), false);
    assert.equal(rawText.includes('leito'), false);
    assert.equal(rawText.includes('ghp_secret'), false);
});

test('updatePhase preserva petitionId/startedAt y cambia solo la fase', () => {
    const root = mkTmpRoot();
    presence.writePresence({ petitionId: 'p1', fase: 'transcribiendo' }, { pipelineRoot: root, now: () => 100 });
    const updated = presence.updatePhase('verificando', { pipelineRoot: root });
    assert.ok(updated);
    assert.equal(updated.petitionId, 'p1');
    assert.equal(updated.fase, 'verificando');
    assert.equal(updated.startedAt, 100);
});

test('updatePhase rechaza fase fuera del enum', () => {
    const root = mkTmpRoot();
    presence.writePresence({ petitionId: 'p1', fase: 'pensando' }, { pipelineRoot: root });
    assert.throws(() => presence.updatePhase('volando', { pipelineRoot: root }), /fase inválida/);
});

test('updatePhase es no-op (null) si no hay presencia activa', () => {
    const root = mkTmpRoot();
    const r = presence.updatePhase('enviando', { pipelineRoot: root });
    assert.equal(r, null);
    // No resucita presencia: el archivo sigue sin existir.
    assert.equal(fs.existsSync(presence.presencePath(root)), false);
});

test('CA-1: clearPresence elimina el archivo y es idempotente', () => {
    const root = mkTmpRoot();
    presence.writePresence({ petitionId: 'p1', fase: 'enviando' }, { pipelineRoot: root });
    assert.equal(fs.existsSync(presence.presencePath(root)), true);
    presence.clearPresence({ pipelineRoot: root });
    assert.equal(fs.existsSync(presence.presencePath(root)), false);
    // Segundo clear sobre archivo ausente no lanza.
    assert.doesNotThrow(() => presence.clearPresence({ pipelineRoot: root }));
    // Tras clear, readPresence devuelve null.
    assert.equal(presence.readPresence({ pipelineRoot: root }), null);
});

test('CA-8 / SEC-4: readPresence ignora presencia stale (sobre TTL)', () => {
    const root = mkTmpRoot();
    presence.writePresence({ petitionId: 'p1', fase: 'pensando' }, { pipelineRoot: root, now: () => 0 });
    // Justo en el borde del TTL → stale (>=).
    assert.equal(presence.readPresence({ pipelineRoot: root, ttlMs: 1000, now: () => 1000 }), null);
    // Más viejo aún → stale.
    assert.equal(presence.readPresence({ pipelineRoot: root, ttlMs: 1000, now: () => 5000 }), null);
    // Dentro del TTL → fresco.
    assert.ok(presence.readPresence({ pipelineRoot: root, ttlMs: 1000, now: () => 999 }));
});

test('SEC-4: readPresence tolera archivo corrupto, ausente y fase inválida', () => {
    const root = mkTmpRoot();
    // Ausente.
    assert.equal(presence.readPresence({ pipelineRoot: root }), null);
    // Corrupto.
    fs.writeFileSync(presence.presencePath(root), '{ not valid json');
    assert.equal(presence.readPresence({ pipelineRoot: root }), null);
    // Fase fuera del enum (manipulado a mano) → ignorado.
    fs.writeFileSync(presence.presencePath(root), JSON.stringify({ petitionId: 'p1', fase: 'hackeando', startedAt: Date.now() }));
    assert.equal(presence.readPresence({ pipelineRoot: root }), null);
    // startedAt ausente → ignorado.
    fs.writeFileSync(presence.presencePath(root), JSON.stringify({ petitionId: 'p1', fase: 'pensando' }));
    assert.equal(presence.readPresence({ pipelineRoot: root }), null);
});

test('CA-9 / SEC-5: escritura atómica — no deja archivos temporales', () => {
    const root = mkTmpRoot();
    presence.writePresence({ petitionId: 'p1', fase: 'pensando' }, { pipelineRoot: root });
    presence.updatePhase('enviando', { pipelineRoot: root });
    const leftovers = fs.readdirSync(root).filter(f => f.includes('.tmp'));
    assert.deepEqual(leftovers, []);
    // El único archivo es el de presencia, con JSON válido y completo.
    const parsed = JSON.parse(fs.readFileSync(presence.presencePath(root), 'utf8'));
    assert.equal(parsed.fase, 'enviando');
});

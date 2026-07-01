// =============================================================================
// Tests `sherlock-presence` — #4332
//
// Cubre los criterios verificables del helper de presencia observacional del
// Sherlock (validación del Commander). Port de los casos de `commander-presence`:
//   - CA-1: write → readPresence → clear (idempotente)
//   - CA-6 / SEC-4: enum cerrado de fase de UN valor (rechazo fuera del set)
//   - CA-6 / SEC-1: NO persiste campos PII (texto, chat_id, from, tokens, veredicto)
//   - CA-4 / SEC-4: TTL — presencia stale se ignora en lectura
//   - CA-6 / SEC-5: escritura atómica (sin temp leftover; nunca JSON parcial)
//
// Todo se aísla en un tmp dir vía `pipelineRoot` — jamás toca el
// `sherlock-presence.json` real del repo.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const presence = require('../sherlock-presence');

function mkTmpRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'sherlock-presence-'));
}

test('writePresence persiste petitionId/fase/startedAt y readPresence lo recupera', () => {
    const root = mkTmpRoot();
    const rec = presence.writePresence({ petitionId: 'abc123', fase: 'verificando' }, { pipelineRoot: root, now: () => 1000 });
    assert.equal(rec.petitionId, 'abc123');
    assert.equal(rec.fase, 'verificando');
    assert.equal(rec.startedAt, 1000);

    const read = presence.readPresence({ pipelineRoot: root, now: () => 1500 });
    assert.ok(read);
    assert.equal(read.petitionId, 'abc123');
    assert.equal(read.fase, 'verificando');
    assert.equal(read.durationMs, 500);
});

test('CA-6/SEC-4: enum cerrado de un valor — solo acepta "verificando"', () => {
    const root = mkTmpRoot();
    // El único valor válido es 'verificando'.
    assert.deepEqual(presence.PHASES, ['verificando']);
    assert.equal(presence.isValidPhase('verificando'), true);
    // Fases del Commander NO son válidas para el Sherlock (enum separado).
    assert.equal(presence.isValidPhase('pensando'), false);
    assert.equal(presence.isValidPhase('enviando'), false);
    assert.throws(() => presence.writePresence({ petitionId: 'x', fase: 'pensando' }, { pipelineRoot: root }), /fase inválida/);
    assert.throws(() => presence.writePresence({ petitionId: 'x', fase: '' }, { pipelineRoot: root }), /fase inválida/);
    // El archivo no debe haberse creado tras el rechazo.
    assert.equal(fs.existsSync(presence.presencePath(root)), false);
});

test('writePresence exige petitionId opaco (string no vacío)', () => {
    const root = mkTmpRoot();
    assert.throws(() => presence.writePresence({ fase: 'verificando' }, { pipelineRoot: root }), /petitionId/);
    assert.throws(() => presence.writePresence({ petitionId: '', fase: 'verificando' }, { pipelineRoot: root }), /petitionId/);
});

test('CA-6 / SEC-1: NO persiste campos PII aunque el caller los pase', () => {
    const root = mkTmpRoot();
    presence.writePresence({
        petitionId: 'opaque-id',
        fase: 'verificando',
        // Campos PII/veredicto que NO deben tocar disco:
        text: 'creá un issue para el bug de login',
        veredicto: 'rechazado por inconsistencia con el estado real',
        chat_id: 123456789,
        from: 'leito',
        username: 'leitolarreta',
        token: 'ghp_secret',
        startedAt: 42,
    }, { pipelineRoot: root });

    const onDisk = JSON.parse(fs.readFileSync(presence.presencePath(root), 'utf8'));
    assert.deepEqual(Object.keys(onDisk).sort(), ['fase', 'petitionId', 'startedAt']);
    assert.equal(onDisk.text, undefined);
    assert.equal(onDisk.veredicto, undefined);
    assert.equal(onDisk.chat_id, undefined);
    assert.equal(onDisk.from, undefined);
    // El JSON crudo no contiene ningún rastro de los valores PII.
    const rawText = fs.readFileSync(presence.presencePath(root), 'utf8');
    assert.equal(rawText.includes('login'), false);
    assert.equal(rawText.includes('leito'), false);
    assert.equal(rawText.includes('ghp_secret'), false);
    assert.equal(rawText.includes('inconsistencia'), false);
});

test('CA-1: clearPresence elimina el archivo y es idempotente', () => {
    const root = mkTmpRoot();
    presence.writePresence({ petitionId: 'p1', fase: 'verificando' }, { pipelineRoot: root });
    assert.equal(fs.existsSync(presence.presencePath(root)), true);
    presence.clearPresence({ pipelineRoot: root });
    assert.equal(fs.existsSync(presence.presencePath(root)), false);
    // Segundo clear sobre archivo ausente no lanza.
    assert.doesNotThrow(() => presence.clearPresence({ pipelineRoot: root }));
    // Tras clear, readPresence devuelve null.
    assert.equal(presence.readPresence({ pipelineRoot: root }), null);
});

test('CA-4 / SEC-4: readPresence ignora presencia stale (sobre TTL)', () => {
    const root = mkTmpRoot();
    presence.writePresence({ petitionId: 'p1', fase: 'verificando' }, { pipelineRoot: root, now: () => 0 });
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
    fs.writeFileSync(presence.presencePath(root), JSON.stringify({ petitionId: 'p1', fase: 'hackeando', startedAt: 1 }));
    assert.equal(presence.readPresence({ pipelineRoot: root }), null);
    // startedAt ausente → ignorado.
    fs.writeFileSync(presence.presencePath(root), JSON.stringify({ petitionId: 'p1', fase: 'verificando' }));
    assert.equal(presence.readPresence({ pipelineRoot: root }), null);
});

test('CA-6 / SEC-5: escritura atómica — no deja archivos temporales', () => {
    const root = mkTmpRoot();
    presence.writePresence({ petitionId: 'p1', fase: 'verificando' }, { pipelineRoot: root });
    const leftovers = fs.readdirSync(root).filter(f => f.includes('.tmp'));
    assert.deepEqual(leftovers, []);
    // El único archivo es el de presencia, con JSON válido y completo.
    const parsed = JSON.parse(fs.readFileSync(presence.presencePath(root), 'utf8'));
    assert.equal(parsed.fase, 'verificando');
    assert.equal(parsed.petitionId, 'p1');
});

test('PRESENCE_FILENAME es un canal separado del Commander', () => {
    assert.equal(presence.PRESENCE_FILENAME, 'sherlock-presence.json');
});

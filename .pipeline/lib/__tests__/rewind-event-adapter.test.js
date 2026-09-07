// =============================================================================
// rewind-event-adapter.test.js — Tests del adapter de eventos del Commander.
// =============================================================================
//
// Valida el contrato consumer/producer entre `lib/commander/rechazar-handler.js`
// (#3441, en main) y `lib/pipeline-rewind.js#rewindIssueToPhase` (#3416).
//
// La review del PR #3416 detectó cuatro mismatches que estos tests cubren:
//   1. Path: producer escribe en `.pipeline/rejections/`, consumer leía
//      `.pipeline/eventos/pipeline-rejection/pendiente/`.
//   2. `event.fase` vs `event.alias`.
//   3. `event.chat_id` vs `event.operatorId`.
//   4. `event.source` ('text'/'audio') vs whitelist
//      ('telegram-commander'/'cli-local').
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeProducerEvent } = require('../rewind-event-adapter');

test('mapea el shape del producer #3441 (text) al consumer #3416', () => {
    // Shape REAL de `rechazar-handler.js` líneas 540-549 cuando llega texto.
    const producerEvent = {
        issue: 3416,
        fase: 'ux',
        fase_resolved: 'desarrollo/aprobacion',
        motivo: 'El mockup del paso 2 no respeta el spacing.',
        ts: '2026-05-20T10:30:00.000Z',
        source: 'text',
        chat_id: 123456789,
        audit_ref: 'rejections-2026-05-20.jsonl',
    };

    const normalized = normalizeProducerEvent(producerEvent);

    assert.equal(normalized.issue, 3416);
    assert.equal(normalized.alias, 'ux', 'event.fase debe mapear a alias');
    assert.equal(normalized.motivo, 'El mockup del paso 2 no respeta el spacing.');
    assert.equal(normalized.operatorId, '123456789', 'event.chat_id debe mapear a operatorId stringificado');
    assert.equal(normalized.source, 'telegram-commander', 'source debe normalizarse a la whitelist del consumer');
    // Envelope con metadata original preservada para audit.
    assert.equal(normalized._envelope.fase_resolved, 'desarrollo/aprobacion');
    assert.equal(normalized._envelope.transcribe_source, 'text');
    assert.equal(normalized._envelope.audit_ref, 'rejections-2026-05-20.jsonl');
    assert.equal(normalized._envelope.ts, '2026-05-20T10:30:00.000Z');
    assert.equal(normalized._envelope.chat_id, '123456789');
});

test('mapea el shape del producer cuando viene de audio (whisper-local)', () => {
    // Cuando el operador manda audio, transcribeSource es 'audio'.
    const producerEvent = {
        issue: 3416,
        fase: 'criterios-po',
        fase_resolved: 'definicion/criterios',
        motivo: 'Faltan los criterios de seguridad de inputs.',
        ts: '2026-05-20T11:00:00.000Z',
        source: 'audio',
        chat_id: '987654321', // chat_id puede venir como string también
        audit_ref: 'rejections-2026-05-20.jsonl',
    };

    const normalized = normalizeProducerEvent(producerEvent);

    assert.equal(normalized.alias, 'criterios-po');
    assert.equal(normalized.operatorId, '987654321');
    // 'audio' NO está en la whitelist del consumer → debe normalizarse a 'telegram-commander'.
    assert.equal(normalized.source, 'telegram-commander');
    assert.equal(normalized._envelope.transcribe_source, 'audio');
});

test('respeta source ya válido de la whitelist (tolerancia hacia adelante)', () => {
    // Si el producer evoluciona y manda source directamente válido (ej. el
    // smoke test legacy que usa 'telegram-commander'), no lo doble-traducimos.
    const event = {
        issue: 3416,
        alias: 'validacion-ux',
        motivo: 'test',
        operatorId: 'leitolarreta',
        source: 'telegram-commander',
    };

    const normalized = normalizeProducerEvent(event);

    assert.equal(normalized.alias, 'validacion-ux');
    assert.equal(normalized.operatorId, 'leitolarreta');
    assert.equal(normalized.source, 'telegram-commander');
});

test('respeta cli-local de la whitelist', () => {
    const event = {
        issue: 3416,
        alias: 'review',
        motivo: 'desde CLI',
        operatorId: 'cli-test',
        source: 'cli-local',
    };

    const normalized = normalizeProducerEvent(event);

    assert.equal(normalized.source, 'cli-local');
});

test('si no hay chat_id ni source válido, deja source vacío (consumer rechaza)', () => {
    // Caso defensivo: evento corrupto sin identidad. NO inventamos source
    // 'telegram-commander' porque no podemos verificar de dónde vino.
    const event = {
        issue: 3416,
        fase: 'ux',
        motivo: 'sin identidad',
    };

    const normalized = normalizeProducerEvent(event);

    assert.equal(normalized.operatorId, null);
    assert.equal(normalized.source, '');
    // El consumer va a rechazar con OPERATOR_ID_REQUIRED o SOURCE_NOT_AUTHORIZED.
});

test('#4967 CA-2: DESCARTA el source desconocido cuando no hay chat_id (fail-closed)', () => {
    // Cambio de contrato explícito de #4967 (CA-2). Antes este source se
    // propagaba tal cual "para que el consumer lo bloquee"; eso convertía al
    // bus de rejections en un canal para NOMBRAR orígenes arbitrarios, incluidos
    // los internos del pipeline. Ahora se colapsa a vacío y el consumer rechaza
    // con SOURCE_NOT_AUTHORIZED igual — pero el nombre nunca sale de acá.
    const event = {
        issue: 3416,
        fase: 'ux',
        motivo: 'test',
        source: 'random-bot',
    };

    const normalized = normalizeProducerEvent(event);

    assert.equal(normalized.source, '');
    assert.equal(normalized.operatorId, null);
    // El forensics no se pierde: el valor original vive en el envelope, que
    // ningún gate de autorización lee.
    assert.equal(normalized._envelope.transcribe_source, 'random-bot');
});

test('#4967 CA-2: ningún source arbitrario atraviesa el adapter, con o sin chat_id', () => {
    const arbitrarios = [
        'mergeability-watcher', 'pulpo', 'internal', 'system',
        'TELEGRAM-COMMANDER', ' cli-local', 'cli-local ',
    ];
    for (const source of arbitrarios) {
        // Sin chat_id: se descarta.
        assert.equal(
            normalizeProducerEvent({ issue: 3416, fase: 'ux', source }).source, '',
            `"${source}" sin chat_id debe colapsar a vacío`,
        );
        // Con chat_id: es un evento del Commander de Telegram, y eso es lo que
        // se emite — nunca el nombre que trajo el archivo.
        assert.equal(
            normalizeProducerEvent({ issue: 3416, fase: 'ux', source, chat_id: 42 }).source,
            'telegram-commander',
            `"${source}" con chat_id debe normalizar a telegram-commander`,
        );
    }
});

test('#4967 CA-2: el adapter sólo puede emitir sources de la whitelist (o vacío)', () => {
    const permitidos = new Set(['telegram-commander', 'cli-local', '']);
    const eventos = [
        {}, { source: 'text' }, { source: 'audio', chat_id: 1 }, { source: 'whisper-local' },
        { source: 'telegram-commander' }, { source: 'cli-local' }, { chat_id: 7 },
        { source: 'lo-que-sea', chat_id: 7 }, { source: 'lo-que-sea' },
    ];
    for (const e of eventos) {
        assert.ok(permitidos.has(normalizeProducerEvent(e).source), JSON.stringify(e));
    }
});

test('null safety: no rompe con event nulo o vacío', () => {
    const a = normalizeProducerEvent(null);
    assert.equal(a.issue, null);
    assert.equal(a.alias, null);
    assert.equal(a.operatorId, null);

    const b = normalizeProducerEvent({});
    assert.equal(b.issue, null);
    assert.equal(b.alias, null);
});

test('stringifica chat_id numérico (Telegram envía int64)', () => {
    // Telegram chat_id puede ser un entero grande. JSON lo parsea como Number
    // pero el consumer espera String. El adapter debe stringificar.
    const event = {
        issue: 3416,
        fase: 'ux',
        motivo: 'test',
        source: 'text',
        chat_id: 1234567890123,
    };

    const normalized = normalizeProducerEvent(event);

    assert.equal(typeof normalized.operatorId, 'string');
    assert.equal(normalized.operatorId, '1234567890123');
});

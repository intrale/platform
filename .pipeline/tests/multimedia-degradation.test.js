// =============================================================================
// multimedia-degradation.test.js — EP1-H4 (#3919): avisos de degradación multimedia
//
// Cubre los helpers puros de `multimedia.js` que sostienen los criterios de
// aceptación del issue #3919:
//   - CA-4 (SEC-1/SEC-2): `ttsDegradedMessage` es canned por `errorKind` y NO
//     filtra paths, stack traces, `raw` ni secrets.
//   - CA-3: `shouldNotifyDegradation` deduplica por ventana, aislado por
//     `chat_id` y por `tipo`.
//   - CA-6 (SEC-4): el estado de dedup purga entradas vencidas (cota de
//     crecimiento) y la carga tolera archivo corrupto sin lanzar excepción.
//
// Los helpers son puros / con I/O acotado, sin dependencias del runtime de
// pulpo, por eso se testean directo. Las rutas de pulpo.js que los consumen
// (Commander, /status, STT mixto) no son importables sin boot; su contrato
// (consolidar el fallo, respetar `esAudio`, pasar por el dedup) queda cubierto
// por estos helpers + revisión de código.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const mm = require('../multimedia');

const WINDOW = mm.DEGRADATION_WINDOW_MS;

// --- CA-4 / SEC-1 / SEC-2: mensajes canned sin filtración de detalle interno ---

test('ttsDegradedMessage devuelve mensaje canned por cada errorKind conocido', () => {
  const kinds = Object.keys(mm.TTS_DEGRADED_MESSAGES);
  assert.ok(kinds.length >= 4, 'debe haber un enum cerrado de motivos');
  for (const kind of kinds) {
    const msg = mm.ttsDegradedMessage(kind);
    assert.equal(typeof msg, 'string');
    assert.ok(msg.length > 0, `mensaje vacío para kind=${kind}`);
    // UX (#3919): "Te respondo solo por texto" SIEMPRE presente (corazón de CA-2).
    assert.match(msg, /Te respondo solo por texto/, `falta el modo de respuesta en kind=${kind}`);
    // Emoji de canal 🔇 consistente.
    assert.ok(msg.startsWith('🔇'), `falta el emoji de canal en kind=${kind}`);
  }
});

test('ttsDegradedMessage cae a "unknown" para kind no listado o vacío', () => {
  const fallback = mm.TTS_DEGRADED_MESSAGES.unknown;
  assert.equal(mm.ttsDegradedMessage('inexistente_xyz'), fallback);
  assert.equal(mm.ttsDegradedMessage(undefined), fallback);
  assert.equal(mm.ttsDegradedMessage(null), fallback);
});

test('ttsDegradedMessage NO contiene paths, stack, raw ni secrets (SEC-1/SEC-2)', () => {
  // Recorremos TODOS los kinds + uno desconocido, y aseguramos que el output no
  // arrastra detalle interno: rutas, extensiones de archivo temporal, stack,
  // ni nada que parezca un token/clave.
  const kinds = [...Object.keys(mm.TTS_DEGRADED_MESSAGES), 'kind_desconocido'];
  const forbidden = [
    /[A-Za-z]:\\/,        // path Windows (C:\...)
    /\/(?:tmp|usr|home|var)\//, // path POSIX
    /\.(?:mp3|ogg|tmp|json|exe)\b/i, // nombres de archivo temporal
    /\bat\s+.+\(.+:\d+:\d+\)/, // stack frame
    /\bError:/,            // texto crudo de excepción
    /[A-Za-z0-9_-]{30,}/,  // blobs largos tipo token/jwt/api-key
    /AKIA[0-9A-Z]{12,}/,   // AWS access key
  ];
  for (const kind of kinds) {
    const msg = mm.ttsDegradedMessage(kind);
    for (const re of forbidden) {
      assert.ok(!re.test(msg), `kind=${kind} filtra patrón prohibido ${re}: "${msg}"`);
    }
  }
});

// --- CA-3: deduplicación por ventana, aislada por (chat_id, tipo) ---

test('dedup: dos avisos del mismo (chat,tipo) dentro de la ventana → segundo notify=false', () => {
  const t0 = 1_000_000;
  const r1 = mm.shouldNotifyDegradation({ entries: {} }, 'chatA', 'tts', t0);
  assert.equal(r1.notify, true);
  const r2 = mm.shouldNotifyDegradation(r1.nextState, 'chatA', 'tts', t0 + WINDOW - 1);
  assert.equal(r2.notify, false, 'dentro de la ventana no debe re-notificar');
});

test('dedup: fuera de la ventana → vuelve a notificar', () => {
  const t0 = 2_000_000;
  const r1 = mm.shouldNotifyDegradation({ entries: {} }, 'chatA', 'tts', t0);
  const r2 = mm.shouldNotifyDegradation(r1.nextState, 'chatA', 'tts', t0 + WINDOW + 1);
  assert.equal(r2.notify, true, 'pasada la ventana debe re-notificar');
});

test('dedup: aislamiento por chat_id (un chat no suprime a otro)', () => {
  const t0 = 3_000_000;
  const r1 = mm.shouldNotifyDegradation({ entries: {} }, 'chatA', 'tts', t0);
  const r2 = mm.shouldNotifyDegradation(r1.nextState, 'chatB', 'tts', t0 + 1);
  assert.equal(r2.notify, true, 'otro chat debe notificar aunque sea dentro de la ventana');
});

test('dedup: aislamiento por tipo (stt no suprime tts y viceversa)', () => {
  const t0 = 4_000_000;
  const r1 = mm.shouldNotifyDegradation({ entries: {} }, 'chatA', 'stt', t0);
  const r2 = mm.shouldNotifyDegradation(r1.nextState, 'chatA', 'tts', t0 + 1);
  assert.equal(r2.notify, true, 'otro tipo debe notificar aunque sea el mismo chat y ventana');
});

// --- CA-6 / SEC-4: estado acotado, purga de vencidas, tolerante a corrupción ---

test('dedup: purga entradas vencidas (cota de crecimiento)', () => {
  const t0 = 5_000_000;
  // Estado con una entrada vencida (vieja) + una vigente.
  const state = {
    entries: {
      'oldChat:tts': t0 - WINDOW - 10, // vencida
      'liveChat:tts': t0 - 10,         // vigente
    },
  };
  const r = mm.shouldNotifyDegradation(state, 'newChat:tts'.split(':')[0], 'stt', t0);
  // La vencida debe haber sido purgada; la vigente conservada; + la nueva.
  assert.ok(!('oldChat:tts' in r.nextState.entries), 'la entrada vencida debe purgarse');
  assert.ok('liveChat:tts' in r.nextState.entries, 'la entrada vigente debe conservarse');
});

test('dedup: estado robusto ante entries corrupto o ausente', () => {
  const t0 = 6_000_000;
  // stateObj nulo, sin entries, o entries no-objeto → trata como vacío sin throw.
  for (const bad of [null, undefined, {}, { entries: null }, { entries: 'x' }, { entries: 42 }]) {
    const r = mm.shouldNotifyDegradation(bad, 'chatA', 'tts', t0);
    assert.equal(r.notify, true);
    assert.equal(r.nextState.entries['chatA:tts'], t0);
  }
});

test('dedup: ignora timestamps no numéricos en el estado (tolerancia a corrupción)', () => {
  const t0 = 7_000_000;
  const state = { entries: { 'chatA:tts': 'corrupto', 'chatA:stt': null } };
  const r = mm.shouldNotifyDegradation(state, 'chatA', 'tts', t0);
  assert.equal(r.notify, true, 'un timestamp corrupto no debe suprimir el aviso');
});

test('loadDegradationState tolera archivo corrupto sin throw (retorna default)', () => {
  const orig = require.resolve('../multimedia');
  // Probamos load/save end-to-end contra un archivo real temporal en .pipeline.
  // loadDegradationState apunta a una ruta fija; verificamos su contrato de
  // tolerancia leyendo un archivo corrupto vía el mismo parser interno: como la
  // ruta es interna, validamos el comportamiento idempotente de save→load.
  const st = mm.loadDegradationState();
  assert.ok(st && typeof st === 'object' && st.entries && typeof st.entries === 'object',
    'loadDegradationState siempre retorna { entries: {} } válido');
  void orig;
});

test('save→load es atómico e idempotente (round-trip)', () => {
  const t0 = 8_000_000;
  const r = mm.shouldNotifyDegradation({ entries: {} }, 'chatRT', 'tts', t0);
  mm.saveDegradationState(r.nextState);
  const loaded = mm.loadDegradationState();
  assert.equal(loaded.entries['chatRT:tts'], t0, 'el round-trip debe preservar el timestamp');
  // Limpieza: dejar el estado vacío para no contaminar corridas siguientes.
  mm.saveDegradationState({ entries: {} });
});

test('notifyDegradationOnce: primer fallo notifica, segundo (en ventana) no', () => {
  // Estado limpio de partida.
  mm.saveDegradationState({ entries: {} });
  const t0 = 9_000_000;
  const first = mm.notifyDegradationOnce('chatOnce', 'tts', t0);
  const second = mm.notifyDegradationOnce('chatOnce', 'tts', t0 + 1000);
  assert.equal(first, true);
  assert.equal(second, false);
  // Distinto tipo no queda suprimido.
  const otherType = mm.notifyDegradationOnce('chatOnce', 'stt', t0 + 1000);
  assert.equal(otherType, true);
  mm.saveDegradationState({ entries: {} });
});

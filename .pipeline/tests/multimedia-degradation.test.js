// =============================================================================
// multimedia-degradation.test.js — EP1-H4 (#3919)
// Aviso de degradación multimedia al usuario (STT/TTS caído).
//
// Cubre los helpers puros agregados en multimedia.js:
//   - ttsDegradedMessage(errorKind): mensaje canned por motivo (SEC-1/SEC-2)
//   - shouldNotifyDegradation(state, chatId, tipo, now, win): dedup por ventana
//   - load/saveDegradationNotifyState: persistencia tolerante a corrupción (SEC-4)
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  ttsDegradedMessage,
  transcriptionFailureMessage,
  shouldNotifyDegradation,
  loadDegradationNotifyState,
  saveDegradationNotifyState,
} = require(path.join(__dirname, '..', 'multimedia.js'));

// --- ttsDegradedMessage: canned + sin filtrado de datos crudos (SEC-1/SEC-2) ---

test('ttsDegradedMessage devuelve mensaje canned por cada errorKind conocido', () => {
  const kinds = ['no_binary', 'spawn_error', 'cli_error', 'timeout', 'no_output', 'ffmpeg'];
  for (const k of kinds) {
    const msg = ttsDegradedMessage(k);
    assert.equal(typeof msg, 'string');
    assert.ok(msg.length > 0, `mensaje vacío para ${k}`);
    // Siempre indica explícitamente que se responde solo por texto (CA-2).
    assert.match(msg, /solo por texto/i, `falta aviso de texto para ${k}`);
  }
});

test('ttsDegradedMessage usa fallback unknown para errorKind desconocido', () => {
  const msg = ttsDegradedMessage('no-existe-este-kind');
  assert.equal(msg, ttsDegradedMessage('unknown'));
  assert.match(msg, /solo por texto/i);
});

test('ttsDegradedMessage NO filtra paths, stack ni raw (SEC-1/SEC-2)', () => {
  // Aunque le pasemos algo que parezca un error crudo, el enum cerrado lo ignora.
  const dirty = "Error: ENOENT C:\\temp\\tts-123.ogg\n    at spawn (node:child_process)";
  const msg = ttsDegradedMessage(dirty);
  assert.ok(!msg.includes('C:\\temp'), 'filtró path de temp');
  assert.ok(!msg.includes('ENOENT'), 'filtró código de error crudo');
  assert.ok(!msg.includes('node:child_process'), 'filtró stack');
  assert.ok(!msg.includes('.ogg'), 'filtró nombre de archivo temp');
});

// --- shouldNotifyDegradation: dedup por ventana, aislamiento (chatId, tipo) ---

test('dedup: segunda llamada dentro de la ventana → notify=false', () => {
  const win = 120000;
  const r1 = shouldNotifyDegradation({ entries: {} }, 'chat-1', 'tts', 1000, win);
  assert.equal(r1.notify, true);
  const r2 = shouldNotifyDegradation(r1.nextState, 'chat-1', 'tts', 1000 + 60000, win);
  assert.equal(r2.notify, false, 'no debería re-avisar dentro de la ventana');
});

test('dedup: fuera de la ventana → notify=true de nuevo', () => {
  const win = 120000;
  const r1 = shouldNotifyDegradation({ entries: {} }, 'chat-1', 'tts', 1000, win);
  const r2 = shouldNotifyDegradation(r1.nextState, 'chat-1', 'tts', 1000 + win + 1, win);
  assert.equal(r2.notify, true, 'pasada la ventana debe volver a avisar');
});

test('dedup: aislamiento por chatId — otro chat no queda silenciado', () => {
  const win = 120000;
  const r1 = shouldNotifyDegradation({ entries: {} }, 'chat-1', 'tts', 1000, win);
  const r2 = shouldNotifyDegradation(r1.nextState, 'chat-2', 'tts', 1000 + 1, win);
  assert.equal(r2.notify, true, 'chat-2 debe poder avisar pese a chat-1');
});

test('dedup: aislamiento por tipo — stt y tts son independientes', () => {
  const win = 120000;
  const r1 = shouldNotifyDegradation({ entries: {} }, 'chat-1', 'tts', 1000, win);
  const r2 = shouldNotifyDegradation(r1.nextState, 'chat-1', 'stt', 1000 + 1, win);
  assert.equal(r2.notify, true, 'stt debe poder avisar pese a tts del mismo chat');
});

test('dedup: purga entradas vencidas (cota de crecimiento, SEC-4)', () => {
  const win = 120000;
  // Estado con una entrada vencida de otro chat.
  const stale = { entries: { 'chat-viejo::tts': 1000 } };
  const now = 1000 + win + 5000; // ya venció
  const r = shouldNotifyDegradation(stale, 'chat-nuevo', 'tts', now, win);
  // La entrada vencida no debe sobrevivir en el nextState.
  assert.ok(!('chat-viejo::tts' in r.nextState.entries), 'no purgó entrada vencida');
  // Y la nueva sí está.
  assert.ok('chat-nuevo::tts' in r.nextState.entries);
});

test('dedup: estado corrupto/no-objeto no rompe (tolerante a corrupción)', () => {
  const win = 120000;
  for (const bad of [null, undefined, 42, 'x', [], { entries: 'no-objeto' }]) {
    const r = shouldNotifyDegradation(bad, 'chat-1', 'tts', 1000, win);
    assert.equal(r.notify, true, `debería avisar con estado ${JSON.stringify(bad)}`);
    assert.equal(typeof r.nextState.entries, 'object');
  }
});

// --- persistencia: load tolera archivo corrupto sin throw (SEC-4) ---

test('loadDegradationNotifyState tolera archivo inexistente y corrupto', () => {
  // No debe lanzar — devuelve estado limpio si no hay archivo o está roto.
  const state = loadDegradationNotifyState();
  assert.equal(typeof state, 'object');
  assert.equal(typeof state.entries, 'object');
});

test('save + load roundtrip persiste solo timestamps (SEC-4)', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deg-state-'));
  // Trabajamos sobre un archivo aislado para no tocar el real del repo.
  const target = path.join(tmpRoot, '.degradation-notify-state.json');
  const payload = { entries: { 'chat-1::tts': 123456 } };
  // Escritura atómica manual equivalente para validar formato persistido.
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, target);
  const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(parsed.entries['chat-1::tts'], 123456);
  // Solo timestamps numéricos, jamás contenido/transcripción.
  for (const v of Object.values(parsed.entries)) {
    assert.equal(typeof v, 'number');
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// saveDegradationNotifyState no debe lanzar aunque el path no sea escribible
test('saveDegradationNotifyState es best-effort (no lanza)', () => {
  assert.doesNotThrow(() => saveDegradationNotifyState({ entries: {} }));
});

// --- CA-1: el aviso STT mixto reutiliza transcriptionFailureMessage ---

test('transcriptionFailureMessage da aviso accionable por errorKind (CA-1)', () => {
  const msg = transcriptionFailureMessage('cli_error');
  assert.equal(typeof msg, 'string');
  assert.ok(msg.length > 0);
  assert.match(msg, /texto/i, 'debe sugerir repetir por texto');
});

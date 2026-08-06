// =============================================================================
// Tests de la señal "EN VUELO" del sweep de audio (#5573)
//
// BUG QUE CUBREN
//
// El sweep de chunks de voz (#4750) sólo miraba el reloj: "hace más de
// `backoff` que encolé esta parte y no confirmó ⇒ se perdió, la reenvío". Con la
// política de TEXTO (base 5s → 5/10/20s) contra la latencia real de entrega de un
// `.ogg` (~62-74s medidos en producción), el sweep disparaba reenvíos mientras el
// envío ORIGINAL seguía en la cola de `svc-telegram`. El operador recibía el
// mismo audio 2-4 veces, y cada reenvío alargaba la cola de las partes que
// faltaban (bola de nieve).
//
// El fix agrega una señal empírica: `scanInFlightParts` mira qué dropfiles de
// audio siguen vivos en `pendiente/` ∪ `trabajando/` y `planSweep` no reencola
// esas partes. Estos tests cubren el lado con I/O (el lado puro de `planSweep`
// vive en `reconcile-voice-chunks.test.js`).
//
// Sin red, sin credenciales: `fs` temporal con `mkdtempSync`.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const vp = require('../voice-parts');

function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'voice-inflight-'));
}

function queueDir(root, sub) {
  const d = path.join(root, 'servicios', 'telegram', sub);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// Escribe un dropfile de voz con el nombre REAL que produce `enqueueTelegramVoice`
// (`<epochMs>-voice-<correlationId>-p<idx>.json`): el nombre es lo único que
// `scanInFlightParts` lee, para no parsear N JSON por tick.
function dropVoice(dir, correlationId, partIndex, ts = 1700000000000) {
  const name = `${ts}-voice-${correlationId}-p${partIndex}.json`;
  fs.writeFileSync(path.join(dir, name), JSON.stringify({
    voice: '/tmp/tts.ogg',
    _correlationId: correlationId,
    _partIndex: partIndex,
    _partTotal: 2,
  }));
  return name;
}

const CID = 'voice-1785927634994-c0d2aa07'; // formato real de generateCorrelationId('voice')

// -----------------------------------------------------------------------------
// scanInFlightParts
// -----------------------------------------------------------------------------
test('#5573 scanInFlightParts detecta dropfiles en pendiente y en trabajando', () => {
  const root = sandbox();
  dropVoice(queueDir(root, 'pendiente'), CID, 0);
  dropVoice(queueDir(root, 'trabajando'), CID, 1); // ya tomado por el consumidor

  const map = vp.scanInFlightParts({ pipelineDir: root });
  assert.ok(map.has(CID), 'el correlationId aparece en el mapa');
  assert.deepEqual([...map.get(CID)].sort(), [0, 1],
    'ambas colas cuentan como "en vuelo": el job existe, no se perdió');
});

test('#5573 CA-3 scanInFlightParts IGNORA fallido/ (es pérdida real, debe reenviarse)', () => {
  const root = sandbox();
  queueDir(root, 'pendiente');
  queueDir(root, 'trabajando');
  dropVoice(queueDir(root, 'fallido'), CID, 0);

  const map = vp.scanInFlightParts({ pipelineDir: root });
  assert.equal(map.size, 0,
    'fallido/ es terminal hasta el barredor de boot: NO suprime el reenvío');
});

test('#5573 R3/SEC-B scanInFlightParts ignora un dropfile con correlationId invalido', () => {
  const root = sandbox();
  const pend = queueDir(root, 'pendiente');
  // `pendiente/` es un bus con muchos escritores: un dropfile forjado no puede
  // suprimir la entrega de una respuesta en vuelo. El nombre nunca es fuente de
  // verdad — se valida con la misma regex del bus de recibos.
  fs.writeFileSync(path.join(pend, '1700000000000-voice-../../etc-p0.json'.replace(/\//g, '_')), '{}');
  fs.writeFileSync(path.join(pend, '1700000000000-voice-ab-p0.json'), '{}');        // cid corto (<6)
  fs.writeFileSync(path.join(pend, '1700000000000-voice-con espacio!-p0.json'), '{}'); // chars fuera de la regex
  dropVoice(pend, CID, 0); // este sí es válido

  const map = vp.scanInFlightParts({ pipelineDir: root });
  assert.deepEqual([...map.keys()], [CID], 'sólo entra el correlationId válido');
  assert.deepEqual([...map.get(CID)], [0]);
});

test('#5573 scanInFlightParts ignora dropfiles de texto y de formato legacy', () => {
  const root = sandbox();
  const pend = queueDir(root, 'pendiente');
  fs.writeFileSync(path.join(pend, '1700000000000-cmd.json'), '{}');       // texto
  fs.writeFileSync(path.join(pend, '1700000000000-voice-p0.json'), '{}');  // legacy pre-#5573, sin cid

  const map = vp.scanInFlightParts({ pipelineDir: root });
  assert.equal(map.size, 0,
    'un dropfile que no matchea degrada al comportamiento previo (a lo sumo un duplicado), nunca a supresión');
});

test('#5573 R2/SEC-C scanInFlightParts devuelve vacio si el directorio no existe', () => {
  const root = sandbox(); // sin servicios/telegram/
  const map = vp.scanInFlightParts({ pipelineDir: root });
  assert.equal(map.size, 0,
    'un error de I/O NO cuenta como "en vuelo": fail-open a la entrega, nunca hueco silencioso');
});

test('#5573 R4 scanInFlightParts ve el job aunque se mueva de cola durante el escaneo', () => {
  const root = sandbox();
  const pend = queueDir(root, 'pendiente');
  const trab = queueDir(root, 'trabajando');
  const name = dropVoice(pend, CID, 0);

  // Simula el race real: el consumidor mueve pendiente/ → trabajando/ justo entre
  // la 1ra y la 2da lectura. El escaneo hace la unión de TRES lecturas
  // (pendiente → trabajando → pendiente), así que el archivo cae en al menos una.
  const realReaddir = fs.readdirSync;
  let calls = 0;
  fs.readdirSync = function patched(dir, ...rest) {
    calls += 1;
    if (calls === 1) {
      // 1ra lectura (pendiente): el archivo todavía no se movió → devuelve vacío
      // como si el move hubiese ocurrido un instante antes.
      try { fs.renameSync(path.join(pend, name), path.join(trab, name)); } catch { /* ya movido */ }
      return [];
    }
    return realReaddir.call(fs, dir, ...rest);
  };
  let map;
  try {
    map = vp.scanInFlightParts({ pipelineDir: root });
  } finally {
    fs.readdirSync = realReaddir;
  }
  assert.ok(map.has(CID), 'la 2da lectura (trabajando) lo encuentra: no hay falso "perdido"');
  assert.deepEqual([...map.get(CID)], [0]);
});

// -----------------------------------------------------------------------------
// sweepVoiceStates — integración: estado en disco + cola real + enqueue inyectado
// -----------------------------------------------------------------------------
const VOICE_CFG = {
  max_retries: 3,
  backoff_base_ms: 150000,
  backoff_max_ms: 900000,
  stale_ttl_ms: 86400000,
  in_flight_max_ms: 600000,
};

test('#5573 CA-2 sweepVoiceStates NO reencola cuando la parte sigue en la cola', () => {
  const root = sandbox();
  const T0 = 1700000000000;
  vp.initState({
    pipelineDir: root, correlationId: CID, partTotal: 2, chatId: 42,
    parts: [{ partIndex: 0, path: '/a.ogg' }, { partIndex: 1, path: '/b.ogg' }],
    now: T0,
  });
  // Las 2 partes siguen vivas en la cola.
  const pend = queueDir(root, 'pendiente');
  dropVoice(pend, CID, 0);
  dropVoice(pend, CID, 1);

  const resends = [];
  // `now` muy pasado el backoff de voz: sin la señal de en-vuelo esto reenviaría.
  const res = vp.sweepVoiceStates({
    pipelineDir: root, now: T0 + 300000, config: VOICE_CFG,
    enqueue: (a) => resends.push(a), notify: () => {},
  });

  assert.equal(resends.length, 0, 'ninguna parte en vuelo se reencola');
  assert.equal(res.resent, 0);
  assert.equal(res.closed, 0, 'el estado sigue abierto esperando confirmación');

  const st = vp.readState(vp.voicePartsDir(root), CID);
  assert.equal(st.parts['0'].retries, 0, 'no ensucia retries');
  assert.equal(st.parts['1'].retries, 0);
});

test('#5573 CA-3 sweepVoiceStates SI reencola cuando el dropfile ya no esta en la cola', () => {
  const root = sandbox();
  const T0 = 1700000000000;
  vp.initState({
    pipelineDir: root, correlationId: CID, partTotal: 2, chatId: 42,
    parts: [{ partIndex: 0, path: '/a.ogg' }, { partIndex: 1, path: '/b.ogg' }],
    now: T0,
  });
  const pend = queueDir(root, 'pendiente');
  queueDir(root, 'trabajando');
  dropVoice(pend, CID, 0); // sólo la parte 0 sigue viva; la 1 desapareció sin recibo

  const resends = [];
  vp.sweepVoiceStates({
    pipelineDir: root, now: T0 + VOICE_CFG.backoff_base_ms + 1, config: VOICE_CFG,
    enqueue: (a) => resends.push(a), notify: () => {},
  });

  assert.equal(resends.length, 1, 'la pérdida real se reenvía (garantía de #4750 intacta)');
  assert.equal(resends[0].partIndex, 1);
  assert.equal(resends[0].correlationId, CID);
});

test('#5573 sweepVoiceStates: la supresion es POR correlationId, no global', () => {
  const root = sandbox();
  const T0 = 1700000000000;
  const OTRO = 'voice-1785927600000-deadbeef';
  vp.initState({
    pipelineDir: root, correlationId: CID, partTotal: 1, chatId: 42,
    parts: [{ partIndex: 0, path: '/a.ogg' }], now: T0,
  });
  vp.initState({
    pipelineDir: root, correlationId: OTRO, partTotal: 1, chatId: 42,
    parts: [{ partIndex: 0, path: '/z.ogg' }], now: T0,
  });
  // Sólo la parte 0 de CID está en vuelo. La de OTRO se perdió.
  dropVoice(queueDir(root, 'pendiente'), CID, 0);
  queueDir(root, 'trabajando');

  const resends = [];
  vp.sweepVoiceStates({
    pipelineDir: root, now: T0 + VOICE_CFG.backoff_base_ms + 1, config: VOICE_CFG,
    enqueue: (a) => resends.push(a), notify: () => {},
  });

  assert.equal(resends.length, 1, 'un cid en vuelo no suprime el reenvío de otro');
  assert.equal(resends[0].correlationId, OTRO);
});

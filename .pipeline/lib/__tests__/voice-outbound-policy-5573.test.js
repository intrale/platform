// =============================================================================
// Tests de la política de reenvío PROPIA de voz + traza de entrega (#5573)
//
// CONTEXTO
//
// Hasta #5573 el sweep de chunks de audio reusaba `telegram_outbound` — la
// política de TEXTO (backoff base 5s). La latencia real de entrega de un `.ogg`
// es ~62-74s, así que el sweep reenviaba sobre envíos todavía en vuelo y el
// operador recibía el mismo audio 2-4 veces. Estos tests fijan que la política de
// voz existe, es independiente de la de texto, y clampea config rota.
//
// Además cubren `voice-delivery-audit.js`: la traza append-only que hace
// DETECTABLE un duplicado (el recibo `<cid>-p<idx>.json` se sobrescribe, así que
// antes los envíos intermedios eran invisibles) y que aporta la serie de latencia
// con la que se recalibra el backoff.
//
// Sin red, sin credenciales.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');

const oc = require('../telegram-outbound-config');
const audit = require('../voice-delivery-audit');

function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'voice-audit-'));
}

// -----------------------------------------------------------------------------
// CA-4: política de voz configurable y separada de la de texto
// -----------------------------------------------------------------------------
test('#5573 CA-4: resolveVoiceOutboundConfig es INDEPENDIENTE de telegram_outbound', () => {
  const cfg = {
    telegram_outbound: { max_retries: 5, backoff_base_ms: 5000, backoff_max_ms: 300000 },
    telegram_voice_outbound: { max_retries: 2, backoff_base_ms: 120000, in_flight_max_ms: 300000 },
  };
  const voz = oc.resolveVoiceOutboundConfig(cfg);
  const texto = oc.resolveOutboundConfig(cfg);

  assert.equal(voz.max_retries, 2, 'la voz lee su propia sección');
  assert.equal(voz.backoff_base_ms, 120000);
  assert.equal(voz.in_flight_max_ms, 300000);
  assert.equal(texto.max_retries, 5, 'la cola de texto NO se ve afectada');
  assert.equal(texto.backoff_base_ms, 5000);
  assert.equal(texto.in_flight_max_ms, undefined, 'in_flight_max_ms es exclusivo de voz');
});

test('#5573: tocar telegram_outbound no altera la politica de voz (y viceversa)', () => {
  const soloTexto = oc.resolveVoiceOutboundConfig({
    telegram_outbound: { max_retries: 99, backoff_base_ms: 100 },
  });
  assert.deepEqual(soloTexto, oc.VOICE_OUTBOUND_DEFAULTS,
    'sin sección de voz cae a los defaults de VOZ, nunca a los de texto');
  assert.notEqual(soloTexto.backoff_base_ms, oc.OUTBOUND_DEFAULTS.backoff_base_ms,
    'los defaults de voz y de texto son distintos a propósito (5s vs 2.5min)');
});

test('#5573: resolveVoiceOutboundConfig clampea valores invalidos al default', () => {
  const casos = [
    { telegram_voice_outbound: { max_retries: 0 } },              // fuera de rango (min 1)
    { telegram_voice_outbound: { max_retries: 'muchos' } },       // no numérico
    { telegram_voice_outbound: { backoff_base_ms: -1 } },
    { telegram_voice_outbound: { in_flight_max_ms: 1 } },         // < 60000
    { telegram_voice_outbound: { in_flight_max_ms: 99999999 } },  // > 3600000
    { telegram_voice_outbound: null },
    {},
    null,
  ];
  for (const c of casos) {
    const r = oc.resolveVoiceOutboundConfig(c);
    assert.ok(Number.isFinite(r.max_retries) && r.max_retries >= 1, `max_retries sano: ${JSON.stringify(c)}`);
    assert.ok(r.backoff_base_ms >= 1000, `backoff_base_ms sano: ${JSON.stringify(c)}`);
    assert.ok(r.in_flight_max_ms >= 60000 && r.in_flight_max_ms <= 3600000,
      `in_flight_max_ms acotado: ${JSON.stringify(c)}`);
  }
  // Config rota nunca deja el techo de supresión en un valor que produzca un
  // hueco silencioso permanente ni un reenvío inmediato.
  assert.equal(oc.resolveVoiceOutboundConfig({ telegram_voice_outbound: { in_flight_max_ms: 0 } }).in_flight_max_ms,
    oc.VOICE_OUTBOUND_DEFAULTS.in_flight_max_ms);
});

test('#5573: el config.yaml REAL trae telegram_voice_outbound con backoff > latencia de un ogg', () => {
  const raw = fs.readFileSync(path.join(__dirname, '..', '..', 'config.yaml'), 'utf8');
  const cfg = yaml.load(raw);
  assert.ok(cfg.telegram_voice_outbound, 'la sección existe en el config.yaml versionado');
  const r = oc.resolveVoiceOutboundConfig(cfg);
  // p95 observado en el incidente: ~74s. El backoff tiene que estar por encima o
  // el sweep vuelve a reenviar sobre envíos en vuelo.
  assert.ok(r.backoff_base_ms > 74000,
    `backoff_base_ms (${r.backoff_base_ms}) debe superar la latencia real de un .ogg (~74s)`);
  assert.ok(r.in_flight_max_ms >= 60000, 'el techo de supresión está configurado');
  assert.notEqual(r.backoff_base_ms, oc.resolveOutboundConfig(cfg).backoff_base_ms,
    'la política de voz NO es la de texto');
});

// -----------------------------------------------------------------------------
// Traza append-only: duplicado detectable + latencia medible
// -----------------------------------------------------------------------------
const CID = 'voice-1785927634994-c0d2aa07';

test('#5573 CA-3: dos eventos sent del mismo (cid, parte) hacen el duplicado DETECTABLE', () => {
  const root = sandbox();
  // El recibo se sobrescribe por parte; el JSONL no. Simulamos el incidente real:
  // la parte 0 se envió 4 veces (original + 3 reenvíos), la 1 y la 2 una sola vez.
  for (let attempt = 0; attempt < 4; attempt++) {
    audit.appendVoiceDeliveryEvent(root, {
      event: audit.EVENT_SENT, correlationId: CID, partIndex: 0, partTotal: 3,
      messageId: 93990 + attempt, attempt,
    });
  }
  audit.appendVoiceDeliveryEvent(root, {
    event: audit.EVENT_SENT, correlationId: CID, partIndex: 1, partTotal: 3, messageId: 93996,
  });

  const events = audit.readVoiceDeliveryEvents(root);
  assert.equal(events.length, 5, 'append-only: ninguna línea pisa a la anterior');

  const dups = audit.findDuplicateSends(events);
  assert.equal(dups.length, 1, 'sólo la parte 0 está duplicada');
  assert.deepEqual(dups[0], { correlationId: CID, partIndex: 0, sends: 4 },
    'los 4 envíos de la parte 0 quedan trazados (antes eran invisibles)');
});

test('#5573 cambio 4: los eventos confirmed dan p50/p95 de latencia real', () => {
  const root = sandbox();
  const muestras = [62000, 65000, 70000, 74000, 120000];
  muestras.forEach((latencyMs, i) => {
    audit.appendVoiceDeliveryEvent(root, {
      event: audit.EVENT_CONFIRMED, correlationId: CID, partIndex: i, partTotal: muestras.length,
      latencyMs, retries: 0,
    });
  });

  const stats = audit.computeLatencyStats(audit.readVoiceDeliveryEvents(root));
  assert.equal(stats.count, 5);
  assert.equal(stats.p50, 70000);
  assert.equal(stats.p95, 120000);
  assert.equal(stats.max, 120000);
  // Este es el dato con el que se recalibra `backoff_base_ms` (hoy provisional).
});

test('#5573 SEC-E: el evento sólo lleva IDs y timings, nunca contenido del chat', () => {
  const ev = audit.buildEvent({
    event: audit.EVENT_SENT, correlationId: CID, partIndex: 0, partTotal: 2, messageId: 1,
    // Campos que un caller descuidado podría colar: deben quedar FUERA.
    text: 'contenido secreto de la respuesta',
    voicePath: 'C:/tmp/tts.ogg',
    chatId: 12345,
  });
  assert.deepEqual(Object.keys(ev).sort(),
    ['correlationId', 'event', 'messageId', 'partIndex', 'partTotal', 'ts'],
    'whitelist estricta de campos');
  assert.equal(ev.text, undefined);
  assert.equal(ev.voicePath, undefined);
  assert.equal(ev.chatId, undefined);
});

test('#5573: buildEvent es fail-closed ante datos invalidos (no ensucia la serie)', () => {
  assert.equal(audit.buildEvent({ event: 'otro', correlationId: CID, partIndex: 0, partTotal: 1 }), null,
    'evento fuera del vocabulario');
  assert.equal(audit.buildEvent({ event: audit.EVENT_SENT, correlationId: '../etc', partIndex: 0, partTotal: 1 }), null,
    'correlationId inválido (path-traversal)');
  assert.equal(audit.buildEvent({ event: audit.EVENT_SENT, correlationId: CID, partIndex: -1, partTotal: 1 }), null,
    'partIndex negativo');
  assert.equal(audit.buildEvent({ event: audit.EVENT_SENT, correlationId: CID }), null,
    'sin dims de parte');
  // Latencia negativa (reloj corrido) se omite en vez de contaminar el p50/p95.
  const ev = audit.buildEvent({
    event: audit.EVENT_CONFIRMED, correlationId: CID, partIndex: 0, partTotal: 1, latencyMs: -5,
  });
  assert.ok(ev, 'el evento igual se emite');
  assert.equal(ev.latencyMs, undefined, 'pero sin la muestra imposible');
});

test('#5573: auditar NUNCA rompe la entrega (directorio no escribible → false, no throw)', () => {
  // pipelineDir inválido: el append falla y se traga el error.
  assert.doesNotThrow(() => {
    const ok = audit.appendVoiceDeliveryEvent('\0ruta-invalida', {
      event: audit.EVENT_SENT, correlationId: CID, partIndex: 0, partTotal: 1,
    });
    assert.equal(ok, false);
  });
  assert.deepEqual(audit.readVoiceDeliveryEvents('\0ruta-invalida'), [],
    'leer una traza inexistente devuelve vacío, no lanza');
});

test('#5573: computeLatencyStats y findDuplicateSends toleran series vacias o corruptas', () => {
  assert.deepEqual(audit.computeLatencyStats([]), { count: 0, p50: null, p95: null, max: null });
  assert.deepEqual(audit.computeLatencyStats(null), { count: 0, p50: null, p95: null, max: null });
  assert.deepEqual(audit.findDuplicateSends([null, {}, { event: 'sent' }]), []);
});

// =============================================================================
// pulpo-paginado-no-pisa-6226.test.js — #6226
//
// Regresión sobre el path REAL de encolado de salientes (`sendTelegram` de
// pulpo.js), no sobre un stand-in. Reproduce el patrón exacto del bug: el
// handler de `/wave` devuelve `{ reply, extraMessages }` y pulpo.js los encola
// en un `for` síncrono, todo dentro del MISMO tick del event loop. Antes del
// fix, ambos `writeFileSync` resolvían a `${Date.now()}-cmd.json` — el mismo
// path — y el segundo pisaba al primero: el operador recibía el mensaje 2 sin
// el 1, sin error, sin reintento y sin más rastro que dos líneas de log con el
// mismo nombre de archivo.
//
// `PIPELINE_DIR_OVERRIDE` apunta la cola a un temp dir, así que este test NO
// manda nada a Telegram: sólo observa qué dropfiles quedan escritos.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Cola aislada en temp ANTES de require('../pulpo.js').
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'pulpo-6226-'));
const QUEUE = path.join(SANDBOX, 'servicios', 'telegram', 'pendiente');
fs.mkdirSync(QUEUE, { recursive: true });
process.env.PIPELINE_DIR_OVERRIDE = SANDBOX;

// Token con formato válido para que `loadTelegramSecrets` resuelva desde env.
// NO es un secreto real — mismo patrón que cua-operator-resolve.test.js.
process.env.TELEGRAM_BOT_TOKEN = '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAA';
process.env.TELEGRAM_CHAT_ID = '99999';

process.env.PULPO_NO_AUTOSTART = '1';
const pulpo = require('../pulpo.js');

function leerCola() {
  return fs.readdirSync(QUEUE)
    .filter((f) => f.endsWith('-cmd.json'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((f) => ({ name: f, payload: JSON.parse(fs.readFileSync(path.join(QUEUE, f), 'utf8')) }));
}

test('el reply y los extraMessages del paginado quedan como dropfiles distintos', () => {
  for (const f of fs.readdirSync(QUEUE)) fs.unlinkSync(path.join(QUEUE, f));

  // Réplica literal del call site de pulpo.js (`sendTelegram(respuesta)` seguido
  // del `for (const extra of extraMessages)`), sin ceder el event loop.
  const reply = '*Estado de la ola*\n\nfilas del cuadro…';
  const extraMessages = ['_(continúa)_\n\nmás filas…', '_(continúa)_\n\n_Generado 05:43 ART_'];

  const ids = [];
  ids.push(pulpo.sendTelegram(reply, { parseMode: 'MarkdownV2' }));
  for (const extra of extraMessages) {
    ids.push(pulpo.sendTelegram(extra, { parseMode: 'MarkdownV2' }));
  }

  assert.ok(ids.every((id) => typeof id === 'string' && id.length > 0), 'todos deben devolver correlationId');
  assert.equal(new Set(ids).size, 3, 'los correlationId deben ser distintos');

  const cola = leerCola();
  assert.equal(cola.length, 3, `deben quedar 3 dropfiles, quedaron ${cola.length}`);

  // Los 3 contenidos, íntegros y en orden de emisión (= orden de nombre).
  assert.deepEqual(cola.map((c) => c.payload.text), [reply, ...extraMessages]);

  // El header va primero y el pie al final: si el orden se invirtiera, el
  // operador leería un `_(continúa)_` huérfano antes del encabezado.
  assert.match(cola[0].payload.text, /^\*Estado de la ola\*/);
  assert.match(cola[2].payload.text, /Generado 05:43 ART/);

  // Nombres únicos y con el formato invariante `<ts>-<seq>-cmd.json`.
  assert.equal(new Set(cola.map((c) => c.name)).size, 3, 'ningún nombre se repite');
  for (const c of cola) assert.match(c.name, /^\d+-\d{4}-cmd\.json$/);
});

test('una ráfaga de N salientes en el mismo tick no pierde ninguno', () => {
  for (const f of fs.readdirSync(QUEUE)) fs.unlinkSync(path.join(QUEUE, f));

  const N = 40;
  const textos = Array.from({ length: N }, (_, i) => `mensaje-${i}-${'x'.repeat(i)}`);
  for (const t of textos) pulpo.sendTelegram(t);

  const cola = leerCola();
  assert.equal(cola.length, N, `deben quedar ${N} dropfiles, quedaron ${cola.length}`);
  assert.deepEqual(cola.map((c) => c.payload.text), textos, 'los N contenidos, íntegros y en orden');
});

test('un dropfile preexistente con el mismo nombre no se sobreescribe', () => {
  for (const f of fs.readdirSync(QUEUE)) fs.unlinkSync(path.join(QUEUE, f));

  // Ocupa por adelantado el nombre que le tocaría al próximo saliente de este
  // milisegundo, simulando a otro proceso productor.
  //
  // Best-effort: acá no se puede congelar el reloj de pulpo.js, así que el
  // milisegundo puede avanzar entre este write y el `sendTelegram` de abajo y la
  // colisión no llegar a dispararse. Lo que el test fija en ambos casos es lo
  // que importa — que NADA se pierda. La rama de colisión propiamente dicha se
  // cubre de forma determinística (reloj congelado) en dropfile-unique-6226.test.js.
  const ahora = Date.now();
  const ocupado = path.join(QUEUE, `${ahora}-0000-cmd.json`);
  fs.writeFileSync(ocupado, JSON.stringify({ text: 'DE-OTRO-PROCESO' }));

  pulpo.sendTelegram('MENSAJE-NUEVO');

  assert.equal(
    JSON.parse(fs.readFileSync(ocupado, 'utf8')).text,
    'DE-OTRO-PROCESO',
    'el dropfile preexistente debe quedar intacto'
  );
  const textos = leerCola().map((c) => c.payload.text);
  assert.ok(textos.includes('DE-OTRO-PROCESO'), 'el preexistente sigue en la cola');
  assert.ok(textos.includes('MENSAJE-NUEVO'), 'el nuevo también se encoló');
});

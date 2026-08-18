// =============================================================================
// Guarda de coherencia: la suite NO puede escribir en la cola real de Telegram
// Issue #5924 — CA-7
//
// Por qué existe
// --------------
// `servicio-telegram.js` resuelve DOS colas distintas a partir de DOS env vars
// distintas, y eso es exactamente lo que se escapó:
//
//   - `PIPELINE_STATE_DIR`  → la cola de TRABAJO del servicio (pendiente/,
//                             trabajando/, fallido/, listo/, recibos/)
//   - `PIPELINE_DIR_OVERRIDE` → la cola donde `notify-telegram` deposita la
//                             ALERTA de fallo
//
// `servicio-telegram-voice.test.js` seteaba sólo la primera. Resultado
// verificado el 13/08/2026: cada corrida de la suite dejaba un
// `alert-svc-telegram-*.json` en la cola REAL del repo, que después el servicio
// intentaba enviar como si fuera un aviso legítimo. Un test contaminando la cola
// de producción es exactamente el modo de falla que el CA-7 cierra.
//
// Este test es ESTÁTICO a propósito: no ejecuta las otras suites (eso sería
// frágil y lento), sino que verifica la precondición que las hace seguras.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TESTS_DIR = __dirname;
const PIPELINE_DIR = path.resolve(__dirname, '..', '..');
const REAL_QUEUE = path.join(PIPELINE_DIR, 'servicios', 'telegram');
const OPERATIONAL_DROPFILE = /^\d+-provider-quota-guard\.json$/;

// Llamadas que TERMINAN depositando un dropfile en la cola de Telegram. Requerir
// el módulo no basta para contaminar (media suite lo requiere sólo por funciones
// puras como `normalizeThreadId`): lo que contamina es invocar una de éstas.
const EMISORES = /\b(notifyTelegram|notifyTelegramFailure|handleSendFailure|flushAlertBuffer)\s*\(/;

test('CA-7: todo test que puede emitir a Telegram aísla la cola de alertas', () => {
  const archivos = fs.readdirSync(TESTS_DIR).filter((f) => f.endsWith('.test.js'));
  const ofensores = [];

  for (const nombre of archivos) {
    if (nombre === path.basename(__filename)) continue;
    const src = fs.readFileSync(path.join(TESTS_DIR, nombre), 'utf8');
    const cargaTelegram = /require\(['"][^'"]*(servicio-telegram|notify-telegram)['"]\)/.test(src);
    if (!cargaTelegram || !EMISORES.test(src)) continue;

    // Alcanza con que el archivo aísle la cola de alertas de ALGUNA forma
    // (asignación directa al env o helper con scope tipo `withEnv`). Lo que no
    // se acepta es que ni la mencione: ahí la cola resuelve a la real.
    if (!src.includes('PIPELINE_DIR_OVERRIDE')) {
      ofensores.push(`${nombre}: emite a Telegram sin aislar PIPELINE_DIR_OVERRIDE`);
    }
  }

  assert.deepEqual(
    ofensores, [],
    'estos tests pueden escribir en la cola real de Telegram:\n' + ofensores.join('\n'),
  );
});

test('CA-7: la cola real no tiene dropfiles dejados por la suite', () => {
  // Chequeo EMPÍRICO, complementario al estático: el estático sólo cubre los
  // emisores conocidos de `servicio-telegram`/`notify-telegram`, pero también
  // encola `pulpo.js` (dropfiles `*-cmd.json` y `*-voice-*.json`). Acá se mira
  // el resultado, no el productor, así que cubre a cualquiera.
  //
  // Nota: este test es sensible al ORDEN dentro de la corrida (si corre antes
  // que el contaminante, no lo ve). Por eso el chequeo definitivo del CA-7 es
  // contar la cola antes y después de la suite completa; esto es la red que
  // atrapa la regresión en el caso común.
  for (const sub of ['pendiente', 'trabajando', 'fallido']) {
    const dir = path.join(REAL_QUEUE, sub);
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    // El pipeline sigue activo durante la suite y puede encolar una alerta real
    // del guard de cuota. Ese productor operativo no es contaminación de tests;
    // cualquier otro dropfile continúa haciendo fallar esta guarda.
    const dropfiles = entries.filter(
      (f) => f.endsWith('.json') && !OPERATIONAL_DROPFILE.test(f),
    );
    assert.deepEqual(
      dropfiles, [],
      `la suite dejó dropfiles en la cola real ${dir}: ${dropfiles.join(', ')}`,
    );
  }
});

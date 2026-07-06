// =============================================================================
// freeze-watchdog-logserve-4521.test.js — el servido de logs queda NOMBRADO
// en un freeze (#4521).
//
// Contexto: el freeze-watchdog captura el bitmask de operaciones en vuelo en
// cada latido (200ms). Una lectura de disco sincrónica que se clava arranca y
// congela el loop dentro del MISMO tick, sin latido intermedio → el freeze se
// reportaba como "ninguno-inflight (operacion sync NO rastreada)". El fix expone
// publishInflight(): publica el bitmask al SAB en el acto, de modo que un
// handler que marca su flag justo antes de la operación pesada queda nombrado
// aunque congele el loop a continuación.
//
// Cubre:
//   1. El bit logServe existe y es distinto del resto (contrato main↔worker).
//   2. Un freeze con logServe publicado sincrónicamente se registra NOMBRADO
//      como "logServe" (no "ninguno-inflight").
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { startFreezeWatchdog, INFLIGHT_BITS } = require('../lib/freeze-watchdog.js');

test('1 · logServe es un bit propio del bitmask inflight', () => {
  assert.equal(INFLIGHT_BITS.logServe, 32, 'bit esperado 32 (sync con el worker)');
  const bits = Object.values(INFLIGHT_BITS);
  assert.equal(new Set(bits).size, bits.length, 'todos los bits son distintos');
});

// Bloqueo sincrónico del event loop (busy-wait): simula la lectura de disco que
// clava el loop. No usa setTimeout porque eso cedería el loop.
function freezeLoopFor(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* spin: mantiene el loop clavado */ }
}

test('2 · un freeze con logServe publicado queda nombrado (no "ninguno-inflight")', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-logserve-'));
  const logFile = path.join(dir, 'freeze-watchdog.log');
  let logServe = false;
  const wd = startFreezeWatchdog({
    logDir: dir,
    thresholdMs: 300,
    bumpMs: 50,
    getInflight: () => ({ logServe }),
  });
  try {
    // Dejar que el worker tome un baseline con logServe=false.
    await new Promise(r => setTimeout(r, 150));

    // Handler entra: marca el flag y lo PUBLICA sincrónicamente al SAB, luego
    // "lee un log grande" que clava el loop por encima del umbral.
    logServe = true;
    wd.publishInflight();
    freezeLoopFor(700);

    // Ceder el loop para que el worker cierre el ciclo y escriba el evento.
    await new Promise(r => setTimeout(r, 400));

    const content = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    assert.match(content, /FREEZE DETECTADO/, 'el worker detectó el freeze');
    assert.match(content, /logServe/, 'el freeze quedó NOMBRADO como logServe');
    assert.doesNotMatch(content, /operacion en vuelo al congelarse: ninguno-inflight/,
      'no debe reportarse como "ninguno-inflight" habiendo publicado el flag');
  } finally {
    wd.stop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

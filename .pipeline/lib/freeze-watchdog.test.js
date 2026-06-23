'use strict';

// Tests del watchdog externo de freeze (#4131-followup-2). Verifican lo que el
// monitor previo NO podía: que un freeze TOTAL del event loop (busy-loop sync
// que nunca cede) sea detectado igual, porque el testigo vive en otro thread.
// Son tests de integración reales: levantan el Worker y congelan el loop a
// propósito. Aislados del dashboard: usan un logDir temporal.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { startFreezeWatchdog, INFLIGHT_BITS } = require('./freeze-watchdog');

function tmpLogDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wd-test-'));
}

// Congela el event loop del thread principal por `ms` con un busy-loop sync:
// reproduce el cuelgue real (proceso vivo, loop clavado, no cede a timers).
function freezeSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* quema CPU, no cede el loop */ }
}

test('detecta un freeze TOTAL del event loop y nombra la operación en vuelo', async () => {
  const logDir = tmpLogDir();
  const events = [];
  const wd = startFreezeWatchdog({
    logDir,
    thresholdMs: 800,
    bumpMs: 80,
    getInflight: () => ({ prInfo: true }), // simula prInfo inflight al congelarse
    onLog: (line) => events.push(line),
  });

  // Dejamos latir normal y luego clavamos el loop 2s (> umbral).
  await new Promise((r) => setTimeout(r, 400));
  freezeSync(2000);
  // Tras liberar, damos tiempo a que el worker registre DETECTADO y FIN.
  await new Promise((r) => setTimeout(r, 1200));
  wd.stop();

  const detectado = events.find((l) => l.includes('FREEZE DETECTADO'));
  const fin = events.find((l) => l.includes('FREEZE FIN'));
  assert.ok(detectado, 'debe registrar FREEZE DETECTADO durante el freeze total');
  assert.ok(detectado.includes('prInfo'), 'debe nombrar la operación en vuelo (prInfo)');
  assert.ok(fin, 'debe registrar FREEZE FIN al recuperarse el loop');

  // La evidencia también queda persistida en disco, independiente del main.
  const logTxt = fs.readFileSync(path.join(logDir, 'freeze-watchdog.log'), 'utf8');
  assert.ok(logTxt.includes('FREEZE DETECTADO'), 'el log en disco debe contener el evento');
});

test('no reporta freeze cuando el loop late normal', async () => {
  const logDir = tmpLogDir();
  const events = [];
  const wd = startFreezeWatchdog({
    logDir,
    thresholdMs: 800,
    bumpMs: 80,
    getInflight: () => ({}),
    onLog: (line) => events.push(line),
  });

  // Loop sano por más de un umbral: cero detecciones.
  await new Promise((r) => setTimeout(r, 1500));
  wd.stop();

  assert.strictEqual(events.length, 0, 'sin freeze no debe haber eventos');
  assert.ok(!fs.existsSync(path.join(logDir, 'freeze-watchdog.log')), 'no debe crear el log sin freezes');
});

test('logDir es obligatorio', () => {
  assert.throws(() => startFreezeWatchdog({}), /logDir es obligatorio/);
});

test('INFLIGHT_BITS expone los bits esperados y son potencias de 2 únicas', () => {
  const bits = Object.values(INFLIGHT_BITS);
  const expected = ['stateSnapshot', 'procStatus', 'prInfo', 'olaETA', 'titleRefresh'];
  assert.deepStrictEqual(Object.keys(INFLIGHT_BITS), expected);
  // Únicos y potencias de 2 (para combinarse como bitmask sin colisión).
  assert.strictEqual(new Set(bits).size, bits.length);
  for (const b of bits) assert.strictEqual(b & (b - 1), 0, `${b} debe ser potencia de 2`);
});

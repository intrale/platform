// =============================================================================
// Tests waitForPortFree / commandLineForPid — #4308
//
// El /restart no liberaba el puerto 3200 del dashboard → EADDRINUSE → rollback
// espurio. El fix agrega una verificación ACOTADA de puerto libre entre
// killAll() y launchAll(). Estos tests cubren CA-7 mockeando findPidByPort:
//
//   1. puerto libre a la primera          → true, onHolder NO se invoca
//   2. puerto se libera tras N vueltas     → true, onHolder se invoca N veces
//   3. puerto nunca se libera              → false tras EXACTAMENTE attempts
//                                            vueltas (acota, sin loop infinito)
//   4. holder con commandLine ajena        → el onHolder con validación de
//                                            ownership NO mata + loguea PID+cmd
//
// Estrategia: mock de `findPidByPort` (resuelto vía module.exports dentro de
// waitForPortFree) + delayMs: 0 para no spawnear procesos de sleep.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const pid = require('../../pid-discovery');

// Sustituye pid.findPidByPort por una secuencia de retornos y ejecuta `fn`,
// restaurando siempre el original. waitForPortFree resuelve findPidByPort vía
// module.exports, por lo que esta sustitución impacta sus llamadas internas.
function withFindPidByPortSequence(sequence, fn) {
  const original = pid.findPidByPort;
  let i = 0;
  const calls = [];
  pid.findPidByPort = (port) => {
    calls.push(port);
    const v = i < sequence.length ? sequence[i] : sequence[sequence.length - 1];
    i++;
    return v;
  };
  try {
    return fn(calls);
  } finally {
    pid.findPidByPort = original;
  }
}

test('`waitForPortFree` retorna true a la primera cuando el puerto está libre y no invoca onHolder', () => {
  const holders = [];
  withFindPidByPortSequence([null], (calls) => {
    const res = pid.waitForPortFree(3200, {
      attempts: 6,
      delayMs: 0,
      onHolder: (p) => holders.push(p),
    });
    assert.equal(res, true);
    assert.equal(calls.length, 1, 'consulta el puerto una sola vez');
  });
  assert.deepEqual(holders, [], 'onHolder no se invoca si el puerto ya está libre');
});

test('`waitForPortFree` retorna true cuando el puerto se libera tras N vueltas e invoca onHolder por cada holder', () => {
  // holder las primeras 2 vueltas, luego libre
  const holders = [];
  withFindPidByPortSequence([1111, 1111, null], () => {
    const res = pid.waitForPortFree(3200, {
      attempts: 6,
      delayMs: 0,
      onHolder: (p) => holders.push(p),
    });
    assert.equal(res, true);
  });
  assert.deepEqual(holders, [1111, 1111], 'onHolder invocado una vez por cada vuelta con holder');
});

test('`waitForPortFree` retorna false tras exactamente `attempts` vueltas cuando el puerto nunca se libera (acota, sin loop infinito)', () => {
  const holders = [];
  withFindPidByPortSequence([2222], (calls) => {
    const res = pid.waitForPortFree(3200, {
      attempts: 4,
      delayMs: 0,
      onHolder: (p) => holders.push(p),
    });
    assert.equal(res, false);
    // 4 vueltas del loop + 1 revalidación final = 5 consultas
    assert.equal(calls.length, 5, 'consulta acotada: attempts + revalidación final');
  });
  assert.equal(holders.length, 4, 'onHolder invocado exactamente attempts veces, nunca más');
});

test('un onHolder con validación de ownership NO mata un PID cuya commandLine es ajena al pipeline y loguea PID + commandLine', () => {
  // Simula el onHolder de restart.js: valida ownership por commandLine usando
  // commandLineForPid (mockeado), loguea PID + cmd ANTES de matar, y solo mata
  // procesos del pipeline (dashboard.js / .pipeline).
  const originalCmdFor = pid.commandLineForPid;
  pid.commandLineForPid = (p) => (p === 9999 ? 'C:\\\\Program Files\\\\Foo\\\\node.exe server.js' : null);

  const logs = [];
  const kills = [];
  const buildOnHolder = () => (p) => {
    const cmd = pid.commandLineForPid(p);
    const owned = !!cmd && (cmd.includes('dashboard.js') || cmd.includes('.pipeline'));
    logs.push(`holder PID ${p} cmd=${cmd || '<desconocido>'}`); // auditoría antes de matar
    if (!owned) return;
    kills.push(p);
  };

  try {
    withFindPidByPortSequence([9999], () => {
      pid.waitForPortFree(3200, { attempts: 2, delayMs: 0, onHolder: buildOnHolder() });
    });
  } finally {
    pid.commandLineForPid = originalCmdFor;
  }

  assert.deepEqual(kills, [], 'un proceso ajeno que tomó el puerto NO se mata');
  assert.ok(logs.length >= 1, 'se logueó el holder');
  assert.match(logs[0], /PID 9999/, 'el log incluye el PID');
  assert.match(logs[0], /server\.js/, 'el log incluye la commandLine');
});

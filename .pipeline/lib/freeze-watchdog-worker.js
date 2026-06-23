'use strict';

// Worker del watchdog de freeze (#4131-followup-2). Corre en su PROPIO event
// loop, totalmente independiente del loop del dashboard. Por eso puede detectar
// un freeze TOTAL del main: aunque el main esté clavado en código sync y no
// procese nada, este loop sigue girando y ve que el contador de latido dejó de
// avanzar.
//
// No depende de NADA del main más que de la SharedArrayBuffer. Escribe su
// evidencia directo a `freeze-watchdog.log` con fs sincrónico, así un freeze
// del main no le impide dejar registro.

const fs = require('fs');
const path = require('path');
const { parentPort, workerData } = require('worker_threads');

const IDX_HEARTBEAT = 0;
const IDX_INFLIGHT = 1;

// Mantener en sync con INFLIGHT_BITS de `freeze-watchdog.js`.
const INFLIGHT_NAMES = [
  [1, 'stateSnapshot'],
  [2, 'procStatus'],
  [4, 'prInfo'],
  [8, 'olaETA'],
  [16, 'titleRefresh'],
];

const { sab, thresholdMs, bumpMs, logDir } = workerData;
const view = new Int32Array(sab);
const logFile = path.join(logDir, 'freeze-watchdog.log');

// El check corre a ~1/3 del threshold (mínimo el doble del bumpMs) para
// detectar rápido sin spamear CPU.
const checkMs = Math.max(bumpMs * 2, Math.floor(thresholdMs / 3));

function decodeInflight(mask) {
  if (!mask) return 'ninguno-inflight (operacion sync NO rastreada: revisar)';
  const names = [];
  for (const [bit, name] of INFLIGHT_NAMES) {
    if (mask & bit) names.push(name);
  }
  return names.length ? names.join('+') : `mask:${mask}`;
}

function appendLog(line) {
  try { fs.appendFileSync(logFile, line + '\n'); } catch {}
  try { if (parentPort) parentPort.postMessage({ type: 'freeze', line }); } catch {}
}

let lastCount = Atomics.load(view, IDX_HEARTBEAT);
let lastChangeAt = Date.now();
let inFreeze = false;
let freezeStartAt = 0;
let freezeInflightMask = 0;

const timer = setInterval(() => {
  const now = Date.now();
  const count = Atomics.load(view, IDX_HEARTBEAT);

  if (count !== lastCount) {
    // El main late: si veníamos de un freeze, lo cerramos con la duración real.
    if (inFreeze) {
      const durMs = now - freezeStartAt;
      const ts = new Date(now).toISOString().replace('T', ' ').slice(0, 19);
      appendLog(`[${ts}] [freeze-watchdog] FREEZE FIN: el event loop se recupero tras ${durMs}ms congelado — operacion al inicio del freeze: ${decodeInflight(freezeInflightMask)}`);
      inFreeze = false;
    }
    lastCount = count;
    lastChangeAt = now;
    return;
  }

  // El contador no se movió: medimos cuánto hace que el main no late.
  const stalledFor = now - lastChangeAt;
  if (!inFreeze && stalledFor >= thresholdMs) {
    inFreeze = true;
    freezeStartAt = lastChangeAt;
    // El bitmask quedó congelado en el último latido previo al freeze: refleja
    // exactamente qué operación estaba en vuelo cuando el loop se clavó.
    freezeInflightMask = Atomics.load(view, IDX_INFLIGHT);
    const ts = new Date(now).toISOString().replace('T', ' ').slice(0, 19);
    appendLog(`[${ts}] [freeze-watchdog] FREEZE DETECTADO: el event loop del dashboard lleva ${stalledFor}ms sin latir (umbral ${thresholdMs}ms) — operacion en vuelo al congelarse: ${decodeInflight(freezeInflightMask)}`);
  }
}, checkMs);
// OJO: NO hacer unref() de este timer. Es lo único que mantiene vivo el loop
// del worker; si lo desreferenciamos, el worker sale al instante y deja de
// vigilar. El worker NO mantiene vivo al proceso principal porque el main ya lo
// desreferencia con `worker.unref()`.
void timer;

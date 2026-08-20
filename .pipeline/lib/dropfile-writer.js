'use strict';

// dropfile-writer.js — Nombres ÚNICOS y escritura fail-closed para los dropfiles
// de las colas del pipeline (#6226).
//
// EL BUG QUE ESTE MÓDULO CIERRA
// -----------------------------
// Los productores nombraban el dropfile con `${Date.now()}-<sufijo>`. Dos
// mensajes emitidos en el MISMO tick del event loop (ej. el `reply` + los
// `extraMessages` del paginado de `/wave`) resuelven al mismo milisegundo, por
// lo tanto al mismo path, y el segundo `writeFileSync` PISA al primero. El
// operador recibía un solo mensaje, sin error, sin reintento y sin más rastro
// que dos líneas de log con el mismo nombre de archivo (9 colisiones sobre 442
// encolados en el log del 2026-08-20 ≈ 2% de salientes perdidos en silencio).
//
// DOS DEFENSAS INDEPENDIENTES
// ---------------------------
// 1. Contador de secuencia dentro del milisegundo → los productores del mismo
//    proceso nunca calculan el mismo nombre.
// 2. Escritura con flag `wx` (fail-closed) → si el path YA existe (otro proceso,
//    reloj para atrás, resto de una corrida anterior) la escritura falla en vez
//    de sobreescribir, y se reintenta con el nombre siguiente. Nunca se pierde
//    contenido en silencio.
//
// INVARIANTES DE NOMBRE (no "simplificar" sin releer esto)
// --------------------------------------------------------
// - Formato: `<ts>-<seq>-<sufijo>`, ej. `1787039565917-0000-cmd.json`.
//
// - El timestamp va PRIMERO para que el orden lexicográfico del nombre siga
//   siendo el orden de emisión. Los consumidores drenan por orden de nombre
//   (`servicio-telegram.js::listWorkFiles`), así que el orden del nombre ES el
//   orden en que el operador lee los mensajes. En el paginado sólo el primer
//   mensaje lleva header y los 2..N arrancan con `_(continúa)_`: invertirlos es
//   una experiencia PEOR que perder uno.
//
// - El `seq` va ZERO-PADDED a 4 dígitos. Sin padding, `<ts>-10-cmd.json` ordena
//   ANTES que `<ts>-9-cmd.json` (comparación lexicográfica, no numérica).
//
// - El `seq` va ANTES del sufijo, NUNCA al final. `telegram-burst-grouper.js::
//   extractPidFromFilename` deriva el `pid` de la clave de burst con
//   `/-(\d+)\.json$/`. `…-0000-cmd.json` no matchea (termina en `-cmd.json`) →
//   `pid='unknown'`, que preserva el agrupamiento actual. Si el seq quedara al
//   final (`…-cmd-0000.json`) SÍ matchearía, y cada mensaje caería en un burst
//   distinto, alterando en silencio el agrupamiento de todos los salientes.
//
// - El contador se REINICIA en cada milisegundo nuevo. Así el seq sólo cuenta
//   escrituras dentro de un mismo ms (en la práctica, un puñado), nunca se
//   acerca al techo de 4 dígitos y el orden lexicográfico queda garantizado sin
//   depender de que el contador no desborde.

const fs = require('fs');
const path = require('path');

const SEQ_WIDTH = 4;
const SEQ_MAX = 10 ** SEQ_WIDTH; // 10000
const DEFAULT_MAX_ATTEMPTS = 64;

// Estado del contador, por PROCESO. Deliberadamente NO se persiste: su único
// trabajo es desempatar escrituras del mismo proceso dentro del mismo
// milisegundo. Las colisiones ENTRE procesos las cubre el flag `wx`.
let lastTs = -1;
let seqInTs = 0;

function padSeq(seq) {
  return String(((seq % SEQ_MAX) + SEQ_MAX) % SEQ_MAX).padStart(SEQ_WIDTH, '0');
}

// Devuelve el próximo seq para `ts`, reiniciando en cada milisegundo nuevo.
// Un reloj que va para atrás (NTP) también reinicia: no rompe unicidad porque
// el `wx` de `writeDropfileSync` es el que garantiza que no se pisa nada.
function nextSeqFor(ts) {
  if (ts !== lastTs) {
    lastTs = ts;
    seqInTs = 0;
  }
  const seq = seqInTs;
  seqInTs = (seqInTs + 1) % SEQ_MAX;
  return seq;
}

// Nombre único para un dropfile. `suffix` es la parte descriptiva CON extensión
// (`'cmd.json'`, `'quota-snapshot.json'`, …) — se pega tal cual al final.
function buildDropfileName(suffix, opts = {}) {
  if (typeof suffix !== 'string' || suffix.length === 0) {
    throw new Error('dropfile-writer: `suffix` debe ser un string no vacío');
  }
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const ts = now();
  return `${ts}-${padSeq(nextSeqFor(ts))}-${suffix}`;
}

// Escribe `data` en `dir` con un nombre único, sin sobreescribir jamás.
//
// Devuelve `{ filename, filePath, collisions }`. Lanza si se agotan los
// intentos o si el error de escritura no es una colisión de nombre (un ENOSPC
// no se debe enmascarar reintentando con otro nombre).
//
// `onCollision(filename, attempt)` se invoca en cada colisión para que el
// productor la registre en su log: una colisión es un evento anómalo que sin
// este aviso volvería a ser invisible.
function writeDropfileSync(options = {}) {
  const {
    dir,
    suffix,
    data,
    fsImpl = fs,
    now = Date.now,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    onCollision = null,
  } = options;

  if (typeof dir !== 'string' || dir.length === 0) {
    throw new Error('dropfile-writer: `dir` debe ser un string no vacío');
  }
  const payload = typeof data === 'string' || Buffer.isBuffer(data)
    ? data
    : JSON.stringify(data);

  let lastErr = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // El `ts` se recalcula en cada intento: si el milisegundo avanzó, el nombre
    // nuevo sigue ordenando después del anterior y el orden de emisión se
    // mantiene.
    const filename = buildDropfileName(suffix, { now });
    const filePath = path.join(dir, filename);
    try {
      // `wx` = crear en exclusiva. Si existe, EEXIST en vez de pisar.
      fsImpl.writeFileSync(filePath, payload, { flag: 'wx' });
      return { filename, filePath, collisions: attempt };
    } catch (e) {
      if (e && e.code === 'EEXIST') {
        lastErr = e;
        if (typeof onCollision === 'function') {
          try { onCollision(filename, attempt); } catch { /* el log no rompe la escritura */ }
        }
        continue;
      }
      throw e; // ENOSPC, EACCES, ENOENT… no son colisiones: que las vea el caller.
    }
  }
  const err = new Error(
    `dropfile-writer: no se pudo escribir un dropfile único en ${dir} tras ${maxAttempts} intentos (sufijo ${suffix})`
  );
  err.code = 'EDROPFILECOLLISION';
  err.cause = lastErr;
  throw err;
}

// Sólo para tests: reinicia el contador de proceso.
function __resetSeqForTests() {
  lastTs = -1;
  seqInTs = 0;
}

module.exports = {
  buildDropfileName,
  writeDropfileSync,
  padSeq,
  SEQ_WIDTH,
  SEQ_MAX,
  DEFAULT_MAX_ATTEMPTS,
  __resetSeqForTests,
};

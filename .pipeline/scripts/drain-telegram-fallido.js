#!/usr/bin/env node
// =============================================================================
// drain-telegram-fallido.js — Drenaje one-shot de la cola de salientes fallidos
// Issue #5924 (split de #5915, parte 2)
//
// Qué resuelve
// ------------
// `.pipeline/servicios/telegram/fallido/` acumuló ~193 salientes que el barredor
// del servicio reencolaba en CADA arranque (ver `sweepFallidoOnce`). El fix del
// servicio corta el ciclo hacia adelante — marca los rechazos no reintentables y
// deja de reencolarlos —, pero los salientes YA acumulados no traen ese flag:
// fueron escritos por la lógica vieja. Este script los clasifica y los cierra de
// una sola pasada.
//
// Reglas inquebrantables
// ----------------------
//   - Se ejecuta con el servicio DETENIDO. Drenar en caliente compite con el
//     barredor y con el drainer: dos procesos moviendo los mismos archivos.
//     El script lo verifica contra el SO y aborta salvo `--force`.
//   - DRY-RUN por default. Sin `--apply` no mueve un solo archivo.
//   - NUNCA vuelca el contenido de un dropfile a stdout ni a log: son payloads
//     completos (texto del operador, adjuntos, tokens de acción). El log lleva
//     sólo nombre de archivo + causa + acción tomada.
//   - R7: un saliente con `reply_markup` NO se reencola jamás. Un botón con URL
//     de acción porta una capability con TTL de 24h; reenviar el payload viejo
//     sería un replay sobre un issue posiblemente ya resuelto. Se descarta; si
//     el aviso sigue haciendo falta, lo regenera su productor.
//   - Las alertas `alert-svc-telegram-*` se descartan CON SU CAUSA REGISTRADA:
//     son la evidencia de la segunda causa enmascarada por el string genérico
//     (29 de ellas no tienen `reply_markup`, así que el botón no las explica).
//
// Uso
// ---
//   node .pipeline/scripts/drain-telegram-fallido.js            # censo (dry-run)
//   node .pipeline/scripts/drain-telegram-fallido.js --apply    # drena de verdad
//   node .pipeline/scripts/drain-telegram-fallido.js --apply --force  # sin chequeo de servicio
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

const PIPELINE = process.env.PIPELINE_STATE_DIR || path.resolve(__dirname, '..');
const QUEUE_DIR = path.join(PIPELINE, 'servicios', 'telegram');
const FALLIDO = path.join(QUEUE_DIR, 'fallido');
const PENDIENTE = path.join(QUEUE_DIR, 'pendiente');
const LISTO = path.join(QUEUE_DIR, 'listo');
const LOG_DIR = path.join(PIPELINE, 'logs');

const alertDedup = require('../lib/telegram-alert-dedup');

// Escalonado del reencolado: mismo criterio que el barredor (SEC-3 anti
// retry-storm). No se toca la política de reintentos, sólo cuándo arranca cada uno.
const STAGGER_MS = 15000;
// Salientes más viejos que esto no se reenvían: un aviso de hace días fuera de
// contexto es ruido, no información.
const STALE_MS = 24 * 60 * 60 * 1000;

const ACCIONES = Object.freeze({ DESCARTAR: 'descartar', REENCOLAR: 'reencolar', DEJAR: 'dejar' });

/**
 * Antigüedad REAL del saliente, no la del último intento.
 *
 * `_failedAt` no sirve solo: el barredor lo borra al reencolar y
 * `handleSendFailure` lo vuelve a estampar en el siguiente fallo terminal, así
 * que un saliente reciclado durante dos semanas exhibe un `_failedAt` de hace
 * minutos. La marca honesta es el timestamp que el productor puso EN EL NOMBRE
 * del dropfile (`alert-<slug>-<ts>-<pid>.json`, `<ts>-cmd.json`,
 * `<ts>-voice-<cid>-p<n>.json`). Se toma la evidencia MÁS VIEJA disponible.
 *
 * @returns {number} ms de antigüedad, o NaN si no se pudo determinar
 */
function outboundAgeMs(fileName, data, now, mtimeMs) {
  const candidatos = [];
  const m = String(fileName || '').match(/(?:^|-)(\d{13})(?:-|\.)/);
  if (m) {
    const t = Number.parseInt(m[1], 10);
    // Sanidad: un timestamp de 13 dígitos que no cae en un rango plausible se
    // ignora en vez de producir una edad absurda.
    if (Number.isFinite(t) && t > 0 && t <= now) candidatos.push(now - t);
  }
  if (data && data._failedAt) {
    const t = Date.parse(data._failedAt);
    if (Number.isFinite(t) && t <= now) candidatos.push(now - t);
  }
  if (Number.isFinite(mtimeMs) && mtimeMs <= now) candidatos.push(now - mtimeMs);
  if (candidatos.length === 0) return NaN;
  return Math.max(...candidatos);
}

/**
 * Clasifica un saliente fallido. PURO: recibe el dropfile ya parseado (o `null`
 * si es ilegible) y devuelve `{ accion, causa }`. No toca disco.
 *
 * El orden de las reglas es la política: primero lo que NUNCA se reenvía.
 *
 * @param {string} fileName
 * @param {object|null} data
 * @param {number} ageMs — antigüedad del fallo
 * @returns {{accion: string, causa: string}}
 */
function classify(fileName, data, ageMs) {
  if (!data) {
    return { accion: ACCIONES.DESCARTAR, causa: 'dropfile ilegible o JSON malformado' };
  }
  // Alertas propias del servicio: se descartan siempre (reenviar un aviso de
  // fallo de hace días no informa nada), pero registrando su causa real — es la
  // evidencia de por qué fallaron, que el string genérico enmascaraba.
  if (typeof fileName === 'string' && fileName.startsWith('alert-svc-telegram')) {
    const code = alertDedup.coerceTelegramErrorCode(data._telegramErrorCode);
    const causaReal = code != null
      ? `alerta propia del servicio (error_code ${code})`
      : `alerta propia del servicio (error_code no registrado; _error ${data._error ? 'presente' : 'ausente'})`;
    return { accion: ACCIONES.DESCARTAR, causa: causaReal };
  }
  // R7 — capability con TTL. Nunca se reenvía el payload viejo tal cual.
  if (data.reply_markup && typeof data.reply_markup === 'object') {
    return {
      accion: ACCIONES.DESCARTAR,
      causa: 'notificacion con botones: no reenviable (replay de capability, R7)',
    };
  }
  // Rechazo no reintentable ya diagnosticado por el servicio.
  const code = alertDedup.coerceTelegramErrorCode(data._telegramErrorCode);
  if (alertDedup.isPermanentTelegramError(code)) {
    return { accion: ACCIONES.DESCARTAR, causa: `rechazo permanente de la API (error_code ${code})` };
  }
  if (Number.isFinite(ageMs) && ageMs > STALE_MS) {
    return { accion: ACCIONES.DESCARTAR, causa: `stale (>${Math.round(STALE_MS / 3600000)}h): fuera de contexto` };
  }
  if (!data.text && !data.caption && !data.document && !data.photo
    && !data.video && !data.animation && !data.voice && !data.method) {
    return { accion: ACCIONES.DESCARTAR, causa: 'sin contenido enviable' };
  }
  return { accion: ACCIONES.REENCOLAR, causa: 'reintentable: sin causa permanente registrada' };
}

function parseArgs(argv) {
  const set = new Set(argv.slice(2));
  return { apply: set.has('--apply'), force: set.has('--force') };
}

/** ¿Hay una instancia viva de svc-telegram según el SO? `null` si no se pudo saber. */
function serviceRunning() {
  try {
    const { findPidByScript, invalidateCache } = require('../pid-discovery');
    invalidateCache();
    const found = findPidByScript('servicio-telegram.js');
    return found && found.pid ? found.pid : false;
  } catch {
    return null; // no se pudo determinar
  }
}

function main() {
  const { apply, force } = parseArgs(process.argv);
  const modo = apply ? 'APPLY' : 'DRY-RUN';
  const lines = [];
  const say = (m) => { lines.push(m); console.log(m); };

  say(`[drain-telegram-fallido] modo=${modo} cola=${FALLIDO}`);

  if (apply) {
    const pid = serviceRunning();
    if (pid && !force) {
      console.error(
        `[drain-telegram-fallido] ABORTA: svc-telegram vivo (PID ${pid}). `
        + 'Drenar en caliente compite con el barredor. Detené el servicio o usá --force.',
      );
      process.exit(2);
    }
    if (pid === null) say('[drain-telegram-fallido] aviso: no se pudo verificar si el servicio corre');
  }

  let names;
  try {
    names = fs.readdirSync(FALLIDO).filter((f) => f.endsWith('.json'));
  } catch (e) {
    console.error(`[drain-telegram-fallido] no se pudo leer ${FALLIDO}: ${e.message}`);
    process.exit(1);
  }

  const censo = new Map();
  let descartados = 0, reencolados = 0, errores = 0, idx = 0;
  const now = Date.now();

  for (const name of names) {
    const filePath = path.join(FALLIDO, name);
    let data = null;
    let mtimeMs = NaN;
    try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { /* ilegible */ }
    try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch { /* sin stat */ }
    const ageMs = outboundAgeMs(name, data, now, mtimeMs);

    const { accion, causa } = classify(name, data, ageMs);
    censo.set(causa, (censo.get(causa) || 0) + 1);
    // Sólo nombre + causa + acción. NUNCA el contenido del dropfile.
    say(`  ${name} | ${causa} | ${accion}`);

    if (!apply) continue;

    try {
      if (accion === ACCIONES.DESCARTAR) {
        const dest = path.join(LISTO, name.replace(/\.json$/, '-drenado-descartado.json'));
        fs.renameSync(filePath, dest);
        descartados++;
      } else if (accion === ACCIONES.REENCOLAR) {
        data._telegramAttempts = 0;
        data._nextRetryAt = new Date(now + (idx + 1) * STAGGER_MS).toISOString();
        delete data._error;
        delete data._failedAt;
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        fs.renameSync(filePath, path.join(PENDIENTE, name));
        reencolados++;
        idx++;
      }
    } catch (e) {
      errores++;
      say(`  ${name} | ERROR moviendo: ${e.code || 'desconocido'} | dejado en fallido/`);
    }
  }

  say('');
  say(`[drain-telegram-fallido] total=${names.length} descartados=${descartados} reencolados=${reencolados} errores=${errores}`);
  say('[drain-telegram-fallido] censo de causas:');
  for (const [causa, n] of [...censo.entries()].sort((a, b) => b[1] - a[1])) {
    say(`  ${String(n).padStart(4)}  ${causa}`);
  }
  if (!apply) say('[drain-telegram-fallido] DRY-RUN: no se movió ningún archivo. Usá --apply para ejecutar.');

  // Traza persistente del drenaje (sólo nombres + causas + acciones).
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(
      path.join(LOG_DIR, `drain-telegram-fallido-${stamp}.log`),
      lines.join('\n') + '\n',
    );
  } catch { /* la traza es best-effort; el drenaje ya ocurrió */ }
}

module.exports = { classify, outboundAgeMs, ACCIONES, STALE_MS };

if (require.main === module) main();

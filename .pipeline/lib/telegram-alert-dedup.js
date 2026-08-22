// =============================================================================
// telegram-alert-dedup.js — Agrupación acotada de alertas de fallo de svc-telegram
// Issue #5924 (split de #5915, parte 2)
//
// Por qué existe
// --------------
// `svc-telegram` emite UNA alerta por saliente que agota sus reintentos. Eso ya
// estaba bien acotado por saliente (una sola invocación en `handleSendFailure`),
// pero NO entre salientes distintos: un burst de 30 fallos por la misma causa
// producía 30 alertas idénticas en segundos, cada una de las cuales es a su vez
// un saliente más en la misma cola.
//
// `telegram-burst-grouper.js` NO sirve acá: agrupa por `skill+issue+pid+type` y
// las alertas de `svc-telegram` no traen `skill` ni `issue` (guru §4.4).
//
// Reglas de diseño (vinculantes, del análisis de `security` sobre #5915)
// ----------------------------------------------------------------------
//   R4.1 / SEC-D — La clave de agrupación se deriva SOLO de valores acotados:
//         `error_code` coercionado a un set conocido (+ bucket `otros`) y el
//         tipo de saliente (enum cerrado). JAMÁS de `description`, que es texto
//         remoto de cardinalidad infinita: un bucket por saliente sería un DoS
//         de memoria por cardinalidad de claves.
//   R4.2 — El conteo va SIEMPRE en el mensaje emitido. Una dedup que no dice
//         cuántos agrupó es indistinguible de una que perdió eventos.
//   R4.3 — El buffer está acotado en ventana Y en tamaño. Un acumulador sin cota
//         en un servicio de vida larga es un DoS autoinfligido, justo bajo el
//         burst que motiva la feature.
//
// Fail-closed hacia la VISIBILIDAD: ante desborde de claves o cualquier duda, se
// emite la alerta. Nunca se silencia por no poder contabilizar.
//
// Módulo PURO: sin I/O, sin timers, sin `Date.now()` implícito (el reloj entra
// por parámetro). Testeable aislado.
// =============================================================================
'use strict';

// Códigos que la API de Telegram devuelve en la práctica. Cualquier otro valor
// (incluido uno inventado por un intermediario) cae al bucket `otros` → la
// cardinalidad total de claves queda acotada por construcción (SEC-D).
const KNOWN_TELEGRAM_CODES = Object.freeze([400, 401, 403, 404, 409, 413, 420, 429, 500]);
const OTHER_BUCKET = 'otros';

// Códigos 4xx que NO tiene sentido reintentar: la request es inválida o el bot
// no tiene permiso. Reintentarlos quema presupuesto y, sobre todo, hace que el
// barredor de `fallido/` recicle el saliente en cada arranque del servicio.
// `429` (rate limit) y `420` (flood wait) quedan FUERA a propósito: son
// transitorios y el backoff existente los cubre.
const NON_RETRYABLE_CODES = Object.freeze([400, 401, 403, 404, 409, 413]);

// Tipos de saliente. Enum cerrado — es la otra mitad de la clave de dedup, así
// que tiene que tener cardinalidad fija.
const OUTBOUND_KINDS = Object.freeze([
  'audio',
  'documento',
  'imagen',
  'video',
  'animacion',
  'notificacion con botones',
  'mensaje de texto',
  'desconocido',
]);

const DEFAULT_WINDOW_MS = 60 * 1000;   // ventana corta de agrupación
const DEFAULT_MAX_KEYS = 64;           // cota dura de claves vivas (R4.3)
const MAX_COUNT_PER_KEY = 1000000;     // cota del contador (no crece sin límite)
const MAX_SAMPLE_LEN = 200;            // extracto de muestra ya viene acotado

/**
 * Coerciona el `error_code` remoto a entero o `null`. No confía en el tipo del
 * body: la API puede devolver string, y un intermediario cualquier cosa.
 *
 * @param {*} raw
 * @returns {number|null}
 */
function coerceTelegramErrorCode(raw) {
  if (raw == null) return null;
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isInteger(n)) return null;
  // Rango sano de códigos HTTP-like. Fuera de rango → tratado como ausente.
  if (n < 100 || n > 599) return null;
  return n;
}

/**
 * Bucket acotado del `error_code` (SEC-D). Siempre devuelve uno de los códigos
 * conocidos como string, o `'otros'`. Nunca propaga el valor remoto crudo.
 *
 * @param {*} code
 * @returns {string}
 */
function dedupBucket(code) {
  const n = coerceTelegramErrorCode(code);
  return n != null && KNOWN_TELEGRAM_CODES.includes(n) ? String(n) : OTHER_BUCKET;
}

/**
 * ¿El código indica un fallo PERMANENTE (no reintentable)?
 * Sólo `true` con un código conocido y explícitamente no reintentable — ante
 * `null`/desconocido devuelve `false` (fail-closed: se sigue reintentando, que
 * es el comportamiento histórico y el que no pierde mensajes).
 *
 * @param {*} code
 * @returns {boolean}
 */
function isPermanentTelegramError(code) {
  const n = coerceTelegramErrorCode(code);
  return n != null && NON_RETRYABLE_CODES.includes(n);
}

/** Normaliza el tipo de saliente al enum cerrado. */
function normalizeKind(kind) {
  const k = typeof kind === 'string' ? kind : '';
  return OUTBOUND_KINDS.includes(k) ? k : 'desconocido';
}

/**
 * Clave de agrupación: `<bucket de error_code>|<tipo de saliente>`.
 * Cardinalidad máxima = (KNOWN_TELEGRAM_CODES.length + 1) * OUTBOUND_KINDS.length.
 *
 * @param {*} code
 * @param {*} kind
 * @returns {string}
 */
function dedupKey(code, kind) {
  return `${dedupBucket(code)}|${normalizeKind(kind)}`;
}

/** Descripción legible de la causa a partir de la clave (para el consolidado). */
function describeKey(key) {
  const [bucket, kind] = String(key).split('|');
  const causa = bucket === OTHER_BUCKET
    ? 'causa sin codigo conocido de la API'
    : `error_code ${bucket}`;
  return { causa, tipo: kind || 'desconocido' };
}

/**
 * Crea un buffer de agrupación.
 *
 * Contrato de uso (el caller manda el reloj):
 *   1. `flush(now)` en cada ciclo de poll → devuelve los consolidados vencidos.
 *   2. `register(key, sample, now)` por cada alerta candidata.
 *
 * `register` devuelve `{ emit, count, overflow }`:
 *   - `emit:true`  → la alerta se emite AHORA (primera de su ventana, o desborde
 *                    de claves). `count` es 1.
 *   - `emit:false` → quedó agrupada; saldrá en el consolidado del `flush`.
 *
 * `flush` devuelve `[{ key, count, sample, windowStartedAt, causa, tipo }]` sólo
 * para las ventanas vencidas con más de 1 evento (la primera ya se emitió sola).
 *
 * @param {{windowMs?: number, maxKeys?: number}} [opts]
 */
function createAlertDedup(opts = {}) {
  const windowMs = Number.isFinite(opts.windowMs) && opts.windowMs > 0
    ? opts.windowMs : DEFAULT_WINDOW_MS;
  const maxKeys = Number.isInteger(opts.maxKeys) && opts.maxKeys > 0
    ? opts.maxKeys : DEFAULT_MAX_KEYS;

  /** @type {Map<string, {firstAt:number, count:number, sample:string}>} */
  const buckets = new Map();

  function coerceNow(now) {
    return Number.isFinite(now) ? now : 0;
  }

  function coerceSample(sample) {
    if (typeof sample !== 'string' || sample.length === 0) return '';
    return sample.slice(0, MAX_SAMPLE_LEN);
  }

  return {
    /**
     * Contabiliza una alerta candidata.
     * @param {string} key   — de `dedupKey` (se re-normaliza defensivamente)
     * @param {string} sample— extracto YA redactado y acotado por el caller
     * @param {number} now   — epoch ms
     */
    register(key, sample, now) {
      const t = coerceNow(now);
      // Defensivo: la clave nunca debe traer texto remoto. Se acota igual.
      const k = String(key == null ? dedupKey(null, null) : key).slice(0, 64);
      const existing = buckets.get(k);

      if (existing && (t - existing.firstAt) < windowMs) {
        if (existing.count < MAX_COUNT_PER_KEY) existing.count += 1;
        if (!existing.sample) existing.sample = coerceSample(sample);
        return { emit: false, count: existing.count, overflow: false };
      }

      if (existing) {
        // Ventana vencida sin `flush` intermedio: se reabre. El caller que llama
        // a `flush` antes de `register` (contrato recomendado) nunca cae acá.
        existing.firstAt = t;
        existing.count = 1;
        existing.sample = coerceSample(sample);
        return { emit: true, count: 1, overflow: false };
      }

      if (buckets.size >= maxKeys) {
        // R4.3 — cota dura. No creamos bucket nuevo; se emite igual (fail-closed
        // hacia la visibilidad). Nunca se silencia por no poder contabilizar.
        return { emit: true, count: 1, overflow: true };
      }

      buckets.set(k, { firstAt: t, count: 1, sample: coerceSample(sample) });
      return { emit: true, count: 1, overflow: false };
    },

    /**
     * Cierra las ventanas vencidas. Devuelve los consolidados a emitir.
     * @param {number} now — epoch ms
     */
    flush(now) {
      const t = coerceNow(now);
      const out = [];
      for (const [k, b] of [...buckets.entries()]) {
        if ((t - b.firstAt) < windowMs) continue;
        buckets.delete(k);
        if (b.count <= 1) continue; // la única de la ventana ya se emitió sola
        out.push({
          key: k,
          count: b.count,
          sample: b.sample,
          windowStartedAt: b.firstAt,
          ...describeKey(k),
        });
      }
      return out;
    },

    /** Cierra TODAS las ventanas (shutdown / test). Mismo shape que `flush`. */
    drain() {
      const out = [];
      for (const [k, b] of [...buckets.entries()]) {
        buckets.delete(k);
        if (b.count <= 1) continue;
        out.push({ key: k, count: b.count, sample: b.sample, windowStartedAt: b.firstAt, ...describeKey(k) });
      }
      return out;
    },

    /** Cantidad de claves vivas — para tests de cota. */
    size() {
      return buckets.size;
    },

    windowMs,
    maxKeys,
  };
}

module.exports = {
  coerceTelegramErrorCode,
  dedupBucket,
  dedupKey,
  describeKey,
  isPermanentTelegramError,
  normalizeKind,
  createAlertDedup,
  KNOWN_TELEGRAM_CODES,
  NON_RETRYABLE_CODES,
  OUTBOUND_KINDS,
  OTHER_BUCKET,
  DEFAULT_WINDOW_MS,
  DEFAULT_MAX_KEYS,
  MAX_SAMPLE_LEN,
};

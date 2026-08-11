// =============================================================================
// pulpo-liveness-margin.js — Dimensionamiento del umbral de liveness del Pulpo
// contra la duración real de ciclo, alerta de margen y freno anti-bucle (#5821)
//
// Por qué este módulo existe
// --------------------------
// El umbral de kill del Pulpo (`pulpo_liveness_kill_seconds`) se venía eligiendo
// a mano DESPUÉS de cada incidente: 90 → 180 → 270. Ninguno derivado de una
// medición. El 2026-08-11 el watchdog mató y relanzó al Pulpo 77 veces en 3
// horas porque el umbral (180s) era MENOR que la duración real de un ciclo: un
// falso positivo puro. Se subió a 270s y el bucle paró, pero sobre los ciclos
// medidos el pico de antigüedad de heartbeat fue 245s => ~9% de margen. Eso no
// es un colchón: es un empate. Una ola más grande, un build concurrente o una
// ventana de QA pesada empujan el ciclo por encima y el bucle vuelve idéntico.
//
// Y el modo de falla es especialmente caro porque SE VE COMO OTRA COSA: lo que
// llega al operador es "el Commander no responde", no "el watchdog está matando
// un proceso sano". Tres horas de diagnóstico en la dirección equivocada.
//
// Qué resuelve
// ------------
//   CA-1  Persiste una serie de duraciones observadas por ciclo (el runner es
//         efímero — lo lanza PowerShell cada 2 min — así que la serie va a disco).
//   CA-2  Deriva el umbral efectivo del percentil observado por un factor
//         configurable, con PISO desde config.yaml.
//   CA-3  Fail-closed: config inválida NUNCA produce "nunca stale" ni un umbral
//         menor al piso (regla SEC-2 vigente de #4154/#5172).
//   CA-5  Evalúa el margen consumido para que el runner alerte ANTES del 1er kill.
//   CA-6  Cooldown por ventana: una alerta por ventana, no una por ciclo.
//   CA-7  Cap de kills por ventana => escalar a needs-human en vez de repetirse.
//
// Decisiones de diseño que NO son obvias
// --------------------------------------
// 1. TECHO ANTI-REALIMENTACIÓN (`maxEffectiveSeconds`). `max(piso, p × factor)`
//    es fail-closed hacia abajo pero NO está acotado hacia arriba, y ahí hay un
//    lazo peligroso: si un cuelgue real entra a la serie sube el percentil, que
//    sube el umbral, que hace que el próximo cuelgue se tolere más tiempo y
//    entre también a la serie. El watchdog se volvería progresivamente ciego, en
//    silencio y sin ningún kill que delate el problema. El techo corta el lazo.
//
// 2. LAS MUESTRAS DE CICLOS QUE TERMINARON EN KILL NO CALIBRAN LA NORMALIDAD.
//    Son anómalas por definición; el runner no las agrega a la serie.
//
// 3. N MÍNIMO (`minSamples`). Un percentil alto sobre pocas muestras degenera en
//    "el máximo". Con N insuficiente el umbral efectivo se queda en el PISO —
//    nunca se inventa un umbral más laxo con evidencia flaca.
//
// 4. LAS MUESTRAS SON INPUT NO CONFIABLE (SEC-2). Pueden venir del contenido de
//    `last-tick.json`, que el watchdog no controla. Por eso cada muestra se
//    CLAMPEA al techo antes de entrar a la serie: aun con un payload falsificado,
//    lo peor que puede lograr un atacante es empujar el umbral hasta el techo
//    configurado — nunca deshabilitar el watchdog.
//
// Cero dependencias npm. Funciones puras salvo load/save de estado en FS.
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

// `parsePositiveInt` ya existe y está testeado en el módulo hermano (#4077).
// Se reusa en vez de duplicar la primitiva de validación fail-closed.
const { parsePositiveInt } = require('./watchdog-supervisor');
// El piso por default vive en el módulo dueño de la decisión de liveness; acá se
// reusa para que un `floorSeconds` inválido caiga al MISMO valor que usaría el
// watchdog, y no a un número inventado por este módulo.
const { DEFAULT_KILL_SECONDS } = require('./pulpo-liveness');

// --- Defaults (todos overridables por config.yaml, sección `watchdog:`) -------

// Percentil sobre el que se dimensiona. p99 = "el ciclo casi más lento que
// vimos", no el promedio: el umbral tiene que cubrir la cola, no la mediana.
const DEFAULT_PERCENTILE = 99;

// Factor sobre el percentil. 2x deja el umbral al DOBLE del ciclo casi-peor
// observado. Es el colchón que hoy no existe (9% real vs 100% con factor 2).
const DEFAULT_FACTOR = 2;

// Techo del umbral efectivo (ver decisión 1). 900s = 15 min: por encima de eso
// un Pulpo que no late no es "lento", está colgado.
const DEFAULT_MAX_EFFECTIVE_SECONDS = 900;

// N mínimo de muestras para que el percentil pueda mover el umbral (decisión 3).
// A 1 muestra cada 2 min, 100 muestras ≈ 3.3 h de observación.
const DEFAULT_MIN_SAMPLES = 100;

// Muestras retenidas. 720 ≈ 24 h a una cada 2 min.
const DEFAULT_MAX_SAMPLES = 720;

// % del umbral efectivo consumido por el pico a partir del cual se alerta.
// 75% = queda un cuarto de colchón: hay tiempo de reaccionar antes del 1er kill.
const DEFAULT_ALERT_MARGIN_PCT = 75;

// Cooldown de la alerta de margen (CA-6). 60 min: la condición es estructural
// (el ciclo se alargó), no un flapeo; repetirla cada 2 min entrena al operador
// a silenciar el canal — que es exactamente el fallo que este issue quiere evitar.
const DEFAULT_ALERT_COOLDOWN_MINUTES = 60;

// CA-7 — cap de kills por ventana antes de escalar a needs-human. Mismos
// valores que el supervisor del watchdog (#4077) para no tener dos frenos con
// semánticas distintas.
const DEFAULT_MAX_KILLS = 3;
const DEFAULT_KILL_WINDOW_MINUTES = 60;

const DEFAULT_STATE = Object.freeze({
  samples: [],
  kills: [],
  lastAlertTs: 0,
  lastEscalationTs: 0,
  alertRepeats: 0,
  // Identidad de la última iteración ya contabilizada (ver `appendSample`).
  lastTickId: null,
});

// -----------------------------------------------------------------------------
// Parsers fail-closed
// -----------------------------------------------------------------------------

/**
 * Valida el factor multiplicativo del percentil.
 * Acepta decimales (1.5) pero NUNCA < 1: un factor menor a 1 dejaría el umbral
 * derivado POR DEBAJO del percentil observado, o sea garantizaría falsos
 * positivos — la degradación destructiva que este issue viene a matar.
 * Cap superior de sanidad (100) para que un typo tipo `2000` no vuele el techo.
 *
 * @param {*} raw
 * @param {number} fallback
 * @returns {number} finito, >= 1
 */
function parseFactor(raw, fallback = DEFAULT_FACTOR) {
  const safeFallback =
    Number.isFinite(fallback) && fallback >= 1 && fallback <= 100 ? fallback : DEFAULT_FACTOR;
  let n = null;
  if (typeof raw === 'number') n = raw;
  else if (typeof raw === 'string' && /^[0-9]+(\.[0-9]+)?$/.test(raw.trim())) {
    n = parseFloat(raw.trim());
  }
  if (n == null || !Number.isFinite(n) || n < 1 || n > 100) return safeFallback;
  return n;
}

/**
 * Valida un porcentaje entero en 1..100 (percentil, % de alerta).
 * Fuera de rango / no numérico => fallback. Un 0 NO puede pasar: un umbral de
 * alerta de 0% alertaría siempre y un percentil 0 sería la muestra mínima.
 *
 * @param {*} raw
 * @param {number} fallback
 * @returns {number} entero en 1..100
 */
function parsePercent(raw, fallback) {
  const safeFallback =
    Number.isInteger(fallback) && fallback >= 1 && fallback <= 100 ? fallback : 100;
  let n = null;
  if (typeof raw === 'number' && Number.isInteger(raw)) n = raw;
  else if (typeof raw === 'string' && /^[0-9]+$/.test(raw.trim())) n = parseInt(raw.trim(), 10);
  if (n == null || !Number.isInteger(n) || n < 1 || n > 100) return safeFallback;
  return n;
}

// -----------------------------------------------------------------------------
// Estadística
// -----------------------------------------------------------------------------

/**
 * Percentil por nearest-rank sobre una copia ordenada. Determinístico y sin
 * interpolación: con pocas muestras la interpolación inventa valores que no se
 * observaron, y acá cada valor tiene que ser un ciclo que realmente pasó.
 *
 * @param {number[]} values  valores crudos (se filtran los no finitos)
 * @param {number} p         percentil 1..100
 * @returns {number|null} null si no hay muestras válidas
 */
function percentile(values, p) {
  if (!Array.isArray(values)) return null;
  const clean = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  if (clean.length === 0) return null;
  const pct = parsePercent(p, DEFAULT_PERCENTILE);
  const rank = Math.ceil((pct / 100) * clean.length);
  const idx = Math.min(clean.length - 1, Math.max(0, rank - 1));
  return clean[idx];
}

// -----------------------------------------------------------------------------
// Estado persistido (CA-1)
// -----------------------------------------------------------------------------

/**
 * Normaliza (defensivamente) el estado leído de disco. Cualquier campo
 * corrupto se descarta en silencio: el estado es una CACHÉ de observación, no
 * una fuente de autoridad — perderlo sólo hace que el umbral vuelva al piso,
 * que es la dirección segura.
 */
function normalizeState(obj) {
  const out = {
    samples: [],
    kills: [],
    lastAlertTs: 0,
    lastEscalationTs: 0,
    alertRepeats: 0,
    lastTickId: null,
  };
  if (!obj || typeof obj !== 'object') return out;
  if (typeof obj.lastTickId === 'string' && obj.lastTickId.length > 0 && obj.lastTickId.length <= 64) {
    out.lastTickId = obj.lastTickId;
  }
  if (Array.isArray(obj.samples)) {
    out.samples = obj.samples
      .filter((s) => s && typeof s === 'object')
      .map((s) => ({ t: Number(s.t), ms: Number(s.ms) }))
      // `t` es metadata (cuándo se observó) y NO participa de ningún cálculo: el
      // percentil se computa sobre `ms`. Por eso se acepta `t >= 0` y no `> 0` —
      // con `> 0` una muestra de t=0 se borraba sola en el siguiente
      // `normalizeState`, o sea la serie perdía datos en silencio.
      .filter((s) => Number.isFinite(s.t) && s.t >= 0 && Number.isFinite(s.ms) && s.ms >= 0);
  }
  if (Array.isArray(obj.kills)) {
    out.kills = obj.kills.filter((t) => Number.isFinite(t) && t > 0);
  }
  if (Number.isFinite(obj.lastAlertTs) && obj.lastAlertTs > 0) out.lastAlertTs = obj.lastAlertTs;
  if (Number.isFinite(obj.lastEscalationTs) && obj.lastEscalationTs > 0) {
    out.lastEscalationTs = obj.lastEscalationTs;
  }
  if (Number.isInteger(obj.alertRepeats) && obj.alertRepeats >= 0) {
    out.alertRepeats = obj.alertRepeats;
  }
  return out;
}

/** Carga el estado. Fail-soft: ausente/corrupto => estado vacío. */
function loadState(file) {
  try {
    return normalizeState(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (_) {
    return { ...DEFAULT_STATE, samples: [], kills: [] };
  }
}

/** Escritura atómica (tmp + rename), mismo patrón que el heartbeat y #4077. */
function saveStateAtomic(file, state) {
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch (_) {
    /* fail-soft */
  }
  fs.writeFileSync(tmp, JSON.stringify(normalizeState(state)));
  fs.renameSync(tmp, file);
}

/**
 * Agrega una muestra de duración observada a la serie. Devuelve un NUEVO estado.
 *
 * DOS PROTECCIONES QUE NO SON OBVIAS:
 *
 * 1. CLAMP al techo (decisión 4): la duración viene del contenido no confiable
 *    de `last-tick.json`, y sin clamp un valor falsificado enorme empujaría el
 *    percentil — y con él el umbral — sin límite. Con clamp, el peor caso es
 *    "el umbral llega al techo configurado".
 *
 * 2. DEDUP por `tickId` (la identidad de la iteración): el watchdog muestrea
 *    cada ~2 min y las iteraciones duran ~4, así que el MISMO ciclo se vería 2-3
 *    veces y los ciclos más cortos que la cadencia no se verían nunca. Sin
 *    dedup, la serie sobre-pesa justo los ciclos largos que quiere medir y el
 *    percentil sale sesgado hacia arriba. Con `tickId` cada iteración aporta
 *    exactamente una muestra. Si el tickId no viene (heartbeat viejo o
 *    ilegible), se acepta la muestra: preferimos una serie con algo de sesgo
 *    —que sólo infla el umbral, dirección segura— antes que ninguna serie.
 *
 * @returns {object} nuevo estado
 */
function appendSample(state, opts = {}) {
  const base = normalizeState(state);
  const now = Number.isFinite(opts.now) ? opts.now : 0;
  const maxSamples = parsePositiveInt(opts.maxSamples, DEFAULT_MAX_SAMPLES);
  const ceilMs =
    parsePositiveInt(opts.maxEffectiveSeconds, DEFAULT_MAX_EFFECTIVE_SECONDS) * 1000;

  const raw = opts.durationMs;
  if (!Number.isFinite(raw) || raw < 0) return base; // muestra ilegible => se ignora

  const tickId = typeof opts.tickId === 'string' && opts.tickId.length > 0 ? opts.tickId : null;
  if (tickId !== null && tickId === base.lastTickId) {
    return base; // esta iteración ya está contada
  }

  const ms = Math.min(raw, ceilMs);
  const samples = base.samples.concat([{ t: now, ms }]);
  // Retención por cantidad (no por tiempo): la cadencia la fija PowerShell y
  // podar por antigüedad dejaría la serie vacía si el watchdog estuvo caído.
  const trimmed = samples.length > maxSamples ? samples.slice(samples.length - maxSamples) : samples;
  return { ...base, samples: trimmed, lastTickId: tickId !== null ? tickId : base.lastTickId };
}

/** Registra un kill en la ventana (poda los que ya salieron). Nuevo estado. */
function recordKill(state, now, windowMinutes = DEFAULT_KILL_WINDOW_MINUTES) {
  const base = normalizeState(state);
  const win = parsePositiveInt(windowMinutes, DEFAULT_KILL_WINDOW_MINUTES) * 60 * 1000;
  const kills = base.kills.filter((t) => now - t < win);
  kills.push(now);
  return { ...base, kills };
}

/** Marca que se emitió la alerta de margen (resetea el contador de repeticiones). */
function markAlert(state, now) {
  const base = normalizeState(state);
  return { ...base, lastAlertTs: now, alertRepeats: 0 };
}

/** Acumula una repetición silenciada por cooldown (se reporta en la próxima alerta). */
function bumpAlertRepeats(state) {
  const base = normalizeState(state);
  return { ...base, alertRepeats: base.alertRepeats + 1 };
}

/** Marca una escalada a needs-human (para dedup de la alerta). */
function markEscalation(state, now) {
  const base = normalizeState(state);
  return { ...base, lastEscalationTs: now };
}

// -----------------------------------------------------------------------------
// Umbral efectivo (CA-2 / CA-3)
// -----------------------------------------------------------------------------

/**
 * Calcula el umbral efectivo del watchdog. Función PURA.
 *
 * Invariante inquebrantable (CA-3, regla SEC-2): el resultado SIEMPRE es un
 * entero >= `floorSeconds`. No hay rama que devuelva Infinity, null, 0 ni un
 * valor menor al piso — "nunca stale" no es un estado alcanzable desde acá.
 *
 * @param {object} opts
 * @param {number[]} opts.samples             duraciones observadas en ms
 * @param {number} opts.floorSeconds          piso (de config.yaml, ya validado)
 * @param {number} [opts.factor]
 * @param {number} [opts.percentile]
 * @param {number} [opts.maxEffectiveSeconds] techo anti-realimentación
 * @param {number} [opts.minSamples]
 * @returns {{effectiveSeconds:number, source:string, sampleCount:number,
 *           percentileMs:number|null, peakMs:number|null, derivedSeconds:number|null}}
 */
function computeEffectiveThreshold(opts = {}) {
  // Un piso inválido NO puede degradar a un número chico: eso mataría antes y
  // habilitaría restart-storms (dirección destructiva, SEC-3). Cae al default
  // del módulo de liveness, que es el mismo piso que usaría el watchdog.
  const floorSeconds = parsePositiveInt(opts.floorSeconds, DEFAULT_KILL_SECONDS);
  const factor = parseFactor(opts.factor, DEFAULT_FACTOR);
  const pct = parsePercent(opts.percentile, DEFAULT_PERCENTILE);
  const maxEffective = parsePositiveInt(opts.maxEffectiveSeconds, DEFAULT_MAX_EFFECTIVE_SECONDS);
  const minSamples = parsePositiveInt(opts.minSamples, DEFAULT_MIN_SAMPLES);

  const values = Array.isArray(opts.samples)
    ? opts.samples.filter((v) => Number.isFinite(v) && v >= 0)
    : [];
  const sampleCount = values.length;
  const peakMs = sampleCount > 0 ? Math.max(...values) : null;

  if (sampleCount < minSamples) {
    // Evidencia insuficiente (decisión 3): el percentil degeneraría en "el
    // máximo". Nos quedamos en el piso — nunca se afloja el umbral a ciegas.
    return {
      effectiveSeconds: floorSeconds,
      source: 'floor-insufficient-samples',
      sampleCount,
      percentileMs: null,
      peakMs,
      derivedSeconds: null,
    };
  }

  const percentileMs = percentile(values, pct);
  const derivedSeconds = Math.ceil((percentileMs * factor) / 1000);

  // El PISO gana siempre (CA-3): un percentil bajo no puede aflojar el umbral
  // por debajo de lo que el operador declaró en config.yaml.
  let effectiveSeconds = Math.max(floorSeconds, derivedSeconds);
  let source = effectiveSeconds === floorSeconds ? 'floor' : 'percentile';

  if (effectiveSeconds > maxEffective) {
    // Techo anti-realimentación. Ojo al `Math.max` con el piso: si el operador
    // configuró un piso MAYOR al techo, manda el piso — el techo nunca puede
    // producir un umbral por debajo del piso (invariante CA-3).
    effectiveSeconds = Math.max(floorSeconds, maxEffective);
    source = effectiveSeconds === floorSeconds ? 'floor' : 'cap';
  }

  return { effectiveSeconds, source, sampleCount, percentileMs, peakMs, derivedSeconds };
}

// -----------------------------------------------------------------------------
// Margen (CA-5)
// -----------------------------------------------------------------------------

/**
 * Evalúa cuánto del umbral efectivo se está comiendo el pico observado.
 * Función PURA.
 *
 * @param {object} opts
 * @param {number|null} opts.peakMs           pico de la ventana en ms
 * @param {number} opts.effectiveSeconds      umbral efectivo vigente
 * @param {number} [opts.alertPct]            % consumido a partir del cual alertar
 * @returns {{consumedPct:number|null, marginPct:number|null,
 *           marginSeconds:number|null, degraded:boolean, peakSeconds:number|null}}
 */
function evaluateMargin(opts = {}) {
  const effectiveSeconds = parsePositiveInt(opts.effectiveSeconds, 0);
  const alertPct = parsePercent(opts.alertPct, DEFAULT_ALERT_MARGIN_PCT);
  const peakMs = opts.peakMs;

  if (!Number.isFinite(peakMs) || peakMs < 0 || effectiveSeconds < 1) {
    // Sin pico observable no hay margen que evaluar. NO es una condición de
    // alerta: la ausencia de datos nunca debe disfrazarse de degradación.
    return {
      consumedPct: null,
      marginPct: null,
      marginSeconds: null,
      degraded: false,
      peakSeconds: null,
    };
  }

  const effectiveMs = effectiveSeconds * 1000;
  const consumedPct = Math.round((peakMs / effectiveMs) * 100);
  return {
    consumedPct,
    marginPct: 100 - consumedPct,
    marginSeconds: Math.round((effectiveMs - peakMs) / 1000),
    degraded: consumedPct >= alertPct,
    peakSeconds: Math.round(peakMs / 1000),
  };
}

/**
 * ¿Venció el cooldown de la alerta de margen? (CA-6)
 * Fail-closed hacia el silencio: un `lastAlertTs` corrupto (futuro, no finito)
 * NO habilita un envío — preferimos perder una alerta antes que spamear 77
 * mensajes idénticos, que es el fallo que este issue viene a evitar.
 */
function shouldAlert(lastAlertTs, now, cooldownMinutes = DEFAULT_ALERT_COOLDOWN_MINUTES) {
  const cooldownMs = parsePositiveInt(cooldownMinutes, DEFAULT_ALERT_COOLDOWN_MINUTES) * 60 * 1000;
  if (!Number.isFinite(now)) return false;
  if (!Number.isFinite(lastAlertTs) || lastAlertTs <= 0) return true; // nunca se alertó
  if (lastAlertTs > now) return false; // reloj corrido / estado corrupto => callar
  return now - lastAlertTs >= cooldownMs;
}

// -----------------------------------------------------------------------------
// Freno anti-bucle (CA-7)
// -----------------------------------------------------------------------------

/**
 * ¿Se puede matar, o ya hubo demasiados kills en la ventana? Función PURA.
 *
 * En el incidente hubo 77 kills en 3 horas. Sea cual sea el umbral, esa cadencia
 * tiene que escalar a needs-human en vez de repetirse: si matar 3 veces no
 * arregló nada, la 4ta tampoco lo va a hacer y el problema es otro.
 *
 * @param {object} opts
 * @param {number[]} opts.kills          timestamps de kills previos
 * @param {number} opts.now
 * @param {number} [opts.maxKills]
 * @param {number} [opts.windowMinutes]
 * @returns {{action:'allow'|'escalate', killsInWindow:number, maxKills:number}}
 */
function decideKillStreak(opts = {}) {
  const maxKills = parsePositiveInt(opts.maxKills, DEFAULT_MAX_KILLS);
  const windowMinutes = parsePositiveInt(opts.windowMinutes, DEFAULT_KILL_WINDOW_MINUTES);
  const now = Number.isFinite(opts.now) ? opts.now : 0;
  const windowMs = windowMinutes * 60 * 1000;

  const kills = Array.isArray(opts.kills) ? opts.kills.filter((t) => Number.isFinite(t) && t > 0) : [];
  const recent = kills.filter((t) => now - t < windowMs);

  if (recent.length >= maxKills) {
    return { action: 'escalate', killsInWindow: recent.length, maxKills };
  }
  return { action: 'allow', killsInWindow: recent.length, maxKills };
}

module.exports = {
  parseFactor,
  parsePercent,
  percentile,
  normalizeState,
  loadState,
  saveStateAtomic,
  appendSample,
  recordKill,
  markAlert,
  bumpAlertRepeats,
  markEscalation,
  computeEffectiveThreshold,
  evaluateMargin,
  shouldAlert,
  decideKillStreak,
  DEFAULT_PERCENTILE,
  DEFAULT_FACTOR,
  DEFAULT_MAX_EFFECTIVE_SECONDS,
  DEFAULT_MIN_SAMPLES,
  DEFAULT_MAX_SAMPLES,
  DEFAULT_ALERT_MARGIN_PCT,
  DEFAULT_ALERT_COOLDOWN_MINUTES,
  DEFAULT_MAX_KILLS,
  DEFAULT_KILL_WINDOW_MINUTES,
};

#!/usr/bin/env node
// =============================================================================
// pulpo-liveness-run.js — Orquestador del liveness del Pulpo (#4154)
//
// Lo invoca `watchdog.ps1` cuando detecta que el proceso de `pulpo.js` EXISTE
// (el path de proceso ausente ya lo cubre el spawn normal del watchdog).
// PowerShell recolecta los hechos del SO y los pasa por variables de entorno;
// este script toma la decisión (vía lib/pulpo-liveness.js) y devuelve la acción
// por stdout para que PowerShell ejecute `Stop-Process` + respawn cuando
// corresponda.
//
// Por qué la lógica vive en Node y no en PowerShell
// -------------------------------------------------
// `node --test` cubre la decisión (sano / zombi / discrepancia de PID /
// fail-closed). PowerShell queda como capa fina de SO (leer heartbeat,
// consultar el proceso, matar+respawnear). Una sola fuente de verdad, testeada.
//
// Hechos esperados por env (los setea el .ps1):
//   PLV_HB_EXISTS        '1' | '0'   ¿existe last-tick.json?
//   PLV_HB_AGE_MS        edad del heartbeat (mtime) en ms (entero) | '' si no existe
//   PLV_HB_CONTENT       contenido crudo de last-tick.json (para cross-check de pid) | ''
//   PLV_SO_PID           pid del proceso pulpo.js detectado por el scan SO (entero) | ''
//   PLV_PROGRESS_AGE_MS  #5821 CA-4: edad (mtime) de last-progress en ms | '' si no existe
//   PULPO_LIVENESS_KILL_SECONDS  override opcional del PISO del umbral (entero positivo)
//
// Salida stdout (una línea, la lee PowerShell):
//   ACTION:kill-respawn | ACTION:skip | ACTION:escalate
//   (la discrepancia de PID se loguea pero se mapea a skip: nunca matamos sin
//    cross-check; `escalate` es #5821 CA-7: cap de kills alcanzado, no se mata más)
//
// Fail-soft: cualquier error interno => ACTION:skip (no inventar kills por un
// bug del orquestador) + log. NUNCA emite secrets ni paths sensibles.
//
// -----------------------------------------------------------------------------
// #5821 — Umbral dimensionado contra la duración real de ciclo
// -----------------------------------------------------------------------------
// Antes, el umbral era un literal elegido a mano después de cada incidente
// (90 → 180 → 270) y nada en el sistema observaba que el margen se estaba
// comiendo antes de romperse. Ahora este runner, en cada ciclo:
//
//   1. registra la duración observada del ciclo en una serie persistida (CA-1),
//   2. deriva el umbral EFECTIVO = max(piso, p99 × factor), con techo (CA-2/3),
//   3. loguea el umbral efectivo y el margen vigente en cada decisión (CA-4),
//   4. alerta al operador cuando el margen cae bajo el % configurado, ANTES del
//      primer kill, con cooldown por ventana (CA-5/6),
//   5. escala a needs-human si la racha de kills alcanza el cap (CA-7).
//
// El runner es EFÍMERO (PowerShell lo lanza cada 2 min), así que la serie y los
// contadores viven en disco, no en memoria de proceso.
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

const PIPELINE_DIR = __dirname;
const LOG_DIR = process.env.PLV_LOG_DIR || path.join(PIPELINE_DIR, 'logs');
const RUN_LOG = path.join(LOG_DIR, 'pulpo-liveness.log');
// #5821 CA-1 — La serie y los contadores viven acá porque el runner es efímero.
// Bajo LOG_DIR (overridable por `PLV_LOG_DIR`) para que los tests herméticos
// arranquen siempre con estado limpio sin tocar el de producción.
const STATE_FILE = process.env.PLV_STATE_FILE || path.join(LOG_DIR, 'pulpo-liveness-state.json');

const liveness = require('./lib/pulpo-liveness');

function log(msg) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const ts = new Date().toISOString();
    fs.appendFileSync(RUN_LOG, `[${ts}] ${msg}\n`);
  } catch (_) {
    /* fail-soft: si no podemos loguear, seguimos */
  }
}

/**
 * Lee el bloque `watchdog:` de config.yaml vía el punto ÚNICO de lectura
 * (#5172: `lib/config-resolver.js`, que parsea, valida contra el schema y lanza
 * errores tipados YA redactados).
 *
 * #5172 · CASO G-3 — por qué el require es LAZY y no está en el tope:
 *   `config-resolver` requiere `js-yaml` y `ajv` en su tope. Este runner corre
 *   en worktrees que PUEDEN no tener `node_modules`; un require en el tope del
 *   archivo mataría el proceso EN EL IMPORT, antes de llegar a cualquier
 *   política, y el fallo sería MUDO (el .ps1 se quedaría sin línea ACTION). Por
 *   eso se requiere dentro del `try` y `MODULE_NOT_FOUND` es fail-soft.
 *
 * #5172 · La degradación a defaults se LOGUEA siempre (nunca es silenciosa):
 *   el propósito del issue es matar el `catch {}` mudo que convertía
 *   "no pude leer la config" en "el umbral es el default" sin dejar traza.
 *
 * #5172 · `pipelineDir` va EXPLÍCITO: este runner fija su raíz a `__dirname` y
 *   no usa env vars. Si dependiera de la cadena de env del resolver, heredar
 *   `PIPELINE_REPO_ROOT` del entorno del pulpo le movería la raíz del worktree
 *   al repo principal, en silencio.
 */
function loadWatchdogConfig() {
  try {
    // eslint-disable-next-line global-require
    const configResolver = require('./lib/config-resolver');
    const cfg = configResolver.resolve({ pipelineDir: PIPELINE_DIR });
    if (cfg && typeof cfg === 'object' && cfg.watchdog && typeof cfg.watchdog === 'object') {
      return cfg.watchdog;
    }
    // #5172 / D-4: sección `watchdog:` ausente NO es corrupción; default seguro.
    log('config.yaml sin sección `watchdog:` — se usan los defaults del liveness');
  } catch (err) {
    // #5172 (rebote rev-1) — La discriminación es por `isConfigViolation(err)`,
    // NO por `err.code === 'MODULE_NOT_FOUND'` vs "todo lo demás": sólo el error
    // tipado del resolver identifica corrupción de config; cualquier otro fallo
    // (incluido un bug del resolver) NO debe hacerse pasar por corrupción.
    if (isConfigViolation(err)) {
      // FAIL-CLOSED: config corrupta. NO se degrada a los defaults del liveness.
      // Motivo: si el archivo es ilegible NO SABEMOS qué umbral declaró el
      // operador, y el default del módulo puede ser más chico que ese valor
      // (nada impide configurar un umbral holgado para una ola pesada). Aplicar
      // el default sería degradar en dirección DESTRUCTIVA — mata antes de
      // tiempo y habilita restart-storms (SEC-3), que es exactamente el bucle de
      // muerte medido en el incidente del 2026-08-11 (#5820: 77 kills en ~3h
      // sobre un Pulpo sano, con el Commander caído 4h de arrastre).
      // Se propaga un sentinel y el caller emite ACTION:skip: nunca se mata con
      // un umbral que no podemos confirmar.
      // SEC-1: el error tipado ya viene redactado ({archivo, causa, linea,
      // columna}); NUNCA se loguea el `.message` crudo de js-yaml.
      log(
        `FAIL-CLOSED: config.yaml ilegible o inválido (causa=${(err && err.causa) || 'desconocida'}` +
          `${err && err.linea != null ? `, linea=${err.linea}` : ''}` +
          `${err && err.columna != null ? `, columna=${err.columna}` : ''}) — ` +
          'NO se aplican los defaults del liveness y NO se mata al Pulpo ' +
          '(sin config legible no se puede confirmar el umbral que declaró el operador; ' +
          'aplicar el default podría matar antes de tiempo). ' +
          'Arreglá config.yaml o fijá PULPO_LIVENESS_KILL_SECONDS para reactivar el liveness'
      );
      return { __configViolation: true };
    }
    if (err && err.code === 'MODULE_NOT_FOUND') {
      // G-3: worktree sin node_modules. FAIL-SOFT a defaults, porque acá NO hay
      // evidencia de que la config sea distinta del default: el módulo lector
      // sencillamente no está. Degradación EXPLÍCITA, no silenciosa.
      log(
        'DEGRADACION: config-resolver no cargable (worktree sin node_modules o módulo ausente) — ' +
          'se usan los defaults del liveness; el umbral de config.yaml NO se aplicó'
      );
    } else {
      log(
        `DEGRADACION: error inesperado leyendo la configuración (${(err && err.name) || 'Error'}) — ` +
          'se usan los defaults del liveness'
      );
    }
  }
  return {};
}

/**
 * #5172 (rebote rev-1) — `isConfigViolation` vive en `config-resolver`, que
 * puede no ser cargable (G-3: worktree sin node_modules). Si no carga, ningún
 * error puede ser una violación tipada de config ⇒ `false`. Nunca lanza.
 */
function isConfigViolation(err) {
  try {
    // eslint-disable-next-line global-require
    return require('./lib/config-resolver').isConfigViolation(err);
  } catch (_) {
    return false;
  }
}

/**
 * #5172 (rebote rev-1) — ¿el operador fijó un umbral explícito y VÁLIDO por env?
 * Sólo un entero positivo cuenta: un env presente pero basura ('', 'abc', '0')
 * no es un umbral confiable y, con la config corrupta, debe caer al fail-closed
 * en vez de rescatar el default destructivo.
 */
function hasExplicitKillSecondsOverride() {
  const raw = process.env.PULPO_LIVENESS_KILL_SECONDS;
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) return false;
  return parseInt(trimmed, 10) >= 1;
}

/**
 * #5821 — Carga LAZY y FAIL-SOFT del módulo de margen.
 *
 * Mismo motivo que el require lazy de `config-resolver` (#5172 · CASO G-3): este
 * runner corre en contextos donde `lib/` puede estar incompleto (worktrees,
 * harness de tests que replica el pipeline con shims). Un require en el tope
 * mataría el proceso EN EL IMPORT y el fallo sería MUDO — el .ps1 se quedaría
 * sin línea ACTION.
 *
 * Si no carga, se degrada al comportamiento pre-#5821: umbral = piso, sin serie,
 * sin alerta y sin cap. Esa degradación es SEGURA en ambas direcciones (el piso
 * es el umbral que el operador declaró) y queda logueada, nunca silenciosa.
 *
 * @returns {object|null}
 */
function loadMarginModule() {
  try {
    // eslint-disable-next-line global-require
    return require('./lib/pulpo-liveness-margin');
  } catch (err) {
    log(
      `DEGRADACION: lib/pulpo-liveness-margin no cargable (${(err && err.code) || (err && err.name) || 'Error'}) — ` +
        'umbral = piso configurado, sin serie ni alerta de margen ni cap de kills'
    );
    return null;
  }
}

/**
 * Encola una alerta operativa a Telegram. Fail-soft: un fallo del canal jamás
 * cambia la decisión del watchdog.
 *
 * Glifos (guideline UX del issue): el nivel elige el glifo vía el léxico ya
 * vigente de `lib/notify-telegram.js` — `warn` ⇒ ⚠️ "anomalía notificada, el
 * pipeline sigue" (alerta de margen), `error` ⇒ 🚨 "algo quedó frenado"
 * (escalada a needs-human). Son dos mensajes DISTINTOS, no uno parametrizado:
 * si abrieran con el mismo glifo se leerían idénticos en la lista de chats y se
 * perdería la distinción que el CA acaba de construir.
 */
function notify(level, message, action, context) {
  try {
    // eslint-disable-next-line global-require
    const { notifyTelegram } = require('./lib/notify-telegram');
    notifyTelegram({ level, component: 'pulpo-liveness', message, action, context });
  } catch (err) {
    log(`WARN no se pudo encolar alerta Telegram: ${err && err.message}`);
  }
}

function envFlag(name) {
  return process.env[name] === '1';
}

function envInt(name) {
  const v = process.env[name];
  if (v == null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * #5821 — Valida un entero positivo de config y LOGUEA cuándo cayó al default.
 *
 * La sección `watchdog:` del schema es `additionalProperties: true` (lenient),
 * así que agregar claves nuevas no rompe la validación ajv... pero un TYPO en
 * una clave nueva tampoco: pasa silencioso y degrada al default sin avisar.
 * Este helper es el que hace ruidosa esa degradación, igual que ya hace
 * `loadWatchdogConfig()` con la config entera.
 *
 * Sólo se loguea cuando el valor estaba PRESENTE y era inválido: la ausencia es
 * el caso normal (todavía no está en config.yaml) y loguearla sería ruido.
 */
function supervisorInt(raw, fallback, keyName) {
  let parsed;
  try {
    // eslint-disable-next-line global-require
    parsed = require('./lib/watchdog-supervisor').parsePositiveInt(raw, fallback);
  } catch (_) {
    // Módulo no cargable (worktree sin lib completo): el default es seguro.
    return fallback;
  }
  if (raw != null && raw !== '' && parsed !== raw && String(raw) !== String(parsed)) {
    log(
      `DEGRADACION: watchdog.${keyName}='${raw}' no es un entero positivo válido — ` +
        `se usa el default ${fallback}`
    );
  }
  return parsed;
}

/**
 * #5821 (rebote rev-1) — MODO CONFIRMACIÓN: registrar un kill que el SO YA
 * confirmó.
 *
 * POR QUÉ EL CAP NO PUEDE CONTAR INTENTOS
 * ---------------------------------------
 * El cap de reinicios existe para cortar un bucle de kills INÚTILES. Si contara
 * intentos en vez de terminaciones efectivas, se volvería en contra justo en el
 * caso que viene a proteger: cuando `Stop-Process` FALLA, el Pulpo sigue
 * colgado, pero el intento igual consume una posición del cap.
 *
 * Y ese fallo no es hipotético en este host: `Stop-Process`/`taskkill` devuelven
 * "Acceso denegado" de forma recurrente (por eso el runbook usa
 * `wmic call terminate`). Con el conteo por intento, 3 ciclos de Acceso denegado
 * (6 minutos) agotaban el cap, el runner escalaba, y `watchdog.ps1` dejaba de
 * intentar SIQUIERA MATAR al zombi hasta que drenara la ventana de 60 min —
 * peor que antes del cambio, que reintentaba cada 2 min para siempre. Una
 * regresión de disponibilidad en el escenario exacto que el issue protege.
 *
 * Por eso el kill se contabiliza acá, en una invocación aparte que `watchdog.ps1`
 * hace SÓLO después de que `Stop-Process` retornó sin excepción. Un kill que no
 * ocurrió no consume cap.
 *
 * Fail-soft: cualquier error se loguea y sale 0 — nunca debe romper el respawn
 * que el `.ps1` está por hacer a continuación.
 */
function confirmKill() {
  try {
    const cfg = loadWatchdogConfig();
    const margin = loadMarginModule();
    if (!margin) {
      log('WARN confirmación de kill sin módulo de margen — no se contabiliza');
      return;
    }
    const windowMinutes = supervisorInt(
      cfg.pulpo_liveness_kill_window_minutes,
      margin.DEFAULT_KILL_WINDOW_MINUTES,
      'pulpo_liveness_kill_window_minutes'
    );
    const now = Date.now();
    const state = margin.loadState(STATE_FILE);
    const next = margin.recordKill(state, now, windowMinutes);
    margin.saveStateAtomic(STATE_FILE, next);
    log(`kill CONFIRMADO por el SO y contabilizado — killsInWindow=${next.kills.length}`);
  } catch (err) {
    log(`WARN no se pudo contabilizar el kill confirmado: ${err && err.message}`);
  }
}

function main() {
  // #5821 (rebote rev-1) — el `.ps1` llama con este flag DESPUÉS de un
  // `Stop-Process` exitoso. No hay decisión que tomar ni salida `ACTION:`.
  if (process.env.PLV_CONFIRM_KILL === '1' || process.argv.includes('--confirm-kill')) {
    confirmKill();
    return;
  }

  const cfg = loadWatchdogConfig();

  // #5172 (rebote rev-1) — FAIL-CLOSED por config corrupta.
  // El override por env NO viene del archivo corrupto, así que si el operador lo
  // fijó explícitamente se respeta (preserva la precedencia SEC-2). Sin override
  // no hay umbral confiable: se propaga un umbral no finito y `decide()` devuelve
  // 'skip' por su primitiva ya existente ("umbral inválido => no matar").
  // Ojo: `parseKillSeconds` NUNCA devuelve null (un fallback inválido cae al
  // DEFAULT_KILL_SECONDS del módulo), así que no sirve para detectar "el
  // operador fijó el env". Ese chequeo tiene que ser sobre el valor crudo.
  if (cfg.__configViolation && !hasExplicitKillSecondsOverride()) {
    log(
      'ACTION:skip por FAIL-CLOSED de configuración — sin PULPO_LIVENESS_KILL_SECONDS ' +
        'no hay umbral confiable; no se mata al Pulpo hasta que config.yaml sea legible'
    );
    process.stdout.write('ACTION:skip\n');
    return;
  }

  // ---------------------------------------------------------------------------
  // PISO del umbral. Override por env > config > default (SEC-2).
  // #5821: esto ya NO es el umbral final, es el PISO sobre el que se dimensiona.
  // ---------------------------------------------------------------------------
  const floorSeconds = liveness.parseKillSeconds(
    process.env.PULPO_LIVENESS_KILL_SECONDS,
    liveness.parseKillSeconds(cfg.pulpo_liveness_kill_seconds, liveness.DEFAULT_KILL_SECONDS)
  );

  const margin = loadMarginModule();
  const now = Date.now();

  // --- Hechos del SO / heartbeat ---------------------------------------------
  const hbExists = envFlag('PLV_HB_EXISTS');
  const hbAgeMs = envInt('PLV_HB_AGE_MS');
  const hbContent = process.env.PLV_HB_CONTENT || '';
  const hbPidFromContent = liveness.parseHeartbeatPid(hbContent);
  const iterationMs = liveness.parseHeartbeatIterationMs(hbContent);
  const tickId = liveness.parseHeartbeatTickId(hbContent);
  const soPid = envInt('PLV_SO_PID');
  const progressAgeMs = envInt('PLV_PROGRESS_AGE_MS');

  // ---------------------------------------------------------------------------
  // #5821 CA-2 — Umbral EFECTIVO derivado del percentil observado.
  //
  // Si el módulo de margen no cargó, `effectiveSeconds` queda en el piso: el
  // comportamiento pre-#5821, que es exactamente el fallback seguro.
  // ---------------------------------------------------------------------------
  let state = null;
  let threshold = { effectiveSeconds: floorSeconds, source: 'floor-sin-modulo', sampleCount: 0, peakMs: null, percentileMs: null };
  let marginInfo = { consumedPct: null, marginPct: null, marginSeconds: null, degraded: false, peakSeconds: null };
  let params = null;

  if (margin) {
    params = {
      factor: margin.parseFactor(cfg.pulpo_liveness_percentile_factor, margin.DEFAULT_FACTOR),
      percentile: margin.parsePercent(cfg.pulpo_liveness_percentile, margin.DEFAULT_PERCENTILE),
      maxEffectiveSeconds: supervisorInt(cfg.pulpo_liveness_max_effective_seconds, margin.DEFAULT_MAX_EFFECTIVE_SECONDS, 'pulpo_liveness_max_effective_seconds'),
      minSamples: supervisorInt(cfg.pulpo_liveness_min_samples, margin.DEFAULT_MIN_SAMPLES, 'pulpo_liveness_min_samples'),
      maxSamples: supervisorInt(cfg.pulpo_liveness_max_samples, margin.DEFAULT_MAX_SAMPLES, 'pulpo_liveness_max_samples'),
      alertPct: margin.parsePercent(cfg.pulpo_liveness_alert_margin_pct, margin.DEFAULT_ALERT_MARGIN_PCT),
      alertCooldownMinutes: supervisorInt(cfg.pulpo_liveness_alert_cooldown_minutes, margin.DEFAULT_ALERT_COOLDOWN_MINUTES, 'pulpo_liveness_alert_cooldown_minutes'),
      maxKills: supervisorInt(cfg.pulpo_liveness_max_kills, margin.DEFAULT_MAX_KILLS, 'pulpo_liveness_max_kills'),
      killWindowMinutes: supervisorInt(cfg.pulpo_liveness_kill_window_minutes, margin.DEFAULT_KILL_WINDOW_MINUTES, 'pulpo_liveness_kill_window_minutes'),
    };

    state = margin.loadState(STATE_FILE);

    // El umbral se calcula sobre la serie HISTÓRICA, ANTES de incorporar la
    // muestra de este ciclo: si el ciclo actual resulta ser un cuelgue, su
    // duración no debe haber participado de la decisión que lo detecta.
    threshold = margin.computeEffectiveThreshold({
      samples: state.samples.map((s) => s.ms),
      floorSeconds,
      factor: params.factor,
      percentile: params.percentile,
      maxEffectiveSeconds: params.maxEffectiveSeconds,
      minSamples: params.minSamples,
    });

    marginInfo = margin.evaluateMargin({
      peakMs: threshold.peakMs,
      effectiveSeconds: threshold.effectiveSeconds,
      alertPct: params.alertPct,
    });
  }

  const killThresholdMs = threshold.effectiveSeconds * 1000;

  const progressStaleSeconds = supervisorInt(
    cfg.pulpo_liveness_progress_stale_seconds,
    liveness.DEFAULT_PROGRESS_STALE_SECONDS,
    'pulpo_liveness_progress_stale_seconds'
  );
  // El techo del ciclo lento tiene que quedar SIEMPRE por encima del umbral
  // efectivo. Si quedara por debajo o igual, la rama de ciclo lento sería código
  // muerto: matar exige `age > umbral` y tolerar exige `age <= techo`, así que
  // con techo <= umbral no existe ninguna edad que caiga en la ventana. Ese
  // colapso es fácil de provocar sin querer — basta con que el dimensionamiento
  // por percentil llegue al mismo valor que el techo configurado.
  const maxSlowCycleSeconds = Math.max(
    supervisorInt(
      cfg.pulpo_liveness_max_slow_cycle_seconds,
      liveness.DEFAULT_MAX_SLOW_CYCLE_SECONDS,
      'pulpo_liveness_max_slow_cycle_seconds'
    ),
    threshold.effectiveSeconds * 2
  );

  let action = liveness.decide({
    hbExists,
    hbAgeMs,
    hbPidFromContent,
    soPid,
    killThresholdMs,
    progressAgeMs,
    progressThresholdMs: progressStaleSeconds * 1000,
    maxSlowCycleMs: maxSlowCycleSeconds * 1000,
  });

  // ---------------------------------------------------------------------------
  // #5821 CA-7 — Freno anti-bucle. En el incidente hubo 77 kills en 3 horas: si
  // matar N veces en la ventana no arregló nada, la N+1 tampoco lo va a hacer y
  // el problema es otro. Se evalúa ANTES de emitir el kill.
  // ---------------------------------------------------------------------------
  let streak = null;
  if (action === 'kill-respawn' && margin && state) {
    streak = margin.decideKillStreak({
      kills: state.kills,
      now,
      maxKills: params.maxKills,
      windowMinutes: params.killWindowMinutes,
    });
    if (streak.action === 'escalate') {
      action = 'escalate';
    }
  }

  // ---------------------------------------------------------------------------
  // #5821 CA-4 — Cada decisión registra el umbral EFECTIVO usado y el margen
  // vigente, no sólo el literal de config. Sin esto, un incidente futuro vuelve
  // a ser indistinguible de "el Commander no responde".
  // ---------------------------------------------------------------------------
  log(
    `decision=${action} hbExists=${hbExists} hbAgeMs=${hbAgeMs} ` +
      `hbPid=${hbPidFromContent} soPid=${soPid} progressAgeMs=${progressAgeMs} ` +
      `floorSeconds=${floorSeconds} effectiveSeconds=${threshold.effectiveSeconds} ` +
      `thresholdSource=${threshold.source} samples=${threshold.sampleCount} ` +
      `peakSeconds=${marginInfo.peakSeconds} consumedPct=${marginInfo.consumedPct} ` +
      `marginSeconds=${marginInfo.marginSeconds} iterationMs=${iterationMs}` +
      (streak ? ` killsInWindow=${streak.killsInWindow}/${streak.maxKills}` : '')
  );

  // ---------------------------------------------------------------------------
  // #5821 CA-1 — Registrar la muestra de este ciclo.
  //
  // SÓLO se registra `iterationMs` (la duración que el Pulpo mide de su propia
  // iteración). NO se usa `hbAgeMs` como sustituto: es la EDAD del heartbeat en
  // el instante arbitrario del muestreo, no la duración — una muestra sesgada
  // hacia abajo (en la evidencia del incidente el p50 daba justo la mitad del
  // máximo, la firma de una distribución de edad muestreada). Mezclar ambas
  // magnitudes en una sola serie deflactaría el percentil y reproduciría el
  // falso positivo en versión estadística. Sin `iterationMs` no hay serie, la
  // evidencia queda por debajo del N mínimo y el umbral se queda en el piso:
  // exactamente el comportamiento pre-#5821.
  //
  // QUÉ CICLOS NO CALIBRAN LA NORMALIDAD:
  //   - los que terminaron en kill/escalada: anómalos por definición (si
  //     entraran, cada cuelgue subiría el umbral y el watchdog se volvería ciego
  //     solo, en silencio y sin ningún kill que lo delate);
  //   - los de `skip-log-discrepancy`: el pid del heartbeat no cruza con el del
  //     SO, así que no sabemos de QUÉ proceso es ese `iterationMs`. Una muestra
  //     de procedencia dudosa no puede dimensionar el umbral.
  // Los `skip-slow-cycle` SÍ entran: un ciclo genuinamente largo es exactamente
  // la evidencia que este dimensionamiento quiere capturar.
  // ---------------------------------------------------------------------------
  if (margin && state) {
    let next = state;
    const calibrable =
      action !== 'kill-respawn' && action !== 'escalate' && action !== 'skip-log-discrepancy';
    if (calibrable && iterationMs != null) {
      next = margin.appendSample(next, {
        now,
        durationMs: iterationMs,
        tickId,
        maxSamples: params.maxSamples,
        maxEffectiveSeconds: params.maxEffectiveSeconds,
      });
    }

    // --- CA-5 / CA-6: alerta de margen, ANTES del primer kill, 1 por ventana ---
    if (marginInfo.degraded) {
      if (margin.shouldAlert(next.lastAlertTs, now, params.alertCooldownMinutes)) {
        // H-2 (#6146): `repeats` y `lastAlertTs` se capturan ANTES de markAlert,
        // que pisa el primero con 0 y el segundo con `now`. Sin esta captura la
        // línea de persistencia saldría siempre diciendo que la condición
        // arrancó recién.
        const repeats = next.alertRepeats;
        const lastAlertTs = next.lastAlertTs;
        // CA-6a / D-5 / SEC-7 (#6146 rev-3) — GATE DE PERSISTENCIA.
        //
        // `lastAlertTs` es CUÁNDO se avisó, no DESDE CUÁNDO sigue pasando: nunca
        // se resetea al recuperarse la condición, así que por sí solo no es
        // evidencia de nada. Pasarlo crudo hacía que una condición aparecida
        // recién le afirmara al operador "ya te avisé hace 3 días y sigue
        // pasando" — un hecho falso, que es lo que bloqueó la review.
        //
        // Sin observaciones degradadas dentro de la ventana que acaba de cerrar
        // (`repeats === 0`) no hay evidencia de repetición, así que la marca NO
        // se pasa: `null` cae en la rama D-3/SEC-4 que el módulo de copy ya tiene
        // cubierta y la línea se OMITE. Dato ausente > dato falso.
        //
        // Se filtra acá y no en el módulo a propósito (SEC-7): la firma de
        // `buildMarginAlert` no se amplía, así que la contención estructural de
        // CA-2 queda intacta y ningún contador interno cruza el borde del módulo.
        const prevAlertTs = repeats > 0 ? lastAlertTs : null;
        next = margin.markAlert(next, now);
        // CA-12 / SEC-6 (#6146 rev-3): el `try` cubre SÓLO la construcción del
        // texto. Antes envolvía también a la emisión, así que un `require`
        // fallido dejaba al operador sin ningún aviso — y éste es justamente el
        // aviso que anticipa que el vigilante va a reiniciar un Pulpo sano.
        // Ahora un fallo de construcción degrada el texto, no lo silencia.
        let alerta;
        try {
          // eslint-disable-next-line global-require
          const copy = require('./lib/pulpo-liveness-copy');
          alerta = copy.buildMarginAlert({
            marginSeconds: marginInfo.marginSeconds,
            prevAlertTs,
            now,
          });
        } catch (err) {
          // Literal de rescate entregado por `ux` (contrato v3, L-3). Va inline
          // acá y no exportado del módulo de copy porque, si ese módulo no se
          // pudo requerir, un literal suyo tampoco estaría disponible.
          //
          // SEC-6: texto CONSTANTE. Prohibido interpolar `err.message`, el stack
          // o el path — un require fallido trae rutas absolutas del filesystem.
          // El detalle del error queda sólo en el log de acá abajo.
          //
          // "puede reiniciar" (y no "está por") es deliberado: es verdadero en
          // los dos niveles de urgencia, y el camino de error no está en
          // condiciones de saber en cuál de los dos está.
          alerta = {
            urgency: 'desconocida',
            message:
              'El vigilante puede reiniciar el Pulpo aunque está trabajando bien. ' +
              'Si lo reinicia, lo que vas a ver es que el Commander deja de responder.',
            action:
              'Podemos darle más tolerancia al vigilante para que no reinicie el Pulpo ' +
              'por ciclos lentos. Si estás de acuerdo, avisá y el pipeline aplica el cambio.',
            context: {},
          };
          log('WARN copy de la alerta de margen no disponible: ' + (err && err.message));
        }
        // SEC-1 / CA-7 (#6146): el detalle de diagnóstico sale del mensaje al
        // operador y queda ACÁ. Antes de este log, la emisión de la alerta y las
        // repeticiones acumuladas no quedaban registradas en ningún lado: vivían
        // sólo dentro del texto que se mandaba al canal. Este renglón es la única
        // traza forense de "se le avisó al operador N veces".
        // El log NO es superficie del operador, así que acá sí va vocabulario
        // interno. `prevAlertTsEnviado` deja asentado si el gate CA-6a dejó pasar
        // la marca o la omitió: sin ese dato, un aviso sin la línea de
        // persistencia es indistinguible de un bug del módulo de copy.
        log(
          'alerta_margen emitida urgencia=' + alerta.urgency +
            ' repeticionesSilenciadas=' + repeats +
            ' peakSeconds=' + marginInfo.peakSeconds +
            ' effectiveSeconds=' + threshold.effectiveSeconds +
            ' thresholdSource=' + threshold.source +
            ' samples=' + threshold.sampleCount +
            ' marginSeconds=' + marginInfo.marginSeconds +
            ' consumedPct=' + marginInfo.consumedPct +
            ' prevAlertTs=' + (lastAlertTs || 'ninguno') +
            ' prevAlertTsEnviado=' + (prevAlertTs || 'omitido')
        );
        try {
          // CA-12: UNA sola emisión, siempre en `warn`. El fail-soft de emisión
          // se conserva tal cual: un fallo encolando jamás cambia la decisión del
          // watchdog ni tumba el runner (CA-13).
          notify('warn', alerta.message, alerta.action, alerta.context);
        } catch (err) {
          log('WARN aviso de margen no emitido: ' + (err && err.message));
        }
      } else {
        // CA-6: la condición persiste pero el cooldown está vigente. Se acumula
        // la evidencia de que se repitió, para poder decir en la próxima alerta
        // que ya se había avisado, en vez de mandar el mensaje pelado otra vez:
        // 77 mensajes idénticos entrenan al operador a silenciar el canal, que es
        // el fallo que esto quiere evitar. Esta cuenta es la que habilita el gate
        // CA-6a de más arriba, y la que la rama de recuperación de abajo limpia.
        next = margin.bumpAlertRepeats(next);
      }
    } else if (Number.isFinite(marginInfo.peakSeconds) && next.alertRepeats > 0) {
      // CA-6b / D-5b (#6146 rev-3) — la pata que le faltaba al gate de arriba.
      //
      // `alertRepeats` sólo lo bajaba `markAlert`, y todo el bloque de la alerta
      // vive dentro del `if (marginInfo.degraded)`: cuando la condición se
      // recuperaba, nadie tocaba el contador. Sin esta rama el gate es un falso
      // positivo permanente — la evidencia de un episodio viejo sobrevive para
      // siempre y vuelve a habilitar la frase en un episodio nuevo.
      //
      // La guarda del pico NO es cosmética: `evaluateMargin` devuelve
      // `degraded: false` TAMBIÉN cuando no hay pico observable. Una laguna de
      // datos no es una recuperación y no puede borrar la evidencia de un
      // episodio vivo.
      //
      // `lastAlertTs` NO se resetea a propósito: ponerlo en 0 resetea también el
      // cooldown y, con la condición oscilando degradado/sano, se alertaría en
      // cada oscilación — el spam es justo lo que este issue viene a evitar. Se
      // limpia la evidencia, la cadencia queda intacta.
      next = { ...next, alertRepeats: 0 };
    }

    // #5821 (rebote rev-1) — el kill NO se contabiliza acá.
    //
    // Antes se hacía `recordKill` en este punto, o sea ANTES de que el `.ps1`
    // intentara siquiera el `Stop-Process`. Eso contaba INTENTOS, no
    // terminaciones: con `Stop-Process` devolviendo "Acceso denegado" (modo de
    // falla recurrente en este host) 3 ciclos agotaban el cap contra un Pulpo
    // que seguía vivo y colgado, y el watchdog dejaba de intentar matarlo por el
    // resto de la ventana. El conteo vive ahora en `confirmKill()`, que el `.ps1`
    // invoca sólo tras una terminación confirmada por el SO.

    if (action === 'escalate') {
      // Dedup de la escalada: a lo sumo 1 alerta por ventana (mismo criterio
      // que el supervisor del watchdog, #4077).
      const windowMs = params.killWindowMinutes * 60 * 1000;
      if (!next.lastEscalationTs || now - next.lastEscalationTs >= windowMs) {
        next = margin.markEscalation(next, now);
        notify(
          'error',
          `El watchdog ya reinició al Pulpo ${streak.killsInWindow} veces en ${params.killWindowMinutes} min ` +
            'y sigue detectando la condición: cap alcanzado, no se reinicia más',
          'Escalado a needs-human — revisar por qué el Pulpo no cierra su ciclo antes de destrabar el watchdog',
          {
            reinicios_en_ventana: `${streak.killsInWindow}/${streak.maxKills}`,
            umbral_efectivo: `${threshold.effectiveSeconds}s (origen ${threshold.source})`,
            diagnostico: '.pipeline/logs/pulpo-liveness.log',
          }
        );
      } else {
        log('escalada ya alertada dentro de la ventana — no se repite alerta');
      }
    }

    try {
      margin.saveStateAtomic(STATE_FILE, next);
    } catch (err) {
      // Fail-soft: perder la serie sólo devuelve el umbral al piso (dirección
      // segura). Jamás debe cambiar la decisión ya tomada.
      log(`WARN no se pudo persistir el estado de liveness: ${err && err.message}`);
    }
  }

  if (action === 'skip-log-discrepancy') {
    // SEC-1: lag vencido pero el PID del heartbeat no cruza con el del SO.
    // No matamos (evita kill de proceso ajeno por PID reciclado/falsificado).
    log(
      `DISCREPANCIA PID: heartbeat vencido (lag ${hbAgeMs}ms > umbral efectivo ${killThresholdMs}ms) ` +
        `pero hbPid=${hbPidFromContent} != soPid=${soPid}. No se mata.`
    );
    process.stdout.write('ACTION:skip\n');
    return;
  }

  if (action === 'skip-slow-cycle') {
    // #5821 CA-4: el heartbeat venció pero el Pulpo mostró progreso reciente.
    // Es un ciclo lento, no un cuelgue: matar acá es el falso positivo del
    // incidente del 2026-08-11 (77 kills en 3 h sobre un proceso sano).
    log(
      `CICLO LENTO: heartbeat vencido (lag ${hbAgeMs}ms > umbral efectivo ${killThresholdMs}ms) ` +
        `pero hay progreso hace ${progressAgeMs}ms (< ${progressStaleSeconds * 1000}ms). No se mata.`
    );
    process.stdout.write('ACTION:skip\n');
    return;
  }

  // 'kill-respawn', 'escalate' o 'skip' van directo al .ps1.
  process.stdout.write(`ACTION:${action}\n`);
}

try {
  main();
} catch (err) {
  log(`ERROR inesperado en pulpo-liveness-run: ${err && err.message}`);
  // Fail-soft: ante un bug del orquestador, no inventamos kills.
  process.stdout.write('ACTION:skip\n');
}

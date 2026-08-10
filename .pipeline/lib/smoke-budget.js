// smoke-budget.js — presupuesto de tiempo del smoke test y clasificación de su
// resultado (#5725).
//
// PROBLEMA QUE RESUELVE
// --------------------
// Antes, el timeout del runner (`restart.js`, 90s hardcodeado) y las ventanas
// internas del smoke (`smoke-test.js`: 60s livianos + 120s dashboard) eran
// constantes INDEPENDIENTES que nadie mantenía sincronizadas. El runner cortaba
// primero: mataba al smoke con SIGTERM antes de que escribiera su diagnóstico,
// y `restart.js` interpretaba ese `exit -1` como "el pipeline está roto" →
// rollback automático a ciegas. El operador abría `smoke-test.log` y encontraba
// la última línea en "Esperando marker ready de: …", sin ninguna pista.
//
// Este módulo es la ÚNICA fuente de verdad de esos tiempos: el runner deriva su
// ventana de los mismos valores que usa el smoke, así que por construcción no
// puede cortar antes. Si mañana alguien sube la ventana del dashboard, la del
// runner sube sola.
//
// LA FÓRMULA (importante)
// -----------------------
// El peor caso de la espera de markers es `max(light, dash)`, NO `light + dash`.
// `waitForComponentMarkers` (smoke-test.js) NO encadena los dos timeouts en
// serie: descuenta lo ya transcurrido, porque el dashboard viene booteando
// durante la espera de los livianos. Calcularlo como suma sobredimensiona el
// presupuesto sobre una premisa falsa.
//
// A ese `max(...)` hay que sumarle el tramo POSTERIOR a la espera, que también
// corre bajo el timeout del runner y que históricamente nadie contabilizó:
// la sonda HTTP con reintentos y los self-checks de skills determinísticos.

// --- Ventanas de espera de markers ---
const MARKER_LIGHT_TIMEOUT_MS = 60000;   // componentes livianos (ready en ~5-7s)
const MARKER_DASH_TIMEOUT_MS = 120000;   // dashboard: ventana diferenciada (#4520)

// --- Tramo posterior a la espera de markers ---
// Sonda HTTP contra /api/health con reintentos (#4131) + chequeo secundario
// /api/state. `HTTP_RETRY` es el default de los parámetros de
// `checkDashboardHttpWithRetry` (smoke-test.js): la sonda reintenta con estos
// valores porque los lee de acá, así que subirlos acá sube el gasto real y el
// presupuesto a la vez. No redeclararlos allá.
const HTTP_RETRY = { attempts: 5, perAttemptMs: 5000, delayMs: 1500 };
const HTTP_SECONDARY_TIMEOUT_MS = 5000;

// Self-checks de skills determinísticos (tester, build, delivery, linter).
const SELF_CHECK_TIMEOUT_MS = 30000;
// Cantidad de self-checks del peor caso. El conteo REAL vive en
// `SELF_CHECK_SKILLS` (smoke-test.js) y se pasa como `selfCheckCount` cuando se
// conoce; esta constante es el default para los callers que NO pueden importar
// esa lista — en particular `restart.js`, que dimensiona su ventana sin cargar
// el smoke. Para que ese default no se desincronice en silencio,
// `smoke-budget.test.js` assertea SELF_CHECK_SKILLS.length === SELF_CHECK_COUNT:
// sumar un skill sin tocar este número rompe el build, no el gate.
const SELF_CHECK_COUNT = 4;

// Margen para que el watchdog interno alcance a volcar el estado parcial.
const DUMP_GRACE_MS = 5000;
// Margen del watchdog por encima del trabajo real. Sin esto, cuando el tramo
// posterior es 0 (--no-http --no-self-check) el watchdog dispararía en el mismo
// instante en que termina la espera legítima de markers, y un empate haría que
// un FAIL con diagnóstico (exit 1) se reportara como "no completó" (exit 5).
// El watchdog es la última red, no debe robarle el veredicto al camino normal.
const WATCHDOG_MARGIN_MS = 5000;
// Margen del runner POR ENCIMA del presupuesto del smoke. Garantiza que el
// smoke siempre se autolimite antes de que el runner lo mate: en Windows el
// SIGTERM del runner es un TerminateProcess incondicional y el hijo no puede
// interceptarlo, así que la única forma de que deje diagnóstico es que termine
// por decisión propia.
const RUNNER_GRACE_MS = 30000;

// Exit code dedicado: "el smoke no llegó a completar sus chequeos".
// Se distingue de los FAIL con diagnóstico (1..4) justamente para que
// `restart.js` no dispare rollback sin evidencia contra el código.
const EXIT_INCOMPLETE = 5;

// Traducción de los exit codes del smoke a castellano. Un `exit 2` pelado en un
// mensaje de Telegram no le dice nada al operador que lo lee a las 2 AM.
const EXIT_REASONS = {
  0: 'pipeline sano',
  1: 'algún componente no llegó a ready (o su PID murió)',
  2: 'el dashboard no responde en :3200 (/api/health)',
  3: 'falta last-restart.json',
  4: 'falló el self-check de un skill determinístico',
  5: 'el smoke no completó sus chequeos',
};

function describeExitCode(code) {
  return EXIT_REASONS[code] || `código de salida ${code}`;
}

// Ventanas efectivas, con override por entorno (operación manual / tests).
function resolveMarkerTimeouts(env = process.env) {
  const light = parseInt(env.SMOKE_LIGHT_MARKER_TIMEOUT_MS || '', 10);
  const dash = parseInt(env.DASHBOARD_MARKER_TIMEOUT_MS || '', 10);
  return {
    lightTimeoutMs: Number.isFinite(light) && light > 0 ? light : MARKER_LIGHT_TIMEOUT_MS,
    dashTimeoutMs: Number.isFinite(dash) && dash > 0 ? dash : MARKER_DASH_TIMEOUT_MS,
  };
}

// Peor caso de la espera de markers: max, no suma (ver cabecera).
function markerWaitBudgetMs(timeouts = resolveMarkerTimeouts()) {
  const { lightTimeoutMs, dashTimeoutMs } = timeouts;
  return Math.max(lightTimeoutMs, dashTimeoutMs);
}

// Peor caso del tramo posterior a la espera de markers.
//
// `selfCheckCount` permite al caller que SÍ conoce la lista real de skills
// (smoke-test.js pasa `SELF_CHECK_SKILLS.length`) dimensionar sobre el conteo
// efectivo en vez de sobre la constante. Así, sumar un skill agranda el
// presupuesto solo, y el watchdog no corta en medio de self-checks legítimos.
function postWaitBudgetMs({ http = true, selfCheck = true, selfCheckCount } = {}) {
  const n = Number.isFinite(selfCheckCount) && selfCheckCount >= 0
    ? selfCheckCount
    : SELF_CHECK_COUNT;
  let ms = 0;
  if (http) {
    ms += HTTP_RETRY.attempts * HTTP_RETRY.perAttemptMs
      + (HTTP_RETRY.attempts - 1) * HTTP_RETRY.delayMs
      + HTTP_SECONDARY_TIMEOUT_MS;
  }
  if (selfCheck) ms += n * SELF_CHECK_TIMEOUT_MS;
  return ms;
}

// Presupuesto propio del smoke: cuánto puede tardar haciendo trabajo real.
// El watchdog interno dispara acá y vuelca el estado parcial.
//
// `lightTimeoutMs`/`dashTimeoutMs` son opcionales y permiten reflejar las
// ventanas EFECTIVAS de esta corrida (p. ej. un `--timeout` explícito del
// operador). Sin esto, un `--timeout 300` haría que el watchdog dispare a los
// 120s en medio de una espera legítima.
//
// `opts` viaja entero a `postWaitBudgetMs`, así que `selfCheckCount` también
// aplica acá (y, por `runnerTimeoutMs`, a la ventana del runner).
function smokeBudgetMs(opts = {}, env = process.env) {
  const override = parseInt(env.SMOKE_SELF_BUDGET_MS || '', 10);
  if (Number.isFinite(override) && override > 0) return override;
  const resueltos = resolveMarkerTimeouts(env);
  return markerWaitBudgetMs({
    lightTimeoutMs: opts.lightTimeoutMs || resueltos.lightTimeoutMs,
    dashTimeoutMs: opts.dashTimeoutMs || resueltos.dashTimeoutMs,
  }) + postWaitBudgetMs(opts) + WATCHDOG_MARGIN_MS;
}

// Ventana del runner: estrictamente mayor que el presupuesto del smoke MÁS el
// tiempo que necesita para volcar. Derivada, no hardcodeada (CA-1).
function runnerTimeoutMs(opts = {}, env = process.env) {
  const override = parseInt(env.SMOKE_RUNNER_TIMEOUT_MS || '', 10);
  if (Number.isFinite(override) && override > 0) return override;
  return smokeBudgetMs(opts, env) + DUMP_GRACE_MS + RUNNER_GRACE_MS;
}

// Clasifica el resultado de spawnSync(smoke-test.js) distinguiendo los dos
// casos que antes colapsaban en `exit -1` (CA-3):
//
//   - FAIL con diagnóstico  → el smoke corrió, chequeó y falló. Hay evidencia
//     de que algo está roto: el rollback está justificado.
//   - NO COMPLETÓ           → el smoke murió (o se autolimitó) sin terminar sus
//     chequeos. No hay evidencia de que el código sea la causa: rollbackear
//     sería destruir un deploy sano por un timeout.
function classifySmokeResult(result) {
  if (!result) {
    return { ok: false, exitCode: -1, incomplete: true, rollbackWarranted: false, reason: 'sin resultado del runner' };
  }

  // spawnSync no pudo siquiera lanzar el proceso (ENOENT, EACCES...). El smoke
  // nunca corrió → ninguna conclusión sobre el código.
  if (result.error && result.status === null && !result.signal) {
    return {
      ok: false, exitCode: -1, incomplete: true, rollbackWarranted: false,
      reason: `no se pudo lanzar el smoke test (${result.error.code || result.error.message})`,
    };
  }

  // Muerte por señal: en Windows es el TerminateProcess del `timeout` de
  // spawnSync. `status` viene en null y la distinción se conserva en `signal`.
  if (result.status === null) {
    const porTimeout = result.error && result.error.code === 'ETIMEDOUT';
    return {
      ok: false, exitCode: -1, incomplete: true, rollbackWarranted: false,
      reason: porTimeout
        ? `el runner lo mató por timeout (signal=${result.signal || 'none'})`
        : `terminado por señal ${result.signal || 'desconocida'}`,
    };
  }

  if (result.status === 0) {
    return { ok: true, exitCode: 0, incomplete: false, rollbackWarranted: false, reason: null };
  }

  // El propio smoke se autolimitó y volcó su estado parcial.
  if (result.status === EXIT_INCOMPLETE) {
    return {
      ok: false, exitCode: EXIT_INCOMPLETE, incomplete: true, rollbackWarranted: false,
      reason: 'el smoke test agotó su ventana y volcó estado parcial sin completar los chequeos',
    };
  }

  return {
    ok: false, exitCode: result.status, incomplete: false, rollbackWarranted: true,
    reason: `${describeExitCode(result.status)} (exit ${result.status})`,
  };
}

module.exports = {
  MARKER_LIGHT_TIMEOUT_MS,
  MARKER_DASH_TIMEOUT_MS,
  HTTP_RETRY,
  HTTP_SECONDARY_TIMEOUT_MS,
  SELF_CHECK_TIMEOUT_MS,
  SELF_CHECK_COUNT,
  DUMP_GRACE_MS,
  WATCHDOG_MARGIN_MS,
  RUNNER_GRACE_MS,
  EXIT_INCOMPLETE,
  EXIT_REASONS,
  describeExitCode,
  resolveMarkerTimeouts,
  markerWaitBudgetMs,
  postWaitBudgetMs,
  smokeBudgetMs,
  runnerTimeoutMs,
  classifySmokeResult,
};

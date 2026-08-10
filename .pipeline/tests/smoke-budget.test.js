// Tests del presupuesto de tiempo del smoke test (#5725).
//
// Lo que se protege acá es la invariante que causó el incidente del 2026-08-09:
// el runner cortaba ANTES que el smoke, lo mataba a mitad del diagnóstico y el
// rollback se disparaba sobre un `exit -1` que no distinguía "roto" de
// "no terminó".

const test = require('node:test');
const assert = require('node:assert');
const budget = require('../lib/smoke-budget');

test('el peor caso de la espera de markers es el máximo, no la suma', () => {
  const timeouts = { lightTimeoutMs: 60000, dashTimeoutMs: 120000 };
  // waitForComponentMarkers descuenta lo transcurrido: el dashboard viene
  // booteando durante la espera de los livianos, no arranca después.
  assert.strictEqual(budget.markerWaitBudgetMs(timeouts), 120000);
  assert.notStrictEqual(budget.markerWaitBudgetMs(timeouts), 180000);
});

test('el peor caso es el máximo aun cuando los livianos tienen la ventana más larga', () => {
  assert.strictEqual(
    budget.markerWaitBudgetMs({ lightTimeoutMs: 200000, dashTimeoutMs: 120000 }),
    200000
  );
});

test('el presupuesto post-wait contabiliza la sonda HTTP y los self-checks', () => {
  const completo = budget.postWaitBudgetMs({ http: true, selfCheck: true });
  const sinNada = budget.postWaitBudgetMs({ http: false, selfCheck: false });
  assert.strictEqual(sinNada, 0);
  // Reintentos HTTP + secundario + 4 self-checks: el tramo que nadie medía.
  assert.ok(completo > budget.SELF_CHECK_COUNT * budget.SELF_CHECK_TIMEOUT_MS);
});

test('INVARIANTE CA-1: la ventana del runner supera el presupuesto del smoke más el volcado', () => {
  const env = {};
  const smoke = budget.smokeBudgetMs({}, env);
  const runner = budget.runnerTimeoutMs({}, env);
  assert.ok(
    runner > smoke + budget.DUMP_GRACE_MS,
    `runner (${runner}ms) debe superar smoke (${smoke}ms) + volcado (${budget.DUMP_GRACE_MS}ms)`
  );
});

test('CA-1: la ventana del runner se deriva — si sube la del dashboard, sube sola', () => {
  const base = budget.runnerTimeoutMs({}, {});
  const conDashboardLento = budget.runnerTimeoutMs({}, { DASHBOARD_MARKER_TIMEOUT_MS: '300000' });
  assert.ok(
    conDashboardLento > base,
    'subir la ventana del dashboard debe arrastrar la del runner (si no, vuelve el bug)'
  );
  // Y la invariante se sigue cumpliendo con el valor nuevo.
  const smoke = budget.smokeBudgetMs({}, { DASHBOARD_MARKER_TIMEOUT_MS: '300000' });
  assert.ok(conDashboardLento > smoke + budget.DUMP_GRACE_MS);
});

test('el 90s hardcodeado que causó el incidente ya no alcanzaría: la ventana derivada es mayor', () => {
  assert.ok(
    budget.runnerTimeoutMs({}, {}) > 90000,
    'la ventana derivada tiene que superar el viejo 90000 que mataba al smoke'
  );
});

test('smokeBudgetMs refleja el --timeout efectivo del operador', () => {
  const conTimeoutLargo = budget.smokeBudgetMs({ lightTimeoutMs: 300000, http: false, selfCheck: false }, {});
  assert.strictEqual(conTimeoutLargo, 300000 + budget.WATCHDOG_MARGIN_MS);
});

test('el watchdog no le roba el veredicto al camino normal: dispara DESPUÉS del trabajo real', () => {
  // Caso límite: sin sonda HTTP ni self-checks el tramo posterior es 0, así que
  // sin margen el watchdog empataría con el fin de la espera de markers y un
  // FAIL con diagnóstico (exit 1) se reportaría como "no completó" (exit 5).
  const opts = { lightTimeoutMs: 2000, dashTimeoutMs: 2000, http: false, selfCheck: false };
  const trabajoReal = budget.markerWaitBudgetMs(opts) + budget.postWaitBudgetMs(opts);
  assert.ok(
    budget.smokeBudgetMs(opts, {}) > trabajoReal,
    'el watchdog tiene que ser la última red, no el camino habitual'
  );
});

test('SMOKE_SELF_BUDGET_MS permite acotar el presupuesto propio del smoke', () => {
  assert.strictEqual(budget.smokeBudgetMs({}, { SMOKE_SELF_BUDGET_MS: '3000' }), 3000);
});

test('SMOKE_RUNNER_TIMEOUT_MS permite forzar la ventana del runner', () => {
  assert.strictEqual(budget.runnerTimeoutMs({}, { SMOKE_RUNNER_TIMEOUT_MS: '7000' }), 7000);
});

// --- CA-3: clasificación del resultado ---

test('CA-3: exit 0 es pipeline sano', () => {
  const c = budget.classifySmokeResult({ status: 0, signal: null });
  assert.strictEqual(c.ok, true);
  assert.strictEqual(c.incomplete, false);
  assert.strictEqual(c.rollbackWarranted, false);
});

test('CA-3: muerte por timeout del runner es NO COMPLETÓ, no dispara rollback', () => {
  // Forma exacta que devuelve spawnSync en Windows al vencer el timeout,
  // verificada empíricamente: status null + signal SIGTERM + ETIMEDOUT.
  const c = budget.classifySmokeResult({
    status: null,
    signal: 'SIGTERM',
    error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }),
  });
  assert.strictEqual(c.ok, false);
  assert.strictEqual(c.incomplete, true);
  assert.strictEqual(c.rollbackWarranted, false, 'un timeout no es evidencia contra el código');
  assert.match(c.reason, /timeout/i);
});

test('CA-3: muerte por señal sin timeout también es NO COMPLETÓ', () => {
  const c = budget.classifySmokeResult({ status: null, signal: 'SIGKILL' });
  assert.strictEqual(c.incomplete, true);
  assert.strictEqual(c.rollbackWarranted, false);
});

test('CA-3: el exit 5 del watchdog interno es NO COMPLETÓ, no dispara rollback', () => {
  const c = budget.classifySmokeResult({ status: budget.EXIT_INCOMPLETE, signal: null });
  assert.strictEqual(c.incomplete, true);
  assert.strictEqual(c.rollbackWarranted, false);
});

test('CA-3: un FAIL con diagnóstico (exit 1..4) SÍ justifica rollback', () => {
  for (const code of [1, 2, 3, 4]) {
    const c = budget.classifySmokeResult({ status: code, signal: null });
    assert.strictEqual(c.ok, false, `exit ${code} no puede ser ok`);
    assert.strictEqual(c.incomplete, false, `exit ${code} tiene diagnóstico`);
    assert.strictEqual(c.rollbackWarranted, true, `exit ${code} justifica rollback`);
  }
});

test('CA-3: si spawnSync no pudo lanzar el proceso, no hay evidencia contra el código', () => {
  const c = budget.classifySmokeResult({
    status: null,
    signal: null,
    error: Object.assign(new Error('spawnSync ENOENT'), { code: 'ENOENT' }),
  });
  assert.strictEqual(c.incomplete, true);
  assert.strictEqual(c.rollbackWarranted, false);
  assert.match(c.reason, /no se pudo lanzar/i);
});

test('CA-3: un resultado ausente se trata como no-completó, no como falla', () => {
  const c = budget.classifySmokeResult(null);
  assert.strictEqual(c.incomplete, true);
  assert.strictEqual(c.rollbackWarranted, false);
});

test('los exit codes se traducen a castellano para el operador', () => {
  assert.match(budget.describeExitCode(2), /dashboard/i);
  assert.match(budget.describeExitCode(budget.EXIT_INCOMPLETE), /no complet/i);
  // Un código desconocido no rompe el mensaje.
  assert.match(budget.describeExitCode(99), /99/);
});

// ---------------------------------------------------------------------------
// Sincronización presupuesto ↔ gasto real (rebote de `aprobacion`, #5725).
//
// El módulo declara ser "la ÚNICA fuente de verdad de esos tiempos", pero dos
// de sus constantes (HTTP_RETRY, SELF_CHECK_COUNT) no estaban atadas a nada del
// lado del smoke: coincidían por casualidad. Estos tests convierten esa
// coincidencia en invariante — si se desincronizan, rompe el build en vez de
// degradar el gate en silencio.
// ---------------------------------------------------------------------------

const smoke = require('../smoke-test');

test('INVARIANTE: SELF_CHECK_COUNT coincide con la lista real de self-checks', () => {
  // SELF_CHECK_COUNT es el default para los callers que no pueden importar la
  // lista (restart.js dimensiona su ventana sin cargar el smoke). Si alguien
  // suma un skill y no toca la constante, el runner queda corto: este assert
  // es lo que lo frena.
  assert.strictEqual(
    smoke.SELF_CHECK_SKILLS.length,
    budget.SELF_CHECK_COUNT,
    `SELF_CHECK_SKILLS tiene ${smoke.SELF_CHECK_SKILLS.length} skills pero `
    + `SELF_CHECK_COUNT declara ${budget.SELF_CHECK_COUNT}: actualizá la constante `
    + `en lib/smoke-budget.js o el runner dimensionará una ventana corta.`
  );
});

test('el conteo real de self-checks manda sobre la constante', () => {
  const conDefault = budget.postWaitBudgetMs({ http: false, selfCheck: true });
  const conCinco = budget.postWaitBudgetMs({ http: false, selfCheck: true, selfCheckCount: 5 });
  assert.strictEqual(conDefault, budget.SELF_CHECK_COUNT * budget.SELF_CHECK_TIMEOUT_MS);
  assert.strictEqual(conCinco, 5 * budget.SELF_CHECK_TIMEOUT_MS);
  // Sumar un skill agranda el presupuesto en vez de desbordarlo.
  assert.ok(conCinco > conDefault);
});

test('selfCheckCount viaja de smokeBudgetMs a la ventana del runner', () => {
  const env = {};
  const cuatro = budget.runnerTimeoutMs({ selfCheckCount: 4 }, env);
  const seis = budget.runnerTimeoutMs({ selfCheckCount: 6 }, env);
  assert.strictEqual(seis - cuatro, 2 * budget.SELF_CHECK_TIMEOUT_MS);
});

// Peor caso REAL, derivado de las listas y params que el smoke usa de verdad —
// no de las constantes del presupuesto. Es el test que el rechazo pedía: si el
// gasto real supera lo presupuestado, el watchdog corta self-checks legítimos,
// el smoke sale EXIT_INCOMPLETE y restart.js toma la rama `incomplete`, que no
// evalúa, no rollbackea y no mueve pipeline-stable. El gate deja de gatear.
function peorCasoRealMs({ selfCheckCount, lightTimeoutMs, dashTimeoutMs }) {
  const r = budget.HTTP_RETRY;
  const http = r.attempts * r.perAttemptMs
    + (r.attempts - 1) * r.delayMs
    + budget.HTTP_SECONDARY_TIMEOUT_MS;
  return Math.max(lightTimeoutMs, dashTimeoutMs)
    + http
    + selfCheckCount * budget.SELF_CHECK_TIMEOUT_MS;
}

test('INVARIANTE: el peor caso real del smoke entra en su propio presupuesto', () => {
  const { lightTimeoutMs, dashTimeoutMs } = budget.resolveMarkerTimeouts({});
  const selfCheckCount = smoke.SELF_CHECK_SKILLS.length;
  const real = peorCasoRealMs({ selfCheckCount, lightTimeoutMs, dashTimeoutMs });
  const presupuesto = budget.smokeBudgetMs({ selfCheckCount, lightTimeoutMs, dashTimeoutMs }, {});
  assert.ok(
    real <= presupuesto,
    `peor caso real ${real}ms supera el presupuesto ${presupuesto}ms: el watchdog `
    + `cortaría durante chequeos legítimos y el smoke saldría EXIT_INCOMPLETE.`
  );
});

test('INVARIANTE: sumar self-checks no desborda el presupuesto (se ajusta solo)', () => {
  const { lightTimeoutMs, dashTimeoutMs } = budget.resolveMarkerTimeouts({});
  // Antes del fix, 5 skills daban 306s de gasto real contra 281s de presupuesto.
  for (const selfCheckCount of [4, 5, 6, 10]) {
    const real = peorCasoRealMs({ selfCheckCount, lightTimeoutMs, dashTimeoutMs });
    const presupuesto = budget.smokeBudgetMs({ selfCheckCount, lightTimeoutMs, dashTimeoutMs }, {});
    assert.ok(real <= presupuesto, `con ${selfCheckCount} skills: real ${real}ms > presupuesto ${presupuesto}ms`);
  }
});

test('INVARIANTE: el runner sigue cubriendo el peor caso real con cualquier conteo', () => {
  const { lightTimeoutMs, dashTimeoutMs } = budget.resolveMarkerTimeouts({});
  for (const selfCheckCount of [4, 5, 6, 10]) {
    const real = peorCasoRealMs({ selfCheckCount, lightTimeoutMs, dashTimeoutMs });
    const runner = budget.runnerTimeoutMs({ selfCheckCount, lightTimeoutMs, dashTimeoutMs }, {});
    assert.ok(
      runner > real + budget.DUMP_GRACE_MS,
      `con ${selfCheckCount} skills el runner (${runner}ms) no cubre el peor caso real `
      + `(${real}ms) + volcado: mataría al smoke antes del diagnóstico.`
    );
  }
});

// Puerto reservado por convención (discard). Nadie escucha ahí: cada intento
// corta con ECONNREFUSED al instante, así que contar reintentos es barato.
const PUERTO_CERRADO = 9;

// Cuenta los intentos REALES de la sonda interceptando http.get. smoke-test.js
// hace `const http = require('http')` y llama `http.get(...)`, o sea que
// resuelve la propiedad en cada invocación: parchearla acá los captura.
async function contarIntentos(opts) {
  const nodeHttp = require('http');
  const original = nodeHttp.get;
  let intentos = 0;
  nodeHttp.get = (...a) => { intentos++; return original.apply(nodeHttp, a); };
  try {
    await smoke.checkDashboardHttpWithRetry(PUERTO_CERRADO, '/api/health', opts);
  } finally {
    nodeHttp.get = original;
  }
  return intentos;
}

test('la sonda HTTP reintenta la cantidad de veces que dice el presupuesto', async () => {
  // Puerto cerrado → cada intento falla al toque (ECONNREFUSED), así que el
  // test es rápido. Sólo overrideamos `delayMs`; `attempts` y `perAttemptMs`
  // quedan en su default, que es lo que se verifica que salga de HTTP_RETRY.
  const original = { ...budget.HTTP_RETRY };
  const res = await smoke.checkDashboardHttpWithRetry(PUERTO_CERRADO, '/api/health', { delayMs: 1 });
  assert.strictEqual(res.ok, false);

  // Subir el presupuesto sube los reintentos REALES: eso es lo que prueba que
  // la sonda lee de acá y no de literales propios. Con la copia hardcodeada
  // que motivó el rechazo, este assert falla (seguiría en 5).
  budget.HTTP_RETRY.attempts = original.attempts + 2;
  try {
    const intentos = await contarIntentos({ delayMs: 1 });
    assert.strictEqual(intentos, original.attempts + 2);
  } finally {
    Object.assign(budget.HTTP_RETRY, original);
  }
});

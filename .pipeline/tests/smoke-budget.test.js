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

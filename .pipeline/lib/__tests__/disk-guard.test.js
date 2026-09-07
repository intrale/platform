// =============================================================================
// Tests de `lib/disk-guard.js` (#6708).
//
// Qué se cubre y por qué
// ----------------------
//   - Clasificación por umbral: es la decisión de la que cuelga todo lo demás.
//   - Escalera ACUMULATIVA: `red` tiene que hacer también lo de `orange` y lo
//     de `yellow`. Si alguien la convierte en un switch, estos tests fallan.
//   - `unknown`: no medir NO puede habilitar acciones destructivas.
//   - Histéresis del freno: sin ella el despacho oscila tick a tick.
//   - Throttles y alertas: el guardián no puede spamear ni relanzarse encima.
//   - Presupuesto inválido: una config rota cae a defaults, no a un estado
//     intermedio que el operador no escribió.
//
// El módulo es puro salvo medición y persistencia, así que casi todo se testea
// sin tocar disco. Lo que sí toca disco usa un directorio temporal propio.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dg = require('../disk-guard');

const B = dg.normalizeBudget({}); // presupuesto default normalizado

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'disk-guard-test-'));
}

// -----------------------------------------------------------------------------
// Presupuesto
// -----------------------------------------------------------------------------

test('el presupuesto default coincide con la propuesta del issue', () => {
  assert.strictEqual(B.green_gb, 40);
  assert.strictEqual(B.yellow_gb, 25);
  assert.strictEqual(B.orange_gb, 12);
  assert.deepStrictEqual(B.invalid, []);
});

test('los umbrales se leen de config y NO están hardcodeados', () => {
  const b = dg.normalizeBudget({ green_gb: 100, yellow_gb: 60, orange_gb: 30 });
  assert.strictEqual(b.green_gb, 100);
  assert.strictEqual(dg.classify(80, b), dg.LEVELS.YELLOW);
  assert.strictEqual(dg.classify(45, b), dg.LEVELS.ORANGE);
  assert.strictEqual(dg.classify(20, b), dg.LEVELS.RED);
});

test('un valor fuera de rango se clampea y queda registrado en invalid', () => {
  const b = dg.normalizeBudget({ green_gb: 99999 });
  assert.strictEqual(b.green_gb, dg.CLAMPS.green_gb[1]);
  assert.ok(b.invalid.some((m) => m.includes('green_gb')));
});

test('un valor no numérico usa el default y queda registrado', () => {
  const b = dg.normalizeBudget({ orange_gb: 'doce' });
  assert.strictEqual(b.orange_gb, dg.DEFAULT_BUDGET.orange_gb);
  assert.ok(b.invalid.some((m) => m.includes('orange_gb')));
});

test('umbrales no descendientes descartan la TERNA ENTERA, no sólo el ofensor', () => {
  // Corregir un solo campo produciría un presupuesto que el operador no
  // escribió y en el que no puede confiar.
  const b = dg.normalizeBudget({ green_gb: 10, yellow_gb: 25, orange_gb: 40 });
  assert.strictEqual(b.green_gb, 40);
  assert.strictEqual(b.yellow_gb, 25);
  assert.strictEqual(b.orange_gb, 12);
  assert.ok(b.invalid.some((m) => m.includes('no descendientes')));
});

test('normalizeBudget tolera null/undefined/basura sin tirar', () => {
  for (const raw of [null, undefined, 'x', 42, []]) {
    const b = dg.normalizeBudget(raw);
    assert.strictEqual(b.green_gb, 40);
  }
});

// -----------------------------------------------------------------------------
// Clasificación
// -----------------------------------------------------------------------------

test('clasifica cada tramo del presupuesto', () => {
  assert.strictEqual(dg.classify(200, B), dg.LEVELS.GREEN);
  assert.strictEqual(dg.classify(41, B), dg.LEVELS.GREEN);
  assert.strictEqual(dg.classify(32, B), dg.LEVELS.YELLOW);
  assert.strictEqual(dg.classify(19.8, B), dg.LEVELS.ORANGE);
  assert.strictEqual(dg.classify(8, B), dg.LEVELS.RED);
  assert.strictEqual(dg.classify(0, B), dg.LEVELS.RED);
});

test('el umbral exacto pertenece al nivel de ABAJO', () => {
  // El umbral marca el piso del nivel superior: tocarlo ya es estar abajo.
  assert.strictEqual(dg.classify(40, B), dg.LEVELS.YELLOW);
  assert.strictEqual(dg.classify(25, B), dg.LEVELS.ORANGE);
  assert.strictEqual(dg.classify(12, B), dg.LEVELS.RED);
});

test('una medición imposible es unknown, no red', () => {
  // Confundir "no pude medir" con "disco lleno" dispararía la escalera entera
  // por un error de herramienta.
  assert.strictEqual(dg.classify(NaN, B), dg.LEVELS.UNKNOWN);
  assert.strictEqual(dg.classify(null, B), dg.LEVELS.UNKNOWN);
  assert.strictEqual(dg.classify(undefined, B), dg.LEVELS.UNKNOWN);
  assert.strictEqual(dg.classify(-1, B), dg.LEVELS.UNKNOWN);
});

// -----------------------------------------------------------------------------
// Escalera de acciones
// -----------------------------------------------------------------------------

test('verde no habilita ninguna acción', () => {
  assert.deepStrictEqual(dg.actionsFor(dg.LEVELS.GREEN, B), {
    rotateCaches: false, reclaimWorktrees: false, freezeHeavyPhases: false,
  });
});

test('amarillo rota cachés y NADA MÁS (no borra worktrees)', () => {
  assert.deepStrictEqual(dg.actionsFor(dg.LEVELS.YELLOW, B), {
    rotateCaches: true, reclaimWorktrees: false, freezeHeavyPhases: false,
  });
});

test('naranja ACUMULA: rota cachés Y reclama worktrees', () => {
  assert.deepStrictEqual(dg.actionsFor(dg.LEVELS.ORANGE, B), {
    rotateCaches: true, reclaimWorktrees: true, freezeHeavyPhases: false,
  });
});

test('rojo ACUMULA todo: rota, reclama Y frena fases pesadas', () => {
  assert.deepStrictEqual(dg.actionsFor(dg.LEVELS.RED, B), {
    rotateCaches: true, reclaimWorktrees: true, freezeHeavyPhases: true,
  });
});

test('unknown no habilita ninguna acción destructiva (guardián ciego no borra)', () => {
  assert.deepStrictEqual(dg.actionsFor(dg.LEVELS.UNKNOWN, B), {
    rotateCaches: false, reclaimWorktrees: false, freezeHeavyPhases: false,
  });
});

test('freeze_heavy_phases:false es kill-switch del freno pero no de la limpieza', () => {
  const b = dg.normalizeBudget({ freeze_heavy_phases: false });
  const a = dg.actionsFor(dg.LEVELS.RED, b);
  assert.strictEqual(a.freezeHeavyPhases, false);
  assert.strictEqual(a.rotateCaches, true);
  assert.strictEqual(a.reclaimWorktrees, true);
});

// -----------------------------------------------------------------------------
// decide(): escenarios Gherkin del issue
// -----------------------------------------------------------------------------

const NOW = 1_800_000_000_000;
const HORA = 60 * 60 * 1000;

test('Gherkin: con 32 GB libres se rotan cachés y NO se borra ningún worktree', () => {
  const d = dg.decide({ freeGb: 32, budget: B, state: dg.emptyState(), now: NOW });
  assert.strictEqual(d.level, dg.LEVELS.YELLOW);
  assert.strictEqual(d.run.rotateCaches, true);
  assert.strictEqual(d.run.reclaimWorktrees, false);
  assert.strictEqual(d.frozen, false);
});

test('Gherkin: con 8 GB libres se rota, se reclama sin cap, se frena y se alerta', () => {
  const d = dg.decide({ freeGb: 8, budget: B, state: dg.emptyState(), now: NOW });
  assert.strictEqual(d.level, dg.LEVELS.RED);
  assert.strictEqual(d.run.rotateCaches, true);
  assert.strictEqual(d.run.reclaimWorktrees, true);
  assert.strictEqual(d.frozen, true);
  assert.strictEqual(d.alert.should, true);
  assert.strictEqual(d.alert.reason, 'escalada');
});

test('al cruzar naranja se alerta', () => {
  const prev = Object.assign(dg.emptyState(), { level: dg.LEVELS.YELLOW });
  const d = dg.decide({ freeGb: 19.8, budget: B, state: prev, now: NOW });
  assert.strictEqual(d.level, dg.LEVELS.ORANGE);
  assert.strictEqual(d.alert.should, true);
  assert.strictEqual(d.alert.reason, 'escalada');
});

test('mejorar de rojo a naranja NO vuelve a alertar por escalada', () => {
  const prev = Object.assign(dg.emptyState(), { level: dg.LEVELS.RED, last_alert_at: NOW });
  const d = dg.decide({ freeGb: 19.8, budget: B, state: prev, now: NOW + 60_000 });
  assert.strictEqual(d.level, dg.LEVELS.ORANGE);
  assert.strictEqual(d.alert.should, false);
});

test('un umbral que persiste re-alerta recién pasado el cooldown', () => {
  const prev = Object.assign(dg.emptyState(), { level: dg.LEVELS.RED, last_alert_at: NOW });
  const antes = dg.decide({ freeGb: 8, budget: B, state: prev, now: NOW + HORA });
  assert.strictEqual(antes.alert.should, false, 'a la hora todavía no (cooldown 120 min)');
  const despues = dg.decide({ freeGb: 8, budget: B, state: prev, now: NOW + 3 * HORA });
  assert.strictEqual(despues.alert.should, true);
  assert.strictEqual(despues.alert.reason, 'persistencia');
});

test('una liberación grande alerta aunque el umbral ya no esté cruzado', () => {
  // "Sin borrado silencioso de cosas grandes."
  const prev = Object.assign(dg.emptyState(), { level: dg.LEVELS.GREEN });
  const d = dg.decide({ freeGb: 80, budget: B, state: prev, now: NOW, freedGbThisRun: 12 });
  assert.strictEqual(d.level, dg.LEVELS.GREEN);
  assert.strictEqual(d.alert.should, true);
  assert.strictEqual(d.alert.reason, 'liberacion-grande');
});

test('una liberación chica NO alerta', () => {
  const d = dg.decide({ freeGb: 80, budget: B, state: dg.emptyState(), now: NOW, freedGbThisRun: 0.5 });
  assert.strictEqual(d.alert.should, false);
});

// -----------------------------------------------------------------------------
// Throttles y re-entrada
// -----------------------------------------------------------------------------

test('el throttle impide relanzar la rotación dentro de la ventana', () => {
  const prev = Object.assign(dg.emptyState(), { last_rotate_at: NOW });
  const pronto = dg.decide({ freeGb: 32, budget: B, state: prev, now: NOW + 10 * 60 * 1000 });
  assert.strictEqual(pronto.actions.rotateCaches, true, 'el nivel la habilita...');
  assert.strictEqual(pronto.run.rotateCaches, false, '...pero el throttle la frena');
  const tarde = dg.decide({ freeGb: 32, budget: B, state: prev, now: NOW + HORA + 1000 });
  assert.strictEqual(tarde.run.rotateCaches, true);
});

test('el throttle de reclamación es independiente del de rotación', () => {
  const prev = Object.assign(dg.emptyState(), { last_rotate_at: NOW, last_reclaim_at: 0 });
  const d = dg.decide({ freeGb: 19.8, budget: B, state: prev, now: NOW + 10 * 60 * 1000 });
  assert.strictEqual(d.run.rotateCaches, false);
  assert.strictEqual(d.run.reclaimWorktrees, true);
});

test('el estado siguiente sólo avanza el throttle de lo que efectivamente corrió', () => {
  const prev = Object.assign(dg.emptyState(), { last_rotate_at: 0, last_reclaim_at: NOW });
  const d = dg.decide({ freeGb: 19.8, budget: B, state: prev, now: NOW + 60_000 });
  assert.strictEqual(d.nextState.last_rotate_at, NOW + 60_000);
  assert.strictEqual(d.nextState.last_reclaim_at, NOW, 'no corrió: no se toca');
});

// -----------------------------------------------------------------------------
// Histéresis del freno
// -----------------------------------------------------------------------------

test('el freno NO se levanta apenas se supera el umbral naranja', () => {
  // Sin histéresis, un disco oscilando alrededor de 12 GB prendería y apagaría
  // el freno en ticks consecutivos y el despacho quedaría intermitente.
  const prev = Object.assign(dg.emptyState(), { level: dg.LEVELS.RED, frozen: true });
  const d = dg.decide({ freeGb: 12.5, budget: B, state: prev, now: NOW });
  assert.strictEqual(d.level, dg.LEVELS.ORANGE);
  assert.strictEqual(d.frozen, true, 'sigue frenado: 12.5 < 12 + 2 de histéresis');
});

test('el freno se levanta al recuperar el margen de histéresis completo', () => {
  const prev = Object.assign(dg.emptyState(), { level: dg.LEVELS.RED, frozen: true });
  const d = dg.decide({ freeGb: 14, budget: B, state: prev, now: NOW });
  assert.strictEqual(d.frozen, false);
});

test('sin medición se CONSERVA el estado del freno, no se congela ni descongela a ciegas', () => {
  const frenado = Object.assign(dg.emptyState(), { level: dg.LEVELS.RED, frozen: true });
  assert.strictEqual(dg.decide({ freeGb: NaN, budget: B, state: frenado, now: NOW }).frozen, true);
  const libre = Object.assign(dg.emptyState(), { level: dg.LEVELS.GREEN, frozen: false });
  assert.strictEqual(dg.decide({ freeGb: NaN, budget: B, state: libre, now: NOW }).frozen, false);
});

test('sin medición se conserva la última lectura buena en vez de pisarla con null', () => {
  const prev = Object.assign(dg.emptyState(), { free_gb: 19.8, measured_at: '2026-08-28T00:00:00.000Z' });
  const d = dg.decide({ freeGb: NaN, budget: B, state: prev, now: NOW });
  assert.strictEqual(d.nextState.free_gb, 19.8);
  assert.strictEqual(d.nextState.measured_at, '2026-08-28T00:00:00.000Z');
});

// -----------------------------------------------------------------------------
// Gate de despacho
// -----------------------------------------------------------------------------

test('en rojo se frenan build y verificacion, y sólo esas', () => {
  const state = Object.assign(dg.emptyState(), { level: dg.LEVELS.RED, frozen: true });
  assert.strictEqual(dg.isHeavyPhaseFrozen('build', 'build', { state }), true);
  assert.strictEqual(dg.isHeavyPhaseFrozen('verificacion', 'qa', { state }), true);
  assert.strictEqual(dg.isHeavyPhaseFrozen('dev', 'pipeline-dev', { state }), false);
  assert.strictEqual(dg.isHeavyPhaseFrozen('aprobacion', 'review', { state }), false);
  assert.strictEqual(dg.isHeavyPhaseFrozen('entrega', 'delivery', { state }), false);
});

test('sin freno activo no se bloquea ninguna fase', () => {
  const state = Object.assign(dg.emptyState(), { level: dg.LEVELS.ORANGE, frozen: false });
  assert.strictEqual(dg.isHeavyPhaseFrozen('build', 'build', { state }), false);
});

test('el gate es FAIL-OPEN ante cualquier basura de entrada', () => {
  // Un bug acá no puede dejar el pipeline sin despachar.
  assert.strictEqual(dg.isHeavyPhaseFrozen('build', 'build', { state: null, pipelineDir: '/no/existe' }), false);
  assert.strictEqual(dg.isHeavyPhaseFrozen(undefined, undefined, { state: { frozen: true } }), false);
});

// -----------------------------------------------------------------------------
// Persistencia
// -----------------------------------------------------------------------------

test('readState devuelve el estado vacío si el archivo no existe', () => {
  const st = dg.readState({ pipelineDir: path.join(tmpdir(), 'nope') });
  assert.strictEqual(st.level, dg.LEVELS.UNKNOWN);
  assert.strictEqual(st.frozen, false);
});

test('readState devuelve el estado vacío si el archivo está corrupto', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, dg.STATE_FILENAME), '{ no es json');
  const st = dg.readState({ pipelineDir: dir });
  assert.strictEqual(st.level, dg.LEVELS.UNKNOWN);
});

test('write + read hacen round-trip del snapshot', () => {
  const dir = tmpdir();
  const d = dg.decide({ freeGb: 8, budget: B, state: dg.emptyState(), now: NOW });
  assert.strictEqual(dg.writeState(d.nextState, { pipelineDir: dir }), true);
  const st = dg.readState({ pipelineDir: dir });
  assert.strictEqual(st.level, dg.LEVELS.RED);
  assert.strictEqual(st.frozen, true);
  assert.strictEqual(st.free_gb, 8);
});

test('writeState no tira si el destino es inescribible', () => {
  assert.strictEqual(dg.writeState({}, { statePath: ' /invalido' }), false);
});

test('el audit JSONL es append-only y una línea por corrida', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'audit', 'disk-guard.jsonl');
  dg.appendAudit({ accion: 'rotate-caches', liberado_gb: 3.2 }, { auditFile: file });
  dg.appendAudit({ accion: 'reclaim-worktrees', liberado_gb: 11.7 }, { auditFile: file });
  const lineas = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.strictEqual(lineas.length, 2);
  assert.strictEqual(JSON.parse(lineas[0]).accion, 'rotate-caches');
  assert.strictEqual(JSON.parse(lineas[1]).liberado_gb, 11.7);
});

test('appendAudit no tira si el destino es inescribible', () => {
  assert.strictEqual(dg.appendAudit({ x: 1 }, { auditFile: ' /invalido' }), false);
});

// -----------------------------------------------------------------------------
// Medición
// -----------------------------------------------------------------------------

test('parsea el output localizado de fsutil', () => {
  const fake = () => 'Bytes totales disponibles                 :  21,282,664,448 ( 19.8 GB)\nBytes totales                     : 252,841,029,632 (235.5 GB)\n';
  assert.strictEqual(dg.measureFreeBytes({ execImpl: fake }), 21282664448);
  assert.strictEqual(dg.measureTotalBytes({ execImpl: fake }), 252841029632);
});

test('si fsutil falla, cae al fallback de PowerShell', () => {
  let llamadas = 0;
  const fake = (cmd) => {
    llamadas++;
    if (cmd.startsWith('fsutil')) throw new Error('no disponible');
    return '  12345678  \n';
  };
  assert.strictEqual(dg.measureFreeBytes({ execImpl: fake }), 12345678);
  assert.strictEqual(llamadas, 2);
});

test('si no se puede medir devuelve NaN, NUNCA 0', () => {
  // 0 sería indistinguible de un disco realmente lleno.
  const fake = () => { throw new Error('sin herramienta'); };
  assert.ok(Number.isNaN(dg.measureFreeBytes({ execImpl: fake })));
  assert.ok(Number.isNaN(dg.measureFreeGb({ execImpl: fake })));
  assert.ok(Number.isNaN(dg.measureTotalBytes({ execImpl: fake })));
});

test('un output basura de fsutil no se interpreta como 0 bytes libres', () => {
  const fake = () => 'ni idea de que es esto';
  assert.ok(Number.isNaN(dg.measureFreeBytes({ execImpl: fake })));
});

// -----------------------------------------------------------------------------
// Render de la alerta
// -----------------------------------------------------------------------------

test('la alerta cita nivel, GB libres, presupuesto y el freno', () => {
  const txt = dg.alertText({ level: dg.LEVELS.RED, freeGb: 8.3, budget: B, freedGb: 6.1, frozen: true });
  assert.ok(txt.includes('red'));
  assert.ok(txt.includes('8.3 GB'));
  assert.ok(txt.includes('6.1 GB'));
  assert.ok(txt.includes('40'));
  assert.ok(/FRENADO/.test(txt));
});

test('la alerta sin freno no menciona el freno', () => {
  const txt = dg.alertText({ level: dg.LEVELS.ORANGE, freeGb: 19.8, budget: B, freedGb: 0, frozen: false });
  assert.ok(!/FRENADO/.test(txt));
});

test('cada nivel tiene color y emoji definidos', () => {
  for (const lvl of Object.values(dg.LEVELS)) {
    assert.ok(dg.LEVEL_COLORS[lvl], `falta color para ${lvl}`);
    assert.ok(dg.LEVEL_EMOJI[lvl], `falta emoji para ${lvl}`);
  }
});

'use strict';

/**
 * Tests de la verificación de paridad de la sub-ola 9.2 (#5068).
 *
 * Dos capas:
 *  - unitaria: la lógica de comparación y la forma del contrato de flujos, con
 *    entradas sintéticas (determinística, corre siempre).
 *  - integración: el puente real del kernel contra el manifiesto real del
 *    producto. Requiere un checkout del kernel con `bin/adapter-env.js`, que se
 *    apunta con la variable KERNEL_ROOT.
 *
 * Sobre el fail-closed de la integración: la ausencia de checkout SKIPEA acá y
 * FALLA en la corrida de paridad. El suite unitario compartido
 * (`npm run test:pipeline`) corre en entornos que no tienen el kernel al lado
 * — hacerlo fallar ahí rompe el build de todos los agentes sin agregar ninguna
 * garantía. La garantía de que la paridad no se dé "verde por omisión" vive en
 * los dos lugares donde efectivamente se afirma:
 *  - `verifyParity()` devuelve ok:false + error si no hay puente (test abajo),
 *    y el CLI `kernel-parity-92.js` sale con código 1 en ese caso;
 *  - con KERNEL_PARITY_STRICT=1 la ausencia de checkout es un fallo duro acá.
 *    Es lo que setea la corrida que genera la evidencia de la sub-ola.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const parity = require('../lib/kernel-parity-92');

// -----------------------------------------------------------------------------
// Contrato de flujos — los cinco que enumera el issue
// -----------------------------------------------------------------------------

test('se declaran exactamente los cinco flujos de paridad del issue', () => {
  assert.deepStrictEqual(
    parity.FLOWS.map((f) => f.id),
    ['branch', 'delivery', 'qa-gate', 'monitor-dashboard', 'reset-ops'],
  );
});

test('cada check declara variable, valor esperado y fuente del literal pre-9.2', () => {
  for (const flow of parity.FLOWS) {
    assert.ok(flow.checks.length > 0, `${flow.id} no tiene checks`);
    for (const c of flow.checks) {
      assert.match(c.var, /^ADAPTER_/, `${flow.id}: la variable ${c.var} no es del puente del adaptador`);
      assert.strictEqual(typeof c.expected, 'string', `${flow.id}/${c.var}: falta "expected"`);
      assert.ok(c.source && c.source.length > 10, `${flow.id}/${c.var}: la fuente del literal debe estar citada`);
    }
  }
});

// -----------------------------------------------------------------------------
// Comparación
// -----------------------------------------------------------------------------

test('un valor idéntico al literal pre-9.2 da paridad', () => {
  const r = parity.compare({ var: 'X', expected: 'qa:passed' }, 'qa:passed');
  assert.strictEqual(r.ok, true);
});

test('un valor distinto rompe la paridad y explica por qué', () => {
  const r = parity.compare({ var: 'X', expected: 'qa:passed' }, 'qa:aprobado');
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /difiere/);
});

test('una variable no emitida por el contrato rompe la paridad', () => {
  const r = parity.compare({ var: 'X', expected: 'algo' }, undefined);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.actual, null);
  assert.match(r.why, /no emitió/);
});

test('las rutas comparan sin atarse al separador del SO', () => {
  const check = { var: 'X', expected: 'C:/Workspaces/Intrale/platform', normalize: 'path' };
  assert.strictEqual(parity.compare(check, 'C:\\Workspaces\\Intrale\\platform').ok, true);
  assert.strictEqual(parity.compare(check, 'C:/Workspaces/Intrale/platform/').ok, true);
  assert.strictEqual(parity.compare(check, 'D:/otro/lado').ok, false);
});

test('sin normalize declarado la comparación es textual estricta', () => {
  const check = { var: 'X', expected: 'a/b' };
  assert.strictEqual(parity.compare(check, 'a\\b').ok, false);
});

test('normalizePath deja las rutas comparables', () => {
  assert.strictEqual(parity.normalizePath('C:\\a\\b\\'), 'C:/a/b');
});

// -----------------------------------------------------------------------------
// Fail-closed
// -----------------------------------------------------------------------------

test('sin puente del kernel la paridad NO se da por verde', () => {
  const vacio = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'sin-kernel-'));
  const r = parity.verifyParity({ kernelRoot: vacio });
  assert.strictEqual(r.ok, false, 'no verificable != verificado');
  assert.ok(r.error, 'debe explicar por qué no pudo verificar');
});

test('el CLI sale distinto de 0 cuando no hay puente del kernel', () => {
  const vacio = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'sin-kernel-cli-'));
  const code = parity.main(['node', 'kernel-parity-92.js', '--kernel-root', vacio]);
  assert.notStrictEqual(code, 0, 'sin puente el CLI debe fallar, no reportar paridad');
});

test('un manifiesto inválido rompe la paridad en vez de resolver defaults', (t) => {
  const found = kernelOrSkip(t);
  if (!found) return;

  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'manifiesto-roto-'));
  const bad = path.join(dir, 'pipeline.config.json');
  fs.writeFileSync(bad, '{ esto no es json valido', 'utf8');

  const r = parity.verifyParity({ kernelRoot: found.root, manifestPath: bad });
  assert.strictEqual(r.ok, false);
  assert.ok(r.error, 'el fallo del puente se reporta, no se traga');
});

// -----------------------------------------------------------------------------
// Integración — el pipeline real contra el kernel real
// -----------------------------------------------------------------------------

const STRICT = process.env.KERNEL_PARITY_STRICT === '1';

/**
 * Resuelve el checkout del kernel para los tests de integración.
 * Sin checkout: skip normal, o fallo duro si KERNEL_PARITY_STRICT=1.
 * @returns {{root: string, how: string} | null} null => el caller debe skipear.
 */
function kernelOrSkip(t) {
  const found = parity.resolveKernelRoot();
  if (found) return found;
  assert.ok(
    !STRICT,
    'KERNEL_PARITY_STRICT=1 pero no se encontró el checkout del kernel ' +
    '(KERNEL_ROOT, paquete instalado o ../kernel). ' +
    'La paridad no se da por verde sin poder ejercitar el contrato.',
  );
  t.skip('sin checkout del kernel disponible (KERNEL_PARITY_STRICT=1 para exigirlo)');
  return null;
}

test('los cinco flujos tienen paridad con el kernel parametrizado', (t) => {
  if (!kernelOrSkip(t)) return;

  const r = parity.verifyParity();
  assert.strictEqual(r.error, null, `el puente falló: ${r.error}`);

  for (const flow of r.flows) {
    const rotos = flow.checks.filter((c) => !c.ok)
      .map((c) => `${c.var}: esperado ${JSON.stringify(c.expected)}, resuelto ${JSON.stringify(c.actual)}`);
    const sondasRotas = flow.probes.filter((p) => !p.ok).map((p) => `${p.name}: ${p.detail}`);
    assert.deepStrictEqual(rotos, [], `flujo "${flow.id}" sin paridad de convención`);
    assert.deepStrictEqual(sondasRotas, [], `flujo "${flow.id}" con sondas en rojo`);
  }

  assert.strictEqual(r.ok, true);
});

test('el reporte nombra cada flujo y su veredicto', (t) => {
  if (!kernelOrSkip(t)) return;

  const texto = parity.formatReport(parity.verifyParity());
  for (const flow of parity.FLOWS) {
    assert.ok(texto.includes(flow.id), `el reporte no menciona el flujo ${flow.id}`);
  }
});

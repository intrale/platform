// =============================================================================
// Tests parseo YAML adversarial — fallo controlado, sin ejecución (EP5-H1, #3938)
//
// CA-6 (heredado de security): el parseo de work-files mantiene `yaml.load` de
// js-yaml v4 (safe-by-default). Un YAML adversarial debe fallar de forma
// CONTROLADA:
//   - tags peligrosos (`!!js/function`, `!!js/eval`) NO ejecutan código y son
//     rechazados con error capturado (WorkFileCorruptionError vía readYaml).
//   - YAML malformado → error controlado, nunca throw no manejado ni `{}`
//     silencioso autoritativo.
//   - `readYamlSafe` degrada a `{}` best-effort sin propagar.
//
// Complementa pulpo-corruption.test.js (#3941), que cubre el camino
// malformado/ENOENT; acá el foco es el vector de SEGURIDAD (deserialización).
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.PULPO_NO_AUTOSTART = '1';
const pulpo = require('../../pulpo.js');
const { readYaml, readYamlSafe, WorkFileCorruptionError } = pulpo;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-yaml-adversarial-'));
function tmpFile(name, content) {
  const fp = path.join(TMP, name);
  fs.writeFileSync(fp, content, 'utf8');
  return fp;
}

test('CA-6: tag !!js/function NO ejecuta código y es rechazado (safe-by-default)', () => {
  // Un loader inseguro (legacy safeLoad off / DEFAULT_FULL_SCHEMA) construiría
  // una función ejecutable acá. js-yaml v4 `yaml.load` NO soporta este tag →
  // error controlado, sin ejecución.
  let sideEffect = false;
  global.__YAML_RCE_CANARY__ = () => { sideEffect = true; };
  const malicious = [
    'issue: 9999',
    'pwn: !!js/function >',
    '  function () { global.__YAML_RCE_CANARY__(); return 1; }',
  ].join('\n');
  const fp = tmpFile('rce.yaml', malicious);

  assert.throws(
    () => readYaml(fp),
    (e) => e instanceof WorkFileCorruptionError,
    'el tag !!js/function debe producir error controlado, no parsear',
  );
  assert.equal(sideEffect, false, 'NO debe ejecutarse código del YAML');
  delete global.__YAML_RCE_CANARY__;
});

test('CA-6: readYamlSafe con YAML adversarial degrada a {} sin propagar ni ejecutar', () => {
  const fp = tmpFile('rce2.yaml', 'x: !!js/function "function(){return 42}"');
  let out;
  assert.doesNotThrow(() => { out = readYamlSafe(fp, 'test'); });
  assert.deepEqual(out, {});
});

test('CA-6: YAML con anchor/alias bomba acotada parsea como dato inerte (sin ejecución)', () => {
  // Aliases son datos, no código: deben parsear a estructura inerte.
  const fp = tmpFile('anchors.yaml', 'a: &x hola\nb: *x\n');
  const out = readYaml(fp);
  assert.equal(out.a, 'hola');
  assert.equal(out.b, 'hola');
});

test('CA-6: YAML malformado adversarial → WorkFileCorruptionError (fallo controlado)', () => {
  const fp = tmpFile('mal.yaml', '{[: : : unbalanced\n  - : :\n::');
  assert.throws(() => readYaml(fp), (e) => e instanceof WorkFileCorruptionError);
});

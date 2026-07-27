'use strict';

// =============================================================================
// adapter-contract.test.js — Validación del manifiesto del producto contra el
// contrato de configuración del adaptador (#5065 · Ola 9.2).
//
// Cubre los dos escenarios Gherkin del issue:
//   1. el manifiesto del producto valida contra contracts/adapter-config.schema.json
//   2. un manifiesto sin `branch.base` es rechazado INDICANDO EL CAMPO POR NOMBRE
//
// El esquema es artefacto del repo del KERNEL, no del producto. Durante la
// coexistencia (`kernel.consume: false`) el kernel no está en node_modules, así
// que lo resolvemos por: env KERNEL_ROOT → node_modules → checkout hermano.
// Si no hay checkout disponible, los tests que dependen del esquema se saltean
// en vez de fallar: la exigencia dura en CI del producto es #5069.
//
// El formateo de errores reusa `redactAjvErrors` de project-descriptor.js para
// que el operador vea el MISMO formato de error en todo el pipeline (guideline
// de DX del ux en la fase de validación).
// =============================================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');

const { redactAjvErrors } = require('../lib/project-descriptor');

const PRODUCT_ROOT = path.resolve(__dirname, '..', '..');
const MANIFEST_PATH = path.join(PRODUCT_ROOT, 'pipeline.config.json');

// --- Resolución del esquema del kernel (fail-soft, ver cabecera) -------------
function resolveSchemaPath() {
  const candidates = [];
  if (process.env.KERNEL_ROOT) {
    candidates.push(path.join(process.env.KERNEL_ROOT, 'contracts', 'adapter-config.schema.json'));
  }
  candidates.push(path.join(
    PRODUCT_ROOT, 'node_modules', '@intrale', 'operating-kernel', 'contracts', 'adapter-config.schema.json',
  ));
  candidates.push(path.join(path.dirname(PRODUCT_ROOT), 'kernel', 'contracts', 'adapter-config.schema.json'));
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch (_) { /* fail-soft: candidato inaccesible, probar el siguiente */ }
  }
  return null;
}

const SCHEMA_PATH = resolveSchemaPath();
const schema = SCHEMA_PATH ? JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8')) : null;
const skipNoSchema = SCHEMA_PATH
  ? false
  : 'esquema del kernel no disponible en este checkout (coexistencia consume:false — ver #5069)';

// Mismo setup de Ajv que project-descriptor.js, para que el esquema quede
// obligado a ser consumible por el validador que ya vive en el pipeline.
function makeValidator() {
  const ajv = new Ajv({ allErrors: true, verbose: false });
  return ajv.compile(schema);
}

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
}

// --- Escenario Gherkin 1 -----------------------------------------------------
test('el manifiesto del producto valida contra el contrato del adaptador', { skip: skipNoSchema }, () => {
  const validate = makeValidator();
  const manifest = readManifest();
  const ok = validate(manifest);
  assert.strictEqual(
    ok,
    true,
    `el manifiesto no valida: ${JSON.stringify(redactAjvErrors(validate.errors), null, 2)}`,
  );
});

// --- Escenario Gherkin 2 -----------------------------------------------------
test('un manifiesto sin branch.base es rechazado nombrando el campo faltante', { skip: skipNoSchema }, () => {
  const validate = makeValidator();
  const manifest = readManifest();
  delete manifest.branch.base;

  const ok = validate(manifest);
  assert.strictEqual(ok, false, 'un manifiesto sin branch.base NO debe validar');

  const errores = redactAjvErrors(validate.errors);
  const faltante = errores.find(
    (e) => e.keyword === 'required' && e.detail.includes('base') && e.path.includes('branch'),
  );
  assert.ok(
    faltante,
    `el error debe nombrar branch.base; se obtuvo: ${JSON.stringify(errores)}`,
  );
  assert.strictEqual(faltante.detail, 'falta clave requerida: base');
});

// --- Cobertura del contrato: campos obligatorios ------------------------------
test('cada campo obligatorio del contrato falta -> el esquema lo rechaza por nombre', { skip: skipNoSchema }, () => {
  const validate = makeValidator();
  for (const campo of schema.required) {
    const manifest = readManifest();
    delete manifest[campo];
    assert.strictEqual(validate(manifest), false, `quitar "${campo}" debe invalidar el manifiesto`);
    const errores = redactAjvErrors(validate.errors);
    assert.ok(
      errores.some((e) => e.keyword === 'required' && e.detail === `falta clave requerida: ${campo}`),
      `el error por "${campo}" debe nombrarlo: ${JSON.stringify(errores)}`,
    );
  }
});

// --- CA-4: el esquema no puede contener valores del producto ------------------
test('CA-4: el esquema del contrato no contiene valores de ningún producto concreto', { skip: skipNoSchema }, () => {
  const raw = fs.readFileSync(SCHEMA_PATH, 'utf8');
  // Valores del adaptador de referencia que NO deben filtrarse al contrato.
  const prohibidos = [/intrale/i, /leitolarreta/i, /gradlew/i, /composeApp/i];
  for (const re of prohibidos) {
    assert.ok(!re.test(raw), `el esquema filtra un valor de producto: ${re}`);
  }
  // Un `default` o `examples` con valor del producto reintroduce el acople.
  assert.ok(!Object.prototype.hasOwnProperty.call(schema, 'default'), 'el esquema no debe declarar default en la raíz');
  const conDefault = JSON.stringify(schema).match(/"(default|examples)"\s*:/);
  assert.strictEqual(conDefault, null, 'ningún campo del contrato debe traer default/examples');
});

// --- CA-7: `commands` no colisiona con `capabilities` -------------------------
test('CA-7: el contrato expone los comandos como `commands`, sin reusar `capabilities`', { skip: skipNoSchema }, () => {
  assert.ok(schema.properties.commands, 'el contrato debe declarar `commands`');
  assert.strictEqual(
    schema.properties.capabilities,
    undefined,
    '`capabilities` no debe existir en el contrato: ya tiene otras semánticas vivas',
  );
  // La PRESENCIA de la clave habilita la capacidad (fail-closed), no un booleano.
  for (const [nombre, def] of Object.entries(schema.properties.commands.properties)) {
    assert.strictEqual(def.type, 'string', `commands.${nombre} debe ser un comando (string), no un booleano`);
  }
});

// --- CA-8: el manifiesto extendido no rompe a los consumidores vivos ----------
test('CA-8: repo-target sigue resolviendo el repo primario tras extender el manifiesto', () => {
  const repoTarget = require('../lib/repo-target');
  assert.strictEqual(repoTarget.getPrimaryRepo(), 'intrale/platform');
});

test('CA-8: `capabilities` (booleanos) sobrevive intacto por compatibilidad hacia atrás', () => {
  const manifest = readManifest();
  assert.strictEqual(typeof manifest.capabilities, 'object');
  for (const [k, v] of Object.entries(manifest.capabilities)) {
    assert.strictEqual(typeof v, 'boolean', `capabilities.${k} debe seguir siendo booleano`);
  }
});

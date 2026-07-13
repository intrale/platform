'use strict';

// Tests de la verificación E2E de paridad post-migración (Ola 9.1 · #4665).
// Aseguran que el verificador de paridad demuestra, contra el repo real, que el
// motor migrado + wiring nuevo se comporta idéntico al baseline
// `pre-ola9-migracion`, cubriendo CA-1..CA-5. Fail-closed: cualquier eje con
// diferencia estructural o resolución rota cuenta como regresión.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const parity = require('../lib/kernel-parity');

// --- CA-2/CA-3 · el baseline existe y resuelve a un commit ---------------------
test('el tag baseline pre-ola9-migracion existe (punto de retorno · CA-3)', () => {
  assert.strictEqual(parity.baselineExists(), true);
});

// --- CA-2 · wiring byte-idéntico (invariante histórica: baseline vs cierre de
// migración; NO contra HEAD, que evoluciona con features posteriores legítimas) -
test('los entrypoints del motor son byte-idénticos baseline vs cierre de migración (CA-2)', () => {
  const r = parity.verifyEngineParity();
  assert.strictEqual(r.ok, true, 'la migración no debe haber cambiado el motor local');
  for (const f of r.files) {
    assert.ok(f.baselineSha, `blob baseline ausente para ${f.file}`);
    assert.strictEqual(f.postSha, f.baselineSha, `${f.file} cambió de bytes`);
  }
});

// --- CA-2 · resolver default → motor local (coexistencia) ----------------------
test('el resolver por default apunta al motor local de .pipeline/ (coexistencia · CA-2)', () => {
  const r = parity.verifyResolverDefault();
  assert.strictEqual(r.consumeEnabled, false, 'consume debe estar OFF por default en 9.1');
  assert.strictEqual(r.ok, true);
  const byName = Object.fromEntries(r.entries.map((e) => [e.name, e]));
  assert.strictEqual(byName.pulpo.resolved.source, 'local');
  assert.strictEqual(byName.pulpo.resolved.path, path.join(__dirname, '..', 'pulpo.js'));
  assert.strictEqual(byName.dashboard.resolved.source, 'local');
  assert.strictEqual(byName.dashboard.resolved.path, path.join(__dirname, '..', 'dashboard.js'));
});

// --- CA-1/CA-2 · flujos clave sin regresión ------------------------------------
test('intake/dispatch/gates/delivery no tienen regresión estructural (CA-1)', () => {
  const r = parity.verifyFlowParity();
  assert.strictEqual(r.ok, true, `flujos con diferencia: ${JSON.stringify(r)}`);
  const names = r.flows.map((f) => f.flow).sort();
  assert.deepStrictEqual(names, ['delivery', 'dispatch', 'gates', 'intake']);
  for (const fl of r.flows) {
    assert.strictEqual(fl.identical, true, `flujo ${fl.flow} difiere baseline vs post`);
  }
});

// --- CA-3 · rollback como salida segura ---------------------------------------
test('el rollback al baseline es una salida segura sin cambio de path (CA-3)', () => {
  const r = parity.verifyRollback();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.tagExists, true);
  assert.ok(r.baselineSha, 'el baseline debe resolver a un commit');
  assert.strictEqual(r.defaultIsLocalEngine, true);
});

// --- CA-4 · paridad de gates de seguridad -------------------------------------
test('los gates de seguridad disparan idénticos post-migración (CA-4)', () => {
  const r = parity.verifySecurityGates();
  assert.strictEqual(r.ok, true, `checks de seguridad: ${JSON.stringify(r.checks)}`);
  assert.strictEqual(r.checks.securityInAnalisis, true);
  assert.strictEqual(r.checks.securityInVerificacion, true);
  assert.strictEqual(r.checks.securityExcludedFromConvergence, true);
  assert.strictEqual(r.checks.credentialsCanonicalPath, true, 'el cargador debe leer ~/.claude/secrets/credentials.json');
  assert.strictEqual(r.checks.redactHasPatterns, true, 'la cadena de redacción debe conservar sus patrones');
});

// --- CA-5 · tooling de secret-scan de historia presente ------------------------
test('el tooling de secret-scan de historia sigue presente (CA-5)', () => {
  const r = parity.verifySecretScanTooling();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.present.scanner, true);
  assert.strictEqual(r.present.allowlist, true);
  assert.strictEqual(r.present.test, true);
});

// --- Orquestador · paridad total fail-closed ----------------------------------
test('runParity reporta paridad total contra el baseline real (fail-closed)', () => {
  const report = parity.runParity();
  assert.strictEqual(report.passed, true, `paridad no total: ${JSON.stringify(report.axes, null, 2)}`);
  assert.strictEqual(report.baselineRef, parity.BASELINE_TAG);
  for (const [name, axis] of Object.entries(report.axes)) {
    assert.strictEqual(axis.ok, true, `eje ${name} falló`);
  }
});

// --- helpers deterministas -----------------------------------------------------
test('stableEqual es insensible al orden de claves', () => {
  assert.strictEqual(parity.stableEqual({ a: 1, b: [2, 3] }, { b: [2, 3], a: 1 }), true);
  assert.strictEqual(parity.stableEqual({ a: 1 }, { a: 2 }), false);
  // Los arrays SÍ son sensibles al orden (el orden de skills importa).
  assert.strictEqual(parity.stableEqual([1, 2], [2, 1]), false);
});

test('extractFlows aísla exactamente los cuatro flujos clave', () => {
  const cfg = {
    intake: { desarrollo: { label: 'Ready' } },
    admission: { enabled: true },
    pipelines: {
      definicion: { fases: ['analisis'], skills_por_fase: { analisis: ['guru', 'security'] } },
      desarrollo: {
        fases: ['verificacion', 'entrega'],
        skills_por_fase: { verificacion: ['tester', 'security', 'qa'], aprobacion: ['review'], entrega: ['delivery'] },
      },
    },
    concurrencia: { delivery: 1 },
    circuit_breaker: { convergence_excludes_skills: ['security'] },
  };
  const f = parity.extractFlows(cfg);
  assert.deepStrictEqual(Object.keys(f).sort(), ['delivery', 'dispatch', 'gates', 'intake']);
  assert.deepStrictEqual(f.gates.verificacion, ['tester', 'security', 'qa']);
  assert.deepStrictEqual(f.gates.convergence_excludes_skills, ['security']);
  assert.strictEqual(f.delivery.concurrencia_delivery, 1);
  assert.deepStrictEqual(f.delivery.entrega, ['delivery']);
});

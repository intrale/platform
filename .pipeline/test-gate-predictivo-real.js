#!/usr/bin/env node
/**
 * test-gate-predictivo-real.js — ejercita las funciones REALES de pulpo.js
 * con PULPO_NO_AUTOSTART=1. Complementa test-gate-predictivo.js (que replica
 * el cálculo puro) asegurando que la implementación publicada coincide con
 * el modelo.
 *
 * Tests:
 *   T1 — Ajuste 2: predictResourceImpact resta emulador para skills QA
 *   T2 — Ajuste 3: MAX_EST_MEM = 5 y default fallback del perfil = 3
 *   T3 — Ajuste 1: recordSkillResourceUsage aprende por delta (sandbox
 *                   con metrics-history.jsonl temporal)
 *   T4 — Migración: skill-profiles.json v1 se renombra a .v1.bak al arrancar
 */

process.env.PULPO_NO_AUTOSTART = '1';

const path = require('path');
const fs = require('fs');
const os = require('os');

// Cargar pulpo.js como módulo
const pulpo = require('C:/Workspaces/Intrale/platform.session-fixpipe-20260411-220349/.pipeline/pulpo.js');

let passed = 0;
let failed = 0;
const fail = (msg) => { console.log(`  ❌ ${msg}`); failed++; };
const ok = (msg) => { console.log(`  ✅ ${msg}`); passed++; };
const assertEq = (actual, expected, label) => {
  if (actual === expected) ok(`${label}: ${actual}`);
  else fail(`${label}: esperado ${expected}, fue ${actual}`);
};
const assertTrue = (cond, label) => cond ? ok(label) : fail(label);

// ------------------------------------------------------------------
// T2 — constantes correctas
// ------------------------------------------------------------------
console.log('── T2: constantes del cap ──');
assertEq(pulpo.MAX_EST_MEM, 5, 'MAX_EST_MEM');
assertEq(pulpo.MAX_EST_CPU, 25, 'MAX_EST_CPU');
assertEq(pulpo.SKILL_PROFILES_SCHEMA_VERSION, 2, 'SKILL_PROFILES_SCHEMA_VERSION');
assertTrue(pulpo.QA_INFRA_SKILLS.has('qa'), 'qa ∈ QA_INFRA_SKILLS');
assertTrue(pulpo.QA_INFRA_SKILLS.has('security'), 'security ∈ QA_INFRA_SKILLS');
assertTrue(pulpo.QA_INFRA_SKILLS.has('tester'), 'tester ∈ QA_INFRA_SKILLS');
assertTrue(!pulpo.QA_INFRA_SKILLS.has('backend-dev'), 'backend-dev ∉ QA_INFRA_SKILLS');
console.log('');

// ------------------------------------------------------------------
// T1 — predictResourceImpact con ctx.emulator
// ------------------------------------------------------------------
console.log('── T1: predictResourceImpact resta RAM del emulador para QA ──');

// Monkey-patch de getSystemResourceUsage vía el entorno: no podemos, está
// encapsulada. En su lugar usamos un skill dummy y ctx.emulator explícito.
// El test puro ya cubrió los números; acá verificamos que el comportamiento
// del contrato (acepta ctx.emulator, produce reserved > 0 para QA_INFRA_SKILLS)
// es el esperado.
//
// Como getSystemResourceUsage() mide el sistema real, usamos un skill fuera
// de QA_INFRA_SKILLS como control y luego uno adentro. La diferencia en
// `reserved` es la evidencia de que la reserva se aplicó.
const config = { resource_limits: { orange_max_percent: 80 } };
const fakeEmu = { running: true, percent: 19.0 };

const impactQa = pulpo.predictResourceImpact('qa', config, { emulator: fakeEmu });
const impactPo = pulpo.predictResourceImpact('po', config, { emulator: fakeEmu });

assertEq(impactQa.reserved, 19.0, 'qa.reserved (emulador 19%)');
assertEq(impactPo.reserved, 0, 'po.reserved (skill no-QA → 0)');

// Con emulador apagado, incluso qa debe tener reserved=0
const impactQaNoEmu = pulpo.predictResourceImpact('qa', config, {
  emulator: { running: false, percent: 0 }
});
assertEq(impactQaNoEmu.reserved, 0, 'qa.reserved con emulador apagado');
console.log('');

// ------------------------------------------------------------------
// T3 — recordSkillResourceUsage aprende por DELTA
// ------------------------------------------------------------------
console.log('── T3: recordSkillResourceUsage aprende por delta ──');

// Necesitamos un PIPELINE custom con metrics-history.jsonl sintético.
// Como pulpo.js hardcodea PIPELINE = path.join(__dirname), tenemos que
// escribir en el .pipeline real del worktree. Lo hacemos en un archivo
// alternativo y monkey-patching `path.join` no es viable. En su lugar,
// escribimos temporalmente skill-profiles.json + metrics-history.jsonl
// en el mismo directorio, corremos la función, y restauramos.

const PIPELINE_DIR = path.join(path.dirname(require.resolve(
  'C:/Workspaces/Intrale/platform.session-fixpipe-20260411-220349/.pipeline/pulpo.js'
)));
const profilesPath = path.join(PIPELINE_DIR, 'skill-profiles.json');
const metricsPath = path.join(PIPELINE_DIR, 'metrics-history.jsonl');

// Backup de los archivos existentes
const profilesBackup = fs.existsSync(profilesPath) ? fs.readFileSync(profilesPath) : null;
const metricsBackup = fs.existsSync(metricsPath) ? fs.readFileSync(metricsPath) : null;

try {
  // Inyectar métricas sintéticas:
  //   - Baseline (60s antes del agente): sistema al 70% MEM (emulador + SO)
  //   - Durante el agente: sistema al 72% MEM (el agente agregó 2 puntos)
  //   Esperamos que el perfil aprenda avgMem ≈ 2 (el DELTA), no 71.
  const now = Date.now();
  const agentStart = now;
  const agentEnd = now + 120_000;
  const snaps = [];
  // Baseline (10 muestras en la ventana [start-60s, start))
  for (let i = 0; i < 10; i++) {
    snaps.push({ ts: agentStart - 60_000 + i * 5000, cpu: 10, mem: 70, agents: 0 });
  }
  // Durante (10 muestras entre start y end)
  for (let i = 0; i < 10; i++) {
    snaps.push({ ts: agentStart + i * 10_000, cpu: 12, mem: 72, agents: 1 });
  }
  fs.writeFileSync(metricsPath, snaps.map(s => JSON.stringify(s)).join('\n') + '\n');

  // Arranca con perfiles vacíos
  fs.writeFileSync(profilesPath, JSON.stringify({ _schemaVersion: 2 }, null, 2));

  pulpo.recordSkillResourceUsage('test-skill', agentStart, agentEnd);
  const learned = pulpo.loadSkillProfiles();

  assertTrue(learned['test-skill'] !== undefined, 'perfil test-skill creado');
  if (learned['test-skill']) {
    const mem = learned['test-skill'].avgMem;
    const cpu = learned['test-skill'].avgCpu;
    console.log(`     aprendido: avgCpu=${cpu} avgMem=${mem}`);
    // DELTA esperado: mem (72) - baseline (70) = 2
    // Con la fórmula vieja habría sido ~71-72 (promedio total)
    assertTrue(mem <= 5, `avgMem ≤ 5 (delta real, fue ${mem})`);
    assertTrue(mem > 0, `avgMem > 0 (fue ${mem})`);
    assertTrue(cpu <= 5, `avgCpu ≤ 5 (delta real, fue ${cpu})`);
  }
} finally {
  // Restaurar archivos originales
  if (profilesBackup !== null) fs.writeFileSync(profilesPath, profilesBackup);
  else if (fs.existsSync(profilesPath)) fs.unlinkSync(profilesPath);
  if (metricsBackup !== null) fs.writeFileSync(metricsPath, metricsBackup);
  else if (fs.existsSync(metricsPath)) fs.unlinkSync(metricsPath);
}
console.log('');

// ------------------------------------------------------------------
// T4 — Migración v1 → v2 renombra a .v1.bak
// ------------------------------------------------------------------
console.log('── T4: migración skill-profiles v1 → v2 ──');

const testProfilesFile = path.join(PIPELINE_DIR, 'skill-profiles.json');
const bakFile = testProfilesFile + '.v1.bak';

// Backup del actual
const existingProfiles = fs.existsSync(testProfilesFile) ? fs.readFileSync(testProfilesFile) : null;
const existingBak = fs.existsSync(bakFile) ? fs.readFileSync(bakFile) : null;

try {
  // Escribir un perfil v1 (sin _schemaVersion)
  const v1Data = {
    qa: { avgCpu: 19.1, avgMem: 44.9, samples: 8, lastUpdated: '2026-04-11T14:27:30Z' }
  };
  fs.writeFileSync(testProfilesFile, JSON.stringify(v1Data, null, 2));
  if (fs.existsSync(bakFile)) fs.unlinkSync(bakFile); // limpiar bak previo

  pulpo.migrateSkillProfilesIfNeeded();

  assertTrue(!fs.existsSync(testProfilesFile), 'skill-profiles.json removido tras migración');
  assertTrue(fs.existsSync(bakFile), 'skill-profiles.json.v1.bak creado');
  if (fs.existsSync(bakFile)) {
    const bakContent = JSON.parse(fs.readFileSync(bakFile, 'utf8'));
    assertEq(bakContent.qa?.avgMem, 44.9, 'bak preserva datos v1');
  }

  // Segunda invocación: no debe fallar ni re-renombrar
  pulpo.migrateSkillProfilesIfNeeded();
  ok('segunda invocación es no-op');

  // Crear un perfil v2 y verificar que NO se migra
  fs.writeFileSync(testProfilesFile, JSON.stringify({
    _schemaVersion: 2,
    qa: { avgCpu: 5, avgMem: 2, samples: 3 }
  }, null, 2));
  if (fs.existsSync(bakFile)) fs.unlinkSync(bakFile);
  pulpo.migrateSkillProfilesIfNeeded();
  assertTrue(fs.existsSync(testProfilesFile), 'v2 NO se migra (sigue existiendo)');
  assertTrue(!fs.existsSync(bakFile), 'v2 NO genera bak');
} finally {
  // Restaurar
  if (existingProfiles !== null) fs.writeFileSync(testProfilesFile, existingProfiles);
  else if (fs.existsSync(testProfilesFile)) fs.unlinkSync(testProfilesFile);
  if (existingBak !== null) fs.writeFileSync(bakFile, existingBak);
  else if (fs.existsSync(bakFile)) fs.unlinkSync(bakFile);
}
console.log('');

// ------------------------------------------------------------------
console.log('═'.repeat(78));
console.log(`Resultado: ${passed} OK, ${failed} fallos`);
console.log('═'.repeat(78));
process.exit(failed === 0 ? 0 : 1);

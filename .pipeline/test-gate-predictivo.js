#!/usr/bin/env node
/**
 * test-gate-predictivo.js — evidencia antes/después del fix del gate predictivo.
 *
 * Reproduce el estado del incidente 2026-04-12 01:03-01:08:
 *   - RAM total del sistema: 72%
 *   - qemu-system-x86_64-headless.exe corriendo (~3.0 GB / 16 GB = ~19%)
 *   - skill-profiles.json aprendido con la fórmula V1 (total, no delta):
 *       qa       avgMem = 44.9   samples = 8
 *       security avgMem = 46.1   samples = 10
 *       tester   avgMem = 22.0   samples = 6
 *   - Ventana QA activa, #1920 en verificacion/pendiente/ (qa, security, tester)
 *
 * Para cada skill, evalúa:
 *   A) FÓRMULA V1 (legacy)  — el bug del livelock
 *   B) FÓRMULA V2 (ajuste 1+2+3) — el fix que probamos
 *
 * No llama al pulpo real. Replica el cálculo puro del gate aislando la lógica.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

// ------------------------------------------------------------------
// Estado del sistema en el momento del incidente (captura real del log)
// ------------------------------------------------------------------
const SCENARIO = {
  usage:         { cpuPercent: 12, memPercent: 72 },
  emulator:      { running: true, percent: 19.0 }, // ~3 GB / 16 GB
  maxCpu:        80,
  maxMem:        80,
  // Perfiles aprendidos con la fórmula V1 (total sin baseline)
  profilesV1: {
    qa:       { avgCpu: 19.1, avgMem: 44.9, samples: 8,  lastUpdated: '2026-04-11T14:27:30Z' },
    security: { avgCpu: 16.6, avgMem: 46.1, samples: 10, lastUpdated: '2026-04-12T01:13:23Z' },
    tester:   { avgCpu: 25.2, avgMem: 22.0, samples: 6,  lastUpdated: '2026-04-11T14:14:19Z' }
  },
  // Perfiles que APRENDERÍA la fórmula V2 (delta real del agente claude.exe)
  // Medición real en pipeline: claude.exe ~250-500 MB = 1.6% - 3% en 16 GB.
  profilesV2: {
    qa:       { avgCpu: 6.2, avgMem: 2.1, samples: 8,  lastUpdated: '2026-04-11T14:27:30Z' },
    security: { avgCpu: 5.1, avgMem: 1.8, samples: 10, lastUpdated: '2026-04-12T01:13:23Z' },
    tester:   { avgCpu: 7.0, avgMem: 2.4, samples: 6,  lastUpdated: '2026-04-11T14:14:19Z' }
  }
};

// ------------------------------------------------------------------
// CÁLCULO V1 — lo que tenía pulpo.js antes del fix
// ------------------------------------------------------------------
function gateV1(skill, scenario) {
  const MIN_RELIABLE_SAMPLES = 5;
  const MAX_EST_CPU = 25;
  const MAX_EST_MEM = 20;    // <-- cap viejo
  const DEFAULT_CPU = 12;
  const DEFAULT_MEM = 8;

  const profile = scenario.profilesV1[skill];
  const samples = profile.samples || 0;
  let cpu = Math.min(profile.avgCpu, MAX_EST_CPU);
  let mem = Math.min(profile.avgMem, MAX_EST_MEM);

  if (samples < MIN_RELIABLE_SAMPLES) {
    const conf = samples / MIN_RELIABLE_SAMPLES;
    cpu = DEFAULT_CPU * (1 - conf) + cpu * conf;
    mem = DEFAULT_MEM * (1 - conf) + mem * conf;
  }

  const predictedCpu = scenario.usage.cpuPercent + cpu;
  const predictedMem = scenario.usage.memPercent + mem;
  const cpuSafe = predictedCpu < scenario.maxCpu;
  const memSafe = predictedMem < scenario.maxMem;

  return {
    safe: cpuSafe && memSafe,
    est: { cpu: round(cpu), mem: round(mem) },
    predicted: { cpu: round(predictedCpu), mem: round(predictedMem) },
    reason: !cpuSafe || !memSafe
      ? `MEM ${scenario.usage.memPercent}% + ~${round(mem)}% = ${round(predictedMem)}% (max ${scenario.maxMem}%)`
      : null
  };
}

// ------------------------------------------------------------------
// CÁLCULO V2 — lo que quedó en pulpo.js después del fix (ajustes 1+2+3)
// ------------------------------------------------------------------
function gateV2(skill, scenario) {
  const MIN_RELIABLE_SAMPLES = 5;
  const MAX_EST_CPU = 25;
  const MAX_EST_MEM = 5;       // <-- cap nuevo (ajuste 3)
  const DEFAULT_CPU = 12;
  const DEFAULT_MEM = 3;       // <-- default nuevo (ajuste 3)
  const QA_INFRA_SKILLS = new Set(['qa', 'security', 'tester']);

  const profile = scenario.profilesV2[skill];
  const samples = profile.samples || 0;
  let cpu = Math.min(profile.avgCpu, MAX_EST_CPU);
  let mem = Math.min(profile.avgMem, MAX_EST_MEM);

  if (samples < MIN_RELIABLE_SAMPLES) {
    const conf = samples / MIN_RELIABLE_SAMPLES;
    cpu = DEFAULT_CPU * (1 - conf) + cpu * conf;
    mem = DEFAULT_MEM * (1 - conf) + mem * conf;
  }

  // Ajuste 2: restar del baseline la RAM reservada por infra del propio skill
  let reservedMem = 0;
  if (QA_INFRA_SKILLS.has(skill) && scenario.emulator.running) {
    reservedMem = scenario.emulator.percent;
  }
  const effectiveMemBase = Math.max(0, scenario.usage.memPercent - reservedMem);

  const predictedCpu = scenario.usage.cpuPercent + cpu;
  const predictedMem = effectiveMemBase + mem;
  const cpuSafe = predictedCpu < scenario.maxCpu;
  const memSafe = predictedMem < scenario.maxMem;

  return {
    safe: cpuSafe && memSafe,
    est: { cpu: round(cpu), mem: round(mem) },
    predicted: { cpu: round(predictedCpu), mem: round(predictedMem) },
    reserved: reservedMem,
    reason: !cpuSafe || !memSafe
      ? `MEM ${scenario.usage.memPercent}% − emulador ${reservedMem}% + ~${round(mem)}% = ${round(predictedMem)}% (max ${scenario.maxMem}%)`
      : null
  };
}

function round(x) { return Math.round(x * 10) / 10; }

// ------------------------------------------------------------------
// Runner
// ------------------------------------------------------------------
function run() {
  console.log('═'.repeat(78));
  console.log('Test: gate predictivo antes/después del fix');
  console.log('Reproduce estado del incidente 2026-04-12 01:03-01:08 (#1920 qa+security+tester)');
  console.log('═'.repeat(78));
  console.log('');
  console.log('Escenario:');
  console.log(`  CPU del sistema:       ${SCENARIO.usage.cpuPercent}%`);
  console.log(`  RAM del sistema:       ${SCENARIO.usage.memPercent}%`);
  console.log(`  Emulador corriendo:    ${SCENARIO.emulator.running ? 'sí' : 'no'} (${SCENARIO.emulator.percent}% de RAM)`);
  console.log(`  Umbral maxMem:         ${SCENARIO.maxMem}%`);
  console.log('');

  const skills = ['qa', 'security', 'tester'];
  let v1Blocked = 0;
  let v2Launched = 0;

  for (const skill of skills) {
    const v1 = gateV1(skill, SCENARIO);
    const v2 = gateV2(skill, SCENARIO);

    if (!v1.safe) v1Blocked++;
    if (v2.safe) v2Launched++;

    console.log(`── ${skill.toUpperCase()} ──`);
    console.log(`  V1 (legacy): est.mem=${v1.est.mem}%  predictedMem=${v1.predicted.mem}%  ${v1.safe ? '✅ PASA' : '🛑 BLOQUEA'}`);
    if (v1.reason) console.log(`       razón: ${v1.reason}`);
    console.log(`  V2 (fix):    est.mem=${v2.est.mem}%  reserved=${v2.reserved || 0}%  predictedMem=${v2.predicted.mem}%  ${v2.safe ? '✅ PASA' : '🛑 BLOQUEA'}`);
    if (v2.reason) console.log(`       razón: ${v2.reason}`);
    console.log('');
  }

  console.log('─'.repeat(78));
  console.log(`Resultado V1: ${v1Blocked}/${skills.length} bloqueados → livelock reproducido`);
  console.log(`Resultado V2: ${v2Launched}/${skills.length} pasan el gate → livelock resuelto`);
  console.log('─'.repeat(78));

  // Casos adicionales: el V2 sigue bloqueando cuando hay saturación externa real
  console.log('');
  console.log('Test de regresión: V2 NO debe bajar la guardia con saturación externa');
  console.log('');
  const saturated = {
    usage:    { cpuPercent: 60, memPercent: 95 }, // sistema al 95% por causas externas
    emulator: { running: false, percent: 0 },     // sin emulador
    maxCpu:   80,
    maxMem:   80,
    profilesV2: SCENARIO.profilesV2
  };
  const v2sat = gateV2('qa', saturated);
  const expectedBlocked = !v2sat.safe;
  console.log(`  qa @ RAM 95% sin emulador: V2 ${v2sat.safe ? '✅ PASA' : '🛑 BLOQUEA'}`);
  console.log(`  razón: ${v2sat.reason || 'n/a'}`);
  console.log(`  Esperado: BLOQUEA — ${expectedBlocked ? '✅ OK' : '❌ FALLA'}`);
  console.log('');

  // Otro test de regresión: baseline no sobrepasa 0
  const negativeGuard = {
    usage:    { cpuPercent: 5, memPercent: 10 },  // sistema casi vacío
    emulator: { running: true, percent: 19 },     // emulador presente
    maxCpu:   80,
    maxMem:   80,
    profilesV2: SCENARIO.profilesV2
  };
  const v2neg = gateV2('qa', negativeGuard);
  const baselineFloor = Math.max(0, negativeGuard.usage.memPercent - negativeGuard.emulator.percent);
  console.log(`  qa @ RAM 10% con emulador 19%: baseline efectivo = ${baselineFloor}% (piso en 0)`);
  console.log(`  V2 ${v2neg.safe ? '✅ PASA' : '🛑 BLOQUEA'} (predictedMem=${v2neg.predicted.mem}%)`);
  console.log(`  Esperado: PASA — ${v2neg.safe ? '✅ OK' : '❌ FALLA'}`);
  console.log('');

  // Exit code: todos los checks deben pasar
  const allOk =
    v1Blocked === skills.length &&  // V1 reproduce el livelock
    v2Launched === skills.length && // V2 lo resuelve
    expectedBlocked &&              // V2 sigue protegiendo ante saturación
    v2neg.safe;                     // V2 no falla con baseline pequeño
  console.log(allOk ? '✅ ALL CHECKS PASSED' : '❌ CHECK FAILURE');
  process.exit(allOk ? 0 : 1);
}

run();

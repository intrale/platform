#!/usr/bin/env node
// =============================================================================
// Test de concurrencia, deduplicación y circuit breaker del Pulpo
// Simula el filesystem del pipeline y verifica las reglas del modelo operativo.
// Uso: node .pipeline/test-concurrencia.js
// =============================================================================

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const os = require('os');

const PASSED = '✅';
const FAILED = '❌';
let total = 0, passed = 0, failed = 0;

function assert(condition, msg) {
  total++;
  if (condition) {
    passed++;
    console.log(`  ${PASSED} ${msg}`);
  } else {
    failed++;
    console.log(`  ${FAILED} ${msg}`);
  }
}

// --- Setup: crear estructura temporal que replica el pipeline ---

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pulpo-test-'));
const CONFIG = {
  pipelines: {
    desarrollo: {
      fases: ['dev', 'build', 'verificacion'],
      fase_rechazo: 'dev',
      skills_por_fase: {
        dev: ['backend-dev', 'android-dev'],
        build: ['build'],
        verificacion: ['tester', 'qa']
      }
    }
  },
  concurrencia: {
    'backend-dev': 3,
    'android-dev': 2,
    'build': 1,
    'tester': 2,
    'qa': 1
  },
  dev_skill_mapping: { default: 'backend-dev' },
  timeouts: { poll_interval_seconds: 30, orphan_timeout_minutes: 10 }
};

// Crear carpetas
for (const fase of CONFIG.pipelines.desarrollo.fases) {
  for (const estado of ['pendiente', 'trabajando', 'listo', 'procesado']) {
    fs.mkdirSync(path.join(TMP, 'desarrollo', fase, estado), { recursive: true });
  }
}

// Crear config.yaml
const configPath = path.join(TMP, 'config.yaml');
fs.writeFileSync(configPath, yaml.dump(CONFIG));

// Cooldowns file
const cooldownPath = path.join(TMP, 'cooldowns.json');
fs.writeFileSync(cooldownPath, '{}');

// --- Funciones del Pulpo replicadas para testing (misma lógica, paths parametrizados) ---

function listWorkFiles(dir) {
  try {
    return fs.readdirSync(dir)
      .filter(f => !f.startsWith('.') && !f.endsWith('.gitkeep'))
      .map(f => ({ name: f, path: path.join(dir, f) }));
  } catch { return []; }
}

function issueFromFile(filename) { return filename.split('.')[0]; }
function skillFromFile(filename) { return filename.split('.').slice(1).join('.'); }

function countRunningBySkill(skill) {
  let count = 0;
  for (const fase of CONFIG.pipelines.desarrollo.fases) {
    const dir = path.join(TMP, 'desarrollo', fase, 'trabajando');
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith(`.${skill}`) && !f.startsWith('.')) count++;
      }
    } catch {}
  }
  return count;
}

function loadCooldowns() {
  try { return JSON.parse(fs.readFileSync(cooldownPath, 'utf8')); } catch { return {}; }
}

function saveCooldowns(cd) {
  fs.writeFileSync(cooldownPath, JSON.stringify(cd, null, 2));
}

function isInCooldown(skill, issue) {
  const cd = loadCooldowns();
  const key = `${skill}:${issue}`;
  if (!cd[key] || !cd[key].cooldownUntil) return false;
  return new Date(cd[key].cooldownUntil) > new Date();
}

function registerFastFail(skill, issue) {
  const COOLDOWN_BASE_MS = 5 * 60 * 1000;
  const COOLDOWN_MAX_MS = 60 * 60 * 1000;
  const cd = loadCooldowns();
  const key = `${skill}:${issue}`;
  if (!cd[key]) cd[key] = { failures: 0, cooldownUntil: null };
  cd[key].failures++;
  const delay = Math.min(COOLDOWN_BASE_MS * Math.pow(2, cd[key].failures - 1), COOLDOWN_MAX_MS);
  cd[key].cooldownUntil = new Date(Date.now() + delay).toISOString();
  cd[key].lastFailure = new Date().toISOString();
  saveCooldowns(cd);
  return { failures: cd[key].failures, delayMin: Math.round(delay / 60000) };
}

function clearCooldown(skill, issue) {
  const cd = loadCooldowns();
  const key = `${skill}:${issue}`;
  if (cd[key]) { delete cd[key]; saveCooldowns(cd); }
}

/** Simular brazoLanzamiento: retorna qué agentes SE LANZARÍAN */
function simulateLanzamiento() {
  const launched = [];
  const fase = 'dev';
  const pendienteDir = path.join(TMP, 'desarrollo', fase, 'pendiente');
  const trabajandoDir = path.join(TMP, 'desarrollo', fase, 'trabajando');
  const archivos = listWorkFiles(pendienteDir);

  for (const archivo of archivos) {
    const skill = skillFromFile(archivo.name);
    const issue = issueFromFile(archivo.name);

    // 1. DEDUP: ¿ya hay un agente activo para este ISSUE en trabajando/?
    const issueAlreadyWorking = listWorkFiles(trabajandoDir).some(f => issueFromFile(f.name) === issue);
    if (issueAlreadyWorking) continue;

    // 2. COOLDOWN
    if (isInCooldown(skill, issue)) continue;

    // 3. Concurrencia del rol
    const maxConcurrencia = CONFIG.concurrencia[skill] || 1;
    const running = countRunningBySkill(skill);
    if (running >= maxConcurrencia) continue;

    // Lanzar: mover a trabajando/
    const dest = path.join(trabajandoDir, archivo.name);
    fs.renameSync(archivo.path, dest);
    launched.push({ skill, issue, file: archivo.name });
  }
  return launched;
}

/** Helper: crear archivo de trabajo en pendiente */
function addPendiente(issue, skill) {
  const dir = path.join(TMP, 'desarrollo', 'dev', 'pendiente');
  const file = path.join(dir, `${issue}.${skill}`);
  fs.writeFileSync(file, yaml.dump({ issue: parseInt(issue), fase: 'dev' }));
}

/** Helper: crear archivo en trabajando (simula agente ya corriendo) */
function addTrabajando(issue, skill) {
  const dir = path.join(TMP, 'desarrollo', 'dev', 'trabajando');
  const file = path.join(dir, `${issue}.${skill}`);
  fs.writeFileSync(file, yaml.dump({ issue: parseInt(issue), fase: 'dev' }));
}

/** Helper: limpiar todos los archivos de trabajo */
function cleanAll() {
  for (const fase of CONFIG.pipelines.desarrollo.fases) {
    for (const estado of ['pendiente', 'trabajando', 'listo']) {
      const dir = path.join(TMP, 'desarrollo', fase, estado);
      for (const f of fs.readdirSync(dir)) {
        if (!f.startsWith('.')) fs.unlinkSync(path.join(dir, f));
      }
    }
  }
  fs.writeFileSync(cooldownPath, '{}');
}

// =============================================================================
// TESTS
// =============================================================================

console.log('\n=== TEST 1: Concurrencia máxima por rol ===');
cleanAll();
// Poner 5 issues pendientes para backend-dev (max 3)
for (let i = 1; i <= 5; i++) addPendiente(String(2000 + i), 'backend-dev');
const t1 = simulateLanzamiento();
assert(t1.length === 3, `Lanzó ${t1.length} agentes backend-dev (esperado: 3, max concurrencia)`);
const t1working = listWorkFiles(path.join(TMP, 'desarrollo', 'dev', 'trabajando')).length;
assert(t1working === 3, `En trabajando/ hay ${t1working} archivos (esperado: 3)`);
const t1pending = listWorkFiles(path.join(TMP, 'desarrollo', 'dev', 'pendiente')).length;
assert(t1pending === 2, `En pendiente/ quedan ${t1pending} archivos (esperado: 2)`);

console.log('\n=== TEST 2: Segundo ciclo NO lanza más si ya está al máximo ===');
const t2 = simulateLanzamiento();
assert(t2.length === 0, `Segundo ciclo lanzó ${t2.length} agentes (esperado: 0, ya al máximo)`);

console.log('\n=== TEST 3: Concurrencia android-dev (max 2) ===');
cleanAll();
for (let i = 1; i <= 4; i++) addPendiente(String(3000 + i), 'android-dev');
const t3 = simulateLanzamiento();
assert(t3.length === 2, `Lanzó ${t3.length} agentes android-dev (esperado: 2)`);

console.log('\n=== TEST 4: Dedup — no lanzar dos agentes para el mismo issue ===');
cleanAll();
addPendiente('4001', 'backend-dev');
addPendiente('4001', 'android-dev');  // Mismo issue, distinto skill
const t4 = simulateLanzamiento();
assert(t4.length === 1, `Lanzó ${t4.length} agentes para issue 4001 (esperado: 1, dedup por issue)`);

console.log('\n=== TEST 5: Dedup — issue ya en trabajando/ no se relanza ===');
cleanAll();
addTrabajando('5001', 'backend-dev');  // Ya corriendo
addPendiente('5001', 'backend-dev');   // Pendiente duplicado
const t5 = simulateLanzamiento();
assert(t5.length === 0, `Lanzó ${t5.length} agentes para issue 5001 (esperado: 0, ya en trabajando/)`);

console.log('\n=== TEST 6: Issues distintos sí se lanzan en paralelo ===');
cleanAll();
addPendiente('6001', 'backend-dev');
addPendiente('6002', 'backend-dev');
addPendiente('6003', 'backend-dev');
const t6 = simulateLanzamiento();
assert(t6.length === 3, `Lanzó ${t6.length} agentes (esperado: 3, issues distintos)`);
const t6issues = t6.map(x => x.issue).sort();
assert(JSON.stringify(t6issues) === '["6001","6002","6003"]', `Issues lanzados: ${t6issues.join(', ')}`);

console.log('\n=== TEST 7: Cooldown — issue penalizado no se relanza ===');
cleanAll();
registerFastFail('backend-dev', '7001');
addPendiente('7001', 'backend-dev');
const t7 = simulateLanzamiento();
assert(t7.length === 0, `Lanzó ${t7.length} agentes para issue 7001 (esperado: 0, en cooldown)`);

console.log('\n=== TEST 8: Cooldown exponencial — tiempos correctos ===');
cleanAll();
fs.writeFileSync(cooldownPath, '{}');
const r1 = registerFastFail('backend-dev', '8001');
assert(r1.delayMin === 5, `Primer fallo: cooldown ${r1.delayMin}min (esperado: 5)`);
const r2 = registerFastFail('backend-dev', '8001');
assert(r2.delayMin === 10, `Segundo fallo: cooldown ${r2.delayMin}min (esperado: 10)`);
const r3 = registerFastFail('backend-dev', '8001');
assert(r3.delayMin === 20, `Tercer fallo: cooldown ${r3.delayMin}min (esperado: 20)`);
const r4 = registerFastFail('backend-dev', '8001');
assert(r4.delayMin === 40, `Cuarto fallo: cooldown ${r4.delayMin}min (esperado: 40)`);
const r5 = registerFastFail('backend-dev', '8001');
assert(r5.delayMin === 60, `Quinto fallo: cooldown ${r5.delayMin}min (esperado: 60, cap)`);
const r6 = registerFastFail('backend-dev', '8001');
assert(r6.delayMin === 60, `Sexto fallo: cooldown ${r6.delayMin}min (esperado: 60, cap)`);

console.log('\n=== TEST 9: clearCooldown — éxito limpia penalización ===');
cleanAll();
registerFastFail('backend-dev', '9001');
assert(isInCooldown('backend-dev', '9001') === true, 'Issue en cooldown después de fallo');
clearCooldown('backend-dev', '9001');
assert(isInCooldown('backend-dev', '9001') === false, 'Issue SIN cooldown después de clearCooldown');
addPendiente('9001', 'backend-dev');
const t9 = simulateLanzamiento();
assert(t9.length === 1, `Lanzó ${t9.length} agentes para 9001 después de clear (esperado: 1)`);

console.log('\n=== TEST 10: Mix — concurrencia + dedup + cooldown juntos ===');
cleanAll();
// 3 issues backend-dev pendientes + 1 en cooldown + 1 duplicado en trabajando
addPendiente('1001', 'backend-dev');
addPendiente('1002', 'backend-dev');
addPendiente('1003', 'backend-dev');
addPendiente('1004', 'backend-dev');  // Excede concurrencia
addPendiente('1005', 'backend-dev');  // En cooldown
registerFastFail('backend-dev', '1005');
addTrabajando('1003', 'android-dev'); // 1003 ya en trabajando (otro skill)
const t10 = simulateLanzamiento();
// 1001, 1002 se lanzan (2). 1003 bloqueado (dedup). 1004 bloqueado (max 3, ya hay 2 + 1003 en trabajando = 3). 1005 en cooldown.
// Pero 1003 ya está en trabajando, así que countRunningBySkill('backend-dev') ve solo los que están como .backend-dev
// Entonces: 1001 se lanza (running=0→1), 1002 se lanza (running=1→2), 1003 dedup, 1004 se lanza (running=2→3), 1005 cooldown
// Total: 3 (1001, 1002, 1004)
assert(t10.length === 3, `Mix: lanzó ${t10.length} agentes (esperado: 3 — 1003 dedup, 1005 cooldown)`);
const t10issues = t10.map(x => x.issue).sort();
assert(!t10issues.includes('1003'), `Issue 1003 NO lanzado (dedup, ya en trabajando/)`);
assert(!t10issues.includes('1005'), `Issue 1005 NO lanzado (en cooldown)`);

console.log('\n=== TEST 11: build tiene concurrencia 1 ===');
cleanAll();
const buildPendDir = path.join(TMP, 'desarrollo', 'build', 'pendiente');
const buildTrabDir = path.join(TMP, 'desarrollo', 'build', 'trabajando');
fs.writeFileSync(path.join(buildPendDir, '1101.build'), yaml.dump({ issue: 1101 }));
fs.writeFileSync(path.join(buildPendDir, '1102.build'), yaml.dump({ issue: 1102 }));
// Simular lanzamiento en fase build
const buildArchivos = listWorkFiles(buildPendDir);
let buildLaunched = 0;
for (const archivo of buildArchivos) {
  const skill = skillFromFile(archivo.name);
  const running = countRunningBySkill(skill);
  const max = CONFIG.concurrencia[skill] || 1;
  if (running >= max) continue;
  fs.renameSync(archivo.path, path.join(buildTrabDir, archivo.name));
  buildLaunched++;
}
assert(buildLaunched === 1, `Build: lanzó ${buildLaunched} (esperado: 1, max concurrencia build=1)`);

// =============================================================================
// RESULTADO
// =============================================================================

console.log(`\n${'='.repeat(50)}`);
console.log(`RESULTADO: ${passed}/${total} tests pasaron${failed > 0 ? ` — ${failed} FALLARON` : ''}`);
console.log(`${'='.repeat(50)}\n`);

// Cleanup
fs.rmSync(TMP, { recursive: true, force: true });

process.exit(failed > 0 ? 1 : 0);

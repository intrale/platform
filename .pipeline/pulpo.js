#!/usr/bin/env node
// =============================================================================
// Pulpo V2 — Proceso central del pipeline
// Brazos: barrido, lanzamiento, huérfanos, desbloqueo (+ intake en F5)
// =============================================================================

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn } = require('child_process');
const yaml = require('js-yaml');

// Crash handlers — loguear y seguir vivo
process.on('uncaughtException', (err) => {
  const msg = `[${new Date().toISOString()}] [pulpo] CRASH uncaughtException: ${err.stack || err.message}\n`;
  try { fs.appendFileSync(path.join(__dirname, 'logs', 'pulpo.log'), msg); } catch {}
  console.error(msg);
});
process.on('unhandledRejection', (reason) => {
  const msg = `[${new Date().toISOString()}] [pulpo] CRASH unhandledRejection: ${reason}\n`;
  try { fs.appendFileSync(path.join(__dirname, 'logs', 'pulpo.log'), msg); } catch {}
  console.error(msg);
});

const ROOT = path.resolve(__dirname, '..');
const PIPELINE = path.resolve(__dirname);
const CONFIG_PATH = path.join(PIPELINE, 'config.yaml');
const LOG_DIR = path.join(PIPELINE, 'logs');
// Ejecutar claude via Node directo (evita cmd.exe y ventanas visibles)
const CLAUDE_CLI_JS = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const USE_NODE_DIRECT = fs.existsSync(CLAUDE_CLI_JS);
const GH_BIN = 'C:\\Workspaces\\gh-cli\\bin\\gh.exe';

// Rate limiting para GitHub API (máx 1 call cada 2 segundos)
let lastGhCallTime = 0;
function ghThrottle() {
  const now = Date.now();
  const wait = 2000 - (now - lastGhCallTime);
  if (wait > 0) {
    // Busy-wait síncrono (las alternativas requieren async y esto es llamado desde contextos sync)
    const end = Date.now() + wait;
    while (Date.now() < end) { /* throttle */ }
  }
  lastGhCallTime = Date.now();
}

/**
 * Agregar un comentario a un issue de GitHub (fire-and-forget).
 */
function ghCommentOnIssue(issueNumber, body) {
  try {
    ghThrottle();
    execSync(`"${GH_BIN}" issue comment ${issueNumber} --body "${body.replace(/"/g, '\\"')}"`, {
      encoding: 'utf8', timeout: 15000, windowsHide: true,
      cwd: path.resolve(__dirname, '..')
    });
    log('github', `Comentario en #${issueNumber}: ${body.slice(0, 80)}`);
  } catch (e) {
    log('github', `Error comentando #${issueNumber}: ${e.message}`);
  }
}

// --- Utilidades ---

// Partir texto en chunks para TTS respetando límites de oraciones
function splitTextForTTSChunks(text, maxChars) {
  if (text.length <= maxChars) return [text];
  const sentences = text.split(/(?<=[.!?])\s+/);
  const chunks = [];
  let current = '';
  for (const sentence of sentences) {
    if ((current + ' ' + sentence).length > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current = current ? current + ' ' + sentence : sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  // Oraciones individuales más largas que maxChars → corte por palabras
  const result = [];
  for (const chunk of chunks) {
    if (chunk.length <= maxChars) { result.push(chunk); continue; }
    const words = chunk.split(/\s+/);
    let part = '';
    for (const word of words) {
      if ((part + ' ' + word).length > maxChars && part.length > 0) {
        result.push(part.trim());
        part = word;
      } else {
        part = part ? part + ' ' + word : word;
      }
    }
    if (part.trim()) result.push(part.trim());
  }
  return result;
}

function log(brazo, msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [${brazo}] ${msg}`);
}

function loadConfig() {
  return yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function readYaml(filepath) {
  try {
    return yaml.load(fs.readFileSync(filepath, 'utf8')) || {};
  } catch { return {}; }
}

function writeYaml(filepath, data) {
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, yaml.dump(data, { lineWidth: -1 }));
}

/** Listar archivos de trabajo (no .gitkeep) en una carpeta */
function listWorkFiles(dir) {
  try {
    return fs.readdirSync(dir)
      .filter(f => !f.startsWith('.') && !f.endsWith('.gitkeep'))
      .map(f => ({ name: f, path: path.join(dir, f) }));
  } catch { return []; }
}

/** Extraer issue number del nombre de archivo (ej: "1732.po" → "1732") */
function issueFromFile(filename) {
  return filename.split('.')[0];
}

/** Extraer skill del nombre de archivo (ej: "1732.po" → "po") */
function skillFromFile(filename) {
  return filename.split('.').slice(1).join('.');
}

/** Mover archivo entre carpetas (atómico en filesystem) */
function moveFile(src, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, path.basename(src));
  fs.renameSync(src, dest);
  return dest;
}

/** Obtener path de fase dentro de un pipeline */
function fasePath(pipelineName, faseName) {
  return path.join(PIPELINE, pipelineName, faseName);
}

/** Obtener el mtime de un archivo en minutos */
function fileAgeMinutes(filepath) {
  try {
    const stat = fs.statSync(filepath);
    return (Date.now() - stat.mtimeMs) / 60000;
  } catch { return 0; }
}

/** Buscar si un issue ya existe en alguna carpeta del pipeline */
/** Verificar si un issue ya está ACTIVO en un pipeline (pendiente/trabajando/listo, NO procesado) */
function issueExistsInPipeline(issueNum, pipelineName) {
  const config = loadConfig();
  const pipelines = pipelineName ? { [pipelineName]: config.pipelines[pipelineName] } : config.pipelines;
  const prefix = issueNum + '.';

  for (const [pName, pConfig] of Object.entries(pipelines)) {
    if (!pConfig) continue;
    for (const fase of pConfig.fases) {
      // Solo buscar en estados activos — procesado significa que ya terminó esa fase
      for (const estado of ['pendiente', 'trabajando', 'listo']) {
        const dir = path.join(PIPELINE, pName, fase, estado);
        try {
          for (const f of fs.readdirSync(dir)) {
            if (f.startsWith(prefix) && f !== '.gitkeep') return true;
          }
        } catch {}
      }
    }
  }
  return false;
}

// --- Circuit Breaker + Cooldown ---
// Penalización exponencial: si un agente muere rápido, esperar antes de relanzar.
// Base: 5 min, duplica en cada fallo consecutivo. Max: 60 min.
const COOLDOWN_BASE_MS = 5 * 60 * 1000;    // 5 minutos
const COOLDOWN_MAX_MS = 60 * 60 * 1000;    // 60 minutos
const COOLDOWN_FILE = path.join(PIPELINE, 'cooldowns.json');

function loadCooldowns() {
  try { return JSON.parse(fs.readFileSync(COOLDOWN_FILE, 'utf8')); } catch { return {}; }
}

function saveCooldowns(cd) {
  fs.writeFileSync(COOLDOWN_FILE, JSON.stringify(cd, null, 2));
}

/** Registrar un fallo rápido para un issue+skill. Incrementa el contador y calcula el cooldown. */
function registerFastFail(skill, issue) {
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

/** Verificar si un issue+skill está en cooldown. */
function isInCooldown(skill, issue) {
  const cd = loadCooldowns();
  const key = `${skill}:${issue}`;
  if (!cd[key] || !cd[key].cooldownUntil) return false;
  return new Date(cd[key].cooldownUntil) > new Date();
}

/** Limpiar cooldown de un issue+skill (cuando un agente termina exitosamente). */
function clearCooldown(skill, issue) {
  const cd = loadCooldowns();
  const key = `${skill}:${issue}`;
  if (cd[key]) { delete cd[key]; saveCooldowns(cd); }
}

// --- Perfiles de consumo de recursos por skill ---
// Promedios históricos de CPU/RAM que consume cada tipo de agente.
// Se actualizan al terminar cada agente usando los snapshots de metrics-history.
const SKILL_PROFILES_FILE = path.join(PIPELINE, 'skill-profiles.json');

// Versión del schema de skill-profiles. Incrementar cada vez que cambie la fórmula
// de aprendizaje de `avgMem` / `avgCpu` — al hacerlo, los perfiles viejos se invalidan
// automáticamente en el próximo arranque de pulpo. v2 = aprendizaje por DELTA vs baseline.
const SKILL_PROFILES_SCHEMA_VERSION = 2;

function loadSkillProfiles() {
  try {
    const raw = JSON.parse(fs.readFileSync(SKILL_PROFILES_FILE, 'utf8'));
    // Compatibilidad: si el archivo viejo no tiene _schemaVersion (v1), devolver vacío
    // al próximo save se escribirá con la versión nueva.
    if (!raw || raw._schemaVersion !== SKILL_PROFILES_SCHEMA_VERSION) return {};
    const { _schemaVersion, ...profiles } = raw;
    return profiles;
  } catch { return {}; }
}

function saveSkillProfiles(profiles) {
  const payload = { _schemaVersion: SKILL_PROFILES_SCHEMA_VERSION, ...profiles };
  fs.writeFileSync(SKILL_PROFILES_FILE, JSON.stringify(payload, null, 2));
}

/**
 * Migración one-shot: si skill-profiles.json existe pero tiene un schema viejo
 * (o no tiene schema version), renombrarlo a .bak y empezar de cero con la fórmula
 * nueva. Se ejecuta una sola vez al arrancar pulpo.
 */
function migrateSkillProfilesIfNeeded() {
  try {
    if (!fs.existsSync(SKILL_PROFILES_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(SKILL_PROFILES_FILE, 'utf8'));
    if (raw && raw._schemaVersion === SKILL_PROFILES_SCHEMA_VERSION) return; // ya migrado

    const bakPath = SKILL_PROFILES_FILE + '.v1.bak';
    fs.renameSync(SKILL_PROFILES_FILE, bakPath);
    log('pulpo', `📦 skill-profiles.json migrado a v${SKILL_PROFILES_SCHEMA_VERSION}: backup en ${path.basename(bakPath)}. Los perfiles se reaprenden con la fórmula DELTA.`);
  } catch (e) {
    log('pulpo', `Error migrando skill-profiles: ${e.message}`);
  }
}

/**
 * Registrar el consumo de recursos de un agente que terminó.
 *
 * Estrategia DELTA (v2): aprender el INCREMENTO que el agente introdujo respecto
 * a la baseline inmediatamente previa a su lanzamiento, no el promedio absoluto
 * del sistema durante su vida. Sin esto, infra pesada coexistente (emulador,
 * Edge, Gradle daemons) se cuela en el perfil y el gate predictivo lo vuelve
 * a sumar al usage actual → doble conteo → livelock.
 *
 * Ver pulpo.js comentario de predictResourceImpact y docs/pipeline/gate-predictivo.md
 */
const BASELINE_WINDOW_MS = 60_000; // Ventana de muestras pre-lanzamiento para estimar baseline

function recordSkillResourceUsage(skill, startTime, endTime) {
  try {
    const metricsFile = path.join(PIPELINE, 'metrics-history.jsonl');
    if (!fs.existsSync(metricsFile)) return;

    const lines = fs.readFileSync(metricsFile, 'utf8').split('\n').filter(Boolean);
    const parsed = [];
    for (const line of lines) {
      try { parsed.push(JSON.parse(line)); } catch {}
    }

    // Baseline: muestras inmediatamente PREVIAS al lanzamiento (ventana de 60s)
    const baseline = parsed.filter(s => s.ts >= startTime - BASELINE_WINDOW_MS && s.ts < startTime);
    // Durante: muestras mientras el agente estuvo vivo
    const during = parsed.filter(s => s.ts >= startTime && s.ts <= endTime);

    if (baseline.length === 0 || during.length < 2) {
      // Sin baseline confiable o muy pocas muestras — no aprender (evita corromper el perfil)
      return;
    }

    const avgBaselineCpu = baseline.reduce((sum, s) => sum + s.cpu, 0) / baseline.length;
    const avgBaselineMem = baseline.reduce((sum, s) => sum + s.mem, 0) / baseline.length;
    const avgDuringCpu = during.reduce((sum, s) => sum + s.cpu, 0) / during.length;
    const avgDuringMem = during.reduce((sum, s) => sum + s.mem, 0) / during.length;

    // Delta bruto: cuánto subió el sistema respecto al instante previo a lanzarlo
    const deltaCpu = Math.max(0, avgDuringCpu - avgBaselineCpu);
    const deltaMem = Math.max(0, avgDuringMem - avgBaselineMem);

    // Si había otros agentes Claude corriendo durante la ventana, atribuirles
    // parcialmente el delta (50% de atribución conservadora). Así no inflamos
    // el perfil de este skill con el consumo de los vecinos.
    const avgDuringAgents = during.reduce((sum, s) => sum + Math.max(1, s.agents || 1), 0) / during.length;
    const otherAgents = Math.max(0, avgDuringAgents - 1);
    const shareDenominator = 1 + otherAgents * 0.5;
    const estCpuPerAgent = deltaCpu / shareDenominator;
    const estMemPerAgent = deltaMem / shareDenominator;

    const profiles = loadSkillProfiles();
    const existing = profiles[skill] || { avgCpu: estCpuPerAgent, avgMem: estMemPerAgent, samples: 0 };

    // Rolling average ponderado: más peso a la historia acumulada
    const n = existing.samples;
    const weight = Math.min(n, 20); // Cap en 20 para que samples nuevos sigan teniendo efecto
    profiles[skill] = {
      avgCpu: Math.round(((existing.avgCpu * weight + estCpuPerAgent) / (weight + 1)) * 10) / 10,
      avgMem: Math.round(((existing.avgMem * weight + estMemPerAgent) / (weight + 1)) * 10) / 10,
      samples: n + 1,
      lastUpdated: new Date().toISOString()
    };

    saveSkillProfiles(profiles);
    log('recursos', `📊 Perfil ${skill}: CPU ~${profiles[skill].avgCpu}% MEM ~${profiles[skill].avgMem}% (${profiles[skill].samples} muestras)`);
  } catch (e) {
    log('recursos', `Error registrando perfil de ${skill}: ${e.message}`);
  }
}

/**
 * Gate predictivo: verificar si lanzar un agente de este skill
 * llevaría al sistema por encima de los umbrales seguros.
 * Retorna { safe: bool, reason: string, predicted: { cpu, mem } }
 *
 * Confianza de profiles:
 * - < MIN_RELIABLE_SAMPLES: blend progresivo hacia defaults (pocas muestras = ruido)
 * - Cap máximo por agente: ningún proceso Claude usa >25% CPU o >20% MEM realmente
 * - Profiles >24h sin actualizar: reducir confianza (el sistema puede haber cambiado)
 */
const MIN_RELIABLE_SAMPLES = 5;
const MAX_EST_CPU = 25;  // Cap: ningún agente Claude usa más que esto
const MAX_EST_MEM = 5;   // Cap: un proceso claude.exe real usa ~250-500MB (~1.6-3% en 16GB).
                         // Defensa en profundidad contra perfiles mal aprendidos — ver doc
                         // docs/pipeline/gate-predictivo.md
const PROFILE_STALE_HOURS = 24;

// Skills cuya infra reservada (emulador Android) debe restarse del baseline del gate.
// Razón: el emulador existe PORQUE estos skills lo necesitan; cobrarle su RAM al propio
// skill que lo consume es doble conteo y lleva a livelock (la baseline + el delta del
// agente nunca cierran bajo el umbral porque el emulador ya está presente en la baseline).
const QA_INFRA_SKILLS = new Set(['qa', 'security', 'tester']);

function getEstimatedImpact(profile) {
  const DEFAULT_CPU = 12;
  const DEFAULT_MEM = 3;  // Proceso claude.exe real ~ 250-500 MB en 16 GB

  if (!profile) return { cpu: DEFAULT_CPU, mem: DEFAULT_MEM };

  const samples = profile.samples || 0;
  const hoursOld = (Date.now() - new Date(profile.lastUpdated || 0).getTime()) / 3600000;

  // Cap absoluto: nunca estimar más que el máximo razonable
  let cpu = Math.min(profile.avgCpu, MAX_EST_CPU);
  let mem = Math.min(profile.avgMem, MAX_EST_MEM);

  // Blend hacia defaults si pocas muestras (confianza progresiva)
  if (samples < MIN_RELIABLE_SAMPLES) {
    const confidence = samples / MIN_RELIABLE_SAMPLES; // 0.0 a 1.0
    cpu = DEFAULT_CPU * (1 - confidence) + cpu * confidence;
    mem = DEFAULT_MEM * (1 - confidence) + mem * confidence;
  }

  // Decay si el profile es viejo (>24h sin actualizar)
  if (hoursOld > PROFILE_STALE_HOURS) {
    const decayFactor = Math.max(0.5, 1 - (hoursOld - PROFILE_STALE_HOURS) / 72); // decay gradual
    cpu = DEFAULT_CPU * (1 - decayFactor) + cpu * decayFactor;
    mem = DEFAULT_MEM * (1 - decayFactor) + mem * decayFactor;
  }

  return { cpu: Math.round(cpu * 10) / 10, mem: Math.round(mem * 10) / 10 };
}

/**
 * Lee la RAM ocupada por qemu-system-x86_64-headless.exe como porcentaje del total
 * del sistema. Cacheado por 5 segundos para no pagar un `tasklist` en cada llamada.
 * Devuelve 0 si el emulador no está corriendo o si la medición falla.
 */
let _emulatorMemCache = { ts: 0, percent: 0, running: false };
const EMULATOR_MEM_CACHE_MS = 5000;

function measureEmulatorMemPercent() {
  const now = Date.now();
  if (now - _emulatorMemCache.ts < EMULATOR_MEM_CACHE_MS) return _emulatorMemCache;

  let running = false;
  let percent = 0;
  try {
    const out = execSync(
      'tasklist /FI "IMAGENAME eq qemu-system-x86_64-headless.exe" /NH /FO CSV',
      { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }
    );
    // Formato CSV: "qemu-system-x86_64-headless.exe","1234","Console","1","234,567 KB"
    const line = out.split('\n').find(l => l.toLowerCase().includes('qemu-system'));
    if (line) {
      running = true;
      const cols = line.split('","').map(c => c.replace(/^"|"$/g, ''));
      const memKbStr = (cols[4] || '').replace(/[^\d]/g, '');
      const memKb = parseInt(memKbStr, 10);
      if (!isNaN(memKb) && memKb > 0) {
        const totalBytes = os.totalmem();
        const usedBytes = memKb * 1024;
        percent = Math.round((usedBytes / totalBytes) * 1000) / 10; // 1 decimal
      }
    }
  } catch { /* sin tasklist o sin qemu — degradar silencioso */ }

  _emulatorMemCache = { ts: now, percent, running };
  return _emulatorMemCache;
}

function predictResourceImpact(skill, config, ctx = {}) {
  const profiles = loadSkillProfiles();
  const profile = profiles[skill];
  const usage = getSystemResourceUsage();
  const limits = config.resource_limits || {};
  const maxCpu = limits.orange_max_percent || 80;
  const maxMem = limits.orange_max_percent || 80;

  const est = getEstimatedImpact(profile);

  // Reserva de infra del propio skill: si este skill es QA y el emulador está
  // corriendo, restarlo del baseline — su RAM es un costo de la ventana QA, no
  // del agente individual. Ver QA_INFRA_SKILLS arriba.
  let reservedMem = 0;
  let reservedReason = null;
  if (QA_INFRA_SKILLS.has(skill)) {
    const emu = ctx.emulator || measureEmulatorMemPercent();
    if (emu.running && emu.percent > 0) {
      reservedMem = emu.percent;
      reservedReason = `emulador ${emu.percent}%`;
    }
  }

  const effectiveMemBase = Math.max(0, usage.memPercent - reservedMem);
  const predictedCpu = usage.cpuPercent + est.cpu;
  const predictedMem = effectiveMemBase + est.mem;

  const cpuSafe = predictedCpu < maxCpu;
  const memSafe = predictedMem < maxMem;

  if (cpuSafe && memSafe) {
    return { safe: true, reason: null, predicted: { cpu: predictedCpu, mem: predictedMem }, reserved: reservedMem };
  }

  const reasons = [];
  if (!cpuSafe) reasons.push(`CPU ${usage.cpuPercent}% + ~${est.cpu}% = ${Math.round(predictedCpu)}% (max ${maxCpu}%)`);
  if (!memSafe) {
    const memDetail = reservedReason
      ? `MEM ${usage.memPercent}% − ${reservedReason} + ~${est.mem}% = ${Math.round(predictedMem)}% (max ${maxMem}%)`
      : `MEM ${usage.memPercent}% + ~${est.mem}% = ${Math.round(predictedMem)}% (max ${maxMem}%)`;
    reasons.push(memDetail);
  }

  return {
    safe: false,
    reason: reasons.join(' | '),
    predicted: { cpu: Math.round(predictedCpu), mem: Math.round(predictedMem) },
    reserved: reservedMem
  };
}

// --- Limpieza de Gradle daemons post-agente ---

/**
 * Limpieza de Gradle daemons — DESACTIVADA en ciclo automatico.
 * Ahora es no-op. La limpieza real se hace bajo demanda via limpiarDaemonsOnDemand().
 */
function killGradleDaemonsForCwd(cwd, label) {
  // No-op: el taskkill automatico fue eliminado por causar race conditions fatales
  return 0;
}

/**
 * Limpieza bajo demanda de daemons Gradle/Kotlin huerfanos.
 * Se invoca SOLO desde el comando /limpiar (via Telegram o skill).
 * Protege daemons de worktrees activos.
 * Retorna un resumen de lo que hizo.
 */
function limpiarDaemonsOnDemand() {
  const results = [];
  let totalKilled = 0;

  // Recolectar worktree paths de agentes activos para protegerlos
  const activeWorktreePaths = new Set();
  for (const [, info] of activeProcesses) {
    if (info.worktreePath) {
      activeWorktreePaths.add(info.worktreePath.replace(/\\/g, '/').toLowerCase());
    }
  }
  activeWorktreePaths.add(ROOT.replace(/\\/g, '/').toLowerCase());

  // 1. Buscar Gradle daemons
  try {
    const wmicOut = execSync(
      'wmic process where "name=\'java.exe\'" get ProcessId,ParentProcessId,CommandLine /FORMAT:CSV',
      { encoding: 'utf8', timeout: 10000, windowsHide: true }
    );
    for (const line of wmicOut.split('\n')) {
      if (!line.includes('GradleDaemon') && !line.includes('gradle-launcher')) continue;
      const parts = line.split(',');
      const pid = parts[parts.length - 2]?.trim();
      if (!pid) continue;

      // Proteger por worktree activo
      const lineLower = line.replace(/\\/g, '/').toLowerCase();
      let isActive = false;
      for (const wtPath of activeWorktreePaths) {
        if (lineLower.includes(wtPath)) { isActive = true; break; }
      }
      if (isActive) {
        results.push('Gradle PID ' + pid + ' PROTEGIDO (worktree activo)');
        continue;
      }

      try {
        execSync('taskkill /PID ' + pid + ' /F /T', { timeout: 5000, windowsHide: true, stdio: 'ignore' });
        totalKilled++;
        results.push('Gradle PID ' + pid + ' eliminado');
      } catch {}
    }
  } catch (e) { results.push('Error buscando Gradle: ' + e.message); }

  // 2. Buscar Kotlin compile daemons
  try {
    const wmicOut2 = execSync(
      'wmic process where "name=\'java.exe\'" get ProcessId,CommandLine /FORMAT:CSV',
      { encoding: 'utf8', timeout: 10000, windowsHide: true }
    );
    for (const line of wmicOut2.split('\n')) {
      if (!line.includes('kotlin-compiler') && !line.includes('KotlinCompileDaemon')) continue;
      const match = line.match(/,(\d+)\s*$/);
      if (!match) continue;

      const lineLower = line.replace(/\\/g, '/').toLowerCase();
      let isActive = false;
      for (const wtPath of activeWorktreePaths) {
        if (lineLower.includes(wtPath)) { isActive = true; break; }
      }
      if (isActive) {
        results.push('Kotlin PID ' + match[1] + ' PROTEGIDO (worktree activo)');
        continue;
      }

      try {
        execSync('taskkill /PID ' + match[1] + ' /F /T', { timeout: 5000, windowsHide: true, stdio: 'ignore' });
        totalKilled++;
        results.push('Kotlin PID ' + match[1] + ' eliminado');
      } catch {}
    }
  } catch (e) { results.push('Error buscando Kotlin: ' + e.message); }

  log('limpiar', 'Limpieza bajo demanda: ' + totalKilled + ' proceso(s) eliminados');
  return { totalKilled, results };
}

// --- Estado de procesos activos (PIDs lanzados por el Pulpo) ---

const activeProcesses = new Map(); // key: "skill:issue" → { pid, startTime }

function processKey(skill, issue) { return `${skill}:${issue}`; }

function isProcessAlive(pid) {
  try {
    // En Windows, process.kill(pid, 0) no es confiable — usar tasklist
    if (process.platform === 'win32') {
      const { spawnSync } = require('child_process');
      const result = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], {
        encoding: 'utf8', timeout: 5000, windowsHide: true
      });
      return (result.stdout || '').includes(`"${pid}"`);
    }
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

function countRunningBySkill(skill) {
  // Contar archivos en trabajando/ de TODAS las fases — fuente de verdad real
  // No depender del Map de PIDs (se pierde al reiniciar)
  const config = loadConfig();
  let count = 0;
  for (const [pName, pConfig] of Object.entries(config.pipelines)) {
    for (const fase of pConfig.fases) {
      const trabajandoDir = path.join(PIPELINE, pName, fase, 'trabajando');
      try {
        for (const f of fs.readdirSync(trabajandoDir)) {
          if (f.endsWith(`.${skill}`) && !f.startsWith('.')) count++;
        }
      } catch {}
    }
  }
  return count;
}

/** Skills que cuentan como "desarrolladores" para el límite global */
const DEV_SKILLS = ['backend-dev', 'android-dev', 'web-dev', 'hotfix'];

/** Contar total de devs corriendo en TODAS las fases de TODOS los pipelines */
function countRunningDevs() {
  const config = loadConfig();
  let count = 0;
  for (const [pName, pConfig] of Object.entries(config.pipelines)) {
    for (const fase of pConfig.fases) {
      const trabajandoDir = path.join(PIPELINE, pName, fase, 'trabajando');
      try {
        for (const f of fs.readdirSync(trabajandoDir)) {
          if (f.startsWith('.')) continue;
          const s = f.split('.').pop();
          if (DEV_SKILLS.includes(s)) count++;
        }
      } catch {}
    }
  }
  return count;
}

// --- Resource Monitor: CPU y Memoria del sistema ---

/** Snapshot de CPU para cálculo diferencial (os.cpus() da totales acumulados) */
let lastCpuSnapshot = null;

function cpuSnapshot() {
  const cpus = os.cpus();
  let idle = 0, total = 0;
  for (const cpu of cpus) {
    for (const type in cpu.times) total += cpu.times[type];
    idle += cpu.times.idle;
  }
  return { idle, total };
}

/**
 * Obtener uso de recursos del sistema.
 * CPU se calcula como delta entre dos snapshots (requiere al menos 2 ciclos).
 * Memoria usa os.freemem / os.totalmem.
 */
function getSystemResourceUsage() {
  // Memoria
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const memPercent = Math.round(((totalMem - freeMem) / totalMem) * 100);

  // CPU (diferencial entre snapshots)
  const current = cpuSnapshot();
  let cpuPercent = 0;
  if (lastCpuSnapshot) {
    const idleDelta = current.idle - lastCpuSnapshot.idle;
    const totalDelta = current.total - lastCpuSnapshot.total;
    cpuPercent = totalDelta > 0 ? Math.round(((totalDelta - idleDelta) / totalDelta) * 100) : 0;
  }
  lastCpuSnapshot = current;

  return { cpuPercent, memPercent };
}

// =============================================================================
// SISTEMA DE PRESIÓN DE RECURSOS — Graduado (green/yellow/orange/red)
// En vez de binario "sobrecargado sí/no", responde proporcionalmente.
// =============================================================================

const PRESSURE_LEVELS = { GREEN: 'green', YELLOW: 'yellow', ORANGE: 'orange', RED: 'red' };
let lastResourceLog = 0;
let lastPressureLevel = PRESSURE_LEVELS.GREEN;
let lastEmergencyTelegramTs = 0;       // Cooldown para NO spamear Telegram en RED
let consecutiveRedCycles = 0;           // Cuántos ciclos seguidos en RED (solo para logging)

// --- Deadlock breaker: detecta cuando TODOS los candidatos son bloqueados por el gate predictivo ---
let consecutiveAllBlockedCycles = 0;    // Ciclos consecutivos donde el gate bloqueó TODO
let lastDeadlockTelegramTs = 0;
const DEADLOCK_TELEGRAM_COOLDOWN = 600000; // 10 min entre notificaciones de deadlock
const DEADLOCK_TIER1_CYCLES = 3;        // ~1.5 min: intentar liberar emulador idle
const DEADLOCK_TIER2_CYCLES = 6;        // ~3 min: forzar lanzamiento del más liviano
const EMERGENCY_TELEGRAM_COOLDOWN = 300000; // 5 minutos entre mensajes de RED
let proactiveCycleCounter = 0;

/**
 * Determinar el nivel de presión del sistema basado en CPU y RAM.
 * Retorna { level, cpuPercent, memPercent, maxOfBoth }
 */
function getResourcePressure(config) {
  const limits = config.resource_limits || {};
  const greenMax  = limits.green_max_percent  || 50;
  const yellowMax = limits.yellow_max_percent || 65;
  const orangeMax = limits.orange_max_percent || 80;
  // red = todo lo que esté por encima de orange

  const { cpuPercent, memPercent } = getSystemResourceUsage();
  const maxOfBoth = Math.max(cpuPercent, memPercent);

  let level;
  if (maxOfBoth < greenMax)       level = PRESSURE_LEVELS.GREEN;
  else if (maxOfBoth < yellowMax) level = PRESSURE_LEVELS.YELLOW;
  else if (maxOfBoth < orangeMax) level = PRESSURE_LEVELS.ORANGE;
  else                            level = PRESSURE_LEVELS.RED;

  return { level, cpuPercent, memPercent, maxOfBoth };
}

/**
 * Obtener el multiplicador de concurrencia según la presión.
 * GREEN=1.0, YELLOW=0.5, ORANGE=solo 1 agente, RED=0
 */
function concurrencyMultiplier(level) {
  switch (level) {
    case PRESSURE_LEVELS.GREEN:  return 1.0;
    case PRESSURE_LEVELS.YELLOW: return 0.5;
    case PRESSURE_LEVELS.ORANGE: return 0;   // Se maneja especial: max 1 total
    case PRESSURE_LEVELS.RED:    return 0;
    default: return 1.0;
  }
}

/**
 * Verificar si el sistema permite lanzar un nuevo agente.
 * Reemplaza isSystemOverloaded() con lógica graduada:
 * - GREEN: todo OK, capacidad completa
 * - YELLOW: limpieza suave + concurrencia reducida al 50%
 * - ORANGE: limpieza agresiva + máximo 1 agente total
 * - RED: bloqueo total + kill de emergencia
 */
function isSystemOverloaded(config) {
  const pressure = getResourcePressure(config);
  const { level, cpuPercent, memPercent } = pressure;

  // Transición de nivel → logear y actuar
  const levelChanged = level !== lastPressureLevel;
  if (levelChanged) {
    const emoji = { green: '🟢', yellow: '🟡', orange: '🟠', red: '🔴' }[level];
    log('recursos', `${emoji} Presión cambió: ${lastPressureLevel} → ${level} — CPU: ${cpuPercent}% | RAM: ${memPercent}%`);
    lastPressureLevel = level;
  }

  // Acciones según nivel
  if (level === PRESSURE_LEVELS.GREEN) {
    consecutiveRedCycles = 0; // Reset si bajamos a green
    // Loguear cada 60s
    const now = Date.now();
    if (now - lastResourceLog > 60000) {
      log('recursos', `🟢 OK — CPU: ${cpuPercent}% | RAM: ${memPercent}%`);
      lastResourceLog = now;
    }
    return false;
  }

  if (level === PRESSURE_LEVELS.YELLOW) {
    consecutiveRedCycles = 0; // Reset si bajamos a yellow
    // Limpieza suave: solo Gradle daemons huérfanos
    const { freed, killed } = tryFreeResources('soft');
    if (freed) log('recursos', `🟡 Limpieza suave: ${killed.join(', ')}`);
    // Re-evaluar — si bajó a green, permitir
    const after = getResourcePressure(config);
    if (after.level === PRESSURE_LEVELS.GREEN) return false;
    // Yellow permite lanzar pero con concurrencia reducida (se aplica en brazoLanzamiento)
    log('recursos', `🟡 YELLOW — CPU: ${cpuPercent}% | RAM: ${memPercent}% — concurrencia reducida`);
    lastResourceLog = Date.now();
    return false; // No bloquea, pero brazoLanzamiento reduce slots
  }

  if (level === PRESSURE_LEVELS.ORANGE) {
    consecutiveRedCycles = 0; // Reset si bajamos a orange
    // Diagnóstico: ¿qué está consumiendo?
    if (config.resource_limits?.diagnostic_on_orange !== false) {
      logTopConsumers();
    }
    // Limpieza agresiva: daemons + kotlin daemons
    const { freed, killed } = tryFreeResources('aggressive');
    if (freed) {
      log('recursos', `🟠 Limpieza agresiva: ${killed.join(', ')}`);
      // Re-evaluar
      const after = getResourcePressure(config);
      if (after.level === PRESSURE_LEVELS.GREEN || after.level === PRESSURE_LEVELS.YELLOW) {
        return false;
      }
    }
    // Orange: permitir solo si hay menos de 1 agente total
    const totalRunning = countTotalRunningAgents(config);
    if (totalRunning >= 1) {
      log('recursos', `🟠 ORANGE — ${totalRunning} agente(s) corriendo, bloqueando nuevos — CPU: ${cpuPercent}% | RAM: ${memPercent}%`);
      lastResourceLog = Date.now();
      return true;
    }
    return false; // Dejar pasar 1 agente
  }

  // RED: bloqueo total + limpieza de daemons (SIN kill de agentes/procesos Claude)
  // Estrategia: solo limpiar Gradle/Kotlin huérfanos y esperar a que los procesos
  // terminen naturalmente. NUNCA matar agentes ni builds en curso.
  consecutiveRedCycles++;

  // Limpieza agresiva de daemons (NO mata procesos Claude — solo Gradle/Kotlin sin worktree)
  const { freed, killed } = tryFreeResources('aggressive');
  if (freed) {
    log('recursos', `🔴 Limpieza de daemons en RED: ${killed.join(', ')}`);
  }

  // Loguear cada 60s
  const now = Date.now();
  if (now - lastResourceLog > 60000) {
    log('recursos', `🔴 RED — BLOQUEADO (ciclo ${consecutiveRedCycles}) — CPU: ${cpuPercent}% | RAM: ${memPercent}% — esperando que procesos terminen`);
    lastResourceLog = now;
  }

  // Notificar por Telegram UNA vez cada 5 minutos
  if (now - lastEmergencyTelegramTs > EMERGENCY_TELEGRAM_COOLDOWN) {
    logTopConsumers();
    sendTelegram(`🔴 Recursos críticos — CPU: ${cpuPercent}% | RAM: ${memPercent}% — bloqueando nuevos lanzamientos, esperando que los activos terminen (sin kill de emergencia)`);
    lastEmergencyTelegramTs = now;
  }

  // Re-evaluar por si la limpieza de daemons bajó la presión
  if (freed) {
    const after = getResourcePressure(config);
    if (after.level !== PRESSURE_LEVELS.RED) {
      return isSystemOverloaded(config);
    }
  }

  return true;
}

/**
 * Contar total de agentes corriendo en todas las fases (filesystem = fuente de verdad)
 */
function countTotalRunningAgents(config) {
  let count = 0;
  for (const [pName, pConfig] of Object.entries(config.pipelines)) {
    for (const fase of pConfig.fases) {
      const trabajandoDir = path.join(PIPELINE, pName, fase, 'trabajando');
      try {
        for (const f of fs.readdirSync(trabajandoDir)) {
          if (!f.startsWith('.')) count++;
        }
      } catch {}
    }
  }
  return count;
}

// =============================================================================
// GATE DE EVIDENCIA QA — Validación automática de evidencia antes de promover
// Si QA dice "aprobado" pero no hay video real con audio, se fuerza rechazo.
// =============================================================================

const QA_VIDEO_MIN_SIZE_BYTES = 51200;  // 50KB — swiftshader genera mp4s de ~150-200KB; antes usábamos 200KB y rechazaba falsamente.
const QA_MIN_FRAME_PNGS = 3;             // Mínimo de frames PNG del agente QA para considerar evidencia alternativa válida.

/**
 * Validar que el resultado del QA tiene evidencia real.
 * Retorna array de problemas encontrados (vacío = OK).
 *
 * Política: aceptar como evidencia válida CUALQUIERA de estas:
 *   a) Un .mp4 en qa/evidence/{issue}/ o qa/recordings/ con tamaño ≥ 50KB.
 *   b) Al menos N frames PNG del agente en qa/evidence/{issue}/ (fallback cuando
 *      el screenrecord del emulador queda chico por swiftshader).
 * El campo `video_size_kb` del YAML es solo informativo; si el archivo en disco
 * cumple el umbral, se acepta.
 */
function validateQaEvidence(issue, qaData) {
  const ROOT = path.resolve(PIPELINE, '..');
  const evidenceDir = path.join(ROOT, 'qa', 'evidence', String(issue));
  const recordingsDir = path.join(ROOT, 'qa', 'recordings');

  let bestVideoKb = 0;
  let pngFrames = 0;

  for (const dir of [evidenceDir, recordingsDir]) {
    try {
      for (const f of fs.readdirSync(dir)) {
        const full = path.join(dir, f);
        let stat;
        try { stat = fs.statSync(full); } catch { continue; }
        if (!stat.isFile()) continue;
        if (f.endsWith('.mp4') && stat.size > bestVideoKb * 1024) {
          bestVideoKb = Math.round(stat.size / 1024);
        } else if (f.endsWith('.png') && dir === evidenceDir && /qa-|frame|nav-/i.test(f)) {
          pngFrames++;
        }
      }
    } catch { /* dir no existe */ }
  }

  const videoOk = bestVideoKb * 1024 >= QA_VIDEO_MIN_SIZE_BYTES;
  const framesOk = pngFrames >= QA_MIN_FRAME_PNGS;

  if (videoOk || framesOk) return [];

  const issues = [];
  if (bestVideoKb > 0) {
    issues.push(`video más grande encontrado es ${bestVideoKb}KB (<${Math.round(QA_VIDEO_MIN_SIZE_BYTES/1024)}KB) y solo ${pngFrames} frame(s) PNG (mínimo ${QA_MIN_FRAME_PNGS})`);
  } else {
    issues.push(`sin evidencia: no hay .mp4 en qa/evidence/${issue}/ ni qa/recordings/, ni frames PNG suficientes (${pngFrames}/${QA_MIN_FRAME_PNGS})`);
  }
  return issues;
}

// =============================================================================
// QA PRIORITY WINDOW — Cuando se acumulan issues de verificación sin poder correr,
// bloquea nuevos lanzamientos dev para liberar recursos y dar prioridad a QA.
// Puntos 1-3 de la propuesta conversada con Leo (2026-04-02).
// =============================================================================

let qaPriorityActive = false;
let qaPriorityActivatedAt = 0;
let qaFirstBlockedAt = 0;           // Momento en que se detectó acumulación QA sin poder lanzar
let qaPriorityNotifiedTelegram = false;
let qaPriorityManual = false;       // true si fue activada manualmente desde el dashboard
let qaPrioritySafetyNotified = false; // true si ya se envió notificación de safety timeout

// =============================================================================
// BUILD PRIORITY WINDOW — Protección de builds contra kill de emergencia y
// priorización de recursos cuando hay builds en cola.
// Cuando se acumulan issues esperando build, el Pulpo bloquea nuevos
// lanzamientos dev para liberar recursos y dar prioridad al build.
// =============================================================================
let buildPriorityActive = false;
let buildPriorityActivatedAt = 0;
let buildFirstBlockedAt = 0;
let buildPriorityNotifiedTelegram = false;
let buildPriorityManual = false;    // true si fue activada manualmente desde el dashboard
let buildPrioritySafetyNotified = false; // true si ya se envió notificación de safety timeout

const PRIORITY_WINDOWS_FILE = path.join(PIPELINE, 'priority-windows.json');

/**
 * Restaurar el estado de priority windows desde disco al iniciar.
 * Sin esto, un restart del pulpo pierde la ventana activa y lanza dev
 * aunque QA/Build estuviera bloqueando.
 */
function restorePriorityWindows() {
  try {
    if (!fs.existsSync(PRIORITY_WINDOWS_FILE)) return;
    const data = JSON.parse(fs.readFileSync(PRIORITY_WINDOWS_FILE, 'utf8'));
    if (data.qa?.active) {
      qaPriorityActive = true;
      qaPriorityActivatedAt = data.qa.activatedAt || Date.now();
      qaPriorityManual = data.qa.manual || false;
      qaPriorityNotifiedTelegram = true; // Ya se notificó antes del restart
      log('qa-priority', `♻️ QA Priority Window restaurada desde disco (activada ${new Date(qaPriorityActivatedAt).toISOString()})`);
    }
    if (data.build?.active) {
      buildPriorityActive = true;
      buildPriorityActivatedAt = data.build.activatedAt || Date.now();
      buildPriorityManual = data.build.manual || false;
      buildPriorityNotifiedTelegram = true;
      log('build-priority', `♻️ Build Priority Window restaurada desde disco (activada ${new Date(buildPriorityActivatedAt).toISOString()})`);
    }
  } catch (e) {
    log('priority', `⚠️ Error restaurando priority windows: ${e.message}`);
  }
}

// Restaurar al cargar el módulo
restorePriorityWindows();

/**
 * Persistir el estado actual de las priority windows a disco.
 * El dashboard lee este archivo para mostrar estado y el usuario puede
 * activar/desactivar ventanas manualmente escribiendo en él.
 */
function persistPriorityWindows() {
  const state = {
    qa: {
      active: qaPriorityActive,
      activatedAt: qaPriorityActivatedAt || null,
      manual: qaPriorityManual
    },
    build: {
      active: buildPriorityActive,
      activatedAt: buildPriorityActivatedAt || null,
      manual: buildPriorityManual
    },
    updatedAt: Date.now()
  };
  try { fs.writeFileSync(PRIORITY_WINDOWS_FILE, JSON.stringify(state, null, 2)); } catch {}
}

/**
 * Leer activaciones/desactivaciones manuales desde el archivo.
 * El dashboard escribe { qa: { manualOverride: true/false }, build: { manualOverride: true/false } }
 * y el Pulpo las consume acá.
 */
function readManualPriorityOverrides() {
  try {
    const data = JSON.parse(fs.readFileSync(PRIORITY_WINDOWS_FILE, 'utf8'));

    // QA manual override — al activar manual, AUTOEXCLUIR Build (las ventanas son
    // mutuamente exclusivas; QA > Build > Dev). Sin esto quedaban las dos activas
    // a la vez cuando se activaba una manualmente y la otra cruzaba el umbral.
    if (data.qa?.manualOverride === true && !qaPriorityActive) {
      qaPriorityActive = true;
      qaPriorityManual = true;
      qaPriorityActivatedAt = Date.now();
      qaPriorityNotifiedTelegram = false;
      log('qa-priority', '🔧 QA Priority Window ACTIVADA MANUALMENTE desde dashboard');
      sendTelegram('🔧 QA Priority Window activada manualmente desde el dashboard. Dev y build bloqueados hasta desactivación.');
      // Autoexcluir Build (incluso si era manual — el último override gana)
      if (buildPriorityActive) {
        log('build-priority', '🔄 Build Priority desactivada por activación manual de QA (autoexcluyentes)');
        buildPriorityActive = false;
        buildPriorityManual = false;
        buildPriorityActivatedAt = 0;
        buildFirstBlockedAt = 0;
        buildPriorityNotifiedTelegram = false;
        buildPrioritySafetyNotified = false;
      }
      persistPriorityWindows();
    } else if (data.qa?.manualOverride === false && qaPriorityActive) {
      qaPriorityActive = false;
      qaPriorityManual = false;
      qaPriorityActivatedAt = 0;
      qaFirstBlockedAt = 0;
      log('qa-priority', '🔧 QA Priority Window DESACTIVADA MANUALMENTE desde dashboard');
      persistPriorityWindows();
    }

    // Build manual override — autoexclusión simétrica con QA
    if (data.build?.manualOverride === true && !buildPriorityActive) {
      buildPriorityActive = true;
      buildPriorityManual = true;
      buildPriorityActivatedAt = Date.now();
      buildPriorityNotifiedTelegram = false;
      log('build-priority', '🔧 Build Priority Window ACTIVADA MANUALMENTE desde dashboard');
      sendTelegram('🔧 Build Priority Window activada manualmente desde el dashboard. Dev bloqueado hasta desactivación.');
      // Autoexcluir QA (incluso si era manual — el último override gana)
      if (qaPriorityActive) {
        log('qa-priority', '🔄 QA Priority desactivada por activación manual de Build (autoexcluyentes)');
        qaPriorityActive = false;
        qaPriorityManual = false;
        qaPriorityActivatedAt = 0;
        qaFirstBlockedAt = 0;
        qaPriorityNotifiedTelegram = false;
        qaPrioritySafetyNotified = false;
      }
      persistPriorityWindows();
    } else if (data.build?.manualOverride === false && buildPriorityActive) {
      buildPriorityActive = false;
      buildPriorityManual = false;
      buildPriorityActivatedAt = 0;
      buildFirstBlockedAt = 0;
      log('build-priority', '🔧 Build Priority Window DESACTIVADA MANUALMENTE desde dashboard');
      persistPriorityWindows();
    }

    // Limpiar overrides consumidos
    if (data.qa?.manualOverride !== undefined || data.build?.manualOverride !== undefined) {
      delete data.qa?.manualOverride;
      delete data.build?.manualOverride;
      fs.writeFileSync(PRIORITY_WINDOWS_FILE, JSON.stringify(data, null, 2));
    }
  } catch {}
}

/**
 * Contar issues pendientes en fase verificación (todas las pipelines).
 */
function countPendingVerificacion(config) {
  let count = 0;
  for (const [pName, pConfig] of Object.entries(config.pipelines)) {
    if (!pConfig.fases.includes('verificacion')) continue;
    const pendDir = path.join(PIPELINE, pName, 'verificacion', 'pendiente');
    const files = listWorkFiles(pendDir);
    for (const f of files) {
      const issue = issueFromFile(f.name);
      const labels = getIssueLabels(issue);
      if (!labels.includes('blocked:dependencies')) count++;
    }
  }
  return count;
}

/**
 * Detectar si hay agentes de dev corriendo (archivos en trabajando/ de fase dev).
 */
function countRunningDev(config) {
  let count = 0;
  for (const [pName, pConfig] of Object.entries(config.pipelines)) {
    if (!pConfig.fases.includes('dev')) continue;
    const trabajandoDir = path.join(PIPELINE, pName, 'dev', 'trabajando');
    count += listWorkFiles(trabajandoDir).length;
  }
  return count;
}

/**
 * Evaluar si debe activarse/desactivarse la QA Priority Window.
 * Modelo V2: ventanas autoexcluyentes, QA > Build > Dev.
 * - Activación inmediata cuando cola >= umbral configurable
 * - Sin timeout fijo (corre hasta vaciar cola)
 * - Timeout de seguridad: notifica Telegram si no completa en N horas (no cierra)
 * Retorna true si QA Priority está activa (dev y build deben bloquearse).
 */
function evaluateQaPriority(config) {
  const limits = config.resource_limits || {};
  const threshold = limits.priority_windows_activation_threshold || 3;
  const safetyTimeoutHours = limits.priority_windows_safety_timeout_hours || 2;
  const now = Date.now();

  const pendingQa = countPendingVerificacion(config);

  // ---- Desactivación ----
  if (qaPriorityActive) {
    // Si fue activada manualmente, solo desactivar por override manual (no por cola vacía)
    if (!qaPriorityManual && pendingQa === 0) {
      log('qa-priority', '🟢 QA Priority Window desactivada — cola de verificación vacía');
      if (qaPriorityNotifiedTelegram) {
        sendTelegram('✅ QA Priority Window terminó — se procesaron todos los issues de verificación pendientes. Pipeline en modo normal.');
      }
      qaPriorityActive = false;
      qaPriorityActivatedAt = 0;
      qaFirstBlockedAt = 0;
      qaPriorityNotifiedTelegram = false;
      persistPriorityWindows();
      return false;
    }
    // Timeout de seguridad: notificar si lleva mucho sin completar (pero NO cerrar)
    const elapsedHours = (now - qaPriorityActivatedAt) / (3600 * 1000);
    if (elapsedHours >= safetyTimeoutHours && !qaPrioritySafetyNotified) {
      qaPrioritySafetyNotified = true;
      log('qa-priority', `⚠️ QA Priority Window lleva ${Math.round(elapsedHours)}h activa sin completar — notificando`);
      sendTelegram(`⚠️ QA Priority Window lleva ${Math.round(elapsedHours)}h activa con ${pendingQa} issues pendientes. Verificá desde el dashboard si hay un problema.`);
    }
    return true; // Sigue activa — sin timeout fijo
  }

  // ---- Activación ----
  // Activación inmediata cuando cola >= umbral (sin esperar N minutos)
  if (pendingQa >= threshold) {
    // Respetar override manual de Build: si el operador activó Build a mano,
    // NO auto-activar QA en paralelo (las ventanas son autoexcluyentes).
    // QA quedará en espera hasta que Build manual se desactive.
    if (buildPriorityActive && buildPriorityManual) {
      if (qaFirstBlockedAt === 0) {
        qaFirstBlockedAt = now;
        log('qa-priority', `⏳ QA Priority en espera (${pendingQa} pendientes) — Build manual activa, autoexcluyentes`);
      }
      return false;
    }
    // QA siempre gana sobre Build automática
    if (buildPriorityActive && !buildPriorityManual) {
      log('qa-priority', `🔄 QA Priority desplaza Build Priority (QA > Build) — ${pendingQa} issues QA pendientes`);
      buildPriorityActive = false;
      buildPriorityActivatedAt = 0;
      buildFirstBlockedAt = 0;
      buildPriorityNotifiedTelegram = false;
      buildPrioritySafetyNotified = false;
    }
    qaPriorityActive = true;
    qaPriorityActivatedAt = now;
    qaPriorityNotifiedTelegram = true;
    qaPrioritySafetyNotified = false;
    log('qa-priority', `🚨 QA PRIORITY WINDOW ACTIVADA — ${pendingQa} issues en verificación (umbral: ${threshold}). Bloqueando dev y build.`);
    sendTelegram(`🚨 QA Priority Window activada — ${pendingQa} issues esperando verificación (umbral: ${threshold}). Dev y build bloqueados hasta vaciar cola.`);
    persistPriorityWindows();
    return true;
  } else {
    // Si bajó del umbral, resetear
    if (qaFirstBlockedAt !== 0) {
      log('qa-priority', `✅ Cola QA bajó a ${pendingQa} (< ${threshold}) — modo normal`);
      qaFirstBlockedAt = 0;
    }
  }

  return false;
}

/**
 * Contar issues pendientes en fase build (todas las pipelines).
 */
function countPendingBuild(config) {
  let count = 0;
  for (const [pName, pConfig] of Object.entries(config.pipelines)) {
    if (!pConfig.fases.includes('build')) continue;
    const pendDir = path.join(PIPELINE, pName, 'build', 'pendiente');
    const files = listWorkFiles(pendDir);
    for (const f of files) {
      const issue = issueFromFile(f.name);
      const labels = getIssueLabels(issue);
      if (!labels.includes('blocked:dependencies')) count++;
    }
  }
  return count;
}

/**
 * Contar builds actualmente en ejecución (archivos en trabajando/ de fase build).
 */
function countRunningBuild(config) {
  let count = 0;
  for (const [pName, pConfig] of Object.entries(config.pipelines)) {
    if (!pConfig.fases.includes('build')) continue;
    const trabajandoDir = path.join(PIPELINE, pName, 'build', 'trabajando');
    count += listWorkFiles(trabajandoDir).length;
  }
  return count;
}

/**
 * Evaluar si debe activarse/desactivarse la Build Priority Window.
 * Modelo V2: ventanas autoexcluyentes, QA > Build > Dev.
 * - Activación inmediata cuando cola >= umbral configurable
 * - Sin timeout fijo (corre hasta vaciar cola)
 * - NO se activa si QA Priority ya está activa (QA > Build)
 * Retorna true si Build Priority está activa (dev debe bloquearse).
 */
function evaluateBuildPriority(config) {
  const limits = config.resource_limits || {};
  const threshold = limits.priority_windows_activation_threshold || 3;
  const safetyTimeoutHours = limits.priority_windows_safety_timeout_hours || 2;
  const now = Date.now();

  const pendingBuild = countPendingBuild(config);
  const runningBuild = countRunningBuild(config);

  // ---- Desactivación ----
  if (buildPriorityActive) {
    // Si QA Priority se activó, Build cede (QA > Build) — excepto si fue manual
    if (qaPriorityActive && !buildPriorityManual) {
      log('build-priority', '🔄 Build Priority cede ante QA Priority (QA > Build)');
      buildPriorityActive = false;
      buildPriorityActivatedAt = 0;
      buildFirstBlockedAt = 0;
      buildPriorityNotifiedTelegram = false;
      buildPrioritySafetyNotified = false;
      persistPriorityWindows();
      return false;
    }
    // Si fue activada manualmente, solo desactivar por override manual (no por cola vacía)
    if (!buildPriorityManual && pendingBuild === 0 && runningBuild === 0) {
      log('build-priority', '🟢 Build Priority Window desactivada — cola de build vacía');
      if (buildPriorityNotifiedTelegram) {
        sendTelegram('✅ Build Priority Window terminó — builds completados. Pipeline en modo normal.');
      }
      buildPriorityActive = false;
      buildPriorityActivatedAt = 0;
      buildFirstBlockedAt = 0;
      buildPriorityNotifiedTelegram = false;
      buildPrioritySafetyNotified = false;
      persistPriorityWindows();
      return false;
    }
    // Timeout de seguridad: notificar si lleva mucho sin completar (pero NO cerrar)
    const elapsedHours = (now - buildPriorityActivatedAt) / (3600 * 1000);
    if (elapsedHours >= safetyTimeoutHours && !buildPrioritySafetyNotified) {
      buildPrioritySafetyNotified = true;
      log('build-priority', `⚠️ Build Priority Window lleva ${Math.round(elapsedHours)}h activa sin completar — notificando`);
      sendTelegram(`⚠️ Build Priority Window lleva ${Math.round(elapsedHours)}h activa con ${pendingBuild} builds pendientes. Verificá desde el dashboard.`);
    }
    return true; // Sigue activa — sin timeout fijo
  }

  // ---- Activación ----
  // NO activar si QA Priority ya está activa (QA > Build, autoexcluyentes)
  if (qaPriorityActive) return false;

  // Activación inmediata cuando cola >= umbral
  if (pendingBuild >= threshold) {
    buildPriorityActive = true;
    buildPriorityActivatedAt = now;
    buildPriorityNotifiedTelegram = true;
    buildPrioritySafetyNotified = false;
    log('build-priority', `🔨 BUILD PRIORITY WINDOW ACTIVADA — ${pendingBuild} issues esperando build (umbral: ${threshold}). Bloqueando dev.`);
    sendTelegram(`🔨 Build Priority Window activada — ${pendingBuild} issues esperando build (umbral: ${threshold}). Dev bloqueado hasta vaciar cola.`);
    persistPriorityWindows();
    return true;
  } else {
    if (buildFirstBlockedAt !== 0) {
      log('build-priority', `✅ Cola build bajó a ${pendingBuild} (< ${threshold}) — modo normal`);
      buildFirstBlockedAt = 0;
    }
  }

  return false;
}

/**
 * Logear los top 5 procesos por consumo de RAM.
 * Esto ayuda a diagnosticar QUÉ está consumiendo antes de actuar a ciegas.
 */
function logTopConsumers() {
  try {
    const wmicOut = execSync(
      'wmic process get Name,ProcessId,WorkingSetSize /FORMAT:CSV',
      { encoding: 'utf8', timeout: 15000, windowsHide: true }
    );
    const processes = [];
    for (const line of wmicOut.split('\n')) {
      const parts = line.trim().split(',');
      if (parts.length < 4) continue;
      const name = parts[1];
      const pid = parts[2];
      const memBytes = parseInt(parts[3], 10);
      if (!name || !memBytes || isNaN(memBytes)) continue;
      processes.push({ name, pid, memMB: Math.round(memBytes / 1048576) });
    }
    processes.sort((a, b) => b.memMB - a.memMB);
    const top5 = processes.slice(0, 5);
    const lines = top5.map((p, i) => `  ${i + 1}. ${p.name} (PID ${p.pid}): ${p.memMB}MB`);
    log('diagnostico', `Top 5 procesos por RAM:\n${lines.join('\n')}`);
  } catch (e) {
    log('diagnostico', `Error obteniendo top consumers: ${e.message}`);
  }
}

/**
 * Liberar recursos: solo limpieza del mapa interno de activeProcesses.
 * El taskkill de Gradle/Kotlin daemons fue ELIMINADO del ciclo automatico.
 * Motivo: bajo carga alta, las heuristicas (wmic, worktree path, PID tree) fallan
 * y matan builds/agentes legitimos, causando loops infinitos de rebotes.
 * La limpieza de daemons ahora es SOLO bajo demanda via comando /limpiar.
 */
function tryFreeResources(mode = 'soft') {
  const killed = [];

  try {
    // Limpieza de agentes stale del mapa interno (no mata procesos)
    let staleAgents = 0;
    for (const [key, info] of activeProcesses) {
      // Grace period: nunca limpiar agentes registrados hace menos de 30 min
      const ageMs = Date.now() - (info.startTime || 0);
      if (ageMs < 30 * 60 * 1000) continue;
      if (!isProcessAlive(info.pid)) {
        activeProcesses.delete(key);
        staleAgents++;
      }
    }
    if (staleAgents > 0) killed.push(staleAgents + ' agente(s) stale');

  } catch (e) {
    log('free-resources', 'Error durante limpieza (' + mode + '): ' + e.message);
  }

  if (killed.length > 0) {
    log('free-resources', '[' + mode + '] Recursos liberados: ' + killed.join(', '));
  }

  return { freed: killed.length > 0, killed };
}

/**
 * Solicitar apagado del emulador QA si no hay nada en fase verificacion/trabajando.
 * Delega al servicio-emulador via cola (no ejecuta directamente).
 * Retorna true si encoló el pedido de stop.
 */
// Grace period: después de levantar el emulador (boot_completed), no apagarlo
// durante este tiempo. Evita el loop preflight→start→idle→stop→preflight que
// corrompía el quickboot. Anclado a qa-env-state.lastStartedAt, que qa-environment.js
// escribe recién DESPUÉS de confirmar sys.boot_completed=1.
const EMULATOR_IDLE_GRACE_MS = 3 * 60 * 1000; // 3 minutos de warm-up protegido

function shutdownIdleEmulator(config) {
  try {
    // ¿Hay algo en verificacion/trabajando O pendiente?
    // Si hay QA pendiente encolada, el emulador va a ser necesario inmediatamente.
    for (const [pName, pConfig] of Object.entries(config.pipelines)) {
      if (!pConfig.fases.includes('verificacion')) continue;
      const verifDir = fasePath(pName, 'verificacion');
      const trabajando = listWorkFiles(path.join(verifDir, 'trabajando'));
      if (trabajando.length > 0) return false; // Hay agentes QA corriendo
      const pendiente = listWorkFiles(path.join(verifDir, 'pendiente'));
      if (pendiente.length > 0) return false; // Hay QA pendiente en cola
    }

    // ¿Está corriendo el emulador? Verificar state file Y por nombre de proceso
    let emulatorRunning = false;
    let lastStartedAt = 0;

    // Check 1: state file
    const stateFile = path.join(PIPELINE, 'qa-env-state.json');
    if (fs.existsSync(stateFile)) {
      try {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        const emulatorPid = state.emulator || state.emulador;
        if (emulatorPid && isProcessAlive(emulatorPid)) emulatorRunning = true;
        lastStartedAt = state.lastStartedAt || 0;
      } catch {}
    }

    // Check 2: buscar proceso QEMU por nombre (el state puede perder track del PID)
    if (!emulatorRunning) {
      try {
        const out = execSync('tasklist /FI "IMAGENAME eq qemu-system-x86_64-headless.exe" /NH /FO CSV',
          { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
        if (out.includes('qemu-system')) emulatorRunning = true;
      } catch {}
    }

    if (!emulatorRunning) return false;

    // Grace period: no apagar si estamos dentro de la ventana post-boot.
    // lastStartedAt se actualiza en qa-environment.js DESPUÉS de boot_completed.
    const ageMs = Date.now() - lastStartedAt;
    if (lastStartedAt > 0 && ageMs < EMULATOR_IDLE_GRACE_MS) {
      const remaining = Math.round((EMULATOR_IDLE_GRACE_MS - ageMs) / 1000);
      log('recursos', `⏳ Emulador dentro de grace period post-boot (${remaining}s restantes) — no apagar`);
      return false;
    }

    // Encolar stop al servicio-emulador (no ejecutar directo)
    log('recursos', '🔌 Encolando stop de emulador idle para liberar ~2.5GB RAM');
    requestEmulator('stop', 'pulpo-idle', null, 'Cola de verificación vacía, sin agentes QA activos');
    return true;
  } catch (e) {
    log('recursos', `Error verificando emulador idle: ${e.message}`);
    return false;
  }
}

/**
 * Deadlock breaker: cuando el gate predictivo bloquea TODOS los candidatos durante
 * varios ciclos consecutivos, escalar progresivamente para salir del deadlock.
 *
 * Tier 1 (3 ciclos / ~1.5min): Apagar emulador idle + resetear profiles poco confiables
 * Tier 2 (6 ciclos / ~3min): Forzar lanzamiento del candidato más liviano con threshold relajado
 */
function handleDeadlock(candidates, config) {
  if (consecutiveAllBlockedCycles < DEADLOCK_TIER1_CYCLES) return null;

  const now = Date.now();

  // --- TIER 1: liberar recursos pasivos ---
  if (consecutiveAllBlockedCycles === DEADLOCK_TIER1_CYCLES) {
    log('deadlock', `⚠️ Deadlock detectado: ${consecutiveAllBlockedCycles} ciclos con TODOS los candidatos bloqueados. Tier 1: liberando recursos pasivos.`);

    // Apagar emulador si está idle
    const emulatorKilled = shutdownIdleEmulator(config);
    if (emulatorKilled) {
      log('deadlock', '🔌 Emulador idle apagado — re-evaluando en el próximo ciclo');
      if (now - lastDeadlockTelegramTs > DEADLOCK_TELEGRAM_COOLDOWN) {
        sendTelegram('⚠️ Pipeline deadlocked — apagué el emulador idle para liberar RAM. Se re-levanta solo cuando haga falta.');
        lastDeadlockTelegramTs = now;
      }
    }

    // Resetear profiles con pocas muestras (no son confiables)
    const profiles = loadSkillProfiles();
    let resetCount = 0;
    for (const [skill, profile] of Object.entries(profiles)) {
      if ((profile.samples || 0) < MIN_RELIABLE_SAMPLES) {
        delete profiles[skill];
        resetCount++;
      }
    }
    if (resetCount > 0) {
      saveSkillProfiles(profiles);
      log('deadlock', `🗑️ Reseteados ${resetCount} profiles con < ${MIN_RELIABLE_SAMPLES} muestras (poco confiables)`);
    }

    return null; // Dar un ciclo más para que surta efecto
  }

  // --- TIER 2: forzar lanzamiento del más liviano ---
  if (consecutiveAllBlockedCycles >= DEADLOCK_TIER2_CYCLES) {
    // Encontrar el candidato con menor impacto estimado
    const profiles = loadSkillProfiles();
    let lightest = null;
    let lightestImpact = Infinity;

    for (const candidate of candidates) {
      const skill = skillFromFile(candidate.archivo.name);
      const est = getEstimatedImpact(profiles[skill]);
      const impact = est.cpu + est.mem;
      if (impact < lightestImpact) {
        lightestImpact = impact;
        lightest = candidate;
      }
    }

    if (lightest) {
      const skill = skillFromFile(lightest.archivo.name);
      const issue = issueFromFile(lightest.archivo.name);
      log('deadlock', `🚀 Tier 2: forzando lanzamiento de ${skill}:#${issue} (el más liviano, impacto estimado: ${Math.round(lightestImpact)}%) tras ${consecutiveAllBlockedCycles} ciclos bloqueados`);
      if (now - lastDeadlockTelegramTs > DEADLOCK_TELEGRAM_COOLDOWN) {
        sendTelegram(`🔓 Pipeline deadlocked ${consecutiveAllBlockedCycles} ciclos — forzando ${skill}:#${issue} para desbloquear. El gate predictivo tenía profiles inflados o el sistema tiene procesos externos pesados.`);
        lastDeadlockTelegramTs = now;
      }
      consecutiveAllBlockedCycles = 0; // Reset — le damos tiempo al agente lanzado
      return lightest;
    }
  }

  return null;
}

/**
 * Limpieza proactiva — se ejecuta cada N ciclos aunque no haya presión.
 * Mata daemons huérfanos que se acumulan silenciosamente.
 */
function proactiveCleanup(config) {
  const interval = config.resource_limits?.proactive_cleanup_cycles || 10;
  proactiveCycleCounter++;
  if (proactiveCycleCounter < interval) return;
  proactiveCycleCounter = 0;

  const { freed, killed } = tryFreeResources('soft');
  if (freed) {
    log('proactivo', `Limpieza periódica: ${killed.join(', ')}`);
  }

  // Auto-shutdown del emulador si no hay verificación activa — libera ~2.5GB RAM
  const emulatorKilled = shutdownIdleEmulator(config);
  if (emulatorKilled) {
    sendTelegram('🔌 Emulador QA apagado automáticamente (sin verificación activa). Se re-levanta solo cuando haga falta.');
  }
}

// Tomar snapshot inicial de CPU al arrancar (el primer delta necesita dos puntos)
lastCpuSnapshot = cpuSnapshot();

// =============================================================================
// BRAZO 1: BARRIDO — Conecta fases, promueve o rechaza
// =============================================================================

function brazoBarrido(config) {
  for (const [pipelineName, pipelineConfig] of Object.entries(config.pipelines)) {
    const fases = pipelineConfig.fases;
    const faseRechazo = pipelineConfig.fase_rechazo;

    for (let i = 0; i < fases.length; i++) {
      const fase = fases[i];
      const listoDir = path.join(fasePath(pipelineName, fase), 'listo');
      const procesadoDir = path.join(fasePath(pipelineName, fase), 'procesado');
      const archivosListo = listWorkFiles(listoDir);

      if (archivosListo.length === 0) continue;

      // Agrupar por issue
      const porIssue = {};
      for (const f of archivosListo) {
        const issue = issueFromFile(f.name);
        if (!porIssue[issue]) porIssue[issue] = [];
        porIssue[issue].push(f);
      }

      // Para cada issue, verificar si todos los skills completaron
      const skillsRequeridos = pipelineConfig.skills_por_fase[fase] || [];

      for (const [issue, archivos] of Object.entries(porIssue)) {
        // Para fase "dev" solo se necesita 1 skill (el que corresponda)
        const skillsEnListo = archivos.map(a => skillFromFile(a.name));

        let todosCompletos;
        if (fase === 'dev' || fase === 'build' || fase === 'entrega') {
          // Fases de un solo skill: con 1 archivo alcanza
          todosCompletos = archivos.length >= 1;
        } else {
          // Fases paralelas: todos los skills requeridos deben estar
          todosCompletos = skillsRequeridos.every(s => skillsEnListo.includes(s));
        }

        if (!todosCompletos) continue;

        // Leer resultados
        const resultados = archivos.map(a => ({
          ...readYaml(a.path),
          file: a
        }));

        // --- GATE DE EVIDENCIA QA (fase verificacion) ---
        // Si el QA dice "aprobado" pero no tiene evidencia real, forzar rechazo automático.
        // Esto evita que issues pasen a aprobación sin video con audio narrado.
        if (fase === 'verificacion') {
          const qaResult = resultados.find(r => skillFromFile(r.file.name) === 'qa');
          if (qaResult && qaResult.resultado === 'aprobado') {
            const issues = validateQaEvidence(issue, qaResult);
            if (issues.length > 0) {
              log('barrido', `⛔ #${issue} QA aprobó SIN evidencia válida: ${issues.join(', ')}`);
              qaResult.resultado = 'rechazado';
              qaResult.motivo = `Evidencia QA incompleta: ${issues.join('; ')}`;
              // Sobrescribir el archivo con el rechazo
              writeYaml(qaResult.file.path, {
                ...qaResult,
                file: undefined,  // No persistir el campo 'file'
                resultado: 'rechazado',
                motivo: qaResult.motivo,
                rechazado_por: 'gate-evidencia-automatico'
              });
              sendTelegram(`⛔ #${issue} — QA aprobó sin evidencia válida. Rechazo automático: ${issues.join('; ')}`);
            }
          }
        }

        const rechazados = resultados.filter(r => r.resultado === 'rechazado');

        if (rechazados.length > 0 && faseRechazo) {
          // Circuit breaker: leer rebote_numero del archivo que originó este ciclo
          // (puede estar en trabajando/ o pendiente/ de la fase de rechazo, o en el propio resultado)
          // Buscar el máximo rebote_numero entre los archivos del issue en dev
          let reboteCount = 0;
          for (const estado of ['pendiente', 'trabajando', 'procesado']) {
            const dir = path.join(fasePath(pipelineName, faseRechazo), estado);
            try {
              for (const f of fs.readdirSync(dir)) {
                if (f.startsWith(issue + '.')) {
                  const data = readYaml(path.join(dir, f));
                  if (data.rebote_numero && data.rebote_numero > reboteCount) {
                    reboteCount = data.rebote_numero;
                  }
                }
              }
            } catch {}
          }

          const MAX_REBOTES = 3;
          if (reboteCount >= MAX_REBOTES) {
            log('barrido', `⛔ #${issue} CIRCUIT BREAKER — ${reboteCount} rebotes en ${faseRechazo}, no devolver más. Requiere intervención manual.`);
            sendTelegram(`⛔ Issue #${issue} atascado — ${reboteCount} rebotes entre ${fase} y ${faseRechazo}. Requiere intervención manual.`);
            // Mover todo a procesado para sacarlo del loop
            for (const a of archivos) {
              const dest = path.join(fasePath(pipelineName, fase), 'procesado');
              try { moveFile(a.path, dest); } catch {}
            }
            continue;
          }

          // Hay rechazo → devolver a fase de rechazo
          const motivos = rechazados.map(r => `[${skillFromFile(r.file.name)}] ${r.motivo || 'sin motivo'}`).join('\n');

          const devPendiente = path.join(fasePath(pipelineName, faseRechazo), 'pendiente');

          // Determinar qué skill de dev corresponde
          const devSkill = determinarDevSkill(issue, config);
          const devFile = path.join(devPendiente, `${issue}.${devSkill}`);

          writeYaml(devFile, {
            issue: parseInt(issue),
            fase: faseRechazo,
            pipeline: pipelineName,
            rebote: true,
            rebote_numero: reboteCount + 1,
            motivo_rechazo: motivos,
            rechazado_en_fase: fase
          });

          log('barrido', `#${issue} RECHAZADO en ${fase} → devuelto a ${faseRechazo} (rebote ${reboteCount + 1}/${MAX_REBOTES})`);

          // CLEANUP DOWNSTREAM: limpiar archivos residuales del issue en fases posteriores.
          // Sin esto, archivos de aprobacion/listo/ de un ciclo anterior sobreviven al rechazo
          // y el barrido los promueve a entrega — el issue sale a delivery sin QA pasado.
          // (Incidente #2043: delivery se lanzó con QA rechazado.)
          for (let downstream = i + 1; downstream < fases.length; downstream++) {
            const downFase = fases[downstream];
            for (const estado of ['pendiente', 'trabajando', 'listo']) {
              const dir = path.join(fasePath(pipelineName, downFase), estado);
              try {
                for (const f of fs.readdirSync(dir)) {
                  if (f.startsWith(issue + '.') && !f.startsWith('.')) {
                    const src = path.join(dir, f);
                    const archDir = path.join(fasePath(pipelineName, downFase), 'archivado');
                    fs.mkdirSync(archDir, { recursive: true });
                    moveFile(src, archDir);
                    log('barrido', `#${issue} cleanup downstream: ${downFase}/${estado}/${f} → archivado/`);
                  }
                }
              } catch {}
            }
          }
        } else if (i < fases.length - 1) {
          // Todos aprobaron → promover a siguiente fase
          const siguienteFase = fases[i + 1];
          const siguientePendiente = path.join(fasePath(pipelineName, siguienteFase), 'pendiente');
          const siguienteSkills = pipelineConfig.skills_por_fase[siguienteFase] || [];

          if (siguienteFase === 'dev' || siguienteFase === 'build' || siguienteFase === 'entrega') {
            // Fase de un solo skill
            const skill = siguienteFase === 'dev'
              ? determinarDevSkill(issue, config)
              : siguienteSkills[0];
            const newFile = path.join(siguientePendiente, `${issue}.${skill}`);
            writeYaml(newFile, {
              issue: parseInt(issue),
              fase: siguienteFase,
              pipeline: pipelineName
            });
          } else {
            // Fase paralela: crear archivo por cada skill
            for (const skill of siguienteSkills) {
              const newFile = path.join(siguientePendiente, `${issue}.${skill}`);
              writeYaml(newFile, {
                issue: parseInt(issue),
                fase: siguienteFase,
                pipeline: pipelineName
              });
            }
          }

          log('barrido', `#${issue} ${fase} ✓ → promovido a ${siguienteFase}`);
        } else {
          // Última fase completada — historia terminada
          log('barrido', `#${issue} COMPLETADO — salió del pipeline ${pipelineName}`);

          // Si es pipeline de definición → agregar label "ready" para que desarrollo lo tome
          if (pipelineName === 'definicion') {
            const ghQueueDir = path.join(PIPELINE, 'servicios', 'github', 'pendiente');
            const labelFile = path.join(ghQueueDir, `${issue}-ready-${Date.now()}.json`);
            fs.writeFileSync(labelFile, JSON.stringify({ action: 'label', issue: parseInt(issue), label: 'ready' }));
            log('barrido', `#${issue} → encolado label "ready" en servicio-github`);

            // También remover label needs-definition
            const rmLabelFile = path.join(ghQueueDir, `${issue}-rm-ndef-${Date.now()}.json`);
            fs.writeFileSync(rmLabelFile, JSON.stringify({ action: 'remove-label', issue: parseInt(issue), label: 'needs-definition' }));
          }

          // Si es pipeline de desarrollo → notificar por telegram
          if (pipelineName === 'desarrollo') {
            sendTelegram(`✅ #${issue} completó el pipeline de desarrollo. Listo para merge.`);
          }

          // Cleanup: eliminar worktree del issue si existe
          try {
            const wtList = execSync('git worktree list --porcelain', { cwd: ROOT, encoding: 'utf8', timeout: 10000, windowsHide: true });
            const wtPattern = `platform.agent-${issue}-`;
            for (const line of wtList.split('\n')) {
              if (line.startsWith('worktree ') && line.includes(wtPattern)) {
                const wtPath = line.replace('worktree ', '').trim();
                execSync(`git worktree remove "${wtPath}" --force`, { cwd: ROOT, timeout: 30000, windowsHide: true });
                log('barrido', `Worktree eliminado: ${wtPath}`);
              }
            }
          } catch (e) {
            log('barrido', `Error limpiando worktree de #${issue}: ${e.message}`);
          }
        }

        // Mover todos los archivos evaluados a procesado/
        for (const a of archivos) {
          moveFile(a.path, procesadoDir);
        }
      }
    }
  }
}

/** Determinar qué skill de dev corresponde a un issue (por labels de GitHub) */
function determinarDevSkill(issue, config) {
  const mapping = config.dev_skill_mapping || {};
  const labels = getIssueLabels(issue);

  for (const label of labels) {
    if (mapping[label]) return mapping[label];
  }

  return mapping.default || 'backend-dev';
}

// =============================================================================
// BRAZO 2: LANZAMIENTO — Detecta trabajo pendiente, lanza agentes
// =============================================================================

// Cache de labels+estado de issues (evita llamadas repetidas a GitHub API)
const issueLabelsCache = new Map(); // issueNum → { labels: [...], state: string, fetchedAt: timestamp }
const LABELS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutos

function getIssueInfo(issueNum) {
  const cached = issueLabelsCache.get(issueNum);
  if (cached && (Date.now() - cached.fetchedAt) < LABELS_CACHE_TTL_MS) {
    return cached;
  }
  try {
    ghThrottle();
    const result = execSync(
      `"${GH_BIN}" issue view ${issueNum} --json labels,state`,
      { cwd: ROOT, encoding: 'utf8', timeout: 10000, windowsHide: true }
    ).trim();
    const parsed = JSON.parse(result);
    const info = {
      labels: (parsed.labels || []).map(l => l.name),
      state: parsed.state || 'UNKNOWN',
      fetchedAt: Date.now()
    };
    issueLabelsCache.set(issueNum, info);
    return info;
  } catch {
    return { labels: [], state: 'UNKNOWN', fetchedAt: Date.now() };
  }
}

function getIssueLabels(issueNum) {
  return getIssueInfo(issueNum).labels;
}

/** Verifica si un issue está cerrado en GitHub (usa cache) */
function isIssueClosed(issueNum) {
  return getIssueInfo(issueNum).state === 'CLOSED';
}

/** Calcular score de prioridad para un issue (menor = más prioritario) */
function calcularPrioridad(issueNum, config) {
  const labels = getIssueLabels(issueNum);
  const prioLabels = config.prioridad_labels || [];
  const featurePrio = config.feature_priority || {};

  // Score base: prioridad directa del label (0=critical, 1=high, 2=medium, 3=low)
  // Default: priority:medium si no tiene label explícito
  let prioScore = prioLabels.indexOf('priority:medium');
  if (prioScore === -1) prioScore = 999;
  for (let i = 0; i < prioLabels.length; i++) {
    if (labels.includes(prioLabels[i])) { prioScore = i; break; }
  }

  // Score de feature: hereda nivel de prioridad según config (critical=0, high=1, etc.)
  let featureScore = 999;
  for (const [nivel, featureLabels] of Object.entries(featurePrio)) {
    const nivelIdx = prioLabels.indexOf(`priority:${nivel}`);
    if (nivelIdx === -1) continue;
    for (const fl of featureLabels) {
      if (labels.includes(fl)) { featureScore = Math.min(featureScore, nivelIdx); break; }
    }
  }

  // Feature priority PUEDE subir la prioridad efectiva (tomar el menor de ambos)
  const effectivePrio = Math.min(prioScore, featureScore);

  // Desempate: si empatan en prioridad efectiva, preferir el que tiene feature explícita
  const tiebreaker = featureScore < 999 ? 0 : 1;

  return effectivePrio * 10 + tiebreaker;
}

/** Ordenar archivos pendientes por prioridad del issue */
function sortByPriority(archivos, config) {
  if (archivos.length <= 1) return archivos;
  return archivos.sort((a, b) => {
    const issueA = issueFromFile(a.name);
    const issueB = issueFromFile(b.name);
    return calcularPrioridad(issueA, config) - calcularPrioridad(issueB, config);
  });
}

/**
 * Rebotar verificación→build cuando preflight detecta APK faltante.
 *
 * Patrón genérico: archiva todos los hermanos de verificacion/pendiente/<issue>.* a
 * procesado/ con resultado: rechazado, y encola un <issue>.build fresco en build/pendiente/.
 * Idempotente: si ya hay un build en curso/encolado para el issue, no duplica.
 * Circuit breaker MAX_REBOTES_APK protege contra loops verificacion↔build.
 *
 * Esta función fue extraída del dispatcher para que también la pueda invocar el
 * deadlock breaker — sin esto, cuando el gate predictivo bloquea preflight (path
 * normal) o cuando el deadlock breaker fuerza preflight, el rebote no corría y el
 * issue quedaba atascado eternamente en verificacion/pendiente/.
 *
 * Llamada por:
 *   - dispatcher normal en brazoLanzamiento (path verificacion + apk_missing)
 *   - deadlock breaker (Tier 2 forzado + apk_missing)
 *
 * @returns {boolean} true si rebote ejecutado, false si circuit breaker disparado
 *                    (en cuyo caso los archivos quedan archivados pero NO se encola build)
 */
function reboteVerificacionABuild(issue, pipelineName, preflightResult) {
  const MAX_REBOTES_APK = 3;

  try {
    const verPendDir = path.join(fasePath(pipelineName, 'verificacion'), 'pendiente');
    const verProcDir = path.join(fasePath(pipelineName, 'verificacion'), 'procesado');
    const buildPendDir = path.join(fasePath(pipelineName, 'build'), 'pendiente');
    const buildTrabDir = path.join(fasePath(pipelineName, 'build'), 'trabajando');
    const buildListoDir = path.join(fasePath(pipelineName, 'build'), 'listo');
    const buildProcDir = path.join(fasePath(pipelineName, 'build'), 'procesado');
    const buildFileName = `${issue}.build`;

    // Recolectar TODOS los archivos del issue en verificacion/pendiente/
    const archivosVerificacion = listWorkFiles(verPendDir).filter(f => issueFromFile(f.name) === issue);

    // Calcular rebote_numero: máximo entre archivos actuales y builds previos del issue
    let reboteCount = 0;
    for (const f of archivosVerificacion) {
      const data = readYaml(f.path);
      if (data.rebote_numero && data.rebote_numero > reboteCount) reboteCount = data.rebote_numero;
    }
    for (const estado of ['pendiente', 'trabajando', 'listo', 'procesado']) {
      const prevBuild = path.join(fasePath(pipelineName, 'build'), estado, buildFileName);
      if (fs.existsSync(prevBuild)) {
        const data = readYaml(prevBuild);
        if (data.rebote_numero && data.rebote_numero > reboteCount) reboteCount = data.rebote_numero;
      }
    }

    if (reboteCount >= MAX_REBOTES_APK) {
      log('lanzamiento', `⛔ #${issue} CIRCUIT BREAKER APK — ${reboteCount} rebotes verificacion↔build. Archivando a procesado.`);
      sendTelegram(`⛔ #${issue} atascado — ${reboteCount} rebotes por APK faltante entre verificacion y build. Requiere intervención manual.`);
      for (const f of archivosVerificacion) {
        try { moveFile(f.path, verProcDir); } catch {}
      }
      return false;
    }

    // 1. Marcar rechazados y archivar a procesado/
    const motivoRechazo = `APK faltante: ${preflightResult?.reason || 'preflight QA no encontró APK del build'}`;
    for (const f of archivosVerificacion) {
      try {
        const data = readYaml(f.path);
        writeYaml(f.path, {
          ...data,
          resultado: 'rechazado',
          motivo: motivoRechazo,
          rechazado_en_fase: 'verificacion',
          rechazado_por: 'preflight-apk',
          rebote_a: 'build',
          rebote_numero: reboteCount + 1,
          rechazado_ts: new Date().toISOString(),
        });
        moveFile(f.path, verProcDir);
      } catch (moverErr) {
        log('lanzamiento', `⚠️ #${issue}: no se pudo archivar ${f.name}: ${moverErr.message}`);
      }
    }

    // 2. Encolar build (idempotente — si ya hay uno en vuelo/encolado, no duplicar)
    const yaEncolado =
      fs.existsSync(path.join(buildPendDir, buildFileName)) ||
      fs.existsSync(path.join(buildTrabDir, buildFileName)) ||
      fs.existsSync(path.join(buildListoDir, buildFileName));

    if (!yaEncolado) {
      const payload = {
        issue: parseInt(issue),
        fase: 'build',
        pipeline: pipelineName,
        motivo: 'APK faltante detectado por preflight QA',
        rebote: true,
        rebote_numero: reboteCount + 1,
        rechazado_en_fase: 'verificacion',
      };
      const procFile = path.join(buildProcDir, buildFileName);
      if (fs.existsSync(procFile)) {
        writeYaml(procFile, payload);
        moveFile(procFile, buildPendDir);
        log('lanzamiento', `⏪ #${issue}: verificación rechazada (APK faltante) → build re-encolado desde procesado (rebote ${reboteCount + 1}/${MAX_REBOTES_APK})`);
      } else {
        writeYaml(path.join(buildPendDir, buildFileName), payload);
        log('lanzamiento', `⏪ #${issue}: verificación rechazada (APK faltante) → build nuevo encolado (rebote ${reboteCount + 1}/${MAX_REBOTES_APK})`);
      }
      ghCommentOnIssue(issue, `⏪ La verificación detectó APK faltante. Issue devuelto automáticamente a la fase build para re-generar el APK.`);
    } else {
      log('lanzamiento', `⏪ #${issue}: verificación rechazada (APK faltante) → build ya en curso/encolado`);
    }
    return true;
  } catch (reencolarErr) {
    log('lanzamiento', `⚠️ #${issue}: no se pudo rebotar verificación→build — ${reencolarErr.message}`);
    return false;
  }
}

function brazoLanzamiento(config) {
  // Limpieza proactiva periódica (cada N ciclos, sin importar presión)
  proactiveCleanup(config);

  // Leer activaciones/desactivaciones manuales del dashboard
  readManualPriorityOverrides();

  // Evaluar Priority Windows ANTES del gate de recursos — para que puedan
  // desactivarse (cola vacía) incluso cuando el sistema está bajo presión.
  // Sin esto, una ventana activada durante un pico de carga queda atascada
  // indefinidamente porque isSystemOverloaded() retorna antes de la evaluación.
  const qaPriority = evaluateQaPriority(config);
  const buildPriority = evaluateBuildPriority(config);

  // GATE DE RECURSOS: presión graduada (green/yellow/orange/red)
  if (isSystemOverloaded(config)) return;

  // Calcular multiplicador de concurrencia según presión actual
  const pressure = getResourcePressure(config);
  const multiplier = concurrencyMultiplier(pressure.level);

  // Fases bloqueadas según ventana activa (autoexcluyentes: QA > Build > Dev)
  // QA Priority: bloquea dev + validacion + build (QA necesita recursos exclusivos)
  // Build Priority: bloquea dev + validacion (build corre, QA sigue si hay)
  const DEV_PHASES = ['dev', 'validacion'];
  const QA_BLOCKED_PHASES = ['dev', 'validacion', 'build']; // QA bloquea también build

  // --- PIEZA 2+3: Recolectar TODOS los pendientes de TODAS las fases ---
  // En vez de iterar fase por fase (que prioriza fases avanzadas),
  // juntamos todo y ordenamos por: feature priority > fase inversa.
  const candidates = [];

  for (const [pipelineName, pipelineConfig] of Object.entries(config.pipelines)) {
    const fases = pipelineConfig.fases;
    for (let faseIdx = 0; faseIdx < fases.length; faseIdx++) {
      const fase = fases[faseIdx];

      // PRIORITY WINDOWS (autoexcluyentes): QA bloquea dev+build, Build bloquea solo dev
      if (qaPriority && QA_BLOCKED_PHASES.includes(fase)) continue;
      if (buildPriority && !qaPriority && DEV_PHASES.includes(fase)) continue;

      const pendienteDir = path.join(fasePath(pipelineName, fase), 'pendiente');
      const archivos = listWorkFiles(pendienteDir);

      for (const archivo of archivos) {
        candidates.push({
          archivo,
          pipelineName,
          fase,
          faseIdx,  // Índice original de la fase (para orden inverso)
          totalFases: fases.length,
        });
      }
    }
  }

  // Ordenar candidatos: feature priority (menor=mejor) > fase inversa (mayor idx=más avanzada=primero)
  candidates.sort((a, b) => {
    const issueA = issueFromFile(a.archivo.name);
    const issueB = issueFromFile(b.archivo.name);
    const prioA = calcularPrioridad(issueA, config);
    const prioB = calcularPrioridad(issueB, config);

    // Primer criterio: prioridad de feature (menor = más prioritario)
    if (prioA !== prioB) return prioA - prioB;

    // Segundo criterio (desempate): fase inversa — fases más avanzadas primero
    // faseIdx mayor = fase más avanzada = debe procesarse antes
    return b.faseIdx - a.faseIdx;
  });

  // --- Procesar candidatos en orden unificado ---
  let anyLaunched = false;
  let gateBlockedCount = 0;       // Candidatos bloqueados específicamente por el gate predictivo
  let eligibleForGateCount = 0;   // Candidatos que llegaron hasta el gate (pasaron dedup/cooldown/concurrencia)
  const gateBlockedCandidates = []; // Para el deadlock breaker

  for (const candidate of candidates) {
    const { archivo, pipelineName, fase } = candidate;
    const trabajandoDir = path.join(fasePath(pipelineName, fase), 'trabajando');
    const skill = skillFromFile(archivo.name);
    const issue = issueFromFile(archivo.name);
    const key = processKey(skill, issue);

    // 0. Defensa contra archivos evaporados — el procesamiento previo de otro candidate
    //    del mismo issue (p.ej. rebote por APK faltante que archiva todos los hermanos
    //    de verificacion/pendiente/ en el primer match) pudo haber movido este archivo.
    //    Sin este check el siguiente iteration explota al intentar moverlo.
    if (!fs.existsSync(archivo.path)) continue;

    // 0b. BLOCKED: no lanzar issues con blocked:dependencies
    const issueLbls = getIssueLabels(issue);
    if (issueLbls.includes('blocked:dependencies')) {
      log('lanzamiento', `#${issue} omitido — blocked:dependencies`);
      continue;
    }

    // 0c. CLOSED: no lanzar issues cerrados en GitHub — archivar y seguir
    if (isIssueClosed(issue)) {
      log('lanzamiento', `#${issue} omitido — issue cerrado en GitHub, archivando`);
      const archDir = path.join(fasePath(pipelineName, fase), 'archivado');
      fs.mkdirSync(archDir, { recursive: true });
      moveFile(archivo.path, archDir);
      continue;
    }

    // 1. DEDUP: ¿ya hay un agente activo para este ISSUE (cualquier skill) en trabajando/?
    const issueAlreadyWorking = listWorkFiles(trabajandoDir).some(f => issueFromFile(f.name) === issue);
    if (issueAlreadyWorking) continue;

    // 2. COOLDOWN: ¿este issue+skill está penalizado por fallos previos?
    if (isInCooldown(skill, issue)) continue;

    // 3. Ya hay un proceso activo para este skill+issue en memoria?
    if (activeProcesses.has(key) && isProcessAlive(activeProcesses.get(key).pid)) {
      continue;
    }

    // 4. Verificar concurrencia del rol — ADAPTATIVA según presión de recursos
    const baseMax = (config.concurrencia || {})[skill] || 1;
    const maxConcurrencia = Math.max(1, Math.floor(baseMax * multiplier));
    const running = countRunningBySkill(skill);
    if (running >= maxConcurrencia) continue;

    // 5a. Límite de builds bajo presión — en YELLOW solo 1 build simultáneo
    // Esto previene que múltiples builds saturen la RAM y lleven al sistema a RED
    if (fase === 'build' && (pressure.level === PRESSURE_LEVELS.YELLOW || pressure.level === PRESSURE_LEVELS.ORANGE)) {
      const runningBuilds = countRunningBuild(config);
      if (runningBuilds >= 1) {
        log('lanzamiento', `⚠️ ${pressure.level.toUpperCase()} — ${runningBuilds} build(s) en curso, postergando build de #${issue} para no saturar`);
        continue;
      }
    }

    // 5b. PIEZA 1: Límite global de devs — si este skill es de desarrollo,
    // verificar que no se exceda el máximo total de devs simultáneos
    if (DEV_SKILLS.includes(skill)) {
      const maxDevs = (config.resource_limits || {}).max_concurrent_devs;
      if (maxDevs != null) {
        const totalDevs = countRunningDevs();
        if (totalDevs >= maxDevs) {
          log('lanzamiento', `Límite global de devs alcanzado (${totalDevs}/${maxDevs}). Postergando ${archivo.name}`);
          continue;
        }
      }
    }

    // 6. PRE-FLIGHT CHECKS PARA FASE VERIFICACIÓN — DEBE ir ANTES del gate predictivo.
    //
    // Razón: si el gate predictivo bloquea por memoria, hace continue antes de llegar
    // al preflight, y el rebote APK→build nunca se ejecuta. El issue queda atascado
    // eternamente en verificacion/pendiente/, pendingQa nunca baja a 0, la ventana QA
    // no se auto-desactiva y el build (que podría regenerar el APK) está bloqueado por
    // la propia ventana QA. Deadlock duro.
    //
    // El preflight y el rebote son barato (no consumen RAM ni CPU significativos),
    // así que tiene sentido ejecutarlos ANTES del gate de recursos.
    let preflightResult = null;
    if (fase === 'verificacion') {
      preflightResult = preflightQaChecks(issue);
      if (!preflightResult.ok) {
        if (preflightResult.result === 'apk_missing') {
          reboteVerificacionABuild(issue, pipelineName, preflightResult);
        } else if (preflightResult.result === 'waiting:emulator') {
          // Encolar start del emulador al servicio-emulador
          requestEmulator('start', 'pulpo-preflight', issue, 'QA_MODE=android, emulador necesario para verificación');
          log('lanzamiento', `⏸️ #${issue}: pre-flight → esperando emulador (encolado start al servicio-emulador)`);
        } else {
          // blocked:infra — mantener en cola, reintentar en próximo ciclo
          log('lanzamiento', `🚫 #${issue}: pre-flight → ${preflightResult.result}: ${preflightResult.reason}`);
        }
        continue; // No mover a trabajando/, no lanzar
      }
      // Capa 3: loguear el qaMode asignado
      log('lanzamiento', `#${issue}: qaMode=${preflightResult.qaMode} (Capa 3 ruteo)`);
    }

    // 7. GATE PREDICTIVO DE RECURSOS: ¿lanzar este agente saturaría el sistema?
    //    (corre DESPUÉS del preflight para que las verificaciones que serían rebotadas
    //    no inflen el contador de candidatos bloqueados ni paren el deadlock breaker)
    //
    //    Pasamos el estado del emulador para que los skills QA puedan restar su RAM
    //    del baseline — el emulador es infra reservada por la propia ventana QA, no
    //    un costo del agente individual. Sin esto el cálculo cuenta dos veces el
    //    emulador y lleva a livelock cuando la baseline ya lo incluye.
    eligibleForGateCount++;
    const gateCtx = { emulator: measureEmulatorMemPercent() };
    const impact = predictResourceImpact(skill, config, gateCtx);
    if (!impact.safe) {
      log('lanzamiento', `🛑 Gate predictivo bloqueó ${skill}:#${issue} — ${impact.reason}`);
      gateBlockedCount++;
      gateBlockedCandidates.push(candidate);
      continue;
    }

    // Mover a trabajando/ (atómico)
    try {
      const trabajandoPath = moveFile(archivo.path, trabajandoDir);

      // Lanzar agente (todas las fases, incluyendo build)
      // Capa 3: pasar qaMode al agente QA via extraEnv
      const extraEnv = {};
      if (preflightResult && preflightResult.qaMode) {
        extraEnv.QA_MODE = preflightResult.qaMode;
        extraEnv.QA_ISSUE = String(issue);
        extraEnv.QA_BASE_URL = 'https://mgnr0htbvd.execute-api.us-east-2.amazonaws.com/dev';
        if (preflightResult.flavors && preflightResult.flavors.length > 0) {
          extraEnv.QA_FLAVOR = preflightResult.flavors[0];
        }
        if (preflightResult.emulatorSerial) {
          extraEnv.QA_EMULATOR_SERIAL = preflightResult.emulatorSerial;
        }
      }
      lanzarAgenteClaude(skill, issue, trabajandoPath, pipelineName, fase, config, extraEnv);
      anyLaunched = true;
    } catch (e) {
      log('lanzamiento', `Error moviendo/lanzando ${archivo.name}: ${e.message}`);
    }
  }

  // --- DEADLOCK BREAKER ---
  // Si había candidatos elegibles pero TODOS fueron bloqueados por el gate predictivo
  if (eligibleForGateCount > 0 && gateBlockedCount === eligibleForGateCount && !anyLaunched) {
    consecutiveAllBlockedCycles++;

    const forced = handleDeadlock(gateBlockedCandidates, config);
    if (forced) {
      // Forzar lanzamiento del candidato elegido por el breaker
      const { archivo, pipelineName, fase } = forced;
      const trabajandoDir = path.join(fasePath(pipelineName, fase), 'trabajando');
      try {
        const skill = skillFromFile(archivo.name);
        const issue = issueFromFile(archivo.name);
        // Pre-flight para verificación incluso en deadlock breaker.
        // Si detecta APK faltante, REBOTAR a build (no abandonar) — sin esto, el
        // deadlock breaker se queda atascado para siempre haciendo return ciclo tras
        // ciclo mientras los archivos siguen en verificacion/pendiente/.
        if (fase === 'verificacion') {
          const preflight = preflightQaChecks(issue);
          if (!preflight.ok) {
            if (preflight.result === 'apk_missing') {
              log('deadlock', `#${issue}: pre-flight forzado detectó APK faltante → rebote a build`);
              reboteVerificacionABuild(issue, pipelineName, preflight);
              consecutiveAllBlockedCycles = 0; // El rebote es progreso real, resetear contador
            } else {
              log('deadlock', `#${issue}: pre-flight bloqueó lanzamiento forzado → ${preflight.result}`);
            }
            return; // No lanzar — el deadlock breaker no puede forzar sin infra
          }
        }
        const trabajandoPath = moveFile(archivo.path, trabajandoDir);
        lanzarAgenteClaude(skill, issue, trabajandoPath, pipelineName, fase, config);
      } catch (e) {
        log('deadlock', `Error en lanzamiento forzado de ${archivo.name}: ${e.message}`);
      }
    }
  } else {
    // Se lanzó algo o no había candidatos elegibles → reset deadlock counter
    if (anyLaunched || eligibleForGateCount === 0) {
      consecutiveAllBlockedCycles = 0;
    }
  }
}

// =============================================================================
// PRE-FLIGHT CHECKS — Capa 2 + Capa 3 de la estrategia QA
// Capa 2: Verifica infraestructura ANTES de lanzar agente QA
// Capa 3: Clasifica qaMode (android/api/structural) para rutear al script correcto
// =============================================================================

const APP_LABELS = ['app:client', 'app:business', 'app:delivery'];
const LABEL_TO_FLAVOR = { 'app:client': 'client', 'app:business': 'business', 'app:delivery': 'delivery' };
const ROUTING_LABELS = [...APP_LABELS, 'area:backend', 'area:infra', 'docs'];

// Keywords para auto-clasificación inteligente de issues sin labels de ruteo
const AUTO_CLASSIFY_RULES = [
  // UI / Android — palabras que indican impacto en la interfaz del usuario
  { keywords: ['pantalla', 'screen', 'ui', 'ux', 'botón', 'button', 'formulario', 'form', 'dialog',
    'compose', 'viewmodel', 'navegación', 'navigation', 'diseño', 'layout', 'color', 'tema', 'theme',
    'carrito', 'cart', 'pedido', 'order', 'producto', 'product', 'menú', 'menu', 'login', 'registro',
    'perfil', 'profile', 'notificación', 'notification', 'lista', 'list', 'detalle', 'detail',
    'imagen', 'image', 'ícono', 'icon', 'toast', 'snackbar', 'repetir pedido', 'checkout',
    'splash', 'onboarding', 'search', 'buscar', 'filtro', 'filter', 'animación', 'animation'],
    label: 'app:client' },
  // Backend / API
  { keywords: ['endpoint', 'api', 'lambda', 'cognito', 'dynamodb', 'serverless', 'función backend',
    'backend function', 'signin', 'signup', 'token', 'jwt', 'cors', 'http', 'request', 'response',
    'ktor', 'route', 'ruta backend', 'status code', 'migration', 'tabla', 'table', 'index',
    'secretsmanager', 'ses', 'email', 'sms', 'otp', '2fa', 'mfa', 'auth'],
    label: 'area:backend' },
  // Infra / pipeline / hooks
  { keywords: ['pipeline', 'hook', 'infra', 'ci/cd', 'github action', 'gradle', 'build', 'deploy',
    'worktree', 'pulpo', 'restart', 'dashboard', 'monitor', 'agent', 'agente', 'config',
    'yaml', 'json config', 'script', '.pipeline', 'cron', 'scheduler'],
    label: 'area:infra' },
  // Documentación
  { keywords: ['documentación', 'documentation', 'docs/', 'readme', 'spec', 'arquitectura',
    'architecture', 'manual', 'guía', 'guide', 'changelog'],
    label: 'docs' }
];

/**
 * Auto-clasificar un issue sin labels de ruteo.
 * Lee título y body del issue, matchea contra keywords, asigna el label en GitHub.
 * Retorna el label asignado o null si no pudo determinar.
 */
function autoClassifyIssue(issueNum) {
  try {
    ghThrottle();
    const issueJson = execSync(
      `"${GH_BIN}" issue view ${issueNum} --json title,body`,
      { cwd: ROOT, encoding: 'utf8', timeout: 10000, windowsHide: true }
    );
    const { title = '', body = '' } = JSON.parse(issueJson);
    const text = `${title}\n${body}`.toLowerCase();

    // Contar matches por regla
    const scores = AUTO_CLASSIFY_RULES.map(rule => {
      const hits = rule.keywords.filter(kw => text.includes(kw.toLowerCase()));
      return { label: rule.label, hits: hits.length, matched: hits };
    }).filter(s => s.hits > 0).sort((a, b) => b.hits - a.hits);

    if (scores.length === 0) {
      log('auto-classify', `#${issueNum}: sin matches — no se puede clasificar automáticamente`);
      return null;
    }

    const winner = scores[0];
    log('auto-classify', `#${issueNum}: clasificado como "${winner.label}" (${winner.hits} hits: ${winner.matched.slice(0, 5).join(', ')})`);

    // Asignar label en GitHub
    try {
      ghThrottle();
      execSync(
        `"${GH_BIN}" issue edit ${issueNum} --add-label "${winner.label}"`,
        { cwd: ROOT, encoding: 'utf8', timeout: 10000, windowsHide: true }
      );
      log('auto-classify', `#${issueNum}: label "${winner.label}" asignado en GitHub ✓`);

      // Invalidar cache de labels para que el ruteo use el label nuevo
      issueLabelsCache.delete(issueNum);
    } catch (e) {
      log('auto-classify', `#${issueNum}: error asignando label — ${e.message.slice(0, 80)}`);
    }

    return winner.label;
  } catch (e) {
    log('auto-classify', `#${issueNum}: error leyendo issue — ${e.message.slice(0, 80)}`);
    return null;
  }
}
const QA_ARTIFACTS_DIR = path.join(ROOT, 'qa', 'artifacts');
const PREFLIGHT_LOG_FILE = path.join(LOG_DIR, 'qa-preflight-log.jsonl');

// --- Warm-up + retry para backend Lambda (evita falsos blocked:infra por cold start) ---
const BACKEND_BASE_URL = 'https://mgnr0htbvd.execute-api.us-east-2.amazonaws.com/dev/intrale';
const WARMUP_RETRIES = 3;       // Intentos totales (1 warm-up + 2 retries)
const WARMUP_WAIT_MS = 5000;    // Espera entre intentos (5 segundos)
// Deduplicación de notificaciones blocked:infra — evita spam en Telegram
const _lastBlockedNotif = {};   // { issueNumber: timestampMs }
const BLOCKED_NOTIF_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutos entre notificaciones del mismo issue

/**
 * Hace un request al backend con warm-up automático.
 * Si el primer intento falla por timeout/error, espera y reintenta.
 * Retorna { ok: boolean, httpCode: number|null, error: string|null }
 */
function checkBackendWithWarmup(issue) {
  const backendUrl = `${BACKEND_BASE_URL}/signin`;
  // NUL en Windows, /dev/null en Unix — execSync usa cmd.exe en Windows
  const devNull = process.platform === 'win32' ? 'NUL' : '/dev/null';

  for (let attempt = 1; attempt <= WARMUP_RETRIES; attempt++) {
    try {
      const curlResult = execSync(
        `curl -s -o ${devNull} -w "%{http_code}" -X POST "${backendUrl}" -H "Content-Type: application/json" -d "{}" --connect-timeout 10 --max-time 20`,
        { encoding: 'utf8', timeout: 25000, windowsHide: true }
      ).trim();
      const httpCode = parseInt(curlResult, 10);

      if (httpCode >= 400 && httpCode < 500) {
        if (attempt > 1) {
          log('preflight', `#${issue}: backend respondió OK en intento ${attempt}/${WARMUP_RETRIES} (cold start resuelto)`);
        }
        return { ok: true, httpCode, error: null };
      }

      // Respuesta inesperada (5xx, etc) — reintentar
      log('preflight', `#${issue}: backend HTTP ${httpCode} en intento ${attempt}/${WARMUP_RETRIES} — ${attempt < WARMUP_RETRIES ? `esperando ${WARMUP_WAIT_MS/1000}s...` : 'agotados reintentos'}`);
    } catch (e) {
      log('preflight', `#${issue}: backend timeout/error en intento ${attempt}/${WARMUP_RETRIES}: ${e.message.slice(0, 60)} — ${attempt < WARMUP_RETRIES ? `esperando ${WARMUP_WAIT_MS/1000}s (probable cold start)...` : 'agotados reintentos'}`);
    }

    // Esperar antes del siguiente intento (excepto en el último)
    // Usamos Atomics.wait como sleep sincrónico portable (funciona en Windows sin shell hacks)
    if (attempt < WARMUP_RETRIES) {
      const sharedBuf = new SharedArrayBuffer(4);
      Atomics.wait(new Int32Array(sharedBuf), 0, 0, WARMUP_WAIT_MS);
    }
  }

  return { ok: false, httpCode: null, error: `No respondió tras ${WARMUP_RETRIES} intentos (cold start persistente)` };
}

/**
 * Envía notificación de blocked:infra con deduplicación (máximo 1 cada 5 min por issue).
 */
function sendBlockedInfraNotif(issue, message) {
  const now = Date.now();
  const lastSent = _lastBlockedNotif[issue] || 0;
  if (now - lastSent < BLOCKED_NOTIF_COOLDOWN_MS) {
    log('preflight', `#${issue}: blocked:infra notificación suprimida (cooldown ${Math.round((BLOCKED_NOTIF_COOLDOWN_MS - (now - lastSent)) / 1000)}s restantes)`);
    return;
  }
  _lastBlockedNotif[issue] = now;
  sendTelegram(message);
}

/**
 * Pre-flight checks para agentes QA (Capa 2 + Capa 3 ruteo).
 * Retorna { ok, result, reason, flavors, requiresEmulator, qaMode }
 *   ok=true  → lanzar agente
 *   qaMode: 'android' | 'api' | 'structural' (Capa 3)
 *   ok=false → no lanzar, result indica la acción a tomar
 */
// --- Check DynamoDB remoto: verifica que no hay overrides locales ---
function checkDynamoDbRemote(issue) {
  const checks = {};
  let ok = true;

  // 1. Verificar env vars que apuntan a DynamoDB local
  const dynamoEndpoint = process.env.DYNAMODB_ENDPOINT || '';
  if (dynamoEndpoint && /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(dynamoEndpoint)) {
    checks.dynamodb_env = `local:${dynamoEndpoint}`;
    log('preflight', `#${issue}: FAIL — DYNAMODB_ENDPOINT apunta a local: ${dynamoEndpoint}`);
    ok = false;
  } else {
    checks.dynamodb_env = dynamoEndpoint ? `remote:${dynamoEndpoint}` : 'not-set:aws-default';
  }

  // 2. Verificar LOCAL_MODE
  if ((process.env.LOCAL_MODE || '').toLowerCase() === 'true') {
    checks.local_mode = 'true';
    log('preflight', `#${issue}: FAIL — LOCAL_MODE=true activo, DynamoDB/Cognito apuntarían a localhost`);
    ok = false;
  } else {
    checks.local_mode = 'off';
  }

  // 3. Verificar .env.qa no tiene overrides locales
  const envQaPath = path.join(ROOT, '.env.qa');
  if (fs.existsSync(envQaPath)) {
    try {
      const envContent = fs.readFileSync(envQaPath, 'utf8');
      if (/DYNAMODB_ENDPOINT=.*localhost|DYNAMODB_ENDPOINT=.*127\.0\.0\.1/.test(envContent)) {
        checks.env_qa = 'dynamodb-local';
        log('preflight', `#${issue}: FAIL — .env.qa contiene DYNAMODB_ENDPOINT local`);
        ok = false;
      } else if (/LOCAL_MODE=true/.test(envContent)) {
        checks.env_qa = 'local-mode-true';
        log('preflight', `#${issue}: FAIL — .env.qa contiene LOCAL_MODE=true`);
        ok = false;
      } else {
        checks.env_qa = 'ok';
      }
    } catch (e) {
      checks.env_qa = `read-error:${e.message.slice(0, 40)}`;
    }
  } else {
    checks.env_qa = 'not-exists';
  }

  // 4. Verificar que searchBusinesses devuelve datos reales (DynamoDB remoto con data)
  // Timeouts más generosos para tolerar cold start (el warm-up de signin puede no calentar esta ruta)
  try {
    const searchUrl = `${BACKEND_BASE_URL}/searchBusinesses`;
    const result = execSync(
      `curl -s -X POST "${searchUrl}" -H "Content-Type: application/json" -d "{}" --connect-timeout 10 --max-time 20`,
      { encoding: 'utf8', timeout: 25000, windowsHide: true }
    ).trim();
    if (result.includes('"businesses":[') && !result.includes('"businesses":[]')) {
      checks.dynamodb_data = 'ok:has-data';
      log('preflight', `#${issue}: DynamoDB remoto OK — searchBusinesses devuelve datos reales`);
    } else if (result.includes('"businesses":[]')) {
      checks.dynamodb_data = 'empty';
      log('preflight', `#${issue}: WARN — DynamoDB remoto vacío (searchBusinesses sin resultados)`);
      // No bloquear por datos vacíos, solo advertir
    } else {
      checks.dynamodb_data = `unexpected:${result.slice(0, 60)}`;
      log('preflight', `#${issue}: WARN — DynamoDB respuesta inesperada: ${result.slice(0, 60)}`);
    }
  } catch (e) {
    checks.dynamodb_data = `error:${e.message.slice(0, 60)}`;
    log('preflight', `#${issue}: FAIL — DynamoDB check falló: ${e.message.slice(0, 60)}`);
    ok = false;
  }

  return { ok, checks };
}

function preflightQaChecks(issue) {
  const startMs = Date.now();
  const checks = {};

  // --- Check 1: Clasificar issue (requiere emulador o no) ---
  let labels = getIssueLabels(issue);

  // Auto-clasificación: si el issue no tiene ningún label de ruteo, inferir y asignar
  const hasRoutingLabel = labels.some(l => ROUTING_LABELS.includes(l));
  if (!hasRoutingLabel) {
    log('preflight', `#${issue}: sin labels de ruteo — intentando auto-clasificar...`);
    const assignedLabel = autoClassifyIssue(issue);
    if (assignedLabel) {
      // Re-leer labels después de la asignación
      labels = getIssueLabels(issue);
      sendTelegram(`🏷️ Issue #${issue} auto-clasificado como \`${assignedLabel}\` (no tenía label de ruteo QA).`);
    } else {
      log('preflight', `#${issue}: auto-clasificación falló — cae en structural por defecto`);
    }
  }

  const appLabels = labels.filter(l => APP_LABELS.includes(l));
  const requiresEmulator = appLabels.length > 0;
  const flavors = appLabels.map(l => LABEL_TO_FLAVOR[l]);

  // Capa 3: Clasificación extendida — qaMode determina el ruteo QA
  // 'android' = necesita emulador + APK + Maestro
  // 'api'     = necesita backend, NO emulador ni APK
  // 'structural' = no necesita infra externa (docs, hooks, infra)
  const hasBackendLabel = labels.includes('area:backend');
  const qaMode = requiresEmulator ? 'android'
    : hasBackendLabel ? 'api'
    : 'structural';

  checks.classify = requiresEmulator ? `ui:${flavors.join(',')}` : `no-ui:${qaMode}`;
  log('preflight', `#${issue}: check 1 OK (qaMode=${qaMode}${requiresEmulator ? `, flavors: ${flavors.join(', ')}` : ''})`);

  // Si no requiere emulador, verificar backend para QA-API antes de aprobar
  if (!requiresEmulator) {
    if (qaMode === 'api') {
      // QA-API necesita backend vivo — check 3 con warm-up (tolera cold start de Lambda)
      const warmup = checkBackendWithWarmup(issue);
      if (warmup.ok) {
        checks.backend = `ok:${warmup.httpCode}`;
        log('preflight', `#${issue}: check 3 (QA-API) OK — backend responde HTTP ${warmup.httpCode}`);
      } else {
        checks.backend = `error:${warmup.error}`;
        log('preflight', `#${issue}: check 3 (QA-API) FAIL — ${warmup.error} → blocked:infra`);
      }

      if (!warmup.ok) {
        logPreflight(issue, checks, 'blocked:infra', startMs);
        sendBlockedInfraNotif(issue, `⚠️ Pre-flight QA-API #${issue}: backend no responde tras ${WARMUP_RETRIES} intentos (cold start). Issue bloqueado hasta que se recupere.`);
        return { ok: false, result: 'blocked:infra', reason: `Backend no responde (${checks.backend})`, flavors: [], requiresEmulator: false, qaMode };
      }

      // Check DynamoDB remoto (no overrides locales)
      const dynamoCheck = checkDynamoDbRemote(issue);
      checks.dynamodb = dynamoCheck.checks;
      if (!dynamoCheck.ok) {
        logPreflight(issue, checks, 'blocked:infra', startMs);
        sendBlockedInfraNotif(issue, `⚠️ Pre-flight QA-API #${issue}: DynamoDB apunta a local o no responde. Verificar .env.qa y env vars.`);
        return { ok: false, result: 'blocked:infra', reason: 'DynamoDB no es remoto — overrides locales detectados', flavors: [], requiresEmulator: false, qaMode };
      }
      log('preflight', `#${issue}: check DynamoDB remoto OK`);

      // Capa 3: Verificar/generar test cases para QA-API
      const testCasesFile = path.join(ROOT, 'qa', 'test-cases', `${issue}.json`);
      if (fs.existsSync(testCasesFile)) {
        checks.testCases = 'exists';
        log('preflight', `#${issue}: check 5 (test cases) OK — encontrado ${testCasesFile}`);
      } else {
        // Fallback: generar test cases automáticamente desde criterios del issue
        log('preflight', `#${issue}: check 5 (test cases) — no existe, generando fallback...`);
        try {
          const genScript = path.join(ROOT, 'qa', 'scripts', 'qa-generate-test-cases.js');
          const ghPath = fs.existsSync(GH_BIN) ? GH_BIN : 'gh';
          execSync(`node "${genScript}"`, {
            encoding: 'utf8',
            timeout: 20000,
            windowsHide: true,
            env: { ...process.env, QA_ISSUE: String(issue), GH_PATH: ghPath }
          });
          checks.testCases = 'generated-fallback';
          log('preflight', `#${issue}: check 5 (test cases) OK — generados como fallback`);
        } catch (genErr) {
          // No bloquear si falla la generación — el agente QA puede generar manualmente
          checks.testCases = `gen-failed:${genErr.message.slice(0, 60)}`;
          log('preflight', `#${issue}: check 5 (test cases) WARN — generación fallback falló, el agente QA los generará`);
        }
      }
    }

    logPreflight(issue, checks, 'pass', startMs);
    return { ok: true, result: 'pass', reason: `Issue ${qaMode} — no requiere emulador ni APK`, flavors: [], requiresEmulator: false, qaMode };
  }

  // --- Check 2: APK disponible (solo si requiere emulador) ---
  fs.mkdirSync(QA_ARTIFACTS_DIR, { recursive: true });
  const missingApks = [];
  for (const flavor of flavors) {
    const apkName = `${issue}-composeApp-${flavor}-debug.apk`;
    const apkPath = path.join(QA_ARTIFACTS_DIR, apkName);
    if (!fs.existsSync(apkPath)) {
      missingApks.push(apkName);
    }
  }

  if (missingApks.length > 0) {
    checks.apk = `missing:${missingApks.join(',')}`;
    log('preflight', `#${issue}: check 2 FAIL — APK faltante: ${missingApks.join(', ')} → re-encolar para build`);
    logPreflight(issue, checks, 'apk_missing', startMs);
    return { ok: false, result: 'apk_missing', reason: `APK faltante: ${missingApks.join(', ')}`, flavors, requiresEmulator: true, qaMode: 'android' };
  }
  checks.apk = 'ok';
  log('preflight', `#${issue}: check 2 OK (APK encontrado para ${flavors.join(', ')})`);

  // --- Check 3: Backend responde (con warm-up para tolerar cold start de Lambda) ---
  const warmupAndroid = checkBackendWithWarmup(issue);
  if (warmupAndroid.ok) {
    checks.backend = `ok:${warmupAndroid.httpCode}`;
    log('preflight', `#${issue}: check 3 OK (backend responde HTTP ${warmupAndroid.httpCode})`);
  } else {
    checks.backend = `error:${warmupAndroid.error}`;
    log('preflight', `#${issue}: check 3 FAIL — ${warmupAndroid.error} → blocked:infra`);
    logPreflight(issue, checks, 'blocked:infra', startMs);
    sendBlockedInfraNotif(issue, `⚠️ Pre-flight QA #${issue}: backend no responde tras ${WARMUP_RETRIES} intentos (cold start). Issue bloqueado hasta que se recupere.`);
    return { ok: false, result: 'blocked:infra', reason: `Backend no responde (${checks.backend})`, flavors, requiresEmulator: true, qaMode: 'android' };
  }

  // --- Check 3b: DynamoDB remoto (no overrides locales) ---
  const dynamoCheckAndroid = checkDynamoDbRemote(issue);
  checks.dynamodb = dynamoCheckAndroid.checks;
  if (!dynamoCheckAndroid.ok) {
    logPreflight(issue, checks, 'blocked:infra', startMs);
    sendBlockedInfraNotif(issue, `⚠️ Pre-flight QA #${issue}: DynamoDB apunta a local o no responde. Verificar .env.qa y env vars.`);
    return { ok: false, result: 'blocked:infra', reason: 'DynamoDB no es remoto — overrides locales detectados', flavors, requiresEmulator: true, qaMode: 'android' };
  }
  log('preflight', `#${issue}: check DynamoDB remoto OK`);

  // --- Check 4: Emulador disponible via ADB + test de screenrecord (Blindaje 2) ---
  let emulatorReady = false;
  let emulatorSerial = '';
  try {
    const adbOutput = execSync('adb devices', {
      encoding: 'utf8', timeout: 5000, windowsHide: true
    }).trim();
    // Buscar linea con "emulator" y estado "device" (no "offline")
    const lines = adbOutput.split('\n').filter(l => l.includes('emulator') && l.includes('device'));
    emulatorReady = lines.length > 0;
    if (emulatorReady) {
      emulatorSerial = lines[0].split('\t')[0].trim();
    }
  } catch {}

  if (!emulatorReady) {
    checks.emulator = 'waiting';
    log('preflight', `#${issue}: check 4 FAIL (emulador no disponible) → waiting:emulator — señalizando ventana QA`);
    logPreflight(issue, checks, 'waiting:emulator', startMs);
    return { ok: false, result: 'waiting:emulator', reason: 'Emulador no disponible — requiere activación de ventana QA', flavors, requiresEmulator: true, qaMode: 'android' };
  }

  // Blindaje 2: Mini screenrecord de prueba (2s) para verificar que ADB puede grabar.
  // Con el gating de boot real en qa-environment.waitBootCompleted(), el framework
  // ya está listo antes de llegar acá, así que un solo intento es suficiente.
  // Si falla, es ADB realmente inestable y conviene abortar el preflight rápido.
  let screenrecordOk = false;
  try {
    execSync(
      `adb -s ${emulatorSerial} shell "screenrecord --time-limit 2 /sdcard/qa-preflight-test.mp4 && ls -l /sdcard/qa-preflight-test.mp4 && rm -f /sdcard/qa-preflight-test.mp4"`,
      { encoding: 'utf8', timeout: 15000, windowsHide: true }
    );
    screenrecordOk = true;
    log('preflight', `#${issue}: check 4b OK — screenrecord test passed`);
  } catch (e) {
    log('preflight', `#${issue}: check 4b FAIL — screenrecord: ${e.message.slice(0, 80)}`);
  }

  if (!screenrecordOk) {
    checks.emulator = 'screenrecord-fail';
    log('preflight', `#${issue}: check 4b FAIL — screenrecord no funciona → blocked:infra`);
    logPreflight(issue, checks, 'blocked:infra', startMs);
    sendBlockedInfraNotif(issue, `⚠️ Pre-flight QA #${issue}: emulador disponible pero screenrecord no funciona. Posible ADB inestable — reintentando en proxima ventana.`);
    return { ok: false, result: 'blocked:infra', reason: 'Screenrecord no funciona — ADB inestable', flavors, requiresEmulator: true, qaMode: 'android' };
  }

  checks.emulator = 'ok+screenrecord';
  log('preflight', `#${issue}: check 4 OK (emulador disponible + screenrecord verificado)`);

  // --- Check 5: Pre-warm — instalar APK, abrir app, cerrar diálogos ---
  // El agente QA pierde minutos valiosos lidiando con ANR dialogs, onboarding,
  // y permisos del sistema. Este paso deja la app en estado limpio para testear.
  try {
    const flavor = flavors[0] || 'client';
    const apkName = `${issue}-composeApp-${flavor}-debug.apk`;
    const apkPath = path.join(QA_ARTIFACTS_DIR, apkName);

    // 5a. Instalar APK (replace si ya existía)
    execSync(`adb -s ${emulatorSerial} install -r -t "${apkPath}"`, {
      encoding: 'utf8', timeout: 60000, windowsHide: true
    });
    log('preflight', `#${issue}: check 5a OK — APK instalado (${flavor})`);

    // 5b. Determinar package name del flavor
    const FLAVOR_PACKAGES = {
      client: 'com.intrale.app.client',
      business: 'com.intrale.app.business',
      delivery: 'com.intrale.app.delivery',
    };
    const pkg = FLAVOR_PACKAGES[flavor] || FLAVOR_PACKAGES.client;

    // 5c. Forzar stop (estado limpio) y lanzar la app
    execSync(`adb -s ${emulatorSerial} shell am force-stop ${pkg}`, {
      encoding: 'utf8', timeout: 5000, windowsHide: true
    });
    execSync(`adb -s ${emulatorSerial} shell monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`, {
      encoding: 'utf8', timeout: 10000, windowsHide: true
    });

    // 5d. Esperar que la app arranque y cerrar diálogos del sistema (ANR, permisos, etc.)
    // Screenrecord tarda ~3s en estabilizarse, la app ~5s en cold start.
    const waitMs = 8000;
    const waitStart = Date.now();
    while (Date.now() - waitStart < waitMs) {
      try {
        // Buscar y cerrar diálogos ANR ("Wait" / "Close app")
        const uiDump = execSync(
          `adb -s ${emulatorSerial} shell "uiautomator dump /dev/tty 2>/dev/null"`,
          { encoding: 'utf8', timeout: 5000, windowsHide: true }
        );
        if (uiDump.includes('android:id/aerr_wait') || uiDump.includes("Wait")) {
          // Tap "Wait" para descartar ANR dialog
          execSync(`adb -s ${emulatorSerial} shell input keyevent KEYCODE_ENTER`, {
            encoding: 'utf8', timeout: 3000, windowsHide: true
          });
          log('preflight', `#${issue}: check 5d — cerrado diálogo ANR`);
        } else if (uiDump.includes('Saltar') || uiDump.includes('saltar') || uiDump.includes('Skip')) {
          // Tap "Saltar" en onboarding — buscar coordenadas del botón
          execSync(`adb -s ${emulatorSerial} shell input keyevent KEYCODE_TAB && adb -s ${emulatorSerial} shell input keyevent KEYCODE_ENTER`, {
            encoding: 'utf8', timeout: 3000, windowsHide: true
          });
          log('preflight', `#${issue}: check 5d — saltado onboarding`);
        } else {
          // Sin diálogos, app cargando normalmente
          break;
        }
      } catch { /* UI dump puede fallar si la app aún no renderizó */ }
      // Pausa corta entre intentos
      execSync('ping -n 2 127.0.0.1 > NUL', { timeout: 3000, windowsHide: true });
    }

    checks.prewarm = 'ok';
    log('preflight', `#${issue}: check 5 OK — app pre-warmed (${flavor}, pkg: ${pkg})`);
  } catch (e) {
    // Pre-warm no es bloqueante — si falla, el agente QA puede hacer el setup él mismo
    checks.prewarm = `warn:${e.message.slice(0, 60)}`;
    log('preflight', `#${issue}: check 5 WARN — pre-warm falló (no bloqueante): ${e.message.slice(0, 80)}`);
  }

  // --- Todos los checks pasaron ---
  logPreflight(issue, checks, 'pass', startMs);
  return { ok: true, result: 'pass', reason: 'Todos los pre-flight checks OK', flavors, requiresEmulator: true, qaMode: 'android', emulatorSerial };
}

/** Persistir resultado de pre-flight en log JSONL para análisis */
function logPreflight(issue, checks, result, startMs) {
  try {
    const entry = {
      timestamp: new Date().toISOString(),
      issue: String(issue),
      checks,
      result,
      duration_ms: Date.now() - startMs
    };
    fs.appendFileSync(PREFLIGHT_LOG_FILE, JSON.stringify(entry) + '\n');
  } catch {}
}

/**
 * Encolar un pedido de start/stop del emulador al servicio-emulador.
 * El servicio procesa la cola con coalescencia last-write-wins.
 * Diseño: docs/pipeline/diseno-servicio-emulador.md
 */
function requestEmulator(action, requester, issue, reason) {
  const ts = Date.now();
  const msg = { action, requester, issue: issue || null, reason: reason || '', timestamp: Math.floor(ts / 1000) };
  const svcDir = path.join(PIPELINE, 'servicios', 'emulador', 'pendiente');
  try {
    fs.mkdirSync(svcDir, { recursive: true });
    const file = path.join(svcDir, `${ts}-${Math.random().toString(36).slice(2, 6)}.json`);
    fs.writeFileSync(file, JSON.stringify(msg, null, 2));
    log('qa-env', `Encolado ${action} emulador (requester: ${requester}, issue: #${issue || '-'})`);
  } catch (e) {
    log('qa-env', `Error encolando ${action} emulador: ${e.message}`);
  }
}

function lanzarAgenteClaude(skill, issue, trabajandoPath, pipeline, fase, config, extraEnv = {}) {
  // INVARIANTE CRÍTICO: el skill debe pertenecer a skills_por_fase[fase] de este pipeline.
  // Ningún agente puede correr en una fase que no es la suya, ni siquiera por excepción
  // (incidentes previos: project_apk-builder-responsibility, project_build-bypass-agent).
  // Si esto falla, el archivo se devuelve a pendiente/ y se alerta — NO se lanza.
  try {
    const skillsValidos = ((config.pipelines || {})[pipeline] || {}).skills_por_fase || {};
    const permitidos = skillsValidos[fase] || [];
    if (!permitidos.includes(skill)) {
      log('lanzamiento', `⛔ INVARIANTE: skill "${skill}" no pertenece a fase "${fase}" (permitidos: ${permitidos.join(', ') || '∅'}). Archivo: ${path.basename(trabajandoPath)}`);
      sendTelegram(`⛔ Pipeline bloqueó lanzamiento de ${skill}:#${issue} en fase "${fase}" — skill no autorizado para esa fase. Revisar inmediatamente.`);
      try {
        const pendienteDir = path.join(fasePath(pipeline, fase), 'pendiente');
        moveFile(trabajandoPath, pendienteDir);
      } catch {}
      return;
    }
  } catch (invErr) {
    log('lanzamiento', `⚠️ No se pudo validar invariante skill∈fase para ${skill}:#${issue}: ${invErr.message}`);
    return;
  }

  const basePrompt = path.join(PIPELINE, 'roles', '_base.md');
  const rolPrompt = path.join(PIPELINE, 'roles', `${skill}.md`);

  // Verificar que los prompts existen
  if (!fs.existsSync(basePrompt) || !fs.existsSync(rolPrompt)) {
    log('lanzamiento', `SKIP ${skill}:#${issue} — falta prompt (${!fs.existsSync(basePrompt) ? '_base.md' : skill + '.md'})`);
    return;
  }

  const base = fs.readFileSync(basePrompt, 'utf8');
  const rol = fs.readFileSync(rolPrompt, 'utf8');
  const workData = readYaml(trabajandoPath);

  // Escribir system prompt (rol) a archivo y user prompt corto como argumento
  const systemFile = path.join(LOG_DIR, `agent-${issue}-${skill}-system.txt`);
  fs.writeFileSync(systemFile, `${base}\n\n${rol}`);

  // Construir user prompt — enriquecer si es un rebote con contexto del rechazo
  let userPrompt = `Archivo de trabajo: ${path.basename(trabajandoPath)}\nPath: ${trabajandoPath}\nContenido:\n${yaml.dump(workData, { lineWidth: -1 })}`;

  if (workData.rebote) {
    const rechazadoEn = workData.rechazado_en_fase || 'desconocida';
    const motivo = workData.motivo_rechazo || 'sin motivo especificado';
    const buildLog = path.join(LOG_DIR, `build-${issue}.log`);
    const buildLogExists = fs.existsSync(buildLog);

    userPrompt += `\n\n⚠️ REBOTE — Este issue fue RECHAZADO en la fase "${rechazadoEn}" y vuelve a vos para corrección.\n`;
    userPrompt += `MOTIVO DEL RECHAZO:\n${motivo}\n\n`;
    userPrompt += `INSTRUCCIONES OBLIGATORIAS:\n`;
    userPrompt += `1. Actualizá tu rama con main: git fetch origin main && git merge origin/main --no-edit\n`;
    userPrompt += `2. Leé el motivo de rechazo arriba con atención\n`;
    if (buildLogExists) {
      userPrompt += `3. Leé el log completo del build: cat "${buildLog}" | tail -100\n`;
      userPrompt += `   El log tiene el output de gradlew con los errores exactos de compilación o tests\n`;
    }
    userPrompt += `4. Diagnosticá la causa raíz del fallo\n`;
    userPrompt += `5. Corregí el código en tu worktree\n`;
    userPrompt += `6. Verificá que compila: ./gradlew check --no-daemon\n`;
    userPrompt += `7. Commiteá y pusheá los fixes\n`;
    userPrompt += `\nNO reimplementes desde cero. Focalizá solo en corregir los errores del rechazo.\n`;
  }

  // Determinar si necesita worktree (solo fases que modifican código)
  const needsWorktree = (fase === 'dev');
  const useExistingWorktree = (fase === 'build');
  let worktreePath = ROOT;
  let worktreeBranch = null;

  if (needsWorktree) {
    try {
      worktreeBranch = `agent/${issue}-${skill}`;
      worktreePath = path.join(ROOT, '..', `platform.agent-${issue}-${skill}`);

      if (!fs.existsSync(worktreePath)) {
        execSync(`git worktree add "${worktreePath}" -b "${worktreeBranch}" origin/main`, {
          cwd: ROOT, encoding: 'utf8', timeout: 30000, windowsHide: true
        });
        log('lanzamiento', `Worktree creado: ${worktreePath}`);
      }
    } catch (e) {
      log('lanzamiento', `Error creando worktree para #${issue}: ${e.message}`);
      const pendienteDir = path.join(fasePath(pipeline, fase), 'pendiente');
      moveFile(trabajandoPath, pendienteDir);
      return;
    }
  } else if (useExistingWorktree) {
    // Build: buscar el worktree existente del issue (creado en fase dev)
    try {
      const worktreePattern = `platform.agent-${issue}-`;
      const worktrees = execSync('git worktree list --porcelain', { cwd: ROOT, encoding: 'utf8', windowsHide: true });
      for (const line of worktrees.split('\n')) {
        if (line.startsWith('worktree ') && line.includes(worktreePattern)) {
          worktreePath = line.replace('worktree ', '').trim();
          break;
        }
      }
      if (worktreePath !== ROOT) {
        log('lanzamiento', `Build #${issue}: usando worktree existente ${worktreePath}`);
      } else {
        log('lanzamiento', `Build #${issue}: no se encontró worktree, usando ROOT`);
      }
    } catch (e) {
      log('lanzamiento', `Build #${issue}: error buscando worktree (${e.message}), usando ROOT`);
    }
  }

  const args = ['-p', userPrompt, '--system-prompt-file', systemFile, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions'];

  log('lanzamiento', `Lanzando ${skill}:#${issue} (fase: ${fase}, pipeline: ${pipeline})`);

  // Log de agente: redirigir stdout/stderr directamente al archivo
  const agentLogPath = path.join(LOG_DIR, `${issue}-${skill}.log`);
  fs.writeFileSync(agentLogPath, `--- ${skill}:#${issue} fase:${fase} pipeline:${pipeline} ${new Date().toISOString()} ---\n`);
  const agentLogFd = fs.openSync(agentLogPath, 'a');

  // --- RECORDING AUTOMÁTICO: iniciar screenrecord en background para QA android ---
  // El pipeline graba, no el agente. Así garantizamos que siempre hay video.
  let qaRecordingProc = null;
  let qaRecordingPath = null;
  const qaSerial = extraEnv.QA_EMULATOR_SERIAL;
  if (skill === 'qa' && fase === 'verificacion' && qaSerial) {
    try {
      const evidenceDir = path.join(ROOT, 'qa', 'evidence', String(issue));
      fs.mkdirSync(evidenceDir, { recursive: true });
      qaRecordingPath = `/sdcard/qa-${issue}-pipeline.mp4`;
      // screenrecord tiene límite de 3 minutos por defecto. Usamos --time-limit 180
      // y --bit-rate 6M para balance calidad/tamaño. Si el agente dura más, el video
      // captura los primeros 3 minutos que es donde ocurre el flujo principal.
      qaRecordingProc = spawn('adb', [
        '-s', qaSerial, 'shell',
        `screenrecord --time-limit 180 --bit-rate 6000000 ${qaRecordingPath}`
      ], { stdio: 'ignore', detached: true, windowsHide: true });
      qaRecordingProc.unref();
      log('lanzamiento', `🎬 Recording iniciado para qa:#${issue} (serial: ${qaSerial})`);
    } catch (e) {
      log('lanzamiento', `⚠️ Error iniciando recording para qa:#${issue}: ${e.message.slice(0, 80)}`);
      qaRecordingProc = null;
    }
  }

  // Usar Node directo para evitar cmd.exe y ventanas visibles
  const spawnCmd = USE_NODE_DIRECT ? process.execPath : CLAUDE_BIN;
  const spawnArgs = USE_NODE_DIRECT ? [CLAUDE_CLI_JS, ...args] : args;

  const child = spawn(spawnCmd, spawnArgs, {
    cwd: (needsWorktree || useExistingWorktree) ? worktreePath : ROOT,
    stdio: ['ignore', agentLogFd, agentLogFd],
    detached: false,
    shell: false,
    windowsHide: true,
    env: { ...process.env, PIPELINE_ISSUE: issue, PIPELINE_SKILL: skill, PIPELINE_FASE: fase, ...extraEnv }
  });

  child.unref();
  // NO cerrar agentLogFd aquí — en Windows, cerrar el FD en el padre
  // mata la herencia y el hijo pierde stdout/stderr.
  // Se cierra en child.on('exit') para que el log capture todo el output.

  // Watchdog de timeout por skill: mata al hijo si excede el límite configurado.
  // Razón: sin enforcement, un /builder con OOM repetido puede quedar 1h+ en loop
  // (incidente #2218). El tope de 30m del rol no se aplica solo — hay que forzarlo.
  const timeoutOverrides = config.timeouts?.agent_timeout_overrides || {};
  const timeoutDefault = config.timeouts?.agent_timeout_default_minutes || 30;
  const timeoutMin = timeoutOverrides[skill] ?? timeoutDefault;
  const timeoutMs = timeoutMin * 60 * 1000;
  const watchdog = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      log('lanzamiento', `⏱️ ${skill}:#${issue} excedió ${timeoutMin}min — matando (watchdog)`);
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 10000);
      try {
        const data = readYaml(trabajandoPath);
        data.resultado = 'rechazado';
        data.motivo = `Timeout de watchdog: excedió ${timeoutMin} minutos sin terminar`;
        data.rechazado_por = 'watchdog-timeout';
        writeYaml(trabajandoPath, data);
      } catch {}
      sendTelegram(`⏱️ ${skill}:#${issue} matado por watchdog (${timeoutMin}min). Rebote a pendiente.`);
    }
  }, timeoutMs);
  watchdog.unref?.();

  activeProcesses.set(processKey(skill, issue), {
    pid: child.pid,
    startTime: Date.now(),
    trabajandoPath,
    pipeline,
    fase,
    worktreePath: (needsWorktree || useExistingWorktree) ? worktreePath : null,
    watchdog
  });

  // Crear canal de contexto para el agente (auto-join)
  let contextChannelId = null;
  try {
    const cm = require(path.join(ROOT, '.claude', 'hooks', 'context-manager'));
    const channelId = 'agent-' + issue;
    let channel = cm.getChannel(channelId);
    if (!channel) {
      channel = cm.createChannel(channelId, skill + ' #' + issue, {
        type: 'agent', issue: '#' + issue, skill: skill,
        branch: worktreeBranch || null, worktree: needsWorktree ? worktreePath : null,
      });
    }
    cm.joinChannel(channelId, {
      type: 'agent', session_id: String(child.pid),
      label: skill + ' #' + issue,
    });
    contextChannelId = channelId;
    log('lanzamiento', `Canal de contexto creado: ${channelId}`);
  } catch (e) {
    log('lanzamiento', `Error creando canal de contexto: ${e.message}`);
  }

  // Cuando el proceso termina, mover de trabajando → listo
  const launchTime = Date.now();
  child.on('exit', (code) => {
    // Cerrar el FD del log ahora que el hijo terminó
    try { fs.closeSync(agentLogFd); } catch {}
    // Cancelar watchdog de timeout (ya terminó, por el motivo que sea)
    clearTimeout(watchdog);

    const elapsedSec = (Date.now() - launchTime) / 1000;

    // Si murió en menos de 15 segundos con error → fallo de infra + COOLDOWN
    if (code !== 0 && elapsedSec < 15) {
      const { failures, delayMin } = registerFastFail(skill, issue);
      log('lanzamiento', `⚠️ ${skill}:#${issue} murió en ${elapsedSec.toFixed(0)}s (code=${code}) — fallo #${failures}, cooldown ${delayMin}min`);
      const pendienteDir = path.join(fasePath(pipeline, fase), 'pendiente');
      try { moveFile(trabajandoPath, pendienteDir); } catch {}
      activeProcesses.delete(processKey(skill, issue));
      // Matar Gradle daemons incluso en fast-fail
      killGradleDaemonsForCwd((needsWorktree || useExistingWorktree) ? worktreePath : ROOT, `${skill}:#${issue} (fast-fail)`);
      // Salir del canal de contexto
      if (contextChannelId) {
        try {
          const cm = require(path.join(ROOT, '.claude', 'hooks', 'context-manager'));
          cm.leaveChannelByType(contextChannelId, 'agent');
        } catch (e) {}
      }
      sendTelegram(`⚠️ ${skill}:#${issue} murió en ${elapsedSec.toFixed(0)}s — fallo #${failures}. Cooldown ${delayMin}min antes de reintentar.`);
      // Reporte PDF de muerte prematura (background)
      try {
        const reportScript = path.join(PIPELINE, 'rejection-report.js');
        const reportChild = spawn(process.execPath, [
          reportScript,
          '--issue', String(issue), '--skill', skill, '--fase', fase,
          '--code', String(code), '--elapsed', String(Math.round(elapsedSec)),
          '--motivo', `Muerte prematura (${elapsedSec.toFixed(0)}s, fallo #${failures})`,
          '--log', `${issue}-${skill}.log`, '--pipeline', pipeline
        ], { cwd: ROOT, stdio: 'ignore', detached: true, windowsHide: true });
        reportChild.unref();
      } catch {}
      return;
    }

    // Éxito o finalización normal → limpiar cooldown
    if (code === 0) clearCooldown(skill, issue);

    // Registrar consumo de recursos del agente para perfiles predictivos
    if (elapsedSec > 30) { // Solo si corrió suficiente para tener snapshots
      recordSkillResourceUsage(skill, launchTime, Date.now());
    }

    const listoDir = path.join(fasePath(pipeline, fase), 'listo');
    try {
      const data = readYaml(trabajandoPath);
      if (!data.resultado) {
        data.resultado = code === 0 ? 'aprobado' : 'rechazado';
        data.motivo = code !== 0 ? `Agente terminó con código ${code}` : undefined;
        writeYaml(trabajandoPath, data);
      }

      // --- STOP RECORDING + PULL VIDEO ---
      // Parar screenrecord del pipeline y bajar el video al evidence dir
      if (skill === 'qa' && fase === 'verificacion' && qaRecordingPath && qaSerial) {
        // pkill puede fallar si screenrecord ya autoterminó por --time-limit;
        // no debe abortar el pull. Sin sintaxis bash (2>/dev/null || true)
        // porque execSync usa cmd.exe en Windows.
        try {
          execSync(`adb -s ${qaSerial} shell pkill -f screenrecord`, {
            encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: 'ignore'
          });
        } catch {
          // Sin proceso vivo: screenrecord ya cerró el mp4 por timeout. OK.
        }
        try {
          // Esperar a que el archivo se cierre (screenrecord tarda ~1s en flush)
          execSync('ping -n 3 127.0.0.1 > NUL', { timeout: 5000, windowsHide: true });
          // Pull del video
          const evidenceDir = path.join(ROOT, 'qa', 'evidence', String(issue));
          fs.mkdirSync(evidenceDir, { recursive: true });
          const localVideo = path.join(evidenceDir, `qa-${issue}-raw.mp4`);
          // Fix #2281: MSYS_NO_PATHCONV evita que Git Bash convierta "/sdcard/..."
          // a "C:/Program Files/Git/sdcard/..." cuando lo pasa como argumento top-level
          // a adb.exe. MSYS2_ARG_CONV_EXCL=* desactiva toda conversión de argumentos.
          // En entornos no-MSYS (Linux/macOS/CI) estas vars se ignoran silenciosamente.
          const adbEnv = { ...process.env, MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' };
          execSync(`adb -s ${qaSerial} pull "${qaRecordingPath}" "${localVideo}"`, {
            encoding: 'utf8', timeout: 30000, windowsHide: true, env: adbEnv
          });
          // Limpiar del emulador
          try {
            execSync(`adb -s ${qaSerial} shell rm -f "${qaRecordingPath}"`, {
              encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: 'ignore', env: adbEnv
            });
          } catch {
            // Cleanup best-effort
          }
          const videoStat = fs.statSync(localVideo);
          const videoSizeKb = Math.round(videoStat.size / 1024);
          log('lanzamiento', `🎬 Recording parado para qa:#${issue} — video: ${videoSizeKb}KB → ${localVideo}`);
          // Inyectar metadata de evidencia en el YAML (50KB es suficiente con swiftshader).
          if (videoSizeKb >= 50) {
            data.evidencia = localVideo;
            data.video_size_kb = videoSizeKb;
            // Audio narrado no se genera acá (el agente QA lo hace), pero el video crudo sí
            writeYaml(trabajandoPath, data);
          }
        } catch (e) {
          log('lanzamiento', `⚠️ Error bajando recording qa:#${issue}: ${e.message.slice(0, 80)}`);
        }
        // Matar el proceso local si sigue vivo
        if (qaRecordingProc && qaRecordingProc.exitCode === null) {
          try { qaRecordingProc.kill(); } catch {}
        }
      }

      // --- VALIDACIÓN ON-EXIT QA ---
      // Si el agente QA terminó diciendo "aprobado" pero sin evidencia, forzar rechazo
      if (skill === 'qa' && fase === 'verificacion' && data.resultado === 'aprobado') {
        const evidenceIssues = validateQaEvidence(issue, data);
        if (evidenceIssues.length > 0) {
          log('lanzamiento', `⛔ QA:#${issue} aprobó sin evidencia válida on-exit: ${evidenceIssues.join(', ')}`);
          data.resultado = 'rechazado';
          data.motivo = `Evidencia QA incompleta (gate on-exit): ${evidenceIssues.join('; ')}`;
          data.rechazado_por = 'gate-evidencia-on-exit';
          writeYaml(trabajandoPath, data);
          sendTelegram(`⛔ QA:#${issue} — evidencia incompleta al terminar. Rechazo automático: ${evidenceIssues.join('; ')}`);
        }
      }

      moveFile(trabajandoPath, listoDir);
      log('lanzamiento', `${skill}:#${issue} terminó (code=${code}, ${elapsedSec.toFixed(0)}s) → listo/`);

      // Generar reporte PDF de rechazo y enviar a Telegram (background, no bloquea)
      if (data.resultado === 'rechazado') {
        try {
          const reportScript = path.join(PIPELINE, 'rejection-report.js');
          const reportArgs = [
            reportScript,
            '--issue', String(issue), '--skill', skill, '--fase', fase,
            '--code', String(code), '--elapsed', String(Math.round(elapsedSec)),
            '--motivo', String(data.motivo || 'Sin motivo'),
            '--log', `${issue}-${skill}.log`, '--pipeline', pipeline
          ];
          const reportChild = spawn(process.execPath, reportArgs, {
            cwd: ROOT, stdio: 'ignore', detached: true, windowsHide: true
          });
          reportChild.unref();
          log('lanzamiento', `📄 Reporte de rechazo lanzado para ${skill}:#${issue}`);
        } catch (reportErr) {
          log('lanzamiento', `⚠️ Error lanzando reporte de rechazo: ${reportErr.message}`);
        }
      }
    } catch (e) {
      log('lanzamiento', `Error post-proceso ${skill}:#${issue}: ${e.message}`);
    }
    activeProcesses.delete(processKey(skill, issue));

    // Matar Gradle daemons del worktree para liberar RAM (cada daemon usa hasta 4GB)
    // Delay de 10s para evitar race condition: si el barrido ya lanzó un build en este
    // worktree, el guard dentro de killGradleDaemonsForCwd lo protegerá.
    const cleanupCwd = (needsWorktree || useExistingWorktree) ? worktreePath : ROOT;
    const cleanupLabel = `${skill}:#${issue}`;
    setTimeout(() => killGradleDaemonsForCwd(cleanupCwd, cleanupLabel), 10000);

    // Salir del canal de contexto (el canal queda para que otros lo consulten)
    if (contextChannelId) {
      try {
        const cm = require(path.join(ROOT, '.claude', 'hooks', 'context-manager'));
        cm.leaveChannelByType(contextChannelId, 'agent');
        cm.postMessage(contextChannelId, {
          from: 'system', from_label: 'Pipeline',
          type: 'system',
          content: skill + ' #' + issue + ' finalizó (code=' + code + ')',
        });
      } catch (e) {}
    }
  });

  // stdout/stderr redirigidos al archivo de log via stdio fd
}

// =============================================================================
// BRAZO 3: HUÉRFANOS — Detecta archivos trabados en trabajando/
// =============================================================================

const orphanRetries = new Map(); // key: "pipeline/fase/filename" → count
const MAX_ORPHAN_RETRIES = 3;

function brazoHuerfanos(config) {
  const timeoutMinutes = config.timeouts?.orphan_timeout_minutes || 10;

  for (const [pipelineName, pipelineConfig] of Object.entries(config.pipelines)) {
    for (const fase of pipelineConfig.fases) {
      const trabajandoDir = path.join(fasePath(pipelineName, fase), 'trabajando');
      const pendienteDir = path.join(fasePath(pipelineName, fase), 'pendiente');
      const listoDir = path.join(fasePath(pipelineName, fase), 'listo');
      const archivos = listWorkFiles(trabajandoDir);

      for (const archivo of archivos) {
        const skill = skillFromFile(archivo.name);
        const issue = issueFromFile(archivo.name);
        const key = processKey(skill, issue);
        const age = fileAgeMinutes(archivo.path);

        if (age < timeoutMinutes) continue;

        // Verificar si el proceso sigue vivo
        const info = activeProcesses.get(key);
        if (info && isProcessAlive(info.pid)) continue;

        const retryKey = `${pipelineName}/${fase}/${archivo.name}`;
        const retries = (orphanRetries.get(retryKey) || 0) + 1;
        orphanRetries.set(retryKey, retries);

        if (retries > MAX_ORPHAN_RETRIES) {
          // Demasiados reintentos → marcar como rechazado y mover a listo
          log('huerfanos', `${archivo.name} excedió ${MAX_ORPHAN_RETRIES} reintentos → rechazado`);
          try {
            const data = readYaml(archivo.path);
            data.resultado = 'rechazado';
            data.motivo = `Huérfano tras ${MAX_ORPHAN_RETRIES} reintentos — proceso muere repetidamente`;
            writeYaml(archivo.path, data);
            moveFile(archivo.path, listoDir);
            orphanRetries.delete(retryKey);
            sendTelegram(`⛔ ${skill}:#${issue} rechazado tras ${MAX_ORPHAN_RETRIES} reintentos huérfanos. Requiere intervención manual.`);
          } catch (e) {
            log('huerfanos', `Error rechazando ${archivo.name}: ${e.message}`);
          }
        } else {
          // Devolver a pendiente con cooldown para evitar loop inmediato
          const { failures, delayMin } = registerFastFail(skill, issue);
          log('huerfanos', `${archivo.name} lleva ${Math.round(age)}min sin proceso → pendiente/ (intento ${retries}/${MAX_ORPHAN_RETRIES}, cooldown ${delayMin}min)`);
          try {
            moveFile(archivo.path, pendienteDir);
          } catch (e) {
            log('huerfanos', `Error devolviendo ${archivo.name}: ${e.message}`);
          }
        }
        activeProcesses.delete(key);
      }
    }
  }
}

// =============================================================================
// BRAZO 5: COMMANDER — Procesa mensajes de Telegram con handlers nativos
// =============================================================================

// --- Sesión conversacional persistente ---

const SESSION_FILE = path.join(PIPELINE, 'commander-session.json');

function loadSession() {
  try {
    return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  } catch {
    return { context: null, lastCommand: null, lastTimestamp: null, pendingAction: null };
  }
}

function saveSession(session) {
  fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
}

// --- Handlers nativos de comandos (cero tokens, ejecución instantánea) ---

async function cmdStatus(config) {
  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const mins = Math.floor((uptime % 3600) / 60);

  const lines = ['📊 *Estado del Pipeline*\n'];
  lines.push(`🟢 Online · ${hours}h ${mins}m`);
  lines.push('');

  for (const [pipelineName, pipelineConfig] of Object.entries(config.pipelines)) {
    lines.push(`*${pipelineName.toUpperCase()}*`);
    for (const fase of pipelineConfig.fases) {
      const base = fasePath(pipelineName, fase);
      const p = listWorkFiles(path.join(base, 'pendiente')).length;
      const t = listWorkFiles(path.join(base, 'trabajando')).length;
      const l = listWorkFiles(path.join(base, 'listo')).length;
      if (p + t + l === 0) continue;
      lines.push(`  ${fase}: 📋${p} ⚙️${t} ✅${l}`);

      // Detalle por issue
      const allFiles = [
        ...listWorkFiles(path.join(base, 'pendiente')).map(f => ({ ...f, estado: '📋' })),
        ...listWorkFiles(path.join(base, 'trabajando')).map(f => ({ ...f, estado: '⚙️' })),
        ...listWorkFiles(path.join(base, 'listo')).map(f => ({ ...f, estado: '✅' }))
      ];
      const byIssue = {};
      for (const f of allFiles) {
        const iss = issueFromFile(f.name);
        if (!byIssue[iss]) byIssue[iss] = [];
        byIssue[iss].push(`${skillFromFile(f.name)}${f.estado}`);
      }
      for (const [iss, skills] of Object.entries(byIssue)) {
        lines.push(`    #${iss}: ${skills.join(' ')}`);
      }
    }
    lines.push('');
  }

  // Agentes activos
  const agentes = [];
  for (const [key, info] of activeProcesses) {
    if (isProcessAlive(info.pid)) {
      const age = Math.round((Date.now() - info.startTime) / 60000);
      agentes.push(`  ${key} (${age}min, pid:${info.pid})`);
    }
  }
  if (agentes.length > 0) {
    lines.push('*Agentes activos*');
    lines.push(...agentes);
  } else {
    lines.push('*Agentes activos:* ninguno');
  }

  // Servicios
  lines.push('\n*Servicios*');
  for (const svc of ['telegram', 'github', 'drive', 'commander']) {
    const svcDir = path.join(PIPELINE, 'servicios', svc, 'pendiente');
    const count = listWorkFiles(svcDir).length;
    if (count > 0) lines.push(`  ${svc}: ${count} pendientes`);
  }

  // Recursos del sistema
  const { cpuPercent, memPercent } = getSystemResourceUsage();
  const thresholds = config.resource_limits || {};
  const maxCpu = thresholds.max_cpu_percent || 80;
  const maxMem = thresholds.max_mem_percent || 80;
  const cpuIcon = cpuPercent >= maxCpu ? '🔴' : cpuPercent >= maxCpu * 0.8 ? '🟡' : '🟢';
  const memIcon = memPercent >= maxMem ? '🔴' : memPercent >= maxMem * 0.8 ? '🟡' : '🟢';
  lines.push(`\n*Recursos del sistema*`);
  lines.push(`  ${cpuIcon} CPU: ${cpuPercent}% (max ${maxCpu}%)`);
  lines.push(`  ${memIcon} RAM: ${memPercent}% (max ${maxMem}%)`);
  if (cpuPercent >= maxCpu || memPercent >= maxMem) {
    lines.push(`  ⛔ Lanzamiento bloqueado por sobrecarga`);
  }

  // PRs mergeados hoy
  try {
    const today = new Date().toISOString().slice(0, 10);
    const ghOut = execSync(`"${GH_BIN}" pr list --state merged --search "merged:>=${today}" --limit 20 --json number,title`, { encoding: 'utf8', timeout: 15000, cwd: ROOT });
    const prs = JSON.parse(ghOut);
    if (prs.length > 0) {
      lines.push(`\n*Entregado hoy (${prs.length} PRs)*`);
      for (const pr of prs.slice(0, 10)) {
        lines.push(`  #${pr.number} ${pr.title}`);
      }
      if (prs.length > 10) lines.push(`  +${prs.length - 10} más`);
    }
  } catch (e) {
    log('commander', `[status] Error obteniendo PRs del día: ${e.message}`);
  }

  // Estado pausa
  if (paused) lines.push('\n⏸️ *PULPO PAUSADO*');

  const text = lines.join('\n');

  // Audio TTS de la narración
  try {
    const { textToSpeech, sendVoiceTelegram } = require('./multimedia');
    const botToken = getTelegramToken();
    const chatId = getTelegramChatId();
    if (botToken && chatId) {
      let narration = `Estado del pipeline. Llevo ${hours} horas y ${mins} minutos online. `;
      // Agentes activos
      const aliveCount = [...activeProcesses.values()].filter(i => isProcessAlive(i.pid)).length;
      narration += aliveCount > 0 ? `${aliveCount} agentes activos. ` : 'Sin agentes activos. ';
      // Recursos
      const { cpuPercent: cpu, memPercent: mem } = getSystemResourceUsage();
      narration += `CPU al ${cpu} por ciento, RAM al ${mem} por ciento. `;
      if (paused) narration += 'El pulpo está pausado. ';
      // PRs del día
      try {
        const today = new Date().toISOString().slice(0, 10);
        const ghOut = execSync(`"${GH_BIN}" pr list --state merged --search "merged:>=${today}" --limit 20 --json number,title`, { encoding: 'utf8', timeout: 15000, cwd: ROOT });
        const prs = JSON.parse(ghOut);
        if (prs.length > 0) {
          narration += `Hoy se entregaron ${prs.length} PRs. `;
          for (const pr of prs.slice(0, 5)) {
            narration += `PR ${pr.number}, ${pr.title}. `;
          }
        }
      } catch {}

      const statusChunks = splitTextForTTSChunks(narration, 3800);
      for (let i = 0; i < statusChunks.length; i++) {
        const chunkText = statusChunks.length > 1
          ? `Parte ${i + 1} de ${statusChunks.length}. ${statusChunks[i]}`
          : statusChunks[i];
        const audioBuffer = await textToSpeech(chunkText);
        if (audioBuffer) {
          await sendVoiceTelegram(audioBuffer, botToken, chatId);
          log('commander', `[status] Audio TTS parte ${i + 1}/${statusChunks.length} enviado`);
        }
      }
    }
  } catch (audioErr) {
    log('commander', `[status] Error TTS (no fatal): ${audioErr.message}`);
  }

  return text;
}

function cmdActividad(args) {
  const historyFile = path.join(PIPELINE, 'commander-history.jsonl');
  let lines = [];
  try {
    lines = fs.readFileSync(historyFile, 'utf8').trim().split('\n');
  } catch { return '📭 Sin historial de actividad'; }

  // Parsear filtro
  let filtro = 10;
  let issueFilter = null;

  if (args) {
    const minuteMatch = args.match(/(\d+)m/);
    const issueMatch = args.match(/#?(\d+)/);
    if (minuteMatch) {
      const mins = parseInt(minuteMatch[1]);
      const cutoff = new Date(Date.now() - mins * 60000).toISOString();
      lines = lines.filter(l => {
        try { return JSON.parse(l).timestamp >= cutoff; } catch { return false; }
      });
      filtro = lines.length;
    } else if (issueMatch) {
      issueFilter = issueMatch[1];
      lines = lines.filter(l => l.includes(issueFilter));
      filtro = lines.length;
    }
  }

  const recientes = lines.slice(-filtro);
  if (recientes.length === 0) return '📭 Sin actividad reciente';

  const result = ['📋 *Actividad reciente*\n'];
  for (const line of recientes) {
    try {
      const entry = JSON.parse(line);
      const dir = entry.direction === 'in' ? '→' : '←';
      const ts = entry.timestamp?.slice(11, 16) || '??:??';
      const from = entry.from ? `[${entry.from}]` : '';
      const text = (entry.text || '').slice(0, 80);
      result.push(`${ts} ${dir} ${from} ${text}`);
    } catch {}
  }
  return result.join('\n');
}

function cmdIntake(args, config) {
  if (args) {
    // Intake de un issue específico
    const issueNum = args.replace('#', '').trim();
    if (isIssueClosed(issueNum)) {
      return `⚠️ #${issueNum} está cerrado en GitHub — no se puede ingresar al pipeline`;
    }
    if (issueExistsInPipeline(issueNum, 'desarrollo')) {
      return `⚠️ #${issueNum} ya está activo en el pipeline de desarrollo`;
    }

    // Determinar pipeline de entrada (por defecto desarrollo/validacion)
    const pendienteDir = path.join(fasePath('desarrollo', 'validacion'), 'pendiente');
    const skills = config.pipelines.desarrollo.skills_por_fase.validacion || [];
    for (const skill of skills) {
      const filePath = path.join(pendienteDir, `${issueNum}.${skill}`);
      writeYaml(filePath, { issue: parseInt(issueNum), fase: 'validacion', pipeline: 'desarrollo' });
    }
    log('intake', `#${issueNum} ingresado manualmente vía /intake`);
    return `✅ #${issueNum} ingresado al pipeline → desarrollo/validacion (${skills.join(', ')})`;
  }

  // Forzar intake inmediato (resetear timer)
  lastIntakeTime = 0;
  brazoIntake(config);
  return '✅ Intake ejecutado — revisé GitHub por issues pendientes';
}

function cmdPausar() {
  fs.writeFileSync(PAUSE_FILE, new Date().toISOString());
  paused = true;
  return '⏸️ Pulpo PAUSADO. Usar /reanudar para continuar.';
}

function cmdReanudar() {
  try { fs.unlinkSync(PAUSE_FILE); } catch {}
  paused = false;
  return '▶️ Pulpo REANUDADO. Procesamiento activo.';
}

function cmdCostos() {
  // Leer logs de agentes para estimar actividad
  const logFiles = [];
  try {
    logFiles.push(...fs.readdirSync(LOG_DIR).filter(f => f.endsWith('.log') && !f.startsWith('.')));
  } catch {}

  if (logFiles.length === 0) return '📊 Sin datos de costos disponibles';

  const lines = ['💰 *Resumen de actividad (por logs)*\n'];
  const skillStats = {};

  for (const f of logFiles) {
    const match = f.match(/^(\d+)-(.+)\.log$/);
    if (!match) continue;
    const [, issue, skill] = match;
    const stat = fs.statSync(path.join(LOG_DIR, f));
    const sizeKb = Math.round(stat.size / 1024);
    if (!skillStats[skill]) skillStats[skill] = { count: 0, totalKb: 0 };
    skillStats[skill].count++;
    skillStats[skill].totalKb += sizeKb;
  }

  for (const [skill, stats] of Object.entries(skillStats).sort((a, b) => b[1].totalKb - a[1].totalKb)) {
    lines.push(`  ${skill}: ${stats.count} ejecuciones, ${stats.totalKb}KB output`);
  }

  lines.push(`\n*Total:* ${logFiles.length} logs en .pipeline/logs/`);
  return lines.join('\n');
}

async function cmdProponer(args, config) {
  const count = parseInt(args) || 3;

  const propositorPrompt = `Analizá el backlog de GitHub, el estado actual del código y la deuda técnica del proyecto Intrale.
Generá ${count} propuestas de historias nuevas. Para cada una incluí:
- Título conciso
- Descripción de 2-3 oraciones
- Área (backend/app/web)
- Tamaño estimado (simple/medio/grande)
- Justificación (por qué es importante)

Usá: gh issue list --state open --json number,title,labels,body --limit 50
Y: git log --oneline -20 para ver actividad reciente.

Formato de respuesta: lista numerada, una propuesta por item.`;

  sendTelegram('🔄 Analizando backlog para generar propuestas...');

  try {
    const resultado = await ejecutarClaude(propositorPrompt, 'proponer historias');

    if (resultado) {
      const proposalFile = path.join(PIPELINE, 'commander-proposals.json');
      const proposals = { timestamp: new Date().toISOString(), count, text: resultado };
      fs.writeFileSync(proposalFile, JSON.stringify(proposals, null, 2));

      return `💡 *Propuestas de historias nuevas*\n\n${resultado}\n\n_Respondé "crear N" para crear una como issue, o "descartar" para ignorar._`;
    }
    return '⚠️ No pude generar propuestas. Intentá de nuevo.';
  } catch (e) {
    log('commander', `Error en proponer: ${e.message}`);
    return '⚠️ Error generando propuestas: ' + e.message.slice(0, 100);
  }
}

/** Ejecutar Claude async con spawn + stream-json (patrón V1). Retorna el texto de respuesta. */
/**
 * Genera un acknowledgment contextual basado en lo que el usuario pidió.
 * @param {string} texto - El mensaje del usuario
 * @param {boolean} esAudio - Si el mensaje vino de un audio
 * @returns {string}
 */
function generarAck(texto, esAudio = false) {
  const t = (texto || '').toLowerCase();
  const icon = esAudio ? '🎙️' : '💬';

  // Detectar intención específica
  if (/reinici|restart|levant|arranc/.test(t)) return `${icon} Dale, arranco con el reinicio...`;
  if (/status|estado|tablero|dashboard/.test(t)) return `${icon} Revisando el tablero...`;
  if (/recurs|cpu|ram|memoria|saturad/.test(t)) return `${icon} Mirando los recursos del sistema...`;
  if (/error|fall[oó]|roto|crash|bug/.test(t)) return `${icon} Voy a investigar qué pasó...`;
  if (/test|prueba|verificar|check/.test(t)) return `${icon} Verificando, dame un momento...`;
  if (/deploy|entreg|merge|push|pr\b/.test(t)) return `${icon} Revisando el delivery...`;
  if (/propuesta|propon|diseñ|implement|rediseñ/.test(t)) return `${icon} Lo estoy pensando, ya te cuento...`;
  if (/limpi|clean|kill|mat[aá]/.test(t)) return `${icon} Encargándome de la limpieza...`;
  if (/\?|terminaste|pudiste|hiciste|cómo|cuánto|qué pas/.test(t)) return `${icon} Buena pregunta, ya te respondo...`;

  // Variantes genéricas (no repetir)
  const genericas = [
    `${icon} Ya lo vi, dame un momento...`,
    `${icon} Recibido, estoy en eso...`,
    `${icon} Dale, ya me pongo...`,
    `${icon} Un toque que lo proceso...`,
    `${icon} Enterado, ya laburo en eso...`,
  ];
  return genericas[Math.floor(Math.random() * genericas.length)];
}

/**
 * Genera mensajes de progreso contextuales que evolucionan con el tiempo.
 * Amplio pool (~200 mensajes) para evitar repeticiones, con tono argentino.
 * En vez de stats de operaciones, muestra porcentaje estimado y ETA cuando corresponde.
 * @param {number} count - Número de mensaje de progreso (0, 1, 2, ...)
 * @param {number} elapsedSec - Segundos transcurridos
 * @param {number} tools - Cantidad de herramientas usadas
 * @param {string} lastTool - Descripción de la última herramienta
 * @param {string} textoOriginal - El pedido original del usuario
 * @returns {string}
 */
function generarMensajeProgreso(count, elapsedSec, tools, lastTool, textoOriginal) {
  const ctx = lastTool ? lastTool.slice(0, 50) : '';
  const t = (textoOriginal || '').toLowerCase();

  // Detectar categoría del pedido para contextualizar
  let categoria = 'general';
  if (/reinici|restart|levantar/.test(t)) categoria = 'restart';
  else if (/recurs|cpu|ram|memoria|disco/.test(t)) categoria = 'recursos';
  else if (/error|fall|crash|bug|romp/.test(t)) categoria = 'diagnostico';
  else if (/implement|rediseñ|cambi|agreg|nuev|código|codigo/.test(t)) categoria = 'implementacion';
  else if (/revis|analiz|investig|fij|cheque/.test(t)) categoria = 'investigacion';
  else if (/deploy|merge|pr |pull|entreg|push/.test(t)) categoria = 'delivery';
  else if (/test|qa|calidad|verificar/.test(t)) categoria = 'testing';
  else if (/log|monitor|estado|status|dashboard/.test(t)) categoria = 'monitoreo';
  else if (/clean|limp|orden|borra|elimin/.test(t)) categoria = 'limpieza';
  else if (/issue|backlog|historia|ticket|label/.test(t)) categoria = 'gestion';
  else if (/config|setting|hook|permiso/.test(t)) categoria = 'config';
  else if (/video|drive|subir|upload|archivo/.test(t)) categoria = 'archivos';

  // Pool amplio de mensajes por categoría — argentinizados y variados
  const pools = {
    restart: [
      'Reiniciando los servicios, que a veces se ponen caprichosos',
      'Levantando todo de nuevo, en un toque te confirmo',
      'Tirando abajo y volviendo a armar, que es la que va',
      'Re-arrancando servicios, dame un momentito que termine de levantar todo',
      'Matando procesos y volviendo a lanzar, enseguida',
      'Bajando y subiendo servicios, los que se cuelgan los reinicio de cero',
      'Haciendo el restart limpio, no quiero dejar nada zombie',
      'Arrancando todo fresh, un toque y te confirmo que levantó',
      'El reinicio va bien, estoy esperando que los servicios respondan',
      'Reiniciando con paciencia, que si apuro se traban más',
      'Ahí va levantando todo, algunos servicios tardan un cachito',
      'Ya maté lo que había que matar, ahora estoy levantando de nuevo',
      'Va el restart, verificando que cada servicio arranque como corresponde',
      'Reinicio en marcha, chequeando uno por uno que respondan',
      'Haciendo el ciclo completo de restart, dame unos minutos',
    ],
    recursos: [
      'Mirando cómo anda la máquina, chequeando CPU y memoria',
      'Revisando los consumos del sistema, a ver qué está chupando recursos',
      'Analizando procesos y memoria, enseguida te cuento el panorama',
      'Midiendo cómo andan los recursos, que a veces algún proceso se zarpa',
      'Escaneando el estado del sistema en detalle, ya te armo el reporte',
      'Chequeando qué procesos están comiendo más, dame un toque',
      'Juntando métricas de CPU, RAM y disco para darte el panorama',
      'Revisando la salud del sistema, quiero ver si hay algo que se pasó de rosca',
      'Viendo los consumos en tiempo real, enseguida te reporto qué encontré',
      'Investigando si hay algún proceso desbocado que esté jodiendo',
      'Monitoreando la carga del sistema, un toque y te cuento',
      'Analizando la performance general, quiero darte data precisa',
      'Chequeando si la máquina anda holgada o apretada de recursos',
      'Midiendo tiempos de respuesta y consumo, para ver si hay cuello de botella',
      'Revisando los picos de consumo, dame un ratito que lo proceso',
    ],
    diagnostico: [
      'Revisando los logs a ver qué pasó, bancame un toque',
      'Investigando el problema, leyendo trazas y estado de los servicios',
      'Buscando la causa raíz del quilombo, un ratito más',
      'Metiéndome en los logs para entender qué se rompió',
      'Analizando el error en detalle, quiero darte un diagnóstico posta',
      'Siguiendo el rastro del bug, hay varias pistas a chequear',
      'Leyendo trazas de error para armar la línea de tiempo del problema',
      'Cruzando datos entre los logs, a ver dónde arrancó el despelote',
      'Desenredando el error, que a veces uno tapa al otro',
      'Buscando el punto exacto donde se rompió, ya estoy cerca',
      'Analizando el stack trace y el contexto, quiero darte la posta',
      'Revisando qué cambió para que esto falle, no quiero tirar diagnóstico a medias',
      'Chequeando si el error es puntual o si hay algo de fondo',
      'Rastreando el bug paso a paso, enseguida te cuento qué encontré',
      'Investigando si es un error nuevo o algo que ya venía de antes',
      'Mirando los logs con lupa, quiero entender bien el escenario del fallo',
    ],
    implementacion: [
      'Metido en el código haciendo los cambios, viene bien',
      'Laburando en la implementación, son varios archivos pero avanzo',
      'Escribiendo código y testeando, no quiero mandarte cualquier cosa',
      'Armando los cambios, quiero que quede bien antes de mostrártelo',
      'La implementación tiene sus vueltas pero sale',
      'Haciendo las modificaciones, chequeando que cada parte funcione',
      'Escribiendo el código, me estoy asegurando de no romper nada existente',
      'Avanzando con los cambios, tocando los archivos que corresponden',
      'Codeando y probando sobre la marcha, va tomando forma',
      'Implementando la solución, estoy en la parte más tricky',
      'Armando todo prolijo, que después no quiero volver a tocar esto',
      'En pleno desarrollo, ya hice la parte más pesada',
      'Ajustando los detalles de la implementación, lo grueso ya está',
      'Picando código, enseguida te cuento qué armé',
      'Haciendo las modificaciones paso a paso, sin apurar para no meter la pata',
      'Metiéndole al código, quiero que quede sólido de entrada',
    ],
    investigacion: [
      'Investigando a fondo, leyendo código y logs',
      'Revisando todo lo relacionado al tema, quiero darte data completa',
      'Metiéndome en los archivos para entender bien qué pasa',
      'Analizando el tema en detalle, enseguida te cuento',
      'Ya tengo algunas pistas pero quiero confirmar antes de hablar',
      'Leyendo código fuente para entender cómo funciona esto hoy',
      'Cruzando info de varios archivos, quiero darte un panorama claro',
      'Revisando el historial de cambios para entender el contexto',
      'Investigando a fondo, prefiero tardar un poco más y darte la posta',
      'Siguiendo varias pistas en paralelo, enseguida te cuento',
      'Chequeando cómo se conectan las piezas, esto tiene varias capas',
      'Leyendo documentación y código para darte una respuesta completa',
      'Analizando el tema desde varios ángulos, no quiero dejar nada afuera',
      'Haciendo la investigación como corresponde, sin atajo',
      'Juntando toda la info relevante, un ratito más y te cuento',
      'Rastreando el tema en el código y la config, ya voy entendiendo',
    ],
    delivery: [
      'Preparando todo para entregar, revisando que esté prolijo',
      'Armando el PR con los cambios, un ratito más',
      'Verificando que todo compile y pase los checks antes de pushear',
      'En el proceso de delivery, quiero que salga limpio',
      'Empaquetando los cambios para el merge, ya casi',
      'Haciendo el commit y preparando el push, quiero que el PR quede claro',
      'Revisando el diff final antes de crear el PR',
      'Armando la descripción del PR con los detalles técnicos',
      'Pusheando y creando el PR, dame un toque',
      'Verificando que no falte nada antes del merge',
      'En la recta final de la entrega, revisando todo una vez más',
      'Preparando el delivery, quiero que esté todo documentado',
      'Haciendo las últimas verificaciones antes de entregar',
      'Armando todo para que el merge sea limpio, sin sorpresas',
      'Ya estoy en la parte de delivery, falta poco',
    ],
    testing: [
      'Corriendo tests y verificando calidad, esto lleva su rato',
      'En la fase de testing, quiero asegurarme que no se rompa nada',
      'Ejecutando las verificaciones, bancame que termine de correr todo',
      'Testeando los cambios a fondo, mejor prevenir que curar',
      'Validando que todo funcione como corresponde, un toque más',
      'Pasando los tests uno por uno, hasta ahora vienen bien',
      'Corriendo la suite de tests, enseguida te cuento el resultado',
      'En plena verificación, quiero darte el resultado con confianza',
      'Testeando edge cases, no quiero que algo raro se cuele',
      'Ejecutando validaciones, si pasa todo te confirmo al toque',
      'Revisando que los tests cubran bien los escenarios importantes',
      'En la etapa de verificación, esto es lo que más vale la pena esperar',
      'Corriendo checks de calidad, dame unos minutos',
      'Validando el comportamiento esperado, va bien hasta ahora',
      'Testeando en todas las configuraciones que corresponden',
    ],
    monitoreo: [
      'Revisando el estado de todo, juntando métricas y datos',
      'Chequeando cómo andan los servicios, enseguida te reporto',
      'Mirando el estado del pipeline y los agentes, un momento',
      'Recopilando info del sistema para darte el panorama completo',
      'Monitoreando los servicios, en un toque te armo el resumen',
      'Juntando data de todos los procesos para el reporte',
      'Consultando el estado de cada servicio, ya te armo el status',
      'Chequeando qué está corriendo y qué no, enseguida te cuento',
      'Relevando el estado actual del pipeline, dame un momentito',
      'Armando el panorama general, quiero que sea preciso',
      'Mirando las métricas actualizadas, ya te paso el resumen',
      'Revisando logs recientes y estado de procesos',
      'Verificando la salud de cada componente del pipeline',
      'Recopilando el estado de agentes y servicios, un toque',
      'Consultando todo para darte una foto completa del sistema',
    ],
    limpieza: [
      'Limpiando lo que hay que limpiar, con cuidado de no volar nada importante',
      'Ordenando el workspace, identificando qué se puede borrar tranqui',
      'En la limpieza, revisando qué queda y qué sobra',
      'Haciendo espacio y ordenando, dame un ratito',
      'Barriendo archivos temporales y procesos huérfanos',
      'Identificando basura para eliminar sin tocar lo que importa',
      'Limpiando logs viejos y archivos temporales, con cuidado',
      'Ordenando la casa, que después se acumula y se complica',
      'Revisando qué se puede limpiar de forma segura',
      'Haciendo la limpieza con criterio, no quiero borrar algo que se necesite',
      'Borrando lo que corresponde, dejando todo prolijo',
      'En modo limpieza, ya identifiqué lo que sobra',
      'Sacando la basura digital, dame un toque que termino',
      'Liberando espacio y matando procesos que ya no sirven',
      'Haciendo espacio en el disco, limpiando con precaución',
    ],
    gestion: [
      'Revisando los issues y el backlog, organizando prioridades',
      'Trabajando con los issues en GitHub, acomodando todo',
      'Analizando el estado del backlog, enseguida te reporto',
      'Gestionando issues y dependencias, un ratito más',
      'Ordenando el tablero, quiero darte el panorama limpio',
      'Revisando labels y asignaciones en GitHub',
      'Actualizando el estado de los issues, dame un toque',
      'Cruzando info del backlog para darte un resumen claro',
      'Organizando las prioridades del tablero, enseguida te cuento',
      'Chequeando bloqueos y dependencias entre issues',
      'Gestionando el flujo de trabajo en GitHub, un momento',
      'Repasando los tickets para ver qué está al día y qué no',
      'Actualizando el estado de cada issue, quiero que el tablero refleje la realidad',
      'Ordenando prioridades y moviendo issues donde corresponde',
      'Revisando el panorama del backlog completo, un ratito',
    ],
    config: [
      'Revisando la configuración, chequeando que todo esté en orden',
      'Tocando settings, con cuidado de no romper nada',
      'Ajustando la config, enseguida te confirmo el cambio',
      'Modificando la configuración pedida, dame un toque',
      'Revisando hooks y permisos, quiero asegurarme de que esté correcto',
      'En los archivos de config, haciendo los ajustes necesarios',
      'Actualizando la configuración del pipeline, un momento',
      'Chequeando y ajustando settings, ya casi',
      'Tocando los archivos de configuración, con precaución',
      'Revisando que la config nueva no genere conflictos',
      'Haciendo el cambio de configuración, verificando que tome efecto',
      'Ajustando parámetros, enseguida te confirmo',
    ],
    archivos: [
      'Procesando los archivos, verificando que estén completos',
      'Preparando el upload, chequeando que todo esté en orden',
      'Trabajando con los archivos, dame un toque',
      'Subiendo lo que hay que subir, verificando que llegue bien',
      'Procesando la tarea de archivos, enseguida te confirmo',
      'Moviendo archivos y verificando integridad, un ratito',
      'En el proceso de upload, chequeando que no falle nada',
      'Revisando y procesando archivos, ya casi termino',
      'Manejando los archivos necesarios, dame un momento',
      'Trabajando con el almacenamiento, quiero que quede todo en su lugar',
      'Procesando uploads pendientes, verificando uno por uno',
      'Preparando y subiendo archivos, con paciencia para que salga bien',
    ],
    general: [
      'Estoy en eso, bancame un toque que ya te cuento',
      'Laburando en tu pedido, viene avanzando bien',
      'Metiéndole pata a esto, enseguida te tengo la respuesta',
      'Trabajando en lo que me pediste, un ratito más',
      'Avanzando con esto, ya te tengo novedades en un toque',
      'Dale que va, estoy terminando de procesar todo',
      'Sigo en la misma, pero avanzando bien',
      'En un momento te paso el resultado, viene encaminado',
      'Acá ando metiéndole, enseguida te cuento',
      'Dándole forma a lo que me pediste, ya falta menos',
      'Procesando tu pedido, quiero darte algo concreto',
      'Laburando con ganas, un toque más y te paso la data',
      'Avanzando firme, ya te tengo algo en un ratito',
      'En eso estoy, tranqui que no me olvidé',
      'Metiéndole, viene saliendo bien la cosa',
      'Ya estoy bastante avanzado, un poquito más',
      'No aflojo, estoy en el tema y enseguida te cuento',
      'Trabajando concentrado en esto, ya te tengo novedades pronto',
      'Va tomando forma lo que me pediste, dame un toque más',
      'Sigo en la misma, no te preocupes que viene bien',
    ],
  };

  // Frases de progreso/avance con porcentaje y ETA (variadas para no repetir)
  const progresoConEstimacion = [
    (pct, eta) => `Voy por el ${pct}% aprox, calculo que en ${eta} te tengo el resultado`,
    (pct, eta) => `Llevo como un ${pct}% del laburo, en ${eta} más o menos termino`,
    (pct, eta) => `Estoy en un ${pct}% de avance, dame ${eta} más y te cuento`,
    (pct, eta) => `Avancé bastante, ando por el ${pct}%, calculo ${eta} más`,
    (pct, eta) => `Viene bien, estoy en un ${pct}% — unos ${eta} y lo cierro`,
    (pct, eta) => `Ya hice como el ${pct}% de lo que necesito, en ${eta} te paso resultado`,
    (pct, eta) => `Progreso: ${pct}% aprox. Calculo que en ${eta} te tengo todo`,
    (pct, eta) => `Falta menos de lo que parece, ando en ${pct}% — ${eta} más calculo`,
    (pct, eta) => `Más de la mitad lista, estoy en ${pct}% — unos ${eta} y listo`,
    (pct, eta) => `Avanzando al ${pct}%, si todo sale bien en ${eta} te cuento`,
  ];

  // Frases de progreso SIN porcentaje (para variedad, no siempre tirar número)
  const progresoGenerico = [
    'La verdad que viene bastante bien, ya le queda poco',
    'Estoy más cerca del final que del principio, tranqui',
    'Avancé un montón, en un ratito te cuento el resultado',
    'Ya pasé la parte más jodida, lo que queda es más sencillo',
    'Falta poco para cerrar, estoy en los detalles finales',
    'Viene encaminado, no debería tardar mucho más',
    'Ya hice lo más pesado, ahora estoy redondeando',
    'Estoy terminando, en breve te paso la novedad',
    'El grueso ya está, me quedan los últimos ajustes',
    'Esto ya está tomando forma, enseguida te cuento',
    'Casi listo, dame un toquecito más y te confirmo',
    'Ya estoy cerrando, no me falta nada',
  ];

  const pool = pools[categoria] || pools.general;

  // Selección pseudo-aleatoria usando múltiples semillas para mejor distribución
  const seed1 = count + (textoOriginal || '').length;
  const seed2 = count * 7 + (textoOriginal || '').charCodeAt(0) || 0;
  const seed3 = count * 13 + elapsedSec;
  const idx = (seed1 + seed2) % pool.length;
  let msg = pool[idx];

  // Para mensajes 2+, agregar info de progreso (porcentaje/ETA o genérico)
  if (count >= 2) {
    // Estimar progreso: heurística basada en tiempo y herramientas usadas
    // Tareas simples ~2min, complejas ~10min
    const estimatedTotal = tools > 15 ? 600 : tools > 8 ? 420 : tools > 3 ? 240 : 180;
    const pct = Math.min(95, Math.round((elapsedSec / estimatedTotal) * 100));
    const remainSec = Math.max(30, estimatedTotal - elapsedSec);
    const eta = remainSec >= 120 ? `${Math.round(remainSec / 60)} minutos` :
                remainSec >= 60  ? 'un minuto' : 'unos segundos';

    // Alternar entre: solo mensaje base, con porcentaje, o con progreso genérico
    const variant = (seed3 + count) % 5;
    if (variant <= 1 && pct >= 20) {
      // Con porcentaje y ETA
      const progIdx = (seed2 + count) % progresoConEstimacion.length;
      msg = progresoConEstimacion[progIdx](pct, eta);
    } else if (variant === 2) {
      // Con progreso genérico (sin número)
      const genIdx = (seed1 + count) % progresoGenerico.length;
      msg = `${msg}. ${progresoGenerico[genIdx]}`;
    }
    // variant 3-4: solo el mensaje base de categoría (sin aditivos, para variedad)
  }

  // Si hay contexto de herramienta y es categoría general, inyectar referencia sutil
  if (ctx && categoria === 'general' && count > 0 && count % 3 === 0) {
    const referencias = [
      `Ahora estoy con: ${ctx}`,
      `En este momento: ${ctx}`,
      `Metido en: ${ctx}`,
      `Trabajando sobre: ${ctx}`,
      `Ahora ando con: ${ctx}`,
    ];
    const refIdx = (seed2 + count) % referencias.length;
    const cierre = progresoGenerico[(seed1 + count) % progresoGenerico.length];
    msg = `${referencias[refIdx]} — ${cierre.charAt(0).toLowerCase() + cierre.slice(1)}`;
  }

  return msg;
}

function ejecutarClaude(prompt, textoOriginal) {
  return new Promise((resolve, reject) => {
    const readline = require('readline');
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'bypassPermissions'
    ];

    const cleanEnv = { ...process.env, CLAUDE_PROJECT_DIR: ROOT };
    delete cleanEnv.CLAUDECODE;

    const cmdSpawn = USE_NODE_DIRECT ? process.execPath : CLAUDE_BIN;
    const cmdArgs = USE_NODE_DIRECT ? [CLAUDE_CLI_JS, ...args] : args;

    const proc = spawn(cmdSpawn, cmdArgs, {
      cwd: ROOT,
      env: cleanEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: !USE_NODE_DIRECT,
      windowsHide: true
    });

    proc.stdin.write(prompt);
    proc.stdin.end();

    let lastText = '';
    let finalResult = null;
    let toolCount = 0;
    let lastToolDesc = '';
    let progressCount = 0;
    let resolved = false;
    const startTime = Date.now();

    // Límite absoluto: 10 minutos — si Claude no terminó, matar y resolver
    const HARD_TIMEOUT_MS = 10 * 60 * 1000;

    function finish(code, reason) {
      if (resolved) return;
      resolved = true;
      clearInterval(progressTimer);
      clearTimeout(hardTimer);
      rl.close();
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      log('commander', `Claude terminó (${reason}, code=${code}, tools=${toolCount}, ${elapsed}s, lastText=${(lastText||'').length}chars)`);
      if (finalResult?.result) {
        resolve(finalResult.result);
      } else if (lastText) {
        resolve(lastText);
      } else {
        log('commander', `stderr: ${stderr.slice(0, 300)}`);
        resolve(`No pude completar tu pedido (${toolCount} operaciones en ${elapsed}s). Intentá de nuevo o con algo más puntual.`);
      }
    }

    function killProc() {
      try { proc.kill('SIGTERM'); } catch {}
      // En Windows SIGTERM no siempre funciona — forzar con taskkill /T (tree kill)
      try {
        if (proc.pid) execSync(`taskkill /PID ${proc.pid} /F /T`, { timeout: 5000, windowsHide: true, stdio: 'ignore' });
      } catch {}
    }

    const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const evt = JSON.parse(line);
        if (evt.type === 'assistant' && evt.message?.content) {
          const blocks = Array.isArray(evt.message.content) ? evt.message.content : [evt.message.content];
          for (const b of blocks) {
            if (b.type === 'text' && b.text) lastText = b.text;
            if (b.type === 'tool_use') {
              toolCount++;
              lastToolDesc = b.input?.description || b.input?.command?.slice(0, 50) || b.name || '';
              log('commander', `  [tool ${toolCount}] ${b.name}: ${lastToolDesc.slice(0, 80)}`);
            }
          }
        } else if (evt.type === 'result') {
          finalResult = evt;
          // WORKAROUND para bug claude-code#25629: CLI no termina después del result event.
          // Dar 3s de gracia para que el proceso salga solo, si no: matarlo.
          log('commander', 'Result event recibido — esperando 3s para exit limpio...');
          setTimeout(() => {
            if (!resolved) {
              log('commander', 'Claude no salió tras result — matando proceso (workaround #25629)');
              killProc();
              finish(null, 'result+kill');
            }
          }, 3000);
        }
      } catch {}
    });

    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    // Mensajes de progreso contextuales cada 2 minutos
    const progressTimer = setInterval(() => {
      if (resolved) return;
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const msg = generarMensajeProgreso(progressCount, elapsed, toolCount, lastToolDesc, textoOriginal);
      progressCount++;
      sendTelegram(msg);
      log('commander', `Progreso: ${msg}`);
    }, 120000);

    // Hard timeout: si nada resolvió en 10 min, forzar finalización
    const hardTimer = setTimeout(() => {
      if (!resolved) {
        log('commander', `HARD TIMEOUT (${HARD_TIMEOUT_MS / 60000}min) — matando Claude`);
        killProc();
        finish(null, 'hard-timeout');
      }
    }, HARD_TIMEOUT_MS);

    proc.on('exit', (code) => finish(code, 'exit'));
    proc.on('close', (code) => finish(code, 'close'));
    proc.stdout.on('end', () => { if (!resolved) finish(proc.exitCode, 'stdout-end'); });

    proc.on('error', (e) => {
      if (resolved) return;
      log('commander', `Error spawning Claude: ${e.message}`);
      finish(null, 'error');
    });
  });
}

function cmdLimpiar() {
  const { totalKilled, results } = limpiarDaemonsOnDemand();
  if (totalKilled === 0 && results.length === 0) {
    return '✅ No hay daemons Gradle/Kotlin para limpiar.';
  }
  const lines = results.map(r => `  • ${r}`).join('\n');
  return `🧹 *Limpieza de daemons*\n\n${lines}\n\n*Total eliminados:* ${totalKilled}`;
}

function cmdRestart(args) {
  const paused = /pausado|--paused/i.test(args || '');
  const cmd = paused ? 'cmd.exe /c restart --paused' : 'cmd.exe /c restart';
  const mode = paused ? 'pausado' : 'completo';

  log('commander', `Restart ${mode} solicitado via Telegram`);

  // Registrar timestamp para protección anti-loop
  try {
    fs.writeFileSync(path.join(PIPELINE, 'last-restart.json'),
      JSON.stringify({ timestamp: new Date().toISOString(), mode, source: 'telegram' }));
  } catch {}

  // Ejecutar con exec async — cmd.exe nativo para que los hijos sobrevivan al Job Object de Windows
  const { exec } = require('child_process');
  exec(cmd, {
    timeout: 60000,
    cwd: ROOT,
    env: { ...process.env, PATH: 'C:\\Workspaces\\bin;' + process.env.PATH },
  }, (error, stdout, stderr) => {
    if (error) {
      log('commander', `Error en restart: ${error.message}`);
      sendTelegram(`❌ Error en reinicio ${mode}:\n\`${error.message.slice(0, 200)}\`\n\nIntentar manualmente: \`cmd.exe /c restart${paused ? ' --paused' : ''}\``);
      return;
    }
    const output = (stdout || '').trim();
    const tail = output ? output.split('\n').slice(-10).join('\n') : 'Pipeline reiniciado.';
    sendTelegram(`✅ *Restart ${mode} ejecutado*\n\n\`\`\`\n${tail}\n\`\`\``);
  });

  return `🔄 Reinicio ${mode} del pipeline en progreso...${paused ? '\n_Modo pausado: Telegram + dashboard activos, sin intake ni agentes._' : ''}`;
}

function cmdHelp() {
  return `🤖 *Comandos del Pipeline V2*

/status — Tablero completo del pipeline
/actividad [filtro] — Timeline (ej: /actividad 30m, /actividad #732)
/intake [issue] — Meter trabajo al pipeline
/proponer — Proponer historias nuevas (vía Claude)
/restart — Reiniciar pipeline completo
/restart pausado — Reiniciar en modo pausado (solo Telegram + dashboard)
/limpiar — Matar daemons Gradle/Kotlin huérfanos
/pausar — Pausar el Pulpo
/reanudar — Reanudar el Pulpo
/costos — Resumen de actividad/costos
/help — Esta ayuda
/stop — Apagar el Commander

También podés escribir texto libre y te respondo con Claude.`;
}

/** Detectar si un mensaje es un comando y extraer nombre + argumentos */
function parseCommand(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();

  // Comando explícito /xxx
  const match = trimmed.match(/^\/(\w+)\s*(.*)?$/s);
  if (match) return { cmd: match[1].toLowerCase(), args: (match[2] || '').trim() };

  // Detección de intención por lenguaje natural (solo para mensajes cortos tipo comando)
  // Si el texto es largo (>80 chars), es conversación libre — delegar a Claude
  const lower = trimmed.toLowerCase();
  const isShortMessage = trimmed.length <= 80;

  if (isShortMessage) {
    // Patrones estrictos: solo matchean intenciones claras de comando, no menciones casuales
    const intentPatterns = [
      { pattern: /\b(status|estado del pipeline|tablero|que hay en el pipeline)\b/i, cmd: 'status' },
      { pattern: /\b(pausar|paus[áa] el|fren[áa] el|par[áa] el pulpo)\b/i, cmd: 'pausar' },
      { pattern: /\b(reanudar|reanud[áa] el|arranc[áa] el pulpo)\b/i, cmd: 'reanudar' },
      { pattern: /\b(mostrame la actividad|qué pas[óo] en el pipeline|timeline)\b/i, cmd: 'actividad' },
      { pattern: /\b(mostrame los costos|cuánto gastamos|reporte de costos)\b/i, cmd: 'costos' },
      { pattern: /\b(ayuda|help|comandos disponibles)\b/i, cmd: 'help' },
      { pattern: /\b(intake|met[eé] .* issue|tra[eé] .* issue|ingres[áa] issue)\b/i, cmd: 'intake' },
      { pattern: /\b(proponer historias|propon[eé] historias|historias nuevas)\b/i, cmd: 'proponer' },
      { pattern: /\b(stop|apag[áa] el commander|cerr[áa] el commander)\b/i, cmd: 'stop' },
      { pattern: /\b(limpi[áa]|limpiar daemons|matar gradle|matar daemons|kill gradle)\b/i, cmd: 'limpiar' },
    ];

    for (const { pattern, cmd } of intentPatterns) {
      if (pattern.test(lower)) {
        const args = lower.replace(pattern, '').trim();
        log('commander', `Intención detectada: "${trimmed.slice(0, 50)}" → /${cmd}`);
        return { cmd, args };
      }
    }
  } else {
    log('commander', `Texto largo (${trimmed.length} chars) — delegando a Claude como texto libre`);
  }

  return null; // Texto libre — delegar a Claude
}

async function brazoCommander(config) {
  const commanderPendiente = path.join(PIPELINE, 'servicios', 'commander', 'pendiente');
  const commanderTrabajando = path.join(PIPELINE, 'servicios', 'commander', 'trabajando');
  const commanderListo = path.join(PIPELINE, 'servicios', 'commander', 'listo');

  let archivos = listWorkFiles(commanderPendiente);
  log('commander', `${archivos.length} mensaje(s) pendiente(s)`);
  if (archivos.length === 0) return;

  // Commander es singleton — verificar si ya hay uno corriendo
  const key = processKey('commander', 'telegram');
  if (activeProcesses.has(key) && isProcessAlive(activeProcesses.get(key).pid)) {
    log('commander', 'Ya hay un commander corriendo — skip');
    return;
  }
  activeProcesses.set(key, { pid: process.pid, startTime: Date.now() });

  try {
    await _brazoCommanderInner(config, archivos, commanderPendiente, commanderTrabajando, commanderListo, key);
  } finally {
    activeProcesses.delete(key);
  }
}

/**
 * Recoger mensajes nuevos de la cola pendiente y moverlos a trabajando.
 * @returns {Array} mensajes leídos y movidos
 */
function recogerMensajes(commanderPendiente, commanderTrabajando) {
  const archivos = listWorkFiles(commanderPendiente);
  const mensajes = [];
  for (const archivo of archivos) {
    try {
      const trabajandoPath = moveFile(archivo.path, commanderTrabajando);
      const data = JSON.parse(fs.readFileSync(trabajandoPath, 'utf8'));
      mensajes.push({ ...data, _path: trabajandoPath });
      log('commander', `Tomado: ${archivo.name} → trabajando/`);
    } catch (e) {
      log('commander', `Error moviendo ${archivo.name}: ${e.message}`);
    }
  }
  return mensajes;
}

async function _brazoCommanderInner(config, archivosIniciales, commanderPendiente, commanderTrabajando, commanderListo, key) {
  // --- VENTANA DE CONSOLIDACIÓN (5s) ---
  // Esperar brevemente para capturar mensajes que llegan juntos
  // (ej: audio 1 + audio 2 enviados con segundos de diferencia)
  const CONSOLIDATION_MS = 5000;
  log('commander', `Ventana de consolidación (${CONSOLIDATION_MS}ms)...`);
  await new Promise(r => setTimeout(r, CONSOLIDATION_MS));

  // Tomar TODOS los mensajes (iniciales + los que llegaron en la ventana)
  const mensajes = recogerMensajes(commanderPendiente, commanderTrabajando);

  // También mover los iniciales si aún están en pendiente
  for (const archivo of archivosIniciales) {
    try {
      if (fs.existsSync(archivo.path)) {
        const trabajandoPath = moveFile(archivo.path, commanderTrabajando);
        const data = JSON.parse(fs.readFileSync(trabajandoPath, 'utf8'));
        mensajes.push({ ...data, _path: trabajandoPath });
        log('commander', `Tomado (inicial): ${archivo.name} → trabajando/`);
      }
    } catch (e) {}
  }

  if (mensajes.length === 0) return;
  log('commander', `Total mensajes consolidados: ${mensajes.length}`);

  const historyFile = path.join(PIPELINE, 'commander-history.jsonl');
  const botToken = getTelegramToken();
  const chatId = getTelegramChatId();
  log('commander', `Token: ${botToken ? 'OK' : 'FALTA'}, ChatId: ${chatId || 'FALTA'}`);

  const { preprocessMessage, textToSpeech, sendVoiceTelegram } = require('./multimedia');
  const session = loadSession();

  // --- PREPROCESAR TODOS los mensajes (transcribir audios, etc.) ---
  for (const m of mensajes) {
    log('commander', `Preprocesando msg de ${m.from}: "${(m.text || '').slice(0, 50)}"`);
    const processed = await preprocessMessage(m, botToken);
    m._textoFinal = processed.text + (processed.extras.length > 0 ? ' ' + processed.extras.join(' ') : '');
    m._esAudio = !!(m.voice || m.voice_path);
    log('commander', `Preprocesado: "${m._textoFinal.slice(0, 80)}"`);

    // Registrar entrada en historial
    fs.appendFileSync(historyFile, JSON.stringify({ direction: 'in', from: m.from, text: m._textoFinal, timestamp: new Date().toISOString() }) + '\n');
  }

  // --- SEPARAR: comandos nativos vs texto libre ---
  const comandos = [];
  const textoLibre = [];

  for (const m of mensajes) {
    const parsed = parseCommand(m._textoFinal);
    if (parsed) {
      comandos.push({ m, parsed });
    } else {
      textoLibre.push(m);
    }
  }

  // --- PROCESAR COMANDOS NATIVOS (rápidos, uno a uno) ---
  for (const { m, parsed } of comandos) {
    log('commander', `Comando detectado: /${parsed.cmd} args="${parsed.args}"`);
    let respuesta = null;
    switch (parsed.cmd) {
      case 'status': respuesta = await cmdStatus(config); break;
      case 'actividad': respuesta = cmdActividad(parsed.args); break;
      case 'intake': respuesta = cmdIntake(parsed.args, config); break;
      case 'pausar': respuesta = cmdPausar(); break;
      case 'reanudar': respuesta = cmdReanudar(); break;
      case 'costos': respuesta = cmdCostos(); break;
      case 'help': case 'start': respuesta = cmdHelp(); break;
      case 'stop':
        respuesta = '🛑 Commander apagándose...';
        sendTelegram(respuesta);
        running = false;
        break;
      case 'proponer': respuesta = await cmdProponer(parsed.args, config); break;
      case 'limpiar': respuesta = cmdLimpiar(); break;
      case 'restart': respuesta = cmdRestart(parsed.args); break;
      default: respuesta = null; break;
    }

    if (respuesta !== null) {
      session.lastCommand = parsed.cmd;
      session.lastTimestamp = new Date().toISOString();
      session.context = `Último comando: /${parsed.cmd}. Respuesta: ${(respuesta || '').slice(0, 200)}`;
      sendTelegram(respuesta);
      fs.appendFileSync(historyFile, JSON.stringify({ direction: 'out', text: respuesta.slice(0, 1000), timestamp: new Date().toISOString() }) + '\n');
    } else {
      // Comando no reconocido → mover a texto libre
      textoLibre.push(m);
    }

    try { moveFile(m._path, commanderListo); } catch {}
    const logFile = path.join(LOG_DIR, 'commander.log');
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] /${parsed.cmd}\n${respuesta || '(sin respuesta)'}\n---\n`);
  }

  // --- PROCESAR TEXTO LIBRE CONSOLIDADO (una sola llamada a Claude) ---
  if (textoLibre.length > 0) {
    const esAudio = textoLibre.some(m => m._esAudio);

    // Consolidar mensajes en un solo texto para Claude
    let mensajeConsolidado;
    if (textoLibre.length === 1) {
      mensajeConsolidado = textoLibre[0]._textoFinal;
    } else {
      // Múltiples mensajes → contexto unificado
      mensajeConsolidado = textoLibre.map((m, i) =>
        `[Mensaje ${i + 1}${m._esAudio ? ' (audio)' : ''}]: ${m._textoFinal}`
      ).join('\n\n');
      log('commander', `Mensajes consolidados: ${textoLibre.length} → 1 prompt`);
    }

    // Protección anti-restart encadenado: si el mensaje pide restart y ya hubo
    // uno reciente (< 2 min), responder directamente sin delegar a Claude
    const restartPattern = /\b(reinici|restart|levant[aá]|arranc[aá])\b/i;
    if (restartPattern.test(mensajeConsolidado)) {
      try {
        const lastRestart = JSON.parse(fs.readFileSync(path.join(PIPELINE, 'last-restart.json'), 'utf8'));
        const ageSec = (Date.now() - new Date(lastRestart.timestamp).getTime()) / 1000;
        if (ageSec < 120) {
          log('commander', `Restart solicitado pero ya hubo uno hace ${Math.round(ageSec)}s — skip`);
          sendTelegram(`✅ Ya reinicié hace ${Math.round(ageSec)}s, todo debería estar andando. Usá /status para verificar.`);
          for (const m of textoLibre) { try { moveFile(m._path, commanderListo); } catch {} }
          return;
        }
      } catch {}
    }

    // ACK contextual
    sendTelegram(generarAck(mensajeConsolidado, esAudio));

    try {
      // Construir prompt
      let historial = '';
      try {
        const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const lines = fs.readFileSync(historyFile, 'utf8').trim().split('\n')
          .filter(l => { try { return JSON.parse(l).timestamp >= cutoff24h; } catch { return false; } })
          .slice(-50);
        historial = '\nHistorial reciente (24hs):\n' + lines.join('\n');
      } catch {}

      let sessionCtx = '';
      if (session.context && session.lastTimestamp) {
        const ageMin = (Date.now() - new Date(session.lastTimestamp).getTime()) / 60000;
        if (ageMin < 30) {
          sessionCtx = `\n\nContexto de sesión: ${session.context}`;
        }
      }

      const from = textoLibre[0].from || 'Leo';
      const userPrompt = `Sos el Commander del pipeline V2 de Intrale. Respondés por Telegram.

REGLAS:
1. Si el usuario pide una ACCIÓN (revisar, arreglar, validar, verificar, levantar, etc): EJECUTALA primero con las herramientas que tengas, y después reportá qué hiciste y el resultado.
2. Si el usuario hace una PREGUNTA: respondé directamente.
3. Tu respuesta final (el texto que se envía a Telegram) debe ser SOLO el reporte al usuario. Conciso, en español argentino.
4. NO menciones paths internos del pipeline (pendiente/, listo/, etc).
5. Contexto del entorno:
   - Pipeline dir: ${PIPELINE}
   - Dashboard: node .pipeline/dashboard-v2.js (puerto 3200)
   - PIDs: .pipeline/*.pid
   - Logs: .pipeline/logs/
   - Procesos: tasklist | grep node

Mensaje de ${from}: ${mensajeConsolidado}${sessionCtx}${historial}`;

      let respuesta = await ejecutarClaude(userPrompt, mensajeConsolidado);
      log('commander', `Claude respondió: ${(respuesta || '').length} chars`);

      // --- CHECK DE SUPLEMENTOS ---
      // Mensajes que llegaron MIENTRAS Claude procesaba (ej: segundo audio complementario)
      const suplementosRaw = recogerMensajes(commanderPendiente, commanderTrabajando);
      if (suplementosRaw.length > 0) {
        log('commander', `${suplementosRaw.length} suplemento(s) llegaron durante procesamiento — integrando`);

        // Preprocesar suplementos
        const suplementosTexto = [];
        for (const s of suplementosRaw) {
          const proc = await preprocessMessage(s, botToken);
          const txt = proc.text + (proc.extras.length > 0 ? ' ' + proc.extras.join(' ') : '');
          suplementosTexto.push(txt);
          s._textoFinal = txt;
          s._esAudio = !!(s.voice || s.voice_path);
          fs.appendFileSync(historyFile, JSON.stringify({ direction: 'in', from: s.from, text: txt, timestamp: new Date().toISOString() }) + '\n');
        }

        sendTelegram('💬 Vi tu mensaje adicional, lo integro a la respuesta...');

        // Re-llamar a Claude con contexto completo + suplementos
        const supplementPrompt = `${userPrompt}

RESPUESTA ANTERIOR (borrador, NO enviada al usuario todavía):
${respuesta}

Mientras generabas esa respuesta, el usuario envió mensaje(s) complementario(s):
${suplementosTexto.map((t, i) => `[Complemento ${i + 1}]: ${t}`).join('\n')}

INSTRUCCIÓN: Integrá los complementos del usuario en tu respuesta. Generá UNA respuesta final unificada que contemple tanto el pedido original como los complementos. No menciones que hubo múltiples mensajes ni que reprocessaste.`;

        respuesta = await ejecutarClaude(supplementPrompt, 'complemento integrado');
        log('commander', `Claude (suplemento) respondió: ${(respuesta || '').length} chars`);

        // Mover suplementos a listo
        for (const s of suplementosRaw) {
          try { moveFile(s._path, commanderListo); } catch {}
        }
      }

      // Actualizar sesión
      session.lastCommand = 'chat';
      session.lastTimestamp = new Date().toISOString();
      session.context = `Conversación libre. Último mensaje: "${mensajeConsolidado.slice(0, 100)}". Respuesta: "${(respuesta || '').slice(0, 100)}"`;

      // --- ENVIAR RESPUESTA ---
      if (respuesta) {
        let enviado = false;

        // Si hubo audio → intentar TTS
        if (esAudio) {
          try {
            const chatChunks = splitTextForTTSChunks(respuesta, 3800);
            for (let i = 0; i < chatChunks.length; i++) {
              const chunkText = chatChunks.length > 1
                ? `Parte ${i + 1} de ${chatChunks.length}. ${chatChunks[i]}`
                : chatChunks[i];
              const audioBuffer = await textToSpeech(chunkText);
              if (audioBuffer) {
                const audioPath = path.join(LOG_DIR, 'media', `tts-${Date.now()}-${i}.ogg`);
                fs.writeFileSync(audioPath, audioBuffer);
                enviado = await sendVoiceTelegram(audioBuffer, botToken, chatId);
                if (enviado) log('telegram', `Audio TTS parte ${i + 1}/${chatChunks.length} enviado (${audioBuffer.length} bytes)`);
              }
            }
          } catch (e) {
            log('commander', `TTS error: ${e.message}`);
          }
        }

        sendTelegram(respuesta);
        log('telegram', `Texto encolado como ${enviado ? 'backup' : 'principal'} (${respuesta.length} chars)`);
        fs.appendFileSync(historyFile, JSON.stringify({ direction: 'out', text: respuesta.slice(0, 1000), timestamp: new Date().toISOString() }) + '\n');
      }
    } catch (e) {
      log('commander', `Error Claude: ${e.message}`);
      sendTelegram('⚠️ Error procesando tu mensaje. Intentá de nuevo.');
    }

    // Mover todos los mensajes texto-libre a listo
    for (const m of textoLibre) {
      try { moveFile(m._path, commanderListo); } catch {}
    }

    const logFile = path.join(LOG_DIR, 'commander.log');
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] TEXT (${textoLibre.length} msgs consolidados)\n---\n`);
  }

  // Persistir sesión
  saveSession(session);
}

function sendTelegram(text) {
  const token = getTelegramToken();
  const chatId = getTelegramChatId();
  if (!token || !chatId) { log('telegram', 'Sin token/chatId'); return; }

  const msg = text.length > 4000 ? text.slice(0, 4000) + '...' : text;

  // Encolar en el servicio de telegram (fire-and-forget via filesystem)
  const svcDir = path.join(PIPELINE, 'servicios', 'telegram', 'pendiente');
  const filename = `${Date.now()}-cmd.json`;
  try {
    fs.writeFileSync(path.join(svcDir, filename), JSON.stringify({ text: msg, parse_mode: 'Markdown' }));
    log('telegram', `Encolado (${msg.length} chars) → ${filename}`);
  } catch (e) {
    // Fallback: envío directo con https (sin subproceso)
    const https = require('https');
    const data = JSON.stringify({ chat_id: chatId, text: msg });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    });
    req.on('error', (err) => log('telegram', `Error directo: ${err.message}`));
    req.write(data);
    req.end();
    log('telegram', `Enviado directo (${msg.length} chars)`);
  }
}

function getTelegramToken() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, '.claude', 'hooks', 'telegram-config.json'), 'utf8')).bot_token;
  } catch { return ''; }
}

function getTelegramChatId() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, '.claude', 'hooks', 'telegram-config.json'), 'utf8')).chat_id;
  } catch { return ''; }
}

// =============================================================================
// BRAZO 4: INTAKE — Lee issues de GitHub y los mete al pipeline
// =============================================================================

let lastIntakeTime = 0;

// Cache de issues qa:dependency abiertos para dedup por contenido
let depIssuesCache = { issues: [], fetchedAt: 0 };

/**
 * Dedup por contenido para issues qa:dependency.
 * Compara el título del issue contra los ya existentes con el mismo label.
 * Si encuentra un duplicado (similitud alta), cierra el nuevo y retorna true.
 */
function dedupDependencyIssue(issue, allIssuesInBatch) {
  const issueLabels = (issue.labels || []).map(l => l.name);
  if (!issueLabels.includes('qa:dependency')) return false;

  // Refrescar cache de issues qa:dependency si tiene más de 10 minutos
  if (Date.now() - depIssuesCache.fetchedAt > 600000) {
    try {
      ghThrottle();
      const raw = execSync(
        `"${GH_BIN}" issue list --label "qa:dependency" --state open --json number,title --limit 100`,
        { cwd: ROOT, encoding: 'utf8', timeout: 30000, windowsHide: true }
      );
      depIssuesCache = { issues: JSON.parse(raw || '[]'), fetchedAt: Date.now() };
    } catch (e) {
      log('intake', `Error cargando cache qa:dependency: ${e.message}`);
      return false;  // si falla, no bloquear el intake
    }
  }

  const titleNorm = normalizeTitleForDedup(issue.title);
  const titleWords = extractSignificantWords(issue.title);

  // Buscar duplicado entre issues existentes (no el mismo issue)
  for (const existing of depIssuesCache.issues) {
    if (existing.number === issue.number) continue;

    // No comparar contra issues del mismo batch (se procesan juntos)
    if (allIssuesInBatch.some(i => i.number === existing.number)) continue;

    const existNorm = normalizeTitleForDedup(existing.title);
    const existWords = extractSignificantWords(existing.title);

    // Similitud: substring match O overlap de palabras significativas >= 60%
    if (existNorm.includes(titleNorm) || titleNorm.includes(existNorm)) {
      closeDuplicateIssue(issue.number, existing.number, issue.title);
      return true;
    }

    const shared = titleWords.filter(w => existWords.some(ew => ew.includes(w) || w.includes(ew)));
    const overlapRatio = shared.length / Math.max(Math.min(titleWords.length, existWords.length), 1);
    if (shared.length >= 2 && overlapRatio >= 0.6) {
      closeDuplicateIssue(issue.number, existing.number, issue.title);
      return true;
    }
  }

  // Agregar a cache para dedup dentro del mismo batch de intake
  depIssuesCache.issues.push({ number: issue.number, title: issue.title });
  return false;
}

function normalizeTitleForDedup(title) {
  return (title || '').toLowerCase()
    .replace(/^(?:fix|feat|infra|bug|dep):\s*/i, '')  // quitar prefijos
    .replace(/\b(el|la|los|las|un|una|de|del|en|que|con|por|al|se|no|es|a)\b/g, '')
    .replace(/[—\-:()#\d]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function extractSignificantWords(title) {
  return normalizeTitleForDedup(title).split(' ').filter(w => w.length > 3);
}

function closeDuplicateIssue(dupNum, existingNum, dupTitle) {
  try {
    const body = `Duplicado de #${existingNum}. Cerrado automáticamente por el pipeline de definición (dedup por contenido).`;
    ghThrottle();
    execSync(
      `"${GH_BIN}" issue close ${dupNum} --comment "${body.replace(/"/g, '\\"')}" --reason "not planned"`,
      { cwd: ROOT, encoding: 'utf8', timeout: 15000, windowsHide: true }
    );
    log('intake', `#${dupNum} cerrado como duplicado de #${existingNum} — "${dupTitle}"`);
  } catch (e) {
    log('intake', `Error cerrando duplicado #${dupNum}: ${e.message}`);
  }
}

function brazoIntake(config) {
  const intakeInterval = (config.timeouts?.intake_interval_seconds || 300) * 1000;
  if (Date.now() - lastIntakeTime < intakeInterval) return;
  lastIntakeTime = Date.now();

  const intakeConfig = config.intake || {};

  for (const [pipelineName, pipeIntake] of Object.entries(intakeConfig)) {
    const label = pipeIntake.label;
    const faseEntrada = pipeIntake.fase_entrada;
    const pipelineConfig = config.pipelines[pipelineName];
    if (!pipelineConfig || !label || !faseEntrada) continue;

    try {
      // Consultar GitHub por issues con el label
      ghThrottle();
      const result = execSync(
        `"${GH_BIN}" issue list --label "${label}" --state open --json number,title,labels --limit 50`,
        { cwd: ROOT, encoding: 'utf8', timeout: 30000, windowsHide: true }
      );
      const issues = JSON.parse(result || '[]');

      if (issues.length === 0) continue;

      // Cachear labels+estado de los issues recién traídos de GitHub
      for (const issue of issues) {
        const labelNames = (issue.labels || []).map(l => l.name);
        issueLabelsCache.set(String(issue.number), { labels: labelNames, state: 'OPEN', fetchedAt: Date.now() });
      }

      // Ordenar por prioridad combinada (priority label + feature priority)
      issues.sort((a, b) => {
        return calcularPrioridad(String(a.number), config) - calcularPrioridad(String(b.number), config);
      });

      for (const issue of issues) {
        const issueNum = String(issue.number);

        // BLOCKED: no procesar issues con label blocked:dependencies
        const issueLabels = (issue.labels || []).map(l => l.name);
        if (issueLabels.includes('blocked:dependencies')) {
          log('intake', `#${issueNum} omitido — tiene label blocked:dependencies`);
          continue;
        }

        // Dedup por contenido para issues qa:dependency (cierra duplicados automáticamente)
        if (dedupDependencyIssue(issue, issues)) continue;

        // Deduplicación: verificar que el issue no esté ya activo en este pipeline
        if (issueExistsInPipeline(issueNum, pipelineName)) continue;

        // Crear archivos en pendiente/ de la fase de entrada
        const skills = pipelineConfig.skills_por_fase[faseEntrada] || [];
        const pendienteDir = path.join(fasePath(pipelineName, faseEntrada), 'pendiente');

        if (faseEntrada === 'dev') {
          // Fase dev: un solo skill según labels
          const devSkill = determinarDevSkill(issueNum, config);
          const filePath = path.join(pendienteDir, `${issueNum}.${devSkill}`);
          if (!fs.existsSync(filePath)) {
            writeYaml(filePath, { issue: parseInt(issueNum), fase: faseEntrada, pipeline: pipelineName });
            log('intake', `#${issueNum} "${issue.title}" → ${pipelineName}/${faseEntrada} (${devSkill})`);
          }
        } else {
          // Fase paralela: un archivo por skill
          let created = false;
          for (const skill of skills) {
            const filePath = path.join(pendienteDir, `${issueNum}.${skill}`);
            if (!fs.existsSync(filePath)) {
              writeYaml(filePath, { issue: parseInt(issueNum), fase: faseEntrada, pipeline: pipelineName });
              created = true;
            }
          }
          if (created) {
            log('intake', `#${issueNum} "${issue.title}" → ${pipelineName}/${faseEntrada} (${skills.join(', ')})`);
          }
        }
      }
    } catch (e) {
      log('intake', `Error consultando GitHub para ${pipelineName}: ${e.message}`);
    }
  }
}

// =============================================================================
// MAIN LOOP
// =============================================================================

let running = true;
let paused = false;

// Archivo de control para pausar/reanudar desde fuera
const PAUSE_FILE = path.join(PIPELINE, '.paused');

function checkPauseFile() {
  paused = fs.existsSync(PAUSE_FILE);
}

// Rotación del historial del commander (descartar > 24hs)
let lastHistoryRotation = 0;
function rotateHistory() {
  if (Date.now() - lastHistoryRotation < 3600000) return; // Rotar máx cada hora
  lastHistoryRotation = Date.now();

  const historyFile = path.join(PIPELINE, 'commander-history.jsonl');
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const lines = fs.readFileSync(historyFile, 'utf8').trim().split('\n');
    const kept = lines.filter(l => {
      try { return JSON.parse(l).timestamp >= cutoff; } catch { return false; }
    });
    if (kept.length < lines.length) {
      fs.writeFileSync(historyFile, kept.join('\n') + '\n');
      log('pulpo', `Historial rotado: ${lines.length} → ${kept.length} entries`);
    }
  } catch {}
}

// --- MÉTRICAS HISTÓRICAS ---
// Persiste snapshot cada ciclo (30s) a metrics-history.jsonl.
// El dashboard lee este archivo para /metrics.
const METRICS_FILE = path.join(PIPELINE, 'metrics-history.jsonl');
const METRICS_MAX_ENTRIES = 2880; // ~24h a 30s/ciclo
let metricsLastRotation = 0;

function persistMetricsSnapshot(config) {
  try {
    const pressure = getResourcePressure(config);
    const totalRunning = countTotalRunningAgents(config);

    // Contar por fase
    const byFase = {};
    for (const [pName, pConfig] of Object.entries(config.pipelines)) {
      for (const fase of pConfig.fases) {
        const tDir = path.join(PIPELINE, pName, fase, 'trabajando');
        const pDir = path.join(PIPELINE, pName, fase, 'pendiente');
        byFase[fase] = {
          working: (byFase[fase]?.working || 0) + listWorkFiles(tDir).length,
          pending: (byFase[fase]?.pending || 0) + listWorkFiles(pDir).length
        };
      }
    }

    // Contar por skill (para perfiles de consumo)
    const bySkill = {};
    for (const [key] of activeProcesses) {
      const sk = key.split(':')[0];
      bySkill[sk] = (bySkill[sk] || 0) + 1;
    }

    const snapshot = {
      ts: Date.now(),
      cpu: pressure.cpuPercent,
      mem: pressure.memPercent,
      level: pressure.level,
      agents: totalRunning,
      byFase,
      bySkill,
      qaPriority: qaPriorityActive,
      buildPriority: buildPriorityActive
    };

    fs.appendFileSync(METRICS_FILE, JSON.stringify(snapshot) + '\n');

    // Rotar cada 10min para no crecer indefinidamente
    const now = Date.now();
    if (now - metricsLastRotation > 600000) {
      metricsLastRotation = now;
      try {
        const lines = fs.readFileSync(METRICS_FILE, 'utf8').split('\n').filter(Boolean);
        if (lines.length > METRICS_MAX_ENTRIES) {
          fs.writeFileSync(METRICS_FILE, lines.slice(-METRICS_MAX_ENTRIES).join('\n') + '\n');
        }
      } catch {}
    }
  } catch {}
}

// =============================================================================
// BRAZO DESBLOQUEO — Revisa issues con blocked:dependencies y desbloquea
// cuando todas sus dependencias están cerradas.
// Frecuencia: cada 30 minutos. Basado en datos reales del pipeline:
//   - P10 de duración de issues: 1.2h, P25: 2.7h, mediana: 141h
//   - 30 min es generoso (cubre issues rápidos) sin ser innecesariamente frecuente
// =============================================================================
let lastUnblockTime = 0;
const UNBLOCK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutos

function brazoDesbloqueo(config) {
  if (Date.now() - lastUnblockTime < UNBLOCK_INTERVAL_MS) return;
  lastUnblockTime = Date.now();

  try {
    // 1. Buscar issues abiertos con label blocked:dependencies
    ghThrottle();
    const result = execSync(
      `"${GH_BIN}" issue list --label "blocked:dependencies" --state open --json number,title --limit 50`,
      { cwd: ROOT, encoding: 'utf8', timeout: 30000, windowsHide: true }
    );
    const blockedIssues = JSON.parse(result || '[]');
    if (blockedIssues.length === 0) {
      // Limpiar datos stale — si ya no hay bloqueados, el dashboard debe saberlo
      try { fs.writeFileSync(path.join(PIPELINE, 'blocked-issues.json'), JSON.stringify({ blockedBy: {}, blocks: {} }, null, 2)); } catch {}
      return;
    }

    log('desbloqueo', `Revisando ${blockedIssues.length} issues bloqueados por dependencias`);

    // Mapeos bidireccionales para el dashboard
    const blockedBy = {};  // issue → [dependencias]
    const blocks = {};     // dependencia → [issues que bloquea]

    for (const issue of blockedIssues) {
      try {
        // 2. Leer comentarios del issue para encontrar dependencias creadas por el pipeline
        ghThrottle();
        const comments = execSync(
          `"${GH_BIN}" issue view ${issue.number} --json comments --jq ".comments[].body" --repo intrale/platform`,
          { cwd: ROOT, encoding: 'utf8', timeout: 15000, windowsHide: true }
        );

        // Buscar el comentario de dependencias del pipeline
        const depCommentMatch = comments.match(/Dependencias detectadas por el pipeline[\s\S]*?(?=\n\n|\Z)/);
        let depIssueNumbers = [];
        if (depCommentMatch) {
          depIssueNumbers = [...depCommentMatch[0].matchAll(/#(\d+)/g)]
            .map(m => m[1])
            .filter(n => n !== String(issue.number));
        }

        // Fallback: si no hay deps en el comentario del pipeline, buscar en body + todos los comentarios
        if (depIssueNumbers.length === 0) {
          try {
            ghThrottle();
            const fullData = execSync(
              `"${GH_BIN}" issue view ${issue.number} --json body,comments --jq "[.body, .comments[].body] | join(\\"\\\\n\\")" --repo intrale/platform`,
              { cwd: ROOT, encoding: 'utf8', timeout: 15000, windowsHide: true }
            );
            const allRefs = [...fullData.matchAll(/#(\d+)/g)]
              .map(m => m[1])
              .filter(n => n !== String(issue.number));
            depIssueNumbers = [...new Set(allRefs)]; // dedup
          } catch {}
        }

        if (depIssueNumbers.length === 0) {
          log('desbloqueo', `#${issue.number}: label blocked:dependencies sin dependencias detectables — registrado sin deps`);
          blockedBy[issue.number] = [];
          continue;
        }

        // Registrar mapeos bidireccionales
        blockedBy[issue.number] = depIssueNumbers;
        for (const dep of depIssueNumbers) {
          if (!blocks[dep]) blocks[dep] = [];
          if (!blocks[dep].includes(String(issue.number))) blocks[dep].push(String(issue.number));
        }

        // 3. Verificar si todas las dependencias están cerradas
        let allClosed = true;
        const openDeps = [];
        for (const depNum of depIssueNumbers) {
          ghThrottle();
          try {
            const depState = execSync(
              `"${GH_BIN}" issue view ${depNum} --json state --jq ".state" --repo intrale/platform`,
              { cwd: ROOT, encoding: 'utf8', timeout: 10000, windowsHide: true }
            ).trim();
            if (depState !== 'CLOSED') {
              allClosed = false;
              openDeps.push(depNum);
            }
          } catch (e) {
            // Si no se puede leer el estado, asumir que está abierto
            allClosed = false;
            openDeps.push(depNum);
          }
        }

        if (allClosed) {
          // 4. Todas cerradas → desbloquear
          log('desbloqueo', `#${issue.number}: todas las dependencias cerradas (${depIssueNumbers.join(', ')}) → desbloqueando`);

          // Quitar de los mapeos (ya no está bloqueado)
          delete blockedBy[issue.number];
          for (const dep of depIssueNumbers) {
            if (blocks[dep]) blocks[dep] = blocks[dep].filter(n => n !== String(issue.number));
            if (blocks[dep] && blocks[dep].length === 0) delete blocks[dep];
          }

          // Quitar label blocked:dependencies
          ghThrottle();
          execSync(
            `"${GH_BIN}" issue edit ${issue.number} --remove-label "blocked:dependencies" --repo intrale/platform`,
            { cwd: ROOT, timeout: 10000, windowsHide: true }
          );

          // Agregar comentario de desbloqueo
          const unblockComment = `## ✅ Issue desbloqueado automáticamente\n\nTodas las dependencias fueron resueltas (${depIssueNumbers.map(n => '#' + n).join(', ')}). Este issue vuelve a la cola del pipeline para ser procesado.`;
          ghThrottle();
          execSync(
            `"${GH_BIN}" issue comment ${issue.number} --body "${unblockComment.replace(/"/g, '\\"')}" --repo intrale/platform`,
            { cwd: ROOT, timeout: 10000, windowsHide: true }
          );

          sendTelegram(`🔓 Issue #${issue.number} desbloqueado — todas las dependencias resueltas (${depIssueNumbers.map(n => '#' + n).join(', ')}). Vuelve a la cola del pipeline.`);
          log('desbloqueo', `#${issue.number} desbloqueado exitosamente`);
        } else {
          log('desbloqueo', `#${issue.number}: dependencias abiertas: ${openDeps.map(n => '#' + n).join(', ')} — sigue bloqueado`);
        }
      } catch (e) {
        log('desbloqueo', `Error procesando #${issue.number}: ${e.message}`);
      }
    }

    // Persistir mapeos para el dashboard
    try {
      fs.writeFileSync(path.join(PIPELINE, 'blocked-issues.json'), JSON.stringify({ blockedBy, blocks }, null, 2));
    } catch (e) {
      log('desbloqueo', `Error persistiendo blocked-issues.json: ${e.message}`);
    }
  } catch (e) {
    log('desbloqueo', `Error en brazo de desbloqueo: ${e.message}`);
  }
}

async function mainLoop() {
  log('pulpo', `Pulpo V2 iniciado — poll cada ${loadConfig().timeouts?.poll_interval_seconds || 30}s`);
  log('pulpo', `Pipeline: ${PIPELINE}`);

  // Migración one-shot del schema de skill-profiles (v1 → v2 delta)
  migrateSkillProfilesIfNeeded();

  while (running) {
    try {
      checkPauseFile();

      const config = loadConfig(); // Reload cada ciclo para hot-reload

      // Commander corre ASYNC — no bloquea el loop principal
      // El singleton check dentro de brazoCommander evita ejecuciones concurrentes
      brazoCommander(config).catch(e => log('commander', `Error async: ${e.message}`));

      // Drain outbox de Telegram (context-relay, notificaciones, etc.)
      try {
        const outbox = require(path.join(ROOT, '.claude', 'hooks', 'telegram-outbox'));
        await outbox.drainQueue();
      } catch (e) {}

      // Context bridge tick (sync preguntas pendientes, relay, cleanup)
      try {
        const bridge = require(path.join(ROOT, '.claude', 'hooks', 'context-bridge'));
        bridge.tick();
      } catch (e) {}

      if (!paused) {
        rotateHistory();          // Housekeeping: rotar historial > 24hs
        persistMetricsSnapshot(config); // Métricas históricas para /metrics
        brazoIntake(config);      // Segundo: traer trabajo nuevo de GitHub
        brazoDesbloqueo(config);  // Tercero: desbloquear issues cuyas dependencias se resolvieron
        brazoBarrido(config);     // Cuarto: promover entre fases
        brazoLanzamiento(config); // Quinto: asignar trabajo a agentes
        brazoHuerfanos(config);   // Sexto: recuperar trabajo trabado
      } else {
        log('pulpo', 'PAUSADO — esperando reanudación (borrar .pipeline/.paused)');
      }
    } catch (e) {
      log('pulpo', `ERROR en ciclo: ${e.message}`);
    }

    // Sleep
    const sleepMs = (loadConfig().timeouts?.poll_interval_seconds || 30) * 1000;
    await new Promise(r => setTimeout(r, sleepMs));
  }
}

// Graceful shutdown
process.on('SIGINT', () => { log('pulpo', 'SIGINT recibido — cerrando'); running = false; });
process.on('SIGTERM', () => { log('pulpo', 'SIGTERM recibido — cerrando'); running = false; });

// --- MODO TEST: permitir require() del archivo sin arrancar el pulpo ---
// Uso: PULPO_NO_AUTOSTART=1 node -e "require('./pulpo.js').predictResourceImpact(...)"
// Útil para tests unitarios y scripts de evidencia del gate predictivo.
if (process.env.PULPO_NO_AUTOSTART === '1') {
  module.exports = {
    predictResourceImpact,
    getEstimatedImpact,
    measureEmulatorMemPercent,
    recordSkillResourceUsage,
    loadSkillProfiles,
    saveSkillProfiles,
    migrateSkillProfilesIfNeeded,
    SKILL_PROFILES_SCHEMA_VERSION,
    QA_INFRA_SKILLS,
    MAX_EST_MEM,
    MAX_EST_CPU
  };
  return; // No arrancar singleton ni mainLoop
}

// --- SINGLETON ---
require('./singleton')('pulpo');

mainLoop().then(() => {
  log('pulpo', 'Pulpo finalizado');
  process.exit(0);
});

#!/usr/bin/env node
// =============================================================================
// Pulpo V2 — Proceso central del pipeline
// Brazos: barrido, lanzamiento, huérfanos (+ intake en F5)
// =============================================================================

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn } = require('child_process');
const yaml = require('js-yaml');

// PIPELINE_STATE_DIR y PIPELINE_MAIN_ROOT: seteados por restart.js cuando corre desde platform.ops
const ROOT = process.env.PIPELINE_MAIN_ROOT || path.resolve(__dirname, '..');
const PIPELINE = process.env.PIPELINE_STATE_DIR || path.resolve(ROOT, '.pipeline');
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

// --- Utilidades ---

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

// --- Limpieza de Gradle daemons post-agente ---

/**
 * Matar Gradle daemons asociados a un directorio de trabajo (worktree o ROOT).
 * Los daemons Gradle persisten después de que el build/agente termina y consumen
 * hasta 4GB de heap cada uno, saturando el sistema.
 */
function killGradleDaemonsForCwd(cwd, label) {
  if (!cwd) return 0;
  let totalKilled = 0;

  // 1. Intentar ./gradlew --stop en el directorio del agente
  try {
    const gradlewPath = path.join(cwd, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
    if (fs.existsSync(gradlewPath)) {
      const result = execSync(`"${gradlewPath}" --stop`, {
        cwd, encoding: 'utf8', timeout: 15000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
      });
      const match = result.match(/(\d+) Daemon/);
      const count = match ? parseInt(match[1]) : 0;
      if (count > 0) {
        log('gradle-cleanup', `${label}: ${count} daemon(s) detenidos via --stop`);
        totalKilled += count;
      }
    }
  } catch {}

  // 2. Matar wrappers lanzados desde este CWD (estos SÍ tienen el path en su CommandLine)
  try {
    const wmicOut = execSync(
      'wmic process where "name=\'java.exe\'" get ProcessId,CommandLine /FORMAT:CSV',
      { encoding: 'utf8', timeout: 10000, windowsHide: true }
    );
    const cwdNormalized = cwd.replace(/\\/g, '/').toLowerCase();
    for (const line of wmicOut.split('\n')) {
      // Matchear wrappers de este CWD (gradle-wrapper.jar incluye el path del worktree)
      if (line.includes('gradle-wrapper.jar') && line.toLowerCase().includes(cwdNormalized)) {
        const pidMatch = line.match(/,(\d+)\s*$/);
        if (pidMatch) {
          // Matar el wrapper Y su árbol de procesos hijos (incluye el GradleDaemon forkeado)
          try {
            execSync(`taskkill /PID ${pidMatch[1]} /F /T`, { timeout: 5000, windowsHide: true, stdio: 'ignore' });
            totalKilled++;
          } catch {}
        }
      }
    }
  } catch {}

  // 3. Matar GradleDaemons ociosos (sin wrapper padre activo = huérfanos)
  //    Los daemons NO tienen el CWD en su CommandLine, así que los identificamos
  //    como "huérfanos" si su proceso padre ya no existe.
  try {
    const wmicOut = execSync(
      'wmic process where "name=\'java.exe\'" get ProcessId,ParentProcessId,CommandLine /FORMAT:CSV',
      { encoding: 'utf8', timeout: 10000, windowsHide: true }
    );
    // Preservar el proceso de QA backend
    let qaBackendPid = null;
    try {
      const qaState = JSON.parse(fs.readFileSync(path.join(PIPELINE, 'qa-env-state.json'), 'utf8'));
      qaBackendPid = qaState.backend ? String(qaState.backend) : null;
    } catch {}

    for (const line of wmicOut.split('\n')) {
      if (!line.includes('GradleDaemon')) continue;
      // Formato CSV: Node,CommandLine,ProcessId,ParentProcessId
      const parts = line.split(',');
      const pid = parts[parts.length - 2]?.trim();
      const ppid = parts[parts.length - 1]?.trim();
      if (!pid || pid === qaBackendPid) continue;

      // Si el padre del daemon ya murió, el daemon es huérfano → matarlo
      if (ppid && !isProcessAlive(parseInt(ppid, 10))) {
        try {
          execSync(`taskkill /PID ${pid} /F /T`, { timeout: 5000, windowsHide: true, stdio: 'ignore' });
          totalKilled++;
          log('gradle-cleanup', `${label}: daemon huérfano PID ${pid} (padre ${ppid} muerto) eliminado`);
        } catch {}
      }
    }
  } catch {}

  if (totalKilled > 0) {
    log('gradle-cleanup', `${label}: ${totalKilled} proceso(s) Gradle limpiados en total`);
  }
  return totalKilled;
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

/** Verificar si el sistema está sobrecargado según los thresholds configurados */
let lastResourceLog = 0;
function isSystemOverloaded(config) {
  const thresholds = config.resource_limits || {};
  const maxCpu = thresholds.max_cpu_percent || 80;
  const maxMem = thresholds.max_mem_percent || 80;

  const { cpuPercent, memPercent } = getSystemResourceUsage();

  let overloaded = cpuPercent >= maxCpu || memPercent >= maxMem;

  // Si está sobrecargado, intentar liberar recursos automáticamente (Gradle daemons, zombies)
  if (overloaded) {
    const { freed, killed } = tryFreeResources();
    if (freed) {
      log('recursos', `Auto-limpieza por sobrecarga: ${killed.join(', ')}`);
      // Re-chequear después de la limpieza
      const after = getSystemResourceUsage();
      overloaded = after.cpuPercent >= maxCpu || after.memPercent >= maxMem;
    }
  }

  // Loguear cada 60s para no spamear
  const now = Date.now();
  if (overloaded || now - lastResourceLog > 60000) {
    const status = overloaded ? '🔴 SOBRECARGADO' : '🟢 OK';
    log('recursos', `${status} — CPU: ${cpuPercent}% (max ${maxCpu}%) | RAM: ${memPercent}% (max ${maxMem}%)`);
    lastResourceLog = now;
  }

  return overloaded;
}

/**
 * Intentar liberar recursos del sistema matando procesos zombies/huérfanos.
 * Retorna { freed: boolean, killed: string[] } con detalle de lo limpiado.
 */
function tryFreeResources() {
  const killed = [];

  try {
    // 1. Matar Gradle daemons huérfanos (consumen mucha RAM)
    const tasklistOut = execSync('tasklist /FI "IMAGENAME eq java.exe" /FO CSV /NH', {
      encoding: 'utf8', timeout: 10000, windowsHide: true
    });

    // Contar daemons Gradle (java.exe con GradleDaemon en command line)
    let gradleKilled = 0;
    try {
      // wmic da la command line completa para identificar Gradle daemons
      const wmicOut = execSync(
        'wmic process where "name=\'java.exe\'" get ProcessId,CommandLine /FORMAT:CSV',
        { encoding: 'utf8', timeout: 10000, windowsHide: true }
      );
      const gradlePids = [];
      for (const line of wmicOut.split('\n')) {
        if (line.includes('GradleDaemon') || line.includes('gradle-launcher')) {
          const match = line.match(/,(\d+)\s*$/);
          if (match) gradlePids.push(match[1]);
        }
      }

      // Preservar el que es del QA backend (si está vivo)
      let qaBackendPid = null;
      try {
        const qaState = JSON.parse(fs.readFileSync(path.join(PIPELINE, 'qa-env-state.json'), 'utf8'));
        qaBackendPid = qaState.backend ? String(qaState.backend) : null;
      } catch {}

      for (const pid of gradlePids) {
        if (pid === qaBackendPid) continue; // No matar el backend QA
        try {
          execSync(`taskkill /PID ${pid} /F /T`, { timeout: 5000, windowsHide: true, stdio: 'ignore' });
          gradleKilled++;
        } catch {}
      }
    } catch {}

    if (gradleKilled > 0) {
      killed.push(`${gradleKilled} Gradle daemon(s)`);
    }

    // 2. Limpiar procesos de agentes muertos del mapa activeProcesses
    let staleAgents = 0;
    for (const [key, info] of activeProcesses) {
      if (!isProcessAlive(info.pid)) {
        activeProcesses.delete(key);
        staleAgents++;
      }
    }
    if (staleAgents > 0) {
      killed.push(`${staleAgents} agente(s) stale del registry`);
    }

  } catch (e) {
    log('free-resources', `Error durante limpieza: ${e.message}`);
  }

  if (killed.length > 0) {
    const summary = killed.join(', ');
    log('free-resources', `Recursos liberados: ${summary}`);
    sendTelegram(`🧹 Limpieza de recursos (pre-QA): ${summary}`);
  }

  return { freed: killed.length > 0, killed };
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

        const rechazados = resultados.filter(r => r.resultado === 'rechazado');

        if (rechazados.length > 0 && faseRechazo) {
          // Circuit breaker: contar rebotes previos del mismo issue en procesado/
          const devProcessed = path.join(fasePath(pipelineName, faseRechazo), 'procesado');
          let reboteCount = 0;
          try {
            for (const f of fs.readdirSync(devProcessed)) {
              if (f.startsWith(issue + '.')) reboteCount++;
            }
          } catch {}

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

// Cache de labels de issues (evita llamadas repetidas a GitHub API)
const issueLabelsCache = new Map(); // issueNum → { labels: [...], fetchedAt: timestamp }
const LABELS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutos

function getIssueLabels(issueNum) {
  const cached = issueLabelsCache.get(issueNum);
  if (cached && (Date.now() - cached.fetchedAt) < LABELS_CACHE_TTL_MS) {
    return cached.labels;
  }
  try {
    ghThrottle();
    const result = execSync(
      `"${GH_BIN}" issue view ${issueNum} --json labels --jq ".labels[].name"`,
      { cwd: ROOT, encoding: 'utf8', timeout: 10000, windowsHide: true }
    ).trim().split('\n').filter(Boolean);
    issueLabelsCache.set(issueNum, { labels: result, fetchedAt: Date.now() });
    return result;
  } catch {
    return [];
  }
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

function brazoLanzamiento(config) {
  // GATE DE RECURSOS: no lanzar nuevos agentes si CPU o RAM están sobrecargados
  if (isSystemOverloaded(config)) return;

  for (const [pipelineName, pipelineConfig] of Object.entries(config.pipelines)) {
    for (const fase of pipelineConfig.fases) {
      const pendienteDir = path.join(fasePath(pipelineName, fase), 'pendiente');
      const trabajandoDir = path.join(fasePath(pipelineName, fase), 'trabajando');
      const archivos = sortByPriority(listWorkFiles(pendienteDir), config);

      for (const archivo of archivos) {
        const skill = skillFromFile(archivo.name);
        const issue = issueFromFile(archivo.name);
        const key = processKey(skill, issue);

        // 1. DEDUP: ¿ya hay un agente activo para este ISSUE (cualquier skill) en trabajando/?
        const issueAlreadyWorking = listWorkFiles(trabajandoDir).some(f => issueFromFile(f.name) === issue);
        if (issueAlreadyWorking) continue;

        // 2. COOLDOWN: ¿este issue+skill está penalizado por fallos previos?
        if (isInCooldown(skill, issue)) continue;

        // 3. Ya hay un proceso activo para este skill+issue en memoria?
        if (activeProcesses.has(key) && isProcessAlive(activeProcesses.get(key).pid)) {
          continue;
        }

        // 4. Verificar concurrencia del rol (máximo global, NO por issue)
        const maxConcurrencia = (config.concurrencia || {})[skill] || 1;
        const running = countRunningBySkill(skill);
        if (running >= maxConcurrencia) continue;

        // Mover a trabajando/ (atómico)
        try {
          const trabajandoPath = moveFile(archivo.path, trabajandoDir);

          // Pre-requisitos por fase
          if (fase === 'verificacion') {
            ensureQaEnvironment(config);
          }

          // Lanzar agente
          if (fase === 'build') {
            lanzarBuild(issue, trabajandoPath, pipelineName, config);
          } else {
            lanzarAgenteClaude(skill, issue, trabajandoPath, pipelineName, fase, config);
          }
        } catch (e) {
          log('lanzamiento', `Error moviendo/lanzando ${archivo.name}: ${e.message}`);
        }
      }
    }
  }
}

/** Asegurar que el QA environment está levantado. Respeta saturación y cooldown entre intentos. */
let lastQaEnvCheck = 0;
const QA_ENV_CHECK_INTERVAL = 5 * 60 * 1000; // Re-verificar cada 5 minutos (no una sola vez)
let qaEnvStartFailures = 0;
const QA_ENV_MAX_FAILURES = 3; // Circuit breaker: después de 3 fallos, dejar de intentar

function ensureQaEnvironment(config) {
  const now = Date.now();

  // Cooldown entre verificaciones: no bombardear cada tick del loop
  if (now - lastQaEnvCheck < QA_ENV_CHECK_INTERVAL) return;
  lastQaEnvCheck = now;

  // Circuit breaker: si falló muchas veces, no seguir intentando
  if (qaEnvStartFailures >= QA_ENV_MAX_FAILURES) {
    log('qa-env', `Circuit breaker activo (${qaEnvStartFailures} fallos). No se reintenta levantar QA env.`);
    return;
  }

  // GATE DE RECURSOS: QA env usa umbrales más bajos que agentes porque levanta 3 servicios pesados
  const limits = config.resource_limits || {};
  const maxCpu = limits.qa_env_max_cpu_percent || 60;
  const maxMem = limits.qa_env_max_mem_percent || 60;

  const { cpuPercent, memPercent } = getSystemResourceUsage();
  if (cpuPercent >= maxCpu || memPercent >= maxMem) {
    log('qa-env', `Sistema saturado para QA env (CPU: ${cpuPercent}% >= ${maxCpu}% | RAM: ${memPercent}% >= ${maxMem}%). Intentando liberar recursos...`);

    // Intentar limpiar zombies/daemons para destrabar
    const { freed } = tryFreeResources();

    if (freed) {
      // Re-chequear después de la limpieza
      const after = getSystemResourceUsage();
      if (after.cpuPercent >= maxCpu || after.memPercent >= maxMem) {
        log('qa-env', `Post-limpieza: aún saturado (CPU: ${after.cpuPercent}% | RAM: ${after.memPercent}%). Posponiendo QA environment.`);
        return;
      }
      log('qa-env', `Post-limpieza: recursos liberados (CPU: ${after.cpuPercent}% | RAM: ${after.memPercent}%). Continuando con QA environment.`);
    } else {
      log('qa-env', `No se encontraron recursos para liberar. Posponiendo QA environment.`);
      return;
    }
  }

  const stateFile = path.join(PIPELINE, 'qa-env-state.json');
  let needsStart = false;

  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    // Verificar si todos los servicios están vivos
    for (const [name, pid] of Object.entries(state)) {
      if (!pid || !isProcessAlive(pid)) {
        log('qa-env', `${name} no está corriendo (PID: ${pid || 'null'})`);
        needsStart = true;
        break;
      }
    }
  } catch {
    needsStart = true;
  }

  if (needsStart) {
    log('qa-env', 'Levantando QA environment automáticamente...');
    try {
      execSync(`node "${path.join(PIPELINE, 'qa-environment.js')}" start`, {
        cwd: ROOT, encoding: 'utf8', timeout: 30000, windowsHide: true
      });
      log('qa-env', 'QA environment levantado OK');
      qaEnvStartFailures = 0; // Reset circuit breaker en éxito
      sendTelegram('🧪 QA Environment levantado automáticamente (emulador + backend + DynamoDB)');
    } catch (e) {
      qaEnvStartFailures++;
      log('qa-env', `Error levantando QA environment (${qaEnvStartFailures}/${QA_ENV_MAX_FAILURES}): ${e.message}`);
      sendTelegram(`⚠️ Error levantando QA environment (${qaEnvStartFailures}/${QA_ENV_MAX_FAILURES}): ` + e.message.slice(0, 100));
    }
  } else {
    log('qa-env', 'QA environment OK — ya corriendo');
  }
}

function lanzarAgenteClaude(skill, issue, trabajandoPath, pipeline, fase, config) {
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
  }

  const args = ['-p', userPrompt, '--system-prompt-file', systemFile, '--output-format', 'text', '--verbose', '--permission-mode', 'bypassPermissions'];

  log('lanzamiento', `Lanzando ${skill}:#${issue} (fase: ${fase}, pipeline: ${pipeline})`);

  // Log de agente: redirigir stdout/stderr directamente al archivo
  const agentLogPath = path.join(LOG_DIR, `${issue}-${skill}.log`);
  fs.writeFileSync(agentLogPath, `--- ${skill}:#${issue} fase:${fase} pipeline:${pipeline} ${new Date().toISOString()} ---\n`);
  const agentLogFd = fs.openSync(agentLogPath, 'a');

  // Usar Node directo para evitar cmd.exe y ventanas visibles
  const spawnCmd = USE_NODE_DIRECT ? process.execPath : CLAUDE_BIN;
  const spawnArgs = USE_NODE_DIRECT ? [CLAUDE_CLI_JS, ...args] : args;

  const child = spawn(spawnCmd, spawnArgs, {
    cwd: needsWorktree ? worktreePath : ROOT,
    stdio: ['ignore', agentLogFd, agentLogFd],
    detached: false,
    shell: false,
    windowsHide: true,
    env: { ...process.env, PIPELINE_ISSUE: issue, PIPELINE_SKILL: skill, PIPELINE_FASE: fase }
  });

  child.unref();
  fs.closeSync(agentLogFd);

  activeProcesses.set(processKey(skill, issue), {
    pid: child.pid,
    startTime: Date.now(),
    trabajandoPath,
    pipeline,
    fase,
    worktreePath: needsWorktree ? worktreePath : null
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
    const elapsedSec = (Date.now() - launchTime) / 1000;

    // Si murió en menos de 15 segundos con error → fallo de infra + COOLDOWN
    if (code !== 0 && elapsedSec < 15) {
      const { failures, delayMin } = registerFastFail(skill, issue);
      log('lanzamiento', `⚠️ ${skill}:#${issue} murió en ${elapsedSec.toFixed(0)}s (code=${code}) — fallo #${failures}, cooldown ${delayMin}min`);
      const pendienteDir = path.join(fasePath(pipeline, fase), 'pendiente');
      try { moveFile(trabajandoPath, pendienteDir); } catch {}
      activeProcesses.delete(processKey(skill, issue));
      // Matar Gradle daemons incluso en fast-fail
      killGradleDaemonsForCwd(needsWorktree ? worktreePath : ROOT, `${skill}:#${issue} (fast-fail)`);
      // Salir del canal de contexto
      if (contextChannelId) {
        try {
          const cm = require(path.join(ROOT, '.claude', 'hooks', 'context-manager'));
          cm.leaveChannelByType(contextChannelId, 'agent');
        } catch (e) {}
      }
      sendTelegram(`⚠️ ${skill}:#${issue} murió en ${elapsedSec.toFixed(0)}s — fallo #${failures}. Cooldown ${delayMin}min antes de reintentar.`);
      return;
    }

    // Éxito o finalización normal → limpiar cooldown
    if (code === 0) clearCooldown(skill, issue);

    const listoDir = path.join(fasePath(pipeline, fase), 'listo');
    try {
      const data = readYaml(trabajandoPath);
      if (!data.resultado) {
        data.resultado = code === 0 ? 'aprobado' : 'rechazado';
        data.motivo = code !== 0 ? `Agente terminó con código ${code}` : undefined;
        writeYaml(trabajandoPath, data);
      }
      moveFile(trabajandoPath, listoDir);
      log('lanzamiento', `${skill}:#${issue} terminó (code=${code}, ${elapsedSec.toFixed(0)}s) → listo/`);
    } catch (e) {
      log('lanzamiento', `Error post-proceso ${skill}:#${issue}: ${e.message}`);
    }
    activeProcesses.delete(processKey(skill, issue));

    // Matar Gradle daemons del worktree para liberar RAM (cada daemon usa hasta 4GB)
    killGradleDaemonsForCwd(needsWorktree ? worktreePath : ROOT, `${skill}:#${issue}`);

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

function lanzarBuild(issue, trabajandoPath, pipeline, config) {
  log('lanzamiento', `BUILD #${issue} — ejecutando gradlew check`);

  // Buscar el worktree del issue
  const worktreePattern = `platform.agent-${issue}-`;
  let buildCwd = ROOT;

  try {
    const worktrees = execSync('git worktree list --porcelain', { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    for (const line of worktrees.split('\n')) {
      if (line.startsWith('worktree ') && line.includes(worktreePattern)) {
        buildCwd = line.replace('worktree ', '').trim();
        break;
      }
    }
  } catch { /* usar ROOT */ }

  // Antes de compilar, mergear origin/main para tener los últimos hotfixes
  if (buildCwd !== ROOT) {
    try {
      execSync('git fetch origin main && git merge origin/main --no-edit', {
        cwd: buildCwd, encoding: 'utf8', timeout: 30000, windowsHide: true
      });
      log('build', `#${issue} worktree actualizado con origin/main`);
    } catch (e) {
      log('build', `#${issue} merge main falló (puede haber conflictos): ${e.message.slice(0, 200)}`);
    }
  }

  // Ejecutar ./gradlew check via Git Bash (path absoluto para que spawn lo encuentre)
  const bashExe = 'C:/Program Files/Git/usr/bin/bash.exe';
  // Validar que JAVA_HOME tenga un java.exe válido; si no, usar Temurin 21
  // IMPORTANTE: solo chequear existencia del directorio no alcanza — IntelliJ JBR puede existir
  // pero no ser un JDK válido (sin bin/java.exe). Hay que validar el binario.
  const envJavaHome = process.env.JAVA_HOME;
  const javaExe = process.platform === 'win32' ? 'java.exe' : 'java';
  const isValidJavaHome = envJavaHome && fs.existsSync(path.join(envJavaHome, 'bin', javaExe));
  const javaHome = (isValidJavaHome ? envJavaHome : 'C:/Users/Administrator/.jdks/temurin-21.0.7').replace(/\\/g, '/');
  const cwdUnix = buildCwd.replace(/\\/g, '/');

  // Construir env con JAVA_HOME forzado y PATH completo (incluye /usr/bin de Git para uname)
  const gitUsrBin = 'C:/Program Files/Git/usr/bin';
  const buildEnv = {
    ...process.env,
    JAVA_HOME: javaHome,
    PATH: `${gitUsrBin}${path.delimiter}${process.env.PATH || ''}`
  };

  const BUILD_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutos

  const child = spawn(bashExe, ['-c', `cd "${cwdUnix}" && ./gradlew check --no-daemon`], {
    cwd: buildCwd,
    env: buildEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    windowsHide: true
  });

  child.unref();

  // Timeout: matar el build si excede 30 minutos
  const buildTimer = setTimeout(() => {
    log('build', `#${issue} TIMEOUT — build excedió ${BUILD_TIMEOUT_MS / 60000} minutos, matando proceso`);
    try { child.kill('SIGTERM'); } catch {}
  }, BUILD_TIMEOUT_MS);

  const buildStartTime = Date.now();
  activeProcesses.set(processKey('build', issue), {
    pid: child.pid,
    startTime: buildStartTime,
    trabajandoPath,
    pipeline,
    fase: 'build'
  });

  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });

  child.on('exit', (code) => {
    clearTimeout(buildTimer);
    const durationMin = ((Date.now() - buildStartTime) / 60000).toFixed(1);
    const logFile = path.join(LOG_DIR, `build-${issue}.log`);
    fs.writeFileSync(logFile, output);

    const data = readYaml(trabajandoPath);
    if (code === 0) {
      data.resultado = 'aprobado';
    } else {
      data.resultado = 'rechazado';
      // Extraer últimas líneas relevantes del log
      const lines = output.split('\n');
      const errorLines = lines.filter(l => /error|FAILED|failure/i.test(l)).slice(0, 5);
      data.motivo = `Build falló (exit ${code}). ${errorLines.join(' | ')}. Log: .pipeline/logs/build-${issue}.log`;
    }
    writeYaml(trabajandoPath, data);

    const listoDir = path.join(fasePath(pipeline, 'build'), 'listo');
    try {
      moveFile(trabajandoPath, listoDir);
      log('build', `#${issue} build ${code === 0 ? '✓' : '✗'} (${durationMin}min) → listo/`);
    } catch (e) {
      log('build', `Error moviendo build result #${issue}: ${e.message}`);
    }
    activeProcesses.delete(processKey('build', issue));

    // Matar Gradle daemons del build para liberar RAM
    killGradleDaemonsForCwd(buildCwd, `build:#${issue}`);
  });
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

function cmdStatus(config) {
  const lines = ['📊 *Estado del Pipeline*\n'];

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

  // Estado pausa
  if (paused) lines.push('\n⏸️ *PULPO PAUSADO*');

  return lines.join('\n');
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
    const resultado = await ejecutarClaude(propositorPrompt);

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
function ejecutarClaude(prompt) {
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
    const startTime = Date.now();

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
        }
      } catch {}
    });

    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    // Mensajes de progreso cada 45s
    const templates = [
      (ctx, stats) => `⏳ ${ctx ? `Estoy en: ${ctx}` : 'Analizando tu pedido'}... ${stats}`,
      (ctx, stats) => `⚙️ ${stats}. ${ctx ? `Último paso: ${ctx}` : 'Sigo laburando'}`,
      (ctx, stats) => `🔧 Esto lleva laburo — ${stats}. ${ctx ? `Ahora: ${ctx}` : 'Ya casi'}`,
      (ctx, stats) => `💪 ${stats}. Bancame que ya cierro esto`,
      (ctx, stats) => `🔄 Varias cosas que revisar — ${stats}`,
      (ctx, stats) => `📋 ${stats}. Un toque más`,
      (ctx, stats) => `🔍 Casi termino — ${stats}`,
      (ctx, stats) => `✨ Ya lo tengo, dame un segundo más — ${stats}`,
    ];
    const progressTimer = setInterval(() => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const ctx = lastToolDesc ? lastToolDesc.slice(0, 40) : '';
      const stats = `${toolCount} pasos en ${elapsed}s`;
      const msg = templates[progressCount % templates.length](ctx, stats);
      progressCount++;
      sendTelegram(msg);
      log('commander', `Progreso: ${msg}`);
    }, 45000);

    proc.on('exit', (code) => {
      clearInterval(progressTimer);
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      log('commander', `Claude terminó (code=${code}, tools=${toolCount}, ${elapsed}s, lastText=${(lastText||'').length}chars)`);
      if (finalResult?.result) {
        resolve(finalResult.result);
      } else if (lastText) {
        resolve(lastText);
      } else {
        log('commander', `stderr: ${stderr.slice(0, 300)}`);
        resolve(`No pude completar tu pedido (${toolCount} operaciones en ${elapsed}s). Intentá de nuevo o con algo más puntual.`);
      }
    });

    proc.on('error', (e) => {
      clearInterval(progressTimer);
      reject(e);
    });
  });
}

function cmdHelp() {
  return `🤖 *Comandos del Pipeline V2*

/status — Tablero completo del pipeline
/actividad [filtro] — Timeline (ej: /actividad 30m, /actividad #732)
/intake [issue] — Meter trabajo al pipeline
/proponer — Proponer historias nuevas (vía Claude)
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
  const archivos = listWorkFiles(commanderPendiente);

  log('commander', `${archivos.length} mensaje(s) pendiente(s)`);

  if (archivos.length === 0) return;

  // Commander es singleton — verificar si ya hay uno corriendo
  const key = processKey('commander', 'telegram');
  if (activeProcesses.has(key) && isProcessAlive(activeProcesses.get(key).pid)) {
    log('commander', 'Ya hay un commander corriendo — skip');
    return;
  }

  // Tomar TODOS los mensajes pendientes
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

  if (mensajes.length === 0) return;

  const historyFile = path.join(PIPELINE, 'commander-history.jsonl');
  const botToken = getTelegramToken();
  const chatId = getTelegramChatId();
  log('commander', `Token: ${botToken ? 'OK' : 'FALTA'}, ChatId: ${chatId || 'FALTA'}`);

  // Preprocesar multimedia
  const { preprocessMessage, textToSpeech, sendVoiceTelegram } = require('./multimedia');

  const session = loadSession();

  for (const m of mensajes) {
    log('commander', `Procesando msg de ${m.from}: "${(m.text || '').slice(0, 50)}"`);
    const processed = await preprocessMessage(m, botToken);
    const textoFinal = processed.text + (processed.extras.length > 0 ? ' ' + processed.extras.join(' ') : '');
    log('commander', `Preprocesado: "${textoFinal.slice(0, 80)}"`);

    // Registrar entrada en historial
    fs.appendFileSync(historyFile, JSON.stringify({ direction: 'in', from: m.from, text: textoFinal, timestamp: new Date().toISOString() }) + '\n');

    let respuesta = null;
    const parsed = parseCommand(textoFinal);

    if (parsed) {
      // Handler nativo de comando
      log('commander', `Comando detectado: /${parsed.cmd} args="${parsed.args}"`);
      switch (parsed.cmd) {
        case 'status':
          respuesta = cmdStatus(config);
          break;
        case 'actividad':
          respuesta = cmdActividad(parsed.args);
          break;
        case 'intake':
          respuesta = cmdIntake(parsed.args, config);
          break;
        case 'pausar':
          respuesta = cmdPausar();
          break;
        case 'reanudar':
          respuesta = cmdReanudar();
          break;
        case 'costos':
          respuesta = cmdCostos();
          break;
        case 'help':
        case 'start':
          respuesta = cmdHelp();
          break;
        case 'stop':
          respuesta = '🛑 Commander apagándose...';
          sendTelegram(respuesta);
          running = false;
          break;
        case 'proponer':
          respuesta = await cmdProponer(parsed.args, config);
          break;
        default:
          // Comando desconocido — delegar a Claude como texto libre
          respuesta = null;
          break;
      }

      // Guardar contexto del comando nativo en sesión
      if (respuesta !== null) {
        session.lastCommand = parsed.cmd;
        session.lastTimestamp = new Date().toISOString();
        session.context = `Último comando: /${parsed.cmd}. Respuesta: ${(respuesta || '').slice(0, 200)}`;
      }
    }

    // Si no se resolvió con handler nativo → delegar a Claude
    if (respuesta === null) {
      try {
        let historial = '';
        try {
          const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
          const lines = fs.readFileSync(historyFile, 'utf8').trim().split('\n')
            .filter(l => { try { return JSON.parse(l).timestamp >= cutoff24h; } catch { return false; } })
            .slice(-50); // Cap a 50 entries dentro de las 24hs
          historial = '\nHistorial reciente (24hs):\n' + lines.join('\n');
        } catch {}

        // Incluir contexto de sesión para continuidad conversacional
        let sessionCtx = '';
        if (session.context && session.lastTimestamp) {
          const ageMin = (Date.now() - new Date(session.lastTimestamp).getTime()) / 60000;
          if (ageMin < 30) { // Solo si la sesión es reciente (< 30 min)
            sessionCtx = `\n\nContexto de sesión: ${session.context}`;
          }
        }

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

Mensaje de ${m.from}: ${textoFinal}${sessionCtx}${historial}`;

        sendTelegram('🔄 Recibido, estoy trabajando en tu pedido...');
        respuesta = await ejecutarClaude(userPrompt);
        log('commander', `Claude respondió: ${(respuesta || '').length} chars`);

        // Actualizar sesión con respuesta de Claude
        session.lastCommand = 'chat';
        session.lastTimestamp = new Date().toISOString();
        session.context = `Conversación libre. Último mensaje: "${textoFinal.slice(0, 100)}". Respuesta: "${(respuesta || '').slice(0, 100)}"`;
      } catch (e) {
        log('commander', `Error Claude: ${e.message}`);
        respuesta = '⚠️ Error procesando tu mensaje. Intentá de nuevo.';
      }
    }

    // Enviar respuesta
    if (respuesta) {
      let enviado = false;

      // Si el mensaje original fue de voz → intentar TTS, siempre con fallback a texto
      if (m.voice || m.voice_path) {
        try {
          const audioBuffer = await textToSpeech(respuesta);
          if (audioBuffer) {
            // Guardar audio a disco y enviar via sendVoice directo
            const audioPath = path.join(LOG_DIR, 'media', `tts-${Date.now()}.ogg`);
            fs.writeFileSync(audioPath, audioBuffer);
            enviado = await sendVoiceTelegram(audioBuffer, botToken, chatId);
            if (enviado) log('telegram', `Audio TTS enviado (${audioBuffer.length} bytes)`);
          }
        } catch (e) {
          log('commander', `TTS error: ${e.message}`);
        }
      }

      // SIEMPRE encolar texto en servicio-telegram como respaldo
      // Si TTS funcionó, el usuario ya tiene el audio — el texto es backup
      // Si TTS falló, el texto es la respuesta principal
      sendTelegram(respuesta);
      log('telegram', `Texto encolado como ${enviado ? 'backup' : 'principal'} (${respuesta.length} chars)`);

      // Registrar salida en historial
      fs.appendFileSync(historyFile, JSON.stringify({ direction: 'out', text: respuesta.slice(0, 1000), timestamp: new Date().toISOString() }) + '\n');
    }

    // Mover a listo
    try { moveFile(m._path, commanderListo); } catch {}

    const logFile = path.join(LOG_DIR, 'commander.log');
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${parsed ? '/' + parsed.cmd : 'TEXT'}\n${respuesta || '(sin respuesta)'}\n---\n`);
  }

  // Persistir sesión conversacional
  saveSession(session);
  activeProcesses.delete(key);
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

      // Cachear labels de los issues recién traídos de GitHub
      for (const issue of issues) {
        const labelNames = (issue.labels || []).map(l => l.name);
        issueLabelsCache.set(String(issue.number), { labels: labelNames, fetchedAt: Date.now() });
      }

      // Ordenar por prioridad combinada (priority label + feature priority)
      issues.sort((a, b) => {
        return calcularPrioridad(String(a.number), config) - calcularPrioridad(String(b.number), config);
      });

      for (const issue of issues) {
        const issueNum = String(issue.number);

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

async function mainLoop() {
  log('pulpo', `Pulpo V2 iniciado — poll cada ${loadConfig().timeouts?.poll_interval_seconds || 30}s`);
  log('pulpo', `Pipeline: ${PIPELINE}`);

  while (running) {
    try {
      checkPauseFile();

      const config = loadConfig(); // Reload cada ciclo para hot-reload

      // Commander SIEMPRE corre (incluso en pausa) — necesario para /reanudar
      await brazoCommander(config);

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
        brazoIntake(config);    // Segundo: traer trabajo nuevo de GitHub
        brazoBarrido(config);   // Tercero: promover entre fases
        brazoLanzamiento(config); // Cuarto: asignar trabajo a agentes
        brazoHuerfanos(config); // Quinto: recuperar trabajo trabado
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

// --- SINGLETON ---
require('./singleton')('pulpo');

mainLoop().then(() => {
  log('pulpo', 'Pulpo finalizado');
  process.exit(0);
});

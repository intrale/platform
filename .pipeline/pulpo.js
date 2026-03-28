#!/usr/bin/env node
// =============================================================================
// Pulpo V2 — Proceso central del pipeline
// Brazos: barrido, lanzamiento, huérfanos (+ intake en F5)
// =============================================================================

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..');
const PIPELINE = path.resolve(ROOT, '.pipeline');
const CONFIG_PATH = path.join(PIPELINE, 'config.yaml');
const LOG_DIR = path.join(PIPELINE, 'logs');
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
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
function issueExistsInPipeline(issueNum) {
  const prefix = issueNum + '.';
  function searchDir(dir) {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (searchDir(path.join(dir, entry.name))) return true;
        } else if (entry.name.startsWith(prefix) && entry.name !== '.gitkeep') {
          return true;
        }
      }
    } catch {}
    return false;
  }
  return searchDir(PIPELINE);
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
  let count = 0;
  for (const [key, info] of activeProcesses) {
    if (key.startsWith(skill + ':') && isProcessAlive(info.pid)) {
      count++;
    } else if (!isProcessAlive(info.pid)) {
      activeProcesses.delete(key);
    }
  }
  return count;
}

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
            motivo_rechazo: motivos,
            rechazado_en_fase: fase
          });

          log('barrido', `#${issue} RECHAZADO en ${fase} → devuelto a ${faseRechazo} (${rechazados.length} rechazos)`);
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

          // Cleanup: eliminar worktree del issue si existe
          try {
            const wtList = execSync('git worktree list --porcelain', { cwd: ROOT, encoding: 'utf8', timeout: 10000 });
            const wtPattern = `platform.agent-${issue}-`;
            for (const line of wtList.split('\n')) {
              if (line.startsWith('worktree ') && line.includes(wtPattern)) {
                const wtPath = line.replace('worktree ', '').trim();
                execSync(`git worktree remove "${wtPath}" --force`, { cwd: ROOT, timeout: 30000 });
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

  // Buscar en archivos procesados de fases anteriores si ya se determinó
  // Por ahora: intentar leer labels del issue de GitHub
  try {
    ghThrottle();
    const result = execSync(
      `"${GH_BIN}" issue view ${issue} --json labels --jq ".labels[].name"`,
      { cwd: ROOT, encoding: 'utf8', timeout: 10000 }
    ).trim().split('\n');

    for (const label of result) {
      if (mapping[label]) return mapping[label];
    }
  } catch { /* ignorar */ }

  return mapping.default || 'backend-dev';
}

// =============================================================================
// BRAZO 2: LANZAMIENTO — Detecta trabajo pendiente, lanza agentes
// =============================================================================

function brazoLanzamiento(config) {
  for (const [pipelineName, pipelineConfig] of Object.entries(config.pipelines)) {
    for (const fase of pipelineConfig.fases) {
      const pendienteDir = path.join(fasePath(pipelineName, fase), 'pendiente');
      const trabajandoDir = path.join(fasePath(pipelineName, fase), 'trabajando');
      const archivos = listWorkFiles(pendienteDir);

      for (const archivo of archivos) {
        const skill = skillFromFile(archivo.name);
        const issue = issueFromFile(archivo.name);
        const key = processKey(skill, issue);

        // Ya hay un proceso activo para este skill+issue?
        if (activeProcesses.has(key) && isProcessAlive(activeProcesses.get(key).pid)) {
          continue;
        }

        // Verificar concurrencia
        const maxConcurrencia = (config.concurrencia || {})[skill] || 1;
        const running = countRunningBySkill(skill);
        if (running >= maxConcurrencia) continue;

        // Mover a trabajando/ (atómico)
        try {
          const trabajandoPath = moveFile(archivo.path, trabajandoDir);

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

  const userPrompt = `Archivo de trabajo: ${path.basename(trabajandoPath)}\nPath: ${trabajandoPath}\nContenido:\n${yaml.dump(workData, { lineWidth: -1 })}`;

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
          cwd: ROOT, encoding: 'utf8', timeout: 30000
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

  const args = ['-p', userPrompt, '--system-prompt-file', systemFile, '--output-format', 'text', '--max-turns', '3'];
  if (needsWorktree) {
    args.push('--cwd', worktreePath);
  }

  log('lanzamiento', `Lanzando ${skill}:#${issue} (fase: ${fase}, pipeline: ${pipeline})`);

  const child = spawn(CLAUDE_BIN, args, {
    cwd: needsWorktree ? worktreePath : ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    shell: true,
    env: { ...process.env, PIPELINE_ISSUE: issue, PIPELINE_SKILL: skill, PIPELINE_FASE: fase }
  });

  child.unref();

  activeProcesses.set(processKey(skill, issue), {
    pid: child.pid,
    startTime: Date.now(),
    trabajandoPath,
    pipeline,
    fase,
    worktreePath: needsWorktree ? worktreePath : null
  });

  // Cuando el proceso termina, mover de trabajando → listo
  child.on('exit', (code) => {
    const listoDir = path.join(fasePath(pipeline, fase), 'listo');
    try {
      // El agente debería haber escrito resultado en el archivo
      // Si no lo hizo, marcamos como error
      const data = readYaml(trabajandoPath);
      if (!data.resultado) {
        data.resultado = code === 0 ? 'aprobado' : 'rechazado';
        data.motivo = code !== 0 ? `Agente terminó con código ${code}` : undefined;
        writeYaml(trabajandoPath, data);
      }
      moveFile(trabajandoPath, listoDir);
      log('lanzamiento', `${skill}:#${issue} terminó (code=${code}) → listo/`);
    } catch (e) {
      log('lanzamiento', `Error post-proceso ${skill}:#${issue}: ${e.message}`);
    }
    activeProcesses.delete(processKey(skill, issue));
  });

  child.stdout.on('data', (data) => {
    const logFile = path.join(LOG_DIR, `${issue}-${skill}.log`);
    fs.appendFileSync(logFile, data);
  });

  child.stderr.on('data', (data) => {
    const logFile = path.join(LOG_DIR, `${issue}-${skill}.log`);
    fs.appendFileSync(logFile, `[STDERR] ${data}`);
  });
}

function lanzarBuild(issue, trabajandoPath, pipeline, config) {
  log('lanzamiento', `BUILD #${issue} — ejecutando gradlew check`);

  const timeout = (config.timeouts?.build_timeout_minutes || 15) * 60 * 1000;

  // Buscar el worktree del issue
  const worktreePattern = `platform.agent-${issue}-`;
  let buildCwd = ROOT;

  try {
    const worktrees = execSync('git worktree list --porcelain', { cwd: ROOT, encoding: 'utf8' });
    for (const line of worktrees.split('\n')) {
      if (line.startsWith('worktree ') && line.includes(worktreePattern)) {
        buildCwd = line.replace('worktree ', '').trim();
        break;
      }
    }
  } catch { /* usar ROOT */ }

  const child = spawn('bash', ['-c', `./gradlew check 2>&1`], {
    cwd: buildCwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true
  });

  child.unref();

  // Timeout real con setTimeout + kill (spawn no soporta timeout option)
  const buildTimer = setTimeout(() => {
    log('build', `#${issue} TIMEOUT (${timeout / 60000}min) — matando proceso`);
    try { process.kill(-child.pid); } catch {}
    try { child.kill('SIGKILL'); } catch {}
  }, timeout);

  activeProcesses.set(processKey('build', issue), {
    pid: child.pid,
    startTime: Date.now(),
    trabajandoPath,
    pipeline,
    fase: 'build'
  });

  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });

  child.on('exit', (code) => {
    clearTimeout(buildTimer);
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
      log('build', `#${issue} build ${code === 0 ? '✓' : '✗'} → listo/`);
    } catch (e) {
      log('build', `Error moviendo build result #${issue}: ${e.message}`);
    }
    activeProcesses.delete(processKey('build', issue));
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
          } catch (e) {
            log('huerfanos', `Error rechazando ${archivo.name}: ${e.message}`);
          }
        } else {
          // Devolver a pendiente para reintento
          log('huerfanos', `${archivo.name} lleva ${Math.round(age)}min sin proceso → pendiente/ (intento ${retries}/${MAX_ORPHAN_RETRIES})`);
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
    if (issueExistsInPipeline(issueNum)) {
      return `⚠️ #${issueNum} ya está en el pipeline`;
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

function cmdProponer(args, config) {
  const count = parseInt(args) || 3;

  // Lanzar agente propositor como proceso async (fire-and-forget)
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

  try {
    // Ejecutar Claude síncronamente (max 2 min) para obtener propuestas
    const { spawnSync: spSyncP } = require('child_process');
    const propResult = spSyncP(CLAUDE_BIN, ['-p', '-', '--output-format', 'text', '--max-turns', '3'], {
      cwd: ROOT, encoding: 'utf8', timeout: 120000, input: propositorPrompt,
      shell: true, windowsHide: true
    });
    if (propResult.error) throw propResult.error;
    const resultado = (propResult.stdout || '').trim();

    if (resultado) {
      // Guardar propuestas en archivo para referencia
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

  // Detección de intención por lenguaje natural (para audio transcripto)
  const lower = trimmed.toLowerCase();
  const intentPatterns = [
    { pattern: /\b(status|estado|tablero|cómo est[áa]|que hay en el pipeline)\b/i, cmd: 'status' },
    { pattern: /\b(pausar|paus[áa]|fren[áa]|par[áa] el pulpo)\b/i, cmd: 'pausar' },
    { pattern: /\b(reanudar|reanud[áa]|segui|continu[áa]|arrancá)\b/i, cmd: 'reanudar' },
    { pattern: /\b(actividad|qué pas[óo]|movimientos|timeline)\b/i, cmd: 'actividad' },
    { pattern: /\b(costos?|gasto|consumo|tokens?)\b/i, cmd: 'costos' },
    { pattern: /\b(ayuda|help|comandos disponibles)\b/i, cmd: 'help' },
    { pattern: /\b(intake|met[eé] .* issue|tra[eé] .* issue|ingres[áa])\b/i, cmd: 'intake' },
    { pattern: /\b(proponer|propon[eé]|historias nuevas|ideas)\b/i, cmd: 'proponer' },
    { pattern: /\b(stop|apag[áa]|cerr[áa])\b/i, cmd: 'stop' },
  ];

  for (const { pattern, cmd } of intentPatterns) {
    if (pattern.test(lower)) {
      // Extraer argumentos: todo lo que no es el keyword
      const args = lower.replace(pattern, '').trim();
      log('commander', `Intención detectada: "${trimmed.slice(0, 50)}" → /${cmd}`);
      return { cmd, args };
    }
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
          respuesta = cmdProponer(parsed.args, config);
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

        const { spawnSync: spSync } = require('child_process');
        const claudeResult = spSync(CLAUDE_BIN, ['-p', '-', '--output-format', 'json', '--max-turns', '10'], {
          cwd: ROOT, encoding: 'utf8', timeout: 180000, input: userPrompt,
          shell: true, windowsHide: true
        });
        if (claudeResult.error) throw claudeResult.error;
        const rawOut = (claudeResult.stdout || '').trim();
        // claude --output-format json devuelve: {"type":"result","result":"texto final",...}
        try {
          const parsed = JSON.parse(rawOut);
          respuesta = parsed.result || rawOut;
        } catch {
          respuesta = rawOut;
        }
        log('commander', `Claude respondió (json): ${(respuesta || '').length} chars`);

        log('commander', `Claude respondió: ${respuesta.length} chars`);

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

      // Si el mensaje original fue de voz → responder con audio
      if (m.voice || m.voice_path) {
        try {
          const audioBuffer = await textToSpeech(respuesta);
          if (audioBuffer) {
            enviado = await sendVoiceTelegram(audioBuffer, botToken, chatId);
            if (enviado) log('telegram', `Audio enviado (${audioBuffer.length} bytes)`);
          }
        } catch (e) {
          log('commander', `TTS error: ${e.message}`);
        }
      }

      if (!enviado) {
        sendTelegram(respuesta);
      }

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
        { cwd: ROOT, encoding: 'utf8', timeout: 30000 }
      );
      const issues = JSON.parse(result || '[]');

      if (issues.length === 0) continue;

      // Ordenar por prioridad
      const prioLabels = config.prioridad_labels || [];
      issues.sort((a, b) => {
        const prioA = prioLabels.findIndex(p => a.labels?.some(l => l.name === p));
        const prioB = prioLabels.findIndex(p => b.labels?.some(l => l.name === p));
        return (prioA === -1 ? 999 : prioA) - (prioB === -1 ? 999 : prioB);
      });

      for (const issue of issues) {
        const issueNum = String(issue.number);

        // Deduplicación: verificar que el issue no esté ya en el pipeline
        if (issueExistsInPipeline(issueNum)) continue;

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

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
    detached: true,
    timeout
  });

  child.unref();

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

function brazoHuerfanos(config) {
  const timeoutMinutes = config.timeouts?.orphan_timeout_minutes || 10;

  for (const [pipelineName, pipelineConfig] of Object.entries(config.pipelines)) {
    for (const fase of pipelineConfig.fases) {
      const trabajandoDir = path.join(fasePath(pipelineName, fase), 'trabajando');
      const pendienteDir = path.join(fasePath(pipelineName, fase), 'pendiente');
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

        // Proceso muerto o desconocido + timeout → devolver a pendiente
        log('huerfanos', `${archivo.name} lleva ${Math.round(age)}min en trabajando/ sin proceso → pendiente/`);
        try {
          moveFile(archivo.path, pendienteDir);
          activeProcesses.delete(key);
        } catch (e) {
          log('huerfanos', `Error devolviendo ${archivo.name}: ${e.message}`);
        }
      }
    }
  }
}

// =============================================================================
// BRAZO 5: COMMANDER — Procesa mensajes de Telegram
// =============================================================================

async function brazoCommander(config) {
  const commanderPendiente = path.join(PIPELINE, 'servicios', 'commander', 'pendiente');
  const commanderTrabajando = path.join(PIPELINE, 'servicios', 'commander', 'trabajando');
  const commanderListo = path.join(PIPELINE, 'servicios', 'commander', 'listo');
  const archivos = listWorkFiles(commanderPendiente);

  if (archivos.length === 0) return;

  // Commander es singleton — verificar si ya hay uno corriendo
  const key = processKey('commander', 'telegram');
  if (activeProcesses.has(key) && isProcessAlive(activeProcesses.get(key).pid)) return;

  // Tomar TODOS los mensajes pendientes (el commander los procesa en lote)
  const mensajes = [];
  for (const archivo of archivos) {
    try {
      const trabajandoPath = moveFile(archivo.path, commanderTrabajando);
      const data = JSON.parse(fs.readFileSync(trabajandoPath, 'utf8'));
      mensajes.push({ ...data, _path: trabajandoPath });
    } catch (e) {
      log('commander', `Error moviendo ${archivo.name}: ${e.message}`);
    }
  }

  if (mensajes.length === 0) return;

  // Construir contexto con historial
  const historyFile = path.join(PIPELINE, 'commander-history.jsonl');
  let historial = '';
  try {
    const lines = fs.readFileSync(historyFile, 'utf8').trim().split('\n').slice(-50);
    historial = '\nHistorial reciente:\n' + lines.join('\n');
  } catch {}

  // Construir prompt con los mensajes
  const cmdPrompt = fs.readFileSync(path.join(PIPELINE, 'roles', 'commander.md'), 'utf8');
  // Preprocesar multimedia (transcribir audio, describir imágenes)
  const { preprocessMessage } = require('./multimedia');
  const botToken = getTelegramToken();

  const mensajesDesc = [];
  for (let i = 0; i < mensajes.length; i++) {
    const m = mensajes[i];
    const processed = await preprocessMessage(m, botToken);
    let desc = `${i + 1}. [${m.from}] ${processed.text}`;
    if (processed.extras.length > 0) desc += ' ' + processed.extras.join(' ');
    mensajesDesc.push(desc);
  }

  const userPrompt = `Mensajes de Telegram a responder:\n${mensajesDesc.join('\n')}\n\nResponde a cada mensaje de forma concisa.`;

  // Construir args de claude
  const claudeArgs = ['-p', '-', '--output-format', 'text'];

  // Si hay imágenes, claude puede leerlas directamente con Read tool
  log('commander', `Lanzando commander para ${mensajes.length} mensaje(s)`);

  try {
    const respuesta = execSync(
      `claude ${claudeArgs.join(' ')}`,
      { cwd: ROOT, encoding: 'utf8', timeout: 120000, input: userPrompt }
    ).trim();

    log('commander', `Commander respondió: ${respuesta.length} chars`);

    // Enviar respuesta a Telegram
    // Si algún mensaje era audio, responder con audio (TTS)
    const hasVoice = mensajes.some(m => m.voice);
    if (respuesta && hasVoice) {
      const { textToSpeech, sendVoiceTelegram } = require('./multimedia');
      log('commander', 'Generando TTS para respuesta de audio...');
      const audioBuffer = await textToSpeech(respuesta);
      if (audioBuffer) {
        const sent = await sendVoiceTelegram(audioBuffer, botToken, getTelegramChatId());
        if (sent) {
          log('telegram', `Audio enviado (${audioBuffer.length} bytes)`);
        } else {
          log('telegram', 'Error enviando audio, fallback a texto');
          sendTelegram(respuesta);
        }
      } else {
        log('telegram', 'TTS no disponible, enviando texto');
        sendTelegram(respuesta);
      }
    } else if (respuesta) {
      sendTelegram(respuesta);
    } else {
      sendTelegram('(Commander no genero respuesta)');
    }

    // Guardar en historial
    for (const m of mensajes) {
      fs.appendFileSync(historyFile, JSON.stringify({ direction: 'in', from: m.from, text: m.text, timestamp: new Date().toISOString() }) + '\n');
    }
    if (respuesta) {
      fs.appendFileSync(historyFile, JSON.stringify({ direction: 'out', text: respuesta.slice(0, 1000), timestamp: new Date().toISOString() }) + '\n');
    }

    const logFile = path.join(LOG_DIR, 'commander.log');
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] OK\n${respuesta}\n---\n`);

    // Solo mover a listo si el envío fue exitoso
    for (const m of mensajes) {
      try { moveFile(m._path, commanderListo); } catch {}
    }

  } catch (e) {
    log('commander', `Error: ${e.message}`);
    const logFile = path.join(LOG_DIR, 'commander.log');
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ERROR\n${e.message}\n---\n`);

    // Devolver mensajes a pendiente para reintento
    for (const m of mensajes) {
      try { moveFile(m._path, commanderPendiente); } catch {}
    }
    log('commander', 'Mensajes devueltos a pendiente para reintento');
  }

  activeProcesses.delete(key);
}

function sendTelegramSync(text) {
  const token = getTelegramToken();
  const chatId = getTelegramChatId();
  if (!token || !chatId) { log('telegram', 'Sin token/chatId'); return; }

  const msg = text.length > 4000 ? text.slice(0, 4000) + '...' : text;
  const data = JSON.stringify({ chat_id: chatId, text: msg });

  // Envío sincrónico usando spawnSync con node inline (evita curl y problemas de cmd.exe)
  try {
    const { spawnSync } = require('child_process');
    const script = `
      const https = require('https');
      const data = ${JSON.stringify(data)};
      const req = https.request({
        hostname: 'api.telegram.org',
        path: '/bot${token}/sendMessage',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
      }, (res) => {
        let b=''; res.on('data',c=>b+=c);
        res.on('end',()=>{ process.stdout.write(JSON.parse(b).ok?'OK':'FAIL'); });
      });
      req.on('error',(e)=>{ process.stdout.write('ERR:'+e.message); });
      req.write(data); req.end();
    `;
    const result = spawnSync('node', ['-e', script], { encoding: 'utf8', timeout: 15000 });
    const status = (result.stdout || '').trim();
    if (status === 'OK') {
      log('telegram', `Enviado (${msg.length} chars)`);
    } else {
      log('telegram', `Error: ${status || result.stderr || 'unknown'}`);
    }
  } catch (e) {
    log('telegram', `Error enviando: ${e.message}`);
  }
}

// Alias para compatibilidad
const sendTelegram = sendTelegramSync;

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

async function mainLoop() {
  log('pulpo', `Pulpo V2 iniciado — poll cada ${loadConfig().timeouts?.poll_interval_seconds || 30}s`);
  log('pulpo', `Pipeline: ${PIPELINE}`);

  while (running) {
    try {
      checkPauseFile();

      if (!paused) {
        const config = loadConfig(); // Reload cada ciclo para hot-reload
        await brazoCommander(config); // Primero: responder mensajes de Telegram
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

// Escribir PID para que el watchdog pueda verificar
fs.writeFileSync(path.join(PIPELINE, 'pulpo.pid'), String(process.pid));

mainLoop().then(() => {
  log('pulpo', 'Pulpo finalizado');
  try { fs.unlinkSync(path.join(PIPELINE, 'pulpo.pid')); } catch {}
  process.exit(0);
});

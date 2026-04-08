#!/usr/bin/env node
// =============================================================================
// Dashboard V2 — Visualización completa del pipeline
// Issue Tracker Matrix + tooltips + links GitHub + logs + SSE live
// =============================================================================

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn } = require('child_process');
const yaml = require('js-yaml');

const PORT = parseInt(process.env.DASHBOARD_PORT) || 3200;
const PIPELINE = process.env.PIPELINE_STATE_DIR || path.resolve(__dirname);
const ROOT = process.env.PIPELINE_MAIN_ROOT || path.resolve(__dirname, '..');
const LOG_DIR = path.join(PIPELINE, 'logs');
const GITHUB_BASE = 'https://github.com/intrale/platform/issues';

// --- Componentes gestionables (start/stop) ---
const COMPONENTS = [
  { name: 'pulpo', script: 'pulpo.js', pid: 'pulpo.pid' },
  { name: 'listener', script: 'listener-telegram.js', pid: 'listener.pid' },
  { name: 'svc-telegram', script: 'servicio-telegram.js', pid: 'svc-telegram.pid' },
  { name: 'svc-github', script: 'servicio-github.js', pid: 'svc-github.pid' },
  { name: 'svc-drive', script: 'servicio-drive.js', pid: 'svc-drive.pid' },
  { name: 'outbox-drain', script: 'outbox-drain.js', pid: 'outbox-drain.pid' },
];
// Nota: dashboard no se incluye (no puede matarse a sí mismo)

function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    const r = execSync(`tasklist /FI "PID eq ${pid}" /NH /FO CSV`, { encoding: 'utf8', timeout: 3000, windowsHide: true });
    return r.includes(`"${pid}"`);
  } catch { return false; }
}

function getComponentPid(comp) {
  try {
    return parseInt(fs.readFileSync(path.join(PIPELINE, comp.pid), 'utf8').trim()) || null;
  } catch { return null; }
}

function stopComponent(name) {
  const comp = COMPONENTS.find(c => c.name === name);
  if (!comp) return { ok: false, msg: `Componente "${name}" no encontrado` };
  const pid = getComponentPid(comp);
  if (!pid || !isProcessAlive(pid)) return { ok: true, msg: `${name} no estaba corriendo` };
  try {
    execSync(`taskkill /PID ${pid} /F /T`, { timeout: 5000, windowsHide: true });
    try { fs.unlinkSync(path.join(PIPELINE, comp.pid)); } catch {}
    return { ok: true, msg: `${name} detenido (PID ${pid})` };
  } catch (e) { return { ok: false, msg: `Error deteniendo ${name}: ${e.message}` }; }
}

function startComponent(name) {
  const comp = COMPONENTS.find(c => c.name === name);
  if (!comp) return { ok: false, msg: `Componente "${name}" no encontrado` };
  const pid = getComponentPid(comp);
  if (pid && isProcessAlive(pid)) return { ok: true, msg: `${name} ya está corriendo (PID ${pid})` };
  const scriptPath = path.join(PIPELINE, comp.script);
  if (!fs.existsSync(scriptPath)) return { ok: false, msg: `Script ${comp.script} no existe` };
  try {
    const logPath = path.join(LOG_DIR, `${comp.name}.log`);
    const logFd = fs.openSync(logPath, 'a');
    const child = spawn(process.execPath, [scriptPath], {
      cwd: ROOT, stdio: ['ignore', logFd, logFd], detached: true, windowsHide: true
    });
    child.unref();
    fs.closeSync(logFd);
    return { ok: true, msg: `${name} iniciado (PID ${child.pid})` };
  } catch (e) { return { ok: false, msg: `Error iniciando ${name}: ${e.message}` }; }
}

// QA Environment
const QA_ENV_SCRIPT = path.join(PIPELINE, 'qa-environment.js');

function qaAction(action, component) {
  if (!fs.existsSync(QA_ENV_SCRIPT)) return { ok: false, msg: 'qa-environment.js no existe' };
  try {
    const cmd = component
      ? `"${process.execPath}" "${QA_ENV_SCRIPT}" ${action} ${component}`
      : `"${process.execPath}" "${QA_ENV_SCRIPT}" ${action}`;
    const output = execSync(cmd, {
      cwd: ROOT, encoding: 'utf8', timeout: 60000, windowsHide: true
    });
    return { ok: true, msg: output.trim().slice(-200) };
  } catch (e) { return { ok: false, msg: `Error: ${(e.stderr || e.message || '').slice(0, 200)}` }; }
}

// --- Resource Monitor: CPU y Memoria ---
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

function getSystemResourceUsage() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const memPercent = Math.round(((totalMem - freeMem) / totalMem) * 100);
  const memUsedGB = ((totalMem - freeMem) / (1024 ** 3)).toFixed(1);
  const memTotalGB = (totalMem / (1024 ** 3)).toFixed(1);

  const current = cpuSnapshot();
  let cpuPercent = 0;
  if (lastCpuSnapshot) {
    const idleDelta = current.idle - lastCpuSnapshot.idle;
    const totalDelta = current.total - lastCpuSnapshot.total;
    cpuPercent = totalDelta > 0 ? Math.round(((totalDelta - idleDelta) / totalDelta) * 100) : 0;
  }
  lastCpuSnapshot = current;

  return { cpuPercent, memPercent, memUsedGB, memTotalGB, cpuCores: os.cpus().length };
}

// Snapshot inicial
lastCpuSnapshot = cpuSnapshot();

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [dashboard] ${msg}`);
}

function loadConfig() {
  try { return yaml.load(fs.readFileSync(path.join(PIPELINE, 'config.yaml'), 'utf8')); }
  catch { return { pipelines: {}, concurrencia: {} }; }
}

function listWorkFiles(dir) {
  try { return fs.readdirSync(dir).filter(f => !f.startsWith('.') && !f.endsWith('.gitkeep')); }
  catch { return []; }
}

function readYamlSafe(filepath) {
  try { return yaml.load(fs.readFileSync(filepath, 'utf8')) || {}; }
  catch { return {}; }
}

function fileStat(filepath) {
  try { const s = fs.statSync(filepath); return { ctimeMs: s.ctimeMs, mtimeMs: s.mtimeMs, birthtimeMs: s.birthtimeMs }; }
  catch { return null; }
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function fmtTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toISOString().slice(11, 19);
}

// --- Recolectar estado ---

function getPipelineState() {
  const config = loadConfig();
  const state = { config };

  // Todas las fases de ambos pipelines en orden
  const allFases = [];
  for (const [pName, pConfig] of Object.entries(config.pipelines)) {
    for (const fase of pConfig.fases) {
      allFases.push({ pipeline: pName, fase });
    }
  }
  state.allFases = allFases;

  // Issue matrix: cruzar issue × fase con datos enriquecidos
  state.issueMatrix = {};
  for (const { pipeline: pName, fase } of allFases) {
    const baseDir = path.join(PIPELINE, pName, fase);
    for (const [estado, dir] of [['pendiente','pendiente'],['trabajando','trabajando'],['listo','listo'],['procesado','procesado']]) {
      for (const f of listWorkFiles(path.join(baseDir, dir))) {
        const issue = f.split('.')[0];
        const skill = f.split('.').slice(1).join('.');
        if (!state.issueMatrix[issue]) state.issueMatrix[issue] = { pipelines: new Set(), fases: {} };
        state.issueMatrix[issue].pipelines.add(pName);
        if (!state.issueMatrix[issue].fases[`${pName}/${fase}`]) state.issueMatrix[issue].fases[`${pName}/${fase}`] = [];

        const filepath = path.join(baseDir, dir, f);
        const stat = fileStat(filepath);
        const entry = { skill, estado, pipeline: pName, fase };

        if (stat) {
          entry.startedAt = stat.ctimeMs;
          entry.updatedAt = stat.mtimeMs;
          entry.durationMs = (estado === 'trabajando') ? Date.now() - stat.ctimeMs : stat.mtimeMs - stat.ctimeMs;
          entry.ageMin = Math.round((Date.now() - stat.mtimeMs) / 60000);
        }

        // Leer resultado/motivo de YAML para listo/procesado
        if (estado === 'listo' || estado === 'procesado') {
          const yamlData = readYamlSafe(filepath);
          entry.resultado = yamlData.resultado;
          entry.motivo = yamlData.motivo;
        }

        // Log disponible? Buscar {issue}-{skill}.log o build-{issue}.log
        let logFile = `${issue}-${skill}.log`;
        if (!fs.existsSync(path.join(LOG_DIR, logFile)) && skill === 'build') {
          logFile = `build-${issue}.log`;
        }
        entry.hasLog = fs.existsSync(path.join(LOG_DIR, logFile));
        entry.logFile = logFile;

        state.issueMatrix[issue].fases[`${pName}/${fase}`].push(entry);

        if (estado !== 'procesado') {
          // 'trabajando' tiene prioridad: no sobreescribir con 'listo' o 'pendiente'
          const prev = state.issueMatrix[issue].estadoActual;
          if (!prev || prev !== 'trabajando' || estado === 'trabajando') {
            state.issueMatrix[issue].faseActual = `${pName}/${fase}`;
            state.issueMatrix[issue].estadoActual = estado;
          }
        }
      }
    }
  }
  // Convert Sets to arrays for JSON
  for (const data of Object.values(state.issueMatrix)) {
    data.pipelines = [...data.pipelines];
  }

  // ETA: calcular promedios históricos por skill+fase desde archivos procesados
  // Usa mtime (escritura resultado) - ctime (creación archivo) como proxy de duración
  state.etaAverages = {}; // key: "fase/skill" → avgMs
  for (const { pipeline: pName, fase } of allFases) {
    const procesadoDir = path.join(PIPELINE, pName, fase, 'procesado');
    const listoDir = path.join(PIPELINE, pName, fase, 'listo');
    for (const dir of [procesadoDir, listoDir]) {
      for (const f of listWorkFiles(dir)) {
        const skill = f.split('.').slice(1).join('.');
        const st = fileStat(path.join(dir, f));
        if (!st) continue;
        // duración = ctime - birthtime (ctime = movido a procesado, birthtime = creación original)
        const dur = st.ctimeMs - st.birthtimeMs;
        if (dur <= 5000 || dur > 4 * 3600000) continue; // descartar <5s o >4h
        const key = `${fase}/${skill}`;
        if (!state.etaAverages[key]) state.etaAverages[key] = { total: 0, count: 0 };
        state.etaAverages[key].total += dur;
        state.etaAverages[key].count++;
      }
    }
  }
  // Calcular promedios y también por fase (sin skill)
  for (const [key, data] of Object.entries(state.etaAverages)) {
    data.avgMs = Math.round(data.total / data.count);
    const fase = key.split('/')[0];
    if (!state.etaAverages[fase]) state.etaAverages[fase] = { total: 0, count: 0 };
    state.etaAverages[fase].total += data.total;
    state.etaAverages[fase].count += data.count;
  }
  for (const [key, data] of Object.entries(state.etaAverages)) {
    if (!key.includes('/')) data.avgMs = Math.round(data.total / data.count);
  }

  // Servicios
  state.servicios = {};
  try {
    for (const svc of fs.readdirSync(path.join(PIPELINE, 'servicios'))) {
      const svcDir = path.join(PIPELINE, 'servicios', svc);
      if (!fs.statSync(svcDir).isDirectory()) continue;
      state.servicios[svc] = {
        pendiente: listWorkFiles(path.join(svcDir, 'pendiente')).length,
        trabajando: listWorkFiles(path.join(svcDir, 'trabajando')).length,
        listo: listWorkFiles(path.join(svcDir, 'listo')).length
      };
    }
  } catch {}

  // Skill heatmap: carga actual vs concurrencia máxima
  state.skillLoad = {};
  const concurrencia = config.concurrencia || {};
  for (const [skill, max] of Object.entries(concurrencia)) {
    let running = 0;
    for (const { pipeline: pName, fase } of allFases) {
      running += listWorkFiles(path.join(PIPELINE, pName, fase, 'trabajando')).filter(f => f.endsWith(`.${skill}`)).length;
    }
    state.skillLoad[skill] = { running, max };
  }

  // Actividad reciente
  state.actividad = [];
  try {
    const lines = fs.readFileSync(path.join(PIPELINE, 'commander-history.jsonl'), 'utf8').trim().split('\n').slice(-20);
    for (const line of lines) {
      try { const e = JSON.parse(line); state.actividad.push({ dir: e.direction, from: e.from || '', text: (e.text || '').slice(0, 150), ts: e.timestamp }); } catch {}
    }
  } catch {}

  // Procesos
  state.procesos = {};
  for (const comp of ['pulpo', 'listener', 'svc-telegram', 'svc-github', 'svc-drive', 'outbox-drain', 'dashboard']) {
    try {
      const pid = fs.readFileSync(path.join(PIPELINE, `${comp}.pid`), 'utf8').trim();
      const alive = isProcessAlive(pid);
      state.procesos[comp] = { pid, alive };
    } catch {
      state.procesos[comp] = { pid: null, alive: false };
    }
  }

  // QA Environment
  state.qaEnv = { emulator: false };
  state.qaRemote = { active: false, url: '', ref: '', startedAt: '' };
  try {
    const qaState = JSON.parse(fs.readFileSync(path.join(PIPELINE, 'qa-env-state.json'), 'utf8'));
    for (const [svc, pid] of Object.entries(qaState)) {
      if (pid) {
        try {
          const r = execSync(`tasklist /FI "PID eq ${pid}" /NH /FO CSV`, { encoding: 'utf8', timeout: 3000, windowsHide: true });
          state.qaEnv[svc] = r.includes(`"${pid}"`);
        } catch {}
      }
    }
  } catch {}
  // QA Remote state
  try {
    const remoteStateFile = path.join(ROOT, 'qa', '.qa-remote-state');
    if (fs.existsSync(remoteStateFile)) {
      const lines = fs.readFileSync(remoteStateFile, 'utf8').split('\n');
      for (const line of lines) {
        const [k, ...vParts] = line.split('=');
        const v = vParts.join('=').trim();
        if (k === 'QA_MODE' && v === 'remote') state.qaRemote.active = true;
        if (k === 'QA_REMOTE_URL') state.qaRemote.url = v;
        if (k === 'DEPLOY_REF') state.qaRemote.ref = v;
        if (k === 'STARTED_AT') state.qaRemote.startedAt = v;
      }
    }
  } catch {}

  // Priority Windows (estado persistido por el Pulpo)
  state.priorityWindows = { qa: { active: false }, build: { active: false } };
  try {
    const pwData = JSON.parse(fs.readFileSync(path.join(PIPELINE, 'priority-windows.json'), 'utf8'));
    if (pwData.qa) state.priorityWindows.qa = pwData.qa;
    if (pwData.build) state.priorityWindows.build = pwData.build;
  } catch {}

  // Rechazos recientes
  state.rechazos = [];
  for (const { pipeline: pName, fase } of allFases) {
    const procesadoDir = path.join(PIPELINE, pName, fase, 'procesado');
    for (const f of listWorkFiles(procesadoDir)) {
      const data = readYamlSafe(path.join(procesadoDir, f));
      if (data.resultado === 'rechazado') {
        const stat = fileStat(path.join(procesadoDir, f));
        state.rechazos.push({
          issue: f.split('.')[0], skill: f.split('.').slice(1).join('.'),
          fase, pipeline: pName, motivo: data.motivo || '',
          ts: stat?.mtimeMs || 0
        });
      }
    }
  }
  state.rechazos.sort((a, b) => b.ts - a.ts);
  state.rechazos = state.rechazos.slice(0, 10);

  // Recursos del sistema
  const resourceLimits = config.resource_limits || {};
  state.resources = {
    ...getSystemResourceUsage(),
    maxCpu: resourceLimits.max_cpu_percent || 70,
    maxMem: resourceLimits.max_mem_percent || 70
  };

  return state;
}

// --- HTML generation ---

function generateHTML(state) {
  const config = state.config;
  const allFases = state.allFases;
  const GH = (num) => `${GITHUB_BASE}/${num}`;

  // Build timestamps para el encabezado
  const fmtDate = (filepath) => {
    try {
      const st = fs.statSync(filepath);
      return st.mtime.toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch { return '—'; }
  };
  const dashboardBuild = fmtDate(path.join(PIPELINE, 'dashboard-v2.js'));
  const pulpoBuild = fmtDate(path.join(PIPELINE, 'pulpo.js'));

  // Agentes con personalidad — referentes del mercado
  const AGENT_PERSONA = {
    guru:          { icon: '🧠', name: 'Guru',        tagline: 'Rich Hickey · Kevlin Henney · Kleppmann', color: '#bc8cff' },
    security:      { icon: '🔒', name: 'Security',    tagline: 'Troy Hunt · Bruce Schneier · OWASP',      color: '#f85149' },
    po:            { icon: '📋', name: 'PO',           tagline: 'Marty Cagan · Teresa Torres · Jeff Patton', color: '#d29922' },
    ux:            { icon: '🎨', name: 'UX',           tagline: 'Don Norman · Jakob Nielsen · Wroblewski',  color: '#f778ba' },
    planner:       { icon: '📐', name: 'Planner',     tagline: 'Ryan Singer · Allen Ward · Reinertsen',    color: '#a371f7' },
    'backend-dev': { icon: '⚡', name: 'BackendDev',  tagline: 'Martin Fowler · Uncle Bob · Sam Newman',   color: '#3fb950' },
    'android-dev': { icon: '📱', name: 'AndroidDev',  tagline: 'Jake Wharton · Romain Guy · Chet Haase',   color: '#58a6ff' },
    'web-dev':     { icon: '🌐', name: 'WebDev',      tagline: 'Addy Osmani · Alex Russell · Archibald',   color: '#79c0ff' },
    tester:        { icon: '🧪', name: 'Tester',      tagline: 'Kent Beck · Meszaros · Martin Fowler',     color: '#d2a8ff' },
    qa:            { icon: '✅', name: 'QA',           tagline: 'James Bach · Lisa Crispin · Bolton',       color: '#3fb950' },
    review:        { icon: '👁️', name: 'Review',      tagline: 'Michaela Greiler · Google Eng Practices',  color: '#ffa657' },
    delivery:      { icon: '🚀', name: 'Delivery',    tagline: 'Jez Humble · Dave Farley �� Forsgren',      color: '#f0883e' },
    scrum:         { icon: '📊', name: 'Scrum',       tagline: 'Sutherland · Vacanti · Mike Cohn',         color: '#79c0ff' },
    perf:          { icon: '⚡', name: 'Perf',         tagline: 'Brendan Gregg · Colt McAnlis · Wharton',   color: '#d29922' },
    build:         { icon: '🏗️', name: 'Builder',     tagline: 'Build pipeline',                           color: '#8b949e' },
    hotfix:        { icon: '🔥', name: 'Hotfix',      tagline: 'Emergency fix',                            color: '#f85149' },
    commander:     { icon: '🤖', name: 'Commander',   tagline: 'Pipeline orchestrator',                    color: '#8b949e' },
  };
  const skillIcon = (skill) => (AGENT_PERSONA[skill] || {}).icon || '⚙';
  const skillColor = (skill) => (AGENT_PERSONA[skill] || {}).color || 'var(--dim)';

  // KPIs
  const matrixEntries = Object.entries(state.issueMatrix);
  const activosList = matrixEntries.filter(([_, d]) => d.estadoActual);
  const activos = activosList.length;
  const totalIssues = matrixEntries.length;
  const trabajandoList = matrixEntries.filter(([_, d]) => d.estadoActual === 'trabajando');
  const trabajando = trabajandoList.length;
  const pendientesList = matrixEntries.filter(([_, d]) => d.estadoActual === 'pendiente');
  const pendientes = pendientesList.length;
  const staleList = matrixEntries.filter(([_, d]) => {
    if (d.estadoActual !== 'trabajando' || !d.faseActual) return false;
    const entries = d.fases[d.faseActual] || [];
    return entries.some(e => e.ageMin > 30);
  });
  const stale = staleList.length;
  const staleDetail = staleList.map(([id, d]) => {
    const entries = d.fases[d.faseActual] || [];
    const staleEntry = entries.find(e => e.estado === 'trabajando' && e.ageMin > 30);
    const skill = staleEntry ? staleEntry.skill : d.faseActual;
    const mins = staleEntry ? staleEntry.ageMin : '?';
    return `#${id} (${skill}, ${mins} min)`;
  }).join(', ');

  // Helpers para tooltips (JSON embebido, el HTML lo arma el cliente)
  const buildTtData = (title, list, labelFn) => {
    const items = list.map(([id, d]) => ({ id, label: labelFn ? labelFn(id, d) : '' }));
    return JSON.stringify({ title, items }).replace(/'/g, '&#39;');
  };
  // Extraer skills activos de un issue en su fase actual
  const activeSkills = (d) => {
    if (!d.faseActual) return '';
    const entries = d.fases[d.faseActual] || [];
    const skills = entries.filter(e => e.estado === 'trabajando' || e.estado === 'pendiente').map(e => e.skill);
    return skills.length > 0 ? skills.join(', ') : '';
  };
  const ttLabel = (d) => {
    const parts = [];
    if (d.faseActual) parts.push(d.faseActual);
    const skills = activeSkills(d);
    if (skills) parts.push(skills);
    if (d.estadoActual) parts.push(d.estadoActual);
    return parts.join(' · ');
  };
  const ttActivos   = buildTtData('Issues activos',       activosList,   (_, d) => ttLabel(d));
  const ttTrabajando= buildTtData('En ejecución',          trabajandoList,(_, d) => ttLabel(d));
  const ttPendientes= buildTtData('En cola',               pendientesList,(_, d) => ttLabel(d));
  const ttStale     = buildTtData('Bloqueados / stale',    staleList,     (_, d) => ttLabel(d));

  // Definidos = completaron la fase final de definición (sizing/procesado)
  const defFasesKpi = config.pipelines?.definicion?.fases || [];
  const lastDefFase = defFasesKpi[defFasesKpi.length - 1];
  const definidosList = lastDefFase ? matrixEntries.filter(([_, d]) => {
    const entries = d.fases[`definicion/${lastDefFase}`] || [];
    return entries.some(e => e.estado === 'procesado');
  }) : [];
  const definidos = definidosList.length;

  // Entregados = completaron la fase final de desarrollo (entrega/procesado)
  const devFasesKpi = config.pipelines?.desarrollo?.fases || [];
  const lastDevFase = devFasesKpi[devFasesKpi.length - 1];
  const entregadosList = lastDevFase ? matrixEntries.filter(([_, d]) => {
    const entries = d.fases[`desarrollo/${lastDevFase}`] || [];
    return entries.some(e => e.estado === 'procesado');
  }) : [];
  const entregados = entregadosList.length;

  const ttDefinidos  = buildTtData('Definidos listos',        definidosList, (_, d) => {
    const label = ttLabel(d);
    return label || 'definición completada';
  });
  const ttEntregados = buildTtData('Entregados a producción',  entregadosList, (_, d) => {
    // Para entregados, buscar el skill que hizo la entrega
    const entregaEntries = d.fases[`desarrollo/${lastDevFase}`] || [];
    const proc = entregaEntries.find(e => e.estado === 'procesado');
    const skill = proc?.skill || '';
    const label = ttLabel(d);
    return skill ? `${skill}` + (label ? ` · ${label}` : '') : (label || 'entregado');
  });

  // --- Issue Tracker Matrix (unified) ---
  // Headers: definición phases | separator | desarrollo phases
  const defFases = config.pipelines?.definicion?.fases || [];
  const devFases = config.pipelines?.desarrollo?.fases || [];

  // Contadores por fase: pendiente/trabajando/listo con lista de issues
  const faseCounts = {};
  for (const { pipeline: pName, fase } of allFases) {
    const key = `${pName}/${fase}`;
    faseCounts[key] = { pendiente: [], trabajando: [], listo: [] };
  }
  for (const [issueNum, data] of matrixEntries) {
    for (const [key, entries] of Object.entries(data.fases)) {
      if (!faseCounts[key]) continue;
      for (const e of entries) {
        if (e.estado === 'pendiente' || e.estado === 'trabajando' || e.estado === 'listo') {
          if (!faseCounts[key][e.estado].includes(issueNum)) {
            faseCounts[key][e.estado].push(issueNum);
          }
        }
      }
    }
  }

  // Generar header con badges y tooltips por fase
  const faseHeader = (f, pName, thClass) => {
    const key = `${pName}/${f}`;
    const c = faseCounts[key] || { pendiente: [], trabajando: [], listo: [] };
    const total = c.pendiente.length + c.trabajando.length + c.listo.length;
    if (total === 0) return `<th class="${thClass}">${f}</th>`;

    const badge = (list, icon, cls) => {
      if (list.length === 0) return '';
      const ttData = JSON.stringify({ title: `${f} — ${cls}`, items: list.map(id => ({ id })) }).replace(/'/g, '&#39;');
      return `<span class="fase-badge fase-${cls}" data-fase-tt='${ttData}'>${icon}${list.length}</span>`;
    };

    const badges = [
      badge(c.pendiente, '○', 'pendiente'),
      badge(c.trabajando, '⚙', 'trabajando'),
      badge(c.listo, '✓', 'listo')
    ].join('');

    return `<th class="${thClass}">${f}<div class="fase-badges">${badges}</div></th>`;
  };

  const headerCells = [
    ...defFases.map(f => faseHeader(f, 'definicion', 'th-def')),
    ...devFases.map(f => faseHeader(f, 'desarrollo', 'th-dev'))
  ].join('');

  const groupHeader = `<tr class="group-header">
    <th></th>
    <th colspan="${defFases.length}" class="group-def">DEFINICIÓN</th>
    <th colspan="${devFases.length}" class="group-dev">DESARROLLO</th>
  </tr>`;

  // Sort: issues incompletos primero (trabajando > pendiente > listo entre ellos),
  // luego finalizados. Dentro del mismo grupo, más avanzados en pipeline primero.
  const faseIndex = (data) => {
    if (!data.faseActual) return -1;
    return allFases.findIndex(f => `${f.pipeline}/${f.fase}` === data.faseActual);
  };
  const isComplete = (data) => {
    // Un issue está completo si todas sus fases están en listo/procesado (sin pendiente/trabajando)
    const hasAnyActive = allFases.some(({ pipeline, fase }) => {
      const entries = data.fases[`${pipeline}/${fase}`] || [];
      return entries.some(e => e.estado === 'pendiente' || e.estado === 'trabajando');
    });
    if (hasAnyActive) return false;
    // Además debe tener al menos la última fase de desarrollo como listo/procesado
    const lastDev = devFases[devFases.length - 1];
    const lastEntries = data.fases[`desarrollo/${lastDev}`] || [];
    return lastEntries.some(e => e.estado === 'listo' || e.estado === 'procesado');
  };
  const sorted = matrixEntries.sort((a, b) => {
    const aComplete = isComplete(a[1]);
    const bComplete = isComplete(b[1]);
    // Incompletos siempre arriba de completos
    if (aComplete !== bComplete) return aComplete ? 1 : -1;
    // Dentro del mismo grupo, ordenar por estado
    const order = { trabajando: 0, pendiente: 1, listo: 2 };
    const aO = a[1].estadoActual ? (order[a[1].estadoActual] ?? 3) : 4;
    const bO = b[1].estadoActual ? (order[b[1].estadoActual] ?? 3) : 4;
    if (aO !== bO) return aO - bO;
    // Dentro del mismo estado, los más avanzados en el pipeline primero
    const aF = faseIndex(a[1]);
    const bF = faseIndex(b[1]);
    if (aF !== bF) return bF - aF;
    return parseInt(b[0]) - parseInt(a[0]);
  });

  // Show all issues, but only first 5 visible by default
  const ISSUE_VISIBLE_LIMIT = 5;
  let rows = '';
  let rowIndex = 0;
  for (const [issueNum, data] of sorted) {
    // Progress bar
    const totalFases = defFases.length + devFases.length;
    const completedFases = allFases.filter(({ pipeline, fase }) => {
      const entries = data.fases[`${pipeline}/${fase}`] || [];
      const hasPendingOrWorking = entries.some(e => e.estado === 'pendiente' || e.estado === 'trabajando');
      return !hasPendingOrWorking && entries.some(e => e.estado === 'listo' || e.estado === 'procesado');
    }).length;
    const pct = totalFases > 0 ? Math.round(completedFases / totalFases * 100) : 0;

    // ETA por issue: suma de promedios de fases pendientes (independiente de agentes activos)
    let issueEtaMs = 0;
    let hasEta = false;
    for (const pipeline of ['definicion', 'desarrollo']) {
      const fasesList = pipeline === 'definicion' ? defFases : devFases;
      for (const faseName of fasesList) {
        const key = `${pipeline}/${faseName}`;
        const entries = data.fases[key] || [];
        const hasPendingOrWorking = entries.some(e => e.estado === 'pendiente' || e.estado === 'trabajando');
        const isDone = !hasPendingOrWorking && entries.some(e => e.estado === 'listo' || e.estado === 'procesado');
        if (isDone) continue; // Fase completada sin trabajo pendiente, no sumar

        const isWorking = entries.some(e => e.estado === 'trabajando');
        if (isWorking) {
          // Fase en curso: ETA = promedio - tiempo transcurrido
          const workingEntry = entries.find(e => e.estado === 'trabajando');
          const avgKey = `${faseName}/${workingEntry.skill}`;
          const avg = state.etaAverages[avgKey] || state.etaAverages[faseName];
          if (avg?.avgMs && workingEntry.durationMs) {
            issueEtaMs += Math.max(0, avg.avgMs - workingEntry.durationMs);
            hasEta = true;
          }
        } else {
          // Fase pendiente o no iniciada: sumar promedio completo
          const avg = state.etaAverages[faseName];
          if (avg?.avgMs) {
            issueEtaMs += avg.avgMs;
            hasEta = true;
          }
        }
      }
    }
    // Para issues completados: calcular duración total real
    let issueEtaLabel = '';
    if (hasEta && issueEtaMs > 0) {
      issueEtaLabel = `<span class="issue-eta" title="ETA estimado para completar fases restantes">⏱ ~${fmtDuration(issueEtaMs)}</span>`;
    } else if (pct === 100) {
      // Issue completado: calcular duración total desde timestamps
      let minTs = Infinity, maxTs = 0;
      for (const entries of Object.values(data.fases)) {
        for (const e of entries) {
          if (e.startedAt && e.startedAt < minTs) minTs = e.startedAt;
          if (e.updatedAt && e.updatedAt > maxTs) maxTs = e.updatedAt;
        }
      }
      if (maxTs > minTs && minTs < Infinity) {
        issueEtaLabel = `<span class="issue-eta issue-done-time" title="Tiempo total de completación">✓ ${fmtDuration(maxTs - minTs)}</span>`;
      }
    }

    const issueCell = `<td class="issue-col">
      <a href="${GH(issueNum)}" target="_blank" class="issue-link">#${issueNum}</a>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
      <span class="progress-text">${completedFases}/${totalFases}</span>${issueEtaLabel}
    </td>`;

    let cells = '';
    for (const { pipeline, fase } of allFases) {
      const key = `${pipeline}/${fase}`;
      const entries = data.fases[key] || [];
      const isCurrent = data.faseActual === key;

      if (entries.length === 0) {
        cells += `<td class="cell-empty ${pipeline === 'definicion' ? 'col-def' : 'col-dev'}">—</td>`;
        continue;
      }

      // Detectar skills repetidos para mostrar índice y diferenciar runs anteriores
      const skillRunCount = {};
      for (const e of entries) {
        skillRunCount[e.skill] = (skillRunCount[e.skill] || 0) + 1;
      }
      // Asignar índice por orden de aparición (más viejo primero)
      const skillRunIndex = {};
      const sortedEntries = [...entries].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
      for (const e of sortedEntries) {
        skillRunIndex[e.skill] = (skillRunIndex[e.skill] || 0) + 1;
        e._runIndex = skillRunIndex[e.skill];
        e._runTotal = skillRunCount[e.skill];
        e._isRetry = skillRunCount[e.skill] > 1;
        e._isLatestRun = skillRunIndex[e.skill] === skillRunCount[e.skill];
      }

      const chips = entries.map(e => {
        // Estado rechazado: resultado explícito de rechazo
        const isRejected = e.resultado && e.resultado !== 'aprobado';

        const cls = isRejected ? 'st-rejected' :
                    e.estado === 'trabajando' ? 'st-working' :
                    e.estado === 'listo' ? 'st-done' :
                    e.estado === 'procesado' ? 'st-processed' : 'st-pending';
        const icon = isRejected ? '✗' :
                     e.estado === 'trabajando' ? '⚙' :
                     e.estado === 'listo' ? '✓' :
                     e.estado === 'procesado' ? '✔' : '○';
        const staleClass = (e.estado === 'trabajando' && e.ageMin > 30) ? ' stale-chip' : '';
        // Runs anteriores de un skill repetido se muestran compactos
        const priorClass = (e._isRetry && !e._isLatestRun) ? ' chip-prior' : '';
        const runLabel = e._isRetry ? `<sup class="run-idx">${e._runIndex}</sup>` : '';

        // ETA por agente activo
        let etaBadge = '';
        let ttEta = '';
        if (e.estado === 'trabajando' && e.durationMs) {
          const avgKey = `${fase}/${e.skill}`;
          const avg = state.etaAverages[avgKey] || state.etaAverages[fase];
          if (avg?.avgMs) {
            const remaining = Math.max(0, avg.avgMs - e.durationMs);
            if (remaining > 0) {
              etaBadge = `<span class="eta-badge">~${fmtDuration(remaining)}</span>`;
              ttEta = `ETA: ~${fmtDuration(remaining)} (promedio: ${fmtDuration(avg.avgMs)})`;
            } else {
              const over = e.durationMs - avg.avgMs;
              etaBadge = `<span class="eta-badge eta-over">+${fmtDuration(over)}</span>`;
              ttEta = `Excedido: +${fmtDuration(over)} sobre promedio de ${fmtDuration(avg.avgMs)}`;
            }
          }
        }

        // Tooltip content
        const ttStart = e.startedAt ? `Inicio: ${fmtTime(e.startedAt)}` : '';
        const ttDur = e.durationMs ? `Duración: ${fmtDuration(e.durationMs)}` : '';
        const ttRes = e.resultado ? `Resultado: ${e.resultado === 'aprobado' ? '✓' : '✗'} ${e.resultado}` : '';
        const ttMot = e.motivo ? `Motivo: ${e.motivo.slice(0, 80)}` : '';
        const ttRun = e._isRetry ? `Ejecución: ${e._runIndex}/${e._runTotal}` : '';
        const ttLines = [e.skill, ttRun, ttStart, ttDur, ttEta, ttRes, ttMot].filter(Boolean);
        const tooltip = `<span class="tt">${ttLines.map(l => `<span>${l}</span>`).join('')}</span>`;

        // Prior runs: solo ícono + índice (sin nombre del skill)
        const agentColor = skillColor(e.skill);
        const chipContent = (e._isRetry && !e._isLatestRun)
          ? `${icon} ${skillIcon(e.skill)}${runLabel}`
          : `${icon} ${skillIcon(e.skill)} ${e.skill}${runLabel}${etaBadge}`;

        // Botón de cancelar para agentes activos (trabajando)
        const killBtn = e.estado === 'trabajando'
          ? `<span class="kill-btn" title="Cancelar agente" onclick="event.preventDefault();event.stopPropagation();killAgent('${issueNum}','${e.skill}','${pipeline}','${fase}')">&times;</span>`
          : '';

        // Wrap in link if log exists
        const inner = `<span class="chip ${cls}${staleClass}${priorClass}">${chipContent}${killBtn}${tooltip}</span>`;
        if (e.hasLog) {
          const isLive = e.estado === 'trabajando';
          return `<a href="/logs/${e.logFile}" class="log-link" onclick="event.preventDefault();openLogViewer('${e.logFile}','#${issueNum} ${e.skill}',${isLive})">${inner}</a>`;
        }
        return inner;
      }).join(' ');

      cells += `<td class="${isCurrent ? 'cell-current' : ''} ${pipeline === 'definicion' ? 'col-def' : 'col-dev'}">${chips}</td>`;
    }

    const rowClass = data.estadoActual ? `issue-${data.estadoActual}` : 'issue-done';
    const hiddenClass = rowIndex >= ISSUE_VISIBLE_LIMIT ? ' issue-overflow' : '';
    rows += `<tr class="${rowClass}${hiddenClass}">${issueCell}${cells}</tr>`;
    rowIndex++;
  }

  const hiddenCount = sorted.length - ISSUE_VISIBLE_LIMIT;
  const verMasBtn = hiddenCount > 0
    ? `<div class="ver-mas-container"><button class="ver-mas-btn" onclick="toggleIssues(this)">Ver más (${hiddenCount} issues)</button></div>`
    : '';

  const matrixHTML = `
    <div class="matrix-section">
      <div class="matrix-header">
        <h2>📊 Issue Tracker</h2>
        <span class="matrix-count">${activos} activos · ${totalIssues - activos} finalizados</span>
      </div>
      <div class="matrix-scroll">
        <table class="issue-matrix">
          <thead>${groupHeader}<tr><th class="th-issue">Issue</th>${headerCells}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${verMasBtn}
    </div>`;

  // Skill capacity — versión reducida: solo activos/parciales, idle como resumen
  // Calcular frecuencia de uso de cada skill en el issue tracker
  const skillUsageCount = {};
  for (const [, data] of matrixEntries) {
    for (const [, faseEntries] of Object.entries(data.fases || {})) {
      for (const e of faseEntries) {
        skillUsageCount[e.skill] = (skillUsageCount[e.skill] || 0) + 1;
      }
    }
  }
  // Ordenar: 1) más agentes activos (running desc), 2) más usados históricamente (usage desc)
  const skillEntries = Object.entries(state.skillLoad)
    .sort((a, b) => {
      const diff = b[1].running - a[1].running;
      if (diff !== 0) return diff;
      return (skillUsageCount[b[0]] || 0) - (skillUsageCount[a[0]] || 0);
    });
  // Mostrar activos/parciales + llenar con idle hasta MAX_CAP_VISIBLE
  // Sin agentes activos ni servicios en Equipo → más espacio para skills
  const hasActiveAgents = Object.values(state.skillLoad).some(l => l.running > 0);
  const MAX_CAP_VISIBLE = hasActiveAgents ? 6 : 12;
  let heatmapHTML = '';
  let shownCount = 0;
  const idleSkills = [];
  for (const [skill, load] of skillEntries) {
    const pct = load.max > 0 ? load.running / load.max : 0;
    const cls = pct >= 1 ? 'load-full' : pct > 0 ? 'load-partial' : 'load-idle';
    if (cls === 'load-idle') { idleSkills.push([skill, load]); continue; }
    const p = AGENT_PERSONA[skill] || { icon: '⚙', name: skill, color: 'var(--dim2)' };
    const barPct = Math.round(pct * 100);
    const countLabel = pct >= 1
      ? `<span style="color:var(--rd);font-weight:700">${load.running}/${load.max}</span>`
      : `${load.running}/${load.max}`;
    heatmapHTML += `<div class="skill-cap-chip ${cls}" style="--agent-color:${p.color}" title="${skill}: ${load.running}/${load.max}">
      <span class="skill-cap-icon">${p.icon}</span>
      <span class="skill-cap-name">${p.name || skill}</span>
      <span class="skill-cap-bar"><span class="skill-cap-fill" style="width:${barPct}%"></span></span>
      <span class="skill-cap-count">${countLabel}</span>
    </div>`;
    shownCount++;
  }
  // Llenar slots restantes con idle más relevantes (por uso histórico)
  const idleSlots = Math.max(0, MAX_CAP_VISIBLE - shownCount);
  const shownIdle = idleSkills.slice(0, idleSlots);
  const hiddenIdle = idleSkills.length - shownIdle.length;
  for (const [skill, load] of shownIdle) {
    const p = AGENT_PERSONA[skill] || { icon: '⚙', name: skill, color: 'var(--dim2)' };
    heatmapHTML += `<div class="skill-cap-chip load-idle" style="--agent-color:${p.color}" title="${skill}: 0/${load.max}">
      <span class="skill-cap-icon">${p.icon}</span>
      <span class="skill-cap-name">${p.name || skill}</span>
      <span class="skill-cap-bar"><span class="skill-cap-fill" style="width:0%"></span></span>
      <span class="skill-cap-count">0/${load.max}</span>
    </div>`;
  }
  if (hiddenIdle > 0) {
    heatmapHTML += `<span class="skill-idle-summary" title="${hiddenIdle} skills más sin carga">+${hiddenIdle} más</span>`;
  }

  // Servicios agrupados + procesos standalone
  const fmtStat = (n) => n > 99 ? `<span title="${n}">99+</span>` : `${n}`;
  const SERVICE_GROUPS = [
    { name: 'Telegram', icon: '📨', queues: ['commander', 'telegram'], processes: ['listener', 'svc-telegram'] },
    { name: 'GitHub', icon: '🐙', queues: ['github'], processes: ['svc-github'] },
    { name: 'Drive', icon: '📁', queues: ['drive'], processes: ['svc-drive'] },
  ];
  const STANDALONE_PROCESSES = ['pulpo', 'outbox-drain', 'dashboard'];
  const groupedProcesses = new Set(SERVICE_GROUPS.flatMap(g => g.processes));
  const groupedQueues = new Set(SERVICE_GROUPS.flatMap(g => g.queues));

  let svcCardsHTML = '';
  for (const group of SERVICE_GROUPS) {
    // Aggregate queue stats
    let totalPend = 0, totalWork = 0, totalDone = 0;
    for (const q of group.queues) {
      const d = state.servicios[q];
      if (d) { totalPend += d.pendiente; totalWork += d.trabajando; totalDone += d.listo; }
    }
    // Check if any process in group is alive
    const anyAlive = group.processes.some(p => state.procesos[p]?.alive);
    const anyDead = group.processes.some(p => !state.procesos[p]?.alive);
    const groupStatus = totalWork > 0 ? 'svc-card-busy' : anyAlive ? 'svc-card-ok' : 'svc-card-dead';

    // Group-level start/stop: starts or stops all processes in the group
    const allAlive = group.processes.every(p => state.procesos[p]?.alive);
    const groupBtn = allAlive
      ? `<button class="ctl-btn ctl-stop" onclick="${group.processes.map(p => `ctlAction('${p}','stop')`).join(';')}" title="Detener ${group.name}">■</button>`
      : `<button class="ctl-btn ctl-start" onclick="${group.processes.map(p => `ctlAction('${p}','start')`).join(';')}" title="Iniciar ${group.name}">▶</button>`;

    // Sub-process indicators
    const subProcs = group.processes.map(p => {
      const info = state.procesos[p] || { pid: null, alive: false };
      const dot = info.alive ? '🟢' : '🔴';
      const label = p.replace('svc-', 'SBC ').replace('listener', 'Listener');
      return `<span class="svc-group-proc" title="${label}: ${info.alive ? 'PID ' + info.pid : 'detenido'}">${dot} ${label}</span>`;
    }).join('');

    // Queue detail tooltips
    const queueDetail = group.queues.map(q => {
      const d = state.servicios[q];
      if (!d) return '';
      return `${q}: ○${d.pendiente} ⚙${d.trabajando} ✓${d.listo}`;
    }).join(' | ');

    svcCardsHTML += `<div class="svc-card svc-card-group ${groupStatus}">
      <div class="svc-card-header">
        ${groupBtn}<span class="svc-card-name">${group.icon} ${group.name}</span>
        ${anyAlive ? '<span class="svc-card-pulse"></span>' : ''}
      </div>
      <div class="svc-card-stats" title="${queueDetail}">
        <span class="svc-stat" title="Pendiente: ${totalPend}">○${fmtStat(totalPend)}</span>
        <span class="svc-stat svc-stat-work" title="Trabajando: ${totalWork}">⚙${fmtStat(totalWork)}</span>
        <span class="svc-stat svc-stat-done" title="Listo: ${totalDone}">✓${fmtStat(totalDone)}</span>
      </div>
      <div class="svc-group-procs">${subProcs}</div>
    </div>`;
  }
  // Standalone processes (not in any group)
  for (const name of STANDALONE_PROCESSES) {
    const info = state.procesos[name] || { pid: null, alive: false };
    const alive = info.alive;
    const statusCls = alive ? 'svc-card-ok' : 'svc-card-dead';
    const isDashboard = name === 'dashboard';
    const btn = isDashboard ? '' :
      alive
        ? `<button class="ctl-btn ctl-stop" onclick="ctlAction('${name}','stop')" title="Detener ${name}">■</button>`
        : `<button class="ctl-btn ctl-start" onclick="ctlAction('${name}','start')" title="Iniciar ${name}">▶</button>`;
    svcCardsHTML += `<div class="svc-card ${statusCls}">
      <div class="svc-card-header">
        ${btn}<span class="svc-card-name">${name}</span>
        ${alive ? '<span class="svc-card-pulse"></span>' : ''}
      </div>
      ${info.pid && alive ? '<div class="svc-card-pid">PID ' + info.pid + '</div>' : '<div class="svc-card-pid">detenido</div>'}
    </div>`;
  }

  // System Resources (CPU + RAM gauges)
  const res = state.resources;
  const cpuCls = res.cpuPercent >= res.maxCpu ? 'gauge-danger' : res.cpuPercent >= res.maxCpu * 0.8 ? 'gauge-warn' : 'gauge-ok';
  const memCls = res.memPercent >= res.maxMem ? 'gauge-danger' : res.memPercent >= res.maxMem * 0.8 ? 'gauge-warn' : 'gauge-ok';
  const blocked = res.cpuPercent >= res.maxCpu || res.memPercent >= res.maxMem;
  const resourcesHTML = `
    <div class="gauge-row">
      <div class="gauge ${cpuCls}">
        <div class="gauge-label">CPU</div>
        <div class="gauge-bar"><div class="gauge-fill" style="width:${Math.min(res.cpuPercent, 100)}%"></div><div class="gauge-threshold" style="left:${res.maxCpu}%"></div></div>
        <div class="gauge-value">${res.cpuPercent}% <span class="gauge-detail">${res.cpuCores} cores · max ${res.maxCpu}%</span></div>
      </div>
      <div class="gauge ${memCls}">
        <div class="gauge-label">RAM</div>
        <div class="gauge-bar"><div class="gauge-fill" style="width:${Math.min(res.memPercent, 100)}%"></div><div class="gauge-threshold" style="left:${res.maxMem}%"></div></div>
        <div class="gauge-value">${res.memPercent}% <span class="gauge-detail">${res.memUsedGB}/${res.memTotalGB} GB · max ${res.maxMem}%</span></div>
      </div>
    </div>
    ${blocked ? '<div class="resource-alert">⛔ Lanzamiento bloqueado por sobrecarga del sistema</div>' : ''}
    ${stale > 0 ? `<div class="resource-alert">⚠️ ${stale} issue${stale > 1 ? 's' : ''} con más de 30 min trabajando — posible huérfano: ${staleDetail}</div>` : ''}`;

  // Emulador Android — integrado como servicio más en svcCardsHTML
  const qaRemoteActive = state.qaRemote && state.qaRemote.active;
  if (qaRemoteActive) {
    svcCardsHTML += `<div class="svc-card svc-card-ok" style="background: linear-gradient(135deg, #0984e3 0%, #6c5ce7 100%); color: white;">
      <div class="svc-card-header">
        <span class="svc-card-name">\u2601\uFE0F QA Remoto</span>
        <span class="svc-card-pulse"></span>
      </div>
      <div class="svc-card-pid" style="color: rgba(255,255,255,0.9);">${state.qaRemote.ref || 'Lambda AWS'}</div>
    </div>`;
  } else {
    Object.entries(state.qaEnv).forEach(([name, alive]) => {
      const statusCls = alive ? 'svc-card-ok' : 'svc-card-dead';
      const btn = alive
        ? `<button class="ctl-btn ctl-stop" onclick="qaComponentAction('${name}','stop')" title="Detener Emulador">■</button>`
        : `<button class="ctl-btn ctl-start" onclick="qaComponentAction('${name}','start')" title="Iniciar Emulador">▶</button>`;
      svcCardsHTML += `<div class="svc-card ${statusCls}">
        <div class="svc-card-header">
          ${btn}<span class="svc-card-name">\u{1F4F1} Emulador</span>
          ${alive ? '<span class="svc-card-pulse"></span>' : ''}
        </div>
        <div class="svc-card-pid">${alive ? 'activo' : 'detenido'}</div>
      </div>`;
    });
  }

  // Rechazos recientes
  let rechazosHTML = '';
  if (state.rechazos.length > 0) {
    rechazosHTML = state.rechazos.map(r => {
      const ts = fmtTime(r.ts);
      return `<div class="rechazo-row">✗ <a href="${GH(r.issue)}" target="_blank" class="issue-link">#${r.issue}</a> ${r.skill} en ${r.fase} — <span class="rechazo-motivo">${(r.motivo || '').slice(0, 80)}</span> <span class="ts">${ts}</span></div>`;
    }).join('');
  }

  // Actividad
  // --- Agent Team: agentes activos con personalidad ---
  const activeAgents = {};
  for (const [issueNum, data] of matrixEntries) {
    if (!data.faseActual) continue;
    const entries = data.fases[data.faseActual] || [];
    for (const e of entries) {
      if (e.estado === 'trabajando') {
        if (!activeAgents[e.skill]) activeAgents[e.skill] = [];
        activeAgents[e.skill].push({ issue: issueNum, fase: data.faseActual.split('/')[1], duration: e.durationMs });
      }
    }
  }

  let agentTeamCards = '';
  if (Object.keys(activeAgents).length > 0) {
    for (const [skill, issues] of Object.entries(activeAgents)) {
      const p = AGENT_PERSONA[skill] || { icon: '⚙', name: skill, tagline: '', color: 'var(--dim)' };
      const issueChips = issues.map(i =>
        `<a href="${GH(i.issue)}" target="_blank" class="agent-issue">#${i.issue} <span class="agent-issue-fase">${i.fase}</span> <span class="agent-issue-dur">${fmtDuration(i.duration)}</span></a>`
      ).join('');
      agentTeamCards += `
        <div class="agent-card" style="--agent-color:${p.color}">
          <div class="agent-avatar">${p.icon}</div>
          <div class="agent-info">
            <div class="agent-name">${p.name}</div>
            <div class="agent-issues">${issueChips}</div>
          </div>
          <div class="agent-pulse"></div>
        </div>`;
    }
  }

  // agentTeamCards se usa inline en la sección "Equipo y Skills"

  // --- Mini DORA metrics on main dashboard ---
  let doraMinHTML = '';
  try {
    const metricsData = getMetricsData();
    const { entregas: doraEntregas, totalProcessed: doraTP, totalRejected: doraRej, etaAverages: doraEta } = metricsData;
    const doraDelivered7d = doraEntregas.filter(e => Date.now() - e.ts < 7 * 86400000).length;
    const doraThroughput = (doraDelivered7d / 7).toFixed(1);
    const doraFailRate = doraTP > 0 ? Math.round(doraRej / doraTP * 100) : 0;
    // Lead time: promedio de duración completa de issues entregados en los últimos 7 días
    const recentDeliveries = doraEntregas.filter(e => Date.now() - e.ts < 7 * 86400000);
    let doraLeadTime = 0;
    if (recentDeliveries.length > 0) {
      // Estimar lead time sumando promedios de fases
      let totalAvg = 0;
      for (const [key, data] of Object.entries(doraEta)) {
        if (!key.includes('/') && data.avgMs) totalAvg += data.avgMs;
      }
      doraLeadTime = totalAvg;
    }

    const ltColor = doraLeadTime > 0 && doraLeadTime < 6 * 3600000 ? 'var(--gn)' : doraLeadTime > 0 ? 'var(--yl)' : 'var(--dim)';
    const tpColor = parseFloat(doraThroughput) >= 2 ? 'var(--gn)' : parseFloat(doraThroughput) > 0 ? 'var(--yl)' : 'var(--dim)';
    const frColor = doraFailRate <= 15 ? 'var(--gn)' : doraFailRate <= 30 ? 'var(--yl)' : 'var(--rd)';

    doraMinHTML = `
    <div class="dora-mini">
      <div class="matrix-header">
        <h2>📐 DORA Metrics <span style="font-size:0.7em;color:var(--dim);text-transform:none;letter-spacing:0">(rolling 7d · Nicole Forsgren)</span></h2>
        <a href="/metrics#dora" class="matrix-count" style="text-decoration:none">Ver detalle →</a>
      </div>
      <div class="dora-mini-grid">
        <div class="dora-mini-card">
          <div class="dora-mini-value" style="color:${ltColor}">${doraLeadTime > 0 ? fmtDuration(doraLeadTime) : '—'}</div>
          <div class="dora-mini-label">Lead Time</div>
          <div class="dora-mini-target">target &lt; 6h</div>
        </div>
        <div class="dora-mini-card">
          <div class="dora-mini-value" style="color:${tpColor}">${doraThroughput}/d</div>
          <div class="dora-mini-label">Throughput</div>
          <div class="dora-mini-target">target &gt; 2/día</div>
        </div>
        <div class="dora-mini-card">
          <div class="dora-mini-value" style="color:${frColor}">${doraFailRate}%</div>
          <div class="dora-mini-label">Failure Rate</div>
          <div class="dora-mini-target">target &lt; 15%</div>
        </div>
        <div class="dora-mini-card">
          <div class="dora-mini-value" style="color:var(--ac)">${doraDelivered7d}</div>
          <div class="dora-mini-label">Entregas 7d</div>
          <div class="dora-mini-target">${recentDeliveries.length > 0 ? Math.round(doraDelivered7d / 7 * 30) + '/mes proyectado' : 'sin datos'}</div>
        </div>
      </div>
    </div>`;
  } catch {}

  let actHTML = state.actividad.slice(-15).reverse().map(a => {
    const ts = a.ts ? a.ts.slice(11, 19) : '??';
    const dir = a.dir === 'in' ? '→' : '←';
    const cls = a.dir === 'in' ? 'msg-in' : 'msg-out';
    const text = (a.text || '').replace(/</g, '&lt;');
    return `<div class="act-row ${cls}"><span class="ts">${ts}</span> ${dir} ${a.from ? '['+a.from+']' : ''} ${text}</div>`;
  }).join('') || '<div class="empty-label">Sin actividad</div>';

  return `<!DOCTYPE html>
<html lang="es"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pipeline V2 — Intrale</title>
<style>
/* ── Variables ──────────────────────────────────────────────────────────── */
:root{
  --bg:#0d1117;--sf:#161b22;--sf2:#1c2128;--bd:#30363d;--bd2:#21262d;
  --tx:#e6edf3;--dim:#8b949e;--dim2:#6e7681;
  --ac:#58a6ff;--ac2:#1f6feb;
  --gn:#3fb950;--gn2:#196c2e;
  --yl:#d29922;--yl2:#9e6a03;
  --rd:#f85149;--rd2:#8b1a14;
  --or:#db6d28;--or2:#7d3410;
  --pu:#bc8cff;
  --radius:10px;--radius-sm:6px;
}
/* ── Reset ──────────────────────────────────────────────────────────────── */
*{margin:0;padding:0;box-sizing:border-box}
body{
  background:var(--bg);color:var(--tx);
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
  padding:20px 24px;font-size:15px;line-height:1.5;
}
a{color:var(--ac);text-decoration:none}a:hover{text-decoration:underline}

/* ── Header ─────────────────────────────────────────────────────────────── */
h1{
  color:var(--tx);font-size:1.5em;font-weight:700;
  margin-bottom:20px;display:flex;align-items:center;gap:10px;
  border-bottom:1px solid var(--bd);padding-bottom:14px;
}
h1 .subtitle{color:var(--dim);font-size:0.6em;font-weight:400;letter-spacing:1px}
.health-dot{width:10px;height:10px;border-radius:50%;display:inline-block;margin-left:6px}
.health-active{background:var(--gn);box-shadow:0 0 8px var(--gn);animation:healthPulse 2s infinite}
.health-warn{background:var(--yl);box-shadow:0 0 8px var(--yl);animation:healthPulse 1s infinite}
.health-idle{background:var(--dim2)}
@keyframes healthPulse{0%,100%{opacity:1}50%{opacity:0.4}}
h2{color:var(--dim);font-size:0.8em;text-transform:uppercase;letter-spacing:2px;margin-bottom:12px;font-weight:600}

/* ── Alert ──────────────────────────────────────────────────────────────── */
.alert{
  background:rgba(248,81,73,0.12);border:1px solid rgba(248,81,73,0.4);
  border-left:4px solid var(--rd);border-radius:var(--radius-sm);
  padding:12px 16px;margin-bottom:20px;color:var(--rd);font-size:0.95em;
  display:flex;align-items:center;gap:10px;
}

/* ── KPI Grid ───────────────────────────────────────────────────────────── */
.kpis{
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(140px,1fr));
  gap:14px;margin-bottom:24px;
}
.kpi{
  background:var(--sf);border:1px solid var(--bd);border-radius:var(--radius);
  padding:18px 16px 14px;display:flex;flex-direction:column;align-items:center;
  gap:6px;position:relative;overflow:hidden;transition:border-color 0.2s;
}
.kpi:hover{border-color:var(--ac)}
.kpi::before{
  content:'';position:absolute;top:0;left:0;right:0;height:3px;
  background:var(--kpi-accent,var(--ac));border-radius:var(--radius) var(--radius) 0 0;
}
.kpi-icon{font-size:1.6em;line-height:1;margin-bottom:2px}
.kpi-value{
  font-size:2.4em;font-weight:800;color:var(--kpi-accent,var(--ac));
  font-variant-numeric:tabular-nums;line-height:1;
}
.kpi-value.warn{color:var(--yl);--kpi-accent:var(--yl)}
.kpi-value.danger{color:var(--rd);--kpi-accent:var(--rd)}
.kpi-value.success{color:var(--gn);--kpi-accent:var(--gn)}
.kpi-value.muted{color:var(--dim);--kpi-accent:var(--dim2)}
.kpi-label{font-size:0.78em;color:var(--dim);font-weight:500;text-align:center;line-height:1.2}

/* ── KPI accent colors per type ─────────────────────────────────────────── */
.kpi.kpi-activos{--kpi-accent:var(--ac)}
.kpi.kpi-working{--kpi-accent:var(--yl)}
.kpi.kpi-pendientes{--kpi-accent:var(--or)}
.kpi.kpi-blocked{--kpi-accent:var(--rd)}
.kpi.kpi-definidos{--kpi-accent:var(--pu)}
.kpi.kpi-entregados{--kpi-accent:var(--gn)}

/* ── Separador de pipeline KPIs ─────────────────────────────────────────── */
.kpi-divider{
  grid-column:1/-1;height:1px;background:var(--bd);
  margin:2px 0;
}

/* ── Matrix Section ─────────────────────────────────────────────────────── */
.matrix-section{
  background:var(--sf);border:1px solid var(--bd);border-radius:var(--radius);
  padding:18px 20px;margin-bottom:20px;
}
.matrix-header{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:14px}
.matrix-count{
  font-size:0.8em;color:var(--dim);font-weight:400;
  background:var(--bg);border:1px solid var(--bd);border-radius:20px;
  padding:2px 10px;
}
.matrix-scroll{overflow-x:visible}
.issue-matrix{width:100%;border-collapse:collapse;font-size:1em;table-layout:auto}
.issue-matrix th{
  padding:10px 12px;color:var(--tx);border-bottom:2px solid var(--bd);
  font-size:0.9em;text-transform:uppercase;letter-spacing:1px;text-align:left;
  font-weight:700;
}
.issue-matrix td{padding:8px 10px;border-bottom:1px solid var(--bd2)}
.issue-matrix tbody tr:hover{background:rgba(255,255,255,0.03)}
.th-issue{min-width:110px}
.group-header th{border-bottom:1px solid var(--bd);font-size:0.85em;letter-spacing:2px;padding:8px 12px;font-weight:700}
.group-def{color:var(--or);text-align:center;border-right:2px solid var(--bd)}.group-dev{color:var(--ac);text-align:center}
.th-def:last-of-type,.col-def:last-of-type{border-right:2px solid var(--bd)}

/* ── Fase header badges ────────────────────────────────────────────────── */
.fase-badges{display:flex;gap:6px;justify-content:left;margin-top:5px}
.fase-badge{
  font-size:0.72em;font-weight:600;padding:1px 6px;border-radius:10px;
  cursor:default;position:relative;letter-spacing:0.5px;
  display:inline-flex;align-items:center;gap:2px;
}
.fase-pendiente{color:var(--dim);background:rgba(139,148,158,0.12);border:1px solid rgba(139,148,158,0.25)}
.fase-trabajando{color:var(--yl);background:rgba(210,153,34,0.12);border:1px solid rgba(210,153,34,0.3)}
.fase-listo{color:var(--gn);background:rgba(63,185,80,0.1);border:1px solid rgba(63,185,80,0.25)}

/* ── Issue column ───────────────────────────────────────────────────────── */
.issue-col{min-width:88px}
.issue-link{color:var(--ac);font-weight:700;font-size:1.05em}
.progress-bar{height:4px;background:var(--bd);border-radius:3px;margin-top:5px;width:80px}
.progress-fill{height:100%;background:var(--gn);border-radius:3px;transition:width 0.4s}
.progress-text{font-size:0.8em;color:var(--dim);margin-top:2px;display:block}

/* ── Row states ─────────────────────────────────────────────────────────── */
.cell-empty{color:var(--bd);text-align:center;font-size:0.85em}
.cell-current{background:rgba(88,166,255,0.07);border-left:3px solid var(--ac)}
.issue-done{opacity:0.38}
.issue-listo{opacity:0.65}

/* ── Chips ──────────────────────────────────────────────────────────────── */
.chip{
  position:relative;cursor:default;
  padding:4px 10px;border-radius:5px;font-size:0.95em;
  display:inline-flex;align-items:center;gap:5px;
  border:1px solid transparent;font-family:inherit;
  font-weight:500;
}
.st-working{
  color:var(--ac);background:rgba(88,166,255,0.12);border-color:rgba(88,166,255,0.3);
  font-weight:600;animation:pulseBlue 2s infinite;
}
.st-done{color:var(--gn);background:rgba(63,185,80,0.1);border-color:rgba(63,185,80,0.25)}
.st-processed{color:var(--gn);opacity:0.55}
.st-pending{color:var(--dim);background:rgba(139,148,158,0.08);border-color:rgba(139,148,158,0.2)}
.st-rejected{color:var(--rd);background:rgba(248,81,73,0.1);border-color:rgba(248,81,73,0.3);opacity:0.7}
.chip-prior{
  font-size:0.72em;padding:2px 6px;opacity:0.5;
  transform:scale(0.85);transform-origin:center;
}
.chip-prior:hover{opacity:0.85}
.run-idx{
  font-size:0.7em;font-weight:700;color:var(--ac);
  margin-left:1px;vertical-align:super;line-height:1;
}
.stale-chip{
  color:var(--ac)!important;background:rgba(88,166,255,0.15)!important;
  border-color:rgba(88,166,255,0.5)!important;animation:pulseBlue 1.8s infinite;
}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}
@keyframes pulseBlue{0%,100%{opacity:1;box-shadow:0 0 4px rgba(88,166,255,0.3)}50%{opacity:0.5;box-shadow:none}}
.log-link{text-decoration:none}
.log-link:hover .chip{text-decoration:underline;filter:brightness(1.15)}

/* ── Log Viewer Panel ──────────────────────────────────────────────────── */
.log-overlay{
  display:none;position:fixed;top:0;right:0;bottom:0;left:0;z-index:500;
  background:rgba(0,0,0,0.5);backdrop-filter:blur(2px);
}
.log-overlay.open{display:block}
.log-panel{
  position:fixed;top:0;right:0;bottom:0;width:55%;min-width:480px;max-width:900px;
  background:var(--bg);border-left:2px solid var(--bd);z-index:501;
  display:flex;flex-direction:column;
  transform:translateX(100%);transition:transform 0.25s ease-out;
  box-shadow:-8px 0 32px rgba(0,0,0,0.6);
}
.log-overlay.open .log-panel{transform:translateX(0)}

.log-header{
  display:flex;align-items:center;gap:10px;
  padding:12px 16px;border-bottom:1px solid var(--bd);
  background:var(--sf);flex-shrink:0;
}
.log-title{font-weight:700;font-size:1.05em;color:var(--tx);flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.log-live-badge{
  display:inline-flex;align-items:center;gap:4px;
  font-size:0.75em;font-weight:700;color:var(--rd);
  padding:2px 8px;border-radius:10px;
  background:rgba(248,81,73,0.12);border:1px solid rgba(248,81,73,0.3);
}
.log-live-dot{
  width:6px;height:6px;border-radius:50%;background:var(--rd);
  animation:pulse 1.5s infinite;
}
.log-done-badge{
  font-size:0.75em;font-weight:600;color:var(--dim);
  padding:2px 8px;border-radius:10px;
  background:rgba(139,148,158,0.12);border:1px solid rgba(139,148,158,0.25);
}
.log-close{
  background:none;border:1px solid var(--bd);color:var(--dim);
  width:28px;height:28px;border-radius:6px;cursor:pointer;
  font-size:1.1em;display:flex;align-items:center;justify-content:center;
  transition:all 0.15s;
}
.log-close:hover{background:var(--rd);color:var(--tx);border-color:var(--rd)}
.log-open-tab{
  background:none;border:1px solid var(--bd);color:var(--dim);
  padding:3px 8px;border-radius:6px;cursor:pointer;
  font-size:0.78em;transition:all 0.15s;
}
.log-open-tab:hover{background:var(--sf2);color:var(--tx)}

.log-toolbar{
  display:flex;align-items:center;gap:8px;
  padding:8px 16px;border-bottom:1px solid var(--bd2);
  background:var(--sf);flex-shrink:0;
}
.log-search{
  flex:1;background:var(--bg);border:1px solid var(--bd);border-radius:6px;
  padding:5px 10px;color:var(--tx);font-size:0.88em;font-family:inherit;
  outline:none;
}
.log-search:focus{border-color:var(--ac)}
.log-search::placeholder{color:var(--dim2)}
.log-filter{
  background:var(--bg);border:1px solid var(--bd);border-radius:6px;
  padding:5px 8px;color:var(--tx);font-size:0.82em;cursor:pointer;
}
.log-match-count{font-size:0.78em;color:var(--dim);white-space:nowrap;min-width:60px;text-align:center}
.log-btn{
  background:var(--bg);border:1px solid var(--bd);border-radius:6px;
  padding:4px 10px;color:var(--dim);font-size:0.82em;cursor:pointer;
  transition:all 0.15s;white-space:nowrap;
}
.log-btn:hover{background:var(--sf2);color:var(--tx)}
.log-btn.active{background:var(--ac2);color:var(--tx);border-color:var(--ac)}

.log-body{
  flex:1;overflow-y:auto;overflow-x:hidden;
  padding:0;font-family:'SF Mono','Cascadia Code','Fira Code',Consolas,monospace;
  font-size:0.82em;line-height:1.65;
  scroll-behavior:smooth;
}
.log-line{
  padding:1px 16px;display:flex;gap:8px;
  border-bottom:1px solid rgba(48,54,61,0.3);
  transition:background 0.1s;white-space:pre-wrap;word-break:break-all;
}
.log-line:hover{background:rgba(88,166,255,0.04)}
.log-line-num{
  color:var(--dim2);font-size:0.85em;min-width:40px;text-align:right;
  user-select:none;flex-shrink:0;padding-top:1px;
}
.log-line-text{flex:1;min-width:0}
.log-line.log-error{color:var(--rd);background:rgba(248,81,73,0.05)}
.log-line.log-error:hover{background:rgba(248,81,73,0.1)}
.log-line.log-warning{color:var(--yl)}
.log-line.log-success{color:var(--gn)}
.log-line.log-tool{color:var(--ac)}
.log-line.log-meta{color:var(--dim)}
.log-line.log-highlight{background:rgba(210,153,34,0.15)!important}
.log-line.log-highlight-current{background:rgba(210,153,34,0.3)!important}
.log-empty{
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  height:100%;color:var(--dim);gap:10px;
}
.log-empty-spinner{
  width:24px;height:24px;border:2px solid var(--bd);border-top-color:var(--ac);
  border-radius:50%;animation:spin 1s linear infinite;
}
@keyframes spin{to{transform:rotate(360deg)}}

.log-footer{
  display:flex;align-items:center;justify-content:space-between;
  padding:6px 16px;border-top:1px solid var(--bd);
  background:var(--sf);flex-shrink:0;font-size:0.78em;color:var(--dim);
}
.log-scroll-btn{
  background:var(--ac2);color:var(--tx);border:none;border-radius:6px;
  padding:3px 10px;cursor:pointer;font-size:0.85em;
  display:none;
}
.log-scroll-btn.visible{display:inline-block}

/* ── Tooltip ────────────────────────────────────────────────────────────── */
.chip .tt{
  display:none;position:absolute;z-index:200;
  bottom:calc(100% + 12px);left:50%;transform:translateX(-50%);
  background:#000000;border:2px solid var(--ac);border-radius:10px;
  padding:14px 18px;font-size:0.95em;white-space:nowrap;
  min-width:220px;color:var(--tx);
  box-shadow:0 8px 32px rgba(0,0,0,0.9),0 0 0 1px rgba(88,166,255,0.2);
  pointer-events:none;
}
.chip .tt span{display:block;line-height:1.7;color:#c9d1d9;font-size:0.95em}
.chip .tt span:first-child{color:var(--tx);font-weight:700;font-size:1.05em;margin-bottom:4px;padding-bottom:4px;border-bottom:1px solid var(--bd)}
.chip:hover .tt{display:block}
.more-label{color:var(--dim);font-style:italic;text-align:center;font-size:0.88em;padding:8px}
.issue-overflow{display:none}
.issue-overflow.show{display:table-row}
.ver-mas-container{text-align:center;padding:10px 0}
.ver-mas-btn{background:var(--sf);color:var(--tx);border:1px solid var(--bd);border-radius:var(--radius);padding:6px 18px;cursor:pointer;font-size:0.88em;transition:background 0.2s}
.ver-mas-btn:hover{background:var(--bd)}

/* ── Dual row: Equipo | Sistema ──────────────────────────────────────── */
.dual-row{display:flex;gap:14px;margin-bottom:20px;flex-wrap:wrap}
.dual-col{flex:1;min-width:320px}
.bar-section{
  background:var(--sf);border:1px solid var(--bd);border-radius:var(--radius);
  padding:16px 18px;
}
.sys-chips-row{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:4px}
/* ── Service Cards ──────────────────────────────────────────────────────── */
.svc-grid{display:flex;flex-wrap:wrap;gap:8px}
.svc-card{
  background:var(--bg);border:1px solid var(--bd2);border-radius:var(--radius-sm);
  padding:8px 10px;min-width:90px;flex:1;max-width:140px;
  border-left:3px solid var(--dim2);transition:box-shadow 0.2s;
}
.svc-card:hover{box-shadow:0 0 6px rgba(88,166,255,0.08)}
.svc-card-ok{border-left-color:var(--gn)}
.svc-card-busy{border-left-color:var(--yl)}
.svc-card-dead{border-left-color:var(--rd)}
.svc-card-header{display:flex;align-items:center;gap:4px}
.svc-card-name{font-size:0.78em;font-weight:600;color:var(--tx);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.svc-card-pulse{width:5px;height:5px;border-radius:50%;background:var(--gn);animation:agentPulse 2s infinite;margin-left:auto;flex-shrink:0}
.svc-card-busy .svc-card-pulse{background:var(--yl)}
.svc-card-stats{display:flex;gap:6px;margin-top:4px;overflow:hidden}
.svc-stat{font-size:0.75em;font-weight:700;color:var(--dim);font-variant-numeric:tabular-nums;white-space:nowrap;cursor:default}
.svc-stat-work{color:var(--yl)}
.svc-stat-done{color:var(--gn)}
.svc-card-pid{font-size:0.68em;color:var(--dim2);margin-top:2px;font-variant-numeric:tabular-nums}
.svc-card-group{min-width:160px;max-width:220px}
.svc-group-procs{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}
.svc-group-proc{font-size:0.65em;color:var(--dim);white-space:nowrap;cursor:default}
.proc-chip{
  display:inline-flex;align-items:center;gap:5px;
  font-size:0.82em;padding:4px 8px;margin:3px;
  border-radius:5px;background:var(--bg);border:1px solid var(--bd2);
}
.proc-alive{color:var(--gn)}.proc-dead{color:var(--rd)}
.pid-num{font-size:0.8em;color:var(--dim2)}

/* ── Control buttons ───────────────────────────────────────────────────── */
.ctl-btn{
  border:none;cursor:pointer;border-radius:4px;font-size:0.72em;
  padding:2px 6px;margin-right:4px;font-weight:700;line-height:1;
  vertical-align:middle;transition:opacity 0.2s,transform 0.1s;
}
.ctl-btn:hover{opacity:0.85;transform:scale(1.1)}
.ctl-btn:active{transform:scale(0.95)}
.ctl-btn.loading{opacity:0.4;pointer-events:none}
.ctl-start{background:var(--gn2);color:var(--gn)}
.ctl-stop{background:var(--rd2);color:var(--rd)}
.ctl-wide{padding:4px 12px;font-size:0.78em;margin-top:8px;display:inline-block}
/* Priority Windows (inline toggles in Equipo header) */
.pw-toggles{margin-left:auto;display:inline-flex;gap:6px;font-size:0.65em;vertical-align:middle}
.pw-toggle{padding:2px 10px;border-radius:12px;cursor:pointer;font-weight:600;letter-spacing:0.3px;transition:all 0.2s;border:1px solid var(--bd);user-select:none}
.pw-toggle-active{background:var(--yl2);color:var(--yl);border-color:var(--yl);animation:pwPulse 2.5s ease-in-out infinite}
.pw-toggle-inactive{background:var(--sf2);color:var(--dim);border-color:var(--bd)}
.pw-toggle-inactive:hover{background:var(--bd2);color:var(--fg)}
.pw-toggle.pw-build.pw-toggle-active{background:var(--ac2);color:var(--ac);border-color:var(--ac)}
@keyframes pwPulse{0%,100%{opacity:1}50%{opacity:0.65}}
/* Kill agent button */
.kill-btn{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;background:var(--rd2);color:var(--rd);font-size:12px;font-weight:700;cursor:pointer;margin-left:4px;opacity:0.6;transition:opacity 0.15s,background 0.15s;line-height:1;vertical-align:middle}
.kill-btn:hover{opacity:1;background:var(--rd);color:#fff}
/* ETA badges */
.eta-badge{font-size:0.7em;padding:1px 5px;border-radius:8px;background:var(--ac2);color:var(--ac);margin-left:4px;font-weight:600;white-space:nowrap}
.eta-over{background:var(--or2);color:var(--or)}
.issue-eta{display:block;font-size:0.72em;color:var(--ac);margin-top:2px;white-space:nowrap}
.issue-done-time{color:var(--gn)}

/* Toast notification */
.toast{
  position:fixed;bottom:20px;right:20px;z-index:999;
  background:var(--sf2);border:1px solid var(--bd);border-radius:var(--radius-sm);
  padding:10px 16px;font-size:0.88em;color:var(--tx);
  box-shadow:0 4px 12px rgba(0,0,0,0.4);
  animation:slideIn 0.3s ease;max-width:350px;
}
.toast.toast-ok{border-left:4px solid var(--gn)}
.toast.toast-err{border-left:4px solid var(--rd)}
@keyframes slideIn{from{transform:translateY(20px);opacity:0}to{transform:translateY(0);opacity:1}}

/* ── Resource Gauges ───────────────────────────────────────────────────── */
.gauge-row{display:flex;gap:16px;flex-wrap:wrap}
.gauge{flex:1;min-width:180px}
.gauge-label{font-size:0.82em;font-weight:700;color:var(--dim);margin-bottom:6px;text-transform:uppercase;letter-spacing:1px}
.gauge-bar{
  position:relative;height:10px;background:var(--bd);border-radius:5px;overflow:visible;
}
.gauge-fill{
  height:100%;border-radius:5px;transition:width 0.6s ease;
}
.gauge-threshold{
  position:absolute;top:-2px;bottom:-2px;width:2px;
  background:var(--rd);opacity:0.6;border-radius:1px;
}
.gauge-ok .gauge-fill{background:var(--gn)}
.gauge-warn .gauge-fill{background:var(--yl)}
.gauge-danger .gauge-fill{background:var(--rd);animation:pulse 1.8s infinite}
.gauge-value{
  font-size:0.9em;font-weight:600;margin-top:6px;
  font-variant-numeric:tabular-nums;
}
.gauge-ok .gauge-value{color:var(--gn)}
.gauge-warn .gauge-value{color:var(--yl)}
.gauge-danger .gauge-value{color:var(--rd)}
.gauge-detail{font-weight:400;color:var(--dim);font-size:0.85em;margin-left:4px}
.resource-alert{
  margin-top:10px;padding:8px 12px;
  background:rgba(248,81,73,0.12);border:1px solid rgba(248,81,73,0.4);
  border-left:4px solid var(--rd);border-radius:var(--radius-sm);
  color:var(--rd);font-size:0.88em;font-weight:600;
}

/* ── Rechazos / Actividad ───────────────────────────────────────────────── */
.rechazo-row{font-size:0.85em;padding:5px 2px;border-bottom:1px solid var(--bd2);color:var(--rd);display:flex;gap:8px;align-items:baseline}
.rechazo-motivo{color:var(--dim);font-style:italic}
.ts{color:var(--dim);font-size:0.82em}
.act-row{font-size:0.82em;padding:4px 2px;border-bottom:1px solid var(--bd2);font-family:'SF Mono','Fira Code',monospace;display:flex;gap:8px}
.msg-in{color:var(--ac)}.msg-out{color:var(--gn)}

/* ── Collapse / details ─────────────────────────────────────────────────── */
.collapse-section{
  background:var(--sf);border:1px solid var(--bd);border-radius:var(--radius);
  padding:0;margin-bottom:14px;overflow:hidden;
}
.collapse-section summary{
  color:var(--dim);font-size:0.82em;cursor:pointer;
  padding:12px 18px;text-transform:uppercase;letter-spacing:1.5px;font-weight:600;
  list-style:none;display:flex;justify-content:space-between;align-items:center;
  user-select:none;
}
.collapse-section summary::-webkit-details-marker{display:none}
.collapse-section summary::after{content:'▸';transition:transform 0.2s}
.collapse-section[open] summary::after{transform:rotate(90deg)}
.collapse-section summary:hover{background:rgba(255,255,255,0.03)}
.collapse-body{padding:10px 18px 14px;border-top:1px solid var(--bd2)}

/* ── Agent Team ────────────────────────────────────────────────────────── */
.team-section{
  background:var(--sf);border:1px solid var(--bd);border-radius:var(--radius);
  padding:18px 20px;margin-bottom:20px;
}
/* ── Agent Cards (compact) ──────────────────────────────────────────────── */
.agent-grid{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:12px}
.agent-card{
  background:var(--bg);border:1px solid var(--bd2);border-radius:var(--radius-sm);
  padding:8px 12px;display:flex;gap:8px;align-items:center;
  border-left:3px solid var(--agent-color);
  position:relative;overflow:hidden;flex:1;min-width:200px;max-width:320px;
  transition:border-color 0.2s,box-shadow 0.2s;
}
.agent-card:hover{border-color:var(--agent-color);box-shadow:0 0 8px rgba(88,166,255,0.1)}
.agent-avatar{font-size:1.2em;line-height:1}
.agent-info{flex:1;min-width:0}
.agent-name{font-weight:700;font-size:0.88em;color:var(--agent-color);line-height:1}
.agent-issues{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}
.agent-issue{
  font-size:0.72em;padding:2px 6px;border-radius:10px;
  background:rgba(88,166,255,0.08);border:1px solid rgba(88,166,255,0.2);
  color:var(--ac);display:inline-flex;align-items:center;gap:3px;
  text-decoration:none;transition:background 0.15s;
}
.agent-issue:hover{background:rgba(88,166,255,0.15);text-decoration:none}
.agent-issue-fase{color:var(--dim);font-size:0.9em}
.agent-issue-dur{color:var(--dim2);font-size:0.85em}
.agent-pulse{
  position:absolute;top:6px;right:6px;width:6px;height:6px;
  border-radius:50%;background:var(--agent-color);
  animation:agentPulse 2s ease-in-out infinite;
}
@keyframes agentPulse{0%,100%{opacity:1;box-shadow:0 0 4px var(--agent-color)}50%{opacity:0.3;box-shadow:none}}

/* ── Sub-section labels ─────────────────────────────────────────────────── */
.subsection-label{
  font-size:0.68em;color:var(--dim);text-transform:uppercase;letter-spacing:1.5px;
  font-weight:600;margin-bottom:6px;margin-top:10px;
  display:flex;align-items:center;gap:8px;
}
.subsection-label::after{content:'';flex:1;height:1px;background:var(--bd2)}

/* ── Skill Capacity Chips (inline compact) ──────────────────────────────── */
.skill-cap-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.skill-cap-chip{
  display:inline-flex;align-items:center;gap:6px;
  background:var(--bg);border:1px solid var(--bd2);border-radius:var(--radius-sm);
  padding:5px 10px;border-left:3px solid var(--agent-color,var(--dim2));
  transition:box-shadow 0.2s;
}
.skill-cap-chip:hover{box-shadow:0 0 6px rgba(88,166,255,0.08)}
.load-full.skill-cap-chip{border-left-color:var(--rd)}
.skill-cap-icon{font-size:1em;line-height:1}
.skill-cap-name{font-size:0.78em;font-weight:600;color:var(--tx);white-space:nowrap}
.skill-cap-bar{width:32px;height:4px;background:var(--bd);border-radius:2px;overflow:hidden;display:inline-block}
.skill-cap-fill{display:block;height:100%;border-radius:2px;transition:width 0.6s ease}
.load-partial .skill-cap-fill{background:var(--yl)}
.load-full .skill-cap-fill{background:var(--rd)}
.skill-cap-count{font-size:0.72em;color:var(--dim);font-variant-numeric:tabular-nums}
.load-idle.skill-cap-chip{opacity:0.5;border-left-color:var(--dim2)}
.load-idle .skill-cap-name{color:var(--dim)}
.skill-idle-summary{font-size:0.75em;color:var(--dim);font-style:italic;padding:4px 8px}

/* ── DORA Mini ─────────────────────────────────────────────────────────── */
.dora-mini{
  background:var(--sf);border:1px solid var(--bd);border-radius:var(--radius);
  padding:18px 20px;margin-bottom:20px;
}
.dora-mini-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
.dora-mini-card{
  background:var(--bg);border:1px solid var(--bd2);border-radius:var(--radius-sm);
  padding:14px 12px;text-align:center;
}
.dora-mini-value{font-size:1.8em;font-weight:800;font-variant-numeric:tabular-nums;line-height:1.1}
.dora-mini-label{color:var(--dim);font-size:0.78em;font-weight:600;margin-top:4px;text-transform:uppercase;letter-spacing:0.5px}
.dora-mini-target{font-size:0.7em;color:var(--dim2);margin-top:4px}
@media(max-width:700px){.dora-mini-grid{grid-template-columns:repeat(2,1fr)}}

/* ── Footer ──────────────────────────────────────────���──────────────────── */
.footer{margin-top:22px;font-size:0.75em;color:var(--dim2);text-align:center;padding-top:12px;border-top:1px solid var(--bd2)}

/* ── Empty state ────────────────────────────────────────────────────────── */
.empty-label{color:var(--dim);font-size:0.82em;font-style:italic}

/* ── KPI Tooltip ────────────────────────────────────────────────────────── */
.kpi[data-tooltip]{cursor:pointer;position:relative}
.kpi-tooltip{
  display:none;position:fixed;z-index:1000;
  background:var(--sf2);border:1px solid var(--bd);border-radius:var(--radius-sm);
  padding:10px 14px;font-size:0.82em;color:var(--tx);
  box-shadow:0 8px 24px rgba(0,0,0,0.4);max-width:320px;min-width:160px;
  pointer-events:none;white-space:nowrap;
}
.kpi-tooltip .tt-title{color:var(--dim);font-size:0.85em;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;font-weight:600}
.kpi-tooltip .tt-item{padding:2px 0;color:var(--ac)}
.kpi-tooltip .tt-item a{color:var(--ac)}
.kpi-tooltip .tt-more{color:var(--dim);font-style:italic;margin-top:4px}
</style></head>
<body>
  <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:14px">
    <h1 style="margin:0">🐙 Pipeline V2 <span class="subtitle">— Intrale Platform</span> <span class="health-dot ${stale > 0 ? 'health-warn' : trabajando > 0 ? 'health-active' : 'health-idle'}"></span></h1>
    <div style="display:flex;gap:16px;font-size:0.78em;color:var(--dim);white-space:nowrap">
      <span>📊 Dashboard: <b style="color:var(--tx)">${dashboardBuild}</b></span>
      <span>🐙 Pulpo: <b style="color:var(--tx)">${pulpoBuild}</b></span>
    </div>
  </div>

  <!-- orphan alert moved to system section -->

  <div id="kpi-tooltip" class="kpi-tooltip"></div>
  <div class="kpis">
    <div class="kpi kpi-activos" data-tt='${ttActivos}'>
      <span class="kpi-icon">🔄</span>
      <div class="kpi-value">${activos}</div>
      <div class="kpi-label">Activos en pipeline</div>
    </div>
    <div class="kpi kpi-working" data-tt='${ttTrabajando}'>
      <span class="kpi-icon">⚙️</span>
      <div class="kpi-value ${trabajando > 0 ? 'warn' : 'muted'}">${trabajando}</div>
      <div class="kpi-label">En ejecución ahora</div>
    </div>
    <div class="kpi kpi-pendientes" data-tt='${ttPendientes}'>
      <span class="kpi-icon">⏳</span>
      <div class="kpi-value ${pendientes > 0 ? '' : 'muted'}" style="color:var(--or)">${pendientes}</div>
      <div class="kpi-label">Pendientes en cola</div>
    </div>
    <div class="kpi kpi-blocked" data-tt='${ttStale}'>
      <span class="kpi-icon">🚨</span>
      <div class="kpi-value ${stale > 0 ? 'danger' : 'muted'}">${stale}</div>
      <div class="kpi-label">Bloqueados / stale</div>
    </div>
    <div class="kpi kpi-definidos" data-tt='${ttDefinidos}'>
      <span class="kpi-icon">📋</span>
      <div class="kpi-value" style="color:var(--pu)">${definidos}</div>
      <div class="kpi-label">Definidos listos</div>
    </div>
    <div class="kpi kpi-entregados" data-tt='${ttEntregados}'>
      <span class="kpi-icon">🚀</span>
      <div class="kpi-value success">${entregados}</div>
      <div class="kpi-label">Entregados a prod</div>
    </div>
  </div>

  <div class="dual-row">
    <div class="bar-section dual-col">
      <h2>🧠 Equipo<span class="pw-toggles">${(() => {
        const pw = state.priorityWindows;
        const items = [
          { key: 'qa', emoji: '\u{1F50D}', label: 'QA', cls: '' },
          { key: 'build', emoji: '\u{1F528}', label: 'Build', cls: ' pw-build' }
        ];
        return items.map(i => {
          const s = pw[i.key];
          const active = s && s.active;
          const elapsed = active && s.activatedAt ? Math.round((Date.now() - s.activatedAt) / 60000) : 0;
          const text = active ? i.emoji + ' ' + i.label + ' \u00B7 ' + elapsed + 'm' : i.emoji + ' ' + i.label;
          const tip = active ? i.label + ' Priority activa (' + elapsed + 'm) \u2014 click para desactivar' : 'Activar ' + i.label + ' Priority';
          const action = active ? 'off' : 'on';
          const cls = active ? 'pw-toggle-active' : 'pw-toggle-inactive';
          return '<span class="pw-toggle ' + cls + i.cls + '" title="' + tip + '" onclick="pwAction(\'' + i.key + '\',\'' + action + '\')">' + text + '</span>';
        }).join('');
      })()}</span></h2>
      ${agentTeamCards ? '<div class="subsection-label">En trabajo ahora</div><div class="agent-grid">' + agentTeamCards + '</div>' : ''}
      ${heatmapHTML ? '<div class="subsection-label">' + (agentTeamCards ? 'Capacidad' : 'Equipo disponible') + '</div><div class="skill-cap-row">' + heatmapHTML + '</div>' : '<span class="empty-label">Sin skills configurados</span>'}
    </div>
    <div class="bar-section dual-col">
      <h2>💻 Sistema</h2>
      ${resourcesHTML}
      <div class="subsection-label" style="margin-top:14px">Servicios</div>
      <div class="svc-grid">${svcCardsHTML}</div>
    </div>
  </div>

  ${matrixHTML}

  ${doraMinHTML}

  ${state.rechazos.length > 0 ? `<details class="collapse-section"><summary>🚫 Rechazos recientes<span>${state.rechazos.length}</span></summary><div class="collapse-body">${rechazosHTML}</div></details>` : ''}

  <details class="collapse-section"><summary>💬 Actividad Commander</summary><div class="collapse-body" style="max-height:300px;overflow-y:auto">${actHTML}</div></details>

  <div class="footer">🔴 Live · Auto-refresh 10s &nbsp;|&nbsp; ${new Date().toLocaleString('es-AR')}</div>

<!-- Log Viewer Panel -->
<div id="log-overlay" class="log-overlay" onclick="if(event.target===this)closeLogViewer()">
  <div class="log-panel">
    <div class="log-header">
      <span id="log-title" class="log-title"></span>
      <span id="log-status-badge"></span>
      <button class="log-open-tab" onclick="openLogInTab()" title="Abrir en nueva pestaña">↗ Tab</button>
      <button class="log-close" onclick="closeLogViewer()" title="Cerrar (Esc)">✕</button>
    </div>
    <div class="log-toolbar">
      <input type="text" id="log-search" class="log-search" placeholder="Buscar en el log…" oninput="filterLog()" onkeydown="if(event.key==='Enter')jumpToMatch(event.shiftKey?-1:1)">
      <span id="log-match-count" class="log-match-count"></span>
      <select id="log-filter" class="log-filter" onchange="filterLog()">
        <option value="all">Todo</option>
        <option value="error">❌ Errores</option>
        <option value="warning">⚠ Warnings</option>
        <option value="tool">🔧 Tools</option>
        <option value="success">✓ Éxitos</option>
      </select>
      <button id="log-pause-btn" class="log-btn" onclick="togglePause()">⏸ Pause</button>
    </div>
    <div id="log-body" class="log-body"></div>
    <div class="log-footer">
      <span id="log-line-count"></span>
      <span id="log-last-update"></span>
      <button id="log-scroll-btn" class="log-scroll-btn" onclick="scrollLogToBottom()">⬇ Ir al final</button>
    </div>
  </div>
</div>

<script>
// SSE live refresh — solo recarga si el estado cambió
let lastHash = null;
const es = new EventSource('/events');
es.onmessage = e => {
  // No recargar si el log viewer está abierto (perdería el panel)
  if (lastHash && e.data !== lastHash && !document.getElementById('log-overlay').classList.contains('open')) location.reload();
  lastHash = e.data;
};
es.onerror = () => { setTimeout(() => location.reload(), 10000); };

// KPI Tooltips
const tt = document.getElementById('kpi-tooltip');
const GH_BASE = 'https://github.com/intrale/platform/issues/';
const MAX_TT = 20;
document.querySelectorAll('.kpi[data-tt]').forEach(el => {
  el.addEventListener('mouseenter', e => {
    try {
      const d = JSON.parse(el.dataset.tt);
      const shown = d.items.slice(0, MAX_TT);
      const rows = shown.map(it =>
        '<div class="tt-item"><a href="' + GH_BASE + it.id + '" target="_blank">#' + it.id + '</a>' +
        (it.label ? ' <span style="color:var(--dim)">— ' + it.label + '</span>' : '') + '</div>'
      ).join('');
      const more = d.items.length > MAX_TT
        ? '<div class="tt-more">+ ' + (d.items.length - MAX_TT) + ' más…</div>' : '';
      tt.innerHTML = '<div class="tt-title">' + d.title + ' (' + d.items.length + ')</div>' + rows + more;
      tt.style.display = 'block';
      positionTt(e);
    } catch(_) {}
  });
  el.addEventListener('mousemove', positionTt);
  el.addEventListener('mouseleave', () => { tt.style.display = 'none'; });
});
function positionTt(e) {
  const pad = 14;
  let x = e.clientX + pad, y = e.clientY + pad;
  const r = tt.getBoundingClientRect();
  if (x + r.width > window.innerWidth - 10) x = e.clientX - r.width - pad;
  if (y + r.height > window.innerHeight - 10) y = e.clientY - r.height - pad;
  tt.style.left = x + 'px';
  tt.style.top = y + 'px';
}

// --- Start/Stop actions ---
async function ctlAction(target, action) {
  // Find the button that was clicked and show loading state
  const btns = document.querySelectorAll('.ctl-btn');
  btns.forEach(b => { if (b.onclick && b.onclick.toString().includes(target)) b.classList.add('loading'); });

  try {
    const resp = await fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target, action })
    });
    const result = await resp.json();
    showToast(result.msg, result.ok);
    // Reload after a short delay to show updated state
    setTimeout(() => location.reload(), 1500);
  } catch (e) {
    showToast('Error de conexión: ' + e.message, false);
  }
  btns.forEach(b => b.classList.remove('loading'));
}

// QA component action (individual or all)
async function qaComponentAction(component, action) {
  const btn = event && event.target ? event.target : null;
  if (btn) btn.classList.add('loading');
  try {
    const body = component === 'all'
      ? { target: 'qa', action }
      : { target: 'qa', action, component };
    const resp = await fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const result = await resp.json();
    showToast(result.msg, result.ok);
    setTimeout(() => location.reload(), 1500);
  } catch (e) {
    showToast('Error: ' + e.message, false);
  }
  if (btn) btn.classList.remove('loading');
}

// Kill agent
async function killAgent(issue, skill, pipeline, fase) {
  if (!confirm('¿Cancelar agente ' + skill + ' en #' + issue + '?')) return;
  try {
    const resp = await fetch('/api/kill-agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issue, skill, pipeline, fase })
    });
    const result = await resp.json();
    showToast(result.msg, result.ok);
    setTimeout(() => location.reload(), 1500);
  } catch (e) {
    showToast('Error: ' + e.message, false);
  }
}

// Priority Window toggle
async function pwAction(window, action) {
  try {
    const resp = await fetch('/api/priority-window', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ window, action })
    });
    const result = await resp.json();
    showToast(result.msg, result.ok);
    setTimeout(() => location.reload(), 1500);
  } catch (e) {
    showToast('Error de conexión: ' + e.message, false);
  }
}

function toggleIssues(btn) {
  const rows = document.querySelectorAll('.issue-overflow');
  const expanded = rows.length > 0 && rows[0].classList.contains('show');
  rows.forEach(r => r.classList.toggle('show', !expanded));
  btn.textContent = expanded ? 'Ver más (' + rows.length + ' issues)' : 'Ver menos';
}

function showToast(msg, ok) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.className = 'toast ' + (ok ? 'toast-ok' : 'toast-err');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// Fase badge tooltips (reutiliza el mismo tooltip div)
document.querySelectorAll('.fase-badge[data-fase-tt]').forEach(el => {
  el.addEventListener('mouseenter', e => {
    try {
      const d = JSON.parse(el.dataset.faseTt);
      const shown = d.items.slice(0, MAX_TT);
      const rows = shown.map(it =>
        '<div class="tt-item"><a href="' + GH_BASE + it.id + '" target="_blank">#' + it.id + '</a></div>'
      ).join('');
      const more = d.items.length > MAX_TT
        ? '<div class="tt-more">+ ' + (d.items.length - MAX_TT) + ' más…</div>' : '';
      tt.innerHTML = '<div class="tt-title">' + d.title + ' (' + d.items.length + ')</div>' + rows + more;
      tt.style.display = 'block';
      positionTt(e);
    } catch(_) {}
  });
  el.addEventListener('mousemove', positionTt);
  el.addEventListener('mouseleave', () => { tt.style.display = 'none'; });
});

// ── Log Viewer ────────────────────────────────────────────────────────
let logViewerES = null;
let logViewerFile = null;
let logViewerPaused = false;
let logAllLines = [];
let logMatchIndices = [];
let logCurrentMatch = -1;
let logAutoScroll = true;

function classifyLine(text) {
  if (/error|exception|fail|❌|CRASH|panic/i.test(text)) return 'log-error';
  if (/warn|⚠|WARNING/i.test(text)) return 'log-warning';
  if (/\[Tool:|tool_use|Edit\]|Read\]|Write\]|Bash\]|Grep\]|Glob\]/i.test(text)) return 'log-tool';
  if (/✓|passed|success|✔|completed|APROBADO/i.test(text)) return 'log-success';
  if (/^---\s|^\[.*\]\s*$|^=+$/.test(text)) return 'log-meta';
  return '';
}

function renderLine(text, idx) {
  const cls = classifyLine(text);
  const escaped = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return '<div class="log-line ' + cls + '" data-idx="' + idx + '"><span class="log-line-num">' + (idx + 1) + '</span><span class="log-line-text">' + escaped + '</span></div>';
}

function openLogViewer(filename, title, isLive) {
  logViewerFile = filename;
  logAllLines = [];
  logMatchIndices = [];
  logCurrentMatch = -1;
  logAutoScroll = true;
  logViewerPaused = false;

  document.getElementById('log-title').textContent = title;
  document.getElementById('log-status-badge').innerHTML = isLive
    ? '<span class="log-live-badge"><span class="log-live-dot"></span> LIVE</span>'
    : '<span class="log-done-badge">Finalizado</span>';
  document.getElementById('log-body').innerHTML = '<div class="log-empty"><div class="log-empty-spinner"></div>Cargando log…</div>';
  document.getElementById('log-search').value = '';
  document.getElementById('log-match-count').textContent = '';
  document.getElementById('log-filter').value = 'all';
  document.getElementById('log-pause-btn').textContent = '⏸ Pause';
  document.getElementById('log-pause-btn').classList.toggle('active', false);
  document.getElementById('log-pause-btn').style.display = isLive ? '' : 'none';
  document.getElementById('log-line-count').textContent = '';
  document.getElementById('log-scroll-btn').classList.remove('visible');
  document.getElementById('log-overlay').classList.add('open');

  // Close SSE if open
  if (logViewerES) { logViewerES.close(); logViewerES = null; }

  // Open SSE stream
  logViewerES = new EventSource('/logs/stream/' + encodeURIComponent(filename));
  logViewerES.onmessage = function(e) {
    if (logViewerPaused) return;
    try {
      const msg = JSON.parse(e.data);
      const body = document.getElementById('log-body');
      if (msg.type === 'init') {
        logAllLines = msg.lines;
        body.innerHTML = msg.lines.map((l, i) => renderLine(l, i)).join('');
        scrollLogToBottom();
      } else if (msg.type === 'append') {
        const startIdx = logAllLines.length;
        logAllLines.push(...msg.lines);
        const html = msg.lines.map((l, i) => renderLine(l, startIdx + i)).join('');
        body.insertAdjacentHTML('beforeend', html);
        if (logAutoScroll) scrollLogToBottom();
      }
      updateLogFooter();
      // Re-apply filter/search if active
      const searchVal = document.getElementById('log-search').value;
      const filterVal = document.getElementById('log-filter').value;
      if (searchVal || filterVal !== 'all') applyFilterVisual();
    } catch(_) {}
  };
  logViewerES.onerror = function() {
    // Connection lost — show in status
    const badge = document.getElementById('log-status-badge');
    if (badge) badge.innerHTML = '<span class="log-done-badge">Desconectado</span>';
  };

  // Track scroll for auto-scroll toggle
  const body = document.getElementById('log-body');
  body.onscroll = function() {
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
    logAutoScroll = atBottom;
    document.getElementById('log-scroll-btn').classList.toggle('visible', !atBottom);
  };
}

function closeLogViewer() {
  document.getElementById('log-overlay').classList.remove('open');
  if (logViewerES) { logViewerES.close(); logViewerES = null; }
}

function openLogInTab() {
  if (logViewerFile) window.open('/logs/' + logViewerFile, '_blank');
}

function scrollLogToBottom() {
  const body = document.getElementById('log-body');
  body.scrollTop = body.scrollHeight;
  logAutoScroll = true;
  document.getElementById('log-scroll-btn').classList.remove('visible');
}

function togglePause() {
  logViewerPaused = !logViewerPaused;
  const btn = document.getElementById('log-pause-btn');
  btn.textContent = logViewerPaused ? '▶ Resume' : '⏸ Pause';
  btn.classList.toggle('active', logViewerPaused);
}

function updateLogFooter() {
  document.getElementById('log-line-count').textContent = logAllLines.length + ' líneas';
  document.getElementById('log-last-update').textContent = 'Actualizado: ' + new Date().toLocaleTimeString('es-AR');
}

function filterLog() {
  applyFilterVisual();
}

function applyFilterVisual() {
  const searchVal = document.getElementById('log-search').value.toLowerCase();
  const filterVal = document.getElementById('log-filter').value;
  const body = document.getElementById('log-body');
  const lines = body.querySelectorAll('.log-line');
  logMatchIndices = [];

  lines.forEach((el, i) => {
    const text = logAllLines[i] || '';
    const textLower = text.toLowerCase();
    let visible = true;

    // Category filter
    if (filterVal !== 'all') {
      const cls = classifyLine(text);
      const filterMap = { error: 'log-error', warning: 'log-warning', tool: 'log-tool', success: 'log-success' };
      if (cls !== filterMap[filterVal]) visible = false;
    }

    // Search filter
    if (searchVal && visible) {
      if (textLower.includes(searchVal)) {
        logMatchIndices.push(i);
        el.classList.add('log-highlight');
      } else {
        el.classList.remove('log-highlight');
        visible = false;
      }
    } else {
      el.classList.remove('log-highlight');
    }

    el.style.display = visible ? '' : 'none';
    el.classList.remove('log-highlight-current');
  });

  // Update match count
  const countEl = document.getElementById('log-match-count');
  if (searchVal && logMatchIndices.length > 0) {
    logCurrentMatch = 0;
    highlightCurrentMatch();
    countEl.textContent = logMatchIndices.length + ' coincidencias';
  } else if (searchVal) {
    countEl.textContent = '0 coincidencias';
    logCurrentMatch = -1;
  } else {
    countEl.textContent = filterVal !== 'all' ? logMatchIndices.length + ' filtradas' : '';
    // When only filter, show matching lines without search
    if (filterVal !== 'all' && !searchVal) {
      lines.forEach((el, i) => {
        const text = logAllLines[i] || '';
        const cls = classifyLine(text);
        const filterMap = { error: 'log-error', warning: 'log-warning', tool: 'log-tool', success: 'log-success' };
        el.style.display = cls === filterMap[filterVal] ? '' : 'none';
      });
    }
  }
}

function highlightCurrentMatch() {
  if (logCurrentMatch < 0 || logMatchIndices.length === 0) return;
  const body = document.getElementById('log-body');
  body.querySelectorAll('.log-highlight-current').forEach(el => el.classList.remove('log-highlight-current'));
  const idx = logMatchIndices[logCurrentMatch];
  const target = body.querySelector('.log-line[data-idx="' + idx + '"]');
  if (target) {
    target.classList.add('log-highlight-current');
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  document.getElementById('log-match-count').textContent = (logCurrentMatch + 1) + '/' + logMatchIndices.length;
}

function jumpToMatch(direction) {
  if (logMatchIndices.length === 0) return;
  logCurrentMatch = (logCurrentMatch + direction + logMatchIndices.length) % logMatchIndices.length;
  highlightCurrentMatch();
}

// Keyboard shortcuts
document.addEventListener('keydown', function(e) {
  if (!document.getElementById('log-overlay').classList.contains('open')) return;
  if (e.key === 'Escape') { closeLogViewer(); e.preventDefault(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    e.preventDefault();
    document.getElementById('log-search').focus();
  }
});
</script>
</body></html>`;
}

// --- Metrics ---

/**
 * Inferir actividad histórica desde timestamps de archivos procesados y activity log.
 * Genera snapshots sintéticos para poblar /metrics cuando no hay datos del Pulpo.
 */
function inferHistoricalActivity() {
  const events = []; // { ts, type, fase, skill }

  // 1. Archivos procesados/listo de todas las fases — cada uno es un "agente terminó"
  const config = loadConfig();
  for (const [pName, pConfig] of Object.entries(config.pipelines)) {
    for (const fase of pConfig.fases) {
      for (const estado of ['procesado', 'listo', 'trabajando', 'pendiente']) {
        const dir = path.join(PIPELINE, pName, fase, estado);
        for (const f of listWorkFiles(dir)) {
          const st = fileStat(path.join(dir, f));
          if (!st) continue;
          const skill = f.split('.').slice(1).join('.');
          // birthtime = creación, ctime = movido a este dir
          if (st.birthtimeMs > 0) events.push({ ts: st.birthtimeMs, type: 'start', fase, skill });
          if (st.ctimeMs > st.birthtimeMs) events.push({ ts: st.ctimeMs, type: 'end', fase, skill });
        }
      }
    }
  }

  // 2. Activity log — tool calls como proxy de actividad
  try {
    const archiveFile = path.join(path.dirname(PIPELINE), '.claude', 'activity-log.archive.jsonl');
    const lines = fs.readFileSync(archiveFile, 'utf8').split('\n').filter(Boolean);
    for (const l of lines) {
      try {
        const d = JSON.parse(l);
        const ts = typeof d.ts === 'string' ? new Date(d.ts).getTime() : d.ts;
        if (ts > 0) events.push({ ts, type: 'tool', fase: 'agent', skill: d.session?.slice(0, 8) || '' });
      } catch {}
    }
  } catch {}

  if (events.length === 0) return [];

  // Ordenar y agrupar en buckets de 5min
  events.sort((a, b) => a.ts - b.ts);
  const BUCKET_MS = 300000; // 5 minutos
  const minTs = events[0].ts;
  const maxTs = events[events.length - 1].ts;
  const snapshots = [];

  for (let t = minTs; t <= maxTs; t += BUCKET_MS) {
    const bucketEnd = t + BUCKET_MS;
    const inBucket = events.filter(e => e.ts >= t && e.ts < bucketEnd);
    const agents = new Set(inBucket.filter(e => e.type === 'start' || e.type === 'tool').map(e => e.skill)).size;
    const byFase = {};
    for (const e of inBucket) {
      if (!byFase[e.fase]) byFase[e.fase] = { working: 0, pending: 0 };
      if (e.type === 'start') byFase[e.fase].working++;
      if (e.type === 'end') byFase[e.fase].pending++;
    }
    // Estimar CPU/RAM basándose en cantidad de agentes activos
    const estCpu = Math.min(95, agents * 20 + (inBucket.length > 5 ? 15 : 5));
    const estMem = Math.min(95, 40 + agents * 12);
    const level = estCpu > 90 || estMem > 90 ? 'red' : estCpu > 80 || estMem > 80 ? 'orange' : estCpu > 65 || estMem > 65 ? 'yellow' : 'green';

    snapshots.push({
      ts: t,
      cpu: estCpu,
      mem: estMem,
      level,
      agents,
      byFase,
      inferred: true // Marcar como dato inferido
    });
  }

  return snapshots;
}

function getMetricsData() {
  const metricsFile = path.join(PIPELINE, 'metrics-history.jsonl');
  let snapshots = [];
  try {
    const lines = fs.readFileSync(metricsFile, 'utf8').split('\n').filter(Boolean);
    for (const l of lines) {
      try { snapshots.push(JSON.parse(l)); } catch {}
    }
  } catch {}

  // Si no hay snapshots del Pulpo, inferir actividad histórica desde archivos procesados
  // Esto da una timeline de cuándo hubo trabajo en cada fase
  if (snapshots.length < 10) {
    const inferred = inferHistoricalActivity();
    if (inferred.length > snapshots.length) snapshots = inferred;
  }

  // Promedios de duración por fase/skill (reusar lógica de ETA)
  const state = getPipelineState();
  const etaAverages = state.etaAverages || {};

  // Throughput: issues completados por período (de archivos en entrega/procesado)
  const entregas = [];
  try {
    const dir = path.join(PIPELINE, 'desarrollo', 'entrega', 'procesado');
    for (const f of listWorkFiles(dir)) {
      const st = fileStat(path.join(dir, f));
      if (st) entregas.push({ issue: f.split('.')[0], ts: st.ctimeMs });
    }
  } catch {}
  entregas.sort((a, b) => a.ts - b.ts);

  // Cuota Anthropic estimada (del activity log)
  const tokenEstimates = { totalSessions: 0, totalTools: 0, totalEstimatedTokens: 0, bySession: [] };
  try {
    const archiveFile = path.join(path.dirname(PIPELINE), '.claude', 'activity-log.archive.jsonl');
    const lines = fs.readFileSync(archiveFile, 'utf8').split('\n').filter(Boolean);
    const sessions = {};
    for (const l of lines) {
      try {
        const d = JSON.parse(l);
        if (!d.session) continue;
        if (!sessions[d.session]) sessions[d.session] = { tools: 0, firstTs: d.ts, lastTs: d.ts };
        sessions[d.session].tools++;
        sessions[d.session].lastTs = d.ts;
      } catch {}
    }
    for (const [id, s] of Object.entries(sessions)) {
      const durSeg = typeof s.firstTs === 'string' && typeof s.lastTs === 'string'
        ? (new Date(s.lastTs) - new Date(s.firstTs)) / 1000
        : typeof s.firstTs === 'number' ? (s.lastTs - s.firstTs) / 1000 : 0;
      const estimated = Math.round((durSeg * 15) + (s.tools * 500));
      tokenEstimates.totalSessions++;
      tokenEstimates.totalTools += s.tools;
      tokenEstimates.totalEstimatedTokens += estimated;
      tokenEstimates.bySession.push({ id: id.slice(0, 8), tools: s.tools, durMin: Math.round(durSeg / 60), tokens: estimated });
    }
  } catch {}

  // Tasa de rebotes (rechazos / total)
  let totalProcessed = 0, totalRejected = 0;
  const config = loadConfig();
  const allFases = [];
  for (const [pName, pConfig] of Object.entries(config.pipelines)) {
    for (const fase of pConfig.fases) allFases.push({ pipeline: pName, fase });
  }
  for (const { pipeline: pName, fase } of allFases) {
    for (const estado of ['procesado', 'listo']) {
      const dir = path.join(PIPELINE, pName, fase, estado);
      for (const f of listWorkFiles(dir)) {
        totalProcessed++;
        const data = readYamlSafe(path.join(dir, f));
        if (data.resultado === 'rechazado') totalRejected++;
      }
    }
  }

  // Agent performance: issues procesados por skill, duración promedio, rechazos
  const agentPerf = {};
  for (const { pipeline: pName, fase } of allFases) {
    for (const estado of ['procesado', 'listo']) {
      const dir = path.join(PIPELINE, pName, fase, estado);
      for (const f of listWorkFiles(dir)) {
        const skill = f.split('.').slice(1).join('.');
        if (!skill) continue;
        if (!agentPerf[skill]) agentPerf[skill] = { issues: 0, rejected: 0, totalDurMs: 0, durCount: 0, toolCalls: 0 };
        agentPerf[skill].issues++;
        const data = readYamlSafe(path.join(dir, f));
        if (data.resultado === 'rechazado') agentPerf[skill].rejected++;
        const st = fileStat(path.join(dir, f));
        if (st) {
          const dur = st.ctimeMs - st.birthtimeMs;
          if (dur > 5000 && dur < 4 * 3600000) {
            agentPerf[skill].totalDurMs += dur;
            agentPerf[skill].durCount++;
          }
        }
      }
    }
  }
  // Enriquecer con tool calls del activity log
  try {
    const archiveFile = path.join(path.dirname(PIPELINE), '.claude', 'activity-log.archive.jsonl');
    const lines = fs.readFileSync(archiveFile, 'utf8').split('\n').filter(Boolean);
    const sessionSkill = {};
    for (const l of lines) {
      try {
        const d = JSON.parse(l);
        if (d.session && d.skill) sessionSkill[d.session] = d.skill;
        if (d.session && d.tool) {
          const sk = sessionSkill[d.session] || d.session;
          if (agentPerf[sk]) agentPerf[sk].toolCalls++;
        }
      } catch {}
    }
  } catch {}

  return { snapshots, etaAverages, entregas, tokenEstimates, totalProcessed, totalRejected, agentPerf };
}

function generateMetricsHTML() {
  const data = getMetricsData();
  const { snapshots, etaAverages, entregas, tokenEstimates, totalProcessed, totalRejected, agentPerf } = data;

  // Últimas 1h, 6h, 24h de snapshots
  const now = Date.now();
  const snap1h = snapshots.filter(s => now - s.ts < 3600000);
  const snap6h = snapshots.filter(s => now - s.ts < 21600000);
  const snap24h = snapshots;

  // CPU/RAM promedios
  const avgCpu = (arr) => arr.length ? Math.round(arr.reduce((a, s) => a + s.cpu, 0) / arr.length) : 0;
  const avgMem = (arr) => arr.length ? Math.round(arr.reduce((a, s) => a + s.mem, 0) / arr.length) : 0;
  const maxCpu = (arr) => arr.length ? Math.max(...arr.map(s => s.cpu)) : 0;
  const maxMem = (arr) => arr.length ? Math.max(...arr.map(s => s.mem)) : 0;
  const avgAgents = (arr) => arr.length ? (arr.reduce((a, s) => a + s.agents, 0) / arr.length).toFixed(1) : 0;

  // Throughput
  const delivered24h = entregas.filter(e => now - e.ts < 86400000).length;
  const delivered7d = entregas.length;

  // Tiempo en cada nivel de presión (últimas 24h)
  const levelCounts = { green: 0, yellow: 0, orange: 0, red: 0 };
  for (const s of snap24h) levelCounts[s.level] = (levelCounts[s.level] || 0) + 1;
  const totalSnaps = snap24h.length || 1;
  const levelPct = {};
  for (const [l, c] of Object.entries(levelCounts)) levelPct[l] = Math.round(c / totalSnaps * 100);

  // Rebote rate
  const reboteRate = totalProcessed > 0 ? Math.round(totalRejected / totalProcessed * 100) : 0;

  // Cuota Anthropic
  const tokM = (tokenEstimates.totalEstimatedTokens / 1000000).toFixed(1);
  const costEst = (tokenEstimates.totalEstimatedTokens / 1000000 * 3).toFixed(2); // ~$3/MTok estimate

  // Sparkline y chart data
  const sparkData = snap1h.length > 2 ? snap1h.slice(-60) : snapshots.slice(-120);
  const cpuSpark = sparkData.map(s => s.cpu);
  const memSpark = sparkData.map(s => s.mem);
  const agentSpark = sparkData.map(s => s.agents);

  function sparkline(values, max, color) {
    if (values.length < 2) return '<span class="dim">sin datos</span>';
    const w = 300, h = 40;
    const step = w / (values.length - 1);
    const points = values.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max * h)).toFixed(1)}`).join(' ');
    return `<svg width="${w}" height="${h}" class="sparkline"><polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5"/></svg>`;
  }

  // Gráfico grande (para sección de históricos)
  function chart(values, max, color, label, unit, thresholds) {
    if (values.length < 2) return '<div class="dim" style="padding:20px">Sin datos suficientes. El Pulpo genera snapshots cada 30s cuando corre.</div>';
    const w = 800, h = 160, pad = 40;
    const pw = w - pad * 2, ph = h - pad;
    const step = pw / (values.length - 1);
    const points = values.map((v, i) => `${(pad + i * step).toFixed(1)},${(h - pad - (v / max * ph)).toFixed(1)}`).join(' ');
    // Area fill
    const areaPoints = `${pad},${h - pad} ${points} ${(pad + (values.length - 1) * step).toFixed(1)},${h - pad}`;
    // Y axis labels
    const yLabels = [0, 25, 50, 75, 100].map(v => {
      const y = h - pad - (v / max * ph);
      return `<text x="${pad - 5}" y="${y + 4}" text-anchor="end" fill="#8b949e" font-size="10">${v}${unit}</text><line x1="${pad}" y1="${y}" x2="${w - pad}" y2="${y}" stroke="#21262d" stroke-width="0.5"/>`;
    }).join('');
    // X axis time labels (first, middle, last)
    const tsFirst = sparkData[0]?.ts;
    const tsLast = sparkData[sparkData.length - 1]?.ts;
    const fmtTs = (ts) => ts ? new Date(ts).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) : '';
    const xLabels = tsFirst ? `<text x="${pad}" y="${h - 5}" fill="#8b949e" font-size="10">${fmtTs(tsFirst)}</text><text x="${w - pad}" y="${h - 5}" text-anchor="end" fill="#8b949e" font-size="10">${fmtTs(tsLast)}</text>` : '';
    // Threshold lines
    let thresholdLines = '';
    if (thresholds) {
      for (const [val, col] of thresholds) {
        const y = h - pad - (val / max * ph);
        thresholdLines += `<line x1="${pad}" y1="${y}" x2="${w - pad}" y2="${y}" stroke="${col}" stroke-width="1" stroke-dasharray="4,4" opacity="0.5"/>`;
      }
    }
    // Avg line
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const avgY = h - pad - (avg / max * ph);

    return `<svg viewBox="0 0 ${w} ${h}" class="chart">
      ${yLabels}${xLabels}${thresholdLines}
      <polygon points="${areaPoints}" fill="${color}" opacity="0.1"/>
      <polyline points="${points}" fill="none" stroke="${color}" stroke-width="2"/>
      <line x1="${pad}" y1="${avgY}" x2="${w - pad}" y2="${avgY}" stroke="${color}" stroke-width="1" stroke-dasharray="2,4" opacity="0.6"/>
      <text x="${w - pad + 5}" y="${avgY + 4}" fill="${color}" font-size="10">avg ${avg.toFixed(0)}${unit}</text>
      <text x="${pad}" y="14" fill="#e6edf3" font-size="12" font-weight="600">${label}</text>
    </svg>`;
  }

  const isInferred = snapshots.length > 0 && snapshots[0].inferred;
  const dataSourceLabel = isInferred
    ? '⚠️ Datos inferidos desde timestamps de archivos (el Pulpo no estaba corriendo). Precisión limitada.'
    : `📊 ${snapshots.length} snapshots reales del Pulpo (${snapshots.length > 0 ? fmtDuration(now - snapshots[0].ts) : '0'} de historia)`;

  // ETA averages table
  let etaRows = '';
  const faseOrder = ['analisis', 'criterios', 'sizing', 'validacion', 'dev', 'build', 'verificacion', 'aprobacion', 'entrega'];
  for (const fase of faseOrder) {
    const avg = etaAverages[fase];
    if (!avg?.avgMs) continue;
    // Skills detail
    const skills = Object.entries(etaAverages)
      .filter(([k]) => k.startsWith(fase + '/'))
      .map(([k, v]) => `${k.split('/')[1]}: ${fmtDuration(v.avgMs)}`)
      .join(', ');
    etaRows += `<tr><td>${fase}</td><td>${fmtDuration(avg.avgMs)}</td><td>${avg.count}</td><td class="dim">${skills}</td></tr>`;
  }

  // Session table (top 10 by tokens)
  const topSessions = tokenEstimates.bySession.sort((a, b) => b.tokens - a.tokens).slice(0, 10);
  let sessionRows = topSessions.map(s =>
    `<tr><td>${s.id}</td><td>${s.tools}</td><td>${s.durMin}min</td><td>${(s.tokens / 1000).toFixed(0)}K</td></tr>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="es"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Métricas — Pipeline V2</title>
<style>
:root{--bg:#0d1117;--sf:#161b22;--sf2:#1c2128;--bd:#30363d;--tx:#e6edf3;--dim:#8b949e;--ac:#58a6ff;--gn:#3fb950;--yl:#d29922;--or:#db6d28;--rd:#f85149;--radius:10px}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--tx);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;padding:20px 24px;font-size:15px;line-height:1.5}
a{color:var(--ac);text-decoration:none}
h1{font-size:1.5em;margin-bottom:20px;display:flex;align-items:center;gap:10px}
h2{font-size:1.1em;color:var(--tx);margin-bottom:12px;border-bottom:1px solid var(--bd);padding-bottom:6px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;margin-bottom:24px}
.card{background:var(--sf);border:1px solid var(--bd);border-radius:var(--radius);padding:16px}
.card-value{font-size:2em;font-weight:700}
.card-label{color:var(--dim);font-size:0.85em}
.card-sub{color:var(--dim);font-size:0.78em;margin-top:4px}
.green{color:var(--gn)}.yellow{color:var(--yl)}.orange{color:var(--or)}.red{color:var(--rd)}.blue{color:var(--ac)}
table{width:100%;border-collapse:collapse;font-size:0.88em}
th{text-align:left;color:var(--dim);padding:6px 10px;border-bottom:1px solid var(--bd);font-weight:600}
td{padding:6px 10px;border-bottom:1px solid var(--bd)}
.dim{color:var(--dim)}
.sparkline{display:block;margin-top:8px}
.level-bar{display:flex;height:20px;border-radius:6px;overflow:hidden;margin:8px 0}
.level-bar>div{height:100%;display:flex;align-items:center;justify-content:center;font-size:0.7em;font-weight:700;color:#000}
.back-link{margin-bottom:16px;display:inline-block}
.chart{width:100%;height:auto;max-height:200px}
.chart-grid{display:grid;grid-template-columns:1fr;gap:12px}
.section{margin-bottom:28px}
.section-ref{font-size:0.65em;color:var(--dim);font-weight:400;font-style:italic;letter-spacing:0;text-transform:none;margin-left:8px}
.bar-h{position:relative;height:12px;background:var(--bd);border-radius:4px;overflow:hidden;min-width:80px}
.bar-h-fill{height:100%;border-radius:4px;transition:width 0.4s}
.bar-h-label{font-size:0.82em;margin-right:8px;min-width:70px;display:inline-block}
.bar-h-value{font-size:0.82em;margin-left:8px;font-weight:600}
.dora-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:16px}
.dora-card{background:var(--sf);border:1px solid var(--bd);border-radius:var(--radius);padding:18px;text-align:center}
.dora-value{font-size:2.2em;font-weight:800;font-variant-numeric:tabular-nums;line-height:1.1}
.dora-target{font-size:0.78em;color:var(--dim);margin-top:8px;display:flex;align-items:center;justify-content:center;gap:6px}
.dora-dot{width:8px;height:8px;border-radius:50%;display:inline-block}
.reco-card p{margin-bottom:8px;line-height:1.5;font-size:0.9em}
.reco-card strong{font-weight:700}
.trend-up{color:var(--gn)}.trend-down{color:var(--rd)}.trend-flat{color:var(--dim)}
</style></head><body>
<a href="/" class="back-link">← Dashboard</a>
<h1>📊 Métricas del Pipeline</h1>

<div class="grid">
  <div class="card">
    <div class="card-value blue">${snap24h.length}</div>
    <div class="card-label">Snapshots (24h)</div>
    <div class="card-sub">${snap1h.length} última hora · ${snap6h.length} últimas 6h</div>
  </div>
  <div class="card">
    <div class="card-value">${avgCpu(snap1h)}%<span class="dim" style="font-size:0.5em"> / ${maxCpu(snap1h)}% max</span></div>
    <div class="card-label">CPU promedio (1h)</div>
    ${sparkline(cpuSpark, 100, '#f85149')}
  </div>
  <div class="card">
    <div class="card-value">${avgMem(snap1h)}%<span class="dim" style="font-size:0.5em"> / ${maxMem(snap1h)}% max</span></div>
    <div class="card-label">RAM promedio (1h)</div>
    ${sparkline(memSpark, 100, '#d29922')}
  </div>
  <div class="card">
    <div class="card-value">${avgAgents(snap1h)}</div>
    <div class="card-label">Agentes promedio (1h)</div>
    ${sparkline(agentSpark, 5, '#58a6ff')}
  </div>
</div>

<div class="grid">
  <div class="card">
    <div class="card-value green">${delivered24h}</div>
    <div class="card-label">Issues entregados (24h)</div>
    <div class="card-sub">${delivered7d} total histórico</div>
  </div>
  <div class="card">
    <div class="card-value ${reboteRate > 30 ? 'red' : reboteRate > 15 ? 'yellow' : 'green'}">${reboteRate}%</div>
    <div class="card-label">Tasa de rechazo</div>
    <div class="card-sub">${totalRejected} rechazados / ${totalProcessed} procesados</div>
  </div>
  <div class="card">
    <div class="card-value blue">${tokM}M</div>
    <div class="card-label">Tokens estimados (total)</div>
    <div class="card-sub">~$${costEst} USD · ${tokenEstimates.totalSessions} sesiones · ${tokenEstimates.totalTools} herramientas</div>
  </div>
  <div class="card">
    <div class="card-label">Presión de recursos (24h)</div>
    <div class="level-bar">
      ${levelPct.green > 0 ? `<div style="width:${levelPct.green}%;background:var(--gn)">${levelPct.green}%</div>` : ''}
      ${levelPct.yellow > 0 ? `<div style="width:${levelPct.yellow}%;background:var(--yl)">${levelPct.yellow}%</div>` : ''}
      ${levelPct.orange > 0 ? `<div style="width:${levelPct.orange}%;background:var(--or)">${levelPct.orange}%</div>` : ''}
      ${levelPct.red > 0 ? `<div style="width:${levelPct.red}%;background:var(--rd)">${levelPct.red}%</div>` : ''}
    </div>
    <div class="card-sub">🟢 ${levelPct.green || 0}% · 🟡 ${levelPct.yellow || 0}% · 🟠 ${levelPct.orange || 0}% · 🔴 ${levelPct.red || 0}%</div>
  </div>
</div>

<div class="section">
<h2>📈 Gráficos históricos</h2>
<div class="card-sub" style="margin-bottom:12px">${dataSourceLabel}</div>
<div class="chart-grid">
  <div class="card">${chart(snapshots.map(s => s.cpu), 100, '#f85149', 'CPU %', '%', [[65, '#d29922'], [80, '#db6d28'], [90, '#f85149']])}</div>
  <div class="card">${chart(snapshots.map(s => s.mem), 100, '#d29922', 'RAM %', '%', [[65, '#d29922'], [80, '#db6d28'], [90, '#f85149']])}</div>
  <div class="card">${chart(snapshots.map(s => s.agents), 6, '#58a6ff', 'Agentes activos', '', [])}</div>
</div>
</div>

<div class="section">
<h2>⏱ Velocidad por fase (promedios históricos)</h2>
<table>
<thead><tr><th>Fase</th><th>Promedio</th><th>Muestras</th><th>Detalle por skill</th></tr></thead>
<tbody>${etaRows || '<tr><td colspan="4" class="dim">Sin datos históricos</td></tr>'}</tbody>
</table>
</div>

<div class="section">
<h2>🤖 Cuota Anthropic — Top sesiones por consumo estimado</h2>
<table>
<thead><tr><th>Sesión</th><th>Herramientas</th><th>Duración</th><th>Tokens est.</th></tr></thead>
<tbody>${sessionRows || '<tr><td colspan="4" class="dim">Sin datos</td></tr>'}</tbody>
</table>
<div class="card-sub" style="margin-top:8px">⚠️ Tokens estimados por proxy: (duración_seg × 15) + (tools × 500). Calibrar con dashboard de Anthropic.</div>
</div>


${(() => {
  // --- Velocity Section ---
  const now7d = Date.now() - 7 * 86400000;
  const now14d = Date.now() - 14 * 86400000;
  const delivered7d_v = entregas.filter(e => e.ts >= now7d).length;
  const delivered14d_v = entregas.filter(e => e.ts >= now14d && e.ts < now7d).length;
  const throughput7d = (delivered7d_v / 7).toFixed(1);
  const throughputTrend = delivered14d_v > 0 ? Math.round((delivered7d_v - delivered14d_v) / delivered14d_v * 100) : 0;
  const trendIcon = throughputTrend > 5 ? '↑' : throughputTrend < -5 ? '↓' : '→';
  const trendColor = throughputTrend > 5 ? 'var(--gn)' : throughputTrend < -5 ? 'var(--rd)' : 'var(--dim)';

  // Cycle time estimado (suma promedios de fases)
  let cycleTimeMs = 0;
  for (const [key, d] of Object.entries(etaAverages)) {
    if (!key.includes('/') && d.avgMs) cycleTimeMs += d.avgMs;
  }

  // Daily series for sparkbar
  const dailySeries = [];
  for (let i = 6; i >= 0; i--) {
    const dayStart = Date.now() - (i + 1) * 86400000;
    const dayEnd = Date.now() - i * 86400000;
    const count = entregas.filter(e => e.ts >= dayStart && e.ts < dayEnd).length;
    const dayLabel = new Date(dayEnd).toLocaleDateString('es-AR', { weekday: 'short' }).slice(0, 2);
    dailySeries.push({ label: dayLabel, count });
  }
  const maxD = Math.max(1, ...dailySeries.map(d => d.count));
  const bars = dailySeries.map(d => {
    const h = Math.max(2, Math.round(d.count / maxD * 32));
    return '<div style="display:inline-flex;flex-direction:column;align-items:center;gap:2px;min-width:32px"><div style="height:' + h + 'px;width:16px;background:var(--ac);border-radius:3px 3px 0 0;opacity:' + (d.count > 0 ? '1' : '0.2') + '"></div><span style="font-size:0.7em;color:var(--dim)">' + d.label + '</span></div>';
  }).join('');

  return '<div id="velocidad" class="section"><h2>🚀 Velocidad de entrega <span class="section-ref">Jez Humble · DORA metrics</span></h2><div class="grid"><div class="card"><div class="card-value" style="color:' + trendColor + '">' + throughput7d + '<span class="dim" style="font-size:0.4em"> /día</span></div><div class="card-label">Throughput (7d) <span style="color:' + trendColor + '">' + trendIcon + ' ' + (throughputTrend > 0 ? '+' : '') + throughputTrend + '%</span></div><div style="display:flex;align-items:flex-end;gap:2px;margin-top:10px;height:40px">' + bars + '</div></div><div class="card"><div class="card-value blue">' + fmtDuration(cycleTimeMs) + '</div><div class="card-label">Cycle Time estimado</div><div class="card-sub">Suma de promedios por fase</div></div><div class="card"><div class="card-value green">' + delivered24h + '</div><div class="card-label">Entregados hoy</div><div class="card-sub">' + delivered7d + ' total histórico</div></div></div></div>';
})()}

${(() => {
  // --- Agent Performance Section ---
  const PERSONA = {
    guru: { icon: '🧠', color: '#bc8cff', ref: 'Hickey · Henney' },
    security: { icon: '🔒', color: '#f85149', ref: 'Hunt · Schneier' },
    po: { icon: '📋', color: '#d29922', ref: 'Cagan · Torres' },
    ux: { icon: '🎨', color: '#f778ba', ref: 'Norman · Nielsen' },
    planner: { icon: '📐', color: '#a371f7', ref: 'Singer · Ward' },
    'backend-dev': { icon: '⚡', color: '#3fb950', ref: 'Fowler · Martin' },
    'android-dev': { icon: '📱', color: '#58a6ff', ref: 'Wharton · Guy' },
    'web-dev': { icon: '🌐', color: '#79c0ff', ref: 'Osmani · Russell' },
    tester: { icon: '🧪', color: '#d2a8ff', ref: 'Beck · Meszaros' },
    qa: { icon: '✅', color: '#3fb950', ref: 'Bach · Crispin' },
    review: { icon: '👁️', color: '#ffa657', ref: 'Greiler · Google' },
    delivery: { icon: '🚀', color: '#f0883e', ref: 'Humble · Farley' },
    build: { icon: '🏗️', color: '#8b949e', ref: 'Pipeline' },
  };

  const perfEntries = Object.entries(agentPerf || {}).sort((a, b) => b[1].issues - a[1].issues);
  if (perfEntries.length === 0) return '';

  const maxIssues = Math.max(1, ...perfEntries.map(([, a]) => a.issues));
  const rows = perfEntries.map(([skill, a]) => {
    const p = PERSONA[skill] || { icon: '⚙', color: 'var(--dim)', ref: '' };
    const avgDur = a.durCount > 0 ? fmtDuration(Math.round(a.totalDurMs / a.durCount)) : '—';
    const failRate = a.issues > 0 ? Math.round(a.rejected / a.issues * 100) : 0;
    const failColor = failRate > 30 ? 'var(--rd)' : failRate > 15 ? 'var(--yl)' : 'var(--gn)';
    const bw = Math.max(2, Math.round(a.issues / maxIssues * 100));
    return '<tr><td><span style="color:' + p.color + '">' + p.icon + ' <strong>' + skill + '</strong></span><div style="font-size:0.7em;color:var(--dim);font-style:italic">' + p.ref + '</div></td><td>' + a.issues + '</td><td><div class="bar-h"><div class="bar-h-fill" style="width:' + bw + '%;background:' + p.color + '"></div></div></td><td>' + avgDur + '</td><td style="color:' + failColor + '">' + failRate + '%</td><td>' + a.toolCalls + '</td></tr>';
  }).join('');

  return '<div id="agentes" class="section"><h2>🤖 Rendimiento por agente</h2><table><thead><tr><th>Agente</th><th>Issues</th><th style="min-width:120px">Volumen</th><th>Duración avg</th><th>Rechazo %</th><th>Tool calls</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
})()}

${(() => {
  // --- DORA Section ---
  const now7d = Date.now() - 7 * 86400000;
  const d7 = entregas.filter(e => e.ts >= now7d).length;
  const doraTP = (d7 / 7).toFixed(1);
  const doraFR = totalProcessed > 0 ? Math.round(totalRejected / totalProcessed * 100) : 0;
  let doraLT = 0;
  for (const [key, d] of Object.entries(etaAverages)) {
    if (!key.includes('/') && d.avgMs) doraLT += d.avgMs;
  }

  const chk = (val, target, inv) => {
    if (!val) return { color: 'var(--dim)', label: 'SIN DATOS', cls: 'dim' };
    return (inv ? val <= target : val >= target)
      ? { color: 'var(--gn)', label: 'ELITE', cls: 'green' }
      : (inv ? val <= target * 2 : val >= target / 2)
        ? { color: 'var(--yl)', label: 'MEDIO', cls: 'yellow' }
        : { color: 'var(--rd)', label: 'BAJO', cls: 'red' };
  };

  const lt = chk(doraLT, 6 * 3600000, true);
  const tp = chk(parseFloat(doraTP), 2, false);
  const cfr = chk(100 - doraFR, 85, false);

  return '<div id="dora" class="section"><h2>📐 DORA Adaptado <span class="section-ref">Nicole Forsgren · Accelerate</span></h2><div class="card-sub" style="margin-bottom:12px">Métricas DORA adaptadas para pipeline de agentes AI · Ventana rolling 7d</div><div class="dora-grid"><div class="dora-card"><div class="dora-value" style="color:' + lt.color + '">' + (doraLT > 0 ? fmtDuration(doraLT) : '—') + '</div><div class="card-label">Lead Time</div><div class="dora-target"><span class="dora-dot" style="background:' + lt.color + '"></span>' + lt.label + ' · target < 6h</div></div><div class="dora-card"><div class="dora-value" style="color:' + tp.color + '">' + doraTP + '/día</div><div class="card-label">Throughput</div><div class="dora-target"><span class="dora-dot" style="background:' + tp.color + '"></span>' + tp.label + ' · target > 2/día</div></div><div class="dora-card"><div class="dora-value" style="color:' + cfr.color + '">' + doraFR + '%</div><div class="card-label">Change Failure Rate</div><div class="dora-target"><span class="dora-dot" style="background:' + cfr.color + '"></span>' + cfr.label + ' · target < 15%</div></div></div></div>';
})()}

<div class="section">
<h2>💡 Recomendaciones inteligentes</h2>
<div class="card reco-card">
${maxMem(snap1h) > 85 ? '<p class="red">⚠️ <strong>Perf (Brendan Gregg):</strong> RAM pico > 85% — Saturation alta. Reducir concurrencia o upgrade memoria.</p>' : ''}
${maxCpu(snap1h) > 90 ? '<p class="red">⚠️ <strong>Perf (Gregg):</strong> CPU pico > 90% — Utilization crítica. Reducir builds paralelos.</p>' : ''}
${reboteRate > 30 ? '<p class="orange">⚠️ <strong>QA (James Bach):</strong> Tasa de rechazo ${reboteRate}% — Explorar root cause en prompts de agentes dev.</p>' : ''}
${reboteRate > 15 && reboteRate <= 30 ? '<p class="yellow">⚠️ <strong>Delivery (Forsgren):</strong> Change failure rate ${reboteRate}% — Por encima del target DORA elite (< 15%).</p>' : ''}
${levelPct.red > 10 ? '<p class="red">⚠️ <strong>Planner (Reinertsen):</strong> Sistema en rojo ' + levelPct.red + '% del tiempo — Batch size excesivo, limitar WIP.</p>' : ''}
${levelPct.green > 80 ? '<p class="green">✅ <strong>Scrum (Vacanti):</strong> Flow saludable — recursos bien dimensionados para la carga actual.</p>' : ''}
${delivered24h === 0 && snap24h.length > 0 ? '<p class="yellow">⚠️ <strong>PO (Cagan):</strong> 0 entregas en 24h con pipeline activo — Verificar si el trabajo avanza hacia outcomes.</p>' : ''}
<p class="dim" style="margin-top:8px">${dataSourceLabel}</p>
</div>
</div>

<div style="color:var(--dim);font-size:0.8em;margin-top:20px">
🔴 Live · <a href="/api/metrics">API JSON</a> · <a href="/">← Dashboard</a> · ${new Date().toLocaleString('es-AR')}
</div>
</body></html>`;
}

// --- Server ---

const server = http.createServer((req, res) => {
  // Servir logs como archivos estáticos (fallback para abrir en nueva pestaña)
  if (req.url.startsWith('/logs/') && !req.url.startsWith('/logs/stream/')) {
    const filename = path.basename(req.url.slice(6)).replace(/[^a-zA-Z0-9\-\.]/g, '');
    const logPath = path.join(LOG_DIR, filename);
    if (fs.existsSync(logPath)) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(fs.readFileSync(logPath, 'utf8'));
    } else {
      res.writeHead(404); res.end('Log no encontrado: ' + filename);
    }
    return;
  }

  // SSE log streaming — tail -f style
  if (req.url.startsWith('/logs/stream/')) {
    const filename = path.basename(req.url.slice(13)).replace(/[^a-zA-Z0-9\-\.]/g, '');
    const logPath = path.join(LOG_DIR, filename);
    if (!fs.existsSync(logPath)) {
      res.writeHead(404); res.end('Log no encontrado');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    // Send initial content (last 1000 lines)
    const content = fs.readFileSync(logPath, 'utf8');
    const lines = content.split('\n');
    const initialLines = lines.slice(-1000);
    res.write(`data: ${JSON.stringify({ type: 'init', lines: initialLines })}\n\n`);

    // Watch for changes
    let lastSize = fs.statSync(logPath).size;
    const interval = setInterval(() => {
      try {
        if (!fs.existsSync(logPath)) return;
        const stat = fs.statSync(logPath);
        if (stat.size > lastSize) {
          const fd = fs.openSync(logPath, 'r');
          const buf = Buffer.alloc(stat.size - lastSize);
          fs.readSync(fd, buf, 0, buf.length, lastSize);
          fs.closeSync(fd);
          const newLines = buf.toString('utf8').split('\n').filter(l => l.length > 0);
          if (newLines.length > 0) {
            res.write(`data: ${JSON.stringify({ type: 'append', lines: newLines })}\n\n`);
          }
          lastSize = stat.size;
        }
      } catch {}
    }, 800);

    req.on('close', () => clearInterval(interval));
    return;
  }

  // SSE endpoint para live refresh
  if (req.url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    const send = () => {
      try {
        const state = getPipelineState();
        const hash = crypto.createHash('md5').update(JSON.stringify(state.issueMatrix)).digest('hex').slice(0, 8);
        res.write(`data: ${hash}\n\n`);
      } catch {}
    };
    send();
    const interval = setInterval(send, 5000);
    req.on('close', () => clearInterval(interval));
    return;
  }

  // API: acciones start/stop
  if (req.url === '/api/action' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { target, action, component } = JSON.parse(body);
        let result;
        if (target === 'qa') {
          result = qaAction(action, component); // component: 'emulator' (dynamo/backend are remote AWS)
        } else if (action === 'start') {
          result = startComponent(target);
        } else if (action === 'stop') {
          result = stopComponent(target);
        } else {
          result = { ok: false, msg: `Acción "${action}" no válida` };
        }
        log(`Action: ${action} ${target} → ${result.ok ? '✓' : '✗'} ${result.msg}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, msg: e.message }));
      }
    });
    return;
  }

  // API: Kill agent (cancelar agente activo)
  if (req.url === '/api/kill-agent' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { issue, skill, pipeline: pl, fase } = JSON.parse(body);
        const trabajandoDir = path.join(PIPELINE, pl, fase, 'trabajando');
        const pendienteDir = path.join(PIPELINE, pl, fase, 'pendiente');
        const filename = `${issue}.${skill}`;

        // Buscar el archivo en trabajando/
        const filepath = path.join(trabajandoDir, filename);
        if (!fs.existsSync(filepath)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, msg: `No encontrado: ${filename} en ${pl}/${fase}/trabajando` }));
          return;
        }

        // Buscar PID del agente en agent-registry
        let killed = false;
        try {
          const registry = JSON.parse(fs.readFileSync(path.join(path.dirname(PIPELINE), '.claude', 'hooks', 'agent-registry.json'), 'utf8'));
          for (const [, agent] of Object.entries(registry.agents || {})) {
            if (agent.issue === `#${issue}` && agent.pid) {
              try {
                execSync(`taskkill /PID ${agent.pid} /F /T`, { timeout: 5000, windowsHide: true, stdio: 'ignore' });
                killed = true;
              } catch {}
            }
          }
        } catch {}

        // Mover de trabajando/ a pendiente/ (para que pueda ser relanzado)
        try {
          const dest = path.join(pendienteDir, filename);
          fs.renameSync(filepath, dest);
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, msg: `Error moviendo archivo: ${e.message}` }));
          return;
        }

        const msg = killed
          ? `Agente ${skill} #${issue} cancelado (proceso terminado + devuelto a pendiente)`
          : `Agente ${skill} #${issue} devuelto a pendiente (proceso no encontrado en registry)`;
        log(`Kill agent: ${skill} #${issue} en ${pl}/${fase} — ${killed ? 'PID killed' : 'no PID'}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, msg }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, msg: e.message }));
      }
    });
    return;
  }

  // API: Priority Windows toggle (on/off manual)
  if (req.url === '/api/priority-window' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { window: win, action } = JSON.parse(body);
        if (!['qa', 'build'].includes(win)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, msg: `Window "${win}" no válida (qa|build)` }));
          return;
        }
        const pwFile = path.join(PIPELINE, 'priority-windows.json');
        let current = {};
        try { current = JSON.parse(fs.readFileSync(pwFile, 'utf8')); } catch {}
        if (!current.qa) current.qa = { active: false };
        if (!current.build) current.build = { active: false };

        // Escribir manualOverride para que el Pulpo lo consuma en su próximo ciclo
        // También actualizar active/manual inmediatamente para que el dashboard refleje el cambio
        current[win].manualOverride = (action === 'on');
        if (action === 'on') {
          current[win].active = true;
          current[win].manual = true;
          current[win].activatedAt = Date.now();
        } else {
          current[win].active = false;
          current[win].manual = false;
          current[win].activatedAt = null;
        }
        current.updatedAt = Date.now();
        fs.writeFileSync(pwFile, JSON.stringify(current, null, 2));

        const label = win === 'qa' ? 'QA Priority' : 'Build Priority';
        const verb = action === 'on' ? 'activada' : 'desactivada';
        log(`Priority Window: ${label} ${verb} manualmente`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, msg: `${label} Window ${verb} — surte efecto en el próximo ciclo del Pulpo` }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, msg: e.message }));
      }
    });
    return;
  }

  // API JSON
  if (req.url === '/api/state' || req.url === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getPipelineState(), null, 2));
    return;
  }

  // /metrics — Métricas históricas para decisiones de hardware/servicio
  if (req.url === '/metrics') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(generateMetricsHTML());
    return;
  }

  // /api/metrics — Raw metrics data
  if (req.url === '/api/metrics') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getMetricsData()));
    return;
  }

  // HTML dashboard
  const state = getPipelineState();
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(generateHTML(state));
});

server.listen(PORT, () => {
  log(`Dashboard V2 en http://localhost:${PORT}`);
  log(`API: /api/state | Logs: /logs/{file} | SSE: /events`);
});

fs.writeFileSync(path.join(PIPELINE, 'dashboard.pid'), String(process.pid));
process.on('SIGINT', () => { server.close(); process.exit(0); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });

// Crash handlers — loguear antes de morir para diagnóstico
process.on('uncaughtException', (err) => {
  const msg = `[${new Date().toISOString()}] [dashboard] CRASH uncaughtException: ${err.stack || err.message}\n`;
  try { fs.appendFileSync(path.join(LOG_DIR, 'dashboard.log'), msg); } catch {}
  console.error(msg);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  const msg = `[${new Date().toISOString()}] [dashboard] CRASH unhandledRejection: ${reason?.stack || reason}\n`;
  try { fs.appendFileSync(path.join(LOG_DIR, 'dashboard.log'), msg); } catch {}
  console.error(msg);
  process.exit(1);
});

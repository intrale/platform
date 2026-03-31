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
const PIPELINE = path.resolve(__dirname);
const ROOT = path.resolve(__dirname, '..');
const LOG_DIR = path.join(PIPELINE, 'logs');
const GITHUB_BASE = 'https://github.com/intrale/platform/issues';

// --- Componentes gestionables (start/stop) ---
const COMPONENTS = [
  { name: 'pulpo', script: 'pulpo.js', pid: 'pulpo.pid' },
  { name: 'listener', script: 'listener-telegram.js', pid: 'listener.pid' },
  { name: 'svc-telegram', script: 'servicio-telegram.js', pid: 'svc-telegram.pid' },
  { name: 'svc-github', script: 'servicio-github.js', pid: 'svc-github.pid' },
  { name: 'svc-drive', script: 'servicio-drive.js', pid: 'svc-drive.pid' },
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

function qaAction(action) {
  if (!fs.existsSync(QA_ENV_SCRIPT)) return { ok: false, msg: 'qa-environment.js no existe' };
  try {
    const output = execSync(`"${process.execPath}" "${QA_ENV_SCRIPT}" ${action}`, {
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
  try { const s = fs.statSync(filepath); return { ctimeMs: s.ctimeMs, mtimeMs: s.mtimeMs }; }
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
          state.issueMatrix[issue].faseActual = `${pName}/${fase}`;
          state.issueMatrix[issue].estadoActual = estado;
        }
      }
    }
  }
  // Convert Sets to arrays for JSON
  for (const data of Object.values(state.issueMatrix)) {
    data.pipelines = [...data.pipelines];
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
  for (const comp of ['pulpo', 'listener', 'svc-telegram', 'svc-github', 'svc-drive', 'dashboard']) {
    try {
      const pid = fs.readFileSync(path.join(PIPELINE, `${comp}.pid`), 'utf8').trim();
      const alive = isProcessAlive(pid);
      state.procesos[comp] = { pid, alive };
    } catch {
      state.procesos[comp] = { pid: null, alive: false };
    }
  }

  // QA Environment
  state.qaEnv = { dynamo: false, backend: false, emulator: false };
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
    maxCpu: resourceLimits.max_cpu_percent || 80,
    maxMem: resourceLimits.max_mem_percent || 80
  };

  return state;
}

// --- HTML generation ---

function generateHTML(state) {
  const config = state.config;
  const allFases = state.allFases;
  const GH = (num) => `${GITHUB_BASE}/${num}`;

  // Íconos por skill
  const SKILL_ICON = {
    guru: '🧠', security: '🔒', po: '📋', ux: '🎨', planner: '📐',
    'backend-dev': '⚡', 'android-dev': '📱', 'web-dev': '🌐', hotfix: '🔥',
    tester: '🧪', qa: '✅', review: '👁️', delivery: '🚀', build: '🏗️',
    commander: '🤖'
  };
  const skillIcon = (skill) => SKILL_ICON[skill] || '⚙';

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
    return entries.some(e => e.ageMin > 10);
  });
  const stale = staleList.length;

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
  const definidos = lastDefFase ? matrixEntries.filter(([_, d]) => {
    const entries = d.fases[`definicion/${lastDefFase}`] || [];
    return entries.some(e => e.estado === 'procesado');
  }).length : 0;

  // Entregados = completaron la fase final de desarrollo (entrega/procesado)
  const devFasesKpi = config.pipelines?.desarrollo?.fases || [];
  const lastDevFase = devFasesKpi[devFasesKpi.length - 1];
  const entregados = lastDevFase ? matrixEntries.filter(([_, d]) => {
    const entries = d.fases[`desarrollo/${lastDevFase}`] || [];
    return entries.some(e => e.estado === 'procesado');
  }).length : 0;

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

  // Sort: trabajando first, then pendiente, then listo, then procesado
  const sorted = matrixEntries.sort((a, b) => {
    const order = { trabajando: 0, pendiente: 1, listo: 2 };
    const aO = a[1].estadoActual ? (order[a[1].estadoActual] ?? 3) : 4;
    const bO = b[1].estadoActual ? (order[b[1].estadoActual] ?? 3) : 4;
    return aO - bO || parseInt(b[0]) - parseInt(a[0]);
  });

  // Show activos + last 15 procesados
  const shown = sorted.slice(0, Math.max(activos, 0) + 15);

  let rows = '';
  for (const [issueNum, data] of shown) {
    // Progress bar
    const totalFases = defFases.length + devFases.length;
    const completedFases = allFases.filter(({ pipeline, fase }) => {
      const entries = data.fases[`${pipeline}/${fase}`] || [];
      return entries.some(e => e.estado === 'listo' || e.estado === 'procesado');
    }).length;
    const pct = totalFases > 0 ? Math.round(completedFases / totalFases * 100) : 0;

    const issueCell = `<td class="issue-col">
      <a href="${GH(issueNum)}" target="_blank" class="issue-link">#${issueNum}</a>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
      <span class="progress-text">${completedFases}/${totalFases}</span>
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
        const staleClass = (e.estado === 'trabajando' && e.ageMin > 10) ? ' stale-chip' : '';
        // Runs anteriores de un skill repetido se muestran compactos
        const priorClass = (e._isRetry && !e._isLatestRun) ? ' chip-prior' : '';
        const runLabel = e._isRetry ? `<sup class="run-idx">${e._runIndex}</sup>` : '';

        // Tooltip content
        const ttStart = e.startedAt ? `Inicio: ${fmtTime(e.startedAt)}` : '';
        const ttDur = e.durationMs ? `Duración: ${fmtDuration(e.durationMs)}` : '';
        const ttRes = e.resultado ? `Resultado: ${e.resultado === 'aprobado' ? '✓' : '✗'} ${e.resultado}` : '';
        const ttMot = e.motivo ? `Motivo: ${e.motivo.slice(0, 80)}` : '';
        const ttRun = e._isRetry ? `Ejecución: ${e._runIndex}/${e._runTotal}` : '';
        const ttLines = [e.skill, ttRun, ttStart, ttDur, ttRes, ttMot].filter(Boolean);
        const tooltip = `<span class="tt">${ttLines.map(l => `<span>${l}</span>`).join('')}</span>`;

        // Prior runs: solo ícono + índice (sin nombre del skill)
        const chipContent = (e._isRetry && !e._isLatestRun)
          ? `${icon} ${skillIcon(e.skill)}${runLabel}`
          : `${icon} ${skillIcon(e.skill)} ${e.skill}${runLabel}`;

        // Wrap in link if log exists
        const inner = `<span class="chip ${cls}${staleClass}${priorClass}">${chipContent}${tooltip}</span>`;
        if (e.hasLog) {
          return `<a href="/logs/${e.logFile}" target="_blank" class="log-link">${inner}</a>`;
        }
        return inner;
      }).join(' ');

      cells += `<td class="${isCurrent ? 'cell-current' : ''} ${pipeline === 'definicion' ? 'col-def' : 'col-dev'}">${chips}</td>`;
    }

    const rowClass = data.estadoActual ? `issue-${data.estadoActual}` : 'issue-done';
    rows += `<tr class="${rowClass}">${issueCell}${cells}</tr>`;
  }

  const hiddenCount = sorted.length - shown.length;
  if (hiddenCount > 0) {
    rows += `<tr class="issue-done"><td colspan="${allFases.length + 1}" class="more-label">... y ${hiddenCount} issues más finalizados</td></tr>`;
  }

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
    </div>`;

  // Skill heatmap
  let heatmapHTML = '';
  for (const [skill, load] of Object.entries(state.skillLoad)) {
    const pct = load.max > 0 ? load.running / load.max : 0;
    const cls = pct >= 1 ? 'load-full' : pct > 0 ? 'load-partial' : 'load-idle';
    const dots = Array(load.max).fill(0).map((_, i) => i < load.running ? '●' : '○').join('');
    heatmapHTML += `<span class="skill-load ${cls}" title="${skill}: ${load.running}/${load.max}">${skill} ${dots}</span>`;
  }

  // Servicios
  let svcsHTML = '';
  for (const [name, data] of Object.entries(state.servicios)) {
    const dot = data.pendiente > 0 ? 'svc-busy' : 'svc-ok';
    svcsHTML += `<span class="svc-chip ${dot}">${name} ${data.pendiente}○ ${data.trabajando}⚙ ${data.listo}✓</span>`;
  }

  // Procesos (con botones start/stop)
  let procHTML = '';
  for (const [name, info] of Object.entries(state.procesos)) {
    const alive = info.alive;
    const cls = alive ? 'proc-alive' : 'proc-dead';
    const isDashboard = name === 'dashboard';
    const btn = isDashboard ? '' :
      alive
        ? `<button class="ctl-btn ctl-stop" onclick="ctlAction('${name}','stop')" title="Detener ${name}">■</button>`
        : `<button class="ctl-btn ctl-start" onclick="ctlAction('${name}','start')" title="Iniciar ${name}">▶</button>`;
    procHTML += `<span class="proc-chip ${cls}">${btn}${name}${info.pid && alive ? ' <span class="pid-num">'+info.pid+'</span>' : ''}</span>`;
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
    ${blocked ? '<div class="resource-alert">⛔ Lanzamiento bloqueado por sobrecarga del sistema</div>' : ''}`;

  // QA Environment (con botones start/stop globales)
  const qaLabels = { dynamo: '🗄️ DynamoDB', backend: '⚡ Backend', emulator: '📱 Emulador' };
  const allQaUp = Object.values(state.qaEnv).every(v => v);
  const anyQaUp = Object.values(state.qaEnv).some(v => v);
  let qaEnvHTML = Object.entries(state.qaEnv).map(([name, alive]) => {
    const cls = alive ? 'proc-alive' : 'proc-dead';
    return `<span class="proc-chip ${cls}">${qaLabels[name] || name} ${alive ? '✓' : '✗'}</span>`;
  }).join('');
  const qaBtn = anyQaUp
    ? `<button class="ctl-btn ctl-stop ctl-wide" onclick="ctlAction('qa','stop')">■ Detener QA</button>`
    : `<button class="ctl-btn ctl-start ctl-wide" onclick="ctlAction('qa','start')">▶ Levantar QA</button>`;
  qaEnvHTML += `<div class="qa-controls">${qaBtn}</div>`;

  // Rechazos recientes
  let rechazosHTML = '';
  if (state.rechazos.length > 0) {
    rechazosHTML = state.rechazos.map(r => {
      const ts = fmtTime(r.ts);
      return `<div class="rechazo-row">✗ <a href="${GH(r.issue)}" target="_blank" class="issue-link">#${r.issue}</a> ${r.skill} en ${r.fase} — <span class="rechazo-motivo">${(r.motivo || '').slice(0, 80)}</span> <span class="ts">${ts}</span></div>`;
    }).join('');
  }

  // Actividad
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
  color:var(--yl);background:rgba(210,153,34,0.12);border-color:rgba(210,153,34,0.3);
  font-weight:600;
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
  color:var(--rd)!important;background:rgba(248,81,73,0.12)!important;
  border-color:rgba(248,81,73,0.4)!important;animation:pulse 1.8s infinite
}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}
.log-link{text-decoration:none}
.log-link:hover .chip{text-decoration:underline;filter:brightness(1.15)}

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

/* ── Bar row: skills / servicios / procesos ─────────────────────────────── */
.bar-row{display:flex;gap:14px;margin-bottom:20px;flex-wrap:wrap}
.bar-section{
  background:var(--sf);border:1px solid var(--bd);border-radius:var(--radius);
  padding:16px 18px;flex:1;min-width:200px;
}
.skill-load{
  display:inline-flex;align-items:center;gap:5px;
  font-size:0.82em;padding:4px 8px;margin:3px;
  border-radius:5px;background:var(--bg);border:1px solid var(--bd2);
}
.load-full{color:var(--rd);border-color:rgba(248,81,73,0.3)}
.load-partial{color:var(--yl);border-color:rgba(210,153,34,0.3)}
.load-idle{color:var(--dim2)}
.svc-chip{
  display:inline-flex;align-items:center;gap:5px;
  font-size:0.82em;padding:4px 10px;margin:3px;
  border-radius:5px;background:var(--bg);border:1px solid var(--bd2);
}
.svc-busy{border-left:3px solid var(--yl)}.svc-ok{border-left:3px solid var(--gn)}
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
.qa-controls{margin-top:8px}

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

/* ── Footer ─────────────────────────────────────────────────────────────── */
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
  <h1>🐙 Pipeline V2 <span class="subtitle">— Intrale Platform</span></h1>

  ${stale > 0 ? `<div class="alert">⚠️ ${stale} issue${stale > 1 ? 's' : ''} con más de 10 min en trabajando — posible huérfano</div>` : ''}

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
    <div class="kpi kpi-definidos">
      <span class="kpi-icon">📋</span>
      <div class="kpi-value" style="color:var(--pu)">${definidos}</div>
      <div class="kpi-label">Definidos listos</div>
    </div>
    <div class="kpi kpi-entregados">
      <span class="kpi-icon">🚀</span>
      <div class="kpi-value success">${entregados}</div>
      <div class="kpi-label">Entregados a prod</div>
    </div>
  </div>

  <div class="bar-section" style="margin-bottom:20px"><h2>💻 Recursos del sistema</h2>${resourcesHTML}</div>

  <div class="bar-row">
    <div class="bar-section"><h2>🧠 Skills activos</h2>${heatmapHTML || '<span class="empty-label">Sin carga</span>'}</div>
    <div class="bar-section"><h2>📡 Servicios</h2>${svcsHTML}</div>
    <div class="bar-section"><h2>⚡ Procesos</h2>${procHTML}</div>
    <div class="bar-section"><h2>🧪 QA Environment</h2>${qaEnvHTML}</div>
  </div>

  ${matrixHTML}

  ${state.rechazos.length > 0 ? `<details class="collapse-section"><summary>🚫 Rechazos recientes<span>${state.rechazos.length}</span></summary><div class="collapse-body">${rechazosHTML}</div></details>` : ''}

  <details class="collapse-section"><summary>💬 Actividad Commander</summary><div class="collapse-body" style="max-height:300px;overflow-y:auto">${actHTML}</div></details>

  <div class="footer">🔴 Live · Auto-refresh 10s &nbsp;|&nbsp; ${new Date().toLocaleString('es-AR')}</div>

<script>
// SSE live refresh — solo recarga si el estado cambió
let lastHash = null;
const es = new EventSource('/events');
es.onmessage = e => {
  if (lastHash && e.data !== lastHash) location.reload();
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
</script>
</body></html>`;
}

// --- Server ---

const server = http.createServer((req, res) => {
  // Servir logs como archivos estáticos
  if (req.url.startsWith('/logs/')) {
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
        const { target, action } = JSON.parse(body);
        let result;
        if (target === 'qa') {
          result = qaAction(action); // 'start' o 'stop'
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

  // API JSON
  if (req.url === '/api/state' || req.url === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getPipelineState(), null, 2));
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

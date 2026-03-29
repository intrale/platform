#!/usr/bin/env node
// =============================================================================
// Dashboard V2 — Visualización del pipeline via HTTP
// Lee el estado directamente del filesystem (.pipeline/)
// Puerto: 3100
// =============================================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const PORT = parseInt(process.env.DASHBOARD_PORT) || 3200;
const PIPELINE = path.resolve(__dirname);
const ROOT = path.resolve(__dirname, '..');

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [dashboard] ${msg}`);
}

function loadConfig() {
  try {
    return yaml.load(fs.readFileSync(path.join(PIPELINE, 'config.yaml'), 'utf8'));
  } catch { return { pipelines: {} }; }
}

function listWorkFiles(dir) {
  try {
    return fs.readdirSync(dir)
      .filter(f => !f.startsWith('.') && !f.endsWith('.gitkeep'));
  } catch { return []; }
}

function readYamlSafe(filepath) {
  try {
    return yaml.load(fs.readFileSync(filepath, 'utf8')) || {};
  } catch { return {}; }
}

// --- Recolectar estado del pipeline ---

function getPipelineState() {
  const config = loadConfig();
  const state = {};

  for (const [pName, pConfig] of Object.entries(config.pipelines)) {
    state[pName] = {};
    for (const fase of pConfig.fases) {
      const baseDir = path.join(PIPELINE, pName, fase);
      const pendiente = listWorkFiles(path.join(baseDir, 'pendiente'));
      const trabajando = listWorkFiles(path.join(baseDir, 'trabajando'));
      const listo = listWorkFiles(path.join(baseDir, 'listo'));
      const procesado = listWorkFiles(path.join(baseDir, 'procesado'));

      state[pName][fase] = {
        pendiente: pendiente.map(f => parseWorkFile(f)),
        trabajando: trabajando.map(f => parseWorkFile(f)),
        listo: listo.map(f => parseWorkFile(f)),
        procesado_count: procesado.length,
        total_active: pendiente.length + trabajando.length + listo.length
      };
    }
  }

  // Servicios
  state.servicios = {};
  const svcsDir = path.join(PIPELINE, 'servicios');
  try {
    for (const svc of fs.readdirSync(svcsDir)) {
      const svcDir = path.join(svcsDir, svc);
      if (!fs.statSync(svcDir).isDirectory()) continue;
      state.servicios[svc] = {
        pendiente: listWorkFiles(path.join(svcDir, 'pendiente')).length,
        trabajando: listWorkFiles(path.join(svcDir, 'trabajando')).length,
        listo: listWorkFiles(path.join(svcDir, 'listo')).length
      };
    }
  } catch {}

  // Actividad reciente (commander history)
  state.actividad = [];
  try {
    const histFile = path.join(PIPELINE, 'commander-history.jsonl');
    const lines = fs.readFileSync(histFile, 'utf8').trim().split('\n').slice(-20);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        state.actividad.push({
          dir: entry.direction,
          from: entry.from || 'Sistema',
          text: (entry.text || '').slice(0, 120),
          ts: entry.timestamp
        });
      } catch {}
    }
  } catch {}

  // Procesos activos (PIDs)
  state.procesos = {};
  for (const comp of ['pulpo', 'listener', 'svc-telegram', 'svc-github', 'svc-drive', 'dashboard']) {
    try {
      const pid = fs.readFileSync(path.join(PIPELINE, `${comp}.pid`), 'utf8').trim();
      state.procesos[comp] = { pid, alive: true }; // Asumimos alive si el PID file existe
    } catch {
      state.procesos[comp] = { pid: null, alive: false };
    }
  }

  return state;
}

function parseWorkFile(filename) {
  const parts = filename.split('.');
  return { issue: parts[0], skill: parts.slice(1).join('.'), filename };
}

// --- HTML ---

function generateHTML(state) {
  const config = loadConfig();

  let pipelinesHTML = '';

  for (const [pName, fases] of Object.entries(state)) {
    if (pName === 'servicios' || pName === 'actividad' || pName === 'procesos') continue;

    let fasesHTML = '';
    for (const [fName, data] of Object.entries(fases)) {
      const total = data.total_active;
      const statusClass = total > 0 ? 'active' : 'empty';

      // Agrupar por issue
      const issues = {};
      for (const item of [...data.pendiente, ...data.trabajando, ...data.listo]) {
        if (!issues[item.issue]) issues[item.issue] = { pendiente: [], trabajando: [], listo: [] };
      }
      for (const item of data.pendiente) issues[item.issue].pendiente.push(item);
      for (const item of data.trabajando) issues[item.issue].trabajando.push(item);
      for (const item of data.listo) issues[item.issue].listo.push(item);

      let issuesHTML = '';
      for (const [issue, items] of Object.entries(issues)) {
        const skills = [];
        for (const s of items.listo) skills.push(`<span class="skill done">${s.skill} ✓</span>`);
        for (const s of items.trabajando) skills.push(`<span class="skill working">${s.skill} ⚙</span>`);
        for (const s of items.pendiente) skills.push(`<span class="skill pending">${s.skill} ○</span>`);
        issuesHTML += `<div class="issue"><span class="issue-num">#${issue}</span> ${skills.join(' ')}</div>`;
      }

      fasesHTML += `
        <div class="fase ${statusClass}">
          <div class="fase-header">
            <span class="fase-name">${fName}</span>
            <span class="fase-count">${data.pendiente.length}○ ${data.trabajando.length}⚙ ${data.listo.length}✓</span>
          </div>
          ${issuesHTML || '<div class="empty-label">vacía</div>'}
        </div>`;
    }

    pipelinesHTML += `
      <div class="pipeline">
        <h2>${pName.toUpperCase()}</h2>
        <div class="fases">${fasesHTML}</div>
      </div>`;
  }

  // Servicios — con pendiente y procesados
  let svcsHTML = '';
  if (state.servicios) {
    for (const [name, data] of Object.entries(state.servicios)) {
      const statusDot = data.pendiente > 0 ? '🟡' : data.trabajando > 0 ? '🔵' : '🟢';
      svcsHTML += `<div class="servicio">
        <span class="svc-name">${statusDot} ${name}</span>
        <span class="svc-count">${data.pendiente}○ ${data.trabajando}⚙ ${data.listo}✓</span>
      </div>`;
    }
  }

  // Procesos activos
  let processHTML = '';
  if (state.procesos) {
    for (const [name, info] of Object.entries(state.procesos)) {
      const dot = info.pid ? '🟢' : '🔴';
      processHTML += `<span class="proc">${dot} ${name}${info.pid ? ' ('+info.pid+')' : ''}</span> `;
    }
  }

  // Actividad reciente
  let actividadHTML = '';
  if (state.actividad && state.actividad.length > 0) {
    const rows = state.actividad.slice(-15).reverse().map(a => {
      const ts = a.ts ? a.ts.slice(11, 19) : '??:??';
      const dir = a.dir === 'in' ? '→' : '←';
      const cls = a.dir === 'in' ? 'msg-in' : 'msg-out';
      const from = a.from ? `[${a.from}]` : '';
      const text = (a.text || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `<div class="activity-row ${cls}"><span class="ts">${ts}</span> ${dir} ${from} ${text}</div>`;
    }).join('');
    actividadHTML = rows;
  } else {
    actividadHTML = '<div class="empty-label">Sin actividad reciente</div>';
  }

  // KPIs
  let totalActive = 0, totalDone = 0;
  for (const [pName, fases] of Object.entries(state)) {
    if (pName === 'servicios' || pName === 'actividad' || pName === 'procesos') continue;
    for (const data of Object.values(fases)) {
      totalActive += data.total_active;
      totalDone += data.procesado_count;
    }
  }

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Pipeline V2 — Intrale</title>
<meta http-equiv="refresh" content="10">
<style>
  :root {
    --bg: #0d1117; --surface: #161b22; --border: #30363d;
    --text: #e6edf3; --text-dim: #8b949e; --accent: #58a6ff;
    --green: #3fb950; --yellow: #d29922; --red: #f85149;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', monospace; padding: 20px; }
  h1 { color: var(--accent); margin-bottom: 20px; font-size: 1.4em; }
  h2 { color: var(--text-dim); font-size: 1em; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 12px; }

  .kpis { display: flex; gap: 16px; margin-bottom: 24px; }
  .kpi { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; flex: 1; text-align: center; }
  .kpi-value { font-size: 2em; font-weight: bold; color: var(--accent); }
  .kpi-label { font-size: 0.8em; color: var(--text-dim); margin-top: 4px; }

  .pipeline { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  .fases { display: flex; gap: 8px; overflow-x: auto; }
  .fase { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 12px; min-width: 160px; flex: 1; }
  .fase.active { border-color: var(--accent); }
  .fase-header { display: flex; justify-content: space-between; margin-bottom: 8px; }
  .fase-name { font-weight: bold; font-size: 0.85em; }
  .fase-count { font-size: 0.75em; color: var(--text-dim); }

  .issue { margin: 4px 0; font-size: 0.8em; }
  .issue-num { color: var(--accent); font-weight: bold; }
  .skill { padding: 1px 4px; border-radius: 3px; font-size: 0.75em; margin-left: 2px; }
  .skill.done { color: var(--green); }
  .skill.working { color: var(--yellow); }
  .skill.pending { color: var(--text-dim); }
  .empty-label { color: var(--text-dim); font-size: 0.75em; font-style: italic; }

  .servicios { display: flex; gap: 12px; margin-top: 16px; }
  .servicio { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 8px 16px; }
  .svc-name { font-weight: bold; font-size: 0.85em; }
  .svc-count { font-size: 0.75em; color: var(--text-dim); margin-left: 8px; }

  .section-row { display: flex; gap: 16px; margin-top: 16px; }
  .section { flex: 1; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .procesos { display: flex; flex-wrap: wrap; gap: 8px; }
  .proc { font-size: 0.8em; padding: 2px 6px; background: var(--bg); border-radius: 4px; }

  .activity-section { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-top: 16px; }
  .activity-log { max-height: 300px; overflow-y: auto; }
  .activity-row { font-size: 0.8em; padding: 3px 0; border-bottom: 1px solid var(--border); font-family: monospace; }
  .activity-row .ts { color: var(--text-dim); }
  .msg-in { color: var(--accent); }
  .msg-out { color: var(--green); }

  .footer { margin-top: 24px; font-size: 0.75em; color: var(--text-dim); text-align: center; }
</style>
</head>
<body>
  <h1>🐙 Pipeline V2 — Intrale</h1>

  <div class="kpis">
    <div class="kpi"><div class="kpi-value">${totalActive}</div><div class="kpi-label">En pipeline</div></div>
    <div class="kpi"><div class="kpi-value">${totalDone}</div><div class="kpi-label">Procesados</div></div>
    <div class="kpi"><div class="kpi-value">${Object.values(state.servicios || {}).reduce((s, v) => s + v.pendiente, 0)}</div><div class="kpi-label">Servicios pendientes</div></div>
  </div>

  ${pipelinesHTML}

  <div class="section-row">
    <div class="section">
      <h2>SERVICIOS</h2>
      <div class="servicios">${svcsHTML}</div>
    </div>
    <div class="section">
      <h2>PROCESOS</h2>
      <div class="procesos">${processHTML}</div>
    </div>
  </div>

  <div class="activity-section">
    <h2>ACTIVIDAD RECIENTE (Commander)</h2>
    <div class="activity-log">${actividadHTML}</div>
  </div>

  <div class="footer">Auto-refresh: 10s | ${new Date().toLocaleString('es-AR')}</div>
</body>
</html>`;
}

// --- API JSON ---

function generateJSON(state) {
  return JSON.stringify(state, null, 2);
}

// --- Server ---

const server = http.createServer((req, res) => {
  const state = getPipelineState();

  if (req.url === '/api/state' || req.url === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(generateJSON(state));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(generateHTML(state));
  }
});

server.listen(PORT, () => {
  log(`Dashboard V2 en http://localhost:${PORT}`);
  log(`API JSON en http://localhost:${PORT}/api/state`);
});

fs.writeFileSync(path.join(PIPELINE, 'dashboard.pid'), String(process.pid));
process.on('SIGINT', () => { server.close(); process.exit(0); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });

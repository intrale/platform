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

      // Para procesado: agrupar por issue (mostrar solo issues únicos, últimos 20)
      const procesadoIssues = [...new Set(procesado.map(f => f.split('.')[0]))].slice(-20);

      state[pName][fase] = {
        pendiente: pendiente.map(f => parseWorkFile(f)),
        trabajando: trabajando.map(f => parseWorkFile(f)),
        listo: listo.map(f => parseWorkFile(f)),
        procesado: procesadoIssues,
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

  // Issue matrix: cruzar issue × fase para trazabilidad completa
  state.issueMatrix = {};
  for (const [pName, pConfig] of Object.entries(config.pipelines)) {
    for (const fase of pConfig.fases) {
      const baseDir = path.join(PIPELINE, pName, fase);
      for (const [estado, dir] of [['pendiente','pendiente'],['trabajando','trabajando'],['listo','listo'],['procesado','procesado']]) {
        for (const f of listWorkFiles(path.join(baseDir, dir))) {
          const issue = f.split('.')[0];
          const skill = f.split('.').slice(1).join('.');
          if (!state.issueMatrix[issue]) state.issueMatrix[issue] = { pipeline: pName, fases: {} };
          if (!state.issueMatrix[issue].fases[fase]) state.issueMatrix[issue].fases[fase] = [];

          const entry = { skill, estado };
          // Edad en minutos si está en trabajando
          if (estado === 'trabajando') {
            try {
              const stat = fs.statSync(path.join(baseDir, dir, f));
              entry.ageMin = Math.round((Date.now() - stat.mtimeMs) / 60000);
            } catch {}
          }
          state.issueMatrix[issue].fases[fase].push(entry);

          // Fase actual = la más avanzada que no sea procesado
          if (estado !== 'procesado') {
            state.issueMatrix[issue].faseActual = fase;
            state.issueMatrix[issue].estadoActual = estado;
          }
        }
      }
    }
  }

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
    if (['servicios', 'actividad', 'procesos', 'issueMatrix'].includes(pName)) continue;

    let fasesHTML = '';
    for (const [fName, data] of Object.entries(fases)) {
      const total = data.total_active;
      const hasProcesado = data.procesado && data.procesado.length > 0;
      const statusClass = total > 0 ? 'active' : hasProcesado ? 'has-history' : 'empty';

      // Agrupar activos por issue
      const issues = {};
      for (const item of [...data.pendiente, ...data.trabajando, ...data.listo]) {
        if (!issues[item.issue]) issues[item.issue] = { pendiente: [], trabajando: [], listo: [] };
      }
      for (const item of data.pendiente) issues[item.issue].pendiente.push(item);
      for (const item of data.trabajando) issues[item.issue].trabajando.push(item);
      for (const item of data.listo) issues[item.issue].listo.push(item);

      let issuesHTML = '';

      // Issues activos (pendiente + trabajando + listo)
      for (const [issue, items] of Object.entries(issues)) {
        const skills = [];
        for (const s of items.listo) skills.push(`<span class="skill done">${s.skill} ✓</span>`);
        for (const s of items.trabajando) skills.push(`<span class="skill working">${s.skill} ⚙</span>`);
        for (const s of items.pendiente) skills.push(`<span class="skill pending">${s.skill} ○</span>`);
        issuesHTML += `<div class="issue"><span class="issue-num">#${issue}</span> ${skills.join(' ')}</div>`;
      }

      // Issues procesados (finalizados) — colapsable
      let procesadoHTML = '';
      if (hasProcesado) {
        const procIssues = data.procesado.map(i => `<span class="issue-num-done">#${i}</span>`).join(' ');
        procesadoHTML = `
          <div class="procesado-section">
            <div class="procesado-label">✅ Finalizados (${data.procesado_count})</div>
            <div class="procesado-list">${procIssues}</div>
          </div>`;
      }

      fasesHTML += `
        <div class="fase ${statusClass}">
          <div class="fase-header">
            <span class="fase-name">${fName}</span>
            <span class="fase-count">${data.pendiente.length}○ ${data.trabajando.length}⚙ ${data.listo.length}✓ ${data.procesado_count}✔</span>
          </div>
          ${issuesHTML || (hasProcesado ? '' : '<div class="empty-label">vacía</div>')}
          ${procesadoHTML}
        </div>`;
    }

    pipelinesHTML += `
      <div class="pipeline">
        <h2>${pName.toUpperCase()}</h2>
        <div class="fases">${fasesHTML}</div>
      </div>`;
  }

  // Issue Matrix HTML — tabla issue × fase
  let issueMatrixHTML = '';
  const matrixEntries = Object.entries(state.issueMatrix || {});
  if (matrixEntries.length > 0) {
    // Separar por pipeline
    for (const pipelineName of Object.keys(config.pipelines)) {
      const pConfig = config.pipelines[pipelineName];
      const fases = pConfig.fases;
      const issues = matrixEntries
        .filter(([_, data]) => data.pipeline === pipelineName)
        .sort((a, b) => {
          // Activos primero, procesados después
          const aActive = a[1].estadoActual ? 0 : 1;
          const bActive = b[1].estadoActual ? 0 : 1;
          return aActive - bActive || parseInt(b[0]) - parseInt(a[0]);
        });

      if (issues.length === 0) continue;

      // Contar activos vs procesados
      const activos = issues.filter(([_, d]) => d.estadoActual).length;
      const procesados = issues.length - activos;

      let rows = '';
      // Mostrar activos + últimos 10 procesados
      const shown = issues.slice(0, activos + 10);
      for (const [issueNum, data] of shown) {
        let cells = '';
        for (const fase of fases) {
          const entries = data.fases[fase] || [];
          if (entries.length === 0) {
            cells += '<td class="cell-empty">—</td>';
          } else {
            const parts = entries.map(e => {
              const cls = e.estado === 'trabajando' ? 'st-working' :
                          e.estado === 'listo' ? 'st-done' :
                          e.estado === 'procesado' ? 'st-processed' : 'st-pending';
              const icon = e.estado === 'trabajando' ? '⚙' :
                           e.estado === 'listo' ? '✓' :
                           e.estado === 'procesado' ? '✔' : '○';
              const age = e.ageMin ? ` <span class="age ${e.ageMin > 10 ? 'stale' : ''}">${e.ageMin}m</span>` : '';
              return `<span class="${cls}">${icon}${e.skill}${age}</span>`;
            });
            const isCurrent = data.faseActual === fase;
            cells += `<td class="${isCurrent ? 'cell-current' : ''}">${parts.join(' ')}</td>`;
          }
        }
        const rowClass = data.estadoActual ? 'issue-active' : 'issue-done';
        rows += `<tr class="${rowClass}"><td class="issue-col">#${issueNum}</td>${cells}</tr>`;
      }
      if (procesados > 10) {
        rows += `<tr class="issue-done"><td colspan="${fases.length + 1}" class="more-label">... y ${procesados - 10} issues más finalizados</td></tr>`;
      }

      const headers = fases.map(f => `<th>${f}</th>`).join('');
      issueMatrixHTML += `
        <div class="matrix-section">
          <h2>${pipelineName.toUpperCase()} <span class="matrix-count">${activos} activos, ${procesados} finalizados</span></h2>
          <div class="matrix-scroll">
            <table class="issue-matrix">
              <thead><tr><th>Issue</th>${headers}</tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>`;
    }
  } else {
    issueMatrixHTML = '<div class="matrix-section"><h2>ISSUE TRACKER</h2><div class="empty-label">Sin issues en el pipeline</div></div>';
  }

  // Servicios ��� con pendiente y procesados
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
    if (['servicios', 'actividad', 'procesos', 'issueMatrix'].includes(pName)) continue;
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
  .fase.has-history { border-color: var(--green); border-style: dashed; }
  .procesado-section { margin-top: 8px; padding-top: 6px; border-top: 1px dashed var(--border); }
  .procesado-label { font-size: 0.7em; color: var(--green); margin-bottom: 4px; }
  .procesado-list { font-size: 0.7em; line-height: 1.6; }
  .issue-num-done { color: var(--green); opacity: 0.7; margin-right: 4px; }

  .servicios { display: flex; gap: 12px; margin-top: 16px; }
  .servicio { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 8px 16px; }
  .svc-name { font-weight: bold; font-size: 0.85em; }
  .svc-count { font-size: 0.75em; color: var(--text-dim); margin-left: 8px; }

  /* Issue Matrix */
  .matrix-section { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  .matrix-count { font-size: 0.7em; color: var(--text-dim); font-weight: normal; }
  .matrix-scroll { overflow-x: auto; }
  .issue-matrix { width: 100%; border-collapse: collapse; font-size: 0.82em; }
  .issue-matrix th { text-align: left; padding: 6px 10px; color: var(--text-dim); border-bottom: 2px solid var(--border); font-size: 0.85em; text-transform: uppercase; letter-spacing: 1px; }
  .issue-matrix td { padding: 5px 10px; border-bottom: 1px solid var(--border); white-space: nowrap; }
  .issue-col { color: var(--accent); font-weight: bold; }
  .cell-empty { color: var(--border); }
  .cell-current { background: rgba(88,166,255,0.08); border-left: 2px solid var(--accent); }
  .issue-active { }
  .issue-done { opacity: 0.5; }
  .st-working { color: var(--yellow); font-weight: bold; }
  .st-done { color: var(--green); }
  .st-processed { color: var(--green); opacity: 0.6; }
  .st-pending { color: var(--text-dim); }
  .age { font-size: 0.75em; color: var(--text-dim); }
  .age.stale { color: var(--red); font-weight: bold; }
  .more-label { color: var(--text-dim); font-style: italic; text-align: center; }
  .section-title { color: var(--text-dim); font-size: 0.9em; cursor: pointer; padding: 8px 0; text-transform: uppercase; letter-spacing: 1px; }

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

  ${issueMatrixHTML}

  <details open>
    <summary class="section-title">FASES (vista clásica)</summary>
    ${pipelinesHTML}
  </details>

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

  <details>
    <summary class="section-title">ACTIVIDAD RECIENTE (Commander)</summary>
    <div class="activity-log">${actividadHTML}</div>
  </details>

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

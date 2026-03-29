#!/usr/bin/env node
// =============================================================================
// Dashboard V2 — Visualización completa del pipeline
// Issue Tracker Matrix + tooltips + links GitHub + logs + SSE live
// =============================================================================

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const PORT = parseInt(process.env.DASHBOARD_PORT) || 3200;
const PIPELINE = path.resolve(__dirname);
const ROOT = path.resolve(__dirname, '..');
const LOG_DIR = path.join(PIPELINE, 'logs');
const GITHUB_BASE = 'https://github.com/intrale/platform/issues';

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

        // Log disponible?
        const logFile = `${issue}-${skill}.log`;
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
    for (const { pipeline: pName } of allFases) {
      for (const fase of (config.pipelines[pName]?.fases || [])) {
        running += listWorkFiles(path.join(PIPELINE, pName, fase, 'trabajando')).filter(f => f.endsWith(`.${skill}`)).length;
      }
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
      state.procesos[comp] = { pid };
    } catch {
      state.procesos[comp] = { pid: null };
    }
  }

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

  return state;
}

// --- HTML generation ---

function generateHTML(state) {
  const config = state.config;
  const allFases = state.allFases;
  const GH = (num) => `${GITHUB_BASE}/${num}`;

  // KPIs
  const matrixEntries = Object.entries(state.issueMatrix);
  const activos = matrixEntries.filter(([_, d]) => d.estadoActual).length;
  const totalIssues = matrixEntries.length;
  const trabajando = matrixEntries.filter(([_, d]) => d.estadoActual === 'trabajando').length;
  const stale = matrixEntries.filter(([_, d]) => {
    if (d.estadoActual !== 'trabajando' || !d.faseActual) return false;
    const entries = d.fases[d.faseActual] || [];
    return entries.some(e => e.ageMin > 10);
  }).length;

  // --- Issue Tracker Matrix (unified) ---
  // Headers: definición phases | separator | desarrollo phases
  const defFases = config.pipelines.definicion?.fases || [];
  const devFases = config.pipelines.desarrollo?.fases || [];

  const headerCells = [
    ...defFases.map(f => `<th class="th-def">${f}</th>`),
    ...devFases.map(f => `<th class="th-dev">${f}</th>`)
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

      const chips = entries.map(e => {
        const cls = e.estado === 'trabajando' ? 'st-working' :
                    e.estado === 'listo' ? 'st-done' :
                    e.estado === 'procesado' ? 'st-processed' : 'st-pending';
        const icon = e.estado === 'trabajando' ? '⚙' :
                     e.estado === 'listo' ? '✓' :
                     e.estado === 'procesado' ? '✔' : '○';
        const staleClass = (e.estado === 'trabajando' && e.ageMin > 10) ? ' stale-chip' : '';

        // Tooltip content
        const ttStart = e.startedAt ? `Inicio: ${fmtTime(e.startedAt)}` : '';
        const ttDur = e.durationMs ? `Duración: ${fmtDuration(e.durationMs)}` : '';
        const ttRes = e.resultado ? `Resultado: ${e.resultado === 'aprobado' ? '✓' : '✗'} ${e.resultado}` : '';
        const ttMot = e.motivo ? `Motivo: ${e.motivo.slice(0, 80)}` : '';
        const ttLines = [e.skill, ttStart, ttDur, ttRes, ttMot].filter(Boolean);
        const tooltip = `<span class="tt">${ttLines.map(l => `<span>${l}</span>`).join('')}</span>`;

        // Wrap in link if log exists
        const inner = `<span class="chip ${cls}${staleClass}">${icon}${e.skill}${tooltip}</span>`;
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
      <h2>ISSUE TRACKER <span class="matrix-count">${activos} activos · ${totalIssues - activos} finalizados</span></h2>
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

  // Procesos
  let procHTML = '';
  for (const [name, info] of Object.entries(state.procesos)) {
    const cls = info.pid ? 'proc-alive' : 'proc-dead';
    procHTML += `<span class="proc-chip ${cls}">${name}${info.pid ? ' '+info.pid : ''}</span>`;
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
:root{--bg:#0d1117;--sf:#161b22;--bd:#30363d;--tx:#e6edf3;--dim:#8b949e;--ac:#58a6ff;--gn:#3fb950;--yl:#d29922;--rd:#f85149;--or:#db6d28}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--tx);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',monospace;padding:16px;font-size:14px}
a{color:var(--ac);text-decoration:none}a:hover{text-decoration:underline}
h1{color:var(--ac);font-size:1.3em;margin-bottom:16px;display:flex;align-items:center;gap:8px}
h2{color:var(--dim);font-size:0.9em;text-transform:uppercase;letter-spacing:2px;margin-bottom:10px}
.header-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
.kpis{display:flex;gap:12px;margin-bottom:20px}
.kpi{background:var(--sf);border:1px solid var(--bd);border-radius:8px;padding:12px 16px;flex:1;text-align:center}
.kpi-value{font-size:1.8em;font-weight:bold;color:var(--ac)}.kpi-value.warn{color:var(--yl)}.kpi-value.danger{color:var(--rd)}
.kpi-label{font-size:0.75em;color:var(--dim);margin-top:2px}
${stale > 0 ? `.alert{background:rgba(248,81,73,0.1);border:1px solid var(--rd);border-radius:8px;padding:10px 16px;margin-bottom:16px;color:var(--rd);font-size:0.9em}` : ''}
.matrix-section{background:var(--sf);border:1px solid var(--bd);border-radius:8px;padding:16px;margin-bottom:16px}
.matrix-count{font-size:0.7em;color:var(--dim);font-weight:normal}
.matrix-scroll{overflow-x:auto}
.issue-matrix{width:100%;border-collapse:collapse;font-size:0.8em}
.issue-matrix th{padding:5px 8px;color:var(--dim);border-bottom:2px solid var(--bd);font-size:0.8em;text-transform:uppercase;letter-spacing:1px;text-align:left}
.issue-matrix td{padding:4px 8px;border-bottom:1px solid var(--bd);white-space:nowrap}
.th-issue{min-width:90px}.group-header th{border-bottom:1px solid var(--bd);font-size:0.7em;letter-spacing:2px}
.group-def{color:var(--or);text-align:center;border-right:2px solid var(--bd)}.group-dev{color:var(--ac);text-align:center}
.th-def{border-right:none}.col-def{}.col-dev{}
.th-def:last-of-type,.col-def:last-of-type{border-right:2px solid var(--bd)}
.issue-col{min-width:80px}
.issue-link{color:var(--ac);font-weight:bold;font-size:0.95em}
.progress-bar{height:3px;background:var(--bd);border-radius:2px;margin-top:3px;width:70px}
.progress-fill{height:100%;background:var(--gn);border-radius:2px}
.progress-text{font-size:0.65em;color:var(--dim)}
.cell-empty{color:var(--bd);text-align:center}
.cell-current{background:rgba(88,166,255,0.06);border-left:2px solid var(--ac)}
.issue-trabajando{}.issue-pendiente{}.issue-listo{opacity:0.7}.issue-done{opacity:0.4}
.chip{position:relative;cursor:default;padding:1px 3px;border-radius:3px;font-size:0.9em}
.st-working{color:var(--yl);font-weight:bold}.st-done{color:var(--gn)}.st-processed{color:var(--gn);opacity:0.6}.st-pending{color:var(--dim)}
.stale-chip{color:var(--rd)!important;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.5}}
.log-link{text-decoration:none}.log-link:hover .chip{text-decoration:underline}
.chip .tt{display:none;position:absolute;z-index:100;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);background:#1c2128;border:1px solid var(--bd);border-radius:6px;padding:8px 12px;font-size:0.85em;white-space:nowrap;min-width:180px;color:var(--tx);box-shadow:0 4px 16px rgba(0,0,0,0.6);pointer-events:none}
.chip .tt span{display:block;line-height:1.5}
.chip:hover .tt{display:block}
.more-label{color:var(--dim);font-style:italic;text-align:center}
.bar-row{display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap}
.bar-section{background:var(--sf);border:1px solid var(--bd);border-radius:8px;padding:12px 16px;flex:1;min-width:200px}
.skill-load{display:inline-block;font-size:0.78em;padding:3px 6px;margin:2px;border-radius:4px;background:var(--bg)}
.load-full{color:var(--rd)}.load-partial{color:var(--yl)}.load-idle{color:var(--dim)}
.svc-chip{display:inline-block;font-size:0.78em;padding:3px 8px;margin:2px;border-radius:4px;background:var(--bg)}
.svc-busy{border-left:3px solid var(--yl)}.svc-ok{border-left:3px solid var(--gn)}
.proc-chip{display:inline-block;font-size:0.78em;padding:3px 6px;margin:2px;border-radius:4px;background:var(--bg)}
.proc-alive{color:var(--gn)}.proc-dead{color:var(--rd)}
.rechazo-row{font-size:0.8em;padding:3px 0;border-bottom:1px solid var(--bd);color:var(--rd)}
.rechazo-motivo{color:var(--dim);font-style:italic}.ts{color:var(--dim);font-size:0.85em}
.act-row{font-size:0.78em;padding:2px 0;border-bottom:1px solid var(--bd);font-family:monospace}
.msg-in{color:var(--ac)}.msg-out{color:var(--gn)}
.collapse-section{margin-top:16px}
summary{color:var(--dim);font-size:0.85em;cursor:pointer;padding:6px 0;text-transform:uppercase;letter-spacing:1px}
.empty-label{color:var(--dim);font-size:0.78em;font-style:italic}
.footer{margin-top:20px;font-size:0.7em;color:var(--dim);text-align:center}
</style></head>
<body>
  <h1>🐙 Pipeline V2 — Intrale</h1>

  ${stale > 0 ? `<div class="alert">⚠️ ${stale} issue(s) llevan más de 10 min en trabajando — posible huérfano</div>` : ''}

  <div class="kpis">
    <div class="kpi"><div class="kpi-value">${activos}</div><div class="kpi-label">Activos</div></div>
    <div class="kpi"><div class="kpi-value ${trabajando > 0 ? '' : 'warn'}">${trabajando}</div><div class="kpi-label">En ejecución</div></div>
    <div class="kpi"><div class="kpi-value ${stale > 0 ? 'danger' : ''}">${stale}</div><div class="kpi-label">Bloqueados</div></div>
    <div class="kpi"><div class="kpi-value">${totalIssues - activos}</div><div class="kpi-label">Finalizados</div></div>
  </div>

  ${matrixHTML}

  <div class="bar-row">
    <div class="bar-section"><h2>Skills</h2>${heatmapHTML || '<span class="empty-label">Sin carga</span>'}</div>
    <div class="bar-section"><h2>Servicios</h2>${svcsHTML}</div>
    <div class="bar-section"><h2>Procesos</h2>${procHTML}</div>
  </div>

  ${state.rechazos.length > 0 ? `<details class="collapse-section"><summary>RECHAZOS RECIENTES (${state.rechazos.length})</summary><div style="padding:8px 0">${rechazosHTML}</div></details>` : ''}

  <details class="collapse-section"><summary>ACTIVIDAD COMMANDER</summary><div style="padding:8px 0;max-height:300px;overflow-y:auto">${actHTML}</div></details>

  <div class="footer">Auto-refresh: 10s | ${new Date().toLocaleString('es-AR')}</div>

<script>
// SSE live refresh — solo recarga si el estado cambió
let lastHash = null;
const es = new EventSource('/events');
es.onmessage = e => {
  if (lastHash && e.data !== lastHash) location.reload();
  lastHash = e.data;
};
es.onerror = () => { setTimeout(() => location.reload(), 10000); };
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

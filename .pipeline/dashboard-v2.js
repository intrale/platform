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
  const activos = matrixEntries.filter(([_, d]) => d.estadoActual).length;
  const totalIssues = matrixEntries.length;
  const trabajando = matrixEntries.filter(([_, d]) => d.estadoActual === 'trabajando').length;
  const pendientes = matrixEntries.filter(([_, d]) => d.estadoActual === 'pendiente').length;
  const stale = matrixEntries.filter(([_, d]) => {
    if (d.estadoActual !== 'trabajando' || !d.faseActual) return false;
    const entries = d.fases[d.faseActual] || [];
    return entries.some(e => e.ageMin > 10);
  }).length;

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
        const inner = `<span class="chip ${cls}${staleClass}">${icon} ${skillIcon(e.skill)} ${e.skill}${tooltip}</span>`;
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
.matrix-scroll{overflow-x:auto}
.issue-matrix{width:100%;border-collapse:collapse;font-size:1em}
.issue-matrix th{
  padding:10px 12px;color:var(--tx);border-bottom:2px solid var(--bd);
  font-size:0.9em;text-transform:uppercase;letter-spacing:1px;text-align:left;
  font-weight:700;
}
.issue-matrix td{padding:8px 12px;border-bottom:1px solid var(--bd2);white-space:nowrap}
.issue-matrix tbody tr:hover{background:rgba(255,255,255,0.03)}
.th-issue{min-width:110px}
.group-header th{border-bottom:1px solid var(--bd);font-size:0.85em;letter-spacing:2px;padding:8px 12px;font-weight:700}
.group-def{color:var(--or);text-align:center;border-right:2px solid var(--bd)}.group-dev{color:var(--ac);text-align:center}
.th-def:last-of-type,.col-def:last-of-type{border-right:2px solid var(--bd)}

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
  bottom:calc(100% + 10px);left:50%;transform:translateX(-50%);
  background:var(--sf2);border:1px solid var(--bd);border-radius:8px;
  padding:10px 14px;font-size:0.88em;white-space:nowrap;
  min-width:190px;color:var(--tx);
  box-shadow:0 8px 24px rgba(0,0,0,0.7);pointer-events:none;
}
.chip .tt span{display:block;line-height:1.6;color:var(--dim)}
.chip .tt span:first-child{color:var(--tx);font-weight:600;margin-bottom:2px}
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
</style></head>
<body>
  <h1>🐙 Pipeline V2 <span class="subtitle">— Intrale Platform</span></h1>

  ${stale > 0 ? `<div class="alert">⚠️ ${stale} issue${stale > 1 ? 's' : ''} con más de 10 min en trabajando — posible huérfano</div>` : ''}

  <div class="kpis">
    <div class="kpi kpi-activos">
      <span class="kpi-icon">🔄</span>
      <div class="kpi-value">${activos}</div>
      <div class="kpi-label">Activos en pipeline</div>
    </div>
    <div class="kpi kpi-working">
      <span class="kpi-icon">⚙️</span>
      <div class="kpi-value ${trabajando > 0 ? 'warn' : 'muted'}">${trabajando}</div>
      <div class="kpi-label">En ejecución ahora</div>
    </div>
    <div class="kpi kpi-pendientes">
      <span class="kpi-icon">⏳</span>
      <div class="kpi-value ${pendientes > 0 ? '' : 'muted'}" style="color:var(--or)">${pendientes}</div>
      <div class="kpi-label">Pendientes en cola</div>
    </div>
    <div class="kpi kpi-blocked">
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

  ${matrixHTML}

  <div class="bar-row">
    <div class="bar-section"><h2>🧠 Skills activos</h2>${heatmapHTML || '<span class="empty-label">Sin carga</span>'}</div>
    <div class="bar-section"><h2>📡 Servicios</h2>${svcsHTML}</div>
    <div class="bar-section"><h2>⚡ Procesos</h2>${procHTML}</div>
  </div>

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

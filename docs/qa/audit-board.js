#!/usr/bin/env node
/**
 * audit-board.js — Genera el reporte de auditoría del tablero Project V2
 * Uso: node audit-board.js
 * Requiere: project-items-raw.json y open-issues-raw.json en el mismo directorio
 */

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const projectData = JSON.parse(fs.readFileSync(path.join(DIR, 'project-items-raw.json'), 'utf8'));
const openIssues = JSON.parse(fs.readFileSync(path.join(DIR, 'open-issues-raw.json'), 'utf8'));

const NOW = new Date();
const STALE_DAYS = 14;
const staleDate = new Date(NOW.getTime() - STALE_DAYS * 24 * 60 * 60 * 1000);

// === 1. COLUMNAS/STATUS DEL PROJECT V2 ===
const STATUS_OPTIONS = [
  'Backlog Tecnico', 'Backlog CLIENTE', 'Backlog NEGOCIO', 'Backlog DELIVERY',
  'Todo', 'Refined', 'In Progress', 'Ready', 'Done', 'Blocked'
];

// === 2. PROCESAR ITEMS DEL PROJECT ===
const projectItems = projectData.data.organization.projectV2.items.nodes
  .filter(n => n.content && n.content.number)
  .map(n => ({
    number: n.content.number,
    title: n.content.title,
    state: n.content.state,
    labels: (n.content.labels?.nodes || []).map(l => l.name),
    assignees: (n.content.assignees?.nodes || []).map(a => a.login),
    updatedAt: n.content.updatedAt,
    createdAt: n.content.createdAt,
    closedAt: n.content.closedAt,
    status: n.fieldValueByName?.name || null
  }));

// === 3. ISSUES ABIERTOS DEL REPO ===
const openIssueMap = {};
openIssues.forEach(i => {
  openIssueMap[i.number] = {
    number: i.number,
    title: i.title,
    labels: (i.labels || []).map(l => l.name),
    assignees: (i.assignees || []).map(a => a.login),
    updatedAt: i.updatedAt,
    createdAt: i.createdAt
  };
});

// === ANALISIS ===

// 3a. Issues sin labels
const noLabels = openIssues.filter(i => !i.labels || i.labels.length === 0);

// 3b. Issues sin asignado
const noAssignee = openIssues.filter(i => !i.assignees || i.assignees.length === 0);

// 3c. Issues en el project sin status definido
const projectOpen = projectItems.filter(i => i.state === 'OPEN');
const noStatus = projectOpen.filter(i => !i.status);

// Issues abiertos que NO están en el Project V2
const projectNumbers = new Set(projectItems.map(i => i.number));
const notInProject = openIssues.filter(i => !projectNumbers.has(i.number));

// 3d. Issues estancados (>14 días sin actividad)
const staleIssues = openIssues.filter(i => new Date(i.updatedAt) < staleDate);

// === 4. BACKLOGS ===
const backlogs = {};
STATUS_OPTIONS.forEach(s => { backlogs[s] = []; });
backlogs['Sin status'] = [];

projectItems.forEach(item => {
  const s = item.status || 'Sin status';
  if (!backlogs[s]) backlogs[s] = [];
  backlogs[s].push(item);
});

// Backlog CLIENTE/NEGOCIO/DELIVERY open only
const backlogCliente = backlogs['Backlog CLIENTE'].filter(i => i.state === 'OPEN');
const backlogNegocio = backlogs['Backlog NEGOCIO'].filter(i => i.state === 'OPEN');
const backlogDelivery = backlogs['Backlog DELIVERY'].filter(i => i.state === 'OPEN');
const backlogTecnico = backlogs['Backlog Tecnico'].filter(i => i.state === 'OPEN');

// === 5. LABELS ANALYSIS ===
const labelCounts = {};
openIssues.forEach(i => {
  (i.labels || []).forEach(l => {
    labelCounts[l.name] = (labelCounts[l.name] || 0) + 1;
  });
});
const sortedLabels = Object.entries(labelCounts).sort((a, b) => b[1] - a[1]);

// Area labels
const areaLabels = sortedLabels.filter(([name]) => name.startsWith('area:'));
const appLabels = sortedLabels.filter(([name]) => name.startsWith('app:'));
const tipoLabels = sortedLabels.filter(([name]) => name.startsWith('tipo:'));

// === 6. FLOW ANALYSIS ===
const flowColumns = ['Todo', 'Refined', 'In Progress', 'Ready', 'Done', 'Blocked'];
const flowCounts = {};
flowColumns.forEach(c => {
  flowCounts[c] = (backlogs[c] || []).length;
});

// Items cerrados en Done
const doneItems = (backlogs['Done'] || []);
const doneClosed = doneItems.filter(i => i.state === 'CLOSED');
const doneOpen = doneItems.filter(i => i.state === 'OPEN');

// Closed items NOT in Done (misalignment)
const closedNotDone = projectItems.filter(i => i.state === 'CLOSED' && i.status !== 'Done');

// === 7. BOTTLENECK DETECTION ===
const inProgressItems = (backlogs['In Progress'] || []).filter(i => i.state === 'OPEN');
const blockedItems = (backlogs['Blocked'] || []).filter(i => i.state === 'OPEN');
const readyItems = (backlogs['Ready'] || []).filter(i => i.state === 'OPEN');
const refinedItems = (backlogs['Refined'] || []).filter(i => i.state === 'OPEN');
const todoItems = (backlogs['Todo'] || []).filter(i => i.state === 'OPEN');

// === GENERATE HTML ===
function issueLink(num) {
  return `<a href="https://github.com/intrale/platform/issues/${num}" target="_blank">#${num}</a>`;
}

function issueRow(item) {
  const labels = (item.labels || []).map(l => `<span class="label">${l}</span>`).join(' ');
  const assignees = (item.assignees || []).join(', ') || '<span class="warning">Sin asignar</span>';
  const updated = new Date(item.updatedAt).toLocaleDateString('es-AR');
  const daysSince = Math.floor((NOW - new Date(item.updatedAt)) / (1000 * 60 * 60 * 24));
  const staleClass = daysSince > STALE_DAYS ? ' class="stale"' : '';
  return `<tr${staleClass}><td>${issueLink(item.number)}</td><td>${item.title}</td><td>${labels}</td><td>${assignees}</td><td>${updated} (${daysSince}d)</td></tr>`;
}

const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>Auditoría del Tablero Project V2 — Intrale Platform</title>
<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
<script>mermaid.initialize({startOnLoad:true, theme:'neutral'});</script>
<style>
  body { font-family: 'Segoe UI', system-ui, sans-serif; margin: 2rem; color: #1a1a2e; background: #fafbfc; line-height: 1.6; }
  h1 { color: #0d47a1; border-bottom: 3px solid #0d47a1; padding-bottom: 0.5rem; }
  h2 { color: #1565c0; margin-top: 2rem; border-bottom: 2px solid #e3f2fd; padding-bottom: 0.3rem; }
  h3 { color: #1976d2; margin-top: 1.5rem; }
  .meta { color: #666; font-size: 0.9rem; margin-bottom: 2rem; }
  .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin: 1.5rem 0; }
  .summary-card { background: white; border: 1px solid #e0e0e0; border-radius: 8px; padding: 1rem; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  .summary-card .number { font-size: 2rem; font-weight: bold; }
  .summary-card .label-text { font-size: 0.85rem; color: #666; margin-top: 0.3rem; }
  .ok { color: #2e7d32; }
  .warning { color: #f57f17; }
  .danger { color: #c62828; }
  .info { color: #0d47a1; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; font-size: 0.85rem; }
  th { background: #e3f2fd; color: #0d47a1; padding: 0.6rem 0.8rem; text-align: left; border: 1px solid #bbdefb; }
  td { padding: 0.5rem 0.8rem; border: 1px solid #e0e0e0; }
  tr:nth-child(even) { background: #f5f5f5; }
  tr.stale { background: #fff3e0; }
  .label { display: inline-block; background: #e3f2fd; color: #0d47a1; padding: 1px 6px; border-radius: 3px; font-size: 0.75rem; margin: 1px; }
  .bar-chart { margin: 1rem 0; }
  .bar-row { display: flex; align-items: center; margin: 4px 0; }
  .bar-label { width: 160px; font-size: 0.85rem; text-align: right; padding-right: 8px; }
  .bar { height: 24px; background: #42a5f5; border-radius: 4px; display: flex; align-items: center; padding-left: 8px; color: white; font-size: 0.8rem; min-width: 30px; }
  .bar.backlog { background: #90a4ae; }
  .bar.todo { background: #7e57c2; }
  .bar.refined { background: #26a69a; }
  .bar.progress { background: #ffa726; }
  .bar.ready { background: #66bb6a; }
  .bar.done { background: #43a047; }
  .bar.blocked { background: #ef5350; }
  .recommendation { background: #e8f5e9; border-left: 4px solid #4caf50; padding: 1rem; margin: 0.8rem 0; border-radius: 4px; }
  .recommendation.high { background: #fce4ec; border-left-color: #e53935; }
  .recommendation.medium { background: #fff8e1; border-left-color: #ffa000; }
  .recommendation .priority { font-weight: bold; text-transform: uppercase; font-size: 0.75rem; }
  .recommendation .priority.high { color: #c62828; }
  .recommendation .priority.medium { color: #f57f17; }
  .recommendation .priority.low { color: #2e7d32; }
  a { color: #1565c0; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .mermaid { margin: 1.5rem 0; text-align: center; }
  @media print {
    body { margin: 0; font-size: 0.8rem; }
    .summary-card { break-inside: avoid; }
    table { font-size: 0.75rem; }
    h2 { break-before: page; }
  }
</style>
</head>
<body>

<h1>Auditoría del Tablero Project V2 — Intrale Platform</h1>
<div class="meta">
  <strong>Fecha:</strong> ${NOW.toLocaleDateString('es-AR', { year: 'numeric', month: 'long', day: 'numeric' })} |
  <strong>Proyecto:</strong> Intrale (org: intrale, Project #1) |
  <strong>Generado por:</strong> Scrum Master Agent (Claude)
</div>

<!-- ============ RESUMEN EJECUTIVO ============ -->
<h2>1. Resumen Ejecutivo</h2>

<div class="summary-grid">
  <div class="summary-card">
    <div class="number info">${openIssues.length}</div>
    <div class="label-text">Issues abiertos (repo)</div>
  </div>
  <div class="summary-card">
    <div class="number info">${projectItems.length}</div>
    <div class="label-text">Items en Project V2</div>
  </div>
  <div class="summary-card">
    <div class="number ${notInProject.length > 10 ? 'danger' : 'warning'}">${notInProject.length}</div>
    <div class="label-text">Issues NO en el Project</div>
  </div>
  <div class="summary-card">
    <div class="number ${staleIssues.length > 20 ? 'danger' : 'warning'}">${staleIssues.length}</div>
    <div class="label-text">Issues estancados (&gt;14d)</div>
  </div>
  <div class="summary-card">
    <div class="number ${noLabels.length > 0 ? 'warning' : 'ok'}">${noLabels.length}</div>
    <div class="label-text">Sin labels</div>
  </div>
  <div class="summary-card">
    <div class="number ${noAssignee.length > 30 ? 'danger' : 'warning'}">${noAssignee.length}</div>
    <div class="label-text">Sin asignar</div>
  </div>
  <div class="summary-card">
    <div class="number ${noStatus.length > 0 ? 'warning' : 'ok'}">${noStatus.length}</div>
    <div class="label-text">En Project sin status</div>
  </div>
  <div class="summary-card">
    <div class="number">${STATUS_OPTIONS.length}</div>
    <div class="label-text">Columnas del board</div>
  </div>
</div>

<!-- ============ COLUMNAS ============ -->
<h2>2. Columnas / Status del Project V2</h2>

<p>El tablero cuenta con <strong>${STATUS_OPTIONS.length} columnas</strong>:</p>

<table>
<tr><th>#</th><th>Columna</th><th>Tipo</th><th>Items totales</th><th>Abiertos</th><th>Cerrados</th></tr>
${STATUS_OPTIONS.map((s, i) => {
  const items = backlogs[s] || [];
  const open = items.filter(i => i.state === 'OPEN').length;
  const closed = items.filter(i => i.state === 'CLOSED').length;
  const type = s.startsWith('Backlog') ? 'Backlog' : (s === 'Done' ? 'Final' : (s === 'Blocked' ? 'Excepción' : 'Flujo'));
  return `<tr><td>${i+1}</td><td><strong>${s}</strong></td><td>${type}</td><td>${items.length}</td><td>${open}</td><td>${closed}</td></tr>`;
}).join('\n')}
</table>

<h3>Distribución visual</h3>
<div class="bar-chart">
${STATUS_OPTIONS.map(s => {
  const items = (backlogs[s] || []);
  const open = items.filter(i => i.state === 'OPEN').length;
  const maxBar = Math.max(...STATUS_OPTIONS.map(x => (backlogs[x] || []).filter(i => i.state === 'OPEN').length), 1);
  const width = Math.max(Math.round((open / maxBar) * 400), open > 0 ? 30 : 5);
  const cls = s.startsWith('Backlog') ? 'backlog' : s === 'Todo' ? 'todo' : s === 'Refined' ? 'refined' : s === 'In Progress' ? 'progress' : s === 'Ready' ? 'ready' : s === 'Done' ? 'done' : 'blocked';
  return `<div class="bar-row"><span class="bar-label">${s}</span><div class="bar ${cls}" style="width:${width}px">${open}</div></div>`;
}).join('\n')}
</div>

<!-- ============ FLUJO ============ -->
<h2>3. Análisis de Flujo</h2>

<div class="mermaid">
graph LR
  BT["Backlog Tecnico<br/>${backlogTecnico.length}"] --> TODO["Todo<br/>${todoItems.length}"]
  BC["Backlog CLIENTE<br/>${backlogCliente.length}"] --> TODO
  BN["Backlog NEGOCIO<br/>${backlogNegocio.length}"] --> TODO
  BD["Backlog DELIVERY<br/>${backlogDelivery.length}"] --> TODO
  TODO --> REF["Refined<br/>${refinedItems.length}"]
  REF --> IP["In Progress<br/>${inProgressItems.length}"]
  IP --> RDY["Ready<br/>${readyItems.length}"]
  RDY --> DONE["Done<br/>${doneClosed.length + doneOpen.length}"]
  IP --> BLK["Blocked<br/>${blockedItems.length}"]
  BLK --> IP
  style BT fill:#eceff1
  style BC fill:#e3f2fd
  style BN fill:#e8f5e9
  style BD fill:#fff3e0
  style TODO fill:#ede7f6
  style REF fill:#e0f2f1
  style IP fill:#fff8e1
  style RDY fill:#e8f5e9
  style DONE fill:#c8e6c9
  style BLK fill:#ffcdd2
</div>

<h3>Observaciones del flujo</h3>
<ul>
  <li><strong>Backlogs acumulados:</strong> ${backlogTecnico.length + backlogCliente.length + backlogNegocio.length + backlogDelivery.length} issues en los 4 backlogs (${backlogTecnico.length} técnico, ${backlogCliente.length} cliente, ${backlogNegocio.length} negocio, ${backlogDelivery.length} delivery)</li>
  <li><strong>En flujo activo:</strong> ${todoItems.length} Todo + ${refinedItems.length} Refined + ${inProgressItems.length} In Progress + ${readyItems.length} Ready = <strong>${todoItems.length + refinedItems.length + inProgressItems.length + readyItems.length}</strong> items</li>
  <li><strong>Done:</strong> ${doneItems.length} items (${doneClosed.length} cerrados, ${doneOpen.length} aún abiertos)</li>
  <li><strong>Blocked:</strong> ${blockedItems.length} items</li>
  ${closedNotDone.length > 0 ? `<li class="warning"><strong>Issues cerrados NO en Done:</strong> ${closedNotDone.length} items — posible desincronización de automatización</li>` : ''}
  ${doneOpen.length > 0 ? `<li class="warning"><strong>Issues en Done pero aún OPEN:</strong> ${doneOpen.length} items — deberían cerrarse</li>` : ''}
</ul>

<!-- ============ ISSUES SIN LABELS ============ -->
<h2>4. Issues sin Labels</h2>

${noLabels.length === 0 ? '<p class="ok">Todos los issues abiertos tienen al menos un label.</p>' : `
<p class="warning">Se encontraron <strong>${noLabels.length}</strong> issues abiertos sin ningún label:</p>
<table>
<tr><th>#</th><th>Título</th><th>Asignado</th><th>Última actividad</th></tr>
${noLabels.map(i => {
  const assignees = (i.assignees || []).map(a => a.login).join(', ') || '<span class="warning">Sin asignar</span>';
  const updated = new Date(i.updatedAt).toLocaleDateString('es-AR');
  const daysSince = Math.floor((NOW - new Date(i.updatedAt)) / (1000 * 60 * 60 * 24));
  return `<tr><td>${issueLink(i.number)}</td><td>${i.title}</td><td>${assignees}</td><td>${updated} (${daysSince}d)</td></tr>`;
}).join('\n')}
</table>`}

<!-- ============ ISSUES SIN ASIGNAR ============ -->
<h2>5. Issues sin Asignar</h2>

<p>Se encontraron <strong>${noAssignee.length}</strong> issues abiertos sin asignar (${Math.round(noAssignee.length / openIssues.length * 100)}% del total).</p>

${noAssignee.length > 20 ? `<p><em>Se muestran los 20 más recientes. Ver listado completo en el Project V2.</em></p>` : ''}

<table>
<tr><th>#</th><th>Título</th><th>Labels</th><th>Última actividad</th></tr>
${noAssignee.slice(0, 20).map(i => {
  const labels = (i.labels || []).map(l => `<span class="label">${l.name}</span>`).join(' ');
  const updated = new Date(i.updatedAt).toLocaleDateString('es-AR');
  const daysSince = Math.floor((NOW - new Date(i.updatedAt)) / (1000 * 60 * 60 * 24));
  return `<tr><td>${issueLink(i.number)}</td><td>${i.title}</td><td>${labels}</td><td>${updated} (${daysSince}d)</td></tr>`;
}).join('\n')}
</table>

<!-- ============ ISSUES SIN STATUS ============ -->
<h2>6. Issues en Project V2 sin Status Definido</h2>

${noStatus.length === 0 ? '<p class="ok">Todos los items abiertos del Project V2 tienen un status asignado.</p>' : `
<p class="warning">Se encontraron <strong>${noStatus.length}</strong> items abiertos en el Project sin status:</p>
<table>
<tr><th>#</th><th>Título</th><th>Labels</th></tr>
${noStatus.map(i => {
  const labels = i.labels.map(l => `<span class="label">${l}</span>`).join(' ');
  return `<tr><td>${issueLink(i.number)}</td><td>${i.title}</td><td>${labels}</td></tr>`;
}).join('\n')}
</table>`}

<!-- ============ ISSUES NO EN PROJECT ============ -->
<h2>7. Issues Abiertos NO incluidos en el Project V2</h2>

<p>Se encontraron <strong>${notInProject.length}</strong> issues abiertos que NO están en el tablero Project V2.</p>

${notInProject.length > 0 ? `
<table>
<tr><th>#</th><th>Título</th><th>Labels</th><th>Asignado</th><th>Creado</th></tr>
${notInProject.slice(0, 30).map(i => {
  const labels = (i.labels || []).map(l => `<span class="label">${l.name}</span>`).join(' ');
  const assignees = (i.assignees || []).map(a => a.login).join(', ') || '<span class="warning">Sin asignar</span>';
  const created = new Date(i.createdAt).toLocaleDateString('es-AR');
  return `<tr><td>${issueLink(i.number)}</td><td>${i.title}</td><td>${labels}</td><td>${assignees}</td><td>${created}</td></tr>`;
}).join('\n')}
</table>
${notInProject.length > 30 ? `<p><em>... y ${notInProject.length - 30} más.</em></p>` : ''}` : ''}

<!-- ============ ISSUES ESTANCADOS ============ -->
<h2>8. Issues Estancados (&gt;${STALE_DAYS} días sin actividad)</h2>

<p>Se encontraron <strong>${staleIssues.length}</strong> issues sin actividad en más de ${STALE_DAYS} días (${Math.round(staleIssues.length / openIssues.length * 100)}% del total).</p>

<h3>Distribución por antigüedad</h3>
<div class="bar-chart">
${(() => {
  const ranges = [
    { label: '15-30 días', min: 15, max: 30 },
    { label: '31-60 días', min: 31, max: 60 },
    { label: '61-90 días', min: 61, max: 90 },
    { label: '>90 días', min: 91, max: 9999 }
  ];
  const maxCount = Math.max(...ranges.map(r => staleIssues.filter(i => {
    const d = Math.floor((NOW - new Date(i.updatedAt)) / (1000*60*60*24));
    return d >= r.min && d <= r.max;
  }).length), 1);
  return ranges.map(r => {
    const count = staleIssues.filter(i => {
      const d = Math.floor((NOW - new Date(i.updatedAt)) / (1000*60*60*24));
      return d >= r.min && d <= r.max;
    }).length;
    const width = Math.max(Math.round((count / maxCount) * 300), count > 0 ? 30 : 5);
    return `<div class="bar-row"><span class="bar-label">${r.label}</span><div class="bar blocked" style="width:${width}px">${count}</div></div>`;
  }).join('\n');
})()}
</div>

<h3>Top 15 issues más estancados</h3>
<table>
<tr><th>#</th><th>Título</th><th>Labels</th><th>Última actividad</th><th>Días</th></tr>
${staleIssues
  .sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt))
  .slice(0, 15)
  .map(i => {
    const labels = (i.labels || []).map(l => `<span class="label">${l.name}</span>`).join(' ');
    const updated = new Date(i.updatedAt).toLocaleDateString('es-AR');
    const daysSince = Math.floor((NOW - new Date(i.updatedAt)) / (1000 * 60 * 60 * 24));
    return `<tr class="stale"><td>${issueLink(i.number)}</td><td>${i.title}</td><td>${labels}</td><td>${updated}</td><td><strong>${daysSince}</strong></td></tr>`;
  }).join('\n')}
</table>

<!-- ============ BACKLOGS ============ -->
<h2>9. Verificación de Backlogs</h2>

<h3>9.1 Backlog CLIENTE (${backlogCliente.length} items abiertos)</h3>
${backlogCliente.length === 0 ? '<p>Vacío.</p>' : `
<table>
<tr><th>#</th><th>Título</th><th>Labels</th><th>Creado</th></tr>
${backlogCliente.map(i => {
  const labels = i.labels.map(l => `<span class="label">${l}</span>`).join(' ');
  const created = new Date(i.createdAt).toLocaleDateString('es-AR');
  return `<tr><td>${issueLink(i.number)}</td><td>${i.title}</td><td>${labels}</td><td>${created}</td></tr>`;
}).join('\n')}
</table>`}

<h3>9.2 Backlog NEGOCIO (${backlogNegocio.length} items abiertos)</h3>
${backlogNegocio.length === 0 ? '<p>Vacío.</p>' : `
<table>
<tr><th>#</th><th>Título</th><th>Labels</th><th>Creado</th></tr>
${backlogNegocio.map(i => {
  const labels = i.labels.map(l => `<span class="label">${l}</span>`).join(' ');
  const created = new Date(i.createdAt).toLocaleDateString('es-AR');
  return `<tr><td>${issueLink(i.number)}</td><td>${i.title}</td><td>${labels}</td><td>${created}</td></tr>`;
}).join('\n')}
</table>`}

<h3>9.3 Backlog DELIVERY (${backlogDelivery.length} items abiertos)</h3>
${backlogDelivery.length === 0 ? '<p>Vacío.</p>' : `
<table>
<tr><th>#</th><th>Título</th><th>Labels</th><th>Creado</th></tr>
${backlogDelivery.map(i => {
  const labels = i.labels.map(l => `<span class="label">${l}</span>`).join(' ');
  const created = new Date(i.createdAt).toLocaleDateString('es-AR');
  return `<tr><td>${issueLink(i.number)}</td><td>${i.title}</td><td>${labels}</td><td>${created}</td></tr>`;
}).join('\n')}
</table>`}

<h3>9.4 Backlog Técnico (${backlogTecnico.length} items abiertos)</h3>
<p>${backlogTecnico.length} items. Los más recientes:</p>
<table>
<tr><th>#</th><th>Título</th><th>Labels</th><th>Creado</th></tr>
${backlogTecnico
  .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  .slice(0, 10)
  .map(i => {
    const labels = i.labels.map(l => `<span class="label">${l}</span>`).join(' ');
    const created = new Date(i.createdAt).toLocaleDateString('es-AR');
    return `<tr><td>${issueLink(i.number)}</td><td>${i.title}</td><td>${labels}</td><td>${created}</td></tr>`;
  }).join('\n')}
</table>

<!-- ============ LABELS ============ -->
<h2>10. Análisis de Labels</h2>

<h3>10.1 Labels más usados (top 20)</h3>
<div class="bar-chart">
${sortedLabels.slice(0, 20).map(([name, count]) => {
  const maxL = sortedLabels[0][1];
  const width = Math.max(Math.round((count / maxL) * 350), 30);
  return `<div class="bar-row"><span class="bar-label">${name}</span><div class="bar" style="width:${width}px">${count}</div></div>`;
}).join('\n')}
</div>

<h3>10.2 Labels de área (area:*)</h3>
<table>
<tr><th>Label</th><th>Cantidad</th></tr>
${areaLabels.map(([name, count]) => `<tr><td>${name}</td><td>${count}</td></tr>`).join('\n')}
</table>

<h3>10.3 Labels de app (app:*)</h3>
<table>
<tr><th>Label</th><th>Cantidad</th></tr>
${appLabels.map(([name, count]) => `<tr><td>${name}</td><td>${count}</td></tr>`).join('\n')}
</table>

<h3>10.4 Labels de tipo (tipo:*)</h3>
<table>
<tr><th>Label</th><th>Cantidad</th></tr>
${tipoLabels.map(([name, count]) => `<tr><td>${name}</td><td>${count}</td></tr>`).join('\n')}
</table>

<!-- ============ CUELLOS DE BOTELLA ============ -->
<h2>11. Cuellos de Botella Detectados</h2>

<div class="mermaid">
pie title Distribución de items abiertos en Project V2
${projectOpen.length > 0 ? STATUS_OPTIONS.map(s => {
  const count = (backlogs[s] || []).filter(i => i.state === 'OPEN').length;
  return count > 0 ? `  "${s}" : ${count}` : '';
}).filter(Boolean).join('\n') : '  "Vacío" : 1'}
</div>

<ul>
${backlogTecnico.length + backlogCliente.length + backlogNegocio.length + backlogDelivery.length > 40 ? `<li><span class="danger"><strong>Backlogs sobrecargados:</strong></span> ${backlogTecnico.length + backlogCliente.length + backlogNegocio.length + backlogDelivery.length} items acumulados en backlogs. Riesgo de perder visibilidad sobre prioridades.</li>` : ''}
${todoItems.length === 0 && refinedItems.length === 0 ? `<li><span class="warning"><strong>Cuello en refinamiento:</strong></span> No hay items en Todo ni Refined. Los backlogs no están fluyendo hacia el ciclo de desarrollo.</li>` : ''}
${inProgressItems.length > 5 ? `<li><span class="warning"><strong>WIP excesivo:</strong></span> ${inProgressItems.length} items en In Progress. Se recomienda limitar el WIP a 3-5.</li>` : ''}
${blockedItems.length > 0 ? `<li><span class="danger"><strong>Items bloqueados:</strong></span> ${blockedItems.length} items en Blocked.</li>` : ''}
${notInProject.length > 20 ? `<li><span class="danger"><strong>Issues fuera del tablero:</strong></span> ${notInProject.length} issues abiertos no están en el Project V2. Se pierde trazabilidad.</li>` : ''}
${staleIssues.length > openIssues.length * 0.5 ? `<li><span class="danger"><strong>Alta proporción de issues estancados:</strong></span> ${Math.round(staleIssues.length / openIssues.length * 100)}% de issues sin actividad en &gt;14d.</li>` : ''}
${noAssignee.length > openIssues.length * 0.5 ? `<li><span class="warning"><strong>Muchos issues sin asignar:</strong></span> ${noAssignee.length} de ${openIssues.length} (${Math.round(noAssignee.length / openIssues.length * 100)}%). Dificulta la rendición de cuentas.</li>` : ''}
${closedNotDone.length > 0 ? `<li><span class="warning"><strong>Desincronización:</strong></span> ${closedNotDone.length} issues cerrados no están en la columna Done.</li>` : ''}
</ul>

<!-- ============ PROPUESTAS DE MEJORA ============ -->
<h2>12. Propuestas de Mejora Priorizadas</h2>

<h3>PRIORIDAD ALTA</h3>

<div class="recommendation high">
  <div class="priority high">P1 — Incorporar todos los issues abiertos al Project V2</div>
  <p><strong>Problema:</strong> ${notInProject.length} issues abiertos no están en el tablero, lo que impide visualizar el alcance real del trabajo pendiente.</p>
  <p><strong>Acción:</strong> Ejecutar un triaje masivo con <code>/priorizar</code> para agregar los issues faltantes al Project V2 con el status correcto. Automatizar con GitHub Action que añada issues nuevos al Project automáticamente.</p>
  <p><strong>Impacto:</strong> Visibilidad completa del backlog y mejor planificación de sprints.</p>
</div>

<div class="recommendation high">
  <div class="priority high">P2 — Etiquetar issues sin labels</div>
  <p><strong>Problema:</strong> ${noLabels.length} issues sin labels dificultan el filtrado y la priorización.</p>
  <p><strong>Acción:</strong> Aplicar labels de <code>area:*</code>, <code>app:*</code> y <code>tipo:*</code> a todos los issues sin etiquetar. Usar <code>/priorizar</code> para el triaje masivo.</p>
  <p><strong>Impacto:</strong> Mejor categorización y capacidad de filtro en el board.</p>
</div>

<div class="recommendation high">
  <div class="priority high">P3 — Mover issues del backlog al flujo activo</div>
  <p><strong>Problema:</strong> ${backlogTecnico.length + backlogCliente.length + backlogNegocio.length + backlogDelivery.length} items acumulados en backlogs con 0 items en Todo/Refined. Los backlogs no están fluyendo al ciclo de desarrollo.</p>
  <p><strong>Acción:</strong> En cada sprint planning, mover los items priorizados de los backlogs a "Todo". Refinar con <code>/po</code> y mover a "Refined" antes de iniciar desarrollo.</p>
  <p><strong>Impacto:</strong> Activar el flujo de desarrollo con prioridades claras.</p>
</div>

<h3>PRIORIDAD MEDIA</h3>

<div class="recommendation medium">
  <div class="priority medium">P4 — Implementar WIP limits</div>
  <p><strong>Problema:</strong> Sin límite de WIP, existe riesgo de context-switching excesivo cuando hay muchos items en "In Progress".</p>
  <p><strong>Acción:</strong> Establecer WIP limit de 3 para "In Progress" y 5 para "Ready". Implementar validación via GitHub Action o hook en el proceso de triaje.</p>
  <p><strong>Impacto:</strong> Mayor foco y throughput del equipo.</p>
</div>

<div class="recommendation medium">
  <div class="priority medium">P5 — Automatizar movimiento de issues a Done</div>
  <p><strong>Problema:</strong> ${closedNotDone.length} issues cerrados no están en Done, y ${doneOpen.length} issues en Done siguen abiertos.</p>
  <p><strong>Acción:</strong> El hook <code>post-issue-close.js</code> ya existe pero no cubre todos los casos. Agregar GitHub Action que sincronice: issue cerrado → columna Done, y que cierre issues en Done que sigan abiertos.</p>
  <p><strong>Impacto:</strong> Board siempre sincronizado con el estado real.</p>
</div>

<div class="recommendation medium">
  <div class="priority medium">P6 — Revisar y archivar issues estancados</div>
  <p><strong>Problema:</strong> ${staleIssues.length} issues sin actividad en más de 14 días (${Math.round(staleIssues.length / openIssues.length * 100)}% del total). Muchos son historias de backlog de funcionalidad (from-intake) que no se han refinado.</p>
  <p><strong>Acción:</strong> Clasificar los issues estancados en 3 categorías: (a) cerrar si son obsoletos, (b) mantener en backlog si son válidos pero no prioritarios, (c) refinar y mover a Todo si son necesarios a corto plazo.</p>
  <p><strong>Impacto:</strong> Backlog más limpio y menor ruido en la planificación.</p>
</div>

<div class="recommendation medium">
  <div class="priority medium">P7 — Agregar columna "In Review"</div>
  <p><strong>Problema:</strong> El flujo actual salta de "In Progress" a "Ready" sin distinguir el estado de code review/QA.</p>
  <p><strong>Acción:</strong> Agregar columna "In Review" entre "In Progress" y "Ready". El agente <code>/delivery</code> puede mover automáticamente al crear PR. Cuando el PR se mergea → "Ready".</p>
  <p><strong>Impacto:</strong> Mayor visibilidad del proceso de revisión y QA.</p>
</div>

<h3>PRIORIDAD BAJA</h3>

<div class="recommendation">
  <div class="priority low">P8 — Estandarizar uso de labels tipo:*</div>
  <p><strong>Problema:</strong> Solo ${tipoLabels.length} labels de tipo en uso. Muchos issues usan "enhancement" genérico sin tipo: más específico.</p>
  <p><strong>Acción:</strong> Definir labels de tipo estándar: <code>tipo:feature</code>, <code>tipo:bug</code>, <code>tipo:qa</code>, <code>tipo:docs</code>, <code>tipo:refactor</code> y aplicarlos consistentemente.</p>
  <p><strong>Impacto:</strong> Mejor clasificación para métricas de calidad y velocidad.</p>
</div>

<div class="recommendation">
  <div class="priority low">P9 — Implementar GitHub Action para auto-agregar issues al Project</div>
  <p><strong>Problema:</strong> Los issues nuevos no se agregan automáticamente al Project V2.</p>
  <p><strong>Acción:</strong> Crear workflow <code>.github/workflows/add-to-project.yml</code> que añada todo issue nuevo al Project con status según sus labels (ej: <code>from-intake</code> → backlog correspondiente).</p>
  <p><strong>Impacto:</strong> Elimina la tarea manual de agregar issues al board.</p>
</div>

<div class="recommendation">
  <div class="priority low">P10 — Asignar issues de backlog funcional</div>
  <p><strong>Problema:</strong> ${noAssignee.length} issues sin asignar, la mayoría son historias de backlog funcional importadas desde intake.</p>
  <p><strong>Acción:</strong> Asignar un product owner responsable de cada backlog (CLIENTE, NEGOCIO, DELIVERY) y marcar los issues con el responsable.</p>
  <p><strong>Impacto:</strong> Ownership claro de cada área funcional.</p>
</div>

<!-- ============ MÉTRICAS ============ -->
<h2>13. Métricas del Board</h2>

<table>
<tr><th>Métrica</th><th>Valor</th><th>Estado</th></tr>
<tr><td>Issues abiertos totales</td><td>${openIssues.length}</td><td>—</td></tr>
<tr><td>Items en Project V2</td><td>${projectItems.length}</td><td>—</td></tr>
<tr><td>Cobertura del Project</td><td>${Math.round((projectItems.filter(i=>i.state==='OPEN').length / openIssues.length) * 100)}%</td><td class="${projectItems.filter(i=>i.state==='OPEN').length / openIssues.length > 0.8 ? 'ok' : 'danger'}">${projectItems.filter(i=>i.state==='OPEN').length / openIssues.length > 0.8 ? 'OK' : 'BAJA'}</td></tr>
<tr><td>Issues con labels</td><td>${openIssues.length - noLabels.length} / ${openIssues.length} (${Math.round((openIssues.length - noLabels.length) / openIssues.length * 100)}%)</td><td class="${noLabels.length === 0 ? 'ok' : 'warning'}">${noLabels.length === 0 ? 'OK' : 'MEJORAR'}</td></tr>
<tr><td>Issues asignados</td><td>${openIssues.length - noAssignee.length} / ${openIssues.length} (${Math.round((openIssues.length - noAssignee.length) / openIssues.length * 100)}%)</td><td class="${noAssignee.length / openIssues.length < 0.3 ? 'ok' : 'warning'}">${noAssignee.length / openIssues.length < 0.3 ? 'OK' : 'MEJORAR'}</td></tr>
<tr><td>Issues estancados (&gt;14d)</td><td>${staleIssues.length} (${Math.round(staleIssues.length / openIssues.length * 100)}%)</td><td class="${staleIssues.length / openIssues.length < 0.3 ? 'ok' : 'danger'}">${staleIssues.length / openIssues.length < 0.3 ? 'OK' : 'CRITICO'}</td></tr>
<tr><td>WIP (In Progress)</td><td>${inProgressItems.length}</td><td class="${inProgressItems.length <= 5 ? 'ok' : 'warning'}">${inProgressItems.length <= 5 ? 'OK' : 'ALTO'}</td></tr>
<tr><td>Blocked</td><td>${blockedItems.length}</td><td class="${blockedItems.length === 0 ? 'ok' : 'warning'}">${blockedItems.length === 0 ? 'OK' : 'ATENCIÓN'}</td></tr>
<tr><td>Labels de área únicos</td><td>${areaLabels.length}</td><td>—</td></tr>
<tr><td>Labels de app únicos</td><td>${appLabels.length}</td><td>—</td></tr>
</table>

<!-- ============ RESUMEN FINAL ============ -->
<h2>14. Conclusión</h2>

<p>El tablero Project V2 de Intrale tiene una estructura de columnas sólida con ${STATUS_OPTIONS.length} status que cubren el flujo completo desde backlog hasta entrega. Sin embargo, se identifican <strong>3 áreas críticas de mejora</strong>:</p>

<ol>
  <li><strong>Cobertura del Project:</strong> Solo el ${Math.round((projectItems.filter(i=>i.state==='OPEN').length / openIssues.length) * 100)}% de los issues abiertos están en el tablero. Los ${notInProject.length} issues faltantes necesitan ser triageados e incorporados.</li>
  <li><strong>Flujo estancado:</strong> Los backlogs acumulan ${backlogTecnico.length + backlogCliente.length + backlogNegocio.length + backlogDelivery.length} items pero las columnas de flujo activo (Todo, Refined) están vacías. Se necesita un proceso de refinamiento periódico.</li>
  <li><strong>Issues estancados:</strong> El ${Math.round(staleIssues.length / openIssues.length * 100)}% de issues no tiene actividad en &gt;14 días. Se recomienda una revisión masiva para cerrar obsoletos y priorizar los relevantes.</li>
</ol>

<p><strong>Próximos pasos recomendados:</strong></p>
<ol>
  <li>Ejecutar <code>/priorizar</code> para triaje masivo de issues sin labels y fuera del Project</li>
  <li>Sprint planning: mover items priorizados de backlogs a "Todo"</li>
  <li>Agregar columna "In Review" al board</li>
  <li>Implementar GitHub Action para auto-agregar issues nuevos al Project</li>
  <li>Establecer WIP limits y ciclo de revisión quincenal de issues estancados</li>
</ol>

<hr>
<p style="color:#999; font-size:0.8rem; text-align:center;">
  Generado automáticamente por Scrum Master Agent — ${NOW.toISOString()} — Intrale Platform v2.0
</p>

</body>
</html>`;

// Write HTML
const outputFile = path.join(DIR, 'reporte-auditoria-board-project-v2.html');
fs.writeFileSync(outputFile, html, 'utf8');
console.log('Reporte HTML generado:', outputFile);

// Cleanup temp files
try {
  fs.unlinkSync(path.join(DIR, 'project-items-raw.json'));
  fs.unlinkSync(path.join(DIR, 'open-issues-raw.json'));
} catch (e) { /* ignore */ }

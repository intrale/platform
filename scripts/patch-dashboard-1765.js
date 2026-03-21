#!/usr/bin/env node
// Patch script for issue #1765 — dashboard multi-ruta
// Applies patches to .claude/dashboard-server.js

const fs = require('fs');
const path = require('path');

const WT = path.resolve(__dirname, '..');
const src = path.join(WT, '.claude', 'dashboard-server.js');

let c = fs.readFileSync(src, 'utf8');

// ─── Patch 4: New section routes in handleRequest ──────────────────────────
const OLD4 = '  } else if (pathname === "/events") {';
const NEW_ROUTES = `  } else if (pathname === '/overview' || pathname === '/flow' || pathname === '/activity' || pathname === '/roadmap' || pathname === '/cicd') {
    // Rutas de sección dedicada (#1765)
    const sectionMap = {'/overview':'overview','/flow':'flow','/activity':'activity','/roadmap':'roadmap','/cicd':'cicd'};
    const theme = url.searchParams.get("theme") || "dark";
    const data = collectData();
    const sectionKey = sectionMap[pathname];
    let html;
    try { html = renderHTML(data, theme, sectionKey); } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" }); res.end("renderHTML error: " + e.message); return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(Buffer.from(html, "utf8"));
  } else if (pathname === "/logs") {
    // Vista de logs en vivo (#1765)
    const theme = url.searchParams.get("theme") || "dark";
    const html = renderLogsHTML(theme);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(Buffer.from(html, "utf8"));
`;

if (!c.includes(OLD4)) { console.error('PATCH4 marker not found'); process.exit(1); }
c = c.replace(OLD4, NEW_ROUTES + OLD4);
console.log('p4 (new routes):', c.includes("pathname === '/overview'"));

// ─── Patch 5: /api/logs endpoint ──────────────────────────────────────────
const OLD5 = '  } else if (pathname === "/health") {';
const API_LOGS = `  } else if (pathname === '/api/logs') {
    // Logs API (#1765) — lista de agentes o logs de un agente específico
    const agentsOnly = url.searchParams.get('agents') === '1';
    const agentId = url.searchParams.get('agent') || null;
    const lineCount = Math.min(parseInt(url.searchParams.get('n') || '50', 10), 100);
    if (agentsOnly) {
      const registryRaw = (() => { try { return JSON.parse(fs.readFileSync(AGENT_REGISTRY_FILE, 'utf8')); } catch { return {}; } })();
      const sprintData = readJson(SPRINT_PLAN_FILE) || {};
      const allAgentes = [
        ...(sprintData.agentes || []).map(a => ({ ...a, _sec: 'active' })),
        ...(sprintData._queue || []).map(a => ({ ...a, _sec: 'queue' })),
        ...(sprintData._incomplete || []).map(a => ({ ...a, _sec: 'incomplete' })),
      ];
      const regAgents = (registryRaw.agents) || {};
      const agents = allAgentes.map((a, i) => {
        const regEntry = regAgents[String(a.issue)] || {};
        const status = regEntry.status || a._sec || 'queue';
        return { id: String(a.issue || (i + 1)), numero: a.numero || (i + 1), issue: a.issue, branch: a.branch || ('agent/' + a.issue + '-' + (a.slug || '')), status };
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify({ agents }));
    } else if (agentId) {
      const logsDir = path.join(REPO_ROOT, 'scripts', 'logs');
      const logFile = path.join(logsDir, 'agente_' + agentId + '.log');
      const targetFile = fs.existsSync(logFile) ? logFile : SERVER_LOG_FILE;
      let lines = [];
      try {
        const rawContent = fs.readFileSync(targetFile, 'utf8');
        const allFileLines = rawContent.split('\\n').filter(l => l.trim());
        lines = allFileLines.slice(Math.max(0, allFileLines.length - lineCount));
      } catch { lines = ['No se encontro log para agente ' + agentId]; }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify({ agent: agentId, lines, file: path.basename(targetFile) }));
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Especificar ?agents=1 o ?agent=ID' }));
    }
`;

if (!c.includes(OLD5)) { console.error('PATCH5 marker not found'); process.exit(1); }
c = c.replace(OLD5, API_LOGS + OLD5);
console.log('p5 (/api/logs):', c.includes("pathname === '/api/logs'"));

// ─── Patch 6: takeScreenshot targetPath support ────────────────────────────
const OLD6 = '    await page.goto("http://localhost:" + PORT + "/?theme=dark&nosse=1", { waitUntil: "domcontentloaded", timeout: 15000 });';
const NEW6 = `    const targetPath = opts.targetPath || '/';
    const targetQuery = targetPath.includes('?') ? '&theme=dark&nosse=1' : '?theme=dark&nosse=1';
    await page.goto("http://localhost:" + PORT + targetPath + targetQuery, { waitUntil: "domcontentloaded", timeout: 15000 });`;

if (!c.includes(OLD6)) { console.error('PATCH6 marker not found'); process.exit(1); }
c = c.replace(OLD6, NEW6);
console.log('p6 (targetPath):', c.includes('opts.targetPath'));

// ─── Patch 3: renderLogsHTML function ─────────────────────────────────────
// Build the HTML as string concatenation to avoid template literal nesting issues
function buildLogsPageHtml() {
  const lines = [
    '',
    '// --- Logs page HTML (#1765) ---',
    'function renderLogsHTML(theme) {',
    "  const isDark = theme !== 'light';",
    "  const css = [",
    "    ':root{--bg:#0a0b10;--surface:#12141d;--surface2:#1a1d2b;--border:#2a2e42;--text:#e2e4ed;--text-dim:#8b8fa5;--text-muted:#555872;--white:#fff;--green:#34d399;--red:#f87171;--blue:#60a5fa;--yellow:#fbbf24;}',",
    "    '[data-theme=\"light\"]{--bg:#f8fafc;--surface:#fff;--surface2:#f1f5f9;--border:#cbd5e1;--text:#1e293b;--text-dim:#475569;--text-muted:#94a3b8;--white:#0f172a;}',",
    "    '*{box-sizing:border-box;margin:0;padding:0;}',",
    "    'body{font-family:Inter,system-ui,sans-serif;background:var(--bg);color:var(--text);font-size:13px;line-height:1.5;}',",
    "    '.header{background:var(--surface);border-bottom:1px solid var(--border);padding:10px 20px;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;z-index:100;}',",
    "    '.header-title{font-size:14px;font-weight:700;color:var(--white);}',",
    "    '.container{max-width:1200px;margin:0 auto;padding:16px;}',",
    "    '.panel{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:16px;}',",
    "    '.panel-title{font-size:12px;font-weight:700;color:var(--text-dim);text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px;}',",
    "    '.grid2{display:grid;grid-template-columns:320px 1fr;gap:16px;}',",
    "    'table{width:100%;border-collapse:collapse;font-size:12px;}',",
    "    'th{padding:6px 10px;text-align:left;color:var(--text-muted);font-weight:600;border-bottom:1px solid var(--border);}',",
    "    'td{padding:6px 10px;border-bottom:1px solid var(--border);color:var(--text);}',",
    "    'tr:hover td{background:var(--surface2);}',",
    "    'tr.selected td{background:rgba(96,165,250,.1);border-left:2px solid var(--blue);}',",
    "    '.status-active{color:var(--green);font-weight:600;}.status-idle{color:var(--yellow);}.status-done,.status-dead{color:var(--text-muted);}',",
    "    '.log-container{background:var(--surface2);border:1px solid var(--border);border-radius:6px;height:480px;overflow-y:auto;padding:10px;font-family:monospace;font-size:11px;line-height:1.6;}',",
    "    '.log-line{padding:1px 0;white-space:pre-wrap;word-break:break-all;}',",
    "    '.log-line.log-error{color:var(--red);}.log-line.log-warn{color:var(--yellow);}.log-line.log-info{color:var(--blue);}',",
    "    '.controls{display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;align-items:center;}',",
    "    '.btn{background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:4px 12px;font-size:11px;color:var(--text-dim);cursor:pointer;}',",
    "    '.btn:hover{border-color:var(--blue);color:var(--blue);}.btn.paused{background:rgba(251,191,36,.1);border-color:var(--yellow);color:var(--yellow);}',",
    "    '.filter-input{background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:4px 10px;font-size:11px;color:var(--text);flex:1;min-width:120px;}',",
    "    '.empty-state{padding:20px;text-align:center;color:var(--text-muted);}',",
    "    '@keyframes pulse{0%,100%{opacity:1;}50%{opacity:.4;}}',",
    "    '.dot{width:7px;height:7px;border-radius:50%;background:var(--green);animation:pulse 2s infinite;display:inline-block;margin-right:6px;}'",
    "  ].join('');",
    "  const body = [",
    "    '<div class=\"header\">',",
    "    '  <div style=\"display:flex;align-items:center;gap:10px;\"><div class=\"dot\"></div><div class=\"header-title\">Intrale Monitor &mdash; Logs en vivo</div></div>',",
    "    '  <div style=\"display:flex;gap:16px;font-size:11px;color:var(--text-muted);align-items:center;\">',",
    "    '    <a href=\"/\" style=\"color:var(--blue);text-decoration:none;\">&larr; Overview</a>',",
    "    '    <span id=\"upd\">Cargando...</span>',",
    "    '  </div>',",
    "    '</div>',",
    "    '<div class=\"container\">',",
    "    '  <div class=\"grid2\">',",
    "    '    <div class=\"panel\">',",
    "    '      <div class=\"panel-title\">Agentes activos</div>',",
    "    '      <table><thead><tr><th>#</th><th>Issue</th><th>Branch</th><th>Estado</th></tr></thead>',",
    "    '        <tbody id=\"agents-body\"><tr><td colspan=\"4\" class=\"empty-state\">Cargando...</td></tr></tbody>',",
    "    '      </table>',",
    "    '    </div>',",
    "    '    <div class=\"panel\">',",
    "    '      <div class=\"panel-title\" id=\"log-title\">Logs &mdash; seleccion&aacute; un agente</div>',",
    "    '      <div class=\"controls\">',",
    "    '        <button class=\"btn\" id=\"btn-pause\" onclick=\"togglePause()\">&#9646;&#9646; Pausar</button>',",
    "    '        <button class=\"btn\" onclick=\"clearLogs()\">&#128465; Limpiar</button>',",
    "    '        <button class=\"btn\" onclick=\"exportLogs()\">&#8595; Exportar</button>',",
    "    '        <input class=\"filter-input\" id=\"filter-kw\" type=\"text\" placeholder=\"Filtrar...\" oninput=\"applyFilter()\"/>',",
    "    '        <select id=\"filter-type\" class=\"btn\" onchange=\"applyFilter()\" style=\"padding:4px 8px;\"><option value=\"\">Todos</option><option value=\"error\">Errores</option><option value=\"warn\">Warn</option><option value=\"info\">Info</option></select>',",
    "    '      </div>',",
    "    '      <div class=\"log-container\" id=\"log-box\"><div class=\"empty-state\">Seleccion&aacute; un agente</div></div>',",
    "    '    </div>',",
    "    '  </div>',",
    "    '</div>'",
    "  ].join('\\n');",
    "  const script = [",
    "    'var selAgent=null,paused=false,allLines=[];',",
    "    'function esc(s){return String(s||\"\").replace(/&/g,\"&amp;\").replace(/</g,\"&lt;\").replace(/>/g,\"&gt;\");}',",
    "    'function togglePause(){paused=!paused;var b=document.getElementById(\"btn-pause\");b.textContent=paused?\"\\u25b6 Reanudar\":\"\\u23f8 Pausar\";b.className=paused?\"btn paused\":\"btn\";}',",
    "    'function clearLogs(){allLines=[];document.getElementById(\"log-box\").innerHTML=\"\";}'  ,",
    "    'function exportLogs(){var bl=new Blob([allLines.join(\"\\n\")],{type:\"text/plain\"});var a=document.createElement(\"a\");a.href=URL.createObjectURL(bl);a.download=\"logs-\"+(selAgent||\"all\")+\".txt\";a.click();}',",
    "    'function cls(l){var lo=l.toLowerCase();if(lo.includes(\"error\")||lo.includes(\"fail\"))return \"log-error\";if(lo.includes(\"warn\"))return \"log-warn\";if(lo.includes(\"info\")||lo.includes(\"[cmd\")||lo.includes(\"[done\"))return \"log-info\";return \"\";}',",
    "    'function applyFilter(){var kw=(document.getElementById(\"filter-kw\").value||\"\").toLowerCase();var tf=(document.getElementById(\"filter-type\").value||\"\").toLowerCase();document.querySelectorAll(\"#log-box .log-line\").forEach(function(el){var t=(el.textContent||\"\").toLowerCase();el.style.display=((!kw||t.includes(kw))&&(!tf||el.classList.contains(\"log-\"+tf)))?\"\":\"none\";});}',",
    "    'function renderLogs(lines){var b=document.getElementById(\"log-box\");var atBot=b.scrollHeight-b.scrollTop-b.clientHeight<60;if(!lines||!lines.length){b.innerHTML=\"\";return;}var f=document.createDocumentFragment();var kw=(document.getElementById(\"filter-kw\").value||\"\").toLowerCase();var tf=(document.getElementById(\"filter-type\").value||\"\").toLowerCase();lines.forEach(function(l){var cc=cls(l);var d=document.createElement(\"div\");d.className=\"log-line \"+cc;d.textContent=l;if((kw&&!l.toLowerCase().includes(kw))||(tf&&!cc.includes(tf)))d.style.display=\"none\";f.appendChild(d);});b.innerHTML=\"\";b.appendChild(f);if(atBot)b.scrollTop=b.scrollHeight;}',",
    "    'function selA(id){selAgent=id;document.querySelectorAll(\"#agents-body tr\").forEach(function(tr){tr.className=tr.getAttribute(\"data-id\")===id?\"selected\":\"\";});document.getElementById(\"log-title\").textContent=\"Logs: agente \"+id;fetchLogs(id);}',",
    "    'function fetchAgents(){fetch(\"/api/logs?agents=1\").then(function(r){return r.json();}).then(function(d){var tb=document.getElementById(\"agents-body\");if(!d.agents||!d.agents.length){tb.innerHTML=\"<tr><td colspan=4 class=empty-state>Sin agentes</td></tr>\";return;}var h=\"\";d.agents.forEach(function(a){var sc=a.status===\"active\"?\"status-active\":(a.status===\"idle\"?\"status-idle\":\"status-done\");var issue=a.issue?\"<a href=https://github.com/intrale/platform/issues/\"+a.issue+\" target=_blank style=color:var(--blue);>#\"+a.issue+\"</a>\":\"-\";h+=\"<tr class=\\\\\"\"+(a.id===selAgent?\"selected\":\"\")+\"\\\\\" data-id=\\\\\"\"+esc(a.id)+\"\\\\\" onclick=\\\\\"selA(\"+JSON.stringify(a.id)+\")\\\\\" style=cursor:pointer>\"+\"<td>\"+esc(a.numero||a.id)+\"</td><td>\"+issue+\"</td>\"+\"<td style=font-size:11px;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap title=\\\\\"\"+esc(a.branch||\"\")+\"\\\\\">\"+esc(a.branch||\"-\")+\"</td>\"+\"<td><span class=\\\\\"\"+sc+\"\\\\\">\"+esc(a.status||\"?\")+\"</span></td></tr>\";});tb.innerHTML=h;}).catch(function(){});}',",
    "    'function fetchLogs(id){if(paused||!id)return;fetch(\"/api/logs?agent=\"+encodeURIComponent(id)+\"&n=50\").then(function(r){return r.json();}).then(function(d){if(d.lines){allLines=d.lines;renderLogs(d.lines);}document.getElementById(\"upd\").textContent=\"Actualizado \"+new Date().toLocaleTimeString(\"es-AR\",{hour12:false});}).catch(function(){});}',",
    "    'setInterval(function(){fetchAgents();if(selAgent&&!paused)fetchLogs(selAgent);},2000);',",
    "    'fetchAgents();'",
    "  ].join('\\n');",
    "  return '<!DOCTYPE html><html lang=\"es\" data-theme=\"' + (isDark ? 'dark' : 'light') + '\">'",
    "    + '<head><meta charset=\"UTF-8\"/><meta name=\"viewport\" content=\"width=device-width,initial-scale=1.0\"/>'",
    "    + '<title>Intrale Monitor \\u2014 Logs</title>'",
    "    + '<style>' + css + '</style>'",
    "    + '</head><body>'",
    "    + body",
    "    + '<script>' + script + '<\\/script>'",
    "    + '</body></html>';",
    "}",
    ""
  ];
  return lines.join('\n');
}

const logsHtmlFn = buildLogsPageHtml();
const OLD3 = '\r\n// --- HTTP Server ---\r\n';
if (!c.includes(OLD3)) { console.error('PATCH3 marker not found'); process.exit(1); }
c = c.replace(OLD3, '\n' + logsHtmlFn.replace(/\n/g, '\r\n') + OLD3);
console.log('p3 (renderLogsHTML):', c.includes('function renderLogsHTML(theme)'));

// ─── Final verification ────────────────────────────────────────────────────
const checks = [
  ['renderHTML signature', c.includes('function renderHTML(data, theme, section)')],
  ['Section filter', c.includes('Section filter')],
  ['renderLogsHTML', c.includes('function renderLogsHTML(theme)')],
  ['/overview', c.includes("pathname === '/overview'")],
  ['/flow', c.includes("pathname === '/flow'")],
  ['/activity', c.includes("pathname === '/activity'")],
  ['/roadmap', c.includes("pathname === '/roadmap'")],
  ['/cicd', c.includes("pathname === '/cicd'")],
  ['/logs', c.includes('pathname === "/logs"')],
  ['/api/logs', c.includes("pathname === '/api/logs'")],
  ['targetPath', c.includes('opts.targetPath')],
];

let allOk = true;
for (const [n, ok] of checks) {
  console.log((ok ? 'OK' : 'FAIL') + ': ' + n);
  if (!ok) allOk = false;
}

if (allOk) {
  fs.writeFileSync(src, c, 'utf8');
  console.log('\nWRITTEN OK — lines: ' + c.split('\n').length);
} else {
  console.log('\nFAILED — not writing');
  process.exit(1);
}

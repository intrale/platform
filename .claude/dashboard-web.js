#!/usr/bin/env node
// Dashboard Web — Monitor en tiempo real via HTTP + SSE
// Script standalone Node.js puro — sin dependencias externas
// Uso: node .claude/dashboard-web.js [--port 4242] [--host localhost]
// Issue: #913

const http = require("http");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// --- config ---
const REPO_ROOT = path.resolve(__dirname, "..");
const SESSIONS_DIR = path.join(REPO_ROOT, ".claude", "sessions");
const LOG_FILE = path.join(REPO_ROOT, ".claude", "activity-log.jsonl");
const SPRINT_PLAN_FILE = path.join(REPO_ROOT, "scripts", "sprint-plan.json");
const ACTIVE_THRESHOLD = 5 * 60 * 1000;   // 5 min
const IDLE_THRESHOLD = 15 * 60 * 1000;    // 15 min
const DONE_DISPLAY_HOURS = 1;
const RECENT_ACTIVITY_COUNT = 20;
const SSE_HEARTBEAT_MS = 15000;
const DEBOUNCE_MS = 200;

// --- CLI args ---
function parseArg(name, defaultVal) {
  const idx = process.argv.indexOf("--" + name);
  if (idx === -1 || idx + 1 >= process.argv.length) return defaultVal;
  return process.argv[idx + 1];
}

const PORT = parseInt(parseArg("port", "4242"), 10);
const HOST = parseArg("host", "localhost");

// --- data loading (adapted from dashboard.js) ---

function loadSessions() {
  const all = [];
  try {
    if (!fs.existsSync(SESSIONS_DIR)) return all;
    for (const file of fs.readdirSync(SESSIONS_DIR)) {
      if (!file.endsWith(".json")) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), "utf8"));
        if (data.status === "done") {
          const age = Date.now() - new Date(data.last_activity_ts).getTime();
          if (age > DONE_DISPLAY_HOURS * 3600 * 1000) continue;
        }
        all.push(data);
      } catch (e) { /* skip corrupt */ }
    }
  } catch (e) { /* dir missing */ }
  all.sort((a, b) => new Date(b.last_activity_ts) - new Date(a.last_activity_ts));
  return all;
}

function loadRecentActivity() {
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    const content = fs.readFileSync(LOG_FILE, "utf8").trim();
    if (!content) return [];
    const lines = content.split("\n");
    const recent = lines.slice(-RECENT_ACTIVITY_COUNT).reverse();
    return recent.map(line => {
      try { return JSON.parse(line); } catch (e) { return null; }
    }).filter(Boolean);
  } catch (e) { return []; }
}

function loadSprintPlan() {
  try {
    if (!fs.existsSync(SPRINT_PLAN_FILE)) return null;
    return JSON.parse(fs.readFileSync(SPRINT_PLAN_FILE, "utf8"));
  } catch (e) { return null; }
}

function getGitInfo() {
  try {
    const branch = execSync("git branch --show-current", { cwd: REPO_ROOT, timeout: 3000 })
      .toString().trim();
    const commit = execSync("git log --oneline -1", { cwd: REPO_ROOT, timeout: 3000 })
      .toString().trim();
    return { branch, commit };
  } catch (e) { return { branch: "???", commit: "???" }; }
}

function livenessStatus(session) {
  if (session.status === "done") return "done";
  const diff = Date.now() - new Date(session.last_activity_ts).getTime();
  if (diff < ACTIVE_THRESHOLD) return "active";
  if (diff < IDLE_THRESHOLD) return "idle";
  return "stale";
}

// Cache de CPU snapshots para detectar zombies (CPU=0 entre polls)
let prevCpuSnapshot = {};

function getClaudeProcesses() {
  try {
    const output = execSync(
      'wmic process where "Name=\'node.exe\'" get ProcessId,CommandLine,CreationDate,UserModeTime /format:list',
      { cwd: REPO_ROOT, timeout: 10000, windowsHide: true }
    ).toString();

    const records = output.split(/\r?\n\r?\n/).filter(r => r.trim());
    const claudeProcs = [];

    for (const record of records) {
      const fields = {};
      for (const line of record.split(/\r?\n/)) {
        const eq = line.indexOf("=");
        if (eq === -1) continue;
        fields[line.substring(0, eq).trim()] = line.substring(eq + 1).trim();
      }
      if (!fields.CommandLine || !fields.CommandLine.match(/claude-code[/\\]cli\.js/)) continue;

      const pid = parseInt(fields.ProcessId, 10);
      const isAgent = /bypassPermissions/.test(fields.CommandLine);
      const cpuTime = parseInt(fields.UserModeTime, 10) || 0;

      // Detectar zombie: CPU identica entre polls
      const prevCpu = prevCpuSnapshot[pid];
      const isZombie = prevCpu !== undefined && prevCpu === cpuTime;

      // Parsear CreationDate de WMI (yyyyMMddHHmmss.ffffff±UUU)
      let startedAt = null;
      if (fields.CreationDate) {
        const m = fields.CreationDate.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
        if (m) startedAt = new Date(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6]).toISOString();
      }

      claudeProcs.push({ pid, isAgent, startedAt, cpuTime, isZombie });
    }

    // Actualizar snapshot de CPU
    const newSnapshot = {};
    for (const p of claudeProcs) newSnapshot[p.pid] = p.cpuTime;
    prevCpuSnapshot = newSnapshot;

    return claudeProcs;
  } catch (e) { return []; }
}

function collectData() {
  const allSessions = loadSessions();
  const sessions = allSessions.map(s => ({
    ...s,
    liveness: livenessStatus(s)
  }));
  const processes = getClaudeProcesses();
  return {
    sessions,
    processes,
    activity: loadRecentActivity(),
    sprintPlan: loadSprintPlan(),
    git: getGitInfo(),
    timestamp: new Date().toISOString()
  };
}

// --- SSE management ---
const sseClients = new Set();

function broadcastSSE(data) {
  const payload = "data: " + JSON.stringify(data) + "\n\n";
  for (const res of sseClients) {
    try { res.write(payload); } catch (e) { sseClients.delete(res); }
  }
}

// --- file watching with debounce ---
let debounceTimer = null;

function onFileChange() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    if (sseClients.size > 0) {
      broadcastSSE(collectData());
    }
  }, DEBOUNCE_MS);
}

function setupWatchers() {
  try {
    if (fs.existsSync(SESSIONS_DIR)) {
      fs.watch(SESSIONS_DIR, { persistent: false }, (event, filename) => {
        if (filename && filename.endsWith(".json")) onFileChange();
      });
    }
  } catch (e) { /* fs.watch not available */ }

  try {
    if (fs.existsSync(LOG_FILE)) {
      fs.watch(LOG_FILE, { persistent: false }, () => onFileChange());
    }
  } catch (e) { /* fs.watch not available */ }

  try {
    if (fs.existsSync(SPRINT_PLAN_FILE)) {
      fs.watch(SPRINT_PLAN_FILE, { persistent: false }, () => onFileChange());
    }
  } catch (e) { /* fs.watch not available */ }
}

// --- HTML SPA (inline) ---
function getHTML() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Intrale Monitor</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html { font-size: 14px; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    background: #0d1117;
    color: #c9d1d9;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }
  a { color: #58a6ff; text-decoration: none; }
  a:hover { text-decoration: underline; }

  /* Header */
  .header {
    background: #161b22;
    border-bottom: 1px solid #30363d;
    padding: 12px 20px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
  }
  .header-left {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .header h1 {
    font-size: 1.2rem;
    font-weight: 600;
    color: #f0f6fc;
  }
  .sse-indicator {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 0.8rem;
    color: #8b949e;
  }
  .sse-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #f85149;
    transition: background 0.3s;
  }
  .sse-dot.connected { background: #3fb950; }
  .header-right {
    font-size: 0.8rem;
    color: #8b949e;
  }

  /* Main grid */
  .main {
    flex: 1;
    padding: 16px;
    display: grid;
    grid-template-columns: 1fr;
    gap: 16px;
    max-width: 1400px;
    width: 100%;
    margin: 0 auto;
  }
  @media (min-width: 900px) {
    .main {
      grid-template-columns: 1fr 1fr;
    }
    .panel-sessions { grid-column: 1 / -1; }
    .panel-subagents { grid-column: 1 / -1; }
    .panel-sprint { grid-column: 1 / -1; }
  }

  /* Panels */
  .panel {
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 6px;
    overflow: hidden;
  }
  .panel-header {
    padding: 10px 16px;
    border-bottom: 1px solid #30363d;
    font-size: 0.85rem;
    font-weight: 600;
    color: #f0f6fc;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .panel-body {
    padding: 0;
    overflow-x: auto;
  }
  .panel-empty {
    padding: 20px 16px;
    text-align: center;
    color: #8b949e;
    font-size: 0.85rem;
  }

  /* Tables */
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.85rem;
  }
  thead th {
    text-align: left;
    padding: 8px 12px;
    color: #8b949e;
    font-weight: 500;
    border-bottom: 1px solid #30363d;
    white-space: nowrap;
  }
  tbody td {
    padding: 8px 12px;
    border-bottom: 1px solid #21262d;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 200px;
  }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr:hover { background: #1c2128; }

  /* Status indicators */
  .status-dot {
    display: inline-block;
    width: 10px;
    text-align: center;
    font-size: 0.9rem;
  }
  .status-active { color: #3fb950; }
  .status-idle { color: #d29922; }
  .status-stale { color: #8b949e; }
  .status-done { color: #8b949e; }

  /* Activity list */
  .activity-list {
    list-style: none;
    padding: 0;
  }
  .activity-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 16px;
    border-bottom: 1px solid #21262d;
    font-size: 0.8rem;
  }
  .activity-item:last-child { border-bottom: none; }
  .activity-ts {
    color: #8b949e;
    font-family: monospace;
    flex-shrink: 0;
    min-width: 60px;
  }
  .activity-session {
    color: #58a6ff;
    flex-shrink: 0;
    min-width: 70px;
    font-family: monospace;
  }
  .activity-tool {
    color: #d2a8ff;
    flex-shrink: 0;
    min-width: 80px;
  }
  .activity-target {
    color: #8b949e;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Git info */
  .git-info {
    padding: 12px 16px;
    font-size: 0.85rem;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .git-label {
    color: #8b949e;
    margin-right: 8px;
  }
  .git-value {
    color: #c9d1d9;
    font-family: monospace;
  }
  .git-branch { color: #3fb950; }

  /* Sprint table */
  .sprint-stream {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 0.75rem;
    font-weight: 600;
  }
  .stream-B { background: #1f3d2a; color: #3fb950; }
  .stream-C { background: #2d1f3d; color: #d2a8ff; }
  .stream-D { background: #3d2e1f; color: #d29922; }
  .stream-E { background: #1f2d3d; color: #58a6ff; }

  .sprint-size {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 0.75rem;
    font-weight: 600;
    background: #21262d;
    color: #8b949e;
  }

  /* Footer */
  .footer {
    background: #161b22;
    border-top: 1px solid #30363d;
    padding: 10px 20px;
    text-align: center;
    font-size: 0.75rem;
    color: #8b949e;
  }

  /* Responsive */
  @media (max-width: 600px) {
    .header { padding: 10px 12px; }
    .main { padding: 8px; gap: 8px; }
    table { font-size: 0.78rem; }
    thead th, tbody td { padding: 6px 8px; }
    .activity-item { padding: 5px 10px; gap: 6px; }
  }

  /* Scrollbar */
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: #0d1117; }
  ::-webkit-scrollbar-thumb { background: #30363d; border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: #484f58; }

  .status-zombie { color: #f85149; }
  .row-zombie { background: #3d1f1f !important; }
  .hidden { display: none !important; }
</style>
</head>
<body>

<header class="header">
  <div class="header-left">
    <h1>Intrale Monitor</h1>
    <span class="sse-indicator">
      <span id="sse-dot" class="sse-dot"></span>
      <span id="sse-label">Conectando...</span>
    </span>
  </div>
  <div class="header-right">
    <span id="last-update">--</span>
  </div>
</header>

<main class="main">
  <!-- Sesiones activas (parent) -->
  <div class="panel panel-sessions">
    <div class="panel-header">Sesiones activas</div>
    <div class="panel-body">
      <div id="sessions-empty" class="panel-empty">Sin sesiones registradas</div>
      <table id="sessions-table" class="hidden">
        <thead>
          <tr>
            <th>ID</th>
            <th>Agente</th>
            <th>Acciones</th>
            <th>Duracion</th>
            <th>Ultima accion</th>
            <th>Estado</th>
          </tr>
        </thead>
        <tbody id="sessions-body"></tbody>
      </table>
    </div>
  </div>

  <!-- Procesos Claude -->
  <div id="processes-panel" class="panel panel-sessions hidden">
    <div class="panel-header">Procesos Claude</div>
    <div class="panel-body">
      <table>
        <thead>
          <tr>
            <th>PID</th>
            <th>Tipo</th>
            <th>Inicio</th>
            <th>CPU (s)</th>
            <th>Estado</th>
          </tr>
        </thead>
        <tbody id="processes-body"></tbody>
      </table>
    </div>
  </div>

  <!-- Sub-agentes -->
  <div id="subagents-panel" class="panel panel-subagents hidden">
    <div class="panel-header">Sub-agentes</div>
    <div class="panel-body">
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Rama</th>
            <th>Acciones</th>
            <th>Duracion</th>
            <th>Estado</th>
          </tr>
        </thead>
        <tbody id="subagents-body"></tbody>
      </table>
    </div>
  </div>

  <!-- Actividad reciente -->
  <div class="panel panel-activity">
    <div class="panel-header">Actividad reciente</div>
    <div class="panel-body">
      <div id="activity-empty" class="panel-empty">Sin actividad registrada</div>
      <ul id="activity-list" class="activity-list hidden"></ul>
    </div>
  </div>

  <!-- Git -->
  <div class="panel panel-git">
    <div class="panel-header">Repositorio</div>
    <div class="panel-body">
      <div class="git-info">
        <div>
          <span class="git-label">Rama:</span>
          <span id="git-branch" class="git-value git-branch">--</span>
        </div>
        <div>
          <span class="git-label">Commit:</span>
          <span id="git-commit" class="git-value">--</span>
        </div>
      </div>
    </div>
  </div>

  <!-- Sprint plan -->
  <div id="sprint-panel" class="panel panel-sprint hidden">
    <div class="panel-header">Plan de Sprint</div>
    <div class="panel-body">
      <div id="sprint-title" style="padding: 8px 16px; font-size: 0.8rem; color: #8b949e;"></div>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Issue</th>
            <th>Titulo</th>
            <th>Stream</th>
            <th>Size</th>
          </tr>
        </thead>
        <tbody id="sprint-body"></tbody>
      </table>
    </div>
  </div>
</main>

<footer class="footer">
  Intrale Platform Monitor &mdash; <span id="footer-ts"></span>
</footer>

<script>
(function() {
  "use strict";

  // --- DOM refs ---
  var sseDot = document.getElementById("sse-dot");
  var sseLabel = document.getElementById("sse-label");
  var lastUpdate = document.getElementById("last-update");
  var sessionsEmpty = document.getElementById("sessions-empty");
  var sessionsTable = document.getElementById("sessions-table");
  var sessionsBody = document.getElementById("sessions-body");
  var subagentsPanel = document.getElementById("subagents-panel");
  var subagentsBody = document.getElementById("subagents-body");
  var activityEmpty = document.getElementById("activity-empty");
  var activityList = document.getElementById("activity-list");
  var gitBranch = document.getElementById("git-branch");
  var gitCommit = document.getElementById("git-commit");
  var processesPanel = document.getElementById("processes-panel");
  var processesBody = document.getElementById("processes-body");
  var sprintPanel = document.getElementById("sprint-panel");
  var sprintTitle = document.getElementById("sprint-title");
  var sprintBody = document.getElementById("sprint-body");
  var footerTs = document.getElementById("footer-ts");

  // --- helpers ---
  function formatDuration(startTs, endTs) {
    if (!startTs || !endTs) return "???";
    var diff = new Date(endTs).getTime() - new Date(startTs).getTime();
    if (diff < 0) return "0s";
    var secs = Math.floor(diff / 1000);
    if (secs < 60) return secs + "s";
    var mins = Math.floor(secs / 60);
    var remSecs = secs % 60;
    if (mins < 60) return mins + "m" + (remSecs > 0 ? remSecs + "s" : "");
    var hours = Math.floor(mins / 60);
    var remMins = mins % 60;
    return hours + "h" + (remMins > 0 ? remMins + "m" : "");
  }

  function extractFilename(target) {
    if (!target) return "--";
    var t = target;
    if (t.indexOf("/") !== -1 || t.indexOf("\\\\") !== -1) {
      var parts = t.replace(/\\\\/g, "/").split("/");
      t = parts[parts.length - 1];
    }
    if (t.length > 40) t = t.substring(0, 39) + "\\u2026";
    return t;
  }

  function lastActionLabel(session) {
    if (!session.last_tool || session.last_tool === "--") return "\\u2014";
    var t = extractFilename(session.last_target || "--");
    var label = session.last_tool + ": " + t;
    if (label.length > 40) label = label.substring(0, 39) + "\\u2026";
    return label;
  }

  function statusIcon(liveness) {
    switch (liveness) {
      case "active": return '<span class="status-dot status-active">\\u25CF</span>';
      case "idle":   return '<span class="status-dot status-idle">\\u25D0</span>';
      case "stale":  return '<span class="status-dot status-stale">\\u25CB</span>';
      case "done":   return '<span class="status-dot status-done">\\u2717</span>';
      default:       return '<span class="status-dot">?</span>';
    }
  }

  function statusLabel(liveness) {
    switch (liveness) {
      case "active": return "activa";
      case "idle":   return "idle";
      case "stale":  return "stale";
      case "done":   return "done";
      default:       return "?";
    }
  }

  function escapeHtml(str) {
    if (!str) return "";
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function formatTime(isoTs) {
    if (!isoTs) return "--";
    return isoTs.substring(11, 19);
  }

  function formatTimestamp(isoTs) {
    if (!isoTs) return "--";
    var d = new Date(isoTs);
    return d.toLocaleString();
  }

  // --- render functions ---
  function renderSessions(sessions) {
    var parents = sessions.filter(function(s) { return s.type !== "sub"; });
    var subs = sessions.filter(function(s) { return s.type === "sub"; });

    // Parent sessions
    if (parents.length === 0) {
      sessionsEmpty.classList.remove("hidden");
      sessionsTable.classList.add("hidden");
    } else {
      sessionsEmpty.classList.add("hidden");
      sessionsTable.classList.remove("hidden");
      var html = "";
      for (var i = 0; i < parents.length; i++) {
        var s = parents[i];
        var agent = escapeHtml(s.agent_name || "Claude");
        var dur = formatDuration(s.started_ts, s.last_activity_ts);
        var action = escapeHtml(lastActionLabel(s));
        html += "<tr>" +
          "<td><code>" + escapeHtml(s.id) + "</code></td>" +
          "<td>" + agent + "</td>" +
          "<td>" + (s.action_count || 0) + "</td>" +
          "<td>" + dur + "</td>" +
          "<td>" + action + "</td>" +
          "<td>" + statusIcon(s.liveness) + " " + statusLabel(s.liveness) + "</td>" +
          "</tr>";
      }
      sessionsBody.innerHTML = html;
    }

    // Sub-agents
    if (subs.length === 0) {
      subagentsPanel.classList.add("hidden");
    } else {
      subagentsPanel.classList.remove("hidden");
      var subHtml = "";
      for (var j = 0; j < subs.length; j++) {
        var sub = subs[j];
        var subDur = formatDuration(sub.started_ts, sub.last_activity_ts);
        subHtml += "<tr>" +
          "<td><code>" + escapeHtml(sub.id) + "</code></td>" +
          "<td>" + escapeHtml(sub.branch || "--") + "</td>" +
          "<td>" + (sub.action_count || 0) + "</td>" +
          "<td>" + subDur + "</td>" +
          "<td>" + statusIcon(sub.liveness) + " " + statusLabel(sub.liveness) + "</td>" +
          "</tr>";
      }
      subagentsBody.innerHTML = subHtml;
    }
  }

  function renderActivity(activity) {
    if (!activity || activity.length === 0) {
      activityEmpty.classList.remove("hidden");
      activityList.classList.add("hidden");
      return;
    }
    activityEmpty.classList.add("hidden");
    activityList.classList.remove("hidden");

    var html = "";
    for (var i = 0; i < activity.length; i++) {
      var entry = activity[i];
      var ts = formatTime(entry.ts);
      var session = escapeHtml(entry.session || "\\u2014");
      var tool = escapeHtml(entry.tool || "?");
      var target = escapeHtml(extractFilename(entry.target));
      html += '<li class="activity-item">' +
        '<span class="activity-ts">' + ts + '</span>' +
        '<span class="activity-session">' + session + '</span>' +
        '<span class="activity-tool">' + tool + '</span>' +
        '<span class="activity-target">' + target + '</span>' +
        '</li>';
    }
    activityList.innerHTML = html;
  }

  function renderGit(git) {
    gitBranch.textContent = git.branch || "???";
    gitCommit.textContent = git.commit || "???";
  }

  function renderSprint(plan) {
    if (!plan || !plan.agentes || plan.agentes.length === 0) {
      sprintPanel.classList.add("hidden");
      return;
    }
    sprintPanel.classList.remove("hidden");
    sprintTitle.textContent = (plan.titulo || "") + (plan.fecha ? " \\u2014 " + plan.fecha : "");

    var html = "";
    for (var i = 0; i < plan.agentes.length; i++) {
      var ag = plan.agentes[i];
      var streamClass = "stream-" + (ag.stream || "E");
      html += "<tr>" +
        "<td>" + (ag.numero || i + 1) + "</td>" +
        "<td><a href=\\"https://github.com/intrale/platform/issues/" + ag.issue + "\\" target=\\"_blank\\">#" + ag.issue + "</a></td>" +
        "<td>" + escapeHtml(ag.titulo) + "</td>" +
        '<td><span class="sprint-stream ' + streamClass + '">' + escapeHtml(ag.stream || "?") + '</span></td>' +
        '<td><span class="sprint-size">' + escapeHtml(ag.size || "?") + '</span></td>' +
        "</tr>";
    }
    sprintBody.innerHTML = html;
  }

  function renderProcesses(processes, sessions) {
    if (!processes || processes.length === 0) {
      processesPanel.classList.add("hidden");
      return;
    }
    // Solo mostrar agentes (bypassPermissions) — los procesos interactivos no interesan
    var agents = processes.filter(function(p) { return p.isAgent; });
    if (agents.length === 0) {
      processesPanel.classList.add("hidden");
      return;
    }
    processesPanel.classList.remove("hidden");
    var html = "";
    for (var i = 0; i < agents.length; i++) {
      var p = agents[i];
      var tipo = "Agente";
      var cpuSecs = Math.round((p.cpuTime || 0) / 10000000);
      var started = p.startedAt ? formatTime(p.startedAt) : "--";
      var statusHtml;
      var rowClass = "";
      if (p.isZombie) {
        statusHtml = '<span class="status-dot status-zombie">&#x2620;</span> zombie';
        rowClass = ' class="row-zombie"';
      } else {
        statusHtml = '<span class="status-dot status-active">&#x25CF;</span> activo';
      }
      html += "<tr" + rowClass + ">" +
        "<td><code>" + p.pid + "</code></td>" +
        "<td>" + tipo + "</td>" +
        "<td>" + started + "</td>" +
        "<td>" + cpuSecs + "</td>" +
        "<td>" + statusHtml + "</td>" +
        "</tr>";
    }
    processesBody.innerHTML = html;
  }

  function renderAll(data) {
    renderSessions(data.sessions || []);
    renderProcesses(data.processes || [], data.sessions || []);
    renderActivity(data.activity || []);
    renderGit(data.git || {});
    renderSprint(data.sprintPlan);

    var ts = formatTimestamp(data.timestamp);
    lastUpdate.textContent = "Actualizado: " + ts;
    footerTs.textContent = ts;
  }

  // --- SSE connection with exponential backoff ---
  var evtSource = null;
  var reconnectDelay = 1000;
  var maxReconnectDelay = 30000;

  function setSSEStatus(connected) {
    if (connected) {
      sseDot.classList.add("connected");
      sseLabel.textContent = "Conectado";
      reconnectDelay = 1000;
    } else {
      sseDot.classList.remove("connected");
      sseLabel.textContent = "Reconectando...";
    }
  }

  function connectSSE() {
    if (evtSource) {
      try { evtSource.close(); } catch(e) {}
    }
    evtSource = new EventSource("/api/stream");

    evtSource.onopen = function() {
      setSSEStatus(true);
    };

    evtSource.onmessage = function(event) {
      try {
        var data = JSON.parse(event.data);
        renderAll(data);
        setSSEStatus(true);
      } catch(e) {
        console.error("Error parsing SSE data:", e);
      }
    };

    evtSource.addEventListener("ping", function() {
      // heartbeat — keep connection indication green
      setSSEStatus(true);
    });

    evtSource.onerror = function() {
      setSSEStatus(false);
      try { evtSource.close(); } catch(e) {}
      evtSource = null;
      // Exponential backoff
      setTimeout(function() {
        reconnectDelay = Math.min(reconnectDelay * 2, maxReconnectDelay);
        connectSSE();
      }, reconnectDelay);
    };
  }

  // --- initial load via fetch, then SSE ---
  function initialLoad() {
    var xhr = new XMLHttpRequest();
    xhr.open("GET", "/api/data");
    xhr.onload = function() {
      if (xhr.status === 200) {
        try {
          renderAll(JSON.parse(xhr.responseText));
        } catch(e) {}
      }
    };
    xhr.send();
  }

  initialLoad();
  connectSSE();
})();
</script>
</body>
</html>`;
}

// --- HTTP server ---
const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];

  // CORS headers for local dev
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method === "GET" && url === "/") {
    // Serve SPA
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(getHTML());
    return;
  }

  if (req.method === "GET" && url === "/api/data") {
    // JSON snapshot
    const data = collectData();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(data));
    return;
  }

  if (req.method === "GET" && url === "/api/stream") {
    // SSE stream
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    });
    res.flushHeaders();

    // Send initial data
    res.write("data: " + JSON.stringify(collectData()) + "\n\n");

    // Register client
    sseClients.add(res);

    // Heartbeat
    const heartbeat = setInterval(() => {
      try { res.write("event: ping\ndata: {}\n\n"); }
      catch (e) { clearInterval(heartbeat); sseClients.delete(res); }
    }, SSE_HEARTBEAT_MS);

    // Cleanup on close
    req.on("close", () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    });
    return;
  }

  // 404
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

// --- start ---
setupWatchers();

server.listen(PORT, HOST, () => {
  console.log("Intrale Monitor running at http://" + HOST + ":" + PORT);
  console.log("Press Ctrl+C to stop");
});

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  for (const res of sseClients) {
    try { res.end(); } catch (e) {}
  }
  sseClients.clear();
  server.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  for (const res of sseClients) {
    try { res.end(); } catch (e) {}
  }
  sseClients.clear();
  server.close();
  process.exit(0);
});

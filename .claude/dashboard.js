#!/usr/bin/env node
// Monitor v3 — Dashboard Live Multi-Sesion + Reporter Telegram con PNG
// Uso: node .claude/dashboard.js [--verbose] [--report <minutos>] [--headless]
//   --report N   enviar resumen PNG a Telegram cada N minutos (defecto: deshabilitado)
//   --report 0   deshabilitar reporter explícitamente
//   --headless   solo reporter Telegram, sin UI de terminal (para background)
// Teclado (solo con UI): q=salir, v=toggle verbose, r=refresh manual
// Dependencia opcional: npm install canvas (para reporte PNG; sin canvas usa texto plano)
const fs = require("fs");
const path = require("path");
const https = require("https");
const querystring = require("querystring");
const { execSync } = require("child_process");

// Canvas opcional — si no está disponible, fallback a texto plano
let createCanvas = null;
try { createCanvas = require("canvas").createCanvas; } catch(e) { /* canvas no disponible */ }

// --- config ---
const REPO_ROOT = path.resolve(__dirname, "..");
const SESSIONS_DIR = path.join(REPO_ROOT, ".claude", "sessions");
const LOG_FILE = path.join(REPO_ROOT, ".claude", "activity-log.jsonl");
const REFRESH_MS = 5000;
const ACTIVE_THRESHOLD = 5 * 60 * 1000;   // 5 min
const IDLE_THRESHOLD = 15 * 60 * 1000;    // 15 min
const DONE_DISPLAY_HOURS = 0.25;       // 15 min — sesiones "done" desaparecen rápido
const STALE_EXPIRY_HOURS = 0.5;        // 30 min — sesiones "active" sin actividad → tratar como expiradas
const RECENT_ACTIVITY_COUNT = 5;

// --- ANSI colors ---
const C = {
  reset:  "\x1B[0m",
  bold:   "\x1B[1m",
  dim:    "\x1B[2m",
  red:    "\x1B[31m",
  green:  "\x1B[32m",
  yellow: "\x1B[33m",
  blue:   "\x1B[34m",
  cyan:   "\x1B[36m",
  white:  "\x1B[37m",
  bgRed:  "\x1B[41m",
};

const HIDE_CURSOR = "\x1B[?25l";
const SHOW_CURSOR = "\x1B[?25h";

// --- Telegram reporter config (centralizado en telegram-config.json) ---
const _tgDashCfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, "hooks", "telegram-config.json"), "utf8")); } catch(e) { return { bot_token: "", chat_id: "" }; } })();
const TG_BOT_TOKEN = _tgDashCfg.bot_token;
const TG_CHAT_ID = _tgDashCfg.chat_id;
const TG_MAX_RETRIES = 2;
const TG_RETRY_DELAY_MS = 1500;

// Colores para imagen PNG del dashboard
const IMG = {
  BG: "#1E1E2E", PANEL_BG: "#2A2A3E", HEADER: "#CDD6F4", TEXT: "#BAC2DE",
  DIM: "#6C7086", GREEN: "#2ECC71", YELLOW: "#F1C40F", GRAY: "#7F8C8D",
  RED: "#E74C3C", CYAN: "#89B4FA", ACCENT: "#B4BEFE",
};

const DEBUG_LOG = path.join(REPO_ROOT, ".claude", "hooks", "hook-debug.log");
function debugLog(msg) {
  try { fs.appendFileSync(DEBUG_LOG, "[" + new Date().toISOString() + "] dashboard-img: " + msg + "\n"); } catch(e) {}
}

function parseReportInterval() {
  const idx = process.argv.indexOf("--report");
  if (idx === -1) return 0;
  const val = parseInt(process.argv[idx + 1], 10);
  return isNaN(val) || val < 0 ? 3 : val;
}

// --- state ---
let verbose = process.argv.includes("--verbose") || process.argv.includes("-v");
const headless = process.argv.includes("--headless");
const reportIntervalMin = parseReportInterval();
let refreshTimer = null;
let reportTimer = null;
let lastReportTs = null;

// --- helpers ---

function truncate(str, max) {
  if (!str) return "";
  if (str.length <= max) return str;
  return str.substring(0, max - 1) + "\u2026";
}

function padEnd(str, len) {
  if (str.length >= len) return str.substring(0, len);
  return str + " ".repeat(len - str.length);
}

function formatAge(isoTs) {
  if (!isoTs) return "???";
  const diff = Date.now() - new Date(isoTs).getTime();
  if (diff < 0) return "ahora";
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return secs + "s";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return mins + "m";
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + "h";
  return Math.floor(hours / 24) + "d";
}

function formatDuration(startTs, endTs) {
  if (!startTs || !endTs) return "???";
  const diff = new Date(endTs).getTime() - new Date(startTs).getTime();
  if (diff < 0) return "0s";
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return secs + "s";
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return mins + "m" + (remSecs > 0 ? remSecs + "s" : "");
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return hours + "h" + (remMins > 0 ? remMins + "m" : "");
}

/**
 * Extrae el número de issue de la rama (ej: agent/1045-slug → #1045)
 */
function extractIssueFromBranch(branch) {
  if (!branch) return null;
  const m = branch.match(/(?:agent|codex|fix|feature|bugfix|docs|refactor)\/(\d+)/);
  return m ? "#" + m[1] : null;
}

/**
 * Nombre de display del agente: "Guru (#1045)" o "Claude (main)"
 */
function agentDisplayName(session) {
  const name = session.agent_name || "Claude";
  const issue = extractIssueFromBranch(session.branch);
  if (issue) return name + " (" + issue + ")";
  return name;
}

function lastActionLabel(session) {
  if (!session.last_tool || session.last_tool === "--") return "\u2014";
  let t = session.last_target || "--";
  // Extraer solo el nombre de archivo si es una ruta
  if (t.includes("/") || t.includes("\\")) {
    const parts = t.replace(/\\/g, "/").split("/");
    t = parts[parts.length - 1];
  }
  return truncate(session.last_tool + ": " + t, 24);
}

function livenessIcon(session) {
  if (session.status === "done") return C.dim + "\u2717" + C.reset; // ✗
  const diff = Date.now() - new Date(session.last_activity_ts).getTime();
  if (diff < ACTIVE_THRESHOLD) return C.green + "\u25CF" + C.reset; // ●
  if (diff < IDLE_THRESHOLD) return C.yellow + "\u25D0" + C.reset;  // ◐
  return C.dim + "\u25CB" + C.reset; // ○
}

function livenessLabel(session) {
  if (session.status === "done") return "done";
  const diff = Date.now() - new Date(session.last_activity_ts).getTime();
  if (diff < ACTIVE_THRESHOLD) return "activa";
  if (diff < IDLE_THRESHOLD) return "idle";
  return "stale";
}

// --- data collection ---

/**
 * Descubre sesiones en worktrees activos (evita duplicados por session id).
 */
function discoverWorktreeSessions(knownIds) {
  const extra = [];
  try {
    const output = execSync("git worktree list --porcelain", { cwd: REPO_ROOT, timeout: 5000, windowsHide: true })
      .toString();
    const lines = output.split(/\r?\n/);
    for (const line of lines) {
      if (!line.startsWith("worktree ")) continue;
      const wtPath = line.substring(9).trim();
      // Saltar el repo principal (ya lo leímos)
      if (path.resolve(wtPath) === path.resolve(REPO_ROOT)) continue;
      const wtSessions = path.join(wtPath, ".claude", "sessions");
      if (!fs.existsSync(wtSessions)) continue;
      for (const file of fs.readdirSync(wtSessions)) {
        if (!file.endsWith(".json")) continue;
        const sid = file.replace(".json", "");
        if (knownIds.has(sid)) continue; // evitar duplicados
        try {
          const data = JSON.parse(fs.readFileSync(path.join(wtSessions, file), "utf8"));
          extra.push(data);
          knownIds.add(sid);
        } catch(e) { /* skip corrupt */ }
      }
    }
  } catch(e) { /* git worktree no disponible — ignorar */ }
  return extra;
}

function loadSessions() {
  const sessions = [];
  const knownIds = new Set();
  const livePids = getLiveClaudePids();

  // Función interna para filtrar una sesión
  function shouldInclude(data) {
    if (data.type === "sub") return false;
    const age = Date.now() - new Date(data.last_activity_ts).getTime();
    if (data.status === "done") {
      if (age > DONE_DISPLAY_HOURS * 3600 * 1000) return false;
    }
    // Auto-expirar sesiones "active" sin actividad por más de STALE_EXPIRY_HOURS
    if (data.status === "active" && age > STALE_EXPIRY_HOURS * 3600 * 1000) return false;
    // Cruce PID: si la sesión tiene PID y podemos verificar, descartar zombies
    if (data.pid && livePids !== null && data.status === "active") {
      if (!livePids.has(data.pid)) return false;
    }
    return true;
  }

  try {
    if (fs.existsSync(SESSIONS_DIR)) {
      for (const file of fs.readdirSync(SESSIONS_DIR)) {
        if (!file.endsWith(".json")) continue;
        try {
          const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), "utf8"));
          if (!shouldInclude(data)) continue;
          sessions.push(data);
          knownIds.add(data.id || file.replace(".json", ""));
        } catch(e) { /* skip corrupt */ }
      }
    }
  } catch(e) {}

  // Escanear worktrees para sesiones adicionales
  const wtSessions = discoverWorktreeSessions(knownIds);
  for (const data of wtSessions) {
    if (shouldInclude(data)) sessions.push(data);
  }

  // Ordenar por last_activity_ts desc
  sessions.sort((a, b) => new Date(b.last_activity_ts) - new Date(a.last_activity_ts));
  return sessions;
}

function loadRecentActivity() {
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    const content = fs.readFileSync(LOG_FILE, "utf8").trim();
    if (!content) return [];
    const lines = content.split("\n");
    const recent = lines.slice(-RECENT_ACTIVITY_COUNT).reverse();
    return recent.map(line => {
      try { return JSON.parse(line); } catch(e) { return null; }
    }).filter(Boolean);
  } catch(e) { return []; }
}

function getGitInfo() {
  try {
    const branch = execSync("git branch --show-current", { cwd: REPO_ROOT, timeout: 3000, windowsHide: true })
      .toString().trim();
    const commit = execSync("git log --oneline -1", { cwd: REPO_ROOT, timeout: 3000, windowsHide: true })
      .toString().trim();
    return { branch, commit };
  } catch(e) { return { branch: "???", commit: "???" }; }
}

// Cache de CPU snapshots para detectar zombies
let _prevCpuSnap = {};

function getClaudeAgentCount() {
  try {
    const output = execSync(
      'wmic process where "Name=\'node.exe\'" get ProcessId,CommandLine,UserModeTime /format:list',
      { cwd: REPO_ROOT, timeout: 10000, windowsHide: true }
    ).toString();

    const records = output.split(/\r?\n\r?\n/).filter(r => r.trim());
    let agents = 0, zombies = 0;
    const newSnap = {};

    for (const record of records) {
      const fields = {};
      for (const line of record.split(/\r?\n/)) {
        const eq = line.indexOf("=");
        if (eq === -1) continue;
        fields[line.substring(0, eq).trim()] = line.substring(eq + 1).trim();
      }
      if (!fields.CommandLine || !fields.CommandLine.match(/claude-code[/\\]cli\.js/)) continue;
      if (!/bypassPermissions/.test(fields.CommandLine)) continue;

      const pid = parseInt(fields.ProcessId, 10);
      const cpu = parseInt(fields.UserModeTime, 10) || 0;
      newSnap[pid] = cpu;
      agents++;
      if (_prevCpuSnap[pid] !== undefined && _prevCpuSnap[pid] === cpu) zombies++;
    }
    _prevCpuSnap = newSnap;
    return { agents, zombies };
  } catch(e) { return { agents: 0, zombies: 0 }; }
}

// Cache de PIDs vivos de Claude Code (refresco cada 10s)
let _livePidsCache = null;
let _livePidsCacheTs = 0;
const LIVE_PIDS_CACHE_MS = 10000;

function getLiveClaudePids() {
  const now = Date.now();
  if (_livePidsCache !== null && (now - _livePidsCacheTs) < LIVE_PIDS_CACHE_MS) return _livePidsCache;
  try {
    const output = execSync(
      'wmic process where "Name=\'node.exe\'" get ProcessId,CommandLine /format:list',
      { cwd: REPO_ROOT, timeout: 10000, windowsHide: true }
    ).toString();
    const records = output.split(/\r?\n\r?\n/).filter(r => r.trim());
    const pids = new Set();
    for (const record of records) {
      const fields = {};
      for (const line of record.split(/\r?\n/)) {
        const eq = line.indexOf("=");
        if (eq === -1) continue;
        fields[line.substring(0, eq).trim()] = line.substring(eq + 1).trim();
      }
      if (!fields.CommandLine || !fields.CommandLine.match(/claude/i)) continue;
      const pid = parseInt(fields.ProcessId, 10);
      if (!isNaN(pid)) pids.add(pid);
    }
    _livePidsCache = pids;
    _livePidsCacheTs = now;
    return pids;
  } catch(e) {
    _livePidsCache = null;
    _livePidsCacheTs = now;
    return null; // degradación elegante — sin filtro PID
  }
}

function getCIStatus() {
  try {
    // Usar bash explicitamente para compatibilidad Windows (Git Bash / MSYS2)
    const bashPath = process.env.SHELL || "C:/Program Files/Git/bin/bash.exe";
    const cmd = 'export PATH="/c/Workspaces/gh-cli/bin:$PATH" && ' +
      'export GH_TOKEN=$(printf \'protocol=https\\nhost=github.com\\n\' | git credential fill 2>/dev/null | sed -n \'s/^password=//p\') && ' +
      'gh run list --limit 1 --json status,conclusion,headBranch --jq \'.[0] | "\\(.status) \\(.conclusion // "-") \\(.headBranch)"\'';
    const result = execSync(cmd, { cwd: REPO_ROOT, timeout: 15000, shell: bashPath, windowsHide: true })
      .toString().trim();
    const parts = result.split(" ");
    return { status: parts[0] || "?", conclusion: parts[1] || "-", branch: parts.slice(2).join(" ") || "?" };
  } catch(e) { return { status: "?", conclusion: "-", branch: "?" }; }
}

function ciIcon(ci) {
  if (ci.status === "completed" && ci.conclusion === "success") return C.green + "\u2705" + C.reset;
  if (ci.status === "completed" && ci.conclusion === "failure") return C.red + "\u274C" + C.reset;
  if (ci.status === "in_progress") return C.yellow + "\u23F3" + C.reset;
  if (ci.status === "queued") return C.blue + "\uD83D\uDD04" + C.reset;
  return C.dim + "\u2014" + C.reset;
}

// --- Task section helpers ---

function progressBarAscii(percent, width) {
  width = width || 8;
  const filled = Math.round((percent / 100) * width);
  return "\u2588".repeat(filled) + "\u2591".repeat(width - filled);
}

function taskStatusIcon(status) {
  if (status === "completed") return "\u2611";  // ☑
  if (status === "in_progress") return "\u2610\u25BA"; // ☐►
  return "\u2610"; // ☐
}

function stepIcon(step, completedSteps, currentStep, allSteps) {
  if (completedSteps && completedSteps.includes(step)) return "\u2713"; // ✓
  const idx = allSteps ? allSteps.indexOf(step) : -1;
  if (currentStep != null && idx === currentStep) return "\u25BA"; // ►
  return "\u25CB"; // ○
}

// --- Progress & ETA helpers ---

/**
 * Calcula progreso de un agente desde sus current_tasks[].
 * Tareas completadas = 1.0, in_progress con sub-steps = fraccion proporcional.
 * Retorna { done, total, percent }
 */
function calcAgentProgress(session) {
  if (!session.current_tasks || session.current_tasks.length === 0) return { done: 0, total: 0, percent: 0 };
  let done = 0;
  const total = session.current_tasks.length;
  for (const t of session.current_tasks) {
    if (t.status === "completed") { done += 1; continue; }
    if (t.status === "in_progress") {
      if (t.progress) { done += t.progress / 100; continue; }
      if (Array.isArray(t.steps) && t.steps.length > 0) {
        const completedSteps = (t.completed_steps || []).length;
        done += completedSteps / t.steps.length;
        continue;
      }
      done += 0.1; // progreso minimo para in_progress sin detalles
    }
  }
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  return { done: Math.round(done * 10) / 10, total, percent };
}

/**
 * Estima tiempo restante: elapsed * (100 - progress) / progress.
 * Solo calcula si progress >= 10%. Retorna string "~15m" o null.
 */
function calcAgentETA(session, progressPercent) {
  if (!progressPercent || progressPercent < 10) return null;
  if (progressPercent >= 100) return "done";
  if (!session.started_ts) return null;
  const elapsed = Date.now() - new Date(session.started_ts).getTime();
  if (elapsed <= 0) return null;
  const remaining = elapsed * (100 - progressPercent) / progressPercent;
  if (remaining > 24 * 3600 * 1000) return ">24h";
  const mins = Math.round(remaining / 60000);
  if (mins < 60) return "~" + mins + "m";
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return "~" + hours + "h" + (remMins > 0 ? remMins + "m" : "");
}

/**
 * Tiempo transcurrido desde started_ts hasta ahora.
 */
function formatElapsed(session) {
  if (!session.started_ts) return "---";
  const diff = Date.now() - new Date(session.started_ts).getTime();
  if (diff < 0) return "0s";
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return secs + "s";
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return mins + "m" + (remSecs > 0 ? remSecs + "s" : "");
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return hours + "h" + (remMins > 0 ? remMins + "m" : "");
}

/**
 * Progreso ponderado global de todos los agentes (excluyendo done).
 */
function calcGlobalProgress(sessions) {
  let totalTasks = 0, weightedDone = 0;
  for (const s of sessions) {
    if (s.status === "done") continue;
    const prog = calcAgentProgress(s);
    totalTasks += prog.total;
    weightedDone += prog.done;
  }
  return totalTasks > 0 ? Math.round((weightedDone / totalTasks) * 100) : 0;
}

/**
 * Extrae y formatea las tareas de todas las sesiones activas.
 * Retorna { sections: [{ agent, duration, tasks: [{ id, subject, status, percent, steps? }] }], globalDone, globalTotal }
 */
function formatTasksSection(sessions) {
  const sections = [];
  let globalDone = 0, globalTotal = 0;

  for (const s of sessions) {
    if (s.status === "done" || !s.current_tasks || s.current_tasks.length === 0) continue;

    const agent = agentDisplayName(s);
    const duration = formatDuration(s.started_ts, s.last_activity_ts);
    const tasks = [];

    for (const t of s.current_tasks) {
      globalTotal++;
      if (t.status === "completed") globalDone++;

      const percent = t.status === "completed" ? 100 : (t.progress || 0);
      const task = {
        id: t.id,
        subject: t.subject || "tarea",
        status: t.status || "pending",
        percent: percent,
      };

      if (Array.isArray(t.steps) && t.steps.length > 0) {
        task.steps = t.steps;
        task.completedSteps = t.completed_steps || [];
        task.currentStep = t.current_step || 0;
      }

      tasks.push(task);
    }

    sections.push({ agent, duration, tasks });
  }

  return { sections, globalDone, globalTotal };
}

/**
 * Genera el texto de tareas para el reporte Telegram (texto plano).
 */
function buildTasksText(sessions) {
  const { sections, globalDone, globalTotal } = formatTasksSection(sessions);
  if (sections.length === 0) return "";

  let msg = "\n\uD83D\uDCCB Tareas:\n";

  for (const sec of sections) {
    msg += "\uD83E\uDD16 " + sec.agent + " (" + sec.duration + ")\n";

    for (const t of sec.tasks) {
      const icon = taskStatusIcon(t.status);
      const bar = progressBarAscii(t.percent);
      msg += icon + " #" + t.id + " " + truncate(t.subject, 30) + " " + bar + " " + t.percent + "%\n";

      // Sub-pasos expandidos solo para in_progress
      if (t.steps && t.status === "in_progress") {
        for (const step of t.steps) {
          const si = stepIcon(step, t.completedSteps, t.currentStep, t.steps);
          msg += "  " + si + " " + truncate(step, 40) + "\n";
        }
      }
    }
  }

  const globalPercent = globalTotal > 0 ? Math.round((globalDone / globalTotal) * 100) : 0;
  msg += "\uD83D\uDCCA Global: " + globalDone + "/" + globalTotal + " \u00B7 " + globalPercent + "%\n";

  return msg;
}

// --- Telegram reporter ---

function sendTelegram(text, attempt) {
  attempt = attempt || 1;
  return new Promise((resolve, reject) => {
    const postData = querystring.stringify({ chat_id: TG_CHAT_ID, text: text });
    const req = https.request({
      hostname: "api.telegram.org",
      path: "/bot" + TG_BOT_TOKEN + "/sendMessage",
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 10000
    }, (res) => {
      let d = "";
      res.on("data", (c) => d += c);
      res.on("end", () => {
        try {
          const r = JSON.parse(d);
          if (r.ok) resolve(r);
          else reject(new Error(d));
        } catch(e) { reject(e); }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", (e) => reject(e));
    req.write(postData);
    req.end();
  });
}

function buildReportMessage() {
  const sessions = loadSessions();
  const recentActivity = loadRecentActivity();

  if (sessions.length === 0) return null;

  // No enviar si todas las sesiones son "done"
  const hasActive = sessions.some(s => livenessLabel(s) !== "done");
  if (!hasActive) return null;

  const now = new Date();
  const timeStr = now.toTimeString().substring(0, 5);
  const total = sessions.length;
  const activos = sessions.filter(s => livenessLabel(s) === "activa").length;
  const globalProg = calcGlobalProgress(sessions);

  let msg = "\uD83D\uDCCA Sprint \u2014 " + timeStr + " | " + activos + "/" + total + " agentes | " + globalProg + "%\n\n";
  msg += "\uD83E\uDD16 Agentes:\n";

  for (const s of sessions) {
    const label = livenessLabel(s);
    const icon = label === "activa" ? "\u25CF" : label === "idle" ? "\u25D0" : label === "done" ? "\u2717" : "\u25CB";
    const agent = agentDisplayName(s);
    const prog = calcAgentProgress(s);
    const elapsed = formatElapsed(s);
    const eta = calcAgentETA(s, prog.percent);
    const action = lastActionLabel(s);
    const branch = s.branch ? truncate(s.branch, 30) : "???";

    // Linea 1: nombre + progress bar + elapsed + ETA + estado + acciones
    const bar = prog.total > 0 ? progressBarAscii(prog.percent, 8) + " " + prog.percent + "%" : "---";
    const etaStr = eta ? "  ETA " + eta : "";
    msg += icon + " " + truncate(agent, 22) + "  " + bar + "  " + elapsed + etaStr + "  " + label + "  " + (s.action_count || 0) + " accs\n";

    if (label !== "done") {
      // Linea 2: branch + last action
      msg += "  " + branch + "  " + action + "\n";
      // Linea 3: current task
      if (s.current_task) {
        msg += "  > " + truncate(s.current_task, 50) + "\n";
      }
    }
  }

  // Actividad reciente (top 3)
  if (recentActivity.length > 0) {
    msg += "\n\uD83D\uDCDD Actividad:\n";
    const top3 = recentActivity.slice(0, 3);
    for (const entry of top3) {
      const time = (entry.ts || "").substring(11, 16);
      let t = entry.target || "--";
      if (t.includes("/") || t.includes("\\")) {
        const parts = t.replace(/\\/g, "/").split("/");
        t = parts[parts.length - 1];
      }
      msg += "  " + time + " " + (entry.tool || "?") + ": " + truncate(t, 25) + "\n";
    }
  }

  // Tareas con sub-pasos
  msg += buildTasksText(sessions);

  // CI
  try {
    const ci = getCIStatus();
    let ciLabel;
    if (ci.status === "completed" && ci.conclusion === "success") ciLabel = "\u2705";
    else if (ci.status === "completed" && ci.conclusion === "failure") ciLabel = "\u274C";
    else if (ci.status === "in_progress") ciLabel = "\u23F3";
    else ciLabel = "\u2014";
    msg += "\n\u2699\uFE0F CI: " + ciLabel + " " + (ci.branch || "?");
  } catch(e) {}

  return msg;
}

// --- Imagen PNG para Telegram ---

function buildReportImage(sessions, recentActivity, ci) {
  if (!createCanvas) return null;

  const W = 800;
  // Calcular filas por agente: 28px base + 18px branch (siempre) + 16px current_task (si tiene y no done)
  let agentPanelH = 0;
  for (const s of sessions) {
    const label = livenessLabel(s);
    agentPanelH += 28; // linea principal
    agentPanelH += 18; // linea branch + action (siempre)
    if (label !== "done" && s.current_task) agentPanelH += 16; // linea current task
  }
  if (sessions.length === 0) agentPanelH = 28;

  // Pre-calcular tareas para estimar altura
  const tasksData = formatTasksSection(sessions);
  let taskPanelRows = 0;
  if (tasksData.sections.length > 0) {
    taskPanelRows += 1; // titulo "TAREAS"
    for (const sec of tasksData.sections) {
      taskPanelRows += 1; // nombre agente
      for (const t of sec.tasks) {
        taskPanelRows += 1; // linea de tarea
        if (t.steps && t.status === "in_progress") taskPanelRows += t.steps.length;
      }
      taskPanelRows += 1; // global
    }
  }
  const H = Math.max(420, 110 + agentPanelH + (taskPanelRows * 20) + 180);

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = IMG.BG;
  ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = "top";

  let y = 0;

  // === HEADER ===
  ctx.fillStyle = IMG.PANEL_BG;
  ctx.fillRect(0, y, W, 50);
  ctx.fillStyle = IMG.ACCENT;
  ctx.fillRect(0, y + 48, W, 2);

  ctx.font = "bold 18px monospace";
  ctx.fillStyle = IMG.HEADER;
  ctx.fillText("Sprint Monitor", 16, y + 14);

  const timeStr = new Date().toTimeString().substring(0, 8);
  const activos = sessions.filter(s => livenessLabel(s) === "activa").length;
  const globalProg = calcGlobalProgress(sessions);
  ctx.font = "14px monospace";
  ctx.fillStyle = IMG.DIM;
  ctx.fillText(timeStr + "  |  " + activos + "/" + sessions.length + " agentes  |  " + globalProg + "%", W - 420, y + 18);
  y += 56;

  // === PANEL AGENTES ===
  ctx.font = "bold 14px monospace";
  ctx.fillStyle = IMG.ACCENT;
  ctx.fillText("AGENTES", 16, y);
  y += 22;

  if (sessions.length === 0) {
    ctx.font = "14px monospace";
    ctx.fillStyle = IMG.DIM;
    ctx.fillText("Sin sesiones registradas", 30, y);
    y += 28;
  } else {
    for (const s of sessions) {
      const label = livenessLabel(s);
      const statusColor = label === "activa" ? IMG.GREEN : label === "idle" ? IMG.YELLOW : IMG.GRAY;
      const agent = agentDisplayName(s);
      const elapsed = formatElapsed(s);
      const prog = calcAgentProgress(s);
      const eta = calcAgentETA(s, prog.percent);
      const actions = String(s.action_count || 0);

      // Barra lateral de color (rama siempre visible + current_task si no done)
      const sideBarH = 28 + 18 + (label !== "done" && s.current_task ? 16 : 0);
      ctx.fillStyle = statusColor;
      ctx.fillRect(16, y, 4, sideBarH);

      // Punto de estado
      ctx.beginPath();
      ctx.arc(32, y + 11, 5, 0, Math.PI * 2);
      ctx.fillStyle = statusColor;
      ctx.fill();

      // Nombre del agente
      ctx.font = "bold 14px monospace";
      ctx.fillStyle = IMG.HEADER;
      ctx.fillText(truncate(agent, 18), 44, y + 3);

      // Progress bar visual (80px)
      if (prog.total > 0) {
        const barX = 210, barW = 80, barH = 12;
        ctx.fillStyle = IMG.PANEL_BG;
        ctx.fillRect(barX, y + 5, barW, barH);
        ctx.fillStyle = prog.percent >= 100 ? IMG.GREEN : statusColor;
        ctx.fillRect(barX, y + 5, Math.round((prog.percent / 100) * barW), barH);
        ctx.strokeStyle = statusColor;
        ctx.lineWidth = 0.5;
        ctx.strokeRect(barX, y + 5, barW, barH);

        ctx.font = "12px monospace";
        ctx.fillStyle = statusColor;
        ctx.fillText(prog.percent + "%", barX + barW + 4, y + 5);
      } else {
        ctx.font = "12px monospace";
        ctx.fillStyle = IMG.DIM;
        ctx.fillText("---", 210, y + 5);
      }

      // Elapsed
      ctx.font = "14px monospace";
      ctx.fillStyle = IMG.TEXT;
      ctx.fillText(elapsed, 360, y + 3);

      // ETA (mostrar valor calculado o razon de por que no hay)
      if (eta === "done") {
        ctx.fillStyle = IMG.GREEN;
        ctx.fillText("done", 440, y + 3);
      } else if (eta) {
        ctx.fillStyle = IMG.YELLOW;
        ctx.fillText("ETA " + eta, 440, y + 3);
      } else if (prog.percent > 0 && prog.percent < 10) {
        ctx.fillStyle = IMG.DIM;
        ctx.fillText("ETA <10%", 440, y + 3);
      } else {
        ctx.fillStyle = IMG.DIM;
        ctx.fillText("---", 440, y + 3);
      }

      // Estado texto
      ctx.fillStyle = statusColor;
      ctx.fillText(label, 560, y + 3);

      // Acciones count
      ctx.fillStyle = IMG.CYAN;
      ctx.fillText(actions + " accs", 650, y + 3);

      y += 28;

      // Linea 2: branch + last action (siempre visible)
      const branch = s.branch ? truncate(s.branch, 28) : "main";
      const action = lastActionLabel(s);
      ctx.font = "12px monospace";
      ctx.fillStyle = IMG.CYAN;
      ctx.fillText("\u2387 " + branch, 44, y);
      ctx.fillStyle = IMG.DIM;
      ctx.fillText(action, 340, y);
      y += 18;

      // Linea 3: tarea activa (solo si no done)
      if (label !== "done" && s.current_task) {
        ctx.font = "12px monospace";
        ctx.fillStyle = IMG.DIM;
        ctx.fillText("> " + truncate(s.current_task, 70), 44, y);
        y += 16;
      }
    }
  }
  y += 8;

  // === PANEL TAREAS ===
  if (tasksData.sections.length > 0) {
    ctx.fillStyle = IMG.ACCENT;
    ctx.fillRect(0, y, W, 1);
    y += 6;

    ctx.font = "bold 14px monospace";
    ctx.fillStyle = IMG.ACCENT;
    ctx.fillText("TAREAS", 16, y);
    y += 22;

    const BAR_W = 120, BAR_H = 12;

    for (const sec of tasksData.sections) {
      // Nombre del agente
      ctx.font = "bold 13px monospace";
      ctx.fillStyle = IMG.CYAN;
      ctx.fillText(sec.agent + " (" + sec.duration + ")", 30, y);
      y += 20;

      for (const t of sec.tasks) {
        const statusColor = t.status === "completed" ? IMG.GREEN : t.status === "in_progress" ? IMG.YELLOW : IMG.DIM;

        // Icono de estado
        ctx.font = "14px monospace";
        ctx.fillStyle = statusColor;
        const icon = t.status === "completed" ? "\u2611" : t.status === "in_progress" ? "\u25BA" : "\u2610";
        ctx.fillText(icon, 40, y);

        // ID + Subject
        ctx.font = "13px monospace";
        ctx.fillStyle = IMG.TEXT;
        ctx.fillText("#" + t.id + " " + truncate(t.subject, 35), 60, y);

        // Barra de progreso visual
        const barX = 440;
        ctx.fillStyle = IMG.PANEL_BG;
        ctx.fillRect(barX, y + 1, BAR_W, BAR_H);
        ctx.fillStyle = statusColor;
        ctx.fillRect(barX, y + 1, Math.round((t.percent / 100) * BAR_W), BAR_H);
        ctx.strokeStyle = statusColor;
        ctx.lineWidth = 0.5;
        ctx.strokeRect(barX, y + 1, BAR_W, BAR_H);

        // Porcentaje
        ctx.font = "12px monospace";
        ctx.fillStyle = statusColor;
        ctx.fillText(t.percent + "%", barX + BAR_W + 8, y + 1);

        y += 20;

        // Sub-pasos (solo in_progress)
        if (t.steps && t.status === "in_progress") {
          for (const step of t.steps) {
            const si = stepIcon(step, t.completedSteps, t.currentStep, t.steps);
            const siColor = si === "\u2713" ? IMG.GREEN : si === "\u25BA" ? IMG.YELLOW : IMG.DIM;

            ctx.font = "12px monospace";
            ctx.fillStyle = siColor;
            ctx.fillText(si, 60, y);

            ctx.fillStyle = IMG.DIM;
            ctx.fillText(truncate(step, 55), 78, y);
            y += 18;
          }
        }
      }
    }

    // Linea de progreso global
    const globalPercent = tasksData.globalTotal > 0 ? Math.round((tasksData.globalDone / tasksData.globalTotal) * 100) : 0;
    ctx.font = "bold 13px monospace";
    ctx.fillStyle = IMG.ACCENT;
    ctx.fillText("Global: " + tasksData.globalDone + "/" + tasksData.globalTotal + " \u00B7 " + globalPercent + "%", 30, y);
    y += 22;
  }

  // === PANEL CI ===
  ctx.fillStyle = IMG.PANEL_BG;
  ctx.fillRect(0, y, W, 44);
  ctx.fillStyle = IMG.ACCENT;
  ctx.fillRect(0, y, W, 1);
  y += 8;

  ctx.font = "bold 14px monospace";
  ctx.fillStyle = IMG.ACCENT;
  ctx.fillText("CI", 16, y);

  let ciStatusText, ciColor;
  if (ci.status === "completed" && ci.conclusion === "success") { ciStatusText = "OK success"; ciColor = IMG.GREEN; }
  else if (ci.status === "completed" && ci.conclusion === "failure") { ciStatusText = "FAIL"; ciColor = IMG.RED; }
  else if (ci.status === "in_progress") { ciStatusText = "in_progress"; ciColor = IMG.YELLOW; }
  else { ciStatusText = ci.status || "?"; ciColor = IMG.DIM; }

  ctx.font = "14px monospace";
  ctx.fillStyle = ciColor;
  ctx.fillText(ciStatusText, 50, y);
  ctx.fillStyle = IMG.DIM;
  ctx.fillText("(" + truncate(ci.branch || "?", 30) + ")", 240, y);
  y += 36;

  // === PANEL METRICAS ===
  ctx.fillStyle = IMG.ACCENT;
  ctx.fillRect(0, y, W, 1);
  y += 8;

  ctx.font = "bold 14px monospace";
  ctx.fillStyle = IMG.ACCENT;
  ctx.fillText("METRICAS", 16, y);
  y += 22;

  const imgActivos = sessions.filter(s => livenessLabel(s) === "activa").length;
  const idle = sessions.filter(s => livenessLabel(s) === "idle").length;
  const total = sessions.length;

  const metrics = [
    { label: "Activos", value: String(imgActivos), color: IMG.GREEN },
    { label: "Idle", value: String(idle), color: IMG.YELLOW },
    { label: "Total", value: String(total), color: IMG.HEADER },
  ];

  let mx = 30;
  for (const m of metrics) {
    ctx.fillStyle = IMG.PANEL_BG;
    ctx.fillRect(mx, y, 100, 36);
    ctx.strokeStyle = m.color;
    ctx.lineWidth = 1;
    ctx.strokeRect(mx, y, 100, 36);

    ctx.font = "bold 18px monospace";
    ctx.fillStyle = m.color;
    ctx.fillText(m.value, mx + 12, y + 4);

    ctx.font = "12px monospace";
    ctx.fillStyle = IMG.DIM;
    ctx.fillText(m.label, mx + 40, y + 10);

    mx += 130;
  }

  // Recortar canvas al alto real usado
  const finalH = y + 50;
  const finalCanvas = createCanvas(W, finalH);
  const fctx = finalCanvas.getContext("2d");
  fctx.drawImage(canvas, 0, 0);

  return finalCanvas.toBuffer("image/png");
}

function sendTelegramPhoto(imageBuffer, caption) {
  return new Promise((resolve, reject) => {
    const boundary = "----DashBoundary" + Date.now().toString(36);
    const CRLF = "\r\n";

    // Construir multipart/form-data manualmente con https nativo
    let textParts = "";
    textParts += "--" + boundary + CRLF;
    textParts += "Content-Disposition: form-data; name=\"chat_id\"" + CRLF + CRLF;
    textParts += TG_CHAT_ID + CRLF;

    if (caption) {
      textParts += "--" + boundary + CRLF;
      textParts += "Content-Disposition: form-data; name=\"caption\"" + CRLF + CRLF;
      textParts += caption + CRLF;
    }

    const preFile = Buffer.from(
      textParts +
      "--" + boundary + CRLF +
      "Content-Disposition: form-data; name=\"photo\"; filename=\"dashboard.png\"" + CRLF +
      "Content-Type: image/png" + CRLF + CRLF
    );
    const postFile = Buffer.from(CRLF + "--" + boundary + "--" + CRLF);
    const fullBody = Buffer.concat([preFile, imageBuffer, postFile]);

    const req = https.request({
      hostname: "api.telegram.org",
      path: "/bot" + TG_BOT_TOKEN + "/sendPhoto",
      method: "POST",
      headers: {
        "Content-Type": "multipart/form-data; boundary=" + boundary,
        "Content-Length": fullBody.length,
      },
      timeout: 15000
    }, (res) => {
      let d = "";
      res.on("data", (c) => d += c);
      res.on("end", () => {
        try {
          const r = JSON.parse(d);
          if (r.ok) resolve(r);
          else reject(new Error(d));
        } catch(e) { reject(e); }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", (e) => reject(e));
    req.write(fullBody);
    req.end();
  });
}

async function sendReport() {
  try {
    const sessions = loadSessions();
    if (sessions.length === 0) return;
    const hasActive = sessions.some(s => livenessLabel(s) !== "done");
    if (!hasActive) return;

    const recentActivity = loadRecentActivity();
    const ci = getCIStatus();
    const globalProg = calcGlobalProgress(sessions);

    // Intentar enviar imagen PNG primero
    let imageSent = false;
    if (createCanvas) {
      try {
        const imgBuf = buildReportImage(sessions, recentActivity, ci);
        if (imgBuf) {
          const activos = sessions.filter(s => livenessLabel(s) === "activa").length;
          const caption = "\uD83D\uDCCA Sprint " + new Date().toTimeString().substring(0, 5) +
            " | " + activos + "/" + sessions.length + " agentes | " + globalProg + "%";

          for (let attempt = 1; attempt <= TG_MAX_RETRIES; attempt++) {
            try {
              await sendTelegramPhoto(imgBuf, caption);
              imageSent = true;
              lastReportTs = new Date().toISOString();
              break;
            } catch(e) {
              debugLog("sendTelegramPhoto intento " + attempt + " fallo: " + e.message);
              if (attempt < TG_MAX_RETRIES) {
                await new Promise(r => setTimeout(r, TG_RETRY_DELAY_MS));
              }
            }
          }
        }
      } catch(e) {
        debugLog("buildReportImage fallo: " + e.message);
      }
    }

    // Fallback a texto si la imagen fallo o canvas no disponible
    if (!imageSent) {
      const msg = buildReportMessage();
      if (!msg) return;
      for (let attempt = 1; attempt <= TG_MAX_RETRIES; attempt++) {
        try {
          await sendTelegram(msg, attempt);
          lastReportTs = new Date().toISOString();
          return;
        } catch(e) {
          if (attempt < TG_MAX_RETRIES) {
            await new Promise(r => setTimeout(r, TG_RETRY_DELAY_MS));
          }
        }
      }
    }
  } catch(e) { /* no romper el dashboard por error de reporter */ }
}

function startReporter() {
  if (reportIntervalMin <= 0) return;
  // Enviar primer reporte al iniciar
  sendReport();
  reportTimer = setInterval(sendReport, reportIntervalMin * 60 * 1000);
}

// --- rendering ---

function boxLine(content, width) {
  const visible = content.replace(/\x1B\[[0-9;]*m/g, "");
  const pad = Math.max(0, width - 2 - visible.length);
  return "\u2502 " + content + " ".repeat(pad) + "\u2502";
}

function boxTop(title, width) {
  const inner = width - 2;
  const t = "\u2500 " + title + " ";
  return "\u250C" + t + "\u2500".repeat(Math.max(0, inner - t.length)) + "\u2510";
}

function boxMid(title, width) {
  const inner = width - 2;
  const t = "\u2500 " + title + " ";
  return "\u251C" + t + "\u2500".repeat(Math.max(0, inner - t.length)) + "\u2524";
}

function boxBot(width) {
  return "\u2514" + "\u2500".repeat(width - 2) + "\u2518";
}

function render() {
  const cols = Math.max(process.stdout.columns || 60, 56);
  const W = Math.min(cols, 80);
  const now = new Date();
  const timeStr = now.toTimeString().substring(0, 8);

  const sessions = loadSessions();
  const recentActivity = loadRecentActivity();

  const lines = [];

  // Header
  const reportTag = reportIntervalMin > 0
    ? C.green + " \u2709 " + reportIntervalMin + "m" + C.reset
    : "";
  lines.push(boxTop(C.bold + C.cyan + "Monitor" + C.reset + C.dim + "  " + timeStr + C.reset + reportTag, W));

  // Panel SESIONES
  if (sessions.length === 0) {
    lines.push(boxLine(C.dim + "Sin sesiones registradas" + C.reset, W));
  } else {
    for (const s of sessions) {
      const icon = livenessIcon(s);
      const agent = agentDisplayName(s);
      const elapsed = formatElapsed(s);
      const prog = calcAgentProgress(s);
      const eta = calcAgentETA(s, prog.percent);

      // Row 1: icon Agent  [████░░░░] XX%  elapsed  ETA  estado
      let row1 = icon + " " + C.bold + padEnd(truncate(agent, 20), 21) + C.reset;
      if (prog.total > 0) {
        const bar = progressBarAscii(prog.percent, 8);
        row1 += " [" + C.cyan + bar + C.reset + "] " + padEnd(prog.percent + "%", 5);
      } else {
        row1 += " " + padEnd("", 16);
      }
      row1 += padEnd(elapsed, 8);
      if (eta && eta !== "done") {
        row1 += C.yellow + "ETA " + padEnd(eta, 6) + C.reset;
      } else if (eta === "done") {
        row1 += C.green + padEnd("done", 10) + C.reset;
      } else {
        row1 += padEnd("", 10);
      }
      lines.push(boxLine(row1, W));

      // Row 2: branch + last_action + accs
      const branch = s.branch || "main";
      const action = lastActionLabel(s);
      const accs = String(s.action_count || 0);
      const row2 = C.dim + "  \u2387 " + C.reset +
        C.cyan + padEnd(truncate(branch, 30), 31) + C.reset +
        padEnd(action, 24) +
        C.dim + "Accs:" + accs + C.reset;
      lines.push(boxLine(row2, W));

      // Row 3: tarea activa (si existe)
      if (s.current_task && s.status !== "done") {
        const taskLine = C.dim + "  \u2514\u2500 \u2699 " + C.reset +
          C.cyan + truncate(s.current_task, W - 12) + C.reset;
        lines.push(boxLine(taskLine, W));
      }

      // Verbose: skills, sub_count, permission_mode
      if (verbose) {
        const skills = (s.skills_invoked || []).join(", ") || "\u2014";
        const detail = C.dim + "  skills: " + skills +
          "  sub: " + (s.sub_count || 0) +
          "  mode: " + (s.permission_mode || "?") + C.reset;
        lines.push(boxLine(truncate(detail, W - 4), W));
      }

      // Separador entre agentes (si no es el ultimo)
      if (s !== sessions[sessions.length - 1]) {
        lines.push(boxLine(C.dim + "\u2500".repeat(W - 4) + C.reset, W));
      }
    }
  }

  // Panel PROCESOS CLAUDE
  const procInfo = getClaudeAgentCount();
  if (procInfo.agents > 0) {
    lines.push(boxMid("PROCESOS", W));
    let procLine = C.green + "\u25CF " + procInfo.agents + " agente(s)" + C.reset;
    if (procInfo.zombies > 0) {
      procLine += "  " + C.red + "\u2620 " + procInfo.zombies + " zombie(s)" + C.reset;
    }
    lines.push(boxLine(procLine, W));
  }

  // Panel ACTIVIDAD RECIENTE
  lines.push(boxMid("ACTIVIDAD RECIENTE", W));
  if (recentActivity.length === 0) {
    lines.push(boxLine(C.dim + "Sin actividad registrada" + C.reset, W));
  } else {
    for (const entry of recentActivity) {
      const time = (entry.ts || "").substring(11, 19);
      const sid = entry.session || "\u2014";
      let t = entry.target || "--";
      if (t.includes("/") || t.includes("\\")) {
        const parts = t.replace(/\\/g, "/").split("/");
        t = parts[parts.length - 1];
      }
      const line = C.dim + time + C.reset + " " +
        C.cyan + padEnd(sid, 9) + C.reset +
        padEnd(entry.tool || "?", 8) +
        C.dim + truncate(t, W - 30) + C.reset;
      lines.push(boxLine(line, W));
    }
  }

  // Panel CI
  lines.push(boxMid("CI", W));
  let ciLine = C.dim + "CI: cargando..." + C.reset;
  try {
    const ci = getCIStatus();
    const icon = ciIcon(ci);
    ciLine = icon + " " + ci.status + (ci.conclusion !== "-" ? " " + ci.conclusion : "") +
      C.dim + " (" + truncate(ci.branch, 25) + ")" + C.reset;
  } catch(e) {}
  lines.push(boxLine(ciLine, W));

  // Footer
  lines.push(boxMid("", W));
  const reportStatus = reportIntervalMin > 0
    ? "  Report: " + reportIntervalMin + "m"
    : "";
  lines.push(boxLine(
    C.dim + "[q] Salir  [v] Verbose" + (verbose ? " ON" : "") +
    "  [r] Refresh  Auto: " + (REFRESH_MS / 1000) + "s" + reportStatus + C.reset, W
  ));
  lines.push(boxBot(W));

  // Render
  process.stdout.write("\x1B[H"); // cursor home
  for (const line of lines) {
    process.stdout.write("\x1B[2K" + line + "\n"); // clear line + write
  }
  // Clear remaining lines below
  process.stdout.write("\x1B[J");
}

// --- keyboard input ---

function setupKeyboard() {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (key) => {
      if (key === "q" || key === "\x03") { // q or Ctrl+C
        cleanup();
        process.exit(0);
      }
      if (key === "v") {
        verbose = !verbose;
        render();
      }
      if (key === "r") {
        render();
      }
    });
  }
}

// --- lifecycle ---

function cleanup() {
  process.stdout.write(SHOW_CURSOR);
  process.stdout.write("\x1B[2J\x1B[H"); // clear screen
  if (refreshTimer) clearInterval(refreshTimer);
  if (reportTimer) clearInterval(reportTimer);
}

function main() {
  // Modo headless: solo reporter Telegram, sin UI de terminal
  if (headless) {
    if (reportIntervalMin <= 0) {
      console.error("Error: --headless requiere --report N (N > 0)");
      process.exit(1);
    }
    // Escribir PID para control externo
    const pidFile = path.join(__dirname, "tmp", "reporter.pid");
    try { fs.mkdirSync(path.dirname(pidFile), { recursive: true }); } catch(e) {}
    fs.writeFileSync(pidFile, String(process.pid));
    process.on("exit", () => { try { fs.unlinkSync(pidFile); } catch(e) {} });

    debugLog("Reporter headless iniciado (PID " + process.pid + ", cada " + reportIntervalMin + " min)");
    console.log("Reporter headless: PID " + process.pid + ", reporte PNG cada " + reportIntervalMin + " min");

    process.on("SIGINT", () => process.exit(0));
    process.on("SIGTERM", () => process.exit(0));

    // Solo ejecutar el reporter
    startReporter();

    // Auto-stop si no hay sesiones activas por 30 minutos
    setInterval(() => {
      try {
        const sessions = loadSessions();
        const hasActive = sessions.some(s => livenessLabel(s) !== "done");
        if (!hasActive) {
          debugLog("Reporter headless: sin sesiones activas, deteniendo");
          process.exit(0);
        }
      } catch(e) {}
    }, 30 * 60 * 1000);
    return;
  }

  process.stdout.write("\x1B[2J"); // clear screen
  process.stdout.write(HIDE_CURSOR);

  process.on("exit", () => process.stdout.write(SHOW_CURSOR));
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });

  setupKeyboard();
  render();

  // Auto-refresh
  refreshTimer = setInterval(render, REFRESH_MS);

  // Telegram reporter
  startReporter();

  // Watch sessions dir for reactive refresh
  try {
    if (fs.existsSync(SESSIONS_DIR)) {
      fs.watch(SESSIONS_DIR, { persistent: false }, (event, filename) => {
        if (filename && filename.endsWith(".json")) {
          // Debounce: esperar 200ms para que el write termine
          setTimeout(render, 200);
        }
      });
    }
  } catch(e) { /* fs.watch not available — rely on setInterval */ }

  // Watch JSONL for activity changes
  try {
    if (fs.existsSync(LOG_FILE)) {
      fs.watch(LOG_FILE, { persistent: false }, () => {
        setTimeout(render, 200);
      });
    }
  } catch(e) { /* fs.watch not available */ }
}

main();

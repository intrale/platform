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
const DONE_DISPLAY_HOURS = 1;
const STALE_EXPIRY_HOURS = 2;          // sesiones "active" sin actividad → tratar como expiradas
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

function loadSessions() {
  const sessions = [];
  try {
    if (!fs.existsSync(SESSIONS_DIR)) return sessions;
    for (const file of fs.readdirSync(SESSIONS_DIR)) {
      if (!file.endsWith(".json")) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), "utf8"));
        // Solo parent, filtrar done expiradas y zombis stale
        if (data.type === "sub") continue;
        const age = Date.now() - new Date(data.last_activity_ts).getTime();
        if (data.status === "done") {
          if (age > DONE_DISPLAY_HOURS * 3600 * 1000) continue;
        }
        // Auto-expirar sesiones "active" sin actividad por más de STALE_EXPIRY_HOURS
        if (data.status === "active" && age > STALE_EXPIRY_HOURS * 3600 * 1000) continue;
        sessions.push(data);
      } catch(e) { /* skip corrupt */ }
    }
  } catch(e) {}
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
    const branch = execSync("git branch --show-current", { cwd: REPO_ROOT, timeout: 3000 })
      .toString().trim();
    const commit = execSync("git log --oneline -1", { cwd: REPO_ROOT, timeout: 3000 })
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

function getCIStatus() {
  try {
    // Usar bash explicitamente para compatibilidad Windows (Git Bash / MSYS2)
    const bashPath = process.env.SHELL || "C:/Program Files/Git/bin/bash.exe";
    const cmd = 'export PATH="/c/Workspaces/gh-cli/bin:$PATH" && ' +
      'export GH_TOKEN=$(printf \'protocol=https\\nhost=github.com\\n\' | git credential fill 2>/dev/null | sed -n \'s/^password=//p\') && ' +
      'gh run list --limit 1 --json status,conclusion,headBranch --jq \'.[0] | "\\(.status) \\(.conclusion // "-") \\(.headBranch)"\'';
    const result = execSync(cmd, { cwd: REPO_ROOT, timeout: 15000, shell: bashPath })
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

  let msg = "\uD83D\uDCCA Sprint \u2014 " + timeStr + "\n\n";
  msg += "\uD83E\uDD16 Agentes (" + activos + " activos / " + total + " total):\n";

  for (const s of sessions) {
    const label = livenessLabel(s);
    const icon = label === "activa" ? "\u25CF" : label === "idle" ? "\u25D0" : label === "done" ? "\u2717" : "\u25CB";
    const agent = agentDisplayName(s);
    const action = lastActionLabel(s);
    const age = formatAge(s.last_activity_ts);
    msg += icon + " " + truncate(agent, 28) + " \u2014 " + action + " (" + age + ")\n";
    if (s.current_task && label !== "done") {
      msg += "  \u2514 \u2699 " + truncate(s.current_task, 40) + "\n";
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

function buildReportImage(sessions, recentActivity, git, ci) {
  if (!createCanvas) return null;

  const W = 800;
  const agentRows = Math.max(sessions.length, 1);
  const taskRows = sessions.filter(s => s.current_task && s.status !== "done").length;
  // Pre-calcular tareas para estimar altura
  const tasksData = formatTasksSection(sessions);
  let taskPanelRows = 0;
  if (tasksData.sections.length > 0) {
    taskPanelRows += 1; // título "TAREAS"
    for (const sec of tasksData.sections) {
      taskPanelRows += 1; // nombre agente
      for (const t of sec.tasks) {
        taskPanelRows += 1; // línea de tarea
        if (t.steps && t.status === "in_progress") taskPanelRows += t.steps.length;
      }
      taskPanelRows += 1; // global
    }
  }
  const H = Math.max(420, 110 + (agentRows * 32) + (taskRows * 20) + (taskPanelRows * 20) + 180);

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
  ctx.font = "14px monospace";
  ctx.fillStyle = IMG.DIM;
  ctx.fillText(timeStr + "  |  " + (git.branch || "???"), W - 380, y + 18);
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
      const action = lastActionLabel(s);
      const duration = formatDuration(s.started_ts, s.last_activity_ts);
      const actions = String(s.action_count || 0);

      // Barra lateral de color
      ctx.fillStyle = statusColor;
      ctx.fillRect(16, y, 4, 22);

      // Punto de estado
      ctx.beginPath();
      ctx.arc(32, y + 11, 5, 0, Math.PI * 2);
      ctx.fillStyle = statusColor;
      ctx.fill();

      // Nombre del agente
      ctx.font = "bold 14px monospace";
      ctx.fillStyle = IMG.HEADER;
      ctx.fillText(truncate(agent, 20), 44, y + 3);

      // Acción
      ctx.font = "14px monospace";
      ctx.fillStyle = IMG.TEXT;
      ctx.fillText(action, 240, y + 3);

      // Duración
      ctx.fillStyle = IMG.DIM;
      ctx.fillText(duration, 490, y + 3);

      // Acciones count
      ctx.fillStyle = IMG.CYAN;
      ctx.fillText(actions + " accs", 560, y + 3);

      // Estado texto
      ctx.fillStyle = statusColor;
      ctx.fillText(label, 650, y + 3);

      y += 28;

      // Tarea activa
      if (s.current_task && s.status !== "done") {
        ctx.font = "12px monospace";
        ctx.fillStyle = IMG.DIM;
        ctx.fillText("  > " + truncate(s.current_task, 65), 44, y);
        y += 20;
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

    // Línea de progreso global
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

  // === PANEL MÉTRICAS ===
  ctx.fillStyle = IMG.ACCENT;
  ctx.fillRect(0, y, W, 1);
  y += 8;

  ctx.font = "bold 14px monospace";
  ctx.fillStyle = IMG.ACCENT;
  ctx.fillText("METRICAS", 16, y);
  y += 22;

  const activos = sessions.filter(s => livenessLabel(s) === "activa").length;
  const idle = sessions.filter(s => livenessLabel(s) === "idle").length;
  const total = sessions.length;

  const metrics = [
    { label: "Activos", value: String(activos), color: IMG.GREEN },
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
    const git = getGitInfo();
    const ci = getCIStatus();

    // Intentar enviar imagen PNG primero
    let imageSent = false;
    if (createCanvas) {
      try {
        const imgBuf = buildReportImage(sessions, recentActivity, git, ci);
        if (imgBuf) {
          const activos = sessions.filter(s => livenessLabel(s) === "activa").length;
          const caption = "\uD83D\uDCCA Sprint " + new Date().toTimeString().substring(0, 5) +
            " | " + activos + "/" + sessions.length + " activos | " + (git.branch || "?");

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

    // Fallback a texto si la imagen falló o canvas no disponible
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
  const git = getGitInfo();
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
    // Header row
    lines.push(boxLine(
      C.bold +
      padEnd("ID", 10) +
      padEnd("Agente", 16) +
      padEnd("Accs", 5) +
      padEnd("Dur.", 7) +
      padEnd("Ultima accion", 25) +
      "Est." +
      C.reset, W
    ));

    for (const s of sessions) {
      const icon = livenessIcon(s);
      const agent = agentDisplayName(s);
      const duration = formatDuration(s.started_ts, s.last_activity_ts);
      const action = lastActionLabel(s);
      let row =
        padEnd(s.id, 10) +
        padEnd(truncate(agent, 15), 16) +
        padEnd(String(s.action_count || 0), 5) +
        padEnd(duration, 7) +
        padEnd(action, 25) +
        icon;

      lines.push(boxLine(row, W));
      // Mostrar tarea activa si existe
      if (s.current_task && s.status !== "done") {
        const taskLine = C.dim + "  \u2514\u2500 \u2699 " + C.reset +
          C.cyan + truncate(s.current_task, W - 12) + C.reset;
        lines.push(boxLine(taskLine, W));
      }
      if (verbose) {
        const skills = (s.skills_invoked || []).join(", ") || "\u2014";
        const detail = C.dim + "  rama: " + (s.branch || "?") + "  sub: " + (s.sub_count || 0) +
          "  skills: " + skills + "  mode: " + (s.permission_mode || "?") + C.reset;
        lines.push(boxLine(truncate(detail, W - 4), W));
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

  // Panel REPO
  lines.push(boxMid("REPO", W));
  lines.push(boxLine("Rama: " + C.cyan + (git.branch || "?") + C.reset, W));
  lines.push(boxLine("Commit: " + C.dim + truncate(git.commit, W - 14) + C.reset, W));

  // CI (solo si no es la primera carga — es lento)
  let ciLine = C.dim + "CI: cargando..." + C.reset;
  try {
    const ci = getCIStatus();
    const icon = ciIcon(ci);
    ciLine = "CI: " + icon + " " + ci.status + (ci.conclusion !== "-" ? " " + ci.conclusion : "") +
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

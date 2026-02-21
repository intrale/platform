#!/usr/bin/env node
// Monitor v3 — Dashboard Live Multi-Sesion + Reporter Telegram
// Script standalone Node.js puro — sin dependencias externas
// Uso: node .claude/dashboard.js [--verbose] [--report <minutos>]
//   --report N   enviar resumen a Telegram cada N minutos (defecto: deshabilitado)
//   --report 0   deshabilitar reporter explícitamente
// Teclado: q=salir, v=toggle verbose, r=refresh manual
const fs = require("fs");
const path = require("path");
const https = require("https");
const querystring = require("querystring");
const { execSync } = require("child_process");

// --- config ---
const REPO_ROOT = path.resolve(__dirname, "..");
const SESSIONS_DIR = path.join(REPO_ROOT, ".claude", "sessions");
const LOG_FILE = path.join(REPO_ROOT, ".claude", "activity-log.jsonl");
const REFRESH_MS = 5000;
const ACTIVE_THRESHOLD = 5 * 60 * 1000;   // 5 min
const IDLE_THRESHOLD = 15 * 60 * 1000;    // 15 min
const DONE_DISPLAY_HOURS = 1;
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

// --- Telegram reporter config ---
const TG_BOT_TOKEN = "8403197784:AAG07242gOCKwZ-G-DI8eLC6R1HwfhG6Exk";
const TG_CHAT_ID = "6529617704";
const TG_MAX_RETRIES = 2;
const TG_RETRY_DELAY_MS = 1500;

function parseReportInterval() {
  const idx = process.argv.indexOf("--report");
  if (idx === -1) return 0;
  const val = parseInt(process.argv[idx + 1], 10);
  return isNaN(val) || val < 0 ? 3 : val;
}

// --- state ---
let verbose = process.argv.includes("--verbose") || process.argv.includes("-v");
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
        // Solo parent, y done solo si < 1h
        if (data.type === "sub") continue;
        if (data.status === "done") {
          const age = Date.now() - new Date(data.last_activity_ts).getTime();
          if (age > DONE_DISPLAY_HOURS * 3600 * 1000) continue;
        }
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
    const agent = s.agent_name || s.branch || s.id;
    const action = lastActionLabel(s);
    const age = formatAge(s.last_activity_ts);
    msg += icon + " " + truncate(agent, 22) + " \u2014 " + action + " (" + age + ")\n";
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

async function sendReport() {
  try {
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
      const agent = s.agent_name || "Claude \uD83E\uDD16";
      const duration = formatDuration(s.started_ts, s.last_activity_ts);
      const action = lastActionLabel(s);
      let row =
        padEnd(s.id, 10) +
        padEnd(truncate(agent, 15), 16) +
        padEnd(String(s.action_count || 0), 5) +
        padEnd(duration, 7) +
        padEnd(action, 25) +
        icon;

      if (verbose) {
        lines.push(boxLine(row, W));
        const skills = (s.skills_invoked || []).join(", ") || "\u2014";
        const detail = C.dim + "  rama: " + (s.branch || "?") + "  sub: " + (s.sub_count || 0) +
          "  skills: " + skills + "  mode: " + (s.permission_mode || "?") + C.reset;
        lines.push(boxLine(truncate(detail, W - 4), W));
      } else {
        lines.push(boxLine(row, W));
      }
    }
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

#!/usr/bin/env node
// Dashboard Monitor Web v2 — Servidor HTTP + SSE + Screenshot + API
// Uso: node .claude/dashboard-server.js [--port 3100]
// Endpoints:
//   GET /           → HTML dashboard con datos embebidos
//   GET /events     → SSE stream (auto-refresh cada 5s)
//   GET /screenshot → Puppeteer screenshot PNG (?w=375&h=640)
//   GET /api/status → JSON con KPIs para /monitor
// Auto-stop: si no hay sesiones activas por 30 min, el servidor se cierra

const http = require("http");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const zlib = require("zlib");

// --- Config ---
const REPO_ROOT = path.resolve(__dirname, "..");
const CLAUDE_DIR = path.join(REPO_ROOT, ".claude");
const SESSIONS_DIR = path.join(CLAUDE_DIR, "sessions");
const LOG_FILE = path.join(CLAUDE_DIR, "activity-log.jsonl");
const PID_FILE = path.join(CLAUDE_DIR, "tmp", "dashboard-server.pid");
const TG_CONFIG_FILE = path.join(CLAUDE_DIR, "hooks", "telegram-config.json");
const SERVER_LOG_FILE = path.join(CLAUDE_DIR, "hooks", "hook-debug.log");

// Logging a archivo (detached processes no tienen stdio)
const _origLog = console.log;
console.log = function() {
  const msg = Array.prototype.join.call(arguments, " ");
  _origLog.apply(console, arguments);
  try { fs.appendFileSync(SERVER_LOG_FILE, "[" + new Date().toISOString() + "] " + msg + "\n"); } catch {}
};

const DEFAULT_PORT = 3100;
const SSE_INTERVAL_MS = 5000;
const ACTIVE_THRESHOLD_MS = 5 * 60 * 1000;
const IDLE_THRESHOLD_MS = 15 * 60 * 1000;
const AUTO_STOP_MS = 30 * 60 * 1000;
const RECENT_ACTIVITY_COUNT = 20;
const MAX_CI_ENTRIES = 5;
const PENDING_QUESTIONS_FILE = path.join(CLAUDE_DIR, "hooks", "pending-questions.json");
const APPROVAL_HISTORY_FILE = path.join(CLAUDE_DIR, "hooks", "approval-history.json");

// --- Parse args ---
const portIdx = process.argv.indexOf("--port");
const PORT = portIdx !== -1 ? parseInt(process.argv[portIdx + 1], 10) || DEFAULT_PORT : DEFAULT_PORT;

// --- State ---
let lastActivityTs = Date.now();
let cachedData = null;
let cachedDataTs = 0;
const DATA_CACHE_MS = 2000;
let etag = "0";

// --- Helpers ---
function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return null; }
}

function formatAge(isoTs) {
  if (!isoTs) return "???";
  const diff = Date.now() - new Date(isoTs).getTime();
  if (diff < 0) return "ahora";
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return secs + "s";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return mins + "m";
  const hrs = Math.floor(mins / 60);
  const rm = mins % 60;
  return hrs + "h " + (rm > 0 ? rm + "m" : "");
}

function formatDuration(startTs, endTs) {
  const ms = (endTs || Date.now()) - new Date(startTs).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return mins + "min";
  const hrs = Math.floor(mins / 60);
  return hrs + "h " + (mins % 60) + "min";
}

function getSessionStatus(session) {
  const elapsed = Date.now() - new Date(session.last_activity_ts).getTime();
  if (session.status === "done") return "done";
  if (elapsed < ACTIVE_THRESHOLD_MS) return "active";
  if (elapsed < IDLE_THRESHOLD_MS) return "idle";
  return "stale";
}

function escHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// --- Data Collection ---
function collectData() {
  const now = Date.now();
  if (cachedData && (now - cachedDataTs) < DATA_CACHE_MS) return cachedData;

  // Sessions
  const sessions = [];
  try {
    if (fs.existsSync(SESSIONS_DIR)) {
      const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json"));
      for (const f of files) {
        const s = readJson(path.join(SESSIONS_DIR, f));
        if (!s) continue;
        const status = getSessionStatus(s);
        // Skip stale sessions older than 1 hour
        if (status === "stale") {
          const elapsed = now - new Date(s.last_activity_ts).getTime();
          if (elapsed > 60 * 60 * 1000) continue;
        }
        // Skip done sessions older than 30 min
        if (status === "done") {
          const elapsed = now - new Date(s.last_activity_ts).getTime();
          if (elapsed > 30 * 60 * 1000) continue;
        }
        sessions.push({ ...s, _status: status });
      }
    }
  } catch {}

  // Activity log (last N entries)
  const activities = [];
  try {
    if (fs.existsSync(LOG_FILE)) {
      const content = fs.readFileSync(LOG_FILE, "utf8").trim();
      if (content) {
        const lines = content.split("\n").slice(-RECENT_ACTIVITY_COUNT * 2);
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            activities.push(entry);
          } catch {}
        }
      }
    }
  } catch {}

  // Git info
  let branch = "unknown";
  let lastCommits = [];
  try {
    branch = execSync("git branch --show-current", { cwd: REPO_ROOT, timeout: 3000, windowsHide: true }).toString().trim();
  } catch {}
  try {
    const gitLog = execSync('git log --oneline -5 --format="%h|%s|%cr|%an"', { cwd: REPO_ROOT, timeout: 5000, windowsHide: true }).toString().trim();
    lastCommits = gitLog.split("\n").filter(Boolean).map(l => {
      const [hash, ...rest] = l.split("|");
      return { hash, message: rest[0] || "", age: rest[1] || "", author: rest[2] || "" };
    });
  } catch {}

  // CI status via gh (cached aggressively)
  let ciRuns = [];
  try {
    const ghPath = "/c/Workspaces/gh-cli/bin/gh.exe";
    if (fs.existsSync(ghPath.replace(/\//g, "\\"))) {
      const raw = execSync(ghPath + ' run list --limit 5 --json status,conclusion,headBranch,displayTitle,createdAt,databaseId', { cwd: REPO_ROOT, timeout: 10000, windowsHide: true }).toString().trim();
      ciRuns = JSON.parse(raw || "[]");
    }
  } catch {}

  // Pending questions (blocking data)
  let pendingQuestions = [];
  try {
    const pq = readJson(PENDING_QUESTIONS_FILE);
    if (pq && Array.isArray(pq.questions)) {
      pendingQuestions = pq.questions.filter(q => q.status === "pending");
    }
  } catch {}

  // Map approver_pid to session/agent for blocking relationships
  const pidToSession = {};
  for (const s of sessions) {
    if (s.pid) pidToSession[s.pid] = s;
  }
  const blockingRelations = [];
  for (const q of pendingQuestions) {
    if (q.approver_pid && pidToSession[q.approver_pid]) {
      const blockedSession = pidToSession[q.approver_pid];
      blockingRelations.push({
        blockedAgent: blockedSession.agent_name || "Ad-hoc (" + blockedSession.id + ")",
        blockedSessionId: blockedSession.id,
        reason: q.type === "permission" ? "Esperando permiso" : "Pregunta pendiente",
        message: (q.message || "").substring(0, 120),
        waitingSince: q.timestamp,
        waitingMs: Date.now() - new Date(q.timestamp).getTime(),
      });
    }
  }

  // Compute KPIs
  const activeSessions = sessions.filter(s => s._status === "active");
  const idleSessions = sessions.filter(s => s._status === "idle");
  const allTasks = [];
  for (const s of sessions) {
    if (Array.isArray(s.current_tasks)) {
      for (const t of s.current_tasks) {
        allTasks.push({ ...t, _session: s.id, _agent: s.agent_name || "Ad-hoc" });
      }
    }
  }
  const completedTasks = allTasks.filter(t => t.status === "completed");
  const inProgressTasks = allTasks.filter(t => t.status === "in_progress");
  const pendingTasks = allTasks.filter(t => t.status === "pending");

  const totalActions = sessions.reduce((sum, s) => sum + (s.action_count || 0), 0);

  // Velocity (actions per hour for last 6 hours)
  const velocity = computeVelocity(activities);

  // Alerts
  const alerts = [];
  const failedCI = ciRuns.filter(r => r.conclusion === "failure" && r.headBranch === "main");
  if (failedCI.length > 0) {
    alerts.push({ type: "critical", message: "CI ROJO en main: " + failedCI[0].displayTitle });
  }
  for (const t of allTasks) {
    if (t.status === "pending" && !t._agent) {
      alerts.push({ type: "warning", message: "Tarea sin owner: " + t.subject });
    }
  }
  for (const s of sessions) {
    if (s._status === "idle") {
      const elapsed = Date.now() - new Date(s.last_activity_ts).getTime();
      if (elapsed > 10 * 60 * 1000) {
        alerts.push({ type: "info", message: (s.agent_name || s.id) + " idle " + formatAge(s.last_activity_ts) });
      }
    }
  }

  const ciStatus = ciRuns.length > 0
    ? (ciRuns[0].conclusion === "success" ? "ok" : ciRuns[0].conclusion === "failure" ? "fail" : "running")
    : "unknown";

  const data = {
    timestamp: new Date().toISOString(),
    sessions,
    activeSessions: activeSessions.length,
    idleSessions: idleSessions.length,
    totalTasks: allTasks.length,
    completedTasks: completedTasks.length,
    inProgressTasks: inProgressTasks.length,
    pendingTasks: pendingTasks.length,
    totalActions,
    ciStatus,
    ciRuns,
    alerts,
    activities: activities.slice(-RECENT_ACTIVITY_COUNT).reverse(),
    velocity,
    branch,
    lastCommits,
    allTasks,
    pendingQuestions,
    blockingRelations,
  };

  cachedData = data;
  cachedDataTs = now;
  etag = String(now);
  return data;
}

function computeVelocity(activities) {
  const now = Date.now();
  const buckets = Array(6).fill(0); // 6 hours, newest first
  for (const a of activities) {
    const ts = new Date(a.ts).getTime();
    const hoursAgo = (now - ts) / (3600 * 1000);
    if (hoursAgo >= 0 && hoursAgo < 6) {
      const bucket = Math.floor(hoursAgo);
      buckets[bucket]++;
    }
  }
  return buckets;
}

// --- HTML Template ---
function renderHTML(data, theme) {
  const isDark = theme !== "light";
  const sprintProgress = data.totalTasks > 0
    ? Math.round((data.completedTasks / data.totalTasks) * 100)
    : 0;
  const completedDeg = Math.round((data.completedTasks / Math.max(data.totalTasks, 1)) * 360);
  const inProgressDeg = Math.round((data.inProgressTasks / Math.max(data.totalTasks, 1)) * 360);

  // Velocity sparkline SVG
  const velMax = Math.max(...data.velocity, 1);
  const velPoints = data.velocity.map((v, i) => {
    const x = 10 + i * (80 / 5);
    const y = 45 - (v / velMax) * 35;
    return `${x},${y}`;
  }).join(" ");

  // Agent icons (character emojis)
  const AGENT_ICONS = {
    "Guru": "&#129497;", // mago
    "Doc": "&#128214;", "Doc (historia)": "&#128214;",
    "Doc (refinar)": "&#128214;", "Doc (priorizar)": "&#128214;",
    "Planner": "&#128218;", // libro abierto
    "DeliveryManager": "&#127939;", // corredor
    "Tester": "&#128373;&#65039;", // detective
    "Monitor": "&#128065;&#65039;", // ojo
    "Builder": "&#127959;&#65039;", // construccion
    "Review": "&#128270;", // lupa
    "QA": "&#128373;&#65039;", // detective
    "Auth": "&#128274;", // candado
    "UX Specialist": "&#127912;", // arte
    "Scrum Master": "&#128203;", // clipboard
    "PO": "&#128188;", // maletin
    "BackendDev": "&#9881;&#65039;", // gear
    "AndroidDev": "&#128241;", // phone
    "iOSDev": "&#127823;", // apple
    "WebDev": "&#127760;", // globe
    "DesktopDev": "&#128187;", // laptop
    "Ops": "&#128295;", // wrench
  };

  // Personalidades de agentes (para tooltips/feed)
  const AGENT_PERSONALITIES = {
    "Guru": "Siempre encuentra la pista",
    "DeliveryManager": "Entrega en tiempo y forma",
    "Tester": "Cuestiona todo",
    "Builder": "Forja c\u00f3digo s\u00f3lido",
    "Planner": "Organiza el caos",
    "Monitor": "Nunca duerme",
    "Doc": "Documenta el camino",
    "Review": "Ojo cr\u00edtico",
    "QA": "Nada pasa sin prueba",
    "Auth": "Guardi\u00e1n de accesos",
    "PO": "La voz del usuario",
    "UX Specialist": "Dise\u00f1a experiencias",
    "Scrum Master": "Facilita el flujo",
    "Ops": "Mantiene todo andando",
  };

  const AGENT_GRADIENTS = {
    "Guru": "linear-gradient(135deg, #6366f1, #a78bfa)",
    "Doc": "linear-gradient(135deg, #8b5cf6, #a78bfa)",
    "Planner": "linear-gradient(135deg, #eab308, #fbbf24)",
    "DeliveryManager": "linear-gradient(135deg, #10b981, #34d399)",
    "Tester": "linear-gradient(135deg, #a855f7, #ec4899)",
    "QA": "linear-gradient(135deg, #a855f7, #ec4899)",
    "Builder": "linear-gradient(135deg, #f97316, #fb923c)",
    "Review": "linear-gradient(135deg, #3b82f6, #8b5cf6)",
    "Monitor": "linear-gradient(135deg, #06b6d4, #22d3ee)",
    "Auth": "linear-gradient(135deg, #64748b, #94a3b8)",
    "PO": "linear-gradient(135deg, #0ea5e9, #38bdf8)",
    "UX Specialist": "linear-gradient(135deg, #ec4899, #f472b6)",
    "Scrum Master": "linear-gradient(135deg, #14b8a6, #2dd4bf)",
    "Ops": "linear-gradient(135deg, #78716c, #a8a29e)",
    "BackendDev": "linear-gradient(135deg, #ef4444, #f87171)",
    "AndroidDev": "linear-gradient(135deg, #22c55e, #4ade80)",
    "WebDev": "linear-gradient(135deg, #3b82f6, #60a5fa)",
  };

  // Agent color (solid, for SVG bars)
  const AGENT_COLORS = {
    "Guru": "#818cf8", "Doc": "#a78bfa", "Planner": "#fbbf24",
    "DeliveryManager": "#34d399", "Tester": "#d946ef", "QA": "#d946ef",
    "Builder": "#fb923c", "Review": "#818cf8", "Monitor": "#22d3ee",
    "Auth": "#94a3b8", "PO": "#38bdf8", "UX Specialist": "#f472b6",
    "Scrum Master": "#2dd4bf", "Ops": "#a8a29e",
    "BackendDev": "#f87171", "AndroidDev": "#4ade80", "WebDev": "#60a5fa",
  };

  const STATUS_COLORS = { active: "#34d399", idle: "#fbbf24", done: "#6C7086", stale: "#555872" };
  const STATUS_LABELS = { active: "Activo", idle: "Idle", done: "Terminado", stale: "Stale" };

  // Check which agents are blocked
  const blockedPids = new Set(data.blockingRelations.map(b => b.blockedSessionId));
  const blockedAgentNames = new Set(data.blockingRelations.map(b => b.blockedAgent));

  // Render sessions HTML (agent cards)
  let agentsHtml = "";
  const visibleSessions = data.sessions.filter(s => s._status !== "stale");
  for (const s of visibleSessions) {
    const icon = AGENT_ICONS[s.agent_name] || "&#129302;";
    const gradient = AGENT_GRADIENTS[s.agent_name] || "linear-gradient(135deg, #555872, #6C7086)";
    const statusColor = STATUS_COLORS[s._status] || "#555872";
    const statusLabel = STATUS_LABELS[s._status] || s._status;
    const name = escHtml(s.agent_name || "Ad-hoc (" + s.id + ")");
    const branchDisplay = escHtml(s.branch || "unknown");
    const duration = formatDuration(s.started_ts);
    const idleInfo = s._status === "idle" ? " " + formatAge(s.last_activity_ts) : "";
    const lastAction = s.last_tool ? (escHtml(s.last_tool) + ": " + escHtml((s.last_target || "").substring(0, 50))) : "--";
    const isBlocked = blockedPids.has(s.id);
    const personality = AGENT_PERSONALITIES[s.agent_name] || "";

    agentsHtml += `
      <div class="agent-card ${isBlocked ? 'agent-blocked' : ''}" title="${escHtml(personality)}">
        <div class="agent-avatar" style="background:${gradient};">${icon}</div>
        <div class="agent-info">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <div class="agent-name">${name}</div>
            ${isBlocked
              ? '<span class="agent-status agent-status-blocked">&#128721; Bloqueado</span>'
              : '<span class="agent-status" style="background:' + statusColor + '20;color:' + statusColor + ';border-color:' + statusColor + '40;">' + statusLabel + idleInfo + '</span>'
            }
          </div>
          <div class="agent-meta">${branchDisplay} &middot; ${s.action_count || 0} acc &middot; ${duration}</div>
          <div class="agent-action"><div class="dot" style="background:${isBlocked ? 'var(--red)' : statusColor};${isBlocked ? 'animation:pulse-red 1.5s infinite;' : ''}"></div>${lastAction}</div>
        </div>
      </div>`;
  }
  if (visibleSessions.length === 0) {
    agentsHtml = '<div class="empty-state">Sin agentes activos</div>';
  }

  // --- Timeline SVG bars (Fase 2) ---
  let timelineBarsHtml = "";
  if (visibleSessions.length > 0) {
    const barHeight = 36;
    const barGap = 8;
    const svgH = visibleSessions.length * (barHeight + barGap) + 10;
    const labelW = 130;
    const barW = 400;
    let bars = "";
    for (let i = 0; i < visibleSessions.length; i++) {
      const s = visibleSessions[i];
      const y = 5 + i * (barHeight + barGap);
      const agentIcon = AGENT_ICONS[s.agent_name] || "&#129302;";
      const agentColor = AGENT_COLORS[s.agent_name] || "#6C7086";
      const agentName = escHtml(s.agent_name || "Ad-hoc");
      const isBlocked = blockedPids.has(s.id);

      // Calculate progress from tasks
      const sessionTasks = (s.current_tasks || []);
      const totalT = sessionTasks.length;
      const doneT = sessionTasks.filter(t => t.status === "completed").length;
      const progressPct = totalT > 0 ? Math.round((doneT / totalT) * 100) : 0;
      const barFillW = Math.round(barW * progressPct / 100);

      // Sub-steps for expandable detail
      const hasSteps = sessionTasks.some(t => t.steps && t.steps.length > 0);

      bars += `
        <g class="timeline-agent-row" data-session="${escHtml(s.id)}" style="cursor:${hasSteps ? 'pointer' : 'default'};">
          <text x="30" y="${y + 23}" font-size="12" fill="var(--text)" font-weight="600">${agentName}</text>
          <text x="4" y="${y + 24}" font-size="14">${agentIcon}</text>
          <rect x="${labelW}" y="${y + 4}" width="${barW}" height="${barHeight - 8}" rx="4" fill="var(--surface3)" />
          <rect x="${labelW}" y="${y + 4}" width="${barFillW}" height="${barHeight - 8}" rx="4" fill="${agentColor}" opacity="0.85">
            ${isBlocked ? '<animate attributeName="opacity" values="0.85;0.3;0.85" dur="1.5s" repeatCount="indefinite"/>' : ''}
          </rect>
          ${isBlocked ? '<rect x="' + labelW + '" y="' + (y + 4) + '" width="' + barW + '" height="' + (barHeight - 8) + '" rx="4" fill="none" stroke="var(--red)" stroke-width="2"><animate attributeName="stroke-opacity" values="1;0.2;1" dur="1.5s" repeatCount="indefinite"/></rect>' : ''}
          <text x="${labelW + barW + 8}" y="${y + 23}" font-size="11" fill="var(--text-dim)" font-weight="700">${progressPct}%</text>
          ${isBlocked ? '<text x="' + (labelW + barW + 40) + '" y="' + (y + 23) + '" font-size="11" fill="var(--red)">&#128721; Bloqueado</text>' : ''}
        </g>`;
    }
    timelineBarsHtml = `
      <svg class="timeline-svg" viewBox="0 0 600 ${svgH}" preserveAspectRatio="xMinYMin meet" style="width:100%;height:${svgH}px;">
        ${bars}
      </svg>`;
  } else {
    timelineBarsHtml = '<div class="empty-state">Sin agentes para el timeline</div>';
  }

  // --- Sub-steps expandable HTML ---
  let substepsHtml = "";
  for (const s of visibleSessions) {
    const sessionTasks = s.current_tasks || [];
    const tasksWithSteps = sessionTasks.filter(t => t.steps && t.steps.length > 0);
    if (tasksWithSteps.length > 0) {
      substepsHtml += `<div class="substeps-detail" id="substeps-${escHtml(s.id)}" style="display:none;">`;
      substepsHtml += `<div class="substeps-title">${AGENT_ICONS[s.agent_name] || "&#129302;"} ${escHtml(s.agent_name || "Ad-hoc")} — Sub-pasos</div>`;
      for (const t of tasksWithSteps) {
        substepsHtml += `<div class="substeps-task">${escHtml(t.subject)}</div>`;
        for (let si = 0; si < t.steps.length; si++) {
          const step = t.steps[si];
          const isCompleted = t.completed_steps && t.completed_steps.includes(step);
          const isCurrent = (t.current_step || 0) === si + 1 && !isCompleted;
          const stepIcon = isCompleted ? "&#10003;" : isCurrent ? "&#9654;" : "&#9675;";
          const stepClass = isCompleted ? "step-done" : isCurrent ? "step-active" : "step-pending";
          substepsHtml += `<div class="substep ${stepClass}">${stepIcon} ${escHtml(step)}</div>`;
        }
      }
      substepsHtml += `</div>`;
    }
  }

  // --- Activity Feed (Fase 1) ---
  let activityFeedHtml = "";
  for (const a of data.activities) {
    const time = a.ts ? new Date(a.ts).toLocaleTimeString("es-AR", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "??:??";
    // Match session to agent name
    let agentName = a.session || "?";
    let agentIcon = "&#129302;";
    for (const s of data.sessions) {
      if (s.id === a.session) {
        agentName = s.agent_name || "Ad-hoc (" + s.id + ")";
        agentIcon = AGENT_ICONS[s.agent_name] || "&#129302;";
        break;
      }
    }
    const toolLabel = escHtml(a.tool || "");
    const target = escHtml((a.target || "").substring(0, 80));
    activityFeedHtml += `
      <div class="feed-item">
        <div class="feed-time">${time}</div>
        <div class="feed-icon">${agentIcon}</div>
        <div class="feed-body">
          <span class="feed-agent">${escHtml(agentName)}</span>
          <span class="feed-tool">${toolLabel}</span>
          <span class="feed-target">${target}</span>
        </div>
      </div>`;
  }

  // Blocking events in feed (highlighted)
  let blockingFeedHtml = "";
  for (const b of data.blockingRelations) {
    const waitTime = formatAge(b.waitingSince);
    blockingFeedHtml += `
      <div class="feed-item feed-blocked">
        <div class="feed-time">&#128721;</div>
        <div class="feed-icon" style="filter:grayscale(1) brightness(1.5);">&#9888;&#65039;</div>
        <div class="feed-body">
          <span class="feed-agent">${escHtml(b.blockedAgent)}</span>
          <span class="feed-reason">${escHtml(b.reason)} (${waitTime})</span>
        </div>
      </div>`;
  }

  // Blocking relations section
  let relationsHtml = "";
  if (data.blockingRelations.length > 0) {
    relationsHtml = '<div class="relations-section"><div class="relations-title">&#128279; Relaciones activas</div>';
    for (const b of data.blockingRelations) {
      relationsHtml += `<div class="relation-item">
        <span class="relation-blocked">&#128721; ${escHtml(b.blockedAgent)}</span>
        <span class="relation-arrow">&larr;</span>
        <span class="relation-reason">${escHtml(b.reason)}</span>
        <span class="relation-time">${formatAge(b.waitingSince)}</span>
      </div>`;
    }
    relationsHtml += '</div>';
  }

  // Render tasks HTML
  let tasksHtml = "";
  for (const t of data.allTasks) {
    const isDone = t.status === "completed";
    const isActive = t.status === "in_progress";
    const checkClass = isDone ? "task-check-done" : isActive ? "task-check-active" : "task-check-pending";
    const checkIcon = isDone ? "&#10003;" : isActive ? "&#9654;" : "";
    const nameClass = isDone ? "task-name-done" : "";
    const subText = t.steps ? (isDone ? t.steps.length + "/" + t.steps.length + " sub-pasos completados" : (t.current_step || 0) + "/" + t.steps.length + " sub-pasos") : "";
    const progressWidth = t.progress || 0;

    tasksHtml += `
      <div class="task-item">
        <div class="task-check ${checkClass}">${checkIcon}</div>
        <div class="task-content">
          <div class="task-name ${nameClass}">${escHtml(t.subject)}</div>
          ${subText ? '<div class="task-sub">' + escHtml(subText) + '</div>' : ""}
          ${isActive && t.steps ? '<div class="task-bar"><div class="task-bar-fill" style="width:' + progressWidth + '%;background:var(--blue);"></div></div>' : ""}
        </div>
        <div class="task-owner">${escHtml(t._agent || "")}</div>
      </div>`;
  }
  if (data.allTasks.length === 0) {
    tasksHtml = '<div class="empty-state">Sin tareas</div>';
  }

  // Render CI HTML
  let ciHtml = "";
  for (const r of data.ciRuns.slice(0, MAX_CI_ENTRIES)) {
    const isOk = r.conclusion === "success";
    const isFail = r.conclusion === "failure";
    const isRunning = r.status === "in_progress" || r.status === "queued";
    const iconClass = isOk ? "ci-ok" : isFail ? "ci-fail" : "ci-run";
    const icon = isOk ? "&#10003;" : isFail ? "&#10007;" : "&#9203;";
    const iconColor = isOk ? "var(--green)" : isFail ? "var(--red)" : "var(--yellow)";
    ciHtml += `
      <div class="ci-row">
        <div class="ci-icon ${iconClass}" style="color:${iconColor}">${icon}</div>
        <div class="ci-text"><strong>${escHtml(r.headBranch)}</strong> &middot; ${escHtml((r.displayTitle || "").substring(0, 50))}</div>
        <div class="ci-time">${formatAge(r.createdAt)}</div>
      </div>`;
  }
  if (data.ciRuns.length === 0) {
    ciHtml = '<div class="empty-state">Sin datos CI</div>';
  }

  // Render activity timeline HTML
  let timelineHtml = "";
  for (let i = 0; i < data.activities.length; i++) {
    const a = data.activities[i];
    const isNow = i === 0;
    const time = a.ts ? new Date(a.ts).toLocaleTimeString("es-AR", { hour12: false }) : "??:??";
    timelineHtml += `
      <div class="tl-item ${isNow ? 'tl-now' : ''}">
        <div class="tl-time">${time}</div>
        <div class="tl-desc"><strong>${escHtml(a.session || "?")}</strong> &middot; ${escHtml(a.tool || "")} &middot; ${escHtml((a.target || "").substring(0, 50))}</div>
      </div>`;
  }
  if (data.activities.length === 0) {
    timelineHtml = '<div class="empty-state" style="padding-left:20px;">Sin actividad reciente</div>';
  }

  // Alerts HTML
  let alertsHtml = "";
  if (data.alerts.length > 0) {
    for (const a of data.alerts) {
      const color = a.type === "critical" ? "var(--red)" : a.type === "warning" ? "var(--yellow)" : "var(--blue)";
      const icon = a.type === "critical" ? "&#128680;" : a.type === "warning" ? "&#9888;&#65039;" : "&#8505;&#65039;";
      alertsHtml += `<div class="alert-item" style="border-left-color:${color};">${icon} ${escHtml(a.message)}</div>`;
    }
  }

  // Burndown data (tasks over time - simplified)
  const burndownTotal = data.totalTasks;
  const burndownDone = data.completedTasks;
  const burndownRemaining = burndownTotal - burndownDone;

  return `<!DOCTYPE html>
<html lang="es" data-theme="${isDark ? 'dark' : 'light'}">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Intrale Monitor</title>
  <style>
    :root {
      --bg: #0a0b10; --surface: #12141d; --surface2: #1a1d2b; --surface3: #222639;
      --border: #2a2e42; --border-light: #363b54;
      --text: #e2e4ed; --text-dim: #8b8fa5; --text-muted: #555872; --white: #ffffff;
      --green: #34d399; --green-dim: rgba(52,211,153,0.12);
      --yellow: #fbbf24; --yellow-dim: rgba(251,191,36,0.12);
      --red: #f87171; --red-dim: rgba(248,113,113,0.12);
      --blue: #60a5fa; --blue-dim: rgba(96,165,250,0.12);
      --purple: #a78bfa; --purple-dim: rgba(167,139,250,0.12);
      --cyan: #22d3ee; --orange: #fb923c; --orange-dim: rgba(251,146,60,0.12);
      --pink: #f472b6;
      --gradient-blue: linear-gradient(135deg, #3b82f6, #8b5cf6);
      --gradient-green: linear-gradient(135deg, #10b981, #34d399);
      --shadow: 0 4px 24px rgba(0,0,0,0.3);
      --radius: 16px; --radius-sm: 10px; --radius-xs: 6px;
    }
    [data-theme="light"] {
      --bg: #f8fafc; --surface: #ffffff; --surface2: #f1f5f9; --surface3: #e2e8f0;
      --border: #cbd5e1; --border-light: #94a3b8;
      --text: #1e293b; --text-dim: #475569; --text-muted: #94a3b8; --white: #0f172a;
      --green-dim: rgba(52,211,153,0.15); --yellow-dim: rgba(251,191,36,0.15);
      --red-dim: rgba(248,113,113,0.15); --blue-dim: rgba(96,165,250,0.15);
      --purple-dim: rgba(167,139,250,0.15); --orange-dim: rgba(251,146,60,0.15);
      --shadow: 0 4px 24px rgba(0,0,0,0.08);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Inter', system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); font-size: 13px; line-height: 1.6; }

    /* Header bar */
    .header { background: var(--surface); border-bottom: 1px solid var(--border); padding: 10px 20px; display: flex; justify-content: space-between; align-items: center; position: sticky; top: 0; z-index: 100; backdrop-filter: blur(10px); }
    .header-left { display: flex; align-items: center; gap: 12px; }
    .header-title { font-size: 14px; font-weight: 700; color: var(--white); }
    .header-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); animation: pulse 2s infinite; }
    .header-right { display: flex; align-items: center; gap: 12px; font-size: 11px; color: var(--text-muted); }
    .theme-toggle { background: var(--surface2); border: 1px solid var(--border); border-radius: 20px; padding: 4px 12px; font-size: 11px; color: var(--text-dim); cursor: pointer; }
    .theme-toggle:hover { border-color: var(--blue); color: var(--blue); }

    /* Main layout */
    .container { max-width: 1200px; margin: 0 auto; padding: 16px; }

    /* KPI row */
    .kpi-row { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; margin-bottom: 16px; }
    .kpi { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 16px; text-align: center; position: relative; overflow: hidden; }
    .kpi::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px; }
    .kpi-green::before { background: var(--gradient-green); }
    .kpi-blue::before { background: var(--gradient-blue); }
    .kpi-orange::before { background: linear-gradient(135deg, #f59e0b, #fb923c); }
    .kpi-red::before { background: linear-gradient(135deg, #ef4444, #f87171); }
    .kpi-purple::before { background: linear-gradient(135deg, #8b5cf6, #a78bfa); }
    .kv { font-size: 28px; font-weight: 800; line-height: 1.2; }
    .kl { font-size: 10px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 1px; font-weight: 500; margin-top: 4px; }
    .kt { font-size: 10px; margin-top: 2px; font-weight: 600; }

    /* Two-column layout */
    .grid-2col { display: grid; grid-template-columns: 1fr 300px; gap: 14px; margin-bottom: 16px; }
    .grid-2equal { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 16px; }

    /* Agent cards */
    .agent-card { display: flex; gap: 12px; padding: 12px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); margin-bottom: 8px; transition: border-color 0.2s; }
    .agent-card:hover { border-color: var(--border-light); }
    .agent-avatar { width: 36px; height: 36px; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 16px; flex-shrink: 0; }
    .agent-info { flex: 1; min-width: 0; }
    .agent-name { font-weight: 700; font-size: 13px; color: var(--white); }
    .agent-status { font-size: 10px; font-weight: 600; padding: 2px 8px; border-radius: 100px; border: 1px solid; white-space: nowrap; }
    .agent-meta { font-size: 10px; color: var(--text-muted); margin-top: 2px; }
    .agent-action { font-size: 11px; color: var(--text-dim); margin-top: 4px; display: flex; align-items: center; gap: 6px; }
    .dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }

    /* Progress ring */
    .progress-panel { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 20px; text-align: center; }
    .progress-ring { width: 110px; height: 110px; border-radius: 50%; margin: 0 auto 16px; position: relative; }
    .progress-ring-inner { position: absolute; inset: 14px; background: var(--surface); border-radius: 50%; display: flex; align-items: center; justify-content: center; flex-direction: column; }
    .progress-pct { font-size: 24px; font-weight: 800; color: var(--white); }
    .progress-label { font-size: 8px; color: var(--text-muted); text-transform: uppercase; }
    .legend-item { display: flex; align-items: center; gap: 8px; margin: 5px 0; font-size: 11px; color: var(--text-dim); text-align: left; padding: 0 8px; }
    .legend-dot { width: 8px; height: 8px; border-radius: 2px; flex-shrink: 0; }

    /* Tasks panel */
    .panel { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 16px; }
    .panel-title { font-size: 12px; font-weight: 700; color: var(--white); margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; }
    .chip { font-size: 10px; font-weight: 600; padding: 2px 8px; border-radius: 100px; }
    .chip-green { background: var(--green-dim); color: var(--green); }
    .chip-blue { background: var(--blue-dim); color: var(--blue); }
    .chip-red { background: var(--red-dim); color: var(--red); }
    .chip-yellow { background: var(--yellow-dim); color: var(--yellow); }

    .task-item { display: flex; align-items: flex-start; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--border); }
    .task-item:last-child { border-bottom: none; }
    .task-check { width: 20px; height: 20px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 10px; flex-shrink: 0; margin-top: 2px; }
    .task-check-done { background: var(--green-dim); color: var(--green); }
    .task-check-active { background: var(--blue-dim); color: var(--blue); animation: pulse 2s infinite; }
    .task-check-pending { background: var(--surface2); border: 1px solid var(--border); }
    .task-content { flex: 1; min-width: 0; }
    .task-name { font-size: 12px; color: var(--text); font-weight: 500; }
    .task-name-done { text-decoration: line-through; color: var(--text-muted); }
    .task-sub { font-size: 10px; color: var(--text-muted); margin-top: 2px; }
    .task-bar { width: 80px; height: 4px; background: var(--surface3); border-radius: 2px; margin-top: 6px; overflow: hidden; }
    .task-bar-fill { height: 100%; border-radius: 2px; transition: width 0.5s; }
    .task-owner { font-size: 10px; color: var(--text-muted); font-weight: 600; white-space: nowrap; }
    .tasks-progress-bar { height: 4px; background: var(--surface3); border-radius: 2px; margin-bottom: 12px; overflow: hidden; }
    .tasks-progress-fill { height: 100%; border-radius: 2px; transition: width 0.5s; }

    /* CI panel */
    .ci-row { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--border); }
    .ci-row:last-child { border-bottom: none; }
    .ci-icon { width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; flex-shrink: 0; }
    .ci-ok { background: var(--green-dim); }
    .ci-fail { background: var(--red-dim); }
    .ci-run { background: var(--yellow-dim); }
    .ci-text { flex: 1; font-size: 11px; color: var(--text-dim); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ci-text strong { color: var(--text); font-weight: 600; }
    .ci-time { font-size: 10px; color: var(--text-muted); white-space: nowrap; }

    /* Activity timeline */
    .timeline { position: relative; padding-left: 20px; }
    .timeline::before { content: ''; position: absolute; left: 6px; top: 8px; bottom: 8px; width: 2px; background: var(--border); }
    .tl-item { position: relative; padding: 6px 0 6px 16px; }
    .tl-item::before { content: ''; position: absolute; left: -18px; top: 12px; width: 8px; height: 8px; border-radius: 50%; border: 2px solid var(--border); background: var(--bg); }
    .tl-item.tl-now::before { border-color: var(--green); background: var(--green); box-shadow: 0 0 8px rgba(52,211,153,0.4); }
    .tl-time { font-size: 10px; color: var(--text-muted); font-weight: 600; }
    .tl-desc { font-size: 11px; color: var(--text-dim); }
    .tl-desc strong { color: var(--text); }

    /* Alerts */
    .alerts-panel { margin-bottom: 16px; }
    .alert-item { padding: 10px 14px; background: var(--surface); border: 1px solid var(--border); border-left: 4px solid; border-radius: var(--radius-xs); margin-bottom: 6px; font-size: 12px; color: var(--text-dim); }

    /* Velocity sparkline */
    .sparkline-panel { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 16px; }
    .sparkline-svg { width: 100%; height: 50px; }

    /* Burndown */
    .burndown-bar { display: flex; height: 12px; border-radius: 6px; overflow: hidden; background: var(--surface3); margin-top: 8px; }
    .burndown-done { background: var(--green); transition: width 0.5s; }
    .burndown-progress { background: var(--blue); transition: width 0.5s; }

    /* Empty state */
    .empty-state { font-size: 12px; color: var(--text-muted); font-style: italic; padding: 12px 0; text-align: center; }

    /* Agent blocked state */
    .agent-blocked { border-color: var(--red) !important; border-left: 3px solid var(--red); animation: pulse-blocked 2s infinite; }
    .agent-status-blocked { background: var(--red-dim); color: var(--red); border: 1px solid rgba(248,113,113,0.4); font-size: 10px; font-weight: 600; padding: 2px 8px; border-radius: 100px; white-space: nowrap; animation: pulse-red 1.5s infinite; }
    @keyframes pulse-blocked { 0%, 100% { box-shadow: 0 0 0 0 rgba(248,113,113,0); } 50% { box-shadow: 0 0 12px 2px rgba(248,113,113,0.15); } }
    @keyframes pulse-red { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }

    /* Timeline SVG bars */
    .timeline-svg { overflow: visible; }
    .timeline-agent-row:hover rect { filter: brightness(1.2); }
    .timeline-panel { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 16px; overflow-x: auto; }

    /* Sub-steps expandable */
    .substeps-detail { background: var(--surface2); border: 1px solid var(--border); border-radius: var(--radius-xs); padding: 12px; margin-top: 8px; }
    .substeps-title { font-size: 12px; font-weight: 700; color: var(--white); margin-bottom: 8px; }
    .substeps-task { font-size: 11px; font-weight: 600; color: var(--text-dim); margin: 6px 0 4px 0; }
    .substep { font-size: 11px; color: var(--text-dim); padding: 2px 0 2px 16px; }
    .step-done { color: var(--green); }
    .step-active { color: var(--blue); font-weight: 600; }
    .step-pending { color: var(--text-muted); }

    /* Activity Feed (chat-style) */
    .feed-panel { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 16px; max-height: 400px; overflow-y: auto; }
    .feed-item { display: flex; align-items: flex-start; gap: 8px; padding: 6px 8px; border-radius: var(--radius-xs); margin-bottom: 2px; transition: background 0.15s; }
    .feed-item:hover { background: var(--surface2); }
    .feed-blocked { background: var(--red-dim) !important; border-left: 3px solid var(--red); border-radius: var(--radius-xs); }
    .feed-time { font-size: 10px; color: var(--text-muted); font-weight: 600; min-width: 60px; flex-shrink: 0; font-family: 'SF Mono', 'Cascadia Code', monospace; }
    .feed-icon { font-size: 14px; flex-shrink: 0; width: 20px; text-align: center; }
    .feed-body { font-size: 11px; color: var(--text-dim); flex: 1; min-width: 0; }
    .feed-agent { font-weight: 700; color: var(--white); margin-right: 4px; }
    .feed-tool { background: var(--blue-dim); color: var(--blue); font-size: 10px; padding: 1px 6px; border-radius: 4px; font-weight: 600; margin-right: 4px; }
    .feed-target { color: var(--text-dim); word-break: break-all; }
    .feed-reason { color: var(--red); font-weight: 600; }

    /* Blocking relations */
    .relations-section { background: var(--red-dim); border: 1px solid rgba(248,113,113,0.3); border-radius: var(--radius-xs); padding: 12px; margin-top: 10px; }
    .relations-title { font-size: 11px; font-weight: 700; color: var(--red); margin-bottom: 8px; }
    .relation-item { display: flex; align-items: center; gap: 8px; font-size: 11px; padding: 4px 0; }
    .relation-blocked { color: var(--red); font-weight: 600; }
    .relation-arrow { color: var(--text-muted); }
    .relation-reason { color: var(--text-dim); }
    .relation-time { color: var(--text-muted); font-size: 10px; margin-left: auto; }

    /* Sprint global bar */
    .sprint-global-bar { display: flex; align-items: center; gap: 12px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 12px 16px; margin-bottom: 16px; }
    .sprint-bar-track { flex: 1; height: 10px; background: var(--surface3); border-radius: 5px; overflow: hidden; }
    .sprint-bar-fill { height: 100%; border-radius: 5px; background: var(--gradient-green); transition: width 0.5s; }
    .sprint-bar-label { font-size: 13px; font-weight: 800; color: var(--white); min-width: 48px; text-align: right; }
    .sprint-bar-detail { font-size: 10px; color: var(--text-dim); min-width: 100px; }

    /* Responsive */
    @media (max-width: 768px) {
      .kpi-row { grid-template-columns: repeat(3, 1fr); }
      .grid-2col { grid-template-columns: 1fr; }
      .grid-2equal { grid-template-columns: 1fr; }
      .kv { font-size: 22px; }
    }
    @media (max-width: 480px) {
      .kpi-row { grid-template-columns: repeat(2, 1fr); }
      .container { padding: 8px; }
      .agent-card { padding: 8px; }
      .feed-panel { max-height: 300px; }
      .feed-time { min-width: 48px; font-size: 9px; }
      .timeline-panel { overflow-x: scroll; }
    }

    /* Animations */
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }

    /* Scrollbar */
    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: var(--bg); }
    ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  </style>
</head>
<body>
  <!-- Header -->
  <div class="header">
    <div class="header-left">
      <div class="header-dot"></div>
      <div class="header-title">Intrale Monitor</div>
    </div>
    <div class="header-right">
      <span id="update-time">Actualizado hace 0s</span>
      <span>&middot; Auto-refresh ON</span>
      <button class="theme-toggle" onclick="toggleTheme()">&#9790; / &#9788;</button>
    </div>
  </div>

  <div class="container">

    <!-- Alerts -->
    ${data.alerts.length > 0 ? '<div class="alerts-panel">' + alertsHtml + '</div>' : ''}

    <!-- KPI Row -->
    <div class="kpi-row">
      <div class="kpi kpi-green">
        <div class="kv" style="color:var(--green)">${data.activeSessions}</div>
        <div class="kl">Agentes activos</div>
        <div class="kt" style="color:var(--green)">${data.idleSessions > 0 ? data.idleSessions + ' idle' : 'Todos trabajando'}</div>
      </div>
      <div class="kpi kpi-blue">
        <div class="kv" style="color:var(--blue)">${data.totalTasks}</div>
        <div class="kl">Tareas totales</div>
        <div class="kt" style="color:var(--blue)">${data.pendingTasks} pendientes</div>
      </div>
      <div class="kpi ${data.ciStatus === 'ok' ? 'kpi-green' : data.ciStatus === 'fail' ? 'kpi-red' : 'kpi-orange'}">
        <div class="kv" style="color:${data.ciStatus === 'ok' ? 'var(--green)' : data.ciStatus === 'fail' ? 'var(--red)' : 'var(--yellow)'}">${data.ciStatus === 'ok' ? '&#10003;' : data.ciStatus === 'fail' ? '&#10007;' : '&#9203;'}</div>
        <div class="kl">CI / CD</div>
        <div class="kt" style="color:${data.ciStatus === 'ok' ? 'var(--green)' : data.ciStatus === 'fail' ? 'var(--red)' : 'var(--yellow)'}">${data.ciStatus === 'ok' ? 'Build OK' : data.ciStatus === 'fail' ? 'Build FAIL' : data.ciStatus === 'running' ? 'En curso...' : 'Sin datos'}</div>
      </div>
      <div class="kpi kpi-orange">
        <div class="kv" style="color:var(--orange)">${data.totalActions}</div>
        <div class="kl">Acciones hoy</div>
        <div class="kt" style="color:var(--orange)">${data.velocity[0] || 0} esta hora</div>
      </div>
      <div class="kpi kpi-purple">
        <div class="kv" style="color:${data.alerts.length > 0 ? 'var(--red)' : 'var(--green)'}">${data.alerts.length}</div>
        <div class="kl">Alertas</div>
        <div class="kt" style="color:${data.alerts.length > 0 ? 'var(--red)' : 'var(--green)'}">${data.alerts.length > 0 ? data.alerts.length + ' activa(s)' : 'Todo limpio'}</div>
      </div>
    </div>

    <!-- Sprint Global Progress Bar -->
    <div class="sprint-global-bar">
      <span style="font-size:11px;font-weight:700;color:var(--text-dim);">Sprint</span>
      <div class="sprint-bar-track">
        <div class="sprint-bar-fill" style="width:${sprintProgress}%;"></div>
      </div>
      <div class="sprint-bar-label">${sprintProgress}%</div>
      <div class="sprint-bar-detail">${data.completedTasks}/${data.totalTasks} tareas</div>
    </div>

    <!-- Agents + Progress Ring -->
    <div class="grid-2col">
      <div>
        <div style="font-size:12px;font-weight:700;color:var(--white);margin-bottom:10px;">Agentes</div>
        ${agentsHtml}
      </div>
      <div>
        <div style="font-size:12px;font-weight:700;color:var(--white);margin-bottom:10px;">Progreso del sprint</div>
        <div class="progress-panel">
          <div class="progress-ring" style="background: conic-gradient(var(--green) 0deg ${completedDeg}deg, var(--blue) ${completedDeg}deg ${completedDeg + inProgressDeg}deg, var(--surface3) ${completedDeg + inProgressDeg}deg 360deg);">
            <div class="progress-ring-inner">
              <div class="progress-pct">${sprintProgress}%</div>
              <div class="progress-label">completado</div>
            </div>
          </div>
          <div class="legend-item"><div class="legend-dot" style="background:var(--green);"></div> ${data.completedTasks} completadas</div>
          <div class="legend-item"><div class="legend-dot" style="background:var(--blue);"></div> ${data.inProgressTasks} en progreso</div>
          <div class="legend-item"><div class="legend-dot" style="background:var(--surface3);border:1px solid var(--border);"></div> ${data.pendingTasks} pendientes</div>
        </div>

        <!-- Velocity Sparkline -->
        <div class="sparkline-panel" style="margin-top:12px;">
          <div class="panel-title">Acciones / hora <span class="chip chip-blue">${data.velocity[0] || 0} ahora</span></div>
          <svg class="sparkline-svg" viewBox="0 0 100 50" preserveAspectRatio="none">
            <polyline points="${velPoints}" fill="none" stroke="var(--blue)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            <polyline points="${velPoints}" fill="url(#velGrad)" stroke="none"/>
            <defs><linearGradient id="velGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--blue)" stop-opacity="0.3"/><stop offset="100%" stop-color="var(--blue)" stop-opacity="0"/></linearGradient></defs>
          </svg>
          <div style="display:flex;justify-content:space-between;font-size:9px;color:var(--text-muted);margin-top:4px;">
            <span>-5h</span><span>-4h</span><span>-3h</span><span>-2h</span><span>-1h</span><span>Ahora</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Timeline with SVG progress bars (Fase 2) -->
    <div class="timeline-panel" style="margin-bottom:16px;">
      <div class="panel-title">Timeline de agentes <span class="chip chip-blue">${visibleSessions.length} activos</span></div>
      ${timelineBarsHtml}
      <div id="substeps-container">${substepsHtml}</div>
    </div>

    <!-- Activity Feed (Fase 1) -->
    <div class="feed-panel" style="margin-bottom:16px;" id="activity-feed">
      <div class="panel-title">Interacciones en vivo <span class="chip ${data.blockingRelations.length > 0 ? 'chip-red' : 'chip-green'}">${data.blockingRelations.length > 0 ? data.blockingRelations.length + ' bloqueado(s)' : 'Sin bloqueos'}</span></div>
      ${blockingFeedHtml}
      ${activityFeedHtml}
      ${activityFeedHtml.length === 0 && blockingFeedHtml.length === 0 ? '<div class="empty-state">Sin actividad reciente</div>' : ''}
      ${relationsHtml}
    </div>

    <!-- Tasks Panel -->
    <div class="panel" style="margin-bottom:16px;">
      <div class="panel-title">
        Tareas del sprint
        <span class="chip chip-green">${data.completedTasks}/${data.totalTasks} completadas</span>
      </div>
      <div class="tasks-progress-bar">
        <div class="tasks-progress-fill" style="width:${sprintProgress}%; background: var(--gradient-green);"></div>
      </div>
      ${tasksHtml}
    </div>

    <!-- CI + Activity -->
    <div class="grid-2equal">
      <div class="panel">
        <div class="panel-title">CI / CD</div>
        ${ciHtml}
      </div>
      <div class="panel">
        <div class="panel-title">Actividad reciente</div>
        <div class="timeline">
          ${timelineHtml}
        </div>
      </div>
    </div>

    <!-- Burndown -->
    <div class="panel" style="margin-bottom:16px;">
      <div class="panel-title">Sprint Burndown <span class="chip chip-green">${data.completedTasks} de ${data.totalTasks}</span></div>
      <div class="burndown-bar">
        <div class="burndown-done" style="width:${data.totalTasks > 0 ? Math.round(data.completedTasks / data.totalTasks * 100) : 0}%;"></div>
        <div class="burndown-progress" style="width:${data.totalTasks > 0 ? Math.round(data.inProgressTasks / data.totalTasks * 100) : 0}%;"></div>
      </div>
      <div style="display:flex;justify-content:space-between;margin-top:8px;font-size:10px;color:var(--text-muted);">
        <span>&#9632; Completadas: ${data.completedTasks}</span>
        <span>&#9632; En progreso: ${data.inProgressTasks}</span>
        <span>&#9632; Pendientes: ${data.pendingTasks}</span>
      </div>
    </div>

  </div>

  <script>
    // Theme toggle
    function toggleTheme() {
      const html = document.documentElement;
      const current = html.getAttribute('data-theme');
      html.setAttribute('data-theme', current === 'dark' ? 'light' : 'dark');
      localStorage.setItem('theme', html.getAttribute('data-theme'));
    }
    // Restore theme
    const saved = localStorage.getItem('theme');
    if (saved) document.documentElement.setAttribute('data-theme', saved);

    // Expandable sub-steps on timeline click
    document.querySelectorAll('.timeline-agent-row').forEach(function(row) {
      row.addEventListener('click', function() {
        var sid = this.getAttribute('data-session');
        var detail = document.getElementById('substeps-' + sid);
        if (detail) {
          detail.style.display = detail.style.display === 'none' ? 'block' : 'none';
        }
      });
    });

    // Auto-scroll activity feed to top (latest events)
    var feed = document.getElementById('activity-feed');
    if (feed) { feed.scrollTop = 0; }

    // SSE auto-refresh (deshabilitado con ?nosse=1 para screenshot)
    if (location.search.includes('nosse=1')) { return; }
    let lastUpdate = Date.now();
    const evtSource = new EventSource('/events');
    evtSource.onmessage = function(event) {
      lastUpdate = Date.now();
      // Full page refresh on data update (simple and reliable)
      const data = JSON.parse(event.data);
      if (data.reload) {
        location.reload();
      }
    };
    evtSource.onerror = function() {
      document.getElementById('update-time').textContent = 'Desconectado...';
    };

    // Update timer
    setInterval(() => {
      const secs = Math.floor((Date.now() - lastUpdate) / 1000);
      document.getElementById('update-time').textContent = 'Actualizado hace ' + secs + 's';
    }, 1000);
  </script>
</body>
</html>`;
}

// --- HTTP Server ---
const sseClients = new Set();

function handleRequest(req, res) {
  const url = new URL(req.url, "http://localhost:" + PORT);
  const pathname = url.pathname;

  lastActivityTs = Date.now();

  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (pathname === "/" || pathname === "/index.html") {
    // Serve HTML dashboard
    const theme = url.searchParams.get("theme") || "dark";
    const data = collectData();
    const html = renderHTML(data, theme);
    const body = Buffer.from(html, "utf8");

    // Gzip if accepted
    const acceptEncoding = req.headers["accept-encoding"] || "";
    if (acceptEncoding.includes("gzip")) {
      zlib.gzip(body, (err, compressed) => {
        if (err) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "ETag": etag });
          res.end(body);
        } else {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Encoding": "gzip", "ETag": etag, "Cache-Control": "no-cache" });
          res.end(compressed);
        }
      });
    } else {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "ETag": etag, "Cache-Control": "no-cache" });
      res.end(body);
    }
  } else if (pathname === "/events") {
    // SSE stream
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    res.write("data: {\"connected\":true}\n\n");

    const client = { res, alive: true };
    sseClients.add(client);

    req.on("close", () => {
      client.alive = false;
      sseClients.delete(client);
    });
  } else if (pathname === "/api/status") {
    // JSON API for /monitor
    const data = collectData();
    const json = JSON.stringify({
      timestamp: data.timestamp,
      activeSessions: data.activeSessions,
      idleSessions: data.idleSessions,
      totalTasks: data.totalTasks,
      completedTasks: data.completedTasks,
      inProgressTasks: data.inProgressTasks,
      pendingTasks: data.pendingTasks,
      totalActions: data.totalActions,
      ciStatus: data.ciStatus,
      alertCount: data.alerts.length,
      alerts: data.alerts,
      velocity: data.velocity,
      sessions: data.sessions.map(s => ({
        id: s.id,
        agent: s.agent_name || "Ad-hoc",
        branch: s.branch,
        status: s._status,
        actions: s.action_count,
        lastTool: s.last_tool,
        lastTarget: (s.last_target || "").substring(0, 80),
        duration: formatDuration(s.started_ts),
        tasks: (s.current_tasks || []).map(t => ({
          id: t.id, subject: t.subject, status: t.status, progress: t.progress || 0
        }))
      })),
      activities: data.activities,
      blockingRelations: data.blockingRelations,
      pendingQuestionsCount: data.pendingQuestions.length,
    });
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
    res.end(json);
  } else if (pathname === "/screenshot") {
    // Puppeteer screenshot
    const width = parseInt(url.searchParams.get("w")) || 375;
    const height = parseInt(url.searchParams.get("h")) || 640;
    takeScreenshot(width, height).then(buf => {
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
      res.end(buf);
    }).catch(err => {
      // Fallback: generate a simple text-based response
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Screenshot error: " + err.message + "\nInstall puppeteer: npm install puppeteer");
    });
  } else if (pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", uptime: process.uptime(), port: PORT }));
  } else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}

// --- Screenshot via Puppeteer ---
let puppeteerBrowser = null;

async function takeScreenshot(width, height) {
  let puppeteer;
  try { puppeteer = require("puppeteer"); } catch {
    // Fallback: Puppeteer instalado en docs/qa/
    try { puppeteer = require(path.join(REPO_ROOT, "docs", "qa", "node_modules", "puppeteer")); }
    catch { throw new Error("puppeteer not installed — run: cd docs/qa && npm install"); }
  }

  if (!puppeteerBrowser || !puppeteerBrowser.isConnected()) {
    puppeteerBrowser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
    });
  }

  const page = await puppeteerBrowser.newPage();
  try {
    await page.setViewport({ width, height });
    // Usar domcontentloaded (no networkidle0) porque SSE mantiene conexión abierta permanente
    await page.goto("http://localhost:" + PORT + "/?theme=dark&nosse=1", { waitUntil: "domcontentloaded", timeout: 15000 });
    // Esperar 1s para que CSS/JS inicialicen
    await new Promise(r => setTimeout(r, 1000));
    const buf = await page.screenshot({ type: "png", fullPage: false });
    return buf;
  } finally {
    await page.close();
  }
}

// --- SSE Broadcaster ---
function broadcastSSE() {
  const data = collectData();
  const msg = JSON.stringify({ reload: true, ts: data.timestamp });
  for (const client of sseClients) {
    if (client.alive) {
      try { client.res.write("data: " + msg + "\n\n"); } catch { client.alive = false; sseClients.delete(client); }
    }
  }
}

// --- Auto-stop check ---
function checkAutoStop() {
  const data = collectData();
  if (data.activeSessions === 0 && data.idleSessions === 0) {
    const elapsed = Date.now() - lastActivityTs;
    if (elapsed > AUTO_STOP_MS) {
      console.log("[dashboard-server] Auto-stop: sin sesiones activas por " + Math.round(elapsed / 60000) + " min");
      cleanup();
      process.exit(0);
    }
  }
}

// --- PID file management ---
function writePid() {
  const dir = path.dirname(PID_FILE);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  fs.writeFileSync(PID_FILE, String(process.pid), "utf8");
}

function cleanup() {
  try { fs.unlinkSync(PID_FILE); } catch {}
  if (puppeteerBrowser) { try { puppeteerBrowser.close(); } catch {} }
}

// --- Telegram Heartbeat Reporter (integrado en el server) ---
const TG_CONFIG = (() => {
  try { return JSON.parse(fs.readFileSync(TG_CONFIG_FILE, "utf8")); }
  catch { return { bot_token: "", chat_id: "", task_report_interval_min: 10 }; }
})();
const REPORT_INTERVAL_MIN = parseInt(TG_CONFIG.task_report_interval_min, 10) || 10;

function sendTelegramText(text, silent) {
  if (!TG_CONFIG.bot_token || !TG_CONFIG.chat_id) {
    console.log("[heartbeat] Sin config Telegram, ignorando");
    return;
  }
  const https = require("https");
  const params = JSON.stringify({
    chat_id: TG_CONFIG.chat_id, text, parse_mode: "HTML",
    disable_web_page_preview: true, disable_notification: !!silent
  });
  const req = https.request({
    hostname: "api.telegram.org",
    path: "/bot" + TG_CONFIG.bot_token + "/sendMessage",
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(params) },
    timeout: 10000
  }, (res) => {
    let body = "";
    res.on("data", (c) => body += c);
    res.on("end", () => {
      try {
        const r = JSON.parse(body);
        if (r.ok) console.log("[heartbeat] Telegram OK msg_id=" + r.result.message_id);
        else console.log("[heartbeat] Telegram error: " + body.substring(0, 200));
      } catch { console.log("[heartbeat] Telegram respuesta no-JSON: " + body.substring(0, 200)); }
    });
  });
  req.on("error", (e) => console.log("[heartbeat] Telegram req error: " + e.message));
  req.write(params);
  req.end();
}

function sendTelegramPhoto(photoBuffer, caption, silent) {
  if (!TG_CONFIG.bot_token || !TG_CONFIG.chat_id) return Promise.resolve(null);
  const https = require("https");
  return new Promise((resolve, reject) => {
    const boundary = "----FormBoundary" + Date.now().toString(36);
    let body = "";
    body += "--" + boundary + "\r\nContent-Disposition: form-data; name=\"chat_id\"\r\n\r\n" + TG_CONFIG.chat_id + "\r\n";
    if (caption) {
      body += "--" + boundary + "\r\nContent-Disposition: form-data; name=\"caption\"\r\n\r\n" + caption + "\r\n";
      body += "--" + boundary + "\r\nContent-Disposition: form-data; name=\"parse_mode\"\r\n\r\n" + "HTML" + "\r\n";
    }
    if (silent) {
      body += "--" + boundary + "\r\nContent-Disposition: form-data; name=\"disable_notification\"\r\n\r\n" + "true" + "\r\n";
    }
    const pre = Buffer.from(body + "--" + boundary + "\r\nContent-Disposition: form-data; name=\"photo\"; filename=\"dashboard.png\"\r\nContent-Type: image/png\r\n\r\n");
    const post = Buffer.from("\r\n--" + boundary + "--\r\n");
    const payload = Buffer.concat([pre, photoBuffer, post]);
    const req = https.request({
      hostname: "api.telegram.org",
      path: "/bot" + TG_CONFIG.bot_token + "/sendPhoto",
      method: "POST",
      headers: { "Content-Type": "multipart/form-data; boundary=" + boundary, "Content-Length": payload.length },
      timeout: 15000
    }, (res) => {
      let d = "";
      res.on("data", (c) => d += c);
      res.on("end", () => {
        try {
          const r = JSON.parse(d);
          if (r.ok) { console.log("[heartbeat] Foto OK msg_id=" + r.result.message_id); resolve(r); }
          else { console.log("[heartbeat] Foto error: " + d.substring(0, 200)); reject(new Error(d)); }
        } catch(e) { reject(e); }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", (e) => reject(e));
    req.write(payload);
    req.end();
  });
}

async function sendHeartbeat() {
  try {
    console.log("[heartbeat] Generando heartbeat...");
    const data = collectData();
    console.log("[heartbeat] Sessions: active=" + data.activeSessions + " idle=" + data.idleSessions);
    const caption = "\ud83d\udc9a <b>Intrale Monitor \u2014 Heartbeat</b>\n" +
      new Date().toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" });

    // Intentar screenshot del dashboard
    try {
      const screenshot = await takeScreenshot(600, 800);
      if (screenshot && screenshot.length > 1000) {
        await sendTelegramPhoto(screenshot, caption, true);
        console.log("[heartbeat] Screenshot enviado OK");
        return;
      }
    } catch (e) {
      console.log("[heartbeat] Screenshot no disponible: " + e.message + " — fallback a texto");
    }

    // Fallback: texto resumido
    const text = caption + "\n\n" +
      "\u25cf Agentes: <b>" + data.activeSessions + "</b> activos" + (data.idleSessions > 0 ? ", " + data.idleSessions + " idle" : "") + "\n" +
      "\u25cf Tareas: <b>" + data.completedTasks + "/" + data.totalTasks + "</b> completadas\n" +
      "\u25cf CI: <b>" + (data.ciStatus === "ok" ? "\u2705 OK" : data.ciStatus === "fail" ? "\u274c FAIL" : data.ciStatus) + "</b>\n" +
      "\u25cf Acciones: <b>" + data.totalActions + "</b> (" + (data.velocity[0] || 0) + "/h)\n" +
      (data.alerts.length > 0 ? "\u25cf \u26a0\ufe0f <b>" + data.alerts.length + " alerta(s)</b>\n" : "");
    sendTelegramText(text, true);
  } catch (e) {
    console.log("[heartbeat] Error: " + e.message);
  }
}

// --- Start server ---
const server = http.createServer(handleRequest);

server.listen(PORT, () => {
  console.log("[dashboard-server] Escuchando en http://localhost:" + PORT);
  writePid();

  // SSE broadcast every 5s
  setInterval(broadcastSSE, SSE_INTERVAL_MS);

  // Auto-stop check every 5 min
  setInterval(checkAutoStop, 5 * 60 * 1000);

  // Telegram heartbeat every N min
  if (TG_CONFIG.bot_token && REPORT_INTERVAL_MIN > 0) {
    console.log("[dashboard-server] Heartbeat Telegram cada " + REPORT_INTERVAL_MIN + " min");
    // Primer heartbeat inmediato (con delay de 5s para que collectData tenga datos)
    setTimeout(sendHeartbeat, 5000);
    setInterval(sendHeartbeat, REPORT_INTERVAL_MIN * 60 * 1000);
  } else {
    console.log("[dashboard-server] Heartbeat desactivado (bot_token=" + !!TG_CONFIG.bot_token + " interval=" + REPORT_INTERVAL_MIN + ")");
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.log("[dashboard-server] Puerto " + PORT + " ya en uso, otro servidor corriendo.");
    process.exit(0);
  }
  console.error("[dashboard-server] Error:", err.message);
  process.exit(1);
});

// Graceful shutdown
process.on("SIGTERM", () => { cleanup(); process.exit(0); });
process.on("SIGINT", () => { cleanup(); process.exit(0); });
process.on("exit", cleanup);

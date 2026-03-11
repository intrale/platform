#!/usr/bin/env node
// Dashboard Monitor Web v3 — Servidor HTTP + SSE + Screenshot + API
// Rediseño #1225: Ejecución unificada, grafo de flujo, feed chat, métricas Claude
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

// Permission severity classifier
let classifySeverity;
try {
  const permUtils = require(path.resolve(__dirname, "hooks", "permission-utils.js"));
  classifySeverity = permUtils.classifySeverity;
} catch { classifySeverity = null; }

// --- Config ---
// Resolver REPO_ROOT al repo principal (no al worktree) — igual que activity-logger.js
function resolveMainRepoRoot() {
  const candidate = path.resolve(__dirname, "..");
  try {
    const gitCommon = execSync("git rev-parse --git-common-dir", {
      cwd: candidate, timeout: 3000, windowsHide: true,
    }).toString().trim().replace(/\\/g, "/");
    // Si retorna ".git" → estamos en el repo principal
    if (gitCommon === ".git") return candidate;
    // Si retorna ruta absoluta (ej: /c/Workspaces/Intrale/platform/.git/worktrees/...)
    const gitIdx = gitCommon.indexOf("/.git");
    if (gitIdx !== -1) return gitCommon.substring(0, gitIdx);
    return path.resolve(gitCommon, "..");
  } catch (e) { return candidate; }
}
const REPO_ROOT = resolveMainRepoRoot();
const CLAUDE_DIR = path.join(REPO_ROOT, ".claude");
const SESSIONS_DIR = path.join(CLAUDE_DIR, "sessions");
const LOG_FILE = path.join(CLAUDE_DIR, "activity-log.jsonl");
const PID_FILE = path.join(CLAUDE_DIR, "hooks", "dashboard-server.pid");
const TG_CONFIG_FILE = path.join(CLAUDE_DIR, "hooks", "telegram-config.json");
const SERVER_LOG_FILE = path.join(CLAUDE_DIR, "hooks", "hook-debug.log");
const SPRINT_PLAN_FILE = path.join(REPO_ROOT, "scripts", "sprint-plan.json");
const ROADMAP_FILE = path.join(REPO_ROOT, "scripts", "roadmap.json");
const AGENT_METRICS_FILE = path.join(CLAUDE_DIR, "hooks", "agent-metrics.json");
const ICONS_DIR = path.join(CLAUDE_DIR, "icons");

// --- Load agent icons as base64 data URIs (once at startup) ---
function loadIconDataUri(filename) {
  try {
    const filePath = path.join(ICONS_DIR, filename);
    const buf = fs.readFileSync(filePath);
    const ext = path.extname(filename).toLowerCase();
    const mime = ext === ".svg" ? "image/svg+xml" : "image/png";
    return "data:" + mime + ";base64," + buf.toString("base64");
  } catch { return ""; }
}

const AGENT_ICON_MAP = {
  "Guru": loadIconDataUri("guru.png"),
  "Doc": loadIconDataUri("doc.png"),
  "Doc (historia)": loadIconDataUri("doc.png"),
  "Doc (refinar)": loadIconDataUri("doc.png"),
  "Doc (priorizar)": loadIconDataUri("doc.png"),
  "Planner": loadIconDataUri("planner.png"),
  "DeliveryManager": loadIconDataUri("delivery.png"),
  "Tester": loadIconDataUri("tester.png"),
  "Monitor": loadIconDataUri("monitor.png"),
  "Builder": loadIconDataUri("builder.png"),
  "Review": loadIconDataUri("review.png"),
  "QA": loadIconDataUri("qa.png"),
  "Auth": loadIconDataUri("auth.png"),
  "UX Specialist": loadIconDataUri("ux.png"),
  "Scrum Master": loadIconDataUri("scrum.png"),
  "PO": loadIconDataUri("po.png"),
  "BackendDev": loadIconDataUri("backend.png"),
  "AndroidDev": loadIconDataUri("android.png"),
  "iOSDev": loadIconDataUri("ios.png"),
  "WebDev": loadIconDataUri("web.png"),
  "DesktopDev": loadIconDataUri("desktop.png"),
  "Ops": loadIconDataUri("ops.png"),
  "Branch": loadIconDataUri("branch.png"),
  "Security": loadIconDataUri("security.png"),
};
const CLAUDE_ICONS = [
  loadIconDataUri("claude-1.svg"),
  loadIconDataUri("claude-2.svg"),
  loadIconDataUri("claude-3.svg"),
  loadIconDataUri("claude-4.svg"),
].filter(Boolean);
if (CLAUDE_ICONS.length > 0) AGENT_ICON_MAP["Claude"] = CLAUDE_ICONS[0];

// Skill-name → canonical agent name mapping
const SKILL_TO_AGENT = {
  "/guru": "Guru", "/doc": "Doc", "/historia": "Doc", "/refinar": "Doc", "/priorizar": "Doc",
  "/planner": "Planner", "/delivery": "DeliveryManager", "/tester": "Tester",
  "/monitor": "Monitor", "/builder": "Builder", "/review": "Review", "/qa": "QA",
  "/auth": "Auth", "/ux": "UX Specialist", "/scrum": "Scrum Master", "/po": "PO",
  "/backend-dev": "BackendDev", "/android-dev": "AndroidDev", "/ios-dev": "iOSDev",
  "/web-dev": "WebDev", "/desktop-dev": "DesktopDev", "/ops": "Ops", "/branch": "Branch",
  "/security": "Security",
};
// Case-insensitive lookup for AGENT_ICON_MAP
const _ICON_MAP_LC = {};
for (const k of Object.keys(AGENT_ICON_MAP)) _ICON_MAP_LC[k.toLowerCase()] = AGENT_ICON_MAP[k];

function resolveIconUri(name) {
  if (AGENT_ICON_MAP[name]) return AGENT_ICON_MAP[name];
  const lc = (name || "").toLowerCase();
  const mapped = SKILL_TO_AGENT[lc] || SKILL_TO_AGENT["/" + lc];
  if (mapped && AGENT_ICON_MAP[mapped]) return AGENT_ICON_MAP[mapped];
  if (_ICON_MAP_LC[lc]) return _ICON_MAP_LC[lc];
  // Generic/unknown → rotate among Claude variants
  if (CLAUDE_ICONS.length > 0) {
    let hash = 0;
    for (let i = 0; i < (name || "").length; i++) hash = ((hash << 5) - hash + (name || "").charCodeAt(i)) | 0;
    return CLAUDE_ICONS[Math.abs(hash) % CLAUDE_ICONS.length];
  }
  return AGENT_ICON_MAP["Claude"] || "";
}

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
const FEED_LIMIT = 15;
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
// Freshness: mtime del sprint-plan.json — si cambia, invalida el cache aunque no expire el TTL (#1417)
let sprintPlanMtime = 0;
// Watcher mtime: para broadcast SSE inmediato al detectar cambio en sprint-plan.json (#1434)
// Se inicializa con el valor actual al arrancar para no hacer un broadcast espurio en el primer tick.
let sprintPlanWatchMtime = (() => { try { return fs.statSync(SPRINT_PLAN_FILE).mtimeMs; } catch { return 0; } })();

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

function formatIssueLink(issueNumber) {
  if (!issueNumber || isNaN(Number(issueNumber))) return "";
  const num = Number(issueNumber);
  const url = `https://github.com/intrale/platform/issues/${num}`;
  const displayText = `#${num}`;
  return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="issue-link">${escHtml(displayText)}</a>`;
}

// --- Data Collection ---
function collectData() {
  const now = Date.now();
  // Invalidar cache si sprint-plan.json cambió (mtime-based freshness, #1417)
  let currentSprintPlanMtime = 0;
  try { currentSprintPlanMtime = fs.statSync(SPRINT_PLAN_FILE).mtimeMs; } catch {}
  const sprintPlanUnchanged = currentSprintPlanMtime === sprintPlanMtime;
  if (cachedData && (now - cachedDataTs) < DATA_CACHE_MS && sprintPlanUnchanged) return cachedData;
  sprintPlanMtime = currentSprintPlanMtime;

  // Sprint plan (leído antes para decidir qué sesiones retener)
  let sprintPlan = null;
  try { sprintPlan = readJson(SPRINT_PLAN_FILE); } catch {}
  // sprintIssueSet incluye TODOS los issues del sprint (agentes + _queue + _completed)
  // para retener sesiones activas y evitar que se clasifiquen como zombie.
  const sprintIssueSet = new Set(
    sprintPlan ? [
      ...(Array.isArray(sprintPlan.agentes) ? sprintPlan.agentes : []),
      ...(Array.isArray(sprintPlan._queue) ? sprintPlan._queue : []),
      ...(Array.isArray(sprintPlan._completed) ? sprintPlan._completed : []),
    ].map(a => String(a.issue)) : []
  );

  // Sessions
  // Solo mostrar sesiones active y stale (no done).
  // - active: con actividad reciente (incluyendo sprint sessions que pueden compilar largos)
  // - stale: sin actividad >2h, marcadas por activity-logger.js
  // - done: excluidas — el session-gc.js las limpia después de 1h
  const ZOMBIE_THRESHOLD_MS = 30 * 60 * 1000;
  const sessions = [];
  try {
    if (fs.existsSync(SESSIONS_DIR)) {
      const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json"));
      for (const f of files) {
        const s = readJson(path.join(SESSIONS_DIR, f));
        if (!s) continue;
        // Solo sesiones parent (ignorar sub-agentes)
        if (s.type && s.type !== "parent") continue;
        // Excluir sesiones done — ya terminaron, el GC las limpiará
        if (s.status === "done") continue;
        const status = getSessionStatus(s);
        const elapsed = now - new Date(s.last_activity_ts).getTime();
        const issueMatch = (s.branch || "").match(/^(?:agent|feature|bugfix)\/(\d+)/);
        const isSprintSession = issueMatch && sprintIssueSet.has(issueMatch[1]);
        if (!isSprintSession) {
          // Zombie: status active pero sin actividad >30min → omitir (stale se muestra igual)
          if (s.status === "active" && elapsed > ZOMBIE_THRESHOLD_MS) continue;
        }
        // Sprint sessions activas: nunca se descartan por edad (agentes pueden compilar largos)
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
          try { activities.push(JSON.parse(line)); } catch {}
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

  // CI status via gh
  let ciRuns = [];
  try {
    const ghPath = "/c/Workspaces/gh-cli/bin/gh.exe";
    if (fs.existsSync(ghPath.replace(/\//g, "\\"))) {
      const raw = execSync(ghPath + ' run list --limit 5 --json status,conclusion,headBranch,displayTitle,createdAt,databaseId', { cwd: REPO_ROOT, timeout: 10000, windowsHide: true }).toString().trim();
      ciRuns = JSON.parse(raw || "[]");
    }
  } catch {}

  // Sprint plan (ya leído arriba)

  // Agent metrics history (#1226)
  let agentMetrics = null;
  try { agentMetrics = readJson(AGENT_METRICS_FILE); } catch {}

  // Pending questions (all + pending-only for blocking)
  let allQuestions = [];
  let pendingQuestions = [];
  try {
    const pq = readJson(PENDING_QUESTIONS_FILE);
    if (pq && Array.isArray(pq.questions)) {
      allQuestions = pq.questions;
      pendingQuestions = pq.questions.filter(q => q.status === "pending");
    }
  } catch {}

  // Approval history (pattern stats)
  let approvalHistory = {};
  try {
    const ah = readJson(APPROVAL_HISTORY_FILE);
    if (ah && ah.patterns) approvalHistory = ah.patterns;
  } catch {}

  // Permission stats
  const permissionStats = { auto: 0, approved: 0, denied: 0, pending: 0 };
  for (const q of allQuestions) {
    if (q.status === "pending") permissionStats.pending++;
    else if (q.answered_via === "auto" || q.answered_via === "auto_allow" || q.answered_via === "fast_path") permissionStats.auto++;
    else if (q.action_result === "deny" || q.action_result === "deny_once" || q.action_result === "deny_always") permissionStats.denied++;
    else permissionStats.approved++;
  }
  // Blocking relations (build pid→session map first, used by enrichment too)
  const pidToSession = {};
  for (const s of sessions) {
    if (s.pid) pidToSession[s.pid] = s;
  }

  // Enrich questions with agent, issue, severity
  for (const q of allQuestions) {
    const html = q.original_html || "";
    // Try parse from original_html (format with robot emoji: "🤖 AgentName (#issue)  ·  🔀 branch")
    const agentHtmlMatch = html.match(/\u{1F916}\s*([^(\u00B7\n]+)/u);
    const issueHtmlMatch = html.match(/#(\d+)/);
    // Fallback: cross-reference approver_pid with sessions
    const linkedSession = q.approver_pid ? pidToSession[q.approver_pid] : null;
    const sessionAgent = linkedSession ? (linkedSession.agent_name || null) : null;
    const sessionBranch = linkedSession ? (linkedSession.branch || "") : "";
    const branchIssueMatch = sessionBranch.match(/^(?:agent|feature|bugfix)\/(\d+)/);

    q._agent = (agentHtmlMatch ? agentHtmlMatch[1].trim() : null) || sessionAgent || (q.action_data && q.action_data.agent) || null;
    q._issue = (issueHtmlMatch ? issueHtmlMatch[1] : null) || (branchIssueMatch ? branchIssueMatch[1] : null);
    // Severity
    if (classifySeverity && q.action_data) {
      try {
        q._severity = classifySeverity(q.action_data.tool_name, q.action_data.tool_input || {}, REPO_ROOT);
      } catch { q._severity = null; }
    }
  }
  // Recent permissions (last 10, most recent first)
  const recentPermissions = allQuestions.slice(-10).reverse();
  const blockingRelations = [];
  for (const q of pendingQuestions) {
    if (q.approver_pid && pidToSession[q.approver_pid]) {
      const blockedSession = pidToSession[q.approver_pid];
      blockingRelations.push({
        blockedAgent: blockedSession.agent_name || "Agente (" + blockedSession.id + ")",
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
        allTasks.push({ ...t, _session: s.id, _agent: s.agent_name || "Agente" });
      }
    }
  }
  const completedTasks = allTasks.filter(t => t.status === "completed");
  const inProgressTasks = allTasks.filter(t => t.status === "in_progress");
  const pendingTasks = allTasks.filter(t => t.status === "pending");
  const totalActions = sessions.reduce((sum, s) => sum + (s.action_count || 0), 0);
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

  // Classify sessions into execution categories
  // Todas las sesiones en `sessions` ya pasaron el filtro zombie (30min).
  // No descartar stale aquí: ○ (stale 15-30min) debe ser visible en EJECUCIÓN.
  const sprintSessions = [];
  const standaloneSessions = [];
  const adhocSessions = [];
  for (const s of sessions) {
    const issueMatch = (s.branch || "").match(/^(?:agent|feature|bugfix)\/(\d+)/);
    const issueNum = issueMatch ? issueMatch[1] : null;
    const isSprintSession = issueNum && sprintIssueSet.has(issueNum);
    if (isSprintSession) {
      sprintSessions.push(s);
    } else if (issueNum) {
      standaloneSessions.push(s);
    } else {
      adhocSessions.push(s);
    }
  }

  // Aggregate agent transitions from all sessions for flow graph
  const agentTransitions = [];
  const agentNodes = new Set();
  for (const s of sessions) {
    if (Array.isArray(s.agent_transitions)) {
      for (const t of s.agent_transitions) {
        agentTransitions.push({ ...t, _session: s.id });
        agentNodes.add(t.from);
        agentNodes.add(t.to);
      }
    }
    // Also add agents from skills_invoked
    if (Array.isArray(s.skills_invoked)) {
      for (const sk of s.skills_invoked) {
        const mapped = AGENT_MAP_DASHBOARD[sk] || sk.replace(/^\//, "");
        agentNodes.add(mapped);
      }
    }
    // Add session agent itself
    if (s.agent_name) agentNodes.add(s.agent_name);
  }

  // Active time
  const totalActiveTime = sessions.reduce((sum, s) => {
    if (!s.started_ts || !s.last_activity_ts) return sum;
    return sum + (new Date(s.last_activity_ts).getTime() - new Date(s.started_ts).getTime());
  }, 0);

  // Skill/agent usage stats (from ALL session files, not just recent)
  const skillUsage = {};
  try {
    const allFiles = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json"));
    for (const f of allFiles) {
      const s = readJson(path.join(SESSIONS_DIR, f));
      if (!s || !s.skills_invoked) continue;
      for (const sk of s.skills_invoked) {
        const name = sk.replace(/^\//, "");
        if (!skillUsage[name]) skillUsage[name] = { count: 0, lastUsed: null };
        skillUsage[name].count++;
        const ts = s.last_activity_ts || s.started_ts;
        if (ts && (!skillUsage[name].lastUsed || ts > skillUsage[name].lastUsed)) {
          skillUsage[name].lastUsed = ts;
        }
      }
    }
  } catch {}

  // Group activities for feed (collapse consecutive same-agent same-tool)
  const groupedActivities = groupActivities(activities.slice(-RECENT_ACTIVITY_COUNT * 2).reverse(), FEED_LIMIT);

  // Roadmap macro (#1382)
  let roadmap = null;
  try { roadmap = readJson(ROADMAP_FILE); } catch {}

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
    groupedActivities,
    velocity,
    branch,
    lastCommits,
    allTasks,
    pendingQuestions,
    allQuestions,
    approvalHistory,
    permissionStats,
    recentPermissions,
    blockingRelations,
    sprintPlan,
    sprintSessions,
    standaloneSessions,
    adhocSessions,
    agentTransitions,
    agentNodes: Array.from(agentNodes),
    skillUsage,
    agentMetrics,
    roadmap,
    metrics: {
      totalActions,
      totalActiveTimeMs: totalActiveTime,
    },
  };

  cachedData = data;
  cachedDataTs = now;
  etag = String(now);
  return data;
}

// Agent map for dashboard (matches activity-logger.js)
const AGENT_MAP_DASHBOARD = {
  "/guru": "Guru", "/planner": "Planner", "/doc": "Doc",
  "/delivery": "DeliveryManager", "/tester": "Tester", "/monitor": "Monitor",
  "/auth": "Auth", "/refinar": "Doc", "/priorizar": "Doc",
  "/historia": "Doc", "/builder": "Builder", "/review": "Review",
  "/qa": "QA", "/po": "PO", "/ux": "UX Specialist",
  "/scrum": "Scrum Master", "/ops": "Ops",
  "/backend-dev": "BackendDev", "/android-dev": "AndroidDev",
  "/ios-dev": "iOSDev", "/web-dev": "WebDev", "/desktop-dev": "DesktopDev",
  "/branch": "Branch",
};

function groupActivities(activities, limit) {
  if (activities.length === 0) return [];
  const groups = [];
  let current = null;
  for (const a of activities) {
    if (current && current.session === a.session && current.tool === a.tool &&
        groups.length < limit * 2) {
      current.count++;
      current.targets.push(a.target || "");
      current.lastTs = a.ts;
    } else {
      if (current) groups.push(current);
      current = { ...a, count: 1, targets: [a.target || ""], lastTs: a.ts, firstTs: a.ts };
    }
  }
  if (current) groups.push(current);
  return groups.slice(0, limit);
}

// Formatear estado de espera para HTML/texto
function formatWaitingBadge(waitingState) {
  if (!waitingState) return null;
  const icons = { ci: "⏳", merge: "⏳", merge_pending: "⏳", build: "🔨", delivery: "⏳", approval: "⏳" };
  const statusIcons = { success: "✅", failure: "❌", timeout: "⚠️", starting: "⏳", in_progress: "⏳", no_runs: "❓" };
  const icon = waitingState.status === "success" ? "✅"
    : waitingState.status === "failure" ? "❌"
    : waitingState.status === "timeout" ? "⚠️"
    : (icons[waitingState.reason] || "⏳");
  const elapsed = waitingState.started_at
    ? formatAge(waitingState.started_at)
    : null;
  const detail = (waitingState.detail || "Esperando...").replace(/\n/g, " ");
  return { icon, detail, elapsed, run_url: waitingState.run_url || null, status: waitingState.status };
}

function computeVelocity(activities) {
  const now = Date.now();
  const buckets = Array(6).fill(0);
  for (const a of activities) {
    const ts = new Date(a.ts).getTime();
    const hoursAgo = (now - ts) / (3600 * 1000);
    if (hoursAgo >= 0 && hoursAgo < 6) {
      buckets[Math.floor(hoursAgo)]++;
    }
  }
  return buckets;
}

// --- Mock Data for Testing ---
function mockEjecucionData() {
  const now = new Date().toISOString();
  const ago = (mins) => new Date(Date.now() - mins * 60000).toISOString();

  const mockSessions = [
    // Sprint agent - active, progressing
    { id: "mock-sprint-1", agent_name: "BackendDev", branch: "agent/1300-api-pedidos", pid: 1001,
      _status: "active", started_ts: ago(45), last_activity_ts: ago(1), action_count: 87,
      last_tool: "Edit", last_target: "backend/src/main/kotlin/Pedidos.kt",
      current_tasks: [
        { subject: "Crear endpoint POST /pedidos", status: "completed" },
        { subject: "Validar request con Konform", status: "completed" },
        { subject: "Integrar DynamoDB", status: "in_progress" },
        { subject: "Tests unitarios", status: "pending" },
      ],
      skills_invoked: ["/backend-dev", "/tester", "/guru"],
      agent_transitions: [{ from: "BackendDev", to: "Tester" }, { from: "BackendDev", to: "Guru" }, { from: "Tester", to: "BackendDev" }] },
    // Sprint agent - idle, waiting
    { id: "mock-sprint-2", agent_name: "AndroidDev", branch: "agent/1301-catalogo-ui", pid: 1002,
      _status: "idle", started_ts: ago(30), last_activity_ts: ago(8), action_count: 42,
      last_tool: "Bash", last_target: "gradlew :app:composeApp:installDebug",
      current_tasks: [
        { subject: "Pantalla CatalogoScreen", status: "completed" },
        { subject: "ViewModel con paginacion", status: "in_progress" },
        { subject: "Integracion Coil imagenes", status: "pending" },
      ],
      skills_invoked: ["/android-dev", "/builder", "/ux"],
      agent_transitions: [{ from: "AndroidDev", to: "Builder" }, { from: "AndroidDev", to: "UX Specialist" }] },
    // Sprint agent - done
    { id: "mock-sprint-3", agent_name: "Doc", branch: "agent/1302-docs-api", pid: 1003,
      _status: "done", started_ts: ago(60), last_activity_ts: ago(15), action_count: 23,
      last_tool: "Write", last_target: "docs/api-reference.md", status: "done",
      current_tasks: [
        { subject: "Documentar endpoints auth", status: "completed" },
        { subject: "Documentar endpoints pedidos", status: "completed" },
      ],
      skills_invoked: ["/doc", "/delivery"],
      agent_transitions: [{ from: "Doc", to: "DeliveryManager" }] },
    // Standalone issue - active
    { id: "mock-standalone-1", agent_name: "QA", branch: "agent/1310-qa-login", pid: 2001,
      _status: "active", started_ts: ago(20), last_activity_ts: ago(2), action_count: 35,
      last_tool: "Bash", last_target: "maestro test qa/flows/login.yaml",
      current_tasks: [
        { subject: "Flow login happy path", status: "completed" },
        { subject: "Flow login error cases", status: "in_progress" },
        { subject: "Generar evidencia video", status: "pending" },
      ],
      skills_invoked: ["/qa", "/android-dev"],
      agent_transitions: [{ from: "QA", to: "AndroidDev" }] },
    // Standalone issue - blocked
    { id: "mock-standalone-2", agent_name: "Planner", branch: "agent/1311-sprint-next", pid: 2002,
      _status: "active", started_ts: ago(10), last_activity_ts: ago(3), action_count: 12,
      last_tool: "Bash", last_target: "gh issue list --repo intrale/platform",
      current_tasks: [
        { subject: "Recolectar issues abiertos", status: "completed" },
        { subject: "Scoring y priorizacion", status: "in_progress" },
      ],
      skills_invoked: ["/planner", "/scrum", "/historia"],
      agent_transitions: [{ from: "Planner", to: "Scrum Master" }, { from: "Planner", to: "Doc" }] },
    // Ad-hoc session - active
    { id: "mock-adhoc-1", agent_name: "Claude", branch: "main", pid: 3001,
      _status: "active", started_ts: ago(5), last_activity_ts: ago(0), action_count: 8,
      last_tool: "Read", last_target: "CLAUDE.md",
      current_tasks: [], skills_invoked: [], agent_transitions: [] },
    // Ad-hoc session - idle
    { id: "mock-adhoc-2", agent_name: "Claude", branch: "main", pid: 3002,
      _status: "idle", started_ts: ago(25), last_activity_ts: ago(12), action_count: 15,
      last_tool: "Grep", last_target: "TODO",
      current_tasks: [], skills_invoked: [], agent_transitions: [] },
  ];

  const mockSprintPlan = {
    sprint_id: "SPR-013",
    estado: "activo",
    fecha: new Date().toISOString().split("T")[0],
    fechaInicio: new Date().toISOString().split("T")[0],
    fechaFin: new Date(Date.now() + 5 * 86400000).toISOString().split("T")[0],
    tema: "Sprint demo — todos los estados de ejecucion",
    agentes: [
      { numero: 1, issue: 1300, slug: "api-pedidos", titulo: "API REST de pedidos", stream: "A", size: "M" },
      { numero: 2, issue: 1301, slug: "catalogo-ui", titulo: "Pantalla catalogo con paginacion", stream: "B", size: "M" },
      { numero: 3, issue: 1302, slug: "docs-api", titulo: "Documentar API reference", stream: "E", size: "S" },
      { numero: 4, issue: 1303, slug: "refactor-di", titulo: "Refactor modulos Kodein", stream: "E", size: "L" },
    ],
  };

  const mockBlockingRelations = [
    {
      blockedAgent: "Planner",
      blockedSessionId: "mock-standalone-2",
      reason: "Esperando permiso",
      message: "Aprobar: gh issue create --title 'Nueva historia' --repo intrale/platform",
      waitingSince: ago(3),
      waitingMs: 3 * 60000,
    },
  ];

  // Classify
  const sprintIssues = mockSprintPlan.agentes.map(a => String(a.issue));
  const sprintSessions = [], standaloneSessions = [], adhocSessions = [];
  for (const s of mockSessions) {
    const issueMatch = (s.branch || "").match(/^(?:agent|feature|bugfix)\/(\d+)/);
    const issueNum = issueMatch ? issueMatch[1] : null;
    if (issueNum && sprintIssues.includes(issueNum)) sprintSessions.push(s);
    else if (issueNum) standaloneSessions.push(s);
    else adhocSessions.push(s);
  }

  const allTasks = [];
  for (const s of mockSessions) {
    if (Array.isArray(s.current_tasks)) {
      for (const t of s.current_tasks) allTasks.push({ ...t, _session: s.id, _agent: s.agent_name });
    }
  }

  return {
    timestamp: now,
    sessions: mockSessions,
    activeSessions: mockSessions.filter(s => s._status === "active").length,
    idleSessions: mockSessions.filter(s => s._status === "idle").length,
    totalTasks: allTasks.length,
    completedTasks: allTasks.filter(t => t.status === "completed").length,
    inProgressTasks: allTasks.filter(t => t.status === "in_progress").length,
    pendingTasks: allTasks.filter(t => t.status === "pending").length,
    totalActions: mockSessions.reduce((sum, s) => sum + (s.action_count || 0), 0),
    ciStatus: "ok",
    ciRuns: [{ status: "completed", conclusion: "success", headBranch: "main", displayTitle: "Build & Test", createdAt: ago(30) }],
    alerts: [
      { type: "info", message: "AndroidDev idle hace 8 min" },
    ],
    activities: [],
    groupedActivities: [
      { agent: "BackendDev", tool: "Edit", targets: ["Pedidos.kt", "PedidosRoute.kt", "PedidosService.kt"], count: 5, ts: ago(1), session: "mock-sprint-1" },
      { agent: "QA", tool: "Bash", targets: ["maestro test login.yaml"], count: 2, ts: ago(2), session: "mock-standalone-1" },
      { agent: "Planner", tool: "Bash", targets: ["gh issue list"], count: 1, ts: ago(3), session: "mock-standalone-2" },
      { agent: "AndroidDev", tool: "Read", targets: ["CatalogoScreen.kt", "CatalogoViewModel.kt"], count: 3, ts: ago(5), session: "mock-sprint-2" },
      { agent: "Doc", tool: "Write", targets: ["docs/api-reference.md"], count: 2, ts: ago(15), session: "mock-sprint-3" },
    ],
    velocity: [12, 18, 25, 30, 22, 15],
    branch: "main",
    lastCommits: [
      { hash: "abc1234", message: "feat: API pedidos endpoint", age: "1 hour ago", author: "Claude" },
      { hash: "def5678", message: "fix: catalogo scroll", age: "2 hours ago", author: "Claude" },
    ],
    allTasks,
    pendingQuestions: [
      { type: "permission", status: "pending", approver_pid: 2002, message: "Aprobar: gh issue create", timestamp: ago(3), action_data: { tool_name: "Bash" } },
    ],
    allQuestions: [
      { type: "permission", status: "answered", answered_via: "fast_path", message: "TaskCreate", timestamp: ago(2), action_data: { tool_name: "TaskCreate" } },
      { type: "permission", status: "answered", answered_via: "fast_path", message: "WebFetch", timestamp: ago(5), action_data: { tool_name: "WebFetch" } },
      { type: "permission", status: "answered", answered_via: "fast_path", message: "git push agent/...", timestamp: ago(8), action_data: { tool_name: "Bash" } },
      { type: "permission", status: "answered", answered_via: "telegram", action_result: "allow", message: "curl -X POST", timestamp: ago(12), action_data: { tool_name: "Bash" } },
      { type: "permission", status: "answered", answered_via: "telegram", action_result: "deny", message: "rm -rf /tmp/*", timestamp: ago(60), action_data: { tool_name: "Bash" } },
      { type: "permission", status: "pending", approver_pid: 2002, message: "gh issue create", timestamp: ago(3), action_data: { tool_name: "Bash" } },
    ],
    approvalHistory: {
      "Bash(node:*)": { count: 42, first: ago(120), last: ago(2) },
      "Edit(*)": { count: 38, first: ago(120), last: ago(1) },
      "WebFetch": { count: 15, first: ago(60), last: ago(5) },
      "Bash(export:*)": { count: 12, first: ago(90), last: ago(10) },
    },
    permissionStats: { auto: 3, approved: 1, denied: 1, pending: 1 },
    recentPermissions: [
      { type: "permission", status: "pending", message: "gh issue create", timestamp: ago(3), action_data: { tool_name: "Bash" }, _agent: "Planner", _issue: "1302", _severity: "MEDIUM" },
      { type: "permission", status: "answered", answered_via: "fast_path", message: "TaskCreate", timestamp: ago(2), action_data: { tool_name: "TaskCreate" }, _agent: "BackendDev", _issue: "1300", _severity: "AUTO_ALLOW" },
      { type: "permission", status: "answered", answered_via: "fast_path", message: "WebFetch context7", timestamp: ago(5), action_data: { tool_name: "WebFetch" }, _agent: "Guru", _issue: "1301", _severity: "LOW" },
      { type: "permission", status: "answered", answered_via: "fast_path", message: "git push agent/1300-api-pedidos", timestamp: ago(8), action_data: { tool_name: "Bash" }, _agent: "DeliveryManager", _issue: "1300", _severity: "MEDIUM" },
      { type: "permission", status: "answered", answered_via: "telegram", action_result: "allow", message: "curl -X POST https://api.example.com", timestamp: ago(12), action_data: { tool_name: "Bash" }, _agent: "BackendDev", _issue: "1300", _severity: "MEDIUM" },
      { type: "permission", status: "answered", answered_via: "telegram", action_result: "deny", message: "rm -rf /tmp/*", timestamp: ago(60), action_data: { tool_name: "Bash" }, _agent: "QA", _issue: "1303", _severity: "HIGH" },
    ],
    blockingRelations: mockBlockingRelations,
    sprintPlan: mockSprintPlan,
    sprintSessions,
    standaloneSessions,
    adhocSessions,
    agentTransitions: [
      // BackendDev invocó Tester para correr tests
      { from: "BackendDev", to: "Tester", _session: "mock-sprint-1" },
      // BackendDev invocó Guru para investigar DynamoDB
      { from: "BackendDev", to: "Guru", _session: "mock-sprint-1" },
      // AndroidDev invocó Builder para compilar
      { from: "AndroidDev", to: "Builder", _session: "mock-sprint-2" },
      // AndroidDev invocó UX Specialist para revisar layout
      { from: "AndroidDev", to: "UX Specialist", _session: "mock-sprint-2" },
      // Doc invocó DeliveryManager para commit+PR
      { from: "Doc", to: "DeliveryManager", _session: "mock-sprint-3" },
      // QA invocó AndroidDev para diagnosticar un flow roto
      { from: "QA", to: "AndroidDev", _session: "mock-standalone-1" },
      // Planner invocó Scrum Master para auditar el board
      { from: "Planner", to: "Scrum Master", _session: "mock-standalone-2" },
      // Planner invocó Doc para crear historia
      { from: "Planner", to: "Doc", _session: "mock-standalone-2" },
      // Claude (ad-hoc) invocó Guru
      { from: "Claude", to: "Guru", _session: "mock-adhoc-1" },
      // Claude invocó Ops para health check
      { from: "Claude", to: "Ops", _session: "mock-adhoc-1" },
      // Ciclo: Tester encontró fallo, volvió a BackendDev
      { from: "Tester", to: "BackendDev", _session: "mock-sprint-1" },
    ],
    agentNodes: ["BackendDev", "AndroidDev", "Doc", "QA", "Planner", "Claude",
                 "Tester", "Guru", "Builder", "UX Specialist", "DeliveryManager",
                 "Scrum Master", "Ops"],
    skillUsage: {
      delivery:     { count: 18, lastUsed: ago(15) },
      "backend-dev":{ count: 12, lastUsed: ago(1) },
      "android-dev":{ count: 10, lastUsed: ago(8) },
      guru:         { count: 9,  lastUsed: ago(2) },
      tester:       { count: 8,  lastUsed: ago(5) },
      branch:       { count: 7,  lastUsed: ago(20) },
      builder:      { count: 6,  lastUsed: ago(10) },
      doc:          { count: 5,  lastUsed: ago(60) },
      planner:      { count: 4,  lastUsed: ago(30) },
      qa:           { count: 3,  lastUsed: ago(45) },
      review:       { count: 3,  lastUsed: ago(120) },
      scrum:        { count: 2,  lastUsed: ago(90) },
      historia:     { count: 2,  lastUsed: ago(40) },
      monitor:      { count: 1,  lastUsed: ago(60) },
      ops:          { count: 1,  lastUsed: ago(180) },
      ux:           { count: 1,  lastUsed: ago(200) },
    },
    metrics: {
      totalActions: 222,
      totalActiveTimeMs: 45 * 60000,
    },
  };
}

// Helper: format a duration in ms to "Xm" or "Xh Ym"
function formatMinutes(ms) {
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return mins + 'm';
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? hrs + 'h ' + rem + 'm' : hrs + 'h';
}

// --- BUILD FLOW GRAPH SVG (force-directed organic layout) ---
function buildFlowTree(sessions, agentNodes, agentTransitions, AGENT_ICONS, AGENT_COLORS) {
  const nodes = Array.isArray(agentNodes) ? [...new Set(agentNodes)] : [];
  const transitions = Array.isArray(agentTransitions) ? agentTransitions : [];

  if (nodes.length === 0) {
    return '<div class="empty-state">Sin flujo de agentes registrado</div>';
  }

  // Determine active/done agents from sessions
  const activeAgents = new Set();
  const doneAgents = new Set();
  const sessionsList = Array.isArray(sessions) ? sessions : [];
  for (const s of sessionsList) {
    if (s.agent_name) {
      if (s._status === "active" || s.status === "active") activeAgents.add(s.agent_name);
      if (s._status === "done" || s.status === "done") doneAgents.add(s.agent_name);
    }
    if (Array.isArray(s.skills_invoked)) {
      for (const sk of s.skills_invoked) {
        const mapped = AGENT_MAP_DASHBOARD[sk] || sk.replace(/^\//, "");
        if (!activeAgents.has(mapped)) doneAgents.add(mapped);
      }
    }
  }

  // Build session map for quick lookup (used to resolve branch → issue number)
  const sessionMap = {};
  for (const s of sessionsList) {
    if (s.id) sessionMap[s.id] = s;
  }

  // Deduplicate edges, carrying issue + recency metadata
  const edgeList = [];
  const edgeSet = new Set();
  let edgeSeq = 0;
  const now = Date.now();
  for (const t of transitions) {
    const key = t.from + "->" + t.to;
    if (!edgeSet.has(key) && nodes.includes(t.from) && nodes.includes(t.to)) {
      edgeSet.add(key);
      edgeSeq++;
      // Resolve issue number from session branch (e.g. "agent/1394-foo" → "1394")
      const session = t._session ? (sessionMap[t._session] || null) : null;
      const branchMatch = session ? (session.branch || "").match(/(\d+)/) : null;
      const issueNum = branchMatch ? branchMatch[1] : null;
      // Recent = transition happened in the last 5 minutes
      const isRecent = t.ts ? (now - new Date(t.ts).getTime() < 5 * 60 * 1000) : false;
      edgeList.push({ from: t.from, to: t.to, seq: edgeSeq, issueNum, isRecent });
    }
  }

  // --- Force-directed layout (simplified, deterministic) ---
  const nodeR = 22;
  const svgW = 600;
  const svgH = 500;
  const cx = svgW / 2, cy = svgH / 2;

  // Initialize positions: spread nodes using golden angle for good distribution
  const positions = {};
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  nodes.forEach((name, i) => {
    const r = 70 + Math.sqrt(i) * 55;
    const angle = i * goldenAngle;
    positions[name] = {
      x: cx + r * Math.cos(angle),
      y: cy + r * Math.sin(angle),
    };
  });

  // Build adjacency
  const neighbors = {};
  for (const n of nodes) neighbors[n] = new Set();
  for (const e of edgeList) {
    neighbors[e.from].add(e.to);
    neighbors[e.to].add(e.from);
  }

  // Run force simulation (80 iterations for better convergence)
  const padding = nodeR + 24;
  for (let iter = 0; iter < 80; iter++) {
    const alpha = 0.3 * (1 - iter / 80);

    for (const a of nodes) {
      let fx = 0, fy = 0;
      const pa = positions[a];

      // Repulsion between all pairs (stronger to avoid clustering)
      for (const b of nodes) {
        if (a === b) continue;
        const pb = positions[b];
        let dx = pa.x - pb.x, dy = pa.y - pb.y;
        let dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 1) { dx = 0.5; dy = 0.3; dist = 1; }
        const repulse = 5000 / (dist * dist);
        fx += (dx / dist) * repulse;
        fy += (dy / dist) * repulse;
      }

      // Attraction along edges (larger ideal distance)
      for (const b of neighbors[a]) {
        const pb = positions[b];
        const dx = pb.x - pa.x, dy = pb.y - pa.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const ideal = 130;
        const attract = (dist - ideal) * 0.05;
        fx += (dx / Math.max(dist, 1)) * attract;
        fy += (dy / Math.max(dist, 1)) * attract;
      }

      // Gravity toward center (reduced to avoid clustering)
      fx += (cx - pa.x) * 0.002;
      fy += (cy - pa.y) * 0.002;

      pa.x += fx * alpha;
      pa.y += fy * alpha;

      // Keep within bounds
      pa.x = Math.max(padding, Math.min(svgW - padding, pa.x));
      pa.y = Math.max(padding, Math.min(svgH - padding, pa.y));
    }
  }

  // Post-layout: ensure minimum separation (2.5 × nodeR) between all nodes
  const minDist = nodeR * 2.5;
  for (let pass = 0; pass < 10; pass++) {
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const pa = positions[nodes[i]];
        const pb = positions[nodes[j]];
        let dx = pa.x - pb.x, dy = pa.y - pb.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < minDist && dist > 0) {
          const push = (minDist - dist) / 2;
          const ux = dx / dist, uy = dy / dist;
          pa.x = Math.max(padding, Math.min(svgW - padding, pa.x + ux * push));
          pa.y = Math.max(padding, Math.min(svgH - padding, pa.y + uy * push));
          pb.x = Math.max(padding, Math.min(svgW - padding, pb.x - ux * push));
          pb.y = Math.max(padding, Math.min(svgH - padding, pb.y - uy * push));
        }
      }
    }
  }

  // Build SVG
  let svg = `<defs>
    <marker id="flow-arrow" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
      <polygon points="0 0, 8 3, 0 6" fill="var(--text-muted)" opacity="0.6"/>
    </marker>
    <marker id="flow-arrow-recent" markerWidth="9" markerHeight="7" refX="8" refY="3.5" orient="auto">
      <polygon points="0 0, 9 3.5, 0 7" fill="#f59e0b" opacity="0.9"/>
    </marker>
    <filter id="node-glow"><feGaussianBlur stdDeviation="4" result="coloredBlur"/>
      <feMerge><feMergeNode in="coloredBlur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="icon-brighten" color-interpolation-filters="sRGB">
      <feComponentTransfer>
        <feFuncR type="linear" slope="1.5" intercept="0.2"/>
        <feFuncG type="linear" slope="1.5" intercept="0.2"/>
        <feFuncB type="linear" slope="1.5" intercept="0.2"/>
      </feComponentTransfer>
    </filter>
  </defs>`;

  // Draw edges as curved arrows with sequential labels and issue reference
  for (const e of edgeList) {
    const from = positions[e.from];
    const to = positions[e.to];
    if (!from || !to) continue;
    const dx = to.x - from.x, dy = to.y - from.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1) continue;
    const ux = dx / dist, uy = dy / dist;
    const x1 = from.x + ux * (nodeR + 4);
    const y1 = from.y + uy * (nodeR + 4);
    const x2 = to.x - ux * (nodeR + 8);
    const y2 = to.y - uy * (nodeR + 8);
    // Check if reverse edge exists → increase curve to avoid overlap
    const reverseKey = e.to + "->" + e.from;
    const curveMult = edgeSet.has(reverseKey) ? 0.25 : 0.12;
    const midX = (x1 + x2) / 2;
    const midY = (y1 + y2) / 2;
    const cpx = midX + (-(y2 - y1) * curveMult);
    const cpy = midY + ((x2 - x1) * curveMult);
    // Midpoint on the quadratic Bézier curve (t=0.5)
    const bMidX = 0.25 * x1 + 0.5 * cpx + 0.25 * x2;
    const bMidY = 0.25 * y1 + 0.5 * cpy + 0.25 * y2;

    const isRecent = e.isRecent;
    const strokeColor = isRecent ? "#f59e0b" : "var(--text-muted)";
    const strokeWidth = isRecent ? "3" : "1.5";
    const strokeOpacity = isRecent ? "0.85" : "0.45";
    const arrowMarker = isRecent ? "url(#flow-arrow-recent)" : "url(#flow-arrow)";

    svg += `<path d="M${x1.toFixed(1)},${y1.toFixed(1)} Q${cpx.toFixed(1)},${cpy.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}" fill="none" stroke="${strokeColor}" stroke-width="${strokeWidth}" stroke-opacity="${strokeOpacity}" marker-end="${arrowMarker}"/>`;

    // Label: sequential number + issue (if available)
    const label = e.issueNum ? `${e.seq} #${e.issueNum}` : `${e.seq}`;
    const labelBg = isRecent ? "rgba(245,158,11,0.18)" : "rgba(17,17,27,0.7)";
    const labelColor = isRecent ? "#fbbf24" : "var(--text-dim)";
    const labelW = e.issueNum ? 40 : 16;
    svg += `<rect x="${(bMidX - labelW / 2).toFixed(1)}" y="${(bMidY - 7).toFixed(1)}" width="${labelW}" height="13" rx="3" fill="${labelBg}"/>`;
    svg += `<text x="${bMidX.toFixed(1)}" y="${(bMidY + 4).toFixed(1)}" text-anchor="middle" font-size="7.5" font-weight="600" fill="${labelColor}" style="pointer-events:none;">${escHtml(label)}</text>`;
  }

  // Draw nodes
  const imgSize = nodeR * 1.4;
  let _claudeIdx = 0;
  for (const name of nodes) {
    const pos = positions[name];
    if (!pos) continue;
    const color = (AGENT_COLORS && AGENT_COLORS[name]) || "#6C7086";
    // Resolve icon data URI for SVG <image> — case/skill-insensitive
    const iconUrl = resolveIconUri(name);
    const isActive = activeAgents.has(name);
    const isDone = doneAgents.has(name);
    const opacity = (!isActive && !isDone) ? "0.35" : "1";
    const filterAttr = isActive ? 'filter="url(#node-glow)"' : '';

    svg += `<g class="flow-node" data-agent="${escHtml(name)}" style="cursor:pointer;opacity:${opacity};" ${filterAttr}>`;
    // Fondo más opaco para garantizar contraste del icono sobre fondo oscuro
    svg += `<circle cx="${pos.x.toFixed(1)}" cy="${pos.y.toFixed(1)}" r="${nodeR}" fill="rgba(255,255,255,0.10)" stroke="${color}" stroke-width="2.5"`;
    if (isActive) {
      svg += `><animate attributeName="stroke-opacity" values="1;0.4;1" dur="2s" repeatCount="indefinite"/></circle>`;
    } else {
      svg += `/>`;
    }
    // Círculo de color semitransparente detrás del icono para contraste
    svg += `<circle cx="${pos.x.toFixed(1)}" cy="${pos.y.toFixed(1)}" r="${(nodeR - 3).toFixed(1)}" fill="${color}" fill-opacity="0.30"/>`;
    // Icon: filter brighten para garantizar visibilidad sobre fondo oscuro
    if (iconUrl) {
      svg += `<image href="${iconUrl}" x="${(pos.x - imgSize / 2).toFixed(1)}" y="${(pos.y - imgSize / 2).toFixed(1)}" width="${imgSize.toFixed(0)}" height="${imgSize.toFixed(0)}" style="pointer-events:none;" filter="url(#icon-brighten)"/>`;
      if (isDone && !isActive) {
        svg += `<circle cx="${(pos.x + imgSize/2 - 2).toFixed(1)}" cy="${(pos.y - imgSize/2 + 2).toFixed(1)}" r="5" fill="${color}"/>`;
        svg += `<text x="${(pos.x + imgSize/2 - 2).toFixed(1)}" y="${(pos.y - imgSize/2 + 5).toFixed(1)}" text-anchor="middle" font-size="7" fill="white">&#10003;</text>`;
      }
    } else if (isDone && !isActive) {
      svg += `<text x="${pos.x.toFixed(1)}" y="${(pos.y + 5).toFixed(1)}" text-anchor="middle" font-size="16" fill="${color}">&#10003;</text>`;
    }
    // Label below node
    const shortName = name.length > 12 ? name.substring(0, 10) + "\u2026" : name;
    svg += `<text x="${pos.x.toFixed(1)}" y="${(pos.y + nodeR + 14).toFixed(1)}" text-anchor="middle" font-size="9" fill="var(--text-dim)" font-weight="600">${escHtml(shortName)}</text>`;
    svg += `</g>`;
  }

  return `<svg class="flow-graph-svg" viewBox="0 0 ${svgW} ${svgH}" preserveAspectRatio="xMidYMid meet" style="width:100%;max-height:${svgH}px;">${svg}</svg>`;
}

// --- BUILD GANTT CHART SVG (Roadmap macro #1382) ---
function buildGanttChart(roadmap) {
  if (!roadmap || !Array.isArray(roadmap.sprints) || roadmap.sprints.length === 0) {
    return '<div class="empty-state">Sin roadmap generado — ejecutar /scrum roadmap</div>';
  }

  const STREAM_COLORS = {
    A: "#f87171",   // Backend — rojo
    B: "#60a5fa",   // Cliente — azul
    C: "#fbbf24",   // Negocio — amarillo
    D: "#34d399",   // Delivery — verde
    E: "#a78bfa",   // Cross-cutting — violeta
  };
  const STREAM_LABELS = { A: "Backend", B: "Cliente", C: "Negocio", D: "Delivery", E: "Cross" };
  const STATUS_OPACITY = { done: 0.45, deferred: 0.25, blocked: 1, in_progress: 1, planned: 1 };

  const sprints = roadmap.sprints;
  const numSprints = sprints.length;

  // Collect all issues with sprint index
  const allIssues = [];
  for (let si = 0; si < sprints.length; si++) {
    const spr = sprints[si];
    for (const iss of (spr.issues || [])) {
      allIssues.push({ ...iss, _sprintIdx: si, _sprintId: spr.id });
    }
  }

  // Build issue index for dependency arrows
  const issueByNum = {};
  for (const iss of allIssues) issueByNum[iss.number] = iss;

  // Group by stream for Y axis
  const streams = ["E", "B", "C", "D", "A"];
  const streamGroups = {};
  for (const s of streams) streamGroups[s] = [];
  for (const iss of allIssues) {
    const s = iss.stream || "E";
    if (!streamGroups[s]) streamGroups[s] = [];
    streamGroups[s].push(iss);
  }

  // Layout constants (large for readability — scroll handles overflow)
  const colW = 220;           // width per sprint column
  const rowH = 44;            // height per issue row
  const barPad = 5;           // vertical padding inside row
  const labelColW = 100;      // left label column (stream names)
  const headerH = 72;         // top header for sprint labels
  const streamGap = 18;       // gap between stream groups
  const streamLabelH = 30;    // height of stream group header

  // Compute total height
  let totalY = headerH;
  const streamYMap = {}; // stream -> { y, issues }
  for (const s of streams) {
    const group = streamGroups[s];
    if (group.length === 0) continue;
    // Issues per row per sprint column — stack vertically within sprint
    // Count max issues per sprint for this stream
    const perSprint = {};
    for (const iss of group) {
      const si = iss._sprintIdx;
      if (!perSprint[si]) perSprint[si] = 0;
      perSprint[si]++;
    }
    const maxRows = Math.max(...Object.values(perSprint), 1);
    const groupH = streamLabelH + maxRows * rowH + streamGap;
    streamYMap[s] = { y: totalY, h: groupH, maxRows };
    totalY += groupH;
  }
  const svgH = Math.max(totalY + 10, 120);
  const svgW = labelColW + numSprints * colW + 20;

  let defs = `<defs>
    <marker id="gantt-arrow" markerWidth="6" markerHeight="5" refX="5" refY="2.5" orient="auto">
      <polygon points="0 0, 6 2.5, 0 5" fill="var(--text-muted)" opacity="0.7"/>
    </marker>`;

  // Hatch pattern for in_progress
  defs += `<pattern id="hatch-inprogress" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="6" stroke="rgba(255,255,255,0.35)" stroke-width="2"/>
    </pattern>`;
  defs += `</defs>`;

  let svg = defs;

  // --- Header: sprint columns ---
  // Background header
  svg += `<rect x="${labelColW}" y="0" width="${numSprints * colW}" height="${headerH}" fill="var(--surface-2,#1e2030)" rx="4"/>`;

  for (let si = 0; si < numSprints; si++) {
    const spr = sprints[si];
    const x = labelColW + si * colW;
    // Column separator
    svg += `<line x1="${x}" y1="0" x2="${x}" y2="${svgH}" stroke="var(--border)" stroke-width="0.5" stroke-opacity="0.4"/>`;
    // Sprint label (ID)
    svg += `<text x="${x + colW / 2}" y="24" text-anchor="middle" font-size="18" font-weight="700" fill="var(--white)" opacity="0.9">${escHtml(spr.id)}</text>`;
    // Date range
    const start = (spr.start || "").substring(5); // MM-DD
    const end = (spr.end || "").substring(5);
    svg += `<text x="${x + colW / 2}" y="44" text-anchor="middle" font-size="13" fill="var(--text-dim)">${escHtml(start)}→${escHtml(end)}</text>`;
    // Sprint tema (truncated)
    const tema = (spr.tema || "").substring(0, 30);
    svg += `<text x="${x + colW / 2}" y="62" text-anchor="middle" font-size="11" fill="var(--text-muted)" opacity="0.7">${escHtml(tema)}</text>`;
  }

  // --- Stream groups and bars ---
  const barPositions = {}; // issueNum -> { cx, cy } for arrow rendering

  for (const s of streams) {
    const group = streamGroups[s];
    if (group.length === 0) continue;
    const sm = streamYMap[s];
    const color = STREAM_COLORS[s] || "#888";

    // Stream label background
    svg += `<rect x="0" y="${sm.y}" width="${labelColW - 2}" height="${sm.h - streamGap}" fill="${color}" fill-opacity="0.12" rx="3"/>`;
    svg += `<text x="${(labelColW - 2) / 2}" y="${sm.y + streamLabelH - 6}" text-anchor="middle" font-size="15" font-weight="700" fill="${color}">${STREAM_LABELS[s] || s}</text>`;

    // Background stripe for stream area
    svg += `<rect x="${labelColW}" y="${sm.y}" width="${numSprints * colW}" height="${sm.h - streamGap}" fill="${color}" fill-opacity="0.04" rx="2"/>`;

    // Track row position per sprint for stacking
    const sprintRowCount = {};

    for (const iss of group) {
      const si = iss._sprintIdx;
      if (!sprintRowCount[si]) sprintRowCount[si] = 0;
      const rowInSprint = sprintRowCount[si]++;

      const barX = labelColW + si * colW + 3;
      const barY = sm.y + streamLabelH + rowInSprint * rowH + barPad;
      const barW = colW - 6;
      const barH = rowH - barPad * 2;
      const cx = barX + barW / 2;
      const cy = barY + barH / 2;
      barPositions[iss.number] = { cx, cy };

      const status = iss.status || "planned";
      const opacity = STATUS_OPACITY[status] !== undefined ? STATUS_OPACITY[status] : 1;
      const fillColor = status === "blocked" ? "#f87171" : color;

      // Main bar
      const issueUrl = `https://github.com/intrale/platform/issues/${iss.number}`;
      svg += `<g opacity="${opacity}">`;
      svg += `<a href="${issueUrl}" target="_blank" rel="noopener noreferrer" class="gantt-bar-link">`;
      svg += `<rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" fill="${fillColor}" fill-opacity="0.22" stroke="${fillColor}" stroke-width="1" rx="3" style="cursor:pointer;">`;
      svg += `<title>#${iss.number} ${iss.title}\nStream: ${s} | Size: ${iss.size || "M"} | Status: ${status}</title>`;
      svg += `</rect>`;

      // Hatch overlay for in_progress
      if (status === "in_progress") {
        svg += `<rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" fill="url(#hatch-inprogress)" rx="3" opacity="0.5" style="pointer-events:none;"/>`;
      }

      // Checkmark for done
      if (status === "done") {
        svg += `<text x="${barX + 7}" y="${barY + barH - 6}" font-size="16" fill="${fillColor}" opacity="0.9" style="pointer-events:none;">✓</text>`;
      }

      // Label: #NUM + title truncated
      const maxChars = Math.floor((barW - (status === "done" ? 26 : 8)) / 7.5);
      const title = iss.title.substring(0, maxChars);
      const labelX = barX + (status === "done" ? 26 : 8);
      svg += `<text x="${labelX}" y="${barY + barH - 7}" font-size="13" fill="var(--white)" font-weight="600" opacity="0.9" style="pointer-events:none">${escHtml(title)}</text>`;

      // Issue number chip
      svg += `<text x="${barX + 4}" y="${barY + 15}" font-size="12" fill="${fillColor}" font-weight="700" opacity="0.85" style="pointer-events:none;">#${iss.number}</text>`;

      svg += `</a>`;
      svg += `</g>`;
    }
  }

  // --- Dependency arrows (Bézier curves) ---
  const drawnArrows = new Set();
  for (const iss of allIssues) {
    const to = barPositions[iss.number];
    if (!to) continue;
    for (const depNum of (iss.depends_on || [])) {
      const from = barPositions[depNum];
      if (!from) continue;
      const arrowKey = `${depNum}->${iss.number}`;
      if (drawnArrows.has(arrowKey)) continue;
      drawnArrows.add(arrowKey);

      // Only draw if different sprint (same sprint deps are fine but arrows get cluttered)
      if (issueByNum[depNum] && issueByNum[depNum]._sprintIdx === iss._sprintIdx) continue;

      const x1 = from.cx + (colW / 2 - 4);
      const y1 = from.cy;
      const x2 = to.cx - (colW / 2 - 4);
      const y2 = to.cy;
      const midX = (x1 + x2) / 2;
      // Slight S-curve
      const cp1x = midX;
      const cp1y = y1;
      const cp2x = midX;
      const cp2y = y2;
      svg += `<path d="M${x1.toFixed(1)},${y1.toFixed(1)} C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}" fill="none" stroke="var(--text-muted)" stroke-width="1" stroke-opacity="0.5" stroke-dasharray="3,2" marker-end="url(#gantt-arrow)"/>`;
    }
  }

  // Legend
  const legendY = svgH - 16;
  let legendX = labelColW + 4;
  const legendStreams = streams.filter(s => streamGroups[s].length > 0);
  for (const s of legendStreams) {
    const color = STREAM_COLORS[s];
    svg += `<rect x="${legendX}" y="${legendY}" width="8" height="8" fill="${color}" rx="2"/>`;
    svg += `<text x="${legendX + 11}" y="${legendY + 7}" font-size="7.5" fill="var(--text-dim)">${STREAM_LABELS[s]}</text>`;
    legendX += 55;
  }

  const updatedLabel = roadmap.updated_ts ? roadmap.updated_ts.substring(0, 10) : "";
  svg += `<text x="${svgW - 4}" y="${legendY + 7}" text-anchor="end" font-size="7" fill="var(--text-muted)" opacity="0.6">actualizado ${updatedLabel}</text>`;

  const horizTotal = numSprints * colW + labelColW + 20;
  // Scrollable wrapper
  return `<div style="overflow-x:auto;-webkit-overflow-scrolling:touch;">
    <svg viewBox="0 0 ${horizTotal} ${svgH}" style="min-width:${Math.min(horizTotal, 900)}px;width:100%;max-height:${svgH}px;display:block;" preserveAspectRatio="xMinYMin meet">
      ${svg}
    </svg>
  </div>`;
}

// --- HTML Template ---
function renderHTML(data, theme) {
  const isDark = theme !== "light";
  const sprintProgress = data.totalTasks > 0
    ? Math.round((data.completedTasks / data.totalTasks) * 100) : 0;
  const completedDeg = Math.round((data.completedTasks / Math.max(data.totalTasks, 1)) * 360);
  const inProgressDeg = Math.round((data.inProgressTasks / Math.max(data.totalTasks, 1)) * 360);

  // Velocity sparkline SVG
  const velMax = Math.max(...data.velocity, 1);
  const velPoints = data.velocity.map((v, i) => {
    const x = 10 + i * (80 / 5);
    const y = 45 - (v / velMax) * 35;
    return `${x},${y}`;
  }).join(" ");

  // Agent icons — resolves any name (case/skill-insensitive) to <img> tag
  function agentIconHtml(name) {
    const uri = resolveIconUri(name);
    return uri
      ? '<img src="' + uri + '" width="16" height="16" style="vertical-align:middle;margin-right:2px;" alt="' + escHtml(name || "") + '">'
      : "&#129302;";
  }
  const AGENT_ICONS = {};
  for (const name of Object.keys(AGENT_ICON_MAP)) AGENT_ICONS[name] = agentIconHtml(name);
  for (const [skill, agent] of Object.entries(SKILL_TO_AGENT)) AGENT_ICONS[skill] = agentIconHtml(agent);

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
    "Branch": "linear-gradient(135deg, #65a30d, #84cc16)",
    "Claude": "linear-gradient(135deg, #555872, #6C7086)",
  };

  const AGENT_COLORS = {
    "Guru": "#818cf8", "Doc": "#a78bfa", "Planner": "#fbbf24",
    "DeliveryManager": "#34d399", "Tester": "#d946ef", "QA": "#d946ef",
    "Builder": "#fb923c", "Review": "#818cf8", "Monitor": "#22d3ee",
    "Auth": "#cbd5e1", "PO": "#38bdf8", "UX Specialist": "#f472b6",
    "Scrum Master": "#2dd4bf", "Ops": "#e7e5e4",
    "BackendDev": "#f87171", "AndroidDev": "#4ade80", "WebDev": "#60a5fa",
    "Branch": "#84cc16", "Claude": "#9399b2",
  };

  const STATUS_COLORS = { active: "#34d399", idle: "#fbbf24", done: "#6C7086", stale: "#555872" };
  const STATUS_LABELS = { active: "Activo", idle: "Idle", done: "Terminado", stale: "Stale" };

  const blockedPids = new Set(data.blockingRelations.map(b => b.blockedSessionId));

  // --- EJECUCIÓN PANEL ---
  let ejecutionHtml = "";

  // Sprint sub-view — combinar agentes + _queue + _completed para vista completa
  // Fuente de verdad: sprint-plan.json (agentes activos + cola + completados)
  const spAgentes = data.sprintPlan && Array.isArray(data.sprintPlan.agentes) ? data.sprintPlan.agentes : [];
  const spQueue = data.sprintPlan && Array.isArray(data.sprintPlan._queue) ? data.sprintPlan._queue : [];
  const spCompleted = data.sprintPlan && Array.isArray(data.sprintPlan._completed) ? data.sprintPlan._completed : [];
  const allSprintAgentes = [...spAgentes, ...spQueue, ...spCompleted];

  // Helper para renderizar una fila de agente del sprint
  function renderSprintAgentRow(ag, forcedStatus) {
    const matchSession = data.sprintSessions.find(s => {
      const issueMatch = (s.branch || "").match(/(\d+)/);
      return issueMatch && issueMatch[1] === String(ag.issue);
    });
    const agStatus = forcedStatus || (matchSession ? matchSession._status : "pending");
    const statusIcon = agStatus === "active" ? "&#9679;" : agStatus === "idle" ? "&#9684;" : agStatus === "done" ? "&#10003;" : agStatus === "stale" ? "&#9632;" : "&#9675;";
    const statusColor = STATUS_COLORS[agStatus] || "var(--text-muted)";
    const isBlocked = matchSession && blockedPids.has(matchSession.id);
    const tasks = matchSession ? (matchSession.current_tasks || []) : [];
    const tasksDone = tasks.filter(t => t.status === "completed").length;
    const actionCount = matchSession ? (matchSession.action_count || 0) : 0;
    let tasksPct;
    if (tasks.length > 0) {
      tasksPct = Math.round((tasksDone / tasks.length) * 100);
    } else if (agStatus === "done" || agStatus === "stale" || forcedStatus === "done") {
      tasksPct = 100;
    } else if (actionCount > 0) {
      const sizeExpected = { S: 40, M: 80, L: 160, XL: 300 };
      tasksPct = Math.min(90, Math.round((actionCount / (sizeExpected[ag.size] || 60)) * 100));
    } else {
      tasksPct = 0;
    }
    const barColor = (agStatus === "done" || forcedStatus === "done") ? "var(--gradient-green)"
      : isBlocked ? "linear-gradient(90deg, #ef4444, #f87171)" : statusColor;
    const waitingState = matchSession ? (matchSession.waiting_state || null) : null;
    const wb = waitingState ? formatWaitingBadge(waitingState) : null;
    const isWaiting = wb && (wb.status === "in_progress" || wb.status === "starting");
    const isFailed = wb && wb.status === "failure";
    const waitingBarColor = isWaiting ? "linear-gradient(90deg, #fbbf24, #f59e0b)"
      : isFailed ? "linear-gradient(90deg, #ef4444, #f87171)"
      : wb && wb.status === "success" ? "var(--gradient-green)" : barColor;
    const statusText = isBlocked ? "&#128721; Bloqueado"
      : wb ? (wb.icon + " " + escHtml(wb.detail) + (wb.elapsed ? " (" + wb.elapsed + ")" : ""))
      : forcedStatus === "pending" ? "En cola"
      : forcedStatus === "done" ? "Completado"
      : agStatus === "pending" ? "Pendiente"
      : agStatus === "done" && tasks.length === 0 ? "Completado"
      : agStatus === "stale" ? "&#128164; Inactivo · " + actionCount + " acciones"
      : tasks.length > 0 ? `${tasksDone}/${tasks.length} tareas · ${tasksPct}%`
      : `${actionCount} acciones · ${tasksPct}%`;
    const duration = matchSession ? formatDuration(matchSession.started_ts) : "";
    const safeRunUrl = wb && wb.run_url && /^https:\/\/github\.com\//.test(wb.run_url) ? wb.run_url : null;
    const ciLinkHtml = safeRunUrl
      ? ` <a href="${escHtml(safeRunUrl)}" target="_blank" rel="noopener noreferrer" style="color:#60a5fa;font-size:9px;">&#9654; CI</a>`
      : "";
    return `<div class="exec-row" style="flex-direction:column;gap:4px;padding:8px 10px;">
      <div style="display:flex;align-items:center;gap:8px;width:100%;">
        <span class="exec-issue" style="min-width:52px;">${formatIssueLink(ag.issue)}</span>
        <span class="exec-slug" style="flex:1;">${escHtml(ag.slug || "")}</span>
        <span class="exec-size chip chip-blue">${escHtml(ag.size || "?")}</span>
        <span style="color:${statusColor};font-size:14px;">${statusIcon}</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px;width:100%;">
        <div class="exec-bar" style="flex:1;height:6px;"><div class="exec-bar-fill" style="width:${tasksPct}%;background:${isWaiting ? waitingBarColor : barColor};${isWaiting ? 'animation:pulse 1.5s infinite alternate;' : ''}"></div></div>
        <span style="font-size:11px;color:${isWaiting ? '#fbbf24' : statusColor};min-width:32px;text-align:right;font-weight:600;">${tasksPct}%</span>
      </div>
      <div style="font-size:10px;color:${isWaiting ? '#fbbf24' : isFailed ? '#f87171' : 'var(--text-muted)'};">${statusText}${!wb && actionCount ? ' · ' + actionCount + ' acc' : ''}${duration ? ' · ' + duration : ''}${ciLinkHtml}</div>
    </div>`;
  }

  if (data.sprintPlan && allSprintAgentes.length > 0) {
    const spDate = data.sprintPlan.fecha || "";
    const sprintId = data.sprintPlan.sprint_id || null;
    const sprintEstado = (data.sprintPlan.estado || "activo").toLowerCase();
    const isFinalizado = sprintEstado === "finalizado";
    const agentesTotal = data.sprintPlan.total_stories || allSprintAgentes.length;
    const completedCount = spCompleted.length;

    // Progreso del sprint: completados / total_stories
    let sprintPct;
    const sprintTasksTotal = data.sprintSessions.reduce((sum, s) => sum + (s.current_tasks || []).length, 0);
    const sprintTasksDone = data.sprintSessions.reduce((sum, s) => sum + (s.current_tasks || []).filter(t => t.status === "completed").length, 0);
    if (sprintTasksTotal > 0) {
      sprintPct = Math.round((sprintTasksDone / sprintTasksTotal) * 100);
    } else {
      // Heurística: completados cuentan 100%, activos por action_count, cola en 0%
      const sizeExpected = { S: 40, M: 80, L: 160, XL: 300 };
      let totalPctSum = completedCount * 100;
      for (const ag of spAgentes) {
        const match = data.sprintSessions.find(s => {
          const m = (s.branch || "").match(/(\d+)/);
          return m && m[1] === String(ag.issue);
        });
        if (match && match.action_count > 0) {
          totalPctSum += Math.min(90, Math.round((match.action_count / (sizeExpected[ag.size] || 60)) * 100));
        }
      }
      sprintPct = agentesTotal > 0 ? Math.round(totalPctSum / agentesTotal) : 0;
    }

    const sprintLabelId = sprintId ? escHtml(sprintId) : (spDate ? escHtml(spDate) : "Sprint");
    const sprintEstadoBadge = isFinalizado
      ? `<span class="sprint-status-badge sprint-finalizado">&#10003; FINALIZADO</span>`
      : `<span class="sprint-status-badge sprint-activo">ACTIVO</span>`;

    ejecutionHtml += `<div class="exec-subview">
      <div class="exec-subview-header">
        <span class="exec-label">&#128640; Sprint ${sprintLabelId} &#9656; ${sprintEstadoBadge}</span>
        <span class="exec-progress-badge">${completedCount}/${agentesTotal} &middot; ${sprintPct}%</span>
      </div>
      <div class="exec-bar"><div class="exec-bar-fill" style="width:${sprintPct}%;background:var(--gradient-green);"></div></div>`;

    // Sección 1: Agentes activos (slot 1-3)
    if (spAgentes.length > 0) {
      ejecutionHtml += `<div style="padding:4px 10px 2px;font-size:10px;font-weight:600;color:var(--accent-green);letter-spacing:.04em;">&#9654; EN EJECUCIÓN (${spAgentes.length}/${data.sprintPlan.concurrency_limit || 3})</div>`;
      ejecutionHtml += `<div class="exec-table">`;
      for (const ag of spAgentes) { ejecutionHtml += renderSprintAgentRow(ag, null); }
      ejecutionHtml += `</div>`;
    }

    // Sección 2: Cola
    if (spQueue.length > 0) {
      ejecutionHtml += `<div style="padding:4px 10px 2px;font-size:10px;font-weight:600;color:#fbbf24;letter-spacing:.04em;">&#9711; EN COLA (${spQueue.length})</div>`;
      ejecutionHtml += `<div class="exec-table">`;
      for (const ag of spQueue) { ejecutionHtml += renderSprintAgentRow(ag, "pending"); }
      ejecutionHtml += `</div>`;
    }

    // Sección 3: Completados
    if (spCompleted.length > 0) {
      ejecutionHtml += `<div style="padding:4px 10px 2px;font-size:10px;font-weight:600;color:var(--text-muted);letter-spacing:.04em;">&#10003; COMPLETADOS (${spCompleted.length})</div>`;
      ejecutionHtml += `<div class="exec-table">`;
      for (const ag of spCompleted) { ejecutionHtml += renderSprintAgentRow(ag, "done"); }
      ejecutionHtml += `</div>`;
    }

    ejecutionHtml += `</div>`;
  }

  // Standalone issues sub-view
  if (data.standaloneSessions.length > 0) {
    ejecutionHtml += `<div class="exec-subview">
      <div class="exec-subview-header">
        <span class="exec-label">&#128204; Historias en curso</span>
        <span class="chip chip-blue">${data.standaloneSessions.length}</span>
      </div>`;
    for (const s of data.standaloneSessions) {
      const icon = AGENT_ICONS[s.agent_name] || agentIconHtml(s.agent_name);
      const gradient = AGENT_GRADIENTS[s.agent_name] || AGENT_GRADIENTS["Claude"];
      const statusColor = STATUS_COLORS[s._status] || "#555872";
      const tasks = s.current_tasks || [];
      const done = tasks.filter(t => t.status === "completed").length;
      const pct = tasks.length > 0 ? Math.round((done / tasks.length) * 100) : 0;
      ejecutionHtml += `<div class="exec-card">
        <div class="exec-card-avatar" style="background:${gradient};">${icon}</div>
        <div class="exec-card-info">
          <div class="exec-card-name">${escHtml(s.agent_name || "Agente")} <span style="color:var(--text-muted);font-weight:400;">${escHtml(s.branch || "")}</span></div>
          <div class="exec-bar" style="margin-top:4px;"><div class="exec-bar-fill" style="width:${pct}%;background:${statusColor};"></div></div>
          <div style="font-size:10px;color:var(--text-muted);margin-top:2px;">${done}/${tasks.length} tareas · ${s.action_count || 0} acc · ${formatDuration(s.started_ts)}</div>
        </div>
        <span class="exec-card-pct" style="color:${statusColor}">${pct}%</span>
      </div>`;
    }
    ejecutionHtml += `</div>`;
  }

  // Ad-hoc sessions sub-view
  if (data.adhocSessions.length > 0) {
    ejecutionHtml += `<div class="exec-subview">
      <div class="exec-subview-header">
        <span class="exec-label">&#9889; Prompts ad-hoc</span>
        <span class="chip chip-yellow">${data.adhocSessions.length}</span>
      </div>`;
    for (const s of data.adhocSessions) {
      if (s._status === "stale") continue;
      const statusColor = STATUS_COLORS[s._status] || "#555872";
      ejecutionHtml += `<div class="exec-adhoc-row">
        <span class="dot" style="background:${statusColor};"></span>
        <span class="exec-adhoc-id">${escHtml(s.id)}</span>
        <span class="exec-adhoc-action">${escHtml(s.last_tool || "")}${s.last_target ? ": " + escHtml((s.last_target || "").substring(0, 40)) : ""}</span>
        <span class="exec-adhoc-meta">${s.action_count || 0} acc · ${formatDuration(s.started_ts)}</span>
      </div>`;
    }
    ejecutionHtml += `</div>`;
  }

  if (!ejecutionHtml) {
    ejecutionHtml = '<div class="empty-state">Sin ejecuciones activas</div>';
  }

  // --- AGENT CARDS ---
  let agentsHtml = "";
  const visibleSessions = data.sessions.filter(s => s._status !== "stale");
  for (const s of visibleSessions) {
    const icon = AGENT_ICONS[s.agent_name] || agentIconHtml(s.agent_name);
    const gradient = AGENT_GRADIENTS[s.agent_name] || AGENT_GRADIENTS["Claude"];
    const statusColor = STATUS_COLORS[s._status] || "#555872";
    const statusLabel = STATUS_LABELS[s._status] || s._status;
    const name = escHtml(s.agent_name || "Agente (" + s.id + ")");
    const branchDisplay = escHtml(s.branch || "unknown");
    const duration = formatDuration(s.started_ts);
    const idleInfo = s._status === "idle" ? " " + formatAge(s.last_activity_ts) : "";
    const lastAction = s.last_tool ? (escHtml(s.last_tool) + ": " + escHtml((s.last_target || "").substring(0, 50))) : "--";
    const isBlocked = blockedPids.has(s.id);

    agentsHtml += `
      <div class="agent-card ${isBlocked ? 'agent-blocked' : ''}">
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

  // --- FLOW TREE (ASCII tree layout) ---
  const flowGraphHtml = buildFlowTree(data.sessions, data.agentNodes, data.agentTransitions, AGENT_ICONS, AGENT_COLORS);

  // --- GANTT ROADMAP (#1382) ---
  const ganttHtml = buildGanttChart(data.roadmap);
  const roadmapNumSprints = (data.roadmap && data.roadmap.horizon_sprints) || 0;

  // --- ACTIVITY FEED (chat-style with grouping) ---
  let feedHtml = "";
  // Blocking events first
  for (const b of data.blockingRelations) {
    const waitTime = formatAge(b.waitingSince);
    feedHtml += `<div class="feed-item feed-blocked">
      <div class="feed-time">&#128721;</div>
      <div class="feed-icon" style="filter:grayscale(1) brightness(1.5);">&#9888;&#65039;</div>
      <div class="feed-body">
        <span class="feed-agent">${escHtml(b.blockedAgent)}</span>
        <span class="feed-reason">${escHtml(b.reason)} (${waitTime})</span>
      </div>
    </div>`;
  }
  for (const g of data.groupedActivities) {
    const time = g.ts ? new Date(g.ts).toLocaleTimeString("es-AR", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "??:??";
    let agentName = g.session || "?";
    let agentIcon = "&#129302;";
    for (const s of data.sessions) {
      if (s.id === g.session) {
        agentName = s.agent_name || "Agente (" + s.id + ")";
        agentIcon = AGENT_ICONS[s.agent_name] || agentIconHtml(s.agent_name);
        break;
      }
    }
    const toolLabel = escHtml(g.tool || "");
    let targetText;
    if (g.count > 1) {
      // Grouped: show summary
      const uniqueTargets = [...new Set(g.targets.filter(Boolean).map(t => {
        const parts = t.replace(/\\/g, "/").split("/");
        return parts[parts.length - 1] || t;
      }))];
      if (g.tool === "Edit" || g.tool === "Write") {
        targetText = g.count + " archivos";
        if (uniqueTargets.length <= 3) targetText += " (" + uniqueTargets.join(", ").substring(0, 60) + ")";
      } else {
        targetText = g.count + " acciones";
      }
    } else {
      const t = (g.target || "").substring(0, 80);
      const parts = t.replace(/\\/g, "/").split("/");
      targetText = parts[parts.length - 1] || t;
    }
    const relTime = formatAge(g.ts);
    feedHtml += `<div class="feed-item">
      <div class="feed-time" title="${escHtml(time)}">${relTime}</div>
      <div class="feed-icon">${agentIcon}</div>
      <div class="feed-body">
        <span class="feed-agent">${escHtml(agentName)}</span>
        <span class="feed-tool">${toolLabel}${g.count > 1 ? ' x' + g.count : ''}</span>
        <span class="feed-target">${escHtml(targetText)}</span>
      </div>
    </div>`;
  }
  if (!feedHtml) {
    feedHtml = '<div class="empty-state">Sin actividad reciente</div>';
  }

  // --- AGENT USAGE PANEL ---
  const skillEntries = Object.entries(data.skillUsage || {})
    .map(([name, info]) => ({ name, count: info.count || 0, lastUsed: info.lastUsed }))
    .sort((a, b) => b.count - a.count);
  const maxSkillCount = skillEntries.length > 0 ? skillEntries[0].count : 1;
  const totalSkillInvocations = skillEntries.reduce((s, e) => s + e.count, 0);
  const uniqueAgentsUsed = skillEntries.length;

  // Color palette for agent bars
  const agentColors = ["var(--blue)", "var(--green)", "var(--orange)", "var(--purple)", "var(--red)", "var(--yellow)"];

  let agentBarsHtml = "";
  for (let i = 0; i < skillEntries.length; i++) {
    const e = skillEntries[i];
    const pct = Math.round((e.count / maxSkillCount) * 100);
    const color = agentColors[i % agentColors.length];
    const lastUsedText = e.lastUsed ? formatAge(e.lastUsed) : "—";
    agentBarsHtml += `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:5px;">
        <span style="font-size:11px;min-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">/${escHtml(e.name)}</span>
        <div style="flex:1;height:8px;background:var(--border);border-radius:4px;overflow:hidden;">
          <div style="width:${pct}%;height:100%;background:${color};border-radius:4px;transition:width 0.3s;"></div>
        </div>
        <span style="font-size:11px;font-weight:600;min-width:24px;text-align:right;">${e.count}</span>
        <span style="font-size:9px;color:var(--text-muted);min-width:40px;text-align:right;">${lastUsedText}</span>
      </div>`;
  }
  if (!agentBarsHtml) {
    agentBarsHtml = '<div class="empty-state">Sin datos de uso</div>';
  }

  const metricsHtml = `
    <div class="metrics-grid">
      <div class="metric-item">
        <div class="metric-value" style="color:var(--blue)">${uniqueAgentsUsed}</div>
        <div class="metric-label">Agentes</div>
      </div>
      <div class="metric-item">
        <div class="metric-value" style="color:var(--orange)">${totalSkillInvocations}</div>
        <div class="metric-label">Invocaciones</div>
      </div>
      <div class="metric-item">
        <div class="metric-value" style="color:var(--green)">${data.activeSessions}</div>
        <div class="metric-label">Sesiones</div>
      </div>
    </div>
    <div style="margin-top:12px;">
      ${agentBarsHtml}
    </div>`;

  // --- PERMISOS ---
  const permStats = data.permissionStats || { auto: 0, approved: 0, denied: 0, pending: 0 };
  const permTotal = permStats.auto + permStats.approved + permStats.denied + permStats.pending;

  let permissionsListHtml = "";
  const recentPerms = data.recentPermissions || [];
  for (const q of recentPerms.slice(0, 8)) {
    const isPending = q.status === "pending";
    const isDenied = q.action_result === "deny" || q.action_result === "deny_once" || q.action_result === "deny_always";
    const isAuto = q.answered_via === "auto" || q.answered_via === "auto_allow" || q.answered_via === "fast_path";
    const isTelegram = q.answered_via === "telegram";
    const isConsole = q.answered_via === "console";

    let statusIcon, statusLabel, statusClass;
    if (isPending) { statusIcon = "&#9711;"; statusLabel = "PEND"; statusClass = "perm-pending"; }
    else if (isDenied) { statusIcon = "&#10007;"; statusLabel = "RECH"; statusClass = "perm-denied"; }
    else if (isAuto) { statusIcon = "&#10003;"; statusLabel = "AUTO"; statusClass = "perm-auto"; }
    else if (isTelegram) { statusIcon = "&#10003;"; statusLabel = "TELE"; statusClass = "perm-telegram"; }
    else if (isConsole) { statusIcon = "&#10003;"; statusLabel = "CONS"; statusClass = "perm-console"; }
    else { statusIcon = "&#10003;"; statusLabel = "OK"; statusClass = "perm-auto"; }

    const toolName = (q.action_data && q.action_data.tool_name) || "???";
    const msgShort = escHtml((q.message || "").replace(/<[^>]*>/g, "").substring(0, 50));
    const age = formatAge(q.timestamp);
    const severity = q._severity || "???";
    const agentName = q._agent || "";
    const issueNum = q._issue || "";
    const sevColor = severity === "HIGH" ? "var(--red)" : severity === "MEDIUM" ? "var(--yellow)" : severity === "LOW" ? "var(--green)" : severity === "AUTO_ALLOW" ? "var(--text-dim)" : "var(--text-muted)";

    permissionsListHtml += `<div class="perm-item">
      <div class="perm-status ${statusClass}">${statusIcon}</div>
      <div class="perm-method">${statusLabel}</div>
      <div class="perm-detail">
        <div class="perm-row1">
          <span class="perm-tool">${escHtml(toolName)}</span>
          <span class="perm-severity" style="color:${sevColor}">${escHtml(severity)}</span>
          ${issueNum ? '<span class="perm-issue">' + formatIssueLink(issueNum) + '</span>' : ''}
          ${agentName ? '<span style="color:var(--text-muted);font-size:9px">' + escHtml(agentName) + '</span>' : ''}
        </div>
        <div class="perm-msg">${msgShort}</div>
      </div>
      <div class="perm-age">${age}</div>
    </div>`;
  }
  if (recentPerms.length === 0) {
    permissionsListHtml = '<div class="empty-state">Sin permisos registrados</div>';
  }

  // Top patterns
  const patterns = data.approvalHistory || {};
  const topPatterns = Object.entries(patterns)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 4)
    .map(([pat, info]) => escHtml(pat) + " &times;" + info.count)
    .join(" &middot; ");

  let permissionsHtml = `
    <div class="perm-summary">
      <div class="perm-stat"><span class="perm-stat-val" style="color:var(--green)">${permStats.auto}</span><span class="perm-stat-lbl">Auto</span></div>
      <div class="perm-stat"><span class="perm-stat-val" style="color:var(--blue)">${permStats.approved}</span><span class="perm-stat-lbl">Aprobados</span></div>
      <div class="perm-stat"><span class="perm-stat-val" style="color:var(--red)">${permStats.denied}</span><span class="perm-stat-lbl">Rechazados</span></div>
      <div class="perm-stat"><span class="perm-stat-val" style="color:var(--yellow)">${permStats.pending}</span><span class="perm-stat-lbl">Pendientes</span></div>
    </div>
    ${permissionsListHtml}
    ${topPatterns ? '<div class="perm-patterns">Top: ' + topPatterns + '</div>' : ''}`;

  // --- CI ---
  let ciHtml = "";
  for (const r of data.ciRuns.slice(0, MAX_CI_ENTRIES)) {
    const isOk = r.conclusion === "success";
    const isFail = r.conclusion === "failure";
    const iconClass = isOk ? "ci-ok" : isFail ? "ci-fail" : "ci-run";
    const icon = isOk ? "&#10003;" : isFail ? "&#10007;" : "&#9203;";
    const iconColor = isOk ? "var(--green)" : isFail ? "var(--red)" : "var(--yellow)";
    ciHtml += `<div class="ci-row">
      <div class="ci-icon ${iconClass}" style="color:${iconColor}">${icon}</div>
      <div class="ci-text"><strong>${escHtml(r.headBranch)}</strong> &middot; ${escHtml((r.displayTitle || "").substring(0, 50))}</div>
      <div class="ci-time">${formatAge(r.createdAt)}</div>
    </div>`;
  }
  if (data.ciRuns.length === 0) {
    ciHtml = '<div class="empty-state">Sin datos CI</div>';
  }

  // --- AGENT METRICS TABLE (#1226) ---
  let agentMetricsHtml = "";
  const metricsEntries = [];
  const activeSessionIds = new Set();
  for (const s of data.sessions) {
    if (s.type === "sub") continue;
    const st = getSessionStatus(s);
    if (st === "stale") continue;
    activeSessionIds.add(s.id);
    const startMs = new Date(s.started_ts).getTime();
    const durMin = Math.round((Date.now() - startMs) / 60000);
    const tc = s.tool_counts || {};
    const totalCalls = Object.values(tc).reduce((a, b) => a + b, 0);
    metricsEntries.push({
      agent: s.agent_name || "Claude",
      session: s.id,
      calls: totalCalls || s.action_count || 0,
      files: Array.isArray(s.modified_files) ? s.modified_files.length : 0,
      tasksCreated: s.tasks_created || 0,
      tasksCompleted: s.tasks_completed || 0,
      durMin,
      active: true,
    });
  }
  if (data.agentMetrics && Array.isArray(data.agentMetrics.sessions)) {
    for (const ms of data.agentMetrics.sessions.slice(-10).reverse()) {
      if (activeSessionIds.has(ms.id)) continue;
      metricsEntries.push({
        agent: ms.agent_name || "Claude",
        session: ms.id,
        calls: ms.total_tool_calls || 0,
        files: ms.modified_files_count || 0,
        tasksCreated: ms.tasks_created || 0,
        tasksCompleted: ms.tasks_completed || 0,
        durMin: ms.duration_min || 0,
        active: false,
      });
    }
  }
  const metricsToShow = metricsEntries.slice(0, 8);
  if (metricsToShow.length > 0) {
    agentMetricsHtml = '<table style="width:100%;font-size:11px;border-collapse:collapse;">';
    agentMetricsHtml += '<tr style="color:var(--text-muted);border-bottom:1px solid var(--border);">'
      + '<th style="text-align:left;padding:4px;">Agente</th>'
      + '<th style="text-align:left;padding:4px;">Sesi&oacute;n</th>'
      + '<th style="text-align:right;padding:4px;">Calls</th>'
      + '<th style="text-align:right;padding:4px;">Arch.</th>'
      + '<th style="text-align:right;padding:4px;">Tareas</th>'
      + '<th style="text-align:right;padding:4px;">Dur.</th></tr>';
    for (const m of metricsToShow) {
      const indicator = m.active ? '<span style="color:var(--green);">&#9679;</span> ' : '';
      const tasksStr = m.tasksCompleted + "/" + m.tasksCreated;
      const durStr = m.durMin < 60 ? m.durMin + "m" : Math.floor(m.durMin / 60) + "h " + (m.durMin % 60) + "m";
      agentMetricsHtml += '<tr style="border-bottom:1px solid var(--border);">'
        + '<td style="padding:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:120px;">' + indicator + escHtml(m.agent) + '</td>'
        + '<td style="padding:4px;font-family:monospace;font-size:10px;">' + escHtml(m.session) + '</td>'
        + '<td style="text-align:right;padding:4px;font-weight:600;">' + m.calls + '</td>'
        + '<td style="text-align:right;padding:4px;">' + m.files + '</td>'
        + '<td style="text-align:right;padding:4px;">' + tasksStr + '</td>'
        + '<td style="text-align:right;padding:4px;">' + durStr + '</td></tr>';
    }
    agentMetricsHtml += '</table>';
    const totalHistoric = data.agentMetrics && Array.isArray(data.agentMetrics.sessions) ? data.agentMetrics.sessions.length : 0;
    if (totalHistoric > 0) {
      const lastTs = data.agentMetrics.updated_ts;
      agentMetricsHtml += '<div style="font-size:10px;color:var(--text-muted);margin-top:6px;">'
        + 'Hist&oacute;rico: ' + totalHistoric + ' sesiones &mdash; &uacute;ltima: ' + formatAge(lastTs) + '</div>';
    }
  } else {
    agentMetricsHtml = '<div class="empty-state">Sin m&eacute;tricas de agentes</div>';
  }

  // --- ALERTS ---
  let alertsHtml = "";
  for (const a of data.alerts) {
    const color = a.type === "critical" ? "var(--red)" : a.type === "warning" ? "var(--yellow)" : "var(--blue)";
    const icon = a.type === "critical" ? "&#128680;" : a.type === "warning" ? "&#9888;&#65039;" : "&#8505;&#65039;";
    alertsHtml += `<div class="alert-item" style="border-left-color:${color};">${icon} ${escHtml(a.message)}</div>`;
  }

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

    /* Header */
    .header { background: var(--surface); border-bottom: 1px solid var(--border); padding: 10px 20px; display: flex; justify-content: space-between; align-items: center; position: sticky; top: 0; z-index: 100; backdrop-filter: blur(10px); }
    .header-left { display: flex; align-items: center; gap: 12px; }
    .header-title { font-size: 14px; font-weight: 700; color: var(--white); }
    .header-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); animation: pulse 2s infinite; }
    .header-right { display: flex; align-items: center; gap: 12px; font-size: 11px; color: var(--text-muted); }
    .theme-toggle { background: var(--surface2); border: 1px solid var(--border); border-radius: 20px; padding: 4px 12px; font-size: 11px; color: var(--text-dim); cursor: pointer; }
    .theme-toggle:hover { border-color: var(--blue); color: var(--blue); }

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

    /* Layout */
    .grid-2col { display: grid; grid-template-columns: 1fr 340px; gap: 14px; margin-bottom: 16px; }
    .grid-2equal { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 16px; }
    .grid-flow { display: grid; grid-template-columns: 1fr; gap: 14px; margin-bottom: 16px; }
    .grid-activity { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 16px; }

    /* Panel base */
    .panel { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 16px; }
    .panel-title { font-size: 12px; font-weight: 700; color: var(--white); margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; }
    .chip { font-size: 10px; font-weight: 600; padding: 2px 8px; border-radius: 100px; }
    .chip-green { background: var(--green-dim); color: var(--green); }
    .chip-blue { background: var(--blue-dim); color: var(--blue); }
    .chip-red { background: var(--red-dim); color: var(--red); }
    .chip-yellow { background: var(--yellow-dim); color: var(--yellow); }
    .chip-purple { background: var(--purple-dim); color: var(--purple); }

    /* Execution panel */
    .exec-subview { margin-bottom: 12px; padding-bottom: 12px; border-bottom: 1px solid var(--border); }
    .exec-subview:last-child { border-bottom: none; margin-bottom: 0; padding-bottom: 0; }
    .exec-subview-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .exec-label { font-size: 12px; font-weight: 700; color: var(--white); display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .exec-progress-badge { font-size: 13px; font-weight: 800; color: var(--green); }
    .sprint-status-badge { font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 100px; letter-spacing: 0.04em; }
    .sprint-activo { background: var(--green-dim, rgba(34,197,94,0.15)); color: var(--green, #22c55e); }
    .sprint-finalizado { background: var(--blue-dim, rgba(59,130,246,0.15)); color: var(--blue, #60a5fa); }
    .exec-bar { height: 6px; background: var(--surface3); border-radius: 3px; overflow: hidden; margin-bottom: 8px; }
    .exec-bar-fill { height: 100%; border-radius: 3px; transition: width 0.5s; }
    .exec-table { display: flex; flex-direction: column; gap: 4px; }
    .exec-row { display: flex; align-items: center; gap: 10px; padding: 4px 8px; border-radius: var(--radius-xs); font-size: 11px; }
    .exec-row:hover { background: var(--surface2); }
    .exec-issue { font-weight: 700; color: var(--blue); min-width: 48px; }
    .exec-slug { color: var(--text-dim); flex: 1; }
    .exec-size { min-width: 24px; text-align: center; }
    .exec-status { font-size: 12px; }
    .exec-card { display: flex; align-items: center; gap: 10px; padding: 10px; background: var(--surface2); border-radius: var(--radius-xs); margin-bottom: 6px; }
    .exec-card-avatar { width: 32px; height: 32px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 14px; flex-shrink: 0; }
    .exec-card-info { flex: 1; min-width: 0; }
    .exec-card-name { font-size: 12px; font-weight: 600; color: var(--white); }
    .exec-card-pct { font-size: 16px; font-weight: 800; }
    .exec-adhoc-row { display: flex; align-items: center; gap: 8px; padding: 4px 8px; font-size: 11px; }
    .exec-adhoc-id { font-weight: 600; color: var(--text-dim); min-width: 64px; font-family: monospace; }
    .exec-adhoc-action { color: var(--text-dim); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .exec-adhoc-meta { color: var(--text-muted); font-size: 10px; white-space: nowrap; }

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

    /* Flow graph */
    .flow-graph-svg { overflow: visible; }
    .flow-node:hover circle { stroke-width: 3; filter: brightness(1.3); }

    /* Feed */
    .feed-panel { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 16px; max-height: 400px; overflow-y: auto; }
    .feed-item { display: flex; align-items: flex-start; gap: 8px; padding: 6px 8px; border-radius: var(--radius-xs); margin-bottom: 2px; transition: background 0.15s; }
    .feed-item:hover { background: var(--surface2); }
    .feed-blocked { background: var(--red-dim) !important; border-left: 3px solid var(--red); }
    .feed-time { font-size: 10px; color: var(--text-muted); font-weight: 600; min-width: 40px; flex-shrink: 0; font-family: 'SF Mono', 'Cascadia Code', monospace; }
    .feed-icon { font-size: 14px; flex-shrink: 0; width: 20px; text-align: center; }
    .feed-body { font-size: 11px; color: var(--text-dim); flex: 1; min-width: 0; }
    .feed-agent { font-weight: 700; color: var(--white); margin-right: 4px; }
    .feed-tool { background: var(--blue-dim); color: var(--blue); font-size: 10px; padding: 1px 6px; border-radius: 4px; font-weight: 600; margin-right: 4px; }
    .feed-target { color: var(--text-dim); word-break: break-all; }
    .feed-reason { color: var(--red); font-weight: 600; }

    /* Metrics */
    .metrics-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 12px; }
    .metric-item { text-align: center; padding: 8px; background: var(--surface2); border-radius: var(--radius-xs); }
    .metric-value { font-size: 18px; font-weight: 800; line-height: 1.3; }
    .metric-label { font-size: 9px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; }
    .metric-weekly { margin-top: 8px; }
    .metric-weekly-header { display: flex; justify-content: space-between; font-size: 10px; color: var(--text-dim); margin-bottom: 4px; }
    .metric-gauge { height: 8px; background: var(--surface3); border-radius: 4px; overflow: hidden; }
    .metric-gauge-fill { height: 100%; border-radius: 4px; transition: width 0.5s; }

    /* Permissions */
    .perm-summary { display: flex; gap: 12px; margin-bottom: 12px; padding-bottom: 10px; border-bottom: 1px solid var(--border); }
    .perm-stat { display: flex; flex-direction: column; align-items: center; flex: 1; }
    .perm-stat-val { font-size: 18px; font-weight: 800; }
    .perm-stat-lbl { font-size: 9px; color: var(--text-muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
    .perm-item { display: flex; align-items: flex-start; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--border); }
    .perm-item:last-child { border-bottom: none; }
    .perm-status { width: 18px; height: 18px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 10px; flex-shrink: 0; margin-top: 2px; }
    .perm-auto { background: var(--green-dim); color: var(--green); }
    .perm-telegram { background: var(--blue-dim); color: var(--blue); }
    .perm-console { background: var(--purple-dim); color: var(--purple); }
    .perm-denied { background: var(--red-dim); color: var(--red); }
    .perm-pending { background: var(--yellow-dim); color: var(--yellow); animation: pulse 2s infinite; }
    .perm-method { font-size: 9px; font-weight: 700; color: var(--text-muted); width: 32px; flex-shrink: 0; text-align: center; margin-top: 3px; }
    .perm-detail { flex: 1; min-width: 0; }
    .perm-row1 { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .perm-tool { font-size: 11px; font-weight: 600; color: var(--text); }
    .perm-severity { font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 3px; background: var(--surface2); white-space: nowrap; }
    .perm-msg { font-size: 10px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; display: block; margin-top: 2px; }
    .perm-origin { font-size: 9px; color: var(--text-muted); margin-top: 2px; display: flex; align-items: center; gap: 4px; }
    .perm-issue { color: var(--blue); font-weight: 600; }
    .issue-link { color: var(--accent-blue, #60a5fa); text-decoration: none; border-bottom: 1px solid var(--accent-blue, #60a5fa); cursor: pointer; transition: color 0.2s, border-bottom-color 0.2s; }
    .issue-link:hover { color: var(--accent-bright, #93c5fd); border-bottom-color: var(--accent-bright, #93c5fd); }
    .gantt-bar-link:hover rect { filter: brightness(1.2); cursor: pointer; }
    .perm-age { font-size: 10px; color: var(--text-muted); white-space: nowrap; flex-shrink: 0; margin-top: 2px; }
    .perm-patterns { font-size: 10px; color: var(--text-dim); margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--border); }
    .tasks-progress-bar { height: 4px; background: var(--surface3); border-radius: 2px; margin-bottom: 12px; overflow: hidden; }
    .tasks-progress-fill { height: 100%; border-radius: 2px; transition: width 0.5s; }

    /* CI */
    .ci-row { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--border); }
    .ci-row:last-child { border-bottom: none; }
    .ci-icon { width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; flex-shrink: 0; }
    .ci-ok { background: var(--green-dim); }
    .ci-fail { background: var(--red-dim); }
    .ci-run { background: var(--yellow-dim); }
    .ci-text { flex: 1; font-size: 11px; color: var(--text-dim); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ci-text strong { color: var(--text); font-weight: 600; }
    .ci-time { font-size: 10px; color: var(--text-muted); white-space: nowrap; }

    /* Alerts */
    .alerts-panel { margin-bottom: 16px; }
    .alert-item { padding: 10px 14px; background: var(--surface); border: 1px solid var(--border); border-left: 4px solid; border-radius: var(--radius-xs); margin-bottom: 6px; font-size: 12px; color: var(--text-dim); }

    /* Sparkline */
    .sparkline-svg { width: 100%; height: 50px; }

    /* Blocked states */
    .agent-blocked { border-color: var(--red) !important; border-left: 3px solid var(--red); animation: pulse-blocked 2s infinite; }
    .agent-status-blocked { background: var(--red-dim); color: var(--red); border: 1px solid rgba(248,113,113,0.4); font-size: 10px; font-weight: 600; padding: 2px 8px; border-radius: 100px; white-space: nowrap; animation: pulse-red 1.5s infinite; }

    /* Empty state */
    .empty-state { font-size: 12px; color: var(--text-muted); font-style: italic; padding: 12px 0; text-align: center; }

    /* Responsive */
    @media (max-width: 768px) {
      .kpi-row { grid-template-columns: repeat(3, 1fr); }
      .grid-2col, .grid-2equal, .grid-flow, .grid-activity { grid-template-columns: 1fr; }
      .kv { font-size: 22px; }
      .metrics-grid { grid-template-columns: repeat(2, 1fr); }
    }
    @media (max-width: 480px) {
      .kpi-row { grid-template-columns: repeat(2, 1fr); }
      .container { padding: 8px; }
      .feed-panel { max-height: 300px; }
    }

    /* Animations */
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
    @keyframes pulse-blocked { 0%, 100% { box-shadow: 0 0 0 0 rgba(248,113,113,0); } 50% { box-shadow: 0 0 12px 2px rgba(248,113,113,0.15); } }
    @keyframes pulse-red { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }

    /* Scrollbar */
    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: var(--bg); }
    ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  </style>
</head>
<body>
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
        <div class="kv" style="color:var(--blue)">${permTotal}</div>
        <div class="kl">Permisos</div>
        <div class="kt" style="color:${permStats.pending > 0 ? 'var(--yellow)' : 'var(--green)'}">${permStats.pending > 0 ? permStats.pending + ' pendiente(s)' : permStats.auto + ' auto'}</div>
      </div>
      ${data.ciStatus !== 'unknown' ? `<div class="kpi ${data.ciStatus === 'ok' ? 'kpi-green' : data.ciStatus === 'fail' ? 'kpi-red' : 'kpi-orange'}">
        <div class="kv" style="color:${data.ciStatus === 'ok' ? 'var(--green)' : data.ciStatus === 'fail' ? 'var(--red)' : 'var(--yellow)'}">${data.ciStatus === 'ok' ? '&#10003;' : data.ciStatus === 'fail' ? '&#10007;' : '&#9203;'}</div>
        <div class="kl">CI / CD</div>
        <div class="kt" style="color:${data.ciStatus === 'ok' ? 'var(--green)' : data.ciStatus === 'fail' ? 'var(--red)' : 'var(--yellow)'}">${data.ciStatus === 'ok' ? 'Build OK' : data.ciStatus === 'fail' ? 'Build FAIL' : 'En curso...'}</div>
      </div>` : ''}
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

    <!-- Ejecución + Agents -->
    <div class="grid-2col" data-panel="exec">
      <div class="panel">
        <div class="panel-title">Ejecuci&oacute;n <span class="chip chip-green">${sprintProgress}% completado</span></div>
        <div class="tasks-progress-bar">
          <div class="tasks-progress-fill" style="width:${sprintProgress}%; background: var(--gradient-green);"></div>
        </div>
        ${ejecutionHtml}
      </div>
      <div>
        <div style="font-size:12px;font-weight:700;color:var(--white);margin-bottom:10px;">Agentes</div>
        ${agentsHtml}
      </div>
    </div>

    <!-- Fila 1: Flujo de agentes (ancho completo) #1378 -->
    <div class="grid-flow" data-panel="sessions">
      <div class="panel">
        <div class="panel-title">Flujo de agentes <span class="chip chip-blue">${data.agentNodes.length} nodos</span></div>
        ${flowGraphHtml}
      </div>
    </div>

    <!-- Fila 2: Actividad en vivo | Permisos #1378 -->
    <div class="grid-activity">
      <div class="feed-panel" id="activity-feed">
        <div class="panel-title">Actividad en vivo <span class="chip ${data.blockingRelations.length > 0 ? 'chip-red' : 'chip-green'}">${data.blockingRelations.length > 0 ? data.blockingRelations.length + ' bloq.' : 'Sin bloqueos'}</span></div>
        ${feedHtml}
      </div>
      <div class="panel">
        <div class="panel-title">Permisos <span class="chip chip-blue">${permTotal} total</span></div>
        ${permissionsHtml}
      </div>
    </div>

    <!-- Fila 3: Uso de agentes | Métricas de agentes #1378 -->
    <div class="grid-2equal" data-panel="metrics">
      <div class="panel">
        <div class="panel-title">Uso de agentes <span class="chip chip-purple">${totalSkillInvocations} inv.</span></div>
        ${metricsHtml}
      </div>
      <div class="panel">
        <div class="panel-title">M&eacute;tricas de agentes <span class="chip chip-purple">${metricsToShow.length} ses.</span></div>
        ${agentMetricsHtml}
      </div>
    </div>

    <!-- Roadmap Gantt (#1382) -->
    <div class="panel" style="margin-bottom:16px;" data-panel="roadmap">
      <div class="panel-title">Roadmap <span class="chip chip-purple">${roadmapNumSprints} sprints</span></div>
      <div style="overflow-x:auto;overflow-y:hidden;max-width:100%;padding-bottom:8px;">
        ${ganttHtml}
      </div>
    </div>

    <!-- CI (solo si hay datos) -->
    ${data.ciRuns.length > 0 ? `<div class="panel" style="margin-bottom:16px;" data-panel="ci">
      <div class="panel-title">CI / CD</div>
      ${ciHtml}
    </div>` : ''}

  </div>

  <script>
    function toggleTheme() {
      var html = document.documentElement;
      var current = html.getAttribute('data-theme');
      html.setAttribute('data-theme', current === 'dark' ? 'light' : 'dark');
      localStorage.setItem('theme', html.getAttribute('data-theme'));
    }
    var saved = localStorage.getItem('theme');
    if (saved) document.documentElement.setAttribute('data-theme', saved);

    // Auto-scroll feed
    var feed = document.getElementById('activity-feed');
    if (feed) { feed.scrollTop = 0; }

    // Flow graph tooltips
    document.querySelectorAll('.flow-node').forEach(function(node) {
      node.addEventListener('mouseenter', function(e) {
        var agent = this.getAttribute('data-agent');
        this.style.transform = 'scale(1.1)';
        this.style.transformOrigin = 'center';
      });
      node.addEventListener('mouseleave', function() {
        this.style.transform = '';
      });
    });

    // SSE auto-refresh
    if (!location.search.includes('nosse=1')) {
      var lastUpdate = Date.now();
      var evtSource = new EventSource('/events');
      evtSource.onmessage = function(event) {
        lastUpdate = Date.now();
        var data = JSON.parse(event.data);
        if (data.reload) location.reload();
      };
      evtSource.onerror = function() {
        document.getElementById('update-time').textContent = 'Desconectado...';
      };
      setInterval(function() {
        var secs = Math.floor((Date.now() - lastUpdate) / 1000);
        document.getElementById('update-time').textContent = 'Actualizado hace ' + secs + 's';
      }, 1000);
    }
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

  res.setHeader("Access-Control-Allow-Origin", "*");

  if (pathname === "/" || pathname === "/index.html") {
    const theme = url.searchParams.get("theme") || "dark";
    const mockMode = url.searchParams.get("mock");
    const data = mockMode === "ejecucion" ? mockEjecucionData() : collectData();
    let html;
    try {
      html = renderHTML(data, theme);
    } catch (renderErr) {
      console.log("[dashboard-server] renderHTML error: " + renderErr.message + "\n" + renderErr.stack);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("renderHTML error: " + renderErr.message + "\n" + renderErr.stack);
      return;
    }
    const body = Buffer.from(html, "utf8");

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
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    res.write("data: {\"connected\":true}\n\n");
    const client = { res, alive: true };
    sseClients.add(client);
    req.on("close", () => { client.alive = false; sseClients.delete(client); });
  } else if (pathname === "/api/status") {
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
        agent: s.agent_name || "Agente",
        branch: s.branch,
        status: s._status,
        actions: s.action_count,
        lastTool: s.last_tool,
        lastTarget: (s.last_target || "").substring(0, 80),
        duration: formatDuration(s.started_ts),
        tasks: (s.current_tasks || []).map(t => ({
          id: t.id, subject: t.subject, status: t.status, progress: t.progress || 0
        })),
        agentTransitions: s.agent_transitions || [],
      })),
      activities: data.activities,
      groupedActivities: data.groupedActivities,
      blockingRelations: data.blockingRelations,
      pendingQuestionsCount: data.pendingQuestions.length,
      permissionStats: data.permissionStats,
      approvalHistory: data.approvalHistory,
      sprintPlan: data.sprintPlan,
      metrics: data.metrics,
      agentMetrics: data.agentMetrics,
      agentNodes: data.agentNodes,
      agentTransitions: data.agentTransitions,
    });
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
    res.end(json);
  } else if (pathname === "/screenshot") {
    const width = parseInt(url.searchParams.get("w")) || 375;
    const height = parseInt(url.searchParams.get("h")) || 640;
    takeScreenshot(width, height).then(buf => {
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
      res.end(buf);
    }).catch(err => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Screenshot error: " + err.message + "\nInstall puppeteer: npm install puppeteer");
    });
  } else if (pathname === "/screenshots") {
    const width = parseInt(url.searchParams.get("w")) || 600;
    const height = parseInt(url.searchParams.get("h")) || 800;
    takeScreenshot(width, height, { split: true }).then(parts => {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ top: parts[0].toString("base64"), bottom: parts[1].toString("base64") }));
    }).catch(err => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Screenshots error: " + err.message);
    });
  } else if (pathname === "/screenshots/sections") {
    const width = parseInt(url.searchParams.get("w")) || 390;
    takeScreenshotSections(width).then(sections => {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(sections));
    }).catch(err => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Sections screenshot error: " + err.message);
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

async function takeScreenshot(width, height, options) {
  const opts = options || {};
  let puppeteer;
  try { puppeteer = require("puppeteer"); } catch {
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
    await page.goto("http://localhost:" + PORT + "/?theme=dark&nosse=1", { waitUntil: "domcontentloaded", timeout: 15000 });
    await new Promise(r => setTimeout(r, 1000));

    if (opts.split) {
      const fullHeight = await page.evaluate(() => document.body.scrollHeight);
      const splitPoint = Math.min(height, Math.ceil(fullHeight / 2));
      const topBuf = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width, height: splitPoint } });
      const bottomBuf = await page.screenshot({ type: "png", clip: { x: 0, y: splitPoint, width, height: Math.max(100, fullHeight - splitPoint) } });
      return [topBuf, bottomBuf];
    }

    return await page.screenshot({ type: "png", fullPage: true });
  } finally {
    await page.close();
  }
}

// Captura cada sección semántica del dashboard usando getBoundingClientRect()
// Retorna array de { id, image: "<base64>" } — omite paneles vacíos o inexistentes
async function takeScreenshotSections(width) {
  let puppeteer;
  try { puppeteer = require("puppeteer"); } catch {
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
    // Viewport alto para que todos los paneles rendericen antes del scroll
    await page.setViewport({ width, height: 2400 });
    await page.goto("http://localhost:" + PORT + "/?theme=dark&nosse=1", { waitUntil: "load", timeout: 15000 });
    // Esperar 3000ms (aumentado desde 2000ms) para dar tiempo a renders con datos
    await new Promise(r => setTimeout(r, 3000));

    // Obtener altura total de la página para bounds checking
    const pageHeight = await page.evaluate(() => document.body.scrollHeight);
    console.log("[dashboard-server] takeScreenshotSections: pageHeight=" + pageHeight + " width=" + width);

    const sectionData = await page.evaluate(() => {
      const selectors = [
        { id: "kpis",               sel: ".kpi-row" },
        { id: "ejecucion",          sel: "[data-panel='exec']" },
        { id: "sesiones",           sel: "[data-panel='sessions']" },
        { id: "metricas",           sel: "[data-panel='metrics']" },
        { id: "flujo",              sel: "[data-panel='flow']" },
        { id: "actividad",          sel: "[data-panel='activity']" },
        { id: "permisos",           sel: "[data-panel='permissions']" },
        { id: "agentes-metricas",   sel: "[data-panel='agent-metrics']" },
        { id: "roadmap",            sel: "[data-panel='roadmap']" },
        { id: "ci",                 sel: "[data-panel='ci']" },
      ];
      return selectors.map(function(s) {
        var el = document.querySelector(s.sel);
        if (!el) return { id: s.id, found: false };
        var r = el.getBoundingClientRect();
        // Ignorar paneles vacíos o sin altura visible
        if (r.height < 20 || r.width < 20) return { id: s.id, found: true, visible: false, rect: { h: r.height, w: r.width } };
        // Redondear a enteros (Puppeteer clip requiere enteros) y corregir offset de scroll
        return {
          id: s.id,
          found: true,
          visible: true,
          x: Math.max(0, Math.round(r.x)),
          y: Math.max(0, Math.round(r.y + window.scrollY)),
          width: Math.round(r.width),
          height: Math.round(r.height),
        };
      });
    });

    // Logear resultado del DOM scan
    const found = sectionData.filter(s => s.found && s.visible);
    const missing = sectionData.filter(s => !s.found).map(s => s.id);
    const hidden = sectionData.filter(s => s.found && !s.visible).map(s => s.id);
    console.log("[dashboard-server] Paneles encontrados: [" + found.map(s => s.id).join(", ") + "]" +
      (missing.length ? " | Faltantes en DOM: [" + missing.join(", ") + "]" : "") +
      (hidden.length ? " | Ocultos (rect<20): [" + hidden.join(", ") + "]" : ""));

    const results = [];
    for (const section of found) {
      try {
        // Bounds check: el clip no puede superar el alto total de la página
        const clampedHeight = Math.min(section.height, Math.max(1, pageHeight - section.y));
        if (clampedHeight < 20) {
          console.log("[dashboard-server] Sección " + section.id + " clampedHeight=" + clampedHeight + " < 20 — omitida");
          continue;
        }

        const buf = await page.screenshot({
          type: "png",
          clip: {
            x: section.x,
            y: section.y,
            width: Math.min(section.width, width),
            height: clampedHeight,
          },
        });
        // Solo incluir si la imagen tiene contenido real (> 5KB)
        if (buf.length > 5000) {
          results.push({ id: section.id, image: buf.toString("base64") });
          console.log("[dashboard-server] Sección " + section.id + " capturada: " + buf.length + " bytes");
        } else {
          console.log("[dashboard-server] Sección " + section.id + " descartada: solo " + buf.length + " bytes (umbral 5KB)");
        }
      } catch (sectionErr) {
        // Una sección fallida no rompe las demás
        console.error("[dashboard-server] Error capturando sección " + section.id + ": " + (sectionErr.stack || sectionErr.message));
      }
    }
    console.log("[dashboard-server] takeScreenshotSections completado: " + results.length + "/" + found.length + " secciones capturadas");
    return results;
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

// --- Sprint-plan freshness watcher (#1434) ---
// Polling de mtime cada 1s (O(1), sin reread completo).
// Si sprint-plan.json cambió, hace broadcast SSE inmediato sin esperar el ciclo de 5s.
function checkSprintPlanFreshness() {
  let currentMtime = 0;
  try { currentMtime = fs.statSync(SPRINT_PLAN_FILE).mtimeMs; } catch {}
  if (currentMtime !== 0 && currentMtime !== sprintPlanWatchMtime) {
    sprintPlanWatchMtime = currentMtime;
    console.log("[dashboard-server] sprint-plan.json cambió → broadcast SSE inmediato");
    broadcastSSE();
  }
}

// --- Auto-stop ---
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

// --- PID file ---
function writePid() {
  const dir = path.dirname(PID_FILE);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  fs.writeFileSync(PID_FILE, String(process.pid), "utf8");
}

function cleanup() {
  try { fs.unlinkSync(PID_FILE); } catch {}
  if (puppeteerBrowser) { try { puppeteerBrowser.close(); } catch {} }
}

// --- Telegram Heartbeat ---
const { startHeartbeat } = require("./hooks/heartbeat-manager.js");

// --- Start server ---
const server = http.createServer(handleRequest);

server.listen(PORT, () => {
  console.log("[dashboard-server] Escuchando en http://localhost:" + PORT);
  writePid();

  setInterval(broadcastSSE, SSE_INTERVAL_MS);
  setInterval(checkSprintPlanFreshness, 1000); // Watcher freshness sprint-plan.json (#1434)
  setInterval(checkAutoStop, 5 * 60 * 1000);

  startHeartbeat({ collectDataFn: collectData, takeScreenshotFn: takeScreenshot, port: PORT });
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.log("[dashboard-server] Puerto " + PORT + " ya en uso, otro servidor corriendo.");
    process.exit(0);
  }
  console.error("[dashboard-server] Error:", err.message);
  process.exit(1);
});

process.on("SIGTERM", () => { cleanup(); process.exit(0); });
process.on("SIGINT", () => { cleanup(); process.exit(0); });
process.on("exit", cleanup);

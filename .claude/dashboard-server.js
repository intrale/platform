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
const AGENT_REGISTRY_FILE = path.join(CLAUDE_DIR, "hooks", "agent-registry.json");
const ICONS_DIR = path.join(CLAUDE_DIR, "icons");

// Agent Registry — fuente de verdad centralizada (#1642)
let agentRegistry = null;
try { agentRegistry = require(path.join(CLAUDE_DIR, "hooks", "agent-registry")); } catch (e) { /* módulo no disponible */ }

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
  "Cleanup": loadIconDataUri("clean.svg"),
  "Perf": loadIconDataUri("perf.png"),
  "Cost": loadIconDataUri("cost.png"),
  "Hotfix": loadIconDataUri("hotfix.png"),
  "Config": loadIconDataUri("config.svg"),
  "Done": loadIconDataUri("done.svg"),
  "Error": loadIconDataUri("failure.svg"),
  "Start": loadIconDataUri("start.svg"),
};
const CLAUDE_ICONS = [
  loadIconDataUri("claude-1.svg"),
  loadIconDataUri("claude-2.svg"),
  loadIconDataUri("claude-3.svg"),
  loadIconDataUri("claude-4.svg"),
].filter(Boolean);
if (CLAUDE_ICONS.length > 0) {
  AGENT_ICON_MAP["Claude"] = CLAUDE_ICONS[0];
  AGENT_ICON_MAP["Main"] = CLAUDE_ICONS[0];
}

// Iconos de robots para agentes raíz del sprint (#1544)
// Carga robot1.svg a robot10.svg como SVG inline (data URI)
const ROBOT_ICONS = {};
for (let i = 1; i <= 10; i++) {
  ROBOT_ICONS[i] = loadIconDataUri("robots/robot" + i + ".svg");
}

// Leer SVG raw para inline rendering en nodos del grafo (#1544)
function loadRobotSvgInline(robotId) {
  try {
    const filePath = path.join(ICONS_DIR, "robots", "robot" + robotId + ".svg");
    return fs.readFileSync(filePath, "utf8");
  } catch { return ""; }
}
const ROBOT_SVGS_INLINE = {};
for (let i = 1; i <= 10; i++) {
  ROBOT_SVGS_INLINE[i] = loadRobotSvgInline(i);
}

// Skill-name → canonical agent name mapping
const SKILL_TO_AGENT = {
  "/guru": "Guru", "/doc": "Doc", "/historia": "Doc", "/refinar": "Doc", "/priorizar": "Doc",
  "/planner": "Planner", "/delivery": "DeliveryManager", "/tester": "Tester",
  "/monitor": "Monitor", "/builder": "Builder", "/review": "Review", "/qa": "QA",
  "/auth": "Auth", "/ux": "UX Specialist", "/scrum": "Scrum Master", "/po": "PO",
  "/backend-dev": "BackendDev", "/android-dev": "AndroidDev", "/ios-dev": "iOSDev",
  "/web-dev": "WebDev", "/desktop-dev": "DesktopDev", "/ops": "Ops", "/branch": "Branch",
  "/security": "Security", "/cleanup": "Cleanup", "/perf": "Perf", "/cost": "Cost", "/hotfix": "Hotfix",
  "/update-config": "Config", "/simplify": "Simplify",
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
let cachedHtml = null;
let cachedHtmlDataTs = 0;
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

// Auto-linkificar referencias #NNNN en texto HTML (#1422)
// Convierte cada ocurrencia de #NNNN (3-5 dígitos) en un link a GitHub Issues
function linkifyIssueRefs(text) {
  if (!text) return "";
  return String(text).replace(/#(\d{3,5})\b/g, (match, num) => {
    const url = `https://github.com/intrale/platform/issues/${num}`;
    return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="issue-link">#${num}</a>`;
  });
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
  // sprintIssueSet incluye TODOS los issues del sprint (agentes + _queue + _completed + _incomplete)
  // para retener sesiones activas y evitar que se clasifiquen como zombie.
  const sprintIssueSet = new Set(
    sprintPlan ? [
      ...(Array.isArray(sprintPlan.agentes) ? sprintPlan.agentes : []),
      ...(Array.isArray(sprintPlan._queue) ? sprintPlan._queue : []),
      ...(Array.isArray(sprintPlan._completed) ? sprintPlan._completed : []),
      ...(Array.isArray(sprintPlan._incomplete) ? sprintPlan._incomplete : []),
    ].map(a => String(a.issue)) : []
  );

  // Sessions
  // Solo mostrar sesiones active y stale (no done).
  // - active: con actividad reciente (incluyendo sprint sessions que pueden compilar largos)
  // - stale: sin actividad >2h, marcadas por activity-logger.js
  // - done: excluidas — el session-gc.js las limpia después de 1h
  const ZOMBIE_THRESHOLD_MS = 30 * 60 * 1000;
  const sessions = [];
  // Recolectar sesiones del repo principal + worktrees de agentes activos
  const sessionDirs = [SESSIONS_DIR];
  try {
    // Buscar worktrees sibling con sesiones de agentes
    const parentDir = path.resolve(REPO_ROOT, "..");
    const baseName = path.basename(REPO_ROOT);
    const siblings = fs.readdirSync(parentDir).filter(d =>
      d.startsWith(baseName + ".agent-") || d.startsWith(baseName + ".codex-"));
    for (const s of siblings) {
      const wtSessions = path.join(parentDir, s, ".claude", "sessions");
      if (fs.existsSync(wtSessions)) sessionDirs.push(wtSessions);
    }
  } catch(e) { /* ignore */ }
  const seenSessionIds = new Set();
  try {
    for (const sessDir of sessionDirs) {
    if (!fs.existsSync(sessDir)) continue;
      const files = fs.readdirSync(sessDir).filter(f => f.endsWith(".json"));
      for (const f of files) {
        if (seenSessionIds.has(f)) continue; // Deduplicar por filename
        seenSessionIds.add(f);
        const s = readJson(path.join(sessDir, f));
        if (!s) continue;
        // Solo sesiones parent (ignorar sub-agentes)
        if (s.type && s.type !== "parent") continue;
        // Sesiones done: conservar recientes (< 30min) para el flujo de agentes
        if (s.status === "done") {
          const doneAge = now - new Date(s.last_activity_ts || s.started_ts).getTime();
          const DONE_KEEP_MS = 30 * 60 * 1000; // 30 min
          if (doneAge > DONE_KEEP_MS) continue;
        }
        const status = getSessionStatus(s);
        const elapsed = now - new Date(s.last_activity_ts).getTime();
        const issueMatch = (s.branch || "").match(/^(?:agent|feature|bugfix)\/(\d+)/);
        let isSprintSession = issueMatch && sprintIssueSet.has(issueMatch[1]);
        // Fallback: detectar sprint session por modified_files path (worktrees con branch "unknown")
        if (!isSprintSession && Array.isArray(s.modified_files) && s.modified_files.length > 0) {
          for (const issueNum of sprintIssueSet) {
            if (s.modified_files.some(f => f.includes("agent-" + issueNum + "-") || f.includes("codex-" + issueNum + "-"))) {
              isSprintSession = true; break;
            }
          }
        }
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
    const ghPath = "C:\\Workspaces\\gh-cli\\bin\\gh.exe";
    if (fs.existsSync(ghPath)) {
      const raw = execSync('"' + ghPath + '" run list --limit 3 --json status,conclusion,headBranch,displayTitle,createdAt,databaseId', { cwd: REPO_ROOT, timeout: 5000, windowsHide: true }).toString().trim();
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

  // Aggregate agent transitions from sessions of the ACTIVE sprint only
  // Usar normalizeSkillName para deduplicar nodos (#1542)
  const agentTransitions = [];
  const agentNodes = new Set();
  // Track which issues have transitions (to detect missing agents)
  const issuesWithTransitions = new Set();
  // Filter: only sessions belonging to the current sprint's issues
  const _flowPlan = readJson(SPRINT_PLAN_FILE);
  const _flowIssues = new Set();
  if (_flowPlan) {
    for (const a of (_flowPlan.agentes || [])) _flowIssues.add(String(a.issue));
    for (const a of (_flowPlan._queue || [])) _flowIssues.add(String(a.issue));
    for (const a of (_flowPlan._completed || [])) _flowIssues.add(String(a.issue));
    for (const a of (_flowPlan._incomplete || [])) _flowIssues.add(String(a.issue));
  }
  for (const s of sessions) {
    const issueMatch = (s.branch || "").match(/(\d+)/);
    const issueNum = issueMatch ? issueMatch[1] : null;
    // Skip sessions not related to the active sprint (unless it's Main session or no sprint)
    const isMainSession = !s.branch || !s.branch.startsWith("agent/");
    if (_flowIssues.size > 0 && !isMainSession && issueNum && !_flowIssues.has(issueNum)) continue;
    if (Array.isArray(s.agent_transitions)) {
      // For sprint agent sessions, replace "Claude" origin with the agent name
      // so each agent appears as its own root node in the flow graph
      const isSprintAgent = s.branch && s.branch.startsWith("agent/") && s.agent_name;
      const agentRootName = isSprintAgent ? normalizeSkillName(s.agent_name) : null;
      for (const t of s.agent_transitions) {
        let normFrom = normalizeSkillName(t.from);
        // Replace "Claude"/"Main" with the agent's own name for sprint agents
        if (agentRootName && (normFrom === "Claude" || normFrom === "Main")) normFrom = agentRootName;
        const normTo = normalizeSkillName(t.to);
        agentTransitions.push({ ...t, from: normFrom, to: normTo, _session: s.id });
        agentNodes.add(normFrom);
        agentNodes.add(normTo);
        if (issueNum) issuesWithTransitions.add(issueNum);
      }
    }
    // Also add agents from skills_invoked
    if (Array.isArray(s.skills_invoked)) {
      for (const sk of s.skills_invoked) {
        const mapped = AGENT_MAP_DASHBOARD[sk] || sk.replace(/^\//, "");
        agentNodes.add(normalizeSkillName(mapped));
      }
    }
    // Add session agent itself
    if (s.agent_name) agentNodes.add(normalizeSkillName(s.agent_name));
  }

  // Inject "Start" node as sprint root — all agents connect from Start
  if (_flowPlan && _flowIssues.size > 0) {
    agentNodes.add("Start");
    const allSprintStories = [
      ...(_flowPlan.agentes || []),
      ...(_flowPlan._queue || []),
      ...(_flowPlan._completed || []),
      ...(_flowPlan._incomplete || [])
    ];
    for (const ag of allSprintStories) {
      const agSession = sessions.find(s => {
        const m = (s.branch || "").match(/(\d+)/);
        return m && m[1] === String(ag.issue) && s.agent_name;
      });
      const agentNodeName = agSession ? normalizeSkillName(agSession.agent_name) : ("Agente " + ag.numero);
      if (!agentNodes.has(agentNodeName)) agentNodes.add(agentNodeName);
      // Use the agent's session id so the edge gets colored with the agent's color
      const sessionId = agSession ? agSession.id : "synthetic-" + ag.issue;
      agentTransitions.push({ from: "Start", to: agentNodeName, _session: sessionId, _synthetic: true });
    }
  }

  // Inject synthetic transitions for completed sprint agents (pipeline_mode=scripts)
  // When agent-runner.js handles post-Claude phases, the session ends at Review
  // but the agent actually reached Done via the external pipeline
  const sprintPlanData = readJson(SPRINT_PLAN_FILE);
  if (sprintPlanData) {
    // Helper: find session id for an issue
    const findSessionForIssue = (issueStr) => {
      const s = sessions.find(s => { const m = (s.branch || "").match(/(\d+)/); return m && m[1] === issueStr; });
      return s ? s.id : "synthetic-" + issueStr;
    };

    // Completed agents -> Done node
    const completedIssues = (sprintPlanData._completed || []).map(a => String(a.issue));
    for (const issueStr of completedIssues) {
      const sid = findSessionForIssue(issueStr);
      const sessionTransitions = agentTransitions.filter(t => {
        const sess = sessions.find(s => s.id === t._session);
        if (!sess) return false;
        const m = (sess.branch || "").match(/(\d+)/);
        return m && m[1] === issueStr;
      });
      if (sessionTransitions.length > 0) {
        const lastNode = sessionTransitions[sessionTransitions.length - 1].to;
        agentTransitions.push({ from: lastNode, to: "Done", _session: sid, _synthetic: true });
      }
      agentNodes.add("Done");
    }

    // Failed/incomplete agents -> Error node
    const incompleteIssues = (sprintPlanData._incomplete || []).map(a => String(a.issue));
    for (const issueStr of incompleteIssues) {
      const sid = findSessionForIssue(issueStr);
      const sessionTransitions = agentTransitions.filter(t => {
        const sess = sessions.find(s => s.id === t._session);
        if (!sess) return false;
        const m = (sess.branch || "").match(/(\d+)/);
        return m && m[1] === issueStr;
      });
      if (sessionTransitions.length > 0) {
        const lastNode = sessionTransitions[sessionTransitions.length - 1].to;
        agentTransitions.push({ from: lastNode, to: "Error", _session: sid, _synthetic: true });
      } else {
        agentTransitions.push({ from: "Claude", to: "Error", _session: sid, _synthetic: true });
      }
      agentNodes.add("Error");
    }
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

  // Agent Registry — fuente de verdad centralizada para agentes activos (#1642)
  // Sweep: detectar zombies, purgar entradas viejas
  let registryAgents = [];
  let registryActiveCount = 0;
  if (agentRegistry) {
    try {
      agentRegistry.sweepRegistry();
      registryAgents = agentRegistry.getAllAgents();
      registryActiveCount = agentRegistry.countActiveAgents();
    } catch (e) { /* no bloquear dashboard */ }
  }

  // Usar el conteo del registry como fuente de verdad para agentes activos.
  // Si el registry tiene datos, prevalece sobre el conteo de sesiones.
  const effectiveActiveAgents = registryActiveCount > 0 ? registryActiveCount : activeSessions.length;

  const data = {
    timestamp: new Date().toISOString(),
    sessions,
    activeSessions: effectiveActiveAgents,
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
    registryAgents,
    registryActiveCount,
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

// Normalizar nombres de skill/agente a nombre canónico (#1542)
// "PO", "/po", "Po" → "PO"; "tester", "/tester", "Tester" → "Tester"
function normalizeSkillName(name) {
  if (!name) return "Claude";
  const raw = String(name).trim();
  if (!raw) return "Claude";
  // Direct match in AGENT_ICON_MAP (canonical names)
  if (typeof AGENT_ICON_MAP !== "undefined" && AGENT_ICON_MAP[raw]) return raw;
  // Buscar en SKILL_TO_AGENT (con y sin slash)
  const clean = raw.replace(/^\/+/, "").toLowerCase();
  const slashVersion = "/" + clean;
  if (SKILL_TO_AGENT[slashVersion]) return SKILL_TO_AGENT[slashVersion];
  if (AGENT_MAP_DASHBOARD[slashVersion]) return AGENT_MAP_DASHBOARD[slashVersion];
  // Buscar en SKILL_NAME_ALIASES (definido más abajo, lazy check)
  if (typeof SKILL_NAME_ALIASES !== "undefined") {
    if (SKILL_NAME_ALIASES[raw]) return SKILL_NAME_ALIASES[raw];
    if (SKILL_NAME_ALIASES[clean]) return SKILL_NAME_ALIASES[clean];
    if (SKILL_NAME_ALIASES[slashVersion]) return SKILL_NAME_ALIASES[slashVersion];
  }
  // Coincidencia case-insensitive contra nombres canónicos
  for (const val of Object.values(SKILL_TO_AGENT)) {
    if (val.toLowerCase() === clean) return val;
  }
  // Coincidencia case-insensitive contra AGENT_ICON_MAP keys
  if (typeof AGENT_ICON_MAP !== "undefined") {
    for (const key of Object.keys(AGENT_ICON_MAP)) {
      if (key.toLowerCase() === clean) return key;
    }
  }
  return raw;
}

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
    size: "medio",
    started_at: new Date().toISOString(),
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

// --- Normalize skill/agent name to canonical form (#1542) ---
// Alias map: variantes comunes → nombre canónico en AGENT_ICON_MAP / AGENT_COLORS
const SKILL_NAME_ALIASES = {
  // Slash-command forms
  "/guru": "Guru", "/doc": "Doc", "/historia": "Doc", "/refinar": "Doc", "/priorizar": "Doc",
  "/planner": "Planner", "/delivery": "DeliveryManager", "/tester": "Tester",
  "/monitor": "Monitor", "/builder": "Builder", "/review": "Review", "/qa": "QA",
  "/auth": "Auth", "/ux": "UX Specialist", "/scrum": "Scrum Master", "/po": "PO",
  "/backend-dev": "BackendDev", "/android-dev": "AndroidDev", "/ios-dev": "iOSDev",
  "/web-dev": "WebDev", "/desktop-dev": "DesktopDev", "/ops": "Ops", "/branch": "Branch",
  "/security": "Security", "/cleanup": "Cleanup", "/perf": "Perf", "/cost": "Cost", "/hotfix": "Hotfix",
  // Lowercase canonical
  "guru": "Guru", "doc": "Doc", "planner": "Planner", "deliverymanager": "DeliveryManager",
  "tester": "Tester", "monitor": "Monitor", "builder": "Builder", "review": "Review",
  "qa": "QA", "auth": "Auth", "ux specialist": "UX Specialist", "scrum master": "Scrum Master",
  "po": "PO", "backenddev": "BackendDev", "androiddev": "AndroidDev", "iosdev": "iOSDev",
  "webdev": "WebDev", "desktopdev": "DesktopDev", "ops": "Ops", "branch": "Branch",
  "cleanup": "Cleanup", "perf": "Perf", "cost": "Cost", "hotfix": "Hotfix",
  "security": "Security", "claude": "Claude",
  // Hyphenated / spaced variants
  "backend-dev": "BackendDev", "android-dev": "AndroidDev", "ios-dev": "iOSDev",
  "web-dev": "WebDev", "desktop-dev": "DesktopDev",
  "delivery": "DeliveryManager", "delivery-manager": "DeliveryManager",
  "ux": "UX Specialist", "scrum": "Scrum Master",
  // Doc sub-skills
  "historia": "Doc", "refinar": "Doc", "priorizar": "Doc",
  "doc (historia)": "Doc", "doc (refinar)": "Doc", "doc (priorizar)": "Doc",
};

// normalizeSkillName ya definida arriba (línea 588) — esta versión fue removida para evitar duplicación (#1594)

// --- Assign robot SVG icons to root sprint agents (#1544) ---
// Solo agentes raíz (los del sprint-plan.json), no sub-agentes invocados por ellos.
const ROBOT_SVGS_DIR = path.join(ICONS_DIR, "robots");
let _robotSvgFiles = null;

function loadRobotSvgFiles() {
  if (_robotSvgFiles !== null) return _robotSvgFiles;
  try {
    _robotSvgFiles = fs.readdirSync(ROBOT_SVGS_DIR)
      .filter(f => f.endsWith(".svg"))
      .sort()
      .map(f => {
        const buf = fs.readFileSync(path.join(ROBOT_SVGS_DIR, f));
        return "data:image/svg+xml;base64," + buf.toString("base64");
      });
  } catch {
    _robotSvgFiles = [];
  }
  return _robotSvgFiles;
}

function assignRobotIcons(sprintAgents) {
  const robots = loadRobotSvgFiles();
  if (robots.length === 0 || !Array.isArray(sprintAgents)) return {};
  const result = {};
  for (let i = 0; i < sprintAgents.length; i++) {
    const ag = sprintAgents[i];
    // Resolver nombre canónico del agente raíz
    const canonical = normalizeSkillName(
      ag.agent_name || AGENT_MAP_DASHBOARD["/" + ag.skill] || ag.skill || ""
    );
    if (canonical && !result[canonical]) {
      result[canonical] = robots[i % robots.length];
    }
  }
  return result;
}

// --- BUILD FLOW GRAPH SVG (force-directed organic layout) ---
// rootAgentRobotMap: { canonicalName -> robotId } para asignar icono robot a agentes raíz (#1544)
function buildFlowTree(sessions, agentNodes, agentTransitions, AGENT_ICONS, AGENT_COLORS, rootAgentRobotMap) {
  const robotMap = rootAgentRobotMap || {};
  // Deduplicar nodos normalizados (#1542)
  const rawNodes = Array.isArray(agentNodes) ? agentNodes : [];
  const nodeSet = new Set();
  for (const n of rawNodes) {
    nodeSet.add(normalizeSkillName(n));
  }
  const transitions = Array.isArray(agentTransitions) ? agentTransitions : [];
  const nodesWithEdges = new Set();
  for (const t of transitions) { nodesWithEdges.add(normalizeSkillName(t.from)); nodesWithEdges.add(normalizeSkillName(t.to)); }
  const nodes = [...nodeSet].filter(n => nodesWithEdges.has(n));

  if (nodes.length === 0) {
    return '<div class="empty-state">Sin flujo de agentes registrado</div>';
  }

  // Renombrar nodos "Claude" a "Main" — es el agente principal (esta sesión)
  // Los "Agente N" del sprint son entidades diferentes (worktrees independientes)
  const sessionsList = Array.isArray(sessions) ? sessions : [];
  const claudeIdx = nodes.indexOf("Claude");
  if (claudeIdx !== -1) {
    nodes[claudeIdx] = "Main";
    for (const e of transitions) {
      if (e.from === "Claude") e.from = "Main";
      if (e.to === "Claude") e.to = "Main";
    }
  }

  // Determine active/done agents from sessions (con normalización #1542)
  const activeAgents = new Set();
  const doneAgents = new Set();
  for (const s of sessionsList) {
    if (s.agent_name) {
      const norm = normalizeSkillName(s.agent_name);
      if (s._status === "active" || s.status === "active") activeAgents.add(norm);
      if (s._status === "done" || s.status === "done") doneAgents.add(norm);
    }
    if (Array.isArray(s.skills_invoked)) {
      for (const sk of s.skills_invoked) {
        const mapped = normalizeSkillName(AGENT_MAP_DASHBOARD[sk] || sk.replace(/^\//, ""));
        if (!activeAgents.has(mapped)) doneAgents.add(mapped);
      }
    }
  }

  // Build session map for quick lookup (used to resolve branch → issue number)
  const sessionMap = {};
  for (const s of sessionsList) {
    if (s.id) sessionMap[s.id] = s;
  }

  // --- Per-agent edge lists (no global dedup — each agent has its own numbered flow) ---
  const edgeList = [];
  const edgeSet = new Set(); // for layout adjacency (unique node pairs)
  const now = Date.now();

  // Group transitions by root agent (session → root agent name)
  const sessionToRoot = {};
  for (const s of sessionsList) {
    if (s.id && s.agent_name) sessionToRoot[s.id] = s.agent_name;
  }
  // Map synthetic session ids to their agent names
  for (const t of transitions) {
    if (t._synthetic && t._session && t._session.startsWith("synthetic-")) {
      // "synthetic-1659" → find agent name from real sessions
      const issueStr = t._session.replace("synthetic-", "");
      const realSess = sessionsList.find(s => { const m = (s.branch || "").match(/(\d+)/); return m && m[1] === issueStr && s.agent_name; });
      if (realSess) sessionToRoot[t._session] = realSess.agent_name;
    }
  }

  // Identify which sessions belong to Main: any session whose transitions include
  // "Main" as source node (i.e. Claude-renamed sessions)
  const mainSessionIds = new Set();
  for (const t of transitions) {
    if (t.from === "Main" && t._session) mainSessionIds.add(t._session);
  }

  // Collect transitions per root agent
  const agentEdges = {}; // rootName → [{from, to, ...}]
  const mainEdgeSet = new Set(); // Main edges dedup globally (no duplicates — reduces noise)
  for (const t of transitions) {
    if (!nodes.includes(t.from) || !nodes.includes(t.to)) continue;
    // If this session ever had a Main→X transition, ALL its transitions belong to Main
    let rootName = mainSessionIds.has(t._session) ? "Main"
      : (t._session ? (sessionToRoot[t._session] || "Main") : "Main");
    if (rootName === "Claude") rootName = "Main";
    if (!agentEdges[rootName]) agentEdges[rootName] = [];
    const pairKey = t.from + "->" + t.to;
    if (rootName === "Main") {
      // Main: dedup globally — never duplicate edges from Main
      if (mainEdgeSet.has(pairKey)) continue;
      mainEdgeSet.add(pairKey);
    } else {
      // Other agents: dedup within same agent only
      if (agentEdges[rootName].some(e => e.from === t.from && e.to === t.to)) continue;
    }
    agentEdges[rootName].push({ from: t.from, to: t.to, ts: t.ts, _session: t._session });
    edgeSet.add(pairKey);
  }

  // Build edgeList with per-agent sequence numbers
  // Format: "agentNum.stepNum" (e.g. "1.1", "1.2", "2.1")
  let edgeSeq = 0;
  for (const [rootName, edges] of Object.entries(agentEdges)) {
    const agentMatch = rootName.match(/^Agente\s+(\d+)$/i);
    const agentNum = agentMatch ? agentMatch[1] : "0";
    const session = edges[0] && edges[0]._session ? (sessionMap[edges[0]._session] || null) : null;
    const branchMatch = session ? (session.branch || "").match(/(\d+)/) : null;
    const issueNum = branchMatch ? branchMatch[1] : null;
    edges.forEach((e, i) => {
      edgeSeq++;
      const isRecent = e.ts ? (now - new Date(e.ts).getTime() < 5 * 60 * 1000) : false;
      edgeList.push({ from: e.from, to: e.to, seq: edgeSeq, agentSeq: agentNum + "." + (i + 1), agentRoot: rootName, issueNum, isRecent });
    });
  }

  // --- Terminal nodes: Done (success) and Error (failure) ---
  const _out = {}, _in = {};
  for (const n of nodes) { _out[n] = new Set(); _in[n] = new Set(); }
  for (const e of edgeList) { if (_out[e.from]) _out[e.from].add(e.to); if (_in[e.to]) _in[e.to].add(e.from); }
  for (const root of nodes.filter(n => /^Agente\s+\d+$/i.test(n))) {
    // Find last node in this agent's chain
    const myEdges = edgeList.filter(e => e.agentRoot === root);
    let last = root;
    if (myEdges.length > 0) last = myEdges[myEdges.length - 1].to;
    const sess = sessionsList.find(s => s.agent_name === root);
    const isDone = sess && (sess._status === "done" || sess.status === "done" || sess._status === "stale" || sess.status === "stale");
    const isError = sess && (sess._status === "error" || sess.status === "error");
    const isActive = sess && (sess._status === "active" || sess.status === "active");
    if (isDone && !isActive) {
      if (!nodes.includes("Done")) nodes.push("Done");
      const agentMatch = root.match(/^Agente\s+(\d+)$/i);
      const agentNum = agentMatch ? agentMatch[1] : "0";
      const stepNum = myEdges.length + 1;
      edgeSeq++;
      edgeList.push({ from: last, to: "Done", seq: edgeSeq, agentSeq: agentNum + "." + stepNum, agentRoot: root, issueNum: null, isRecent: false });
    } else if (isError) {
      if (!nodes.includes("Error")) nodes.push("Error");
      const agentMatch = root.match(/^Agente\s+(\d+)$/i);
      const agentNum = agentMatch ? agentMatch[1] : "0";
      const stepNum = myEdges.length + 1;
      edgeSeq++;
      edgeList.push({ from: last, to: "Error", seq: edgeSeq, agentSeq: agentNum + "." + stepNum, agentRoot: root, issueNum: null, isRecent: false });
    }
  }

  // --- Layered layout con grid routing ---
  const nodeR = 56;

  // Build directed adjacency (from → [to])
  const outEdges = {};
  const inEdges = {};
  for (const n of nodes) { outEdges[n] = []; inEdges[n] = []; }
  for (const e of edgeList) {
    if (outEdges[e.from]) outEdges[e.from].push(e.to);
    if (inEdges[e.to]) inEdges[e.to].push(e.from);
  }

  // Assign layers via BFS — cycle-safe: each node visited at most once
  const layer = {};
  const visited = new Set();
  const roots = nodes.filter(n => inEdges[n].length === 0);
  if (roots.length === 0 && nodes.length > 0) roots.push(nodes[0]);
  const queue = [...roots];
  for (const r of roots) { layer[r] = 0; visited.add(r); }
  while (queue.length > 0) {
    const n = queue.shift();
    for (const next of (outEdges[n] || [])) {
      if (!visited.has(next)) {
        visited.add(next);
        layer[next] = layer[n] + 1;
        queue.push(next);
      }
    }
  }
  const maxLayer = Math.max(0, ...Object.values(layer));
  for (const n of nodes) {
    if (layer[n] === undefined) layer[n] = Math.min(maxLayer + 1, nodes.length - 1);
  }

  // Force specific layers for sprint structure:
  // Layer 0: Start only
  // Layer 1: Agent nodes only (Agente 1, Agente 2, etc.)
  // Layer 2+: Skills (PO, BackendDev, Review, etc.)
  // Last layer: Done, Error
  if (nodes.includes("Start")) {
    layer["Start"] = 0;
    // Push all agent nodes to layer 1
    const agentPattern = /^Agente\s+/i;
    for (const n of nodes) {
      if (agentPattern.test(n)) layer[n] = 1;
    }
    // Push all non-agent, non-terminal, non-Start nodes to layer >= 2
    for (const n of nodes) {
      if (n === "Start" || n === "Done" || n === "Error" || agentPattern.test(n)) continue;
      if (layer[n] <= 1) layer[n] = 2;
    }
  }

  // Force terminal nodes to rightmost layer
  const terminalLayer = Math.max(3, ...Object.values(layer)) + 1;
  if (nodes.includes("Done")) { layer["Done"] = terminalLayer; }
  if (nodes.includes("Error")) { layer["Error"] = terminalLayer; }

  // Agrupar nodos por capa
  const layers = {};
  for (const n of nodes) {
    const l = layer[n];
    if (!layers[l]) layers[l] = [];
    layers[l].push(n);
  }
  const numLayers = Math.max(...Object.keys(layers).map(Number)) + 1;

  const colSpacing = 240;
  const rowSpacing = 160;
  const maxNodesInLayer = Math.max(...Object.values(layers).map(l => l.length));
  const padding = nodeR + 50;
  const svgW = Math.max(1000, numLayers * colSpacing + padding * 2);
  const svgH = Math.max(600, maxNodesInLayer * rowSpacing + padding * 2);

  // Posicionar nodos: columna = capa, fila = índice dentro de la capa (centrado)
  const positions = {};
  for (const [layerIdx, layerNodes] of Object.entries(layers)) {
    const col = Number(layerIdx);
    const x = padding + col * colSpacing + colSpacing / 2;
    const count = layerNodes.length;
    const totalH = (count - 1) * rowSpacing;
    const startY = svgH / 2 - totalH / 2;
    layerNodes.forEach((name, i) => {
      positions[name] = { x, y: startY + i * rowSpacing };
    });
  }

  // Trazar origen de cada edge hasta su agente raíz (capa 0) para asignar color
  // 20 distinct colors — enough for any sprint, never repeat between agents
  const rootColors = [
    "#f87171", "#60a5fa", "#4ade80", "#fbbf24", "#a78bfa",
    "#f472b6", "#fb923c", "#22d3ee", "#e879f9", "#84cc16",
    "#f59e0b", "#06b6d4", "#ec4899", "#14b8a6", "#8b5cf6",
    "#ef4444", "#3b82f6", "#10b981", "#f97316", "#6366f1",
  ];
  const rootNodeList = nodes.filter(n => layer[n] === 0);
  const rootColorMap = {};
  rootNodeList.forEach((r, i) => { rootColorMap[r] = rootColors[i] || rootColors[i % rootColors.length]; });
  // BFS desde cada raíz para asignar "owner" a cada nodo
  const nodeOwner = {};
  for (const root of rootNodeList) {
    const bfsQ = [root];
    nodeOwner[root] = root;
    while (bfsQ.length > 0) {
      const cur = bfsQ.shift();
      for (const next of (outEdges[cur] || [])) {
        if (!nodeOwner[next]) { nodeOwner[next] = root; bfsQ.push(next); }
      }
    }
  }
  // Asignar color de edge según el agente raíz del nodo "from"
  function edgeColor(fromNode) {
    const owner = nodeOwner[fromNode];
    return owner ? (rootColorMap[owner] || "#60a5fa") : "#60a5fa";
  }

  // Build SVG defs — markers dinámicos por color de agente raíz
  const usedColors = new Set();
  for (const e of edgeList) usedColors.add(edgeColor(e.from));
  let markerDefs = "";
  for (const c of usedColors) {
    const id = "fa-" + c.replace("#", "");
    markerDefs += '<marker id="' + id + '" markerWidth="7" markerHeight="5" refX="6" refY="2.5" orient="auto"><polygon points="0 0, 7 2.5, 0 5" fill="' + c + '" opacity="0.85"/></marker>';
  }

  let svg = '<defs>' + markerDefs + `
    <filter id="node-glow"><feGaussianBlur stdDeviation="6" result="coloredBlur"/>
      <feMerge><feMergeNode in="coloredBlur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="icon-brighten" color-interpolation-filters="sRGB">
      <feComponentTransfer>
        <feFuncR type="linear" slope="1.5" intercept="0.2"/>
        <feFuncG type="linear" slope="1.5" intercept="0.2"/>
        <feFuncB type="linear" slope="1.5" intercept="0.2"/>
      </feComponentTransfer>
    </filter>
    <style>
      @keyframes flow-dash { to { stroke-dashoffset: 0; } }
      @keyframes node-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
      .flow-edge { stroke-dasharray: 8 6; stroke-dashoffset: 28; animation: flow-dash 1.2s linear infinite; }
      .node-active { animation: node-pulse 2s ease-in-out infinite; }
    </style>
  </defs>`;

  // --- Grid-based A* routing para flechas sin colisiones ---
  // Resolución fina para ruteo preciso
  const gridCell = Math.max(12, Math.round(nodeR * 0.5));
  const gridW = Math.ceil(svgW / gridCell);
  const gridH = Math.ceil(svgH / gridCell);
  // Grid de ocupación: 0=libre, 1=nodo (bloqueante duro), 2=flecha previa (penalizada)
  const grid = Array.from({ length: gridH }, () => new Uint8Array(gridW));

  // Helper: marcar celda si está en rango
  function markCell(gx, gy, val) {
    if (gy >= 0 && gy < gridH && gx >= 0 && gx < gridW) {
      grid[gy][gx] = Math.max(grid[gy][gx], val);
    }
  }

  // Marcar celdas ocupadas por nodos — área circular + zona del label
  const blockRadius = nodeR + 12; // margen alrededor del nodo (círculo)
  const labelExtraBelow = 35; // espacio del label debajo del nodo
  for (const name of nodes) {
    const p = positions[name];
    if (!p) continue;
    const gcx = Math.round(p.x / gridCell);
    const gcy = Math.round(p.y / gridCell);
    const rCells = Math.ceil(blockRadius / gridCell);
    const labelCells = Math.ceil((blockRadius + labelExtraBelow) / gridCell);
    // Círculo bloqueante alrededor del nodo
    for (let dy = -rCells; dy <= labelCells; dy++) {
      for (let dx = -rCells; dx <= rCells; dx++) {
        const px = dx * gridCell, py = dy * gridCell;
        // Arriba y a los lados: área circular
        if (dy <= rCells) {
          const dist = Math.sqrt(px * px + Math.min(py, 0) ** 2);
          if (dist <= blockRadius) markCell(gcx + dx, gcy + dy, 1);
        }
        // Debajo del nodo: rectángulo para el label
        if (dy > 0 && dy <= labelCells && Math.abs(dx) <= Math.ceil(60 / gridCell)) {
          markCell(gcx + dx, gcy + dy, 1);
        }
      }
    }
  }

  // A* pathfinding en la grilla
  function gridRoute(sx, sy, tx, ty) {
    const sgx = Math.max(0, Math.min(gridW - 1, Math.round(sx / gridCell)));
    const sgy = Math.max(0, Math.min(gridH - 1, Math.round(sy / gridCell)));
    const tgx = Math.max(0, Math.min(gridW - 1, Math.round(tx / gridCell)));
    const tgy = Math.max(0, Math.min(gridH - 1, Math.round(ty / gridCell)));

    // Liberar celdas de start y target (están dentro de nodos)
    const savedS = grid[sgy][sgx]; grid[sgy][sgx] = 0;
    const savedT = grid[tgy][tgx]; grid[tgy][tgx] = 0;

    const key = (x, y) => y * gridW + x;
    const open = [{ x: sgx, y: sgy, g: 0, f: 0 }];
    const gScore = new Map(); gScore.set(key(sgx, sgy), 0);
    const cameFrom = new Map();
    const dirs = [[1,0],[0,1],[-1,0],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];

    let found = false;
    let maxIter = Math.min(2000, gridW * gridH);
    while (open.length > 0 && maxIter-- > 0) {
      open.sort((a, b) => a.f - b.f);
      const cur = open.shift();
      if (cur.x === tgx && cur.y === tgy) { found = true; break; }

      for (const [ddx, ddy] of dirs) {
        const nx = cur.x + ddx, ny = cur.y + ddy;
        if (nx < 0 || nx >= gridW || ny < 0 || ny >= gridH) continue;
        if (grid[ny][nx] === 1) continue; // nodo bloqueante
        const cost = (ddx !== 0 && ddy !== 0) ? 1.41 : 1;
        const edgePenalty = grid[ny][nx] === 2 ? 8 : 0; // penalizar fuerte celdas con flechas previas
        const ng = cur.g + cost + edgePenalty;
        const k = key(nx, ny);
        if (!gScore.has(k) || ng < gScore.get(k)) {
          gScore.set(k, ng);
          const h = Math.abs(nx - tgx) + Math.abs(ny - tgy);
          open.push({ x: nx, y: ny, g: ng, f: ng + h });
          cameFrom.set(k, key(cur.x, cur.y));
        }
      }
    }

    // Restaurar grid
    grid[sgy][sgx] = savedS;
    grid[tgy][tgx] = savedT;

    if (!found) return null; // fallback a línea recta

    // Reconstruir path
    const path = [];
    let ck = key(tgx, tgy);
    while (ck !== undefined) {
      const cy = Math.floor(ck / gridW), cx = ck % gridW;
      path.unshift({ x: cx * gridCell, y: cy * gridCell });
      ck = cameFrom.get(ck);
    }

    // Marcar celdas de esta flecha como ocupadas (peso 2) con ancho de 3 celdas
    for (const pt of path) {
      const gx = Math.round(pt.x / gridCell), gy = Math.round(pt.y / gridCell);
      for (let ddy = -1; ddy <= 1; ddy++) {
        for (let ddx = -1; ddx <= 1; ddx++) {
          const nx = gx + ddx, ny = gy + ddy;
          if (ny >= 0 && ny < gridH && nx >= 0 && nx < gridW && grid[ny][nx] === 0) grid[ny][nx] = 2;
        }
      }
    }

    return path;
  }

  // Simplificar path: eliminar puntos colineales
  function simplifyPath(pts) {
    if (pts.length <= 2) return pts;
    const result = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const prev = result[result.length - 1];
      const next = pts[i + 1];
      const cur = pts[i];
      // Si los 3 puntos son colineales, skip el del medio
      const dx1 = cur.x - prev.x, dy1 = cur.y - prev.y;
      const dx2 = next.x - cur.x, dy2 = next.y - cur.y;
      if (Math.abs(dx1 * dy2 - dy1 * dx2) > 0.1) result.push(cur);
    }
    result.push(pts[pts.length - 1]);
    return result;
  }

  // Convertir path a SVG con esquinas redondeadas
  function pathToSvg(pts, fromPos, toPos) {
    if (!pts || pts.length < 2) {
      return "M" + fromPos.x.toFixed(1) + "," + fromPos.y.toFixed(1) + " L" + toPos.x.toFixed(1) + "," + toPos.y.toFixed(1);
    }
    const simple = simplifyPath(pts);
    simple[0] = { ...fromPos };
    simple[simple.length - 1] = { ...toPos };

    if (simple.length === 2) {
      return "M" + simple[0].x.toFixed(1) + "," + simple[0].y.toFixed(1) + " L" + simple[1].x.toFixed(1) + "," + simple[1].y.toFixed(1);
    }

    // Path con esquinas redondeadas usando arcos cuadráticos
    const r = gridCell * 0.6; // radio de redondeo
    let d = "M" + simple[0].x.toFixed(1) + "," + simple[0].y.toFixed(1);
    for (let i = 1; i < simple.length - 1; i++) {
      const prev = simple[i - 1], cur = simple[i], next = simple[i + 1];
      const d1 = Math.sqrt((cur.x - prev.x) ** 2 + (cur.y - prev.y) ** 2);
      const d2 = Math.sqrt((next.x - cur.x) ** 2 + (next.y - cur.y) ** 2);
      const rr = Math.min(r, d1 / 2, d2 / 2);
      if (rr < 1) { d += " L" + cur.x.toFixed(1) + "," + cur.y.toFixed(1); continue; }
      const ux1 = (cur.x - prev.x) / d1, uy1 = (cur.y - prev.y) / d1;
      const ux2 = (next.x - cur.x) / d2, uy2 = (next.y - cur.y) / d2;
      const bx = cur.x - ux1 * rr, by = cur.y - uy1 * rr;
      const cx = cur.x + ux2 * rr, cy = cur.y + uy2 * rr;
      d += " L" + bx.toFixed(1) + "," + by.toFixed(1);
      d += " Q" + cur.x.toFixed(1) + "," + cur.y.toFixed(1) + " " + cx.toFixed(1) + "," + cy.toFixed(1);
    }
    d += " L" + simple[simple.length - 1].x.toFixed(1) + "," + simple[simple.length - 1].y.toFixed(1);
    return d;
  }

  // Draw edges con A* routing
  for (const e of edgeList) {
    const from = positions[e.from];
    const to = positions[e.to];
    if (!from || !to) continue;
    const dx = to.x - from.x, dy = to.y - from.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1) continue;
    const ux = dx / dist, uy = dy / dist;
    // Offset perpendicular for parallel edges between same node pair
    const pairKey = e.from + "->" + e.to;
    const pairEdges = edgeList.filter(x => x.from === e.from && x.to === e.to);
    const pairIdx = pairEdges.indexOf(e);
    const pairCount = pairEdges.length;
    const perpOff = pairCount > 1 ? (pairIdx - (pairCount - 1) / 2) * 12 : 0;
    const px = -uy * perpOff, py = ux * perpOff; // perpendicular vector
    const x1 = from.x + ux * (nodeR + 6) + px;
    const y1 = from.y + uy * (nodeR + 6) + py;
    const x2 = to.x - ux * (nodeR + 10) + px;
    const y2 = to.y - uy * (nodeR + 10) + py;

    const route = gridRoute(x1, y1, x2, y2);
    const pathD = pathToSvg(route, { x: x1, y: y1 }, { x: x2, y: y2 });

    // Color by root agent (not from-node) so each agent's flow has consistent color
    const ec = e.agentRoot ? edgeColor(e.agentRoot) : edgeColor(e.from);
    const markerId = "fa-" + ec.replace("#", "");

    const isStartEdge = e.from === "Start" || e.to === "Start";
    const edgeRootAttr = isStartEdge ? ' data-flow-root="sprint"' : (e.agentRoot === "Main") ? ' data-flow-root="main"' : ' data-flow-root="agent"';
    svg += '<g' + edgeRootAttr + '>';
    svg += '<path class="flow-edge" d="' + pathD + '" fill="none" stroke="' + ec + '" stroke-width="2.5" stroke-opacity="0.8" marker-end="url(#' + markerId + ')"/>';
    // Edge label: per-agent sequence (e.g. "1.2" = Agent 1, step 2)
    const label = e.agentSeq || String(e.seq);
    const labelR = label.length > 3 ? 12 : 9;
    const mx = ((x1 + x2) / 2).toFixed(1), my = ((y1 + y2) / 2).toFixed(1);
    svg += `<circle cx="${mx}" cy="${my}" r="${labelR}" fill="var(--bg, #0a0b10)" stroke="${ec}" stroke-width="1.5"/>`;
    svg += `<text x="${mx}" y="${(parseFloat(my) + 3.5).toFixed(1)}" text-anchor="middle" font-size="${label.length > 3 ? 7 : 8}" font-weight="700" fill="${ec}">${label}</text>`;
    svg += '</g>';
  }

  // Draw nodes
  const imgSize = nodeR * 1.4;
  let _claudeIdx = 0;
  for (const name of nodes) {
    const pos = positions[name];
    if (!pos) continue;
    const color = (AGENT_COLORS && AGENT_COLORS[name]) || "#6C7086";
    // Resolve icon: usar robot SVG para agentes raíz (#1544)
    // Primero intentar robotMap (sprint-plan), luego patrón "Agente N"
    let robotId = robotMap[name];
    if (!robotId) {
      const agentMatch = name.match(/^Agente\s+(\d+)$/i);
      if (agentMatch) robotId = ((parseInt(agentMatch[1], 10) - 1) % 10) + 1;
    }
    const hasRobot = robotId && ROBOT_ICONS[robotId];
    const iconUrl = hasRobot ? ROBOT_ICONS[robotId] : resolveIconUri(name);
    const isActive = activeAgents.has(name);
    const isDone = doneAgents.has(name);
    // Todos los nodos con transiciones se muestran al 100% — no grisar nodos participantes
    const opacity = "1";
    const filterAttr = isActive ? 'filter="url(#node-glow)"' : '';
    // Nodo raíz con robot tiene radio ligeramente mayor
    const effectiveR = hasRobot ? nodeR + 4 : nodeR;
    const effectiveImgSize = hasRobot ? effectiveR * 1.6 : imgSize;

    // Determine visibility category for toggle:
    // "sprint" = always visible (Start, Done, Error, Agent nodes)
    // "agent" = visible by default (skills used by agents)
    // "main" = hidden by default (Main session skills)
    const isSprintInfra = name === "Start" || name === "Done" || name === "Error" || /^Agente\s+/i.test(name);
    let flowRootAttr;
    if (isSprintInfra) {
      flowRootAttr = 'data-flow-root="sprint"';
    } else if (name === "Main") {
      flowRootAttr = 'data-flow-root="main"';
    } else {
      const nodeEdgesAsTarget = edgeList.filter(e => e.to === name);
      const nodeEdgesAsSource = edgeList.filter(e => e.from === name);
      const allNodeEdges = [...nodeEdgesAsTarget, ...nodeEdgesAsSource];
      const isMainOnly = allNodeEdges.length > 0 && allNodeEdges.every(e => e.agentRoot === "Main");
      flowRootAttr = isMainOnly ? 'data-flow-root="main"' : 'data-flow-root="agent"';
    }

    const activeClass = isActive ? ' node-active' : '';
    svg += `<g class="flow-node${activeClass}" data-agent="${escHtml(name)}" ${flowRootAttr} style="cursor:pointer;" ${filterAttr}>`;
    // Fondo del nodo
    svg += `<circle cx="${pos.x.toFixed(1)}" cy="${pos.y.toFixed(1)}" r="${effectiveR}" fill="rgba(255,255,255,0.10)" stroke="${color}" stroke-width="${hasRobot ? '4' : '3'}"/>`;
    // Halo pulsante para nodos activos
    if (isActive) {
      svg += `<circle cx="${pos.x.toFixed(1)}" cy="${pos.y.toFixed(1)}" r="${effectiveR + 8}" fill="none" stroke="${color}" stroke-width="2"><animate attributeName="r" values="${effectiveR + 4};${effectiveR + 14};${effectiveR + 4}" dur="2s" repeatCount="indefinite"/><animate attributeName="stroke-opacity" values="0.8;0.1;0.8" dur="2s" repeatCount="indefinite"/></circle>`;
    }
    // Círculo de color semitransparente detrás del icono para contraste
    svg += `<circle cx="${pos.x.toFixed(1)}" cy="${pos.y.toFixed(1)}" r="${(effectiveR - 3).toFixed(1)}" fill="${color}" fill-opacity="${hasRobot ? '0.15' : '0.30'}"/>`;
    // Icon: filter brighten para garantizar visibilidad sobre fondo oscuro
    if (iconUrl) {
      svg += `<image href="${iconUrl}" x="${(pos.x - effectiveImgSize / 2).toFixed(1)}" y="${(pos.y - effectiveImgSize / 2).toFixed(1)}" width="${effectiveImgSize.toFixed(0)}" height="${effectiveImgSize.toFixed(0)}" style="pointer-events:none;" filter="url(#icon-brighten)"/>`;
      if (isDone && !isActive) {
        svg += `<circle cx="${(pos.x + effectiveImgSize/2 - 2).toFixed(1)}" cy="${(pos.y - effectiveImgSize/2 + 2).toFixed(1)}" r="5" fill="${color}"/>`;
        svg += `<text x="${(pos.x + effectiveImgSize/2 - 2).toFixed(1)}" y="${(pos.y - effectiveImgSize/2 + 5).toFixed(1)}" text-anchor="middle" font-size="7" fill="white">&#10003;</text>`;
      }
    } else if (isDone && !isActive) {
      svg += `<text x="${pos.x.toFixed(1)}" y="${(pos.y + 5).toFixed(1)}" text-anchor="middle" font-size="16" fill="${color}">&#10003;</text>`;
    }
    // Badge de robot ID para agentes raíz (#1544)
    if (hasRobot) {
      svg += `<circle cx="${(pos.x + effectiveR - 3).toFixed(1)}" cy="${(pos.y - effectiveR + 3).toFixed(1)}" r="8" fill="${color}" stroke="var(--bg, #0a0b10)" stroke-width="1.5"/>`;
      svg += `<text x="${(pos.x + effectiveR - 3).toFixed(1)}" y="${(pos.y - effectiveR + 6.5).toFixed(1)}" text-anchor="middle" font-size="8" font-weight="700" fill="white">${robotId}</text>`;
    }
    // Label below node — nombre completo sin truncar
    svg += `<text x="${pos.x.toFixed(1)}" y="${(pos.y + effectiveR + 16).toFixed(1)}" text-anchor="middle" font-size="13" fill="var(--text-dim)" font-weight="600">${escHtml(name)}</text>`;
    // Issue number debajo del nombre para agentes raíz
    if (hasRobot) {
      const agentSession = sessionsList.find(s => s.agent_name === name);
      const branchMatch = agentSession ? (agentSession.branch || "").match(/(\d+)/) : null;
      if (branchMatch) {
        const issueUrl = "https://github.com/intrale/platform/issues/" + branchMatch[1];
        svg += `<a href="${issueUrl}" target="_blank"><text x="${pos.x.toFixed(1)}" y="${(pos.y + effectiveR + 30).toFixed(1)}" text-anchor="middle" font-size="11" fill="#60a5fa" font-weight="500" style="cursor:pointer;text-decoration:underline;">#${branchMatch[1]}</text></a>`;
      }
    }
    svg += `</g>`;
  }

  const minH = Math.max(400, svgH);
  return `<div style="overflow-x:auto;"><svg class="flow-graph-svg" viewBox="0 0 ${svgW} ${svgH}" preserveAspectRatio="xMidYMid meet" style="width:100%;min-height:${minH}px;height:auto;">${svg}</svg></div>`;
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

  // Filter to show exactly 5 sprints: last executed (done) + active (if any) + next planned
  const allSprints = [...roadmap.sprints].sort((a, b) => a.id.localeCompare(b.id));
  const doneList = allSprints.filter(s => s.status === "done");
  const activeList = allSprints.filter(s => s.status === "active" || s.status === "in_progress");
  const plannedList = allSprints.filter(s => s.status === "planned");
  // Last done: most recently closed (by closed_at timestamp, fallback to last by ID)
  doneList.sort((a, b) => (b.closed_at || "").localeCompare(a.closed_at || "") || b.id.localeCompare(a.id));
  const lastDone = doneList.length > 0 ? [doneList[0]] : [];
  // Fill remaining 4 slots: active first, then planned by ID order
  const remaining = [...activeList, ...plannedList].slice(0, 5 - lastDone.length);
  const sprints = [...lastDone, ...remaining].slice(0, 5);
  const numSprints = sprints.length;

  // Collect all issues with sprint index
  const allIssues = [];
  for (let si = 0; si < sprints.length; si++) {
    const spr = sprints[si];
    for (const iss of (spr.stories || spr.issues || [])) {
      // Normalizar campos: roadmap usa issue/effort, chart espera number/size
      const normalized = { ...iss };
      if (!normalized.number && normalized.issue) normalized.number = normalized.issue;
      if (!normalized.size && normalized.effort) {
        const effortMap = { "simple": "S", "medio": "M", "grande": "L" };
        normalized.size = effortMap[normalized.effort] || "M";
      }
      allIssues.push({ ...normalized, _sprintIdx: si, _sprintId: spr.id });
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

    // Status icon + Sprint label (ID) + Size badge
    const statusIcon = spr.status === "done" ? "✅" : (spr.status === "active" || spr.status === "in_progress") ? "▶️" : "⏳";
    const sizeLabel = spr.size ? ` [${spr.size}]` : "";
    svg += `<text x="${x + colW / 2}" y="24" text-anchor="middle" font-size="18" font-weight="700" fill="var(--white)" opacity="0.9">${statusIcon} ${escHtml(spr.id)}${escHtml(sizeLabel)}</text>`;
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
      const isDone = status === "done";
      const opacity = isDone ? 0.5 : (STATUS_OPACITY[status] !== undefined ? STATUS_OPACITY[status] : 1);
      const fillColor = isDone ? "#6b7280" : status === "blocked" ? "#f87171" : color;
      const barFillOpacity = isDone ? 0.35 : 0.22;
      const barStroke = isDone ? "#9ca3af" : fillColor;

      // Main bar
      const issueUrl = `https://github.com/intrale/platform/issues/${iss.number}`;
      svg += `<g opacity="${opacity}">`;
      svg += `<a href="${issueUrl}" target="_blank" rel="noopener noreferrer" class="gantt-bar-link">`;
      svg += `<rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" fill="${fillColor}" fill-opacity="${barFillOpacity}" stroke="${barStroke}" stroke-width="1" rx="3" style="cursor:pointer;">`;
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
    // Para agentes raíz "Agente N", usar robot SVG igual que en el flujo
    const agentMatch = (name || "").match(/^Agente\s+(\d+)$/i);
    if (agentMatch) {
      const rId = ((parseInt(agentMatch[1], 10) - 1) % 10) + 1;
      if (ROBOT_ICONS[rId]) {
        return '<img src="' + ROBOT_ICONS[rId] + '" width="20" height="20" style="vertical-align:middle;margin-right:2px;border-radius:50%;" alt="' + escHtml(name) + '">';
      }
    }
    const uri = resolveIconUri(name);
    return uri
      ? '<img src="' + uri + '" width="20" height="20" style="vertical-align:middle;margin-right:2px;" alt="' + escHtml(name || "") + '">'
      : "&#129302;";
  }
  const AGENT_ICONS = {};
  for (const name of Object.keys(AGENT_ICON_MAP)) AGENT_ICONS[name] = agentIconHtml(name);
  for (const [skill, agent] of Object.entries(SKILL_TO_AGENT)) AGENT_ICONS[skill] = agentIconHtml(agent);

  // Robot icons para agentes raíz del sprint (#1544)
  const sprintAgentsList = data.sprintPlan && Array.isArray(data.sprintPlan.agentes) ? data.sprintPlan.agentes : [];
  const robotIconMap = assignRobotIcons(sprintAgentsList);
  // Generar HTML para robot icons y mergear (prioridad sobre default solo en grafo)
  const ROBOT_ICON_HTML = {};
  for (const [name, uri] of Object.entries(robotIconMap)) {
    ROBOT_ICON_HTML[name] = '<img src="' + uri + '" width="18" height="18" style="vertical-align:middle;margin-right:2px;border-radius:50%;" alt="' + escHtml(name) + '">';
  }

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
    "Branch": "#84cc16", "Cleanup": "#78716c", "Security": "#ef4444",
    "Perf": "#eab308", "Cost": "#06b6d4", "Hotfix": "#dc2626",
    "Claude": "#9399b2", "Main": "#D4A574", "Config": "#a8a29e",
    "Done": "#34d399", "Error": "#ef4444",
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
  const spIncomplete = data.sprintPlan && Array.isArray(data.sprintPlan._incomplete) ? data.sprintPlan._incomplete : [];
  const allSprintAgentes = [...spAgentes, ...spQueue, ...spCompleted, ...spIncomplete];

  // Helper para renderizar una fila de agente del sprint
  function renderSprintAgentRow(ag, forcedStatus) {
    // Buscar sesión del agente: por branch, modified_files path, o slug
    const agIssueStr = String(ag.issue);
    const agSlug = ag.slug || "";
    const worktreePattern = "agent-" + agIssueStr + "-";
    const matchSession = [...data.sprintSessions, ...(data.sessions || [])].find(s => {
      // Match por branch con issue number
      const issueMatch = (s.branch || "").match(/(\d+)/);
      if (issueMatch && issueMatch[1] === agIssueStr) return true;
      // Match por modified_files path que contenga el worktree name (platform.agent-NNN-slug)
      if (Array.isArray(s.modified_files) && s.modified_files.length > 0) {
        if (s.modified_files.some(f => f.includes(worktreePattern))) return true;
      }
      // Match por current_task que mencione el issue
      if (s.current_task && s.current_task.includes("#" + agIssueStr)) return true;
      return false;
    });
    const agStatus = forcedStatus || (matchSession ? matchSession._status : "pending");
    const statusIcon = agStatus === "active" ? "&#9679;" : agStatus === "idle" ? "&#9684;" : agStatus === "done" ? "&#10003;" : agStatus === "stale" ? "&#9632;" : "&#9675;";
    const statusColor = STATUS_COLORS[agStatus] || "var(--text-muted)";
    const isBlocked = matchSession && blockedPids.has(matchSession.id);
    const tasks = matchSession ? (matchSession.current_tasks || []) : [];
    const tasksDone = tasks.filter(t => t.status === "completed").length;
    const actionCount = matchSession ? (matchSession.action_count || 0) : 0;
    let tasksPct;
    if (forcedStatus === "done") {
      tasksPct = 100;
    } else if (tasks.length > 0) {
      tasksPct = Math.round((tasksDone / tasks.length) * 100);
    } else if (agStatus === "done" || agStatus === "stale") {
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
    // Estimado de tiempo restante basado en tamaño y progreso
    let etaHtml = "";
    if (agStatus === "active" && matchSession && matchSession.started_ts) {
      const sizeMinutes = { S: 15, M: 45, L: 90, XL: 180 };
      const expectedMin = sizeMinutes[ag.size] || 45;
      const elapsedMin = Math.round((Date.now() - new Date(matchSession.started_ts).getTime()) / 60000);
      const progress = tasksPct / 100;
      let remainMin;
      if (progress > 0.1) {
        // Extrapolación basada en progreso real
        const totalEstimated = elapsedMin / progress;
        remainMin = Math.max(0, Math.round(totalEstimated - elapsedMin));
      } else {
        // Sin progreso suficiente — usar estimado por tamaño
        remainMin = Math.max(0, expectedMin - elapsedMin);
      }
      if (remainMin > 0) {
        etaHtml = remainMin < 60
          ? " · ~" + remainMin + "min restante"
          : " · ~" + Math.round(remainMin / 60) + "h " + (remainMin % 60) + "min restante";
      } else {
        etaHtml = " · deberia finalizar pronto";
      }
    }
    const safeRunUrl = wb && wb.run_url && /^https:\/\/github\.com\//.test(wb.run_url) ? wb.run_url : null;
    const ciLinkHtml = safeRunUrl
      ? ` <a href="${escHtml(safeRunUrl)}" target="_blank" rel="noopener noreferrer" style="color:#60a5fa;font-size:9px;">&#9654; CI</a>`
      : "";
    // Robot icon para agente raíz del sprint (#1544)
    const agCanonical = normalizeSkillName(ag.agent_name || AGENT_MAP_DASHBOARD["/" + ag.skill] || ag.skill || "");
    const robotHtml = ROBOT_ICON_HTML[agCanonical] || "";
    return `<div class="exec-row" style="flex-direction:column;gap:4px;padding:8px 10px;">
      <div style="display:flex;align-items:center;gap:8px;width:100%;">
        ${robotHtml}<span class="exec-issue" style="min-width:52px;">${formatIssueLink(ag.issue)}</span>
        <span class="exec-slug" style="flex:1;">${linkifyIssueRefs(escHtml(ag.slug || ""))}</span>
        <span class="exec-size chip chip-blue">${escHtml(ag.size || "?")}</span>
        <span style="color:${statusColor};font-size:14px;">${statusIcon}</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px;width:100%;">
        <div class="exec-bar" style="flex:1;height:6px;"><div class="exec-bar-fill" style="width:${tasksPct}%;background:${isWaiting ? waitingBarColor : barColor};${isWaiting ? 'animation:pulse 1.5s infinite alternate;' : ''}"></div></div>
        <span style="font-size:11px;color:${isWaiting ? '#fbbf24' : statusColor};min-width:32px;text-align:right;font-weight:600;">${tasksPct}%</span>
      </div>
      <div style="font-size:10px;color:${isWaiting ? '#fbbf24' : isFailed ? '#f87171' : 'var(--text-muted)'};">${statusText}${!wb && actionCount ? ' · ' + actionCount + ' acc' : ''}${duration ? ' · ' + duration : ''}${etaHtml}${ciLinkHtml}</div>
    </div>`;
  }

  // Calcular sprintPct antes de los bloques que lo usan
  let sprintPct = 0;
  const completedCount = spCompleted.length;
  const agentesTotal = (data.sprintPlan && data.sprintPlan.total_stories) || allSprintAgentes.length || 1;
  if (data.sprintPlan && allSprintAgentes.length > 0) {
    const spDate = data.sprintPlan.fecha || "";
    const sprintId = data.sprintPlan.sprint_id || null;
    const sprintEstado = (data.sprintPlan.estado || "activo").toLowerCase();
    const isFinalizado = sprintEstado === "finalizado";
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
    // Verificar registry como fallback (#1642): puede haber agentes activos no detectados por sesiones
    if (data.registryActiveCount > 0) {
      agentsHtml = '<div class="empty-state">Agentes activos en registry: ' + data.registryActiveCount + ' (sesiones no visibles)</div>';
    } else {
      agentsHtml = '<div class="empty-state">Sin agentes activos</div>';
    }
  }

  // --- UNIFIED AGENT CARDS (combina sprint execution + session info) ---
  let unifiedAgentsHtml = "";
  if (data.sprintPlan && allSprintAgentes.length > 0) {
    const sprintId = data.sprintPlan.sprint_id || "Sprint";
    const sprintTema = data.sprintPlan.tema || "";
    const sprintPctColor = sprintPct >= 80 ? "var(--green)" : sprintPct >= 40 ? "#fbbf24" : "var(--text-muted)";
    unifiedAgentsHtml += `<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
      <span style="font-size:14px;font-weight:700;color:var(--white);">${escHtml(sprintId)}</span>
      <span style="font-size:13px;font-weight:700;color:${sprintPctColor};">${sprintPct}%</span>
      <span style="font-size:11px;color:var(--text-muted);flex:1;">${escHtml(sprintTema)}</span>
      <span style="font-size:10px;color:var(--text-dim);">${spCompleted.length}/${allSprintAgentes.length} completados</span>
    </div>`;

    // Renderizar secciones: en ejecución, en cola, completados
    const sections = [
      { items: spAgentes, label: "EN EJECUCI\u00D3N", color: "var(--accent-green)", icon: "&#9654;" },
      { items: spQueue, label: "EN COLA", color: "#fbbf24", icon: "&#9711;" },
      { items: spCompleted, label: "COMPLETADOS", color: "var(--text-muted)", icon: "&#10003;" },
      { items: spIncomplete, label: "FALLIDOS", color: "#f87171", icon: "&#10007;" }
    ];

    for (const sec of sections) {
      if (sec.items.length === 0) continue;
      unifiedAgentsHtml += `<div style="padding:4px 0 6px;font-size:10px;font-weight:600;color:${sec.color};letter-spacing:.04em;">${sec.icon} ${sec.label} (${sec.items.length})</div>`;
      unifiedAgentsHtml += `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:10px;margin-bottom:12px;">`;

      for (const ag of sec.items) {
        const matchSession = data.sprintSessions.find(s => {
          const m = (s.branch || "").match(/(\d+)/);
          return m && m[1] === String(ag.issue);
        });
        const agStatus = sec.label.includes("COLA") ? "pending" : sec.label.includes("COMPLETADO") ? "done" : (matchSession ? matchSession._status : "pending");
        const statusColor = STATUS_COLORS[agStatus] || "var(--text-muted)";
        const statusLabel = STATUS_LABELS[agStatus] || agStatus;
        const agentName = matchSession ? (matchSession.agent_name || "Agente") : "Agente " + ag.numero;
        const icon = AGENT_ICONS[agentName] || agentIconHtml(agentName);
        const gradient = AGENT_GRADIENTS[agentName] || AGENT_GRADIENTS["Claude"];
        const actionCount = matchSession ? (matchSession.action_count || 0) : 0;
        const duration = matchSession ? formatDuration(matchSession.started_ts) : "";
        const lastAction = matchSession && matchSession.last_tool ? (escHtml(matchSession.last_tool) + ": " + escHtml((matchSession.last_target || "").substring(0, 40))) : "";
        const tasks = matchSession ? (matchSession.current_tasks || []) : [];
        const tasksDone = tasks.filter(t => t.status === "completed").length;
        const tasksInProg = tasks.filter(t => t.status === "in_progress").length;

        // Barra de progreso
        const sizeExpected = { S: 40, M: 80, L: 160, XL: 300 };
        let pct = agStatus === "done" ? 100 : tasks.length > 0 ? Math.round((tasksDone / tasks.length) * 100) : Math.min(90, Math.round((actionCount / (sizeExpected[ag.size] || 60)) * 100));

        const isBlocked = matchSession && blockedPids.has(matchSession.id);
        const isFailed = sec.label.includes("FALLIDO");
        const isIdle = agStatus === "idle";
        const isPending = agStatus === "pending" || sec.label.includes("COLA");
        const barColor = agStatus === "done" ? "var(--gradient-green)" : isBlocked ? "linear-gradient(90deg, #ef4444, #f87171)" : isFailed ? "#f87171" : statusColor;

        // Compute status reason message
        let statusReason = "";
        if (isFailed && ag.motivo) {
          statusReason = ag.motivo;
        } else if (isFailed && ag.resultado) {
          statusReason = ag.resultado === "suspicious" ? "Sesi\u00F3n finaliz\u00F3 sin completar el trabajo (duraci\u00F3n insuficiente o sin PR)" : ag.resultado;
        } else if (isIdle && matchSession) {
          const idleMs = matchSession.last_activity_ts ? Date.now() - new Date(matchSession.last_activity_ts).getTime() : 0;
          const idleMin = Math.round(idleMs / 60000);
          if (matchSession.last_tool === "AskUserQuestion") {
            statusReason = "Esperando respuesta del usuario (" + idleMin + "m)";
          } else if (idleMin > 10) {
            statusReason = "Sin actividad hace " + idleMin + "m \u2014 posible espera de permiso o rate limit";
          } else {
            statusReason = "Idle hace " + idleMin + "m \u2014 \u00FAltima acci\u00F3n: " + (matchSession.last_tool || "desconocida");
          }
        } else if (isPending && !isFailed) {
          statusReason = "En cola \u2014 ser\u00E1 promovido cuando se libere un slot de ejecuci\u00F3n";
        }

        unifiedAgentsHtml += `
          <div style="background:var(--surface2);border-radius:var(--radius-sm);padding:12px;border-left:3px solid ${statusColor};">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
              <div class="agent-avatar" style="background:${gradient};width:36px;height:36px;min-width:36px;">${icon}</div>
              <div style="flex:1;">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                  <span style="font-weight:700;color:var(--white);font-size:13px;">${escHtml(agentName)}</span>
                  <span style="font-size:10px;padding:2px 6px;border-radius:4px;background:${statusColor}20;color:${statusColor};font-weight:600;">${isBlocked ? '&#128721; Bloqueado' : statusLabel}</span>
                </div>
                <div style="font-size:11px;color:var(--text-muted);">${formatIssueLink(ag.issue)} &middot; ${escHtml(ag.slug || "")} &middot; <span class="chip chip-blue" style="font-size:9px;padding:1px 4px;">${escHtml(ag.size || "?")}</span></div>
              </div>
            </div>${statusReason ? `
            <div style="margin:0 0 8px;padding:6px 8px;border-radius:4px;background:${isFailed ? '#f8717115' : isIdle ? '#fbbf2415' : '#60a5fa15'};border:1px solid ${isFailed ? '#f8717130' : isIdle ? '#fbbf2430' : '#60a5fa30'};font-size:10px;color:${isFailed ? '#f87171' : isIdle ? '#fbbf24' : '#60a5fa'};">
              ${isFailed ? '&#10007;' : isIdle ? '&#9888;' : '&#9711;'} ${escHtml(statusReason)}
            </div>` : ''}
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
              <div class="exec-bar" style="flex:1;height:5px;"><div class="exec-bar-fill" style="width:${pct}%;background:${barColor};"></div></div>
              <span style="font-size:11px;color:${statusColor};font-weight:600;min-width:28px;text-align:right;">${pct}%</span>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-muted);">
              <span>${actionCount} acc${duration ? ' &middot; ' + duration : ''}</span>
              ${lastAction ? '<span>' + lastAction + '</span>' : ''}
            </div>${tasks.length > 0 ? `
            <div style="margin-top:8px;border-top:1px solid var(--surface3);padding-top:6px;">
              ${tasks.map(t => {
                const checked = t.status === "completed";
                const inProg = t.status === "in_progress";
                const checkColor = checked ? "var(--green)" : inProg ? "#fbbf24" : "var(--text-muted)";
                const checkIcon = checked ? "&#9745;" : inProg ? "&#9654;" : "&#9744;";
                const textStyle = checked ? "text-decoration:line-through;opacity:0.6;" : inProg ? "color:#fbbf24;font-weight:600;" : "";
                return '<div style="display:flex;align-items:center;gap:6px;font-size:11px;padding:2px 0;color:var(--text-dim);">' +
                  '<span style="color:' + checkColor + ';font-size:13px;">' + checkIcon + '</span>' +
                  '<span style="' + textStyle + '">' + escHtml(t.subject || t.name || "Tarea") + '</span></div>';
              }).join("")}
            </div>` : ""}
          </div>`;
      }
      unifiedAgentsHtml += `</div>`;
    }
  } else {
    unifiedAgentsHtml = '<div class="empty-state">Sin sprint activo</div>';
  }

  // Sesiones standalone (fuera del sprint)
  const sprintIssueNums = new Set(allSprintAgentes.map(a => String(a.issue)));
  const standaloneSessions = visibleSessions.filter(s => {
    const m = (s.branch || "").match(/(\d+)/);
    const issueNum = m ? m[1] : null;
    return s.branch && s.branch.startsWith("agent/") && (!issueNum || !sprintIssueNums.has(issueNum));
  });
  if (standaloneSessions.length > 0) {
    unifiedAgentsHtml += `<div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--surface3);">
      <div style="font-size:10px;font-weight:600;color:#a78bfa;letter-spacing:.04em;margin-bottom:8px;">&#9881; FUERA DEL SPRINT (${standaloneSessions.length})</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:10px;">`;
    for (const s of standaloneSessions) {
      const icon = AGENT_ICONS[s.agent_name] || agentIconHtml(s.agent_name);
      const gradient = AGENT_GRADIENTS[s.agent_name] || AGENT_GRADIENTS["Claude"];
      const statusColor = STATUS_COLORS[s._status] || "#555872";
      const statusLabel = STATUS_LABELS[s._status] || s._status;
      const branchMatch = (s.branch || "").match(/(\d+)/);
      const issueNum = branchMatch ? branchMatch[1] : null;
      const actionCount = s.action_count || 0;
      const duration = formatDuration(s.started_ts);
      const lastAction = s.last_tool ? (escHtml(s.last_tool) + ": " + escHtml((s.last_target || "").substring(0, 40))) : "";
      const tasks = s.current_tasks || [];
      const tasksDone = tasks.filter(t => t.status === "completed").length;

      unifiedAgentsHtml += `
        <div style="background:var(--surface2);border-radius:var(--radius-sm);padding:12px;border-left:3px solid #a78bfa;">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
            <div class="agent-avatar" style="background:${gradient};width:36px;height:36px;min-width:36px;">${icon}</div>
            <div style="flex:1;">
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <span style="font-weight:700;color:var(--white);font-size:13px;">${escHtml(s.agent_name || "Agente")}</span>
                <span style="font-size:10px;padding:2px 6px;border-radius:4px;background:${statusColor}20;color:${statusColor};font-weight:600;">${statusLabel}</span>
              </div>
              <div style="font-size:11px;color:var(--text-muted);">${issueNum ? formatIssueLink(issueNum) + ' &middot; ' : ''}${escHtml(s.branch || "")}</div>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
            <div class="exec-bar" style="flex:1;height:5px;"><div class="exec-bar-fill" style="width:${tasks.length > 0 ? Math.round((tasksDone / tasks.length) * 100) : 0}%;background:${statusColor};"></div></div>
            <span style="font-size:11px;color:${statusColor};font-weight:600;min-width:28px;text-align:right;">${tasks.length > 0 ? Math.round((tasksDone / tasks.length) * 100) : 0}%</span>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-muted);">
            <span>${actionCount} acc &middot; ${duration}</span>
            ${lastAction ? '<span>' + lastAction + '</span>' : ''}
          </div>${tasks.length > 0 ? `
          <div style="margin-top:8px;border-top:1px solid var(--surface3);padding-top:6px;">
            ${tasks.map(t => {
              const checked = t.status === "completed";
              const inProg = t.status === "in_progress";
              const checkColor = checked ? "var(--green)" : inProg ? "#fbbf24" : "var(--text-muted)";
              const checkIcon = checked ? "&#9745;" : inProg ? "&#9654;" : "&#9744;";
              const textStyle = checked ? "text-decoration:line-through;opacity:0.6;" : inProg ? "color:#fbbf24;font-weight:600;" : "";
              return '<div style="display:flex;align-items:center;gap:6px;font-size:11px;padding:2px 0;color:var(--text-dim);">' +
                '<span style="color:' + checkColor + ';font-size:13px;">' + checkIcon + '</span>' +
                '<span style="' + textStyle + '">' + escHtml(t.subject || t.name || "Tarea") + '</span></div>';
            }).join("")}
          </div>` : ""}
        </div>`;
    }
    unifiedAgentsHtml += `</div></div>`;
  }

  // --- FLOW TREE (force-directed layout) ---
  // Construir mapa de agentes raíz → robotId desde sprint-plan.json (#1544)
  const rootAgentRobotMap = {};
  if (data.sprintPlan) {
    // Incluir agentes activos + completados + incompletos para asignar robots
    const allAgents = [
      ...(Array.isArray(data.sprintPlan.agentes) ? data.sprintPlan.agentes : []),
      ...(Array.isArray(data.sprintPlan._completed) ? data.sprintPlan._completed : []),
      ...(Array.isArray(data.sprintPlan._incomplete) ? data.sprintPlan._incomplete : []),
      ...(Array.isArray(data.sprintPlan._queue) ? data.sprintPlan._queue : [])
    ];
    for (const ag of allAgents) {
      // Buscar sesión para obtener agent_name canónico
      const matchSession = data.sprintSessions.find(s => {
        const m = (s.branch || "").match(/(\d+)/);
        return m && m[1] === String(ag.issue);
      });
      if (matchSession && matchSession.agent_name) {
        const robotId = ((ag.numero - 1) % 10) + 1;
        rootAgentRobotMap[normalizeSkillName(matchSession.agent_name)] = robotId;
      }
    }
  }
  const flowGraphHtml = buildFlowTree(data.sessions, data.agentNodes, data.agentTransitions, AGENT_ICONS, AGENT_COLORS, rootAgentRobotMap);

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
        <span class="feed-reason">${linkifyIssueRefs(escHtml(b.reason))} (${waitTime})</span>
      </div>
    </div>`;
  }
  for (const g of data.groupedActivities) {
    const time = g.ts ? new Date(g.ts).toLocaleTimeString("es-AR", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "??:??";
    let agentName = g.session || "?";
    let agentIcon = "&#129302;";
    // Buscar en sesiones activas primero, luego en disco para sesiones done
    let matchedSession = data.sessions.find(s => s.id === g.session);
    if (!matchedSession && g.session) {
      try {
        const sFile = path.join(SESSIONS_DIR, g.session + ".json");
        if (fs.existsSync(sFile)) matchedSession = readJson(sFile);
      } catch {}
    }
    if (matchedSession) {
      agentName = matchedSession.agent_name || "Agente (" + g.session + ")";
      agentIcon = AGENT_ICONS[matchedSession.agent_name] || agentIconHtml(matchedSession.agent_name);
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
        <span class="feed-target">${linkifyIssueRefs(escHtml(targetText))}</span>
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
  // Mostrar últimas 10 solicitudes (#1404)
  for (const q of recentPerms.slice(0, 10)) {
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
        <div class="perm-msg">${linkifyIssueRefs(msgShort)}</div>
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
    const branchIssue = (r.headBranch || "").match(/^(?:agent|feature|bugfix)\/(\d+)/);
    const issueLink = branchIssue ? formatIssueLink(branchIssue[1]) + " &middot; " : "";
    const runUrl = r.databaseId ? "https://github.com/intrale/platform/actions/runs/" + r.databaseId : null;
    ciHtml += `<div class="ci-row">
      <div class="ci-icon ${iconClass}" style="color:${iconColor}">${icon}</div>
      <div class="ci-text">${issueLink}${runUrl ? '<a href="' + runUrl + '" target="_blank" rel="noopener noreferrer" style="color:var(--white);text-decoration:none;font-weight:700;">' + escHtml(r.headBranch) + '</a>' : '<strong>' + escHtml(r.headBranch) + '</strong>'} &middot; ${linkifyIssueRefs(escHtml((r.displayTitle || "").substring(0, 60)))}</div>
      <div class="ci-time">${formatAge(r.createdAt)}</div>
    </div>`;
  }
  if (data.ciRuns.length === 0) {
    ciHtml = '<div class="empty-state">Sin ejecuciones recientes de CI/CD</div>';
  }

  // --- AGENT METRICS TABLE (#1226, #1419) ---
  let agentMetricsHtml = "";
  const currentSprintId = (data.sprintPlan && data.sprintPlan.sprint_id) || null;
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
      sprintId: s.sprint_id || currentSprintId || "",
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
        sprintId: ms.sprint_id || "",
        calls: ms.total_tool_calls || 0,
        files: ms.modified_files_count || 0,
        tasksCreated: ms.tasks_created || 0,
        tasksCompleted: ms.tasks_completed || 0,
        durMin: ms.duration_min || 0,
        active: false,
      });
    }
  }
  const metricsToShow = metricsEntries.slice(0, 12);
  const totalHistoric = data.agentMetrics && Array.isArray(data.agentMetrics.sessions) ? data.agentMetrics.sessions.length : 0;
  const sprintSessionCount = currentSprintId
    ? metricsToShow.filter(m => m.sprintId === currentSprintId).length
    : 0;
  if (metricsToShow.length > 0) {
    // Filtro toggle por sprint (#1419): botón que muestra solo el sprint activo
    const filterToggleId = "agMetricsFilter_" + Date.now();
    agentMetricsHtml = `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
      <span style="font-size:10px;color:var(--text-muted);">${totalHistoric > 0 ? 'Hist&oacute;rico: ' + totalHistoric + ' ses.' : ''}</span>
      ${currentSprintId ? `<button id="${filterToggleId}" onclick="(function(btn){
        var tbl=btn.closest('.ag-metrics-wrap').querySelector('.ag-metrics-tbl');
        var rows=tbl.querySelectorAll('tr[data-sprint]');
        var isFiltered=btn.dataset.filtered==='1';
        rows.forEach(function(r){
          if(isFiltered){r.style.display='';}
          else{r.style.display=(r.dataset.sprint==='${escHtml(currentSprintId)}')?'':'none';}
        });
        btn.dataset.filtered=isFiltered?'0':'1';
        btn.textContent=isFiltered?'Sprint actual':'Todos';
        btn.style.background=isFiltered?'var(--surface3)':'var(--blue-dim)';
        btn.style.color=isFiltered?'var(--text-muted)':'var(--blue)';
      })(this)" data-filtered="0" style="font-size:10px;padding:2px 8px;border:1px solid var(--border);border-radius:4px;background:var(--surface3);color:var(--text-muted);cursor:pointer;">${escHtml(currentSprintId)}</button>` : ''}
    </div>`;
    agentMetricsHtml += '<div class="ag-metrics-wrap"><table class="ag-metrics-tbl" style="width:100%;font-size:11px;border-collapse:collapse;">';
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
      const sprintAttr = m.sprintId ? ' data-sprint="' + escHtml(m.sprintId) + '"' : '';
      const isCurrentSprint = currentSprintId && m.sprintId === currentSprintId;
      const rowStyle = isCurrentSprint
        ? 'border-bottom:1px solid var(--border);background:var(--blue-dim);'
        : 'border-bottom:1px solid var(--border);';
      agentMetricsHtml += `<tr style="${rowStyle}"${sprintAttr}>`
        + '<td style="padding:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:120px;">' + indicator + escHtml(m.agent) + '</td>'
        + '<td style="padding:4px;font-family:monospace;font-size:10px;">' + escHtml(m.session) + '</td>'
        + '<td style="text-align:right;padding:4px;font-weight:600;">' + m.calls + '</td>'
        + '<td style="text-align:right;padding:4px;">' + m.files + '</td>'
        + '<td style="text-align:right;padding:4px;">' + tasksStr + '</td>'
        + '<td style="text-align:right;padding:4px;">' + durStr + '</td></tr>';
    }
    agentMetricsHtml += '</table></div>';
    if (totalHistoric > 0) {
      const lastTs = data.agentMetrics.updated_ts;
      agentMetricsHtml += '<div style="font-size:10px;color:var(--text-muted);margin-top:4px;">'
        + '&uacute;ltima: ' + formatAge(lastTs)
        + (currentSprintId && sprintSessionCount > 0 ? ' &mdash; ' + sprintSessionCount + ' en ' + escHtml(currentSprintId) : '')
        + '</div>';
    }
  } else {
    agentMetricsHtml = '<div class="empty-state">Sin m&eacute;tricas de agentes</div>';
  }

  // --- ALERTS ---
  let alertsHtml = "";
  for (const a of data.alerts) {
    const color = a.type === "critical" ? "var(--red)" : a.type === "warning" ? "var(--yellow)" : "var(--blue)";
    const icon = a.type === "critical" ? "&#128680;" : a.type === "warning" ? "&#9888;&#65039;" : "&#8505;&#65039;";
    alertsHtml += `<div class="alert-item" style="border-left-color:${color};">${icon} ${linkifyIssueRefs(escHtml(a.message))}</div>`;
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

    <!-- KPI Row (clickeable → scroll al panel) -->
    <div class="kpi-row">
      <a href="#" onclick="document.querySelector('[data-panel=exec]').scrollIntoView({behavior:'smooth'});return false;" class="kpi kpi-green" style="text-decoration:none;cursor:pointer;">
        <div class="kv" style="color:var(--green)">${data.activeSessions}</div>
        <div class="kl">Agentes activos</div>
        <div class="kt" style="color:var(--green)">${data.idleSessions > 0 ? data.idleSessions + ' idle' : 'Todos trabajando'}</div>
      </a>
      <a href="#" onclick="document.querySelector('[data-panel=activity]').scrollIntoView({behavior:'smooth'});return false;" class="kpi kpi-blue" style="text-decoration:none;cursor:pointer;">
        <div class="kv" style="color:var(--blue)">${permTotal}</div>
        <div class="kl">Permisos</div>
        <div class="kt" style="color:${permStats.pending > 0 ? 'var(--yellow)' : 'var(--green)'}">${permStats.pending > 0 ? permStats.pending + ' pendiente(s)' : permStats.auto + ' auto'}</div>
      </a>
      <a href="#" onclick="document.querySelector('[data-panel=ci]').scrollIntoView({behavior:'smooth'});return false;" class="kpi ${data.ciStatus === 'ok' ? 'kpi-green' : data.ciStatus === 'fail' ? 'kpi-red' : data.ciStatus === 'unknown' ? 'kpi-blue' : 'kpi-orange'}" style="text-decoration:none;cursor:pointer;">
        <div class="kv" style="color:${data.ciStatus === 'ok' ? 'var(--green)' : data.ciStatus === 'fail' ? 'var(--red)' : data.ciStatus === 'unknown' ? 'var(--text-muted)' : 'var(--yellow)'}">${data.ciStatus === 'ok' ? '&#10003;' : data.ciStatus === 'fail' ? '&#10007;' : data.ciStatus === 'unknown' ? '&#8212;' : '&#9203;'}</div>
        <div class="kl">CI / CD</div>
        <div class="kt" style="color:${data.ciStatus === 'ok' ? 'var(--green)' : data.ciStatus === 'fail' ? 'var(--red)' : data.ciStatus === 'unknown' ? 'var(--text-muted)' : 'var(--yellow)'}">${data.ciStatus === 'ok' ? 'Build OK' : data.ciStatus === 'fail' ? 'Build FAIL' : data.ciStatus === 'unknown' ? 'Sin ejecuciones recientes' : 'En curso...'}</div>
      </a>
      <a href="#" onclick="document.querySelector('[data-panel=sessions]').scrollIntoView({behavior:'smooth'});return false;" class="kpi kpi-orange" style="text-decoration:none;cursor:pointer;">
        <div class="kv" style="color:var(--orange)">${data.totalActions}</div>
        <div class="kl">Acciones hoy</div>
        <div class="kt" style="color:var(--orange)">${data.velocity[0] || 0} esta hora</div>
      </a>
      <a href="#" onclick="document.querySelector('[data-panel=metrics]').scrollIntoView({behavior:'smooth'});return false;" class="kpi kpi-purple" style="text-decoration:none;cursor:pointer;">
        <div class="kv" style="color:${data.alerts.length > 0 ? 'var(--red)' : 'var(--green)'}">${data.alerts.length}</div>
        <div class="kl">Alertas</div>
        <div class="kt" style="color:${data.alerts.length > 0 ? 'var(--red)' : 'var(--green)'}">${data.alerts.length > 0 ? data.alerts.length + ' activa(s)' : 'Todo limpio'}</div>
      </a>
    </div>

    <!-- Ejecución & Agentes (tarjetas unificadas, ancho completo) -->
    <div class="panel" data-panel="exec" style="margin-bottom:16px;">
      <div class="panel-title">Ejecuci&oacute;n &amp; Agentes</div>
      ${unifiedAgentsHtml}

    <!-- Fila 1: Flujo de agentes (ancho completo) #1378 -->
    <div class="grid-flow" data-panel="sessions">
      <div class="panel">
        <div class="panel-title" style="display:flex;justify-content:space-between;align-items:center;">
          <span>Flujo de agentes <span class="chip chip-blue">${data.agentNodes.length} nodos</span></span>
          <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text-muted);cursor:pointer;font-weight:400;">
            <input type="checkbox" id="toggle-main-flow" style="cursor:pointer;" onchange="toggleMainFlow(this.checked)">
            Mostrar flujo Main
          </label>
        </div>
        ${flowGraphHtml}
      </div>
    </div>

    <!-- Fila 2: Actividad en vivo | Permisos #1378 -->
    <div class="grid-activity" data-panel="activity">
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

    <!-- CI/CD — siempre visible (#1413) -->
    <div class="panel" style="margin-bottom:16px;" data-panel="ci">
      <div class="panel-title">CI / CD <span class="chip ${data.ciStatus === 'ok' ? 'chip-green' : data.ciStatus === 'fail' ? 'chip-red' : 'chip-blue'}">${data.ciRuns.length} ejecuciones</span></div>
      ${ciHtml}
    </div>

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

    // Toggle Main flow visibility (default: hidden)
    function toggleMainFlow(show) {
      document.querySelectorAll('[data-flow-root="main"]').forEach(function(el) {
        el.style.display = show ? '' : 'none';
      });
      localStorage.setItem('showMainFlow', show ? '1' : '0');
    }
    // Apply saved preference (default: hidden)
    (function() {
      var show = localStorage.getItem('showMainFlow') === '1';
      var cb = document.getElementById('toggle-main-flow');
      if (cb) cb.checked = show;
      toggleMainFlow(show);
    })();

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

    // SSE auto-refresh con polling real-time (#1212)
    if (!location.search.includes('nosse=1')) {
      var lastUpdate = Date.now();
      var lastReload = Date.now();
      var evtSource = new EventSource('/events');
      evtSource.onmessage = function(event) {
        lastUpdate = Date.now();
        var data = JSON.parse(event.data);
        // Actualizar KPIs en vivo sin recargar la página
        if (data.activeSessions !== undefined) {
          var kpis = document.querySelectorAll('.kv');
          if (kpis[0]) kpis[0].textContent = data.activeSessions;
        }
        // Recargar página completa cada 30s para refrescar todos los paneles
        if (data.reload && (Date.now() - lastReload > 30000)) {
          lastReload = Date.now();
          location.reload();
        }
      };
      evtSource.onerror = function() {
        document.getElementById('update-time').textContent = 'Desconectado...';
        // Reconectar automáticamente después de 5s
        setTimeout(function() {
          evtSource.close();
          evtSource = new EventSource('/events');
        }, 5000);
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
    const htmlCacheFresh = cachedHtml && (Date.now() - cachedHtmlDataTs < 5000) && !mockMode;
    if (htmlCacheFresh) {
      html = cachedHtml;
    } else {
      try {
        html = renderHTML(data, theme);
        if (!mockMode) { cachedHtml = html; cachedHtmlDataTs = Date.now(); }
      } catch (renderErr) {
        console.log("[dashboard-server] renderHTML error: " + renderErr.message + "\n" + renderErr.stack);
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("renderHTML error: " + renderErr.message + "\n" + renderErr.stack);
        return;
      }
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
  } else if (pathname === "/api/activity") {
    // Endpoint de actividad en vivo (#1212) — polling ligero para feeds externos
    const data = collectData();
    const since = url.searchParams.get("since");
    let filtered = data.groupedActivities;
    if (since) {
      const sinceMs = new Date(since).getTime();
      if (!isNaN(sinceMs)) {
        filtered = filtered.filter(g => new Date(g.lastTs || g.ts).getTime() > sinceMs);
      }
    }
    const json = JSON.stringify({
      timestamp: data.timestamp,
      activities: filtered.slice(0, 50),
      activeSessions: data.activeSessions,
      alerts: data.alerts,
      pendingQuestionsCount: data.pendingQuestions.length,
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
  } else if (pathname === "/api/activity") {
    // Endpoint liviano para polling de actividad en vivo (#1212)
    // Retorna tool calls, skill invocations y progreso de agentes
    const data = collectData();
    const activityPayload = {
      ts: data.timestamp,
      activeSessions: data.activeSessions,
      totalActions: data.totalActions,
      pendingPermissions: data.pendingQuestions.length,
      groupedActivities: (data.groupedActivities || []).slice(0, 10).map(g => ({
        tool: g.tool,
        target: (g.target || "").substring(0, 80),
        session: g.session,
        count: g.count,
        ts: g.ts,
      })),
      agentProgress: (() => {
        // Fuente primaria: sesiones activas
        const fromSessions = data.sessions.filter(s => s._status === "active").map(s => ({
          id: s.id,
          agent: s.agent_name || "Agente",
          lastTool: s.last_tool,
          lastTarget: (s.last_target || "").substring(0, 60),
          actions: s.action_count,
          skillsInvoked: s.skills_invoked || [],
        }));
        // Fallback: agentes del registry no presentes en sesiones (#1642)
        const sessionIds = new Set(fromSessions.map(s => s.id));
        const fromRegistry = (data.registryAgents || [])
          .filter(a => a.status === "active" && !sessionIds.has(a.session_id))
          .map(a => ({
            id: a.session_id,
            agent: a.skill || "Agente (#" + (a.issue || "?") + ")",
            lastTool: null,
            lastTarget: a.branch || "",
            actions: 0,
            skillsInvoked: [],
            _source: "registry",
          }));
        return [...fromSessions, ...fromRegistry];
      })(),
    };
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
    res.end(JSON.stringify(activityPayload));
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
        { id: "kpis",               sel: ".kpi-row",                                  w: 0 },
        { id: "ejecucion",          sel: "[data-panel='exec']",                       w: 0 },
        { id: "flujo",              sel: "[data-panel='sessions']",                   w: 0 },
        { id: "actividad",          sel: "[data-panel='activity'] .feed-panel",       w: 0 },
        { id: "permisos",           sel: "[data-panel='activity'] .panel:last-child", w: 0 },
        { id: "uso-agentes",        sel: "[data-panel='metrics'] > .panel:first-child", w: 0 },
        { id: "metricas-agentes",   sel: "[data-panel='metrics'] > .panel:last-child",  w: 0 },
        { id: "roadmap",            sel: "[data-panel='roadmap']",                    w: 1200 },
        { id: "ci",                 sel: "[data-panel='ci']",                         w: 0 },
      ];
      return selectors.map(function(s) {
        var el = document.querySelector(s.sel);
        if (!el) return { id: s.id, found: false, customWidth: s.w };
        var r = el.getBoundingClientRect();
        if (r.height < 20 || r.width < 20) return { id: s.id, found: true, visible: false, rect: { h: r.height, w: r.width }, customWidth: s.w };
        return {
          id: s.id,
          found: true,
          visible: true,
          x: Math.max(0, Math.round(r.x)),
          y: Math.max(0, Math.round(r.y + window.scrollY)),
          width: Math.round(r.width),
          height: Math.round(r.height),
          customWidth: s.w,
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
        const needsWider = section.customWidth && section.customWidth > width;

        // Si la sección necesita más ancho, re-renderizar con viewport más ancho
        if (needsWider) {
          await page.setViewport({ width: section.customWidth, height: 2400 });
          await page.reload({ waitUntil: "load", timeout: 15000 });
          await new Promise(r => setTimeout(r, 2000));
          // Re-obtener bounds con el nuevo viewport
          const newRect = await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: Math.max(0, Math.round(r.x)), y: Math.max(0, Math.round(r.y + window.scrollY)), width: Math.round(r.width), height: Math.round(r.height) };
          }, "[data-panel='" + section.id + "']");
          if (newRect) {
            section.x = newRect.x;
            section.y = newRect.y;
            section.width = newRect.width;
            section.height = newRect.height;
          }
        }

        // Bounds check: el clip no puede superar el alto total de la página ni 1200px max
        const currentPageHeight = needsWider ? await page.evaluate(() => document.body.scrollHeight) : pageHeight;
        const clampedHeight = Math.min(section.height, Math.max(1, currentPageHeight - section.y), 1200);
        if (clampedHeight < 20) {
          console.log("[dashboard-server] Sección " + section.id + " clampedHeight=" + clampedHeight + " < 20 — omitida");
          if (needsWider) { await page.setViewport({ width, height: 2400 }); await page.reload({ waitUntil: "load", timeout: 15000 }); await new Promise(r => setTimeout(r, 2000)); }
          continue;
        }

        const captureWidth = needsWider ? section.customWidth : Math.min(section.width, width);
        const buf = await page.screenshot({
          type: "png",
          clip: {
            x: section.x,
            y: section.y,
            width: captureWidth,
            height: clampedHeight,
          },
        });

        // Restaurar viewport original si se cambió
        if (needsWider) {
          await page.setViewport({ width, height: 2400 });
          await page.reload({ waitUntil: "load", timeout: 15000 });
          await new Promise(r => setTimeout(r, 2000));
        }
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
// Envía datos parciales de actividad para actualización en vivo (#1212)
// El cliente recibe: reload (para refrescar HTML completo) + actividad + KPIs
function broadcastSSE() {
  const data = collectData();
  const msg = JSON.stringify({
    reload: true,
    ts: data.timestamp,
    // Datos parciales para actualización en vivo (#1212)
    activeSessions: data.activeSessions,
    idleSessions: data.idleSessions,
    totalActions: data.totalActions,
    ciStatus: data.ciStatus,
    alertCount: data.alerts.length,
    pendingPermissions: data.pendingQuestions.length,
    // Últimas 5 actividades para feed en vivo
    recentActivity: (data.groupedActivities || []).slice(0, 5).map(g => ({
      tool: g.tool,
      target: (g.target || "").substring(0, 60),
      session: g.session,
      count: g.count,
      ts: g.ts,
    })),
  });
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

// Pre-check: verificar si el puerto ya está en uso antes de intentar bind (#1415)
// Esto previene instancias zombie desde worktrees de agentes.
const net = require("net");
let preCheckDone = false;
const preCheckSocket = net.createConnection({ port: PORT, host: "localhost" });
preCheckSocket.setTimeout(1000);
preCheckSocket.on("connect", () => {
  preCheckDone = true;
  preCheckSocket.end();
  console.log("[dashboard-server] Port " + PORT + " in use, exiting (otra instancia corriendo).");
  process.exit(0);
});
preCheckSocket.on("error", () => {
  if (preCheckDone) return;
  preCheckDone = true;
  // Puerto libre — continuar con startup normal
  startServer();
});
preCheckSocket.on("timeout", () => {
  if (preCheckDone) return;
  preCheckDone = true;
  preCheckSocket.destroy();
  // Timeout → puerto libre — continuar
  startServer();
});

function startServer() {
  server.listen(PORT, () => {
    console.log("[dashboard-server] Escuchando en http://localhost:" + PORT);
    writePid();

    setInterval(broadcastSSE, SSE_INTERVAL_MS);
    setInterval(checkSprintPlanFreshness, 1000); // Watcher freshness sprint-plan.json (#1434)
    setInterval(checkAutoStop, 5 * 60 * 1000);

    startHeartbeat({ collectDataFn: collectData, takeScreenshotFn: takeScreenshot, takeScreenshotSectionsFn: takeScreenshotSections, port: PORT });
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.log("[dashboard-server] Puerto " + PORT + " ya en uso, otro servidor corriendo.");
      process.exit(0);
    }
    console.error("[dashboard-server] Error:", err.message);
    process.exit(1);
  });
}

process.on("SIGTERM", () => { cleanup(); process.exit(0); });
process.on("SIGINT", () => { cleanup(); process.exit(0); });
process.on("exit", cleanup);

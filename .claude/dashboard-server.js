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

// --- Config ---
const REPO_ROOT = path.resolve(__dirname, "..");
const CLAUDE_DIR = path.join(REPO_ROOT, ".claude");
const SESSIONS_DIR = path.join(CLAUDE_DIR, "sessions");
const LOG_FILE = path.join(CLAUDE_DIR, "activity-log.jsonl");
const PID_FILE = path.join(CLAUDE_DIR, "tmp", "dashboard-server.pid");
const TG_CONFIG_FILE = path.join(CLAUDE_DIR, "hooks", "telegram-config.json");
const SERVER_LOG_FILE = path.join(CLAUDE_DIR, "hooks", "hook-debug.log");
const SPRINT_PLAN_FILE = path.join(REPO_ROOT, "scripts", "sprint-plan.json");

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
        if (status === "stale") {
          const elapsed = now - new Date(s.last_activity_ts).getTime();
          if (elapsed > 60 * 60 * 1000) continue;
        }
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

  // Sprint plan
  let sprintPlan = null;
  try { sprintPlan = readJson(SPRINT_PLAN_FILE); } catch {}

  // Pending questions
  let pendingQuestions = [];
  try {
    const pq = readJson(PENDING_QUESTIONS_FILE);
    if (pq && Array.isArray(pq.questions)) {
      pendingQuestions = pq.questions.filter(q => q.status === "pending");
    }
  } catch {}

  // Blocking relations
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
  const sprintIssues = sprintPlan && Array.isArray(sprintPlan.agentes)
    ? sprintPlan.agentes.map(a => String(a.issue))
    : [];
  const sprintSessions = [];
  const standaloneSessions = [];
  const adhocSessions = [];
  for (const s of sessions) {
    if (s._status === "stale") continue;
    const issueMatch = (s.branch || "").match(/^(?:agent|feature|bugfix)\/(\d+)/);
    const issueNum = issueMatch ? issueMatch[1] : null;
    if (issueNum && sprintIssues.includes(issueNum)) {
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
    blockingRelations,
    sprintPlan,
    sprintSessions,
    standaloneSessions,
    adhocSessions,
    agentTransitions,
    agentNodes: Array.from(agentNodes),
    skillUsage,
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
      { type: "permission", status: "pending", approver_pid: 2002, message: "Aprobar: gh issue create", timestamp: ago(3) },
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

  // Agent icons
  const AGENT_ICONS = {
    "Guru": "&#129497;", "Doc": "&#128214;", "Doc (historia)": "&#128214;",
    "Doc (refinar)": "&#128214;", "Doc (priorizar)": "&#128214;",
    "Planner": "&#128218;", "DeliveryManager": "&#127939;",
    "Tester": "&#128373;&#65039;", "Monitor": "&#128065;&#65039;",
    "Builder": "&#127959;&#65039;", "Review": "&#128270;",
    "QA": "&#128373;&#65039;", "Auth": "&#128274;",
    "UX Specialist": "&#127912;", "Scrum Master": "&#128203;",
    "PO": "&#128188;", "BackendDev": "&#9881;&#65039;",
    "AndroidDev": "&#128241;", "iOSDev": "&#127823;",
    "WebDev": "&#127760;", "DesktopDev": "&#128187;",
    "Ops": "&#128295;", "Branch": "&#127796;", "Claude": "&#129302;",
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
    "Branch": "linear-gradient(135deg, #65a30d, #84cc16)",
    "Claude": "linear-gradient(135deg, #555872, #6C7086)",
  };

  const AGENT_COLORS = {
    "Guru": "#818cf8", "Doc": "#a78bfa", "Planner": "#fbbf24",
    "DeliveryManager": "#34d399", "Tester": "#d946ef", "QA": "#d946ef",
    "Builder": "#fb923c", "Review": "#818cf8", "Monitor": "#22d3ee",
    "Auth": "#94a3b8", "PO": "#38bdf8", "UX Specialist": "#f472b6",
    "Scrum Master": "#2dd4bf", "Ops": "#a8a29e",
    "BackendDev": "#f87171", "AndroidDev": "#4ade80", "WebDev": "#60a5fa",
    "Branch": "#84cc16", "Claude": "#6C7086",
  };

  const STATUS_COLORS = { active: "#34d399", idle: "#fbbf24", done: "#6C7086", stale: "#555872" };
  const STATUS_LABELS = { active: "Activo", idle: "Idle", done: "Terminado", stale: "Stale" };

  const blockedPids = new Set(data.blockingRelations.map(b => b.blockedSessionId));

  // --- EJECUCIÓN PANEL ---
  let ejecutionHtml = "";

  // Sprint sub-view
  if (data.sprintPlan && Array.isArray(data.sprintPlan.agentes) && data.sprintPlan.agentes.length > 0) {
    const spDate = data.sprintPlan.fecha || "";
    const sprintTasksTotal = data.sprintSessions.reduce((sum, s) => sum + (s.current_tasks || []).length, 0);
    const sprintTasksDone = data.sprintSessions.reduce((sum, s) => sum + (s.current_tasks || []).filter(t => t.status === "completed").length, 0);
    const sprintPct = sprintTasksTotal > 0 ? Math.round((sprintTasksDone / sprintTasksTotal) * 100) : 0;

    ejecutionHtml += `<div class="exec-subview">
      <div class="exec-subview-header">
        <span class="exec-label">&#128640; Sprint${spDate ? ' (' + escHtml(spDate) + ')' : ''}</span>
        <span class="exec-progress-badge">${sprintPct}%</span>
      </div>
      <div class="exec-bar"><div class="exec-bar-fill" style="width:${sprintPct}%;background:var(--gradient-green);"></div></div>
      <div class="exec-table">`;
    for (const ag of data.sprintPlan.agentes) {
      const matchSession = data.sprintSessions.find(s => {
        const issueMatch = (s.branch || "").match(/(\d+)/);
        return issueMatch && issueMatch[1] === String(ag.issue);
      });
      const agStatus = matchSession ? matchSession._status : "pending";
      const statusIcon = agStatus === "active" ? "&#9679;" : agStatus === "idle" ? "&#9684;" : agStatus === "done" ? "&#10003;" : "&#9675;";
      const statusColor = STATUS_COLORS[agStatus] || "var(--text-muted)";
      const isBlocked = matchSession && blockedPids.has(matchSession.id);
      const tasks = matchSession ? (matchSession.current_tasks || []) : [];
      const tasksDone = tasks.filter(t => t.status === "completed").length;
      const tasksInProgress = tasks.filter(t => t.status === "in_progress").length;
      const tasksPct = tasks.length > 0 ? Math.round((tasksDone / tasks.length) * 100) : 0;
      const agentIcon = AGENT_ICONS[matchSession ? matchSession.agent_name : ""] || "&#9675;";
      const barColor = agStatus === "done" ? "var(--gradient-green)" : isBlocked ? "linear-gradient(90deg, #ef4444, #f87171)" : statusColor;
      const statusText = isBlocked ? "&#128721; Bloqueado"
        : agStatus === "pending" ? "Pendiente"
        : `${tasksDone}/${tasks.length} tareas · ${tasksPct}%`;
      const actionCount = matchSession ? (matchSession.action_count || 0) : 0;
      const duration = matchSession ? formatDuration(matchSession.started_ts) : "";

      ejecutionHtml += `<div class="exec-row" style="flex-direction:column;gap:4px;padding:8px 10px;">
        <div style="display:flex;align-items:center;gap:8px;width:100%;">
          <span class="exec-issue" style="min-width:52px;">#${escHtml(String(ag.issue))}</span>
          <span class="exec-slug" style="flex:1;">${escHtml(ag.slug || "")}</span>
          <span class="exec-size chip chip-blue">${escHtml(ag.size || "?")}</span>
          <span style="color:${statusColor};font-size:14px;">${statusIcon}</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px;width:100%;">
          <div class="exec-bar" style="flex:1;height:6px;"><div class="exec-bar-fill" style="width:${tasksPct}%;background:${barColor};"></div></div>
          <span style="font-size:11px;color:${statusColor};min-width:32px;text-align:right;font-weight:600;">${tasksPct}%</span>
        </div>
        <div style="font-size:10px;color:var(--text-muted);">${statusText}${actionCount ? ' · ' + actionCount + ' acc' : ''}${duration ? ' · ' + duration : ''}</div>
      </div>`;
    }
    ejecutionHtml += `</div></div>`;
  }

  // Standalone issues sub-view
  if (data.standaloneSessions.length > 0) {
    ejecutionHtml += `<div class="exec-subview">
      <div class="exec-subview-header">
        <span class="exec-label">&#128204; Historias en curso</span>
        <span class="chip chip-blue">${data.standaloneSessions.length}</span>
      </div>`;
    for (const s of data.standaloneSessions) {
      const icon = AGENT_ICONS[s.agent_name] || "&#129302;";
      const gradient = AGENT_GRADIENTS[s.agent_name] || AGENT_GRADIENTS["Claude"];
      const statusColor = STATUS_COLORS[s._status] || "#555872";
      const tasks = s.current_tasks || [];
      const done = tasks.filter(t => t.status === "completed").length;
      const pct = tasks.length > 0 ? Math.round((done / tasks.length) * 100) : 0;
      ejecutionHtml += `<div class="exec-card">
        <div class="exec-card-avatar" style="background:${gradient};">${icon}</div>
        <div class="exec-card-info">
          <div class="exec-card-name">${escHtml(s.agent_name || "Ad-hoc")} <span style="color:var(--text-muted);font-weight:400;">${escHtml(s.branch || "")}</span></div>
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
    const icon = AGENT_ICONS[s.agent_name] || "&#129302;";
    const gradient = AGENT_GRADIENTS[s.agent_name] || AGENT_GRADIENTS["Claude"];
    const statusColor = STATUS_COLORS[s._status] || "#555872";
    const statusLabel = STATUS_LABELS[s._status] || s._status;
    const name = escHtml(s.agent_name || "Ad-hoc (" + s.id + ")");
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

  // --- FLOW GRAPH SVG (circular layout) ---
  let flowGraphHtml = "";
  const nodes = data.agentNodes.length > 0 ? data.agentNodes : [];
  if (nodes.length > 0) {
    const cx = 200, cy = 180, radius = 140;
    const nodeR = 28;
    const svgW = 400, svgH = 360;
    const angleStep = (2 * Math.PI) / Math.max(nodes.length, 1);

    // Compute positions
    const positions = {};
    nodes.forEach((n, i) => {
      positions[n] = {
        x: cx + radius * Math.cos(angleStep * i - Math.PI / 2),
        y: cy + radius * Math.sin(angleStep * i - Math.PI / 2),
      };
    });

    // Determine active agents
    const activeAgents = new Set();
    const doneAgents = new Set();
    for (const s of visibleSessions) {
      if (s.agent_name) {
        if (s._status === "active") activeAgents.add(s.agent_name);
        if (s._status === "done") doneAgents.add(s.agent_name);
      }
      if (Array.isArray(s.skills_invoked)) {
        for (const sk of s.skills_invoked) {
          const mapped = AGENT_MAP_DASHBOARD[sk] || sk.replace(/^\//, "");
          // Mark as done if not currently active
          if (!activeAgents.has(mapped)) doneAgents.add(mapped);
        }
      }
    }

    // Arrow defs
    let graphSvg = `<defs>
      <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
        <polygon points="0 0, 8 3, 0 6" fill="var(--text-muted)" opacity="0.6"/>
      </marker>
      <filter id="glow"><feGaussianBlur stdDeviation="3" result="coloredBlur"/>
        <feMerge><feMergeNode in="coloredBlur"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>`;

    // Draw edges (transitions)
    const drawnEdges = new Set();
    for (const t of data.agentTransitions) {
      const from = positions[t.from];
      const to = positions[t.to];
      if (!from || !to) continue;
      const edgeKey = t.from + "->" + t.to;
      if (drawnEdges.has(edgeKey)) continue;
      drawnEdges.add(edgeKey);
      // Shorten arrow to stop at node boundary
      const dx = to.x - from.x, dy = to.y - from.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 1) continue;
      const ux = dx / dist, uy = dy / dist;
      const x1 = from.x + ux * (nodeR + 4), y1 = from.y + uy * (nodeR + 4);
      const x2 = to.x - ux * (nodeR + 8), y2 = to.y - uy * (nodeR + 8);
      graphSvg += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="var(--text-muted)" stroke-width="1.5" stroke-opacity="0.5" marker-end="url(#arrowhead)"/>`;
    }

    // Draw nodes
    for (const name of nodes) {
      const pos = positions[name];
      if (!pos) continue;
      const color = AGENT_COLORS[name] || "#6C7086";
      const icon = AGENT_ICONS[name] || "&#129302;";
      const isActive = activeAgents.has(name);
      const isDone = doneAgents.has(name);
      const opacity = (!isActive && !isDone) ? "0.4" : "1";
      const filterAttr = isActive ? 'filter="url(#glow)"' : '';

      graphSvg += `<g class="flow-node" data-agent="${escHtml(name)}" style="cursor:pointer;opacity:${opacity};" ${filterAttr}>`;
      graphSvg += `<circle cx="${pos.x.toFixed(1)}" cy="${pos.y.toFixed(1)}" r="${nodeR}" fill="${color}" fill-opacity="0.2" stroke="${color}" stroke-width="2"`;
      if (isActive) {
        graphSvg += `><animate attributeName="stroke-opacity" values="1;0.4;1" dur="2s" repeatCount="indefinite"/>`;
        graphSvg += `</circle>`;
      } else {
        graphSvg += `/>`;
      }
      // Check mark for done
      if (isDone && !isActive) {
        graphSvg += `<text x="${pos.x.toFixed(1)}" y="${(pos.y + 5).toFixed(1)}" text-anchor="middle" font-size="18" fill="${color}">&#10003;</text>`;
      } else {
        graphSvg += `<text x="${pos.x.toFixed(1)}" y="${(pos.y + 5).toFixed(1)}" text-anchor="middle" font-size="16">${icon}</text>`;
      }
      // Label below
      const shortName = name.length > 12 ? name.substring(0, 10) + "…" : name;
      graphSvg += `<text x="${pos.x.toFixed(1)}" y="${(pos.y + nodeR + 14).toFixed(1)}" text-anchor="middle" font-size="9" fill="var(--text-dim)" font-weight="600">${escHtml(shortName)}</text>`;
      graphSvg += `</g>`;
    }

    flowGraphHtml = `<svg class="flow-graph-svg" viewBox="0 0 ${svgW} ${svgH}" preserveAspectRatio="xMidYMid meet" style="width:100%;max-height:${svgH}px;">${graphSvg}</svg>`;
  } else {
    flowGraphHtml = '<div class="empty-state">Sin flujo de agentes registrado</div>';
  }

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
        agentName = s.agent_name || "Ad-hoc (" + s.id + ")";
        agentIcon = AGENT_ICONS[s.agent_name] || "&#129302;";
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

  // --- TASKS ---
  let tasksHtml = "";
  for (const t of data.allTasks) {
    const isDone = t.status === "completed";
    const isActive = t.status === "in_progress";
    const checkClass = isDone ? "task-check-done" : isActive ? "task-check-active" : "task-check-pending";
    const checkIcon = isDone ? "&#10003;" : isActive ? "&#9654;" : "";
    const nameClass = isDone ? "task-name-done" : "";
    const subText = t.steps ? (isDone ? t.steps.length + "/" + t.steps.length + " sub-pasos" : (t.current_step || 0) + "/" + t.steps.length + " sub-pasos") : "";
    const progressWidth = t.progress || 0;
    tasksHtml += `<div class="task-item">
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
    .grid-flow { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 16px; }

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
    .exec-label { font-size: 12px; font-weight: 700; color: var(--white); }
    .exec-progress-badge { font-size: 13px; font-weight: 800; color: var(--green); }
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

    /* Tasks */
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
      .grid-2col, .grid-2equal, .grid-flow { grid-template-columns: 1fr; }
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

    <!-- Ejecución + Agents -->
    <div class="grid-2col">
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

    <!-- Flow Graph + Feed -->
    <div class="grid-flow">
      <div class="panel">
        <div class="panel-title">Flujo de agentes <span class="chip chip-blue">${data.agentNodes.length} nodos</span></div>
        ${flowGraphHtml}
      </div>
      <div class="feed-panel" id="activity-feed">
        <div class="panel-title">Actividad en vivo <span class="chip ${data.blockingRelations.length > 0 ? 'chip-red' : 'chip-green'}">${data.blockingRelations.length > 0 ? data.blockingRelations.length + ' bloq.' : 'Sin bloqueos'}</span></div>
        ${feedHtml}
      </div>
    </div>

    <!-- Métricas Claude + Tasks -->
    <div class="grid-2equal">
      <div class="panel">
        <div class="panel-title">Uso de agentes <span class="chip chip-purple">${totalSkillInvocations} inv.</span></div>
        ${metricsHtml}
      </div>
      <div class="panel">
        <div class="panel-title">Tareas <span class="chip chip-green">${data.completedTasks}/${data.totalTasks}</span></div>
        <div class="tasks-progress-bar">
          <div class="tasks-progress-fill" style="width:${sprintProgress}%; background: var(--gradient-green);"></div>
        </div>
        ${tasksHtml}
      </div>
    </div>

    <!-- CI -->
    <div class="panel" style="margin-bottom:16px;">
      <div class="panel-title">CI / CD</div>
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
        agent: s.agent_name || "Ad-hoc",
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
      sprintPlan: data.sprintPlan,
      metrics: data.metrics,
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
const TG_CONFIG = (() => {
  try { return JSON.parse(fs.readFileSync(TG_CONFIG_FILE, "utf8")); }
  catch { return { bot_token: "", chat_id: "", task_report_interval_min: 10 }; }
})();
const REPORT_INTERVAL_MIN = parseInt(TG_CONFIG.task_report_interval_min, 10) || 10;

function sendTelegramText(text, silent) {
  if (!TG_CONFIG.bot_token || !TG_CONFIG.chat_id) return;
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

function sendTelegramMediaGroup(photos, caption, silent) {
  if (!TG_CONFIG.bot_token || !TG_CONFIG.chat_id) return Promise.resolve(null);
  const https = require("https");
  return new Promise((resolve, reject) => {
    const boundary = "----FormBoundary" + Date.now().toString(36);
    const media = photos.map((_, i) => ({
      type: "photo",
      media: "attach://photo" + i,
      ...(i === 0 && caption ? { caption, parse_mode: "HTML" } : {})
    }));
    let parts = [];
    parts.push(Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"chat_id\"\r\n\r\n" + TG_CONFIG.chat_id + "\r\n"));
    parts.push(Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"media\"\r\n\r\n" + JSON.stringify(media) + "\r\n"));
    if (silent) {
      parts.push(Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"disable_notification\"\r\n\r\n" + "true" + "\r\n"));
    }
    photos.forEach((buf, i) => {
      parts.push(Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"photo" + i + "\"; filename=\"photo" + i + ".png\"\r\nContent-Type: image/png\r\n\r\n"));
      parts.push(buf);
      parts.push(Buffer.from("\r\n"));
    });
    parts.push(Buffer.from("--" + boundary + "--\r\n"));
    const payload = Buffer.concat(parts);
    const req = https.request({
      hostname: "api.telegram.org",
      path: "/bot" + TG_CONFIG.bot_token + "/sendMediaGroup",
      method: "POST",
      headers: { "Content-Type": "multipart/form-data; boundary=" + boundary, "Content-Length": payload.length },
      timeout: 20000
    }, (res) => {
      let d = "";
      res.on("data", (c) => d += c);
      res.on("end", () => {
        try {
          const r = JSON.parse(d);
          if (r.ok) { console.log("[heartbeat] Álbum OK"); resolve(r); }
          else { console.log("[heartbeat] Álbum error: " + d.substring(0, 200)); reject(new Error(d)); }
        } catch (e) { reject(e); }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", reject);
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

    try {
      const parts = await takeScreenshot(600, 800, { split: true });
      if (Array.isArray(parts) && parts[0].length > 1000 && parts[1].length > 1000) {
        await sendTelegramMediaGroup(parts, caption, true);
        console.log("[heartbeat] Álbum enviado OK");
        return;
      }
    } catch (e) {
      console.log("[heartbeat] Álbum no disponible: " + e.message + " — fallback a single");
    }

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

    const text = caption + "\n\n" +
      "\u25cf Agentes: <b>" + data.activeSessions + "</b> activos" + (data.idleSessions > 0 ? ", " + data.idleSessions + " idle" : "") + "\n" +
      "\u25cf Tareas: <b>" + data.completedTasks + "/" + data.totalTasks + "</b> completadas\n" +
      "\u25cf CI: <b>" + (data.ciStatus === "ok" ? "\u2705 OK" : data.ciStatus === "fail" ? "\u274c FAIL" : data.ciStatus) + "</b>\n" +
      "\u25cf Acciones: <b>" + data.totalActions + "</b> (" + (data.velocity[0] || 0) + "/h)\n" +
      "\u25cf Costo est: <b>$" + data.metrics.estimatedCostUsd.toFixed(2) + "</b> (" + data.metrics.weeklyUsagePct + "% semanal)\n" +
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

  setInterval(broadcastSSE, SSE_INTERVAL_MS);
  setInterval(checkAutoStop, 5 * 60 * 1000);

  if (TG_CONFIG.bot_token && REPORT_INTERVAL_MIN > 0) {
    console.log("[dashboard-server] Heartbeat Telegram cada " + REPORT_INTERVAL_MIN + " min");
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

process.on("SIGTERM", () => { cleanup(); process.exit(0); });
process.on("SIGINT", () => { cleanup(); process.exit(0); });
process.on("exit", cleanup);

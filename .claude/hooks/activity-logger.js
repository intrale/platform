<<<<<<< docs/agents-automation
// El Centinela v2.1 -- Activity Logger Hook
=======
// El Centinela v2 -- Activity Logger Hook
>>>>>>> main
// PostToolUse hook: registra actividad per-session en .claude/sessions/<id>.json
// Pure Node.js — sin dependencia de bash
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const CLAUDE_DIR = path.join(REPO_ROOT, ".claude");
const SESSIONS_DIR = path.join(CLAUDE_DIR, "sessions");
const SESSION_FILE = path.join(CLAUDE_DIR, "session-state.json"); // backward compat
const LOG_FILE = path.join(CLAUDE_DIR, "activity-log.jsonl");
const MAX_LOG_LINES = 500;
const TASKS_BASE = path.join(process.env.HOME || process.env.USERPROFILE || "", ".claude", "tasks");
const STALE_HOURS = 24;

<<<<<<< docs/agents-automation
const CLEANUP_EVERY_N = 50; // throttle: solo cleanup cada N invocaciones

=======
>>>>>>> main
// Mapeo skill → agente
const SKILL_AGENT_MAP = {
  sabueso: "El Sabueso \u{1F415}",
  monitor: "El Centinela \u{1F5FC}",
  inquisidor: "El Inquisidor \u{1F575}\u{FE0F}",
  mensajero: "El Mensajero \u{1F4E8}",
  oraculo: "El Or\u00E1culo \u{1F52E}",
  pluma: "La Pluma \u{270D}\u{FE0F}",
  permisos: "El Portero \u{1F6AA}",
<<<<<<< docs/agents-automation
  "nueva-historia": "La Pluma \u{270D}\u{FE0F}",
  refinar: "La Pluma \u{270D}\u{FE0F}",
  triaje: "La Pluma \u{270D}\u{FE0F}",
=======
>>>>>>> main
};

// --- stdin read ---
const MAX_READ = 8192;
let input = "";
let done = false;

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (done) return;
  input += chunk;
  if (input.length >= MAX_READ) { done = true; process.stdin.destroy(); handleInput(); }
});
process.stdin.on("end", () => { if (!done) { done = true; handleInput(); } });
process.stdin.on("error", () => { if (!done) { done = true; handleInput(); } });
setTimeout(() => { if (!done) { done = true; try { process.stdin.destroy(); } catch(e) {} handleInput(); } }, 2000);

// --- helpers ---

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getBranch() {
  try {
    return execSync("git branch --show-current", { cwd: REPO_ROOT, timeout: 3000 })
      .toString().trim();
  } catch(e) { return null; }
}

function isParentSession(fullId) {
  if (!fullId) return true; // fallback: assume parent
  const taskDir = path.join(TASKS_BASE, fullId);
  return fs.existsSync(taskDir);
}

function sessionFilePath(shortId) {
  return path.join(SESSIONS_DIR, shortId + ".json");
}

function cleanupStaleSessions() {
  try {
    if (!fs.existsSync(SESSIONS_DIR)) return;
    const now = Date.now();
    const cutoff = STALE_HOURS * 3600 * 1000;
    for (const file of fs.readdirSync(SESSIONS_DIR)) {
      if (!file.endsWith(".json")) continue;
      const fp = path.join(SESSIONS_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(fp, "utf8"));
        const lastTs = new Date(data.last_activity_ts || 0).getTime();
        if (now - lastTs > cutoff) {
          fs.unlinkSync(fp);
        }
      } catch(e) { /* skip corrupt files */ }
    }
  } catch(e) {}
}

function categorize(toolName) {
  switch (toolName) {
    case "Bash": return "bash";
    case "Edit": case "Write": case "Read": case "Glob": case "Grep": case "NotebookEdit": return "file";
    case "Task": return "agent";
    case "Skill": return "skill";
    case "TaskCreate": case "TaskUpdate": case "TaskList": case "TaskGet": return "task";
    case "WebFetch": case "WebSearch": return "web";
    case "AskUserQuestion": return "user";
    case "EnterPlanMode": case "ExitPlanMode": return "meta";
    default: return "other";
  }
}

// --- per-session state ---

function updateSession(fullId, shortId, ts, toolName, skillName, permMode) {
  ensureDir(SESSIONS_DIR);

  const fp = sessionFilePath(shortId);
  let session = null;
  try { session = JSON.parse(fs.readFileSync(fp, "utf8")); } catch(e) {}

  const isNew = !session;

  if (isNew) {
    const isParent = isParentSession(fullId);
    session = {
      id: shortId,
      full_id: fullId,
      type: isParent ? "parent" : "sub",
      started_ts: ts,
      last_activity_ts: ts,
      action_count: 0,
      branch: getBranch(),
      agent_name: null,
      skills_invoked: [],
      sub_count: 0,
      permission_mode: permMode || null,
      status: "active",
    };
<<<<<<< docs/agents-automation
  } else if (session.type === "sub" && isParentSession(fullId)) {
    // Recalcular: el taskdir puede no existir en el primer evento pero si despues
    session.type = "parent";
=======
>>>>>>> main
  }

  session.action_count++;
  session.last_activity_ts = ts;

  // Track skills
  if (skillName) {
    const skillKey = "/" + skillName;
    if (!session.skills_invoked.includes(skillKey)) {
      session.skills_invoked.push(skillKey);
    }
    // Mapear skill → agente (el mas reciente gana)
    if (SKILL_AGENT_MAP[skillName]) {
      session.agent_name = SKILL_AGENT_MAP[skillName];
    }
  }

  // Contador de sub-agentes
  if (toolName === "Task") {
    session.sub_count++;
  }

  try {
    fs.writeFileSync(fp, JSON.stringify(session, null, 2) + "\n", "utf8");
  } catch(e) {}

  // Backward compat: session-state.json apunta a esta sesion
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify({
      current_session: shortId,
      session_start_ts: session.started_ts,
      action_count: session.action_count,
      skills_invoked: session.skills_invoked,
      agents_launched: session.sub_count,
      last_activity_ts: session.last_activity_ts,
    }, null, 2) + "\n", "utf8");
  } catch(e) {}
}

// --- main ---

function handleInput() {
  try {
    let data;
    try { data = JSON.parse(input); } catch(e) {
      const m = input.match(/"tool_name"\s*:\s*"([^"]+)"/);
      if (!m) return;
      data = { tool_name: m[1], tool_input: {} };
      const fm = input.match(/"file_path"\s*:\s*"([^"]+)"/);
      if (fm) data.tool_input = { file_path: fm[1] };
      const cm = input.match(/"command"\s*:\s*"([^"]+)"/);
      if (cm) data.tool_input = { command: cm[1] };
    }

    const toolName = data.tool_name || "";
    if (!toolName) return;

<<<<<<< docs/agents-automation
    // Ignorar herramientas de solo lectura y TaskOutput (mucho ruido, session null)
    if (["TaskList", "TaskGet", "TaskOutput", "Read", "Glob", "Grep"].includes(toolName)) return;
=======
    // Ignorar herramientas de solo lectura (mucho ruido)
    if (["TaskList", "TaskGet", "Read", "Glob", "Grep"].includes(toolName)) return;
>>>>>>> main

    const ti = data.tool_input || {};
    let target = "--";

    switch (toolName) {
      case "Edit": case "Write": case "NotebookEdit":
        target = ti.file_path || ti.notebook_path || "--";
        break;
      case "Bash":
        target = (ti.command || "--").substring(0, 80);
        break;
      case "Task":
        target = (ti.description || "--").substring(0, 80);
        break;
      case "TaskCreate": case "TaskUpdate":
        target = ti.subject || (ti.taskId ? "task #" + ti.taskId : "--");
        break;
      case "WebFetch": case "WebSearch":
        target = ti.url || ti.query || "--";
        break;
      case "Skill":
        target = ti.skill || "--";
        break;
      case "AskUserQuestion":
        target = ((ti.questions && ti.questions[0] && ti.questions[0].question) || "--").substring(0, 80);
        break;
    }

    const fullId = data.session_id || "";
    const shortId = fullId.substring(0, 8);
    const cat = categorize(toolName);
    const skillName = toolName === "Skill" ? (ti.skill || null) : null;
    const agentDesc = toolName === "Task" ? (ti.description || "").substring(0, 40) || null : null;
    const permMode = data.permission_mode || null;

    const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");

    // Append to activity log (kept for historical record)
    ensureDir(CLAUDE_DIR);
    const entry = JSON.stringify({
      ts,
      session: shortId || null,
      tool: toolName,
      cat,
      target: target.substring(0, 120),
      skill: skillName,
      agent: agentDesc,
    });
    fs.appendFileSync(LOG_FILE, entry + "\n", "utf8");

    // Update per-session file
    if (shortId) {
      updateSession(fullId, shortId, ts, toolName, skillName, permMode);
    }

<<<<<<< docs/agents-automation
    // Cleanup stale sessions (throttled: cada N invocaciones)
    if (shortId) {
      try {
        const s = JSON.parse(fs.readFileSync(sessionFilePath(shortId), "utf8"));
        if (s.action_count % CLEANUP_EVERY_N === 0) cleanupStaleSessions();
      } catch(e) { cleanupStaleSessions(); }
    }
=======
    // Cleanup stale sessions (cheap — runs every invocation)
    cleanupStaleSessions();
>>>>>>> main

    // Rotate activity log
    try {
      const content = fs.readFileSync(LOG_FILE, "utf8").trim();
      const lines = content.split("\n");
      if (lines.length > MAX_LOG_LINES) {
        const keep = Math.floor(MAX_LOG_LINES / 2);
        fs.writeFileSync(LOG_FILE, lines.slice(-keep).join("\n") + "\n", "utf8");
      }
    } catch(e) {}
  } catch(e) {}
}

#!/usr/bin/env node
// Reporter Background — Inicia/detiene el reporter PNG de Telegram
// Uso:
//   node .claude/hooks/reporter-bg.js start [minutos]   (defecto: 5)
//   node .claude/hooks/reporter-bg.js stop
//   node .claude/hooks/reporter-bg.js status
const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");
const DASHBOARD = path.join(REPO_ROOT, "dashboard.js");
const PID_FILE = path.join(REPO_ROOT, "tmp", "reporter.pid");
const LOG_FILE = path.join(REPO_ROOT, "hooks", "hook-debug.log");

function debugLog(msg) {
  try {
    fs.appendFileSync(LOG_FILE, "[" + new Date().toISOString() + "] reporter-bg: " + msg + "\n");
  } catch (e) {}
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

function readPid() {
  try {
    if (!fs.existsSync(PID_FILE)) return null;
    const pid = parseInt(fs.readFileSync(PID_FILE, "utf8").trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch (e) {
    return null;
  }
}

function start(intervalMin) {
  const existing = readPid();
  if (existing && isRunning(existing)) {
    console.log("Reporter ya corriendo (PID " + existing + ")");
    return existing;
  }

  // Limpiar PID file viejo
  try { fs.unlinkSync(PID_FILE); } catch (e) {}

  // Crear dir tmp si no existe
  try { fs.mkdirSync(path.dirname(PID_FILE), { recursive: true }); } catch (e) {}

  const child = spawn(process.execPath, [DASHBOARD, "--headless", "--report", String(intervalMin)], {
    detached: true,
    stdio: "ignore",
    cwd: REPO_ROOT,
  });

  child.unref();
  debugLog("Iniciado reporter headless PID " + child.pid + " cada " + intervalMin + " min");
  console.log("Reporter iniciado: PID " + child.pid + ", reporte PNG cada " + intervalMin + " min");
  return child.pid;
}

function stop() {
  const pid = readPid();
  if (!pid) {
    console.log("Reporter no esta corriendo");
    return false;
  }
  if (!isRunning(pid)) {
    console.log("Reporter PID " + pid + " ya no existe, limpiando");
    try { fs.unlinkSync(PID_FILE); } catch (e) {}
    return false;
  }
  try {
    process.kill(pid, "SIGTERM");
    console.log("Reporter detenido (PID " + pid + ")");
    debugLog("Reporter detenido PID " + pid);
    try { fs.unlinkSync(PID_FILE); } catch (e) {}
    return true;
  } catch (e) {
    console.error("Error deteniendo PID " + pid + ": " + e.message);
    return false;
  }
}

function status() {
  const pid = readPid();
  if (!pid) {
    console.log("Reporter: detenido");
    return false;
  }
  if (isRunning(pid)) {
    console.log("Reporter: corriendo (PID " + pid + ")");
    return true;
  } else {
    console.log("Reporter: PID " + pid + " muerto, limpiando");
    try { fs.unlinkSync(PID_FILE); } catch (e) {}
    return false;
  }
}

// --- CLI ---
const cmd = process.argv[2] || "start";
const interval = parseInt(process.argv[3], 10) || 5;

if (cmd === "start") {
  start(interval);
} else if (cmd === "stop") {
  stop();
} else if (cmd === "status") {
  status();
} else {
  console.log("Uso: reporter-bg.js [start|stop|status] [minutos]");
}

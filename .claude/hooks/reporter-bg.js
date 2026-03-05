#!/usr/bin/env node
// Reporter Background v2 — Gestiona dashboard-server.js + reportes periódicos a Telegram
// El dashboard web server sirve HTML en localhost:3100 y genera screenshots via Puppeteer.
// Este script:
//   1. Arranca dashboard-server.js si no está corriendo
//   2. Cada N minutos, toma screenshot y lo envía a Telegram como heartbeat (silencioso)
// Uso:
//   node .claude/hooks/reporter-bg.js start [minutos]   (defecto: 10)
//   node .claude/hooks/reporter-bg.js stop
//   node .claude/hooks/reporter-bg.js status
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");

const REPO_ROOT = path.resolve(__dirname, "..");
const DASHBOARD_SERVER = path.join(REPO_ROOT, "dashboard-server.js");
const PID_FILE = path.join(REPO_ROOT, "tmp", "reporter.pid");
const SERVER_PID_FILE = path.join(REPO_ROOT, "tmp", "dashboard-server.pid");
const LOG_FILE = path.join(REPO_ROOT, "hooks", "hook-debug.log");
const TG_CONFIG_FILE = path.join(REPO_ROOT, "hooks", "telegram-config.json");
const DASHBOARD_PORT = 3100;

function debugLog(msg) {
  try {
    fs.appendFileSync(LOG_FILE, "[" + new Date().toISOString() + "] reporter-bg: " + msg + "\n");
  } catch (e) {}
}

function isRunning(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readPid(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const pid = parseInt(fs.readFileSync(file, "utf8").trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch { return null; }
}

function readTgConfig() {
  try { return JSON.parse(fs.readFileSync(TG_CONFIG_FILE, "utf8")); }
  catch { return { bot_token: "", chat_id: "" }; }
}

// Verificar si el dashboard web server está corriendo
function isDashboardServerRunning() {
  const pid = readPid(SERVER_PID_FILE);
  if (pid && isRunning(pid)) return true;
  return false;
}

// Verificar si el dashboard responde via HTTP (más fiable que PID file)
function isDashboardServerReachable() {
  try {
    const { execSync } = require("child_process");
    execSync("node -e \"const r=require('http').get('http://localhost:" + DASHBOARD_PORT + "/health',{timeout:2000},s=>{process.exit(s.statusCode===200?0:1)});r.on('error',()=>process.exit(1))\"", { timeout: 4000, windowsHide: true, stdio: "ignore" });
    return true;
  } catch { return false; }
}

// Arrancar dashboard-server.js si no está corriendo
function ensureDashboardServer() {
  // 1. Check PID file
  if (isDashboardServerRunning()) {
    debugLog("Dashboard server ya corriendo (PID)");
    return;
  }
  // 2. Check HTTP health (cubre caso de server sin PID file)
  if (isDashboardServerReachable()) {
    debugLog("Dashboard server ya corriendo (HTTP health OK)");
    return;
  }

  if (!fs.existsSync(DASHBOARD_SERVER)) {
    debugLog("No se encontro dashboard-server.js: " + DASHBOARD_SERVER);
    return;
  }

  const child = spawn(process.execPath, [DASHBOARD_SERVER], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    cwd: path.dirname(script),
  });
  child.on("error", () => {}); // No crashear si spawn falla
  child.unref();
  debugLog("Iniciado dashboard server PID " + child.pid);
}

// Obtener screenshot del dashboard web
function fetchScreenshot(width, height) {
  return new Promise((resolve) => {
    const req = http.get("http://localhost:" + DASHBOARD_PORT + "/screenshot?w=" + width + "&h=" + height, { timeout: 15000 }, (res) => {
      if (res.statusCode !== 200) { resolve(null); return; }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

// Enviar foto a Telegram (heartbeat silencioso)
function sendTelegramPhoto(photoBuffer, caption, silent) {
  const cfg = readTgConfig();
  if (!cfg.bot_token || !cfg.chat_id) { debugLog("Telegram no configurado"); return Promise.resolve(null); }

  return new Promise((resolve, reject) => {
    const boundary = "----FormBoundary" + Date.now().toString(36);
    let body = "";
    body += "--" + boundary + "\r\nContent-Disposition: form-data; name=\"chat_id\"\r\n\r\n" + cfg.chat_id + "\r\n";
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
      path: "/bot" + cfg.bot_token + "/sendPhoto",
      method: "POST",
      headers: { "Content-Type": "multipart/form-data; boundary=" + boundary, "Content-Length": payload.length },
      timeout: 15000
    }, (res) => {
      let d = "";
      res.on("data", (c) => d += c);
      res.on("end", () => {
        try {
          const r = JSON.parse(d);
          if (r.ok) { debugLog("Heartbeat foto OK msg_id=" + r.result.message_id); resolve(r); }
          else { debugLog("Heartbeat foto error: " + d); reject(new Error(d)); }
        } catch(e) { reject(e); }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", (e) => reject(e));
    req.write(payload);
    req.end();
  });
}

// Obtener screenshots partidos del dashboard web (para álbum)
function fetchScreenshots(width, height) {
  return new Promise((resolve) => {
    const req = http.get("http://localhost:" + DASHBOARD_PORT + "/screenshots?w=" + width + "&h=" + height, { timeout: 25000 }, (res) => {
      if (res.statusCode !== 200) { resolve(null); return; }
      let d = "";
      res.on("data", (c) => d += c);
      res.on("end", () => {
        try {
          const json = JSON.parse(d);
          resolve({ top: Buffer.from(json.top, "base64"), bottom: Buffer.from(json.bottom, "base64") });
        } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

// Enviar álbum de fotos a Telegram (heartbeat silencioso)
function sendTelegramMediaGroup(photos, caption, silent) {
  const cfg = readTgConfig();
  if (!cfg.bot_token || !cfg.chat_id) { debugLog("Telegram no configurado"); return Promise.resolve(null); }

  return new Promise((resolve, reject) => {
    const boundary = "----FormBoundary" + Date.now().toString(36);
    const media = photos.map((_, i) => ({
      type: "photo",
      media: "attach://photo" + i,
      ...(i === 0 && caption ? { caption, parse_mode: "HTML" } : {})
    }));

    let parts = [];
    parts.push(Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"chat_id\"\r\n\r\n" + cfg.chat_id + "\r\n"));
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
      path: "/bot" + cfg.bot_token + "/sendMediaGroup",
      method: "POST",
      headers: { "Content-Type": "multipart/form-data; boundary=" + boundary, "Content-Length": payload.length },
      timeout: 20000
    }, (res) => {
      let d = "";
      res.on("data", (c) => d += c);
      res.on("end", () => {
        try {
          const r = JSON.parse(d);
          if (r.ok) { debugLog("Heartbeat álbum OK"); resolve(r); }
          else { debugLog("Heartbeat álbum error: " + d); reject(new Error(d)); }
        } catch (e) { reject(e); }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// Enviar texto a Telegram (fallback)
function sendTelegramText(text, silent) {
  const cfg = readTgConfig();
  if (!cfg.bot_token || !cfg.chat_id) return Promise.resolve(null);

  return new Promise((resolve, reject) => {
    const params = JSON.stringify({
      chat_id: cfg.chat_id, text: text, parse_mode: "HTML",
      disable_web_page_preview: true, disable_notification: !!silent
    });
    const req = https.request({
      hostname: "api.telegram.org",
      path: "/bot" + cfg.bot_token + "/sendMessage",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(params) },
      timeout: 5000
    }, (res) => {
      let d = "";
      res.on("data", (c) => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    req.write(params); req.end();
  });
}

// Reporte periódico: screenshot + envío a Telegram
async function sendPeriodicReport() {
  debugLog("Generando reporte periodico...");

  // Asegurar que el dashboard server está corriendo
  ensureDashboardServer();

  // Esperar un momento para que arranque
  await new Promise(r => setTimeout(r, 2000));

  const caption = "\ud83d\udc9a <b>Intrale Monitor</b> \u2014 Heartbeat\n" + new Date().toLocaleString("es-AR");

  // Intentar álbum de 2 fotos primero
  try {
    const parts = await fetchScreenshots(600, 800);
    if (parts && parts.top.length > 1000 && parts.bottom.length > 1000) {
      await sendTelegramMediaGroup([parts.top, parts.bottom], caption, true);
      return;
    }
  } catch (e) {
    debugLog("Error con álbum screenshots: " + e.message);
  }

  // Fallback: single screenshot
  const screenshot = await fetchScreenshot(375, 640);
  if (screenshot && screenshot.length > 1000) {
    try {
      await sendTelegramPhoto(screenshot, caption, true);
    } catch(e) {
      debugLog("Error enviando screenshot: " + e.message);
      await sendTelegramText("\ud83d\udc9a <b>Heartbeat</b>\nDashboard activo en localhost:" + DASHBOARD_PORT + "\n" + new Date().toLocaleString("es-AR"), true);
    }
  } else {
    debugLog("Screenshot no disponible, enviando texto");
    // Intentar obtener status JSON
    try {
      const statusData = await new Promise((resolve) => {
        const req = http.get("http://localhost:" + DASHBOARD_PORT + "/api/status", { timeout: 5000 }, (res) => {
          let d = ""; res.on("data", c => d += c);
          res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
        });
        req.on("error", () => resolve(null));
      });
      if (statusData) {
        const text = "\ud83d\udc9a <b>Heartbeat</b>\n" +
          "\u25cf " + statusData.activeSessions + " activos, " + statusData.idleSessions + " idle\n" +
          "\u25cf " + statusData.completedTasks + "/" + statusData.totalTasks + " tareas\n" +
          "\u25cf CI: " + statusData.ciStatus + "\n" +
          "\u25cf " + statusData.totalActions + " acciones";
        await sendTelegramText(text, true);
      }
    } catch(e) { debugLog("Fallback text tambien fallo: " + e.message); }
  }
}

function start(intervalMin) {
  const existing = readPid(PID_FILE);
  if (existing && isRunning(existing)) {
    console.log("Reporter ya corriendo (PID " + existing + ")");
    return existing;
  }

  try { fs.unlinkSync(PID_FILE); } catch {}
  try { fs.mkdirSync(path.dirname(PID_FILE), { recursive: true }); } catch {}

  // Arrancar dashboard web server
  ensureDashboardServer();

  // Escribir PID del reporter (este proceso en modo loop, o detached)
  if (process.argv.includes("--daemon")) {
    // Modo daemon: loop infinito con reportes periódicos
    fs.writeFileSync(PID_FILE, String(process.pid), "utf8");
    debugLog("Reporter daemon PID " + process.pid + " cada " + intervalMin + " min");
    console.log("Reporter daemon: PID " + process.pid + ", reporte cada " + intervalMin + " min");

    // Primer reporte inmediato
    sendPeriodicReport();

    // Reportes periódicos
    setInterval(sendPeriodicReport, intervalMin * 60 * 1000);
    return process.pid;
  }

  // Modo spawn: lanzar como daemon detached
  const child = spawn(process.execPath, [__filename, "start", String(intervalMin), "--daemon"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    cwd: REPO_ROOT,
  });
  child.unref();

  debugLog("Iniciado reporter daemon PID " + child.pid + " cada " + intervalMin + " min");
  console.log("Reporter iniciado: PID " + child.pid + ", reporte cada " + intervalMin + " min");
  return child.pid;
}

function stop() {
  let stopped = false;

  // Detener reporter
  const pid = readPid(PID_FILE);
  if (pid && isRunning(pid)) {
    try { process.kill(pid, "SIGTERM"); stopped = true; console.log("Reporter detenido (PID " + pid + ")"); } catch {}
  }
  try { fs.unlinkSync(PID_FILE); } catch {}

  // Detener dashboard server
  const serverPid = readPid(SERVER_PID_FILE);
  if (serverPid && isRunning(serverPid)) {
    try { process.kill(serverPid, "SIGTERM"); stopped = true; console.log("Dashboard server detenido (PID " + serverPid + ")"); } catch {}
  }
  try { fs.unlinkSync(SERVER_PID_FILE); } catch {}

  if (!stopped) console.log("Nada corriendo");
  return stopped;
}

function status() {
  const pid = readPid(PID_FILE);
  const serverPid = readPid(SERVER_PID_FILE);
  const reporterOk = pid && isRunning(pid);
  const serverOk = serverPid && isRunning(serverPid);

  console.log("Reporter: " + (reporterOk ? "corriendo (PID " + pid + ")" : "detenido"));
  console.log("Dashboard server: " + (serverOk ? "corriendo (PID " + serverPid + ") → http://localhost:" + DASHBOARD_PORT : "detenido"));

  if (!reporterOk && pid) { try { fs.unlinkSync(PID_FILE); } catch {} }
  if (!serverOk && serverPid) { try { fs.unlinkSync(SERVER_PID_FILE); } catch {} }

  return reporterOk || serverOk;
}

// --- CLI ---
const cmd = (process.argv.includes("--daemon") ? "daemon" : process.argv[2]) || "start";
const interval = parseInt(process.argv[3], 10) || 10;

if (cmd === "start") {
  start(interval);
} else if (cmd === "stop") {
  stop();
} else if (cmd === "status") {
  status();
} else if (cmd === "daemon") {
  // Interno: no llamar directamente
} else {
  console.log("Uso: reporter-bg.js [start|stop|status] [minutos]");
}

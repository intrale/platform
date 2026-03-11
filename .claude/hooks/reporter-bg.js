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
const SKIP_ALERT_THRESHOLD = 3; // Alertar a Telegram tras N skips consecutivos
const HEARTBEAT_STATE_FILE = path.join(REPO_ROOT, "hooks", "heartbeat-state.json");
const SESSIONS_DIR = path.join(REPO_ROOT, "sessions");
const ACTIVITY_THRESHOLD_MIN = 15; // Minutos para considerar una sesión como activa

// Contador de heartbeats saltados por fallo de screenshot
let consecutiveSkipCount = 0;

// Estado del modo actual (se actualiza antes de cada sendPeriodicReport)
let heartbeatMode = "normal";   // "normal" | "idle"
let heartbeatIntervalMin = 10;  // Intervalo actual en minutos

function debugLog(msg) {
  try {
    fs.appendFileSync(LOG_FILE, "[" + new Date().toISOString() + "] reporter-bg: " + msg + "\n");
  } catch (e) {}
}

// Validar que un buffer es un PNG real (magic bytes 89 50 4E 47 0D 0A 1A 0A)
function isPngValid(buf) {
  if (!buf || buf.length < 8) return false;
  return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 &&
         buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A;
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
    cwd: REPO_ROOT,
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

// Obtener screenshots por sección semántica del dashboard (nuevo endpoint #1263)
// Retorna array de { id, buf } o null si el endpoint no está disponible
function fetchScreenshotSections(width) {
  return new Promise((resolve) => {
    const req = http.get("http://localhost:" + DASHBOARD_PORT + "/screenshots/sections?w=" + width, { timeout: 30000 }, (res) => {
      if (res.statusCode !== 200) { resolve(null); return; }
      let d = "";
      res.on("data", (c) => d += c);
      res.on("end", () => {
        try {
          const sections = JSON.parse(d);
          if (!Array.isArray(sections) || sections.length === 0) { resolve(null); return; }
          resolve(sections.map(function(s) { return { id: s.id, buf: Buffer.from(s.image, "base64") }; }));
        } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
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

// Consultar si hay agentes activos via dashboard API
function hasActiveAgents() {
  return new Promise((resolve) => {
    const req = http.get("http://localhost:" + DASHBOARD_PORT + "/api/status", { timeout: 3000 }, (res) => {
      let d = "";
      res.on("data", (c) => d += c);
      res.on("end", () => {
        try {
          const status = JSON.parse(d);
          resolve((status.activeSessions || 0) > 0);
        } catch { resolve(false); }
      });
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

// Detectar sesiones activas leyendo .claude/sessions/*.json directamente
// Criterio: status === "active" y last_activity_ts < ACTIVITY_THRESHOLD_MIN minutos
function hasActiveSessions() {
  try {
    if (!fs.existsSync(SESSIONS_DIR)) return false;
    const files = fs.readdirSync(SESSIONS_DIR).filter(function(f) { return f.endsWith(".json"); });
    const now = Date.now();
    const threshold = ACTIVITY_THRESHOLD_MIN * 60 * 1000;
    for (const file of files) {
      try {
        const session = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), "utf8"));
        if (session.status === "active" && session.last_activity_ts) {
          const lastActivity = new Date(session.last_activity_ts).getTime();
          if (now - lastActivity < threshold) return true;
        }
      } catch {}
    }
    return false;
  } catch { return false; }
}

// Cargar estado persistido del heartbeat desde heartbeat-state.json
function loadHeartbeatState() {
  try {
    if (!fs.existsSync(HEARTBEAT_STATE_FILE)) return null;
    return JSON.parse(fs.readFileSync(HEARTBEAT_STATE_FILE, "utf8"));
  } catch { return null; }
}

// Guardar estado del heartbeat en heartbeat-state.json
function saveHeartbeatState(currentInterval, consecutiveIdle, mode) {
  try {
    const state = {
      currentInterval,
      consecutiveIdle,
      lastHeartbeat: new Date().toISOString(),
      mode
    };
    fs.writeFileSync(HEARTBEAT_STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (e) { debugLog("Error guardando heartbeat-state.json: " + e.message); }
}

// Constantes de frecuencia adaptativa
const INTERVAL_STEP_MIN = 10;         // Minutos extra por cada ciclo inactivo
const MAX_INTERVAL_MIN = 60;          // Cap máximo del intervalo

// Reporte periódico: screenshot + envío a Telegram
// NUNCA cae al fallback ASCII — si screenshot falla, omite el envío (silencioso)
async function sendPeriodicReport() {
  debugLog("Generando reporte periodico (intento)...");

  // Asegurar que el dashboard server está corriendo
  ensureDashboardServer();

  // Esperar a que el server arranque si recién inició
  await new Promise(r => setTimeout(r, 2000));

  // Verificar que el dashboard responde antes de intentar screenshot
  const reachable = isDashboardServerReachable();
  if (!reachable) {
    debugLog("Dashboard no responde — omitiendo heartbeat este ciclo");
    consecutiveSkipCount++;
    debugLog("Skips consecutivos: " + consecutiveSkipCount);
    await checkAndAlertSkips();
    return;
  }

  const dateStr = new Date().toLocaleString("es-AR");

  // Indicador de modo en el caption principal
  const modeLabel = heartbeatMode === "normal"
    ? "\ud83d\udc9a <b>Intrale Monitor</b> \u2014 Heartbeat (cada " + heartbeatIntervalMin + " min)"
    : "\ud83d\udca4 <b>Intrale Monitor</b> \u2014 Heartbeat (cada " + heartbeatIntervalMin + " min \u2014 sin actividad)";

  // Mapa de captions descriptivos por section ID
  const SECTION_CAPTIONS = {
    kpis:            "\ud83d\udcca <b>KPIs</b> \u2014 " + modeLabel + " \u2014 " + dateStr,
    ejecucion:       "\u26a1 <b>Ejecuci\u00f3n de agentes</b>",
    sesiones:        "\ud83e\uddd1\u200d\ud83d\udcbb <b>Sesiones activas</b>",
    metricas:        "\ud83d\udcca <b>M\u00e9tricas de uso</b>",
    flujo:           "\ud83d\udd00 <b>Flujo de agentes</b>",
    actividad:       "\ud83d\udce1 <b>Actividad en vivo</b>",
    permisos:        "\ud83d\udd12 <b>Permisos</b>",
    "agentes-metricas": "\ud83d\udcca <b>M\u00e9tricas de agentes</b>",
    roadmap:         "\ud83d\uddd3\ufe0f <b>Roadmap</b>",
    ci:              "\ud83d\udee0\ufe0f <b>CI / CD</b>",
  };

  // 1. Intentar álbum por secciones semánticas (mobile-first 390px, #1263)
  try {
    debugLog("Intentando screenshot de secciones (390px)...");
    const sections = await fetchScreenshotSections(390);
    debugLog("fetchScreenshotSections result: " + (sections ? sections.length + " secciones [" + sections.map(s => s.id + "=" + s.buf.length + "b").join(", ") + "]" : "null"));
    if (sections && sections.length >= 2) {
      const validSections = sections.filter(function(s) {
        const ok = isPngValid(s.buf) && s.buf.length > 500;
        if (!ok) debugLog("Seccion descartada: id=" + s.id + " size=" + s.buf.length + "b isPng=" + isPngValid(s.buf));
        return ok;
      });
      debugLog("Secciones válidas: " + validSections.length + "/" + sections.length + " [" + validSections.map(s => s.id).join(", ") + "]");
      if (validSections.length >= 2) {
        // Enviar fotos en serie con captions individuales (Telegram solo soporta caption en 1ra foto de sendMediaGroup)
        debugLog("Enviando " + validSections.length + " paneles con captions individuales...");
        let sentCount = 0;
        for (const section of validSections) {
          try {
            const cap = SECTION_CAPTIONS[section.id] || ("\ud83d\udcf8 <b>" + section.id + "</b>");
            await sendTelegramPhoto(section.buf, cap, true);
            sentCount++;
            if (sentCount < validSections.length) {
              await new Promise(r => setTimeout(r, 200));
            }
          } catch (photoErr) {
            debugLog("Error enviando panel " + section.id + ": " + (photoErr.stack || photoErr.message));
          }
        }
        if (sentCount > 0) {
          debugLog("Heartbeat secciones OK (" + sentCount + "/" + validSections.length + " paneles enviados)");
          consecutiveSkipCount = 0;
          return;
        }
      }
      debugLog("Secciones insuficientes o inválidas: " + sections.length + " totales, " + (sections ? sections.filter(s => isPngValid(s.buf) && s.buf.length > 500).length : 0) + " válidas (umbral 500b)");
    } else {
      debugLog("fetchScreenshotSections devolvió " + (sections ? sections.length + " secciones (mínimo 2 requeridas)" : "null"));
    }
  } catch (e) {
    debugLog("Error con secciones: " + (e.stack || e.message));
  }

  const caption = modeLabel + "\n" + dateStr;

  // 2. Intentar álbum top/bottom (endpoint /screenshots)
  try {
    debugLog("Intentando álbum top/bottom (600x800)...");
    const parts = await fetchScreenshots(600, 800);
    if (parts && isPngValid(parts.top) && parts.top.length > 1000 && isPngValid(parts.bottom) && parts.bottom.length > 1000) {
      await sendTelegramMediaGroup([parts.top, parts.bottom], caption, true);
      debugLog("Heartbeat álbum top/bottom OK (top=" + parts.top.length + "b bottom=" + parts.bottom.length + "b)");
      consecutiveSkipCount = 0;
      return;
    }
    debugLog("Álbum inválido o buffers vacíos: top=" + (parts ? parts.top.length : 0) + "b bottom=" + (parts ? parts.bottom.length : 0) + "b");
  } catch (e) {
    debugLog("Error con álbum screenshots: " + e.message);
  }

  // 3. Último intento: foto única (375x640)
  try {
    debugLog("Intentando screenshot único (375x640)...");
    const screenshot = await fetchScreenshot(375, 640);
    if (screenshot && isPngValid(screenshot) && screenshot.length > 1000) {
      await sendTelegramPhoto(screenshot, caption, true);
      debugLog("Heartbeat foto única OK (" + screenshot.length + " bytes)");
      consecutiveSkipCount = 0;
      return;
    }
    debugLog("Screenshot único inválido o vacío: " + (screenshot ? screenshot.length : 0) + "b, isPng=" + (screenshot ? isPngValid(screenshot) : false));
  } catch (e) {
    debugLog("Error enviando screenshot único: " + e.message);
  }

  // Todos los intentos fallaron — omitir heartbeat este ciclo (NUNCA enviar texto ASCII)
  consecutiveSkipCount++;
  debugLog("Heartbeat omitido — todos los screenshots fallaron. Skips consecutivos: " + consecutiveSkipCount);
  await checkAndAlertSkips();
}

// Enviar alerta a Telegram si se superó el umbral de skips consecutivos
async function checkAndAlertSkips() {
  if (consecutiveSkipCount >= SKIP_ALERT_THRESHOLD) {
    debugLog("Umbral de skips alcanzado (" + consecutiveSkipCount + ") — enviando alerta a Telegram");
    try {
      await sendTelegramText(
        "\u26a0\ufe0f <b>Reporter: sin screenshots</b>\n" +
        "El heartbeat fue omitido <b>" + consecutiveSkipCount + " veces consecutivas</b>.\n" +
        "Verifica que <code>dashboard-server.js</code> est\u00e9 corriendo y que Puppeteer est\u00e9 instalado.",
        false
      );
      // Reset para no spamear (alertar cada SKIP_ALERT_THRESHOLD ciclos)
      consecutiveSkipCount = 0;
    } catch (e) {
      debugLog("Error enviando alerta de skips: " + e.message);
    }
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
    // Modo daemon: loop con frecuencia adaptativa (#1255)
    fs.writeFileSync(PID_FILE, String(process.pid), "utf8");
    debugLog("Reporter daemon PID " + process.pid + " base " + intervalMin + " min (adaptativo)");
    console.log("Reporter daemon: PID " + process.pid + ", base " + intervalMin + " min (adaptativo)");

    // Cargar estado persistido al arrancar (sobrevive reinicios)
    const persistedState = loadHeartbeatState();
    let consecutiveIdle = persistedState ? (persistedState.consecutiveIdle || 0) : 0;
    let previousMode = persistedState ? (persistedState.mode || "normal") : "normal";

    async function adaptiveLoop() {
      // Detectar actividad leyendo sesiones directamente (.claude/sessions/*.json)
      const active = hasActiveSessions();
      const wasIdle = previousMode === "idle";

      // Actualizar modo y contador
      if (active) {
        if (wasIdle) {
          // Transición: inactivo → normal — notificar y enviar heartbeat inmediato
          debugLog("Transicion idle->normal detectada — enviando mensaje de actividad");
          try {
            await sendTelegramText(
              "\ud83d\udd04 <b>Actividad detectada</b> \u2014 volviendo a monitoreo normal (10 min)",
              false
            );
          } catch (e) { debugLog("Error enviando msg transicion: " + e.message); }
        }
        consecutiveIdle = 0;
        heartbeatMode = "normal";
      } else {
        consecutiveIdle++;
        heartbeatMode = "idle";
      }

      // Intervalo adaptativo: 10 base, +10 por cada ciclo inactivo, cap 60
      const nextInterval = active ? intervalMin : Math.min(intervalMin + (consecutiveIdle * INTERVAL_STEP_MIN), MAX_INTERVAL_MIN);
      heartbeatIntervalMin = nextInterval;
      previousMode = heartbeatMode;

      debugLog("intervalo adaptativo: " + nextInterval + "min (consecutiveIdle=" + consecutiveIdle + ", modo=" + heartbeatMode + ")");

      // Enviar reporte con el modo actualizado en los captions
      await sendPeriodicReport();

      // Persistir estado para sobrevivir reinicios
      saveHeartbeatState(nextInterval, consecutiveIdle, heartbeatMode);

      setTimeout(adaptiveLoop, nextInterval * 60 * 1000);
    }

    // Primer reporte inmediato
    adaptiveLoop();
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

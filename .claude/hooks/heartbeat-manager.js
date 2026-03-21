// heartbeat-manager.js — Módulo de heartbeat adaptativo para Intrale Monitor
// Extraído de dashboard-server.js — Issue #1430 (sub-tarea de #1416)
// API pública: { startHeartbeat, stopHeartbeat, getHeartbeatState }

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

// Paths propios del módulo (resueltos desde .claude/hooks/)
const HOOKS_DIR = __dirname;
const CLAUDE_DIR = path.resolve(HOOKS_DIR, '..');
const HEARTBEAT_STATE_FILE = path.join(HOOKS_DIR, 'heartbeat-state.json');
const TG_CONFIG_FILE = path.join(HOOKS_DIR, 'telegram-config.json');
const DEFAULT_SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');

// Resolver la raíz del repo principal (para leer roadmap.json desde el repo main, no desde un worktree)
function resolveMainRepoRoot() {
  const envRoot = process.env.CLAUDE_PROJECT_DIR || 'C:\\Workspaces\\Intrale\\platform';
  try {
    const { execSync } = require('child_process');
    const out = execSync('git worktree list', {
      encoding: 'utf8', cwd: envRoot, timeout: 5000, windowsHide: true
    });
    const firstLine = out.split('\n')[0] || '';
    const match = firstLine.match(/^(.+?)\s+[0-9a-f]{5,}/);
    if (match) return match[1].trim().replace(/\\/g, '/');
  } catch (e) {}
  return envRoot.replace(/\\/g, '/');
}

const MAIN_REPO_ROOT = resolveMainRepoRoot();
const ROADMAP_FILE = path.join(MAIN_REPO_ROOT, 'scripts', 'roadmap.json');

// Constantes del intervalo adaptativo
const INTERVAL_STEP_MIN = 15;       // +15 min por cada ciclo sin actividad
const MAX_INTERVAL_MIN = 180;       // Cap máximo: 3 horas
const ACTIVITY_THRESHOLD_MIN = 15;  // Umbral de actividad en minutos

// Estado interno del módulo (mutable entre ciclos)
let heartbeatCurrentInterval = 15;
let heartbeatConsecutiveIdle = 0;
let heartbeatMode = 'normal';       // "normal" | "idle"
let heartbeatSkipCount = 0;
const HEARTBEAT_SKIP_ALERT = 3;
let heartbeatTimer = null;

// Configuración inyectada por el caller en startHeartbeat()
let tgConfig = { bot_token: '', chat_id: '' };
let sessionsDir = DEFAULT_SESSIONS_DIR;
let reportIntervalMin = 15;
let portRef = 3100;
let collectDataFn = null;
let takeScreenshotFn = null;
let takeScreenshotSectionsFn = null;

// --- Horizonte del roadmap ---

/**
 * Lee roadmap.json y calcula el horizonte: número de sprints futuros planificados.
 * Retorna null si no se puede leer el archivo (falla silenciosa).
 */
function readRoadmapHorizon() {
  try {
    if (!fs.existsSync(ROADMAP_FILE)) return null;
    const roadmap = JSON.parse(fs.readFileSync(ROADMAP_FILE, 'utf8'));
    if (!Array.isArray(roadmap.sprints)) return null;
    const futureSprints = roadmap.sprints.filter(function(s) { return s.status !== 'done'; });
    return futureSprints.length;
  } catch { return null; }
}

// --- Estado persistente ---

function loadHeartbeatState() {
  try {
    if (!fs.existsSync(HEARTBEAT_STATE_FILE)) return null;
    return JSON.parse(fs.readFileSync(HEARTBEAT_STATE_FILE, 'utf8'));
  } catch { return null; }
}

function saveHeartbeatState() {
  try {
    const state = {
      currentInterval: heartbeatCurrentInterval,
      consecutiveIdle: heartbeatConsecutiveIdle,
      lastHeartbeat: new Date().toISOString(),
      mode: heartbeatMode
    };
    fs.writeFileSync(HEARTBEAT_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) { console.log('[heartbeat] Error guardando heartbeat-state.json: ' + e.message); }
}

// --- Detección de sesiones activas ---

// Detectar sesiones activas leyendo .claude/sessions/*.json directamente
// Criterio: status === "active" y last_activity_ts < ACTIVITY_THRESHOLD_MIN minutos
function hasActiveSessions() {
  try {
    if (!fs.existsSync(sessionsDir)) return false;
    const files = fs.readdirSync(sessionsDir).filter(function(f) { return f.endsWith('.json'); });
    const now = Date.now();
    const threshold = ACTIVITY_THRESHOLD_MIN * 60 * 1000;
    for (const file of files) {
      try {
        const session = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf8'));
        if (session.status === 'active' && session.last_activity_ts) {
          const lastActivity = new Date(session.last_activity_ts).getTime();
          if (now - lastActivity < threshold) return true;
        }
      } catch {}
    }
    return false;
  } catch { return false; }
}

// --- Envío Telegram ---

function sendTelegramText(text, silent) {
  if (!tgConfig.bot_token || !tgConfig.chat_id) return;
  const params = JSON.stringify({
    chat_id: tgConfig.chat_id, text, parse_mode: 'HTML',
    disable_web_page_preview: true, disable_notification: !!silent
  });
  const req = https.request({
    hostname: 'api.telegram.org',
    path: '/bot' + tgConfig.bot_token + '/sendMessage',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(params) },
    timeout: 10000
  }, (res) => {
    let body = '';
    res.on('data', (c) => body += c);
    res.on('end', () => {
      try {
        const r = JSON.parse(body);
        if (r.ok) console.log('[heartbeat] Telegram OK msg_id=' + r.result.message_id);
        else console.log('[heartbeat] Telegram error: ' + body.substring(0, 200));
      } catch { console.log('[heartbeat] Telegram respuesta no-JSON: ' + body.substring(0, 200)); }
    });
  });
  req.on('error', (e) => console.log('[heartbeat] Telegram req error: ' + e.message));
  req.write(params);
  req.end();
}

function sendTelegramPhoto(photoBuffer, caption, silent) {
  if (!tgConfig.bot_token || !tgConfig.chat_id) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const boundary = '----FormBoundary' + Date.now().toString(36);
    let body = '';
    body += '--' + boundary + '\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n' + tgConfig.chat_id + '\r\n';
    if (caption) {
      body += '--' + boundary + '\r\nContent-Disposition: form-data; name="caption"\r\n\r\n' + caption + '\r\n';
      body += '--' + boundary + '\r\nContent-Disposition: form-data; name="parse_mode"\r\n\r\nHTML\r\n';
    }
    if (silent) {
      body += '--' + boundary + '\r\nContent-Disposition: form-data; name="disable_notification"\r\n\r\ntrue\r\n';
    }
    const pre = Buffer.from(body + '--' + boundary + '\r\nContent-Disposition: form-data; name="photo"; filename="dashboard.png"\r\nContent-Type: image/png\r\n\r\n');
    const post = Buffer.from('\r\n--' + boundary + '--\r\n');
    const payload = Buffer.concat([pre, photoBuffer, post]);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: '/bot' + tgConfig.bot_token + '/sendPhoto',
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': payload.length },
      timeout: 15000
    }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(d);
          if (r.ok) { console.log('[heartbeat] Foto OK msg_id=' + r.result.message_id); resolve(r); }
          else { console.log('[heartbeat] Foto error: ' + d.substring(0, 200)); reject(new Error(d)); }
        } catch(e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', (e) => reject(e));
    req.write(payload);
    req.end();
  });
}

// Envia imagen como documento (sin compresion) para mayor calidad (#1740)
function sendTelegramDocument(fileBuffer, filename, caption, silent) {
  if (!tgConfig.bot_token || !tgConfig.chat_id) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const boundary = '----FormBoundary' + Date.now().toString(36);
    let body = '';
    body += '--' + boundary + '\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n' + tgConfig.chat_id + '\r\n';
    if (caption) {
      body += '--' + boundary + '\r\nContent-Disposition: form-data; name="caption"\r\n\r\n' + caption + '\r\n';
      body += '--' + boundary + '\r\nContent-Disposition: form-data; name="parse_mode"\r\n\r\nHTML\r\n';
    }
    if (silent) {
      body += '--' + boundary + '\r\nContent-Disposition: form-data; name="disable_notification"\r\n\r\ntrue\r\n';
    }
    const pre = Buffer.from(body + '--' + boundary + '\r\nContent-Disposition: form-data; name="document"; filename="' + filename + '"\r\nContent-Type: application/octet-stream\r\n\r\n');
    const post = Buffer.from('\r\n--' + boundary + '--\r\n');
    const payload = Buffer.concat([pre, fileBuffer, post]);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: '/bot' + tgConfig.bot_token + '/sendDocument',
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': payload.length },
      timeout: 20000
    }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(d);
          if (r.ok) { console.log('[heartbeat] Doc OK msg_id=' + r.result.message_id); resolve(r); }
          else { console.log('[heartbeat] Doc error: ' + d.substring(0, 200)); reject(new Error(d)); }
        } catch(e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout sendDocument')); });
    req.on('error', (e) => reject(e));
    req.write(payload);
    req.end();
  });
}

function sendTelegramMediaGroup(photos, caption, silent) {
  if (!tgConfig.bot_token || !tgConfig.chat_id) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const boundary = '----FormBoundary' + Date.now().toString(36);
    const media = photos.map((_, i) => ({
      type: 'photo',
      media: 'attach://photo' + i,
      ...(i === 0 && caption ? { caption, parse_mode: 'HTML' } : {})
    }));
    let parts = [];
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n' + tgConfig.chat_id + '\r\n'));
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="media"\r\n\r\n' + JSON.stringify(media) + '\r\n'));
    if (silent) {
      parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="disable_notification"\r\n\r\ntrue\r\n'));
    }
    photos.forEach((buf, i) => {
      parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="photo' + i + '"; filename="photo' + i + '.png"\r\nContent-Type: image/png\r\n\r\n'));
      parts.push(buf);
      parts.push(Buffer.from('\r\n'));
    });
    parts.push(Buffer.from('--' + boundary + '--\r\n'));
    const payload = Buffer.concat(parts);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: '/bot' + tgConfig.bot_token + '/sendMediaGroup',
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': payload.length },
      timeout: 20000
    }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(d);
          if (r.ok) { console.log('[heartbeat] Álbum OK'); resolve(r); }
          else { console.log('[heartbeat] Álbum error: ' + d.substring(0, 200)); reject(new Error(d)); }
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Enviar álbum con media descriptors personalizados (captions por foto)
function sendTelegramMediaGroupRaw(photos, media, silent) {
  if (!tgConfig.bot_token || !tgConfig.chat_id) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const boundary = '----FormBoundary' + Date.now().toString(36);
    let parts = [];
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n' + tgConfig.chat_id + '\r\n'));
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="media"\r\n\r\n' + JSON.stringify(media) + '\r\n'));
    if (silent) {
      parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="disable_notification"\r\n\r\ntrue\r\n'));
    }
    photos.forEach((buf, i) => {
      parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="photo' + i + '"; filename="photo' + i + '.png"\r\nContent-Type: image/png\r\n\r\n'));
      parts.push(buf);
      parts.push(Buffer.from('\r\n'));
    });
    parts.push(Buffer.from('--' + boundary + '--\r\n'));
    const payload = Buffer.concat(parts);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: '/bot' + tgConfig.bot_token + '/sendMediaGroup',
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': payload.length },
      timeout: 30000
    }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(d);
          if (r.ok) resolve(r);
          else { console.log('[heartbeat] MediaGroup error: ' + d.substring(0, 200)); reject(new Error(d)); }
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Validar que un buffer es un PNG real (magic bytes: 89 50 4E 47 0D 0A 1A 0A)
function isPngValid(buf) {
  if (!buf || buf.length < 8) return false;
  return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 &&
         buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A;
}

// --- Ciclo principal del heartbeat ---

async function sendHeartbeat() {
  try {
    console.log('[heartbeat] Generando heartbeat...');
    const data = collectDataFn ? collectDataFn() : {};
    console.log('[heartbeat] Sessions: active=' + (data.activeSessions || 0) + ' idle=' + (data.idleSessions || 0));
    const modeIcon = heartbeatMode === 'normal' ? '\ud83d\udc9a' : '\ud83d\udca4';
    const modeLabel = heartbeatMode === 'normal'
      ? ' (cada ' + heartbeatCurrentInterval + ' min)'
      : ' (cada ' + heartbeatCurrentInterval + ' min \u2014 sin actividad)';
    const horizon = readRoadmapHorizon();
    const horizonLine = horizon !== null ? '\n\ud83d\udcc5 Horizonte: ' + horizon + ' sprint' + (horizon !== 1 ? 's' : '') + ' planificado' + (horizon !== 1 ? 's' : '') : '';
    const sprintId = (data.sprintPlan && data.sprintPlan.sprint_id) || null;
    const sprintTema = (data.sprintPlan && data.sprintPlan.tema) || '';
    const sprintLine = sprintId ? '\n\ud83c\udfc3 <b>' + sprintId + '</b>: ' + sprintTema : '';
    const agentsLine = '\n\ud83e\udd16 ' + (data.activeSessions || 0) + ' agente(s) activo(s)' + (data.idleSessions > 0 ? ' \u00b7 ' + data.idleSessions + ' idle' : '');
    const caption = modeIcon + ' <b>Intrale Monitor \u2014 Heartbeat</b>' + modeLabel + '\n' +
      new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }) +
      sprintLine + agentsLine + horizonLine;

    if (takeScreenshotSectionsFn || takeScreenshotFn) {
      // 1. Intentar álbum por secciones del dashboard (9 imágenes max)
      if (takeScreenshotSectionsFn) {
        try {
          console.log('[heartbeat] Capturando secciones del dashboard...');
          const sections = await takeScreenshotSectionsFn(600);
          const validSections = sections.filter(s => s.image && Buffer.from(s.image, 'base64').length > 500);
          if (validSections.length > 0) {
            // Telegram permite max 10 fotos por álbum — enviar en lotes
            const sectionLabels = {
              kpis: '\ud83d\udcca <b>KPIs</b> — Agentes, permisos, CI/CD, acciones, alertas',
              ejecucion: '\ud83d\ude80 <b>Ejecuci\u00f3n & Agentes</b> — Estado del sprint activo',
              flujo: '\ud83d\udd00 <b>Flujo de Agentes</b> — Interacciones entre agentes',
              actividad: '\u26a1 <b>Actividad en Vivo</b> — \u00daltimas acciones de agentes',
              permisos: '\ud83d\udd10 <b>Permisos</b> — Solicitudes auto/aprobadas/rechazadas',
              'uso-agentes': '\ud83d\udcca <b>Uso de Agentes</b> — Invocaciones de skills',
              'metricas-agentes': '\ud83d\udcc8 <b>M\u00e9tricas de Agentes</b> — Sesiones y duraci\u00f3n',
              roadmap: '\ud83d\uddfa\ufe0f <b>Roadmap</b> — Planificaci\u00f3n de sprints',
              ci: '\u2699\ufe0f <b>CI/CD</b> — Estado de GitHub Actions'
            };
            const photos = validSections.map(s => Buffer.from(s.image, 'base64'));
            const captions = validSections.map((s, i) => i === 0 ? caption : (sectionLabels[s.id] || s.id));

            // Enviar en lotes de max 10
            for (let i = 0; i < photos.length; i += 10) {
              const batch = photos.slice(i, i + 10);
              const batchCaptions = captions.slice(i, i + 10);
              // sendMediaGroup con captions individuales
              const media = batch.map((_, j) => ({
                type: 'photo',
                media: 'attach://photo' + j,
                ...(batchCaptions[j] ? { caption: batchCaptions[j], parse_mode: 'HTML' } : {})
              }));
              await sendTelegramMediaGroupRaw(batch, media, true);
            }
            console.log('[heartbeat] ' + validSections.length + ' secciones enviadas: [' + validSections.map(s => s.id).join(', ') + ']');
            heartbeatSkipCount = 0;
            return;
          }
          console.log('[heartbeat] Secciones vacías — fallback a screenshot único');
        } catch (e) {
          console.log('[heartbeat] Secciones fallidas: ' + e.message + ' — fallback');
        }
      }

      // 2. Fallback: screenshot único
      if (takeScreenshotFn) {
        try {
          console.log('[heartbeat] Intentando screenshot único (600x800)...');
          const screenshot = await takeScreenshotFn(600, 800);
          if (screenshot && isPngValid(screenshot) && screenshot.length > 1000) {
            await sendTelegramDocument(screenshot, 'dashboard.png', caption, true);
            console.log('[heartbeat] Screenshot único enviado OK (' + screenshot.length + 'b)');
            heartbeatSkipCount = 0;
            return;
          }
        } catch (e) {
          console.log('[heartbeat] Screenshot único fallido: ' + e.message);
        }
      }
    }

    // Todos los intentos fallaron — omitir heartbeat este ciclo (NUNCA enviar texto ASCII)
    heartbeatSkipCount++;
    console.log('[heartbeat] Omitido — screenshot no disponible. Skips consecutivos: ' + heartbeatSkipCount);

    // Alertar si se supera el umbral de skips
    if (heartbeatSkipCount >= HEARTBEAT_SKIP_ALERT) {
      console.log('[heartbeat] Umbral de skips alcanzado — enviando alerta');
      sendTelegramText(
        '\u26a0\ufe0f <b>Heartbeat: sin screenshots</b>\n' +
        'El heartbeat fue omitido <b>' + heartbeatSkipCount + ' veces consecutivas</b>.\n' +
        'Puppeteer no pudo capturar el dashboard. Verifica que est\u00e9 instalado y que el puerto ' + portRef + ' responda.',
        false
      );
      heartbeatSkipCount = 0;
    }
  } catch (e) {
    console.log('[heartbeat] Error inesperado: ' + e.message);
  }
}

async function adaptiveHeartbeatLoop() {
  // Detectar actividad leyendo sesiones directamente (.claude/sessions/*.json)
  const active = hasActiveSessions();

  // Actualizar modo y contador
  if (active) {
    heartbeatConsecutiveIdle = 0;
    heartbeatMode = 'normal';
    heartbeatCurrentInterval = reportIntervalMin;
  } else {
    heartbeatConsecutiveIdle++;
    heartbeatMode = 'idle';
    heartbeatCurrentInterval = Math.min(reportIntervalMin + (heartbeatConsecutiveIdle * INTERVAL_STEP_MIN), MAX_INTERVAL_MIN);
  }

  console.log('[heartbeat] Adaptativo: modo=' + heartbeatMode + ' intervalo=' + heartbeatCurrentInterval + 'min consecutiveIdle=' + heartbeatConsecutiveIdle);

  // Enviar heartbeat
  await sendHeartbeat();

  // Persistir estado para sobrevivir reinicios
  saveHeartbeatState();

  // Programar próximo ciclo con setTimeout dinámico
  heartbeatTimer = setTimeout(adaptiveHeartbeatLoop, heartbeatCurrentInterval * 60 * 1000);
}

// --- API pública ---

/**
 * Inicia el heartbeat adaptativo.
 * @param {Object} opts
 * @param {Function} opts.collectDataFn    - Función que retorna datos del dashboard (activeSessions, idleSessions, etc.)
 * @param {Function} opts.takeScreenshotFn - Función async(w, h, opts?) que retorna Buffer PNG o [Buffer, Buffer] si split:true
 * @param {Object}   [opts.telegramConfig] - Config de Telegram (override de telegram-config.json)
 * @param {string}   [opts.sessionsDir]    - Directorio de sesiones (override del default)
 * @param {number}   [opts.reportIntervalMin] - Intervalo base en minutos (override de task_report_interval_min)
 * @param {number}   [opts.port]           - Puerto del dashboard (para mensajes de alerta)
 */
function startHeartbeat(opts) {
  opts = opts || {};

  // Resolver configuración de Telegram
  if (opts.telegramConfig) {
    tgConfig = opts.telegramConfig;
  } else {
    try {
      tgConfig = JSON.parse(fs.readFileSync(TG_CONFIG_FILE, 'utf8'));
    } catch {
      tgConfig = { bot_token: '', chat_id: '', task_report_interval_min: 10 };
    }
  }

  reportIntervalMin = opts.reportIntervalMin || parseInt(tgConfig.task_report_interval_min, 10) || 10;
  sessionsDir = opts.sessionsDir || DEFAULT_SESSIONS_DIR;
  portRef = opts.port || 3100;
  collectDataFn = opts.collectDataFn || null;
  takeScreenshotFn = opts.takeScreenshotFn || null;
  takeScreenshotSectionsFn = opts.takeScreenshotSectionsFn || null;

  if (!tgConfig.bot_token || reportIntervalMin <= 0) {
    console.log('[heartbeat] Desactivado (bot_token=' + !!tgConfig.bot_token + ' interval=' + reportIntervalMin + ')');
    return;
  }

  // Cargar estado persistido al arrancar (sobrevive reinicios)
  const persistedState = loadHeartbeatState();
  if (persistedState) {
    heartbeatConsecutiveIdle = persistedState.consecutiveIdle || 0;
    heartbeatCurrentInterval = persistedState.currentInterval || reportIntervalMin;
    heartbeatMode = persistedState.mode || 'normal';
  } else {
    heartbeatCurrentInterval = reportIntervalMin;
  }

  console.log('[heartbeat] Iniciado (base=' + reportIntervalMin + 'min, modo=' + heartbeatMode + ')');

  // Primer heartbeat después de 5 segundos
  heartbeatTimer = setTimeout(adaptiveHeartbeatLoop, 5000);
}

/**
 * Detiene el heartbeat adaptativo cancelando el timer pendiente.
 */
function stopHeartbeat() {
  if (heartbeatTimer) {
    clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
    console.log('[heartbeat] Detenido');
  }
}

/**
 * Retorna el estado actual del heartbeat (modo, intervalo, idle count, skips).
 * @returns {{ mode: string, currentInterval: number, consecutiveIdle: number, skipCount: number }}
 */
function getHeartbeatState() {
  return {
    mode: heartbeatMode,
    currentInterval: heartbeatCurrentInterval,
    consecutiveIdle: heartbeatConsecutiveIdle,
    skipCount: heartbeatSkipCount
  };
}

module.exports = { startHeartbeat, stopHeartbeat, getHeartbeatState };

#!/usr/bin/env node
// =============================================================================
// Servicio Drive — Fire-and-forget: upload de archivos a Google Drive
// Procesa cola de servicios/drive/pendiente/
// Delega el upload real a qa/scripts/qa-video-share.js (OAuth + Drive REST API)
// =============================================================================

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
// #2334: sanitización write-time.
require('./lib/sanitize-console').install();
const { sanitize } = require('./sanitizer');
const { sanitizeDrivePayload, sanitizeDriveFilename, filenameHasSecret } = require('./lib/sanitize-payload');

const PIPELINE = process.env.PIPELINE_STATE_DIR || path.resolve(__dirname);
const PROJECT_ROOT = path.resolve(PIPELINE, '..');
const QUEUE_DIR = path.join(PIPELINE, 'servicios', 'drive');
const PENDIENTE = path.join(QUEUE_DIR, 'pendiente');
const TRABAJANDO = path.join(QUEUE_DIR, 'trabajando');
const LISTO = path.join(QUEUE_DIR, 'listo');
const FALLIDO = path.join(QUEUE_DIR, 'fallido');
const QA_VIDEO_SHARE = path.join(PROJECT_ROOT, 'qa', 'scripts', 'qa-video-share.js');

// Máximo reintentos antes de mover a fallido
const MAX_RETRIES = 2;

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [svc-drive] ${msg}`);
}

function listWorkFiles(dir) {
  try {
    return fs.readdirSync(dir)
      .filter(f => !f.startsWith('.') && f.endsWith('.json'))
      .map(f => ({ name: f, path: path.join(dir, f) }));
  } catch { return []; }
}

// Extraer número de issue desde description o filename
// Ej: "QA video con relato narrado #2015" → "2015"
// Ej: "qa-2015-video.json" → "2015"
function extractIssue(data, filename) {
  // Desde description: buscar #NNNN
  if (data.description) {
    const match = data.description.match(/#(\d+)/);
    if (match) return match[1];
  }
  // Desde folder: "QA/evidence/2015" → "2015"
  if (data.folder) {
    const parts = data.folder.split('/');
    const last = parts[parts.length - 1];
    if (/^\d+$/.test(last)) return last;
  }
  // Desde filename: "qa-2015-video.json" → "2015"
  const fMatch = filename.match(/qa-(\d+)/);
  if (fMatch) return fMatch[1];
  return '0';
}

// Extraer título del issue desde description (después del " - " o " — ")
function extractTitle(data) {
  if (!data.description) return '';
  const match = data.description.match(/(?:#\d+)\s*[-—]\s*(.+)/);
  return match ? match[1].trim() : '';
}

// Resolver la ruta del video: buscar en múltiples ubicaciones posibles
function resolveVideoPath(filePath) {
  // Intentar como ruta relativa al proyecto
  const fromProject = path.resolve(PROJECT_ROOT, filePath);
  if (fs.existsSync(fromProject)) return fromProject;

  // Intentar como ruta absoluta
  if (path.isAbsolute(filePath) && fs.existsSync(filePath)) return filePath;

  // Buscar en qa/evidence/{issue}/ por videos con extensión mp4
  const issueMatch = filePath.match(/qa-(\d+)/);
  if (issueMatch) {
    const issueDir = path.join(PROJECT_ROOT, 'qa', 'evidence', issueMatch[1]);
    if (fs.existsSync(issueDir)) {
      const mp4s = fs.readdirSync(issueDir).filter(f => f.endsWith('.mp4'));
      if (mp4s.length > 0) {
        // Preferir narrated, luego el más reciente
        const narrated = mp4s.find(f => f.includes('narrat'));
        return path.join(issueDir, narrated || mp4s[mp4s.length - 1]);
      }
    }
  }

  // Buscar en qa/recordings/
  const recordingsDir = path.join(PROJECT_ROOT, 'qa', 'recordings');
  if (fs.existsSync(recordingsDir)) {
    const basename = path.basename(filePath);
    const inRecordings = path.join(recordingsDir, basename);
    if (fs.existsSync(inRecordings)) return inRecordings;
  }

  return null;
}

// Ejecutar qa-video-share.js como child process
function runVideoShare(videoPath, issue, title) {
  return new Promise((resolve, reject) => {
    const args = [
      QA_VIDEO_SHARE,
      '--issue', issue,
      '--videos', videoPath,
      '--verdict', 'EVIDENCIA',
      '--passed', '0',
      '--total', '0',
    ];
    if (title) {
      args.push('--title', title);
    }

    log(`Ejecutando: node ${args.join(' ')}`);

    execFile(process.execPath, args, {
      cwd: PROJECT_ROOT,
      timeout: 600000, // 10 min
      env: { ...process.env },
    }, (err, stdout, stderr) => {
      if (stdout) log(`[qa-video-share stdout] ${stdout.trim()}`);
      if (stderr) log(`[qa-video-share stderr] ${stderr.trim()}`);
      if (err) {
        reject(new Error(`qa-video-share exit ${err.code || err.signal}: ${stderr || err.message}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

// Procesar un job individual
async function processJob(file) {
  const trabajandoPath = path.join(TRABAJANDO, file.name);
  try { fs.renameSync(file.path, trabajandoPath); } catch { return; }

  try {
    const rawData = JSON.parse(fs.readFileSync(trabajandoPath, 'utf8'));
    // #2334: sanitizar description/title/caption ANTES del upload.
    // Esos campos van como CLI args a qa-video-share.js y terminan en
    // metadata de Drive + mensajes de Telegram.
    const data = sanitizeDrivePayload(rawData);
    const issue = extractIssue(data, file.name);
    const title = extractTitle(data);
    const videoFile = data.file || '';

    if (!videoFile) {
      log(`Job ${file.name}: sin campo 'file', moviendo a listo`);
      fs.renameSync(trabajandoPath, path.join(LISTO, file.name));
      return;
    }

    const resolvedPath = resolveVideoPath(videoFile);
    if (!resolvedPath) {
      log(`Job ${file.name}: video no encontrado en ninguna ruta: ${videoFile}`);
      // Mover a fallido para no reintentar indefinidamente
      ensureDir(FALLIDO);
      fs.renameSync(trabajandoPath, path.join(FALLIDO, file.name));
      return;
    }

    // #2334 CA7: validar que el basename NO contenga patrones de secretos
    // (tokens, JWT, etc). Si matchea, copiamos a un path con nombre
    // truncado + hash (no placeholder, que rompería la trazabilidad). El
    // contenido del video NO se toca — es binario y el sanitizer sólo
    // opera sobre texto.
    let uploadPath = resolvedPath;
    const originalBasename = path.basename(resolvedPath);
    if (filenameHasSecret(originalBasename)) {
      const safeBasename = sanitizeDriveFilename(originalBasename);
      const safeDir = path.join(path.dirname(resolvedPath), '.sanitized');
      try {
        fs.mkdirSync(safeDir, { recursive: true });
      } catch {}
      const safePath = path.join(safeDir, safeBasename);
      try {
        fs.copyFileSync(resolvedPath, safePath);
        uploadPath = safePath;
        log(`Filename sanitizado: basename original contenía patrón de secreto, subiendo como ${safeBasename}`);
      } catch (e) {
        log(`Error copiando a nombre saneado (${e.message}); se omite upload para evitar leak`);
        ensureDir(FALLIDO);
        fs.renameSync(trabajandoPath, path.join(FALLIDO, file.name));
        return;
      }
    }

    log(`Subiendo video: ${uploadPath} (issue #${issue})`);

    // Reintentar hasta MAX_RETRIES veces
    let lastErr;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await runVideoShare(uploadPath, issue, title);
        log(`Upload exitoso: ${file.name} (intento ${attempt})`);
        fs.renameSync(trabajandoPath, path.join(LISTO, file.name));
        return;
      } catch (e) {
        lastErr = e;
        log(`Intento ${attempt}/${MAX_RETRIES} falló: ${e.message}`);
        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, 3000));
        }
      }
    }

    // Todos los intentos fallaron
    log(`Upload fallido después de ${MAX_RETRIES} intentos: ${file.name}`);
    ensureDir(FALLIDO);
    // Agregar info de error al job
    try {
      const jobData = JSON.parse(fs.readFileSync(trabajandoPath, 'utf8'));
      jobData._error = lastErr.message;
      jobData._failedAt = new Date().toISOString();
      fs.writeFileSync(trabajandoPath, JSON.stringify(jobData, null, 2));
    } catch {}
    fs.renameSync(trabajandoPath, path.join(FALLIDO, file.name));

  } catch (e) {
    log(`Error procesando ${file.name}: ${e.message}`);
    try { fs.renameSync(trabajandoPath, file.path); } catch {}
  }
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Cola global para serializar uploads (evitar saturar OAuth)
let processing = false;

async function processQueue() {
  if (processing) return;
  processing = true;
  try {
    const files = listWorkFiles(PENDIENTE);
    if (files.length === 0) return;

    log(`${files.length} job(s) en cola`);
    for (const file of files) {
      await processJob(file);
    }
  } finally {
    processing = false;
  }
}

function main() {
  log('Servicio Drive iniciado (upload real via qa-video-share.js)');

  // Verificar que qa-video-share.js existe
  if (!fs.existsSync(QA_VIDEO_SHARE)) {
    log(`ERROR: qa-video-share.js no encontrado en ${QA_VIDEO_SHARE}`);
    process.exit(1);
  }

  // Heartbeat mantiene el marker fresh (issue #2450).
  try { require('./lib/ready-marker').startHeartbeat('svc-drive'); } catch {}
  setInterval(() => {
    processQueue().catch(e => log(`Error en processQueue: ${e.message}`));
  }, 10000);
}

fs.writeFileSync(path.join(PIPELINE, 'svc-drive.pid'), String(process.pid));
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

// Crash handlers — loguear antes de morir para diagnóstico
const LOG_DIR = path.join(PIPELINE, 'logs');
process.on('uncaughtException', (err) => {
  // #2334: sanitizar antes de persistir stack a disco.
  const msg = sanitize(`[${new Date().toISOString()}] [svc-drive] CRASH uncaughtException: ${err.stack || err.message}\n`);
  try { fs.appendFileSync(path.join(LOG_DIR, 'svc-drive.log'), msg); } catch {}
  console.error(msg);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  const msg = sanitize(`[${new Date().toISOString()}] [svc-drive] CRASH unhandledRejection: ${reason?.stack || reason}\n`);
  try { fs.appendFileSync(path.join(LOG_DIR, 'svc-drive.log'), msg); } catch {}
  console.error(msg);
  process.exit(1);
});

main();

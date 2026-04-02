#!/usr/bin/env node
// =============================================================================
// Servicio Drive — Fire-and-forget: upload de archivos
// Procesa cola de servicios/drive/pendiente/
// Placeholder: por ahora solo loguea. Se implementa cuando se configure Google Drive API.
// =============================================================================

const fs = require('fs');
const path = require('path');

const PIPELINE = process.env.PIPELINE_STATE_DIR || path.resolve(__dirname);
const QUEUE_DIR = path.join(PIPELINE, 'servicios', 'drive');
const PENDIENTE = path.join(QUEUE_DIR, 'pendiente');
const TRABAJANDO = path.join(QUEUE_DIR, 'trabajando');
const LISTO = path.join(QUEUE_DIR, 'listo');

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

function processQueue() {
  const files = listWorkFiles(PENDIENTE);
  if (files.length === 0) return;

  for (const file of files) {
    const trabajandoPath = path.join(TRABAJANDO, file.name);
    try { fs.renameSync(file.path, trabajandoPath); } catch { continue; }

    try {
      const data = JSON.parse(fs.readFileSync(trabajandoPath, 'utf8'));
      // TODO: implementar upload real a Google Drive
      log(`[STUB] Upload pendiente: ${data.file || data.description || file.name}`);
      fs.renameSync(trabajandoPath, path.join(LISTO, file.name));
    } catch (e) {
      log(`Error: ${e.message}`);
      try { fs.renameSync(trabajandoPath, file.path); } catch {}
    }
  }
}

function main() {
  log('Servicio Drive iniciado (stub)');
  setInterval(() => {
    try { processQueue(); } catch (e) { log(`Error: ${e.message}`); }
  }, 10000);
}

fs.writeFileSync(path.join(PIPELINE, 'svc-drive.pid'), String(process.pid));
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
main();

#!/usr/bin/env node
// =============================================================================
// Servicio GitHub — Fire-and-forget: comentarios, labels, ETAs
// Procesa cola de servicios/github/pendiente/
// =============================================================================

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const GH_BIN = 'C:\\Workspaces\\gh-cli\\bin\\gh.exe';
const PIPELINE = path.resolve(__dirname);
const QUEUE_DIR = path.join(PIPELINE, 'servicios', 'github');
const PENDIENTE = path.join(QUEUE_DIR, 'pendiente');
const TRABAJANDO = path.join(QUEUE_DIR, 'trabajando');
const LISTO = path.join(QUEUE_DIR, 'listo');

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [svc-github] ${msg}`);
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

      switch (data.action) {
        case 'comment':
          execSync(`"${GH_BIN}" issue comment ${data.issue} -b "${data.body.replace(/"/g, '\\"')}"`, {
            cwd: ROOT, encoding: 'utf8', timeout: 15000
          });
          log(`Comentario en #${data.issue}`);
          break;

        case 'label':
          execSync(`"${GH_BIN}" issue edit ${data.issue} --add-label "${data.label}"`, {
            cwd: ROOT, encoding: 'utf8', timeout: 15000
          });
          log(`Label "${data.label}" → #${data.issue}`);
          break;

        case 'remove-label':
          execSync(`"${GH_BIN}" issue edit ${data.issue} --remove-label "${data.label}"`, {
            cwd: ROOT, encoding: 'utf8', timeout: 15000
          });
          log(`Label "${data.label}" removido de #${data.issue}`);
          break;

        default:
          log(`Acción desconocida: ${data.action}`);
      }

      fs.renameSync(trabajandoPath, path.join(LISTO, file.name));
    } catch (e) {
      log(`Error procesando ${file.name}: ${e.message}`);
      try { fs.renameSync(trabajandoPath, file.path); } catch {}
    }
  }
}

// Main loop
function main() {
  log('Servicio GitHub iniciado');
  setInterval(() => {
    try { processQueue(); } catch (e) { log(`Error: ${e.message}`); }
  }, 10000); // Poll cada 10 seg
}

fs.writeFileSync(path.join(PIPELINE, 'svc-github.pid'), String(process.pid));
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
main();

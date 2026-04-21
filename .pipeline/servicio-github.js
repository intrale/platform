#!/usr/bin/env node
// =============================================================================
// Servicio GitHub — Cola con retry, create-issue y condensador generico
// Procesa cola de servicios/github/pendiente/
// =============================================================================

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
// #2334: sanitización write-time.
require('./lib/sanitize-console').install();
// Saneado global de JAVA_HOME — este servicio spawnea agentes Claude que
// pueden invocar gradle; hereda y propaga el valor a sus hijos.
require('./lib/java-home-normalizer').normalizeJavaHome({
  log: (msg) => console.error(msg),
});
const { sanitize } = require('./sanitizer');
const { sanitizeGithubPayload } = require('./lib/sanitize-payload');

const ROOT = process.env.PIPELINE_MAIN_ROOT || path.resolve(__dirname, '..');
const GH_BIN = 'C:\\Workspaces\\gh-cli\\bin\\gh.exe';
const PIPELINE = process.env.PIPELINE_STATE_DIR || path.resolve(__dirname);
const QUEUE_DIR = path.join(PIPELINE, 'servicios', 'github');
const PENDIENTE = path.join(QUEUE_DIR, 'pendiente');
const TRABAJANDO = path.join(QUEUE_DIR, 'trabajando');
const LISTO = path.join(QUEUE_DIR, 'listo');
const FALLIDO = path.join(QUEUE_DIR, 'fallido');
const MAX_RETRIES = 3;
const LOG_DIR = path.join(PIPELINE, 'logs');

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

// --- Escape para shell ---
function esc(str) {
  return (str || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '');
}

// --- Recovery: mover orphans de trabajando/ a pendiente/ al arrancar ---
function recoverOrphans() {
  const orphans = listWorkFiles(TRABAJANDO);
  for (const file of orphans) {
    try {
      fs.renameSync(file.path, path.join(PENDIENTE, file.name));
      log(`Recuperado orphan: ${file.name}`);
    } catch {}
  }
}

// --- Condensador: disparar onComplete cuando un grupo se completa ---
function checkCondenser(data) {
  if (!data.group || !data.groupSize) return;

  const group = data.group;
  const expected = data.groupSize;

  // Contar items del grupo en listo/ y fallido/
  let completed = 0;
  for (const dir of [LISTO, FALLIDO]) {
    for (const f of listWorkFiles(dir)) {
      try {
        const item = JSON.parse(fs.readFileSync(f.path, 'utf8'));
        if (item.group === group) completed++;
      } catch {}
    }
  }

  log(`Condenser: grupo "${group}" — ${completed}/${expected}`);
  if (completed < expected) return;

  // Proteccion anti-duplicado: flag atomico
  const firedMarker = path.join(QUEUE_DIR, `condenser-fired-${group}.json`);
  try {
    fs.writeFileSync(firedMarker, JSON.stringify({ group, ts: Date.now() }), { flag: 'wx' });
  } catch {
    // Otro thread ya disparo el onComplete
    log(`Condenser: grupo "${group}" ya fue disparado`);
    return;
  }

  // Recolectar todos los resultados del grupo
  const results = [];
  for (const dir of [LISTO, FALLIDO]) {
    const dirName = path.basename(dir);
    for (const f of listWorkFiles(dir)) {
      try {
        const item = JSON.parse(fs.readFileSync(f.path, 'utf8'));
        if (item.group === group) {
          results.push({ ...item, _status: dirName === 'fallido' ? 'failed' : 'completed', _file: f.name });
        }
      } catch {}
    }
  }

  // Buscar onComplete en cualquier item del grupo
  const onComplete = data.onComplete;
  if (!onComplete || !onComplete.command) {
    log(`Condenser: grupo "${group}" completado sin onComplete`);
    return;
  }

  // Escribir results JSON
  const resultsPath = path.join(QUEUE_DIR, `condenser-results-${group}.json`);
  fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));

  fireOnComplete(onComplete.command, resultsPath, group);
}

// --- Ejecutar onComplete como proceso hijo ---
function fireOnComplete(command, resultsPath, group) {
  log(`Condenser: grupo "${group}" completado — firing: ${command} --results ${resultsPath}`);

  try {
    // Parsear el command respetando comillas (extraer args correctamente)
    const args = parseCommandArgs(command);
    args.push('--results', resultsPath);
    const child = spawn(process.execPath, args, {
      cwd: ROOT, stdio: 'ignore', detached: true, windowsHide: true
    });
    child.unref();
  } catch (e) {
    log(`Condenser: error firing onComplete: ${e.message}`);
    // Marker para retry al reiniciar
    const retryPath = path.join(QUEUE_DIR, `condenser-retry-${group}.json`);
    fs.writeFileSync(retryPath, JSON.stringify({ group, command, resultsPath, error: e.message, ts: Date.now() }));
  }
}

// --- Parsear args de un comando respetando comillas ---
function parseCommandArgs(command) {
  // Quitar "node " del inicio si lo tiene
  const cmd = command.replace(/^node\s+/, '');
  const args = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';
  for (const ch of cmd) {
    if (inQuote) {
      if (ch === quoteChar) { inQuote = false; }
      else { current += ch; }
    } else if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
    } else if (ch === ' ') {
      if (current) { args.push(current); current = ''; }
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);
  return args;
}

// --- Retry de onComplete fallidos al arrancar ---
function retryFailedOnCompletes() {
  const retryFiles = listWorkFiles(QUEUE_DIR).filter(f => f.name.startsWith('condenser-retry-'));
  for (const file of retryFiles) {
    try {
      const data = JSON.parse(fs.readFileSync(file.path, 'utf8'));
      log(`Reintentando onComplete: ${data.command}`);
      const args = parseCommandArgs(data.command);
      if (data.resultsPath) args.push('--results', data.resultsPath);
      const child = spawn(process.execPath, args, {
        cwd: ROOT, stdio: 'ignore', detached: true, windowsHide: true
      });
      child.unref();
      fs.unlinkSync(file.path);
      log(`onComplete reintentado OK, marker eliminado`);
    } catch (e) {
      log(`Error reintentando onComplete ${file.name}: ${e.message}`);
    }
  }
}

// --- Cache de labels existentes (se refresca cada 10 min) ---
let labelCache = new Set();
let labelCacheTs = 0;
const LABEL_CACHE_TTL = 10 * 60 * 1000;

function refreshLabelCache() {
  if (Date.now() - labelCacheTs < LABEL_CACHE_TTL && labelCache.size > 0) return;
  try {
    const raw = execSync(`"${GH_BIN}" label list --json name --limit 200 --repo intrale/platform`, {
      cwd: ROOT, encoding: 'utf8', timeout: 15000, windowsHide: true
    });
    const labels = JSON.parse(raw || '[]');
    labelCache = new Set(labels.map(l => l.name));
    labelCacheTs = Date.now();
    log(`Label cache refrescado: ${labelCache.size} labels`);
  } catch (e) {
    log(`Error refrescando label cache: ${e.message}`);
  }
}

const LABEL_COLORS = {
  'qa:dependency': 'D93F0B',
  'blocked:dependencies': 'B60205',
  'needs-definition': 'ededed',
  'needs-human': 'B60205',   // #2405 CA-4 — circuit breaker infra escalado a humano
};

function ensureLabels(labelsStr) {
  if (!labelsStr) return;
  refreshLabelCache();
  const names = labelsStr.split(',').map(s => s.trim()).filter(Boolean);
  for (const name of names) {
    if (labelCache.has(name)) continue;
    const color = LABEL_COLORS[name] || 'ededed';
    try {
      execSync(`"${GH_BIN}" label create "${esc(name)}" --color "${color}" --repo intrale/platform`, {
        cwd: ROOT, encoding: 'utf8', timeout: 10000, windowsHide: true
      });
      labelCache.add(name);
      log(`Label "${name}" creado automáticamente`);
    } catch (e) {
      if (e.message && e.message.includes('already exists')) {
        labelCache.add(name);
      } else {
        log(`Error creando label "${name}": ${e.message}`);
      }
    }
  }
}

// --- Procesamiento de cola ---
function processQueue() {
  const files = listWorkFiles(PENDIENTE);
  if (files.length === 0) return;

  for (const file of files) {
    const trabajandoPath = path.join(TRABAJANDO, file.name);
    try { fs.renameSync(file.path, trabajandoPath); } catch { continue; }

    let data;
    try {
      const rawData = JSON.parse(fs.readFileSync(trabajandoPath, 'utf8'));
      // #2334: sanitizar body/title/label ANTES del execSync a `gh`.
      // El body viaja a la API pública de GitHub, visible por cualquiera.
      data = sanitizeGithubPayload(rawData);

      switch (data.action) {
        case 'comment':
          execSync(`"${GH_BIN}" issue comment ${data.issue} -b "${esc(data.body)}"`, {
            cwd: ROOT, encoding: 'utf8', timeout: 15000, windowsHide: true
          });
          log(`Comentario en #${data.issue}`);
          break;

        case 'label':
          ensureLabels(data.label);
          execSync(`"${GH_BIN}" issue edit ${data.issue} --add-label "${esc(data.label)}"`, {
            cwd: ROOT, encoding: 'utf8', timeout: 15000, windowsHide: true
          });
          log(`Label "${data.label}" → #${data.issue}`);
          break;

        case 'remove-label':
          execSync(`"${GH_BIN}" issue edit ${data.issue} --remove-label "${esc(data.label)}"`, {
            cwd: ROOT, encoding: 'utf8', timeout: 15000, windowsHide: true
          });
          log(`Label "${data.label}" removido de #${data.issue}`);
          break;

        case 'create-issue': {
          ensureLabels(data.labels);
          const output = execSync(
            `"${GH_BIN}" issue create --title "${esc(data.title)}" --body "${esc(data.body)}" --label "${esc(data.labels)}" --repo ${data.repo || 'intrale/platform'}`,
            { cwd: ROOT, encoding: 'utf8', timeout: 20000, windowsHide: true }
          ).trim();
          const urlMatch = output.match(/\/(\d+)\s*$/);
          data.result = { number: urlMatch ? parseInt(urlMatch[1]) : null, url: output };
          log(`Issue creado: #${data.result.number} — ${data.title}`);
          break;
        }

        default:
          log(`Acción desconocida: ${data.action}`);
      }

      // Escribir JSON enriquecido (puede tener result) y mover a listo
      fs.writeFileSync(path.join(LISTO, file.name), JSON.stringify(data, null, 2));
      try { fs.unlinkSync(trabajandoPath); } catch {}
      checkCondenser(data);

    } catch (e) {
      log(`Error procesando ${file.name}: ${e.message}`);
      try {
        const itemData = data || JSON.parse(fs.readFileSync(trabajandoPath, 'utf8'));
        itemData.retries = (itemData.retries || 0) + 1;
        itemData.lastError = e.message;

        if (itemData.retries >= MAX_RETRIES) {
          fs.writeFileSync(path.join(FALLIDO, file.name), JSON.stringify(itemData, null, 2));
          try { fs.unlinkSync(trabajandoPath); } catch {}
          log(`${file.name} → fallido/ (${itemData.retries} reintentos agotados)`);
          checkCondenser(itemData);
        } else {
          fs.writeFileSync(path.join(PENDIENTE, file.name), JSON.stringify(itemData, null, 2));
          try { fs.unlinkSync(trabajandoPath); } catch {}
          log(`${file.name} → pendiente/ (reintento ${itemData.retries}/${MAX_RETRIES})`);
        }
      } catch {
        // Fallback: mover de vuelta como estaba
        try { fs.renameSync(trabajandoPath, file.path); } catch {}
      }
    }
  }
}

// --- Main ---
function main() {
  // Asegurar directorios
  for (const dir of [PENDIENTE, TRABAJANDO, LISTO, FALLIDO]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  recoverOrphans();
  retryFailedOnCompletes();

  log('Servicio GitHub iniciado');
  try { require('./lib/ready-marker').signalReady('svc-github'); } catch {}
  setInterval(() => {
    try { processQueue(); } catch (e) { log(`Error: ${e.message}`); }
  }, 10000);
}

fs.writeFileSync(path.join(PIPELINE, 'svc-github.pid'), String(process.pid));
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

// Crash handlers
process.on('uncaughtException', (err) => {
  // #2334: sanitizar antes de persistir stack a disco.
  const msg = sanitize(`[${new Date().toISOString()}] [svc-github] CRASH uncaughtException: ${err.stack || err.message}\n`);
  try { fs.appendFileSync(path.join(LOG_DIR, 'svc-github.log'), msg); } catch {}
  console.error(msg);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  const msg = sanitize(`[${new Date().toISOString()}] [svc-github] CRASH unhandledRejection: ${reason?.stack || reason}\n`);
  try { fs.appendFileSync(path.join(LOG_DIR, 'svc-github.log'), msg); } catch {}
  console.error(msg);
  process.exit(1);
});

main();

#!/usr/bin/env node
// rollback.js — Rollback del pipeline V2 (Node puro, detached-safe)
//
// Reemplazo de rollback.sh. Los problemas del script bash anterior:
//   - taskkill //T (tree-kill) se comía al parent restart.js si no lo
//     salteaba con PARENT_RESTART_PID → el rollback moría mid-ejecución.
//   - Bash + wmic + quoting frágil → misma cadena que el smoke-test
//     rompió 4 veces.
//
// Este script corre COMO ORPHAN: cuando restart.js detecta que el smoke
// falló, lanza rollback.js con { detached: true, stdio: 'ignore' } y
// unref + process.exit(0). Así el rollback queda corriendo por su
// cuenta y es libre de matar a TODO proceso del pipeline incluyendo
// al restart.js original (que ya murió) sin matarse a sí mismo.
//
// Flujo:
//   1. Matar todos los node.exe del pipeline (saltando self).
//   2. git fetch origin pipeline-stable + checkout solo de .pipeline/.
//   3. Relanzar: node restart.js --no-smoke-test --no-rollback.
//   4. Notificar resultado por Telegram (via outbox).
//
// Uso:
//   node .pipeline/rollback.js              → rollback a pipeline-stable
//   node .pipeline/rollback.js <sha|tag>    → rollback a commit/tag puntual

const { execSync, spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { scanNodeProcesses, invalidateCache } = require('./pid-discovery');

const PIPELINE_DIR = __dirname;
const ROOT = path.resolve(PIPELINE_DIR, '..');
const LOG_FILE = path.join(PIPELINE_DIR, 'logs', 'rollback.log');
const TARGET = process.argv[2] || 'pipeline-stable';

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const line = `[${ts}] ${msg}`;
  try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); } catch {}
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
  console.log(line);
}

function fail(msg, code = 1) {
  log(`FAIL: ${msg}`);
  enqueueTelegramAlert(`❌ *Rollback FALLÓ.* Intervención manual requerida.\n\`\`\`\nnode .pipeline/rollback.js\n\`\`\`\n${msg}`);
  process.exit(code);
}

function enqueueTelegramAlert(text) {
  const msg = text.length > 4000 ? text.slice(0, 4000) + '...' : text;
  const svcDir = path.join(PIPELINE_DIR, 'servicios', 'telegram', 'pendiente');
  try {
    if (!fs.existsSync(svcDir)) fs.mkdirSync(svcDir, { recursive: true });
    const filename = `${Date.now()}-rollback-alert.json`;
    fs.writeFileSync(path.join(svcDir, filename), JSON.stringify({ text: msg, parse_mode: 'Markdown' }));
  } catch (e) {
    log(`No se pudo encolar alerta Telegram: ${e.message}`);
  }
}

function sleep(ms) {
  spawnSync(process.execPath, ['-e', `setTimeout(()=>{},${ms})`], { timeout: ms + 2000 });
}

// --- 1) Matar todo proceso del pipeline, salteando self ---

function killPipelineProcesses() {
  log(`=== ROLLBACK a ${TARGET} ===`);
  log(`1) Matando procesos del pipeline (self=${process.pid})...`);

  invalidateCache();
  let killed = 0;
  for (const p of scanNodeProcesses()) {
    if (!p.commandLine || !p.commandLine.includes('.pipeline')) continue;
    if (p.pid === process.pid) continue;
    try {
      execSync(`taskkill /PID ${p.pid} /F /T`, { timeout: 5000, stdio: 'ignore' });
      log(`  Killed PID ${p.pid}`);
      killed++;
    } catch {}
  }
  if (killed === 0) log('  No había procesos del pipeline corriendo');

  // Limpiar PID files.
  try {
    for (const f of fs.readdirSync(PIPELINE_DIR)) {
      if (f.endsWith('.pid')) { try { fs.unlinkSync(path.join(PIPELINE_DIR, f)); } catch {} }
    }
  } catch {}

  sleep(2000);
}

// --- 2) Verificar target + checkout quirúrgico ---

function resetPipelineDir() {
  log(`2) Verificando target ${TARGET}...`);

  // Si el target no existe localmente, intentar fetch.
  try {
    execSync(`git rev-parse --verify ${TARGET}`, { cwd: ROOT, timeout: 5000, stdio: 'ignore' });
  } catch {
    log('  Target local no existe, haciendo fetch...');
    let fetched = false;
    for (const ref of [`refs/tags/${TARGET}:refs/tags/${TARGET}`, TARGET]) {
      try {
        execSync(`git fetch origin ${ref}`, { cwd: ROOT, timeout: 30000, stdio: 'ignore' });
        fetched = true;
        break;
      } catch {}
    }
    if (!fetched) fail(`No se pudo fetch ${TARGET}`, 2);
  }

  let sha = '';
  try {
    sha = execSync(`git rev-parse ${TARGET}`, { cwd: ROOT, encoding: 'utf8', timeout: 5000 }).trim();
    log(`  Target SHA: ${sha}`);
  } catch (e) {
    fail(`No se pudo resolver SHA de ${TARGET}: ${e.message}`, 2);
  }

  log(`3) Revirtiendo .pipeline/ al target...`);
  try {
    execSync(`git checkout ${TARGET} -- .pipeline/`, { cwd: ROOT, timeout: 30000 });
  } catch (e) {
    fail(`git checkout falló: ${e.message}`, 3);
  }

  return sha;
}

// --- 3) Relanzar pipeline (sin smoke + sin rollback recursivo) ---

function relaunchPipeline() {
  log(`4) Relanzando pipeline...`);
  const restartScript = path.join(PIPELINE_DIR, 'restart.js');
  const result = spawnSync(process.execPath, [restartScript, '--no-smoke-test', '--no-rollback'], {
    cwd: ROOT,
    timeout: 120000,
    encoding: 'utf8',
    windowsHide: true,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  if (output) log(output.split('\n').slice(-12).join('\n'));
  if (result.status !== 0) fail(`restart.js retornó ${result.status}`, 4);
}

// --- Main ---

(function main() {
  killPipelineProcesses();
  const sha = resetPipelineDir();
  relaunchPipeline();
  log('=== ROLLBACK COMPLETADO ===');
  log(`Pipeline restaurado a ${TARGET} (${sha.slice(0, 8)})`);
  enqueueTelegramAlert(`✅ *Rollback completado.*\nPipeline restaurado a \`${TARGET}\` (${sha.slice(0, 8)}).`);
  process.exit(0);
})();

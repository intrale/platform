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
// Flujo (#5723 — el guard va PRIMERO, antes de tocar nada):
//   0. Planificar: resolver el target y evaluar el guard con lecturas de git
//      puras. Si el guard frena, no se mata ni se revierte nada: el pipeline
//      queda como está (vivo, con el código que puede contener el fix) y se
//      escala a needs-human.
//   1. Loguear el diffstat de lo que se está por perder (CA-3).
//   2. Matar todos los node.exe del pipeline (saltando self).
//   3. git fetch origin pipeline-stable + checkout solo de .pipeline/.
//   4. Relanzar: node restart.js --no-smoke-test --no-rollback.
//   5. Notificar por Telegram con el tono que corresponde a la consecuencia:
//      un rollback que revierte commits nunca es un ✅.
//
// Uso:
//   node .pipeline/rollback.js              → rollback a pipeline-stable
//   node .pipeline/rollback.js <sha|tag>    → rollback a commit/tag puntual
//   node .pipeline/rollback.js --dry-run    → mostrar qué se perdería, sin tocar nada
//   node .pipeline/rollback.js --force      → ignorar el corte del guard (override manual)

const { execSync, spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { scanNodeProcesses, invalidateCache } = require('./pid-discovery');
const guard = require('./lib/rollback-guard');
const dropfileWriter = require('./lib/dropfile-writer');

const PIPELINE_DIR = __dirname;
const ROOT = path.resolve(PIPELINE_DIR, '..');
const LOG_FILE = path.join(PIPELINE_DIR, 'logs', 'rollback.log');
const ARGS = process.argv.slice(2);
const TARGET = ARGS.find((a) => !a.startsWith('--')) || 'pipeline-stable';
const FORCE = ARGS.includes('--force');
// --dry-run: planifica y muestra el diffstat sin matar, revertir ni persistir.
// Es la forma segura de contestar "¿qué me llevaría por delante un rollback?".
const DRY_RUN = ARGS.includes('--dry-run');

// #5723 (G-6) — restart.js spawnea este script con stdio redirigido al MISMO
// rollback.log al que le escribimos con appendFileSync. Sin esta guarda cada
// línea queda duplicada en el log, y un log donde todo aparece dos veces
// entrena al lector a saltearlo. Cuando el operador lo corre a mano no hay
// redirección y el console.log sigue siendo útil.
const STDOUT_IS_LOG = process.env.ROLLBACK_STDIO_IS_LOG === '1';

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const line = `[${ts}] ${msg}`;
  try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); } catch {}
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
  if (!STDOUT_IS_LOG) console.log(line);
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
    // #6226 — nombre único + escritura `wx`: dos dropfiles del mismo
    // milisegundo ya no se pisan entre sí ni pisan los de otro proceso.
    dropfileWriter.writeDropfileSync({
      dir: svcDir,
      suffix: 'rollback-alert.json',
      data: JSON.stringify({ text: msg, parse_mode: 'Markdown' }),
      onCollision: (name) => log(`Colisión de nombre de dropfile (${name}) — se reintenta`),
    });
  } catch (e) {
    log(`No se pudo encolar alerta Telegram: ${e.message}`);
  }
}

function sleep(ms) {
  spawnSync(process.execPath, ['-e', `setTimeout(()=>{},${ms})`], { timeout: ms + 2000 });
}

// --- 1) Planificar: resolver target + evaluar guard (solo lecturas) ---

/** Lectura de git que nunca lanza: devuelve '' si el comando falla. */
function gitRead(cmd, timeout = 15000) {
  return gitReadStrict(cmd, timeout).out;
}

/**
 * Igual que gitRead pero distingue "salida vacía" de "el comando falló".
 * Hace falta para no afirmar en el log que el diff está vacío (o sea, que no
 * se pierde nada) cuando en realidad no lo pudimos leer — eso sería la misma
 * ceguera que CA-3 viene a cerrar, sólo que con otra cara.
 */
function gitReadStrict(cmd, timeout = 15000) {
  try {
    return { ok: true, out: execSync(cmd, { cwd: ROOT, encoding: 'utf8', timeout, windowsHide: true }).trim() };
  } catch {
    return { ok: false, out: '' };
  }
}

/** `git merge-base --is-ancestor A B` → exit 0 si A es ancestro de B. */
function isAncestor(a, b) {
  try {
    execSync(`git merge-base --is-ancestor ${a} ${b}`, { cwd: ROOT, timeout: 10000, stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function resolveTarget() {
  log(`1) Verificando target ${TARGET}...`);

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
  return sha;
}

/**
 * Arma el plan del rollback: qué se perdería y si corresponde ejecutarlo.
 * Todas las operaciones de git acá son de lectura — si el guard decide frenar,
 * el pipeline queda exactamente como estaba.
 */
function planRollback() {
  const targetSha = resolveTarget();
  const headSha = gitRead('git rev-parse HEAD', 5000);
  const ancestor = targetSha && headSha ? isAncestor(targetSha, headSha) : false;

  // Diff en el sentido en el que el rollback mueve el árbol: de HEAD hacia el
  // target. Acotado a .pipeline/ porque el checkout también lo está.
  //
  // El registro NO se condiciona a la ancestría (bloqueante 2 de la review de
  // #5723). `git diff A B` y `git log A..B` funcionan igual sin relación de
  // ancestría, y con un target divergente — tag apuntando fuera de la historia
  // de HEAD tras un force-push/rebase de main, o invocación manual
  // `node .pipeline/rollback.js <sha>` — el rollback igual revierte. Si acá no
  // registráramos nada, ese caso perdería código sin dejar rastro: exactamente
  // la ceguera que CA-3 viene a cerrar. La ancestría alimenta sólo la severidad
  // (`selfDestructive` vía decide()), nunca suprime el registro.
  const range = `${targetSha} ${headSha}`;
  const changedFiles = gitRead(`git diff --name-only ${range} -- .pipeline/`)
    .split('\n').map((s) => s.trim()).filter(Boolean);
  const diffRead = gitReadStrict(`git diff --stat ${range} -- .pipeline/`);
  const diffstat = diffRead.out;
  const diffReadFailed = !diffRead.ok;
  const shortstat = guard.parseShortstat(gitRead(`git diff --shortstat ${range} -- .pipeline/`));
  // `A..B` con A y B divergentes lista los commits de B que no están en A, que
  // es justamente lo que el checkout se lleva puesto. Es la respuesta correcta
  // también en el caso divergente.
  const commits = guard.parseCommitList(
    gitRead(`git log --oneline --no-decorate --no-merges ${targetSha}..${headSha}`)
  );
  // Para los refs a issues miramos subject + body de TODOS los commits
  // (incluidos los merges): el `Closes #N` del body es el issue real, mientras
  // que el `#N` del subject de un squash suele ser el número del PR.
  const issues = guard.extractIssueRefs(gitRead(`git log --format=%s%n%b ${targetSha}..${headSha}`));

  const lifecycleTouched = guard.touchesLifecycle(changedFiles);
  const decision = guard.decide({
    targetSha,
    headSha,
    isAncestor: ancestor,
    lifecycleTouched,
    state: guard.readState(),
  });

  return { targetSha, headSha, ancestor, changedFiles, diffstat, diffReadFailed, shortstat, commits, issues, lifecycleTouched, decision };
}

/**
 * CA-3 — dejar registrado QUÉ se pierde ANTES de perderlo. El 2026-08-09 el
 * log decía "3) Revirtiendo .pipeline/ al target..." y nada más: la pérdida de
 * 2407 líneas fue invisible hasta auditar el git status a mano.
 */
function logDiffPreview(plan) {
  log(`  HEAD actual: ${plan.headSha || 'desconocido'}`);
  log(`  ¿Target es ancestro de HEAD?: ${plan.ancestor ? 'sí' : 'no'}`);
  if (!plan.ancestor) {
    // Caso divergente: el target no está en la historia de HEAD (force-push o
    // rebase de main, o invocación manual con un sha suelto). El checkout se
    // lleva puesto código igual, así que el registro de abajo importa MÁS acá.
    log('    OJO: el target no está en la historia de HEAD. El rollback no "vuelve atrás":');
    log('    mueve .pipeline/ a una rama distinta de la historia. Revisá el detalle de abajo.');
  }
  const lifecycleHits = plan.changedFiles.filter((f) => guard.LIFECYCLE_FILES.includes(f));
  log(`  ¿Toca archivos del lifecycle?: ${lifecycleHits.length ? 'SÍ — ' + lifecycleHits.join(', ') : 'no'}`);
  if (plan.commits.length) {
    log(`  Commits que se van a revertir (${plan.commits.length}):`);
    for (const c of plan.commits.slice(0, 20)) log(`    - ${c.sha} ${c.subject}`);
    if (plan.commits.length > 20) log(`    - ...y ${plan.commits.length - 20} más`);
  } else {
    log('  Sin commits entre el target y HEAD (nada que revertir a nivel commit)');
  }
  if (plan.diffstat) {
    log('  Diffstat de lo que se está por revertir:');
    for (const line of plan.diffstat.split('\n')) log(`    ${line}`);
  } else if (plan.diffReadFailed) {
    // No afirmar que no se pierde nada cuando en realidad no lo pudimos leer:
    // esa es la misma ceguera que CA-3 viene a cerrar, con otra cara.
    log('  NO SE PUDO LEER EL DIFFSTAT: git no respondió. No hay forma de saber qué se pierde.');
    log('  Antes de dar por bueno este rollback, mirá a mano:');
    log(`    git diff --stat ${plan.targetSha || '<target>'} ${plan.headSha || 'HEAD'} -- .pipeline/`);
  } else {
    log('  Diffstat vacío: .pipeline/ es idéntico entre el target y HEAD');
  }
  log(`  Decisión del guard: ${plan.decision.action.toUpperCase()} (intento ${plan.decision.attempt}) — ${plan.decision.reason}`);
}

/**
 * CA-4 — cortar y escalar. No se mata ningún proceso ni se revierte nada: el
 * pipeline queda con el código actual, que es justamente el que puede tener
 * el fix que el rollback estaba a punto de borrar.
 */
function escalate(plan) {
  const issues = plan.issues || [];
  guard.writeState(plan.decision.nextState);

  log('=== ROLLBACK FRENADO POR EL GUARD ===');
  log(`  ${plan.decision.reason}`);
  log('  No se revirtió nada. Se escala a intervención humana.');

  if (issues.length) {
    try {
      const { enqueueNeedsHumanLabel } = require('./lib/human-block');
      for (const issue of issues) enqueueNeedsHumanLabel(issue);
      log(`  Label needs-human encolado para: ${issues.map((i) => `#${i}`).join(', ')}`);
    } catch (e) {
      log(`  No se pudo encolar needs-human: ${e.message}`);
    }
  } else {
    log('  Sin issues referenciados en los commits — escalada sólo por alerta.');
  }

  enqueueTelegramAlert(guard.buildHaltAlert({
    target: TARGET,
    targetSha: plan.targetSha,
    headSha: plan.headSha,
    reason: plan.decision.reason,
    commits: plan.commits,
    shortstat: plan.shortstat,
    issues,
  }));
}

// --- 2) Matar todo proceso del pipeline, salteando self ---

function killPipelineProcesses() {
  log(`2) Matando procesos del pipeline (self=${process.pid})...`);

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

// --- 3) Checkout quirúrgico ---

function applyCheckout() {
  log('3) Revirtiendo .pipeline/ al target...');
  try {
    execSync(`git checkout ${TARGET} -- .pipeline/`, { cwd: ROOT, timeout: 30000 });
  } catch (e) {
    fail(`git checkout falló: ${e.message}`, 3);
  }
}

// --- 4) Relanzar pipeline (sin smoke + sin rollback recursivo) ---

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
  log(`=== ROLLBACK a ${TARGET} ===`);
  const plan = planRollback();
  logDiffPreview(plan);

  if (DRY_RUN) {
    log('--dry-run: no se mató ningún proceso, no se revirtió nada, no se persistió estado.');
    process.exit(0);
  }

  if (plan.decision.action === 'halt' && !FORCE) {
    escalate(plan);
    process.exit(10);
  }
  if (plan.decision.action === 'halt' && FORCE) {
    log('  --force activo: se ignora el corte del guard y se revierte igual.');
  }

  // Persistimos el intento ANTES de tocar el árbol: si el proceso muere
  // mid-rollback, el contador ya cuenta este ciclo y el próximo frena.
  guard.writeState(plan.decision.nextState);

  killPipelineProcesses();
  applyCheckout();
  relaunchPipeline();

  log('=== ROLLBACK COMPLETADO ===');
  log(`Pipeline revertido a ${TARGET} (${plan.targetSha.slice(0, 8)}) — ${plan.commits.length} commit(s) revertidos`);
  // G-1: el tono sigue a la consecuencia, no al exit code. El 2026-08-09 este
  // mensaje salió con ✅ dos veces mientras se borraban 2407 líneas.
  enqueueTelegramAlert(guard.buildProceedAlert({
    target: TARGET,
    targetSha: plan.targetSha,
    headSha: plan.headSha,
    severity: plan.decision.severity,
    commits: plan.commits,
    shortstat: plan.shortstat,
  }));
  process.exit(0);
})();

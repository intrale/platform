#!/usr/bin/env node
// =============================================================================
// ghostbusters.js — Mata fantasmas del sistema.
//
// Tres categorías:
//   1. Procesos Gradle/Kotlin zombies (parent process no existe)
//   2. Worktrees abandonados (sin proceso adentro + sin trabajo activo)
//   3. Emuladores no sincronizados con el dashboard/pulpo
//
// Uso:
//   node .pipeline/ghostbusters.js            → ejecuta y reporta
//   node .pipeline/ghostbusters.js --json     → reporte como JSON (para Telegram)
//   node .pipeline/ghostbusters.js --dry-run  → solo detecta, no actúa (debug)
//
// Protecciones inviolables:
//   - NUNCA tocar el repo principal C:/Workspaces/Intrale/platform
//   - NUNCA tocar el worktree donde corre este proceso
//   - NUNCA tocar procesos fuera de C:/Workspaces/Intrale/
//   - NUNCA tocar bots externos, claude-code interactivo del usuario
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

// El estado del pipeline es global del sistema (emulador, archivos de fases,
// etc.) — NO varía por worktree. Siempre operamos sobre el repo principal
// aunque el script se invoque desde un worktree secundario (ej. cs session).
const MAIN_ROOT = 'C:/Workspaces/Intrale/platform';
const PIPELINE = path.join(MAIN_ROOT, '.pipeline');
const ROOT = MAIN_ROOT;
const WORKSPACES = path.resolve(MAIN_ROOT, '..');
const QA_STATE_FILE = path.join(PIPELINE, 'qa-env-state.json');
const GH_BIN = process.env.GH_CLI_PATH || 'C:/Workspaces/gh-cli/bin/gh.exe';

const ARG_JSON = process.argv.includes('--json');
const ARG_DRY = process.argv.includes('--dry-run');

// -----------------------------------------------------------------------------
// Utilidades
// -----------------------------------------------------------------------------

function log(msg) {
  if (!ARG_JSON) console.log(msg);
}

function wmicProcesses() {
  // Devuelve lista de {pid, ppid, name, cmd, rssBytes}
  try {
    const out = execSync(
      'wmic process get processid,parentprocessid,name,commandline,workingsetsize /format:csv',
      { encoding: 'utf8', timeout: 20000, windowsHide: true, maxBuffer: 20 * 1024 * 1024 }
    );
    const lines = out.split('\n').filter(l => l.includes(',') && !l.startsWith('Node'));
    const procs = [];
    for (const line of lines) {
      // CSV de wmic: Node,CommandLine,Name,ParentProcessId,ProcessId,WorkingSetSize
      // CommandLine puede contener comas; parseamos desde la derecha.
      const parts = line.split(',');
      if (parts.length < 5) continue;
      const rssBytes = parseInt(parts[parts.length - 1].trim(), 10) || 0;
      const pid = parseInt(parts[parts.length - 2].trim(), 10);
      const ppid = parseInt(parts[parts.length - 3].trim(), 10);
      const name = parts[parts.length - 4].trim();
      const cmd = parts.slice(1, parts.length - 4).join(',').trim();
      if (!pid) continue;
      procs.push({ pid, ppid, name, cmd, rssBytes });
    }
    return procs;
  } catch (e) {
    log(`⚠️ wmic falló: ${e.message.slice(0, 120)}`);
    return [];
  }
}

function killPid(pid) {
  try {
    spawnSync('taskkill', ['/F', '/PID', String(pid)], {
      timeout: 10000, windowsHide: true, stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function fmtMB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(0);
}

function fmtGB(bytes) {
  return (bytes / (1024 * 1024 * 1024)).toFixed(2);
}

function readJson(filepath) {
  try { return JSON.parse(fs.readFileSync(filepath, 'utf8')); } catch { return null; }
}

function isInsideWorkspace(p) {
  // Normaliza a forward-slash para comparación
  const norm = (s) => (s || '').replace(/\\/g, '/').toLowerCase();
  return norm(p).startsWith(norm(WORKSPACES).toLowerCase());
}

function isPathMe() {
  // Detecta si este script está corriendo en un worktree (cwd) — protege ese worktree
  const norm = (s) => (s || '').replace(/\\/g, '/').toLowerCase();
  return norm(process.cwd());
}

function listWorktrees() {
  try {
    const out = execSync('git worktree list --porcelain', {
      cwd: ROOT, encoding: 'utf8', timeout: 10000, windowsHide: true,
    });
    const worktrees = [];
    let cur = null;
    for (const line of out.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (cur) worktrees.push(cur);
        cur = { path: line.slice(9).trim(), branch: null, head: null };
      } else if (line.startsWith('HEAD ') && cur) {
        cur.head = line.slice(5).trim();
      } else if (line.startsWith('branch ') && cur) {
        cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
      }
    }
    if (cur) worktrees.push(cur);
    return worktrees;
  } catch (e) {
    log(`⚠️ git worktree list falló: ${e.message.slice(0, 120)}`);
    return [];
  }
}

// Verifica si un worktree tiene trabajo que se perdería al borrar:
//   - cambios sin commitear en el árbol de trabajo
//   - commits locales ahead de origin/<branch>
// Retorna true si es SEGURO borrar (worktree limpio + rama en sync con origin).
function isWorktreeSafeToDelete(wtPath, branch) {
  try {
    // 1. ¿Hay cambios sin commitear?
    const status = execSync('git status --porcelain', {
      cwd: wtPath, encoding: 'utf8', timeout: 10000, windowsHide: true,
    }).trim();
    // Ignorar cambios en .claude/ (son copias por hook, no trabajo del usuario)
    const relevantChanges = status.split('\n').filter(l => {
      if (!l.trim()) return false;
      const filepath = l.substring(3).trim();
      return !filepath.startsWith('.claude/') && !filepath.startsWith('.claude\\');
    });
    if (relevantChanges.length > 0) return { safe: false, reason: `${relevantChanges.length} archivo(s) sin commitear` };

    // 2. ¿Hay commits locales ahead de origin?
    if (branch) {
      try {
        const ahead = execSync(`git rev-list --count origin/${branch}..HEAD`, {
          cwd: wtPath, encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        const n = parseInt(ahead, 10) || 0;
        if (n > 0) return { safe: false, reason: `${n} commit(s) ahead de origin/${branch}` };
      } catch {
        // origin/<branch> no existe → rama no pusheada → comprobar si hay commits más allá de main
        try {
          const fromMain = execSync(`git rev-list --count origin/main..HEAD`, {
            cwd: wtPath, encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
          }).trim();
          const n = parseInt(fromMain, 10) || 0;
          if (n > 0) return { safe: false, reason: `rama no pusheada con ${n} commit(s) sobre main` };
        } catch {}
      }
    }
    return { safe: true };
  } catch (e) {
    // Si git falla, NO borrar — fail-safe
    return { safe: false, reason: `no pude inspeccionar: ${e.message.slice(0, 60)}` };
  }
}

function issueIsOpen(issueNum) {
  try {
    const ghPath = fs.existsSync(GH_BIN) ? GH_BIN : 'gh';
    const out = execSync(
      `"${ghPath}" issue view ${issueNum} --repo intrale/platform --json state --jq ".state"`,
      { encoding: 'utf8', timeout: 10000, windowsHide: true }
    ).trim();
    return out === 'OPEN';
  } catch {
    return false;
  }
}

function prForBranch(branch) {
  try {
    const ghPath = fs.existsSync(GH_BIN) ? GH_BIN : 'gh';
    const out = execSync(
      `"${ghPath}" pr list --repo intrale/platform --head "${branch}" --state open --json number --jq ".[0].number"`,
      { encoding: 'utf8', timeout: 10000, windowsHide: true }
    ).trim();
    return out ? parseInt(out, 10) : null;
  } catch {
    return null;
  }
}

function dirSizeBytes(dir) {
  // du -sb en bash, pero en Windows tenemos que iterar. Usamos un atajo con powershell.
  try {
    const out = execSync(
      `powershell -NoProfile -Command "(Get-ChildItem -Path '${dir}' -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum"`,
      { encoding: 'utf8', timeout: 30000, windowsHide: true }
    ).trim();
    return parseInt(out, 10) || 0;
  } catch {
    return 0;
  }
}

function removeWorktree(wtPath) {
  try {
    // Primero: desmontar junction .claude/ si existe (memoria: usar cmd rmdir, no rm -rf)
    const claudeLink = path.join(wtPath, '.claude');
    if (fs.existsSync(claudeLink)) {
      try {
        spawnSync('cmd', ['/c', 'rmdir', claudeLink.replace(/\//g, '\\')], {
          timeout: 5000, windowsHide: true, stdio: 'ignore',
        });
      } catch {}
    }
    execSync(`git worktree remove "${wtPath}" --force`, {
      cwd: ROOT, timeout: 30000, windowsHide: true, stdio: 'ignore',
    });
    // Borrar también la branch local
    try {
      execSync(`git branch -D "$(git worktree list | grep "${wtPath}" | awk '{print $3}' | tr -d '[]')" 2>/dev/null`, {
        cwd: ROOT, shell: true, windowsHide: true, stdio: 'ignore',
      });
    } catch {}
    return true;
  } catch (e) {
    log(`⚠️ no pude remover ${wtPath}: ${e.message.slice(0, 120)}`);
    return false;
  }
}

// -----------------------------------------------------------------------------
// Detección 1: Gradle/Kotlin zombies
// -----------------------------------------------------------------------------

function findGradleZombies(procs) {
  const pidsAlive = new Set(procs.map(p => p.pid));
  const gradleish = /gradle|kotlin.*daemon|KotlinCompile/i;

  const zombies = [];
  for (const p of procs) {
    if (p.name !== 'java.exe' && p.name !== 'javaw.exe') continue;
    if (!gradleish.test(p.cmd)) continue;
    // Parent no existe más → zombie real
    if (p.ppid && !pidsAlive.has(p.ppid)) {
      zombies.push({ ...p, reason: `parent ${p.ppid} no existe` });
    }
  }
  return zombies;
}

// -----------------------------------------------------------------------------
// Detección 2: Worktrees abandonados
// -----------------------------------------------------------------------------

function pipelineHasActiveWork(issueNum) {
  // Chequea archivos en desarrollo/*/{trabajando,pendiente,listo}/<issue>.*
  const activeStates = ['trabajando', 'pendiente', 'listo'];
  const fases = ['validacion', 'dev', 'build', 'verificacion', 'aprobacion', 'entrega'];
  for (const fase of fases) {
    for (const estado of activeStates) {
      const dir = path.join(PIPELINE, 'desarrollo', fase, estado);
      try {
        const files = fs.readdirSync(dir);
        if (files.some(f => f.startsWith(`${issueNum}.`))) return true;
      } catch {}
    }
  }
  return false;
}

function findAbandonedWorktrees(procs) {
  const worktrees = listWorktrees();
  const abandoned = [];
  const myCwd = isPathMe();

  // Set de cwd de procesos vivos (normalizado a forward-slash lowercase)
  const cwds = new Set();
  // wmic no da cwd directo; lo sacamos del cmd si contiene un path de worktree
  for (const p of procs) {
    const m = p.cmd.match(/C:[\\/]Workspaces[\\/]Intrale[\\/](platform[^\\/\s"]*)/i);
    if (m) cwds.add(m[0].replace(/\\/g, '/').toLowerCase());
  }

  for (const wt of worktrees) {
    const wtPathNorm = wt.path.replace(/\\/g, '/');
    const wtLower = wtPathNorm.toLowerCase();

    // Protecciones
    if (wtLower === 'c:/workspaces/intrale/platform') continue; // repo principal
    if (myCwd.startsWith(wtLower)) continue; // yo mismo
    if (!wtLower.startsWith('c:/workspaces/intrale/platform.')) continue; // fuera de scope

    // ¿Hay proceso con cwd en este worktree?
    let hasLiveProc = false;
    for (const cwd of cwds) {
      if (cwd.startsWith(wtLower)) { hasLiveProc = true; break; }
    }
    if (hasLiveProc) continue;

    // Clasificar: agent/<N> o session/<desc>
    const branch = wt.branch || '';
    let issueNum = null;
    let reason = null;

    const agentMatch = wtPathNorm.match(/platform\.agent-(\d+)-/);
    const sessionMatch = wtPathNorm.match(/platform\.session-/);

    if (agentMatch) {
      issueNum = parseInt(agentMatch[1], 10);
      const hasWork = pipelineHasActiveWork(issueNum);
      const issueOpen = issueIsOpen(issueNum);
      if (!hasWork && !issueOpen) {
        reason = `issue #${issueNum} cerrado y sin trabajo activo`;
      } else if (!hasWork && issueOpen) {
        // issue abierto pero pipeline sin trabajo: verificar PR abierto de esta rama
        const pr = prForBranch(branch);
        if (!pr) reason = `issue #${issueNum} abierto pero sin PR ni trabajo en pipeline`;
      }
    } else if (sessionMatch) {
      const pr = prForBranch(branch);
      if (!pr) reason = `session sin PR abierto`;
    } else {
      // Otros worktrees (fix, spike, etc.) — solo si la rama no tiene PR
      const pr = prForBranch(branch);
      if (!pr) reason = `rama sin PR abierto`;
    }

    if (reason) {
      // Protección fail-safe: si hay trabajo sin push / sin commit, NO borrar
      const safety = isWorktreeSafeToDelete(wt.path, branch);
      if (!safety.safe) {
        abandoned.push({ path: wt.path, branch, issue: issueNum, reason, skip: true, skipReason: safety.reason });
      } else {
        abandoned.push({ path: wt.path, branch, issue: issueNum, reason });
      }
    }
  }
  return abandoned;
}

// -----------------------------------------------------------------------------
// Detección 3: Emuladores no sincronizados
// -----------------------------------------------------------------------------

function findPhantomEmulators(procs) {
  const state = readJson(QA_STATE_FILE) || {};
  const officialPid = state.emulator || null;

  const emulatorNames = /^(qemu-system-x86_64|emulator|emulator64-crash-service|adb)\.exe$/i;
  const emulatorCmds = /qemu-system|emulator64|android.*sdk.*emulator|adb\.exe.*start-server/i;

  // Construir árbol padre/hijo
  const byPid = new Map(procs.map(p => [p.pid, p]));
  const children = new Map();
  for (const p of procs) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(p.pid);
  }

  function descendants(pid, acc = new Set()) {
    const kids = children.get(pid) || [];
    for (const k of kids) {
      if (!acc.has(k)) { acc.add(k); descendants(k, acc); }
    }
    return acc;
  }

  // La "familia" del emulador oficial incluye: el propio PID, sus descendientes,
  // y también subir al ancestor raíz relacionado con el emulador (Android Studio
  // lanza emulator.exe → qemu-system — el "oficial" en qa-env-state es qemu pero
  // el padre emulator.exe también es legítimo). Subimos mientras el ancestor
  // sea un proceso emulator-related.
  const isEmulatorLike = (p) =>
    p && (emulatorNames.test(p.name) || emulatorCmds.test(p.cmd));

  const officialFamily = new Set();
  if (officialPid && byPid.has(officialPid)) {
    // Subir hasta el ancestor raíz emulator-related
    let rootPid = officialPid;
    let cur = byPid.get(officialPid);
    while (cur && cur.ppid && byPid.has(cur.ppid) && isEmulatorLike(byPid.get(cur.ppid))) {
      rootPid = cur.ppid;
      cur = byPid.get(cur.ppid);
    }
    officialFamily.add(rootPid);
    descendants(rootPid, officialFamily);
  }

  const phantoms = [];
  for (const p of procs) {
    const isEmu = emulatorNames.test(p.name) || emulatorCmds.test(p.cmd);
    if (!isEmu) continue;
    if (officialFamily.has(p.pid)) continue; // parte del emulador oficial
    // adb.exe server puede ser spawneado por cualquiera (gradle, agente); lo excluimos si su parent
    // es un proceso del repo principal. Solo matamos los huérfanos estrictos.
    if (p.name.toLowerCase() === 'adb.exe') {
      // adb es muy compartido; solo lo mato si no hay emulator.exe/qemu vivo tampoco
      const anyEmuAlive = procs.some(q =>
        /^(qemu-system|emulator)/i.test(q.name) && officialFamily.has(q.pid)
      );
      if (!anyEmuAlive && !officialPid) {
        phantoms.push({ ...p, reason: 'adb server sin emulador oficial' });
      }
      continue;
    }
    phantoms.push({ ...p, reason: officialPid ? `no pertenece a PID oficial ${officialPid}` : 'sin emulador oficial registrado' });
  }
  return phantoms;
}

// -----------------------------------------------------------------------------
// Orquestación
// -----------------------------------------------------------------------------

function run() {
  const procs = wmicProcesses();

  const zombies = findGradleZombies(procs);
  const abandoned = findAbandonedWorktrees(procs);
  const phantomEmus = findPhantomEmulators(procs);

  const report = {
    timestamp: new Date().toISOString(),
    zombies: [],
    worktrees: [],
    emulators: [],
    ramFreedBytes: 0,
    diskFreedBytes: 0,
  };

  // 1. Matar zombies
  for (const z of zombies) {
    const ok = ARG_DRY ? false : killPid(z.pid);
    report.zombies.push({ pid: z.pid, name: z.name, rssBytes: z.rssBytes, reason: z.reason, killed: ok });
    if (ok) report.ramFreedBytes += z.rssBytes;
  }

  // 2. Matar emuladores fantasma
  for (const e of phantomEmus) {
    const ok = ARG_DRY ? false : killPid(e.pid);
    report.emulators.push({ pid: e.pid, name: e.name, rssBytes: e.rssBytes, reason: e.reason, killed: ok });
    if (ok) report.ramFreedBytes += e.rssBytes;
  }

  // 3. Limpiar worktrees (más lento — calcula tamaño antes).
  // Los que tienen `skip: true` no se remueven (tienen trabajo sin push).
  for (const w of abandoned) {
    const size = dirSizeBytes(w.path);
    const entry = { path: w.path, branch: w.branch, issue: w.issue, reason: w.reason, diskBytes: size };
    if (w.skip) {
      entry.skipped = true;
      entry.skipReason = w.skipReason;
      entry.removed = false;
    } else {
      const ok = ARG_DRY ? false : removeWorktree(w.path);
      entry.removed = ok;
      if (ok) report.diskFreedBytes += size;
    }
    report.worktrees.push(entry);
  }

  return report;
}

function fmtReport(r) {
  const lines = [];
  lines.push(`👻 *Ghostbusters* — ${r.timestamp.slice(0, 19).replace('T', ' ')}`);
  lines.push('');

  if (r.zombies.length === 0 && r.worktrees.length === 0 && r.emulators.length === 0) {
    lines.push('✅ No hay fantasmas. Sistema sano.');
    return lines.join('\n');
  }

  if (r.zombies.length > 0) {
    lines.push(`*Gradle/Kotlin zombies:* ${r.zombies.length}`);
    for (const z of r.zombies) {
      lines.push(`  ${z.killed ? '☠️' : '⚠️'} PID ${z.pid} ${z.name} (${fmtMB(z.rssBytes)} MB) — ${z.reason}`);
    }
    lines.push('');
  }

  if (r.emulators.length > 0) {
    lines.push(`*Emuladores fantasma:* ${r.emulators.length}`);
    for (const e of r.emulators) {
      lines.push(`  ${e.killed ? '☠️' : '⚠️'} PID ${e.pid} ${e.name} (${fmtMB(e.rssBytes)} MB) — ${e.reason}`);
    }
    lines.push('');
  }

  if (r.worktrees.length > 0) {
    const removed = r.worktrees.filter(w => w.removed);
    const skipped = r.worktrees.filter(w => w.skipped);
    lines.push(`*Worktrees abandonados:* ${r.worktrees.length} (${removed.length} borrados, ${skipped.length} protegidos)`);
    for (const w of r.worktrees) {
      const name = path.basename(w.path);
      const size = w.diskBytes > 0 ? ` (${fmtGB(w.diskBytes)} GB)` : '';
      if (w.skipped) {
        lines.push(`  🛡️ ${name}${size} — ${w.reason} · NO borrado: ${w.skipReason}`);
      } else {
        lines.push(`  ${w.removed ? '🗑' : '⚠️'} ${name}${size} — ${w.reason}`);
      }
    }
    lines.push('');
  }

  const ramGB = r.ramFreedBytes / (1024 ** 3);
  const diskGB = r.diskFreedBytes / (1024 ** 3);
  lines.push(`*Total liberado:* ${diskGB.toFixed(2)} GB disco · ${ramGB.toFixed(2)} GB RAM`);

  return lines.join('\n');
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

if (require.main === module) {
  const report = run();
  if (ARG_JSON) {
    process.stdout.write(JSON.stringify(report, null, 2));
  } else {
    console.log(fmtReport(report));
  }
}

module.exports = { run, fmtReport };

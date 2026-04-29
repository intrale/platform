#!/usr/bin/env node
// =============================================================================
// ghostbusters.js — Caza fantasmas del sistema. Unifica /cleanup y /checkup.
//
// Categorías:
//   1. Procesos
//      a. Gradle/Kotlin zombies (parent muerto)
//      b. Emuladores fantasma (no sincronizados con qa-env-state)
//      c. bash.exe colgados con tail -f cuyo productor murió
//      d. node.exe ejecutando scripts one-shot externos huérfanos (parse-*, fichar_*, etc.)
//      e. Watchdogs duplicados (mismo .ps1 corriendo dos veces)
//      f. claude.exe inactivo > 30 min (no actual ni padre)
//      g. node.exe corriendo .claude/hooks/* > 15 min
//   2. Worktrees abandonados (sin proceso vivo + sin trabajo activo)
//   3. Sesiones .claude/sessions/*.json done > 1h
//   4. Locks stale (PID muerto en .claude/hooks/*.lock, *.pid, scripts/sprint-pids.json)
//   5. Logs oversized (hook-debug.log > 500 líneas, activity-log.jsonl > 200 entradas)
//   6. QA artifacts viejos (qa/backend.log, qa/recordings/*)
//   7. Consistencia agentes vs PRs (solo reporte)
//   8. Entorno (Java, gh, disco — solo reporte)
//
// Uso CLI:
//   node ghostbusters.js                 → dry-run completo (default seguro)
//   node ghostbusters.js --run           → auto-fix completo
//   node ghostbusters.js --deep          → incluye build/, .gradle/, node_modules (implica --run)
//   node ghostbusters.js --json          → salida JSON cruda
//   node ghostbusters.js --processes     → solo procesos (dry-run salvo --run)
//   node ghostbusters.js --worktrees     → solo worktrees
//   node ghostbusters.js --logs          → solo logs
//   node ghostbusters.js --sessions      → solo sesiones
//   node ghostbusters.js --locks         → solo locks
//   node ghostbusters.js --qa            → solo qa artifacts
//   node ghostbusters.js --agents        → solo consistencia agentes
//   node ghostbusters.js --env           → solo entorno
//
// API programática:
//   const gb = require('./ghostbusters');
//   const report = gb.run({ dryRun: false, categories: [...], deep: false });
//   console.log(gb.fmtReport(report));
//
// Whitelist absoluta — NUNCA matar:
//   - Watchdogs: powershell *\watchdog.ps1 (Intrale, Alina, Diego/club25)
//   - Bots Telegram: node bot.js bajo {oficina,club25,nestor}/telegram*/
//   - Daemons Intrale: node .pipeline/{dashboard,pulpo,servicio-*,listener-telegram,telegram-commander}.js
//   - Sistema: claude.exe actual y padre, IDEs, MsMpEng, svchost, dwm, explorer
//   - Repo principal C:/Workspaces/Intrale/platform y el worktree donde corre este script
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

// -----------------------------------------------------------------------------
// Constantes
// -----------------------------------------------------------------------------

const MAIN_ROOT = 'C:/Workspaces/Intrale/platform';
const PIPELINE = path.join(MAIN_ROOT, '.pipeline');
const ROOT = MAIN_ROOT;
const WORKSPACES = path.resolve(MAIN_ROOT, '..');
const QA_STATE_FILE = path.join(PIPELINE, 'qa-env-state.json');
const GH_BIN = process.env.GH_CLI_PATH || 'C:/Workspaces/gh-cli/bin/gh.exe';

const HOOKS_DIR = path.join(MAIN_ROOT, '.claude', 'hooks');
const SESSIONS_DIR = path.join(MAIN_ROOT, '.claude', 'sessions');
const ACTIVITY_LOG = path.join(MAIN_ROOT, '.claude', 'activity-log.jsonl');
const HOOK_DEBUG_LOG = path.join(HOOKS_DIR, 'hook-debug.log');
const TG_LOCK = path.join(HOOKS_DIR, 'telegram-commander.lock');
const REPORTER_PID = path.join(HOOKS_DIR, 'reporter.pid');
const QA_BACKEND_LOG = path.join(MAIN_ROOT, 'qa', 'backend.log');
const QA_RECORDINGS = path.join(MAIN_ROOT, 'qa', 'recordings');
const SPRINT_PIDS = path.join(MAIN_ROOT, 'scripts', 'sprint-pids.json');

const TH = {
  bashTailIdleMin: 15,
  nodeOneShotIdleMin: 30,
  claudeIdleMin: 30,
  nodeHookIdleMin: 15,
  sessionDoneAgeHours: 1,
  hookLogMaxLines: 500,
  activityLogMaxEntries: 200,
};

const PROTECTED_FILES = new Set([
  'telegram-config.json', 'settings.json', 'settings.local.json',
  'permissions-baseline.json', 'package.json', 'package-lock.json',
  'tg-session-store.json', 'tg-offsets.json', 'session-state.json',
  'agent-metrics.json', 'agent-participation.json', 'heartbeat-state.json',
  'scrum-health-history.jsonl',
]);

// -----------------------------------------------------------------------------
// Whitelist absoluta de procesos
// -----------------------------------------------------------------------------

const WHITELIST = {
  watchdogs: [
    /[\\/]watchdog\.ps1\b/i,
    /[\\/][\w-]+-watchdog\.ps1\b/i,
  ],
  botsTelegram: [
    /[\\/]oficina[\\/]telegram[\\/]bot\.js\b/i,
    /[\\/]club25[\\/]telegram-club[\\/]bot\.js\b/i,
    /[\\/]nestor[\\/]telegram[\\/]bot\.js\b/i,
    /[\\/]nestor[\\/]bot\.js\b/i,
  ],
  daemonsIntrale: [
    /[\\/]\.pipeline[\\/](dashboard|pulpo|servicio-[\w-]+|listener-telegram|telegram-commander|watchdog-loop)\.js\b/i,
    /[\\/]\.claude[\\/]hooks[\\/]telegram-commander\.js\b/i,
  ],
  systemNames: new Set([
    'system', 'idle', 'csrss.exe', 'wininit.exe', 'services.exe',
    'lsass.exe', 'svchost.exe', 'msmpeng.exe', 'dwm.exe', 'explorer.exe',
    'fontdrvhost.exe', 'taskhostw.exe', 'sihost.exe', 'searchhost.exe',
    'runtimebroker.exe', 'shellexperiencehost.exe', 'startmenuexperiencehost.exe',
    'idea64.exe', 'studio64.exe', 'code.exe', 'devenv.exe', 'webstorm64.exe',
    'pycharm64.exe', 'rider64.exe', 'goland64.exe',
    'chrome.exe', 'msedge.exe', 'firefox.exe', 'msedgewebview2.exe',
    'whatsapp.exe', 'whatsapp.root.exe', 'photos.exe',
    'logioptionsplus_agent.exe', 'spoolsv.exe', 'audiodg.exe',
    'memory compression', 'registry',
  ]),
};

function isWhitelisted(proc, ancestorPids) {
  if (ancestorPids && ancestorPids.has(proc.pid)) return { wl: true, why: 'ancestor of this script' };
  const nameLow = (proc.name || '').toLowerCase();
  if (WHITELIST.systemNames.has(nameLow)) return { wl: true, why: 'system' };
  for (const re of WHITELIST.watchdogs) if (re.test(proc.cmd)) return { wl: true, why: 'watchdog' };
  for (const re of WHITELIST.botsTelegram) if (re.test(proc.cmd)) return { wl: true, why: 'bot-telegram' };
  for (const re of WHITELIST.daemonsIntrale) if (re.test(proc.cmd)) return { wl: true, why: 'daemon-intrale' };
  return { wl: false };
}

// Calcula la cadena de ancestros (PIDs) del proceso actual subiendo por ppid.
// Esto incluye el claude.exe (o terminal/cmd/ide) que ejecutó esta sesión.
function ancestorPidsOf(procs, startPid, startPpid) {
  const byPid = new Map(procs.map(p => [p.pid, p]));
  const ancestors = new Set();
  ancestors.add(startPid);
  let cur = startPpid;
  let safety = 50; // anti-loop
  while (cur && cur > 0 && !ancestors.has(cur) && safety-- > 0) {
    ancestors.add(cur);
    const p = byPid.get(cur);
    if (!p) break;
    cur = p.ppid;
  }
  return ancestors;
}

// -----------------------------------------------------------------------------
// Args
// -----------------------------------------------------------------------------

function parseCliArgs(argv) {
  const flags = new Set(argv.filter(a => a.startsWith('--')));
  const opts = {
    json: flags.has('--json'),
    deep: flags.has('--deep'),
    explicitDryRun: flags.has('--dry-run'),
    explicitRun: flags.has('--run') || flags.has('--deep'),
    categories: new Set(),
  };
  const knownCats = ['processes', 'worktrees', 'sessions', 'locks', 'logs', 'qa', 'agents', 'env'];
  for (const c of knownCats) if (flags.has(`--${c}`)) opts.categories.add(c);
  if (opts.categories.size === 0) for (const c of knownCats) opts.categories.add(c);
  opts.dryRun = opts.explicitDryRun || !opts.explicitRun;
  return opts;
}

// -----------------------------------------------------------------------------
// Utilidades
// -----------------------------------------------------------------------------

let LOG_QUIET = false;
function log(msg) {
  if (!LOG_QUIET) console.log(msg);
}

function fmtMB(bytes) { return (bytes / (1024 * 1024)).toFixed(0); }
function fmtGB(bytes) { return (bytes / (1024 * 1024 * 1024)).toFixed(2); }

function readJson(filepath) {
  try { return JSON.parse(fs.readFileSync(filepath, 'utf8')); } catch { return null; }
}

function parseWmicCreationDate(s) {
  if (!s) return null;
  const m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`).getTime();
}

function wmicProcesses() {
  // wmic CSV con columnas (orden alfabético): Node, CommandLine, CreationDate, Name, ParentProcessId, ProcessId, WorkingSetSize
  try {
    const out = execSync(
      'wmic process get commandline,creationdate,name,parentprocessid,processid,workingsetsize /format:csv',
      { encoding: 'utf8', timeout: 20000, windowsHide: true, maxBuffer: 30 * 1024 * 1024 }
    );
    const lines = out.split('\n').filter(l => l.includes(',') && !l.startsWith('Node'));
    const procs = [];
    for (const line of lines) {
      const parts = line.split(',');
      if (parts.length < 6) continue;
      const rssBytes = parseInt(parts[parts.length - 1].trim(), 10) || 0;
      const pid = parseInt(parts[parts.length - 2].trim(), 10);
      const ppid = parseInt(parts[parts.length - 3].trim(), 10);
      const name = parts[parts.length - 4].trim();
      const createdRaw = parts[parts.length - 5].trim();
      const cmd = parts.slice(1, parts.length - 5).join(',').trim();
      if (!pid) continue;
      procs.push({
        pid, ppid, name, cmd, rssBytes,
        startMs: parseWmicCreationDate(createdRaw),
      });
    }
    return procs;
  } catch (e) {
    log(`⚠️ wmic falló: ${e.message.slice(0, 120)}`);
    return [];
  }
}

function ageMinutes(p) {
  if (!p.startMs) return null;
  return (Date.now() - p.startMs) / 60000;
}

function killPid(pid) {
  try {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], {
      timeout: 10000, windowsHide: true, stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function isPathMe() {
  const norm = (s) => (s || '').replace(/\\/g, '/').toLowerCase();
  return norm(process.cwd());
}

// -----------------------------------------------------------------------------
// Worktrees — utilidades
// -----------------------------------------------------------------------------

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

function isWorktreeSafeToDelete(wtPath, branch) {
  try {
    const status = execSync('git status --porcelain', {
      cwd: wtPath, encoding: 'utf8', timeout: 10000, windowsHide: true,
    }).trim();
    const relevantChanges = status.split('\n').filter(l => {
      if (!l.trim()) return false;
      const filepath = l.substring(3).trim();
      return !filepath.startsWith('.claude/') && !filepath.startsWith('.claude\\');
    });
    if (relevantChanges.length > 0) return { safe: false, reason: `${relevantChanges.length} archivo(s) sin commitear` };

    if (branch) {
      try {
        const ahead = execSync(`git rev-list --count origin/${branch}..HEAD`, {
          cwd: wtPath, encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        const n = parseInt(ahead, 10) || 0;
        if (n > 0) return { safe: false, reason: `${n} commit(s) ahead de origin/${branch}` };
      } catch {
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
    if (fs.existsSync(wtPath)) {
      try { fs.rmSync(wtPath, { recursive: true, force: true }); } catch {}
    }
    return true;
  } catch (e) {
    log(`⚠️ no pude remover ${wtPath}: ${e.message.slice(0, 120)}`);
    return false;
  }
}

// -----------------------------------------------------------------------------
// CAZADORES
// -----------------------------------------------------------------------------

function findGradleZombies(procs) {
  const pidsAlive = new Set(procs.map(p => p.pid));
  const gradleish = /gradle|kotlin.*daemon|KotlinCompile/i;
  const zombies = [];
  for (const p of procs) {
    if (p.name !== 'java.exe' && p.name !== 'javaw.exe') continue;
    if (!gradleish.test(p.cmd)) continue;
    if (p.ppid && !pidsAlive.has(p.ppid)) {
      zombies.push({ ...p, reason: `parent ${p.ppid} no existe` });
    }
  }
  return zombies;
}

function pipelineHasActiveWork(issueNum) {
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
  const cwds = new Set();
  for (const p of procs) {
    const m = p.cmd.match(/C:[\\/]Workspaces[\\/]Intrale[\\/](platform[^\\/\s"]*)/i);
    if (m) cwds.add(m[0].replace(/\\/g, '/').toLowerCase());
  }
  for (const wt of worktrees) {
    const wtPathNorm = wt.path.replace(/\\/g, '/');
    const wtLower = wtPathNorm.toLowerCase();
    if (wtLower === 'c:/workspaces/intrale/platform') continue;
    if (myCwd.startsWith(wtLower)) continue;
    if (!wtLower.startsWith('c:/workspaces/intrale/platform.')) continue;
    let hasLiveProc = false;
    for (const cwd of cwds) {
      if (cwd.startsWith(wtLower)) { hasLiveProc = true; break; }
    }
    if (hasLiveProc) continue;
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
        const pr = prForBranch(branch);
        if (!pr) reason = `issue #${issueNum} abierto pero sin PR ni trabajo en pipeline`;
      }
    } else if (sessionMatch) {
      const pr = prForBranch(branch);
      if (!pr) reason = `session sin PR abierto`;
    } else {
      const pr = prForBranch(branch);
      if (!pr) reason = `rama sin PR abierto`;
    }
    if (reason) {
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

function findPhantomEmulators(procs) {
  const state = readJson(QA_STATE_FILE) || {};
  const officialPid = state.emulator || null;
  const emulatorNames = /^(qemu-system-x86_64|emulator|emulator64-crash-service|adb)\.exe$/i;
  const emulatorCmds = /qemu-system|emulator64|android.*sdk.*emulator|adb\.exe.*start-server/i;
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
  const isEmulatorLike = (p) => p && (emulatorNames.test(p.name) || emulatorCmds.test(p.cmd));
  const officialFamily = new Set();
  if (officialPid && byPid.has(officialPid)) {
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
    if (officialFamily.has(p.pid)) continue;
    if (p.name.toLowerCase() === 'adb.exe') {
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

function findBashTailOrphans(procs, ancestorPids) {
  const pidsAlive = new Set(procs.map(p => p.pid));
  const orphans = [];
  for (const p of procs) {
    if (!/^bash\.exe$/i.test(p.name)) continue;
    if (!/tail\s+-f/i.test(p.cmd)) continue;
    if (isWhitelisted(p, ancestorPids).wl) continue;

    const m = p.cmd.match(/tail\s+-f\s+(?:\\?["'])?([^"'|<>]+?)(?:\\?["'])?\s*[|<]/i);
    let filePath = m ? m[1].trim() : null;
    if (filePath) filePath = filePath.replace(/^\\?["']/, '').replace(/["']$/, '');

    let reason = null;
    let osPath = filePath ? filePath.replace(/\//g, path.sep) : null;
    if (!filePath) {
      if (p.ppid && !pidsAlive.has(p.ppid)) {
        const age = ageMinutes(p);
        if (age === null || age > TH.bashTailIdleMin) reason = `tail -f sin path + parent ${p.ppid} muerto`;
      }
    } else if (!fs.existsSync(osPath)) {
      reason = `archivo no existe: ${path.basename(osPath)}`;
    } else {
      try {
        const stat = fs.statSync(osPath);
        const ageMin = (Date.now() - stat.mtimeMs) / 60000;
        if (ageMin > TH.bashTailIdleMin) {
          reason = `archivo sin escritor (mtime hace ${ageMin.toFixed(0)} min)`;
        }
      } catch {}
    }
    if (!reason && p.ppid && !pidsAlive.has(p.ppid)) {
      reason = `parent ${p.ppid} no existe`;
    }
    if (reason) orphans.push({ ...p, reason });
  }
  return orphans;
}

function findExtBotZombies(procs, ancestorPids) {
  const pidsAlive = new Set(procs.map(p => p.pid));
  const oneShotPatterns = [
    /[\\/]parse-?carnets?\.js\b/i,
    /[\\/]parse[_-]now\.js\b/i,
    /[\\/]parse_fefi/i,
    /[\\/]parse_bajada/i,
    /[\\/]descargar[_-][\w-]+\.js\b/i,
    /[\\/]generar[_-][\w-]+\.js\b/i,
    /[\\/]reporte[_-][\w-]+\.js\b/i,
    /[\\/]reporte-[\w-]+\.js\b/i,
    /[\\/]fichar[_-][\w-]+\.js\b/i,
    /[\\/]tmp[\\/][\w-]+\.js\b/i,
  ];
  const zombies = [];
  for (const p of procs) {
    if (!/^node\.exe$/i.test(p.name)) continue;
    if (isWhitelisted(p, ancestorPids).wl) continue;
    const isOneShot = oneShotPatterns.some(re => re.test(p.cmd));
    if (!isOneShot) continue;
    let reason = null;
    if (p.ppid && !pidsAlive.has(p.ppid)) {
      reason = `parent ${p.ppid} no existe`;
    } else {
      const age = ageMinutes(p);
      if (age !== null && age > TH.nodeOneShotIdleMin) {
        reason = `script one-shot vivo hace ${age.toFixed(0)} min`;
      }
    }
    if (reason) zombies.push({ ...p, reason });
  }
  return zombies;
}

function findDuplicateWatchdogs(procs) {
  const byScript = new Map();
  for (const p of procs) {
    if (!/^powershell(_ise)?\.exe$/i.test(p.name)) continue;
    const m = p.cmd.match(/([A-Z]:[\\/](?:[\w.-]+[\\/])*[\w.-]*watchdog\.ps1)/i);
    if (!m) continue;
    const key = m[1].toLowerCase().replace(/\\/g, '/');
    if (!byScript.has(key)) byScript.set(key, []);
    byScript.get(key).push(p);
  }
  const duplicates = [];
  for (const [script, list] of byScript) {
    if (list.length <= 1) continue;
    list.sort((a, b) => (a.startMs || 0) - (b.startMs || 0));
    for (let i = 1; i < list.length; i++) {
      duplicates.push({ ...list[i], reason: `watchdog duplicado de ${path.basename(script)} (PID original ${list[0].pid})` });
    }
  }
  return duplicates;
}

function findIdleClaude(procs, ancestorPids) {
  const idle = [];
  for (const p of procs) {
    if (!/^claude\.exe$/i.test(p.name)) continue;
    if (isWhitelisted(p, ancestorPids).wl) continue;
    const age = ageMinutes(p);
    if (age === null || age <= TH.claudeIdleMin) continue;
    idle.push({ ...p, reason: `claude.exe vivo hace ${age.toFixed(0)} min (>${TH.claudeIdleMin})` });
  }
  return idle;
}

function findIdleNodeHooks(procs, ancestorPids) {
  const idle = [];
  for (const p of procs) {
    if (!/^node\.exe$/i.test(p.name)) continue;
    if (isWhitelisted(p, ancestorPids).wl) continue;
    if (!/[\\/]\.claude[\\/]hooks[\\/]/i.test(p.cmd)) continue;
    const age = ageMinutes(p);
    if (age === null || age <= TH.nodeHookIdleMin) continue;
    const m = p.cmd.match(/[\\/]\.claude[\\/]hooks[\\/]([^\s"]+)/i);
    const script = m ? m[1] : 'hook';
    idle.push({ ...p, reason: `${script} vivo hace ${age.toFixed(0)} min (>${TH.nodeHookIdleMin})` });
  }
  return idle;
}

function findStaleSessions() {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  const stale = [];
  const now = Date.now();
  const cutoff = TH.sessionDoneAgeHours * 3600000;
  for (const f of fs.readdirSync(SESSIONS_DIR)) {
    if (!f.endsWith('.json')) continue;
    const fp = path.join(SESSIONS_DIR, f);
    try {
      const s = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (s.status !== 'done') continue;
      const ts = new Date(s.last_activity_ts || s.started_ts).getTime();
      const age = now - ts;
      if (age > cutoff) {
        const sizeBytes = fs.statSync(fp).size;
        stale.push({ file: fp, name: f, ageH: (age / 3600000).toFixed(1), sizeBytes });
      }
    } catch {}
  }
  return stale;
}

function findDeadLocks(procs) {
  const pidsAlive = new Set(procs.map(p => p.pid));
  const dead = [];
  const candidates = [
    { file: TG_LOCK, kind: 'lock' },
    { file: REPORTER_PID, kind: 'pid' },
  ];
  for (const c of candidates) {
    if (!fs.existsSync(c.file)) continue;
    try {
      const content = fs.readFileSync(c.file, 'utf8').trim();
      const pid = parseInt(content, 10) || parseInt(content.split('\n')[0], 10);
      if (!pid) {
        dead.push({ file: c.file, pid: null, kind: c.kind, reason: 'lock sin PID parseable' });
        continue;
      }
      if (!pidsAlive.has(pid)) {
        dead.push({ file: c.file, pid, kind: c.kind, reason: `PID ${pid} muerto` });
      }
    } catch {}
  }
  if (fs.existsSync(SPRINT_PIDS)) {
    try {
      const data = JSON.parse(fs.readFileSync(SPRINT_PIDS, 'utf8'));
      const deadKeys = [];
      for (const [key, pid] of Object.entries(data)) {
        if (typeof pid === 'number' && !pidsAlive.has(pid)) deadKeys.push({ key, pid });
      }
      if (deadKeys.length > 0) {
        dead.push({ file: SPRINT_PIDS, kind: 'sprint-pids', entries: deadKeys, reason: `${deadKeys.length} PIDs muertos` });
      }
    } catch {}
  }
  return dead;
}

function findOversizedLogs() {
  const oversized = [];
  if (fs.existsSync(HOOK_DEBUG_LOG)) {
    try {
      const content = fs.readFileSync(HOOK_DEBUG_LOG, 'utf8');
      const lines = content.split('\n');
      if (lines.length > TH.hookLogMaxLines) {
        oversized.push({
          file: HOOK_DEBUG_LOG, kind: 'hook-debug',
          current: lines.length, target: TH.hookLogMaxLines,
          sizeBytes: Buffer.byteLength(content, 'utf8'),
        });
      }
    } catch {}
  }
  if (fs.existsSync(ACTIVITY_LOG)) {
    try {
      const content = fs.readFileSync(ACTIVITY_LOG, 'utf8');
      const lines = content.trim().split('\n').filter(l => l.trim());
      if (lines.length > TH.activityLogMaxEntries) {
        oversized.push({
          file: ACTIVITY_LOG, kind: 'activity-log',
          current: lines.length, target: TH.activityLogMaxEntries,
          sizeBytes: Buffer.byteLength(content, 'utf8'),
        });
      }
    } catch {}
  }
  return oversized;
}

function findStaleQAArtifacts() {
  const artifacts = [];
  if (fs.existsSync(QA_BACKEND_LOG)) {
    try {
      const stat = fs.statSync(QA_BACKEND_LOG);
      artifacts.push({ file: QA_BACKEND_LOG, kind: 'backend-log', sizeBytes: stat.size });
    } catch {}
  }
  if (fs.existsSync(QA_RECORDINGS)) {
    try {
      let total = 0;
      let count = 0;
      for (const f of fs.readdirSync(QA_RECORDINGS)) {
        const fp = path.join(QA_RECORDINGS, f);
        try {
          const stat = fs.statSync(fp);
          if (stat.isFile()) { total += stat.size; count++; }
        } catch {}
      }
      if (count > 0) {
        artifacts.push({ file: QA_RECORDINGS, kind: 'recordings', count, sizeBytes: total });
      }
    } catch {}
  }
  return artifacts;
}

function findInconsistentAgents(procs) {
  const issues = [];
  const registry = readJson(path.join(HOOKS_DIR, 'agent-registry.json'));
  if (!registry || typeof registry !== 'object') return issues;
  const claudePids = new Set(procs.filter(p => /^claude\.exe$/i.test(p.name)).map(p => p.pid));
  for (const [agentId, info] of Object.entries(registry)) {
    if (!info || typeof info !== 'object') continue;
    if (info.status === 'completed' || info.status === 'done') continue;
    if (info.pid && !claudePids.has(info.pid)) {
      issues.push({ agentId, pid: info.pid, status: info.status, reason: 'PID no encontrado entre claude.exe vivos' });
    }
  }
  return issues;
}

function findEnvIssues() {
  const issues = [];
  try {
    const javaHome = process.env.JAVA_HOME || '/c/Users/Administrator/.jdks/temurin-21.0.7';
    if (!fs.existsSync(javaHome.replace(/\//g, path.sep))) {
      issues.push({ kind: 'java', detail: `JAVA_HOME no existe: ${javaHome}` });
    }
  } catch {}
  try {
    if (!fs.existsSync(GH_BIN)) {
      issues.push({ kind: 'gh', detail: `gh CLI no existe: ${GH_BIN}` });
    }
  } catch {}
  try {
    const out = execSync(`powershell -NoProfile -Command "(Get-PSDrive C).Free"`, {
      encoding: 'utf8', timeout: 5000, windowsHide: true,
    }).trim();
    const freeBytes = parseInt(out, 10) || 0;
    const freeGB = freeBytes / (1024 ** 3);
    if (freeGB < 5) {
      issues.push({ kind: 'disk', detail: `disco C: con ${freeGB.toFixed(1)} GB libres (<5)` });
    }
  } catch {}
  return issues;
}

// -----------------------------------------------------------------------------
// Killers (acciones)
// -----------------------------------------------------------------------------

function trimLog(filepath, maxLines, isJsonl) {
  try {
    const content = fs.readFileSync(filepath, 'utf8');
    const lines = isJsonl ? content.trim().split('\n').filter(l => l.trim()) : content.split('\n');
    if (lines.length <= maxLines) return { trimmed: false, before: lines.length, after: lines.length };
    const trimmed = lines.slice(-maxLines).join('\n') + (isJsonl ? '\n' : '');
    fs.writeFileSync(filepath, trimmed);
    return { trimmed: true, before: lines.length, after: maxLines };
  } catch (e) {
    return { trimmed: false, error: e.message.slice(0, 80) };
  }
}

function removeFileSafe(filepath) {
  try {
    if (PROTECTED_FILES.has(path.basename(filepath))) return false;
    fs.unlinkSync(filepath);
    return true;
  } catch {
    return false;
  }
}

function removeDirContents(dir) {
  let count = 0;
  let bytes = 0;
  if (!fs.existsSync(dir)) return { count, bytes };
  for (const f of fs.readdirSync(dir)) {
    const fp = path.join(dir, f);
    try {
      const stat = fs.statSync(fp);
      if (stat.isFile()) {
        bytes += stat.size;
        fs.unlinkSync(fp);
        count++;
      }
    } catch {}
  }
  return { count, bytes };
}

function pruneSprintPids(procs) {
  if (!fs.existsSync(SPRINT_PIDS)) return { removed: 0, alive: 0 };
  try {
    const pidsAlive = new Set(procs.map(p => p.pid));
    const data = JSON.parse(fs.readFileSync(SPRINT_PIDS, 'utf8'));
    const alive = {};
    let removed = 0;
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === 'number' && pidsAlive.has(v)) alive[k] = v;
      else removed++;
    }
    fs.writeFileSync(SPRINT_PIDS, JSON.stringify(alive, null, 2));
    return { removed, alive: Object.keys(alive).length };
  } catch {
    return { removed: 0, alive: 0 };
  }
}

// -----------------------------------------------------------------------------
// Orquestación
// -----------------------------------------------------------------------------

function run(opts = {}) {
  const dryRun = opts.dryRun === true;
  const cats = opts.categories instanceof Set
    ? opts.categories
    : new Set(opts.categories || ['processes', 'worktrees', 'sessions', 'locks', 'logs', 'qa', 'agents', 'env']);
  const deep = opts.deep === true;

  const procs = wmicProcesses();
  const myPid = process.pid;
  const myPpid = process.ppid || 0;
  // Calcular cadena de ancestros (incluye claude.exe / terminal / IDE que orquesta esta sesión).
  // Esto previene que ghostbusters mate a quien lo está corriendo, sin importar
  // cuán arriba en el árbol esté el claude.exe (node ← bash ← claude.exe).
  const ancestorPids = ancestorPidsOf(procs, myPid, myPpid);

  const report = {
    timestamp: new Date().toISOString(),
    dryRun,
    categories: [...cats],
    zombies: [],
    emulators: [],
    bashOrphans: [],
    extBotZombies: [],
    duplicateWatchdogs: [],
    idleClaude: [],
    idleNodeHooks: [],
    worktrees: [],
    sessions: [],
    locks: [],
    logs: [],
    qaArtifacts: [],
    agentInconsistencies: [],
    envIssues: [],
    ramFreedBytes: 0,
    diskFreedBytes: 0,
  };

  if (cats.has('processes')) {
    const zombies = findGradleZombies(procs);
    const phantomEmus = findPhantomEmulators(procs);
    const bashOrphans = findBashTailOrphans(procs, ancestorPids);
    const extBots = findExtBotZombies(procs, ancestorPids);
    const dupWd = findDuplicateWatchdogs(procs);
    const idleC = findIdleClaude(procs, ancestorPids);
    const idleNH = findIdleNodeHooks(procs, ancestorPids);

    function killAndPush(arr, target) {
      for (const p of arr) {
        const ok = dryRun ? false : killPid(p.pid);
        target.push({ pid: p.pid, name: p.name, rssBytes: p.rssBytes, reason: p.reason, killed: ok });
        if (ok) report.ramFreedBytes += p.rssBytes;
      }
    }
    killAndPush(zombies, report.zombies);
    killAndPush(phantomEmus, report.emulators);
    killAndPush(bashOrphans, report.bashOrphans);
    killAndPush(extBots, report.extBotZombies);
    killAndPush(dupWd, report.duplicateWatchdogs);
    killAndPush(idleC, report.idleClaude);
    killAndPush(idleNH, report.idleNodeHooks);
  }

  if (cats.has('worktrees')) {
    const abandoned = findAbandonedWorktrees(procs);
    for (const w of abandoned) {
      const size = dirSizeBytes(w.path);
      const entry = { path: w.path, branch: w.branch, issue: w.issue, reason: w.reason, diskBytes: size };
      if (w.skip) {
        entry.skipped = true;
        entry.skipReason = w.skipReason;
        entry.removed = false;
      } else {
        const ok = dryRun ? false : removeWorktree(w.path);
        entry.removed = ok;
        if (ok) report.diskFreedBytes += size;
      }
      report.worktrees.push(entry);
    }
  }

  if (cats.has('sessions')) {
    const stale = findStaleSessions();
    for (const s of stale) {
      const ok = dryRun ? false : removeFileSafe(s.file);
      report.sessions.push({ ...s, removed: ok });
      if (ok) report.diskFreedBytes += s.sizeBytes;
    }
  }

  if (cats.has('locks')) {
    const dead = findDeadLocks(procs);
    for (const d of dead) {
      if (d.kind === 'sprint-pids') {
        const r = dryRun ? { removed: d.entries.length, alive: -1 } : pruneSprintPids(procs);
        report.locks.push({ ...d, pruned: r.removed, aliveAfter: r.alive });
      } else {
        const ok = dryRun ? false : removeFileSafe(d.file);
        report.locks.push({ ...d, removed: ok });
      }
    }
  }

  if (cats.has('logs')) {
    const oversized = findOversizedLogs();
    for (const l of oversized) {
      const isJsonl = l.kind === 'activity-log';
      const r = dryRun
        ? { trimmed: false, before: l.current, after: l.target }
        : trimLog(l.file, l.target, isJsonl);
      report.logs.push({ ...l, ...r });
    }
  }

  if (cats.has('qa')) {
    const arts = findStaleQAArtifacts();
    for (const a of arts) {
      if (a.kind === 'backend-log') {
        const ok = dryRun ? false : removeFileSafe(a.file);
        report.qaArtifacts.push({ ...a, removed: ok });
        if (ok) report.diskFreedBytes += a.sizeBytes;
      } else if (a.kind === 'recordings') {
        const r = dryRun ? { count: 0, bytes: 0 } : removeDirContents(a.file);
        report.qaArtifacts.push({ ...a, removed: r.count, removedBytes: r.bytes });
        report.diskFreedBytes += r.bytes;
      }
    }
  }

  if (cats.has('agents')) {
    report.agentInconsistencies = findInconsistentAgents(procs);
  }

  if (cats.has('env')) {
    report.envIssues = findEnvIssues();
  }

  if (deep && !dryRun) {
    const deepDirs = [
      path.join(MAIN_ROOT, '.gradle'),
      path.join(HOOKS_DIR, 'node_modules'),
    ];
    report.deepCleaned = [];
    for (const d of deepDirs) {
      if (!fs.existsSync(d)) continue;
      const size = dirSizeBytes(d);
      try {
        fs.rmSync(d, { recursive: true, force: true });
        report.deepCleaned.push({ dir: d, sizeBytes: size, removed: true });
        report.diskFreedBytes += size;
      } catch (e) {
        report.deepCleaned.push({ dir: d, sizeBytes: size, removed: false, error: e.message.slice(0, 80) });
      }
    }
  }

  return report;
}

// -----------------------------------------------------------------------------
// Formato del reporte
// -----------------------------------------------------------------------------

function fmtReport(r) {
  const lines = [];
  const dryTag = r.dryRun ? ' [DRY-RUN]' : '';
  lines.push(`👻 *Ghostbusters*${dryTag} — ${r.timestamp.slice(0, 19).replace('T', ' ')}`);
  lines.push('');

  const procCounts =
    r.zombies.length + r.emulators.length + r.bashOrphans.length +
    r.extBotZombies.length + r.duplicateWatchdogs.length +
    r.idleClaude.length + r.idleNodeHooks.length;
  const otherCounts =
    r.worktrees.length + r.sessions.length + r.locks.length +
    r.logs.length + r.qaArtifacts.length +
    r.agentInconsistencies.length + r.envIssues.length;

  if (procCounts === 0 && otherCounts === 0) {
    lines.push('✅ Sistema sano. No hay fantasmas.');
    return lines.join('\n');
  }

  // Trunca a 10 items con un "...y N más" para no romper el dashboard ante
  // categorías masivas (ej: 1000+ sesiones huérfanas viejas).
  const MAX_PER_SECTION = 10;
  function section(title, items, fmtItem) {
    if (items.length === 0) return;
    lines.push(`*${title}:* ${items.length}`);
    const shown = items.slice(0, MAX_PER_SECTION);
    for (const it of shown) lines.push('  ' + fmtItem(it));
    if (items.length > MAX_PER_SECTION) {
      lines.push(`  …y ${items.length - MAX_PER_SECTION} más`);
    }
    lines.push('');
  }

  const procIcon = (killed) => r.dryRun ? '🔍' : (killed ? '☠️' : '⚠️');

  section('Gradle/Kotlin zombies', r.zombies, (z) =>
    `${procIcon(z.killed)} PID ${z.pid} ${z.name} (${fmtMB(z.rssBytes)} MB) — ${z.reason}`);
  section('Emuladores fantasma', r.emulators, (e) =>
    `${procIcon(e.killed)} PID ${e.pid} ${e.name} (${fmtMB(e.rssBytes)} MB) — ${e.reason}`);
  section('Bash tail -f huérfanos', r.bashOrphans, (b) =>
    `${procIcon(b.killed)} PID ${b.pid} bash (${fmtMB(b.rssBytes)} MB) — ${b.reason}`);
  section('Scripts externos zombis', r.extBotZombies, (n) =>
    `${procIcon(n.killed)} PID ${n.pid} node (${fmtMB(n.rssBytes)} MB) — ${n.reason}`);
  section('Watchdogs duplicados', r.duplicateWatchdogs, (w) =>
    `${procIcon(w.killed)} PID ${w.pid} (${fmtMB(w.rssBytes)} MB) — ${w.reason}`);
  section('Claude.exe inactivos', r.idleClaude, (c) =>
    `${procIcon(c.killed)} PID ${c.pid} (${fmtMB(c.rssBytes)} MB) — ${c.reason}`);
  section('Node.exe en hooks idle', r.idleNodeHooks, (n) =>
    `${procIcon(n.killed)} PID ${n.pid} (${fmtMB(n.rssBytes)} MB) — ${n.reason}`);

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
        const icon = r.dryRun ? '🔍' : (w.removed ? '🗑' : '⚠️');
        lines.push(`  ${icon} ${name}${size} — ${w.reason}`);
      }
    }
    lines.push('');
  }

  section('Sesiones done viejas', r.sessions, (s) => {
    const icon = r.dryRun ? '🔍' : (s.removed ? '🗑' : '⚠️');
    return `${icon} ${s.name} (${fmtMB(s.sizeBytes)} MB, ${s.ageH}h)`;
  });

  section('Locks stale', r.locks, (l) => {
    const icon = r.dryRun ? '🔍' : '🗑';
    if (l.kind === 'sprint-pids') return `${icon} ${path.basename(l.file)}: ${l.pruned} PIDs muertos`;
    return `${icon} ${path.basename(l.file)} — ${l.reason}`;
  });

  section('Logs oversized', r.logs, (l) => {
    const icon = r.dryRun ? '🔍' : (l.trimmed ? '✂️' : '⚠️');
    return `${icon} ${path.basename(l.file)}: ${l.before} → ${l.after} ${l.kind === 'activity-log' ? 'entradas' : 'líneas'}`;
  });

  section('QA artifacts', r.qaArtifacts, (a) => {
    const icon = r.dryRun ? '🔍' : '🗑';
    if (a.kind === 'backend-log') return `${icon} ${path.basename(a.file)} (${fmtMB(a.sizeBytes)} MB)`;
    return `${icon} qa/recordings: ${a.count} archivos (${fmtMB(a.sizeBytes)} MB)`;
  });

  section('Inconsistencias agentes', r.agentInconsistencies, (i) =>
    `⚠️ ${i.agentId} (PID ${i.pid}, status ${i.status}) — ${i.reason}`);

  section('Issues de entorno', r.envIssues, (e) =>
    `⚠️ ${e.kind}: ${e.detail}`);

  if (r.deepCleaned && r.deepCleaned.length > 0) {
    section('Deep clean', r.deepCleaned, (d) => {
      const icon = d.removed ? '🗑' : '⚠️';
      return `${icon} ${d.dir} (${fmtGB(d.sizeBytes)} GB)`;
    });
  }

  const ramGB = r.ramFreedBytes / (1024 ** 3);
  const diskGB = r.diskFreedBytes / (1024 ** 3);
  if (r.dryRun) {
    lines.push(`*Liberación potencial:* ${diskGB.toFixed(2)} GB disco · ${ramGB.toFixed(2)} GB RAM`);
    lines.push(`Ejecutá \`/ghostbusters --run\` para aplicar.`);
  } else {
    lines.push(`*Total liberado:* ${diskGB.toFixed(2)} GB disco · ${ramGB.toFixed(2)} GB RAM`);
  }

  return lines.join('\n');
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

if (require.main === module) {
  const opts = parseCliArgs(process.argv.slice(2));
  if (opts.json) LOG_QUIET = true;
  const report = run({
    dryRun: opts.dryRun,
    categories: opts.categories,
    deep: opts.deep,
  });
  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2));
  } else {
    console.log(fmtReport(report));
  }
}

module.exports = { run, fmtReport, parseCliArgs, isWhitelisted, WHITELIST, TH };

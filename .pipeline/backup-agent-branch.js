// =============================================================================
// backup-agent-branch.js — Helper para crear tags de backup antes de operaciones
// destructivas (reset/merge) sobre ramas `agent/*`.
//
// Criterio CA-2 del issue #2405:
//   - Si hay commits locales no pusheados, crear tag local
//     `backup/agent-<issue>-<skill>-<YYYYMMDDTHHMMSSZ>-<rand4>`
//   - Loggear a `.pipeline/logs/audit-<issue>.log` con prefijo `[BACKUP]`,
//     SHA del tip, y el comando de reverso `git reset --hard <tag>`.
//   - Tags son LOCALES (nunca `git push --tags` implícito).
//   - Colisión de nombre → reintento con nuevo rand4 (no `--force`).
//
// Uso programático:
//   const { backupAgentBranch } = require('./backup-agent-branch');
//   const result = backupAgentBranch({ issue: 2405, skill: 'pipeline-dev', cwd: '.' });
//   if (result.ok && result.created) console.log(`Tag creado: ${result.tag}`);
//
// Uso CLI:
//   node .pipeline/backup-agent-branch.js --issue 2405 --skill pipeline-dev [--cwd path]
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const PIPELINE = path.resolve(__dirname);
const LOG_DIR = path.join(PIPELINE, 'logs');

/**
 * ISO-8601 UTC compacto sin puntuación — seguro como sufijo de tag git.
 * Ej: 20260421T210345Z
 */
function timestampUtcCompact(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/**
 * Devuelve `count` hex chars pseudo-aleatorios (seguro suficiente para
 * disambiguar tags creados en el mismo segundo).
 */
function randomHex(count = 4) {
  const chars = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < count; i++) out += chars[Math.floor(Math.random() * 16)];
  return out;
}

/**
 * Ejecuta git con captura de stdout/stderr. Lanza error con mensaje claro si
 * el exit code != 0.
 *
 * Usamos spawnSync en vez de execSync para evitar problemas de quoting.
 */
function git(args, cwd) {
  const res = spawnSync('git', args, {
    cwd: cwd || process.cwd(),
    encoding: 'utf8',
    windowsHide: true,
  });
  if (res.status !== 0) {
    const stderr = (res.stderr || '').trim();
    const err = new Error(`git ${args.join(' ')} failed (exit ${res.status}): ${stderr}`);
    err.stdout = res.stdout;
    err.stderr = res.stderr;
    err.status = res.status;
    throw err;
  }
  return (res.stdout || '').trim();
}

/**
 * Detecta la rama actual. Devuelve null si HEAD está detached.
 */
function currentBranch(cwd) {
  try {
    const out = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    if (!out || out === 'HEAD') return null;
    return out;
  } catch {
    return null;
  }
}

/**
 * Cuenta commits locales NO pusheados al upstream. Si el upstream no existe,
 * compara contra origin/main (fallback conservador).
 *
 * @returns {{ count: number, upstreamUsed: string|null }}
 */
function countUnpushedCommits(branch, cwd) {
  // 1) Intentar con upstream configurado
  try {
    const upstream = git(['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], cwd);
    const list = git(['rev-list', `${upstream}..HEAD`], cwd);
    const count = list ? list.split('\n').filter(Boolean).length : 0;
    return { count, upstreamUsed: upstream };
  } catch {
    // 2) Fallback: compararse contra origin/main
    try {
      const list = git(['rev-list', 'origin/main..HEAD'], cwd);
      const count = list ? list.split('\n').filter(Boolean).length : 0;
      return { count, upstreamUsed: 'origin/main' };
    } catch {
      // Ni upstream ni origin/main disponibles — asumimos hay commits
      // (posición conservadora: preferimos crear tag y gastar refs antes que
      // perder commits silenciosamente).
      return { count: 1, upstreamUsed: null };
    }
  }
}

/**
 * ¿Existe un tag con este nombre?
 */
function tagExists(name, cwd) {
  try {
    const out = git(['tag', '-l', name], cwd);
    return out.trim() === name;
  } catch {
    return false;
  }
}

/**
 * Append-only al audit log del issue. Crea el directorio si no existe.
 */
function writeAudit(issue, line) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, `audit-${issue}.log`);
    // Usamos appendFileSync (flag 'a' implícito) para evitar truncar.
    fs.appendFileSync(file, line + '\n', { encoding: 'utf8' });
  } catch (e) {
    // No podemos tirar acá — el audit es best-effort. El caller sigue.
    try { process.stderr.write(`[backup-agent-branch] audit write failed: ${e.message}\n`); } catch {}
  }
}

/**
 * Crea un tag de backup si hay commits locales no pusheados en la rama actual.
 *
 * @param {object} opts
 * @param {number|string} opts.issue — número del issue
 * @param {string} opts.skill — skill responsable (pipeline-dev, backend-dev, etc.)
 * @param {string} [opts.cwd] — worktree donde operar (default CWD)
 * @param {string} [opts.forceBranch] — override de detección de rama (tests)
 * @returns {{ ok: boolean, created: boolean, tag?: string, tip?: string, branch?: string, reason?: string, unpushedCount?: number }}
 */
function backupAgentBranch(opts) {
  const issue = String(opts.issue || '').trim();
  const skill = String(opts.skill || '').trim();
  const cwd = opts.cwd || process.cwd();

  if (!issue || !skill) {
    return { ok: false, created: false, reason: 'missing issue or skill' };
  }

  // 1) Determinar rama
  const branch = opts.forceBranch || currentBranch(cwd);
  if (!branch) {
    return { ok: true, created: false, reason: 'detached-head' };
  }
  if (!branch.startsWith('agent/')) {
    // Sólo protegemos ramas agent/*. Otras ramas (main, feature/*) no aplican.
    return { ok: true, created: false, reason: 'not-agent-branch', branch };
  }

  // 2) Contar commits no pusheados
  let unpushed;
  try {
    unpushed = countUnpushedCommits(branch, cwd);
  } catch (e) {
    return { ok: false, created: false, reason: `cannot-count-unpushed: ${e.message}`, branch };
  }
  if (unpushed.count === 0) {
    return { ok: true, created: false, reason: 'no-unpushed-commits', branch };
  }

  // 3) Resolver SHA del tip
  let tip;
  try {
    tip = git(['rev-parse', '--short=8', 'HEAD'], cwd);
  } catch (e) {
    return { ok: false, created: false, reason: `cannot-resolve-tip: ${e.message}`, branch };
  }

  // 4) Construir nombre de tag + reintento por colisión (hasta 5 intentos)
  const timestamp = timestampUtcCompact();
  let tag = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = `backup/agent-${issue}-${skill}-${timestamp}-${randomHex(4)}`;
    if (!tagExists(candidate, cwd)) {
      tag = candidate;
      break;
    }
  }
  if (!tag) {
    return { ok: false, created: false, reason: 'could-not-find-unique-tag-name', branch, tip };
  }

  // 5) Crear tag LOCAL (sin push). Nunca --force; si falla reportamos.
  try {
    git(['tag', tag, 'HEAD'], cwd);
  } catch (e) {
    return { ok: false, created: false, reason: `tag-create-failed: ${e.message}`, branch, tip };
  }

  // 6) Audit log
  const now = new Date().toISOString();
  const auditLine = [
    `${now} [BACKUP] issue=${issue} skill=${skill} branch=${branch}`,
    `  tag=${tag}`,
    `  tip=${tip} unpushed=${unpushed.count} upstream=${unpushed.upstreamUsed || 'none'}`,
    `  revert: git reset --hard ${tag}`,
  ].join('\n');
  writeAudit(issue, auditLine);

  return {
    ok: true,
    created: true,
    tag,
    tip,
    branch,
    unpushedCount: unpushed.count,
  };
}

/**
 * Barre todos los tags `backup/*` y borra los que superan TTL (default 30 días).
 *
 * @param {object} [opts]
 * @param {number} [opts.ttlDays=30] — edad máxima en días
 * @param {boolean} [opts.dryRun=false] — si true, sólo reporta, no borra
 * @param {string} [opts.cwd]
 * @returns {{ scanned: number, expired: Array<{ tag: string, ageDays: number }>, deleted: string[] }}
 */
function cleanBackupTags(opts = {}) {
  const ttlDays = opts.ttlDays === undefined ? 30 : opts.ttlDays;
  const dryRun = !!opts.dryRun;
  const cwd = opts.cwd || process.cwd();

  const ttlSeconds = ttlDays * 24 * 60 * 60;
  const nowSec = Math.floor(Date.now() / 1000);

  let rawList;
  try {
    rawList = git([
      'for-each-ref',
      '--format=%(refname:short)|%(creatordate:unix)',
      'refs/tags/backup/',
    ], cwd);
  } catch (e) {
    return {
      scanned: 0,
      expired: [],
      deleted: [],
      error: `for-each-ref failed: ${e.message}`,
    };
  }

  const lines = (rawList || '').split('\n').filter(Boolean);
  const expired = [];
  const deleted = [];

  for (const line of lines) {
    const [tag, createdAt] = line.split('|');
    if (!tag || !createdAt) continue;
    const ageSec = nowSec - parseInt(createdAt, 10);
    if (!Number.isFinite(ageSec) || ageSec < 0) continue;
    if (ageSec <= ttlSeconds) continue;
    const ageDays = Math.floor(ageSec / (24 * 60 * 60));
    expired.push({ tag, ageDays });
    if (dryRun) continue;
    try {
      git(['tag', '-d', tag], cwd);
      deleted.push(tag);
      // Audit (issue desconocido si no se puede parsear — usar 'cleanup')
      const issueMatch = tag.match(/^backup\/agent-(\d+)-/);
      const issueFromTag = issueMatch ? issueMatch[1] : 'cleanup';
      writeAudit(
        issueFromTag,
        `${new Date().toISOString()} [CLEANUP] tag=${tag} age=${ageDays}d`,
      );
    } catch (e) {
      try { process.stderr.write(`[backup-agent-branch] failed to delete ${tag}: ${e.message}\n`); } catch {}
    }
  }

  return {
    scanned: lines.length,
    expired,
    deleted,
  };
}

// =============================================================================
// CLI
// =============================================================================

function parseCliArgs(argv) {
  const opts = { issue: null, skill: null, cwd: undefined, clean: false, dryRun: false, ttlDays: 30 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--issue') opts.issue = argv[++i];
    else if (a === '--skill') opts.skill = argv[++i];
    else if (a === '--cwd') opts.cwd = argv[++i];
    else if (a === '--clean') opts.clean = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--ttl-days') opts.ttlDays = parseInt(argv[++i], 10);
  }
  return opts;
}

function mainCli() {
  const opts = parseCliArgs(process.argv.slice(2));

  if (opts.clean) {
    const result = cleanBackupTags({ ttlDays: opts.ttlDays, dryRun: opts.dryRun, cwd: opts.cwd });
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.error ? 1 : 0);
  }

  if (!opts.issue || !opts.skill) {
    console.error('Usage: backup-agent-branch.js --issue <N> --skill <skill> [--cwd path]');
    console.error('       backup-agent-branch.js --clean [--dry-run] [--ttl-days 30]');
    process.exit(2);
  }

  const result = backupAgentBranch({ issue: opts.issue, skill: opts.skill, cwd: opts.cwd });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

if (require.main === module) {
  mainCli();
}

module.exports = {
  backupAgentBranch,
  cleanBackupTags,
  // testable internals
  __forTestsOnly__: {
    timestampUtcCompact,
    randomHex,
    currentBranch,
    countUnpushedCommits,
    tagExists,
    writeAudit,
  },
};

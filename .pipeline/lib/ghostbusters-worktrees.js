// =============================================================================
// ghostbusters-worktrees.js — Lógica de borrado seguro de worktrees (#3943)
//
// Extraída de ghostbusters.js para que el guard anti-suicidio, el criterio
// compuesto de abandono y la migración de injection sean testeables en
// aislamiento (patrón de inyección `spawnImpl` de worktree-resolver.js).
//
// Requisitos de seguridad cubiertos (issue #3943, análisis security):
//   RS-1 — Confinamiento de paths: fs.realpathSync() + prefijo base obligatorio.
//          Guard duro anti-suicidio: jamás operar sobre el repo principal,
//          un ancestro suyo, o un path fuera de `<repo>.<sufijo>`.
//   RS-2 — Sin shell interpolado: TODO git va por spawnSync('git', [args]).
//          Los branch names derivan de títulos de issues (input semi-externo).
//   RS-3 — Criterio compuesto: seguridad (todas) AND abandono (al menos una).
//   RS-4 — Audit log JSONL append-only + dry-run + cap por corrida.
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { remoteBranchExists } = require('./worktree-resolver');

const MAIN_REPO = 'C:/Workspaces/Intrale/platform';
const DEFAULT_AGE_THRESHOLD_DAYS = 30;
const DEFAULT_CAP = 5;
const AUDIT_FILE = path.join(__dirname, '..', 'audit', 'ghostbusters-worktrees.jsonl');

function normPath(p) {
  return String(p || '').replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
}

// -----------------------------------------------------------------------------
// RS-1 — Guard anti-suicidio. Devuelve { forbidden, reason }.
// Se ejecuta ANTES de cualquier borrado (incluido el fallback fs.rmSync).
// Resuelve realpath para rechazar junctions/symlinks que apunten afuera.
// -----------------------------------------------------------------------------
function isForbiddenTarget(wtPath, { mainRepo = MAIN_REPO, fsImpl = fs } = {}) {
  const main = normPath(mainRepo);
  let real;
  try {
    real = normPath(fsImpl.realpathSync(wtPath));
  } catch (e) {
    // Si no podemos resolver el path real, NO borramos (conservador).
    return { forbidden: true, reason: `realpath irresoluble: ${e.message.slice(0, 80)}` };
  }
  if (real === main) {
    return { forbidden: true, reason: 'es el repo principal' };
  }
  // Ancestro del repo principal (ej: C:/Workspaces, C:/) — borrar eso se lleva todo.
  if (main.startsWith(real + '/') || real === '' || /^[a-z]:$/.test(real)) {
    return { forbidden: true, reason: 'es un ancestro del repo principal' };
  }
  // Confinamiento: solo se permiten worktrees hermanos `<repo>.<sufijo>`.
  // Esto rechaza junctions que resuelven fuera del prefijo permitido.
  if (!real.startsWith(main + '.')) {
    return { forbidden: true, reason: `fuera del prefijo permitido ${main}.*` };
  }
  return { forbidden: false };
}

// -----------------------------------------------------------------------------
// Helper git sin shell (RS-2). Devuelve { ok, stdout }.
// -----------------------------------------------------------------------------
function gitRun(args, { cwd, spawnImpl = spawnSync, timeout = 10000 } = {}) {
  const r = spawnImpl('git', args, {
    cwd, encoding: 'utf8', timeout, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  return { ok: r && r.status === 0, stdout: (r && r.stdout) ? String(r.stdout) : '' };
}

// -----------------------------------------------------------------------------
// Gate de SEGURIDAD (RS-3, todas deben cumplirse): sin cambios sin commitear
// y sin commits sin pushear. Migrado de execSync con template string a
// spawnSync con array de argumentos (RS-2): el branch name nunca toca un shell.
// -----------------------------------------------------------------------------
function isWorktreeSafeToDelete(wtPath, branch, { spawnImpl = spawnSync } = {}) {
  try {
    const st = gitRun(['status', '--porcelain'], { cwd: wtPath, spawnImpl });
    if (!st.ok) return { safe: false, reason: 'no pude inspeccionar git status' };
    // OJO: no hacer .trim() del output completo — comería el espacio inicial
    // del status code `XY ` de la primera línea y rompería el substring(3).
    const relevantChanges = st.stdout.split('\n').filter(l => {
      if (!l.trim()) return false;
      const filepath = l.substring(3).trim();
      return !filepath.startsWith('.claude/') && !filepath.startsWith('.claude\\');
    });
    if (relevantChanges.length > 0) {
      return { safe: false, reason: `${relevantChanges.length} archivo(s) sin commitear` };
    }

    if (branch) {
      const ahead = gitRun(['rev-list', '--count', `origin/${branch}..HEAD`], { cwd: wtPath, spawnImpl });
      if (ahead.ok) {
        const n = parseInt(ahead.stdout.trim(), 10) || 0;
        if (n > 0) return { safe: false, reason: `${n} commit(s) ahead de origin/${branch}` };
      } else {
        // La rama no existe en remoto → comparar contra origin/main.
        const fromMain = gitRun(['rev-list', '--count', 'origin/main..HEAD'], { cwd: wtPath, spawnImpl });
        if (fromMain.ok) {
          const n = parseInt(fromMain.stdout.trim(), 10) || 0;
          if (n > 0) return { safe: false, reason: `rama no pusheada con ${n} commit(s) sobre main` };
        }
      }
    }
    return { safe: true };
  } catch (e) {
    return { safe: false, reason: `no pude inspeccionar: ${e.message.slice(0, 60)}` };
  }
}

// -----------------------------------------------------------------------------
// Criterio de ABANDONO (RS-3, al menos una):
//   a. rama inexistente en remoto (reusa remoteBranchExists de worktree-resolver)
//   b. antigüedad del worktree > umbral configurable (default 30 días)
// Devuelve { abandoned, reason }.
// -----------------------------------------------------------------------------
function checkAbandonment(wtPath, branch, {
  mainRepo = MAIN_REPO,
  spawnImpl = spawnSync,
  fsImpl = fs,
  ageThresholdDays = DEFAULT_AGE_THRESHOLD_DAYS,
  nowMs = Date.now(),
} = {}) {
  // (a) rama inexistente en remoto
  if (branch) {
    let exists = true;
    try {
      exists = remoteBranchExists(mainRepo, branch, { spawnImpl });
    } catch { exists = true; /* sin red: conservador, no declarar abandono */ }
    if (!exists) return { abandoned: true, reason: `rama ${branch} inexistente en remoto` };
  } else {
    // Worktree en detached HEAD sin rama → no hay rama que lo respalde.
    return { abandoned: true, reason: 'worktree sin rama (detached HEAD)' };
  }

  // (b) antigüedad > umbral (creación del directorio; fallback mtime)
  try {
    const stat = fsImpl.statSync(wtPath);
    const created = (stat.birthtimeMs && stat.birthtimeMs > 0) ? stat.birthtimeMs : stat.mtimeMs;
    const ageDays = (nowMs - created) / (24 * 60 * 60 * 1000);
    if (ageDays > ageThresholdDays) {
      return { abandoned: true, reason: `antigüedad ${Math.floor(ageDays)}d > umbral ${ageThresholdDays}d` };
    }
  } catch { /* stat falló: no podemos afirmar antigüedad */ }

  return { abandoned: false, reason: `rama viva en remoto y antigüedad ≤ ${ageThresholdDays}d` };
}

// -----------------------------------------------------------------------------
// Borrado físico. GUARD ANTI-SUICIDIO PRIMERO (RS-1) — cubre AMBOS call sites:
// `git worktree remove` y el fallback fs.rmSync (el más peligroso).
// Todo git via spawnSync con array de args (RS-2).
// -----------------------------------------------------------------------------
function removeWorktree(wtPath, {
  mainRepo = MAIN_REPO,
  spawnImpl = spawnSync,
  fsImpl = fs,
  logger = () => {},
} = {}) {
  const guard = isForbiddenTarget(wtPath, { mainRepo, fsImpl });
  if (guard.forbidden) {
    logger(`🛑 ABORT removeWorktree(${wtPath}): ${guard.reason}`);
    return false;
  }
  try {
    // Desmontar junction .claude si existe (precedente #2867: rmdir solo
    // desmonta el reparse point, nunca sigue el contenido).
    const claudeLink = path.join(wtPath, '.claude');
    if (fsImpl.existsSync(claudeLink)) {
      try {
        spawnImpl('cmd', ['/c', 'rmdir', claudeLink.replace(/\//g, '\\')], {
          timeout: 5000, windowsHide: true, stdio: 'ignore',
        });
      } catch {}
    }
    spawnImpl('git', ['worktree', 'remove', wtPath, '--force'], {
      cwd: mainRepo, timeout: 30000, windowsHide: true, stdio: 'ignore',
    });
    if (fsImpl.existsSync(wtPath)) {
      // Fallback: re-validar guard inmediatamente antes del rmSync recursivo.
      const reguard = isForbiddenTarget(wtPath, { mainRepo, fsImpl });
      if (reguard.forbidden) {
        logger(`🛑 ABORT rmSync(${wtPath}): ${reguard.reason}`);
        return false;
      }
      try { fsImpl.rmSync(wtPath, { recursive: true, force: true }); } catch {}
    }
    return !fsImpl.existsSync(wtPath);
  } catch (e) {
    logger(`⚠️ no pude remover ${wtPath}: ${e.message.slice(0, 120)}`);
    return false;
  }
}

// -----------------------------------------------------------------------------
// RS-4 — Audit log JSONL append-only (patrón lib/handoff.js). Best-effort:
// nunca rompe la corrida por un fallo de auditoría.
// -----------------------------------------------------------------------------
function appendAudit(entry, { auditFile = AUDIT_FILE, fsImpl = fs } = {}) {
  try {
    fsImpl.mkdirSync(path.dirname(auditFile), { recursive: true });
    fsImpl.appendFileSync(auditFile, JSON.stringify(entry) + '\n', { encoding: 'utf8', flag: 'a' });
    return true;
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// Cap por corrida (RS-4). Devuelve { selected, capped } sin mutar la entrada.
// -----------------------------------------------------------------------------
function applyCap(candidates, cap = DEFAULT_CAP) {
  const n = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : DEFAULT_CAP;
  return { selected: candidates.slice(0, n), capped: candidates.slice(n) };
}

// -----------------------------------------------------------------------------
// Sweep: procesa la lista de candidatos ya filtrados (seguridad + abandono),
// aplica cap, ejecuta borrado (o no, en dry-run) y escribe audit JSONL.
// `candidates`: [{ path, branch, issue, reason, diskBytes, skip?, skipReason? }]
// Devuelve entries con shape compatible con report.worktrees de ghostbusters.
// -----------------------------------------------------------------------------
function sweepWorktrees(candidates, {
  cap = DEFAULT_CAP,
  dryRun = true,
  removeImpl = removeWorktree,
  auditImpl = appendAudit,
  fsImpl = fs,
  nowIso = new Date().toISOString(),
  logger = () => {},
} = {}) {
  const entries = [];
  const skipped = candidates.filter(c => c.skip);
  const eligible = candidates.filter(c => !c.skip);
  const { selected, capped } = applyCap(eligible, cap);

  for (const c of skipped) {
    entries.push({ ...c, skipped: true, removed: false });
  }
  for (const c of capped) {
    entries.push({ ...c, skipped: true, skipReason: `cap de ${cap} por corrida alcanzado`, removed: false });
  }
  for (const c of selected) {
    let pathReal = c.path;
    try { pathReal = fsImpl.realpathSync(c.path).replace(/\\/g, '/'); } catch {}
    const removed = dryRun ? false : removeImpl(c.path, { fsImpl, logger });
    auditImpl({
      timestamp: nowIso,
      path_real: pathReal,
      branch: c.branch || null,
      motivo: c.reason,
      bytes_recuperados: c.diskBytes || 0,
      dry_run: dryRun,
    });
    entries.push({ ...c, skipped: false, removed });
    logger(`${dryRun ? '🔍 [dry-run]' : (removed ? '🗑' : '⚠️')} ${c.path} — ${c.reason} (${((c.diskBytes || 0) / (1024 ** 2)).toFixed(0)} MB)`);
  }
  return entries;
}

module.exports = {
  MAIN_REPO,
  DEFAULT_AGE_THRESHOLD_DAYS,
  DEFAULT_CAP,
  AUDIT_FILE,
  isForbiddenTarget,
  isWorktreeSafeToDelete,
  checkAbandonment,
  removeWorktree,
  appendAudit,
  applyCap,
  sweepWorktrees,
};

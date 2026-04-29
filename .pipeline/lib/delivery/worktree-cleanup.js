// worktree-cleanup.js — Limpieza segura de worktrees post-merge
//
// Reemplaza el Paso 6.6 del SKILL.md (markdown interpretado por LLM) con
// lógica determinística + tests. Incorpora el fix de #2867:
//
//   1. Si el worktree a limpiar es donde corre la sesión activa del CLI,
//      skipea el cleanup completo (solo prune metadata).
//   2. `.claude/` solo se desmonta con rmdir si es junction. Si es copia
//      real, se deja que `git worktree remove` se encargue (sino rmdir
//      borra todo el contenido y voltea los skills).

const path = require('path');
const fs = require('fs');
const { execSync, spawnSync } = require('child_process');

const MAIN_REPO_DEFAULT = 'C:/Workspaces/Intrale/platform';

// Compara paths reales (resuelve symlinks/junctions). Si sessionCwd está
// dentro de worktreePath, este es la sesión activa y NO debe limpiarse.
function isActiveSession(worktreePath, sessionCwd) {
  if (!worktreePath || !sessionCwd) return false;
  let wtReal, cwdReal;
  try { wtReal = fs.realpathSync(worktreePath); } catch { return false; }
  try { cwdReal = fs.realpathSync(sessionCwd); } catch { return false; }
  // Normalizar separadores y casing (Windows es case-insensitive)
  const norm = (p) => p.replace(/\\/g, '/').toLowerCase();
  const wt = norm(wtReal);
  const cwd = norm(cwdReal);
  // Igualdad exacta o cwd dentro del worktree.
  // Comparar contra `wt + '/'` evita falsos positivos por prefijo
  // (ej: cwd=/foobar, wt=/foo — el startsWith plano daría true).
  return cwd === wt || cwd.startsWith(wt + '/');
}

// Verifica si un path es un reparse point (junction o symlink) en Windows.
// Usa `fsutil reparsepoint query` que devuelve exit 0 solo para reparse points.
function isJunction(targetPath) {
  if (!fs.existsSync(targetPath)) return false;
  // En non-Windows también soporta vía lstat
  if (process.platform !== 'win32') {
    try { return fs.lstatSync(targetPath).isSymbolicLink(); } catch { return false; }
  }
  const winPath = targetPath.replace(/\//g, '\\');
  const result = spawnSync('cmd', ['/c', 'fsutil', 'reparsepoint', 'query', winPath], {
    stdio: 'pipe',
    windowsHide: true,
  });
  return result.status === 0;
}

// Desmonta `.claude/` SOLO si es junction. Si es copia real, no toca.
function dismountClaudeJunction(worktreePath, logger = () => {}) {
  const claudePath = path.join(worktreePath, '.claude');
  if (!fs.existsSync(claudePath)) {
    logger('  → .claude no existe, skip');
    return { dismounted: false, reason: 'not_present' };
  }
  if (!isJunction(claudePath)) {
    logger('  → .claude es copia real, no se toca (lo borra git worktree remove)');
    return { dismounted: false, reason: 'real_copy' };
  }
  const winPath = claudePath.replace(/\//g, '\\');
  const result = spawnSync('cmd', ['/c', 'rmdir', winPath], {
    stdio: 'pipe',
    windowsHide: true,
  });
  if (result.status === 0) {
    logger('  → .claude junction desmontado');
    return { dismounted: true };
  }
  logger(`  → falló rmdir (exit ${result.status}): ${result.stderr?.toString().trim()}`);
  return { dismounted: false, reason: 'rmdir_failed' };
}

// Ejecuta git desde el repo principal con manejo limpio de errores.
function gitInMain(args, mainRepo, opts = {}) {
  const result = spawnSync('git', ['-C', mainRepo, ...args], {
    stdio: opts.capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
    windowsHide: true,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

// Limpia un worktree después de merge. Devuelve un resultado estructurado.
async function cleanupWorktree({
  worktreePath,
  branch,
  mainRepoPath = MAIN_REPO_DEFAULT,
  sessionCwd = process.cwd(),
  logger = console.log,
}) {
  if (!worktreePath || !branch) {
    return { ok: false, error: 'missing_args', message: 'worktreePath y branch son obligatorios' };
  }

  const log = (msg) => logger(msg);

  // 0. Detección de sesión activa (fix #2867)
  if (isActiveSession(worktreePath, sessionCwd)) {
    log('⚠️ Skip cleanup: worktree es la sesión activa del CLI');
    log(`   Worktree: ${worktreePath}`);
    log(`   Session:  ${sessionCwd}`);
    log('   Branch local se conserva. Worktree quedará huérfano hasta /ghostbusters --worktrees --run manual.');
    gitInMain(['worktree', 'prune'], mainRepoPath);
    return {
      ok: true,
      skipped: true,
      reason: 'active_session',
      worktreePath,
      branch,
    };
  }

  // 1. Volver al repo principal (cambio de cwd via git -C, no process.chdir)
  log(`🧹 Limpiando worktree ${worktreePath}`);

  // 2. Desmontar .claude SOLO si es junction
  const claudeResult = dismountClaudeJunction(worktreePath, log);

  // 3. git worktree remove
  const wtRemove = gitInMain(['worktree', 'remove', worktreePath, '--force'], mainRepoPath, { capture: true });
  if (!wtRemove.ok) {
    log(`  ⚠️ git worktree remove falló: ${wtRemove.stderr.trim()}`);
  } else {
    log('  → worktree removido');
  }

  // 4. Eliminar branch local
  const branchDel = gitInMain(['branch', '-D', branch], mainRepoPath, { capture: true });
  if (branchDel.ok) {
    log(`  → branch local ${branch} eliminada`);
  } else {
    log(`  → branch local ${branch} ya no existía`);
  }

  // 5. Prune
  gitInMain(['worktree', 'prune'], mainRepoPath);
  log('  → prune completado');

  return {
    ok: true,
    skipped: false,
    worktreePath,
    branch,
    claudeDismounted: claudeResult.dismounted,
    worktreeRemoved: wtRemove.ok,
    branchDeleted: branchDel.ok,
  };
}

module.exports = {
  cleanupWorktree,
  isActiveSession,
  isJunction,
  dismountClaudeJunction,
  // exports para tests
  _internals: { gitInMain },
};

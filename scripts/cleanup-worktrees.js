// cleanup-worktrees.js — Limpia worktrees huérfanos del sprint anterior
const fs = require('fs');
const p = require('path');
const { execSync } = require('child_process');

const PARENT = p.resolve('C:\\Workspaces\\Intrale');
const REPO = p.join(PARENT, 'platform');

// Leer todos los directorios platform.agent-*
const entries = fs.readdirSync(PARENT).filter(d => d.startsWith('platform.agent-'));
console.log('Encontrados: ' + entries.length + ' worktrees sibling');

let cleaned = 0, failed = 0;

for (const dir of entries) {
  const full = p.join(PARENT, dir);

  // 1. Desvincular junction .claude si existe
  const claudeDir = p.join(full, '.claude');
  if (fs.existsSync(claudeDir)) {
    try {
      // rmdir sin /s solo elimina junctions/symlinks, no contenido
      execSync('rmdir "' + claudeDir + '"', { timeout: 5000, windowsHide: true, shell: 'cmd.exe' });
      console.log('  junction .claude desvinculado: ' + dir);
    } catch(e) {
      // Si no es junction, eliminar como directorio normal
      try { fs.rmSync(claudeDir, { recursive: true, force: true }); } catch(e2) {}
    }
  }

  // 2. Intentar git worktree remove
  try {
    execSync('git worktree remove --force "' + full + '"', { cwd: REPO, timeout: 10000, windowsHide: true });
    console.log('OK (git worktree remove): ' + dir);
    cleaned++;
    continue;
  } catch(e) {}

  // 3. Intentar fs.rmSync
  try {
    fs.rmSync(full, { recursive: true, force: true });
    if (!fs.existsSync(full)) {
      console.log('OK (rmSync): ' + dir);
      cleaned++;
    } else {
      console.log('FAIL (EBUSY): ' + dir);
      failed++;
    }
  } catch(e) {
    console.log('FAIL (' + e.code + '): ' + dir);
    failed++;
  }
}

// 4. Prune
try {
  const out = execSync('git worktree prune -v', { cwd: REPO, encoding: 'utf8', timeout: 5000 });
  if (out.trim()) console.log('Prune: ' + out.trim());
} catch(e) {}

console.log('\nResultado: ' + cleaned + ' limpiados, ' + failed + ' bloqueados');

// =============================================================================
// ensure-git-on-path.js — helper de tests del pipeline (rebote #2892 rev-8)
//
// Garantiza que el binario `git` esté disponible en `process.env.PATH` antes
// de que el test invoque `spawnSync('git', …)` o `execSync('git …')`.
//
// Por qué existe:
//   El tester determinístico (`.pipeline/skills-deterministicos/tester.js`)
//   en `verificacion` corre desde el WORKTREE PRINCIPAL (en main) — pero
//   los *.test.js que ejecuta vienen del worktree del AGENTE (que sí tiene
//   los commits del issue). Como el tester de main puede ser una versión
//   vieja sin el fix de "garantizar git en PATH del child node-test", el
//   PATH heredado por el child puede no contener Git for Windows; cualquier
//   spawnSync('git', …) revienta con `ENOENT`.
//
//   Mover el fix a los tests mismos los hace self-contained y robustos a
//   variaciones del runner. Idempotente: si git ya está en PATH, no toca
//   nada.
//
// Uso:
//   require('../../lib/_test-helpers/ensure-git-on-path');
//   // …a partir de acá, spawnSync('git', …) funciona aunque el padre haya
//   //   limpiado PATH.
//
// Side effect:
//   Mutates `process.env.PATH` (idempotente). NO logea — los tests deben
//   permanecer silenciosos cuando todo va bien.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const GIT_FALLBACK_DIRS_WIN32 = [
    'C:\\Program Files\\Git\\cmd',
    'C:\\Program Files\\Git\\bin',
    'C:\\Program Files\\Git\\mingw64\\bin',
    'C:\\Program Files (x86)\\Git\\cmd',
    'C:\\Program Files (x86)\\Git\\bin',
];

/**
 * Resuelve el directorio que contiene git.exe/git via lookup en PATH y, si
 * eso falla, fallback a las rutas estándar de Git for Windows. Devuelve
 * `null` si no encuentra nada — en ese caso el caller deja PATH como está
 * y los tests emitirán fallas claras (ENOENT) en lugar de pretender éxito.
 */
function resolveGitDir() {
    const lookup = process.platform === 'win32' ? 'where' : 'which';
    try {
        const r = spawnSync(lookup, ['git'], {
            encoding: 'utf8', windowsHide: true, shell: false, timeout: 5000,
        });
        if (r && r.status === 0 && typeof r.stdout === 'string') {
            const firstLine = r.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
            if (firstLine) {
                try {
                    const stat = fs.statSync(firstLine);
                    if (stat.isFile()) return path.dirname(firstLine);
                } catch { /* ignore */ }
            }
        }
    } catch { /* ignore */ }

    if (process.platform === 'win32') {
        for (const dir of GIT_FALLBACK_DIRS_WIN32) {
            try {
                if (fs.statSync(path.join(dir, 'git.exe')).isFile()) return dir;
            } catch { /* ignore */ }
        }
    }
    return null;
}

/**
 * Verifica si `git --version` corre OK con el PATH actual. Si funciona,
 * no hace falta tocar nada. Devuelve true/false.
 */
function gitWorksInCurrentPath() {
    try {
        const r = spawnSync('git', ['--version'], {
            encoding: 'utf8', windowsHide: true, shell: false, timeout: 5000,
        });
        return r && r.status === 0;
    } catch {
        return false;
    }
}

/**
 * Garantiza que `git` esté en PATH. Idempotente:
 *   - Si git ya funciona → no-op.
 *   - Si no, busca el directorio y lo prepende a process.env.PATH.
 *   - Si no encuentra git → no toca PATH (los tests fallarán con ENOENT
 *     real, que sigue siendo accionable).
 *
 * Devuelve el directorio agregado (o null si no fue necesario / no se pudo).
 */
function ensureGitOnPath() {
    if (gitWorksInCurrentPath()) return null;
    const dir = resolveGitDir();
    if (!dir) return null;
    const sep = path.delimiter;
    const current = process.env.PATH || '';
    // Solo prependear si no está ya
    const parts = current.split(sep).map((p) => p.replace(/[\\/]+$/, ''));
    const normalized = dir.replace(/[\\/]+$/, '');
    if (!parts.some((p) => p.toLowerCase() === normalized.toLowerCase())) {
        process.env.PATH = `${dir}${sep}${current}`;
    }
    return dir;
}

// Side effect en require: ejecuta inmediatamente. La idea es que los tests
// hagan `require('…/ensure-git-on-path')` al tope del archivo y se olviden.
ensureGitOnPath();

module.exports = {
    ensureGitOnPath,
    resolveGitDir,
    gitWorksInCurrentPath,
    GIT_FALLBACK_DIRS_WIN32,
};

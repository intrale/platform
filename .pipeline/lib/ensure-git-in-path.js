// =============================================================================
// ensure-git-in-path.js — helper compartido para tests que invocan git
//
// Contexto (rebote #2891 rev-3):
// Cuando el pulpo corre como servicio Windows, su `process.env.PATH` puede no
// incluir el directorio de Git (`C:\Program Files\Git\cmd`). Eso se hereda al
// child de `node --test` que spawnea el tester. Los tests del pipeline (ej.
// `git-context.test.js`, `backup-agent-branch.test.js`) hacen
// `spawnSync('git', ...)` o `execSync('git ...')` y fallan con
// `'git' no se reconoce como un comando interno o externo` o
// `Command failed: git init`.
//
// Este módulo expone DOS variantes:
//   - `ensureGitInProcessPath()` muta `process.env.PATH` (se llama una sola
//     vez al cargar el archivo de tests, antes del primer `execSync('git')`).
//   - `ensureGitInEnv(env)` muta el `env` recibido (para usar en spawn).
//
// Diseño:
//   1) Verificar si `git --version` ya funciona con el env actual.
//   2) Si no, sondear ubicaciones conocidas (Win/Linux/macOS) y prepender la
//      primera válida al PATH.
//   3) Como último recurso, respetar `GIT_INSTALL_ROOT` / `GIT_HOME` si están
//      seteadas (Git for Windows installer las exporta).
//
// IMPORTANTE: este helper resuelve el "deadlock" de la fase verificacion
// donde el tester corre desde `main` sin el fix de ensureGitInPath en su
// runNodeTests. Aplicando el fix dentro de los tests mismos, no necesitamos
// que el tester de main lo aplique.
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const WIN_CANDIDATES = [
    'C:\\Program Files\\Git\\cmd',
    'C:\\Program Files\\Git\\mingw64\\bin',
    'C:\\Program Files (x86)\\Git\\cmd',
    'C:\\Program Files (x86)\\Git\\mingw64\\bin',
];
const POSIX_CANDIDATES = [
    '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin',
];

/**
 * Verifica si `git --version` funciona con el env dado.
 * Retorna true si está disponible, false si falta.
 */
function gitWorks(env) {
    try {
        const probe = spawnSync('git', ['--version'], {
            env, shell: false, windowsHide: true, encoding: 'utf8',
        });
        return probe.status === 0;
    } catch {
        return false;
    }
}

/**
 * Muta `env` agregando una ubicación válida de git al PATH si no funciona.
 * Devuelve el mismo `env` (mutado).
 *
 * - Si git ya funciona con el env actual: no toca nada.
 * - Si no: prepende la primera ubicación conocida donde existe git.exe / git.
 * - Como fallback: usa GIT_INSTALL_ROOT/GIT_HOME si están definidos.
 */
function ensureGitInEnv(env) {
    if (!env) return env;
    if (gitWorks(env)) return env;

    const candidates = process.platform === 'win32' ? WIN_CANDIDATES : POSIX_CANDIDATES;
    const exe = process.platform === 'win32' ? 'git.exe' : 'git';

    for (const dir of candidates) {
        try {
            if (fs.existsSync(path.join(dir, exe))) {
                env.PATH = `${dir}${path.delimiter}${env.PATH || ''}`;
                return env;
            }
        } catch { /* siguiente */ }
    }

    // Fallback: respetar GIT_INSTALL_ROOT / GIT_HOME exportados por el installer.
    const installRoot = env.GIT_INSTALL_ROOT || env.GIT_HOME;
    if (installRoot) {
        const candidate = path.join(installRoot, 'cmd');
        env.PATH = `${candidate}${path.delimiter}${env.PATH || ''}`;
    }
    return env;
}

/**
 * Versión que muta `process.env` directamente.
 * Útil para invocar UNA SOLA VEZ al inicio de un archivo de tests, antes
 * de cualquier `execSync('git ...')` que herede del proceso actual.
 *
 * Idempotente: llamadas subsecuentes son no-op si git ya funciona.
 */
function ensureGitInProcessPath() {
    ensureGitInEnv(process.env);
}

module.exports = {
    ensureGitInEnv,
    ensureGitInProcessPath,
    gitWorks,
};

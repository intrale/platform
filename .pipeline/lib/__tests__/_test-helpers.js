// =============================================================================
// _test-helpers.js — Helpers compartidos para tests Node del pipeline
//
// `ensureGitOnPath()` resuelve `git.exe` cuando el PATH heredado no lo trae
// (caso típico cuando el pulpo arranca con PATH stripped en Windows) y lo
// prepende a `process.env.PATH` para que `spawnSync('git', …)` y
// `execSync('git …')` funcionen dentro de los tests.
//
// Razón (rebote #2893): el tester determinístico ya hace este mismo trabajo
// antes de spawnear `node --test` (ver `.pipeline/skills-deterministicos/
// tester.js → resolveGitDir()`). Pero cuando la versión deployada del tester
// en `main` no incluye ese fix, los child node procesos heredan un PATH sin
// git y todos los tests que invocan git via spawn explotan con ENOENT.
// Este helper hace al test suite robusto sin depender de qué versión del
// tester esté corriendo.
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

let _cached = undefined; // undefined = no chequeado, null = no encontrado, string = path

/**
 * Verifica si `git` es invocable en el PATH actual.
 */
function gitIsInvokable() {
    try {
        const r = spawnSync('git', ['--version'], {
            encoding: 'utf8', windowsHide: true, shell: false, timeout: 5000,
        });
        return r && r.status === 0 && /^git version/.test(r.stdout || '');
    } catch {
        return false;
    }
}

/**
 * Localiza el directorio que contiene git.exe / git, sin asumir que esté en PATH.
 * Usa `where git` (Windows) / `which git` (Unix) primero, después paths estándar.
 * Devuelve `null` si no encuentra.
 */
function locateGitDir() {
    const lookup = process.platform === 'win32' ? 'where' : 'which';
    try {
        const r = spawnSync(lookup, ['git'], {
            encoding: 'utf8', windowsHide: true, shell: false, timeout: 5000,
        });
        if (r && r.status === 0 && typeof r.stdout === 'string') {
            const firstLine = r.stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean);
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
 * Asegura que `git` sea invocable desde tests. Idempotente:
 *   - Si `git --version` ya funciona, no hace nada.
 *   - Si no, busca git.exe y lo prepende a `process.env.PATH`.
 *   - Si tampoco lo encuentra, devuelve false (los tests deberían skippearse).
 *
 * @returns {boolean} true si git quedó invokable; false si no se pudo.
 */
function ensureGitOnPath() {
    if (_cached === undefined) {
        if (gitIsInvokable()) {
            _cached = 'in-path';
        } else {
            const dir = locateGitDir();
            if (dir) {
                process.env.PATH = `${dir}${path.delimiter}${process.env.PATH || ''}`;
                _cached = gitIsInvokable() ? dir : null;
            } else {
                _cached = null;
            }
        }
    }
    return _cached !== null;
}

module.exports = { ensureGitOnPath, locateGitDir, gitIsInvokable };

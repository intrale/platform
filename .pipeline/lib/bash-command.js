'use strict';

const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

function bashCandidates(env = process.env) {
    return [
        env.GIT_BASH_PATH,
        'C:\\Program Files\\Git\\bin\\bash.exe',
        'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
        'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    ].filter(Boolean);
}

function resolveBashCommand(cmd) {
    if (process.platform !== 'win32') {
        return { cmd, useShell: false };
    }
    if (cmd !== 'bash') {
        // ./gradlew y otros: usar shell para que cmd.exe encuentre .bat
        return { cmd, useShell: true };
    }
    const candidates = bashCandidates();
    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate)) {
                return { cmd: candidate, useShell: false };
            }
        } catch {}
    }
    // No se encontró Git Bash — fallback a 'bash' por PATH (puede caer
    // en WSL bash). Mejor fallar con stack trace claro que silenciosamente.
    return { cmd, useShell: true };
}

// Un archivo existente o --version no garantizan que WSL pueda ejecutar scripts.
function resolveUsableBash({ platform = process.platform, env = process.env, spawnSyncFn = spawnSync } = {}) {
    const candidates = platform === 'win32' ? [...bashCandidates(env), 'bash'] : ['bash'];
    for (const cmd of new Set(candidates)) {
        try {
            const result = spawnSyncFn(cmd, ['-c', 'exit 0'], {
                env, encoding: 'utf8', shell: false, timeout: 5000, windowsHide: true,
            });
            if (!result.error && result.status === 0) return cmd;
        } catch {}
    }
    return null;
}

const BASH_SKIP_REASON = 'No hay Bash usable: ningún candidato pudo ejecutar bash -c "exit 0" (timeout 5s).';
module.exports = { resolveBashCommand, resolveUsableBash, BASH_SKIP_REASON };

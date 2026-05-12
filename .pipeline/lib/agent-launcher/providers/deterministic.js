// =============================================================================
// providers/deterministic.js — Handler para skills determinísticos (Node puro).
//
// Bypass al LLM: los skills `builder`, `tester`, `delivery`, `linter`
// implementan su lógica en `.pipeline/skills-deterministicos/<skill>.js` y
// corren con Node directo, sin gastar tokens. Cada script implementa el mismo
// contrato (marker, heartbeat, eventos V3, exit 0/1) que el resto del flujo
// del Pulpo (watchdog, on-exit) entiende sin cambios.
//
// Issues: #2476 / #2482 / #2484 (rollout reversible — borrar el archivo del
// skill devuelve al fallback LLM automáticamente).
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

// -----------------------------------------------------------------------------
// Allowlist hardcoded — invariante de seguridad I4 (path-traversal defense).
// NUNCA cambiar a require dinámico sobre `skill`: si un atacante con permiso de
// PR edita esto, podría inyectar un script fuera de skills-deterministicos/.
// -----------------------------------------------------------------------------
const DETERMINISTIC_SKILLS = new Set(['build', 'tester', 'delivery', 'linter']);

function isDeterministic(skill) {
    return DETERMINISTIC_SKILLS.has(skill);
}

// -----------------------------------------------------------------------------
// resolveDeterministicScript — resuelve la ruta absoluta del script Node del
// skill. Si existe un worktree del issue (platform.agent-<issue>-*), prefiere
// el script del worktree (puede haber cambios locales del developer).
//
// Si el worktree no tiene el script, fallback al de ROOT (el "oficial").
// -----------------------------------------------------------------------------
function resolveDeterministicScript({ skill, issue, ROOT, PIPELINE, onWorktreeHit, execSyncImpl, fsImpl } = {}) {
    const _execSync = execSyncImpl || execSync;
    const _fs = fsImpl || fs;
    const rootScript = path.join(PIPELINE, 'skills-deterministicos', `${skill}.js`);
    if (!issue || !ROOT) return rootScript;
    let issueWorktree = null;
    try {
        const needle = `platform.agent-${issue}-`;
        const worktrees = _execSync('git worktree list --porcelain', { cwd: ROOT, encoding: 'utf8', timeout: 5000, windowsHide: true });
        for (const line of String(worktrees).split('\n')) {
            if (line.startsWith('worktree ') && line.includes(needle)) {
                issueWorktree = line.replace('worktree ', '').trim();
                break;
            }
        }
    } catch { /* sin worktree, fallback a ROOT */ }
    if (issueWorktree) {
        const wtScript = path.join(issueWorktree, '.pipeline', 'skills-deterministicos', `${skill}.js`);
        if (_fs.existsSync(wtScript)) {
            if (typeof onWorktreeHit === 'function') {
                try { onWorktreeHit(issueWorktree); } catch { /* ignore */ }
            }
            return wtScript;
        }
    }
    return rootScript;
}

// -----------------------------------------------------------------------------
// buildSpawn — devuelve el objeto spawn para el script determinístico.
//
// Contrato igual que el provider Anthropic: {cmd, args, spawnOpts}. Acá la
// CMD es siempre `process.execPath` (node) y los args incluyen el path del
// script + el issue + --trabajando=<path>.
//
// Defensa I4: el `skill` debe estar en DETERMINISTIC_SKILLS. Si no, throw.
// -----------------------------------------------------------------------------
function buildSpawn({ skill, issue, trabajandoPath, cwd, env, ROOT, PIPELINE, onWorktreeHit, execSyncImpl, fsImpl }) {
    if (!isDeterministic(skill)) {
        throw new Error(
            `[agent-launcher/deterministic] skill "${skill}" no está en la allowlist de skills determinísticos.\n` +
            `Allowlist: ${Array.from(DETERMINISTIC_SKILLS).join(', ')}.\n` +
            `Esto suele indicar un bug en resolve-provider o un agent-models.json incorrecto.`
        );
    }
    const scriptPath = resolveDeterministicScript({ skill, issue, ROOT, PIPELINE, onWorktreeHit, execSyncImpl, fsImpl });
    return {
        cmd: process.execPath,
        args: [scriptPath, String(issue), `--trabajando=${trabajandoPath}`],
        spawnOpts: {
            cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: false,
            // Defensa I1: shell:false SIEMPRE para skills determinísticos.
            shell: false,
            windowsHide: true,
            env,
        },
        scriptPath,
    };
}

// Los skills determinísticos no tienen tokens (no van al LLM).
function parseTokensFromLog(/* logPath */) {
    return { input: 0, output: 0, cache_read: 0, cache_create: 0, tool_calls: 0 };
}

// Los skills determinísticos no consumen cuota Anthropic, así que el detector
// de cuota agotada no aplica.
function detectQuotaExhausted() {
    return { matched: false };
}

module.exports = {
    name: 'deterministic',
    DETERMINISTIC_SKILLS,
    isDeterministic,
    resolveDeterministicScript,
    buildSpawn,
    parseTokensFromLog,
    detectQuotaExhausted,
};

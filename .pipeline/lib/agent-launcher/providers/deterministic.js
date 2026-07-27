// =============================================================================
// providers/deterministic.js — Handler para skills determinísticos (Node puro).
//
// Bypass al LLM: los skills `build`, `tester`, `delivery`, `linter`
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
// CA-B2 — needle del worktree derivado del helper compartido (sin re-duplicar 'platform.').
const { worktreeNeedle } = require('../../worktree-prefix');

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
// Base contra la que se mide "¿esta rama cambió el script?". Coincide con la
// base de ramas de agente del repo (ver CLAUDE.md → Ramas y PRs).
// -----------------------------------------------------------------------------
const DEFAULT_BASE_REF = 'origin/main';

// El nombre del skill se interpola en una línea de comando de git. Ya viene
// filtrado por DETERMINISTIC_SKILLS en `buildSpawn`, pero `resolveDeterministicScript`
// es exportado y llamable por su cuenta: allowlist de caracteres, sin excepciones.
const SAFE_SKILL_RE = /^[a-z0-9][a-z0-9._-]*$/i;

// -----------------------------------------------------------------------------
// worktreeOwnsScript — ¿la rama del worktree efectivamente MODIFICA el script
// determinístico de este skill?
//
// Es la condición que habilita el override del worktree. Sin ella, un worktree
// creado hace semanas devuelve una copia arbitrariamente vieja del motor del
// pipeline (ver comentario de `resolveDeterministicScript`).
//
// Dos señales, cualquiera alcanza:
//   1. Cambios COMMITEADOS: `git diff <base>...HEAD -- <script>`. Triple punto
//      A PROPÓSITO — compara contra el merge-base, así que una rama meramente
//      ATRASADA da vacío. Con dos puntos, la copia vieja del worktree "difiere"
//      de la nueva de main y el override se activaría justo en el caso que este
//      chequeo viene a atajar (diferencia invertida).
//   2. Cambios SIN COMMITEAR en ese path: el agente está editando el script
//      ahora mismo y todavía no cerró el commit.
//
// Fail-closed hacia ROOT: ante cualquier error de git devuelve false. ROOT es
// siempre el motor vigente; el worktree es la excepción, y una excepción que no
// se puede justificar no se aplica.
// -----------------------------------------------------------------------------
function worktreeOwnsScript({ worktree, skill, execSyncImpl, baseRef } = {}) {
    const _execSync = execSyncImpl || execSync;
    if (!SAFE_SKILL_RE.test(String(skill || ''))) return false;
    const base = baseRef || DEFAULT_BASE_REF;
    const rel = `.pipeline/skills-deterministicos/${skill}.js`;
    const opts = { cwd: worktree, encoding: 'utf8', timeout: 5000, windowsHide: true };
    try {
        const out = _execSync(`git diff --name-only ${base}...HEAD -- ${rel}`, opts);
        if (String(out).trim()) return true;
    } catch { /* base no resoluble en este worktree — sigue con el chequeo 2 */ }
    try {
        const out = _execSync(`git status --porcelain -- ${rel}`, opts);
        if (String(out).trim()) return true;
    } catch { /* sin git utilizable — fail-closed a ROOT */ }
    return false;
}

// -----------------------------------------------------------------------------
// resolveDeterministicScript — resuelve la ruta absoluta del script Node del
// skill.
//
// Regla: se usa la copia del worktree del issue SÓLO si la rama de ese worktree
// modifica ese mismo script. En cualquier otro caso gana la copia de ROOT.
//
// Por qué (#5066): estos scripts NO son la carga del issue, son el motor del
// pipeline. El override del worktree existe por un chicken-and-egg acotado
// (#2893): si un agente pipeline-dev arregla `tester.js`, su fix tiene que
// tomar efecto ANTES del merge o el issue rebota eternamente. Pero aplicarlo
// incondicionalmente convierte a CUALQUIER worktree viejo en una máquina del
// tiempo: corre el motor tal como estaba cuando se cortó la rama y revierte en
// silencio todos los fixes posteriores.
//
// Caso observado en #5066: el worktree estaba 556 commits atrás de main, sobre
// un commit anterior a `resolveBashCommand` (a922fb28). El build spawneó `bash`
// vía cmd.exe, que no lo resuelve, y murió en 47 ms con
// `"bash" no se reconoce como un comando interno o externo` — un fix que ya
// llevaba dos meses en main.
//
// Si el worktree no tiene el script, o no lo modifica, fallback al de ROOT.
// -----------------------------------------------------------------------------
function resolveDeterministicScript({ skill, issue, ROOT, PIPELINE, onWorktreeHit, onWorktreeSkip, execSyncImpl, fsImpl, baseRef } = {}) {
    const _execSync = execSyncImpl || execSync;
    const _fs = fsImpl || fs;
    const rootScript = path.join(PIPELINE, 'skills-deterministicos', `${skill}.js`);
    if (!issue || !ROOT) return rootScript;
    let issueWorktree = null;
    try {
        const needle = worktreeNeedle(issue);
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
            if (worktreeOwnsScript({ worktree: issueWorktree, skill, execSyncImpl: _execSync, baseRef })) {
                if (typeof onWorktreeHit === 'function') {
                    try { onWorktreeHit(issueWorktree); } catch { /* ignore */ }
                }
                return wtScript;
            }
            // El worktree tiene el script pero no lo toca: es una copia heredada
            // del corte de rama. Se ignora y se corre el motor vigente de ROOT.
            if (typeof onWorktreeSkip === 'function') {
                try { onWorktreeSkip(issueWorktree); } catch { /* ignore */ }
            }
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
function buildSpawn({ skill, issue, trabajandoPath, cwd, env, ROOT, PIPELINE, onWorktreeHit, onWorktreeSkip, execSyncImpl, fsImpl, interactive_supported }) {
    if (!isDeterministic(skill)) {
        throw new Error(
            `[agent-launcher/deterministic] skill "${skill}" no está en la allowlist de skills determinísticos.\n` +
            `Allowlist: ${Array.from(DETERMINISTIC_SKILLS).join(', ')}.\n` +
            `Esto suele indicar un bug en resolve-provider o un agent-models.json incorrecto.`
        );
    }
    const scriptPath = resolveDeterministicScript({ skill, issue, ROOT, PIPELINE, onWorktreeHit, onWorktreeSkip, execSyncImpl, fsImpl });
    // #3605 — Opt-in. Default 'ignore'; 'pipe' habilita IPC operador→agente.
    // Sólo aplica si el skill determinístico implementa loop de lectura de stdin.
    const stdin = interactive_supported === true ? 'pipe' : 'ignore';
    return {
        cmd: process.execPath,
        args: [scriptPath, String(issue), `--trabajando=${trabajandoPath}`],
        spawnOpts: {
            cwd,
            stdio: [stdin, 'pipe', 'pipe'],
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
    worktreeOwnsScript,
    buildSpawn,
    parseTokensFromLog,
    detectQuotaExhausted,
};

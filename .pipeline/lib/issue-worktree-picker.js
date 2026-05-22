// =============================================================================
// issue-worktree-picker.js — Selección del worktree "ganador" cuando hay varios
// worktrees activos para el mismo issue (caso típico: cross-phase rebote dev→
// dev distinto, ej. android-dev → pipeline-dev quedan ambos abiertos sobre el
// mismo issue).
//
// **Causa raíz** (rebote #3409 rev-2):
//   El issue #3409 (hook `qa/scripts/promote-screenshots.js`) corrió primero
//   en `agent/3409-android-dev`, fue rechazado por tester con "No se
//   encontraron reportes JUnit", y un cross-phase rebote re-asignó el issue
//   a `pipeline-dev`. El nuevo worktree `platform.agent-3409-pipeline-dev`
//   incluye el fix del tester (`qa/scripts/*.js` como pipeline-only), pero
//   el worktree viejo `platform.agent-3409-android-dev` quedó vivo con la
//   versión sin fix.
//
//   La fase verificacion corre el tester desde ROOT (main worktree); `pulpo.
//   resolveDeterministicScript` y `tester.findIssueWorktree` resolvían el
//   worktree del issue iterando `git worktree list --porcelain` y devolviendo
//   el PRIMER match alfabético (`android-dev` < `pipeline-dev`). Así el
//   tester ejecutaba la versión vieja de tester.js, no detectaba qa/scripts
//   como pipeline-only y caía a ruta gradle (que no produce JUnit reports
//   para un cambio puro Node.js) → rebote eterno hasta circuit breaker.
//
//   Verificación empírica del bug (desde C:/Workspaces/Intrale/platform):
//     $ git worktree list --porcelain | grep "platform.agent-3409"
//     worktree C:/Workspaces/Intrale/platform.agent-3409-android-dev
//     worktree C:/Workspaces/Intrale/platform.agent-3409-pipeline-dev
//
//     # Versión antes del fix devolvía siempre android-dev:
//     $ PULPO_NO_AUTOSTART=1 node -e "const {resolveDeterministicScript} =
//         require('./.pipeline/pulpo.js');
//         console.log(resolveDeterministicScript({
//             skill:'tester', issue:3409, ROOT:process.cwd(),
//             PIPELINE: process.cwd()+'/.pipeline'}));"
//     -> ...platform.agent-3409-android-dev\.pipeline\skills-deterministicos\tester.js
//
// **Fix**: cuando hay varios worktrees para el mismo issue, preferir el que
//   tiene MÁS commits ahead de `origin/main` (asumiendo que el dev más reciente
//   trae al menos los commits del anterior + sus propios fixes). Ties se rompen
//   por mtime de HEAD del worktree (último escrito gana).
//
// Sin esto la solución a un cross-phase rebote queda "invisible" al pipeline:
// el nuevo worktree tiene los fixes pero el viejo sigue siendo el seleccionado
// alfabéticamente, y todo cambio que toque scripts determinísticos del pipeline
// (tester/builder/linter/delivery) sufre el mismo bug.
//
// **Diseño**:
//   - `listIssueWorktrees(ROOT, issue, opts)` → array de paths (todos los que
//     matchean `platform.agent-<issue>-*`). Cero match → array vacío.
//   - `rankWorktreesByFreshness(worktrees, opts)` → ordena por commits ahead
//     de origin/main (desc), ties por HEAD mtime (desc). Worktrees con git
//     errors (branch desaparecida, repo corrupto) van al final.
//   - `pickIssueWorktree(ROOT, issue, opts)` → atajo: lista + ordena + toma
//     el primero. Devuelve null si no hay matches.
//
// **Por qué exponemos los tres**: tester.js solo necesita el path final;
//   pulpo.js además quiere logear cuántos había y cuál ganó (telemetría útil
//   para detectar worktrees fantasma que el cleanup no recolectó). Si solo
//   exponemos `pickIssueWorktree`, pulpo no puede contar.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/**
 * Lista todos los worktrees activos que matchean `platform.agent-<issue>-*`.
 *
 * Filtra entradas cuyo directorio físico ya no existe — git puede mantener
 * registros muertos en `.git/worktrees/` hasta el próximo prune. Si el path
 * no existe en disco, no nos sirve para correr código.
 *
 * @param {string} ROOT     Path absoluto del repo principal (cwd de `git worktree list`).
 * @param {number|string} issue
 * @param {object} [opts]
 * @param {function} [opts.execSyncImpl] Inyectable para tests.
 * @param {object}   [opts.fsImpl]       Inyectable para tests (necesita existsSync).
 * @returns {string[]} paths absolutos de worktrees matcheantes, en el orden
 *                    devuelto por `git worktree list --porcelain`.
 */
function listIssueWorktrees(ROOT, issue, opts = {}) {
    const _execSync = opts.execSyncImpl || execSync;
    const _fs = opts.fsImpl || fs;
    if (!issue || !ROOT) return [];
    let raw;
    try {
        raw = _execSync('git worktree list --porcelain', {
            cwd: ROOT, encoding: 'utf8', timeout: 10000, windowsHide: true,
        });
    } catch {
        return [];
    }
    const needle = `platform.agent-${issue}-`;
    const out = [];
    for (const line of String(raw || '').split('\n')) {
        if (!line.startsWith('worktree ')) continue;
        const wt = line.replace('worktree ', '').trim();
        if (!wt) continue;
        // Match por basename para evitar falsos positivos si el repo está
        // anidado en un path que contiene "platform.agent-3409-".
        const base = path.basename(wt);
        if (!base.startsWith(needle)) continue;
        // Filtrar paths que git lista pero ya no existen físicamente — opt-in
        // vía `opts.requireExists=true`. Default OFF para preservar la semántica
        // de los algoritmos previos (`pulpo.resolveDeterministicScript` y
        // `tester.findIssueWorktree`) que no chequeaban existencia y cuyos
        // tests pre-existentes solo modelan los SCRIPTS, no la carpeta del
        // worktree. Los callers en código real chequean implícitamente el
        // archivo final (ej. pulpo verifica que el script existe antes de
        // usarlo), así que el filtro acá sería redundante en producción.
        if (opts.requireExists === true) {
            try {
                if (!_fs.existsSync(wt)) continue;
            } catch { continue; }
        }
        out.push(wt);
    }
    return out;
}

/**
 * Devuelve los commits ahead de `origin/main` para un worktree dado.
 *
 * Tolerante a errores: si git falla, devuelve -1 (peor que cualquier branch
 * sana). El caller debe tratar -1 como "branch problemática, ir al final".
 *
 * @param {string} worktreePath
 * @param {object} [opts]
 * @param {function} [opts.execSyncImpl]
 * @returns {number} commits ahead de origin/main, o -1 si falla.
 */
function commitsAheadOfMain(worktreePath, opts = {}) {
    const _execSync = opts.execSyncImpl || execSync;
    if (!worktreePath) return -1;
    try {
        const out = _execSync('git rev-list --count origin/main..HEAD', {
            cwd: worktreePath, encoding: 'utf8', timeout: 5000, windowsHide: true,
        });
        const n = parseInt(String(out).trim(), 10);
        return Number.isFinite(n) ? n : -1;
    } catch {
        return -1;
    }
}

/**
 * Devuelve el mtime del HEAD del worktree (timestamp del último commit local).
 * Si no hay HEAD (worktree corrupto), devuelve 0.
 *
 * Usado como tiebreak cuando dos worktrees tienen el mismo número de commits
 * ahead — preferimos el último escrito.
 */
function worktreeHeadMtime(worktreePath, opts = {}) {
    const _fs = opts.fsImpl || fs;
    if (!worktreePath) return 0;
    // En worktrees secundarios `.git` es un archivo apuntando al gitdir real.
    const gitFile = path.join(worktreePath, '.git');
    try {
        const stat = _fs.statSync(gitFile);
        let headPath;
        if (stat.isDirectory()) {
            headPath = path.join(gitFile, 'HEAD');
        } else {
            // gitdir file: "gitdir: <abs-path-to-worktree-gitdir>"
            const content = _fs.readFileSync(gitFile, 'utf8').trim();
            const m = content.match(/^gitdir:\s*(.+)$/i);
            if (!m) return 0;
            const gitDir = m[1].trim();
            headPath = path.join(gitDir, 'HEAD');
        }
        const headStat = _fs.statSync(headPath);
        return headStat.mtimeMs || headStat.mtime?.getTime() || 0;
    } catch {
        return 0;
    }
}

/**
 * Ordena worktrees por "freshness" descendente:
 *   1. commits ahead de origin/main (mayor primero).
 *   2. mtime de HEAD (más reciente primero).
 *   3. orden original (estable).
 *
 * NO muta el array recibido. Devuelve uno nuevo.
 */
function rankWorktreesByFreshness(worktrees, opts = {}) {
    const meta = (Array.isArray(worktrees) ? worktrees : []).map((wt, idx) => ({
        wt,
        idx,
        ahead: commitsAheadOfMain(wt, opts),
        mtime: worktreeHeadMtime(wt, opts),
    }));
    meta.sort((a, b) => {
        if (b.ahead !== a.ahead) return b.ahead - a.ahead;
        if (b.mtime !== a.mtime) return b.mtime - a.mtime;
        return a.idx - b.idx;
    });
    return meta.map((m) => m.wt);
}

/**
 * Atajo: lista los worktrees del issue, los rankea por freshness y devuelve
 * el ganador.
 *
 * Devuelve null si no hay worktrees matcheantes.
 *
 * @param {string} ROOT
 * @param {number|string} issue
 * @param {object} [opts]
 * @param {function} [opts.execSyncImpl]
 * @param {object}   [opts.fsImpl]
 * @param {function} [opts.onPick]  callback({ winner, candidates, ranked, reason })
 *                                  útil para logear telemetría desde el caller.
 * @returns {string|null} path absoluto del worktree ganador o null.
 */
function pickIssueWorktree(ROOT, issue, opts = {}) {
    const candidates = listIssueWorktrees(ROOT, issue, opts);
    if (candidates.length === 0) return null;
    if (candidates.length === 1) {
        if (typeof opts.onPick === 'function') {
            try {
                opts.onPick({
                    winner: candidates[0], candidates, ranked: candidates,
                    reason: 'single-candidate',
                });
            } catch { /* ignore */ }
        }
        return candidates[0];
    }
    const ranked = rankWorktreesByFreshness(candidates, opts);
    if (typeof opts.onPick === 'function') {
        try {
            opts.onPick({
                winner: ranked[0], candidates, ranked,
                reason: 'most-ahead',
            });
        } catch { /* ignore */ }
    }
    return ranked[0];
}

module.exports = {
    listIssueWorktrees,
    commitsAheadOfMain,
    worktreeHeadMtime,
    rankWorktreesByFreshness,
    pickIssueWorktree,
};

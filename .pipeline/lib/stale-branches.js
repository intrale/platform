// =============================================================================
// stale-branches.js — Detección y limpieza de branches locales `agent/*` stale.
//
// Issue: #2398
//
// Una branch `agent/*` se considera stale (segura para borrar) si cumple TODAS:
//   1. Sin worktree asociado (no aparece en `git worktree list --porcelain`).
//   2. Tip ya está integrado en `origin/main`
//      (`git merge-base --is-ancestor <branch> origin/main` exit 0).
//   3. Nombre matchea `agent/<issue>-<skill>` (no toca feature/*, bugfix/*,
//      session-*, ni branches manuales).
//
// La condición #2 garantiza cero pérdida de trabajo: si el tip es ancestro de
// origin/main, no aporta commits únicos. La condición #1 evita romper agentes
// activos. La #3 mantiene el scope acotado a refs generados por el pipeline.
//
// Opcional: enriquecer cada candidato con el estado del issue (OPEN/CLOSED/
// MERGED) usando `gh issue view`. No es bloqueante: si falla la consulta, se
// reporta como UNKNOWN y el borrado procede igual (el ancestor-check ya
// garantiza la seguridad).
//
// API:
//   const sb = require('./stale-branches');
//   const candidates = sb.detectStale({ fetchOrigin: true, withIssueState: true });
//   const results = sb.cleanStale(candidates, { dryRun: false });
//
// Inyección de dependencias para tests:
//   detectStale({ exec, repoRoot, ghBin, ... })
//   cleanStale(branches, { exec, repoRoot, dryRun })
//
// Donde `exec` es una función `(cmd, opts) => string` (default: child_process.execSync).
// =============================================================================
'use strict';

const { execSync } = require('node:child_process');
const path = require('node:path');

const DEFAULT_REPO_ROOT = path.resolve(__dirname, '..', '..');
const AGENT_BRANCH_RE = /^agent\/(\d+)-([\w.-]+)$/;
const DEFAULT_GH_BIN = process.env.GH_CLI_PATH || 'C:/Workspaces/gh-cli/bin/gh.exe';

// -----------------------------------------------------------------------------
// Utilidades
// -----------------------------------------------------------------------------

function defaultExec(cmd, opts = {}) {
    return execSync(cmd, {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10000,
        ...opts,
    });
}

function parseAgentBranchName(branch) {
    const m = AGENT_BRANCH_RE.exec(branch);
    if (!m) return null;
    return { issueNum: parseInt(m[1], 10), skill: m[2] };
}

function listAgentBranches({ exec = defaultExec, repoRoot = DEFAULT_REPO_ROOT } = {}) {
    try {
        const out = exec('git for-each-ref --format="%(refname:short)" refs/heads/agent/', { cwd: repoRoot });
        return out
            .split('\n')
            .map((s) => s.trim().replace(/^"|"$/g, ''))
            .filter(Boolean)
            .filter((b) => AGENT_BRANCH_RE.test(b));
    } catch {
        return [];
    }
}

function listWorktreeBranches({ exec = defaultExec, repoRoot = DEFAULT_REPO_ROOT } = {}) {
    const inUse = new Set();
    try {
        const out = exec('git worktree list --porcelain', { cwd: repoRoot });
        for (const raw of out.split('\n')) {
            const line = raw.trim();
            if (line.startsWith('branch refs/heads/')) {
                inUse.add(line.slice('branch refs/heads/'.length));
            }
        }
    } catch {
        // Si falla, devolvemos vacío — todas las branches aparecerán como sin
        // worktree, pero el ancestor-check es la safety neta dura.
    }
    return inUse;
}

function isAncestorOfMain(branch, { exec = defaultExec, repoRoot = DEFAULT_REPO_ROOT } = {}) {
    try {
        exec(`git merge-base --is-ancestor "${branch}" origin/main`, {
            cwd: repoRoot,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        // exit 0 → ancestor
        return true;
    } catch (e) {
        // exit 1 → no ancestor; exit 128 → bad ref / no origin/main
        return false;
    }
}

function fetchOriginMain({ exec = defaultExec, repoRoot = DEFAULT_REPO_ROOT } = {}) {
    try {
        exec('git fetch origin main --quiet', { cwd: repoRoot, timeout: 30000 });
        return true;
    } catch {
        return false;
    }
}

function fetchIssueState(issueNum, { exec = defaultExec, ghBin = DEFAULT_GH_BIN } = {}) {
    try {
        const out = exec(
            `"${ghBin}" issue view ${issueNum} --repo intrale/platform --json state,stateReason --jq "[.state, .stateReason] | join(\\":\\")"`,
            { timeout: 8000 }
        ).trim();
        // Forma: "OPEN:" / "CLOSED:COMPLETED" / "CLOSED:NOT_PLANNED"
        const [state, reason] = out.split(':');
        if (!state) return 'UNKNOWN';
        if (state === 'CLOSED' && reason === 'COMPLETED') return 'MERGED'; // semánticamente acercado al PR mergeado
        return state;
    } catch {
        return 'UNKNOWN';
    }
}

// -----------------------------------------------------------------------------
// API principal
// -----------------------------------------------------------------------------

/**
 * Detecta branches `agent/*` candidatas a borrado seguro.
 *
 * @param {object} opts
 * @param {Function} [opts.exec]            execSync-like, para tests.
 * @param {string}   [opts.repoRoot]        Path al repo principal.
 * @param {boolean}  [opts.fetchOrigin]     Si hace `git fetch origin main` previo (default false).
 * @param {boolean}  [opts.withIssueState]  Si enriquece con estado del issue vía gh (default false).
 * @param {string}   [opts.ghBin]           Path al binario gh.
 * @returns {Array<{name:string,issueNum:number,skill:string,reason:string,issueState?:string,skipped?:boolean,skipReason?:string}>}
 */
function detectStale(opts = {}) {
    const exec = opts.exec || defaultExec;
    const repoRoot = opts.repoRoot || DEFAULT_REPO_ROOT;
    const ghBin = opts.ghBin || DEFAULT_GH_BIN;
    const fetchOrigin = opts.fetchOrigin === true;
    const withIssueState = opts.withIssueState === true;

    if (fetchOrigin) fetchOriginMain({ exec, repoRoot });

    const allAgent = listAgentBranches({ exec, repoRoot });
    const inUse = listWorktreeBranches({ exec, repoRoot });

    const candidates = [];
    const skipped = [];

    for (const branch of allAgent) {
        const parsed = parseAgentBranchName(branch);
        if (!parsed) continue; // ya filtrado en listAgentBranches, defensivo
        if (inUse.has(branch)) {
            skipped.push({
                name: branch,
                issueNum: parsed.issueNum,
                skill: parsed.skill,
                skipped: true,
                skipReason: 'tiene worktree asociado',
            });
            continue;
        }
        const ancestor = isAncestorOfMain(branch, { exec, repoRoot });
        if (!ancestor) {
            skipped.push({
                name: branch,
                issueNum: parsed.issueNum,
                skill: parsed.skill,
                skipped: true,
                skipReason: 'tip no es ancestro de origin/main (tiene commits únicos)',
            });
            continue;
        }
        const entry = {
            name: branch,
            issueNum: parsed.issueNum,
            skill: parsed.skill,
            reason: 'tip en origin/main, sin worktree, sin contenido único',
        };
        if (withIssueState) {
            entry.issueState = fetchIssueState(parsed.issueNum, { exec, ghBin });
        }
        candidates.push(entry);
    }

    return { candidates, skipped };
}

/**
 * Borra las branches candidatas con `git branch -D`. Opcionalmente crea un tag
 * de backup `backup/orphan-<branch>-<ts>` antes de borrar.
 *
 * @param {Array<{name:string,issueNum:number}>} branches  Candidatas a borrar (output de detectStale().candidates).
 * @param {object} opts
 * @param {Function} [opts.exec]       execSync-like.
 * @param {string}   [opts.repoRoot]   Path al repo.
 * @param {boolean}  [opts.dryRun]     Si true, no borra (default true por seguridad).
 * @param {boolean}  [opts.backupTag]  Si true, crea tag backup antes del delete (default true).
 * @returns {Array<{name:string,removed:boolean,error?:string,backupTag?:string}>}
 */
function cleanStale(branches, opts = {}) {
    const exec = opts.exec || defaultExec;
    const repoRoot = opts.repoRoot || DEFAULT_REPO_ROOT;
    const dryRun = opts.dryRun !== false; // default true (seguro)
    const backupTag = opts.backupTag !== false; // default true

    const results = [];
    for (const b of branches) {
        const result = { name: b.name, issueNum: b.issueNum, removed: false };
        if (b.issueState) result.issueState = b.issueState;
        if (dryRun) {
            results.push(result);
            continue;
        }
        try {
            if (backupTag) {
                const sanitized = b.name.replace(/[/\\]/g, '-');
                const tag = `backup/orphan-${sanitized}-${Date.now()}`;
                exec(`git tag "${tag}" "${b.name}"`, { cwd: repoRoot });
                result.backupTag = tag;
            }
            exec(`git branch -D "${b.name}"`, { cwd: repoRoot });
            result.removed = true;
        } catch (e) {
            result.removed = false;
            result.error = (e && e.message ? e.message : String(e)).split('\n')[0].slice(0, 200);
        }
        results.push(result);
    }
    return results;
}

module.exports = {
    detectStale,
    cleanStale,
    // expuesto para tests + composición
    parseAgentBranchName,
    listAgentBranches,
    listWorktreeBranches,
    isAncestorOfMain,
    fetchOriginMain,
    fetchIssueState,
    AGENT_BRANCH_RE,
};

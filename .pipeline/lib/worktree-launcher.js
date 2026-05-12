// =============================================================================
// worktree-launcher.js — Creación robusta del worktree de fase `dev`.
//
// Encapsula la decisión "¿hay que crear, reusar o limpiar antes?" del worktree
// del agente, con recovery automático de branches huérfanas.
//
// **Causa raíz que motivó el módulo** (incidente 2026-05-11):
//   El bloque inline previo en pulpo.js hacía:
//     if (!fs.existsSync(worktreePath)) {
//       execSync(`git worktree add ${path} -b ${branch} origin/main`)
//     }
//   Cuando un intento anterior dejaba la branch `agent/<n>-<skill>` huérfana
//   (worktree borrado, branch persistente), el `-b` fallaba con
//     `fatal: a branch named '<...>' already exists`
//   y el Pulpo contaba "muerte prematura" en cada iteración. Resultado:
//   el issue quedaba dando vueltas en cola sin avanzar nunca.
//
// **Contrato público**:
//   ensureLaunchWorktree({ ROOT, issue, skill, log }) -> {
//     worktreePath: string,
//     worktreeBranch: string,
//     created: boolean,   // true si se creó ahora; false si se reusó
//     recovered: boolean, // true si tuvimos que limpiar branch huérfana
//   }
//   Lanza `WorktreeLaunchError` con `code` cuando no puede continuar.
//
// **Estrategia**:
//   1. Si el directorio del worktree ya existe → reuso silencioso (idempotente).
//   2. `git worktree prune` defensivo (limpia entries muertas del .git/worktrees).
//   3. ¿La branch `agent/<n>-<skill>` existe localmente?
//      3a. NO → `git worktree add -b ... origin/main` (camino feliz).
//      3b. SÍ y en uso por OTRO worktree → error `BRANCH_IN_USE` (no tocar,
//          ese worktree probablemente tiene un agente vivo).
//      3c. SÍ y NO en uso → branch huérfana:
//          - Crear tag de backup `backup/orphan-<branch>-<ts>` (best-effort).
//          - `git branch -D` para eliminarla.
//          - `git worktree add -b ... origin/main` fresco.
//
// **Por qué borrar la branch huérfana en vez de reusarla**:
//   El contrato del lanzamiento es "arrancar desde origin/main". Si reusamos
//   una branch huérfana podemos heredar commits podridos de un intento previo
//   rechazado (motivo del rebote, código a medias). El backup tag preserva
//   el SHA por 30 días si hace falta investigar.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const EXEC_OPTS_DEFAULT = { encoding: 'utf8', timeout: 30000, windowsHide: true };

class WorktreeLaunchError extends Error {
    constructor(message, code, cause) {
        super(message);
        this.name = 'WorktreeLaunchError';
        this.code = code;
        if (cause) this.cause = cause;
    }
}

/**
 * Valida que `issue` y `skill` sean seguros para interpolar en comandos git.
 * Defense-in-depth — pulpo ya valida upstream, pero este módulo es público
 * para reutilización.
 */
function validateInputs(issue, skill) {
    if (!/^\d+$/.test(String(issue))) {
        throw new WorktreeLaunchError(`Issue inválido: "${issue}"`, 'INVALID_ISSUE');
    }
    if (!/^[a-z][a-z0-9-]{0,40}$/.test(String(skill))) {
        throw new WorktreeLaunchError(`Skill inválido: "${skill}"`, 'INVALID_SKILL');
    }
}

/**
 * ¿La branch `branchName` existe localmente?
 */
function localBranchExists(ROOT, branchName, execImpl = execSync) {
    try {
        execImpl(`git show-ref --verify --quiet "refs/heads/${branchName}"`, {
            cwd: ROOT, ...EXEC_OPTS_DEFAULT, timeout: 10000,
        });
        return true;
    } catch {
        return false;
    }
}

/**
 * Devuelve el path del worktree que tiene checkout `branchName`, o null si
 * ninguno la tiene. Usa `git worktree list --porcelain` que es el formato
 * estable documentado.
 */
function worktreeUsingBranch(ROOT, branchName, execImpl = execSync) {
    let out;
    try {
        out = execImpl('git worktree list --porcelain', {
            cwd: ROOT, ...EXEC_OPTS_DEFAULT, timeout: 10000,
        });
    } catch {
        return null;
    }
    const target = `branch refs/heads/${branchName}`;
    const lines = out.split('\n');
    let currentWorktree = null;
    for (const raw of lines) {
        const line = raw.trim();
        if (line.startsWith('worktree ')) {
            currentWorktree = line.slice('worktree '.length).trim();
        } else if (line === target) {
            return currentWorktree;
        } else if (line === '') {
            currentWorktree = null;
        }
    }
    return null;
}

/**
 * Crea un tag de backup `backup/orphan-<sanitized-branch>-<ts>` sobre la
 * branch huérfana antes de eliminarla. Best-effort: errores se loggean
 * pero no abortan la limpieza.
 */
function createOrphanBackupTag(ROOT, branchName, execImpl, log) {
    const sanitized = branchName.replace(/[/\\]/g, '-');
    const tagName = `backup/orphan-${sanitized}-${Date.now()}`;
    try {
        execImpl(`git tag "${tagName}" "${branchName}"`, {
            cwd: ROOT, ...EXEC_OPTS_DEFAULT, timeout: 10000,
        });
        log?.(`Backup tag creado: ${tagName} → ${branchName}`);
        return tagName;
    } catch (e) {
        log?.(`⚠️ No se pudo crear backup tag para ${branchName}: ${e.message}`);
        return null;
    }
}

/**
 * Entry point principal. Garantiza que existe un worktree fresco listo para
 * que el agente trabaje, recuperándose de estados degradados previos.
 *
 * @param {object} params
 * @param {string} params.ROOT            Ruta absoluta al repo principal.
 * @param {string|number} params.issue    Número de issue (debe ser numérico).
 * @param {string} params.skill           Skill (a-z, 0-9, guiones).
 * @param {function} [params.log]         Callback de log opcional.
 * @param {function} [params.execImpl]    Inyectable para tests.
 * @param {object} [params.fsImpl]        Inyectable para tests.
 */
function ensureLaunchWorktree({
    ROOT,
    issue,
    skill,
    log,
    execImpl = execSync,
    fsImpl = fs,
}) {
    validateInputs(issue, skill);

    const worktreeBranch = `agent/${issue}-${skill}`;
    const worktreePath = path.join(ROOT, '..', `platform.agent-${issue}-${skill}`);

    // (1) Idempotencia: si el worktree ya existe, no tocamos nada.
    if (fsImpl.existsSync(worktreePath)) {
        return { worktreePath, worktreeBranch, created: false, recovered: false };
    }

    // (2) Prune defensivo: limpia entries de `.git/worktrees/` cuyo directorio
    // físico ya no existe. Sin esto, un intento anterior con cleanup parcial
    // puede dejar git pensando que la branch está en uso.
    try {
        execImpl('git worktree prune', {
            cwd: ROOT, ...EXEC_OPTS_DEFAULT, timeout: 10000,
        });
    } catch (e) {
        log?.(`⚠️ git worktree prune falló (continúo): ${e.message}`);
    }

    let recovered = false;

    // (3) Detección de branch huérfana.
    if (localBranchExists(ROOT, worktreeBranch, execImpl)) {
        const usedBy = worktreeUsingBranch(ROOT, worktreeBranch, execImpl);
        if (usedBy) {
            throw new WorktreeLaunchError(
                `Branch ${worktreeBranch} en uso por worktree activo: ${usedBy}. ` +
                `No re-creo el worktree de #${issue} para no pisar trabajo vivo.`,
                'BRANCH_IN_USE',
            );
        }

        // Branch huérfana — backup + delete.
        createOrphanBackupTag(ROOT, worktreeBranch, execImpl, log);
        try {
            execImpl(`git branch -D "${worktreeBranch}"`, {
                cwd: ROOT, ...EXEC_OPTS_DEFAULT, timeout: 10000,
            });
            log?.(`Branch huérfana eliminada: ${worktreeBranch}`);
            recovered = true;
        } catch (e) {
            throw new WorktreeLaunchError(
                `No se pudo eliminar branch huérfana ${worktreeBranch}: ${e.message}`,
                'BRANCH_DELETE_FAILED',
                e,
            );
        }
    }

    // (4) Crear worktree fresco desde origin/main.
    try {
        execImpl(`git worktree add "${worktreePath}" -b "${worktreeBranch}" origin/main`, {
            cwd: ROOT, ...EXEC_OPTS_DEFAULT,
        });
        log?.(`Worktree creado: ${worktreePath}`);
    } catch (e) {
        throw new WorktreeLaunchError(
            `git worktree add falló para #${issue}: ${e.message}`,
            'WORKTREE_ADD_FAILED',
            e,
        );
    }

    return { worktreePath, worktreeBranch, created: true, recovered };
}

module.exports = {
    ensureLaunchWorktree,
    WorktreeLaunchError,
    // Exports auxiliares para tests / herramientas operativas.
    localBranchExists,
    worktreeUsingBranch,
    validateInputs,
};

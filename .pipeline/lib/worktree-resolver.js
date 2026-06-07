// =============================================================================
// worktree-resolver.js — Resolución del worktree existente del issue para fases
// que NO crean código nuevo pero sí leen/escriben sobre el worktree ya creado
// por la fase dev (`build`, `linteo`, `aprobacion`, `entrega`).
//
// **Contexto / causa raíz** (issue #2591):
//   El bloque inline previo en `pulpo.js` (rama `useExistingWorktree`) caía a
//   `worktreePath = ROOT` cuando no encontraba `platform.agent-<issue>-*`.
//   Eso producía commits cruzados (delivery del issue A en la rama del B),
//   conflictos de rebase espurios y commits que requerían limpieza manual.
//   Documentado en el body del #2591 + análisis security + guru.
//
// **Diseño**:
//   - `resolveExistingWorktree({ ROOT, issue, skill, ... })` busca el worktree
//     del issue ejecutando `git worktree list --porcelain` con `spawnSync` y
//     array de argumentos (sin shell parsing → defense-in-depth contra inj).
//   - Validación dura de `issue` (`/^\d+$/`) y `skill` (regex segura). Se
//     reusa `validateInputs` de `worktree-launcher.js` para mantener la única
//     fuente de verdad sobre qué shape de input es aceptable.
//   - Si encuentra el worktree → `{ found: true, worktreePath, recovered: false }`.
//   - Si NO encuentra → intenta `attemptAutoRecovery` (best-effort) que valida
//     procedencia de la branch remota antes de recrear el worktree. Si la
//     recovery funciona, retorna `{ found: true, recovered: true }`. Si falla,
//     retorna `{ found: false, reason, branchOriginVerified }`.
//   - El caller decide el side-effect (rebote a pendiente, audit log, Telegram).
//     Este módulo NO hace I/O fuera de git.
//
// **Por qué NO usamos `execSync` con string interpolado**:
//   Aunque `validateInputs` rechaza los vectores conocidos (issue no numérico,
//   skill con caracteres inseguros), preferimos `spawnSync(['git', '...'])`
//   por defense-in-depth: si un día alguien rompe la validación previa por
//   error de refactor, el shell tampoco interpreta caracteres especiales.
//   Cinturón y tiradores.
//
// **Procedencia de branches remotas** (security CA-2):
//   Antes de auto-recovery, verificamos que `origin/agent/<issue>-<skill>`
//   fue creada por el pipeline. Aceptamos la branch si CUALQUIERA de:
//     - El autor del primer commit ∈ allowlist (`PIPELINE_COMMITTER_ALLOWLIST`).
//     - Algún commit del rango contiene el marcador `pipeline-v2` en el message.
//   Si ninguna condición se cumple → abortamos con `branchOriginVerified=false`
//   para que el caller emita el flag `branch-origin-unverified` (UX CA-5).
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { validateInputs, WorktreeLaunchError } = require('./worktree-launcher');

const DEFAULT_EXEC_OPTS = { encoding: 'utf8', timeout: 15000, windowsHide: true };

// Allowlist de autores aceptables para branches remotas creadas por el pipeline.
// Se compara contra `git log --format=%ae -1 <rev-list-root>`. Cualquier email
// que NO esté en esta lista hace que la verificación de procedencia falle.
// Si necesitamos agregar un nuevo committer (ej. nuevo bot del pipeline),
// se actualiza acá + commit + smoke test.
const PIPELINE_COMMITTER_ALLOWLIST = new Set([
    'noreply@anthropic.com',           // Co-Authored-By Claude
    'leito.larreta@gmail.com',         // Maintainer
    'pulpo@intrale.local',              // Pulpo bot
    'pipeline@intrale.local',           // Genérico pipeline
    '41898282+github-actions[bot]@users.noreply.github.com', // GH Actions
]);

// Marcador que el pipeline embeb en commits para auto-recovery seguro.
// Si una branch remota contiene este marker en algún commit del rango,
// se considera creada por el pipeline (regardless del email del autor).
const PIPELINE_COMMIT_MARKER = 'pipeline-v2';

class WorktreeResolutionError extends Error {
    constructor(message, code, cause) {
        super(message);
        this.name = 'WorktreeResolutionError';
        this.code = code;
        if (cause) this.cause = cause;
    }
}

/**
 * Wrapper sobre `spawnSync` que devuelve stdout como string o lanza un error.
 * El array de args evita shell parsing → defense-in-depth.
 *
 * @param {string[]} args              Argumentos para `git`.
 * @param {object}   opts              Opciones `spawnSync` (cwd obligatorio).
 * @param {function} [opts.spawnImpl]  Inyectable para tests.
 */
function gitSpawn(args, opts = {}) {
    const { spawnImpl = spawnSync, cwd, timeout = DEFAULT_EXEC_OPTS.timeout } = opts;
    if (!cwd) throw new Error('gitSpawn: cwd es obligatorio');
    const res = spawnImpl('git', args, {
        cwd,
        encoding: 'utf8',
        timeout,
        windowsHide: true,
        shell: false,
    });
    if (res.error) throw res.error;
    if (typeof res.status === 'number' && res.status !== 0) {
        const err = new Error(`git ${args.join(' ')} exit=${res.status}: ${(res.stderr || '').trim()}`);
        err.stdout = res.stdout || '';
        err.stderr = res.stderr || '';
        err.code = res.status;
        throw err;
    }
    return res.stdout || '';
}

/**
 * Parsea la salida de `git worktree list --porcelain` y devuelve un array de
 * `{ worktree, branch }`. Formato estable documentado por git.
 */
function parseWorktreeList(porcelain) {
    const entries = [];
    let current = null;
    for (const raw of String(porcelain || '').split('\n')) {
        const line = raw.trim();
        if (line.startsWith('worktree ')) {
            if (current) entries.push(current);
            current = { worktree: line.slice('worktree '.length).trim(), branch: null };
        } else if (line.startsWith('branch ')) {
            if (current) current.branch = line.slice('branch '.length).trim();
        } else if (line === '' && current) {
            entries.push(current);
            current = null;
        }
    }
    if (current) entries.push(current);
    return entries;
}

/**
 * Cuenta los commits de `branchRef` que NO están en `origin/main`. Best-effort:
 * cualquier fallo (ref inexistente, sin red para el cálculo local, etc.) cuenta
 * como 0 — preferimos no romper la resolución por un conteo que no se pudo hacer.
 *
 * @param {string}   ROOT       Checkout principal donde corre el rev-list.
 * @param {string}   branchRef  Ref del worktree (ej. `refs/heads/agent/3733-pipeline-dev`).
 */
function countCommitsAhead(ROOT, branchRef, { spawnImpl = spawnSync } = {}) {
    if (!branchRef) return 0;
    try {
        const out = gitSpawn(['rev-list', '--count', `origin/main..${branchRef}`], {
            cwd: ROOT, spawnImpl, timeout: 10000,
        });
        const n = parseInt(String(out).trim(), 10);
        return Number.isFinite(n) ? n : 0;
    } catch {
        return 0;
    }
}

/**
 * Busca el worktree del issue por patrón `platform.agent-<issue>-*` (case
 * sensitive, igual que git). Retorna el worktree elegido o null.
 *
 * Excluye explícitamente entradas cuyo directorio físico ya no existe — git
 * a veces retiene entries muertas en `.git/worktrees/` hasta el próximo prune.
 *
 * **Desambiguación con múltiples worktrees del mismo issue** (issues #3733/#3736):
 *   Un issue puede tener más de un worktree `platform.agent-<issue>-*` cuando
 *   fue ruteado a más de un skill, o cuando quedó un worktree huérfano de un
 *   misroute previo. El match por prefijo a secas devolvía el PRIMERO según el
 *   orden de `git worktree list` — que podía ser un worktree vacío (0 commits)
 *   en vez del worktree del dev que efectivamente trabajó. Eso producía
 *   `pr:no-commits` en linteo/build aunque el worktree correcto tenía el commit.
 *   (Incidente real #3733 rev-1: linteo resolvió `platform.agent-3733-backend-dev`
 *   con 0 commits en lugar de `platform.agent-3733-pipeline-dev` con el trabajo.
 *   Mismo patrón en #3736 rev-1 con `agent/3736-backend-dev` vacío.)
 *
 *   Cuando hay varios candidatos desempatamos:
 *     1. Match EXACTO por skill (`platform.agent-<issue>-<skill>`) si `skill` viene.
 *        Útil para fases que conocen el skill del dev (no para `linter`, cuyo
 *        skill no nombra ningún worktree).
 *     2. El worktree con MÁS commits sobre `origin/main` (el que trabajó). Esto
 *        cubre el caso del linter, que corre como skill="linter" y no puede
 *        matchear por nombre.
 *   Con un único candidato el comportamiento es idéntico al previo (sin git
 *   calls extra) — la desambiguación solo paga su costo cuando hay colisión.
 *
 * @param {string|number} issue
 * @param {object}  [opts]
 * @param {string}  [opts.skill]  Skill para preferir match exacto ante colisión.
 */
function findIssueWorktree(ROOT, issue, { skill = null, spawnImpl = spawnSync, fsImpl = fs } = {}) {
    const stdout = gitSpawn(['worktree', 'list', '--porcelain'], {
        cwd: ROOT, spawnImpl,
    });
    const entries = parseWorktreeList(stdout);
    const needle = `platform.agent-${issue}-`;

    // Candidatos del issue con path físico existente, preservando el orden de git.
    const candidates = [];
    for (const e of entries) {
        if (!e.worktree) continue;
        const base = path.basename(e.worktree);
        if (!base.startsWith(needle)) continue;
        // git puede mantener entradas obsoletas — verificamos que el path real exista.
        try {
            if (!fsImpl.existsSync(e.worktree)) continue;
        } catch { continue; }
        candidates.push(e);
    }

    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    // (1) Match exacto por skill.
    if (skill) {
        const exactBase = `platform.agent-${issue}-${skill}`;
        const exact = candidates.find((c) => path.basename(c.worktree) === exactBase);
        if (exact) return exact;
    }

    // (2) Preferir el worktree con más commits sobre origin/main.
    let best = candidates[0];
    let bestAhead = countCommitsAhead(ROOT, best.branch, { spawnImpl });
    for (let i = 1; i < candidates.length; i++) {
        const ahead = countCommitsAhead(ROOT, candidates[i].branch, { spawnImpl });
        if (ahead > bestAhead) {
            best = candidates[i];
            bestAhead = ahead;
        }
    }
    return best;
}

/**
 * Verifica si una branch remota existe en `origin`. Usa `git ls-remote --heads`
 * con timeout corto — si la red está mal preferimos no auto-recoverear.
 */
function remoteBranchExists(ROOT, branchName, { spawnImpl = spawnSync } = {}) {
    try {
        const stdout = gitSpawn(['ls-remote', '--heads', 'origin', `refs/heads/${branchName}`], {
            cwd: ROOT, spawnImpl, timeout: 10000,
        });
        return stdout.trim().length > 0;
    } catch {
        return false;
    }
}

/**
 * Validación de procedencia de una branch remota antes del auto-recovery.
 * Acepta la branch si CUALQUIERA es verdadera:
 *   1. Autor del PRIMER commit (cronológicamente) ∈ allowlist.
 *   2. Algún commit del rango contiene el marker `pipeline-v2` en el message.
 *
 * Retorna `{ ok, reason }`. `ok=true` significa que es seguro auto-recovery.
 *
 * Sin red o branch sin commits → `ok=false` (conservador).
 */
function verifyRemoteBranchOrigin(ROOT, branchName, { spawnImpl = spawnSync } = {}) {
    // Aseguramos tener refs locales actualizadas para el cálculo de rev-list.
    try {
        gitSpawn(['fetch', '--quiet', '--no-tags', 'origin', `refs/heads/${branchName}:refs/remotes/origin/${branchName}`], {
            cwd: ROOT, spawnImpl, timeout: 15000,
        });
    } catch (e) {
        return { ok: false, reason: `fetch-failed: ${e.message.slice(0, 120)}` };
    }

    const remoteRef = `origin/${branchName}`;

    // (1) Autor del primer commit que NO existe en main — eso aísla los commits
    // que la branch agregó sobre la base. Si el ancestro común con main es el
    // único commit, el rango está vacío y no podemos verificar — falla.
    let firstAuthor = null;
    try {
        const stdout = gitSpawn([
            'log', '--reverse', '--format=%ae',
            `origin/main..${remoteRef}`,
        ], { cwd: ROOT, spawnImpl, timeout: 10000 });
        const lines = stdout.split('\n').map(s => s.trim()).filter(Boolean);
        firstAuthor = lines[0] || null;
    } catch (e) {
        return { ok: false, reason: `log-author-failed: ${e.message.slice(0, 120)}` };
    }

    if (firstAuthor && PIPELINE_COMMITTER_ALLOWLIST.has(firstAuthor)) {
        return { ok: true, reason: `author-allowlisted:${firstAuthor}` };
    }

    // (2) Marcador en algún commit del rango (case-insensitive).
    try {
        const stdout = gitSpawn([
            'log', '--format=%B',
            `origin/main..${remoteRef}`,
        ], { cwd: ROOT, spawnImpl, timeout: 10000 });
        if (stdout.toLowerCase().includes(PIPELINE_COMMIT_MARKER.toLowerCase())) {
            return { ok: true, reason: 'pipeline-marker-found' };
        }
    } catch (e) {
        return { ok: false, reason: `log-marker-failed: ${e.message.slice(0, 120)}` };
    }

    return {
        ok: false,
        reason: firstAuthor
            ? `author-not-allowlisted:${firstAuthor}`
            : 'no-commits-on-branch-or-fetch-empty',
    };
}

/**
 * Intenta recrear el worktree desde `origin/agent/<issue>-<skill>` cuando
 * desapareció el worktree físico pero la branch remota sigue accesible.
 *
 * Pre-requisito: la branch remota debe pasar `verifyRemoteBranchOrigin`.
 *
 * Retorna:
 *   - `{ ok: true, worktreePath, branchOriginVerified: true }` si funcionó.
 *   - `{ ok: false, reason, branchOriginVerified }` si no.
 *
 * Si la branch local `agent/<issue>-<skill>` ya existe y NO está en uso por
 * otro worktree, la limpiamos primero (mismo patrón que `worktree-launcher`
 * para huérfanas) y luego `git worktree add` con `--force-if-current-checkout`
 * no se usa — preferimos `add` con `-B` que reescribe la branch local sin
 * preguntar. Backup tag previo para preservar el SHA.
 */
function attemptAutoRecovery(ROOT, issue, skill, { spawnImpl = spawnSync, fsImpl = fs, log } = {}) {
    const branchName = `agent/${issue}-${skill}`;
    const worktreePath = path.join(ROOT, '..', `platform.agent-${issue}-${skill}`);

    // Si el path ya existe (caso raro: la entrada de git desapareció pero el
    // directorio quedó) NO lo tocamos — preferimos abortar y que el operador
    // limpie. Auto-borrar paths que pueden tener trabajo no commiteado es
    // peligroso.
    try {
        if (fsImpl.existsSync(worktreePath)) {
            return {
                ok: false,
                reason: `worktree-path-exists-without-git-entry:${worktreePath}`,
                branchOriginVerified: null,
            };
        }
    } catch {}

    if (!remoteBranchExists(ROOT, branchName, { spawnImpl })) {
        return { ok: false, reason: `remote-branch-missing:${branchName}`, branchOriginVerified: null };
    }

    const verif = verifyRemoteBranchOrigin(ROOT, branchName, { spawnImpl });
    if (!verif.ok) {
        log?.(`⛔ auto-recovery rechazado: branch-origin-unverified (${verif.reason})`);
        return { ok: false, reason: `branch-origin-unverified:${verif.reason}`, branchOriginVerified: false };
    }

    // Prune defensivo + best-effort backup tag de la branch local si existe.
    try { gitSpawn(['worktree', 'prune'], { cwd: ROOT, spawnImpl, timeout: 10000 }); } catch {}

    try {
        // -B reescribe la branch local (si existía) apuntándola a origin/<branch>.
        // Esto es seguro porque ya verificamos la procedencia del remoto.
        gitSpawn([
            'worktree', 'add',
            worktreePath,
            '-B', branchName,
            `origin/${branchName}`,
        ], { cwd: ROOT, spawnImpl, timeout: 30000 });
        log?.(`♻️ Worktree recuperado para #${issue}: ${worktreePath} (verif: ${verif.reason})`);
        return {
            ok: true,
            worktreePath,
            branchOriginVerified: true,
            verificationReason: verif.reason,
        };
    } catch (e) {
        return {
            ok: false,
            reason: `worktree-add-failed:${e.message.slice(0, 200)}`,
            branchOriginVerified: true, // la verif sí pasó; el add fue lo que falló
        };
    }
}

/**
 * Entry point. Resuelve el worktree existente del issue. Si no lo encuentra,
 * intenta auto-recovery (best-effort, validado). El caller decide qué hacer
 * con el `{ found: false, ... }` (típicamente: audit + dedup + rebote infra).
 *
 * Esta función NO escribe en filesystem fuera de git. NO emite Telegram.
 * NO toca el archivo de trabajo. Solo lee `git` y opcionalmente crea el
 * worktree para auto-recovery.
 *
 * @param {object} params
 * @param {string} params.ROOT
 * @param {string|number} params.issue
 * @param {string} params.skill
 * @param {function} [params.log]      Callback de log opcional (string → void).
 * @param {function} [params.spawnImpl] Inyectable para tests (default: spawnSync).
 * @param {object}   [params.fsImpl]    Inyectable para tests (default: fs).
 * @param {boolean}  [params.allowAutoRecovery=true]
 *
 * @returns {object} {
 *   found: boolean,
 *   worktreePath?: string,
 *   recovered?: boolean,
 *   branchOriginVerified?: boolean|null,
 *   reason?: string,
 * }
 */
function resolveExistingWorktree({
    ROOT,
    issue,
    skill,
    log,
    spawnImpl = spawnSync,
    fsImpl = fs,
    allowAutoRecovery = true,
}) {
    // (1) Validación dura. Reusamos validateInputs del launcher → única fuente
    // de verdad. Si rompe acá, NO seguimos al spawn.
    validateInputs(issue, skill);

    // (2) Búsqueda directa del worktree por patrón. Pasamos `skill` para que,
    // ante múltiples worktrees del mismo issue, se prefiera el match exacto
    // (o el worktree con commits) en vez del primero arbitrario (#3733).
    let existing = null;
    try {
        existing = findIssueWorktree(ROOT, issue, { skill, spawnImpl, fsImpl });
    } catch (e) {
        log?.(`⚠️ git worktree list falló (continúo con auto-recovery si aplica): ${e.message.slice(0, 120)}`);
    }

    if (existing) {
        return {
            found: true,
            worktreePath: existing.worktree,
            recovered: false,
            branchOriginVerified: null,
        };
    }

    // (3) Sin worktree existente: intentar auto-recovery si está habilitado.
    if (!allowAutoRecovery) {
        return { found: false, reason: 'no-worktree-and-recovery-disabled', branchOriginVerified: null };
    }

    const rec = attemptAutoRecovery(ROOT, issue, skill, { spawnImpl, fsImpl, log });
    if (rec.ok) {
        return {
            found: true,
            worktreePath: rec.worktreePath,
            recovered: true,
            branchOriginVerified: rec.branchOriginVerified,
            verificationReason: rec.verificationReason,
        };
    }

    return {
        found: false,
        reason: rec.reason,
        branchOriginVerified: rec.branchOriginVerified,
    };
}

module.exports = {
    resolveExistingWorktree,
    findIssueWorktree,
    countCommitsAhead,
    parseWorktreeList,
    remoteBranchExists,
    verifyRemoteBranchOrigin,
    attemptAutoRecovery,
    WorktreeResolutionError,
    // Exports auxiliares para tests / herramientas operativas.
    PIPELINE_COMMITTER_ALLOWLIST,
    PIPELINE_COMMIT_MARKER,
};

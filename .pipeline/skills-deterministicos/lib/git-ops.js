'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

function runCmd(cmd, args, opts = {}) {
    const started = Date.now();
    const res = spawnSync(cmd, args, {
        cwd: opts.cwd,
        env: opts.env || process.env,
        encoding: 'utf8',
        timeout: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
        windowsHide: true,
        shell: opts.shell ?? (process.platform === 'win32'),
    });
    return {
        cmd: `${cmd} ${args.join(' ')}`,
        exit_code: res.status == null ? 1 : res.status,
        stdout: res.stdout || '',
        stderr: res.stderr || '',
        wall_ms: Date.now() - started,
        signal: res.signal || null,
        error: res.error ? res.error.message : null,
    };
}

function runGit(args, opts = {}) {
    return runCmd('git', args, opts);
}

// #2523 (rev-4): resolver `gh.exe` a una ruta absoluta en Windows. La causa
// del rebote del 2026-04-27 fue que el pulpo lanza delivery.js como hijo
// directo (cmd.exe), heredando un PATH que NO incluye `C:\Workspaces\gh-cli\
// bin`. La invocación `spawn('gh', ..., { shell: true })` deriva en cmd.exe
// que falla con "'gh' no se reconoce como un comando interno o externo".
//
// La memoria `github-cli.md` documenta que el binario vive en
// `/c/Workspaces/gh-cli/bin/gh.exe` y que en sesiones interactivas se
// agrega al PATH manualmente vía `export PATH=...`. Como el pulpo arranca
// como servicio (no necesariamente desde un shell con ese export), no
// podemos confiar en el PATH heredado.
//
// Estrategia de resolución (orden):
//   1. Si `process.env.PATH` ya tiene `gh.exe`, usar el primero encontrado.
//   2. Si no, probar ubicaciones conocidas de instalación en Windows.
//   3. Si nada matchea, caer a `'gh'` literal — falla visible con el mismo
//      error original (no peor que antes).
//
// El resultado se cachea por proceso (la ubicación no cambia en runtime).
// Para tests, exponemos `clearGhPathCache()` como helper interno.
let _ghPathCache;
function resolveGhPath() {
    if (process.platform !== 'win32') return 'gh';
    if (_ghPathCache !== undefined) return _ghPathCache;

    const isFile = (p) => {
        try {
            return fs.statSync(p).isFile();
        } catch { return false; }
    };

    // 1) Buscar en PATH (case-insensitive en Windows pero usamos los nombres tal cual)
    const rawPath = process.env.PATH || process.env.Path || '';
    const pathDirs = rawPath.split(path.delimiter).filter(Boolean);
    for (const dir of pathDirs) {
        const candidate = path.join(dir, 'gh.exe');
        if (isFile(candidate)) {
            _ghPathCache = candidate;
            return candidate;
        }
    }

    // 2) Ubicaciones conocidas de instalación en Windows
    const known = [
        'C:\\Workspaces\\gh-cli\\bin\\gh.exe',
        'C:\\Program Files\\GitHub CLI\\gh.exe',
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'GitHub CLI', 'gh.exe'),
        process.env.USERPROFILE && path.join(process.env.USERPROFILE, '.local', 'bin', 'gh.exe'),
        process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'GitHub CLI', 'gh.exe'),
    ].filter(Boolean);
    for (const candidate of known) {
        if (isFile(candidate)) {
            _ghPathCache = candidate;
            return candidate;
        }
    }

    // 3) Fallback: dejar la falla visible con el comando bare
    _ghPathCache = 'gh';
    return 'gh';
}

// Para tests: limpiar la cache y forzar re-resolución.
function clearGhPathCache() { _ghPathCache = undefined; }

// #2895 (rebote rev-1): resolver el directorio que contiene `git.exe` en
// Windows. Mismo patrón que resolveGhPath pero para git.
//
// Síntoma: en el rebote del 2026-04-30 los tests Node fallaron en producción
// con "git no se reconoce" / spawn ENOENT, aunque en local pasan. Causa:
// cuando el pulpo arranca como servicio Windows (no desde un shell con git
// en PATH) y spawnea tester.js, el env heredado puede no incluir
// `C:\Program Files\Git\cmd`. Al spawnear `node --test` con ese env, los
// test child processes que usan `spawnSync('git', ...)` o `execSync('git ...')`
// fallan con ENOENT — mismo bug que tuvimos con `gh.exe` (#2523 rev-4).
//
// La memoria `bash-limitations.md` documenta que el pipeline corre desde Node
// con cmd.exe como shell — no podemos asumir que PATH tenga git.
//
// Estrategia (orden):
//   1. Si `process.env.PATH` ya tiene `git.exe`, devolver ese directorio.
//   2. Probar ubicaciones conocidas de Git for Windows.
//   3. Si nada matchea, devolver `null` — el caller decide cómo seguir.
//
// El resultado se cachea por proceso. `clearGitDirCache()` lo resetea para tests.
let _gitDirCache;
function resolveGitDir() {
    if (process.platform !== 'win32') return null;
    if (_gitDirCache !== undefined) return _gitDirCache;

    const isFile = (p) => {
        try { return fs.statSync(p).isFile(); } catch { return false; }
    };

    // 1) Buscar en PATH actual
    const rawPath = process.env.PATH || process.env.Path || '';
    for (const dir of rawPath.split(path.delimiter).filter(Boolean)) {
        if (isFile(path.join(dir, 'git.exe'))) {
            _gitDirCache = dir;
            return dir;
        }
    }

    // 2) Ubicaciones conocidas de Git for Windows
    const known = [
        'C:\\Program Files\\Git\\cmd',
        'C:\\Program Files\\Git\\mingw64\\bin',
        'C:\\Program Files (x86)\\Git\\cmd',
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'cmd'),
        process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git', 'cmd'),
    ].filter(Boolean);
    for (const dir of known) {
        if (isFile(path.join(dir, 'git.exe'))) {
            _gitDirCache = dir;
            return dir;
        }
    }

    // 3) Fallback: null. El caller puede decidir si tirar o seguir sin git.
    _gitDirCache = null;
    return null;
}
function clearGitDirCache() { _gitDirCache = undefined; }

// #2895: devuelve un nuevo objeto env con git.exe accesible vía PATH.
// No muta el env recibido. Idempotente: si git ya está en PATH, no lo agrega
// dos veces. Si resolveGitDir devuelve null (no encontró git), devuelve el
// env tal cual (la falla seguirá siendo visible en el child con el mismo
// error que antes — no peor que sin el helper).
//
// Importante para Windows: si el env tenía claves `Path` y `PATH` con casing
// distinto, las normalizamos a `PATH` para evitar el caso ambiguo donde
// CreateProcess elige una de las dos.
function ensureGitInPath(env) {
    const out = { ...env };
    const gitDir = resolveGitDir();
    if (!gitDir) return out;

    // Normalizar a una sola key PATH (case-insensitive en Windows pero
    // case-sensitive en el objeto JS — dos keys con casing distinto en el
    // env que se pasa a spawn pueden producir resultados impredecibles).
    let currentPath = '';
    if ('PATH' in out) currentPath = out.PATH || '';
    else if ('Path' in out) currentPath = out.Path || '';
    else if ('path' in out) currentPath = out.path || '';

    const dirs = currentPath.split(path.delimiter).filter(Boolean);
    const lc = gitDir.toLowerCase();
    const alreadyIn = dirs.some((d) => d.toLowerCase() === lc);

    out.PATH = alreadyIn ? currentPath : `${gitDir}${path.delimiter}${currentPath}`;
    // Borrar variantes de casing para que el child reciba sólo una PATH.
    if ('Path' in out && out.Path !== out.PATH) delete out.Path;
    if ('path' in out && out.path !== out.PATH) delete out.path;
    return out;
}

function runGh(args, opts = {}) {
    const ghPath = resolveGhPath();
    // #2523 (rev-4): cuando resolvimos a una ruta absoluta, deshabilitamos
    // shell:true. spawnSync con shell:true en Windows enruta vía cmd.exe que
    // requiere quoting frágil para paths con espacios; con shell:false node
    // usa CreateProcess directo con la ruta literal, sin quoting issues.
    // Cuando ghPath==='gh' (fallback), respetamos el shell:true por defecto
    // del runCmd para que cmd.exe pueda hacer la búsqueda en PATH.
    const isAbs = ghPath !== 'gh';
    const optsOut = isAbs ? { ...opts, shell: false } : opts;
    return runCmd(ghPath, args, optsOut);
}

function getCurrentBranch(cwd) {
    const r = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
    return r.stdout.trim();
}

function getCurrentSha(cwd) {
    const r = runGit(['rev-parse', 'HEAD'], { cwd });
    return r.stdout.trim();
}

function getChangedFiles(cwd) {
    // Status porcelain: tres categorías
    //   ' M' / ' A' modificado pero no staged
    //   'M ' / 'A ' staged
    //   '??' untracked
    const r = runGit(['status', '--porcelain=v1'], { cwd });
    const files = [];
    for (const ln of r.stdout.split(/\r?\n/)) {
        if (!ln.trim()) continue;
        const code = ln.slice(0, 2);
        const path = ln.slice(3);
        files.push({ code, path, staged: code[0] !== ' ' && code[0] !== '?' });
    }
    return files;
}

function getDiffStats(cwd, base = 'origin/main') {
    const r = runGit(['diff', '--shortstat', `${base}...HEAD`], { cwd });
    // Output ej: " 5 files changed, 123 insertions(+), 4 deletions(-)"
    const out = r.stdout.trim();
    const parsed = { files_changed: 0, additions: 0, deletions: 0 };
    if (!out) return parsed;
    const mFiles = out.match(/(\d+)\s+files?\s+changed/);
    const mAdd = out.match(/(\d+)\s+insertions?/);
    const mDel = out.match(/(\d+)\s+deletions?/);
    if (mFiles) parsed.files_changed = parseInt(mFiles[1], 10);
    if (mAdd) parsed.additions = parseInt(mAdd[1], 10);
    if (mDel) parsed.deletions = parseInt(mDel[1], 10);
    return parsed;
}

function fetchOrigin(cwd) {
    return runGit(['fetch', 'origin', 'main'], { cwd, timeoutMs: 60 * 1000 });
}

function rebaseOnto(cwd, base = 'origin/main') {
    // #2519 (rev-2): --autostash es defensa en profundidad para el caso en que
    // el árbol de trabajo tenga archivos tracked modificados que SAFE_IGNORE
    // (delivery.js) decidió no commitear (heartbeats, agent-registry, activity-
    // logger, metrics-history). Sin --autostash, git rebase falla con
    // "cannot rebase: You have unstaged changes" aunque esos archivos sean
    // estado transitorio del pipeline en marcha. --autostash los stashea antes
    // del rebase y los reaplica después; como main nunca toca esos paths, el
    // pop es conflict-free.
    return runGit(['rebase', '--autostash', base], { cwd, timeoutMs: 60 * 1000 });
}

function rebaseAbort(cwd) {
    return runGit(['rebase', '--abort'], { cwd });
}

function pushBranch(cwd, branch) {
    // --force-with-lease es seguro tras rebase (no pisa cambios ajenos al upstream conocido)
    // #2523 (rev-3): timeout subido de 2min a 5min. La red de Leo tarda ~90-120s
    // en pushes con muchos objects (p.ej. assets/mockups/narrativa-lili.mp3) y
    // 2min era exactamente el borde — spawnSync mataba el proceso justo cuando
    // git terminaba de transferir, devolviendo exit_code != 0 con stderr vacío
    // aunque el push había completado en el remote.
    return runGit(['push', '--force-with-lease', '-u', 'origin', branch], { cwd, timeoutMs: 5 * 60 * 1000 });
}

// #2523 (rev-3): helper para verificar el SHA actual de un ref en origin.
// Usado por pushAndVerify para distinguir "push falló de verdad" (remote sin
// nuestros commits) de "spawnSync timeout pero git terminó" (remote == HEAD).
function getRemoteSha(cwd, ref) {
    const r = runGit(['ls-remote', 'origin', ref], { cwd, timeoutMs: 30 * 1000 });
    if (r.exit_code !== 0) return null;
    const line = (r.stdout || '').trim().split(/\r?\n/)[0] || '';
    const sha = line.split(/\s+/)[0] || '';
    return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
}

// #2523 (rev-3): decisión pura sobre el outcome del push.
// Separada de pushAndVerify para poder testearse sin spawnear git real.
//
// Reglas:
// - exit_code === 0  → éxito directo (push OK).
// - exit_code !== 0 + localSha === remoteSha → push completó en el remote
//   pero spawnSync devolvió error transitorio (timeout, signal SIGKILL,
//   stderr vacío). Tratamos como éxito recuperado y logueamos por qué.
// - exit_code !== 0 + SHAs no coinciden → fallo real. Propagamos diagnóstico
//   rico (signal/error/sha local/sha remote) para que el rebote sea accionable.
function decidePushOutcome({ pushRes, localSha, remoteSha, branch }) {
    if (pushRes.exit_code === 0) {
        return { ...pushRes, verified: true, recovered: false };
    }
    if (localSha && remoteSha && localSha === remoteSha) {
        const shortLocal = localSha.slice(0, 7);
        return {
            ...pushRes,
            exit_code: 0,
            verified: true,
            recovered: true,
            recovered_reason:
                `local SHA (${shortLocal}) == origin/${branch} SHA — ` +
                `push completó pese a exit_code=${pushRes.exit_code} ` +
                `signal=${pushRes.signal || 'none'}`,
        };
    }
    return {
        ...pushRes,
        verified: false,
        recovered: false,
        local_sha: localSha,
        remote_sha: remoteSha,
    };
}

// #2523 (rev-3): pushBranch con verificación post-push contra origin.
// Si pushBranch reporta exit_code != 0 pero el remote ya tiene el SHA local
// (push completó pero spawnSync devolvió error transitorio: timeout, signal,
// stderr vacío), tratamos como éxito y lo logueamos para diagnóstico.
// Si el remote NO coincide → fallo real, propagamos el error original.
//
// Caso histórico (rebote-3 del #2523, 2026-04-27): push tardó 126s, spawnSync
// timeout @ 120s, exit_code=1, stderr="", pero `git rev-parse origin/agent/
// 2523-dashboard-visual-redesign` post-fetch == HEAD local. Esto rebotaba al
// agente y lo llevaba al circuit breaker (rebote_numero=3) por un fallo
// puramente cosmético del orquestador.
function pushAndVerify(cwd, branch) {
    const pushRes = pushBranch(cwd, branch);
    if (pushRes.exit_code === 0) {
        return decidePushOutcome({ pushRes, localSha: null, remoteSha: null, branch });
    }
    const localSha = getCurrentSha(cwd);
    const remoteSha = getRemoteSha(cwd, `refs/heads/${branch}`);
    return decidePushOutcome({ pushRes, localSha, remoteSha, branch });
}

// ── Builders de mensajes ──────────────────────────────────────────────
const TYPE_BY_PREFIX = [
    { rx: /^agent\/\d+-/i, type: 'feat' },
    { rx: /^feature\//i, type: 'feat' },
    { rx: /^bugfix\//i, type: 'fix' },
    { rx: /^fix\//i, type: 'fix' },
    { rx: /^docs?\//i, type: 'docs' },
    { rx: /^refactor\//i, type: 'refactor' },
    { rx: /^test\//i, type: 'test' },
    { rx: /^chore\//i, type: 'chore' },
];

function inferCommitType(branch) {
    for (const { rx, type } of TYPE_BY_PREFIX) {
        if (rx.test(branch)) return type;
    }
    return 'chore';
}

function inferScope(files, fallback = 'general') {
    if (!files || !files.length) return fallback;
    const top = new Map();
    for (const f of files) {
        const seg = (f.path || f).split('/')[0];
        if (!seg) continue;
        top.set(seg, (top.get(seg) || 0) + 1);
    }
    if (!top.size) return fallback;
    const sorted = [...top.entries()].sort((a, b) => b[1] - a[1]);
    const winner = sorted[0][0];
    // Mapeo a scopes Intrale conocidos
    const scopeMap = {
        '.pipeline': 'pipeline',
        '.claude': 'pipeline',
        backend: 'backend',
        users: 'users',
        app: 'app',
        docs: 'docs',
        tools: 'tools',
        buildSrc: 'build',
        scripts: 'scripts',
    };
    return scopeMap[winner] || winner;
}

function buildCommitMessage({ issue, title, body, branch, files }) {
    const type = inferCommitType(branch);
    const scope = inferScope(files);
    const safeTitle = (title || `entrega #${issue}`).replace(/^\s*\[\w+\]\s*/, '').trim();
    const subject = `${type}(${scope}): ${safeTitle}`;
    const lines = [subject];
    if (body && body.trim()) {
        lines.push('', body.trim());
    }
    lines.push('', `Closes #${issue}`);
    return lines.join('\n');
}

function buildPRBody({ issue, title, summaryBullets, testPlan, qaLabel }) {
    const bullets = (summaryBullets && summaryBullets.length)
        ? summaryBullets.map((b) => `- ${b}`).join('\n')
        : `- Cambios automatizados del pipeline V3 para issue #${issue}`;

    const tests = (testPlan && testPlan.length)
        ? testPlan.map((t) => `- [x] ${t}`).join('\n')
        : `- [x] Pipeline V3 ejecutó builder + tester (gates verdes)\n- [x] QA: \`${qaLabel || 'qa:skipped'}\` aplicado`;

    return `## Resumen\n\n${bullets}\n\n## Plan de pruebas\n\n${tests}\n\n## Closes\n\nCloses #${issue}\n`;
}

module.exports = {
    runCmd,
    runGit,
    runGh,
    resolveGhPath,
    clearGhPathCache,
    resolveGitDir,
    clearGitDirCache,
    ensureGitInPath,
    getCurrentBranch,
    getCurrentSha,
    getChangedFiles,
    getDiffStats,
    fetchOrigin,
    rebaseOnto,
    rebaseAbort,
    pushBranch,
    pushAndVerify,
    decidePushOutcome,
    getRemoteSha,
    inferCommitType,
    inferScope,
    buildCommitMessage,
    buildPRBody,
};

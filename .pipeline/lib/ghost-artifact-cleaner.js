#!/usr/bin/env node
'use strict';

// =============================================================================
// ghost-artifact-cleaner.js — Garbage collector de artifacts huérfanos en
// carpetas operacionales del pipeline V2 (#3638).
//
// Diseño
// ------
// Barre `.pipeline/definicion/**` y `.pipeline/desarrollo/**` buscando
// archivos `.md`/`.txt`/`.json` que sean artifacts auxiliares según
// `lib/marker-artifact.isMarkerArtifact` (sufijos `.comment.md`,
// `.guidance.txt`, `.reason.json`) cuyo issue asociado:
//
//   (a) está CERRADO en GitHub,
//   (b) NO tiene `.work`/`.build`/`<issue>.<skill>` (marker activo) en la
//       carpeta padre.
//
// Si ambos se cumplen → archiva el archivo (mueve, NO elimina) a
// `.pipeline/archivado/ghost-<timestamp>/<path relativo>` y registra una
// línea JSONL en `.pipeline/audit/ghost-artifacts-cleanup.jsonl`.
//
// Modos:
//   --dry-run   (default fail-safe): lista candidatos, no toca disco.
//   --execute  : archiva candidatos confirmados.
//
// Reglas de seguridad (CA-SEC-1..7):
//   - path.resolve src debe quedar bajo `.pipeline/definicion/` o
//     `.pipeline/desarrollo/`. path.resolve dst debe quedar bajo
//     `.pipeline/archivado/`. Rechazo explícito fuera de scope.
//   - `fs.lstatSync` rechaza symlinks (anti-attack).
//   - Filename matchea regex estricta antes de invocar `gh`.
//   - `gh` se invoca con `spawnSync` array-form, jamás `exec` con string.
//   - JSONL escrito con `JSON.stringify(obj) + '\n'`.
//   - `.gitignore` verificado al inicio: aborta si `archivado/` o `audit/`
//     no están ignored.
//   - Walk con maxDepth 5 y timeout total 60s.
//
// Reglas operativas (CA-OPS-1..4):
//   - Lock cooperativo vía `lib/file-lock.withLock` sobre
//     `.pipeline/locks/ghost-cleaner.lock`. Timeout 5s; si no lo agarra,
//     registra skip y reintenta en próximo tick.
//   - Fail-safe `gh` down: si `gh issue view` falla o supera 10s, NO archiva.
//   - Idempotencia: si el archivo ya existe en `archivado/ghost-*/<mismo
//     path relativo>`, registra `no-op` y skip.
//   - Logging con prefijo `[ghost-artifact]` en `console.log/error`.
//
// API:
//   await runOnce({ mode, pipelineRoot, repoRoot, now, ghTimeoutMs, logger })
//     → { scanned, candidates, archived, skipped, errors, durationMs }
//
//   CLI:
//     node .pipeline/lib/ghost-artifact-cleaner.js [--execute|--dry-run]
// =============================================================================

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { withLock } = require('./file-lock');
const { isMarkerArtifact } = require('./marker-artifact');

// ─── Constantes ─────────────────────────────────────────────────────────────

const PIPELINES = ['definicion', 'desarrollo'];
const ACTIVE_STATES = ['pendiente', 'trabajando', 'listo', 'bloqueado-humano', 'bloqueado-dependencias'];
const MAX_WALK_DEPTH = 5;
const WALK_TIMEOUT_MS = 60 * 1000;
const GH_TIMEOUT_MS_DEFAULT = 10 * 1000;
const LOCK_TIMEOUT_MS = 5 * 1000;
const LOG_PREFIX = '[ghost-artifact]';

// Regex estricta para extraer issue de filename: <digits>.<skill>[.suffix]
// `skill` permite letras, dígitos y guiones. `suffix` es uno de los conocidos.
// Esto previene command injection en `gh issue view`.
const FILENAME_REGEX = /^(\d+)\.[a-z][a-z0-9-]*(?:\.(?:comment\.md|guidance\.txt|reason\.json|reason\.resolved(?:-\d+)?\.json))?$/;

// Sólo estos sufijos califican como artifact candidato a limpieza.
const ARTIFACT_SUFFIXES = ['.comment.md', '.guidance.txt', '.reason.json'];

// ─── Helpers ────────────────────────────────────────────────────────────────

function defaultLogger() {
    return {
        info: (msg) => console.log(`${LOG_PREFIX} ${msg}`),
        warn: (msg) => console.warn(`${LOG_PREFIX} ${msg}`),
        error: (msg) => console.error(`${LOG_PREFIX} ${msg}`),
    };
}

function isUnderPrefix(absolutePath, prefix) {
    const norm = path.resolve(absolutePath) + path.sep;
    const pre = path.resolve(prefix) + path.sep;
    return norm.startsWith(pre);
}

/** Verifica que .pipeline/archivado/ y .pipeline/audit/ estén gitignored. */
function verifyGitignore(repoRoot, logger) {
    const giFile = path.join(repoRoot, '.gitignore');
    let content = '';
    try { content = fs.readFileSync(giFile, 'utf8'); }
    catch {
        logger.error(`.gitignore no encontrado en ${repoRoot}`);
        return { ok: false, reason: 'gitignore-missing' };
    }
    const required = ['.pipeline/archivado/', '.pipeline/audit/'];
    const missing = required.filter(p => !new RegExp(`(^|\\n)${p.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*(\\n|$)`).test(content));
    if (missing.length > 0) {
        return { ok: false, reason: `gitignore-missing-paths: ${missing.join(', ')}` };
    }
    return { ok: true };
}

/** Filename matchea regex estricta de issue.skill[.suffix]. */
function safeIssueFromFilename(filename) {
    const m = FILENAME_REGEX.exec(filename);
    if (!m) return null;
    return m[1];
}

function isCandidateFilename(name) {
    // Solo nos interesan archivos que son artifacts auxiliares; los markers
    // de skill (`<issue>.<skill>`) NO se tocan acá.
    if (!isMarkerArtifact(name)) return false;
    return ARTIFACT_SUFFIXES.some(s => name.endsWith(s));
}

/** ¿Existe marker activo del mismo issue en la carpeta padre? */
function hasActiveSibling(dir, issue) {
    const prefix = String(issue) + '.';
    let entries;
    try { entries = fs.readdirSync(dir); } catch { return false; }
    for (const f of entries) {
        if (!f.startsWith(prefix)) continue;
        if (f === '.gitkeep') continue;
        // .work / .build cuentan como actividad
        if (f.endsWith('.work') || f.endsWith('.build')) return true;
        // marker de skill (<issue>.<skill>) cuenta como actividad
        if (!isMarkerArtifact(f)) return true;
    }
    return false;
}

/** Consulta GitHub si el issue está OPEN o CLOSED vía `gh`. Fail-safe. */
function issueState(issueNumber, opts = {}) {
    const ghTimeout = opts.ghTimeoutMs || GH_TIMEOUT_MS_DEFAULT;
    // CA-SEC-4: spawn array-form. issueNumber ya validado por regex.
    const result = spawnSync('gh', ['issue', 'view', String(issueNumber), '--json', 'state'], {
        timeout: ghTimeout,
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
    });
    if (result.error || result.status !== 0) {
        return { ok: false, reason: result.error?.code === 'ETIMEDOUT' ? 'gh-timeout' : 'gh-failed' };
    }
    try {
        const json = JSON.parse(result.stdout);
        return { ok: true, state: json.state };
    } catch {
        return { ok: false, reason: 'gh-bad-json' };
    }
}

/** Walk recursivo con maxDepth, rechaza symlinks. */
function walk(rootDir, opts = {}) {
    const maxDepth = opts.maxDepth || MAX_WALK_DEPTH;
    const deadline = opts.deadline || (Date.now() + WALK_TIMEOUT_MS);
    const out = [];
    function recurse(dir, depth) {
        if (depth > maxDepth) return;
        if (Date.now() > deadline) throw new Error('walk-timeout');
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            let lst;
            try { lst = fs.lstatSync(full); } catch { continue; }
            // CA-SEC-2: skipear symlinks.
            if (lst.isSymbolicLink()) {
                out.push({ kind: 'symlink', path: full, name: entry.name });
                continue;
            }
            if (lst.isDirectory()) {
                recurse(full, depth + 1);
            } else if (lst.isFile()) {
                out.push({ kind: 'file', path: full, name: entry.name });
            }
        }
    }
    recurse(rootDir, 0);
    return out;
}

/** Construye path relativo desde repo root → relPath estilo POSIX. */
function relFromRoot(repoRoot, absolutePath) {
    return path.relative(repoRoot, absolutePath).split(path.sep).join('/');
}

/** Append JSONL al audit log. CA-SEC-5: JSON.stringify exclusivo. */
function appendAudit(auditFile, entry) {
    fs.mkdirSync(path.dirname(auditFile), { recursive: true });
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(auditFile, line, { encoding: 'utf8' });
}

// ¿Existe ya el archivo en alguna carpeta `archivado/ghost-<stamp>/<relPath>`?
function alreadyArchived(archivadoRoot, relFromPipelineRoot) {
    let buckets;
    try { buckets = fs.readdirSync(archivadoRoot, { withFileTypes: true }); }
    catch { return null; }
    for (const b of buckets) {
        if (!b.isDirectory()) continue;
        if (!b.name.startsWith('ghost-')) continue;
        const candidate = path.join(archivadoRoot, b.name, relFromPipelineRoot);
        try {
            const st = fs.lstatSync(candidate);
            if (st.isFile()) return candidate;
        } catch { /* sigue */ }
    }
    return null;
}

// ─── Función principal ──────────────────────────────────────────────────────

/**
 * Ejecuta un ciclo de limpieza.
 *
 * @param {object} opts
 * @param {'dry-run'|'execute'} [opts.mode='dry-run']
 * @param {string} [opts.pipelineRoot] — default: `<repoRoot>/.pipeline`
 * @param {string} [opts.repoRoot] — default: cwd
 * @param {number} [opts.ghTimeoutMs]
 * @param {function} [opts.issueStateFn] — override para tests (no llamar `gh`)
 * @param {Date|number} [opts.now]
 * @param {object} [opts.logger]
 * @returns {Promise<{scanned, candidates, archived, skipped, errors, durationMs, bucket}>}
 */
async function runOnce(opts = {}) {
    const t0 = Date.now();
    const mode = opts.mode === 'execute' ? 'execute' : 'dry-run';
    const logger = opts.logger || defaultLogger();
    const repoRoot = opts.repoRoot || process.cwd();
    const pipelineRoot = opts.pipelineRoot || path.join(repoRoot, '.pipeline');
    const archivadoRoot = path.join(pipelineRoot, 'archivado');
    const auditFile = path.join(pipelineRoot, 'audit', 'ghost-artifacts-cleanup.jsonl');
    const issueStateFn = opts.issueStateFn || ((n) => issueState(n, opts));
    const now = opts.now ? new Date(opts.now) : new Date();
    const isoNow = now.toISOString();
    const bucketStamp = isoNow.replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-').slice(0, 15);
    const bucket = path.join(archivadoRoot, `ghost-${bucketStamp}`);

    // CA-SEC-6 (no-negociable): verificar gitignore antes de hacer nada.
    const giCheck = verifyGitignore(repoRoot, logger);
    if (!giCheck.ok) {
        const msg = `aborto: .gitignore no protege archivado/audit (${giCheck.reason})`;
        logger.error(msg);
        if (mode === 'execute') {
            appendAudit(auditFile, {
                timestamp: isoNow,
                action: 'error',
                reason: msg,
                context: 'gitignore-guard',
            });
        }
        return { scanned: 0, candidates: 0, archived: 0, skipped: 0, errors: 1, durationMs: Date.now() - t0, bucket: null, aborted: true };
    }

    let scanned = 0, candidates = 0, archived = 0, skipped = 0, errors = 0;
    const deadline = t0 + WALK_TIMEOUT_MS;
    let walkTimedOut = false;

    // Recorrer pipelines/fases/estados.
    for (const pipeline of PIPELINES) {
        const pipeDir = path.join(pipelineRoot, pipeline);
        let entries;
        try { entries = fs.readdirSync(pipeDir, { withFileTypes: true }); }
        catch { continue; }
        for (const phase of entries) {
            if (!phase.isDirectory()) continue;
            for (const state of ACTIVE_STATES) {
                const stateDir = path.join(pipeDir, phase.name, state);
                let files;
                try { files = walk(stateDir, { maxDepth: MAX_WALK_DEPTH, deadline }); }
                catch (e) {
                    if (e.message === 'walk-timeout') { walkTimedOut = true; break; }
                    errors++;
                    logger.error(`walk error en ${stateDir}: ${e.message}`);
                    continue;
                }
                for (const item of files) {
                    scanned++;
                    if (Date.now() > deadline) { walkTimedOut = true; break; }
                    if (item.kind === 'symlink') {
                        skipped++;
                        if (mode === 'execute') {
                            appendAudit(auditFile, {
                                timestamp: new Date().toISOString(),
                                action: 'skip',
                                file: relFromRoot(pipelineRoot, item.path),
                                reason: 'symlink',
                                context: 'walk',
                            });
                        }
                        continue;
                    }
                    // Solo candidatos: artifact auxiliar de los 3 sufijos.
                    if (!isCandidateFilename(item.name)) continue;

                    candidates++;
                    const issue = safeIssueFromFilename(item.name);
                    if (!issue) {
                        skipped++;
                        if (mode === 'execute') {
                            appendAudit(auditFile, {
                                timestamp: new Date().toISOString(),
                                action: 'skip',
                                file: relFromRoot(pipelineRoot, item.path),
                                reason: 'filename-regex-mismatch',
                                context: 'regex-guard',
                            });
                        }
                        continue;
                    }

                    // CA-SEC-1: validar paths.
                    const srcAbs = path.resolve(item.path);
                    const srcOk = isUnderPrefix(srcAbs, path.join(pipelineRoot, 'definicion')) ||
                                  isUnderPrefix(srcAbs, path.join(pipelineRoot, 'desarrollo'));
                    if (!srcOk) {
                        skipped++;
                        logger.warn(`src fuera de scope: ${srcAbs}`);
                        continue;
                    }

                    // CA-OPS-3 + idempotencia: ¿ya archivado en alguna corrida previa?
                    const relFromPipe = path.relative(pipelineRoot, srcAbs).split(path.sep).join('/');
                    const prev = alreadyArchived(archivadoRoot, relFromPipe);
                    if (prev) {
                        skipped++;
                        logger.info(`already archived: ${relFromPipe} → ${path.relative(pipelineRoot, prev).split(path.sep).join('/')}`);
                        if (mode === 'execute') {
                            appendAudit(auditFile, {
                                timestamp: new Date().toISOString(),
                                action: 'no-op',
                                file: relFromRoot(pipelineRoot, srcAbs),
                                reason: 'already archived',
                                archived_to: path.relative(pipelineRoot, prev).split(path.sep).join('/'),
                                context: 'idempotency',
                            });
                        }
                        continue;
                    }

                    // ¿hay marker activo del issue en la misma carpeta padre?
                    if (hasActiveSibling(path.dirname(srcAbs), issue)) {
                        skipped++;
                        logger.info(`skip ${item.name}: sibling activo en carpeta padre`);
                        continue;
                    }

                    // CA-OPS-2: fail-safe gh down.
                    const stateRes = issueStateFn(issue);
                    if (!stateRes.ok) {
                        skipped++;
                        logger.warn(`gh fail para issue #${issue}: ${stateRes.reason} — skip`);
                        if (mode === 'execute') {
                            appendAudit(auditFile, {
                                timestamp: new Date().toISOString(),
                                action: 'skip',
                                file: relFromRoot(pipelineRoot, srcAbs),
                                reason: `gh unavailable (${stateRes.reason})`,
                                context: 'fail-safe',
                            });
                        }
                        continue;
                    }
                    if (stateRes.state !== 'CLOSED') {
                        skipped++;
                        continue;
                    }

                    // Orfandad confirmada → archivar (o reportar en dry-run).
                    const dstAbs = path.resolve(path.join(bucket, relFromPipe));
                    if (!isUnderPrefix(dstAbs, archivadoRoot)) {
                        errors++;
                        logger.error(`dst fuera de scope: ${dstAbs}`);
                        continue;
                    }

                    if (mode === 'dry-run') {
                        logger.info(`DRY-RUN candidate: ${relFromPipe} (issue #${issue} CLOSED)`);
                        continue;
                    }

                    try {
                        fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
                        fs.renameSync(srcAbs, dstAbs);
                        archived++;
                        appendAudit(auditFile, {
                            timestamp: new Date().toISOString(),
                            action: 'cleanup',
                            file: relFromRoot(pipelineRoot, srcAbs),
                            reason: `orphaned (issue #${issue} CLOSED, no active marker in parent)`,
                            archived_to: path.relative(pipelineRoot, dstAbs).split(path.sep).join('/'),
                            context: 'runOnce',
                        });
                        logger.info(`archived: ${relFromPipe} → ${path.relative(pipelineRoot, dstAbs).split(path.sep).join('/')}`);
                    } catch (e) {
                        errors++;
                        appendAudit(auditFile, {
                            timestamp: new Date().toISOString(),
                            action: 'error',
                            file: relFromRoot(pipelineRoot, srcAbs),
                            reason: 'rename-failed',
                            error: e.message,
                            context: 'runOnce',
                        });
                        logger.error(`rename fail ${srcAbs}: ${e.message}`);
                    }
                }
                if (walkTimedOut) break;
            }
            if (walkTimedOut) break;
        }
        if (walkTimedOut) break;
    }

    if (walkTimedOut) {
        errors++;
        if (mode === 'execute') {
            appendAudit(auditFile, {
                timestamp: new Date().toISOString(),
                action: 'error',
                reason: 'walk-timeout exceeded (60s)',
                context: 'walk-guard',
            });
        }
        logger.error('walk-timeout: sweep abortado por exceder 60s');
    }

    return {
        scanned, candidates, archived, skipped, errors,
        durationMs: Date.now() - t0,
        bucket: archived > 0 ? path.relative(pipelineRoot, bucket).split(path.sep).join('/') : null,
        aborted: false,
    };
}

/**
 * Wrapper con lock. Si no agarra el lock en LOCK_TIMEOUT_MS, registra skip y
 * retorna sin tocar nada. Esto es lo que llama `pulpo.js` y el CLI.
 */
async function runWithLock(opts = {}) {
    const logger = opts.logger || defaultLogger();
    const repoRoot = opts.repoRoot || process.cwd();
    const pipelineRoot = opts.pipelineRoot || path.join(repoRoot, '.pipeline');
    const lockDir = path.join(pipelineRoot, 'locks');
    fs.mkdirSync(lockDir, { recursive: true });
    const lockTarget = path.join(lockDir, 'ghost-cleaner');
    try {
        return await withLock(lockTarget, async () => runOnce({ ...opts, pipelineRoot, repoRoot }), {
            timeoutMs: LOCK_TIMEOUT_MS,
            component: 'ghost-artifact-cleaner',
        });
    } catch (e) {
        logger.warn(`lock busy o timeout (${e.message}) — skip ciclo`);
        return { scanned: 0, candidates: 0, archived: 0, skipped: 0, errors: 0, durationMs: 0, bucket: null, aborted: true, lockSkip: true };
    }
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function parseCliArgs(argv) {
    const args = { mode: 'dry-run' };
    for (const a of argv) {
        if (a === '--execute') args.mode = 'execute';
        else if (a === '--dry-run') args.mode = 'dry-run';
    }
    return args;
}

async function main() {
    const args = parseCliArgs(process.argv.slice(2));
    const logger = defaultLogger();
    logger.info(`mode=${args.mode}`);
    const repoRoot = process.env.PIPELINE_REPO_ROOT || process.cwd();
    const result = await runWithLock({ mode: args.mode, repoRoot, logger });
    logger.info(`done: ${JSON.stringify(result)}`);
    process.exit(result.errors > 0 || result.aborted ? 1 : 0);
}

if (require.main === module) {
    main().catch((e) => {
        console.error(`${LOG_PREFIX} fatal: ${e.message}`);
        process.exit(2);
    });
}

module.exports = {
    runOnce,
    runWithLock,
    // Exposed for tests:
    _internal: {
        safeIssueFromFilename,
        isCandidateFilename,
        hasActiveSibling,
        verifyGitignore,
        alreadyArchived,
        walk,
        FILENAME_REGEX,
        ARTIFACT_SUFFIXES,
        MAX_WALK_DEPTH,
        WALK_TIMEOUT_MS,
        GH_TIMEOUT_MS_DEFAULT,
        LOCK_TIMEOUT_MS,
        LOG_PREFIX,
    },
};

// Detección de dependencias para pausa parcial (issue #2893).
//
// Resuelve el incidente del 2026-04-30: cuando el operador activa una pausa
// parcial con `allowed_issues: [X]` y X tiene dependencias abiertas que NO
// están en el allowlist, el issue queda habilitado pero bloqueado por sus
// propios pre-requisitos — el pipeline parece "trabado" sin avisar.
//
// Este módulo:
//   - Lee dependencias declaradas en el body/comments del issue (regex sobre
//     "Closes #N", "Depends on #N", "Split de #N", "Tracked by #N").
//   - Filtra issues cerrados.
//   - Recursión limitada a profundidad 3 (con warning si se llega al límite).
//   - Cache TTL 5 min (reusa el patrón de lib/recommendations.js).
//
// Inyección de dependencias para tests:
//   - ghRunner: spawnSync de gh por default; se mockea en tests con scripted runner.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PIPELINE_DIR = path.join(REPO_ROOT, '.pipeline');
const CACHE_FILE = path.join(PIPELINE_DIR, 'partial-pause-deps-cache.json');
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_DEPTH = 3;

// Regex para detectar referencias a issues en body/comments.
// Convenciones soportadas:
//   - Closes #N
//   - Depends on #N
//   - Split de #N
//   - Tracked by #N
//   - Blocks #N / Blocked by #N
const DEP_PATTERNS = [
    /\b(?:closes?|fix(?:es)?|resolves?)\s+#(\d+)/gi,
    /\bdepends?\s+on\s+#(\d+)/gi,
    /\bsplit\s+(?:de|of)\s+#(\d+)/gi,
    /\btracked\s+by\s+#(\d+)/gi,
    /\bblocked\s+by\s+#(\d+)/gi,
];

function defaultGhRunner(args, opts = {}) {
    const env = Object.assign({}, process.env, opts.env || {});
    const ghPath = process.env.GH_PATH || 'gh';
    const r = spawnSync(ghPath, args, {
        env,
        encoding: 'utf8',
        timeout: opts.timeoutMs || 30000,
    });
    return {
        ok: r.status === 0,
        stdout: r.stdout || '',
        stderr: r.stderr || '',
        status: r.status,
    };
}

function readCache(cacheFile = CACHE_FILE) {
    try {
        const raw = fs.readFileSync(cacheFile, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return emptyCache();
        return Object.assign(emptyCache(), parsed);
    } catch {
        return emptyCache();
    }
}

function emptyCache() {
    return { issues: {}, updatedAt: 0 };
}

function writeCache(cache, cacheFile = CACHE_FILE) {
    try {
        fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2), 'utf8');
    } catch {}
}

function isFresh(entry, now = Date.now()) {
    if (!entry || !entry.fetchedAt) return false;
    return (now - entry.fetchedAt) < CACHE_TTL_MS;
}

/**
 * Extrae dependencias declaradas en el body/comments con los patrones soportados.
 * Devuelve set de números únicos.
 * @param {string} text
 * @returns {number[]}
 */
function parseDepsFromText(text) {
    if (!text || typeof text !== 'string') return [];
    const found = new Set();
    for (const pattern of DEP_PATTERNS) {
        // Reset lastIndex porque las regex /g preservan estado.
        pattern.lastIndex = 0;
        let m;
        while ((m = pattern.exec(text)) !== null) {
            const n = parseInt(m[1], 10);
            if (Number.isInteger(n) && n > 0) found.add(n);
        }
    }
    return [...found].sort((a, b) => a - b);
}

/**
 * Consulta un issue vía gh y devuelve {state, deps[]}.
 * Usa cache TTL 5 min.
 * @returns {{state: 'open'|'closed'|'unknown', deps: number[], title: string, fetchedAt: number, error?: string}}
 */
function fetchIssueInfo(issueNum, { ghRunner = defaultGhRunner, repo = 'intrale/platform', cache = null, cacheFile = CACHE_FILE, now = Date.now() } = {}) {
    const c = cache || readCache(cacheFile);
    const key = String(issueNum);
    const existing = c.issues[key];
    if (existing && isFresh(existing, now)) {
        return existing;
    }

    const args = [
        'issue', 'view', String(issueNum),
        '--repo', repo,
        '--json', 'number,title,state,body,comments',
    ];
    const r = ghRunner(args);
    if (!r.ok) {
        const errEntry = {
            state: 'unknown',
            deps: [],
            title: '',
            fetchedAt: now,
            error: r.stderr ? r.stderr.split('\n')[0].trim() : `gh exit ${r.status}`,
        };
        c.issues[key] = errEntry;
        c.updatedAt = now;
        writeCache(c, cacheFile);
        return errEntry;
    }

    let parsed;
    try {
        parsed = JSON.parse(r.stdout);
    } catch {
        const errEntry = { state: 'unknown', deps: [], title: '', fetchedAt: now, error: 'json-parse' };
        c.issues[key] = errEntry;
        c.updatedAt = now;
        writeCache(c, cacheFile);
        return errEntry;
    }

    const body = parsed.body || '';
    const comments = (parsed.comments || []).map(co => co.body || '').join('\n');
    const deps = parseDepsFromText(body + '\n' + comments)
        .filter(n => n !== Number(issueNum)); // no auto-referencias

    const entry = {
        state: parsed.state ? parsed.state.toLowerCase() : 'unknown',
        deps,
        title: parsed.title || '',
        fetchedAt: now,
    };
    c.issues[key] = entry;
    c.updatedAt = now;
    writeCache(c, cacheFile);
    return entry;
}

/**
 * Resuelve recursivamente las dependencias abiertas de un issue.
 * Recursión limitada a MAX_DEPTH (3) — si se llega al límite emite warning.
 *
 * @returns {{
 *   openDeps: number[],
 *   chains: {[issueNum]: {title, deps}},
 *   truncated: boolean
 * }}
 */
function resolveOpenDeps(issueNum, opts = {}) {
    const { ghRunner = defaultGhRunner, repo = 'intrale/platform', cacheFile = CACHE_FILE, now = Date.now() } = opts;
    const cache = readCache(cacheFile);
    const visited = new Set();
    const openDeps = new Set();
    const chains = {};
    let truncated = false;

    function walk(num, depth) {
        const key = String(num);
        if (visited.has(key)) return;
        visited.add(key);
        if (depth > MAX_DEPTH) {
            truncated = true;
            return;
        }
        const info = fetchIssueInfo(num, { ghRunner, repo, cache, cacheFile, now });
        chains[key] = { title: info.title, deps: info.deps, state: info.state };
        for (const dep of info.deps) {
            // Para decidir si lo incluimos, necesitamos su estado.
            const subInfo = fetchIssueInfo(dep, { ghRunner, repo, cache, cacheFile, now });
            chains[String(dep)] = { title: subInfo.title, deps: subInfo.deps, state: subInfo.state };
            if (subInfo.state === 'open') openDeps.add(dep);
            // Recursión: profundizar incluso si el dep está cerrado podría revelar deps
            // abiertas anidadas — mejor cortar al primer nivel cerrado para evitar ruido.
            if (subInfo.state === 'open') {
                walk(dep, depth + 1);
            }
        }
    }

    walk(Number(issueNum), 0);
    return {
        openDeps: [...openDeps].sort((a, b) => a - b),
        chains,
        truncated,
    };
}

/**
 * Para una allowlist dada, encuentra los issues que tienen deps abiertas
 * que NO están en el allowlist.
 *
 * @returns {{
 *   missing: {[issueNum]: number[]},  // issue → deps faltantes
 *   chains: {[issueNum]: {...}},
 *   truncated: boolean
 * }}
 */
function findMissingDeps(allowlist, opts = {}) {
    const allowed = new Set((allowlist || []).map(n => Number(n)).filter(Boolean));
    const missing = {};
    const allChains = {};
    let truncated = false;

    for (const issue of allowed) {
        const { openDeps, chains, truncated: t } = resolveOpenDeps(issue, opts);
        if (t) truncated = true;
        Object.assign(allChains, chains);
        const missingForIssue = openDeps.filter(d => !allowed.has(d));
        if (missingForIssue.length > 0) {
            missing[String(issue)] = missingForIssue;
        }
    }

    return { missing, chains: allChains, truncated };
}

/**
 * Helper para construir la unión de un allowlist con sus deps detectadas.
 * Útil para la opción "Sí, incluir todas" del flujo.
 */
function allowlistWithDeps(allowlist, missing) {
    const out = new Set((allowlist || []).map(n => Number(n)).filter(Boolean));
    for (const deps of Object.values(missing || {})) {
        for (const d of deps) out.add(Number(d));
    }
    return [...out].sort((a, b) => a - b);
}

/**
 * Construye una "firma" estable para un par (issue, missingDeps) — usada por
 * el cooldown del Pulpo para no spamear la misma alerta.
 */
function alertSignature(issueNum, missingDeps) {
    const sorted = [...(missingDeps || [])].map(Number).filter(Boolean).sort((a, b) => a - b);
    return `${Number(issueNum)}:${sorted.join(',')}`;
}

module.exports = {
    CACHE_FILE,
    CACHE_TTL_MS,
    MAX_DEPTH,
    DEP_PATTERNS,
    parseDepsFromText,
    fetchIssueInfo,
    resolveOpenDeps,
    findMissingDeps,
    allowlistWithDeps,
    alertSignature,
    readCache,
    writeCache,
    isFresh,
    _emptyCache: emptyCache,
    _defaultGhRunner: defaultGhRunner,
};

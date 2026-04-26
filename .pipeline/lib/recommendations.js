// Recomendaciones generadas por agentes (issue #2653).
//
// Modelo: cuando un agente (guru, security, po, ux, review) detecta una
// oportunidad de mejora durante el análisis de un issue, crea un issue nuevo
// con labels:
//   - tipo:recomendacion  → marca el issue como recomendación
//   - needs-human          → bloquea el flujo automático del pulpo
//
// El humano revisa desde el dashboard y:
//   - aprueba: agrega `recommendation:approved` y quita `needs-human`. El
//     pulpo lo recoge en el próximo intake.
//   - rechaza: cierra el issue con label `recommendation:rejected`.
//
// Este módulo encapsula la lógica de cache + acciones, sin acoplarse al
// dashboard ni al pulpo. Probar via dependency-injection del runner gh.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PIPELINE_DIR = path.join(REPO_ROOT, '.pipeline');
const CACHE_FILE = path.join(PIPELINE_DIR, 'recommendations-cache.json');
const CACHE_TTL_MS = 5 * 60 * 1000;

const TIPO_LABEL = 'tipo:recomendacion';
const NEEDS_HUMAN_LABEL = 'needs-human';
const APPROVED_LABEL = 'recommendation:approved';
const REJECTED_LABEL = 'recommendation:rejected';

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
    return { items: [], updatedAt: 0, error: null };
}

function writeCache(cache, cacheFile = CACHE_FILE) {
    try {
        fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2), 'utf8');
    } catch {}
}

function isFresh(cache, now = Date.now()) {
    if (!cache || !cache.updatedAt) return false;
    return (now - cache.updatedAt) < CACHE_TTL_MS;
}

// Parsea el JSON de `gh issue list` y filtra los pendientes (sin
// `recommendation:approved` y sin `recommendation:rejected`). Devuelve la
// lista normalizada que persiste en cache.
function parseIssues(rawJson) {
    let issues;
    try {
        issues = JSON.parse(rawJson);
    } catch {
        return [];
    }
    if (!Array.isArray(issues)) return [];
    return issues
        .map(it => normalizeIssue(it))
        .filter(it => it && it.pending);
}

function normalizeIssue(it) {
    if (!it || typeof it.number !== 'number') return null;
    const labels = (it.labels || []).map(l => (typeof l === 'string' ? l : (l && l.name) || ''));
    const isReco = labels.includes(TIPO_LABEL);
    if (!isReco) return null;
    const approved = labels.includes(APPROVED_LABEL);
    const rejected = labels.includes(REJECTED_LABEL);
    if (approved || rejected) return null;
    const sourceAgent = detectSourceAgent(labels, it.title);
    const fromIssue = detectFromIssue(labels);
    return {
        number: it.number,
        title: it.title || '',
        url: it.url || '',
        labels,
        author: (it.author && it.author.login) || it.author || '',
        sourceAgent,
        fromIssue,
        createdAt: it.createdAt || null,
        pending: true,
    };
}

function detectSourceAgent(labels, title) {
    const m = (title || '').match(/^\[(guru|security|po|ux|review)\]/i);
    if (m) return m[1].toLowerCase();
    for (const l of labels) {
        if (l.startsWith('agent:')) return l.slice(6);
    }
    return 'unknown';
}

function detectFromIssue(labels) {
    for (const l of labels) {
        const m = l.match(/^from-issue:(\d+)$/);
        if (m) return Number(m[1]);
    }
    return null;
}

async function refreshCache({ ghRunner = defaultGhRunner, repo = 'intrale/platform', cacheFile = CACHE_FILE } = {}) {
    const args = [
        'issue', 'list',
        '--repo', repo,
        '--label', TIPO_LABEL,
        '--state', 'open',
        '--limit', '200',
        '--json', 'number,title,url,labels,author,createdAt',
    ];
    const r = ghRunner(args);
    const cache = emptyCache();
    if (!r.ok) {
        cache.error = r.stderr ? r.stderr.split('\n')[0] : `gh exit ${r.status}`;
        cache.updatedAt = Date.now();
        writeCache(cache, cacheFile);
        return cache;
    }
    cache.items = parseIssues(r.stdout);
    cache.updatedAt = Date.now();
    cache.error = null;
    writeCache(cache, cacheFile);
    return cache;
}

function approve({ issue, ghRunner = defaultGhRunner, repo = 'intrale/platform' }) {
    const num = String(issue);
    const addLabel = ghRunner(['issue', 'edit', num, '--repo', repo, '--add-label', APPROVED_LABEL]);
    if (!addLabel.ok) return { ok: false, msg: `No se pudo agregar label aprobado: ${addLabel.stderr || addLabel.status}` };
    const removeLabel = ghRunner(['issue', 'edit', num, '--repo', repo, '--remove-label', NEEDS_HUMAN_LABEL]);
    if (!removeLabel.ok) {
        return { ok: false, msg: `Aprobación parcial: agregado ${APPROVED_LABEL} pero falló remover ${NEEDS_HUMAN_LABEL}: ${removeLabel.stderr || removeLabel.status}` };
    }
    return { ok: true, msg: `Recomendación #${num} aprobada — entrará al pipeline en el próximo ciclo` };
}

function reject({ issue, reason = '', ghRunner = defaultGhRunner, repo = 'intrale/platform' }) {
    const num = String(issue);
    const addLabel = ghRunner(['issue', 'edit', num, '--repo', repo, '--add-label', REJECTED_LABEL]);
    if (!addLabel.ok) return { ok: false, msg: `No se pudo etiquetar rechazo: ${addLabel.stderr || addLabel.status}` };
    const closeArgs = ['issue', 'close', num, '--repo', repo, '--reason', 'not planned'];
    if (reason && reason.trim()) {
        closeArgs.push('--comment', `Recomendación rechazada: ${reason.trim()}`);
    }
    const close = ghRunner(closeArgs);
    if (!close.ok) return { ok: false, msg: `No se pudo cerrar el issue: ${close.stderr || close.status}` };
    return { ok: true, msg: `Recomendación #${num} rechazada y cerrada` };
}

module.exports = {
    CACHE_FILE,
    CACHE_TTL_MS,
    TIPO_LABEL,
    NEEDS_HUMAN_LABEL,
    APPROVED_LABEL,
    REJECTED_LABEL,
    readCache,
    writeCache,
    isFresh,
    parseIssues,
    refreshCache,
    approve,
    reject,
    _emptyCache: emptyCache,
    _defaultGhRunner: defaultGhRunner,
};

// Recomendaciones generadas por agentes (issue #2653).
//
// Modelo: cuando un agente (guru, security, po, ux, review) detecta una
// oportunidad de mejora durante el análisis de un issue, crea un issue nuevo
// con labels:
//   - tipo:recomendacion  → marca el issue como recomendación
//   - needs-human          → bloquea el flujo automático del pulpo
//
// El humano revisa desde el dashboard y:
//   - aprueba: agrega `recommendation:approved` y quita los labels que frenan
//     el intake — `needs-human` Y `needs:triage-backlog` (#5689 REQ-SEC-4: los
//     dos, porque durante el split de #5678 conviven). El pulpo lo recoge en el
//     próximo intake.
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

// #5689 REQ-SEC-4 — labels que `approve()` debe SACAR para que la recomendación
// entre efectivamente al intake.
//
// Por qué DOS y no uno: la secuencia obligatoria del split de #5678 mergea esta
// parte ANTES de la migración del backlog (#5691). Eso abre una ventana donde
// las recomendaciones todavía tienen `needs-human` y NO tienen todavía
// `needs:triage-backlog`. Si `approve()` sacara sólo el nuevo, `needs-human`
// quedaría puesto, el `--search` del intake seguiría excluyendo el issue, y el
// operador vería `{ok:true, "entrará al pipeline"}` mientras el issue NUNCA
// entra: éxito falso silencioso. Post-#5691 el caso se invierte.
//
// Sacar los dos es idempotente y sobrevive la ventana en ambas direcciones:
// `gh issue edit --remove-label X` con X presente en el REPO pero ausente en el
// ISSUE sale con exit 0 (no-op), y CA-1 de esta misma historia garantiza que
// `needs:triage-backlog` existe en el repo. Se puede simplificar a uno solo una
// vez que #5691 haya migrado el backlog entero.
const TRIAGE_BACKLOG_LABEL = 'needs:triage-backlog';
const APPROVE_REMOVE_LABELS = [NEEDS_HUMAN_LABEL, TRIAGE_BACKLOG_LABEL];

function approve({ issue, ghRunner = defaultGhRunner, repo = 'intrale/platform' }) {
    const num = String(issue);
    const addLabel = ghRunner(['issue', 'edit', num, '--repo', repo, '--add-label', APPROVED_LABEL]);
    if (!addLabel.ok) return { ok: false, msg: `No se pudo agregar label aprobado: ${addLabel.stderr || addLabel.status}` };
    // Se intentan TODOS aunque uno falle: si abortáramos en el primer error,
    // un fallo al remover `needs-human` dejaría `needs:triage-backlog` pegado
    // (o viceversa) y el issue igual quedaría fuera del intake, pero además con
    // el label de triaje colgado para siempre en la vista de bloqueados (R7).
    const failed = [];
    for (const label of APPROVE_REMOVE_LABELS) {
        const r = ghRunner(['issue', 'edit', num, '--repo', repo, '--remove-label', label]);
        if (!r.ok) failed.push(`${label} (${r.stderr || r.status})`);
    }
    if (failed.length) {
        // Fail-closed: el issue queda AFUERA del intake y el operador ve el error,
        // en vez de un éxito falso sobre un issue que nunca va a entrar.
        return { ok: false, msg: `Aprobación parcial: agregado ${APPROVED_LABEL} pero falló remover ${failed.join(' · ')}` };
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

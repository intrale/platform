// =============================================================================
// duplicate-detector.js — Detector de issues duplicados via Jaccard sobre
// tokens normalizados (#3625 CA-4).
//
// Motivación: el incidente Ola N+11 incluyó la creación accidental de #3617
// como duplicado no autorizado de #3616. El skill `/doc nueva` no chequeaba
// similitud con OPEN issues recientes antes de crear.
//
// Decisiones cerradas por PO (#3625):
//   - Métrica: Jaccard sobre tokens normalizados (lowercase, sin stopwords
//     ES/EN). Umbral 0.7 default.
//   - Override: `--force-duplicate "razón ≥20 chars"` → permite creación,
//     loguea en audit dedicado.
//   - Cache de `gh issue list` por 30s (rate-limit defense).
//   - MVP Jaccard puro. Cambio a embeddings/LLM requiere re-review de
//     seguridad (documentado al pie).
//
// Threat model:
//   - El input `title` viene del operador y se compara con títulos de
//     issues abiertos. La métrica NO usa LLM, así que NO hay vector de
//     prompt-injection. Si en el futuro se cambia la métrica a embeddings,
//     se DEBE sanitizar el input antes de pasarlo al modelo.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const auditLog = require('./audit-log');

const DEFAULT_THRESHOLD = 0.7;
const CACHE_TTL_MS = 30 * 1000;

// Stopwords ES + EN (lista breve, hay muchos issues técnicos donde "the/de/
// la/that/feature" son ruido y no señal).
const STOPWORDS = new Set([
    // ES
    'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas',
    'y', 'o', 'u', 'e', 'pero', 'mas', 'sino',
    'de', 'del', 'al', 'a', 'en', 'con', 'por', 'para', 'sin', 'sobre', 'desde', 'hasta',
    'que', 'qué', 'cuando', 'cuándo', 'donde', 'dónde', 'como', 'cómo',
    'se', 'sus', 'su', 'mi', 'mis', 'tu', 'tus', 'me', 'te', 'le', 'les',
    'es', 'son', 'fue', 'sido', 'ser', 'esta', 'están', 'está', 'estar',
    'no', 'si', 'sí', 'también', 'muy', 'más', 'menos', 'solo', 'solo',
    'cada', 'todo', 'todos', 'toda', 'todas', 'algun', 'alguna', 'algunos',
    'hace', 'hacer', 'haga', 'hay', 'pueda', 'puede', 'poder',
    // EN
    'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else',
    'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'into', 'about',
    'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'it', 'its', 'this', 'that', 'these', 'those',
    'we', 'us', 'our', 'you', 'your', 'they', 'them', 'their',
    'has', 'have', 'had', 'do', 'does', 'did', 'done', 'can', 'could', 'should',
    'i', 'me', 'my', 'mine', 'as', 'so', 'not',
]);

let cache = { fetchedAt: 0, issues: null };

/**
 * Tokeniza un título a set de palabras normalizadas (lowercase, sin
 * stopwords, sin signos, sin acentos, mínimo 2 chars).
 *
 * @param {string} title
 * @returns {Set<string>}
 */
function tokenize(title) {
    if (typeof title !== 'string') return new Set();
    const normalized = title
        .toLowerCase()
        .normalize('NFD').replace(/\p{Diacritic}/gu, '') // sin acentos
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')              // sólo letras/dígitos/espacios
        .split(/\s+/)
        .map(w => w.trim())
        .filter(w => w.length >= 2 && !STOPWORDS.has(w));
    return new Set(normalized);
}

/**
 * Jaccard coefficient: |A ∩ B| / |A ∪ B|.
 * Devuelve 0 si ambos sets son vacíos (caso degenerado).
 *
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {number} valor en [0, 1]
 */
function jaccard(a, b) {
    if (!(a instanceof Set) || !(b instanceof Set)) return 0;
    if (a.size === 0 && b.size === 0) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    const union = a.size + b.size - inter;
    if (union === 0) return 0;
    return inter / union;
}

/**
 * Trae issues abiertos vía gh CLI (con cache 30s).
 *
 * @param {object} [opts]
 * @param {number} [opts.limit=50]
 * @param {string} [opts.ghPath] — path al binario gh.
 * @returns {Array<{number: number, title: string}>}
 */
function fetchOpenIssues({ limit = 50, ghPath = 'gh' } = {}) {
    const now = Date.now();
    if (cache.issues && (now - cache.fetchedAt) < CACHE_TTL_MS) {
        return cache.issues;
    }
    try {
        const out = execSync(
            `${ghPath} issue list --state open --limit ${limit} --json number,title`,
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 }
        );
        const parsed = JSON.parse(out);
        if (Array.isArray(parsed)) {
            cache = { fetchedAt: now, issues: parsed };
            return parsed;
        }
    } catch {
        // Si gh falla, devolvemos cache vieja si existe (mejor que nada).
        if (cache.issues) return cache.issues;
    }
    return [];
}

/**
 * Encuentra issues similares al título propuesto.
 *
 * @param {string} title — título propuesto del nuevo issue.
 * @param {object} [opts]
 * @param {Array<{number,title}>} [opts.openIssues] — opcional, evita llamar gh (tests).
 * @param {number} [opts.threshold=0.7]
 * @param {number} [opts.limit=50]
 * @returns {{
 *   hasDuplicate: boolean,
 *   threshold: number,
 *   matches: Array<{ number: number, title: string, score: number }>,
 *   topMatch: { number, title, score }|null,
 * }}
 */
function findSimilar(title, { openIssues, threshold = DEFAULT_THRESHOLD, limit = 50 } = {}) {
    if (typeof title !== 'string' || title.trim().length === 0) {
        return { hasDuplicate: false, threshold, matches: [], topMatch: null };
    }
    const tokensA = tokenize(title);
    if (tokensA.size === 0) {
        return { hasDuplicate: false, threshold, matches: [], topMatch: null };
    }
    const issues = Array.isArray(openIssues) ? openIssues : fetchOpenIssues({ limit });

    const matches = [];
    for (const it of issues) {
        if (!it || typeof it.title !== 'string') continue;
        const tokensB = tokenize(it.title);
        const score = jaccard(tokensA, tokensB);
        if (score >= threshold) {
            matches.push({ number: Number(it.number), title: it.title, score });
        }
    }
    matches.sort((a, b) => b.score - a.score);
    return {
        hasDuplicate: matches.length > 0,
        threshold,
        matches,
        topMatch: matches[0] || null,
    };
}

// -----------------------------------------------------------------------------
// Audit log de overrides `--force-duplicate`.
// Vive en `.pipeline/audit/duplicate-overrides.jsonl`, mismo patrón
// hash-chain SHA-256 que el audit principal.
// -----------------------------------------------------------------------------

function overrideAuditFile() {
    const baseDir = process.env.PIPELINE_DIR_OVERRIDE || path.resolve(__dirname, '..');
    return path.join(baseDir, 'audit', 'duplicate-overrides.jsonl');
}

/**
 * Loguea un uso de `--force-duplicate`.
 *
 * @param {object} params
 * @param {string} params.title — título del nuevo issue.
 * @param {Array} params.matches — issues similares detectados.
 * @param {string} params.justification — razón libre del operador (≥ 20 chars).
 * @param {string} [params.author] — operador (e.g. 'commander:leo').
 * @returns {{ ok: boolean, error?: string, hash_self?: string }}
 */
function logForceDuplicate({ title, matches, justification, author }) {
    if (typeof justification !== 'string' || justification.trim().length < 20) {
        return { ok: false, error: 'justification_too_short' };
    }
    const entry = {
        timestamp: new Date().toISOString(),
        pid: process.pid,
        title: String(title).slice(0, 200),
        matches: (Array.isArray(matches) ? matches : [])
            .slice(0, 10)
            .map(m => ({ number: m.number, title: String(m.title).slice(0, 150), score: m.score })),
        justification: justification.slice(0, 500),
        author: author || 'unknown',
    };
    try {
        const r = auditLog.appendChained({ file: overrideAuditFile(), entry });
        return { ok: true, hash_self: r.hash_self };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

/**
 * Formatea un mensaje amigable para Telegram cuando se detecta un duplicado.
 *
 * @param {string} title
 * @param {object} result — output de findSimilar()
 * @returns {string}
 */
function formatDuplicateAlert(title, result) {
    if (!result || !result.topMatch) return '';
    const m = result.topMatch;
    const score = (m.score * 100).toFixed(1);
    return (
        `⚠️ *Posible duplicado detectado* (Jaccard ${score}% > ${(result.threshold * 100).toFixed(0)}%):\n\n` +
        `Tu título: ${title}\n` +
        `Issue similar: #${m.number} — ${m.title}\n\n` +
        `${result.matches.length > 1 ? `(${result.matches.length} matches en total)\n\n` : ''}` +
        `Si igual querés crear el nuevo issue, usá:\n` +
        `\`/doc nueva --force-duplicate "razón ≥ 20 chars" ...\``
    );
}

// Reset interno (tests).
function _resetCache() { cache = { fetchedAt: 0, issues: null }; }

module.exports = {
    tokenize,
    jaccard,
    fetchOpenIssues,
    findSimilar,
    logForceDuplicate,
    formatDuplicateAlert,
    DEFAULT_THRESHOLD,
    CACHE_TTL_MS,
    _resetCache,
    _paths: () => ({ OVERRIDE_AUDIT_FILE: overrideAuditFile() }),
};

'use strict';

/**
 * block-classifier.js (#4765 — parte (a) del split de #4759)
 * ==========================================================
 *
 * Capa fina de UNIFICACION que decide si un bloqueo del kernel puede
 * auto-resolverse sin humano (`mecanico`) o debe escalar fail-closed
 * (`decision`). Un falso `mecanico` = **bypass del gate humano** → merge
 * automático de código potencialmente sensible/malicioso. Por eso la regla
 * conservadora dura (SR-8): ante `kind` desconocido, entrada ambigua o error
 * de delegación → `decision` (fail-closed).
 *
 * `classifyBlock(block)` es la función pura de entrada. Delega en los
 * clasificadores específicos ya existentes:
 *   - `merge-conflict` → `delivery.classifyConflictFiles(paths, allowlist)`.
 *   - `desync`         → `desync-detector.classifyDesync(diff, isClosed)`
 *                        (mapeo explícito reductivo→mecanico / ambiguo→decision).
 *   - `gate-reject`    → `decision` por defecto hasta la parte (b) #4766.
 *
 * La allowlist/denylist se cargan SOLO del repo base (`.pipeline/config/`),
 * NUNCA del branch evaluado (SR-2): `loadConfig()` ancla el path con
 * `path.join(__dirname, ...)`, no relativo al `cwd`/worktree.
 *
 * Seguridad heredada: SR-1 (mixto→decision), SR-2 (allowlist no envenenable),
 * SR-3 (denylist antes de allowlist), SR-8 (conservador por defecto),
 * SR-9 (denylist cubre RCE/secrets/CI/IaC + self-reference), SR-10
 * (canonicalización anti-evasión), SR-11 (audit + hash de allowlist),
 * SR-12 (matcher de globs sin regex → anti-ReDoS).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// -----------------------------------------------------------------------------
// Canonicalización de paths (SR-10 / CA-13..CA-15).
// -----------------------------------------------------------------------------

/**
 * Canonicaliza un path para matchear denylist/allowlist de forma robusta ante
 * evasión (separadores, `.`/`..`, `//`, case-fold Windows, Unicode).
 *
 * Pasos: `\`→`/`, NFC, `toLowerCase()` (host Windows case-insensitive),
 * split por `/`, colapsar segmentos vacíos (`//`) y `.`, resolver `..`
 * (si escapa la raíz → `null`, fail-closed). NO usa `path.posix.normalize`
 * (no hace case-fold ni resuelve `..` fuera de raíz — nota de guru).
 *
 * @param {*} p
 * @returns {string|null} path canónico o `null` si no es canonicalizable /
 *   escapa la raíz (el caller debe tratar `null` como `decision`).
 */
function canonicalizePath(p) {
    if (typeof p !== 'string' || p.length === 0) return null;
    let s;
    try {
        s = p.replace(/\\/g, '/').normalize('NFC').toLowerCase();
    } catch {
        return null; // normalize puede lanzar ante entradas raras → fail-closed
    }
    const out = [];
    for (const seg of s.split('/')) {
        if (seg === '' || seg === '.') continue; // colapsa `//`, `./` y leading `/`
        if (seg === '..') {
            if (out.length === 0) return null; // escapa la raíz → fail-closed
            out.pop();
            continue;
        }
        out.push(seg);
    }
    if (out.length === 0) return null; // path vacío tras canonicalizar
    return out.join('/');
}

// -----------------------------------------------------------------------------
// Matcher de globs SIN regex (SR-12 / CA-19 — anti-ReDoS).
// -----------------------------------------------------------------------------

/**
 * Match glob de UN segmento con soporte `*` (cero+ chars) y `?` (un char).
 * Two-pointer con backtracking acotado sobre `*`: O(n·m) peor caso, sin
 * backtracking catastrófico (no hay superficie ReDoS).
 *
 * @param {string} s — segmento del path (ya lowercased).
 * @param {string} pat — segmento del patrón (se lowercasea acá).
 * @returns {boolean}
 */
function matchSegment(s, pat) {
    const p = pat.toLowerCase();
    let si = 0;
    let pi = 0;
    let star = -1;
    let ss = 0;
    while (si < s.length) {
        if (pi < p.length && (p[pi] === s[si] || p[pi] === '?')) {
            si++;
            pi++;
        } else if (pi < p.length && p[pi] === '*') {
            star = pi;
            ss = si;
            pi++;
        } else if (star !== -1) {
            pi = star + 1;
            ss++;
            si = ss;
        } else {
            return false;
        }
    }
    while (pi < p.length && p[pi] === '*') pi++;
    return pi === p.length;
}

/**
 * Match glob de un path completo contra un patrón. `**` (segmento) matchea
 * cero o más segmentos del path. El resto de segmentos se comparan con
 * `matchSegment`. Recursión acotada por la cantidad de `**` del patrón (los
 * patrones vienen de config VERSIONADA/trusted, no del input adversario).
 *
 * @param {string} canonPath — path YA canonicalizado.
 * @param {string} pattern
 * @returns {boolean}
 */
function matchGlob(canonPath, pattern) {
    if (typeof canonPath !== 'string' || typeof pattern !== 'string') return false;
    const T = canonPath.split('/');
    // Canonicalizamos el patrón a nivel de segmentos (colapsa `//`, `.`),
    // pero SIN resolver `..` ni fallar (los patrones son trusted).
    const P = pattern.replace(/\\/g, '/').split('/').filter((seg) => seg !== '' && seg !== '.');

    function walk(i, j) {
        while (i < P.length) {
            if (P[i] === '**') {
                if (i + 1 === P.length) return true; // `**` final matchea el resto
                for (let k = j; k <= T.length; k++) {
                    if (walk(i + 1, k)) return true;
                }
                return false;
            }
            if (j >= T.length) return false;
            if (!matchSegment(T[j], P[i])) return false;
            i++;
            j++;
        }
        return j === T.length;
    }

    return walk(0, 0);
}

/**
 * Denylist: `true` si ALGÚN path canónico matchea ALGÚN patrón de denylist
 * (CA-10..CA-12). Evaluada ANTES que la allowlist (SR-3).
 *
 * @param {string[]} canonPaths — paths YA canonicalizados (no `null`).
 * @param {string[]} deny
 * @returns {boolean}
 */
function matchDenylist(canonPaths, deny) {
    if (!Array.isArray(canonPaths) || !Array.isArray(deny)) return false;
    for (const p of canonPaths) {
        for (const pat of deny) {
            if (typeof pat === 'string' && matchGlob(p, pat)) return true;
        }
    }
    return false;
}

/**
 * Allowlist: `true` si TODOS los paths canónicos caen bajo algún prefijo/ruta
 * anclada de allow (CA-2/CA-17). Prefijos ANCLADOS, no globs laxos: un path
 * matchea si es igual a la entrada o empieza por `entrada + '/'` (o la entrada
 * termina en `/` y es prefijo directo).
 *
 * @param {string[]} canonPaths — paths YA canonicalizados (no `null`).
 * @param {string[]} allow
 * @returns {boolean}
 */
function matchAllowlist(canonPaths, allow) {
    if (!Array.isArray(canonPaths) || canonPaths.length === 0) return false;
    if (!Array.isArray(allow) || allow.length === 0) return false;
    return canonPaths.every((p) => allow.some((entry) => matchAllowEntry(p, entry)));
}

function matchAllowEntry(canonPath, entry) {
    if (typeof entry !== 'string' || entry.length === 0) return false;
    const e = entry.replace(/\\/g, '/').toLowerCase();
    if (e.endsWith('/')) {
        const dir = e.slice(0, -1);
        return canonPath === dir || canonPath.startsWith(e);
    }
    return canonPath === e || canonPath.startsWith(e + '/');
}

// -----------------------------------------------------------------------------
// Mapeo explícito de la clasificación de desync (CA-4).
// -----------------------------------------------------------------------------

/**
 * `desync-detector.classifyDesync` devuelve `'resoluble_reductivo'|'ambiguo'`.
 * NO reusar esos strings crudos: mapear explícitamente al dominio del gate.
 * Cualquier otro valor → `decision` (fail-closed, SR-8).
 *
 * @param {string} raw
 * @returns {'mecanico'|'decision'}
 */
function mapDesyncClassification(raw) {
    if (raw === 'resoluble_reductivo') return 'mecanico';
    if (raw === 'ambiguo') return 'decision';
    return 'decision';
}

// -----------------------------------------------------------------------------
// Carga de config anclada al repo base (SR-2 / CA-16).
// -----------------------------------------------------------------------------

/**
 * Carga la allowlist/denylist SOLO desde `.pipeline/config/` del repo base,
 * usando path absoluto anclado con `__dirname` (NUNCA relativo al cwd/branch
 * evaluado). Devuelve `{ version, allow, deny }`. Ante error → lanza (el
 * caller lo captura y cae a `decision`).
 *
 * @returns {{ version: string, allow: string[], deny: string[] }}
 */
function loadConfig() {
    const cfgPath = path.join(__dirname, '..', 'config', 'block-classifier-allowlist.json');
    const raw = fs.readFileSync(cfgPath, 'utf8');
    const cfg = JSON.parse(raw);
    return {
        version: typeof cfg.version === 'string' ? cfg.version : '0',
        allow: Array.isArray(cfg.allow) ? cfg.allow : [],
        deny: Array.isArray(cfg.deny) ? cfg.deny : [],
    };
}

/**
 * Hash de la config usada para la auto-resolución (SR-11 / CA-18): permite
 * auditar a posteriori con qué reglas se auto-resolvió un `mecanico`.
 * @param {object} cfg
 * @returns {string}
 */
function allowlistHash(cfg) {
    return crypto.createHash('sha256').update(JSON.stringify(cfg)).digest('hex');
}

// -----------------------------------------------------------------------------
// Sanitización de salida (SR-12 / CA-20). Best-effort: nunca romper por esto.
// -----------------------------------------------------------------------------

function safe(text) {
    try {
        return require('./kernel-actions-audit').sanitizeReason(text).sanitized;
    } catch {
        return typeof text === 'string' ? text.replace(/[\r\n]+/g, ' ').slice(0, 500) : '';
    }
}

function safeEvidence(evidence) {
    if (evidence == null) return null;
    try {
        const out = {};
        for (const k of Object.keys(evidence)) {
            const v = evidence[k];
            if (Array.isArray(v)) out[k] = v.map((x) => safe(String(x)));
            else out[k] = safe(String(v));
        }
        return out;
    } catch {
        return null;
    }
}

function decision(reason, extra = {}) {
    return {
        category: 'decision',
        reason: safe(reason),
        delegateTo: extra.delegateTo || null,
        evidence: safeEvidence(extra.evidence),
    };
}

function mecanico(reason, extra = {}) {
    return {
        category: 'mecanico',
        reason: safe(reason),
        delegateTo: extra.delegateTo || null,
        evidence: safeEvidence(extra.evidence),
    };
}

// -----------------------------------------------------------------------------
// Audit de auto-resolución `mecanico` (SR-11 / CA-18). Reusa audit-log.js
// (chained hash log), NO crea infra de logging nueva. Best-effort: si el
// audit falla, NO se rompe la clasificación (regla inquebrantable #1).
// -----------------------------------------------------------------------------

function auditFilePath() {
    if (process.env.BLOCK_CLASSIFIER_AUDIT_FILE) return process.env.BLOCK_CLASSIFIER_AUDIT_FILE;
    return path.join(__dirname, '..', 'audit', 'block-classifier.jsonl');
}

function auditMecanico({ kind, paths: affectedPaths, delegateTo, reason, config }) {
    try {
        require('./audit-log').appendChained({
            file: auditFilePath(),
            entry: {
                event: 'block-classify-mecanico',
                kind: safe(String(kind)),
                paths: Array.isArray(affectedPaths) ? affectedPaths.map((x) => safe(String(x))) : [],
                delegate_to: delegateTo || null,
                reason: safe(reason),
                allowlist_version: config && config.version ? String(config.version) : null,
                allowlist_hash: config ? allowlistHash(config) : null,
            },
        });
    } catch {
        // best-effort: la traza no debe poder tumbar el gate.
    }
}

// -----------------------------------------------------------------------------
// Clasificadores por `kind`.
// -----------------------------------------------------------------------------

function extractPaths(block) {
    if (Array.isArray(block.paths)) return block.paths;
    if (Array.isArray(block.files)) return block.files;
    return [];
}

function classifyMergeConflict(block) {
    const config = loadConfig();
    const delivery = require('../skills-deterministicos/delivery');
    const affectedPaths = extractPaths(block);
    const res = delivery.classifyConflictFiles(affectedPaths, config);
    const delegateTo = 'delivery.classifyConflictFiles';
    if (res && res.category === 'mecanico') {
        auditMecanico({ kind: 'merge-conflict', paths: affectedPaths, delegateTo, reason: res.reason, config });
        return mecanico(res.reason, { delegateTo, evidence: { paths: affectedPaths } });
    }
    return decision(res && res.reason ? res.reason : 'conflicto no auto-resoluble', {
        delegateTo,
        evidence: { paths: affectedPaths },
    });
}

function classifyDesyncBlock(block) {
    const { classifyDesync } = require('./desync-detector');
    const diff = block && typeof block.diff === 'object' ? block.diff : {};
    const isClosed = typeof block.isClosed === 'function' ? block.isClosed : undefined;
    const raw = classifyDesync(diff, isClosed);
    const category = mapDesyncClassification(raw);
    const delegateTo = 'desync-detector.classifyDesync';
    if (category === 'mecanico') {
        auditMecanico({ kind: 'desync', paths: [], delegateTo, reason: `desync ${raw}`, config: loadConfig() });
        return mecanico(`desync ${raw}`, { delegateTo, evidence: { raw } });
    }
    return decision(`desync ${raw}`, { delegateTo, evidence: { raw } });
}

// -----------------------------------------------------------------------------
// API pública: classifyBlock — dispatcher con fail-closed envolvente (CA-1/SR-8).
// -----------------------------------------------------------------------------

/**
 * Clasifica un bloqueo normalizado. Contrato de salida (CA-1):
 *   `{ category: 'mecanico'|'decision', reason, delegateTo, evidence }`.
 *
 * El `try/catch` externo garantiza que CUALQUIER excepción de un delegado
 * caiga a `decision` (CA-8). Todo camino dudoso resuelve a `decision` (SR-8).
 *
 * @param {{ kind: 'merge-conflict'|'desync'|'gate-reject', [k:string]: any }} block
 * @returns {{ category: 'mecanico'|'decision', reason: string, delegateTo: string|null, evidence: object|null }}
 */
function classifyBlock(block) {
    try {
        if (!block || typeof block !== 'object' || Array.isArray(block)) {
            return decision('entrada inválida: se esperaba un bloque normalizado');
        }
        switch (block.kind) {
            case 'merge-conflict':
                return classifyMergeConflict(block);
            case 'desync':
                return classifyDesyncBlock(block);
            case 'gate-reject':
                return decision('gate-reject por defecto → decision (parte b #4766 pendiente)', {
                    delegateTo: 'gate-reject-default',
                });
            default:
                return decision(`kind desconocido: ${String(block.kind)}`);
        }
    } catch (e) {
        return decision(`excepción en clasificación: ${e && e.message ? e.message : String(e)}`);
    }
}

module.exports = {
    classifyBlock,
    _internal: {
        canonicalizePath,
        matchSegment,
        matchGlob,
        matchDenylist,
        matchAllowlist,
        matchAllowEntry,
        mapDesyncClassification,
        loadConfig,
        allowlistHash,
        auditFilePath,
    },
};

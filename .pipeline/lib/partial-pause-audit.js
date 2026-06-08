// =============================================================================
// partial-pause-audit.js — Audit trail append-only para mutaciones de
// `.partial-pause.json` (issue #3625, derivado del incidente Ola N+11 del
// 2026-05-29 09:39 BA donde la allowlist fue reescrita perdiendo #3559 y
// #3605 e introduciendo el duplicado no autorizado #3617).
//
// Objetivos del módulo (PO + security + guru cerraron criterios en #3625):
//
//   1. CA-1: cada mutación se persiste en `.pipeline/audit/partial-pause-
//      mutations.jsonl` vía `lib/audit-log.appendChained` (hash-chain
//      SHA-256 + file-lock O_EXCL). Sin chain el audit no prueba nada.
//
//   2. CA-2: validación de `authorizedBy` contra un enum cerrado de 8 valores.
//      Strings arbitrarios → REJECTED + audit entry de rechazo. Los removals
//      sin autoría humana/subsistema legítimo quedan registrados pero NO se
//      aplican (la decisión de aplicar está en `lib/partial-pause.js`).
//
//   3. CA-6: sanitización de `justification` (max 500 chars + redact AWS
//      keys, JWT, API keys, tokens, paths, etc.). Reusa `lib/redact.js` que
//      ya cubre todos los patrones de prompt-injection y secret-leak del
//      proyecto.
//
//   4. Backfill del incidente 09:39 BA como primera entry del log (cuando
//      el archivo está vacío, antes de habilitar el gate runtime). Se marca
//      con `_backfill: true` para no confundirla con tráfico normal.
//
// **Invariante de orden (CA-2)**: el caller (`partial-pause.js`) debe llamar
// PRIMERO a `appendMutation()` (audit log) y RECIÉN DESPUÉS escribir el
// estado en `.partial-pause.json`. Si el proceso muere entre los dos pasos,
// queda registrado el intento pero el estado no se modificó — recuperable.
// El orden inverso (estado primero, audit después) es exactamente el bug
// que estamos arreglando: una mutación sin trazabilidad.
//
// Este módulo NO escribe `.partial-pause.json` ni decide aplicar/rechazar
// la mutación: sólo persiste el evento. La decisión es de quien lo invoca.
//
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const auditLog = require('./audit-log');
const { redactSensitive } = require('./redact');

// -----------------------------------------------------------------------------
// Enum cerrado de valores válidos para `authorizedBy` (PO cerró en #3625).
//
// El valor está validado contra esta whitelist; cualquier valor fuera de
// ella genera una entry de audit `action: 'reject'` y la mutación NO se
// aplica (responsabilidad del caller).
//
// `recursive-deps:from-N` admite un sufijo numérico (el issue padre). Se
// valida por regex aparte para no requerir enumerar cada padre posible.
// -----------------------------------------------------------------------------

const AUTHORIZED_BY_STATIC = Object.freeze([
    'commander:leo',         // operador humano vía Telegram Commander
    'restart:rollback',      // restart.js durante recovery transaccional
    'wave-promote',          // lib/waves.promoteWaveAtomic
    'wave-rollback',         // lib/waves.restoreFromSnapshots
    'resume:operator',       // /resume manual (Telegram o CLI)
    'pulpo:cleanup',         // limpieza programada del Pulpo (TTL expirado, etc.)
    'planner-split:auto',    // CA-3: auto-promoción de hijos cuando split de planner
]);

// `recursive-deps:from-<N>` donde N es el número del issue padre (>0).
const RECURSIVE_DEPS_RE = /^recursive-deps:from-(\d+)$/;

// #3742 — Allowlist de `source` conocidos. SEPARADO del enum de `authorizedBy`
// a propósito: un `source` identifica QUIÉN originó la mutación (trazabilidad),
// NO autoriza removals. Mantenerlo aparte evita que registrar un source nuevo
// ensanche el gate de autorización. `normalizeSource` lo consulta para no
// prefijar `unknown:` a sources legítimos.
const KNOWN_SOURCES = Object.freeze([
    'dashboard:wizard:allowlist',   // wizard de triaje de allowlist (#3742)
    'dashboard:wizard:pausa',       // wizard de pausa parcial (#3741)
]);

const AUTHORIZED_BY_ENUM = Object.freeze([
    ...AUTHORIZED_BY_STATIC,
    'recursive-deps:from-N', // forma documental (valor real lleva el N concreto)
]);

/**
 * Valida un valor de `authorizedBy` contra el enum cerrado.
 *
 * @param {string|null|undefined} value
 * @returns {{ valid: boolean, normalized: string|null, reason?: string }}
 */
function validateAuthorizedBy(value) {
    if (value == null || value === '') {
        return { valid: false, normalized: null, reason: 'missing_authorized_by' };
    }
    if (typeof value !== 'string') {
        return { valid: false, normalized: null, reason: 'authorized_by_not_string' };
    }
    const trimmed = value.trim();
    if (AUTHORIZED_BY_STATIC.includes(trimmed)) {
        return { valid: true, normalized: trimmed };
    }
    const m = trimmed.match(RECURSIVE_DEPS_RE);
    if (m && Number(m[1]) > 0) {
        return { valid: true, normalized: trimmed };
    }
    return {
        valid: false,
        normalized: null,
        reason: `authorized_by_not_in_enum:${trimmed}`,
    };
}

// -----------------------------------------------------------------------------
// Sanitización (CA-6).
//
// `source` se valida contra el mismo enum cerrado (no string libre — un atacante
// podría meter `source: 'commander:bot_TOKEN_LEAKED'`).
//
// `justification` admite texto libre pero con:
//   - max 500 chars (trunca con marcador)
//   - redact secrets vía `lib/redact.js` (cubre AWS keys, JWT, OAuth tokens,
//     paths absolutos, emails, query strings sensibles, etc.)
//
// Regex defensiva extra (cinturón + tirantes): si después del redact aún
// queda un patrón típico de secret-leak (AKIA..., xox..., JWT base64),
// reemplazar por [REDACTED]. Lib redact ya cubre headers/JSON keys; este
// pase extra es para texto plano libre.
// -----------------------------------------------------------------------------

const MAX_JUSTIFICATION_LEN = 500;
const TRUNCATION_NOTICE = '...[TRUNCATED]';
const REDACTION_MARKER = '[REDACTED]';

// Patrones obvios de secrets que queremos atrapar incluso en texto libre.
// Conservadores para evitar falsos positivos sobre lenguaje natural.
const SECRET_LEAK_PATTERNS = Object.freeze([
    /\bAKIA[0-9A-Z]{16}\b/g,                          // AWS Access Key
    /\baws_secret_access_key\s*[:=]\s*[A-Za-z0-9/+=]{40}\b/gi,
    /\bxox[bpoas]-[A-Za-z0-9-]{10,}\b/g,             // Slack
    /\bey[A-Za-z0-9_-]{8,}\.ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT (header.payload.signature)
    /\bsk-[A-Za-z0-9]{20,}\b/g,                       // OpenAI / Anthropic
    /\bghp_[A-Za-z0-9]{30,}\b/g,                      // GitHub PAT
    /\bgho_[A-Za-z0-9]{30,}\b/g,                      // GitHub OAuth
    /\b[0-9]{8,}:[A-Za-z0-9_-]{30,}\b/g,             // Telegram bot token
]);

/**
 * Sanitiza una justificación libre antes de persistirla.
 * Aplica `redactSensitive` + regex defensivas + trim a max length.
 *
 * @param {string|null|undefined} text
 * @returns {{ sanitized: string, didRedact: boolean, didTruncate: boolean }}
 */
function sanitizeJustification(text) {
    if (text == null) {
        return { sanitized: '', didRedact: false, didTruncate: false };
    }
    if (typeof text !== 'string') {
        return { sanitized: String(text).slice(0, MAX_JUSTIFICATION_LEN), didRedact: false, didTruncate: false };
    }
    // Paso 1: redact estándar del proyecto.
    let out = String(redactSensitive(text));
    let didRedact = out !== text;

    // Paso 2: regex defensivas para texto libre.
    for (const re of SECRET_LEAK_PATTERNS) {
        const before = out;
        out = out.replace(re, REDACTION_MARKER);
        if (out !== before) didRedact = true;
    }

    // Paso 3: trim a max length.
    let didTruncate = false;
    if (out.length > MAX_JUSTIFICATION_LEN) {
        const keep = MAX_JUSTIFICATION_LEN - TRUNCATION_NOTICE.length;
        out = out.slice(0, Math.max(0, keep)) + TRUNCATION_NOTICE;
        didTruncate = true;
    }
    return { sanitized: out, didRedact, didTruncate };
}

/**
 * Valida `source` contra el mismo enum cerrado (para evitar leakage por
 * canal sin validar). Si no matchea, devuelve `'unknown'` para que la
 * entry siga teniendo forma uniforme pero quede claramente marcada.
 *
 * @param {string|null|undefined} value
 * @returns {string}
 */
function normalizeSource(value) {
    const v = validateAuthorizedBy(value);
    if (v.valid) return v.normalized;
    // #3742 — sources legítimos (no del enum de autorización) se registran tal cual.
    if (typeof value === 'string' && KNOWN_SOURCES.includes(value)) return value;
    if (typeof value === 'string' && value.length > 0 && value.length <= 100) {
        // Permite valor descriptivo pero lo marca explícitamente.
        return `unknown:${value.slice(0, 80)}`;
    }
    return 'unknown';
}

// -----------------------------------------------------------------------------
// Diff de allowlist (previous vs current).
//
// Devuelve `{ added: number[], removed: number[] }`. Útil para que el caller
// decida si la mutación es un "removal sin autoría" (rejection). Ordenado
// ascendente para que el output sea estable.
// -----------------------------------------------------------------------------

function computeDiff(previous, current) {
    const prevSet = new Set(Array.isArray(previous) ? previous.filter(Number.isInteger) : []);
    const currSet = new Set(Array.isArray(current) ? current.filter(Number.isInteger) : []);
    const added = [...currSet].filter(n => !prevSet.has(n)).sort((a, b) => a - b);
    const removed = [...prevSet].filter(n => !currSet.has(n)).sort((a, b) => a - b);
    return { added, removed };
}

// -----------------------------------------------------------------------------
// Resolución de paths.
// -----------------------------------------------------------------------------

function pipelineDir() {
    if (process.env.PIPELINE_DIR_OVERRIDE) return process.env.PIPELINE_DIR_OVERRIDE;
    return path.resolve(__dirname, '..');
}

function auditFile() {
    return path.join(pipelineDir(), 'audit', 'partial-pause-mutations.jsonl');
}

// -----------------------------------------------------------------------------
// Backfill del incidente 09:39 BA del 2026-05-29 (Ola N+11).
//
// Política PO (#3625): primera entry del archivo cuando está vacío, marcada
// con `_backfill: true`. NO reescribir el chain ya existente — solo se
// emite si el archivo aún no tiene líneas.
// -----------------------------------------------------------------------------

const INCIDENT_BACKFILL = Object.freeze({
    _backfill: true,
    _backfill_reason: 'Ola N+11 incident recovery 2026-05-29',
    timestamp: '2026-05-29T12:39:00Z',
    pid: null,
    source: 'unknown:incident-09-39-BA',
    action: 'write',
    previous: [3559, 3605],
    current: [3616, 3617],
    diff: { added: [3617], removed: [3559, 3605] },
    authorized_by: null,
    justification: 'Mutación detectada post-incidente: allowlist reescrita perdiendo #3559 y #3605, entró duplicado no autorizado #3617. Causa raíz desconocida (no había audit). Backfill manual al habilitar el gate.',
});

/**
 * Emite el backfill del incidente si el archivo está vacío.
 * Idempotente: si ya hay alguna entry, no hace nada.
 *
 * @returns {{ emitted: boolean }}
 */
function emitBackfillIfNeeded() {
    const file = auditFile();
    let existed = false;
    try {
        const content = fs.readFileSync(file, 'utf8');
        existed = content.split('\n').some(l => l.trim().length > 0);
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
    }
    if (existed) return { emitted: false };
    // Escribir backfill directamente vía appendChained — la entry se hashea
    // como cualquier otra. El campo `_backfill: true` viaja dentro del
    // payload encadenado, así que es inmutable al igual que el resto.
    auditLog.appendChained({ file, entry: { ...INCIDENT_BACKFILL } });
    return { emitted: true };
}

// -----------------------------------------------------------------------------
// API pública.
// -----------------------------------------------------------------------------

/**
 * Persiste una mutación en el audit log.
 *
 * El caller (típicamente `lib/partial-pause.js`) DEBE invocar esta función
 * ANTES de escribir el estado nuevo en `.partial-pause.json`. Si el proceso
 * muere entre los dos pasos, el audit registró la intención pero el estado
 * sigue como antes — recuperable. Si se invierte el orden, queda una
 * mutación sin trazabilidad (el bug que arreglamos).
 *
 * @param {object} params
 * @param {string} params.source — quién originó (validado vs enum o marcado unknown).
 * @param {'write'|'reject'|'clear'} params.action — naturaleza del cambio.
 * @param {number[]} params.previous — allowlist antes.
 * @param {number[]} params.current — allowlist después.
 * @param {string|null} [params.authorizedBy] — autoría validada vs enum.
 * @param {string} [params.justification] — razón libre (sanitizada).
 * @param {object} [params.extra] — campos adicionales (e.g. expira_at).
 * @returns {{ ok: boolean, hash_self?: string, validation?: object, sanitization?: object }}
 */
function appendMutation({ source, action, previous, current, authorizedBy, justification, extra } = {}) {
    // Backfill antes de la primera escritura real.
    try { emitBackfillIfNeeded(); } catch { /* no-fatal: si el backfill falla, seguimos */ }

    const file = auditFile();
    const validation = validateAuthorizedBy(authorizedBy);
    const sanitization = sanitizeJustification(justification);
    const diff = computeDiff(previous, current);
    const validAction = ['write', 'reject', 'clear'].includes(action) ? action : 'write';

    const entry = {
        timestamp: new Date().toISOString(),
        pid: process.pid,
        source: normalizeSource(source),
        action: validAction,
        previous: Array.isArray(previous) ? [...previous] : [],
        current: Array.isArray(current) ? [...current] : [],
        diff,
        authorized_by: validation.valid ? validation.normalized : null,
        justification: sanitization.sanitized,
    };
    if (!validation.valid && authorizedBy != null) {
        // No tirar la info — registrar el valor inválido para forensia.
        entry.authorized_by_rejected_value = String(authorizedBy).slice(0, 100);
        entry.authorized_by_rejected_reason = validation.reason;
    }
    if (sanitization.didRedact) entry.justification_redacted = true;
    if (sanitization.didTruncate) entry.justification_truncated = true;
    if (extra && typeof extra === 'object') {
        // Sin pisar campos críticos.
        for (const k of Object.keys(extra)) {
            if (!(k in entry)) entry[k] = extra[k];
        }
    }

    const result = auditLog.appendChained({ file, entry });
    return { ok: true, hash_self: result.hash_self, validation, sanitization, diff };
}

/**
 * Wrapper de `audit-log.verifyChain` sobre el archivo de mutaciones.
 *
 * @returns {{ ok: boolean, entriesChecked: number, brokenAt?: number, reason?: string }}
 */
function verifyChain() {
    return auditLog.verifyChain(auditFile());
}

/**
 * Lee las últimas N entries del audit log (tail eficiente).
 *
 * Para N <= 100 (el caso real del dashboard widget), leer el archivo entero
 * y devolver las últimas N es aceptable. Si en el futuro el archivo crece a
 * GB, este helper se reemplaza por un tail con seek desde el final.
 *
 * @param {number} [n=3]
 * @returns {object[]}
 */
function tail(n = 3) {
    const all = auditLog.readAll(auditFile());
    if (!Array.isArray(all)) return [];
    const N = Math.max(0, Math.min(Number(n) || 0, all.length));
    return all.slice(all.length - N);
}

/**
 * Cuenta mutaciones en una ventana temporal (default 24h) agrupadas por
 * status. Usado por `/status` y métricas del dashboard.
 *
 * @param {object} [opts]
 * @param {number} [opts.windowMs] — ventana hacia atrás desde now.
 * @returns {{ total: number, authorized: number, rejected: number, unknown: number, since: string }}
 */
function statsSince({ windowMs = 24 * 60 * 60 * 1000 } = {}) {
    const all = auditLog.readAll(auditFile());
    const cutoff = Date.now() - windowMs;
    const sinceIso = new Date(cutoff).toISOString();
    let total = 0, authorized = 0, rejected = 0, unknown = 0;
    for (const e of all) {
        const t = Date.parse(e.timestamp || '');
        if (!Number.isFinite(t) || t < cutoff) continue;
        total++;
        if (e.action === 'reject') rejected++;
        else if (e.authorized_by) authorized++;
        else unknown++;
    }
    return { total, authorized, rejected, unknown, since: sinceIso };
}

module.exports = {
    // API principal
    appendMutation,
    verifyChain,
    tail,
    statsSince,
    emitBackfillIfNeeded,
    // Helpers exportados para tests y para el gate de `partial-pause.js`
    validateAuthorizedBy,
    sanitizeJustification,
    normalizeSource,
    computeDiff,
    // Constantes
    AUTHORIZED_BY_ENUM,
    AUTHORIZED_BY_STATIC,
    KNOWN_SOURCES,
    RECURSIVE_DEPS_RE,
    MAX_JUSTIFICATION_LEN,
    REDACTION_MARKER,
    INCIDENT_BACKFILL,
    // Path resolver (uso interno + tests)
    _paths: () => ({ AUDIT_FILE: auditFile() }),
};

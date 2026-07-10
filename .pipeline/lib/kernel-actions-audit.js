// =============================================================================
// kernel-actions-audit.js — Audit trail append-only para las **acciones
// autónomas del kernel** (issue #4577 · épico #4570 · GATE 3).
//
// GATE 3 gobierna las mutaciones que el kernel se aplica a sí mismo sobre su
// **estado operativo** (no código de producto): re-seeds de ola, realigns de
// allowlist, flags de cuota, auto-resolves de desync, reset del working tree.
// Los tres incidentes del 2026-07-08 (#4565 quota-flag, #4566 realign, 3er
// reset del working tree) ocurrieron sin traza: el operador tuvo cero
// visibilidad de que el kernel había mutado su propio estado.
//
// Este módulo es el **registro canónico** de esas acciones. Clona la semántica
// probada de `lib/partial-pause-audit.js`:
//
//   - CA-1 / RS-1: cada acción se persiste en el archivo canónico ÚNICO
//     `.pipeline/audit/kernel-actions.jsonl` vía `lib/audit-log.appendChained`
//     (hash-chain SHA-256 + file-lock O_EXCL). NUNCA con `fs.appendFile` crudo.
//     Un audit sin cadena no prueba nada: cualquier proceso podría reescribir
//     el JSONL y borrar la evidencia de un re-seed/realign.
//
//   - CA-2 / RS-2 / RS-6: invariante **log-antes-de-mutar**. El caller DEBE
//     invocar `appendAction()` ANTES de mutar el estado. Si el proceso muere
//     entre el log y la mutación, queda registrado el intento y el estado
//     previo intacto (recuperable). El orden inverso es exactamente el agujero
//     que originó los incidentes 2026-07-08.
//
//   - CA-3 / RS-3: sanitización del campo `reason` — redact de secrets
//     (AWS key / JWT / API key / token) + truncado (~500 chars) + escape de
//     CRLF para impedir forjar líneas JSONL falsas (log-forging).
//
//   - `action` y `authorizedBy` validados contra **enums cerrados**. Un valor
//     fuera de rango no rompe el registro: se marca (`unknown` / campo de
//     rechazo forense) para no perder la traza.
//
// Este módulo NO ejecuta la mutación ni decide aplicar/rechazar: sólo persiste
// el evento. La decisión de aplicar/notificar/confirmar vive en el caller y en
// `lib/kernel-action-policy.js`.
// =============================================================================
'use strict';

const path = require('node:path');

const auditLog = require('./audit-log');
const { redactSensitive } = require('./redact');

// -----------------------------------------------------------------------------
// Enum cerrado de acciones autónomas instrumentadas (receta del arquitecto,
// #4577). Cualquier valor fuera de la lista se registra como 'unknown' para no
// perder la traza pero dejar clara la anomalía.
// -----------------------------------------------------------------------------
const KERNEL_ACTIONS = Object.freeze([
    'realign-allowlist',   // pulpo → wave-dispatch.realignActiveWaveDispatch (incidente #4566)
    'reseed-wave',         // scripts/init-waves-from-partial.initWavesFromPartial
    'quota-flag-set',      // lib/quota-exhausted.setFlag (incidente #4565)
    'quota-flag-clear',    // lib/quota-exhausted.clearFlag (incidente #4565)
    'worktree-reset',      // restart.js syncWithMain → git reset --hard (3er incidente 2026-07-08)
    'desync-autoresolve',  // lib/desync-detector.clearDesyncFlag + legit-add-trace
]);

// Niveles de impacto (se refleja en la notificación al operador — UX #4577).
const IMPACT = Object.freeze(['alto', 'medio', 'bajo']);

// -----------------------------------------------------------------------------
// Enum cerrado de `authorizedBy` (mismo criterio que partial-pause-audit.js).
//
// Identifica QUÉ subsistema autorizó la acción autónoma. Un valor fuera del
// enum NO se descarta: se persiste el valor original en campos de rechazo
// forense (`authorized_by_rejected_value` / `_reason`) y `authorized_by`
// queda `null`. Reusamos las autorías ya existentes donde aplica
// (`restart:rollback` para el reset del working tree — RS-6, no duplicar).
// -----------------------------------------------------------------------------
const AUTHORIZED_BY_STATIC = Object.freeze([
    'kernel:auto',           // acción autónoma del propio kernel (default)
    'restart:rollback',      // restart.js durante recovery transaccional (RS-6)
    'wave-promote',          // realign de la ola activa (pulpo)
    'quota-detector',        // detector de cuota (set/clear del flag)
    'desync-detector',       // auto-resolve de desync aditivo
    'commander:leo',         // operador humano confirmó vía Telegram
    'operator:confirm',      // confirmación de operador validada (CA-5)
]);

const AUTHORIZED_BY_ENUM = Object.freeze([...AUTHORIZED_BY_STATIC]);

// -----------------------------------------------------------------------------
// Sanitización del `reason` (CA-3 / RS-3).
// -----------------------------------------------------------------------------
const MAX_REASON_LEN = 500;
const TRUNCATION_NOTICE = '...[TRUNCATED]';
const REDACTION_MARKER = '[REDACTED]';

// Patrones obvios de secrets — cinturón + tirantes sobre `redactSensitive`.
// Conservadores para no pisar lenguaje natural. Espejo de partial-pause-audit.
const SECRET_LEAK_PATTERNS = Object.freeze([
    /\bAKIA[0-9A-Z]{16}\b/g,                          // AWS Access Key
    /\baws_secret_access_key\s*[:=]\s*[A-Za-z0-9/+=]{40}\b/gi,
    /\bxox[bpoas]-[A-Za-z0-9-]{10,}\b/g,             // Slack
    /\bey[A-Za-z0-9_-]{8,}\.ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
    /\bsk-[A-Za-z0-9]{20,}\b/g,                       // OpenAI / Anthropic
    /\bghp_[A-Za-z0-9]{30,}\b/g,                      // GitHub PAT
    /\bgho_[A-Za-z0-9]{30,}\b/g,                      // GitHub OAuth
    /\b[0-9]{8,}:[A-Za-z0-9_-]{30,}\b/g,             // Telegram bot token
]);

/**
 * Sanitiza el motivo/contexto antes de persistirlo.
 *   1. `redactSensitive` (redact estándar del proyecto).
 *   2. Regex defensivas para texto libre.
 *   3. Escape de CRLF (evita forjar líneas JSONL falsas — log-forging RS-3).
 *   4. Truncado a `MAX_REASON_LEN`.
 *
 * @param {string|null|undefined} text
 * @returns {{ sanitized: string, didRedact: boolean, didTruncate: boolean, didEscapeCrlf: boolean }}
 */
function sanitizeReason(text) {
    if (text == null) {
        return { sanitized: '', didRedact: false, didTruncate: false, didEscapeCrlf: false };
    }
    const original = typeof text === 'string' ? text : String(text);

    // Paso 1: redact estándar.
    let out;
    try {
        out = String(redactSensitive(original));
    } catch {
        out = original; // best-effort: nunca romper por el redact
    }
    let didRedact = out !== original;

    // Paso 2: regex defensivas.
    for (const re of SECRET_LEAK_PATTERNS) {
        const before = out;
        out = out.replace(re, REDACTION_MARKER);
        if (out !== before) didRedact = true;
    }

    // Paso 3: escapar CRLF (log-injection). Un `\n`/`\r` en el reason podría
    // forjar una línea JSONL adicional. Los neutralizamos a texto visible.
    let didEscapeCrlf = false;
    if (/[\r\n]/.test(out)) {
        out = out.replace(/\r\n/g, '\\n').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
        didEscapeCrlf = true;
    }

    // Paso 4: truncado.
    let didTruncate = false;
    if (out.length > MAX_REASON_LEN) {
        const keep = MAX_REASON_LEN - TRUNCATION_NOTICE.length;
        out = out.slice(0, Math.max(0, keep)) + TRUNCATION_NOTICE;
        didTruncate = true;
    }
    return { sanitized: out, didRedact, didTruncate, didEscapeCrlf };
}

/**
 * Valida `authorizedBy` contra el enum cerrado.
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
    return { valid: false, normalized: null, reason: `authorized_by_not_in_enum:${trimmed}` };
}

/**
 * Normaliza `action` contra el enum cerrado.
 * @param {string} value
 * @returns {string}
 */
function normalizeAction(value) {
    return (typeof value === 'string' && KERNEL_ACTIONS.includes(value)) ? value : 'unknown';
}

/**
 * Normaliza `impact` contra el enum. Default `medio` (conservador).
 * @param {string} value
 * @returns {string}
 */
function normalizeImpact(value) {
    return (typeof value === 'string' && IMPACT.includes(value)) ? value : 'medio';
}

// -----------------------------------------------------------------------------
// Resolución de paths. `PIPELINE_DIR_OVERRIDE` permite aislar tests (mismo
// patrón que quota-exhausted / partial-pause-audit).
// -----------------------------------------------------------------------------
function pipelineDir() {
    if (process.env.PIPELINE_DIR_OVERRIDE) return process.env.PIPELINE_DIR_OVERRIDE;
    return path.resolve(__dirname, '..');
}

function kernelActionsFile() {
    return path.join(pipelineDir(), 'audit', 'kernel-actions.jsonl');
}

// -----------------------------------------------------------------------------
// API pública.
// -----------------------------------------------------------------------------

/**
 * Persiste una acción autónoma del kernel en el audit log canónico.
 *
 * **INVARIANTE (CA-2 / RS-2)**: el caller DEBE invocar `appendAction()` ANTES
 * de ejecutar la mutación de estado. Ver header del módulo.
 *
 * @param {object} params
 * @param {string} params.action — una de `KERNEL_ACTIONS` (o se marca 'unknown').
 * @param {'alto'|'medio'|'bajo'} [params.impact] — impacto (default 'medio').
 * @param {string} [params.reason] — por qué (sanitizado: redact + CRLF + trunc).
 * @param {string} [params.authorizedBy] — autoría validada vs enum cerrado.
 * @param {object} [params.extra] — campos adicionales (no pisan los críticos).
 * @returns {{ ok: boolean, hash_self?: string, entry?: object, validation?: object, sanitization?: object, error?: string }}
 */
function appendAction({ action, impact, reason, authorizedBy, extra } = {}) {
    const validation = validateAuthorizedBy(authorizedBy);
    const sanitization = sanitizeReason(reason);

    const entry = {
        timestamp: new Date().toISOString(),
        pid: process.pid,
        action: normalizeAction(action),
        impact: normalizeImpact(impact),
        reason: sanitization.sanitized,
        authorized_by: validation.valid ? validation.normalized : null,
    };
    if (!validation.valid && authorizedBy != null) {
        // No tirar la info: registrar el valor inválido para forensia (RS-4).
        entry.authorized_by_rejected_value = String(authorizedBy).slice(0, 100);
        entry.authorized_by_rejected_reason = validation.reason;
    }
    if (normalizeAction(action) === 'unknown' && action != null) {
        entry.action_rejected_value = String(action).slice(0, 100);
    }
    if (sanitization.didRedact) entry.reason_redacted = true;
    if (sanitization.didTruncate) entry.reason_truncated = true;
    if (sanitization.didEscapeCrlf) entry.reason_crlf_escaped = true;
    if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
        for (const k of Object.keys(extra)) {
            if (!(k in entry)) entry[k] = extra[k];
        }
    }

    const result = auditLog.appendChained({ file: kernelActionsFile(), entry });
    return { ok: true, hash_self: result.hash_self, entry, validation, sanitization };
}

/**
 * Variante **best-effort** para instrumentar sitios de mutación en caliente
 * (pulpo, restart, quota-exhausted, desync). NUNCA lanza: si el audit falla,
 * devuelve `{ ok: false, error }` para no dejar el pipeline fuera de servicio
 * (regla inquebrantable #1). El caller igual debe respetar el invariante de
 * orden (llamar ANTES de mutar).
 *
 * @param {object} params — mismos que `appendAction`.
 * @returns {{ ok: boolean, error?: string }}
 */
function safeAppendAction(params) {
    try {
        return appendAction(params);
    } catch (e) {
        return { ok: false, error: (e && e.message) ? String(e.message).slice(0, 200) : 'unknown' };
    }
}

/**
 * Registra una **confirmación rechazada** (CA-5 / RS-4): click de un `chat_id`
 * no-allowlisted sobre una acción privilegiada. La acción NO se aplica; queda
 * la entry de rechazo para forensia.
 *
 * @param {object} params
 * @param {string} params.action — acción que se intentó confirmar.
 * @param {string|number} [params.rejectedChatId] — chat_id que intentó confirmar.
 * @param {string} [params.reason] — contexto (sanitizado).
 * @returns {{ ok: boolean, hash_self?: string, entry?: object, error?: string }}
 */
function appendConfirmationRejected({ action, rejectedChatId, reason } = {}) {
    try {
        const sanitization = sanitizeReason(reason);
        const entry = {
            timestamp: new Date().toISOString(),
            pid: process.pid,
            action: normalizeAction(action),
            impact: 'alto',
            reason: sanitization.sanitized,
            authorized_by: null,
            confirmation_rejected: true,
            rejected_chat_id: rejectedChatId != null ? String(rejectedChatId).slice(0, 64) : null,
        };
        if (sanitization.didRedact) entry.reason_redacted = true;
        const result = auditLog.appendChained({ file: kernelActionsFile(), entry });
        return { ok: true, hash_self: result.hash_self, entry };
    } catch (e) {
        return { ok: false, error: (e && e.message) ? String(e.message).slice(0, 200) : 'unknown' };
    }
}

/**
 * Wrapper de `audit-log.verifyChain` sobre el archivo canónico.
 * @returns {{ ok: boolean, entriesChecked: number, brokenAt?: number, reason?: string }}
 */
function verifyChain() {
    return auditLog.verifyChain(kernelActionsFile());
}

/**
 * Lee las últimas N entries (tail). Para N chico (widget del dashboard) leer
 * todo y cortar es aceptable.
 * @param {number} [n=5]
 * @returns {object[]}
 */
function tail(n = 5) {
    const all = auditLog.readAll(kernelActionsFile());
    if (!Array.isArray(all)) return [];
    const N = Math.max(0, Math.min(Number(n) || 0, all.length));
    return all.slice(all.length - N);
}

module.exports = {
    // API principal
    appendAction,
    safeAppendAction,
    appendConfirmationRejected,
    verifyChain,
    tail,
    // Helpers exportados para tests e instrumentación
    validateAuthorizedBy,
    sanitizeReason,
    normalizeAction,
    normalizeImpact,
    // Constantes
    KERNEL_ACTIONS,
    IMPACT,
    AUTHORIZED_BY_ENUM,
    AUTHORIZED_BY_STATIC,
    MAX_REASON_LEN,
    REDACTION_MARKER,
    // Path resolver (uso interno + tests)
    _paths: () => ({ KERNEL_ACTIONS_FILE: kernelActionsFile() }),
};

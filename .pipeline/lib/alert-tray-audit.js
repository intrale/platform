// =============================================================================
// alert-tray-audit.js — Audit trail append-only para las acciones del operador
// sobre la bandeja de alertas del Home mission-control (issue #3954, EP8-H1).
//
// Modelado 1:1 sobre `lib/partial-pause-audit.js`: mismo `tail` / `statsSince`
// / `verifyChain`, misma escritura atómica encadenada vía `lib/audit-log`
// (hash-chain SHA-256 + file-lock O_EXCL).
//
// Diseño de seguridad (cierra REQ-SEC-2 / REQ-SEC-3 de la fase de análisis):
//
//   1. REQ-SEC-3 — "Quién la atendió" NO se lee del cliente. El dashboard no
//      tiene autenticación (bind loopback, "operador local único"). Aceptar un
//      string de actor arbitrario desde el body sería spoofing + audit
//      injection. El campo `actor` se graba SIEMPRE server-side con el valor
//      fijo `operador-local` + timestamp del server. El supuesto de confianza
//      ("operador local único") queda documentado acá.
//
//   2. REQ-SEC-2 — El snooze NO admite duración free-form. Allowlist cerrada
//      `1h / 4h / 24h` con techo hardcoded de 24h (misma convención que el
//      cost-anomaly banner / modo descanso). Una duración fuera de la allowlist
//      se rechaza (entry `action: 'reject'`, no se aplica supresión).
//
//   3. `alertId` se valida contra una regex allowlist (mismo criterio que el
//      slug de vista del router): nunca se persiste un id arbitrario sin
//      acotar — defensa contra audit-injection / XSS reflejada al renderizar.
//
//   4. `justification` se sanitiza con `lib/redact.js` + regex defensivas +
//      truncado a 500 chars (idéntico a partial-pause-audit).
//
// Este módulo NO decide políticas de UI ni renderiza: sólo persiste el evento
// y deriva el estado de supresión vigente (`activeSuppressions`) leyendo el
// tail. La decisión de mostrar/ocultar una alerta es del renderer/slice.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const auditLog = require('./audit-log');
const { redactSensitive } = require('./redact');

// -----------------------------------------------------------------------------
// Identidad server-side fija (REQ-SEC-3).
//
// El dashboard corre sin auth bajo el supuesto "operador local único". Por eso
// la autoría de cualquier ack/snooze se graba con este valor fijo y NUNCA se
// toma del body del cliente.
// -----------------------------------------------------------------------------
const FIXED_ACTOR = 'operador-local';

// -----------------------------------------------------------------------------
// Allowlist cerrada de duración de snooze (REQ-SEC-2). Techo hardcoded 24h.
// Cualquier valor fuera de esta lista es rechazado (no hay snooze indefinido
// ni free-form: silenciar una degradación real arbitrariamente es un riesgo de
// disponibilidad sobre el propio sistema de alertas).
// -----------------------------------------------------------------------------
const SNOOZE_ALLOWLIST_HOURS = Object.freeze([1, 4, 24]);
const SNOOZE_MAX_HOURS = 24;

// -----------------------------------------------------------------------------
// Acciones válidas. `reject` se persiste para forensia cuando la validación
// falla (igual que partial-pause-audit).
// -----------------------------------------------------------------------------
const VALID_ACTIONS = Object.freeze(['ack', 'snooze', 'reject']);

// `alertId` allowlist: empieza con letra, sólo `[a-z0-9:_-]`, hasta 64 chars.
// Cubre ids como `quota:weekly`, `cost-anomaly`, `pulpo-down`, `infra:dns`.
const ALERT_ID_RE = /^[a-z][a-z0-9:_-]{0,63}$/;
const ALERT_ID_MAX_LEN = 64;

// -----------------------------------------------------------------------------
// Sanitización de justificación (idéntica a partial-pause-audit, CA-6).
// -----------------------------------------------------------------------------
const MAX_JUSTIFICATION_LEN = 500;
const TRUNCATION_NOTICE = '...[TRUNCATED]';
const REDACTION_MARKER = '[REDACTED]';

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
 * Sanitiza una justificación libre antes de persistirla.
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
    let out = String(redactSensitive(text));
    let didRedact = out !== text;
    for (const re of SECRET_LEAK_PATTERNS) {
        const before = out;
        out = out.replace(re, REDACTION_MARKER);
        if (out !== before) didRedact = true;
    }
    let didTruncate = false;
    if (out.length > MAX_JUSTIFICATION_LEN) {
        const keep = MAX_JUSTIFICATION_LEN - TRUNCATION_NOTICE.length;
        out = out.slice(0, Math.max(0, keep)) + TRUNCATION_NOTICE;
        didTruncate = true;
    }
    return { sanitized: out, didRedact, didTruncate };
}

/**
 * Valida un `alertId` contra la regex allowlist.
 * @param {string|null|undefined} value
 * @returns {{ valid: boolean, normalized: string|null, reason?: string }}
 */
function validateAlertId(value) {
    if (value == null || value === '') {
        return { valid: false, normalized: null, reason: 'missing_alert_id' };
    }
    if (typeof value !== 'string') {
        return { valid: false, normalized: null, reason: 'alert_id_not_string' };
    }
    const trimmed = value.trim().slice(0, ALERT_ID_MAX_LEN);
    if (!ALERT_ID_RE.test(trimmed)) {
        return { valid: false, normalized: null, reason: 'alert_id_not_in_allowlist' };
    }
    return { valid: true, normalized: trimmed };
}

/**
 * Valida una duración de snooze contra la allowlist cerrada (REQ-SEC-2).
 * @param {number|string|null|undefined} value
 * @returns {{ valid: boolean, normalized: number|null, reason?: string }}
 */
function validateSnoozeHours(value) {
    const n = typeof value === 'string' ? Number(value) : value;
    if (!Number.isFinite(n)) {
        return { valid: false, normalized: null, reason: 'snooze_hours_not_number' };
    }
    if (!SNOOZE_ALLOWLIST_HOURS.includes(n)) {
        return { valid: false, normalized: null, reason: `snooze_hours_not_in_allowlist:${n}` };
    }
    // Cinturón + tirantes: aunque el allowlist ya topa en 24, validamos el
    // techo hardcoded explícitamente (defense-in-depth).
    if (n > SNOOZE_MAX_HOURS) {
        return { valid: false, normalized: null, reason: 'snooze_hours_over_cap' };
    }
    return { valid: true, normalized: n };
}

// -----------------------------------------------------------------------------
// Resolución de paths.
// -----------------------------------------------------------------------------

function pipelineDir() {
    if (process.env.PIPELINE_DIR_OVERRIDE) return process.env.PIPELINE_DIR_OVERRIDE;
    return path.resolve(__dirname, '..');
}

function auditFile() {
    return path.join(pipelineDir(), 'audit', 'alert-tray-mutations.jsonl');
}

// -----------------------------------------------------------------------------
// API pública.
// -----------------------------------------------------------------------------

/**
 * Persiste una acción del operador (ack/snooze) en el audit log encadenado.
 *
 * El `actor` se IGNORA si viene del caller: SIEMPRE se graba `operador-local`
 * (REQ-SEC-3). La duración de snooze se valida contra la allowlist (REQ-SEC-2).
 * Una validación fallida persiste un entry `action: 'reject'` (forensia) y NO
 * aplica supresión.
 *
 * @param {object} params
 * @param {'ack'|'snooze'} params.action
 * @param {string} params.alertId — id de alerta (validado vs allowlist).
 * @param {number} [params.snoozeHours] — sólo para snooze; allowlist 1/4/24.
 * @param {string} [params.justification] — razón libre (sanitizada).
 * @returns {{ ok: boolean, applied: boolean, hash_self?: string, validation: object }}
 */
function appendAction({ action, alertId, snoozeHours, justification } = {}) {
    const file = auditFile();
    const idV = validateAlertId(alertId);
    const sanitization = sanitizeJustification(justification);

    let validAction = VALID_ACTIONS.includes(action) ? action : null;
    let snoozeV = { valid: true, normalized: null };
    let rejectReason = null;

    if (!idV.valid) {
        rejectReason = idV.reason;
    } else if (validAction !== 'ack' && validAction !== 'snooze') {
        rejectReason = `invalid_action:${String(action).slice(0, 40)}`;
    } else if (validAction === 'snooze') {
        snoozeV = validateSnoozeHours(snoozeHours);
        if (!snoozeV.valid) rejectReason = snoozeV.reason;
    }

    const applied = rejectReason == null;
    const nowMs = Date.now();
    const entry = {
        timestamp: new Date(nowMs).toISOString(),
        pid: process.pid,
        actor: FIXED_ACTOR,                                   // REQ-SEC-3: server-side fijo
        action: applied ? validAction : 'reject',
        alert_id: idV.valid ? idV.normalized : null,
        justification: sanitization.sanitized,
    };
    if (applied && validAction === 'snooze') {
        entry.snooze_hours = snoozeV.normalized;
        entry.snooze_until = new Date(nowMs + snoozeV.normalized * 3600 * 1000).toISOString();
    }
    if (!applied) {
        entry.reject_reason = rejectReason;
        // Guardar el valor crudo recortado para forensia, nunca reflejado a UI.
        if (alertId != null) entry.alert_id_rejected_value = String(alertId).slice(0, 80);
    }
    if (sanitization.didRedact) entry.justification_redacted = true;
    if (sanitization.didTruncate) entry.justification_truncated = true;

    const result = auditLog.appendChained({ file, entry });
    return { ok: true, applied, hash_self: result.hash_self, validation: { id: idV, snooze: snoozeV } };
}

/** Wrapper de ack. */
function recordAck({ alertId, justification } = {}) {
    return appendAction({ action: 'ack', alertId, justification });
}

/** Wrapper de snooze. */
function recordSnooze({ alertId, snoozeHours, justification } = {}) {
    return appendAction({ action: 'snooze', alertId, snoozeHours, justification });
}

/**
 * Verificación de la cadena de hashes del audit log.
 * @returns {{ ok: boolean, entriesChecked: number, brokenAt?: number, reason?: string }}
 */
function verifyChain() {
    return auditLog.verifyChain(auditFile());
}

/**
 * Últimas N entries del audit (tail simple, suficiente para el widget).
 * @param {number} [n=5]
 * @returns {object[]}
 */
function tail(n = 5) {
    const all = auditLog.readAll(auditFile());
    if (!Array.isArray(all)) return [];
    const N = Math.max(0, Math.min(Number(n) || 0, all.length));
    return all.slice(all.length - N);
}

/**
 * Cuenta acciones en una ventana temporal (default 24h) por tipo.
 * @param {object} [opts]
 * @param {number} [opts.windowMs]
 * @returns {{ total:number, ack:number, snooze:number, rejected:number, since:string }}
 */
function statsSince({ windowMs = 24 * 60 * 60 * 1000 } = {}) {
    const all = auditLog.readAll(auditFile());
    const cutoff = Date.now() - windowMs;
    const sinceIso = new Date(cutoff).toISOString();
    let total = 0, ack = 0, snooze = 0, rejected = 0;
    for (const e of (Array.isArray(all) ? all : [])) {
        const t = Date.parse(e.timestamp || '');
        if (!Number.isFinite(t) || t < cutoff) continue;
        total++;
        if (e.action === 'ack') ack++;
        else if (e.action === 'snooze') snooze++;
        else if (e.action === 'reject') rejected++;
    }
    return { total, ack, snooze, rejected, since: sinceIso };
}

/**
 * Deriva el estado de supresión vigente por alerta a partir del tail.
 *
 * Para cada `alert_id` se toma la ÚLTIMA acción aplicada (ack/snooze):
 *   - ack    → suprimida (sin vencimiento).
 *   - snooze → suprimida hasta `snooze_until` (si todavía no venció).
 *
 * Devuelve un mapa `{ [alertId]: { action, actor, timestamp, snoozeUntil } }`
 * SÓLO con las alertas cuya supresión sigue vigente al momento de la consulta.
 *
 * @returns {Object<string, {action:string, actor:string, timestamp:string, snoozeUntil:string|null}>}
 */
function activeSuppressions() {
    const all = auditLog.readAll(auditFile());
    const latest = {};
    for (const e of (Array.isArray(all) ? all : [])) {
        if (!e || !e.alert_id) continue;
        if (e.action !== 'ack' && e.action !== 'snooze') continue;
        latest[e.alert_id] = e; // append-only ⇒ el último gana
    }
    const now = Date.now();
    const out = {};
    for (const [id, e] of Object.entries(latest)) {
        if (e.action === 'snooze') {
            const until = Date.parse(e.snooze_until || '');
            if (!Number.isFinite(until) || until <= now) continue; // venció
            out[id] = { action: 'snooze', actor: e.actor, timestamp: e.timestamp, snoozeUntil: e.snooze_until };
        } else {
            out[id] = { action: 'ack', actor: e.actor, timestamp: e.timestamp, snoozeUntil: null };
        }
    }
    return out;
}

module.exports = {
    appendAction,
    recordAck,
    recordSnooze,
    verifyChain,
    tail,
    statsSince,
    activeSuppressions,
    // Helpers / validadores (tests + caller del endpoint)
    validateAlertId,
    validateSnoozeHours,
    sanitizeJustification,
    // Constantes
    FIXED_ACTOR,
    SNOOZE_ALLOWLIST_HOURS,
    SNOOZE_MAX_HOURS,
    VALID_ACTIONS,
    ALERT_ID_RE,
    ALERT_ID_MAX_LEN,
    MAX_JUSTIFICATION_LEN,
    REDACTION_MARKER,
    // Path resolver (tests)
    _paths: () => ({ AUDIT_FILE: auditFile() }),
};

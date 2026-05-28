// =============================================================================
// notify-telegram.js — Helper genérico para emitir alertas operacionales
// del control plane (waves, partial-pause, file-lock) — issue #3518.
//
// Por qué este helper existe
// --------------------------
// El pipeline ya tiene notifiers específicos (quota-notifier, telegram-notifier,
// notifier-infra-recovered, etc.), cada uno con su semántica. NO hay un punto
// canónico para "alerta operacional de bloqueante con call-to-action a Leo"
// como pide el CA-9 de #3518.
//
// Este helper resuelve eso con una firma única:
//
//   notifyTelegram({ level, component, message, diag, context? })
//
// Y deposita un JSON drop en `.pipeline/servicios/telegram/pendiente/` con
// el formato que `servicio-telegram.js` ya sabe leer (`{ text, parse_mode }`).
// Fire-and-forget — si el servicio Telegram está caído, el archivo queda
// encolado y se procesará al volver.
//
// Estructura del mensaje (CA-9 de #3518, guidelines de UX)
// ---------------------------------------------------------
//   <emoji severidad> <component>: <resumen 1 línea>
//
//   <contexto: PID, host, timestamp ISO>
//
//   <call-to-action concreto>
//
//   (diag: <comando o path>)
//
// Severidades
// -----------
//   'error'   → 🚨 (bloqueante, requiere acción inmediata)
//   'warn'    → ⚠️  (degradado, requiere atención pero no urgente)
//   'info'    → ℹ️  (informativo, sin acción requerida)
//
// Reglas inquebrantables (security + UX)
// --------------------------------------
//   - NUNCA stacktraces crudos en el mensaje. El stacktrace va al log file.
//   - PID + hostname + timestamp ISO SIEMPRE en alertas de lock/concurrencia.
//   - Idioma: español. Términos técnicos del stack en inglés (lock, fsync, PID).
//   - Cero deps npm. Cero red directa — usa la cola del servicio-telegram.
//   - Fail-soft: si el drop falla (FS lleno, permisos), NO propaga — solo
//     loguea warning. Una alerta perdida no debe romper el caller.
// =============================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const PIPELINE_DIR_DEFAULT = path.join(__dirname, '..');

function pipelineDir() {
    if (process.env.PIPELINE_DIR_OVERRIDE) return process.env.PIPELINE_DIR_OVERRIDE;
    return PIPELINE_DIR_DEFAULT;
}

function telegramQueueDir() {
    return path.join(pipelineDir(), 'servicios', 'telegram', 'pendiente');
}

const EMOJI_BY_LEVEL = Object.freeze({
    error: '\u{1F6A8}', // 🚨
    warn: '\u{26A0}\u{FE0F}',  // ⚠️
    info: '\u{2139}\u{FE0F}',  // ℹ️
});

function emojiFor(level) {
    return EMOJI_BY_LEVEL[level] || EMOJI_BY_LEVEL.info;
}

/**
 * Construye el texto del mensaje a partir del payload estructurado.
 * Determinístico — los tests pueden comparar string-equal sobre la salida
 * (excepto por timestamp si el caller no lo provee).
 */
function buildMessage(payload) {
    const level = payload.level || 'info';
    const component = String(payload.component || 'pipeline');
    const summary = String(payload.message || '(sin descripción)');
    const diag = payload.diag ? String(payload.diag) : null;
    const ts = payload.ts || new Date().toISOString();
    const ctx = payload.context && typeof payload.context === 'object' ? payload.context : {};

    const lines = [];
    lines.push(`${emojiFor(level)} ${component}: ${summary}`);
    lines.push('');

    // Contexto: holder (PID, host), timestamp, campos custom.
    const ctxLines = [];
    if (payload.holder && typeof payload.holder === 'object') {
        const h = payload.holder;
        const parts = [];
        if (h.pid) parts.push(`pid=${h.pid}`);
        if (h.hostname) parts.push(`host=${h.hostname}`);
        if (h.startTime) parts.push(`start=${h.startTime}`);
        if (parts.length > 0) ctxLines.push(`holder: ${parts.join(' ')}`);
    }
    for (const key of Object.keys(ctx)) {
        const val = ctx[key];
        if (val == null || val === '') continue;
        ctxLines.push(`${key}: ${typeof val === 'object' ? JSON.stringify(val) : String(val)}`);
    }
    ctxLines.push(`emisor: pid=${process.pid} host=${os.hostname()} ts=${ts}`);
    lines.push(...ctxLines);
    lines.push('');

    // Acción concreta (recomendable que el caller la inyecte explícitamente).
    if (payload.action) {
        lines.push(String(payload.action));
        lines.push('');
    }

    // Detalle adicional (1 línea, sin stacktrace). Cap defensivo 400 chars.
    if (payload.detail) {
        const det = String(payload.detail).replace(/\s+/g, ' ').slice(0, 400);
        lines.push(`detalle: ${det}`);
    }

    if (diag) {
        lines.push(`(diag: ${diag})`);
    }

    return lines.join('\n');
}

/**
 * Emite una alerta operacional a Telegram. Fire-and-forget.
 *
 * @param {object} payload
 * @param {'error'|'warn'|'info'} [payload.level='info']
 * @param {string} payload.component   — ej. 'waves-lock', 'waves-schema'
 * @param {string} payload.message     — resumen 1 línea
 * @param {string} [payload.diag]      — comando/path de diagnóstico
 * @param {string} [payload.action]    — call-to-action concreto para Leo
 * @param {string} [payload.detail]    — info adicional (1 línea, sin stack)
 * @param {object} [payload.context]   — campos custom k:v
 * @param {object} [payload.holder]    — { pid, hostname, startTime } del holder
 *                                       (caso lock timeout)
 * @returns {{ ok: boolean, dropPath?: string, reason?: string }}
 */
function notifyTelegram(payload) {
    if (!payload || typeof payload !== 'object') {
        return { ok: false, reason: 'invalid_payload' };
    }
    if (!payload.component || !payload.message) {
        return { ok: false, reason: 'missing_required_fields' };
    }

    let text;
    try {
        text = buildMessage(payload);
    } catch (err) {
        console.warn(`[notify-telegram] error construyendo mensaje: ${err.message}`);
        return { ok: false, reason: 'build_failed' };
    }

    const dir = telegramQueueDir();
    try {
        fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
        console.warn(`[notify-telegram] no se pudo crear ${dir}: ${err.message}`);
        return { ok: false, reason: 'mkdir_failed' };
    }

    const ts = Date.now();
    // Identificador único por componente para evitar colisiones cuando dos
    // alertas del mismo componente caen en el mismo ms.
    const slug = String(payload.component).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 32);
    const filename = `alert-${slug}-${ts}-${process.pid}.json`;
    const dropPath = path.join(dir, filename);

    const drop = {
        text,
        // El servicio default usa Markdown; nuestro texto no lleva sintaxis MD,
        // se renderiza igual como texto plano. Pasamos 'Markdown' por consistencia
        // con el resto del pipeline (no rompe nada — caracteres safe).
        parse_mode: 'Markdown',
    };

    try {
        fs.writeFileSync(dropPath, JSON.stringify(drop, null, 2));
        return { ok: true, dropPath };
    } catch (err) {
        console.warn(`[notify-telegram] no se pudo escribir ${dropPath}: ${err.message}`);
        return { ok: false, reason: 'write_failed' };
    }
}

module.exports = {
    notifyTelegram,
    // Helpers exportados para tests
    _internal: {
        buildMessage,
        emojiFor,
        telegramQueueDir,
        EMOJI_BY_LEVEL,
    },
};

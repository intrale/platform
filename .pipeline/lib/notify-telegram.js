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
const { redactSecretValue, redactSensitive, redactObject } = require('./redact');

const PIPELINE_DIR_DEFAULT = path.join(__dirname, '..');

// #5400 / SEC-1 — Escape del Markdown legacy de Telegram.
//
// El comentario histórico de este módulo decía que pasar `parse_mode: 'Markdown'`
// "no rompe nada — caracteres safe". Es FALSO en cuanto el mensaje interpola
// datos del pipeline: causas, autorías, títulos de issues, nombres de skill. Un
// `snake_case` mete un `_` impar y Telegram responde `400 can't parse entities`;
// `servicio-telegram` reintenta con el MISMO parse_mode y termina archivando en
// `fallido/`. Resultado: la alerta de "pipeline parado" nunca llega — que es
// exactamente el modo de falla que este issue viene a cerrar (mismo agujero de
// #5173).
//
// No alcanza con omitir `parse_mode`: el servicio hace `data.parse_mode ||
// 'Markdown'`, así que un valor ausente o vacío cae igual en Markdown. La
// solución local y completa es ESCAPAR el texto antes de encolarlo. Telegram
// renderiza `\_` como `_`, así que el mensaje se lee idéntico.
//
// Import defensivo (mismo patrón que `redact` en dispatch-cause.js): si
// `config-schema` no carga, se usa un escape local equivalente. Una alerta jamás
// debe perderse por un problema de require.
let escapeMarkdownLegacy;
try {
    ({ escapeMarkdownLegacy } = require('./config-schema'));
} catch { /* fallback abajo */ }
if (typeof escapeMarkdownLegacy !== 'function') {
    escapeMarkdownLegacy = (s) => String(s).replace(/([_*`[])/g, '\\$1');
}

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

function canonicalChatId(value) {
    if (typeof value !== 'string' || !/^-?[1-9]\d*$/.test(value)) return null;
    const numeric = Number(value);
    return Number.isSafeInteger(numeric) ? String(numeric) : null;
}

function resolvePrivateChatId(requested) {
    if (requested == null) return { ok: true, chatId: null };
    const anchorRaw = process.env.TELEGRAM_LEO_OPERATOR_CHAT_ID;
    if (anchorRaw == null || anchorRaw === '') return { ok: false, reason: 'no_operator_chat_id' };
    const anchor = canonicalChatId(anchorRaw);
    if (!anchor) return { ok: false, reason: 'invalid_operator_chat_id' };
    const candidate = canonicalChatId(requested);
    if (!candidate || candidate !== anchor) return { ok: false, reason: 'unauthorized_chat_id' };
    return { ok: true, chatId: anchor };
}

function redactFreeText(value) {
    return redactSecretValue(redactSensitive(String(value)));
}

/**
 * Construye el texto del mensaje a partir del payload estructurado.
 * Determinístico — los tests pueden comparar string-equal sobre la salida
 * (excepto por timestamp si el caller no lo provee).
 */
function buildMessage(payload) {
    const level = payload.level || 'info';
    const component = redactFreeText(payload.component || 'pipeline');
    const summary = redactFreeText(payload.message || '(sin descripción)');
    const diag = payload.diag ? redactFreeText(payload.diag) : null;
    const ts = payload.ts || new Date().toISOString();
    const ctx = payload.context && typeof payload.context === 'object' ? payload.context : {};

    const lines = [];
    lines.push(`${emojiFor(level)} ${component}: ${summary}`);
    lines.push('');

    // Contexto: holder (PID, host), timestamp, campos custom.
    //
    // SEGURIDAD (#5450 rev-2): `redactObject` sólo consulta la tabla de claves
    // sensibles cuando ITERA las entradas de un objeto. Aplicado sobre un string
    // suelto degrada a redacción por patrón/entropía, que no reconoce secretos
    // cortos o de baja entropía. Por eso el objeto se redacta COMPLETO acá,
    // ANTES de iterarlo: así un secreto colgado directo de una clave sensible de
    // primer nivel (`context: { password: 'x' }`) también queda tachado, tanto en
    // el dropfile en reposo como en el body saliente. Vale para los dos destinos
    // (privado con `chat_id` y el camino histórico sin `chat_id`, que va al grupo).
    const ctxLines = [];
    if (payload.holder && typeof payload.holder === 'object') {
        const h = redactObject(payload.holder);
        const parts = [];
        if (h.pid) parts.push(`pid=${redactFreeText(h.pid)}`);
        if (h.hostname) parts.push(`host=${redactFreeText(h.hostname)}`);
        if (h.startTime) parts.push(`start=${redactFreeText(h.startTime)}`);
        if (parts.length > 0) ctxLines.push(`holder: ${parts.join(' ')}`);
    }
    const safeCtx = redactObject(ctx);
    for (const key of Object.keys(safeCtx)) {
        const val = safeCtx[key];
        if (val == null || val === '') continue;
        const safeValue = typeof val === 'object' ? JSON.stringify(val) : val;
        ctxLines.push(`${redactFreeText(key)}: ${redactFreeText(safeValue)}`);
    }
    ctxLines.push(`emisor: pid=${process.pid} host=${os.hostname()} ts=${ts}`);
    lines.push(...ctxLines);
    lines.push('');

    // Acción concreta (recomendable que el caller la inyecte explícitamente).
    if (payload.action) {
        lines.push(redactFreeText(payload.action));
        lines.push('');
    }

    // Detalle adicional (1 línea, sin stacktrace). Cap defensivo 400 chars.
    if (payload.detail) {
        const det = redactFreeText(payload.detail).replace(/\s+/g, ' ').slice(0, 400);
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

    const destination = resolvePrivateChatId(payload.chat_id);
    if (!destination.ok) {
        console.warn(`[notify-telegram] aviso privado omitido: ${destination.reason}`);
        return { ok: false, reason: destination.reason };
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
    const slug = redactFreeText(payload.component).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 32);
    const filename = `alert-${slug}-${ts}-${process.pid}.json`;
    const dropPath = path.join(dir, filename);

    const drop = {
        // #5400 / SEC-1 — `buildMessage` no produce sintaxis Markdown intencional:
        // todo lo que parezca un metacarácter viene de datos interpolados y tiene
        // que llegar literal. Escapamos el texto completo para que el envío no se
        // caiga con `400 can't parse entities` y termine en `fallido/`.
        text: escapeMarkdownLegacy(text),
        parse_mode: 'Markdown',
    };
    if (destination.chatId != null) drop.chat_id = destination.chatId;

    try {
        fs.writeFileSync(dropPath, JSON.stringify(drop, null, 2), { mode: 0o600, flag: 'wx' });
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
        canonicalChatId,
        resolvePrivateChatId,
    },
};

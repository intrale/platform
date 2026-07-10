// =============================================================================
// kernel-action-policy.js — Resolución de política por-acción para GATE 3
// (issue #4577 · épico #4570). Decide, por acción autónoma del kernel, si el
// kernel debe **notificar-y-proceder** (`notify-and-proceed`) o
// **esperar-confirmación** (`wait-confirmation`) del operador.
//
// Complementa a `lib/kernel-actions-audit.js` (el REGISTRO). Este módulo es la
// **capa de política**:
//
//   - CA-4: política por-acción (NO global), leída desde `config.yaml`
//     (`gates.gate3.policy`). Defaults seguros por acción cuando la config no
//     la declara. Recovery crítico (worktree-reset, quota-flag,
//     desync-autoresolve) → `notify-and-proceed`. Electivas (realign-allowlist,
//     reseed-wave) → `wait-confirmation`.
//
//   - CA-5 / RS-4: autenticación del confirmador. `validateConfirmer(chatId,
//     allowlist)` valida el `chat_id` que hace click contra la allowlist de
//     operadores. Un click no-allowlisted se rechaza (el caller registra la
//     entry de rechazo vía `kernel-actions-audit.appendConfirmationRejected`).
//
//   - CA-6 / RS-5: anti-deadlock. `resolveTimeoutFallback(action)` define el
//     fallback seguro cuando `wait-confirmation` vence sin respuesta del
//     operador, para que "esperar firma" no sea un vector de auto-DoS.
//
// Este módulo es **puro** (sin IO de red): resuelve política y valida
// autoría a partir de la config y la allowlist que le pasa el caller. La
// superficie Telegram (enviar el mensaje, esperar el callback) vive en el
// caller (pulpo/listener), reusando `servicio-telegram` / `listener-telegram`.
// =============================================================================
'use strict';

const path = require('node:path');
const fs = require('node:fs');

const POLICY_MODES = Object.freeze(['notify-and-proceed', 'wait-confirmation']);
const TIMEOUT_FALLBACKS = Object.freeze(['proceed', 'abort']);

// Alias tolerados en config.yaml (una sola clave `quota-flag` cubre set+clear).
// Las claves de `kernel-actions-audit.KERNEL_ACTIONS` que comparten política.
const ACTION_ALIASES = Object.freeze({
    'quota-flag-set': 'quota-flag',
    'quota-flag-clear': 'quota-flag',
});

// -----------------------------------------------------------------------------
// Defaults por-acción (CA-4). Seguros y explícitos: recovery crítico procede
// (no bloquear el destrabe), electivas esperan confirmación humana.
// Claves normalizadas al alias de config (quota-flag agrupa set/clear).
// -----------------------------------------------------------------------------
const DEFAULT_POLICY = Object.freeze({
    'realign-allowlist':  'wait-confirmation',
    'reseed-wave':        'wait-confirmation',
    'quota-flag':         'notify-and-proceed',
    'worktree-reset':     'notify-and-proceed',
    'desync-autoresolve': 'notify-and-proceed',
});

// -----------------------------------------------------------------------------
// Fallback seguro por-acción al vencer el timeout de `wait-confirmation`
// (CA-6 / RS-5). `proceed` = aplicar la acción igual (el default configurado
// era electivo pero el operador está ausente y no aplicar bloquea el kernel).
// `abort` = NO aplicar (dejar el estado como estaba, más conservador).
//
// Criterio: realign/reseed son operaciones de *convergencia* — si el operador
// no responde, es más seguro NO mutar y dejar la divergencia visible que
// resetear progreso sin firma. Por eso el fallback default es `abort`.
// Configurable por acción vía `gates.gate3.timeout_fallback`.
// -----------------------------------------------------------------------------
const DEFAULT_TIMEOUT_FALLBACK = Object.freeze({
    'realign-allowlist':  'abort',
    'reseed-wave':        'abort',
    'quota-flag':         'proceed',
    'worktree-reset':     'proceed',
    'desync-autoresolve': 'proceed',
});

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000; // 15min sin respuesta → fallback

/**
 * Normaliza una acción a su clave de política (aplica alias).
 * @param {string} action
 * @returns {string}
 */
function policyKey(action) {
    if (typeof action !== 'string') return 'unknown';
    return ACTION_ALIASES[action] || action;
}

// -----------------------------------------------------------------------------
// Carga de config.yaml (lazy, js-yaml safe-by-default). NUNCA throw: ante
// cualquier error devolvemos `{}` y caemos a los defaults. Mismo criterio
// defensivo que el resto del pipeline (config puede faltar en tests/CI).
// -----------------------------------------------------------------------------
function pipelineDir() {
    if (process.env.PIPELINE_DIR_OVERRIDE) return process.env.PIPELINE_DIR_OVERRIDE;
    return path.resolve(__dirname, '..');
}

function loadGate3Config(configOverride) {
    if (configOverride && typeof configOverride === 'object') {
        return extractGate3(configOverride);
    }
    try {
        const yaml = require('js-yaml');
        const file = path.join(pipelineDir(), 'config.yaml');
        const doc = yaml.load(fs.readFileSync(file, 'utf8')) || {};
        return extractGate3(doc);
    } catch {
        return {};
    }
}

function extractGate3(doc) {
    const gates = (doc && typeof doc.gates === 'object' && doc.gates) || {};
    const gate3 = (gates && typeof gates.gate3 === 'object' && gates.gate3) || {};
    return gate3;
}

/**
 * Resuelve la política de una acción: `notify-and-proceed` | `wait-confirmation`.
 *
 * Orden de precedencia:
 *   1. `config.gates.gate3.policy[<clave>]` (si es un modo válido).
 *   2. `DEFAULT_POLICY[<clave>]`.
 *   3. `'notify-and-proceed'` (fail-open hacia disponibilidad: nunca dejar el
 *      kernel bloqueado por una acción no declarada — RS-5).
 *
 * @param {string} action — acción de `KERNEL_ACTIONS`.
 * @param {object} [opts]
 * @param {object} [opts.config] — doc de config.yaml ya parseado (evita IO).
 * @returns {{ mode: string, source: 'config'|'default'|'fallback', key: string }}
 */
function resolvePolicy(action, opts = {}) {
    const key = policyKey(action);
    const gate3 = loadGate3Config(opts.config);
    const policyMap = (gate3 && typeof gate3.policy === 'object' && gate3.policy) || {};

    const fromConfig = policyMap[key];
    if (typeof fromConfig === 'string' && POLICY_MODES.includes(fromConfig)) {
        return { mode: fromConfig, source: 'config', key };
    }
    if (Object.prototype.hasOwnProperty.call(DEFAULT_POLICY, key)) {
        return { mode: DEFAULT_POLICY[key], source: 'default', key };
    }
    return { mode: 'notify-and-proceed', source: 'fallback', key };
}

/**
 * ¿La acción requiere confirmación del operador antes de aplicarse?
 * @param {string} action
 * @param {object} [opts]
 * @returns {boolean}
 */
function requiresConfirmation(action, opts = {}) {
    return resolvePolicy(action, opts).mode === 'wait-confirmation';
}

// -----------------------------------------------------------------------------
// Autenticación del confirmador (CA-5 / RS-4).
// -----------------------------------------------------------------------------

/**
 * Normaliza un chat_id a string comparable (Telegram los emite como number o
 * string según el path). Devuelve null si no es un valor usable.
 * @param {string|number|null|undefined} id
 * @returns {string|null}
 */
function normalizeChatId(id) {
    if (id == null) return null;
    if (typeof id === 'number' && Number.isFinite(id)) return String(id);
    if (typeof id === 'string' && id.trim().length > 0) return id.trim();
    return null;
}

/**
 * Valida que el `chat_id` que confirma esté en la allowlist de operadores.
 *
 * La allowlist puede venir como array o valor único (el pipeline tiene UN
 * operador, `telegram.chat_id`). Un valor no presente → `{ authorized: false }`
 * y el caller registra la entry de rechazo (NO aplica la acción).
 *
 * @param {string|number} chatId — chat_id del click de confirmación.
 * @param {string|number|Array<string|number>} allowlist — operadores autorizados.
 * @returns {{ authorized: boolean, chatId: string|null, reason?: string }}
 */
function validateConfirmer(chatId, allowlist) {
    const norm = normalizeChatId(chatId);
    if (norm == null) {
        return { authorized: false, chatId: null, reason: 'missing_or_invalid_chat_id' };
    }
    const list = Array.isArray(allowlist) ? allowlist : [allowlist];
    const allowed = list
        .map(normalizeChatId)
        .filter(v => v != null);
    if (allowed.length === 0) {
        // Sin allowlist configurada NO autorizamos (fail-closed en auth — RS-4).
        return { authorized: false, chatId: norm, reason: 'empty_operator_allowlist' };
    }
    if (allowed.includes(norm)) {
        return { authorized: true, chatId: norm };
    }
    return { authorized: false, chatId: norm, reason: 'chat_id_not_in_operator_allowlist' };
}

// -----------------------------------------------------------------------------
// Anti-deadlock / timeout (CA-6 / RS-5).
// -----------------------------------------------------------------------------

/**
 * Resuelve el fallback seguro y el timeout de una acción en modo
 * `wait-confirmation` cuando el operador no responde.
 *
 * @param {string} action
 * @param {object} [opts]
 * @param {object} [opts.config]
 * @returns {{ fallback: 'proceed'|'abort', timeoutMs: number, source: 'config'|'default' }}
 */
function resolveTimeoutFallback(action, opts = {}) {
    const key = policyKey(action);
    const gate3 = loadGate3Config(opts.config);
    const fbMap = (gate3 && typeof gate3.timeout_fallback === 'object' && gate3.timeout_fallback) || {};
    const tMap = (gate3 && typeof gate3.timeout_ms === 'object' && gate3.timeout_ms) || {};

    let fallback = DEFAULT_TIMEOUT_FALLBACK[key] || 'abort';
    let fbSource = 'default';
    if (fbMap[key] === 'proceed' || fbMap[key] === 'abort') {
        fallback = fbMap[key];
        fbSource = 'config';
    }

    let timeoutMs = DEFAULT_TIMEOUT_MS;
    const gConfigTimeout = Number(gate3.timeout_ms);
    if (Number.isFinite(Number(tMap[key])) && Number(tMap[key]) > 0) {
        timeoutMs = Number(tMap[key]);
    } else if (Number.isFinite(gConfigTimeout) && gConfigTimeout > 0) {
        timeoutMs = gConfigTimeout;
    }

    return { fallback, timeoutMs, source: fbSource };
}

function telegramQueueDir() {
    return path.join(pipelineDir(), 'servicios', 'telegram', 'pendiente');
}

function safeMarkdownText(value) {
    return String(value == null ? '' : value)
        .replace(/[`*_{}\[\]()#+\-.!|>]/g, '\\$&')
        .slice(0, 500);
}

function buildOperatorMessage({ action, mode, impact, reason, policySource, decision }) {
    const level = impact === 'alto' ? 'ALTO' : (impact === 'medio' ? 'MEDIO' : 'BAJO');
    const verb = mode === 'wait-confirmation'
        ? 'requiere confirmacion de operador'
        : 'notifica y procede';
    return [
        `GATE 3 kernel - impacto ${level}`,
        `Accion: ${safeMarkdownText(action)}`,
        `Politica: ${safeMarkdownText(mode)} (${safeMarkdownText(policySource || 'n/a')})`,
        `Decision: ${safeMarkdownText(decision || verb)}`,
        `Motivo: ${safeMarkdownText(reason || 'sin motivo informado')}`,
        'Audit: .pipeline/audit/kernel-actions.jsonl',
    ].join('\n');
}

/**
 * Encola una notificacion al operador usando la cola existente de
 * servicio-telegram.js. No toca red y nunca debe bloquear la mutacion.
 *
 * @param {object} params
 * @param {Function} [send] - inyeccion para tests.
 * @returns {{ ok: boolean, path?: string, error?: string }}
 */
function notifyOperator(params = {}, send) {
    if (typeof send === 'function') {
        return send(params);
    }
    try {
        const dir = telegramQueueDir();
        fs.mkdirSync(dir, { recursive: true });
        const id = `gate3-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
        const file = path.join(dir, `${id}.json`);
        const payload = {
            text: buildOperatorMessage(params),
            parse_mode: 'Markdown',
            _correlationId: id,
        };
        fs.writeFileSync(file, JSON.stringify(payload));
        return { ok: true, path: file };
    } catch (e) {
        return { ok: false, error: (e && e.message) ? String(e.message).slice(0, 200) : 'unknown' };
    }
}

function appendRejected(action, chatId, reason, appendRejectedFn) {
    const fn = appendRejectedFn || require('./kernel-actions-audit').appendConfirmationRejected;
    try {
        return fn({ action, rejectedChatId: chatId, reason });
    } catch (e) {
        return { ok: false, error: (e && e.message) ? String(e.message).slice(0, 200) : 'unknown' };
    }
}

/**
 * Punto unico de ejecucion de la politica GATE 3 para callers de produccion.
 * Se invoca DESPUES de kernel-actions-audit.safeAppendAction y ANTES de mutar.
 *
 * @param {string} action
 * @param {object} [opts]
 * @param {string} [opts.impact]
 * @param {string} [opts.reason]
 * @param {string|number} [opts.confirmerChatId]
 * @param {string|number|Array<string|number>} [opts.operatorAllowlist]
 * @param {object} [opts.config]
 * @param {Function} [opts.notify]
 * @param {Function} [opts.appendConfirmationRejected]
 * @param {'proceed'|'abort'} [opts.timeoutFallbackOverride]
 * @returns {{ proceed: boolean, mode: string, reason: string, policy: object, notification?: object, confirmation?: object, fallback?: object, rejection?: object }}
 */
function enforceActionPolicy(action, opts = {}) {
    const policy = resolvePolicy(action, opts);
    const base = { action, mode: policy.mode, impact: opts.impact, reason: opts.reason, policySource: policy.source };

    if (policy.mode === 'notify-and-proceed') {
        const notification = notifyOperator({ ...base, decision: 'se procede sin bloquear' }, opts.notify);
        return { proceed: true, mode: policy.mode, reason: 'notify-and-proceed', policy, notification };
    }

    const confirmation = validateConfirmer(opts.confirmerChatId, opts.operatorAllowlist);
    if (confirmation.authorized) {
        const notification = notifyOperator({ ...base, decision: `confirmado por chat_id ${confirmation.chatId}` }, opts.notify);
        return { proceed: true, mode: policy.mode, reason: 'confirmed', policy, confirmation, notification };
    }

    const rejection = appendRejected(
        action,
        confirmation.chatId,
        `wait-confirmation rechazado: ${confirmation.reason || 'sin_confirmacion_valida'}; ${opts.reason || ''}`,
        opts.appendConfirmationRejected,
    );
    const fallback = resolveTimeoutFallback(action, opts);
    const fallbackValue = TIMEOUT_FALLBACKS.includes(opts.timeoutFallbackOverride)
        ? opts.timeoutFallbackOverride
        : fallback.fallback;
    const notification = notifyOperator({
        ...base,
        decision: `sin confirmacion valida (${confirmation.reason || 'n/a'}), fallback=${fallbackValue}`,
    }, opts.notify);
    return {
        proceed: fallbackValue === 'proceed',
        mode: policy.mode,
        reason: fallbackValue === 'proceed' ? 'timeout-fallback-proceed' : 'confirmation-required',
        policy,
        confirmation,
        fallback: { ...fallback, fallback: fallbackValue },
        rejection,
        notification,
    };
}

module.exports = {
    enforceActionPolicy,
    notifyOperator,
    resolvePolicy,
    requiresConfirmation,
    validateConfirmer,
    resolveTimeoutFallback,
    normalizeChatId,
    policyKey,
    // Constantes
    POLICY_MODES,
    TIMEOUT_FALLBACKS,
    DEFAULT_POLICY,
    DEFAULT_TIMEOUT_FALLBACK,
    DEFAULT_TIMEOUT_MS,
    ACTION_ALIASES,
};

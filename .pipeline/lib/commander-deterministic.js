// =============================================================================
// commander-deterministic.js — Router + handlers determinísticos del Commander
// Issue #3257
//
// Camino "feliz" del Commander que NO invoca a Claude. Cubre comandos de
// status/listado/snapshot/logs/health que son lectura de filesystem +
// render de plantilla Markdown. Diseñado para responder SIEMPRE — incluso con
// cuota Claude agotada o multi-provider caído.
//
// Arquitectura:
//
//   classify(text)        → { class, command, args, raw, rawTruncated }
//                            class ∈ {'deterministic','llm','unknown'}
//   dispatch(ctx, intent) → { reply, status, handler, durationMs }
//                            reply: string MarkdownV2 listo para enviar
//                            status: 'ok' | 'rate_limited' | 'invalid_args' | 'error'
//
// El router clasifica con allowlist explícita (CA-7). Los handlers validan args
// con schemas cerrados (CA-8). Toda salida pasa por la plantilla con escape
// MarkdownV2 (CA-12) y, cuando lee FS, por redactReadOutput (CA-9).
//
// Reglas inquebrantables:
// - Sin `eval`/`new Function`/`vm`. Solo regex, switch y validators de args.
// - Para spawn de subprocess (dashboard up/down, procesos node), usar
//   `execFile`/`spawn` con argv array. JAMÁS shell-concat.
// - Cada dispatch persiste en audit-log (CA-10), con args hasheados.
// - Rate limit por chat_id antes de cualquier handler (CA-11).
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');
const { fillTemplate, escapeMarkdownV2 } = require('./commander/fill-template');
const { createAuditLog } = require('./commander/audit-log');
const { createRateLimiter } = require('./commander/rate-limit');
const {
    createDestructiveCooldown,
    humanizeRetryAfter,
    DEFAULT_COOLDOWN_MS,
} = require('./commander/destructive-cooldown');
const { redactReadOutput } = require('./commander/redact-read');
const baseRedact = require('./redact');

// -----------------------------------------------------------------------------
// CLASIFICADOR (CA-1 / CA-7)
// -----------------------------------------------------------------------------

// Allowlist explícita de slash-commands clasificados como `deterministic`.
// El comando llega en lowercase. Cualquier slash-command que NO esté acá NO
// se trata como determinístico — eventualmente cae a `llm` o `unknown`.
const DETERMINISTIC_SLASH = new Set([
    'status',
    'snapshot',
    'wave',            // #3262 — snapshot ejecutivo de ola (avance %, ETA, intervención)
    'listado',
    'allowlist',
    'tail',
    'dashboard-up',
    'dashboard-down',
    'screenshot',
    'procesos',
    'salud',
    'descanso',
    // Issue #3253 — /quota read-only sin LLM (CA-1).
    'quota',
    // Comandos legacy del switch original que también son determinísticos:
    'help', 'start',
    'actividad',
    'ghostbusters',
    'pausar', 'pause',
    'reanudar', 'resume',
    'pause-partial', 'pause_partial', 'pausarparcial',
    'costos',
    'limpiar',
    'restart',
    'bloqueados',
    'unblock',
    'stop',
]);

// Slash-commands que SE clasifican como `llm` (creación/análisis con razonamiento).
const LLM_SLASH = new Set([
    'intake',
    'proponer',
]);

// Patrones NLP determinísticos para texto natural corto. Cada entrada produce
// `command` y opcionalmente `args` extraídos del input.
//
// IMPORTANTE: mantener compatibilidad con los patrones legacy en pulpo.js
// (parseCommand:7189-7208) para no romper la UX existente (CA-18 no-regresión).
const NLP_PATTERNS = [
    { regex: /\b(status|estado del pipeline|tablero|que hay en el pipeline|qué hay en el pipeline)\b/i, command: 'status' },
    // #3262 — `/wave` y "¿cómo va la ola?" / "estado de la ola con audio" — snapshot ejecutivo.
    // El patrón captura "estado/avance/cómo/cómo viene/cómo va" + "ola" para los pedidos naturales.
    { regex: /\b(wave|cómo (viene|va|anda) la ola|c[oó]mo (viene|va|anda) la ola|avance de (la )?ola|estado de (la )?ola)\b/i, command: 'wave' },
    { regex: /\b(snapshot|snapshot de (la )?ola|ola en curso)\b/i, command: 'snapshot' },
    { regex: /\b(listado|listar issues|qué issues|que issues|mostrame los issues|mostr[áa] los issues)\b/i, command: 'listado' },
    { regex: /\b(allowlist|pausa parcial actual|qué hay en la allowlist|que hay en la allowlist)\b/i, command: 'allowlist' },
    { regex: /^tail\s+([\w.-]+)/i, command: 'tail', argsFromCapture: 1 },
    { regex: /\b(tail (de )?logs?|últimas líneas del log|ultimas lineas del log)\b/i, command: 'tail' },
    { regex: /\b(levant[áa]r? (el )?dashboard|prend[éa] (el )?dashboard|arranc[áa] (el )?dashboard)\b/i, command: 'dashboard-up' },
    { regex: /\b(baj[áa] (el )?dashboard|apag[áa] (el )?dashboard|matá (el )?dashboard|mata (el )?dashboard)\b/i, command: 'dashboard-down' },
    { regex: /\b(screenshot|captur[áa] (el )?dashboard|sacale una foto al dashboard|mostrame el dashboard)\b/i, command: 'screenshot' },
    { regex: /\b(procesos node|node procesos|qu[eé] procesos node hay|listar procesos|ver procesos)\b/i, command: 'procesos' },
    { regex: /\b(salud (del )?pulpo|health (del )?pulpo|c[oó]mo (est[áa]|esta) el pulpo)\b/i, command: 'salud' },
    { regex: /\b(modo descanso|descanso lookup|ventana de descanso|cu[áa]ndo descansa|cuando descansa)\b/i, command: 'descanso' },
    // Issue #3253 — NLP para /quota (CA-1). Texto natural: "cómo está la cuota", "cuota claude".
    { regex: /\b(cuota|quota|c[oó]mo (esta|est[áa]) la cuota|claude cuota|cuota claude)\b/i, command: 'quota' },
    // Patrones legacy (presentes en parseCommand original)
    { regex: /\b(pausar|paus[áa] el|fren[áa] el|par[áa] el pulpo)\b/i, command: 'pausar' },
    { regex: /\b(reanudar|reanud[áa] el|arranc[áa] el pulpo)\b/i, command: 'reanudar' },
    { regex: /\b(mostrame la actividad|qué pas[óo] en el pipeline|timeline)\b/i, command: 'actividad' },
    { regex: /\b(mostrame los costos|cuánto gastamos|reporte de costos)\b/i, command: 'costos' },
    { regex: /\b(ayuda|help|comandos disponibles)\b/i, command: 'help' },
    { regex: /\b(stop|apag[áa] el commander|cerr[áa] el commander)\b/i, command: 'stop' },
    { regex: /\b(limpi[áa]|limpiar daemons|matar gradle|matar daemons|kill gradle)\b/i, command: 'limpiar' },
    { regex: /\b(bloqueados|qu[eé] est[áa] bloqueado|que necesita humano|necesitan intervenci[óo]n)\b/i, command: 'bloqueados' },
    { regex: /\b(ghostbusters|matar fantasmas|matar zombis)\b/i, command: 'ghostbusters' },
    { regex: /\b(intake|met[eé] .* issue|tra[eé] .* issue|ingres[áa] issue)\b/i, command: 'intake', llm: true },
    { regex: /\b(proponer historias|propon[eé] historias|historias nuevas)\b/i, command: 'proponer', llm: true },
];

const MAX_SHORT_LENGTH = 80;     // Texto > 80 chars es conversación libre (CA-18)
const RAW_TRUNC_LEN = 120;       // Para echo en plantillas de error

/**
 * Clasifica un mensaje entrante. Devuelve siempre un objeto.
 *
 * @param {string} text
 * @returns {{ class: 'deterministic'|'llm'|'unknown', command: string|null, args: string, raw: string, rawTruncated: string }}
 */
function classify(text) {
    const raw = typeof text === 'string' ? text : '';
    const trimmed = raw.trim();
    const rawTruncated = trimmed.slice(0, RAW_TRUNC_LEN);

    if (!trimmed) {
        return { class: 'unknown', command: null, args: '', raw, rawTruncated };
    }

    // Slash-command — admite guiones (`/pause-partial`, `/dashboard-up`).
    const slash = trimmed.match(/^\/([\w-]+)\s*([\s\S]*)?$/);
    if (slash) {
        const cmd = slash[1].toLowerCase();
        const args = (slash[2] || '').trim();
        if (DETERMINISTIC_SLASH.has(cmd)) {
            return { class: 'deterministic', command: cmd, args, raw, rawTruncated };
        }
        if (LLM_SLASH.has(cmd)) {
            return { class: 'llm', command: cmd, args, raw, rawTruncated };
        }
        return { class: 'unknown', command: cmd, args, raw, rawTruncated };
    }

    // Texto largo → conversación libre → LLM
    if (trimmed.length > MAX_SHORT_LENGTH) {
        return { class: 'llm', command: null, args: trimmed, raw, rawTruncated };
    }

    // Texto corto: probar NLP patterns
    for (const p of NLP_PATTERNS) {
        const m = trimmed.match(p.regex);
        if (m) {
            // Preferir captura explícita (`tail commander.log` → args=commander.log)
            // sobre el residual del replace (que puede dejar ruido como "de la").
            const args = (p.argsFromCapture && m[p.argsFromCapture])
                ? m[p.argsFromCapture].trim()
                : trimmed.replace(p.regex, '').trim();
            return {
                class: p.llm ? 'llm' : 'deterministic',
                command: p.command,
                args,
                raw,
                rawTruncated,
            };
        }
    }

    // No matchea — clasificar como `llm` (texto libre corto que el LLM puede
    // interpretar) o `unknown` si parece comando fallido (empieza con `/`).
    // Ya cubrimos slash arriba, así que cae a `llm`.
    return { class: 'llm', command: null, args: trimmed, raw, rawTruncated };
}

// -----------------------------------------------------------------------------
// VALIDADORES DE ARGS (CA-8)
// -----------------------------------------------------------------------------

const TAIL_ALLOWED_FILES = new Set([
    'commander.log',
    'pulpo.log',
    'svc-telegram.log',
    'dashboard-v2.log',
    'listener-telegram.log',
    'multi-provider.log',
    'restart.log',
]);

const LISTADO_FILTERS = new Set([
    '', 'pendientes', 'en-curso', 'en curso', 'listos', 'ola', 'todo',
]);

// #3262 — `/wave` admite el flag opcional `--audio` para activar TTS opt-in (CA-9 / PO-CA-9).
// Cualquier otro arg es rechazado para no abrir vectores adicionales.
const WAVE_FLAGS = new Set(['', '--audio']);

const ARG_SCHEMAS = {
    status: { allow: () => true },
    snapshot: { allow: () => true },
    wave: {
        allow(args) {
            const norm = String(args || '').toLowerCase().trim();
            return WAVE_FLAGS.has(norm);
        },
        usage: 'wave [--audio]',
        allowedValues: ['--audio'],
        hint: 'Sin args o con `--audio` para incluir resumen TTS opt-in.',
    },
    listado: {
        allow(args) {
            const norm = String(args || '').toLowerCase().trim();
            return LISTADO_FILTERS.has(norm);
        },
        usage: 'listado [pendientes|en curso|listos|ola|todo]',
        allowedValues: [...LISTADO_FILTERS].filter(Boolean),
    },
    allowlist: { allow: () => true },
    tail: {
        allow(args) {
            const norm = String(args || '').trim();
            if (!norm) return false;
            // Allowlist estricta: nombre exacto, sin path. Sin slashes/dotdot.
            if (norm.includes('/') || norm.includes('\\') || norm.includes('..')) return false;
            return TAIL_ALLOWED_FILES.has(norm);
        },
        usage: 'tail <archivo>',
        allowedValues: [...TAIL_ALLOWED_FILES],
        hint: 'Indicá uno de los archivos permitidos (ej. `tail commander.log`).',
    },
    'dashboard-up': { allow: () => true },
    'dashboard-down': { allow: () => true },
    screenshot: { allow: () => true },
    procesos: { allow: () => true },
    salud: { allow: () => true },
    descanso: { allow: () => true },
    // Issue #3253 — /quota es estrictamente read-only (CA-S1).
    // Cualquier argumento (clear, reset, delete, force, etc.) se rechaza
    // antes de invocar al handler para impedir bypass del rate-limit de
    // Claude desde el chat. El handler nunca modifica el archivo del flag.
    quota: {
        allow(args) {
            const norm = String(args || '').trim();
            return norm.length === 0;
        },
        usage: 'quota',
        allowedValues: [],
        hint: 'El comando es read-only — no acepta argumentos. Para destrabar la cuota, esperá al reset o borrá el flag manualmente con `rm .pipeline/quota-exhausted.json` (consola).',
    },
};

function validateArgs(command, args) {
    const schema = ARG_SCHEMAS[command];
    if (!schema) return { ok: true };
    if (schema.allow(args)) return { ok: true };
    return {
        ok: false,
        message: `El valor "${escapeMarkdownV2((args || '').slice(0, 40))}" no es válido para \`${escapeMarkdownV2(command)}\`.`,
        usage: schema.usage || command,
        allowedValues: schema.allowedValues || null,
        hint: schema.hint || null,
    };
}

// -----------------------------------------------------------------------------
// FACTORY DE DISPATCHER
// -----------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {string} opts.pipelineRoot       - root del pipeline (`.pipeline`)
 * @param {string} opts.logsDir            - directorio de logs (`.pipeline/logs`)
 * @param {string} [opts.expectedChatId]   - chat_id autorizado (CA-17)
 * @param {object} [opts.handlers]         - override por comando (para tests / pulpo)
 * @param {object} [opts.rateLimit]        - { burst, ratePerMin }
 * @param {object} [opts.destructiveCooldown]
 *        - { cooldownMs, destructiveCommands } — issue #3253 CA-4. Si se omite,
 *          se crea uno con defaults (60s sobre restart/limpiar/ghostbusters/reset).
 *          Pasar `false` lo deshabilita (tests aislados que no quieren cooldown).
 * @param {function} [opts.now]            - clock injectable
 */
function createDispatcher(opts) {
    const options = opts || {};
    if (!options.pipelineRoot) throw new Error('createDispatcher: pipelineRoot es obligatorio');
    if (!options.logsDir) throw new Error('createDispatcher: logsDir es obligatorio');

    const auditLog = createAuditLog({
        dir: options.logsDir,
        redact: (s) => baseRedact.redactSensitive(String(s || '')),
        now: options.now,
    });
    const rateLimiter = createRateLimiter({
        burst: options.rateLimit && options.rateLimit.burst,
        ratePerMin: options.rateLimit && options.rateLimit.ratePerMin,
        now: options.now,
    });
    // Issue #3253 — CA-4: cooldown destructivo. Layer adicional al rate-limit.
    // Si el caller pasa `false` explícito, lo deshabilitamos (tests que quieren
    // ejecutar el mismo destructivo varias veces sin esperar 60s).
    const destructiveCooldown = options.destructiveCooldown === false
        ? null
        : createDestructiveCooldown({
            cooldownMs: options.destructiveCooldown && options.destructiveCooldown.cooldownMs,
            destructiveCommands: options.destructiveCooldown && options.destructiveCooldown.destructiveCommands,
            now: options.now,
        });
    const customHandlers = options.handlers || {};
    const now = typeof options.now === 'function' ? options.now : () => Date.now();

    const expectedChatId = options.expectedChatId ? String(options.expectedChatId) : null;

    // Defaults: handlers stub que el caller (pulpo.js) puede overridear con
    // implementaciones reales. El módulo no asume infra — devuelve "stub" si
    // no se inyectó nada, para que el router siga siendo testable aislado.
    const defaultHandlers = buildDefaultHandlers({
        pipelineRoot: options.pipelineRoot,
        logsDir: options.logsDir,
    });
    const handlers = { ...defaultHandlers, ...customHandlers };

    /**
     * @param {{from?: string, chat_id?: string|number, text: string}} message
     * @returns {Promise<{ reply: string|null, status: string, handler: string|null, intent: object, durationMs: number }>}
     */
    async function dispatch(message) {
        const start = now();
        const intent = classify(message && message.text);
        const chatId = message && message.chat_id !== undefined ? String(message.chat_id) : null;

        // Auth re-verificada por handler crítico (CA-17). El listener ya filtró
        // por CHAT_ID; acá protegemos contra construcciones internas que se salten.
        if (expectedChatId && chatId && chatId !== expectedChatId) {
            const row = auditLog.record({
                from: message && message.from,
                chat_id: chatId,
                raw_command: intent.rawTruncated,
                intent_class: 'unknown',
                handler: null,
                args: intent.args,
                result_status: 'error',
                duration_ms: now() - start,
            });
            return {
                reply: null,
                status: 'unauthorized',
                handler: null,
                intent,
                durationMs: row.duration_ms,
            };
        }

        // Solo determinísticos pasan por el rate limiter (CA-11).
        if (intent.class === 'deterministic' && chatId) {
            const decision = rateLimiter.consume(chatId);
            if (!decision.allowed) {
                rateLimiter.recordBlocked(chatId, intent.command || intent.raw);
                const reply = fillTemplate('error-rate-limit', {
                    'recent-requests': decision.recentRequests,
                    'limit-per-min': rateLimiter._config.ratePerMin,
                    'retry-after-seconds': Math.ceil(decision.retryAfterMs / 1000),
                    'last-blocked-commands': rateLimiter.getRecentBlocked(chatId).map((b) => ({
                        command: b.command,
                        elapsed: formatElapsed(now() - b.ts),
                    })),
                });
                const row = auditLog.record({
                    from: message && message.from,
                    chat_id: chatId,
                    raw_command: intent.rawTruncated,
                    intent_class: 'deterministic',
                    handler: intent.command,
                    args: intent.args,
                    result_status: 'rate_limited',
                    duration_ms: now() - start,
                });
                return { reply, status: 'rate_limited', handler: intent.command, intent, durationMs: row.duration_ms };
            }
        }

        // Comandos `unknown` → plantilla de error con sugerencias.
        if (intent.class === 'unknown') {
            const reply = fillTemplate('error-unknown', {
                'raw-command-truncated': intent.rawTruncated,
                'quota-degraded': false,
            });
            const row = auditLog.record({
                from: message && message.from,
                chat_id: chatId,
                raw_command: intent.rawTruncated,
                intent_class: 'unknown',
                handler: null,
                args: intent.args,
                result_status: 'ok',
                duration_ms: now() - start,
            });
            return { reply, status: 'ok', handler: null, intent, durationMs: row.duration_ms };
        }

        // Comandos `llm` → el router devuelve null para que el caller llame a Claude.
        if (intent.class === 'llm') {
            const row = auditLog.record({
                from: message && message.from,
                chat_id: chatId,
                raw_command: intent.rawTruncated,
                intent_class: 'llm',
                handler: intent.command || null,
                args: intent.args,
                result_status: 'ok',
                duration_ms: now() - start,
            });
            return { reply: null, status: 'delegated_to_llm', handler: intent.command, intent, durationMs: row.duration_ms };
        }

        // -------- DETERMINISTIC --------
        const validation = validateArgs(intent.command, intent.args);
        if (!validation.ok) {
            const reply = fillTemplate('error-invalid-args', {
                command: intent.command,
                'validation-error-message': validation.message,
                'usage-example': validation.usage,
                'allowed-values': validation.allowedValues,
                hint: validation.hint,
            });
            const row = auditLog.record({
                from: message && message.from,
                chat_id: chatId,
                raw_command: intent.rawTruncated,
                intent_class: 'deterministic',
                handler: intent.command,
                args: intent.args,
                result_status: 'invalid_args',
                duration_ms: now() - start,
            });
            return { reply, status: 'invalid_args', handler: intent.command, intent, durationMs: row.duration_ms };
        }

        // Issue #3253 — CA-4: cooldown destructivo. Aplica DESPUÉS del
        // rate-limit y de la validación de args, ANTES del handler. Si el
        // comando es destructivo y está dentro de la ventana, devolvemos
        // template con tiempo restante y NO invocamos al handler. No
        // grabamos `recordSuccess` acá — el caller lo hace explícitamente
        // después de confirmar éxito (ver `markDestructiveSuccess`).
        if (destructiveCooldown && chatId && destructiveCooldown.isDestructive(intent.command)) {
            const cd = destructiveCooldown.check(chatId, intent.command);
            if (!cd.allowed) {
                const reply = fillTemplate('error-destructive-cooldown', {
                    command: intent.command,
                    'retry-after-ms': cd.retryAfterMs,
                    'retry-after-human': humanizeRetryAfter(cd.retryAfterMs),
                    'cooldown-seconds': Math.round((destructiveCooldown._config.cooldownMs || DEFAULT_COOLDOWN_MS) / 1000),
                });
                const row = auditLog.record({
                    from: message && message.from,
                    chat_id: chatId,
                    raw_command: intent.rawTruncated,
                    intent_class: 'deterministic',
                    handler: intent.command,
                    args: intent.args,
                    result_status: 'cooldown',
                    duration_ms: now() - start,
                });
                return { reply, status: 'cooldown', handler: intent.command, intent, durationMs: row.duration_ms };
            }
        }

        const handler = handlers[intent.command];
        if (typeof handler !== 'function') {
            const row = auditLog.record({
                from: message && message.from,
                chat_id: chatId,
                raw_command: intent.rawTruncated,
                intent_class: 'deterministic',
                handler: intent.command,
                args: intent.args,
                result_status: 'error',
                duration_ms: now() - start,
            });
            return { reply: null, status: 'no_handler', handler: intent.command, intent, durationMs: row.duration_ms };
        }

        let reply = null;
        let audioText = null;
        let status = 'ok';
        try {
            const result = await handler({ args: intent.args, message, intent });
            if (typeof result === 'string') {
                reply = result;
            } else if (result && typeof result === 'object') {
                reply = result.reply || null;
                // #3262 — handlers que quieren emitir audio TTS (opt-in, no
                // bloqueante) devuelven `audioText` adicional. El dispatcher
                // lo forwardea para que el caller (pulpo.brazoCommander) decida
                // si invocar sendVoiceTelegram. Si el caller no lo soporta,
                // simplemente lo ignora — el reply Markdown llega igual.
                audioText = result.audioText || null;
            }
        } catch (e) {
            status = 'error';
            try { process.stderr.write(`[commander-deterministic] handler ${intent.command} falló: ${e.message}\n`); } catch (_) {}
        }
        // Issue #3253 — CA-4: grabar success solo si efectivamente devolvimos
        // una respuesta no nula. Si el handler retornó null (ej. legacy
        // resuelto en pulpo.js via no_handler fallback), no grabamos —
        // pulpo.js llamará a `markDestructiveSuccess` cuando confirme éxito.
        if (destructiveCooldown && chatId && status === 'ok' && reply !== null && destructiveCooldown.isDestructive(intent.command)) {
            destructiveCooldown.recordSuccess(chatId, intent.command);
        }
        const durationMs = now() - start;
        auditLog.record({
            from: message && message.from,
            chat_id: chatId,
            raw_command: intent.rawTruncated,
            intent_class: 'deterministic',
            handler: intent.command,
            args: intent.args,
            result_status: status,
            duration_ms: durationMs,
        });
        return { reply, audioText, status, handler: intent.command, intent, durationMs };
    }

    /**
     * Issue #3253 — CA-4: API explícita para que pulpo.js marque éxito
     * de un comando destructivo cuyo handler vive en el switch legacy
     * (cmdLimpiar / cmdRestart / cmdGhostbusters). Sin esto, los comandos
     * que NO tienen handler default en el dispatcher (porque están en
     * pulpo.js) nunca activarían el cooldown.
     */
    function markDestructiveSuccess(chatId, command) {
        if (!destructiveCooldown || !chatId || !command) return false;
        if (!destructiveCooldown.isDestructive(command)) return false;
        destructiveCooldown.recordSuccess(chatId, command);
        return true;
    }

    /**
     * Issue #3253 — CA-4: API explícita para que pulpo.js consulte si un
     * destructivo está en cooldown antes de invocar el switch legacy.
     */
    function checkDestructiveCooldown(chatId, command) {
        if (!destructiveCooldown || !chatId || !command) {
            return { allowed: true, retryAfterMs: 0, lastSuccessAt: null };
        }
        return destructiveCooldown.check(chatId, command);
    }

    return {
        classify,
        validateArgs,
        dispatch,
        auditLog,
        rateLimiter,
        destructiveCooldown,
        markDestructiveSuccess,
        checkDestructiveCooldown,
        DETERMINISTIC_SLASH,
        LLM_SLASH,
        ARG_SCHEMAS,
    };
}

// -----------------------------------------------------------------------------
// HANDLERS POR DEFECTO
//
// Los handlers default cubren los comandos NUEVOS del CA-2 (tail, dashboard
// up/down, screenshot, procesos, salud, descanso) y usan ÚNICAMENTE lectura
// de FS + spawn con argv array. Los comandos legacy (status, actividad,
// ghostbusters, etc.) se siguen sirviendo desde `pulpo.js` vía override.
// -----------------------------------------------------------------------------

function buildDefaultHandlers(ctx) {
    const PIPELINE = path.resolve(ctx.pipelineRoot);
    const LOG_DIR = path.resolve(ctx.logsDir);

    return {
        // Issue #3253 — CA-1: `/quota` read-only. Lee
        // `.pipeline/quota-exhausted.json` con whitelist estricta de campos
        // (CA-S2: nunca emite el JSON crudo, nunca expone paths absolutos).
        // El handler jamás modifica el archivo (CA-S1) — los args mutativos
        // (clear/reset/delete) ya rebotaron en ARG_SCHEMAS.quota antes de
        // llegar acá.
        quota: async () => {
            const flagPath = path.join(PIPELINE, 'quota-exhausted.json');
            let parsed = null;
            try {
                if (fs.existsSync(flagPath)) {
                    const raw = fs.readFileSync(flagPath, 'utf8');
                    parsed = JSON.parse(raw);
                }
            } catch (_) {
                // Lectura defensiva: si está corrupto el JSON, NO emitimos
                // el contenido crudo en la respuesta (CA-S2). Devolvemos el
                // estado "sin cuota activa" como safe-default.
                parsed = null;
            }

            const exhausted = !!(parsed && parsed.exhausted === true);
            if (!exhausted) {
                return fillTemplate('quota', { exhausted: false });
            }

            // Whitelist estricta de campos para Telegram (CA-S2).
            // - provider: string identificador (ej "anthropic"), sanitizado.
            // - since-iso: detected_at en ISO8601 humanizado a HH:MM:SS.
            // - since-elapsed: tiempo desde detected_at.
            // - resets-iso / resets-in: si hay resets_at, humanizamos; sino "—".
            // - reason-kind: el campo `pattern_matched` truncado a 64 chars.
            const provider = typeof parsed.provider === 'string' ? parsed.provider : 'anthropic';
            const reasonKindRaw = typeof parsed.pattern_matched === 'string'
                ? parsed.pattern_matched
                : 'desconocido';
            const reasonKind = reasonKindRaw.slice(0, 64);

            const nowMs = Date.now();
            const detectedAtMs = parsed.detected_at ? Date.parse(parsed.detected_at) : NaN;
            const resetsAtMs = parsed.resets_at ? Date.parse(parsed.resets_at) : NaN;

            const sinceElapsed = Number.isFinite(detectedAtMs)
                ? formatElapsed(nowMs - detectedAtMs)
                : 'desconocido';
            const sinceIso = Number.isFinite(detectedAtMs)
                ? new Date(detectedAtMs).toISOString()
                : '—';
            const hasResets = Number.isFinite(resetsAtMs);
            const resetsIn = hasResets ? formatElapsed(resetsAtMs - nowMs) : '—';
            const resetsIso = hasResets ? new Date(resetsAtMs).toISOString() : '—';

            return fillTemplate('quota', {
                exhausted: true,
                provider,
                'reason-kind': reasonKind,
                'since-elapsed': sinceElapsed,
                'since-iso': sinceIso,
                'has-resets': hasResets,
                'resets-in': resetsIn,
                'resets-iso': resetsIso,
            });
        },

        tail: async ({ args }) => {
            const file = String(args || '').trim();
            const safeFile = path.resolve(LOG_DIR, file);
            // Defensa adicional: el path resuelto debe vivir dentro de LOG_DIR.
            if (!safeFile.startsWith(LOG_DIR + path.sep) && safeFile !== LOG_DIR) {
                throw new Error('tail: path traversal detectado');
            }
            if (!fs.existsSync(safeFile)) {
                return fillTemplate('tail-logs', {
                    'log-file': file,
                    'lines-count': 0,
                    'file-size-human': '0 B',
                    'last-write': 'n/a',
                    'log-content': '(archivo no existe todavía)',
                    'redacted-count': 0,
                    truncated: false,
                });
            }
            const stat = fs.statSync(safeFile);
            const raw = fs.readFileSync(safeFile, 'utf8');
            const allLines = raw.split('\n');
            const LIMIT = 30;
            const tail = allLines.slice(-LIMIT).join('\n');
            const { text: safeText, redactedCount } = redactReadOutput(tail);
            return fillTemplate('tail-logs', {
                'log-file': file,
                'lines-count': Math.min(allLines.length, LIMIT),
                'file-size-human': humanBytes(stat.size),
                'last-write': new Date(stat.mtimeMs).toISOString(),
                'log-content': clipForTelegram(safeText),
                'redacted-count': redactedCount,
                truncated: allLines.length > LIMIT,
            });
        },

        descanso: async () => {
            // Lee la config de modo descanso desde `.pipeline/config.yaml`
            // sin parsearlo agresivamente: solo extraemos la sección con regex
            // (alcanza para read-only display, no es la fuente de verdad).
            const configPath = path.join(PIPELINE, 'config.yaml');
            const cfg = { active: false, until: null, remaining: null, start: '--', end: '--', tz: 'America/Argentina/Buenos_Aires', days: 'L–V' };
            try {
                if (fs.existsSync(configPath)) {
                    const yaml = fs.readFileSync(configPath, 'utf8');
                    const m = yaml.match(/rest_mode:\s*\n((?:\s{2,}.+\n)+)/);
                    if (m) {
                        const block = m[1];
                        const start = (block.match(/start:\s*['"]?([\d:]+)['"]?/) || [])[1];
                        const end = (block.match(/end:\s*['"]?([\d:]+)['"]?/) || [])[1];
                        const tz = (block.match(/timezone:\s*['"]?([^'"\s]+)['"]?/) || [])[1];
                        if (start) cfg.start = start;
                        if (end) cfg.end = end;
                        if (tz) cfg.tz = tz;
                    }
                }
            } catch (_) { /* lectura best-effort */ }

            return fillTemplate('modo-descanso', {
                timestamp: new Date().toISOString(),
                active: cfg.active,
                until: cfg.until || '--',
                'remaining-human': cfg.remaining || '--',
                'window-start': cfg.start,
                'window-end': cfg.end,
                timezone: cfg.tz,
                'days-display': cfg.days,
                'snooze-cap-h': 24,
                'has-snooze': false,
            });
        },

        wave: async ({ args }) => {
            // #3262 — Snapshot ejecutivo de la ola para Telegram. Combina
            // resolveActiveWave (active-wave.json / partial-pause / fallback FS)
            // + buildWaveSnapshot (cálculo determinístico de %, ETA, bloqueos)
            // + renderWaveSnapshot (MarkdownV2 listo para enviar).
            //
            // El flag opcional `--audio` activa la generación del texto TTS
            // (CA-9). Si el caller (pulpo) puede emitir voice, lo hará; si no,
            // queda como metadato extra que no rompe el reply principal.
            //
            // Performance (CA-16): usa wave-state con TTL cache 2s. Re-usar
            // dashboard.getCachedPipelineState no es viable acá porque
            // `dashboard.js` arranca un HTTP server al require (side effect
            // imposible desde el commander singleton). wave-state es un
            // módulo paralelo que replica las pocas funciones de state que
            // necesitamos sin esos side effects.
            const resolver = require('./wave-resolver');
            const snapshotMod = require('./wave-snapshot');
            const rendererMod = require('./wave-renderer');
            const stateMod = require('./wave-state');

            const wave = resolver.resolveActiveWave({ pipelineRoot: PIPELINE });
            const state = stateMod.getCachedWaveState({ pipelineRoot: PIPELINE });

            // Listado de bloqueados (best-effort).
            let blocked = [];
            try {
                // eslint-disable-next-line global-require
                const humanBlock = require('./human-block');
                if (typeof humanBlock.listBlockedIssues === 'function') {
                    blocked = humanBlock.listBlockedIssues() || [];
                }
            } catch (_) { /* sin bloqueados detectables */ }

            // Closed: heurística — labels `closed` o estado `procesado` de entrega.
            // No consultamos GitHub API (CA-8, sin red).
            const closedIssues = new Set();
            for (const id of wave.issues) {
                const data = state.issueMatrix && state.issueMatrix[String(id)];
                if (!data) continue;
                const labels = Array.isArray(data.labels) ? data.labels : [];
                const labelNames = labels.map((l) => (typeof l === 'string' ? l : (l && l.name) || '')).filter(Boolean);
                if (labelNames.includes('closed') || labelNames.includes('done')) {
                    closedIssues.add(Number(id));
                }
            }

            const snapshot = snapshotMod.buildWaveSnapshot({
                state,
                wave,
                blocked,
                closedIssues,
            });

            const reply = rendererMod.renderWaveSnapshot(snapshot);

            // CA-9: TTS opt-in solo si --audio.
            const wantsAudio = String(args || '').toLowerCase().trim() === '--audio';
            const audioText = wantsAudio ? rendererMod.renderAudioText(snapshot) : null;

            return { reply, audioText };
        },

        snapshot: async () => {
            // Lee `.pipeline/desarrollo/<fase>/<estado>/*.{<skill>,yaml}` y arma
            // un snapshot agregado del estado actual del pipeline. Sin LLM ni red:
            // solo `fs.readdirSync` sobre la jerarquía de carpetas.
            const desarrollo = path.join(PIPELINE, 'desarrollo');
            const PHASES = ['dev', 'build', 'verificacion', 'aprobacion', 'entrega', 'validacion'];
            const STATES = ['pendiente', 'trabajando', 'listo'];
            const issuesMap = new Map(); // issue → { phase, state, file, mtimeMs }
            let blockedCount = 0;
            const interventionItems = [];

            for (const phase of PHASES) {
                for (const state of STATES) {
                    const dir = path.join(desarrollo, phase, state);
                    let files = [];
                    try { files = fs.readdirSync(dir); } catch (_) { continue; }
                    for (const f of files) {
                        const m = f.match(/^(\d+)\.([\w-]+)$/);
                        if (!m) continue;
                        const issue = Number(m[1]);
                        const fullPath = path.join(dir, f);
                        let mtimeMs = 0;
                        try { mtimeMs = fs.statSync(fullPath).mtimeMs; } catch (_) {}
                        // Si ya existía el issue en otra fase, conservamos la más avanzada
                        // (la fase con índice mayor en PHASES).
                        const prev = issuesMap.get(issue);
                        const idx = PHASES.indexOf(phase);
                        const prevIdx = prev ? PHASES.indexOf(prev.phase) : -1;
                        if (!prev || idx > prevIdx) {
                            issuesMap.set(issue, { phase, state, file: f, mtimeMs });
                        }
                        // Detección heurística de bloqueo: archivos `.reason*.json` o
                        // contenido con `rebote: true` / `motivo_rechazo`.
                        try {
                            if (state === 'pendiente') {
                                const content = fs.readFileSync(fullPath, 'utf8');
                                if (/^rebote:\s*true/m.test(content) || /motivo_rechazo:/m.test(content)) {
                                    blockedCount += 1;
                                    if (interventionItems.length < 5) {
                                        const reasonMatch = content.match(/motivo_rechazo:\s*\|?\s*\n?\s*(.{0,140})/);
                                        const reason = (reasonMatch ? reasonMatch[1].trim() : 'rebote pendiente').slice(0, 140);
                                        interventionItems.push({ number: issue, reason });
                                    }
                                }
                            }
                        } catch (_) {}
                    }
                }
            }

            const totalIssues = issuesMap.size;
            // Progreso: % de issues en fases finales (aprobacion/entrega) sobre total.
            const advancedPhases = new Set(['aprobacion', 'entrega']);
            let advanced = 0;
            for (const meta of issuesMap.values()) {
                if (advancedPhases.has(meta.phase)) advanced += 1;
            }
            const progressPercent = totalIssues > 0 ? Math.round((advanced / totalIssues) * 100) : 0;
            const progressBar = renderProgressBar(progressPercent);

            // Render: orden por issue desc, máximo 12 issues para no pasarnos del límite.
            const issues = [...issuesMap.entries()]
                .sort((a, b) => b[0] - a[0])
                .slice(0, 12)
                .map(([num, meta]) => ({
                    number: num,
                    phase: meta.phase,
                    title: `(${meta.file})`,
                    'status-icon': stateIcon(meta.state),
                    blocked: false,
                    'last-event': null,
                    'last-event-elapsed': null,
                }));

            // Número de ola: best-effort. Si existe `.pipeline/ola-actual.json` lo
            // usamos, sino lo dejamos en "—" (no inventamos).
            let olaNumero = '—';
            try {
                const olaFile = path.join(PIPELINE, 'ola-actual.json');
                if (fs.existsSync(olaFile)) {
                    const data = JSON.parse(fs.readFileSync(olaFile, 'utf8'));
                    if (data && data.numero) olaNumero = String(data.numero);
                }
            } catch (_) {}

            return fillTemplate('snapshot-ola', {
                'ola-numero': olaNumero,
                timestamp: new Date().toISOString(),
                'progress-bar': progressBar,
                'progress-percent': progressPercent,
                'eta-human': '—',
                'eta-model': 'sin modelo determinístico',
                'blocked-count': blockedCount,
                'total-issues': totalIssues,
                issues,
                'intervencion-requerida': interventionItems.length > 0,
                'intervencion-items': interventionItems,
            });
        },

        listado: async ({ args }) => {
            // Lectura puro-FS del estado actual del pipeline. Filtros aceptados
            // (validados por ARG_SCHEMAS antes de llegar acá): pendientes / en
            // curso / listos / ola / todo / '' (default = todo).
            const filter = String(args || '').toLowerCase().trim() || 'todo';
            const desarrollo = path.join(PIPELINE, 'desarrollo');
            const PHASES = ['dev', 'build', 'verificacion', 'aprobacion', 'entrega', 'validacion'];

            // Mapeo filtro → conjunto de estados aceptados.
            const STATE_MAP = {
                pendientes: new Set(['pendiente']),
                'en-curso': new Set(['trabajando']),
                'en curso': new Set(['trabajando']),
                listos: new Set(['listo']),
                ola: new Set(['pendiente', 'trabajando', 'listo']),
                todo: new Set(['pendiente', 'trabajando', 'listo']),
                '': new Set(['pendiente', 'trabajando', 'listo']),
            };
            const acceptedStates = STATE_MAP[filter] || STATE_MAP.todo;

            const issueRows = new Map(); // issue → row
            for (const phase of PHASES) {
                for (const state of acceptedStates) {
                    const dir = path.join(desarrollo, phase, state);
                    let files = [];
                    try { files = fs.readdirSync(dir); } catch (_) { continue; }
                    for (const f of files) {
                        const m = f.match(/^(\d+)\.([\w-]+)$/);
                        if (!m) continue;
                        const issue = Number(m[1]);
                        const skill = m[2];
                        const fullPath = path.join(dir, f);
                        let elapsed = null;
                        try {
                            const st = fs.statSync(fullPath);
                            elapsed = formatElapsed(Date.now() - st.mtimeMs);
                        } catch (_) {}
                        const prev = issueRows.get(issue);
                        const idx = PHASES.indexOf(phase);
                        const prevIdx = prev ? PHASES.indexOf(prev._phaseIdx) : -1;
                        if (!prev || idx > prevIdx) {
                            issueRows.set(issue, {
                                number: issue,
                                _phaseIdx: phase,
                                phase,
                                state,
                                labels: skill,
                                title: `(${f})`,
                                elapsed,
                                'priority-icon': stateIcon(state),
                            });
                        }
                    }
                }
            }

            const total = issueRows.size;
            const sortedRows = [...issueRows.values()].sort((a, b) => b.number - a.number);
            const MAX_SHOW = 15;
            const shown = Math.min(sortedRows.length, MAX_SHOW);
            const issues = sortedRows.slice(0, MAX_SHOW);

            return fillTemplate('listado-issues', {
                'filter-description': filter || 'todo',
                empty: total === 0,
                total,
                shown,
                truncated: total > MAX_SHOW,
                issues,
            });
        },

        allowlist: async () => {
            const partialPausePath = path.join(PIPELINE, '.partial-pause.json');
            if (!fs.existsSync(partialPausePath)) {
                return fillTemplate('allowlist', {
                    active: false,
                    'last-modified': 'nunca',
                    'last-modified-by': null,
                    'empty-allowlist': true,
                    count: 0,
                    issues: [],
                    'con-deps-recursivas': false,
                    deps: [],
                });
            }

            let raw;
            try { raw = fs.readFileSync(partialPausePath, 'utf8'); }
            catch (e) {
                return fillTemplate('allowlist', {
                    active: false,
                    'last-modified': 'error de lectura',
                    'last-modified-by': null,
                    'empty-allowlist': true,
                    count: 0,
                    issues: [],
                    'con-deps-recursivas': false,
                    deps: [],
                });
            }
            let parsed = null;
            try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }

            // Soportar formatos variados: { issues: [...] }, [...], { allowlist: [...] }
            let allowed = [];
            if (Array.isArray(parsed)) allowed = parsed;
            else if (parsed && Array.isArray(parsed.issues)) allowed = parsed.issues;
            else if (parsed && Array.isArray(parsed.allowlist)) allowed = parsed.allowlist;

            const stat = fs.statSync(partialPausePath);
            const lastModified = new Date(stat.mtimeMs).toISOString();
            const isEmpty = allowed.length === 0;
            // Pausa parcial "activa" si el archivo existe Y tiene items en allowlist.
            const isActive = !isEmpty;

            const issues = allowed.map((item) => {
                if (typeof item === 'number' || typeof item === 'string') {
                    return { number: Number(item), 'title-short': '(sin metadata)', 'labels-display': null };
                }
                return {
                    number: Number(item.issue || item.number || 0),
                    'title-short': String(item.title || '(sin título)').slice(0, 60),
                    'labels-display': item.labels ? String(item.labels).slice(0, 40) : null,
                };
            });

            return fillTemplate('allowlist', {
                active: isActive,
                'last-modified': lastModified,
                'last-modified-by': parsed && parsed.modified_by ? String(parsed.modified_by) : null,
                'empty-allowlist': isEmpty,
                count: issues.length,
                issues,
                'con-deps-recursivas': false,
                deps: [],
            });
        },

        'dashboard-up': async () => {
            // Levanta el dashboard. Sin shell-concat: spawn con argv array.
            const port = parseInt(process.env.DASHBOARD_PORT || '3200', 10);
            const dashboardScript = path.join(PIPELINE, 'dashboard.js');
            if (!fs.existsSync(dashboardScript)) {
                return fillTemplate('dashboard-up', {
                    'dashboard-url': '—',
                    pid: '—',
                    port,
                    'startup-ms': 0,
                    'was-already-running': false,
                    'smoke-test-passed': false,
                });
            }

            // Check si ya corre alguien en el puerto.
            const existingPid = portInUse(port);
            if (existingPid) {
                return fillTemplate('dashboard-up', {
                    'dashboard-url': `http://localhost:${port}/`,
                    pid: existingPid,
                    port,
                    'startup-ms': 0,
                    'was-already-running': true,
                    'smoke-test-passed': false,
                });
            }

            const startedAt = Date.now();
            const logPath = path.join(LOG_DIR, 'dashboard-v2.log');
            let logFd = null;
            try {
                if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
                fs.appendFileSync(logPath, `--- dashboard-up commander ${new Date().toISOString()} ---\n`);
                logFd = fs.openSync(logPath, 'a');
            } catch (_) {}

            // Spawn detached con argv array — node + dashboard.js. Sin shell.
            let child;
            try {
                child = spawn(process.execPath, [dashboardScript], {
                    cwd: path.resolve(PIPELINE, '..'),
                    stdio: logFd ? ['ignore', logFd, logFd] : 'ignore',
                    detached: true,
                    windowsHide: true,
                    env: { ...process.env },
                });
                child.unref();
            } catch (e) {
                return fillTemplate('dashboard-up', {
                    'dashboard-url': '—',
                    pid: '—',
                    port,
                    'startup-ms': Date.now() - startedAt,
                    'was-already-running': false,
                    'smoke-test-passed': false,
                });
            } finally {
                if (logFd) try { fs.closeSync(logFd); } catch (_) {}
            }

            // Smoke test best-effort: esperar máximo 5s a que el puerto responda.
            let smokeOk = false;
            for (let i = 0; i < 25; i += 1) {
                if (portInUse(port)) { smokeOk = true; break; }
                // sleep 200ms sync sin tirar nuevo node
                const until = Date.now() + 200;
                while (Date.now() < until) { /* busy wait corto */ }
            }

            return fillTemplate('dashboard-up', {
                'dashboard-url': `http://localhost:${port}/`,
                pid: child && child.pid ? child.pid : '—',
                port,
                'startup-ms': Date.now() - startedAt,
                'was-already-running': false,
                'smoke-test-passed': smokeOk,
            });
        },

        'dashboard-down': async () => {
            const port = parseInt(process.env.DASHBOARD_PORT || '3200', 10);
            const pid = portInUse(port);
            if (!pid) {
                return fillTemplate('dashboard-down', {
                    pid: '—',
                    'uptime-human': '—',
                    reason: 'apagado manual desde Telegram',
                    'was-not-running': true,
                    'leftover-processes': false,
                    'leftover-count': 0,
                });
            }

            const startedAt = pidStartTime(pid);
            const uptimeHuman = startedAt ? formatElapsed(Date.now() - startedAt) : 'desconocido';

            let killed = false;
            // En Windows usamos taskkill /F /T (mata árbol) sin shell-concat.
            if (process.platform === 'win32') {
                try {
                    spawnSync('taskkill', ['/PID', String(pid), '/F', '/T'], {
                        timeout: 5000, windowsHide: true, stdio: 'ignore',
                    });
                    killed = true;
                } catch (_) {}
            } else {
                try {
                    process.kill(pid, 'SIGTERM');
                    killed = true;
                } catch (_) {}
            }

            // Esperar hasta 2s a que el puerto se libere.
            let leftover = false;
            for (let i = 0; i < 10; i += 1) {
                const until = Date.now() + 200;
                while (Date.now() < until) { /* busy wait */ }
                if (!portInUse(port)) { leftover = false; break; }
                leftover = true;
            }

            return fillTemplate('dashboard-down', {
                pid,
                'uptime-human': uptimeHuman,
                reason: killed ? 'apagado manual desde Telegram' : 'kill falló',
                'was-not-running': false,
                'leftover-processes': leftover,
                'leftover-count': leftover ? 1 : 0,
            });
        },

        screenshot: async () => {
            // Sin puppeteer/playwright instalados en el repo, el handler
            // determinístico responde con metadata útil + URL en vez de adjuntar
            // imagen. Esto es honesto y testeable; no inventa adjuntos.
            const port = parseInt(process.env.DASHBOARD_PORT || '3200', 10);
            const dashUrl = `http://localhost:${port}/`;
            const dashAlive = !!portInUse(port);
            return fillTemplate('screenshot', {
                timestamp: new Date().toISOString(),
                'view-name': 'home',
                attached: false,
                width: 0,
                height: 0,
                'size-human': '0 B',
                redacted: false,
                'redacted-areas': 0,
                'available-views': dashAlive ? `home (${dashUrl})` : 'dashboard apagado',
            });
        },

        procesos: async () => {
            // Lectura del estado de procesos node del pipeline. Usa wmic/ps con
            // argv array (sin shell-concat). pid-discovery YA aplica esa regla.
            let scanner;
            try { scanner = require('../pid-discovery'); }
            catch (e) {
                return fillTemplate('procesos-node', {
                    timestamp: new Date().toISOString(),
                    'total-count': 0,
                    'total-ram-human': '0 B',
                    processes: [],
                    'has-orphans': false,
                    'orphan-count': 0,
                    orphans: [],
                });
            }

            const all = scanner.scanNodeProcesses();
            const SCRIPT_MAP = scanner.SCRIPT_MAP || {};
            // Mapeo inverso script → rol
            const SCRIPT_TO_ROLE = {};
            for (const [role, script] of Object.entries(SCRIPT_MAP)) {
                SCRIPT_TO_ROLE[script] = role;
            }

            const procesos = [];
            const orphans = [];
            for (const p of all) {
                if (!p.commandLine || !p.commandLine.includes('.pipeline')) continue;
                let role = null;
                for (const [script, r] of Object.entries(SCRIPT_TO_ROLE)) {
                    if (p.commandLine.includes(script)) { role = r; break; }
                }
                if (role) {
                    procesos.push({
                        'status-icon': '🟢',
                        role,
                        pid: p.pid,
                        'cpu-percent': '—',
                        'ram-human': '—',
                        uptime: '—',
                        'is-zombie': false,
                    });
                } else {
                    // Huérfano: corre dentro de .pipeline pero no matchea ningún script conocido.
                    const safeCmd = redactReadOutput(String(p.commandLine).slice(0, 160)).text;
                    orphans.push({ pid: p.pid, 'cmdline-redacted': safeCmd });
                }
            }

            return fillTemplate('procesos-node', {
                timestamp: new Date().toISOString(),
                'total-count': procesos.length,
                'total-ram-human': '—',
                processes: procesos,
                'has-orphans': orphans.length > 0,
                'orphan-count': orphans.length,
                orphans,
            });
        },

        salud: async () => {
            // Datos básicos del estado del pulpo: lock activo, último tick, errores recientes.
            const lockPath = path.join(PIPELINE, 'pulpo.lock');
            let lockActive = false;
            let lockPid = null;
            if (fs.existsSync(lockPath)) {
                try {
                    const lockData = fs.readFileSync(lockPath, 'utf8').trim();
                    lockPid = lockData;
                    lockActive = true;
                } catch (_) {}
            }
            // Último tick: tomamos `last-tick.json` si existe, sino fallback a mtime del lock.
            let lastTickElapsed = 'desconocido';
            try {
                const tickPath = path.join(PIPELINE, 'last-tick.json');
                if (fs.existsSync(tickPath)) {
                    const tick = JSON.parse(fs.readFileSync(tickPath, 'utf8'));
                    if (tick.timestamp) {
                        const elapsed = Date.now() - new Date(tick.timestamp).getTime();
                        lastTickElapsed = formatElapsed(elapsed);
                    }
                } else if (lockActive) {
                    const stat = fs.statSync(lockPath);
                    lastTickElapsed = formatElapsed(Date.now() - stat.mtimeMs);
                }
            } catch (_) {}

            // Recolectar errores recientes de commander.log + pulpo.log (últimos 60min).
            const recentErrors = collectRecentErrors(LOG_DIR);

            return fillTemplate('salud-pulpo', {
                timestamp: new Date().toISOString(),
                healthy: lockActive && !lastTickElapsed.startsWith('+'),
                'last-tick-elapsed': lastTickElapsed,
                'lock-active': lockActive,
                'lock-pid': lockPid || '--',
                phases: [],
                'watchdog-stuck-state': 'activo',
                'watchdog-cost-state': 'activo',
                'watchdog-cb-state': 'activo',
                'recent-errors': recentErrors.length > 0 ? recentErrors : null,
                'recent-errors-count': recentErrors.length,
            });
        },
    };
}

// -----------------------------------------------------------------------------
// UTILIDADES INTERNAS
// -----------------------------------------------------------------------------

function humanBytes(n) {
    if (!Number.isFinite(n) || n < 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let v = n;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i += 1;
    }
    return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function formatElapsed(ms) {
    if (!Number.isFinite(ms) || ms < 0) return 'desconocido';
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ${sec % 60}s`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h}h ${min % 60}m`;
    return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function clipForTelegram(text) {
    // Telegram limita 4096 chars por mensaje; dejamos buffer holgado.
    const LIMIT = 3000;
    if (text.length <= LIMIT) return text;
    return text.slice(-LIMIT);
}

function renderProgressBar(percent) {
    // Barra ASCII de 20 caracteres. Defensivo: percent fuera de rango lo clampeamos.
    const pct = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
    const filled = Math.round((pct / 100) * 20);
    return '█'.repeat(filled) + '░'.repeat(20 - filled);
}

function stateIcon(state) {
    switch (String(state || '').toLowerCase()) {
        case 'pendiente': return '⏳';
        case 'trabajando': return '⚙️';
        case 'listo': return '✅';
        case 'procesado': return '📦';
        default: return '•';
    }
}

function portInUse(port) {
    // Reusa pid-discovery.findPidByPort si está disponible; defensivo si el
    // módulo no carga (test aislado del commander).
    try {
        const scanner = require('../pid-discovery');
        return scanner.findPidByPort(port) || null;
    } catch (_) {
        return null;
    }
}

function pidStartTime(pid) {
    try {
        const scanner = require('../pid-discovery');
        const all = scanner.scanNodeProcesses();
        for (const p of all) {
            if (p.pid === pid && p.creationDate) {
                // wmic CreationDate: yyyyMMddHHmmss.ffffff+TZ
                const m = String(p.creationDate).match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
                if (m) {
                    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
                    const t = Date.parse(iso);
                    if (Number.isFinite(t)) return t;
                }
            }
        }
    } catch (_) {}
    return null;
}

function collectRecentErrors(logDir) {
    const out = [];
    const cutoff = Date.now() - 60 * 60 * 1000;
    const files = ['commander.log', 'pulpo.log'];
    for (const f of files) {
        const p = path.join(logDir, f);
        if (!fs.existsSync(p)) continue;
        try {
            const stat = fs.statSync(p);
            if (stat.mtimeMs < cutoff) continue;
            const content = fs.readFileSync(p, 'utf8').split('\n').slice(-200);
            for (const line of content) {
                if (/ERROR|error|⚠️|exception/i.test(line)) {
                    const tsMatch = line.match(/\[([\dT:.Z-]+)\]/);
                    const ts = tsMatch ? tsMatch[1] : '';
                    out.push({
                        'ts-short': ts.slice(11, 16),
                        'message-short': redactReadOutput(line.slice(0, 120)).text,
                    });
                    if (out.length >= 5) return out;
                }
            }
        } catch (_) { /* silencio */ }
    }
    return out;
}

// -----------------------------------------------------------------------------
// MÉTRICAS (CA-4)
// -----------------------------------------------------------------------------

/**
 * Lee `commander-audit-*.jsonl` y calcula % determinístico vs LLM vs unknown
 * por día. El resultado se consume desde el dashboard (`/metrics/commander/routing`).
 *
 * @param {string} logsDir
 * @param {object} [opts]
 * @param {number} [opts.days=7]  - ventana de días hacia atrás
 * @param {Date}   [opts.now]
 */
function computeRoutingMetrics(logsDir, opts) {
    const options = opts || {};
    const days = Number.isFinite(options.days) ? options.days : 7;
    const nowMs = options.now instanceof Date ? options.now.getTime() : Date.now();
    const buckets = []; // por día

    for (let i = days - 1; i >= 0; i -= 1) {
        const date = new Date(nowMs - i * 86400000);
        const stamp = date.toISOString().slice(0, 10);
        const file = path.join(logsDir, `commander-audit-${stamp}.jsonl`);
        const bucket = { date: stamp, deterministic: 0, llm: 0, unknown: 0, total: 0, percentDeterministic: 0 };
        if (fs.existsSync(file)) {
            try {
                const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
                for (const ln of lines) {
                    try {
                        const row = JSON.parse(ln);
                        if (row.intent_class === 'deterministic') bucket.deterministic += 1;
                        else if (row.intent_class === 'llm') bucket.llm += 1;
                        else bucket.unknown += 1;
                        bucket.total += 1;
                    } catch (_) { /* skip */ }
                }
            } catch (_) { /* skip */ }
        }
        bucket.percentDeterministic = bucket.total > 0
            ? Math.round((bucket.deterministic / bucket.total) * 1000) / 10
            : 0;
        buckets.push(bucket);
    }
    return { window_days: days, buckets };
}

module.exports = {
    classify,
    validateArgs,
    createDispatcher,
    computeRoutingMetrics,
    DETERMINISTIC_SLASH,
    LLM_SLASH,
    NLP_PATTERNS,
    ARG_SCHEMAS,
};

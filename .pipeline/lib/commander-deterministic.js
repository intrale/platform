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
const { fillTemplate, escapeMarkdownV2 } = require('./commander/fill-template');
const { createAuditLog } = require('./commander/audit-log');
const { createRateLimiter } = require('./commander/rate-limit');
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
    'listado',
    'allowlist',
    'tail',
    'dashboard-up',
    'dashboard-down',
    'screenshot',
    'procesos',
    'salud',
    'descanso',
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
    { regex: /\b(snapshot|snapshot de (la )?ola|estado de (la )?ola|ola en curso)\b/i, command: 'snapshot' },
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

const ARG_SCHEMAS = {
    status: { allow: () => true },
    snapshot: { allow: () => true },
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
        let status = 'ok';
        try {
            const result = await handler({ args: intent.args, message, intent });
            reply = typeof result === 'string' ? result : (result && result.reply) || null;
        } catch (e) {
            status = 'error';
            try { process.stderr.write(`[commander-deterministic] handler ${intent.command} falló: ${e.message}\n`); } catch (_) {}
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
        return { reply, status, handler: intent.command, intent, durationMs };
    }

    return {
        classify,
        validateArgs,
        dispatch,
        auditLog,
        rateLimiter,
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

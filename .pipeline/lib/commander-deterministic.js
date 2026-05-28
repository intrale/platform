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

// Issue #3541 — Notificación CUA fire-and-forget. Se carga lazy en
// `createDispatcher` para no encarecer el require del módulo cuando el feature
// está apagado (default OFF en config.yaml). Tests pueden inyectar un stub vía
// `opts.cua.deps`.
let _deliverableNotifyModule = null;
function _loadDeliverableNotify() {
    if (_deliverableNotifyModule) return _deliverableNotifyModule;
    try {
        _deliverableNotifyModule = require('./deliverable-notify');
        return _deliverableNotifyModule;
    } catch (e) {
        return null;
    }
}

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
    // Issue #3415 — `/rechazar` y sus aliases. El handler vive en
    // `commander/rechazar-handler.js` y se inyecta como default handler.
    'rechazar',
    'reject',
    'rebobinar',
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
    // Issue #3415 — NLP para `/rechazar` (texto natural). El residual del
    // replace queda como args ("3381 ux el mockup..."). Capturamos verbos
    // típicos: rechazá/rechazar, rebobiná/rebobinar, reject. El parser del
    // handler tolera espacios y comas en el residual.
    { regex: /^(?:rech[áa]z[áa]?|rech[áa]ce|rebobin[áa]?|reject)\s+/i, command: 'rechazar' },
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
// #3493 — H5 expande la sintaxis a subcomandos: `/wave [status [--audio] | next | add <num> #issue | promote]`.
// La forma antigua `/wave` y `/wave --audio` se preservan (backward compat → status).
const WAVE_SUBCOMMANDS = new Set(['status', 'next', 'add', 'promote']);

/**
 * Parsea `args` de `/wave` y devuelve `{ subcommand, audio, waveNumber, issueNumber }`
 * o `null` si la sintaxis no matchea ningún subcomando válido.
 *
 * Reglas de validación estricta (CA-5 security refuerzo pt.2):
 *   - Sin args, o solo `--audio` → backward-compat con #3262 → `status`.
 *   - `status [--audio]`         → status con audio opt-in.
 *   - `next`                     → próxima ola, sin args extra.
 *   - `add <num> #issue`         → `num` entero positivo, `#issue` matchea `^#\d+$`.
 *   - `promote`                  → promote, sin args extra.
 *   - Cualquier otra combinación devuelve `null` (handler genera error claro).
 */
function parseWaveArgs(rawArgs) {
    const tokens = String(rawArgs || '').trim().split(/\s+/).filter(Boolean);
    // Caso vacío → status backward-compat.
    if (tokens.length === 0) {
        return { subcommand: 'status', audio: false };
    }
    const head = tokens[0].toLowerCase();
    // Backward-compat: `/wave --audio` (sin subcomando explícito) → status con audio.
    if (head === '--audio' && tokens.length === 1) {
        return { subcommand: 'status', audio: true };
    }
    if (!WAVE_SUBCOMMANDS.has(head)) return null;

    if (head === 'status') {
        if (tokens.length === 1) return { subcommand: 'status', audio: false };
        if (tokens.length === 2 && tokens[1].toLowerCase() === '--audio') {
            return { subcommand: 'status', audio: true };
        }
        return null;
    }
    if (head === 'next' || head === 'promote') {
        if (tokens.length !== 1) return null;
        return { subcommand: head };
    }
    if (head === 'add') {
        // Schema estricto: exactamente 3 tokens (`add`, num, #issue) — sin extras.
        if (tokens.length !== 3) return null;
        const numToken = tokens[1];
        const issueToken = tokens[2];
        // `num` debe ser entero positivo decimal puro (no floats, no negativos, no hex).
        if (!/^\d+$/.test(numToken)) return null;
        const waveNumber = parseInt(numToken, 10);
        if (!Number.isInteger(waveNumber) || waveNumber < 1) return null;
        // `#issue` matchea exacto `#` + dígitos.
        if (!/^#\d+$/.test(issueToken)) return null;
        const issueNumber = parseInt(issueToken.slice(1), 10);
        if (!Number.isInteger(issueNumber) || issueNumber < 1) return null;
        return { subcommand: 'add', waveNumber, issueNumber };
    }
    return null;
}

const ARG_SCHEMAS = {
    status: { allow: () => true },
    snapshot: { allow: () => true },
    wave: {
        allow(args) {
            // #3493 — Acepta subcomandos status/next/add/promote y backward-compat.
            // Validación estricta delegada en parseWaveArgs (rechaza floats, regex
            // mismatch, tokens extra → security CA-5).
            return parseWaveArgs(args) !== null;
        },
        usage: 'wave [status [--audio] | next | add <num> #issue | promote]',
        allowedValues: ['status', 'status --audio', 'next', 'add <num> #issue', 'promote'],
        hint: 'Subcomandos: `status` (con `--audio` opcional), `next`, `add <num> #issue`, `promote`. Sin subcomando equivale a `status`.',
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
    // Issue #3415 — `/rechazar` valida MÍNIMAMENTE acá. El parser estricto
    // (SEC-1.5 issue + SEC-1.4 fase) vive en rechazar-handler.js para que
    // el handler pueda diferenciar entre texto y audio transcripto.
    // Acá solo gateamos: si llega texto plano (no audio), debe haber al
    // menos algo de input. Para audio (sin args), dejamos pasar y que el
    // handler decida (puede haber transcripción válida en _textoFinal).
    rechazar: { allow: () => true },
    reject: { allow: () => true },
    rebobinar: { allow: () => true },
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
// CUA NOTIFY EMITTER (#3541)
// -----------------------------------------------------------------------------

/**
 * Crea un emisor de notificaciones CUA atado al config del pipeline. La
 * fachada `emit(entregable)` se inyecta en cada handler determinístico vía
 * `ctx.cuaEmit`. Si el feature está apagado (default), `emit` es un noop que
 * devuelve `{ ok: false, action: 'skipped', reason: 'disabled' }` sin tocar
 * ningún side-effect.
 *
 * CA-TEC-2 — Filtrado de stages se aplica acá (el caller). `notifyCua` también
 * lo verifica como defensa, pero el camino feliz nunca llega allá si el stage
 * no está en `cua.notifiable_stages`.
 *
 * @param {object} opts
 * @param {object} opts.config - bloque `cua` del config.yaml.
 * @param {string} opts.pipelineRoot
 * @param {string} opts.telegramQueueDir
 * @param {object} [opts.deps]
 * @param {function} [opts.log] - logger del caller (pulpo.log) para visibilidad.
 * @returns {{ emit: function, enabled: boolean, notifiableStages: string[], allowedCommands: string[] }}
 */
function createCuaEmitter(opts) {
    const o = opts || {};
    const cfg = o.config || {};
    const enabled = cfg.enabled === true && cfg.kill_switch !== true;
    const notifiableStages = Array.isArray(cfg.notifiable_stages) && cfg.notifiable_stages.length > 0
        ? cfg.notifiable_stages
        : [];
    const allowedCommands = Array.isArray(cfg.allowed_commands) ? cfg.allowed_commands : [];
    const log = typeof o.log === 'function' ? o.log : (() => {});

    function emit(entregable) {
        if (!enabled) {
            return { ok: false, action: 'skipped', reason: 'disabled' };
        }
        if (!entregable || typeof entregable !== 'object') {
            return { ok: false, action: 'skipped', reason: 'invalid_entregable' };
        }
        // CA-TEC-2 — filtro stage en el caller. Si el stage no está en la
        // lista, ni siquiera invocamos notifyCua (más barato).
        if (notifiableStages.length > 0 && !notifiableStages.includes(entregable.stage)) {
            return { ok: false, action: 'skipped', reason: 'stage_not_notifiable' };
        }
        const mod = (o.deps && o.deps.deliverableNotify) || _loadDeliverableNotify();
        if (!mod || typeof mod.notifyCua !== 'function') {
            return { ok: false, action: 'skipped', reason: 'module_unavailable' };
        }
        let result;
        try {
            result = mod.notifyCua({
                entregable,
                config: cfg,
                pipelineRoot: o.pipelineRoot,
                telegramQueueDir: o.telegramQueueDir,
                deps: o.deps,
            });
        } catch (e) {
            // notifyCua ya captura todo; si llegamos acá es algo del módulo.
            return { ok: false, action: 'error', reason: (e && e.message) || String(e) };
        }

        // CA-FUNC-9 — fire-and-forget. El audit ya quedó persistido sync;
        // sólo el audioTask es async. Lo enganchamos a un .catch defensivo
        // para que cualquier rejection sin handler quede silenciada.
        if (result && result.audioTask && typeof result.audioTask.then === 'function') {
            result.audioTask.catch(() => {});
        }
        if (result && result.ok) {
            log('cua', `⚙️ /${entregable.command} ${entregable.stage} → enqueued`);
        } else if (result && result.action === 'rejected') {
            log('cua', `⚙️ /${entregable.command || '?'} rechazado: ${result.reason}`);
        } else if (result && result.action === 'skipped' && result.reason !== 'disabled') {
            log('cua', `⚙️ /${entregable.command || '?'} skipped (${result.reason})`);
        }
        return result;
    }

    return {
        emit,
        enabled,
        notifiableStages,
        allowedCommands,
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

    // Issue #3541 — Emisor de notificaciones CUA. Si el caller no inyecta el
    // bloque `cua`, queda un emitter "noop" que devuelve `disabled`. Esto deja
    // toda la lógica downstream homogénea — los handlers siempre tienen un
    // `cuaEmit` válido aunque el feature esté apagado.
    const cuaOpts = options.cua || {};
    const cuaEmitter = createCuaEmitter({
        config: cuaOpts.config,
        pipelineRoot: cuaOpts.pipelineRoot || options.pipelineRoot,
        telegramQueueDir: cuaOpts.telegramQueueDir,
        deps: cuaOpts.deps,
        log: cuaOpts.log,
    });

    // Defaults: handlers stub que el caller (pulpo.js) puede overridear con
    // implementaciones reales. El módulo no asume infra — devuelve "stub" si
    // no se inyectó nada, para que el router siga siendo testable aislado.
    const defaultHandlers = buildDefaultHandlers({
        pipelineRoot: options.pipelineRoot,
        logsDir: options.logsDir,
        now: options.now,
        // Issue #3415 — overrides para el handler de `/rechazar`. El caller
        // (pulpo.js o tests) puede inyectar `whisperLocal`/`githubClient`/etc.
        // Si no se inyectan, se usan los defaults reales (whisper-local.js + gh CLI).
        rechazarDeps: options.rechazarDeps || null,
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
        // Issue #3541 — Si el comando ejecutado está en `cua.allowed_commands`
        // y el feature está habilitado, emitimos automáticamente `init` antes
        // del handler y `completion` después. Los handlers pueden también
        // emitir `validation`/`analysis` desde dentro usando `ctx.cuaEmit`.
        // Cumple CA-FUNC-6 (enqueue por stage) y CA-TEC-2 (filtro en caller).
        const cuaShouldAutoEmit = cuaEmitter.enabled
            && cuaEmitter.allowedCommands.length > 0
            && cuaEmitter.allowedCommands.includes(intent.command);
        const handlerStartedAt = now();
        if (cuaShouldAutoEmit) {
            cuaEmitter.emit({
                command: intent.command,
                stage: 'init',
                status: 'in_progress',
                preview: `⏳ Comando \`${intent.command}\` iniciado.`,
                args: typeof intent.args === 'string' && intent.args.length > 0 ? intent.args : undefined,
            });
        }
        try {
            const result = await handler({
                args: intent.args,
                message,
                intent,
                // Issue #3541 — `cuaEmit` disponible para que handlers complejos
                // emitan stages intermedios (`validation`, `analysis`) cuando
                // identifican un hito interno. Es noop si CUA está apagado.
                cuaEmit: cuaEmitter.emit,
            });
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
        // Issue #3541 — completion stage. `status` mapea a `ok`/`fail` según
        // cómo terminó el handler.
        if (cuaShouldAutoEmit) {
            const durationS = Math.max(0, (now() - handlerStartedAt) / 1000);
            const completedOk = status === 'ok' && reply !== null;
            cuaEmitter.emit({
                command: intent.command,
                stage: 'completion',
                status: completedOk ? 'ok' : 'fail',
                preview: completedOk
                    ? `Comando \`${intent.command}\` completado.`
                    : `Comando \`${intent.command}\` terminó con errores.`,
                args: typeof intent.args === 'string' && intent.args.length > 0 ? intent.args : undefined,
                duration: durationS,
            });
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
        // Issue #3541 — expuesto para que callers externos (ej. handlers que
        // viven fuera del switch del dispatcher) puedan emitir entregables
        // CUA con el mismo emisor inicializado.
        cuaEmit: cuaEmitter.emit,
        cuaEmitter,
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

    // #3493 — Cooldown destructivo específico para subcomandos de `/wave`.
    // El cooldown global del dispatcher es per-comando (`wave`), no per-subcomando.
    // Como `/wave status` y `/wave next` son read-only y `/wave add` y
    // `/wave promote` son destructivos, NO podemos meter `wave` en el set global
    // (gatearía las lecturas). Spawneamos uno aislado con claves virtuales
    // (`wave-add`, `wave-promote`) y ventana de 30s — más corta que el default
    // 60s porque las mutaciones son granulares y la idempotencia de
    // `waves.addIssueToWave` (no-op si ya está) ya cubre el doble-tap accidental.
    // CA-9 — destructiveCooldown MUST en add/promote (refuerzo security pt.3).
    const waveSubCooldown = createDestructiveCooldown({
        cooldownMs: 30 * 1000,
        destructiveCommands: ['wave-add', 'wave-promote'],
        now: ctx.now,
    });

    // Issue #3415 — handler de `/rechazar` (singleton dentro del dispatcher,
    // mantiene el auditor de rejections vivo entre dispatches).
    const rechazarDeps = ctx.rechazarDeps || {};
    const { createRechazarHandler } = require('./commander/rechazar-handler');
    const rechazarHandler = createRechazarHandler({
        pipelineRoot: PIPELINE,
        auditDir: rechazarDeps.auditDir || path.join(PIPELINE, 'audit'),
        rejectionsDir: rechazarDeps.rejectionsDir || path.join(PIPELINE, 'rejections'),
        redactSensitive: rechazarDeps.redactSensitive || ((s) => baseRedact.redactSensitive(String(s || ''))),
        whisperLocal: rechazarDeps.whisperLocal,
        githubClient: rechazarDeps.githubClient,
        now: ctx.now || rechazarDeps.now,
        randomVariant: rechazarDeps.randomVariant,
        maxAudioBytes: rechazarDeps.maxAudioBytes,
        maxAudioDurationS: rechazarDeps.maxAudioDurationS,
        maxStaleMs: rechazarDeps.maxStaleMs,
        noReturnLabels: rechazarDeps.noReturnLabels,
        logger: rechazarDeps.logger,
        // Issue #3541 / CA-SEC-6 — propagar la allowlist de operadores
        // autorizados a rebobinar entregables CUA + whitelist de comandos
        // desde el caller (pulpo.js). Sin esto, todo `/rechazar <cua>` cae en
        // `unauthorized_rebobinar` aunque pulpo wiree `cua.enabled: true`.
        cuaOperatorChatIds: Array.isArray(rechazarDeps.cuaOperatorChatIds)
            ? rechazarDeps.cuaOperatorChatIds
            : [],
        allowedCuaCommands: Array.isArray(rechazarDeps.allowedCuaCommands)
            ? rechazarDeps.allowedCuaCommands
            : [],
    });

    return {
        // Issue #3415 — aliases todos mapean al mismo handler.
        rechazar: rechazarHandler.handle,
        reject: rechazarHandler.handle,
        rebobinar: rechazarHandler.handle,

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

        wave: async ({ args, message }) => {
            // #3262 — Snapshot ejecutivo de la ola para Telegram.
            // #3493 — H5 expande a 4 subcomandos:
            //   status [--audio] | next | add <num> #issue | promote
            //
            // Reutiliza la infraestructura existente:
            //   - wave-resolver / wave-snapshot / wave-renderer → render `status`.
            //   - lib/waves.js (H1 #3489) → CRUD de `waves.json` (next/add/promote).
            //   - partial-pause.js → actualizar `.partial-pause.json` post-promote.
            //   - destructive-cooldown (waveSubCooldown) → MUST en add/promote (CA-9).
            //   - audit-log via dispatcher → CA-10. Acá solo retornamos reply/status.
            //
            // Performance (CA-11): todo el handler corre sin red, sin LLM, sin
            // subprocess. < 500ms p99 incluso con scan FS de issues conocidos
            // (cache 30s vía getKnownIssues).
            const parsed = parseWaveArgs(args);
            // Defensa en profundidad: si validateArgs dejó pasar algo malformado
            // (no debería suceder por ARG_SCHEMAS.wave.allow), respondemos error
            // en español sin colgar el dispatcher.
            if (!parsed) {
                return fillTemplate('wave-error', {
                    'error-kind': 'subcomando-invalido',
                    message: 'Subcomando inválido. Usá: `status` · `next` · `add <num> #issue` · `promote`.',
                });
            }

            // Mapeo subcomando → handler dedicado. Cada uno responde { reply, audioText? }.
            switch (parsed.subcommand) {
                case 'status':
                    return handleWaveStatus({ pipelineRoot: PIPELINE, audio: parsed.audio });
                case 'next':
                    return handleWaveNext({ pipelineRoot: PIPELINE });
                case 'add':
                    return handleWaveAdd({
                        pipelineRoot: PIPELINE,
                        waveNumber: parsed.waveNumber,
                        issueNumber: parsed.issueNumber,
                        cooldown: waveSubCooldown,
                        chatId: message && message.chat_id !== undefined ? String(message.chat_id) : null,
                        from: message && message.from ? String(message.from) : 'Leo',
                    });
                case 'promote':
                    return handleWavePromote({
                        pipelineRoot: PIPELINE,
                        cooldown: waveSubCooldown,
                        chatId: message && message.chat_id !== undefined ? String(message.chat_id) : null,
                        from: message && message.from ? String(message.from) : 'Leo',
                    });
                default:
                    return fillTemplate('wave-error', {
                        'error-kind': 'subcomando-no-soportado',
                        message: `Subcomando "${parsed.subcommand}" no soportado.`,
                    });
            }
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
// #3493 — SUB-HANDLERS DE `/wave` (H5)
//
// Cuatro funciones puras que reciben el contexto necesario y devuelven el shape
// `{ reply, audioText? }` que el dispatcher espera. Separadas del handler
// principal para mantener cada subcomando testeable de forma aislada.
//
// Reglas comunes:
//   - Sin red, sin LLM, sin subprocess. Solo `lib/waves.js` (FS atómico) +
//     `partial-pause.js` + `wave-renderer.js`.
//   - Antes de operaciones destructivas (add/promote) → `waves.invalidateCache()`
//     (CA-7 / CA-8 — read-fresh para evitar TOCTOU sobre el TTL de 2s).
//   - Mutaciones SIEMPRE marcan `meta.source: 'telegram-commander/wave-<sub>'`
//     y `meta.updated_by` con el chat. CA-7 / CA-8 visibilidad de origen.
//   - Errores rebotan al template `wave-error` con `error-kind` semántico.
// -----------------------------------------------------------------------------

// Cache de issues conocidos del pipeline (CA-6 — existence check < 500ms).
// Scope: in-memory por proceso. TTL 30s — suficiente para ráfagas de
// `/wave add` consecutivos sin recorrer FS otra vez.
const knownIssuesCache = new Map(); // pipelineRoot → { issues: Set<number>, ts }

/**
 * Lista los issues con artefactos vivos en el pipeline. Recorre
 * `desarrollo/**` y `definicion/**` buscando archivos `<num>.<skill>`.
 * No consulta GitHub (CA-6 — sin `gh issue view` sincrónico).
 *
 * @param {string} pipelineRoot
 * @returns {Set<number>}
 */
function getKnownIssues(pipelineRoot) {
    const nowMs = Date.now();
    const cached = knownIssuesCache.get(pipelineRoot);
    if (cached && (nowMs - cached.ts) < 30 * 1000) return cached.issues;

    const issues = new Set();
    const roots = [
        path.join(pipelineRoot, 'desarrollo'),
        path.join(pipelineRoot, 'definicion'),
    ];
    function walk(dir, depth) {
        if (depth > 4) return; // guardia anti-loop simbólico
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch (_) { return; }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { walk(full, depth + 1); continue; }
            // Convención del pipeline: artefactos se nombran `<issue>.<skill>` o
            // `<issue>.<skill>.<sufijo>` (ej. `3493.pipeline-dev`, `3493.guru.json`).
            const m = e.name.match(/^(\d+)\.[\w.-]+$/);
            if (m) issues.add(Number(m[1]));
        }
    }
    for (const r of roots) walk(r, 0);

    knownIssuesCache.set(pipelineRoot, { issues, ts: nowMs });
    return issues;
}

/**
 * Invalida la cache de issues conocidos. Útil para tests deterministas.
 */
function invalidateKnownIssuesCache(pipelineRoot) {
    if (pipelineRoot === undefined) knownIssuesCache.clear();
    else knownIssuesCache.delete(pipelineRoot);
}

/**
 * `/wave status [--audio]` — Reusa el snapshot ejecutivo de #3262 (CA-3 DRY).
 *
 * Post-#3502: el resolver delega internamente en `lib/waves.js` como
 * source-of-truth única. Ya no necesitamos rama dual acá — la cascada
 * (waves.json → partial-pause → fs-fallback) vive del lado del resolver.
 * `usingLegacy` se infiere del `wave.source` para mantener la nota discreta
 * del template `wave-status` cuando no se está leyendo de `waves.json`.
 */
async function handleWaveStatus({ pipelineRoot, audio }) {
    const resolver = require('./wave-resolver');
    const snapshotMod = require('./wave-snapshot');
    const rendererMod = require('./wave-renderer');
    const stateMod = require('./wave-state');

    const wave = resolver.resolveActiveWave({ pipelineRoot });
    const usingLegacy = wave.source !== 'waves.json';

    const state = stateMod.getCachedWaveState({ pipelineRoot });

    let blocked = [];
    try {
        const humanBlock = require('./human-block');
        if (typeof humanBlock.listBlockedIssues === 'function') {
            blocked = humanBlock.listBlockedIssues() || [];
        }
    } catch (_) { /* sin bloqueados */ }

    const closedIssues = new Set();
    for (const id of wave.issues) {
        const data = state.issueMatrix && state.issueMatrix[String(id)];
        if (!data) continue;
        const labels = Array.isArray(data.labels) ? data.labels : [];
        const labelNames = labels
            .map((l) => (typeof l === 'string' ? l : (l && l.name) || ''))
            .filter(Boolean);
        if (labelNames.includes('closed') || labelNames.includes('done')) {
            closedIssues.add(Number(id));
        }
    }

    const snapshot = snapshotMod.buildWaveSnapshot({ state, wave, blocked, closedIssues });
    const snapshotMd = rendererMod.renderWaveSnapshot(snapshot);
    const audioText = audio ? rendererMod.renderAudioText(snapshot) : null;
    // CA-13 — render por template wave-status (`{{{snapshot}}}` triple-brace para
    // no re-escapar MarkdownV2 ya producido por wave-renderer).
    const reply = fillTemplate('wave-status', {
        snapshot: snapshotMd,
        'using-legacy': usingLegacy,
        'audio-sent': !!audioText,
    });
    return { reply, audioText };
}

/**
 * `/wave next` — Lista candidatos de la próxima ola desde `waves.json`.
 * Si no hay `planned_waves[0]`, mensaje cálido (UX guidelines).
 */
async function handleWaveNext({ pipelineRoot }) {
    const waves = require('./waves');
    waves.invalidateCache(); // CA-16 — opcional acá pero garantiza freshness.
    const state = waves.loadWaves();
    const next = Array.isArray(state.planned_waves) && state.planned_waves.length > 0
        ? state.planned_waves[0]
        : null;
    if (!next) {
        return { reply: fillTemplate('wave-next', { 'has-next': false }) };
    }
    const issues = Array.isArray(next.issues) ? next.issues : [];
    return {
        reply: fillTemplate('wave-next', {
            'has-next': true,
            'wave-number': next.number,
            goal: next.goal || '',
            'has-goal': !!next.goal,
            'issues-count': issues.length,
            'has-issues': issues.length > 0,
            issues: issues.map((i) => {
                const num = typeof i === 'object' && i ? i.number : i;
                const size = typeof i === 'object' && i && typeof i.size === 'string' ? i.size : null;
                const rationale = typeof i === 'object' && i && typeof i.rationale === 'string' ? i.rationale : null;
                return {
                    number: Number(num),
                    'has-size': !!size,
                    size: size || '',
                    'has-rationale': !!rationale,
                    rationale: rationale || '(sin rationale aún)',
                };
            }),
        }),
    };
}

/**
 * `/wave add <num> #issue` — Mueve un issue a una ola específica.
 * Aplica:
 *   - destructiveCooldown (CA-9, MUST).
 *   - Existence check del issue (CA-6).
 *   - Validación waveNumber ∈ [1, totalOlas] (CA-5).
 *   - Read-fresh (`invalidateCache`) antes de mutación (CA-7).
 *   - Atomic write via `waves.save` (CA-7).
 *   - Conflict detection si el issue ya está en otra ola.
 */
async function handleWaveAdd({ pipelineRoot, waveNumber, issueNumber, cooldown, chatId, from }) {
    // CA-9 — Cooldown previo. Defensa contra doble-tap accidental.
    if (cooldown && chatId) {
        const cd = cooldown.check(chatId, 'wave-add');
        if (!cd.allowed) {
            return {
                reply: fillTemplate('wave-error', {
                    'error-kind': 'cooldown_blocked',
                    message: `Esperá ${humanizeRetryAfter(cd.retryAfterMs)} antes de repetir \`/wave add\` (anti doble-tap).`,
                }),
            };
        }
    }

    const waves = require('./waves');
    // CA-7 — read-fresh: invalidamos el TTL cache antes de leer y mutar.
    waves.invalidateCache();
    const state = waves.loadWaves();
    const planned = Array.isArray(state.planned_waves) ? state.planned_waves : [];
    const active = state.active_wave || null;
    const totalOlas = (active ? 1 : 0) + planned.length;

    // CA-5 — Validación de rango. `waveNumber` debe corresponder a una ola
    // existente. La política simple: aceptamos `waveNumber` ∈ [1, totalOlas]
    // mapeando 1 = active_wave (si existe) y 2..N = planned_waves[0..N-2].
    // Si el caller pide una ola que no existe, error semántico claro.
    let targetWaveExists = false;
    let targetWaveResolved = null;
    if (active && active.number === waveNumber) {
        targetWaveExists = true;
        targetWaveResolved = active;
    } else {
        const w = planned.find((p) => p.number === waveNumber);
        if (w) { targetWaveExists = true; targetWaveResolved = w; }
    }
    if (!targetWaveExists) {
        return {
            reply: fillTemplate('wave-error', {
                'error-kind': 'wave_not_found',
                message: `No encontré la ola \`${waveNumber}\`. Olas disponibles: ${describeAvailableWaves(active, planned)}.`,
            }),
        };
    }

    // CA-6 — Existence check del issue. Cache 30s + recorrido FS, sin red.
    const known = getKnownIssues(pipelineRoot);
    if (!known.has(issueNumber)) {
        return {
            reply: fillTemplate('wave-error', {
                'error-kind': 'unknown_issue',
                message: `No encontré #${issueNumber} en el pipeline. ¿Lo escribiste bien? ¿O es de un repo distinto?`,
            }),
        };
    }

    // CA-7 — Mutación. addIssueToWave es atómico (waves.save → tmp+rename).
    try {
        waves.addIssueToWave(waveNumber, { number: issueNumber }, {
            updated_by: from || 'Leo',
            source: 'telegram-commander/wave-add',
            note: `move issue #${issueNumber} → wave ${waveNumber}`,
        });
    } catch (e) {
        const msg = String(e && e.message ? e.message : e);
        // Detección de conflict: addIssueToWave lanza con "ya está en ola N".
        if (/ya está en ola/i.test(msg)) {
            return {
                reply: fillTemplate('wave-error', {
                    'error-kind': 'conflict',
                    message: msg + '. Si querés moverlo de verdad, primero sacalo de allá.',
                }),
            };
        }
        return {
            reply: fillTemplate('wave-error', {
                'error-kind': 'fs_error',
                message: `Algo falló escribiendo el estado: ${msg}`,
            }),
        };
    }

    // Releer estado para devolver el tamaño actualizado de la ola destino.
    waves.invalidateCache();
    const refreshed = waves.loadWaves();
    const refreshedTarget = (refreshed.active_wave && refreshed.active_wave.number === waveNumber)
        ? refreshed.active_wave
        : (refreshed.planned_waves || []).find((w) => w.number === waveNumber);
    const newSize = refreshedTarget && Array.isArray(refreshedTarget.issues)
        ? refreshedTarget.issues.length
        : 1;

    // CA-9 — Marcar éxito en el cooldown DESPUÉS del write.
    if (cooldown && chatId) cooldown.recordSuccess(chatId, 'wave-add');

    return {
        reply: fillTemplate('wave-add-ok', {
            'issue-number': issueNumber,
            'wave-number': waveNumber,
            'wave-name': (targetWaveResolved && targetWaveResolved.name) || `Ola ${waveNumber}`,
            'new-size': newSize,
        }),
    };
}

/**
 * `/wave promote` — Promueve `planned_waves[0]` a `active_wave`.
 *
 * #3520 — Ejecuta la transacción atómica multi-archivo vía
 * `waves.promoteWaveAtomic`, que internamente:
 *   - Crea snapshot de waves.json y .partial-pause.json en archived/.
 *   - Escribe marker `wave-promote.in-progress.json` con fsync.
 *   - Aplica `promoteWaveToActive` (waves.json) y `setPartialPauseAtomic`
 *     (.partial-pause.json) secuencialmente.
 *   - Si la segunda escritura falla, rollback inline desde el snapshot.
 *   - Si crashea entre las dos escrituras, el boot recovery del próximo
 *     pulpo (pulpo.js → waves.recoverIncompletePromote()) restaura.
 *
 * Aplica además:
 *   - destructiveCooldown (CA-9, MUST).
 *   - Gate fail-closed: si hay `wave-promote.failed.*.json` activo,
 *     bloquea con mensaje accionable (CA-C3 / CA-D3).
 *   - Read-fresh antes de mutación (CA-8).
 */
async function handleWavePromote({ pipelineRoot, cooldown, chatId, from }) {
    if (cooldown && chatId) {
        const cd = cooldown.check(chatId, 'wave-promote');
        if (!cd.allowed) {
            return {
                reply: fillTemplate('wave-error', {
                    'error-kind': 'cooldown_blocked',
                    message: `Esperá ${humanizeRetryAfter(cd.retryAfterMs)} antes de repetir \`/wave promote\` (anti doble-tap).`,
                }),
            };
        }
    }

    const waves = require('./waves');

    // #3520 — Gate fail-closed: si recovery automático no pudo restaurar
    // una transacción anterior, NO permitimos nuevas promociones hasta que
    // un humano inspeccione y borre el .failed.
    const blocked = waves.isWavePromoteBlocked();
    if (blocked.blocked) {
        const markerNames = blocked.markers.map((p) => require('path').basename(p)).join(', ');
        return {
            reply: fillTemplate('wave-promote-blocked', {
                'failed-markers': markerNames,
                'archived-dir': '.pipeline/archived/',
            }),
        };
    }

    waves.invalidateCache();
    const state = waves.loadWaves();
    const planned = Array.isArray(state.planned_waves) ? state.planned_waves : [];
    if (planned.length === 0) {
        return {
            reply: fillTemplate('wave-error', {
                'error-kind': 'no_next_wave',
                message: 'No hay ola próxima para promover. El planner tiene que componer una primero.',
            }),
        };
    }

    const newWave = planned[0];
    const newWaveNumber = newWave.number;

    let result;
    try {
        result = waves.promoteWaveAtomic(newWaveNumber, {
            updated_by: from || 'Leo',
            source: 'telegram-commander/wave-promote',
            note: `promote wave ${newWaveNumber} → active (desde Telegram, atomic)`,
        });
    } catch (e) {
        return {
            reply: fillTemplate('wave-error', {
                'error-kind': 'fs_error',
                message: `Algo falló promoviendo la ola: ${String(e && e.message ? e.message : e)}`,
            }),
        };
    }

    if (cooldown && chatId) cooldown.recordSuccess(chatId, 'wave-promote');

    return {
        reply: fillTemplate('wave-promote-ok', {
            'has-old-wave': result.oldWaveNumber !== null,
            'old-wave-number': result.oldWaveNumber || 0,
            'new-wave-number': result.newWaveNumber,
            'new-wave-name': result.newWaveName,
            'allowlist-size': result.newAllowlist.length,
            'added-count': result.added.length,
            'removed-count': result.removed.length,
            'allowlist-applied': true,
            'has-allowlist-error': false,
            'allowlist-error': '',
        }),
    };
}

/**
 * Helper de UX: humaniza las olas disponibles para el mensaje de error
 * `wave_not_found`. Devuelve algo como "1 (activa) o 2, 3".
 */
function describeAvailableWaves(active, planned) {
    const parts = [];
    if (active) parts.push(`${active.number} (activa)`);
    for (const p of planned) parts.push(String(p.number));
    return parts.length > 0 ? parts.join(', ') : 'ninguna';
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
    // Issue #3541 — emisor CUA reutilizable por callers que no usan el
    // dispatcher completo (ej. handlers de pulpo.js fuera del switch
    // determinístico). Pasa por la misma validación + dedup + audio fire-and-forget.
    createCuaEmitter,
    DETERMINISTIC_SLASH,
    LLM_SLASH,
    NLP_PATTERNS,
    ARG_SCHEMAS,
    // #3493 — exports para tests de subcomandos `/wave`.
    parseWaveArgs,
    _waveInternal: {
        handleWaveStatus,
        handleWaveNext,
        handleWaveAdd,
        handleWavePromote,
        getKnownIssues,
        invalidateKnownIssuesCache,
        describeAvailableWaves,
    },
};

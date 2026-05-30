// =============================================================================
// agent-chat-handler.js — Handler de los endpoints /api/agent-chat (issue #3605)
//
// Endpoints expuestos:
//
//   POST /api/agent-chat
//     body: { issue, skill, fase, message, messageId? }
//     → canaliza el mensaje al stdin del agente (vía lib/agent-ipc) y persiste
//       una entrada `type:operator_message` en {logFile}.chat.jsonl con audit
//       enriquecido. Responde { status, queued_at, message_id }.
//
//   GET /api/agent-chat/history?logFile=X
//     → reconstruye historial desde {logFile}.chat.jsonl (líneas corruptas
//       skip-eadas con warning). Devuelve { entries:[...], truncated? }.
//
// Defensa (CA-S1..S8): replica el patrón de #3142 (allowlist-candidates).
// =============================================================================

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { withLock } = require('./file-lock');
const { redactSensitive } = require('./redact');
const agentIpc = require('./agent-ipc');

// Cap por tamaño individual antes del framing en server-side. El cliente puede
// mandar hasta 2000 chars; cualquier excedente se trunca acá silenciosamente
// (no error, defensa simple).
const MESSAGE_MAX_CHARS = 2000;

// Cap de tamaño total del cuerpo POST para protegerse de un cliente malicioso.
const BODY_MAX_BYTES = 32 * 1024;

// Cap de tamaño del chat JSONL antes de rotar. 5MB según CA-P6.
const CHAT_FILE_ROTATE_BYTES = 5 * 1024 * 1024;
const CHAT_FILE_MAX_ROTATIONS = 3; // .chat.jsonl + .chat.jsonl.1 + .chat.jsonl.2

// CA-SEC-1 (issue #3721): validación estricta de params del body para
// prevenir path traversal en `isAgentAlive`/`getAgentAliveDetails` (que
// construye paths a `.claude/hooks/` y `.pipeline/<pipeline>/<fase>/`).
// Regex idénticas a las de agent-ipc.js — duplicación intencional para
// defensa en profundidad (el handler rechaza ANTES de invocar el módulo IPC).
const RE_ISSUE = /^\d+$/;
const RE_SKILL = /^[a-z0-9-]{1,32}$/;
const VALID_FASES_HANDLER = [
    'analisis', 'criterios', 'validacion',
    'dev', 'build', 'verificacion', 'aprobacion',
    'entrega', 'linteo',
];
const VALID_PIPELINES_HANDLER = ['desarrollo', 'definicion'];

/**
 * Valida los params del body POST antes de invocar `agent-ipc`.
 * Retorna `{ ok: true }` si todos los campos cumplen, o
 * `{ ok: false, field: '<field>' }` señalando cuál falló.
 *
 * @param {object} body
 * @returns {{ ok: true } | { ok: false, field: string }}
 */
function validateChatParams(body) {
    const { issue, skill, fase, pipeline } = body || {};
    if (!RE_ISSUE.test(String(issue == null ? '' : issue))) {
        return { ok: false, field: 'issue' };
    }
    if (!RE_SKILL.test(String(skill == null ? '' : skill))) {
        return { ok: false, field: 'skill' };
    }
    if (!VALID_FASES_HANDLER.includes(String(fase == null ? '' : fase))) {
        return { ok: false, field: 'fase' };
    }
    // pipeline es opcional (default 'desarrollo' en el agent-ipc); validamos
    // solo si vino explícito.
    if (pipeline !== undefined && !VALID_PIPELINES_HANDLER.includes(String(pipeline))) {
        return { ok: false, field: 'pipeline' };
    }
    return { ok: true };
}

// Rate limiter token bucket por (issue, skill, fase). 10 msg/s con burst 10.
// Cargado lazy para evitar penalizar el startup del dashboard si nadie usa la
// feature.
let _rateLimiter = null;
function getRateLimiter() {
    if (!_rateLimiter) {
        const { createRateLimiter } = require('./commander/rate-limit');
        _rateLimiter = createRateLimiter({ burst: 10, ratePerMin: 600 }); // 10/s
    }
    return _rateLimiter;
}

// -----------------------------------------------------------------------------
// Helpers de seguridad (replican patrón #3142).
// -----------------------------------------------------------------------------

function isLoopbackRemote(req) {
    const remote = (req.socket && req.socket.remoteAddress) || '';
    return remote === '127.0.0.1'
        || remote === '::1'
        || remote === '::ffff:127.0.0.1'
        || remote.startsWith('127.');
}

const ALLOWED_ORIGINS = ['http://localhost:3200', 'http://127.0.0.1:3200'];

function hasValidOrigin(req) {
    const origin = req.headers['origin'] || '';
    const referer = req.headers['referer'] || '';
    let originOk = !origin || ALLOWED_ORIGINS.includes(origin);
    let refererOk = !referer || ALLOWED_ORIGINS.some((o) => referer.startsWith(o + '/'));
    return originOk && refererOk;
}

/**
 * Valida nombre de logFile contra path-traversal (CA-S7).
 * Acepta `<digits>.<skill>.log` (formato canónico del pulpo) o
 * `build-<digits>.log` (skill build legacy).
 */
function validateLogFileName(raw) {
    if (typeof raw !== 'string' || !raw) return null;
    const safe = path.basename(raw);
    // Acepta:
    //   - `<issue>.<skill>.log` (formato canónico del audit log #3083)
    //   - `<issue>-<skill>.log` (formato del pulpo en disco hoy)
    //   - `build-<issue>.log`   (skill build legacy)
    if (!/^(\d+\.[\w-]+\.log|\d+-[\w-]+\.log|build-\d+\.log)$/.test(safe)) return null;
    return safe;
}

/**
 * Sanitiza el mensaje del operador antes de IPC y antes de persistir.
 * CA-S5: slice 2000 + strip control chars (excepto \n y \t para multiline legítimo).
 */
function sanitizeOperatorMessage(raw) {
    return String(raw || '')
        .slice(0, MESSAGE_MAX_CHARS)
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

/**
 * Devuelve la ruta del archivo `.chat.jsonl` correspondiente a un logFile.
 * Validación anti path-traversal asume que el caller ya pasó por validateLogFileName.
 */
function chatJsonlPath(LOG_DIR, validatedLogFile) {
    return path.join(LOG_DIR, validatedLogFile + '.chat.jsonl');
}

/**
 * Rota el .chat.jsonl si superó CHAT_FILE_ROTATE_BYTES.
 * Política: .chat.jsonl → .chat.jsonl.1 → .chat.jsonl.2 (max retenidos).
 *
 * Idempotente: si el archivo no existe o pesa menos del cap, no hace nada.
 * Best-effort: si falla, log + continúa (no rompe el flow del operador).
 */
function maybeRotateChatFile(chatFile, log) {
    try {
        if (!fs.existsSync(chatFile)) return;
        const stat = fs.statSync(chatFile);
        if (stat.size < CHAT_FILE_ROTATE_BYTES) return;

        // Shift: .chat.jsonl.(N-1) → .chat.jsonl.N
        for (let i = CHAT_FILE_MAX_ROTATIONS - 1; i >= 1; i--) {
            const older = `${chatFile}.${i}`;
            const newer = `${chatFile}.${i - 1}`;
            if (fs.existsSync(newer)) {
                try {
                    if (fs.existsSync(older) && i === CHAT_FILE_MAX_ROTATIONS - 1) {
                        // El más viejo se descarta.
                        fs.unlinkSync(older);
                    }
                    fs.renameSync(newer, older);
                } catch (e) {
                    if (log) log(`agent-chat: rotación falló para ${path.basename(newer)}: ${e.message}`);
                }
            }
        }
        // .chat.jsonl → .chat.jsonl.1
        try {
            fs.renameSync(chatFile, `${chatFile}.1`);
        } catch (e) {
            if (log) log(`agent-chat: rotación falló para ${path.basename(chatFile)}: ${e.message}`);
        }
    } catch (e) {
        if (log) log(`agent-chat: maybeRotateChatFile falló: ${e.message}`);
    }
}

/**
 * Lee body JSON con cap de tamaño. Devuelve via callback.
 */
function readBodyJson(req, cb) {
    let body = '';
    let aborted = false;
    req.on('data', (chunk) => {
        body += chunk;
        if (body.length > BODY_MAX_BYTES) {
            aborted = true;
            req.destroy();
        }
    });
    req.on('end', () => {
        if (aborted) return cb(new Error('body excede cap de tamaño'));
        try { cb(null, body ? JSON.parse(body) : {}); }
        catch (e) { cb(e); }
    });
    req.on('error', (e) => cb(e));
}

/**
 * Mapea códigos del módulo agent-ipc a status HTTP.
 */
function ipcCodeToHttpStatus(code) {
    switch (code) {
        case 'NO_AGENT': return 404;
        case 'AGENT_DEAD': return 410;
        case 'QUEUE_FULL': return 429;
        case 'PIPE_BROKEN': return 410;
        // Issue #3721 — nuevos códigos:
        case 'OPERATOR_DELIMITER_INJECTION': return 400; // CA-SEC-2: rechazo de delimiter injection
        case 'INVALID_PARAMS': return 400;               // CA-SEC-1: path traversal hardening
        case 'AGENT_NOT_COMMUNICABLE': return 412;       // alive en FS pero sin canal IPC
        default: return 500;
    }
}

/**
 * Lee y parsea entries de un .chat.jsonl. Línea-por-línea con try/catch
 * para que una corrupción no rompa todo el render (CA-P5).
 */
function readChatHistory(chatFile) {
    if (!fs.existsSync(chatFile)) return { entries: [], truncated: false };
    let raw;
    try {
        raw = fs.readFileSync(chatFile, 'utf8');
    } catch {
        return { entries: [], truncated: false };
    }
    const lines = raw.split('\n');
    const entries = [];
    let corruptCount = 0;
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            const obj = JSON.parse(trimmed);
            // Mínimo de campos visibles al cliente; omitimos remoteAddress/userAgent
            // que son solo para audit forense local.
            entries.push({
                timestamp: obj.timestamp,
                type: obj.type,
                message_id: obj.message_id,
                message: obj.message,
                author: obj.author || (obj.type === 'operator_message' ? 'operator' : 'agent'),
            });
        } catch {
            corruptCount++;
        }
    }
    return { entries, truncated: false, corruptLines: corruptCount };
}

// -----------------------------------------------------------------------------
// Handlers principales
// -----------------------------------------------------------------------------

/**
 * Punto de entrada único. Dashboard delega aquí cuando ve `/api/agent-chat...`.
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {object} ctx { PIPELINE, LOG_DIR, log }
 */
function handle(req, res, ctx) {
    // CA-S1: loopback gate (común a todos los métodos)
    if (!isLoopbackRemote(req)) {
        const remote = (req.socket && req.socket.remoteAddress) || '';
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, msg: `loopback-only endpoint, got remote=${remote}` }));
        return;
    }
    // CA-S2: Origin/Referer para mutaciones (los GET locales no traen Origin,
    // así que solo bloqueamos cuando el header viene y NO matchea).
    if (!hasValidOrigin(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, msg: 'cross-origin request rejected' }));
        return;
    }

    if (req.method === 'POST' && req.url === '/api/agent-chat') {
        return handlePost(req, res, ctx);
    }
    if (req.method === 'GET' && req.url.startsWith('/api/agent-chat/history')) {
        return handleGetHistory(req, res, ctx);
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, msg: 'agent-chat route not found' }));
}

function handlePost(req, res, ctx) {
    const { LOG_DIR, log } = ctx;

    // CA-S3: Content-Type estricto.
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    if (!ct.startsWith('application/json')) {
        res.writeHead(415, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, msg: 'Content-Type must be application/json' }));
        return;
    }

    readBodyJson(req, (err, body) => {
        if (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, msg: 'invalid JSON body' }));
            return;
        }
        const { issue, skill, fase, message } = body || {};
        if (!issue || !skill) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, msg: 'issue y skill son obligatorios' }));
            return;
        }
        // CA-SEC-1 (issue #3721): validación regex estricta de params ANTES
        // del rate limit y ANTES del isAgentAlive. Rechaza intentos de
        // path traversal en cascada FS de agent-ipc.
        const paramCheck = validateChatParams(body);
        if (!paramCheck.ok) {
            if (log) {
                try {
                    log(`[agent-chat][SEC-1] params inválidos: field=${paramCheck.field} value=${JSON.stringify(body[paramCheck.field])}`);
                } catch (_) { /* nunca bloquear por log */ }
            }
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                ok: false,
                msg: 'invalid params',
                code: 'INVALID_PARAMS',
                field: paramCheck.field,
            }));
            return;
        }

        // CA-F9: validar mensaje no vacío. Cliente ya valida, defensa adicional.
        const sanitized = sanitizeOperatorMessage(message);
        if (!sanitized.trim()) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, msg: 'mensaje vacío' }));
            return;
        }

        // CA-S4: rate limit server-side por (issue, skill, fase).
        const rlKey = `${issue}::${skill}::${fase || ''}`;
        const decision = getRateLimiter().consume(rlKey);
        if (!decision.allowed) {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                ok: false,
                msg: 'rate limit exceeded',
                retryAfterMs: decision.retryAfterMs,
            }));
            return;
        }

        // Issue #3721 — cascada de detección de vida + comunicabilidad.
        // Discriminamos:
        //   - alive=false → 410 (agente terminado de verdad).
        //   - alive=true, communicable=false → 412 (vivo pero canal IPC no
        //     disponible: pulpo reiniciado, skill sin interactive_supported,
        //     o heartbeat huérfano).
        //   - alive=true, communicable=true → continuar con sendMessage.
        const registry = agentIpc.getRegistry();
        const pipeline = (body && body.pipeline) || 'desarrollo';
        const status = registry.getAgentAliveDetails(issue, skill, fase, { pipeline });
        if (!status.alive) {
            res.writeHead(410, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                ok: false,
                msg: 'agente terminado',
                reason: status.reason,
            }));
            return;
        }
        if (!status.communicable) {
            res.writeHead(412, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                ok: false,
                msg: 'agente vivo pero canal IPC no disponible',
                reason: status.reason,
                hint: 'el pulpo puede haber reiniciado, o el skill no tiene interactive_supported:true en agent-models.json (ver #3748)',
            }));
            return;
        }

        // CA-S8: message_id server-derived, NUNCA del cliente.
        const messageId = randomUUID();
        const queuedAt = new Date().toISOString();

        registry.sendMessage(issue, skill, fase, sanitized, { messageId })
            .then((ipcResult) => {
                // CA-P1/P2: persistir en .chat.jsonl con audit enriquecido.
                // Derivamos el logFile del par (issue, skill). El pulpo escribe
                // logs con formato `<issue>-<skill>.log` (ver dashboard.js:564).
                const logFile = skill === 'build' && !fs.existsSync(path.join(LOG_DIR, `${issue}-${skill}.log`))
                    ? `build-${issue}.log`
                    : `${issue}-${skill}.log`;
                const validated = validateLogFileName(logFile);
                if (!validated) {
                    // Inconsistencia: no podemos persistir pero el mensaje ya
                    // se envió. Devolvemos ok=true con warning para que el
                    // operador vea el mensaje en la UI igual.
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        ok: true,
                        status: ipcResult.status || 'sent',
                        queued_at: ipcResult.queued_at || queuedAt,
                        message_id: ipcResult.message_id || messageId,
                        warning: 'no se pudo persistir en .chat.jsonl (logFile no válido)',
                    }));
                    return;
                }
                const chatFile = chatJsonlPath(LOG_DIR, validated);
                const entry = {
                    timestamp: queuedAt,
                    type: 'operator_message',
                    message_id: ipcResult.message_id || messageId,
                    message: redactSensitive(sanitized), // CA-S6
                    author: 'operator',
                    // CA-S8: audit enriquecido (solo en el JSONL, no se devuelve al cliente)
                    remoteAddress: (req.socket && req.socket.remoteAddress) || '',
                    userAgent: String(req.headers['user-agent'] || '').slice(0, 200),
                    requestId: randomUUID(),
                };

                appendChatEntry(chatFile, entry, log)
                    .then(() => {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            ok: true,
                            status: ipcResult.status || 'sent',
                            queued_at: ipcResult.queued_at || queuedAt,
                            message_id: ipcResult.message_id || messageId,
                        }));
                    })
                    .catch((appendErr) => {
                        // Persistencia falló, pero el mensaje ya salió.
                        if (log) log(`agent-chat: append falló: ${appendErr.message}`);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            ok: true,
                            status: ipcResult.status || 'sent',
                            queued_at: ipcResult.queued_at || queuedAt,
                            message_id: ipcResult.message_id || messageId,
                            warning: 'persistencia fallida (mensaje enviado igual)',
                        }));
                    });
            })
            .catch((ipcErr) => {
                const code = ipcErr.code || 'UNKNOWN';
                const status = ipcCodeToHttpStatus(code);
                res.writeHead(status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    ok: false,
                    msg: 'agent-ipc rechazó el mensaje',
                    reason: ipcErr.message,
                    code,
                }));
            });
    });
}

function handleGetHistory(req, res, ctx) {
    const { LOG_DIR } = ctx;
    try {
        const u = new URL(req.url, 'http://localhost');
        const logFile = validateLogFileName(u.searchParams.get('logFile'));
        if (!logFile) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, msg: 'logFile inválido o no provisto' }));
            return;
        }
        const chatFile = chatJsonlPath(LOG_DIR, logFile);
        const result = readChatHistory(chatFile);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            ok: true,
            entries: result.entries,
            corruptLines: result.corruptLines || 0,
        }));
    } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, msg: e.message }));
    }
}

/**
 * Append atómico al .chat.jsonl con file-lock + rotación previa.
 *
 * Returns Promise<void>. Errores propagan para que el endpoint maneje.
 */
async function appendChatEntry(chatFile, entry, log) {
    await withLock(chatFile, async () => {
        // Rotación previa: si el archivo está a punto de superar el cap, lo
        // rotamos ANTES del append para no dejar archivos > cap.
        maybeRotateChatFile(chatFile, log);
        const line = JSON.stringify(entry) + '\n';
        await fs.promises.appendFile(chatFile, line, 'utf8');
    }, { component: 'agent-chat' });
}

module.exports = {
    handle,
    // Para tests
    validateLogFileName,
    validateChatParams,
    sanitizeOperatorMessage,
    readChatHistory,
    appendChatEntry,
    chatJsonlPath,
    maybeRotateChatFile,
    ipcCodeToHttpStatus,
    isLoopbackRemote,
    hasValidOrigin,
    CHAT_FILE_ROTATE_BYTES,
    CHAT_FILE_MAX_ROTATIONS,
    MESSAGE_MAX_CHARS,
};

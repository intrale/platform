// =============================================================================
// telegram-notifier.js — Handler proactivo de notificaciones al operador (Leo)
// Issue #3384
//
// Responsabilidad
// ---------------
// Cuando el skill `/ux` cierra el modo `screenshot-mockup` y adjunta el PNG
// del "estado esperado" al issue (#3381 Caso A dashboard / #3382 Caso B
// Android), este módulo envía el PNG por Telegram al chat del operador
// (`telegram.leo_operator_chat_id` en credentials.json) para que Leo lo vea
// desde el celular sin tener que abrir GitHub.
//
// API pública
// -----------
//   notifyMockupToOperator({ issueNumber, issueTitle, caseType, mockupPath,
//                             changeDescription, repoRoot, deps })
//     → Promise<{ ok, action, reason?, ... }>
//
// Diseño
// ------
//   * Fire-and-forget: nunca propaga excepciones (CA-F-9 fail-soft).
//   * Timeout total 5s. Si vence → warning + continuar sin bloquear.
//   * Rate-limit 1 msg/s (CA-F-10) por proceso — mutex con timestamp.
//   * NO retry por default (CA-S-5 explícito: el log basta).
//
// Defensa
// -------
//   * `redact.redactUrlLike` antes de escribir CUALQUIER mensaje al log
//     (CA-S-1, fix histórico CA-11.1 / #2332).
//   * `mockupPath`: resolve dentro de `pipelineRoot`, extensión `.png`,
//     `lstatSync` no-symlink, size < 10MB (CA-S-2).
//   * Sin `parse_mode` (caption en texto plano) → cero superficie de
//     prompt-injection (CA-S-3).
//   * `chat_id` NO aparece en logs ni en mensajes de error (CA-S-4).
//   * PNG leído a Buffer **antes** del envío para evitar TOCTOU (CA-S-6).
//
// UX del operador (CA-UX-1..6)
// ----------------------------
//   * Título truncado a 60 chars antes de armar el caption.
//   * Descripción truncada a 600 chars.
//   * Emoji canónico por caseType.
//   * Última línea: link al issue (Telegram auto-linkea).
//   * Footer "Mockup generado automáticamente · fase de definición".
//   * PNG > 1.5MB → compresión con `sharp` si está disponible (warning
//     + envío sin comprimir si no lo está).
//
// Auto-disable
// ------------
//   Si `TELEGRAM_LEO_OPERATOR_CHAT_ID` no está seteado en env (cargado por
//   `credentials.loadIntoEnv` desde `~/.claude/secrets/credentials.json`
//   `telegram.leo_operator_chat_id`), la función devuelve
//   `{ ok: false, action: 'skipped', reason: 'no_operator_chat_id' }`
//   sin enviar nada — el operador todavía no configuró el chat (default
//   CA-F-8).
// =============================================================================

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const httpClient = require('./http-client');
const { redactUrlLike } = require('./redact');

// -----------------------------------------------------------------------------
// Constantes (CA-UX-2, CA-S-2, CA-F-9, CA-F-10, CA-UX-1, CA-UX-5, CA-UX-6)
// -----------------------------------------------------------------------------

/**
 * Mapping emoji ↔ caseType (CA-UX-2). Exportado como constante para que
 * `/ux` y los tests usen el mismo set.
 */
const CASE_EMOJI = Object.freeze({
    'dashboard': '🖥',
    'android-client': '📱',
    'android-business': '🏪',
    'android-delivery': '🛵',
});

const VALID_CASE_TYPES = Object.freeze(Object.keys(CASE_EMOJI));

const MAX_TITLE_CHARS = 60;        // CA-UX-1
const MAX_DESCRIPTION_CHARS = 600; // CA-UX-5
const MAX_CAPTION_CHARS = 1024;    // Cap duro de Telegram
const MAX_PNG_BYTES = 10 * 1024 * 1024;          // CA-S-2 (10 MB)
const COMPRESS_THRESHOLD_BYTES = 1_500_000;       // CA-UX-6 (1.5 MB)
const TIMEOUT_MS = 5000;           // CA-F-9
const RATE_LIMIT_MS = 1000;        // CA-F-10
const TELEGRAM_API_BASE = 'https://api.telegram.org';
const AGENT_TAG = 'telegram-notifier';

// -----------------------------------------------------------------------------
// Rate-limit state (1 msg/s por proceso — CA-F-10)
// -----------------------------------------------------------------------------

let _lastSendTs = 0;

async function applyRateLimit(now = Date.now()) {
    const elapsed = now - _lastSendTs;
    if (elapsed < RATE_LIMIT_MS) {
        const wait = RATE_LIMIT_MS - elapsed;
        await new Promise((r) => setTimeout(r, wait));
    }
    _lastSendTs = Date.now();
}

function _resetRateLimit() {
    _lastSendTs = 0;
}

// -----------------------------------------------------------------------------
// Logging defensivo (CA-S-1, CA-S-4)
// -----------------------------------------------------------------------------

/**
 * Escribe `msg` al log de fallos del notifier aplicando `redactUrlLike()`
 * antes (CA-S-1) y removiendo cualquier mención del `chat_id` (CA-S-4).
 * `chat_id` se reemplaza por `<chat_id>` para preservar contexto sin
 * filtrar el identificador personal del operador.
 *
 * Fail-soft: si el log no se puede abrir/escribir, no propaga.
 *
 * @param {string} logPath     ruta absoluta al .log
 * @param {string} msg         mensaje crudo (puede contener URL con token)
 * @param {string|null} chatId chat_id a remover del mensaje (opcional)
 */
function appendNotifierLog(logPath, msg, chatId) {
    try {
        const ts = new Date().toISOString();
        let redacted = redactUrlLike(String(msg));
        if (chatId) {
            const re = new RegExp(escapeRegExp(String(chatId)), 'g');
            redacted = redacted.replace(re, '<chat_id>');
        }
        const line = `[${ts}] [telegram-notifier] ${redacted}\n`;
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        fs.appendFileSync(logPath, line, 'utf8');
    } catch {
        // Fail-soft: si no podemos loguear, el caller igual recibe
        // `{ ok: false, ... }` y el pipeline sigue.
    }
}

function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// -----------------------------------------------------------------------------
// Validación del path del mockup (CA-S-2)
// -----------------------------------------------------------------------------

/**
 * Valida `mockupPath` antes de leerlo. Rechaza:
 *   - vacío / non-string
 *   - null byte (path traversal trick clásico)
 *   - segmento `..` (antes del resolve)
 *   - paths fuera de `pipelineRoot`
 *   - symlinks (lstat.isSymbolicLink)
 *   - extensión != `.png` (case-insensitive)
 *   - tamaño > 10MB
 *
 * Devuelve `{ ok, absolute?, size?, reason? }`. NUNCA tira excepción.
 */
function validateMockupPath(candidate, pipelineRoot) {
    if (typeof candidate !== 'string' || candidate.length === 0) {
        return { ok: false, reason: 'empty_path' };
    }
    if (candidate.indexOf('\0') >= 0) {
        return { ok: false, reason: 'null_byte' };
    }
    // `..` lexical (path.resolve los colapsa y se pierde el motivo).
    const segments = candidate.split(/[\/\\]+/);
    if (segments.some((s) => s === '..')) {
        return { ok: false, reason: 'parent_segment' };
    }
    if (typeof pipelineRoot !== 'string' || pipelineRoot.length === 0) {
        return { ok: false, reason: 'no_pipeline_root' };
    }
    const absRoot = path.resolve(pipelineRoot);
    const absCandidate = path.isAbsolute(candidate)
        ? path.resolve(candidate)
        : path.resolve(absRoot, candidate);
    const inside = absCandidate === absRoot
        || absCandidate.startsWith(absRoot + path.sep);
    if (!inside) {
        return { ok: false, reason: 'outside_repo' };
    }
    // Extensión `.png` (case-insensitive) — CA-S-2.
    if (!/\.png$/i.test(absCandidate)) {
        return { ok: false, reason: 'invalid_extension' };
    }
    // lstat: no-symlink + tamaño + existencia.
    let stat;
    try {
        stat = fs.lstatSync(absCandidate);
    } catch (e) {
        return { ok: false, reason: 'stat_failed', detail: e.code || 'unknown' };
    }
    if (stat.isSymbolicLink()) {
        return { ok: false, reason: 'symlink_rejected' };
    }
    if (!stat.isFile()) {
        return { ok: false, reason: 'not_a_file' };
    }
    if (stat.size > MAX_PNG_BYTES) {
        return { ok: false, reason: 'too_large', size: stat.size };
    }
    if (stat.size === 0) {
        return { ok: false, reason: 'empty_file' };
    }
    return { ok: true, absolute: absCandidate, size: stat.size };
}

// -----------------------------------------------------------------------------
// Helpers de formato (CA-UX-1, CA-UX-5)
// -----------------------------------------------------------------------------

function shortenWithEllipsis(text, max) {
    if (typeof text !== 'string') return '';
    const oneLine = text.replace(/\s+/g, ' ').trim();
    if (oneLine.length <= max) return oneLine;
    return oneLine.slice(0, max - 1).trimEnd() + '…';
}

/**
 * Construye el caption final, en texto plano (CA-S-3 sin parse_mode).
 *
 * Formato (ver CA-UX-1..5 + caption de referencia en el issue):
 *
 *   🖼 #<N> — <título truncado 60 chars>
 *   <emoji caso> <caseType>
 *
 *   <descripción truncada 600 chars>
 *
 *   Mockup generado automáticamente · fase de definición
 *   🔗 https://github.com/intrale/platform/issues/<N>
 *
 * Si el caption final excede `MAX_CAPTION_CHARS`, se trunca con `…`
 * defensivo (no debería pasar dado los caps individuales pero es una
 * defensa adicional contra inputs degenerados).
 */
function buildCaption({ issueNumber, issueTitle, caseType, changeDescription }) {
    const title = shortenWithEllipsis(issueTitle || '', MAX_TITLE_CHARS);
    const desc = shortenWithEllipsis(changeDescription || '', MAX_DESCRIPTION_CHARS);
    const emoji = CASE_EMOJI[caseType] || '📦';

    const lines = [
        `🖼 #${issueNumber} — ${title}`,
        `${emoji} ${caseType}`,
        '',
        desc || '(sin descripción del cambio)',
        '',
        'Mockup generado automáticamente · fase de definición',
        `🔗 https://github.com/intrale/platform/issues/${issueNumber}`,
    ];
    let caption = lines.join('\n');
    if (caption.length > MAX_CAPTION_CHARS) {
        caption = caption.slice(0, MAX_CAPTION_CHARS - 1) + '…';
    }
    return caption;
}

// -----------------------------------------------------------------------------
// Compresión opcional con sharp (CA-UX-6)
// -----------------------------------------------------------------------------

/**
 * Si el buffer pesa > 1.5MB y `sharp` está disponible, devuelve un buffer
 * recomprimido (PNG → PNG con `compressionLevel: 9`). Si `sharp` no está
 * instalado, devuelve el buffer original y deja un warning en `logFn`.
 * No baja resolución (CA-UX-6).
 *
 * @param {Buffer} buf
 * @param {(msg: string) => void} logFn
 * @param {object} [deps] inyectable para tests: { sharp }
 */
async function maybeCompress(buf, logFn, deps) {
    if (!Buffer.isBuffer(buf) || buf.length <= COMPRESS_THRESHOLD_BYTES) {
        return buf;
    }
    let sharpLib = deps && deps.sharp;
    if (!sharpLib) {
        try { sharpLib = require('sharp'); }
        catch {
            logFn(`PNG ${buf.length} bytes > umbral ${COMPRESS_THRESHOLD_BYTES} pero sharp no esta instalado; enviando sin comprimir (CA-UX-6 fail-soft).`);
            return buf;
        }
    }
    try {
        const out = await sharpLib(buf).png({ compressionLevel: 9 }).toBuffer();
        // Si sharp no logra reducir, devolvemos el original para no inflar.
        if (out.length < buf.length) return out;
        return buf;
    } catch (e) {
        logFn(`Fallo de compresion sharp: ${(e && e.message) || e}. Enviando sin comprimir.`);
        return buf;
    }
}

// -----------------------------------------------------------------------------
// Envío multipart al API Telegram (CA-F-5)
// -----------------------------------------------------------------------------

/**
 * Arma el body multipart y dispara `sendPhoto` al Bot API. Devuelve
 * `{ ok, statusCode, body }` o tira `{ code, message }` (lo captura el
 * caller).
 *
 * @param {object} args
 * @param {string} args.botToken
 * @param {string} args.chatId
 * @param {Buffer} args.photoBuf
 * @param {string} args.filename
 * @param {string} args.caption
 * @param {object} [args.deps]
 *   - `deps.http`: cliente con la misma firma que `httpClient.request`
 *     (override para tests sin red).
 */
async function sendPhotoMultipart(args) {
    const { botToken, chatId, photoBuf, filename, caption, deps } = args;
    const boundary = '----PipelineV3Notifier' + Date.now() + '-' + Math.random().toString(36).slice(2);

    const safeFilename = path.basename(filename || 'mockup.png').replace(/[\r\n"]/g, '');

    const prologueParts = [
        `--${boundary}`,
        `Content-Disposition: form-data; name="chat_id"`,
        ``,
        String(chatId),
        `--${boundary}`,
        `Content-Disposition: form-data; name="caption"`,
        ``,
        caption,
        `--${boundary}`,
        `Content-Disposition: form-data; name="photo"; filename="${safeFilename}"`,
        `Content-Type: image/png`,
        ``,
        '',
    ];
    const prologue = Buffer.from(prologueParts.join('\r\n'));
    const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`);
    const bodyBuf = Buffer.concat([prologue, photoBuf, epilogue]);

    const url = `${TELEGRAM_API_BASE}/bot${botToken}/sendPhoto`;
    const httpFn = (deps && typeof deps.http === 'function') ? deps.http : httpClient.request;

    const res = await httpFn(url, {
        method: 'POST',
        body: bodyBuf,
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        agentTag: AGENT_TAG,
        timeout: TIMEOUT_MS,
        // CA-S-5 default: NO retry (Telegram no es idempotente para sendPhoto).
        retryable: false,
    });
    return res;
}

// -----------------------------------------------------------------------------
// Settings (CA-F-8) — lectura opcional de `.claude/settings.json`
// -----------------------------------------------------------------------------

/**
 * Lee `.claude/settings.json` desde `repoRoot` y devuelve el valor de
 * `telegram.notify_ux_mockups`. Si el archivo no existe o no tiene la
 * clave, devuelve `null` → el caller aplica el default (true si hay
 * chat_id).
 */
function readNotifyEnabledSetting(repoRoot) {
    const settingsPath = path.join(repoRoot, '.claude', 'settings.json');
    try {
        const raw = fs.readFileSync(settingsPath, 'utf8');
        const json = JSON.parse(raw);
        if (json && json.telegram && typeof json.telegram.notify_ux_mockups === 'boolean') {
            return json.telegram.notify_ux_mockups;
        }
    } catch {
        // No existe / no parsea → default.
    }
    return null;
}

// -----------------------------------------------------------------------------
// API pública: notifyMockupToOperator
// -----------------------------------------------------------------------------

/**
 * Notifica al operador (Leo) por Telegram con el PNG del mockup esperado.
 *
 * @param {object} args
 * @param {number|string} args.issueNumber        — número del issue de GitHub
 * @param {string}        args.issueTitle         — título del issue
 * @param {string}        args.caseType           — uno de VALID_CASE_TYPES
 * @param {string}        args.mockupPath         — path al PNG generado por LLM
 * @param {string}        args.changeDescription  — texto que describe el cambio
 * @param {string}        [args.repoRoot]         — root del repo; default
 *                                                  process.env.PIPELINE_REPO_ROOT
 *                                                  || process.cwd()
 * @param {object}        [args.deps]             — inyección para tests
 *   - `deps.now`      : () => number (Date.now override)
 *   - `deps.env`      : object (process.env override)
 *   - `deps.http`     : función con firma de httpClient.request
 *   - `deps.sharp`    : módulo sharp (si null, se intenta require('sharp'))
 *   - `deps.logFile`  : path absoluto al log de fallos (override)
 *   - `deps.applyRateLimit`: async () => void (override)
 *
 * @returns {Promise<{ok: boolean, action: 'sent'|'skipped'|'error', reason?: string, statusCode?: number}>}
 *
 * Nunca propaga excepciones (CA-F-9). El caller (`/ux`) puede ignorar el
 * resultado tranquilo: el cierre del issue no depende de esto.
 */
async function notifyMockupToOperator(args = {}) {
    const {
        issueNumber,
        issueTitle,
        caseType,
        mockupPath,
        changeDescription,
    } = args;
    const deps = args.deps || {};
    const env = deps.env || process.env;
    const repoRoot = args.repoRoot
        || env.PIPELINE_REPO_ROOT
        || env.CLAUDE_PROJECT_DIR
        || process.cwd();
    const logPath = deps.logFile
        || path.join(repoRoot, '.pipeline', 'logs', 'telegram-notifier.log');

    const logFn = (m) => appendNotifierLog(logPath, m, env.TELEGRAM_LEO_OPERATOR_CHAT_ID);

    // Validar args sin tirar.
    try {
        // CA-F-2 caseType
        if (!VALID_CASE_TYPES.includes(caseType)) {
            logFn(`Invocación rechazada: caseType inválido (${caseType})`);
            return { ok: false, action: 'skipped', reason: 'invalid_case_type' };
        }
        const issueNum = Number.parseInt(issueNumber, 10);
        if (!Number.isFinite(issueNum) || issueNum <= 0) {
            return { ok: false, action: 'skipped', reason: 'invalid_issue_number' };
        }

        // CA-F-8 — settings.json override (false → skip explícito).
        const settingsValue = readNotifyEnabledSetting(repoRoot);
        if (settingsValue === false) {
            return { ok: false, action: 'skipped', reason: 'disabled_in_settings' };
        }

        // Credenciales (CA-F-6).
        const botToken = env.TELEGRAM_BOT_TOKEN;
        const chatId = env.TELEGRAM_LEO_OPERATOR_CHAT_ID;
        if (!botToken) {
            // Sin token → no podemos enviar. Default: auto-skip silencioso.
            return { ok: false, action: 'skipped', reason: 'no_bot_token' };
        }
        if (!chatId) {
            // CA-F-8 default: si no está la credencial, auto-disable.
            return { ok: false, action: 'skipped', reason: 'no_operator_chat_id' };
        }

        // CA-S-2 — validar el path del PNG.
        const validation = validateMockupPath(mockupPath, repoRoot);
        if (!validation.ok) {
            logFn(`mockupPath inválido (${validation.reason}): ${mockupPath}`);
            return { ok: false, action: 'skipped', reason: `invalid_mockup_path:${validation.reason}` };
        }

        // CA-S-6 — leer a Buffer YA (sin TOCTOU).
        let photoBuf;
        try {
            photoBuf = fs.readFileSync(validation.absolute);
        } catch (e) {
            logFn(`No se pudo leer mockupPath: ${e.code || e.message}`);
            return { ok: false, action: 'skipped', reason: 'read_failed' };
        }
        if (photoBuf.length > MAX_PNG_BYTES) {
            return { ok: false, action: 'skipped', reason: 'too_large_after_read' };
        }

        // CA-UX-6 — compresión opcional si >1.5MB.
        photoBuf = await maybeCompress(photoBuf, logFn, deps);

        // CA-UX-1..5 — caption.
        const caption = buildCaption({
            issueNumber: issueNum,
            issueTitle,
            caseType,
            changeDescription,
        });

        // CA-F-10 — rate-limit 1 msg/s.
        const rateLimit = (deps && typeof deps.applyRateLimit === 'function')
            ? deps.applyRateLimit
            : applyRateLimit;
        await rateLimit();

        // CA-F-5 + CA-F-9 — envío con timeout 5s.
        try {
            const res = await sendPhotoMultipart({
                botToken,
                chatId,
                photoBuf,
                filename: path.basename(validation.absolute),
                caption,
                deps,
            });
            const statusCode = res && (res.statusCode || (res.status && Number(res.status)));
            const okStatus = statusCode === 200 || statusCode === 201;
            if (!okStatus) {
                let bodyExcerpt = '';
                try {
                    bodyExcerpt = typeof res.body === 'string'
                        ? res.body.slice(0, 200)
                        : (Buffer.isBuffer(res.body) ? res.body.toString('utf8').slice(0, 200) : '');
                } catch {}
                logFn(`Telegram respondió status ${statusCode}: ${bodyExcerpt}`);
                return { ok: false, action: 'error', reason: 'telegram_non_2xx', statusCode };
            }
            return { ok: true, action: 'sent', statusCode };
        } catch (e) {
            // CA-S-1: el message PUEDE contener la URL con el token. `logFn`
            // ya pasa por `redactUrlLike` antes de escribir.
            const msg = (e && e.message) || String(e);
            const code = e && e.code;
            logFn(`Fallo de envío (${code || 'unknown'}): ${msg}`);
            return { ok: false, action: 'error', reason: code || 'send_failed' };
        }
    } catch (e) {
        // CA-F-9 último fallback: nunca propagar.
        try { logFn(`Error inesperado en notifyMockupToOperator: ${(e && e.message) || e}`); } catch {}
        return { ok: false, action: 'error', reason: 'unexpected' };
    }
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = {
    // API pública
    notifyMockupToOperator,

    // Constantes (consumidas por /ux y tests)
    CASE_EMOJI,
    VALID_CASE_TYPES,
    MAX_TITLE_CHARS,
    MAX_DESCRIPTION_CHARS,
    MAX_CAPTION_CHARS,
    MAX_PNG_BYTES,
    COMPRESS_THRESHOLD_BYTES,
    TIMEOUT_MS,
    RATE_LIMIT_MS,

    // Internos exportados para tests (no son contrato público).
    __forTests__: {
        validateMockupPath,
        buildCaption,
        shortenWithEllipsis,
        maybeCompress,
        appendNotifierLog,
        readNotifyEnabledSetting,
        applyRateLimit,
        _resetRateLimit,
        sendPhotoMultipart,
    },
};

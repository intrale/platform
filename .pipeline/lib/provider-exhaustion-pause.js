// =============================================================================
// provider-exhaustion-pause.js — Pausa y reanudación del Pulpo cuando primary +
// todos los fallbacks de un skill quedan gated por cuota (#3259).
//
// Issue padre: #3259 — garantizar continuidad del Pulpo ante caída de Claude.
// Hermanos arquitecturales: #3198 (consumer runtime fallbacks),
// #2974/#3077 (detector de cuota multi-provider).
//
// RESPONSABILIDAD
//   1. CA-4: cuando `resolveSpawnWithFallback` reporta `gated`, este módulo:
//        a) Aplica la label `provider-exhaustion-pause` al issue (idempotente).
//        b) Encola mensaje Telegram en `.pipeline/servicios/telegram/pendiente/`
//           con detalle sanitizado (sin secrets, con link al issue, chain
//           intentada y ETA).
//        c) Persiste un marker en `.pipeline/state/exhaustion-notified/<issue>.json`
//           para dedupe de notificaciones (CA-9).
//   2. CA-9: dedupe del Telegram — re-notifica sólo si pasaron >2h desde la
//      última o si el set de providers gated cambió.
//   3. CA-10: cuando la cuota de algún provider se libera, este módulo:
//        a) Detecta issues con label `provider-exhaustion-pause` aún abiertos.
//        b) Quita la label.
//        c) Borra el marker `state/exhaustion-notified/<issue>.json`.
//        d) Encola mensaje Telegram "destrabado".
//
// REUSAR PRIMITIVAS (mandato PO / security):
//   - `lib/quota-exhausted.js`: lectura/audit del flag, scope per-provider.
//   - `lib/telegram-secrets.js` no — el módulo no llama Telegram API directo.
//     Encolamos en filesystem queue; `servicio-telegram.js` drena.
//   - `lib/redact.js`: sanitización de raw_excerpt antes de loguear.
//   - `lib/audit-log.js`: append con hash-chain para el evento
//     `provider-exhaustion-pause`.
//
// SEGURIDAD (revisión security del issue):
//   - Validación estricta del `issue` (Number.isInteger > 0) antes de
//     invocar `gh issue edit`.
//   - `gh` invocado con `spawnSync` + array de args (NO shell concat).
//   - Telegram body sanitizado por `sanitize` + redactSensitive. Strip
//     control chars / ANSI. Hard cap 4000 bytes (límite Telegram + margen).
//   - El marker `state/exhaustion-notified/<issue>.json` se escribe atomic
//     vía rename desde tmp/, mode 0o600.
//   - Retry interval con piso hardcoded 60s (`MIN_RETRY_INTERVAL_MS`) aunque
//     config.yaml pida menos — defensa contra DoS implícito de providers.
//
// IDEMPOTENCIA:
//   - `applyLabel`: lee labels con `gh issue view --json labels` antes de
//     `--add-label`. Doble add es no-op del lado de GitHub también, pero
//     evitamos roundtrip innecesario.
//   - `notifyTelegram`: revisa marker antes de encolar. Re-notifica si
//     `Date.now() - marker.last_notified_ms > NOTIFY_RENOTIFY_MS` (2h) o si
//     `chain_tried` cambió.
//   - `clearLabel`: el `gh --remove-label` es idempotente del lado GitHub.
//     Borrar el marker es `fs.unlinkSync` con `ENOENT` silenciado.
//
// HASH-CHAIN AUDIT (mandato security):
//   - Evento `provider-exhaustion-pause` registrado vía `lib/audit-log.js`
//     en `logs/exhaustion-pause-YYYY-MM-DD.jsonl`.
//   - Cada entrada incluye: ts, event, skill, issue, primary_provider,
//     chain_tried, prev_hash, hash.
//
// Sin dependencias npm nuevas (Node puro: fs, path, child_process).
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Carga defensiva de primitivas. Si alguno falla (paths legacy), degradamos
// a no-op para que el pipeline siga corriendo — `provider-exhaustion-pause`
// es accesorio, no debe tumbar el barrido.
let redactLib = null;
try { redactLib = require('./redact'); } catch { /* opcional */ }

let sanitizerLib = null;
try { sanitizerLib = require('../sanitizer'); } catch { /* opcional */ }

let auditLogLib = null;
try { auditLogLib = require('./audit-log'); } catch { /* opcional */ }

let quotaModule = null;
try { quotaModule = require('./quota-exhausted'); } catch { /* opcional */ }

// Loader de `agent-models.json` (#3498). Fuente única para humanizar los hints
// de quota en el mensaje Telegram. Si no carga, `getQuotaHint` degrada a
// fallback genérico — el barrido nunca se cae por un loader opcional.
let agentModelsLib = null;
try { agentModelsLib = require('./agent-models'); } catch { /* opcional */ }

// Clasificador de causa de pausa (#5467). Devuelve la categoría gruesa
// (reposo|cuota|auth|transitoria) + desglose por provider, leyendo SÓLO
// archivos locales. Si no carga, `formatExhaustionMessage` degrada al mensaje
// sin desglose — nunca se cae.
let pauseCauseLib = null;
try { pauseCauseLib = require('./provider-pause-cause'); } catch { /* opcional */ }

// Escapador de Markdown legacy (CA-9 / SEC-2). `sanitizeForTelegram` redacta
// secretos y control chars pero NO escapa Markdown, y el envío usa
// `parse_mode: 'Markdown'` (`servicio-telegram.js:836`). Todo valor derivado de
// datos (label del snapshot, título del issue) se escapa antes de interpolar:
// un `_` suelto tumba el mensaje entero con `400 can't parse entities` (#5173),
// y un mensaje de pausa que falla al enviarse es exactamente el fallo que
// #5467 viene a evitar.
let escapeMarkdownLegacy = (s) => String(s);
try {
    const cs = require('./config-schema');
    if (typeof cs.escapeMarkdownLegacy === 'function') escapeMarkdownLegacy = cs.escapeMarkdownLegacy;
} catch { /* opcional — identidad como fallback */ }

// -----------------------------------------------------------------------------
// Constantes (todas configurables vía opts del caller para tests + flex)
// -----------------------------------------------------------------------------

// Label aplicada/removida en GitHub. Single source of truth.
const EXHAUSTION_LABEL = 'provider-exhaustion-pause';

// Repo target. Hardcoded por defensa: NUNCA aceptar repo dinámico desde
// caller (vector de path injection en gh args).
const GH_REPO = 'intrale/platform';

// Cap del comentario Telegram (límite real es 4096; dejamos margen).
const TELEGRAM_MAX_BYTES = 4000;

// Re-notificación: si pasó más de 2h desde la última o si el set de
// providers gated cambió, volvemos a notificar (CA-9).
const NOTIFY_RENOTIFY_MS = 2 * 60 * 60 * 1000;

// Piso hardcoded del retry interval. El config.yaml puede aumentar pero
// nunca bajar — defensa contra DoS implícito de providers free.
const MIN_RETRY_INTERVAL_MS = 60 * 1000;
const DEFAULT_RETRY_INTERVAL_MS = 5 * 60 * 1000;

// Subdir donde se encolan los Telegram messages.
const TELEGRAM_QUEUE_SUBDIR = path.join('servicios', 'telegram', 'pendiente');

// Subdir de markers de notificación. Una entrada por issue.
const NOTIFY_MARKER_SUBDIR = path.join('state', 'exhaustion-notified');

// Hints humanizados por provider (#3498).
//
// Fuente única de verdad: `agent-models.json#providers.<id>.quota_error_types`.
// Antes (rebote 0 de #3259) esto era una tabla `KNOWN_HINTS_BY_PROVIDER`
// hardcoded — quedaba en drift con `agent-models.json` (incidente Ola N+10
// 2026-05-26: el hint Telegram no reflejaba `snapshot_threshold_90` aunque
// estaba en el JSON). #3498 cierra esa deuda derivando el hint del JSON con
// `getQuotaHint(provider, opts)`.
//
// Constantes del helper:
const QUOTA_HINT_FALLBACK = 'quota_exhausted';
const QUOTA_HINT_FALLBACK_DEGRADED = 'quota_exhausted (config indisponible)';
// Cap defensivo — invariante de seguridad (CA-9 / SEC-1):
//   1) Previene DoS por mensaje > 4096 bytes (límite Telegram).
//   2) Mantiene legibilidad de la línea del operador (UX-1).
// Cap aplicado ANTES del `.join(' / ')`.
const QUOTA_HINT_MAX_ELEMENTS = 5;

// --- Titulares por causa (#5467) --------------------------------------------
//
// UX-6 (adoptado): UN SOLO titular para todo lo que no es reposo. El titular es
// lo único que se ve en la notificación colapsada del lock screen; que cambie
// de texto según la causa obliga al operador a aprender varios titulares para
// la misma decisión ("¿abro o no?"), y reabre el problema original apenas
// aparezca una quinta causa.
//
// Con esta lectura CA-2 se cumple de forma trivial y verificable: la cadena
// "cuota agotada" NUNCA aparece en el titular. La causa concreta vive en el
// veredicto y en el desglose, que es donde el operador la puede accionar.
const HEADER_REPOSO = '🌙 *Pipeline en pausa programada*';
const HEADER_SIN_PROVIDER = '🟧 *Pipeline pausado — sin proveedor disponible*';

// Tope de proveedores en el desglose (UX-4). Seis es el número que sostiene el
// escaneo en móvil; con la cadena real de 5 nunca se alcanza.
const BREAKDOWN_MAX_PROVIDERS = 6;

// Largo máximo de una línea del desglose para no envolver en Telegram móvil
// (UX-4). Si el `label` no entra, se usa el id del proveedor, que es más corto.
const BREAKDOWN_MAX_LINE_CHARS = 46;

// -----------------------------------------------------------------------------
// Path helpers
// -----------------------------------------------------------------------------

function pipelineDir(opts = {}) {
    if (opts.pipelineDir) return opts.pipelineDir;
    if (process.env.PIPELINE_DIR_OVERRIDE) return process.env.PIPELINE_DIR_OVERRIDE;
    return path.resolve(__dirname, '..');
}

function notifyMarkerFile(issue, opts = {}) {
    return path.join(pipelineDir(opts), NOTIFY_MARKER_SUBDIR, `${issue}.json`);
}

function telegramQueueDir(opts = {}) {
    return path.join(pipelineDir(opts), TELEGRAM_QUEUE_SUBDIR);
}

function exhaustionAuditFile(opts = {}, now = new Date()) {
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    return path.join(pipelineDir(opts), 'logs', `exhaustion-pause-${yyyy}-${mm}-${dd}.jsonl`);
}

// -----------------------------------------------------------------------------
// Validación y sanitización
// -----------------------------------------------------------------------------

/**
 * Valida que `issue` sea un int positivo. Vector de injection si dejáramos
 * pasar strings con espacios o shell metacharacters al `gh issue edit`.
 */
function isValidIssue(issue) {
    if (typeof issue === 'number') return Number.isInteger(issue) && issue > 0;
    if (typeof issue === 'string') return /^\d+$/.test(issue) && Number(issue) > 0;
    return false;
}

/**
 * Aplica sanitización en capas:
 *   1. `lib/redact.js`: redacta JSON keys sensibles, emails, paths absolutos.
 *   2. `sanitizer`: limpia control chars / ANSI / chars hostiles a Markdown.
 *   3. Hard cap a `TELEGRAM_MAX_BYTES`.
 */
function sanitizeForTelegram(text) {
    if (text == null) return '';
    let str = String(text);
    if (redactLib && typeof redactLib.redactSensitive === 'function') {
        try { str = String(redactLib.redactSensitive(str)); } catch { /* best-effort */ }
    }
    if (sanitizerLib && typeof sanitizerLib.sanitize === 'function') {
        try { str = String(sanitizerLib.sanitize(str)); } catch { /* best-effort */ }
    }
    // Strip control chars (CWE-117 + Markdown injection defense).
    str = str.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '');
    if (Buffer.byteLength(str, 'utf8') > TELEGRAM_MAX_BYTES) {
        // El cap es en BYTES pero `String.slice` corta por CARACTERES. Con el
        // mensaje lleno de emojis, tildes y em dashes (2-4 bytes cada uno), un
        // slice de 3968 caracteres puede pesar varios miles de bytes de más y
        // Telegram rechazar el envío entero — dejando al operador sin el aviso
        // de pausa, que es justo el fallo que #5467 viene a evitar.
        //
        // Cortamos sobre el Buffer y limpiamos el reemplazo U+FFFD que deja una
        // secuencia UTF-8 partida al final.
        const suffix = '\n[... truncado]';
        const budget = TELEGRAM_MAX_BYTES - Buffer.byteLength(suffix, 'utf8');
        const head = Buffer.from(str, 'utf8').subarray(0, budget).toString('utf8');
        str = head.replace(/�+$/, '') + suffix;
    }
    return str;
}

// -----------------------------------------------------------------------------
// Quota hint helper (#3498) — derivado de agent-models.json#quota_error_types
// -----------------------------------------------------------------------------

// Cache memoizado lazy del config validado.
//   `null` = todavía no se intentó cargar (estado virgen del proceso).
//   Objeto literal `{}` = se intentó cargar y falló — modo degradado.
//   Objeto con `providers` = cargado OK.
// Pulpo se reinicia con `restart.js` y no hace hot-reload, así que una sola
// carga por vida de proceso es coherente (CA-6).
let _quotaHintsCache = null;
let _quotaHintsLoadFailed = false;
let _quotaHintsWarningEmitted = false;

/**
 * Sanitiza un elemento individual de `quota_error_types` antes del join.
 * Defense in depth sobre `sanitizeForTelegram` (que se aplica al mensaje
 * completo aguas abajo). Elimina caracteres Markdown que podrían romper
 * el render Telegram o inyectar links (CA-10 / SEC-2 / UX-4).
 *
 * Nota deliberada de diseño: el underscore (`_`) NO se elimina aunque sea
 * el marcador de italic en Markdown. Los identificadores en
 * `quota_error_types` son snake_case (`usage_limit_error`,
 * `weekly_quota_exhausted`, etc.) y eliminarlo destruiría el contenido que
 * el operador necesita leer — esto pisaría CA-14 (anti-regresión del
 * wording vs el hardcoded previo). El render italic ocasional no abre
 * vector de injection (no inyecta links, no levanta scripts) y la baseline
 * del módulo lo viene tolerando desde #3259. Los chars realmente
 * peligrosos (`*`, backtick, `[`, `]`, `(`, `)`) sí se filtran.
 */
function sanitizeHintElement(s) {
    return String(s == null ? '' : s).replace(/[*`\[\]()]/g, '');
}

function _logQuotaHintWarning(opts) {
    if (_quotaHintsWarningEmitted) return;
    _quotaHintsWarningEmitted = true;
    const logger = (opts && opts.logger) || console;
    try {
        if (logger && typeof logger.warn === 'function') {
            logger.warn('[provider-exhaustion-pause] agent-models.json no disponible o corrupto — getQuotaHint cae a fallback genérico');
        }
    } catch { /* logger inválido — silenciar */ }
}

/**
 * Devuelve el hint humanizado del provider para el mensaje Telegram al
 * operador. Fuente única de verdad: `agent-models.json#providers.<id>.quota_error_types`.
 *
 * Comportamiento:
 *   - Provider con `quota_error_types` poblado → strings sanitizados unidos por `' / '`
 *     (hasta {@link QUOTA_HINT_MAX_ELEMENTS} elementos).
 *   - Provider con `quota_error_types: []` o ausente → `'quota_exhausted'`.
 *   - Provider inexistente en el config → `'quota_exhausted'`.
 *   - `agent-models.json` corrupto / no cargable → `'quota_exhausted (config indisponible)'`
 *     + warning loggeado una sola vez (no spam por invocación).
 *
 * Defensas (invariantes documentadas):
 *   - Cap `slice(0, 5)` ANTES del join (CA-9 / SEC-1).
 *   - Sanitización por elemento previa al join (CA-10 / SEC-2 / UX-4).
 *
 * @param {string} provider — identificador del provider (ej. `'anthropic'`).
 * @param {object} [opts]
 * @param {object} [opts.agentModels] — config inyectado para tests; tiene
 *   precedencia sobre la cache memoizada (CA-5).
 * @param {object} [opts.logger] — logger custom para el warning del caso
 *   corrupto; default `console`.
 * @returns {string} hint humanizado.
 */
function getQuotaHint(provider, opts = {}) {
    let config = null;
    let degraded = false;

    // 1) Inyección explícita (testeable, prioritaria). NO toca el cache global.
    if (opts.agentModels && typeof opts.agentModels === 'object') {
        config = opts.agentModels;
    } else {
        // 2) Cache lazy — cargar una sola vez por vida del proceso.
        if (_quotaHintsCache === null) {
            try {
                if (!agentModelsLib || typeof agentModelsLib.loadAndValidate !== 'function') {
                    throw new Error('agent-models loader unavailable');
                }
                const result = agentModelsLib.loadAndValidate();
                if (result && result.ok && result.config && typeof result.config === 'object') {
                    _quotaHintsCache = result.config;
                    _quotaHintsLoadFailed = false;
                } else {
                    _quotaHintsCache = {};
                    _quotaHintsLoadFailed = true;
                    _logQuotaHintWarning(opts);
                }
            } catch {
                _quotaHintsCache = {};
                _quotaHintsLoadFailed = true;
                _logQuotaHintWarning(opts);
            }
        }
        config = _quotaHintsCache;
        degraded = _quotaHintsLoadFailed;
    }

    // 3) Extraer `quota_error_types` defensivamente.
    let types = null;
    try {
        const providerNode = config && config.providers && config.providers[provider];
        if (providerNode && Array.isArray(providerNode.quota_error_types)) {
            types = providerNode.quota_error_types;
        }
    } catch { /* defensive — caemos a fallback abajo */ }

    if (Array.isArray(types) && types.length > 0) {
        const joined = types
            .slice(0, QUOTA_HINT_MAX_ELEMENTS)
            .map(sanitizeHintElement)
            .filter(s => s.length > 0)
            .join(' / ');
        if (joined.length > 0) return joined;
        // Todos los elementos quedaron vacíos tras la sanitización → fallback.
    }

    return degraded ? QUOTA_HINT_FALLBACK_DEGRADED : QUOTA_HINT_FALLBACK;
}

/**
 * Resetea el cache memoizado del helper. Pensado únicamente para tests
 * (entre casos). NO usar desde producción — el cache es lazy y consistente
 * durante la vida del proceso (Pulpo se reinicia con `restart.js`, sin
 * hot-reload).
 */
function _resetQuotaHintsCache() {
    _quotaHintsCache = null;
    _quotaHintsLoadFailed = false;
    _quotaHintsWarningEmitted = false;
}

// -----------------------------------------------------------------------------
// Atomic JSON write para markers (mode 0o600).
// -----------------------------------------------------------------------------

function ensureDir(dir) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

function writeJsonAtomic(filepath, payload) {
    ensureDir(path.dirname(filepath));
    const tmp = `${filepath}.${process.pid}.${Date.now()}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
        fs.writeSync(fd, JSON.stringify(payload, null, 2));
        try { fs.fsyncSync(fd); } catch { /* best-effort */ }
    } finally {
        try { fs.closeSync(fd); } catch {}
    }
    try { fs.renameSync(tmp, filepath); }
    catch (e) {
        try { fs.unlinkSync(tmp); } catch {}
        throw e;
    }
}

// -----------------------------------------------------------------------------
// gh CLI wrappers
// -----------------------------------------------------------------------------

/**
 * Ejecuta gh con args en array (NO shell concat). El primer arg es la
 * subcommand, los siguientes son flags/positional. Si `gh` no está en PATH
 * el `spawnSync` devuelve error que el caller ignora (label aplicada
 * eventualmente cuando el ambiente lo soporte).
 */
function ghCall(args, opts = {}) {
    const ghBin = opts.ghBin || process.env.GH_BIN || 'gh';
    const spawn = opts.spawnSyncImpl || spawnSync;
    return spawn(ghBin, args, {
        timeout: opts.timeoutMs || 15000,
        windowsHide: true,
        encoding: 'utf8',
    });
}

/**
 * Lee labels actuales del issue. Devuelve array de strings (vacío si gh falla).
 */
function readIssueLabels(issue, opts = {}) {
    if (!isValidIssue(issue)) return [];
    const result = ghCall(
        ['issue', 'view', String(issue), '--repo', GH_REPO, '--json', 'labels'],
        opts,
    );
    if (!result || result.status !== 0 || !result.stdout) return [];
    try {
        const parsed = JSON.parse(result.stdout);
        if (!parsed || !Array.isArray(parsed.labels)) return [];
        return parsed.labels.map(l => (l && typeof l.name === 'string') ? l.name : null).filter(Boolean);
    } catch { return []; }
}

/**
 * Aplica la label `provider-exhaustion-pause` al issue si no la tiene.
 * Idempotente del lado del cliente (no hace roundtrip si ya está).
 *
 * @returns {{ applied: boolean, reason: string }} reason en {already, applied, gh_error, invalid_issue}
 */
function applyLabel(issue, opts = {}) {
    if (!isValidIssue(issue)) {
        return { applied: false, reason: 'invalid_issue' };
    }
    const existing = readIssueLabels(issue, opts);
    if (existing.includes(EXHAUSTION_LABEL)) {
        return { applied: false, reason: 'already' };
    }
    const result = ghCall(
        ['issue', 'edit', String(issue), '--repo', GH_REPO, '--add-label', EXHAUSTION_LABEL],
        opts,
    );
    if (!result || result.status !== 0) {
        return { applied: false, reason: 'gh_error' };
    }
    return { applied: true, reason: 'applied' };
}

/**
 * Quita la label `provider-exhaustion-pause` del issue. Idempotente.
 */
function clearLabel(issue, opts = {}) {
    if (!isValidIssue(issue)) {
        return { removed: false, reason: 'invalid_issue' };
    }
    const existing = readIssueLabels(issue, opts);
    if (!existing.includes(EXHAUSTION_LABEL)) {
        return { removed: false, reason: 'not_present' };
    }
    const result = ghCall(
        ['issue', 'edit', String(issue), '--repo', GH_REPO, '--remove-label', EXHAUSTION_LABEL],
        opts,
    );
    if (!result || result.status !== 0) {
        return { removed: false, reason: 'gh_error' };
    }
    return { removed: true, reason: 'removed' };
}

/**
 * Lista issues con label `provider-exhaustion-pause` aún abiertos. Devuelve
 * array de objects `{ number, title }`. Si gh falla, devuelve [].
 */
function listExhaustedIssues(opts = {}) {
    const result = ghCall(
        [
            'issue', 'list', '--repo', GH_REPO,
            '--label', EXHAUSTION_LABEL,
            '--state', 'open',
            '--json', 'number,title',
            '--limit', '50',
        ],
        opts,
    );
    if (!result || result.status !== 0 || !result.stdout) return [];
    try {
        const parsed = JSON.parse(result.stdout);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(i => i && Number.isInteger(i.number));
    } catch { return []; }
}

// -----------------------------------------------------------------------------
// Marker de notificación
// -----------------------------------------------------------------------------

function readNotifyMarker(issue, opts = {}) {
    if (!isValidIssue(issue)) return null;
    try {
        const raw = fs.readFileSync(notifyMarkerFile(issue, opts), 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        return parsed;
    } catch { return null; }
}

function writeNotifyMarker(issue, payload, opts = {}) {
    if (!isValidIssue(issue)) return;
    writeJsonAtomic(notifyMarkerFile(issue, opts), payload);
}

function deleteNotifyMarker(issue, opts = {}) {
    if (!isValidIssue(issue)) return false;
    try {
        fs.unlinkSync(notifyMarkerFile(issue, opts));
        return true;
    } catch (e) {
        if (e && e.code === 'ENOENT') return false;
        return false;
    }
}

/**
 * Extrae la causa dominante que se compara en el dedup.
 *
 * SEC-6 · Es la categoría GRUESA (`reposo`|`cuota`|`auth`|`transitoria`), nunca
 * el `reason_code` crudo. Un provider que flapea green↔red (openai pasó de
 * `red/quota_exhausted_real` a `green` en dos horas el 03/08) convertiría el
 * ruido de salud en ruido de Telegram, y el operador se acostumbraría a
 * ignorar el canal — perdiendo la caída real.
 */
function dominantCauseOf(payload, opts = {}) {
    if (opts.pauseCause && typeof opts.pauseCause === 'object') {
        return String(opts.pauseCause.dominantCause || '');
    }
    return typeof payload.dominant_cause === 'string' ? payload.dominant_cause : '';
}

/**
 * Decide si re-notificar Telegram (CA-9 de #3259, ampliado por CA-10 de #5467):
 *   - Sin marker → SI (primera notificación).
 *   - Si pasaron >2h desde `last_notified_ms` → SI.
 *   - Si el set de providers en `chain_tried` cambió respecto del marker → SI.
 *   - Si cambió la CAUSA DOMINANTE con cadena constante → SI. Pasar de reposo
 *     programado a cuota real es información nueva para el operador: la primera
 *     no requiere acción y la segunda sí.
 *   - En cualquier otro caso → NO (silencio idempotente).
 *
 * DOS CASOS QUE **NO** DISPARAN, a propósito:
 *
 *   1. Marker viejo sin `dominant_cause` (los que ya están en disco cuando se
 *      despliega #5467). Compararlos contra la causa actual daría "cambió" para
 *      TODOS a la vez: una tormenta de Telegram sobre cada issue pausado, en el
 *      mismo deploy que introduce la feature. Un marker sin campo no registró
 *      una causa distinta — registró NINGUNA. No hay novedad que contar.
 *   2. Causa actual vacía (clasificador degradado o sin snapshot de salud). No
 *      saber la causa no es información nueva para el operador.
 *
 * En ambos el marker se reescribe igual con el campo nuevo (`reportExhaustion`
 * persiste siempre), así que la comparación queda armada para la próxima vez
 * sin costo de ruido.
 */
function shouldNotify(issue, payload, opts = {}) {
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const marker = readNotifyMarker(issue, opts);
    if (!marker) return { notify: true, reason: 'first_notify' };
    const lastTs = Number(marker.last_notified_ms || 0);
    if (Number.isFinite(lastTs) && now - lastTs > NOTIFY_RENOTIFY_MS) {
        return { notify: true, reason: 'renotify_2h' };
    }
    const prevChain = Array.isArray(marker.chain_tried) ? marker.chain_tried.join('|') : '';
    const currChain = Array.isArray(payload.chain_tried) ? payload.chain_tried.join('|') : '';
    if (prevChain !== currChain) {
        return { notify: true, reason: 'chain_changed' };
    }
    const prevCause = typeof marker.dominant_cause === 'string' ? marker.dominant_cause : '';
    const currCause = dominantCauseOf(payload, opts);
    if (prevCause && currCause && prevCause !== currCause) {
        return { notify: true, reason: 'cause_changed' };
    }
    return { notify: false, reason: 'dedup_silent' };
}

// -----------------------------------------------------------------------------
// Telegram queue
// -----------------------------------------------------------------------------

/**
 * Resuelve la clasificación de causa (#5467) de forma defensiva.
 *
 * Acepta una causa ya calculada por `opts.pauseCause` — así `reportExhaustion`
 * clasifica UNA sola vez y comparte el resultado entre `shouldNotify` y el
 * formateador, en vez de leer el snapshot dos veces por notificación.
 *
 * Si el módulo no cargó o tira, devuelve `degraded` — el mensaje sale sin
 * desglose pero SIEMPRE sale (CA-7).
 */
function resolvePauseCause(payload, opts = {}) {
    const DEGRADED = { degraded: true, stale: false, ageMinutes: null, dominantCause: null, providers: [], verdict: null };
    if (opts.pauseCause && typeof opts.pauseCause === 'object') return opts.pauseCause;
    if (!pauseCauseLib || typeof pauseCauseLib.classifyPauseCause !== 'function') return DEGRADED;
    const chain = Array.isArray(payload.chain_tried) && payload.chain_tried.length
        ? payload.chain_tried
        : [String(payload.primary_provider || '')];
    try {
        return pauseCauseLib.classifyPauseCause(chain, opts) || DEGRADED;
    } catch {
        return DEGRADED; // el mensaje de pausa nunca se cae por el clasificador
    }
}

/**
 * Arma una línea del desglose: `• <Label> — <motivo>`.
 *
 * UX-4: máximo `BREAKDOWN_MAX_LINE_CHARS` para no envolver en Telegram móvil.
 * Si con el `label` no entra, se cae al id del proveedor — pero SÓLO si el id
 * es efectivamente más corto. Varias entradas de la tabla de copy de UX-3 son
 * largas por sí solas (`el proveedor la reporta agotada (sin medición)` son 45
 * caracteres), así que ningún nombre las haría entrar: cambiar
 * `Cerebras` por `cerebras` ahí perdería el label lindo sin ganar una sola
 * columna. Preferimos el nombre legible cuando el swap no aporta.
 *
 * El `label` viene del snapshot —input no confiable— así que se escapa contra
 * Markdown antes de interpolar (CA-9 / SEC-2).
 */
function breakdownLine(entry) {
    const text = String(entry.text || '');
    const label = String(entry.label || entry.id || '');
    const id = String(entry.id || '');
    const fits = (name) => (name.length + 3 + text.length) <= BREAKDOWN_MAX_LINE_CHARS;

    let name = label || id;
    if (label && id && !fits(label) && id.length < label.length) name = id;

    return `• ${escapeMarkdownLegacy(name)} — ${text}`;
}

/**
 * Formato del mensaje de pausa (CA-8 de #3259, reescrito por #5467).
 * Determinístico para snapshot tests.
 *
 * ORDEN DE LECTURA (UX-4 + UX-V1 · el mensaje es ADITIVO, no sustitutivo)
 *
 *   1. TITULAR      ¿qué pasó?              🌙 reposo | 🟧 sin proveedor   [NUEVO]
 *   2. VEREDICTO    ¿tengo que hacer algo?  ✅ / ⚠️                        [NUEVO]
 *   3. IDENTIDAD    ¿a qué issue afecta?    Issue / Skill                  [de #3498]
 *   4. DESGLOSE     ¿por qué?               • Label — motivo               [NUEVO]
 *   5. COLA TÉCNICA Primary / Cadena                                       [de #3498]
 *   6. PIE          reintento + destrabe manual                            [de #3498]
 *
 * Las líneas 3, 5 y 6 se conservan LITERALES: son capacidad operativa que
 * #3498 agregó deliberadamente (el comando para destrabar a mano) y su
 * anti-regresión CA-14 sigue verde. Los asserts usan `includes()`, no comparan
 * orden, así que el orden por urgencia y la conservación literal no compiten.
 *
 * `sanitizeForTelegram` trunca por el FINAL (línea ~192), de modo que lo que se
 * pierde con una cadena larga es el detalle, nunca el veredicto (SEC-5 / CA-5).
 *
 * @param {object} payload — datos del evento de exhaustion.
 * @param {object} [opts] — overrides (propagados a `getQuotaHint` y al
 *   clasificador de causa). Permite inyectar `agentModels` para tests sin tocar
 *   el cache global (#3498 CA-5), y `pauseCause` / `stateDir` / `now` para
 *   fijar la causa con fixtures (#5467 CA-12).
 */
function formatExhaustionMessage(payload, opts = {}) {
    const skill = String(payload.skill || 'unknown');
    const issue = isValidIssue(payload.issue) ? Number(payload.issue) : null;
    const title = payload.title ? String(payload.title) : '';
    const primary = String(payload.primary_provider || 'unknown');
    const chain = Array.isArray(payload.chain_tried) && payload.chain_tried.length
        ? payload.chain_tried.join(' -> ')
        : primary;
    // #3498: hint derivado de `agent-models.json#quota_error_types`; el helper
    // mantiene fallback genérico si el provider no está en el config o si el
    // JSON no carga. Nunca tira.
    const hint = getQuotaHint(primary, opts);
    const retrySec = Math.max(60, Math.round(Number(payload.retry_interval_ms || DEFAULT_RETRY_INTERVAL_MS) / 1000));
    // CA-9 · el título viene de GitHub (repo público: cualquiera abre un issue),
    // así que es INPUT EXTERNO y NO puede ir en posición de texto-de-link.
    //
    // El bug que esto cierra: `escapeMarkdownLegacy` escapa `_ * \` [` pero NO
    // `]`. Con el título adentro de `[#N — <title>](url)`, un título que trajera
    // `](` cerraba el link de la plantilla antes de tiempo y rebindeaba el
    // destino — Telegram (parse_mode 'Markdown') renderizaba "#N — Bug"
    // apuntando al sitio del atacante. Phishing en el mismo canal que el
    // operador usa de madrugada para destrabar el pipeline.
    //
    // Fix: el texto del link es FIJO (`#N`, sólo dígitos validados por
    // `isValidIssue`) y el título sale AFUERA del link. Ahí `]` es inerte:
    // formar un link nuevo necesita un `[` de apertura, y ese sí lo escapa
    // `escapeMarkdownLegacy`.
    //
    // El `\` se saca ANTES de escapar (si se sacara después borraría los
    // backslashes que el propio escape acaba de poner): un `\` al final del
    // título se comería el escape del carácter siguiente.
    const rawTitle = title ? title.slice(0, 80).replace(/\\/g, '') : '';
    const safeTitle = rawTitle ? escapeMarkdownLegacy(rawTitle) : '';
    const issueLink = issue
        ? `[#${issue}](https://github.com/${GH_REPO}/issues/${issue})${safeTitle ? ' — ' + safeTitle : ''}`
        : '(sin issue)';

    const cause = resolvePauseCause(payload, opts);

    // CA-3 · `🌙 pausa programada` sólo si TODAS las no disponibles están en
    // reposo. Cualquier otra causa colapsa al titular único no-reposo (UX-6).
    //
    // CA-6 / SEC-7 · con el dato de salud vencido tampoco se titula pausa
    // programada: no podemos descartar que además haya un provider caído que el
    // snapshot viejo no refleja. Afirmar "programada" sería sobre-atribuir con
    // datos que no sostienen la afirmación (render E de UX).
    const header = (cause.dominantCause === 'reposo' && !cause.stale)
        ? HEADER_REPOSO
        : HEADER_SIN_PROVIDER;

    const lines = [header];

    // 2 · VEREDICTO. Ausente sólo en modo degradado: sin snapshot no hay causa,
    // y afirmar una (aunque sea el ⚠️ genérico) es inventar la atribución que
    // este issue viene a matar — el mismo defecto, en el caso donde el sistema
    // MENOS sabe (UX-V2 / R2).
    if (cause.verdict && cause.verdict.text) {
        // SEC-2 · el veredicto interpola `p.label`, que sale del snapshot de
        // salud — un archivo que escribe OTRO proceso, o sea input no confiable
        // (el propio `readHealthSnapshot` lo trata así). `breakdownLine` ya
        // escapaba ese mismo campo; el veredicto no, y quedaba asimétrico: un
        // label con `[x](url)` formaba un link en la línea que el operador lee
        // primero.
        //
        // Se escapa el texto ENTERO en vez de sólo el label porque acá el label
        // ya viene interpolado y no es separable. Es seguro: `buildVerdict` no
        // usa metacaracteres Markdown en NINGUNO de sus literales, así que el
        // escape es no-op para ellos.
        //
        // INVARIANTE (lo bloquea el test "el veredicto no altera los literales
        // propios al escapar"): si algún literal de `buildVerdict` llegara a
        // necesitar formato Markdown propio, este escape se lo comería — en ese
        // caso hay que segmentar el veredicto y escapar sólo el label.
        lines.push(``, `${cause.verdict.requiresAction ? '⚠️' : '✅'} ${escapeMarkdownLegacy(cause.verdict.text)}`);
    }

    // 3 · IDENTIDAD (literal de #3498).
    lines.push(
        ``,
        `Issue: ${issueLink}`,
        `Skill: \`${skill}\``,
    );

    // 4 · DESGLOSE. Ordenado por urgencia descendente (auth primero, reposo
    // último) para que el truncado se coma lo menos importante.
    if (!cause.degraded && Array.isArray(cause.providers) && cause.providers.length) {
        const priority = (pauseCauseLib && pauseCauseLib.CAUSE_PRIORITY) || {};
        const sorted = cause.providers
            .map((p, i) => ({ p, i }))
            .sort((a, b) => {
                const pa = priority[a.p.cause];
                const pb = priority[b.p.cause];
                const na = Number.isFinite(pa) ? pa : 99;
                const nb = Number.isFinite(pb) ? pb : 99;
                return na !== nb ? na - nb : a.i - b.i; // estable dentro de la categoría
            })
            .map(x => x.p);

        // CA-6 · con dato vencido el desglose se rotula como último dato
        // conocido, para que el operador sepa que está mirando el pasado.
        const staleTag = (cause.stale && Number.isFinite(cause.ageMinutes))
            ? ` (último dato conocido hace ${cause.ageMinutes} min)`
            : (cause.stale ? ' (último dato conocido)' : '');

        lines.push(``, `Proveedores intentados${staleTag}:`);
        for (const entry of sorted.slice(0, BREAKDOWN_MAX_PROVIDERS)) {
            lines.push(breakdownLine(entry));
        }
        const extra = sorted.length - BREAKDOWN_MAX_PROVIDERS;
        if (extra > 0) lines.push(`• …y ${extra} proveedor${extra === 1 ? '' : 'es'} más`);
    }

    // 5 · COLA TÉCNICA + 6 · PIE (literales de #3498).
    lines.push(
        ``,
        `Primary: \`${primary}\` (${hint})`,
        `Cadena intentada: \`${chain}\``,
        ``,
        `El pulpo aplicó la label \`${EXHAUSTION_LABEL}\` y va a reintentar cada ~${retrySec}s hasta que algún provider se libere.`,
        ``,
        `Para destrabe manual: \`gh issue edit ${issue || '<n>'} --remove-label ${EXHAUSTION_LABEL}\` o esperar al brazo de retry.`,
    );
    return sanitizeForTelegram(lines.join('\n'));
}

/**
 * Formato del mensaje de destrabe (CA-10).
 */
function formatResumedMessage(payload) {
    const issue = isValidIssue(payload.issue) ? Number(payload.issue) : null;
    const title = payload.title ? String(payload.title) : '';
    const provider = String(payload.provider_recovered || 'unknown');
    const issueLink = issue
        ? `[#${issue}${title ? ' — ' + title.slice(0, 80) : ''}](https://github.com/${GH_REPO}/issues/${issue})`
        : '(sin issue)';
    const lines = [
        `🟩 *Pipeline destrabado — provider recuperado*`,
        ``,
        `Issue: ${issueLink}`,
        `Provider: \`${provider}\``,
        ``,
        `Se quitó la label \`${EXHAUSTION_LABEL}\`. El pulpo va a reentrar el issue en el próximo barrido.`,
    ];
    return sanitizeForTelegram(lines.join('\n'));
}

/**
 * Encola un mensaje en `servicios/telegram/pendiente/` (fire-and-forget).
 * `servicio-telegram.js` drena la cola fuera del path crítico.
 *
 * @returns {{ ok: boolean, file?: string, reason?: string }}
 */
function enqueueTelegram(text, opts = {}) {
    const queueDir = telegramQueueDir(opts);
    try { ensureDir(queueDir); }
    catch (e) { return { ok: false, reason: `cannot_create_queue_dir: ${e.message}` }; }
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const tag = opts.filenameTag || 'exhaustion';
    const filename = `${now}-${tag}.json`;
    const file = path.join(queueDir, filename);
    try {
        fs.writeFileSync(file, JSON.stringify({
            text,
            parse_mode: 'Markdown',
        }), 'utf8');
        return { ok: true, file };
    } catch (e) {
        return { ok: false, reason: `cannot_write_file: ${e.message}` };
    }
}

// -----------------------------------------------------------------------------
// Audit log (hash-chain via lib/audit-log.js — best-effort si no carga).
// -----------------------------------------------------------------------------

/**
 * Persiste una entry en el audit log de exhaustion. Devuelve `true` si
 * efectivamente escribió (hash-chain o fallback plano), `false` si ambos
 * caminos fallaron — NO swallow silent: el caller usa el return para
 * setear `audit_logged` con honestidad.
 *
 * Estrategia:
 *   1. Si `lib/audit-log.js` cargó, intentamos `appendChained` con la
 *      firma correcta `{ file, entry }`. Si TIRA, NO devolvemos `true`
 *      ni mentimos: caemos al fallback plano para al menos persistir la
 *      evidencia.
 *   2. Fallback plano: `fs.appendFileSync` JSONL sin hash-chain.
 *
 * Diferencia con la versión anterior (#3259 rebote 1):
 *   - Antes: try/catch silencioso alrededor de appendChained(string, entry)
 *     enmascaraba el bug de firma — la función reportaba `audit_logged: true`
 *     pero el archivo nunca existía.
 *   - Ahora: la firma es correcta + el catch hace fallback real + return
 *     boolean explícito.
 */
function appendAudit(event, entry, opts = {}) {
    const file = exhaustionAuditFile(opts);

    // Intento 1: hash-chained via lib/audit-log.js (path preferido — el
    // mandato security pide chain SHA-256 verificable con verifyChain).
    if (auditLogLib && typeof auditLogLib.appendChained === 'function') {
        try {
            auditLogLib.appendChained({
                file,
                entry: { event, ...entry },
            });
            return true;
        } catch {
            // Si el lib falla (bug interno, EACCES, ENOSPC, etc.) caemos
            // al fallback plano. NO devolvemos true acá — solo si el
            // fallback también escribe.
        }
    }

    // Intento 2: append directo a JSONL sin hash-chain. Cubre tanto el
    // caso "auditLogLib no cargó" como "auditLogLib tiró".
    try {
        ensureDir(path.dirname(file));
        fs.appendFileSync(file, JSON.stringify({
            ts: new Date(opts.now || Date.now()).toISOString(),
            event,
            ...entry,
        }) + '\n', { mode: 0o600 });
        return true;
    } catch {
        return false;
    }
}

// -----------------------------------------------------------------------------
// API PÚBLICA
// -----------------------------------------------------------------------------

/**
 * CA-4 + CA-9: invocado desde `pulpo.js` cuando `dispatchResolution.gated`.
 * Aplica label, encola Telegram (si toca por dedupe), persiste marker y
 * auditea.
 *
 * @param {object} payload
 * @param {string} payload.skill — nombre del skill bloqueado
 * @param {number} payload.issue — número del issue
 * @param {string} payload.primary_provider — provider primary que gateó
 * @param {string[]} payload.chain_tried — providers intentados en orden
 * @param {string} [payload.title] — título del issue (informativo, opcional)
 * @param {number} [payload.retry_interval_ms] — para humanizar ETA del Telegram
 * @param {object} [opts] — overrides (pipelineDir, spawnSyncImpl, now, ghBin)
 * @returns {{
 *   label_applied: boolean,
 *   notified: boolean,
 *   notify_reason: string,
 *   audit_logged: boolean,
 *   telegram_file?: string,
 * }}
 */
function reportExhaustion(payload, opts = {}) {
    const out = {
        label_applied: false,
        notified: false,
        notify_reason: 'unknown',
        audit_logged: false,
    };
    if (!payload || typeof payload !== 'object') return out;
    const { issue, skill } = payload;
    if (!isValidIssue(issue)) {
        out.notify_reason = 'invalid_issue';
        return out;
    }

    // 0. `now` HOISTEADO (#5467). Antes se calculaba después de formatear, pero
    // el formateador ahora lo necesita para la frescura del snapshot y la hora
    // de reanudación. Sin hoistearlo los tests de reposo no son
    // determinísticos: el formateador caería a `Date.now()` real.
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();

    // 0.b Causa clasificada UNA sola vez y compartida por `shouldNotify`,
    // `formatExhaustionMessage` y el marker — así el snapshot de salud se lee
    // una vez por notificación, no tres.
    let pauseCause = opts.pauseCause;
    if (!pauseCause && pauseCauseLib && typeof pauseCauseLib.classifyPauseCause === 'function') {
        const chain = Array.isArray(payload.chain_tried) && payload.chain_tried.length
            ? payload.chain_tried
            : [String(payload.primary_provider || '')];
        try { pauseCause = pauseCauseLib.classifyPauseCause(chain, { ...opts, now }); }
        catch { pauseCause = null; } // degradamos, nunca tumbamos el barrido
    }
    const causeOpts = { ...opts, now, pauseCause: pauseCause || undefined };
    const dominantCause = pauseCause ? String(pauseCause.dominantCause || '') : '';
    out.dominant_cause = dominantCause;

    // 1. Label (idempotente).
    const labelRes = applyLabel(issue, causeOpts);
    out.label_applied = labelRes.applied;
    out.label_reason = labelRes.reason;

    // 2. Dedupe Telegram.
    const decision = shouldNotify(issue, payload, causeOpts);
    out.notify_reason = decision.reason;
    if (decision.notify) {
        const text = formatExhaustionMessage(payload, causeOpts);
        const tg = enqueueTelegram(text, { ...causeOpts, filenameTag: 'exhaustion-pause' });
        out.notified = tg.ok;
        if (tg.file) out.telegram_file = tg.file;
    }

    // 3. Persistir marker (siempre — refresca `chain_tried` y `dominant_cause`
    // aún sin re-notificar, para que el dedupe note cambios futuros).
    try {
        writeNotifyMarker(issue, {
            issue: Number(issue),
            skill: String(skill || ''),
            primary_provider: String(payload.primary_provider || ''),
            chain_tried: Array.isArray(payload.chain_tried) ? payload.chain_tried.slice() : [],
            // SEC-6 · categoría gruesa, nunca el `reason_code` crudo.
            dominant_cause: dominantCause,
            last_notified_ms: decision.notify ? now : Number((readNotifyMarker(issue, opts) || {}).last_notified_ms || now),
            updated_at: new Date(now).toISOString(),
        }, opts);
    } catch { /* best-effort */ }

    // 4. Audit log hash-chained. `appendAudit` retorna boolean honesto
    // (true sólo si efectivamente escribió por hash-chain o fallback
    // plano). NO envolvemos en try/catch + true asumido — eso enmascara
    // bugs como el de la firma incorrecta (rebote 1 #3259).
    out.audit_logged = appendAudit('provider-exhaustion-pause', {
        skill: String(skill || ''),
        issue: Number(issue),
        primary_provider: String(payload.primary_provider || ''),
        chain_tried: Array.isArray(payload.chain_tried) ? payload.chain_tried.slice() : [],
        label_applied: out.label_applied,
        notified: out.notified,
        notify_reason: out.notify_reason,
        // #5467 · trazabilidad de por qué se pausó. Categoría gruesa, sin
        // `reason_code` crudo ni postura de seguridad (SEC-3 / SEC-6).
        dominant_cause: dominantCause,
    }, { ...opts, now });

    return out;
}

/**
 * CA-10: invocado periódicamente desde el brazo de retry del Pulpo.
 * Detecta qué providers están libres ahora y destraba issues cuya cadena
 * incluya alguno de esos providers.
 *
 * @param {object} opts
 * @param {object} [opts.quotaModule] — para tests (default: requirido de
 *   `./quota-exhausted`).
 * @returns {{
 *   resumed: Array<{ issue, provider_recovered, removed }>,
 *   skipped: Array<{ issue, reason }>,
 * }}
 */
function tryResume(opts = {}) {
    const out = { resumed: [], skipped: [] };
    const qm = opts.quotaModule || quotaModule;

    // 1. Quiénes están exhausted hoy.
    const exhaustedIssues = listExhaustedIssues(opts);
    if (exhaustedIssues.length === 0) return out;

    // 2. Estado actual del flag — si está activo y NO expiró, sabemos que
    // ese provider sigue gated. Si está absent/expired, asumimos libre.
    let activeFlagProvider = null;
    if (qm && typeof qm.readDefensive === 'function') {
        try {
            const flag = qm.readDefensive({ auditLogEnabled: false });
            if (flag && flag.exhausted === true) {
                activeFlagProvider = flag.provider || null;
            }
        } catch { /* best-effort: si falla, asumimos libre */ }
    }

    // 3. Por cada issue: si su cadena incluye AL MENOS un provider que ya
    // no es el `activeFlagProvider`, asumimos que ese provider está libre
    // y destrabamos. Si la cadena es subset estricto de `activeFlagProvider`
    // (sólo gated por el provider activo), saltamos.
    for (const it of exhaustedIssues) {
        const issue = it.number;
        const marker = readNotifyMarker(issue, opts);
        const chain = marker && Array.isArray(marker.chain_tried) ? marker.chain_tried : [];
        // Si no tenemos marker, default seguro: destrabamos. El pulpo
        // re-clasifica naturalmente si la cuota sigue agotada.
        let recovered = null;
        if (!activeFlagProvider) {
            recovered = (chain[0] || marker?.primary_provider || 'unknown');
        } else {
            // Buscar un provider de la chain que NO sea el activo gated.
            recovered = chain.find(p => p && p !== activeFlagProvider);
            if (!recovered) {
                out.skipped.push({ issue, reason: 'still_gated_same_provider' });
                continue;
            }
        }

        // 4. Quitar label.
        const labelRes = clearLabel(issue, opts);
        if (!labelRes.removed && labelRes.reason !== 'not_present') {
            out.skipped.push({ issue, reason: `clear_label_failed:${labelRes.reason}` });
            continue;
        }

        // 5. Borrar marker.
        deleteNotifyMarker(issue, opts);

        // 6. Notificar Telegram destrabe.
        const text = formatResumedMessage({
            issue,
            title: it.title || '',
            provider_recovered: recovered,
        });
        enqueueTelegram(text, { ...opts, filenameTag: 'exhaustion-resumed' });

        // 7. Audit (hash-chain + fallback plano via `appendAudit`).
        // `appendAudit` no tira; el return boolean queda implícito porque
        // este path es fire-and-forget (no exponemos el flag al caller).
        appendAudit('provider-exhaustion-resumed', {
            issue,
            provider_recovered: recovered,
            chain_before: chain,
        }, opts);

        out.resumed.push({ issue, provider_recovered: recovered, removed: labelRes.removed });
    }
    return out;
}

/**
 * Helper para callers: clamp del retry interval (config.yaml puede pedir
 * menos, hardcoded floor de 60s).
 */
function clampRetryIntervalMs(input) {
    const n = Number(input);
    if (!Number.isFinite(n)) return DEFAULT_RETRY_INTERVAL_MS;
    if (n < MIN_RETRY_INTERVAL_MS) return MIN_RETRY_INTERVAL_MS;
    return Math.floor(n);
}

module.exports = {
    // API pública
    reportExhaustion,
    tryResume,
    formatExhaustionMessage,
    formatResumedMessage,
    clampRetryIntervalMs,

    // Helpers expuestos (callers internos + tests)
    applyLabel,
    clearLabel,
    listExhaustedIssues,
    readIssueLabels,
    readNotifyMarker,
    writeNotifyMarker,
    deleteNotifyMarker,
    shouldNotify,
    enqueueTelegram,
    sanitizeForTelegram,
    isValidIssue,
    notifyMarkerFile,
    telegramQueueDir,
    exhaustionAuditFile,

    // #3498: helper memoizado del hint humanizado + reset para tests.
    getQuotaHint,
    sanitizeHintElement,
    _resetQuotaHintsCache,

    // #5467: helpers de causa de pausa expuestos para tests.
    resolvePauseCause,
    dominantCauseOf,
    breakdownLine,

    // Constantes
    EXHAUSTION_LABEL,
    GH_REPO,
    TELEGRAM_MAX_BYTES,
    NOTIFY_RENOTIFY_MS,
    MIN_RETRY_INTERVAL_MS,
    DEFAULT_RETRY_INTERVAL_MS,
    TELEGRAM_QUEUE_SUBDIR,
    NOTIFY_MARKER_SUBDIR,
    // #3498: constantes nuevas del helper.
    QUOTA_HINT_FALLBACK,
    QUOTA_HINT_FALLBACK_DEGRADED,
    QUOTA_HINT_MAX_ELEMENTS,
    // #5467: titulares por causa + topes del desglose.
    HEADER_REPOSO,
    HEADER_SIN_PROVIDER,
    BREAKDOWN_MAX_PROVIDERS,
    BREAKDOWN_MAX_LINE_CHARS,
};

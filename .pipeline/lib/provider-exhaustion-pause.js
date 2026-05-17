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

// Tipos de error esperables por provider — para humanizar el detalle del
// Telegram. Si el caller no pasa `error_types`, mostramos `unknown`.
const KNOWN_HINTS_BY_PROVIDER = Object.freeze({
    anthropic: 'usage_limit_error / weekly_quota_exhausted',
    'openai-codex': 'insufficient_quota / billing_hard_limit_reached',
    'gemini-google': 'quota_exceeded / resource_exhausted',
    groq: 'rate_limit_exceeded / tokens_exhausted',
    cerebras: 'rate_limit_exceeded / quota_exceeded',
});

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
        str = str.slice(0, TELEGRAM_MAX_BYTES - 32) + '\n[... truncado]';
    }
    return str;
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
 * Decide si re-notificar Telegram (CA-9):
 *   - Sin marker → SI (primera notificación).
 *   - Si pasaron >2h desde `last_notified_ms` → SI.
 *   - Si el set de providers en `chain_tried` cambió respecto del marker → SI.
 *   - En cualquier otro caso → NO (silencio idempotente).
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
    return { notify: false, reason: 'dedup_silent' };
}

// -----------------------------------------------------------------------------
// Telegram queue
// -----------------------------------------------------------------------------

/**
 * Formato del mensaje de pausa (CA-8). Determinístico para snapshot tests.
 * NO Markdown porque el body puede traer chain con guiones; el servicio
 * Telegram lo encola con `parse_mode: 'Markdown'` por defecto pero el
 * caller puede pedir plain.
 */
function formatExhaustionMessage(payload) {
    const skill = String(payload.skill || 'unknown');
    const issue = isValidIssue(payload.issue) ? Number(payload.issue) : null;
    const title = payload.title ? String(payload.title) : '';
    const primary = String(payload.primary_provider || 'unknown');
    const chain = Array.isArray(payload.chain_tried) && payload.chain_tried.length
        ? payload.chain_tried.join(' -> ')
        : primary;
    const hint = KNOWN_HINTS_BY_PROVIDER[primary] || 'quota_exhausted';
    const retrySec = Math.max(60, Math.round(Number(payload.retry_interval_ms || DEFAULT_RETRY_INTERVAL_MS) / 1000));
    const issueLink = issue
        ? `[#${issue}${title ? ' — ' + title.slice(0, 80) : ''}](https://github.com/${GH_REPO}/issues/${issue})`
        : '(sin issue)';

    const lines = [
        `🟧 *Pipeline pausado — cuota agotada*`,
        ``,
        `Issue: ${issueLink}`,
        `Skill: \`${skill}\``,
        `Primary: \`${primary}\` (${hint})`,
        `Cadena intentada: \`${chain}\``,
        ``,
        `El pulpo aplicó la label \`${EXHAUSTION_LABEL}\` y va a reintentar cada ~${retrySec}s hasta que algún provider se libere.`,
        ``,
        `Para destrabe manual: \`gh issue edit ${issue || '<n>'} --remove-label ${EXHAUSTION_LABEL}\` o esperar al brazo de retry.`,
    ];
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

    // 1. Label (idempotente).
    const labelRes = applyLabel(issue, opts);
    out.label_applied = labelRes.applied;
    out.label_reason = labelRes.reason;

    // 2. Dedupe Telegram.
    const decision = shouldNotify(issue, payload, opts);
    out.notify_reason = decision.reason;
    if (decision.notify) {
        const text = formatExhaustionMessage(payload);
        const tg = enqueueTelegram(text, { ...opts, filenameTag: 'exhaustion-pause' });
        out.notified = tg.ok;
        if (tg.file) out.telegram_file = tg.file;
    }

    // 3. Persistir marker (siempre — refresca `chain_tried` aún sin re-notificar
    // si querés que el dedupe note cambios futuros).
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    try {
        writeNotifyMarker(issue, {
            issue: Number(issue),
            skill: String(skill || ''),
            primary_provider: String(payload.primary_provider || ''),
            chain_tried: Array.isArray(payload.chain_tried) ? payload.chain_tried.slice() : [],
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

    // Constantes
    EXHAUSTION_LABEL,
    GH_REPO,
    TELEGRAM_MAX_BYTES,
    NOTIFY_RENOTIFY_MS,
    MIN_RETRY_INTERVAL_MS,
    DEFAULT_RETRY_INTERVAL_MS,
    TELEGRAM_QUEUE_SUBDIR,
    NOTIFY_MARKER_SUBDIR,
    KNOWN_HINTS_BY_PROVIDER,
};

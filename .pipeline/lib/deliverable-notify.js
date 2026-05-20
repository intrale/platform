// =============================================================================
// deliverable-notify.js — Notificación Telegram de entregables del pipeline
// Issue #3414
//
// Responsabilidad: armar el payload (text|photo + caption + parse_mode +
// envelope canónico) que el pulpo encola en `.pipeline/servicios/telegram/
// pendiente/*.json` cuando un skill notificable cierra una fase del pipeline
// `definicion` con `resultado: aprobado`.
//
// Se mantiene PURO y sin side effects propios (no escribe Telegram, no toca
// el filesystem del pipeline) salvo:
//   - `appendAudit(...)`  → escribe una línea JSONL al audit log
//   - `notify(...)`       → fachada que combina buildPreview + dedup + audit +
//                            escribir el dropfile Telegram. Es la API que el
//                            pulpo invoca. Si algo falla, captura y devuelve
//                            `{ ok: false, error }` SIN propagar (CA-FN-8).
//
// CA mapping (issue #3414):
//   - CA-FN-1/2: filtro por skill notificable se aplica fuera (en pulpo) +
//                doble check defensivo en `notify`.
//   - CA-FN-3:   plantilla canónica con header + preview + footer.
//   - CA-FN-4:   fallback text-only si PNG inválido.
//   - CA-FN-5 / CA-SEC-2: envelope HTML comment con fields derivados del
//                          archivo (no del YAML editable).
//   - CA-FN-6:   recibe `config` como parámetro (kill-switch + enabled
//                evaluados en cada llamada).
//   - CA-FN-7:   dedup por content_hash con ventana configurable.
//   - CA-FN-8:   try/catch en `notify`.
//   - CA-SEC-1:  validación path del adjunto bajo root allowlisteado.
//   - CA-SEC-3:  audit con content_hash + preview sanitizado truncado a 200 +
//                ruta relativa. Aplica `redact.js` defense-in-depth.
//   - CA-UX-1..6: plantilla, emojis, separador, truncado, caption corto.
//   - CA-UX-9:   no audio TTS (omitido, este módulo solo arma payload texto).
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { sanitizeTelegramPayload } = require('./sanitize-payload');
const { redactSensitive } = require('./redact');

// -----------------------------------------------------------------------------
// CA-UX-2 — Emojis canónicos fijos por skill. Cualquier skill no listado cae
// a 📦 (fallback neutral). El set debe coincidir con el subset configurado en
// `deliverable_notifications.skills`.
// -----------------------------------------------------------------------------
const SKILL_EMOJIS = Object.freeze({
    guru: '🔍',
    po: '📋',
    ux: '🎨',
    planner: '🗺️',
});

const DEFAULT_FALLBACK_EMOJI = '📦';

// CA-UX-2 — subset notificable default (override desde config.yaml).
const DEFAULT_NOTIFY_SKILLS = Object.freeze(['guru', 'po', 'ux', 'planner']);

// CA-UX-4 — truncado por defecto si el config no lo declara.
const DEFAULT_TRUNCATE_CHARS = 1500;

// CA-FN-7 — ventana de dedup por defecto (horas).
const DEFAULT_DEDUP_HOURS = 24;

// CA-SEC-1 — root allowlisteado por defecto para adjuntos.
const DEFAULT_ATTACHMENT_ROOT = '.pipeline/assets/mockups';

// CA-SEC-3 — preview truncado en el audit log.
const AUDIT_PREVIEW_MAX = 200;

// CA-UX-1 / CA-UX-3 — separador del header.
const HEADER_SEP = ' · ';

// CA-UX-4 — sufijo del truncado.
const TRUNCATE_SUFFIX = '…\n_(continúa en el issue)_';

// CA-UX-4 — fallback cuando notas está vacía/malformada.
const EMPTY_NOTAS_FALLBACK = '_Sin preview disponible — ver issue completo._';

// -----------------------------------------------------------------------------
// Utilidades puras
// -----------------------------------------------------------------------------

/**
 * Devuelve el emoji canónico del skill. Si no está en el set fijo, devuelve
 * un fallback neutral sin romper.
 */
function emojiForSkill(skill) {
    return SKILL_EMOJIS[skill] || DEFAULT_FALLBACK_EMOJI;
}

/**
 * SHA-256 de un texto. Usado para dedup (CA-FN-7) y para el `content_hash`
 * del audit log (CA-SEC-3).
 *
 * @param {string} text
 * @returns {string} hex completo (64 chars).
 */
function contentHash(text) {
    return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

/**
 * Trunca el texto a `max` chars, cortando en límite de línea cuando es
 * posible (CA-UX-4). Si excede agrega `TRUNCATE_SUFFIX`. Si no excede,
 * devuelve tal cual.
 *
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function truncatePreserveLines(text, max) {
    if (typeof text !== 'string') return '';
    if (text.length <= max) return text;
    const slice = text.slice(0, max);
    const lastNl = slice.lastIndexOf('\n');
    // Si encontramos un salto de línea cerca del final, cortamos ahí.
    // Cerca = al menos el 50% del límite para evitar truncados muy chicos.
    const cutoff = lastNl > Math.floor(max * 0.5) ? lastNl : max;
    return text.slice(0, cutoff).trimEnd() + TRUNCATE_SUFFIX;
}

/**
 * Obtiene el preview crudo desde el YAML del archivo procesado. Acepta
 * `notas` (forma canónica), `notes` (typo común) o el body completo si no
 * hay notas. Defensivo ante undefined/null/no-strings.
 *
 * @param {object} yaml
 * @returns {string} `''` si no hay nada utilizable.
 */
function extractRawNotes(yaml) {
    if (!yaml || typeof yaml !== 'object') return '';
    if (typeof yaml.notas === 'string' && yaml.notas.trim().length > 0) return yaml.notas;
    if (typeof yaml.notes === 'string' && yaml.notes.trim().length > 0) return yaml.notes;
    if (typeof yaml.notas === 'object' && yaml.notas != null) {
        try { return JSON.stringify(yaml.notas, null, 2); } catch { return ''; }
    }
    return '';
}

/**
 * CA-SEC-1 — Valida que `attachmentPath` resuelva estrictamente bajo `root`.
 * Rechaza:
 *   - `..` (path traversal explícito)
 *   - null bytes
 *   - paths absolutos fuera del root
 *   - cualquier resolución fuera del root (incluido symlinks que escapan)
 *
 * Devuelve `{ ok, absolute, relative, reason }`. NUNCA tira excepción.
 *
 * `root` se resuelve contra `pipelineRoot` si es relativo (default
 * `.pipeline/assets/mockups` relativo al `process.cwd()` o `pipelineRoot`).
 *
 * @param {string} candidate - path (relativo o absoluto) declarado por el agente.
 * @param {object} opts
 * @param {string} opts.root - root allowlisteado.
 * @param {string} [opts.pipelineRoot] - cwd del repo, para resolver rel→abs.
 * @returns {{ ok: boolean, absolute?: string, relative?: string, reason?: string }}
 */
function validateAttachmentPath(candidate, opts) {
    const root = (opts && opts.root) || DEFAULT_ATTACHMENT_ROOT;
    const pipelineRoot = (opts && opts.pipelineRoot) || process.cwd();

    if (typeof candidate !== 'string' || candidate.length === 0) {
        return { ok: false, reason: 'empty' };
    }
    // Null byte → traversal trick clásico en C-bindings; rechazar siempre.
    if (candidate.indexOf('\0') >= 0) return { ok: false, reason: 'null_byte' };

    // Detección barata de `..` segmentos antes de resolver — el resolver de
    // Node los colapsa y podríamos perder el motivo del rechazo.
    const segments = candidate.split(/[\/\\]+/);
    if (segments.some((s) => s === '..')) return { ok: false, reason: 'parent_segment' };

    const absRoot = path.resolve(pipelineRoot, root);
    const absCandidate = path.isAbsolute(candidate)
        ? path.resolve(candidate)
        : path.resolve(pipelineRoot, candidate);

    // Match exacto o subdirectorio (path.sep para no matchear "rootX").
    const isInside = absCandidate === absRoot
        || absCandidate.startsWith(absRoot + path.sep);

    if (!isInside) return { ok: false, reason: 'outside_root' };

    // Defensa adicional contra symlinks que escapan: si el archivo existe,
    // resolvemos por realpath y revalidamos. Si no existe todavía,
    // confiamos en la resolución lexical (el caller debería verificar
    // existsSync por separado).
    let realAbs = absCandidate;
    try {
        if (fs.existsSync(absCandidate)) {
            realAbs = fs.realpathSync(absCandidate);
            const realRoot = fs.realpathSync(absRoot);
            if (realAbs !== realRoot && !realAbs.startsWith(realRoot + path.sep)) {
                return { ok: false, reason: 'symlink_escape' };
            }
        }
    } catch {
        // Si realpath falla, caemos al resultado lexical pero marcamos:
        return { ok: false, reason: 'realpath_failed' };
    }

    const relative = path.relative(pipelineRoot, realAbs).replace(/\\/g, '/');
    return { ok: true, absolute: realAbs, relative };
}

/**
 * CA-FN-5 / CA-SEC-2 — Arma el envelope canónico HTML comment con los campos
 * de routing. Los campos se serializan a JSON one-line para que el parser de
 * `/rechazar` (#3415) pueda matchear sin ambigüedad.
 *
 * **Importante (CA-SEC-2):** `skill`, `fase` y `pipeline` DEBEN provenir del
 * caller a partir del nombre del archivo y el directorio, NUNCA de campos
 * editables por el agente dentro del YAML.
 *
 * @param {object} meta - { issue, fase, skill, pipeline, ts? }
 * @returns {string} HTML comment listo para concatenar al final del mensaje.
 */
function buildEnvelope(meta) {
    const payload = {
        issue: parseInt(meta.issue, 10),
        fase: String(meta.fase || ''),
        skill: String(meta.skill || ''),
        pipeline: String(meta.pipeline || ''),
        ts: typeof meta.ts === 'number' ? meta.ts : Math.floor(Date.now() / 1000),
    };
    // JSON one-line: el parser de #3415 hace match contra `pipeline-meta {JSON}`.
    return `<!-- pipeline-meta ${JSON.stringify(payload)} -->`;
}

/**
 * Trunca el título del issue a `max` chars con `…` si excede. Sanitiza
 * caracteres newline para que el header siempre quede en una sola línea.
 *
 * @param {string} title
 * @param {number} [max=80]
 * @returns {string}
 */
function shortenTitle(title, max) {
    const limit = typeof max === 'number' ? max : 80;
    if (typeof title !== 'string') return '';
    const oneLine = title.replace(/\s+/g, ' ').trim();
    if (oneLine.length <= limit) return oneLine;
    return oneLine.slice(0, limit - 1).trimEnd() + '…';
}

/**
 * Construye el cuerpo de texto canónico (CA-UX-1).
 *
 * Formato:
 *   <emoji> #<N> · <fase> · <skill>
 *   <título corto>
 *
 *   <preview truncado>
 *
 *   🔗 https://github.com/intrale/platform/issues/<N>
 *
 *   <envelope (invisible)>
 *
 * @param {object} input
 * @param {string|number} input.issue
 * @param {string} input.title
 * @param {string} input.fase
 * @param {string} input.skill
 * @param {string} input.pipeline
 * @param {string} input.preview - texto YA truncado, listo para incluir.
 * @param {string} input.envelope - HTML comment de `buildEnvelope`.
 * @returns {string}
 */
function buildText(input) {
    const emoji = emojiForSkill(input.skill);
    const header = `${emoji} #${input.issue}${HEADER_SEP}${input.fase}${HEADER_SEP}${input.skill}`;
    const subtitle = shortenTitle(input.title || '');
    const body = input.preview && input.preview.trim().length > 0
        ? input.preview
        : EMPTY_NOTAS_FALLBACK;
    const link = `🔗 https://github.com/intrale/platform/issues/${input.issue}`;
    const parts = [
        header,
        subtitle,
        '',
        body,
        '',
        link,
        '',
        input.envelope,
    ].filter((p) => p !== null && p !== undefined);
    return parts.join('\n');
}

/**
 * Construye el caption del adjunto PNG (CA-UX-5) — solo header + subtítulo +
 * link + envelope. Sin preview de notas (el caption de Telegram limita a 1024
 * y trunca feo).
 */
function buildCaption(input) {
    const emoji = emojiForSkill(input.skill);
    const header = `${emoji} #${input.issue}${HEADER_SEP}${input.fase}${HEADER_SEP}${input.skill}`;
    const subtitle = shortenTitle(input.title || '');
    const link = `🔗 https://github.com/intrale/platform/issues/${input.issue}`;
    return [header, subtitle, '', link, '', input.envelope].join('\n');
}

// -----------------------------------------------------------------------------
// API: buildPreview (puro)
// -----------------------------------------------------------------------------

/**
 * Genera el payload Telegram + el `auditRecord` listo para persistir. Es
 * **puro** (no toca filesystem salvo para validar existencia del PNG vía
 * `validateAttachmentPath` → `fs.existsSync`).
 *
 * El caller (pulpo) es responsable de:
 *   - decidir si encolar (en función de `config.enabled` y `config.kill_switch`)
 *   - aplicar dedup (`shouldSkipByDedup`)
 *   - escribir el dropfile Telegram
 *   - escribir el audit log
 *
 * @param {object} args
 * @param {string|number} args.issue
 * @param {string} args.skill
 * @param {string} args.fase
 * @param {string} args.pipeline
 * @param {object} args.yaml - YAML del archivo procesado (notas, photo, etc.)
 * @param {string} [args.title] - título del issue (cache por caller, opcional).
 * @param {object} args.config - bloque `deliverable_notifications`.
 * @param {string} args.pipelineRoot - cwd del repo.
 * @returns {object} { payload, auditRecord, attachmentRejected?, reason? }
 */
function buildPreview(args) {
    const {
        issue,
        skill,
        fase,
        pipeline,
        yaml,
        title,
        config,
        pipelineRoot,
    } = args;

    const cfg = config || {};
    const truncateChars = Number.isFinite(cfg.truncate_chars) ? cfg.truncate_chars : DEFAULT_TRUNCATE_CHARS;
    const attachmentRoot = typeof cfg.attachment_root === 'string' ? cfg.attachment_root : DEFAULT_ATTACHMENT_ROOT;

    const rawNotes = extractRawNotes(yaml);
    const previewTrunc = truncatePreserveLines(rawNotes, truncateChars);

    // Envelope: campos de routing tomados del CALLER (nombre archivo + dir),
    // nunca del YAML — defensa CA-SEC-2.
    const envelope = buildEnvelope({ issue, fase, skill, pipeline });

    // Resolver adjunto (solo `ux`, CA-FN-4).
    let attachment = null;
    let attachmentRejected = false;
    let rejectionReason = null;

    if (skill === 'ux') {
        const declaredPath = typeof yaml?.photo === 'string'
            ? yaml.photo
            : (typeof yaml?.mockup === 'string' ? yaml.mockup : null);

        if (declaredPath) {
            const validation = validateAttachmentPath(declaredPath, {
                root: attachmentRoot,
                pipelineRoot,
            });
            if (validation.ok && fs.existsSync(validation.absolute)) {
                attachment = {
                    absolute: validation.absolute,
                    relative: validation.relative,
                };
            } else {
                attachmentRejected = true;
                rejectionReason = validation.ok ? 'file_not_found' : validation.reason;
            }
        }
    }

    // Construir payload Telegram (text-only o foto+caption).
    let payload;
    if (attachment) {
        // sendPhoto multipart: el servicio-telegram soporta { photo: <ruta abs>, caption, parse_mode }.
        payload = {
            photo: attachment.absolute,
            caption: buildCaption({
                issue, title, fase, skill, envelope,
            }),
            parse_mode: 'Markdown',
        };
    } else {
        payload = {
            text: buildText({
                issue, title, fase, skill,
                preview: previewTrunc,
                envelope,
            }),
            parse_mode: 'Markdown',
        };
    }

    // El sanitizer de Telegram ya se aplica en `servicio-telegram.js` al leer
    // el dropfile, pero defense-in-depth: sanitizamos acá también.
    const sanitizedPayload = sanitizeTelegramPayload(payload);

    // Audit record (CA-SEC-3).
    const auditPreview = (() => {
        const source = sanitizedPayload.text || sanitizedPayload.caption || '';
        // redact defense-in-depth + truncar a 200 chars.
        const redacted = redactSensitive(source);
        const redactedStr = typeof redacted === 'string' ? redacted : String(source);
        return redactedStr.length > AUDIT_PREVIEW_MAX
            ? redactedStr.slice(0, AUDIT_PREVIEW_MAX - 1) + '…'
            : redactedStr;
    })();

    const auditRecord = {
        ts: new Date().toISOString(),
        issue: parseInt(issue, 10),
        fase: String(fase),
        skill: String(skill),
        pipeline: String(pipeline),
        // SHA-256 del notas crudo (antes del sanitize) para dedup.
        content_hash: contentHash(rawNotes),
        preview: auditPreview,
        attachment_path: attachment ? attachment.relative : null,
    };
    if (attachmentRejected) {
        auditRecord.attachment_rejected = true;
        auditRecord.attachment_reject_reason = rejectionReason || 'unknown';
    }

    return {
        payload: sanitizedPayload,
        auditRecord,
        attachmentRejected,
        rejectionReason,
    };
}

// -----------------------------------------------------------------------------
// API: dedup (CA-FN-7)
// -----------------------------------------------------------------------------

/**
 * Lee el audit JSONL (si existe) y decide si saltear por dedup. Compara la
 * tupla `(issue, skill, content_hash)` dentro de la ventana
 * `dedup_window_hours` (default 24h).
 *
 * @param {object} args
 * @param {string} args.auditPath - path absoluto al JSONL.
 * @param {string|number} args.issue
 * @param {string} args.skill
 * @param {string} args.contentHash
 * @param {number} [args.windowHours=24]
 * @returns {boolean} true si hay duplicado en la ventana → saltear.
 */
function shouldSkipByDedup(args) {
    const { auditPath, issue, skill } = args;
    const hash = args.contentHash;
    const windowHours = Number.isFinite(args.windowHours) ? args.windowHours : DEFAULT_DEDUP_HOURS;

    if (!auditPath || typeof hash !== 'string' || hash.length === 0) return false;
    if (!fs.existsSync(auditPath)) return false;

    const cutoffMs = Date.now() - windowHours * 3600 * 1000;
    let raw;
    try {
        raw = fs.readFileSync(auditPath, 'utf8');
    } catch {
        return false;
    }
    // Recorrer de adelante hacia atrás para encontrar el match más reciente
    // sin parsear todo el archivo (en realidad lo parseamos todo igual porque
    // JSONL es append-only y va a estar acotado por rotación). Costo: O(n)
    // donde n es la cantidad de entradas en la ventana de retención.
    const lines = raw.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (!entry || typeof entry !== 'object') continue;
        if (entry.skipped_dedup) continue; // ignorar los skip ya logueados
        if (entry.issue !== parseInt(issue, 10)) continue;
        if (entry.skill !== skill) continue;
        if (entry.content_hash !== hash) continue;
        // Ventana temporal:
        const tsMs = Date.parse(entry.ts || '');
        if (Number.isFinite(tsMs) && tsMs >= cutoffMs) return true;
    }
    return false;
}

// -----------------------------------------------------------------------------
// API: appendAudit (side-effect)
// -----------------------------------------------------------------------------

/**
 * Append-only JSONL. Crea el directorio padre si no existe. Idempotente —
 * si falla la escritura, captura y devuelve `false` SIN propagar.
 *
 * @param {string} auditPath - path absoluto al JSONL.
 * @param {object} record - audit record (preferiblemente desde `buildPreview`).
 * @returns {boolean} true si se persistió OK.
 */
function appendAudit(auditPath, record) {
    if (!auditPath || !record || typeof record !== 'object') return false;
    try {
        fs.mkdirSync(path.dirname(auditPath), { recursive: true });
        fs.appendFileSync(auditPath, JSON.stringify(record) + '\n', 'utf8');
        return true;
    } catch {
        return false;
    }
}

// -----------------------------------------------------------------------------
// API: notify (fachada con dedup + audit + enqueue dropfile)
// -----------------------------------------------------------------------------

/**
 * Fachada de alto nivel para el pulpo. Combina:
 *   - filtro por skill notificable
 *   - check de `enabled` y `kill_switch`
 *   - dedup
 *   - construcción de payload (`buildPreview`)
 *   - enqueue del dropfile Telegram
 *   - append al audit log
 *
 * **Garantiza zero-blocking** (CA-FN-8): cualquier error se captura y se
 * devuelve `{ ok: false, error }` sin tirar.
 *
 * @param {object} args
 * @param {string|number} args.issue
 * @param {string} args.skill
 * @param {string} args.fase
 * @param {string} args.pipeline
 * @param {object} args.yaml - YAML del archivo procesado.
 * @param {string} [args.title]
 * @param {object} args.config - bloque `deliverable_notifications` del config.yaml.
 * @param {string} args.pipelineRoot - cwd del repo.
 * @param {string} args.telegramQueueDir - dir `.pipeline/servicios/telegram/pendiente/`.
 * @param {object} [args.deps] - hooks para inyección de tests.
 * @param {function} [args.deps.now] - () => Date.now()
 * @param {function} [args.deps.writeQueueFile] - (dropfilePath, payload) => void
 * @returns {{ ok: boolean, action: string, reason?: string, payload?: object, audit?: object }}
 */
function notify(args) {
    try {
        const {
            issue, skill, fase, pipeline, yaml, title,
            config, pipelineRoot, telegramQueueDir, deps,
        } = args;

        const cfg = config || {};

        // Kill-switch / enabled — CA-FN-6.
        if (cfg.kill_switch === true) return { ok: false, action: 'skipped', reason: 'kill_switch' };
        if (cfg.enabled !== true) return { ok: false, action: 'skipped', reason: 'disabled' };

        // Skill notificable.
        const notifySkills = Array.isArray(cfg.skills) && cfg.skills.length > 0
            ? cfg.skills
            : DEFAULT_NOTIFY_SKILLS;
        if (!notifySkills.includes(skill)) {
            return { ok: false, action: 'skipped', reason: 'skill_not_notifiable' };
        }

        // Construir payload.
        const built = buildPreview({
            issue, skill, fase, pipeline, yaml, title,
            config: cfg, pipelineRoot,
        });

        // Dedup CA-FN-7.
        const auditPath = path.isAbsolute(cfg.audit_file || '')
            ? cfg.audit_file
            : path.resolve(
                pipelineRoot || process.cwd(),
                cfg.audit_file || '.pipeline/audit/deliverable-notifications.jsonl',
            );

        const windowHours = Number.isFinite(cfg.dedup_window_hours)
            ? cfg.dedup_window_hours
            : DEFAULT_DEDUP_HOURS;

        const skipDedup = shouldSkipByDedup({
            auditPath,
            issue,
            skill,
            contentHash: built.auditRecord.content_hash,
            windowHours,
        });

        if (skipDedup) {
            // Log de dedup (sin enviar Telegram, pero deja rastro).
            appendAudit(auditPath, {
                ts: new Date().toISOString(),
                issue: parseInt(issue, 10),
                fase: String(fase),
                skill: String(skill),
                pipeline: String(pipeline),
                content_hash: built.auditRecord.content_hash,
                skipped_dedup: true,
            });
            return { ok: false, action: 'skipped', reason: 'dedup' };
        }

        // Enqueue dropfile Telegram (fire-and-forget).
        const now = (deps && typeof deps.now === 'function') ? deps.now() : Date.now();
        const dropfileName = `${now}-deliverable-${issue}-${skill}.json`;
        const dropfilePath = path.join(telegramQueueDir, dropfileName);

        const writer = (deps && typeof deps.writeQueueFile === 'function')
            ? deps.writeQueueFile
            : (p, payload) => {
                fs.mkdirSync(path.dirname(p), { recursive: true });
                fs.writeFileSync(p, JSON.stringify(payload), 'utf8');
            };
        writer(dropfilePath, built.payload);

        // Audit OK.
        const finalAudit = {
            ...built.auditRecord,
            telegram_enqueue_ok: true,
            dropfile: path.basename(dropfilePath),
        };
        appendAudit(auditPath, finalAudit);

        return { ok: true, action: 'enqueued', payload: built.payload, audit: finalAudit };
    } catch (e) {
        // CA-FN-8: NUNCA propagar.
        return { ok: false, action: 'error', reason: (e && e.message) || String(e) };
    }
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------
module.exports = {
    // API pública
    notify,
    buildPreview,
    appendAudit,
    shouldSkipByDedup,

    // Constantes
    SKILL_EMOJIS,
    DEFAULT_NOTIFY_SKILLS,
    DEFAULT_TRUNCATE_CHARS,
    DEFAULT_DEDUP_HOURS,
    DEFAULT_ATTACHMENT_ROOT,
    AUDIT_PREVIEW_MAX,
    TRUNCATE_SUFFIX,
    EMPTY_NOTAS_FALLBACK,

    // Helpers (exportados para tests)
    __forTests__: {
        emojiForSkill,
        contentHash,
        truncatePreserveLines,
        extractRawNotes,
        validateAttachmentPath,
        buildEnvelope,
        shortenTitle,
        buildText,
        buildCaption,
    },
};

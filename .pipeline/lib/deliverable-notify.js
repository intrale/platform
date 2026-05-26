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
//   - CA-UX-9 (#3539):  audio TTS automático post-enqueue texto. Ver bloque
//                       AUDIO TTS más abajo y `generateAudioNotifications()`.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { sanitizeTelegramPayload } = require('./sanitize-payload');
const { redactSensitive } = require('./redact');
const { narrativeSanitizePreview } = require('./narrative-sanitize');

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
// AUDIO TTS — Issue #3539 (CA-UX-9)
// -----------------------------------------------------------------------------
// CA-FN-5 / CA-SEC-2 — particionado del texto narrado: máximo 3800 chars por
// chunk (margen vs el límite empírico ~4096 de OpenAI/Edge), respetando
// límites de oración.
const MAX_TTS_CHARS = 3800;

// CA-SEC-2 — cap absoluto de chunks para evitar quota burn por bug upstream
// (un agente que entrega 50KB de notas no debe disparar 14 audios). Si el
// particionado produce más, se trunca al chunk 3 con frase de cierre natural.
const MAX_TTS_CHUNKS = 3;

// CA-SEC-4 — timeout obligatorio por chunk TTS. Si el provider externo cuelga,
// queremos cortar y registrar `audio_error: 'timeout'` sin bloquear el resto.
const TTS_CHUNK_TIMEOUT_MS = 30000;

// CA-SEC-4 — circuit breaker local: si N timeouts seguidos dentro de la misma
// invocación, abortar el resto (probable caída del provider).
const TTS_CIRCUIT_BREAKER_TIMEOUTS = 3;

// CA-UX-5 — frase con la que se cierra el último chunk si MAX_TTS_CHUNKS
// truncó. Termina la idea para que el TTS no corte mid-sentence.
const TTS_TRUNCATION_SUFFIX = ' ... el contenido completo está en el issue.';

// CA-SEC-6 / CA-SEC-8 — root allowlisteado donde se persisten los .ogg
// generados. Listado en .gitignore. Cleanup/retención = candidate a #3544.
const DEFAULT_AUDIO_ROOT = '.pipeline/audio/notifications';

// CA-UX-1 — perfiles TTS conocidos (sincronizado con .pipeline/tts-config.json).
// Si un skill no aparece acá, se intenta cargar el perfil con su nombre y, si
// no existe en tts-config, cae a 'default' con `tts_profile_fallback: true`
// en audit.
const KNOWN_TTS_PROFILES = Object.freeze([
    'default', 'guru', 'po', 'ux', 'planner', 'security', 'qa',
]);

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
        // #3539 — los records de audio (kind:'audio') son complementarios al
        // record de texto, NO cuentan como "notificación previa" a efectos
        // de dedup. Ignorarlos.
        if (entry.kind === 'audio') continue;
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
// API: audio TTS (CA-UX-9 / #3539)
// -----------------------------------------------------------------------------

/**
 * Particiona texto en chunks de hasta `max` chars cortando en límites de
 * oración (regex `(?<=[.!?])\s+`). Aplica un cap superior de `cap` chunks
 * (CA-SEC-2 anti chunk-bombing). Si el cap se aplica, el último chunk
 * termina con `TTS_TRUNCATION_SUFFIX` para no cortar mid-sentence (CA-UX-5).
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.max=MAX_TTS_CHARS]
 * @param {number} [opts.cap=MAX_TTS_CHUNKS]
 * @returns {{ chunks: string[], truncated: boolean }}
 */
function partitionForTts(text, opts) {
    const max = (opts && Number.isFinite(opts.max)) ? opts.max : MAX_TTS_CHARS;
    const cap = (opts && Number.isFinite(opts.cap)) ? opts.cap : MAX_TTS_CHUNKS;
    if (typeof text !== 'string' || text.length === 0) return { chunks: [], truncated: false };

    if (text.length <= max) return { chunks: [text], truncated: false };

    const sentences = text.split(/(?<=[.!?])\s+/);
    const out = [];
    let current = '';
    for (const sentence of sentences) {
        if ((current + ' ' + sentence).length > max && current.length > 0) {
            out.push(current.trim());
            current = sentence;
        } else {
            current = current ? current + ' ' + sentence : sentence;
        }
    }
    if (current.trim()) out.push(current.trim());

    // Cap superior (CA-SEC-2). El último chunk conservado termina con frase
    // natural de cierre para que el TTS no corte mid-sentence (CA-UX-5).
    if (out.length > cap) {
        const truncated = out.slice(0, cap);
        truncated[cap - 1] = truncated[cap - 1] + TTS_TRUNCATION_SUFFIX;
        return { chunks: truncated, truncated: true };
    }
    return { chunks: out, truncated: false };
}

/**
 * CA-SEC-4 — Promise wrapper con timeout. Si la promise interna no resuelve
 * antes de `ms`, rechaza con un error tagged. Nunca lanza sincrónicamente.
 */
function withTimeout(promise, ms, errorTag) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            const err = new Error(errorTag || 'timeout');
            err.code = 'TTS_TIMEOUT';
            reject(err);
        }, ms);
        Promise.resolve(promise).then(
            (v) => { clearTimeout(timer); resolve(v); },
            (e) => { clearTimeout(timer); reject(e); },
        );
    });
}

/**
 * CA-UX-1 — Resuelve el perfil TTS a usar para un skill dado. Si el skill
 * está en KNOWN_TTS_PROFILES, devuelve ese mismo nombre. Si no, devuelve
 * 'default' y marca `fallback: true` para audit (CA-OBS-1 `tts_profile_fallback`).
 *
 * Hook `deps.loadTtsConfig` permite tests inyectar configuración alternativa.
 */
function resolveTtsProfile(skill, deps) {
    const skillName = typeof skill === 'string' ? skill : '';
    // Skill vacío o null: default explícito SIN flag de fallback. El flag
    // `tts_profile_fallback` indica que un skill conocido tuvo que caer
    // por no tener perfil — el caso "no había skill" es default natural.
    if (skillName.length === 0) {
        return { profile: 'default', fallback: false };
    }
    // 1) Lista hardcoded de skills conocidos (rápida).
    if (KNOWN_TTS_PROFILES.includes(skillName)) {
        return { profile: skillName, fallback: false };
    }
    // 2) Intentar leer la config (multimedia.js exporta loadTtsConfig que
    //    ya tiene fallback interno a default; usamos su flag `profileFound`).
    try {
        const loader = (deps && typeof deps.loadTtsConfig === 'function')
            ? deps.loadTtsConfig
            : require('../multimedia').loadTtsConfig;
        const cfg = loader(skillName);
        if (cfg && cfg.profileFound) return { profile: skillName, fallback: false };
    } catch {
        // Si multimedia no está disponible (tests con sandbox raro), seguimos.
    }
    return { profile: 'default', fallback: true };
}

/**
 * CA-FN-1..CA-FN-7, CA-SEC-1..5, CA-UX-1..5 — Genera audio TTS para una
 * notificación de entregable y lo envía a Telegram. Es **async**, devuelve
 * un patch de audit con los resultados que el caller debe persistir como
 * record adicional (`kind: 'audio'`) en el JSONL.
 *
 * Defensiva: nunca lanza. Cualquier error se captura y se devuelve dentro
 * del patch como `audio_error`.
 *
 * **Pipeline interno por chunk:**
 *   redactSensitive(text) → narrativeSanitize(text) → particionado →
 *   withTimeout(textToSpeechWithMeta) → fs.writeFile(.ogg) → sendVoiceTelegram
 *
 * @param {object} args
 * @param {string|number} args.issue
 * @param {string} args.skill           - skill del archivo (CA-SEC-3).
 * @param {string} args.fase
 * @param {string} args.pipeline
 * @param {string} args.narrationText   - texto base para narrar (preview YA truncado).
 * @param {string} args.contentHash     - hash para vincular con record texto.
 * @param {object} args.config          - bloque `deliverable_notifications`.
 * @param {string} args.pipelineRoot
 * @param {object} [args.deps]          - hooks de tests: textToSpeechWithMeta,
 *                                        sendVoiceTelegram, loadTelegramSecrets,
 *                                        loadTtsConfig, now, writeAudioFile.
 * @returns {Promise<object>} patch listo para appendAudit con `kind: 'audio'`.
 */
async function generateAudioNotifications(args) {
    const startedAt = Date.now();
    const {
        issue, skill, fase, pipeline,
        narrationText, contentHash: hash,
        config, pipelineRoot, deps,
    } = args;

    const cfg = config || {};
    const audioRoot = typeof cfg.audio_root === 'string' ? cfg.audio_root : DEFAULT_AUDIO_ROOT;
    const chunkTimeoutMs = Number.isFinite(cfg.tts_chunk_timeout_ms)
        ? cfg.tts_chunk_timeout_ms
        : TTS_CHUNK_TIMEOUT_MS;
    const maxChunks = Number.isFinite(cfg.max_tts_chunks)
        ? cfg.max_tts_chunks
        : MAX_TTS_CHUNKS;

    // Patch base que vamos completando.
    const basePatch = {
        ts: new Date().toISOString(),
        kind: 'audio',
        issue: parseInt(issue, 10),
        fase: String(fase || ''),
        skill: String(skill || ''),
        pipeline: String(pipeline || ''),
        content_hash: hash,
    };

    try {
        // CA-UX-1 — perfil del skill (derivado del nombre del archivo, no del YAML).
        const { profile, fallback } = resolveTtsProfile(skill, deps);
        basePatch.audio_profile = profile;
        if (fallback) basePatch.tts_profile_fallback = true;

        // CA-SEC-1 — redactar secretos ANTES de pasar al provider externo.
        // CA-UX-2 — narrative-sanitize después de redact (markdown/emojis/envelope).
        const redacted = redactSensitive(String(narrationText || ''));
        const sanitized = narrativeSanitizePreview(
            typeof redacted === 'string' ? redacted : String(narrationText || ''),
        );

        if (!sanitized || sanitized.length === 0) {
            basePatch.audio_skipped = true;
            basePatch.audio_skip_reason = 'empty_after_sanitize';
            return basePatch;
        }

        // CA-FN-5 / CA-SEC-2 — particionado con cap superior.
        const { chunks, truncated } = partitionForTts(sanitized, { max: MAX_TTS_CHARS, cap: maxChunks });
        basePatch.audio_chunks_count = chunks.length;
        basePatch.audio_truncated = truncated;

        if (chunks.length === 0) {
            basePatch.audio_skipped = true;
            basePatch.audio_skip_reason = 'empty_chunks';
            return basePatch;
        }

        // Cargar credenciales Telegram (lazy + inyectable para tests).
        let botToken = null, chatId = null;
        try {
            const loader = (deps && typeof deps.loadTelegramSecrets === 'function')
                ? deps.loadTelegramSecrets
                : require('./telegram-secrets').loadTelegramSecrets;
            const sec = loader({});
            botToken = sec.bot_token;
            chatId = sec.chat_id;
        } catch (credErr) {
            const safeMsg = (() => {
                try {
                    const redactedErr = redactSensitive(String(credErr && credErr.message || credErr));
                    return typeof redactedErr === 'string' ? redactedErr : 'credential_load_failed';
                } catch { return 'credential_load_failed'; }
            })();
            basePatch.audio_error = { code: credErr?.code || 'CREDS_MISSING', message: safeMsg };
            basePatch.audio_duration_ms = Date.now() - startedAt;
            return basePatch;
        }

        // Funciones inyectables (defaults: multimedia.js).
        const ttsFn = (deps && typeof deps.textToSpeechWithMeta === 'function')
            ? deps.textToSpeechWithMeta
            : (text, opts) => require('../multimedia').textToSpeechWithMeta(text, opts);
        const sendFn = (deps && typeof deps.sendVoiceTelegram === 'function')
            ? deps.sendVoiceTelegram
            : (buf, t, c) => require('../multimedia').sendVoiceTelegram(buf, t, c);
        const nowFn = (deps && typeof deps.now === 'function') ? deps.now : () => Date.now();
        const writerFn = (deps && typeof deps.writeAudioFile === 'function')
            ? deps.writeAudioFile
            : (absPath, buf) => {
                fs.mkdirSync(path.dirname(absPath), { recursive: true });
                fs.writeFileSync(absPath, buf);
            };

        // CA-SEC-6 — root absoluto donde persistimos los .ogg.
        const audioAbsRoot = path.isAbsolute(audioRoot)
            ? audioRoot
            : path.resolve(pipelineRoot || process.cwd(), audioRoot);

        const audioFilePaths = [];
        const chunkErrors = [];
        let consecutiveTimeouts = 0;
        const breakerLimit = TTS_CIRCUIT_BREAKER_TIMEOUTS;

        for (let i = 0; i < chunks.length; i++) {
            // CA-SEC-4 — si el breaker se abrió, abortar el resto de chunks.
            if (consecutiveTimeouts >= breakerLimit) {
                chunkErrors.push({ index: i, code: 'CIRCUIT_BREAKER', message: 'breaker_open' });
                break;
            }
            const chunkText = chunks[i];
            try {
                // CA-SEC-4 — timeout obligatorio por chunk.
                const meta = await withTimeout(
                    ttsFn(chunkText, { profile }),
                    chunkTimeoutMs,
                    `tts_timeout_chunk_${i}`,
                );
                if (!meta || !meta.buffer) {
                    chunkErrors.push({ index: i, code: 'TTS_EMPTY', message: 'sin buffer' });
                    consecutiveTimeouts = 0;
                    continue;
                }
                consecutiveTimeouts = 0;

                // CA-SEC-6 — filename determinístico bajo root validado.
                // Patrón: <ts>-<issue>-<skill>-chunk<i>.ogg
                const fname = `${nowFn()}-${parseInt(issue, 10)}-${skill}-chunk${i}.ogg`;
                const fpath = path.join(audioAbsRoot, fname);
                writerFn(fpath, meta.buffer);

                // Persistimos ruta RELATIVA al pipelineRoot (CA-SEC-6).
                const rel = path.relative(pipelineRoot || process.cwd(), fpath).replace(/\\/g, '/');
                audioFilePaths.push(rel);

                // Enviar a Telegram. Si falla, lo registramos en errores pero
                // seguimos con el resto.
                try {
                    await withTimeout(sendFn(meta.buffer, botToken, chatId), chunkTimeoutMs, 'send_timeout');
                } catch (sendErr) {
                    chunkErrors.push({ index: i, code: 'SEND_FAILED', message: safeRedact(sendErr) });
                }
            } catch (e) {
                const isTimeout = e && (e.code === 'TTS_TIMEOUT' || /timeout/i.test(String(e.message || '')));
                if (isTimeout) consecutiveTimeouts++;
                else consecutiveTimeouts = 0;
                chunkErrors.push({
                    index: i,
                    code: isTimeout ? 'TIMEOUT' : (e?.code || 'TTS_ERROR'),
                    message: safeRedact(e),
                });
            }
        }

        basePatch.audio_file_paths = audioFilePaths;
        if (chunkErrors.length > 0) {
            // CA-SEC-5 — errores ya redactados arriba.
            basePatch.audio_error = chunkErrors.length === 1
                ? chunkErrors[0]
                : { code: 'MULTI', message: `${chunkErrors.length} chunks fallaron`, details: chunkErrors };
        }
        basePatch.audio_duration_ms = Date.now() - startedAt;
        return basePatch;
    } catch (e) {
        // Defensa última — nunca propagar.
        basePatch.audio_error = { code: e?.code || 'UNEXPECTED', message: safeRedact(e) };
        basePatch.audio_duration_ms = Date.now() - startedAt;
        return basePatch;
    }
}

/**
 * CA-SEC-5 — wrapper redactado para serializar errores. Nunca incluye
 * `error.stack` ni `error.response.data` crudo: solo `.message` redactado
 * + `.code`. La idea es no leakear API keys / tokens cuando OpenAI/Edge
 * tira un 401 con el body original.
 */
function safeRedact(err) {
    try {
        const raw = String(err && err.message != null ? err.message : err);
        const out = redactSensitive(raw);
        return typeof out === 'string' ? out : raw;
    } catch {
        return 'redaction_failed';
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

        // CA-UX-9 (#3539) — si audio está habilitado y el patch del audit
        // se va a generar async, marcamos el record texto con `audio_pending`
        // para que un consumidor downstream sepa que viene un complemento.
        const audioEnabled = cfg.audio_enabled === true && cfg.kill_switch_audio !== true;

        // Audit OK del texto.
        const finalAudit = {
            ...built.auditRecord,
            telegram_enqueue_ok: true,
            dropfile: path.basename(dropfilePath),
        };
        if (audioEnabled) finalAudit.audio_pending = true;
        appendAudit(auditPath, finalAudit);

        // CA-FN-3 — audio fire-and-forget. NO awaitamos: el caller recibe
        // `audioTask` como Promise y puede dispararla sin bloquear el barrido.
        // Si el caller no la consume, igual corre en background (la Promise
        // queda viva mientras el event loop no se vacíe).
        let audioTask = null;
        if (audioEnabled) {
            // Reusamos el preview YA truncado (lo mismo que va al texto).
            const narrationText = built.payload.text || built.payload.caption || '';
            audioTask = generateAudioNotifications({
                issue, skill, fase, pipeline,
                narrationText,
                contentHash: built.auditRecord.content_hash,
                config: cfg,
                pipelineRoot,
                deps,
            }).then((patch) => {
                // CA-OBS-1 / CA-OBS-2 — appendamos UN record adicional con
                // kind:'audio' que el dedup ignora. Mantiene append-only y
                // preserva 1 record texto + 1 record audio por notificación.
                try { appendAudit(auditPath, patch); } catch {}
                return patch;
            }).catch((e) => {
                // Defensa última (generateAudioNotifications ya captura todo,
                // pero por las dudas la encadenamos).
                try {
                    appendAudit(auditPath, {
                        ts: new Date().toISOString(),
                        kind: 'audio',
                        issue: parseInt(issue, 10),
                        skill: String(skill),
                        content_hash: built.auditRecord.content_hash,
                        audio_error: { code: 'UNHANDLED', message: safeRedact(e) },
                    });
                } catch {}
                return null;
            });
        }

        return {
            ok: true,
            action: 'enqueued',
            payload: built.payload,
            audit: finalAudit,
            audioTask, // Promise<auditPatch|null> — fire-and-forget si caller no la consume.
        };
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
    // API pública — audio TTS (#3539)
    generateAudioNotifications,
    partitionForTts,
    resolveTtsProfile,

    // Constantes
    SKILL_EMOJIS,
    DEFAULT_NOTIFY_SKILLS,
    DEFAULT_TRUNCATE_CHARS,
    DEFAULT_DEDUP_HOURS,
    DEFAULT_ATTACHMENT_ROOT,
    AUDIT_PREVIEW_MAX,
    TRUNCATE_SUFFIX,
    EMPTY_NOTAS_FALLBACK,
    // Constantes — audio TTS (#3539)
    MAX_TTS_CHARS,
    MAX_TTS_CHUNKS,
    TTS_CHUNK_TIMEOUT_MS,
    TTS_CIRCUIT_BREAKER_TIMEOUTS,
    TTS_TRUNCATION_SUFFIX,
    DEFAULT_AUDIO_ROOT,
    KNOWN_TTS_PROFILES,

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
        // audio TTS
        withTimeout,
        safeRedact,
    },
};

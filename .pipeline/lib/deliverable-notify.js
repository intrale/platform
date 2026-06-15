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

const {
    sanitizeTelegramPayload,
    sanitizeDrivePayload,
    sanitizeDriveFilename,
    filenameHasSecret,
} = require('./sanitize-payload');
const { redactSensitive } = require('./redact');
const { narrativeSanitizePreview } = require('./narrative-sanitize');
const {
    mimeForPath,
    verifyMagicBytes,
    probeVideoDurationSeconds,
    MIME_TO_KIND,
} = require('./multimedia-attachment');
// #4019 — avance de ola en la notificación de entrega. `resolveWaveForIssue`
// (filesystem-only) y `runGh` (GitHub, una sola llamada sin shell) son los dos
// side-effects que viven en la capa impura (`notify`), no en `buildPreview`.
const waveResolver = require('./wave-resolver');
const gitOps = require('../skills-deterministicos/lib/git-ops');

// -----------------------------------------------------------------------------
// CA-UX-2 — Emojis canónicos fijos por skill. Cualquier skill no listado cae
// a 📦 (fallback neutral). El set debe coincidir con el subset configurado en
// `deliverable_notifications.skills`.
//
// `cua` (#3541) — skill ficticio agregador de eventos de comandos CUA. NO es
// un agente real; lo usa `notifyCua()` para discriminar las notificaciones de
// stages de comandos vs entregables de issues. Header inequívoco "⚙️ /<cmd>".
// -----------------------------------------------------------------------------
const SKILL_EMOJIS = Object.freeze({
    guru: '🔍',
    po: '📋',
    ux: '🎨',
    planner: '🗺️',
    cua: '⚙️',
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

// =============================================================================
// #3540 — Adjuntos multimedia (V1)
// =============================================================================
// Tipos soportados: document, image, video, animation. HTML diferido a V2
// (requiere DOMPurify+jsdom, ver #3547 — security agent CA-SEC-EXT-4).
//
// Convención: el agente puede declarar adjuntos de dos formas:
//   1. Forma nueva (#3540): `yaml.attachments = [{ type, path, ... }]`.
//   2. Forma legacy (#3414): `yaml.photo` o `yaml.mockup` — se mapea a
//      `attachments[0] = { type: 'image', path: <photo> }` para ux.
//
// CA-SEC-EXT-1 — roots por tipo (declarados en config.attachment_roots).
// Si un tipo no tiene root explícito, cae al `attachment_root` legacy (image).
const DEFAULT_ATTACHMENT_ROOTS = Object.freeze({
    document:  '.pipeline/assets/docs',
    image:     '.pipeline/assets/mockups',
    video:     '.pipeline/assets/videos',
    animation: '.pipeline/assets/animations',
});

// CA-SEC-EXT-5 — caps absolutos para evitar resource exhaustion.
const DEFAULT_ATTACHMENT_MAX_COUNT = 5;
const DEFAULT_ATTACHMENT_MAX_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB
const DEFAULT_VIDEO_MAX_DURATION_S = 300; // 5 min

// CA-FUNC-1 — declaración por skill de tipos+formatos esperados. Defaults
// suficientes para que skills no listados en config sigan funcionando con
// los tipos del issue. Cualquier extensión fuera de aquí va a "format_not_allowed".
const DEFAULT_ATTACHMENTS_PER_SKILL = Object.freeze({
    guru:    { types: ['document'], formats: ['.pdf', '.md'] },
    po:      { types: ['document'], formats: ['.pdf', '.md'] },
    planner: { types: ['document'], formats: ['.pdf', '.md'] },
    ux:      { types: ['image', 'video', 'animation'], formats: ['.png', '.jpg', '.jpeg', '.mp4', '.webm', '.gif'] },
    qa:      { types: ['video', 'document'], formats: ['.mp4', '.webm', '.pdf'] },
});

// CA-UX-EXT-2 — marker emoji por tipo de adjunto (segunda línea del caption).
const ATTACHMENT_TYPE_EMOJI = Object.freeze({
    document:  '📄',
    image:     '🖼️',
    video:     '🎬',
    animation: '🎞️',
});

// CA-UX-EXT-2 — etiqueta humana por tipo, para el subtítulo del caption.
const ATTACHMENT_TYPE_LABEL = Object.freeze({
    document:  'documento',
    image:     'imagen',
    video:     'video',
    animation: 'animación',
});

// CA-UX-EXT-4 — orden de envío con múltiples adjuntos:
// texto → image → document → video → animation.
const ATTACHMENT_TYPE_ORDER = Object.freeze(['image', 'document', 'video', 'animation']);

// CA-1 (#3927) — motivos de rechazo de un video que disparan encolado a Drive
// (en vez de descartar). Un video que excede tamaño/duración de Telegram igual
// puede entregarse vía Drive con link compartible.
const DRIVE_QUEUEABLE_REJECT_REASONS = new Set(['size_exceeded', 'duration_exceeded']);

// Mapeo tipo → método Telegram + nombre del field en el dropfile.
const ATTACHMENT_DROPFILE_FIELD = Object.freeze({
    document:  'document',
    image:     'photo',
    video:     'video',
    animation: 'animation',
});

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
 * Normaliza las declaraciones de adjuntos del YAML del agente a un array
 * `[{ type, path }]`. Acepta tres formas:
 *
 *   1. **Forma nueva (#3540)**: `yaml.attachments = [{ type: 'document',
 *      path: '...' }, ...]`. El `type` debe ser uno de
 *      document/image/video/animation; si falta o es inválido, se descarta.
 *
 *   2. **Legacy `yaml.photo` / `yaml.mockup`** (compat #3414): se mapea a
 *      `{ type: 'image', path: <yaml.photo|yaml.mockup> }`.
 *
 *   3. Cualquier otra forma → array vacío.
 *
 * NO valida nada — eso es responsabilidad de `resolveAttachments`. Esta
 * función solo normaliza la forma de los inputs.
 *
 * @param {object} yaml - YAML del archivo procesado.
 * @returns {Array<{ type: string, path: string, descriptor?: string }>}
 */
function normalizeAttachmentDeclarations(yaml) {
    if (!yaml || typeof yaml !== 'object') return [];
    const out = [];

    // Forma nueva.
    if (Array.isArray(yaml.attachments)) {
        for (const entry of yaml.attachments) {
            if (!entry || typeof entry !== 'object') continue;
            const type = typeof entry.type === 'string' ? entry.type.toLowerCase() : '';
            const p = typeof entry.path === 'string' ? entry.path : '';
            if (!type || !p) continue;
            out.push({
                type,
                path: p,
                descriptor: typeof entry.descriptor === 'string' ? entry.descriptor : undefined,
            });
        }
    }

    // Back-compat: photo / mockup → image. Solo se agrega si no hay ya un
    // attachment del mismo path (evita duplicados cuando el agente declara
    // ambas formas).
    const legacyPhoto = typeof yaml.photo === 'string'
        ? yaml.photo
        : (typeof yaml.mockup === 'string' ? yaml.mockup : null);
    if (legacyPhoto && !out.some((a) => a.path === legacyPhoto)) {
        out.push({ type: 'image', path: legacyPhoto });
    }

    return out;
}

/**
 * CA-UX-EXT-3 — Construye un filename legible para Telegram a partir del
 * contexto del issue y el adjunto. Patrón: `<issue>-<skill>-<descriptor>.<ext>`.
 *
 * Si el agente declaró `attachment.descriptor`, se usa como sufijo; si no, se
 * deriva del basename del archivo (sin extensión).
 *
 * Sanitiza para evitar caracteres patológicos en el filename HTTP multipart:
 * permitidos `[a-zA-Z0-9_.-]`, el resto se reemplaza por `-`.
 *
 * @param {object} args
 * @param {string|number} args.issue
 * @param {string} args.skill
 * @param {string} args.attachmentPath - path original declarado.
 * @param {string} [args.descriptor]   - override del agente.
 * @returns {string}
 */
function buildAttachmentFilename(args) {
    const issue = parseInt(args.issue, 10);
    const skill = String(args.skill || 'skill');
    const ext = path.extname(args.attachmentPath || '').toLowerCase();
    const baseDescriptor = args.descriptor
        ? args.descriptor
        : path.basename(args.attachmentPath || '', ext);
    const safe = String(baseDescriptor)
        .replace(/[^a-zA-Z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'attach';
    return `${issue}-${skill}-${safe}${ext}`;
}

/**
 * CA-FUNC-1..5 / CA-SEC-EXT-1..3,5..7 — Resuelve los adjuntos declarados:
 *
 *   - Normaliza forma (legacy + nueva).
 *   - Filtra por config.attachments_per_skill[skill].types (rechaza tipos no
 *     permitidos para ese skill).
 *   - Valida extensión contra `formats` permitidos.
 *   - Resuelve root por tipo (config.attachment_roots[type] o default).
 *   - Llama `validateAttachmentPath` (path traversal, null-byte, outside_root,
 *     symlink_escape).
 *   - Verifica magic bytes contra MIME declarado por extensión.
 *   - Verifica tamaño <= attachment_max_size_bytes (default 50 MB).
 *   - Si es video, llama probeVideoDurationSeconds y rechaza si excede
 *     video_max_duration_s (default 300s).
 *   - Aplica cap de cantidad (default 5 adjuntos).
 *
 * NUNCA tira excepción. Cada adjunto produce un record con `accepted: bool` y
 * datos suficientes para audit.
 *
 * @param {object} args
 * @param {string} args.skill
 * @param {object} args.yaml
 * @param {object} args.config
 * @param {string} args.pipelineRoot
 * @param {object} [args.deps] - hooks de tests:
 *     probeVideoDurationSeconds (override del probe ffprobe).
 * @returns {Array<object>} array de records (orden de entrada preservado).
 *     Forma de cada record cuando `accepted=true`:
 *       { accepted: true, type, mime, absolute, relative, size,
 *         filename, magic_byte_verified, duration_s? }
 *     Forma cuando `accepted=false`:
 *       { accepted: false, type, relative?, reject_reason, ...extra }
 */
function resolveAttachments(args) {
    const { skill, yaml, config, pipelineRoot, deps } = args;
    const cfg = config || {};

    const perSkillCfg = (cfg.attachments_per_skill && cfg.attachments_per_skill[skill])
        || DEFAULT_ATTACHMENTS_PER_SKILL[skill]
        || null;
    const allowedTypes = perSkillCfg && Array.isArray(perSkillCfg.types) ? perSkillCfg.types : null;
    const allowedFormats = perSkillCfg && Array.isArray(perSkillCfg.formats) ? perSkillCfg.formats : null;

    const roots = Object.assign({}, DEFAULT_ATTACHMENT_ROOTS,
        (cfg.attachment_roots && typeof cfg.attachment_roots === 'object') ? cfg.attachment_roots : {});
    // Back-compat: si el agente seteó `attachment_root` (config legacy #3414),
    // sobreescribe el de image (mockups).
    if (typeof cfg.attachment_root === 'string') {
        roots.image = cfg.attachment_root;
    }

    const maxCount = Number.isFinite(cfg.attachment_max_count)
        ? cfg.attachment_max_count
        : DEFAULT_ATTACHMENT_MAX_COUNT;
    const maxSizeBytes = Number.isFinite(cfg.attachment_max_size_bytes)
        ? cfg.attachment_max_size_bytes
        : DEFAULT_ATTACHMENT_MAX_SIZE_BYTES;
    const videoMaxDurationS = Number.isFinite(cfg.attachment_video_max_duration_s)
        ? cfg.attachment_video_max_duration_s
        : DEFAULT_VIDEO_MAX_DURATION_S;

    const declarations = normalizeAttachmentDeclarations(yaml);
    const records = [];

    for (let i = 0; i < declarations.length; i++) {
        const decl = declarations[i];

        // CA-SEC-EXT-5 — cap de cantidad. Aplicamos ANTES de procesar para no
        // gastar trabajo en adjuntos que igual no van a entrar.
        if (records.filter((r) => r.accepted).length >= maxCount) {
            records.push({
                accepted: false,
                type: decl.type,
                relative: decl.path,
                reject_reason: 'max_count_exceeded',
            });
            continue;
        }

        // CA-FUNC-1 — el tipo debe ser uno de los soportados en V1 y estar en
        // la lista permitida para el skill.
        if (!Object.prototype.hasOwnProperty.call(ATTACHMENT_DROPFILE_FIELD, decl.type)) {
            records.push({
                accepted: false,
                type: decl.type,
                relative: decl.path,
                reject_reason: 'type_not_supported',
            });
            continue;
        }
        if (allowedTypes && !allowedTypes.includes(decl.type)) {
            records.push({
                accepted: false,
                type: decl.type,
                relative: decl.path,
                reject_reason: 'type_not_allowed_for_skill',
            });
            continue;
        }

        // CA-SEC-EXT-1 — Validación de path PRIMERO (parent_segment, null_byte,
        // outside_root, symlink_escape). Va ANTES del format check porque
        // traversal/null-byte son hard-stops de seguridad: la razón del rechazo
        // debe reflejar el vector (no decir "format_not_allowed" cuando el path
        // intenta escapar del root).
        const rootForType = roots[decl.type] || DEFAULT_ATTACHMENT_ROOT;
        const validation = validateAttachmentPath(decl.path, {
            root: rootForType,
            pipelineRoot,
        });
        if (!validation.ok) {
            records.push({
                accepted: false,
                type: decl.type,
                relative: decl.path,
                reject_reason: validation.reason || 'invalid_path',
            });
            continue;
        }

        // CA-FUNC-1 — validación negativa de extensión (después de path-safety).
        const ext = path.extname(decl.path).toLowerCase();
        if (allowedFormats && !allowedFormats.includes(ext)) {
            records.push({
                accepted: false,
                type: decl.type,
                relative: validation.relative,
                reject_reason: 'format_not_allowed',
            });
            continue;
        }
        if (!fs.existsSync(validation.absolute)) {
            records.push({
                accepted: false,
                type: decl.type,
                relative: validation.relative,
                reject_reason: 'file_not_found',
            });
            continue;
        }

        // CA-SEC-EXT-5 — cap de tamaño ANTES de leer magic bytes / probe.
        let size = 0;
        try {
            const st = fs.statSync(validation.absolute);
            size = st.size;
            if (!st.isFile()) {
                records.push({
                    accepted: false,
                    type: decl.type,
                    relative: validation.relative,
                    reject_reason: 'not_a_file',
                });
                continue;
            }
        } catch {
            records.push({
                accepted: false,
                type: decl.type,
                relative: validation.relative,
                reject_reason: 'stat_failed',
            });
            continue;
        }
        if (size > maxSizeBytes) {
            records.push({
                accepted: false,
                type: decl.type,
                relative: validation.relative,
                size,
                reject_reason: 'size_exceeded',
            });
            continue;
        }
        if (size === 0) {
            records.push({
                accepted: false,
                type: decl.type,
                relative: validation.relative,
                size: 0,
                reject_reason: 'empty_file',
            });
            continue;
        }

        // CA-SEC-EXT-2 — MIME por magic bytes.
        const mime = mimeForPath(validation.absolute);
        if (!mime) {
            records.push({
                accepted: false,
                type: decl.type,
                relative: validation.relative,
                reject_reason: 'mime_unknown',
            });
            continue;
        }
        // El tipo declarado por el agente debe coincidir con el kind derivado
        // del MIME. Evita que un agente declare un .pdf como type:'image'.
        const kindByMime = MIME_TO_KIND[mime];
        if (kindByMime && kindByMime !== decl.type) {
            records.push({
                accepted: false,
                type: decl.type,
                relative: validation.relative,
                reject_reason: 'type_mime_mismatch',
            });
            continue;
        }
        const magic = verifyMagicBytes(validation.absolute, mime);
        if (!magic.ok) {
            records.push({
                accepted: false,
                type: decl.type,
                relative: validation.relative,
                reject_reason: magic.reason || 'mime_mismatch',
            });
            continue;
        }

        // CA-SEC-EXT-3 — duración para video. Animation (GIF) y document no
        // requieren probe. Si ffprobe no está disponible o falla, NO rechazamos
        // el adjunto silenciosamente — marcamos `duration_probe_failed` para
        // audit y dejamos pasar (no bloqueante, defense-in-depth contra
        // ambientes sin ffprobe). Si ffprobe responde con duración > cap,
        // rechazamos `duration_exceeded`.
        let durationS = null;
        let durationProbeFailed = false;
        if (decl.type === 'video') {
            const probeFn = (deps && typeof deps.probeVideoDurationSeconds === 'function')
                ? deps.probeVideoDurationSeconds
                : probeVideoDurationSeconds;
            try {
                const probe = probeFn(validation.absolute, {});
                if (probe && probe.ok) {
                    durationS = probe.duration_s;
                    if (durationS > videoMaxDurationS) {
                        records.push({
                            accepted: false,
                            type: decl.type,
                            relative: validation.relative,
                            size,
                            duration_s: durationS,
                            reject_reason: 'duration_exceeded',
                        });
                        continue;
                    }
                } else {
                    durationProbeFailed = true;
                }
            } catch {
                durationProbeFailed = true;
            }
        }

        const filename = buildAttachmentFilename({
            issue: args.issue,
            skill,
            attachmentPath: decl.path,
            descriptor: decl.descriptor,
        });

        const record = {
            accepted: true,
            type: decl.type,
            mime,
            absolute: validation.absolute,
            relative: validation.relative,
            size,
            filename,
            magic_byte_verified: magic.skipped !== true,
        };
        if (durationS !== null) record.duration_s = durationS;
        if (durationProbeFailed) record.duration_probe_failed = true;

        records.push(record);
    }

    return records;
}

/**
 * CA-UX-EXT-1 / CA-UX-EXT-2 — Caption canónico para un adjunto. Reusa el
 * header del preview de texto + agrega subtítulo con marker emoji del tipo
 * + link + envelope. CA-UX-EXT-7: <1024 chars (sin preview de notas).
 *
 * @param {object} input
 * @param {string|number} input.issue
 * @param {string} input.title
 * @param {string} input.fase
 * @param {string} input.skill
 * @param {string} input.envelope
 * @param {string} input.attachmentType - document/image/video/animation
 * @returns {string}
 */
function buildAttachmentCaption(input) {
    const emoji = emojiForSkill(input.skill);
    const header = `${emoji} #${input.issue}${HEADER_SEP}${input.fase}${HEADER_SEP}${input.skill}`;
    const subtitle = shortenTitle(input.title || '');
    const typeMarker = ATTACHMENT_TYPE_EMOJI[input.attachmentType] || '';
    const typeLabel = ATTACHMENT_TYPE_LABEL[input.attachmentType] || input.attachmentType || '';
    const typeLine = typeMarker ? `${typeMarker} ${typeLabel}` : typeLabel;
    const link = `🔗 https://github.com/intrale/platform/issues/${input.issue}`;
    return [header, subtitle, typeLine, '', link, '', input.envelope]
        .filter((p) => p !== null && p !== undefined && p !== '')
        .join('\n');
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
    // #4019 — sección de avance de ola: va DESPUÉS del cuerpo y ANTES del link
    // (G-1). Se omite si viene vacía o no es string (CA-4: notificación intacta).
    const wave = typeof input.waveProgress === 'string' && input.waveProgress.trim().length > 0
        ? input.waveProgress.trim()
        : null;
    const parts = [
        header,
        subtitle,
        '',
        body,
        ...(wave ? ['', wave] : []),
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
// #4019 — Sección de avance de ola en la notificación de entrega.
// -----------------------------------------------------------------------------

// Cantidad máxima de issues abiertos a listar antes de truncar (G-5, alineado
// con la convención `slice(0, MAX)` + `(+N)` de wave-renderer.js).
const WAVE_OPEN_LIST_MAX = 8;

// Límite de `gh issue list`. `gh` devuelve los N issues más recientes del repo
// (no filtrados por ola), así que un límite chico (p.ej. 30) puede dejar afuera
// issues de olas que arrancaron hace muchos issues. 500 cubre con holgura la
// ola activa y las recientes; las olas muy viejas degradan con gracia (los
// issues no devueltos se cuentan como "no cerrados", nunca como cerrados, para
// no declarar una ola finalizada por error — CA-2 + CA-5).
const WAVE_GH_LIST_LIMIT = 500;

/**
 * Formatea el listado de issues abiertos truncando si es largo (G-5).
 *   `#1, #2, #3 … (+5)`
 *
 * @param {number[]} openNums - números de issue abiertos (ya ordenados).
 * @returns {string}
 */
function formatOpenIssueList(openNums) {
    const visible = openNums.slice(0, WAVE_OPEN_LIST_MAX);
    const hidden = openNums.length - visible.length;
    const base = visible.map((n) => `#${n}`).join(', ');
    return hidden > 0 ? `${base} … (+${hidden})` : base;
}

/**
 * Construye la línea de avance de la ola a la que pertenece el issue entregado
 * (CA-1/CA-2). Es la **única capa impura** de este flujo: lee `waves.json`
 * (filesystem) y consulta el estado real de GitHub (`gh issue list`, una sola
 * llamada sin shell). Por eso vive fuera de `buildPreview`/`buildText`, que
 * permanecen puros y reciben el string ya calculado vía `waveProgress`.
 *
 * Garantías de resiliencia (CA-5): nunca tira. Ante cualquier fallo (issue sin
 * ola, `waves.json` ilegible, `gh` con error, JSON inválido) devuelve `null` y
 * la notificación se entrega sin la sección, como hoy (CA-4).
 *
 * Seguridad (CA-6): los números de issue se castean a int positivo en
 * `resolveWaveForIssue` (vía `normalizeIssueNumber`); la única llamada a `gh`
 * usa `runGh` con array de args y `shell:false` (sin interpolación shell); el
 * listado solo incluye números de issue (sin títulos atacante-controlables).
 *
 * @param {object} args
 * @param {string|number} args.issue
 * @param {string} args.pipelineRoot
 * @param {object} [args.deps] - inyección para tests: { resolveWaveForIssue, runGh, logger }.
 * @returns {string|null} línea de avance o `null` si no aplica / falla.
 */
function buildWaveProgressSection(args) {
    const { issue, pipelineRoot, deps } = args || {};
    const resolveWave = (deps && deps.resolveWaveForIssue) || waveResolver.resolveWaveForIssue;
    const runGh = (deps && deps.runGh) || gitOps.runGh;
    const logFail = (deps && typeof deps.logFail === 'function')
        ? deps.logFail
        : () => {};

    try {
        // CA-4 — issue sin ola → sin sección, comportamiento de hoy.
        const wave = resolveWave(issue, { pipelineRoot });
        if (!wave) return null;

        const waveIssues = Array.isArray(wave.issues) ? wave.issues : [];
        const total = waveIssues.length;
        if (total === 0) return null;

        // CA-3/CA-6 — estado fresco de GitHub, una sola llamada, sin shell.
        const limit = Math.max(total, WAVE_GH_LIST_LIMIT);
        const res = runGh([
            'issue', 'list',
            '--repo', 'intrale/platform',
            '--state', 'all',
            '--json', 'number,state',
            '--limit', String(limit),
        ]);

        // CA-5 — degradación elegante: cualquier fallo de gh → sin sección.
        if (!res || res.exit_code !== 0 || typeof res.stdout !== 'string' || !res.stdout.trim()) {
            logFail('gh issue list falló o vino vacío', res && res.stderr);
            return null;
        }

        let states;
        try {
            states = JSON.parse(res.stdout);
        } catch (e) {
            logFail('JSON inválido de gh issue list', e && e.message);
            return null;
        }
        if (!Array.isArray(states)) return null;

        const waveSet = new Set(waveIssues);
        const inWave = states.filter(
            (s) => s && typeof s.number === 'number' && waveSet.has(s.number),
        );
        const openNums = inWave
            .filter((s) => s.state === 'OPEN')
            .map((s) => s.number)
            .sort((a, b) => a - b);

        // Issues de la ola que `gh` no devolvió (límite / no existen). Se cuentan
        // como "no cerrados" para nunca declarar una ola finalizada de más.
        const unknown = total - inWave.length;
        const open = openNums.length + unknown;
        const closed = total - open;

        const waveLabel = wave.number != null ? `Ola ${wave.number}` : 'Ola';

        // CA-2 — último issue: ola finalizada.
        if (open === 0) {
            const next = wave.number != null
                ? `la Ola ${wave.number + 1}`
                : 'la siguiente ola';
            return `🎉 ${waveLabel} finalizada — ${total}/${total} cerradas. `
                + `Sugerencia: habilitá ${next} para arrancar.`;
        }

        // CA-1 — avance intermedio.
        const pct = Math.round((closed / total) * 100);
        const plural = open === 1 ? 'abierta' : 'abiertas';
        const lista = formatOpenIssueList(openNums);
        return `🌊 ${waveLabel} — ${closed}/${total} cerradas (${pct}%) · `
            + `quedan ${open} ${plural}: ${lista}`;
    } catch (e) {
        // CA-5 — jamás romper la notificación de entrega por el avance de ola.
        logFail('excepción inesperada en buildWaveProgressSection', e && e.message);
        return null;
    }
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
        waveProgress,
    } = args;

    const cfg = config || {};
    const truncateChars = Number.isFinite(cfg.truncate_chars) ? cfg.truncate_chars : DEFAULT_TRUNCATE_CHARS;

    const rawNotes = extractRawNotes(yaml);
    const previewTrunc = truncatePreserveLines(rawNotes, truncateChars);

    // Envelope: campos de routing tomados del CALLER (nombre archivo + dir),
    // nunca del YAML — defensa CA-SEC-2.
    const envelope = buildEnvelope({ issue, fase, skill, pipeline });

    // #3540 — Resolución de adjuntos. resolveAttachments() acepta tanto la
    // forma legacy (yaml.photo/yaml.mockup) como la nueva (yaml.attachments[]).
    const attachmentRecords = resolveAttachments({
        issue,
        skill,
        yaml,
        config: cfg,
        pipelineRoot,
        deps: args.deps,
    });
    const accepted = attachmentRecords.filter((r) => r.accepted);
    const rejected = attachmentRecords.filter((r) => !r.accepted);

    // Modo legacy (#3414): si el agente solo declaró `photo`/`mockup` (sin
    // `attachments[]`) Y el resultado es exactamente UN adjunto aceptado,
    // preservamos el comportamiento histórico: sendPhoto + caption corto en
    // el primer (único) mensaje. Esto preserva compat con tests/callers que
    // dependen de `out.payload.photo`.
    const declaredArray = Array.isArray(yaml && yaml.attachments);
    const declaredLegacyPhoto = !declaredArray
        && (typeof (yaml && yaml.photo) === 'string'
            || typeof (yaml && yaml.mockup) === 'string');
    const isLegacySinglePhotoMode = declaredLegacyPhoto
        && accepted.length === 1
        && accepted[0].type === 'image';

    // CA-1 (#3927) — videos que exceden los límites de Telegram NO se descartan:
    // se encolan a la cola de Drive (`servicios/drive/pendiente/`) en vez de
    // perderse. Detectamos los records de tipo `video` rechazados por tamaño o
    // duración y construimos un job sanitizado que `notify` persistirá (el
    // encolado es un side effect → vive en `notify`, no acá; buildPreview es puro).
    const driveQueued = rejected.filter(
        (r) => r.type === 'video' && DRIVE_QUEUEABLE_REJECT_REASONS.has(r.reject_reason),
    );
    const driveJobs = driveQueued.map((r) => {
        const relativeVideoPath = typeof r.relative === 'string' ? r.relative : '';
        const rawBasename = relativeVideoPath ? path.basename(relativeVideoPath) : '';
        // RS-1 — si el basename del video contiene un patrón de secreto, derivamos
        // un nombre seguro (mismo tratamiento que aplica `processJob` al subir).
        // `file` conserva la ruta real (necesaria para resolver el archivo);
        // `filename` lleva el nombre seguro para metadata/mensajes downstream.
        const safeBasename = filenameHasSecret(rawBasename)
            ? sanitizeDriveFilename(rawBasename)
            : rawBasename;
        // RS-1 — el payload pasa por `sanitizeDrivePayload` ANTES de persistir,
        // igual que hace `processJob` al leer. No se introduce un camino que
        // evada los sanitizers.
        const payload = sanitizeDrivePayload({
            file: relativeVideoPath,
            issue: parseInt(issue, 10),
            title: typeof title === 'string' ? title : '',
            filename: safeBasename,
            // `description` redundante: permite que `servicio-drive` resuelva el
            // issue aunque corra una versión previa del consumidor.
            description: `Video QA del issue #${parseInt(issue, 10)}`,
            source: 'deliverable-notify',
            reject_reason: r.reject_reason,
        });
        return { payload };
    });

    // CA-UX-EXT-5 — footer no-alarmista cuando hay rechazos. NO menciona los
    // motivos técnicos, solo cantidad y referencia al issue.
    //
    // CA-2 / UX-1 (#3927) — un video encolado a Drive NO es un "adjunto omitido":
    // no se pierde, llega en breve. Su aviso debe ser forward-looking y separado
    // del footer de adjuntos realmente descartados (formato no soportado, etc.).
    const trulyOmitted = rejected.filter((r) => !driveQueued.includes(r));
    let footerNote = '';
    if (driveQueued.length > 0) {
        const n = driveQueued.length;
        const plural = n === 1 ? '' : 's';
        const verbo = n === 1 ? 'superó' : 'superaron';
        const subiendo = n === 1 ? 'subiendo' : 'subiendo';
        footerNote += `\n\n📹 ${n} video${plural} ${verbo} el límite de Telegram — lo estoy ${subiendo} a Drive, el link llega en breve.`;
    }
    if (trulyOmitted.length > 0) {
        const n = trulyOmitted.length;
        const plural = n === 1 ? '' : 's';
        footerNote += `\n\n_Nota: ${n} adjunto${plural} omitido${plural} (formato no soportado o tamaño excedido). Ver issue completo._`;
    }

    let payload;
    const extraDropfiles = [];

    if (isLegacySinglePhotoMode) {
        // Comportamiento legacy preservado (#3414).
        const a = accepted[0];
        payload = {
            photo: a.absolute,
            caption: buildCaption({ issue, title, fase, skill, envelope }),
            parse_mode: 'Markdown',
            filename: a.filename,
        };
    } else if (accepted.length === 0) {
        // Sin adjuntos válidos: text-only (igual con/ sin rechazos).
        const textBody = (previewTrunc || '') + footerNote;
        payload = {
            text: buildText({
                issue, title, fase, skill,
                preview: textBody,
                envelope,
                waveProgress,
            }),
            parse_mode: 'Markdown',
        };
    } else {
        // V1 multi-adjunto: CA-UX-EXT-4 fija el orden texto → image → document
        // → video → animation. El payload principal es texto; los adjuntos van
        // en extraDropfiles.
        const textBody = (previewTrunc || '') + footerNote;
        payload = {
            text: buildText({
                issue, title, fase, skill,
                preview: textBody,
                envelope,
                waveProgress,
            }),
            parse_mode: 'Markdown',
        };
        const ordered = [...accepted].sort((a, b) => {
            const ia = ATTACHMENT_TYPE_ORDER.indexOf(a.type);
            const ib = ATTACHMENT_TYPE_ORDER.indexOf(b.type);
            return ia - ib;
        });
        for (const a of ordered) {
            const fieldName = ATTACHMENT_DROPFILE_FIELD[a.type];
            if (!fieldName) continue; // tipo no soportado (defensa)
            const dropPayload = {
                [fieldName]: a.absolute,
                caption: buildAttachmentCaption({
                    issue, title, fase, skill, envelope,
                    attachmentType: a.type,
                }),
                parse_mode: 'Markdown',
                filename: a.filename,
            };
            extraDropfiles.push(sanitizeTelegramPayload(dropPayload));
        }
    }

    // El sanitizer de Telegram ya se aplica en `servicio-telegram.js` al leer
    // el dropfile, pero defense-in-depth: sanitizamos acá también.
    const sanitizedPayload = sanitizeTelegramPayload(payload);

    // Audit record (CA-SEC-3 + CA-SEC-EXT-6).
    const auditPreview = (() => {
        const source = sanitizedPayload.text || sanitizedPayload.caption || '';
        // redact defense-in-depth + truncar a 200 chars.
        const redacted = redactSensitive(source);
        const redactedStr = typeof redacted === 'string' ? redacted : String(source);
        return redactedStr.length > AUDIT_PREVIEW_MAX
            ? redactedStr.slice(0, AUDIT_PREVIEW_MAX - 1) + '…'
            : redactedStr;
    })();

    // CA-SEC-EXT-6 — array `attachments[]` solo con paths relativos + metadata
    // segura. Sin `absolute`. Pasamos cada record por `redactSensitive` defense-
    // in-depth aunque hoy paths no contengan secrets (mantiene la barrera).
    const attachmentsAudit = attachmentRecords.map((r) => {
        const rec = {
            type: r.type,
            path: typeof r.relative === 'string' ? r.relative : null,
            mime: r.mime || null,
            size: Number.isFinite(r.size) ? r.size : null,
            sent_ok: r.accepted === true,
        };
        if (r.accepted) {
            if (r.duration_s != null) rec.duration_s = r.duration_s;
            if (r.duration_probe_failed) rec.duration_probe_failed = true;
            if (typeof r.magic_byte_verified === 'boolean') {
                rec.magic_byte_verified = r.magic_byte_verified;
            }
            if (typeof r.filename === 'string') rec.filename = r.filename;
        } else {
            rec.reject_reason = r.reject_reason || 'unknown';
        }
        // Redact defense-in-depth sobre el path (paths con tokens en URLs raros).
        if (typeof rec.path === 'string') {
            const redacted = redactSensitive(rec.path);
            if (typeof redacted === 'string') rec.path = redacted;
        }
        return rec;
    });

    // Campos legacy preservados para back-compat (#3414).
    const legacyFirstAccepted = accepted.find((r) => r.type === 'image') || accepted[0] || null;
    const legacyFirstRejected = rejected[0] || null;

    const auditRecord = {
        ts: new Date().toISOString(),
        issue: parseInt(issue, 10),
        fase: String(fase),
        skill: String(skill),
        pipeline: String(pipeline),
        // SHA-256 del notas crudo (antes del sanitize) para dedup.
        content_hash: contentHash(rawNotes),
        preview: auditPreview,
        // Legacy: primer adjunto aceptado (o null).
        attachment_path: legacyFirstAccepted ? legacyFirstAccepted.relative : null,
    };
    if (attachmentsAudit.length > 0) {
        auditRecord.attachments = attachmentsAudit;
    }
    if (legacyFirstRejected) {
        auditRecord.attachment_rejected = true;
        auditRecord.attachment_reject_reason = legacyFirstRejected.reject_reason || 'unknown';
    }

    return {
        payload: sanitizedPayload,
        auditRecord,
        attachments: attachmentRecords,
        extraDropfiles,
        // CA-1 (#3927) — jobs de Drive a encolar (los escribe `notify`).
        driveJobs,
        // Legacy fields para back-compat con callers actuales:
        attachmentRejected: rejected.length > 0,
        rejectionReason: legacyFirstRejected ? legacyFirstRejected.reject_reason : null,
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

        // #4019 — avance de ola SOLO en la entrega (delivery/entrega). Es un
        // side-effect (lee waves.json + consulta GitHub), por eso se calcula acá
        // (capa impura) y se pasa ya resuelto como string a `buildPreview`, que
        // permanece puro. Resiliente: `buildWaveProgressSection` nunca tira y
        // devuelve `null` ante cualquier fallo (CA-4/CA-5).
        let waveProgress = null;
        if (skill === 'delivery' && fase === 'entrega') {
            waveProgress = buildWaveProgressSection({
                issue,
                pipelineRoot,
                deps: deps && deps.waveDeps,
            });
        }

        // Construir payload.
        const built = buildPreview({
            issue, skill, fase, pipeline, yaml, title,
            config: cfg, pipelineRoot, waveProgress,
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

        // Enqueue dropfile(s) Telegram (fire-and-forget).
        // #3540 — soporta múltiples dropfiles (texto + 0..N adjuntos). El
        // orden viene de buildPreview (text → image → document → video →
        // animation). Cada uno tiene un timestamp incremental (now + idx)
        // para que el servicio-telegram los procese en orden lexical estable.
        const now = (deps && typeof deps.now === 'function') ? deps.now() : Date.now();
        const writer = (deps && typeof deps.writeQueueFile === 'function')
            ? deps.writeQueueFile
            : (p, payload) => {
                fs.mkdirSync(path.dirname(p), { recursive: true });
                fs.writeFileSync(p, JSON.stringify(payload), 'utf8');
            };

        const allDropfiles = [built.payload, ...(built.extraDropfiles || [])];
        const dropfileNames = [];
        for (let i = 0; i < allDropfiles.length; i++) {
            // ts incremental para preservar el orden de envío. El servicio
            // ordena por nombre de archivo (timestamp + sufijo).
            const ts = now + i;
            // Si hay extras, agregamos un sufijo `-NN` para distinguirlos en disco.
            const suffix = allDropfiles.length > 1 ? `-${String(i).padStart(2, '0')}` : '';
            const dropfileName = `${ts}-deliverable-${issue}-${skill}${suffix}.json`;
            const dropfilePath = path.join(telegramQueueDir, dropfileName);
            writer(dropfilePath, allDropfiles[i]);
            dropfileNames.push(path.basename(dropfilePath));
        }
        const firstDropfileName = dropfileNames[0];

        // CA-1 (#3927) — encolar a Drive los videos que excedieron los límites de
        // Telegram. Es un side effect (igual que escribir el dropfile Telegram):
        // por eso vive acá y no en `buildPreview`. El payload ya viene sanitizado
        // (RS-1) desde `buildPreview`. Fire-and-forget: el `servicio-drive` lo
        // tomará de la cola y posteará el `webViewLink` a Telegram (CA-2 msg-2).
        const driveJobs = Array.isArray(built.driveJobs) ? built.driveJobs : [];
        const driveJobNames = [];
        if (driveJobs.length > 0) {
            const driveQueueDir = args.driveQueueDir
                || path.resolve(
                    pipelineRoot || process.cwd(),
                    '.pipeline/servicios/drive/pendiente',
                );
            for (let i = 0; i < driveJobs.length; i++) {
                const ts = now + i;
                const jobName = `drive-${issue}-${ts}-${String(i).padStart(2, '0')}.json`;
                const jobPath = path.join(driveQueueDir, jobName);
                try {
                    writer(jobPath, driveJobs[i].payload);
                    driveJobNames.push(jobName);
                } catch (err) {
                    // No propagamos: una falla al encolar no debe romper el envío
                    // del texto ya escrito. Queda registro en el audit.
                    // eslint-disable-next-line no-console
                    console.warn(`[deliverable-notify] no se pudo encolar a Drive ${jobPath}: ${err.message}`);
                }
            }
        }

        // CA-UX-9 (#3539) — si audio está habilitado y el patch del audit
        // se va a generar async, marcamos el record texto con `audio_pending`
        // para que un consumidor downstream sepa que viene un complemento.
        const audioEnabled = cfg.audio_enabled === true && cfg.kill_switch_audio !== true;

        // Audit OK del texto.
        const finalAudit = {
            ...built.auditRecord,
            telegram_enqueue_ok: true,
            dropfile: firstDropfileName,
        };
        if (dropfileNames.length > 1) {
            finalAudit.dropfiles = dropfileNames;
        }
        // CA-1 (#3927) — trazabilidad del encolado a Drive en el audit.
        if (driveJobNames.length > 0) {
            finalAudit.drive_enqueued = driveJobNames.length;
            finalAudit.drive_jobs = driveJobNames;
        }
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
            // CA-1 (#3927) — nombres de los jobs encolados a Drive (vacío si ninguno).
            driveJobs: driveJobNames,
            audioTask, // Promise<auditPatch|null> — fire-and-forget si caller no la consume.
        };
    } catch (e) {
        // CA-FN-8: NUNCA propagar.
        return { ok: false, action: 'error', reason: (e && e.message) || String(e) };
    }
}

// =============================================================================
// CUA — Entregables parciales del Comando de Usuario Asistido (issue #3541)
// =============================================================================
//
// La superficie CUA es paralela a la de issues: el operador ejecuta comandos
// (ej. `/cargar-ola n11`) y cada comando tiene stages internos notificables
// (`init`, `validation`, `analysis`, `completion`). `notifyCua()` arma el
// payload Telegram + el audit record exactamente como `notify()` lo hace para
// issues, pero discriminando por `command` en lugar de `issue`.
//
// CA mapping del issue #3541:
//   - CA-FUNC-1 / CA-SEC-4 — schema CUA validado con Ajv en runtime.
//   - CA-FUNC-2 — skill ficticio `cua` + envelope con `command`.
//   - CA-FUNC-3 / CA-UX-3 — audio TTS con `redactSensitive` previo.
//   - CA-FUNC-4 / CA-SEC-1 / CA-SEC-2 / CA-SEC-5 — adjuntos con whitelist de
//     extensiones + cap de tamaño + root hardcodeado.
//   - CA-FUNC-7 / CA-SEC-8 — audit con `command` (string) + `issue: null` y
//     dedup key `sha256(command + stage + ts_minuto + preview_hash)`.
//   - CA-UX-1..5 — emojis de status, copy reglado, header `⚙️ /<cmd> — <stage>`.
//   - CA-SEC-3 — whitelist + regex de `command`.
//   - CA-SEC-7 — redact ANTES del TTS (igual que notify de issues).
// =============================================================================

// CA-SEC-1 — Whitelist hardcodeada de extensiones permitidas para sendDocument
// CUA. NO configurable (defensa contra tampering desde config.yaml). Cualquier
// extensión fuera de esta lista (.exe/.bat/.sh/.ps1/.cmd/.scr/.js/.html/.lnk…)
// se rechaza con audit `attachment_rejected: extension_not_allowed`.
const ALLOWED_CUA_EXTENSIONS = Object.freeze([
    'json', 'csv', 'xlsx', 'pdf', 'txt', 'md', 'log',
]);

// CA-SEC-2 — Cap por defecto del tamaño de adjuntos CUA. Configurable vía
// `cua.max_attachment_bytes` en config.yaml, default 5 MB. Anti DoS al bot y
// anti exfil masiva accidental.
const DEFAULT_CUA_MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

// CA-SEC-5 — Root hardcodeado donde CUA persiste sus outputs. El path-traversal
// (CA-SEC-1 del patrón #3414) se aplica con este root. Solo es configurable el
// subdirectorio bajo este root (`cua.attachment_subroot`), nunca el root mismo
// — ningún caller puede declarar una ruta absoluta.
const CUA_ATTACHMENT_ROOT = '.pipeline/cua-outputs';

// CA-UX-7 — Ventana de dedup default para CUA. NO heredamos las 24h del patrón
// de issues — el operador corre comandos varias veces el mismo día, 24h
// silenciaría notificaciones legítimas. Default 1h, configurable vía
// `cua.dedup_window_hours` en config.yaml.
const DEFAULT_CUA_DEDUP_HOURS = 1;

// CA-SEC-3 — Regex defensiva de `command`. Refuerza la pertenencia a la
// whitelist `cua.allowed_commands`. Doble validación = defense-in-depth.
const CUA_COMMAND_REGEX = /^[a-z][a-z0-9-]{0,40}$/;

// CA-UX-1 — Iconografía de status documentada por el ux agent. La tabla está
// codificada acá para que el copy del preview/header sea consistente.
const CUA_STATUS_EMOJIS = Object.freeze({
    init: '⏳',
    validation_ok: '✅',
    validation_fail: '❌',
    analysis: '🔍',
    completion_ok: '🎯',
    completion_fail: '⚠️',
    in_progress: '🔄',
});

// CA-UX-1 — Emoji de adjunto adjunto al footer si el entregable trae archivo.
const CUA_ATTACHMENT_EMOJI = '📎';

// CA-UX-2 — Cap absoluto del preview narrable. Más largo se trunca con
// `TRUNCATE_SUFFIX` (igual que en notify de issues).
const CUA_PREVIEW_NARRABLE_MAX = 200;

// CA-SEC-4 — Cache del compilador Ajv. Se carga una sola vez por proceso.
let _cuaSchemaValidator = null;

/**
 * CA-SEC-4 — Carga + compila el schema CUA con Ajv draft-07. Cachea el
 * validator para evitar recompilar en cada notificación.
 *
 * @param {object} [deps] - hooks de tests (loadSchema, ajv).
 * @returns {{ ok: boolean, validate?: function, error?: string }}
 */
function getCuaSchemaValidator(deps) {
    if (_cuaSchemaValidator) return { ok: true, validate: _cuaSchemaValidator };

    try {
        // Permitir inyección directa de un validator pre-compilado (tests).
        if (deps && typeof deps.cuaSchemaValidator === 'function') {
            _cuaSchemaValidator = deps.cuaSchemaValidator;
            return { ok: true, validate: _cuaSchemaValidator };
        }

        const Ajv = (deps && deps.ajv)
            ? deps.ajv
            : require('ajv');
        const loadSchema = (deps && typeof deps.loadSchema === 'function')
            ? deps.loadSchema
            : () => {
                const schemaPath = path.resolve(
                    __dirname, '..', 'esquemas', 'cua-entregable.schema.json',
                );
                return JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
            };
        const schema = loadSchema();
        const ajv = new Ajv({ allErrors: true, strict: false });
        _cuaSchemaValidator = ajv.compile(schema);
        return { ok: true, validate: _cuaSchemaValidator };
    } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) };
    }
}

/**
 * CA-SEC-4 — Resetea la cache del validator (solo tests).
 */
function __resetCuaSchemaValidator() {
    _cuaSchemaValidator = null;
}

/**
 * CA-SEC-3 — Valida que el `command` esté en la whitelist explícita Y matchee
 * la regex defensiva. Falla cualquier check → reject con motivo discriminable.
 *
 * @param {string} command
 * @param {string[]} allowedCommands - lista de cua.allowed_commands del config.
 * @returns {{ ok: boolean, reason?: string }}
 */
function validateCuaCommand(command, allowedCommands) {
    if (typeof command !== 'string' || command.length === 0) {
        return { ok: false, reason: 'empty_command' };
    }
    if (!CUA_COMMAND_REGEX.test(command)) {
        return { ok: false, reason: 'command_regex_mismatch' };
    }
    if (!Array.isArray(allowedCommands) || allowedCommands.length === 0) {
        // Sin whitelist configurada → fail closed (rechazar antes que
        // permitir cualquier `command`).
        return { ok: false, reason: 'no_allowed_commands_configured' };
    }
    if (!allowedCommands.includes(command)) {
        return { ok: false, reason: 'command_not_in_whitelist' };
    }
    return { ok: true };
}

/**
 * CA-SEC-1 — Devuelve la extensión normalizada (lowercase, sin punto) del path.
 * Acepta tanto `.json` como `json`.
 */
function _normalizeExt(input) {
    if (typeof input !== 'string') return '';
    return input.replace(/^\./, '').toLowerCase();
}

/**
 * CA-SEC-1 / CA-SEC-2 — Valida el adjunto CUA: whitelist de extensión,
 * coherencia extensión declarada vs extensión real, existencia, tamaño bajo
 * cap configurado, path-traversal contra `CUA_ATTACHMENT_ROOT`. NUNCA lanza.
 *
 * @param {object} attachment - { type, path, filename?, caption? }
 * @param {object} opts
 * @param {string} opts.pipelineRoot
 * @param {string} [opts.subroot] - subdir bajo CUA_ATTACHMENT_ROOT.
 * @param {number} [opts.maxBytes] - default DEFAULT_CUA_MAX_ATTACHMENT_BYTES.
 * @returns {{ ok: boolean, absolute?: string, relative?: string, sizeBytes?: number, reason?: string }}
 */
function validateCuaAttachment(attachment, opts) {
    if (!attachment || typeof attachment !== 'object') {
        return { ok: false, reason: 'attachment_missing' };
    }
    const declaredType = _normalizeExt(attachment.type);
    const declaredPath = typeof attachment.path === 'string' ? attachment.path : '';
    const maxBytes = (opts && Number.isFinite(opts.maxBytes))
        ? opts.maxBytes
        : DEFAULT_CUA_MAX_ATTACHMENT_BYTES;
    const subroot = (opts && typeof opts.subroot === 'string' && opts.subroot.length > 0)
        ? opts.subroot
        : '';
    const pipelineRoot = (opts && opts.pipelineRoot) || process.cwd();

    if (!ALLOWED_CUA_EXTENSIONS.includes(declaredType)) {
        return { ok: false, reason: 'extension_not_allowed' };
    }
    if (declaredPath.length === 0) {
        return { ok: false, reason: 'empty_path' };
    }

    // CA-SEC-5: root hardcodeado + subroot opcional configurable. Lo
    // verificamos PRIMERO (path traversal es el flag más crítico — si llega
    // un `..` o un path fuera del root no queremos emitir un motivo
    // secundario como extension_mismatch).
    const effectiveRoot = subroot.length > 0
        ? path.join(CUA_ATTACHMENT_ROOT, subroot)
        : CUA_ATTACHMENT_ROOT;
    const validation = validateAttachmentPath(declaredPath, {
        root: effectiveRoot,
        pipelineRoot,
    });
    if (!validation.ok) {
        return { ok: false, reason: validation.reason || 'path_invalid' };
    }

    // Defense in depth: la extensión real del archivo debe coincidir con la
    // declarada. Esto bloquea casos como `attachment.type: 'json'` + `path:
    // 'malware.exe'` (que pasaría la whitelist de `type` pero el archivo es
    // ejecutable).
    const realExt = _normalizeExt(path.extname(declaredPath));
    if (realExt !== declaredType) {
        return { ok: false, reason: 'extension_mismatch' };
    }
    if (!fs.existsSync(validation.absolute)) {
        return { ok: false, reason: 'file_not_found' };
    }

    // CA-SEC-2 — cap de tamaño antes del upload.
    let sizeBytes = 0;
    try {
        const stat = fs.statSync(validation.absolute);
        sizeBytes = stat.size;
    } catch (e) {
        return { ok: false, reason: 'stat_failed' };
    }
    if (sizeBytes > maxBytes) {
        return { ok: false, reason: 'attachment_too_large' };
    }

    return {
        ok: true,
        absolute: validation.absolute,
        relative: validation.relative,
        sizeBytes,
    };
}

/**
 * CA-UX-1 — Devuelve el emoji apropiado según (stage, status).
 *
 * Reglas:
 *   - init → ⏳
 *   - validation + ok → ✅, validation + fail → ❌
 *   - analysis → 🔍
 *   - completion + ok → 🎯, completion + fail → ⚠️
 *   - status=in_progress → 🔄 (override de cualquier stage)
 */
function emojiForCuaStatus(stage, status) {
    if (status === 'in_progress') return CUA_STATUS_EMOJIS.in_progress;
    if (stage === 'init') return CUA_STATUS_EMOJIS.init;
    if (stage === 'validation') {
        return status === 'fail' ? CUA_STATUS_EMOJIS.validation_fail : CUA_STATUS_EMOJIS.validation_ok;
    }
    if (stage === 'analysis') return CUA_STATUS_EMOJIS.analysis;
    if (stage === 'completion') {
        return status === 'fail' ? CUA_STATUS_EMOJIS.completion_fail : CUA_STATUS_EMOJIS.completion_ok;
    }
    return DEFAULT_FALLBACK_EMOJI;
}

/**
 * CA-FUNC-2 / CA-SEC-8 — Envelope HTML comment con `command` (en vez de
 * `issue`). El parser de `/rechazar` discrimina por `command != null`.
 */
function buildCuaEnvelope(meta) {
    const payload = {
        issue: null,
        command: String(meta.command || ''),
        stage: String(meta.stage || ''),
        skill: 'cua',
        pipeline: 'cua',
        ts: typeof meta.ts === 'number' ? meta.ts : Math.floor(Date.now() / 1000),
    };
    return `<!-- pipeline-meta ${JSON.stringify(payload)} -->`;
}

/**
 * CA-SEC-8 — Dedup key específica de CUA. Toma `ts_minuto` (truncado al
 * minuto) + `preview_hash` (sha256 corto) para que dos invocaciones idénticas
 * dentro del mismo minuto se deduplican, pero variantes en el preview se
 * notifican.
 */
function buildCuaDedupHash(command, stage, tsMs, preview) {
    const tsMin = Math.floor((Number.isFinite(tsMs) ? tsMs : Date.now()) / 60000) * 60000;
    const previewHash = contentHash(String(preview || '')).slice(0, 16);
    return contentHash(`${command}|${stage}|${tsMin}|${previewHash}`);
}

/**
 * CA-UX-3 — Strip de emojis + paths/hashes largos del texto que se manda al
 * TTS. Los emojis quedan visibles en Telegram pero no se narran (los TTS los
 * leen literal o los saltean feo). Paths/hashes ≥20 chars se reemplazan por un
 * sustantivo en español (`archivo adjunto`/`identificador`).
 */
function sanitizeCuaForTts(text) {
    if (typeof text !== 'string') return '';
    let out = text;
    // Stripear emojis y símbolos pictográficos (rango Unicode aproximado).
    out = out.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2700}-\u{27BF}\u{2B00}-\u{2BFF}]/gu, ' ');
    // Reemplazar paths y hashes largos por sustantivo.
    out = out.replace(/[\w./\\-]{20,}/g, 'archivo adjunto');
    // Colapsar espacios.
    out = out.replace(/\s+/g, ' ').trim();
    return out;
}

/**
 * CA-UX-5 — Header inequívoco para notificación CUA:
 *   `⚙️ /<command> [args] — <stage>`
 *
 * NO usa `#NNNN` (eso confunde al operador con issues).
 */
function buildCuaHeader(command, stage, args) {
    const cleanArgs = typeof args === 'string' && args.trim().length > 0
        ? ' ' + args.trim()
        : '';
    return `⚙️ /${command}${cleanArgs}${HEADER_SEP}${stage}`;
}

/**
 * CA-FUNC-2 / CA-UX-2 / CA-UX-5 — Construye el cuerpo de texto del entregable
 * CUA.
 *
 * Formato:
 *   ⚙️ /<command> <args> — <stage>
 *   <statusEmoji> <preview line 1 (≤200 chars)>
 *   [<resto del preview expandido>]
 *
 *   [⏱ <duration>s]
 *   [📎 <attachment.filename> adjunto abajo]
 *
 *   <envelope (invisible)>
 */
function buildCuaText(input) {
    const header = buildCuaHeader(input.command, input.stage, input.args);
    const statusEmoji = emojiForCuaStatus(input.stage, input.status);
    const previewRaw = typeof input.preview === 'string' ? input.preview : '';
    const previewTrunc = truncatePreserveLines(previewRaw, input.truncateChars || DEFAULT_TRUNCATE_CHARS);
    // CA-UX-2: si el preview no empieza con emoji, prefijar el de status.
    // Detectamos "emoji" por presencia de char no-ASCII en posición 0.
    const startsWithEmoji = previewTrunc.length > 0 && previewTrunc.charCodeAt(0) > 127;
    const previewBody = startsWithEmoji ? previewTrunc : `${statusEmoji} ${previewTrunc || '_sin preview_'}`;

    const lines = [header, previewBody];
    if (Number.isFinite(input.duration) && input.duration > 0) {
        lines.push('');
        lines.push(`⏱ ${input.duration.toFixed(1)}s`);
    }
    if (input.attachmentFilename) {
        lines.push(`${CUA_ATTACHMENT_EMOJI} ${input.attachmentFilename} adjunto abajo`);
    }
    lines.push('');
    lines.push(input.envelope);
    return lines.join('\n');
}

/**
 * Construye el caption del adjunto CUA (caso `sendDocument` con caption). El
 * caption es breve — sin preview expandido — porque Telegram cortea feo cuando
 * un caption excede 1024 chars.
 */
function buildCuaCaption(input) {
    const header = buildCuaHeader(input.command, input.stage, input.args);
    const customCaption = typeof input.caption === 'string' && input.caption.trim().length > 0
        ? input.caption.trim()
        : '';
    const lines = [header];
    if (customCaption) {
        lines.push('');
        lines.push(customCaption);
    }
    lines.push('');
    lines.push(input.envelope);
    return lines.join('\n');
}

/**
 * CA-FUNC-2 / CA-FUNC-4 / CA-SEC-1/2/4/5 — Construye el payload Telegram del
 * entregable CUA. Es la contraparte de `buildPreview()` para issues.
 *
 * Pasos:
 *   1. Schema validation con Ajv (CA-SEC-4) → fail closed.
 *   2. Validación de `command` (CA-SEC-3).
 *   3. Validación de `attachment` si existe (CA-SEC-1, 2, 5).
 *   4. Envelope con `command` + `issue: null` (CA-SEC-8).
 *   5. Build text-only o sendDocument con caption.
 *   6. Audit record con `command`, `issue: null`, dedup_key específica.
 *
 * @param {object} args
 * @param {object} args.entregable - { command, stage, status, preview?, attachment?, duration?, error?, args? }
 * @param {object} args.config - bloque cua del config.yaml.
 * @param {string} args.pipelineRoot
 * @param {object} [args.deps] - cuaSchemaValidator override, etc.
 * @returns {object} { ok, payload?, auditRecord?, dedupHash?, attachmentRejected?, reason? }
 */
function buildCuaPayload(args) {
    const { entregable, config, pipelineRoot, deps } = args;
    const cfg = config || {};

    // CA-SEC-4 — validación de schema antes de cualquier otra cosa.
    const validator = getCuaSchemaValidator(deps);
    if (!validator.ok) {
        return { ok: false, reason: 'schema_loader_failed', schemaLoaderError: validator.error };
    }
    if (!validator.validate(entregable)) {
        const firstError = (validator.validate.errors && validator.validate.errors[0]) || null;
        return {
            ok: false,
            reason: 'schema_invalid',
            schemaErrors: validator.validate.errors || null,
            schemaFirstError: firstError
                ? `${firstError.instancePath || '/'} ${firstError.message || ''}`.trim()
                : null,
        };
    }

    const command = entregable.command;
    const stage = entregable.stage;
    const status = entregable.status;
    const preview = typeof entregable.preview === 'string' ? entregable.preview : '';
    const attachment = entregable.attachment || null;
    const truncateChars = Number.isFinite(cfg.truncate_chars)
        ? cfg.truncate_chars
        : DEFAULT_TRUNCATE_CHARS;

    // CA-SEC-3 — whitelist + regex del command (defense in depth contra
    // schema bypass por un Ajv mal configurado).
    const allowedCommands = Array.isArray(cfg.allowed_commands) ? cfg.allowed_commands : [];
    const cmdCheck = validateCuaCommand(command, allowedCommands);
    if (!cmdCheck.ok) {
        return { ok: false, reason: cmdCheck.reason };
    }

    // Adjunto (CA-SEC-1/2/5).
    let attachmentResolved = null;
    let attachmentRejected = false;
    let rejectionReason = null;
    if (attachment) {
        const maxBytes = Number.isFinite(cfg.max_attachment_bytes)
            ? cfg.max_attachment_bytes
            : DEFAULT_CUA_MAX_ATTACHMENT_BYTES;
        const attachCheck = validateCuaAttachment(attachment, {
            pipelineRoot,
            subroot: cfg.attachment_subroot,
            maxBytes,
        });
        if (attachCheck.ok) {
            attachmentResolved = attachCheck;
        } else {
            attachmentRejected = true;
            rejectionReason = attachCheck.reason || 'unknown';
        }
    }

    const envelope = buildCuaEnvelope({ command, stage });
    const attachmentFilename = attachmentResolved
        ? (typeof attachment.filename === 'string' && attachment.filename.length > 0
            ? attachment.filename
            : path.basename(attachmentResolved.absolute))
        : null;

    let payload;
    if (attachmentResolved) {
        // sendDocument con caption legible (CA-UX-4).
        payload = {
            document: attachmentResolved.absolute,
            filename: attachmentFilename,
            caption: buildCuaCaption({
                command, stage,
                args: entregable.args,
                caption: typeof attachment.caption === 'string' && attachment.caption.length > 0
                    ? attachment.caption
                    : `${attachmentFilename} (${humanBytesShort(attachmentResolved.sizeBytes)})`,
                envelope,
            }),
            parse_mode: 'Markdown',
        };
    } else {
        payload = {
            text: buildCuaText({
                command, stage, status,
                args: entregable.args,
                preview,
                duration: entregable.duration,
                attachmentFilename: null,
                envelope,
                truncateChars,
            }),
            parse_mode: 'Markdown',
        };
    }

    const sanitizedPayload = sanitizeTelegramPayload(payload);

    // Dedup hash CA-SEC-8: (command, stage, ts_minuto, preview_hash).
    const dedupHash = buildCuaDedupHash(command, stage, Date.now(), preview);

    // Audit preview redactado (CA-SEC-3 patrón #3414).
    const auditPreview = (() => {
        const source = sanitizedPayload.text || sanitizedPayload.caption || '';
        const redacted = redactSensitive(source);
        const redactedStr = typeof redacted === 'string' ? redacted : String(source);
        return redactedStr.length > AUDIT_PREVIEW_MAX
            ? redactedStr.slice(0, AUDIT_PREVIEW_MAX - 1) + '…'
            : redactedStr;
    })();

    const auditRecord = {
        ts: new Date().toISOString(),
        // CA-FUNC-7 — `issue: null` explícito (NO omitido) para que consumers
        // sepan distinguir CUA de issues sin lookup.
        issue: null,
        command: String(command),
        stage: String(stage),
        status: String(status),
        skill: 'cua',
        pipeline: 'cua',
        // Hash dedicado CUA (CA-SEC-8). NO compatible con content_hash del
        // pipeline de issues — son canales separados.
        dedup_hash: dedupHash,
        // Mantenemos `content_hash` también para herramientas que asumen su
        // presencia (preview hash, ignorando ts).
        content_hash: contentHash(String(preview || '')),
        preview: auditPreview,
        attachment_path: attachmentResolved ? attachmentResolved.relative : null,
        attachment_size_bytes: attachmentResolved ? attachmentResolved.sizeBytes : null,
        duration: Number.isFinite(entregable.duration) ? entregable.duration : null,
    };
    if (attachmentRejected) {
        auditRecord.attachment_rejected = true;
        auditRecord.attachment_reject_reason = rejectionReason || 'unknown';
    }

    return {
        ok: true,
        payload: sanitizedPayload,
        auditRecord,
        dedupHash,
        attachmentRejected,
        rejectionReason,
    };
}

/**
 * CA-FUNC-7 / CA-SEC-8 — Dedup específica para CUA. Igual lógica que
 * `shouldSkipByDedup` pero compara `(command, stage, dedup_hash)` en lugar de
 * `(issue, skill, content_hash)`.
 */
function shouldSkipCuaByDedup(args) {
    const { auditPath, command, stage } = args;
    const hash = args.dedupHash;
    const windowHours = Number.isFinite(args.windowHours)
        ? args.windowHours
        : DEFAULT_CUA_DEDUP_HOURS;

    if (!auditPath || typeof hash !== 'string' || hash.length === 0) return false;
    if (!fs.existsSync(auditPath)) return false;

    const cutoffMs = Date.now() - windowHours * 3600 * 1000;
    let raw;
    try { raw = fs.readFileSync(auditPath, 'utf8'); }
    catch { return false; }

    const lines = raw.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (!entry || typeof entry !== 'object') continue;
        if (entry.skipped_dedup) continue;
        if (entry.kind === 'audio') continue;
        // Solo records CUA (skill='cua' y command presente).
        if (entry.skill !== 'cua') continue;
        if (entry.command !== command) continue;
        if (entry.stage !== stage) continue;
        if (entry.dedup_hash !== hash) continue;
        const tsMs = Date.parse(entry.ts || '');
        if (Number.isFinite(tsMs) && tsMs >= cutoffMs) return true;
    }
    return false;
}

/**
 * Bytes humanizados cortos para caption (5.3 MB / 412 KB / 87 B). Sin
 * dependencias.
 */
function humanBytesShort(n) {
    if (!Number.isFinite(n)) return '?';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * CA-FUNC-3 / CA-UX-3 / CA-SEC-7 — Genera el audio TTS del preview CUA.
 * Reusa el módulo `multimedia.js` igual que el audio de issues, pero
 * sanitiza el texto con `sanitizeCuaForTts` ANTES (CA-UX-3) y aplica
 * `redactSensitive` ANTES del TTS (CA-SEC-7, explicitado desde UX).
 *
 * @param {object} args
 * @param {string} args.command
 * @param {string} args.stage
 * @param {string} args.narrationText - preview ya validado.
 * @param {string} args.dedupHash
 * @param {object} args.config
 * @param {string} args.pipelineRoot
 * @param {object} [args.deps]
 * @returns {Promise<object>} patch para appendAudit con kind:'audio_cua'.
 */
async function generateCuaAudioNotifications(args) {
    const startedAt = Date.now();
    const {
        command, stage, narrationText, dedupHash,
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

    const basePatch = {
        ts: new Date().toISOString(),
        kind: 'audio_cua',
        issue: null,
        command: String(command || ''),
        stage: String(stage || ''),
        skill: 'cua',
        pipeline: 'cua',
        dedup_hash: dedupHash,
    };

    try {
        // Perfil TTS: si el spec define perfil `cua` en multimedia.js lo
        // usamos; sino caemos a default con flag fallback.
        const { profile, fallback } = resolveTtsProfile('cua', deps);
        basePatch.audio_profile = profile;
        if (fallback) basePatch.tts_profile_fallback = true;

        // CA-SEC-7 — redactar PRIMERO (antes de cualquier transformación que
        // pueda enmascarar el formato de los secrets).
        const redacted = redactSensitive(String(narrationText || ''));
        const redactedStr = typeof redacted === 'string' ? redacted : String(narrationText || '');
        // CA-UX-3 — strip emojis + paths/hashes largos + narrative-sanitize.
        const stripped = sanitizeCuaForTts(redactedStr);
        const sanitized = narrativeSanitizePreview(stripped);

        if (!sanitized || sanitized.length === 0) {
            basePatch.audio_skipped = true;
            basePatch.audio_skip_reason = 'empty_after_sanitize';
            return basePatch;
        }

        const { chunks, truncated } = partitionForTts(sanitized, {
            max: MAX_TTS_CHARS,
            cap: maxChunks,
        });
        basePatch.audio_chunks_count = chunks.length;
        basePatch.audio_truncated = truncated;
        if (chunks.length === 0) {
            basePatch.audio_skipped = true;
            basePatch.audio_skip_reason = 'empty_chunks';
            return basePatch;
        }

        let botToken = null, chatId = null;
        try {
            const loader = (deps && typeof deps.loadTelegramSecrets === 'function')
                ? deps.loadTelegramSecrets
                : require('./telegram-secrets').loadTelegramSecrets;
            const sec = loader({});
            botToken = sec.bot_token;
            chatId = sec.chat_id;
        } catch (credErr) {
            basePatch.audio_error = {
                code: credErr?.code || 'CREDS_MISSING',
                message: safeRedact(credErr),
            };
            basePatch.audio_duration_ms = Date.now() - startedAt;
            return basePatch;
        }

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

        const audioAbsRoot = path.isAbsolute(audioRoot)
            ? audioRoot
            : path.resolve(pipelineRoot || process.cwd(), audioRoot);

        const audioFilePaths = [];
        const chunkErrors = [];
        let consecutiveTimeouts = 0;
        const breakerLimit = TTS_CIRCUIT_BREAKER_TIMEOUTS;

        for (let i = 0; i < chunks.length; i++) {
            if (consecutiveTimeouts >= breakerLimit) {
                chunkErrors.push({ index: i, code: 'CIRCUIT_BREAKER', message: 'breaker_open' });
                break;
            }
            const chunkText = chunks[i];
            try {
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
                const fname = `${nowFn()}-cua-${String(command).replace(/[^a-z0-9-]/g, '_')}-${stage}-chunk${i}.ogg`;
                const fpath = path.join(audioAbsRoot, fname);
                writerFn(fpath, meta.buffer);
                const rel = path.relative(pipelineRoot || process.cwd(), fpath).replace(/\\/g, '/');
                audioFilePaths.push(rel);
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
            basePatch.audio_error = chunkErrors.length === 1
                ? chunkErrors[0]
                : { code: 'MULTI', message: `${chunkErrors.length} chunks fallaron`, details: chunkErrors };
        }
        basePatch.audio_duration_ms = Date.now() - startedAt;
        return basePatch;
    } catch (e) {
        basePatch.audio_error = { code: e?.code || 'UNEXPECTED', message: safeRedact(e) };
        basePatch.audio_duration_ms = Date.now() - startedAt;
        return basePatch;
    }
}

/**
 * Fachada CUA — el equivalente a `notify()` para entregables del CUA.
 * Combina:
 *   - Kill switches + enabled.
 *   - Validación de schema, command, attachment (fail closed en todos).
 *   - Construcción del payload.
 *   - Dedup CUA-specific.
 *   - Enqueue dropfile Telegram (fire-and-forget).
 *   - Audio TTS async (fire-and-forget).
 *   - Audit append.
 *
 * Garantiza `zero-blocking`: cualquier error se captura y devuelve
 * `{ ok: false, ... }` sin propagar (CA-FUNC-9).
 *
 * @param {object} args
 * @param {object} args.entregable - validado contra cua-entregable.schema.json.
 * @param {object} args.config - bloque `cua` del config.yaml.
 * @param {string} args.pipelineRoot
 * @param {string} args.telegramQueueDir
 * @param {object} [args.deps]
 * @returns {{ ok: boolean, action: string, reason?: string, payload?: object, audit?: object, audioTask?: Promise }}
 */
function notifyCua(args) {
    try {
        const { entregable, config, pipelineRoot, telegramQueueDir, deps } = args;
        const cfg = config || {};

        if (cfg.kill_switch === true) {
            return { ok: false, action: 'skipped', reason: 'kill_switch' };
        }
        if (cfg.enabled !== true) {
            return { ok: false, action: 'skipped', reason: 'disabled' };
        }

        // CA-SEC-4 — schema fail-closed PRIMERO. Si el entregable tiene un
        // stage no enum o un command malformado, queremos verlo como
        // `rejected` con audit `schema_invalid` antes que como un skip
        // silencioso por `stage_not_notifiable` (que sería engañoso).
        const built = buildCuaPayload({ entregable, config: cfg, pipelineRoot, deps });
        if (!built.ok) {
            // CA-SEC-4: error de schema/command/attachment → audit fail-closed.
            const auditPath = _resolveAuditPath(cfg, pipelineRoot);
            try {
                appendAudit(auditPath, {
                    ts: new Date().toISOString(),
                    issue: null,
                    command: entregable && entregable.command ? String(entregable.command) : null,
                    stage: entregable && entregable.stage ? String(entregable.stage) : null,
                    skill: 'cua',
                    pipeline: 'cua',
                    rejected: true,
                    reject_reason: built.reason,
                    schema_first_error: built.schemaFirstError || null,
                });
            } catch {}
            return { ok: false, action: 'rejected', reason: built.reason, schemaFirstError: built.schemaFirstError };
        }

        // Filtro por stage notificable. CA-TEC-2 dice que esto se hace en el
        // caller (commander-deterministic), pero también lo verificamos acá
        // como defensa (idempotencia). Se ejecuta DESPUÉS del schema check
        // para que stages inválidos se reporten como `rejected` y no como
        // `skipped`.
        const notifiableStages = Array.isArray(cfg.notifiable_stages) && cfg.notifiable_stages.length > 0
            ? cfg.notifiable_stages
            : ['init', 'validation', 'analysis', 'completion'];
        if (!notifiableStages.includes(entregable.stage)) {
            return { ok: false, action: 'skipped', reason: 'stage_not_notifiable' };
        }

        // Dedup CA-SEC-8.
        const auditPath = _resolveAuditPath(cfg, pipelineRoot);
        const windowHours = Number.isFinite(cfg.dedup_window_hours)
            ? cfg.dedup_window_hours
            : DEFAULT_CUA_DEDUP_HOURS;

        if (shouldSkipCuaByDedup({
            auditPath,
            command: entregable.command,
            stage: entregable.stage,
            dedupHash: built.dedupHash,
            windowHours,
        })) {
            appendAudit(auditPath, {
                ts: new Date().toISOString(),
                issue: null,
                command: entregable.command,
                stage: entregable.stage,
                skill: 'cua',
                pipeline: 'cua',
                dedup_hash: built.dedupHash,
                skipped_dedup: true,
            });
            return { ok: false, action: 'skipped', reason: 'dedup' };
        }

        // Enqueue dropfile.
        const now = (deps && typeof deps.now === 'function') ? deps.now() : Date.now();
        const safeCommand = String(entregable.command).replace(/[^a-z0-9-]/g, '_');
        const dropfileName = `${now}-cua-${safeCommand}-${entregable.stage}.json`;
        const dropfilePath = path.join(telegramQueueDir, dropfileName);
        const writer = (deps && typeof deps.writeQueueFile === 'function')
            ? deps.writeQueueFile
            : (p, payload) => {
                fs.mkdirSync(path.dirname(p), { recursive: true });
                fs.writeFileSync(p, JSON.stringify(payload), 'utf8');
            };
        writer(dropfilePath, built.payload);

        const audioEnabled = cfg.audio_enabled === true && cfg.kill_switch_audio !== true;
        const finalAudit = {
            ...built.auditRecord,
            telegram_enqueue_ok: true,
            dropfile: path.basename(dropfilePath),
        };
        if (audioEnabled) finalAudit.audio_pending = true;
        appendAudit(auditPath, finalAudit);

        // Audio fire-and-forget.
        let audioTask = null;
        if (audioEnabled) {
            const narrationText = built.payload.text || built.payload.caption || '';
            audioTask = generateCuaAudioNotifications({
                command: entregable.command,
                stage: entregable.stage,
                narrationText,
                dedupHash: built.dedupHash,
                config: cfg,
                pipelineRoot,
                deps,
            }).then((patch) => {
                try { appendAudit(auditPath, patch); } catch {}
                return patch;
            }).catch((e) => {
                try {
                    appendAudit(auditPath, {
                        ts: new Date().toISOString(),
                        kind: 'audio_cua',
                        issue: null,
                        command: entregable.command,
                        skill: 'cua',
                        dedup_hash: built.dedupHash,
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
            attachmentRejected: built.attachmentRejected || false,
            attachmentRejectionReason: built.rejectionReason || null,
            audioTask,
        };
    } catch (e) {
        return { ok: false, action: 'error', reason: (e && e.message) || String(e) };
    }
}

/**
 * Resolución del path absoluto al audit JSONL. Comparte el mismo archivo que
 * el patrón de issues — el discriminador es `skill: 'cua'` + `command`
 * presente.
 */
function _resolveAuditPath(cfg, pipelineRoot) {
    const auditFile = (cfg && typeof cfg.audit_file === 'string' && cfg.audit_file.length > 0)
        ? cfg.audit_file
        : '.pipeline/audit/deliverable-notifications.jsonl';
    return path.isAbsolute(auditFile)
        ? auditFile
        : path.resolve(pipelineRoot || process.cwd(), auditFile);
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
    // API pública — CUA (#3541)
    notifyCua,
    buildCuaPayload,
    shouldSkipCuaByDedup,
    generateCuaAudioNotifications,
    validateCuaCommand,
    validateCuaAttachment,
    getCuaSchemaValidator,
    // API pública — adjuntos multimedia (#3540)
    resolveAttachments,

    // Constantes
    SKILL_EMOJIS,
    DEFAULT_NOTIFY_SKILLS,
    DEFAULT_TRUNCATE_CHARS,
    DEFAULT_DEDUP_HOURS,
    DEFAULT_ATTACHMENT_ROOT,
    DRIVE_QUEUEABLE_REJECT_REASONS,
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
    // Constantes — CUA (#3541)
    ALLOWED_CUA_EXTENSIONS,
    DEFAULT_CUA_MAX_ATTACHMENT_BYTES,
    CUA_ATTACHMENT_ROOT,
    DEFAULT_CUA_DEDUP_HOURS,
    CUA_COMMAND_REGEX,
    CUA_STATUS_EMOJIS,
    // Constantes — adjuntos multimedia (#3540)
    DEFAULT_ATTACHMENT_ROOTS,
    DEFAULT_ATTACHMENT_MAX_COUNT,
    DEFAULT_ATTACHMENT_MAX_SIZE_BYTES,
    DEFAULT_VIDEO_MAX_DURATION_S,
    DEFAULT_ATTACHMENTS_PER_SKILL,
    ATTACHMENT_TYPE_EMOJI,
    ATTACHMENT_TYPE_LABEL,
    ATTACHMENT_TYPE_ORDER,
    ATTACHMENT_DROPFILE_FIELD,

    // Helpers (exportados para tests)
    __forTests__: {
        // CA-4 (#3927) — entrypoints del camino video→Drive (no son API pública,
        // solo se exponen para el test de integración del encolado).
        buildPreview,
        notify,
        emojiForSkill,
        contentHash,
        truncatePreserveLines,
        extractRawNotes,
        validateAttachmentPath,
        buildEnvelope,
        shortenTitle,
        buildText,
        buildCaption,
        // #4019 — avance de ola
        buildWaveProgressSection,
        formatOpenIssueList,
        // audio TTS
        withTimeout,
        safeRedact,
        // CUA
        emojiForCuaStatus,
        buildCuaEnvelope,
        buildCuaDedupHash,
        sanitizeCuaForTts,
        buildCuaHeader,
        buildCuaText,
        buildCuaCaption,
        humanBytesShort,
        __resetCuaSchemaValidator,
        // adjuntos multimedia (#3540)
        normalizeAttachmentDeclarations,
        buildAttachmentFilename,
        buildAttachmentCaption,
    },
};

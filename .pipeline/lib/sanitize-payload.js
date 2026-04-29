// =============================================================================
// sanitize-payload.js — Sanitización write-time de payloads a servicios externos
// Issue #2334 (split de #2324). Depende de `.pipeline/sanitizer.js` (#2333).
//
// Responsabilidad: wrappers específicos por servicio. NUNCA tocar el core del
// sanitizer (fuera de alcance). Todas las funciones son puras (no mutan input)
// y devuelven copia nueva con los campos sensibles redactados.
//
// Contrato:
//   - sanitizeTelegramPayload(data)  → copia con `text`, `caption` sanitizados
//   - sanitizeGithubPayload(data)    → copia con `body`, `title` sanitizados
//   - sanitizeDrivePayload(data)     → copia con `description`, `title`
//                                       sanitizados (el contenido del video no
//                                       se reescribe — es binario).
//   - sanitizeDriveFilename(name)    → si el basename matchea patrones de
//                                       secretos, devuelve nombre truncado
//                                       con hash SHA-256 (8 chars hex) para
//                                       preservar identificación. Si no,
//                                       devuelve el nombre tal cual.
//
// Motivo CA7 / #2334: los payloads que viajan a servicios externos (Telegram,
// Drive, GitHub) son visibles por humanos/APIs terceras. Aunque el artefacto
// persistido en disco esté sanitizado, el plaintext que la API recibe DEBE
// también estar sanitizado — de ahí este módulo que se invoca *antes* del
// `sendMessage`/`comment`/`upload`.
// =============================================================================
'use strict';

const crypto = require('crypto');
const path = require('path');
const { sanitize } = require('../sanitizer');

// -----------------------------------------------------------------------------
// Helper interno: aplica sanitize sobre un string, pass-through si no es string
// -----------------------------------------------------------------------------
function safe(text) {
    if (typeof text !== 'string') return text;
    return sanitize(text);
}

// -----------------------------------------------------------------------------
// TELEGRAM
// Campos sanitizables: `text` (sendMessage), `caption` (sendDocument/sendPhoto).
// NO tocamos `document`/`photo` (son paths a archivos binarios) ni
// `parse_mode` (valor controlado: "Markdown"/"HTML").
// -----------------------------------------------------------------------------
function sanitizeTelegramPayload(data) {
    if (!data || typeof data !== 'object') return data;
    const out = { ...data };
    if (typeof out.text === 'string') out.text = safe(out.text);
    if (typeof out.caption === 'string') out.caption = safe(out.caption);
    return out;
}

// -----------------------------------------------------------------------------
// GITHUB QUEUE
// Acciones: `comment`, `label`, `remove-label`, `create-issue`.
// Campos sanitizables: `body` (comment + create-issue), `title` (create-issue).
// Los `label` son identifiers que no deberían traer secretos; los sanitizamos
// igual (defensa en profundidad) pero devuelven copia idéntica en el 99% de
// los casos.
// -----------------------------------------------------------------------------
function sanitizeGithubPayload(data) {
    if (!data || typeof data !== 'object') return data;
    const out = { ...data };
    if (typeof out.body === 'string') out.body = safe(out.body);
    if (typeof out.title === 'string') out.title = safe(out.title);
    if (typeof out.label === 'string') out.label = safe(out.label);
    if (typeof out.labels === 'string') out.labels = safe(out.labels);
    return out;
}

// -----------------------------------------------------------------------------
// DRIVE
// El servicio de drive sube videos (binarios) y pasa metadata a
// `qa-video-share.js` por CLI args (description, title). Esas son las partes
// que pueden llevar secretos.
// -----------------------------------------------------------------------------
function sanitizeDrivePayload(data) {
    if (!data || typeof data !== 'object') return data;
    const out = { ...data };
    if (typeof out.description === 'string') out.description = safe(out.description);
    if (typeof out.title === 'string') out.title = safe(out.title);
    if (typeof out.caption === 'string') out.caption = safe(out.caption);
    return out;
}

// -----------------------------------------------------------------------------
// FILENAME: detección + truncado con hash (CA7 del #2334)
//
// Por qué no redactamos con placeholder: rompería la capacidad de vincular
// el archivo a su issue/contexto (ej: "qa-2015-video.mp4" es informativo,
// "[REDACTED:FILENAME].mp4" no). Si detectamos secretos en el nombre,
// preservamos extensión y agregamos hash corto del nombre original para que
// dos archivos distintos no colisionen en la ruta.
// -----------------------------------------------------------------------------

// Regex mínima para detectar si el basename contiene un patrón de secreto
// conocido (subset de los patrones del sanitizer core — no incluye patterns
// que requieren contexto con "key:" o "secret=" porque en un filename no
// aparecen así). Si alguno matchea, hay que renombrar.
const FILENAME_SECRET_RE = new RegExp(
    [
        '(?:AKIA|ASIA)[0-9A-Z]{16}',              // AWS access key
        'gh[pousr]_[A-Za-z0-9]{30,}',             // GitHub token
        'github_pat_[A-Za-z0-9_]{80,}',           // GitHub fine-grained
        'eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+', // JWT
        'AIza[0-9A-Za-z_-]{35}',                  // Google API key
        '1//[0-9A-Za-z_-]{43,}',                  // Google OAuth refresh
        '\\d{6,}:[A-Za-z0-9_-]{35,}',             // Telegram bot token
    ].join('|'),
);

function filenameHasSecret(name) {
    if (typeof name !== 'string' || name.length === 0) return false;
    return FILENAME_SECRET_RE.test(name);
}

/**
 * Devuelve un nombre seguro. Si `name` contiene un patrón de secreto, se
 * retorna `<hash>.<ext>` donde hash es el SHA-256 del nombre original
 * truncado a 8 hex chars. Si no, devuelve `name` tal cual.
 *
 * NUNCA toca el contenido del archivo — es sólo el nombre.
 *
 * @param {string} name
 * @returns {string}
 */
function sanitizeDriveFilename(name) {
    if (!filenameHasSecret(name)) return name;
    const ext = path.extname(name) || '';
    const hash = crypto.createHash('sha256').update(name).digest('hex').slice(0, 8);
    return `redacted-${hash}${ext}`;
}

module.exports = {
    sanitizeTelegramPayload,
    sanitizeGithubPayload,
    sanitizeDrivePayload,
    sanitizeDriveFilename,
    filenameHasSecret,
    // Sólo para tests:
    __forTestsOnly__: { safe, FILENAME_SECRET_RE },
};

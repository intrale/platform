// =============================================================================
// wave-audit.js — Audit trail append-only para cambios sobre olas e issues
// asociados (issue #4371, Ola 8.3).
//
// Registra quién agregó/quitó un issue de una ola, quién cambió la prioridad de
// un issue, y cuándo se promovió/archivó una ola — con estado previo/posterior.
// El objetivo es diagnóstico forense confiable: hoy reconstruir "quién tocó qué
// ola" exige diffear backups a mano (gap detectado por `guru` en la fase de
// análisis).
//
// Diseño (CA-1..CA-12 del PO + security OWASP):
//
//   - CA-5 (A08/A09, integridad): NO reimplementa el hash-chain. Es un emisor
//     delgado sobre `lib/audit-log.appendChained` (SHA-256 + file-lock O_EXCL).
//     Cualquier alteración de una entrada rompe `verifyChain`. Un solo lugar
//     canónico del chain (evita el "tercer chain" que advirtió `guru`).
//
//   - CA-6 (A09, log injection): `sanitizeField` colapsa newlines y caracteres
//     de control en campos de texto libre (`actor`, `note`) antes de persistir.
//
//   - CA-7 (A02, secrets): todo el record pasa por `redact.redactObject` antes
//     de escribirse (redacta AWS keys, JWT, API keys, tokens, emails, paths).
//
//   - CA-1 (A09, actor no self-report): el `actor` lo provee el caller desde el
//     actor ya autenticado (commander audit / `meta.updated_by`), no un string
//     editable por el usuario final.
//
// La emisión es **aditiva y best-effort** para los callers de `waves.js`: la
// mutación de la ola es la operación autoritativa; si el audit falla, se loguea
// pero NO se rompe la mutación (CA-12). Este módulo NO decide aplicar/rechazar
// la mutación — sólo persiste el evento.
// =============================================================================
'use strict';

const path = require('node:path');

const auditLog = require('./audit-log');
const { redactObject } = require('./redact');

// Eventos auditables (enum cerrado). Un `event` fuera de este set es un bug de
// programación del caller → throw (no queremos entradas de evento inventado).
const EVENTS = Object.freeze([
    'issue_added',      // CA-1
    'issue_removed',    // CA-2
    'priority_changed', // CA-3
    'wave_promoted',    // CA-4
    'wave_archived',    // CA-4
]);

// -----------------------------------------------------------------------------
// Resolución de paths (honra PIPELINE_DIR_OVERRIDE para tests, igual que
// partial-pause-audit.js).
// -----------------------------------------------------------------------------

function pipelineDir() {
    if (process.env.PIPELINE_DIR_OVERRIDE) return process.env.PIPELINE_DIR_OVERRIDE;
    return path.resolve(__dirname, '..');
}

function auditFile() {
    return path.join(pipelineDir(), 'audit', 'wave-issue-audit.jsonl');
}

// -----------------------------------------------------------------------------
// Sanitización de texto libre (CA-6 — anti log-injection A09).
//
// Colapsa newlines, carriage returns, tabs y demás caracteres de control a un
// espacio y recorta. Aunque `JSON.stringify` ya escapa `\n` (imposible partir
// una línea JSONL), este saneo es defensa en profundidad: garantiza que un
// `actor`/`note` con `\n{"fake":...}` no pueda inducir a un parser laxo a leer
// dos entries, y deja el texto legible en el dashboard.
//
// Rango \u0000-\u001F cubre todos los control C0 (incluye newline,
// carriage return, tab); \u007F es DEL. Definido con secuencias \u para
// no incrustar bytes de control literales en el fuente.
// -----------------------------------------------------------------------------

const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]+/g;
const MAX_FREE_TEXT_LEN = 500;

function sanitizeField(v) {
    if (v == null) return v;
    if (typeof v !== 'string') return v;
    let out = v.replace(CONTROL_CHARS_RE, ' ').trim();
    if (out.length > MAX_FREE_TEXT_LEN) {
        out = out.slice(0, MAX_FREE_TEXT_LEN) + '…';
    }
    return out;
}

// -----------------------------------------------------------------------------
// API pública.
// -----------------------------------------------------------------------------

/**
 * Normaliza un valor a entero > 0 o null (no confía en el input del caller).
 */
function normalizeNumber(v) {
    if (v == null) return null;
    const n = Number(String(v).replace('#', '').trim());
    return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Persiste un evento de auditoría de olas/issues en el log hash-chained.
 *
 * Orden canónico de campos del entry persistido (además de los que agrega
 * `audit-log`: `created_at`, `hash_prev`, `hash_self`):
 *   { event, wave, issue, actor, estado_previo, estado_posterior,
 *     prioridad_previa, prioridad_nueva, note, timestamp, pid }
 *
 * @param {object} evt
 * @param {string} evt.event — uno de EVENTS.
 * @param {number|null} [evt.wave] — number de la ola.
 * @param {number|null} [evt.issue] — number del issue.
 * @param {string} [evt.actor] — actor autenticado (no self-report). CA-1.
 * @param {*} [evt.estado_previo] — estado de la ola antes de la mutación.
 * @param {*} [evt.estado_posterior] — estado después.
 * @param {string|null} [evt.prioridad_previa] — label priority:* previo (CA-3).
 * @param {string|null} [evt.prioridad_nueva] — label priority:* nuevo (CA-3).
 * @param {string} [evt.note] — nota libre (sanitizada + redactada).
 * @returns {{ ok: boolean, hash_self: string, hash_prev: string }}
 * @throws si `evt.event` no está en EVENTS (bug del caller).
 */
function recordWaveEvent(evt = {}) {
    if (!evt || typeof evt !== 'object') {
        throw new Error('wave-audit: recordWaveEvent espera un objeto de evento.');
    }
    if (!EVENTS.includes(evt.event)) {
        throw new Error(`wave-audit: event inválido "${evt.event}" (válidos: ${EVENTS.join(', ')})`);
    }

    // CA-1: actor autenticado. Nunca dejamos que quede vacío/manipulable.
    const actor = sanitizeField(evt.actor) || 'desconocido';

    // CA-7: redactar todo el record antes de persistir (secrets/tokens/paths).
    const entry = redactObject({
        event: evt.event,
        wave: normalizeNumber(evt.wave),
        issue: normalizeNumber(evt.issue),
        actor,
        estado_previo: evt.estado_previo ?? null,
        estado_posterior: evt.estado_posterior ?? null,
        prioridad_previa: sanitizeField(evt.prioridad_previa) ?? null,
        prioridad_nueva: sanitizeField(evt.prioridad_nueva) ?? null,
        note: sanitizeField(evt.note) ?? null,
        timestamp: new Date().toISOString(),
        pid: process.pid,
    });

    // CA-5: escritura hash-chained delegada — no reimplementamos el chain.
    const result = auditLog.appendChained({ file: auditFile(), entry });

    // CA-11: rotación + retención. `rotateIfNeeded` sólo rota si el archivo
    // supera el umbral (statSync barato en cada append; rota recién a ~5MB, con
    // redact antes del gzip). El `cleanup` de archivados viejos corre sólo cuando
    // hubo rotación (evita un readdir por evento). Best-effort: nunca rompe el
    // audit. Al rotar, el archivo activo queda vacío y la próxima entry arranca
    // una cadena nueva desde GENESIS; el .gz archivado conserva su cadena íntegra
    // y verificable por separado.
    try {
        // eslint-disable-next-line global-require
        const jsonlRotation = require('./jsonl-rotation');
        const file = auditFile();
        const rot = jsonlRotation.rotateIfNeeded({ path: file, redact: true });
        if (rot && rot.rotated) {
            jsonlRotation.cleanupOldArchives({
                dir: path.dirname(file),
                basename: 'wave-issue-audit',
                retentionDays: jsonlRotation.DEFAULT_RETENTION_DAYS,
            });
        }
    } catch (_) { /* rotación/retención no bloquea la emisión del audit */ }

    return { ok: true, hash_self: result.hash_self, hash_prev: result.hash_prev };
}

/**
 * Verifica la integridad de la cadena del log de auditoría de olas.
 * @returns {{ ok: boolean, entriesChecked: number, brokenAt?: number, reason?: string }}
 */
function verifyChain() {
    return auditLog.verifyChain(auditFile());
}

/**
 * Lee todas las entries del log (sin verificar la cadena). Devuelve [] si el
 * archivo no existe.
 * @returns {object[]}
 */
function readAllEvents() {
    return auditLog.readAll(auditFile());
}

/**
 * Devuelve el historial en orden cronológico, opcionalmente filtrado por ola
 * y/o issue, limitado a las últimas `limit` entries. Usado por `/wave history`
 * y el slice del dashboard (CA-10).
 *
 * @param {object} [opts]
 * @param {number} [opts.wave] — filtra por number de ola.
 * @param {number} [opts.issue] — filtra por number de issue.
 * @param {number} [opts.limit=50] — máximo de entries (las más recientes).
 * @returns {object[]}
 */
function history({ wave, issue, limit = 50 } = {}) {
    let all = readAllEvents();
    if (!Array.isArray(all)) return [];
    const waveN = wave == null ? null : normalizeNumber(wave);
    const issueN = issue == null ? null : normalizeNumber(issue);
    if (waveN != null) all = all.filter((e) => e.wave === waveN);
    if (issueN != null) all = all.filter((e) => e.issue === issueN);
    const N = Math.max(0, Math.min(Number(limit) || 0, all.length));
    return all.slice(all.length - N);
}

module.exports = {
    recordWaveEvent,
    verifyChain,
    readAllEvents,
    history,
    // Exportados para tests
    sanitizeField,
    normalizeNumber,
    EVENTS,
    // Path resolver dinámico (respeta PIPELINE_DIR_OVERRIDE en runtime/tests).
    _paths: () => ({ AUDIT_FILE: auditFile() }),
};

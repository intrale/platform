'use strict';
// =============================================================================
// #7632 — Anotaciones de GitHub Actions y resumen del check de autoría
// (UX-1 … UX-5 · RS-3).
//
// Módulo PURO. Los mensajes son FIJOS: ningún texto del PR (título, body, rama,
// valores del trailer) llega a una anotación. Lo único que se interpola es el
// número de issue ya validado con `^\d{1,7}$` y el sha corto validado como hex.
// Igual todo pasa por el escape de GitHub, por defensa en profundidad.
// =============================================================================

const TITLE = 'Autoría del PR';
const DRY_RUN_PREFIX = '[modo de prueba — no bloquea]';
const MAX_LEN = 200;

const MESSAGES = Object.freeze({
    MISSING_TRAILER: 'Falta el trailer de autoría en el mensaje de squash. Regenerar el handoff de delivery del issue.',
    INVALID_FORMAT: 'El trailer de autoría tiene un formato inválido. Regenerar el handoff de delivery del issue.',
    DUPLICATE_KEY: 'El trailer de autoría repite una clave Intrale-*. Regenerar el handoff; no editar el body a mano.',
    KEY_OUTSIDE_BLOCK: 'Hay una línea Intrale-* fuera del bloque de autoría. Quitarla del body y regenerar el handoff.',
    ISSUE_NOT_FOUND: 'El trailer apunta a un issue que no existe (#{issue}). Revisar el número de issue del trailer.',
    ANCHOR_MISMATCH: 'El bloque authorship-anchor del PR no coincide con el trailer. Regenerar el handoff; no editar el body a mano.',
    TOO_LARGE: 'El mensaje del PR supera 64 KB y no se verificó. Reducir el body del PR y reintentar el check.',
    UNVERIFIABLE: 'No se pudo consultar GitHub para verificar la autoría (error transitorio). Reintentar el check.',
});

const DISABLED_MESSAGE = 'La verificación de autoría está desactivada por configuración.';
const FOOTER = 'Este check verifica consistencia, no autenticidad.';

function escapeData(s) {
    return String(s == null ? '' : s)
        .replace(/%/g, '%25')
        .replace(/\r/g, '%0D')
        .replace(/\n/g, '%0A');
}

function escapeProperty(s) {
    return escapeData(s)
        .replace(/:/g, '%3A')
        .replace(/,/g, '%2C');
}

function truncate(s) {
    const arr = Array.from(String(s));
    return arr.length > MAX_LEN ? arr.slice(0, MAX_LEN).join('') : String(s);
}

function safeIssue(issue) {
    return /^\d{1,7}$/.test(String(issue == null ? '' : issue)) ? String(issue) : '?';
}

function command(level, message) {
    return `::${level} title=${escapeProperty(TITLE)}::${escapeData(truncate(message))}`;
}

/**
 * Una anotación por hallazgo. `warning` en dry-run (con prefijo literal),
 * `error` en enforce (sin prefijo).
 */
function formatAnnotation({ code, issue, mode }) {
    const base = MESSAGES[code] || MESSAGES.UNVERIFIABLE;
    const msg = base.replace('{issue}', safeIssue(issue));
    if (mode === 'enforce') return command('error', msg);
    return command('warning', `${DRY_RUN_PREFIX} ${msg}`);
}

function formatDisabledNotice() {
    return command('notice', DISABLED_MESSAGE);
}

/** UX-4 — auditoría de main: un warning por commit, informativo. */
function formatAuditWarning(sha) {
    const s = String(sha == null ? '' : sha);
    const short = /^[0-9a-f]{7,40}$/i.test(s) ? s.slice(0, 7).toLowerCase() : '?';
    return command('warning', `Entró a main un squash de agent/* sin trailer de autoría (commit ${short}).`);
}

const ICON = Object.freeze({ ok: '✅', fail: '❌', unknown: '⚠️' });

/** UX-3 — tabla para `$GITHUB_STEP_SUMMARY`, sin texto del PR. */
function renderSummary(checks, mode) {
    const c = checks || {};
    const icon = (v) => ICON[v] || ICON.unknown;
    const modo = mode === 'enforce' ? 'bloqueante' : (mode === 'disabled' ? 'desactivado' : 'prueba');
    return [
        `### ${TITLE}`,
        '',
        '| Chequeo | Resultado |',
        '|---|---|',
        `| Modo | ${modo} |`,
        `| Formato del trailer | ${icon(c.format)} |`,
        `| Issue existe | ${icon(c.issue)} |`,
        `| Bloque = trailer | ${icon(c.anchor)} |`,
        '',
        `_${FOOTER}_`,
        '',
    ].join('\n');
}

module.exports = {
    TITLE,
    DRY_RUN_PREFIX,
    MESSAGES,
    DISABLED_MESSAGE,
    FOOTER,
    escapeData,
    escapeProperty,
    formatAnnotation,
    formatDisabledNotice,
    formatAuditWarning,
    renderSummary,
};

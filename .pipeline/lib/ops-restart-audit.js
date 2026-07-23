'use strict';

// =============================================================================
// ops-restart-audit.js — Audit del restart por servicio del Dashboard Ops.
// EP8-H7 (#3960, épica #3952) — CA-3 "quién lo pidió" + REQ-SEC-H7-4.
// -----------------------------------------------------------------------------
// JSONL append-only `.pipeline/audit/ops-restart.jsonl`:
//
//   { ts, service, source, sourceIp, actor, ok, msg }
//
// SEGURIDAD (REQ-SEC-H7-4, OWASP A09):
//   - `source` (`dashboard-ui`/`telegram`) es ATESTACIÓN NO AUTENTICADA: el
//     dashboard no tiene auth, así que "quién" es spoofeable. Se registra como
//     dato declarativo. `sourceIp` (req.socket.remoteAddress) se registra como
//     dato OBJETIVO del request (no spoofeable a nivel de socket TCP local).
//   - `actor` y `msg` se sanitizan contra LOG INJECTION: un `\n` / `\r` en esos
//     campos rompería el formato línea-a-línea del .jsonl. Se colapsan los
//     saltos de línea y se capa el largo ANTES de serializar. JSON.stringify ya
//     escapa comillas, pero el corte de newline es defensa explícita.
// =============================================================================

const fs = require('node:fs');
const path = require('node:path');

const AUDIT_REL = ['audit', 'ops-restart.jsonl'];
const MAX_FIELD = 500;
const MAX_LINES = 10000;
const KNOWN_SOURCES = new Set(['dashboard-ui', 'telegram', 'cli', 'unknown']);

// Separadores de línea que romperían el JSONL: CR, LF, TAB, NEL (U+0085),
// LS (U+2028), PS (U+2029).
const LINE_SEPARATORS = new RegExp('[' + ['\r','\n','\t','\u0085','\u2028','\u2029'].join('') + ']+', 'g');

function resolvePipelineDir(opts) {
    if (opts && opts.pipelineDir) return opts.pipelineDir;
    // __dirname = .pipeline/lib → padre = .pipeline
    return path.resolve(__dirname, '..');
}

function auditPath(opts) {
    return path.join(resolvePipelineDir(opts), ...AUDIT_REL);
}

// Defensa anti log-injection: colapsa cualquier separador de línea a un espacio
// simple y capa el largo. Devuelve string siempre.
function sanitizeField(value, maxLen) {
    const cap = typeof maxLen === 'number' && maxLen > 0 ? maxLen : MAX_FIELD;
    let s = value == null ? '' : String(value);
    s = s.replace(LINE_SEPARATORS, ' ');
    return s.length > cap ? s.slice(0, cap) + '…' : s;
}

function normalizeSource(source) {
    const s = sanitizeField(source, 40).trim();
    return KNOWN_SOURCES.has(s) ? s : 'unknown';
}

/**
 * Registra un evento de restart en el audit JSONL.
 *
 * @param {object} ev — { service, source, sourceIp, actor, ok, msg }.
 * @param {object} [opts] — { pipelineDir, now (ms) }.
 * @returns {object} el record persistido (o el que se intentó persistir).
 */
function appendOpsRestartAudit(ev, opts) {
    const o = opts || {};
    const now = typeof o.now === 'number' ? o.now : Date.now();
    const e = ev || {};
    const record = {
        ts: new Date(now).toISOString(),
        service: sanitizeField(e.service, 80),
        source: normalizeSource(e.source),       // declarativo, NO autenticado
        sourceIp: sanitizeField(e.sourceIp, 60), // objetivo (socket remoto)
        actor: sanitizeField(e.actor, 120),
        ok: e.ok === true,
        msg: sanitizeField(e.msg, MAX_FIELD),
    };
    const file = auditPath(o);
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
    } catch {
        // best-effort: nunca bloquear el restart por un fallo de audit.
    }
    return record;
}

/**
 * Lee las últimas N entradas del audit (más reciente primero). Tolera líneas
 * corruptas saltándolas.
 *
 * @param {object} [opts] — { pipelineDir, limit (default 50), service }.
 * @returns {Array<object>}
 */
function readOpsRestartAudit(opts) {
    const o = opts || {};
    const limit = typeof o.limit === 'number' && o.limit > 0 ? o.limit : 50;
    const file = auditPath(o);
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch { return []; }
    const lines = raw.split(/\r?\n/).filter(Boolean).slice(-MAX_LINES);
    const out = [];
    for (const line of lines) {
        try {
            const ev = JSON.parse(line);
            if (o.service && ev.service !== o.service) continue;
            out.push(ev);
        } catch { /* línea corrupta, ignorar */ }
    }
    return out.reverse().slice(0, limit);
}

module.exports = {
    appendOpsRestartAudit,
    readOpsRestartAudit,
    sanitizeField,
    normalizeSource,
    auditPath,
};

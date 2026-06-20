'use strict';

// =============================================================================
// process-transitions.js — Store de transiciones vivo↔muerto por servicio.
// EP8-H7 (#3960, épica #3952) — CA-1 "desde cuándo" + último error + historial.
// -----------------------------------------------------------------------------
// Store append-only `process-transitions.jsonl` (una línea JSON por flanco):
//
//   { ts, service, from: 'alive'|'dead', to: 'alive'|'dead', reason, lastError }
//
// Alimentación: `recordSnapshot(procesos)` se engancha al punto donde el
// dashboard ya computa alive/dead por componente (getPipelineState →
// state.procesos). Detecta el flanco contra el snapshot previo EN MEMORIA y
// sólo persiste cuando hay cambio real (idempotente si no hay flanco).
//
// "Último error" (CA-1) = heurística: última línea ERROR/stack del `<svc>.log`,
// pasada por `sanitizer.sanitize()` ANTES de persistir (REQ-SEC-H7-1/6) para
// no filtrar secrets al store ni al SSR. La lectura agrega por motivo en una
// ventana de 7 días (`caídas 7 d: 2 (ECONNRESET ×2)`).
//
// Sin bind de paths a tiempo de carga: `opts.pipelineDir` permite tests con
// tmpdir; `opts.now` y `opts.lastErrorFor` hacen el flanco determinístico.
// =============================================================================

const fs = require('node:fs');
const path = require('node:path');

const STORE_NAME = 'process-transitions.jsonl';
const DEFAULT_WINDOW_MS = 7 * 24 * 3600 * 1000; // 7 días
const MAX_LINES = 20000;       // techo de parseo por lectura (append-only)
const LAST_ERROR_MAX = 400;    // cap del último error persistido
const LOG_TAIL_BYTES = 64 * 1024; // ventana de cola del log de servicio

// Estado en memoria del último alive/dead observado por servicio. Se siembra en
// la primera observación (no genera transición espuria al arrancar el dashboard).
const _lastState = new Map();

function resolvePipelineDir(opts) {
    if (opts && opts.pipelineDir) return opts.pipelineDir;
    // __dirname = .pipeline/lib → padre = .pipeline
    return path.resolve(__dirname, '..');
}

function storePath(opts) {
    return path.join(resolvePipelineDir(opts), STORE_NAME);
}

function logDir(opts) {
    return path.join(resolvePipelineDir(opts), 'logs');
}

// sanitize defensivo — si el módulo no está disponible, devolvemos el texto tal
// cual (mejor un texto sin redactar en un entorno de test que romper el flow).
function _sanitize(text) {
    if (typeof text !== 'string') return '';
    try { return require('../sanitizer').sanitize(text); }
    catch { return text; }
}

// Extrae un motivo legible del último error. Prioriza tokens tipo ECONNRESET /
// ETIMEDOUT / EPIPE; si no hay, usa la primera palabra significativa. Default
// 'unknown'. El resultado se usa para agregar el breakdown por motivo.
function classifyReason(lastError) {
    if (typeof lastError !== 'string' || !lastError) return 'unknown';
    const code = lastError.match(/\b(E[A-Z]{2,}[A-Z0-9_]*)\b/);
    if (code) return code[1];
    const named = lastError.match(/\b([A-Z][a-zA-Z]*Error|[A-Z]{3,})\b/);
    if (named) return named[1];
    return 'unknown';
}

// Lee la cola del log del servicio y devuelve la última línea relevante
// (ERROR/Exception/stack), sanitizada y capada. '' si no hay log o no hay match.
function readLastError(service, opts) {
    const file = path.join(logDir(opts), `${service}.log`);
    let raw;
    try {
        const stat = fs.statSync(file);
        const start = Math.max(0, stat.size - LOG_TAIL_BYTES);
        const fd = fs.openSync(file, 'r');
        try {
            const len = stat.size - start;
            const buf = Buffer.alloc(len);
            fs.readSync(fd, buf, 0, len, start);
            raw = buf.toString('utf8');
        } finally { fs.closeSync(fd); }
    } catch { return ''; }

    const lines = raw.split(/\r?\n/).filter(l => l.length > 0);
    const isErr = (l) => /\bERROR\b|Exception|\bat\s+\w|ECONNRESET|ETIMEDOUT|EPIPE|EADDRINUSE|fatal/i.test(l);
    let pick = '';
    for (let i = lines.length - 1; i >= 0; i--) {
        if (isErr(lines[i])) { pick = lines[i]; break; }
    }
    if (!pick && lines.length) pick = lines[lines.length - 1];
    const clean = _sanitize(pick).trim();
    return clean.length > LAST_ERROR_MAX ? clean.slice(0, LAST_ERROR_MAX) + '…' : clean;
}

function _appendLine(record, opts) {
    const file = storePath(opts);
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
        return true;
    } catch { return false; }
}

/**
 * Registra el flanco alive↔dead detectado en `procesos` contra el snapshot
 * previo en memoria. Persiste sólo los servicios que cambiaron de estado.
 *
 * @param {object} procesos — map { service: { alive: bool, ... } } (state.procesos).
 * @param {object} [opts] — { pipelineDir, now (ms), lastErrorFor(service)->string }.
 * @returns {Array<object>} transiciones efectivamente registradas (para tests).
 */
function recordSnapshot(procesos, opts) {
    const o = opts || {};
    const now = typeof o.now === 'number' ? o.now : Date.now();
    const ts = new Date(now).toISOString();
    const recorded = [];
    if (!procesos || typeof procesos !== 'object') return recorded;

    for (const [service, p] of Object.entries(procesos)) {
        const alive = !!(p && p.alive);
        const prev = _lastState.get(service);
        if (prev === undefined) { _lastState.set(service, alive); continue; } // siembra
        if (prev === alive) continue; // sin flanco

        const from = prev ? 'alive' : 'dead';
        const to = alive ? 'alive' : 'dead';
        let lastError = '';
        let reason;
        if (to === 'dead') {
            lastError = typeof o.lastErrorFor === 'function'
                ? _sanitize(String(o.lastErrorFor(service) || '')).slice(0, LAST_ERROR_MAX)
                : readLastError(service, o);
            reason = classifyReason(lastError);
        } else {
            reason = 'recovered';
        }
        const record = { ts, service, from, to, reason, lastError };
        _appendLine(record, o);
        _lastState.set(service, alive);
        recorded.push(record);
    }
    return recorded;
}

function _readAll(opts) {
    const file = storePath(opts);
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch { return []; }
    const lines = raw.split(/\r?\n/).filter(Boolean).slice(-MAX_LINES);
    const out = [];
    for (const line of lines) {
        try { out.push(JSON.parse(line)); } catch { /* línea corrupta, ignorar */ }
    }
    return out;
}

/**
 * Lee el historial de transiciones (ventana 7d default), opcionalmente filtrado
 * por servicio, con agregación de caídas por motivo.
 *
 * @param {string|null} service — servicio a filtrar (null = todos).
 * @param {object} [opts] — { pipelineDir, now, windowMs }.
 * @returns {{ service, count, downCount, byReason, summary, lastError, transitions }}
 */
function readTransitions(service, opts) {
    const o = opts || {};
    const now = typeof o.now === 'number' ? o.now : Date.now();
    const windowMs = typeof o.windowMs === 'number' ? o.windowMs : DEFAULT_WINDOW_MS;
    const cutoff = now - windowMs;

    const all = _readAll(o).filter(ev => {
        if (service && ev.service !== service) return false;
        const t = ev && ev.ts ? Date.parse(ev.ts) : NaN;
        return Number.isFinite(t) && t >= cutoff;
    });

    const byReason = {};
    let downCount = 0;
    let lastError = '';
    for (const ev of all) {
        if (ev.to === 'dead') {
            downCount++;
            const r = String(ev.reason || 'unknown');
            byReason[r] = (byReason[r] || 0) + 1;
            if (ev.lastError) lastError = ev.lastError; // el más reciente en orden append
        }
    }

    const days = Math.round(windowMs / (24 * 3600 * 1000));
    const reasonStr = Object.entries(byReason)
        .sort((a, b) => b[1] - a[1])
        .map(([r, n]) => `${r} ×${n}`)
        .join(', ');
    const summary = downCount > 0
        ? `caídas ${days} d: ${downCount}${reasonStr ? ` (${reasonStr})` : ''}`
        : `caídas ${days} d: 0`;

    return {
        service: service || null,
        count: all.length,
        downCount,
        byReason,
        summary,
        lastError,
        transitions: all,
    };
}

// Reset del estado en memoria — sólo para tests (aislamiento entre casos).
function _resetState() { _lastState.clear(); }

module.exports = {
    recordSnapshot,
    readTransitions,
    readLastError,
    classifyReason,
    storePath,
    DEFAULT_WINDOW_MS,
    __forTestsOnly__: { _resetState, _lastState },
};

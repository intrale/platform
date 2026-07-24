// =============================================================================
// bloqueados-stats.js — Agregados del header de la ventana Bloqueados (#3957,
// EP8-H4 / CA-4). Computa dos métricas a partir del trace `activity-log.jsonl`:
//
//   - avgSla        SLA promedio de desbloqueo = avg(unblocked.ts − blocked.ts)
//                   por issue (sólo pares emparejados). Texto legible "4h 12m".
//   - resolvedToday count de eventos human:unblocked + human:dismissed del día.
//
// Seguridad / performance (riesgos guru + security del issue):
//   - Path CONSTANTE (`lib/traceability.js::LOG_FILE`), jamás derivado de
//     request → sin path traversal.
//   - Lectura con VENTANA ACOTADA (tail de ~2MB, igual disciplina que
//     traceability.getSessionContext #3088/SEC-3) → nunca parse completo en
//     cada poll del dashboard → sin auto-DoS.
//   - Devuelve SÓLO agregados numéricos/strings cortos; jamás líneas crudas del
//     log al caller (que las volcaría al DOM).
//
// Sin Date.now() implícito: recibe `nowMs` como argumento (testeable). Si no se
// pasa, cae a Date.now() en runtime real.
// =============================================================================
'use strict';

const fs = require('fs');

let LOG_FILE;
try {
    ({ LOG_FILE } = require('./traceability'));
} catch {
    LOG_FILE = null;
}

// Tail máximo a leer del JSONL. ~2MB cubre miles de eventos recientes — más que
// suficiente para SLA de hoy / últimos días sin pagar el costo de parsear un
// archivo que crece sin límite y tiene múltiples consumidores.
const READ_BYTES = 2 * 1024 * 1024;

// Sólo se consideran eventos de los últimos N días para el SLA (ventana
// temporal además de la ventana de bytes). Mantiene el promedio representativo
// del estado operativo actual y acota el trabajo de emparejado.
const SLA_WINDOW_DAYS = 7;

const RELEVANT_EVENTS = new Set(['human:blocked', 'human:unblocked', 'human:dismissed']);

// Lee la cola del log (tail acotado) y devuelve las líneas completas. Descarta
// la primera línea si quedó truncada por el corte del tail (mismo patrón que
// traceability.getSessionContext).
function readTailLines(logFile, _fs) {
    if (!logFile) return [];
    try {
        if (!_fs.existsSync(logFile)) return [];
        const stat = _fs.statSync(logFile);
        const readSize = Math.min(stat.size, READ_BYTES);
        if (readSize <= 0) return [];
        const fd = _fs.openSync(logFile, 'r');
        try {
            const buf = Buffer.alloc(readSize);
            _fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
            const raw = buf.toString('utf8');
            const lines = raw.split('\n');
            if (lines.length > 0 && !lines[0].endsWith('}')) lines.shift();
            return lines;
        } finally {
            _fs.closeSync(fd);
        }
    } catch {
        return [];
    }
}

// "4h 12m" / "37m" / "2d 3h". Sólo unidades significativas, compacto para el
// chip del header. ms negativos o no finitos → null (caller muestra "—").
function fmtDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return null;
    const totalMin = Math.round(ms / 60000);
    if (totalMin < 1) return '<1m';
    const days = Math.floor(totalMin / 1440);
    const hours = Math.floor((totalMin % 1440) / 60);
    const mins = totalMin % 60;
    if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
    if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
    return `${mins}m`;
}

function startOfDayMs(nowMs) {
    const d = new Date(nowMs);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

/**
 * Computa los agregados del header de Bloqueados.
 *
 * @param {object} [opts]
 * @param {number} [opts.nowMs]   — "ahora" inyectable (tests). Default Date.now().
 * @param {string} [opts.logFile] — override del path del log (tests). Default LOG_FILE.
 * @param {object} [opts.fsImpl]  — override de fs (tests).
 * @returns {{avgSla: (string|null), resolvedToday: number}} sólo agregados.
 */
function computeBloqueadosStats(opts) {
    const o = opts || {};
    const nowMs = Number.isFinite(o.nowMs) ? o.nowMs : Date.now();
    const logFile = o.logFile || LOG_FILE;
    const _fs = o.fsImpl || fs;

    const dayStart = startOfDayMs(nowMs);
    const windowStart = nowMs - SLA_WINDOW_DAYS * 86400000;

    const lines = readTailLines(logFile, _fs);

    // Emparejado por issue: guardamos el último blocked.ts visto y, al ver el
    // unblocked correspondiente, acumulamos el delta. Recorremos en orden de
    // aparición (cronológico en el log).
    const lastBlockedAt = new Map(); // issue -> ts(ms) del último human:blocked
    const slaDeltas = [];
    let resolvedToday = 0;

    for (const line of lines) {
        if (!line) continue;
        let evt;
        try { evt = JSON.parse(line); } catch { continue; }
        if (!evt || !RELEVANT_EVENTS.has(evt.event)) continue;

        const issue = Number(evt.issue);
        const ts = Date.parse(evt.ts);
        if (!Number.isFinite(ts)) continue;
        if (ts < windowStart) continue; // fuera de la ventana temporal

        if (evt.event === 'human:blocked') {
            if (Number.isFinite(issue)) lastBlockedAt.set(issue, ts);
            continue;
        }

        // unblocked / dismissed → eventos de resolución.
        if (ts >= dayStart && ts <= nowMs) resolvedToday++;

        if (evt.event === 'human:unblocked' && Number.isFinite(issue)) {
            const blockedTs = lastBlockedAt.get(issue);
            if (Number.isFinite(blockedTs) && ts >= blockedTs) {
                slaDeltas.push(ts - blockedTs);
                lastBlockedAt.delete(issue);
            }
        }
    }

    let avgSla = null;
    if (slaDeltas.length > 0) {
        const sum = slaDeltas.reduce((a, b) => a + b, 0);
        avgSla = fmtDuration(sum / slaDeltas.length);
    }

    return { avgSla, resolvedToday };
}

module.exports = {
    computeBloqueadosStats,
    fmtDuration,
    SLA_WINDOW_DAYS,
};

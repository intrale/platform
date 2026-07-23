'use strict';

// =============================================================================
// provider-cost.js — Telemetría granular de costo por provider (issue #4403,
// split de #3791, deliverable D4 · CA-D · H2 · RS-3).
//
// Registra, de forma append-only, una línea JSON por ejecución de agente con
// EXACTAMENTE los 7 campos whitelist:
//   { provider, skill, issue, tokens_in, tokens_out, latency_ms, status }
//
// Fuente de verdad: `.pipeline/state/provider-cost.jsonl`. Patrón de escritura
// idéntico a `audit-log.js:293` (`appendFileSync(JSON.stringify(rec)+'\n')`),
// que garantiza un registro por línea (JSON.stringify escapa los newlines
// internos de cada string).
//
// SEGURIDAD (RS-3 · CWE-117 · A02/A09):
//   - El registro se construye por ASIGNACIÓN LITERAL de los 7 campos. NUNCA
//     `{...opts}` ni `Object.assign(dst, opts)`: el `opts` de la fuente arrastra
//     `provider/transport/context` de error que puede ecoar la API key (401).
//   - `status` pasa SIEMPRE por `sanitizeRawExcerpt(...)` antes de escribir
//     (redacta secretos multi-proveedor + strip CR/LF anti log-injection).
//   - Los campos numéricos se coercionan con `Number(...)` (fallback 0/null si
//     NaN) para que no vehiculen texto sensible.
//
// NEVER-THROWS (CA-5): todo el cuerpo va envuelto en try/catch que traga el
// error. La telemetría es best-effort y jamás debe romper el lifecycle del
// agente ni el punto de ingesta en `pulpo.js`.
// =============================================================================

const fs = require('fs');
const path = require('path');

// Import defensivo: si el módulo de sanitización no cargara (versión vieja),
// degradamos a un sanitizador local mínimo en vez de romper. El status igual
// queda sin CR/LF; los patrones de secreto se cubren en el módulo canónico.
let _sanitizeRawExcerpt;
try {
    ({ sanitizeRawExcerpt: _sanitizeRawExcerpt } = require('../quota-exhausted'));
} catch { /* fallback abajo */ }
function sanitizeStatus(raw) {
    if (typeof _sanitizeRawExcerpt === 'function') {
        return _sanitizeRawExcerpt(raw);
    }
    // Fallback ultra-defensivo: strip CR/LF/TAB + truncado. No cubre secretos
    // multi-proveedor (eso vive en quota-exhausted), pero evita log-injection.
    return String(raw == null ? '' : raw).replace(/[\r\n\t]/g, ' ').slice(0, 200);
}

// Set exacto de campos persistidos. El test afirma que `Object.keys` de cada
// línea === este array, ni una clave más (RS-3 whitelist estricta).
const WHITELIST = ['provider', 'skill', 'issue', 'tokens_in', 'tokens_out', 'latency_ms', 'status'];

// Ruta canónica del JSONL de costo por provider.
function defaultFile() {
    return path.join(__dirname, '..', '..', 'state', 'provider-cost.jsonl');
}

/**
 * Persiste un registro de costo por provider (append-only, never-throws).
 *
 * @param {object} opts
 * @param {string} opts.provider   id del provider resuelto (ej. 'anthropic')
 * @param {string} opts.skill      skill del agente (ej. 'backend-dev')
 * @param {number} opts.issue      número de issue
 * @param {number} opts.tokens_in  tokens de entrada (total canónico del adapter)
 * @param {number} opts.tokens_out tokens de salida (total canónico del adapter)
 * @param {number} opts.latency_ms latencia de la ejecución en ms
 * @param {string} opts.status     estado ('ok'|'error'|...) — se sanitiza
 * @param {object} [deps]          inyección para tests: { fs, file }
 */
function recordProviderCost(opts = {}, deps = {}) {
    const _fs = deps.fs || fs;
    const file = deps.file || defaultFile();
    try {
        // RS-3: asignación LITERAL de los 7 campos. Prohibido spread/Object.assign.
        const record = {
            provider: String(opts.provider || 'unknown'),
            skill: String(opts.skill || 'unknown'),
            issue: Number(opts.issue) || null,
            tokens_in: Number(opts.tokens_in) || 0,
            tokens_out: Number(opts.tokens_out) || 0,
            latency_ms: Number(opts.latency_ms) || 0,
            // status sanitizado (cierra 401-eco-key + CWE-117 strip CR/LF).
            status: sanitizeStatus(opts.status == null ? 'ok' : opts.status),
        };
        try { _fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* best-effort */ }
        _fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8'); // append-only, patrón audit-log.js:293
    } catch { /* never-throws — best-effort (CA-5) */ }
}

/**
 * Lee el JSONL y agrega el consumo por provider. Consumido por el dashboard.
 * Degrada a `{ hasData: false, byProvider: {}, totalSessions: 0 }` si el archivo
 * no existe, está vacío, o falla la lectura (never-throws).
 *
 * @param {object} [deps] inyección para tests: { fs, file }
 * @returns {{ hasData: boolean, byProvider: object, totalSessions: number }}
 *   byProvider: { <provider>: { tokens_in, tokens_out, sessions, errors } }
 */
function readProviderCostBreakdown(deps = {}) {
    const _fs = deps.fs || fs;
    const file = deps.file || defaultFile();
    const out = { hasData: false, byProvider: {}, totalSessions: 0 };
    try {
        let raw = '';
        try { raw = _fs.readFileSync(file, 'utf8'); } catch { return out; }
        const lines = String(raw).split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            let rec;
            try { rec = JSON.parse(trimmed); } catch { continue; }
            if (!rec || typeof rec !== 'object') continue;
            const prov = String(rec.provider || 'unknown');
            const bucket = out.byProvider[prov] || (out.byProvider[prov] = {
                tokens_in: 0, tokens_out: 0, sessions: 0, errors: 0,
            });
            bucket.tokens_in += Number(rec.tokens_in) || 0;
            bucket.tokens_out += Number(rec.tokens_out) || 0;
            bucket.sessions += 1;
            // `status` ya viene sanitizado; sólo lo usamos como flag de error.
            if (String(rec.status || '').toLowerCase().indexOf('error') !== -1) {
                bucket.errors += 1;
            }
            out.totalSessions += 1;
            out.hasData = true;
        }
    } catch { /* never-throws — degrade a empty-state */ }
    return out;
}

module.exports = { recordProviderCost, readProviderCostBreakdown, WHITELIST };

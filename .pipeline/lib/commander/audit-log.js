// =============================================================================
// audit-log.js — Log append-only del Commander determinístico
// Issue #3257 · CA-10
// Issue #3415 · CA-16 / SEC-1.6 — `filenamePrefix` configurable + `extraFields`
//                                  para que `/rechazar` reuse este factory con
//                                  schema extendido y rotación en
//                                  `.pipeline/audit/rejections-YYYY-MM-DD.jsonl`.
//
// Cada comando que entra al router se asienta en
// `.pipeline/logs/commander-audit.jsonl`. El handler invoca `record()` al final
// del dispatch — antes de mover el mensaje a `listo/`.
//
// Reglas de seguridad:
// - El `raw_command` se guarda redactado (api keys/JWT/passwords masked).
// - Los `args` se guardan como hash sha256 — no se persiste contenido crudo.
// - El archivo rota por día: `commander-audit-YYYY-MM-DD.jsonl` (o el prefix
//   custom que pase el caller).
// - El `filenamePrefix` se sanitiza contra path traversal — solo `[A-Za-z0-9_-]+`.
//
// Formato del registro:
//   {
//     ts: "2026-05-17T01:23:45.678Z",
//     from: "Leo",
//     chat_id: "123456789",
//     raw_command: "<redactado>",
//     intent_class: "deterministic" | "llm" | "unknown",
//     handler: "status" | null,
//     args_hash: "<sha256 hex>",
//     result_status: "ok" | "rate_limited" | "invalid_args" | "error",
//     duration_ms: 42
//   }
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sha256Hex(value) {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function todayStamp(date) {
    const d = date instanceof Date ? date : new Date();
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/**
 * Crea un grabador de auditoría sobre `dir` (default: `.pipeline/logs`).
 * Devuelve { record, currentPath, listToday }.
 *
 * @param {object} opts
 * @param {string} opts.dir              - directorio destino (se crea si no existe)
 * @param {function} [opts.redact]       - redactor de strings (default: identity)
 * @param {function} [opts.now]          - clock injectable (default: Date.now)
 * @param {string} [opts.filenamePrefix] - prefijo del archivo (default 'commander-audit').
 *                                          Issue #3415 / CA-16 / SEC-1.6: el handler de
 *                                          `/rechazar` usa `filenamePrefix: 'rejections'` para
 *                                          aislar el audit log en `rejections-YYYY-MM-DD.jsonl`.
 *                                          Sanitizado contra path traversal — solo
 *                                          `[A-Za-z0-9_-]+`, caso contrario se ignora y se
 *                                          mantiene el default.
 * @param {string[]} [opts.extraFields]  - whitelist de campos extra que `record({...})` puede
 *                                          aportar y que se persisten en el JSONL. Issue #3415
 *                                          CA-17: el handler de rechazar incluye `issue`,
 *                                          `fase`, `fase_resolved`, `motivo`, `source`,
 *                                          `raw_input`, `raw_input_hash`, `event_path`. Los
 *                                          strings se redactan; los numéricos/booleanos se
 *                                          persisten tal cual. Campos no listados se ignoran.
 */
function createAuditLog(opts) {
    const options = opts || {};
    const dir = options.dir;
    if (!dir || typeof dir !== 'string') {
        throw new Error('audit-log: opts.dir es obligatorio');
    }
    const redact = typeof options.redact === 'function' ? options.redact : (s) => s;
    const now = typeof options.now === 'function' ? options.now : () => Date.now();

    // Issue #3415 / CA-16 / SEC-1.6 — filenamePrefix configurable.
    // Sanitización defensiva: solo aceptamos `[A-Za-z0-9_-]+` para evitar path traversal
    // (ej. caller que sin querer pasa `../etc/passwd-`). Default retrocompatible.
    const rawPrefix = typeof options.filenamePrefix === 'string' && options.filenamePrefix.length > 0
        ? options.filenamePrefix
        : 'commander-audit';
    const filenamePrefix = /^[A-Za-z0-9_-]+$/.test(rawPrefix) ? rawPrefix : 'commander-audit';

    const extraFieldsAllowed = Array.isArray(options.extraFields)
        ? options.extraFields.filter((k) => typeof k === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
        : [];
    const extraFieldsSet = new Set(extraFieldsAllowed);

    function ensureDir() {
        try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* idempotente */ }
    }

    function currentPath(date) {
        return path.join(dir, `${filenamePrefix}-${todayStamp(date)}.jsonl`);
    }

    /**
     * @param {object} entry
     * @param {string} [entry.from]
     * @param {string|number} [entry.chat_id]
     * @param {string} [entry.raw_command]
     * @param {string} entry.intent_class
     * @param {string|null} [entry.handler]
     * @param {string} [entry.args]
     * @param {string} entry.result_status
     * @param {number} [entry.duration_ms]
     */
    function record(entry) {
        ensureDir();
        const ts = new Date(now()).toISOString();
        const row = {
            ts,
            from: entry.from || null,
            chat_id: entry.chat_id !== undefined && entry.chat_id !== null ? String(entry.chat_id) : null,
            raw_command: redact(entry.raw_command || ''),
            intent_class: entry.intent_class,
            handler: entry.handler || null,
            args_hash: sha256Hex(entry.args || ''),
            result_status: entry.result_status,
            duration_ms: Number.isFinite(entry.duration_ms) ? entry.duration_ms : 0,
        };
        // Issue #3415 / CA-17 — mergear campos extra de la whitelist. Strings pasan
        // por el redactor; números/booleanos/null se persisten directo. Cualquier
        // otro tipo se serializa con String() defensivo.
        if (extraFieldsSet.size > 0) {
            for (const key of extraFieldsSet) {
                if (!Object.prototype.hasOwnProperty.call(entry, key)) continue;
                const v = entry[key];
                if (v === null || v === undefined) {
                    row[key] = null;
                } else if (typeof v === 'number' || typeof v === 'boolean') {
                    row[key] = v;
                } else if (typeof v === 'string') {
                    row[key] = redact(v);
                } else {
                    row[key] = redact(String(v));
                }
            }
        }
        const line = JSON.stringify(row) + '\n';
        try {
            fs.appendFileSync(currentPath(new Date(now())), line);
        } catch (e) {
            // Audit log no debe romper el commander; logueamos a stderr y seguimos.
            try { process.stderr.write(`[commander-audit] ${e.message}\n`); } catch (_) {}
        }
        return row;
    }

    /**
     * Lee las entradas del archivo de hoy. Útil para métricas del dashboard.
     * @param {Date} [date]
     */
    function listToday(date) {
        const file = currentPath(date);
        if (!fs.existsSync(file)) return [];
        const raw = fs.readFileSync(file, 'utf8');
        const lines = raw.split('\n').filter(Boolean);
        const out = [];
        for (const ln of lines) {
            try { out.push(JSON.parse(ln)); } catch (_) { /* línea corrupta — skip */ }
        }
        return out;
    }

    return { record, currentPath, listToday };
}

module.exports = { createAuditLog, sha256Hex, todayStamp };

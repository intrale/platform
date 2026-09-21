'use strict';

// =============================================================================
// provider-cost.js — Telemetría granular de costo por provider (issue #4403,
// split de #3791, deliverable D4 · CA-D · H2 · RS-3).
//
// #6558 — Esquema v2 (libro contable de cuota por proveedor). Cada corrida deja
// UNA línea JSON append-only con EXACTAMENTE los campos whitelist:
//
//   { schema, timestamp, provider, skill, issue, fase,
//     tokens_in, tokens_out, cache_read, cache_write, duration_ms, resultado }
//
//   - `schema`      → 2. Marca de versión visible (CA-5): las líneas históricas
//                     (v1, sin `schema`) no llevan timestamp ni proveedor
//                     efectivo y el reader las trata como NO CONFIABLES.
//   - `timestamp`   → ISO 8601 en UTC con sufijo `Z` (CA-2). La conversión a
//                     hora local es responsabilidad de quien lo muestra.
//   - `provider`    → clave canónica del proveedor que EJECUTÓ de verdad
//                     (`anthropic`, `openai-codex`, `antigravity`,
//                     `deterministic`), no la declarada en el perfil del skill.
//   - `resultado`   → `ganada | error | rebote | abortada` (enum cerrado). Es el
//                     vocabulario canónico: reemplaza a `status` (`ok|error`)
//                     del esquema v1. Mapeo v1→v2: `ok → ganada`,
//                     `error… → error`.
//   - `duration_ms` → canónico; reemplaza a `latency_ms` de v1 (mismo valor).
//   - `cache_read` / `cache_write` → tokens cacheados (#7506); 0 si el adapter
//                     no los informa.
//
// Esquema v1 (#4403, histórico — sigue en el archivo, no se reescribe):
//   { provider, skill, issue, tokens_in, tokens_out, latency_ms, status }
//
// Fuente de verdad: `.pipeline/state/provider-cost.jsonl`. Patrón de escritura
// idéntico a `audit-log.js:293` (`appendFileSync(JSON.stringify(rec)+'\n')`),
// que garantiza un registro por línea (JSON.stringify escapa los newlines
// internos de cada string).
//
// SEGURIDAD (RS-3 · CWE-117 · A02/A09):
//   - El registro se construye por ASIGNACIÓN LITERAL de los campos. NUNCA
//     `{...opts}` ni `Object.assign(dst, opts)`: el `opts` de la fuente arrastra
//     `provider/transport/context` de error que puede ecoar la API key (401).
//   - `resultado` es un enum cerrado: cualquier valor fuera del enum cae a
//     `error` (fail-closed). `provider`, `skill` y `fase` pasan por
//     `sanitizeRawExcerpt(...)` (redacta secretos multi-proveedor + strip CR/LF
//     anti log-injection) y se truncan.
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
// degradamos a un sanitizador local mínimo en vez de romper. El texto igual
// queda sin CR/LF; los patrones de secreto se cubren en el módulo canónico.
let _sanitizeRawExcerpt;
try {
    ({ sanitizeRawExcerpt: _sanitizeRawExcerpt } = require('../quota-exhausted'));
} catch { /* fallback abajo */ }
function sanitizeText(raw, max = 80) {
    let s;
    if (typeof _sanitizeRawExcerpt === 'function') {
        s = _sanitizeRawExcerpt(raw);
    } else {
        // Fallback ultra-defensivo: strip CR/LF/TAB + truncado. No cubre secretos
        // multi-proveedor (eso vive en quota-exhausted), pero evita log-injection.
        s = String(raw == null ? '' : raw).replace(/[\r\n\t]/g, ' ');
    }
    return String(s == null ? '' : s).slice(0, max);
}

// Versión vigente del esquema. Toda línea nueva la lleva como primer campo.
const SCHEMA_VERSION = 2;

// Set exacto de campos persistidos (v2). El test afirma que `Object.keys` de
// cada línea === este array, ni una clave más (RS-3 whitelist estricta).
const WHITELIST = [
    'schema', 'timestamp', 'provider', 'skill', 'issue', 'fase',
    'tokens_in', 'tokens_out', 'cache_read', 'cache_write', 'duration_ms', 'resultado',
];

// Whitelist histórica (v1, #4403). Sólo referencia para los lectores: el writer
// ya no la emite.
const WHITELIST_V1 = ['provider', 'skill', 'issue', 'tokens_in', 'tokens_out', 'latency_ms', 'status'];

// Vocabulario cerrado de `resultado` (CA-3 · #6558).
const RESULTADOS = ['ganada', 'error', 'rebote', 'abortada'];

// Mapeo v1 → v2 de `status` a `resultado`. `ok` era el único éxito; todo lo
// demás (`error`, `error: …`) era error. Fail-closed: desconocido ⇒ `error`.
function resultadoFromStatus(status) {
    const s = String(status == null ? '' : status).trim().toLowerCase();
    if (s === '' || s === 'ok') return 'ganada';
    return 'error';
}

// Normaliza `resultado`: enum cerrado, fail-closed a `error`.
function normalizeResultado(raw) {
    const s = String(raw == null ? '' : raw).trim().toLowerCase();
    return RESULTADOS.includes(s) ? s : 'error';
}

// Timestamp ISO 8601 UTC (`Z`). Si el caller pasa uno válido se respeta (tests
// / replays); si no, se toma el reloj del proceso.
function normalizeTimestamp(raw, now) {
    if (raw != null && raw !== '') {
        const d = new Date(raw);
        if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
    const d = now instanceof Date ? now : new Date(typeof now === 'number' ? now : Date.now());
    return (Number.isNaN(d.getTime()) ? new Date() : d).toISOString();
}

// Ruta canónica del JSONL de costo por provider.
function defaultFile() {
    // #7112 — resolución POR LLAMADA vía el envoltorio (SEC-13): sin ambiente
    // declarado ni dir de pruebas avisa por stderr y LANZA (CA-3), nunca `__dirname`.
    return require('../write-target').writePath(process.env, { canal: 'logs', destino: 'state/provider-cost.jsonl' }, 'state', 'provider-cost.jsonl');
}

/**
 * Persiste un registro de costo por provider (append-only, never-throws).
 *
 * @param {object} opts
 * @param {string} opts.provider     clave canónica del provider que EJECUTÓ
 *                                   (ej. 'openai-codex'), no el declarado
 * @param {string} opts.skill        skill del agente (ej. 'backend-dev')
 * @param {number} opts.issue        número de issue
 * @param {string} [opts.fase]       fase del pipeline (ej. 'dev')
 * @param {number} opts.tokens_in    tokens de entrada (total canónico del adapter)
 * @param {number} opts.tokens_out   tokens de salida (total canónico del adapter)
 * @param {number} [opts.cache_read]  tokens leídos de cache (0 si no aplica)
 * @param {number} [opts.cache_write] tokens escritos a cache (0 si no aplica)
 * @param {number} [opts.duration_ms] duración de la ejecución en ms (canónico)
 * @param {number} [opts.latency_ms]  alias v1 de `duration_ms` (compat)
 * @param {string} [opts.resultado]   'ganada'|'error'|'rebote'|'abortada'
 * @param {string} [opts.status]      alias v1 ('ok'|'error…') → se mapea a `resultado`
 *                                    sólo si `resultado` no vino
 * @param {string} [opts.timestamp]   ISO 8601; default: ahora (UTC)
 * @param {object} [deps]             inyección para tests: { fs, file, now }
 */
function recordProviderCost(opts = {}, deps = {}) {
    const _fs = deps.fs || fs;
    const file = deps.file || defaultFile();
    try {
        // RS-3: asignación LITERAL de los campos whitelist. Prohibido spread/Object.assign.
        const record = {
            schema: SCHEMA_VERSION,
            timestamp: normalizeTimestamp(opts.timestamp, deps.now),
            provider: sanitizeText(opts.provider || 'unknown') || 'unknown',
            skill: sanitizeText(opts.skill || 'unknown') || 'unknown',
            issue: Number(opts.issue) || null,
            fase: sanitizeText(opts.fase || 'unknown') || 'unknown',
            tokens_in: Number(opts.tokens_in) || 0,
            tokens_out: Number(opts.tokens_out) || 0,
            cache_read: Number(opts.cache_read) || 0,
            cache_write: Number(opts.cache_write) || 0,
            duration_ms: Number(opts.duration_ms != null ? opts.duration_ms : opts.latency_ms) || 0,
            // Enum cerrado (fail-closed a `error`); `status` v1 sólo como fallback.
            resultado: opts.resultado != null
                ? normalizeResultado(opts.resultado)
                : resultadoFromStatus(opts.status),
        };
        try { _fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* best-effort */ }
        _fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8'); // append-only, patrón audit-log.js:293
    } catch { /* never-throws — best-effort (CA-5) */ }
}

// Un registro es "confiable" (atribuible al proveedor efectivo) si es v2+ y trae
// timestamp válido. Las líneas v1 (sin `schema`) tienen `provider` = declarado
// del skill (defecto medido en #6558: 14.258 líneas dicen `anthropic`) → NO se
// suman al bucket del proveedor; se cuentan aparte como histórico no atribuible.
function isReliableRecord(rec) {
    if (!rec || typeof rec !== 'object') return false;
    if (Number(rec.schema) < SCHEMA_VERSION) return false;
    if (!rec.timestamp) return false;
    return !Number.isNaN(new Date(rec.timestamp).getTime());
}

// Normaliza un registro (v1 o v2) a la forma v2 para los lectores. No reescribe
// el archivo: es sólo una vista. Marca `reliable` para que el consumidor decida.
function normalizeRecord(rec) {
    if (!rec || typeof rec !== 'object') return null;
    const reliable = isReliableRecord(rec);
    return {
        schema: Number(rec.schema) || 1,
        timestamp: reliable ? new Date(rec.timestamp).toISOString() : null,
        provider: String(rec.provider || 'unknown'),
        skill: String(rec.skill || 'unknown'),
        issue: Number(rec.issue) || null,
        fase: rec.fase != null ? String(rec.fase) : null,
        tokens_in: Number(rec.tokens_in) || 0,
        tokens_out: Number(rec.tokens_out) || 0,
        cache_read: Number(rec.cache_read) || 0,
        cache_write: Number(rec.cache_write) || 0,
        duration_ms: Number(rec.duration_ms != null ? rec.duration_ms : rec.latency_ms) || 0,
        resultado: rec.resultado != null ? normalizeResultado(rec.resultado) : resultadoFromStatus(rec.status),
        reliable,
    };
}

/**
 * Itera el JSONL y devuelve los registros normalizados (v1 y v2), en orden de
 * archivo. Líneas corruptas se saltean. Never-throws: `[]` si el archivo falta.
 *
 * @param {object} [deps] inyección para tests: { fs, file }
 * @returns {Array<object>} registros normalizados con flag `reliable`
 */
function readProviderCostRecords(deps = {}) {
    const _fs = deps.fs || fs;
    const file = deps.file || defaultFile();
    const out = [];
    try {
        let raw = '';
        try { raw = _fs.readFileSync(file, 'utf8'); } catch { return out; }
        for (const line of String(raw).split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            let rec;
            try { rec = JSON.parse(trimmed); } catch { continue; }
            const norm = normalizeRecord(rec);
            if (norm) out.push(norm);
        }
    } catch { /* never-throws */ }
    return out;
}

function emptyBucket() {
    return { tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, sessions: 0, errors: 0, rebotes: 0, abortadas: 0 };
}

function addToBucket(bucket, rec) {
    bucket.tokens_in += rec.tokens_in;
    bucket.tokens_out += rec.tokens_out;
    bucket.cache_read += rec.cache_read;
    bucket.cache_write += rec.cache_write;
    bucket.sessions += 1;
    if (rec.resultado === 'error') bucket.errors += 1;
    else if (rec.resultado === 'rebote') bucket.rebotes += 1;
    else if (rec.resultado === 'abortada') bucket.abortadas += 1;
}

/**
 * Lee el JSONL y agrega el consumo por provider. Consumido por el dashboard.
 *
 * Sólo las líneas CONFIABLES (v2: proveedor efectivo + timestamp) alimentan
 * `byProvider`. Las históricas (v1, proveedor declarado) se acumulan aparte en
 * `unreliable` para que el panel pueda decir "N corridas anteriores sin
 * proveedor confiable" en vez de inflar el bucket de `anthropic` (CA-5 + UX-1).
 *
 * Degrada a `{ hasData: false, byProvider: {}, totalSessions: 0, ... }` si el
 * archivo no existe, está vacío, o falla la lectura (never-throws).
 *
 * @param {object} [deps] inyección para tests: { fs, file }
 * @returns {{ hasData: boolean, byProvider: object, totalSessions: number,
 *             hasUnreliable: boolean, unreliable: object }}
 *   byProvider: { <provider>: { tokens_in, tokens_out, cache_read, cache_write,
 *                               sessions, errors, rebotes, abortadas } }
 *   unreliable: { sessions, tokens_in, tokens_out } — histórico v1 no atribuible
 */
function readProviderCostBreakdown(deps = {}) {
    const out = {
        hasData: false,
        byProvider: {},
        totalSessions: 0,
        hasUnreliable: false,
        unreliable: { sessions: 0, tokens_in: 0, tokens_out: 0 },
    };
    try {
        for (const rec of readProviderCostRecords(deps)) {
            if (!rec.reliable) {
                out.unreliable.sessions += 1;
                out.unreliable.tokens_in += rec.tokens_in;
                out.unreliable.tokens_out += rec.tokens_out;
                out.hasUnreliable = true;
                continue;
            }
            const bucket = out.byProvider[rec.provider] || (out.byProvider[rec.provider] = emptyBucket());
            addToBucket(bucket, rec);
            out.totalSessions += 1;
            out.hasData = true;
        }
    } catch { /* never-throws — degrade a empty-state */ }
    return out;
}

// Clave de período en UTC: 'day' → YYYY-MM-DD; 'week' → YYYY-Www (ISO 8601,
// semana que arranca el lunes).
function periodKey(isoTs, period) {
    const d = new Date(isoTs);
    if (period === 'week') {
        const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
        const dayNum = t.getUTCDay() || 7;           // lunes=1 … domingo=7
        t.setUTCDate(t.getUTCDate() + 4 - dayNum);   // jueves de la misma semana ISO
        const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
        const week = Math.ceil((((t - yearStart) / 86400000) + 1) / 7);
        return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
    }
    return d.toISOString().slice(0, 10);
}

/**
 * Serie temporal de consumo por proveedor y período (CA-4 · #6558). Sólo usa
 * líneas confiables (v2). Never-throws.
 *
 * @param {object} [opts]
 * @param {'day'|'week'} [opts.period='day']
 * @param {object} [deps] inyección para tests: { fs, file }
 * @returns {{ period: string, series: object, unreliableSessions: number }}
 *   series: { '<YYYY-MM-DD>|<YYYY-Www>': { '<provider>': bucket } } ordenado por clave
 */
function readProviderCostByPeriod(opts = {}, deps = {}) {
    const period = opts.period === 'week' ? 'week' : 'day';
    const out = { period, series: {}, unreliableSessions: 0 };
    try {
        const acc = {};
        for (const rec of readProviderCostRecords(deps)) {
            if (!rec.reliable) { out.unreliableSessions += 1; continue; }
            const key = periodKey(rec.timestamp, period);
            const byProv = acc[key] || (acc[key] = {});
            const bucket = byProv[rec.provider] || (byProv[rec.provider] = emptyBucket());
            addToBucket(bucket, rec);
        }
        for (const key of Object.keys(acc).sort()) out.series[key] = acc[key];
    } catch { /* never-throws */ }
    return out;
}

module.exports = {
    recordProviderCost,
    readProviderCostBreakdown,
    readProviderCostRecords,
    readProviderCostByPeriod,
    WHITELIST,
    WHITELIST_V1,
    SCHEMA_VERSION,
    RESULTADOS,
};

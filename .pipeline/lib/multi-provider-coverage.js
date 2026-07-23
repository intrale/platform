// =============================================================================
// multi-provider-coverage.js — lectura y sanitización del JSON persistido del
// harness multi-provider smoke-test (#3680) para servirlo al widget del
// dashboard V3 (#3681, hijo B del épico #3669).
//
// Mount points:
//   - dashboard-routes.js GET /api/dash/multi-provider-coverage
//   - lib/multi-provider-coverage/api.js POST /api/dash/multi-provider-coverage/run
//     (módulo aparte; este sólo hace lectura/sanitización)
//
// Contrato con el hijo A (#3680):
//   - Schema: .pipeline/multi-provider-coverage.schema.json (sibling del JSON).
//   - JSON runtime: .pipeline/multi-provider-coverage.json (generado por
//     `lib/multi-provider/smoke-test.js`). NO está committeado.
//
// Reglas duras del payload servido al cliente (REQ-SEC-B4, REQ-SEC-B6, CA-B3):
//   - Whitelist explícita por campo. NUNCA spread del raw.
//   - PROHIBIDO `api_key_prefix`, `hostname`, `latency_ms` absolutos,
//     `raw_output`, `evidence` cruda.
//   - Status fuera del enum → degrada a 'N/A' (no se filtra ese row porque
//     queremos visibilidad del data drift, pero el cliente NO lee status
//     desconocidos como FAIL/PASS).
//   - Buckets de latencia fuera del enum → null (la celda se renderiza sin
//     bucket pero conserva el resto del payload).
//   - `evidence_hash` truncado a 12 chars (convención git-style + REQ-SEC-B8).
//   - `divergence` SÓLO si status === 'WARN' (descarta divergencia para PASS
//     u otros, evita info leak transversal).
//
// Estados del payload top-level:
//   - `error: 'coverage_unavailable', reason: 'not_yet_run'`
//     → el archivo no existe (harness aún no corrió). status HTTP 503.
//   - `error: 'coverage_unavailable', reason: 'parse_error'`
//     → JSON malformado. status HTTP 503.
//   - `error: 'coverage_unavailable', reason: 'schema_invalid'`
//     → JSON existe pero no cumple el schema #3680. status HTTP 503.
//   - `error: 'coverage_unavailable', reason: 'io_error'`
//     → cualquier otro error de lectura (permisos, EBUSY). status HTTP 503.
//   - Payload OK: `{version, generated_at, run_id, duration_ms, spawns_used,
//     spawns_cap, matrix:[], summary:{}}` — status HTTP 200.
//
// Defensa en profundidad: el `_status` se setea en el envelope de error para
// que `dashboard-routes.handle()` mapee a 503 sin requerir refactor invasivo.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const COVERAGE_JSON_PATH = path.resolve(__dirname, '..', 'multi-provider-coverage.json');
const SCHEMA_PATH = path.resolve(__dirname, '..', 'multi-provider-coverage.schema.json');

const ALLOWED_STATUSES = new Set(['PASS', 'WARN', 'FAIL', 'SKIPPED', 'N/A']);
const ALLOWED_BUCKETS = new Set(['<=100ms', '<=500ms', '<=2s', '<=10s', '>10s']);
const ALLOWED_ERROR_CLASSES = new Set([
    'quota_exhausted', 'rate_limit', 'transient_5xx', 'auth',
    'permanent_failure', 'cli_1m_context_glitch', 'unknown',
    'parser_well_formed_violation', 'baseline_divergence',
    'data_residency_blocked', 'timeout', 'cap_exceeded',
]);

// Defensa: caps para evitar payloads abusivos. La matriz real ronda 17 skills
// × 5 providers = 85 entries. Aceptamos hasta 500 (10× headroom) — más allá
// es señal de tampering.
const MAX_MATRIX_ENTRIES = 500;
const MAX_STRING_LEN = 280;

// Ajv lazy-loaded: si no está disponible (rara vez, pero defensa de cinturón),
// el endpoint degrada a 503 schema_invalid en vez de crashear el server.
let _ajv = null;
let _validateFn = null;
function getValidator() {
    if (_validateFn) return _validateFn;
    try {
        if (!fs.existsSync(SCHEMA_PATH)) return null;
        const Ajv = require('ajv/dist/2020');
        if (!_ajv) {
            // strict:false porque el schema usa `format: date-time` (no
            // bloqueante con strict off) y `enum` con null mezclado en
            // taxonomías de error que Ajv en strict avisa. Mantenemos
            // estructura + tipos firmes.
            _ajv = new Ajv({ strict: false, allErrors: false });
        }
        const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
        _validateFn = _ajv.compile(schema);
        return _validateFn;
    } catch {
        return null;
    }
}

/**
 * Sanitiza una entry de la matriz. Whitelist por campo, sin spread.
 * Garantiza que el cliente NO vea: api_key_prefix, hostname, latency_ms,
 * raw_output, evidence cruda, ni status/bucket fuera del enum.
 *
 * @param {*} raw
 * @returns {object|null}
 */
function sanitizeMatrixEntry(raw) {
    if (!raw || typeof raw !== 'object') return null;

    const skill = typeof raw.skill === 'string' ? raw.skill.slice(0, 64) : '';
    const provider = typeof raw.provider === 'string' ? raw.provider.slice(0, 64) : '';
    if (!skill || !provider) return null;

    const rawStatus = typeof raw.status === 'string' ? raw.status.toUpperCase() : '';
    const status = ALLOWED_STATUSES.has(rawStatus) ? rawStatus : 'N/A';

    const rawBucket = typeof raw.latency_bucket === 'string' ? raw.latency_bucket : '';
    const latency_bucket = ALLOWED_BUCKETS.has(rawBucket) ? rawBucket : null;

    const rawErrorClass = typeof raw.error_class === 'string' ? raw.error_class : null;
    const error_class = (rawErrorClass && ALLOWED_ERROR_CLASSES.has(rawErrorClass)) ? rawErrorClass : null;

    let evidence_hash = null;
    if (typeof raw.evidence_hash === 'string' && raw.evidence_hash.length > 0) {
        // Convención git-style: prefijo de 12 chars del hex (CA-B10 + REQ-SEC-B8).
        // El JSON puede traer 'sha256:<64hex>' o directamente '<64hex>'. Nos
        // quedamos con los 12 primeros chars del hex.
        const hexOnly = raw.evidence_hash.replace(/^sha256:/, '');
        evidence_hash = /^[a-f0-9]+$/i.test(hexOnly) ? hexOnly.slice(0, 12) : null;
    }

    // CA-B10.bis (REQ-SEC-B7): NO concatenamos el campo `issue` con la URL
    // acá; el cliente construye la URL con cast Number() explícito.
    // Acá sólo emitimos el número saneado (o null).
    let issue = null;
    if (raw.issue !== null && raw.issue !== undefined) {
        const n = Number(raw.issue);
        issue = Number.isInteger(n) && n > 0 ? n : null;
    }

    const model = typeof raw.model === 'string' ? raw.model.slice(0, 128) : '';

    let timestamp = null;
    if (typeof raw.timestamp === 'string' && raw.timestamp.length < 64) {
        timestamp = raw.timestamp;
    } else if (typeof raw.generated_at === 'string' && raw.generated_at.length < 64) {
        timestamp = raw.generated_at;
    }

    // CA-B13: divergence sólo en WARN. En cualquier otro status descartamos
    // el campo aunque venga en el raw — defensa contra info leak transversal.
    let divergence = null;
    if (status === 'WARN' && typeof raw.divergence === 'string') {
        divergence = raw.divergence.slice(0, MAX_STRING_LEN);
    }

    // `reason` saneado y acotado. Útil para SKIPPED y N/A.
    let reason = null;
    if (typeof raw.reason === 'string' && raw.reason.length > 0) {
        reason = raw.reason.slice(0, MAX_STRING_LEN);
    } else if (typeof raw.na_reason === 'string' && raw.na_reason.length > 0) {
        reason = raw.na_reason.slice(0, MAX_STRING_LEN);
    }

    return {
        skill,
        provider,
        status,
        latency_bucket,
        error_class,
        evidence_hash,
        issue,
        model,
        timestamp,
        divergence,
        reason,
    };
}

/**
 * Sanitiza el summary. Whitelist explícita.
 * @param {*} raw
 * @returns {object}
 */
function sanitizeSummary(raw) {
    if (!raw || typeof raw !== 'object') {
        return {
            pass: 0, warn: 0, fail: 0, skipped: 0, na: 0,
            total_combinations: 0, skills_llm_count: 0, providers_llm_count: 0,
        };
    }
    const num = (v) => {
        const n = Number(v);
        return Number.isInteger(n) && n >= 0 ? n : 0;
    };
    return {
        pass: num(raw.pass),
        warn: num(raw.warn),
        fail: num(raw.fail),
        skipped: num(raw.skipped),
        na: num(raw.na),
        total_combinations: num(raw.total_combinations),
        skills_llm_count: num(raw.skills_llm_count),
        providers_llm_count: num(raw.providers_llm_count),
    };
}

/**
 * Sanitiza el payload completo. Whitelist por campo. NO spread.
 *
 * @param {object} raw — JSON parseado y validado contra el schema #3680.
 * @returns {object} payload limpio.
 */
function sanitizeCoveragePayload(raw) {
    const matrix = Array.isArray(raw.matrix) ? raw.matrix : [];
    const sanitizedMatrix = matrix
        .slice(0, MAX_MATRIX_ENTRIES)
        .map(sanitizeMatrixEntry)
        .filter(Boolean);

    // Algunas extensiones futuras (duration_ms, spawns_used, spawns_cap) viven
    // en root del JSON pero NO son required por el schema. Las emitimos como
    // null si no vienen — el widget muestra "—".
    const duration_ms = Number.isFinite(Number(raw.duration_ms)) ? Number(raw.duration_ms) : null;
    const spawns_used = Number.isFinite(Number(raw.spawns_used)) ? Number(raw.spawns_used) : 0;
    const spawns_cap = Number.isFinite(Number(raw.spawns_cap)) ? Number(raw.spawns_cap) : 60;

    return {
        version: typeof raw.version === 'string' ? raw.version : '1.0.0',
        generated_at: typeof raw.generated_at === 'string' ? raw.generated_at : null,
        run_id: typeof raw.run_id === 'string' ? raw.run_id.slice(0, 64) : null,
        duration_ms,
        spawns_used,
        spawns_cap,
        matrix: sanitizedMatrix,
        summary: sanitizeSummary(raw.summary),
        warnings: Array.isArray(raw.warnings)
            ? raw.warnings.filter((w) => typeof w === 'string').map((w) => w.slice(0, MAX_STRING_LEN)).slice(0, 50)
            : [],
    };
}

/**
 * Punto de entrada del endpoint GET /api/dash/multi-provider-coverage.
 * Lee + valida + sanitiza, o emite envelope de error con `_status` 503.
 *
 * @param {object} [opts] opciones para tests.
 * @param {string} [opts.coveragePath] override del path del JSON.
 * @param {object} [opts.fsImpl] override de fs (para tests).
 * @returns {object} payload limpio o envelope `{error, reason, _status}`.
 */
function buildCoveragePayload(opts = {}) {
    const coveragePath = opts.coveragePath || COVERAGE_JSON_PATH;
    const fsImpl = opts.fsImpl || fs;

    if (!fsImpl.existsSync(coveragePath)) {
        return { error: 'coverage_unavailable', reason: 'not_yet_run', _status: 503 };
    }

    let raw;
    try {
        const text = fsImpl.readFileSync(coveragePath, 'utf8');
        try {
            raw = JSON.parse(text);
        } catch {
            return { error: 'coverage_unavailable', reason: 'parse_error', _status: 503 };
        }
    } catch {
        return { error: 'coverage_unavailable', reason: 'io_error', _status: 503 };
    }

    const validator = opts.validator || getValidator();
    if (!validator) {
        // Sin validator no podemos asegurar la integridad del JSON.
        // Degradamos a 503 antes que servir datos potencialmente malformados.
        return { error: 'coverage_unavailable', reason: 'schema_invalid', _status: 503 };
    }
    const ok = validator(raw);
    if (!ok) {
        return { error: 'coverage_unavailable', reason: 'schema_invalid', _status: 503 };
    }

    return sanitizeCoveragePayload(raw);
}

module.exports = {
    buildCoveragePayload,
    sanitizeCoveragePayload,
    sanitizeMatrixEntry,
    sanitizeSummary,
    // Exports para tests
    _internal: {
        ALLOWED_STATUSES,
        ALLOWED_BUCKETS,
        ALLOWED_ERROR_CLASSES,
        MAX_MATRIX_ENTRIES,
        MAX_STRING_LEN,
        COVERAGE_JSON_PATH,
        SCHEMA_PATH,
        getValidator,
    },
};

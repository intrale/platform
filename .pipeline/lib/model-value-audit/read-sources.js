'use strict';

// =============================================================================
// model-value-audit / read-sources — lectores de ventana, read-only (#7517)
// =============================================================================
//
// Capa de insumos del auditor de calidad-precio por agente (#6793, parte 1).
// Lee las cinco fuentes del pipeline acotadas a una ventana `[from, to]`
// (epoch ms, inclusiva en ambos extremos) y devuelve SOLO filas proyectadas
// contra una whitelist por fuente. Nada de lo que no esté en la whitelist
// (`raw_excerpt`, `evidence`, `status`, `evaluadores`, `target`, paths,
// títulos) sobrevive aguas abajo (SEC-8 / CA-8).
//
// Reglas de lectura (receta del Arquitecto A1–A10):
//   - Fuentes fechadas (`logs/spawn-exit-YYYY-MM-DD.jsonl`,
//     `logs/rebound-events-YYYY-MM-DD.jsonl`): doble filtro, por fecha del
//     nombre (clave UTC) y por `ts` de cada fila.
//   - Fuentes monolíticas (`state/effective-model.jsonl`,
//     `state/provider-cost.jsonl`, `state/label-mutations.jsonl` + `.1`):
//     filtro por `ts` de cada fila.
//   - Tope `MAX_BYTES_PER_FILE` por `statSync().size` ANTES de leer (A8):
//     nunca lectura parcial.
//   - `spawn-exit` es la única fuente con hash-chain verificada por archivo
//     (`auditLog.verifyChain`); las demás salen `no_verificada` (D2).
//   - `try/catch` por línea en las fuentes sin chain: una línea corrupta se
//     salta y se cuenta, las demás se leen.
//   - `issue == null` se preserva como `null` (5 % de spawn-exit, A3) y se
//     cuenta en `sin_issue`; el resto se devuelve como `String(issue)`. La
//     validación `/^\d{1,7}$/` es de `sanitize.js` (CA-12).
//   - Costo fail-closed (D5 / CA-11): una fila válida sin fecha ⇒ toda la
//     ventana `evaluable: false, reason: 'sin_ts'`. Prohibido inferir fechas
//     por posición.
//
// Este módulo NO escribe nada, no ejecuta procesos y no abre red (CA-20).
// Sólo `require` de `fs`, `path` y módulos relativos dentro de `lib/`.

const fs = require('fs');
const path = require('path');

const MAX_BYTES_PER_FILE = 8 * 1024 * 1024;

// Vocabulario cerrado (CA-13): ningún `reason` / `estado` se emite como literal
// suelto fuera de estos enums. La parte (3) construye sus labels sobre ellos.
const REASON = Object.freeze({
    SIN_TS: 'sin_ts',
    OVERSIZE: 'oversize',
});

const INTEGRIDAD_ESTADO = Object.freeze({
    VERIFICADA: 'verificada',
    NO_VERIFICADA: 'no_verificada',
});

// Valor fijo hasta que #7506 mida caché (parte 3).
const CACHE_NO_MEDIDO = 'no_medido';

// Whitelists de proyección por fuente (CA-8). `ts` se agrega siempre ya
// normalizado a epoch ms.
const SPAWN_FIELDS = Object.freeze(['skill', 'issue', 'provider', 'exit_code', 'duration_ms', 'death_kind', 'codepath']);
const REBOUND_FIELDS = Object.freeze(['issue', 'skill', 'provider', 'rechazado_en_fase']);
const EFFECTIVE_FIELDS = Object.freeze(['issue', 'skill', 'provider', 'model_effective', 'source']);
const COST_FIELDS = Object.freeze(['provider', 'skill', 'issue', 'tokens_in', 'tokens_out']);
const QA_FIELDS = Object.freeze(['issue', 'label', 'action']);

const QA_LABEL = 'qa:failed';
const QA_ACTION = 'label';

// -----------------------------------------------------------------------------
// Helpers puros
// -----------------------------------------------------------------------------

/** Clave `YYYY-MM-DD` en UTC (idéntico a provider-contribution.utcDayKey). */
function utcDayKey(ms) {
    const d = new Date(ms);
    return [
        d.getUTCFullYear(),
        String(d.getUTCMonth() + 1).padStart(2, '0'),
        String(d.getUTCDate()).padStart(2, '0'),
    ].join('-');
}

/** Epoch ms de un valor `ts` (número finito o ISO parseable); NaN si no. */
function parseTs(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
    if (typeof value === 'string' && value.trim()) {
        const p = Date.parse(value);
        return Number.isFinite(p) ? p : NaN;
    }
    return NaN;
}

function inWindow(ts, from, to) {
    if (Number.isFinite(from) && ts < from) return false;
    if (Number.isFinite(to) && ts > to) return false;
    return true;
}

/** Proyección whitelist: sólo campos propios listados en `fields`. */
function project(row, fields) {
    const out = {};
    if (!row || typeof row !== 'object') return out;
    for (const f of fields) {
        if (Object.prototype.hasOwnProperty.call(row, f)) out[f] = row[f];
    }
    return out;
}

/** Regla A3: `null` se preserva; lo demás se devuelve como string. */
function normalizeIssue(projected, integridad) {
    if (projected.issue == null) {
        projected.issue = null;
        integridad.sin_issue++;
    } else {
        projected.issue = String(projected.issue);
    }
}

function nuevaIntegridad(estado) {
    return {
        estado,
        broken: [],
        skipped: [],
        files: 0,
        lines: 0,
        rows: 0,
        sin_ts: 0,
        sin_issue: 0,
        // Filas parseables y con fecha válida que quedaron fuera por ventana o
        // por predicado (p. ej. `label !== 'qa:failed'`). Distingue "sin datos en
        // la ventana" de "la fuente cambió de forma" (CA-14).
        filtradas: 0,
        // Líneas que no parsearon como JSON (fuentes sin chain).
        lineas_corruptas: 0,
        schema_mismatch: false,
    };
}

/**
 * CA-14: `schema_mismatch` = hubo líneas, ninguna fila válida, ninguna chain
 * rota y nada quedó afuera sólo por ventana/predicado. Si TODO lo válido cayó
 * por ventana, es "sin datos en la ventana", no un cambio de forma.
 */
function cerrarIntegridad(integridad) {
    integridad.schema_mismatch = integridad.lines > 0
        && integridad.rows === 0
        && integridad.broken.length === 0
        && integridad.filtradas === 0;
    return integridad;
}

/** Tamaño en bytes si excede el tope, 0 si no (o si `statSync` falla). */
function oversize(file, fsImpl) {
    try {
        const size = fsImpl.statSync(file).size;
        return size > MAX_BYTES_PER_FILE ? size : 0;
    } catch {
        return 0;
    }
}

function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Lista archivos `<prefix>YYYY-MM-DD.jsonl` de `dir` cuya fecha (clave UTC)
 * cae dentro de la ventana. Copia de `listDispatchFiles` con prefijo
 * parametrizado.
 *
 * @returns {string[]} paths absolutos ordenados por fecha ascendente
 */
function listDatedFiles({ dir, prefix, from, to, fsImpl = fs }) {
    const re = new RegExp('^' + escapeRegex(prefix) + '(\\d{4}-\\d{2}-\\d{2})\\.jsonl$');
    let names = [];
    try {
        if (!fsImpl.existsSync(dir)) return [];
        names = fsImpl.readdirSync(dir);
    } catch {
        return [];
    }
    const fromKey = Number.isFinite(from) ? utcDayKey(from) : null;
    const toKey = Number.isFinite(to) ? utcDayKey(to) : null;
    return names
        .map((n) => String(n))
        .filter((n) => re.test(n))
        .filter((n) => {
            const key = re.exec(n)[1];
            if (fromKey && key < fromKey) return false;
            if (toKey && key > toKey) return false;
            return true;
        })
        .sort()
        .map((n) => path.join(dir, n));
}

/**
 * Lee un archivo JSONL sin chain con `try/catch` por línea. Devuelve los
 * objetos parseados; las líneas corruptas se cuentan en `integridad`.
 */
function readJsonLines(file, fsImpl, integridad) {
    let content;
    try {
        content = fsImpl.readFileSync(file, 'utf8');
    } catch {
        return [];
    }
    const out = [];
    for (const line of String(content).split(/\r?\n/)) {
        if (!line.trim()) continue;
        integridad.lines++;
        try {
            const parsed = JSON.parse(line);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) out.push(parsed);
            else integridad.lineas_corruptas++;
        } catch {
            integridad.lineas_corruptas++;
        }
    }
    return out;
}

/**
 * Gate común de las fuentes monolíticas: existencia + tope de bytes (A8).
 * Devuelve `{ skip: true, result }` cuando hay que cortar antes de leer.
 */
function gateMonolitico(file, fsImpl, integridad) {
    let exists = false;
    try { exists = fsImpl.existsSync(file); } catch { exists = false; }
    if (!exists) return { exists: false, oversize: 0 };
    integridad.files++;
    const bytes = oversize(file, fsImpl);
    if (bytes) {
        integridad.skipped.push({ file: path.basename(file), bytes });
        return { exists: true, oversize: bytes };
    }
    return { exists: true, oversize: 0 };
}

function resultadoOversize(integridad) {
    const bytes = integridad.skipped.reduce((acc, s) => Math.max(acc, s.bytes), 0);
    return { rows: [], evaluable: false, reason: REASON.OVERSIZE, bytes, integridad: cerrarIntegridad(integridad) };
}

// -----------------------------------------------------------------------------
// spawn-exit (con hash-chain, A6 / CA-6)
// -----------------------------------------------------------------------------

function readSpawnExits({ pipelineDir, from, to, fsImpl = fs, auditLog } = {}) {
    const _auditLog = auditLog || require('../audit-log');
    const integridad = nuevaIntegridad(INTEGRIDAD_ESTADO.VERIFICADA);
    const rows = [];
    const files = listDatedFiles({ dir: path.join(pipelineDir, 'logs'), prefix: 'spawn-exit-', from, to, fsImpl });

    for (const file of files) {
        integridad.files++;
        const bytes = oversize(file, fsImpl);
        if (bytes) {
            integridad.skipped.push({ file: path.basename(file), bytes });
            continue;
        }
        let verdict;
        try {
            verdict = _auditLog.verifyChain(file, fsImpl);
        } catch (err) {
            verdict = { ok: false, reason: err && err.message };
        }
        if (!verdict || !verdict.ok) {
            // Chain rota: el archivo entero queda fuera. La integridad dudosa no
            // alimenta el criterio (SEC-1b).
            integridad.broken.push(path.basename(file));
            continue;
        }
        let raw;
        try {
            raw = _auditLog.readAll(file, fsImpl);
        } catch {
            integridad.broken.push(path.basename(file));
            continue;
        }
        for (const item of raw) {
            integridad.lines++;
            if (!item || typeof item !== 'object') { integridad.lineas_corruptas++; continue; }
            const ts = parseTs(item.ts);
            if (!Number.isFinite(ts)) { integridad.sin_ts++; continue; }
            if (!inWindow(ts, from, to)) { integridad.filtradas++; continue; }
            const p = project(item, SPAWN_FIELDS);
            p.ts = ts;
            normalizeIssue(p, integridad);
            rows.push(p);
            integridad.rows++;
        }
    }
    return { rows, evaluable: true, integridad: cerrarIntegridad(integridad) };
}

// -----------------------------------------------------------------------------
// rebound-events (sin chain, D2)
// -----------------------------------------------------------------------------

function readReboundEvents({ pipelineDir, from, to, fsImpl = fs } = {}) {
    const integridad = nuevaIntegridad(INTEGRIDAD_ESTADO.NO_VERIFICADA);
    const rows = [];
    const files = listDatedFiles({ dir: path.join(pipelineDir, 'logs'), prefix: 'rebound-events-', from, to, fsImpl });

    for (const file of files) {
        integridad.files++;
        const bytes = oversize(file, fsImpl);
        if (bytes) {
            integridad.skipped.push({ file: path.basename(file), bytes });
            continue;
        }
        for (const item of readJsonLines(file, fsImpl, integridad)) {
            const ts = parseTs(item.ts);
            if (!Number.isFinite(ts)) { integridad.sin_ts++; continue; }
            if (!inWindow(ts, from, to)) { integridad.filtradas++; continue; }
            const p = project(item, REBOUND_FIELDS);
            p.ts = ts;
            normalizeIssue(p, integridad);
            rows.push(p);
            integridad.rows++;
        }
    }
    return { rows, evaluable: true, integridad: cerrarIntegridad(integridad) };
}

// -----------------------------------------------------------------------------
// effective-model (monolítico, A7 / CA-17)
// -----------------------------------------------------------------------------

function readEffectiveModels({ pipelineDir, from, to, fsImpl = fs, effectiveModel } = {}) {
    const _effectiveModel = effectiveModel || require('../metrics/effective-model');
    const integridad = nuevaIntegridad(INTEGRIDAD_ESTADO.NO_VERIFICADA);
    const rows = [];
    const file = path.join(pipelineDir, 'state', 'effective-model.jsonl');

    const gate = gateMonolitico(file, fsImpl, integridad);
    if (!gate.exists) return { rows, evaluable: true, integridad: cerrarIntegridad(integridad) };
    if (gate.oversize) return resultadoOversize(integridad);

    // `readRecords` traga errores y devuelve `[]`; contamos las líneas por
    // nuestra cuenta para poder emitir `schema_mismatch` (A7).
    try {
        const content = fsImpl.readFileSync(file, 'utf8');
        for (const line of String(content).split(/\r?\n/)) {
            if (line.trim()) integridad.lines++;
        }
    } catch {
        // Si no se puede leer, `readRecords` tampoco podrá: quedará lines=0/rows=0.
    }

    let records = [];
    try {
        // El parámetro del helper se llama `fs`, no `fsImpl` (A7).
        records = _effectiveModel.readRecords({ file, fs: fsImpl }) || [];
    } catch {
        records = [];
    }

    for (const r of records) {
        if (!r || typeof r !== 'object') continue;
        const ts = parseTs(r.ts);
        if (!Number.isFinite(ts)) { integridad.sin_ts++; continue; }
        if (!inWindow(ts, from, to)) { integridad.filtradas++; continue; }
        const p = project(r, EFFECTIVE_FIELDS);
        p.ts = ts;
        // `null` se conserva (45 % de las filas, `source: not_observable`); lo
        // no-null se re-normaliza con el mismo validador del writer.
        p.model_effective = r.model_effective == null ? null : _effectiveModel.normalizeModelId(r.model_effective);
        normalizeIssue(p, integridad);
        rows.push(p);
        integridad.rows++;
    }
    return { rows, evaluable: true, integridad: cerrarIntegridad(integridad) };
}

// -----------------------------------------------------------------------------
// provider-cost (monolítico, fail-closed D5 / CA-11)
// -----------------------------------------------------------------------------

function readCostWindow({ pipelineDir, from, to, fsImpl = fs } = {}) {
    const integridad = nuevaIntegridad(INTEGRIDAD_ESTADO.NO_VERIFICADA);
    const rows = [];
    const file = path.join(pipelineDir, 'state', 'provider-cost.jsonl');

    const gate = gateMonolitico(file, fsImpl, integridad);
    if (!gate.exists) return { rows, evaluable: true, integridad: cerrarIntegridad(integridad) };
    if (gate.oversize) return resultadoOversize(integridad);

    let sinFecha = false;
    for (const item of readJsonLines(file, fsImpl, integridad)) {
        // El writer v2 (#6558) emite `timestamp` ISO; `ts` se acepta por
        // compatibilidad con la spec. Nunca se infiere por posición (SEC-9).
        const ts = parseTs(item.timestamp !== undefined ? item.timestamp : item.ts);
        if (!Number.isFinite(ts)) {
            integridad.sin_ts++;
            sinFecha = true;
            continue;
        }
        if (!inWindow(ts, from, to)) { integridad.filtradas++; continue; }
        const p = project(item, COST_FIELDS);
        p.ts = ts;
        p.cache = CACHE_NO_MEDIDO;
        normalizeIssue(p, integridad);
        rows.push(p);
        integridad.rows++;
    }

    if (sinFecha) {
        // Una sola fila válida sin fecha invalida la ventana completa: no se
        // puede saber qué parte del costo cae adentro.
        integridad.rows = 0;
        return { rows: [], evaluable: false, reason: REASON.SIN_TS, integridad: cerrarIntegridad(integridad) };
    }
    return { rows, evaluable: true, integridad: cerrarIntegridad(integridad) };
}

// -----------------------------------------------------------------------------
// label-mutations → QA fallido (monolítico + rotado `.1`, A1 / CA-15)
// -----------------------------------------------------------------------------

function readQaFailures({ pipelineDir, from, to, fsImpl = fs } = {}) {
    const integridad = nuevaIntegridad(INTEGRIDAD_ESTADO.NO_VERIFICADA);
    const rows = [];
    const activo = path.join(pipelineDir, 'state', 'label-mutations.jsonl');
    // El rotado se lee primero (es la mitad vieja de la ventana).
    const candidatos = [`${activo}.1`, activo];

    for (const file of candidatos) {
        const gate = gateMonolitico(file, fsImpl, integridad);
        if (!gate.exists) continue;
        if (gate.oversize) return resultadoOversize(integridad);

        for (const item of readJsonLines(file, fsImpl, integridad)) {
            // Schema real del writer: {issue, label, action, target, at}.
            const conSchema = typeof item.label === 'string' && typeof item.action === 'string';
            const ts = parseTs(item.at);
            if (!conSchema || !Number.isFinite(ts)) { integridad.sin_ts++; continue; }
            if (!inWindow(ts, from, to)) { integridad.filtradas++; continue; }
            if (item.label !== QA_LABEL || item.action !== QA_ACTION) { integridad.filtradas++; continue; }
            const p = project(item, QA_FIELDS);
            p.ts = ts;
            normalizeIssue(p, integridad);
            rows.push(p);
            integridad.rows++;
        }
    }
    return { rows, evaluable: true, integridad: cerrarIntegridad(integridad) };
}

// -----------------------------------------------------------------------------
// readSources — contrato para la parte (2) (A10)
// -----------------------------------------------------------------------------

function readSources({ pipelineDir, from, to, fsImpl = fs, auditLog, effectiveModel } = {}) {
    return {
        spawn_exit: readSpawnExits({ pipelineDir, from, to, fsImpl, auditLog }),
        rebound_events: readReboundEvents({ pipelineDir, from, to, fsImpl }),
        effective_model: readEffectiveModels({ pipelineDir, from, to, fsImpl, effectiveModel }),
        provider_cost: readCostWindow({ pipelineDir, from, to, fsImpl }),
        label_mutations: readQaFailures({ pipelineDir, from, to, fsImpl }),
        ventana: { from, to },
    };
}

module.exports = {
    MAX_BYTES_PER_FILE,
    REASON,
    INTEGRIDAD_ESTADO,
    CACHE_NO_MEDIDO,
    SPAWN_FIELDS,
    REBOUND_FIELDS,
    EFFECTIVE_FIELDS,
    COST_FIELDS,
    QA_FIELDS,
    utcDayKey,
    parseTs,
    listDatedFiles,
    readSpawnExits,
    readReboundEvents,
    readEffectiveModels,
    readCostWindow,
    readQaFailures,
    readSources,
};

'use strict';

// =============================================================================
// process-audit / read-verdicts — insumos del eje proceso, read-only (#6809 H2)
// =============================================================================
//
// Cuatro lectores acotados a una ventana `[from, to]` (epoch ms):
//
//   - `readProcesadoVerdicts`: YAMLs `<pipeline>/<fase>/procesado/<issue>.<skill>`
//     (fecha = mtime). Sólo se extrae `resultado`; el resto del YAML (motivo,
//     notas, paths) NUNCA se lee aguas abajo.
//   - `readRebounds`: `logs/rebound-events-YYYY-MM-DD.jsonl` con la lista de
//     `evaluadores` (quién rechazó) y `rechazado_en_fase`.
//   - `readCostRuns`: `state/provider-cost.jsonl` v2 (sólo líneas confiables)
//     por el lector canónico de #6558, con tope de bytes previo.
//   - `readFailures`: `logs/spawn-exit-*` vía `model-value-audit/read-sources`
//     (hash-chain verificada), reducido a muertes/salidas no normales.
//
// SEC-6809-3: todo campo se proyecta por whitelist (`skill`, `fase`,
// `resultado`, números, enums). Una fila que no valida se descarta y se cuenta.
// Ningún texto libre de la telemetría sobrevive (ni `motivo`, ni stderr, ni
// `raw_excerpt`). SEC-6809-1: este módulo no escribe, no lanza procesos y no
// abre red.

const fs = require('fs');
const path = require('path');

const readSources = require('../model-value-audit/read-sources');

const SKILL_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const FASE_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const ISSUE_RE = /^\d{1,7}$/;
const RESULTADO_RE = /^resultado:\s*["']?([A-Za-z_-]{1,20})["']?\s*(?:#.*)?$/m;
const RESULTADOS_VEREDICTO = Object.freeze(['aprobado', 'rechazado']);
const RESULTADOS_COSTO = Object.freeze(['ganada', 'error', 'rebote', 'abortada']);
const DEATH_KINDS = Object.freeze(['normal', 'agent-death', 'provider-death', 'credential-death']);

/** Pipelines cuyos `procesado/` se leen (allowlist cerrada: nada de `servicios/`). */
const PIPELINES = Object.freeze(['definicion', 'desarrollo']);
const MAX_YAML_BYTES = 64 * 1024;
const MAX_YAMLS = 20000;
const MAX_JSONL_BYTES = 8 * 1024 * 1024;
const MAX_COST_BYTES = 32 * 1024 * 1024;

function enVentana(ts, from, to) {
    return Number.isFinite(ts) && ts >= from && ts <= to;
}

function nuevaIntegridad() {
    return { leidas: 0, descartadas: 0, fuera_de_ventana: 0, oversize: 0 };
}

function listar(dir, fsImpl) {
    try {
        if (!fsImpl.existsSync(dir)) return [];
        return fsImpl.readdirSync(dir).map(String).sort();
    } catch {
        return [];
    }
}

/**
 * Veredictos de los YAMLs ya procesados.
 * @returns {{rows:Array<{skill,fase,resultado,ts}>, integridad:object}}
 */
function readProcesadoVerdicts({ pipelineDir, from, to, fsImpl = fs } = {}) {
    const integridad = nuevaIntegridad();
    const rows = [];
    let vistos = 0;
    for (const pipeline of PIPELINES) {
        const base = path.join(pipelineDir, pipeline);
        for (const fase of listar(base, fsImpl)) {
            if (!FASE_RE.test(fase)) continue;
            const dir = path.join(base, fase, 'procesado');
            for (const nombre of listar(dir, fsImpl)) {
                if (vistos++ >= MAX_YAMLS) return { rows, integridad, truncado: true };
                const m = /^(\d{1,7})\.([a-z0-9][a-z0-9-]{0,39})$/.exec(nombre);
                if (!m) continue;
                const file = path.join(dir, nombre);
                let st;
                try { st = fsImpl.statSync(file); } catch { integridad.descartadas++; continue; }
                if (!st.isFile()) continue;
                const ts = st.mtimeMs;
                if (!enVentana(ts, from, to)) { integridad.fuera_de_ventana++; continue; }
                if (st.size > MAX_YAML_BYTES) { integridad.oversize++; continue; }
                let texto;
                try { texto = String(fsImpl.readFileSync(file, 'utf8')); } catch { integridad.descartadas++; continue; }
                integridad.leidas++;
                const r = RESULTADO_RE.exec(texto);
                const resultado = r && RESULTADOS_VEREDICTO.includes(r[1].toLowerCase()) ? r[1].toLowerCase() : null;
                if (!resultado) { integridad.descartadas++; continue; }
                rows.push({ skill: m[2], fase, resultado, ts });
            }
        }
    }
    return { rows, integridad, truncado: false };
}

/**
 * Rebotes con sus evaluadores.
 * @returns {{rows:Array<{skill,fase,evaluadores:string[],ts}>, integridad:object}}
 */
function readRebounds({ pipelineDir, from, to, fsImpl = fs } = {}) {
    const integridad = nuevaIntegridad();
    const rows = [];
    const files = readSources.listDatedFiles({ dir: path.join(pipelineDir, 'logs'), prefix: 'rebound-events-', from, to, fsImpl });
    for (const file of files) {
        let size = 0;
        try { size = fsImpl.statSync(file).size; } catch { continue; }
        if (size > MAX_JSONL_BYTES) { integridad.oversize++; continue; }
        let texto;
        try { texto = String(fsImpl.readFileSync(file, 'utf8')); } catch { continue; }
        for (const linea of texto.split(/\r?\n/)) {
            if (!linea.trim()) continue;
            let raw;
            try { raw = JSON.parse(linea); } catch { integridad.descartadas++; continue; }
            const ts = Date.parse(raw && raw.ts);
            if (!enVentana(ts, from, to)) { integridad.fuera_de_ventana++; continue; }
            const skill = typeof raw.skill === 'string' && SKILL_RE.test(raw.skill) ? raw.skill : null;
            const fase = typeof raw.rechazado_en_fase === 'string' && FASE_RE.test(raw.rechazado_en_fase) ? raw.rechazado_en_fase : null;
            if (!fase) { integridad.descartadas++; continue; }
            const evaluadores = Array.isArray(raw.evaluadores)
                ? raw.evaluadores.filter((e) => typeof e === 'string' && SKILL_RE.test(e)).slice(0, 20)
                : [];
            integridad.leidas++;
            rows.push({ skill, fase, evaluadores, ts });
        }
    }
    return { rows, integridad };
}

/**
 * Corridas con costo (provider-cost v2 confiable).
 * @returns {{rows:Array<{skill,fase,resultado,tokens,ts}>, evaluable:boolean, integridad:object}}
 */
function readCostRuns({ pipelineDir, from, to, fsImpl = fs, providerCost } = {}) {
    const integridad = nuevaIntegridad();
    const rows = [];
    const file = path.join(pipelineDir, 'state', 'provider-cost.jsonl');
    try {
        if (!fsImpl.existsSync(file)) return { rows, evaluable: true, integridad };
        if (fsImpl.statSync(file).size > MAX_COST_BYTES) {
            integridad.oversize++;
            return { rows, evaluable: false, integridad };
        }
    } catch {
        return { rows, evaluable: false, integridad };
    }
    const pc = providerCost || require('../metrics/provider-cost');
    let records = [];
    try { records = pc.readProviderCostRecords({ file, fs: fsImpl }) || []; } catch { records = []; }
    for (const r of records) {
        if (!r || r.reliable !== true) { integridad.descartadas++; continue; }
        const ts = Date.parse(r.timestamp);
        if (!enVentana(ts, from, to)) { integridad.fuera_de_ventana++; continue; }
        const skill = typeof r.skill === 'string' && SKILL_RE.test(r.skill) ? r.skill : null;
        const fase = typeof r.fase === 'string' && FASE_RE.test(r.fase) ? r.fase : null;
        const resultado = RESULTADOS_COSTO.includes(r.resultado) ? r.resultado : null;
        const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
        if (!skill || !fase || !resultado) { integridad.descartadas++; continue; }
        integridad.leidas++;
        rows.push({ skill, fase, resultado, tokens: n(r.tokens_in) + n(r.tokens_out) + n(r.cache_write), ts });
    }
    return { rows, evaluable: true, integridad };
}

/**
 * Fallos (salidas no normales) de `spawn-exit`, proyectados.
 * @returns {{rows:Array<{skill,death_kind,exit_code,ts}>, evaluable:boolean, integridad:object}}
 */
function readFailures({ pipelineDir, from, to, fsImpl = fs, auditLog } = {}) {
    let res;
    try {
        res = readSources.readSpawnExits({ pipelineDir, from, to, fsImpl, auditLog });
    } catch {
        return { rows: [], evaluable: false, integridad: nuevaIntegridad() };
    }
    const rows = [];
    for (const r of (res && res.rows) || []) {
        const skill = typeof r.skill === 'string' && SKILL_RE.test(r.skill) ? r.skill : null;
        const dk = DEATH_KINDS.includes(r.death_kind) ? r.death_kind : (r.death_kind == null ? 'normal' : null);
        const ec = (typeof r.exit_code === 'number' && Number.isInteger(r.exit_code)) ? r.exit_code : null;
        if (!skill || !dk) continue;
        if (dk === 'normal' && (ec === 0 || ec === null)) continue;
        rows.push({ skill, death_kind: dk, exit_code: ec, ts: r.ts });
    }
    return { rows, evaluable: !!(res && res.evaluable), integridad: res && res.integridad };
}

module.exports = {
    PIPELINES,
    RESULTADOS_VEREDICTO,
    SKILL_RE,
    FASE_RE,
    ISSUE_RE,
    readProcesadoVerdicts,
    readRebounds,
    readCostRuns,
    readFailures,
};

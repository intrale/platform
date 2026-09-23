'use strict';

// =============================================================================
// process-audit / read-hourly — lector del rollup horario (#6809 H1/H3)
// =============================================================================
//
// Lee `metrics-history-hourly.jsonl` acotado a una ventana. Read-only.
// SEC-6809-8: tope de bytes por `statSync` ANTES de leer (nunca lectura
// parcial), tope de líneas, y una línea corrupta se descarta sin abortar.
// SEC-6809-3: cada línea se proyecta por whitelist; lo que no valida se cuenta
// como descartado y no viaja aguas abajo.

const fs = require('fs');
const path = require('path');

const { FILE_NAME, MAX_LINES } = require('./hourly-rollup');

const MAX_BYTES = 8 * 1024 * 1024;
const CAUSA_RE = /^[a-z0-9_-]{1,40}$/;
const AGENTES_RE = /^\d{1,2}$/;

function numOrNull(v, max) {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return undefined;
    if (max !== undefined && v > max) return undefined;
    return v;
}

/** Proyección estricta de una línea. `null` si no valida. */
function proyectar(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const ts = Date.parse(raw.ts_hora);
    if (!Number.isFinite(ts)) return null;
    const n = numOrNull(raw.n_muestras, 100000);
    const cero = numOrNull(raw.muestras_cero_agentes, 100000);
    if (!n || cero === undefined || cero === null || cero > n) return null;
    const por = {};
    const src = raw.por_agentes && typeof raw.por_agentes === 'object' ? raw.por_agentes : {};
    for (const k of Object.keys(src)) {
        if (!AGENTES_RE.test(k)) return null;
        const b = src[k] || {};
        const fila = {
            n: numOrNull(b.n, 100000),
            mem_p50: numOrNull(b.mem_p50, 100),
            mem_p95: numOrNull(b.mem_p95, 100),
            mem_max: numOrNull(b.mem_max, 100),
            cpu_p50: numOrNull(b.cpu_p50, 100),
            cpu_max: numOrNull(b.cpu_max, 100),
        };
        if (Object.values(fila).some((v) => v === undefined) || !fila.n) return null;
        por[k] = fila;
    }
    const enCapSrc = raw.en_cap && typeof raw.en_cap === 'object' ? raw.en_cap : {};
    const out = {
        ts,
        n_muestras: n,
        muestras_cero_agentes: cero,
        por_agentes: por,
        elegibles_p50: numOrNull(raw.elegibles_p50),
        elegibles_max: numOrNull(raw.elegibles_max),
        elegibles_p50_cero: numOrNull(raw.elegibles_p50_cero),
        causa_moda: (typeof raw.causa_moda === 'string' && CAUSA_RE.test(raw.causa_moda)) ? raw.causa_moda : null,
        cap_efectivo: numOrNull(raw.cap_efectivo, 1000),
        nocturna: raw.nocturna === true,
        muestras_en_cap: numOrNull(raw.muestras_en_cap, 100000),
        en_cap: {
            n: numOrNull(enCapSrc.n, 100000),
            mem_p95: numOrNull(enCapSrc.mem_p95, 100),
            mem_max: numOrNull(enCapSrc.mem_max, 100),
        },
    };
    const escalares = [out.elegibles_p50, out.elegibles_max, out.elegibles_p50_cero, out.cap_efectivo,
        out.muestras_en_cap, out.en_cap.n, out.en_cap.mem_p95, out.en_cap.mem_max];
    if (escalares.some((v) => v === undefined)) return null;
    return out;
}

/**
 * @param {object} p
 * @param {string} [p.file]         path explícito (tests)
 * @param {string} [p.pipelineDir]  si no hay `file`, `<pipelineDir>/metrics-history-hourly.jsonl`
 * @param {number} p.from           epoch ms (inclusivo)
 * @param {number} p.to             epoch ms (inclusivo)
 * @param {object} [p.fsImpl]
 * @returns {{horas:Array, evaluable:boolean, reason?:string, descartadas:number}}
 */
function readHourly({ file, pipelineDir, from, to, fsImpl = fs } = {}) {
    const f = file || (pipelineDir ? path.join(pipelineDir, FILE_NAME) : null);
    const vacio = (reason) => ({ horas: [], evaluable: reason === undefined, reason, descartadas: 0 });
    if (!f) return vacio('sin_archivo');
    let size;
    try {
        if (!fsImpl.existsSync(f)) return vacio();
        size = fsImpl.statSync(f).size;
    } catch {
        return vacio('ilegible');
    }
    if (size > MAX_BYTES) return vacio('oversize');
    let texto;
    try { texto = String(fsImpl.readFileSync(f, 'utf8')); } catch { return vacio('ilegible'); }
    const lineas = texto.split(/\r?\n/).filter(Boolean).slice(-MAX_LINES);
    const porHora = new Map();
    let descartadas = 0;
    for (const l of lineas) {
        let raw;
        try { raw = JSON.parse(l); } catch { descartadas++; continue; }
        const h = proyectar(raw);
        if (!h) { descartadas++; continue; }
        if (h.ts < from || h.ts > to) continue;
        // Dos líneas de la misma hora (reinicio a mitad de hora): gana la de más muestras.
        const prev = porHora.get(h.ts);
        if (!prev || h.n_muestras > prev.n_muestras) porHora.set(h.ts, h);
    }
    const horas = [...porHora.values()].sort((a, b) => a.ts - b.ts);
    return { horas, evaluable: true, descartadas };
}

module.exports = { MAX_BYTES, proyectar, readHourly };

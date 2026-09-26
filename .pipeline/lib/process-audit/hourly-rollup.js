// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// =============================================================================
// process-audit / hourly-rollup — rollup horario de metrics-history (#6809 H1)
// =============================================================================
//
// `metrics-history.jsonl` guarda ~24 h (2880 snapshots de 30 s). Los ejes de
// capacidad y ociosidad del auditor necesitan semanas. En vez de abrir un store
// nuevo, se extiende el histórico existente con un archivo hermano:
//
//     .pipeline/metrics-history-hourly.jsonl   (una línea por hora UTC)
//
// Lo alimenta `persistMetricsSnapshot` del Pulpo (D4): después de persistir el
// snapshot llama a `accumulate(snapshot, hechos, { file })` dentro de su PROPIO
// try/catch. Contrato (SEC-6809-8):
//
//   - O(1) por muestra: acumulador en memoria con reservorios de ≤120 valores
//     por bucket (a 30 s por ciclo, una hora son 120 muestras).
//   - Una sola escritura por hora: cuando cambia la hora UTC, `flush` hace UN
//     `appendFileSync` de una línea con la hora cerrada.
//   - Tope de 90 días (2160 líneas). La rotación corre como máximo una vez por
//     hora (sólo después de un flush) y reescribe vía tmp + rename.
//   - NUNCA lanza: cualquier error interno se traga y se cuenta.
//
// Forma de la línea (todo numérico o enum validado; nada de texto libre):
//
//   { schema, ts_hora, n_muestras, muestras_cero_agentes, min_cero_agentes,
//     por_agentes: { "<k>": { n, mem_p50, mem_p95, mem_max, cpu_p50, cpu_max } },
//     elegibles_p50, elegibles_max, elegibles_p50_cero, muestras_elegibles,
//     causa_moda, cap_efectivo, nocturna, muestras_en_cap,
//     en_cap: { n, mem_p95, mem_max } }
//
// Un reinicio del Pulpo pierde la hora en curso (el acumulador vive en memoria):
// es aceptable, la hora siguiente arranca limpia y el lector descarta horas con
// pocas muestras (`min_samples_hora`).

const fs = require('fs');
const path = require('path');

const SCHEMA = 1;
const FILE_NAME = 'metrics-history-hourly.jsonl';
const MAX_LINES = 2160; // 90 días
const RESERVOIR = 120;
const MAX_AGENTES_BUCKET = 32;
const HOUR_MS = 3600 * 1000;
const CAUSA_RE = /^[a-z0-9_-]{1,40}$/;

let acc = null;
let errores = 0;

function horaDe(ts) {
    return Math.floor(ts / HOUR_MS) * HOUR_MS;
}

function num(v) {
    return (typeof v === 'number' && Number.isFinite(v)) ? v : null;
}

function pct(v) {
    const n = num(v);
    if (n === null || n < 0 || n > 100) return null;
    return n;
}

function entero(v, max) {
    const n = num(v);
    if (n === null || n < 0) return null;
    return Math.min(Math.floor(n), max);
}

function nuevoReservorio() {
    return { n: 0, vals: [] };
}

function empujar(res, v) {
    if (v === null) return;
    if (res.vals.length < RESERVOIR) res.vals.push(v);
    else res.vals[res.n % RESERVOIR] = v; // reemplazo circular: acotado y determinístico
    res.n++;
}

function percentil(vals, p) {
    if (!vals.length) return null;
    const s = vals.slice().sort((a, b) => a - b);
    const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
    return s[idx];
}

function maximo(vals) {
    return vals.length ? Math.max(...vals) : null;
}

function nuevaHora(hora) {
    return {
        hora,
        n: 0,
        cero: 0,
        buckets: {},
        elegibles: nuevoReservorio(),
        elegiblesCero: nuevoReservorio(),
        elegiblesMax: null,
        causas: {},
        caps: {},
        nocturnas: 0,
        enCap: 0,
        memEnCap: nuevoReservorio(),
    };
}

function moda(conteos) {
    let mejor = null;
    let max = -1;
    for (const k of Object.keys(conteos).sort()) {
        if (conteos[k] > max) { max = conteos[k]; mejor = k; }
    }
    return mejor;
}

/** Normaliza la causa declarada del no-despacho a un token cerrado. */
function causaDe(hechos) {
    if (!hechos || typeof hechos !== 'object') return 'desconocida';
    const c = hechos.cause;
    if (c === null) return 'ninguna';
    if (!c || typeof c !== 'object') return 'desconocida';
    return (typeof c.kind === 'string' && CAUSA_RE.test(c.kind)) ? c.kind : 'desconocida';
}

/**
 * Construye la línea de una hora cerrada. Pura.
 * @returns {object|null} `null` si la hora no tiene muestras.
 */
function construirLinea(h) {
    if (!h || h.n === 0) return null;
    const por = {};
    for (const k of Object.keys(h.buckets).sort((a, b) => Number(a) - Number(b))) {
        const b = h.buckets[k];
        por[k] = {
            n: b.n,
            mem_p50: percentil(b.mem.vals, 50),
            mem_p95: percentil(b.mem.vals, 95),
            mem_max: maximo(b.mem.vals),
            cpu_p50: percentil(b.cpu.vals, 50),
            cpu_max: maximo(b.cpu.vals),
        };
    }
    return {
        schema: SCHEMA,
        ts_hora: new Date(h.hora).toISOString(),
        n_muestras: h.n,
        muestras_cero_agentes: h.cero,
        min_cero_agentes: Math.round((60 * h.cero) / h.n),
        por_agentes: por,
        elegibles_p50: percentil(h.elegibles.vals, 50),
        elegibles_max: h.elegiblesMax,
        elegibles_p50_cero: percentil(h.elegiblesCero.vals, 50),
        muestras_elegibles: h.elegibles.n,
        causa_moda: moda(h.causas),
        cap_efectivo: (() => { const m = moda(h.caps); return m === null ? null : Number(m); })(),
        nocturna: h.nocturnas * 2 > h.n,
        muestras_en_cap: h.enCap,
        en_cap: {
            n: h.memEnCap.n,
            mem_p95: percentil(h.memEnCap.vals, 95),
            mem_max: maximo(h.memEnCap.vals),
        },
    };
}

/**
 * Agrega una muestra a la hora en curso. Si la muestra cae en otra hora, cierra
 * (flush) la anterior primero. Nunca lanza.
 *
 * @param {object} snapshot  el snapshot de `persistMetricsSnapshot` ({ts, cpu, mem, agents})
 * @param {object} [extra]   { hechos, cap, devs, nocturna } — hechos de `dispatch-facts`
 * @param {object} opts      { file, fsImpl }
 * @returns {{ok:boolean, flushed:boolean}}
 */
function accumulate(snapshot, extra, opts) {
    try {
        const o = opts || {};
        const s = snapshot || {};
        const ts = num(s.ts);
        if (ts === null) return { ok: false, flushed: false };
        const hora = horaDe(ts);
        let flushed = false;
        if (acc && acc.hora !== hora) {
            flushed = flush(o);
        }
        if (!acc || acc.hora !== hora) acc = nuevaHora(hora);

        const agentes = entero(s.agents, MAX_AGENTES_BUCKET);
        const mem = pct(s.mem);
        const cpu = pct(s.cpu);
        acc.n++;
        if (agentes !== null) {
            const k = String(agentes);
            const b = acc.buckets[k] || (acc.buckets[k] = { n: 0, mem: nuevoReservorio(), cpu: nuevoReservorio() });
            b.n++;
            empujar(b.mem, mem);
            empujar(b.cpu, cpu);
            if (agentes === 0) acc.cero++;
        }

        const e = extra || {};
        const hechos = e.hechos;
        const elegibles = hechos && hechos.conteo ? entero(hechos.conteo.elegibles, 100000) : null;
        if (elegibles !== null) {
            empujar(acc.elegibles, elegibles);
            if (agentes === 0) empujar(acc.elegiblesCero, elegibles);
            acc.elegiblesMax = acc.elegiblesMax === null ? elegibles : Math.max(acc.elegiblesMax, elegibles);
        }
        if (agentes === 0 && hechos !== undefined) {
            const c = causaDe(hechos);
            acc.causas[c] = (acc.causas[c] || 0) + 1;
        }
        const cap = entero(e.cap, 1000);
        const devs = entero(e.devs, 1000);
        if (cap !== null) {
            acc.caps[String(cap)] = (acc.caps[String(cap)] || 0) + 1;
            if (devs !== null && cap > 0 && devs >= cap) {
                acc.enCap++;
                empujar(acc.memEnCap, mem);
            }
        }
        if (e.nocturna === true) acc.nocturnas++;
        return { ok: true, flushed };
    } catch {
        errores++;
        return { ok: false, flushed: false };
    }
}

/**
 * Escribe la hora acumulada (una línea) y rota si hace falta. Nunca lanza.
 * @returns {boolean} true si escribió.
 */
function flush(opts) {
    const o = opts || {};
    const fsImpl = o.fsImpl || fs;
    const h = acc;
    acc = null;
    try {
        const linea = construirLinea(h);
        if (!linea || typeof o.file !== 'string' || !o.file) return false;
        const dir = path.dirname(o.file);
        if (!fsImpl.existsSync(dir)) return false; // nunca crea el árbol del pipeline
        fsImpl.appendFileSync(o.file, JSON.stringify(linea) + '\n');
        rotar(o.file, fsImpl, o.maxLines);
        return true;
    } catch {
        errores++;
        return false;
    }
}

/** Recorta a las últimas `maxLines` líneas vía tmp + rename. Nunca lanza. */
function rotar(file, fsImpl, maxLines) {
    const tope = (Number.isInteger(maxLines) && maxLines > 0) ? maxLines : MAX_LINES;
    try {
        const lines = String(fsImpl.readFileSync(file, 'utf8')).split('\n').filter(Boolean);
        if (lines.length <= tope) return false;
        const tmp = `${file}.tmp.${process.pid}`;
        fsImpl.writeFileSync(tmp, lines.slice(-tope).join('\n') + '\n');
        fsImpl.renameSync(tmp, file);
        return true;
    } catch {
        errores++;
        return false;
    }
}

/** Sólo tests: estado del acumulador y reset. */
function _estado() {
    return { acc: acc ? construirLinea(acc) : null, errores };
}
function _reset() {
    acc = null;
    errores = 0;
}

module.exports = {
    SCHEMA,
    FILE_NAME,
    MAX_LINES,
    RESERVOIR,
    accumulate,
    flush,
    rotar,
    construirLinea,
    causaDe,
    percentil,
    _estado,
    _reset,
};

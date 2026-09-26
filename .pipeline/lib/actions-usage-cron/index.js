// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// =============================================================================
// actions-usage-cron / index — orquestador de la semana (#7689, parte 3/4 de #7661)
// =============================================================================
//
//   evidencias (baseline + pricing) → runner.spawnMeasure → report.buildWeek
//   → appendSeries(state/actions-usage-series.json) → publish (opcional, parte 4)
//
// - Si falla cualquier paso previo al append, la serie queda intacta (CA-16).
// - La serie guarda SÓLO agregados (CA-15): semana, minutos, costo estimado y
//   veredicto del plan objetivo. Nunca stderr, rutas, logins ni filas.
// - Tope de 104 entradas; al superarlo se descartan las más viejas (CA-18).
// - `generated_at` lo pone este módulo: `report.js` es puro.
// - `publish` es una dependencia inyectable (la implementa #7690). Si lanza, se
//   loguea y la serie ya escrita no se revierte (CA-19).
// - `done(result)` va SIEMPRE en el `finally`: libera el `inFlight` del cron.
// - No se indexan objetos planos por nombre de workflow (CA-17): el mapeo es un
//   `Map` (`mapping.buildMapping`) y `report.buildWeek` trabaja con `Map` y
//   objetos sin prototipo.

const fs = require('fs');
const cron = require('./cron');

const SERIES_FILE = 'actions-usage-series.json';
const SERIES_MAX = 104;
const EVIDENCE_MAX_BYTES = 5 * 1024 * 1024;
const ENTRY_KEYS = Object.freeze([
    'week_start', 'week_end', 'generated_at', 'dias', 'parcial', 'minutes', 'total_min_mes',
    'plan_objetivo', 'excedente_min_mes', 'veredicto', 'cost_usd_estimado',
]);

/** SIEMPRE vía `write-target`; nunca `__dirname` ni `pipelineDir`. */
function defaultSeriesFile() {
    return require('../write-target').writePath(process.env, { canal: 'estado', destino: 'state/actions-usage-series.json' }, 'state', SERIES_FILE);
}

function isObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function finiteOrNull(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function round2(v) {
    return v === null ? null : Math.round(v * 100) / 100;
}

/** Lee un JSON de evidencia ya validado por `resolveEvidencePath`, con tope de tamaño. */
function readEvidence(file, fsImpl = fs) {
    const st = fsImpl.statSync(file);
    if (!st.isFile() || st.size > EVIDENCE_MAX_BYTES) throw new Error('evidencia fuera de tope');
    const parsed = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    if (!isObject(parsed)) throw new Error('evidencia no es un objeto');
    return parsed;
}

/** Serie actual; si falta o es inválida, `[]`. */
function readSeries(file, fsImpl = fs) {
    try {
        if (typeof fsImpl.existsSync === 'function' && !fsImpl.existsSync(file)) return [];
        const parsed = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
        return Array.isArray(parsed) ? parsed.filter(isObject) : [];
    } catch {
        return [];
    }
}

/**
 * Entrada de la serie: sólo agregados, claves fijas (ENTRY_KEYS).
 * `cost_usd_estimado` es el costo mensual estimado del excedente sobre el plan
 * objetivo, a tarifa linux (los `billable_min` ya vienen normalizados por el
 * multiplicador del runner).
 */
function buildEntry(summary, week, pricing, section, now) {
    const win = isObject(summary.window) ? summary.window : {};
    const plan = section.target_plan;
    const proy = isObject(week.proyeccion) && Object.hasOwn(week.proyeccion, plan) && isObject(week.proyeccion[plan])
        ? week.proyeccion[plan] : {};
    const excedente = finiteOrNull(proy.excedente_min);
    const perMin = isObject(pricing.per_minute_usd) ? finiteOrNull(pricing.per_minute_usd.linux) : null;
    const veredicto = typeof proy.veredicto === 'string' && /^[a-z_]{1,20}$/.test(proy.veredicto) ? proy.veredicto : 'sin_dato';
    return {
        week_start: cron.isValidIsoDate(win.from) ? win.from : null,
        week_end: cron.isValidIsoDate(win.to) ? win.to : null,
        generated_at: new Date(now).toISOString(),
        dias: finiteOrNull(week.dias),
        parcial: typeof week.parcial === 'boolean' ? week.parcial : null,
        minutes: isObject(summary.totals) ? finiteOrNull(summary.totals.billable_min) : null,
        total_min_mes: round2(finiteOrNull(week.total_min_mes)),
        plan_objetivo: plan,
        excedente_min_mes: round2(excedente),
        veredicto,
        cost_usd_estimado: excedente !== null && perMin !== null ? round2(excedente * perMin) : null,
    };
}

/** Agrega `entry`, recorta a las últimas SERIES_MAX y escribe atómico (0o600). */
function appendSeries(file, entry, fsImpl = fs) {
    const series = readSeries(file, fsImpl);
    series.push(entry);
    const trimmed = series.length > SERIES_MAX ? series.slice(series.length - SERIES_MAX) : series;
    cron.writeStateAtomic(file, trimmed, fsImpl);
    return trimmed;
}

/**
 * Corre una semana completa. Nunca rechaza: cualquier falla termina en un
 * `result` con `kind` distinto de `ok` y la serie intacta.
 *
 * @param {object} section           sección de `cron.resolveSection`
 * @param {{done?:Function, repoRoot?:string}} handle
 * @param {object} [deps]            inyección para tests
 * @returns {Promise<{kind:string, appended:boolean, entry?:object, publicado?:boolean}>}
 */
async function runWeek(section, handle = {}, deps = {}) {
    const done = typeof handle.done === 'function' ? handle.done : () => {};
    const repoRoot = handle.repoRoot || deps.repoRoot;
    const fsImpl = deps.fsImpl || fs;
    const logger = deps.logger || (() => {});
    const now = typeof deps.now === 'function' ? deps.now : Date.now;
    let result = { kind: 'error', appended: false };
    try {
        let baseline;
        let pricing;
        try {
            baseline = readEvidence(section.baselinePath, fsImpl);
            pricing = readEvidence(section.pricingPath, fsImpl);
        } catch {
            result = { kind: 'evidencia_invalida', appended: false };
            return result;
        }

        const spawnMeasure = deps.spawnMeasure || require('./runner').spawnMeasure;
        const measured = await spawnMeasure({ section, repoRoot, pricingObj: pricing, logger, ...(deps.runnerDeps || {}) });
        const kind = measured && typeof measured.kind === 'string' ? measured.kind : 'api';
        if (kind !== 'ok' || !isObject(measured.summary)) {
            result = { kind: kind === 'ok' ? 'summary_invalido' : kind, appended: false };
            return result;
        }
        const summary = measured.summary;

        const report = deps.report || require('./report');
        const mapping = (deps.mapping || require('./mapping')).buildMapping(pricing, section.workflow_map);
        const file = deps.seriesFile || defaultSeriesFile();
        const prev = readSeries(file, fsImpl);
        const prevWeek = prev.length ? prev[prev.length - 1] : null;
        const week = report.buildWeek(summary, baseline, mapping, pricing, prevWeek);
        const entry = buildEntry(summary, week, pricing, section, now());
        const series = appendSeries(file, entry, fsImpl);
        result = { kind: 'ok', appended: true, entry };

        if (typeof deps.publish === 'function') {
            try {
                const suficiente = typeof report.evaluarSuficiente === 'function'
                    ? report.evaluarSuficiente(series, { olaCerrada: section.ola_cerrada === true }) : null;
                await deps.publish({ week, entry, series, section, suficiente });
                result.publicado = true;
            } catch (e) {
                logger(`publicación falló (${(e && e.code) || 'error'}); la serie quedó guardada`);
                result.publicado = false;
            }
        }
        return result;
    } catch (e) {
        logger(`orquestación falló antes de guardar (${(e && e.code) || 'error'})`);
        result = { kind: 'error', appended: false };
        return result;
    } finally {
        done(result);
    }
}

/** Frase legible para el log del brazo (pautas de UX). */
function describeResult(r) {
    const res = r || {};
    switch (res.kind) {
        case 'ok': {
            const e = res.entry || {};
            const min = e.total_min_mes === null || e.total_min_mes === undefined ? 's/d' : Math.round(e.total_min_mes).toLocaleString('es-AR');
            const usd = e.cost_usd_estimado === null || e.cost_usd_estimado === undefined ? 's/d' : e.cost_usd_estimado.toFixed(2).replace('.', ',');
            return `semana agregada a la serie — ${min} min/mes proyectados, costo estimado USD ${usd} (plan ${e.plan_objetivo || 's/d'})`;
        }
        case 'timeout': return 'medición cortada por tiempo — la serie no cambió';
        case 'rate_limit': return 'GitHub limitó las consultas, se reintenta en el próximo ciclo — la serie no cambió';
        case 'api': return 'error consultando la API de GitHub — la serie no cambió';
        case 'config': return 'el medidor rechazó los argumentos (revisar config) — la serie no cambió';
        case 'summary_invalido': return 'el resumen de la medición vino vacío o inválido — la serie no cambió';
        case 'evidencia_invalida': return 'no se pudieron leer baseline/pricing — la serie no cambió';
        case 'tmp_no_disponible': return 'no se pudo crear el directorio temporal — la serie no cambió';
        default: return 'la medición falló — la serie no cambió';
    }
}

module.exports = {
    SERIES_FILE,
    SERIES_MAX,
    EVIDENCE_MAX_BYTES,
    ENTRY_KEYS,
    defaultSeriesFile,
    readEvidence,
    readSeries,
    buildEntry,
    appendSeries,
    runWeek,
    describeResult,
};

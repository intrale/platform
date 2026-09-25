// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// =============================================================================
// process-audit / axis-process — eje proceso (#6809 H2)
// =============================================================================
//
// Cinco detectores determinísticos sobre los insumos ya proyectados por
// `read-verdicts` / `read-control-age`. PURO: no lee ni escribe nada.
//
//   1. Paso invariante — un `(skill, fase)` evaluativo con ≥20 veredictos en la
//      ventana y todos iguales. Si el skill corre con un LLM según
//      `agent-models.json` ⇒ "paso determinizable"; si ya es determinístico ⇒
//      "paso que sobra".
//   2. Repetición automatizable — una firma de fallo
//      `sha256(skill|fase|death_kind|exit_code)[:12]` con ≥5 ocurrencias en ≥3
//      días UTC distintos. `spawn-exit` no registra la fase: va `-` en la firma.
//   3. Fase que concentra el costo — una fase evaluativa con ≥30 % de los tokens
//      de la ventana cuyo veredicto casi no varía (<10 % de minoría).
//   4. Control apagado — un control de la allowlist con `enabled: false` hace
//      ≥14 días.
//   5. Rebotes / reintentos por fase — no generan propuesta propia: viajan como
//      evidencia de soporte en el detalle y en la propuesta de costo.
//
// Cada hallazgo lleva su métrica (valor + ventana) y su fuente; todos salen con
// `tipo: mejora-de-proceso` (no suben costo ni riesgo).

const crypto = require('crypto');

const MIN_CORRIDAS_INVARIANTE = 20;
const MIN_OCURRENCIAS_FALLO = 5;
const MIN_DIAS_FALLO = 3;
const MIN_PCT_COSTO = 30;
const MAX_VARIACION_PCT = 10;
const MIN_CORRIDAS_COSTO = 20;
const MIN_DIAS_CONTROL = 14;

/** Fases cuyo resultado es un veredicto (gate); las que producen código/APK quedan fuera. */
const FASES_EVALUATIVAS = Object.freeze(['analisis', 'criterios', 'sizing', 'validacion', 'linteo', 'verificacion', 'aprobacion']);
/** Gates cuya rareza de rechazo es justamente su valor: nunca se proponen como prescindibles. */
const SKILLS_NO_PRESCINDIBLES = Object.freeze(['security']);

function r1(v) { return Math.round(v * 10) / 10; }

function diaUtc(ts) { return new Date(ts).toISOString().slice(0, 10); }

/** ¿El skill corre con un LLM? `deterministic` (o desconocido sin default) ⇒ no. */
function usaLlm(agentModels, skill) {
    const am = agentModels && typeof agentModels === 'object' ? agentModels : {};
    const s = am.skills && typeof am.skills === 'object' ? am.skills[skill] : undefined;
    const prov = s && typeof s.provider === 'string' ? s.provider : am.default_provider;
    if (typeof prov !== 'string' || !prov) return null;
    return prov !== 'deterministic';
}

/** Firma normalizada de un fallo (SEC-6809-3: nunca el mensaje). */
function firmaFallo(skill, fase, deathKind, exitCode) {
    return crypto.createHash('sha256')
        .update(`${skill}|${fase || '-'}|${deathKind}|${exitCode === null || exitCode === undefined ? '-' : exitCode}`)
        .digest('hex')
        .slice(0, 12);
}

/** Veredictos por (skill, fase): corridas, rechazos, aprobados. */
function veredictosPorPaso({ verdicts, rebounds, costRuns }) {
    const pasos = {};
    const celda = (skill, fase) => {
        const k = `${skill}|${fase}`;
        return pasos[k] || (pasos[k] = { skill, fase, yaml: 0, yamlRech: 0, rebotes: 0, corridas: 0 });
    };
    for (const v of verdicts || []) {
        const c = celda(v.skill, v.fase);
        c.yaml++;
        if (v.resultado === 'rechazado') c.yamlRech++;
    }
    for (const r of rebounds || []) {
        for (const ev of r.evaluadores || []) celda(ev, r.fase).rebotes++;
    }
    for (const run of costRuns || []) {
        if (run.resultado === 'ganada') celda(run.skill, run.fase).corridas++;
    }
    for (const c of Object.values(pasos)) {
        c.total = Math.max(c.corridas, c.yaml);
        c.rechazos = Math.min(c.total, Math.max(c.yamlRech, c.rebotes));
        c.aprobados = c.total - c.rechazos;
    }
    return pasos;
}

/**
 * @param {object} p
 * @param {Array} p.verdicts   `readProcesadoVerdicts().rows`
 * @param {Array} p.rebounds   `readRebounds().rows`
 * @param {Array} p.costRuns   `readCostRuns().rows`
 * @param {Array} p.failures   `readFailures().rows`
 * @param {Array} p.controls   `readControlAges()`
 * @param {object} p.agentModels
 * @param {string} p.ventana
 * @returns {{veredicto:string, hallazgos:Array, detalle:object}}
 */
function evaluarProceso({ verdicts, rebounds, costRuns, failures, controls, agentModels, ventana } = {}) {
    const hallazgos = [];
    const detalle = {};

    // ── 1. Paso invariante ─────────────────────────────────────────────────
    const pasos = veredictosPorPaso({ verdicts, rebounds, costRuns });
    for (const c of Object.values(pasos).sort((a, b) => (a.skill + a.fase).localeCompare(b.skill + b.fase))) {
        if (!FASES_EVALUATIVAS.includes(c.fase) || SKILLS_NO_PRESCINDIBLES.includes(c.skill)) continue;
        if (c.total < MIN_CORRIDAS_INVARIANTE) continue;
        if (c.rechazos !== 0 && c.aprobados !== 0) continue;
        const llm = usaLlm(agentModels, c.skill);
        if (llm === null) continue; // sin dato de proveedor no se afirma nada
        hallazgos.push({
            eje: 'proceso',
            clave: llm ? 'paso_determinizable' : 'paso_sobra',
            veredicto: 'sugerir',
            fuente: 'rebound-events+procesado',
            sube_costo_o_riesgo: false,
            metrica: { nombre: 'corridas_mismo_resultado', valor: c.total, unidad: 'corridas', ventana },
            params: { skill: c.skill, fase: c.fase, resultado: c.rechazos === 0 ? 'aprobado' : 'rechazado' },
        });
    }

    // ── 2. Repetición automatizable ────────────────────────────────────────
    const firmas = {};
    for (const f of failures || []) {
        const firma = firmaFallo(f.skill, null, f.death_kind, f.exit_code);
        const g = firmas[firma] || (firmas[firma] = { firma, skill: f.skill, death_kind: f.death_kind, exit_code: f.exit_code, n: 0, dias: new Set() });
        g.n++;
        if (Number.isFinite(f.ts)) g.dias.add(diaUtc(f.ts));
    }
    for (const g of Object.values(firmas).sort((a, b) => a.firma.localeCompare(b.firma))) {
        if (g.n < MIN_OCURRENCIAS_FALLO || g.dias.size < MIN_DIAS_FALLO) continue;
        hallazgos.push({
            eje: 'proceso',
            clave: 'fallo_recurrente',
            veredicto: 'sugerir',
            fuente: 'spawn-exit',
            sube_costo_o_riesgo: false,
            metrica: { nombre: 'ocurrencias_fallo', valor: g.n, unidad: 'ocurrencias', ventana },
            params: { skill: g.skill, death_kind: g.death_kind, exit_code: g.exit_code, firma: g.firma, dias: g.dias.size },
        });
    }

    // ── 3/5. Costo por fase + rebotes / reintentos como soporte ────────────
    const porFase = {};
    let totalTokens = 0;
    for (const run of costRuns || []) {
        const f = porFase[run.fase] || (porFase[run.fase] = { tokens: 0, corridas: 0, reintentos: 0 });
        f.tokens += run.tokens;
        f.corridas++;
        if (run.resultado === 'error' || run.resultado === 'abortada') f.reintentos++;
        totalTokens += run.tokens;
    }
    const rebotesPorFase = {};
    for (const r of rebounds || []) rebotesPorFase[r.fase] = (rebotesPorFase[r.fase] || 0) + 1;
    detalle.rebotes_por_fase = rebotesPorFase;
    detalle.reintentos_por_fase = Object.fromEntries(Object.entries(porFase).map(([k, v]) => [k, v.reintentos]));
    detalle.tokens_ventana = totalTokens;
    if (totalTokens > 0) {
        for (const fase of Object.keys(porFase).sort()) {
            if (!FASES_EVALUATIVAS.includes(fase)) continue;
            const f = porFase[fase];
            const pct = (f.tokens / totalTokens) * 100;
            if (pct < MIN_PCT_COSTO) continue;
            const deFase = Object.values(pasos).filter((c) => c.fase === fase);
            const total = deFase.reduce((s, c) => s + c.total, 0);
            const minoria = deFase.reduce((s, c) => s + Math.min(c.aprobados, c.rechazos), 0);
            if (total < MIN_CORRIDAS_COSTO) continue;
            const variacion = (minoria / total) * 100;
            if (variacion >= MAX_VARIACION_PCT) continue;
            hallazgos.push({
                eje: 'proceso',
                clave: 'fase_costosa',
                veredicto: 'sugerir',
                fuente: 'provider-cost',
                sube_costo_o_riesgo: false,
                metrica: { nombre: 'pct_costo_fase', valor: r1(pct), unidad: '%', ventana },
                params: { fase, variacion: r1(variacion), corridas: total, rebotes: rebotesPorFase[fase] || 0, reintentos: f.reintentos },
            });
        }
    }

    // ── 4. Control apagado ─────────────────────────────────────────────────
    for (const c of controls || []) {
        if (c.estado !== 'apagado' || !(c.dias >= MIN_DIAS_CONTROL)) continue;
        hallazgos.push({
            eje: 'proceso',
            clave: 'control_apagado',
            veredicto: 'sugerir',
            fuente: 'git-log-config',
            sube_costo_o_riesgo: false,
            metrica: { nombre: 'dias_control_apagado', valor: c.dias, unidad: 'dias', ventana: `desde ${c.desde}` },
            params: { control: c.control },
        });
    }
    detalle.controles = (controls || []).map((c) => ({ control: c.control, estado: c.estado, dias: c.dias }));

    return { veredicto: hallazgos.length ? 'sugerir' : 'mantener', hallazgos, detalle };
}

module.exports = {
    FASES_EVALUATIVAS,
    SKILLS_NO_PRESCINDIBLES,
    MIN_CORRIDAS_INVARIANTE,
    MIN_OCURRENCIAS_FALLO,
    MIN_DIAS_FALLO,
    MIN_PCT_COSTO,
    MAX_VARIACION_PCT,
    MIN_DIAS_CONTROL,
    usaLlm,
    firmaFallo,
    veredictosPorPaso,
    evaluarProceso,
};

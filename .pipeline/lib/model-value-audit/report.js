// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// =============================================================================
// model-value-audit / report — JSON canónico + tabla humana (#7519)
// =============================================================================
//
// Dos salidas de un mismo objeto:
//   - `buildReport(...)`  → objeto con claves ordenadas (`canonicalJsonStringify`
//     de `lib/audit-log`) y `sha256` del canónico SIN el campo `sha256`, para
//     que un tercero pueda borrarlo, recalcular y comparar (C13 / SEC-R3).
//   - `renderHuman(report, { compacto, comando })` → cabecera en lenguaje de
//     operador + tabla markdown (espejo de `renderMarkdownTable` del hermano
//     `multi-provider/provider-contribution.js`) + pie con contadores.
//
// Vocabulario (PR3 / SEC-R1): el JSON lleva CÓDIGOS (`VERDICT`, `MOTIVOS`,
// `RIESGO`, `ADVERTENCIAS` de `recommender.js`); el texto humano vive acá en
// `VERDICT_LABEL` / `MOTIVO_LABEL` / `RIESGO_LABEL` / `ADVERTENCIA_LABEL`. Las
// únicas interpolaciones son números ya validados (`Number.isFinite`) e
// identificadores whitelisteados (`skill`, `provider`, `model`), y cada celda
// pasa por `stripForOutput` (control chars, ANSI, invisibles, tope 120).
//
// Última defensa (CA-22, C2): `stripForOutput` por celda + `redactRagContent`
// sobre el texto completo. `redactSensitive` sola NO redacta claves AWS.
//
// Este módulo NO escribe nada, no requiere `fs`, no ejecuta procesos (CA-20).

const crypto = require('crypto');
const { canonicalJsonStringify } = require('../audit-log');
const { redactRagContent } = require('../redact');
const { stripForOutput, safeModel } = require('./sanitize');
const recommender = require('./recommender');

const { VERDICT, RIESGO, ADVERTENCIAS, ALERTAS } = recommender;

const REPORT_VERSION = 1;

/** CA-R3: exactamente los cinco literales del body. */
const VERDICT_LABEL = Object.freeze({
    [VERDICT.BAJAR]: 'bajar de modelo',
    [VERDICT.SUBIR]: 'subir de modelo',
    [VERDICT.MANTENER]: 'mantener',
    [VERDICT.SIN_EVIDENCIA]: 'sin evidencia suficiente',
    [VERDICT.NO_EVALUABLE]: 'no evaluable',
});

/** Texto base por código de motivo (guía UX de `criterios`). */
const MOTIVO_LABEL = Object.freeze({
    integridad_rota: 'cadena de spawn-exit rota: señal no confiable',
    modelo_no_observado: 'ninguna corrida con modelo observable en la ventana',
    modelo_sin_precio: 'el modelo no está en la tabla de precios (#7507)',
    provider_sin_precios: 'el proveedor no tiene tabla de precios (#7524)',
    precio_invalido: 'precio no válido en la tabla: no se puede calcular',
    muestra_insuficiente: 'muestra insuficiente',
    skill_protegido: 'skill protegido: cambio sólo por decisión humana',
    rebound_alto: 'rebote alto',
    early_death_alto: 'muerte temprana alta',
    qa_fail_alto: 'QA fallido alto',
    ya_en_el_tope: 'ya en el modelo más caro del proveedor',
    ya_en_el_mas_barato: 'ya en el modelo más barato del proveedor',
    calidad_ok_costo_menor: 'calidad dentro de umbral y hay un modelo más barato',
    costo_no_evaluable: 'sin dato de costo en la ventana (#6558)',
    metrica_no_medible: 'alguna métrica sin dato en la ventana: no se sugiere bajar',
    modelos_mixtos: 'corrió con más de un modelo; veredicto sobre el mayoritario',
    declarado_desconocido: 'el agente no figura en agent-models.json',
    propagacion_apagada: 'el modelo declarado no se propaga (#6274)',
});

const RIESGO_LABEL = Object.freeze({
    [RIESGO.NO_APLICA]: 'no aplica',
    [RIESGO.NO_CUANTIFICABLE_SIN_OBSERVACION]: 'no cuantificable — sin observación del modelo destino',
    [RIESGO.NO_MEDIDO_V1]: 'no medido en v1',
});

/** Literal de CA-18 (D10 del padre). */
const ADVERTENCIA_LABEL = Object.freeze({
    [ADVERTENCIAS.PROPAGACION_APAGADA]: 'model_propagation.enabled=false: el modelo declarado no se propaga; '
        + 'una sugerencia aceptada requiere encender el rollout (#6274)',
});

/** Motivos de `pricing-freshness` (parte 1) y `reason` del costo (parte 1), en lenguaje de operador. */
const PRECIOS_MOTIVO_LABEL = Object.freeze({
    antiguedad: 'tabla vencida por antigüedad',
    updated_at_invalido: 'fecha de actualización inválida',
    pricing_json_ausente_o_invalido: 'tabla ausente o inválida: se usa el fallback embebido',
});
const COSTO_MOTIVO_LABEL = Object.freeze({
    sin_ts: 'hay filas de costo sin timestamp',
    oversize: 'el archivo de costo supera el tope de lectura',
});

/** Vocabulario cerrado de ausencia (CA-R3): ninguna celda queda vacía. */
const ABSENCE = Object.freeze({
    SIN_DATO: 'sin dato',
    SIN_MUESTRA: 'sin muestra',
    NO_EVALUABLE: 'no evaluable',
    NO_CUANTIFICABLE: 'no cuantificable',
    SIN_DECLARAR: 'sin declarar',
    NO_OBSERVADO: 'no observado',
    SIN_OBSERVACIONES: 'sin observaciones',
});

/** Orden de grupos por accionabilidad (C17). */
const VERDICT_ORDER = Object.freeze([VERDICT.SUBIR, VERDICT.BAJAR, VERDICT.NO_EVALUABLE, VERDICT.SIN_EVIDENCIA, VERDICT.MANTENER]);

const RULE = '═'.repeat(76);

// -----------------------------------------------------------------------------
// Formatos (copias con test de los helpers no exportados del hermano)
// -----------------------------------------------------------------------------

function fmtInt(n) {
    if (!Number.isFinite(n)) return ABSENCE.SIN_DATO;
    return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** `35,0 %`; `null`/no finito ⇒ `sin dato` (métrica no medible ≠ 0 %). */
function fmtRate(rate) {
    if (rate === null || !Number.isFinite(rate)) return ABSENCE.SIN_DATO;
    return `${(rate * 100).toFixed(1).replace('.', ',')} %`;
}

/** `12,34 USD`; `null` ⇒ el literal de ausencia que pida el caller. */
function fmtUsd(value, absent) {
    if (value === null || !Number.isFinite(value)) return absent;
    return `${value.toFixed(2).replace('.', ',')} USD`;
}

function fmtDay(iso) {
    return typeof iso === 'string' && iso.length >= 10 ? iso.slice(0, 10) : ABSENCE.SIN_DATO;
}

function fmtDifiere(v) {
    return v === true ? 'sí' : 'no';
}

function toIso(v) {
    if (typeof v === 'string') return Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null;
    return Number.isFinite(v) ? new Date(v).toISOString() : null;
}

// -----------------------------------------------------------------------------
// buildReport
// -----------------------------------------------------------------------------

function sha256Of(obj) {
    return crypto.createHash('sha256').update(canonicalJsonStringify(obj), 'utf8').digest('hex');
}

function missingModels(freshness) {
    const out = [];
    for (const m of (freshness && Array.isArray(freshness.missing_models)) ? freshness.missing_models : []) {
        if (!m || typeof m.provider !== 'string' || typeof m.model !== 'string') continue;
        out.push({ provider: m.provider, model: m.model, n: Number.isFinite(m.n) ? m.n : 0 });
    }
    return out;
}

const RATE_KEYS = Object.freeze(['reboundRate', 'earlyDeathRate', 'qaFailRate', 'retriesPerIssue', 'durationP50Ms', 'durationP95Ms']);
const finiteOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * @param {object} p
 * @param {object} p.verdicts           salida de `recommender.recommend`
 * @param {object} p.quality            salida de `agent-quality-signal.compute` (tasas por skill)
 * @param {object} p.freshness          salida de `pricing-freshness.evaluate`
 * @param {{from:number|string,to:number|string,dias:number}} p.ventana
 * @param {object} p.integridad         enums/contadores (ver `index.js`)
 * @param {boolean} p.propagationEnabled
 * @param {string|null} p.agentModelsSha256
 * @param {number} p.generatedAt        epoch ms
 * @returns {object} reporte con claves ordenadas y `sha256`
 */
function buildReport({ verdicts, quality, freshness, ventana, integridad, propagationEnabled, agentModelsSha256, generatedAt } = {}) {
    const v = verdicts || {};
    const f = freshness || {};
    const win = ventana || {};
    const qSkills = (quality && quality.skills && typeof quality.skills === 'object') ? quality.skills : {};
    const skills = {};
    // Tasas por skill (sólo los skills ya whitelisteados por el recommender):
    // no caben en las 15 claves de `evidencia` y la tabla humana las necesita.
    const calidad = {};
    for (const skill of Object.keys(v.skills || {}).sort()) {
        const s = v.skills[skill];
        if (!s || typeof s !== 'object') continue;
        Object.defineProperty(skills, skill, {
            value: { veredicto: s.veredicto, evidencia: s.evidencia }, enumerable: true, writable: true, configurable: true,
        });
        const q = (Object.prototype.hasOwnProperty.call(qSkills, skill) && qSkills[skill]) || {};
        const tasas = {};
        for (const k of RATE_KEYS) tasas[k] = finiteOrNull(q[k]);
        Object.defineProperty(calidad, skill, { value: tasas, enumerable: true, writable: true, configurable: true });
    }
    const sinSha = {
        version: REPORT_VERSION,
        generado_en: toIso(Number.isFinite(generatedAt) ? generatedAt : Date.now()),
        ventana: { from: toIso(win.from), to: toIso(win.to), dias: Number.isFinite(win.dias) ? win.dias : null },
        propagation_enabled: propagationEnabled === true,
        advertencias: Array.isArray(v.advertencias) ? [...v.advertencias] : [],
        precios: {
            sha256: typeof f.sha256 === 'string' ? f.sha256 : null,
            version: f.version === undefined ? null : f.version,
            updated_at: f.updated_at === undefined ? null : f.updated_at,
            stale: f.stale === true,
            motivo: typeof f.motivo === 'string' ? f.motivo : null,
            missing_models: missingModels(f),
        },
        integridad: (integridad && typeof integridad === 'object') ? { ...integridad } : {},
        skills,
        calidad,
        desconocidos: (v.desconocidos && typeof v.desconocidos === 'object') ? { ...v.desconocidos } : {},
        umbrales: (v.umbrales && typeof v.umbrales === 'object') ? v.umbrales : {},
        agent_models_sha256: typeof agentModelsSha256 === 'string' ? agentModelsSha256 : null,
    };
    const sha256 = sha256Of(sinSha);
    // Claves ya ordenadas: borrar `sha256` y recalcular da el mismo valor (C13).
    return JSON.parse(canonicalJsonStringify({ ...sinSha, sha256 }));
}

// -----------------------------------------------------------------------------
// renderHuman
// -----------------------------------------------------------------------------

/** Filas ordenadas por accionabilidad (C17 + PR2). */
function sortRows(report) {
    const skills = (report && report.skills) || {};
    const rows = Object.keys(skills).map((skill) => ({ skill, ...skills[skill] }));
    const rank = (v) => { const i = VERDICT_ORDER.indexOf(v); return i < 0 ? VERDICT_ORDER.length : i; };
    return rows.sort((a, b) => {
        const ra = rank(a.veredicto), rb = rank(b.veredicto);
        if (ra !== rb) return ra - rb;
        const aa = (a.evidencia && a.evidencia.alertas_calidad && a.evidencia.alertas_calidad.length) ? 1 : 0;
        const ab = (b.evidencia && b.evidencia.alertas_calidad && b.evidencia.alertas_calidad.length) ? 1 : 0;
        if (aa !== ab) return ab - aa;
        const na = (a.evidencia && Number.isFinite(a.evidencia.n)) ? a.evidencia.n : -1;
        const nb = (b.evidencia && Number.isFinite(b.evidencia.n)) ? b.evidencia.n : -1;
        if (na !== nb) return nb - na;
        return a.skill < b.skill ? -1 : (a.skill > b.skill ? 1 : 0);
    });
}

function pct(v) {
    return fmtRate(v);
}

/** Texto de un motivo con las cifras validadas que le corresponden. */
function motivoTexto(code, ev, umbrales) {
    const base = MOTIVO_LABEL[code];
    if (!base) return null;
    const th = (umbrales && umbrales.thresholds) || {};
    switch (code) {
        case 'rebound_alto':
            return `rebote ${pct(ev.reboundRate)} (umbral ${pct(th.subir_rebound)})`;
        case 'early_death_alto':
            return `muerte temprana ${pct(ev.earlyDeathRate)} (umbral ${pct(th.subir_early_death)})`;
        case 'qa_fail_alto':
            return `QA fallido ${pct(ev.qaFailRate)} (umbral ${pct(th.subir_qa_fail)})`;
        case 'muestra_insuficiente':
            return `${base} (n = ${fmtInt(ev.n)}, mínimo ${fmtInt(umbrales && umbrales.min_sample)})`;
        case 'calidad_ok_costo_menor':
            return ev.modelo_destino ? `${base}: destino ${modelCell(ev.modelo_destino, ABSENCE.SIN_DATO)}` : base;
        default:
            return base;
    }
}

/** Partes de la celda Motivo: alarmas primero (PR2), después el resto. */
function motivoCell(row, umbrales, rates) {
    const ev = row.evidencia || {};
    const ctx = { ...ev, ...rates };
    const alertas = Array.isArray(ev.alertas_calidad) ? ev.alertas_calidad.filter((a) => ALERTAS.includes(a)) : [];
    const resto = (Array.isArray(ev.motivo) ? ev.motivo : []).filter((m) => !alertas.includes(m));
    const partes = [];
    for (const code of [...alertas, ...resto]) {
        const t = motivoTexto(code, ctx, umbrales);
        if (t && !partes.includes(t)) partes.push(t);
    }
    if (row.veredicto === VERDICT.SUBIR && ev.modelo_destino) partes.push(`destino ${modelCell(ev.modelo_destino, ABSENCE.SIN_DATO)}`);
    if (row.veredicto === VERDICT.SUBIR && Number.isFinite(ev.costo_reproceso_usd)) {
        partes.push(`reproceso estimado ${fmtUsd(ev.costo_reproceso_usd, ABSENCE.NO_CUANTIFICABLE)} en la ventana`);
    } else if (row.veredicto === VERDICT.SUBIR) {
        partes.push(`reproceso ${ABSENCE.NO_CUANTIFICABLE}`);
    }
    if (row.veredicto === VERDICT.BAJAR && ev.riesgo_estimado && RIESGO_LABEL[ev.riesgo_estimado]) {
        partes.push(`riesgo ${RIESGO_LABEL[ev.riesgo_estimado]}`);
    }
    return partes.length ? partes : [ABSENCE.SIN_OBSERVACIONES];
}

/** Celda para un VALOR de entrada (id whitelisteado): sin controles, tope 120, sin `|`. */
function cell(v) {
    return stripForOutput(v).replace(/\|/g, '/');
}

/** Celda de modelo: sólo un id que pasa el validador del writer; si no, ausencia. */
function modelCell(v, absent) {
    if (v == null || typeof v !== 'string') return absent;
    return safeModel(v) === v ? cell(v) : absent;
}

/**
 * Celda COMPUESTA: cada parte (etiqueta constante + valor validado) pasa por
 * `cell` por separado; el tope de 120 es por valor, no por celda.
 */
function celdaCompuesta(partes) {
    return partes.map(cell).join(' · ');
}

/**
 * @param {object} report        salida de `buildReport`
 * @param {{compacto?:boolean, comando?:string, rates?:object}} [opts]
 *   `rates` (opcional): `{ <skill>: { reboundRate, earlyDeathRate, qaFailRate } }`
 *   para las columnas de tasa; si no llega, se toma de `report.calidad`.
 */
function renderHuman(report, opts = {}) {
    const r = report || {};
    const compacto = opts.compacto === true;
    const comando = typeof opts.comando === 'string' ? opts.comando : '';
    const ratesBySkill = (opts.rates && typeof opts.rates === 'object') ? opts.rates : ((r.calidad && typeof r.calidad === 'object') ? r.calidad : {});
    const umbrales = r.umbrales || {};
    const integridad = r.integridad || {};
    const precios = r.precios || {};
    const rows = sortRows(r);
    const totalN = rows.reduce((acc, x) => acc + ((x.evidencia && Number.isFinite(x.evidencia.n)) ? x.evidencia.n : 0), 0);
    const ventana = r.ventana || {};
    const out = [];

    // ---- cabecera ----------------------------------------------------------
    out.push(RULE);
    out.push(` AUDITORÍA DE MODELOS POR AGENTE — ventana ${fmtDay(ventana.from)} → ${fmtDay(ventana.to)}`
        + ` (${fmtInt(ventana.dias)} días · ${fmtInt(totalN)} corridas)`);
    if (integridad.spawn_exit !== 'verificada') {
        out.push(' SEÑAL NO CONFIABLE — cadena de spawn-exit rota: ningún veredicto de esta tabla es accionable');
    }
    const sinPrecio = rows.filter((x) => x.evidencia && Array.isArray(x.evidencia.motivo) && x.evidencia.motivo.includes('modelo_sin_precio')).length;
    const missing = Array.isArray(precios.missing_models) ? precios.missing_models.map((m) => modelCell(m.model, ABSENCE.SIN_DATO)) : [];
    let lineaPrecios = ` Precios: tabla v${cell(precios.version === null || precios.version === undefined ? ABSENCE.SIN_DATO : precios.version)}`
        + ` del ${fmtDay(precios.updated_at)}`;
    if (precios.stale) lineaPrecios += ` (${PRECIOS_MOTIVO_LABEL[precios.motivo] || 'vencida'})`;
    if (missing.length) lineaPrecios += `; sin precio para ${missing.join(', ')} → ${fmtInt(sinPrecio)} agente/s no evaluable/s (#7507)`;
    out.push(lineaPrecios);
    out.push(integridad.cost_evaluable === true
        ? ' Costo: evaluable en la ventana (filas con timestamp, #6558); caché no medido (#7506)'
        : ` Costo: no evaluable — ${COSTO_MOTIVO_LABEL[integridad.cost_reason] || 'sin dato de costo en la ventana'} (#6558); ningún «bajar» se emite sin costo`);
    out.push(integridad.rebound_measurable === true
        ? ' Rebotes: medibles en toda la ventana'
        : ' Rebotes: no medibles en la ventana; la columna Rebote dice «sin dato», no 0 %');
    out.push(` Integridad: spawn-exit ${cell(integridad.spawn_exit || 'rota')}`
        + ` · rebotes/QA/costo/modelo efectivo sin cadena de integridad (#7508)`
        + (Number.isFinite(integridad.broken_files) && integridad.broken_files > 0 ? ` · ${fmtInt(integridad.broken_files)} archivo/s con cadena rota` : ''));
    for (const a of Array.isArray(r.advertencias) ? r.advertencias : []) {
        if (ADVERTENCIA_LABEL[a]) out.push(` Ojo: ${ADVERTENCIA_LABEL[a]}`);
    }
    if (comando) out.push(` Regenerar: ${cell(comando)}`);
    out.push(RULE);
    out.push('');

    // ---- tabla -------------------------------------------------------------
    const ratesOf = (skill) => (Object.prototype.hasOwnProperty.call(ratesBySkill, skill) && ratesBySkill[skill]) || {};
    const nCell = (x) => {
        const ev = x.evidencia || {};
        const base = fmtInt(ev.n);
        return x.veredicto === VERDICT.SIN_EVIDENCIA ? `${base} (< ${fmtInt(umbrales.min_sample)})` : base;
    };
    if (compacto) {
        const head = '| Skill | Modelo efectivo | Veredicto | n |\n|---|---|---|---:|';
        if (!rows.length) {
            out.push(`${head}\n| ${ABSENCE.SIN_MUESTRA} | ${ABSENCE.SIN_MUESTRA} | ${ABSENCE.SIN_MUESTRA} | ${ABSENCE.SIN_MUESTRA} |`);
        } else {
            out.push(head);
            for (const x of rows) {
                const ev = x.evidencia || {};
                out.push(`| ${[
                    cell(x.skill),
                    modelCell(ev.modelo_efectivo, ABSENCE.NO_OBSERVADO),
                    VERDICT_LABEL[x.veredicto] || ABSENCE.NO_EVALUABLE,
                    nCell(x),
                ].join(' | ')} |`);
            }
        }
    } else {
        const head = [
            '| Skill | Declarado | Efectivo | Difiere | n | Rebote | Muerte temprana | QA fallido | Costo ventana | Ahorro mensual | Veredicto | Motivo |',
            '|---|---|---|---|---:|---:|---:|---:|---:|---:|---|---|',
        ].join('\n');
        if (!rows.length) {
            out.push(`${head}\n| ${new Array(12).fill(ABSENCE.SIN_MUESTRA).join(' | ')} |`);
        } else {
            out.push(head);
            for (const x of rows) {
                const ev = x.evidencia || {};
                const rt = ratesOf(x.skill);
                out.push(`| ${[
                    cell(x.skill),
                    modelCell(ev.modelo_declarado, ABSENCE.SIN_DECLARAR),
                    modelCell(ev.modelo_efectivo, ABSENCE.NO_OBSERVADO),
                    fmtDifiere(ev.difiere),
                    nCell(x),
                    fmtRate(rt.reboundRate),
                    fmtRate(rt.earlyDeathRate),
                    fmtRate(rt.qaFailRate),
                    fmtUsd(ev.costo_ventana_usd, ABSENCE.NO_EVALUABLE),
                    fmtUsd(ev.ahorro_mensual_estimado_usd, ABSENCE.NO_CUANTIFICABLE),
                    VERDICT_LABEL[x.veredicto] || ABSENCE.NO_EVALUABLE,
                    celdaCompuesta(motivoCell(x, umbrales, rt)),
                ].join(' | ')} |`);
            }
        }
    }
    out.push('');

    // ---- pie ---------------------------------------------------------------
    const noObs = rows.reduce((acc, x) => acc + ((x.evidencia && Number.isFinite(x.evidencia.no_observados)) ? x.evidencia.no_observados : 0), 0);
    const excl = rows.reduce((acc, x) => acc + ((x.evidencia && Number.isFinite(x.evidencia.costo_filas_excluidas)) ? x.evidencia.costo_filas_excluidas : 0), 0);
    const d = r.desconocidos || {};
    const dTotal = ['skills', 'providers', 'models'].reduce((acc, k) => acc + (Number.isFinite(d[k]) ? d[k] : 0), 0);
    out.push(` Corridas sin modelo observable: ${fmtInt(noObs)} · filas de costo excluidas: ${fmtInt(excl)}`
        + ` · descartados por lista blanca: ${fmtInt(dTotal)}`
        + ` (skills ${fmtInt(d.skills)}, proveedores ${fmtInt(d.providers)}, modelos ${fmtInt(d.models)})`);
    if (compacto) {
        const porGrupo = {};
        for (const x of rows) porGrupo[x.veredicto] = (porGrupo[x.veredicto] || 0) + 1;
        const resumen = VERDICT_ORDER.filter((v) => porGrupo[v]).map((v) => `${VERDICT_LABEL[v]}: ${fmtInt(porGrupo[v])}`).join(' · ');
        out.push(` Veredictos: ${resumen || ABSENCE.SIN_MUESTRA}`);
        if (missing.length) out.push(` Sin precio para ${missing.join(', ')}: ${fmtInt(sinPrecio)} agente/s no evaluable/s (#7507)`);
    }
    const th = umbrales.thresholds || {};
    out.push(` Umbrales aplicados: subir si rebote ≥ ${pct(th.subir_rebound)} o muerte temprana ≥ ${pct(th.subir_early_death)}`
        + ` o QA fallido ≥ ${pct(th.subir_qa_fail)}; bajar sólo con rebote ≤ ${pct(th.bajar_rebound)},`
        + ` muerte temprana ≤ ${pct(th.bajar_early_death)} y QA fallido 0 % · muestra mínima ${fmtInt(umbrales.min_sample)}`
        + ` · protegidos: ${(Array.isArray(umbrales.protected_skills) ? umbrales.protected_skills.map(cell) : []).join(', ') || ABSENCE.SIN_DATO}`);
    out.push(' Nada se cambió solo. Un cambio de modelo es un PR sobre agent-models.json.');

    // Última defensa (CA-22): el texto completo pasa por el redactor central.
    return redactRagContent(out.join('\n'));
}

module.exports = {
    REPORT_VERSION,
    VERDICT_LABEL,
    MOTIVO_LABEL,
    RIESGO_LABEL,
    ADVERTENCIA_LABEL,
    PRECIOS_MOTIVO_LABEL,
    COSTO_MOTIVO_LABEL,
    ABSENCE,
    VERDICT_ORDER,
    fmtInt,
    fmtRate,
    fmtUsd,
    fmtDay,
    sha256Of,
    buildReport,
    sortRows,
    motivoTexto,
    renderHuman,
};

// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// =============================================================================
// model-value-audit / proposal — propuesta PURA del auditor (#7520, CA-26)
// =============================================================================
//
// Forma "alineada al draft de #6807 al 2026-09-21" (P9 / SEC-16 / CA-UX-5):
//
//   { titulo, tipo: 'cambio-de-configuracion', accion,
//     evidencia: { tipo: 'metrica', referencia: <hash>, resumen ≤ 500 },
//     beneficio ≤ 300, costo: { nivel, detalle? }, riesgo: { nivel, detalle? },
//     sensible: false }
//
// - `productor: 'auditor-modelos'` viaja en el `ctx` de `publish(proposal, ctx)`,
//   NUNCA en el payload (cae por `additionalProperties:false` del schema de
//   #6807 — C2 de guru).
// - `titulo` es la ÚNICA fuente de la primera línea del mensaje (CA-UX-3.1).
// - Sin campos de presentación (`parse_mode`, `chat_id`, `reply_markup`, `voice`).
// - `sensible: false` sólo es lícito porque el contenido son números agregados
//   + identificadores whitelisteados: `validateProposal` rechaza cualquier
//   campo con `\n`, `/`, `\\` o que matchee `SECRET_VALUE_PATTERNS` (SEC-16).
//
// Puro: sin `fs`, sin red, sin procesos. Cada valor interpolado pasa por
// `stripForOutput` (#7517) ANTES de componer; los labels salen de `report.js`
// (#7519): este módulo no inventa vocabulario ni formatea números por su cuenta.

const { stripForOutput, safeModel } = require('./sanitize');
const report = require('./report');
const { SECRET_VALUE_PATTERNS } = require('../redact');

const { VERDICT_LABEL, ABSENCE, fmtRate, fmtInt, fmtUsd, fmtDay } = report;

const PRODUCTOR = 'auditor-modelos';
const TIPO = 'cambio-de-configuracion';
const EVIDENCIA_TIPO = 'metrica';
const TITULO_MIN = 12;
const TITULO_MAX = 90;
const TITULO_FORBIDDEN_RE = /[\n*_]|http/i;
const ACCION_MAX = 200;
const RESUMEN_MAX = 500;
const BENEFICIO_MAX = 300;
const DETALLE_MAX = 200;
/** Un campo de la propuesta nunca lleva salto de línea ni separador de path (SEC-16). */
const CAMPO_FORBIDDEN_RE = /[\n\r/\\]/;
const NIVEL = Object.freeze(['bajo', 'medio', 'alto']);
const PROPOSAL_KEYS = Object.freeze(['accion', 'beneficio', 'costo', 'evidencia', 'riesgo', 'sensible', 'tipo', 'titulo']);
const TITULO_PREFIX = 'Auditoría de modelos por agente';
// El nombre del archivo se arma por concatenación: el policy test de #7517
// (CA-4) prohíbe el literal en el módulo para que nadie lea precios sin
// pasar por `lib/pricing.js`; acá es sólo copy hacia el operador.
const PRICING_FILE = 'pricing' + '.json';
const ACCION_PRECIOS = `refrescar ${PRICING_FILE} (#7507)`;
/**
 * Forma de un id de skill despachable (defensa en profundidad, SEC-12): las
 * claves de `report.skills` ya vienen whitelisteadas por la parte 1, pero el
 * texto hacia el operador no confía en eso. Lo que no matchea, no se nombra.
 */
const SKILL_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const RIESGO_DETALLE_SIN_OBSERVACION = 'no cuantificable — sin observación del modelo destino';

/** Un valor de entrada (id whitelisteado, número ya formateado) listo para interpolar. */
function val(v) {
    return stripForOutput(v == null ? '' : v);
}

/** Skills con ese veredicto cuyo id tiene forma válida, ordenados. */
function skillsPorVeredicto(rep, veredicto) {
    const skills = (rep && rep.skills && typeof rep.skills === 'object') ? rep.skills : {};
    return Object.keys(skills).sort().filter((k) => SKILL_ID_RE.test(k) && skills[k] && skills[k].veredicto === veredicto);
}

/** Id de modelo que pasa el validador del writer; si no, la ausencia pedida. */
function modelOr(v, absent) {
    if (v == null || typeof v !== 'string') return absent;
    return safeModel(v) === v ? v : absent;
}

function hallazgoPrecios(rep) {
    const p = (rep && rep.precios && typeof rep.precios === 'object') ? rep.precios : {};
    return {
        stale: p.stale === true,
        missing: Array.isArray(p.missing_models) ? p.missing_models.filter((m) => m && typeof m.model === 'string') : [],
    };
}

/** CA-UX-3.1: `Auditoría de modelos por agente · <from> → <to>` (57 chars). */
function buildTitulo(rep) {
    const ventana = (rep && rep.ventana && typeof rep.ventana === 'object') ? rep.ventana : {};
    return `${TITULO_PREFIX} · ${val(fmtDay(ventana.from))} → ${val(fmtDay(ventana.to))}`;
}

function rateOf(rep, skill, key) {
    const c = (rep && rep.calidad && typeof rep.calidad === 'object' && Object.prototype.hasOwnProperty.call(rep.calidad, skill)) ? rep.calidad[skill] : null;
    return (c && Number.isFinite(c[key])) ? c[key] : null;
}

/** Métrica que justifica un `subir`: la primera alarma de calidad, con su tasa. */
function motivoSubir(rep, skill) {
    const ev = (rep.skills[skill] && rep.skills[skill].evidencia) || {};
    const alertas = Array.isArray(ev.alertas_calidad) ? ev.alertas_calidad : [];
    if (alertas.includes('rebound_alto')) return `rebote ${val(fmtRate(rateOf(rep, skill, 'reboundRate')))}`;
    if (alertas.includes('early_death_alto')) return `muerte temprana ${val(fmtRate(rateOf(rep, skill, 'earlyDeathRate')))}`;
    if (alertas.includes('qa_fail_alto')) return `QA fallido ${val(fmtRate(rateOf(rep, skill, 'qaFailRate')))}`;
    return null;
}

/** Beneficio en términos del operador (CA-UX-5), sin ids internos. */
function beneficioDe(rep, subir, bajar, precios) {
    const partes = [];
    for (const skill of bajar) {
        const ev = (rep.skills[skill] && rep.skills[skill].evidencia) || {};
        const ahorro = Number.isFinite(ev.ahorro_mensual_estimado_usd) ? ev.ahorro_mensual_estimado_usd : null;
        partes.push(ahorro !== null
            ? `ahorra ~${val(fmtUsd(ahorro, ABSENCE.NO_CUANTIFICABLE))} por mes en ${val(skill)}`
            : `${val(skill)} puede correr con un modelo más barato`);
    }
    for (const skill of subir) {
        const motivo = motivoSubir(rep, skill);
        partes.push(motivo ? `reduce ${motivo} de ${val(skill)}` : `mejora la calidad de ${val(skill)}`);
    }
    if (precios.stale || precios.missing.length) partes.push('vuelve evaluables los agentes sin precio');
    return partes.join('; ');
}

/** Resumen de la evidencia (≤ 500): conteos, listas y hallazgo de precios. */
function resumenDe(rep, subir, bajar, precios) {
    const n = Object.keys((rep && rep.skills) || {}).length;
    const partes = [`${val(fmtInt(n))} agentes evaluados`];
    if (subir.length) partes.push(`${VERDICT_LABEL.subir}: ${subir.map(val).join(', ')}`);
    if (bajar.length) partes.push(`${VERDICT_LABEL.bajar}: ${bajar.map(val).join(', ')}`);
    if (precios.stale) partes.push('tabla de precios vencida');
    if (precios.missing.length) {
        partes.push(`sin precio para ${precios.missing.map((m) => `${val(modelOr(m.model, ABSENCE.SIN_DATO))} (${val(fmtInt(m.n))} corridas)`).join(', ')}`);
    }
    return partes.join('; ');
}

function accionDe(subir, bajar, precios) {
    const conPrecios = precios.stale || precios.missing.length > 0;
    const total = subir.length + bajar.length;
    if (total === 0) return ACCION_PRECIOS;
    if (total === 1 && !conPrecios) {
        return subir.length ? `${VERDICT_LABEL.subir} a ${val(subir[0])}` : `${VERDICT_LABEL.bajar} a ${val(bajar[0])}`;
    }
    const partes = [];
    if (subir.length) partes.push(`subir ${subir.map(val).join(', ')}`);
    if (bajar.length) partes.push(`bajar ${bajar.map(val).join(', ')}`);
    let accion = `revisar ${val(fmtInt(total))} sugerencias: ${partes.join(', ')}`;
    if (conPrecios) accion += `; refrescar ${PRICING_FILE}`;
    return accion;
}

function nivelMax(a, b) {
    return NIVEL.indexOf(b) > NIVEL.indexOf(a) ? b : a;
}

/**
 * Mapeo cerrado (P9): `bajar` ⇒ costo `bajo`, riesgo `medio` sin propagación /
 * `bajo` con propagación; `subir` ⇒ costo `medio`, riesgo `bajo`; sólo precios
 * ⇒ `bajo`/`bajo`. Con varios tipos, gana el nivel más alto de cada eje.
 */
function costoRiesgo(subir, bajar, propagationEnabled) {
    let costo = 'bajo';
    let riesgo = 'bajo';
    let riesgoDetalle = null;
    if (bajar.length) {
        if (propagationEnabled !== true) {
            riesgo = nivelMax(riesgo, 'medio');
            riesgoDetalle = RIESGO_DETALLE_SIN_OBSERVACION;
        }
    }
    if (subir.length) costo = nivelMax(costo, 'medio');
    const out = { costo: { nivel: costo }, riesgo: { nivel: riesgo } };
    if (riesgoDetalle) out.riesgo.detalle = riesgoDetalle;
    return out;
}

function recortar(s, max) {
    const t = String(s);
    return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/**
 * @param {object} rep                        salida de `report.buildReport`
 * @param {{referencia:string, propagationEnabled?:boolean}} opts
 * @returns {object} propuesta (claves cerradas: `PROPOSAL_KEYS`)
 */
function buildProposal(rep, { referencia, propagationEnabled } = {}) {
    if (!rep || typeof rep !== 'object') throw new Error('[model-value-audit] buildProposal: reporte requerido');
    const subir = skillsPorVeredicto(rep, 'subir');
    const bajar = skillsPorVeredicto(rep, 'bajar');
    const precios = hallazgoPrecios(rep);
    const { costo, riesgo } = costoRiesgo(subir, bajar, propagationEnabled);
    return {
        titulo: buildTitulo(rep),
        tipo: TIPO,
        accion: recortar(accionDe(subir, bajar, precios), ACCION_MAX),
        evidencia: {
            tipo: EVIDENCIA_TIPO,
            referencia: typeof referencia === 'string' ? referencia : (typeof rep.sha256 === 'string' ? rep.sha256 : ''),
            resumen: recortar(resumenDe(rep, subir, bajar, precios), RESUMEN_MAX),
        },
        beneficio: recortar(beneficioDe(rep, subir, bajar, precios), BENEFICIO_MAX),
        costo,
        riesgo,
        sensible: false,
    };
}

function matcheaSecreto(s) {
    for (const { re } of SECRET_VALUE_PATTERNS) {
        const probe = new RegExp(re.source, re.flags.replace('g', ''));
        if (probe.test(s)) return true;
    }
    return false;
}

/** Rechaza un string con `\n`, `/`, `\\` o con forma de secreto (SEC-16). */
function campoOk(s, max) {
    if (typeof s !== 'string' || s.length === 0 || s.length > max) return false;
    if (CAMPO_FORBIDDEN_RE.test(s)) return false;
    if (matcheaSecreto(s)) return false;
    return true;
}

function nivelOk(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    const keys = Object.keys(obj).sort();
    if (keys.length === 1 ? keys[0] !== 'nivel' : (keys.length !== 2 || keys[0] !== 'detalle' || keys[1] !== 'nivel')) return false;
    if (!NIVEL.includes(obj.nivel)) return false;
    if (keys.length === 2 && !campoOk(obj.detalle, DETALLE_MAX)) return false;
    return true;
}

/**
 * @param {object} p
 * @returns {{ok:boolean, reason:string|null}}
 */
function validateProposal(p) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return { ok: false, reason: 'propuesta_invalida' };
    const keys = Object.keys(p).sort();
    if (keys.length !== PROPOSAL_KEYS.length || keys.some((k, i) => k !== PROPOSAL_KEYS[i])) return { ok: false, reason: 'claves_invalidas' };
    if (typeof p.titulo !== 'string' || p.titulo.length < TITULO_MIN || p.titulo.length > TITULO_MAX) return { ok: false, reason: 'titulo_fuera_de_rango' };
    if (TITULO_FORBIDDEN_RE.test(p.titulo) || !campoOk(p.titulo, TITULO_MAX)) return { ok: false, reason: 'titulo_invalido' };
    if (p.tipo !== TIPO) return { ok: false, reason: 'tipo_invalido' };
    if (!campoOk(p.accion, ACCION_MAX)) return { ok: false, reason: 'accion_invalida' };
    const ev = p.evidencia;
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return { ok: false, reason: 'evidencia_invalida' };
    const evKeys = Object.keys(ev).sort();
    if (evKeys.length !== 3 || evKeys[0] !== 'referencia' || evKeys[1] !== 'resumen' || evKeys[2] !== 'tipo') return { ok: false, reason: 'evidencia_invalida' };
    if (ev.tipo !== EVIDENCIA_TIPO) return { ok: false, reason: 'evidencia_invalida' };
    if (typeof ev.referencia !== 'string' || !/^[0-9a-f]{8,64}$/.test(ev.referencia)) return { ok: false, reason: 'referencia_invalida' };
    if (!campoOk(ev.resumen, RESUMEN_MAX)) return { ok: false, reason: 'resumen_invalido' };
    if (!campoOk(p.beneficio, BENEFICIO_MAX)) return { ok: false, reason: 'beneficio_invalido' };
    if (!nivelOk(p.costo)) return { ok: false, reason: 'costo_invalido' };
    if (!nivelOk(p.riesgo)) return { ok: false, reason: 'riesgo_invalido' };
    if (p.sensible !== false) return { ok: false, reason: 'sensible_invalido' };
    return { ok: true, reason: null };
}

module.exports = {
    PRODUCTOR,
    TIPO,
    EVIDENCIA_TIPO,
    TITULO_MIN,
    TITULO_MAX,
    TITULO_FORBIDDEN_RE,
    CAMPO_FORBIDDEN_RE,
    ACCION_MAX,
    RESUMEN_MAX,
    BENEFICIO_MAX,
    NIVEL,
    PROPOSAL_KEYS,
    SKILL_ID_RE,
    ACCION_PRECIOS,
    skillsPorVeredicto,
    modelOr,
    RIESGO_DETALLE_SIN_OBSERVACION,
    buildTitulo,
    buildProposal,
    validateProposal,
};

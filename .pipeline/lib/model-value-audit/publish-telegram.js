// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// =============================================================================
// model-value-audit / publish-telegram — adaptador `telegram-plain` (#7520)
// =============================================================================
//
// Único punto del módulo que produce TEXTO hacia el operador. Encola UN
// dropfile en `servicios/telegram/pendiente/` con el payload exacto del
// precedente `vault-cut` (`pulpo.js`, #5421 / #6190):
//
//     { text, plain: true, disable_web_page_preview: true }      — SIN parse_mode
//
// `plain: true` hace que `servicio-telegram.js` envíe sin `parse_mode`: el
// texto llega LITERAL y un `_` de un nombre de skill nunca lo manda a
// `fallido/` con `400 can't parse entities` (C5 de guru, CA-26).
//
// Orden interno (P6 / SEC-12), sobre el texto ya renderizado:
//   validateProposal → renderMessage → sanitizeText (por línea: controles +
//   invisibles → redactSecretValue → redactSensitive) → truncateByItems (3.500,
//   ítems enteros, marcador ANTES del cierre) → UN writeDropfileSync →
//   audio (CA-UX-4) como Promise fire-and-forget, fail-open sólo del audio.
//
// Mensaje diseñado para el celular (CA-UX-3): título = `proposal.titulo`;
// ≤ 5 ítems (`subir` → `bajar` → precios) + `y N más en el reporte completo`;
// advertencia de propagación en una línea; cierre fijo con `FOOTER_CMD` y
// `ref <hash8>`. Toda URL/comando del texto es constante del módulo.
//
// Vocabulario y formato: `VERDICT_LABEL` / `fmt*` de `./report` (#7519) y
// `stripForOutput` (#7517) sobre CADA valor interpolado antes de componer. El
// adaptador no formatea números por su cuenta.
//
// Escrituras: el dropfile (vía `write-target`, canal `colas`) y —delegado en
// `deliverable-notify.generateAudioNotifications`, ya inventariado— el `.ogg`
// bajo `deliverable_notifications.audio_root`.

const path = require('path');
const { stripForOutput } = require('./sanitize');
const report = require('./report');
const { validateProposal, skillsPorVeredicto, modelOr } = require('./proposal');
const redact = require('../redact');

const { VERDICT_LABEL, ABSENCE, fmtRate, fmtInt, fmtUsd, fmtDay } = report;

const MAX_CHARS = 3500;
const MAX_ITEMS = 5;
const SUFFIX = 'model-value-audit.json';
const SKILL_NAME = 'model-value-audit';
const AUDIO_EVENT = 'model_value_audit';
const FOOTER_CMD = 'node .pipeline/scripts/model-value-report.js';
const FOOTER_PREFIX = 'Nada se cambió solo. Reporte completo:';
const TRUNCATION_MARKER = '… (mensaje recortado; ver reporte completo)';
/** Sin `_`: la prohibición de ids internos aplica también a esta línea (CA-UX-3). */
const PROPAGATION_WARNING = 'Ojo: el modelo declarado no se está propagando (propagación de modelos apagada); '
    + 'aceptar una sugerencia implica encender el rollout (#6274).';
const PRICING_ISSUE = '#7507';
const DEFAULT_PRICING_MAX_AGE_DAYS = 60;
const DAY_MS = 86400000;
const WEEK_MS = 7 * DAY_MS;

// Misma regex que `sanitize.CONTROL_RE` (A2 de #7517) SIN el `slice(0, 120)`:
// se aplica por LÍNEA sobre el texto final (una línea de precios mide > 120).
const CONTROL_RE = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/g;
const INVISIBLE_RE = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

function val(v) {
    return stripForOutput(v == null ? '' : v);
}

function rateOf(rep, skill, key) {
    const c = (rep && rep.calidad && typeof rep.calidad === 'object' && Object.prototype.hasOwnProperty.call(rep.calidad, skill)) ? rep.calidad[skill] : null;
    return (c && Number.isFinite(c[key])) ? c[key] : null;
}

function evidenciaDe(rep, skill) {
    return (rep.skills[skill] && rep.skills[skill].evidencia && typeof rep.skills[skill].evidencia === 'object') ? rep.skills[skill].evidencia : {};
}

function lineaSubir(rep, skill) {
    const ev = evidenciaDe(rep, skill);
    const alertas = Array.isArray(ev.alertas_calidad) ? ev.alertas_calidad : [];
    let motivo = null;
    if (alertas.includes('rebound_alto')) motivo = `rebote ${val(fmtRate(rateOf(rep, skill, 'reboundRate')))}`;
    else if (alertas.includes('early_death_alto')) motivo = `muerte temprana ${val(fmtRate(rateOf(rep, skill, 'earlyDeathRate')))}`;
    else if (alertas.includes('qa_fail_alto')) motivo = `QA fallido ${val(fmtRate(rateOf(rep, skill, 'qaFailRate')))}`;
    const actual = val(modelOr(ev.modelo_efectivo, ABSENCE.NO_OBSERVADO));
    let linea = `${val(skill)}: ${VERDICT_LABEL.subir} (${actual}) — ${motivo || 'calidad por debajo del umbral'} en ${val(fmtInt(ev.n))} corridas`;
    const destino = modelOr(ev.modelo_destino, null);
    if (destino) linea += `, destino ${val(destino)}`;
    return linea;
}

function lineaBajar(rep, skill) {
    const ev = evidenciaDe(rep, skill);
    const actual = val(modelOr(ev.modelo_efectivo, ABSENCE.NO_OBSERVADO));
    const destino = val(modelOr(ev.modelo_destino, ABSENCE.SIN_DATO));
    const ahorro = val(fmtUsd(ev.ahorro_mensual_estimado_usd, ABSENCE.NO_CUANTIFICABLE));
    const rebote = rateOf(rep, skill, 'reboundRate');
    const colaRebote = rebote === 0 ? 'sin rebote' : `rebote ${val(fmtRate(rebote))}`;
    return `${val(skill)}: ${VERDICT_LABEL.bajar} (${actual} → ${destino}) — ahorro estimado ${ahorro} por mes, ${val(fmtInt(ev.n))} corridas ${colaRebote}`;
}

/** `N` semanas desde que venció la tabla, derivado sin estado nuevo (P10). */
function semanasVencida(updatedAt, maxAgeDays, now) {
    const t = Date.parse(updatedAt);
    if (!Number.isFinite(t)) return null;
    const max = (Number.isFinite(maxAgeDays) && maxAgeDays >= 1) ? maxAgeDays : DEFAULT_PRICING_MAX_AGE_DAYS;
    const vencimiento = t + max * DAY_MS;
    if (now <= vencimiento) return 0;
    return Math.floor((now - vencimiento) / WEEK_MS);
}

function lineaPrecios(rep, ctx) {
    const p = (rep.precios && typeof rep.precios === 'object') ? rep.precios : {};
    const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
    const seccion = (ctx.cfgRoot && ctx.cfgRoot.model_value_audit && typeof ctx.cfgRoot.model_value_audit === 'object') ? ctx.cfgRoot.model_value_audit : {};
    const t = typeof p.updated_at === 'string' ? Date.parse(p.updated_at) : NaN;
    let linea = Number.isFinite(t)
        ? `La tabla de precios tiene ${val(fmtInt(Math.floor((now - t) / DAY_MS)))} días (última: ${val(fmtDay(p.updated_at))})`
        : 'La tabla de precios no tiene fecha de actualización';
    const missing = Array.isArray(p.missing_models) ? p.missing_models.filter((m) => m && typeof m.model === 'string') : [];
    if (missing.length) {
        const modelos = missing.map((m) => `${val(modelOr(m.model, ABSENCE.SIN_DATO))}, que corrió ${val(fmtInt(m.n))} veces`).join('; ');
        const sinPrecio = Object.keys(rep.skills || {}).filter((k) => {
            const ev = evidenciaDe(rep, k);
            return Array.isArray(ev.motivo) && ev.motivo.includes('modelo_sin_precio');
        }).length;
        linea += ` y no tiene ${modelos}: ${sinPrecio === 1 ? '1 agente no se pudo evaluar' : `${val(fmtInt(sinPrecio))} agentes no se pudieron evaluar`}`;
    }
    linea += '.';
    if (p.stale === true) {
        const semanas = semanasVencida(p.updated_at, seccion.pricing_max_age_days, now);
        linea += (semanas !== null && semanas >= 1)
            ? ` Hace ${val(fmtInt(semanas))} ${semanas === 1 ? 'semana' : 'semanas'} que la tabla está vencida.`
            : ' La tabla está vencida.';
    }
    linea += ` Refrescarla: ${PRICING_ISSUE}.`;
    return linea;
}

/**
 * Líneas del mensaje (CA-UX-3). La primera es `proposal.titulo`; la última, el
 * cierre fijo. `items` = ítems accionables incluidos en el texto.
 *
 * @returns {{lines:string[], items:number, total:number}}
 */
function renderMessage(proposal, ctx = {}) {
    const rep = (ctx.report && typeof ctx.report === 'object') ? ctx.report : { skills: {}, precios: {}, ventana: {} };
    const subir = skillsPorVeredicto(rep, 'subir');
    const bajar = skillsPorVeredicto(rep, 'bajar');
    const precios = (rep.precios && typeof rep.precios === 'object') ? rep.precios : {};
    const hayPrecios = precios.stale === true || (Array.isArray(precios.missing_models) && precios.missing_models.length > 0);

    const todos = [
        ...subir.map((s) => () => lineaSubir(rep, s)),
        ...bajar.map((s) => () => lineaBajar(rep, s)),
        ...(hayPrecios ? [() => lineaPrecios(rep, ctx)] : []),
    ];
    const incluidos = todos.slice(0, MAX_ITEMS).map((f) => f());
    const restantes = todos.length - incluidos.length;

    const lines = [String(proposal && proposal.titulo)];
    lines.push(...incluidos);
    if (restantes > 0) lines.push(`y ${val(fmtInt(restantes))} más en el reporte completo`);
    if (ctx.propagationEnabled !== true && (subir.length || bajar.length)) lines.push(PROPAGATION_WARNING);
    const ventana = (rep.ventana && typeof rep.ventana === 'object') ? rep.ventana : {};
    const dias = Number.isFinite(ventana.dias) ? ventana.dias : 30;
    const hash8 = typeof ctx.hash8 === 'string' ? val(ctx.hash8) : val(String(ctx.hash || '').slice(0, 8));
    lines.push(`${FOOTER_PREFIX} ${FOOTER_CMD} --dias=${val(fmtInt(dias))} --hasta=${val(fmtDay(ventana.to))} · ref ${hash8}`);
    return { lines, items: incluidos.length, total: todos.length };
}

/** P6: controles + invisibles por línea, después redacción de secretos y datos sensibles. */
function sanitizeText(text) {
    const porLinea = String(text == null ? '' : text)
        .split('\n')
        .map((l) => l.replace(CONTROL_RE, '').replace(INVISIBLE_RE, ''))
        .join('\n');
    const sinSecretos = redact.redactSecretValue(porLinea);
    const out = redact.redactSensitive(typeof sinSecretos === 'string' ? sinSecretos : porLinea);
    return typeof out === 'string' ? out : porLinea;
}

/**
 * Corta ÍTEMS ENTEROS (líneas del medio, de atrás hacia adelante) hasta que el
 * texto entra en `max`; agrega `TRUNCATION_MARKER` antes del cierre. Título y
 * cierre quedan intactos.
 */
function truncateByItems(lines, max = MAX_CHARS) {
    const arr = Array.isArray(lines) ? lines.map(String) : [String(lines)];
    if (arr.join('\n').length <= max) return arr.join('\n');
    const head = arr[0];
    const tail = arr.length > 1 ? arr[arr.length - 1] : '';
    let middle = arr.slice(1, -1);
    const compose = () => [head, ...middle, TRUNCATION_MARKER, tail].join('\n');
    while (middle.length && compose().length > max) middle = middle.slice(0, -1);
    let out = compose();
    // Degeneración: título + marcador + cierre todavía no entran ⇒ tope duro.
    if (out.length > max) out = out.slice(0, max);
    return out;
}

/** P5 — SIEMPRE vía `write-target` (lint R1/R2); nunca `__dirname` ni `pipelineDir`. */
function defaultQueueDir() {
    const root = require('../write-target').writeDir(process.env, { canal: 'colas', destino: 'servicios/telegram/pendiente' });
    return path.join(root, 'servicios', 'telegram', 'pendiente');
}

function codeOf(x) {
    if (x && typeof x === 'object') {
        if (typeof x.code === 'string' && x.code) return x.code;
        if (x.audio_error && typeof x.audio_error.code === 'string') return x.audio_error.code;
        if (typeof x.audio_skip_reason === 'string') return x.audio_skip_reason;
    }
    return 'error';
}

/** CA-UX-4: narración del MISMO texto, fire-and-forget, fail-open sólo del audio. */
function lanzarAudio(text, ctx, deps, logger) {
    const cfgRoot = (ctx.cfgRoot && typeof ctx.cfgRoot === 'object') ? ctx.cfgRoot : {};
    const shouldEmit = typeof deps.shouldEmitAudio === 'function' ? deps.shouldEmitAudio : require('../audio-policy').shouldEmitAudio;
    if (!shouldEmit(cfgRoot.audio_policy, AUDIO_EVENT)) return { audio: 'no', audioTask: null };
    const gen = typeof deps.generateAudio === 'function'
        ? deps.generateAudio
        : require('../deliverable-notify').generateAudioNotifications;
    let task;
    try {
        task = Promise.resolve(gen({
            issue: 0,
            skill: SKILL_NAME,
            fase: 'cron',
            pipeline: 'pulpo',
            narrationText: text,
            contentHash: typeof ctx.hash8 === 'string' ? ctx.hash8 : null,
            config: cfgRoot.deliverable_notifications,
            pipelineRoot: ctx.pipelineRoot,
            deps: deps.audioDeps,
        }));
    } catch (e) {
        logger(`audio omitido (${codeOf(e)})`);
        return { audio: 'omitido', audioTask: null };
    }
    const settled = task.then((patch) => {
        if (patch && (patch.audio_error || patch.audio_skipped === true)) {
            const code = codeOf(patch);
            logger(`audio omitido (${code})`);
            return { audio: 'omitido', code };
        }
        return { audio: 'enviado' };
    }, (e) => {
        const code = codeOf(e);
        logger(`audio omitido (${code})`);
        return { audio: 'omitido', code };
    });
    return { audio: 'pendiente', audioTask: settled };
}

/**
 * @param {object} proposal   salida de `proposal.buildProposal`
 * @param {object} ctx        `{ report, hash, hash8, propagationEnabled, cfgRoot, pipelineRoot, logger, now, deps }`
 * @returns {{ok:boolean, reason:string|null, file?:string, items:number, audio:'pendiente'|'omitido'|'no', audioTask:Promise|null}}
 */
function publish(proposal, ctx = {}) {
    const deps = (ctx.deps && typeof ctx.deps === 'object') ? ctx.deps : {};
    const logger = typeof ctx.logger === 'function' ? ctx.logger : () => {};
    const v = validateProposal(proposal);
    if (!v.ok) return { ok: false, reason: `propuesta_invalida:${v.reason}`, items: 0, audio: 'no', audioTask: null };

    const rendered = renderMessage(proposal, ctx);
    const sanitized = rendered.lines.map((l) => sanitizeText(l));
    const text = truncateByItems(sanitized, MAX_CHARS);
    const payload = { text, plain: true, disable_web_page_preview: true };

    const fsImpl = deps.fsImpl || require('fs');
    const dir = typeof deps.queueDir === 'string' && deps.queueDir ? deps.queueDir : defaultQueueDir();
    const writeDropfile = typeof deps.writeDropfile === 'function' ? deps.writeDropfile : require('../dropfile-writer').writeDropfileSync;
    let file;
    try {
        if (!fsImpl.existsSync(dir)) fsImpl.mkdirSync(dir, { recursive: true });
        const out = writeDropfile({
            dir, suffix: SUFFIX, data: JSON.stringify(payload), fsImpl,
            now: typeof deps.now === 'function' ? deps.now : undefined,
        });
        file = out && out.filePath;
    } catch (e) {
        logger(`dropfile no escrito (${codeOf(e)})`);
        return { ok: false, reason: 'dropfile_no_escrito', items: rendered.items, audio: 'no', audioTask: null };
    }

    const audio = lanzarAudio(text, ctx, deps, logger);
    return { ok: true, reason: 'publicado', file, items: rendered.items, audio: audio.audio, audioTask: audio.audioTask };
}

module.exports = {
    MAX_CHARS,
    MAX_ITEMS,
    SUFFIX,
    SKILL_NAME,
    AUDIO_EVENT,
    FOOTER_CMD,
    FOOTER_PREFIX,
    TRUNCATION_MARKER,
    PROPAGATION_WARNING,
    CONTROL_RE,
    renderMessage,
    sanitizeText,
    truncateByItems,
    defaultQueueDir,
    publish,
};

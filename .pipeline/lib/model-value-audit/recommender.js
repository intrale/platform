'use strict';

// =============================================================================
// model-value-audit / recommender — capa de decisión (#7519, parte 3 de #6793)
// =============================================================================
//
// Cruza la señal de calidad por skill (parte 2, `agent-quality-signal`) con el
// costo de ventana y la tabla de precios (parte 1) y emite POR SKILL uno de
// cinco veredictos cerrados con `evidencia` obligatoria. Es una tabla de reglas
// puras: la primera que aplica gana (CA-13), sin I/O, sin config global, sin
// archivos. Todo llega inyectado por `index.js`.
//
// Orden de reglas (CA-13, PR2 del PO):
//   (1) integridad rota           ⇒ no_evaluable / integridad_rota
//   (2) sin modelo observable     ⇒ no_evaluable / modelo_no_observado
//   (3) provider sin tabla        ⇒ no_evaluable / provider_sin_precios
//   (4) modelo sin clave de precio⇒ no_evaluable / modelo_sin_precio
//   (5) muestra chica             ⇒ sin_evidencia_suficiente / muestra_insuficiente
//   (6) skill protegido           ⇒ mantener / skill_protegido
//   (7) subir (no depende del costo, P4)
//   (8) bajar (exige TODO, CA-16)
//   (9) mantener
//
// Principios fail-closed:
//   - Métrica `null` no es cero (C7): nunca dispara `subir`, nunca habilita
//     `bajar`.
//   - "Modelo sin precio" es ausencia de CLAVE en `pricingByProvider()`, nunca
//     `getPricing` (devuelve precio cero para desconocidos, C4).
//   - Empates de precio por desigualdad estricta (C4 / PR5); empate de mayoría
//     de modelos ⇒ el más caro (C5).
//   - Ninguna cifra sale sin `Number.isFinite`; división por precio cero ⇒
//     `no_evaluable` / `precio_invalido`, jamás `NaN` serializado (S-4).
//   - Vocabulario cerrado (SEC-R1): `veredicto`, `motivo[]`, `alertas_calidad[]`,
//     `riesgo_estimado` y `advertencias[]` son códigos de los enums de abajo;
//     ningún string de salida se interpola con datos de entrada.
//   - `security` protegido SIEMPRE (piso en código, SEC-R8).
//
// Este módulo NO escribe nada, no ejecuta procesos y no abre red (CA-20).

/** Sección de `config.yaml` con umbrales y protegidos (llega con la parte 4). */
const CONFIG_SECTION = 'model_value_audit';

const VERDICT = Object.freeze({
    BAJAR: 'bajar',
    SUBIR: 'subir',
    MANTENER: 'mantener',
    SIN_EVIDENCIA: 'sin_evidencia_suficiente',
    NO_EVALUABLE: 'no_evaluable',
});

const MOTIVOS = Object.freeze([
    'integridad_rota', 'modelo_no_observado', 'modelo_sin_precio', 'provider_sin_precios',
    'precio_invalido', 'muestra_insuficiente', 'skill_protegido', 'rebound_alto', 'early_death_alto', 'qa_fail_alto',
    'ya_en_el_tope', 'ya_en_el_mas_barato', 'calidad_ok_costo_menor', 'costo_no_evaluable', 'metrica_no_medible',
    'modelos_mixtos', 'declarado_desconocido', 'propagacion_apagada',
]);

/** Alarmas de calidad (PR2): subconjunto de MOTIVOS, siempre calculadas. */
const ALERTAS = Object.freeze(['rebound_alto', 'early_death_alto', 'qa_fail_alto']);

const RIESGO = Object.freeze({
    NO_APLICA: 'no_aplica',
    NO_CUANTIFICABLE_SIN_OBSERVACION: 'no_cuantificable_sin_observacion',
    NO_MEDIDO_V1: 'no_medido_v1',
});

const ADVERTENCIAS = Object.freeze({
    PROPAGACION_APAGADA: 'propagacion_apagada',
});

const DEFAULTS = Object.freeze({
    min_sample: 10,
    protected_skills: Object.freeze(['security', 'review', 'tester', 'qa', 'po']),
    thresholds: Object.freeze({
        subir_rebound: 0.30,
        subir_early_death: 0.10,
        subir_qa_fail: 0.25,
        bajar_rebound: 0.05,
        bajar_early_death: 0.02,
    }),
});

/** Piso en código (SEC-R8): `security` está protegido aunque la config lo omita. */
const PROTECTED_FLOOR = Object.freeze(['security']);

/** Exactamente las 15 claves de `evidencia` (CA-14), ordenadas. */
const EVIDENCIA_KEYS = Object.freeze([
    'ahorro_mensual_estimado_usd', 'alertas_calidad', 'costo_filas_excluidas', 'costo_reproceso_usd',
    'costo_ventana_usd', 'difiere', 'modelo_declarado', 'modelo_destino', 'modelo_efectivo',
    'modelos_observados', 'motivo', 'n', 'no_observados', 'riesgo_estimado', 'ventana',
]);

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// -----------------------------------------------------------------------------
// Helpers puros
// -----------------------------------------------------------------------------

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);
/** `null`/`NaN` nunca dispara `subir` (C7). */
const ge = (v, t) => isFiniteNumber(v) && v >= t;
/** `null`/`NaN` nunca habilita `bajar` (C7). */
const le = (v, t) => isFiniteNumber(v) && v <= t;
const finiteOrNull = (v) => (isFiniteNumber(v) ? v : null);
const own = (obj, key) => obj != null && Object.prototype.hasOwnProperty.call(obj, key);

/** Precio de orden de una entrada de la tabla: `in + out`; NaN si no es válida. */
function price(entry) {
    return (entry && isFiniteNumber(entry.in) && isFiniteNumber(entry.out)) ? entry.in + entry.out : NaN;
}

function isStringArray(v) {
    return Array.isArray(v) && v.every((s) => typeof s === 'string');
}

/**
 * Lista efectiva de skills protegidos: `PROTECTED_FLOOR ∪ cfg.protected_skills`
 * si es array de strings; tipo inválido o ausente ⇒ defaults completos (CA-17).
 */
function resolveProtected(cfg) {
    const declared = cfg && own(cfg, 'protected_skills') ? cfg.protected_skills : undefined;
    const base = isStringArray(declared) ? declared : DEFAULTS.protected_skills;
    return new Set([...PROTECTED_FLOOR, ...base]);
}

function numberOr(v, fallback, { min = 0, max = Infinity } = {}) {
    return (isFiniteNumber(v) && v >= min && v <= max) ? v : fallback;
}

/** Umbrales y `min_sample` desde `config.model_value_audit`, con defaults congelados. */
function resolveThresholds(cfg) {
    const c = (cfg && typeof cfg === 'object') ? cfg : {};
    const t = (c.thresholds && typeof c.thresholds === 'object') ? c.thresholds : {};
    const d = DEFAULTS.thresholds;
    return {
        min_sample: numberOr(c.min_sample, DEFAULTS.min_sample, { min: 1 }),
        subir_rebound: numberOr(t.subir_rebound, d.subir_rebound, { max: 1 }),
        subir_early_death: numberOr(t.subir_early_death, d.subir_early_death, { max: 1 }),
        subir_qa_fail: numberOr(t.subir_qa_fail, d.subir_qa_fail, { max: 1 }),
        bajar_rebound: numberOr(t.bajar_rebound, d.bajar_rebound, { max: 1 }),
        bajar_early_death: numberOr(t.bajar_early_death, d.bajar_early_death, { max: 1 }),
    };
}

/**
 * Provider de la tabla de precios (C3): `alias[provider] ?? provider`. El alias
 * llega inyectado; el default es `HEALTH_PROVIDER_ALIAS` del hermano de
 * `multi-provider` (`{ 'openai-codex': 'openai' }`). Sin tabla nueva.
 */
/** Alias inyectado o el default del hermano (`{ 'openai-codex': 'openai' }`). */
function resolveAlias(providerAlias) {
    return (providerAlias && typeof providerAlias === 'object')
        ? providerAlias
        : require('../multi-provider/provider-contribution').HEALTH_PROVIDER_ALIAS;
}

function pricingProvider(provider, alias) {
    if (typeof provider !== 'string') return null;
    const a = (alias && typeof alias === 'object') ? alias : {};
    return own(a, provider) && typeof a[provider] === 'string' ? a[provider] : provider;
}

/**
 * Modelos de un provider ordenados por `in + out` ascendente y nombre
 * ascendente (PR5). `null` si el provider no tiene tabla (provider_sin_precios).
 * Las entradas con precio no finito se descartan del ranking.
 *
 * @returns {Array<{model:string, price:number}>|null}
 */
function rankModels(table, provider) {
    if (!table || typeof table !== 'object' || !own(table, provider) || !table[provider] || typeof table[provider] !== 'object') return null;
    const t = table[provider];
    return Object.keys(t)
        .map((model) => ({ model, price: price(t[model]) }))
        .filter((m) => Number.isFinite(m.price))
        .sort((a, b) => (a.price - b.price) || (a.model < b.model ? -1 : (a.model > b.model ? 1 : 0)));
}

/** Escalón inferior más cercano (precio ESTRICTAMENTE menor); empate ⇒ nombre asc. */
function stepDown(ranked, actual) {
    const lower = ranked.filter((m) => m.price < actual);
    if (!lower.length) return null;
    const maxPrice = lower[lower.length - 1].price;
    return lower.find((m) => m.price === maxPrice) || null;
}

/** Escalón superior más cercano (precio ESTRICTAMENTE mayor); empate ⇒ nombre asc. */
function stepUp(ranked, actual) {
    return ranked.find((m) => m.price > actual) || null;
}

/**
 * Modelo efectivo mayoritario (C5) sobre filas `{ provider, model_effective }`
 * ya validadas. Empate ⇒ el de mayor `in + out` (fail-closed: nunca se sugiere
 * bajar desde un modelo que quizá no corrió); precio desconocido cuenta como el
 * más caro; último desempate por nombre ascendente.
 *
 * @param {Array<{provider:string, model_effective:string|null}>} rows
 * @param {(provider:string, model:string)=>number} [priceOf]  precio de orden (NaN si no hay)
 * @returns {{ key:string|null, provider:string|null, model:string|null, observados:object, no_observados:number, mixtos:boolean }}
 */
function pickMajority(rows, priceOf) {
    const counts = Object.create(null);
    let noObservados = 0;
    for (const r of Array.isArray(rows) ? rows : []) {
        if (!r || r.model_effective == null) { noObservados++; continue; }
        const key = `${r.provider}|${r.model_effective}`;
        counts[key] = (counts[key] || 0) + 1;
    }
    const keys = Object.keys(counts);
    if (!keys.length) {
        return { key: null, provider: null, model: null, observados: {}, no_observados: noObservados, mixtos: false };
    }
    const priceOfKey = (k) => {
        if (typeof priceOf !== 'function') return NaN;
        const i = k.indexOf('|');
        return priceOf(k.slice(0, i), k.slice(i + 1));
    };
    keys.sort((a, b) => {
        if (counts[b] !== counts[a]) return counts[b] - counts[a];
        const pa = priceOfKey(a), pb = priceOfKey(b);
        const ra = Number.isFinite(pa) ? pa : Infinity;
        const rb = Number.isFinite(pb) ? pb : Infinity;
        if (ra !== rb) return rb - ra;
        return a < b ? -1 : 1;
    });
    const key = keys[0];
    const i = key.indexOf('|');
    return {
        key,
        provider: key.slice(0, i),
        model: key.slice(i + 1),
        observados: { ...counts },
        no_observados: noObservados,
        mixtos: keys.length > 1,
    };
}

/**
 * Modelo declarado (C6): `skills[skill].model_override ?? providers[skills[skill].provider].model ?? null`.
 * Skill ausente ⇒ `null` (motivo `declarado_desconocido`).
 */
function declaredModel(agentModels, skill) {
    const skills = agentModels && agentModels.skills;
    if (!skills || typeof skills !== 'object' || !own(skills, skill) || !skills[skill] || typeof skills[skill] !== 'object') return null;
    const s = skills[skill];
    if (typeof s.model_override === 'string' && s.model_override) return s.model_override;
    const providers = agentModels.providers;
    if (typeof s.provider === 'string' && providers && own(providers, s.provider) && providers[s.provider]
        && typeof providers[s.provider].model === 'string' && providers[s.provider].model) {
        return providers[s.provider].model;
    }
    return null;
}

/** Alarmas de calidad (PR2): siempre, con los umbrales de `subir`, null-safe. */
function qualityAlerts(q, th) {
    const out = [];
    if (ge(q.reboundRate, th.subir_rebound)) out.push('rebound_alto');
    if (ge(q.earlyDeathRate, th.subir_early_death)) out.push('early_death_alto');
    if (ge(q.qaFailRate, th.subir_qa_fail)) out.push('qa_fail_alto');
    return out;
}

// -----------------------------------------------------------------------------
// Tabla de reglas (CA-13): la primera que devuelve un veredicto gana.
// -----------------------------------------------------------------------------

const RULES = [
    (c) => (!c.q.integrity || c.q.integrity.spawn_exit !== 'verificada')
        ? { v: VERDICT.NO_EVALUABLE, m: ['integridad_rota'] } : null,
    (c) => c.efectivo == null ? { v: VERDICT.NO_EVALUABLE, m: ['modelo_no_observado'] } : null,
    (c) => c.ranked == null ? { v: VERDICT.NO_EVALUABLE, m: ['provider_sin_precios'] } : null,
    (c) => !c.priced ? { v: VERDICT.NO_EVALUABLE, m: ['modelo_sin_precio'] } : null,
    // Clave presente pero precio no finito: nunca se ordena ni se divide (S-4).
    (c) => !isFiniteNumber(c.precioActual) ? { v: VERDICT.NO_EVALUABLE, m: ['precio_invalido'] } : null,
    (c) => c.q.sample_ok !== true ? { v: VERDICT.SIN_EVIDENCIA, m: ['muestra_insuficiente'] } : null,
    (c) => c.protegido ? { v: VERDICT.MANTENER, m: ['skill_protegido'] } : null,
    (c) => {
        // subir — no depende del costo (P4). Una métrica null nunca dispara (C7).
        if (!c.alertas.length) return null;
        return c.masCaro
            ? { v: VERDICT.SUBIR, m: [...c.alertas], destino: c.masCaro.model }
            : { v: VERDICT.MANTENER, m: [...c.alertas, 'ya_en_el_tope'] };
    },
    (c) => {
        // bajar — exige TODO (CA-16). Sin escalón inferior no hay nada que bajar,
        // se evalúa antes que el costo (C9: `deterministic` nunca sale
        // `costo_no_evaluable`) y antes que las métricas.
        if (!c.masBarato) return { v: VERDICT.MANTENER, m: ['ya_en_el_mas_barato'] };
        if (c.precioActual <= 0) return { v: VERDICT.NO_EVALUABLE, m: ['precio_invalido'] };
        if (c.q.reboundRate === null || c.q.earlyDeathRate === null || c.q.qaFailRate === null
            || c.q.reboundRate === undefined || c.q.earlyDeathRate === undefined || c.q.qaFailRate === undefined) {
            return { v: VERDICT.MANTENER, m: ['metrica_no_medible'] };
        }
        const calidadOk = le(c.q.reboundRate, c.th.bajar_rebound)
            && le(c.q.earlyDeathRate, c.th.bajar_early_death)
            && c.q.qaFailRate === 0;
        if (!calidadOk) return null;
        if (!c.costEvaluable) return { v: VERDICT.MANTENER, m: ['costo_no_evaluable'] };
        return { v: VERDICT.BAJAR, m: ['calidad_ok_costo_menor'], destino: c.masBarato.model };
    },
    () => ({ v: VERDICT.MANTENER, m: [] }),
];

function decide(ctx) {
    for (const rule of RULES) {
        const out = rule(ctx);
        if (out) return out;
    }
    /* istanbul ignore next — la última regla siempre devuelve */
    return { v: VERDICT.MANTENER, m: [] };
}

// -----------------------------------------------------------------------------
// recommend
// -----------------------------------------------------------------------------

function setOwn(obj, key, value) {
    Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

function toIso(ms) {
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * @param {object} p
 * @param {object} p.quality            salida de `agent-quality-signal.compute`
 * @param {object} p.cost               parte 1: `{ evaluable, reason, rows[] }`
 * @param {object[]} p.models           parte 1: filas `{ skill, provider, model_effective|null }`
 * @param {object} p.pricingFreshness   parte 1 (sólo se propaga; no decide)
 * @param {object} p.pricing            `{ pricingByProvider() }`
 * @param {object} p.agentModels        JSON ya parseado de agent-models.json
 * @param {object} p.config             `config.model_value_audit || {}`
 * @param {boolean} p.propagationEnabled
 * @param {Set<string>} p.allowedSkills
 * @param {Set<string>} p.allowedProviders
 * @param {object} [p.providerAlias]
 * @param {{from:number,to:number,dias:number}} p.ventana
 * @returns {{ skills: object, advertencias: string[], desconocidos: object, umbrales: object }}
 */
function recommend({
    quality, cost, models, pricing, agentModels, config, propagationEnabled,
    allowedSkills, allowedProviders, providerAlias, ventana,
} = {}) {
    const th = resolveThresholds(config);
    const protegidos = resolveProtected(config);
    const alias = resolveAlias(providerAlias);
    const skillsOk = allowedSkills instanceof Set ? allowedSkills : new Set(Array.isArray(allowedSkills) ? allowedSkills : []);
    const providersOk = allowedProviders instanceof Set ? allowedProviders : new Set(Array.isArray(allowedProviders) ? allowedProviders : []);
    const { safeModel } = require('./sanitize');

    let table = {};
    try { table = (pricing && typeof pricing.pricingByProvider === 'function') ? (pricing.pricingByProvider() || {}) : {}; } catch { table = {}; }
    const priceOf = (provider, model) => {
        const p = pricingProvider(provider, alias);
        const t = (p && own(table, p) && table[p]) ? table[p] : null;
        return (t && own(t, model)) ? price(t[model]) : NaN;
    };

    const costEvaluable = !!(cost && cost.evaluable === true);
    const costRows = (cost && Array.isArray(cost.rows)) ? cost.rows : [];
    const propagation = propagationEnabled === true;
    const desconocidos = { skills: 0, providers: 0, models: 0 };
    const win = ventana || {};
    const dias = numberOr(win.dias, 30, { min: 1 });
    const ventanaOut = { from: toIso(win.from), to: toIso(win.to), dias };

    // Filas de modelo efectivo agrupadas por skill, re-validadas (CA-18b).
    const modelRowsBySkill = Object.create(null);
    for (const r of Array.isArray(models) ? models : []) {
        if (!r || typeof r !== 'object') continue;
        if (typeof r.skill !== 'string' || !skillsOk.has(r.skill)) { desconocidos.skills++; continue; }
        if (typeof r.provider !== 'string' || !providersOk.has(r.provider)) { desconocidos.providers++; continue; }
        let model = null;
        if (r.model_effective != null) {
            if (typeof r.model_effective !== 'string' || safeModel(r.model_effective) !== r.model_effective) { desconocidos.models++; continue; }
            model = r.model_effective;
        }
        if (!own(modelRowsBySkill, r.skill)) setOwn(modelRowsBySkill, r.skill, []);
        modelRowsBySkill[r.skill].push({ provider: r.provider, model_effective: model });
    }

    const skillsOut = Object.create(null);
    const qSkills = (quality && quality.skills && typeof quality.skills === 'object') ? quality.skills : {};
    for (const skill of Object.keys(qSkills)) {
        if (!skillsOk.has(skill)) { desconocidos.skills++; continue; }
        const q = qSkills[skill] || {};
        const mayoria = pickMajority(own(modelRowsBySkill, skill) ? modelRowsBySkill[skill] : [], priceOf);
        const efectivo = mayoria.model;
        const providerRaw = mayoria.provider;
        const providerPrecios = pricingProvider(providerRaw, alias);
        const ranked = efectivo != null ? rankModels(table, providerPrecios) : null;
        // "Sin precio" = ausencia de CLAVE (C4), nunca `getPricing`.
        const entry = (ranked && own(table[providerPrecios], efectivo)) ? table[providerPrecios][efectivo] : null;
        const priced = !!(ranked && entry);
        const precioActual = priced ? price(entry) : NaN;
        const masBarato = isFiniteNumber(precioActual) ? stepDown(ranked, precioActual) : null;
        const masCaro = isFiniteNumber(precioActual) ? stepUp(ranked, precioActual) : null;
        const alertas = qualityAlerts(q, th);
        const declarado = declaredModel(agentModels, skill);
        const enAgentModels = !!(agentModels && agentModels.skills && own(agentModels.skills, skill));

        // Costo de ventana (C8): sólo filas del skill con el provider mayoritario,
        // priceadas con el modelo efectivo; `tokens_in/out` únicamente (cache: #7506).
        let costoVentana = null;
        let excluidas = 0;
        if (costEvaluable) {
            let tin = 0, tout = 0, hay = false;
            for (const r of costRows) {
                if (!r || r.skill !== skill) continue;
                if (r.provider !== providerRaw) { excluidas++; continue; }
                hay = true;
                if (isFiniteNumber(r.tokens_in)) tin += r.tokens_in;
                if (isFiniteNumber(r.tokens_out)) tout += r.tokens_out;
            }
            if (hay && priced && isFiniteNumber(entry.in) && isFiniteNumber(entry.out)) {
                costoVentana = finiteOrNull((tin * entry.in + tout * entry.out) / 1e6);
            }
        }

        const ctx = {
            q, th, efectivo, ranked, priced, precioActual,
            masBarato, masCaro, alertas, costEvaluable,
            protegido: protegidos.has(skill),
        };
        let out = decide(ctx);
        let veredicto = out.v;
        const motivo = [...out.m];
        let destino = out.destino || null;

        let ahorro = null;
        let reproceso = null;
        if (veredicto === VERDICT.BAJAR) {
            const precioDestino = masBarato ? masBarato.price : NaN;
            if (costEvaluable && isFiniteNumber(costoVentana) && isFiniteNumber(precioActual) && precioActual > 0 && isFiniteNumber(precioDestino)) {
                ahorro = finiteOrNull(costoVentana * (1 - precioDestino / precioActual) * 30 / dias);
            }
            if (!propagation) motivo.push('propagacion_apagada');
        }
        if (veredicto === VERDICT.SUBIR && costEvaluable && isFiniteNumber(costoVentana) && isFiniteNumber(q.reboundRate)) {
            reproceso = finiteOrNull(costoVentana * q.reboundRate * 30 / dias);
        }
        if (mayoria.mixtos) motivo.push('modelos_mixtos');
        if (!enAgentModels) motivo.push('declarado_desconocido');

        // S-4: una cifra no finita jamás sale como `null` silencioso.
        const cifras = [costoVentana, ahorro, reproceso];
        if (cifras.some((v) => v !== null && !isFiniteNumber(v))) {
            veredicto = VERDICT.NO_EVALUABLE;
            motivo.length = 0;
            motivo.push('precio_invalido');
            destino = null;
            ahorro = null;
            reproceso = null;
            costoVentana = null;
        }

        const riesgo = veredicto === VERDICT.BAJAR
            ? (propagation ? RIESGO.NO_MEDIDO_V1 : RIESGO.NO_CUANTIFICABLE_SIN_OBSERVACION)
            : RIESGO.NO_APLICA;

        const evidencia = {
            ahorro_mensual_estimado_usd: finiteOrNull(ahorro),
            alertas_calidad: alertas,
            costo_filas_excluidas: excluidas,
            costo_reproceso_usd: finiteOrNull(reproceso),
            costo_ventana_usd: finiteOrNull(costoVentana),
            difiere: declarado != null && efectivo != null && declarado !== efectivo,
            modelo_declarado: declarado,
            modelo_destino: destino,
            modelo_efectivo: efectivo,
            modelos_observados: mayoria.observados,
            motivo: motivo.filter((m) => MOTIVOS.includes(m)),
            n: isFiniteNumber(q.n) ? q.n : 0,
            no_observados: mayoria.no_observados,
            riesgo_estimado: riesgo,
            ventana: ventanaOut,
        };
        setOwn(skillsOut, skill, { veredicto, evidencia });
    }

    const advertencias = [];
    if (!propagation) advertencias.push(ADVERTENCIAS.PROPAGACION_APAGADA);

    return {
        skills: skillsOut,
        advertencias,
        desconocidos,
        umbrales: {
            min_sample: th.min_sample,
            thresholds: {
                subir_rebound: th.subir_rebound,
                subir_early_death: th.subir_early_death,
                subir_qa_fail: th.subir_qa_fail,
                bajar_rebound: th.bajar_rebound,
                bajar_early_death: th.bajar_early_death,
            },
            protected_skills: [...protegidos].sort(),
        },
    };
}

module.exports = {
    CONFIG_SECTION,
    VERDICT,
    MOTIVOS,
    ALERTAS,
    RIESGO,
    ADVERTENCIAS,
    DEFAULTS,
    PROTECTED_FLOOR,
    EVIDENCIA_KEYS,
    MS_PER_DAY,
    resolveProtected,
    resolveThresholds,
    resolveAlias,
    pricingProvider,
    rankModels,
    stepDown,
    stepUp,
    pickMajority,
    declaredModel,
    qualityAlerts,
    recommend,
};

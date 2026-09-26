// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// =============================================================================
// model-value-… / index — orquestación PURA de la corrida (#7519, CA-I1)
// =============================================================================
//
// `runAudit({ pipelineDir, dias, hasta, deps })` encadena:
//
//   config-resolver → pricing.invalidateCache() → agent-models.json (UNA lectura,
//   sha256 de esos mismos bytes, SEC-R4) → readSources (parte 1) → sanitizeRows
//   (parte 1) → pricing-freshness (parte 1) → agent-quality-signal (parte 2) →
//   recommender → report.buildReport
//
// Sin escrituras: este módulo no conoce el trail encadenado (C16); la única
// escritura del sistema vive en `scripts/model-value-report.js --registrar`.
//
// Los hermanos se requieren PEREZOSAMENTE dentro de `runAudit` y son
// sobreescribibles por `deps` (`readSources`, `sanitize`, `pricingFreshness`,
// `qualitySignal`, `reboundSince`), para testear la orquestación con fakes.
//
// Puente entre partes (verificado en HEAD): la parte 1 emite `ts` como epoch
// ms y la parte 2 hace `Date.parse(ts)` (NaN sobre un número ⇒ toda fila
// descartada). Acá se convierte `ts` a ISO antes de `compute`.
//
// Sólo `require` de `fs`, `path`, `crypto` y rutas relativas dentro de `lib/`.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MIN_DIAS = 30;

const ESTADO_VERIFICADA = 'verificada';
const ESTADO_NO_VERIFICADA = 'no_verificada';
const ESTADO_ROTA = 'rota';

function isoOf(ms) {
    return new Date(ms).toISOString();
}

/** Copia de la fila con `ts` en ISO (puente parte 1 → parte 2). */
function conTsIso(rows) {
    const out = [];
    for (const r of Array.isArray(rows) ? rows : []) {
        if (!r || typeof r !== 'object') continue;
        const ts = typeof r.ts === 'number' ? r.ts : Date.parse(r.ts);
        if (!Number.isFinite(ts)) continue;
        out.push({ ...r, ts: isoOf(ts) });
    }
    return out;
}

function sumar(desconocidos, extra) {
    for (const k of Object.keys(extra || {})) {
        desconocidos[k] = (desconocidos[k] || 0) + (Number.isFinite(extra[k]) ? extra[k] : 0);
    }
}

function limpiar(sanitize, fuente, whitelists, desconocidos) {
    const rows = (fuente && Array.isArray(fuente.rows)) ? fuente.rows : [];
    const r = sanitize.sanitizeRows(rows, whitelists);
    sumar(desconocidos, r.desconocidos);
    return r.rows;
}

function brokenDe(fuente) {
    const b = fuente && fuente.integridad && fuente.integridad.broken;
    return Array.isArray(b) ? b.length : 0;
}

/**
 * @param {object} p
 * @param {string} p.pipelineDir
 * @param {number} [p.dias=30]      mínimo 30 (se eleva con `Math.max`)
 * @param {string} [p.hasta]        `YYYY-MM-DD` (fin de ventana, 23:59:59.999Z)
 * @param {object} [p.deps]
 * @returns {object} reporte canónico (ver `report.buildReport`)
 */
function runAudit({ pipelineDir, dias = MIN_DIAS, hasta, deps = {} } = {}) {
    if (!pipelineDir || typeof pipelineDir !== 'string') throw new Error('[model-value-report] pipelineDir requerido');
    const fsImpl = deps.fsImpl || fs;
    const now = typeof deps.now === 'function' ? deps.now : Date.now;
    const pricing = deps.pricing || require('../pricing');
    const resolver = deps.configResolver || require('../config-resolver');
    const readSources = deps.readSources || require('./read-sources').readSources;
    const sanitize = deps.sanitize || require('./sanitize');
    const freshness = deps.pricingFreshness || require('./pricing-freshness');
    const quality = deps.qualitySignal || require('./agent-quality-signal');
    const recommender = deps.recommender || require('./recommender');
    const report = deps.report || require('./report');

    const root = path.resolve(pipelineDir);

    // 1. Config por el único lector canónico. Lanza ⇒ propaga (fail-closed).
    const config = resolver.resolve({ pipelineDir: root, reload: true });
    const seccion = config ? config[recommender.CONFIG_SECTION] : undefined;
    const cfg = (seccion && typeof seccion === 'object') ? seccion : {};
    // C10 / S-5: sólo el booleano `true` enciende; cualquier otro valor ⇒ apagado.
    const propagationEnabled = !!(config && config.pipeline && config.pipeline.model_propagation
        && config.pipeline.model_propagation.enabled === true);
    const devSkills = (config && config.pipelines && config.pipelines.desarrollo
        && config.pipelines.desarrollo.skills_por_fase && Array.isArray(config.pipelines.desarrollo.skills_por_fase.dev))
        ? config.pipelines.desarrollo.skills_por_fase.dev : [];

    // 2. Ventana: `dias` mínimo 30 (CA-I1), `hasta` inclusivo hasta fin de día UTC.
    const diasEfectivos = Math.max(MIN_DIAS, Number.isFinite(Number(dias)) ? Math.floor(Number(dias)) : MIN_DIAS);
    let to;
    if (hasta) {
        to = Date.parse(`${hasta}T23:59:59.999Z`);
        if (!Number.isFinite(to)) throw new Error(`[model-value-report] --hasta invalido: ${JSON.stringify(String(hasta))}`);
    } else {
        to = now();
    }
    const from = to - diasEfectivos * MS_PER_DAY;

    // 3. Precios: caché invalidada UNA vez por corrida.
    pricing.invalidateCache();

    // 4. agent-models.json: una sola lectura; el hash es de esos mismos bytes (SEC-R4).
    const amPath = path.join(root, 'agent-models.json');
    const amBytes = fsImpl.readFileSync(amPath);
    const agentModelsSha256 = crypto.createHash('sha256').update(amBytes).digest('hex');
    let agentModels;
    try {
        agentModels = JSON.parse(Buffer.isBuffer(amBytes) ? amBytes.toString('utf8') : String(amBytes));
    } catch (err) {
        throw new Error(`[model-value-report] agent-models.json no parsea: ${err.message}`);
    }
    if (!agentModels || typeof agentModels !== 'object') throw new Error('[model-value-report] agent-models.json no es un objeto');

    // 5. Fuentes (parte 1). Los puertos opcionales (`fsImpl`, verificador de
    //    cadena, `effectiveModel`) se reenvían tal cual desde `deps`.
    const sources = readSources({ ...deps, pipelineDir: root, from, to, fsImpl });

    // 6. Whitelists + sanitización (parte 1).
    const whitelists = {
        skills: sanitize.allowedSkills(config),
        providers: sanitize.allowedProviders(agentModels),
        phases: sanitize.allowedPhases(config),
    };
    const desconocidos = {};
    const spawns = limpiar(sanitize, sources.spawn_exit, whitelists, desconocidos);
    const rebounds = limpiar(sanitize, sources.rebound_events, whitelists, desconocidos);
    const models = limpiar(sanitize, sources.effective_model, whitelists, desconocidos);
    const costRows = limpiar(sanitize, sources.provider_cost, whitelists, desconocidos);
    const qaRows = limpiar(sanitize, sources.label_mutations, whitelists, desconocidos);

    // 7. Precios: antigüedad + modelos observados sin precio (parte 1). El
    //    provider se pasa ya resuelto por alias (C3) para que `missing_models`
    //    consulte la misma tabla que el recommender.
    const alias = recommender.resolveAlias(deps.providerAlias);
    const observed = new Map();
    for (const r of models) {
        if (r.model_effective == null) continue;
        const provider = recommender.pricingProvider(r.provider, alias);
        const key = `${provider}|${r.model_effective}`;
        const cur = observed.get(key) || { provider, model: r.model_effective, n: 0 };
        cur.n++;
        observed.set(key, cur);
    }
    const fresh = freshness.evaluate({
        pricing, fsImpl, now: now(), observedModels: [...observed.values()],
        maxAgeDays: Number.isFinite(cfg.pricing_max_age_days) ? cfg.pricing_max_age_days : undefined,
    });

    // 8. Señal de calidad (parte 2). Integridad recibida, nunca relajada: un
    //    archivo con cadena rota en la ventana ⇒ señal rota.
    const spawnIntegridad = (sources.spawn_exit && sources.spawn_exit.evaluable !== false && brokenDe(sources.spawn_exit) === 0)
        ? ESTADO_VERIFICADA : ESTADO_ROTA;
    let reboundSince = null;
    if (typeof deps.reboundSince === 'function') reboundSince = deps.reboundSince(root, fsImpl);
    else if (typeof deps.reboundSince === 'string') reboundSince = deps.reboundSince;
    else reboundSince = require('../model-propagation-rollout').reboundSince(root, fsImpl);
    const umbrales = recommender.resolveThresholds(cfg);
    const q = quality.compute({
        spawns: conTsIso(spawns),
        rebounds: conTsIso(rebounds),
        qaFailures: conTsIso(qaRows),
        integrity: { spawn_exit: spawnIntegridad },
        devSkills,
        from: isoOf(from),
        reboundSince,
        earlyDeathMs: Number.isFinite(cfg.early_death_ms) ? cfg.early_death_ms : undefined,
        minSample: umbrales.min_sample,
    });

    // 9. Recomendación.
    const costEvaluable = !!(sources.provider_cost && sources.provider_cost.evaluable === true);
    const verdicts = recommender.recommend({
        quality: q,
        cost: { evaluable: costEvaluable, reason: (sources.provider_cost && sources.provider_cost.reason) || null, rows: costRows },
        models,
        pricingFreshness: fresh,
        pricing,
        agentModels,
        config: cfg,
        propagationEnabled,
        allowedSkills: whitelists.skills,
        allowedProviders: whitelists.providers,
        providerAlias: alias,
        ventana: { from, to, dias: diasEfectivos },
    });
    // Descartes de la sanitización (parte 1) + re-validación del recommender.
    sumar(desconocidos, verdicts.desconocidos);
    verdicts.desconocidos = desconocidos;

    // 10. Reporte canónico.
    const integridad = {
        spawn_exit: spawnIntegridad,
        rebound_events: ESTADO_NO_VERIFICADA,
        label_mutations: ESTADO_NO_VERIFICADA,
        provider_cost: ESTADO_NO_VERIFICADA,
        effective_model: ESTADO_NO_VERIFICADA,
        broken_files: ['spawn_exit', 'rebound_events', 'effective_model', 'provider_cost', 'label_mutations']
            .reduce((acc, k) => acc + brokenDe(sources[k]), 0),
        rebound_measurable: q.reboundMeasurable === true,
        cost_evaluable: costEvaluable,
        cost_reason: (sources.provider_cost && typeof sources.provider_cost.reason === 'string') ? sources.provider_cost.reason : null,
    };
    return report.buildReport({
        verdicts,
        quality: q,
        freshness: fresh,
        ventana: { from, to, dias: diasEfectivos },
        integridad,
        propagationEnabled,
        agentModelsSha256,
        generatedAt: now(),
    });
}

module.exports = { runAudit, MIN_DIAS, MS_PER_DAY };

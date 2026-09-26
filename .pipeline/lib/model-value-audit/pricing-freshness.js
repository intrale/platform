// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// =============================================================================
// model-value-audit / pricing-freshness — antigüedad de la tabla de precios
// =============================================================================
//
// Hallazgo del día 1 (#7517): la tabla de precios (`version: 1`,
// `updated_at: 2026-05-08`) tiene ~4 meses y no contiene `claude-opus-5`, el
// único modelo observable que hoy corre. Este módulo lo dice con datos:
//
//   { version, updated_at, age_days, stale, motivo, missing_models, sha256, source_kind }
//
// Reglas (receta A4 / CA-1…CA-4 / CA-10):
//   - Los precios se leen EXCLUSIVAMENTE vía `lib/pricing.js` (`invalidateCache`,
//     `load`, `pricingMeta`, `pricingByProvider`, `pricingFilePath`). Sin parser
//     propio (SEC-2). `invalidateCache()` exactamente una vez por corrida, antes
//     de `load()`.
//   - `sha256` = hash de los BYTES del archivo que `pricingFilePath()` señala.
//     Si no se puede leer ⇒ `sha256: null` y la tabla se considera fallback.
//     Nunca se hashea el fallback en memoria como si fuera el archivo (SEC-2b).
//   - `stale` ⇔ `motivo !== null`, con prioridad
//     `pricing_json_ausente_o_invalido` > `updated_at_invalido` > `antiguedad`.
//   - `missing_models` NO usa `getPricing` (devuelve precio cero tanto para un
//     modelo ausente como para `deterministic`): se consulta
//     `pricingByProvider()` con `hasOwnProperty`. Provider sin tabla ⇒ missing.
//     `model: null` se excluye. Salida ordenada por `n` descendente (CA-UX-10).
//
// Este módulo NO escribe nada, no ejecuta procesos y no abre red (CA-20).

const fs = require('fs');
const crypto = require('crypto');

const DEFAULT_MAX_AGE_DAYS = 60;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Vocabulario cerrado (CA-13).
const MOTIVO = Object.freeze({
    PRICING_JSON_AUSENTE_O_INVALIDO: 'pricing_json_ausente_o_invalido',
    UPDATED_AT_INVALIDO: 'updated_at_invalido',
    ANTIGUEDAD: 'antiguedad',
});

const SOURCE_KIND = Object.freeze({
    JSON: 'json',
    FALLBACK: 'fallback',
});

function hashFile(pricing, fsImpl) {
    try {
        const bytes = fsImpl.readFileSync(pricing.pricingFilePath());
        return crypto.createHash('sha256').update(bytes).digest('hex');
    } catch {
        return null;
    }
}

/** Normaliza `observedModels` a `[{provider, model, n}]` sin nulos ni basura. */
function normalizeObserved(observedModels) {
    const out = [];
    for (const o of Array.isArray(observedModels) ? observedModels : []) {
        if (!o || typeof o !== 'object') continue;
        if (o.model == null || typeof o.provider !== 'string') continue;
        const n = Number(o.n);
        out.push({ provider: o.provider, model: String(o.model), n: Number.isFinite(n) ? n : 0 });
    }
    return out;
}

/** Orden por `n` descendente; desempate estable por provider y model. */
function porNDesc(a, b) {
    if (b.n !== a.n) return b.n - a.n;
    if (a.provider !== b.provider) return a.provider < b.provider ? -1 : 1;
    if (a.model !== b.model) return a.model < b.model ? -1 : 1;
    return 0;
}

/**
 * @param {object} opts
 * @param {object} [opts.pricing]          puerto a `lib/pricing.js` (inyectable)
 * @param {object} [opts.fsImpl]           fs inyectable (sólo `readFileSync`)
 * @param {number} [opts.now]              epoch ms
 * @param {Array<{provider:string,model:string|null,n:number}>} [opts.observedModels]
 * @param {number} [opts.maxAgeDays=60]
 */
function evaluate({ pricing, fsImpl = fs, now = Date.now(), observedModels = [], maxAgeDays = DEFAULT_MAX_AGE_DAYS } = {}) {
    const _pricing = pricing || require('../pricing');

    _pricing.invalidateCache();
    _pricing.load();
    const meta = _pricing.pricingMeta() || {};

    const sha256 = hashFile(_pricing, fsImpl);
    const source_kind = (meta.source_kind === SOURCE_KIND.JSON && sha256) ? SOURCE_KIND.JSON : SOURCE_KIND.FALLBACK;

    const updatedMs = typeof meta.updated_at === 'string' || typeof meta.updated_at === 'number'
        ? Date.parse(meta.updated_at)
        : NaN;
    const age_days = Number.isFinite(updatedMs) ? Math.floor((now - updatedMs) / MS_PER_DAY) : null;

    const _maxAge = Number.isFinite(Number(maxAgeDays)) ? Number(maxAgeDays) : DEFAULT_MAX_AGE_DAYS;
    let motivo = null;
    if (source_kind === SOURCE_KIND.FALLBACK) motivo = MOTIVO.PRICING_JSON_AUSENTE_O_INVALIDO;
    else if (age_days == null) motivo = MOTIVO.UPDATED_AT_INVALIDO;
    else if (age_days > _maxAge) motivo = MOTIVO.ANTIGUEDAD;

    let table = {};
    try { table = _pricing.pricingByProvider() || {}; } catch { table = {}; }
    const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
    const missing_models = normalizeObserved(observedModels)
        .filter((o) => !(own(table, o.provider) && table[o.provider] && own(table[o.provider], o.model)))
        .sort(porNDesc);

    return {
        version: meta.version === undefined ? null : meta.version,
        updated_at: meta.updated_at === undefined ? null : meta.updated_at,
        age_days,
        stale: motivo !== null,
        motivo,
        missing_models,
        sha256: source_kind === SOURCE_KIND.FALLBACK ? null : sha256,
        source_kind,
        max_age_days: _maxAge,
    };
}

module.exports = {
    DEFAULT_MAX_AGE_DAYS,
    MOTIVO,
    SOURCE_KIND,
    evaluate,
};

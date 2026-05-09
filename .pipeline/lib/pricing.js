// Pricing cross-provider — loader del JSON externalizado para multi-provider (#3091).
//
// Contrato:
//   - Lee `.pipeline/metrics/pricing.json` (path FIJO, sin override por env/CLI/input).
//   - Valida schema (allowlist de providers, regex de modelos, numéricos finitos no-negativos).
//   - Cae a la tabla hardcoded `FALLBACK_PRICING` si el JSON no existe / está corrupto / falla validación.
//   - NO hace fetch HTTP, NO leer API keys, NO watch de filesystem.
//   - Sanitiza `provider` y `model` antes de usar como key (anti path-traversal).
//
// Consumido por `lib/traceability.js#estimateCostUsd` y por `metrics/aggregator.js`
// para exponer `snapshot.pricing` (flat back-compat) y `snapshot.pricing_by_provider` (#2891 → #3090).

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Allowlist hardcoded de providers — NO permitir nada fuera de esta lista (security #2).
const PROVIDER_ALLOWLIST = new Set(['anthropic', 'openai', 'google', 'deterministic']);

// Regex defensivo para keys de modelo — minúsculas, dígitos, `_:.-`, máx 64 chars (security #5).
const SAFE_KEY_RE = /^[a-z0-9_:.-]{1,64}$/;

// Tabla de fallback hardcoded — preserva la regresión cero del dashboard (#2891) cuando el
// JSON externalizado falla. Idéntica a la histórica de `traceability.js` previa al refactor.
const FALLBACK_PRICING = {
    anthropic: {
        'claude-opus-4-7':   { in: 15.00, out: 75.00, cache_read: 1.50,  cache_write: 18.75 },
        'claude-opus-4-6':   { in: 15.00, out: 75.00, cache_read: 1.50,  cache_write: 18.75 },
        'claude-sonnet-4-6': { in:  3.00, out: 15.00, cache_read: 0.30,  cache_write:  3.75 },
        'claude-haiku-4-5':  { in:  1.00, out:  5.00, cache_read: 0.10,  cache_write:  1.25 },
    },
    deterministic: {
        'deterministic':     { in:  0.00, out:  0.00, cache_read: 0.00,  cache_write:  0.00 },
    },
};

const FALLBACK_META = {
    version: 0,
    updated_at: null,
    source: 'fallback (lib/pricing.js#FALLBACK_PRICING)',
    providers_loaded: Object.keys(FALLBACK_PRICING),
    source_kind: 'fallback',
};

let _cache = null; // { table, meta, mtimeMs }

function resolveRepoRoot() {
    const candidate = process.env.CLAUDE_PROJECT_DIR || process.env.PIPELINE_REPO_ROOT || 'C:\\Workspaces\\Intrale\\platform';
    try {
        const gitCommon = execSync('git rev-parse --git-common-dir', { cwd: candidate, timeout: 3000, windowsHide: true })
            .toString().trim().replace(/\\/g, '/');
        if (gitCommon === '.git') return candidate;
        const gitIdx = gitCommon.indexOf('/.git');
        if (gitIdx !== -1) return gitCommon.substring(0, gitIdx);
        return path.resolve(gitCommon, '..');
    } catch (e) { return candidate; }
}

function pricingFilePath() {
    // Path FIJO — NO permitir override por env var, CLI flag ni input externo (security #1).
    return path.join(resolveRepoRoot(), '.pipeline', 'metrics', 'pricing.json');
}

// ---------------------------------------------------------------------------
// Sanitizers — exportados para uso en aggregator.js y tests
// ---------------------------------------------------------------------------

/**
 * Normaliza y valida un nombre de provider contra la allowlist.
 * @returns {string|null} provider normalizado en minúsculas, o `null` si no matchea.
 */
function sanitizeProvider(p) {
    if (p == null) return null;
    const x = String(p).toLowerCase().trim();
    return PROVIDER_ALLOWLIST.has(x) ? x : null;
}

/**
 * Normaliza y valida un nombre de modelo. Aplica regex SAFE_KEY_RE para evitar
 * path traversal, whitespace, caracteres de control y nombres demasiado largos.
 * @returns {string|null} modelo normalizado o `null` si no matchea.
 */
function sanitizeModel(m) {
    if (m == null) return null;
    const x = String(m).toLowerCase().replace(/-\d{8}$/, '').trim();
    return SAFE_KEY_RE.test(x) ? x : null;
}

/**
 * Infiere el provider a partir del prefijo del modelo. Sirve para back-compat
 * con eventos `session:end` legacy que no incluyen `provider` explícito.
 * @returns {string|null} provider inferido, o `null` si no se puede inferir.
 */
function inferProvider(model) {
    const m = sanitizeModel(model);
    if (!m) return null;
    if (m === 'deterministic') return 'deterministic';
    if (m.startsWith('claude-')) return 'anthropic';
    if (m.startsWith('gpt-') || m.startsWith('o1-') || m.startsWith('o3-') || m.startsWith('o4-')) return 'openai';
    if (m.startsWith('gemini-')) return 'google';
    return null;
}

// ---------------------------------------------------------------------------
// Validación del JSON externalizado
// ---------------------------------------------------------------------------

function isFiniteNonNegative(n) {
    return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

function validatePriceEntry(entry) {
    if (!entry || typeof entry !== 'object') return false;
    return isFiniteNonNegative(entry.in)
        && isFiniteNonNegative(entry.out)
        && isFiniteNonNegative(entry.cache_read)
        && isFiniteNonNegative(entry.cache_write);
}

/**
 * Valida la forma del JSON parseado. Devuelve `{ ok: bool, errors: string[] }`.
 * Rechaza providers fuera de la allowlist, modelos con caracteres prohibidos,
 * y entradas de pricing con campos faltantes / negativos / no numéricos.
 */
// Regex ISO-8601 estricto — Date.parse es demasiado lenient (acepta "2026", "no-iso", etc.).
// Acepta YYYY-MM-DD opcionalmente seguido de Thh:mm:ss(.sss)? con offset Z o ±hh:mm.
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function validate(parsed) {
    const errors = [];
    if (!parsed || typeof parsed !== 'object') {
        return { ok: false, errors: ['pricing.json no es un objeto válido'] };
    }
    if (typeof parsed.version !== 'number') errors.push('campo `version` ausente o no-numérico');
    if (typeof parsed.updated_at !== 'string'
        || !ISO_8601_RE.test(parsed.updated_at)
        || Number.isNaN(Date.parse(parsed.updated_at))) {
        errors.push('campo `updated_at` no es ISO-8601 parseable');
    }
    if (!parsed.providers || typeof parsed.providers !== 'object') {
        return { ok: false, errors: errors.concat(['campo `providers` ausente o no-objeto']) };
    }
    for (const provider of Object.keys(parsed.providers)) {
        if (!PROVIDER_ALLOWLIST.has(provider)) {
            errors.push(`provider '${String(provider).slice(0, 40)}' fuera de allowlist`);
            continue;
        }
        const models = parsed.providers[provider];
        if (!models || typeof models !== 'object') {
            errors.push(`providers.${provider} no es un objeto`);
            continue;
        }
        for (const modelKey of Object.keys(models)) {
            const safe = sanitizeModel(modelKey);
            if (!safe || safe !== modelKey) {
                errors.push(`providers.${provider}: nombre de modelo '${String(modelKey).slice(0, 40)}' no matchea regex de seguridad`);
                continue;
            }
            if (!validatePriceEntry(models[modelKey])) {
                errors.push(`providers.${provider}.${modelKey}: precios faltantes / negativos / no numéricos`);
            }
        }
    }
    return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Loader principal
// ---------------------------------------------------------------------------

/**
 * Carga la tabla de pricing desde el JSON externalizado. Si falla la lectura,
 * el parseo o la validación, cae a `FALLBACK_PRICING` y loguea un warning en
 * español (CA-5). NUNCA lanza excepción — la traza nunca debe romper un skill.
 *
 * El resultado se cachea en memoria del proceso. Para refresh on-tick basta con
 * llamar `invalidateCache()` antes de `load()`.
 *
 * @returns {{ table: Object, meta: Object }} table es nested `{ provider: { model: { in, out, cache_read, cache_write } } }`.
 */
function load() {
    if (_cache) return _cache;

    const file = pricingFilePath();
    let parsed = null;

    if (!fs.existsSync(file)) {
        warn(`pricing.json ausente en '${file}' — usando tabla hardcoded de fallback`);
        return setCache(FALLBACK_PRICING, FALLBACK_META, null);
    }

    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
        warn(`pricing.json no se pudo leer (${e.message}) — usando tabla hardcoded de fallback`);
        return setCache(FALLBACK_PRICING, FALLBACK_META, null);
    }

    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        warn(`pricing.json malformado (JSON inválido: ${e.message}) — usando tabla hardcoded de fallback`);
        return setCache(FALLBACK_PRICING, FALLBACK_META, null);
    }

    const v = validate(parsed);
    if (!v.ok) {
        warn(`pricing.json malformado (${v.errors.slice(0, 3).join('; ')}) — usando tabla hardcoded de fallback`);
        return setCache(FALLBACK_PRICING, FALLBACK_META, null);
    }

    const meta = {
        version: parsed.version,
        updated_at: parsed.updated_at,
        source: parsed.source || null,
        providers_loaded: Object.keys(parsed.providers).sort(),
        source_kind: 'json',
    };
    return setCache(parsed.providers, meta, file);
}

function setCache(table, meta, sourceFile) {
    let mtimeMs = null;
    if (sourceFile) {
        try { mtimeMs = fs.statSync(sourceFile).mtimeMs; } catch(_) {}
    }
    _cache = { table, meta, mtimeMs };
    return _cache;
}

function invalidateCache() {
    _cache = null;
}

function warn(msg) {
    try { process.stderr.write(`[pricing] ${msg}\n`); } catch(_) {}
}

// ---------------------------------------------------------------------------
// API pública: lookup y flat-merge
// ---------------------------------------------------------------------------

/**
 * Busca el pricing de un (provider, model). Aplica sanitización, infiere
 * provider si viene `null`, y cae a `deterministic` (costo 0) si el modelo no
 * está en la tabla — evita fail-open con costos arbitrarios (security #3, CA-5).
 *
 * @returns {{ in:number, out:number, cache_read:number, cache_write:number }}
 */
function getPricing(provider, model) {
    const { table } = load();

    // Distinción clave para back-compat (security #2):
    //   - Provider == null/undefined/'' → caller NO lo proveyó → inferimos por prefijo del modelo.
    //   - Provider proveído pero inválido → caller lo proveyó pero es malicioso/erróneo → NO inferimos,
    //     devolvemos costo 0. Esto evita que un evento envenenado con `provider='anthropic evil'`
    //     se cobre como anthropic vía inferencia del modelo.
    let safeProvider;
    if (provider == null || (typeof provider === 'string' && provider.trim() === '')) {
        safeProvider = sanitizeProvider(inferProvider(model));
    } else {
        safeProvider = sanitizeProvider(provider);
    }
    const safeModel = sanitizeModel(model);
    if (!safeProvider || !safeModel) return zeroPricing();

    const providerTable = table[safeProvider];
    if (!providerTable) return zeroPricing();

    const entry = providerTable[safeModel];
    if (entry && validatePriceEntry(entry)) return entry;

    // Fallback explícito a deterministic (costo 0) si el modelo no aparece.
    return zeroPricing();
}

function zeroPricing() {
    return { in: 0, out: 0, cache_read: 0, cache_write: 0 };
}

/**
 * Devuelve la tabla flat-merged compatible con `MODEL_PRICING` legacy:
 * `{ <model>: { in, out, cache_read, cache_write } }`. Se usa para mantener
 * `snapshot.pricing` sin tocar el shape histórico (CA-3 — regresión cero #2891).
 *
 * Si dos providers tienen el mismo nombre de modelo (no debería ocurrir bajo
 * la allowlist actual), gana el que carga después según orden de `Object.keys`.
 */
function flatMergedPricing() {
    const { table } = load();
    const out = {};
    for (const provider of Object.keys(table)) {
        for (const model of Object.keys(table[provider])) {
            out[model] = table[provider][model];
        }
    }
    return out;
}

/**
 * Devuelve la tabla nested por provider — shape nuevo para el dashboard #3090.
 */
function pricingByProvider() {
    return load().table;
}

/**
 * Metadatos de la tabla cargada — version, updated_at, providers_loaded, source_kind.
 */
function pricingMeta() {
    return load().meta;
}

module.exports = {
    // Loader
    load,
    invalidateCache,
    pricingFilePath,
    // API de cálculo
    getPricing,
    flatMergedPricing,
    pricingByProvider,
    pricingMeta,
    // Sanitizers (exportados para tests y aggregator)
    sanitizeProvider,
    sanitizeModel,
    inferProvider,
    validate,
    // Constantes (exportadas para tests)
    PROVIDER_ALLOWLIST,
    SAFE_KEY_RE,
    FALLBACK_PRICING,
    FALLBACK_META,
};

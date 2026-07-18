// =============================================================================
// provider-quota.js — Agregador de cuota DISPONIBLE por proveedor × ventana
// (#4533).
//
// Motivación (issue #4533):
//   El panel "Estado del sistema + Cuotas" del home MIZPÁ debe mostrar la cuota
//   DISPONIBLE (no consumida) por CADA proveedor y por CADA ventana (corta /
//   larga), leída de la fuente fidedigna del propio proveedor, con su PROPIO
//   reset por bucket (no uno global compartido).
//
// Este módulo NO hace requests HTTP (los adapters son offline por diseño,
// security CA-#6 de #3092). Deriva la cuota disponible del `QuotaResult` que
// ya computan los adapters (`lib/quota-adapters/*`) y expone un "seam" para que
// la capa de dispatch multi-provider — que SÍ ve las respuestas HTTP — cachee
// el último `{remaining, limit, resetAt}` real por proveedor+bucket (headers
// `x-ratelimit-*`, evento `usage-limit`, metadatos `QuotaFailure`) sin llamadas
// extra. Mientras esa captura no exista para un proveedor, la celda cae a
// "sin dato" explícito en vez de una estimación nuestra (CA #4533).
//
// Contrato de exposición mínima (security req#5 de #4202): por proveedor+bucket
// SOLO viaja `{ pct, confidence, available, resetAt, win, kind, mode }`. NUNCA
// tokens crudos, cost_usd, secretos ni rutas de snapshot.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

// Metadata de ventanas por proveedor — FUENTE ÚNICA de los rótulos de ventana
// (CA #4533: "cada celda rotula su ventana real"). El front NO hardcodea los
// labels: los recibe del slice.
//
//   - kind: 'short' (ventana corta) | 'long' (ventana larga). Mapea a los
//     buckets del slice: short ↔ session, long ↔ weekly.
//   - mode: 'gauge' (barra con % disponible) | 'event' (estado por eventos,
//     e.g. Codex "sin límite" hasta que salta un usage-limit).
const PROVIDER_WINDOWS = Object.freeze({
    'anthropic':     { short: { win: '5h',  kind: 'short' }, long: { win: 'Sem', kind: 'long' }, mode: 'gauge' },
    'openai-codex':  { short: { win: 'Roll', kind: 'short' }, long: { win: 'Sem', kind: 'long' }, mode: 'event' },
    'gemini-google': { short: { win: 'Min', kind: 'short' }, long: { win: 'Día', kind: 'long' }, mode: 'gauge' },
    'cerebras':      { short: { win: 'Min', kind: 'short' }, long: { win: 'Día', kind: 'long' }, mode: 'gauge' },
    'nvidia-nim':    { short: { win: 'Min', kind: 'short' }, long: { win: 'Día', kind: 'long' }, mode: 'gauge' },
});

const DEFAULT_WINDOW = Object.freeze({
    short: { win: 'Min', kind: 'short' },
    long:  { win: 'Día', kind: 'long' },
    mode:  'gauge',
});

// Clasificación de proveedores por modelo de contabilidad de cuota (#4777 CA-1):
//   - PAGOS (Anthropic/Codex): consumo contabilizado en un contador CENTRAL
//     único (coordination store) vía débito atómico. Ningún consumo concurrente
//     se pierde. Medición fidedigna (feedback_quota-fidedigna-pagos-vs-free).
//   - FREE (Gemini/Groq-Cerebras/NVIDIA): medición LOCAL flexible (recordSample,
//     snapshot de disponible por headers/eventos). No requiere contador central.
const PAID_PROVIDERS = Object.freeze(['anthropic', 'openai-codex']);
const FREE_PROVIDERS = Object.freeze(['gemini-google', 'cerebras', 'nvidia-nim']);

function isPaidProvider(provider) {
    return PAID_PROVIDERS.includes(provider);
}

function isFreeProvider(provider) {
    return FREE_PROVIDERS.includes(provider);
}

// Clave del contador central por proveedor pago. Los nombres de proveedor son
// una allowlist fija de código (a-z + guion) → clave `isSafeId`-segura para el
// coordination store, sin datos crudos del caller.
function _quotaKeyFor(provider) {
    return `quota-${provider}`;
}

// TTL de una muestra cacheada (headers/eventos) antes de tratarla como stale.
// Una muestra más vieja que esto NO se usa como dato fresco: la celda cae a
// "sin dato" (evita mostrar cuota fantasma de hace horas como si fuera real).
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 min

function _cachePath(pipelineDir) {
    return path.join(pipelineDir || '.', 'state', 'provider-quota.json');
}

// clamp 0..100 defensivo. Devuelve null si el input no es número finito.
function _clampPct(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    if (v < 0) return 0;
    if (v > 100) return 100;
    return v;
}

// consumido% -> disponible% (clamp). CA #4533: fórmula `disponible = 100 - consumido`.
function _availableFromConsumed(consumedPct) {
    const c = _clampPct(consumedPct);
    if (c == null) return null;
    return _clampPct(100 - c);
}

// Lee el `resetAt` (ISO) del bucket correspondiente desde el QuotaResult del
// adapter. Cada proveedor tiene su propio campo/semántica (CA #4533: reset
// independiente por proveedor y ventana):
//   - Anthropic: sessionResetsAt (5h) / weeklyResetsAtReported (semanal).
//   - Resto (cuando el adapter lo provea): nextResetAt.
function _resetAtFor(provider, bucketKind, adapterResult) {
    if (!adapterResult || typeof adapterResult !== 'object') return null;
    const iso = (v) => (typeof v === 'string' && v.length > 0 ? v : null);
    if (provider === 'anthropic') {
        return bucketKind === 'short'
            ? iso(adapterResult.sessionResetsAt)
            : iso(adapterResult.weeklyResetsAtReported);
    }
    return iso(adapterResult.nextResetAt);
}

/**
 * Lee la caché de muestras reales por proveedor+bucket. Best-effort: si el
 * archivo no existe o está corrupto, devuelve {}. NUNCA lanza.
 *
 * Shape: { "<provider>": { "<bucketKind>": { available, resetAt, capturedAt } } }
 *
 * @param {string} pipelineDir
 * @returns {Object}
 */
function readCache(pipelineDir) {
    try {
        const raw = fs.readFileSync(_cachePath(pipelineDir), 'utf8');
        const parsed = JSON.parse(raw);
        return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch {
        return {};
    }
}

/**
 * Seam para la capa de dispatch multi-provider: cachea la última muestra real
 * `{remaining, limit, resetAt}` por proveedor+bucket (headers `x-ratelimit-*`,
 * evento `usage-limit`, `QuotaFailure`). Idempotente y fail-secure: si algo
 * falla, no rompe el dispatch (best-effort). Escribe atómicamente (tmp+rename).
 *
 * @param {Object} sample { provider, bucketKind ('short'|'long'), remaining,
 *                          limit, resetAt (ISO|null), now (ms), pipelineDir }
 * @returns {boolean} true si persistió
 */
function recordSample(sample) {
    try {
        const s = sample || {};
        const provider = s.provider;
        const bucketKind = s.bucketKind === 'long' ? 'long' : 'short';
        if (typeof provider !== 'string' || provider.length === 0) return false;
        const remaining = Number(s.remaining);
        const limit = Number(s.limit);
        if (!Number.isFinite(remaining) || !Number.isFinite(limit) || limit <= 0) return false;
        const available = _clampPct(100 * (remaining / limit));
        const now = Number.isFinite(s.now) ? s.now : Date.now();
        const pipelineDir = s.pipelineDir || '.';

        const cache = readCache(pipelineDir);
        if (!cache[provider] || typeof cache[provider] !== 'object') cache[provider] = {};
        cache[provider][bucketKind] = {
            available,
            resetAt: (typeof s.resetAt === 'string' && s.resetAt.length > 0) ? s.resetAt : null,
            capturedAt: now,
        };

        const file = _cachePath(pipelineDir);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
        fs.renameSync(tmp, file);
        return true;
    } catch {
        return false;
    }
}

/**
 * Débito de cuota de un proveedor PAGO al contador central único (coordination
 * store), de forma atómica (`store.debitPaid` → `compareAndSet` con reintento
 * por conflicto de versión). Free tiers NO usan esta ruta: siguen en medición
 * local (`recordSample`).
 *
 * SEC-1 (OWASP A02, bloqueante): al store SÓLO viaja el contador de tokens
 * consumidos. NUNCA credenciales, API keys, tokens de sesión ni `cost_usd`
 * crudo. La fuente única de secretos sigue en `credentials.js`.
 *
 * @param {object} store   coordination store con `debitPaid(key, delta, opts)`.
 * @param {object} params  { provider, deltaTokens, maxRetries? }
 * @returns {Promise<{ ok:true, consumed:number, version:number }>}
 */
async function debitPaidQuota(store, params) {
    const p = params || {};
    const provider = p.provider;
    if (!isPaidProvider(provider)) {
        throw new Error(
            `debitPaidQuota sólo aplica a proveedores pagos (${PAID_PROVIDERS.join('/')}); ` +
            `los free tiers usan medición local. Recibido: ${String(provider)}`);
    }
    if (!store || typeof store.debitPaid !== 'function') {
        throw new Error('debitPaidQuota requiere un coordination store con debitPaid()');
    }
    const deltaTokens = Number(p.deltaTokens);
    if (!Number.isFinite(deltaTokens) || deltaTokens < 0) {
        throw new Error('debitPaidQuota requiere deltaTokens finito y >= 0');
    }
    // Sólo el contador viaja al store (lo garantiza store.debitPaid: persiste
    // `{ consumed }`). Acá no adjuntamos keys/tokens/cost.
    return store.debitPaid(_quotaKeyFor(provider), deltaTokens, { maxRetries: p.maxRetries });
}

// Devuelve la muestra cacheada fresca para provider+bucket, o null si no hay o
// está stale (más vieja que CACHE_TTL_MS).
function _freshCacheSample(cache, provider, bucketKind, now) {
    const perProvider = cache && cache[provider];
    const sample = perProvider && perProvider[bucketKind];
    if (!sample || typeof sample !== 'object') return null;
    const capturedAt = Number(sample.capturedAt);
    if (!Number.isFinite(capturedAt)) return null;
    if ((now - capturedAt) > CACHE_TTL_MS) return null;
    return sample;
}

/**
 * Enriquece el sub-shape normalizado de cliente (`{ pct, confidence }` por
 * bucket) con la cuota DISPONIBLE, el reset propio, el rótulo de ventana y el
 * modo de render. Muta y devuelve el mismo objeto `normalized` (in-place) para
 * encajar sin fricción en el loop de `quotaSlice`.
 *
 * Prioridad de la fuente de cada bucket:
 *   1. Muestra real cacheada y fresca (headers/eventos) — confianza 'fresh'.
 *   2. QuotaResult del adapter (Anthropic real / Codex evento) — deriva
 *      available de `pct` consumido.
 *   3. Sin ninguna de las dos → mode 'nodata' (celda "sin dato" explícita).
 *
 * @param {string} provider
 * @param {Object} normalized  { provider, adapterStatus, session:{pct,confidence}, weekly:{pct,confidence} }
 * @param {Object} adapterResult  QuotaResult crudo del adapter (para reset/estado)
 * @param {Object} [opts] { cache, now }
 * @returns {Object} el mismo `normalized`, enriquecido
 */
function enrich(provider, normalized, adapterResult, opts) {
    if (!normalized || typeof normalized !== 'object') return normalized;
    const meta = PROVIDER_WINDOWS[provider] || DEFAULT_WINDOW;
    const now = (opts && Number.isFinite(opts.now)) ? opts.now : Date.now();
    const cache = (opts && opts.cache) || {};

    // bucketKey = clave del sub-shape en `normalized`; bucketMeta = ventana.
    const buckets = [
        { key: 'session', meta: meta.short },
        { key: 'weekly',  meta: meta.long },
    ];

    for (const { key, meta: bmeta } of buckets) {
        const sub = normalized[key] && typeof normalized[key] === 'object'
            ? normalized[key]
            : (normalized[key] = { pct: null, confidence: 'missing' });

        sub.win = bmeta.win;
        sub.kind = bmeta.kind;

        // 1. Muestra real cacheada (seam de headers/eventos).
        const cached = _freshCacheSample(cache, provider, bmeta.kind, now);
        if (cached && cached.available != null) {
            sub.available = _clampPct(cached.available);
            sub.resetAt = cached.resetAt || _resetAtFor(provider, bmeta.kind, adapterResult);
            sub.confidence = 'fresh';
            sub.mode = 'gauge';
            continue;
        }

        // 2. Codex y otros proveedores por eventos: no hay barra, hay estado.
        if (meta.mode === 'event') {
            sub.mode = 'event';
            sub.available = null;
            sub.resetAt = _resetAtFor(provider, bmeta.kind, adapterResult);
            // "sin límite" salvo que el adapter reporte un tope activo.
            const st = adapterResult && adapterResult.adapterStatus;
            const q = adapterResult && adapterResult.status;
            sub.eventOk = !(st === 'error' || q === 'critical');
            continue;
        }

        // 3. Dato del adapter (available derivado del consumido).
        const available = _availableFromConsumed(sub.pct);
        if (available != null) {
            sub.available = available;
            sub.resetAt = _resetAtFor(provider, bmeta.kind, adapterResult);
            sub.mode = 'gauge';
            continue;
        }

        // 4. Sin dato confiable → celda explícita "sin dato" (no estimamos).
        sub.available = null;
        sub.resetAt = null;
        sub.mode = 'nodata';
    }

    return normalized;
}

module.exports = {
    PROVIDER_WINDOWS,
    CACHE_TTL_MS,
    PAID_PROVIDERS,
    FREE_PROVIDERS,
    enrich,
    readCache,
    recordSample,
    isPaidProvider,
    isFreeProvider,
    debitPaidQuota,
    // exportados para test
    _availableFromConsumed,
    _resetAtFor,
    _quotaKeyFor,
};

'use strict';

// =============================================================================
// provider-balancer.js — Selector ponderado PURO de providers del Commander.
//
// Corte 1/3 de #4363 (issue #4411). Núcleo sin integración: NO cablea a
// `pulpo.js` ni a `resolveCommanderProvider`. Regresión-cero por construcción.
//
// Dado el set de providers de una `chain` (derivada de `fallbacks[]`), filtra
// los SANOS (fail-closed) y reparte la selección entre ellos combinando:
//   - el orden de calidad canónico (Claude > Codex > Groq > Gemini > Cerebras),
//   - la cuota DISPONIBLE de cada provider,
// para evitar que un único provider se agote y tumbe al Commander.
//
// Diseño (requisitos de seguridad A01/A08/A02 del issue):
//   - Función PURA: TODO insumo entra por `deps` inyectables. El módulo no
//     llama `fs`/`process.env`/red/argv en el camino caliente. Los `require`
//     de las fuentes reales se resuelven LAZY y SOLO como default cuando el
//     caller no inyecta la dependencia (en tests se inyecta todo → 0 acceso
//     externo).
//   - Fail-closed en ELEGIBILIDAD: un provider gateado / sin-credencial /
//     no-tool NUNCA recibe peso > 0, aunque el estado SWRR esté corrupto.
//   - Fail-open SOLO en el PESO: estado SWRR ilegible ⇒ contadores en 0.
//   - `reason` es metadata enumerada (id de provider + motivo). JAMÁS material
//     de credencial (req A02).
//   - Solo pondera providers ya presentes en `chain`. No expande superficie de
//     lanzamiento (no deriva `ALLOWED_LAUNCHERS`).
// =============================================================================

// Orden de calidad canónico (memoria project_multi-provider-default-order:
// Claude > Codex > Groq > Gemini > Cerebras). NVIDIA-NIM cierra la cola.
// Cualquier provider fuera de esta lista recibe la menor prioridad de calidad.
const QUALITY_ORDER = [
    'anthropic',
    'openai-codex',
    'groq',
    'gemini-google',
    'cerebras',
    'nvidia-nim',
];

// Skill del Commander conversacional para el gate por agotamiento (#3077).
const COMMANDER_SKILL = 'telegram-commander';

// Defaults de configuración. `quality_bias` >= 0: a mayor valor, más peso
// concentra el primario (decay = 1/(1+quality_bias)). `min_primary_quota_pct`:
// umbral de cuota disponible por debajo del cual el peso del provider se degrada
// y se reparte hacia los siguientes en orden de calidad (CA-2).
const DEFAULT_CONFIG = {
    quality_bias: 1.0,
    min_primary_quota_pct: 20,
    default_available_pct: 100, // cuota asumida cuando no hay dato (fail-open en peso)
};

// Escala para convertir pesos flotantes a enteros del SWRR clásico.
const WEIGHT_SCALE = 1000;

// -----------------------------------------------------------------------------
// Helpers puros
// -----------------------------------------------------------------------------

function qualityRank(provider) {
    const idx = QUALITY_ORDER.indexOf(provider);
    return idx === -1 ? QUALITY_ORDER.length : idx;
}

function clampPct(v) {
    if (!Number.isFinite(v)) return null;
    if (v < 0) return 0;
    if (v > 100) return 100;
    return v;
}

// Resuelve las dependencias reales de forma LAZY. Solo se invoca para las claves
// que el caller NO inyectó (en tests se inyecta todo → nunca se ejecuta esto).
function resolveDefaultDep(key, pipelineDir) {
    switch (key) {
        case 'assessProviderQuota': {
            const ph = require('../provider-health');
            return (provider, opts = {}) =>
                ph.assessProviderQuota(provider, { pipelineDir, ...opts });
        }
        case 'shouldGateSpawn': {
            const qe = require('../quota-exhausted');
            return qe.shouldGateSpawn;
        }
        case 'isPlaceholder': {
            const sec = require('../multi-provider/secrets-rw');
            return sec.isPlaceholder;
        }
        case 'readCredential': {
            const sec = require('../multi-provider/secrets-rw');
            return (provider) => sec.getRawKey({ provider });
        }
        default:
            return undefined;
    }
}

function dep(deps, key, pipelineDir) {
    if (deps && Object.prototype.hasOwnProperty.call(deps, key) && deps[key] != null) {
        return deps[key];
    }
    return resolveDefaultDep(key, pipelineDir);
}

// -----------------------------------------------------------------------------
// 1) Construcción del set candidato — fail-closed (orden de exclusión del issue)
// -----------------------------------------------------------------------------

/**
 * Filtra `chain` dejando SOLO los providers elegibles. Un provider se EXCLUYE
 * (nunca entra al set candidato) si cumple CUALQUIERA de:
 *   1. requiresToolUse && supports_tool_use === false            (CA-5)
 *   2. credencial null/vacía o placeholder/revocada              (CA-4, A08.4)
 *   3. shouldGateSpawn(...) === true                             (CA-3)
 *   4. assessProviderQuota(...).status === 'critical' || gated   (cuota crítica)
 *
 * @returns {Array<{provider:string, quotaPct:number|null}>}
 */
function _buildCandidateSet({ chain, requiresToolUse, pipelineDir, deps = {} }) {
    if (!Array.isArray(chain)) return [];

    const assessProviderQuota = dep(deps, 'assessProviderQuota', pipelineDir);
    const shouldGateSpawn = dep(deps, 'shouldGateSpawn', pipelineDir);
    const isPlaceholder = dep(deps, 'isPlaceholder', pipelineDir);
    const readCredential = dep(deps, 'readCredential', pipelineDir);
    const modelsMeta = (deps && deps.modelsMeta) || {};
    const now = typeof (deps && deps.now) === 'function' ? deps.now : () => 0;
    const ts = now();

    const seen = new Set();
    const candidates = [];

    for (const provider of chain) {
        if (typeof provider !== 'string' || !provider) continue;
        if (seen.has(provider)) continue; // dedup, conserva el primer orden
        seen.add(provider);

        // 1) Paridad tool-use (CA-5) — fail-closed: sin metadata explícita `true`
        //    y con requiresToolUse, se excluye.
        if (requiresToolUse === true) {
            const meta = modelsMeta[provider];
            if (!meta || meta.supports_tool_use !== true) continue;
        }

        // 2) Credencial válida (CA-4 / A08.4) — fail-closed ante error del dep.
        let cred = null;
        try {
            cred = typeof readCredential === 'function' ? readCredential(provider) : null;
        } catch { cred = null; }
        if (!cred || typeof cred !== 'string' || !cred.trim()) continue;
        try {
            if (typeof isPlaceholder === 'function' && isPlaceholder(cred)) continue;
        } catch { continue; } // ante error del validador, excluir (fail-closed)

        // 3) Gate por agotamiento (CA-3) — fail-closed ante error.
        try {
            if (typeof shouldGateSpawn === 'function'
                && shouldGateSpawn(COMMANDER_SKILL, { provider, now: ts }) === true) {
                continue;
            }
        } catch { continue; }

        // 4) Cuota crítica / gateada por salud.
        let quotaPct = null;
        try {
            const q = typeof assessProviderQuota === 'function'
                ? assessProviderQuota(provider, { now: ts })
                : null;
            if (q && typeof q === 'object') {
                if (q.status === 'critical' || q.gated === true) continue;
                quotaPct = clampPct(q.pct);
            }
        } catch { continue; }

        candidates.push({ provider, quotaPct });
    }

    return candidates;
}

// -----------------------------------------------------------------------------
// 2) Cálculo de pesos — CA-2
// -----------------------------------------------------------------------------

/**
 * Asigna un peso a cada candidato combinando calidad y cuota disponible.
 *
 *   qualityWeight(rank) = decay^rank, decay = 1/(1+quality_bias)
 *     → a mayor quality_bias, más peso concentra el primario.
 *   quotaFactor(available):
 *     - available >= min_primary_quota_pct  → 1 (sin penalización)
 *     - available <  min_primary_quota_pct  → available/min (degrade lineal)
 *
 *   weight = qualityWeight * quotaFactor  (con piso > 0 para todo elegible).
 *
 * Con cuotas plenas e iguales, los pesos respetan estrictamente QUALITY_ORDER
 * y el primario conserva la mayoría. Si la cuota del primario cae por debajo del
 * umbral, su peso se degrada y el reparto se corre hacia los siguientes.
 *
 * @returns {Array<{provider:string, weight:number, quotaPct:number|null}>}
 */
function _computeWeights(candidates, config = {}) {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    const qualityBias = Number.isFinite(cfg.quality_bias) && cfg.quality_bias >= 0
        ? cfg.quality_bias
        : DEFAULT_CONFIG.quality_bias;
    const minPrimary = Number.isFinite(cfg.min_primary_quota_pct) && cfg.min_primary_quota_pct > 0
        ? cfg.min_primary_quota_pct
        : DEFAULT_CONFIG.min_primary_quota_pct;
    const defaultAvail = Number.isFinite(cfg.default_available_pct)
        ? cfg.default_available_pct
        : DEFAULT_CONFIG.default_available_pct;

    const decay = 1 / (1 + qualityBias);

    // Rango base por calidad relativo al MEJOR candidato presente, para que el
    // primario del set concentre la mayoría aunque su rank absoluto no sea 0.
    const bestRank = candidates.reduce(
        (min, c) => Math.min(min, qualityRank(c.provider)),
        Number.POSITIVE_INFINITY,
    );

    return candidates.map((c) => {
        const relRank = qualityRank(c.provider) - bestRank;
        const qualityWeight = Math.pow(decay, relRank);

        const available = c.quotaPct == null ? defaultAvail : c.quotaPct;
        let quotaFactor = 1;
        if (available < minPrimary) {
            quotaFactor = minPrimary > 0 ? available / minPrimary : 0;
        }

        // Piso estrictamente positivo: todo candidato ELEGIBLE debe poder ser
        // seleccionado (evita pesos 0 que romperían el SWRR con multi-candidato).
        const weight = Math.max(qualityWeight * quotaFactor, 1e-6);

        return { provider: c.provider, weight, quotaPct: c.quotaPct };
    });
}

// -----------------------------------------------------------------------------
// 3) Selección — SWRR (smooth weighted round-robin) con estado inyectable
// -----------------------------------------------------------------------------

function safeReadState(store) {
    if (!store || typeof store.readState !== 'function') return { current: {} };
    let raw;
    try { raw = store.readState(); } catch { return { current: {} }; }
    if (!raw || typeof raw !== 'object' || !raw.current || typeof raw.current !== 'object') {
        return { current: {} };
    }
    return { current: { ...raw.current } };
}

/**
 * Selección smooth weighted round-robin (algoritmo clásico de nginx). El estado
 * (contadores `current` por provider) se lee/escribe vía `store` inyectable.
 * Determinístico: mismos pesos + mismo estado ⇒ misma elección.
 *
 * Fail-open SOLO en el peso: si el estado no parsea, contadores en 0. La
 * elegibilidad ya fue resuelta aguas arriba (fail-closed), así que un estado
 * corrupto NUNCA puede habilitar un provider inelegible.
 *
 * @param {Array<{provider,weight,quotaPct}>} weighted
 * @param {{store?:object, random?:function}} opts
 * @returns {{provider,weight,quotaPct}|null}
 */
function _swrrPick(weighted, opts = {}) {
    if (!Array.isArray(weighted) || weighted.length === 0) return null;
    if (weighted.length === 1) return weighted[0];

    const { store, random } = opts;

    // Alternativa aceptable (security: no requiere CSPRNG): weighted-random con
    // seed inyectable, SOLO cuando no hay store SWRR disponible.
    if ((!store || typeof store.readState !== 'function') && typeof random === 'function') {
        const total = weighted.reduce((s, w) => s + w.weight, 0);
        let r = random() * total;
        for (const w of weighted) {
            r -= w.weight;
            if (r < 0) return w;
        }
        return weighted[weighted.length - 1];
    }

    // SWRR clásico con enteros escalados.
    const state = safeReadState(store);
    const scaled = weighted.map((w) => ({
        ...w,
        int: Math.max(1, Math.round(w.weight * WEIGHT_SCALE)),
    }));
    const total = scaled.reduce((s, w) => s + w.int, 0);

    let best = null;
    for (const w of scaled) {
        const prev = Number.isFinite(state.current[w.provider]) ? state.current[w.provider] : 0;
        const cur = prev + w.int;
        state.current[w.provider] = cur;
        if (best === null || cur > state.current[best.provider]) {
            best = w;
        }
    }
    state.current[best.provider] -= total;

    // Poda contadores de providers ya no presentes (evita crecimiento no acotado).
    const present = new Set(scaled.map((w) => w.provider));
    for (const p of Object.keys(state.current)) {
        if (!present.has(p)) delete state.current[p];
    }

    if (store && typeof store.writeState === 'function') {
        try { store.writeState(state); } catch { /* best-effort: no romper la selección */ }
    }

    return { provider: best.provider, weight: best.weight, quotaPct: best.quotaPct };
}

// -----------------------------------------------------------------------------
// API pública
// -----------------------------------------------------------------------------

/**
 * Selector ponderado puro. Devuelve el provider elegido o `null` si no hay
 * ningún provider sano (habilita el fallback estricto de la Parte 2).
 *
 * @param {object} params
 * @param {string[]} params.chain        providers candidatos (de `fallbacks[]`).
 * @param {boolean}  params.requiresToolUse  el request necesita tool-use.
 * @param {string}   [params.pipelineDir]    raíz del pipeline (para deps default).
 * @param {object}   [params.deps]           dependencias inyectables (ver módulo).
 * @returns {{provider:string, weight:number, quotaPct:number|null, reason:string}|null}
 */
function selectProvider({ chain, requiresToolUse = false, pipelineDir, deps = {} } = {}) {
    const candidates = _buildCandidateSet({ chain, requiresToolUse, pipelineDir, deps });
    if (candidates.length === 0) return null; // CA-8: 0 sanos ⇒ null

    const weighted = _computeWeights(candidates, deps.config || {});
    const picked = _swrrPick(weighted, { store: deps.store, random: deps.random });
    if (!picked) return null;

    // `reason`: metadata enumerada, SOLO id de provider + motivo. Nunca credenciales.
    const bestByQuality = weighted.reduce(
        (best, w) => (qualityRank(w.provider) < qualityRank(best.provider) ? w : best),
        weighted[0],
    );
    let reason;
    if (weighted.length === 1) {
        reason = 'sole_candidate';
    } else if (picked.provider === bestByQuality.provider) {
        reason = 'quality_bias';
    } else {
        reason = 'quota_rebalance';
    }

    return {
        provider: picked.provider,
        weight: picked.weight,
        quotaPct: picked.quotaPct,
        reason,
    };
}

module.exports = {
    selectProvider,
    QUALITY_ORDER,
    // Internos expuestos para tests (patrón credentials-precheck.js).
    _buildCandidateSet,
    _computeWeights,
    _swrrPick,
};

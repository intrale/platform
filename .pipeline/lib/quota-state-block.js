// =============================================================================
// quota-state-block.js — Compositor del bloque de cuota servido por `/api/state`
// (#4327, CA-4). Empaqueta DOS fuentes YA sanitizadas, con un timestamp reciente,
// para que `/api/state` exponga la cuota por proveedor con estado explícito y sin
// PII, sin re-disparar mecanismos ni serializar el snapshot OCR crudo:
//
//   - getBannerState() (quota-snapshot-integration) → estado explícito del
//     snapshot real (`fresh|stale|missing|parser-offline`), su edad (`ageMs`) y
//     `lastSnapshot` YA pasado por la allowlist `sanitizeSnapshotForOutput`
//     (sin `account_handle`; invariantes de seguridad #1/#4 de #4324).
//   - quotaSlice().providers (dashboard-slices) → % por proveedor/bucket
//     normalizado a `{pct, confidence}` (security req#5: sin cost_usd, tokens
//     crudos, ruta de snapshot ni campos de identidad). Se invoca con
//     `skipSideEffects: true` para NO re-correr el guard anticipatorio (#4282)
//     ni el pacing (#4289) desde el worker de estado.
//
// Defensa en profundidad: aunque ambas fuentes ya vienen sanitizadas, este
// compositor RECONSTRUYE el bloque por allowlist explícita (no copia el objeto
// crudo). Cualquier clave nueva que aparezca upstream NO se filtra a `/api/state`
// salvo que se la agregue acá a propósito.
//
// Fail-closed (CA-5): ante cualquier error de lectura/cómputo, el bloque queda
// en estado `missing` con `providers: {}` — NUNCA un número viejo presentado
// como fresco ni `0` como dato vigente.
// =============================================================================
'use strict';

// Estados válidos del banner (enum cerrado de getBannerState). Cualquier otro
// valor degrada a 'missing' (fail-closed).
const BANNER_STATES = Object.freeze(['fresh', 'stale', 'missing', 'parser-offline']);

// Normaliza un bucket (session/weekly) al shape mínimo del cliente. Sólo
// `{pct, confidence}`: `pct` numérico finito o null ("sin dato"); `confidence`
// string o 'missing'. Nunca propaga otras claves.
function sanitizeBucket(b) {
    const pct = (b && typeof b.pct === 'number' && Number.isFinite(b.pct)) ? b.pct : null;
    const confidence = (b && typeof b.confidence === 'string') ? b.confidence : 'missing';
    return { pct, confidence };
}

/**
 * Construye el bloque de cuota para `/api/state`.
 *
 * @param {{PIPELINE:string, ROOT:string}} ctx — dirs del pipeline (los mismos
 *        que usa el resto del snapshot de estado).
 * @param {object} [deps] — inyección para test: `{ integration, slices, now }`.
 * @returns {{snapshotAt:number, state:string, ageMs:(number|null),
 *            lastSnapshot:(object|null), providers:object}}
 */
function buildQuotaStateBlock(ctx, deps) {
    const now = (deps && typeof deps.now === 'function') ? deps.now() : Date.now();

    // Default fail-closed: estado 'missing', sin providers, con timestamp reciente.
    const block = {
        snapshotAt: now,
        state: 'missing',
        ageMs: null,
        lastSnapshot: null,
        providers: {},
    };

    // --- Estado explícito + snapshot sanitizado (getBannerState) --------------
    try {
        const integration = (deps && deps.integration)
            || require('./quota-snapshot-integration');
        if (integration && typeof integration.getBannerState === 'function') {
            const banner = integration.getBannerState();
            if (banner && typeof banner === 'object') {
                block.state = BANNER_STATES.includes(banner.state) ? banner.state : 'missing';
                block.ageMs = Number.isFinite(banner.ageMs) ? banner.ageMs : null;
                // `lastSnapshot` ya pasó por sanitizeSnapshotForOutput (allowlist,
                // sin account_handle). Se acepta tal cual sólo si es objeto.
                block.lastSnapshot = (banner.lastSnapshot && typeof banner.lastSnapshot === 'object')
                    ? banner.lastSnapshot
                    : null;
            }
        }
    } catch { /* fail-closed: queda 'missing' */ }

    // --- % por proveedor normalizado (quotaSlice, sin efectos secundarios) -----
    try {
        const slices = (deps && deps.slices) || require('./dashboard-slices');
        if (slices && typeof slices.quotaSlice === 'function') {
            const q = slices.quotaSlice({}, {
                PIPELINE: ctx && ctx.PIPELINE,
                ROOT: ctx && ctx.ROOT,
                skipSideEffects: true,
            });
            if (q && q.providers && typeof q.providers === 'object') {
                for (const [provider, v] of Object.entries(q.providers)) {
                    if (!v || typeof v !== 'object') continue;
                    block.providers[provider] = {
                        provider: typeof v.provider === 'string' ? v.provider : provider,
                        adapterStatus: typeof v.adapterStatus === 'string' ? v.adapterStatus : 'unknown',
                        session: sanitizeBucket(v.session),
                        weekly: sanitizeBucket(v.weekly),
                    };
                }
            }
        }
    } catch { /* providers vacío: no se cae a números viejos */ }

    return block;
}

module.exports = { buildQuotaStateBlock, sanitizeBucket, BANNER_STATES };

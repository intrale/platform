// =============================================================================
// quota-exhausted-state.js — Lectura defensiva del flag de cuota Anthropic
// agotada para el dashboard del pipeline V3 (#2976, hija de #2955).
//
// Responsabilidades:
//   - Leer `.pipeline/quota-exhausted.json` con hardening anti-DoS
//     (cap 10KB) y anti-corruption (try/catch + shape default).
//   - Normalizar el payload del detector (#2974) al shape consumido por
//     el banner del dashboard. El detector escribe `pattern_matched`,
//     el dashboard muestra `error_type` — el mapping vive acá.
//   - Computar `active = exhausted && resets_at_ms > now` para que el
//     banner desaparezca solo cuando expira el flag (sin reload).
//
// Patrón replicado de `lib/rest-mode-state.js` (banner del modo descanso,
// PR #2961). Mismas garantías:
//   - NUNCA tira: ENOENT / parse error / shape inválido / oversize → safe
//     default `{ active: false }`.
//   - Sin estado en memoria: cada llamada lee el filesystem (fuente de
//     verdad). El cache TTL queda para issue de mejora #2982.
//
// Schema persistido por #2974 (referencia):
//   {
//     exhausted: true,                         // siempre true cuando existe
//     resets_at: "2026-05-12T00:00:00.000Z",   // ISO8601, futuro
//     detected_at: "2026-05-05T03:14:22.123Z", // ISO8601 detección
//     pattern_matched: "usage_limit_error"     // valor de error_type del CLI
//   }
//
// Schema normalizado por este módulo (consumido por el banner):
//   {
//     active: boolean,
//     error_type: string|null,
//     detected_at: string|null,    // ISO8601 (validado parseable)
//     resets_at: string|null,      // ISO8601 (validado parseable + futuro)
//     resets_at_ms: number|null,   // epoch ms para el countdown del cliente
//     queued_skills: string[],     // computado por el slice del dashboard
//   }
//
// `queued_skills` lo poblamos vacío acá — el slice
// (dashboard-slices.js → quotaExhaustedSlice) lo enriquece con la cola
// real (LLM skills con archivos en `pendiente/`). Así el módulo de
// estado queda agnóstico de la matriz del pipeline (single responsibility).
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_PIPELINE_DIR = path.resolve(__dirname, '..');
const FLAG_FILENAME = 'quota-exhausted.json';

// CA-9: cap anti-DoS. Replica el patrón aplicado a `infra-health.json`
// (dashboard.js:729). Un archivo > 10KB para un flag tan simple es señal
// de manipulación o bug aguas arriba — degradar a safe default sin parsear.
const MAX_FILE_BYTES = 10 * 1024;

function resolvePipelineDir(explicit) {
    if (explicit) return explicit;
    // Mismo override env que usa lib/quota-exhausted.js (#2974) para que
    // los tests del slice/banner puedan apuntar a un dir temporal sin
    // tocar el `.pipeline/` real del worktree.
    if (process.env.PIPELINE_DIR_OVERRIDE) return process.env.PIPELINE_DIR_OVERRIDE;
    return DEFAULT_PIPELINE_DIR;
}

function flagPath(pipelineDir) {
    return path.join(resolvePipelineDir(pipelineDir), FLAG_FILENAME);
}

/**
 * Shape default del banner. Garantiza tipos consistentes para el cliente
 * aunque el archivo no exista o esté roto.
 */
function emptyQuotaState() {
    return {
        active: false,
        error_type: null,
        detected_at: null,
        resets_at: null,
        resets_at_ms: null,
        // #4731 — lista de proveedores afectados (vacía cuando no hay flag).
        providers: [],
        queued_skills: [],
    };
}

// #4731 — Normaliza cualquier shape persistido (legacy single-flag o el nuevo
// mapa por-proveedor) a una lista de slots `{ id, error_type, detected_at,
// resets_at, resets_at_ms }`. READ-ONLY: no toca el filesystem (a diferencia
// de quota-exhausted.js:readDefensive, este módulo NUNCA borra el flag físico
// — sólo lo hace el detector). Devuelve `[]` si el shape es inválido.
// Backward-compat #3077 CA-14: legacy sin `provider` → id `anthropic`.
function normalizeSlots(parsed) {
    const out = [];
    const pushSlot = (id, raw) => {
        if (!raw || typeof raw !== 'object') return;
        if (typeof raw.resets_at !== 'string') return;
        if (typeof raw.detected_at !== 'string') return;
        if (typeof raw.pattern_matched !== 'string') return;
        const resetsMs = Date.parse(raw.resets_at);
        const detectedMs = Date.parse(raw.detected_at);
        if (!Number.isFinite(resetsMs) || !Number.isFinite(detectedMs)) return;
        out.push({
            id: (typeof raw.provider === 'string' && raw.provider) || id,
            error_type: raw.pattern_matched,
            detected_at: raw.detected_at,
            resets_at: raw.resets_at,
            resets_at_ms: resetsMs,
        });
    };
    if (parsed && typeof parsed === 'object' && parsed.providers
        && typeof parsed.providers === 'object' && !Array.isArray(parsed.providers)) {
        for (const [id, raw] of Object.entries(parsed.providers)) pushSlot(id, raw);
    } else if (parsed && typeof parsed === 'object' && parsed.exhausted === true) {
        pushSlot(parsed.provider || 'anthropic', parsed);
    }
    return out;
}

/**
 * Lectura defensiva con todos los hardenings que pide el security review:
 *   - `fs.statSync` para abortar si el archivo > MAX_FILE_BYTES (CA-9).
 *   - `try/catch` envuelve read+parse (CA-8).
 *   - Validación de tipos antes de consumir (CA-8 + #2974 validateFlagShape):
 *     * `exhausted === true` (boolean estricto)
 *     * `resets_at`, `detected_at`, `pattern_matched` son strings con
 *       Date.parse() válido cuando aplica.
 *   - Mapeo `pattern_matched` → `error_type` para el banner.
 *   - `active` se computa contra `now`: si `resets_at` ya pasó, devuelve
 *     `{ active: false }` aunque el archivo siga ahí (drenado lógico).
 *     El borrado físico lo hace el detector (#2974) la próxima vez que
 *     lea — este módulo es read-only.
 *
 * NUNCA propaga excepciones. Cualquier error de IO/parse/shape devuelve
 * `emptyQuotaState()` para no tumbar el dashboard.
 *
 * @param {object} [opts]
 * @param {string} [opts.pipelineDir] — override para tests.
 * @param {string} [opts.statePath]   — override directo del path.
 * @param {Function|number} [opts.now] — Date.now() override (tests).
 * @returns {{active: boolean, error_type: string|null, detected_at: string|null, resets_at: string|null, resets_at_ms: number|null, queued_skills: string[]}}
 */
function getQuotaState(opts) {
    const _opts = opts || {};
    const file = _opts.statePath || flagPath(_opts.pipelineDir);
    const now = typeof _opts.now === 'function'
        ? _opts.now()
        : (Number.isFinite(_opts.now) ? _opts.now : Date.now());

    // CA-9: stat antes de read. ENOENT → safe default sin loguear (caso normal).
    let stat;
    try {
        stat = fs.statSync(file);
    } catch (e) {
        return emptyQuotaState();
    }
    if (!stat || !stat.isFile()) return emptyQuotaState();
    if (typeof stat.size === 'number' && stat.size > MAX_FILE_BYTES) {
        // Anti-DoS: archivo gigante. No parseamos. Defensa en profundidad:
        // un atacante con write al disk no debería poder bloquear el event
        // loop del dashboard con un JSON de 1MB.
        return emptyQuotaState();
    }

    // CA-8: try/catch envuelve TODO. Cualquier error → safe default.
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
        return emptyQuotaState();
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        return emptyQuotaState();
    }
    if (!parsed || typeof parsed !== 'object') return emptyQuotaState();

    // #4731 — Normalizamos a slots por-proveedor (legacy o nuevo shape) y nos
    // quedamos SÓLO con los activos (`resets_at` futuro). `active = OR de slots
    // con reset futuro`. Un slot vencido se oculta naturalmente sin borrar el
    // archivo (CA-2: read-only; el borrado físico lo hace el detector).
    const slots = normalizeSlots(parsed)
        .filter((s) => s.resets_at_ms > now)
        .sort((a, b) => a.resets_at_ms - b.resets_at_ms); // reset más próximo primero
    if (slots.length === 0) return emptyQuotaState();

    // Slot primario = reset más próximo → espejo legacy para el countdown y los
    // consumidores que aún leen `error_type`/`resets_at` planos.
    const primary = slots[0];

    return {
        active: true,
        // Espejo del slot primario (compat con el banner legacy + countdown).
        error_type: primary.error_type,
        detected_at: primary.detected_at,
        resets_at: primary.resets_at,
        resets_at_ms: primary.resets_at_ms,
        // #4731 — lista completa de proveedores afectados (fuente por-proveedor
        // del banner). Cada uno con su motivo (`error_type`) y reset propio.
        providers: slots.map((s) => ({
            id: s.id,
            error_type: s.error_type,
            detected_at: s.detected_at,
            resets_at: s.resets_at,
            resets_at_ms: s.resets_at_ms,
        })),
        // El slice del dashboard rellena esta lista con los skills LLM esperando
        // en `pendiente/`. Default `[]` seguro.
        queued_skills: [],
    };
}

module.exports = {
    MAX_FILE_BYTES,
    FLAG_FILENAME,
    emptyQuotaState,
    getQuotaState,
    flagPath,
};

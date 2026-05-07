// =============================================================================
// quota-thresholds.js — Umbrales semánticos por bucket de cuota (#3013, CA-UX-4)
//
// Tabla configurable de umbrales que decide el "estado" semántico de cada
// bucket del banner real-snapshot:
//
//   - Buckets de tipo `*_pct` (sesión, semanal todos/sonnet/design):
//     verde (< 65%) / ámbar (65-89%) / rojo (>= 90%).
//
//   - Bucket especial `daily_routines` (X / 15): verde (< 10) / ámbar (10-13)
//     / rojo (>= 14).
//
//   - Bucket especial `api_overage_usd_pct` (used_usd / cap_usd):
//     verde ($0 / 0%) / ámbar (1-80%) / rojo (> 80%).
//
// Configurabilidad (CA-UX-4 + narrativa §2.4):
//   - Cada umbral es overrideable por env var (`QUOTA_THRESHOLD_*`).
//   - Si la env var no existe / no parsea como número finito, se usa el
//     default literal.
//   - Los rangos se validan: si el override es >= 100 o <= 0, se ignora con
//     fallback al default.
//
// Sin nuevas dependencias externas (Node puro). Sin estado persistido.
// =============================================================================

'use strict';

// -----------------------------------------------------------------------------
// Defaults (narrativa-quota-real-snapshot.md §2.4)
// -----------------------------------------------------------------------------

const DEFAULT_PCT_AMBER = 65;   // 65% por bucket pct genérico
const DEFAULT_PCT_RED = 90;     // 90% gating real

const DEFAULT_ROUTINES_AMBER = 10;  // 10/15
const DEFAULT_ROUTINES_RED = 14;    // 14/15

const DEFAULT_OVERAGE_AMBER = 1;    // > 0% USD usado
const DEFAULT_OVERAGE_RED = 80;     // > 80% del cap

// -----------------------------------------------------------------------------
// Helpers de parsing seguro
// -----------------------------------------------------------------------------

/**
 * Parse un override de env var a número. Falla cerrado:
 *   - undefined / vacío → null (usa default).
 *   - NaN, Infinity, fuera de [0, 100] → null + warning local.
 *
 * Sin throw — el caller decide qué hacer con null.
 */
function parsePctEnv(name, fallback) {
    const raw = process.env[name];
    if (raw == null || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    if (n < 0 || n > 100) return fallback;
    return n;
}

function parseIntEnv(name, fallback, max) {
    const raw = process.env[name];
    if (raw == null || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n)) return fallback;
    if (n < 0) return fallback;
    if (Number.isFinite(max) && n > max) return fallback;
    return n;
}

// -----------------------------------------------------------------------------
// Tabla de umbrales (resolved en cada llamada para reflejar env var dinámica)
// -----------------------------------------------------------------------------

/**
 * Devuelve la tabla activa de umbrales. Se calcula en cada llamada para
 * permitir cambiar variables de entorno entre tests sin requerir reload del
 * módulo (importante para los tests del propio módulo y del wire 3013).
 */
function getThresholds() {
    return Object.freeze({
        // Buckets pct genéricos (sesión, semanal todos/sonnet/design)
        sessionPct: {
            amber: parsePctEnv('QUOTA_THRESHOLD_SESSION_AMBER', DEFAULT_PCT_AMBER),
            red: parsePctEnv('QUOTA_THRESHOLD_SESSION_RED', DEFAULT_PCT_RED),
        },
        weeklyAllPct: {
            amber: parsePctEnv('QUOTA_THRESHOLD_WEEKLY_AMBER', DEFAULT_PCT_AMBER),
            red: parsePctEnv('QUOTA_THRESHOLD_WEEKLY_RED', DEFAULT_PCT_RED),
        },
        weeklySonnetPct: {
            amber: parsePctEnv('QUOTA_THRESHOLD_SONNET_AMBER', DEFAULT_PCT_AMBER),
            red: parsePctEnv('QUOTA_THRESHOLD_SONNET_RED', DEFAULT_PCT_RED),
        },
        weeklyDesignPct: {
            amber: parsePctEnv('QUOTA_THRESHOLD_DESIGN_AMBER', DEFAULT_PCT_AMBER),
            red: parsePctEnv('QUOTA_THRESHOLD_DESIGN_RED', DEFAULT_PCT_RED),
        },
        // Bucket especial: rutinas diarias (X / 15)
        dailyRoutines: {
            amber: parseIntEnv('QUOTA_THRESHOLD_ROUTINES_AMBER', DEFAULT_ROUTINES_AMBER, 15),
            red: parseIntEnv('QUOTA_THRESHOLD_ROUTINES_RED', DEFAULT_ROUTINES_RED, 15),
            max: 15,
        },
        // Bucket especial: overage USD (% del cap)
        apiOveragePct: {
            amber: parsePctEnv('QUOTA_THRESHOLD_OVERAGE_AMBER', DEFAULT_OVERAGE_AMBER),
            red: parsePctEnv('QUOTA_THRESHOLD_OVERAGE_RED', DEFAULT_OVERAGE_RED),
        },
    });
}

// -----------------------------------------------------------------------------
// Clasificación semántica
// -----------------------------------------------------------------------------

/**
 * Clasifica un valor pct contra la tabla [amber, red] del bucket dado.
 * Devuelve uno de: 'ok' | 'warn' | 'crit'.
 *
 * Microcopy CA-UX-3 / narrativa §2.4 sugerido por status:
 *   - 'ok'   < 25 → "OK · uso bajo"
 *   - 'ok'   25-amber → "OK · uso normal"
 *   - 'warn' >= amber → "Atencion · supera Y%"
 *   - 'crit' >= red → "Critico · supera Z%"
 *
 * El microcopy textual lo construye el caller (banner / `/status`) usando
 * `microcopyForPct()`.
 */
function classifyPct(pct, thresholds) {
    if (!Number.isFinite(pct) || pct < 0) return 'unknown';
    const amber = Number.isFinite(thresholds && thresholds.amber) ? thresholds.amber : DEFAULT_PCT_AMBER;
    const red = Number.isFinite(thresholds && thresholds.red) ? thresholds.red : DEFAULT_PCT_RED;
    if (pct >= red) return 'crit';
    if (pct >= amber) return 'warn';
    return 'ok';
}

/**
 * Microcopy CA-UX-3 derivado del status + valor numérico del bucket pct.
 */
function microcopyForPct(pct, thresholds) {
    const status = classifyPct(pct, thresholds);
    const amber = (thresholds && Number.isFinite(thresholds.amber)) ? thresholds.amber : DEFAULT_PCT_AMBER;
    const red = (thresholds && Number.isFinite(thresholds.red)) ? thresholds.red : DEFAULT_PCT_RED;
    if (status === 'crit') return `Critico · supera ${red}%`;
    if (status === 'warn') return `Atencion · supera ${amber}%`;
    if (status === 'ok' && pct < 25) return 'OK · uso bajo';
    if (status === 'ok') return 'OK · uso normal';
    return 'Sin dato';
}

/**
 * Clasifica el bucket de rutinas diarias (entero 0..15).
 */
function classifyRoutines(used, thresholds) {
    if (!Number.isFinite(used) || used < 0) return 'unknown';
    const amber = (thresholds && Number.isFinite(thresholds.amber)) ? thresholds.amber : DEFAULT_ROUTINES_AMBER;
    const red = (thresholds && Number.isFinite(thresholds.red)) ? thresholds.red : DEFAULT_ROUTINES_RED;
    if (used >= red) return 'crit';
    if (used >= amber) return 'warn';
    return 'ok';
}

function microcopyForRoutines(used, thresholds) {
    const max = (thresholds && Number.isFinite(thresholds.max)) ? thresholds.max : 15;
    const remaining = Math.max(0, max - used);
    return `${remaining} disponibles hoy`;
}

/**
 * Clasifica el bucket de overage USD según el porcentaje usado del cap.
 * Si `capUsd` es 0 o no está definido, se trata como "sin overage habilitado":
 * verde fijo ($0 / $0).
 */
function classifyOverage(usedUsd, capUsd, thresholds) {
    if (!Number.isFinite(usedUsd) || usedUsd < 0) return 'unknown';
    if (!Number.isFinite(capUsd) || capUsd <= 0) {
        return usedUsd === 0 ? 'ok' : 'warn';
    }
    const pct = (usedUsd / capUsd) * 100;
    const amber = (thresholds && Number.isFinite(thresholds.amber)) ? thresholds.amber : DEFAULT_OVERAGE_AMBER;
    const red = (thresholds && Number.isFinite(thresholds.red)) ? thresholds.red : DEFAULT_OVERAGE_RED;
    if (pct >= red) return 'crit';
    if (pct >= amber) return 'warn';
    return 'ok';
}

function microcopyForOverage(usedUsd, capUsd) {
    if (!Number.isFinite(usedUsd) || usedUsd < 0) return 'Sin dato';
    if (!Number.isFinite(capUsd) || capUsd <= 0) {
        return usedUsd === 0 ? 'OK · sin overage activo' : 'Atencion · overage sin cap';
    }
    const pct = (usedUsd / capUsd) * 100;
    if (pct === 0) return 'OK · sin overage activo';
    if (pct < 50) return 'OK · uso moderado';
    if (pct < 80) return 'Atencion · uso alto';
    return 'Critico · uso casi al cap';
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = {
    getThresholds,
    classifyPct,
    microcopyForPct,
    classifyRoutines,
    microcopyForRoutines,
    classifyOverage,
    microcopyForOverage,
    // Defaults expuestos para tests
    DEFAULT_PCT_AMBER,
    DEFAULT_PCT_RED,
    DEFAULT_ROUTINES_AMBER,
    DEFAULT_ROUTINES_RED,
    DEFAULT_OVERAGE_AMBER,
    DEFAULT_OVERAGE_RED,
};

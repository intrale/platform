// =============================================================================
// quota-adapters/_shape.js — Contrato común que devuelven todos los adapters
// de cuota multi-provider (#3092 + #3065 §5.4).
//
// Diseño:
//
//   * El consumidor (banner del dashboard, quota-exhausted, calibrador) lee un
//     único shape independiente del provider. Las diferencias por provider
//     viven exclusivamente DENTRO del adapter — no se filtran al caller.
//
//   * Backward-compat con `computeQuota` (legacy Anthropic only): cuando el
//     adapter es 'anthropic' y `adapterStatus === 'ok'`, el shape devuelto
//     contiene **byte-a-byte** los mismos campos que la función legacy
//     (`hoursUsed7d`, `pct`, `status`, `session.pct`, `calibration`, ...).
//     Esto es requisito de regresión cero del banner (CA original + UX G5).
//
//   * Estados del adapter (security CA-#3 + UX G1): el caller debe distinguir
//     "0% real" (cuota disponible) de "estado degradado" (no sabemos cuánto
//     se consumió). Ese discriminante vive en `adapterStatus`, NO en `pct=0`.
//     Usar 0% silencioso cuando el adapter falló es UX-bug grave: el operador
//     asume cuota infinita y el sistema sigue gastando.
//
//   * Reset semantics distintos por provider (security CA-#5 + UX G6): el shape
//     incluye `nextResetAt` por provider. El banner muestra countdown por
//     adapter, no un único countdown global cuando hay breakdown[].
//
// Estados posibles de `adapterStatus`:
//
//   - 'ok'              → adapter funcional, datos confiables.
//   - 'unknown'         → adapter no pudo calcular (datos faltantes, archivo
//                          ausente). NO es 'error': es ausencia de signal.
//   - 'error'           → adapter falló (parser roto, archivo corrupto). El
//                          operador debe revisar `errorReason`.
//   - 'not_implemented' → provider declarado pero el adapter no está hecho
//                          todavía (e.g. OpenAI/Codex stub durante M2a).
//   - 'no_quota'        → provider no tiene cuota (e.g. Ollama local). pct
//                          siempre `null`, status siempre 'no_quota'.
//
// Estados posibles de `status` (cuota propiamente dicha — solo válidos cuando
// `adapterStatus === 'ok'`):
//
//   - 'ok'       → < 50% de uso.
//   - 'normal'   → 50% ≤ uso < 75%.
//   - 'warning'  → 75% ≤ uso < 90%.
//   - 'critical' → uso ≥ 90%.
//   - 'unknown'  → propagado desde adapterStatus cuando no se puede calcular.
//
// =============================================================================
'use strict';

/**
 * @typedef {Object} QuotaSession
 *   Sub-shape de la sesión rolling (5h en Anthropic, distinto por provider).
 * @property {number|null} hoursUsed
 * @property {number|null} sessionsCount
 * @property {number|null} limitHours
 * @property {number|null} pct
 * @property {number|null} realPct      Pct calibrado contra dato real (cap 100).
 * @property {number|null} realPctRaw   Pct calibrado SIN capear (debug/saturación).
 * @property {boolean}      realPctCapped
 * @property {string}      realStatus
 * @property {number|null} hoursRemaining
 * @property {string}      status
 */

/**
 * @typedef {Object} QuotaBreakdownEntry
 *   Una entrada del breakdown[] cuando hay múltiples providers activos.
 *   Forward-compat para Fase 2 cross-provider (UX G2).
 * @property {string}      provider
 * @property {string}      adapterStatus
 * @property {number|null} pct
 * @property {string}      status
 * @property {number|null} hoursUsed
 */

/**
 * @typedef {Object} QuotaResult
 *   Shape canónico que TODOS los adapters devuelven. Cuando un campo no aplica
 *   al provider, se pone `null` (no `0`, no `undefined`).
 *
 * @property {string}              provider           Nombre del provider que respondió.
 * @property {string}              adapterStatus      Estado del adapter (ver constantes ADAPTER_STATUS).
 * @property {string|null}         errorReason        Copy accionable cuando adapterStatus != 'ok'.
 * @property {number}              schemaVersion      Versión del shape (= 2 en M2).
 *
 * @property {number|null}         hoursUsed7d
 * @property {number|null}         sessionsCount7d
 * @property {number|null}         hoursLast24h
 * @property {number|null}         effectiveLimitHours
 * @property {number|null}         configLimitHours
 * @property {number|null}         pct
 * @property {number|null}         realPct
 * @property {number|null}         realPctRaw
 * @property {boolean}             realPctCapped
 * @property {string}              realStatus
 * @property {number|null}         hoursRemaining
 * @property {number|null}         burnRatePerDay
 * @property {number|null}         daysToLimit
 * @property {string}              status              Cuota propiamente dicha (ok/normal/warning/critical) o 'unknown' si adapter falló.
 * @property {number}              adjustmentsCount
 * @property {number|null}         observedMaxHours
 * @property {string|null}         observedMaxAt
 * @property {boolean}             autoAdjusted
 * @property {string|null}         lastResetAt
 * @property {string|null}         nextResetAt
 * @property {number|null}         daysToReset
 *
 * @property {QuotaSession}        session
 *
 * @property {Object|null}         calibration
 * @property {Array<Object>}       calibrations
 * @property {number}              weeklyResetDriftMin
 * @property {number|null}         calibrationAgeDays
 * @property {boolean}             calibrationStale
 * @property {string|null}         sessionResetsAt
 * @property {string|null}         weeklyResetsAtReported
 *
 * @property {QuotaBreakdownEntry[]} breakdown          Forward-compat (UX G2).
 */

// Constantes públicas — usadas por adapters y tests para evitar typos.
const ADAPTER_STATUS = Object.freeze({
    OK: 'ok',
    UNKNOWN: 'unknown',
    ERROR: 'error',
    NOT_IMPLEMENTED: 'not_implemented',
    NO_QUOTA: 'no_quota',
});

const QUOTA_STATUS = Object.freeze({
    OK: 'ok',
    NORMAL: 'normal',
    WARNING: 'warning',
    CRITICAL: 'critical',
    UNKNOWN: 'unknown',
    NO_QUOTA: 'no_quota',
});

const SCHEMA_VERSION = 2;

/**
 * Construye un QuotaResult "vacío" para estados degradados/desconocidos.
 * Todos los campos numéricos quedan en `null` (no `0`) para que el banner
 * pueda distinguir "0% real" de "estado degradado" (security CA-#3 + UX G1).
 *
 * @param {string} provider
 * @param {string} adapterStatus
 * @param {string|null} errorReason
 * @returns {QuotaResult}
 */
function emptyResult(provider, adapterStatus, errorReason = null) {
    const status = adapterStatus === ADAPTER_STATUS.NO_QUOTA
        ? QUOTA_STATUS.NO_QUOTA
        : QUOTA_STATUS.UNKNOWN;
    return {
        provider,
        adapterStatus,
        errorReason,
        schemaVersion: SCHEMA_VERSION,

        hoursUsed7d: null,
        sessionsCount7d: null,
        hoursLast24h: null,
        effectiveLimitHours: null,
        configLimitHours: null,
        pct: null,
        realPct: null,
        realPctRaw: null,
        realPctCapped: false,
        realStatus: status,
        hoursRemaining: null,
        burnRatePerDay: null,
        daysToLimit: null,
        status,
        adjustmentsCount: 0,
        observedMaxHours: null,
        observedMaxAt: null,
        autoAdjusted: false,
        lastResetAt: null,
        nextResetAt: null,
        daysToReset: null,

        session: {
            hoursUsed: null,
            sessionsCount: null,
            limitHours: null,
            pct: null,
            realPct: null,
            realPctRaw: null,
            realPctCapped: false,
            realStatus: status,
            hoursRemaining: null,
            status,
        },

        calibration: null,
        calibrations: [],
        weeklyResetDriftMin: 0,
        calibrationAgeDays: null,
        calibrationStale: false,
        sessionResetsAt: null,
        weeklyResetsAtReported: null,

        breakdown: [],
    };
}

module.exports = {
    ADAPTER_STATUS,
    QUOTA_STATUS,
    SCHEMA_VERSION,
    emptyResult,
};

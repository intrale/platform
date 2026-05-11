// =============================================================================
// quota-adapters/anthropic.js — Adapter Anthropic Plan Max (#3092 + #3065 §5.4).
//
// Estrategia:
//
//   * Anthropic NO expone API pública del uso del Plan Max, así que el
//     pipeline aproxima sumando `duration_ms` de eventos `session:end` del
//     activity-log. Esa heurística vive en `weekly-quota.js#computeQuota`,
//     se mantiene intacta y el adapter la **delega** sin reimplementar.
//
//   * Adicionalmente, el operador puede calibrar contra dato real de
//     claude.ai (snapshots #3055/#3057 + EMA #3008) — esos campos vienen
//     ya incluidos en `computeQuota`, así que pasan transparentes al shape.
//
//   * Reset semantics — domingo 21:00 hora local (ART por default), con
//     drift de TZ persistido si el operador reporta otra hora en calibración.
//
// Backward-compat byte-a-byte (regresión cero del banner):
//
//   * Cuando `adapterStatus === 'ok'`, el shape devuelto por este adapter
//     es **idéntico** al que devolvía `computeQuota` en M1, con tres
//     campos nuevos no-rompedores: `provider`, `adapterStatus`, `errorReason`,
//     `schemaVersion`, `breakdown`.
//
//   * El test de regresión `weekly-quota.test.js` verifica esto con assertions
//     campo-a-campo sobre el subset que el banner consume (UX G5 + security
//     CA-#7).
// =============================================================================
'use strict';

const { ADAPTER_STATUS, SCHEMA_VERSION, emptyResult } = require('./_shape');

/**
 * Adapter Anthropic. Recibe sessionData y devuelve un QuotaResult.
 *
 * Errores → fail-secure (devuelve emptyResult con motivo, no lanza).
 *
 * @param {Object} sessionData
 *   @property {string} metricsDir        path a .pipeline/metrics
 *   @property {string} activityLogPath   path a .claude/activity-log.jsonl
 *   @property {number} [configLimitHours]
 * @returns {QuotaResult}
 */
function anthropicAdapter(sessionData) {
    const metricsDir = sessionData && sessionData.metricsDir;
    const activityLogPath = sessionData && sessionData.activityLogPath;

    if (typeof metricsDir !== 'string' || metricsDir.length === 0) {
        return emptyResult('anthropic', ADAPTER_STATUS.ERROR,
            'metricsDir requerido para adapter Anthropic');
    }
    if (typeof activityLogPath !== 'string' || activityLogPath.length === 0) {
        return emptyResult('anthropic', ADAPTER_STATUS.ERROR,
            'activityLogPath requerido para adapter Anthropic');
    }

    // Cargar la lógica legacy. require dinámico para evitar ciclo
    // weekly-quota → quota-adapters → weekly-quota.
    const weekly = require('../weekly-quota');
    const opts = {};
    if (sessionData.configLimitHours) {
        opts.configLimitHours = sessionData.configLimitHours;
    }

    let legacy;
    try {
        legacy = weekly.computeQuota(metricsDir, activityLogPath, opts);
    } catch (err) {
        const reason = err && err.message ? String(err.message).slice(0, 200) : 'unknown';
        return emptyResult('anthropic', ADAPTER_STATUS.ERROR,
            `Cuota Anthropic: error calculando (${reason})`);
    }

    // Defensa: computeQuota nunca debería devolver null/undefined, pero
    // si pasa, lo tratamos como estado degradado.
    if (!legacy || typeof legacy !== 'object') {
        return emptyResult('anthropic', ADAPTER_STATUS.UNKNOWN,
            'Cuota Anthropic: computeQuota devolvió shape inválido');
    }

    // Wrappear el shape legacy con el envelope multi-provider. Backward-compat:
    // todos los campos legacy quedan exactamente como estaban.
    return {
        ...legacy,
        provider: 'anthropic',
        adapterStatus: ADAPTER_STATUS.OK,
        errorReason: null,
        schemaVersion: SCHEMA_VERSION,
        breakdown: [],
    };
}

module.exports = anthropicAdapter;

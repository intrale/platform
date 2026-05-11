// =============================================================================
// quota-adapters/openai-codex.js — Stub para OpenAI/Codex provider (#3092 M2a).
//
// Por qué stub:
//
//   * #3075 (H3 — adapter OpenAI/Codex completo) está OPEN con label
//     `needs-human` y `size:large`. El pipeline no procesa H3 hasta que
//     un humano lo destrabe.
//
//   * Para no bloquear M2 (este issue) detrás de #3075, partimos en M2a
//     (refactor + Anthropic real, este commit) y M2b (OpenAI real, depende
//     de H3 destrabado). Recomendación de planning del análisis Guru.
//
//   * El stub devuelve `adapterStatus: 'not_implemented'` con `pct: null`
//     (NO `pct: 0`, eso sería bug grave UX/security — "luz verde silenciosa").
//
// Hard cap del budget (security CA-#2 — se enforce ya en M2a aunque la lógica
// de cálculo todavía no exista):
//
//   * `MAX_MONTHLY_BUDGET_USD` hardcoded — la config NO puede superar este
//     valor. Si lo intenta, el adapter devuelve `error` con motivo (en M2b
//     será una validación al boot).
// =============================================================================
'use strict';

const { ADAPTER_STATUS, emptyResult } = require('./_shape');

// Hard cap del budget mensual (security CA-#2). Se enforce desde M2a aunque
// la lógica de cálculo real recién entre con M2b/#3075. Cambiar este valor
// requiere revisión humana — un PR malicioso que lo suba a $999_999 desactiva
// la detección de cuota agotada y permite gasto descontrolado.
const MAX_MONTHLY_BUDGET_USD = 1000;

/**
 * Adapter OpenAI/Codex (stub). Devuelve `not_implemented` salvo que la
 * config tenga un budget inválido (>cap) — en ese caso devuelve `error`
 * para alertar al operador antes de M2b.
 *
 * @param {Object} sessionData
 * @returns {QuotaResult}
 */
function openaiCodexAdapter(sessionData) {
    // Defensa preventiva del cap del budget — incluso siendo stub, validamos
    // si llega un budget para que cuando M2b lo implemente real, ya tenga
    // el guard rail.
    const budget = sessionData && sessionData.budgetUsd;
    if (budget != null) {
        if (typeof budget !== 'number' || !Number.isFinite(budget) || budget < 0) {
            return emptyResult('openai-codex', ADAPTER_STATUS.ERROR,
                'Cuota OpenAI: budgetUsd debe ser número finito >= 0');
        }
        if (budget > MAX_MONTHLY_BUDGET_USD) {
            return emptyResult('openai-codex', ADAPTER_STATUS.ERROR,
                `Cuota OpenAI: budget USD (${budget}) excede el cap hardcoded (${MAX_MONTHLY_BUDGET_USD}) — revisar config`);
        }
    }

    // Estado stub. El banner del dashboard debe renderizar copy específico
    // ("Cuota OpenAI/Codex: pendiente de implementar — ver #3075") en lugar
    // del banner de cuota agotada (security CA-#3 + UX G1/G4).
    return emptyResult('openai-codex', ADAPTER_STATUS.NOT_IMPLEMENTED,
        'Cuota OpenAI/Codex: adapter pendiente — ver #3075 (M2b)');
}

// Exportar el cap para que tests + futuro M2b lo verifiquen.
openaiCodexAdapter.MAX_MONTHLY_BUDGET_USD = MAX_MONTHLY_BUDGET_USD;

module.exports = openaiCodexAdapter;

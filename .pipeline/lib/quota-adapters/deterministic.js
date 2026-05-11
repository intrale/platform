// =============================================================================
// quota-adapters/deterministic.js — Adapter para skills determinísticos.
//
// Los skills marcados como `provider: deterministic` (e.g. `builder`, `tester`
// cuando no LLM-augmented) NO consumen cuota de ningún plan. Devolver
// `no_quota` permite que el dashboard renderice el estado correctamente
// y no acumule "0%" engañosos en el agregado.
// =============================================================================
'use strict';

const { ADAPTER_STATUS, emptyResult } = require('./_shape');

function deterministicAdapter(_sessionData) {
    return emptyResult('deterministic', ADAPTER_STATUS.NO_QUOTA,
        'Cuota deterministic: provider sin LLM, no consume cuota');
}

module.exports = deterministicAdapter;

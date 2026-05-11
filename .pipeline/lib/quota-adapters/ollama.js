// =============================================================================
// quota-adapters/ollama.js — Adapter Ollama local (#3092 M2a).
//
// Ollama corre local (sin API remota, sin cuota): los modelos se sirven
// desde la máquina del operador, así que no hay cuota propiamente dicha.
//
// Estado canónico: `adapterStatus: 'no_quota'`. El banner debe leerlo como
// "no hay cuota que mostrar para este provider" y NO como "0% / disponible
// infinito".
// =============================================================================
'use strict';

const { ADAPTER_STATUS, emptyResult } = require('./_shape');

function ollamaAdapter(_sessionData) {
    return emptyResult('ollama', ADAPTER_STATUS.NO_QUOTA,
        'Cuota Ollama: provider local sin cuota remota');
}

module.exports = ollamaAdapter;

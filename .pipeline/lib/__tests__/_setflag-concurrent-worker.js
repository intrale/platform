// =============================================================================
// _setflag-concurrent-worker.js — Worker forkeado para el test de concurrencia
// de `quotaExhausted.setFlag` (#3575 CA-5).
//
// Recibe por argv:
//   [2] tmpDir           — sandbox para PIPELINE_DIR_OVERRIDE
//   [3] provider         — provider de la allowlist KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER
//   [4] errorType        — error_type a persistir (debe ser de la allowlist del provider)
//
// Comportamiento:
//   - Fail-closed (exit 2) si provider no está en la allowlist (SR-5 #3435).
//   - Fail-closed (exit 3) si errorType no está en la allowlist del provider
//     (SR-7 #3435).
//   - exit 0 al persistir setFlag correctamente.
//   - exit 1 ante cualquier excepción inesperada del módulo.
//
// Por contrato del test:
//   - argv SOLO contiene datos sintéticos (sin secrets, sin keys).
//   - El worker NO escribe fuera de tmpDir (PIPELINE_DIR_OVERRIDE).
// =============================================================================
'use strict';

const [, , tmpDir, provider, errorType] = process.argv;

if (!tmpDir || !provider || !errorType) {
    console.error('worker: missing args (tmpDir/provider/errorType)');
    process.exit(4);
}

process.env.PIPELINE_DIR_OVERRIDE = tmpDir;

let quotaExhausted;
try {
    quotaExhausted = require('../quota-exhausted');
} catch (err) {
    console.error(`worker: failed to load quota-exhausted: ${err.message}`);
    process.exit(1);
}

// Fail-closed: provider debe estar en la allowlist canónica.
const allowedTypes = (quotaExhausted.KNOWN_QUOTA_ERROR_TYPES_BY_PROVIDER || {})[provider];
if (!allowedTypes) {
    console.error(`worker: provider ${provider} not in allowlist`);
    process.exit(2);
}
if (!allowedTypes.includes(errorType)) {
    console.error(`worker: errorType ${errorType} not in allowlist for ${provider}`);
    process.exit(3);
}

try {
    quotaExhausted.setFlag({
        errorType,
        provider,
        // No incluimos rawExcerpt para no introducir contexto sensible.
        auditLogEnabled: false,
    });
    process.exit(0);
} catch (err) {
    console.error(`worker: setFlag threw: ${err.message}`);
    process.exit(1);
}

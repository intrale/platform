// =============================================================================
// commander/provider-error-parser.js — RE-EXPORT SHIM (#3575)
//
// Este módulo se migró a `lib/agent-launcher/provider-error-parser.js` como
// primera entrega del split de #3435. Aquí queda un shim estático para no
// romper callers existentes:
//
//   - `lib/commander/__tests__/provider-error-parser.test.js`
//   - `lib/commander/__tests__/anthropic-1m-workaround.test.js`
//   - `lib/commander/multi-provider.js:713`
//
// CONTRATO DE SEGURIDAD (NEW-5 de #3435)
// --------------------------------------
// El require DEBE ser un string literal estático — sin variables, sin
// templates, sin process.env, sin concatenación. Cualquier require dinámico
// abre vector de path traversal y viola el contrato del análisis security.
// La verificación pre-merge es:
//
//   grep -E "require\(['\"]\.\./agent-launcher/provider-error-parser['\"]\)" \
//        .pipeline/lib/commander/provider-error-parser.js
//
// y el negativo (no debe matchear nada):
//
//   grep -E "require\(.*\$\{|require\(.*\+|require\(process\.env" \
//        .pipeline/lib/commander/provider-error-parser.js
//
// EMISIÓN DEL warn
// ----------------
// El console.warn se emite una sola vez por proceso (flag module-level). El
// mensaje es literal: sin process.argv, sin env, sin stack trace dinámico —
// para evitar leak de contexto sensible a logs (defensa heredada SR-2).
// =============================================================================
'use strict';

let warned = false;
if (!warned) {
    warned = true;
    // Mensaje literal por contrato — no parametrizar con datos dinámicos.
    console.warn('[deprecated] lib/commander/provider-error-parser → lib/agent-launcher/provider-error-parser');
}

module.exports = require('../agent-launcher/provider-error-parser');

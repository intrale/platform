#!/usr/bin/env node
// =============================================================================
// smoke-multiprovider.js — thin wrapper del harness multi-provider (#3785).
//
// Existe SÓLO para satisfacer el path discoverable pedido en el issue #3785.
// NO reimplementa nada: delega 1:1 en el CLI canónico
// `.pipeline/tools/multi-provider-smoke-test.js` (#3680), preservando toda su
// lógica, seguridad (redacción, data-residency, caps, audit hash-chain) y flags.
//
// Uso (idéntico al CLI real; todos los args se pasan tal cual):
//   node .pipeline/scripts/smoke-multiprovider.js --dry-run --format=markdown
//   node .pipeline/scripts/smoke-multiprovider.js --telegram
//
// Decisión de scope (PO #3785): opción B — wrapper/renderer sobre el CLI
// existente, NO script nuevo con stubs hardcodeados (evita duplicar la matriz
// skill×provider y regresión de seguridad).
// =============================================================================
'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.resolve(__dirname, '..', 'tools', 'multi-provider-smoke-test.js');
// spawn (no require) para preservar exit codes y stdout/stderr del CLI intactos,
// y evitar side-effects de doble ejecución del módulo. Args en array → sin
// command injection (REQ-SEC-4).
const res = spawnSync(process.execPath, [CLI, ...process.argv.slice(2)], {
    stdio: 'inherit',
    windowsHide: true,
});
if (res.error) {
    process.stderr.write(`[smoke-multiprovider] no se pudo ejecutar el CLI: ${res.error.message}\n`);
    process.exit(1);
}
process.exit(typeof res.status === 'number' ? res.status : 1);

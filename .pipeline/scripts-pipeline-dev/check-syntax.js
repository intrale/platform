#!/usr/bin/env node
// check-syntax.js <archivo.js> [<archivo2.js> ...]
// Wrapper sobre `node --check` que valida sintaxis de uno o varios archivos JS
// y devuelve un reporte JSON consolidado. Reemplaza la lectura LLM + razonamiento.
//
// Exit codes:
//   0 = todos los archivos con sintaxis valida
//   1 = al menos uno con error
//   2 = error de uso

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

function usage() {
    console.error('Uso: node check-syntax.js <archivo.js> [<archivo2.js> ...]');
    process.exit(2);
}

const files = process.argv.slice(2);
if (files.length === 0) usage();

const results = [];
let allOk = true;

for (const file of files) {
    const abs = path.resolve(file);
    const result = { file: abs, ok: false, error: null };

    if (!fs.existsSync(abs)) {
        result.error = 'archivo no existe';
        results.push(result);
        allOk = false;
        continue;
    }

    const proc = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8' });
    if (proc.status === 0) {
        result.ok = true;
    } else {
        result.error = (proc.stderr || proc.stdout || `exit ${proc.status}`).trim();
        allOk = false;
    }
    results.push(result);
}

console.log(JSON.stringify({ all_ok: allOk, results }, null, 2));
process.exit(allOk ? 0 : 1);

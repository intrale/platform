#!/usr/bin/env node
// validate-json.js <archivo.json> [<archivo2.json> ...]
// Parsea archivos JSON del pipeline y reporta sintaxis valida o invalida.
// Reemplaza el patron LLM-parsea-y-razona por una invocacion determinista.
//
// Exit codes:
//   0 = todos los archivos validos
//   1 = al menos uno invalido
//   2 = error de uso

const fs = require('fs');
const path = require('path');

function usage() {
    console.error('Uso: node validate-json.js <archivo.json> [<archivo2.json> ...]');
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

    let raw;
    try {
        raw = fs.readFileSync(abs, 'utf8');
    } catch (err) {
        result.error = `read error: ${err.message}`;
        results.push(result);
        allOk = false;
        continue;
    }

    try {
        JSON.parse(raw);
        result.ok = true;
    } catch (err) {
        result.error = err.message;
        allOk = false;
    }

    results.push(result);
}

console.log(JSON.stringify({ all_ok: allOk, results }, null, 2));
process.exit(allOk ? 0 : 1);

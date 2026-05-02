#!/usr/bin/env node
// check-pid.js <archivo.pid>
// Verifica que un archivo .pid del pipeline contiene un PID vivo.
// Reemplaza la combinacion Bash + razonamiento del agente.
//
// Exit codes:
//   0 = PID vivo
//   1 = PID muerto
//   2 = archivo no existe o contenido invalido
//   3 = error de uso

const fs = require('fs');
const path = require('path');

function usage() {
    console.error('Uso: node check-pid.js <archivo.pid>');
    process.exit(3);
}

const file = process.argv[2];
if (!file) usage();

const abs = path.resolve(file);
if (!fs.existsSync(abs)) {
    console.log(JSON.stringify({ ok: false, reason: 'pid_file_missing', file: abs }));
    process.exit(2);
}

let raw;
try {
    raw = fs.readFileSync(abs, 'utf8').trim();
} catch (err) {
    console.log(JSON.stringify({ ok: false, reason: 'pid_file_read_error', error: err.message }));
    process.exit(2);
}

const pid = Number.parseInt(raw, 10);
if (!Number.isInteger(pid) || pid <= 0) {
    console.log(JSON.stringify({ ok: false, reason: 'pid_invalid', raw }));
    process.exit(2);
}

let alive = false;
try {
    process.kill(pid, 0);
    alive = true;
} catch (err) {
    if (err.code === 'EPERM') {
        // EPERM significa que el proceso existe pero no podemos enviarle senales.
        alive = true;
    } else {
        alive = false;
    }
}

console.log(JSON.stringify({ ok: alive, pid, file: abs, reason: alive ? 'alive' : 'dead' }));
process.exit(alive ? 0 : 1);

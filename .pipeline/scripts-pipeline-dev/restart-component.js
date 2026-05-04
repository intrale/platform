#!/usr/bin/env node
// restart-component.js <nombre>
// Reinicia un componente residente del pipeline (pulpo, dashboard, listener, watchdog, multimedia)
// matando el PID actual (si existe) y dejando que restart.js lo levante en el proximo ciclo.
// Reemplaza la secuencia Bash + razonamiento del agente pipeline-dev.
//
// Exit codes:
//   0 = senal enviada (o componente ya muerto)
//   1 = error matando el proceso
//   2 = error de uso o componente desconocido
//   3 = pid file ilegible

const fs = require('fs');
const path = require('path');

const COMPONENTS = {
    pulpo: 'pulpo.pid',
    dashboard: 'dashboard.pid',
    listener: 'listener.pid',
    watchdog: 'watchdog.pid',
    multimedia: 'multimedia.pid',
};

function usage() {
    const names = Object.keys(COMPONENTS).join('|');
    console.error(`Uso: node restart-component.js <${names}> [--signal SIGTERM]`);
    process.exit(2);
}

const args = process.argv.slice(2);
if (args.length === 0) usage();

const name = args.find(a => !a.startsWith('--'));
if (!name || !COMPONENTS[name]) usage();

const sigArgIdx = args.indexOf('--signal');
const signal = sigArgIdx >= 0 ? args[sigArgIdx + 1] : 'SIGTERM';

const pidFile = path.resolve(__dirname, '..', COMPONENTS[name]);

if (!fs.existsSync(pidFile)) {
    console.log(JSON.stringify({ ok: true, component: name, action: 'no_pid_file', pid_file: pidFile }));
    process.exit(0);
}

let raw;
try {
    raw = fs.readFileSync(pidFile, 'utf8').trim();
} catch (err) {
    console.log(JSON.stringify({ ok: false, component: name, error: `read error: ${err.message}` }));
    process.exit(3);
}

const pid = Number.parseInt(raw, 10);
if (!Number.isInteger(pid) || pid <= 0) {
    console.log(JSON.stringify({ ok: false, component: name, error: 'pid invalido', raw }));
    process.exit(3);
}

try {
    process.kill(pid, signal);
    console.log(JSON.stringify({ ok: true, component: name, action: 'signal_sent', pid, signal }));
    process.exit(0);
} catch (err) {
    if (err.code === 'ESRCH') {
        console.log(JSON.stringify({ ok: true, component: name, action: 'already_dead', pid }));
        process.exit(0);
    }
    console.log(JSON.stringify({ ok: false, component: name, pid, error: err.message }));
    process.exit(1);
}

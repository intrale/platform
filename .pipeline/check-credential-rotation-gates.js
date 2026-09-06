#!/usr/bin/env node
/**
 * Verificador de los gates de rollout de la rotación sin reinicio (#5802).
 *
 * El runbook `docs/runbooks/credential-rotation.md` ofrece dos caminos de cierre
 * y cuál corresponde NO es una decisión del operador: la fija la configuración.
 * Este script es el paso de precondición de ese runbook, y existe para que la
 * respuesta salga de leer el config real y no de la memoria de nadie.
 *
 * Fail-closed, igual que los gates que inspecciona: sólo el booleano `true`
 * exacto abre. Un `"true"` string, un `1`, una clave ausente o un config
 * ilegible dejan el gate cerrado — y por lo tanto mandan al camino A (con
 * reinicio), que es el conservador.
 *
 * Uso:
 *   node .pipeline/check-credential-rotation-gates.js          # texto para el operador
 *   node .pipeline/check-credential-rotation-gates.js --json   # para scripts
 *
 * Exit code: 0 si los tres gates están abiertos, 1 si alguno está cerrado.
 * Nunca imprime material de credenciales: sólo nombres de clave y booleanos.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

/** Ruta canónica del config del pipeline, relativa a este archivo. */
const CONFIG_PATH = path.join(__dirname, 'config.yaml');

/**
 * Los tres gates que habilitan la rotación sin reinicio, con el path exacto que
 * el operador tiene que buscar en `config.yaml`. El orden es el del runbook.
 */
const GATES = Object.freeze([
    { key: 'pipeline.credential_snapshot_enabled', get: (c) => c && c.pipeline && c.pipeline.credential_snapshot_enabled },
    { key: 'pipeline.credential_retry_enabled', get: (c) => c && c.pipeline && c.pipeline.credential_retry_enabled },
    { key: 'vault.enabled', get: (c) => c && c.vault && c.vault.enabled },
]);

/**
 * Lee el config sin explotar. Un config ilegible no es motivo para asumir que
 * los gates están abiertos: se devuelve `null` y todos quedan cerrados.
 */
function leerConfig(configPath = CONFIG_PATH) {
    try {
        return yaml.load(fs.readFileSync(configPath, 'utf8'));
    } catch {
        return null;
    }
}

/**
 * Estado de los tres gates.
 *
 * @returns {{ gates: Array<{key: string, value: *, open: boolean}>, allOpen: boolean }}
 */
function checkGates(config = leerConfig()) {
    const gates = GATES.map(({ key, get }) => {
        const value = get(config);
        return { key, value, open: value === true };
    });
    return { gates, allOpen: gates.every((g) => g.open) };
}

function main(argv = process.argv.slice(2)) {
    const { gates, allOpen } = checkGates();

    if (argv.includes('--json')) {
        console.log(JSON.stringify({ gates, allOpen }, null, 2));
    } else {
        for (const g of gates) {
            const estado = g.open ? 'ABIERTO' : 'cerrado';
            const valor = g.value === undefined ? '(ausente)' : JSON.stringify(g.value);
            console.log(`  ${estado.padEnd(8)} ${g.key} = ${valor}`);
        }
        console.log('');
        console.log(allOpen
            ? 'GATES ABIERTOS -> camino B (sin reinicio)'
            : 'GATES CERRADOS -> camino A (con reinicio): cerra la rotacion con `node .pipeline/restart.js`');
    }

    return allOpen ? 0 : 1;
}

if (require.main === module) {
    process.exit(main());
}

module.exports = { CONFIG_PATH, GATES, leerConfig, checkGates };

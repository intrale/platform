// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

/**
 * #7112 · CA-4 / D-2 — DIR EFÍMERO DE PRUEBAS, provisto por UN solo helper.
 *
 * Con el default invertido (#7112), un test que no declara ambiente resuelve
 * `pruebas` con `dir: null` y cualquier escritor migrado falla ruidoso. Para
 * que la suite siga verde sin reescribir los tests, el DIR de pruebas lo
 * provee el LANZADOR de la suite, en un único punto, antes de spawnear los
 * hijos: cada hijo hereda `PIPELINE_DIR_OVERRIDE` y todo escritor cae ahí.
 * Los tests que ya declaran el suyo (`with-env`) lo pisan.
 *
 * Dos lanzadores comparten este helper (Enmienda 2 de guru, "único helper, dos
 * lanzadores"): `scripts/test-pipeline.js` (antes de `run()`) y
 * `skills-deterministicos/tester.js` (en el `childEnv` de `node --test`).
 *
 * Reglas:
 *   - `mkdtemp` bajo `os.tmpdir()` — NUNCA bajo `.pipeline/tmp/` (#7406: SEC-3
 *     lo anularía y ensucia el árbol productivo).
 *   - Un dir por corrida y se BORRA al terminar, también ante fallo/señal
 *     (`exit`, `SIGINT`, `SIGTERM`): no se repite la fuga de fixtures de #7210.
 *   - Si `PIPELINE_DIR_OVERRIDE` ya venía seteado por el llamador, se respeta y
 *     NO se borra.
 *   - El helper cuenta lo que hizo en una línea al arrancar y otra al cerrar
 *     (guideline UX 4/A2): el llamador pone su prefijo vía `log`.
 *   - Cuando #7111 llegue, reemplaza el `mkdtemp` pelado por el dir provisionado
 *     completo — mismo seam, cero cambios en los escritores.
 *
 * @module test-run-dir
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** Variable que los hijos heredan como dir de pruebas (precedencia D-1, la primera). */
const ENV_DIR = 'PIPELINE_DIR_OVERRIDE';

const PREFIJO_TMP = 'pipeline-tests-';

// Archivos mínimos que hacen usable el dir pelado: el kernel lee `config.yaml`
// desde el dir resuelto (`loadConfig`) y, derivado de esa raíz, el manifiesto
// de producto `pipeline.config.json` (#5174: en el padre de `.pipeline`, o en
// el mismo dir cuando la raíz no se llama `.pipeline`, como acá). Sin ellos el
// Pulpo pausaría por "config inválida" en cada test que lo requiera. Se COPIAN
// (no se enlazan) desde el repo que lanza la suite: un test que los edite no
// toca el productivo. La provisión completa (estructura, manifiesto) es #7111.
const ARCHIVOS_BASE = Object.freeze([
    { nombre: 'config.yaml', desde: 'pipeline' },
    { nombre: 'pipeline.config.json', desde: 'repo' },
]);

// Dirs creados y todavía no borrados. UN solo handler de `exit` para todos:
// un lanzador que llama `ensureTestRunDir` muchas veces por proceso (los tests
// del propio tester) no acumula listeners.
const pendientes = new Set();
let hooksInstalados = false;

function limpiarPendientes() {
    for (const limpiar of Array.from(pendientes)) {
        try { limpiar(); } catch { /* best-effort */ }
    }
}

function instalarHooks(conSenales) {
    if (!hooksInstalados) {
        hooksInstalados = true;
        process.once('exit', limpiarPendientes);
    }
    if (conSenales && !instalarHooks.senales) {
        instalarHooks.senales = true;
        for (const senal of ['SIGINT', 'SIGTERM']) {
            process.once(senal, () => {
                limpiarPendientes();
                // Re-emitir el comportamiento por defecto: salir con el código de la señal.
                process.exit(senal === 'SIGINT' ? 130 : 143);
            });
        }
    }
}

/**
 * Crea el dir efímero (o respeta el declarado) y lo deja en `env[ENV_DIR]`.
 *
 * @param {object} [opts]
 * @param {object} [opts.env=process.env] env a mutar (los hijos lo heredan).
 * @param {(linea: string) => void} [opts.log] receptor de la línea informativa.
 * @param {string} [opts.pipelineDir] `.pipeline` del repo que lanza la suite
 *   (fuente de `ARCHIVOS_BASE`). Default: el padre de `lib/`.
 * @param {boolean} [opts.registrarLimpieza=true] cuelga el borrado de `exit`.
 * @param {boolean} [opts.registrarSenales=true] además, de `SIGINT`/`SIGTERM`
 *   (sale con 130/143 tras borrar). Un lanzador con handlers propios de señal
 *   lo apaga y llama `limpiar()` en su propio cierre.
 * @returns {{dir: string, creado: boolean, limpiar: () => boolean}}
 */
function ensureTestRunDir(opts = {}) {
    const env = opts.env && typeof opts.env === 'object' ? opts.env : process.env;
    const log = typeof opts.log === 'function' ? opts.log : () => {};
    const declarado = env[ENV_DIR];
    if (typeof declarado === 'string' && declarado.trim()) {
        const dir = path.resolve(declarado.trim());
        log(`dir de pruebas: ${dir} (declarado por el llamador, no se borra)`);
        return { dir, creado: false, limpiar: () => false };
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), PREFIJO_TMP));
    const origen = opts.pipelineDir ? path.resolve(opts.pipelineDir) : path.resolve(__dirname, '..');
    for (const { nombre, desde } of ARCHIVOS_BASE) {
        const src = desde === 'repo' ? path.join(origen, '..', nombre) : path.join(origen, nombre);
        try { fs.copyFileSync(src, path.join(dir, nombre)); } catch { /* sin base: el dir sigue siendo válido */ }
    }
    env[ENV_DIR] = dir;

    let borrado = false;
    const limpiar = () => {
        if (borrado) return false;
        borrado = true;
        pendientes.delete(limpiar);
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best-effort */ }
        if (env[ENV_DIR] === dir) delete env[ENV_DIR];
        log('dir de pruebas borrado');
        return true;
    };

    if (opts.registrarLimpieza !== false) {
        pendientes.add(limpiar);
        instalarHooks(opts.registrarSenales !== false);
    }

    log(`dir de pruebas: ${dir} (efímero, se borra al terminar)`);
    return { dir, creado: true, limpiar };
}

/** ¿`dir` está bajo `os.tmpdir()` (y no dentro de ningún `.pipeline`)? */
function esDirEfimero(dir) {
    if (typeof dir !== 'string' || !dir) return false;
    const d = path.resolve(dir);
    const tmp = path.resolve(os.tmpdir());
    return (d === tmp || d.startsWith(tmp + path.sep)) && path.basename(d).startsWith(PREFIJO_TMP);
}

module.exports = { ensureTestRunDir, esDirEfimero, ENV_DIR, PREFIJO_TMP, ARCHIVOS_BASE };

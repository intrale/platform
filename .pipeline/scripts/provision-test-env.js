#!/usr/bin/env node
'use strict';

// =============================================================================
// provision-test-env.js — CLI del provisionador del ambiente de pruebas (#7111)
//
// Cero lógica: parsea argv, delega en `lib/provision-test-env.js` y traduce el
// resultado a la salida del operador (guidelines UX G-1…G-9, CA-8).
//
//   node .pipeline/scripts/provision-test-env.js [--root <dir>] [--fresh] [--json]
//   node .pipeline/scripts/provision-test-env.js --destroy   [--root <dir>] [--json]
//   node .pipeline/scripts/provision-test-env.js --verify    [--root <dir>] [--json]
//   node .pipeline/scripts/provision-test-env.js --print-env [--root <dir>]
//
// Exit codes: 0 OK · 1 INCOMPLETO (residuo / aislamiento roto) · 2 ABORTADO
// (fail-closed: destino no habilitado, link, marcador ausente, flag desconocido).
//
// stdout: resultado (humano, `--json` o las dos líneas de `--print-env`).
// stderr: diagnósticos y avisos. Así `eval "$(... --print-env)"` nunca se rompe.
// =============================================================================

const lib = require('../lib/provision-test-env');

const PREFIJO = '[pruebas:env]';
const MAX_LISTA = 20;

const EXIT = Object.freeze({ OK: 0, INCOMPLETO: 1, ABORTADO: 2 });

const USAGE = `Uso: node .pipeline/scripts/provision-test-env.js [opciones]

Provisiona un ambiente de pruebas completo del pipeline (pipelineDir desechable)
fuera del checkout, sin compartir un solo archivo con el .pipeline productivo.

Opciones:
  --root <dir>   directorio raíz del ambiente (default: <tmp>/${lib.DEFAULT_ROOT_NAME})
  --fresh        borra el ambiente (si existe) y lo recrea
  --destroy      borra el ambiente entero (sólo si tiene marcador de pruebas)
  --verify       verifica que el ambiente no comparte nada con el productivo
  --print-env    provisiona y emite PIPELINE_AMBIENTE / PIPELINE_DIR_OVERRIDE (para eval)
  --json         imprime el objeto de retorno de la lib en stdout (avisos a stderr)
  -h, --help     esta ayuda

Exit codes: 0 OK · 1 INCOMPLETO · 2 ABORTADO

Scripts npm equivalentes:
  npm run pruebas:env             npm run pruebas:env:destroy        npm run pruebas:env:verify
`;

/**
 * Parseo estricto: un flag desconocido o mal tipeado (`--destory`, `--fresh=1`)
 * NO degrada a la acción por default (G-5).
 * @returns {{ok: true, opts: object} | {ok: false, error: string}}
 */
function parseArgs(argv) {
    const opts = { root: undefined, fresh: false, destroy: false, verify: false, printEnv: false, json: false, help: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        switch (a) {
            case '--root':
                if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) return { ok: false, error: 'opción `--root` sin valor (ver --help)' };
                opts.root = argv[++i];
                break;
            case '--fresh': opts.fresh = true; break;
            case '--destroy': opts.destroy = true; break;
            case '--verify': opts.verify = true; break;
            case '--print-env': opts.printEnv = true; break;
            case '--json': opts.json = true; break;
            case '-h':
            case '--help': opts.help = true; break;
            default:
                return { ok: false, error: `opción desconocida \`${a}\` (ver --help)` };
        }
    }
    const acciones = ['destroy', 'verify', 'printEnv'].filter((k) => opts[k]);
    if (acciones.length > 1) return { ok: false, error: 'opciones incompatibles: --destroy, --verify y --print-env son excluyentes (ver --help)' };
    if (opts.fresh && (opts.destroy || opts.verify)) return { ok: false, error: 'opción `--fresh` sólo aplica al provisionar (ver --help)' };
    return { ok: true, opts };
}

/** Lista acotada (G-8): máximo `MAX_LISTA` entradas + "… y N más". */
function listar(items) {
    const lineas = items.slice(0, MAX_LISTA).map((r) => `${PREFIJO}   - ${r}`);
    if (items.length > MAX_LISTA) lineas.push(`${PREFIJO}   … y ${items.length - MAX_LISTA} más`);
    return lineas;
}

function emitir(stream, lineas) {
    for (const l of lineas) stream.write(`${l}\n`);
}

function accionProvision(opts, io, deps) {
    const r = lib.provision({ env: io.env, root: opts.root, fresh: opts.fresh }, deps);
    const v = lib.verifyIsolation({ root: r.root }, deps);
    const salida = { ...r, verifyIsolation: v };
    const code = v.ok ? EXIT.OK : EXIT.INCOMPLETO;

    if (opts.printEnv) {
        // G-2: stdout exactamente dos líneas; todo lo demás a stderr.
        if (r.yaExistia && !opts.fresh) emitir(io.stderr, [`${PREFIJO} el ambiente ya existía en ${r.root}; se completó lo faltante (${r.creados.length} creados)`]);
        if (!v.ok) emitir(io.stderr, [`${PREFIJO} INCOMPLETO · ${v.motivo}`, ...listar([...v.compartidos, ...v.links])]);
        // #7112 / SEC-9 ESTRICTO: la declaración fija el MODO y el DIRECTORIO de
        // pruebas viaja por `PIPELINE_DIR_OVERRIDE` (D1: el mismo candidato que
        // validó el resolvedor). NO se emite `PIPELINE_REPO_ROOT`: en pruebas es
        // contexto heredado del checkout productivo y nunca aporta dir; además
        // su `.pipeline` es miembro de la unión que SEC-3 protege, así que
        // apuntarlo al root de pruebas anularía este mismo override.
        io.stdout.write(`${lib.ENV_AMBIENTE}=${lib.MODO_PRUEBAS}\n`);
        io.stdout.write(`${lib.ENV_DIR_OVERRIDE}=${r.pipelineDir}\n`);
        return code;
    }
    if (opts.json) {
        io.stdout.write(`${JSON.stringify(salida, null, 2)}\n`);
        if (!v.ok) emitir(io.stderr, [`${PREFIJO} INCOMPLETO · ${v.motivo}`]);
        return code;
    }
    let primera;
    if (opts.fresh) primera = `OK · ambiente borrado y recreado en ${r.root}`;
    else if (r.yaExistia) primera = `OK · el ambiente ya existía en ${r.root}; se completó lo faltante (${r.creados.length} creados)`;
    else primera = `OK · ambiente provisionado en ${r.root}`;
    const lineas = [
        `${PREFIJO} ${primera}`,
        `${PREFIJO} ${r.colas} colas · ${r.copiados} archivos copiados · productivo fuera del root: ${r.productivo}`,
    ];
    if (r.omitidos.length) lineas.push(`${PREFIJO} orígenes ausentes en el productivo (no copiados): ${r.omitidos.join(', ')}`);
    if (v.ok) {
        lineas.push(`${PREFIJO} para apuntar un proceso: npm run pruebas:env -- --print-env`);
        emitir(io.stdout, lineas);
    } else {
        lineas[0] = `${PREFIJO} INCOMPLETO · ${v.motivo} en ${r.root}`;
        emitir(io.stdout, [...lineas, ...listar([...v.compartidos, ...v.links])]);
    }
    return code;
}

function accionDestroy(opts, io, deps) {
    const prod = lib.DEFAULT_PRODUCTIVE_DIR;
    // G-7: anunciar el root (canónico, G-9) ANTES de borrar.
    emitir(io.stderr, [`${PREFIJO} destruyendo ${lib.resolveRoot({ root: opts.root }, deps)} (fuera de ${prod})`]);
    const d = lib.destroy({ root: opts.root }, deps);
    if (opts.json) io.stdout.write(`${JSON.stringify(d, null, 2)}\n`);
    if (!d.existia) {
        if (!opts.json) emitir(io.stdout, [`${PREFIJO} OK · no había ambiente en ${d.root}`]);
        return EXIT.OK;
    }
    if (!d.borrado) {
        emitir(io.stderr, [`${PREFIJO} ABORTADO · ${d.motivo}`]);
        return EXIT.ABORTADO;
    }
    if (!d.ok) {
        emitir(io.stderr, [`${PREFIJO} INCOMPLETO · ${d.motivo}`, ...listar(d.residuo)]);
        return EXIT.INCOMPLETO;
    }
    if (!opts.json) emitir(io.stdout, [`${PREFIJO} OK · ambiente borrado: ${d.root} (productivo intacto: ${prod})`]);
    return EXIT.OK;
}

function accionVerify(opts, io, deps) {
    const v = lib.verifyIsolation({ root: opts.root }, deps);
    if (opts.json) io.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
    if (v.ok) {
        if (!opts.json) emitir(io.stdout, [`${PREFIJO} OK · ${v.entradas} entradas en ${v.root}, ninguna compartida con ${v.productivo}${v.marcador ? '' : ' (sin marcador de pruebas)'}`]);
        return EXIT.OK;
    }
    if (v.entradas === 0) {
        emitir(io.stderr, [`${PREFIJO} ABORTADO · ${v.motivo}; provisioná primero con npm run pruebas:env`]);
        return EXIT.ABORTADO;
    }
    emitir(io.stderr, [`${PREFIJO} INCOMPLETO · ${v.motivo}`, ...listar([...v.compartidos, ...v.links])]);
    return EXIT.INCOMPLETO;
}

/**
 * Punto de entrada testeable sin spawn.
 * @param {string[]} argv argumentos (sin `node` ni script).
 * @param {{stdout: {write: Function}, stderr: {write: Function}, env: object}} io
 * @param {object} [deps] inyección para la lib (`fs`, `os`, `execFileSync`).
 * @returns {number} exit code.
 */
function main(argv, io, deps = {}) {
    const parsed = parseArgs(argv || []);
    if (!parsed.ok) {
        emitir(io.stderr, [`${PREFIJO} ABORTADO · ${parsed.error}`]);
        return EXIT.ABORTADO;
    }
    const { opts } = parsed;
    if (opts.help) {
        io.stdout.write(USAGE);
        return EXIT.OK;
    }
    try {
        if (opts.destroy) return accionDestroy(opts, io, deps);
        if (opts.verify) return accionVerify(opts, io, deps);
        return accionProvision(opts, io, deps);
    } catch (e) {
        const msg = e && e.abort ? e.message : `error inesperado (${e && e.message ? e.message : String(e)})`;
        emitir(io.stderr, [`${PREFIJO} ABORTADO · ${msg}`]);
        return EXIT.ABORTADO;
    }
}

if (require.main === module) {
    process.exitCode = main(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr, env: process.env });
}

module.exports = { main, parseArgs, EXIT, PREFIJO, USAGE };

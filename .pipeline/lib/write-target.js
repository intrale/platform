// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

/**
 * #7112 (split de #7102) — ENVOLTORIO ÚNICO DE LOS PUNTOS DE ESCRITURA.
 *
 * Todo escritor del pipeline (colas de servicios, `logs/`, estado operativo,
 * marcadores de pausa) resuelve su directorio destino por acá y no por su
 * cuenta. Es una capa fina sobre `lib/pipeline-env.js` que aplica la regla que
 * invierte el default:
 *
 *   sin ambiente declarado ⇒ `dir === null` ⇒ NO se escribe y se falla RUIDOSO.
 *
 * ── Manual de uso ───────────────────────────────────────────────────────────
 *
 *   const writeTarget = require('./lib/write-target');
 *
 *   // Familia F (función por llamada): el cuerpo pasa a ser UNA línea.
 *   function pipelineDir() {
 *       return writeTarget.writeDir(process.env, { canal: 'pausa', destino: '.paused' });
 *   }
 *
 *   // Path completo en una llamada:
 *   const file = writeTarget.writePath(process.env, { canal: 'logs', destino: 'logs/pulpo.log' }, 'logs', 'pulpo.log');
 *
 *   // Handlers de crash y escritores `safe*` (NUNCA lanzan): devuelven `null`
 *   // y avisan por stderr una sola vez por (canal, destino).
 *   const dir = writeTarget.safeWriteDir(process.env, { canal: 'logs', destino: 'logs/pulpo.log' });
 *   if (dir) fs.appendFileSync(path.join(dir, 'logs', 'pulpo.log'), msg);
 *   // …o el path completo (null si está bloqueado), también para LEER en el
 *   // mismo dir en el que se escribe (contadores, mtimes):
 *   const file = writeTarget.safeWritePath(process.env, { canal: 'logs', destino: 'logs/x.jsonl' }, 'logs', 'x.jsonl');
 *
 * Reglas (SEC-10, SEC-13, SEC-14 de #7112):
 *   - Resolución POR LLAMADA: el llamador pasa `process.env` en cada invocación.
 *     Prohibido guardar el resultado en una const de módulo o en una closure
 *     creada al `require` (V4 / TOCTOU: el test setea el override después).
 *   - Con `dir === null` `writeDir` avisa por `stderr` (deduplicado por
 *     canal+destino) Y lanza `EscrituraBloqueadaError`. El aviso va a `stderr`
 *     aunque el llamador envuelva la escritura en un `try/catch {}` best-effort:
 *     un bloqueo nunca es mudo.
 *   - El aviso va SÓLO a `stderr`: nunca a `logs/pulpo.log` productivo (sería el
 *     derrame que evita) ni a Telegram.
 *   - Un solo formateador del mensaje (`formatearBloqueo`): tres líneas fijas
 *     con prefijo grepeable `[pipeline-env]` — qué / por qué / cómo salir. La
 *     segunda línea reutiliza `amb.motivo` textual del resolvedor.
 *   - Vocabulario único de canales: `colas | logs | estado | pausa` (mismos
 *     nombres que `lib/write-points.json` y que el guardrail de #7114).
 *   - Este módulo NO crea directorios ni escribe archivos: el resolvedor sigue
 *     puro y el escritor conserva su `mkdirSync`/`writeFileSync`.
 *
 * @module write-target
 */

const path = require('path');
const pipelineEnv = require('./pipeline-env');

/** Vocabulario único de canales del inventario (`lib/write-points.json`). */
const CANALES = Object.freeze(['colas', 'logs', 'estado', 'pausa']);

/** Prefijo grepeable de las tres líneas del bloqueo. */
const PREFIJO = '[pipeline-env]';

/** Código estable del error (para `catch` por código, no por texto). */
const CODIGO_BLOQUEO = 'PIPELINE_ESCRITURA_BLOQUEADA';

/** Runner canónico de la suite: única forma de correr tests con dir de pruebas. */
const RUNNER = 'scripts/test-pipeline.js';

class EscrituraBloqueadaError extends Error {
    /**
     * @param {string} mensaje texto de tres líneas (`formatearBloqueo`).
     * @param {{canal: string, destino: string, amb: object}} detalle
     */
    constructor(mensaje, { canal, destino, amb }) {
        super(mensaje);
        this.name = 'EscrituraBloqueadaError';
        this.code = CODIGO_BLOQUEO;
        this.canal = canal;
        this.destino = destino;
        this.modo = amb.modo;
        this.origen = amb.origen;
        this.motivo = amb.motivo;
    }
}

function validarOpts(opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    if (!CANALES.includes(o.canal)) {
        throw new TypeError(
            `${PREFIJO} canal inválido '${o.canal}'; válidos: ${CANALES.join(' | ')}`
        );
    }
    const destino = typeof o.destino === 'string' && o.destino.trim() ? o.destino.trim() : '(sin destino)';
    return { canal: o.canal, destino, pipelineDir: o.pipelineDir };
}

/**
 * Tercera línea del bloqueo: siempre la salida. Nombra la variable a declarar
 * (proceso productivo) y el runner a usar (tests). No enumera más variables.
 */
function lineaSalida() {
    return `${PREFIJO} para salir: proceso productivo → ${pipelineEnv.ENV_AMBIENTE}=${pipelineEnv.VALOR_PRODUCTIVO} `
        + '(lo declara el lanzador: restart.js · watchdog.ps1 · launch.ps1; agente/skill → lo propaga el Pulpo) · '
        + `test → npm run test:pipeline (${RUNNER})`;
}

/**
 * ÚNICO formateador del mensaje de bloqueo (guideline UX 1 y 6 de #7112).
 *
 * @param {{canal: string, destino: string, amb: {modo: string, dir: string|null, origen: string, motivo: string|null}}} p
 * @returns {string} tres líneas, prefijo `[pipeline-env]`, sin `\n` final.
 */
function formatearBloqueo({ canal, destino, amb }) {
    const motivo = amb && amb.motivo ? amb.motivo : 'sin motivo informado por el resolvedor';
    const dir = amb && amb.dir !== null && amb.dir !== undefined ? amb.dir : 'null';
    return [
        `${PREFIJO} escritura bloqueada: canal=${canal} destino=${destino}`,
        `${PREFIJO} motivo: ${motivo} (modo=${amb ? amb.modo : '?'}, dir=${dir}, origen=${amb ? amb.origen : '?'})`,
        lineaSalida(),
    ].join('\n');
}

/**
 * Resuelve el destino de escritura SIN lanzar ni avisar. Es la primitiva sobre
 * la que se apoyan `writeDir` y `safeWriteDir`; útil para quien necesita mirar
 * el ambiente completo (`amb`) además del dir.
 *
 * @param {object} env entorno del proceso, pasado por el llamador.
 * @param {{canal: string, destino?: string, pipelineDir?: string}} opts
 * @returns {{dir: string|null, amb: object, bloqueo: string|null}}
 */
function resolverEscritura(env, opts) {
    const { canal, destino, pipelineDir } = validarOpts(opts);
    const amb = pipelineEnv.resolve(env, pipelineDir ? { pipelineDir } : undefined);
    const bloqueo = amb.dir === null ? formatearBloqueo({ canal, destino, amb }) : null;
    return { dir: amb.dir, amb, bloqueo, canal, destino };
}

// Aviso deduplicado por (canal, destino): un escritor bloqueado en un loop no
// inunda stderr, pero el PRIMER bloqueo de cada destino siempre se ve.
const avisados = new Set();

function avisar(bloqueo, canal, destino, stderr) {
    const clave = `${canal}|${destino}`;
    if (avisados.has(clave)) return false;
    avisados.add(clave);
    try {
        (stderr || process.stderr).write(bloqueo + '\n');
    } catch { /* stderr cerrado: el throw/null del llamador sigue siendo la señal */ }
    return true;
}

/**
 * Directorio de escritura, o LANZA `EscrituraBloqueadaError` (SEC-10).
 *
 * @param {object} env entorno del proceso.
 * @param {{canal: string, destino?: string, pipelineDir?: string, stderr?: {write: Function}}} opts
 * @returns {string} dir resuelto (nunca `null`).
 */
function writeDir(env, opts) {
    const r = resolverEscritura(env, opts);
    if (r.dir === null) {
        avisar(r.bloqueo, r.canal, r.destino, opts && opts.stderr);
        throw new EscrituraBloqueadaError(r.bloqueo, { canal: r.canal, destino: r.destino, amb: r.amb });
    }
    return r.dir;
}

/**
 * `path.join(writeDir(env, opts), ...segmentos)`.
 *
 * @param {object} env
 * @param {object} opts mismas opciones que `writeDir`.
 * @param {...string} segmentos
 * @returns {string}
 */
function writePath(env, opts, ...segmentos) {
    return path.join(writeDir(env, opts), ...segmentos);
}

/**
 * Variante que NUNCA lanza, para handlers de crash (`uncaughtException`) y
 * escritores `safe*`: devuelve `null` y avisa por stderr (deduplicado). El
 * llamador saltea el archivo y conserva su `console.error`.
 *
 * @param {object} env
 * @param {object} opts mismas opciones que `writeDir`.
 * @returns {string|null}
 */
function safeWriteDir(env, opts) {
    let r;
    try {
        r = resolverEscritura(env, opts);
    } catch {
        return null;
    }
    if (r.dir === null) {
        avisar(r.bloqueo, r.canal, r.destino, opts && opts.stderr);
        return null;
    }
    return r.dir;
}

/**
 * `path.join(safeWriteDir(env, opts), ...segmentos)`, o `null` si está bloqueado.
 * Para lecturas que deben mirar el MISMO dir en el que se escribe (contadores,
 * mtimes) y para escritores `safe*`: una línea, sin `const dir = …; if (dir) …`.
 *
 * @param {object} env
 * @param {object} opts mismas opciones que `writeDir`.
 * @param {...string} segmentos
 * @returns {string|null}
 */
function safeWritePath(env, opts, ...segmentos) {
    const dir = safeWriteDir(env, opts);
    return dir === null ? null : path.join(dir, ...segmentos);
}

/** ¿El error es un bloqueo de escritura de este módulo? */
function esBloqueo(err) {
    return !!err && err.code === CODIGO_BLOQUEO;
}

module.exports = {
    writeDir,
    writePath,
    safeWriteDir,
    safeWritePath,
    resolverEscritura,
    formatearBloqueo,
    esBloqueo,
    EscrituraBloqueadaError,
    CANALES,
    PREFIJO,
    CODIGO_BLOQUEO,
    // Sólo para tests: vacía la deduplicación de avisos.
    _resetAvisos: () => avisados.clear(),
};

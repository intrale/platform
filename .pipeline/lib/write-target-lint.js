#!/usr/bin/env node
// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// =============================================================================
// write-target-lint.js — Guardrail por DESTINO de escritura (#7114, cierre de
// la Ola 9.4.1 · Ambiente de pruebas del CORE).
//
// Objetivo
// --------
// Que la inversion del default de #7112 ("sin ambiente declarado no se toca el
// `.pipeline` productivo") NO se erosione con el proximo archivo que copie el
// patron viejo. Extiende `test-env-lint.js` (#6260) de VARIABLES de entorno a
// DESTINOS de escritura: no alcanza con verificar que el test declaro algo, hay
// que verificar donde termina el byte.
//
// Es analisis ESTATICO puro sobre el fuente (SEC-5): ningun workflow corre la
// suite completa y el pre-commit no puede correr 1000+ tests. La verificacion
// dinamica de "donde termina el byte" vive en los lanzadores (#7414 / #7457).
//
// Tres reglas, un solo formato de hallazgo (CA-3 / CA-7):
//
//   LINT R<1|2|3>: <archivo relativo al repo>:<linea> -> <destino> (canal <c>)
//       reason: <por que es rojo>
//
// R1 · Inventario sincronizado (GATE, no test suelto). `write-points-scan`
//      escanea los modulos productivos; el diff contra `lib/write-points.json`
//      tiene que ser vacio en las dos direcciones. Anti-tampering (SEC-4a): un
//      `migrado|safe` del JSON tiene que serlo tambien para el escaner y su
//      linea matchear `RE_WRITE_TARGET`; un `lectura|externo` exige `nota` no
//      vacia y que ninguna llamada de escritura use el mismo identificador.
// R2 · Ratchet shrink-only de `pendiente`. Baseline por `modulo::funcion`
//      (NUNCA por numero de linea — leccion de #6260). Un `pendiente` nuevo es
//      rojo; el conteo solo baja.
// R3 · Destinos en tests. En los 4 origenes del runner (`scripts/test-pipeline.js`)
//      un test que fija `PIPELINE_DIR_OVERRIDE` / `PIPELINE_STATE_DIR` /
//      `PIPELINE_REPO_ROOT` o la opcion `pipelineDir:` con un valor RESOLUBLE
//      estaticamente (`path.join|resolve(__dirname, ...)`, `${__dirname}...`,
//      `__dirname + ...`, literal absoluto) que cae dentro del `.pipeline`
//      productivo es rojo. `PIPELINE_REPO_ROOT` aporta la RAIZ del repo: el
//      destino que se compara es `<valor>/.pipeline` (misma semantica que el
//      resolvedor y que la union SEC-9), asi que fijarla a la raiz del repo
//      es rojo aunque la raiz no este dentro de `.pipeline`. Las 6 formas de SEC-7: `process.env.X =`,
//      `process.env['X'] =`, `Object.assign(process.env, {X})`, `withEnv({X})`,
//      `env: {...process.env, X}` de spawn/exec/fork y `pipelineDir:`. Valor no
//      resoluble (mkdtemp, variable, `ensureTestRunDir()`) NO es rojo: lo cubre
//      SEC-3 en runtime. La comparacion es CANONICA (SEC-1): realpath nativo del
//      ancestro existente + minusculas en win32 + sin prefijo `\\?\`; NO hereda
//      el bypass por casing de `pipeline-env.dentroDe`. La inexistencia del
//      destino NO exime (SEC-2): un `mkdirSync({recursive:true})` lo crea.
//
// Salida
// ------
//   node .pipeline/lib/write-target-lint.js --check           0 limpio / 1 rojo / 2 error de config
//   node .pipeline/lib/write-target-lint.js --write-baseline  regenera el baseline: shrink-only
//                                                             [--allow-dirty] con untracked en alcance
//
// Fail-closed (SEC-9): inventario o baseline ausentes/ilegibles, o `pipeline-env`
// que no carga -> exit 2. Cero modulos o cero tests escaneados -> exit 1.
//
// SEC-6 (repo publico): los mensajes nombran archivo, linea, NOMBRE de variable y
// destino relativo al repo. Nunca valores de otras variables ni un dump del env.
//
// SEC-5: cero `require`/`vm`/`eval` sobre archivos escaneados; `child_process`
// solo `execFileSync('git', [argv fijo])`, sin shell ni interpolacion de paths.
// =============================================================================

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const scan = require('./write-points-scan');

const LOG_PREFIX = '[write-target-lint]';

const DEFAULT_PIPELINE_ROOT = path.resolve(__dirname, '..');
const BASELINE_FILE = 'write-target-lint.baseline.json';
const INVENTARIO_FILE = 'write-points.json';

// CA-8 / SEC-4d: auto-exencion de EXACTAMENTE dos paths — el guardrail y su
// suite (los fixtures de la suite escriben las formas de SEC-7 como texto).
// `write-points-scan.js`, `pipeline-env.js`, `write-target.js` y los JSON del
// lint SI se auditan.
const SELF_EXEMPT = new Set([
    'lib/write-target-lint.js',
    'lib/__tests__/write-target-lint.test.js',
]);

// Los 4 origenes del runner (`scripts/test-pipeline.js` PATTERNS), relativos a
// la raiz del REPO. Walk propio: el glob nativo de `fs` no existe en Node 20 (CI).
const ORIGENES_TESTS = Object.freeze([
    '.pipeline',
    'qa/scripts/__tests__',
    'scripts',
    '.claude/hooks/tests/test-p09-telegram-client.js',
]);

/** Variables que aportan DIRECTORIO al resolvedor (precedencia D-1 de `pipeline-env`). */
const VARIABLES_DIR = Object.freeze(['PIPELINE_DIR_OVERRIDE', 'PIPELINE_STATE_DIR', 'PIPELINE_REPO_ROOT']);
/**
 * `PIPELINE_REPO_ROOT` aporta la RAIZ del repo, no el dir de estado: el
 * resolvedor le agrega `/.pipeline` (`pipeline-env`, precedencia D-1) y los
 * skills deterministicos (`build.js`, `delivery.js`, `linter.js`, `tester.js`)
 * la usan como `REPO_ROOT` y escriben debajo. R3 compara entonces
 * `<valor>/.pipeline` contra los miembros, igual que la union SEC-9: un test
 * que la fija a la raiz del repo es rojo aunque la raiz no este DENTRO de
 * `.pipeline` (rebote QA de #7114).
 */
const VARIABLE_RAIZ = 'PIPELINE_REPO_ROOT';
const SUBDIR_RAIZ = '.pipeline';

/** Destino EFECTIVO al que apunta una variable/opcion con el valor `resuelto`. */
function destinoEfectivo(variable, resuelto) {
    return variable === VARIABLE_RAIZ ? path.join(resuelto, SUBDIR_RAIZ) : resuelto;
}
/** Opcion que fija el dir por parametro (`modo: explicito` de `pipeline-env`, `write-target`, `test-run-dir`). */
const OPCION_DIR = 'pipelineDir';

const SKIP_DIRS = new Set(['node_modules', '_tmp']);
const SCRATCH_DIR_RE = /^(_tmp|tmp[-.]|\.)/;

const CANALES = Object.freeze(['colas', 'logs', 'estado', 'pausa']);
const SNIPPET_MAX = 120;

/** Error de configuracion -> exit 2 (fail-closed, nunca degrada a "vacio"). */
class ConfigError extends Error {
    constructor(message) { super(message); this.name = 'ConfigError'; }
}

function defaultLogger() {
    return {
        info: (m) => console.log(`${LOG_PREFIX} ${m}`),
        warn: (m) => console.warn(`${LOG_PREFIX} ${m}`),
        error: (m) => console.error(`${LOG_PREFIX} ${m}`),
    };
}

// --- Utilidades de path ------------------------------------------------------

function rel(root, abs) {
    return path.relative(root, abs).replace(/\\/g, '/');
}

/**
 * SEC-1: forma canonica de un path para comparar contra el productivo, SIN
 * heredar el bypass lexico/case-sensitive de `pipeline-env.dentroDe`.
 * `realpathSync.native` del ancestro existente mas profundo (resuelve
 * junction/symlink y el casing real del volumen), reatando los segmentos que no
 * existen (SEC-2: la inexistencia no exime), sin prefijo `\\?\`, y en
 * minusculas en win32 (el volumen es case-insensitive).
 */
function canonizar(p) {
    const abs = path.resolve(String(p));
    let ancestro = abs;
    const faltantes = [];
    while (!fs.existsSync(ancestro)) {
        const padre = path.dirname(ancestro);
        if (padre === ancestro) break;
        faltantes.unshift(path.basename(ancestro));
        ancestro = padre;
    }
    let real;
    try { real = fs.realpathSync.native(ancestro); } catch { real = ancestro; }
    if (real.startsWith('\\\\?\\')) real = real.slice(4);
    const out = faltantes.length ? path.join(real, ...faltantes) : real;
    return process.platform === 'win32' ? out.toLowerCase() : out;
}

/**
 * Miembros de la union "productivo" (SEC-9): el `.pipeline` del arbol que se
 * lintea (`DEFAULT_PRODUCTIVE_DIR` de `pipeline-env`, o `opts.productiveDir`)
 * y, si el proceso hereda `PIPELINE_REPO_ROOT`, tambien `<root>/.pipeline`.
 * Aditivo: nunca protege menos que el resolvedor.
 *
 * @returns {Array<{raw: string, canon: string, label: string}>}
 */
function miembrosProductivo(opts) {
    let raw = opts.productiveDir;
    if (!raw) {
        let pipelineEnv;
        try { pipelineEnv = require('./pipeline-env'); }
        catch (e) { throw new ConfigError('no se pudo cargar lib/pipeline-env.js: ' + (e && e.message)); }
        raw = pipelineEnv.DEFAULT_PRODUCTIVE_DIR;
        if (typeof raw !== 'string' || !raw) throw new ConfigError('pipeline-env no exporta DEFAULT_PRODUCTIVE_DIR');
    }
    const out = [{ raw: path.resolve(raw), canon: canonizar(raw), label: '.pipeline' }];
    const env = opts.env || {};
    const heredado = env.PIPELINE_REPO_ROOT;
    if (typeof heredado === 'string' && heredado.trim()) {
        const h = path.join(path.resolve(heredado.trim()), '.pipeline');
        const canon = canonizar(h);
        if (!out.some((m) => m.canon === canon)) out.push({ raw: h, canon, label: 'PIPELINE_REPO_ROOT/.pipeline' });
    }
    return out;
}

/** ¿`abs` cae dentro de algun miembro? Devuelve el miembro o `null`. */
function miembroQueContiene(abs, miembros) {
    const c = canonizar(abs);
    for (const m of miembros) {
        if (c === m.canon || c.startsWith(m.canon + path.sep)) return m;
    }
    return null;
}

/** Destino relativo al repo (`.pipeline/...`), nunca el path absoluto del host (SEC-6 / UX G1). */
function destinoRelativo(abs, miembro) {
    let r = path.relative(miembro.raw, path.resolve(abs)).replace(/\\/g, '/');
    if (r.startsWith('..') || path.isAbsolute(r)) {
        r = path.relative(miembro.canon, canonizar(abs)).replace(/\\/g, '/');
    }
    return r ? miembro.label + '/' + r : miembro.label;
}

// --- Sanitizacion de salida (UX G1 / #5607) ----------------------------------

/** Una linea, recortada, sin `::` al inicio (workflow commands de GitHub Actions). */
function sanear(s, max = SNIPPET_MAX) {
    let t = String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim();
    if (t.length > max) t = t.slice(0, max) + '…';
    return t.replace(/^::/, ': :');
}

// --- Lectura estricta de JSON (fail-closed) ----------------------------------

function readJsonStrict(file, nombre) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (e) {
        throw new ConfigError(`${nombre} ausente o ilegible (${file}): ${e && e.code ? e.code : e}`);
    }
    try { return JSON.parse(raw); }
    catch (e) { throw new ConfigError(`${nombre} no es JSON valido (${file}): ${e && e.message}`); }
}

function loadInventario(pipelineRoot) {
    const file = path.join(pipelineRoot, 'lib', INVENTARIO_FILE);
    const doc = readJsonStrict(file, INVENTARIO_FILE);
    if (!doc || !Array.isArray(doc.puntos)) throw new ConfigError(`${INVENTARIO_FILE} sin array \`puntos\``);
    return doc.puntos;
}

function loadBaseline(pipelineRoot) {
    const file = path.join(pipelineRoot, 'lib', BASELINE_FILE);
    const doc = readJsonStrict(file, BASELINE_FILE);
    if (!doc || !Array.isArray(doc.pendientes) || !Array.isArray(doc.tests)) {
        throw new ConfigError(`${BASELINE_FILE} sin arrays \`pendientes\` y \`tests\``);
    }
    for (const k of doc.pendientes.concat(doc.tests)) {
        if (typeof k !== 'string' || !k.includes('::')) throw new ConfigError(`${BASELINE_FILE}: clave invalida ${JSON.stringify(k)}`);
    }
    return { pendientes: doc.pendientes, tests: doc.tests };
}

// --- Escaneo de fuente (comun a R1 y R3) --------------------------------------

/** Quita comentarios de linea (misma aproximacion que `write-points-scan`). */
function codigoDe(linea) {
    if (/^\s*(\/\/|\*|\/\*)/.test(linea)) return '';
    const idx = linea.search(/(?<!:)\/\/(?!\/)/);
    return idx >= 0 ? linea.slice(0, idx) : linea;
}

function leerLineas(abs) {
    try { return fs.readFileSync(abs, 'utf8').split(/\r?\n/); }
    catch { return null; }
}

// --- R1 · inventario sincronizado ---------------------------------------------

function hallazgo(regla, file, line, destino, canal, reason, extra) {
    return Object.assign({ regla, file, line, destino, canal, reason }, extra || {});
}

/**
 * R1: escaneo vs JSON en las dos direcciones + anti-tampering SEC-4a.
 *
 * @returns {{hallazgos: Array, escaneo: Array, porClaveJson: Map, desactualizadas: string[]}}
 */
function lintInventario(pipelineRoot, inventario) {
    const hallazgos = [];
    const escaneo = scan.escanear(pipelineRoot).filter((e) => !SELF_EXEMPT.has(e.modulo));
    const json = inventario.filter((e) => !SELF_EXEMPT.has(e.modulo));
    const porClaveScan = new Map(escaneo.map((e) => [scan.clave(e), e]));
    const porClaveJson = new Map(json.map((e) => [scan.clave(e), e]));
    const desactualizadas = [];

    for (const e of escaneo) {
        if (porClaveJson.has(scan.clave(e))) continue;
        hallazgos.push(hallazgo('R1', '.pipeline/' + e.modulo, e.linea, e.via,
            scan.canalPorDefecto(e.modulo, e.funcion),
            `punto de escritura NO inventariado (${scan.clave(e)}): resuelve por ${e.via}, estado ${e.estado}`));
    }
    const lineasCache = new Map();
    const lineasDe = (modulo) => {
        if (!lineasCache.has(modulo)) lineasCache.set(modulo, leerLineas(path.join(pipelineRoot, modulo)) || []);
        return lineasCache.get(modulo);
    };
    for (const e of json) {
        const k = scan.clave(e);
        const real = porClaveScan.get(k);
        const canal = CANALES.includes(e.canal) ? e.canal : 'estado';
        if (!real) {
            hallazgos.push(hallazgo('R1', '.pipeline/' + e.modulo, e.linea || 0, e.destino || e.via || '?', canal,
                `entrada del inventario sin punto en el fuente (${k}): el codigo cambio y el JSON no`));
            continue;
        }
        if (!CANALES.includes(e.canal)) {
            hallazgos.push(hallazgo('R1', '.pipeline/' + e.modulo, real.linea, e.destino || real.via, 'estado',
                `canal invalido ${JSON.stringify(e.canal)} en ${k}; vocabulario: ${CANALES.join(' | ')}`));
        }
        if (real.linea !== e.linea) desactualizadas.push(k);
        const lineas = lineasDe(e.modulo);
        const codigo = codigoDe(lineas[real.linea - 1] || '');
        if (e.estado === 'migrado' || e.estado === 'safe') {
            // SEC-4a: "migrar editando el JSON" no alcanza — el escaner y la linea deciden.
            if (real.estado !== e.estado || !scan.RE_WRITE_TARGET.test(codigo)) {
                hallazgos.push(hallazgo('R1', '.pipeline/' + e.modulo, real.linea, e.destino || real.via, canal,
                    `el JSON declara \`${e.estado}\` pero el fuente resuelve por ${real.via} (estado real: ${real.estado}); `
                    + 'la linea no usa lib/write-target'));
            }
        } else if (scan.ESTADOS_CURADOS.includes(e.estado)) {
            // SEC-4a: un `lectura|externo` sin nota, o cuyo identificador aparece en
            // una llamada de escritura del modulo, es una curacion invalida.
            if (typeof e.nota !== 'string' || !e.nota.trim()) {
                hallazgos.push(hallazgo('R1', '.pipeline/' + e.modulo, real.linea, e.destino || real.via, canal,
                    `estado \`${e.estado}\` sin \`nota\`: una curacion a mano exige justificacion escrita (${k})`));
            }
            if (real.estado !== 'pendiente') {
                hallazgos.push(hallazgo('R1', '.pipeline/' + e.modulo, real.linea, e.destino || real.via, canal,
                    `estado \`${e.estado}\` sobre un punto que el escaner ve \`${real.estado}\` (${k}); correr --sync`));
            }
            // `lectura`: el identificador no puede aparecer en NINGUNA llamada de
            // escritura. `externo`: puede (escribe fuera del arbol), pero esa linea no
            // puede armar un path con `.pipeline` adentro.
            const ident = new RegExp('(?<![\\w$.])' + e.funcion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w$])');
            if (!e.funcion.startsWith('inline:')) {
                for (let i = 0; i < lineas.length; i++) {
                    const c = codigoDe(lineas[i]);
                    if (!c || !scan.RE_ESCRITURA.test(c)) continue;
                    const sinStrings = c.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '""');
                    if (!ident.test(sinStrings)) continue;
                    if (e.estado === 'externo' && !/\.pipeline\b/.test(c)) continue;
                    hallazgos.push(hallazgo('R1', '.pipeline/' + e.modulo, i + 1, e.destino || real.via, canal,
                        `estado \`${e.estado}\` pero \`${e.funcion}\` aparece en una llamada de escritura`
                        + (e.estado === 'externo' ? ' que arma un path con `.pipeline`' : '') + ` (${k}): no es un falso positivo`));
                    break;
                }
            }
        } else if (e.estado === 'pendiente') {
            if (real.estado === 'migrado' || real.estado === 'safe') {
                // El fuente ya migro y el JSON quedo viejo: desincronizacion, --sync lo arregla.
                hallazgos.push(hallazgo('R1', '.pipeline/' + e.modulo, real.linea, e.destino || real.via, canal,
                    `el JSON declara \`pendiente\` pero el fuente ya resuelve por ${real.via} (${k}); correr --sync`));
            }
        } else {
            hallazgos.push(hallazgo('R1', '.pipeline/' + e.modulo, real.linea, e.destino || real.via, canal,
                `estado invalido ${JSON.stringify(e.estado)} en ${k}; validos: ${scan.ESTADOS.join(' | ')}`));
        }
    }
    return { hallazgos, escaneo, porClaveJson, desactualizadas };
}

/**
 * Pendientes EFECTIVOS: el escaner los ve `pendiente` y el JSON no los cura
 * como `lectura|externo` (la validez de esa curacion la audita R1).
 */
function pendientesEfectivos(escaneo, porClaveJson) {
    const out = [];
    for (const e of escaneo) {
        if (e.estado !== 'pendiente') continue;
        const j = porClaveJson.get(scan.clave(e));
        if (j && scan.ESTADOS_CURADOS.includes(j.estado)) continue;
        out.push(Object.assign({ canal: j && CANALES.includes(j.canal) ? j.canal : scan.canalPorDefecto(e.modulo, e.funcion) }, e));
    }
    return out;
}

// --- R3 · destinos en tests ---------------------------------------------------

function inScope(name) {
    return name.endsWith('.test.js') || (name.startsWith('test-') && name.endsWith('.js'));
}

function walkTests(root) {
    const out = [];
    function recurse(dir) {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { return; }
        for (const e of entries) {
            if (e.isSymbolicLink()) continue;
            if (e.isDirectory()) {
                if (SKIP_DIRS.has(e.name) || SCRATCH_DIR_RE.test(e.name)) continue;
                recurse(path.join(dir, e.name));
            } else if (e.isFile() && inScope(e.name)) {
                out.push(path.join(dir, e.name));
            }
        }
    }
    recurse(root);
    return out;
}

/** Archivos de test de los 4 origenes, absolutos y ordenados. */
function listarTests(repoRoot, origenes = ORIGENES_TESTS) {
    const out = [];
    for (const o of origenes) {
        const abs = path.join(repoRoot, o);
        let st;
        try { st = fs.lstatSync(abs); } catch { continue; }
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) out.push(...walkTests(abs));
        else if (st.isFile()) out.push(abs);
    }
    return out.sort();
}

const NOMBRES_R3 = VARIABLES_DIR.concat([OPCION_DIR]);
const NOMBRES_ALT = NOMBRES_R3.join('|');
// Forma 1: `process.env.X =` (tambien `||=`, `??=`). Forma 2: `process.env['X'] =`.
const RE_ENV_ASIGNA = new RegExp('process\\.env(?:\\.(' + NOMBRES_ALT + ')|\\[\\s*[\'"](' + NOMBRES_ALT
    + ')[\'"]\\s*\\])\\s*(?:\\|\\||\\?\\?)?=(?!=)', 'g');
// Formas 3-6: propiedad `X: valor` (o `'X': valor`) en cualquier objeto literal —
// `Object.assign(process.env, {X})`, `withEnv({X})`, `env: {...process.env, X}`
// de spawn/exec/fork y la opcion `pipelineDir:`. Preferimos el falso positivo.
const RE_PROPIEDAD = new RegExp('(?<![.\\w$])[\'"]?(' + NOMBRES_ALT + ')[\'"]?\\s*:(?!:)', 'g');

/**
 * Expresion a partir de `s` hasta el primer `,` `;` `}` `)` `]` de nivel 0.
 * Respeta comillas, backticks y anidamiento.
 */
function extraerExpresion(s) {
    let depth = 0;
    let quote = null;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (quote) {
            if (ch === '\\') { i++; continue; }
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; continue; }
        if (ch === '(' || ch === '[' || ch === '{') { depth++; continue; }
        if (ch === ')' || ch === ']' || ch === '}') {
            if (depth === 0) return s.slice(0, i).trim();
            depth--;
            continue;
        }
        if ((ch === ',' || ch === ';') && depth === 0) return s.slice(0, i).trim();
    }
    return s.trim();
}

/** Argumentos de nivel 0 separados por coma. */
function splitArgs(s) {
    const out = [];
    let rest = s;
    while (rest.trim()) {
        const a = extraerExpresion(rest);
        out.push(a);
        const idx = rest.indexOf(a) + a.length;
        const coma = rest.indexOf(',', idx);
        if (coma < 0) break;
        rest = rest.slice(coma + 1);
    }
    return out;
}

/** Contenido de un literal de string simple (sin `${}`), o `null`. */
function literalString(e) {
    const t = e.trim();
    const m = t.match(/^(['"`])([\s\S]*)\1$/);
    if (!m) return null;
    if (m[1] === '`' && m[2].includes('${')) return null;
    return m[2].replace(/\\(.)/g, '$1');
}

function esAbsolutoLiteral(s) {
    return /^[A-Za-z]:[\\/]/.test(s) || s.startsWith('/') || s.startsWith('\\\\');
}

/**
 * Resuelve estaticamente el valor asignado, relativo al DIRECTORIO del test.
 * Formas de SEC-7: `path.join|resolve(__dirname, lits...)`, `${__dirname}...`,
 * `__dirname + lits`, `__dirname`, `path.dirname(__dirname)`, literal absoluto
 * (win y posix). Cualquier otra cosa (mkdtemp, variable, funcion) -> `null`.
 */
function resolverValor(expr, testDir) {
    const e = String(expr || '').trim();
    if (!e) return null;
    const lit = literalString(e);
    if (lit !== null) {
        if (!esAbsolutoLiteral(lit)) return null;
        // En posix `C:\x` no es absoluto para `path`: no es resoluble (ni puede ser productivo).
        return path.isAbsolute(lit) ? path.resolve(lit) : null;
    }
    if (e === '__dirname') return testDir;
    if (/^path\.dirname\(\s*__dirname\s*\)$/.test(e)) return path.dirname(testDir);
    const t = e.match(/^`\$\{__dirname\}([^`$]*)`$/);
    if (t) return path.resolve(testDir + t[1]);
    if (/^__dirname\s*\+/.test(e)) {
        const partes = e.split('+').map((p) => p.trim());
        if (partes[0] !== '__dirname') return null;
        let sufijo = '';
        for (const p of partes.slice(1)) {
            const l = literalString(p);
            if (l === null) return null;
            sufijo += l;
        }
        return path.resolve(testDir + sufijo);
    }
    const m = e.match(/^path\.(join|resolve)\(([\s\S]*)\)$/);
    if (m) {
        const partes = [];
        for (const a of splitArgs(m[2])) {
            if (a === '__dirname') partes.push(testDir);
            else if (/^path\.dirname\(\s*__dirname\s*\)$/.test(a)) partes.push(path.dirname(testDir));
            else {
                const l = literalString(a);
                if (l === null) return null;
                partes.push(l);
            }
        }
        if (!partes.length || !path.isAbsolute(partes[0])) return null;
        return path.resolve(...partes);
    }
    return null;
}

/**
 * R3 sobre un archivo de test.
 *
 * @returns {Array} hallazgos (con `variable`, `forma`, `snippet`, `clave`).
 */
function lintTest(abs, repoRoot, miembros) {
    const lineas = leerLineas(abs);
    if (!lineas) return [];
    const file = rel(repoRoot, abs);
    const testDir = path.dirname(abs);
    const out = [];
    const candidatos = [];
    for (let i = 0; i < lineas.length; i++) {
        const c = codigoDe(lineas[i]);
        if (!c) continue;
        RE_ENV_ASIGNA.lastIndex = 0;
        let m;
        while ((m = RE_ENV_ASIGNA.exec(c)) !== null) {
            const variable = m[1] || m[2];
            candidatos.push({ i, variable, forma: m[1] ? 'process.env.' + variable + ' =' : "process.env['" + variable + "'] =", resto: c.slice(m.index + m[0].length) });
        }
        RE_PROPIEDAD.lastIndex = 0;
        while ((m = RE_PROPIEDAD.exec(c)) !== null) {
            const variable = m[1];
            candidatos.push({ i, variable, forma: 'propiedad ' + variable + ':', resto: c.slice(m.index + m[0].length) });
        }
    }
    for (const cand of candidatos) {
        let expr = extraerExpresion(cand.resto);
        // Valor en la linea siguiente (`X:\n    path.join(__dirname, ...)`).
        if (!expr && lineas[cand.i + 1] !== undefined) expr = extraerExpresion(codigoDe(lineas[cand.i + 1]));
        const valor = resolverValor(expr, testDir);
        if (!valor) continue;
        // `PIPELINE_REPO_ROOT` = raiz del repo -> el destino real es `<raiz>/.pipeline`.
        const resuelto = destinoEfectivo(cand.variable, valor);
        const miembro = miembroQueContiene(resuelto, miembros);
        if (!miembro) continue;
        const destino = destinoRelativo(resuelto, miembro);
        const derivado = resuelto !== valor ? ` (${cand.variable} es la raiz del repo: el destino efectivo es <valor>/${SUBDIR_RAIZ})` : '';
        out.push(hallazgo('R3', file, cand.i + 1, destino, canalDeDestino(destino),
            `el test fija ${cand.variable} (forma ${cand.forma}) a un destino dentro del .pipeline productivo` + derivado
            + (fs.existsSync(resuelto) ? '' : ' (el destino no existe hoy: un mkdirSync recursivo lo crea — SEC-2)'),
            { variable: cand.variable, forma: cand.forma, snippet: sanear(codigoDe(lineas[cand.i])), clave: file + '::' + cand.variable + '::' + destino }));
    }
    return out;
}

/** Canal por el segmento del destino (vocabulario de `write-target`). */
function canalDeDestino(destinoRel) {
    const r = destinoRel.replace(/^[^/]*\/?/, '').toLowerCase();
    if (/^(\.paused|pause)/.test(r)) return 'pausa';
    if (/^logs(\/|$)/.test(r)) return 'logs';
    if (/^(servicios|definicion|desarrollo|outbox)(\/|$)/.test(r)) return 'colas';
    return 'estado';
}

// --- Formato y remedios (CA-3 / CA-7 / UX G1) -----------------------------------

function formatHallazgo(h) {
    let s = 'LINT ' + h.regla + ': ' + h.file + ':' + h.line + ' -> ' + sanear(h.destino) + ' (canal ' + h.canal + ')';
    if (h.variable) s += '\n    variable: ' + h.variable + ' [' + h.forma + ']';
    s += '\n    reason: ' + sanear(h.reason, 240);
    if (h.snippet) s += '\n    snippet: ' + sanear(h.snippet);
    return s;
}

const REMEDIO_SYNC = [
    '  1) [R1] Inventario desincronizado: regenerar el JSON con el dir EXPLICITO (sin dir, el',
    '     default `pruebas` de write-target lanza) y curar `estado`/`nota` de lo que aparezca:',
    '       node .pipeline/lib/write-points-scan.js --sync .pipeline',
];
const REMEDIO_CURAR = [
    '  2) [R1/R2] Falso positivo del heuristico (el punto solo alimenta lecturas) o escritura fuera',
    '     de `.pipeline`: curar `estado: lectura|externo` + `nota` en `.pipeline/lib/write-points.json`.',
    '     Un escritor real se migra a `lib/write-target` (`writeDir`/`safeWriteDir`), no se cura.',
];
const REMEDIO_TEST = [
    '  3) [R3] Destino estatico en un test: apuntarlo a `fs.mkdtempSync(path.join(os.tmpdir(), …))`,',
    '     a `ensureTestRunDir()` de `.pipeline/lib/test-run-dir.js`, o al `PIPELINE_DIR_OVERRIDE` que',
    '     `scripts/test-pipeline.js` ya provee. La inexistencia del destino NO exime (SEC-2).',
];
const REMEDIO_BASELINE = [
    '  4) [R2/R3] `--write-baseline` SOLO si el baseline ENCOGIO (el diff va en el PR). Rechaza crecer:',
    '     un `pendiente` o un destino de test nuevos se arreglan, no se congelan.',
    '       node .pipeline/lib/write-target-lint.js --write-baseline',
];
const REMEDIO_NO_VERIFY = [
    '  5) `--no-verify` NO es la salida: mueve el rojo al CI (y al productivo) en vez de resolverlo.',
];

/**
 * Remedios en el orden FIJO de CA-7 (sync -> curar -> test -> baseline, nunca
 * `--no-verify`), etiquetados con la regla que atienden para que el remedio se
 * derive del motivo del rojo (UX G1) sin que el orden dependa del hallazgo.
 */
function remediosPara(reglas) {
    const r = reglas instanceof Set ? reglas : new Set(reglas || []);
    const cabecera = '  (rojo por ' + (r.size ? [...r].sort().join(', ') : 'config') + ' — el remedio marcado con esa regla es el que aplica)';
    return [cabecera].concat(REMEDIO_SYNC, REMEDIO_CURAR, REMEDIO_TEST, REMEDIO_BASELINE, REMEDIO_NO_VERIFY);
}
const REMEDIOS_TODOS = remediosPara(new Set(['R1', 'R2', 'R3']));

// --- Delta vs base git (SEC-4b) ---------------------------------------------------

/**
 * Transiciones de `estado` del inventario respecto de la version en HEAD, para
 * que `review` las vea en la salida de CI. Best-effort: sin git, se dice.
 */
function deltaVsHead(repoRoot, actual) {
    let raw;
    try {
        raw = execFileSync('git', ['show', 'HEAD:.pipeline/lib/' + INVENTARIO_FILE], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
        return { disponible: false, transiciones: [], antes: {} };
    }
    let previo;
    try { previo = JSON.parse(raw).puntos || []; } catch { return { disponible: false, transiciones: [], antes: {} }; }
    const antesPorClave = new Map(previo.map((e) => [scan.clave(e), e.estado]));
    const ahoraPorClave = new Map(actual.map((e) => [scan.clave(e), e.estado]));
    const transiciones = [];
    for (const [k, est] of ahoraPorClave) {
        const a = antesPorClave.get(k);
        if (a === undefined) transiciones.push(`${k}: (nuevo) -> ${est}`);
        else if (a !== est) transiciones.push(`${k}: ${a} -> ${est}`);
    }
    for (const [k, a] of antesPorClave) {
        if (!ahoraPorClave.has(k)) transiciones.push(`${k}: ${a} -> (eliminado)`);
    }
    return { disponible: true, transiciones, antes: contarEstados(previo) };
}

function contarEstados(puntos) {
    const c = {};
    for (const e of puntos) c[e.estado] = (c[e.estado] || 0) + 1;
    return c;
}

function fmtConteos(c) {
    return scan.ESTADOS.map((s) => `${c[s] || 0} ${s}`).join(' / ');
}

// --- check() --------------------------------------------------------------------

/**
 * Corrida completa en modo `--check`, en el ORDEN FAIL-CLOSED: config (2) ->
 * escaneo vacio (1) -> R1 -> R2 -> R3 (1) -> verde (0).
 *
 * @param {object} [opts]
 * @param {string} [opts.pipelineRoot] `.pipeline` a lintear (default: el propio).
 * @param {string} [opts.repoRoot] raiz del repo (default: padre de `pipelineRoot`).
 * @param {string} [opts.productiveDir] `.pipeline` productivo (default: `pipeline-env.DEFAULT_PRODUCTIVE_DIR`).
 * @param {object} [opts.env] entorno (solo se lee `PIPELINE_REPO_ROOT` para la union SEC-9).
 * @param {string[]} [opts.origenes] origenes de tests relativos a `repoRoot`.
 * @returns {{code:number, lines:string[], hallazgos:Array, remedios:string[], modulos:number, tests:number}}
 */
function check(opts = {}) {
    const pipelineRoot = path.resolve(opts.pipelineRoot || DEFAULT_PIPELINE_ROOT);
    const repoRoot = path.resolve(opts.repoRoot || path.join(pipelineRoot, '..'));
    const lines = [];

    // 1) config -> exit 2 (lo tiran los loaders / miembrosProductivo)
    const miembros = miembrosProductivo({ productiveDir: opts.productiveDir, env: opts.env || process.env });
    const inventario = loadInventario(pipelineRoot);
    const baseline = loadBaseline(pipelineRoot);

    // 2) escaneo vacio -> exit 1 (SEC-9), mensaje literal.
    const modulos = scan.listarModulos(pipelineRoot).filter((m) => !SELF_EXEMPT.has(m));
    if (modulos.length === 0) {
        lines.push('el escaner no encontro ningun modulo productivo bajo ' + rel(repoRoot, pipelineRoot));
        return { code: 1, lines, hallazgos: [], remedios: REMEDIOS_TODOS, modulos: 0, tests: 0 };
    }
    const tests = listarTests(repoRoot, opts.origenes).filter((t) => !SELF_EXEMPT.has(rel(pipelineRoot, t)));
    if (tests.length === 0) {
        lines.push('glob no matcheo ningun archivo de test en los origenes: ' + (opts.origenes || ORIGENES_TESTS).join(', '));
        return { code: 1, lines, hallazgos: [], remedios: REMEDIOS_TODOS, modulos: modulos.length, tests: 0 };
    }

    // 3) R1
    const r1 = lintInventario(pipelineRoot, inventario);
    const hallazgos = r1.hallazgos.slice();

    // 4) R2 — ratchet de pendientes por modulo::funcion
    const pendientes = pendientesEfectivos(r1.escaneo, r1.porClaveJson);
    const enBaseline = new Set(baseline.pendientes);
    const clavesAhora = new Set(pendientes.map(scan.clave));
    for (const p of pendientes) {
        if (enBaseline.has(scan.clave(p))) continue;
        hallazgos.push(hallazgo('R2', '.pipeline/' + p.modulo, p.linea, p.via, p.canal,
            `punto \`pendiente\` NUEVO fuera del baseline (${scan.clave(p)}): el ratchet solo baja`));
    }
    const pendientesResueltos = baseline.pendientes.filter((k) => !clavesAhora.has(k));

    // 5) R3 — destinos en tests
    const congelados = new Set(baseline.tests);
    const r3 = [];
    for (const t of tests) r3.push(...lintTest(t, repoRoot, miembros));
    const r3Congelados = r3.filter((h) => congelados.has(h.clave));
    for (const h of r3) if (!congelados.has(h.clave)) hallazgos.push(h);
    const testsResueltos = baseline.tests.filter((k) => !r3.some((h) => h.clave === k));

    if (hallazgos.length) {
        const reglas = new Set(hallazgos.map((h) => h.regla));
        lines.push(hallazgos.length + ' hallazgo(s) nuevo(s) en ' + modulos.length + ' modulos y ' + tests.length + ' tests escaneados:');
        for (const h of hallazgos) lines.push(formatHallazgo(h));
        return { code: 1, lines, hallazgos, remedios: remediosPara(reglas), modulos: modulos.length, tests: tests.length };
    }

    // Verde: UNA linea de OK + conteos por estado + delta vs baseline y vs HEAD (SEC-4b).
    lines.push('OK — ' + modulos.length + ' modulos, ' + tests.length + ' tests escaneados, 0 hallazgos nuevos; '
        + 'baseline: ' + baseline.pendientes.length + ' pendientes, ' + baseline.tests.length + ' destinos de test congelados');
    const conteos = contarEstados(inventario);
    lines.push('INVENTARIO: ' + inventario.length + ' puntos — ' + fmtConteos(conteos));
    const delta = deltaVsHead(repoRoot, inventario);
    if (delta.disponible) {
        if (delta.transiciones.length) {
            lines.push('TRANSICIONES vs HEAD (' + fmtConteos(delta.antes) + ' -> ' + fmtConteos(conteos) + '):');
            for (const t of delta.transiciones) lines.push('  ' + sanear(t));
        } else {
            lines.push('TRANSICIONES vs HEAD: ninguna');
        }
    } else {
        lines.push('TRANSICIONES vs HEAD: no disponible (sin git o sin ' + INVENTARIO_FILE + ' en HEAD)');
    }
    if (r3Congelados.length) {
        lines.push('DEUDA CONGELADA (baseline.tests): ' + r3Congelados.length + ' destino(s) de test dentro del productivo — '
            + r3Congelados.map((h) => h.file + ':' + h.line).join(', '));
    }
    if (r1.desactualizadas.length) {
        lines.push('AVISO: ' + r1.desactualizadas.length + ' entrada(s) del inventario con `linea` desactualizada '
            + '(no bloquea; `node .pipeline/lib/write-points-scan.js --sync .pipeline` la re-ancla)');
    }
    if (pendientesResueltos.length || testsResueltos.length) {
        lines.push('El baseline ENCOGIO: ' + pendientesResueltos.length + ' pendiente(s) y ' + testsResueltos.length
            + ' destino(s) de test ya no aplican. Correr `--write-baseline` y dejar el diff en el PR.');
    }
    return { code: 0, lines, hallazgos: [], remedios: [], modulos: modulos.length, tests: tests.length };
}

// --- --write-baseline ---------------------------------------------------------------

/** R-A2 (de #6260): abortar si hay `.js` UNTRACKED en alcance bajo `.pipeline`. */
function assertWorktreeLimpio(repoRoot) {
    let out;
    try {
        out = execFileSync('git', ['status', '--porcelain', '-z', '--', '.pipeline'], { cwd: repoRoot, encoding: 'utf8' });
    } catch {
        throw new ConfigError('no se pudo consultar `git status --porcelain -- .pipeline` (R-A2)');
    }
    const untracked = out.split('\0')
        .filter((r) => r.startsWith('?? '))
        .map((r) => r.slice(3).replace(/\\/g, '/'))
        .filter((p) => {
            const segs = p.replace(/^\.pipeline\//, '').split('/').filter(Boolean);
            if (segs.slice(0, -1).some((s) => SKIP_DIRS.has(s) || SCRATCH_DIR_RE.test(s))) return false;
            const last = segs[segs.length - 1] || '';
            return p.endsWith('/') || last.endsWith('.js');
        });
    if (untracked.length) {
        const muestra = untracked.slice(0, 10).join(', ') + (untracked.length > 10 ? ', ...' : '');
        throw new ConfigError(untracked.length + ' archivo(s) UNTRACKED en alcance bajo `.pipeline`: ' + muestra
            + '. Regenerar con ellos hornea claves que el CI no tiene. Commitealos, borralos, o volve a correr con '
            + '`--allow-dirty` si entran en ESTE mismo commit.');
    }
}

/**
 * Regenera el baseline. Shrink-only: si existe y alguna clave (pendiente o
 * destino de test) CRECERIA, aborta con exit 1 listandolas. Sin baseline previo
 * (siembra inicial) escribe lo que hay.
 */
function writeBaseline(opts = {}, logger = defaultLogger()) {
    const pipelineRoot = path.resolve(opts.pipelineRoot || DEFAULT_PIPELINE_ROOT);
    const repoRoot = path.resolve(opts.repoRoot || path.join(pipelineRoot, '..'));
    if (!opts.skipGitCheck) assertWorktreeLimpio(repoRoot);
    const miembros = miembrosProductivo({ productiveDir: opts.productiveDir, env: opts.env || process.env });
    const inventario = loadInventario(pipelineRoot);
    const r1 = lintInventario(pipelineRoot, inventario);
    if (r1.hallazgos.length) {
        logger.error('--write-baseline ABORTA: el inventario esta desincronizado (R1). Primero --sync y curar.');
        for (const h of r1.hallazgos) logger.error(formatHallazgo(h));
        return 1;
    }
    const pendientes = pendientesEfectivos(r1.escaneo, r1.porClaveJson).map(scan.clave).sort();
    const tests = [];
    for (const t of listarTests(repoRoot, opts.origenes).filter((f) => !SELF_EXEMPT.has(rel(pipelineRoot, f)))) {
        for (const h of lintTest(t, repoRoot, miembros)) tests.push(h.clave);
    }
    tests.sort();
    const file = path.join(pipelineRoot, 'lib', BASELINE_FILE);
    let prev = null;
    if (fs.existsSync(file)) prev = loadBaseline(pipelineRoot);
    if (prev) {
        const crecenP = pendientes.filter((k) => !prev.pendientes.includes(k));
        const crecenT = tests.filter((k) => !prev.tests.includes(k));
        if (crecenP.length || crecenT.length) {
            logger.error('--write-baseline ABORTA: el baseline CRECERIA en ' + (crecenP.length + crecenT.length) + ' clave(s). Shrink-only.');
            for (const k of crecenP) logger.error('  pendiente nuevo: ' + sanear(k));
            for (const k of crecenT) logger.error('  destino de test nuevo: ' + sanear(k));
            return 1;
        }
    }
    const doc = {
        _doc: 'Ratchet shrink-only del guardrail por destino (#7114). `pendientes`: puntos del inventario que '
            + 'resuelven ad-hoc, clave modulo::funcion (nunca por linea). `tests`: destinos estaticos de tests dentro '
            + 'del .pipeline productivo, clave archivo::variable::destino. Crecer = exit 1. Se regenera SOLO cuando '
            + 'encoge: node .pipeline/lib/write-target-lint.js --write-baseline. Goteo de pendientes: #7464.',
        pendientes,
        tests,
    };
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    logger.info('baseline regenerado: ' + pendientes.length + ' pendientes, ' + tests.length + ' destinos de test');
    return 0;
}

// --- CLI -----------------------------------------------------------------------------

function main() {
    const logger = defaultLogger();
    const argv = process.argv.slice(2);
    const conocidos = new Set(['--check', '--write-baseline', '--allow-dirty']);
    if (!argv.every((a) => conocidos.has(a))) {
        logger.error('uso: node write-target-lint.js [--check | --write-baseline] [--allow-dirty]');
        process.exit(2);
    }
    try {
        if (argv.includes('--write-baseline')) {
            process.exit(writeBaseline({ skipGitCheck: argv.includes('--allow-dirty') }, logger));
        }
        const { code, lines, remedios } = check({});
        for (const l of lines) (code === 0 ? logger.info : logger.error)(l);
        if (code !== 0) {
            console.error('');
            console.error('Para resolver (en este orden):');
            for (const l of (remedios && remedios.length ? remedios : REMEDIOS_TODOS)) console.error(l);
        }
        process.exit(code);
    } catch (e) {
        if (e instanceof ConfigError) {
            logger.error('config invalida: ' + e.message);
            process.exit(2);
        }
        logger.error('fatal: ' + (e && e.message));
        process.exit(2);
    }
}

if (require.main === module) main();

module.exports = {
    check,
    writeBaseline,
    ConfigError,
    _internal: {
        canonizar, miembrosProductivo, miembroQueContiene, destinoRelativo, sanear,
        loadInventario, loadBaseline, lintInventario, pendientesEfectivos,
        listarTests, walkTests, inScope, lintTest, resolverValor, destinoEfectivo, extraerExpresion, splitArgs, literalString,
        formatHallazgo, remediosPara, deltaVsHead, canalDeDestino, assertWorktreeLimpio,
        REMEDIO_SYNC, REMEDIO_CURAR, REMEDIO_TEST, REMEDIO_BASELINE, REMEDIO_NO_VERIFY, REMEDIOS_TODOS,
        SELF_EXEMPT, ORIGENES_TESTS, VARIABLES_DIR, VARIABLE_RAIZ, SUBDIR_RAIZ, OPCION_DIR, SKIP_DIRS, SCRATCH_DIR_RE,
        DEFAULT_PIPELINE_ROOT, BASELINE_FILE, INVENTARIO_FILE, LOG_PREFIX, CANALES,
        RE_ENV_ASIGNA, RE_PROPIEDAD,
    },
};

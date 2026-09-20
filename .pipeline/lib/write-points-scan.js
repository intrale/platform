'use strict';

/**
 * #7112 · CA-1 / SEC-15 — ESCÁNER ESTRUCTURAL DE PUNTOS DE ESCRITURA.
 *
 * Recorre `.pipeline/*.js`, `.pipeline/lib/**` y `.pipeline/metrics/**` (sin
 * tests, scratch ni `node_modules`) y devuelve, por módulo que ESCRIBE, cada PUNTO DE RESOLUCIÓN
 * de directorio: el lugar donde el módulo decide a qué `.pipeline` apunta.
 * Es la fuente contra la que `lib/write-points.json` se compara (diff = ∅) y la
 * entrada del guardrail de #7114.
 *
 * Un punto de resolución es una línea de CÓDIGO (no comentario) que:
 *   - usa `writeTarget.writeDir|writePath|safeWriteDir|safeWritePath(` → `estado: migrado`
 *     (o `safe` si es la variante que nunca lanza), o
 *   - lee `process.env.PIPELINE_DIR_OVERRIDE|PIPELINE_STATE_DIR|PIPELINE_REPO_ROOT`
 *     para armar un directorio → `estado: pendiente`, o
 *   - importa `REPO_ROOT` de `lib/traceability` (que lo deriva de
 *     `PIPELINE_REPO_ROOT` + git y NO honra `PIPELINE_DIR_OVERRIDE`: inmune al
 *     dir efímero del runner — rebote rev-2, `metrics/aggregator.js`) →
 *     `estado: pendiente`, `inmune: true`, o
 *   - arma un path con `__dirname` (fuera de `require(...)`) → `estado: pendiente`,
 *     incluido el ALIAS `const X = __dirname;` (rebote rev-2 de #7112: la
 *     forma que usaban `quota-snapshot-scheduler.js` y `smoke-test.js` y que
 *     dejaba la cola de Telegram y dos logs fuera del inventario).
 *
 * Un módulo ESCRIBE si su código contiene alguna llamada de escritura
 * (`writeFileSync`, `appendFileSync`, `mkdirSync`, `renameSync`, `rmSync`,
 * `unlinkSync`, `copyFileSync`, `writeFile(`, `appendFile(`, `createWriteStream`,
 * `openSync(..., 'a'|'w')`, `writeSync`). Un módulo que sólo LEE queda fuera
 * (los lectores migran por goteo; leer no derrama).
 *
 * La `funcion` de cada punto es el identificador que lo nombra: la const/let
 * asignada en esa línea, o la función que la contiene, o `inline:L<n>`.
 *
 * Heurístico a propósito: es un grep estructural reproducible, no un parser.
 * Prefiere el falso positivo (una entrada de más en el inventario) al falso
 * negativo (un escritor invisible para #7114).
 *
 * @module write-points-scan
 */

const fs = require('fs');
const path = require('path');

const RE_ESCRITURA = /\b(writeFileSync|appendFileSync|mkdirSync|renameSync|rmSync|unlinkSync|copyFileSync|writeFile|appendFile|createWriteStream|writeSync|truncateSync)\s*\(|openSync\([^)]*,\s*['"](a|w)[+a-z]*['"]/;
const RE_ENV_DIR = /process\.env\.PIPELINE_(DIR_OVERRIDE|STATE_DIR|REPO_ROOT)\b/;
const RE_DIRNAME = /\b__dirname\b/;
// Dos formas del envoltorio: `writeTarget.writeDir(` (require en cabecera) y
// `require('./write-target').writeDir(` (require perezoso dentro de la función).
const RE_WRITE_TARGET = /(?:\bwriteTarget|require\(\s*['"][^'"]*write-target['"]\s*\))\.(writeDir|writePath|safeWriteDir|safeWritePath)\s*\(/;
const RE_REQUIRE_DIRNAME = /require\([^)]*__dirname[^)]*\)/;
// Formas en que una línea ARMA un directorio a partir de `__dirname`:
//   path.join(__dirname, …) / path.resolve(__dirname, …) / path.dirname(__dirname)
//   const X = __dirname;            (alias crudo — rebote rev-2)
//   __dirname + '/logs' / `${__dirname}/logs`
const RE_DIRNAME_ARMA = /path\.(join|resolve|dirname)\s*\([^)]*__dirname|=\s*__dirname\b|__dirname\s*\+|\$\{__dirname\}/;
// `const { REPO_ROOT, … } = require('../lib/traceability')` o
// `({ REPO_ROOT } = require('../lib/traceability'))`: raíz derivada de
// PIPELINE_REPO_ROOT + git, ciega al override del runner (CA-5).
const RE_TRACE_REPO_ROOT = /\bREPO_ROOT\b[^=]*=\s*require\(\s*['"][^'"]*traceability['"]\s*\)/;

/** Directorios excluidos por nombre de segmento. */
function esDirExcluido(nombre) {
    return nombre === 'node_modules' || nombre === '__tests__' || nombre === 'tests'
        || nombre === 'fixtures' || nombre === '_test-helpers' || nombre === 'test-helpers'
        || nombre === 'assets' || nombre === 'views'
        || nombre === '_tmp' || /^tmp/.test(nombre) || nombre === 'skills-deterministicos';
}

function esArchivoExcluido(nombre) {
    return !nombre.endsWith('.js') || nombre.endsWith('.test.js') || nombre.startsWith('test-');
}

/**
 * Lista los módulos en alcance (rutas relativas a `pipelineDir`, con `/`).
 *
 * @param {string} pipelineDir
 * @returns {string[]}
 */
function listarModulos(pipelineDir) {
    const out = [];
    const raiz = path.resolve(pipelineDir);
    for (const e of fs.readdirSync(raiz, { withFileTypes: true })) {
        if (e.isFile() && !esArchivoExcluido(e.name)) out.push(e.name);
    }
    const libDir = path.join(raiz, 'lib');
    const walk = (dir, rel) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.isDirectory()) {
                if (!esDirExcluido(e.name)) walk(path.join(dir, e.name), rel + e.name + '/');
            } else if (e.isFile() && !esArchivoExcluido(e.name)) {
                out.push(rel + e.name);
            }
        }
    };
    if (fs.existsSync(libDir)) walk(libDir, 'lib/');
    // `metrics/` escribe dentro de `.pipeline` (snapshots del aggregator,
    // budget-config.json): entra al alcance con el mismo filtro que `lib/`.
    const metricsDir = path.join(raiz, 'metrics');
    if (fs.existsSync(metricsDir)) walk(metricsDir, 'metrics/');
    return out.sort();
}

/** Quita comentarios de línea (aprox.: primer `//` que no sea parte de `://`). */
function codigoDe(linea) {
    if (/^\s*(\/\/|\*|\/\*)/.test(linea)) return '';
    const idx = linea.search(/(?<!:)\/\/(?!\/)/);
    return idx >= 0 ? linea.slice(0, idx) : linea;
}

/**
 * Nombre que identifica el punto: const/let asignado en la línea, si no la
 * función contenedora (última `function nombre(` o `nombre = (...) =>` /
 * `nombre(...) {` de método antes de la línea), si no `inline:L<n>`.
 */
function nombreDelPunto(lineas, i) {
    const c0 = codigoDe(lineas[i]);
    const m = c0.match(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/);
    if (m) return m[1];
    if (RE_TRACE_REPO_ROOT.test(c0)) return 'REPO_ROOT';
    // Reasignación de una variable ya declarada (`REPO_ROOT = process.env…` en un
    // `catch`): el identificador asignado nombra el punto, no la función contenedora.
    const r = c0.match(/^\s*\(?\s*([A-Za-z_$][\w$]*)\s*=(?!=)/);
    if (r && !['module', 'exports'].includes(r[1])) return r[1];
    for (let j = i; j >= 0; j--) {
        const c = codigoDe(lineas[j]);
        const f = c.match(/^\s*(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/)
            || c.match(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/)
            || c.match(/^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*$/)
            || c.match(/^\s*([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:function\s*\(|\([^)]*\)\s*=>)/);
        if (f && !['if', 'for', 'while', 'switch', 'catch', 'function'].includes(f[1])) return f[1];
        if (/^(function|class)\b/.test(c) && j < i) break;
    }
    return `inline:L${i + 1}`;
}

/**
 * Escanea un módulo.
 *
 * @param {string} abs ruta absoluta.
 * @returns {{escribe: boolean, puntos: Array<{funcion: string, linea: number, estado: string, via: string}>}}
 */
function escanearModulo(abs) {
    const lineas = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
    let escribe = false;
    // Un mismo identificador con varias líneas (p. ej. un `if` de fallback + el
    // `return` por defecto) es UN punto: se agregan sus líneas y se decide al final.
    const porFuncion = new Map();
    for (let i = 0; i < lineas.length; i++) {
        const c = codigoDe(lineas[i]);
        if (!c) continue;
        if (RE_ESCRITURA.test(c)) escribe = true;
        let tipo = null;
        const wt = c.match(RE_WRITE_TARGET);
        if (wt) tipo = wt[1] === 'safeWriteDir' || wt[1] === 'safeWritePath' ? 'safe' : 'migrado';
        else if (RE_ENV_DIR.test(c)) tipo = 'env';
        else if (RE_TRACE_REPO_ROOT.test(c)) tipo = 'trace';
        else if (RE_DIRNAME.test(c) && !RE_REQUIRE_DIRNAME.test(c) && RE_DIRNAME_ARMA.test(c)) tipo = 'dirname';
        if (!tipo) continue;
        const funcion = nombreDelPunto(lineas, i);
        if (!porFuncion.has(funcion)) porFuncion.set(funcion, { funcion, linea: i + 1, tipos: new Set() });
        porFuncion.get(funcion).tipos.add(tipo);
    }
    // Líneas de escritura del módulo (para atar cada punto a un destino real).
    const lineasEscritura = [];
    for (let i = 0; i < lineas.length; i++) {
        const c = codigoDe(lineas[i]);
        if (c && RE_ESCRITURA.test(c)) lineasEscritura.push({ i, c });
    }
    const puntos = [];
    for (const p of porFuncion.values()) {
        if (!alimentaEscritura(lineas, lineasEscritura, p)) continue;
        const t = p.tipos;
        let estado;
        if (t.has('env') || t.has('dirname') || t.has('trace')) estado = 'pendiente';
        else if (t.has('safe') && !t.has('migrado')) estado = 'safe';
        else estado = 'migrado';
        const via = t.has('dirname') && !t.has('env') && !t.has('trace') ? '__dirname'
            : t.has('env') ? 'process.env.PIPELINE_*'
                : t.has('trace') ? 'traceability.REPO_ROOT'
                    : t.has('safe') ? 'writeTarget.safeWriteDir' : 'writeTarget.writeDir';
        // Inmune al override del runner: __dirname crudo, o la raíz de
        // traceability (PIPELINE_REPO_ROOT + git), sin variable de dir ni envoltorio.
        const inmune = (t.has('dirname') || t.has('trace')) && !t.has('env') && !t.has('migrado') && !t.has('safe');
        puntos.push({ funcion: p.funcion, linea: p.linea, estado, via, inmune });
    }
    return { escribe, puntos };
}

const RE_IDENT = /[A-Za-z_$][\w$]*/g;

/**
 * ¿El punto alimenta alguna escritura del módulo? Cierre transitivo liviano:
 * el identificador del punto, más las const/let cuya definición lo usa (hasta
 * 3 niveles), tiene que aparecer en una línea de escritura. Un punto `inline`
 * cuenta si su propia línea escribe; una FUNCIÓN cuenta además si escribe
 * dentro de su cuerpo (hasta la próxima declaración a columna 0).
 * Así `ASSETS_DIR`, `SCHEMA_PATH` o un `ROOT` usado sólo como `cwd` de git no
 * entran: son lecturas.
 */
function alimentaEscritura(lineas, lineasEscritura, p) {
    if (p.funcion.startsWith('inline:')) {
        return lineasEscritura.some((w) => w.i === p.linea - 1);
    }
    const cierre = new Set([p.funcion]);
    const usaCierre = (c) => (c.match(RE_IDENT) || []).some((id) => cierre.has(id));
    const funciones = definicionesDeFuncion(lineas);
    for (let ronda = 0; ronda < 5; ronda++) {
        let creció = false;
        for (const linea of lineas) {
            const c = codigoDe(linea);
            const m = c.match(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=(.*)$/);
            if (!m || cierre.has(m[1])) continue;
            if (usaCierre(m[2])) { cierre.add(m[1]); creció = true; }
        }
        // Cadena función→función: `pipelineDir()` usada dentro de `queueDir()`,
        // que a su vez alimenta `writeFileSync(queueDir(), …)`. Una función entra
        // al cierre si su cuerpo usa algún identificador del cierre.
        for (const fn of funciones) {
            if (cierre.has(fn.nombre)) continue;
            for (let j = fn.def; j < fn.fin; j++) {
                if (usaCierre(codigoDe(lineas[j]))) { cierre.add(fn.nombre); creció = true; break; }
            }
        }
        if (!creció) break;
    }
    if (lineasEscritura.some((w) => usaCierre(w.c))) return true;
    // Función: ¿escribe en su propio cuerpo (o en el de alguna del cierre)?
    return funciones.some((fn) => cierre.has(fn.nombre)
        && lineasEscritura.some((w) => w.i >= fn.def && w.i < fn.fin));
}

/**
 * Definiciones de función del módulo (declaración, arrow asignada, método de
 * objeto) con su rango de líneas [def, fin): el cuerpo termina en la próxima
 * declaración con indentación menor o igual a la de la definición (exclusivo).
 */
function definicionesDeFuncion(lineas) {
    const out = [];
    for (let i = 0; i < lineas.length; i++) {
        const c = codigoDe(lineas[i]);
        const f = c.match(/^\s*(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/)
            || c.match(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/)
            || c.match(/^\s+([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:function\s*\(|\([^)]*\)\s*=>)\s*\{?\s*$/)
            || c.match(/^\s+(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*$/);
        if (!f || ['if', 'for', 'while', 'switch', 'catch', 'function', 'return'].includes(f[1])) continue;
        const indent = (lineas[i].match(/^\s*/) || [''])[0].length;
        let fin = lineas.length;
        for (let j = i + 1; j < lineas.length; j++) {
            const t = lineas[j].trim();
            if (!t) continue;
            const ind = (lineas[j].match(/^\s*/) || [''])[0].length;
            if (ind <= indent && /^(function\b|async function\b|class\b|const\b|let\b|var\b|module\.exports|\}|[A-Za-z_$][\w$]*\s*[:(])/.test(t)) { fin = j; break; }
        }
        out.push({ nombre: f[1], def: i, fin });
    }
    return out;
}

/**
 * Escaneo completo: sólo módulos que escriben y tienen ≥1 punto de resolución.
 *
 * @param {string} pipelineDir
 * @returns {Array<{modulo: string, funcion: string, linea: number, estado: string, via: string}>}
 */
function escanear(pipelineDir) {
    const out = [];
    for (const modulo of listarModulos(pipelineDir)) {
        const r = escanearModulo(path.join(pipelineDir, modulo));
        if (!r.escribe || r.puntos.length === 0) continue;
        for (const p of r.puntos) out.push({ modulo, ...p });
    }
    return out;
}

const clave = (e) => `${e.modulo}::${e.funcion}`;

/** Tier del inventario (D-1 del PO): 1 = derramó el 08/09 o marcador de pausa; 2 = servicios/dashboard; 3 = goteo. */
const TIER_1 = new Set(['pulpo.js', 'servicio-telegram.js', 'servicio-github.js', 'restart.js',
    'lib/notify-telegram.js', 'lib/partial-pause.js', 'lib/operational-state-backend.js',
    'lib/rest-mode-state.js', 'lib/rest-mode-window.js']);
const TIER_2 = new Set(['servicio-drive.js', 'servicio-reconciler.js', 'servicio-emulador.js',
    'listener-telegram.js', 'dashboard.js', 'lib/dashboard-slices.js', 'outbox-drain.js', 'singleton.js']);

function tierDe(modulo) { return TIER_1.has(modulo) ? 1 : TIER_2.has(modulo) ? 2 : 3; }

/** Canal por defecto de un punto nuevo (curable a mano en el JSON). */
function canalPorDefecto(modulo, funcion) {
    const t = (modulo + ' ' + funcion).toLowerCase();
    if (/pause|paused/.test(t)) return 'pausa';
    if (/servicio|telegram|github|outbox|queue|cola/.test(t)) return 'colas';
    if (/log|audit|report|metric|history|jsonl/.test(t)) return 'logs';
    return 'estado';
}

const ESTADOS = Object.freeze(['migrado', 'safe', 'pendiente', 'lectura', 'externo']);
/** Estados curados a mano que sobreviven al sync mientras el escáner siga viendo 'pendiente'. */
const ESTADOS_CURADOS = Object.freeze(['lectura', 'externo']);
const CAMPOS_CURADOS = Object.freeze(['canal', 'destino', 'tier', 'nota']);

/**
 * Sincroniza el JSON con el escaneo: agrega puntos nuevos con defaults, quita
 * los que desaparecieron, actualiza `linea`/`via`/`estado` y conserva los
 * campos curados a mano (`canal`, `destino`, `tier`, `nota`). Un punto curado
 * como `estado: lectura` (falso positivo del heurístico: el `__dirname`
 * alimenta una lectura dentro de una función que también escribe) o
 * `estado: externo` (escribe fuera del árbol `.pipeline`: `qa/`, `.claude/`)
 * conserva ese estado mientras el escáner lo siga viendo como `pendiente`.
 *
 * @param {string} pipelineDir
 * @param {Array<object>} previo entradas del JSON actual.
 * @returns {Array<object>} entradas nuevas, ordenadas por módulo/línea.
 */
function sincronizar(pipelineDir, previo) {
    const porClave = new Map((previo || []).map((e) => [clave(e), e]));
    const out = [];
    for (const p of escanear(pipelineDir)) {
        const prev = porClave.get(clave(p)) || {};
        const e = {
            modulo: p.modulo,
            funcion: p.funcion,
            linea: p.linea,
            canal: prev.canal || canalPorDefecto(p.modulo, p.funcion),
            destino: prev.destino || p.via,
            tier: prev.tier || tierDe(p.modulo),
            estado: ESTADOS_CURADOS.includes(prev.estado) && p.estado === 'pendiente' ? prev.estado : p.estado,
            via: p.via,
        };
        if (p.inmune) e.inmune = true;
        if (prev.nota) e.nota = prev.nota;
        out.push(e);
    }
    return out.sort((a, b) => a.modulo.localeCompare(b.modulo) || a.linea - b.linea);
}

/** Ruta canónica del inventario para un `pipelineDir`. */
function rutaInventario(pipelineDir) {
    return path.join(pipelineDir, 'lib', 'write-points.json');
}

/** Lee el inventario (`{ puntos: [...] }`); `[]` si no existe. */
function leerInventario(pipelineDir) {
    try {
        return JSON.parse(fs.readFileSync(rutaInventario(pipelineDir), 'utf8')).puntos || [];
    } catch {
        return [];
    }
}

/** Escribe el inventario sincronizado y devuelve sus puntos. */
function escribirInventario(pipelineDir) {
    const puntos = sincronizar(pipelineDir, leerInventario(pipelineDir));
    const doc = {
        descripcion: 'Inventario de puntos de resolucion de directorio que terminan en escritura dentro de .pipeline (#7112 / SEC-15). Se regenera con `node lib/write-points-scan.js --sync`; canal/destino/tier/nota se curan a mano y sobreviven al sync. Es la entrada del guardrail de #7114.',
        canales: ['colas', 'logs', 'estado', 'pausa'],
        estados: {
            migrado: 'resuelve via lib/write-target (falla ruidoso con dir null)',
            safe: 'resuelve via safeWriteDir (nunca lanza; saltea el archivo)',
            pendiente: 'resuelve ad-hoc (__dirname / process.env.PIPELINE_*): migra por goteo, cubierto por el dir efimero del runner',
            lectura: 'falso positivo del heuristico: el punto alimenta solo lecturas',
            externo: 'escribe fuera del arbol .pipeline (qa/, .claude/): no es destino del resolvedor de ambiente',
        },
        puntos,
    };
    fs.writeFileSync(rutaInventario(pipelineDir), JSON.stringify(doc, null, 2) + '\n');
    return puntos;
}

function resumen(puntos) {
    const porEstado = puntos.reduce((a, e) => { a[e.estado] = (a[e.estado] || 0) + 1; return a; }, {});
    return `${puntos.length} puntos en ${new Set(puntos.map((e) => e.modulo)).size} módulos — ${JSON.stringify(porEstado)}`;
}

module.exports = {
    escanear, escanearModulo, listarModulos, sincronizar, leerInventario, escribirInventario, rutaInventario,
    clave, tierDe, canalPorDefecto, ESTADOS, ESTADOS_CURADOS, CAMPOS_CURADOS, RE_ESCRITURA, RE_ENV_DIR, RE_WRITE_TARGET,
    RE_DIRNAME_ARMA, RE_TRACE_REPO_ROOT,
};

if (require.main === module) {
    // Uso: node lib/write-points-scan.js [dir]          → escaneo crudo a stdout
    //      node lib/write-points-scan.js --sync [dir]   → reescribe lib/write-points.json
    const args = process.argv.slice(2);
    // #7112 — sin dir posicional, el `.pipeline` a escanear/escribir sale del envoltorio
    // (SEC-13): sin ambiente declarado ni dir de pruebas avisa por stderr y LANZA.
    // Alternativa explícita: `node lib/write-points-scan.js --sync <dir>`.
    const dir = path.resolve(args.find((a) => !a.startsWith('--'))
        || require('./write-target').writeDir(process.env, { canal: 'estado', destino: 'lib/write-points.json' }));
    if (args.includes('--sync')) {
        const puntos = escribirInventario(dir);
        process.stderr.write(`[write-points-scan] ${rutaInventario(dir)}: ${resumen(puntos)}\n`);
    } else {
        const res = escanear(dir);
        process.stderr.write(`[write-points-scan] ${resumen(res)}\n`);
        process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    }
}

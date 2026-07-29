// =============================================================================
// config-resolver-guard.test.js — #5172 · CA-2 / CA-3 / CA-17
// =============================================================================
//
// Guard estructural: ningún archivo de producción bajo `.pipeline/` conserva su
// propio `yaml.load` de `config.yaml`.
//
// ## Por qué el guard es así y no como estaba redactado en el CA
//
// El CA proponía `grep yaml.load` sobre archivos que mencionan `config.yaml`.
// Ese filtro da **5 falsos positivos** (`rejection-report.js`,
// `lib/pipeline-rewind.js`, `lib/task-contract.js`, `test-connectivity-state.js`
// parsean work-files/contratos y sólo NOMBRAN config.yaml en comentarios), y la
// salida cómoda sería inflar la allowlist hasta vaciar el CA-3 de contenido.
//
// La receta corrigió a "matchear el argumento de `yaml.load`", pero medido sobre
// HEAD ese regex da el problema INVERSO y peor (G-1): detecta 11 de 22, porque
// la mitad de los lectores arman la ruta en una variable local
// (`yaml.load(fs.readFileSync(target))` con `target = CONFIG_FILE`). Con ese
// guard, CA-2 pasaría en verde con la mitad de los lectores sin migrar —
// exactamente la clase de fallo silencioso que la historia viene a matar.
//
// El guard efectivo es a nivel ARCHIVO, **quitando comentarios antes de
// matchear**: eso elimina los 4 falsos positivos sin necesidad de allowlist y no
// pierde ningún lector real. Sobre HEAD pre-migración detectaba 24 = los 22 de
// producción + `kernel-parity.js` + `test-dev-routing-regression.js`.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PIPELINE_DIR = path.resolve(__dirname, '..', '..');

// -----------------------------------------------------------------------------
// Allowlist — exactamente 2 entradas, cada una con su justificación EN EL CÓDIGO
// del test (CA-3). Prohibida la allowlist por patrón o por prefijo: una entrada
// sin comentario hace fallar este mismo test.
// -----------------------------------------------------------------------------
const ALLOWLIST = new Map([
    [
        'test-dev-routing-regression.js',
        // Harness de regresión de routing, NO producción: lee `config.yaml` para
        // afirmar SOBRE EL PROPIO ARCHIVO bajo test (que el ruteo declarado en
        // config produce el skill esperado). No consume el resolver a propósito:
        // si lo hiciera, estaría testeando el resolver, no el archivo.
        'harness de regresión — assert sobre el archivo, no consumo de config',
    ],
    [
        'lib/kernel-parity.js',
        // Compara `.pipeline/config.yaml` entre DOS revisiones git (`git show`),
        // no del disco actual: `resolve()` no puede servirlo. Usa
        // `resolveForDiff(text)` (D-B), que parsea+valida texto arbitrario sin
        // lanzar — un baseline viejo puede violar el schema actual y eso no es
        // corrupción del runtime.
        'lectura por revisión git — usa resolveForDiff',
    ],
]);

/** El módulo que TIENE que hacer el `yaml.load`: es el punto único. */
const RESOLVER_REL = 'lib/config-resolver.js';

// -----------------------------------------------------------------------------

function stripComments(src) {
    // Bloque primero, después línea. No pretende ser un parser: alcanza para que
    // una mención de `config.yaml` en prosa no cuente como lectura.
    // CRLF → LF ANTES de nada. Sin esto el guard es silenciosamente inútil en
    // los archivos con finales de línea de Windows: en JS `.` NO matchea `\r`,
    // así que `//.*$` no llega a matchear nunca (el `\r` final queda entre `.*`
    // y `$`) y NINGÚN comentario de línea se elimina. El síntoma no es un error
    // sino un guard que empieza a contar comentarios como código — falsos
    // positivos que empujan a inflar la allowlist. Detectado con
    // `multi-provider/health-cron.js`, que quedó en CRLF.
    return src
        .replace(/\r\n?/g, '\n')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
        .join('\n');
}

function walk(dir, acc = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            // `_tmp/` son worktrees de agentes (copias del repo), `__tests__/` y
            // `node_modules/` no son producción.
            if (entry.name === '_tmp' || entry.name === '__tests__' || entry.name === 'node_modules') continue;
            walk(full, acc);
        } else if (entry.isFile() && entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
            acc.push(full);
        }
    }
    return acc;
}

function rel(file) {
    return path.relative(PIPELINE_DIR, file).split(path.sep).join('/');
}

/**
 * Tokens que identifican una ruta a `config.yaml` (literal o por constante).
 * `cfgPath`/`configPath` NO van acá: tras la migración son el NOMBRE DEL
 * PARÁMETRO que se le pasa al resolver (`resolve({configPath: cfgPath})`), no
 * un argumento de `yaml.load`. Incluirlos volvería a dar falsos positivos.
 */
const TOKEN_CONFIG = /['"`]config\.yaml['"`]|CONFIG_PATH|CONFIG_FILE|CONFIG_REL|PIPELINE_CONFIG_PATH/;

/**
 * Extrae el texto del argumento de cada llamada `yaml.load(...)`, respetando
 * paréntesis balanceados (el argumento suele ser `fs.readFileSync(x, 'utf8')`).
 * @param {string} t - fuente YA sin comentarios.
 * @returns {string[]}
 */
function argumentosDeYamlLoad(t) {
    const out = [];
    const re = /yaml\.load\s*\(/g;
    let m;
    while ((m = re.exec(t)) !== null) {
        let depth = 1;
        let i = m.index + m[0].length;
        const start = i;
        while (i < t.length && depth > 0) {
            if (t[i] === '(') depth += 1;
            else if (t[i] === ')') depth -= 1;
            i += 1;
        }
        out.push(t.slice(start, depth === 0 ? i - 1 : i));
    }
    return out;
}

/**
 * Mapa `variable -> expresión asignada`, para UN nivel de indirección local.
 * Resuelve el caso G-1 (`const target = CONFIG_FILE; yaml.load(read(target))`),
 * que es donde el guard "por argumento" de la receta detectaba 11 de 22.
 * @param {string} t - fuente YA sin comentarios.
 */
function asignacionesLocales(t) {
    const mapa = new Map();
    const acumular = (nombre, expr) => {
        // Si una variable se reasigna, conservamos ambas expresiones concatenadas:
        // que CUALQUIERA de ellas sea el config alcanza para considerarla sospechosa.
        mapa.set(nombre, (mapa.get(nombre) || '') + ' ' + expr);
    };

    const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g;
    let m;
    while ((m = re.exec(t)) !== null) acumular(m[1], m[2]);

    // Destructuring: `const { file, via } = resolveConfigPath(opts)`. Sin esto la
    // cadena se corta en seco, porque el binding no matchea el regex de arriba
    // y `file` queda como identificador desconocido (ver G-4 abajo).
    const reDestr = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*([^;\n]+)/g;
    while ((m = reDestr.exec(t)) !== null) {
        for (const parte of m[1].split(',')) {
            // Soporta `{ file }` y `{ file: f }`: nos interesa el binding LOCAL,
            // que es el que después aparece dentro del `yaml.load`.
            const nombre = (parte.includes(':') ? parte.split(':')[1] : parte).trim();
            if (/^[A-Za-z_$][\w$]*$/.test(nombre)) acumular(nombre, m[2]);
        }
    }
    return mapa;
}

/**
 * Mapa `nombreDeFunción -> cuerpo`, para trazar a través de una llamada local.
 *
 * G-4 — Por qué hace falta: sin esto el guard NO detectaba a
 * `lib/config-resolver.js`, o sea al único lector que TIENE que existir. Su
 * cadena real es
 *   `yaml.load(fs.readFileSync(file))` → `const { file } = resolveConfigPath(opts)`
 *   → y el literal `'config.yaml'` vive DENTRO de `resolveConfigPath`.
 * El trazado por variables se cortaba en `resolveConfigPath`, que no es una
 * variable sino una función. El síntoma estaba enmascarado: el assert de
 * infractores fallaba antes y nunca se llegaba a evaluar el self-check.
 *
 * Esto no es cosmética del self-check: cualquier módulo que envuelva su
 * construcción de ruta en un helper local (el refactor más natural del mundo)
 * quedaba invisible para el guard. Es la misma clase de falso verde que G-1.
 *
 * El cuerpo se extrae con barrido de llaves balanceadas — alcanza de sobra para
 * las declaraciones `function f(...) { ... }` del codebase.
 *
 * @param {string} t - fuente YA sin comentarios.
 */
function funcionesLocales(t) {
    const mapa = new Map();
    const re = /function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g;
    let m;
    while ((m = re.exec(t)) !== null) {
        let depth = 1;
        let i = m.index + m[0].length;
        const start = i;
        while (i < t.length && depth > 0) {
            if (t[i] === '{') depth += 1;
            else if (t[i] === '}') depth -= 1;
            i += 1;
        }
        mapa.set(m[1], t.slice(start, depth === 0 ? i - 1 : i));
    }
    return mapa;
}

/**
 * Detecta un lector propio de `config.yaml` mirando el ARGUMENTO de `yaml.load`,
 * con un nivel de trazado de variables locales.
 *
 * Por qué NO es a nivel archivo: `pulpo.js` (`readYaml`, #3941) y `dashboard.js`
 * (`readYamlSafe`) conservan legítimamente un loader GENÉRICO de work-files
 * —que recibe el path por parámetro— y además declaran `CONFIG_PATH` para los
 * mensajes al operador. Un guard a nivel archivo los marcaría como infractores
 * aunque su lectura de config YA pase por el resolver, y la salida cómoda sería
 * meterlos en la allowlist: eso vaciaría de contenido al CA-3 y, peor, taparía
 * una regresión real futura en esos dos archivos.
 */
function esLectorDeConfig(src) {
    const t = stripComments(src);
    const vars = asignacionesLocales(t);
    const funcs = funcionesLocales(t);

    /**
     * ¿La expresión `expr` termina, siguiendo variables locales, en el config?
     *
     * El trazado es RECURSIVO y no de un solo salto: el caso real que lo obliga
     * es `deliverable-index.js`, donde hacen falta DOS saltos —
     *   `yaml.load(raw)` → `raw = fs.readFileSync(cfgPath)` → `cfgPath = path.join(root, 'config.yaml')`.
     * Con un único nivel, ese lector pasaba el guard en verde sin estar migrado:
     * exactamente el falso verde (G-1) que este guard existe para impedir.
     *
     * `vistos` corta ciclos (`let a = b; let b = a;`) y `profundidad` acota el
     * costo; 6 saltos cubren de sobra las cadenas reales del codebase.
     */
    function trazaAConfig(expr, vistos = new Set(), profundidad = 0) {
        if (!expr || profundidad > 6) return false;
        if (TOKEN_CONFIG.test(expr)) return true;
        const ids = expr.match(/[A-Za-z_$][\w$]*/g) || [];
        return ids.some((id) => {
            if (vistos.has(id)) return false;
            // Una función local se traza igual que una variable: su CUERPO es la
            // expresión de la que depende quien la llama (G-4).
            const siguiente = vars.has(id) ? vars.get(id) : funcs.get(id);
            if (siguiente === undefined) return false;
            vistos.add(id);
            return trazaAConfig(siguiente, vistos, profundidad + 1);
        });
    }

    return argumentosDeYamlLoad(t).some((arg) => trazaAConfig(arg));
}

test('CA-2 · ningún archivo de producción conserva su propio yaml.load de config.yaml', () => {
    const detectados = walk(PIPELINE_DIR)
        .filter((f) => esLectorDeConfig(fs.readFileSync(f, 'utf8')))
        .map(rel)
        .sort();

    const permitidos = new Set([RESOLVER_REL, ...ALLOWLIST.keys()]);
    const infractores = detectados.filter((f) => !permitidos.has(f));

    assert.deepEqual(infractores, [],
        'estos archivos siguen leyendo config.yaml por su cuenta en vez de usar lib/config-resolver:\n'
        + infractores.map((f) => `  - ${f}`).join('\n'));

    // El punto único tiene que estar: si el resolver desapareciera de la lista,
    // el guard pasaría en verde con CERO lectores y sin config resuelta.
    assert.ok(detectados.includes(RESOLVER_REL),
        'lib/config-resolver.js debe ser el (único) lector real de config.yaml');

    // Techo duro: el universo permitido es 3 (resolver + 2 allowlisted). Fijar el
    // conteo, no sólo la lista, es lo que impide que la allowlist crezca sola.
    assert.ok(detectados.length <= 3, `esperaba ≤3 lectores, hay ${detectados.length}: ${detectados.join(', ')}`);
});

test('CA-3 · toda entrada de la allowlist tiene justificación explícita', () => {
    assert.equal(ALLOWLIST.size, 2, 'la allowlist arranca y queda en 2 entradas (D-A)');
    for (const [archivo, motivo] of ALLOWLIST) {
        assert.equal(typeof motivo, 'string');
        assert.ok(motivo.trim().length >= 20,
            `la entrada '${archivo}' necesita un motivo escrito, no un placeholder`);
        assert.ok(fs.existsSync(path.join(PIPELINE_DIR, archivo)),
            `la allowlist no puede tener entradas muertas: falta ${archivo}`);
    }
});

test('CA-3 · la allowlist no admite patrones ni prefijos', () => {
    for (const archivo of ALLOWLIST.keys()) {
        assert.equal(/[*?]/.test(archivo), false, 'prohibida la allowlist por patrón');
        assert.ok(archivo.endsWith('.js'), 'cada entrada nombra UN archivo concreto');
    }
});

test('D-A · los falsos positivos estructurales no están en la allowlist ni en la detección', () => {
    // Estos cuatro NOMBRAN config.yaml en comentarios pero parsean work-files o
    // contratos. Que el guard los descarte solo (sin allowlist) es lo que
    // confirma D-A por otro camino.
    const falsosPositivos = [
        'rejection-report.js',
        'lib/pipeline-rewind.js',
        'lib/task-contract.js',
        'test-connectivity-state.js',
    ];
    for (const f of falsosPositivos) {
        const full = path.join(PIPELINE_DIR, f);
        if (!fs.existsSync(full)) continue;
        assert.equal(esLectorDeConfig(fs.readFileSync(full, 'utf8')), false,
            `${f} parsea work-files/contratos, no config.yaml — no debe detectarse`);
        assert.equal(ALLOWLIST.has(f), false, `${f} no necesita allowlist: el guard lo descarta solo`);
    }
});

test('CA-17 · el resolver no usa DEFAULT_FULL_SCHEMA ni loadAll', () => {
    const src = fs.readFileSync(path.join(PIPELINE_DIR, RESOLVER_REL), 'utf8');
    assert.equal(/DEFAULT_FULL_SCHEMA/.test(stripComments(src)), false);
    assert.equal(/loadAll/.test(stripComments(src)), false);
    // Y tampoco un `schema:` custom que reintroduzca tipos JS arbitrarios.
    assert.equal(/yaml\.load\s*\([^)]*,\s*\{/.test(stripComments(src)), false,
        'yaml.load se llama sin opciones: safe-by-default de js-yaml v4');
});

test('D-D · PIPELINE_CONFIG_PATH queda depreciada: ningún archivo de producción la lee', () => {
    const infractores = walk(PIPELINE_DIR)
        .filter((f) => /process\.env\.PIPELINE_CONFIG_PATH/.test(stripComments(fs.readFileSync(f, 'utf8'))))
        .map(rel);
    assert.deepEqual(infractores, [],
        'PIPELINE_CONFIG_PATH aportaba una RUTA DE ARCHIVO por entorno, que es justo lo que CA-12 prohíbe');
});

test('el guard estripa comentarios también con finales de línea CRLF', () => {
    // Regresión: en JS `.` no matchea `\r`, así que `//.*$` NUNCA matcheaba en
    // archivos CRLF y los comentarios sobrevivían enteros al stripping.
    assert.equal(esLectorDeConfig("//  se eliminó yaml.load(CONFIG_PATH)\r\nconst x = 1;\r\n"), false,
        'un comentario en CRLF no puede contar como lectura de config');
    assert.equal(esLectorDeConfig("const d = yaml.load(fs.readFileSync(CONFIG_PATH));\r\n"), true,
        'pero el código real en CRLF sí se detecta');
});

test('el stripComments del guard no se come código real', () => {
    assert.equal(esLectorDeConfig("// yaml.load de config.yaml en un comentario\nconst x = 1;\n"), false);
    assert.equal(esLectorDeConfig("/* yaml.load(CONFIG_PATH) */\nconst x = 1;\n"), false);
    assert.equal(esLectorDeConfig("const d = yaml.load(fs.readFileSync(CONFIG_PATH));\n"), true);
    assert.equal(esLectorDeConfig("const d = yaml.load(fs.readFileSync(path.join(p, 'config.yaml')));\n"), true);
    // Caso G-1: la ruta viaja en una variable local y `yaml.load` ya no la nombra.
    assert.equal(esLectorDeConfig("const target = CONFIG_FILE;\nconst d = yaml.load(fs.readFileSync(target));\n"), true);
    assert.equal(esLectorDeConfig("const target = file || CONFIG_FILE;\nconst d = yaml.load(fs.readFileSync(target, 'utf8'));\n"), true);
    // DOS saltos (forma real de `deliverable-index.js`): el argumento de
    // yaml.load no nombra el config ni de cerca; hay que seguir la cadena
    // `raw` → `cfgPath` → literal. Con trazado de un solo nivel, esto daba
    // falso verde con el lector SIN migrar.
    assert.equal(esLectorDeConfig(
        "const cfgPath = path.join(root, 'config.yaml');\n"
        + "const raw = fs.readFileSync(cfgPath, 'utf8');\n"
        + "const cfg = yaml.load(raw) || {};\n"), true);
    // El trazado no debe colgarse ante un ciclo entre variables locales.
    assert.equal(esLectorDeConfig("let a = b;\nlet b = a;\nconst d = yaml.load(a);\n"), false);
    // Un loader genérico de work-files no se detecta (dashboard.js:667).
    assert.equal(esLectorDeConfig("function readYamlSafe(f) { return yaml.load(fs.readFileSync(f, 'utf8')); }\n"), false);
});

test('el guard no marca un archivo que YA migró pero conserva un loader genérico', () => {
    // Ésta es exactamente la forma de `pulpo.js` y `dashboard.js` tras migrar:
    // la lectura de config pasa por el resolver, y sobrevive un loader genérico
    // de work-files que recibe el path por PARÁMETRO. Un guard a nivel archivo
    // los marcaba como infractores porque `CONFIG_PATH` aparece en el mismo
    // archivo (para los mensajes al operador) — falso positivo que empujaba a
    // inflar la allowlist y a tapar regresiones reales en esos dos archivos.
    const migrado = [
        "const configResolver = require('./lib/config-resolver');",
        "const CONFIG_PATH = path.join(PIPELINE, 'config.yaml');",
        "function loadConfig() { return configResolver.resolve({ pipelineDir: PIPELINE, reload: true }); }",
        "function readYaml(filepath) {",
        "  const rawText = fs.readFileSync(filepath, 'utf8');",
        "  return yaml.load(rawText) || {};",
        "}",
    ].join('\n');
    assert.equal(esLectorDeConfig(migrado), false,
        'un archivo migrado con loader genérico de work-files NO es un lector de config');

    // Y el mismo archivo, si alguien REINTRODUJERA la lectura directa, sí cae.
    assert.equal(esLectorDeConfig(migrado + "\nconst c = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8'));\n"), true,
        'una regresión real en ese mismo archivo tiene que seguir detectándose');
});

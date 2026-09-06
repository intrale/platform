#!/usr/bin/env node
'use strict';

// =============================================================================
// test-env-lint.js — Guardrail de contaminacion de `process.env` en tests
// (#6260, parte 3 de 3 del split de #6240).
//
// Objetivo
// --------
// Que la contaminacion de entorno en tests NO VUELVA A ENTRAR: analisis
// estatico que falla si un archivo de test asigna `process.env` fuera del
// helper `lib/test-helpers/with-env.js`, cableado donde realmente corre
// (hook local + CI).
//
// Este archivo entrega DETECCION + RATCHET. El barrido de las violaciones
// preexistentes es #6254 — entran al baseline como deuda VISIBLE.
//
// Clasificacion por DIRECCION DE RIESGO (no por nombre)
// ----------------------------------------------------
// `test-env-lint.protected.json` es el registro HIBRIDO (unico) de variables de
// control: entradas `nombre` y entradas `patron`, cobertura = UNION. Cada
// entrada declara `sentido_inseguro` (`encender` | `apagar` | `cualquiera`),
// OBLIGATORIO y sin default. Una linea es `estricta` (no perdonable por
// allowlist) SOLO cuando empuja la variable hacia su sentido inseguro; en el
// sentido seguro es deuda ordinaria, allowlisteable.
//
// Fail-closed en tres puntos: valor no resoluble estaticamente, clave no
// resoluble estaticamente y asignacion al objeto entero son SIEMPRE estrictas.
//
// Este modulo es tambien la UNICA fuente de la logica de direccion: lo importa
// `lib/test-helpers/with-env.js` para SEC-7 (R-A12 — dos listas divergentes
// fueron la causa raiz del hallazgo alta de `security`).
//
// Salida
// ------
//   node .pipeline/lib/test-env-lint.js --check            0 limpio / 1 violations / 2 error de config
//   node .pipeline/lib/test-env-lint.js --write-allowlist  regenera allowlist (aborta con estrictas, CA-24)
//   node .pipeline/lib/test-env-lint.js --write-baseline   regenera baseline, SOLO si encoge
//
// Los dos writers abortan si hay archivos UNTRACKED en alcance bajo `.pipeline`
// (R-A2). Un TRACKED modificado NO bloquea: viaja en el mismo commit. Para el
// caso legitimo de regenerar con archivos nuevos: `--allow-dirty`.
//
// API:
//   const { lint } = require('./test-env-lint');
//   const { violations, scanned } = lint({ pipelineRoot });
//
// SEC-4 / CA-16: analisis estatico PURO. Cero `require` dinamico, `eval`,
// `vm` o `import` dinamico sobre el archivo auditado — solo `fs.readFileSync(utf8)` +
// regex, con containment por `fs.realpathSync` contra el `pipelineRoot`.
// =============================================================================

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const LOG_PREFIX = '[test-env-lint]';

const DEFAULT_PIPELINE_ROOT = path.resolve(__dirname, '..');
const PROTECTED_FILE = 'test-env-lint.protected.json';
const ALLOWLIST_FILE = 'test-env-lint.allowlist.json';
const BASELINE_FILE = 'test-env-lint.baseline.json';

// NO es el SKIP_DIRS de ghost-artifact-lint: aquel excluye `__tests__`/`tests`,
// que es justo donde vive la enorme mayoria del alcance de este guardrail.
// Clonarlo reportaria VERDE sobre un scan vacio de contenido (CA-15' / SEC-9).
const SKIP_DIRS = new Set(['node_modules', '_tmp']);

// R-A2: directorios scratch locales (`tmp-review-*`, `tmp.algo`, dotdirs).
const SCRATCH_DIR_RE = /^(_tmp|tmp[-.]|\.)/;

// CA-23: auto-exencion de EXACTAMENTE dos paths — el helper y su propia suite.
// Sin esto el guardrail se rechaza a si mismo. Un tercer archivo bajo
// `lib/test-helpers/` que no sea el helper SI se audita.
const SELF_EXEMPT = new Set([
    'lib/test-helpers/with-env.js',
    'lib/__tests__/with-env.test.js',
]);

// --- Deteccion: las CUATRO formas -------------------------------------------
// La ASSIGN_RE captura el LADO DERECHO (grupo 2): clasificar por direccion
// exige el valor. El snippet reportado se corta despues en el `=` (SEC-8).
//
// NOMBRE_RE — `[A-Za-z0-9_]`, NO `[A-Z0-9_]`. En Windows `process.env` es
// case-insensitive: escribir la clave en minusculas deja el MISMO control
// leido en mayusculas por el consumidor, y es justo la plataforma que
// el issue cita para justificar la case-insensitivity del registro. Con la
// clase en mayusculas el guardrail no veia la escritura en minuscula NI COMO
// DEUDA: el helper `withEnv` si la bloquea (derivacion nominal con flag `i`,
// CA-38), asi que el dev frenado por el helper la evadia escribiendo a mano en
// minuscula — exactamente el vector que el guardrail existe para cazar, y que
// la seccion 7 del issue declara cerrado. La infra de clasificacion ya resolvia
// bien el nombre en minusculas (`direction()` hace `toUpperCase()` para las
// nominales y compila los patrones con flag `i`); el unico filtro era esta
// clase de caracteres. NO volver a restringirla a `[A-Z0-9_]`.
const NOMBRE_RE_SRC = '[A-Za-z0-9_]+';
// ASSIGN_OP — la asignacion compuesta TAMBIEN escribe. El lookahead `=(?!=)`
// excluye correctamente las comparaciones (`==`, `===`, `!==`), pero sin esta
// alternancia dejaba fuera `||=`, `??=` y `+=`. Un `||=` sobre el escape hatch
// de secretos lo ENCIENDE cuando la variable esta ausente (el caso normal en
// CI) y no se reportaba nada. La alternancia no admite espacios internos:
// `||=` es un token, y `x + '=y'` no matchea.
//
// Este archivo se audita a si mismo (no esta en SELF_EXEMPT): por eso los
// comentarios describen las formas en prosa y NO las escriben literales.
const ASSIGN_OP_SRC = '\\s*(?:\\|\\||\\?\\?|\\+)?=(?!=)';
const ASSIGN_RE = new RegExp('process\\.env\\.(' + NOMBRE_RE_SRC + ')' + ASSIGN_OP_SRC + '\\s*([^;\\n]*)', 'g');
const COMPUTED_RE = new RegExp('process\\.env\\[([^\\]]+)\\]' + ASSIGN_OP_SRC + '\\s*([^;\\n]*)', 'g');
const DELETE_RE = new RegExp('delete\\s+process\\.env(?:\\.(' + NOMBRE_RE_SRC + ')|\\[([^\\]]+)\\])', 'g');
const WHOLE_RE = new RegExp('process\\.env' + ASSIGN_OP_SRC + '|Object\\.assign\\(\\s*process\\.env', 'g');

const SENTIDOS = Object.freeze(['encender', 'apagar', 'cualquiera']);

// CA-27.4 — lista negra FIJA de no-captura. Ningun `patron` del registro puede
// matchear ninguna de estas. Blinda CA-6258-9 estructuralmente: sin esto un
// patron `.*` declararia "de control" a medio entorno, las suites `waves-*` no
// podrian usar el helper y el guardrail seria inutil por sobre-bloqueo (mas
// superficie ReDoS de yapa).
const NO_CONTROL_BLACKLIST = Object.freeze([
    'PIPELINE_DIR_OVERRIDE', 'PATH', 'HOME', 'NODE_ENV', 'TMPDIR', 'TEMP',
]);

// Valores que NO encienden (case-insensitive, con trim). Vocabulario alineado
// al CONSUMIDOR real, no a truthiness.
const NO_ENCIENDEN = Object.freeze(['', '0', 'false', 'off', 'no']);

const PATRON_MAX_LEN = 200;
const LITERAL_MIN = 4;

const NO_RESOLUBLE = Object.freeze({ resoluble: false });

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

// Copia LOCAL a proposito (referencia: `lib/telegram-notifier.js:145`). No se
// exporta ni se importa: este modulo no puede depender del notifier.
function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- Vocabulario de valores (compartido con with-env.js — R-A12) ------------

/**
 * Valor efectivo que terminaria en `process.env`. `null` == `undefined` ==
 * variable AUSENTE (D-6258-5).
 */
function valorEfectivo(v) {
    return (v === undefined || v === null) ? undefined : String(v);
}

/**
 * La escritura de `v` empuja la variable hacia su `sentido` inseguro?
 *
 * Vocabulario del CONSUMIDOR real, no truthiness: produccion evalua
 * `String(env[X] || '0').trim() === '1'`, asi que TODO lo que no sea
 * exactamente `'1'` apaga el gate — `'false'`, `'true'`, `'off'` y `'2'`
 * incluidos.
 *
 *   apagar     -> apaga = String(v).trim() !== '1'  (la AUSENCIA incluida)
 *   encender   -> enciende = valor fuera de {undefined,null,'','0','false','off','no'}
 *   cualquiera -> TODA escritura es insegura (variables no booleanas)
 *
 * @param {*} v valor crudo a escribir (`undefined`/`null` = ausencia)
 * @param {'encender'|'apagar'|'cualquiera'} sentido
 * @returns {boolean}
 */
function esSentidoInseguro(v, sentido) {
    if (sentido === 'cualquiera') return true;
    const eff = valorEfectivo(v);
    if (sentido === 'apagar') {
        // La ausencia apaga tan bien como '0'.
        return eff === undefined || eff.trim() !== '1';
    }
    if (eff === undefined) return false;
    return !NO_ENCIENDEN.includes(eff.trim().toLowerCase());
}

// --- Validacion de la FORMA de los patrones (CA-27.3) -----------------------

function tieneComodinLibre(body) {
    let inClass = false;
    for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (c === '\\') {
            const next = body[i + 1];
            // Clases abreviadas ANCHAS fuera de una clase acotada.
            if (!inClass && (next === 'w' || next === 'W' || next === 'S' || next === 'D')) return true;
            i++;
            continue;
        }
        if (c === '[') { inClass = true; continue; }
        if (c === ']') { inClass = false; continue; }
        if (!inClass && c === '.') return true;
    }
    return false;
}

function largoPrefijoLiteral(body) {
    let n = 0;
    for (let i = 0; i < body.length; i++) {
        if (!/[A-Za-z0-9_]/.test(body[i])) break;
        const next = body[i + 1];
        // Un cuantificador detras vuelve al caracter opcional/repetible: deja
        // de ser prefijo FIJO.
        if (next === '*' || next === '?' || next === '+' || next === '{') break;
        n++;
    }
    return n;
}

function largoSufijoLiteral(body) {
    let n = 0;
    for (let i = body.length - 1; i >= 0; i--) {
        if (!/[A-Za-z0-9_]/.test(body[i])) break;
        n++;
    }
    return n;
}

function validarFormaPatron(patron, etiqueta) {
    if (typeof patron !== 'string' || patron.length === 0) {
        throw new ConfigError(etiqueta + ': `patron` debe ser un string no vacio');
    }
    if (patron.length > PATRON_MAX_LEN) {
        throw new ConfigError(etiqueta + ': `patron` excede ' + PATRON_MAX_LEN + ' caracteres (anti-ReDoS)');
    }
    if (!patron.startsWith('^') || !patron.endsWith('$')) {
        throw new ConfigError(etiqueta + ': `patron` debe estar ANCLADO en ^ y $ (ambos)');
    }
    const body = patron.slice(1, -1);
    if (tieneComodinLibre(body)) {
        throw new ConfigError(
            etiqueta + ': `patron` tiene comodines libres (punto, .*, \\w, \\S); '
            + 'solo se admiten clases acotadas tipo [A-Z0-9_]',
        );
    }
    // Anti-ReDoS: cuantificador aplicado a un grupo que ya tiene cuantificador.
    if (/\([^)]*[+*][^)]*\)\s*[+*{]/.test(body)) {
        throw new ConfigError(etiqueta + ': `patron` anida cuantificadores ((x+)+ / (x*)*) — riesgo ReDoS');
    }
    const pre = largoPrefijoLiteral(body);
    const suf = largoSufijoLiteral(body);
    if (Math.max(pre, suf) < LITERAL_MIN) {
        throw new ConfigError(
            etiqueta + ': `patron` necesita un prefijo o sufijo literal de al menos ' + LITERAL_MIN
            + ' caracteres (tiene prefijo=' + pre + ', sufijo=' + suf + ')',
        );
    }
    let re;
    try { re = new RegExp(patron, 'i'); }
    catch (e) { throw new ConfigError(etiqueta + ': `patron` no compila: ' + e.message); }
    for (const negra of NO_CONTROL_BLACKLIST) {
        if (re.test(negra)) {
            throw new ConfigError(
                etiqueta + ': `patron` captura `' + negra + '`, que esta en la lista negra de '
                + 'no-control (CA-27.4). Un patron que se traga variables corrientes vuelve el '
                + 'helper inusable y el equipo termina evitandolo.',
            );
        }
    }
    return re;
}

// --- Registro hibrido -------------------------------------------------------

/**
 * Valida y compila el registro. Cualquier problema es `ConfigError` -> exit 2,
 * SIEMPRE nombrando la entrada infractora. Sin defaults en ningun campo.
 */
function buildRegistry(json) {
    if (!json || typeof json !== 'object' || !Array.isArray(json.vars) || json.vars.length === 0) {
        throw new ConfigError(PROTECTED_FILE + ': se espera { vars: [ ... ] } con al menos una entrada');
    }
    const nominal = new Map();      // NOMBRE_UPPER -> entry
    const patterns = [];            // { raw, re, sentido }
    const regexes = [];             // contrato derivado: nombres y luego patrones

    json.vars.forEach((entry, idx) => {
        let etiqueta = PROTECTED_FILE + '#vars[' + idx + ']';
        if (entry && typeof entry.nombre === 'string') etiqueta += ' (nombre: ' + entry.nombre + ')';
        else if (entry && typeof entry.patron === 'string') etiqueta += ' (patron: ' + entry.patron + ')';
        if (!entry || typeof entry !== 'object') {
            throw new ConfigError(etiqueta + ': entrada invalida');
        }
        const tieneNombre = typeof entry.nombre === 'string' && entry.nombre.length > 0;
        const tienePatron = typeof entry.patron === 'string' && entry.patron.length > 0;
        if (tieneNombre === tienePatron) {
            throw new ConfigError(etiqueta + ': la entrada debe declarar `nombre` O `patron`, exactamente uno');
        }
        // CA-27.1 / CA-27.2 — obligatorio en las DOS formas, sin default.
        if (!SENTIDOS.includes(entry.sentido_inseguro)) {
            throw new ConfigError(
                etiqueta + ': `sentido_inseguro` es obligatorio y debe ser uno de '
                + SENTIDOS.join(' | ') + ' (recibido: ' + JSON.stringify(entry.sentido_inseguro) + '). '
                + 'Sin default a proposito: adivinar la direccion es el error que produjo el hallazgo.',
            );
        }
        if (tienePatron) {
            const re = validarFormaPatron(entry.patron, etiqueta);
            patterns.push({ raw: entry.patron, re, sentido: entry.sentido_inseguro, etiqueta });
        } else {
            const upper = entry.nombre.toUpperCase();
            if (nominal.has(upper)) {
                throw new ConfigError(etiqueta + ': `nombre` duplicado en el registro');
            }
            nominal.set(upper, Object.assign({}, entry, { etiqueta }));
        }
    });

    // CA-27.5 — precedencia nominal > patron: una fila `nombre` cuya direccion
    // DIFIERE de la de una familia que la matchea debe declarar
    // `motivo_precedencia` no vacio. Es regla GENERAL, no una excepcion escrita
    // para `PULPO_NO_AUTOSTART`. Sin esto, "nominal gana" permitiria DEBILITAR
    // una familia agregando una fila.
    for (const [upper, entry] of nominal) {
        const familias = patterns.filter((p) => p.re.test(upper));
        const difiere = familias.some((p) => p.sentido !== entry.sentido_inseguro);
        if (difiere && !String(entry.motivo_precedencia || '').trim()) {
            throw new ConfigError(
                entry.etiqueta + ': `' + entry.nombre + '` declara `' + entry.sentido_inseguro
                + '` pero la familia `' + familias.map((p) => p.raw).join(', ')
                + '` declara otra direccion. Una fila nominal que difiere de su familia exige '
                + '`motivo_precedencia` no vacio (CA-27.5).',
            );
        }
    }

    // Contrato derivado (SECURITY_CONTROL_VARS). Las nominales se anclan y van
    // case-insensitive: `process.env` en Windows tambien lo es, y una
    // derivacion sin flag `i` dejaria la evasion por casing abierta justo para
    // las 8 nominales que ninguna familia cubre. El `escapeRegExp` NO es
    // cosmetico: impide que una fila futura inyecte un patron por la puerta de
    // `nombre`, saltandose la validacion de forma de CA-27.3.
    for (const [, entry] of nominal) {
        regexes.push(new RegExp('^' + escapeRegExp(entry.nombre) + '$', 'i'));
    }
    for (const p of patterns) regexes.push(new RegExp(p.raw, 'i'));

    /**
     * Direccion efectiva de `name`, o `null` si el registro no la cubre.
     * Cobertura = UNION; la precedencia decide SOLO la direccion.
     */
    function direction(name) {
        if (typeof name !== 'string' || !name) return null;
        const nom = nominal.get(name.toUpperCase());
        if (nom) return nom.sentido_inseguro;
        const hits = patterns.filter((p) => p.re.test(name));
        if (hits.length === 0) return null;
        const sentidos = new Set(hits.map((p) => p.sentido));
        // CA-27.2 — dos patrones en conflicto resuelven a `cualquiera`
        // (fail-closed), NUNCA al mas laxo.
        return sentidos.size === 1 ? hits[0].sentido : 'cualquiera';
    }

    return {
        direction,
        isControl: (name) => direction(name) !== null,
        regexes: Object.freeze(regexes),
        size: json.vars.length,
        _nominal: nominal,
        _patterns: patterns,
    };
}

function readJsonStrict(file, etiqueta) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (e) {
        throw new ConfigError(
            etiqueta + ': no se pudo leer ' + file + ' (' + (e.code || e.message) + '). '
            + 'Es fail-closed a proposito: un archivo ausente NUNCA degrada a configuracion vacia.',
        );
    }
    try { return JSON.parse(raw); }
    catch (e) { throw new ConfigError(etiqueta + ': JSON invalido en ' + file + ' — ' + e.message); }
}

function loadRegistry(pipelineRoot) {
    const file = path.join(pipelineRoot || DEFAULT_PIPELINE_ROOT, 'lib', PROTECTED_FILE);
    return buildRegistry(readJsonStrict(file, PROTECTED_FILE));
}

// Cache de proceso: `with-env.js` lo consulta en CADA llamada a `withEnv()` y
// hay cientos de tests. No hace falta invalidarlo: el registro es un archivo
// versionado que no cambia dentro de una corrida.
let _registryCache = null;
function getRegistry(pipelineRoot) {
    if (pipelineRoot) return loadRegistry(pipelineRoot);
    if (_registryCache === null) _registryCache = loadRegistry(DEFAULT_PIPELINE_ROOT);
    return _registryCache;
}

// --- Allowlist / baseline ---------------------------------------------------

const KINDS = Object.freeze(['deuda', 'falso-positivo']);

function normalizeRel(p) {
    return String(p === undefined || p === null ? '' : p).replace(/\\/g, '/');
}

function loadAllowlist(pipelineRoot) {
    const file = path.join(pipelineRoot, 'lib', ALLOWLIST_FILE);
    const j = readJsonStrict(file, ALLOWLIST_FILE);
    if (!Number.isInteger(j.min_scanned) || j.min_scanned < 0) {
        throw new ConfigError(ALLOWLIST_FILE + ": `min_scanned` es obligatorio y debe ser un entero >= 0 (CA-15')");
    }
    const files = (j.files || []).map((f, i) => {
        if (!f || typeof f !== 'object') throw new ConfigError(ALLOWLIST_FILE + '#files[' + i + ']: entrada invalida');
        if (!KINDS.includes(f.kind)) {
            throw new ConfigError(
                ALLOWLIST_FILE + '#files[' + i + '] (' + f.file + '): `kind` es obligatorio y debe ser '
                + KINDS.join(' | ') + ' — sin default (CA-22)',
            );
        }
        return { file: normalizeRel(f.file), kind: f.kind, reason: f.reason || '' };
    });
    const rules = (j.rules || []).map((r, i) => {
        if (!r || typeof r !== 'object') throw new ConfigError(ALLOWLIST_FILE + '#rules[' + i + ']: entrada invalida');
        if (!KINDS.includes(r.kind)) {
            throw new ConfigError(
                ALLOWLIST_FILE + '#rules[' + i + '] (' + r.file + ':' + r.line + '): `kind` es obligatorio y debe ser '
                + KINDS.join(' | ') + ' — sin default (CA-22)',
            );
        }
        if (!Number.isInteger(r.line)) {
            throw new ConfigError(ALLOWLIST_FILE + '#rules[' + i + '] (' + r.file + '): `line` debe ser entero');
        }
        return { file: normalizeRel(r.file), line: r.line, kind: r.kind, reason: r.reason || '' };
    });
    return { min_scanned: j.min_scanned, files, rules };
}

function loadBaseline(pipelineRoot) {
    const file = path.join(pipelineRoot, 'lib', BASELINE_FILE);
    const j = readJsonStrict(file, BASELINE_FILE);
    if (!Array.isArray(j.entries)) {
        throw new ConfigError(BASELINE_FILE + ': se espera { entries: [ ... ] }');
    }
    const entries = j.entries.map((e, i) => {
        if (!e || typeof e !== 'object' || typeof e.file !== 'string'
            || !Number.isInteger(e.line) || typeof e.variable !== 'string'
            || typeof e.sentido !== 'string') {
            throw new ConfigError(
                BASELINE_FILE + '#entries[' + i + ']: cada entrada exige (file, line, variable, sentido). '
                + 'El baseline es POR ENTRADA, no un contador: un contador dejaria MOVER una estricta '
                + 'de un archivo a otro sin que nadie lo vea (CA-36).',
            );
        }
        return { file: normalizeRel(e.file), line: e.line, variable: e.variable, sentido: e.sentido };
    });
    return { entries };
}

/** Clave de identidad de una estricta en el baseline (CA-36). */
function baselineKey(v) {
    return normalizeRel(v.file) + '::' + v.line + '::' + (v.variable === null ? '(clave no resoluble)' : v.variable)
        + '::' + (v.sentido === null ? '(n/a)' : v.sentido);
}

// --- Walker -----------------------------------------------------------------

function inScope(name) {
    return name.endsWith('.test.js') || (name.startsWith('test-') && name.endsWith('.js'));
}

function walkJs(root) {
    const out = [];
    function recurse(dir) {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { return; }
        for (const e of entries) {
            if (e.isSymbolicLink()) continue;
            if (e.isDirectory()) {
                if (SKIP_DIRS.has(e.name)) continue;
                if (SCRATCH_DIR_RE.test(e.name)) continue;
                recurse(path.join(dir, e.name));
            } else if (e.isFile() && inScope(e.name)) {
                out.push(path.join(dir, e.name));
            }
        }
    }
    recurse(root);
    return out.sort();
}

// SEC-5.2 — chequeo ANTI-PODREDUMBRE. Una flag de PRODUCCION con forma de
// control que NINGUNA de las dos formas del registro cubre es, casi siempre, un
// control nuevo que nadie clasifico. Sin este chequeo el registro envejece en
// silencio mientras el codigo suma gates.
//
// SE REPORTA, NO BLOQUEA — decision explicita y medida. Motivo: no existe hoy
// una forma de declarar "revisada y NO es de control" (el registro es, por
// definicion, de variables de control), asi que bloquear forzaria el falso
// dilema de clasificar como control una flag que no lo es, o de bajar el
// chequeo. El mecanismo que faltaria seria estructura nueva y CA-20 fija SIETE
// archivos. Medicion sobre el arbol de entrega: CERO flags sin cubrir, o sea el
// valor presente del chequeo es la VISIBILIDAD del drift futuro, no deteccion
// de hoy. La linea sale en la consola del pre-commit y en el log de CI.
const FORMA_DE_CONTROL_RE = new RegExp(
    '^(?:PULPO_[A-Z0-9_]+'
    + '|[A-Z0-9_]*_ENABLED'
    + '|[A-Z0-9_]*_DISABLED'
    + '|[A-Z0-9_]*BYPASS[A-Z0-9_]*'
    + '|[A-Z0-9_]*KILL_SWITCH[A-Z0-9_]*'
    + '|[A-Z0-9_]*GATE[A-Z0-9_]*)$',
);
const LECTURA_ENV_RE = /process\.env\.([A-Z][A-Z0-9_]{2,})/g;

/** Archivos de PRODUCCION: `.js` que NO estan en el alcance del guardrail. */
function walkProduccion(root) {
    const out = [];
    function recurse(dir) {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { return; }
        for (const e of entries) {
            if (e.isSymbolicLink()) continue;
            if (e.isDirectory()) {
                if (SKIP_DIRS.has(e.name)) continue;
                if (SCRATCH_DIR_RE.test(e.name)) continue;
                recurse(path.join(dir, e.name));
            } else if (e.isFile() && e.name.endsWith('.js') && !inScope(e.name)) {
                out.push(path.join(dir, e.name));
            }
        }
    }
    recurse(root);
    return out.sort();
}

/** @returns {string[]} nombres de flag con forma de control sin cubrir. */
function detectarPodredumbre(pipelineRoot, registry) {
    const out = new Set();
    for (const f of walkProduccion(pipelineRoot)) {
        let src;
        try { src = fs.readFileSync(f, 'utf8'); }
        catch { continue; }
        LECTURA_ENV_RE.lastIndex = 0;
        let m;
        while ((m = LECTURA_ENV_RE.exec(src)) !== null) {
            const n = m[1];
            if (!FORMA_DE_CONTROL_RE.test(n)) continue;
            if (registry.direction(n) !== null) continue;
            out.add(n);
        }
    }
    return [...out].sort();
}

function pathPosixRel(pipelineRoot, absolute) {
    return path.relative(pipelineRoot, absolute).split(path.sep).join('/');
}

function lineOfOffset(source, offset) {
    let line = 1;
    for (let i = 0; i < offset; i++) if (source.charCodeAt(i) === 10) line++;
    return line;
}

// --- Resolucion estatica de clave y valor -----------------------------------

/** Literal string sin interpolacion -> su contenido; si no, `null`. */
function literalString(expr) {
    const s = String(expr === undefined || expr === null ? '' : expr).trim();
    if (s.length < 2) return null;
    const q = s[0];
    if (q !== "'" && q !== '"' && q !== '`') return null;
    let out = '';
    let i = 1;
    while (i < s.length) {
        const c = s[i];
        if (c === '\\') { out += s[i + 1] === undefined ? '' : s[i + 1]; i += 2; continue; }
        if (c === q) break;
        if (q === '`' && c === '$' && s[i + 1] === '{') return null;   // interpolacion
        out += c;
        i++;
    }
    if (i >= s.length) return null;                                    // sin cierre en la linea
    const rest = s.slice(i + 1).trim();
    if (rest !== '' && !rest.startsWith('//')) return null;            // concatenacion / algo mas
    return out;
}

/**
 * Nombre de la variable, o `null` si la clave NO es resoluble estaticamente.
 * Fail-closed: escribir en `process.env` con una clave DINAMICA (un
 * identificador entre corchetes) es el bypass trivial del registro (R-A11,
 * decision cerrada — NO re-litigable por el dev).
 *
 * Nota: la forma literal de ese bypass NO se escribe en este archivo ni en sus
 * comentarios. El guardrail esta en su propio alcance (`test-*.js`) y CA-23
 * fija en DOS los paths auto-exentos: documentarlo textualmente lo haria
 * rechazarse a si mismo por una linea de prosa.
 */
function resolveKey(keyExpr, kind) {
    if (kind === 'dot' || kind === 'delete-dot') return String(keyExpr);
    return literalString(keyExpr);
}

/** `{resoluble:true, value}` o `NO_RESOLUBLE`. */
function resolveValue(raw) {
    const s = String(raw === undefined || raw === null ? '' : raw).trim().replace(/;+\s*$/, '').trim();
    if (s === '') return NO_RESOLUBLE;
    const lit = literalString(s);
    if (lit !== null) return { resoluble: true, value: lit };
    const noComment = s.split('//')[0].trim().replace(/;+\s*$/, '').trim();
    if (/^-?\d+(?:\.\d+)?$/.test(noComment)) return { resoluble: true, value: noComment };
    if (noComment === 'undefined') return { resoluble: true, value: undefined };
    if (noComment === 'null') return { resoluble: true, value: null };
    if (noComment === 'true' || noComment === 'false') return { resoluble: true, value: noComment };
    return NO_RESOLUBLE;
}

// --- Clasificacion por direccion de riesgo ----------------------------------

function classify(hit, registry) {
    if (hit.kind === 'whole') {
        return {
            variable: null,
            sentido: null,
            severity: 'estricta',
            reason: 'asignacion al objeto process.env entero — estricta sin excepcion posible',
        };
    }
    const name = resolveKey(hit.keyExpr, hit.kind);
    if (name === null) {
        return {
            variable: null,
            sentido: null,
            severity: 'estricta',
            reason: 'clave no resoluble estaticamente — fail-closed: process.env[k] con k identificador '
                + 'es el bypass trivial del registro',
        };
    }
    const sentido = registry.direction(name);
    if (sentido === null) {
        return { variable: name, sentido: null, severity: 'deuda', reason: 'escritura de ' + name + ' fuera del helper' };
    }

    if (hit.kind === 'delete' || hit.kind === 'delete-dot') {
        // `delete` == dejar la variable AUSENTE == direccion `apagar`.
        return esSentidoInseguro(undefined, sentido)
            ? { variable: name, sentido, severity: 'estricta', reason: 'delete de ' + name + ' (ausencia) en su sentido inseguro (' + sentido + ')' }
            : { variable: name, sentido, severity: 'deuda', reason: 'delete de ' + name + ' en el sentido seguro' };
    }

    const rv = resolveValue(hit.valueExpr);
    if (!rv.resoluble) {
        return {
            variable: name,
            sentido,
            severity: 'estricta',
            reason: 'valor no resoluble estaticamente sobre variable de control: ' + name,
        };
    }
    return esSentidoInseguro(rv.value, sentido)
        ? { variable: name, sentido, severity: 'estricta', reason: name + ' escrita en su sentido inseguro (' + sentido + ')' }
        : { variable: name, sentido, severity: 'deuda', reason: name + ' escrita en el sentido seguro (' + sentido + ')' };
}

// --- Lint de un archivo -----------------------------------------------------

/**
 * SEC-8 — el snippet se corta en el operador `=`: se reporta el lado izquierdo,
 * NUNCA el valor. `ghost-artifact-lint` manda el snippet crudo a stdout (consola
 * del pre-commit y log de CI) y aca el match INCLUYE el valor asignado.
 */
function safeSnippet(matchText) {
    // El corte incluye el operador compuesto (`||=`, `??=`, `+=`) para no dejar
    // el `||` colgando en el reporte. La garantia SEC-8 se mantiene: cualquier
    // alternativa del split termina en el PRIMER `=`, asi que el elemento [0]
    // nunca puede contener el valor asignado.
    return String(matchText).split(/\s*(?:\|\||\?\?|\+)?=/)[0].trim().slice(0, 120);
}

/**
 * Sin `allowlist` en la firma — DESVIO NO NEGOCIABLE respecto de
 * `ghost-artifact-lint.js:187-190`, que consulta la allowlist ANTES de leer el
 * archivo. Clonar ese orden abre el agujero de SEC-6: allowlistear un archivo
 * entero lo saca del scan para siempre. Aca el archivo se lee y se escanea
 * SIEMPRE; el filtrado es POSTERIOR, violation por violation.
 */
function lintFile(absolute, pipelineRoot, registry) {
    const rel = pathPosixRel(pipelineRoot, absolute);
    if (SELF_EXEMPT.has(rel)) return [];

    // CA-16 / SEC-4 — containment: paths con `..` o symlinks que salgan del
    // pipelineRoot se rechazan.
    let realRoot;
    let realFile;
    try {
        realRoot = fs.realpathSync(pipelineRoot);
        realFile = fs.realpathSync(absolute);
    } catch { return []; }
    const prefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
    if (!realFile.startsWith(prefix)) return [];

    let src;
    try { src = fs.readFileSync(absolute, 'utf8'); }
    catch { return []; }

    const hits = [];
    let m;

    ASSIGN_RE.lastIndex = 0;
    while ((m = ASSIGN_RE.exec(src)) !== null) {
        hits.push({ kind: 'dot', keyExpr: m[1], valueExpr: m[2], index: m.index, text: m[0] });
    }
    COMPUTED_RE.lastIndex = 0;
    while ((m = COMPUTED_RE.exec(src)) !== null) {
        hits.push({ kind: 'computed', keyExpr: m[1], valueExpr: m[2], index: m.index, text: m[0] });
    }
    DELETE_RE.lastIndex = 0;
    while ((m = DELETE_RE.exec(src)) !== null) {
        const dotName = m[1];
        hits.push({
            kind: dotName ? 'delete-dot' : 'delete',
            keyExpr: dotName || m[2],
            valueExpr: null,
            index: m.index,
            text: m[0],
        });
    }
    WHOLE_RE.lastIndex = 0;
    while ((m = WHOLE_RE.exec(src)) !== null) {
        hits.push({ kind: 'whole', keyExpr: null, valueExpr: null, index: m.index, text: m[0] });
    }

    const out = hits.map((h) => {
        const c = classify(h, registry);
        return {
            file: rel,
            line: lineOfOffset(src, h.index),
            forma: h.kind === 'delete-dot' ? 'delete' : h.kind,
            variable: c.variable,
            sentido: c.sentido,
            severity: c.severity,
            reason: c.reason,
            snippet: safeSnippet(h.text),
        };
    });
    out.sort((a, b) => a.line - b.line || a.forma.localeCompare(b.forma));
    return out;
}

// --- Allowlist / baseline aplicados -----------------------------------------

/**
 * Reglas, en este orden:
 *   1. `estricta` NUNCA la suprime la allowlist: si una entry la cubre, esa
 *      entry es ELLA MISMA una violation, con mensaje que nombra entry +
 *      variable (SEC-2 / SEC-6 / CA-14).
 *   2. `estricta` presente en el baseline -> NO se suprime: se REPORTA como
 *      deuda visible (linea propia) y no cuenta para el exit code, salvo que
 *      el baseline haya CRECIDO.
 *   3. solo `deuda` se suprime por allowlist.
 */
function applyAllowlist(violations, allowlist, baseline) {
    const fileEntries = new Map(allowlist.files.map((f) => [f.file, f]));
    const ruleEntries = new Map(allowlist.rules.map((r) => [r.file + '::' + r.line, r]));
    const baselineKeys = new Set(baseline.entries.map(baselineKey));

    const usadasFiles = new Set();
    const usadasRules = new Set();
    const conteoKind = { deuda: 0, 'falso-positivo': 0 };

    const nuevas = [];              // cuentan para exit 1
    const congeladas = [];          // deuda visible del baseline
    const entriesQueCubrenEstrictas = [];

    for (const v of violations) {
        const fEntry = fileEntries.get(v.file);
        const rEntry = ruleEntries.get(v.file + '::' + v.line);
        if (fEntry) usadasFiles.add(v.file);
        if (rEntry) usadasRules.add(v.file + '::' + v.line);

        if (v.severity === 'estricta') {
            if (fEntry || rEntry) {
                const entry = rEntry || fEntry;
                entriesQueCubrenEstrictas.push({
                    file: v.file,
                    line: v.line,
                    variable: v.variable,
                    entry: rEntry ? 'rules[' + entry.file + ':' + entry.line + ']' : 'files[' + entry.file + ']',
                    reason: 'la entry de allowlist cubre una violation ESTRICTA sobre `'
                        + (v.variable === null ? '(clave no resoluble)' : v.variable)
                        + '`; una estricta no es perdonable por allowlist (SEC-2 / SEC-6)',
                });
            }
            if (baselineKeys.has(baselineKey(v))) congeladas.push(v);
            else nuevas.push(v);
            continue;
        }
        // deuda
        if (fEntry || rEntry) {
            const entry = rEntry || fEntry;
            conteoKind[entry.kind] += 1;
            continue;
        }
        nuevas.push(v);
    }

    // CA-21 / R-5 — entries obsoletas: sin ellas la allowlist queda inflada
    // para siempre y el guardrail deja de medir la deuda.
    const obsoletas = [];
    for (const f of allowlist.files) {
        if (!usadasFiles.has(f.file)) {
            obsoletas.push({ entry: 'files[' + f.file + ']', reason: 'el archivo ya no tiene violations (o no existe)' });
        }
    }
    for (const r of allowlist.rules) {
        if (!usadasRules.has(r.file + '::' + r.line)) {
            obsoletas.push({ entry: 'rules[' + r.file + ':' + r.line + ']', reason: 'la linea ya no matchea ninguna violation' });
        }
    }

    // Baseline que ENCOGE: entradas congeladas que ya no existen. No es error
    // (se regenera y el diff queda en el PR), pero se informa.
    const vistas = new Set(congeladas.map(baselineKey));
    const resueltas = baseline.entries.filter((e) => !vistas.has(baselineKey(e)));

    return { nuevas, congeladas, obsoletas, entriesQueCubrenEstrictas, conteoKind, resueltas };
}

// --- API --------------------------------------------------------------------

function lint(opts = {}) {
    const pipelineRoot = opts.pipelineRoot || DEFAULT_PIPELINE_ROOT;
    const registry = opts.registry || loadRegistry(pipelineRoot);
    const files = walkJs(pipelineRoot);
    const violations = [];
    for (const f of files) {
        for (const v of lintFile(f, pipelineRoot, registry)) violations.push(v);
    }
    return { scanned: files.length, violations, registry };
}

function formatViolation(v) {
    return 'LINT ' + v.severity.toUpperCase() + ': ' + v.file + ':' + v.line + ' [' + v.forma + ']'
        + (v.variable ? ' ' + v.variable : '')
        + '\n    reason: ' + v.reason
        + '\n    snippet: ' + v.snippet + ' =';
}

// --- Copy accionable (seccion 10: el remedio se DERIVA del motivo del rojo) --
//
// Un bloque fijo termina ofreciendo la salida equivocada. Ante entries OBSOLETAS
// decir "agregar entry con `kind` y `reason`" es instruccion ERRADA — hay que
// REGENERAR, no agregar — y al no nombrar `--write-allowlist` dejaba
// `--no-verify` como unica salida aparente (rev-2).
const REMEDIOS_VIOLATIONS = [
    '  1) Usar `withEnv(vars, fn)` de `.pipeline/lib/test-helpers/with-env.js` en vez de',
    '     tocar `process.env` a mano. Restaura el entorno pase lo que pase.',
    '  2) Si el test NECESITA apagar un control, el opt-in explicito:',
    "     withEnv({ VAR: '0' }, fn, { permitirApagarControl: ['VAR'], motivo: '...' })",
    '  3) Si es deuda preexistente o falso positivo, agregar entry con `kind` y `reason`',
    '     en `.pipeline/lib/' + ALLOWLIST_FILE + '`. Las ESTRICTAS no se allowlistean.',
];

const REMEDIOS_OBSOLETAS = [
    '  1) Una entry obsoleta NO se agrega ni se edita a mano: se REGENERA.',
    '       node .pipeline/lib/test-env-lint.js --write-allowlist',
    '     Reescribe las entries `deuda` contra las lineas actuales; el diff va en el PR.',
    '     Editar un test allowlisteado desplaza sus lineas y llega aca: es el caso normal.',
    '  2) Los archivos TRACKED modificados NO bloquean la regeneracion (viajan en el mismo',
    '     commit). Si ademas hay archivos NUEVOS untracked que entran en ESTE commit,',
    '     agregar `--allow-dirty`.',
    '  3) Si hay una violation ESTRICTA presente, `--write-allowlist` aborta (CA-24):',
    '     esa se arregla, no se allowlistea.',
    '  4) `--no-verify` NO es la salida: mueve el rojo al CI en vez de resolverlo.',
];

/**
 * Corrida completa en modo `--check`, con el ORDEN FAIL-CLOSED del issue: el
 * primero que falla corta.
 *
 * @returns {{code:number, lines:string[], scanned:number, violations:Array, remedios:string[]}}
 */
function check(opts = {}) {
    const pipelineRoot = opts.pipelineRoot || DEFAULT_PIPELINE_ROOT;
    const lines = [];

    // 1) validacion del registro -> exit 2 (la tira `loadRegistry`)
    const registry = opts.registry || loadRegistry(pipelineRoot);
    const allowlist = opts.allowlist || loadAllowlist(pipelineRoot);
    const baseline = opts.baseline || loadBaseline(pipelineRoot);

    const { scanned, violations } = lint({ pipelineRoot, registry });

    // 2) scanned === 0 — SEC-3 fail-closed, mensaje LITERAL.
    if (scanned === 0) {
        lines.push('glob no matcheo ningun archivo');
        return { code: 1, lines, scanned, violations: [], remedios: REMEDIOS_VIOLATIONS };
    }
    // 3) piso de escaneo (CA-15')
    if (scanned < allowlist.min_scanned) {
        lines.push('piso de escaneo incumplido: esperado >= ' + allowlist.min_scanned
            + ', encontrado ' + scanned + '. Un alcance recortado reporta verde sobre un scan vacio de contenido.');
        return { code: 1, lines, scanned, violations, remedios: REMEDIOS_VIOLATIONS };
    }

    const r = applyAllowlist(violations, allowlist, baseline);

    // 4) entries obsoletas (CA-21)
    if (r.obsoletas.length) {
        lines.push(r.obsoletas.length + ' entry(s) de allowlist OBSOLETA(s):');
        for (const o of r.obsoletas) lines.push('  ' + o.entry + ' — ' + o.reason);
        return { code: 1, lines, scanned, violations, remedios: REMEDIOS_OBSOLETAS };
    }
    // 5) entries que cubren estrictas (SEC-2 / SEC-6 / CA-14)
    if (r.entriesQueCubrenEstrictas.length) {
        lines.push(r.entriesQueCubrenEstrictas.length + ' entry(s) de allowlist cubren violations ESTRICTAS:');
        for (const e of r.entriesQueCubrenEstrictas) {
            lines.push('  ' + e.entry + ' -> ' + e.file + ':' + e.line + ' variable `'
                + (e.variable === null ? '(clave no resoluble)' : e.variable) + '` — ' + e.reason);
        }
        return { code: 2, lines, scanned, violations, remedios: REMEDIOS_VIOLATIONS };
    }
    // 6) violations nuevas (incluye baseline que CRECIO — CA-36)
    if (r.nuevas.length) {
        const estrictasNuevas = r.nuevas.filter((v) => v.severity === 'estricta');
        lines.push(r.nuevas.length + ' violation(s) nueva(s) en ' + scanned + ' archivos escaneados:');
        for (const v of r.nuevas) lines.push(formatViolation(v));
        if (estrictasNuevas.length) {
            lines.push('');
            lines.push(estrictasNuevas.length + ' de ellas son ESTRICTAS: el baseline CRECIO. '
                + 'Una estricta nueva es rojo duro siempre — no se allowlistea, se arregla.');
        }
        return { code: 1, lines, scanned, violations, remedios: REMEDIOS_VIOLATIONS };
    }

    // Verde: los dos conteos de CA-22 + la deuda del baseline en LINEA PROPIA.
    lines.push('OK — ' + scanned + ' escaneados, 0 violations nuevas, allowlist: '
        + r.conteoKind.deuda + ' deuda / ' + r.conteoKind['falso-positivo'] + ' falso-positivo');
    lines.push('DEUDA CONGELADA (baseline): ' + r.congeladas.length + ' estrictas preexistentes — ver #6254');
    // SEC-5.2 — anti-podredumbre, en linea propia y sin cambiar el exit code.
    const podridas = detectarPodredumbre(pipelineRoot, registry);
    if (podridas.length) {
        lines.push('PODREDUMBRE (SEC-5.2): ' + podridas.length + ' flag(s) de produccion con forma de '
            + 'control que el registro NO cubre por ninguna de sus dos formas: ' + podridas.join(', ')
            + '. Clasificarlas en `test-env-lint.protected.json` o dejar escrito por que no son controles.');
    }
    if (r.resueltas.length) {
        lines.push('El baseline ENCOGIO: ' + r.resueltas.length + ' entrada(s) ya no aplican. '
            + 'Correr `--write-baseline` y dejar el diff en el PR.');
    }
    return { code: 0, lines, scanned, violations, remedios: [] };
}

// --- CLI --------------------------------------------------------------------

/**
 * R-A2 — un path UNTRACKED puede hornearse en la allowlist/baseline?
 *
 * Solo si el writer pudiera emitir una entry para el: un archivo en alcance
 * (`inScope`) fuera de los directorios que `walkJs` ya saltea. Un directorio
 * untracked (git colapsa `?? dir/`) cuenta como riesgoso salvo que sea skip o
 * scratch: no sabemos que hay adentro.
 */
function puedeHornearse(repoPath) {
    const rel = repoPath.replace(/\\/g, '/').replace(/^\.pipeline\//, '');
    const segs = rel.split('/').filter(Boolean);
    if (!segs.length) return true;
    for (const s of segs.slice(0, -1)) {
        if (SKIP_DIRS.has(s) || SCRATCH_DIR_RE.test(s)) return false;
    }
    const last = segs[segs.length - 1];
    // `?? dir/` — directorio untracked colapsado por git.
    if (rel.endsWith('/')) return !(SKIP_DIRS.has(last) || SCRATCH_DIR_RE.test(last));
    return inScope(last);
}

/**
 * R-A2 — abortar si hay UNTRACKED horneables bajo `.pipeline`.
 *
 * El riesgo que R-A2 nombra es acotado y tiene una sola forma: el writer hornea
 * un archivo que el CI NO tiene, y por CA-21 esa entry nace obsoleta ⇒ rojo.
 * Eso solo lo produce un archivo UNTRACKED. Un archivo TRACKED modificado viaja
 * en el mismo commit que la regeneracion, asi que el CI lo ve: no hay riesgo.
 *
 * Bloquear tambien por tracked (como hacia rev-1) producia un DEADLOCK operativo
 * (rev-2): editar un test con deuda allowlisteada por linea desplaza sus lineas
 * ⇒ el hook exige regenerar la allowlist; el writer exigia commitear primero;
 * y el hook no deja commitear. La unica salida era `--no-verify`, justo el modo
 * de fallo que la seccion 2 del issue existe para evitar. La mitigacion habia
 * quedado mas ancha que el riesgo.
 *
 * `--allow-dirty` (`opts.skipGitCheck`) es la salida explicita y documentada para
 * el caso legitimo restante: regenerar con archivos NUEVOS que entran en este
 * mismo commit. El mensaje de error lo nombra.
 */
function assertWorktreeLimpio(pipelineRoot) {
    let out;
    try {
        out = execFileSync('git', ['status', '--porcelain', '-z', '--', '.pipeline'], {
            cwd: path.resolve(pipelineRoot, '..'),
            encoding: 'utf8',
        });
    } catch {
        throw new ConfigError('no se pudo consultar `git status --porcelain -- .pipeline` (R-A2)');
    }
    // Con `-z` el path no viene quoteado. Los registros de rename agregan un path
    // suelto sin prefijo XY: no matchea `?? `, se ignora solo.
    const untracked = out.split('\0')
        .filter((r) => r.startsWith('?? '))
        .map((r) => r.slice(3))
        .filter(puedeHornearse);
    if (untracked.length) {
        const muestra = untracked.slice(0, 10).join(', ') + (untracked.length > 10 ? ', ...' : '');
        throw new ConfigError(
            untracked.length + ' archivo(s) UNTRACKED en alcance bajo `.pipeline`: ' + muestra
            + '. Regenerar con ellos hornea entries que el CI no tiene y pinta el CI de rojo por '
            + 'entries obsoletas (R-A2). Commitealos, borralos, o volve a correr con `--allow-dirty` '
            + 'si entran en ESTE mismo commit. Los archivos TRACKED modificados no bloquean: viajan '
            + 'en el mismo commit que la regeneracion.',
        );
    }
}

function writeAllowlist(pipelineRoot, logger, opts = {}) {
    if (!opts.skipGitCheck) assertWorktreeLimpio(pipelineRoot);
    const registry = loadRegistry(pipelineRoot);
    const { violations } = lint({ pipelineRoot, registry });
    // "Estricta presente" = estricta que NO esta congelada en el baseline. Una
    // ya congelada es deuda visible conocida y no se hornea aca de todos modos
    // (el writer solo emite entries `deuda`); si contara, el modo de
    // regeneracion seria inutilizable por diseno y el pre-checklist del issue
    // lo exige funcionando.
    let baselineKeys = new Set();
    try { baselineKeys = new Set(loadBaseline(pipelineRoot).entries.map(baselineKey)); }
    catch { /* sin baseline todavia: toda estricta cuenta */ }
    const estrictas = violations.filter((v) => v.severity === 'estricta' && !baselineKeys.has(baselineKey(v)));
    // CA-24 — es lo que impide que el modo de regeneracion sea el bypass del guardrail.
    if (estrictas.length) {
        logger.error('--write-allowlist ABORTA: hay ' + estrictas.length + ' violation(s) ESTRICTA(s) presentes.');
        for (const v of estrictas) logger.error(formatViolation(v));
        return 2;
    }
    // SOLO deuda. Una estricta jamas entra a la allowlist, ni siquiera congelada.
    const rules = violations
        .filter((v) => v.severity === 'deuda')
        .map((v) => ({ file: v.file, line: v.line, kind: 'deuda', reason: v.reason }));
    const file = path.join(pipelineRoot, 'lib', ALLOWLIST_FILE);
    const prev = readJsonStrict(file, ALLOWLIST_FILE);
    const next = Object.assign({}, prev, { files: prev.files || [], rules });
    fs.writeFileSync(file, JSON.stringify(next, null, 4) + '\n', 'utf8');
    logger.info('allowlist regenerada: ' + rules.length + ' entries `deuda`');
    return 0;
}

function writeBaseline(pipelineRoot, logger, opts = {}) {
    if (!opts.skipGitCheck) assertWorktreeLimpio(pipelineRoot);
    const registry = loadRegistry(pipelineRoot);
    const { violations } = lint({ pipelineRoot, registry });
    const estrictas = violations.filter((v) => v.severity === 'estricta');
    let prev;
    try { prev = loadBaseline(pipelineRoot); }
    catch { prev = { entries: [] }; }
    const prevKeys = new Set(prev.entries.map(baselineKey));
    const nuevas = estrictas.filter((v) => !prevKeys.has(baselineKey(v)));
    // Shrink-only: crecer es rojo. Una estricta nueva se arregla, no se congela.
    if (prev.entries.length > 0 && nuevas.length > 0) {
        logger.error('--write-baseline ABORTA: el baseline CRECERIA en ' + nuevas.length + ' entrada(s).');
        for (const v of nuevas) logger.error(formatViolation(v));
        return 1;
    }
    const entries = estrictas.map((v) => ({
        file: v.file,
        line: v.line,
        variable: v.variable === null ? '(clave no resoluble)' : v.variable,
        sentido: v.sentido === null ? '(n/a)' : v.sentido,
    }));
    const file = path.join(pipelineRoot, 'lib', BASELINE_FILE);
    const doc = 'deuda estricta preexistente congelada (#6260). Crecer = exit 1. NO suprime: el lint la '
        + 'reporta en voz alta en cada corrida, en linea propia. Shrink-only, sin vencimiento. Barrido: #6254.';
    fs.writeFileSync(file, JSON.stringify({ _doc: doc, entries }, null, 4) + '\n', 'utf8');
    logger.info('baseline regenerado: ' + entries.length + ' estrictas congeladas');
    return 0;
}

function main() {
    const logger = defaultLogger();
    const argv = process.argv.slice(2);
    const pipelineRoot = DEFAULT_PIPELINE_ROOT;
    // `--allow-dirty` — salida explicita y documentada del chequeo R-A2, para
    // regenerar cuando hay archivos NUEVOS que entran en este mismo commit.
    const wopts = { skipGitCheck: argv.includes('--allow-dirty') };
    try {
        if (argv.includes('--write-allowlist')) process.exit(writeAllowlist(pipelineRoot, logger, wopts));
        if (argv.includes('--write-baseline')) process.exit(writeBaseline(pipelineRoot, logger, wopts));
        const soloFlagsConocidos = argv.every((a) => a === '--check' || a === '--allow-dirty');
        if (argv.length !== 0 && !soloFlagsConocidos) {
            logger.error('uso: node test-env-lint.js '
                + '[--check | --write-allowlist | --write-baseline] [--allow-dirty]');
            process.exit(2);
        }
        const { code, lines, remedios } = check({ pipelineRoot });
        for (const l of lines) (code === 0 ? logger.info : logger.error)(l);
        if (code !== 0) {
            console.error('');
            console.error('Para resolver:');
            for (const l of (remedios && remedios.length ? remedios : REMEDIOS_VIOLATIONS)) console.error(l);
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
    lint,
    check,
    // Fuente UNICA de la logica de direccion — la importa `test-helpers/with-env.js`
    // (R-A12: escribirla dos veces es reintroducir la causa raiz del hallazgo).
    getRegistry,
    loadRegistry,
    buildRegistry,
    esSentidoInseguro,
    ConfigError,
    // expuesto para tests
    _internal: {
        walkJs, walkProduccion, detectarPodredumbre, FORMA_DE_CONTROL_RE,
        lintFile, loadAllowlist, loadBaseline, applyAllowlist, classify,
        resolveKey, resolveValue, literalString, validarFormaPatron, escapeRegExp,
        baselineKey, inScope, formatViolation, safeSnippet, writeAllowlist, writeBaseline,
        assertWorktreeLimpio, puedeHornearse, REMEDIOS_VIOLATIONS, REMEDIOS_OBSOLETAS,
        largoPrefijoLiteral, largoSufijoLiteral, tieneComodinLibre, defaultLogger,
        ASSIGN_RE, COMPUTED_RE, DELETE_RE, WHOLE_RE,
        SELF_EXEMPT, SKIP_DIRS, SCRATCH_DIR_RE, NO_CONTROL_BLACKLIST, SENTIDOS, KINDS,
        DEFAULT_PIPELINE_ROOT, PROTECTED_FILE, ALLOWLIST_FILE, BASELINE_FILE,
    },
};

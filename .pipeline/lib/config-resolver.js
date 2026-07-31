// =============================================================================
// config-resolver.js — Punto ÚNICO de lectura, validación y resolución de
//                      `config.yaml` (#5172 · Entrega A de #5111)
// =============================================================================
//
// ## Por qué existe
//
// Antes de #5172 había 22 lectores de producción haciendo su propio
// `yaml.load(config.yaml)`, cada uno con su propio `catch` y su propio default.
// Como los defaults del codebase son **apagados por diseño de rollout**
// (`architect.enabled: false`, `gate_mode: dry-run`, `commander_products.products: {}`),
// un `catch { return {} }` convertía *"no pude leer la config"* en *"el gate
// está apagado"* — un fail-open silencioso, no un error. Este módulo elimina esa
// clase de fallo: o la configuración es válida, o se lanza un error tipado.
//
// ## Contrato (CA-4 / SEC-2)
//
//   `resolve()` devuelve la configuración válida **o lanza** el error tipado.
//
// El módulo NO retiene `lastGoodConfig`, NO escribe `.paused` y NO llama a
// `haltOnConfigCorruption`. Esa política es del llamador y es distinta en cada
// uno (D-3): generalizar el last-good acá reinstalaría la degradación
// silenciosa en 22 módulos — esta vez sin el `.paused` que hoy la hace visible.
//
// | Llamador               | Política ante el error tipado                              |
// |------------------------|------------------------------------------------------------|
// | `pulpo.js`             | halt + lastGood + auto-recovery #4832 (NO `process.exit`)   |
// | `dashboard.js`         | `configErrorState`, no sirve decisión derivada, proceso vivo|
// | `project-bootstrap.js` | propaga si no parsea; `kernel:` ausente ⇒ `durable:false`   |
// | CLIs                   | mensaje redactado + `exit 1`, sin defaults silenciosos      |
//
// ## Lo que NO es un error (D-4)
//
// La **ausencia de una sección opcional** (`kernel:`, `waves:`, …) no es
// corrupción: `resolve()` valida el documento y cada consumidor aplica su
// default seguro. Lo que se elimina es el `catch` que convertía *fallo de
// lectura* en default, no el default de *sección ausente*.
//
// ## Seguridad
//
//  - SEC-1 / CA-14: el error tipado expone SÓLO `{archivo, causa, linea,
//    columna}`. El error de `js-yaml` **no se encadena ni se reexpone**: su
//    `.message` trae el snippet crudo del archivo (y con él cualquier valor con
//    forma de secreto de las líneas adyacentes).
//  - SEC-3a / CA-12: las env vars aportan un **directorio**; el nombre del
//    archivo lo pone el resolver (`path.join(raiz, 'config.yaml')`) y se
//    verifica que resuelva a **archivo regular**. Cierra el "apuntá la autoridad
//    de los gates a cualquier YAML del disco".
//  - SEC-3b / CA-13: cada proceso deja traza, una sola vez, de qué ruta resolvió
//    y por qué mecanismo. *"¿Qué config estoy enforzando?"* se contesta del log.
//  - SEC-4 / CA-16: los overrides por env var salen de una **allowlist cerrada**.
//    Prohibido barrer `process.env` o descubrir por prefijo: el env del pulpo
//    está hidratado con `TELEGRAM_BOT_TOKEN` y `ANTHROPIC_API_KEY`
//    (`pulpo.js:14` + `lib/credentials.js`).
//  - CA-17: `js-yaml` v4 safe-by-default. PROHIBIDO `DEFAULT_FULL_SCHEMA` y
//    `loadAll` (grep del guard lo verifica).
//
// ## Nota de carga (G-3)
//
// Este módulo hace `require('js-yaml')` y `require('./config-schema')` (→ `ajv`)
// en el tope. Los runners que corren en worktrees **sin `node_modules`**
// (`pulpo-liveness-run.js`, `watchdog-supervisor-run.js`) deben requerirlo
// **lazy dentro de su `try`** y tratar `MODULE_NOT_FOUND` como fail-soft — si no,
// mueren en el import, antes de llegar a cualquier política, y el fallo es mudo.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml'); // v4.1.1 safe-by-default (CA-17)
const {
    validateConfig,
    formatErrors,
    redactYamlParseError,
    ConfigSchemaViolation,
    ConfigParseViolation,
} = require('./config-schema');

// -----------------------------------------------------------------------------
// D-1 · ÚNICA regla de resolución de la raíz del pipeline
// -----------------------------------------------------------------------------
//
//   1. `opts.configPath`  — argumento explícito (ruta de ARCHIVO)
//   2. `opts.pipelineDir` — argumento explícito (DIRECTORIO)
//   3. `PIPELINE_DIR_OVERRIDE`
//   4. `PIPELINE_STATE_DIR`
//   5. `PIPELINE_REPO_ROOT` + `/.pipeline`
//   6. `path.resolve(__dirname, '..')`  — la `.pipeline/` de este checkout
//
// Los **argumentos** van primero (D-E): ~40 tests y 5 módulos de producción
// (`project-bootstrap.deps.configPath`, `deliverable-index.opts.pipelineRoot`,
// `kernel-provision.cfgPath`, `health-cron.configPath`,
// `kpi-deliverables-by-skill.ctx.repoRoot`) inyectan por firma. Si la regla
// arrancara por env var, esos puntos de inyección quedarían muertos y el fallo
// NO sería ruidoso: un tmpdir incompleto **apagaría gates en silencio** dentro
// del test, porque los defaults del codebase son apagados por diseño.
//
// `opts.configPath` puede ser ruta de archivo porque es **código**, no entorno:
// CA-12 restringe lo que puede aportar el ENTORNO, no la firma de una función.
//
// `PIPELINE_REPO_ROOT` está en el orden porque `anomaly-detector.js:31-35` ya lo
// usaba; omitirlo rompería CA-18 para ese lector.
//
// Los call-sites que hoy fijan su raíz a `__dirname` **sin** ninguna env var
// (`pulpo-liveness-run.js`, `watchdog-supervisor-run.js`,
// `scripts/planner-waves-cli.js`) pasan `opts.pipelineDir` explícito: si
// dependieran de la cadena, heredar `PIPELINE_REPO_ROOT` del entorno del pulpo
// les cambiaría la raíz del worktree al repo principal, en silencio (G-3).

const ENV_ROOT_VARS = Object.freeze([
    { env: 'PIPELINE_DIR_OVERRIDE', via: 'DIR_OVERRIDE', suffix: null },
    { env: 'PIPELINE_STATE_DIR', via: 'STATE_DIR', suffix: null },
    { env: 'PIPELINE_REPO_ROOT', via: 'REPO_ROOT', suffix: '.pipeline' },
]);

/**
 * Resuelve QUÉ archivo de configuración es la autoridad, y por qué mecanismo.
 *
 * @param {{configPath?: string, pipelineDir?: string}} [opts]
 * @returns {{file: string, via: string, dir: string}}
 */
function resolveConfigPath(opts = {}) {
    if (opts.configPath) {
        const file = path.resolve(opts.configPath);
        return { file, via: 'arg:configPath', dir: path.dirname(file) };
    }
    let dir = null;
    let via = null;
    if (opts.pipelineDir) {
        dir = path.resolve(opts.pipelineDir);
        via = 'arg:pipelineDir';
    } else {
        for (const cand of ENV_ROOT_VARS) {
            const val = process.env[cand.env];
            if (val) {
                dir = cand.suffix ? path.join(path.resolve(val), cand.suffix) : path.resolve(val);
                via = cand.via;
                break;
            }
        }
    }
    if (dir === null) {
        dir = path.resolve(__dirname, '..');
        via = 'default';
    }
    // CA-12: la env aporta DIRECTORIO; el nombre del archivo lo pone el resolver,
    // NUNCA el entorno. Un `PIPELINE_STATE_DIR=/tmp/cualquier.yaml` no convierte
    // ese YAML en la autoridad de los gates: se buscaría `/tmp/cualquier.yaml/config.yaml`.
    return { file: path.join(dir, 'config.yaml'), via, dir };
}

// -----------------------------------------------------------------------------
// CA-13 · Traza de resolución (una vez por proceso y por archivo resuelto)
// -----------------------------------------------------------------------------

/** @type {Set<string>} claves `file|via` ya trazadas en este proceso. */
const traced = new Set();
/** @type {Array<{file: string, via: string, nivel: string, mensaje: string}>} */
const traceLog = [];
/** @type {(linea: string, nivel: string) => void} */
let traceSink = (linea) => {
    // stderr y no stdout: los CLIs del pipeline sirven datos por stdout.
    try { process.stderr.write(linea + '\n'); } catch { /* best-effort */ }
};

/**
 * Redirige la traza (el pulpo la manda a `logs/pulpo.log`; los tests la capturan).
 * @param {null|((linea: string, nivel: string) => void)} fn - `null` restaura stderr.
 */
function setTraceSink(fn) {
    traceSink = typeof fn === 'function'
        ? fn
        : (linea) => { try { process.stderr.write(linea + '\n'); } catch { /* best-effort */ } };
}

/** Traza acumulada en este proceso (para tests y para `/salud`). */
function getTraces() {
    return traceLog.slice();
}

function emitTrace(nivel, mensaje, file, via) {
    traceLog.push({ file, via, nivel, mensaje });
    traceSink(mensaje, nivel);
}

function traceOnce(file, via) {
    const key = `${file}|${via}`;
    if (traced.has(key)) return;
    traced.add(key);
    emitTrace('info', `[config-resolver] config resuelta: ${file} (vía ${via})`, file, via);
}

// -----------------------------------------------------------------------------
// CA-16 / SEC-4 · Overrides por env var — allowlist CERRADA
// -----------------------------------------------------------------------------
//
// G-2: la sección real del config es `admission_gate`, NO `admission`. Escribir
// en `admission.*` crearía una sección fantasma paralela a la real (el schema es
// `additionalProperties: true` en la raíz y no la rechazaría) y le dejaría a
// #5173 una clave sintética que clasificar.
//
// Precedencia fijada: **env > YAML > default del consumidor**. Hoy los valores
// del YAML (`sweep_enabled: true`, `dry_run: false`) coinciden con los defaults
// que produce la ausencia de env var, así que la paridad de CA-18 se sostiene;
// el test de CA-16 lo afirma explícitamente en vez de darlo por sentado.
//
// PROHIBIDO iterar `process.env` o descubrir por prefijo: el env del pulpo está
// hidratado con secretos (`TELEGRAM_BOT_TOKEN`, `ANTHROPIC_API_KEY`).

const ENV_OVERRIDES = Object.freeze([
    {
        env: 'ADMISSION_SWEEP_ENABLED',
        path: ['admission_gate', 'sweep_enabled'],
        parse: (v) => v !== '0',
        // Debilita el gate cuando lo APAGA.
        weakensWhen: (v) => v === '0',
        efecto: 'el sweep del admission gate quedó apagado',
    },
    {
        env: 'ADMISSION_GATE_DRY_RUN',
        path: ['admission_gate', 'dry_run'],
        parse: (v) => v === '1',
        // Debilita el gate cuando lo pasa a dry-run (loguea pero no aplica).
        weakensWhen: (v) => v === '1',
        efecto: 'el admission gate quedó en dry-run (loguea pero no aplica)',
    },
]);

function setDeep(obj, segments, value) {
    let node = obj;
    for (let i = 0; i < segments.length - 1; i += 1) {
        const seg = segments[i];
        if (!node[seg] || typeof node[seg] !== 'object' || Array.isArray(node[seg])) node[seg] = {};
        node = node[seg];
    }
    node[segments[segments.length - 1]] = value;
}

/**
 * Aplica los overrides de la allowlist sobre el documento y deja traza.
 * Todo override que DEBILITA un gate se loguea con nivel de **alerta**, no info
 * — es justo el agujero que el issue describe como *"apagan un gate por env var
 * sin traza"*.
 *
 * @param {object} doc - config ya validada (se muta in-place; es la copia cacheada).
 * @param {string} file - ruta resuelta (para la traza).
 * @param {string} via
 * @returns {object} el mismo `doc`.
 */
function applyEnvOverrides(doc, file, via) {
    for (const o of ENV_OVERRIDES) {
        // Sólo se lee `process.env[o.env]` para o ∈ ENV_OVERRIDES. Nada más.
        const raw = process.env[o.env];
        if (raw === undefined) continue;
        const valor = o.parse(raw);
        setDeep(doc, o.path, valor);
        const clave = o.path.join('.');
        if (o.weakensWhen(raw)) {
            emitTrace(
                'alerta',
                `[config-resolver] ALERTA override: ${o.env}=${raw} → ${clave}=${valor}`
                + ` (gate debilitado; origen: env, no archivo)`,
                file,
                via,
            );
        } else {
            emitTrace(
                'info',
                `[config-resolver] override: ${o.env}=${raw} → ${clave}=${valor} (origen: env, no archivo)`,
                file,
                via,
            );
        }
    }
    return doc;
}

/**
 * #5172 · CA-5 — Aplica **sólo** los overrides por env (con la MISMA traza que
 * `resolve()`) sobre un objeto base.
 *
 * Existe para los consumidores de gates cuando el archivo no se pudo leer: sin
 * esto, "config ilegible" volvería a apagar el gate por la ventana de atrás y en
 * silencio — la degradación exacta que la historia elimina. La allowlist de
 * `ENV_OVERRIDES` sigue siendo la única fuente: acá NO se lee ninguna otra env.
 *
 * @param {object} [base] - defaults del consumidor (no se muta el original).
 * @param {{archivo?: string, via?: string}} [meta] - para la traza.
 * @returns {object} copia de `base` con los overrides aplicados.
 */
function applyOverridesOnly(base = {}, meta = {}) {
    const doc = (base && typeof base === 'object' && !Array.isArray(base)) ? copyOf(base) : {};
    return applyEnvOverrides(doc, meta.archivo || '(config no disponible)', meta.via || 'defaults');
}

/**
 * Texto de alerta al operador para un override que debilita un gate (CA-UX-7).
 * La frase *"origen: entorno, no archivo"* es el punto UX: sin ella el operador
 * audita `config.yaml`, lo ve correcto y no entiende por qué el gate está apagado.
 *
 * @param {string} envVar
 * @returns {string|null} mensaje Telegram, o `null` si esa var no debilita nada.
 */
function formatOverrideAlert(envVar) {
    const o = ENV_OVERRIDES.find((x) => x.env === envVar);
    if (!o) return null;
    const raw = process.env[envVar];
    if (raw === undefined || !o.weakensWhen(raw)) return null;
    return '⚠️ *Gate debilitado por variable de entorno*\n\n'
        + `\`${envVar}=${raw}\` → ${o.efecto}.\n`
        + 'Origen: entorno del proceso, no `config.yaml`. Al reiniciar sin esa variable vuelve al valor del archivo.';
}

// -----------------------------------------------------------------------------
// D-2 · Caché por ruta resuelta
// -----------------------------------------------------------------------------
//
// Reemplaza los cachés ad-hoc que tenían `canonical-facts`, `deliverable-index`,
// `waves` y `servicio-reconciler` (`_globalPhaseOrderCache`).
//
// `resolve()` devuelve una **copia** del documento cacheado: antes de #5172 cada
// lector parseaba el suyo y era dueño de su objeto. Compartir la misma
// referencia entre 22 módulos habilitaría que una mutación local en uno se viera
// en los otros — un cambio de comportamiento que CA-18 no permite. El costo
// (`structuredClone` de ~46KB) es de microsegundos y el caché igual ahorra lo
// caro: el read de FS, el parse YAML y la validación ajv.
//
// RIESGO BAJO cerrado: el pulpo hot-recarga cada ~30s. Un caché sin invalidación
// rompería el auto-recovery de #4832 (el config arreglado nunca se re-leería y la
// pausa no se levantaría sola) ⇒ `pulpo.loadConfig()` llama con `{reload: true}`.

/** @type {Map<string, object>} */
const cache = new Map();

/** Vacía el caché (tests, y cualquier caller que necesite forzar re-lectura). */
function clearCache() {
    cache.clear();
}

/**
 * Resetea el estado de traza. Sólo para tests: CA-13 exige "una vez por proceso"
 * y sin esto un test no puede verificar la primera emisión.
 */
function _resetTraceState() {
    traced.clear();
    traceLog.length = 0;
}

function copyOf(doc) {
    // `structuredClone` es built-in desde Node 17; el pipeline corre Node 24.
    try { return structuredClone(doc); } catch { return JSON.parse(JSON.stringify(doc)); }
}

// -----------------------------------------------------------------------------
// Predicado ÚNICO de «este error lo tiró el resolver de configuración».
// -----------------------------------------------------------------------------
//
// Vive acá, junto a los dos errores que reconoce, porque hay más de un llamador
// que necesita distinguir *"no pude leer la configuración"* (fail-closed) de
// *"cualquier otro error"* — y cada copia local del predicado es una copia que
// se puede desactualizar en silencio.
//
// Los dos `name` son contrato cerrado (D-G): `lib/error-classifier` clasifica la
// corrupción de config por esta MISMA lista de names. Agregar un error tipado
// nuevo obliga a tocar los dos lugares.
//
// Se compara por `name` y no con `instanceof` a propósito: el error cruza
// fronteras de `require` (los call-sites lo reciben propagado desde módulos que
// cargan el resolver por su cuenta) y un doble registro en la caché de módulos
// haría fallar `instanceof` justo en el camino que tiene que fallar cerrado.
//
// @param {*} e
// @returns {boolean}
function isConfigViolation(e) {
    return !!e && (e.name === 'ConfigParseViolation' || e.name === 'ConfigSchemaViolation');
}

/**
 * Lee, valida y resuelve la configuración del pipeline.
 *
 * @param {{configPath?: string, pipelineDir?: string, reload?: boolean}} [opts]
 * @returns {object} configuración resuelta (copia propia del llamador).
 * @throws {ConfigParseViolation} archivo ausente / no regular / YAML inválido /
 *         vacío o no-mapa.
 * @throws {ConfigSchemaViolation} el documento no cumple el schema.
 */
function resolve(opts = {}) {
    const { file, via } = resolveConfigPath(opts);
    if (!opts.reload && cache.has(file)) return copyOf(cache.get(file));
    traceOnce(file, via);

    let st;
    try {
        st = fs.statSync(file);
    } catch {
        // `causa`, NO `code`: `error-classifier` mira `err.code` antes que
        // `err.name`, y 'ENOENT' está en TRANSIENT_CODES — un `code` acá
        // degradaría la corrupción de config a 'transient'.
        throw new ConfigParseViolation('configuración no accesible', {
            archivo: file, via, causa: 'ENOENT',
        });
    }
    if (!st.isFile()) {
        throw new ConfigParseViolation('la ruta de configuración no es un archivo regular', {
            archivo: file, via, causa: 'not-a-file',
        });
    }

    let doc;
    try {
        // CA-17: `yaml.load` con el schema seguro por default. Sin `schema:`
        // custom, sin `DEFAULT_FULL_SCHEMA`, sin `loadAll`.
        doc = yaml.load(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        // SEC-1 / CA-14: `e` NO se encadena (`cause`) ni se reexpone. Sólo
        // línea y columna, que son metadata segura y son *la* info accionable.
        throw new ConfigParseViolation('YAML inválido', {
            archivo: file, via, ...redactYamlParseError(e),
        });
    }
    if (doc === null || doc === undefined || typeof doc !== 'object' || Array.isArray(doc)) {
        // Cubre archivo vacío, archivo a medio escribir y raíz que no es mapa.
        throw new ConfigParseViolation('configuración vacía o no es un mapa de claves', {
            archivo: file, via, causa: 'empty-or-not-a-map',
        });
    }

    const { valid, errors } = validateConfig(doc);
    if (!valid) {
        // `redactErrors` (vía `validateConfig`) fue auditado: `path`, `keyword` y
        // `detail` derivan del SCHEMA, nunca del input. Seguro de reusar tal cual.
        throw new ConfigSchemaViolation(formatErrors(errors), errors, { archivo: file, via });
    }

    const out = applyEnvOverrides(doc, file, via);
    cache.set(file, out);
    return copyOf(out);
}

/**
 * D-B · Variante para comparar **revisiones git** del config (`kernel-parity.js`
 * parsea `.pipeline/config.yaml` de dos refs vía `git show`, no del disco).
 *
 * Parsea y valida **texto arbitrario**. NO lanza, NO cachea, NO trazea y NO
 * dispara fail-closed: un baseline viejo puede violar el schema ACTUAL, y eso
 * no es corrupción del runtime — es exactamente lo que la comparación quiere ver.
 *
 * @param {string} text - contenido YAML crudo.
 * @returns {{valid: boolean, config: object|null,
 *            errors: Array<{path: string, keyword: string, detail: string}>}}
 */
function resolveForDiff(text) {
    if (typeof text !== 'string' || text.trim() === '') {
        return { valid: false, config: null, errors: [{ path: '(root)', keyword: 'empty', detail: 'texto vacío' }] };
    }
    let doc;
    try {
        doc = yaml.load(text);
    } catch (e) {
        // Mismo criterio de redacción que `resolve()`: nunca `e.message`.
        const { linea, columna } = redactYamlParseError(e);
        const pos = linea !== null ? ` (línea ${linea}${columna !== null ? `, col ${columna}` : ''})` : '';
        return {
            valid: false,
            config: null,
            errors: [{ path: '(root)', keyword: 'yaml', detail: `YAML inválido${pos}` }],
        };
    }
    if (doc === null || doc === undefined || typeof doc !== 'object' || Array.isArray(doc)) {
        return {
            valid: false,
            config: null,
            errors: [{ path: '(root)', keyword: 'shape', detail: 'vacío o no es un mapa de claves' }],
        };
    }
    const { valid, errors } = validateConfig(doc);
    // `config` se devuelve aunque no valide: la comparación por revisión necesita
    // el documento para diffear, y esto NO es el camino de enforcement.
    return { valid, config: doc, errors };
}

module.exports = {
    resolve,
    resolveForDiff,
    resolveConfigPath,
    clearCache,
    setTraceSink,
    getTraces,
    applyOverridesOnly,
    formatOverrideAlert,
    isConfigViolation,
    ENV_OVERRIDES,
    ConfigParseViolation,
    ConfigSchemaViolation,
    _resetTraceState,
};

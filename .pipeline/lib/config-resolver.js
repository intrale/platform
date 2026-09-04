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
    checkSide,
    resolveSide,
    formatErrors,
    redactYamlParseError,
    sanitizeKeyName,
    archivoDeLado,
    SCHEMA,
    SIDE_MAP,
    KERNEL_CONFIG_FILE,
    PRODUCT_CONFIG_FILE,
    ConfigSchemaViolation,
    ConfigParseViolation,
} = require('./config-schema');

// =============================================================================
// #5174 · Entrega C de #5111 — la configuración vive PARTIDA en dos archivos
// =============================================================================
//
// | Categoría                    | Precedencia            | Violación                       |
// |------------------------------|------------------------|---------------------------------|
// | Autoridad (lista congelada)  | **kernel gana siempre**| presencia del lado producto o en|
// |                              |                        | env ⇒ falla el arranque         |
// | Calibración / política        | `env > producto > kernel` | —                            |
// | Mecanismo del kernel          | kernel                 | clave de producto del lado      |
// |                              |                        | kernel ⇒ falla el arranque      |
// | `PIPELINE_DIR_OVERRIDE`       | reubica AMBOS o ninguno| reubicación parcial ⇒ falla     |
//
// ## Por qué el merge es código y no anchors YAML
//
// Los anchors (`<<:`) no cruzan archivos, habilitan amplificación (billion
// laughs) y romperían el diff clave por clave que demuestra la paridad. El
// merge de acá es explícito, dirigido por el ESQUEMA CERRADO de #5173 (nunca por
// las claves del archivo — REQ-SEC-C3) y produce un documento que se valida UNA
// vez, entero.
//
// ## Por qué ningún lado suelto se valida contra el schema completo
//
// Post-partición el kernel se queda sin `pipelines.*.skills_por_fase` (que es
// `required`) y el producto sin las secciones de autoridad. Validar cada lado
// contra el schema entero daría falsos positivos garantizados. El reparto de
// responsabilidades es:
//
//   - por lado:   `checkSide(doc, lado)` — ¿alguna clave está en el archivo
//                 equivocado? (bidireccional desde #5174)
//   - mergeado:   `validateConfig(merged)` — el MISMO schema de siempre, sobre
//                 el MISMO documento efectivo de siempre. Es lo que garantiza la
//                 paridad clave por clave del CA-2: si el merge perdiera o
//                 cambiara algo, el schema o el snapshot lo cazan.
//
// ## Rollback (CA-12)
//
// `PARTITION_ENABLED = false` (una línea) vuelve al archivo único: no se lee el
// manifiesto, no hay chequeo de lado y no hay merge. Combinado con revertir el
// movimiento de claves en `config.yaml`, el estado previo se restituye sin tocar
// ningún consumidor. El test `config-partition-rollback.test.js` lo EJERCITA.
// =============================================================================

const PARTITION_ENABLED = true;

// REQ-SEC-C3 / CA-9 — `JSON.parse` acepta `__proto__` como clave literal (a
// diferencia de un object literal). Un merge recursivo ingenuo contamina
// `Object.prototype` y, desde ahí, TODA lectura con default (`cfg.foo ?? d`) en
// los 84 lectores devuelve el valor inyectado — sin aparecer en ningún diff de
// configuración resuelta. Mismo patrón que `dashboard-thresholds.js`.
const FORBIDDEN_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);

// CA-10 / REQ-SEC-C5 — el canal genérico env→config está PROHIBIDO. No existe
// `PIPELINE_CFG_<KEY>`: `build-child-env.js:359` reenvía todo `PIPELINE_*` a
// cada agente hijo, así que un patrón genérico volvería la configuración
// no auditable de un saque. La única superficie de override por env es la
// allowlist cerrada y enumerada de `ENV_OVERRIDES` (#5172 · CA-16).
//
// Cualquier variable que matchee este patrón ⇒ fail-closed nombrando la variable,
// la clave que intenta tocar y el lado/archivo que le corresponde. Ignorarla en
// silencio sería indistinguible de un ataque exitoso desde el log.
const ENV_CONFIG_PATTERN = /^PIPELINE_(?:CFG|CONFIG_SET)_(.+)$/;

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
// #5174 · CA-11 / REQ-SEC-C6 · Dónde vive el manifiesto de producto
// -----------------------------------------------------------------------------
//
// Se DERIVA de la raíz ya resuelta del kernel. El kernel **nunca** toma la
// ubicación del adaptador desde el adaptador: un `product_config_path:` dentro
// del propio archivo sería un self-referential lookup — quien edita el
// manifiesto elegiría qué manifiesto se lee.
//
// Regla: `pipeline.config.json` vive en el PADRE de `.pipeline/` (raíz del repo).
// Si la raíz resuelta no se llama `.pipeline` (sandboxes de test que usan un
// tmpdir plano como pipelineDir), vive en ese mismo directorio. Las dos formas
// derivan de la raíz fija; ninguna acepta un path del entorno.

const PRODUCT_FILENAME = 'pipeline.config.json';

/**
 * @param {string} kernelDir - directorio del `config.yaml` ya resuelto.
 * @returns {string} ruta absoluta del manifiesto de producto.
 */
function productPathFor(kernelDir) {
    const base = path.basename(kernelDir) === '.pipeline' ? path.dirname(kernelDir) : kernelDir;
    return path.join(base, PRODUCT_FILENAME);
}

/**
 * Resuelve las DOS rutas de una sola vez. `via` es único: los dos archivos se
 * reubican por el mismo mecanismo o por ninguno (CA-3).
 *
 * @param {{configPath?: string, pipelineDir?: string}} [opts]
 * @returns {{kernel: {file: string, via: string, dir: string}, product: {file: string, via: string}}}
 */
function resolveConfigPaths(opts = {}) {
    const kernel = resolveConfigPath(opts);
    return { kernel, product: { file: productPathFor(kernel.dir), via: kernel.via } };
}

// -----------------------------------------------------------------------------
// Lectura segura sin ventana TOCTOU (REQ-SEC-C6 / CA-11)
// -----------------------------------------------------------------------------
//
// Validar con `realpath` y después abrir por path deja una ventana en la que el
// path validado puede cambiar (CWE-367). Acá se abre PRIMERO, se valida sobre el
// **mismo descriptor** (`fstat`) y se relee el `realpath` DESPUÉS de leer: si
// cambió entre la apertura y la lectura, se aborta.

/**
 * @param {string} file - ruta a leer.
 * @param {string} via
 * @returns {string} contenido utf8.
 * @throws {ConfigParseViolation}
 */
function readFileSecure(file, via) {
    // Rechazo de `..` ANTES de tocar el FS: la ruta la derivamos nosotros, así
    // que un `..` acá significa que la raíz vino contaminada.
    if (file.split(/[\\/]/).includes('..')) {
        throw new ConfigParseViolation('la ruta de configuración contiene ..', {
            archivo: file, via, causa: 'not-a-file',
        });
    }
    let fd = null;
    try {
        try {
            fd = fs.openSync(file, 'r');
        } catch {
            throw new ConfigParseViolation('configuración no accesible', {
                archivo: file, via, causa: 'ENOENT',
            });
        }
        // Sobre el DESCRIPTOR, no sobre el path: cierra la ventana entre el
        // chequeo y la apertura.
        const st = fs.fstatSync(fd);
        if (!st.isFile()) {
            throw new ConfigParseViolation('la ruta de configuración no es un archivo regular', {
                archivo: file, via, causa: 'not-a-file',
            });
        }
        // Un symlink que APUNTA adentro de la raíz es legítimo (checkouts,
        // worktrees). Lo que se rechaza es que el destino real escape del
        // directorio del que derivamos la ruta.
        const real = fs.realpathSync(file);
        const raizReal = fs.realpathSync(path.dirname(file));
        if (path.dirname(real) !== raizReal) {
            throw new ConfigParseViolation('la configuración resuelve fuera de su raíz', {
                archivo: file, via, causa: 'not-a-file',
            });
        }
        const buf = Buffer.alloc(st.size);
        let leidos = 0;
        while (leidos < st.size) {
            const n = fs.readSync(fd, buf, leidos, st.size - leidos, leidos);
            if (n <= 0) break;
            leidos += n;
        }
        // Revalidación post-lectura: si el path pasó a resolver a otro inodo
        // mientras leíamos, lo leído no es lo que validamos.
        if (fs.realpathSync(file) !== real) {
            throw new ConfigParseViolation('la configuración cambió durante la lectura', {
                archivo: file, via, causa: 'not-a-file',
            });
        }
        return buf.slice(0, leidos).toString('utf8');
    } finally {
        if (fd !== null) { try { fs.closeSync(fd); } catch { /* best-effort */ } }
    }
}

// -----------------------------------------------------------------------------
// Guardas de la frontera producto → kernel
// -----------------------------------------------------------------------------

/**
 * REQ-SEC-C3 / CA-9 — barrido profundo de claves prohibidas sobre el lado
 * NO confiable (el manifiesto de producto es un JSON mergeable por PR).
 *
 * @param {*} node
 * @param {string[]} segs
 * @param {Array<object>} out
 */
function collectForbiddenKeys(node, segs, out) {
    if (!node || typeof node !== 'object' || segs.length > 12) return;
    if (Array.isArray(node)) {
        node.forEach((v, i) => collectForbiddenKeys(v, segs.concat(String(i)), out));
        return;
    }
    for (const key of Object.keys(node)) {
        const childSegs = segs.concat(key);
        if (FORBIDDEN_KEYS.includes(key)) {
            out.push({
                path: '/' + childSegs.map(sanitizeKeyName).join('/'),
                keyword: 'forbidden-key',
                detail: `clave prohibida '${sanitizeKeyName(key)}': contamina el prototipo`,
                lado: 'producto',
            });
            continue;
        }
        collectForbiddenKeys(node[key], childSegs, out);
    }
}

/**
 * CA-10 / CA-4 (escenario env) — ninguna clave se inyecta por variable de
 * entorno fuera de la allowlist cerrada. El mensaje nombra la variable, la clave
 * y el archivo que le corresponde (CA-14, las 4 piezas).
 *
 * @param {NodeJS.ProcessEnv} env
 * @throws {ConfigSchemaViolation}
 */
function assertNoConfigEnvInjection(env) {
    const errores = [];
    for (const name of Object.keys(env || {})) {
        const m = ENV_CONFIG_PATTERN.exec(name);
        if (!m) continue;
        // `PIPELINE_CFG_COMMANDER_PRODUCTS__PRODUCTS` → `commander_products.products`
        const dotted = m[1].toLowerCase().split('__').join('.');
        const lado = resolveSide(dotted);
        errores.push({
            path: '/' + dotted.split('.').map(sanitizeKeyName).join('/'),
            keyword: 'env',
            detail: `la variable '${sanitizeKeyName(name)}' intenta setear una clave de lado `
                + `'${lado}', que vive en ${archivoDeLado(lado)}`
                + (lado === 'autoridad' ? ' y NO se override nunca por entorno' : ''),
            lado,
        });
    }
    if (errores.length) {
        throw new ConfigSchemaViolation(formatErrors(errores), errores, { causa: 'env-prohibida' });
    }
}

/**
 * Guarda ESTRUCTURAL de la allowlist de overrides por env (CA-10).
 *
 * La regla que fija esta entrega es: **el canal de override por entorno es de
 * calibración, no de autoridad**. Se verifica sobre la propia tabla, no sobre el
 * entorno, así que una entrada nueva mal clasificada rompe el arranque y los
 * tests — no espera a que alguien setee la variable en producción.
 *
 * Excepción documentada y ACOTADA (nunca silenciosa, CA-8): los dos kill-switches
 * de `admission_gate` que #5172 entregó como corte instantáneo del gate de
 * admisión. `admission_gate` es lado `autoridad`, así que bajo la regla nueva no
 * podrían existir; se conservan porque (a) son un control de emergencia ya
 * auditado, (b) están enumerados en código y no son descubribles por patrón,
 * (c) el resolver los TRAZEA con nivel de alerta cuando debilitan el gate, y
 * (d) su equivalente en archivo (`admission_gate.sweep_enabled`) sigue siendo el
 * camino documentado. Quitarlos es una decisión de producto, no de esta entrega:
 * removerlos acá dejaría al operador sin corte instantáneo durante un incidente.
 *
 * Cualquier entrada NUEVA que apunte a autoridad ⇒ error al cargar el módulo.
 */
const ENV_AUTHORITY_GRANDFATHERED = Object.freeze(['ADMISSION_SWEEP_ENABLED', 'ADMISSION_GATE_DRY_RUN']);

function assertEnvOverridesAllowlistIsSafe(entradas) {
    for (const o of entradas) {
        const dotted = o.path.join('.');
        const lado = resolveSide(dotted);
        if (lado === 'producto') continue;
        if (ENV_AUTHORITY_GRANDFATHERED.includes(o.env)) continue;
        throw new Error(
            `[config-resolver] ENV_OVERRIDES inválida: '${o.env}' apunta a '${dotted}' (lado '${lado}'). `
            + 'El override por entorno es de calibración: sólo se admiten claves de lado producto. '
            + `Movela a ${archivoDeLado(lado)} o justificá la excepción en ENV_AUTHORITY_GRANDFATHERED.`
        );
    }
}

// -----------------------------------------------------------------------------
// Merge por categoría (CA-3 / CA-9)
// -----------------------------------------------------------------------------
//
// Dirigido por el ESQUEMA CERRADO de #5173, nunca por las claves del archivo de
// producto. Como `checkSide` ya corrió en los dos sentidos, los dos lados son
// **disjuntos**: ninguna clave existe en ambos. El merge es una unión, y por eso
// la paridad clave por clave del CA-2 es demostrable.
//
// `hasProductoDescendant` no se re-implementa: se deduce del propio `SIDE_MAP`,
// que es la fuente de verdad congelada.

const SPLIT_PREFIXES = Object.freeze(
    Object.keys(SIDE_MAP)
        .filter((p) => SIDE_MAP[p] === 'producto' && p.includes('.'))
        .map((p) => p.split('.'))
);

/** ¿La sección `segs` tiene un split de producto declarado más abajo? */
function tieneSplit(segs) {
    return SPLIT_PREFIXES.some((pat) => pat.length > segs.length
        && pat.slice(0, segs.length).every((s, i) => s === '*' || s === segs[i]));
}

function esMapa(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Une dos subárboles disjuntos. Los acumuladores se crean con
 * `Object.create(null)` (CA-9): aunque una clave prohibida burlara el barrido,
 * la asignación no llegaría al setter de `__proto__`.
 */
function unir(kernelVal, productVal, segs) {
    if (productVal === undefined) return kernelVal;
    if (kernelVal === undefined) return productVal;
    if (!esMapa(kernelVal) || !esMapa(productVal) || !tieneSplit(segs)) {
        // Sin split declarado no puede haber colisión legítima: gana producto y
        // el schema del documento mergeado decide si el resultado es válido.
        return productVal;
    }
    const out = Object.create(null);
    for (const k of Object.keys(kernelVal)) out[k] = kernelVal[k];
    for (const k of Object.keys(productVal)) {
        if (FORBIDDEN_KEYS.includes(k)) continue; // ya rechazado antes; defensa en profundidad
        out[k] = unir(kernelVal[k], productVal[k], segs.concat(k));
    }
    return out;
}

/**
 * @param {object} kernel - documento del `config.yaml` (ya sin claves de producto).
 * @param {object} product - slice de producto del manifiesto (ya sin claves de kernel).
 * @returns {object} documento efectivo.
 */
function mergeSides(kernel, product) {
    const out = Object.create(null);
    // 1) Recorrido por el ESQUEMA (REQ-SEC-C3): las secciones declaradas mandan
    //    el orden y son las únicas que el lado producto puede aportar.
    for (const seccion of Object.keys(SCHEMA.properties)) {
        const v = unir(kernel[seccion], product[seccion], [seccion]);
        if (v !== undefined) out[seccion] = v;
    }
    // 2) Sobrantes del KERNEL (secciones no declaradas): pasan tal cual para que
    //    la raíz cerrada del schema las reporte con su sugerencia de clave
    //    cercana, en vez de desaparecer en silencio en el merge. El lado
    //    producto no puede aportar sobrantes: `checkSide` ya los rechazó.
    for (const k of Object.keys(kernel)) {
        if (!(k in out)) out[k] = kernel[k];
    }
    return out;
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

// #5174 · CA-10 — la tabla de arriba se audita al cargar el módulo, no cuando
// alguien setea la variable. Una entrada nueva apuntando a autoridad rompe acá.
assertEnvOverridesAllowlistIsSafe(ENV_OVERRIDES);

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
    // La alerta de la excepción de `repos` es once-per-process como la traza de
    // resolución: sin resetearla acá, el test que la verifica dependería del
    // orden en que corran los archivos del runner.
    reposTrazado.clear();
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
    const { kernel: k, product: p } = resolveConfigPaths(opts);
    const { file, via } = k;
    if (!opts.reload && cache.has(file)) return copyOf(cache.get(file));
    traceOnce(file, via);

    // CA-10 — antes de leer nada: si el entorno intenta inyectar configuración
    // por el canal genérico prohibido, no hay merge que valga.
    assertNoConfigEnvInjection(process.env);

    const kernelDoc = loadKernelYaml(file, via);

    // Rollback en una línea (CA-12): sin partición no se lee el manifiesto, no
    // hay chequeo de lado y no hay merge — el comportamiento vuelve al de #5172.
    const partir = PARTITION_ENABLED && opts.partition !== false;
    let doc = kernelDoc;
    if (partir) {
        traceOnce(p.file, via);
        const productDoc = loadProductJson(p.file, via, { kernelFile: file });
        // Fail-closed en los DOS sentidos, ANTES de mergear: un merge parcial
        // sobre lados mal clasificados es peor que no arrancar.
        assertSide(kernelDoc, 'kernel', file, via);
        assertSide(productDoc, 'producto', p.file, via);
        // `copyOf` normaliza los acumuladores `Object.create(null)` del merge a
        // objetos ordinarios antes de que los vea ajv o cualquiera de los 84
        // lectores. Cuesta microsegundos y evita sorpresas de prototipo.
        doc = copyOf(mergeSides(kernelDoc, productDoc));
    }

    const { valid, errors } = validateConfig(doc);
    if (!valid) {
        // `redactErrors` (vía `validateConfig`) fue auditado: `path`, `keyword` y
        // `detail` derivan del SCHEMA, nunca del input. Seguro de reusar tal cual.
        // El archivo que se nombra es el del KERNEL: un error de schema sobre el
        // documento mergeado no se puede atribuir a un lado sin adivinar, y el
        // `detail` ya trae el path exacto de la clave.
        throw new ConfigSchemaViolation(formatErrors(errors), errors, { archivo: file, via });
    }

    const out = applyEnvOverrides(doc, file, via);
    cache.set(file, out);
    return copyOf(out);
}

/**
 * Lee y parsea el `config.yaml` del kernel. Los errores salen tipados y
 * REDACTADOS: nunca el `.message` de js-yaml (trae el snippet crudo del archivo).
 *
 * @param {string} file
 * @param {string} via
 * @returns {object}
 * @throws {ConfigParseViolation}
 */
function loadKernelYaml(file, via) {
    const texto = readFileSecure(file, via);
    let doc;
    try {
        // CA-17: `yaml.load` con el schema seguro por default. Sin `schema:`
        // custom, sin `DEFAULT_FULL_SCHEMA`, sin `loadAll`.
        doc = yaml.load(texto);
    } catch (e) {
        // SEC-1 / CA-14: `e` NO se encadena (`cause`) ni se reexpone. Sólo
        // línea y columna, que son metadata segura y son *la* info accionable.
        throw new ConfigParseViolation('YAML inválido', {
            archivo: file, via, ...redactYamlParseError(e),
        });
    }
    if (!esMapa(doc)) {
        // Cubre archivo vacío, archivo a medio escribir y raíz que no es mapa.
        throw new ConfigParseViolation('configuración vacía o no es un mapa de claves', {
            archivo: file, via, causa: 'empty-or-not-a-map',
        });
    }
    return doc;
}

// Clave del manifiesto donde vive el slice de configuración del producto.
// NO se llama `routing` (el placeholder que reemplaza) a propósito: `routing` ya
// es una sección de `config.yaml` del lado KERNEL (`routing.max_bounces`), y dos
// cosas distintas con el mismo nombre en los dos archivos de una partición es
// exactamente la ambigüedad que la partición viene a eliminar.
const PRODUCT_CONFIG_KEY = 'productConfig';

/**
 * Lee el manifiesto de producto y devuelve su slice de configuración.
 *
 * CA-5 — el fallo de este archivo es corrupción **TOTAL**, con el mismo trato
 * que el del kernel: nunca se degrada a merge parcial ni a "seguí con el kernel
 * solo", porque eso reinstala el modo de falla que la entrega elimina (el
 * consumidor deja de ver su clave y cae a su default permisivo).
 *
 * @param {string} file
 * @param {string} via
 * @param {{kernelFile: string}} ctx
 * @returns {object}
 * @throws {ConfigParseViolation|ConfigSchemaViolation}
 */
function loadProductJson(file, via, ctx) {
    let texto;
    try {
        texto = readFileSecure(file, via);
    } catch (e) {
        // CA-3 — «reubica ambos o ninguno». Si el kernel se resolvió por un
        // override y el manifiesto no está ahí pero SÍ está en la ubicación por
        // defecto, la reubicación quedó a medias: el proceso estaría mezclando
        // el kernel de un checkout con el producto de otro. Se nombra como tal
        // en vez de como un ENOENT genérico, que mandaría al operador a crear un
        // archivo donde no va.
        if (e && e.causa === 'ENOENT' && via !== 'default') {
            const porDefecto = productPathFor(path.resolve(__dirname, '..'));
            if (porDefecto !== file && fs.existsSync(porDefecto)) {
                const err = new ConfigSchemaViolation(
                    `la raíz se reubicó vía ${via} pero ${PRODUCT_CONFIG_FILE} sólo existe en la ubicación por defecto`,
                    [{
                        path: '/' + PRODUCT_FILENAME,
                        keyword: 'partial-relocation',
                        detail: `falta en la raíz reubicada (vía ${via}); ${KERNEL_CONFIG_FILE} sí se movió`,
                        lado: 'producto',
                    }],
                    { archivo: file, via, causa: 'reubicacion-parcial' },
                );
                throw err;
            }
        }
        throw e;
    }
    let doc;
    try {
        doc = JSON.parse(texto);
    } catch (e) {
        // Mismo criterio que el YAML: nunca `e.message` (trae el fragmento crudo).
        throw new ConfigParseViolation('JSON inválido', {
            archivo: file, via, causa: 'json-invalido',
        });
    }
    if (!esMapa(doc)) {
        throw new ConfigParseViolation('el manifiesto de producto está vacío o no es un mapa de claves', {
            archivo: file, via, causa: 'empty-or-not-a-map',
        });
    }
    // REQ-SEC-C3 — el barrido corre sobre el manifiesto ENTERO, no sólo sobre el
    // slice de configuración: `__proto__` en cualquier rama contamina igual.
    const prohibidas = [];
    collectForbiddenKeys(doc, [], prohibidas);
    if (prohibidas.length) {
        throw new ConfigSchemaViolation(formatErrors(prohibidas), prohibidas, {
            archivo: file, via, causa: 'clave-prohibida',
        });
    }
    // REQ-SEC-C2 — el chequeo de lado del TOP-LEVEL, ANTES de quedarnos con el
    // slice. Va acá y no en `resolve()` a propósito: es el único punto del
    // proceso que tiene el manifiesto ENTERO en la mano; devolver sólo el slice
    // y chequear después obligaría a pasear el documento completo, que es
    // exactamente el descuido que dejó este agujero abierto en rev-1.
    assertManifestTopLevel(doc, file, via);
    const slice = doc[PRODUCT_CONFIG_KEY];
    if (slice === undefined) {
        throw new ConfigParseViolation(
            `el manifiesto de producto no declara '${PRODUCT_CONFIG_KEY}'`,
            { archivo: file, via, causa: 'empty-or-not-a-map' },
        );
    }
    if (!esMapa(slice)) {
        throw new ConfigParseViolation(
            `'${PRODUCT_CONFIG_KEY}' no es un mapa de claves`,
            { archivo: file, via, causa: 'empty-or-not-a-map' },
        );
    }
    void ctx;
    return slice;
}

// -----------------------------------------------------------------------------
// REQ-SEC-C2 / CA-8 — chequeo de lado del TOP-LEVEL del manifiesto
// -----------------------------------------------------------------------------
//
// `assertSide(productDoc, 'producto')` corre sobre el slice `productConfig`. En
// rev-1 TODO el resto del manifiesto —su top-level— quedaba fuera de cualquier
// chequeo: un PR que tocara sólo este JSON podía agregar `firma_operador:
// {enabled:false}` (lado autoridad) o una clave inventada, y el arranque lo
// aceptaba sin fallar y sin traza. El `productConfigNote` del propio archivo
// afirmaba lo contrario. Es el modo de falla que el issue prohíbe con todas las
// letras: «ignorar en silencio es indistinguible de un ataque exitoso desde el
// log».
//
// El manifiesto NO es un cajón libre: es un contrato de forma cerrada. Por eso la
// lista va ENUMERADA y CONGELADA, nunca derivada de un patrón — una clave nueva
// obliga a tocar esta constante, que es el punto donde se audita la frontera.
// Default FAIL-CLOSED, igual que `resolveSide`: lo no enumerado se rechaza.
const MANIFEST_KEYS = Object.freeze([
    // Identidad y contrato
    'contractVersion', 'projectId', 'displayName', 'kernel',
    // Descriptor del repo destino y de la mecánica de entrega
    'repo', 'repos', 'defaultAssignee', 'branch', 'qaLabels', 'commands',
    'workspace', 'pr',
    // Capacidades y puntos de extensión del adaptador
    'capabilities', 'extensionPoints',
    // Slice de configuración de producto (lo único que entra al merge)
    PRODUCT_CONFIG_KEY,
    // Notas: documentación embebida, sin efecto de runtime.
    'capabilitiesNote', 'productConfigNote', 'productConfigNotes',
]);

// -----------------------------------------------------------------------------
// CA-8 · Decisión sobre `repos.*` — se pronuncia acá y la fija un test
// -----------------------------------------------------------------------------
//
// DECISIÓN: `repos.primary`, `repos.allowlist` y `repos.intake` son lado
// **AUTORIDAD**. `repo-target.js:13-14` lo dice textual: sumar un repo a la
// allowlist es «otorgarle confianza de ejecución de código con el token del
// pipeline». Bajo la regla de esta entrega —autoridad ⇒ kernel gana siempre, la
// sola presencia del lado producto rompe el arranque— no podrían vivir acá.
//
// EXCEPCIÓN DE MIGRACIÓN, enumerada y acotada (mismo patrón que
// `ENV_AUTHORITY_GRANDFATHERED`): se conservan en el manifiesto porque
//   (a) `repo-target.js` y `kernel-resolver.js` los leen de este archivo desde
//       #4693, por fuera del resolver, y moverlos el día 1 rompería la paridad
//       clave por clave del CA-2 sin ganar frontera: CODEOWNERS NO cubre
//       `.pipeline/` (auto-merge habilitado, ver `.github/CODEOWNERS`), así que
//       `config.yaml` y este manifiesto están HOY bajo el mismo control de
//       revisión — mudar el bloque no agregaría un gate humano, sólo movería el
//       archivo;
//   (b) la excepción no es descubrible por patrón: está enumerada acá y sólo
//       cubre las sub-claves que ya existían;
//   (c) NO es silenciosa: se trazea con nivel `alerta` en cada arranque;
//   (d) queda CHEQUEADA, no exenta: sub-clave nueva ⇒ fail-closed, y las
//       invariantes de la frontera (`intake ⊆ allowlist`, `primary ∈ allowlist`)
//       se verifican en el arranque.
//
// El cierre de la excepción —mover el bloque al kernel— es de #4694, que ya es
// la dependencia declarada del `note` del propio bloque (naming repo-scoped).
const REPOS_AUTHORITY_KEY = 'repos';
const REPOS_GRANDFATHERED_SUBKEYS = Object.freeze([
    'primary', 'allowlist', 'intake', 'default_base_ref', 'note',
]);

/** Claves `repos|file|via` ya trazadas: la alerta se emite una vez por proceso. */
const reposTrazado = new Set();

/**
 * REQ-SEC-C2 — toda clave del top-level del manifiesto que no esté en la lista
 * congelada rompe el arranque, nombrando la clave y el lado al que pertenece.
 *
 * @param {object} doc - manifiesto ENTERO (no el slice).
 * @param {string} file
 * @param {string} via
 * @throws {ConfigSchemaViolation}
 */
function assertManifestTopLevel(doc, file, via) {
    const errors = [];
    for (const key of Object.keys(doc)) {
        if (MANIFEST_KEYS.includes(key)) continue;
        // `resolveSide` es la MISMA fuente de verdad que usa el chequeo del
        // slice, así que una clave de autoridad se nombra como tal y el operador
        // lee a qué archivo mudarla. Lo que no está en `SIDE_MAP` cae al default
        // fail-closed (`kernel`), que también es un destino accionable.
        const lado = resolveSide(key);
        errors.push({
            path: '/' + sanitizeKeyName(key),
            keyword: 'manifest-key',
            detail: `no es una clave del manifiesto de producto; es lado '${lado}' y va en ${archivoDeLado(lado)}`,
            lado,
        });
    }
    if (errors.length) {
        throw new ConfigSchemaViolation(formatErrors(errors), errors, {
            archivo: file, via, causa: 'clave-fuera-del-manifiesto',
        });
    }
    if (Object.prototype.hasOwnProperty.call(doc, REPOS_AUTHORITY_KEY)) {
        assertReposAuthorityBlock(doc[REPOS_AUTHORITY_KEY], file, via);
    }
}

/**
 * CA-8 — la excepción de migración de `repos.*` queda ACOTADA y CHEQUEADA.
 *
 * No valida la forma `owner/repo` de cada entrada: eso ya lo hace `repo-target`
 * con default-deny en el punto de uso, y duplicar el regex crearía una segunda
 * fuente de verdad que puede desfasarse. Acá se verifica lo que `repo-target` no
 * puede ver desde una sola función: la COHERENCIA del bloque.
 *
 * Los errores NO vuelcan el valor (SEC-2): el manifiesto es mergeable por PR y el
 * error viaja al log y a Telegram. Se nombra el path (con índice) y el motivo.
 *
 * @param {*} repos
 * @param {string} file
 * @param {string} via
 * @throws {ConfigSchemaViolation}
 */
function assertReposAuthorityBlock(repos, file, via) {
    const errors = [];
    const push = (p, keyword, detail) => errors.push({ path: p, keyword, detail, lado: 'autoridad' });

    if (!esMapa(repos)) {
        push('/repos', 'shape', 'la frontera de confianza tiene que ser un mapa de claves');
    } else {
        for (const k of Object.keys(repos)) {
            if (REPOS_GRANDFATHERED_SUBKEYS.includes(k)) continue;
            push('/repos/' + sanitizeKeyName(k), 'authority-scope',
                'no está en la excepción de migración enumerada; una clave nueva bajo la frontera de '
                + `confianza es lado autoridad y va en ${archivoDeLado('autoridad')}`);
        }
        const arr = (k) => (Array.isArray(repos[k]) ? repos[k] : null);
        if (repos.allowlist !== undefined && !arr('allowlist')) push('/repos/allowlist', 'type', 'se espera un array');
        if (repos.intake !== undefined && !arr('intake')) push('/repos/intake', 'type', 'se espera un array');
        if (repos.primary !== undefined && typeof repos.primary !== 'string') push('/repos/primary', 'type', 'se espera un string');

        // Invariantes de la frontera: nada se consulta ni se toma como primario
        // sin estar allowlisted. Un `intake` con un repo que no está en la
        // allowlist es exactamente el desfasaje que #4693 vino a eliminar.
        const allow = arr('allowlist');
        if (allow) {
            const permitidos = new Set(allow);
            const intake = arr('intake');
            if (intake) {
                intake.forEach((r, i) => {
                    if (!permitidos.has(r)) {
                        push(`/repos/intake/${i}`, 'authority-invariant', 'el repo de intake no está en `allowlist`');
                    }
                });
            }
            if (typeof repos.primary === 'string' && !permitidos.has(repos.primary)) {
                push('/repos/primary', 'authority-invariant', 'el repo primario no está en `allowlist`');
            }
        }
    }

    if (errors.length) {
        throw new ConfigSchemaViolation(formatErrors(errors), errors, {
            archivo: file, via, causa: 'frontera-de-confianza',
        });
    }

    // (c) de la decisión: NUNCA silenciosa. Una vez por proceso, con nivel
    // `alerta`, para que la excepción se vea en el log de todo arranque en vez
    // de vivir sólo en un comentario.
    const key = `${REPOS_AUTHORITY_KEY}|${file}|${via}`;
    if (reposTrazado.has(key)) return;
    reposTrazado.add(key);
    emitTrace(
        'alerta',
        `[config-resolver] ALERTA autoridad: '${REPOS_AUTHORITY_KEY}' (frontera de ejecución de código) `
        + `vive en ${PRODUCT_CONFIG_FILE} por excepción de migración acotada a `
        + `[${REPOS_GRANDFATHERED_SUBKEYS.join(', ')}] — cierre en #4694. `
        + 'Su CONTENIDO no lo valida el chequeo de lado: la revisión del cambio es el control.',
        file,
        via,
    );
}

/**
 * CA-4 — una clave del lado equivocado falla el arranque nombrando la clave y el
 * archivo que le corresponde. Las dos direcciones, con el MISMO tratamiento.
 *
 * @param {object} doc
 * @param {'kernel'|'producto'} lado
 * @param {string} file
 * @param {string} via
 * @throws {ConfigSchemaViolation}
 */
function assertSide(doc, lado, file, via) {
    const { valid, errors } = checkSide(doc, lado);
    if (valid) return;
    throw new ConfigSchemaViolation(formatErrors(errors), errors, { archivo: file, via });
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
function resolveForDiff(input) {
    // #5174 · CA-2 — variante de DOS lados. La firma vieja (`string`) sigue viva
    // para `kernel-parity.js`, que compara revisiones git del `config.yaml`.
    // Post-partición «la configuración resuelta» ya no es un archivo, así que la
    // comparación de paridad necesita poder pedir el MERGE de los dos textos.
    if (input && typeof input === 'object' && !Array.isArray(input)) {
        return resolveMergedForDiff(input);
    }
    const text = input;
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

/**
 * #5174 · CA-2 — resuelve la configuración efectiva a partir de los DOS textos,
 * sin tocar el disco y sin fail-closed: es la vía de COMPARACIÓN, no la de
 * enforcement. `productText` ausente ⇒ modo monolito (pre-partición), que es
 * justo el lado izquierdo del diff de paridad.
 *
 * @param {{kernelText: string, productText?: string|null}} input
 * @returns {{valid: boolean, config: object|null, errors: Array<object>}}
 */
function resolveMergedForDiff(input) {
    const izq = resolveForDiff(input.kernelText);
    if (!izq.config) return izq;
    if (input.productText === undefined || input.productText === null) return izq;
    let manifest;
    try {
        manifest = JSON.parse(input.productText);
    } catch {
        return {
            valid: false,
            config: null,
            errors: [{ path: '/' + PRODUCT_FILENAME, keyword: 'json', detail: 'JSON inválido', lado: 'producto' }],
        };
    }
    const slice = esMapa(manifest) && esMapa(manifest[PRODUCT_CONFIG_KEY]) ? manifest[PRODUCT_CONFIG_KEY] : {};
    const merged = copyOf(mergeSides(izq.config, slice));
    const { valid, errors } = validateConfig(merged);
    return { valid, config: merged, errors };
}

// -----------------------------------------------------------------------------
// #5174 · CA-2 — snapshot REDACTADO de la configuración resuelta
// -----------------------------------------------------------------------------
//
// El dump de la configuración resuelta volcaría chat ids de operadores, paths de
// la máquina y endpoints. La salida es **path + tipo**, nunca el valor: alcanza
// para demostrar paridad clave por clave y no alcanza para filtrar nada.
//
// El tipo de las hojas escalares se incluye porque una migración que convierta
// `"30"` en `30` es exactamente el tipo de regresión que el CA-2 busca cazar.

const MAX_SNAPSHOT_DEPTH = 8;

function tipoDe(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return `array[${v.length}]`;
    return typeof v;
}

function walkSnapshot(node, segs, out) {
    if (segs.length > MAX_SNAPSHOT_DEPTH) return;
    for (const key of Object.keys(node).sort()) {
        const childSegs = segs.concat(key);
        const v = node[key];
        const dotted = childSegs.join('.');
        if (esMapa(v)) {
            out.push(`${dotted}: object(${Object.keys(v).length})`);
            walkSnapshot(v, childSegs, out);
        } else {
            out.push(`${dotted}: ${tipoDe(v)}`);
        }
    }
}

/**
 * @param {object} config - configuración resuelta.
 * @returns {string[]} líneas `path: tipo`, ordenadas y sin un solo valor.
 */
function snapshotForDiff(config) {
    if (!esMapa(config)) return [];
    const out = [];
    walkSnapshot(config, [], out);
    return out;
}

module.exports = {
    resolve,
    resolveForDiff,
    resolveMergedForDiff,
    snapshotForDiff,
    resolveConfigPath,
    resolveConfigPaths,
    productPathFor,
    PRODUCT_FILENAME,
    PRODUCT_CONFIG_KEY,
    // #5174 rev-1 · REQ-SEC-C2 / CA-8 — la forma cerrada del manifiesto y la
    // excepción de migración de la frontera de confianza. Se exportan para que
    // el test itere sobre las listas congeladas en vez de duplicarlas: una
    // clave nueva queda cubierta el día que se agrega.
    MANIFEST_KEYS,
    REPOS_AUTHORITY_KEY,
    REPOS_GRANDFATHERED_SUBKEYS,
    PARTITION_ENABLED,
    FORBIDDEN_KEYS,
    ENV_AUTHORITY_GRANDFATHERED,
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

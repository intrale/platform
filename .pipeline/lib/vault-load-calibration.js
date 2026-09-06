'use strict';

/**
 * #5805 — Corrida de calibración del tráfico físico del vault: preflight de
 * integración, orquestación de la carga y publicación del artefacto de evidencia.
 *
 * Qué ES este módulo:
 *   - `preflightIntegrations()`: verificación fail-closed de que el HEAD que va a
 *     medirse integra realmente los commits de las dependencias declaradas y de
 *     que el árbol de trabajo está limpio (si no, el SHA no describe el código
 *     que corrió).
 *   - `buildCalibrationEvidence()`: proyección CAMPO A CAMPO (nunca por spread)
 *     de la evidencia publicable, con pico y extrapolación derivados
 *     exclusivamente de la categoría física.
 *   - `publishCalibrationArtifact()`: escritura atómica `tmp + rename` con
 *     permisos mínimos sobre un nombre de archivo FIJO en código.
 *   - `runCalibration()`: orquestador. Preflight → identidad de sólo lectura →
 *     runner de #5804 → evidencia → publicación.
 *
 * Qué NO es:
 *   - no reimplementa la instrumentación del vault (#5803: el enum
 *     `VAULT_TELEMETRY_CATEGORIES` y el emisor viven en `secret-vault.js` y acá
 *     se IMPORTAN),
 *   - no reimplementa el núcleo ni el runner de escenarios (#5804:
 *     `runScenario` entra por `require` y sus puertos por inyección),
 *   - no toca `Date.now()`, `Math.random()`, `child_process` ni `process.env`:
 *     `git`, `fs`, `crypto`, `clock` y `driver` son parámetros. El cableado real
 *     vive en `.pipeline/scripts/run-vault-calibration.js`.
 *
 * Nota sobre la superficie exportada: la receta de pre-admisión previó cuatro
 * funciones. Se exportan además `LOAD_CALIBRATION_ERROR_CODES` (el CA-7 exige un
 * código de error ESTABLE que el consumidor discrimine sin parsear texto —
 * escribir los literales en el CLI y en los tests sería la segunda fuente de
 * verdad que el enum viene a evitar), `ARTIFACT_FILENAME`, `GIT_ENV_ALLOWLIST`,
 * `buildAllowlistedEnv` y `createGitPort` (el test obligatorio «el env del
 * proceso hijo contiene sólo las variables allowlisted» prueba justamente esa
 * construcción, y el wrapper CLI no puede alojarla porque tiene prohibida la
 * lógica de negocio). Ninguna de esas cinco agrega comportamiento nuevo.
 */

const path = require('path');

const { VAULT_TELEMETRY_CATEGORIES } = require('./secret-vault');
const { redactDeep } = require('./kernel-table-verify');
const {
    CALIBRATION_LIMITS,
    CalibrationError,
    runScenario,
} = require('./vault-calibration-scenario');

// -----------------------------------------------------------------------------
// Vocabulario importado — una sola fuente de verdad (#5803)
// -----------------------------------------------------------------------------

const CATEGORIES = VAULT_TELEMETRY_CATEGORIES;

if (!Array.isArray(CATEGORIES) || CATEGORIES.length === 0
    || !CATEGORIES.every((c) => typeof c === 'string' && c.length > 0)) {
    // Fail-closed en tiempo de carga: sin vocabulario no hay métrica posible.
    throw new Error('LOAD_CALIBRATION_TELEMETRY_VOCABULARY_INVALID');
}

/** Categoría de lectura física: por contrato del enum, el primer elemento. */
const PHYSICAL_CATEGORY = CATEGORIES[0];

// -----------------------------------------------------------------------------
// Contrato público
// -----------------------------------------------------------------------------

/** Nombre FIJO del artefacto. Nunca se deriva de input externo (CA-4). */
const ARTIFACT_FILENAME = 'vault-load-calibration.json';

/** Prefijo de los temporales propios. Se usa también para limpiarlos. */
const TMP_PREFIX = `.${ARTIFACT_FILENAME}.`;
const TMP_SUFFIX = '.tmp';

const EVIDENCE_SCHEMA_VERSION = 1;

/**
 * Códigos de error ESTABLES (CA-7). El operador y los wrappers discriminan por
 * `code`; el texto para humanos se agrega recién en el borde (el CLI).
 */
const LOAD_CALIBRATION_ERROR_CODES = Object.freeze({
    // --- preflight ---
    GIT_PORT_MISSING: 'LOAD_CALIBRATION_GIT_PORT_MISSING',
    REQUIRED_COMMITS_INVALID: 'LOAD_CALIBRATION_REQUIRED_COMMITS_INVALID',
    HEAD_UNRESOLVED: 'LOAD_CALIBRATION_HEAD_UNRESOLVED',
    WORKTREE_DIRTY: 'LOAD_CALIBRATION_WORKTREE_DIRTY',
    INTEGRATION_UNRESOLVED: 'LOAD_CALIBRATION_INTEGRATION_UNRESOLVED',
    INTEGRATION_MISSING: 'LOAD_CALIBRATION_INTEGRATION_MISSING',
    // --- identidad ---
    IDENTITY_INVALID: 'LOAD_CALIBRATION_IDENTITY_INVALID',
    IDENTITY_NOT_READ_ONLY: 'LOAD_CALIBRATION_IDENTITY_NOT_READ_ONLY',
    IDENTITY_SCOPES_EXCESIVOS: 'LOAD_CALIBRATION_IDENTITY_SCOPES_EXCESIVOS',
    // --- evidencia ---
    PREFLIGHT_INVALID: 'LOAD_CALIBRATION_PREFLIGHT_INVALID',
    WINDOW_INVALID: 'LOAD_CALIBRATION_WINDOW_INVALID',
    COUNTERS_INVALID: 'LOAD_CALIBRATION_COUNTERS_INVALID',
    FORMULA_INVALID: 'LOAD_CALIBRATION_FORMULA_INVALID',
    UNKNOWN_FIELD: 'LOAD_CALIBRATION_UNKNOWN_FIELD',
    SCOPE_INVALID: 'LOAD_CALIBRATION_SCOPE_INVALID',
    NON_FINITE_RESULT: 'LOAD_CALIBRATION_NON_FINITE_RESULT',
    UNSAFE_INTEGER_RESULT: 'LOAD_CALIBRATION_UNSAFE_INTEGER_RESULT',
    EVIDENCE_NOT_CLEAN: 'LOAD_CALIBRATION_EVIDENCE_NOT_CLEAN',
    // --- publicación ---
    ARTIFACT_DIR_INVALID: 'LOAD_CALIBRATION_ARTIFACT_DIR_INVALID',
    ARTIFACT_WRITE_FAILED: 'LOAD_CALIBRATION_ARTIFACT_WRITE_FAILED',
    // --- orquestación ---
    PORT_MISSING: 'LOAD_CALIBRATION_PORT_MISSING',
    RUNNER_FAILED: 'LOAD_CALIBRATION_RUNNER_FAILED',
    RUNNER_RESULT_INVALID: 'LOAD_CALIBRATION_RUNNER_RESULT_INVALID',
});

/**
 * Horizontes de extrapolación soportados. Enum CERRADO: un valor fuera de esta
 * lista falla, nunca cae a un default. `MONTH_MS` se importa de #5804 para que
 * la constante temporal viva en un solo lugar.
 */
const EXTRAPOLATION_HORIZONS = Object.freeze({
    month: CALIBRATION_LIMITS.MONTH_MS,
});

/** Única familia de fórmula soportada. Sin `eval`, sin expresiones del usuario. */
const FORMULA_KIND = 'ceil_rate_extrapolation';

/** Milisegundos de la unidad de pico publicada. */
const MINUTE_MS = 60000;

/**
 * Variables de ambiente que puede heredar el proceso hijo `git` (requisito 3 de
 * Security). Es una ALLOWLIST: nunca `{ ...process.env }`. Un canario que viva
 * en el ambiente del padre no puede viajar al hijo ni volver en su salida.
 */
const GIT_ENV_ALLOWLIST = Object.freeze([
    'PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir',
    'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL',
]);

/** Claves aceptadas en cada entrada de `requiredCommits`. Enum cerrado. */
const REQUIRED_COMMIT_KEYS = Object.freeze(['issue', 'commit']);
/** Claves aceptadas en `window`. Enum cerrado. */
const WINDOW_KEYS = Object.freeze([
    'started_at', 'duration_ms', 'concurrency', 'launches',
    'distribution', 'bucket_ms', 'peak_physical_reads_per_bucket', 'scope_logico',
]);
/** Claves aceptadas en `formula`. Enum cerrado. */
const FORMULA_KEYS = Object.freeze(['kind', 'horizon']);
/** Claves aceptadas en `preflight`. Enum cerrado. */
const PREFLIGHT_KEYS = Object.freeze(['head', 'integrated']);

const SHA_FULL_RE = /^[0-9a-f]{40}$/;
/** Referencia de commit admitida como ENTRADA: hex corto o completo, minúscula. */
const COMMIT_REF_RE = /^[0-9a-f]{7,40}$/;
/** Nombre lógico: por construcción no puede ser un ARN, un path ni un account id. */
const LOGICAL_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;
/** ISO8601 UTC estricto con milisegundos. */
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** Nombre de campo publicable en `detail`: mismo contrato que #5804. */
const FIELD_NAME_RE = /^[A-Za-z0-9_]{1,64}$/;

const MAX_REQUIRED_COMMITS = 32;
const MAX_ISSUE_NUMBER = 100000000;
/** Métodos cuyo prefijo delata capacidad de ESCRITURA en un driver o identidad. */
const WRITE_METHOD_RE = /^(put|set|write|delete|remove|create|update|rotate|provision)/i;

/**
 * Patrones PROHIBIDOS en cualquier string del artefacto (CA-4). Acá no se
 * redacta: se FALLA. La garantía primaria ya la dio la proyección por allowlist,
 * así que un match significa que la allowlist tiene un bug — y publicar una
 * evidencia "casi limpia" es peor que no publicar ninguna.
 */
const FORBIDDEN_PATTERNS = Object.freeze([
    { name: 'arn', re: /arn:/i },
    { name: 'account_id', re: /\b\d{12}\b/ },
    { name: 'aws_access_key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
    { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}/ },
    { name: 'api_key', re: /\b(?:sk-|gsk_|xox[baprs]-|ghp_|github_pat_)[A-Za-z0-9_-]{10,}/ },
    { name: 'pem', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
    { name: 'env_dump', re: /(?:^|[\s,{"'])[A-Z][A-Z0-9_]{3,}=/ },
    { name: 'windows_path', re: /(?:^|[\s,{"'=(])[A-Za-z]:[\\/]/ },
    { name: 'posix_path', re: /(?:^|[\s,{"'=(])\/(?:home|Users|root|mnt|var|tmp|opt|etc|proc)\// },
]);

// -----------------------------------------------------------------------------
// Errores — se REUSA `CalibrationError` de #5804: su `detail` ya está proyectado
// por allowlist (sólo nombres de campo, índices y topes) y su `message` es el
// propio `code`, así que ningún canario puede viajar por el camino de excepción.
// -----------------------------------------------------------------------------

function fail(code, detail) {
    throw new CalibrationError(code, detail);
}

/** Nombre de campo seguro para `detail`: un input nunca se publica crudo. */
function campo(nombre) {
    return typeof nombre === 'string' && FIELD_NAME_RE.test(nombre) ? nombre : 'unsafe';
}

// -----------------------------------------------------------------------------
// Primitivas
// -----------------------------------------------------------------------------

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertOnlyKnownKeys(input, known, code) {
    for (const key of Object.keys(input)) {
        if (!known.includes(key)) fail(code, { field: campo(key) });
    }
    // Herencia peligrosa: se chequea con `hasOwnProperty`, nunca con `in`.
    for (const key of ['__proto__', 'constructor', 'prototype']) {
        if (Object.prototype.hasOwnProperty.call(input, key)) fail(code, { field: campo(key) });
    }
}

function requireEnteroEnRango(value, min, max, field, code) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        fail(code, { field: campo(field), kind: typeof value });
    }
    if (value < min || value > max) fail(code, { field: campo(field), limit: max });
    return value;
}

function requireStringConForma(value, re, field, code) {
    if (typeof value !== 'string') fail(code, { field: campo(field), kind: typeof value });
    if (!re.test(value)) fail(code, { field: campo(field) });
    return value;
}

/** Redondeo half-up determinístico a 6 decimales. */
function round6(x, field) {
    if (!Number.isFinite(x)) fail(LOAD_CALIBRATION_ERROR_CODES.NON_FINITE_RESULT, { field: campo(field) });
    return Math.round(x * 1e6) / 1e6;
}

function deepFreeze(value) {
    if (Array.isArray(value)) {
        for (const item of value) deepFreeze(item);
        return Object.freeze(value);
    }
    if (value !== null && typeof value === 'object') {
        for (const key of Object.keys(value)) deepFreeze(value[key]);
        return Object.freeze(value);
    }
    return value;
}

// -----------------------------------------------------------------------------
// Env allowlisted del proceso hijo (requisito 3 de Security)
// -----------------------------------------------------------------------------

/**
 * Proyecta un ambiente por ALLOWLIST explícita. Nunca hace spread del ambiente
 * del padre: lo que no está en `GIT_ENV_ALLOWLIST` no existe para el hijo.
 *
 * @param {object} [env] ambiente de origen (por default, ninguno)
 * @returns {Readonly<object>}
 */
function buildAllowlistedEnv(env) {
    const origen = isPlainObject(env) ? env : {};
    const out = Object.create(null);
    for (const nombre of GIT_ENV_ALLOWLIST) {
        if (!Object.prototype.hasOwnProperty.call(origen, nombre)) continue;
        const valor = origen[nombre];
        if (typeof valor !== 'string') continue;   // sólo strings: nada de objetos heredados
        out[nombre] = valor;
    }
    // `Object.assign({}, ...)` para devolver un objeto plano con prototipo nulo
    // ya congelado: el consumidor no puede agregarle una variable después.
    return Object.freeze(out);
}

/**
 * Construye el puerto `git(argv)` del preflight sobre un `execFileSync`
 * inyectado. Los argumentos viajan como ARRAY: nunca hay una shell, así que un
 * valor con forma de comando no puede convertirse en uno.
 *
 * @param {object} deps
 * @param {function} deps.execFileSync `(file, args, opts) -> string|Buffer`
 * @param {string}   deps.cwd          directorio del repo a inspeccionar
 * @param {object}   [deps.env]        ambiente de origen a proyectar por allowlist
 * @returns {function(string[]): string}
 */
function createGitPort({ execFileSync, cwd, env } = {}) {
    if (typeof execFileSync !== 'function') {
        fail(LOAD_CALIBRATION_ERROR_CODES.GIT_PORT_MISSING, { field: 'execFileSync' });
    }
    if (typeof cwd !== 'string' || cwd.length === 0) {
        fail(LOAD_CALIBRATION_ERROR_CODES.GIT_PORT_MISSING, { field: 'cwd' });
    }
    const childEnv = buildAllowlistedEnv(env);

    return function git(argv) {
        if (!Array.isArray(argv) || argv.some((a) => typeof a !== 'string')) {
            fail(LOAD_CALIBRATION_ERROR_CODES.GIT_PORT_MISSING, { field: 'argv' });
        }
        const salida = execFileSync('git', argv, {
            cwd,
            env: { ...childEnv },
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],   // stderr NO se captura: puede traer paths
            windowsHide: true,
        });
        return typeof salida === 'string' ? salida : String(salida == null ? '' : salida);
    };
}

// -----------------------------------------------------------------------------
// 1 · preflightIntegrations (CA-1 / CA-7)
// -----------------------------------------------------------------------------

function validarRequiredCommits(requiredCommits) {
    const C = LOAD_CALIBRATION_ERROR_CODES;
    if (!Array.isArray(requiredCommits) || requiredCommits.length === 0) {
        fail(C.REQUIRED_COMMITS_INVALID, { field: 'requiredCommits', kind: typeof requiredCommits });
    }
    if (requiredCommits.length > MAX_REQUIRED_COMMITS) {
        fail(C.REQUIRED_COMMITS_INVALID, { field: 'requiredCommits', limit: MAX_REQUIRED_COMMITS });
    }
    const vistos = new Set();
    return requiredCommits.map((entrada, index) => {
        if (!isPlainObject(entrada)) {
            fail(C.REQUIRED_COMMITS_INVALID, { index, kind: typeof entrada });
        }
        assertOnlyKnownKeys(entrada, REQUIRED_COMMIT_KEYS, C.REQUIRED_COMMITS_INVALID);
        const issue = requireEnteroEnRango(entrada.issue, 1, MAX_ISSUE_NUMBER, 'issue', C.REQUIRED_COMMITS_INVALID);
        if (vistos.has(issue)) fail(C.REQUIRED_COMMITS_INVALID, { field: 'issue', index });
        vistos.add(issue);
        // La referencia se valida ANTES de llegar a `git`: un valor con forma de
        // flag (`--upload-pack=...`) o de ruta no puede alcanzar el proceso hijo.
        const commit = requireStringConForma(entrada.commit, COMMIT_REF_RE, 'commit', C.REQUIRED_COMMITS_INVALID);
        return { issue, commit };
    });
}

/**
 * Verifica, ANTES de la primera lectura física, que el HEAD que se va a medir
 * integra los commits declarados y que el árbol está limpio. Falla cerrado ante
 * ausencia, ambigüedad, SHA no resoluble o worktree sucio.
 *
 * @param {{git: function(string[]): string, requiredCommits: Array<{issue:number,commit:string}>}} deps
 * @returns {Readonly<{head:string, integrated:ReadonlyArray<{issue:number,commit:string}>}>}
 * @throws {CalibrationError}
 */
function preflightIntegrations({ git, requiredCommits } = {}) {
    const C = LOAD_CALIBRATION_ERROR_CODES;
    if (typeof git !== 'function') fail(C.GIT_PORT_MISSING, { field: 'git', kind: typeof git });

    const pedidos = validarRequiredCommits(requiredCommits);

    // 1. HEAD. Un HEAD no resoluble (repo sin commits, detached roto) es fallo
    //    terminal: sin SHA no hay procedencia y la medición no sería atribuible.
    let headRaw;
    try {
        headRaw = git(['rev-parse', 'HEAD']);
    } catch (err) {
        // El error ajeno se DESCARTA entero: su `message` suele traer el path
        // absoluto del repo y el stderr de git.
        fail(C.HEAD_UNRESOLVED, { field: 'head' });
    }
    const head = typeof headRaw === 'string' ? headRaw.trim() : '';
    if (!SHA_FULL_RE.test(head)) fail(C.HEAD_UNRESOLVED, { field: 'head' });

    // 2. Árbol limpio. Sin esto el SHA registrado NO describe el código que
    //    corrió (riesgo #3 de guru) y toda la evidencia queda no reproducible.
    let estado;
    try {
        estado = git(['status', '--porcelain']);
    } catch (err) {
        fail(C.WORKTREE_DIRTY, { field: 'worktree' });
    }
    if (typeof estado !== 'string' || estado.trim() !== '') {
        // NO se publica QUÉ archivo está sucio: un path es dato sensible (CA-4).
        fail(C.WORKTREE_DIRTY, { field: 'worktree' });
    }

    // 3. Integración de cada dependencia. El `field` nombra el issue para que el
    //    operador sepa QUÉ destrabar sin leer el código fuente (CA-7).
    const integrated = pedidos.map(({ issue, commit }) => {
        const field = `issue_${issue}`;
        let shaRaw;
        try {
            // `^{commit}` fuerza a que la referencia sea un commit y hace que una
            // abreviatura ambigua falle en vez de elegir una al azar.
            shaRaw = git(['rev-parse', '--verify', '--end-of-options', `${commit}^{commit}`]);
        } catch (err) {
            fail(C.INTEGRATION_UNRESOLVED, { field });
        }
        const sha = typeof shaRaw === 'string' ? shaRaw.trim() : '';
        if (!SHA_FULL_RE.test(sha)) fail(C.INTEGRATION_UNRESOLVED, { field });

        try {
            // exit 0 ⇒ es ancestro. Cualquier otra cosa (exit 1 o error) ⇒ no
            // está integrado en este HEAD.
            git(['merge-base', '--is-ancestor', sha, head]);
        } catch (err) {
            fail(C.INTEGRATION_MISSING, { field });
        }
        return { issue, commit: sha };
    });

    return deepFreeze({ head, integrated });
}

// -----------------------------------------------------------------------------
// 2 · Identidad de sólo lectura con scopes mínimos (requisito 2 de Security)
// -----------------------------------------------------------------------------

/**
 * Verifica que la corrida se ejecute con una identidad de SÓLO LECTURA acotada
 * exactamente al scope del escenario. Fail-closed: sin la declaración explícita
 * `read_only: true` no se mide.
 *
 * @param {{identity:object, driver:function, scopeLogico:string}} args
 */
function assertReadOnlyIdentity({ identity, driver, scopeLogico }) {
    const C = LOAD_CALIBRATION_ERROR_CODES;
    if (!isPlainObject(identity)) {
        fail(C.IDENTITY_INVALID, { field: 'identity', kind: typeof identity });
    }
    assertOnlyKnownKeys(identity, ['read_only', 'scopes'], C.IDENTITY_INVALID);
    if (identity.read_only !== true) {
        // Sólo el booleano exacto habilita: un `'true'` string o un truthy
        // cualquiera es configuración ambigua, y acá se falla cerrado.
        fail(C.IDENTITY_NOT_READ_ONLY, { field: 'read_only', kind: typeof identity.read_only });
    }
    if (!Array.isArray(identity.scopes) || identity.scopes.length !== 1) {
        // Scopes MÍNIMOS: el escenario mide un scope, la identidad tiene ese y
        // nada más. Cualquier scope de más es privilegio que no se justifica.
        fail(C.IDENTITY_SCOPES_EXCESIVOS, { field: 'scopes' });
    }
    const declarado = requireStringConForma(identity.scopes[0], LOGICAL_NAME_RE, 'scopes', C.IDENTITY_INVALID);
    if (declarado !== scopeLogico) {
        fail(C.IDENTITY_SCOPES_EXCESIVOS, { field: 'scopes' });
    }
    // El driver es lo que efectivamente toca el vault: si expone un verbo de
    // escritura, la identidad de sólo lectura es una declaración vacía. Se
    // inspecciona también cuando es una función, porque un driver puede ser
    // invocable y traer los verbos colgados como propiedades.
    if (driver && (typeof driver === 'object' || typeof driver === 'function')) {
        for (const clave of Object.keys(driver)) {
            if (WRITE_METHOD_RE.test(clave)) {
                fail(C.IDENTITY_NOT_READ_ONLY, { field: campo(clave) });
            }
        }
    }
}

// -----------------------------------------------------------------------------
// 3 · buildCalibrationEvidence (CA-2 / CA-3 / CA-4 / CA-5)
// -----------------------------------------------------------------------------

/**
 * Los contadores tienen que cubrir el enum COMPLETO y sólo el enum: una clave de
 * menos esconde una vía de resolución, y una de más es una categoría inventada
 * que inflaría el total sin que nadie la reclame.
 */
function assertCountersExclusivos(counters) {
    const C = LOAD_CALIBRATION_ERROR_CODES;
    if (!isPlainObject(counters)) {
        fail(C.COUNTERS_INVALID, { field: 'counters', kind: typeof counters });
    }
    assertOnlyKnownKeys(counters, CATEGORIES, C.COUNTERS_INVALID);
    for (const categoria of CATEGORIES) {
        if (!Object.prototype.hasOwnProperty.call(counters, categoria)) {
            fail(C.COUNTERS_INVALID, { field: campo(categoria) });
        }
        const valor = counters[categoria];
        if (typeof valor !== 'number' || !Number.isSafeInteger(valor) || valor < 0) {
            // Fracción, NaN, Infinity o negativo son ERROR: redondear en silencio
            // produciría un pico plausible sacado de un dato roto.
            fail(C.COUNTERS_INVALID, { field: campo(categoria), kind: typeof valor });
        }
    }
    return CATEGORIES.reduce((acc, categoria) => acc + counters[categoria], 0);
}

function validarPreflight(preflight) {
    const C = LOAD_CALIBRATION_ERROR_CODES;
    if (!isPlainObject(preflight)) {
        fail(C.PREFLIGHT_INVALID, { field: 'preflight', kind: typeof preflight });
    }
    assertOnlyKnownKeys(preflight, PREFLIGHT_KEYS, C.PREFLIGHT_INVALID);
    const head = requireStringConForma(preflight.head, SHA_FULL_RE, 'head', C.PREFLIGHT_INVALID);
    if (!Array.isArray(preflight.integrated) || preflight.integrated.length === 0) {
        fail(C.PREFLIGHT_INVALID, { field: 'integrated' });
    }
    if (preflight.integrated.length > MAX_REQUIRED_COMMITS) {
        fail(C.PREFLIGHT_INVALID, { field: 'integrated', limit: MAX_REQUIRED_COMMITS });
    }
    const integrated = preflight.integrated.map((entrada, index) => {
        if (!isPlainObject(entrada)) fail(C.PREFLIGHT_INVALID, { index, kind: typeof entrada });
        assertOnlyKnownKeys(entrada, REQUIRED_COMMIT_KEYS, C.PREFLIGHT_INVALID);
        return {
            issue: requireEnteroEnRango(entrada.issue, 1, MAX_ISSUE_NUMBER, 'issue', C.PREFLIGHT_INVALID),
            // Ya resuelto por el preflight: acá se exige el SHA COMPLETO.
            commit: requireStringConForma(entrada.commit, SHA_FULL_RE, 'commit', C.PREFLIGHT_INVALID),
        };
    });
    return { head, integrated };
}

function validarWindow(window) {
    const C = LOAD_CALIBRATION_ERROR_CODES;
    if (!isPlainObject(window)) fail(C.WINDOW_INVALID, { field: 'window', kind: typeof window });
    assertOnlyKnownKeys(window, WINDOW_KEYS, C.WINDOW_INVALID);

    const out = {
        started_at: requireStringConForma(window.started_at, ISO_UTC_RE, 'started_at', C.WINDOW_INVALID),
        duration_ms: requireEnteroEnRango(
            window.duration_ms,
            CALIBRATION_LIMITS.MIN_WINDOW_MS, CALIBRATION_LIMITS.MAX_WINDOW_MS,
            'duration_ms', C.WINDOW_INVALID,
        ),
        bucket_ms: requireEnteroEnRango(
            window.bucket_ms,
            CALIBRATION_LIMITS.MIN_BUCKET_MS, CALIBRATION_LIMITS.MAX_BUCKET_MS,
            'bucket_ms', C.WINDOW_INVALID,
        ),
        concurrency: requireEnteroEnRango(
            window.concurrency, 1, CALIBRATION_LIMITS.MAX_CONCURRENCY, 'concurrency', C.WINDOW_INVALID,
        ),
        launches: requireEnteroEnRango(
            window.launches, 1, CALIBRATION_LIMITS.MAX_LAUNCHES, 'launches', C.WINDOW_INVALID,
        ),
        distribution: requireStringConForma(
            window.distribution, LOGICAL_NAME_RE, 'distribution', C.WINDOW_INVALID,
        ),
        peak_physical_reads_per_bucket: requireEnteroEnRango(
            window.peak_physical_reads_per_bucket, 0, CALIBRATION_LIMITS.MAX_EVENTS,
            'peak_physical_reads_per_bucket', C.WINDOW_INVALID,
        ),
        // Nombre LÓGICO. La forma del regex es la que garantiza que un ARN, un
        // account id o un nombre de secreto no puedan pasar por acá (CA-4).
        scope_logico: requireStringConForma(
            window.scope_logico, LOGICAL_NAME_RE, 'scope_logico', C.SCOPE_INVALID,
        ),
    };
    if (out.duration_ms % out.bucket_ms !== 0) {
        fail(C.WINDOW_INVALID, { field: 'bucket_ms' });
    }
    return out;
}

function validarFormula(formula) {
    const C = LOAD_CALIBRATION_ERROR_CODES;
    if (!isPlainObject(formula)) fail(C.FORMULA_INVALID, { field: 'formula', kind: typeof formula });
    assertOnlyKnownKeys(formula, FORMULA_KEYS, C.FORMULA_INVALID);
    if (formula.kind !== FORMULA_KIND) fail(C.FORMULA_INVALID, { field: 'kind' });
    const horizon = formula.horizon;
    if (typeof horizon !== 'string'
        || !Object.prototype.hasOwnProperty.call(EXTRAPOLATION_HORIZONS, horizon)) {
        // Enum CERRADO: no se acepta un `horizon_ms` arbitrario del caller, que
        // sería la puerta para publicar una extrapolación a medida.
        fail(C.FORMULA_INVALID, { field: 'horizon' });
    }
    return { kind: FORMULA_KIND, horizon, horizon_ms: EXTRAPOLATION_HORIZONS[horizon] };
}

/** Falla si algún string del artefacto matchea un patrón prohibido (CA-4). */
function assertSinPatronesProhibidos(value, ruta) {
    if (typeof value === 'string') {
        for (const { name, re } of FORBIDDEN_PATTERNS) {
            if (re.test(value)) {
                fail(LOAD_CALIBRATION_ERROR_CODES.EVIDENCE_NOT_CLEAN, { field: campo(name) });
            }
        }
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) assertSinPatronesProhibidos(item, ruta);
        return;
    }
    if (value !== null && typeof value === 'object') {
        for (const key of Object.keys(value)) {
            // La CLAVE también es superficie: un canario puede llegar como nombre.
            assertSinPatronesProhibidos(key, ruta);
            assertSinPatronesProhibidos(value[key], ruta);
        }
        return;
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
        fail(LOAD_CALIBRATION_ERROR_CODES.NON_FINITE_RESULT, { field: campo(ruta) });
    }
}

/**
 * Construye la evidencia publicable CAMPO A CAMPO. Prohibido `spread` /
 * `Object.assign` sobre el input: la garantía primaria del CA-4 es esta
 * proyección por allowlist; la redacción por patrón es la capa de atrás.
 *
 * Pico y extrapolación se derivan EXCLUSIVAMENTE de la categoría física: variar
 * `cache_hit` o `single_flight_join` no puede mover ninguno de los dos (CA-3).
 *
 * @param {{preflight:object, window:object, counters:object, formula:object}} args
 * @returns {Readonly<object>}
 * @throws {CalibrationError}
 */
function buildCalibrationEvidence({ preflight, window, counters, formula } = {}) {
    const C = LOAD_CALIBRATION_ERROR_CODES;
    const p = validarPreflight(preflight);
    const w = validarWindow(window);
    const f = validarFormula(formula);
    const totalResoluciones = assertCountersExclusivos(counters);

    const fisicas = counters[PHYSICAL_CATEGORY];

    // Pico: se escala el bucket físico más cargado a una tasa por minuto. El
    // insumo es el conteo físico por bucket, así que ninguna otra categoría
    // participa del número.
    const pico = round6(
        (w.peak_physical_reads_per_bucket * MINUTE_MS) / w.bucket_ms,
        'peak_physical_reads_per_minute',
    );

    // Extrapolación: `ceil` (conservador — no se subdimensiona la cuota). El
    // numerador se chequea ANTES de dividir porque un overflow silencioso sería
    // una calibración engañosa con apariencia válida.
    const numerador = fisicas * f.horizon_ms;
    if (!Number.isSafeInteger(numerador)) {
        fail(C.UNSAFE_INTEGER_RESULT, { field: 'monthly_extrapolation' });
    }
    const crudo = numerador / w.duration_ms;
    if (!Number.isFinite(crudo)) fail(C.NON_FINITE_RESULT, { field: 'monthly_extrapolation' });
    const extrapolacion = Math.ceil(crudo);
    if (!Number.isSafeInteger(extrapolacion)) {
        fail(C.UNSAFE_INTEGER_RESULT, { field: 'monthly_extrapolation' });
    }

    // La expresión se ARMA desde el enum importado: escribir el literal de la
    // categoría acá sería la segunda fuente de verdad que #5803 vino a cerrar.
    const expression = `monthly_extrapolation = ceil(${PHYSICAL_CATEGORY} * horizon_ms / window_duration_ms)`;
    const substitution = `ceil(${fisicas} * ${f.horizon_ms} / ${w.duration_ms})`;

    const counts = {};
    for (const categoria of CATEGORIES) counts[categoria] = counters[categoria];
    counts.total_resolutions = totalResoluciones;

    const evidence = {
        schema_version: EVIDENCE_SCHEMA_VERSION,
        head_sha: p.head,
        integrated_commits: p.integrated.map((i) => ({ issue: i.issue, commit: i.commit })),
        window: {
            started_at: w.started_at,
            duration_ms: w.duration_ms,
            concurrency: w.concurrency,
            launches: w.launches,
            distribution: w.distribution,
            bucket_ms: w.bucket_ms,
        },
        counts,
        // Rótulo explícito de qué categorías NO alimentan las métricas físicas:
        // sin él, un cero no se distingue de "se perdió el dato".
        excluded_from_physical_metrics: CATEGORIES.filter((c) => c !== PHYSICAL_CATEGORY),
        peak_physical_reads_per_minute: pico,
        peak_unit: `${PHYSICAL_CATEGORY}/minute`,
        peak_basis: {
            physical_reads_per_bucket: w.peak_physical_reads_per_bucket,
            bucket_ms: w.bucket_ms,
        },
        monthly_extrapolation: extrapolacion,
        formula: {
            kind: f.kind,
            expression,
            params: {
                [PHYSICAL_CATEGORY]: fisicas,
                horizon_ms: f.horizon_ms,
                window_duration_ms: w.duration_ms,
            },
            substitution,
            unit: `${PHYSICAL_CATEGORY}/${f.horizon}`,
            rounding: 'ceil',
        },
        scope_logico: w.scope_logico,
    };

    // Última barrera antes de que el objeto exista para el caller: si un string
    // matchea un patrón prohibido, la allowlist tiene un bug y NO se publica.
    assertSinPatronesProhibidos(evidence, 'evidence');

    // Defensa en profundidad: si la redacción por patrón cambia UN byte, algo se
    // coló pese a la proyección. Se falla cerrado en vez de publicar redactado.
    const redactada = redactDeep(evidence);
    if (JSON.stringify(redactada) !== JSON.stringify(evidence)) {
        fail(C.EVIDENCE_NOT_CLEAN, { field: 'evidence' });
    }

    return deepFreeze(evidence);
}

// -----------------------------------------------------------------------------
// 4 · publishCalibrationArtifact (CA-1 / CA-4)
// -----------------------------------------------------------------------------

function validarDir(dir) {
    const C = LOAD_CALIBRATION_ERROR_CODES;
    if (typeof dir !== 'string' || dir.length === 0) {
        fail(C.ARTIFACT_DIR_INVALID, { field: 'dir', kind: typeof dir });
    }
    if (!path.isAbsolute(dir)) fail(C.ARTIFACT_DIR_INVALID, { field: 'dir' });
    // El nombre del archivo es fijo, así que no hay traversal posible por ahí;
    // este chequeo cubre el `dir`, que sí llega desde el borde.
    if (dir.split(/[\\/]/).includes('..')) fail(C.ARTIFACT_DIR_INVALID, { field: 'dir' });
    return dir;
}

/**
 * Borra el artefacto canónico y los temporales propios que hayan quedado. Se
 * invoca al ARRANCAR la corrida: una evidencia de otro HEAD conviviendo con una
 * corrida fallida es exactamente la confusión que el CA-1 prohíbe.
 *
 * Idempotente: un archivo ausente no es un error.
 */
function clearCalibrationArtifacts({ dir, fs }) {
    const objetivo = path.join(dir, ARTIFACT_FILENAME);
    try {
        fs.rmSync(objetivo, { force: true });
    } catch (err) { /* el artefacto no existía: estado deseado */ }

    let entradas = [];
    try {
        entradas = fs.readdirSync(dir);
    } catch (err) {
        return;   // el directorio todavía no existe: nada que limpiar
    }
    for (const nombre of entradas) {
        if (typeof nombre !== 'string') continue;
        if (!nombre.startsWith(TMP_PREFIX) || !nombre.endsWith(TMP_SUFFIX)) continue;
        try {
            fs.rmSync(path.join(dir, nombre), { force: true });
        } catch (err) { /* otro proceso lo borró primero: mismo estado final */ }
    }
}

/**
 * Publica el artefacto de forma ATÓMICA (`tmp` + `rename`) y con permisos
 * mínimos. El nombre del archivo está FIJO en código: no se deriva de ningún
 * input, así que no hay path traversal por el nombre.
 *
 * @param {{evidence:object, dir:string, fs:object, crypto:object}} args
 * @returns {Readonly<{path:string, filename:string, bytes:number}>}
 */
function publishCalibrationArtifact({ evidence, dir, fs, crypto } = {}) {
    const C = LOAD_CALIBRATION_ERROR_CODES;
    if (!fs || typeof fs.writeFileSync !== 'function' || typeof fs.renameSync !== 'function') {
        fail(C.PORT_MISSING, { field: 'fs' });
    }
    if (!crypto || typeof crypto.randomBytes !== 'function') {
        fail(C.PORT_MISSING, { field: 'crypto' });
    }
    if (!isPlainObject(evidence)) {
        fail(C.PREFLIGHT_INVALID, { field: 'evidence', kind: typeof evidence });
    }
    const destino = validarDir(dir);

    // Se revalida acá: `publishCalibrationArtifact` es exportada y podría
    // llamarse con una evidencia que no pasó por `buildCalibrationEvidence`.
    assertSinPatronesProhibidos(evidence, 'evidence');

    const archivo = path.join(destino, ARTIFACT_FILENAME);
    if (path.basename(archivo) !== ARTIFACT_FILENAME) {
        fail(C.ARTIFACT_DIR_INVALID, { field: 'dir' });
    }
    const tmp = path.join(
        destino,
        `${TMP_PREFIX}${process.pid}.${crypto.randomBytes(4).toString('hex')}${TMP_SUFFIX}`,
    );

    const cuerpo = `${JSON.stringify(evidence, null, 2)}\n`;
    try {
        if (typeof fs.mkdirSync === 'function') fs.mkdirSync(destino, { recursive: true });
        // `mode: 0o600` en la creación: el archivo nunca existe con permisos
        // amplios, ni siquiera por un instante.
        fs.writeFileSync(tmp, cuerpo, { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(tmp, archivo);   // publicación atómica, tras TODAS las validaciones
    } catch (err) {
        try {
            fs.rmSync(tmp, { force: true });
        } catch (e) { /* el tmp ya no estaba */ }
        // El error del filesystem se descarta: su `message` lleva el path absoluto.
        fail(C.ARTIFACT_WRITE_FAILED, { field: 'artifact' });
    }

    return Object.freeze({
        path: archivo,
        filename: ARTIFACT_FILENAME,
        bytes: Buffer.byteLength(cuerpo, 'utf8'),
    });
}

// -----------------------------------------------------------------------------
// 5 · runCalibration — orquestador
// -----------------------------------------------------------------------------

function msAIso(ms, field) {
    const fecha = new Date(ms);
    const iso = Number.isFinite(fecha.getTime()) ? fecha.toISOString() : '';
    if (!ISO_UTC_RE.test(iso)) {
        fail(LOAD_CALIBRATION_ERROR_CODES.WINDOW_INVALID, { field: campo(field) });
    }
    return iso;
}

/**
 * Orquesta la corrida completa:
 *   1. limpia el directorio de artefactos (una corrida fallida no puede dejar
 *      evidencia vieja que se confunda con la nueva — CA-1),
 *   2. preflight de integración fail-closed ANTES de tocar el driver,
 *   3. verificación de identidad de sólo lectura con scopes mínimos,
 *   4. runner de #5804 (`runScenario`) con el HEAD ya demostrado,
 *   5. evidencia por allowlist + publicación atómica.
 *
 * @param {object} deps
 * @param {function} deps.git             puerto `git(argv) -> string`
 * @param {Array}    deps.requiredCommits `[{issue, commit}]`
 * @param {object}   deps.scenario        escenario de #5804
 * @param {function} deps.clock           `() -> ms` (inyectado; nunca `Date.now()` acá)
 * @param {function} deps.driver          `(request) -> {category}`
 * @param {object}   deps.identity        `{read_only:true, scopes:[scopeLogico]}`
 * @param {string}   deps.scopeLogico     nombre lógico del scope medido
 * @param {object}   deps.formula         `{kind, horizon}`
 * @param {string}   deps.dir             directorio del artefacto (absoluto)
 * @param {object}   deps.fs
 * @param {object}   deps.crypto
 * @returns {Promise<Readonly<{evidence:object, artifact:object}>>}
 */
async function runCalibration(deps) {
    const C = LOAD_CALIBRATION_ERROR_CODES;
    if (!isPlainObject(deps)) fail(C.PORT_MISSING, { field: 'deps', kind: typeof deps });

    for (const puerto of ['git', 'clock', 'driver']) {
        if (typeof deps[puerto] !== 'function') {
            fail(C.PORT_MISSING, { field: campo(puerto), kind: typeof deps[puerto] });
        }
    }
    if (!deps.fs || typeof deps.fs.writeFileSync !== 'function') fail(C.PORT_MISSING, { field: 'fs' });
    if (!deps.crypto || typeof deps.crypto.randomBytes !== 'function') fail(C.PORT_MISSING, { field: 'crypto' });

    const dir = validarDir(deps.dir);
    const scopeLogico = requireStringConForma(
        deps.scopeLogico, LOGICAL_NAME_RE, 'scopeLogico', C.SCOPE_INVALID,
    );

    // 1. El directorio queda limpio ANTES de arrancar: si la corrida falla en
    //    cualquier punto de acá en adelante, no hay artefacto que confundir.
    clearCalibrationArtifacts({ dir, fs: deps.fs });

    // 2. Preflight. Ocurre antes de construir el vault y antes de la primera
    //    lectura física: un spy sobre el driver tiene que quedar en cero.
    const preflight = preflightIntegrations({ git: deps.git, requiredCommits: deps.requiredCommits });

    // 3. Identidad de sólo lectura acotada al scope del escenario.
    assertReadOnlyIdentity({ identity: deps.identity, driver: deps.driver, scopeLogico });

    // 4. Runner de #5804. El HEAD que sella la evidencia es EXACTAMENTE el que
    //    validó el preflight: `resolveHead` no vuelve a preguntarle a git.
    let scenarioEvidence;
    try {
        scenarioEvidence = await runScenario({
            scenario: deps.scenario,
            clock: deps.clock,
            driver: deps.driver,
            // El sink del runner se descarta: la evidencia publicable la arma y
            // la publica ESTE módulo, con su propia allowlist.
            sink: () => {},
            resolveHead: () => preflight.head,
        });
    } catch (err) {
        // Un `CalibrationError` del núcleo ya viene sanitizado: se propaga tal
        // cual para no perder su `code`. Cualquier otra excepción se descarta.
        if (err instanceof CalibrationError) throw err;
        fail(C.RUNNER_FAILED, { field: 'runner' });
    }

    if (!isPlainObject(scenarioEvidence) || !isPlainObject(scenarioEvidence.scenario)
        || !isPlainObject(scenarioEvidence.counts) || !isPlainObject(scenarioEvidence.peak)
        || !isPlainObject(scenarioEvidence.buckets)) {
        fail(C.RUNNER_RESULT_INVALID, { field: 'runner' });
    }

    const sc = scenarioEvidence.scenario;
    const counters = {};
    for (const categoria of CATEGORIES) counters[categoria] = scenarioEvidence.counts[categoria];

    const evidence = buildCalibrationEvidence({
        preflight,
        window: {
            started_at: msAIso(sc.window_start_ms, 'started_at'),
            duration_ms: sc.window_duration_ms,
            concurrency: sc.concurrency,
            launches: sc.launches,
            distribution: sc.distribution,
            bucket_ms: sc.bucket_ms,
            peak_physical_reads_per_bucket: scenarioEvidence.peak.reads_per_bucket,
            scope_logico: scopeLogico,
        },
        counters,
        formula: isPlainObject(deps.formula) ? deps.formula : { kind: FORMULA_KIND, horizon: 'month' },
    });

    // 5. Publicación atómica: el último paso, después de todas las validaciones.
    const artifact = publishCalibrationArtifact({
        evidence, dir, fs: deps.fs, crypto: deps.crypto,
    });

    return Object.freeze({ evidence, artifact });
}

module.exports = {
    // Las cuatro funciones del contrato.
    preflightIntegrations,
    buildCalibrationEvidence,
    publishCalibrationArtifact,
    runCalibration,
    // Vocabulario y construcción de puertos (ver nota de superficie arriba).
    LOAD_CALIBRATION_ERROR_CODES,
    ARTIFACT_FILENAME,
    GIT_ENV_ALLOWLIST,
    buildAllowlistedEnv,
    createGitPort,
};

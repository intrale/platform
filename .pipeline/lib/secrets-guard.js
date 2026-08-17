// =============================================================================
// secrets-guard.js — guard de ORIGEN de credenciales, fail-closed (#5245, TRAMO 3
// del split de #5218).
//
// Qué resuelve
// ------------
// El repo es PUBLICO. Cualquier credencial que se lea —o se escriba— desde un
// archivo que vive adentro del arbol del repo termina publicada. Este modulo
// hace esa condicion detectable primero y imposible despues:
//
//   classifyOrigin(filePath, opts)   -> 'outside' | 'in_repo' | 'undetermined'
//   assertSecretOrigin(filePath, {op, secret, site})
//
// Rollout en dos tiempos (CA-11). Al mergear queda en modo `warn`:
//   - `warn`   (default, PIPELINE_SECRETS_GUARD_STRICT sin definir): loguea una
//              linea con prefijo estable, cuenta, y NO tira. Comportamiento del
//              pipeline sin cambios.
//   - `strict` (PIPELINE_SECRETS_GUARD_STRICT=1): tira SecretOriginError.
//              Su activacion NO es parte de esta historia: se ejecuta en #5263.
//
// Precedente de control reusado, no reinventado: PIPELINE_PERMISSION_VALIDATOR_STRICT
// (`pulpo.js`), comparacion estricta contra '1'. Del precedente se copia el
// patron de control, NO el texto del mensaje (ver U-1 de `ux` en #5245): la
// estructura de 4 partes del aviso viene de CA-7 de #5243.
//
// Clasificacion por (archivo, clave) — NO por archivo (D-1 / CA-10a)
// ------------------------------------------------------------------
// `.claude/hooks/telegram-config.json` es un archivo DUAL: tiene claves
// operativas versionadas con consumidores vivos (`quiet_hours`,
// `safe_directories`, `severity_timeouts`...) y claves de secreto (`bot_token`,
// `openai_api_key`). Si el guard clasificara por archivo, cada lectura de
// `quiet_hours` sumaria un `in_repo_read`, el contador no bajaria nunca, y el
// arreglo bajo presion seria una allowlist a nivel archivo que reabre el
// agujero completo. Por eso `secret` es OBLIGATORIO y es un dot-path del
// manifiesto de #5242 (`.pipeline/secrets-manifest.json`), no una lista
// hardcodeada que se desincroniza.
//
// Condicion de corte con denominador (D-6 / R22)
// ----------------------------------------------
// Los contadores se persisten en `.pipeline/secrets-health.json` bajo la clave
// `migration`, TODOS numeros, ningun array de paths (el repo es publico).
// El corte para encender `strict` es:
//     in_repo_reads === 0  AND  uninstrumented_readers === 0
// El denominador lo calcula `.pipeline/lib/secrets-census.js`, no un grep a ojo:
// sin el, el contador puede marcar cero con decenas de lectores directos
// intactos, y ese cero es lo unico que autorizaria a encender `strict`.
// =============================================================================

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
    redactSecretValue,
    redactSensitive,
    SECRET_VALUE_PATTERNS,
    REDACTION_MARKER,
} = require('./redact');
const manifestLib = require('./secrets-manifest');
const { gitSpawn, parseWorktreeList } = require('./worktree-resolver');
const { ensureGitInProcessPath } = require('./ensure-git-in-path');

// -----------------------------------------------------------------------------
// Constantes
// -----------------------------------------------------------------------------

const STRICT_ENV = 'PIPELINE_SECRETS_GUARD_STRICT';
const TEST_ENV = 'PIPELINE_SECRETS_GUARD_TEST';

/** Prefijo estable y unico: `grep -c` lo cuenta, `grep -v` lo filtra (U-2). */
const WARN_PREFIX = '[secrets-guard] WARN';

const RUNBOOK = 'docs/runbooks/credential-rotation.md#ubicación-canónica-de-credenciales-3311';
const ACTIVATION_ISSUE = '#5263';
const CANONICAL_HINT = '~/.claude/secrets/credentials.json';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PIPELINE_DIR = path.resolve(__dirname, '..');
const HEALTH_JSON_PATH = path.join(PIPELINE_DIR, 'secrets-health.json');
const GUARD_LOG_PATH = path.join(PIPELINE_DIR, 'logs', 'secrets-guard.log');

/** Clave bajo la que viven los contadores dentro de `secrets-health.json`. */
const HEALTH_MIGRATION_KEY = 'migration';

const ORIGIN = Object.freeze({
    OUTSIDE: 'outside',
    IN_REPO: 'in_repo',
    UNDETERMINED: 'undetermined',
});

const CODE = Object.freeze({
    IN_REPO: 'SECRET_ORIGIN_IN_REPO',
    UNDETERMINED: 'SECRET_ORIGIN_UNDETERMINED',
});

/** Segmentos de path aceptados por la allowlist de fixtures (CA-11a). */
const FIXTURE_SEGMENTS = Object.freeze(['__tests__', 'fixtures']);

// -----------------------------------------------------------------------------
// Error
// -----------------------------------------------------------------------------

/**
 * Error del guard. `code` distingue "el origen es in-repo" de "no pude
 * determinar el origen" (CA-10): si los dos dijeran lo mismo, el diagnostico
 * del proximo incidente seria adivinanza.
 */
class SecretOriginError extends Error {
    constructor(message, { code, origin, file, secret, op } = {}) {
        super(message);
        this.name = 'SecretOriginError';
        this.code = code || CODE.IN_REPO;
        this.origin = origin || ORIGIN.IN_REPO;
        // Detalle redactado: nombra el archivo y el dot-path, nunca el valor.
        this.details = redactSensitive({
            file: safePath(file),
            secret: safeText(secret),
            op: safeText(op),
            origin: this.origin,
        });
    }
}

// -----------------------------------------------------------------------------
// Estado del proceso (mismo ciclo de vida que la dedup — comparten resetForTests)
// -----------------------------------------------------------------------------

let _roots = null;            // string[] | null
let _rootsResolved = false;
let _rootsSpawns = 0;         // cuantas veces se invoco `git worktree list`
let _secretIndex = null;      // Set<string> | null
let _secretIndexFailed = false;
let _seenPairs = new Set();   // dedup por (secreto, archivo)
let _seenSources = new Set(); // archivos in-repo distintos
let _seenSites = new Set();   // call sites instrumentados alcanzados
let _inRepoReads = 0;
let _undetermined = 0;
let _touched = false;         // el guard fue invocado al menos una vez
let _flushHooked = false;

/** Contadores del proceso. Solo numeros: nunca paths (repo publico, R29). */
function getCounters() {
    return {
        in_repo_reads: _inRepoReads,
        distinct_sources: _seenSources.size,
        instrumented_sites: _seenSites.size,
        undetermined_origins: _undetermined,
        worktree_list_spawns: _rootsSpawns,
    };
}

/** Limpia TODO el estado memoizado. Solo para tests. */
function resetForTests() {
    _roots = null;
    _rootsResolved = false;
    _rootsSpawns = 0;
    _secretIndex = null;
    _secretIndexFailed = false;
    _seenPairs = new Set();
    _seenSources = new Set();
    _seenSites = new Set();
    _inRepoReads = 0;
    _undetermined = 0;
    _touched = false;
}

// -----------------------------------------------------------------------------
// Helpers de path
// -----------------------------------------------------------------------------

function realpathWith(fsImpl, target) {
    const rs = fsImpl && fsImpl.realpathSync;
    if (typeof rs !== 'function') return null;
    // `realpathSync.native` es el que resuelve el casing real en NTFS; si el
    // fsImpl inyectado no lo trae, se usa el sincronico comun.
    if (typeof rs.native === 'function') return rs.native(target);
    return rs(target);
}

function safeRealpath(fsImpl, target) {
    try {
        const r = realpathWith(fsImpl, target);
        return typeof r === 'string' && r ? r : null;
    } catch {
        return null;
    }
}

/**
 * Sube por `dirname` hasta el primer directorio que existe.
 *
 * ENOENT en la HOJA de un `write` es el caso normal de crear el store canonico
 * en una maquina limpia y NO es "indeterminado". ENOENT o error de fs
 * recorriendo la CADENA de ancestros si lo es, y rechaza. Sin esta distincion
 * la primera escritura legitima del store es imposible y alguien agrega un
 * `if (!existsSync) return 'outside'` que queda de bypass permanente (D-2).
 *
 * @returns {string|null} path existente, o `null` si no se pudo resolver ninguno.
 */
function nearestExistingAncestor(target, fsImpl) {
    let cur;
    try { cur = path.resolve(target); } catch { return null; }
    const visited = new Set();
    while (!visited.has(cur)) {
        visited.add(cur);
        let exists;
        try { exists = fsImpl.existsSync(cur); } catch { return null; }
        if (exists) return cur;
        const parent = path.dirname(cur);
        if (!parent || parent === cur) return null;
        cur = parent;
    }
    return null;
}

/**
 * `child` esta adentro de `parent`.
 *
 * Compara sobre paths resueltos y con separador: comparar prefijos de string
 * pelados da falsos negativos y falsos positivos (`/repo-backup` NO es subpath
 * de `/repo`). En `win32` compara en minusculas porque NTFS es
 * case-insensitive (CA-10).
 */
function isSubPath(child, parent, platform = process.platform) {
    if (!child || !parent) return false;
    let c;
    let p;
    try {
        c = path.resolve(child);
        p = path.resolve(parent);
    } catch {
        return false;
    }
    const norm = platform === 'win32' ? (s) => s.toLowerCase() : (s) => s;
    const cn = norm(c);
    const pn = norm(p);
    if (cn === pn) return true;
    const withSep = pn.endsWith(path.sep) ? pn : pn + path.sep;
    return cn.startsWith(withSep);
}

/**
 * Roots de TODOS los worktrees (`git worktree list --porcelain`), no solo el
 * toplevel: el pipeline crea worktrees `agent/*` y un secreto leido desde ahi
 * esta igual de adentro del repo.
 *
 * Memoizado por proceso: medido, `git worktree list` tarda ~0.9s y el guard
 * corre en cada lectura de credencial, con daemons que leen en loop (D-2/G-3).
 *
 * @returns {string[]|null} `null` = no se pudo determinar -> el llamador
 *          clasifica `undetermined` y rechaza (default deny).
 */
function worktreeRoots({ spawnImpl, fsImpl = fs } = {}) {
    if (_rootsResolved) return _roots;
    _rootsResolved = true;
    _roots = null;
    try {
        // `git` puede no estar en el PATH del proceso hijo (Windows).
        try { ensureGitInProcessPath(); } catch { /* best-effort */ }
        _rootsSpawns += 1;
        const out = gitSpawn(['worktree', 'list', '--porcelain'], { cwd: REPO_ROOT, spawnImpl });
        const listed = parseWorktreeList(out).map((e) => e && e.worktree).filter(Boolean);
        const all = [REPO_ROOT, ...listed];
        const seen = new Set();
        const resolved = [];
        for (const r of all) {
            const real = safeRealpath(fsImpl, r) || r;
            const key = process.platform === 'win32' ? real.toLowerCase() : real;
            if (seen.has(key)) continue;
            seen.add(key);
            resolved.push(real);
        }
        _roots = resolved;
    } catch {
        // Fail-closed: sin listado de worktrees no hay forma de saber si un path
        // esta adentro del repo. No se degrada a "solo el toplevel".
        _roots = null;
    }
    return _roots;
}

// -----------------------------------------------------------------------------
// classifyOrigin
// -----------------------------------------------------------------------------

/**
 * Clasifica el origen de un archivo. NUNCA lanza.
 *
 * @param {string} filePath
 * @param {object} [opts]
 * @param {'read'|'write'} [opts.op='read']
 * @param {function} [opts.spawnImpl] inyectable para tests
 * @param {object}   [opts.fsImpl]    inyectable para tests
 * @param {string}   [opts.platform]  inyectable para tests (casing NTFS)
 * @returns {'outside'|'in_repo'|'undetermined'}
 */
function classifyOrigin(filePath, {
    op = 'read',
    spawnImpl,
    fsImpl = fs,
    platform = process.platform,
    skipFastPath = false,
} = {}) {
    if (typeof filePath !== 'string' || !filePath.trim()) return ORIGIN.UNDETERMINED;

    const target = op === 'write' ? nearestExistingAncestor(filePath, fsImpl) : filePath;
    if (!target) return ORIGIN.UNDETERMINED;

    const real = safeRealpath(fsImpl, target);
    if (!real) return ORIGIN.UNDETERMINED;

    // Fast path: si ya cae adentro del root de ESTE checkout, es in-repo y no
    // hace falta pagar el `git worktree list`. Solo puede acortar hacia
    // `in_repo`, nunca hacia `outside`: fail-closed intacto. Es lo que evita
    // sumarle ~0.9s a cada invocacion de hook.
    if (!skipFastPath && isSubPath(real, REPO_ROOT, platform)) return ORIGIN.IN_REPO;

    const roots = worktreeRoots({ spawnImpl, fsImpl });
    if (!roots || roots.length === 0) return ORIGIN.UNDETERMINED;

    return roots.some((r) => isSubPath(real, r, platform)) ? ORIGIN.IN_REPO : ORIGIN.OUTSIDE;
}

// -----------------------------------------------------------------------------
// Manifiesto: que dot-paths son secretos (D-1)
// -----------------------------------------------------------------------------

function secretIndex(manifestImpl) {
    if (_secretIndex) return _secretIndex;
    const lib = manifestImpl || manifestLib;
    const set = new Set();
    try {
        const manifest = lib.load();
        for (const entry of (manifest && manifest.entries) || []) {
            if (entry && entry.name) set.add(String(entry.name).trim());
        }
        _secretIndexFailed = set.size === 0;
    } catch {
        // Manifiesto ilegible: fail-closed. Se trata TODO dot-path como secreto
        // en vez de desactivar el guard en silencio.
        _secretIndexFailed = true;
    }
    _secretIndex = set;
    return set;
}

/**
 * `true` si el dot-path corresponde a un secreto declarado en el manifiesto de
 * #5242. Las claves operativas (`quiet_hours` y companía) no estan en el
 * manifiesto y por lo tanto no son secretos: se leen in-repo legitimamente y no
 * cuentan (CA-10a).
 */
function isSecretDotPath(dotPath, { manifestImpl } = {}) {
    if (typeof dotPath !== 'string' || !dotPath.trim()) return false;
    const clean = dotPath.trim();
    try {
        if (manifestLib.isMetadataKey(clean)) return false;
    } catch { /* seguimos */ }
    const index = secretIndex(manifestImpl);
    if (_secretIndexFailed) return true; // fail-closed
    return index.has(clean);
}

// -----------------------------------------------------------------------------
// Allowlist de fixtures (CA-11a)
// -----------------------------------------------------------------------------

function isTestRun() {
    return process.env[TEST_ENV] === '1'
        || process.env.NODE_ENV === 'test'
        || !!process.env.NODE_TEST_CONTEXT;
}

/**
 * Una allowlist es un bypass del control: exige LAS DOS condiciones a la vez
 * —segmento `__tests__`/`fixtures` en el path Y corrida de test— y tiene su
 * test negativo obligatorio (CA-11a). Sin el, el dia que alguien ensanche el
 * prefijo nadie se entera.
 */
function isFixtureAllowlisted(filePath, { platform = process.platform, testMode } = {}) {
    const inTest = typeof testMode === 'boolean' ? testMode : isTestRun();
    if (!inTest) return false;
    if (typeof filePath !== 'string' || !filePath) return false;
    const norm = platform === 'win32' ? (s) => s.toLowerCase() : (s) => s;
    const segments = filePath.split(/[\\/]+/).map(norm);
    return FIXTURE_SEGMENTS.some((seg) => segments.includes(seg));
}

// -----------------------------------------------------------------------------
// Mensajes (U-1: cuatro partes, misma estructura que CA-7 de #5243)
// -----------------------------------------------------------------------------

/** Todo string que sale del guard pasa por redact (CA-7d). */
function safeText(value) {
    if (value === undefined || value === null) return '';
    try {
        return String(redactSensitive(redactSecretValue(String(value))));
    } catch {
        return '[texto no redactable]';
    }
}

function oneLine(text) {
    return String(text).replace(/[\r\n]+/g, ' ').trim();
}

/**
 * Redaccion de un PATH.
 *
 * Aplica los patrones de valor de `redact.js` (un token embebido en el path se
 * redacta igual) pero NO la heuristica de entropia: un path absoluto de mas de
 * 40 caracteres sin espacios la dispara y el mensaje pierde exactamente el dato
 * que CA-10/U-1 exigen que tenga. Un mensaje que dice "algo esta mal en
 * [REDACTED:high-entropy]" no es accionable.
 *
 * Ademas, si el archivo vive adentro del repo se muestra RELATIVO al root: es
 * lo que el operador necesita leer (`.claude/hooks/telegram-config.json`) y de
 * paso no publica la topologia de directorios de la maquina.
 */
function safePath(value) {
    if (value === undefined || value === null) return '';
    let out = String(value);
    try {
        const abs = path.resolve(out);
        if (isSubPath(abs, REPO_ROOT)) {
            const rel = path.relative(REPO_ROOT, abs);
            if (rel && !rel.startsWith('..')) out = rel.split(path.sep).join('/');
        }
    } catch { /* se usa el string tal cual */ }
    try {
        for (const { re } of SECRET_VALUE_PATTERNS) out = out.replace(re, REDACTION_MARKER);
        return String(redactSensitive(out));
    } catch {
        return '[path no redactable]';
    }
}

/**
 * Linea de `warn`: UNA sola linea, prefijo estable, contable con `grep -c` y
 * filtrable con `grep -v` (U-2). El detalle multilinea va en el `throw`.
 */
function warnLine(origin, { file, secret, op }) {
    const slug = origin === ORIGIN.IN_REPO ? `in-repo-${op}` : `origen-indeterminado-${op}`;
    return oneLine(
        `${WARN_PREFIX} ${slug} secret=${safeText(secret)} origen=${safePath(file)} — `
        + `no se frenó nada: ${STRICT_ENV} está apagado; con ${STRICT_ENV}=1 esto sería un corte. `
        + `Reponer en ${CANONICAL_HINT} · runbook ${RUNBOOK} · activación ${ACTIVATION_ISSUE}`,
    );
}

function strictMessage(origin, { file, secret, op }) {
    const f = safePath(file);
    const s = safeText(secret);
    const o = safeText(op);
    const comoSigue = `  cómo sigue: el guard se controla con ${STRICT_ENV} (=1 corta; sin definir sólo avisa). `
        + `La activación permanente se ejecuta en ${ACTIVATION_ISSUE}.`;

    if (origin === ORIGIN.IN_REPO) {
        return [
            '[secrets-guard] Origen in-repo para un secreto — operación abortada.',
            `  qué pasó: el secreto '${s}' se estaba resolviendo desde un archivo que vive adentro del árbol del repo (público): ${f}`,
            `  qué frena: se abortó la operación op=${o}; quien la pidió no obtiene el valor.`,
            `  cómo se arregla: mover el valor a ${CANONICAL_HINT} (o exportarlo por ENV) y leerlo desde ahí. Runbook: ${RUNBOOK}`,
            comoSigue,
        ].join('\n');
    }
    return [
        '[secrets-guard] Origen indeterminado para un secreto — operación abortada.',
        `  qué pasó: NO se pudo determinar si '${f}' vive adentro del repo (falló la resolución del path o el listado de worktrees). `
            + `No es lo mismo que "está adentro del repo": acá el guard no sabe. Secreto: '${s}'.`,
        `  qué frena: se abortó la operación op=${o}; ante la duda el guard no deja pasar (default deny).`,
        `  cómo se arregla: verificar que el path exista y que \`git\` resuelva en este proceso; si el secreto vive in-repo, `
            + `moverlo a ${CANONICAL_HINT}. Runbook: ${RUNBOOK}`,
        comoSigue,
    ].join('\n');
}

// -----------------------------------------------------------------------------
// Log
// -----------------------------------------------------------------------------

function defaultLog(line) {
    // stderr: en los daemons cae en el log del proceso que los lanzo.
    try { process.stderr.write(`${line}\n`); } catch { /* best-effort */ }
    // Log propio: garantiza la evidencia de enganche tambien para los hooks,
    // cuyo stderr no siempre queda registrado. `.pipeline/logs/` es gitignored.
    try {
        fs.mkdirSync(path.dirname(GUARD_LOG_PATH), { recursive: true });
        fs.appendFileSync(GUARD_LOG_PATH, `[${new Date().toISOString()}] ${line}\n`);
    } catch { /* best-effort: el guard nunca puede tumbar al llamador */ }
}

// -----------------------------------------------------------------------------
// Persistencia de la metrica (D-6)
// -----------------------------------------------------------------------------

function readJsonSafe(target, fsImpl) {
    try {
        if (!fsImpl.existsSync(target)) return null;
        const parsed = JSON.parse(fsImpl.readFileSync(target, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        return parsed;
    } catch {
        return null;
    }
}

function toNumber(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Persiste los contadores en `.pipeline/secrets-health.json` bajo `migration`.
 * Best-effort, nunca lanza: el guard no puede tumbar al proceso que lo usa.
 *
 * Semantica de los contadores: son ACUMULADOS entre resets, no un snapshot del
 * ultimo proceso. Cada proceso suma lo suyo al salir. Bajan a cero solo con
 * `resetHealthCounters()` (lo ejecuta #5263 antes de medir), y asi
 * `in_repo_reads === 0` significa "ningun proceso leyo un secreto in-repo desde
 * el reset", que es lo que la condicion de corte necesita afirmar.
 *
 * `uninstrumented_readers` es el DENOMINADOR y lo escribe `secrets-census.js`.
 * Vale `-1` mientras no se haya medido: es un numero, no es cero, y por lo
 * tanto no habilita el corte por accidente.
 */
function flushCounters({
    targetPath = HEALTH_JSON_PATH,
    fsImpl = fs,
    uninstrumentedReaders,
    counters,
} = {}) {
    try {
        const current = counters || getCounters();
        const doc = readJsonSafe(targetPath, fsImpl) || {};
        const prev = (doc[HEALTH_MIGRATION_KEY] && typeof doc[HEALTH_MIGRATION_KEY] === 'object')
            ? doc[HEALTH_MIGRATION_KEY]
            : {};
        const censo = typeof uninstrumentedReaders === 'number'
            ? uninstrumentedReaders
            : toNumber(prev.uninstrumented_readers, -1);

        doc[HEALTH_MIGRATION_KEY] = {
            in_repo_reads: toNumber(prev.in_repo_reads, 0) + current.in_repo_reads,
            distinct_sources: Math.max(toNumber(prev.distinct_sources, 0), current.distinct_sources),
            instrumented_sites: Math.max(toNumber(prev.instrumented_sites, 0), current.instrumented_sites),
            undetermined_origins: toNumber(prev.undetermined_origins, 0) + current.undetermined_origins,
            uninstrumented_readers: censo,
            ts: new Date().toISOString(),
            ts_reset: typeof prev.ts_reset === 'string' ? prev.ts_reset : new Date().toISOString(),
        };
        fsImpl.writeFileSync(targetPath, JSON.stringify(doc, null, 2));
        return { ok: true, path: targetPath, migration: doc[HEALTH_MIGRATION_KEY] };
    } catch (e) {
        return { ok: false, path: targetPath, error: safeText(e && e.message) };
    }
}

/** Pone los acumulados en cero y estampa `ts_reset`. Lo usa #5263 antes de medir. */
function resetHealthCounters({ targetPath = HEALTH_JSON_PATH, fsImpl = fs } = {}) {
    try {
        const doc = readJsonSafe(targetPath, fsImpl) || {};
        const prev = (doc[HEALTH_MIGRATION_KEY] && typeof doc[HEALTH_MIGRATION_KEY] === 'object')
            ? doc[HEALTH_MIGRATION_KEY]
            : {};
        const now = new Date().toISOString();
        doc[HEALTH_MIGRATION_KEY] = {
            in_repo_reads: 0,
            distinct_sources: 0,
            instrumented_sites: 0,
            undetermined_origins: 0,
            uninstrumented_readers: toNumber(prev.uninstrumented_readers, -1),
            ts: now,
            ts_reset: now,
        };
        fsImpl.writeFileSync(targetPath, JSON.stringify(doc, null, 2));
        return { ok: true, path: targetPath, migration: doc[HEALTH_MIGRATION_KEY] };
    } catch (e) {
        return { ok: false, path: targetPath, error: safeText(e && e.message) };
    }
}

function scheduleFlush() {
    if (_flushHooked) return;
    _flushHooked = true;
    try {
        process.once('exit', () => {
            // Solo escribe si el guard fue realmente invocado: un proceso que no
            // toca credenciales no tiene nada que decir sobre la migracion.
            if (!_touched) return;
            // Una corrida de test no es una corrida del pipeline: sus contadores
            // envenenarian la condicion de corte de #5263.
            if (isTestRun()) return;
            try { flushCounters(); } catch { /* best-effort */ }
        });
    } catch { /* best-effort */ }
}

// -----------------------------------------------------------------------------
// assertSecretOrigin
// -----------------------------------------------------------------------------

/**
 * Fail-closed. En `strict` lanza `SecretOriginError`; en `warn` loguea una linea
 * y cuenta. `outside` pasa siempre y no cuenta.
 *
 * @param {string} filePath  archivo desde el que se lee/escribe el secreto
 * @param {object} opts
 * @param {'read'|'write'} [opts.op='read']
 * @param {string} opts.secret  OBLIGATORIO. Dot-path del manifiesto (#5242).
 * @param {string} [opts.site]  identificador del call site (para instrumented_sites)
 * @param {boolean} [opts.strict] override del env (tests)
 * @param {function} [opts.log]
 * @returns {{ok:boolean, origin:string, counted:boolean, strict:boolean}}
 */
function assertSecretOrigin(filePath, {
    op = 'read',
    secret,
    site,
    strict,
    log,
    spawnImpl,
    fsImpl,
    platform,
    manifestImpl,
    testMode,
} = {}) {
    if (typeof secret !== 'string' || !secret.trim()) {
        throw new TypeError(
            "[secrets-guard] assertSecretOrigin: el parámetro 'secret' es obligatorio y "
            + 'debe ser un dot-path del manifiesto (.pipeline/secrets-manifest.json). '
            + 'Sin él el guard no puede distinguir una clave operativa de un secreto.',
        );
    }
    const dotPath = secret.trim();
    const operation = op === 'write' ? 'write' : 'read';
    const logger = typeof log === 'function' ? log : defaultLog;

    _touched = true;
    _seenSites.add(site ? String(site) : `${dotPath}:${operation}`);
    scheduleFlush();

    // Clave operativa (no declarada como secreto en el manifiesto): pasa y NO cuenta.
    if (!isSecretDotPath(dotPath, { manifestImpl })) {
        return { ok: true, origin: 'not_a_secret', counted: false, strict: false };
    }

    if (isFixtureAllowlisted(filePath, { platform, testMode })) {
        return { ok: true, origin: 'fixture_allowlisted', counted: false, strict: false };
    }

    const origin = classifyOrigin(filePath, { op: operation, spawnImpl, fsImpl, platform });
    if (origin === ORIGIN.OUTSIDE) {
        return { ok: true, origin, counted: false, strict: false };
    }

    // Dedup por (secreto, archivo) una vez por proceso: acota el ruido del log y
    // evita que un daemon que lee en loop infle el contador.
    const pairKey = `${dotPath}|${String(filePath)}`;
    const isNew = !_seenPairs.has(pairKey);
    if (isNew) {
        _seenPairs.add(pairKey);
        if (origin === ORIGIN.IN_REPO) {
            _inRepoReads += 1;
            _seenSources.add(String(filePath));
        } else {
            _undetermined += 1;
        }
    }

    const isStrict = typeof strict === 'boolean' ? strict : (process.env[STRICT_ENV] === '1');
    if (isStrict) {
        throw new SecretOriginError(
            strictMessage(origin, { file: filePath, secret: dotPath, op: operation }),
            {
                code: origin === ORIGIN.IN_REPO ? CODE.IN_REPO : CODE.UNDETERMINED,
                origin,
                file: filePath,
                secret: dotPath,
                op: operation,
            },
        );
    }

    if (isNew) logger(warnLine(origin, { file: filePath, secret: dotPath, op: operation }));
    return { ok: false, origin, counted: isNew, strict: false };
}

module.exports = {
    classifyOrigin,
    assertSecretOrigin,
    isSecretDotPath,
    isFixtureAllowlisted,
    getCounters,
    resetForTests,
    flushCounters,
    resetHealthCounters,
    SecretOriginError,
    // Constantes publicas (tests / herramientas operativas).
    ORIGIN,
    CODE,
    STRICT_ENV,
    TEST_ENV,
    WARN_PREFIX,
    RUNBOOK,
    ACTIVATION_ISSUE,
    HEALTH_JSON_PATH,
    HEALTH_MIGRATION_KEY,
    GUARD_LOG_PATH,
    REPO_ROOT,
    // Internos expuestos para test unitario.
    isSubPath,
    nearestExistingAncestor,
};

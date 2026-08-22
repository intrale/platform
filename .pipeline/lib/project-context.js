'use strict';

// -----------------------------------------------------------------------------
// project-context.js — dueño ÚNICO de la resolución del proyecto en contexto
// para el ESTADO OPERATIVO (#5110 · Ola 9.4 · E2).
//
// Por qué existe
// --------------
// Hasta #5110 el estado operativo (registro de olas, allowlist de ejecución y
// sus contadores) era plano y global: un único `waves.json` y un único
// `.partial-pause.json` para todo el sistema. Con dos proyectos activos, ambos
// escriben la misma estructura y se pisan.
//
// Este módulo resuelve QUÉ proyecto está en contexto. El sustrato
// (`waves.js`, `partial-pause.js`, `partial-pause-audit.js`) le pregunta a este
// módulo y namespacea sus paths bajo `.pipeline/projects/<projectId>/`.
//
// Dos ejes de autoridad que NO se unifican (D1)
// ---------------------------------------------
//   1. IDENTIDAD DE TENANT — `isReservedProjectId()` de `project-descriptor.js`.
//      Gobierna quién puede ser el `identity.projectId` de un tenant en
//      `kernel-store`. Que `intrale-platform` esté RESERVADO es justamente lo
//      que protege el namespace del host de ser reclamado por un tenant.
//      Levantar esa reserva abriría el agujero que #6045 quiere cerrar, así que
//      acá NO se levanta.
//   2. VALIDEZ DE NAMESPACE OPERATIVO — `assertOperationalNamespace()` (abajo).
//      Eje separado: acepta `HOST_PROJECT_ID` (que es reservado a propósito) y,
//      para cualquier otro id, exige `isSafeId(id) && !isReservedProjectId(id)`.
//
// El `intrale` de `.pipeline/config.yaml` es raíz del VAULT DE SECRETOS
// (`SECRET_SCOPES`), un tercer eje: ni se unifica ni se toca acá.
//
// Asimetría con `kernel-store.js` (security §2)
// ---------------------------------------------
// `kernel-store` deriva el `contextProjectId` de la CREDENCIAL de la instancia.
// Acá NO hay credencial: el pipeline corre local, con un solo usuario del SO.
// La autoridad la aporta el PULPO en el spawn (binding en disco), no el
// entorno. `PIPELINE_PROJECT_ID` es TRANSPORTE, nunca autoridad: `build-child-env.js`
// propaga toda `PIPELINE_*` heredada de `process.env`, y los roles instruyen a
// los agentes a correr `node -e "require('.../lib/...')"` — o sea que un agente
// podría exportar la var y, sin el binding, hablarle al namespace de otro
// proyecto (SEC-1 / A01 / A07).
//
// Residual honesto: el binding vive en el FS local, bajo el mismo usuario. Sube
// la barra (hay que forjar un registro escrito por el pulpo) pero NO es
// criptográfico. La autoridad plena llega con #5113/#5129.
// -----------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const { isSafeId, isReservedProjectId } = require('./project-descriptor');

// -----------------------------------------------------------------------------
// Error tipado
// -----------------------------------------------------------------------------

// Se define acá y NO se importa de `operational-state.js` a propósito: este
// módulo lo consume el SUSTRATO (`waves.js`), que a su vez es consumido por
// `operational-state.js`. Importar hacia arriba cerraría un ciclo de require.
// La forma (`code`, `stage`) es idéntica a `OperationalStateError` para que los
// callers puedan tratarlos igual.
class ProjectContextError extends Error {
    constructor(message, opts = {}) {
        super(message);
        this.name = 'ProjectContextError';
        this.code = opts.code || 'EOPSTATE_NO_PROJECT_CONTEXT';
        this.stage = opts.stage || 'isolation';
        if (opts.cause !== undefined) this.cause = opts.cause;
    }
}

// -----------------------------------------------------------------------------
// Paths físicos
// -----------------------------------------------------------------------------

// Raíz FÍSICA del pipeline. `PIPELINE_DIR_OVERRIDE` se preserva y COMPONE con
// el namespace: sigue eligiendo la raíz física, el namespace se aplica adentro.
// Misma semántica que `waves.js:92` y `partial-pause.js:80`, para que los
// fixtures existentes no cambien de forma.
function pipelineDir() {
    if (process.env.PIPELINE_DIR_OVERRIDE) return process.env.PIPELINE_DIR_OVERRIDE;
    return path.resolve(__dirname, '..');
}

// Raíz del repo — de acá sale la identidad del HOST. NO honra
// `PIPELINE_DIR_OVERRIDE`: la identidad del host es del checkout, no del
// directorio de estado que un fixture apunte a otro lado.
function repoRoot() {
    return path.resolve(__dirname, '..', '..');
}

function descriptorsDir() {
    return path.join(pipelineDir(), 'descriptors');
}

/**
 * Directorio de bindings de spawn.
 *
 * OJO con el worktree: los agentes de fase `dev` corren en un worktree aislado
 * (`platform.agent-<issue>-<skill>/`), con su PROPIA copia de `.pipeline/`. El
 * binding, en cambio, lo escribe el pulpo en el repo PRINCIPAL. Si esta función
 * resolviera contra el `.pipeline/` local, el hijo buscaría el nonce en un
 * directorio que nunca lo va a tener y `resolveProjectContext()` fallaría
 * cerrado en todo agente de dev.
 *
 * `PIPELINE_REPO_ROOT` lo inyecta el pulpo en cada spawn y apunta siempre al
 * repo principal, así que es la referencia correcta. `PIPELINE_DIR_OVERRIDE`
 * tiene precedencia por encima para que los sandboxes de test sigan siendo
 * herméticos.
 */
function bindingsDir() {
    if (process.env.PIPELINE_DIR_OVERRIDE) {
        return path.join(process.env.PIPELINE_DIR_OVERRIDE, 'state', 'project-bindings');
    }
    if (process.env.PIPELINE_REPO_ROOT) {
        return path.join(process.env.PIPELINE_REPO_ROOT, '.pipeline', 'state', 'project-bindings');
    }
    return path.join(pipelineDir(), 'state', 'project-bindings');
}

// Retención de bindings. Cada spawn escribe uno y el consumidor no siempre
// puede borrarlo (el hijo puede morir por watchdog), así que sin poda el
// directorio crece sin techo. 48h cubre de sobra la vida de cualquier agente.
const BINDING_TTL_MS = 48 * 60 * 60 * 1000;

function pruneStaleBindings(now = Date.now()) {
    let entries;
    try { entries = fs.readdirSync(bindingsDir()); } catch { return 0; }
    let removed = 0;
    for (const f of entries) {
        if (!f.endsWith('.json')) continue;
        const file = path.join(bindingsDir(), f);
        try {
            if (now - fs.statSync(file).mtimeMs > BINDING_TTL_MS) {
                fs.unlinkSync(file);
                removed++;
            }
        } catch { /* best-effort: un binding que no se puede podar no rompe nada */ }
    }
    return removed;
}

// Raíz de TODOS los namespaces de estado operativo.
function projectsRoot() {
    return path.resolve(path.join(pipelineDir(), 'projects'));
}

// -----------------------------------------------------------------------------
// Contención de paths (SEC-2 · anti-traversal)
// -----------------------------------------------------------------------------
//
// Estos dos helpers son DEFENSA EN PROFUNDIDAD: en todos sus call sites el id ya
// pasó por `isSafeId()`, que rechaza `..`, `/` y `\`, así que un escape es hoy
// inalcanzable desde la API pública. Justamente por eso viven acá como funciones
// PURAS y exportadas en `_internal`: es el único nivel donde se les puede
// construir una entrada que escape y probar que cortan. Dejarlos inline en cada
// call site los volvía ramas muertas — no testeadas, no verificables, y por lo
// tanto una garantía que nadie estaba mirando (que es exactamente lo que este
// módulo NO puede permitirse siendo el control de aislamiento).
//
// Corolario de diseño: los call sites NO ramifican. Preguntan al helper y usan
// lo que devuelve. Si mañana el regex de ids se relaja, la contención sigue
// cortando ANTES de tocar el FS y con test que lo respalda.

/**
 * @returns {string|null} `child` si cuelga estrictamente de `parent`; si no, `null`.
 */
function containedUnder(child, parent) {
    return child.startsWith(parent + path.sep) ? child : null;
}

/**
 * Igual que `containedUnder()` pero fail-closed y ruidoso — para el sustrato de
 * estado, donde un escape no puede degradarse a "no encontré nada".
 * @throws {ProjectContextError}
 */
function requireContainedUnder(child, parent) {
    const contained = containedUnder(child, parent);
    if (!contained) {
        throw new ProjectContextError(
            `namespace resuelve fuera de ${parent}: ${child}`,
            { code: 'EOPSTATE_PATH_ESCAPE', stage: 'isolation' },
        );
    }
    return contained;
}

// -----------------------------------------------------------------------------
// Flag de layout (rollout gradual + R8)
// -----------------------------------------------------------------------------
//
// `config.yaml → operational_state.namespaced.enabled`, DEFAULT OFF.
//
// Por qué default OFF: el pipeline corre en producción continua y este cambio
// mueve dónde vive el registro de olas. Si se activara solo, un checkout que
// todavía no corrió el migrador vería el namespace vacío — es decir, CERO olas,
// dispatch detenido y avance de ola en 0%. Con el flag apagado el layout es el
// plano de siempre y no hay ni un byte de diferencia de comportamiento (CA-5).
//
// Secuencia de encendido: correr el migrador (con halt) → prender el flag →
// `/restart`. R8 (rollback en minutos) es el camino inverso: bajar el flag y
// correr `--rollback`.
//
// `PIPELINE_OPSTATE_NAMESPACED` fuerza el valor (1/0) sin tocar config — lo usan
// los tests de aislamiento y sirve para probar el encendido en caliente.

let namespacedConfigCache = null;

/**
 * Lee el flag del árbol de config ya resuelto. PURA: el camino real depende de
 * `config-resolver` (js-yaml + ajv + schema del pipeline entero), así que armar
 * por fixture cada combinación de config parcial costaría más que el control que
 * se quiere probar. Acá cada forma degradada del árbol —sin `operational_state`,
 * con la sección pero sin `namespaced`, con `enabled` en un valor distinto de
 * `true`— es un caso de test de una línea.
 *
 * Estricto con `=== true` a propósito: `"true"`, `1` o `"1"` en el YAML NO
 * encienden el namespaceo. Un flag que mueve dónde vive el registro de olas no
 * se prende por coerción accidental.
 */
function namespacedFromConfig(cfg) {
    const ns = cfg && cfg.operational_state && cfg.operational_state.namespaced;
    return !!(ns && ns.enabled === true);
}

/**
 * `operational_state.namespaced.strict_context`. Mismo criterio `=== true`.
 *
 * Qué hace cuando está prendido: apaga los DOS caminos que resuelven el contexto
 * por convención en vez de por declaración — `single-project` (exactamente un
 * descriptor) y `host-fallback` (cero descriptores). Con `strict_context: true`
 * el contexto tiene que venir declarado: `opts.projectId` in-process o el par
 * env+binding que escribe el pulpo. Cualquier otra cosa tira
 * `EOPSTATE_NO_PROJECT_CONTEXT`.
 *
 * Es el knob que hace exigible el CA-3 del issue ("el projectId se resuelve de
 * forma explícita en cada punto de entrada") sin romper el pipeline de un
 * proyecto mientras el cableado de #5164 no esté.
 */
function strictContextFromConfig(cfg) {
    const ns = cfg && cfg.operational_state && cfg.operational_state.namespaced;
    return !!(ns && ns.strict_context === true);
}

/**
 * Resuelve la config UNA vez por proceso y cachea las dos lecturas juntas: el
 * resolver arrastra `js-yaml` + `ajv` y esto se consulta en el camino caliente
 * de resolución de paths, así que no se paga dos veces.
 *
 * Config ilegible ⇒ `{ enabled: false, strictContext: false }`, es decir el
 * comportamiento PLANO y permisivo de siempre. Es el default seguro: ante duda,
 * el comportamiento conocido, no uno nuevo. En particular no se cae a strict —
 * una config rota no debe dejar al pipeline sin poder resolver su propio estado.
 */
function readNamespacedConfig() {
    if (namespacedConfigCache) return namespacedConfigCache;
    let cfg = null;
    try {
        // Lazy-require deliberado: ver arriba.
        // eslint-disable-next-line global-require
        const configResolver = require('./config-resolver');
        cfg = configResolver.resolve({ pipelineDir: pipelineDir() });
    } catch {
        cfg = null;
    }
    namespacedConfigCache = Object.freeze({
        enabled: namespacedFromConfig(cfg),
        strictContext: strictContextFromConfig(cfg),
    });
    return namespacedConfigCache;
}

function namespaceEnabled() {
    const env = process.env.PIPELINE_OPSTATE_NAMESPACED;
    if (env === '1') return true;
    if (env === '0') return false;
    return readNamespacedConfig().enabled;
}

/**
 * `PIPELINE_OPSTATE_STRICT_CONTEXT` fuerza el valor (1/0) sin tocar config, con
 * el mismo patrón que el flag de layout: lo usan los tests y sirve para probar
 * el modo estricto en caliente antes de escribirlo en el YAML.
 */
function strictContextEnabled() {
    const env = process.env.PIPELINE_OPSTATE_STRICT_CONTEXT;
    if (env === '1') return true;
    if (env === '0') return false;
    return readNamespacedConfig().strictContext;
}

// -----------------------------------------------------------------------------
// HOST_PROJECT_ID
// -----------------------------------------------------------------------------

// `pipeline.config.json:3` → `"projectId": "intrale-platform"`, que ya coincide
// con `.pipeline/descriptors/intrale-platform.json`. Se lee UNA vez y se
// congela: si el archivo cambia en caliente, el proceso vivo conserva la
// identidad con la que arrancó (cambiar de host a mitad de vuelo sería peor que
// quedar viejo).
const HOST_FALLBACK_ID = 'intrale-platform';

let hostProjectIdCache = null;

function hostConfigFile() {
    return path.join(repoRoot(), 'pipeline.config.json');
}

/**
 * Extrae el `projectId` del contenido crudo de `pipeline.config.json`.
 * PURA a propósito: `repoRoot()` no honra `PIPELINE_DIR_OVERRIDE` (la identidad
 * del host es del checkout, no del directorio de estado que un fixture apunte a
 * otro lado), así que un test no puede alimentar este parseo por el FS sin
 * escribir en el repo real. Separarlo lo hace verificable sin esa trampa.
 *
 * @returns {string|null} el id ya trimmeado, o `null` si el JSON no lo declara.
 * @throws {SyntaxError} si `raw` no es JSON — lo captura `computeHostProjectId()`.
 */
function parseHostProjectId(raw) {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.projectId === 'string' && parsed.projectId.trim()) {
        return parsed.projectId.trim();
    }
    return null;
}

/**
 * Resuelve la identidad del host a partir de un lector inyectable.
 * @param {() => string} readRaw
 */
function computeHostProjectId(readRaw) {
    let id = null;
    try {
        id = parseHostProjectId(readRaw());
    } catch {
        // Archivo ausente o ilegible (fixtures, checkouts parciales): se cae al
        // literal conocido. NO es un default silencioso a "otro proyecto" — es
        // la identidad del propio host, que es lo único que puede ser.
        id = null;
    }
    if (!id) id = HOST_FALLBACK_ID;
    if (!isSafeId(id)) {
        throw new ProjectContextError(
            `pipeline.config.json declara un projectId inseguro: ${JSON.stringify(id)}`,
            { code: 'EOPSTATE_INVALID_PROJECT_ID', stage: 'isolation' },
        );
    }
    return id;
}

function readHostProjectId() {
    if (hostProjectIdCache !== null) return hostProjectIdCache;
    hostProjectIdCache = computeHostProjectId(() => fs.readFileSync(hostConfigFile(), 'utf8'));
    return hostProjectIdCache;
}

// -----------------------------------------------------------------------------
// Validación de namespace operativo (D1)
// -----------------------------------------------------------------------------

/**
 * Valida que `id` sea un namespace de ESTADO OPERATIVO legítimo.
 *
 * Acepta `HOST_PROJECT_ID` aunque esté en `RESERVED_PROJECT_IDS` — la reserva
 * gobierna la identidad de TENANT, no el namespace de estado del host (D1).
 * Para cualquier otro id exige `isSafeId(id) && !isReservedProjectId(id)`, con
 * lo que quedan rechazados de entrada los ids de contaminación de prototipo
 * (`__proto__`, `constructor`, `prototype`, `toString`, `namespaces`) y los
 * scopes del vault de secretos — SEC-3.
 *
 * @param {string} id
 * @returns {string} el mismo `id`, ya validado.
 * @throws {ProjectContextError}
 */
function assertOperationalNamespace(id) {
    const host = readHostProjectId();
    if (id === host) return id;

    if (!isSafeId(id)) {
        throw new ProjectContextError(
            `projectId inválido para namespace de estado operativo: ${JSON.stringify(
                id == null ? null : String(id).slice(0, 120),
            )}`,
            { code: 'EOPSTATE_INVALID_PROJECT_ID', stage: 'isolation' },
        );
    }
    if (isReservedProjectId(id)) {
        throw new ProjectContextError(
            `projectId "${id}" está reservado y no puede usarse como namespace de estado operativo ` +
            `(la reserva de tenant NO se levanta — ver #6045)`,
            { code: 'EOPSTATE_RESERVED_PROJECT_ID', stage: 'isolation' },
        );
    }
    return id;
}

// NOTA — acá vivía un `assertSameProject()` "por paridad" con
// `kernel-store.js:241-247`. Se eliminó en rev-2: no tenía un solo caller de
// producción. El único consumidor que pide una partición por id explícito es el
// migrador, y lo hace a propósito sobre el HOST (`stateDirFor(HOST_PROJECT_ID)`)
// justamente para NO depender de que el contexto ambiente de la máquina que
// migra esté bien configurado — un cross-check ahí habría roto el caso legítimo.
// Todo el resto del sustrato usa `stateDir()`, que resuelve el contexto y no
// recibe id de nadie, así que no hay superficie donde el chequeo aplique.
//
// Una defensa A01 exportada y testeada pero que nadie invoca es peor que no
// tenerla: figura como garantía en el diff y no protege nada. El chequeo real
// vive en `kernel-store.js`, donde SÍ está cableado (`:428`, `:440`) sobre una
// API que recibe `projectId` del caller.

// -----------------------------------------------------------------------------
// Directorio de estado namespaceado (SEC-2 · anti-traversal)
// -----------------------------------------------------------------------------

/**
 * `.pipeline/projects/<projectId>/` — con assert de contención.
 *
 * `isSafeId()` ya rechaza `..`, `/` y `\`, así que este check es defensa en
 * profundidad: si el regex de ids se relajara alguna vez, la contención sigue
 * cortando el escape ANTES de tocar el FS.
 */
function stateDirFor(projectId) {
    assertOperationalNamespace(projectId);
    const root = projectsRoot();
    // `requireContainedUnder()` cubre también el caso `dir === root`: la raíz no
    // empieza con `root + sep`, así que un id que colapse al propio root queda
    // rechazado por el mismo check, sin una condición extra que nadie pueda
    // ejercitar.
    return requireContainedUnder(path.resolve(path.join(root, projectId)), root);
}

const ensuredStateDirs = new Set();

/**
 * `stateDirFor()` del proyecto en contexto, con el directorio garantizado.
 * Es la ÚNICA función que consume el sustrato (`waves.js`, `partial-pause.js`,
 * `partial-pause-audit.js`) para resolver dónde vive el estado.
 *
 * Que viva acá y no en `waves.js` no es cosmético: si `partial-pause.js`
 * tuviera que preguntarle a `waves.js`, cualquier test que reemplace el módulo
 * `waves` por un fake (patrón usado en los tests del dashboard) rompería la
 * resolución de paths de la allowlist. El sustrato depende de este módulo, y
 * este módulo no depende de ninguno de ellos.
 *
 * Con el flag APAGADO (default) devuelve la raíz física — layout plano, sin
 * resolver contexto siquiera: cero superficie nueva de fallo en el camino
 * caliente mientras el rollout no esté encendido.
 */
function stateDir() {
    if (!namespaceEnabled()) return path.resolve(pipelineDir());
    const dir = stateDirFor(resolveProjectContext().projectId);
    // El assert de contención ya corrió en `stateDirFor()` (SEC-2). Acá sólo
    // garantizamos existencia, memoizada para no pagar un syscall por cada
    // resolución de path en el camino caliente.
    if (!ensuredStateDirs.has(dir)) {
        try { fs.mkdirSync(dir, { recursive: true }); } catch { /* el write posterior falla ruidoso */ }
        ensuredStateDirs.add(dir);
    }
    return dir;
}

// -----------------------------------------------------------------------------
// Binding de spawn — la autoridad la aporta el pulpo, no el entorno (SEC-1)
// -----------------------------------------------------------------------------

/**
 * Lee `.pipeline/state/project-bindings/<nonce>.json`, que SOLO escribe el
 * pulpo antes de spawnear un agente. Devuelve `null` ante cualquier problema:
 * el caller trata `null` como "sin autoridad" y tira — nunca como "seguí igual".
 */
/**
 * Path del binding de `nonce`, o `null` si el nonce no es seguro o el path
 * escaparía del directorio de bindings. Único lugar que arma este path: que
 * lectura y borrado compartan resolución evita que una de las dos se relaje sola.
 */
function bindingFileFor(nonce) {
    if (!isSafeId(nonce)) return null;
    const dir = path.resolve(bindingsDir());
    return containedUnder(path.resolve(path.join(dir, `${nonce}.json`)), dir);
}

function readSpawnBinding(nonce) {
    const file = bindingFileFor(nonce);
    if (!file) return null;
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!parsed || typeof parsed !== 'object') return null;
        if (typeof parsed.projectId !== 'string') return null;
        return parsed;
    } catch {
        return null;
    }
}

/**
 * Escribe el binding de spawn. Lo usa el PULPO (y sólo el pulpo) antes de
 * lanzar un agente; el hijo recibe `PIPELINE_PROJECT_ID` + `PIPELINE_PROJECT_BINDING`
 * y este módulo valida que el par coincida.
 *
 * @returns {{ nonce: string, file: string, projectId: string }}
 */
function writeSpawnBinding({ projectId, nonce, pid = null, skill = null, spawnedAt = null } = {}) {
    assertOperationalNamespace(projectId);
    if (!isSafeId(nonce)) {
        throw new ProjectContextError(
            `nonce de binding inválido: ${JSON.stringify(nonce == null ? null : String(nonce).slice(0, 80))}`,
            { code: 'EOPSTATE_INVALID_BINDING', stage: 'isolation' },
        );
    }
    const dir = path.resolve(bindingsDir());
    fs.mkdirSync(dir, { recursive: true });
    // Sin `try` alrededor: `pruneStaleBindings()` ya contiene TODO su error
    // adentro (readdir y cada stat/unlink van en su propio catch) y devuelve un
    // contador, nunca tira. Un catch extra acá sería una rama muerta que además
    // sugiere, en falso, que la poda puede tumbar un spawn.
    pruneStaleBindings();
    const file = path.join(dir, `${nonce}.json`);
    const body = {
        projectId,
        nonce,
        pid,
        skill,
        spawnedAt: spawnedAt || new Date().toISOString(),
    };
    fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    return { nonce, file, projectId };
}

/** Borra un binding consumido. Idempotente. */
function clearSpawnBinding(nonce) {
    const file = bindingFileFor(nonce);
    if (!file) return false;
    try {
        fs.unlinkSync(file);
        return true;
    } catch {
        return false;
    }
}

// -----------------------------------------------------------------------------
// Descriptores conocidos
// -----------------------------------------------------------------------------

/** Ids de proyecto con descriptor en `.pipeline/descriptors/`, ordenados. */
function listDescriptorProjectIds() {
    let entries;
    try {
        entries = fs.readdirSync(descriptorsDir());
    } catch {
        return [];
    }
    return entries
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -'.json'.length))
        .filter((id) => isSafeId(id))
        .sort();
}

// -----------------------------------------------------------------------------
// Resolución del contexto
// -----------------------------------------------------------------------------

let cached = null;

function freezeContext(projectId, source) {
    return Object.freeze({ projectId, source });
}

/**
 * Resuelve el proyecto en contexto. FAIL-CLOSED: ante ambigüedad tira
 * `EOPSTATE_NO_PROJECT_CONTEXT` en vez de caer por convención en el estado de
 * otro proyecto (escenario Gherkin "falta el proyecto en contexto").
 *
 * Precedencia:
 *   1. `opts.projectId` explícito in-process — sólo lo pasa el pulpo o una CLI
 *      que ya decidió.                                     → `source: 'explicit'`
 *   2. `PIPELINE_PROJECT_ID` + `PIPELINE_PROJECT_BINDING` — el env es transporte;
 *      vale sólo si coincide con el binding que escribió el pulpo (SEC-1).
 *                                                     → `source: 'spawn-binding'`
 *   3. Exactamente UN descriptor conocido y sin binding → ese proyecto.
 *      Camino de compatibilidad del proyecto único (CA-5).
 *                                                    → `source: 'single-project'`
 *   4. Cualquier otro caso → throw.
 *
 * El resultado se cachea por proceso y se devuelve CONGELADO.
 *
 * @param {{ projectId?: string }} [opts]
 * @returns {Readonly<{ projectId: string, source: string }>}
 */
function resolveProjectContext(opts = {}) {
    const explicit = opts && opts.projectId;
    if (explicit) {
        // Lo explícito NO se sirve del caché ni lo puebla: un caller que pide un
        // proyecto puntual no debe reprogramar el contexto del proceso entero.
        return freezeContext(assertOperationalNamespace(explicit), 'explicit');
    }

    if (cached) return cached;

    const envId = process.env.PIPELINE_PROJECT_ID;
    const nonce = process.env.PIPELINE_PROJECT_BINDING;

    if (envId || nonce) {
        const bound = readSpawnBinding(nonce);
        if (!bound || bound.projectId !== envId) {
            throw new ProjectContextError(
                'projectId en banda sin binding de spawn válido (A01/A07): el entorno no es autoridad. ' +
                'PIPELINE_PROJECT_ID debe venir apareado con un PIPELINE_PROJECT_BINDING escrito por el pulpo.',
                { code: 'EOPSTATE_NO_PROJECT_CONTEXT', stage: 'isolation' },
            );
        }
        cached = freezeContext(assertOperationalNamespace(envId), 'spawn-binding');
        return cached;
    }

    const known = listDescriptorProjectIds();

    // `strict_context: true` — los dos caminos de abajo resuelven por CONVENCIÓN
    // (hay un solo descriptor / no hay ninguno), no porque alguien haya declarado
    // el proyecto. Es exactamente lo que el modo estricto viene a prohibir: con
    // el knob prendido, un punto de entrada sin contexto falla ruidoso en vez de
    // acertarle al único proyecto que hay. Se chequea una sola vez, acá, para no
    // repetir la condición en cada rama.
    if (strictContextEnabled()) {
        throw new ProjectContextError(
            'operational_state.namespaced.strict_context: true — el contexto de proyecto debe venir ' +
            `DECLARADO y no lo está (${known.length} descriptor(es) conocido(s)). Los caminos de compat ` +
            '`single-project` y `host-fallback` están apagados por config. Pasá projectId explícito ' +
            'o spawneá con binding del pulpo.',
            { code: 'EOPSTATE_NO_PROJECT_CONTEXT', stage: 'isolation' },
        );
    }

    if (known.length === 1) {
        cached = freezeContext(assertOperationalNamespace(known[0]), 'single-project');
        return cached;
    }

    // CERO descriptores ≠ ambigüedad. Pasa en checkouts sin `descriptors/`, en
    // fixtures que apuntan `PIPELINE_DIR_OVERRIDE` a un tmpdir, y en el bootstrap
    // antes de que exista el primer descriptor. Ahí NO hay "otro proyecto" en el
    // que caer por error: el host es el único que puede ser. Resolver acá
    // preserva CA-5 (el proyecto único sigue operando igual) sin abrir el
    // agujero que importa, que es el de abajo.
    if (known.length === 0) {
        cached = freezeContext(readHostProjectId(), 'host-fallback');
        return cached;
    }

    // DOS O MÁS descriptores y nadie declaró cuál: acá sí hay que fallar. Elegir
    // "el primero" o "el host" sería exactamente el default silencioso que el
    // escenario Gherkin "falta el proyecto en contexto" prohíbe — un punto de
    // entrada mal cableado terminaría leyendo y escribiendo el estado del
    // proyecto equivocado sin que nadie se entere.
    throw new ProjectContextError(
        `contexto de proyecto ausente y ${known.length} proyectos conocidos (${known.join(', ')}): ` +
        'no se resuelve por convención. Pasá projectId explícito o spawneá con binding del pulpo.',
        { code: 'EOPSTATE_NO_PROJECT_CONTEXT', stage: 'isolation' },
    );
}

/**
 * Variante NO-THROW para superficies informativas (audit trail, `_paths()`,
 * mensajes de error). Devuelve el id del proyecto o `null` si el contexto no
 * resuelve.
 *
 * Existe para no convertir un campo de diagnóstico en un modo de fallo nuevo:
 * si el contexto está ambiguo, una mutación de allowlist debe seguir tirando
 * (eso lo hace `resolveProjectContext()` en el camino de escritura), pero
 * anotar el projectId en un JSONL no debería tumbar nada por sí solo.
 *
 * @returns {string|null}
 */
function currentProjectIdOrNull() {
    try {
        return resolveProjectContext().projectId;
    } catch {
        return null;
    }
}

/** Invalida el caché por proceso. Sólo para tests y para el migrador. */
function _resetForTests() {
    cached = null;
    hostProjectIdCache = null;
    namespacedConfigCache = null;
    ensuredStateDirs.clear();
}

module.exports = {
    ProjectContextError,
    get HOST_PROJECT_ID() { return readHostProjectId(); },
    resolveProjectContext,
    currentProjectIdOrNull,
    namespaceEnabled,
    assertOperationalNamespace,
    stateDir,
    stateDirFor,
    projectsRoot,
    listDescriptorProjectIds,
    readSpawnBinding,
    writeSpawnBinding,
    clearSpawnBinding,
    pruneStaleBindings,
    BINDING_TTL_MS,
    _resetForTests,
    // Helpers PUROS del control de aislamiento. Se exportan para poder probarlos
    // con entradas que la API pública ya no deja construir (un id que escape del
    // root, un `pipeline.config.json` ilegible, un árbol de config a medio
    // armar). No son API: nadie fuera de los tests debería importarlos.
    _internal: {
        containedUnder,
        requireContainedUnder,
        parseHostProjectId,
        computeHostProjectId,
        namespacedFromConfig,
        strictContextFromConfig,
        strictContextEnabled,
        bindingFileFor,
        hostConfigFile,
        HOST_FALLBACK_ID,
    },
    _paths: () => ({
        PIPELINE_DIR: pipelineDir(),
        PROJECTS_ROOT: projectsRoot(),
        DESCRIPTORS_DIR: descriptorsDir(),
        BINDINGS_DIR: bindingsDir(),
    }),
};

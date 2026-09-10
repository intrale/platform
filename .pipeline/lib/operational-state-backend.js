'use strict';

// =============================================================================
// operational-state-backend.js — capa de storage ÚNICA del estado operativo
// (#5113 · Ola 9.4 · E2 — último eslabón de #5108 → #5109 → #5110 → #5113)
// =============================================================================
//
// QUÉ ES
// ------
// El sustrato donde vive el estado operativo del pipeline: el registro de olas
// (`waves.json`) y la allowlist de ejecución (`.partial-pause.json`). Resuelve
// contra filesystem o contra la tabla de coordinación del kernel
// (`intrale-kernel-coordination`) según UN flag único, y es el ÚNICO archivo
// que conoce ese flag.
//
// DÓNDE SE INSERTA (D-1 del PO)
// -----------------------------
// En la capa de STORAGE de `waves.js` / `partial-pause.js`, NO detrás de la
// fachada `operational-state.js`. Los archivos de producción que requieren esos
// módulos directo heredan el cambio sin tocarse ni una línea (CA-C7). Meterlo
// en la fachada dejaría a esos lectores contra filesystem, que son exactamente
// las dos fuentes de verdad que el issue prohíbe (CA-C1).
//
// POR QUÉ TODA LA API ES SÍNCRONA
// -------------------------------
// Es la decisión de diseño que sostiene CA-A1, CA-A2 y CA-C7 a la vez.
// `isIssueAllowed()` debe seguir devolviendo `boolean` ESTRICTO: convertir la
// cadena a `async` obligaría a `await` en los ~35 consumidores y cualquier
// olvido es fail-OPEN silencioso, porque `if (unaPromesa)` es siempre `true`.
// Eso es el incidente #5060 (~320 agentes despachados) reproducido por un
// cambio de tipo de retorno. El costo del `spawnSync` lo absorben el caché de
// 2 s de `waves.js` y `isIssueAllowedInState(issue, state)`, que lee el estado
// UNA vez por tick y lo reusa para N issues.
//
// DEGRADACIÓN = DENEGAR, NUNCA LEER FILESYSTEM (CA-A7 / SEC-6)
// ------------------------------------------------------------
// Ante error de red, credenciales o schema, `readKey()` devuelve `null`. En la
// allowlist eso hace caer `getPipelineMode()` en `mode: 'running'` y
// `isIssueAllowedInState` DENIEGA (fail-closed post-#5060). El fallback a
// filesystem está PROHIBIDO: una allowlist local stale no es un dato viejo, es
// una autorización revocada que vuelve a estar vigente.
//
// LO QUE NO ESTÁ ACÁ (D-3 / SEC-7)
// --------------------------------
// `.paused` — el halt total. Es FS SIEMPRE, con el flag encendido o apagado.
// Es el freno de último recurso y el mecanismo de aborto del propio cutover: si
// viviera en el store, una degradación dejaría al operador sin freno justo en
// el peor momento. `pauseFile()` no pasa por este módulo, y hay un test
// negativo que falla si la clave aparece en `KEYS` o en `SOURCES` del migrador.
//
// EL STORE ES SUSTRATO, NO API DE MUTACIÓN (D-5)
// ----------------------------------------------
// Las capas, de arriba hacia abajo:
//     setPartialPauseAtomic()      <- autoría + justificación (#3625)
//       |- evaluateAndAudit()      <- audit trail; rechaza removals sin authorizedBy
//            |- backend.writeKey() <- ESTE módulo: CAS con expectedVersion
//                 |- driverSync.putItem(..., ConditionExpression)
// Invertir el orden (llamar `compareAndSet` directo) deja el gate de #3625
// decorativo. Este módulo no valida autoría a propósito: no es su capa.
// =============================================================================

const fs = require('node:fs');
const path = require('node:path');

// Los helpers del store de coordinación se requieren LAZY a propósito: cargarlo
// arrastra Ajv + la compilación del schema del kernel, y con el flag apagado
// (régimen normal hoy) ese costo no se paga ni una vez. `waves.js` requiere este
// módulo en su top-level, así que ese costo lo pagaría todo el pipeline.
function coord() {
    // eslint-disable-next-line global-require
    return require('./kernel-coordination-store');
}

// ─── Claves y mapeo a archivo ───────────────────────────────────────────────

/**
 * Claves del estado operativo. El mapeo clave ↔ archivo es LITERAL y cerrado:
 * nunca se deriva de input. `.paused` NO está y no puede estar (D-3).
 */
const KEYS = Object.freeze({
    WAVES: 'waves',
    PARTIAL_PAUSE: 'partial-pause',
});

const FILE_FOR_KEY = Object.freeze({
    [KEYS.WAVES]: 'waves.json',
    [KEYS.PARTIAL_PAUSE]: '.partial-pause.json',
});

// ─── Cotas del payload remoto (CA-A5) ───────────────────────────────────────
//
// La cota de bytes se aplica sobre el stdout CRUDO del CLI, ANTES del
// `JSON.parse`, y es POR CLAVE (rev-6): la clave se deriva del `SK` de los
// propios args del `get-item` (`coord#<key>`, generado por `skFor`), no del
// contenido de la respuesta. Antes la cota pre-parse era GLOBAL —el máximo de
// todas las claves— así que un `partial-pause` de 200 KB se parseaba entero y
// recién después `validateRemoteValue` lo rechazaba por su cota de 64 KB. El
// punto de CA-A5 es no parsear lo sobredimensionado, no rechazarlo tarde.
//
// La de la allowlist mantiene paridad con `MAX_PAUSE_MARKER_BYTES` (64 KB,
// #5399); la del registro de olas es más holgada porque el archivo real ronda
// los 31 KB y crece con la historia de olas, pero queda MUY por debajo del
// límite de 400 KB por ítem de DynamoDB — que reventaría el write, no la
// lectura.
const MAX_BYTES_FOR_KEY = Object.freeze({
    [KEYS.WAVES]: 300 * 1024,
    [KEYS.PARTIAL_PAUSE]: 64 * 1024,
});

// Sobre el envelope completo devuelto por la CLI (ítem + metadata del store).
const RESPONSE_BYTES_MARGIN = 32 * 1024;

// Cotas de cardinalidad de la allowlist. Un `allowed_issues` con 50k entradas
// no es un estado válido: es una allowlist envenenada o un ítem de otro origen.
const MAX_ALLOWED_ISSUES = 500;
const MAX_ALLOWED_SKILLS = 100;

// Cotas del registro de olas (mismo criterio, aplicado a sus colecciones).
const MAX_WAVES_PER_BUCKET = 500;

// ─── Flag ÚNICO de cutover (CA-C1) ──────────────────────────────────────────
//
// `operational_state.durable`. Gatea LECTURA y ESCRITURA a la vez: no hay un
// flag de lectura y otro de escritura, justamente para que no puedan coexistir
// dos fuentes de verdad ni un instante.
//
// Estricto con `=== true`, mismo criterio que `project-context.js:222-224`:
// `"true"`, `1` o `"1"` en el YAML NO encienden nada. Un flag que mueve dónde
// vive el registro de olas no se prende por coerción accidental.
//
// `PIPELINE_OPSTATE_DURABLE` (1/0) fuerza el valor sin tocar config — lo usan
// los tests y sirve para el ensayo de rollback en caliente (R8: bajar el flag
// y reiniciar toma minutos).

let configCache = null;

// #5113 rev-8 — `readConfig()` distingue tres cosas que antes colapsaba en una:
//
//   1. config resuelta            → `{cfg, error:null}`, se CACHEA.
//   2. config AUSENTE             → el resolver tira con `causa: 'ENOENT'` y el
//                                   archivo efectivamente no está. Es el estado
//                                   legítimo pre-cutover (tmpdirs de test,
//                                   checkouts sin config): modo filesystem, y se
//                                   CACHEA porque es un hecho estable.
//   3. config ILEGIBLE            → el resolver tira por cualquier otra causa:
//                                   YAML mal parseado, schema inválido, ruta que
//                                   no es un archivo regular, o un `open` que
//                                   falla con el archivo PRESENTE (lock/EACCES).
//                                   NO se cachea y NO se resuelve a filesystem.
//
// El caso 3 era el agujero: se tragaba el error, devolvía `cfg:null` y lo
// CACHEABA. `isRemote()` pasaba a `false` para SIEMPRE (el caché es por proceso
// y nadie lo invalida en caliente) mientras el resto de la flota seguía
// escribiendo en el store remoto: dos fuentes de verdad y el flag de cutover
// apagándose solo, por la puerta de atrás de CA-C1. Un YAML corrupto de un
// segundo — un editor guardando a medias — dejaba ese proceso desincronizado
// hasta el próximo restart, sin una sola línea de log.
//
// El discriminador es `err.causa` (`ConfigParseViolation`), no el mensaje.
// `causa: 'ENOENT'` se re-verifica contra el filesystem a propósito: el
// resolver etiqueta así CUALQUIER `openSync` fallido, así que un config
// bloqueado o sin permisos llegaría disfrazado de ausente — que es justo el
// caso "lock de archivo" que no puede degradar a filesystem en silencio.
function configErrorIsAbsence(err) {
    if (!err || err.causa !== 'ENOENT') return false;
    if (!err.archivo) return true;   // sin path no se puede refutar: se cree.
    try {
        // Presente pero no abrible ⇒ ilegible, NO ausente.
        return !fs.existsSync(err.archivo);
    } catch {
        return false;
    }
}

function readConfig() {
    if (configCache) return configCache;
    let cfg = null;
    let error = null;
    try {
        // Lazy-require deliberado y caché por proceso: el resolver arrastra
        // js-yaml + ajv y este módulo se consulta en el camino caliente de
        // resolución del estado. Mismo patrón que `project-context.js`.
        // eslint-disable-next-line global-require
        cfg = require('./config-resolver').resolve({ pipelineDir: pipelineDir() });
    } catch (err) {
        cfg = null;
        // Config ausente ⇒ pre-cutover legítimo, sin `error`: el modo se
        // resuelve por el default (filesystem) igual que siempre.
        error = configErrorIsAbsence(err) ? null : err;
    }
    const result = { cfg, error };
    // Un fallo NO se memoiza: la config puede volver (el editor termina de
    // guardar, el lock se libera) y el proceso tiene que poder enterarse sin
    // reiniciar. Sólo el resultado estable (sano o ausencia confirmada) se cachea.
    if (!error) configCache = result;
    return result;
}

/**
 * Error a devolver cuando la config del pipeline es ILEGIBLE: no se puede
 * decidir dónde vive el estado operativo, así que no se lee ni se escribe en
 * ningún lado. Fail-closed puro (CA-A7): elegir filesystem "por default" sería
 * elegir la fuente de verdad equivocada justo cuando no se sabe cuál es.
 *
 * `.paused` NO pasa por este módulo (es filesystem SIEMPRE, D-3/SEC-7), así que
 * el halt de último recurso sigue disponible con la config rota.
 *
 * @returns {Error|null}
 */
function configFailure() {
    // El override por env es una decisión EXPLÍCITA del operador sobre dónde
    // vive el estado: no necesita la config para nada y tiene que seguir
    // funcionando con el YAML roto (es la herramienta del rollback en caliente).
    const env = process.env.PIPELINE_OPSTATE_DURABLE;
    if (env === '1' || env === '0') return null;
    const { error } = readConfig();
    if (!error) return null;
    const err = new Error(
        `config del pipeline ILEGIBLE: no se puede determinar el sustrato del estado `
        + `operativo (CA-C1): ${error.message}. No se lee ni se escribe estado hasta `
        + `resolverlo — caer a filesystem por default sería elegir la fuente de verdad `
        + `equivocada mientras la flota puede estar en remoto.`
    );
    err.opstateKind = 'config';
    err.cause = error;
    return err;
}

function pipelineDir() {
    if (process.env.PIPELINE_DIR_OVERRIDE) return process.env.PIPELINE_DIR_OVERRIDE;
    return path.join(__dirname, '..');
}

/** Invalida el caché de config (tests / recarga en caliente). */
function invalidateConfigCache() {
    configCache = null;
    versionIndex.clear();
    driverCache = null;
    invalidateReadCache();
}

/**
 * ¿El estado operativo vive en el store remoto? PURA respecto del store: sólo
 * mira el flag. Fail-closed hacia el comportamiento CONOCIDO (filesystem).
 * @returns {boolean}
 */
function isRemote() {
    const env = process.env.PIPELINE_OPSTATE_DURABLE;
    if (env === '1') return true;
    if (env === '0') return false;
    const { cfg } = readConfig();
    const os = cfg && cfg.operational_state;
    return !!(os && os.durable === true);
}

/**
 * Descripción del modo vigente, para el operador y para el dashboard (CA-UX1).
 * NUNCA lee el YAML por su cuenta: expone el flag EFECTIVO del runtime, que es
 * distinto del valor del archivo cuando hay override por env.
 * @returns {{mode:'remote'|'fs', source:'env'|'config', degraded:boolean, lastError:string|null}}
 */
function describeMode() {
    const env = process.env.PIPELINE_OPSTATE_DURABLE;
    const source = (env === '1' || env === '0') ? 'env' : 'config';
    return {
        mode: isRemote() ? 'remote' : 'fs',
        source,
        degraded: lastDegradation !== null,
        lastError: lastDegradation ? lastDegradation.cause : null,
    };
}

// ─── Resolución de paths (modo filesystem) ──────────────────────────────────

function stateDir() { return require('./project-context').stateDir(); }

/**
 * Guarda de vocabulario del estado operativo. `FILE_FOR_KEY` es la allowlist
 * CERRADA de claves; nada fuera de ella entra al backend por ningún sustrato.
 *
 * #5113 (rev-6) — se aplica ANTES de bifurcar entre filesystem y remoto. Antes
 * la única guarda efectiva era `fileFor()`, que sólo corre en el branch local:
 * con el flag encendido una clave desconocida llegaba hasta el store, y
 * `validateRemoteValue` la dejaba pasar sin cota de bytes (`MAX_BYTES_FOR_KEY`
 * indefinido para esa clave). La cota es la defensa de CA-A5 y no puede
 * depender de qué sustrato esté activo.
 *
 * Lanza (no devuelve false) a propósito: una clave fuera del vocabulario es un
 * bug de programación, no un estado de runtime que haya que tolerar.
 *
 * @param {string} key
 */
function assertKnownKey(key) {
    if (!Object.prototype.hasOwnProperty.call(FILE_FOR_KEY, key)) {
        throw new Error(`operational-state-backend: clave de estado desconocida: ${JSON.stringify(key)}`);
    }
}

function fileFor(key) {
    assertKnownKey(key);
    return path.join(stateDir(), FILE_FOR_KEY[key]);
}

// ─── Degradación (CA-A7 / CA-C5 / CA-UX3 / CA-UX5) ──────────────────────────
//
// El canal de aviso YA EXISTE (`kernel-degradation-alert.js`: template fijo,
// correlation id, rate-limit por causa y aborto-con-`.paused` cuando la ventana
// de cutover está abierta). Se reusa; NO se emite un `sendTelegram` nuevo para
// este hecho (CA-UX3).

let lastDegradation = null;
let degradationSink = null;

/** Inyecta el sink (tests / cableado del pulpo). */
function setDegradationSink(sink) { degradationSink = sink; }

/** Último evento de degradación observado (null si nunca degradó). */
function getLastDegradation() { return lastDegradation; }

/** Limpia el rastro de degradación (tests / tras una lectura exitosa). */
function clearDegradation() { lastDegradation = null; }

function resolveSink() {
    if (degradationSink) return degradationSink;
    try {
        const { createDegradationSink } = require('./kernel-degradation-alert');
        const { cfg } = readConfig();
        degradationSink = createDegradationSink({
            config: cfg || {},
            operationalState: true,
            sendTelegram: (message) => require('./notify-telegram').notifyTelegram({
                level: 'error', component: 'operational-state', message,
            }),
            // El halt queda en FS y no reemplaza una pausa de otro origen.
            halt: ({ cause, correlationId }) => {
                try {
                    fs.writeFileSync(path.join(pipelineDir(), '.paused'), JSON.stringify({
                        source: 'kernel-cutover-degraded-halt',
                        ts: new Date().toISOString(), cause, correlationId,
                    }), { flag: 'wx', mode: 0o600 });
                    return { markerWritten: true, preexisting: false };
                } catch (err) {
                    if (err.code === 'EEXIST') return { markerWritten: false, preexisting: true };
                    throw err; // El sink registra el fallo sin propagarlo al gate.
                }
            },
            log: (message) => console.warn(message),
            redact: (message) => require('./redact').redactSecretValue(message),
        });
    } catch {
        degradationSink = { onDegraded: () => {} };
    }
    return degradationSink;
}

function reportDegradation(err, stage) {
    let cause = 'desconocido';
    try {
        cause = require('./kernel-degradation-alert').classifyDegradation(err);
    } catch { /* la clasificación no puede tumbar el gate */ }
    lastDegradation = { cause, stage, at: Date.now() };
    try {
        const sink = resolveSink();
        if (sink && typeof sink.onDegraded === 'function') {
            sink.onDegraded(err, { stage: `opstate:${stage}` });
        }
    } catch { /* el sink NUNCA propaga: un fallo del canal no frena el pipeline */ }
}

// ─── Driver síncrono ────────────────────────────────────────────────────────

let driverCache = null;

/**
 * Construye (LAZY, una vez por proceso) el driver síncrono contra la tabla de
 * coordinación. Con el flag apagado NUNCA se llega acá: cero llamadas a AWS.
 */
/**
 * CA-B2 / CA-A4 — En regimen remoto la exclusion mutua la da el CAS, y el CAS
 * SOLO existe si el driver soporta escrituras condicionales.
 * `buildCasWriteOptions()` devuelve `{}` cuando `atomicUpdate` es falso: la
 * escritura sale SIN condicion, o sea a ciegas, apoyada nada mas que en la
 * lectura previa — que entre hosts no excluye nada.
 *
 * Eso es peor que no tener garantia: SIMULA una que no existe, y el lost update
 * vuelve en silencio. Por eso se verifica en el punto de uso y no se asume por
 * como quedo armado el driver: hoy `resolveDriver()` lo afirma explicito, pero
 * `kernel-coordination-store.js` lo DERIVA de `!isInMemory`, y un driver futuro
 * que repita esa derivacion degradaria el CAS sin que nadie se entere.
 *
 * Fail-closed: se rechaza la escritura. No se escribe a ciegas.
 *
 * @returns {Error|null} el error a devolver, o `null` si hay garantia.
 */
function casGuard(atomicUpdate, op) {
    if (atomicUpdate === true) return null;
    return new Error(
        `operational-state-backend: ${op} rechazada (CA-B2, fail-closed). El driver no `
        + 'declara `atomicUpdate: true`, asi que la escritura saldria SIN ConditionExpression: '
        + 'un write ciego que simula una exclusion inexistente y reabre el lost update entre '
        + 'instancias. Verificar el soporte de escritura condicional antes del cutover.',
    );
}

function resolveDriver() {
    if (driverCache) return driverCache;
    const { cfg } = readConfig();
    const kernel = (cfg && cfg.kernel) || {};
    const tableName = kernel.coordinationTableName;
    if (typeof tableName !== 'string' || !tableName) {
        throw new Error(
            'operational-state-backend: falta `kernel.coordinationTableName` en '
            + '.pipeline/config.yaml. Es requerido para el driver real (fail-closed): '
            + 'sin esa clave el estado operativo remoto no tiene destino.',
        );
    }
    const {
        createAwsCliRunnerSync,
        createAwsCliDynamoDriverSync,
    } = require('./provisioner-infra');

    const env = resolveAwsEnv();
    const { runSync } = createAwsCliRunnerSync(env);

    // CA-A5 · La cota de bytes se aplica ANTES del `JSON.parse`: el guard
    // envuelve al runner, así que un stdout sobredimensionado nunca llega al
    // parser. Es la diferencia entre rechazar un ítem y parsearlo para después
    // decidir que era muy grande. La cota es POR CLAVE (rev-6), derivada del
    // `SK` de los args: con la cota global, un `partial-pause` de 200 KB se
    // parseaba igual porque el máximo lo fijaba `waves`.
    const guardedRunSync = (args) => {
        const res = runSync(args);
        const stdout = (res && res.stdout) || '';
        const key = keyFromCliArgs(args);
        const cap = maxResponseBytesFor(key);
        if (stdout.length > cap) {
            return {
                code: 1,
                stdout: '',
                stderr: `operational-state-backend: respuesta de ${stdout.length} bytes supera la cota `
                    + `de ${cap} para \`${key || 'clave-desconocida'}\` (CA-A5, fail-closed): NO se parsea.`,
            };
        }
        return res;
    };

    driverCache = {
        driver: createAwsCliDynamoDriverSync({ runSync: guardedRunSync }),
        spec: {
            type: 'dynamodb_table',
            tableName,
            keys: [
                { name: 'PK', attributeType: 'S', keyType: 'HASH' },
                { name: 'SK', attributeType: 'S', keyType: 'RANGE' },
            ],
        },
        projectId: resolveProjectId(),
        instanceId: resolveProjectId(),
        // CA-B2 · el CAS atómico por `ConditionExpression` sólo vale con el
        // driver real. Se afirma explícito, no se deriva de `!isInMemory`: sin
        // él, `compareAndSet` se apoya en la lectura previa monohilo y entre
        // hosts no excluye nada.
        atomicUpdate: true,
    };
    return driverCache;
}

/**
 * Env del scope `aws` para el runner. NUNCA `process.env` crudo: se delega en
 * `kernel-runtime-credentials`, que es el dueño de la resolución (env estático
 * o perfil declarado en `kernel.runtimeProfile`) y su fail-closed. Si no
 * resuelve, se propaga el error accionable tal cual — el runner lo rechazaría
 * igual, pero con un mensaje menos útil para el operador.
 */
function resolveAwsEnv() {
    const { cfg } = readConfig();
    const kernel = (cfg && cfg.kernel) || {};
    // eslint-disable-next-line global-require
    const res = require('./kernel-runtime-credentials').resolveRuntimeAwsEnv({ kernel });
    if (!res || !res.ok) {
        throw new Error(
            `operational-state-backend: credenciales AWS del runtime no resueltas (${(res && res.code) || 'desconocido'}). `
            + `${(res && res.error) || ''}`.trim(),
        );
    }
    return res.env;
}

/**
 * Partición del estado remoto. Es el `projectId` del contexto (#5110): el
 * estado remoto queda namespaceado por proyecto igual que el local (CA-B5).
 * Fail-closed: sin contexto resuelto no se escribe en una partición adivinada.
 */
function resolveProjectId() {
    // eslint-disable-next-line global-require
    const projectId = require('./project-context').currentProjectIdOrNull();
    if (!projectId) {
        throw new Error(
            'operational-state-backend: no hay contexto de proyecto resuelto. El estado remoto '
            + 'se particiona por `projectId` (#5110 / CA-B5) y NO se escribe en una partición '
            + 'adivinada. Revisá `operational_state.namespaced` y el binding de spawn.',
        );
    }
    return projectId;
}

/**
 * Cota de stdout para una clave concreta. Fail-closed: una clave que no
 * reconocemos cae en la cota MÁS RESTRICTIVA, nunca en la más holgada.
 * @param {string|null} key
 * @returns {number}
 */
function maxResponseBytesFor(key) {
    const known = MAX_BYTES_FOR_KEY[key];
    const base = typeof known === 'number'
        ? known
        : Math.min(...Object.values(MAX_BYTES_FOR_KEY));
    return base + RESPONSE_BYTES_MARGIN;
}

/**
 * Clave del estado operativo a la que apunta una invocación de la CLI. Se lee
 * del `SK` (`coord#<key>`) que nosotros mismos construimos con `skFor`, así que
 * el dato NO viene de la respuesta del store. Devuelve `null` si no se puede
 * determinar ⇒ el caller aplica la cota más restrictiva. PURA.
 * @param {string[]} args
 * @returns {string|null}
 */
function keyFromCliArgs(args) {
    if (!Array.isArray(args)) return null;
    const i = args.indexOf('--key');
    if (i < 0 || typeof args[i + 1] !== 'string') return null;
    const m = /"SK"\s*:\s*\{\s*"S"\s*:\s*"coord#([^"]+)"/.exec(args[i + 1]);
    return m ? m[1] : null;
}

/** Inyección del driver para tests (evita spawnear la CLI). */
function _setDriverForTests(fake) {
    driverCache = fake;
    // Cambiar el sustrato bajo los pies invalida cualquier lectura memoizada.
    invalidateReadCache();
}

// ─── Validación del payload remoto (CA-A5) ──────────────────────────────────

/**
 * Valida el VALOR leído del store contra las cotas de la clave. PURA.
 * Fail-closed: cualquier violación devuelve `{ ok:false, reason }` y el valor
 * se descarta — nunca se acepta "la parte buena".
 *
 * @param {string} key
 * @param {*} value
 * @returns {{ok:boolean, reason?:string}}
 */
function validateRemoteValue(key, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, reason: 'el valor remoto no es un objeto' };
    }
    const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
    // Defensa en profundidad (rev-6): `assertKnownKey` ya filtra el vocabulario
    // aguas arriba, pero esta función es PURA y exportada — si la llaman con una
    // clave que no conoce, la cota tiene que ser la MÁS RESTRICTIVA, jamás
    // `undefined` (que dejaba el payload sin cota alguna).
    const cap = typeof MAX_BYTES_FOR_KEY[key] === 'number'
        ? MAX_BYTES_FOR_KEY[key]
        : Math.min(...Object.values(MAX_BYTES_FOR_KEY));
    if (bytes > cap) {
        return { ok: false, reason: `payload de ${bytes} bytes supera la cota de ${cap} para \`${key}\`` };
    }
    if (key === KEYS.PARTIAL_PAUSE) {
        if (value.allowed_issues !== undefined && !Array.isArray(value.allowed_issues)) {
            return { ok: false, reason: 'allowed_issues no es un array' };
        }
        if (Array.isArray(value.allowed_issues) && value.allowed_issues.length > MAX_ALLOWED_ISSUES) {
            return { ok: false, reason: `allowed_issues con ${value.allowed_issues.length} entradas supera la cota de ${MAX_ALLOWED_ISSUES}` };
        }
        if (value.allowed_skills !== undefined && !Array.isArray(value.allowed_skills)) {
            return { ok: false, reason: 'allowed_skills no es un array' };
        }
        if (Array.isArray(value.allowed_skills) && value.allowed_skills.length > MAX_ALLOWED_SKILLS) {
            return { ok: false, reason: `allowed_skills con ${value.allowed_skills.length} entradas supera la cota de ${MAX_ALLOWED_SKILLS}` };
        }
    }
    if (key === KEYS.WAVES) {
        for (const bucket of ['planned_waves', 'archived_waves', 'dependencies']) {
            const v = value[bucket];
            if (v !== undefined && !Array.isArray(v)) {
                return { ok: false, reason: `${bucket} no es un array` };
            }
            if (Array.isArray(v) && v.length > MAX_WAVES_PER_BUCKET) {
                return { ok: false, reason: `${bucket} con ${v.length} entradas supera la cota de ${MAX_WAVES_PER_BUCKET}` };
            }
        }
    }
    return { ok: true };
}

// ─── Redacción antes de escribir (CA-A9) ────────────────────────────────────
//
// `justification` y `source` son campos de TEXTO LIBRE que llegan desde
// Telegram. `redactSecretValue` sólo toca lo que parece secreto (regex por
// proveedor + alta entropía): "add issue #123 → wave 5" queda intacto. Es la
// misma redacción que `waves.js:2110-2111` ya aplica sobre `meta.source` /
// `meta.note` en el camino de filesystem — acá se replica para que el sustrato
// remoto no quede con menos garantía que el local.

const REDACTED_FIELDS = new Set(['justification', 'source', 'note', 'reason', 'detail']);

function redactBeforeWrite(value) {
    let redactSecretValue;
    try {
        ({ redactSecretValue } = require('./redact'));
    } catch {
        return value; // sin el módulo, se escribe tal cual (no se pierde el write).
    }
    if (typeof redactSecretValue !== 'function') return value;

    const seen = new WeakSet();
    const walk = (node) => {
        if (Array.isArray(node)) return node.map(walk);
        if (!node || typeof node !== 'object') return node;
        if (seen.has(node)) return node;
        seen.add(node);
        const out = {};
        for (const [k, v] of Object.entries(node)) {
            if (typeof v === 'string' && REDACTED_FIELDS.has(k)) {
                out[k] = redactSecretValue(v);
            } else {
                out[k] = walk(v);
            }
        }
        return out;
    };
    return walk(value);
}

// ─── Mapeo de versión ISO ↔ entero (CA-A6) ──────────────────────────────────
//
// El registro de olas versiona con `meta.updated_at` (string ISO) y ~20 callers
// lo devuelven tal cual en `version` / `If-Match`. El coordination store
// versiona con un entero incremental, que en modo remoto es el AUTORITATIVO.
//
// El índice mantiene el par vigente por clave; el ISO se preserva DENTRO del
// value (no se pierde), y el entero es el que va al `ConditionExpression`.
// Traducir un ISO que ya no es el vigente devuelve `null` ⇒ el CAS falla por
// conflicto, que es exactamente lo que un If-Match stale tiene que producir.

const versionIndex = new Map(); // key -> { intVersion, isoVersion }

// ─── Caché TTL de la lectura remota (#5113 rev-6) ───────────────────────────
//
// POR QUÉ EXISTE: en modo remoto cada `readKeyWithVersion` es un `spawnSync` de
// la AWS CLI (~cientos de ms, BLOQUEANTE). El call-site caliente del despacho
// (`pulpo.js`, `isIssueAllowed(issue)` dentro del `for (const candidate of
// candidates)`) lo invocaría una vez por candidato: con N candidatos son hasta
// 2N spawns bloqueantes por tick del Pulpo. El diseño original daba por hecho
// esta memoización; no existía.
//
// TTL DE 2 s: la MISMA ventana que `waves.js` ya aplica sobre el registro de
// olas en filesystem, así que no introduce una staleness nueva de la que el
// pipeline no dependa ya. Para la allowlist, 2 s de retraso frente a un cambio
// del operador por Telegram es irrelevante.
//
// FAIL-CLOSED: sólo se cachean lecturas SANAS (`degraded === false`). Un error
// de red o de schema NUNCA se memoiza — se reintenta en la llamada siguiente,
// porque cachear una degradación extendería una denegación más allá del
// incidente real. Toda escritura o borrado invalida la clave: el CAS lee del
// store directo (`driver.getItem`), nunca de acá, así que la versión que va al
// `ConditionExpression` siempre es fresca.

const REMOTE_READ_TTL_MS = 2000;
const remoteReadCache = new Map(); // key -> { at:number, result:object }

function readTtlMs() {
    const raw = Number(process.env.PIPELINE_OPSTATE_READ_TTL_MS);
    if (Number.isFinite(raw) && raw >= 0) return raw;
    return REMOTE_READ_TTL_MS;
}

/** Memoiza SÓLO lecturas sanas y devuelve el mismo resultado. */
function rememberRead(key, result) {
    if (readTtlMs() > 0 && result && result.degraded === false) {
        remoteReadCache.set(key, { at: Date.now(), result });
    }
    return result;
}

/** Invalida la memoización de lectura (una clave, o todas si no se pasa). */
function invalidateReadCache(key) {
    if (key === undefined) remoteReadCache.clear();
    else remoteReadCache.delete(key);
}

/** ISO de versión que transporta un value de estado. PURA. */
function isoVersionOf(value) {
    return (value && value.meta && typeof value.meta.updated_at === 'string')
        ? value.meta.updated_at
        : null;
}

function rememberVersion(key, intVersion, value) {
    versionIndex.set(key, { intVersion, isoVersion: isoVersionOf(value) });
}

/** Par de versión vigente conocido para la clave (o null). PURA sobre el índice. */
function versionPairOf(key) {
    return versionIndex.get(key) || null;
}

/**
 * Traduce el `expectedVersion` que trae el caller al entero del store.
 *
 *   - `null`/`undefined` → `undefined` (el caller no pidió If-Match: se usa la
 *     versión leída en el mismo read-modify-write).
 *   - número            → tal cual.
 *   - string ISO        → el entero del par vigente si coincide; `null` (=
 *                         conflicto) si no.
 *
 * @returns {number|undefined|null}
 */
function toRemoteExpectedVersion(key, expectedVersion) {
    if (expectedVersion === null || expectedVersion === undefined) return undefined;
    if (Number.isInteger(expectedVersion)) return expectedVersion;
    const pair = versionPairOf(key);
    if (!pair) return null;
    return String(pair.isoVersion) === String(expectedVersion) ? pair.intVersion : null;
}

// ─── Lectura ────────────────────────────────────────────────────────────────

/**
 * Lectura de filesystem. El `kind` del error distingue "no se pudo leer" de
 * "no parsea": los callers ya mapean esa diferencia a códigos de dominio
 * distintos (`EWAVES_READ` vs `EWAVES_JSON`) y colapsarlos le daría al operador
 * la acción equivocada (permisos/disco vs restaurar desde `archived/`).
 */
function readFromDisk(file) {
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
        if (err && err.code !== 'ENOENT') {
            err.opstateKind = 'read';
            return { value: null, error: err };
        }
        return { value: null, error: null };
    }
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            const err = new Error('schema inválido: no es objeto');
            err.opstateKind = 'parse';
            return { value: null, error: err };
        }
        return { value: parsed, error: null };
    } catch (err) {
        err.opstateKind = 'parse';
        return { value: null, error: err };
    }
}

/**
 * Lee una clave del estado operativo con su versión.
 *
 * @param {string} key
 * @returns {{value: object|null, version: number|string|null, remote: boolean,
 *            degraded: boolean, error: Error|null}}
 */
function readKeyWithVersion(key) {
    assertKnownKey(key);
    // #5113 rev-8 — config ilegible ⇒ degradación explícita, no modo filesystem
    // silencioso. Los callers ya tratan `degraded` como fail-closed.
    const cfgErr = configFailure();
    if (cfgErr) {
        reportDegradation(cfgErr, `read:${key}`);
        return { value: null, version: null, remote: false, degraded: true, error: cfgErr };
    }
    if (!isRemote()) {
        const { value, error } = readFromDisk(fileFor(key));
        return { value, version: isoVersionOf(value), remote: false, degraded: false, error };
    }
    const ttl = readTtlMs();
    if (ttl > 0) {
        const hit = remoteReadCache.get(key);
        if (hit && (Date.now() - hit.at) < ttl) return hit.result;
    }
    try {
        const { driver, spec, projectId } = resolveDriver();
        const res = driver.getItem(spec, { PK: projectId, SK: coord().skFor(key) });
        const raw = coord().validateCoordinationRawItem(res && res.item, projectId);
        if (!raw) {
            // Ausencia legítima (todavía no migrado / recién borrado): NO es
            // degradación. Es el equivalente remoto de ENOENT.
            versionIndex.delete(key);
            return rememberRead(key, { value: null, version: null, remote: true, degraded: false, error: null });
        }
        const value = raw.body.value;
        const check = validateRemoteValue(key, value);
        if (!check.ok) {
            const err = new Error(`payload remoto rechazado (CA-A5): ${check.reason}`);
            reportDegradation(err, `read:${key}`);
            return { value: null, version: null, remote: true, degraded: true, error: err };
        }
        rememberVersion(key, raw.body.version, value);
        clearDegradation();
        return rememberRead(key, { value, version: raw.body.version, remote: true, degraded: false, error: null });
    } catch (err) {
        // CA-A7 — PROHIBIDO el fallback silencioso a filesystem. Se devuelve
        // `null` y el gate deniega. Una allowlist local stale no es un dato
        // viejo: es una autorización revocada que vuelve a estar vigente.
        reportDegradation(err, `read:${key}`);
        return { value: null, version: null, remote: true, degraded: true, error: err };
    }
}

/**
 * Azúcar sobre `readKeyWithVersion`: devuelve el valor o `null`.
 * @param {string} key
 * @returns {object|null}
 */
function readKey(key) {
    return readKeyWithVersion(key).value;
}

/**
 * Token de versión vigente de la clave. Entero en modo remoto (autoritativo),
 * ISO en modo filesystem.
 * @param {string} key
 * @returns {number|string|null}
 */
function versionOf(key) {
    return readKeyWithVersion(key).version;
}

// ─── Escritura ──────────────────────────────────────────────────────────────

/**
 * #5113 rev-8 — Centinela para declarar una escritura remota INCONDICIONAL.
 *
 * Existe para que "no paso versión porque este write tiene que ganar" y "no paso
 * versión porque me olvidé" dejen de ser el mismo código. Sólo lo usa el
 * rollback de emergencia de `/wave promote`; cualquier otro uso es un bug y se
 * lee como tal en el diff.
 */
const UNCONDITIONAL_WRITE = Symbol('opstate:unconditional-write');

/**
 * Persiste una clave del estado operativo.
 *
 * En modo filesystem delega en el write atómico de siempre (tmp + fsync +
 * rename con retry en Windows). En modo remoto hace CAS con `expectedVersion`:
 * `withLockSync` deja de ser la primitiva de exclusión — es local por PID y
 * entre hosts no excluye NADA, así que simular esa garantía sería peor que no
 * tenerla (CA-A4).
 *
 * @param {string} key
 * @param {object} value
 * @param {number|string|null} [expectedVersion]  entero del store o ISO del caller.
 * @returns {{ok:boolean, conflict?:boolean, version?:number|string|null, error?:Error}}
 */
function writeKey(key, value, expectedVersion) {
    assertKnownKey(key);
    // Toda mutación invalida la memoización de lectura, gane o pierda el CAS:
    // si ganó, el valor cambió; si perdió, el store tiene algo que no vimos.
    invalidateReadCache(key);
    const cfgErr = configFailure();
    if (cfgErr) {
        reportDegradation(cfgErr, `write:${key}`);
        return { ok: false, degraded: true, error: cfgErr };
    }
    if (!isRemote()) {
        const { atomicWriteFile } = require('./waves');
        atomicWriteFile(fileFor(key), JSON.stringify(value, null, 2));
        return { ok: true, version: isoVersionOf(value) };
    }
    // #5113 rev-8 — en modo remoto el `expectedVersion` es OBLIGATORIO.
    //
    // Antes, omitirlo no era un error: el backend rellenaba el hueco con la
    // versión que él mismo acababa de leer, la `ConditionExpression` salía igual
    // y se cumplía SIEMPRE. El CAS quedaba protegiendo la ventana
    // `getItem→putItem` del propio backend (microsegundos, sin carrera real) en
    // vez de la ventana del dominio (`leer previous → evaluar gate → escribir`),
    // que es donde ocurre el lost update entre hosts. Hoy todos los callers de
    // producción lo pasan, pero era un default silencioso: un mutador nuevo
    // reintroducía la carrera de #5113 sin poner un solo test en rojo.
    //
    // La única excepción legítima es el rollback de emergencia
    // (`waves.js:restoreKey`), que tiene que ganar contra la versión que la
    // propia transacción fallida movió. Esa excepción ahora se DECLARA con
    // `UNCONDITIONAL_WRITE` en el call-site, en vez de ser indistinguible de un
    // olvido.
    if (expectedVersion === UNCONDITIONAL_WRITE) {
        expectedVersion = undefined;   // incondicional EXPLÍCITO: usa la versión leída.
    } else if (expectedVersion === undefined || expectedVersion === null) {
        const err = new Error(
            `escritura remota de '${key}' SIN expectedVersion: el CAS quedaría cumpliéndose `
            + `siempre y la carrera del dominio (leer → decidir → escribir) sin proteger `
            + `(CA-A4). Pasá la versión del snapshot que alimentó la decisión, o `
            + `UNCONDITIONAL_WRITE si es un rollback de emergencia.`
        );
        err.opstateKind = 'cas';
        reportDegradation(err, `write:${key}`);
        return { ok: false, error: err };
    }
    const payload = redactBeforeWrite(value);
    const check = validateRemoteValue(key, payload);
    if (!check.ok) {
        // Fail-closed también en el write: no se escribe un ítem que después no
        // se podría leer (la cota de lectura lo rechazaría y el estado quedaría
        // ilegible para todas las instancias).
        const err = new Error(`escritura remota rechazada (CA-A5): ${check.reason}`);
        reportDegradation(err, `write:${key}`);
        return { ok: false, error: err };
    }
    try {
        const { driver, spec, projectId, instanceId, atomicUpdate } = resolveDriver();

        const sinCas = casGuard(atomicUpdate, 'escritura remota');
        if (sinCas) {
            reportDegradation(sinCas, `write:${key}`);
            return { ok: false, error: sinCas };
        }

        // Read-modify-write: la versión actual sale del store, no de un caché.
        const res = driver.getItem(spec, { PK: projectId, SK: coord().skFor(key) });
        const cur = coord().validateCoordinationRawItem(res && res.item, projectId);
        const currentVersion = cur ? cur.body.version : 0;

        const mapped = toRemoteExpectedVersion(key, expectedVersion);
        if (mapped === null) {
            // If-Match stale: el ISO que trae el caller no es el vigente.
            return { ok: false, conflict: true, version: currentVersion };
        }
        const expected = mapped === undefined ? currentVersion : mapped;
        if (expected !== currentVersion) {
            return { ok: false, conflict: true, version: currentVersion };
        }

        const nextVersion = currentVersion + 1;
        const item = coord().buildCoordinationEnvelope({
            projectId, key, value: payload, version: nextVersion, instanceId, updatedAt: Date.now(),
        });
        coord().assertCoordinationWritable(item);

        // El CAS es la exclusión real entre hosts. `currentVersion === 0`
        // significa "no existe": la condición es `attribute_not_exists(PK)`,
        // que da un único ganador en la creación.
        // `currentVersion === 0` significa "no existe": la condición de
        // creación viene del helper COMPARTIDO del coordination store
        // (`buildCreateOnceWriteOptions`), no de una copia local — dos
        // definiciones del mismo `attribute_not_exists` divergen y una de las
        // dos pierde el ganador único (#5113 rev-6).
        const opts = currentVersion === 0
            ? coord().buildCreateOnceWriteOptions()
            : coord().buildCasWriteOptions(currentVersion, atomicUpdate);

        driver.putItem(spec, item, opts);
        rememberVersion(key, nextVersion, payload);
        clearDegradation();
        return { ok: true, version: nextVersion };
    } catch (err) {
        if (err && err.name === 'ConditionalCheckFailedError') {
            return { ok: false, conflict: true, version: versionPairOf(key) ? versionPairOf(key).intVersion : null };
        }
        reportDegradation(err, `write:${key}`);
        return { ok: false, error: err };
    }
}

/**
 * Borra una clave del estado operativo (equivalente a `unlink` del marker).
 *
 * @param {string} key
 * @param {number|string|null} [expectedVersion]
 * @returns {{ok:boolean, existed:boolean, conflict?:boolean, error?:Error}}
 */
function deleteKey(key, expectedVersion) {
    assertKnownKey(key);
    invalidateReadCache(key);
    const cfgErr = configFailure();
    if (cfgErr) {
        reportDegradation(cfgErr, `delete:${key}`);
        return { ok: false, existed: false, degraded: true, error: cfgErr };
    }
    if (!isRemote()) {
        const file = fileFor(key);
        const existed = fs.existsSync(file);
        if (existed) {
            try { fs.unlinkSync(file); } catch { /* best-effort, igual que antes */ }
        }
        return { ok: true, existed };
    }
    try {
        const { driver, spec, projectId, atomicUpdate } = resolveDriver();

        const sinCas = casGuard(atomicUpdate, 'baja remota');
        if (sinCas) {
            reportDegradation(sinCas, `delete:${key}`);
            return { ok: false, existed: false, error: sinCas };
        }

        const res = driver.getItem(spec, { PK: projectId, SK: coord().skFor(key) });
        const cur = coord().validateCoordinationRawItem(res && res.item, projectId);
        if (!cur) {
            versionIndex.delete(key);
            return { ok: true, existed: false };
        }
        const currentVersion = cur.body.version;
        const mapped = toRemoteExpectedVersion(key, expectedVersion);
        if (mapped === null || (mapped !== undefined && mapped !== currentVersion)) {
            return { ok: false, existed: true, conflict: true };
        }
        driver.deleteItem(spec, { PK: projectId, SK: coord().skFor(key) },
            coord().buildCasWriteOptions(currentVersion, atomicUpdate));
        versionIndex.delete(key);
        clearDegradation();
        return { ok: true, existed: true };
    } catch (err) {
        if (err && err.name === 'ConditionalCheckFailedError') {
            return { ok: false, existed: true, conflict: true };
        }
        reportDegradation(err, `delete:${key}`);
        return { ok: false, existed: false, error: err };
    }
}

/**
 * ¿Existe la clave? Equivalente de `fs.existsSync` en los dos modos.
 *
 * #5113 rev-8 — con la config ilegible devuelve `false`: no se puede afirmar
 * existencia sobre un sustrato que no se sabe cuál es. Los callers usan esto
 * para reportar, no para autorizar (los gates van por `readKeyWithVersion`).
 */
function existsKey(key) {
    assertKnownKey(key);
    if (configFailure()) return false;
    if (!isRemote()) return fs.existsSync(fileFor(key));
    return readKeyWithVersion(key).value !== null;
}

module.exports = {
    KEYS,
    FILE_FOR_KEY,
    MAX_BYTES_FOR_KEY,
    MAX_ALLOWED_ISSUES,
    MAX_ALLOWED_SKILLS,
    isRemote,
    describeMode,
    fileFor,
    assertKnownKey,
    // #5113 (rev-6) — memoización de la lectura remota (2 s) y su invalidación.
    invalidateReadCache,
    REMOTE_READ_TTL_MS,
    readKey,
    readKeyWithVersion,
    writeKey,
    // #5113 rev-8 — centinela del write incondicional (rollback de emergencia).
    UNCONDITIONAL_WRITE,
    deleteKey,
    existsKey,
    versionOf,
    // Puras, exportadas para test de contrato:
    validateRemoteValue,
    maxResponseBytesFor,
    keyFromCliArgs,
    redactBeforeWrite,
    isoVersionOf,
    versionPairOf,
    toRemoteExpectedVersion,
    // Degradación / cableado:
    setDegradationSink,
    getLastDegradation,
    clearDegradation,
    invalidateConfigCache,
    _setDriverForTests,
};

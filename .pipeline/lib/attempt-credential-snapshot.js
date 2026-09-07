// =============================================================================
// attempt-credential-snapshot.js — Frontera de credenciales POR INTENTO (#5799)
//
// **Qué resuelve**: hasta ahora el material de credenciales de los hijos salía
// de `process.env` del Pulpo, hidratado UNA vez en el boot
// (`hydrate-provider-env.js`). Ese diseño tiene tres consecuencias que este
// módulo cierra:
//
//   1. Rotación — una credencial rotada no llega a los hijos hasta reiniciar el
//      Pulpo, porque el padre conserva la versión que leyó al arrancar.
//   2. Aislamiento — el material de TODOS los providers coexiste en el proceso
//      padre; que el hijo no lo reciba depende únicamente del filtro de salida.
//   3. Identidad de intento — primario, reintento y fallback comparten la misma
//      fuente mutable, así que un objeto reutilizado entre intentos puede
//      arrastrar la credencial del provider anterior.
//
// **Cómo lo resuelve**: cada INTENTO de lanzamiento (Pulpo, Commander,
// reintento y cada eslabón de fallback) pide su propio snapshot con
// `createCredentialSnapshot()` (#5798) para el provider EFECTIVO ya resuelto, y
// compone con él un `processEnv` NUEVO que se pasa a `buildChildEnv()`. El
// snapshot pertenece a un solo intento: no se cachea, no se muta y no se
// comparte. La frontera de mínimo privilegio sigue siendo `buildChildEnv()` —
// este módulo NO la reemplaza ni cambia su firma pública, sólo decide QUÉ
// objeto entra por `processEnv`.
//
// **Gate de rollout** (`pipeline.credential_snapshot_enabled`, default false):
// con el gate cerrado el módulo devuelve `{ required: false, snapshot: null }`
// y `composeAttemptProcessEnv()` entrega una copia del env base — o sea, el
// comportamiento legacy bit a bit. Es deliberado: `vault.enabled` hoy está en
// `false`, y `createCredentialSnapshot()` con el vault cerrado falla con
// `SNAPSHOT_VAULT_DISABLED`. Hacer fail-closed incondicional dejaría al pipeline
// sin lanzar un solo agente. El fail-closed que piden los criterios de
// aceptación aplica cuando el snapshot es REQUERIDO, que es lo que este gate
// declara.
//
// **Invariantes**:
//   A-1: un intento nunca recibe el objeto de otro intento (identidad distinta).
//   A-2: con snapshot activo, el material de credenciales de providers sale
//        EXCLUSIVAMENTE del snapshot; el env base queda purgado de todas las
//        variables de credenciales de providers declaradas, incluidas las del
//        primario cuando el intento corre con un fallback.
//   A-3: `process.env` nunca se muta ni se expone por referencia.
//   A-4: fail-closed antes del spawn: si el snapshot es requerido y no se pudo
//        emitir, se lanza `AttemptSnapshotError` y el caller aborta el intento.
//   A-5: nada de lo que sale de acá (error, log) contiene valores, hashes ni la
//        serialización del snapshot: sólo nombre lógico, provider, destino y
//        código estable.
// =============================================================================

'use strict';

const {
    PROVIDER_DEFAULT_CREDENTIAL_ENV,
    SYSTEM_ALLOWLIST,
    CREDENTIAL_SCOPES,
} = require('./build-child-env');

// Destinos del catálogo curado de #5798 que corresponden a un spawn del
// pipeline. Se referencian por constante para que un typo sea un error de
// módulo y no un `SNAPSHOT_DESTINATION_UNKNOWN` en runtime.
const SNAPSHOT_DESTINATION = Object.freeze({
    AGENT_CHILD: 'agent-child',
    COMMANDER: 'commander',
});

// Scope único que los destinos de spawn tienen autorizado
// (`SNAPSHOT_DESTINATIONS` de credentials.js). Se declara explícito porque el
// pedido debe nombrarlo.
const SNAPSHOT_SCOPES = Object.freeze(['providers']);

// Providers que autentican FUERA del env (OAuth/CLI login). No exigen material
// en el ambiente del hijo, así que tampoco exigen snapshot: pedirlo sería
// fail-closed sobre una credencial que nadie consume.
const OAUTH_AUTH_MODE = 'oauth';

/** Código estable cuando el fallo no trae uno propio de #5798. */
const ATTEMPT_SNAPSHOT_ERROR = 'ATTEMPT_SNAPSHOT_UNAVAILABLE';

/**
 * Error tipado del intento. Mismo criterio de superficie que
 * `CredentialSnapshotError`: nombres y códigos, jamás valores.
 */
class AttemptSnapshotError extends Error {
    constructor(message, { code, provider, destination } = {}) {
        super(message);
        this.name = 'AttemptSnapshotError';
        this.code = code || ATTEMPT_SNAPSHOT_ERROR;
        this.provider = provider || null;
        this.destination = destination || null;
    }
}

/** Normaliza `credentials_env` (string | array | undefined) a array de nombres. */
function credentialEnvNamesOf(providerEntry) {
    if (!providerEntry || typeof providerEntry !== 'object') return [];
    const raw = providerEntry.credentials_env;
    if (typeof raw === 'string' && raw !== '') return [raw];
    if (Array.isArray(raw)) return raw.filter((n) => typeof n === 'string' && n !== '');
    return [];
}

/**
 * Nombres de variables de entorno que transportan credenciales de ALGÚN
 * provider. Se derivan del `providers` de `agent-models.json` MÁS el mapa de
 * defaults de `build-child-env.js`: una lista escrita a mano se desincroniza el
 * día que se agrega un provider (lección de `providers.groq`, #3353).
 *
 * @param {object} providersCfg sección `providers` de agent-models.json
 * @returns {Set<string>}
 */
function providerCredentialEnvNames(providersCfg = {}) {
    const nombres = new Set();
    for (const v of Object.values(PROVIDER_DEFAULT_CREDENTIAL_ENV)) {
        if (typeof v === 'string' && v !== '') nombres.add(v);
    }
    if (providersCfg && typeof providersCfg === 'object') {
        for (const entry of Object.values(providersCfg)) {
            for (const n of credentialEnvNamesOf(entry)) nombres.add(n);
        }
    }
    return nombres;
}

/** Gate de rollout. Fail-closed: sólo el booleano `true` exacto lo abre. */
function isSnapshotEnabled(config) {
    return !!(config && config.pipeline && config.pipeline.credential_snapshot_enabled === true);
}

/**
 * ¿Este provider consume credencial DESDE EL ENTORNO del hijo?
 *
 * Mismo criterio que `buildChildEnv`: `auth_mode: 'oauth'` autentica afuera
 * (~/.codex, cuenta Google, OAuth Max) y no recibe key ni por `credentials_env`
 * ni por el default. Default-safe: un provider sin `auth_mode` va por el camino
 * api_key.
 */
function providerRequiresCredential(provider, providersCfg = {}) {
    if (!provider || typeof provider !== 'string') return false;
    const entry = (providersCfg && providersCfg[provider]) || {};
    if (entry.auth_mode === OAUTH_AUTH_MODE) return false;
    const declarados = credentialEnvNamesOf(entry);
    if (declarados.length > 0) return true;
    const porDefault = PROVIDER_DEFAULT_CREDENTIAL_ENV[provider];
    return typeof porDefault === 'string' && porDefault !== '';
}

/**
 * ¿El intento REQUIERE snapshot? Es la condición que activa el fail-closed:
 * gate de rollout abierto Y provider efectivo que consume credencial del env.
 */
function isSnapshotRequired({ config, provider, providersCfg } = {}) {
    if (!isSnapshotEnabled(config)) return false;
    return providerRequiresCredential(provider, providersCfg);
}

/**
 * Hidrata el snapshot de UN intento. Devuelve SIEMPRE un objeto nuevo.
 *
 * @param {object}   args
 * @param {string}   args.destination      `SNAPSHOT_DESTINATION.*`
 * @param {string}   args.provider         provider EFECTIVO ya resuelto del intento
 * @param {object}   [args.providersCfg]   sección `providers` de agent-models.json
 * @param {object}   [args.config]         config del pipeline (gate de rollout)
 * @param {string}   [args.pipelineDir]    raíz de `.pipeline` (argumento, no entorno)
 * @param {string}   [args.namespace]      tenant lógico
 * @param {function} [args.logger]         señal local; sólo nombres y códigos
 * @param {function} [args.createSnapshotFn] inyectable para tests
 * @returns {Promise<{required:boolean, snapshot:object|null}>}
 * @throws {AttemptSnapshotError} fail-closed cuando el snapshot es requerido
 */
async function createAttemptSnapshot(args = {}) {
    const {
        destination, provider, providersCfg = {}, config,
        pipelineDir, namespace, logger, createSnapshotFn,
    } = args;
    const senal = typeof logger === 'function' ? logger : () => {};

    if (!isSnapshotRequired({ config, provider, providersCfg })) {
        return { required: false, snapshot: null };
    }

    if (!destination || typeof destination !== 'string') {
        throw new AttemptSnapshotError(
            '[attempt-snapshot] destino de snapshot requerido (agent-child | commander).',
            { provider, destination: null },
        );
    }

    // La API canónica se carga perezosamente: el módulo de credenciales es
    // pesado y con el gate cerrado no hace falta ni requerirlo.
    const crear = typeof createSnapshotFn === 'function'
        ? createSnapshotFn
        : require('./credentials').createCredentialSnapshot;

    let snapshot;
    try {
        snapshot = await crear({
            destination,
            scopes: [...SNAPSHOT_SCOPES],
            provider,
            namespace,
            pipelineDir,
            // El logger del snapshot es silencioso a propósito: la única línea
            // que sale de este camino es la nuestra, ya acotada a códigos.
            logger: () => {},
        });
    } catch (e) {
        const code = (e && e.code) || ATTEMPT_SNAPSHOT_ERROR;
        senal(`[attempt-snapshot] ${code}: snapshot no emitido para destino `
            + `"${destination}" (provider ${provider}) — intento abortado antes del spawn`);
        throw new AttemptSnapshotError(
            `[attempt-snapshot] ${code}: el intento con provider "${provider}" no pudo `
            + `hidratar credenciales para el destino "${destination}". El lanzamiento se aborta `
            + 'antes del spawn (fail-closed).',
            { code, provider, destination },
        );
    }

    if (!snapshot || typeof snapshot !== 'object' || !snapshot.env || typeof snapshot.env !== 'object') {
        senal(`[attempt-snapshot] ${ATTEMPT_SNAPSHOT_ERROR}: snapshot mal formado para destino `
            + `"${destination}" (provider ${provider}) — intento abortado antes del spawn`);
        throw new AttemptSnapshotError(
            `[attempt-snapshot] snapshot mal formado para el destino "${destination}" `
            + `(provider "${provider}"). El lanzamiento se aborta antes del spawn (fail-closed).`,
            { provider, destination },
        );
    }

    return { required: true, snapshot };
}

/**
 * Compone el `processEnv` de UN intento. SIEMPRE devuelve un objeto nuevo, así
 * que dos intentos jamás comparten referencia (A-1) y mutar el resultado no
 * alcanza a `process.env` (A-3).
 *
 * Con snapshot: el env base se copia SIN ninguna variable de credencial de
 * provider —incluida la del primario cuando corre un fallback— y el material lo
 * aporta exclusivamente `snapshot.env` (A-2). Las variables que NO son
 * credenciales de provider (PATH, `PIPELINE_*`, scopes `github`/`aws`/
 * `gradle-android`) siguen viniendo del env base: `buildChildEnv` es quien
 * decide cuáles de ellas cruzan al hijo, y esa frontera no cambia.
 *
 * Sin snapshot: copia fiel del env base (camino legacy).
 *
 * @param {object} args
 * @param {object} [args.baseEnv]      env del proceso padre (default `process.env`)
 * @param {object|null} [args.snapshot] snapshot del intento (`{ env }`)
 * @param {object} [args.providersCfg] sección `providers` de agent-models.json
 * @returns {Object<string,string>} objeto nuevo
 */
function composeAttemptProcessEnv({ baseEnv = process.env, snapshot = null, providersCfg = {} } = {}) {
    const fuente = (baseEnv && typeof baseEnv === 'object') ? baseEnv : {};
    const tieneSnapshot = !!(snapshot && snapshot.env && typeof snapshot.env === 'object');

    // Sin snapshot NO se copia nada: se devuelve el env base TAL CUAL. No es un
    // atajo de performance, es correctitud en Windows — ver `canonicalizeSystemKeys`.
    // Copiar un `process.env` real degradaría su lookup case-insensitive, y con
    // el gate de rollout cerrado el camino legacy tiene que quedar idéntico.
    if (!tieneSnapshot) return fuente;

    const purgar = providerCredentialEnvNames(providersCfg);
    const out = {};
    for (const k of Object.keys(fuente)) {
        if (fuente[k] === undefined) continue;
        if (purgar.has(k)) continue;
        out[k] = fuente[k];
    }
    canonicalizeSystemKeys(fuente, out, purgar);
    for (const [k, v] of Object.entries(snapshot.env)) {
        if (v === undefined || v === null) continue;
        out[k] = String(v);
    }
    return out;
}

/**
 * Windows guarda las variables del sistema con SU casing (`Path`,
 * `ProgramFiles`, `windir`, `ProgramData`) y `process.env` compensa con lookup
 * case-insensitive. Un objeto literal NO tiene esa propiedad: `out['PATH']`
 * sería `undefined` sobre una copia que guardó `Path`, y `buildChildEnv` —que
 * busca por el nombre canónico de `SYSTEM_ALLOWLIST`— dejaría al hijo sin PATH,
 * sin SystemRoot y sin ComSpec. En Windows eso no es una degradación: el hijo no
 * arranca.
 *
 * Por eso, cuando el snapshot obliga a materializar una copia, cada nombre
 * canónico que la copia no tenga exacto se busca case-insensitive en el env base
 * y se escribe bajo el nombre canónico. Las claves originales quedan además tal
 * como estaban, así que nada que hoy funcione deja de funcionar.
 *
 * El alcance son los nombres que `buildChildEnv` busca por nombre exacto:
 * `SYSTEM_ALLOWLIST` y las variables de todos los `CREDENTIAL_SCOPES`. Las
 * `PIPELINE_*` no entran porque las escribe el propio pulpo con casing exacto y
 * se propagan por prefijo, no por nombre.
 */
function canonicalizeSystemKeys(fuente, out, purgar) {
    const canonicos = [...SYSTEM_ALLOWLIST];
    for (const vars of Object.values(CREDENTIAL_SCOPES)) canonicos.push(...vars);

    let indice = null;
    for (const nombre of canonicos) {
        if (purgar && purgar.has(nombre)) continue;
        if (Object.prototype.hasOwnProperty.call(out, nombre)) continue;
        if (indice === null) {
            indice = new Map();
            for (const k of Object.keys(fuente)) {
                const lower = k.toLowerCase();
                if (!indice.has(lower)) indice.set(lower, k);
            }
        }
        const real = indice.get(nombre.toLowerCase());
        if (real === undefined) continue;
        const valor = fuente[real];
        if (valor === undefined) continue;
        out[nombre] = valor;
    }
}

module.exports = {
    createAttemptSnapshot,
    composeAttemptProcessEnv,
    isSnapshotEnabled,
    isSnapshotRequired,
    providerRequiresCredential,
    providerCredentialEnvNames,
    AttemptSnapshotError,
    SNAPSHOT_DESTINATION,
    SNAPSHOT_SCOPES,
    ATTEMPT_SNAPSHOT_ERROR,
};

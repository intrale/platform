// =============================================================================
// secret-vault.js — driver de LECTURA del vault de secretos (#5352)
// =============================================================================
//
// Split 2/3 de #5338 (épico #5215). Este módulo resuelve secretos desde AWS
// (SSM Parameter Store / Secrets Manager) por **scope declarado**, con allowlist
// de verbos read-only, caché en memoria por namespace y fail-closed explícito.
//
// AMPLIACIÓN DE #5353 (hija 3) — superficie SYNC sobre el MISMO núcleo:
//   `resolveNamespaceSync` / `resolveScopeSync` y el port sync de los dos
//   drivers. No es un gemelo duplicado: la lógica se escribe una sola vez como
//   generador y dos conductores la ejecutan (ver "un solo cuerpo, dos
//   conductores"). La API async de #5352 no cambia — sigue declarada `async`,
//   sigue devolviendo `Promise`, y su suite queda verde sin editarse (D1.5).
//
// AMPLIACIÓN DE #5464 (1/3 de #5425) — se EXPORTA la validación canónica del
//   namespace (`validateVaultNamespace`) para que el tramo de provisión la
//   reutilice en vez de copiar los regex. Es un envoltorio PURO sobre
//   `buildParameterPath`: no agrega reglas, no agrega verbos y no amplía los
//   privilegios del runtime — la allowlist read-only queda idéntica.
//
// LO QUE ESTE MÓDULO **NO** HACE (a propósito):
//   - NO escribe en el vault. `VAULT_READONLY_COMMANDS` sigue siendo la lista
//     congelada de #5352 (tres verbos de lectura) y ningún driver de acá expone
//     escritura: escribir es del rol de provisión, no del runtime que lee.
//   - NO escribe en el ambiente del proceso (CA-8). Esa decisión — precedencia y
//     semántica de degradación de `loadIntoEnv` — vive en la hija 3 (#5353) y
//     toca `credentials.js`. Acá no se importa nada que mute el ambiente.
//   - NO se integra en el boot. `pulpo.js:14-20` y `restart.js:42-49` quedan
//     intactos (D2 — boot sincrónico preservado).
//   - NO agrega dependencias: el acceso a AWS va por la CLI ya instalada, sin
//     `@aws-sdk/*` (D1 / SEC-7). `dependencies` sigue siendo 4.
//
// -----------------------------------------------------------------------------
// Decisiones cerradas por el arquitecto que el código implementa (no re-decide)
// -----------------------------------------------------------------------------
//
//   G-1  El vocabulario de `<scope>` son las claves top-level del namespace de
//        credenciales (`resolveScopedRefs`, credentials.js:209): `telegram`,
//        `providers`, `multimedia`, `aws`, `google_drive`. `CREDENTIAL_SCOPES`
//        (build-child-env.js:134-152) es ANALOGÍA DE DISEÑO, no fuente del
//        vocabulario: direcciona la inyección al child y vive en la hija 3.
//
//   G-2  Un scope = UN parámetro cuyo valor es JSON SERIALIZADO. Los dos drivers
//        devuelven `value` como STRING; `resolveScope()` parsea y devuelve el
//        objeto. Es lo único que hace que el driver in-memory y el aws-cli
//        tengan la misma forma de retorno — sin esto, los tests corren contra el
//        in-memory (objetos) y no prueban el driver que va a producción
//        (strings): el riesgo Alto "cobertura ilusoria" del análisis.
//
//   G-3  `buildParameterPath` recibe `tier` EXPLÍCITO ∈ shared|host|rotating.
//        Nunca lo infiere de la presencia de `hostId`. La convención de barra
//        inicial la aplica el mismo constructor (SSM con `/`, Secrets Manager
//        sin `/`).
//
//   SEC-3 Presupuesto: A LO SUMO DOS llamadas batch por resolución de namespace,
//        sobre las raíces `<prefix>/<projectId>/shared/` y
//        `<prefix>/<projectId>/hosts/<hostId>/`. La raíz a nivel proyecto
//        `<prefix>/<projectId>/` es INCONSTRUIBLE: un barrido recursivo desde
//        ahí cruzaría el namespace de otros hosts.
//
//   SEC-1 El `Error` de `execFileSync` transporta el stdout del hijo — que acá
//        es la respuesta de `--with-decryption`, o sea los secretos EN CLARO —
//        y `util.inspect()` lo incluye. Verificado:
//            e.stdout = "CANARIO-XYZ" · util.inspect(e).includes('CANARIO-XYZ') === true
//        Por eso `sanitizeCliError` construye un error NUEVO: nunca se re-lanza
//        el original ni se le copia `stdout`/`output`/`message`.
//
//   SEC-2 El env del spawn se arma por ALLOWLIST con `buildVaultAwsEnv` —
//        builder PROPIO del vault (#5426 · G-2), no el compartido de
//        `kernel-provision.js`, que tiene tres consumidores con principales
//        distintos. El ambiente global del proceso NO se nombra ni una sola vez
//        en este archivo — ni para leerlo: el ambiente de origen se recibe
//        SIEMPRE por parámetro y se valida que sea un objeto. El test 10b lo
//        afirma con un grep sobre el propio archivo.
//
//   SEC-7 El ambiente TRANSPORTA material de credencial; nunca ELIGE el
//        principal (#5426 · T2-1/CA-13). `AWS_PROFILE`, `AWS_CONFIG_FILE` y
//        `AWS_SHARED_CREDENTIALS_FILE` del ambiente de origen se descartan: el
//        perfil sale de `vault.awsProfile` y las rutas se calculan con
//        `os.homedir()`. El mecanismo se declara con `vault.authMode` (enum
//        cerrado), por SEÑAL POSITIVA: nunca por ausencia de variables.
//
//   SEC-6 Caché con tope duro de TTL, clave que incluye el namespace, sin
//        negative caching y sin persistencia a disco.
//
// -----------------------------------------------------------------------------
// Taxonomía de errores (CA-28 / UX-1)
// -----------------------------------------------------------------------------
//
// Las tres fallas terminales tienen remediaciones OPUESTAS, así que no pueden
// compartir una sola clase. Cada mensaje nombra la ACCIÓN, no sólo el síntoma:
//
//   VaultSecretMissingError      VAULT_SECRET_MISSING      -> subir el parámetro al vault
//   VaultCliError                VAULT_CLI                 -> renovar la credencial del mecanismo
//                                                            declarado / corregir la policy IAM
//   VaultTruncatedResponseError  VAULT_TRUNCATED_RESPONSE  -> revisar paginación; el vault está bien
//
// La cuarta falla — config del vault inválida al ENCENDER el gate (CA-29) — no
// es terminal de resolución sino de arranque, y se discrimina por
// `err.code === 'VAULT_CONFIG_INVALID'` / `err.name === 'VaultConfigError'`. NO
// se exporta como clase a propósito: CA-28 fija la superficie de exports en
// EXACTAMENTE tres claves terminadas en `Error`. Los códigos de todos los modos
// de falla viven en `VAULT_ERROR_CODES`, que sí se exporta.
// =============================================================================
'use strict';

const util = require('node:util');

const os = require('node:os');
const path = require('node:path');

const { redactAwsEvidence } = require('./kernel-table-verify');
const { redactScoped } = require('./credentials');

// #5426 (G-2) — `buildAwsScopedEnv` (kernel-provision.js:110-119) YA NO se
// importa acá. Tiene tres consumidores con PRINCIPALES distintos (provisión =
// admin, vault = rol de lectura del host, `pulpo.js` = `kernel-runtime` de
// #5126). Ensancharlo para que el vault pueda imponer su perfil movería el
// blast radius a los otros dos, y el daño no se vería en este PR porque
// `kernel.durable: false` mantiene dormido al tercero. El vault arma su propio
// ambiente con `buildVaultAwsEnv` (abajo).

// -----------------------------------------------------------------------------
// Allowlist de verbos read-only — fail-closed ANTES de spawnear
// -----------------------------------------------------------------------------
//
// En la línea de `READONLY_COMMANDS` (kernel-table-verify.js:62-71). Congelada:
// `ssm put-parameter` NO entra — escribir en el vault es del rol de provisión,
// no del runtime que lee. Un verbo fuera de esta lista se rechaza antes de que
// exista un proceso hijo.
const VAULT_READONLY_COMMANDS = Object.freeze([
    'ssm get-parameters-by-path',
    'ssm get-parameter',
    'secretsmanager get-secret-value',
]);

// ALLOWLIST de flags que el módulo puede construir. Cualquier otro argumento que
// empiece con `-` se rechaza (SEC-5): sin esto, un valor de config con forma de
// flag se convierte en un flag real de la CLI.
//
// SEC-4 — es una allowlist y NO una denylist a propósito. Los flags de
// paginación acotada de la AWS CLI (los que devuelven una página y cortan) no
// están en esta lista, así que quedan rechazados por construcción: una denylist
// que los enumere sería redundante y encima habría que acordarse de ampliarla
// cada vez que la CLI agregue uno nuevo.
const VAULT_ALLOWED_FLAGS = Object.freeze([
    '--path',
    '--recursive',
    '--with-decryption',
    '--secret-id',
    '--version-stage',
    '--starting-token',
    '--region',
    '--output',
    '--no-cli-pager',
]);

const SEGMENT_RE = /^[A-Za-z0-9_-]+$/;        // D8 — segmentos del path
const PREFIX_RE = /^(\/[A-Za-z0-9_-]+)+$/;    // SEC-5 — prefix de config.yaml
const FILE_URI_RE = /file:\/\//i;             // SEC-5 — la CLI lee archivos con `file://`
// #5426 — nombre de perfil de la AWS CLI. Más permisivo que `SEGMENT_RE` (los
// perfiles admiten punto) y más cerrado que "cualquier string": sin barras, sin
// espacios y sin `-`/`.` inicial, que es lo que evita que un valor de config con
// forma de flag llegue al ambiente del hijo.
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const VAULT_TIERS = Object.freeze(['shared', 'host', 'rotating']);

// -----------------------------------------------------------------------------
// #5426 — mecanismo de identidad del vault, por SEÑAL POSITIVA de config
// -----------------------------------------------------------------------------
//
// T2-2 — El guard viejo aceptaba/rechazaba mirando qué variables había en el
// ambiente. Eso tiene dos defectos que no se arreglan por separado:
//
//   1. Rechaza por construcción el único mecanismo que este host tiene
//      (assume-role encadenado), porque no deja par estático en el ambiente.
//   2. Aceptar «instance profile» mirando el env obliga a dejar de exigir algo
//      — o sea, convertir el fail-closed en fail-open disfrazado.
//
// Por eso la señal es `vault.authMode`, un enum CERRADO que viene de config
// (código commiteado), no del ambiente. El ambiente sólo puede TRANSPORTAR
// material de credencial; nunca ELIGE con qué principal corre la CLI.
const VAULT_AUTH_MODES = Object.freeze([
    'assume-role-chain',
    'session-token',
    'static-key',
    'instance-profile',
]);

// Material de credencial que cada modo admite copiar del ambiente de origen.
//
// T2-1 (endurecido respecto de la receta) — los modos que resuelven la identidad
// por PERFIL o por METADATA no copian NINGUNA variable de credencial. No es
// cosmética: la AWS CLI le da precedencia a `AWS_ACCESS_KEY_ID`/`SECRET` del
// ambiente POR ENCIMA del perfil, así que copiarlas en modo
// `assume-role-chain` dejaría que un par estático heredado del padre le gane al
// rol declarado en config — exactamente el agujero que `vault.awsProfile` viene
// a cerrar, sólo que por la otra puerta.
const VAULT_AUTH_MATERIAL = Object.freeze({
    'assume-role-chain': Object.freeze([]),
    'instance-profile': Object.freeze([]),
    'session-token': Object.freeze([
        'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
    ]),
    'static-key': Object.freeze(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']),
});

// Nombre de archivo que NO debe existir nunca. Se usa como valor de
// `AWS_CONFIG_FILE`/`AWS_SHARED_CREDENTIALS_FILE` en `instance-profile` para
// cortar la cadena de credenciales basada en archivos (ver `buildVaultAwsEnv`).
// Es un nombre neutro a propósito: este repo es público y un nombre de perfil
// del host sería reconocimiento gratuito (REQ-SEC-5 de #5339).
const VAULT_NO_FILE_SENTINEL = 'vault-instance-profile-sin-archivos';

const MAX_CACHE_TTL_SECONDS = 300;            // SEC-6 — tope DURO, no default
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;
const MAX_PAGES = 50;                         // cota de la paginación manual (SEC-4)

// SEC-6(a) — matchea la FAMILIA de errores de autorización/expiración, no el
// literal `AccessDenied`. Verificado que el host responde hoy "Your session has
// expired", que un matcher literal NO atrapa: la caché quedaría envenenada con
// un namespace que ya no se puede refrescar.
const AUTH_ERROR_RE = /AccessDenied|ExpiredToken|UnrecognizedClient|InvalidClientTokenId|session has expired/i;

const VAULT_ERROR_CODES = Object.freeze({
    SECRET_MISSING: 'VAULT_SECRET_MISSING',
    CLI: 'VAULT_CLI',
    TRUNCATED_RESPONSE: 'VAULT_TRUNCATED_RESPONSE',
    CONFIG_INVALID: 'VAULT_CONFIG_INVALID',
});

// -----------------------------------------------------------------------------
// Errores tipados (CA-28 / UX-1) — cada mensaje nombra la REMEDIACIÓN
// -----------------------------------------------------------------------------

/**
 * El scope está declarado en `vault.required_scopes[]` pero no existe en el
 * vault. Remediación: subir el parámetro.
 *
 * CA-32 — el mensaje pasa por `redactAwsEvidence`, que enmascara el ACCOUNT ID
 * pero NO la jerarquía de parámetros. Nombra el scope y el tier a propósito
 * (son lo que el operador necesita para saber qué subir y dónde) y NUNCA el
 * valor del secreto.
 */
class VaultSecretMissingError extends Error {
    constructor(scope, logicalPath, tier) {
        super(redactAwsEvidence(
            `vault: secreto ausente — scope="${scope}" tier="${tier}" path="${logicalPath}". `
            + `Remediación: subir el parámetro al vault (tier ${tier}) antes de encender `
            + '`vault.enabled`; el vault no inventa defaults ni devuelve vacío.',
        ));
        this.name = 'VaultSecretMissingError';
        this.code = VAULT_ERROR_CODES.SECRET_MISSING;
        this.scope = scope;
        this.tier = tier;
    }
}

/**
 * La AWS CLI falló (auth denegada, sesión expirada, timeout, exit ≠ 0).
 * Remediación: renovar la credencial del mecanismo declarado en `vault.authMode`
 * o corregir la policy IAM.
 *
 * CA-31 — el stderr saneado se PRESERVA a propósito: `redactAwsEvidence` deja
 * intacto el verbo AWS denegado (`ssm:GetParameter` vs `kms:Decrypt`, que
 * desambiguan remediaciones distintas) y el texto de remediación que trae la
 * propia CLI.
 * Colapsar esto a «error de CLI» sería más «seguro» y dejaría al operador sin
 * diagnóstico.
 */
class VaultCliError extends Error {
    constructor({ service, verb, exitCode, stderr, scopes }) {
        const detalle = redactAwsEvidence(String(stderr == null ? '' : stderr).trim());
        super(
            `vault: la AWS CLI falló — ${service} ${verb} (exit=${exitCode == null ? 'null' : exitCode})`
            + `${detalle ? `: ${detalle}` : ''}`
            + ` · scopes=[${(scopes || []).join(',')}]`
            // #5426 · CA-11(c) — la remediación nombra el MECANISMO declarado,
            // no un comando concreto: reautenticar por SSO no aplica a un host
            // que se autentica por assume-role encadenado, y sugerirlo manda el
            // diagnóstico para el lado equivocado. Tampoco se nombra el perfil.
            + ' · Remediación: renovar la credencial del mecanismo declarado en '
            + '`vault.authMode` o corregir la policy IAM del rol de lectura del vault.',
        );
        this.name = 'VaultCliError';
        this.code = VAULT_ERROR_CODES.CLI;
        this.service = service;
        this.verb = verb;
        this.exitCode = exitCode == null ? null : exitCode;
        this.scopes = Array.isArray(scopes) ? scopes.slice() : [];
    }
}

/**
 * La respuesta del vault llegó incompleta (`NextToken` sin consumir, `maxBuffer`
 * desbordado, JSON cortado). Remediación: revisar paginación — el vault está
 * BIEN, no hay que subir nada ni tocar la policy.
 *
 * Existe para que una lectura truncada NUNCA se confunda con «secreto ausente»:
 * son remediaciones opuestas y la confusión termina en un parámetro duplicado.
 */
class VaultTruncatedResponseError extends Error {
    constructor({ root, reason, scopes }) {
        super(
            `vault: respuesta truncada leyendo "${redactAwsEvidence(String(root || ''))}" (${reason}). `
            + `scopes=[${(scopes || []).join(',')}] · Remediación: revisar la paginación de la lectura `
            + '(`NextToken` / `maxBuffer`). El contenido del vault NO está en falta: NO subir '
            + 'parámetros ni tocar la policy IAM por este error.',
        );
        this.name = 'VaultTruncatedResponseError';
        this.code = VAULT_ERROR_CODES.TRUNCATED_RESPONSE;
        this.root = root || null;
        this.reason = reason;
        this.scopes = Array.isArray(scopes) ? scopes.slice() : [];
    }
}

/**
 * Config del vault inválida al ENCENDER el gate (CA-29). NO se exporta como
 * clase: CA-28 fija los exports `*Error` en exactamente tres. Se discrimina por
 * `code`/`name`, que es una de las dos convenciones vigentes del repo
 * (`worktree-launcher.js:75` discrimina por code).
 *
 * El mensaje nombra la CLAVE DE CONFIG (`vault.hostId`), nunca el regex crudo:
 * un operador no puede accionar sobre `^[A-Za-z0-9_-]+$`.
 */
class VaultConfigError extends Error {
    constructor(clave, detalle) {
        // El archivo se nombra sólo para las claves que el operador edita a mano:
        // mandarlo a `config.yaml` por un argumento interno mal armado sería una
        // remediación falsa.
        const enArchivo = VAULT_CONFIG_KEYS.has(clave) ? ' en `.pipeline/config.yaml`' : '';
        super(`vault: \`${clave}\` ${detalle}${enArchivo}.`);
        this.name = 'VaultConfigError';
        this.code = VAULT_ERROR_CODES.CONFIG_INVALID;
        this.clave = clave;
    }
}

// Claves que el operador edita a mano en la sección `vault:` de config.yaml.
const VAULT_CONFIG_KEYS = new Set([
    'vault.prefix',
    'vault.projectId',
    'vault.hostId',
    // #5426 — mecanismo de identidad del host. Las dos son claves que el
    // operador edita a mano, así que el error las manda a `config.yaml`.
    'vault.authMode',
    'vault.awsProfile',
    'vault.cache_ttl_seconds',
    'vault.required_scopes',
    'vault.required_scopes[]',
    'vault.shared_secrets',
    'vault.shared_secrets[]',
    'kernel.region',
]);

// -----------------------------------------------------------------------------
// CA-2 / CA-3 / CA-7 — buildParameterPath: EL ÚNICO lugar donde vive el esquema
// -----------------------------------------------------------------------------

/**
 * Construye el nombre del parámetro (SSM) o del secreto (Secrets Manager).
 *
 * Es el único constructor de rutas del módulo: no hay un segundo builder ni
 * literales de path fuera de acá. Todo se valida ANTES de concatenar — validar
 * después de armar el string es exactamente el bug que SEC-5 previene.
 *
 *   tier 'shared'   -> `${prefix}/${projectId}/shared/${scope}`            (SSM, CON barra inicial)
 *   tier 'host'     -> `${prefix}/${projectId}/hosts/${hostId}/${scope}`   (SSM, CON barra inicial)
 *   tier 'rotating' -> `${prefix}/${projectId}/rotating/${scope}`.slice(1) (SM,  SIN barra inicial)
 *
 * Con `root: true` devuelve la RAÍZ RECURSIVA del tier (terminada en `/`) para
 * el barrido batch de `resolveNamespace`. Sólo `shared` y `host` tienen raíz:
 * la raíz a nivel proyecto (`<prefix>/<projectId>/`) es INCONSTRUIBLE por
 * diseño (SEC-3) — barrer desde ahí con `--recursive` devolvería los secretos
 * de TODOS los hosts.
 *
 * @param {object} args
 * @param {string} args.prefix     validado contra `^(/[A-Za-z0-9_-]+)+$`
 * @param {string} args.projectId  validado contra `^[A-Za-z0-9_-]+$`
 * @param {string} [args.hostId]   requerido sólo con tier `host`
 * @param {string} [args.scope]    requerido salvo con `root: true`
 * @param {'shared'|'host'|'rotating'} args.tier  EXPLÍCITO, nunca inferido (G-3)
 * @param {boolean} [args.root]    devolver la raíz recursiva del tier
 * @returns {string}
 */
function buildParameterPath({ prefix, projectId, hostId, scope, tier, root = false } = {}) {
    if (typeof tier !== 'string' || !VAULT_TIERS.includes(tier)) {
        throw new VaultConfigError('vault.tier',
            `debe ser uno de ${VAULT_TIERS.join('|')} (recibido: ${describeTipo(tier)}); `
            + 'el tier es EXPLÍCITO, nunca se infiere de la presencia de hostId');
    }
    assertSegment('vault.projectId', projectId);
    assertPrefix('vault.prefix', prefix);

    if (root) {
        if (tier === 'rotating') {
            throw new VaultConfigError('vault.tier',
                'no admite barrido recursivo con tier `rotating`: Secrets Manager se lee por '
                + 'nombre exacto, no por raíz');
        }
        if (scope != null && scope !== '') {
            throw new VaultConfigError('vault.scope',
                'no se declara al construir una raíz recursiva (root: true)');
        }
    } else {
        assertSegment('vault.scope', scope);
    }

    if (tier === 'host') {
        assertSegment('vault.hostId', hostId);
        const base = `${prefix}/${projectId}/hosts/${hostId}`;
        return root ? `${base}/` : `${base}/${scope}`;
    }
    if (tier === 'shared') {
        const base = `${prefix}/${projectId}/shared`;
        return root ? `${base}/` : `${base}/${scope}`;
    }
    // rotating — Secrets Manager: name SIN barra inicial.
    return `${prefix}/${projectId}/rotating/${scope}`.slice(1);
}

function describeTipo(v) {
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    if (typeof v === 'string') return v === '' ? 'cadena vacía' : `"${v}"`;
    return typeof v;
}

function assertSegment(clave, value) {
    if (typeof value !== 'string' || value === '') {
        throw new VaultConfigError(clave, `sin configurar (recibido: ${describeTipo(value)})`);
    }
    if (!SEGMENT_RE.test(value)) {
        throw new VaultConfigError(clave,
            `inválido (${describeTipo(value)}): sólo letras, números, guion y guion bajo — `
            + 'sin barras, sin puntos y sin `..`');
    }
}

function assertPrefix(clave, value) {
    if (typeof value !== 'string' || value === '') {
        throw new VaultConfigError(clave, `sin configurar (recibido: ${describeTipo(value)})`);
    }
    if (!PREFIX_RE.test(value)) {
        throw new VaultConfigError(clave,
            `inválido (${describeTipo(value)}): debe empezar con "/" y no terminar en "/" `
            + '(ejemplo válido: `/intrale`)');
    }
}

// -----------------------------------------------------------------------------
// #5426 · CA-11 / CA-13 — identidad del vault: config manda, ambiente no elige
// -----------------------------------------------------------------------------

/**
 * Valida el mecanismo de identidad declarado en config. Fail-closed por SEÑAL
 * POSITIVA (T2-2): el error nombra la CLAVE (`vault.authMode`), nunca un regex
 * ni «faltan variables» — un operador no puede accionar sobre la ausencia de
 * algo que nunca supo que tenía que estar.
 *
 * Se llama desde `createAwsCliVaultRunner` (el único camino que efectivamente
 * necesita una identidad AWS) y desde `validateVaultConfig` cuando la clave
 * está presente. NO se exige en el driver in-memory: acoplar la validación del
 * NAMESPACE a la identidad de AWS sería una dependencia falsa — el driver de
 * tests no habla con AWS ni una vez.
 *
 * @param {object} cfg  sección `vault:` de config.yaml (+ `region`)
 */
function assertVaultAuthConfig(cfg) {
    const modo = cfg && cfg.authMode;
    if (typeof modo !== 'string' || !VAULT_AUTH_MODES.includes(modo)) {
        throw new VaultConfigError('vault.authMode',
            `sin mecanismo de identidad declarado (recibido: ${describeTipo(modo)}). `
            + `Valores aceptados: ${VAULT_AUTH_MODES.join(' | ')}. `
            + 'La identidad del vault se declara en config, nunca se infiere del ambiente');
    }
    const perfil = cfg.awsProfile;
    const usaPerfil = modo === 'assume-role-chain';
    if (usaPerfil) {
        if (typeof perfil !== 'string' || perfil === '') {
            throw new VaultConfigError('vault.awsProfile',
                `sin configurar (recibido: ${describeTipo(perfil)}); `
                + `\`authMode: ${modo}\` resuelve la identidad por perfil de la AWS CLI, `
                + 'y el perfil sale de config — nunca del ambiente');
        }
        if (!PROFILE_RE.test(perfil)) {
            throw new VaultConfigError('vault.awsProfile',
                'inválido: sólo letras, números, punto, guion y guion bajo, '
                + 'empezando por letra o número');
        }
    } else if (perfil != null && perfil !== '') {
        // Combinación ambigua: con perfil Y material de credencial en el mismo
        // ambiente, la AWS CLI resuelve por el material y el perfil queda de
        // adorno. Un operador que la escribe cree estar usando el rol.
        throw new VaultConfigError('vault.awsProfile',
            `sólo aplica con \`authMode: assume-role-chain\` (declarado: \`${modo}\`)`);
    }
}

/**
 * Arma el ambiente del proceso hijo del vault. Es el ÚNICO lugar donde se
 * decide con qué principal corre la AWS CLI que lee el vault.
 *
 * Cuatro invariantes, todas de #5426:
 *
 *   T2-1.1 — `AWS_PROFILE` del ambiente de origen se DESCARTA sin excepción. El
 *            perfil sale de `vault.awsProfile`. Cerrado el bug de R2, un
 *            `AWS_PROFILE` heredado dejaría de ser inerte y pasaría a elegir el
 *            principal; el conjunto alcanzable de un host de desarrollo incluye
 *            perfiles muy por encima del rol de lectura.
 *   T2-1.3 — `AWS_CONFIG_FILE` y `AWS_SHARED_CREDENTIALS_FILE` se CALCULAN con
 *            `os.homedir()`. Nunca se copian del ambiente: quien los pueda
 *            escribir redirige la resolución de identidad a archivos suyos.
 *   T2-1.4 — `instance-profile` apunta la cadena por ARCHIVOS a una ruta
 *            inexistente y no setea `AWS_PROFILE`. Es el único modo sin señal en
 *            el ambiente; sin este corte el hijo sale con sólo `AWS_REGION` y la
 *            CLI resuelve contra el `[default]` de `~/.aws`, devolviéndole al
 *            disco la elección del principal.
 *   T2-1.5 — El material de credencial que se copia depende del modo
 *            (`VAULT_AUTH_MATERIAL`): los modos por perfil/metadata no copian
 *            ninguno, así que un par estático heredado no le puede ganar al rol.
 *
 * NO reutiliza `buildAwsScopedEnv` a propósito (G-2): ese builder es compartido
 * por tres principales distintos.
 *
 * @param {object} sourceEnv  ambiente de origen, EXPLÍCITO
 * @param {object} cfg        `{ region, authMode, awsProfile }`
 * @returns {object} ambiente del hijo — sólo claves `AWS_*`
 */
function buildVaultAwsEnv(sourceEnv, cfg) {
    const src = sourceEnv && typeof sourceEnv === 'object' && !Array.isArray(sourceEnv)
        ? sourceEnv
        : {};
    const out = {};
    if (cfg && cfg.region) out.AWS_REGION = cfg.region;

    const modo = cfg && cfg.authMode;
    if (modo === 'assume-role-chain' && cfg.awsProfile) {
        const home = os.homedir();
        out.AWS_PROFILE = cfg.awsProfile;
        out.AWS_CONFIG_FILE = path.join(home, '.aws', 'config');
        out.AWS_SHARED_CREDENTIALS_FILE = path.join(home, '.aws', 'credentials');
    } else if (modo === 'instance-profile') {
        // T2-1.4 — el ÚNICO modo cuya señal no vive en el ambiente (su guard en
        // `assertVaultAuthSignal` es incondicionalmente verde, porque el rol se
        // resuelve por metadata del host). Sin esto el hijo arrancaba con SÓLO
        // `AWS_REGION`: sin material y sin saber dónde buscarlo, la AWS CLI baja
        // por su cadena por defecto hasta `~/.aws/config` y termina resolviendo
        // contra el perfil `[default]` del disco — es decir, el ambiente le
        // vuelve a ELEGIR el principal al vault, que es justo lo que SEC-7
        // prohíbe, sólo que por la puerta del modo que no deja señal.
        //
        // Neutralizamos la cadena basada en ARCHIVOS apuntándola a una ruta que
        // no existe (la CLI la trata como config vacía), y NO seteamos
        // `AWS_PROFILE`: así el único origen posible de identidad es la metadata
        // del host. El sentinel vive bajo el home —no bajo un temp world-writable—
        // para que plantarlo exija ya tener la cuenta del operador.
        const sentinel = path.join(os.homedir(), '.aws', VAULT_NO_FILE_SENTINEL);
        out.AWS_CONFIG_FILE = sentinel;
        out.AWS_SHARED_CREDENTIALS_FILE = sentinel;
    }

    const material = VAULT_AUTH_MATERIAL[modo] || [];
    for (const name of material) {
        const v = src[name];
        if (v != null && v !== '') out[name] = v;
    }
    return out;
}

/**
 * Verifica que el mecanismo declarado tenga su señal en el ambiente ya armado.
 *
 * El mensaje NO sugiere reautenticar por SSO (la remediación vieja, que este
 * archivo ya no nombra ni en un comentario, no satisfacía al guard
 * que la emitía) y NO enumera perfiles del host: un mensaje de error viaja a
 * logs y a Telegram, y ahí un nombre de perfil es reconocimiento gratis
 * (REQ-SEC-5 de #5339).
 */
function assertVaultAuthSignal(env, cfg) {
    const modo = cfg.authMode;
    let ok;
    switch (modo) {
        case 'assume-role-chain':
            ok = !!env.AWS_PROFILE;
            break;
        case 'session-token':
            ok = !!env.AWS_SESSION_TOKEN && !!env.AWS_ACCESS_KEY_ID
                && !!env.AWS_SECRET_ACCESS_KEY;
            break;
        case 'static-key':
            ok = !!env.AWS_ACCESS_KEY_ID && !!env.AWS_SECRET_ACCESS_KEY;
            break;
        case 'instance-profile':
            // La señal es `vault.authMode`, no el ambiente: el rol de instancia
            // se resuelve por metadata del host y no deja rastro en el env.
            ok = true;
            break;
        default:
            ok = false;
    }
    if (!ok) {
        throw new VaultConfigError('vault.credenciales',
            `el mecanismo declarado (\`${modo}\`) no tiene su señal en el ambiente del vault: `
            + 'faltan las credenciales AWS que ese modo necesita. Fail-closed: no se invoca la '
            + 'AWS CLI con credenciales vacías. Remediación: revisar `vault.authMode` y el '
            + 'scope `aws` del proceso que arranca el pipeline');
    }
}

/**
 * Resuelve el `hostId` del namespace del vault.
 *
 * D9 / T2-5 — `vault.hostId` se commitea VACÍO y **nunca** se llena en
 * `.pipeline/config.yaml`: ese archivo está trackeado en un repo PÚBLICO, y el
 * hostname expone la estructura `hosts/<hostId>/` que sostiene el aislamiento
 * entre hosts. El alta de host lo resuelve en RUNTIME desde `os.hostname()` —
 * el mismo criterio de identidad que ya usan `file-lock.js:145` y
 * `notify-telegram.js:106`.
 *
 * La resolución en runtime NO es implícita: la habilita
 * `vault.hostIdFromHostname`, que es una SEÑAL POSITIVA commiteada (el
 * MECANISMO se publica; el VALOR nunca). Si fuera el default silencioso, un
 * `hostId` vacío dejaría de ser distinguible de «sin configurar» y se perdería
 * el fail-closed que hoy nombra la clave — que es justo lo que CA-12(e) pide
 * conservar.
 *
 * No normaliza ni recorta: un hostname con puntos (FQDN) NO se trunca a su
 * primera etiqueta, porque `a.uno.local` y `a.dos.local` colapsarían al mismo
 * namespace y el aislamiento por host se perdería en silencio. Si no resuelve a
 * un segmento válido, devuelve cadena vacía y `validateVaultConfig` falla
 * cerrado NOMBRANDO `vault.hostId` (CA-12.e) — nunca contra `hosts//`.
 *
 * @param {object} cfg          sección `vault:` de config.yaml
 * @param {object} [deps]       `{ hostname }` inyectable para tests
 * @returns {string} hostId resuelto (puede ser '' — el llamador falla cerrado)
 */
function resolveVaultHostId(cfg, deps = {}) {
    const declarado = cfg && cfg.hostId;
    if (typeof declarado === 'string' && declarado !== '') return declarado;
    if (!cfg || cfg.hostIdFromHostname !== true) return '';
    const hostname = typeof deps.hostname === 'function' ? deps.hostname : () => os.hostname();
    let valor = '';
    try {
        valor = hostname();
    } catch {
        return '';
    }
    return typeof valor === 'string' ? valor.trim() : '';
}

// -----------------------------------------------------------------------------
// #5464 (1/3 de #5425) — validación CANÓNICA del namespace, exportable
// -----------------------------------------------------------------------------
//
// El tramo de provisión (#5425) necesita resolver y validar el mismo nombre
// lógico que el runtime lee, pero vive en OTRO proceso, con OTRA identidad y
// con un port de ESCRITURA propio. Sin un punto de entrada exportado, ese
// tramo termina copiando `SEGMENT_RE` / `PREFIX_RE` o concatenando el path a
// mano: dos copias del esquema que divergen en silencio el día que una cambia.
//
// Por eso esto NO es una segunda implementación: `validateVaultNamespace` es un
// envoltorio fino sobre `buildParameterPath`, que sigue siendo el único lugar
// donde vive el esquema y el único que corre los regex. Acá no hay un regex
// nuevo, ni una concatenación de path, ni una regla de validación propia — si
// la hubiera, sería exactamente la duplicación que este split viene a evitar.
//
// Y NO amplía privilegios: es una función PURA (sin I/O, sin ambiente, sin
// driver). No toca `VAULT_READONLY_COMMANDS`, no agrega verbos, no expone los
// regex crudos (exportarlos habilitaría justamente la copia que se quiere
// impedir). El `service` que devuelve es el destino de LECTURA que el tier ya
// implica en `buildParameterPath`; quién escribe y con qué verbo es decisión
// del provisionador, fuera de este módulo.

// Destino AWS por tier. Se declara UNA vez y se cubre por test contra
// `VAULT_TIERS`: un tier nuevo sin destino declarado rompe la suite en vez de
// devolver `undefined` y mandar el pedido a un servicio equivocado.
const VAULT_TIER_SERVICE = Object.freeze({
    shared: 'ssm',
    host: 'ssm',
    rotating: 'secretsmanager',
});

/**
 * Valida prefijo, namespace (`projectId` / `hostId`), tier y nombre lógico, y
 * devuelve el descriptor canónico del destino. Fail-closed: si algo no valida,
 * lanza `VaultConfigError` y NO devuelve un descriptor a medias — el consumidor
 * no llega a emitir la llamada remota.
 *
 * Mismos argumentos, mismos errores y mismas claves de config que
 * `buildParameterPath`: es el mismo contrato, con la salida enriquecida.
 *
 * @param {object} args  igual que `buildParameterPath`
 * @returns {Readonly<{tier:string, service:'ssm'|'secretsmanager', path:string,
 *                     root:boolean, prefix:string, projectId:string,
 *                     hostId:string|null, scope:string|null}>}
 */
function validateVaultNamespace({ prefix, projectId, hostId, scope, tier, root = false } = {}) {
    // `root` decide si el nombre lógico es obligatorio, así que un truthy
    // ambiguo (`'false'`, `1`) cambiaría la validación sin que nadie lo note.
    if (typeof root !== 'boolean') {
        throw new VaultConfigError('vault.root',
            `debe ser booleano (recibido: ${describeTipo(root)}); `
            + 'la raíz recursiva se pide EXPLÍCITAMENTE, nunca por un valor truthy');
    }

    // Única fuente del esquema y de los regex: si esto no lanza, el path es
    // válido por construcción.
    const path = buildParameterPath({ prefix, projectId, hostId, scope, tier, root });

    return Object.freeze({
        tier,
        service: VAULT_TIER_SERVICE[tier],
        path,
        root,
        prefix,
        projectId,
        // `hostId` sólo pertenece al descriptor si el tier lo usó: devolverlo
        // en `shared` sugeriría que el path está segmentado por host y no lo está.
        hostId: tier === 'host' ? hostId : null,
        scope: root ? null : scope,
    });
}

// -----------------------------------------------------------------------------
// SEC-1 — saneamiento del error de la CLI
// -----------------------------------------------------------------------------

/**
 * Convierte cualquier falla de `execFileSync` en un error NUEVO y saneado.
 *
 * Prohibido re-lanzar `err` o copiarle `stdout`/`output`/`message`: los tres
 * transportan la respuesta descifrada del vault. Aplica igual al kill por
 * timeout, que también deja stdout parcial adjunto.
 *
 * `ENOBUFS` (maxBuffer desbordado) se mapea a truncación, no a fallo de CLI:
 * son remediaciones distintas y el operador necesita saber que el vault está bien.
 */
function sanitizeCliError(err, { service, verb, scopes, root }) {
    const codigo = err && err.code;
    if (codigo === 'ENOBUFS') {
        return new VaultTruncatedResponseError({ root, reason: 'maxBuffer desbordado', scopes });
    }
    const timedOut = !!(err && (err.killed || codigo === 'ETIMEDOUT'));
    const stderr = err && err.stderr != null ? String(err.stderr) : '';
    return new VaultCliError({
        service,
        verb,
        exitCode: err && err.status != null ? err.status : null,
        stderr: timedOut && !stderr.trim()
            ? `la CLI excedió el timeout de ${DEFAULT_TIMEOUT_MS} ms y fue terminada`
            : stderr,
        scopes,
    });
}

// -----------------------------------------------------------------------------
// Runner de la AWS CLI — servicio PARAMETRIZADO
// -----------------------------------------------------------------------------

/**
 * Runner propio del vault. No reutiliza `createAwsCliRunner`
 * (provisioner-infra.js:466) porque ése **hardcodea el token `'dynamodb'`** en
 * el spawn: no es parametrizable por servicio. La consolidación de los dos
 * runners quedó registrada como deuda en #5356 (no bloquea).
 *
 * @param {object} sourceEnv  ambiente de origen, SIEMPRE explícito. El ambiente
 *                            global del proceso no se usa nunca (SEC-2).
 * @param {object} cfg        sección `vault:` de config.yaml + `region`. #5426:
 *                            deja de ser un string de región. La identidad sale
 *                            de acá (`authMode`/`awsProfile`), o sea de código
 *                            commiteado — nunca del ambiente (T2-1/CA-13).
 * @param {object} [deps]     `{ execFileSync }` inyectable para tests.
 * @returns {{ run: (service: string, args: string[]) => string }}
 */
function createAwsCliVaultRunner(sourceEnv, cfg, deps = {}) {
    // SEC-2 — el ambiente de origen es EXPLÍCITO. Un no-objeto acá era, con el
    // builder viejo, un fallback SILENCIOSO al ambiente global del proceso.
    if (!sourceEnv || typeof sourceEnv !== 'object' || Array.isArray(sourceEnv)) {
        throw new VaultConfigError('vault.env',
            'requiere un ambiente de origen EXPLÍCITO (objeto); el vault nunca cae al '
            + 'ambiente global del proceso');
    }
    // #5426 — la firma cambió: antes el 2º argumento era la región (string).
    // Un string acá NO se acepta por compatibilidad: aceptarlo obligaría a
    // asumir un `authMode` implícito, y un modo de identidad implícito es
    // exactamente lo que T2-2 prohíbe. Falla ruidoso, nombrando la clave.
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
        throw new VaultConfigError('vault.authMode',
            `requiere la config del vault (objeto), no ${describeTipo(cfg)}. El mecanismo de `
            + 'identidad se declara en config y nunca se infiere');
    }
    const region = cfg.region;

    // Fail-closed por SEÑAL POSITIVA, ANTES de armar el ambiente (T2-2).
    assertVaultAuthConfig(cfg);

    // SEC-2 — env por ALLOWLIST propia del vault (G-2: no se reutiliza el
    // builder compartido). Un `AWS_ENDPOINT_URL`, un `AWS_CONFIG_FILE` o un
    // `AWS_PROFILE` del ambiente de entrada NO llegan al hijo, así que nadie
    // puede redirigir la lectura del vault ni elegirle el principal.
    const env = buildVaultAwsEnv(sourceEnv, cfg);

    // Fail-closed de credenciales ANTES de spawnear (mismo criterio que
    // provisioner-infra.js:447-454): invocar la CLI con credenciales vacías
    // produce un error de auth indistinguible de una policy mal puesta.
    assertVaultAuthSignal(env, cfg);

    if (!region) {
        throw new VaultConfigError('kernel.region', 'sin configurar; el vault la reutiliza');
    }

    const execFileSync = typeof deps.execFileSync === 'function'
        ? deps.execFileSync
        : require('node:child_process').execFileSync;

    return {
        kind: 'aws-cli-runner',
        run(service, args) {
            const verb = Array.isArray(args) ? args[0] : undefined;
            assertVerboPermitido(service, verb);
            const finales = [...args, '--region', region, '--output', 'json', '--no-cli-pager'];
            assertArgsSeguros(finales);
            try {
                return execFileSync('aws', [service, ...finales], {
                    env,                          // SÓLO el scope `aws` (SEC-2)
                    shell: false,                 // PROHIBIDO habilitar el shell (A03)
                    timeout: DEFAULT_TIMEOUT_MS,  // timeout DURO
                    maxBuffer: DEFAULT_MAX_BUFFER,
                    encoding: 'utf8',
                    windowsHide: true,
                });
            } catch (err) {
                // SEC-1: error NUEVO. `err` nunca sale de este catch.
                throw sanitizeCliError(err, { service, verb, scopes: [], root: null });
            }
        },
    };
}

/** Allowlist congelada: se evalúa ANTES de que exista un proceso hijo (CA-9). */
function assertVerboPermitido(service, verb) {
    const comando = `${service} ${verb}`;
    if (!VAULT_READONLY_COMMANDS.includes(comando)) {
        throw new VaultConfigError('vault.comando',
            `\`${comando}\` no está en la allowlist read-only del vault `
            + `(${VAULT_READONLY_COMMANDS.join(' · ')}). Escribir en el vault es del rol de `
            + 'provisión, no del runtime de lectura');
    }
}

/** SEC-5 — ningún argumento construido puede convertirse en un flag inesperado. */
function assertArgsSeguros(args) {
    for (const arg of args) {
        if (typeof arg !== 'string') {
            throw new VaultConfigError('vault.args', `argumento no-string (${describeTipo(arg)})`);
        }
        if (FILE_URI_RE.test(arg)) {
            throw new VaultConfigError('vault.args',
                'contiene `file://`: la AWS CLI leería un archivo local del host');
        }
        if (arg.startsWith('-') && !VAULT_ALLOWED_FLAGS.includes(arg)) {
            // Cubre tanto la inyección de flags (SEC-5) como los flags de
            // paginación acotada que truncarían la respuesta (SEC-4).
            throw new VaultConfigError('vault.args', `\`${arg}\` no es un flag conocido del vault`);
        }
    }
}

// -----------------------------------------------------------------------------
// D1.1 / D-SYNC-3 (#5353) — un solo cuerpo, dos conductores
// -----------------------------------------------------------------------------
//
// `credentials.js` hidrata el ambiente en el arranque del Pulpo y de
// `restart.js` con llamadas A NIVEL DE MÓDULO (`pulpo.js:18`, `restart.js:47`)
// cuya razón de ser es el ORDEN (#3311): CommonJS no tiene top-level `await`,
// así que volver async ese camino no cambiaría una firma, destruiría la
// garantía. Este módulo tiene que ofrecer, entonces, una superficie SYNC.
//
// La salida NO es un gemelo duplicado. Duplicar la caché, la allowlist, la
// paginación y el fail-closed reintroduce exactamente la "cobertura ilusoria"
// que G-2 documenta: los tests corren contra un camino y producción usa el
// otro. La lógica se escribe UNA sola vez como generador — cada `yield` es un
// PEDIDO al transporte, y el núcleo no sabe ni le importa si lo van a resolver
// de forma sync o async. Los dos conductores de abajo son lo único que se
// escribe dos veces.
//
// Habilitante: el transporte real YA ES SYNC (`execFileSync`, ver
// `createAwsCliVaultRunner`), o sea que la asincronía de la API pública es
// cosmética — ninguno de los `await` de este módulo espera I/O real.

/**
 * Conduce el núcleo resolviendo cada pedido de forma SÍNCRONA.
 *
 * @param {Generator} generador núcleo que `yield`ea pedidos al transporte
 * @param {function} ejecutar   traductor `pedido -> valor` (sin promesas)
 */
function conducirSync(generador, ejecutar) {
    let paso = generador.next();
    while (!paso.done) {
        let valor;
        try {
            valor = ejecutar(paso.value);
        } catch (err) {
            paso = generador.throw(err);
            continue;
        }
        if (valor && typeof valor.then === 'function') {
            // D-SYNC-6 — una Promise en el camino sync se rechaza de frente.
            // PROHIBIDO esperarla con `Atomics.wait`, `worker_threads`, un Node
            // hijo o `deasync`: todos convierten un problema de contrato en un
            // bloqueo del event loop del Pulpo.
            throw new VaultConfigError('vault.driver',
                `\`${paso.value.op}\` devolvió una Promise en el camino sync. `
                + 'Remediación: el camino sync exige un transporte sync '
                + '(ver createAwsCliVaultRunner)');
        }
        paso = generador.next(valor);
    }
    return paso.value;
}

/** Conduce EL MISMO núcleo resolviendo cada pedido con `await`. */
async function conducirAsync(generador, ejecutar) {
    let paso = generador.next();
    while (!paso.done) {
        let valor;
        try {
            valor = await ejecutar(paso.value);
        } catch (err) {
            paso = generador.throw(err);
            continue;
        }
        paso = generador.next(valor);
    }
    return paso.value;
}

// -----------------------------------------------------------------------------
// Drivers (port/adapter) — AMBOS devuelven la MISMA forma (G-2)
// -----------------------------------------------------------------------------
//
// Port:
//   getParametersByPath(root) -> Promise<{ parameters: Array<{name, value}> }>
//   getSecretValue(name)      -> Promise<{ name, value } | null>
//
// Port sync (D1.3), mismo contrato sin la envoltura de Promise:
//   getParametersByPathSync(root) -> { parameters: Array<{name, value}> }
//   getSecretValueSync(name)      -> { name, value } | null
//
// `value` es SIEMPRE un string con JSON serializado. El parseo vive arriba, en
// `resolveScope`, para que los dos drivers no puedan divergir de tipo.

/**
 * Driver determinístico en memoria: sin red, sin cuenta AWS. Base de los tests.
 *
 * Los valores sembrados como objeto se serializan al sembrar, no al leer: así
 * el driver devuelve strings igual que el aws-cli y el test de paridad (13)
 * compara contratos reales, no una conveniencia del fake.
 *
 * @param {object} [seed]
 * @param {object} [seed.parameters] mapa `path -> valor` (objeto o string JSON)
 * @param {object} [seed.secrets]    mapa `name -> valor` (objeto o string JSON)
 */
function createInMemoryVaultDriver({ parameters = {}, secrets = {} } = {}) {
    const store = new Map();
    for (const [name, value] of Object.entries(parameters)) {
        store.set(name, typeof value === 'string' ? value : JSON.stringify(value));
    }
    const secretStore = new Map();
    for (const [name, value] of Object.entries(secrets)) {
        secretStore.set(name, typeof value === 'string' ? value : JSON.stringify(value));
    }

    const calls = [];

    // D1.3 — el cuerpo es UNO solo y ya era sync; las variantes async quedan
    // como envoltorios finos. Así el fake no puede divergir entre caminos.
    function leerParametros(root) {
        calls.push({ op: 'getParametersByPath', root });
        const out = [];
        for (const [name, value] of store) {
            if (name.startsWith(root)) out.push({ name, value });
        }
        // Orden estable: la resolución no puede depender del orden de inserción.
        out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        return { parameters: out };
    }

    function leerSecreto(name) {
        calls.push({ op: 'getSecretValue', name });
        if (!secretStore.has(name)) return null;
        return { name, value: secretStore.get(name) };
    }

    return {
        kind: 'in-memory',
        calls,

        getParametersByPathSync: leerParametros,
        getSecretValueSync: leerSecreto,

        async getParametersByPath(root) {
            return leerParametros(root);
        },

        async getSecretValue(name) {
            return leerSecreto(name);
        },
    };
}

/**
 * Adapter real sobre la AWS CLI. Fino a propósito: traduce el port al
 * vocabulario CLI y parsea el JSON. El runner es inyectable
 * (`run(service, args)`), así que los tests ejercen ESTE camino sin red.
 */
function createAwsCliVaultDriver({ run } = {}) {
    if (typeof run !== 'function') {
        throw new VaultConfigError('vault.driver',
            'requiere un runner `run(service, args)` (ver createAwsCliVaultRunner)');
    }

    function parsear(raw, { root, scopes }) {
        const texto = String(raw == null ? '' : raw).trim();
        if (!texto) return {};
        try {
            return JSON.parse(texto);
        } catch (e) {
            // Un JSON que no parsea después de un exit 0 es una respuesta
            // CORTADA, no un vault vacío: fail-closed hacia truncación.
            throw new VaultTruncatedResponseError({
                root, reason: 'la respuesta de la CLI no es JSON completo', scopes,
            });
        }
    }

    // D1.1 — la paginación se escribe UNA vez. El `yield` es el pedido al
    // runner; quién lo espera (o no) lo decide el conductor.
    function* nucleoGetParametersByPath(root, opts) {
        const scopes = opts.scopes || [];
        const parameters = [];
        let token = null;
        let pagina = 0;
        do {
            // SEC-4: ningún flag de paginación acotada — la allowlist de
            // flags no los admite. La paginación se sigue a mano hasta
            // agotar `NextToken`, así que nunca se devuelve media respuesta.
            const args = ['get-parameters-by-path', '--path', root, '--recursive', '--with-decryption'];
            if (token) args.push('--starting-token', token);
            const json = parsear(yield { op: 'run', service: 'ssm', args }, { root, scopes });
            for (const p of Array.isArray(json.Parameters) ? json.Parameters : []) {
                parameters.push({ name: p.Name, value: p.Value });
            }
            token = json.NextToken || null;
            pagina += 1;
            if (token && pagina >= MAX_PAGES) {
                // Nunca devolver un resultado parcial en silencio: un scope
                // que quedó en la página 51 se vería como «secreto ausente».
                throw new VaultTruncatedResponseError({
                    root, reason: `NextToken sin consumir tras ${pagina} páginas`, scopes,
                });
            }
        } while (token);
        return { parameters };
    }

    function* nucleoGetSecretValue(name, opts) {
        const scopes = opts.scopes || [];
        let raw;
        try {
            // D9 — `--version-stage AWSCURRENT` explícito y SIN `--version-id`:
            // fijar una versión concreta congela el secreto y la rotación deja
            // de tener efecto sin que nada falle.
            raw = yield {
                op: 'run',
                service: 'secretsmanager',
                args: ['get-secret-value', '--secret-id', name, '--version-stage', 'AWSCURRENT'],
            };
        } catch (err) {
            if (err && err.name === 'VaultCliError' && /ResourceNotFound/i.test(err.message)) {
                return null;
            }
            throw err;
        }
        const json = parsear(raw, { root: name, scopes });
        if (json.SecretString == null) return null;
        return { name, value: String(json.SecretString) };
    }

    // El traductor es el mismo para los dos caminos: `run` ya es sync en
    // producción, y el conductor async sigue aceptando un runner que devuelva
    // Promise (retrocompat del port original).
    const ejecutar = (pedido) => run(pedido.service, pedido.args);

    return {
        kind: 'aws-cli',

        getParametersByPathSync(root, opts = {}) {
            return conducirSync(nucleoGetParametersByPath(root, opts), ejecutar);
        },

        getSecretValueSync(name, opts = {}) {
            return conducirSync(nucleoGetSecretValue(name, opts), ejecutar);
        },

        async getParametersByPath(root, opts = {}) {
            return conducirAsync(nucleoGetParametersByPath(root, opts), ejecutar);
        },

        async getSecretValue(name, opts = {}) {
            return conducirAsync(nucleoGetSecretValue(name, opts), ejecutar);
        },
    };
}

// -----------------------------------------------------------------------------
// createSecretVault — resolución por scope + caché por namespace
// -----------------------------------------------------------------------------

/**
 * Valida la config del vault. Se ejecuta SÓLO con el gate encendido (CA-29):
 * con `enabled: false` no hay validación ni llamadas, y el boot queda idéntico
 * al actual (CA-25). El mensaje nombra la CLAVE de config, nunca el regex.
 */
function validateVaultConfig(config) {
    assertPrefix('vault.prefix', config.prefix);
    assertSegment('vault.projectId', config.projectId);
    // `hostId` se commitea VACÍO (CA-29 · D9 de #5426): el valor real es el
    // `os.hostname()` del host — cf. file-lock.js:145, notify-telegram.js:106 —
    // y lo resuelve `resolveVaultHostId` en runtime. Un placeholder tipo
    // `<host>` pasaba el YAML y explotaba recién el día del rollout.
    //
    // CA-12(e) — vacío o no resoluble falla NOMBRANDO `vault.hostId`, y jamás
    // se sigue adelante contra un namespace colapsado (`hosts//`).
    assertSegment('vault.hostId', config.hostId);

    // #5426 · CA-11(b) — el mecanismo de identidad se valida cuando la clave
    // está declarada. El camino de producción la exige siempre, porque
    // `createAwsCliVaultRunner` llama a `assertVaultAuthConfig` antes de armar
    // el ambiente; acá se cubre además el caso de una config con la clave
    // presente pero inválida y un driver inyectado.
    if (config.authMode !== undefined || config.awsProfile != null) {
        assertVaultAuthConfig(config);
    }

    const ttl = config.cache_ttl_seconds;
    if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0) {
        throw new VaultConfigError('vault.cache_ttl_seconds',
            `debe ser un número de segundos mayor a 0 (recibido: ${describeTipo(ttl)})`);
    }
    if (ttl > MAX_CACHE_TTL_SECONDS) {
        throw new VaultConfigError('vault.cache_ttl_seconds',
            `excede el tope duro de ${MAX_CACHE_TTL_SECONDS} s (recibido: ${ttl}); `
            + 'una credencial rotada seguiría sirviéndose de la caché');
    }
    if (!Array.isArray(config.required_scopes)) {
        throw new VaultConfigError('vault.required_scopes', 'debe ser una lista de scopes');
    }
    if (!Array.isArray(config.shared_secrets)) {
        throw new VaultConfigError('vault.shared_secrets',
            'debe ser una lista de scopes (membresía ENUMERADA: `shared/` no es default)');
    }
    for (const scope of config.required_scopes) assertSegment('vault.required_scopes[]', scope);
    for (const scope of config.shared_secrets) assertSegment('vault.shared_secrets[]', scope);
    for (const scope of config.shared_secrets) {
        if (!config.required_scopes.includes(scope)) {
            throw new VaultConfigError('vault.shared_secrets',
                `declara "${scope}", que no está en \`vault.required_scopes\``);
        }
    }
}

/**
 * Construye el vault de lectura.
 *
 * @param {object} args
 * @param {object} args.config   sección `vault:` de config.yaml + `region`
 * @param {object} args.driver   port de lectura (in-memory o aws-cli)
 * @param {object} [args.logger] logger opcional; recibe SÓLO nombres de scope
 * @param {function} [args.now]  reloj inyectable (ms) para los tests de TTL
 * @returns {{resolveNamespace: Function, resolveScope: Function, clearCache: Function}}
 */
function createSecretVault({ config, driver, logger, now } = {}) {
    const cfg = config && typeof config === 'object' ? config : {};
    const enabled = cfg.enabled === true;   // fail-closed: sólo el booleano exacto
    const reloj = typeof now === 'function' ? now : () => Date.now();

    // D4 / CA-25 — con el gate cerrado NO se valida config (un placeholder no
    // puede voltear el boot) y NO se emite una sola llamada AWS.
    if (enabled) validateVaultConfig(cfg);

    const declarados = Array.isArray(cfg.required_scopes) ? cfg.required_scopes.slice() : [];
    const compartidos = new Set(Array.isArray(cfg.shared_secrets) ? cfg.shared_secrets : []);
    const ttlSegundos = typeof cfg.cache_ttl_seconds === 'number'
        ? Math.min(cfg.cache_ttl_seconds, MAX_CACHE_TTL_SECONDS)
        : MAX_CACHE_TTL_SECONDS;

    // SEC-6(d) — el Map vive en el closure: no es propiedad del objeto, no se
    // exporta, no es enumerable y no se serializa. Nunca toca el disco.
    const cache = new Map();

    function claveNamespace() {
        // SEC-6 — la clave INCLUYE el namespace: un hit del host A jamás puede
        // servir la resolución del host B.
        return `${cfg.prefix}/${cfg.projectId}#${cfg.hostId}`;
    }

    function tierDe(scope) {
        return compartidos.has(scope) ? 'shared' : 'host';
    }

    function invalidarSiEsAuth(err) {
        // SEC-6(a) — una credencial expirada invalida TODO el namespace: seguir
        // sirviendo de la caché con la sesión muerta enmascara la falla.
        if (err && AUTH_ERROR_RE.test(String(err.message || ''))) cache.clear();
    }

    function log(nivel, msg, meta) {
        if (!logger || typeof logger[nivel] !== 'function') return;
        logger[nivel](msg, meta);   // CA-23: `meta` sólo lleva NOMBRES de scope
    }

    // D-SYNC-6 — el camino sync exige el port sync del driver. Si falta, se
    // falla cerrado NOMBRANDO el método: nunca se devuelve vacío y nunca se
    // espera la Promise con un hack de bloqueo.
    function ejecutarSync(pedido) {
        const metodo = pedido.op === 'getParametersByPath'
            ? 'getParametersByPathSync'
            : 'getSecretValueSync';
        if (!driver || typeof driver[metodo] !== 'function') {
            throw new VaultConfigError('vault.driver',
                `el driver "${(driver && driver.kind) || 'desconocido'}" no expone \`${metodo}\`, `
                + 'que el camino sync exige. Remediación: usar `createAwsCliVaultDriver` o '
                + '`createInMemoryVaultDriver`, o agregar el port sync al driver inyectado');
        }
        return pedido.op === 'getParametersByPath'
            ? driver.getParametersByPathSync(pedido.root, pedido.opts)
            : driver.getSecretValueSync(pedido.name, pedido.opts);
    }

    function ejecutarAsync(pedido) {
        return pedido.op === 'getParametersByPath'
            ? driver.getParametersByPath(pedido.root, pedido.opts)
            : driver.getSecretValue(pedido.name, pedido.opts);
    }

    /**
     * Núcleo ÚNICO de la resolución del namespace (D1.1 / D-SYNC-3): caché,
     * TTL, tiers, presupuesto de llamadas, fail-closed y taxonomía de errores
     * viven acá una sola vez. Los dos caminos públicos lo conducen.
     *
     * Resuelve el namespace completo con A LO SUMO DOS llamadas batch (SEC-3):
     * una a `<prefix>/<projectId>/shared/` y otra a
     * `<prefix>/<projectId>/hosts/<hostId>/`. Nunca una llamada por variable, y
     * nunca un barrido recursivo desde la raíz del proyecto.
     *
     * @param {object} [opts]
     * @param {string[]} [opts.scopes] subconjunto de `required_scopes`
     */
    function* nucleoResolveNamespace(opts = {}) {
        if (!enabled) {
            // CA-25 / test 15 — ni una llamada al driver.
            return { enabled: false, namespace: null, scopes: {}, tiers: {} };
        }
        const pedidos = normalizarScopes(opts.scopes);
        const clave = claveNamespace();
        const entrada = cache.get(clave);
        if (entrada) {
            if (entrada.expiraEn > reloj()) {
                if (pedidos.every((s) => Object.prototype.hasOwnProperty.call(entrada.scopes, s))) {
                    return proyectar(entrada, pedidos, clave);
                }
            } else {
                // SEC-6(c) — la expiración BORRA la entrada, no la marca.
                cache.delete(clave);
            }
        }

        // Sólo se barre la raíz de un tier si algún scope pedido vive ahí: el
        // presupuesto es «a lo sumo dos», no «siempre dos».
        const porTier = new Map();
        for (const scope of pedidos) {
            const tier = tierDe(scope);
            if (!porTier.has(tier)) porTier.set(tier, []);
            porTier.get(tier).push(scope);
        }

        const crudos = new Map();
        const tiers = {};
        try {
            for (const [tier, scopesDelTier] of porTier) {
                const root = buildParameterPath({
                    prefix: cfg.prefix, projectId: cfg.projectId, hostId: cfg.hostId, tier, root: true,
                });
                const res = yield {
                    op: 'getParametersByPath', root, opts: { scopes: scopesDelTier },
                };
                const params = (res && Array.isArray(res.parameters)) ? res.parameters : [];
                if (res && res.nextToken) {
                    // Un driver que devuelve un token sin consumir está entregando
                    // un resultado PARCIAL: error, jamás «scope vacío» (SEC-4).
                    throw new VaultTruncatedResponseError({
                        root, reason: 'el driver devolvió NextToken sin consumir', scopes: scopesDelTier,
                    });
                }
                for (const p of params) crudos.set(p.name, p.value);
            }

            const resueltos = {};
            for (const scope of pedidos) {
                const tier = tierDe(scope);
                const path = buildParameterPath({
                    prefix: cfg.prefix, projectId: cfg.projectId, hostId: cfg.hostId, scope, tier,
                });
                if (!crudos.has(path)) {
                    // Fail-closed: nunca '' ni un default (CA-21 / CA-32).
                    throw new VaultSecretMissingError(scope, path, tier);
                }
                resueltos[scope] = parsearScope(scope, crudos.get(path));
                tiers[scope] = tier;
            }

            const nueva = {
                namespace: clave,
                scopes: resueltos,
                tiers,
                expiraEn: reloj() + ttlSegundos * 1000,
            };
            cache.set(clave, nueva);   // SIN negative caching: sólo se cachea el éxito
            log('info', 'vault: namespace resuelto', redactScoped({
                ok: true, namespace: clave, scopes: resueltos, missing: [],
            }));
            return proyectar(nueva, pedidos, clave);
        } catch (err) {
            invalidarSiEsAuth(err);
            // CA-23 — al log van el nombre del error y los NOMBRES de scope.
            // Nunca `err.message` crudo del driver, nunca el stdout de la CLI.
            log('warn', 'vault: fallo de resolución', {
                namespace: clave, scopes: pedidos, error: err && err.name, code: err && err.code,
            });
            throw err;   // CA-22: un fallo de auth se PROPAGA, jamás se degrada
        }
    }

    function proyectar(entrada, pedidos, clave) {
        const scopes = {};
        const tiers = {};
        for (const s of pedidos) {
            scopes[s] = entrada.scopes[s];
            tiers[s] = entrada.tiers[s];
        }
        return { enabled: true, namespace: clave, scopes, tiers };
    }

    function normalizarScopes(scopes) {
        const lista = Array.isArray(scopes) && scopes.length ? scopes : declarados;
        for (const s of lista) {
            assertSegment('vault.required_scopes[]', s);
            if (!declarados.includes(s)) {
                // D5 — sólo se resuelve lo DECLARADO. No existe un camino que
                // hidrate de una las 13 vars de ENV_MAPPING.
                throw new VaultConfigError('vault.required_scopes',
                    `no declara el scope "${s}"; el vault sólo resuelve scopes declarados`);
            }
        }
        return lista.slice();
    }

    /**
     * Núcleo ÚNICO de `resolveScope` (D1.1). Devuelve SÓLO los scopes
     * declarados, ya parseados desde JSON (G-2).
     *
     * @param {object} args
     * @param {string[]} args.scopes
     * @param {'shared'|'host'|'rotating'} [args.tier] `rotating` va a Secrets Manager
     */
    function* nucleoResolveScope({ scopes, tier } = {}) {
        if (!enabled) return {};
        if (tier === 'rotating') {
            const pedidos = normalizarScopes(scopes);
            const out = {};
            for (const scope of pedidos) {
                const name = buildParameterPath({
                    prefix: cfg.prefix, projectId: cfg.projectId, scope, tier: 'rotating',
                });
                let res;
                try {
                    res = yield { op: 'getSecretValue', name, opts: { scopes: [scope] } };
                } catch (err) {
                    invalidarSiEsAuth(err);
                    throw err;
                }
                if (!res || res.value == null) throw new VaultSecretMissingError(scope, name, 'rotating');
                out[scope] = parsearScope(scope, res.value);
            }
            return out;
        }
        const res = yield* nucleoResolveNamespace({ scopes });
        return res.scopes;
    }

    // -------------------------------------------------------------------------
    // Superficie pública — dos caminos, un solo cuerpo (D1.1 / D1.2 / D-SYNC-2)
    // -------------------------------------------------------------------------
    //
    // D1.5 / D-SYNC-4: las async siguen DECLARADAS `async` (su
    // `constructor.name` sigue siendo `AsyncFunction` y siguen devolviendo
    // `Promise`), así que la superficie observable de #5352 no cambia y su
    // suite queda verde sin editarse.

    /** @returns {Promise<{enabled:boolean, namespace:string|null, scopes:object, tiers:object}>} */
    async function resolveNamespace(opts = {}) {
        return conducirAsync(nucleoResolveNamespace(opts), ejecutarAsync);
    }

    /** @returns {Promise<object>} mapa `scope -> objeto` */
    async function resolveScope(args = {}) {
        return conducirAsync(nucleoResolveScope(args), ejecutarAsync);
    }

    /** Gemelo sync: MISMO cuerpo, mismos errores, mismos códigos (D1.4). */
    function resolveNamespaceSync(opts = {}) {
        return conducirSync(nucleoResolveNamespace(opts), ejecutarSync);
    }

    /** Gemelo sync: MISMO cuerpo, mismos errores, mismos códigos (D1.4). */
    function resolveScopeSync(args = {}) {
        return conducirSync(nucleoResolveScope(args), ejecutarSync);
    }

    /** SEC-6(c) — invalidación explícita, idempotente. */
    function clearCache() {
        cache.clear();
    }

    const vault = {
        resolveNamespace,
        resolveScope,
        clearCache,

        // CA-30 / UX-3 — forma POSITIVA, no sólo la negativa. El Pulpo vuelca
        // objetos a los logs para diagnosticar: devolver `'[SecretVault]'`
        // cumpliría «oculta valores» y borraría toda la observabilidad.
        //   SecretVault { enabled: false, scopes: ['telegram','aws'], cached: 2, ttl_s: 300 }
        [util.inspect.custom](depth, options, inspect) {
            const render = typeof inspect === 'function' ? inspect : util.inspect;
            const forma = {
                enabled,
                scopes: declarados.slice(),   // NOMBRES, nunca valores (CA-23)
                cached: cache.size,
                ttl_s: ttlSegundos,
            };
            return `SecretVault ${render(forma, { ...(options || {}), depth: null })}`;
        },
    };

    // D1.2 / D1.5 — los gemelos sync se cuelgan como propiedades NO
    // ENUMERABLES a propósito. El test 8 de #5352 congela la superficie
    // enumerable del vault (`Object.keys(vault).sort()` === los 3 de siempre)
    // como parte de CA-20/SEC-6(d), y esa suite tiene que quedar verde SIN
    // editarse. Non-enumerable satisface las dos cosas a la vez: el método es
    // público, invocable y testeable, y `Object.keys` / `JSON.stringify` /
    // `util.inspect` siguen viendo exactamente la forma que #5352 firmó.
    Object.defineProperty(vault, 'resolveNamespaceSync', {
        value: resolveNamespaceSync, enumerable: false, writable: false, configurable: false,
    });
    Object.defineProperty(vault, 'resolveScopeSync', {
        value: resolveScopeSync, enumerable: false, writable: false, configurable: false,
    });

    return vault;
}

/** G-2 — JSON inválido ⇒ ERROR, nunca scope vacío. */
function parsearScope(scope, raw) {
    if (typeof raw !== 'string') {
        throw new VaultCliError({
            service: 'vault', verb: 'parse', exitCode: null,
            stderr: `el driver devolvió ${describeTipo(raw)} para el scope "${scope}"; `
                + 'el contrato es un string con JSON serializado',
            scopes: [scope],
        });
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        // El mensaje NO incluye `raw`: es el secreto. Sólo el nombre del scope.
        throw new VaultCliError({
            service: 'vault', verb: 'parse', exitCode: null,
            stderr: `el valor del scope "${scope}" no es JSON válido`,
            scopes: [scope],
        });
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new VaultCliError({
            service: 'vault', verb: 'parse', exitCode: null,
            stderr: `el valor del scope "${scope}" no es un objeto JSON`,
            scopes: [scope],
        });
    }
    return parsed;
}

module.exports = {
    VAULT_READONLY_COMMANDS,
    VAULT_ALLOWED_FLAGS,
    VAULT_TIERS,
    VAULT_ERROR_CODES,
    MAX_CACHE_TTL_SECONDS,
    // #5426 — mecanismo de identidad del host. `VAULT_AUTH_MODES` se exporta
    // para que el enum viva en UN solo lugar: la config, el guard y los tests
    // leen la misma lista congelada, y no hay una segunda copia que se
    // desincronice.
    VAULT_AUTH_MODES,
    buildVaultAwsEnv,
    assertVaultAuthConfig,
    resolveVaultHostId,
    buildParameterPath,
    // #5464 — validación canónica reutilizable por el tramo de provisión
    // (#5425). Los regex NO se exportan a propósito: exportarlos habilitaría
    // la copia que este helper viene a evitar.
    VAULT_TIER_SERVICE,
    validateVaultNamespace,
    createInMemoryVaultDriver,
    createAwsCliVaultDriver,
    createAwsCliVaultRunner,
    createSecretVault,
    // CA-28 — EXACTAMENTE tres claves terminadas en `Error`, una por falla
    // terminal con remediación propia. `VaultConfigError` se discrimina por
    // `code`/`name` (ver VAULT_ERROR_CODES), no se exporta como clase.
    VaultSecretMissingError,
    VaultCliError,
    VaultTruncatedResponseError,
};

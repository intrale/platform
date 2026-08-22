#!/usr/bin/env node
// qa-video-share.js — Distribuye videos de evidencia QA a stakeholders vía Google Drive + Telegram
//
// Uso:
//   node qa/scripts/qa-video-share.js \
//     --issue 1112 \
//     --title "Login — happy path" \
//     --sprint "SPR-0051" \
//     --videos "qa/recordings/maestro-shard-5554.mp4,qa/recordings/maestro-shard-5556.mp4" \
//     --verdict "APROBADO" \
//     --passed 3 --total 3
//
// Estrategia en 3 niveles:
//   1. Google Drive (OAuth desde el store canonico; como fallback, el JSON de
//      Service Account que apunte GOOGLE_CREDENTIALS_PATH):
//      → Sube video a "Intrale QA / SPR-XXXX / #issue-titulo /"
//      → Permisos "anyone with link" (reader)
//      → Envía link por Telegram (mensaje descriptivo)
//      → Guarda video_url en qa-report.json
//   2. Video <= 50MB y Drive no disponible → sendVideo directo por Telegram Bot API
//   3. Video > 50MB sin Drive → subir a Cloudflare R2 + enviar link (si R2 esta
//      provisionado). Se resuelve del namespace `r2` del store canonico, con
//      override por env. Sin claves en ningun almacen el estado es "no
//      provisionado" (CA-14): falta trabajo humano en Cloudflare, no un valor
//      que el operador pueda escribir.
//
// Dependencias: ninguna (Node.js puro, https/crypto nativos)
//
// Credenciales (#5217): todas se resuelven con el mismo resolvedor generico,
// precedencia env > store canonico (~/.claude/secrets/credentials.json) > legacy
// (.claude/hooks/telegram-config.json, SOLO LECTURA — nunca destino de escritura).
//   Telegram → telegram.bot_token / telegram.chat_id
//   Drive    → google_drive.oauth_client_id / oauth_client_secret /
//              oauth_refresh_token / drive_folder_id
//   R2       → r2.account_id / access_key_id / secret_access_key / bucket
// Drive y R2 leen su namespace bajo demanda via resolveScopedRefs: NO estan en
// ENV_MAPPING, para no ampliar el process.env global que hereda todo agente hijo.

const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const {
    buildTelegramMessage,
    resolveMode,
    resolveVerdict,
    isValidIssue,
    formatTimestamp,
} = require("./qa-telegram-template");

// --- Constantes ---

const TELEGRAM_MAX_VIDEO_SIZE = 50 * 1024 * 1024; // 50MB
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2000;
const R2_PRESIGNED_EXPIRY_SECONDS = 7 * 24 * 60 * 60; // 7 dias

// #4173: mapa extension -> mime para subir assets de evidencia a Drive
const ASSET_MIME = {
    png: "image/png",
    zip: "application/zip",
    html: "text/html",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
};

// --- Config ---

const HOOKS_DIR = path.resolve(__dirname, "../../.claude/hooks");
const CONFIG_PATH = path.join(HOOKS_DIR, "telegram-config.json");

// #4907: el store unificado (~/.claude/secrets/credentials.json) es la fuente
// canonica de bot_token/chat_id. El archivo versionado telegram-config.json
// quedo con placeholders tras la unificacion (#3311) y solo sirve de fallback
// (y como unica fuente de la config de Google Drive).
const CREDENTIALS_LIB_PATH = path.resolve(__dirname, "../../.pipeline/lib/credentials.js");
let credentialsLib = null;
try {
    credentialsLib = require(CREDENTIALS_LIB_PATH);
} catch (e) {
    console.error("[qa-video-share] WARN: no se pudo cargar el store unificado de credenciales (" + e.message + ")");
    credentialsLib = null;
}

// Formato real de un bot token de Telegram: "<bot_id>:<secreto>".
const TELEGRAM_TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;

// Detecta placeholders (MOVED_TO_HOME_DOT_CLAUDE_SECRETS, REVOKED, etc.).
// Reusa el detector del loader central; si el loader no esta disponible, aplica
// la misma regex localmente para no perder la validacion.
const LOCAL_PLACEHOLDER_RE = /(REVOKED|PLACEHOLDER|MOVED|EXAMPLE|REPLACE|CHANGE_ME)/i;
function isPlaceholderOrEmpty(value) {
    if (credentialsLib && typeof credentialsLib.isPlaceholderOrEmpty === "function") {
        return credentialsLib.isPlaceholderOrEmpty(value);
    }
    if (value === null || value === undefined) return true;
    const s = String(value);
    if (s.trim().length === 0) return true;
    return LOCAL_PLACEHOLDER_RE.test(s);
}

function isValidBotToken(value) {
    if (isPlaceholderOrEmpty(value)) return false;
    return TELEGRAM_TOKEN_RE.test(String(value).trim());
}

// chat_id puede ser numerico (-100123...) o un @username de canal. Solo se
// exige que no este vacio ni sea un placeholder.
function isValidChatId(value) {
    return !isPlaceholderOrEmpty(value);
}

function readJsonSafe(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (e) {
        return null;
    }
}

// Hidrata un env descartable con el store unificado (no toca process.env).
function readUnifiedStore(opts = {}) {
    const lib = opts.credentialsLib !== undefined ? opts.credentialsLib : credentialsLib;
    if (!lib || typeof lib.loadIntoEnv !== "function") return {};
    const scratch = {};
    const loadOpts = { env: scratch, logger: () => {} };
    if (opts.canonicalPath) loadOpts.canonicalPath = opts.canonicalPath;
    if (opts.storeLegacyPath) loadOpts.legacyPath = opts.storeLegacyPath;
    try {
        lib.loadIntoEnv(loadOpts);
    } catch (e) {
        return {};
    }
    return scratch;
}

// -----------------------------------------------------------------------------
// Resolvedor generico de credenciales (#5217 — generaliza el de Telegram de
// #4907 y entrega el helper compartido que pide #4917).
//
// Cada credencial declara un `spec` con sus campos y, por campo, los candidatos
// ordenados: env > store canonico > legacy. La validacion es por FORMA, asi que
// un placeholder en un nivel NO corta la cadena: se descarta y pasa al siguiente
// (CA-3). El resultado reporta la fuente de cada valor para que un fallo futuro
// se diagnostique en el log y no con otra investigacion.
// -----------------------------------------------------------------------------

// Ref namespaceado SIEMPRE en forma tilde. RIESGO A-1 (#5217): el regex de
// `parseSecretRef` (en `.pipeline/lib/credentials.js`) no admite `\` ni `C:`,
// asi que armar el ref con `credentialsLib.CANONICAL_PATH` en Windows devuelve
// `{ok:false, namespace:null}` SIN lanzar excepcion — exactamente el modo de
// falla silenciosa que este issue cierra, reintroducido por la via del fix.
// El path real del SO viaja por `opts.canonicalPath`, que `resolveScopedRefs`
// prioriza sobre su `expandHome(ref)` interno.
//
// Se citan SIMBOLOS y no numeros de linea a proposito: `credentials.js` crecio
// de ~230 a ~950 lineas entre el punto de rama y `main`, y los anchors que
// tenia este comentario ya apuntaban a codigo que no era el descripto. Un
// comentario que manda a leer la linea equivocada es peor que ninguno.
// Ampliar el regex queda fuera de alcance (parser del brokering de #4687 /
// #4738, requiere sign-off de `security`).
const STORE_REF = "~/.claude/secrets/credentials.json";

/**
 * Lee SOLO los scopes declarados de un namespace del store canonico.
 *
 * Usa `resolveScopedRefs`, NO `readUnifiedStore()`: este ultimo delega en
 * `loadIntoEnv()`, que itera `ENV_MAPPING` — y CA-6 de #5217 prohibe agregar
 * Drive/R2/AWS ahi, porque `loadIntoEnv` escribe en el `process.env` global que
 * hereda todo proceso hijo de todo agente. Con `resolveScopedRefs` se lee el
 * namespace directo del JSON, sin tocar `process.env`.
 *
 * @returns {{found:boolean, scopes:object}} `found:false` = namespace ausente o
 *          archivo ilegible (estado "no provisionado" de CA-14), distinto de
 *          "namespace presente con scopes faltantes".
 */
function resolveStoreScopes(namespace, scopes, opts = {}) {
    const lib = opts.credentialsLib !== undefined ? opts.credentialsLib : credentialsLib;
    if (!lib || typeof lib.resolveScopedRefs !== "function") return { found: false, scopes: {} };
    if (!namespace || !Array.isArray(scopes) || scopes.length === 0) return { found: false, scopes: {} };

    // #5898 — opt-in explicito de primera parte. Los namespaces que lee este
    // script (`google_drive`, `r2`) son BLOQUES GLOBALES del store, no tenants:
    // la deny-list `RESERVED_STORE_NAMESPACES` existe para que un producto no se
    // registre con esos nombres y cobre las llaves del sistema, no para tapiar
    // al duenio. Este es el unico sitio del script que resuelve contra el store,
    // asi que el flag va aca y en ningun otro lado.
    const refOpts = { systemNamespace: true };
    if (opts.storeData !== undefined) refOpts.data = opts.storeData || {};
    else refOpts.canonicalPath = opts.canonicalPath || lib.CANONICAL_PATH;

    let res = null;
    try {
        res = lib.resolveScopedRefs(STORE_REF + "#" + namespace, scopes, refOpts);
    } catch (e) {
        return { found: false, scopes: {} };
    }
    if (!res) return { found: false, scopes: {} };
    // `found` significa "el namespace EXISTE en el store", no "resolvio todo":
    // es la distincion de CA-14 entre "no provisionado" (no hay bloque) y
    // "configuracion incompleta" (hay bloque, faltan scopes).
    //
    // #5898 — antes esto se leia como `!res.error`, que funcionaba de casualidad:
    // la rama de scopes faltantes salia con `error: undefined`. Ese `undefined`
    // era justamente uno de los bugs que #5898 cierra (CA-6: ningun fail-closed
    // sale sin `error`), asi que el proxy se rompio al arreglarlo. Ahora la
    // intencion se expresa con el `code`, que es explicito: el unico fallo que
    // NO significa "namespace ausente" es `scope_faltante`.
    const found = res.ok === true || res.code === "scope_faltante";
    return { found, scopes: res.scopes || {} };
}

// Path del store efectivamente consultado. Si el caller inyecta `canonicalPath`
// (tests, o un store alternativo), el mensaje tiene que nombrar ESE archivo y no
// el default del modulo: decirle al operador que se miro un store distinto del
// que se leyo es el mismo modo de falla "te mando al lugar equivocado" que
// #5217 cierra.
function effectiveCanonicalPath(opts = {}) {
    return opts.canonicalPath || (credentialsLib && credentialsLib.CANONICAL_PATH) || STORE_REF;
}

// Lista de fuentes consultadas, en orden, para el mensaje al operador (CA-10).
function credentialSources(spec, opts = {}) {
    const canonical = effectiveCanonicalPath(opts);
    const legacyPath = opts.legacyConfigPath || CONFIG_PATH;
    const out = [];
    const envNames = spec.fields.map(f => f.env).filter(Boolean);
    if (envNames.length) out.push("env " + envNames.join("/"));
    out.push(spec.namespace ? canonical + "#" + spec.namespace : canonical);
    // El archivo del repo solo se nombra si algun campo lo consulta, y siempre
    // como fuente legacy de LECTURA — nunca como destino de escritura (CA-9).
    if (spec.fields.some(f => (f.legacy || []).length > 0)) {
        out.push(legacyPath + (spec.legacyReadOnly ? " (legacy, solo lectura)" : ""));
    }
    // Fuentes extra que el consumidor consulta por fuera del spec (Drive tiene
    // el fallback de Service Account, `driveAvailable()`). Si no se nombran, el
    // operador con el JSON de Service Account mal apuntado lee un diagnostico
    // que nunca menciona la fuente que realmente fallo.
    for (const extra of (spec.extraSources || [])) out.push(extra);
    return out;
}

/**
 * Resuelve todos los campos de un `spec` con precedencia env > store > legacy.
 *
 * @param {object} spec  ver TELEGRAM_SPEC / DRIVE_SPEC / R2_SPEC.
 * @param {object} [opts] overrides para tests: env, legacyConfig/legacyConfigPath,
 *                        store (scratch de ENV_MAPPING), storeData (JSON del store
 *                        canonico), canonicalPath, storeLegacyPath, credentialsLib.
 * @returns {{label:string, namespace:string|null, values:object, sources:object,
 *            valid:boolean, missing:string[], state:string, stateLabel:string,
 *            storeNamespaceFound:boolean, sourcesConsulted:string[],
 *            remediation:string}}
 */
function resolveCredential(spec, opts = {}) {
    const env = opts.env || process.env;
    const legacyConfigPath = opts.legacyConfigPath || CONFIG_PATH;
    const legacyConfig = (opts.legacyConfig !== undefined)
        ? (opts.legacyConfig || {})
        : (readJsonSafe(legacyConfigPath) || {});
    const legacyLabel = "legacy:" + path.basename(legacyConfigPath);

    // Telegram sigue leyendo el scratch de ENV_MAPPING (compat exacta con #4907,
    // incluido su fallback al legacy de ~/.claude/secrets). Drive y R2 resuelven
    // por namespace, sin pasar por ENV_MAPPING (CA-6).
    const needsEnvStore = spec.fields.some(f => f.storeEnvKey);
    const envStore = needsEnvStore
        ? ((opts.store !== undefined) ? (opts.store || {}) : readUnifiedStore(opts))
        : {};
    const scopeNames = spec.fields.map(f => f.scope).filter(Boolean);
    const scoped = spec.namespace
        ? resolveStoreScopes(spec.namespace, scopeNames, opts)
        : { found: false, scopes: {} };

    const values = {};
    const sources = {};
    const missing = [];

    for (const field of spec.fields) {
        const candidates = [];
        if (field.env) candidates.push({ source: "env:" + field.env, value: env[field.env] });
        if (field.storeEnvKey) {
            candidates.push({ source: "store:credentials.json", value: envStore[field.storeEnvKey] });
        }
        if (field.scope && spec.namespace) {
            candidates.push({
                source: "store:" + spec.namespace + "." + field.scope,
                value: scoped.scopes[field.scope],
            });
        }
        for (const key of (field.legacy || [])) {
            candidates.push({
                source: key === field.key ? legacyLabel : legacyLabel + "#" + key,
                value: legacyConfig[key],
            });
        }

        const isValid = field.isValid || spec.isValid || ((v) => !isPlaceholderOrEmpty(v));
        const hit = candidates.find(c => isValid(c.value));
        if (hit) {
            values[field.name] = String(hit.value).trim();
            sources[field.name] = hit.source;
        } else {
            values[field.name] = field.fallback || "";
            sources[field.name] = field.fallback ? "default" : null;
            if (!field.optional) missing.push(field.key);
        }
    }

    // CA-14: "no provisionado" (nada resuelve en ninguna fuente) es un estado
    // distinto de "configuracion incompleta" (algo resuelve y falta el resto).
    const required = spec.fields.filter(f => !f.optional);
    const resolvedRequired = required.filter(f => sources[f.name] && sources[f.name] !== "default").length;
    const state = missing.length === 0 ? "ok" : (resolvedRequired === 0 ? "absent" : "partial");
    const stateLabel = state === "ok"
        ? "configurado"
        : (state === "absent" ? (spec.absentLabel || "no configurado") : "configuracion incompleta");

    const canonical = effectiveCanonicalPath(opts);
    return {
        label: spec.label,
        namespace: spec.namespace || null,
        values,
        sources,
        valid: missing.length === 0,
        missing,
        state,
        stateLabel,
        storeNamespaceFound: !!scoped.found,
        sourcesConsulted: credentialSources(spec, opts),
        remediation: typeof spec.remediation === "function"
            ? spec.remediation({ canonical, legacyPath: legacyConfigPath })
            : "",
    };
}

/**
 * Mensaje explicito de credencial faltante (#4907 CA-3, generalizado por CA-10
 * de #5217). Va a stderr ANTES de cualquier intento de uso, con el formato
 * `[qa-video-share] <que falta> · <fuentes en orden> · <como resolverlo>`.
 * Nunca incluye valores de credenciales.
 */
// CA-14: el diagnostico tiene que decir el MISMO estado que reporta
// `stateLabel`. Hardcodear "no configuradas" borraba la distincion que CA-14
// introduce: R2 ausente de todo almacen es "no provisionado" (falta trabajo
// humano en Cloudflare), no "no configurado" (falta un valor que el operador
// puede escribir). El operador que lee el mensaje decide que hacer con eso.
//
// Mapa explicito en vez de derivar el femenino plural por regex: el estado es
// un enum corto y una conversion magica se rompe en silencio con la primera
// etiqueta que no termine en "o". `specAbsentLabels()` garantiza cobertura.
const STATE_PHRASES = Object.freeze({
    "no configurado": "no configuradas",
    "no provisionado": "no provisionadas",
    "configuracion incompleta": "con configuracion incompleta",
});
const DEFAULT_STATE_PHRASE = "no configuradas";

function credentialStatePhrase(cred) {
    const label = cred && cred.stateLabel;
    return (label && STATE_PHRASES[label]) || DEFAULT_STATE_PHRASE;
}

function describeMissingCredentials(cred) {
    // Defensivo: este helper se llama en el camino de ERROR, donde un TypeError
    // propio taparia el diagnostico que el operador necesita. Un `cred` viejo o
    // parcial degrada el mensaje, no lo rompe.
    const missing = (cred && cred.missing) || [];
    const consulted = (cred && cred.sourcesConsulted) || [];
    let msg = "[qa-video-share] credenciales de " + ((cred && cred.label) || "?") +
        " " + credentialStatePhrase(cred) +
        ": falta " + (missing.length ? missing.join(" y ") : "(sin detalle)") + ".";
    if (consulted.length) msg += " Fuentes consultadas (en orden): " + consulted.join(" > ") + ".";
    if (cred && cred.remediation) msg += " " + cred.remediation;
    return msg;
}

// --- Specs de credenciales ---

const TELEGRAM_SPEC = Object.freeze({
    label: "Telegram",
    namespace: null,
    absentLabel: "no configurado",
    fields: [
        {
            name: "botToken", key: "bot_token",
            env: "TELEGRAM_BOT_TOKEN", storeEnvKey: "TELEGRAM_BOT_TOKEN",
            legacy: ["bot_token"], isValid: isValidBotToken,
        },
        {
            // sponsor_chat_id mantiene la precedencia historica sobre chat_id
            // dentro del nivel legacy, pasando por el mismo filtro de placeholder.
            name: "chatId", key: "chat_id",
            env: "TELEGRAM_CHAT_ID", storeEnvKey: "TELEGRAM_CHAT_ID",
            legacy: ["sponsor_chat_id", "chat_id"], isValid: isValidChatId,
        },
    ],
});

// Los dot-paths son los del store canonico: `google_drive.<scope>` (anidado).
// Los nombres flat (`google_oauth_client_id`) son del formato legacy y solo
// valen como ultimo nivel de la cadena.
const DRIVE_SPEC = Object.freeze({
    label: "Google Drive",
    namespace: "google_drive",
    absentLabel: "no configurado",
    legacyReadOnly: true,
    fields: [
        { name: "clientId", key: "oauth_client_id", env: "GOOGLE_OAUTH_CLIENT_ID", scope: "oauth_client_id", legacy: ["google_oauth_client_id"] },
        { name: "clientSecret", key: "oauth_client_secret", env: "GOOGLE_OAUTH_CLIENT_SECRET", scope: "oauth_client_secret", legacy: ["google_oauth_client_secret"] },
        { name: "refreshToken", key: "oauth_refresh_token", env: "GOOGLE_OAUTH_REFRESH_TOKEN", scope: "oauth_refresh_token", legacy: ["google_oauth_refresh_token"] },
        { name: "folderId", key: "drive_folder_id", env: "GOOGLE_DRIVE_FOLDER_ID", scope: "drive_folder_id", legacy: ["google_drive_folder_id"] },
    ],
    // Fallback de Service Account: `driveAvailable()` lo consulta cuando el
    // triplete OAuth no resuelve, asi que el diagnostico tiene que nombrarlo.
    // No es un scope del vault: es un PATH a un JSON, o sea configuracion.
    extraSources: ["fallback Service Account: env GOOGLE_CREDENTIALS_PATH > google_credentials_path (legacy, solo lectura)"],
    remediation: ({ canonical }) => "Se resuelve escribiendo google_drive.oauth_client_id / oauth_client_secret / " +
        "oauth_refresh_token / drive_folder_id en " + canonical +
        ", o re-autorizando con `node scripts/google-drive-oauth-setup.js` (persiste ahi, sin secretos por linea de comandos).",
});

// CA-13: R2 queda cableado contra el store, pero ningun criterio depende de que
// suba. Sus claves no existen en ningun almacen: el alta requiere provisionar
// credenciales en Cloudflare (trabajo humano), de ahi el estado "no provisionado".
const R2_SPEC = Object.freeze({
    label: "Cloudflare R2",
    namespace: "r2",
    absentLabel: "no provisionado",
    fields: [
        { name: "accountId", key: "account_id", env: "R2_ACCOUNT_ID", scope: "account_id" },
        { name: "accessKeyId", key: "access_key_id", env: "R2_ACCESS_KEY_ID", scope: "access_key_id" },
        { name: "secretAccessKey", key: "secret_access_key", env: "R2_SECRET_ACCESS_KEY", scope: "secret_access_key" },
        { name: "bucket", key: "bucket", env: "R2_BUCKET", scope: "bucket", optional: true, fallback: "intrale-qa-evidence" },
    ],
    remediation: ({ canonical }) => "R2 no esta provisionado: requiere crear credenciales en Cloudflare y escribirlas " +
        "en r2.account_id / access_key_id / secret_access_key / bucket de " + canonical + ".",
});

/**
 * Wrapper de compatibilidad (#4907). Se conserva la firma y el contrato: hay
 * consumidores y tests que lo importan por nombre (R-5 de #5217).
 */
function resolveTelegramCredentials(opts = {}) {
    const cred = resolveCredential(TELEGRAM_SPEC, opts);
    return Object.assign({}, cred, {
        botToken: cred.values.botToken,
        chatId: cred.values.chatId,
        botTokenSource: cred.sources.botToken,
        chatIdSource: cred.sources.chatId,
    });
}

function describeMissingTelegramCredentials(cred) {
    return describeMissingCredentials(cred);
}

const TELEGRAM_CREDENTIALS = resolveTelegramCredentials();
const BOT_TOKEN = TELEGRAM_CREDENTIALS.botToken;
const CHAT_ID = TELEGRAM_CREDENTIALS.chatId;

// Drive y R2 se resuelven de forma PEREZOSA y memoizada: no se toca el store al
// cargar el modulo, solo cuando alguien pide esas credenciales. Con `opts` la
// resolucion no se memoiza — es la via de inyeccion de los tests.
//
// Ojo: `TELEGRAM_CREDENTIALS` (arriba) SI resuelve en tiempo de carga y por lo
// tanto lee el store real en un `require()`. Viene de #4907 y no se cambia acá
// para no arrastrar una regresion de Telegram (R-5); lo que no hace, ni acá ni
// allá, es IMPRIMIR valores. Los tests no dependen de ese contenido: inyectan
// sus fixtures por `opts`.
let _driveCredentials = null;
function getDriveCredentials(opts) {
    if (opts) return resolveCredential(DRIVE_SPEC, opts);
    if (!_driveCredentials) _driveCredentials = resolveCredential(DRIVE_SPEC);
    return _driveCredentials;
}
function driveOAuth() {
    return getDriveCredentials().values;
}

// -----------------------------------------------------------------------------
// Compat con #5172 (`resolveDriveCredentials`) — un solo resolvedor, dos formas
// -----------------------------------------------------------------------------
//
// #5172 llego a `main` (commit fb03a6b8e) con su propio resolvedor de Drive
// mientras esta rama construia el generico. Los dos resuelven lo mismo con la
// misma precedencia (env > store > legacy) y la misma validacion por forma, asi
// que convivir seria duplicar el bug que ambos cierran: dos cadenas que pueden
// divergir en silencio. Se conserva UNA sola implementacion —`resolveCredential`
// + `DRIVE_SPEC`— y este wrapper mantiene la firma y el contrato de #5172, que
// tiene tests y consumidores propios.
//
// La diferencia de fondo NO es cosmetica: el resolvedor de #5172 leia el store
// via `readUnifiedStore()`, que delega en `loadIntoEnv()` y por lo tanto exige
// que las claves esten en `ENV_MAPPING` — lo que CA-6 de #5217 prohibe, porque
// `loadIntoEnv` escribe en el `process.env` global que hereda todo proceso hijo
// de todo agente. Este wrapper resuelve por namespace (`resolveScopedRefs`), sin
// pasar por `ENV_MAPPING` ni tocar `process.env`.
//
// `drive_folder_id` no entra en `missing`: es opcional para #5172 (sin el la
// subida funciona, degradada a la raiz del Drive — ver `warnIfDriveFolderMissing`).
const DRIVE_COMPAT_REQUIRED = Object.freeze([
    "oauth_client_id", "oauth_client_secret", "oauth_refresh_token",
]);

// El generico etiqueta con mas precision que #5172: el hit del store sale como
// `store:<namespace>.<scope>` y el del legacy como `legacy:<archivo>#<clave>`
// cuando el nombre plano del legacy no coincide con el del store (que es el caso
// de las 4 de Drive: `google_oauth_refresh_token` vs `oauth_refresh_token`).
// El contrato de #5172 espera las etiquetas planas. Se degradan SOLO en este
// wrapper: la forma precisa sigue disponible en `cred.credential.sources`.
function driveCompatSource(source) {
    if (typeof source !== "string") return source;
    if (source.startsWith("store:")) return "store:credentials.json";
    if (source.startsWith("legacy:")) return source.split("#")[0];
    return source;
}

function resolveDriveCredentials(opts = {}) {
    const cred = resolveCredential(DRIVE_SPEC, opts);
    const sa = resolveDriveServiceAccountPath(opts);
    const missing = cred.missing.filter(k => DRIVE_COMPAT_REQUIRED.includes(k));
    return {
        clientId: cred.values.clientId,
        clientSecret: cred.values.clientSecret,
        refreshToken: cred.values.refreshToken,
        folderId: cred.values.folderId,
        credentialsPath: sa,
        clientIdSource: driveCompatSource(cred.sources.clientId),
        clientSecretSource: driveCompatSource(cred.sources.clientSecret),
        refreshTokenSource: driveCompatSource(cred.sources.refreshToken),
        folderIdSource: driveCompatSource(cred.sources.folderId),
        credentialsPathSource: sa ? "resolveDriveServiceAccountPath" : null,
        oauthReady: missing.length === 0,
        missing,
        // Se preserva el resultado completo del generico para quien lo quiera.
        credential: cred,
    };
}

/**
 * Compat de #5172. Nunca vuelca un valor de credencial.
 *
 * A diferencia de `describeMissingCredentials` —que nombra el store REALMENTE
 * consultado (`effectiveCanonicalPath`), que es lo que pide CA-10 y lo que usa
 * el camino de produccion— este wrapper nombra siempre el store canonico por
 * default, igual que hacia #5172. No es un descuido: es su contrato. El unico
 * caso en que ambos difieren es cuando el caller INYECTA un store alternativo,
 * o sea un test; en produccion `opts` viene vacio y los dos coinciden.
 */
function describeMissingDriveCredentials(cred) {
    const base = (cred && cred.credential) ? cred.credential : (cred || {});
    return describeMissingCredentials({
        label: DRIVE_SPEC.label,
        missing: base.missing || [],
        sourcesConsulted: credentialSources(DRIVE_SPEC),
        remediation: DRIVE_SPEC.remediation({
            canonical: effectiveCanonicalPath(), legacyPath: CONFIG_PATH,
        }),
    });
}

let _r2Credentials = null;
function getR2Credentials(opts) {
    if (opts) return resolveCredential(R2_SPEC, opts);
    if (!_r2Credentials) _r2Credentials = resolveCredential(R2_SPEC);
    return _r2Credentials;
}
function r2Config() {
    return getR2Credentials().values;
}

/**
 * Path al JSON de Service Account. NO es un secreto: es un path de configuracion
 * al archivo que sí los contiene, y ademas es el *fallback* (OAuth gana en
 * `driveAvailable()`). Por eso no entra al vault como scope (fuera de alcance
 * declarado en #5217). Se resuelve por forma y con la fuente explicita, no con
 * una cadena `||` que colapse en silencio.
 */
function resolveDriveServiceAccountPath(opts = {}) {
    const env = opts.env || process.env;
    const fromEnv = env.GOOGLE_CREDENTIALS_PATH;
    if (!isPlaceholderOrEmpty(fromEnv)) return String(fromEnv).trim();
    const legacyConfig = (opts.legacyConfig !== undefined)
        ? (opts.legacyConfig || {})
        : (readJsonSafe(opts.legacyConfigPath || CONFIG_PATH) || {});
    const fromLegacy = legacyConfig.google_credentials_path;
    return isPlaceholderOrEmpty(fromLegacy) ? "" : String(fromLegacy).trim();
}

let _driveServiceAccountPath = null;
function getDriveServiceAccountPath(opts) {
    if (opts) return resolveDriveServiceAccountPath(opts);
    if (_driveServiceAccountPath === null) _driveServiceAccountPath = resolveDriveServiceAccountPath();
    return _driveServiceAccountPath;
}

// --- Argument parsing ---

function parseArgs() {
    const args = process.argv.slice(2);
    const result = {
        issue: "0",
        title: "",
        sprint: "",
        videos: "",
        verdict: "DESCONOCIDO",
        passed: "0",
        total: "0",
        // #2519: nuevos flags — mode, motivo, criterios, narrador, rejectionPdf
        mode: "",
        motivo: "",
        criteriosFallidos: "",
        narratorProvider: "",
        rejectionPdf: "",
        // #4173: modo assets — subir evidencia binaria (png/zip/html/mp3) a Drive
        assets: "",
        videoUrl: "",
    };
    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case "--issue":   result.issue   = args[++i] || "0"; break;
            case "--title":   result.title   = args[++i] || ""; break;
            case "--sprint":  result.sprint  = args[++i] || ""; break;
            case "--videos":  result.videos  = args[++i] || ""; break;
            case "--verdict": result.verdict = args[++i] || "DESCONOCIDO"; break;
            case "--passed":  result.passed  = args[++i] || "0"; break;
            case "--total":   result.total   = args[++i] || "0"; break;
            case "--mode":    result.mode    = args[++i] || ""; break;
            case "--motivo":  result.motivo  = args[++i] || ""; break;
            case "--criterios-fallidos": result.criteriosFallidos = args[++i] || ""; break;
            case "--narrator": result.narratorProvider = args[++i] || ""; break;
            case "--rejection-pdf": result.rejectionPdf = args[++i] || ""; break;
            case "--assets":  result.assets  = args[++i] || ""; break;
            case "--video-url": result.videoUrl = args[++i] || ""; break;
        }
    }
    return result;
}

// --- Telegram: sendVideo (multipart/form-data) ---

function sendTelegramVideo(videoBuffer, filename, caption) {
    return new Promise((resolve, reject) => {
        // #4907: cortar antes de pegarle a la API — sin credenciales validas la
        // respuesta seria un 404 opaco imposible de diagnosticar en el log.
        if (!TELEGRAM_CREDENTIALS.valid) {
            reject(new Error(describeMissingTelegramCredentials(TELEGRAM_CREDENTIALS)));
            return;
        }
        const boundary = "----QAVideoBoundary" + Date.now().toString(36);
        const CRLF = "\r\n";

        let textParts = "";
        textParts += "--" + boundary + CRLF;
        textParts += 'Content-Disposition: form-data; name="chat_id"' + CRLF + CRLF;
        textParts += CHAT_ID + CRLF;

        if (caption) {
            textParts += "--" + boundary + CRLF;
            textParts += 'Content-Disposition: form-data; name="caption"' + CRLF + CRLF;
            textParts += caption + CRLF;
        }

        textParts += "--" + boundary + CRLF;
        textParts += 'Content-Disposition: form-data; name="supports_streaming"' + CRLF + CRLF;
        textParts += "true" + CRLF;

        textParts += "--" + boundary + CRLF;
        textParts += 'Content-Disposition: form-data; name="parse_mode"' + CRLF + CRLF;
        textParts += "Markdown" + CRLF;

        const preFile = Buffer.from(
            textParts +
            "--" + boundary + CRLF +
            'Content-Disposition: form-data; name="video"; filename="' + filename + '"' + CRLF +
            "Content-Type: video/mp4" + CRLF + CRLF
        );
        const postFile = Buffer.from(CRLF + "--" + boundary + "--" + CRLF);
        const fullBody = Buffer.concat([preFile, videoBuffer, postFile]);

        const req = https.request({
            hostname: "api.telegram.org",
            path: "/bot" + BOT_TOKEN + "/sendVideo",
            method: "POST",
            headers: {
                "Content-Type": "multipart/form-data; boundary=" + boundary,
                "Content-Length": fullBody.length,
            },
            timeout: 120000,
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => {
                try {
                    const r = JSON.parse(d);
                    if (r.ok) resolve(r);
                    else reject(new Error(d));
                } catch (e) { reject(e); }
            });
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout (120s)")); });
        req.on("error", (e) => reject(e));
        req.write(fullBody);
        req.end();
    });
}

// --- Telegram: sendMessage ---

function sendTelegramMessage(text) {
    return new Promise((resolve, reject) => {
        // #4907: idem sendTelegramVideo — error explicito en lugar de 404 opaco.
        if (!TELEGRAM_CREDENTIALS.valid) {
            reject(new Error(describeMissingTelegramCredentials(TELEGRAM_CREDENTIALS)));
            return;
        }
        const payload = JSON.stringify({
            chat_id: CHAT_ID,
            text: text,
            parse_mode: "Markdown",
            disable_web_page_preview: false,
        });
        const req = https.request({
            hostname: "api.telegram.org",
            path: "/bot" + BOT_TOKEN + "/sendMessage",
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
            },
            timeout: 15000,
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => {
                try {
                    const r = JSON.parse(d);
                    if (r.ok) resolve(r);
                    else reject(new Error(d));
                } catch (e) { reject(e); }
            });
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
        req.on("error", (e) => reject(e));
        req.write(payload);
        req.end();
    });
}

// --- Google Drive: Service Account JWT + REST API (Node.js puro) ---

// OAuth config (alternativa a Service Account — funciona con cuentas personales).
// Ya no se lee el archivo del repo directo: sale del resolvedor generico, con
// precedencia env > store canonico (google_drive.*) > legacy (#5217 CA-1/CA-3).

// El OAuth de Drive necesita el triplete completo. `drive_folder_id` NO gobierna
// la disponibilidad (sin el la subida igual funciona), pero su ausencia degrada:
// la evidencia termina en la RAIZ del Drive en vez de la carpeta de QA. Por eso
// sigue contando como faltante en el diagnostico y se avisa explicitamente antes
// de subir (`warnIfDriveFolderMissing`) — degradar en silencio es exactamente el
// modo de falla que #5217 cierra.
function driveOAuthReady() {
    const v = driveOAuth();
    return !!(v.refreshToken && v.clientId && v.clientSecret);
}

// Aviso explicito (una sola vez por proceso) cuando la subida va a la raiz del
// Drive por falta de `drive_folder_id`. Nombra el store canonico via
// `credentialsLib.CANONICAL_PATH`, sin hardcodear el path (CA-10), y nunca
// propone escribirlo en el archivo del repo (CA-9).
let _warnedDriveFolder = false;
function warnIfDriveFolderMissing(rootFolderId, opts = {}) {
    if (!isPlaceholderOrEmpty(rootFolderId)) return false;
    if (_warnedDriveFolder && !opts.force) return false;
    _warnedDriveFolder = true;
    console.warn(
        "[qa-video-share] AVISO: drive_folder_id no resuelve en ninguna fuente. " +
        "La evidencia se sube a la RAIZ del Drive, no a la carpeta de QA. " +
        "Fuentes consultadas (en orden): env GOOGLE_DRIVE_FOLDER_ID > " +
        effectiveCanonicalPath(opts) + "#google_drive.drive_folder_id > " +
        (opts.legacyConfigPath || CONFIG_PATH) + " (legacy, solo lectura). " +
        "Se resuelve escribiendo google_drive.drive_folder_id en el store canonico " +
        "(por ejemplo con `node scripts/google-drive-oauth-setup.js`, que lo persiste ahi).",
    );
    return true;
}

function driveAvailable() {
    // OAuth tiene prioridad para Drive personal (Service Account no tiene storage quota)
    if (driveOAuthReady()) return true;
    // Fallback: Service Account (funciona con Shared Drives / Workspace)
    const saPath = getDriveServiceAccountPath();
    if (saPath) {
        const resolved = path.resolve(saPath);
        if (fs.existsSync(resolved) && !fs.statSync(resolved).isDirectory()) return true;
    }
    return false;
}

// Estado de Drive para mensajes al operador (CA-14): "configurado" /
// "configuracion incompleta" / "no configurado".
function driveStateLabel() {
    return driveAvailable() ? "configurado" : getDriveCredentials().stateLabel;
}

function loadDriveCredentials() {
    const saPath = getDriveServiceAccountPath();
    if (!saPath) return null;
    const resolved = path.resolve(saPath);
    if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) return null;
    return JSON.parse(fs.readFileSync(resolved, "utf8"));
}

// Generar JWT firmado para Service Account
function createServiceAccountJWT(credentials) {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
        iss: credentials.client_email,
        scope: "https://www.googleapis.com/auth/drive",
        aud: "https://oauth2.googleapis.com/token",
        exp: now + 3600,
        iat: now,
    })).toString("base64url");
    const unsigned = header + "." + payload;
    const sign = crypto.createSign("RSA-SHA256");
    sign.update(unsigned);
    const signature = sign.sign(credentials.private_key, "base64url");
    return unsigned + "." + signature;
}

// Obtener access token via OAuth refresh token (cuenta personal)
function getOAuthAccessToken() {
    return new Promise((resolve, reject) => {
        const oauth = driveOAuth();
        const payload = "client_id=" + encodeURIComponent(oauth.clientId) +
            "&client_secret=" + encodeURIComponent(oauth.clientSecret) +
            "&refresh_token=" + encodeURIComponent(oauth.refreshToken) +
            "&grant_type=refresh_token";
        const req = https.request({
            hostname: "oauth2.googleapis.com", path: "/token", method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(payload) },
            timeout: 15000,
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => {
                try {
                    const r = JSON.parse(d);
                    if (r.access_token) resolve(r.access_token);
                    else reject(new Error("OAuth token error: " + d));
                } catch (e) { reject(e); }
            });
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("OAuth token timeout")); });
        req.on("error", (e) => reject(e));
        req.write(payload);
        req.end();
    });
}

// Obtener access token via JWT grant (Service Account)
function getGoogleAccessToken(credentials) {
    // Prioridad: OAuth (Drive personal) > Service Account (Shared Drives / Workspace)
    if (driveOAuthReady()) {
        return getOAuthAccessToken();
    }
    if (credentials && credentials.private_key) {
        return new Promise((resolve, reject) => {
            const jwt = createServiceAccountJWT(credentials);
            const payload = "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") +
                "&assertion=" + encodeURIComponent(jwt);
            const req = https.request({
                hostname: "oauth2.googleapis.com",
                path: "/token",
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Content-Length": Buffer.byteLength(payload),
                },
                timeout: 15000,
            }, (res) => {
                let d = "";
                res.on("data", (c) => d += c);
                res.on("end", () => {
                    try {
                        const r = JSON.parse(d);
                        if (r.access_token) resolve(r.access_token);
                        else reject(new Error("SA token error: " + d));
                    } catch (e) { reject(e); }
                });
            });
            req.on("timeout", () => { req.destroy(); reject(new Error("SA token request timeout")); });
            req.on("error", reject);
            req.write(payload);
            req.end();
        });
    }
    if (driveOAuthReady()) {
        return getOAuthAccessToken();
    }
    return Promise.reject(new Error("No credentials available (neither Service Account nor OAuth)"));
}

const DRIVE_ROOT_FOLDER_ID = "root";

// Google Drive acepta el alias estable "root" para representar la raiz del
// usuario. Nunca serializar un parent vacio: produce requests invalidos.
function resolveDriveParentId(parentId) {
    if (typeof parentId !== "string" || !parentId.trim()) {
        return DRIVE_ROOT_FOLDER_ID;
    }
    return parentId.trim();
}

// Listar carpetas hijas con un nombre dado dentro de un padre
function driveListFolder(accessToken, name, parentId) {
    return new Promise((resolve, reject) => {
        const resolvedParentId = resolveDriveParentId(parentId);
        const q = encodeURIComponent(
            "mimeType='application/vnd.google-apps.folder'" +
            " and name='" + name.replace(/'/g, "\\'") + "'" +
            " and '" + resolvedParentId + "' in parents" +
            " and trashed=false"
        );
        const req = https.request({
            hostname: "www.googleapis.com",
            path: "/drive/v3/files?q=" + q + "&fields=files(id,name)&spaces=drive",
            method: "GET",
            headers: { Authorization: "Bearer " + accessToken },
            timeout: 15000,
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => {
                try {
                    const r = JSON.parse(d);
                    resolve((r.files || []));
                } catch (e) { reject(e); }
            });
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("list folder timeout")); });
        req.on("error", (e) => reject(e));
        req.end();
    });
}

// Crear carpeta en Drive
function driveCreateFolder(accessToken, name, parentId) {
    return new Promise((resolve, reject) => {
        const resolvedParentId = resolveDriveParentId(parentId);
        const metadata = JSON.stringify({
            name: name,
            mimeType: "application/vnd.google-apps.folder",
            parents: [resolvedParentId],
        });
        const req = https.request({
            hostname: "www.googleapis.com",
            path: "/drive/v3/files?fields=id,name",
            method: "POST",
            headers: {
                Authorization: "Bearer " + accessToken,
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(metadata),
            },
            timeout: 15000,
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => {
                try {
                    const r = JSON.parse(d);
                    if (r.id) resolve(r);
                    else reject(new Error("createFolder error: " + d));
                } catch (e) { reject(e); }
            });
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("create folder timeout")); });
        req.on("error", (e) => reject(e));
        req.write(metadata);
        req.end();
    });
}

// Obtener o crear carpeta (idempotente)
async function driveGetOrCreateFolder(accessToken, name, parentId) {
    const existing = await driveListFolder(accessToken, name, parentId);
    if (existing.length > 0) {
        return existing[0].id;
    }
    const created = await driveCreateFolder(accessToken, name, parentId);
    return created.id;
}

// Subir un asset a Drive (multipart upload). #4173: mimeType parametrizable
// (default video/mp4 para preservar el comportamiento de los videos).
function driveUploadFile(accessToken, assetBuffer, filename, folderId, mimeType = "video/mp4") {
    return new Promise((resolve, reject) => {
        const boundary = "----DriveBoundary" + Date.now().toString(36);
        const CRLF = "\r\n";
        const metadata = JSON.stringify({ name: filename, parents: [folderId] });

        const preamble = Buffer.from(
            "--" + boundary + CRLF +
            "Content-Type: application/json; charset=UTF-8" + CRLF + CRLF +
            metadata + CRLF +
            "--" + boundary + CRLF +
            "Content-Type: " + mimeType + CRLF + CRLF
        );
        const postamble = Buffer.from(CRLF + "--" + boundary + "--" + CRLF);
        const body = Buffer.concat([preamble, assetBuffer, postamble]);

        const req = https.request({
            hostname: "www.googleapis.com",
            path: "/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink,webContentLink",
            method: "POST",
            headers: {
                Authorization: "Bearer " + accessToken,
                "Content-Type": "multipart/related; boundary=" + boundary,
                "Content-Length": body.length,
            },
            timeout: 600000, // 10 min para videos grandes
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => {
                try {
                    const r = JSON.parse(d);
                    if (r.id) resolve(r);
                    else reject(new Error("Drive upload error: " + d));
                } catch (e) { reject(e); }
            });
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("Drive upload timeout")); });
        req.on("error", (e) => reject(e));
        req.write(body);
        req.end();
    });
}

// Hacer el archivo público (anyone with link, reader)
function driveSetPublic(accessToken, fileId) {
    return new Promise((resolve, reject) => {
        const permission = JSON.stringify({ type: "anyone", role: "reader" });
        const req = https.request({
            hostname: "www.googleapis.com",
            path: "/drive/v3/files/" + fileId + "/permissions",
            method: "POST",
            headers: {
                Authorization: "Bearer " + accessToken,
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(permission),
            },
            timeout: 15000,
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => {
                try {
                    const r = JSON.parse(d);
                    resolve(r);
                } catch (e) { reject(e); }
            });
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("setPublic timeout")); });
        req.on("error", (e) => reject(e));
        req.write(permission);
        req.end();
    });
}

// Obtener webViewLink de un archivo (para link compartible)
function driveGetFileLink(accessToken, fileId) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: "www.googleapis.com",
            path: "/drive/v3/files/" + fileId + "?fields=webViewLink",
            method: "GET",
            headers: { Authorization: "Bearer " + accessToken },
            timeout: 10000,
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => {
                try {
                    const r = JSON.parse(d);
                    resolve(r.webViewLink || "");
                } catch (e) { reject(e); }
            });
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("getFileLink timeout")); });
        req.on("error", (e) => reject(e));
        req.end();
    });
}

// Subir cualquier asset a Google Drive: auth + carpetas + upload + permisos.
// #4173: generalizado de "video" a "asset" (mismo camino para png/zip/html/mp3).
async function uploadToDrive(assetBuffer, filename, issueNumber, issueTitle, sprintId, mimeType = "video/mp4") {
    const credentials = loadDriveCredentials();
    const accessToken = await getGoogleAccessToken(credentials);

    // Carpeta raíz configurada (ej. ID de "Intrale QA" en Drive)
    const rootFolderId = driveOAuth().folderId;
    warnIfDriveFolderMissing(rootFolderId);

    // Estructura: rootFolderId / #issueNumber /
    // Una sola carpeta unívoca por issue (sin sprint, sin título, sin doble nivel).
    const issueFolder = "#" + issueNumber;

    console.log("[qa-video-share] Drive: creando/usando carpeta " + issueFolder);
    const issueFolderId = await driveGetOrCreateFolder(accessToken, issueFolder, rootFolderId);

    console.log("[qa-video-share] Drive: subiendo " + filename + " (" + formatSize(assetBuffer.length) + ")...");
    const uploaded = await driveUploadFile(accessToken, assetBuffer, filename, issueFolderId, mimeType);
    await driveSetPublic(accessToken, uploaded.id);

    // Preferir webViewLink (abre el video en el navegador)
    let driveLink = uploaded.webViewLink;
    if (!driveLink) {
        driveLink = await driveGetFileLink(accessToken, uploaded.id);
    }
    if (!driveLink) {
        driveLink = "https://drive.google.com/file/d/" + uploaded.id + "/view";
    }
    return driveLink;
}

// Actualizar video_url en qa-report.json
function updateQaReport(issueNumber, videoUrl) {
    const PROJECT_ROOT = path.resolve(__dirname, "../..");
    const reportPath = path.join(PROJECT_ROOT, "qa", "evidence", String(issueNumber), "qa-report.json");
    if (!fs.existsSync(reportPath)) return;
    try {
        const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
        report.video_url = videoUrl;
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
        console.log("[qa-video-share] qa-report.json actualizado con video_url");
    } catch (e) {
        console.error("[qa-video-share] No se pudo actualizar qa-report.json:", e.message);
    }
}

// SEC-1 (#4173): una URL es segura para commitear solo si NO lleva material de
// firma en el querystring. Las presigned de R2 emiten X-Amz-*/Signature= y NO
// deben llegar al repo público; las webViewLink de Drive son canónicas.
function isCanonicalUrl(url) {
    if (!url || typeof url !== "string") return false;
    return !/X-Amz-/i.test(url) && !/[?&]Signature=/i.test(url);
}

// #4173: registrar los links de assets (png/zip/html/mp3) + video en
// qa/evidence/<issue>/qa-results.json (archivo distinto de qa-report.json).
// Merge idempotente por nombre. Descarta cualquier URL con material de firma
// (SEC-1). Crea el archivo y la carpeta si no existen.
function updateQaResults(issueNumber, assets, videoUrl) {
    const PROJECT_ROOT = path.resolve(__dirname, "../..");
    const dir = path.join(PROJECT_ROOT, "qa", "evidence", String(issueNumber));
    const resultsPath = path.join(dir, "qa-results.json");
    try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        let results = { video_url: "", assets: [] };
        if (fs.existsSync(resultsPath)) {
            try {
                const parsed = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
                if (parsed && typeof parsed === "object") results = parsed;
            } catch (_) { /* JSON corrupto: se reescribe limpio */ }
        }
        if (!Array.isArray(results.assets)) results.assets = [];

        // video_url: solo canónica (SEC-1)
        if (videoUrl) {
            if (isCanonicalUrl(videoUrl)) results.video_url = videoUrl;
            else console.error("[qa-video-share] video_url descartado por material de firma (SEC-1)");
        }

        // Merge por name; descartar URLs con material de firma (SEC-1)
        const byName = new Map(results.assets.filter(a => a && a.name).map(a => [a.name, a]));
        for (const a of (assets || [])) {
            if (!a || !a.name || !a.url) continue;
            if (!isCanonicalUrl(a.url)) {
                console.error("[qa-video-share] URL de asset descartada por material de firma (SEC-1): " + a.name);
                continue;
            }
            byName.set(a.name, { name: a.name, type: a.type || "", url: a.url });
        }
        results.assets = Array.from(byName.values());

        fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2) + "\n", "utf8");
        console.log("[qa-video-share] qa-results.json actualizado (" + results.assets.length + " asset(s))");
        return resultsPath;
    } catch (e) {
        console.error("[qa-video-share] No se pudo actualizar qa-results.json:", e.message);
        return null;
    }
}

// #4173: subir assets de evidencia binaria a Drive y registrar links en
// qa-results.json. Best-effort: cada fallo registra fallback explícito con el
// path local (CA-5/SEC-5), nunca vuelca secrets ni rompe el flujo.
async function runAssetUpload(data) {
    const issue = data.issue;
    const assetPaths = String(data.assets).split(",").map(s => s.trim()).filter(Boolean);
    if (assetPaths.length === 0) {
        console.log("[qa-video-share] Modo assets: sin assets para subir");
        return;
    }
    if (!driveAvailable()) {
        // Fallback explícito — nunca fallar mudo (CA-5/SEC-5).
        // Mismo formato de diagnóstico que el resto: qué falta · fuentes en
        // orden · cómo resolverlo (CA-10 de #5217).
        console.error(describeMissingCredentials(getDriveCredentials()));
        for (const p of assetPaths) {
            console.error("[qa-video-share] Drive " + driveStateLabel() +
                ": no se pudo subir, evidencia local en " + path.resolve(p));
        }
        return;
    }

    const sprintId = data.sprint || readActiveSprint();
    const uploaded = [];
    for (const assetPath of assetPaths) {
        const full = path.resolve(assetPath);
        if (!fs.existsSync(full)) {
            console.error("[qa-video-share] Asset no encontrado: " + full);
            continue;
        }
        const name = path.basename(full);
        const type = path.extname(full).replace(/^\./, "").toLowerCase();
        const mimeType = ASSET_MIME[type] || "application/octet-stream";
        try {
            const buf = fs.readFileSync(full);
            const url = await withRetry(
                () => uploadToDrive(buf, name, issue, data.title, sprintId, mimeType),
                "Drive asset upload " + name
            );
            uploaded.push({ name, type, url });
            console.log("[qa-video-share] Asset subido a Drive: " + name);
        } catch (e) {
            // CA-5/SEC-5: fallback explícito con path local, sin volcar secrets
            console.error("[qa-video-share] No se pudo subir " + name + ", evidencia local en " + full);
        }
    }

    if (uploaded.length > 0 || data.videoUrl) {
        updateQaResults(issue, uploaded, data.videoUrl || "");
    }
}

// --- Cloudflare R2: upload con presigned URL (S3-compatible, Node.js puro) ---

function r2Available() {
    const v = r2Config();
    return !!(v.accountId && v.accessKeyId && v.secretAccessKey);
}

// CA-14: distingue *ausente de todo almacén* ("no provisionado" — requiere
// provisionar en Cloudflare) de *presente pero incompleto* ("configuracion
// incompleta" — se resuelve escribiendo el scope que falta en el store).
function r2StateLabel() {
    return r2Available() ? "configurado" : getR2Credentials().stateLabel;
}

function hmacSha256(key, data) {
    return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Hex(data) {
    return crypto.createHash("sha256").update(data).digest("hex");
}

// AWS Signature V4 para PUT en R2 (compatible S3)
function uploadToR2(videoBuffer, objectKey) {
    return new Promise((resolve, reject) => {
        const host = r2Config().accountId + ".r2.cloudflarestorage.com";
        const region = "auto";
        const service = "s3";
        const now = new Date();
        const dateStamp = now.toISOString().replace(/[-:]/g, "").slice(0, 8);
        const amzDate = dateStamp + "T" + now.toISOString().replace(/[-:]/g, "").slice(9, 15) + "Z";
        const contentHash = sha256Hex(videoBuffer);

        const canonicalUri = "/" + r2Config().bucket + "/" + objectKey;
        const canonicalQueryString = "";
        const canonicalHeaders =
            "content-type:video/mp4\n" +
            "host:" + host + "\n" +
            "x-amz-content-sha256:" + contentHash + "\n" +
            "x-amz-date:" + amzDate + "\n";
        const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";

        const canonicalRequest = [
            "PUT", canonicalUri, canonicalQueryString,
            canonicalHeaders, signedHeaders, contentHash,
        ].join("\n");

        const credentialScope = dateStamp + "/" + region + "/" + service + "/aws4_request";
        const stringToSign = [
            "AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest),
        ].join("\n");

        let signingKey = hmacSha256("AWS4" + r2Config().secretAccessKey, dateStamp);
        signingKey = hmacSha256(signingKey, region);
        signingKey = hmacSha256(signingKey, service);
        signingKey = hmacSha256(signingKey, "aws4_request");
        const signature = crypto.createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

        const authHeader = "AWS4-HMAC-SHA256 Credential=" + r2Config().accessKeyId + "/" + credentialScope +
            ", SignedHeaders=" + signedHeaders + ", Signature=" + signature;

        const req = https.request({
            hostname: host,
            path: canonicalUri,
            method: "PUT",
            headers: {
                "Content-Type": "video/mp4",
                "Content-Length": videoBuffer.length,
                "Host": host,
                "x-amz-content-sha256": contentHash,
                "x-amz-date": amzDate,
                "Authorization": authHeader,
            },
            timeout: 300000, // 5 min para uploads grandes
        }, (res) => {
            let d = "";
            res.on("data", (c) => d += c);
            res.on("end", () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve({ key: objectKey, status: res.statusCode });
                } else {
                    reject(new Error("R2 upload failed: " + res.statusCode + " " + d));
                }
            });
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("R2 upload timeout")); });
        req.on("error", (e) => reject(e));
        req.write(videoBuffer);
        req.end();
    });
}

// Generar presigned GET URL para R2
function generateR2PresignedUrl(objectKey) {
    const host = r2Config().accountId + ".r2.cloudflarestorage.com";
    const region = "auto";
    const service = "s3";
    const now = new Date();
    const dateStamp = now.toISOString().replace(/[-:]/g, "").slice(0, 8);
    const amzDate = dateStamp + "T" + now.toISOString().replace(/[-:]/g, "").slice(9, 15) + "Z";
    const credentialScope = dateStamp + "/" + region + "/" + service + "/aws4_request";
    const credential = r2Config().accessKeyId + "/" + credentialScope;

    const canonicalUri = "/" + r2Config().bucket + "/" + objectKey;
    const queryParams = [
        "X-Amz-Algorithm=AWS4-HMAC-SHA256",
        "X-Amz-Credential=" + encodeURIComponent(credential),
        "X-Amz-Date=" + amzDate,
        "X-Amz-Expires=" + R2_PRESIGNED_EXPIRY_SECONDS,
        "X-Amz-SignedHeaders=host",
    ].sort().join("&");

    const canonicalRequest = [
        "GET", canonicalUri, queryParams,
        "host:" + host + "\n", "host", "UNSIGNED-PAYLOAD",
    ].join("\n");

    const stringToSign = [
        "AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest),
    ].join("\n");

    let signingKey = hmacSha256("AWS4" + r2Config().secretAccessKey, dateStamp);
    signingKey = hmacSha256(signingKey, region);
    signingKey = hmacSha256(signingKey, service);
    signingKey = hmacSha256(signingKey, "aws4_request");
    const signature = crypto.createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

    return "https://" + host + canonicalUri + "?" + queryParams + "&X-Amz-Signature=" + signature;
}

// --- Retry wrapper ---

async function withRetry(fn, label) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            return await fn();
        } catch (e) {
            console.error("[qa-video-share] " + label + " intento " + attempt + "/" + MAX_RETRIES + ": " + e.message);
            if (attempt < MAX_RETRIES) {
                await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
            } else {
                throw e;
            }
        }
    }
}

// --- Formateo de tamanio ---

function formatSize(bytes) {
    if (bytes < 1024) return bytes + "B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + "KB";
    return (bytes / (1024 * 1024)).toFixed(1) + "MB";
}

// Nombre descriptivo para el video subido a Drive.
// Formato: qa-<issue>-<YYYYMMDD>-<HHMM>-<verdict>[-narrated].mp4
// Ejemplo: qa-2062-20260416-2311-rechazado-narrated.mp4
function buildDriveFilename(issueNumber, verdict, hasNarration) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const date = now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate());
    const time = pad(now.getHours()) + pad(now.getMinutes());
    const normalized = String(verdict || "DESCONOCIDO")
        .toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
    const verdictTag = normalized || "desconocido";
    const suffix = hasNarration ? "-narrated" : "";
    return "qa-" + issueNumber + "-" + date + "-" + time + "-" + verdictTag + suffix + ".mp4";
}

// --- Leer sprint activo desde roadmap.json (fallback si no se pasa --sprint) ---

function readActiveSprint() {
    try {
        const roadmapPath = path.resolve(__dirname, "../../scripts/roadmap.json");
        const roadmap = JSON.parse(fs.readFileSync(roadmapPath, "utf8"));
        const active = (roadmap.sprints || []).find(s => s.status === "active");
        return active ? active.id : "";
    } catch (e) {
        return "";
    }
}

// --- Main ---

async function main() {
    const data = parseArgs();

    // #4173: modo assets — sube evidencia binaria (png/zip/html/mp3) a Drive y
    // registra links en qa-results.json. No requiere Telegram; corta acá.
    if (data.assets) {
        await runAssetUpload(data);
        return;
    }

    // #4907: validar FORMA, no solo presencia. Los placeholders del archivo
    // legacy son strings no vacios: el guard viejo los dejaba pasar y el error
    // recien emergia 140 lineas despues como un 404 opaco de Telegram.
    if (!TELEGRAM_CREDENTIALS.valid) {
        console.error(describeMissingTelegramCredentials(TELEGRAM_CREDENTIALS));
        process.exit(1);
    }
    console.log(
        "[qa-video-share] credenciales Telegram OK (bot_token <- " + TELEGRAM_CREDENTIALS.botTokenSource +
        ", chat_id <- " + TELEGRAM_CREDENTIALS.chatIdSource + ")"
    );

    const videoPaths = data.videos.split(",").filter(v => v.trim());
    if (videoPaths.length === 0) {
        console.log("[qa-video-share] No hay videos para compartir");
        process.exit(0);
    }

    // Resolución del sprint: parámetro > roadmap.json
    const sprintId = data.sprint || readActiveSprint();

    // #2519: el verdict puede venir en upper legacy ("APROBADO") o lower nuevo
    // ("aprobado"). Normalizamos a lower antes de pasarlo al template.
    const verdictNorm = String(data.verdict || "").toLowerCase();
    const verdictResolved = resolveVerdict(verdictNorm);
    const verdictIcon = verdictResolved ? verdictResolved.icon : "\uD83D\uDCF9";
    const timestamp = formatTimestamp(new Date());

    // Modo QA con fallback heuristico (CA-A6): si no llega explicito, derivar
    // por presencia de videos (android) o qa-api-report.json (api). Resto
    // => structural. El template muestra "indeterminado" solo si nada resuelve.
    function resolveModeWithHeuristic() {
        const explicit = resolveMode(data.mode);
        if (explicit) return explicit.key;
        if (videoPaths.length > 0) return "android";
        const apiReportPath = path.resolve(
            "qa", "evidence", String(data.issue || ""), "qa-api-report.json"
        );
        try { if (fs.existsSync(apiReportPath)) return "api"; } catch (_) {}
        return "structural";
    }
    const effectiveMode = resolveModeWithHeuristic();

    // Criterios fallidos: CSV ("CA-1,CA-4,...") o JSON array stringified.
    function parseCriterios(raw) {
        if (!raw) return [];
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) return parsed.map(String);
        } catch (_) { /* no JSON, tratarlo como CSV */ }
        return String(raw).split(",").map((s) => s.trim()).filter(Boolean);
    }
    const criteriosFallidos = parseCriterios(data.criteriosFallidos);

    // Rejection PDF: solo se linkea si es relativo valido y existe en el
    // working tree (CA-A7 + CA-S4). Paths con `..` o absolutos se descartan.
    let rejectionPdfPath = "";
    if (data.rejectionPdf) {
        const relPdf = String(data.rejectionPdf).trim();
        if (relPdf && !relPdf.includes("..") && !path.isAbsolute(relPdf)) {
            const abs = path.resolve(process.cwd(), relPdf);
            try { if (fs.existsSync(abs)) rejectionPdfPath = relPdf; } catch (_) {}
        }
    }

    // CA-B1: sin verdict reconocido => path legacy en el template.
    const isLegacyPayload = !verdictResolved;

    console.log("[qa-video-share] Distribuyendo " + videoPaths.length + " video(s) para issue #" + data.issue);
    if (driveAvailable()) {
        console.log("[qa-video-share] Modo: Google Drive → Telegram link");
    } else {
        // Drive no resuelve — bloquear en vez de fallback silencioso.
        // La evidencia de QA debe quedar persistida en Drive, no solo en Telegram.
        //
        // CA-9/CA-10/CA-11 de #5217: el diagnostico se arma UNA vez y viaja
        // igual a stderr y a Telegram, para que no queden dos textos
        // desincronizados. Nombra el store canonico y las fuentes en orden, y
        // NO instruye a escribir credenciales en el archivo del repo (ese
        // procedimiento es el que esta historia elimina).
        const driveDiagnostic = describeMissingCredentials(getDriveCredentials());
        console.error("[qa-video-share] ERROR: Google Drive " + driveStateLabel() + ".");
        console.error("[qa-video-share] Sin Drive, la evidencia de video se pierde.");
        console.error(driveDiagnostic);
        // Enviar alerta a Telegram y fallar. El diagnostico va en bloque de
        // codigo: `parse_mode: Markdown` interpretaria los `_` de los dot-paths
        // y la API devolveria 400, dejando al operador sin alerta.
        try {
            await sendTelegramMessage(
                "⚠️ *QA Evidence BLOQUEADO* — Issue #" + data.issue + "\n" +
                "Google Drive " + driveStateLabel() + ". " + videoPaths.length + " video(s) sin persistir.\n" +
                "```\n" + driveDiagnostic + "\n```"
            );
        } catch (e) {}
        process.exit(2); // Exit code 2 = Drive no disponible
    }

    let sent = 0;
    let failed = 0;
    let firstDriveUrl = "";

    for (const videoPath of videoPaths) {
        const fullPath = path.resolve(videoPath.trim());
        if (!fs.existsSync(fullPath)) {
            console.error("[qa-video-share] Video no encontrado: " + fullPath);
            failed++;
            continue;
        }

        const stats = fs.statSync(fullPath);
        const filename = path.basename(fullPath);
        const sizeStr = formatSize(stats.size);
        const hasNarration = filename.includes("-narrated");
        const audioTag = hasNarration ? " \uD83D\uDD0A con narracion" : "";

        // ── Nivel 1: Google Drive ──────────────────────────────────────────
        if (driveAvailable()) {
            // Renombrar para que sea identificable: qa-<issue>-<fecha>-<hora>-<verdict>[-narrated].mp4
            const driveFilename = buildDriveFilename(data.issue, data.verdict, hasNarration);
            console.log("[qa-video-share] " + filename + " (" + sizeStr + ") -> Google Drive como " + driveFilename);
            try {
                const videoBuffer = fs.readFileSync(fullPath);
                const driveLink = await withRetry(
                    () => uploadToDrive(videoBuffer, driveFilename, data.issue, data.title, sprintId),
                    "Drive upload " + driveFilename
                );

                // Guardar primer link de Drive para qa-report.json
                if (!firstDriveUrl) {
                    firstDriveUrl = driveLink;
                    updateQaReport(data.issue, driveLink);
                }

                // #2519: template unificado via qa-telegram-template.
                const repoReportPath = "qa/evidence/" + data.issue + "/qa-report.json";
                const message = buildTelegramMessage({
                    issue: data.issue,
                    title: data.title,
                    verdict: verdictNorm,
                    passed: data.passed,
                    total: data.total,
                    mode: effectiveMode,
                    motivo: data.motivo,
                    criteriosFallidos: criteriosFallidos,
                    narratorProvider: data.narratorProvider,
                    rejectionPdf: rejectionPdfPath,
                    driveLink: driveLink,
                    reportPath: repoReportPath,
                    audioTag: audioTag,
                    timestamp: timestamp,
                    legacy: isLegacyPayload,
                });

                await withRetry(() => sendTelegramMessage(message), "sendMessage Drive link " + driveFilename);
                console.log("[qa-video-share] " + driveFilename + " subido a Drive, link enviado OK");
                sent++;
            } catch (e) {
                console.error("[qa-video-share] Drive fallo para " + driveFilename + ": " + e.message);
                console.error("[qa-video-share] ERROR: No se pudo subir evidencia a Drive. Pipeline fallido.");
                // Notificar el fallo a Telegram
                try {
                    await sendTelegramMessage(
                        "❌ *Drive Upload FALLIDO* — Issue #" + data.issue + "\n" +
                        "Video: `" + driveFilename + "` (" + sizeStr + ")\n" +
                        "Error: " + e.message.substring(0, 200)
                    );
                } catch (e2) {
                    // #4907: no tragarse el error del aviso. Si el canal de
                    // notificacion es justamente el que fallo, el operador tiene
                    // que verlo en el log local.
                    console.error("[qa-video-share] tampoco se pudo notificar el fallo por Telegram: " + e2.message);
                }
                failed++;
            }
            continue;
        }

        // ── Fallback cuando Drive no está configurado ──────────────────────
        await sendFallback(filename, fullPath, stats, sizeStr, data, verdictIcon, timestamp);
        sent++;
    }

    // Resumen final
    console.log("[qa-video-share] Resultado: " + sent + " enviados, " + failed + " fallidos de " + videoPaths.length + " totales");

    if (failed > 0 && sent === 0) {
        process.exit(1);
    }
}

// Flujo de envío fallback (Telegram directo o R2)
async function sendFallback(filename, fullPath, stats, sizeStr, data, verdictIcon, timestamp) {
    const hasNarration = filename.includes("-narrated");
    const audioTag = hasNarration ? " \uD83D\uDD0A Con narracion" : " \uD83D\uDD07 Sin audio";
    const caption =
        verdictIcon + " *QA Evidence* \u2014 Issue #" + data.issue + "\n" +
        "\uD83C\uDFAC `" + filename + "` (" + sizeStr + ")" + audioTag + "\n" +
        "\uD83D\uDCCA Tests: " + data.passed + "/" + data.total + " pasaron\n" +
        "\uD83D\uDD52 " + timestamp;

    if (stats.size <= TELEGRAM_MAX_VIDEO_SIZE) {
        // Envio directo por Telegram
        console.log("[qa-video-share] " + filename + " (" + sizeStr + ") -> Telegram sendVideo");
        try {
            const videoBuffer = fs.readFileSync(fullPath);
            await withRetry(() => sendTelegramVideo(videoBuffer, filename, caption), "sendVideo " + filename);
            console.log("[qa-video-share] " + filename + " enviado OK");
        } catch (e) {
            console.error("[qa-video-share] Fallo sendVideo " + filename + ": " + e.message);
            try {
                await sendTelegramMessage(caption + "\n\n\u26A0 _Video no se pudo enviar directamente (" + sizeStr + ")_");
            } catch (e2) {
                throw e2;
            }
        }
    } else if (r2Available()) {
        // R2 para videos > 50MB
        console.log("[qa-video-share] " + filename + " (" + sizeStr + ") -> R2 upload + link Telegram");
        const objectKey = "qa/issue-" + data.issue + "/" + filename;
        const videoBuffer = fs.readFileSync(fullPath);
        await withRetry(() => uploadToR2(videoBuffer, objectKey), "R2 upload " + filename);
        const presignedUrl = generateR2PresignedUrl(objectKey);
        const linkCaption =
            caption + "\n\n" +
            "\uD83D\uDD17 [Descargar video](" + presignedUrl + ")\n" +
            "_Link valido por 7 dias_";
        await withRetry(() => sendTelegramMessage(linkCaption), "sendMessage link " + filename);
        console.log("[qa-video-share] " + filename + " subido a R2, link enviado OK");
    } else {
        // Video > 50MB, sin Drive ni R2: texto solamente.
        //
        // CA-14 de #5217: este es el mensaje donde el operador se entera de que
        // un video NO se persistio, asi que Drive y R2 se reportan por separado
        // con su estado real. No es lo mismo "no configurado" (Drive: se
        // resuelve escribiendo en el store canonico) que "no provisionado" (R2:
        // hay que crear las credenciales en Cloudflare). Meterlos en la misma
        // bolsa manda al operador a buscar al lugar equivocado.
        const driveState = driveStateLabel();
        const r2State = r2StateLabel();
        console.log("[qa-video-share] " + filename + " (" + sizeStr + ") excede 50MB, " +
            "Drive " + driveState + " y R2 " + r2State + " -> texto");
        await sendTelegramMessage(
            caption + "\n\n" +
            "\u26A0 _Video " + sizeStr + " sin persistir: Drive " + driveState +
            ", R2 " + r2State + "._\n" +
            "_Ruta local: `" + fullPath + "`_"
        );
    }
}

// #4173: guard require.main — permite `require()` desde otro script Node sin
// disparar el flujo Telegram (evita doble envío). main() solo corre como CLI.
if (require.main === module) {
    main().catch(e => {
        console.error("[qa-video-share] Error fatal:", e.message);
        process.exit(1);
    });
}

// #4173: API reusable para subir assets y registrar qa-results.json
// #4907: resolucion de credenciales exportada e inyectable para tests.
// #5217: resolvedor generico + specs. Los exports de #4907 se CONSERVAN con su
//        firma original (hay tests y consumidores que los importan por nombre).
module.exports = {
    uploadToDrive,
    updateQaResults,
    isCanonicalUrl,
    resolveTelegramCredentials,
    describeMissingTelegramCredentials,
    resolveDriveCredentials,
    describeMissingDriveCredentials,
    isValidBotToken,
    isValidChatId,
    // Resolvedor generico (#5217 · entrega el helper compartido de #4917)
    resolveCredential,
    describeMissingCredentials,
    credentialStatePhrase,
    STATE_PHRASES,
    resolveStoreScopes,
    resolveDriveServiceAccountPath,
    warnIfDriveFolderMissing,
    driveGetOrCreateFolder,
    resolveDriveParentId,
    DRIVE_ROOT_FOLDER_ID,
    TELEGRAM_SPEC,
    DRIVE_SPEC,
    R2_SPEC,
    STORE_REF,
};

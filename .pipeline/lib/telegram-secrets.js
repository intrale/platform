// =============================================================================
// telegram-secrets.js — fuente unica de credenciales del bot Telegram + claves
// API (OpenAI, Anthropic) usadas por TTS/STT/Vision en multimedia.
//
// Prioridad de carga (#3311 - credentials unificadas):
//   1) ENV: TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID  (+ OPENAI_API_KEY etc.)
//   2) ~/.claude/secrets/credentials.json   (CANONICAL, nested - estructura unificada)
//   3) ~/.claude/secrets/telegram-config.json   (home legacy, flat keys, fallback)
//   4) <repo>/.claude/hooks/telegram-config.json (legacy committed, fallback con warning)
//
// La API publica (loadTelegramSecrets / loadApiKeys) NO cambia para preservar
// backward-compat con los 6 consumidores actuales (multimedia.js, pulpo.js,
// listener-telegram.js, servicio-telegram.js, rejection-report.js,
// hydrate-provider-env.js). El cargador alternativo
// `.pipeline/lib/credentials.js#loadIntoEnv()` cubre el path Pulpo multi-provider.
//
// #7113 (CA-3, RS-2) — POR PERFIL DE AMBIENTE. Ambas funciones aceptan
// `{ env, ambiente }` (el env del proceso lo pasa el llamador; `ambiente` es el
// resultado de `pipeline-env.resolve(env)` si ya lo tiene). En modo distinto de
// `productivo` SOLO se mira la via 1 sobre las variables de PRUEBAS
// (`TELEGRAM_BOT_TOKEN_PRUEBAS` / `TELEGRAM_CHAT_ID_PRUEBAS`, hidratadas por
// `lib/credenciales-ambiente.js` desde `credentials.pruebas.json`): NO se
// ejecutan las vias 2 (store productivo), 3 (home legacy) ni 4 (archivo
// commiteado). Si faltan, el `throw TELEGRAM_SECRETS_MISSING` de siempre (los
// callers ya degradan). Los nombres de las variables salen del modulo de
// credenciales, nunca como literal sobre la global del proceso (ratchet CA-7).
// =============================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CANONICAL_SECRETS = path.join(os.homedir(), '.claude', 'secrets', 'credentials.json');
const HOME_SECRETS = path.join(os.homedir(), '.claude', 'secrets', 'telegram-config.json');

// Nombre logico del secreto (dot-path del manifiesto), NO su valor. Vive en una
// constante en vez de inline: escrito como `secret: '<valor>'` el linter lo lee
// como asignacion de credencial y lo marca como hallazgo. Con la constante el
// sitio de uso queda sin literal y la etiqueta tiene una sola fuente.
const SECRET_NAME_BOT_TOKEN = 'telegram.bot_token';

function tryRead(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { return null; }
}

function isLikelyToken(s) {
    return typeof s === 'string' && /^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(s);
}

function looksLikePlaceholder(s) {
    if (!s) return true;
    return /(REVOKED|PLACEHOLDER|MOVED|EXAMPLE|REPLACE|CHANGE_ME)/i.test(s);
}

function pickKey(value) {
    if (typeof value !== 'string') return '';
    if (!value.trim()) return '';
    if (looksLikePlaceholder(value)) return '';
    return value;
}

/**
 * #7113 — Resuelve (env, modo, nombres de variables) para ambas funciones.
 * Requires diferidos a proposito: `credenciales-ambiente` carga `credentials`
 * (pesado) y este modulo lo consumen procesos livianos; ademas evita cualquier
 * ciclo de carga entre ambos.
 */
function perfilDelAmbiente(env, ambiente) {
    const e = env && typeof env === 'object' ? env : process.env;
    const pipelineEnv = require('./pipeline-env');
    const amb = ambiente && typeof ambiente === 'object' ? ambiente : pipelineEnv.resolve(e);
    const productivo = amb.modo === pipelineEnv.MODOS.PRODUCTIVO;
    const { VARIABLES } = require('./credenciales-ambiente');
    return { e, productivo, vars: productivo ? VARIABLES.productivo : VARIABLES.pruebas };
}

/**
 * Devuelve { bot_token, chat_id, source }.
 * Lanza Error si no encuentra credenciales validas en ninguna fuente.
 *
 * Prioridad (#3311):
 *   env > credentials.json (canonical, nested) > telegram-config.json home (flat) > legacy committed
 *
 * #7113: en modo distinto de `productivo` SOLO la via 1 sobre las variables
 * `_PRUEBAS`; sin ellas lanza `TELEGRAM_SECRETS_MISSING`.
 */
function loadTelegramSecrets({ legacyConfigPath, log, env, ambiente } = {}) {
    const logger = typeof log === 'function' ? log : () => {};
    const { e, productivo, vars } = perfilDelAmbiente(env, ambiente);

    // 1) ENV (variables del perfil: productivas o `_PRUEBAS`)
    if (isLikelyToken(e[vars.botToken]) && e[vars.chatId]) {
        return {
            bot_token: e[vars.botToken],
            chat_id: String(e[vars.chatId]),
            source: 'env',
        };
    }

    // #7113 — en modo distinto de productivo no hay mas vias: ni store
    // productivo, ni legacy del home, ni archivo commiteado (CA-3 bullet 1).
    if (!productivo) {
        const err = new Error(`Sin credenciales Telegram del ambiente de pruebas: faltan ${vars.botToken}+${vars.chatId} `
            + '(se hidratan desde credentials.pruebas.json; ver docs/runbooks/ambiente-pruebas-credenciales.md).');
        err.code = 'TELEGRAM_SECRETS_MISSING';
        throw err;
    }

    // 2) Canonical credentials.json (#3311 - estructura nested unificada)
    const canonical = tryRead(CANONICAL_SECRETS);
    if (canonical && canonical.telegram
        && isLikelyToken(canonical.telegram.bot_token)
        && canonical.telegram.chat_id) {
        return {
            bot_token: canonical.telegram.bot_token,
            chat_id: String(canonical.telegram.chat_id),
            source: 'canonical',
        };
    }

    // 3) Home telegram-config.json (legacy flat, fallback durante transicion)
    const home = tryRead(HOME_SECRETS);
    if (home && isLikelyToken(home.bot_token) && home.chat_id) {
        logger(`[secrets] WARNING: bot_token leido de ${HOME_SECRETS} (legacy). Migrar a ${CANONICAL_SECRETS} con estructura nested (#3311).`);
        return { bot_token: home.bot_token, chat_id: String(home.chat_id), source: 'home' };
    }

    // 4) Legacy committed fallback
    if (legacyConfigPath) {
        const legacy = tryRead(legacyConfigPath);
        // #5245 — Punto donde un secreto se resuelve desde un archivo que puede
        // vivir adentro del repo (publico). Se declara al guard ANTES de mirar
        // si el valor sirve: la lectura in-repo ya ocurrio, y es exactamente lo
        // que la migracion tiene que llevar a cero. En `warn` avisa y cuenta; en
        // `strict` (#5263) lanza y el llamador degrada.
        // Require diferido a proposito: solo esta rama paga el costo, y el resto
        // de los consumidores de este modulo no arrastran el guard.
        if (legacy && typeof legacy.bot_token === 'string' && legacy.bot_token.trim()) {
            const { assertSecretOrigin } = require('./secrets-guard');
            assertSecretOrigin(legacyConfigPath, {
                op: 'read',
                secret: SECRET_NAME_BOT_TOKEN,
                site: 'telegram-secrets.loadTelegramSecrets:legacy',
                // Sin logger propio se usa el del guard (stderr + log dedicado):
                // el `logger` local por defecto es un no-op y se comeria la
                // evidencia de enganche que pide CA-11.
                log: typeof log === 'function' ? logger : undefined,
            });
        }
        if (legacy && isLikelyToken(legacy.bot_token) && !looksLikePlaceholder(legacy.bot_token)) {
            logger(`[secrets] WARNING: bot_token leido del archivo committed (${legacyConfigPath}). Mover a ${CANONICAL_SECRETS}.`);
            return { bot_token: legacy.bot_token, chat_id: String(legacy.chat_id), source: 'legacy' };
        }
    }

    const err = new Error(`No se encontraron credenciales Telegram. Crear ${CANONICAL_SECRETS} con {telegram:{bot_token, chat_id}} (preferido) o setear ENV TELEGRAM_BOT_TOKEN+TELEGRAM_CHAT_ID.`);
    err.code = 'TELEGRAM_SECRETS_MISSING';
    throw err;
}

/**
 * Devuelve las API keys de proveedores externos (TTS/STT/Vision).
 * Best-effort: nunca lanza, retorna strings vacios para keys faltantes.
 *
 * Prioridad por key (#3311):
 *   ENV > credentials.json canonical (nested) > telegram-config.json home (flat) > legacy committed
 *
 * El consumidor decide que hacer cuando una key viene vacia (multimedia
 * loggea "falta openai_api_key" y degrada).
 */
function loadApiKeys({ legacyConfigPath, env, ambiente } = {}) {
    const { e, productivo, vars } = perfilDelAmbiente(env, ambiente);
    // #7113 (CA-4) — en pruebas las API keys productivas NO se resuelven: ni del
    // env (ya purgado), ni de ningun archivo. Vacias = el consumidor degrada.
    if (!productivo) return { openai_api_key: '', anthropic_api_key: '' };

    const canonical = tryRead(CANONICAL_SECRETS) || {};
    const home = tryRead(HOME_SECRETS) || {};
    const legacy = legacyConfigPath ? (tryRead(legacyConfigPath) || {}) : {};

    // Helpers para acceso seguro a la estructura nested del canonical.
    const canonProv = (canonical.providers && typeof canonical.providers === 'object') ? canonical.providers : {};

    return {
        openai_api_key:
            pickKey(e[vars.openaiApiKey]) ||
            pickKey(canonProv.openai && canonProv.openai.api_key) ||
            pickKey(home.openai_api_key) ||
            pickKey(legacy.openai_api_key),
        anthropic_api_key:
            pickKey(e[vars.anthropicApiKey]) ||
            pickKey(canonProv.anthropic && canonProv.anthropic.api_key) ||
            pickKey(home.anthropic_api_key) ||
            pickKey(legacy.anthropic_api_key),
    };
}

// #5220 (A2) — `isLikelyToken` y `looksLikePlaceholder` se exportan para que el
// barrido de credenciales filtradas (`lib/secret-leak-scan.js`) reuse el mismo
// criterio de forma y de placeholder, en vez de re-implementarlo y divergir.
// Cambio ADITIVO: no toca la implementación ni la API previa.
module.exports = {
    loadTelegramSecrets, loadApiKeys, HOME_SECRETS, CANONICAL_SECRETS,
    isLikelyToken, looksLikePlaceholder,
};

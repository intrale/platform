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
// =============================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CANONICAL_SECRETS = path.join(os.homedir(), '.claude', 'secrets', 'credentials.json');
const HOME_SECRETS = path.join(os.homedir(), '.claude', 'secrets', 'telegram-config.json');

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
 * Devuelve { bot_token, chat_id, source }.
 * Lanza Error si no encuentra credenciales validas en ninguna fuente.
 *
 * Prioridad (#3311):
 *   env > credentials.json (canonical, nested) > telegram-config.json home (flat) > legacy committed
 */
function loadTelegramSecrets({ legacyConfigPath, log } = {}) {
    const logger = typeof log === 'function' ? log : () => {};

    // 1) ENV
    if (isLikelyToken(process.env.TELEGRAM_BOT_TOKEN) && process.env.TELEGRAM_CHAT_ID) {
        return {
            bot_token: process.env.TELEGRAM_BOT_TOKEN,
            chat_id: String(process.env.TELEGRAM_CHAT_ID),
            source: 'env',
        };
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
function loadApiKeys({ legacyConfigPath } = {}) {
    const canonical = tryRead(CANONICAL_SECRETS) || {};
    const home = tryRead(HOME_SECRETS) || {};
    const legacy = legacyConfigPath ? (tryRead(legacyConfigPath) || {}) : {};

    // Helpers para acceso seguro a la estructura nested del canonical.
    const canonProv = (canonical.providers && typeof canonical.providers === 'object') ? canonical.providers : {};

    return {
        openai_api_key:
            pickKey(process.env.OPENAI_API_KEY) ||
            pickKey(canonProv.openai && canonProv.openai.api_key) ||
            pickKey(home.openai_api_key) ||
            pickKey(legacy.openai_api_key),
        anthropic_api_key:
            pickKey(process.env.ANTHROPIC_API_KEY) ||
            pickKey(canonProv.anthropic && canonProv.anthropic.api_key) ||
            pickKey(home.anthropic_api_key) ||
            pickKey(legacy.anthropic_api_key),
    };
}

module.exports = { loadTelegramSecrets, loadApiKeys, HOME_SECRETS, CANONICAL_SECRETS };

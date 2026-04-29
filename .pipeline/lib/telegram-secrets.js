// =============================================================================
// telegram-secrets.js — fuente unica de credenciales del bot Telegram + claves
// API (OpenAI, Anthropic, ElevenLabs) usadas por TTS/STT/Vision en multimedia.
//
// Prioridad de carga:
//   1) ENV: TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID  (+ OPENAI_API_KEY etc.)
//   2) ~/.claude/secrets/telegram-config.json   (FUERA del repo, recomendado)
//   3) <repo>/.claude/hooks/telegram-config.json (legacy, fallback con warning)
//
// El path (2) es inmune a checkouts/pulls del repo y nunca se sube a github
// porque vive en el home del usuario. Es la ubicacion oficial post-intrusion.
//
// loadTelegramSecrets()  -> {bot_token, chat_id, source}        (criticos, throw si faltan)
// loadApiKeys()          -> {openai_api_key, anthropic_api_key,
//                           elevenlabs_api_key, elevenlabs_voice_id}  (best-effort, vacio si falta)
// =============================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

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

    // 2) Home secrets (oficial)
    const home = tryRead(HOME_SECRETS);
    if (home && isLikelyToken(home.bot_token) && home.chat_id) {
        return { bot_token: home.bot_token, chat_id: String(home.chat_id), source: 'home' };
    }

    // 3) Legacy fallback
    if (legacyConfigPath) {
        const legacy = tryRead(legacyConfigPath);
        if (legacy && isLikelyToken(legacy.bot_token) && !looksLikePlaceholder(legacy.bot_token)) {
            logger(`[secrets] WARNING: bot_token leido del archivo committed (${legacyConfigPath}). Mover a ${HOME_SECRETS}.`);
            return { bot_token: legacy.bot_token, chat_id: String(legacy.chat_id), source: 'legacy' };
        }
    }

    const err = new Error(`No se encontraron credenciales Telegram. Crear ${HOME_SECRETS} con {bot_token, chat_id} o setear ENV TELEGRAM_BOT_TOKEN+TELEGRAM_CHAT_ID.`);
    err.code = 'TELEGRAM_SECRETS_MISSING';
    throw err;
}

/**
 * Devuelve las API keys de proveedores externos (TTS/STT/Vision).
 * Best-effort: nunca lanza, retorna strings vacios para keys faltantes.
 * Prioridad por key: ENV → home secrets → legacy committed config.
 * El consumidor decide que hacer cuando una key viene vacia (multimedia
 * loggea "falta openai_api_key" y degrada).
 */
function loadApiKeys({ legacyConfigPath } = {}) {
    const home = tryRead(HOME_SECRETS) || {};
    const legacy = legacyConfigPath ? (tryRead(legacyConfigPath) || {}) : {};

    return {
        openai_api_key:
            pickKey(process.env.OPENAI_API_KEY) ||
            pickKey(home.openai_api_key) ||
            pickKey(legacy.openai_api_key),
        anthropic_api_key:
            pickKey(process.env.ANTHROPIC_API_KEY) ||
            pickKey(home.anthropic_api_key) ||
            pickKey(legacy.anthropic_api_key),
        elevenlabs_api_key:
            pickKey(process.env.ELEVENLABS_API_KEY) ||
            pickKey(home.elevenlabs_api_key) ||
            pickKey(legacy.elevenlabs_api_key),
        elevenlabs_voice_id:
            pickKey(process.env.ELEVENLABS_VOICE_ID) ||
            pickKey(home.elevenlabs_voice_id) ||
            pickKey(legacy.elevenlabs_voice_id),
    };
}

module.exports = { loadTelegramSecrets, loadApiKeys, HOME_SECRETS };

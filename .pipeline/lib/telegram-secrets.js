// =============================================================================
// telegram-secrets.js — fuente unica de bot_token y chat_id.
//
// Prioridad de carga:
//   1) ENV: TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
//   2) ~/.claude/secrets/telegram-config.json   (FUERA del repo, recomendado)
//   3) <repo>/.claude/hooks/telegram-config.json (legacy, fallback con warning)
//
// El path (2) es inmune a checkouts/pulls del repo y nunca se sube a github
// porque vive en el home del usuario. Es la ubicacion oficial post-intrusion.
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

module.exports = { loadTelegramSecrets, HOME_SECRETS };

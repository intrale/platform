// =============================================================================
// credentials.js — Cargador unificado de credenciales (#3311)
//
// Fuente única de verdad: ~/.claude/secrets/credentials.json
// Lee el archivo al boot del Pulpo/restart.js y popula process.env para que
// `validateCredentialsEnvPresence` (agent-models-validate.js) encuentre las
// credenciales sin que el operador tenga que setear setx manualmente por cada
// provider.
//
// Estructura esperada del JSON:
//   {
//     "telegram":   { "bot_token": "...", "chat_id": "..." },
//     "providers":  { "google": {"api_key": "..."}, "cerebras": {...}, ... },
//     "multimedia": { "elevenlabs_api_key": "...", "elevenlabs_voice_id": "..." }
//   }
//
// #3353 (mayo 2026): Groq fue descontinuado. Si el credentials.json todavía
// tiene `providers.groq`, la key se ignora silenciosamente (sin entrada en
// ENV_MAPPING) — el operador puede limpiarlo cuando quiera.
//
// Precedencia (alineada con loadApiKeys de telegram-secrets.js):
//   1. process.env ya seteado → respetar, no sobrescribir
//   2. credentials.json (canonical)
//   3. telegram-config.json (legacy, fallback con warning)
// =============================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CANONICAL_PATH = path.join(os.homedir(), '.claude', 'secrets', 'credentials.json');
const LEGACY_PATH = path.join(os.homedir(), '.claude', 'secrets', 'telegram-config.json');

// Mapeo canónico: dot-path en credentials.json → env var que esperan los CLIs.
// Mantener ordenado por categoría para facilitar el code-review.
const ENV_MAPPING = Object.freeze({
  // Telegram bot
  'telegram.bot_token':            'TELEGRAM_BOT_TOKEN',
  'telegram.chat_id':              'TELEGRAM_CHAT_ID',
  // Providers IA (allowlist en agent-models-validate.js:ALLOWED_CREDENTIAL_ENV_VARS)
  'providers.openai.api_key':      'OPENAI_API_KEY',
  'providers.anthropic.api_key':   'ANTHROPIC_API_KEY',
  'providers.google.api_key':      'GEMINI_API_KEY',
  // providers.groq.api_key se removió en #3353 — Groq descontinuado.
  'providers.cerebras.api_key':    'CEREBRAS_API_KEY',
  'providers.nvidia.api_key':      'NVIDIA_NIM_API_KEY',
  // Multimedia (TTS/STT/Vision)
  'multimedia.elevenlabs_api_key':  'ELEVENLABS_API_KEY',
  'multimedia.elevenlabs_voice_id': 'ELEVENLABS_VOICE_ID',
});

// Mapeo legacy: telegram-config.json usa flat keys (no nested). Solo cubre las
// que existían en ese formato — providers nuevos (google/cerebras/nvidia) no
// se cargan del legacy porque no existían cuando ese archivo era canónico.
//
// #3353 (mayo 2026): `groq_api_key` se removió del mapping legacy junto con la
// descontinuación de Groq. Si aparece en el JSON legacy se ignora silenciosamente.
const LEGACY_MAPPING = Object.freeze({
  'bot_token':           'TELEGRAM_BOT_TOKEN',
  'chat_id':             'TELEGRAM_CHAT_ID',
  'openai_api_key':      'OPENAI_API_KEY',
  'anthropic_api_key':   'ANTHROPIC_API_KEY',
  'elevenlabs_api_key':  'ELEVENLABS_API_KEY',
  'elevenlabs_voice_id': 'ELEVENLABS_VOICE_ID',
});

const PLACEHOLDER_RE = /(REVOKED|PLACEHOLDER|MOVED|EXAMPLE|REPLACE|CHANGE_ME)/i;

function isPlaceholderOrEmpty(value) {
  if (value === null || value === undefined) return true;
  const s = String(value);
  if (s.trim().length === 0) return true;
  return PLACEHOLDER_RE.test(s);
}

function getNested(obj, dotPath) {
  return dotPath.split('.').reduce(
    (acc, k) => (acc && typeof acc === 'object') ? acc[k] : undefined,
    obj
  );
}

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

/**
 * Lee credentials.json y popula `env` con las credenciales mapeadas.
 *
 * @param {object} [opts]
 * @param {function} [opts.logger=console.log] Logger para warnings/errors.
 * @param {string}   [opts.canonicalPath]      Path del archivo canónico (override para tests).
 * @param {string}   [opts.legacyPath]         Path del archivo legacy (override para tests).
 * @param {object}   [opts.env=process.env]    Env target (override para tests).
 * @returns {{source: 'canonical'|'legacy'|'none', hydrated: string[], skipped_existing: string[], skipped_empty: string[]}}
 */
function loadIntoEnv(opts = {}) {
  const logger = typeof opts.logger === 'function' ? opts.logger : console.log;
  const canonicalPath = opts.canonicalPath || CANONICAL_PATH;
  const legacyPath = opts.legacyPath || LEGACY_PATH;
  const env = opts.env || process.env;

  const result = { source: 'none', hydrated: [], skipped_existing: [], skipped_empty: [] };

  let data = null;
  let usingMapping = null;

  if (fs.existsSync(canonicalPath)) {
    try {
      data = readJsonFile(canonicalPath);
      result.source = 'canonical';
      usingMapping = ENV_MAPPING;
    } catch (e) {
      logger(`[credentials] WARN: ${canonicalPath} es JSON invalido (${e.message}); intentando fallback al legacy`);
    }
  }

  if (!data && fs.existsSync(legacyPath)) {
    try {
      data = readJsonFile(legacyPath);
      result.source = 'legacy';
      usingMapping = LEGACY_MAPPING;
      logger(`[credentials] WARN: usando archivo legacy ${legacyPath}. Migrar a ${canonicalPath} (ver docs/runbooks/credential-rotation.md)`);
    } catch (e) {
      logger(`[credentials] ERROR: legacy ${legacyPath} es JSON invalido (${e.message}); process.env queda como esta`);
      return result;
    }
  }

  if (!data) {
    logger(`[credentials] WARN: no se encontro ${canonicalPath} ni ${legacyPath}; process.env queda como esta`);
    return result;
  }

  for (const [sourceKey, envVar] of Object.entries(usingMapping)) {
    if (env[envVar] && String(env[envVar]).length > 0) {
      result.skipped_existing.push(envVar);
      continue;
    }
    const raw = (usingMapping === ENV_MAPPING)
      ? getNested(data, sourceKey)
      : data[sourceKey];
    if (isPlaceholderOrEmpty(raw)) {
      result.skipped_empty.push(envVar);
      continue;
    }
    env[envVar] = String(raw);
    result.hydrated.push(envVar);
  }

  return result;
}

module.exports = {
  loadIntoEnv,
  CANONICAL_PATH,
  LEGACY_PATH,
  ENV_MAPPING,
  LEGACY_MAPPING,
  isPlaceholderOrEmpty,
  getNested,
};

// CLI: dry-run que imprime resumen sin valores. Útil para diagnóstico operativo.
//   node .pipeline/lib/credentials.js
if (require.main === module) {
  const result = loadIntoEnv({ logger: (m) => process.stderr.write(m + '\n') });
  process.stdout.write(JSON.stringify({
    source: result.source,
    hydrated_count: result.hydrated.length,
    hydrated: result.hydrated,
    skipped_existing: result.skipped_existing,
    skipped_empty: result.skipped_empty,
  }, null, 2) + '\n');
}

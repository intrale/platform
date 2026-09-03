// =============================================================================
// hydrate-provider-env.js — Hidrata `process.env` con las API keys de proveedores
// LLM/TTS guardadas en `~/.claude/secrets/telegram-config.json`.
//
// CONTEXTO (#3075 multi-provider H3 — desbloqueo openai-codex)
// -----------------------------------------------------------------------------
// El pulpo lee `telegram-config.json` para TTS (OpenAI) y Whisper local. La key
// `openai_api_key` ya vive ahí. El dispatcher `build-child-env.js` filtra el env
// del padre con allowlist mínima — para que el child de `openai-codex` reciba
// `OPENAI_API_KEY`, el **padre** (pulpo) tiene que tenerla en `process.env`.
//
// Antes de esta hidratación, el operador tenía que setear `OPENAI_API_KEY` como
// env var del SO (User/Machine), creando una segunda fuente de verdad. Rotar la
// key requería cambiarla en dos lados. Ahora la fuente única es el JSON.
//
// REGLA DE PRECEDENCIA
// -----------------------------------------------------------------------------
// 1. Si el env var ya existe en `process.env` (ej. seteado por el operador o por
//    un test), NO se sobreescribe — el llamador manda.
// 2. Si está vacío y el JSON tiene la key correspondiente, se hidrata.
// 3. Si ni env ni JSON la traen, se loguea WARN y se sigue (degradación grácil).
//
// Esta función es idempotente: ejecutarla varias veces no cambia el resultado
// salvo que el JSON cambie y reiniciemos el pulpo.
//
// #5799 — YA NO ES LA FUENTE DE CREDENCIALES DE LOS HIJOS
// -----------------------------------------------------------------------------
// Esa última frase ("salvo que reiniciemos el pulpo") es justamente el defecto
// que cierra #5799: hidratar UNA vez en el boot ata la credencial que reciben
// los hijos a la vida del proceso padre, así que una rotación no llega hasta el
// próximo restart.
//
// Con `pipeline.credential_snapshot_enabled: true`, cada lanzamiento hidrata su
// PROPIO snapshot (`lib/attempt-credential-snapshot.js` sobre la API de #5798) y
// el env base del hijo se compone PURGADO de todas las credenciales de
// providers. O sea: lo que esta función deja en `process.env` deja de cruzar al
// hijo, y el material sale del snapshot del intento.
//
// Esta hidratación se conserva por dos razones, ninguna de ellas "credenciales
// para los hijos":
//   1. Con el gate cerrado (default del rollout) sigue siendo el camino legacy.
//   2. El propio Pulpo consume `OPENAI_API_KEY` in-process (TTS, Whisper), y ese
//      consumo es del PADRE, no de un hijo.
// =============================================================================

'use strict';

const { loadApiKeys } = require('./telegram-secrets');

// Mapeo: campo del JSON → env var que esperan los CLIs externos.
// `anthropic_api_key` queda fuera del default a propósito: Claude Code ya tiene
// auth propia vía OAuth/MAX login, sobre-hidratar puede confundirlo. El operador
// puede pasarla explícitamente si la necesita seteando la env var del SO.
const ENV_MAPPING = Object.freeze({
    openai_api_key: 'OPENAI_API_KEY',
});

function hydrateProviderEnv({ legacyConfigPath, log, loadKeysFn } = {}) {
    const logger = typeof log === 'function' ? log : () => {};
    const loader = typeof loadKeysFn === 'function' ? loadKeysFn : loadApiKeys;
    const keys = loader({ legacyConfigPath });

    const hydrated = [];
    const alreadySet = [];
    const missing = [];

    for (const [jsonField, envVar] of Object.entries(ENV_MAPPING)) {
        const fromJson = keys[jsonField];
        const fromEnv = process.env[envVar];

        if (fromEnv && fromEnv.trim()) {
            alreadySet.push(envVar);
            continue;
        }
        if (fromJson && fromJson.trim()) {
            process.env[envVar] = fromJson;
            hydrated.push(envVar);
            continue;
        }
        missing.push(envVar);
    }

    if (hydrated.length) logger(`[pulpo] env hydration: hidratadas desde JSON → ${hydrated.join(', ')}`);
    if (alreadySet.length) logger(`[pulpo] env hydration: ya estaban en env (no se tocaron) → ${alreadySet.join(', ')}`);
    if (missing.length) logger(`[pulpo] env hydration: faltantes (no hay valor en env ni JSON) → ${missing.join(', ')}`);

    return { hydrated, alreadySet, missing };
}

module.exports = { hydrateProviderEnv, ENV_MAPPING };

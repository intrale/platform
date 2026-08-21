// =============================================================================
// model-propagation.js — Política PURA de propagación del modelo resuelto al
// proceso hijo (#6272, split de #6270).
//
// Responde una sola pregunta: dado (provider activo, skill/actor, modelo
// resuelto, config), ¿el modelo viaja al hijo, por qué canal, y con qué valor?
//
// Sin side effects: no lee env, no lee disco, no spawnea, no loggea. El
// `agent-launcher` orquesta (aplica la decisión y emite la traza); este módulo
// sólo decide. Mismo estilo que `lib/commander/glitch-retry.js`: constantes
// arriba, funciones puras, exports explícitos al final.
//
// -----------------------------------------------------------------------------
// Por qué existe (el bug que cierra)
// -----------------------------------------------------------------------------
// `agent-launcher.js` resolvía `effective.model` y lo devolvía al caller SÓLO
// para logging: nunca llegaba al `buildSpawn` del handler ni al env del hijo.
// Resultado: los cinco providers corrían con el default de su CLI, no con el
// modelo declarado en `agent-models.json`.
//
// -----------------------------------------------------------------------------
// Canales por provider (`resolveTarget`)
// -----------------------------------------------------------------------------
//   - launcher `claude` (anthropic, kimi-moonshot) → flag `--model <id>` como
//     ELEMENTO SEPARADO del array de args. Nunca interpolación de string:
//     `detectLauncher` puede devolver `shell:true` (tiers cmd-shim /
//     path-fallback), así que un id con metacaracteres escalaría a `cmd.exe`.
//   - resto → variable de entorno del hijo, según `PROVIDER_MODEL_ENV`
//     (`lib/build-child-env.js`), que es la constante de código dueña de los
//     nombres. Cada handler YA lee esa variable; acá sólo la completamos.
//
// -----------------------------------------------------------------------------
// Rollout (`resolveMode`) — apagado por default
// -----------------------------------------------------------------------------
// `config.yaml` → `pipeline.model_propagation`:
//
//   pipeline:
//     model_propagation:
//       enabled: false          # kill-switch global; false ⇒ modo 'off' duro
//       default_mode: 'off'     # off | dry-run | on
//       by_provider:            # granularidad por PROVEEDOR
//         anthropic: 'dry-run'
//       by_skill:               # granularidad por ACTOR (skill)
//         guru: 'on'
//
// Precedencia: by_skill > by_provider > default_mode > 'off'. El más específico
// gana, así el encendido escalonado de #6274 puede prender un actor sin prender
// a su proveedor entero (y viceversa).
//
// Modos:
//   - 'off'     → no se toca nada. El objeto que recibe `child_process.spawn`
//                 es byte-idéntico al previo (CA-4).
//   - 'dry-run' → se calcula TODO (whitelist + catálogo) y se emite la traza
//                 con el modelo que SE HABRÍA pasado, pero no se altera el
//                 comando (CA-5).
//   - 'on'      → se aplica.
//
// -----------------------------------------------------------------------------
// Defensa del valor (SR-A.1, patrón de `commander/glitch-retry.js`)
// -----------------------------------------------------------------------------
// Orden estricto: typeof → cap de longitud → whitelist. Si algo no valida →
// `model: null` con `reason` TIPADA, el caller OMITE el flag/env, el agente
// arranca heredando el default del CLI y queda traza (CA-3). Jamás se pasa un
// valor arbitrario a la línea de comandos ni al env.
//
// -----------------------------------------------------------------------------
// Validación contra catálogo (CA-6)
// -----------------------------------------------------------------------------
// `validateDeclaredModel` cruza el id contra `ALLOWED_MODELS_BY_LAUNCHER`
// (`lib/agent-models-validate.js`) — la MISMA tabla que ya valida el boot, no
// un catálogo nuevo. Ojo con la asimetría: esa tabla indexa por **launcher**,
// mientras que `multi-provider/model-catalog.js` indexa por **provider**. No son
// intercambiables (`kimi-moonshot` es un provider que reusa el launcher
// `claude`), así que acá mapeamos provider → launcher leyendo
// `providers.<p>.launcher` de `agent-models.json`, igual que hace
// `validateCrossReferences`. Un id inválido se reporta como ERROR DE
// CONFIGURACIÓN (traza accionable enumerando los válidos) y NO propaga: nunca
// mata al agente.
// =============================================================================
'use strict';

// SR-A.1 — reusamos la whitelist canónica de #3950 en vez de escribir otra:
// una sola definición de "qué es un id de modelo aceptable" para el canal argv.
const { MODEL_WHITELIST, MODEL_MAX_LEN } = require('./commander/glitch-retry');
// Fuente única de los nombres de env por provider (#6272 / patrón #4880).
const { PROVIDER_MODEL_ENV } = require('./build-child-env');
// Catálogo canónico ya usado por el boot (#3220).
const { ALLOWED_MODELS_BY_LAUNCHER } = require('./agent-models-validate');

// -----------------------------------------------------------------------------
// Whitelists por CANAL — dos, no una, y a propósito.
//
//   MODEL_ARG_WHITELIST (= la de glitch-retry): canal argv. Es la más estricta
//     porque `detectLauncher` de Anthropic puede devolver `shell:true` (tiers
//     cmd-shim / path-fallback) y ahí un metacaracter escala a `cmd.exe`.
//
//   MODEL_ENV_WHITELIST: canal env. Agrega EXACTAMENTE un carácter, la barra
//     `/`, porque los ids reales de NVIDIA NIM son namespaced
//     (`deepseek-ai/deepseek-v4-flash-0731`, `moonshotai/kimi-k2-instruct`, ambos
//     en ALLOWED_MODELS_BY_LAUNCHER['nvidia-nim']). Con la whitelist estricta,
//     CA-2 sería inalcanzable para NVIDIA: su modelo declarado se rechazaría
//     siempre. La `/` es segura en este canal: los providers que reciben el
//     modelo por env corren con `shell:false` SIEMPRE (cerebras y nvidia-nim lo
//     fijan en código; gemini-google también), y aun en el único que puede caer a
//     `shell:true` (openai-codex, tiers cmd-shim / path-fallback) la `/` no es
//     metacaracter de `cmd.exe` (`& | < > ^ " %` sí lo son, y ninguno pasa).
//
// Ambas mantienen el cap de longitud compartido y siguen rechazando espacios,
// comillas, `$`, backticks, saltos de línea y todo el resto.
// -----------------------------------------------------------------------------
const MODEL_ARG_WHITELIST = MODEL_WHITELIST;
const MODEL_ENV_WHITELIST = /^[A-Za-z0-9._\-[\]/]{1,64}$/;

// Modos válidos del flag. Cualquier otro valor en config se IGNORA (se cae al
// siguiente nivel de precedencia) — un typo no debe encender la propagación.
const MODES = Object.freeze(['off', 'dry-run', 'on']);
const MODE_OFF = 'off';

// Providers cuyo modelo viaja por argv (`--model`), no por env: los que corren
// sobre el launcher `claude`. Constante de código, no derivada de input.
const ARG_MODEL_PROVIDERS = Object.freeze(['anthropic', 'kimi-moonshot']);

// El provider determinístico no tiene modelo: es Node puro.
const NO_MODEL_PROVIDERS = Object.freeze(['deterministic']);

// -----------------------------------------------------------------------------
// sanitizeModelId(rawModel, { channel }) → { model, reason }
//
// Orden SR-A.2: typeof → cap de longitud → whitelist. `model: null` ⇒ el caller
// OMITE la propagación y mantiene la herencia del default del CLI.
// `reason` ∈ { 'ok' | 'not_a_string' | 'length_out_of_range' | 'failed_whitelist' }.
//
// `channel` ∈ { 'arg' (default) | 'env' }. El default es el canal MÁS ESTRICTO a
// propósito: un caller que se olvide de declarar el canal obtiene la validación
// más dura, nunca la más laxa (fail-safe).
// -----------------------------------------------------------------------------
function sanitizeModelId(rawModel, opts) {
    const channel = (opts && opts.channel === 'env') ? 'env' : 'arg';
    const whitelist = channel === 'env' ? MODEL_ENV_WHITELIST : MODEL_ARG_WHITELIST;
    if (typeof rawModel !== 'string') {
        return { model: null, reason: 'not_a_string' };
    }
    if (rawModel.length === 0 || rawModel.length > MODEL_MAX_LEN) {
        return { model: null, reason: 'length_out_of_range' };
    }
    if (!whitelist.test(rawModel)) {
        return { model: null, reason: 'failed_whitelist' };
    }
    return { model: rawModel, reason: 'ok' };
}

// -----------------------------------------------------------------------------
// safeForLog(rawModel) → string
//
// Anti-leak para la traza del id RECHAZADO: el valor rechazado justamente NO
// pasó la whitelist, así que no se imprime crudo (vector: alguien pone una API
// key en `model` y termina en log / Telegram / PDF). Mismo criterio de defensa
// en profundidad que `agent-models-validate.js` con `[REDACTED]`.
// -----------------------------------------------------------------------------
function safeForLog(rawModel) {
    if (typeof rawModel !== 'string') return `<${typeof rawModel}>`;
    if (rawModel.length === 0) return '<vacío>';
    // Sólo caracteres inofensivos y recortado: suficiente para que el operador
    // reconozca el typo, insuficiente para exfiltrar un secreto entero.
    const cleaned = rawModel.replace(/[^A-Za-z0-9._\-[\]/]/g, '·');
    return cleaned.length > 32 ? `${cleaned.slice(0, 32)}…(${rawModel.length} chars)` : cleaned;
}

// -----------------------------------------------------------------------------
// normalizeMode(value) → 'off' | 'dry-run' | 'on' | null
// Devuelve null si el valor no es un modo válido (typo en config → se ignora).
// -----------------------------------------------------------------------------
function normalizeMode(value) {
    if (typeof value !== 'string') return null;
    const v = value.trim().toLowerCase();
    return MODES.includes(v) ? v : null;
}

// -----------------------------------------------------------------------------
// resolveMode({ config, provider, skill }) → { mode, source }
//
// `config` es el objeto completo de `config.yaml` (el que el pulpo ya tiene en
// mano). Lectura 100% defensiva: cualquier forma inesperada cae a 'off'.
// `source` ∈ { 'kill-switch' | 'skill' | 'provider' | 'default' | 'implicit-off' }.
// -----------------------------------------------------------------------------
function resolveMode(opts) {
    const o = opts || {};
    const cfg = (o.config && o.config.pipeline && o.config.pipeline.model_propagation) || null;

    // Kill-switch global: sin sección, o `enabled` que no sea exactamente true,
    // el modo es 'off' duro y ni siquiera se miran las granularidades.
    if (!cfg || typeof cfg !== 'object' || cfg.enabled !== true) {
        return { mode: MODE_OFF, source: 'kill-switch' };
    }

    const bySkill = (cfg.by_skill && typeof cfg.by_skill === 'object' && o.skill)
        ? normalizeMode(cfg.by_skill[o.skill])
        : null;
    if (bySkill) return { mode: bySkill, source: 'skill' };

    const byProvider = (cfg.by_provider && typeof cfg.by_provider === 'object' && o.provider)
        ? normalizeMode(cfg.by_provider[o.provider])
        : null;
    if (byProvider) return { mode: byProvider, source: 'provider' };

    const byDefault = normalizeMode(cfg.default_mode);
    if (byDefault) return { mode: byDefault, source: 'default' };

    return { mode: MODE_OFF, source: 'implicit-off' };
}

// -----------------------------------------------------------------------------
// resolveTarget(provider) → { kind, envVar }
//
// `kind` ∈ { 'arg' | 'env' | 'none' }. 'none' = el provider no sabe recibir un
// modelo (determinístico, o un provider nuevo sin canal declarado). El guardrail
// anti-regresión (CA-7) falla si un handler LLM cae en 'none'.
// -----------------------------------------------------------------------------
function resolveTarget(provider) {
    if (typeof provider !== 'string' || provider.length === 0) {
        return { kind: 'none', envVar: null };
    }
    if (NO_MODEL_PROVIDERS.includes(provider)) return { kind: 'none', envVar: null };
    if (ARG_MODEL_PROVIDERS.includes(provider)) return { kind: 'arg', envVar: null };
    const envVar = PROVIDER_MODEL_ENV[provider];
    if (typeof envVar === 'string' && envVar.length > 0) return { kind: 'env', envVar };
    return { kind: 'none', envVar: null };
}

// -----------------------------------------------------------------------------
// validateDeclaredModel({ model, provider, agentModels }) → { ok, error, allowed }
//
// CA-6 — cruce contra ALLOWED_MODELS_BY_LAUNCHER *antes* del spawn. Mapea
// provider → launcher vía `agent-models.json` (mismo camino que el boot). Si no
// se puede determinar el launcher, o el launcher no tiene allowlist (node,
// ollama), se acepta: ausencia de catálogo no es evidencia de invalidez.
// -----------------------------------------------------------------------------
function validateDeclaredModel(opts) {
    const o = opts || {};
    const model = o.model;
    if (typeof model !== 'string' || model.length === 0) {
        return { ok: true, error: null, allowed: null };
    }

    // `agentModels` acepta objeto O thunk. El thunk existe para que el caller
    // (agent-launcher) NO pague la lectura de `agent-models.json` en cada spawn
    // cuando la propagación está apagada: con el flag off nunca se llega acá.
    let agentModels = o.agentModels;
    if (typeof agentModels === 'function') {
        try { agentModels = agentModels(); } catch { agentModels = null; }
    }

    const providers = (agentModels && typeof agentModels === 'object' && agentModels.providers) || null;
    const providerDef = (providers && typeof providers === 'object' && o.provider)
        ? providers[o.provider]
        : null;
    const launcher = (providerDef && typeof providerDef.launcher === 'string') ? providerDef.launcher : null;
    if (!launcher) return { ok: true, error: null, allowed: null };

    const allowed = ALLOWED_MODELS_BY_LAUNCHER[launcher];
    if (!Array.isArray(allowed) || allowed.length === 0) {
        return { ok: true, error: null, allowed: null };
    }
    if (allowed.includes(model)) return { ok: true, error: null, allowed };

    return {
        ok: false,
        allowed,
        error: `modelo "${safeForLog(model)}" declarado para el provider "${o.provider}" `
            + `no pertenece a ALLOWED_MODELS_BY_LAUNCHER["${launcher}"] `
            + `(válidos: ${allowed.join(', ')}). `
            + 'Corregir agent-models.json, o agregar el id nuevo a ALLOWED_MODELS_BY_LAUNCHER '
            + 'en lib/agent-models-validate.js (decisión de plataforma — requiere review).',
    };
}

// -----------------------------------------------------------------------------
// plan({ provider, skill, model, config, agentModels }) → decision
//
// Decisión completa y auditable. Campos:
//   mode         'off' | 'dry-run' | 'on'
//   modeSource   de dónde salió el modo (kill-switch / skill / provider / default)
//   target       'arg' | 'env' | 'none'
//   envVar       nombre de la var cuando target === 'env', si no null
//   model        id ya saneado, o null si fue rechazado
//   rejectedReason  razón TIPADA del rechazo del valor, o null
//   configError  mensaje accionable de error de configuración (CA-6), o null
//   apply        true SÓLO si mode === 'on' y todo lo demás dio verde
//   trace        línea de log lista para emitir, o null si no hay nada que decir
//
// Contrato de regresión cero (CA-4): con mode 'off' devuelve `apply:false` y
// `trace:null` — el launcher no toca ni args ni env.
// -----------------------------------------------------------------------------
function plan(opts) {
    const o = opts || {};
    const provider = o.provider;
    const skill = o.skill;

    const { mode, source: modeSource } = resolveMode({ config: o.config, provider, skill });

    const base = {
        mode,
        modeSource,
        target: 'none',
        envVar: null,
        model: null,
        rejectedReason: null,
        configError: null,
        apply: false,
        trace: null,
    };

    // 'off' = silencio absoluto. Ni siquiera calculamos: cualquier traza acá
    // sería ruido en el 100% de los spawns durante el rollout apagado.
    if (mode === MODE_OFF) return base;

    const target = resolveTarget(provider);
    base.target = target.kind;
    base.envVar = target.envVar;

    const prefix = mode === 'dry-run' ? '[dry-run] ' : '';
    const actor = `${skill || '<sin-skill>'}@${provider || '<sin-provider>'}`;

    if (target.kind === 'none') {
        base.trace = `${prefix}propagación de modelo OMITIDA para ${actor}: `
            + 'el provider no declara canal de modelo (ni flag --model ni entrada en '
            + 'PROVIDER_MODEL_ENV de lib/build-child-env.js). El agente arranca heredando '
            + 'el default de su CLI.';
        return base;
    }

    // Paso 1 — saneo del valor (SR-A.1). Va ANTES del catálogo: no queremos
    // cruzar contra la allowlist un string arbitrario.
    const sane = sanitizeModelId(o.model, { channel: target.kind });
    if (!sane.model) {
        base.rejectedReason = sane.reason;
        base.trace = `${prefix}modelo RECHAZADO por whitelist para ${actor} `
            + `(id: ${safeForLog(o.model)}, razón: ${sane.reason}). `
            + 'No se pasa --model ni se setea la env: el agente arranca heredando el default '
            + 'del CLI. El spawn NO se aborta.';
        return base;
    }
    base.model = sane.model;

    // Paso 2 — validación contra catálogo (CA-6). Error de CONFIGURACIÓN: se
    // reporta con mensaje accionable y NO propaga, pero el agente igual arranca.
    const catalog = validateDeclaredModel({ model: sane.model, provider, agentModels: o.agentModels });
    if (!catalog.ok) {
        base.configError = catalog.error;
        base.model = null;
        base.trace = `${prefix}ERROR DE CONFIGURACIÓN para ${actor}: ${catalog.error} `
            + 'No se propaga el modelo; el agente arranca con el default del CLI. El spawn NO se aborta.';
        return base;
    }

    // Paso 3 — todo verde.
    const canal = target.kind === 'arg' ? '--model (argv)' : `env ${target.envVar}`;
    if (mode === 'dry-run') {
        base.trace = `[dry-run] modelo "${sane.model}" NO propagado a ${actor} `
            + `(se habría pasado por ${canal}). El comando queda sin alterar. `
            + `Modo resuelto por: ${modeSource}.`;
        return base;
    }

    base.apply = true;
    base.trace = `modelo "${sane.model}" propagado a ${actor} por ${canal}. `
        + `Modo resuelto por: ${modeSource}.`;
    return base;
}

module.exports = {
    plan,
    resolveMode,
    resolveTarget,
    sanitizeModelId,
    validateDeclaredModel,

    // Constantes (consumidas por el launcher, los handlers y los tests).
    MODES,
    MODE_OFF,
    ARG_MODEL_PROVIDERS,
    NO_MODEL_PROVIDERS,
    PROVIDER_MODEL_ENV,
    MODEL_ARG_WHITELIST,
    MODEL_ENV_WHITELIST,
    MODEL_MAX_LEN,

    // Interno exportado para tests / trazas de terceros.
    _safeForLog: safeForLog,
};

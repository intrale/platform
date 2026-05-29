// =============================================================================
// resolve-provider.js — Resolución skill → provider/handler.
//
// CA-2 del issue #3074: el mapeo provider→handler es una **tabla hardcoded**
// (defensa contra path-traversal en agent-models.json). NO usar
// `require(\`./providers/\${name}.js\`)` dinámico — un atacante con permiso de
// PR podría poner `provider: "../../etc/passwd"` y el require lo cargaría.
//
// Default defensivo: si `agent-models.json` no existe, no resuelve un skill,
// o no es JSON válido, defaulteamos a Anthropic con modelo legacy
// "claude-opus-4-7" para garantizar regresión cero corriendo solo Anthropic
// (CA-4) hasta que H1 (#3072) deje el archivo en disco.
//
// Skills determinísticos (allowlist en providers/deterministic.js) siempre
// van por el provider deterministic, sin importar lo que diga el JSON.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// -----------------------------------------------------------------------------
// Tabla hardcoded de providers (CA-2 / I-CRÍTICO seguridad).
// El orden no importa; usamos hasOwnProperty para descartar provider names
// inexistentes con mensaje accionable.
// -----------------------------------------------------------------------------
const PROVIDER_HANDLERS = {
    'anthropic': require('./providers/anthropic'),
    'openai-codex': require('./providers/openai-codex'),
    // #3220 — providers sign-off 2026-05-15. Handlers stub: tiran error
    // accionable si se les pide spawn antes de #3198 (runtime real).
    'gemini-google': require('./providers/gemini-google'),
    'cerebras': require('./providers/cerebras'),
    // #3243 — NVIDIA NIM, 4to free provider. Stub idéntico al patrón de los
    // otros 3 free providers: error accionable hasta que #3198 entregue el
    // wrapper real, sin tokens consumidos, sin crash del pulpo.
    'nvidia-nim': require('./providers/nvidia-nim'),
    'deterministic': require('./providers/deterministic'),
    // Groq fue descontinuado en #3353 (mayo 2026) por política de bloqueos
    // arbitrarios — el handler stub y la referencia se removieron del mapa.
};

const VALID_PROVIDERS = Object.freeze(Object.keys(PROVIDER_HANDLERS));

// Modelo legacy para fallback de regresión cero (idéntico al hardcode previo
// en pulpo.js:4954 antes de #3072 / H1).
const LEGACY_ANTHROPIC_MODEL = 'claude-opus-4-7';

// -----------------------------------------------------------------------------
// getProviderHandler — busca un handler por nombre. Throw si no existe.
//
// CA-7 (DX): mensaje accionable que incluye provider recibido, válidos y
// dónde corregir. NO uses `require` dinámico — la tabla hardcoded ES la
// validación.
// -----------------------------------------------------------------------------
function getProviderHandler(name) {
    if (typeof name !== 'string' || name.length === 0) {
        throw new Error(
            `[agent-launcher] Provider inválido (vacío o no string).\n` +
            `Providers válidos: ${VALID_PROVIDERS.join(', ')}.\n` +
            `Verificar .pipeline/agent-models.json (campo "provider" del skill afectado).`
        );
    }
    if (!Object.prototype.hasOwnProperty.call(PROVIDER_HANDLERS, name)) {
        throw new Error(
            `[agent-launcher] Provider desconocido "${name}".\n` +
            `Providers válidos: ${VALID_PROVIDERS.join(', ')}.\n` +
            `Verificar .pipeline/agent-models.json (campo "provider" del skill afectado).`
        );
    }
    return PROVIDER_HANDLERS[name];
}

// -----------------------------------------------------------------------------
// readAgentModels — lee y parsea agent-models.json en pipelineDir/agent-models.json.
//
// Defensivo: cualquier error (no existe, JSON inválido, IO error) retorna
// null SIN tirar. El llamador caerá al default de Anthropic.
// -----------------------------------------------------------------------------
function readAgentModels(pipelineDir, fsImpl) {
    const _fs = fsImpl || fs;
    if (!pipelineDir) return null;
    const modelsPath = path.join(pipelineDir, 'agent-models.json');
    try {
        if (!_fs.existsSync(modelsPath)) return null;
        const raw = _fs.readFileSync(modelsPath, 'utf8');
        return JSON.parse(raw);
    } catch (e) {
        // No bloqueamos por JSON inválido. El warning lo reporta el wrapper
        // que llama a `resolveProviderForSkill` (tiene acceso a `log`).
        return { __readError: e.message };
    }
}

// -----------------------------------------------------------------------------
// resolveProviderForSkill — devuelve { provider, model, handler, source } para
// un skill dado.
//
// Reglas:
//  1. Si el skill está en la allowlist determinística → provider 'deterministic'.
//  2. Si `agent-models.json` no existe / no resuelve el skill → default
//     'anthropic' con modelo legacy (regresión cero).
//  3. Si resuelve, valida `provider` contra la tabla hardcoded.
// -----------------------------------------------------------------------------
function resolveProviderForSkill(skill, opts = {}) {
    const { pipelineDir, fsImpl } = opts;

    // 1. Skills determinísticos: allowlist hardcoded del propio handler
    //    (no consulta agent-models.json, son Node puro y sin tokens).
    const determHandler = PROVIDER_HANDLERS.deterministic;
    if (determHandler.isDeterministic(skill)) {
        // #3605 — `interactive_supported` puede estar declarado por skill en
        // agent-models.json incluso para skills determinísticos (un script Node
        // que implemente un loop de lectura de stdin sí podría aprovecharlo).
        // Si no está, default false (preserva I3 del agent-launcher).
        const models0 = readAgentModels(pipelineDir, fsImpl);
        const skillCfg0 = (models0 && !models0.__readError && models0.skills && models0.skills[skill]) || null;
        return {
            provider: 'deterministic',
            model: null,
            mode: 'native',
            handler: determHandler,
            source: 'deterministic-allowlist',
            interactive_supported: !!(skillCfg0 && skillCfg0.interactive_supported === true),
        };
    }

    // 2. Lectura defensiva de agent-models.json
    const models = readAgentModels(pipelineDir, fsImpl);
    if (!models) {
        return {
            provider: 'anthropic',
            model: LEGACY_ANTHROPIC_MODEL,
            mode: 'bypassPermissions',
            handler: PROVIDER_HANDLERS.anthropic,
            source: 'fallback-no-config',
            interactive_supported: false,
        };
    }
    if (models.__readError) {
        return {
            provider: 'anthropic',
            model: LEGACY_ANTHROPIC_MODEL,
            mode: 'bypassPermissions',
            handler: PROVIDER_HANDLERS.anthropic,
            source: 'fallback-read-error',
            warning: `agent-models.json no se pudo parsear: ${models.__readError}`,
            interactive_supported: false,
        };
    }

    const skillCfg = (models.skills && models.skills[skill]) || null;
    const defaultModel = (models.defaults && models.defaults.model) || LEGACY_ANTHROPIC_MODEL;

    if (!skillCfg) {
        return {
            provider: 'anthropic',
            model: defaultModel,
            mode: resolvePermissionMode(models, 'anthropic'),
            handler: PROVIDER_HANDLERS.anthropic,
            source: 'fallback-skill-not-found',
            interactive_supported: false,
        };
    }

    const providerName = skillCfg.provider || 'anthropic';
    const handler = getProviderHandler(providerName); // valida contra tabla hardcoded
    return {
        provider: providerName,
        model: skillCfg.model || defaultModel,
        // #3082 (CA-8): el mode efectivo del provider para este skill es lo
        // que la matriz capability×(provider, mode) consume. Lo extraemos del
        // bloque providers.<X>.permissions_mode de agent-models.json. Si no
        // está declarado, el caller cae al default por provider (anthropic →
        // bypassPermissions, openai-codex → full-auto).
        mode: resolvePermissionMode(models, providerName),
        handler,
        source: 'agent-models',
        // #3605 — Opt-in por skill+provider. Solo cuando true:
        //   (a) agent-launcher pisa `stdio[0] = 'pipe'` para habilitar IPC.
        //   (b) el endpoint /api/agent-chat acepta mensajes para este skill.
        // Default false: NO se cambia I3 global (regresión cero CA-4).
        interactive_supported: skillCfg.interactive_supported === true,
    };
}

// -----------------------------------------------------------------------------
// resolvePermissionMode — #3082 (CA-8): extrae el `permissions_mode` del bloque
// `providers.<name>` de agent-models.json. Si está ausente, devuelve el default
// canónico por provider documentado en docs/pipeline-multi-provider/permission-mapping.md.
//
// El default por provider es **conservador**: el mode más permisivo que el pulpo
// usa hoy (`bypassPermissions` para anthropic, `full-auto` para openai-codex,
// `native` para deterministic). Cambiar el default acá requiere actualizar la
// matriz capability del validator y la doc canónica.
// -----------------------------------------------------------------------------
function resolvePermissionMode(models, providerName) {
    const defaultsByProvider = {
        anthropic: 'bypassPermissions',
        'openai-codex': 'full-auto',
        // #3220 — providers nuevos sign-off 2026-05-15. Default
        // `bypassPermissions` consistente con cómo el pulpo trata a Claude;
        // si #3198 detecta que un wrapper de provider concreto necesita
        // otro modo, lo declara via providers.<x>.permissions_mode.
        'gemini-google': 'bypassPermissions',
        'cerebras': 'bypassPermissions',
        // #3243 — NVIDIA NIM default consistent con otros free providers.
        'nvidia-nim': 'bypassPermissions',
        deterministic: 'native',
    };
    if (!models || !models.providers || !models.providers[providerName]) {
        return defaultsByProvider[providerName] || null;
    }
    const block = models.providers[providerName];
    return block.permissions_mode || defaultsByProvider[providerName] || null;
}

module.exports = {
    PROVIDER_HANDLERS,
    VALID_PROVIDERS,
    LEGACY_ANTHROPIC_MODEL,
    getProviderHandler,
    resolveProviderForSkill,
    readAgentModels,
    resolvePermissionMode,
};

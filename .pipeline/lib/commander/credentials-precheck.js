// =============================================================================
// commander/credentials-precheck.js — Pre-validación de credenciales del
// ranking multi-provider del Commander al boot del Pulpo (#3275 CA-9).
//
// CONTEXTO
// --------
// El fallback in-flight del Commander rota al siguiente provider en el ranking
// cuando el primario falla mid-turn. Si descubrimos mid-flight que el secundario
// no tenía credencial válida (variable de entorno ausente, JSON corrupto en
// credentials.json, etc.), el comportamiento sería indistinguible de un timeout
// real → entraríamos al canned response sin diagnosticar la causa real.
//
// Este módulo cierra ese gap: al boot, validamos TODAS las credenciales de
// los providers del ranking activo (primario + fallbacks declarados) y
// devolvemos un snapshot inmutable que el decisor in-flight consulta antes de
// elegir un secundario.
//
// CONTRATO
// --------
//   const precheck = precheckCommanderProviderRanking({
//     pipelineDir,        // root del .pipeline
//     processEnv,         // process.env (default process.env)
//     skill,              // 'telegram-commander' default
//     fsImpl, agentModelsValidate,  // inyectables tests
//   })
//   →
//   {
//     activeRanking: string[],    // providers efectivamente utilizables (primary + fallbacks válidos)
//     degraded: string[],         // providers degradados (sin credencial / config inválida)
//     degradedReasons: { provider: reason },
//     allFailed: boolean,         // true si ranking quedó vacío post-degradación
//     primaryProvider: string,    // del skill, para diagnóstico
//     fallbackProviders: string[],// originales declarados, sin filtrar
//   }
//
// Después: `isProviderDegraded(name)` consulta el snapshot.
//
// EFECTO SECUNDARIO
// -----------------
// Si `allFailed:true`, el caller (typically pulpo.js o restart.js) DEBE:
//   1. Loguear `[boot] ❌ todos los providers del Commander degradados…`
//   2. Encolar alerta Telegram crítica.
//   3. **Abortar boot** del Pulpo (process.exit(2)) — el Commander quedaría
//      sin LLM disponible, así que no tiene sentido continuar el boot.
//
// El módulo NO ejecuta esos efectos por sí mismo. Devuelve el snapshot
// inmutable, el caller decide.
//
// SEGURIDAD
// ---------
// S-1 NO leemos los valores literales de las credenciales al log: sólo
//     verificamos presencia y placeholder. El primero que falla, lo
//     reportamos por nombre de variable (`CEREBRAS_API_KEY missing`), no
//     por valor.
// S-2 Fail-open NO permitido: si `agent-models.json` falla a parsear, todos
//     los providers se reportan como degraded (ranking vacío → caller aborta).
//     Mejor parar el boot que correr con ranking incierto.
// S-3 El precheck se hace UNA VEZ al boot. No re-check mid-flight (el
//     dispatcher in-flight consulta el snapshot inmutable). Esto evita el
//     edge case de credencial revocada mid-turn — política del PO: re-deploy
//     necesario para refrescar el snapshot, no se cachea con TTL.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PLACEHOLDER_RE = /(REVOKED|PLACEHOLDER|MOVED|EXAMPLE|REPLACE|CHANGE_ME)/i;

function isPlaceholderOrEmpty(value) {
    if (value === null || value === undefined) return true;
    const s = String(value);
    if (s.trim().length === 0) return true;
    return PLACEHOLDER_RE.test(s);
}

function readAgentModelsRaw(pipelineDir, fsImpl) {
    const _fs = fsImpl || fs;
    if (!pipelineDir) return null;
    const modelsPath = path.join(pipelineDir, 'agent-models.json');
    try {
        if (!_fs.existsSync(modelsPath)) return null;
        return JSON.parse(_fs.readFileSync(modelsPath, 'utf8'));
    } catch {
        return null;
    }
}

/**
 * Resuelve la lista de providers del ranking del skill: primario + fallbacks
 * declarados. Devuelve los nombres en orden, sin filtrar.
 *
 * El item del array de fallbacks puede ser string o `{provider, model_override}`
 * (mismo shape que `lib/agent-launcher/dispatch-with-fallback.js`).
 */
function resolveRankingForSkill(models, skill) {
    if (!models || !models.skills) return { primary: null, fallbacks: [] };
    const skillCfg = models.skills[skill];
    if (!skillCfg) return { primary: null, fallbacks: [] };
    const primary = skillCfg.provider || null;
    const fbArr = Array.isArray(skillCfg.fallbacks) ? skillCfg.fallbacks : [];
    const fallbacks = fbArr.map((entry) => {
        if (typeof entry === 'string') return entry;
        if (entry && typeof entry === 'object' && typeof entry.provider === 'string') {
            return entry.provider;
        }
        return null;
    }).filter(Boolean);
    return { primary, fallbacks };
}

/**
 * Valida una credencial individual:
 *   - El provider debe tener `credentials_env: [...]` declarado.
 *   - Cada var del array debe estar en processEnv con valor no-vacío y
 *     no-placeholder.
 *   - Excepción: provider con `launcher: 'claude'` autentica vía OAuth del
 *     CLI, no por env. Skipeamos su validación de env (igual que
 *     agent-models-validate.js).
 *
 * Devuelve `{ ok: bool, reason: string }`. `reason` viene poblado sólo si
 * `ok: false`.
 */
function validateProviderCredentials(providerName, providerDef, processEnv) {
    if (!providerDef || typeof providerDef !== 'object') {
        return { ok: false, reason: 'provider_definition_missing' };
    }

    // Launcher claude: OAuth flow, no validamos env.
    if (providerDef.launcher === 'claude') {
        return { ok: true };
    }

    if (!Array.isArray(providerDef.credentials_env) || providerDef.credentials_env.length === 0) {
        // Sin credentials_env declarado: aceptamos (no podemos validar).
        // El validator del schema ya lo hubiera bloqueado si fuera obligatorio.
        return { ok: true };
    }

    for (const envVar of providerDef.credentials_env) {
        if (typeof envVar !== 'string' || !envVar) continue;
        const val = processEnv[envVar];
        if (isPlaceholderOrEmpty(val)) {
            return { ok: false, reason: `env_missing_or_placeholder:${envVar}` };
        }
    }

    return { ok: true };
}

/**
 * precheckCommanderProviderRanking — núcleo público.
 */
function precheckCommanderProviderRanking(opts = {}) {
    const {
        pipelineDir,
        processEnv,
        skill,
        fsImpl,
    } = opts;

    const _env = processEnv || process.env;
    const _skill = skill || 'telegram-commander';

    const models = readAgentModelsRaw(pipelineDir, fsImpl);
    if (!models || !models.providers) {
        // Fail-closed: si agent-models.json no parsea, ranking vacío.
        return {
            activeRanking: [],
            degraded: [],
            degradedReasons: {},
            allFailed: true,
            primaryProvider: null,
            fallbackProviders: [],
            reason: 'agent_models_invalid',
        };
    }

    const { primary, fallbacks } = resolveRankingForSkill(models, _skill);

    if (!primary) {
        return {
            activeRanking: [],
            degraded: [],
            degradedReasons: {},
            allFailed: true,
            primaryProvider: null,
            fallbackProviders: [],
            reason: 'skill_or_primary_missing',
        };
    }

    const ordered = [primary, ...fallbacks];
    const seen = new Set();
    const uniqueOrdered = [];
    for (const p of ordered) {
        if (!seen.has(p)) {
            seen.add(p);
            uniqueOrdered.push(p);
        }
    }

    const activeRanking = [];
    const degraded = [];
    const degradedReasons = Object.create(null);

    for (const providerName of uniqueOrdered) {
        const def = models.providers[providerName];
        if (!def) {
            degraded.push(providerName);
            degradedReasons[providerName] = 'provider_not_in_models_json';
            continue;
        }
        const v = validateProviderCredentials(providerName, def, _env);
        if (v.ok) {
            activeRanking.push(providerName);
        } else {
            degraded.push(providerName);
            degradedReasons[providerName] = v.reason;
        }
    }

    return {
        activeRanking,
        degraded,
        degradedReasons,
        allFailed: activeRanking.length === 0,
        primaryProvider: primary,
        fallbackProviders: fallbacks,
    };
}

/**
 * makePrecheckHandle — fábrica de un handle inmutable que el decisor
 * in-flight consulta vía `isProviderDegraded(name)`. Se llama una vez al
 * boot con el resultado de `precheckCommanderProviderRanking`.
 */
function makePrecheckHandle(precheckResult) {
    const result = precheckResult || { degraded: [], activeRanking: [] };
    const degradedSet = new Set(result.degraded || []);
    return Object.freeze({
        isProviderDegraded(name) {
            return degradedSet.has(name);
        },
        activeRanking: Object.freeze([...(result.activeRanking || [])]),
        degraded: Object.freeze([...(result.degraded || [])]),
        allFailed: !!result.allFailed,
        primaryProvider: result.primaryProvider || null,
        snapshot() {
            return {
                activeRanking: [...(result.activeRanking || [])],
                degraded: [...(result.degraded || [])],
                degradedReasons: { ...(result.degradedReasons || {}) },
                allFailed: !!result.allFailed,
                primaryProvider: result.primaryProvider || null,
                fallbackProviders: [...(result.fallbackProviders || [])],
            };
        },
    });
}

/**
 * formatPrecheckReport — log human-readable para arrancar el pulpo. Útil
 * para que `boot` muestre el ranking efectivo en una sola línea.
 */
function formatPrecheckReport(result) {
    if (!result) return '[precheck] sin resultado';
    if (result.allFailed) {
        const reason = result.reason ? ` (${result.reason})` : '';
        const degList = Object.entries(result.degradedReasons || {})
            .map(([p, r]) => `${p}=${r}`).join(', ');
        return `[precheck] ❌ ranking vacío post-degradación${reason}. Degradados: ${degList || 'ninguno'}`;
    }
    const activeStr = (result.activeRanking || []).join(' → ');
    const degStr = (result.degraded || []).length > 0
        ? ` (degradados: ${result.degraded.join(', ')})`
        : '';
    return `[precheck] ✅ ranking activo: ${activeStr}${degStr}`;
}

module.exports = {
    precheckCommanderProviderRanking,
    makePrecheckHandle,
    formatPrecheckReport,
    // exports internos para tests
    _validateProviderCredentials: validateProviderCredentials,
    _resolveRankingForSkill: resolveRankingForSkill,
    _isPlaceholderOrEmpty: isPlaceholderOrEmpty,
};

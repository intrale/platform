// =============================================================================
// model-catalog.js — Catálogo hardcoded de modelos disponibles por provider.
//
// Issue: #3177 — Sección 3 "Catálogo de modelos" del dashboard multi-provider.
//
// Por qué hardcoded (y no auto-fetch desde el provider):
//   - Anthropic NO publica una API canónica de "modelos disponibles" con
//     capabilities + costo en forma estable. La data viene de docs.anthropic.com.
//   - OpenAI tiene `/v1/models` pero solo lista nombres, sin costo ni
//     capabilities estructuradas. El operador necesita ver costos para decidir.
//   - El catálogo cambia poco (1-2 releases por trimestre). Tenerlo en repo
//     permite review en PR y rollback claro.
//
// Cuando un modelo nuevo está disponible:
//   1. Agregarlo acá con capabilities + precio público vigente.
//   2. Si el nombre del modelo no está en `ALLOWED_MODELS_BY_LAUNCHER` de
//      agent-models-validate.js, también agregarlo allá.
//   3. Bumpear CATALOG_VERSION (para cache busting del front).
// =============================================================================
'use strict';

// 2026-09-16.1 — #6858: alta del provider `gemini-google` con el catálogo real
// de Antigravity (hasta acá el dashboard no mostraba ninguna fila Gemini pese
// a que 9 skills lo tienen en su cadena).
// 2026-09-16.2 — #6563: baja de `kimi-moonshot` (retirado del pipeline junto
// con cerebras y nvidia-nim; el plantel queda en anthropic, openai-codex y
// gemini-google).
const CATALOG_VERSION = '2026-09-16.2';

// #6858 — Helper para las 14 filas de Antigravity. El catálogo del CLI codifica
// el esfuerzo de razonamiento en el sufijo del id (`-high/-medium/-low`); ese
// sufijo es el ÚNICO canal de esfuerzo que usa el pipeline (nunca `--effort`).
// Antigravity factura por licencia/cuota, no por token: `cost_per_1m` queda en
// `null` y el front lo renderiza como `—` (no se inventan precios). `label` es
// el nombre humano que devuelve `agy models`, tal cual.
function agyModel(id, label, extra) {
    return {
        id,
        label,
        capabilities: ['chat', 'tools', 'vision'],
        cost_per_1m: null,
        context_window: null,
        release_date: '2026-09',
        recommended_for: [],
        ...(extra || {}),
    };
}

const CATALOG = Object.freeze({
    anthropic: Object.freeze([
        {
            id: 'claude-opus-4-7',
            label: 'Claude Opus 4.7 (1M context)',
            capabilities: ['chat', 'tools', 'vision', 'reasoning', 'cache'],
            cost_per_1m: { input: 15.00, output: 75.00 },
            context_window: 1_000_000,
            release_date: '2026-04',
            recommended_for: ['guru', 'po', 'review', 'planner', 'security', 'qa'],
        },
        {
            id: 'claude-sonnet-4-6',
            label: 'Claude Sonnet 4.6',
            capabilities: ['chat', 'tools', 'vision', 'cache'],
            cost_per_1m: { input: 3.00, output: 15.00 },
            context_window: 200_000,
            release_date: '2026-02',
            recommended_for: ['backend-dev', 'android-dev', 'web-dev', 'pipeline-dev', 'ux', 'refinar'],
        },
        {
            id: 'claude-haiku-4',
            label: 'Claude Haiku 4',
            capabilities: ['chat', 'tools', 'cache'],
            cost_per_1m: { input: 0.25, output: 1.25 },
            context_window: 200_000,
            release_date: '2026-01',
            recommended_for: ['linter', 'delivery'],
        },
    ]),
    'openai-codex': Object.freeze([
        // 2026-06-04 — Codex con cuenta ChatGPT (OAuth) solo sirve sus propios
        // modelos. Catálogo real verificado en vivo: gpt-5.5 (frontier, strongest
        // agentic coding), gpt-5.4 (general/eval), gpt-5.4-mini (verificación).
        // Reemplaza los nombres viejos gpt-5-codex / gpt-5 (rechazados con 400).
        {
            id: 'gpt-5.5',
            label: 'GPT-5.5 (agentic coding)',
            capabilities: ['chat', 'tools', 'cache'],
            cost_per_1m: { input: 2.50, output: 10.00 },
            context_window: 256_000,
            release_date: '2026-06',
            recommended_for: ['backend-dev', 'pipeline-dev'],
        },
        {
            id: 'gpt-5.4',
            label: 'GPT-5.4 (general)',
            capabilities: ['chat', 'tools', 'vision', 'cache'],
            cost_per_1m: { input: 5.00, output: 20.00 },
            context_window: 256_000,
            release_date: '2026-06',
            recommended_for: ['guru', 'qa'],
        },
        {
            id: 'gpt-5.4-mini',
            label: 'GPT-5.4 mini (verificación)',
            capabilities: ['chat', 'tools', 'cache'],
            cost_per_1m: { input: 0.50, output: 2.00 },
            context_window: 256_000,
            release_date: '2026-06',
            recommended_for: ['telegram-sherlock'],
        },
    ]),
    // #6858 (2026-09-16) — Antigravity (`agy`, CLI 1.2.4). Catálogo medido con
    // `agy models`; los 14 ids son exactamente los que el CLI devuelve y se
    // cruzan contra él en lib/multi-provider/agy-catalog.js. `recommended_for`
    // refleja los skills que efectivamente lo declaran en agent-models.json.
    'gemini-google': Object.freeze([
        agyModel('gemini-3.8-flash-high', 'Gemini 3.8 Flash (High)', {
            capabilities: ['chat', 'tools', 'vision', 'reasoning'],
            recommended_for: ['android-dev', 'web-dev', 'architect'],
        }),
        agyModel('gemini-3.8-flash-medium', 'Gemini 3.8 Flash (Medium)', {
            recommended_for: ['qa', 'po', 'ux', 'perf', 'telegram-commander'],
        }),
        agyModel('gemini-3.8-flash-low', 'Gemini 3.8 Flash (Low)', {
            recommended_for: ['telegram-sherlock'],
        }),
        agyModel('gemini-3.7-flash-high', 'Gemini 3.7 Flash (High)', {
            capabilities: ['chat', 'tools', 'vision', 'reasoning'],
        }),
        // Modelo alternativo del provider (#3501): familia distinta al primario
        // para que Sherlock conserve adversarialidad parcial.
        agyModel('gemini-3.7-flash-medium', 'Gemini 3.7 Flash (Medium)', {
            recommended_for: ['telegram-sherlock'],
        }),
        agyModel('gemini-3.7-flash-low', 'Gemini 3.7 Flash (Low)'),
        agyModel('gemini-3.6-flash-high', 'Gemini 3.6 Flash (High)', {
            capabilities: ['chat', 'tools', 'vision', 'reasoning'],
        }),
        agyModel('gemini-3.6-flash-medium', 'Gemini 3.6 Flash (Medium)'),
        agyModel('gemini-3.6-flash-low', 'Gemini 3.6 Flash (Low)'),
        agyModel('gemini-3.1-pro-high', 'Gemini 3.1 Pro (High)', {
            capabilities: ['chat', 'tools', 'vision', 'reasoning'],
        }),
        agyModel('gemini-3.1-pro-low', 'Gemini 3.1 Pro (Low)'),
        // Modelos de terceros servidos por Antigravity bajo su licencia.
        agyModel('claude-sonnet-4-6', 'Claude Sonnet 4.6 (Thinking)', {
            capabilities: ['chat', 'tools', 'vision', 'reasoning'],
        }),
        agyModel('claude-opus-4-6-thinking', 'Claude Opus 4.6 (Thinking)', {
            capabilities: ['chat', 'tools', 'vision', 'reasoning'],
        }),
        agyModel('gpt-oss-120b-medium', 'GPT-OSS 120B (Medium)', {
            capabilities: ['chat', 'tools'],
        }),
    ]),
    deterministic: Object.freeze([
        {
            id: 'deterministic',
            label: 'Script Node (sin LLM)',
            capabilities: [],
            cost_per_1m: { input: 0, output: 0 },
            context_window: 0,
            release_date: null,
            recommended_for: ['build', 'tester', 'linter', 'delivery'],
        },
    ]),
});

function listModels({ provider } = {}) {
    if (provider) {
        return {
            version: CATALOG_VERSION,
            provider,
            models: (CATALOG[provider] || []).slice(),
        };
    }
    const out = {};
    for (const [p, list] of Object.entries(CATALOG)) {
        out[p] = list.slice();
    }
    return {
        version: CATALOG_VERSION,
        providers: Object.keys(CATALOG),
        catalog: out,
    };
}

function getModel(id) {
    for (const [provider, list] of Object.entries(CATALOG)) {
        const m = list.find(x => x.id === id);
        if (m) return { ...m, provider };
    }
    return null;
}

module.exports = {
    CATALOG_VERSION,
    CATALOG,
    listModels,
    getModel,
};

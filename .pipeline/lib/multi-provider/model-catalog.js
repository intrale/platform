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

const CATALOG_VERSION = '2026-05-14.1';

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
        {
            id: 'gpt-5-codex',
            label: 'GPT-5 Codex',
            capabilities: ['chat', 'tools', 'cache'],
            cost_per_1m: { input: 2.50, output: 10.00 },
            context_window: 256_000,
            release_date: '2026-03',
            recommended_for: ['backend-dev', 'pipeline-dev'],
        },
        {
            id: 'gpt-5',
            label: 'GPT-5 (general)',
            capabilities: ['chat', 'tools', 'vision', 'cache'],
            cost_per_1m: { input: 5.00, output: 20.00 },
            context_window: 256_000,
            release_date: '2026-03',
            recommended_for: ['guru', 'qa'],
        },
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

// =============================================================================
// commander-chain-gated-4565.test.js — #4565 (rebote rev-1)
//
// Test de integración del helper `isCommanderChainGated` (módulos REALES:
// dispatch-with-fallback + quota-exhausted + provider-disabled, leyendo flags
// de disco vía PIPELINE_DIR_OVERRIDE). Cierra el gap del rechazo de review:
//
//   El gate de cuota del pulpo pre-emptía con canned determinístico cuando
//   Anthropic estaba agotado, SIN considerar la cadena de fallback. Si había un
//   fallback sano (ej. Codex), el commander debía usarlo (CA-3), pero el gate
//   respondía canned antes de que `ejecutarClaude` pudiera hacerlo.
//
// `isCommanderChainGated` resuelve la MISMA cadena que `ejecutarClaude` y
// devuelve `true` SOLO cuando NO hay ningún provider sano. Read-only: silencia
// audit, notice a Telegram y logs.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const commanderMP = require('../lib/commander/multi-provider');

// agent-models.json mínimo: telegram-commander con primario anthropic y fallback
// openai-codex (auth_mode oauth → no requiere secretos, test determinístico).
function agentModels() {
    return {
        defaults: { model: 'claude-sonnet-4-6' },
        default_provider: 'anthropic',
        providers: {
            anthropic: { launcher: 'claude', model: 'claude-sonnet-4-6', auth_mode: 'oauth', credentials_env: ['ANTHROPIC_API_KEY'] },
            'openai-codex': { launcher: 'codex', model: 'gpt-5.5', auth_mode: 'oauth', credentials_env: ['OPENAI_API_KEY'] },
        },
        skills: {
            'telegram-commander': {
                provider: 'anthropic',
                model_override: 'claude-sonnet-4-6',
                fallbacks: [{ provider: 'openai-codex', model_override: 'gpt-5.5' }],
            },
        },
    };
}

function withTempPipeline(setupFiles, fn) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chain4565-'));
    const prev = process.env.PIPELINE_DIR_OVERRIDE;
    try {
        for (const [name, content] of Object.entries(setupFiles)) {
            fs.writeFileSync(path.join(tmp, name), content, 'utf8');
        }
        process.env.PIPELINE_DIR_OVERRIDE = tmp;
        return fn(tmp);
    } finally {
        if (prev === undefined) delete process.env.PIPELINE_DIR_OVERRIDE;
        else process.env.PIPELINE_DIR_OVERRIDE = prev;
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
}

// Flag de cuota REAL con schema post-#3077 (validateFlagShape exige
// resets_at/detected_at/pattern_matched como strings; provider opcional).
function quotaFlag(provider) {
    return JSON.stringify({
        exhausted: true,
        provider,
        resets_at: new Date(Date.now() + 3600_000).toISOString(),
        detected_at: new Date().toISOString(),
        pattern_matched: 'usage_limit_reached',
    });
}

test('#4565 rebote · Anthropic agotado + Codex sano → isCommanderChainGated=false (CA-3)', () => {
    withTempPipeline({
        'agent-models.json': JSON.stringify(agentModels()),
        // SOLO Anthropic agotado. El fallback Codex NO está en el flag (scope por
        // provider) → la cadena resuelve a Codex y NO está gateada. Este es
        // EXACTAMENTE el escenario del rechazo de review.
        'quota-exhausted.json': quotaFlag('anthropic'),
    }, (tmp) => {
        const gated = commanderMP.isCommanderChainGated({ pipelineDir: tmp });
        assert.equal(gated, false, 'hay fallback sano (Codex) → NO gatea, el commander debe usarlo');

        // Sanity: la resolución real efectivamente salta a Codex (mismo veredicto).
        const res = commanderMP.resolveCommanderProvider({ pipelineDir: tmp, log: () => {} });
        assert.equal(res.gated, false);
        assert.equal(res.provider, 'openai-codex', 'la cadena efectiva usa el fallback sano');
    });
});

test('#4565 rebote · Anthropic agotado + Codex apagado → isCommanderChainGated=true (canned)', () => {
    withTempPipeline({
        'agent-models.json': JSON.stringify(agentModels()),
        'quota-exhausted.json': quotaFlag('anthropic'),
        // El único fallback también fuera de servicio → NO hay provider sano.
        'provider-disabled.json': JSON.stringify({
            disabled: [{ name: 'openai-codex', disabled_at: new Date(0).toISOString() }],
        }),
    }, (tmp) => {
        const gated = commanderMP.isCommanderChainGated({ pipelineDir: tmp });
        assert.equal(gated, true, 'primario agotado + fallback apagado → cadena entera gateada');
    });
});

test('#4565 rebote · sin flags → isCommanderChainGated=false (happy path)', () => {
    withTempPipeline({
        'agent-models.json': JSON.stringify(agentModels()),
    }, (tmp) => {
        assert.equal(commanderMP.isCommanderChainGated({ pipelineDir: tmp }), false);
    });
});

test('#4565 rebote · Codex agotado (no Anthropic) → isCommanderChainGated=false', () => {
    withTempPipeline({
        'agent-models.json': JSON.stringify(agentModels()),
        // Se agotó Codex; el primario Anthropic sigue sano → NO gatea.
        'quota-exhausted.json': quotaFlag('openai-codex'),
    }, (tmp) => {
        assert.equal(commanderMP.isCommanderChainGated({ pipelineDir: tmp }), false);
    });
});

test('#4565 rebote · es READ-ONLY: no escribe audit ni notice en el pipeline dir', () => {
    withTempPipeline({
        'agent-models.json': JSON.stringify(agentModels()),
        'quota-exhausted.json': quotaFlag('anthropic'),
    }, (tmp) => {
        const before = fs.readdirSync(tmp).sort();
        // Varias invocaciones no deben acumular side-effects.
        commanderMP.isCommanderChainGated({ pipelineDir: tmp });
        commanderMP.isCommanderChainGated({ pipelineDir: tmp });
        const after = fs.readdirSync(tmp).sort();
        assert.deepEqual(after, before, 'no crea archivos nuevos (audit/notice silenciados)');
    });
});

test('#4565 rebote · fail-open: dispatchModule que lanza → false (no pre-emptir)', () => {
    // Inyectamos un dispatch que revienta: nunca queremos bloquear al commander
    // por un bug del resolver. Fail-open = false.
    const boom = {
        resolveSpawnWithFallback() { throw new Error('dispatch boom'); },
    };
    const gated = commanderMP.isCommanderChainGated({ pipelineDir: '/tmp/nope', dispatchModule: boom });
    assert.equal(gated, false, 'fail-open ante error del dispatch');
});

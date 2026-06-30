// =============================================================================
// commander-preflight-fallback.test.js — #4313
//
// Test de integración del WIRING del Commander: `resolveCommanderProvider`
// (módulo real, sin inyectar `disabledModule`) + flag-file `provider-disabled.json`
// REAL en disco. Cierra la brecha test↔producción: en producción el Commander
// NO inyecta el módulo de disabled, usa el real, que lee desde PIPELINE_DIR_OVERRIDE
// (o `__dirname/..`). Acá ejercemos exactamente ese camino.
//
// Cubre:
//   - CA-1: anthropic deshabilitado de entrada + codex habilitado → resuelve codex.
//   - CA-2: `disqualifyReason === 'primary_disabled_preflight'` y la traza del
//     turno (`_trace.resolution`, replicada como en pulpo.js) lleva
//     `reason: 'primary_disabled_preflight'` y `crossProvider: true`.
//   - CA-3: todos los providers del orden deshabilitados → `gated: true`
//     (el Commander responde canned, no cuelga).
//   - CA-4: anthropic habilitado → resuelve anthropic, sin salto, sin motivo.
//
// El motivo es un literal/enum ESTÁTICO (SEC-1): la traza solo lleva strings no
// sensibles (SEC-3), nunca config/credenciales/contenido del flag-file.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const commanderMP = require('../lib/commander/multi-provider');

// agent-models.json mínimo con telegram-commander → openai-codex como primer
// fallback. openai-codex es `auth_mode: 'oauth'` → no requiere key en el env,
// el test es determinístico sin secretos.
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

// Replica EXACTA de la construcción de `_trace.resolution` en pulpo.js (#4313).
// Mantener en sync: si cambia el shape en pulpo, este helper debe reflejarlo.
function buildTraceResolution(resolution) {
    return {
        provider: resolution.provider || 'anthropic',
        crossProvider: resolution.crossProvider === true,
        fallbackUsed: resolution.fallbackUsed != null ? String(resolution.fallbackUsed) : null,
        primaryProvider: resolution.primaryProvider || 'anthropic',
        reason: resolution.disqualifyReason != null ? String(resolution.disqualifyReason) : null,
    };
}

function withTempPipeline(setupFiles, fn) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd4313-'));
    const prev = process.env.PIPELINE_DIR_OVERRIDE;
    try {
        for (const [name, content] of Object.entries(setupFiles)) {
            fs.writeFileSync(path.join(tmp, name), content, 'utf8');
        }
        process.env.PIPELINE_DIR_OVERRIDE = tmp; // módulo provider-disabled real lee de acá
        return fn(tmp);
    } finally {
        if (prev === undefined) delete process.env.PIPELINE_DIR_OVERRIDE;
        else process.env.PIPELINE_DIR_OVERRIDE = prev;
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
}

test('#4313 · CA-1/CA-2 · anthropic deshabilitado preflight (flag real) → codex + reason en traza', () => {
    withTempPipeline({
        'agent-models.json': JSON.stringify(agentModels()),
        'provider-disabled.json': JSON.stringify({
            disabled: [{ name: 'anthropic', disabled_at: new Date(0).toISOString() }],
        }),
    }, (tmp) => {
        // Módulo REAL (no inyectamos disabledModule) — path de producción.
        const resolution = commanderMP.resolveCommanderProvider({
            pipelineDir: tmp,
            log: () => {},
        });

        assert.equal(resolution.gated, false, 'no gated: hay fallback resoluble');
        assert.equal(resolution.crossProvider, true, 'salta cross-provider de entrada');
        assert.equal(resolution.provider, 'openai-codex', 'usa el siguiente del orden');
        assert.equal(resolution.disqualifyReason, 'primary_disabled_preflight');

        const trace = buildTraceResolution(resolution);
        assert.equal(trace.reason, 'primary_disabled_preflight', 'traza con motivo del salto pre-turno');
        assert.equal(trace.crossProvider, true);
        assert.equal(trace.provider, 'openai-codex');
        // SEC-3 — la traza solo lleva strings/booleans no sensibles.
        for (const v of Object.values(trace)) {
            assert.ok(v === null || typeof v === 'string' || typeof v === 'boolean',
                'la traza no expone objetos/handler/config');
        }
    });
});

test('#4313 · CA-3 · todos los providers del orden deshabilitados → gated (canned, no cuelga)', () => {
    withTempPipeline({
        'agent-models.json': JSON.stringify(agentModels()),
        'provider-disabled.json': JSON.stringify({
            disabled: [
                { name: 'anthropic', disabled_at: new Date(0).toISOString() },
                { name: 'openai-codex', disabled_at: new Date(0).toISOString() },
            ],
        }),
    }, (tmp) => {
        const resolution = commanderMP.resolveCommanderProvider({
            pipelineDir: tmp,
            log: () => {},
        });

        assert.equal(resolution.gated, true, 'chain agotada → gated');
        assert.equal(resolution.source, 'all-gated');
        // El Commander responde canned (no spawnea, no cuelga al timeout duro).
        const canned = commanderMP.cannedAllGatedResponse(resolution);
        assert.equal(typeof canned, 'string');
        assert.ok(canned.length > 0, 'mensaje canned no vacío');
    });
});

test('#4313 · CA-4 · anthropic habilitado → resuelve anthropic sin salto ni motivo (sin regresión)', () => {
    withTempPipeline({
        'agent-models.json': JSON.stringify(agentModels()),
        // sin provider-disabled.json → ningún provider apagado
    }, (tmp) => {
        const resolution = commanderMP.resolveCommanderProvider({
            pipelineDir: tmp,
            log: () => {},
        });

        assert.equal(resolution.provider, 'anthropic');
        assert.equal(resolution.crossProvider, false);
        const trace = buildTraceResolution(resolution);
        assert.equal(trace.reason, null, 'sin motivo de salto en happy path');
    });
});

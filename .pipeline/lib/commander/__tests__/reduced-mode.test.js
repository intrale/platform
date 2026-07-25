// =============================================================================
// reduced-mode.test.js — #4870 (modo reducido)
//
// Tests de integración del "modo reducido" del Commander (módulos REALES:
// dispatch-with-fallback + quota-exhausted + provider-disabled, leyendo flags de
// disco vía PIPELINE_DIR_OVERRIDE). Verifica:
//
//   1. TODOS los pagos gateados + free sano → isReducedMode === true (CA-1).
//   2. Al menos un pago sano → isReducedMode === false (CA-4).
//   3. Chain enteramente gateada (gated:true) → isReducedMode === false (CA-5:
//      es all-gated, NO reduced).
//   4. cannedReducedModeResponse explicita "modo reducido" + "sin ejecución de
//      acciones" y NO filtra secrets/modelos (CA-3).
//   5. shouldRespondReducedMode con enabled:false → false (CA-7: regresión cero).
//
// Modo reducido = pagos (billing:'paid' → Anthropic, Codex) todos gateados por
// cuota PERO queda un free (billing:'free' → Cerebras) sano como candidato. En
// ese estado el Commander responde advisory y NO spawnea el free (PO D1).
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const commanderMP = require('../../commander/multi-provider');

// agent-models.json mínimo: telegram-commander con primario anthropic (paid),
// fallback openai-codex (paid) y cerebras (free). auth_mode oauth/api_key sin
// secretos requeridos en el test → determinístico. La CLAVE del issue es el
// campo `billing` por provider (fuente de verdad de "¿hay pago?").
function agentModels() {
    return {
        default_provider: 'anthropic',
        providers: {
            anthropic: {
                launcher: 'claude', model: 'claude-sonnet-4-6', auth_mode: 'oauth',
                credentials_env: ['ANTHROPIC_API_KEY'], billing: 'paid',
            },
            'openai-codex': {
                launcher: 'codex', model: 'gpt-5.5', auth_mode: 'oauth',
                credentials_env: ['OPENAI_API_KEY'], billing: 'paid',
            },
            cerebras: {
                launcher: 'cerebras', model: 'gpt-oss-120b',
                credentials_env: [], billing: 'free',
            },
        },
        skills: {
            'telegram-commander': {
                provider: 'anthropic',
                model_override: 'claude-sonnet-4-6',
                fallbacks: [
                    { provider: 'openai-codex', model_override: 'gpt-5.5' },
                    { provider: 'cerebras', model_override: 'gpt-oss-120b' },
                ],
            },
        },
    };
}

function withTempPipeline(setupFiles, fn) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reduced4870-'));
    const prev = process.env.PIPELINE_DIR_OVERRIDE;
    const prevReconcile = process.env.QUOTA_RECONCILE_DISABLED;
    const prevCodexSessionsDir = process.env.CODEX_SESSIONS_DIR;
    try {
        for (const [name, content] of Object.entries(setupFiles)) {
            fs.writeFileSync(path.join(tmp, name), content, 'utf8');
        }
        process.env.PIPELINE_DIR_OVERRIDE = tmp;
        // El fixture define toda la cadena de cuota. Evita que sesiones Codex
        // del host invaliden esos flags sintéticos y escriban logs de auditoría.
        // Doble aislamiento complementario: `CODEX_SESSIONS_DIR` (#4899) apunta
        // la lectura de rollouts JSONL a un directorio del fixture, y
        // `QUOTA_RECONCILE_DISABLED` (#4900) desactiva el veto de reconciliación
        // en `quota-exhausted.js`. Cubren capas distintas de la cadena de cuota.
        process.env.QUOTA_RECONCILE_DISABLED = '1';
        process.env.CODEX_SESSIONS_DIR = path.join(tmp, 'codex-sessions');
        return fn(tmp);
    } finally {
        if (prev === undefined) delete process.env.PIPELINE_DIR_OVERRIDE;
        else process.env.PIPELINE_DIR_OVERRIDE = prev;
        if (prevReconcile === undefined) delete process.env.QUOTA_RECONCILE_DISABLED;
        else process.env.QUOTA_RECONCILE_DISABLED = prevReconcile;
        if (prevCodexSessionsDir === undefined) delete process.env.CODEX_SESSIONS_DIR;
        else process.env.CODEX_SESSIONS_DIR = prevCodexSessionsDir;
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
}

test('#4899 · withTempPipeline restaura CODEX_SESSIONS_DIR ante una excepción', () => {
    const previous = process.env.CODEX_SESSIONS_DIR;
    assert.throws(() => withTempPipeline({}, () => {
        assert.notEqual(process.env.CODEX_SESSIONS_DIR, previous);
        throw new Error('fixture-error');
    }), /fixture-error/);
    assert.equal(process.env.CODEX_SESSIONS_DIR, previous);
});

// Flag de cuota REAL con schema por-proveedor (post-#4731): mapa `providers` con
// un slot exhausted por cada provider pasado. Espejo top-level al slot primario
// para backward-compat con lectores legacy.
function quotaFlagMulti(providers) {
    const resets = new Date(Date.now() + 3600_000).toISOString();
    const detected = new Date().toISOString();
    const slot = () => ({
        exhausted: true, resets_at: resets, detected_at: detected,
        pattern_matched: 'usage_limit_reached',
    });
    const map = {};
    for (const p of providers) map[p] = slot();
    const primary = providers[0];
    return JSON.stringify({
        exhausted: true,
        provider: primary,
        resets_at: resets,
        detected_at: detected,
        pattern_matched: 'usage_limit_reached',
        providers: map,
    });
}

// -----------------------------------------------------------------------------
// CA-1 — todos los pagos gateados + free sano → isReducedMode === true.
// -----------------------------------------------------------------------------
test('#4870 CA-1 · Anthropic + Codex gateados + Cerebras (free) sano → isReducedMode=true', () => {
    withTempPipeline({
        'agent-models.json': JSON.stringify(agentModels()),
        // Ambos PAGOS agotados; el free (cerebras) NO está en el flag → la cadena
        // resuelve a cerebras y NO está gateada, pero es free ⇒ modo reducido.
        'quota-exhausted.json': quotaFlagMulti(['anthropic', 'openai-codex']),
    }, (tmp) => {
        assert.equal(commanderMP.isReducedMode({ pipelineDir: tmp }), true);

        // Sanity: la resolución real salta al free sano con billing 'free'.
        const res = commanderMP.resolveCommanderProvider({ pipelineDir: tmp, log: () => {} });
        assert.equal(res.gated, false);
        assert.equal(res.provider, 'cerebras', 'la cadena efectiva usa el free sano');
        assert.equal(res.providerBilling, 'free', 'el candidato resuelto es free');
    });
});

// -----------------------------------------------------------------------------
// CA-4 — al menos un pago sano → NO es modo reducido (sale solo al recuperar pago).
// -----------------------------------------------------------------------------
test('#4870 CA-4 · sólo Anthropic gateado, Codex (paid) sano → isReducedMode=false', () => {
    withTempPipeline({
        'agent-models.json': JSON.stringify(agentModels()),
        'quota-exhausted.json': quotaFlagMulti(['anthropic']),
    }, (tmp) => {
        assert.equal(commanderMP.isReducedMode({ pipelineDir: tmp }), false,
            'queda Codex (pago) sano → ejecuta normal, NO modo reducido');
        const res = commanderMP.resolveCommanderProvider({ pipelineDir: tmp, log: () => {} });
        assert.equal(res.provider, 'openai-codex');
        assert.equal(res.providerBilling, 'paid');
    });
});

test('#4870 CA-4 · sin flags (primario Anthropic pago sano) → isReducedMode=false', () => {
    withTempPipeline({
        'agent-models.json': JSON.stringify(agentModels()),
    }, (tmp) => {
        assert.equal(commanderMP.isReducedMode({ pipelineDir: tmp }), false);
    });
});

// -----------------------------------------------------------------------------
// CA-5 — chain enteramente gateada (ni pagos ni frees) → gated:true → NO reduced.
// -----------------------------------------------------------------------------
test('#4870 CA-5 · Anthropic + Codex + Cerebras TODOS gateados → gated:true → isReducedMode=false', () => {
    withTempPipeline({
        'agent-models.json': JSON.stringify(agentModels()),
        'quota-exhausted.json': quotaFlagMulti(['anthropic', 'openai-codex', 'cerebras']),
    }, (tmp) => {
        // La cadena entera gateada NO es modo reducido (es "todos caídos").
        assert.equal(commanderMP.isReducedMode({ pipelineDir: tmp }), false);
        const res = commanderMP.resolveCommanderProvider({ pipelineDir: tmp, log: () => {} });
        assert.equal(res.gated, true, 'sanity: la cadena reporta all-gated');
    });
});

// -----------------------------------------------------------------------------
// CA-3 — copy del canned advisory: frases literales + sin secrets/modelos.
// -----------------------------------------------------------------------------
test('#4870 CA-3 · cannedReducedModeResponse explicita "modo reducido" + "sin ejecución de acciones"', () => {
    const text = commanderMP.cannedReducedModeResponse({ downProviders: ['anthropic', 'openai-codex'] });
    assert.match(text, /modo reducido/, 'explicita el estado');
    assert.match(text, /sin ejecución de acciones/, 'explicita la consecuencia');
    // Nombra los pagos caídos en lenguaje de operador (sin nombres de modelos).
    assert.match(text, /Anthropic/);
    assert.match(text, /Codex/);
    // Cierra con la salida automática (CA-4).
    assert.match(text, /recupere un proveedor pago/);
});

test('#4870 CA-3 · el canned NO filtra secrets, nombres de modelo, ni jerga interna', () => {
    const text = commanderMP.cannedReducedModeResponse({ downProviders: ['anthropic', 'openai-codex'] });
    // Sin nombres de modelos ni secrets ni términos internos.
    assert.doesNotMatch(text, /claude-|gpt-|gpt-oss|deepseek|zai-glm/i, 'sin nombres de modelo');
    assert.doesNotMatch(text, /API_KEY|CEREBRAS|NVIDIA_NIM|Bearer|sk-/i, 'sin secrets/credenciales');
    assert.doesNotMatch(text, /\bgated\b|providerBilling|\bchain\b/i, 'sin jerga interna');
});

test('#4870 CA-3 · downProviders vacío/desconocido → copy genérico sin nombres crudos', () => {
    const empty = commanderMP.cannedReducedModeResponse({});
    assert.match(empty, /los proveedores pagos/, 'cae al genérico');
    // Un nombre desconocido nunca se interpola crudo.
    const unknown = commanderMP.cannedReducedModeResponse({ downProviders: ['some-internal-x'] });
    assert.doesNotMatch(unknown, /some-internal-x/);
    assert.match(unknown, /los proveedores pagos/);
});

// -----------------------------------------------------------------------------
// CA-7 — rollout gate: enabled:false (default) → flujo idéntico (regresión cero).
// -----------------------------------------------------------------------------
test('#4870 CA-7 · shouldRespondReducedMode con enabled:false → false aunque haya reduced mode', () => {
    withTempPipeline({
        'agent-models.json': JSON.stringify(agentModels()),
        'quota-exhausted.json': quotaFlagMulti(['anthropic', 'openai-codex']),
    }, (tmp) => {
        // El estado de cuota ES modo reducido, pero el rollout OFF lo desactiva.
        assert.equal(commanderMP.isReducedMode({ pipelineDir: tmp }), true, 'precondición: hay reduced mode');
        assert.equal(
            commanderMP.shouldRespondReducedMode({ config: { enabled: false }, pipelineDir: tmp }),
            false,
            'enabled:false ⇒ flujo idéntico al actual (regresión cero)');
        // Config ausente → también OFF.
        assert.equal(commanderMP.shouldRespondReducedMode({ config: undefined, pipelineDir: tmp }), false);
    });
});

test('#4870 CA-7 · kill_switch:true anula enabled:true (corte de emergencia)', () => {
    withTempPipeline({
        'agent-models.json': JSON.stringify(agentModels()),
        'quota-exhausted.json': quotaFlagMulti(['anthropic', 'openai-codex']),
    }, (tmp) => {
        assert.equal(
            commanderMP.shouldRespondReducedMode({ config: { enabled: true, kill_switch: true }, pipelineDir: tmp }),
            false,
            'kill_switch corta sin tocar enabled');
        // enabled:true sin kill → sí dispara (hay reduced mode).
        assert.equal(
            commanderMP.shouldRespondReducedMode({ config: { enabled: true }, pipelineDir: tmp }),
            true);
    });
});

// -----------------------------------------------------------------------------
// Robustez — READ-ONLY (sin side-effects) + fail-open ante error del dispatch.
// -----------------------------------------------------------------------------
test('#4870 robustez · isReducedMode es READ-ONLY (no crea archivos)', () => {
    withTempPipeline({
        'agent-models.json': JSON.stringify(agentModels()),
        'quota-exhausted.json': quotaFlagMulti(['anthropic', 'openai-codex']),
    }, (tmp) => {
        const before = fs.readdirSync(tmp).sort();
        commanderMP.isReducedMode({ pipelineDir: tmp });
        commanderMP.isReducedMode({ pipelineDir: tmp });
        const after = fs.readdirSync(tmp).sort();
        assert.deepEqual(after, before, 'audit/notice/logs silenciados → sin archivos nuevos');
    });
});

test('#4870 robustez · fail-open: dispatchModule que lanza → isReducedMode=false', () => {
    const boom = { resolveSpawnWithFallback() { throw new Error('dispatch boom'); } };
    assert.equal(
        commanderMP.isReducedMode({ pipelineDir: '/tmp/nope', dispatchModule: boom }),
        false,
        'fail-open: nunca advisory-lock por un bug del resolver');
});

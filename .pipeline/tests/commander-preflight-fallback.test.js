// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

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

// =============================================================================
// #5456 · CA-4 — RECUPERACIÓN DEL CANAL: con el flag canónico de #5455 vigente,
// el turno SIGUIENTE tiene que salir por Codex.
//
// Este es el cierre del incidente 2026-08-02: el turno se perdía por cuota
// semanal, el flag no se persistía y el turno siguiente volvía a elegir
// Anthropic — el Commander quedaba mudo en loop. Acá se ejerce el camino de
// producción COMPLETO y con estado REAL en disco:
//
//   setFlag (API canónica de #5455)  →  quota-exhausted.json real
//     →  shouldGateSpawn (GET, con el bypass del veto de #4865)
//       →  resolveCommanderProvider (módulo real, sin quotaModule inyectado)
//         →  openai-codex
//
// NO se escribe el JSON a mano ni se inyecta un fake de cuota: el objetivo es
// exactamente detectar una divergencia entre lo que el SET persiste y lo que el
// GET interpreta. Tampoco se agrega selector ni estado paralelo — el ruteo sale
// del mismo gate pre-spawn que ya usaba el pipeline.
// =============================================================================

const quotaExhausted = require('../lib/quota-exhausted');
const { seedPipelineConfig } = require('../lib/__tests__/_test-helpers');

// Texto real del incidente. Va como `rawExcerpt` (pasa por redacción central).
const AVISO_SEMANAL_5456 = "You've hit your weekly limit · resets 9pm (America/Buenos_Aires)";

function persistirCuotaSemanalCanonica(now) {
    // Persistencia por la API canónica. `errorType` sale de la constante
    // exportada por #5455 — si el contrato cambia de nombre, este test rompe.
    return quotaExhausted.setFlag({
        errorType: quotaExhausted.WEEKLY_LIMIT_CONTENT_ERROR_TYPE,
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        resetsAt: new Date(now + 30 * 60 * 1000).toISOString(),
        agent: 'commander',
        rawExcerpt: AVISO_SEMANAL_5456,
        auditLogEnabled: false,
    });
}

test('#5456 · CA-4 · con el flag canónico de cuota semanal vigente, el turno siguiente resuelve openai-codex', () => {
    withTempPipeline({
        'agent-models.json': JSON.stringify(agentModels()),
        // sin provider-disabled.json: el salto lo tiene que producir la CUOTA,
        // no el kill-switch operacional. Si el gate no funcionara, la resolución
        // volvería a anthropic y el test falla (que es el bug del incidente).
    }, (tmp) => {
        seedPipelineConfig(tmp);
        const now = Date.now();
        persistirCuotaSemanalCanonica(now);

        // El estado quedó en el archivo canónico, con el subtipo exacto.
        const flag = JSON.parse(fs.readFileSync(path.join(tmp, 'quota-exhausted.json'), 'utf8'));
        assert.equal(flag.exhausted, true, 'el flag se persistió como activo');
        const slot = (flag.providers || {})['anthropic'];
        assert.ok(slot, 'debe existir el slot por-proveedor de anthropic (#4731)');
        assert.equal(slot.pattern_matched, quotaExhausted.WEEKLY_LIMIT_CONTENT_ERROR_TYPE,
            'el slot conserva el subtipo tipado de #5455');

        // GET: el gate pre-spawn honra el subtipo (bypass del veto de #4865).
        assert.equal(
            quotaExhausted.shouldGateSpawn('telegram-commander', { provider: 'anthropic' }),
            true,
            'anthropic debe quedar gateado para el turno siguiente',
        );
        // Scope por proveedor: el fallback NO se gatea de arrastre (#3077 CA-7).
        assert.equal(
            quotaExhausted.shouldGateSpawn('telegram-commander', { provider: 'openai-codex' }),
            false,
            'el gate de anthropic no puede arrastrar a codex',
        );

        // Turno siguiente: módulo REAL, sin quotaModule inyectado.
        const resolution = commanderMP.resolveCommanderProvider({
            pipelineDir: tmp,
            log: () => {},
        });

        assert.equal(resolution.gated, false, 'hay fallback resoluble: el canal no se cae');
        assert.equal(resolution.provider, 'openai-codex', 'el turno siguiente sale por Codex');
        assert.equal(resolution.crossProvider, true, 'salto cross-provider pre-spawn');

        // La traza del turno no filtra nada del payload ni del subtipo (CA-1).
        const trace = buildTraceResolution(resolution);
        assert.equal(trace.provider, 'openai-codex');
        const traceStr = JSON.stringify(trace);
        assert.ok(!traceStr.includes(quotaExhausted.WEEKLY_LIMIT_CONTENT_ERROR_TYPE),
            'la traza del turno no puede llevar el errorType tipado');
        assert.ok(!traceStr.includes('weekly limit'), 'la traza no puede llevar el crudo');
    });
});

test('#5456 · control negativo · SIN flag de cuota el turno sigue saliendo por Anthropic', () => {
    withTempPipeline({
        'agent-models.json': JSON.stringify(agentModels()),
    }, (tmp) => {
        seedPipelineConfig(tmp);
        // Precondición explícita: no hay estado de cuota en el sandbox.
        assert.equal(fs.existsSync(path.join(tmp, 'quota-exhausted.json')), false);

        const resolution = commanderMP.resolveCommanderProvider({
            pipelineDir: tmp,
            log: () => {},
        });

        assert.equal(resolution.provider, 'anthropic',
            'sin cuota agotada NO se desvía el turno (no hay ruteo espurio)');
        assert.equal(resolution.crossProvider, false);
    });
});

// =============================================================================
// #7371 · CA-12 / CA-13 — canned del Commander: la causa real por eslabón y un
// encabezado que no la contradiga.
//
// Incidente 2026-09-19: Anthropic en reposo, Codex con cuota semanal real al 93%
// y Antigravity gateado por versión del CLI → el Commander respondía "sin
// credenciales o desactivados, no por falta de cuota", falso en las dos
// direcciones. Ahora el encabezado se deriva del CONJUNTO de causas y la línea
// por eslabón usa `provider-pause-cause.ACTION_SHORT[health_reason]` (tabla
// cerrada; REQ-SEC-G). Deps de disco inyectadas: sin cuota ni schedule reales.
// =============================================================================
const _7371_DEPS = Object.freeze({
    now: Date.UTC(2026, 8, 19, 10, 0, 0),
    quotaModule: { readDefensive: () => ({ exhausted: false }), canonicalProvider: (p) => p },
    restStatusFor: () => ({ resting: false }),
});

test('#7371 · CA-13 (a) · cadena gateada por health → sin "credenciales", causa real por eslabón', () => {
    const canned = commanderMP.cannedAllGatedResponse({
        reason: 'all_gated',
        chainTried: ['anthropic', 'openai-codex', 'antigravity'],
        skipReasons: [
            { provider: 'anthropic', reason: 'provider_inactive_by_schedule', details: null },
            { provider: 'openai-codex', reason: 'health_gate', details: 'health=red fresco (quota_exhausted_real)', health_reason: 'quota_exhausted_real' },
            { provider: 'antigravity', reason: 'health_gate', details: 'health=red fresco (cli_contract_mismatch)', health_reason: 'cli_contract_mismatch' },
        ],
    }, _7371_DEPS);
    assert.doesNotMatch(canned, /credenciales/);
    assert.doesNotMatch(canned, /no por falta de cuota/);
    assert.match(canned, /abajo va la causa de cada uno/);
    assert.match(canned, /Codex con la cuota agotada/);
    assert.match(canned, /Antigravity con el CLI en una versión no probada/);
    assert.match(canned, /Claude en reposo/);
    assert.match(canned, /\/status, \/listado, \/lanzar/);
    // El `details` crudo del dispatcher nunca se interpola.
    assert.doesNotMatch(canned, /health=red fresco/);
});

test('#7371 · CA-13 (b) · con permission_matrix presente sigue diciendo "sin credenciales o desactivados"', () => {
    const canned = commanderMP.cannedAllGatedResponse({
        reason: 'all_gated',
        skipReasons: [
            { provider: 'openai-codex', reason: 'permission_matrix', details: 'no_key_configured' },
            { provider: 'antigravity', reason: 'health_gate', details: null, health_reason: 'cli_contract_mismatch' },
        ],
    }, _7371_DEPS);
    assert.match(canned, /sin credenciales o desactivados/);
    const disabled = commanderMP.cannedAllGatedResponse({
        reason: 'all_gated',
        skipReasons: [{ provider: 'anthropic', reason: 'provider_disabled', details: null }],
    }, _7371_DEPS);
    assert.match(disabled, /sin credenciales o desactivados/);
});

test('#7371 · CA-12 (c) · health_reason desconocido → "caído temporalmente" (fail-closed a copy aprobado)', () => {
    const line = commanderMP.describeGatedChain({
        skipReasons: [{ provider: 'antigravity', reason: 'health_gate', details: 'health=red fresco (zzz)', health_reason: 'zzz' }],
    }, _7371_DEPS);
    assert.equal(line, 'Antigravity caído temporalmente');
    // Sin `health_reason` (skips viejos) → mismo copy genérico, sin romper.
    const legacy = commanderMP.describeGatedChain({
        skipReasons: [{ provider: 'antigravity', reason: 'health_gate', details: 'health=red fresco (cli_contract_mismatch)' }],
    }, _7371_DEPS);
    assert.equal(legacy, 'Antigravity caído temporalmente');
    // `health_reason` no-string no se lee.
    const bogus = commanderMP.describeGatedChain({
        skipReasons: [{ provider: 'antigravity', reason: 'health_gate', health_reason: { toString: () => 'cli_contract_mismatch' } }],
    }, _7371_DEPS);
    assert.equal(bogus, 'Antigravity caído temporalmente');
});

test('#7371 · CA-13 · todas las causas de cuota (reason o health_reason) → encabezado histórico "sin cuota disponible"', () => {
    const canned = commanderMP.cannedAllGatedResponse({
        reason: 'all_gated',
        chainTried: ['anthropic', 'openai-codex', 'antigravity'],
        skipReasons: [
            { provider: 'anthropic', reason: 'quota_exhausted', details: null },
            { provider: 'openai-codex', reason: 'health_gate', details: null, health_reason: 'quota_exhausted_real' },
            { provider: 'antigravity', reason: 'health_gate', details: null, health_reason: 'quota_flag_active' },
        ],
    }, _7371_DEPS);
    assert.match(canned.split('\n')[0], /sin cuota disponible/);
    assert.doesNotMatch(canned, /credenciales/);
});

test('#7371 · redactSkipReasons preserva health_reason (enum) y sigue redactando details', () => {
    const out = commanderMP.redactSkipReasons([
        { provider: 'antigravity', reason: 'health_gate', details: 'x', health_reason: 'cli_contract_mismatch' },
        { provider: 'anthropic', reason: 'quota_exhausted', details: null },
    ]);
    assert.equal(out[0].health_reason, 'cli_contract_mismatch');
    assert.equal('health_reason' in out[1], false);
});

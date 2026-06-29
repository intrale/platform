// =============================================================================
// Tests `activeAgents` — provider EFECTIVO sobre el configurado (#4284)
//
// Cubre los CA verificables del slice:
//   - CA-1/CA-2: con marker efectivo (Anthropic apagado → openai-codex), la card
//     muestra id "openai-codex" + label "Codex", NO el configurado por skill.
//   - CA-3: sin marker (TTL vencido / no escrito), cae al provider CONFIGURADO
//     manteniendo el shape `{ id, label, model }` (happy path intacto).
//   - CA-8: el label sale de PROVIDER_LABELS (naming canónico).
//
// El marker se aísla monkeypatcheando `readRunningProviders` sobre la instancia
// cacheada de `running-providers` que captura el slice — jamás toca el archivo
// real del repo.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const runningProviders = require('../running-providers');
const slices = require('../dashboard-slices');

// El slice llama `runningProviders.readRunningProviders()` sin args en runtime;
// sobreescribimos el método sobre la instancia cacheada para inyectar markers.
const realReadMarkers = runningProviders.readRunningProviders;
function setMarkers(map) {
    runningProviders.readRunningProviders = () => map;
}
function restoreMarkers() {
    runningProviders.readRunningProviders = realReadMarkers;
}

// Estado con un agente pipeline-dev en `trabajando/`. El skill configurado en
// agent-models.json es 'anthropic' (default), así que sin marker debe mostrar
// Claude; con marker openai-codex debe mostrar Codex.
function stateWithAgent() {
    return {
        issueMatrix: {
            '4284': {
                title: 'Provider efectivo',
                estadoActual: 'trabajando',
                faseActual: 'desarrollo/dev',
                fases: {
                    'desarrollo/dev': [
                        { skill: 'pipeline-dev', pipeline: 'desarrollo', fase: 'dev', estado: 'trabajando', durationMs: 60000 },
                    ],
                },
            },
        },
        etaAverages: {},
    };
}

test('CA-1/CA-2: marker efectivo (openai-codex) tiene prioridad sobre el configurado', () => {
    setMarkers({
        'desarrollo/dev/pipeline-dev:4284': {
            provider: 'openai-codex', model: 'gpt-5-codex', source: 'fallback', startedAt: Date.now(), durationMs: 1000,
        },
    });
    try {
        const out = slices.activeAgents(stateWithAgent());
        const agent = out.find(a => a.issue === '4284');
        assert.ok(agent, 'el agente debe estar');
        assert.ok(agent.provider, 'debe tener provider');
        assert.equal(agent.provider.id, 'openai-codex', 'id efectivo, no el configurado');
        assert.equal(agent.provider.label, 'Codex', 'label canónico de PROVIDER_LABELS (CA-8)');
        assert.equal(agent.provider.model, 'gpt-5-codex', 'modelo efectivo del marker');
    } finally {
        restoreMarkers();
    }
});

test('CA-3: sin marker, cae al provider configurado (happy path, shape intacto)', () => {
    setMarkers({}); // ningún marker para este agente
    try {
        const out = slices.activeAgents(stateWithAgent());
        const agent = out.find(a => a.issue === '4284');
        assert.ok(agent);
        assert.ok(agent.provider, 'debe resolver el provider configurado');
        // Shape `{ id, label, model }` presente.
        assert.ok('id' in agent.provider && 'label' in agent.provider && 'model' in agent.provider);
        // El configurado por skill no debe ser openai-codex (no hay fallback).
        assert.notEqual(agent.provider.id, 'openai-codex');
    } finally {
        restoreMarkers();
    }
});

test('CA-3: marker de OTRO agente no contamina a éste (match por clave exacta)', () => {
    setMarkers({
        'desarrollo/dev/otro-skill:9999': {
            provider: 'cerebras', model: null, source: 'fallback', startedAt: Date.now(), durationMs: 1000,
        },
    });
    try {
        const out = slices.activeAgents(stateWithAgent());
        const agent = out.find(a => a.issue === '4284');
        assert.ok(agent);
        // No debe tomar el provider del marker ajeno.
        assert.notEqual(agent.provider && agent.provider.id, 'cerebras');
    } finally {
        restoreMarkers();
    }
});

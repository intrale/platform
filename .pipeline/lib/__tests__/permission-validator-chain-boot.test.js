// =============================================================================
// permission-validator-chain-boot.test.js — #4274
//
// Validación chain-aware al boot (CA-4 / SR-3) + invariantes de least-privilege
// (CA-6 / SR-2) y techo de privilegios (CA-7 / SR-4) de la matriz canónica.
//
// Antes, `validateAllSkillsAtBoot` solo validaba el provider PRIMARIO de cada
// skill — una combinación inválida (provider de fallback × modo) era invisible
// al boot y recién explotaba en runtime (incidente 23:20 ART del 28/06). Ahora,
// pasando `resolveSkillChain(skill) → [{provider, mode}, …]`, se valida cada
// eslabón de la cadena (primario + fallbacks).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const pv = require('../permission-validator');

const DEV_REQUIRED = ['file_read', 'file_write_repo', 'bash', 'child_spawn', 'tool_use_gated'];

// ---------------------------------------------------------------------------
// CA-4 / SR-3 — chain-aware boot
// ---------------------------------------------------------------------------

test('#4274 CA-4 · boot chain-aware detecta un fallback con (provider × modo) sin celda en la matriz', () => {
    const registry = { 'pipeline-dev': { required_permissions: DEV_REQUIRED } };
    // Primario válido (anthropic/bypassPermissions) pero un fallback inválido:
    // openai-codex con modo 'bypassPermissions' NO tiene celda → debe detectarse.
    const resolveSkillChain = () => ([
        { provider: 'anthropic', mode: 'bypassPermissions' },
        { provider: 'openai-codex', mode: 'bypassPermissions' }, // <- combinación inválida
    ]);
    const failures = pv.validateAllSkillsAtBoot({ skillsRegistry: registry, resolveSkillChain });
    assert.equal(failures.length, 1);
    assert.equal(failures[0].skill, 'pipeline-dev');
    assert.equal(failures[0].reason, 'mode_unknown');
});

test('#4274 CA-4 · boot chain-aware pasa cuando cada eslabón de la cadena está mapeado', () => {
    const registry = { 'pipeline-dev': { required_permissions: DEV_REQUIRED } };
    const resolveSkillChain = () => ([
        { provider: 'anthropic', mode: 'bypassPermissions' },
        { provider: 'openai-codex', mode: 'full-auto' },   // modo correcto de codex
        { provider: 'nvidia-nim', mode: 'bypassPermissions' },
    ]);
    const failures = pv.validateAllSkillsAtBoot({ skillsRegistry: registry, resolveSkillChain });
    assert.deepEqual(failures, []);
});

test('#4274 CA-4 · un fallback inválido es invisible si solo se valida el primario (regresión que el fix corrige)', () => {
    const registry = { 'pipeline-dev': { required_permissions: DEV_REQUIRED } };
    // Modo legacy (solo primario): NO detecta el fallback roto → demuestra por qué
    // el incidente fue invisible al boot antes de la validación chain-aware.
    const resolveSkill = () => ({ provider: 'anthropic', mode: 'bypassPermissions' });
    const failuresLegacy = pv.validateAllSkillsAtBoot({ skillsRegistry: registry, resolveSkill });
    assert.deepEqual(failuresLegacy, []);

    // Con chain-aware, el mismo fallback roto SÍ se detecta.
    const resolveSkillChain = () => ([
        { provider: 'anthropic', mode: 'bypassPermissions' },
        { provider: 'openai-codex', mode: 'bypassPermissions' },
    ]);
    const failuresChain = pv.validateAllSkillsAtBoot({ skillsRegistry: registry, resolveSkillChain });
    assert.equal(failuresChain.length, 1);
});

test('#4274 CA-4 · resolveSkill (single) sigue soportado por compat', () => {
    const registry = { guru: { required_permissions: ['file_read', 'network_out'] } };
    const resolveSkill = () => ({ provider: 'openai-codex', mode: 'full-auto' });
    const failures = pv.validateAllSkillsAtBoot({ skillsRegistry: registry, resolveSkill });
    assert.deepEqual(failures, []);
});

test('#4274 CA-4 · eslabón de cadena sin mode resoluble se reporta como resolve_failed', () => {
    const registry = { 'pipeline-dev': { required_permissions: DEV_REQUIRED } };
    const resolveSkillChain = () => ([
        { provider: 'anthropic', mode: 'bypassPermissions' },
        { provider: 'provider-fantasma', mode: null }, // mode no resoluble
    ]);
    const failures = pv.validateAllSkillsAtBoot({ skillsRegistry: registry, resolveSkillChain });
    assert.equal(failures.length, 1);
    assert.equal(failures[0].reason, 'resolve_failed');
});

test('#4274 CA-4 · skills determinísticos en la cadena no disparan el gate', () => {
    const registry = { reset: { required_permissions: ['file_read', 'bash'] } };
    const resolveSkillChain = () => ([{ provider: 'deterministic', mode: 'native' }]);
    const failures = pv.validateAllSkillsAtBoot({ skillsRegistry: registry, resolveSkillChain });
    assert.deepEqual(failures, []);
});

// ---------------------------------------------------------------------------
// CA-6 / SR-2 — least-privilege por modo (la matriz NO se aplana)
// ---------------------------------------------------------------------------

test('#4274 CA-6 · codex/default concede solo file_read + network_out (no es el set autónomo)', () => {
    const granted = pv.grantedCapabilities('openai-codex', 'default');
    assert.ok(granted instanceof Set);
    assert.deepEqual(Array.from(granted).sort(), ['file_read', 'network_out']);
});

test('#4274 CA-6 · codex/full-auto concede el set autónomo completo (diferenciación por modo se mantiene)', () => {
    const granted = pv.grantedCapabilities('openai-codex', 'full-auto');
    for (const cap of ['file_read', 'file_write_repo', 'bash', 'network_out', 'child_spawn', 'tool_use_gated']) {
        assert.ok(granted.has(cap), `full-auto debe conceder ${cap}`);
    }
});

// ---------------------------------------------------------------------------
// CA-7 / SR-4 — techo de privilegios del pipeline intacto
// ---------------------------------------------------------------------------

test('#4274 CA-7 · ningún (provider LLM × modo) concede file_write_outside_repo / bash_elevated / network_in', () => {
    const CEILING = ['file_write_outside_repo', 'bash_elevated', 'network_in'];
    const matrix = pv.CAPABILITY_MATRIX;
    for (const [provider, modes] of Object.entries(matrix)) {
        if (provider === 'deterministic') continue; // Node puro, no es spawn LLM gateado
        for (const [mode, granted] of Object.entries(modes)) {
            for (const forbidden of CEILING) {
                assert.ok(
                    !granted.has(forbidden),
                    `${provider}/${mode} NO debe conceder ${forbidden}`
                );
            }
        }
    }
});

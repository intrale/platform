// =============================================================================
// agent-models-validate-4306.test.js — #4306
//
// Verifica:
//   - coherencia auth_mode: oauth ⇒ launcher CLI (claude/codex/gemini-google)
//     como ERROR de carga (fail-closed, CA-3 / REQ-SEC-1).
//   - validateCredentialsEnvPresence bypassea providers oauth (no exige key).
//   - credentials_env opcional cuando auth_mode === 'oauth'.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    validateCrossReferences,
    validateCredentialsEnvPresence,
} = require('../agent-models-validate');

function baseConfig(providers, skills) {
    return {
        default_provider: 'anthropic',
        providers,
        skills: skills || {},
    };
}

// ── Coherencia auth_mode (validateCrossReferences) ───────────────────────────

test('#4306: oauth + launcher CLI conocido (codex) → sin error de coherencia', () => {
    const cfg = baseConfig({
        'openai-codex': { launcher: 'codex', auth_mode: 'oauth', credentials_env: ['OPENAI_API_KEY'] },
    });
    const errors = validateCrossReferences(cfg);
    const authErrors = errors.filter((e) => e.path.includes('/auth_mode'));
    assert.equal(authErrors.length, 0, JSON.stringify(authErrors));
});

test('#4306: oauth + launcher gemini-google → sin error de coherencia', () => {
    const cfg = baseConfig({
        'gemini-google': { launcher: 'gemini-google', auth_mode: 'oauth' },
    });
    const errors = validateCrossReferences(cfg);
    const authErrors = errors.filter((e) => e.path.includes('/auth_mode'));
    assert.equal(authErrors.length, 0, JSON.stringify(authErrors));
});

test('#4306: oauth + launcher HTTP (cerebras) → ERROR de carga (fail-closed)', () => {
    const cfg = baseConfig({
        cerebras: { launcher: 'cerebras', auth_mode: 'oauth', credentials_env: ['CEREBRAS_API_KEY'] },
    });
    const errors = validateCrossReferences(cfg);
    const authErrors = errors.filter((e) => e.path === '#/providers/cerebras/auth_mode');
    assert.equal(authErrors.length, 1, JSON.stringify(errors));
    assert.match(authErrors[0].message, /no es de login CLI/);
});

test('#4306: oauth + launcher local (node) → ERROR de carga', () => {
    const cfg = baseConfig({
        deterministic: { launcher: 'node', auth_mode: 'oauth' },
    });
    const errors = validateCrossReferences(cfg);
    const authErrors = errors.filter((e) => e.path === '#/providers/deterministic/auth_mode');
    assert.equal(authErrors.length, 1, JSON.stringify(errors));
});

test('#4306: provider sin auth_mode (api_key default) NO dispara la regla de coherencia', () => {
    const cfg = baseConfig({
        cerebras: { launcher: 'cerebras', credentials_env: ['CEREBRAS_API_KEY'] },
    });
    const errors = validateCrossReferences(cfg);
    const authErrors = errors.filter((e) => e.path.includes('/auth_mode'));
    assert.equal(authErrors.length, 0);
});

// ── credentials_env opcional con oauth ───────────────────────────────────────

test('#4306: oauth + launcher CLI SIN credentials_env → válido (credentials_env opcional)', () => {
    const cfg = baseConfig({
        'openai-codex': { launcher: 'codex', auth_mode: 'oauth' },
    });
    const errors = validateCrossReferences(cfg);
    const authErrors = errors.filter((e) => e.path.includes('/auth_mode') || e.path.includes('/credentials_env'));
    assert.equal(authErrors.length, 0, JSON.stringify(authErrors));
});

// ── Bypass de presencia de env (validateCredentialsEnvPresence) ──────────────

test('#4306: validateCredentialsEnvPresence bypassea codex oauth sin OPENAI_API_KEY', () => {
    const cfg = baseConfig(
        { 'openai-codex': { launcher: 'codex', auth_mode: 'oauth', credentials_env: ['OPENAI_API_KEY'] } },
        { qa: { provider: 'openai-codex' } },
    );
    const errors = validateCredentialsEnvPresence(cfg, { /* sin OPENAI_API_KEY */ });
    assert.equal(errors.length, 0, JSON.stringify(errors));
});

test('#4306 (regresión): validateCredentialsEnvPresence SIGUE exigiendo key a cerebras', () => {
    const cfg = baseConfig(
        { cerebras: { launcher: 'cerebras', credentials_env: ['CEREBRAS_API_KEY'] } },
        { qa: { provider: 'cerebras' } },
    );
    const errors = validateCredentialsEnvPresence(cfg, { /* sin CEREBRAS_API_KEY */ });
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.match(errors[0].message, /CEREBRAS_API_KEY/);
});

// =============================================================================
// agent-models-validate-4306.test.js — #4306
//
// Verifica:
//   - coherencia auth_mode: oauth ⇒ launcher CLI (claude/codex/antigravity)
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

test('#4306: oauth + launcher antigravity → sin error de coherencia', () => {
    const cfg = baseConfig({
        'antigravity': { launcher: 'antigravity', auth_mode: 'oauth' },
    });
    const errors = validateCrossReferences(cfg);
    const authErrors = errors.filter((e) => e.path.includes('/auth_mode'));
    assert.equal(authErrors.length, 0, JSON.stringify(authErrors));
});

// #6563 — el caso "oauth + launcher HTTP" (cerebras) se retiró junto con el
// provider: tras la baja no queda ningún launcher HTTP en ALLOWED_LAUNCHERS. El
// único launcher fuera de OAUTH_CAPABLE_LAUNCHERS es el local `node`.
test('#4306: oauth + launcher local (node) → ERROR de carga (fail-closed)', () => {
    const cfg = baseConfig({
        deterministic: { launcher: 'node', auth_mode: 'oauth' },
    });
    const errors = validateCrossReferences(cfg);
    const authErrors = errors.filter((e) => e.path === '#/providers/deterministic/auth_mode');
    assert.equal(authErrors.length, 1, JSON.stringify(errors));
    assert.match(authErrors[0].message, /no es de login CLI/);
});

test('#4306: provider sin auth_mode (api_key default) NO dispara la regla de coherencia', () => {
    const cfg = baseConfig({
        'antigravity': { launcher: 'antigravity', credentials_env: ['GEMINI_API_KEY'] },
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

test('#4306 (regresión): validateCredentialsEnvPresence SIGUE exigiendo key a un provider api_key', () => {
    const cfg = baseConfig(
        { 'antigravity': { launcher: 'antigravity', credentials_env: ['GEMINI_API_KEY'] } },
        { qa: { provider: 'antigravity' } },
    );
    const errors = validateCredentialsEnvPresence(cfg, { /* sin GEMINI_API_KEY */ });
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.match(errors[0].message, /GEMINI_API_KEY/);
});

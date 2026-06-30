// =============================================================================
// credentials-precheck-4306.test.js — #4306
//
// Verifica el bypass declarativo de validación de credenciales para providers
// OAuth/CLI login (auth_mode: 'oauth') y la preservación de la exigencia de
// key para providers HTTP (cerebras / nvidia-nim).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { _validateProviderCredentials } = require('../commander/credentials-precheck');

test('#4306: openai-codex (auth_mode oauth) SIN OPENAI_API_KEY → ok:true', () => {
    const def = { launcher: 'codex', auth_mode: 'oauth', credentials_env: ['OPENAI_API_KEY'] };
    const r = _validateProviderCredentials('openai-codex', def, {});
    assert.deepEqual(r, { ok: true });
});

test('#4306: gemini-google (auth_mode oauth) SIN GEMINI_API_KEY → ok:true', () => {
    const def = { launcher: 'gemini-google', auth_mode: 'oauth', credentials_env: ['GEMINI_API_KEY'] };
    const r = _validateProviderCredentials('gemini-google', def, {});
    assert.deepEqual(r, { ok: true });
});

test('#4306: anthropic (launcher claude, sin auth_mode explícito) sigue bypaseando', () => {
    const def = { launcher: 'claude', credentials_env: ['ANTHROPIC_API_KEY'] };
    const r = _validateProviderCredentials('anthropic', def, {});
    assert.deepEqual(r, { ok: true });
});

test('#4306 (regresión): cerebras (HTTP, sin auth_mode) SIN key → ok:false con reason', () => {
    const def = { launcher: 'cerebras', credentials_env: ['CEREBRAS_API_KEY'] };
    const r = _validateProviderCredentials('cerebras', def, {});
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'env_missing_or_placeholder:CEREBRAS_API_KEY');
});

test('#4306 (regresión): nvidia-nim (HTTP, sin auth_mode) SIN key → ok:false con reason', () => {
    const def = { launcher: 'nvidia-nim', credentials_env: ['NVIDIA_NIM_API_KEY'] };
    const r = _validateProviderCredentials('nvidia-nim', def, {});
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'env_missing_or_placeholder:NVIDIA_NIM_API_KEY');
});

test('#4306 (regresión): cerebras CON key presente → ok:true', () => {
    const def = { launcher: 'cerebras', credentials_env: ['CEREBRAS_API_KEY'] };
    const r = _validateProviderCredentials('cerebras', def, { CEREBRAS_API_KEY: 'csk-real-value' });
    assert.deepEqual(r, { ok: true });
});

test('#4306: el reason nunca contiene el VALOR de la credencial (REQ-SEC-4)', () => {
    const def = { launcher: 'cerebras', credentials_env: ['CEREBRAS_API_KEY'] };
    const r = _validateProviderCredentials('cerebras', def, { CEREBRAS_API_KEY: '' });
    assert.equal(r.ok, false);
    // Solo nombre de var, nunca valor.
    assert.match(r.reason, /^env_missing_or_placeholder:CEREBRAS_API_KEY$/);
});

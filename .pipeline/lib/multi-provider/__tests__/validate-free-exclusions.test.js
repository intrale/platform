// =============================================================================
// validate-free-exclusions.test.js — tests del candado free-only fail-closed
// para skills sensibles (#4408 / RS-2 / OWASP A05).
//
// Cobertura (CA-1..CA-5):
//   - CA-1: provider fuera de allowlist en primary o fallback → ok:false.
//   - CA-2: fail-closed sobre provider inventado (ni APPROVED ni FORBIDDEN).
//   - CA-3: assert positivo — android-dev/web-dev con gemini-google no rechazados.
//   - CA-4: contra agent-models.json real editado → ok:true.
//   - CA-5: errores accionables sin fuga de secrets/tokens/paths.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  validateFreeExclusions,
  SENSITIVE_SKILLS,
  APPROVED_FOR_SENSITIVE,
  FORBIDDEN_FOR_SENSITIVE,
} = require('../validate-free-exclusions');

// -----------------------------------------------------------------------------
// CA-1 — Rechazo de provider no aprobado en skill sensible
// -----------------------------------------------------------------------------
test('CA-1: backend-dev con provider vetado en fallback devuelve ok:false', () => {
  const config = {
    skills: {
      'backend-dev': {
        provider: 'anthropic',
        fallbacks: [
          { provider: 'openai-codex' },
          { provider: 'gemini-google' },
        ],
      },
    },
  };
  const res = validateFreeExclusions(config);
  assert.equal(res.ok, false);
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0], /backend-dev/);
  assert.match(res.errors[0], /gemini-google/);
  assert.match(res.errors[0], /fallback\[1\]/);
});

test('CA-1: pipeline-dev con provider vetado en primary devuelve ok:false', () => {
  const config = {
    skills: {
      'pipeline-dev': {
        provider: 'cerebras',
        fallbacks: [{ provider: 'openai-codex' }],
      },
    },
  };
  const res = validateFreeExclusions(config);
  assert.equal(res.ok, false);
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0], /pipeline-dev/);
  assert.match(res.errors[0], /cerebras/);
  assert.match(res.errors[0], /primary/);
});

test('CA-1: reporta cada posición ofensora por separado', () => {
  const config = {
    skills: {
      'backend-dev': {
        provider: 'groq',
        fallbacks: [{ provider: 'nvidia-nim' }, { provider: 'anthropic' }],
      },
    },
  };
  const res = validateFreeExclusions(config);
  assert.equal(res.ok, false);
  // primary (groq) + fallback[0] (nvidia-nim); fallback[1] (anthropic) OK.
  assert.equal(res.errors.length, 2);
});

// -----------------------------------------------------------------------------
// CA-2 — Fail-closed sobre provider desconocido
// -----------------------------------------------------------------------------
test('CA-2 (fail-closed): provider inventado no aprobado ni vetado devuelve ok:false', () => {
  const invented = 'provider-fantasma';
  assert.equal(APPROVED_FOR_SENSITIVE.includes(invented), false);
  assert.equal(FORBIDDEN_FOR_SENSITIVE.includes(invented), false);

  const config = {
    skills: {
      'backend-dev': {
        provider: 'anthropic',
        fallbacks: [{ provider: invented }],
      },
    },
  };
  const res = validateFreeExclusions(config);
  assert.equal(res.ok, false);
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0], new RegExp(invented));
  // El provider inventado no está en la denylist → sin hint de "free-tier vetado".
  assert.doesNotMatch(res.errors[0], /free-tier explícitamente vetado/);
});

// -----------------------------------------------------------------------------
// CA-3 — No romper skills no sensibles (assert positivo)
// -----------------------------------------------------------------------------
test('CA-3: android-dev y web-dev con gemini-google no son rechazados', () => {
  const config = {
    skills: {
      'backend-dev': {
        provider: 'anthropic',
        fallbacks: [{ provider: 'openai-codex' }],
      },
      'android-dev': {
        provider: 'anthropic',
        fallbacks: [{ provider: 'gemini-google' }, { provider: 'nvidia-nim' }],
      },
      'web-dev': {
        provider: 'anthropic',
        fallbacks: [{ provider: 'gemini-google' }, { provider: 'nvidia-nim' }],
      },
    },
  };
  const res = validateFreeExclusions(config);
  assert.equal(res.ok, true);
  assert.deepEqual(res.errors, []);
});

test('CA-3: el validador solo itera SENSITIVE_SKILLS', () => {
  assert.deepEqual(SENSITIVE_SKILLS, ['backend-dev', 'pipeline-dev']);
});

// -----------------------------------------------------------------------------
// CA-4 — Contra agent-models.json real editado
// -----------------------------------------------------------------------------
test('CA-4: agent-models.json real (fallback=[openai-codex]) devuelve ok:true', () => {
  const configPath = path.resolve(__dirname, '../../../agent-models.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  // Guard: la config real debe tener el fallback esperado ya aplicado.
  const backendFallbacks = config.skills['backend-dev'].fallbacks.map((f) => f.provider);
  const pipelineFallbacks = config.skills['pipeline-dev'].fallbacks.map((f) => f.provider);
  assert.deepEqual(backendFallbacks, ['openai-codex']);
  assert.deepEqual(pipelineFallbacks, ['openai-codex']);

  const res = validateFreeExclusions(config);
  assert.equal(res.ok, true);
  assert.deepEqual(res.errors, []);
});

// -----------------------------------------------------------------------------
// CA-5 — Errores accionables sin fuga de datos
// -----------------------------------------------------------------------------
test('CA-5: los mensajes de error no filtran secrets/tokens/paths', () => {
  const config = {
    skills: {
      'backend-dev': {
        provider: 'gemini-google',
        // Datos sensibles que NUNCA deben aparecer en los mensajes.
        credentials_env: 'GEMINI_API_KEY',
        token: 'sk-super-secreto-123',
        fallbacks: [{ provider: 'nvidia-nim', credentials_env: 'NVIDIA_TOKEN' }],
      },
    },
  };
  const res = validateFreeExclusions(config);
  assert.equal(res.ok, false);
  assert.ok(res.errors.length > 0);

  const forbiddenSubstrings = ['credentials', 'env', 'token', '/secrets', 'sk-super-secreto'];
  for (const msg of res.errors) {
    for (const bad of forbiddenSubstrings) {
      assert.equal(
        msg.toLowerCase().includes(bad.toLowerCase()),
        false,
        `el mensaje "${msg}" no debe contener "${bad}"`
      );
    }
  }
});

// -----------------------------------------------------------------------------
// Robustez — entradas degeneradas no deben romper el validador
// -----------------------------------------------------------------------------
test('robustez: config vacía/ausente devuelve ok:true sin lanzar', () => {
  assert.deepEqual(validateFreeExclusions(undefined), { ok: true, errors: [] });
  assert.deepEqual(validateFreeExclusions({}), { ok: true, errors: [] });
  assert.deepEqual(validateFreeExclusions({ skills: {} }), { ok: true, errors: [] });
});

test('robustez: skill sensible ausente no es violación', () => {
  const res = validateFreeExclusions({
    skills: { 'android-dev': { provider: 'gemini-google' } },
  });
  assert.equal(res.ok, true);
});

test('robustez: fallbacks no-array se ignora sin lanzar', () => {
  const res = validateFreeExclusions({
    skills: { 'backend-dev': { provider: 'anthropic', fallbacks: null } },
  });
  assert.equal(res.ok, true);
});

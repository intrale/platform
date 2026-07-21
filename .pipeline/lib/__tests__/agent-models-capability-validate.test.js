// =============================================================================
// Tests capability-aware fallback validation — Issue #4839
//
// Cobertura de los criterios de aceptación (CA-1..CA-7) del PO:
//   CA-1 · Catálogo declarativo frozen en namespace propio (execution-capabilities.js).
//   CA-2 · Schema cerrado: enum inyectado, capability arbitraria falla el schema.
//   CA-3 · Validación fail-closed rechaza providers incapaces (primario + fallback).
//          + ausencia de capabilities ⇒ tratado como "no ofrece ninguna" (SEC-3).
//   CA-4 · Roles agénticos exigen agentic-tool-use; razonamiento no.
//   CA-5 · Provider capaz pasa sin ruido.
//   CA-6 · Config viva limpia: qa sin cerebras, deterministic con capability.
//   CA-7 · Este suite (aceptación + rechazo Gherkin del issue).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const validateMod = require('../agent-models-validate');
const execCaps = require('../execution-capabilities');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function tmpFile(content, ext = '.json') {
  const file = path.join(
    os.tmpdir(),
    `agent-models-cap-test-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`,
  );
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

// Config mínima válida con providers capaz (anthropic) e incapaz (cerebras) +
// deterministic (declara agentic-tool-use por Riesgo D). Los skills se pisan por
// test según el escenario.
function baseConfig(overrides = {}) {
  const cfg = {
    $schema: './agent-models.schema.json',
    default_provider: 'anthropic',
    providers: {
      anthropic: {
        launcher: 'claude',
        model: 'claude-opus-4-7',
        spawn_args_template: ['-p', '{user_prompt}', '--system-prompt-file', '{system_file}'],
        output_parser: 'anthropic-stream-json',
        quota_error_types: ['usage_limit_error'],
        supports_tool_use: true,
        capabilities: ['agentic-tool-use'],
        prompt_caching: { supported: true, ttl_seconds_default: 300 },
        credentials_env: ['ANTHROPIC_API_KEY'],
        permissions_mode: 'bypassPermissions',
        auth_mode: 'oauth',
      },
      cerebras: {
        launcher: 'cerebras',
        model: 'gpt-oss-120b',
        spawn_args_template: ['--model', '{model}', '{user_prompt}'],
        output_parser: 'openai-sse',
        quota_error_types: ['rate_limit_exceeded'],
        supports_tool_use: false,
        capabilities: [],
        prompt_caching: { supported: false },
        credentials_env: ['CEREBRAS_API_KEY'],
        permissions_mode: 'bypassPermissions',
      },
      deterministic: {
        launcher: 'node',
        model: 'deterministic',
        spawn_args_template: ['{script_path}', '{issue}', '--trabajando={trabajando_path}'],
        output_parser: 'none',
        quota_error_types: [],
        supports_tool_use: false,
        capabilities: ['agentic-tool-use'],
        prompt_caching: { supported: false },
      },
    },
    skills: {
      'backend-dev': { provider: 'anthropic', required_capabilities: ['agentic-tool-use'] },
    },
  };
  return { ...cfg, ...overrides };
}

// Filtra sólo los errores de capability (mensaje [FAIL-CLOSED]) para aislar del
// resto de cross-validations.
function capErrors(errors) {
  return errors.filter((e) => typeof e.message === 'string' && e.message.includes('[FAIL-CLOSED]'));
}

// ─── CA-1 · Catálogo declarativo en namespace propio ─────────────────────────

test('CA-1 · execution-capabilities exporta catálogo frozen + capabilityNames()', () => {
  assert.ok(Object.isFrozen(execCaps.EXECUTION_CAPABILITY_CATALOG), 'catálogo debe ser frozen');
  assert.ok('agentic-tool-use' in execCaps.EXECUTION_CAPABILITY_CATALOG, 'incluye agentic-tool-use');
  assert.deepEqual(execCaps.capabilityNames(), ['agentic-tool-use']);
});

test('CA-1 · el catálogo NO reusa tool_use_gated (eje autorización, SEC-1)', () => {
  const names = execCaps.capabilityNames();
  assert.ok(!names.includes('tool_use_gated'), 'no debe mezclar el eje autorización');
});

// ─── CA-2 · Schema cerrado con enum inyectado ────────────────────────────────

test('CA-2 · el schema inyecta el enum de capabilities desde el catálogo', () => {
  const schema = validateMod.getEffectiveSchema();
  assert.deepEqual(
    schema.$defs.providerDef.properties.capabilities.items.enum,
    execCaps.capabilityNames(),
  );
  assert.deepEqual(
    schema.$defs.skillAssignment.properties.required_capabilities.items.enum,
    execCaps.capabilityNames(),
  );
});

test('CA-2 · capability arbitraria fuera del enum hace fallar el schema', () => {
  const cfg = baseConfig();
  cfg.providers.anthropic.capabilities = ['agentic-tool-use', 'hack-arbitrary'];
  const file = tmpFile(cfg);
  const res = validateMod.validate(file);
  fs.unlinkSync(file);
  assert.equal(res.ok, false, 'debe rechazar capability inventada');
});

test('CA-2 · required_capabilities arbitraria fuera del enum hace fallar el schema', () => {
  const cfg = baseConfig();
  cfg.skills['backend-dev'].required_capabilities = ['inventada'];
  const file = tmpFile(cfg);
  const res = validateMod.validate(file);
  fs.unlinkSync(file);
  assert.equal(res.ok, false, 'debe rechazar required_capability inventada');
});

// ─── CA-3 / Gherkin #1 · Rechazo fail-closed ─────────────────────────────────

test('CA-3 / Gherkin #1 · cerebras en fallback de rol agéntico ⇒ rechazo [FAIL-CLOSED]', () => {
  const cfg = baseConfig();
  cfg.skills['backend-dev'].fallbacks = [{ provider: 'cerebras', model_override: 'gpt-oss-120b' }];
  const errs = capErrors(validateMod.validateExecutionCapabilities(cfg));
  assert.equal(errs.length, 1, 'exactamente un rechazo de capability');
  assert.match(errs[0].message, /rol "backend-dev"/);
  assert.match(errs[0].message, /provider "cerebras"/);
  assert.match(errs[0].message, /agentic-tool-use/);
  assert.equal(errs[0].path, '#/skills/backend-dev/fallbacks/0');
});

test('CA-3 · cerebras como provider primario de rol agéntico ⇒ rechazo', () => {
  const cfg = baseConfig();
  cfg.skills['qa'] = { provider: 'cerebras', required_capabilities: ['agentic-tool-use'] };
  const errs = capErrors(validateMod.validateExecutionCapabilities(cfg));
  const qaErr = errs.find((e) => e.path === '#/skills/qa/provider');
  assert.ok(qaErr, 'debe rechazar el primario incapaz');
  assert.match(qaErr.message, /\(primario\)/);
});

test('CA-3 / SEC-3 · provider SIN capabilities declaradas en rol agéntico ⇒ rechazo (fail-closed por ausencia)', () => {
  const cfg = baseConfig();
  // Provider capaz de tool_use pero sin declarar `capabilities` → fail-closed.
  cfg.providers.nocap = {
    launcher: 'nvidia-nim',
    model: 'deepseek-ai/deepseek-v4-pro',
    spawn_args_template: ['--model', '{model}', '{user_prompt}'],
    output_parser: 'openai-sse',
    quota_error_types: ['rate_limit_exceeded'],
    supports_tool_use: true,
    // capabilities AUSENTE a propósito.
    prompt_caching: { supported: false },
    credentials_env: ['NVIDIA_NIM_API_KEY'],
    permissions_mode: 'bypassPermissions',
  };
  cfg.skills['backend-dev'].fallbacks = [{ provider: 'nocap' }];
  const errs = capErrors(validateMod.validateExecutionCapabilities(cfg));
  assert.equal(errs.length, 1, 'ausencia de capabilities ⇒ rechazo, nunca asumir capaz');
  assert.match(errs[0].message, /provider "nocap"/);
});

test('CA-3 · el mensaje [FAIL-CLOSED] no interpola env/keys (SEC-5)', () => {
  const cfg = baseConfig();
  cfg.skills['backend-dev'].fallbacks = [{ provider: 'cerebras' }];
  const errs = capErrors(validateMod.validateExecutionCapabilities(cfg));
  for (const e of errs) {
    assert.ok(!/API_KEY|sk-|Bearer|CEREBRAS_API_KEY/.test(e.message), 'sin secretos/env en el mensaje');
  }
});

// ─── CA-4 · Roles agénticos exigen; razonamiento no ──────────────────────────

test('CA-4 / CA-5 · rol de razonamiento con cerebras en fallback ⇒ pasa sin ruido', () => {
  const cfg = baseConfig();
  // review NO declara required_capabilities → sin exigencia.
  cfg.skills['review'] = {
    provider: 'anthropic',
    fallbacks: [{ provider: 'cerebras', model_override: 'gpt-oss-120b' }],
  };
  const errs = capErrors(validateMod.validateExecutionCapabilities(cfg));
  assert.equal(errs.length, 0, 'sin required_capabilities no hay exigencia');
});

test('CA-4 · required_capabilities:[] equivale a sin exigencia', () => {
  const cfg = baseConfig();
  cfg.skills['review'] = {
    provider: 'anthropic',
    required_capabilities: [],
    fallbacks: [{ provider: 'cerebras' }],
  };
  const errs = capErrors(validateMod.validateExecutionCapabilities(cfg));
  assert.equal(errs.length, 0);
});

// ─── CA-5 / Gherkin #2 · Aceptación sin ruido ────────────────────────────────

test('CA-5 / Gherkin #2 · anthropic en backend-dev (requiere agentic-tool-use) ⇒ sin errores', () => {
  const cfg = baseConfig();
  const errs = capErrors(validateMod.validateExecutionCapabilities(cfg));
  assert.equal(errs.length, 0, 'provider capaz pasa sin errores de capability');
});

test('CA-5 · fallbacks capaces (codex/gemini/nvidia declaran la capability) ⇒ sin errores', () => {
  const cfg = baseConfig();
  cfg.providers.gemini = {
    launcher: 'gemini-google',
    model: 'gemini-2.0-flash',
    spawn_args_template: ['--model', '{model}', '{user_prompt}'],
    output_parser: 'gemini-stream',
    quota_error_types: ['quota_exceeded'],
    supports_tool_use: true,
    capabilities: ['agentic-tool-use'],
    prompt_caching: { supported: false },
    credentials_env: ['GEMINI_API_KEY'],
    auth_mode: 'oauth',
    permissions_mode: 'bypassPermissions',
  };
  cfg.skills['backend-dev'].fallbacks = [{ provider: 'gemini', model_override: 'gemini-2.0-flash' }];
  const errs = capErrors(validateMod.validateExecutionCapabilities(cfg));
  assert.equal(errs.length, 0);
});

// ─── CA-6 · deterministic primary de build/tester ────────────────────────────

test('CA-6 / Riesgo D · build/tester con provider deterministic ⇒ pasa', () => {
  const cfg = baseConfig();
  cfg.skills['build'] = { provider: 'deterministic', required_capabilities: ['agentic-tool-use'] };
  cfg.skills['tester'] = { provider: 'deterministic', required_capabilities: ['agentic-tool-use'] };
  const errs = capErrors(validateMod.validateExecutionCapabilities(cfg));
  assert.equal(errs.length, 0, 'deterministic declara agentic-tool-use → no rompe boot');
});

// ─── CA-6 · Regresión sobre la config real (post-limpieza de qa) ─────────────

test('CA-6 · config real agent-models.json ⇒ cero errores de capability', () => {
  const raw = fs.readFileSync(validateMod.CANONICAL_JSON_PATH, 'utf8');
  const config = JSON.parse(raw);
  const errs = capErrors(validateMod.validateExecutionCapabilities(config));
  assert.equal(errs.length, 0, `config real no debe tener offenders de capability: ${JSON.stringify(errs)}`);
});

test('CA-6 · config real ⇒ qa NO tiene cerebras en fallback', () => {
  const raw = fs.readFileSync(validateMod.CANONICAL_JSON_PATH, 'utf8');
  const config = JSON.parse(raw);
  const qaFallbacks = (config.skills.qa && config.skills.qa.fallbacks) || [];
  const providers = qaFallbacks.map((f) => (typeof f === 'string' ? f : f.provider));
  assert.ok(!providers.includes('cerebras'), 'qa no debe listar cerebras (offender limpiado)');
  assert.deepEqual(config.skills.qa.required_capabilities, ['agentic-tool-use']);
});

test('CA-6 · config real ⇒ deterministic declara agentic-tool-use', () => {
  const raw = fs.readFileSync(validateMod.CANONICAL_JSON_PATH, 'utf8');
  const config = JSON.parse(raw);
  assert.deepEqual(config.providers.deterministic.capabilities, ['agentic-tool-use']);
});

test('CA-6 · config real ⇒ cerebras declara capabilities vacío (incapaz)', () => {
  const raw = fs.readFileSync(validateMod.CANONICAL_JSON_PATH, 'utf8');
  const config = JSON.parse(raw);
  assert.deepEqual(config.providers.cerebras.capabilities, []);
});

// ─── CA-3 · Boot fail-fast: validate() completo sobre config con offender ─────

test('CA-3 · validate() sobre config con offender ⇒ ok:false (boot abortaría)', () => {
  const cfg = baseConfig();
  cfg.skills['qa'] = {
    provider: 'anthropic',
    model_override: 'claude-opus-4-7',
    required_capabilities: ['agentic-tool-use'],
    fallbacks: [{ provider: 'cerebras', model_override: 'gpt-oss-120b' }],
  };
  const file = tmpFile(cfg);
  const res = validateMod.validate(file);
  fs.unlinkSync(file);
  assert.equal(res.ok, false, 'la config con offender no valida');
  assert.ok(capErrors(res.errors).length >= 1, 'incluye el error de capability');
});

// ─── Multi-offender: lista todos, no corta en el primero (UX guideline) ──────

test('UX · varios offenders se listan todos en una pasada', () => {
  const cfg = baseConfig();
  cfg.skills['backend-dev'].fallbacks = [
    { provider: 'cerebras' },
    { provider: 'cerebras', model_override: 'zai-glm-4.7' },
  ];
  const errs = capErrors(validateMod.validateExecutionCapabilities(cfg));
  assert.equal(errs.length, 2, 'no corta en el primer offender');
});

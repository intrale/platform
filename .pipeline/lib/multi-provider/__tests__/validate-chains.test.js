// =============================================================================
// validate-chains.test.js — Tests del validador de cadenas multi-provider
// (#4407 D1). Runner: node --test .pipeline/lib/multi-provider/__tests__/validate-chains.test.js
// =============================================================================
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const amv = require('../../agent-models-validate');
const { validateChains } = require('../validate-chains');

// Carga del config real canónico (JSONC-aware), igual que el CLI.
function loadRealConfig() {
  const raw = fs.readFileSync(amv.CANONICAL_JSON_PATH, 'utf8');
  return amv.parseJsonOrJsonc(raw, amv.CANONICAL_JSON_PATH);
}

// Clon profundo para mutar sin contaminar el config real entre tests.
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

test('(a) config real con 23 cadenas devuelve ok:true y skillCount 23', () => {
  const config = loadRealConfig();
  const result = validateChains(config);
  assert.strictEqual(result.ok, true, `esperaba ok:true, errores: ${JSON.stringify(result.errors)}`);
  assert.strictEqual(result.skillCount, 23, `esperaba 23 skills, obtuvo ${result.skillCount}`);
  assert.deepStrictEqual(result.errors, []);
});

test('(b) fallback a provider inexistente devuelve ok:false con {path, message, fix}', () => {
  const config = deepClone(loadRealConfig());
  // Elegir la primera skill con fallbacks y romper su primer fallback.
  const skillKey = Object.keys(config.skills)
    .find((k) => Array.isArray(config.skills[k].fallbacks) && config.skills[k].fallbacks.length > 0);
  assert.ok(skillKey, 'el config real debe tener al menos una skill con fallbacks');
  config.skills[skillKey].fallbacks[0] = { provider: 'provider-que-no-existe', model_override: 'x' };

  const result = validateChains(config);
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.length >= 1, 'debe haber al menos un error');

  const broken = result.errors.find((e) => /provider-que-no-existe/.test(e.message));
  assert.ok(broken, `esperaba un error que identifique el provider roto, obtuvo: ${JSON.stringify(result.errors)}`);
  // Shape accionable completo.
  assert.ok(typeof broken.path === 'string' && broken.path.length > 0, 'error debe tener path');
  assert.ok(typeof broken.message === 'string' && broken.message.length > 0, 'error debe tener message');
  assert.ok(typeof broken.fix === 'string' && broken.fix.length > 0, 'error debe tener fix');
  assert.ok(broken.path.includes(skillKey), 'el path debe identificar la skill afectada');
});

test('(b2) provider primario ausente/roto devuelve ok:false (resolveSkillChain vacío)', () => {
  const config = deepClone(loadRealConfig());
  const skillKey = Object.keys(config.skills)[0];
  config.skills[skillKey].provider = 'primario-inexistente';

  const result = validateChains(config);
  assert.strictEqual(result.ok, false);
  const primaryErr = result.errors.find((e) => e.path === `#/skills/${skillKey}/provider`);
  assert.ok(primaryErr, `esperaba error de primario para ${skillKey}, obtuvo: ${JSON.stringify(result.errors)}`);
  assert.ok(primaryErr.fix.length > 0);
});

test('(c) no-fuga de secretos: ningún error incluye el VALOR de credentials_env', () => {
  const SECRET_VALUE = 'sk-super-secreto-no-debe-aparecer-12345';
  const ENV_NAME = 'TEST_FAKE_CREDENTIAL_4407';
  process.env[ENV_NAME] = SECRET_VALUE;
  try {
    const config = deepClone(loadRealConfig());
    // Inyectar un provider con credentials_env apuntando a una env con valor
    // presente, y romper una cadena para forzar la emisión de errores.
    config.providers['fake-provider-4407'] = {
      launcher: 'node',
      model: 'local-fake',
      credentials_env: [ENV_NAME],
    };
    const skillKey = Object.keys(config.skills)[0];
    config.skills[skillKey].provider = 'otro-inexistente';

    const result = validateChains(config);
    const serialized = JSON.stringify(result.errors);

    // El VALOR del secreto nunca debe aparecer en los mensajes.
    assert.ok(!serialized.includes(SECRET_VALUE),
      'FUGA: el valor de la env var de credentials_env apareció en los errores');
    // Defensa extra: tampoco el valor debe filtrarse aunque se mencione el nombre.
    for (const e of result.errors) {
      assert.ok(!String(e.message).includes(SECRET_VALUE));
      assert.ok(!String(e.fix).includes(SECRET_VALUE));
      assert.ok(!String(e.path).includes(SECRET_VALUE));
    }
  } finally {
    delete process.env[ENV_NAME];
  }
});

test('config sin skills devuelve ok:true con skillCount 0', () => {
  const result = validateChains({ providers: {}, skills: {} });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.skillCount, 0);
});

test('config null/indefinido no rompe (devuelve estructura válida)', () => {
  const result = validateChains(null);
  assert.strictEqual(typeof result.ok, 'boolean');
  assert.strictEqual(result.skillCount, 0);
  assert.ok(Array.isArray(result.errors));
});

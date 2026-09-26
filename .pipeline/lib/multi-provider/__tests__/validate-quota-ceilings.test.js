// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

// =============================================================================
// validate-quota-ceilings.test.js — Techo de cuota contratada por proveedor
// (#6559). Runner:
//   node --test .pipeline/lib/multi-provider/__tests__/validate-quota-ceilings.test.js
//
// Cubre los dos escenarios Gherkin del issue (techo declarado ⇒ valida y queda
// legible; activo sin techo ⇒ falla nombrando al proveedor) más los bordes que
// el guru marcó como riesgo real: exención de `deterministic`, normalización
// de alias, invariante porcentaje⇒100 y formato de `reposicion` por período.
// =============================================================================
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const amv = require('../../agent-models-validate');
const configResolver = require('../../config-resolver');
const q = require('../validate-quota-ceilings');

// --- fixtures ---------------------------------------------------------------

function agentModelsFixture() {
  return {
    default_provider: 'anthropic',
    providers: {
      anthropic: { launcher: 'claude', credentials_env: ['ANTHROPIC_API_KEY'] },
      'openai-codex': { launcher: 'codex', credentials_env: ['OPENAI_API_KEY'] },
      antigravity: { launcher: 'agy' },
      deterministic: { launcher: 'node', admission: { non_llm: true } },
    },
    skills: {
      'backend-dev': { provider: 'anthropic', fallbacks: [{ provider: 'openai-codex' }] },
      po: { provider: 'anthropic', fallbacks: [{ provider: 'antigravity' }, { provider: 'openai-codex' }] },
      tester: { provider: 'deterministic' },
    },
  };
}

function quotaFixture() {
  return {
    anthropic: { plan: 'Claude Max', periodo: 'semanal', techo: 100, unidad: 'porcentaje', reposicion: 'dom 21:00' },
    'openai-codex': { plan: 'ChatGPT Plus', periodo: 'semanal', techo: 100, unidad: 'porcentaje', reposicion: 'rolling' },
    antigravity: { plan: 'Google One', periodo: 'diario', techo: 100, unidad: 'porcentaje', reposicion: 'rolling' },
  };
}

function configFixture(quota = quotaFixture()) {
  return { multi_provider: { quota } };
}

function loadRealAgentModels() {
  const raw = fs.readFileSync(amv.CANONICAL_JSON_PATH, 'utf8');
  return amv.parseJsonOrJsonc(raw, amv.CANONICAL_JSON_PATH);
}

function loadRealConfig() {
  return configResolver.resolveMergedForDiff({
    kernelText: fs.readFileSync(path.join(__dirname, '..', '..', '..', 'config.yaml'), 'utf8'),
    productText: fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'pipeline.config.json'), 'utf8'),
  }).config;
}

// --- Gherkin 1: proveedor con techo declarado --------------------------------

test('Gherkin 1 · los 3 proveedores activos con techo declarado ⇒ ok:true y techo legible', () => {
  const r = q.validateQuotaCeilings(configFixture(), agentModelsFixture());
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  assert.deepStrictEqual(r.errors, []);
  assert.deepStrictEqual(r.providers, ['anthropic', 'openai-codex', 'antigravity']);

  const c = q.getQuotaCeiling(configFixture(), 'openai-codex', { env: {} });
  assert.strictEqual(c.plan, 'ChatGPT Plus');
  assert.strictEqual(c.periodo, 'semanal');
  assert.strictEqual(c.techo, 100);
  assert.strictEqual(c.unidad, 'porcentaje');
  assert.strictEqual(c.reposicion, 'rolling');
  assert.strictEqual(c.rolling, true);
  assert.strictEqual(c.tz_offset_min, -180, 'TZ default ART cuando QUOTA_TZ_OFFSET_MIN no está');
});

test('CA-3 · getQuotaCeiling respeta QUOTA_TZ_OFFSET_MIN y devuelve null si no hay techo', () => {
  const c = q.getQuotaCeiling(configFixture(), 'anthropic', { env: { QUOTA_TZ_OFFSET_MIN: '-300' } });
  assert.strictEqual(c.tz_offset_min, -300);
  assert.strictEqual(c.rolling, false);
  assert.strictEqual(q.getQuotaCeiling(configFixture(), 'provider-inexistente'), null);
  assert.strictEqual(q.getQuotaCeiling({}, 'anthropic'), null, 'sin sección quota ⇒ null, nunca infinito');
  assert.strictEqual(q.getQuotaCeiling(null, 'anthropic'), null);
});

test('CA-3 · listQuotaCeilings indexa por id canónico', () => {
  const all = q.listQuotaCeilings(configFixture(), { env: {} });
  assert.deepStrictEqual(Object.keys(all).sort(), ['anthropic', 'antigravity', 'openai-codex']);
  assert.strictEqual(all.anthropic.reposicion, 'dom 21:00');
});

// --- Gherkin 2: proveedor activo sin techo -----------------------------------

test('Gherkin 2 · proveedor activo en fallback sin techo ⇒ ok:false y el mensaje nombra al proveedor', () => {
  const quota = quotaFixture();
  delete quota.antigravity;
  const r = q.validateQuotaCeilings(configFixture(quota), agentModelsFixture());
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errors.length, 1, JSON.stringify(r.errors));
  const e = r.errors[0];
  assert.strictEqual(e.path, 'multi_provider.quota.antigravity');
  assert.match(e.message, /sin techo declarado/);
  assert.match(e.fix, /plan\/periodo\/techo\/unidad\/reposicion/);
  assert.match(e.fix, /config\.yaml/);
  assert.match(e.fix, /multi-provider\.md/);
  // El texto formateado que ve el operador nombra al proveedor.
  assert.match(q.formatError(e), /antigravity/);
});

test('Gherkin 2 · sin sección quota ⇒ un error POR proveedor activo (no uno genérico)', () => {
  const r = q.validateQuotaCeilings({ multi_provider: {} }, agentModelsFixture());
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(
    r.errors.map((e) => e.path).sort(),
    ['multi_provider.quota.anthropic', 'multi_provider.quota.antigravity', 'multi_provider.quota.openai-codex'],
  );
  for (const e of r.errors) assert.match(e.message, /proveedor activo sin techo declarado/);
});

test('Gherkin 2 · default_provider sin techo también falla (no sólo skills)', () => {
  const am = agentModelsFixture();
  am.skills = {};
  const r = q.validateQuotaCeilings({ multi_provider: { quota: {} } }, am);
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.providers, ['anthropic']);
  assert.strictEqual(r.errors[0].path, 'multi_provider.quota.anthropic');
});

// --- Exención de proveedores sin LLM -----------------------------------------

test('deterministic (non_llm) NO exige techo aunque esté en la cadena', () => {
  const r = q.validateQuotaCeilings(configFixture(), agentModelsFixture());
  assert.strictEqual(r.ok, true);
  assert.ok(!r.providers.includes('deterministic'));
});

test('deterministic queda exento por nombre incluso sin admission declarada', () => {
  const am = agentModelsFixture();
  delete am.providers.deterministic.admission;
  assert.ok(!q.activeProviders(am).includes('deterministic'));
});

test('un proveedor LLM sin admission.non_llm SÍ exige techo (fail-closed)', () => {
  const am = agentModelsFixture();
  am.skills.nuevo = { provider: 'nuevo-llm' };
  am.providers['nuevo-llm'] = { launcher: 'x' };
  const r = q.validateQuotaCeilings(configFixture(), am);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.path === 'multi_provider.quota.nuevo-llm'));
});

// --- Alias -------------------------------------------------------------------

test('alias: multi_provider.order [claude, codex] + quota.anthropic/openai-codex ⇒ ok:true (sin falso positivo)', () => {
  const cfg = configFixture();
  cfg.multi_provider.order = ['claude', 'codex', 'antigravity'];
  const r = q.validateQuotaCeilings(cfg, agentModelsFixture());
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

test('alias: un proveedor sólo presente en multi_provider.order como alias y sin techo ⇒ falla con el id canónico', () => {
  const am = agentModelsFixture();
  am.skills = { x: { provider: 'anthropic' } };
  const quota = quotaFixture();
  delete quota['openai-codex'];
  const cfg = configFixture(quota);
  cfg.multi_provider.order = ['codex'];
  const r = q.validateQuotaCeilings(cfg, am);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errors[0].path, 'multi_provider.quota.openai-codex');
});

test('normalizeProviderId: alias → canónico, canónico intacto, basura → null', () => {
  assert.strictEqual(q.normalizeProviderId('claude'), 'anthropic');
  assert.strictEqual(q.normalizeProviderId('codex'), 'openai-codex');
  assert.strictEqual(q.normalizeProviderId('antigravity'), 'antigravity');
  assert.strictEqual(q.normalizeProviderId(' anthropic '), 'anthropic');
  assert.strictEqual(q.normalizeProviderId(''), null);
  assert.strictEqual(q.normalizeProviderId(null), null);
  assert.strictEqual(q.normalizeProviderId(42), null);
});

// --- Invariantes cruzados ----------------------------------------------------

test('unidad porcentaje con techo ≠ 100 ⇒ error que lo explica', () => {
  const quota = quotaFixture();
  quota.anthropic.techo = 80;
  const r = q.validateQuotaCeilings(configFixture(quota), agentModelsFixture());
  assert.strictEqual(r.ok, false);
  const e = r.errors.find((x) => x.path === 'multi_provider.quota.anthropic.techo');
  assert.ok(e, JSON.stringify(r.errors));
  assert.match(e.message, /porcentaje.*100/);
});

test('unidad absoluta (tokens) admite cualquier techo >= 0', () => {
  const quota = quotaFixture();
  quota.anthropic = { plan: 'API', periodo: 'diario', techo: 5000000, unidad: 'tokens', reposicion: '00:00' };
  const r = q.validateQuotaCeilings(configFixture(quota), agentModelsFixture());
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

test('techo negativo o no numérico ⇒ error', () => {
  for (const bad of [-1, 'cien', NaN, null]) {
    const quota = quotaFixture();
    quota.anthropic.techo = bad;
    const r = q.validateQuotaCeilings(configFixture(quota), agentModelsFixture());
    assert.strictEqual(r.ok, false, `techo=${String(bad)} debería fallar`);
    assert.ok(r.errors.some((e) => e.path === 'multi_provider.quota.anthropic.techo'));
  }
});

test('reposicion: formato acorde al periodo (semanal=día HH:MM, diario=HH:MM, horario=:MM, rolling siempre)', () => {
  const casos = [
    ['semanal', 'dom 21:00', true],
    ['semanal', 'rolling', true],
    ['semanal', '21:00', false],
    ['semanal', 'domingo 21:00', false],
    ['diario', '03:00', true],
    ['diario', 'dom 03:00', false],
    ['diario', '25:00', false],
    ['horario', ':00', true],
    ['horario', ':30', true],
    ['horario', '03:00', false],
  ];
  for (const [periodo, reposicion, esperado] of casos) {
    const quota = quotaFixture();
    quota.anthropic.periodo = periodo;
    quota.anthropic.reposicion = reposicion;
    const r = q.validateQuotaCeilings(configFixture(quota), agentModelsFixture());
    assert.strictEqual(r.ok, esperado, `periodo=${periodo} reposicion=${JSON.stringify(reposicion)} → ${JSON.stringify(r.errors)}`);
    if (!esperado) assert.ok(r.errors.some((e) => e.path === 'multi_provider.quota.anthropic.reposicion'));
  }
});

test('REPOSICION_PATTERN (el del schema ajv) acepta y rechaza lo mismo que el validador', () => {
  const re = new RegExp(q.REPOSICION_PATTERN);
  for (const ok of ['dom 21:00', 'lun 00:00', '03:00', '23:59', ':00', ':59', 'rolling']) assert.ok(re.test(ok), ok);
  for (const bad of ['', 'domingo 21:00', 'dom 25:00', '21:00 ART', 'Rolling', ':60', 'dom21:00']) assert.ok(!re.test(bad), bad);
});

test('campos faltantes ⇒ un error por campo, nombrando proveedor y campo', () => {
  const quota = quotaFixture();
  quota['openai-codex'] = { plan: 'ChatGPT Plus' };
  const r = q.validateQuotaCeilings(configFixture(quota), agentModelsFixture());
  assert.strictEqual(r.ok, false);
  const paths = r.errors.map((e) => e.path).sort();
  assert.deepStrictEqual(paths, [
    'multi_provider.quota.openai-codex.periodo',
    'multi_provider.quota.openai-codex.reposicion',
    'multi_provider.quota.openai-codex.techo',
    'multi_provider.quota.openai-codex.unidad',
  ]);
  for (const e of r.errors) assert.match(e.message, /openai-codex/);
});

test('proveedor declarado pero NO activo: no exige presencia, pero sí valida su bloque', () => {
  const am = agentModelsFixture();
  am.skills = { x: { provider: 'anthropic' } };
  // antigravity dado de baja del ruteo: puede conservar el techo…
  let r = q.validateQuotaCeilings(configFixture(), am);
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  assert.deepStrictEqual(r.providers, ['anthropic']);
  // …y si lo conserva mal formado, se avisa igual (no queda latente).
  const quota = quotaFixture();
  quota.antigravity.periodo = 'mensual';
  r = q.validateQuotaCeilings(configFixture(quota), am);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.path === 'multi_provider.quota.antigravity.periodo'));
});

// --- Seguridad (CA-6 de #4407) ----------------------------------------------

test('los mensajes nunca arrastran credentials_env ni valores crudos del provider', () => {
  const am = agentModelsFixture();
  am.providers.anthropic.credentials_env = ['SUPER_SECRETA_ENV'];
  const r = q.validateQuotaCeilings({ multi_provider: { quota: {} } }, am);
  const texto = r.errors.map(q.formatError).join('\n');
  assert.ok(!/SUPER_SECRETA_ENV/.test(texto));
  assert.ok(!/credentials_env/.test(texto));
});

// --- Config real del repo -----------------------------------------------------

test('config.yaml + agent-models.json reales ⇒ ok:true (los 3 proveedores activos tienen techo)', () => {
  const r = q.validateQuotaCeilings(loadRealConfig(), loadRealAgentModels());
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  assert.deepStrictEqual([...r.providers].sort(), ['anthropic', 'antigravity', 'openai-codex']);
  for (const id of r.providers) {
    const c = q.getQuotaCeiling(loadRealConfig(), id);
    assert.ok(c, `techo legible para ${id}`);
    assert.ok(q.PERIODOS.includes(c.periodo));
    assert.ok(q.UNIDADES.includes(c.unidad));
  }
});

// .pipeline/lib/repo-target.test.js
// Tests node --test de la fuente de verdad única del repo destino (#4693 · CA-0,
// CA-A1, CA-A3). Cobertura 100% de ramas de isRepoAllowed() (frontera de
// seguridad) + fail-closed de getIntakeRepos()/getRepoForIssue().
//
// Ejecución: node --test .pipeline/lib/repo-target.test.js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  getIntakeRepos,
  getRepoForIssue,
  isRepoAllowed,
  getPrimaryRepo,
  getDefaultBaseRef,
} = require('./repo-target');

// Fixtures de config inyectadas (nunca tocan pipeline.config.json real).
const CFG_BOTH = {
  repos: {
    primary: 'intrale/platform',
    allowlist: ['intrale/platform', 'intrale/kernel'],
    default_base_ref: 'main',
  },
};
const CFG_GATED = {
  repos: {
    primary: 'intrale/platform',
    allowlist: ['intrale/platform', 'intrale/kernel'],
    intake: ['intrale/platform'], // GATE REQ-SEC-5: kernel allowlisted pero fuera del intake
    default_base_ref: 'main',
  },
};

// ---------------------------------------------------------------------------
// getIntakeRepos() — CA-A1
// ---------------------------------------------------------------------------

test('getIntakeRepos: sin bloque `intake` retorna la allowlist completa', () => {
  assert.deepStrictEqual(getIntakeRepos(CFG_BOTH), ['intrale/platform', 'intrale/kernel']);
});

test('getIntakeRepos: con `intake` explícito retorna sólo ese subconjunto (gate REQ-SEC-5)', () => {
  assert.deepStrictEqual(getIntakeRepos(CFG_GATED), ['intrale/platform']);
});

test('getIntakeRepos: intake nunca amplía más allá de la allowlist (∩)', () => {
  const cfg = { repos: { primary: 'intrale/platform', allowlist: ['intrale/platform'], intake: ['intrale/platform', 'intrale/kernel'] } };
  // kernel no está en allowlist ⇒ se filtra del intake.
  assert.deepStrictEqual(getIntakeRepos(cfg), ['intrale/platform']);
});

test('getIntakeRepos: allowlist ausente ⇒ fail-closed a primary-only', () => {
  assert.deepStrictEqual(getIntakeRepos({ repos: { primary: 'intrale/platform' } }), ['intrale/platform']);
});

test('getIntakeRepos: bloque repos ausente ⇒ fail-closed a fallback primary', () => {
  assert.deepStrictEqual(getIntakeRepos({}), ['intrale/platform']);
});

// ---------------------------------------------------------------------------
// isRepoAllowed() — CA-A3 / REQ-SEC-1..4 · 100% de ramas
// ---------------------------------------------------------------------------

test('isRepoAllowed: repo allowlisted ⇒ true', () => {
  assert.strictEqual(isRepoAllowed('intrale/platform', CFG_BOTH), true);
  assert.strictEqual(isRepoAllowed('intrale/kernel', CFG_BOTH), true);
});

test('isRepoAllowed: repo NO allowlisted ⇒ false (default-deny)', () => {
  assert.strictEqual(isRepoAllowed('evil/repo', CFG_BOTH), false);
});

test('isRepoAllowed: repo ausente/vacío/null/undefined ⇒ false', () => {
  assert.strictEqual(isRepoAllowed('', CFG_BOTH), false);
  assert.strictEqual(isRepoAllowed(null, CFG_BOTH), false);
  assert.strictEqual(isRepoAllowed(undefined, CFG_BOTH), false);
});

test('isRepoAllowed: normaliza casing en ambos lados (REQ-SEC-4)', () => {
  assert.strictEqual(isRepoAllowed('Intrale/Platform', CFG_BOTH), true);
  assert.strictEqual(isRepoAllowed('INTRALE/KERNEL', CFG_BOTH), true);
  // allowlist en mayúsculas también matchea input en minúsculas.
  const cfgUpper = { repos: { primary: 'Intrale/Kernel', allowlist: ['Intrale/Kernel'] } };
  assert.strictEqual(isRepoAllowed('intrale/kernel', cfgUpper), true);
});

test('isRepoAllowed: rechaza formas maliciosas — shell injection / flags / espacios (REQ-SEC-2)', () => {
  assert.strictEqual(isRepoAllowed('platform; rm -rf', CFG_BOTH), false);
  assert.strictEqual(isRepoAllowed('intrale/platform; echo pwned', CFG_BOTH), false);
  assert.strictEqual(isRepoAllowed('--flag', CFG_BOTH), false);
  assert.strictEqual(isRepoAllowed('intrale platform', CFG_BOTH), false);
  assert.strictEqual(isRepoAllowed('intrale/../../etc', CFG_BOTH), false);
  assert.strictEqual(isRepoAllowed('intrale/plat form', CFG_BOTH), false);
  assert.strictEqual(isRepoAllowed('sinbarra', CFG_BOTH), false);
  assert.strictEqual(isRepoAllowed('a/b/c', CFG_BOTH), false);
});

test('isRepoAllowed: allowlist vacía ⇒ deny salvo primary (nunca allow-all)', () => {
  const cfg = { repos: { primary: 'intrale/platform', allowlist: [] } };
  assert.strictEqual(isRepoAllowed('intrale/platform', cfg), true);  // primary siempre confiable
  assert.strictEqual(isRepoAllowed('intrale/kernel', cfg), false);   // no allow-all
});

test('isRepoAllowed: allowlist malformada (no-array) ⇒ fail-closed a primary-only', () => {
  const cfg = { repos: { primary: 'intrale/platform', allowlist: 'intrale/kernel' } };
  assert.strictEqual(isRepoAllowed('intrale/kernel', cfg), false);
  assert.strictEqual(isRepoAllowed('intrale/platform', cfg), true);
});

test('isRepoAllowed: entradas malformadas en allowlist se descartan (no crash)', () => {
  const cfg = { repos: { primary: 'intrale/platform', allowlist: ['intrale/platform', 'basura ilegal', 42, null] } };
  assert.strictEqual(isRepoAllowed('intrale/platform', cfg), true);
  assert.strictEqual(isRepoAllowed('basura ilegal', cfg), false);
});

test('isRepoAllowed: bloque repos ausente/corrupto ⇒ sólo fallback primary permitido', () => {
  assert.strictEqual(isRepoAllowed('intrale/platform', {}), true);
  assert.strictEqual(isRepoAllowed('intrale/kernel', {}), false);
  assert.strictEqual(isRepoAllowed('intrale/platform', { repos: null }), true);
});

// ---------------------------------------------------------------------------
// getRepoForIssue() — CA-A2
// ---------------------------------------------------------------------------

test('getRepoForIssue: resuelve el repo de origen propagado (objeto)', () => {
  assert.strictEqual(getRepoForIssue({ number: 100, origin_repo: 'intrale/kernel' }, CFG_BOTH), 'intrale/kernel');
  assert.strictEqual(getRepoForIssue({ number: 7, repo: 'intrale/platform' }, CFG_BOTH), 'intrale/platform');
});

test('getRepoForIssue: acepta string owner/repo', () => {
  assert.strictEqual(getRepoForIssue('intrale/kernel', CFG_BOTH), 'intrale/kernel');
});

test('getRepoForIssue: normaliza casing del repo propagado', () => {
  assert.strictEqual(getRepoForIssue({ origin_repo: 'Intrale/Kernel' }, CFG_BOTH), 'intrale/kernel');
});

test('getRepoForIssue: repo propagado NO allowlisted ⇒ fail-closed a primary', () => {
  assert.strictEqual(getRepoForIssue({ number: 1, origin_repo: 'evil/repo' }, CFG_BOTH), 'intrale/platform');
});

test('getRepoForIssue: issue sin repo (número puro / objeto vacío) ⇒ primary', () => {
  assert.strictEqual(getRepoForIssue({ number: 4693 }, CFG_BOTH), 'intrale/platform');
  assert.strictEqual(getRepoForIssue(4693, CFG_BOTH), 'intrale/platform');
  assert.strictEqual(getRepoForIssue(null, CFG_BOTH), 'intrale/platform');
});

// ---------------------------------------------------------------------------
// getPrimaryRepo() / getDefaultBaseRef()
// ---------------------------------------------------------------------------

test('getPrimaryRepo: retorna el primary normalizado, fail-closed a fallback', () => {
  assert.strictEqual(getPrimaryRepo(CFG_BOTH), 'intrale/platform');
  assert.strictEqual(getPrimaryRepo({}), 'intrale/platform');
  assert.strictEqual(getPrimaryRepo({ repos: { primary: 'malformado sin barra' } }), 'intrale/platform');
});

test('getDefaultBaseRef: retorna default_base_ref o `main` por default', () => {
  assert.strictEqual(getDefaultBaseRef(CFG_BOTH), 'main');
  assert.strictEqual(getDefaultBaseRef({ repos: { default_base_ref: 'develop' } }), 'develop');
  assert.strictEqual(getDefaultBaseRef({}), 'main');
});

// ---------------------------------------------------------------------------
// Config de PRODUCCIÓN real (pipeline.config.json) — invariantes del gate
// ---------------------------------------------------------------------------

test('config real: platform allowlisted+intaken; kernel allowlisted pero FUERA del intake (gate #4694)', () => {
  // Sin configOverride ⇒ lee pipeline.config.json real.
  assert.strictEqual(isRepoAllowed('intrale/platform'), true, 'platform debe estar allowlisted');
  assert.strictEqual(isRepoAllowed('intrale/kernel'), true, 'kernel debe estar allowlisted (confianza)');
  const intake = getIntakeRepos();
  assert.ok(intake.includes('intrale/platform'), 'platform debe estar en intake efectivo');
  assert.ok(!intake.includes('intrale/kernel'), 'GATE REQ-SEC-5: kernel NO debe estar en intake hasta #4694');
  assert.strictEqual(getPrimaryRepo(), 'intrale/platform');
});

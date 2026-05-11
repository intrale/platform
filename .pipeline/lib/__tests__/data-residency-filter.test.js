// =============================================================================
// data-residency-filter.test.js — Tests del filtro de paths data residency
// (issue #3084 / S6 multi-provider).
//
// Cubre los CA-4 del issue:
//   1. Path en exclusión NO aparece en el contexto enviado a adapter no-Anthropic.
//   2. Path fuera de exclusión SÍ aparece (anti-falso-positivo).
//   3. Audit log registra el evento de bloqueo con shape esperado y `path_hash`.
//   4. Sidecar ausente o corrupto → loader lanza error fail-closed.
//   5. Provider Anthropic → filtro NO aplica exclusión (passthrough).
//   6. Patrón con path-traversal (`..`, prefijo `/`) → schema/compileGlob rechaza.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const filter = require('../data-residency-filter');

// ─── Fixtures helpers ────────────────────────────────────────────────────────

function makeTmpDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `data-resid-${label}-`));
  return dir;
}

function writeSidecar(dir, sidecar) {
  const p = path.join(dir, 'data-residency-exclusions.json');
  fs.writeFileSync(p, JSON.stringify(sidecar, null, 2), 'utf8');
  return p;
}

function defaultSidecar(extra = {}) {
  return {
    version: '2026-05-08',
    doc_ref: 'docs/pipeline-multi-provider/data-residency.md',
    default_policy: {
      anthropic: 'passthrough',
      deterministic: 'passthrough',
      non_anthropic: 'filter',
    },
    exclusions: [
      {
        pattern: '**/.env*',
        providers: ['non_anthropic'],
        motivo: 'archivos .env con secrets',
      },
      {
        pattern: 'users/src/main/resources/application.conf',
        providers: ['non_anthropic'],
        motivo: 'config de Lambda con secrets AWS y Cognito',
      },
      {
        pattern: '**/secrets/**',
        providers: ['non_anthropic'],
        motivo: 'directorio convencional de secrets',
      },
    ],
    ...extra,
  };
}

// ─── CA-4 / Test 1 — Path en exclusión NO aparece (caso positivo) ────────────

test('CA-4 #1 · path en exclusión NO aparece en allowed para provider no-Anthropic', () => {
  const sidecar = defaultSidecar();
  const result = filter.filterPathsForProvider({
    paths: [
      'users/src/main/resources/application.conf',
      'app/composeApp/src/main/kotlin/Login.kt',
      '.env.production',
    ],
    provider: 'openai-codex',
    exclusions: sidecar.exclusions,
    defaultPolicy: sidecar.default_policy,
  });

  assert.equal(result.policy, 'filter');
  assert.equal(result.category, 'non_anthropic');
  assert.deepEqual(result.allowed, ['app/composeApp/src/main/kotlin/Login.kt']);
  assert.equal(result.blocked.length, 2);
  const motivos = result.blocked.map((b) => b.motivo).sort();
  assert.ok(motivos.some((m) => m.includes('application.conf') === false));
  // Verifico que tienen pattern + motivo + path
  for (const b of result.blocked) {
    assert.equal(typeof b.path, 'string');
    assert.equal(typeof b.pattern, 'string');
    assert.equal(typeof b.motivo, 'string');
  }
});

// ─── CA-4 / Test 2 — Anti falso-positivo ─────────────────────────────────────

test('CA-4 #2 · path fuera de exclusión SÍ aparece (anti-falso-positivo)', () => {
  const sidecar = defaultSidecar();
  const safePaths = [
    'app/composeApp/src/main/kotlin/Login.kt',
    'docs/arquitectura-app.md',
    'backend/build.gradle.kts',
  ];
  const result = filter.filterPathsForProvider({
    paths: safePaths,
    provider: 'gemini',
    exclusions: sidecar.exclusions,
    defaultPolicy: sidecar.default_policy,
  });
  assert.deepEqual(result.allowed, safePaths);
  assert.deepEqual(result.blocked, []);
});

// ─── CA-4 / Test 3 — Audit log con path_hash + shape esperado ────────────────

test('CA-4 #3 · audit log persiste shape esperado y path_hash (no path crudo)', () => {
  const tmp = makeTmpDir('audit');
  const auditPath = path.join(tmp, 'audit.jsonl');

  const blocked = [
    { path: 'users/src/main/resources/application.conf', pattern: '**/application.conf', motivo: 'config Lambda' },
    { path: '.env.production', pattern: '**/.env*', motivo: 'env file' },
  ];
  const r = filter.appendAudit({
    skill: 'review',
    provider: 'openai-codex',
    blocked,
    auditPath,
  });
  assert.equal(r.written, 2);

  const lines = fs.readFileSync(auditPath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  for (let i = 0; i < lines.length; i++) {
    const obj = JSON.parse(lines[i]);
    assert.match(obj.ts, /^[0-9]{4}-[0-9]{2}-[0-9]{2}T/, 'ts ISO-8601');
    assert.equal(obj.skill, 'review');
    assert.equal(obj.provider, 'openai-codex');
    assert.equal(typeof obj.path_hash, 'string');
    assert.equal(obj.path_hash.length, 12);
    assert.match(obj.path_hash, /^[0-9a-f]{12}$/, 'path_hash es hex truncado');
    // No debe aparecer el path crudo en ningún campo del JSON.
    const serialized = JSON.stringify(obj);
    assert.ok(!serialized.includes(blocked[i].path), `path crudo "${blocked[i].path}" no debe estar en el audit JSON`);
    assert.equal(obj.motivo, blocked[i].motivo);
    assert.equal(obj.pattern, blocked[i].pattern);
  }
});

test('CA-4 #3b · path_hash es SHA-256 truncado a 12 hex', () => {
  const p = 'users/src/main/resources/application.conf';
  const expected = crypto.createHash('sha256').update(p, 'utf8').digest('hex').slice(0, 12);
  assert.equal(filter.hashPath(p), expected);
});

test('CA-4 #3c · appendAudit no escribe nada cuando blocked está vacío', () => {
  const tmp = makeTmpDir('audit-empty');
  const auditPath = path.join(tmp, 'audit.jsonl');
  const r = filter.appendAudit({ skill: 'qa', provider: 'gemini', blocked: [], auditPath });
  assert.equal(r.written, 0);
  assert.equal(fs.existsSync(auditPath), false);
});

// ─── CA-4 / Test 4 — Sidecar ausente o corrupto → fail-closed ────────────────

test('CA-4 #4a · sidecar ausente → loadExclusionsOrThrow lanza con mensaje accionable', () => {
  const tmp = makeTmpDir('absent');
  const sidecarPath = path.join(tmp, 'no-existe.json');
  assert.throws(() => {
    filter.loadExclusionsOrThrow({ sidecarPath });
  }, (err) => {
    assert.match(err.message, /FAIL-CLOSED/);
    assert.match(err.message, /no se pudo leer/);
    assert.match(err.message, /no arranca sin sidecar/i);
    return true;
  });
});

test('CA-4 #4b · sidecar corrupto (JSON inválido) → loadExclusionsOrThrow lanza', () => {
  const tmp = makeTmpDir('corrupt');
  const sidecarPath = path.join(tmp, 'sidecar.json');
  fs.writeFileSync(sidecarPath, '{ "version": "broken"', 'utf8');
  assert.throws(() => {
    filter.loadExclusionsOrThrow({ sidecarPath });
  }, (err) => {
    assert.match(err.message, /FAIL-CLOSED/);
    assert.match(err.message, /JSON inválido/);
    return true;
  });
});

test('CA-4 #4c · sidecar valida pero falta default_policy → loadExclusionsOrThrow lanza', () => {
  const tmp = makeTmpDir('missing-policy');
  const broken = defaultSidecar();
  delete broken.default_policy;
  const p = writeSidecar(tmp, broken);
  assert.throws(() => {
    filter.loadExclusionsOrThrow({ sidecarPath: p });
  }, /FAIL-CLOSED/);
});

// ─── CA-4 / Test 5 — Provider Anthropic = passthrough ────────────────────────

test('CA-4 #5 · provider anthropic NO aplica exclusión (passthrough)', () => {
  const sidecar = defaultSidecar();
  const paths = [
    'users/src/main/resources/application.conf',
    '.env.production',
    'src/main/kotlin/secrets/Token.kt',
  ];
  const result = filter.filterPathsForProvider({
    paths,
    provider: 'anthropic',
    exclusions: sidecar.exclusions,
    defaultPolicy: sidecar.default_policy,
  });
  assert.equal(result.policy, 'passthrough');
  assert.equal(result.category, 'anthropic');
  assert.deepEqual(result.allowed, paths);
  assert.deepEqual(result.blocked, []);
});

test('CA-4 #5b · provider deterministic también passthrough por default', () => {
  const sidecar = defaultSidecar();
  const paths = ['.env.production', 'users/src/main/resources/application.conf'];
  const result = filter.filterPathsForProvider({
    paths,
    provider: 'deterministic',
    exclusions: sidecar.exclusions,
    defaultPolicy: sidecar.default_policy,
  });
  assert.equal(result.policy, 'passthrough');
  assert.deepEqual(result.allowed, paths);
});

// ─── CA-4 / Test 6 — Patrón con path-traversal → rechazado ───────────────────

test('CA-4 #6a · validateExclusionsSidecar rechaza patrón con segmento ".."', () => {
  const sidecar = defaultSidecar({
    exclusions: [
      { pattern: '../etc/passwd', providers: ['non_anthropic'], motivo: 'traversal' },
    ],
  });
  const result = filter.validateExclusionsSidecar(sidecar);
  assert.equal(result.ok, false);
  // El error puede venir del schema (regex `not`) o del cross-check de compileGlob.
  // Buscamos cualquier mención al pattern problemático.
  const messages = result.errors.map((e) => `${e.path} ${e.message}`).join('\n');
  assert.match(messages, /pattern|\.\./);
});

test('CA-4 #6b · validateExclusionsSidecar rechaza patrón con prefijo absoluto "/"', () => {
  const sidecar = defaultSidecar({
    exclusions: [
      { pattern: '/etc/passwd', providers: ['non_anthropic'], motivo: 'absoluto' },
    ],
  });
  const result = filter.validateExclusionsSidecar(sidecar);
  assert.equal(result.ok, false);
});

test('CA-4 #6c · validateExclusionsSidecar rechaza patrón con prefijo "~/"', () => {
  const sidecar = defaultSidecar({
    exclusions: [
      { pattern: '~/.aws/credentials', providers: ['non_anthropic'], motivo: 'home' },
    ],
  });
  const result = filter.validateExclusionsSidecar(sidecar);
  assert.equal(result.ok, false);
});

test('CA-4 #6d · compileGlob lanza directamente para ".." y absolutos', () => {
  assert.throws(() => filter.compileGlob('../etc/passwd'), /\.\./);
  assert.throws(() => filter.compileGlob('/etc/passwd'), /absoluto/);
  assert.throws(() => filter.compileGlob('~/.aws/credentials'), /absoluto|home/);
});

// ─── CA-5 / Provider no en allowlist → rechazo ───────────────────────────────

test('CA-5 · validateExclusionsSidecar rechaza provider fuera del allowlist (cuando se pasa allowedProviders)', () => {
  const sidecar = defaultSidecar({
    exclusions: [
      { pattern: '**/foo', providers: ['provider-fantasma'], motivo: 'unknown' },
    ],
  });
  const result = filter.validateExclusionsSidecar(sidecar, {
    allowedProviders: ['anthropic', 'deterministic', 'openai-codex'],
  });
  assert.equal(result.ok, false);
  const messages = result.errors.map((e) => e.message).join('\n');
  assert.match(messages, /provider-fantasma/);
});

test('CA-5b · validateExclusionsSidecar acepta provider en allowlist', () => {
  const sidecar = defaultSidecar({
    exclusions: [
      { pattern: '**/foo', providers: ['openai-codex'], motivo: 'provider declarado' },
    ],
  });
  const result = filter.validateExclusionsSidecar(sidecar, {
    allowedProviders: ['anthropic', 'deterministic', 'openai-codex'],
  });
  assert.equal(result.ok, true);
});

// ─── Glob matching: tests del compilador ─────────────────────────────────────

test('compileGlob · ** matchea cualquier profundidad (con y sin slash inicial)', () => {
  const re = filter.compileGlob('**/.env*');
  assert.equal(re.test('.env'), true);
  assert.equal(re.test('.env.production'), true);
  assert.equal(re.test('app/.env'), true);
  assert.equal(re.test('a/b/c/.env.local'), true);
  assert.equal(re.test('config/env.prod'), false, 'env.prod no es .env*');
});

test('compileGlob · "users/src/main/resources/application.conf" matchea exacto', () => {
  const re = filter.compileGlob('users/src/main/resources/application.conf');
  assert.equal(re.test('users/src/main/resources/application.conf'), true);
  assert.equal(re.test('users/src/main/resources/application.conf.bak'), false);
});

test('compileGlob · ** en mitad: "**/secrets/**" matchea cualquier dir secrets', () => {
  const re = filter.compileGlob('**/secrets/**');
  assert.equal(re.test('app/secrets/keys.json'), true);
  assert.equal(re.test('secrets/foo'), true);
  assert.equal(re.test('a/b/secrets/c/d/e'), true);
  assert.equal(re.test('app/sec/foo'), false);
});

test('compileGlob · *.pem matchea solo extensión, no slashes', () => {
  const re = filter.compileGlob('**/*.pem');
  assert.equal(re.test('keys/server.pem'), true);
  assert.equal(re.test('server.pem'), true);
  assert.equal(re.test('server.pem.bak'), false);
});

test('normalizePath · convierte backslashes Windows a forward slashes', () => {
  assert.equal(filter.normalizePath('users\\src\\app.kt'), 'users/src/app.kt');
  assert.equal(filter.normalizePath('./relative/path'), 'relative/path');
});

// ─── Integración: filterPathsForProvider mete por nombre de provider exacto ──

test('Integración · exclusión por nombre de provider concreto matchea ese provider, no otros', () => {
  const sidecar = defaultSidecar({
    exclusions: [
      { pattern: 'special/file.json', providers: ['gemini'], motivo: 'solo gemini' },
    ],
  });
  const r1 = filter.filterPathsForProvider({
    paths: ['special/file.json', 'other/file.json'],
    provider: 'gemini',
    exclusions: sidecar.exclusions,
    defaultPolicy: sidecar.default_policy,
  });
  assert.deepEqual(r1.allowed, ['other/file.json']);
  assert.equal(r1.blocked.length, 1);

  const r2 = filter.filterPathsForProvider({
    paths: ['special/file.json'],
    provider: 'openai-codex',
    exclusions: sidecar.exclusions,
    defaultPolicy: sidecar.default_policy,
  });
  // openai-codex NO está en `providers` de la exclusión → no aplica.
  assert.deepEqual(r2.allowed, ['special/file.json']);
});

// ─── Integración: loadExclusionsOrThrow termina con shape consumible ─────────

test('Integración · loadExclusionsOrThrow del sidecar canónico devuelve shape consumible', () => {
  // El sidecar canónico vive en .pipeline/data-residency-exclusions.json.
  // No paso path → usa CANONICAL_SIDECAR_PATH del módulo.
  const result = filter.loadExclusionsOrThrow();
  assert.ok(result.version);
  assert.match(result.version, /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
  assert.ok(result.default_policy);
  assert.ok(Array.isArray(result.exclusions));
  // Las exclusiones documentadas en CA-2 deben estar (al menos los candidatos
  // explícitos de §6.4).
  const patterns = result.exclusions.map((e) => e.pattern);
  assert.ok(patterns.some((p) => p.includes('.env')), '.env debe estar excluido');
  assert.ok(patterns.some((p) => p.includes('secrets')), 'secrets debe estar excluido');
  assert.ok(patterns.some((p) => p.includes('application.conf')), 'application.conf debe estar excluido');
});

// ─── validateOrExit (boot) — sidecar inválido ────────────────────────────────

test('validateOrExit · sidecar válido devuelve ok:true sin exit', () => {
  let exitCalls = 0;
  const r = filter.validateOrExit({
    sidecarPath: filter.CANONICAL_SIDECAR_PATH,
    schemaPath: filter.CANONICAL_SCHEMA_PATH,
    onErrorWrite: () => {},
    exitFn: () => { exitCalls++; },
  });
  assert.equal(r.ok, true);
  assert.equal(exitCalls, 0);
});

test('validateOrExit · sidecar ausente invoca exitFn(2) + escribe a stderr', () => {
  const writes = [];
  let exited = null;
  filter.validateOrExit({
    sidecarPath: '/path/que/no/existe-data-resid.json',
    schemaPath: filter.CANONICAL_SCHEMA_PATH,
    onErrorWrite: (m) => writes.push(m),
    exitFn: (c) => { exited = c; },
  });
  assert.equal(exited, filter.EXIT_CODES.INVALID_CONFIG);
  assert.match(writes.join('\n'), /FATAL data-residency-exclusions/);
});

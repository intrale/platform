// =============================================================================
// ux-android-actual-lookup.test.js — Tests unitarios (#3408 · CA-3 + CA-S1/S6/S8)
//
// Cobertura:
//   - CA-3: match exacto en docs/, fallback a qa/evidence/, alias resolution,
//     "sin evidencia" -> null
//   - CA-S1: path traversal (../, ..%2F, absoluto, null byte, regex falla)
//   - CA-S6: alias map cerrado (todos los pares iniciales presentes)
//   - Casos negativos: directorio inexistente, archivo no PNG, flavor inválido,
//     prefix-check (`docs/app-screenshots-reference-fake/` no matchea)
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const lookupModule = require('../ux-android-actual-lookup');
const { lookup, describeSource, ALIAS_MAP, PANTALLA_RE, isInsideRoot } = lookupModule;

// -----------------------------------------------------------------------------
// Helpers de fixture
// -----------------------------------------------------------------------------

function mkRepoRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ux-lookup-'));
}

function writePng(absPath, content = 'PNG-FAKE-CONTENT') {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content);
}

function touchMtime(absPath, isoDate) {
  const t = new Date(isoDate);
  fs.utimesSync(absPath, t, t);
}

// -----------------------------------------------------------------------------
// CA-3 — match exacto en docs/app-screenshots-reference/<pantalla>/
// -----------------------------------------------------------------------------

test('CA-3: match exacto en docs/app-screenshots-reference (sin flavor)', () => {
  const root = mkRepoRoot();
  const png = path.join(root, 'docs', 'app-screenshots-reference', 'login', 'login-2026-04-15.png');
  writePng(png);
  const hit = lookup('login', null, { repoRoot: root });
  assert.ok(hit, 'esperaba un hit');
  assert.equal(hit.source, 'docs');
  assert.equal(hit.path, fs.realpathSync(png));
});

test('CA-3: prefiere el archivo más reciente cuando hay varios', () => {
  const root = mkRepoRoot();
  const dir = path.join(root, 'docs', 'app-screenshots-reference', 'login');
  const viejo = path.join(dir, 'login-2026-01-01.png');
  const nuevo = path.join(dir, 'login-2026-05-15.png');
  writePng(viejo);
  writePng(nuevo);
  touchMtime(viejo, '2026-01-01T00:00:00Z');
  touchMtime(nuevo, '2026-05-15T00:00:00Z');
  const hit = lookup('login', null, { repoRoot: root });
  assert.equal(hit.path, fs.realpathSync(nuevo));
});

test('CA-3: con flavor, prefiere archivo cuyo nombre menciona el flavor', () => {
  const root = mkRepoRoot();
  const dir = path.join(root, 'docs', 'app-screenshots-reference', 'login');
  const generic = path.join(dir, 'login-2026-05-20.png');
  const flavorBased = path.join(dir, 'login-client-2026-04-15.png');
  writePng(generic);
  writePng(flavorBased);
  touchMtime(generic, '2026-05-20T00:00:00Z'); // más reciente pero genérico
  touchMtime(flavorBased, '2026-04-15T00:00:00Z');
  const hit = lookup('login', 'client', { repoRoot: root });
  assert.equal(hit.path, fs.realpathSync(flavorBased), 'debe ganar el flavor-specific');
});

// -----------------------------------------------------------------------------
// CA-3 — fallback a qa/evidence/<issue-anterior>/
// -----------------------------------------------------------------------------

test('CA-3: fallback a qa/evidence/<issue>/ux-mockup-actual-*.png cuando no hay en docs', () => {
  const root = mkRepoRoot();
  const issueDir = path.join(root, 'qa', 'evidence', '1234');
  const png = path.join(issueDir, 'ux-mockup-actual-login-2026-04-10.png');
  writePng(png);
  const hit = lookup('login', null, { repoRoot: root });
  assert.ok(hit);
  assert.equal(hit.source, 'qa-evidence');
});

test('CA-3: fallback a qa/evidence/.../screenshot-*.png cuando no hay mockup actual', () => {
  const root = mkRepoRoot();
  const issueDir = path.join(root, 'qa', 'evidence', '5678');
  const png = path.join(issueDir, 'screenshot-login-base.png');
  writePng(png);
  const hit = lookup('login', null, { repoRoot: root });
  assert.ok(hit, 'esperaba hit en screenshot-*');
  assert.equal(hit.source, 'qa-evidence');
});

test('CA-3: entre dos issues con evidencia, prefiere el de mtime más reciente', () => {
  const root = mkRepoRoot();
  const viejoIssue = path.join(root, 'qa', 'evidence', '1000');
  const nuevoIssue = path.join(root, 'qa', 'evidence', '2000');
  const viejo = path.join(viejoIssue, 'ux-mockup-actual-login-old.png');
  const nuevo = path.join(nuevoIssue, 'ux-mockup-actual-login-new.png');
  writePng(viejo);
  writePng(nuevo);
  touchMtime(viejo, '2026-01-01T00:00:00Z');
  touchMtime(nuevo, '2026-05-20T00:00:00Z');
  // mtime de los dirs los hereda el último mtime aplicado
  fs.utimesSync(viejoIssue, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
  fs.utimesSync(nuevoIssue, new Date('2026-05-20T00:00:00Z'), new Date('2026-05-20T00:00:00Z'));
  const hit = lookup('login', null, { repoRoot: root });
  assert.ok(hit);
  assert.equal(hit.path, fs.realpathSync(nuevo));
});

// -----------------------------------------------------------------------------
// CA-3 — alias resolution
// -----------------------------------------------------------------------------

test('CA-3: alias signin -> login', () => {
  const root = mkRepoRoot();
  const png = path.join(root, 'docs', 'app-screenshots-reference', 'login', 'login-2026-04-15.png');
  writePng(png);
  const hit = lookup('signin', null, { repoRoot: root });
  assert.ok(hit, 'esperaba match vía alias');
  assert.equal(hit.source, 'docs');
  assert.deepEqual(hit.alias, { from: 'signin', to: 'login' });
});

test('CA-3: alias login -> signin (par bidireccional)', () => {
  const root = mkRepoRoot();
  const png = path.join(root, 'docs', 'app-screenshots-reference', 'signin', 'signin-2026-04-15.png');
  writePng(png);
  const hit = lookup('login', null, { repoRoot: root });
  assert.ok(hit);
  assert.deepEqual(hit.alias, { from: 'login', to: 'signin' });
});

test('CA-3: describeSource arma label con alias', () => {
  const hit = { source: 'docs', alias: { from: 'signin', to: 'login' } };
  assert.equal(describeSource(hit), 'docs (alias signin->login)');
});

test('CA-3: describeSource sin alias devuelve solo el source', () => {
  assert.equal(describeSource({ source: 'qa-evidence' }), 'qa-evidence');
});

test('CA-3: describeSource(null) devuelve "none"', () => {
  assert.equal(describeSource(null), 'none');
});

// -----------------------------------------------------------------------------
// CA-3 — "sin evidencia" → null
// -----------------------------------------------------------------------------

test('CA-3: sin evidencia disponible → null (no throws)', () => {
  const root = mkRepoRoot();
  const hit = lookup('carrito', null, { repoRoot: root });
  assert.equal(hit, null);
});

test('CA-3: repo sin docs/ ni qa/evidence/ → null', () => {
  const root = mkRepoRoot();
  // root completamente vacío
  assert.equal(lookup('login', 'client', { repoRoot: root }), null);
});

// -----------------------------------------------------------------------------
// CA-S1 — path traversal (validación regex)
// -----------------------------------------------------------------------------

test('CA-S1: pantalla con `../` → null', () => {
  const root = mkRepoRoot();
  assert.equal(lookup('../etc/passwd', null, { repoRoot: root }), null);
});

test('CA-S1: pantalla con `..%2F` (URL-encoded) → null', () => {
  const root = mkRepoRoot();
  assert.equal(lookup('..%2Fqa%2Fevidence', null, { repoRoot: root }), null);
});

test('CA-S1: pantalla con ruta absoluta → null', () => {
  const root = mkRepoRoot();
  assert.equal(lookup('/etc/passwd', null, { repoRoot: root }), null);
});

test('CA-S1: pantalla con null byte → null', () => {
  const root = mkRepoRoot();
  assert.equal(lookup('login\0.png', null, { repoRoot: root }), null);
});

test('CA-S1: pantalla con mayúsculas → null (regex es [a-z0-9-])', () => {
  const root = mkRepoRoot();
  writePng(path.join(root, 'docs', 'app-screenshots-reference', 'Login', 'x.png'));
  assert.equal(lookup('Login', null, { repoRoot: root }), null);
});

test('CA-S1: pantalla con caracteres especiales (.,/) → null', () => {
  const root = mkRepoRoot();
  assert.equal(lookup('login.txt', null, { repoRoot: root }), null);
  assert.equal(lookup('login/profile', null, { repoRoot: root }), null);
  assert.equal(lookup('login\\windows', null, { repoRoot: root }), null);
});

test('CA-S1: pantalla muy larga (>40 chars) → null', () => {
  const root = mkRepoRoot();
  const tooLong = 'a'.repeat(41);
  assert.equal(lookup(tooLong, null, { repoRoot: root }), null);
});

test('CA-S1: pantalla vacía → null', () => {
  const root = mkRepoRoot();
  assert.equal(lookup('', null, { repoRoot: root }), null);
});

test('CA-S1: pantalla no-string → null (no throws)', () => {
  const root = mkRepoRoot();
  assert.equal(lookup(undefined, null, { repoRoot: root }), null);
  assert.equal(lookup(null, null, { repoRoot: root }), null);
  assert.equal(lookup(123, null, { repoRoot: root }), null);
  assert.equal(lookup({ pantalla: 'login' }, null, { repoRoot: root }), null);
});

test('CA-S1: flavor inválido se ignora silenciosamente (no rompe), busca sin filtro', () => {
  const root = mkRepoRoot();
  const png = path.join(root, 'docs', 'app-screenshots-reference', 'login', 'login.png');
  writePng(png);
  // flavor 'hacker' no es válido pero no debe romper — busca como sin flavor
  const hit = lookup('login', 'hacker', { repoRoot: root });
  assert.ok(hit, 'flavor inválido se ignora, pero el lookup sin filtro sigue');
});

test('CA-S1: prefix-check estricto — `docs/app-screenshots-reference-fake/login/` NO matchea', () => {
  const root = mkRepoRoot();
  // Creamos un directorio "vecino" que comparte prefijo pero no es el root válido.
  const evilPath = path.join(root, 'docs', 'app-screenshots-reference-fake', 'login', 'x.png');
  writePng(evilPath);
  const hit = lookup('login', null, { repoRoot: root });
  assert.equal(hit, null, 'no debería matchear el directorio fake');
});

test('CA-S1: isInsideRoot — verifica prefix con separator', () => {
  const root = '/tmp/foo';
  assert.equal(isInsideRoot('/tmp/foo/bar.png', root), true);
  assert.equal(isInsideRoot('/tmp/foo', root), true);
  assert.equal(isInsideRoot('/tmp/foobar.png', root), false, 'foobar no es subdir de foo');
  assert.equal(isInsideRoot('/etc/passwd', root), false);
});

// -----------------------------------------------------------------------------
// CA-S6 — alias map cerrado (todos los pares iniciales)
// -----------------------------------------------------------------------------

test('CA-S6: pares iniciales obligatorios presentes en ALIAS_MAP', () => {
  const pares = [
    ['signin', 'login'],
    ['signup', 'register'],
    ['home', 'dashboard'],
    ['cart', 'carrito'],
    ['checkout', 'pago'],
    ['orders', 'pedidos'],
    ['profile', 'perfil'],
    ['settings', 'configuracion'],
  ];
  for (const [a, b] of pares) {
    assert.equal(ALIAS_MAP[a], b, `alias ${a} -> ${b}`);
    assert.equal(ALIAS_MAP[b], a, `alias ${b} -> ${a} (bidireccional)`);
  }
});

test('CA-S6: ALIAS_MAP es inmutable (Object.freeze)', () => {
  assert.equal(Object.isFrozen(ALIAS_MAP), true);
});

// -----------------------------------------------------------------------------
// Regex de validación pantalla
// -----------------------------------------------------------------------------

test('PANTALLA_RE: matchea ejemplos válidos', () => {
  assert.ok(PANTALLA_RE.test('login'));
  assert.ok(PANTALLA_RE.test('home-cliente'));
  assert.ok(PANTALLA_RE.test('orders-123'));
  assert.ok(PANTALLA_RE.test('a'));
  assert.ok(PANTALLA_RE.test('a'.repeat(40)));
});

test('PANTALLA_RE: rechaza inválidos', () => {
  assert.equal(PANTALLA_RE.test(''), false);
  assert.equal(PANTALLA_RE.test('Login'), false);
  assert.equal(PANTALLA_RE.test('a'.repeat(41)), false);
  assert.equal(PANTALLA_RE.test('login.png'), false);
  assert.equal(PANTALLA_RE.test('login/x'), false);
});

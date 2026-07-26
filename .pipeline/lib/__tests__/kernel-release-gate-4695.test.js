'use strict';
/**
 * Regresión de CRITICAL-1 (#4695 · auditoría 2026-07-26): la transformación del
 * gate de publicación del kernel se rompía con finales de línea CRLF — borraba el
 * gate humano y dejaba vivo el disparo automático por push de tag, en silencio.
 *
 * Los tests corren sobre el YAML REAL del repo, y la mitad lo hacen con el archivo
 * convertido a CRLF a propósito: es la condición exacta que produjo el fallo.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { applyGate, assertGateSafety, normalizeEol, dropChildBlock } =
  require(path.join(__dirname, '..', 'kernel-release-gate.js'));

const PROPOSED_YML = path.join(__dirname, '..', '..', '..', 'docs', 'pipeline', 'kernel-release-workflow.proposed.yml');

const REAL_LF = normalizeEol(fs.readFileSync(PROPOSED_YML, 'utf8'));
const REAL_CRLF = REAL_LF.replace(/\n/g, '\r\n');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ─── El fallo original, en las dos codificaciones ────────────────────────────

for (const [eol, source] of [['LF', REAL_LF], ['CRLF', REAL_CRLF]]) {
  test(`gate=dispatch elimina el trigger por push de tag (${eol})`, () => {
    const out = applyGate(source, 'dispatch');
    assert.ok(!/^\s+push:/m.test(out), 'el trigger on.push sobrevivio a la transformacion');
    assert.ok(!/v\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+/.test(out), 'el filtro de tags sobrevivio');
    assert.ok(/workflow_dispatch:/.test(out), 'se perdio workflow_dispatch: el workflow quedaria inejecutable');
  });

  test(`gate=dispatch pasa la verificacion fail-closed (${eol})`, () => {
    assert.strictEqual(assertGateSafety(applyGate(source, 'dispatch'), 'dispatch'), true);
  });

  test(`gate=environment conserva el gate humano y el trigger (${eol})`, () => {
    const out = applyGate(source, 'environment');
    assert.ok(/^\s+environment: release/m.test(out), 'se perdio el environment: release');
    assert.ok(/^\s+push:/m.test(out), 'se perdio el trigger por tag');
    assert.strictEqual(assertGateSafety(out, 'environment'), true);
  });

  test(`la salida siempre queda en LF (${eol})`, () => {
    assert.ok(!applyGate(source, 'dispatch').includes('\r'), 'quedaron CR en la salida');
  });
}

// ─── La aserción tiene que RECHAZAR la combinación exacta del bug ────────────

test('assertGateSafety rechaza gate=dispatch con el trigger push vivo', () => {
  // Reproduce el bug: se saca el environment pero se deja el push (lo que hacian
  // los regex viejos sobre un archivo CRLF).
  const roto = REAL_LF.replace(/^    environment: release.*$/m, '    # gate humano = disparo manual');
  assert.throws(
    () => assertGateSafety(roto, 'dispatch'),
    /on\.push` sigue presente/,
    'la asercion dejo pasar un workflow que publicaria solo'
  );
});

test('assertGateSafety rechaza gate=environment sin environment en publish', () => {
  const roto = REAL_LF.replace(/^    environment: release.*$/m, '    # sin gate');
  assert.throws(() => assertGateSafety(roto, 'environment'), /no declara `environment: release`/);
});

test('assertGateSafety rechaza un workflow sin ningun trigger', () => {
  const sinDispatch = dropChildBlock(dropChildBlock(REAL_LF, 'on', 'push').yml, 'on', 'workflow_dispatch').yml;
  assert.throws(() => assertGateSafety(sinDispatch, 'dispatch'), /workflow_dispatch/);
});

// ─── Invariantes de seguridad del YAML propuesto (HIGH-1 / HIGH-2) ──────────

test('ningun run: interpola ${{ }} (HIGH-1 · script injection)', () => {
  assert.strictEqual(assertGateSafety(REAL_LF, 'environment'), true);
});

test('las tres actions estan pineadas por SHA de 40 (HIGH-2)', () => {
  const uses = REAL_LF.split('\n').filter((l) => /^\s+uses:/.test(l));
  assert.ok(uses.length >= 3, `se esperaban al menos 3 actions, hay ${uses.length}`);
  for (const u of uses) {
    assert.ok(/@[0-9a-f]{40}\s*(#.*)?$/.test(u.trim()), `action sin pin por SHA: ${u.trim()}`);
  }
});

test('el tarball se empaqueta una sola vez y se publica ese mismo (MEDIUM-1)', () => {
  assert.ok(/npm publish "\$BLOB"/.test(REAL_LF), 'npm publish no usa el tarball empaquetado');
  assert.strictEqual((REAL_LF.match(/npm pack/g) || []).length, 1, 'npm pack aparece mas de una vez');
});

test('el job publish no ejecuta scripts de dependencias de terceros (MEDIUM-3)', () => {
  const ci = REAL_LF.split('\n').filter((l) => /npm ci\b/.test(l));
  assert.ok(ci.length >= 1, 'no se encontro el paso npm ci');
  for (const l of ci) {
    assert.ok(
      /--ignore-scripts/.test(l),
      `npm ci sin --ignore-scripts en el job que firma y publica: ${l.trim()}`
    );
  }
});

test('el input tag se valida contra semver antes de cualquier checkout (MEDIUM-2)', () => {
  assert.ok(/\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/.test(REAL_LF), 'falta la validacion de formato del tag');
  assert.ok(/ref: refs\/tags\//.test(REAL_LF), 'el checkout no usa la ref calificada refs/tags/');
});

// ─── Runner ─────────────────────────────────────────────────────────────────

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${name}\n       ${e.message.split('\n')[0]}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} tests OK`);
process.exit(failed ? 1 : 0);

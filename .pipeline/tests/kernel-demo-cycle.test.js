// =============================================================================
// kernel-demo-cycle.test.js — E2E de la demo del ciclo del kernel (#4700 · CA-D2)
// Cubre: avance por fase dev->build->QA->delivery, target verificado en cada
// fase mutante (CA-D2.2), abort ante target = intrale/platform (blast radius),
// delivery sin auto-merge/sin main/token scoped (CA-D2.3) y lockfile pineado
// (CA-D2.4).
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Rebote #4732: el harness (`bootstrap`) hace `execSync('npm ci ...')`, que
// hereda `process.env.PATH`. Cuando el tester determinístico spawnea
// `node --test` con un PATH stripped (pulpo como servicio Windows, misma causa
// que git en #2891), `npm` no está en el PATH y estos tests fallan con
// `"npm" no se reconoce como un comando interno o externo`. Garantizamos `npm`
// en el PATH del proceso ANTES de requerir el harness — el fix vive en el
// worktree (este archivo), así no depende de que el tester de `main` lo tenga.
require('../lib/ensure-npm-in-path').ensureNpmInProcessPath();

const HARNESS = path.join(__dirname, '..', '..', 'fixtures', 'demo', 'run-cycle.js');
const {
  runCycle,
  verifyTarget,
  bootstrap,
  deliver,
  AbortError,
  __constants__,
} = require(HARNESS);

const BUNDLED_TARGET = path.join(__dirname, '..', '..', 'fixtures', 'demo', 'target');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Copia el target bundled a un dir nuevo (para casos que mutan el marker).
function copyTarget(dest) {
  fs.cpSync(BUNDLED_TARGET, dest, {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}node_modules${path.sep}`),
  });
  return dest;
}

test('el ciclo completo avanza dev->build->QA->delivery con trail correcto', () => {
  const { summary, trail, verifications } = runCycle({ runDir: mkTmp('demo-run-') });
  assert.equal(summary.ok, true);
  assert.deepEqual(trail, ['pendiente', 'trabajando', 'listo', 'procesado']);
  // Las 3 fases mutantes quedaron verificadas.
  assert.deepEqual(
    verifications.map((v) => v.phase),
    ['build', 'qa', 'delivery']
  );
  for (const v of verifications) {
    assert.equal(v.ok, true);
    assert.equal(v.projectId, 'kernel-fixtures');
    assert.match(v.line, /target = kernel-fixtures \(verificado\)/);
  }
});

test('cada fase mutante deja evidencia con target verificado', () => {
  const runDir = mkTmp('demo-ev-');
  const { evidence } = runCycle({ runDir });
  const mutantes = evidence.filter((e) => e.mutating);
  assert.deepEqual(mutantes.map((e) => e.phase), ['build', 'qa', 'delivery']);
  for (const e of mutantes) {
    assert.ok(e.targetVerification, `fase ${e.phase} sin targetVerification`);
    assert.equal(e.targetVerification.repo, 'intrale/kernel');
    // Artefacto de evidencia por fase persistido.
    assert.ok(fs.existsSync(path.join(runDir, `phase-${e.phase}.json`)));
  }
  assert.ok(fs.existsSync(path.join(runDir, 'summary.json')));
});

test('verifyTarget ABORTA si el marker declara repo intrale/platform (blast radius)', () => {
  const dir = copyTarget(mkTmp('demo-bad-repo-'));
  const markerFile = path.join(dir, '.kernel-target.json');
  const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
  marker.repo = 'intrale/platform';
  fs.writeFileSync(markerFile, JSON.stringify(marker));

  assert.throws(
    () => verifyTarget(dir, { phase: 'build', platformRoot: path.join(os.tmpdir(), '__none__') }),
    (err) => err instanceof AbortError && /intrale\/platform/.test(err.message)
  );
});

test('verifyTarget ABORTA si el target resuelve dentro de intrale/platform', () => {
  const dir = copyTarget(mkTmp('demo-inside-'));
  // Simulamos que el platformRoot es el padre del target -> debe abortar.
  const fakePlatformRoot = path.dirname(fs.realpathSync(dir));
  assert.throws(
    () => verifyTarget(dir, { phase: 'delivery', platformRoot: fakePlatformRoot }),
    (err) => err instanceof AbortError && /DENTRO de intrale\/platform/.test(err.message)
  );
});

test('verifyTarget ABORTA si falta el marker de identidad', () => {
  const dir = copyTarget(mkTmp('demo-nomarker-'));
  fs.rmSync(path.join(dir, '.kernel-target.json'));
  assert.throws(
    () => verifyTarget(dir, { phase: 'qa', platformRoot: path.join(os.tmpdir(), '__none__') }),
    (err) => err instanceof AbortError && /marker/.test(err.message)
  );
});

test('bootstrap RECHAZA rangos abiertos en el package.json del target (supply chain)', () => {
  const dir = copyTarget(mkTmp('demo-openrange-'));
  const pkgFile = path.join(dir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  pkg.dependencies = { 'some-lib': '^1.0.0' };
  fs.writeFileSync(pkgFile, JSON.stringify(pkg));
  assert.throws(
    () => bootstrap(dir),
    (err) => err instanceof AbortError && /rangos abiertos/.test(err.message)
  );
});

test('bootstrap con lockfile pineado corre npm ci sin dependencias externas', () => {
  const dir = copyTarget(mkTmp('demo-ci-'));
  const boot = bootstrap(dir);
  assert.equal(boot.tool, 'npm ci');
  assert.equal(boot.openRanges, 0);
  assert.ok(boot.lockfileVersion >= 2);
});

test('deliver corre dry-run: sin auto-merge, sin main, token scoped (CA-D2.3)', () => {
  const dir = copyTarget(mkTmp('demo-deliver-'));
  const runDir = mkTmp('demo-deliver-run-');
  const { manifest, manifestFile } = deliver(dir, { runDir });
  assert.equal(manifest.dryRun, true);
  assert.equal(manifest.executed, false);
  assert.equal(manifest.autoMerge, false);
  assert.equal(manifest.mergeToMain, false);
  assert.equal(manifest.sign, false);
  assert.equal(manifest.targetRepo, 'intrale/kernel');
  assert.notEqual(manifest.targetRepo, 'intrale/platform');
  assert.match(manifest.tokenScope, /^repo:intrale\/kernel:/);
  assert.ok(fs.existsSync(manifestFile));
});

test('las constantes de política declaran kernel permitido y platform prohibido', () => {
  assert.equal(__constants__.ALLOWED_REPO, 'intrale/kernel');
  assert.equal(__constants__.FORBIDDEN_REPO, 'intrale/platform');
  assert.equal(__constants__.EXPECTED_PROJECT_ID, 'kernel-fixtures');
  assert.ok(__constants__.MUTATING_PHASES.has('build'));
  assert.ok(__constants__.MUTATING_PHASES.has('qa'));
  assert.ok(__constants__.MUTATING_PHASES.has('delivery'));
  assert.ok(!__constants__.MUTATING_PHASES.has('dev'));
});

#!/usr/bin/env node
// =============================================================================
// scripts/test-pipeline.js — runner canonico de la suite del pipeline (#7082)
//
// Reemplaza el glob `node --test ".pipeline/**/*.test.js" ...` de `package.json`,
// que arrastraba los `*.test.js` de los scratchpads gitignoreados
// (`.pipeline/tmp`, `.pipeline/_tmp`, `.pipeline/tmp-*`: >2000 archivos nunca
// revisados, muchos con `child_process`/`https`). `node --test` no soporta
// negacion de globs, asi que la exclusion se resuelve aca y la suite se lanza con
// `run({ files })` de `node:test` (evita ademas el limite de largo de linea de
// comandos en Windows).
//
// Contrato (CA-4 / SEC-2 / SEC-6 de #7082):
//   * Mismos 4 origenes que el glob historico — el universo NO se amplia.
//   * Se excluye por CADA segmento de directorio (`tmp*`, `_tmp`, `node_modules`),
//     no solo el primer nivel. Un ARCHIVO llamado `tmp-algo.test.js` dentro de
//     un directorio legitimo SI entra: se poda por directorio, no por nombre.
//   * No sigue symlinks ni junctions: todo archivo cuyo `realpath` difiera de su
//     ruta, o caiga fuera del repo, se descarta (fail-closed).
//   * Lista en stderr (`?? <ruta>`) los tests que va a ejecutar y NO estan
//     versionados; con `--tracked-only` los excluye de la corrida.
//   * Rutas relativas al repo con `/` (estables entre Windows y CI).
//   * Sin `env` explicito en `run()`: hereda `process.env` igual que `node --test`.
//     NUNCA serializa ni loguea `process.env`.
//   * #7112 (CA-4): antes de `run()` provee el DIR DE PRUEBAS en un unico punto
//     (`lib/test-run-dir.js`): `PIPELINE_DIR_OVERRIDE` a un `mkdtemp` bajo
//     `os.tmpdir()` (nunca bajo `.pipeline/tmp/`) que los hijos heredan y se
//     borra al terminar (tambien ante fallo/senal). Si ya venia seteado, se
//     respeta y no se borra. Con el default invertido, el test que no dice nada
//     cae ahi y no en el `.pipeline` productivo.
//   * Exit code 1 si algun test falla o si no se encontro NINGUN archivo (correr
//     "verde" con 0 tests es el falso positivo que esta historia elimina).
//
// Uso:
//   node scripts/test-pipeline.js                  # corre la suite (reporter spec)
//   node scripts/test-pipeline.js --tracked-only   # solo archivos versionados
//   node scripts/test-pipeline.js --list           # una ruta por linea, sin correr
//   node scripts/test-pipeline.js --reporter=tap   # reporter TAP
//
// Requiere Node >= 22.17 (`fs.globSync`, `node:test.run` estables). Sin
// dependencias npm.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { isScratchDirName } = require('../.pipeline/lib/scratch-dirs');
const { ensureTestRunDir } = require('../.pipeline/lib/test-run-dir');

// Mismos 4 origenes que el glob historico de package.json — no se amplia el universo.
const PATTERNS = Object.freeze([
  '.pipeline/**/*.test.js',
  'qa/scripts/__tests__/**/*.test.js',
  'scripts/**/*.test.js',
  '.claude/hooks/tests/test-p09-telegram-client.js',
]);

// Pathspecs equivalentes para `git ls-files` (acotados a tests: el pathspec por
// directorio devolvia ~2 MB de untracked en el checkout principal y reventaba
// `execFileSync` con ENOBUFS).
const GIT_PATHSPECS = Object.freeze([
  ':(glob).pipeline/**/*.test.js',
  ':(glob)qa/scripts/__tests__/**/*.test.js',
  ':(glob)scripts/**/*.test.js',
  '.claude/hooks/tests/test-p09-telegram-client.js',
]);

const GIT_MAX_BUFFER = 64 * 1024 * 1024;

function isExcludedDirName(name) {
  return name === 'node_modules' || isScratchDirName(name);
}

/**
 * SEC-2: se decide por CADA segmento de DIRECTORIO de la ruta relativa
 * (`tmp*`, `_tmp`, `node_modules`), nunca por el nombre del archivo.
 */
function isExcludedRelPath(rel) {
  if (typeof rel !== 'string' || rel === '') return true;
  return rel.split(/[\\/]+/).slice(0, -1).some(isExcludedDirName);
}

function toPosix(rel) {
  return rel.split(path.sep).join('/');
}

/**
 * Devuelve las rutas (relativas al repo, con `/`, ordenadas) de los tests que
 * entran a la corrida. Doble filtro: `exclude` de `globSync` poda por directorio
 * (con `withFileTypes: true` recibe un Dirent; en modo string recibe una mezcla
 * de nombres y rutas relativas, verificado en Node 24.13.1) y despues se
 * re-filtra el resultado con `isExcludedRelPath`, porque `exclude` no es un
 * contrato estable entre versiones.
 */
function collectTestFiles({ repoRoot }) {
  if (!repoRoot) throw new TypeError('collectTestFiles: falta `repoRoot`');
  const root = path.resolve(repoRoot);
  const rootReal = fs.realpathSync(root).toLowerCase();
  const found = fs.globSync(PATTERNS, {
    cwd: root,
    withFileTypes: true,
    exclude: (e) => typeof e === 'object' && e !== null && typeof e.isDirectory === 'function'
      ? (e.isDirectory() && isExcludedDirName(e.name))
      : false,
  });
  const out = new Set();
  for (const e of found) {
    const parent = e.parentPath !== undefined ? e.parentPath : e.path;
    const abs = path.resolve(parent, e.name);
    const rel = path.relative(root, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    if (isExcludedRelPath(rel)) continue;
    let real;
    let stat;
    try {
      real = fs.realpathSync(abs);
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    // SEC-2: ningun symlink/junction en ningun segmento y realpath dentro del repo.
    if (real.toLowerCase() !== abs.toLowerCase()) continue;
    if (!real.toLowerCase().startsWith(rootReal + path.sep)) continue;
    out.add(toPosix(rel));
  }
  return Array.from(out).sort();
}

/**
 * Lee de git los `*.test.js` no versionados dentro de los 4 origenes. Tira si
 * git no responde: el llamador decide si eso es fatal (`--tracked-only`) o solo
 * un aviso.
 */
function gitUntrackedTestFiles({ repoRoot }) {
  const out = execFileSync('git',
    ['-C', path.resolve(repoRoot), 'ls-files', '--others', '--exclude-standard', '--', ...GIT_PATHSPECS],
    { encoding: 'utf8', windowsHide: true, maxBuffer: GIT_MAX_BUFFER, stdio: ['ignore', 'pipe', 'ignore'] });
  return new Set(out.split(/\r?\n/).filter(Boolean).map((l) => l.replace(/\\/g, '/')));
}

/** Devuelve el subconjunto de `files` que git reporta como no versionado. */
function listUntracked({ repoRoot, files }) {
  const untracked = gitUntrackedTestFiles({ repoRoot });
  return files.filter((f) => untracked.has(f));
}

function parseArgs(argv) {
  const opts = { trackedOnly: false, listOnly: false, reporter: 'spec' };
  for (const a of argv) {
    if (a === '--tracked-only') opts.trackedOnly = true;
    else if (a === '--list') opts.listOnly = true;
    else if (a.startsWith('--reporter=')) opts.reporter = a.slice('--reporter='.length);
    else throw new Error('[test-pipeline] argumento desconocido: ' + a);
  }
  if (opts.reporter !== 'spec' && opts.reporter !== 'tap') {
    throw new Error('[test-pipeline] --reporter admite `spec` o `tap`, recibido: ' + opts.reporter);
  }
  return opts;
}

function main(argv = process.argv.slice(2), { repoRoot = path.resolve(__dirname, '..'), stdout = process.stdout, stderr = process.stderr } = {}) {
  // `run()` llamado desde adentro de un archivo de test saltea en silencio y
  // reporta verde ("is being called recursively ... skipping running files").
  // Ese falso verde se hace imposible aca.
  if (process.env.NODE_TEST_CONTEXT) {
    stderr.write('[test-pipeline] no se puede correr dentro de node --test (run() recursivo saltea en silencio) — abortando (exit 1)\n');
    process.exitCode = 1;
    return;
  }

  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    stderr.write(e.message + '\n');
    process.exitCode = 2;
    return;
  }

  let files = collectTestFiles({ repoRoot });

  let untracked = [];
  try {
    untracked = listUntracked({ repoRoot, files });
  } catch (e) {
    const code = e && e.code ? ' (' + e.code + ')' : '';
    if (opts.trackedOnly) {
      stderr.write('[test-pipeline] --tracked-only exige consultar git y fallo' + code + ' — abortando (exit 1)\n');
      process.exitCode = 1;
      return;
    }
    stderr.write('[test-pipeline] aviso: no se pudo consultar git' + code + '; no se distingue tracked de untracked\n');
  }

  if (untracked.length) {
    // SEC-2: siempre se LISTA lo no versionado que entra a la corrida; con
    // --tracked-only se excluye. Cero untracked = silencio.
    stderr.write('[test-pipeline] ' + untracked.length + ' archivo(s) de test NO versionados'
      + (opts.trackedOnly ? ' (excluidos por --tracked-only)' : ' (se ejecutan)') + ':\n');
    for (const f of untracked) stderr.write('  ?? ' + f + '\n');
    if (!opts.trackedOnly) {
      stderr.write('  -> para correr solo lo versionado: npm run test:pipeline:tracked\n');
    } else {
      const set = new Set(untracked);
      files = files.filter((f) => !set.has(f));
    }
  }

  if (opts.listOnly) {
    for (const f of files) stdout.write(f + '\n');
    return;
  }

  if (files.length === 0) {
    stderr.write('[test-pipeline] 0 archivos de test encontrados bajo ' + repoRoot + ' — abortando (exit 1)\n');
    process.exitCode = 1;
    return;
  }

  stderr.write('[test-pipeline] ' + files.length + ' archivos\n');

  // Se requieren recien aca: `--list` y los errores de args no necesitan node:test.
  const { run } = require('node:test');
  const reporters = require('node:test/reporters');
  const reporter = opts.reporter === 'tap' ? reporters.tap : reporters.spec;

  // #7112 · CA-4 — dir efimero de pruebas, UN solo punto, antes de spawnear.
  // El helper deja `PIPELINE_DIR_OVERRIDE` en el env del proceso (su default):
  // es lo que heredan los hijos. SEC-6 sigue valiendo: no se pasa `env`
  // explicito a `run()` ni se serializa nada.
  const runDir = ensureTestRunDir({
    pipelineDir: path.join(repoRoot, '.pipeline'),
    log: (l) => stderr.write('[test-pipeline] ' + l + '\n'),
  });
  // El borrado tambien cuelga de `exit`/senales (dentro del helper); aca se
  // adelanta al cierre del stream para que la linea "borrado" salga antes del
  // resumen del reporter cuando la corrida termina bien.
  process.once('beforeExit', () => runDir.limpiar());

  // SEC-6: sin `env` explicito -> hereda process.env igual que `node --test` hoy.
  const stream = run({
    files: files.map((f) => path.join(repoRoot, f)),
    concurrency: true,
  });
  stream.on('test:fail', () => { process.exitCode = 1; });
  stream.on('error', (e) => {
    stderr.write('[test-pipeline] error del runner: ' + (e && e.message ? e.message : String(e)) + '\n');
    process.exitCode = 1;
  });
  stream.compose(reporter).pipe(stdout);
}

module.exports = {
  PATTERNS,
  GIT_PATHSPECS,
  isExcludedRelPath,
  collectTestFiles,
  gitUntrackedTestFiles,
  listUntracked,
  parseArgs,
  main,
};

if (require.main === module) main();

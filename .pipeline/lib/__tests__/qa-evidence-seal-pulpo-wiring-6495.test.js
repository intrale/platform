// =============================================================================
// #6495 (rebote 6) · CA-2 — La traza de descarte tiene que sobrevivir al ÚNICO
// llamador de producción, no sólo al módulo invocado aislado.
//
// Por qué existe este archivo aparte de `qa-evidence-seal.test.js`:
//
//   `stripDeclaredSeal` es DESTRUCTIVO. El Pulpo lo corre sobre todo dropfile
//   de qa/verificación antes de los gates, y `sealQaVerdict` lo repite. La
//   suite del módulo llama a `sealQaVerdict` aislado, así que nunca cruza el
//   strip previo: los 61 tests quedaban en verde mientras en producción el
//   sello se persistía con `descartes: []` y la auditoría de CA-2 —la que las
//   partes 2-5 del split leen como autoridad— se perdía entera.
//
// La regla de oro acá es la misma que en `ux-estado-operador-5176.test.js`: el
// assert va sobre la SALIDA DEL BLOQUE REAL DE `pulpo.js`, extraído por
// marcador textual y ejecutado en `vm` con stubs, no sobre una reimplementación
// del cableado en el test. Un test que reconstruye a mano `strip(); seal()`
// pasa en verde el día que alguien cambia el orden en el Pulpo.
//
// Si el marcador deja de matchear, el test FALLA con un mensaje explícito: es
// deliberado. Mover el bloque obliga a revisar que el cableado siga entero.
// =============================================================================
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const qaEvidenceSeal = require('../qa-evidence-seal');
const { sealQaVerdict, mergeDeclaredSnapshots } = qaEvidenceSeal;

const PULPO = path.resolve(__dirname, '..', '..', 'pulpo.js');
const REPO = path.resolve(__dirname, '..', '..', '..');

// Marcadores del bloque de producción: desde el descarte del sello declarado
// hasta el recorder de #5708 (excluido). Cubre strip → gate de evidencia →
// sellado, que es exactamente el orden obligatorio del issue.
const START = '// #6495 (rebote 5, seguridad) — El sello lo DERIVA el pipeline';
const END = '// #5708: una aprobación visual también es una pasada auditable';

function extraerBloqueOnExit() {
  const src = fs.readFileSync(PULPO, 'utf8');
  const desde = src.indexOf(START);
  const hasta = src.indexOf(END);
  assert.ok(desde > 0, `no se encontró el marcador de inicio en pulpo.js: ${START}`);
  assert.ok(hasta > desde, `no se encontró el marcador de fin después del inicio: ${END}`);
  return src.slice(desde, hasta);
}

function fixture(t, issue = 6258) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-seal-wiring-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'qa', 'evidence', String(issue));
  fs.mkdirSync(dir, { recursive: true });
  const write = (name, content = 'evidencia real') => {
    fs.writeFileSync(path.join(dir, name), content);
    return `qa/evidence/${issue}/${name}`;
  };
  return { root, dir, issue, write };
}

const sha = content => `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;

/**
 * Corre el BLOQUE REAL del on-exit del Pulpo sobre `data` y devuelve el sello
 * que quedaría persistido en el dropfile.
 */
function correrOnExitReal({ root, issue, data, spawnCwd = REPO }) {
  const telegramas = [];
  const contexto = {
    skill: 'qa',
    fase: 'verificacion',
    issue,
    data,
    extraEnv: { QA_MODE: 'android' },
    // En produccion `spawnCwd` es el WORKTREE del agente, no ROOT: `verificacion`
    // esta en EXISTING_WORKTREE_PHASES (`lib/phase-workspace.js:32`).
    spawnCwd,
    workingPath: path.join(root, 'trabajando.yaml'),
    ROOT: root,
    qaEvidenceSeal,
    log: () => {},
    sendTelegram: mensaje => telegramas.push(mensaje),
    writeYaml: () => {},
    redactSecretValue: value => value,
    // El gate hermano no es el sujeto del test: se stubea permisivo para que el
    // veredicto llegue al sellado igual que en un QA android con evidencia OK.
    resolveQaEvidenceEnforcement: () => ({ bypassed: false, motivo: '' }),
    validateQaEvidence: () => [],
    console,
  };
  vm.createContext(contexto);
  vm.runInContext(`(function () {\n${extraerBloqueOnExit()}\n})()`, contexto);
  return { sello: data.sello, telegramas };
}

// ─── CA-2 · artefacto único: los DOS llamadores dejan la misma traza ─────────

test('#6495 CA-2 · el bloque real del on-exit deja la MISMA traza de descarte que el sellado aislado', t => {
  const f = fixture(t);
  const ruta = f.write('qa-6258-structural.md', 'bytes canónicos');
  const real = sha('bytes canónicos');
  const declarado = 'a'.repeat(64);
  const dropfile = () => ({
    resultado: 'aprobado', modo: 'android', evidencia: ruta, evidencia_sha256: declarado,
  });
  const esperado = [{ campo: 'evidencia_sha256', declarado: `sha256:${declarado}`, real }];

  // Camino de producción: strip del Pulpo + sellado, un solo dropfile.
  const produccion = correrOnExitReal({ root: f.root, issue: f.issue, data: dropfile() });
  assert.deepEqual(produccion.sello.descartes, esperado,
    'el sello persistido por el camino de producción perdió la traza del hash declarado (CA-2)');

  // Camino aislado: el que ya testeaba la suite del módulo.
  const dataAislada = dropfile();
  const aislado = sealQaVerdict({ root: f.root, issue: f.issue, data: dataAislada, cwd: REPO });
  assert.deepEqual(aislado.descartes, esperado);

  // La invariante que se rompió: los dos llamadores tienen que coincidir.
  assert.deepEqual(produccion.sello.descartes, aislado.descartes);
  assert.equal(dataAislada.evidencia_sha256, real);
});

// ─── CA-2 · la rama del glob de frames también traza por producción ──────────

test('#6495 CA-2 · el descarte del glob de frames sobrevive al strip previo del Pulpo', t => {
  const f = fixture(t);
  f.write('qa-6258-frame-01.png', 'frame uno');
  const data = {
    resultado: 'aprobado',
    modo: 'android',
    evidencia: f.write('qa-6258-structural.md', 'principal'),
    evidencia_frames: `qa/evidence/${f.issue}/qa-6258-frame-*.png`,
    evidencia_frames_sha256: 'b'.repeat(64),
  };
  const { sello } = correrOnExitReal({ root: f.root, issue: f.issue, data });
  const descarte = sello.descartes.find(item => item.campo === 'evidencia_frames_sha256');
  assert.ok(descarte, `la rama del glob perdió la traza: ${JSON.stringify(sello.descartes)}`);
  assert.equal(descarte.declarado, `sha256:${'b'.repeat(64)}`);
  assert.equal(descarte.real, sha('frame uno'));
});

// ─── CA-2 · la rama de compat (`real: null`) también traza por producción ────

test('#6495 CA-2 · el evidencia_sha256 sin artefacto único traza real:null por el camino real', t => {
  const f = fixture(t);
  f.write('qa-6258-frame-01.png', 'frame uno');
  f.write('qa-6258-frame-02.png', 'frame dos');
  const data = {
    resultado: 'aprobado',
    modo: 'android',
    evidencia: `qa/evidence/${f.issue}/qa-6258-frame-*.png`,
    evidencia_sha256: 'c'.repeat(64),
  };
  const { sello } = correrOnExitReal({ root: f.root, issue: f.issue, data });
  assert.deepEqual(sello.descartes, [{
    campo: 'evidencia_sha256', declarado: `sha256:${'c'.repeat(64)}`, real: null,
  }]);
  assert.equal(data.evidencia_sha256, undefined, 'el hash declarado no puede quedar persistido');
});

// ─── CA-2/SEC-8 · la traza sigue sin filtrar contenido ni rutas del host ─────

test('#6495 CA-2 · la traza del camino de producción no filtra contenido ni rutas absolutas', t => {
  const f = fixture(t);
  const data = {
    resultado: 'aprobado',
    modo: 'android',
    evidencia: f.write('qa-6258-structural.md', 'contenido ultra secreto'),
    evidencia_sha256: 'd'.repeat(64),
  };
  const { sello } = correrOnExitReal({ root: f.root, issue: f.issue, data });
  const serializado = JSON.stringify(sello);
  assert.doesNotMatch(serializado, /contenido ultra secreto/);
  assert.doesNotMatch(serializado, /[A-Za-z]:\\|\/tmp\//);
});

// ─── El snapshot que ahora viaja NO reinstala el sello forjado (rev-6) ──────

test('#6495 · el sello forjado por el agente no vuelve a data por el camino de producción', t => {
  const f = fixture(t);
  const forjado = { version: 1, derivado_por: 'agente', head: 'f'.repeat(40), artefactos: [], descartes: [] };
  const data = {
    resultado: 'aprobado',
    modo: 'android',
    evidencia: f.write('qa-6258-structural.md', 'real'),
    evidencia_sha256: 'a'.repeat(64),
    sello: forjado,
  };
  const { sello } = correrOnExitReal({ root: f.root, issue: f.issue, data });
  assert.notEqual(sello.head, 'f'.repeat(40), 'el head forjado no puede sobrevivir');
  assert.equal(sello.derivado_por, 'qa-evidence-seal');
  assert.equal(sello.artefactos.length, 1);
  assert.equal(data.evidencia_sha256, sha('real'), 'CA-1: lo persistido es el hash real');
});

// ─── El merge de snapshots no es un canal de inyección ───────────────────────

test('#6495 · mergeDeclaredSnapshots une sin dejar que el llamador inyecte claves ajenas', () => {
  const hashes = Object.create(null);
  hashes.evidencia_sha256 = 'a'.repeat(64);
  hashes.screenshot_sha256 = 'b'.repeat(64);
  hashes.resultado_sha256 = 'ajeno';   // base fuera del descubrimiento
  hashes.inventado = 'ajeno';          // no termina en _sha256
  hashes.__proto__ = { polucion: true }; // no puede llegar al mapa
  const merged = mergeDeclaredSnapshots({ sello: { forjado: true }, hashes }, { sello: undefined, hashes: {} });
  assert.deepEqual(Object.keys(merged.hashes).sort(), ['evidencia_sha256', 'screenshot_sha256']);
  assert.deepEqual(merged.sello, { forjado: true });
  assert.equal({}.polucion, undefined);
});

test('#6495 · lo que sigue en data al sellar le gana al snapshot previo, y un snapshot inválido no rompe', () => {
  const propio = { sello: undefined, hashes: { evidencia_sha256: 'nuevo' } };
  assert.equal(mergeDeclaredSnapshots({ hashes: { evidencia_sha256: 'viejo' } }, propio).hashes.evidencia_sha256, 'nuevo');
  for (const invalido of [null, undefined, 'texto', 42, { hashes: 'no-es-objeto' }]) {
    assert.deepEqual(
      mergeDeclaredSnapshots(invalido, { sello: undefined, hashes: { evidencia_sha256: 1 } }).hashes,
      { evidencia_sha256: 1 },
    );
  }
});

test('#6495 · sealQaVerdict sin snapshot previo se comporta igual que antes', t => {
  const f = fixture(t);
  const data = { resultado: 'aprobado', evidencia: f.write('ok.md', 'x'), evidencia_sha256: 'e'.repeat(64) };
  const result = sealQaVerdict({ root: f.root, issue: f.issue, data, cwd: REPO });
  assert.equal(result.sealed, true);
  assert.deepEqual(result.descartes, [{ campo: 'evidencia_sha256', declarado: `sha256:${'e'.repeat(64)}`, real: sha('x') }]);
});


// =============================================================================
// #6495 (rebote 7) · R-5 — `root` (ROOT del Pulpo) != `spawnCwd` (worktree)
//
// El review encontro que el bloque real invocaba `sealQaVerdict({ root: ROOT })`
// mientras el agente QA escribia sus artefactos en el worktree, porque
// `verificacion` corre con `cwd = worktreePath` y el rol `qa.md:336-338` le
// manda declarar rutas RELATIVAS. Consecuencia: en android (carril exigible) un
// QA aprobado correcto se degradaba a `rechazado`, y en structural (100% del
// corpus real) el sello simplemente no se producia.
//
// Ninguno de los tests anteriores lo veia porque todos pasaban `root` = el temp
// donde estaban los artefactos. Estos SI separan las dos raices y ademas corren
// el bloque REAL del Pulpo, que es donde vivia el defecto.
// =============================================================================

/** Worktree de verdad: `deriveHead` corre `git rev-parse HEAD` sobre el spawnCwd. */
function worktreeGit(t, prefijo = 'qa-seal-wt-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefijo));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true });
  git('init', '-q');
  git('config', 'user.email', 'pipeline@intrale.test');
  git('config', 'user.name', 'pipeline');
  git('commit', '-q', '--allow-empty', '-m', 'base');
  const head = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true });
  assert.match((head.stdout || '').trim(), /^[a-f0-9]{40}$/, 'no se pudo preparar el worktree git de la fixture');
  return { dir, head: head.stdout.trim() };
}

function escribirEvidencia(base, issue, name, content) {
  const dir = path.join(base, 'qa', 'evidence', String(issue));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
  return `qa/evidence/${issue}/${name}`;
}

test('#6495 R-5 · el bloque real sella la forma canonica de qa.md con los artefactos del worktree', t => {
  const issue = 8888;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-seal-root-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // El Pulpo crea el evidence dir en ROOT para bajar el crudo del emulador: existe
  // y esta VACIO. Era la trampa del caso B del review (glob-vacio).
  fs.mkdirSync(path.join(root, 'qa', 'evidence', String(issue)), { recursive: true });

  const worktree = worktreeGit(t);
  const evidencia = escribirEvidencia(worktree.dir, issue, `qa-${issue}.mp4`, 'video real del emulador');
  escribirEvidencia(worktree.dir, issue, `qa-${issue}-frame-01.png`, 'frame 1');
  escribirEvidencia(worktree.dir, issue, `qa-${issue}-frame-final.png`, 'frame final');

  const data = {
    resultado: 'aprobado',
    modo: 'android',
    evidencia,
    evidencia_frames: `qa/evidence/${issue}/qa-${issue}-frame-*.png`,
    screenshot: `qa/evidence/${issue}/qa-${issue}-frame-final.png`,
    evidencia_sha256: 'a'.repeat(64),
  };
  const salida = correrOnExitReal({ root, issue, data, spawnCwd: worktree.dir });

  assert.equal(data.resultado, 'aprobado',
    `un QA android correcto se degrado a rechazado: ${data.motivo || ''}`);
  assert.equal(data.rechazado_por, undefined);
  assert.deepEqual(salida.telegramas, []);
  assert.ok(salida.sello, 'el entregable nucleo del split quedo en no-op: no se persistio sello');
  assert.equal(salida.sello.head, worktree.head, 'el head sale del worktree vivo, no de ROOT');
  assert.equal(salida.sello.artefactos.length, 4);
  for (const artefacto of salida.sello.artefactos) {
    assert.match(artefacto.ruta, new RegExp(`^qa/evidence/${issue}/`));
  }
  // CA-1/CA-2 siguen firmes cruzando el strip del Pulpo.
  assert.equal(data.evidencia_sha256,
    sha('video real del emulador'));
  assert.deepEqual(salida.sello.descartes,
    [{ campo: 'evidencia_sha256', declarado: `sha256:${'a'.repeat(64)}`, real: sha('video real del emulador') }]);
});

test('#6495 R-5 · el crudo que el Pulpo graba en ROOT sigue sellando junto a lo del worktree', t => {
  const issue = 8889;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-seal-root-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const crudo = escribirEvidencia(root, issue, `qa-${issue}-raw.mp4`, 'crudo del emulador');

  const worktree = worktreeGit(t);
  escribirEvidencia(worktree.dir, issue, `qa-${issue}-frame-01.png`, 'frame 1');

  const data = {
    resultado: 'aprobado',
    modo: 'android',
    // Lo pisa el propio Pulpo unas lineas antes del sellado, relativo a ROOT.
    evidencia: crudo,
    evidencia_frames: `qa/evidence/${issue}/qa-${issue}-frame-*.png`,
  };
  const salida = correrOnExitReal({ root, issue, data, spawnCwd: worktree.dir });

  assert.equal(data.resultado, 'aprobado', `se degrado a rechazado: ${data.motivo || ''}`);
  assert.ok(salida.sello);
  assert.equal(salida.sello.artefactos.length, 2);
  assert.equal(data.evidencia_sha256, sha('crudo del emulador'));
});

test('#6495 R-5 · el caso vivo 6272: el harness que solo existe en el worktree se sella', t => {
  const issue = 6272;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-seal-root-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  escribirEvidencia(root, issue, 'qa-6272-structural.md', 'markdown structural');

  const worktree = worktreeGit(t);
  escribirEvidencia(worktree.dir, issue, 'qa-ca-verify.js', 'harness de verificacion');

  const data = {
    resultado: 'aprobado',
    modo: 'structural',
    evidencia: 'qa/evidence/6272/qa-6272-structural.md',
    evidencia_harness: 'qa/evidence/6272/qa-ca-verify.js',
  };
  const salida = correrOnExitReal({ root, issue, data, spawnCwd: worktree.dir });

  assert.equal(data.resultado, 'aprobado');
  assert.ok(salida.sello, 'sin sello, las partes 2-5 del split no tienen que consumir');
  assert.deepEqual(salida.sello.artefactos.map(a => a.campo), ['evidencia', 'evidencia_harness']);
});

test('#6495 R-5 · el bloque real no relaja el recinto: fuera de qa/evidence sigue degradando el veredicto', t => {
  const issue = 8890;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-seal-root-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const worktree = worktreeGit(t);
  fs.writeFileSync(path.join(worktree.dir, 'secreto.txt'), 'no es evidencia');

  const data = { resultado: 'aprobado', modo: 'android', evidencia: 'secreto.txt' };
  const salida = correrOnExitReal({ root, issue, data, spawnCwd: worktree.dir });

  assert.equal(data.resultado, 'rechazado');
  assert.equal(data.rechazado_por, 'gate-sellado-evidencia');
  assert.match(data.motivo, /\(fuera-de-recinto\)\.$/);
  assert.equal(data.sello, undefined);
  assert.equal(salida.telegramas.length, 1);
});

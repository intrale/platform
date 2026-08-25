'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const {
  sealQaVerdict, normalizeHash, resolveConfined, deriveHead,
  MAX_EVIDENCE_FIELDS, MAX_FILE_BYTES, MAX_LOG_FIELD_CHARS, sanitizeLogField,
  describeSealFailure, degradeVerdictForSeal,
} = require('../qa-evidence-seal');

function fixture(t, issue = 6258) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-seal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'qa', 'evidence', String(issue));
  fs.mkdirSync(dir, { recursive: true });
  const write = (name, content = 'evidencia real') => {
    const target = path.join(dir, name);
    fs.writeFileSync(target, content);
    return `qa/evidence/${issue}/${name}`;
  };
  return { root, dir, issue, write };
}

function gitHeadCwd() {
  return path.resolve(__dirname, '..', '..', '..');
}

test('normaliza sha256: y hex pelado a la misma forma canónica', () => {
  const hex = 'a'.repeat(64);
  assert.equal(normalizeHash(hex), `sha256:${hex}`);
  assert.equal(normalizeHash(`SHA256:${hex}`), `sha256:${hex}`);
  assert.equal(normalizeHash('c35b'), null);
});

test('el sello se deriva del archivo real y descarta el hash declarado', t => {
  const f = fixture(t);
  const route = f.write('qa-6258-structural.md', 'bytes canónicos');
  const actual = `sha256:${crypto.createHash('sha256').update('bytes canónicos').digest('hex')}`;
  const data = { resultado: 'aprobado', evidencia: route, evidencia_sha256: 'a'.repeat(64), entorno: { worktree: 'C:/host/inventado' } };
  const result = sealQaVerdict({ root: f.root, issue: f.issue, data, cwd: gitHeadCwd() });
  assert.equal(result.sealed, true);
  assert.equal(data.evidencia_sha256, actual);
  assert.deepEqual(result.descartes, [{ campo: 'evidencia_sha256', declarado: `sha256:${'a'.repeat(64)}`, real: actual }]);
  assert.equal(result.manifest.head, deriveHead(gitHeadCwd()));
  assert.doesNotMatch(JSON.stringify(result.descartes), /bytes canónicos|[A-Z]:\\/i);
});

test('rechaza un path con traversal relativo', t => {
  const f = fixture(t);
  assert.throws(() => resolveConfined(f.root, f.issue, 'qa/evidence/6258/../../../.claude/secrets/credentials.json'), { reason: 'traversal' });
});

test('rechaza un path absoluto fuera del repo sin distinguirlo de uno inexistente', t => {
  const f = fixture(t);
  for (const route of [path.join(f.root, 'afuera.txt'), 'qa/evidence/6258/ausente.txt']) {
    const data = { resultado: 'aprobado', evidencia: route };
    assert.equal(sealQaVerdict({ root: f.root, issue: f.issue, data, cwd: gitHeadCwd() }).reason, 'fuera-de-recinto');
    assert.equal(data.sello, undefined);
  }
});

test('rechaza un symlink que apunta fuera de qa/evidence', t => {
  const f = fixture(t);
  const outside = path.join(f.root, 'outside.txt');
  fs.writeFileSync(outside, 'secreto');
  const link = path.join(f.dir, 'link.txt');
  try { fs.symlinkSync(outside, link, 'file'); } catch { t.skip('symlink no disponible'); return; }
  const result = sealQaVerdict({ root: f.root, issue: f.issue, data: { resultado: 'aprobado', evidencia: 'qa/evidence/6258/link.txt' }, cwd: gitHeadCwd() });
  assert.equal(result.reason, 'fuera-de-recinto');
});

test('un artefacto vacío hace fallar el sellado sin manifiesto parcial', t => {
  const f = fixture(t);
  const data = { resultado: 'aprobado', evidencia: f.write('ok.txt'), evidencia_extra: f.write('empty.txt', '') };
  const result = sealQaVerdict({ root: f.root, issue: f.issue, data, cwd: gitHeadCwd() });
  assert.equal(result.reason, 'vacio');
  assert.equal(data.sello, undefined);
  assert.deepEqual(result.descartes, []);
});

test('un hash truncado no matchea por prefijo para una copia', t => {
  const f = fixture(t);
  const data = { resultado: 'aprobado', evidencia: { ruta: f.write('copy.txt'), tipo: 'copia', sha256: 'c35b' } };
  assert.equal(sealQaVerdict({ root: f.root, issue: f.issue, data, cwd: gitHeadCwd() }).reason, 'hash-divergente');
});

test('una copia exige igualdad estricta con el hash canónico apuntado', t => {
  const f = fixture(t);
  const content = 'copia exacta';
  const source = `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
  const data = { resultado: 'aprobado', evidencia: { ruta: f.write('copy.txt', content), tipo: 'copia', derivado_de: source } };
  const result = sealQaVerdict({ root: f.root, issue: f.issue, data, cwd: gitHeadCwd() });
  assert.equal(result.sealed, true);
  assert.equal(result.manifest.artefactos[0].sha256, source);
});

test('un derivado conserva hash propio y exige que derivado_de sea canónico', t => {
  const f = fixture(t);
  const data = { resultado: 'aprobado', evidencia: { ruta: f.write('remux.mp4'), tipo: 'derivado', derivado_de: 'b'.repeat(64) } };
  const result = sealQaVerdict({ root: f.root, issue: f.issue, data, cwd: gitHeadCwd() });
  assert.equal(result.sealed, true);
  assert.equal(result.manifest.artefactos[0].derivado_de, `sha256:${'b'.repeat(64)}`);
});

test('el glob de frames se expande confinado y ordenado', t => {
  const f = fixture(t);
  f.write('qa-6258-frame-02.png', 'dos');
  f.write('qa-6258-frame-01.png', 'uno');
  const data = { resultado: 'aprobado', evidencia_frames: 'qa/evidence/6258/qa-6258-frame-*.png' };
  const result = sealQaVerdict({ root: f.root, issue: f.issue, data, cwd: gitHeadCwd() });
  assert.deepEqual(result.manifest.artefactos.map(a => path.basename(a.ruta)), ['qa-6258-frame-01.png', 'qa-6258-frame-02.png']);
});

test('un glob vacío falla cerrado', t => {
  const f = fixture(t);
  const data = { resultado: 'aprobado', evidencia_frames: 'qa/evidence/6258/frame-*.png' };
  assert.equal(sealQaVerdict({ root: f.root, issue: f.issue, data, cwd: gitHeadCwd() }).reason, 'glob-vacio');
});

test('superar el tope de campos descubiertos falla cerrado', t => {
  const f = fixture(t);
  const data = { resultado: 'aprobado' };
  for (let i = 0; i <= MAX_EVIDENCE_FIELDS; i++) data[`evidencia_${i}`] = f.write(`${i}.txt`);
  assert.equal(sealQaVerdict({ root: f.root, issue: f.issue, data, cwd: gitHeadCwd() }).reason, 'campos-oversize');
});

test('superar el tope de bytes por archivo falla cerrado', t => {
  const f = fixture(t);
  const target = path.join(f.dir, 'huge.bin');
  const fd = fs.openSync(target, 'w');
  fs.ftruncateSync(fd, MAX_FILE_BYTES + 1);
  fs.closeSync(fd);
  const data = { resultado: 'aprobado', evidencia: 'qa/evidence/6258/huge.bin' };
  assert.equal(sealQaVerdict({ root: f.root, issue: f.issue, data, cwd: gitHeadCwd() }).reason, 'oversize');
});

test('deriveHead rechaza un cwd que no es repositorio e ignora datos YAML', t => {
  const f = fixture(t);
  assert.throws(() => deriveHead(f.root), { reason: 'head-invalido' });
  const data = { resultado: 'aprobado', evidencia: f.write('ok.txt'), entorno: { worktree: f.root } };
  assert.equal(sealQaVerdict({ root: f.root, issue: f.issue, data, cwd: gitHeadCwd() }).sealed, true);
});

// ---------------------------------------------------------------------------
// #6495 (rebote de seguridad) — Inyección de log en el sink de rechazos.
// El campo `evidencia` lo controla el YAML del agente QA. Antes del fix, un
// CR/LF sobrevivía hasta console.error y permitía forjar líneas de log, y la
// normalización de rutas absolutas sólo cubría drive letters de Windows.
// ---------------------------------------------------------------------------

// Captura console.error y devuelve las líneas emitidas.
function captureStderr(t, fn) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => { lines.push(args.join(' ')); };
  t.after(() => { console.error = original; });
  try { fn(); } finally { console.error = original; }
  return lines;
}

test('el sink de rechazos nunca emite más de una línea aunque el YAML declare CR/LF', t => {
  const f = fixture(t);
  const payloads = [
    'qa/evidence/6258/ok.png\n[INFO] sellado aprobado por operador',
    'qa/evidence/6258/ok.png\r\n[INFO] sellado aprobado por operador',
    'qa/evidence/6258/ok.png\u2028[INFO] falsificado',
    'qa/evidence/6258/ok.png\u0000[INFO] falsificado',
  ];
  for (const payload of payloads) {
    const data = { resultado: 'aprobado', evidencia: payload };
    const emitted = captureStderr(t, () => sealQaVerdict({ root: f.root, issue: f.issue, data, cwd: gitHeadCwd() }));
    assert.equal(emitted.length, 1, `payload ${JSON.stringify(payload)} emitió ${emitted.length} llamadas`);
    const salida = emitted.join('');
    assert.doesNotMatch(salida, /[\r\n\u2028\u2029\u0000]/, 'la línea de log contiene caracteres de control');
    assert.doesNotMatch(salida, /\[INFO\]/, 'la línea de log contiene una entrada forjada');
    assert.match(salida, /<ruta-no-imprimible>/);
  }
});

test('el PoC del rechazo (ruta absoluta POSIX + salto de línea) queda en un marcador categórico', t => {
  const f = fixture(t);
  const data = { resultado: 'aprobado', evidencia: '/var/lib/private/token.txt\n[INFO] sellado aprobado por operador' };
  const emitted = captureStderr(t, () => sealQaVerdict({ root: f.root, issue: f.issue, data, cwd: gitHeadCwd() }));
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0], '[qa-evidence-seal] sellado rechazado (fuera-de-recinto) campo=<ruta-absoluta>');
  assert.doesNotMatch(emitted[0], /var|token|\[INFO\]/);
});

test('toda ruta absoluta se representa con marcador categórico, no sólo las de Windows', () => {
  const absolutas = [
    'C:\\Workspaces\\Intrale\\secreto.png',
    'c:/Workspaces/Intrale/secreto.png',
    '/var/lib/private/token.txt',
    '/home/leito/.ssh/id_rsa',
    '\\\\servidor\\share\\evidencia.png',
    '//servidor/share/evidencia.png',
    '   /etc/passwd',
  ];
  for (const ruta of absolutas) {
    assert.equal(sanitizeLogField(ruta), '<ruta-absoluta>', `no se marcó como absoluta: ${ruta}`);
  }
});

test('sanitizeLogField acota el largo y nunca coacciona un valor no string', () => {
  assert.equal(sanitizeLogField(undefined), '');
  assert.equal(sanitizeLogField(null), '');
  assert.equal(sanitizeLogField(''), '');
  assert.equal(sanitizeLogField('   '), '<ruta-vacia>');
  assert.equal(sanitizeLogField(42), '<valor-no-textual>');
  assert.equal(sanitizeLogField({}), '<valor-no-textual>');
  const largo = `qa/${'a'.repeat(500)}.png`;
  const salida = sanitizeLogField(largo);
  assert.ok(salida.length <= MAX_LOG_FIELD_CHARS + '<truncado>'.length, `salida sin truncar (${salida.length})`);
  assert.match(salida, /<truncado>$/);
});

// #6495 (rebote 1) — Clases que el denylist anterior dejaba pasar aunque ya
// cerraba CR/LF y drive letters. Se verifican contra el sanitizado por
// allowlist, que es el que las cubre a todas de una.
test('la coerción de un valor no string no puede filtrar una ruta absoluta embebida', () => {
  // String(['ok','/var/lib/private/token.txt']) === 'ok,/var/lib/private/token.txt',
  // que ya no empieza con `/` y por lo tanto esquivaba el marcador de absoluta.
  assert.equal(sanitizeLogField(['ok', '/var/lib/private/token.txt']), '<valor-no-textual>');
  assert.equal(sanitizeLogField({ ruta: '/var/lib/private/token.txt' }), '<valor-no-textual>');
  assert.equal(sanitizeLogField({ toString() { return 'ok,/var/lib/private/token.txt'; } }), '<valor-no-textual>');
  for (const salida of [
    sanitizeLogField(['ok', '/var/lib/private/token.txt']),
    sanitizeLogField({ ruta: '/var/lib/private/token.txt' }),
  ]) {
    assert.doesNotMatch(salida, /var|lib|token/, 'la salida filtró parte de la ruta absoluta');
  }
});

test('un valor fuera del alfabeto de una ruta de evidencia se descarta entero', () => {
  const hostiles = [
    'x) sellado OK campo=(y',                    // envenenamiento en una sola línea
    'qa/evidence/6258/ok.png sellado aprobado',  // espacios: texto libre en el log
    'qa/evidence/6258/ok.png‮gnp.ko',       // U+202E invierte la línea al operador
    'qa/evidence/6258/ok​.png',             // zero-width space
    'qa/evidence/﻿6258/ok.png',             // BOM intercalado (el del borde lo come trim)
    'qa/evidence/6258/#{ok}.png',
    'qa/evidence/6258/ok.png;rm -rf /',
  ];
  for (const payload of hostiles) {
    const salida = sanitizeLogField(payload);
    assert.match(salida, /^<ruta-(?:no-representable|no-imprimible)>$/, `no se descartó entero: ${JSON.stringify(payload)} -> ${salida}`);
    assert.doesNotMatch(salida, /sellado|aprobado|rm |campo=\(/, 'la salida conserva texto hostil');
  }
});

test('una ruta de evidencia legítima sobrevive al allowlist', () => {
  for (const ruta of [
    'qa/evidence/6258/qa-6258-structural.md',
    'qa/evidence/6190/qa-6190-frame-*.png',
    'qa/evidence/6258/../../../.claude/secrets/credentials.json', // relativa: va al log local (CA-11)
  ]) {
    assert.equal(sanitizeLogField(ruta), ruta, `se descartó una ruta representable: ${ruta}`);
  }
});

test('deriveHead no deja que el stderr de git escriba en el sink sin sanitizar', t => {
  // El hijo escribe en el fd 2 real, así que stubbear console.error no alcanza:
  // hay que observar el stderr de un proceso aparte.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-nogit-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } });
  const modulo = path.resolve(__dirname, '..', 'qa-evidence-seal.js');
  const guion = 'const m = require(process.argv[1]);'
    + ' try { m.deriveHead(process.argv[2]); } catch (e) { process.stdout.write(String(e.reason)); }';
  const salida = spawnSync(process.execPath, ['-e', guion, modulo, dir], { encoding: 'utf8' });
  assert.equal(salida.stdout, 'head-invalido');
  // git imprime "fatal: not a git repository (or any of the parent directories)"
  // en su stderr; con stdio ignorado no debe llegar nada al sink del pipeline.
  assert.equal(salida.stderr, '', `git filtró su stderr al sink: ${JSON.stringify(salida.stderr)}`);
});

// ---------------------------------------------------------------------------
// #6495 (rebote 2 de seguridad) — Fail-OPEN por tipo del campo de evidencia.
// `artifactSpec()` devolvía null para lista YAML, null, número y booleano, y
// ese null caía en el mismo `continue` del centinela: el campo se salteaba en
// silencio y el sellado seguía con menos artefactos que los declarados.
// ---------------------------------------------------------------------------

test('PoC del rebote: evidencia como lista + screenshot válido NO puede sellar', t => {
  const f = fixture(t);
  const report = f.write('report.md', 'reporte real');
  const otro = f.write('otro.md', 'otro real');
  const shot = f.write('shot.png', 'pixeles');
  const hashReport = `sha256:${crypto.createHash('sha256').update('reporte real').digest('hex')}`;
  const hashShot = `sha256:${crypto.createHash('sha256').update('pixeles').digest('hex')}`;
  assert.notEqual(hashReport, hashShot);

  const data = { resultado: 'aprobado', evidencia: [report, otro], screenshot: shot };
  const result = sealQaVerdict({ root: f.root, issue: f.issue, data, cwd: gitHeadCwd() });

  assert.equal(result.sealed, false, 'una lista de evidencia no puede producir sellado');
  assert.equal(result.reason, 'tipo-invalido');
  assert.equal(data.sello, undefined, 'no queda manifiesto parcial');
  // El corazón del rebote: jamás promover el hash de OTRO campo al compat.
  assert.notEqual(data.evidencia_sha256, hashShot);
  assert.equal(data.evidencia_sha256, undefined);
});

test('todo valor de evidencia que no es ruta ni descriptor falla cerrado', t => {
  const f = fixture(t);
  const shot = f.write('shot.png', 'pixeles');
  const hostiles = [
    ['lista', ['qa/evidence/6258/report.md', 'qa/evidence/6258/otro.md']],
    ['lista-vacia', []],
    ['numero', 42],
    ['booleano', true],
    ['objeto-sin-ruta', { tipo: 'original' }],
    ['objeto-ruta-no-textual', { ruta: ['qa/evidence/6258/report.md'] }],
    ['objeto-ruta-numerica', { ruta: 7 }],
    ['objeto-tipo-vacio', { ruta: 'qa/evidence/6258/report.md', tipo: '' }],
    ['objeto-tipo-no-textual', { ruta: 'qa/evidence/6258/report.md', tipo: ['original'] }],
  ];
  for (const [nombre, valor] of hostiles) {
    const data = { resultado: 'aprobado', evidencia: valor, screenshot: shot };
    const result = sealQaVerdict({ root: f.root, issue: f.issue, data, cwd: gitHeadCwd() });
    assert.equal(result.sealed, false, `${nombre} selló igual`);
    assert.equal(result.reason, 'tipo-invalido', `${nombre} falló por otro motivo: ${result.reason}`);
    assert.equal(data.sello, undefined, `${nombre} dejó manifiesto`);
    assert.equal(data.evidencia_sha256, undefined, `${nombre} promovió un hash ajeno`);
  }
});

test('el centinela textual sigue salteando el campo pero no arrastra el compat', t => {
  const f = fixture(t);
  const shot = f.write('shot.png', 'pixeles');
  const hashShot = `sha256:${crypto.createHash('sha256').update('pixeles').digest('hex')}`;
  // #6495 (rebote 3, R-3): los centinelas del histórico real NUNCA están
  // pelados — todos justifican. El `null` es `evidencia_sondas:` sin valor,
  // que en YAML parsea a `null` y significa lo mismo (caso real `5172.qa`).
  const centinelas = [
    '', '-', 'no-aplica', 'N/A', ' null ', null,
    'no aplica: el preflight confirmo que no hay superficie UI visible',
    'n/a - QA_MODE=structural sin UI visible (preflight verificado)',
    'no-aplica — preflight de UI visible NEGATIVO (sin area:dashboard)',
    'no aplica (cambio de configuracion interna sin superficie visual)',
    'N/A — modo structural sin UI visible (infra de CI, sin labels app:*)',
  ];
  for (const centinela of centinelas) {
    const data = { resultado: 'aprobado', evidencia: centinela, screenshot: shot, evidencia_sha256: 'a'.repeat(64) };
    const result = sealQaVerdict({ root: f.root, issue: f.issue, data, cwd: gitHeadCwd() });
    assert.equal(result.sealed, true, `el centinela ${JSON.stringify(centinela)} no debería frenar el sellado`);
    assert.deepEqual(result.manifest.artefactos.map(a => a.campo), ['screenshot']);
    // `evidencia` no produjo artefacto ⇒ el compat se borra, nunca hereda el
    // hash del screenshot.
    assert.equal(data.evidencia_sha256, undefined, 'el compat quedó apuntando a otro artefacto');
    assert.notEqual(data.evidencia_sha256, hashShot);
    // El salteo queda TRAZADO, nunca en silencio: es la propiedad que el
    // rebote 2 exigía y que el `continue` mudo había roto.
    assert.deepEqual(result.descartes, [
      { campo: 'evidencia', declarado: null, real: null, motivo: 'centinela' },
      { campo: 'evidencia_sha256', declarado: `sha256:${'a'.repeat(64)}`, real: null },
    ]);
  }
});

test('sin campo evidencia, el hash de otro campo no se promueve al compat', t => {
  const f = fixture(t);
  const data = { resultado: 'aprobado', screenshot: f.write('shot.png', 'pixeles') };
  const result = sealQaVerdict({ root: f.root, issue: f.issue, data, cwd: gitHeadCwd() });
  assert.equal(result.sealed, true);
  assert.equal(data.evidencia_sha256, undefined);
  assert.equal(result.manifest.artefactos.length, 1);
  assert.equal(result.manifest.artefactos[0].campo, 'screenshot');
});

test('un glob de evidencia con varios artefactos no elige un compat arbitrario', t => {
  const f = fixture(t);
  f.write('qa-6258-frame-01.png', 'uno');
  f.write('qa-6258-frame-02.png', 'dos');
  const data = { resultado: 'aprobado', evidencia: 'qa/evidence/6258/qa-6258-frame-*.png' };
  const result = sealQaVerdict({ root: f.root, issue: f.issue, data, cwd: gitHeadCwd() });
  assert.equal(result.sealed, true);
  assert.equal(result.manifest.artefactos.length, 2);
  assert.equal(data.evidencia_sha256, undefined, 'el compat no puede representar a dos artefactos');
});

test('el descarte del compat no se duplica cuando el bucle ya trazo el mismo campo', t => {
  const f = fixture(t);
  f.write('qa-6258-frame-01.png', 'uno');
  f.write('qa-6258-frame-02.png', 'dos');
  const data = {
    resultado: 'aprobado',
    evidencia: 'qa/evidence/6258/qa-6258-frame-*.png',
    evidencia_sha256: 'a'.repeat(64),
  };
  const result = sealQaVerdict({ root: f.root, issue: f.issue, data, cwd: gitHeadCwd() });
  assert.equal(result.sealed, true);
  assert.equal(data.evidencia_sha256, undefined);
  // El bucle ya dejó una entrada por artefacto divergente: la baja del compat
  // no agrega una tercera con `real: null` que se leería como contradictoria.
  const delCompat = result.descartes.filter(d => d.campo === 'evidencia_sha256');
  assert.equal(delCompat.length, 2);
  assert.ok(delCompat.every(d => d.real !== null));
});

test('un descriptor con ruta centinela se resuelve contra el recinto, no se saltea', t => {
  const f = fixture(t);
  const data = { resultado: 'aprobado', evidencia: { ruta: 'no-aplica', tipo: 'original' } };
  const result = sealQaVerdict({ root: f.root, issue: f.issue, data, cwd: gitHeadCwd() });
  assert.equal(result.sealed, false);
  assert.equal(result.reason, 'fuera-de-recinto');
});

test('un motivo desconocido degrada a sellado-invalido en vez de viajar al log', t => {
  const f = fixture(t);
  const original = fs.realpathSync;
  const forjado = new Error('boom');
  forjado.reason = 'aprobado\n[INFO] todo bien';
  forjado.declaredPath = 'qa/evidence/6258/ok.png';
  const data = { resultado: 'aprobado', evidencia: f.write('ok.png') };
  fs.realpathSync = () => { throw forjado; };
  t.after(() => { fs.realpathSync = original; });
  const emitted = captureStderr(t, () => sealQaVerdict({ root: f.root, issue: f.issue, data, cwd: gitHeadCwd() }));
  fs.realpathSync = original;
  assert.equal(emitted.length, 1);
  assert.doesNotMatch(emitted.join(''), /\[INFO\]|[\r\n]/);
});

// ===========================================================================
// #6495 · rebote 3 — Regresiones contra las FORMAS REALES del dropfile.
//
// El review marcó que ninguno de los 30 tests anteriores usaba una forma real,
// y que por eso el fail-closed pasó verde mientras se comía el 22% de las
// aprobaciones históricas. Estos tests fijan las formas que el pipeline
// realmente produce hoy (barrido de `procesado/` + `archivado/`).
// ===========================================================================

test('R-1: la ruta absoluta que escribe el propio pulpo en data.evidencia sella OK', t => {
  const f = fixture(t, 6495);
  f.write('qa-6495-raw.mp4', 'bytes de video');
  // Exactamente lo que arma el on-exit del pulpo: path.join(ROOT, 'qa',
  // 'evidence', issue, `qa-${issue}-raw.mp4`) — absoluto.
  const absoluta = path.join(f.root, 'qa', 'evidence', '6495', 'qa-6495-raw.mp4');
  assert.ok(path.isAbsolute(absoluta), 'el fixture tiene que ser absoluto para probar la regresión');

  const data = { resultado: 'aprobado', evidencia: absoluta, video_size_kb: 812 };
  const result = sealQaVerdict({ root: f.root, issue: 6495, data, cwd: gitHeadCwd() });

  assert.equal(result.sealed, true, `el happy path de android no puede caer: ${result.reason}`);
  assert.equal(result.manifest.artefactos.length, 1);
  // El manifiesto persiste la ruta RELATIVA, nunca la absoluta del host (SEC-8).
  assert.equal(result.manifest.artefactos[0].ruta, 'qa/evidence/6495/qa-6495-raw.mp4');
  assert.doesNotMatch(JSON.stringify(result.manifest), /[A-Za-z]:\\\\/);
  assert.equal(
    data.evidencia_sha256,
    `sha256:${crypto.createHash('sha256').update('bytes de video').digest('hex')}`,
  );
});

test('R-1: la ruta absoluta que cae FUERA del recinto sigue siendo fail-closed', t => {
  const f = fixture(t, 6495);
  const afuera = path.join(f.root, 'afuera', 'robado.txt');
  fs.mkdirSync(path.dirname(afuera), { recursive: true });
  fs.writeFileSync(afuera, 'no deberia sellarse');
  const data = { resultado: 'aprobado', evidencia: afuera };
  const result = sealQaVerdict({ root: f.root, issue: 6495, data, cwd: gitHeadCwd() });
  assert.equal(result.sealed, false, 'aceptar absolutos no puede aflojar el confinamiento');
  assert.equal(result.reason, 'fuera-de-recinto');
});

test('R-2/R-3: un veredicto structural con evidencia en prosa no produce sello pero tampoco toca el veredicto', t => {
  const f = fixture(t, 4869);
  // Forma textual de `.pipeline/roles/qa.md:195` y de `4869.qa` / `4850.qa`.
  const data = {
    resultado: 'aprobado',
    modo: 'structural',
    evidencia: 'Validación estructural — infra sin UI/backend. area:infra, sin app:*.',
    screenshot: 'no-aplica: cambio de infraestructura sin interfaz visible',
  };
  const result = sealQaVerdict({ root: f.root, issue: 4869, data, cwd: gitHeadCwd() });

  // El módulo no puede sellar prosa, pero distingue "no es ruta" de "ruta rota":
  // el motivo es `sin-evidencia`, no `fuera-de-recinto`.
  assert.equal(result.sealed, false);
  assert.equal(result.reason, 'sin-evidencia', 'la prosa no puede leerse como una ruta rota');
  // Y el módulo NUNCA toca el veredicto: degradar es decisión del llamador, que
  // sólo lo hace cuando la evidencia es exigible (ver el hook del pulpo).
  assert.equal(data.resultado, 'aprobado');
  assert.equal(data.motivo, undefined);
  assert.equal(data.sello, undefined);
  // CA-9 sigue mandando: un sellado que falla no persiste NADA, ni siquiera las
  // trazas parciales. La traza del salteo sólo viaja cuando hay manifiesto (ver
  // los casos 5110 y 6239 más abajo); acá el canal es el log + el motivo.
  assert.deepEqual(result.descartes, []);
});

test('R-3: el caso 5110 — evidencia confinada + screenshot con centinela justificado sella igual', t => {
  const f = fixture(t, 5110);
  const route = f.write('qa-5110-structural.md', 'reporte estructural real');
  const data = {
    resultado: 'aprobado',
    modo: 'structural',
    evidencia: route,
    screenshot: 'no aplica: el preflight confirmo que no hay superficie UI visible, mockup no aplica',
    evidencia_sondas: null,
  };
  const result = sealQaVerdict({ root: f.root, issue: 5110, data, cwd: gitHeadCwd() });

  assert.equal(result.sealed, true, `5110 tenía la evidencia BIEN confinada: ${result.reason}`);
  assert.deepEqual(result.manifest.artefactos.map(a => a.campo), ['evidencia']);
  assert.equal(
    data.evidencia_sha256,
    `sha256:${crypto.createHash('sha256').update('reporte estructural real').digest('hex')}`,
  );
});

test('R-4: el derivado de .pipeline/logs/media alcanza su rama en vez de morir en el recinto', t => {
  const f = fixture(t, 6190);
  const original = f.write('qa-6190.mp4', 'video crudo');
  const hashOriginal = `sha256:${crypto.createHash('sha256').update('video crudo').digest('hex')}`;
  const mediaDir = path.join(f.root, '.pipeline', 'logs', 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.writeFileSync(path.join(mediaDir, 'qa-6190.mp4'), 'remux faststart, bytes distintos');

  const data = {
    resultado: 'aprobado',
    evidencia: original,
    evidencia_remux: { ruta: '.pipeline/logs/media/qa-6190.mp4', tipo: 'derivado', derivado_de: hashOriginal },
  };
  const result = sealQaVerdict({ root: f.root, issue: 6190, data, cwd: gitHeadCwd() });

  assert.equal(result.sealed, true, `el caso motivador de CA-6 no puede ser inalcanzable: ${result.reason}`);
  const remux = result.manifest.artefactos.find(a => a.campo === 'evidencia_remux');
  assert.equal(remux.tipo, 'derivado');
  assert.equal(remux.derivado_de, hashOriginal, 'el derivado conserva el puntero, no el hash del original');
  assert.notEqual(remux.sha256, hashOriginal, 'un derivado tiene hash propio');
  assert.equal(remux.ruta, '.pipeline/logs/media/qa-6190.mp4');
});

test('R-4: el recinto de logs no es un comodín entre issues', t => {
  const f = fixture(t, 6190);
  const mediaDir = path.join(f.root, '.pipeline', 'logs', 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.writeFileSync(path.join(mediaDir, 'qa-9999.mp4'), 'video de OTRO issue');
  fs.writeFileSync(path.join(f.root, '.pipeline', 'logs', 'pulpo.log'), 'log arbitrario del pipeline');

  for (const ajena of ['.pipeline/logs/media/qa-9999.mp4', '.pipeline/logs/pulpo.log']) {
    const data = { resultado: 'aprobado', evidencia: ajena };
    const result = sealQaVerdict({ root: f.root, issue: 6190, data, cwd: gitHeadCwd() });
    assert.equal(result.sealed, false, `${ajena} no referencia al issue y no debería sellarse`);
    assert.equal(result.reason, 'fuera-de-recinto');
  }
});

test('CA-13: el fail-closed escribe motivo legible y rechazado_por, no deja el veredicto sin motivo', () => {
  // El review marcó que el mapa de mensajes del hook no tenía ninguna prueba y
  // que sin `motivo` el rejection-report emite PDF y audio que dicen
  // literalmente "Sin motivo" (#6421).
  const reasons = [
    'traversal', 'fuera-de-recinto', 'no-regular', 'vacio', 'oversize', 'head-invalido',
    'glob-invalido', 'glob-vacio', 'glob-oversize', 'hash-divergente', 'campos-oversize',
    'tipo-invalido', 'sin-evidencia', 'sellado-invalido',
  ];
  for (const reason of reasons) {
    const data = { resultado: 'aprobado', evidencia: 'qa/evidence/1/x.png' };
    const escrito = degradeVerdictForSeal(data, reason);
    assert.equal(data.resultado, 'rechazado', `${reason} no degradó el veredicto`);
    assert.equal(data.rechazado_por, 'gate-sellado-evidencia');
    assert.equal(data.motivo, escrito.motivo);
    assert.ok(data.motivo && data.motivo.length > 20, `${reason} dejó un motivo vacío o inútil`);
    // CA-13: legible (frase en español) + slug entre paréntesis.
    assert.match(data.motivo, new RegExp(`\\(${reason}\\)\\.$`), `${reason} no expone su slug`);
    assert.match(data.motivo, /^[A-ZÁÉÍÓÚÑ]/, `${reason} no arranca con una frase legible`);
  }
});

test('CA-13/CA-11: el motivo del fail-closed nunca interpola el path ni un motivo forjado', () => {
  // Un motivo desconocido (o forjado por un error inesperado) no puede viajar al
  // PDF/audio del operador: degrada al slug estable.
  const data = { resultado: 'aprobado' };
  const escrito = degradeVerdictForSeal(data, 'aprobado\n[INFO] sellado OK por el operador');
  assert.doesNotMatch(escrito.motivo, /\[INFO\]|[\r\n]/);
  assert.match(escrito.motivo, /\(sellado-invalido\)\.$/);
  assert.doesNotMatch(describeSealFailure('fuera-de-recinto'), /qa\/evidence|\/etc\//);
});

test('el barrido de formas reales del histórico no rompe una aprobación con artefactos', t => {
  // Forma real de `6239.qa`: original en `.pipeline/logs/media`, copia en repo,
  // markdown estructural, glob de frames, campo vacío y screenshot centinela.
  const f = fixture(t, 6239);
  f.write('qa-6239.mp4', 'video');
  f.write('qa-6239-structural.md', 'estructural');
  f.write('qa-6239-frame-01.png', 'frame1');
  f.write('qa-6239-frame-02.png', 'frame2');
  const mediaDir = path.join(f.root, '.pipeline', 'logs', 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.writeFileSync(path.join(mediaDir, 'qa-6239.mp4'), 'remux');

  const data = {
    resultado: 'aprobado',
    evidencia: '.pipeline/logs/media/qa-6239.mp4',
    evidencia_repo: 'qa/evidence/6239/qa-6239.mp4',
    evidencia_estructural: 'qa/evidence/6239/qa-6239-structural.md',
    evidencia_frames: 'qa/evidence/6239/qa-6239-frame-*.png',
    evidencia_hashes: null,
    screenshot: 'no aplica — modo structural sin superficie de UI renderizable',
  };
  const result = sealQaVerdict({ root: f.root, issue: 6239, data, cwd: gitHeadCwd() });

  assert.equal(result.sealed, true, `forma real de 6239 no selló: ${result.reason}`);
  assert.deepEqual(
    result.manifest.artefactos.map(a => a.campo),
    ['evidencia', 'evidencia_repo', 'evidencia_estructural', 'evidencia_frames', 'evidencia_frames'],
  );
  assert.ok(result.manifest.artefactos.every(a => !path.isAbsolute(a.ruta)));
  assert.deepEqual(
    result.descartes.map(d => [d.campo, d.motivo]),
    [['evidencia_hashes', 'centinela'], ['screenshot', 'centinela']],
  );
});

test('el tope de campos se calibra sobre el histórico real (10 campos observados) y sigue siendo fijo', t => {
  const f = fixture(t, 6118);
  const data = { resultado: 'aprobado' };
  // `6118.qa` declara 10 campos de evidencia; el tope no puede quedar debajo.
  for (let i = 0; i < 10; i++) data[`evidencia_${i}`] = f.write(`art-${i}.txt`, `bytes ${i}`);
  const result = sealQaVerdict({ root: f.root, issue: 6118, data, cwd: gitHeadCwd() });
  assert.equal(result.sealed, true, `10 campos reales no pueden dar oversize: ${result.reason}`);
  assert.equal(result.manifest.artefactos.length, 10);

  // Pero sigue siendo un tope fijo: superarlo es fail-closed, no truncado.
  const exceso = { resultado: 'aprobado' };
  for (let i = 0; i <= MAX_EVIDENCE_FIELDS; i++) exceso[`evidencia_${i}`] = f.write(`art-${i}.txt`, `bytes ${i}`);
  const conExceso = sealQaVerdict({ root: f.root, issue: 6118, data: exceso, cwd: gitHeadCwd() });
  assert.equal(conExceso.sealed, false);
  assert.equal(conExceso.reason, 'campos-oversize');
});

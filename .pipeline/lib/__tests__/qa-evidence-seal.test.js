'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  sealQaVerdict, normalizeHash, resolveConfined, deriveHead,
  MAX_EVIDENCE_FIELDS, MAX_FILE_BYTES,
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

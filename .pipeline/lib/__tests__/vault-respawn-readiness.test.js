// =============================================================================
// vault-respawn-readiness.test.js — #5453 · acreditación del respawn
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createRespawnReadiness, CONSUMIDORES, archivoPid,
} = require('../vault-respawn-readiness');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function banco(opciones = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-respawn-'));
  const consumidores = opciones.consumidores || ['pulpo', 'listener', 'dashboard'];
  const vivos = new Set(opciones.vivos || consumidores.map((_, i) => 1000 + i));

  function escribirPid(nombre, { pid, mtimeMs }) {
    const ruta = path.join(dir, archivoPid(nombre));
    fs.writeFileSync(ruta, String(pid));
    if (mtimeMs !== undefined) {
      const fecha = new Date(mtimeMs);
      fs.utimesSync(ruta, fecha, fecha);
    }
  }

  const readiness = createRespawnReadiness({
    pipelineDir: dir,
    consumidores,
    isAlive: (pid) => vivos.has(pid),
  });

  return { dir, consumidores, vivos, escribirPid, readiness };
}

const ROTACION_MS = Date.parse('2026-08-31T10:00:00Z');
const DESPUES = ROTACION_MS + 60_000;
const ANTES = ROTACION_MS - 60_000;

// -----------------------------------------------------------------------------
// 1 · Camino feliz
// -----------------------------------------------------------------------------

test('acredita el respawn cuando todos los .pid son posteriores a la rotacion y estan vivos', () => {
  const b = banco();
  b.consumidores.forEach((nombre, i) => b.escribirPid(nombre, { pid: 1000 + i, mtimeMs: DESPUES }));
  const r = b.readiness.verify({ since: new Date(ROTACION_MS).toISOString() });
  assert.equal(r.ok, true);
  assert.deepEqual(r.consumers.sort(), [...b.consumidores].sort());
  assert.deepEqual(r.pendientes, []);
  assert.equal(r.total, b.consumidores.length);
});

test('acepta el instante de rotacion en ms además de en ISO', () => {
  const b = banco();
  b.consumidores.forEach((nombre, i) => b.escribirPid(nombre, { pid: 1000 + i, mtimeMs: DESPUES }));
  assert.equal(b.readiness.verify({ since: ROTACION_MS }).ok, true);
});

// -----------------------------------------------------------------------------
// 2 · Fail-closed
// -----------------------------------------------------------------------------

test('un .pid ANTERIOR a la rotacion NO acredita: ese proceso nunca se reinicio', () => {
  const b = banco();
  b.consumidores.forEach((nombre, i) => b.escribirPid(nombre, { pid: 1000 + i, mtimeMs: DESPUES }));
  b.escribirPid('listener', { pid: 1001, mtimeMs: ANTES });
  const r = b.readiness.verify({ since: ROTACION_MS });
  assert.equal(r.ok, false);
  assert.deepEqual(r.pendientes, ['listener']);
});

test('un .pid fresco de un proceso MUERTO no acredita', () => {
  const b = banco();
  b.consumidores.forEach((nombre, i) => b.escribirPid(nombre, { pid: 1000 + i, mtimeMs: DESPUES }));
  b.vivos.delete(1002); // dashboard arrancó y se cayó
  const r = b.readiness.verify({ since: ROTACION_MS });
  assert.equal(r.ok, false);
  assert.deepEqual(r.pendientes, ['dashboard']);
});

test('un .pid ausente deja al consumidor pendiente, no lo saltea', () => {
  const b = banco();
  b.escribirPid('pulpo', { pid: 1000, mtimeMs: DESPUES });
  const r = b.readiness.verify({ since: ROTACION_MS });
  assert.equal(r.ok, false);
  assert.deepEqual(r.pendientes.sort(), ['dashboard', 'listener']);
  assert.deepEqual(r.consumers, ['pulpo']);
});

test('un .pid con contenido basura no acredita', () => {
  const b = banco();
  b.consumidores.forEach((nombre, i) => b.escribirPid(nombre, { pid: 1000 + i, mtimeMs: DESPUES }));
  const ruta = path.join(b.dir, archivoPid('pulpo'));
  fs.writeFileSync(ruta, 'no soy un pid');
  fs.utimesSync(ruta, new Date(DESPUES), new Date(DESPUES));
  const r = b.readiness.verify({ since: ROTACION_MS });
  assert.equal(r.ok, false);
  assert.deepEqual(r.pendientes, ['pulpo']);
});

test('sin instante de rotacion NADA se acredita (nunca "todo listo")', () => {
  const b = banco();
  b.consumidores.forEach((nombre, i) => b.escribirPid(nombre, { pid: 1000 + i, mtimeMs: DESPUES }));
  for (const since of [undefined, null, '', 'ayer', NaN]) {
    const r = b.readiness.verify({ since });
    assert.equal(r.ok, false, `since=${JSON.stringify(since)} no puede acreditar`);
    assert.equal(r.consumers.length, 0);
    assert.equal(r.pendientes.length, b.consumidores.length);
  }
});

test('un directorio inexistente deja todo pendiente en vez de explotar', () => {
  const readiness = createRespawnReadiness({
    pipelineDir: path.join(os.tmpdir(), `no-existe-${process.pid}`),
    consumidores: ['pulpo'],
    isAlive: () => true,
  });
  const r = readiness.verify({ since: ROTACION_MS });
  assert.equal(r.ok, false);
  assert.deepEqual(r.pendientes, ['pulpo']);
});

// -----------------------------------------------------------------------------
// 3 · Contención: la evidencia no filtra PIDs ni paths
// -----------------------------------------------------------------------------

test('el resultado lleva nombres logicos, nunca PIDs ni paths', () => {
  const b = banco();
  b.consumidores.forEach((nombre, i) => b.escribirPid(nombre, { pid: 1000 + i, mtimeMs: DESPUES }));
  const r = b.readiness.verify({ since: ROTACION_MS });
  const serializado = JSON.stringify(r);
  assert.ok(!/\b100[0-9]\b/.test(serializado), 'no puede aparecer ningun PID');
  assert.ok(!serializado.includes(b.dir), 'no puede aparecer el path del pipeline');
  assert.deepEqual(Object.keys(r).sort(), ['consumers', 'ok', 'pendientes', 'total']);
});

// -----------------------------------------------------------------------------
// 4 · Coherencia de fuente cruzada con restart.js
// -----------------------------------------------------------------------------

test('la lista de consumidores coincide EXACTAMENTE con COMPONENTS de restart.js', () => {
  // `restart.js` es un script ejecutable: se lee como TEXTO a propósito, porque
  // requerirlo mataría y respawnearía el pipeline entero durante el test.
  const fuente = fs.readFileSync(path.join(REPO_ROOT, '.pipeline', 'restart.js'), 'utf8');
  const bloque = fuente.match(/const COMPONENTS = \[([\s\S]*?)\n\];/);
  assert.ok(bloque, 'no se encontro el bloque COMPONENTS en restart.js');

  const declarados = [...bloque[1].matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(declarados.length > 0, 'COMPONENTS quedo vacio');
  assert.deepEqual([...CONSUMIDORES].sort(), declarados.sort(),
    'La lista de consumidores de larga vida se desincronizo de restart.js. '
    + 'Un componente que arranca y NO esta declarado aca migraria sin acreditar '
    + 'su respawn: seguiria sirviendo el material anterior con la ventana en verde.');
});

test('cada consumidor declarado tiene su archivo .pid derivado del nombre', () => {
  const fuente = fs.readFileSync(path.join(REPO_ROOT, '.pipeline', 'restart.js'), 'utf8');
  const bloque = fuente.match(/const COMPONENTS = \[([\s\S]*?)\n\];/);
  const pares = [...bloque[1].matchAll(/name:\s*'([^']+)'[^}]*pid:\s*'([^']+)'/g)];
  assert.equal(pares.length, CONSUMIDORES.length);
  for (const [, nombre, pid] of pares) {
    assert.equal(archivoPid(nombre), pid,
      `el .pid de "${nombre}" en restart.js no se deriva de su nombre`);
  }
});

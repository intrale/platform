// Test de regresión #6226 — los mensajes del paginado se pisaban en la cola de
// Telegram. Dos dropfiles emitidos en el mismo milisegundo resolvían al mismo
// `${Date.now()}-cmd.json` y el segundo sobreescribía al primero: el operador
// recibía el mensaje 2 sin el 1, sin error ni rastro.
//
// Cubre CA-1 (nombres distintos en el mismo ms), CA-2 (orden preservado),
// CA-3 (no sobreescribe: reintenta + registra) y CA-4 (N mensajes → N archivos
// con los N contenidos íntegros).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dropfileWriter = require('../lib/dropfile-writer');
const grouper = require('../lib/telegram-burst-grouper');
const svcTelegram = require('../servicio-telegram');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dropfile-6226-'));
}

// Reloj congelado: todas las escrituras caen en el MISMO milisegundo, que es
// exactamente la condición que disparaba el bug.
function frozenClock(ms) {
  return () => ms;
}

test.beforeEach(() => dropfileWriter.__resetSeqForTests());

test('CA-1: dos escrituras en el mismo milisegundo generan archivos distintos', () => {
  const dir = tmpDir();
  const now = frozenClock(1787039565917);

  const a = dropfileWriter.writeDropfileSync({ dir, suffix: 'cmd.json', data: '{"text":"uno"}', now });
  const b = dropfileWriter.writeDropfileSync({ dir, suffix: 'cmd.json', data: '{"text":"dos"}', now });

  assert.notStrictEqual(a.filename, b.filename, 'los nombres deben diferir dentro del mismo ms');
  assert.strictEqual(fs.readdirSync(dir).length, 2);
  assert.strictEqual(fs.readFileSync(a.filePath, 'utf8'), '{"text":"uno"}');
  assert.strictEqual(fs.readFileSync(b.filePath, 'utf8'), '{"text":"dos"}');
});

test('CA-2: el orden lexicográfico del nombre es el orden de emisión, con más de 9 mensajes', () => {
  const dir = tmpDir();
  const now = frozenClock(1787039565917);
  // 12 mensajes fuerzan el cruce del dígito 9 al 10: sin zero-padding, `-10-`
  // ordenaría ANTES que `-9-` y el operador leería el paginado desordenado.
  const emitidos = [];
  for (let i = 0; i < 12; i++) {
    emitidos.push(dropfileWriter.writeDropfileSync({ dir, suffix: 'cmd.json', data: `msg-${i}`, now }).filename);
  }

  const enDisco = fs.readdirSync(dir).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  assert.deepStrictEqual(enDisco, emitidos, 'orden por nombre debe coincidir con el de emisión');
});

test('CA-2: el timestamp va al frente, así el orden se mantiene entre milisegundos', () => {
  const dir = tmpDir();
  const n1 = dropfileWriter.writeDropfileSync({ dir, suffix: 'cmd.json', data: 'a', now: frozenClock(1787039565917) }).filename;
  const n2 = dropfileWriter.writeDropfileSync({ dir, suffix: 'cmd.json', data: 'b', now: frozenClock(1787039565918) }).filename;
  assert.ok(n1 < n2, `${n1} debe ordenar antes que ${n2}`);
});

test('CA-3: si el path ya existe no se sobreescribe — se reintenta y queda registro', () => {
  const dir = tmpDir();
  const now = frozenClock(1787039565917);

  // Simula el productor de OTRO proceso que ya ocupó el primer nombre.
  const ocupado = path.join(dir, '1787039565917-0000-cmd.json');
  fs.writeFileSync(ocupado, 'CONTENIDO-PREEXISTENTE');

  const colisiones = [];
  const res = dropfileWriter.writeDropfileSync({
    dir,
    suffix: 'cmd.json',
    data: 'CONTENIDO-NUEVO',
    now,
    onCollision: (name, attempt) => colisiones.push({ name, attempt }),
  });

  assert.strictEqual(fs.readFileSync(ocupado, 'utf8'), 'CONTENIDO-PREEXISTENTE', 'no se debe pisar lo preexistente');
  assert.notStrictEqual(res.filePath, ocupado);
  assert.strictEqual(fs.readFileSync(res.filePath, 'utf8'), 'CONTENIDO-NUEVO');
  assert.strictEqual(res.collisions, 1);
  assert.strictEqual(colisiones.length, 1, 'la colisión debe quedar registrada');
  assert.strictEqual(colisiones[0].name, '1787039565917-0000-cmd.json');
});

test('CA-3: un error que NO es colisión se propaga en vez de enmascararse con otro nombre', () => {
  const dir = tmpDir();
  const fsImpl = {
    writeFileSync() {
      const e = new Error('sin espacio');
      e.code = 'ENOSPC';
      throw e;
    },
  };
  assert.throws(
    () => dropfileWriter.writeDropfileSync({ dir, suffix: 'cmd.json', data: 'x', fsImpl }),
    (e) => e.code === 'ENOSPC'
  );
});

test('CA-4: N mensajes en el mismo tick generan N archivos con los N contenidos íntegros', () => {
  const dir = tmpDir();
  const now = frozenClock(1787039565917);
  const N = 25;

  // Reproduce el patrón real de pulpo.js: `reply` + `extraMessages` del paginado
  // encolados en un `for` síncrono, todo dentro del mismo tick del event loop.
  const payloads = [];
  for (let i = 0; i < N; i++) {
    const p = JSON.stringify({
      text: i === 0 ? 'header + filas' : `_(continúa)_ bloque ${i}`,
      parse_mode: 'MarkdownV2',
    });
    payloads.push(p);
    dropfileWriter.writeDropfileSync({ dir, suffix: 'cmd.json', data: p, now });
  }

  const archivos = fs.readdirSync(dir).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  assert.strictEqual(archivos.length, N, `deben quedar ${N} archivos, no ${archivos.length}`);

  const leidos = archivos.map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
  assert.deepStrictEqual(leidos, payloads, 'los N contenidos deben estar íntegros y en orden');
});

test('CA-2: listWorkFiles drena por nombre, no por el orden del filesystem', () => {
  const dir = tmpDir();
  // Escritos a propósito en orden inverso al de sus nombres.
  for (const n of ['1787039565917-0002-cmd.json', '1787039565917-0000-cmd.json', '1787039565917-0001-cmd.json']) {
    fs.writeFileSync(path.join(dir, n), '{}');
  }
  const nombres = svcTelegram.listWorkFiles(dir).map((e) => e.name);
  assert.deepStrictEqual(nombres, [
    '1787039565917-0000-cmd.json',
    '1787039565917-0001-cmd.json',
    '1787039565917-0002-cmd.json',
  ]);
});

test('CA-2: groupByBurst desempata por nombre cuando el mtime empata', () => {
  const dir = tmpDir();
  const nombres = [
    '1787039565917-0000-cmd.json',
    '1787039565917-0001-cmd.json',
    '1787039565917-0002-cmd.json',
  ];
  nombres.forEach((n, i) => fs.writeFileSync(path.join(dir, n), JSON.stringify({ text: `m${i}` })));

  // fs falso con mtime IDÉNTICO para los tres — el caso del mismo milisegundo.
  const fsImpl = {
    statSync: () => ({ mtimeMs: 1787039565917 }),
    readFileSync: (p, enc) => fs.readFileSync(p, enc),
  };
  // Entrada en orden invertido, como podría devolverla el filesystem.
  const entries = [...nombres].reverse().map((n) => ({ name: n, path: path.join(dir, n) }));
  const groups = grouper.groupByBurst({ fileEntries: entries, windowMs: 60000, fsImpl });

  const orden = groups.flatMap((g) => g.files.map((f) => f.file));
  assert.deepStrictEqual(orden, nombres, 'con mtime empatado, el orden lo debe fijar el nombre');
});

test('invariante: el seq va ANTES del sufijo y no altera la clave de burst', () => {
  // `extractPidFromFilename` matchea `/-(\d+)\.json$/`. Si el seq quedara al
  // final (`…-cmd-0000.json`) cada mensaje derivaría un `pid` distinto y caería
  // en un burst distinto, cambiando en silencio el agrupamiento de TODOS los
  // salientes genéricos del pulpo.
  const dir = tmpDir();
  const now = frozenClock(1787039565917);
  const a = dropfileWriter.writeDropfileSync({ dir, suffix: 'cmd.json', data: '{"text":"uno"}', now });
  const b = dropfileWriter.writeDropfileSync({ dir, suffix: 'cmd.json', data: '{"text":"dos"}', now });

  assert.match(a.filename, /^\d+-\d{4}-cmd\.json$/);

  // Se comprueba sobre el consumidor real: la clave de burst que deriva
  // `loadFileSafe` debe seguir siendo la misma para ambos mensajes.
  const la = grouper.loadFileSafe({ filePath: a.filePath, fileName: a.filename, fsImpl: fs });
  const lb = grouper.loadFileSafe({ filePath: b.filePath, fileName: b.filename, fsImpl: fs });

  assert.strictEqual(la.pid, 'unknown', 'el seq no debe leerse como pid');
  assert.strictEqual(lb.pid, 'unknown', 'el seq no debe leerse como pid');
  assert.strictEqual(la.key, lb.key, 'ambos mensajes deben seguir cayendo en la misma clave de burst');
});

test('invariante: el seq se reinicia en cada milisegundo nuevo', () => {
  const dir = tmpDir();
  const a = dropfileWriter.writeDropfileSync({ dir, suffix: 'cmd.json', data: 'a', now: frozenClock(1000) });
  const b = dropfileWriter.writeDropfileSync({ dir, suffix: 'cmd.json', data: 'b', now: frozenClock(1000) });
  const c = dropfileWriter.writeDropfileSync({ dir, suffix: 'cmd.json', data: 'c', now: frozenClock(1001) });
  assert.strictEqual(a.filename, '1000-0000-cmd.json');
  assert.strictEqual(b.filename, '1000-0001-cmd.json');
  assert.strictEqual(c.filename, '1001-0000-cmd.json');
});

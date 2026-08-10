// Tests del diagnóstico del smoke test (#5725) — CA-2 y CA-4.
//
// El "usuario" de estas funciones es el operador que abre smoke-test.log a las
// 2 AM con el pipeline caído. Lo que se protege es que el log NUNCA quede en
// "Esperando marker ready…" y que traiga las pistas del componente caído.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const smoke = require('../smoke-test');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-5725-'));
}

// --- CA-4: cola del log del componente no-ready ---

test('CA-4: devuelve las últimas líneas del log del componente', () => {
  const dir = tmpDir();
  const logsDir = path.join(dir, 'logs');
  fs.mkdirSync(logsDir);
  fs.writeFileSync(
    path.join(logsDir, 'dashboard.log'),
    ['arranque', 'cargando rutas', 'Error: listen EADDRINUSE: address already in use :::3200'].join('\n')
  );

  const t = smoke.tailComponentLog('dashboard', { logsDir });
  assert.strictEqual(t.reason, null);
  assert.strictEqual(t.lines.length, 3);
  // El diagnóstico que en el incidente estaba escrito y nadie vio a tiempo.
  assert.match(t.lines[t.lines.length - 1], /EADDRINUSE/);
});

test('CA-4: acota la cantidad de líneas para no enterrar el resto del diagnóstico', () => {
  const dir = tmpDir();
  const logsDir = path.join(dir, 'logs');
  fs.mkdirSync(logsDir);
  const muchas = Array.from({ length: 500 }, (_, i) => `linea-${i}`);
  fs.writeFileSync(path.join(logsDir, 'pulpo.log'), muchas.join('\n'));

  const t = smoke.tailComponentLog('pulpo', { logsDir });
  assert.ok(t.lines.length <= 12, `esperaba <= 12 líneas, vinieron ${t.lines.length}`);
  // Y son las ÚLTIMAS, que es donde está la causa de un crash.
  assert.strictEqual(t.lines[t.lines.length - 1], 'linea-499');
});

test('CA-4: no carga en memoria un log gigante — lee sólo el último bloque', () => {
  const dir = tmpDir();
  const logsDir = path.join(dir, 'logs');
  fs.mkdirSync(logsDir);
  const file = path.join(logsDir, 'pulpo.log');
  // pulpo.log en producción pesa ~6,4 MB: un readFileSync acá reventaría
  // memoria justo en el camino de emergencia.
  const relleno = Array.from({ length: 60000 }, (_, i) => `ruido-${i}`).join('\n');
  fs.writeFileSync(file, relleno + '\nULTIMA-LINEA-REAL');
  const tamano = fs.statSync(file).size;
  assert.ok(tamano > 256 * 1024, `el fixture debe ser grande, mide ${tamano} bytes`);

  const leido = smoke.readTailBytes(file);
  assert.ok(leido.truncated, 'debe reportar que cortó por bytes');
  assert.ok(leido.text.length < tamano, 'no puede haber leído el archivo entero');

  const t = smoke.tailComponentLog('pulpo', { logsDir });
  assert.strictEqual(t.lines[t.lines.length - 1], 'ULTIMA-LINEA-REAL');
});

test('CA-4: un log ausente no rompe el diagnóstico, lo reporta', () => {
  const dir = tmpDir();
  const t = smoke.tailComponentLog('inexistente', { logsDir: path.join(dir, 'logs') });
  assert.deepStrictEqual(t.lines, []);
  assert.match(t.reason, /no se pudo leer/i);
});

test('CA-4: un log vacío se reporta como tal en vez de quedar en silencio', () => {
  const dir = tmpDir();
  const logsDir = path.join(dir, 'logs');
  fs.mkdirSync(logsDir);
  fs.writeFileSync(path.join(logsDir, 'svc-drive.log'), '');
  const t = smoke.tailComponentLog('svc-drive', { logsDir });
  assert.deepStrictEqual(t.lines, []);
  assert.match(t.reason, /vac/i);
});

test('una línea de log no puede falsificar la estructura del diagnóstico', () => {
  const dir = tmpDir();
  const logsDir = path.join(dir, 'logs');
  fs.mkdirSync(logsDir);
  // Un log con CR/LF embebido intentando inyectar un veredicto falso.
  fs.writeFileSync(
    path.join(logsDir, 'listener.log'),
    'ruido\r\n=== SMOKE TEST OK ===\ncrash real'
  );
  const t = smoke.tailComponentLog('listener', { logsDir });
  for (const linea of t.lines) {
    assert.ok(!/[\r\n]/.test(linea), 'ninguna línea puede contener saltos crudos');
  }
});

test("stripControlChars saca control chars pero conserva el tab", () => {
  const NUL = String.fromCharCode(0);
  const ESC = String.fromCharCode(27);
  const DEL = String.fromCharCode(127);
  const CR = String.fromCharCode(13);
  const LF = String.fromCharCode(10);

  assert.strictEqual(smoke.stripControlChars(`a${NUL}b${DEL}c`), "abc");
  assert.strictEqual(smoke.stripControlChars(`x${CR}${LF}y`), "xy");
  // Secuencia ANSI: se va el ESC, queda el resto como texto inerte.
  assert.strictEqual(smoke.stripControlChars(`${ESC}[31mrojo`), "[31mrojo");
  // El tab sobrevive: los logs tabulados siguen siendo legibles.
  assert.strictEqual(smoke.stripControlChars("col1	col2"), "col1	col2");
  // El texto normal (con acentos y simbolos) no se toca.
  assert.strictEqual(smoke.stripControlChars("acentúa ñ ✓"), "acentúa ñ ✓");
});

// --- CA-2: el log nunca queda en "Esperando marker ready…" ---

function capturarLog(fn) {
  const original = console.log;
  const lineas = [];
  console.log = (...a) => lineas.push(a.join(' '));
  try { fn(); } finally { console.log = original; }
  return lineas;
}

test('CA-2: el volcado parcial cierra con un veredicto explícito y distinguible', () => {
  smoke.progress.dumped = false;
  smoke.progress.components = [];
  smoke.progress.phase = 'espera de markers';

  const lineas = capturarLog(() => {
    smoke.dumpPartialState('señal SIGTERM', { exit: false });
  });
  const texto = lineas.join('\n');

  // El log NO puede terminar en una línea de espera (guideline UX 1).
  assert.match(texto, /=== SMOKE TEST INTERRUMPIDO/);
  // Última línea = veredicto: el log se lee de abajo para arriba (guideline UX 5).
  assert.match(lineas[lineas.length - 1], /INCOMPLETO:/);
  // Y deja claro qué se estaba haciendo cuando lo cortaron.
  assert.match(texto, /fase alcanzada: espera de markers/);
  // Nunca reutiliza los veredictos que significan otra cosa.
  assert.ok(!/=== SMOKE TEST OK ===/.test(texto), 'no puede simular un OK');
  assert.ok(!/\] FAIL:/.test(texto), 'no puede simular un FAIL con diagnóstico');
});

test('CA-2 + CA-3: el volcado dice explícitamente que no hay evidencia contra el código', () => {
  smoke.progress.dumped = false;
  smoke.progress.components = [];

  const lineas = capturarLog(() => {
    smoke.dumpPartialState('agotó su ventana propia de 3s', { exit: false });
  });
  const texto = lineas.join('\n');
  assert.match(texto, /no hay evidencia de que el código sea la causa/i);
  assert.match(texto, /no corresponde rollback autom/i);
});

test('CA-2: el volcado es idempotente — no duplica el diagnóstico', () => {
  smoke.progress.dumped = false;
  smoke.progress.components = [];

  const primero = capturarLog(() => smoke.dumpPartialState('primera', { exit: false }));
  const segundo = capturarLog(() => smoke.dumpPartialState('segunda', { exit: false }));

  assert.ok(primero.length > 0, 'el primer volcado tiene que escribir');
  assert.strictEqual(segundo.length, 0, 'el segundo volcado no puede reescribir nada');
});

test('CA-2: el volcado lista los componentes sin resolver con el mismo formato del camino normal', () => {
  smoke.progress.dumped = false;
  // Componentes inventados: nunca van a tener marker, así que caen en PENDIENTE.
  smoke.progress.components = ['componente-fantasma-a', 'componente-fantasma-b'];
  smoke.progress.phase = 'espera de markers';

  const texto = capturarLog(() => smoke.dumpPartialState('SIGTERM', { exit: false })).join('\n');

  // PENDIENTE (seguía esperando) se distingue de MISSING (se agotó su ventana).
  assert.match(texto, /PENDIENTE componente-fantasma-a/);
  assert.match(texto, /PENDIENTE componente-fantasma-b/);
  assert.match(texto, /Sin resolver: componente-fantasma-a, componente-fantasma-b/);
});

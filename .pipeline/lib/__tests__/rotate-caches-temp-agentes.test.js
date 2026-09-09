// =============================================================================
// Tests de la rotación de temporales de agentes en `.claude/hooks/rotate-caches.js`.
//
// Por qué existe
// --------------
// En la medición 2026-09-05, `C:\Temp` y `C:\tmp` sumaban 15,5 GB de copias del
// repo hechas por los agentes (qa, po, ux, review) para issues ya cerrados.
// Nadie los miraba: `rotate-caches` sólo veía los cachés de máquina y
// `ghostbusters` sólo `C:\Workspaces`. Por eso el guardián de disco corría cada
// hora liberando 0,00 GB mientras el disco se vaciaba.
//
// Lo que se cubre acá es el criterio de selección, que es lo único peligroso:
// decide qué se borra. `newestMtime` mira el árbol y no sólo el directorio raíz
// porque en Windows el mtime del padre no se propaga desde los hijos — un árbol
// escrito hoy puede tener el raíz con fecha de la semana pasada.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const rc = require('../../../.claude/hooks/rotate-caches');

const HORA = 60 * 60 * 1000;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rotate-caches-test-'));
}

function envejecer(target, ms) {
  const t = new Date(Date.now() - ms);
  fs.utimesSync(target, t, t);
}

test('newestMtime encuentra un archivo fresco enterrado bajo un raíz viejo', () => {
  const raiz = tmpDir();
  const hondo = path.join(raiz, 'a', 'b');
  fs.mkdirSync(hondo, { recursive: true });
  fs.writeFileSync(path.join(hondo, 'vivo.txt'), 'x');
  // Sólo se envejece el raíz: es exactamente el caso que engaña a un stat simple.
  envejecer(raiz, 72 * HORA);

  const deadline = Date.now() - 48 * HORA;
  assert.ok(rc.newestMtime(raiz, deadline) > deadline,
    'un archivo reciente adentro tiene que ganarle a la fecha del raíz');
});

test('newestMtime reporta viejo un árbol enteramente viejo', () => {
  const raiz = tmpDir();
  const sub = path.join(raiz, 'sub');
  fs.mkdirSync(sub, { recursive: true });
  const archivo = path.join(sub, 'viejo.txt');
  fs.writeFileSync(archivo, 'x');
  for (const t of [archivo, sub, raiz]) envejecer(t, 72 * HORA);

  const deadline = Date.now() - 48 * HORA;
  assert.ok(rc.newestMtime(raiz, deadline) <= deadline);
});

test('el umbral de antigüedad es de 48 horas', () => {
  // Más corto pisaría trabajo en curso; más largo no alcanza a sostener un
  // disco que puede caer 8 GB en 10 horas.
  assert.strictEqual(rc.AGENT_TEMP_AGE_MS, 48 * HORA);
});

test('se barren los temporales de agentes, dentro y fuera de %TEMP%', () => {
  // `C:\Temp` y `C:	mp` son los que ninguna automatización miraba; `%TEMP%`
  // se sumó porque acumulaba otros 10 GB con el mismo tipo de basura.
  assert.ok(rc.AGENT_TEMP_DIRS.includes('C:\\Temp'));
  assert.ok(rc.AGENT_TEMP_DIRS.includes('C:\\tmp'));
  assert.ok(rc.AGENT_TEMP_DIRS.includes(os.tmpdir()));
});

test('el scratchpad de las sesiones de Claude nunca se toca', () => {
  // Ahí viven los outputs de tareas en background de una sesión en curso, que
  // puede llevar más de 48h abierta sin escribir nada nuevo.
  assert.ok(rc.AGENT_TEMP_KEEP.has('claude'));
});

test('newestMtime no tira con una ruta inexistente', () => {
  // El módulo es accesorio: un error suyo no puede tumbar la rotación entera.
  assert.strictEqual(rc.newestMtime(path.join(tmpDir(), 'no-existe'), Date.now()), 0);
});

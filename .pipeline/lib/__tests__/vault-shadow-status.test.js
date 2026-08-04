// =============================================================================
// Tests del comando de estado de la ventana sombra (#5449 — split 2/3 de #5427)
// node --test  (entra por el glob existente de `npm run test:pipeline`)
// =============================================================================
//
// Cobertura, por criterio:
//   CA-2   veredicto y motivo primero, en la primera linea
//   CA-3   sólo el estado explícito `cumple` abre con CUMPLE y sale con 0
//   CA-4   fail-closed: incompleto, config inválida, t0, integridad, estado
//          desconocido y excepción salen con NO CUMPLE y código != 0
//   CA-5   pares pendientes con orden ordinal estable y lista vacía explícita
//   CA-6   duración, t0 con unidad/formato y la leyenda literal
//   CA-7   conteos por (secreto, host, vía), pegados a la leyenda
//   CA-8   CR/LF/ESC/C0/C1/separadores Unicode no crean líneas falsas
//   CA-9   cero canario en stdout Y en stderr, en todos los caminos
//   CA-11  entry point real con exit codes reales
//
// Los strings hostiles se construyen con `String.fromCharCode` a propósito: un
// control LITERAL en el fuente del test es invisible al revisar el diff, no
// sobrevive a un copiado y puede romper el propio archivo.
// =============================================================================

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const status = require('../../vault-shadow-status');
const { ESTADO } = require('../vault-shadow-metrics');

const {
  main, renderStatus, exitCodeFor, textoSeguro, categoriaError, EXIT, LEYENDA,
} = status;

const MODULO = path.resolve(__dirname, '..', '..', 'vault-shadow-status.js');
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Valor que NO puede aparecer jamás en la salida. Lleva guiones y minúsculas a
 * propósito: es la forma de una API key real, no un token de laboratorio.
 */
const CANARIO = 'sk-live-canario-9f3a7c2b-NO-DEBE-APARECER';

const ESC = String.fromCharCode(0x1b);
const CR = String.fromCharCode(0x0d);
const LF = String.fromCharCode(0x0a);
const NUL = String.fromCharCode(0x00);
const C1_CSI = String.fromCharCode(0x9b);
const LINE_SEP = String.fromCharCode(0x2028);
const PARA_SEP = String.fromCharCode(0x2029);
const RLO = String.fromCharCode(0x202e);
const ZWSP = String.fromCharCode(0x200b);

/** Stream de mentira con la misma superficie que usa el comando: `write`. */
function capturar() {
  const trozos = [];
  return {
    write(s) { trozos.push(String(s)); return true; },
    texto() { return trozos.join(''); },
  };
}

/** Resultado válido de `evaluate()`. `over` pisa lo que haga falta. */
function resultado(over = {}) {
  return Object.assign({
    estado: ESTADO.CUMPLE,
    motivo: 'cobertura_completa',
    t0: '2026-08-01T00:00:00.000Z',
    ventana_horas: 24,
    horas_transcurridas: 25.5,
    secretos: 2,
    hosts: ['hostAlfa'],
    no_verificados: [],
    negativos: [],
    conteos: [],
    error: null,
  }, over);
}

/** Corre `main` con un evaluador inyectado y devuelve código, stdout y stderr. */
function correr(evaluate) {
  const stdout = capturar();
  const stderr = capturar();
  const code = main({ evaluate, stdout, stderr });
  return { code, out: stdout.texto(), err: stderr.texto() };
}

function primeraLinea(texto) {
  return texto.split('\n')[0];
}

/** Ejecuta un script temporal en un proceso Node real. */
function correrDriver(cuerpo) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-shadow-5449-'));
  const archivo = path.join(dir, 'driver.js');
  try {
    fs.writeFileSync(archivo, cuerpo, 'utf8');
    const r = spawnSync(process.execPath, [archivo], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
      env: Object.assign({}, process.env, { NO_COLOR: '1' }),
    });
    return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// -----------------------------------------------------------------------------
// CA-3 · el camino feliz, y sólo él
// -----------------------------------------------------------------------------

test('el estado explicito `cumple` abre con CUMPLE, muestra el motivo y sale con 0', () => {
  const { code, out, err } = correr(() => resultado());

  assert.match(primeraLinea(out), /^CUMPLE — /);
  assert.ok(primeraLinea(out).length > 'CUMPLE — '.length, 'el motivo va en la MISMA primera linea');
  assert.equal(code, EXIT.CUMPLE);
  assert.equal(err, '', 'el camino feliz no escribe en stderr');
});

test('exitCodeFor usa una allowlist de un solo estado y todo lo demas falla cerrado', () => {
  assert.equal(exitCodeFor({ estado: 'cumple' }), 0);

  // Ni un estado nuevo del nucleo, ni una variante de mayusculas, ni un espacio
  // de mas pueden colarse por el hueco de un `!==`.
  for (const estado of ['no_cumple', 'no_verificado', 'CUMPLE', 'Cumple', 'cumple ', ' cumple',
    'estado_flamante_de_una_version_futura', '', null, undefined, 0, 1, true]) {
    assert.notEqual(exitCodeFor({ estado }), 0, `estado ${JSON.stringify(estado)} no puede dar 0`);
  }

  // Sin resultado utilizable no hay veredicto posible: 2, no 1.
  for (const basura of [null, undefined, 'cumple', 42, []]) {
    assert.equal(exitCodeFor(basura), EXIT.ERROR, `${JSON.stringify(basura)} no es un resultado`);
  }
});

// -----------------------------------------------------------------------------
// CA-4 · fail-closed, estado por estado
// -----------------------------------------------------------------------------

test('cobertura incompleta, config invalida, t0 reiniciado e integridad comprometida dan NO CUMPLE', () => {
  const casos = [
    { estado: ESTADO.NO_CUMPLE, motivo: 'cobertura_incompleta' },
    { estado: ESTADO.NO_CUMPLE, motivo: 'evidencia_negativa' },
    { estado: ESTADO.NO_CUMPLE, motivo: 'ventana_en_curso' },
    { estado: ESTADO.NO_VERIFICADO, motivo: 'hosts_activos_vacio', error: '`vault.shadow_window.hosts_activos` esta vacia' },
    { estado: ESTADO.NO_VERIFICADO, motivo: 'hosts_activos_no_array' },
    { estado: ESTADO.NO_VERIFICADO, motivo: 'hosts_activos_invalido' },
    { estado: ESTADO.NO_VERIFICADO, motivo: 'descriptores_ausentes' },
    { estado: ESTADO.NO_VERIFICADO, motivo: 't0_reiniciado', t0: null },
    { estado: ESTADO.NO_VERIFICADO, motivo: 'integridad_comprometida' },
  ];

  for (const over of casos) {
    const { code, out } = correr(() => resultado(over));
    assert.match(primeraLinea(out), /^NO CUMPLE — /, `motivo ${over.motivo}`);
    assert.notEqual(code, 0, `motivo ${over.motivo} no puede salir con 0`);
    assert.match(out, /^Proximo paso: .+$/m, `motivo ${over.motivo} necesita un proximo paso accionable`);
  }
});

test('un estado desconocido del nucleo no degrada a exito y se nombra como tal', () => {
  const { code, out } = correr(() => resultado({ estado: 'estado_flamante', motivo: 'motivo_flamante' }));

  assert.match(primeraLinea(out), /^NO CUMPLE — /);
  assert.match(out, /estado no reconocido por este comando/);
  assert.match(out, /estado=estado_flamante/);
  assert.match(out, /motivo=motivo_flamante/);
  assert.equal(code, EXIT.NO_CUMPLE);
});

test('la integridad comprometida no imprime el contenido del sidecar', () => {
  const { out, err } = correr(() => resultado({
    estado: ESTADO.NO_VERIFICADO,
    motivo: 'integridad_comprometida',
    error: 'existe el sidecar de integridad: se perdio evidencia negativa',
  }));

  assert.match(out, /sidecar de integridad/);
  // El comando reporta la PRESENCIA, nunca abre el archivo: no puede aparecer
  // ni el motivo interno del append fallido ni una ruta del filesystem.
  assert.ok(!/append_fallido/.test(out + err));
  assert.ok(!/\.pipeline[\\/]audit[\\/]vault-resolution/.test(out));
});

test('una excepcion del evaluador da NO CUMPLE con codigo 2 y no filtra mensaje ni stack', () => {
  const boom = new TypeError(`no se pudo leer ${CANARIO}`);
  boom.code = 'ERR_INVALID_ARG_TYPE';
  const { code, out, err } = correr(() => { throw boom; });

  assert.match(primeraLinea(out), /^NO CUMPLE — /);
  assert.equal(code, EXIT.ERROR);
  // Categoria estable, no el mensaje.
  assert.match(out, /TypeError\/ERR_INVALID_ARG_TYPE/);
  assert.ok(!out.includes(CANARIO) && !err.includes(CANARIO));
  assert.ok(!/at .+:\d+:\d+/.test(out + err), 'ninguna linea de stack');
  // Sin conteos no hay leyenda: una leyenda huerfana confunde (criterio UX).
  assert.ok(!out.includes(LEYENDA));
  assert.match(err, /^\[vault-shadow-status\] ERROR: /m);
});

test('un resultado hostil que explota al renderizarse tambien falla cerrado', () => {
  const trampa = resultado();
  Object.defineProperty(trampa, 'no_verificados', {
    enumerable: true,
    get() { throw new Error(`getter hostil ${CANARIO}`); },
  });

  const { code, out, err } = correr(() => trampa);

  assert.match(primeraLinea(out), /^NO CUMPLE — /);
  assert.equal(code, EXIT.ERROR);
  assert.ok(!out.includes(CANARIO) && !err.includes(CANARIO));
});

// -----------------------------------------------------------------------------
// CA-5 · pares pendientes
// -----------------------------------------------------------------------------

test('los pares no verificados salen ordenados por secreto y despues por host', () => {
  const desordenados = [
    { name: 'providers.openai.api_key', host: 'hostZeta' },
    { name: 'telegram.bot_token', host: 'hostBeta' },
    { name: 'providers.openai.api_key', host: 'hostAlfa' },
    { name: 'telegram.bot_token', host: 'hostAlfa' },
    { name: 'aws.region', host: 'hostZeta' },
  ];

  const { code, out } = correr(() => resultado({
    estado: ESTADO.NO_CUMPLE, motivo: 'cobertura_incompleta', no_verificados: desordenados,
  }));

  const pares = out.split('\n')
    .filter((l) => l.startsWith('  secreto=') && l.includes(' host='))
    .map((l) => l.trim());

  assert.deepEqual(pares, [
    'secreto=aws.region host=hostZeta',
    'secreto=providers.openai.api_key host=hostAlfa',
    'secreto=providers.openai.api_key host=hostZeta',
    'secreto=telegram.bot_token host=hostAlfa',
    'secreto=telegram.bot_token host=hostBeta',
  ]);
  assert.match(out, /Pares \(secreto, host\) sin resolucion por vault: 5/);
  assert.equal(code, EXIT.NO_CUMPLE);
});

test('el orden no depende del orden de llegada: dos permutaciones rinden el mismo texto', () => {
  const pares = [
    { name: 'b.secreto', host: 'hostB' },
    { name: 'a.secreto', host: 'hostB' },
    { name: 'b.secreto', host: 'hostA' },
    { name: 'a.secreto', host: 'hostA' },
  ];
  const uno = renderStatus(resultado({ estado: ESTADO.NO_CUMPLE, motivo: 'cobertura_incompleta', no_verificados: pares }));
  const otro = renderStatus(resultado({
    estado: ESTADO.NO_CUMPLE, motivo: 'cobertura_incompleta', no_verificados: pares.slice().reverse(),
  }));
  assert.equal(uno, otro);
});

test('la lista vacia se dice explicitamente, no se omite', () => {
  const out = renderStatus(resultado());

  assert.match(out, /Pares \(secreto, host\) sin resolucion por vault: 0\n {2}ninguno/);
  assert.match(out, /Resoluciones por fallback dentro de la ventana: 0\n {2}ninguna/);
  assert.match(out, /Resoluciones por \(secreto, host, via\): 0\n {2}ninguna/);
});

// -----------------------------------------------------------------------------
// CA-6 / CA-7 · datos de ventana, conteos y leyenda
// -----------------------------------------------------------------------------

test('duracion, t0 y horas transcurridas salen con unidad y formato explicitos', () => {
  const out = renderStatus(resultado({ ventana_horas: 24, horas_transcurridas: 25.5 }));

  assert.match(out, /^ {2}inicio t0: 2026-08-01T00:00:00\.000Z \(UTC, ISO-8601\)$/m);
  assert.match(out, /^ {2}duracion configurada: 24 h$/m);
  assert.match(out, /^ {2}transcurrido desde t0: 25\.50 h$/m);
});

test('sin t0 se dice que no hay ventana registrada, sin colgarle una unidad vacia', () => {
  const out = renderStatus(resultado({ t0: null, estado: ESTADO.NO_VERIFICADO, motivo: 't0_reiniciado' }));
  assert.match(out, /^ {2}inicio t0: \(sin inicio de ventana registrado\)$/m);
  assert.ok(!/\(sin inicio de ventana registrado\) \(UTC/.test(out));
});

test('un numero no finito no se muestra como NaN ni Infinity', () => {
  const out = renderStatus(resultado({
    ventana_horas: NaN,
    horas_transcurridas: Infinity,
    secretos: undefined,
    conteos: [{ name: 'a.b', host: 'h', via: 'vault', resoluciones: NaN }],
  }));
  assert.ok(!/NaN|Infinity/.test(out));
  assert.match(out, /duracion configurada: \(sin dato\) h/);
});

test('los conteos salen por secreto, host y via, ordenados, y la leyenda literal va pegada', () => {
  const out = renderStatus(resultado({
    conteos: [
      { name: 'telegram.bot_token', host: 'hostBeta', via: 'vault', resoluciones: 2 },
      { name: 'telegram.bot_token', host: 'hostAlfa', via: 'vault', resoluciones: 7 },
      { name: 'telegram.bot_token', host: 'hostAlfa', via: 'file-bootstrap', resoluciones: 1 },
      { name: 'aws.region', host: 'hostAlfa', via: 'vault', resoluciones: 3 },
    ],
  }));

  const lineas = out.split('\n');
  const inicio = lineas.findIndex((l) => l.startsWith('Resoluciones por (secreto, host, via):'));
  assert.ok(inicio >= 0);
  assert.equal(lineas[inicio], 'Resoluciones por (secreto, host, via): 4');
  assert.deepEqual(lineas.slice(inicio + 1, inicio + 5), [
    '  secreto=aws.region host=hostAlfa via=vault resoluciones=3',
    '  secreto=telegram.bot_token host=hostAlfa via=file-bootstrap resoluciones=1',
    '  secreto=telegram.bot_token host=hostAlfa via=vault resoluciones=7',
    '  secreto=telegram.bot_token host=hostBeta via=vault resoluciones=2',
  ]);
  // La leyenda cierra el bloque de conteos: sola queda huerfana (criterio UX).
  assert.equal(lineas[inicio + 5], `  ${LEYENDA}`);
  assert.equal(out.split(LEYENDA).length - 1, 1, 'la leyenda aparece exactamente una vez');
});

test('la jerarquia del reporte es estable: veredicto, pares, negativos, ventana, conteos', () => {
  const out = renderStatus(resultado({
    estado: ESTADO.NO_CUMPLE,
    motivo: 'evidencia_negativa',
    no_verificados: [{ name: 'a.b', host: 'hostAlfa' }],
    negativos: [{ name: 'a.b', host: 'hostAlfa', via: 'file-bootstrap', ts: '2026-08-01T10:00:00.000Z' }],
    conteos: [{ name: 'a.b', host: 'hostAlfa', via: 'file-bootstrap', resoluciones: 1 }],
  }));

  const idx = (frag) => out.indexOf(frag);
  assert.equal(idx('NO CUMPLE'), 0);
  assert.ok(idx('Pares (secreto, host)') < idx('Resoluciones por fallback'));
  assert.ok(idx('Resoluciones por fallback') < idx('Ventana'));
  assert.ok(idx('Ventana') < idx('Resoluciones por (secreto, host, via)'));
  assert.ok(idx('Resoluciones por (secreto, host, via)') < idx(LEYENDA));
});

// -----------------------------------------------------------------------------
// CA-8 · nada de lo que llegue del nucleo puede falsificar una linea
// -----------------------------------------------------------------------------

test('CR, LF, ESC, NUL, C1 y separadores Unicode se escapan y no crean lineas falsas', () => {
  const hostMalicioso = `hostA${CR}${LF}CUMPLE — cobertura completa`;
  const nombreMalicioso = `a.b${ESC}[2K${ESC}[1;31mrojo`;
  const errorMalicioso = `roto${NUL}${C1_CSI}2K${LINE_SEP}linea falsa${PARA_SEP}otra${RLO}oiciled${ZWSP}`;

  const { code, out } = correr(() => resultado({
    estado: ESTADO.NO_CUMPLE,
    motivo: 'cobertura_incompleta',
    error: errorMalicioso,
    no_verificados: [{ name: nombreMalicioso, host: hostMalicioso }],
  }));

  // Cero controles activos en toda la salida.
  for (const [nombre, ch] of [['ESC', ESC], ['CR', CR], ['NUL', NUL], ['C1-CSI', C1_CSI],
    ['LINE_SEP', LINE_SEP], ['PARA_SEP', PARA_SEP], ['RLO', RLO], ['ZWSP', ZWSP]]) {
    assert.ok(!out.includes(ch), `${nombre} no puede sobrevivir crudo en la salida`);
  }
  // Escapados como texto ASCII visible, en una sola linea por campo.
  assert.match(out, /\\u001b\[2K/);
  assert.match(out, /\\u000d\\u000a/);
  assert.match(out, /\\u2028/);
  assert.match(out, /\\u202e/);

  // Y lo que importa: el CR/LF inyectado NO produjo una segunda linea `CUMPLE`.
  const lineasCumple = out.split('\n').filter((l) => l.startsWith('CUMPLE'));
  assert.deepEqual(lineasCumple, [], 'ninguna linea puede empezar con CUMPLE');
  assert.equal(out.split('\n').filter((l) => l.startsWith('  secreto=')).length, 1,
    'el par malicioso ocupa exactamente una linea');
  assert.equal(code, EXIT.NO_CUMPLE);
});

test('un motivo desconocido con controles se nombra saneado, no se ejecuta', () => {
  const { out } = correr(() => resultado({ estado: `x${ESC}[31m`, motivo: `y${CR}${LF}CUMPLE` }));
  assert.ok(!out.includes(ESC) && !out.includes(CR));
  assert.match(out, /estado=x\\u001b\[31m/);
  assert.deepEqual(out.split('\n').filter((l) => l.startsWith('CUMPLE')), []);
});

test('textoSeguro trunca sin dejar media pareja subrogada suelta', () => {
  const largo = 'a'.repeat(199) + String.fromCodePoint(0x1f600);   // emoji = 2 unidades
  const t = textoSeguro(largo);

  assert.ok(t.endsWith('...[truncado]'));
  assert.ok(!/[\uD800-\uDBFF]$/.test(t.replace('...[truncado]', '')), 'sin high surrogate huerfano');
  assert.equal(textoSeguro(''), '(sin dato)');
  assert.equal(textoSeguro(null), '(sin dato)');
  assert.equal(textoSeguro(7), '7');
});

test('categoriaError descarta formas que no son de un error del runtime', () => {
  const e = new TypeError('x');
  e.code = 'ENOENT';
  assert.equal(categoriaError(e), 'TypeError/ENOENT');
  assert.equal(categoriaError({ name: 'MODULE_NOT_FOUND' }), 'MODULE_NOT_FOUND');
  // Un `name`/`code` con forma de secreto (guiones, largo) no pasa el filtro.
  assert.equal(categoriaError({ name: CANARIO, code: CANARIO }), 'Error');
  assert.equal(categoriaError({ name: `X${ESC}[2K` }), 'Error');
  assert.equal(categoriaError(null), 'error');
});

// -----------------------------------------------------------------------------
// CA-9 · el canario no aparece por ningun camino, ni en stdout ni en stderr
// -----------------------------------------------------------------------------

test('ningun camino filtra el canario ni sus derivados en stdout ni en stderr', () => {
  // Cada caso mete el canario donde un render descuidado lo sacaria: un campo
  // extra del resultado, una fila cruda adjunta, el mensaje de una excepcion.
  const casos = {
    cumple: () => Object.assign(resultado(), { valor: CANARIO, env: { TELEGRAM_BOT_TOKEN: CANARIO } }),
    config_invalida: () => Object.assign(resultado({
      estado: ESTADO.NO_VERIFICADO, motivo: 'hosts_activos_invalido',
      error: '`vault.shadow_window.hosts_activos` tiene un valor invalido',
    }), { config_cruda: { token: CANARIO } }),
    integridad: () => Object.assign(resultado({
      estado: ESTADO.NO_VERIFICADO, motivo: 'integridad_comprometida',
    }), { sidecar: `append_fallido:file-bootstrap ${CANARIO}` }),
    fila_corrupta: () => resultado({
      estado: ESTADO.NO_CUMPLE, motivo: 'cobertura_incompleta',
      no_verificados: [{ name: 'telegram.bot_token', host: 'hostAlfa', value: CANARIO, raw: CANARIO }],
      negativos: [{ name: 'telegram.bot_token', host: 'hostAlfa', via: 'missing', ts: '2026-08-01T00:00:00.000Z', sample: CANARIO }],
      conteos: [{ name: 'telegram.bot_token', host: 'hostAlfa', via: 'missing', resoluciones: 1, hash: CANARIO }],
    }),
    excepcion: () => { const e = new Error(`fallo leyendo ${CANARIO}`); e.code = 'EACCES'; throw e; },
    excepcion_sin_error: () => { throw CANARIO; },
  };

  for (const [nombre, evaluate] of Object.entries(casos)) {
    const { out, err } = correr(evaluate);
    assert.ok(!out.includes(CANARIO), `${nombre}: canario en stdout`);
    assert.ok(!err.includes(CANARIO), `${nombre}: canario en stderr`);
    // Derivados: ni prefijo, ni sufijo, ni longitud, ni el nombre de la env var.
    assert.ok(!out.includes('sk-live') && !err.includes('sk-live'), `${nombre}: prefijo del canario`);
    assert.ok(!out.includes(String(CANARIO.length)) || !/longitud|len=/.test(out), `${nombre}: longitud`);
    assert.ok(!/TELEGRAM_BOT_TOKEN/.test(out + err), `${nombre}: env var cruda`);
    assert.ok(!/\{".*\}|\[object Object\]/.test(out), `${nombre}: objeto serializado`);
    assert.match(primeraLinea(out), /^(CUMPLE|NO CUMPLE) — /, `${nombre}: veredicto primero`);
  }
});

// -----------------------------------------------------------------------------
// CA-11 · entry point real, exit codes reales
// -----------------------------------------------------------------------------

test('importar el modulo no ejecuta el comando ni termina el proceso', () => {
  const driver = `const m = require(${JSON.stringify(MODULO)});\n`
    + "if (typeof m.main !== 'function') throw new Error('sin main');\n"
    + "console.log('MODULO_CARGADO_SIN_SALIR');\n";
  const { code, out } = correrDriver(driver);

  assert.equal(code, 0, 'importar no puede matar al runner');
  assert.match(out, /MODULO_CARGADO_SIN_SALIR/);
  assert.ok(!out.includes('CUMPLE'), 'importar no imprime el reporte');
});

test('el entry point devuelve 0 de verdad cuando el nucleo dice `cumple`', () => {
  const fixture = resultado({
    conteos: [{ name: 'telegram.bot_token', host: 'hostAlfa', via: 'vault', resoluciones: 7 }],
  });
  const driver = `const m = require(${JSON.stringify(MODULO)});\n`
    + `process.exitCode = m.main({ evaluate: () => (${JSON.stringify(fixture)}) });\n`;
  const { code, out, err } = correrDriver(driver);

  assert.equal(code, 0);
  assert.match(primeraLinea(out), /^CUMPLE — /);
  assert.match(out, new RegExp(LEYENDA.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(err, '');
});

test('el entry point devuelve un codigo distinto de cero de verdad cuando no cumple', () => {
  const fixture = resultado({
    estado: ESTADO.NO_CUMPLE, motivo: 'cobertura_incompleta',
    no_verificados: [{ name: 'telegram.bot_token', host: 'hostAlfa' }],
  });
  const driver = `const m = require(${JSON.stringify(MODULO)});\n`
    + `process.exitCode = m.main({ evaluate: () => (${JSON.stringify(fixture)}) });\n`;
  const { code, out } = correrDriver(driver);

  assert.equal(code, 1);
  assert.match(primeraLinea(out), /^NO CUMPLE — /);
});

test('la corrida real contra la config del repo respeta el contrato de stdout/stderr y el exit code', () => {
  // Con `hosts_activos: []` commiteado (CA-21 de #5448) el nucleo corta ANTES de
  // tocar t0 o el JSONL: esta corrida no escribe nada en `.pipeline/audit/`.
  const r = spawnSync(process.execPath, [MODULO], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env: Object.assign({}, process.env, { NO_COLOR: '1', COLUMNS: '40' }),
  });

  assert.notEqual(r.status, 0, 'la config vigente no puede aprobar');
  assert.match(primeraLinea(r.stdout), /^NO CUMPLE — /, 'stdout arranca con el veredicto');
  assert.ok(!r.stdout.includes(ESC), 'stdout sin ANSI aun con NO_COLOR y redireccion');
  assert.match(r.stdout, /Proximo paso: /);
  assert.match(r.stdout, new RegExp(LEYENDA.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  // El log operativo del nucleo va a stderr: en stdout solo vive el reporte.
  assert.ok(!r.stdout.includes('[vault-shadow]'), 'los logs del nucleo no ensucian stdout');
  assert.ok(!r.stdout.includes('[config-resolver]'), 'las trazas de config no ensucian stdout');
  // Ninguna linea del reporte lleva un control crudo. La clase se escribe con
  // escapes: un control LITERAL en el fuente del test es invisible en el diff.
  const CONTROLES = new RegExp('[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]');
  for (const linea of r.stdout.split('\n')) {
    assert.ok(!CONTROLES.test(linea), 'sin controles crudos en el reporte');
  }
});

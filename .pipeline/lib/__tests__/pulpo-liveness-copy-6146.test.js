// =============================================================================
// pulpo-liveness-copy-6146.test.js — #6146
//
// Qué se está protegiendo acá
// ---------------------------
// El aviso de margen del vigilante del Pulpo llegaba al operador como una
// métrica cruda con vocabulario interno y una receta de edición de archivo como
// acción sugerida. El operador lo dijo textual: "no le llega al operador; si no
// pido una aclaración, no se entiende". Este archivo es el guardián que hace
// FALLAR el build si el copy vuelve a filtrar jerga interna.
//
// Dos decisiones de diseño del guardián, para que no se entregue en verde con
// la fuga viva:
//
//   1. La denylist se escribe LITERAL acá adentro. NO se importa del módulo de
//      copy. Si la lista viviera en el módulo, quien edita el copy editaría
//      también la lista y el test seguiría verde: un guardián tautológico.
//
//   2. Se verifica el payload ENTERO — `message`, `action`, las CLAVES del
//      detalle y sus VALORES. La fuga histórica no estaba en `message`: la ruta
//      del archivo de configuración y los nombres de las claves viajaban en
//      `action`, y la clave del umbral viajaba como clave del detalle. Un test
//      que sólo mire `message` pasa en verde con la fuga intacta.
//
// Además hay guardias ESTÁTICAS sobre el runner (lee el fuente, no lo ejecuta:
// requerirlo dispararía `main()`, que escribe log, persiste estado y puede
// encolar un mensaje real al canal).
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const copy = require('../pulpo-liveness-copy');

const MODULE_FILE = path.join(__dirname, '..', 'pulpo-liveness-copy.js');
const RUNNER_FILE = path.join(__dirname, '..', '..', 'pulpo-liveness-run.js');

// --- Denylist LITERAL (CA-2). No se importa de ningún lado a propósito. ------
const TERMINOS_INTERNOS = [
  'pulpo_liveness_kill_seconds',
  'pulpo_liveness_percentile_factor',
  'umbral efectivo',
  'umbral_efectivo',
  'margen de liveness',
  'percentil',
  'pico de ciclo',
  'repeticiones silenciadas',
  'repeticiones_silenciadas',
  'config.yaml',
  '.log',
];
const REGEX_INTERNOS = [/pulpo_liveness_\w+/i, /\.pipeline[\\/]/];
// H-UX-1: las claves del detalle se renderizan al operador tal cual, así que el
// nombre de la variable es texto visible. Ninguna puede estar en snake_case.
const SNAKE_CASE = /[a-z0-9]+_[a-z0-9]+/;

function textosDelPayload(alerta) {
  return [alerta.message, alerta.action]
    .concat(Object.keys(alerta.context))
    .concat(Object.values(alerta.context).map(String));
}

function assertSinJergaInterna(textos, etiqueta) {
  for (const texto of textos) {
    const bajo = texto.toLowerCase();
    for (const termino of TERMINOS_INTERNOS) {
      assert.ok(
        !bajo.includes(termino),
        etiqueta + ': el texto entregado al operador filtra "' + termino + '" -> ' + texto
      );
    }
    for (const re of REGEX_INTERNOS) {
      assert.ok(!re.test(texto), etiqueta + ': el texto matchea ' + re + ' -> ' + texto);
    }
  }
}

const INMINENTE = copy.buildMarginAlert({ marginSeconds: 6, prevAlertTs: 0, now: 1000 });
const ATENCION = copy.buildMarginAlert({ marginSeconds: 60, prevAlertTs: 0, now: 1000 });

// =============================================================================
// CA-1 · síntoma y consecuencia primero, no métrica
// =============================================================================

test('CA-1: el primer renglon describe el reinicio de un Pulpo sano y que el Commander deja de responder', () => {
  const casos = [['inminente', INMINENTE], ['atencion', ATENCION]];
  for (const [etiqueta, alerta] of casos) {
    const m = alerta.message;
    assert.ok(/Pulpo/.test(m), etiqueta + ': no nombra al Pulpo');
    assert.ok(/reinicia|reiniciar|reiniciaría/.test(m), etiqueta + ': no dice que lo reinicia');
    assert.ok(
      /trabajando bien/.test(m),
      etiqueta + ': no aclara que el Pulpo está sano — sin eso el aviso se lee como un reinicio justificado'
    );
    assert.ok(
      /Commander deja de responder/.test(m),
      etiqueta + ': no dice la consecuencia que el operador va a ver'
    );
    assert.ok(!/\d/.test(m), etiqueta + ': el mensaje principal contiene una métrica');
  }
});

// =============================================================================
// CA-4 / CA-5 · dos niveles de urgencia distinguibles
// =============================================================================

test('CA-5: el margen corto es inminente y el margen holgado es atencion', () => {
  assert.strictEqual(copy.buildMarginAlert({ marginSeconds: 6 }).urgency, 'inminente');
  assert.strictEqual(copy.buildMarginAlert({ marginSeconds: 30 }).urgency, 'inminente');
  assert.strictEqual(copy.buildMarginAlert({ marginSeconds: 31 }).urgency, 'atencion');
  assert.strictEqual(copy.buildMarginAlert({ marginSeconds: 60 }).urgency, 'atencion');
  assert.strictEqual(copy.INMINENTE_MAX_SECONDS, 30);
});

test('CA-5: los dos niveles se leen distinto sin comparar numeros', () => {
  assert.notStrictEqual(INMINENTE.message, ATENCION.message);
  assert.notStrictEqual(INMINENTE.action, ATENCION.action);
  assert.ok(/está por reiniciar/.test(INMINENTE.message));
  assert.ok(/se está acercando/.test(ATENCION.message));
  assert.ok(/puede pasar en cualquier momento/.test(INMINENTE.context['cuánto falta']));
  assert.ok(/todavía hay aire/.test(ATENCION.context['cuánto falta']));
});

// =============================================================================
// CA-2 + CA-8 + H-UX-1 · guardián de copy sobre el payload completo
// =============================================================================

test('CA-2: ningun nivel filtra vocabulario interno, rutas ni claves de configuracion', () => {
  assertSinJergaInterna(textosDelPayload(INMINENTE), 'inminente');
  assertSinJergaInterna(textosDelPayload(ATENCION), 'atencion');
});

test('CA-2: el guardian detecta una fuga plantada (no es un test que pasa por vacio)', () => {
  assert.throws(
    () => assertSinJergaInterna(['Subí pulpo_liveness_kill_seconds en config.yaml'], 'fuga plantada'),
    /filtra|matchea/
  );
  assert.throws(
    () => assertSinJergaInterna(['editá .pipeline/config.yaml'], 'fuga plantada'),
    /filtra|matchea/
  );
});

test('H-UX-1: ninguna clave del detalle esta en snake_case', () => {
  const conPersistencia = copy.buildMarginAlert({
    marginSeconds: 6,
    prevAlertTs: 1,
    now: 1 + 3600000,
  });
  const claves = []
    .concat(Object.keys(INMINENTE.context))
    .concat(Object.keys(ATENCION.context))
    .concat(Object.keys(conPersistencia.context));
  assert.ok(claves.length > 0, 'el detalle quedó vacío: el guardián no estaría verificando nada');
  for (const clave of claves) {
    assert.ok(
      !SNAKE_CASE.test(clave),
      'la clave "' + clave + '" es un nombre de variable, no lenguaje llano'
    );
  }
  // La regla discrimina: las claves viejas del payload la habrían reprobado.
  for (const vieja of ['si_se_pasa', 'pico_observado', 'umbral_efectivo', 'repeticiones_silenciadas']) {
    assert.ok(SNAKE_CASE.test(vieja), 'la regla anti-snake_case dejó de discriminar');
  }
});

// =============================================================================
// CA-6 · persistencia en lenguaje llano
// =============================================================================

test('CA-6: la persistencia se expresa en lenguaje llano y no como contador', () => {
  const now = 10 * 24 * 3600 * 1000;
  const alerta = copy.buildMarginAlert({ marginSeconds: 6, prevAlertTs: now - 3600000, now });
  assert.ok(/hace una hora/.test(alerta.context['desde cuándo']));
  assert.ok(/viene igual desde/.test(alerta.context['desde cuándo']));
  for (const texto of textosDelPayload(alerta)) {
    assert.ok(!/repeticion/i.test(texto), 'expone el contador de repeticiones: ' + texto);
  }
  assertSinJergaInterna(textosDelPayload(alerta), 'con persistencia');
});

test('CA-6: la tabla de intervalos entregada por ux se respeta', () => {
  assert.strictEqual(copy.formatPersistence(5 * 60000), 'hace 5 minutos');
  assert.strictEqual(copy.formatPersistence(59 * 60000), 'hace 59 minutos');
  assert.strictEqual(copy.formatPersistence(60 * 60000), 'hace una hora');
  assert.strictEqual(copy.formatPersistence(119 * 60000), 'hace una hora');
  assert.strictEqual(copy.formatPersistence(2 * 3600000), 'hace 2 horas');
  assert.strictEqual(copy.formatPersistence(23 * 3600000), 'hace 23 horas');
  assert.strictEqual(copy.formatPersistence(24 * 3600000), 'hace 1 días');
  assert.strictEqual(copy.formatPersistence(72 * 3600000), 'hace 3 días');
});

// =============================================================================
// D-3 / SEC-4 · se omite, no se degrada
// =============================================================================

test('D-3: sin dato de persistencia la clave no existe — nunca "hace 0 minutos" ni "hace NaN"', () => {
  const now = 10 * 24 * 3600 * 1000;
  const casos = [
    ['primera alerta de la vida (ts en 0)', 0],
    ['estado ausente (null)', null],
    ['estado ausente (undefined)', undefined],
    ['estado corrupto (NaN)', NaN],
    ['estado corrupto (texto)', 'ayer'],
    ['reloj hacia atras (ts futuro)', now + 3600000],
    ['cooldown recien arrancado (delta < 60s)', now - 30000],
  ];
  for (const [etiqueta, prevAlertTs] of casos) {
    const alerta = copy.buildMarginAlert({ marginSeconds: 6, prevAlertTs, now });
    assert.ok(
      !Object.prototype.hasOwnProperty.call(alerta.context, 'desde cuándo'),
      etiqueta + ': la clave debería omitirse, salió "' + alerta.context['desde cuándo'] + '"'
    );
    assert.ok(alerta.message.length > 0, etiqueta + ': el aviso no se emitió');
  }
  assert.strictEqual(copy.formatPersistence(NaN), null);
  assert.strictEqual(copy.formatPersistence(-3600000), null);
  assert.strictEqual(copy.formatPersistence(Infinity), null);
  assert.strictEqual(copy.formatPersistence(0), null);
});

test('D-3: `now` no finito tambien omite la linea en vez de degradarla', () => {
  const alerta = copy.buildMarginAlert({ marginSeconds: 6, prevAlertTs: 1000, now: NaN });
  assert.ok(!Object.prototype.hasOwnProperty.call(alerta.context, 'desde cuándo'));
});

// =============================================================================
// D-1 · dato de margen ausente: se avisa igual, en nivel atención
// =============================================================================

test('D-1: sin margen calculable el aviso sale igual, en atencion y sin la clave', () => {
  for (const marginSeconds of [null, undefined, NaN, Infinity, '6']) {
    const alerta = copy.buildMarginAlert({ marginSeconds });
    assert.strictEqual(alerta.urgency, 'atencion', 'margen ' + String(marginSeconds));
    assert.ok(!Object.prototype.hasOwnProperty.call(alerta.context, 'cuánto falta'));
    assert.ok(
      alerta.message.length > 0,
      'el aviso se omitió: un dato ausente nunca silencia la alerta'
    );
    assert.ok(alerta.action.length > 0);
  }
  assert.ok(copy.buildMarginAlert().message.length > 0, 'sin argumentos el aviso igual sale');
});

test('margen negativo (el pico ya cruzo el umbral) es inminente y conserva la clave', () => {
  const alerta = copy.buildMarginAlert({ marginSeconds: -12 });
  assert.strictEqual(alerta.urgency, 'inminente');
  assert.ok(/-12 segundos/.test(alerta.context['cuánto falta']));
});

// =============================================================================
// CA-8 · el módulo de copy es puro (por eso es testeable sin efectos)
// =============================================================================

test('CA-8: el modulo de copy no lee disco, no toca el canal ni el calculo del margen', () => {
  const src = fs.readFileSync(MODULE_FILE, 'utf8');
  const prohibidos = [
    "require('fs')",
    "require('node:fs')",
    "require('path')",
    "require('node:path')",
    'notify-telegram',
    'pulpo-liveness-margin',
    'process.env',
  ];
  for (const prohibido of prohibidos) {
    assert.ok(!src.includes(prohibido), 'el módulo de copy referencia "' + prohibido + '"');
  }
  assert.ok(!/\brequire\s*\(/.test(src), 'el módulo de copy no debería requerir nada');
});

// =============================================================================
// Guardias estáticas sobre el runner (H-2, CA-7, CA-9)
// =============================================================================

function bloqueDeAlerta() {
  const src = fs.readFileSync(RUNNER_FILE, 'utf8');
  const start = src.indexOf('if (marginInfo.degraded)');
  assert.ok(start > 0, 'no se encontró el bloque de la alerta de margen en el runner');
  const end = src.indexOf('bumpAlertRepeats', start);
  assert.ok(end > start, 'no se encontró el cierre del bloque de la alerta de margen');
  return { src, block: src.slice(start, end) };
}

test('H-2: el runner captura prevAlertTs ANTES de markAlert', () => {
  const { block } = bloqueDeAlerta();
  const iPrev = block.indexOf('prevAlertTs');
  const iMark = block.indexOf('markAlert');
  assert.ok(iPrev > -1, 'el runner no captura prevAlertTs: la persistencia saldría siempre en cero');
  assert.ok(iMark > -1, 'el runner ya no marca la alerta');
  assert.ok(
    iPrev < iMark,
    'prevAlertTs se captura DESPUÉS de markAlert: el aviso diría "sigue igual desde hace 0 minutos"'
  );
});

test('CA-2: el bloque del runner tampoco arma copy con jerga interna', () => {
  const { block } = bloqueDeAlerta();
  const bajo = block.toLowerCase();
  const prohibidos = [
    'umbral efectivo',
    'umbral_efectivo',
    'margen de liveness',
    'pico de ciclo',
    'config.yaml',
    'pulpo_liveness_kill_seconds',
    'pulpo_liveness_percentile_factor',
    'repeticiones_silenciadas',
  ];
  for (const termino of prohibidos) {
    assert.ok(!bajo.includes(termino), 'el runner sigue armando copy con "' + termino + '"');
  }
  assert.ok(block.includes('buildMarginAlert'), 'el runner no usa la capa de copy');
});

test('CA-7: el runner deja traza de la emision y de las repeticiones silenciadas', () => {
  const { block } = bloqueDeAlerta();
  assert.ok(/log\(/.test(block), 'no hay log de emisión');
  assert.ok(block.includes('urgencia='), 'el log de emisión no registra la urgencia');
  assert.ok(
    block.includes('repeticionesSilenciadas='),
    'el log de emisión no registra las repeticiones acumuladas'
  );
  const datos = [
    'peakSeconds',
    'effectiveSeconds',
    'thresholdSource',
    'samples',
    'marginSeconds',
    'consumedPct',
  ];
  for (const dato of datos) {
    assert.ok(block.includes(dato), 'el diagnóstico perdió "' + dato + '" al salir del mensaje');
  }
});

test('CA-9 / D-4: bajar la jerga no bajo la severidad', () => {
  const { src, block } = bloqueDeAlerta();
  assert.ok(/notify\(\s*'warn'/.test(block), 'la alerta de margen ya no se emite en nivel warn');
  assert.ok(/notify\(\s*\n?\s*'error'/.test(src), 'la escalada ya no se emite en nivel error');
  assert.ok(src.includes("component: 'pulpo-liveness'"), 'se cambió el canal de emisión');
});

// =============================================================================
// CA-10 · el cálculo del margen no se toca
// =============================================================================

test('CA-10: el modulo de calculo del margen queda fuera del diff', () => {
  let cambiados;
  try {
    cambiados = execFileSync('git', ['diff', '--name-only', 'origin/main'], {
      cwd: path.join(__dirname, '..', '..', '..'),
      encoding: 'utf8',
    });
  } catch (err) {
    // Sin `origin/main` a mano (clone shallow, CI sin fetch) la guardia no puede
    // correr. Se omite explícitamente en vez de fallar por el entorno.
    console.log('CA-10: guardia de diff omitida (git no disponible o sin origin/main)');
    return;
  }
  assert.ok(
    !cambiados.split('\n').some((f) => f.trim() === '.pipeline/lib/pulpo-liveness-margin.js'),
    'el cálculo del margen entró al diff: este issue es sólo copy'
  );
});

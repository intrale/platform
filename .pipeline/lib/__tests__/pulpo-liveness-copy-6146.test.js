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
  // CA-6c (rev-3): la frase vieja afirmaba continuidad ininterrumpida con un
  // dato que sólo prueba repetición. A partir de esta revisión es texto
  // prohibido: si reaparece, es que alguien revirtió L-1 del contrato de `ux`.
  'viene igual desde',
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
  for (const texto of textosDelPayload(alerta)) {
    assert.ok(!/repeticion/i.test(texto), 'expone el contador de repeticiones: ' + texto);
  }
  assertSinJergaInterna(textosDelPayload(alerta), 'con persistencia');
});

test('CA-6c: el texto no afirma continuidad ininterrumpida, sólo dos hechos comprobables', () => {
  // El dato que respalda la línea prueba que hubo avisos repetidos, no que la
  // condición estuvo degradada sin interrupción. "viene igual desde hace 3 días"
  // afirmaba lo segundo — más de lo que el runner sabe. El literal de `ux` (L-1)
  // afirma "hubo un aviso hace tanto" + "sigue pasando ahora", ambos verificables
  // por separado y ninguno de los dos exige continuidad.
  const now = 10 * 24 * 3600 * 1000;
  for (const [etiqueta, marginSeconds] of [['inminente', 6], ['atencion', 60]]) {
    const alerta = copy.buildMarginAlert({ marginSeconds, prevAlertTs: now - 3600000, now });
    const linea = alerta.context['desde cuándo'];
    assert.strictEqual(linea, 'ya te avisé hace una hora y sigue pasando', etiqueta);
    assert.ok(
      !/viene igual/.test(linea),
      etiqueta + ': volvió la frase que afirma continuidad ininterrumpida'
    );
    assertSinJergaInterna(textosDelPayload(alerta), etiqueta + ' con persistencia');
    for (const clave of Object.keys(alerta.context)) {
      assert.ok(!SNAKE_CASE.test(clave), etiqueta + ': clave en snake_case -> ' + clave);
    }
  }
});

test('CA-11: la tabla de intervalos de ux se respeta, con singulares', () => {
  // Contrato v3 L-2. El assert de "hace 1 días" que había acá congelaba el
  // defecto: que un test fije el texto roto no es motivo para conservarlo.
  const tabla = [
    [59 * 1000, null],
    [60 * 1000, 'hace un minuto'],
    [90 * 1000, 'hace un minuto'],
    [120 * 1000, 'hace 2 minutos'],
    [5 * 60000, 'hace 5 minutos'],
    [59 * 60000, 'hace 59 minutos'],
    [60 * 60000, 'hace una hora'],
    [119 * 60000, 'hace una hora'],
    [2 * 3600000, 'hace 2 horas'],
    [23 * 3600000, 'hace 23 horas'],
    [24 * 3600000, 'hace un día'],
    [47 * 3600000, 'hace un día'],
    [48 * 3600000, 'hace 2 días'],
    [72 * 3600000, 'hace 3 días'],
  ];
  for (const [deltaMs, esperado] of tabla) {
    assert.strictEqual(
      copy.formatPersistence(deltaMs),
      esperado,
      'intervalo ' + deltaMs + ' ms'
    );
  }
  // La pluralización tiene que verse en el texto que realmente sale al canal,
  // no sólo en el helper: un cambio en la frase que rearme el número por su
  // cuenta pasaría el bloque de arriba y rompería el aviso igual.
  const now = 30 * 24 * 3600 * 1000;
  for (const [deltaMs, fragmento] of [[60 * 1000, 'hace un minuto'], [24 * 3600000, 'hace un día']]) {
    const alerta = copy.buildMarginAlert({ marginSeconds: 6, prevAlertTs: now - deltaMs, now });
    assert.ok(
      alerta.context['desde cuándo'].includes(fragmento),
      'el aviso no usa el singular: ' + alerta.context['desde cuándo']
    );
  }
});

test('CA-6a: sin evidencia de repetición el runner manda null y la línea no existe', () => {
  // El gate vive en el runner (SEC-7). Acá se fija la contraparte del módulo:
  // que `prevAlertTs: null` OMITA la línea en vez de degradarla. Es el mismo
  // camino que D-3, etiquetado aparte para que nadie lo borre por duplicado.
  const now = 10 * 24 * 3600 * 1000;
  const conEvidencia = copy.buildMarginAlert({ marginSeconds: 6, prevAlertTs: now - 3600000, now });
  const sinEvidencia = copy.buildMarginAlert({ marginSeconds: 6, prevAlertTs: null, now });
  assert.ok(Object.prototype.hasOwnProperty.call(conEvidencia.context, 'desde cuándo'));
  assert.ok(
    !Object.prototype.hasOwnProperty.call(sinEvidencia.context, 'desde cuándo'),
    'con la marca filtrada en null la línea igual salió: el gate del runner no serviría de nada'
  );
  // Caso testigo: mismo margen y misma antigüedad del aviso previo; lo único que
  // los distingue es si hubo observaciones degradadas en la ventana que cerró.
  assert.strictEqual(conEvidencia.message, sinEvidencia.message);
  assert.strictEqual(
    conEvidencia.context['cuánto falta'],
    sinEvidencia.context['cuánto falta']
  );
});

test('SEC-7: la firma del modulo de copy no se amplio para meterle el contador', () => {
  const src = fs.readFileSync(MODULE_FILE, 'utf8');
  assert.ok(
    src.includes('function buildMarginAlert({ marginSeconds, prevAlertTs, now } = {})'),
    'la firma de buildMarginAlert cambió: la contención estructural de CA-2 depende de que el módulo NO reciba más datos'
  );
  for (const prohibido of ['repeat', 'persisted', 'alertRepeats']) {
    assert.ok(
      !src.includes(prohibido),
      'el módulo de copy menciona "' + prohibido + '": un contador interno cruzó el borde del módulo'
    );
  }
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

// El recorte llega hasta el CIERRE del bloque, no hasta `bumpAlertRepeats`.
//
// Con el corte viejo, la rama de recuperación de CA-6b caía fuera del recorte y
// ninguna guardia la alcanzaba: los tests quedaban verdes sin mirar nada. Un
// recorte mal puesto es peor que no tener guardia, así que abajo se verifica que
// el bloque devuelto contenga las dos mitades (la de alerta y la de
// recuperación) y que NO se haya comido la escalada, que emite en otro nivel.
const FIN_DEL_BLOQUE = '#5821 (rebote rev-1)';

function bloqueDeAlerta() {
  const src = fs.readFileSync(RUNNER_FILE, 'utf8');
  const start = src.indexOf('if (marginInfo.degraded)');
  assert.ok(start > 0, 'no se encontró el bloque de la alerta de margen en el runner');
  const end = src.indexOf(FIN_DEL_BLOQUE, start);
  assert.ok(end > start, 'no se encontró el cierre del bloque de la alerta de margen');
  return { src, block: src.slice(start, end) };
}

test('el recorte del guardian cubre el bloque entero y nada mas', () => {
  const { block } = bloqueDeAlerta();
  assert.ok(block.includes('bumpAlertRepeats'), 'el recorte no llega a la rama del cooldown');
  assert.ok(
    block.includes('alertRepeats: 0'),
    'el recorte no llega a la rama de recuperación: las guardias de CA-6b no estarían mirando nada'
  );
  assert.ok(
    !block.includes("action === 'escalate'"),
    'el recorte se comió la escalada: las guardias de conteo de notify() darían falsos positivos'
  );
});

/**
 * El bloque sin comentarios. Las guardias de ORDEN tienen que mirar el código:
 * si miran el texto crudo, alcanza con nombrar `markAlert` en un comentario de
 * arriba para que la comparación de posiciones dé cualquier cosa.
 */
function sinComentarios(block) {
  return block.replace(/^[ \t]*\/\/.*$/gm, '');
}

test('H-2: el runner captura la marca y la cuenta ANTES de markAlert', () => {
  const { block } = bloqueDeAlerta();
  const codigo = sinComentarios(block);
  const iMark = codigo.indexOf('markAlert');
  assert.ok(iMark > -1, 'el runner ya no marca la alerta');
  for (const dato of ['lastAlertTs', 'repeats', 'prevAlertTs']) {
    const i = codigo.indexOf(dato);
    assert.ok(i > -1, 'el runner no captura "' + dato + '"');
    assert.ok(
      i < iMark,
      '"' + dato + '" se captura DESPUÉS de markAlert, que lo pisa: la línea de ' +
        'persistencia saldría siempre en cero o no saldría nunca'
    );
  }
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
    // CA-6c: incluye al literal de rescate, que se redacta acá adentro.
    'viene igual desde',
  ];
  for (const termino of prohibidos) {
    assert.ok(!bajo.includes(termino), 'el runner sigue armando copy con "' + termino + '"');
  }
  assert.ok(block.includes('buildMarginAlert'), 'el runner no usa la capa de copy');
});

test('CA-6a: el runner filtra la marca de tiempo en vez de pasarla cruda', () => {
  const { block } = bloqueDeAlerta();
  assert.ok(
    block.includes('const prevAlertTs = repeats > 0 ? lastAlertTs : null;'),
    'desapareció el gate de persistencia: una condición recién aparecida volvería a afirmarle al operador que ya se le avisó hace días'
  );
  assert.ok(
    !block.includes('prevAlertTs: next.lastAlertTs') &&
      !block.includes('prevAlertTs = next.lastAlertTs'),
    'el runner volvió a pasar lastAlertTs crudo al copy'
  );
  // SEC-7: el borde del módulo sigue siendo esos tres datos y nada más.
  const llamada = block.slice(block.indexOf('buildMarginAlert'));
  const args = llamada.slice(llamada.indexOf('{'), llamada.indexOf('}') + 1);
  assert.ok(
    args.includes('marginSeconds') && args.includes('prevAlertTs') && args.includes('now'),
    'el runner dejó de pasarle al copy alguno de los tres únicos datos del borde: ' + args
  );
  assert.ok(
    !/repeat/i.test(args) && !args.includes('persisted'),
    'un contador interno cruzó el borde del módulo de copy: ' + args
  );
});

test('CA-6b: el runner limpia la evidencia al recuperarse, con guarda de pico', () => {
  const { block } = bloqueDeAlerta();
  const rama = block.slice(block.indexOf('} else if'));
  assert.ok(
    block.indexOf('} else if') > -1,
    'no existe la rama de recuperación: el gate de CA-6a quedaría sucio para siempre'
  );
  assert.ok(
    rama.includes('Number.isFinite(marginInfo.peakSeconds)'),
    'la rama de recuperación no exige un pico medido: una laguna de datos borraría la evidencia de un episodio vivo'
  );
  assert.ok(rama.includes('alertRepeats: 0'), 'la rama de recuperación no limpia la cuenta');
  assert.ok(
    !rama.includes('lastAlertTs: 0') && !rama.includes('lastAlertTs: null'),
    'la recuperación resetea también el cooldown: con la condición oscilando se alertaría en cada oscilación'
  );
});

test('CA-12: el fail-soft degrada el texto pero nunca se traga el aviso', () => {
  const { block } = bloqueDeAlerta();
  const emisiones = block.split('notify(').length - 1;
  assert.strictEqual(
    emisiones,
    1,
    'el bloque emite ' + emisiones + ' veces: con el notify() dentro del try, el catch manda un segundo mensaje o no manda ninguno'
  );
  // El literal de rescate es constante: SEC-6 prohíbe interpolar el error, que
  // en un require fallido trae rutas absolutas del filesystem.
  const rescate = block.slice(block.indexOf('alerta = {'), block.indexOf('};', block.indexOf('alerta = {')));
  assert.ok(rescate.length > 0, 'no hay literal de rescate: un require fallido dejaría al operador sin aviso');
  assert.ok(!/err/.test(rescate), 'el texto de rescate interpola el error: ' + rescate);
  assert.ok(
    rescate.includes('Commander deja de responder'),
    'el rescate perdió la consecuencia que el operador va a ver'
  );
  assert.ok(
    rescate.includes('context: {}'),
    'el rescate arma un detalle que justamente no se pudo construir'
  );
  assertSinJergaInterna([rescate], 'literal de rescate');
  // El detalle del fallo sí queda registrado, pero sólo en el log.
  assert.ok(
    block.includes("log('WARN copy de la alerta de margen no disponible"),
    'el fallo de construcción no deja traza en el log'
  );
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

// =============================================================================
// wave-router.test.js — Tests del routing de `/wave` y NLP "cómo va la ola" (#3262).
//
// CA-1: comando `/wave` (o intención "estado de la ola") devuelve snapshot.
//
// Ejecutar:  node --test .pipeline/lib/__tests__/wave-router.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const commanderDet = require('../commander-deterministic');

// -----------------------------------------------------------------------------
// Helper anti-ReDoS robusto frente a jitter de scheduling (#3938).
//
// Medir wall-clock absoluto de un solo run es flaky: bajo carga (suite completa)
// un classify() perfectamente lineal puede pasar un umbral chico de ms por una
// pausa de GC o contención de CPU, sin que exista backtracking catastrófico.
// El backtracking catastrófico real (lo que SEC-1 quiere detectar) explota de
// forma exponencial → segundos, no decenas de ms.
//
// Estrategia: warmup para neutralizar JIT, y best-of-N para descartar pausas
// transitorias. El "mejor" run refleja el costo algorítmico real del regex;
// un ReDoS NO puede tener un best-of-N bajo porque CADA run cuelga.
function bestClassifyMs(input, runs = 5) {
    for (let i = 0; i < 3; i++) commanderDet.classify(input); // warmup JIT
    let best = Infinity;
    for (let i = 0; i < runs; i++) {
        const t0 = performance.now();
        commanderDet.classify(input);
        best = Math.min(best, performance.now() - t0);
    }
    return best;
}

// Techo holgado: un classify() lineal sobre ~10k chars corre en pocos ms incluso
// bajo carga; un backtracking catastrófico tardaría segundos. 250ms separa ambos
// mundos con amplio margen sin reintroducir flakiness por scheduling.
const REDOS_CEILING_MS = 250;

test('CA-1: /wave clasifica como determinístico → command=wave', () => {
    const r = commanderDet.classify('/wave');
    assert.equal(r.class, 'deterministic');
    assert.equal(r.command, 'wave');
});

test('CA-1: /wave --audio clasifica como determinístico con args="--audio"', () => {
    const r = commanderDet.classify('/wave --audio');
    assert.equal(r.class, 'deterministic');
    assert.equal(r.command, 'wave');
    assert.equal(r.args, '--audio');
});

test('CA-1: intención "cómo va la ola" se mapea a wave', () => {
    const r = commanderDet.classify('cómo va la ola?');
    assert.equal(r.class, 'deterministic');
    assert.equal(r.command, 'wave');
});

test('CA-1: intención "cómo viene la ola" se mapea a wave', () => {
    const r = commanderDet.classify('cómo viene la ola hoy');
    assert.equal(r.class, 'deterministic');
    assert.equal(r.command, 'wave');
});

test('CA-1: intención "estado de la ola" se mapea a wave (no a snapshot)', () => {
    const r = commanderDet.classify('estado de la ola');
    assert.equal(r.class, 'deterministic');
    assert.equal(r.command, 'wave');
});

test('CA-1: "snapshot" aún se mapea a snapshot (no rompemos retrocompatibilidad)', () => {
    const r = commanderDet.classify('snapshot');
    assert.equal(r.class, 'deterministic');
    assert.equal(r.command, 'snapshot');
});

test('validateArgs: wave sin args es válido', () => {
    const v = commanderDet.validateArgs('wave', '');
    assert.equal(v.ok, true);
});

test('validateArgs: wave --audio es válido', () => {
    const v = commanderDet.validateArgs('wave', '--audio');
    assert.equal(v.ok, true);
});

test('validateArgs: wave con flag desconocido es inválido', () => {
    const v = commanderDet.validateArgs('wave', '--video');
    assert.equal(v.ok, false);
    // #3493 — H5 expandió usage a subcomandos: `wave [status [--audio] | next | add <num> #issue | promote]`.
    // El regex anterior `/wave \[--audio\]/` correspondía a la sintaxis pre-H5 (#3262, solo snapshot).
    assert.match(v.usage, /wave \[status \[--audio\] \| next \| add/);
});

test('validateArgs: wave con args arbitrarios es inválido (defensa de injection)', () => {
    const v = commanderDet.validateArgs('wave', '`rm -rf /`');
    assert.equal(v.ok, false);
});

// =============================================================================
// #4089 — Routing sticky del pedido de estado de la ola.
//
// Bug: un pedido de estado fraseado con contexto/correcciones supera los 80
// chars (MAX_SHORT_LENGTH) y antes caía al camino LLM ANTES de probar el patrón
// `wave`, rompiendo el formato fijo de la tabla determinística. El detector
// sticky se evalúa ANTES del corte por longitud y fuerza `deterministic/wave`.
// =============================================================================

test('CA-1 (#4089): pedido LARGO de estado de la ola → deterministic/wave', () => {
    const msg = 'pasame el estado real de la ola actual que el tablero marca raro y quiero ver el detalle';
    assert.ok(msg.length > 80, 'el mensaje debe superar MAX_SHORT_LENGTH para ejercitar el bug');
    const r = commanderDet.classify(msg);
    assert.equal(r.class, 'deterministic');
    assert.equal(r.command, 'wave');
});

test('CA-1 (#4089): pedido LARGO con desync tablero/main → deterministic/wave', () => {
    const msg = 'dame el estado de la ola pero ojo que hay desync con main en el issue X y quiero confirmarlo';
    assert.ok(msg.length > 80);
    const r = commanderDet.classify(msg);
    assert.equal(r.class, 'deterministic');
    assert.equal(r.command, 'wave');
});

test('CA-3 (#4089, guardrail negativo): un pedido de estado largo NUNCA rutea a llm', () => {
    const msg = 'che necesito saber cómo viene la ola en este momento porque el dashboard me marca cualquier cosa';
    assert.ok(msg.length > 80);
    const r = commanderDet.classify(msg);
    // El guardrail: jamás debe terminar en el camino LLM (que arma la tabla a mano).
    assert.notEqual(r.class, 'llm');
    assert.equal(r.command, 'wave');
});

test('CA-4 (#4089, falso positivo): mención conversacional de "ola" NO rutea a wave', () => {
    const r = commanderDet.classify('la ola de calor de ayer estuvo brava');
    assert.notEqual(r.command, 'wave');
});

test('CA-4 (#4089, falso positivo): "olas" en plural sin pedido NO rutea a wave', () => {
    const r = commanderDet.classify('me encantan las olas del mar en verano');
    assert.notEqual(r.command, 'wave');
});

test('CA-2 (#4089): pedido con contexto extra preserva waveResidual con sustancia', () => {
    const r = commanderDet.classify('dame el estado de la ola pero ojo que hay desync con main en el issue X');
    assert.equal(r.command, 'wave');
    assert.ok(typeof r.waveResidual === 'string');
    assert.ok(r.waveResidual.length > 0, 'el residual con contexto no debe ser vacío');
    assert.match(r.waveResidual, /desync/);
});

test('CA-2 (#4089): pedido pelado deja waveResidual vacío', () => {
    const r = commanderDet.classify('estado de la ola');
    assert.equal(r.command, 'wave');
    assert.equal(r.waveResidual, '');
});

test('SEC-1 (#4089, ReDoS): input adversarial ~10k chars + "ola" clasifica en tiempo lineal', () => {
    // Peor caso: verbo de pedido al inicio + relleno enorme + "ola" lejos. El
    // regex sticky es lineal y acotado (clase negada con ventana {0,40}), así
    // que no debe degradar a backtracking catastrófico.
    const adversarial = 'pasame el estado ' + 'a'.repeat(10000) + ' de la ola';
    const elapsed = bestClassifyMs(adversarial);
    assert.ok(
        elapsed < REDOS_CEILING_MS,
        `classify() tardó ${elapsed.toFixed(2)}ms sobre 10k chars (esperado lineal < ${REDOS_CEILING_MS}ms)`,
    );
    // No importa el veredicto exacto del routing acá; importa que NO cuelgue.
    const r = commanderDet.classify(adversarial);
    assert.ok(r && typeof r.class === 'string');
});

test('SEC-1 (#4089, ReDoS): relleno sin verbo de pedido también es lineal', () => {
    const adversarial = 'x'.repeat(12000) + ' ola';
    const elapsed = bestClassifyMs(adversarial);
    assert.ok(
        elapsed < REDOS_CEILING_MS,
        `classify() tardó ${elapsed.toFixed(2)}ms sobre 12k chars (esperado lineal < ${REDOS_CEILING_MS}ms)`,
    );
});

// =============================================================================
// #5835 — MENCIÓN incidental de la ola dentro de una pregunta analítica.
//
// El bug: el sticky de #4089 se comía toda pregunta de opinión que mencionara
// "el avance de la ola" al pasar. El operador pedía una mirada y recibía el
// cuadro — dos veces seguidas sobre el mismo tema. Desde su lado se percibe
// como "el bot no me contesta".
//
// Estos tests corren en PAREJA con los de #4089 de arriba a propósito: los de
// arriba protegen la invariante que NO se debe romper (el pedido explícito
// sigue siendo determinístico), estos protegen la corrección.
// =============================================================================

// Transcripto REAL del chat del operador — 2026-08-11 23:13.
const TRANSCRIPTO_2026_08_11 = [
    'Che Claudito, estuve mirando el dashboard y me quedó una duda con el tema de',
    'los splits. Cuando un issue grande se parte en varios hijos y esos hijos se',
    'suman a la ola, el porcentaje de avance de la ola baja de golpe, porque el',
    'denominador creció pero el numerador no. Quería saber si está bien que cuando',
    'se sumen esos hijos el porcentaje de avance de la ola disminuya, o si eso es',
    'un problema de cómo estamos midiendo el peso de cada issue. Me gustaría que me',
    'des tu mirada sobre esto antes de que toquemos nada.',
].join(' ');

// Transcripto REAL del chat del operador — 2026-08-12 10:15.
const TRANSCRIPTO_2026_08_12 = [
    'Buen día Claudito, ayer a la noche te comenté algo y no me quedó clara la',
    'respuesta. El tema tenía que ver con los cortes o divisiones de los issues y',
    'cómo eso incrementaba el peso o el porcentaje de avance de cada ola. Yo creo',
    'que hay algo mal en cómo se calcula eso cuando aparecen los hijos de un split,',
    'porque el avance de la ola se mueve para atrás sin que nadie haya desandado',
    'trabajo. ¿Lo revisás y me contás qué encontrás?',
].join(' ');

test('CA-4 (#5835, regresión real 2026-08-11 23:13): pregunta analítica rutea a llm', () => {
    assert.ok(TRANSCRIPTO_2026_08_11.length > 400, 'el transcripto real supera los 400 chars');
    const r = commanderDet.classify(TRANSCRIPTO_2026_08_11);
    assert.equal(r.class, 'llm', 'la pregunta debe responderse, no reemplazarse por la tabla');
    assert.notEqual(r.command, 'wave');
    assert.equal(r.waveMentioned, true, 'debe marcarse para anexar la tabla del handler');
    assert.equal(r.args, TRANSCRIPTO_2026_08_11, 'la pregunta completa viaja al LLM');
});

test('CA-4 (#5835, regresión real 2026-08-12 10:15): pregunta analítica rutea a llm', () => {
    assert.ok(TRANSCRIPTO_2026_08_12.length > 400, 'el transcripto real supera los 400 chars');
    const r = commanderDet.classify(TRANSCRIPTO_2026_08_12);
    assert.equal(r.class, 'llm');
    assert.notEqual(r.command, 'wave');
    assert.equal(r.waveMentioned, true);
});

test('CA-2 (#5835): marcador léxico alcanza SOLO, sin umbral de longitud', () => {
    // 45 chars: es exactamente la misma pregunta que los transcriptos largos.
    const msg = '¿está bien que baje el avance de la ola?';
    assert.ok(msg.length < commanderDet.WAVE_ANALYTIC_MIN_LENGTH);
    const r = commanderDet.classify(msg);
    assert.equal(r.class, 'llm');
    assert.equal(r.waveMentioned, true);
});

test('CA-2 (#5835): "me gustaría tu mirada" sobre el avance de la ola rutea a llm', () => {
    const r = commanderDet.classify('me gustaría tu mirada sobre el avance de la ola');
    assert.equal(r.class, 'llm');
    assert.equal(r.waveMentioned, true);
});

test('CA-2 (#5835): "por qué" causal sobre el avance de la ola rutea a llm', () => {
    const r = commanderDet.classify('por qué el avance de la ola bajó de un día para el otro');
    assert.equal(r.class, 'llm');
    assert.equal(r.waveMentioned, true);
});

// --- CA-1: los pedidos explícitos NO deben moverse (sin regresión de #4089) ---

for (const pedido of [
    'estado de la ola',
    'pasame el estado de la ola actual',
    'cómo viene la ola',
    'avance de la ola?',
    'cómo va la ola',
    'status de la ola',
    'resumen de la ola por favor',
]) {
    test(`CA-1 (#5835): "${pedido}" sigue ruteando a wave (invariante #4089)`, () => {
        const r = commanderDet.classify(pedido);
        assert.equal(r.class, 'deterministic', 'la tabla la produce SIEMPRE el handler');
        assert.equal(r.command, 'wave');
        assert.notEqual(r.waveMentioned, true);
    });
}

test('CA-1 (#5835): /wave sigue siendo determinístico', () => {
    const r = commanderDet.classify('/wave');
    assert.equal(r.class, 'deterministic');
    assert.equal(r.command, 'wave');
});

test('CA-1 (#5835): el signo de pregunta NO es el discriminante', () => {
    // `avance de la ola?` es interrogativo y es un PEDIDO. Si el detector usara
    // "es interrogativo" como marcador, este caso se rompería.
    const r = commanderDet.classify('avance de la ola?');
    assert.equal(r.command, 'wave');
});

test('CA-1 (#5835): "porque" causal NO es "por qué" (regresión viva de #4089)', () => {
    // Este mensaje ya estaba protegido por #4089 y debe seguir yendo a wave: el
    // "porque" es lenguaje normal de un pedido con contexto, no una pregunta.
    const msg = 'che necesito saber cómo viene la ola en este momento porque el dashboard me marca cualquier cosa';
    assert.ok(msg.length > 80 && msg.length < commanderDet.WAVE_ANALYTIC_MIN_LENGTH);
    const r = commanderDet.classify(msg);
    assert.equal(r.class, 'deterministic');
    assert.equal(r.command, 'wave');
});

test('CA-2 (#5835): el umbral de longitud se mide sobre el texto SIN la anotación de voz', () => {
    // El sufijo del preprocesador de whisper no debe inflar el conteo. Un pedido
    // corto por voz sigue siendo un pedido.
    const r = commanderDet.classify('pasame el estado de la ola (mensaje de voz transcripto · whisper local)');
    assert.equal(r.class, 'deterministic');
    assert.equal(r.command, 'wave');
});

test('SEC-1 (#5835, ReDoS): detector analítico también es lineal sobre 12k chars', () => {
    const adversarial = 'por qu' + ' está bien que '.repeat(800) + ' avance de la ola';
    const elapsed = bestClassifyMs(adversarial);
    assert.ok(
        elapsed < REDOS_CEILING_MS,
        `classify() tardó ${elapsed.toFixed(2)}ms (esperado lineal < ${REDOS_CEILING_MS}ms)`,
    );
});

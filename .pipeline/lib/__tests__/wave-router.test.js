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

// =============================================================================
// wave-annex-5835.test.js — Anexo de estado de ola en el camino LLM (#5835).
//
// CA-3: cuando el ruteo va al LLM y el mensaje mencionaba la ola, la respuesta
//       incluye el bloque de estado generado por el handler `wave`, TEXTUAL.
// CA-5: ningún camino permite que el LLM produzca una tabla de estado propia.
//
// Ejecutar:  node --test .pipeline/lib/__tests__/wave-annex-5835.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const waveAnnex = require('../wave-annex');

// Render "textual" simulado del handler `wave` — con escapes MarkdownV2 reales
// (`\.`, `\-`) para poder afirmar que llegan intactos y no reescritos.
const REPLY_HANDLER = [
    '🌊 *Ola 12* — avance *42%*',
    '```',
    '#5835 │ dev    │ ⏳',
    '#5822 │ listo  │ ✅',
    '```',
    '_generado 2026\\-08\\-12 10:15_',
].join('\n');

function fakeWaveHandler(opts = {}) {
    fakeWaveHandler.calls.push(opts);
    return Promise.resolve({
        reply: REPLY_HANDLER,
        audioText: 'La ola doce va al cuarenta y dos por ciento.',
        extraMessages: ['(continuación 1)', '(continuación 2)'],
    });
}
fakeWaveHandler.calls = [];

test.beforeEach(() => { fakeWaveHandler.calls = []; });

// -----------------------------------------------------------------------------
// CA-3 — el bloque proviene TEXTUAL del handler
// -----------------------------------------------------------------------------

test('CA-3: el bloque de estado se concatena tal cual lo emitió el handler', async () => {
    const annex = await waveAnnex.buildWaveAnnex({ pipelineRoot: '/tmp/x', handler: fakeWaveHandler });
    assert.ok(annex.messages.length > 0);
    assert.ok(
        annex.messages[0].includes(REPLY_HANDLER),
        'el reply del handler debe aparecer íntegro, sin reescritura ni resumen',
    );
    // Los escapes MarkdownV2 llegan intactos: nadie los "limpió" por el camino.
    assert.match(annex.messages[0], /2026\\-08\\-12/);
});

test('CA-3: el anexo lleva marcador de encuadre fijo, escapado para MarkdownV2', async () => {
    const annex = await waveAnnex.buildWaveAnnex({ pipelineRoot: '/tmp/x', handler: fakeWaveHandler });
    assert.ok(annex.messages[0].startsWith(waveAnnex.WAVE_ANNEX_MARKER));
    // En MarkdownV2 los paréntesis son reservados: sin escapar rompen el render
    // del mensaje entero, incluido el cuadro.
    assert.ok(waveAnnex.WAVE_ANNEX_MARKER.includes('\\('));
    assert.ok(waveAnnex.WAVE_ANNEX_MARKER.includes('\\)'));
});

test('CA-3: el anexo declara parseMode MarkdownV2 (mensaje separado, #4130)', async () => {
    const annex = await waveAnnex.buildWaveAnnex({ pipelineRoot: '/tmp/x', handler: fakeWaveHandler });
    assert.equal(annex.parseMode, 'MarkdownV2');
});

test('CA-3 (#4075): se reenvían los extraMessages del paginado — la ola no se trunca', async () => {
    const annex = await waveAnnex.buildWaveAnnex({ pipelineRoot: '/tmp/x', handler: fakeWaveHandler });
    assert.equal(annex.messages.length, 3, 'reply + 2 extras');
    assert.equal(annex.messages[1], '(continuación 1)');
    assert.equal(annex.messages[2], '(continuación 2)');
});

test('UX-4: el anexo NO arrastra audioText (quien pidió opinión no recibe la tabla narrada)', async () => {
    const annex = await waveAnnex.buildWaveAnnex({ pipelineRoot: '/tmp/x', handler: fakeWaveHandler });
    assert.equal(annex.audioText, undefined);
    assert.equal(fakeWaveHandler.calls[0].audio, false, 'se pide el render sin audio');
});

test('CA-3: el render se pide en readOnly — preguntar no contamina la serie de ETA', async () => {
    await waveAnnex.buildWaveAnnex({ pipelineRoot: '/tmp/x', handler: fakeWaveHandler });
    assert.equal(fakeWaveHandler.calls[0].readOnly, true);
    assert.equal(fakeWaveHandler.calls[0].pipelineRoot, '/tmp/x');
});

test('fail-open: handler sin reply → no se anexa nada, sin explotar', async () => {
    const annex = await waveAnnex.buildWaveAnnex({
        pipelineRoot: '/tmp/x',
        handler: async () => ({ reply: '   ', extraMessages: null }),
    });
    assert.deepEqual(annex.messages, []);
});

// -----------------------------------------------------------------------------
// CA-5 — el LLM no puede emitir una tabla de estado propia
// -----------------------------------------------------------------------------

test('CA-5 (caso negativo): una respuesta del LLM CON tabla queda sin las filas', () => {
    const respuestaLlm = [
        'El avance baja porque al sumar los hijos crece el denominador.',
        '',
        '| Issue | Fase | Estado |',
        '| --- | --- | --- |',
        '| #5835 | dev | en curso |',
        '',
        'Mi recomendación es ponderar por tamaño.',
    ].join('\n');
    const out = waveAnnex.stripLlmWaveTable(respuestaLlm);
    assert.ok(!out.includes('|'), 'ninguna fila de tabla debe sobrevivir');
    assert.match(out, /El avance baja porque/, 'la respuesta a la pregunta se preserva');
    assert.match(out, /Mi recomendación es ponderar/);
});

test('CA-5 (caso negativo): tabla dentro de code-fence también se descarta', () => {
    const respuestaLlm = [
        'Te explico el cálculo.',
        '```',
        '#5835 │ dev │ ⏳',
        '#5822 │ listo │ ✅',
        '```',
        'En resumen: el denominador crece.',
    ].join('\n');
    const out = waveAnnex.stripLlmWaveTable(respuestaLlm);
    assert.ok(!out.includes('```'));
    assert.ok(!out.includes('#5822'));
    assert.match(out, /Te explico el cálculo/);
    assert.match(out, /En resumen/);
});

test('CA-5: si el LLM respondió SÓLO una tabla, se usa el fallback fijo del código', () => {
    const soloTabla = '| Issue | Fase |\n| --- | --- |\n| #5835 | dev |';
    assert.equal(waveAnnex.stripLlmWaveTable(soloTabla), '');
    assert.equal(waveAnnex.safeLlmAnswer(soloTabla), waveAnnex.WAVE_TABLE_ONLY_FALLBACK);
});

test('CA-2: una respuesta sin tablas NO se altera ni se trunca', () => {
    // A diferencia del bloque de aclaración de #4089 (cap 600 chars), acá el
    // texto es la RESPUESTA a la pregunta: truncarla reintroduce el bug.
    const larga = 'Mi análisis del cálculo de avance. '.repeat(60).trim();
    assert.ok(larga.length > 600);
    assert.equal(waveAnnex.safeLlmAnswer(larga), larga);
});

test('CA-2: un pipe suelto (no tabla) no se come la línea', () => {
    const txt = 'Podés correr `node --test | tail -5` para verlo.';
    assert.equal(waveAnnex.stripLlmWaveTable(txt), txt);
});

test('entrada vacía/no-string no explota', () => {
    assert.equal(waveAnnex.stripLlmWaveTable(''), '');
    assert.equal(waveAnnex.stripLlmWaveTable(null), '');
    assert.equal(waveAnnex.stripLlmWaveTable(undefined), '');
    assert.equal(waveAnnex.safeLlmAnswer(''), waveAnnex.WAVE_TABLE_ONLY_FALLBACK);
});

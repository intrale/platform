'use strict';

// =============================================================================
// #5399 · UX-1/UX-2/UX-3 — el dato de autoría de la pausa llega al canal que el
// operador realmente lee, y lo hace sin mentirle.
//
// Contexto del defecto que estos tests blindan: tras el `/restart` del
// 2026-08-02 el operador recibió "🚀 Pipeline reiniciado y listo (modo pausado)
// — Todo en marcha para nuevas pruebas" sobre un pipeline que estuvo 1h33 sin
// despachar. Nadie miró porque el sistema avisó que estaba todo bien.
//
// `buildRestartNotice` es PURA: no hace falta tmpdir ni mocks.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert');

const pauseNotice = require('../pause-notice');
const partialPause = require('../partial-pause');

// Emojis que comunican éxito. Con el pipeline frenado son mentira (UX-1).
const EMOJIS_DE_EXITO = ['🚀', '✅'];

function assertSinEmojiDeExito(msg) {
    for (const emoji of EMOJIS_DE_EXITO) {
        assert.ok(!msg.includes(emoji),
            `el copy de una pausa activa no puede llevar ${emoji}: ${msg}`);
    }
}

function assertNoInstruyeBorrarMarker(msg) {
    // UX-2 — este issue convierte `.paused` en el portador de la autoría:
    // mandar a borrarlo a mano es instruir a destruir el dato que crea.
    assert.ok(!/\.paused/.test(msg), `el copy no debe nombrar el marker: ${msg}`);
    assert.ok(!/\brm\b|borrar|eliminar/i.test(msg), `el copy no debe instruir un borrado: ${msg}`);
}

// -----------------------------------------------------------------------------
// UX-1 — el operador distingue "esperá y se levanta sola" de "esto no arranca solo"
// -----------------------------------------------------------------------------

test('#5399 UX-1: una pausa automatica recuperable se comunica como auto-levantable y sin emoji de exito', () => {
    const msg = pauseNotice.buildRestartNotice({
        mode: 'pausado',
        pauseActive: true,
        source: 'config-corruption-halt',
        autoLiftable: true,
        preserved: true,
    });

    assertSinEmojiDeExito(msg);
    assert.ok(msg.includes('PAUSADO'), 'el operador tiene que ver que quedó pausado');
    assert.ok(msg.includes('heredada'), 'tiene que decir que la pausa viene de antes del restart');
    assert.ok(/se levanta sola/i.test(msg), 'tiene que decir que no requiere intervención');
    assert.ok(!/\/reanudar/.test(msg), 'no puede pedir destrabe sobre una pausa que se levanta sola');
    assertNoInstruyeBorrarMarker(msg);
});

test('#5399 UX-1: una pausa humana se comunica como bloqueante y nombra /reanudar', () => {
    const msg = pauseNotice.buildRestartNotice({
        mode: 'pausado',
        pauseActive: true,
        source: 'telegram',
        autoLiftable: false,
        preserved: true,
    });

    assertSinEmojiDeExito(msg);
    assert.ok(msg.includes('/reanudar'), 'el destrabe se nombra por su comando');
    assert.ok(!/se levanta sola/i.test(msg), 'una pausa humana NO se levanta sola');
    assertNoInstruyeBorrarMarker(msg);
});

test('#5399 UX-1: el copy de una pausa automatica difiere del de una humana', () => {
    const auto = pauseNotice.buildRestartNotice({
        mode: 'pausado', pauseActive: true,
        source: 'config-corruption-halt', autoLiftable: true, preserved: true,
    });
    const humana = pauseNotice.buildRestartNotice({
        mode: 'pausado', pauseActive: true,
        source: 'telegram', autoLiftable: false, preserved: true,
    });

    // Es EL criterio verificable que dejó `ux`: disparar el restart con cada
    // pausa y confirmar que el texto recibido difiere.
    assert.notStrictEqual(auto, humana);
});

test('#5399 UX-1: el restart completo que si despacha conserva el copy de exito', () => {
    const msg = pauseNotice.buildRestartNotice({ mode: 'completo', pauseActive: false });

    assert.ok(msg.includes('🚀'), 'el cohete se reserva para el restart que sí despacha');
    assert.ok(!/PAUSADO/.test(msg));
});

test('#5399 UX-1: si la pausa heredada ya se auto-levanto durante el arranque, el copy lo dice', () => {
    // Escenario central de la historia: el marker sobrevivió al restart con
    // autoría automática y `loadConfig()` lo levantó solo. El operador pidió un
    // restart PAUSADO y sin embargo el pipeline despacha: tiene que enterarse.
    const msg = pauseNotice.buildRestartNotice({ mode: 'pausado', pauseActive: false });

    assert.ok(/ya se levant/i.test(msg), 'tiene que avisar que la pausa se levantó sola');
    assert.ok(/despach/i.test(msg), 'tiene que decir que volvió a despachar');
    assertNoInstruyeBorrarMarker(msg);
});

test('#5399 UX-1: un restart completo sobre un pipeline que quedo pausado no miente con el cohete', () => {
    // Divergencia real entre lo pedido y el estado del filesystem: el marker
    // manda. `pauseActive` sale de `existsSync`, no de last-restart.json.
    const msg = pauseNotice.buildRestartNotice({
        mode: 'completo', pauseActive: true, source: 'manual', autoLiftable: false,
    });

    assertSinEmojiDeExito(msg);
    assert.ok(msg.includes('PAUSADO'));
});

// -----------------------------------------------------------------------------
// UX-1 (segunda mitad) — nunca exponer el enum crudo
// -----------------------------------------------------------------------------

test('#5399 UX-1: el copy traduce la autoria y nunca vuelca el enum crudo', () => {
    for (const source of Object.keys(pauseNotice.PAUSE_SOURCE_LABELS)) {
        const msg = pauseNotice.buildRestartNotice({
            mode: 'pausado', pauseActive: true, source,
            autoLiftable: partialPause.isAutoLiftableSource(source), preserved: true,
        });
        const label = pauseNotice.PAUSE_SOURCE_LABELS[source];
        assert.ok(msg.includes(label),
            `el copy no usa el label humano de "${source}": ${msg}`);
        // Los identificadores internos con guiones (`config-corruption-halt`,
        // `kernel-cutover-degraded-halt`) no significan nada para el operador:
        // no pueden aparecer literales. Los sources de una sola palabra
        // (`wizard`, `telegram`) sí pueden estar DENTRO del label humano, que es
        // castellano legible — ahí no hay enum expuesto.
        if (source.includes('-')) {
            assert.ok(!msg.includes(source),
                `el copy expone el enum interno "${source}" en vez de traducirlo: ${msg}`);
        }
    }
});

test('#5399 UX-1: un source desconocido cae al label generico en vez de volcarse crudo', () => {
    // El marker es un archivo que cualquier proceso del host puede escribir: su
    // contenido no es una fuente confiable de copy para el operador.
    const inyectado = 'source-inventado-por-otro-proceso';
    const msg = pauseNotice.buildRestartNotice({
        mode: 'pausado', pauseActive: true, source: inyectado, autoLiftable: false,
    });

    assert.ok(!msg.includes(inyectado), `volcó el source crudo: ${msg}`);
    assert.ok(msg.includes(pauseNotice.PAUSE_SOURCE_LABEL_FALLBACK));
    assert.ok(msg.includes('/reanudar'), 'lo no identificado es fail-closed: destrabe explícito');
});

test('#5399 UX-1: un source no-string no rompe el copy', () => {
    for (const source of [null, undefined, 42, {}, [], true]) {
        const msg = pauseNotice.buildRestartNotice({
            mode: 'pausado', pauseActive: true, source, autoLiftable: false,
        });
        assert.ok(msg.includes(pauseNotice.PAUSE_SOURCE_LABEL_FALLBACK));
        assertSinEmojiDeExito(msg);
    }
});

// -----------------------------------------------------------------------------
// UX-2 — ningún texto nuevo instruye borrar el marker
// -----------------------------------------------------------------------------

test('#5399 UX-2: ningun copy nuevo instruye borrar el marker de pausa', () => {
    const combinaciones = [
        { mode: 'pausado', pauseActive: true, source: 'config-corruption-halt', autoLiftable: true, preserved: true },
        { mode: 'pausado', pauseActive: true, source: 'kernel-cutover-degraded-halt', autoLiftable: false, preserved: true },
        { mode: 'pausado', pauseActive: true, source: 'telegram', autoLiftable: false, preserved: false },
        { mode: 'pausado', pauseActive: true, source: 'unknown', autoLiftable: false, preserved: true },
        { mode: 'pausado', pauseActive: false },
        { mode: 'completo', pauseActive: false },
        { mode: 'completo', pauseActive: true, source: 'manual', autoLiftable: false },
        {},
    ];
    for (const opts of combinaciones) {
        assertNoInstruyeBorrarMarker(pauseNotice.buildRestartNotice(opts));
    }
});

// -----------------------------------------------------------------------------
// UX-3 — el estado degradado no se comunica como falla
// -----------------------------------------------------------------------------

test('#5399 UX-3: el camino degradado sin preservedFrom no se comunica como error', () => {
    // Lock no adquirido: el marker original quedó intacto (preservación
    // correcta), sólo faltó anotar `preservedFrom`. El operador no debe leer
    // esto como una falla que lo empuje a intervenir a mano.
    const msg = pauseNotice.buildRestartNotice({
        mode: 'pausado', pauseActive: true,
        source: 'config-corruption-halt', autoLiftable: true, preserved: false,
    });

    assert.ok(!/error|fall(o|ó|a)|no se pudo|⚠|❌/i.test(msg),
        `el camino degradado no puede leerse como falla: ${msg}`);
    assert.ok(/se levanta sola/i.test(msg),
        'la autoría se preservó igual: el auto-levantado se sigue comunicando');
    assertNoInstruyeBorrarMarker(msg);
});

// -----------------------------------------------------------------------------
// CA-8 — el copy no participa de la decisión de auto-levantado
// -----------------------------------------------------------------------------

test('#5399 CA-8: el copy no promete auto-levantado sobre una pausa deliberadamente no recuperable', () => {
    // Regresión #5135: `kernel-cutover-degraded-halt` es automática pero exige
    // rollback manual. `autoLiftable` lo decide `isAutoLiftableSource`, no el
    // hecho de que la autoría sea automática.
    const source = 'kernel-cutover-degraded-halt';
    assert.strictEqual(partialPause.isAutoLiftableSource(source), false);

    const msg = pauseNotice.buildRestartNotice({
        mode: 'pausado', pauseActive: true, source,
        autoLiftable: partialPause.isAutoLiftableSource(source), preserved: true,
    });

    assert.ok(!/se levanta sola/i.test(msg), 'no puede prometer un auto-levantado que el gate no hace');
    assert.ok(msg.includes('/reanudar'));
});

// -----------------------------------------------------------------------------
// #5243 rev-1 de review — toda autoría auto-levantable tiene que saber
// explicarse al operador
//
// `secrets-health-halt` entró a `AUTO_LIFTABLE_SOURCES` (`partial-pause.js`)
// pero no a `PAUSE_SOURCE_LABELS`: tras un halt por secretos el `/restart` le
// decía al operador "pausa activa (no se pudo identificar el origen)" sobre una
// pausa que el pipeline mismo puso y sabe explicar. El fallback genérico existe
// para el marker que escribe un tercero, no para las autorías propias.
// -----------------------------------------------------------------------------

test('#5243: el halt por secretos se nombra por su causa, no por el fallback generico', () => {
    const msg = pauseNotice.buildRestartNotice({
        mode: 'pausado',
        pauseActive: true,
        source: 'secrets-health-halt',
        autoLiftable: partialPause.isAutoLiftableSource('secrets-health-halt'),
    });

    assert.ok(!msg.includes(pauseNotice.PAUSE_SOURCE_LABEL_FALLBACK),
        `el copy cae al fallback generico en vez de explicar la causa: ${msg}`);
    assert.ok(msg.includes(pauseNotice.PAUSE_SOURCE_LABELS['secrets-health-halt']));
    assert.ok(/secreto/i.test(msg), 'el operador tiene que saber que lo que faltaba era un secreto');
    // Se auto-levanta al reponer el secreto: el copy no puede mandar a /reanudar
    // ni a borrar el marker (CA-7b de #5243).
    assert.ok(/se levanta sola/i.test(msg));
    assertNoInstruyeBorrarMarker(msg);
});

test('#5243: ninguna autoria auto-levantable puede quedar sin copy propio', () => {
    // Guardrail de la clase de defecto, no del caso: sumar un `source` al set de
    // auto-levantables sin sumarle su línea de copy vuelve a dejar al operador
    // con "no se pudo identificar el origen" sobre una pausa que el pipeline puso.
    for (const source of partialPause.AUTO_LIFTABLE_SOURCES) {
        assert.ok(
            Object.prototype.hasOwnProperty.call(pauseNotice.PAUSE_SOURCE_LABELS, source),
            `"${source}" es auto-levantable pero no tiene label humano en pause-notice.js`,
        );
    }
});

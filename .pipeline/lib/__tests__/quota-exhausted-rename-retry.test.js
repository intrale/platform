// =============================================================================
// quota-exhausted-rename-retry.test.js — #5400
//
// Regresión del flaky de `setFlag: 10 procesos concurrentes producen JSON final
// valido`. Ese test fallaba de forma INTERMITENTE y sólo bajo carga (la suite
// completa corre miles de tests en paralelo): con la máquina contendida, la
// ventana de conflicto de `renameSync` en Windows superaba el budget de retry,
// `setFlag` lanzaba EPERM y el worker salía con exit 1.
//
// La causa raíz NO se testea bien ganándole a una carrera real — eso es
// exactamente lo que producía la intermitencia. Acá se inyectan fallos
// transitorios en `fs.renameSync` para verificar el contrato del retry de forma
// determinística.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const {
    renameWithRetry,
    RENAME_RETRY_MAX_ATTEMPTS,
    RENAME_RETRYABLE_ERRORS,
} = require('../quota-exhausted');

/** Reemplaza fs.renameSync por un stub y garantiza la restauración. */
function withRenameStub(t, impl) {
    const original = fs.renameSync;
    fs.renameSync = impl;
    t.after(() => { fs.renameSync = original; });
}

function errWithCode(code) {
    const e = new Error(`stub ${code}`);
    e.code = code;
    return e;
}

test('el rename se recupera de fallos transitorios en vez de propagar el error', (t) => {
    let calls = 0;
    withRenameStub(t, () => {
        calls++;
        // Falla las primeras dos veces (la carrera real de Windows dura poco).
        if (calls <= 2) throw errWithCode('EPERM');
    });

    assert.doesNotThrow(() => renameWithRetry('/tmp/x.tmp', '/tmp/x.json'));
    assert.equal(calls, 3, 'debe haber reintentado hasta lograrlo');
});

test('el budget de retry tolera mas de un solo reintento bajo contencion sostenida', (t) => {
    let calls = 0;
    withRenameStub(t, () => {
        calls++;
        // Contención larga: falla hasta el penúltimo intento permitido.
        if (calls < RENAME_RETRY_MAX_ATTEMPTS) throw errWithCode('EBUSY');
    });

    assert.doesNotThrow(() => renameWithRetry('/tmp/x.tmp', '/tmp/x.json'));
    assert.equal(
        calls, RENAME_RETRY_MAX_ATTEMPTS,
        'el budget debe permitir agotar los intentos antes de rendirse'
    );
    assert.ok(
        RENAME_RETRY_MAX_ATTEMPTS >= 5,
        'con 10 escritores concurrentes, 3 intentos son insuficientes (causa del flaky)'
    );
});

test('EACCES se trata como transitorio: es la carrera mas comun de Windows', (t) => {
    assert.ok(RENAME_RETRYABLE_ERRORS.has('EACCES'), 'EACCES debe ser retriable');
    assert.ok(RENAME_RETRYABLE_ERRORS.has('EPERM'), 'EPERM debe ser retriable');
    assert.ok(RENAME_RETRYABLE_ERRORS.has('EBUSY'), 'EBUSY debe ser retriable');

    let calls = 0;
    withRenameStub(t, () => {
        calls++;
        if (calls === 1) throw errWithCode('EACCES');
    });
    assert.doesNotThrow(() => renameWithRetry('/tmp/x.tmp', '/tmp/x.json'));
    assert.equal(calls, 2);
});

test('un error NO transitorio se propaga de inmediato sin gastar reintentos', (t) => {
    let calls = 0;
    withRenameStub(t, () => {
        calls++;
        throw errWithCode('ENOENT');  // el origen no existe: reintentar no arregla nada
    });

    assert.throws(() => renameWithRetry('/tmp/x.tmp', '/tmp/x.json'), /ENOENT/);
    assert.equal(calls, 1, 'un error no transitorio no debe reintentarse');
});

test('la contencion permanente termina propagando el error y no cuelga el proceso', (t) => {
    let calls = 0;
    withRenameStub(t, () => { calls++; throw errWithCode('EPERM'); });

    const started = Date.now();
    assert.throws(() => renameWithRetry('/tmp/x.tmp', '/tmp/x.json'), /EPERM/);
    const wallMs = Date.now() - started;

    assert.equal(calls, RENAME_RETRY_MAX_ATTEMPTS, 'debe agotar exactamente el maximo de intentos');
    // Cota anti-DoS: el retry es bounded, nunca spinea indefinidamente.
    assert.ok(wallMs < 5000, `el retry debe estar acotado, tardo ${wallMs}ms`);
    // Recorrió los backoffs de verdad (no salió de largo sin esperar).
    assert.ok(wallMs >= 50, `deberia haber recorrido los backoffs, wall=${wallMs}ms`);
});

// NOTA — por qué NO hay un test del "no quema CPU"
// -----------------------------------------------
// El cambio a `Atomics.wait` (espera bloqueante en vez de busy-wait) es real y
// deliberado, pero NO es testeable de forma determinística acá. Se intentó
// medir `process.cpuUsage()` contra el tiempo de pared y esperar una ratio baja.
// Falla como guard: en una máquina cargada —justo el escenario que importa— el
// proceso que hace busy-wait es DESALOJADO por el scheduler, así que consume
// bastante menos CPU que tiempo de pared y la aserción pasa igual. Medido acá:
// el guard sólo detectaba la regresión en 2 de 5 corridas.
//
// Un test que detecta la regresión el 40% de las veces no es un guard: es otro
// flaky, que es exactamente el defecto que esta entrega vino a corregir. Se deja
// documentado en vez de fingir cobertura.

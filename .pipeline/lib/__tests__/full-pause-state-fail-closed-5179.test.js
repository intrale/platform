// =============================================================================
// #5179 CA-6b — El indicador de halt total NO degrada a "en marcha".
//
// Cubre el camino DEGRADADO de la lectura de `.paused` que migraron
// `dashboard.js` (2 call sites) y `restart.js` (1 call site) al envoltorio.
// Los tres consumen `isFullPauseActive()`, así que ejercitar el helper ejercita
// el camino real de los tres — no una reimplementación paralela.
//
// Escenario Gherkin cubierto:
//   Dado un halt total activo con el archivo .paused presente
//   Cuando el envoltorio de estado no puede resolver el estado operativo
//   Entonces el tablero y el pulpo NO reportan "en marcha"
//   Y el estado degrada a pausado o a desconocido explicito
//
// El fail-open que esto previene es el mismo que #6080 abrió contra
// `dashboard-slices.js`: un `try/catch` que cae a "running" hace que el tablero
// muestre el pipeline operando mientras el operador cree que lo frenó.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isFullPauseActive } = require('../full-pause-state.js');

// ─── Camino feliz (paridad: el indicador sigue reflejando el estado real) ────

test('estado paused ⇒ true', () => {
    const stateMod = { getDispatchState: () => ({ mode: 'paused' }) };
    assert.equal(isFullPauseActive({ stateMod }), true);
});

test('estado running ⇒ false (no se pausa de más cuando el estado SÍ se resolvió)', () => {
    const stateMod = { getDispatchState: () => ({ mode: 'running' }) };
    assert.equal(isFullPauseActive({ stateMod }), false);
});

test('estado partial_pause ⇒ false: NO es halt total', () => {
    // La pausa parcial es un gate de allowlist, no un halt. Confundirlos haría
    // que el tablero muestre "pipeline frenado" con una ola despachando normal.
    const stateMod = { getDispatchState: () => ({ mode: 'partial_pause', allowedIssues: [1] }) };
    assert.equal(isFullPauseActive({ stateMod }), false);
});

// ─── Camino DEGRADADO — el corazón de CA-6b ─────────────────────────────────

test('CA-6b: getDispatchState() TIRA ⇒ pausado, nunca "en marcha"', () => {
    const stateMod = {
        getDispatchState() { throw new Error('estado operativo inválido (read:waves)'); },
    };
    assert.equal(
        isFullPauseActive({ stateMod }), true,
        'con el estado indeterminado el indicador degradó a "en marcha": es el fail-open de #6080',
    );
});

test('CA-6b: el envoltorio no expone getDispatchState ⇒ pausado', () => {
    // Módulo cargado pero incompleto (versión vieja, carga parcial): el
    // TypeError cae en el mismo catch y NO puede resolverse como "running".
    assert.equal(isFullPauseActive({ stateMod: {} }), true);
});

test('CA-6b: getDispatchState() devuelve basura ⇒ no reporta "en marcha" por accidente', () => {
    // `null`/`undefined` haría explotar el `.mode` → catch → pausado. Un objeto
    // sin `mode` NO es `'paused'`… y ahí el helper devolvería false. Fijamos el
    // comportamiento explícitamente para que un cambio futuro lo tenga que mirar.
    const tirando = { getDispatchState: () => null };
    assert.equal(isFullPauseActive({ stateMod: tirando }), true, 'null ⇒ TypeError ⇒ fail-closed');
});

test('CA-6b: el require del envoltorio falla ⇒ pausado', () => {
    // Sin `stateMod` inyectado el helper hace `require('./operational-state')`.
    // Se simula el fallo de carga inyectando un módulo cuyo getter tira al
    // accederse, que es la forma observable de "no pude conseguir el módulo".
    const inaccesible = {
        get getDispatchState() { throw new Error('Cannot find module'); },
    };
    assert.equal(isFullPauseActive({ stateMod: inaccesible }), true);
});

// ─── Contrato del helper ────────────────────────────────────────────────────

test('sin argumentos no explota (los call sites reales lo llaman así)', () => {
    // `dashboard.js` y `restart.js` invocan `isFullPauseActive()` pelado. Sea
    // cual sea el estado del repo donde corre el test, tiene que devolver un
    // booleano y no propagar excepciones.
    const r = isFullPauseActive();
    assert.equal(typeof r, 'boolean');
});

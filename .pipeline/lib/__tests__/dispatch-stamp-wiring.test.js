// =============================================================================
// dispatch-stamp-wiring.test.js — DÓNDE se estampa el despacho efectivo (#5400
// rev-5, B1).
//
// El bloqueante de la review rev-4: la estampa vivía en los call sites, atada a
// `launched`, y `launched` NO significa "salió un agente".
//
//   pulpo.js   -> let launched = false;
//                 launched = slotClaim.reserveSlot(..., { onAcquired })
//   slot-claim -> if (countFn() >= max) return;  onAcquired();  launched = true;
//
// O sea `launched === true` sólo dice "el slot estaba libre y `onAcquired()` no
// tiró excepción". `onAcquired` llama a `lanzarAgenteClaude`, que es SÍNCRONA y
// tiene 8 `return` tempranos ANTES del spawn real — cuota agotada, invariante de
// skill, prompt faltante, workfile corrupto, stale-log, error de worktree,
// worktree irrecuperable, aborto por infra — y NINGUNO lanza excepción.
//
// El caso de cuota agotada es además CÍCLICO: los candidatos vuelven a
// `pendiente/` y el mainLoop los reintenta cada ciclo, re-estampando cada vez.
// Con la cuota agotada el reloj del watchdog nunca avanzaba y el aviso quedaba
// MUDO PARA SIEMPRE — exactamente el escenario que este issue viene a cerrar, y
// con `quota` siendo una de las causas que el issue pide nombrar.
//
// Estos tests cubren las dos mitades: (1) la semántica — estampar sólo en spawn
// real hace que la alerta llegue; (2) el cableado — la estampa está en el punto
// del spawn y no en los call sites.
// =============================================================================

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const wd = require('../wave-stall-watchdog');

const MIN = 60 * 1000;
const PULPO = path.join(__dirname, '..', '..', 'pulpo.js');
const SLOT_CLAIM = path.join(__dirname, '..', 'slot-claim.js');

// ─── 1 · Semántica: el bug producía silencio total con la cuota agotada ─────

/**
 * Simula N ciclos del mainLoop con la cadena de providers gated (cuota agotada)
 * y trabajo elegible esperando.
 *
 * @param {boolean} estampaEnCadaCiclo  true = el bug (estampa aunque no spawnee)
 * @returns {number} cantidad de alertas emitidas
 */
function simularCuotaAgotada(estampaEnCadaCiclo) {
    const inicio = 1_000_000;
    let estado = {
        lastMovementTs: inicio, lastStampTs: inicio,
        lastSignature: null, lastAlertTs: 0, alertCount: 0,
    };
    let lastDispatchTs = inicio;
    let alertas = 0;

    // 3 h de cuota agotada, un ciclo cada minuto.
    for (let min = 1; min <= 180; min++) {
        const now = inicio + min * MIN;

        // El ciclo intenta despachar: `reserveSlot` toma el slot y `onAcquired`
        // corre, pero `lanzarAgenteClaude` sale por el return de quota-exhausted
        // SIN spawnear. `launched` queda en true igual.
        if (estampaEnCadaCiclo) lastDispatchTs = now;

        const d = wd.decide({
            now,
            waveKey: 7,
            enabledCount: 5,          // 5 issues elegibles esperando
            dispatching: 0,           // nadie corriendo: no hay gracia por busy
            cause: { declared: true, kind: 'quota', readable: true },
            lastDispatchTs,
            state: estado,
            stallMinutes: 20,
            cooldownMinutes: 30,
            declaredCauseEscalateMinutes: 45,
        });
        estado = d.nextState;
        if (d.action === 'alert') alertas++;
    }
    return alertas;
}

test('con la cuota agotada y elegibles esperando, estampar en cada ciclo deja al watchdog mudo', () => {
    // Reproducción del bloqueante: es el bug, y produce silencio TOTAL.
    assert.equal(simularCuotaAgotada(true), 0,
        'con la estampa atada a `launched` el reloj se resetea cada ciclo y nunca alerta');
});

test('estampando sólo en el spawn real, la cuota agotada sí dispara la alerta', () => {
    const alertas = simularCuotaAgotada(false);
    assert.ok(alertas > 0,
        'sin despacho efectivo el reloj avanza y la causa `quota` se vuelve alertable (CA-1/CA-2)');
    // Con backoff: unas pocas alertas en 3 h, no una por ciclo (CA-4).
    assert.ok(alertas <= 6, `backoff verificable: ${alertas} alertas en 3 h de detención`);
});

test('un despacho real sí resetea el reloj y no se alerta', () => {
    // No-regresión: la estampa tiene que seguir funcionando cuando SÍ hay spawn.
    const inicio = 1_000_000;
    let estado = {
        lastMovementTs: inicio, lastStampTs: inicio,
        lastSignature: null, lastAlertTs: 0, alertCount: 0,
    };
    let alertas = 0;
    for (let min = 1; min <= 180; min++) {
        const now = inicio + min * MIN;
        const d = wd.decide({
            now,
            waveKey: 7,
            enabledCount: 5,
            dispatching: 1,
            cause: null,
            lastDispatchTs: now,   // spawn real en cada ciclo
            state: estado,
            stallMinutes: 20,
            cooldownMinutes: 30,
            declaredCauseEscalateMinutes: 45,
        });
        estado = d.nextState;
        if (d.action === 'alert') alertas++;
    }
    assert.equal(alertas, 0, 'un pipeline que despacha de verdad jamás alerta');
});

// ─── 2 · Cableado: la estampa vive en el spawn, no en los call sites ────────

test('`launched` de reserveSlot no prueba que se haya lanzado un agente', () => {
    // La premisa del bloqueante, verificada contra el source real de slot-claim.
    const src = fs.readFileSync(SLOT_CLAIM, 'utf8');
    assert.ok(
        /if\s*\(countFn\(\)\s*>=\s*max\)\s*return;\s*onAcquired\(\);\s*launched\s*=\s*true;/.test(
            src.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ').replace(/ /g, ' '),
        ) || /onAcquired\(\);[\s\S]{0,80}launched\s*=\s*true/.test(src),
        '`launched = true` va inmediatamente después de `onAcquired()`, sin verificar spawn',
    );
});

test('la estampa de despacho efectivo se hace en el punto del spawn, no en los call sites', () => {
    const src = fs.readFileSync(PULPO, 'utf8');

    // (a) Está inmediatamente después del spawn real, y GUARDADA por el PID.
    assert.ok(
        /const child = launchResult\.child;[\s\S]{0,2600}?if \(child && child\.pid\) \{\s*marcarDespachoEfectivo\(\{ issue, skill, fase, pipeline \}\);/
            .test(src),
        'debe estamparse justo después de `const child = launchResult.child`, sólo con PID real',
    );

    // (b) Ya NO está atada a `launched` en el call site del loop de candidatos.
    assert.ok(
        !/if\s*\(launched\)\s*\{[\s\S]{0,600}?marcarDespachoEfectivo/.test(src),
        'la estampa no puede depender de `launched`: no prueba que haya salido un agente',
    );

    // (c) Ya NO está en el call site del deadlock breaker.
    assert.ok(
        !/_dcState\.anyLaunched = true;[\s\S]{0,400}?marcarDespachoEfectivo\(\{ issue, skill, fase, pipeline: pipelineName \}\)/
            .test(src),
        'el lanzamiento forzado del breaker también estampa desde dentro de lanzarAgenteClaude',
    );

    // (d) Sólo quedan los dos puntos legítimos: el spawn y el ejecutor
    //     determinístico del contrato de tarea (que también es despacho real).
    const estampas = src.match(/^\s*marcarDespachoEfectivo\(/gm) || [];
    assert.equal(estampas.length, 2,
        `sólo el spawn y el ejecutor determinístico estampan; encontradas ${estampas.length}`);
});

// ─── 3 · B1 residual: un spawn sin PID no es un despacho ───────────────────

test('un spawn que no devuelve PID no estampa despacho y el watchdog sigue alertando', () => {
    // `spawn` NO tira sincrónicamente cuando falta el ejecutable: devuelve un
    // `ChildProcess` con `pid === undefined` y emite `'error'` asíncrono. El
    // workfile vuelve a `pendiente/` y el mainLoop reintenta cada ciclo — misma
    // forma cíclica que la cuota agotada. Si la estampa no estuviera guardada
    // por el PID, el reloj se resetearía en cada vuelta y el watchdog volvería a
    // quedar mudo para siempre.
    const inicio = 1_000_000;
    let estado = {
        lastMovementTs: inicio, lastStampTs: inicio,
        lastSignature: null, lastAlertTs: 0, alertCount: 0,
    };
    let lastDispatchTs = inicio;
    let alertas = 0;

    for (let min = 1; min <= 180; min++) {
        const now = inicio + min * MIN;

        // El ciclo llega al spawn, pero el launcher devuelve `{ child }` sin
        // PID. Ésta es la guarda bajo test: sólo se estampa con PID real.
        const child = { pid: undefined };
        if (child && child.pid) lastDispatchTs = now;

        const d = wd.decide({
            now,
            waveKey: 7,
            enabledCount: 5,
            dispatching: 0,
            cause: { declared: true, kind: 'quota', readable: true },
            lastDispatchTs,
            state: estado,
            stallMinutes: 20,
            cooldownMinutes: 30,
            declaredCauseEscalateMinutes: 45,
        });
        estado = d.nextState;
        if (d.action === 'alert') alertas++;
    }

    assert.ok(alertas > 0,
        'un spawn fallido no puede contar como despacho: el watchdog tiene que alertar igual');
});

test('la guarda del PID está cableada en el punto del spawn', () => {
    // Guardia de fuente: sin el `if (child && child.pid)` el test de arriba
    // seguiría verde (ejercita la semántica, no el cableado real).
    const src = fs.readFileSync(PULPO, 'utf8');
    assert.ok(
        /if \(child && child\.pid\) \{[\s\S]{0,200}?marcarDespachoEfectivo\(/.test(src),
        'la estampa del spawn LLM debe estar guardada por `child && child.pid`',
    );
});

test('el ejecutor determinístico del contrato de tarea también estampa despacho', () => {
    // No tiene `child` (resuelve la fase con una promesa, sin LLM ni worktree),
    // así que la estampa del spawn no lo cubre: sin punto propio, una ola
    // resuelta íntegramente por contratos alertaría en falso.
    const src = fs.readFileSync(PULPO, 'utf8');
    assert.ok(
        /taskContract\.runContractPhase\([\s\S]{0,3000}?marcarDespachoEfectivo\(\{ issue, skill, fase, pipeline \}\);\s*return;/
            .test(src),
        'la rama del ejecutor determinístico debe estampar antes de su `return`',
    );
});

// =============================================================================
// dispatch-stall-watchdog.test.js — Watchdog de inactividad de DESPACHO (#5400).
//
// El 2026-08-02 el pipeline estuvo 1h33 sin despachar y no llegó NINGUNA
// notificación. El watchdog de ola (#4708) existía pero: (a) estaba apagado,
// (b) una causa declarada lo callaba para siempre, (c) medía el movimiento con
// el conteo de `trabajando/`, que miente cuando un agente queda clavado.
//
// Un test por escenario Gherkin del issue + las regresiones que el análisis
// marcó como obligatorias:
//   G-3    un agente clavado no congela el reloj
//   R-3    no-regresión de #4751 (modo ola por debajo del umbral sigue mudo)
//   SEC-2  autoría declarada, nunca atribuida a una persona sin dato
//   SEC-3  el watchdog es read-only (no destraba nada)
//   SEC-4  clamp del umbral nuevo (0 / negativo / gigante no lo desactivan)
// =============================================================================

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const wd = require('../wave-stall-watchdog');
const lastDispatch = require('../last-dispatch');

const MIN = 60 * 1000;

// Foto base con estampa de despacho efectivo: el pipeline no despacha desde
// `lastDispatchTs`, hay trabajo elegible y el estado ya vio esa estampa.
function pipelineFacts(overrides = {}) {
    const lastDispatchTs = overrides.lastDispatchTs !== undefined ? overrides.lastDispatchTs : 20 * MIN;
    return {
        now: 120 * MIN,
        waveKey: 7,
        enabledCount: 5,
        dispatching: 0,
        progressSeries: [{ ts: 1, waveKey: 7, avancePct: 42 }],
        cause: null,
        lastDispatchTs,
        state: {
            lastMovementTs: lastDispatchTs,
            lastSignature: `0:42:${lastDispatchTs}`,
            lastAlertTs: 0,
            alertCount: 0,
        },
        stallMinutes: 20,
        cooldownMinutes: 30,
        declaredCauseEscalateMinutes: 45,
        ...overrides,
    };
}

// ─── Escenario Gherkin 1 · pipeline pausado más allá del umbral ──────────────

test('pipeline pausado más allá del umbral emite alerta nombrando la pausa y su autoría', () => {
    // Pausa preservada por un restart, declarada hace 100 min (> 45 de escalada).
    const d = wd.decide(pipelineFacts({
        cause: { declared: true, kind: 'human-halt', readable: true, sinceTs: 20 * MIN },
        authorDeclared: 'leitolarreta',
    }));
    assert.equal(d.action, 'alert');
    assert.equal(d.reason, 'stale-declared-cause:human-halt');
    assert.equal(d.level, 'warn');
    // CA-2: nombra la causa concreta, no un mensaje genérico.
    assert.ok(d.message.includes('pausa total declarada por el operador'), d.message);
    // Autoría rotulada como DECLARADA (SEC-2).
    assert.ok(d.message.includes('autoría declarada: leitolarreta'), d.message);
    // Cantidad de issues elegibles esperando.
    assert.ok(d.message.includes('5 issue(s) habilitado(s)'), d.message);
});

// ─── Escenario Gherkin 2 · cola legítimamente vacía ──────────────────────────

test('cola legítimamente vacía no genera alerta', () => {
    const d = wd.decide(pipelineFacts({ enabledCount: 0, cause: null }));
    assert.equal(d.action, 'skip');
    assert.equal(d.reason, 'no-enabled-work');
    assert.equal(d.message, null);
});

test('una causa vieja tampoco alerta si no hay trabajo elegible esperando (CA-3 manda)', () => {
    const d = wd.decide(pipelineFacts({
        enabledCount: 0,
        cause: { declared: true, kind: 'human-halt', readable: true, sinceTs: 20 * MIN },
    }));
    assert.equal(d.action, 'skip');
    assert.equal(d.reason, 'no-enabled-work');
    assert.equal(d.message, null);
});

// ─── Escenario Gherkin 3 · recuperación del despacho ─────────────────────────

test('recuperación del despacho emite aviso con la duración total de la detención', () => {
    // Episodio ya alertado (alertCount 2), último despacho previo a los 20 min.
    // Ahora entra una estampa nueva a los 120 min → detención de 100 min.
    const d = wd.decide(pipelineFacts({
        now: 120 * MIN,
        lastDispatchTs: 120 * MIN,
        state: {
            lastMovementTs: 20 * MIN,
            lastSignature: `0:42:${20 * MIN}`,
            lastAlertTs: 100 * MIN,
            alertCount: 2,
        },
    }));
    assert.ok(d.recovery, 'debe traer payload de recuperación');
    assert.equal(d.recovery.outageMs, 100 * MIN);
    assert.ok(d.recovery.message.includes('1 h 40 min'), d.recovery.message);
    assert.ok(d.recovery.message.includes('despacho reanudado'), d.recovery.message);
    // El episodio se cierra: no re-alerta ni deja contador colgado.
    assert.equal(d.nextState.alertCount, 0);
    assert.equal(d.nextState.lastAlertTs, 0);
});

test('la recuperación se emite UNA sola vez (el tick siguiente ya no la repite)', () => {
    const primero = wd.decide(pipelineFacts({
        now: 120 * MIN,
        lastDispatchTs: 120 * MIN,
        state: {
            lastMovementTs: 20 * MIN, lastSignature: `0:42:${20 * MIN}`,
            lastAlertTs: 100 * MIN, alertCount: 2,
        },
    }));
    assert.ok(primero.recovery);
    // Segundo tick con el estado ya persistido y la misma estampa.
    const segundo = wd.decide(pipelineFacts({
        now: 121 * MIN, lastDispatchTs: 120 * MIN, state: primero.nextState,
    }));
    assert.equal(segundo.recovery, null);
});

test('sin alerta previa, reanudar el despacho NO emite aviso de recuperación', () => {
    // Nadie se enteró de nada: no hay nada que "recuperar" que valga un mensaje.
    const d = wd.decide(pipelineFacts({
        now: 120 * MIN,
        lastDispatchTs: 120 * MIN,
        state: { lastMovementTs: 100 * MIN, lastSignature: `0:42:${100 * MIN}`, lastAlertTs: 0, alertCount: 0 },
    }));
    assert.equal(d.recovery, null);
});

test('los agentes terminando NO se confunden con un despacho nuevo', () => {
    // El conteo de `trabajando/` baja de 3 a 0 sin que salga nada nuevo. Con la
    // proxy vieja eso reiniciaba el reloj y habría emitido una recuperación falsa.
    const d = wd.decide(pipelineFacts({
        now: 120 * MIN,
        dispatching: 0,
        lastDispatchTs: 20 * MIN,
        state: {
            lastMovementTs: 20 * MIN, lastSignature: `3:42:${20 * MIN}`,
            lastAlertTs: 100 * MIN, alertCount: 1,
        },
    }));
    assert.equal(d.recovery, null, 'terminar trabajo no es despachar trabajo');
    assert.equal(d.nextState.lastMovementTs, 20 * MIN, 'el reloj no se reinicia');
});

// ─── G-3 · el conteo de trabajando/ no es la señal ──────────────────────────

test('un agente clavado en trabajando no congela el reloj de despacho', () => {
    // 3 agentes vivos en `trabajando/` pero el último despacho fue hace 100 min.
    // Con la proxy de conteo esto era `skip: dispatching` para siempre.
    const d = wd.decide(pipelineFacts({ dispatching: 3, lastDispatchTs: 20 * MIN }));
    assert.equal(d.action, 'alert');
    assert.equal(d.reason, 'unexplained-stall');
    assert.equal(d.stalledMs, 100 * MIN);
});

// ─── B4 · ceguera de arranque en frío ────────────────────────────────────────

test('B4: sin estampa y con agentes en trabajando, el reloj ARRANCA en vez de callar', () => {
    // Instalación que todavía no escribió `last-dispatch.json` (o Pulpo recién
    // arrancado con el pipeline ya trabado: el caso G-3 que motiva el módulo).
    // rev-0 salía por `skip: dispatching` en cada tick — 33 h de silencio con
    // `degraded: false`. Ahora el primer tick fija el reloj y a partir de ahí
    // cuenta de verdad.
    const arranque = wd.decide(pipelineFacts({
        now: 1 * MIN,
        dispatching: 1,
        enabledCount: 9,
        lastDispatchTs: undefined,
        state: { lastMovementTs: 0, lastSignature: null, lastAlertTs: 0, alertCount: 0 },
    }));
    assert.equal(arranque.nextState.lastMovementTs, 1 * MIN, 'el reloj arranca en el primer tick');
    assert.equal(arranque.stampState, 'never');

    // Ticks posteriores: mismos 9 pendientes, mismo agente clavado, nada
    // despachado. Umbral atenuado por agentes en curso = 20 + 60 = 80 min.
    for (const [min, esperado] of [[30, 'skip'], [79, 'skip'], [82, 'alert']]) {
        const d = wd.decide(pipelineFacts({
            now: min * MIN,
            dispatching: 1,
            enabledCount: 9,
            lastDispatchTs: undefined,
            state: arranque.nextState,
        }));
        assert.equal(d.action, esperado, `a los ${min} min debía ser ${esperado} (fue ${d.action}/${d.reason})`);
    }
});

test('B4: 33 h sin despachar con un agente clavado NO puede reportar salud', () => {
    const d = wd.decide(pipelineFacts({
        now: 2000 * MIN,
        dispatching: 1,
        enabledCount: 9,
        lastDispatchTs: undefined,
        state: { lastMovementTs: 1 * MIN, lastSignature: '1:42', lastAlertTs: 0, alertCount: 0 },
    }));
    assert.equal(d.action, 'alert');
    assert.ok(d.stalledMs > 30 * 60 * MIN, 'la duración informada es la real');
});

// ─── rev-6 · modo `never`: el conteo de trabajando/ NO es evidencia de despacho ─
//
// BLOQUEANTE del rebote rev-1. En modo `never` (sin estampa jamás vista) la rama
// legacy usaba `signatureChanged`, o sea igualdad de string sobre
// `${dispatching}:${avance}`. La firma cambia TAMBIÉN cuando el conteo BAJA, y el
// conteo baja solo a medida que los agentes viejos terminan. Resultado: cada
// muerte de un agente clavado reiniciaba el reloj de detención y emitía una
// "recuperación" que en pulpo.js borra `needs_attention`. El único test de
// `never` que existía mantenía `dispatching` FIJO, así que no tocaba el
// disparador y el defecto quedó descubierto.
//
// Helper: ticks sucesivos en modo `never`, encadenando el estado como en producción.
function correrNever(ticks, base = {}) {
    let state = wd.normalizeState(null);
    const out = [];
    for (const t of ticks) {
        const d = wd.decide(pipelineFacts({
            now: t.min * MIN,
            dispatching: t.disp,
            enabledCount: 5,
            lastDispatchTs: undefined,
            progressSeries: [{ ts: 1, waveKey: 7, avancePct: 42 }],
            state,
            ...base,
        }));
        out.push(d);
        state = wd.normalizeState(d.nextState);
    }
    return out;
}

test('rev-6: en modo `never` un conteo DECRECIENTE no reinicia el reloj ni emite recuperación', () => {
    // Agentes viejos drenando 3 → 2 → 1 → 0 con CERO despachos. Antes esto daba
    // `stalled=0min` y `recovery=SI` en cada baja.
    const [t1, t100, t101, t201, t301] = correrNever([
        { min: 1, disp: 3 }, { min: 100, disp: 3 }, { min: 101, disp: 2 },
        { min: 201, disp: 1 }, { min: 301, disp: 0 },
    ]);

    assert.equal(t1.stampState, 'never', 'el escenario es sin estampa');
    assert.equal(t100.action, 'alert', 'a los 100 min sin despachar tiene que alertar');

    // La baja 3 → 2 NO es un despacho.
    assert.equal(t101.recovery, null, 'que un agente termine NO es "despacho reanudado"');
    assert.ok(t101.stalledMs >= 100 * MIN, `el reloj acumula (fue ${t101.stalledMs / MIN}min)`);

    // Y sigue acumulando en cada baja posterior, escalando en vez de callar.
    for (const [d, min] of [[t201, 200], [t301, 300]]) {
        assert.equal(d.recovery, null, 'ninguna baja puede emitir recuperación');
        assert.ok(d.stalledMs >= min * MIN, `el reloj nunca se reinicia (fue ${d.stalledMs / MIN}min)`);
    }
    assert.equal(t301.action, 'escalate', 'una detención de 5 h escala');
});

test('rev-6: en modo `never` un conteo OSCILANTE alerta igual', () => {
    // El conteo global sube y baja entre fases (2 ↔ 3) sin un solo despacho.
    // Antes el reloj se reiniciaba en CADA cambio y el umbral no se alcanzaba
    // nunca: el watchdog quedaba mudo indefinidamente.
    const ticks = correrNever([
        { min: 1, disp: 2 }, { min: 10, disp: 3 }, { min: 20, disp: 2 },
        { min: 30, disp: 3 }, { min: 40, disp: 2 }, { min: 50, disp: 3 },
        { min: 60, disp: 2 }, { min: 70, disp: 3 }, { min: 82, disp: 2 },
    ]);
    const ultimo = ticks[ticks.length - 1];
    assert.ok(
        ticks.some((d) => d.action === 'alert' || d.action === 'escalate'),
        'con el conteo oscilando el watchdog NO puede quedarse mudo'
    );
    assert.equal(ultimo.action, 'alert', 'a los 82 min supera el umbral atenuado (20 + 60)');
    assert.ok(ultimo.stalledMs >= 80 * MIN, 'la inactividad informada es la real');
    assert.ok(ticks.every((d) => d.recovery == null), 'oscilar no es recuperarse');
});

test('rev-6: en modo `never` un AVANCE real de la ola sí reinicia el reloj', () => {
    // La contracara: el avancePct es progreso genuino y monótono de la ola, y
    // sigue contando como "movió ficha" (definición del PO en #4708).
    let state = wd.normalizeState(null);
    const primero = wd.decide(pipelineFacts({
        now: 1 * MIN, dispatching: 1, lastDispatchTs: undefined, state,
        progressSeries: [{ ts: 1, waveKey: 7, avancePct: 42 }],
    }));
    state = wd.normalizeState(primero.nextState);
    const conAvance = wd.decide(pipelineFacts({
        now: 200 * MIN, dispatching: 1, lastDispatchTs: undefined, state,
        progressSeries: [{ ts: 2, waveKey: 7, avancePct: 57 }],
    }));
    assert.equal(conAvance.nextState.lastMovementTs, 200 * MIN, 'el avance reinicia el reloj');
    assert.equal(conAvance.action, 'skip');
});

test('rev-6: sin reloj honesto NO se afirma una recuperación', () => {
    // Aun con movimiento real (avance), en modo `never` la duración de la
    // detención sale de la proxy legacy y no se puede sostener. Anunciar una
    // reanudación que no consta borra `needs_attention` en plena detención.
    const state = {
        lastMovementTs: 10 * MIN, lastSignature: '1:42', lastAlertTs: 20 * MIN,
        alertCount: 2, lastDispatching: 1, lastAvancePct: 42,
    };
    const d = wd.decide(pipelineFacts({
        now: 200 * MIN, dispatching: 1, lastDispatchTs: undefined, state,
        progressSeries: [{ ts: 2, waveKey: 7, avancePct: 90 }],
    }));
    assert.equal(d.stampState, 'never');
    assert.equal(d.recovery, null, 'sin estampa creíble no se anuncia recuperación');
});

// ─── rev-6 · B4 · "no hay trabajo" ≠ "no puedo ver el trabajo" ───────────────

test('rev-6 (B4): con el alcance CIEGO, 0 elegibles NO silencia el watchdog', () => {
    // Pausa total sin allowlist preservada y sin ola activa: el recolector sale
    // por `fail-closed-sin-ola` con elegibles 0. Antes `decide()` salía por
    // `no-enabled-work` — skip mudo con el pipeline trabado y la cola llena.
    const d = wd.decide(pipelineFacts({
        now: 200 * MIN,
        enabledCount: 0,
        scopeBlind: true,
        queuedTotal: 241,
        lastDispatchTs: 20 * MIN,
    }));
    assert.notEqual(d.reason, 'no-enabled-work', 'el alcance ciego no es una cola vacía');
    assert.equal(d.action, 'alert');
    assert.match(d.message, /no determinable/, 'el aviso admite que no puede acotar la cola');
    assert.match(d.message, /241 workfile/, 'informa lo único afirmable: el tamaño crudo');
    assert.doesNotMatch(d.message, /0 issue\(s\) habilitado/, 'no reporta "0 esperando"');
});

test('rev-6 (B4): una cola realmente vacía sigue sin alertar (CA-3 intacto)', () => {
    const d = wd.decide(pipelineFacts({
        now: 200 * MIN, enabledCount: 0, scopeBlind: false, lastDispatchTs: 20 * MIN,
    }));
    assert.equal(d.action, 'skip');
    assert.equal(d.reason, 'no-enabled-work');
});

// ─── rev-6 · B2 · el backoff no se arrastra entre episodios ──────────────────

test('rev-6 (B2): una cola vacía cierra el episodio y resetea el backoff', () => {
    // Antes el reset colgaba SÓLO de `movedFicha`, así que el primer aviso del
    // episodio siguiente heredaba el cooldown acumulado del anterior (hasta 16x
    // = 8 h de mordaza) sin que nada lo justificara.
    const d = wd.decide(pipelineFacts({
        now: 200 * MIN,
        enabledCount: 0,
        lastDispatchTs: 20 * MIN,
        state: {
            lastMovementTs: 20 * MIN, lastSignature: '0:42:1200000',
            lastAlertTs: 190 * MIN, alertCount: 5,
        },
    }));
    assert.equal(d.reason, 'no-enabled-work');
    assert.equal(d.nextState.alertCount, 0, 'el episodio se cierra');
    assert.equal(d.nextState.lastAlertTs, 0, 'y el backoff arranca de cero');
});

// ─── rev-6 · S4 · el invariante escalate >= stall se garantiza ───────────────

test('rev-6 (S4): con `escalate` mal configurado por debajo de `stall`, el modo ola sigue mudo', () => {
    // Las dos claves son independientes en config y nada impide escalate < stall.
    // Propiedad que se protege: NO puede existir un punto de inactividad POR
    // DEBAJO del umbral normal en el que una causa declarada dispare — eso sería
    // la regresión de #4751. Se barre el rango en vez de probar un solo punto.
    for (const stalled of [1, 10, 25, 29]) {
        const d = wd.decide(pipelineFacts({
            now: (20 + stalled) * MIN,
            stallMinutes: 30,
            declaredCauseEscalateMinutes: 5,   // mal configurado: menor que stall
            cause: { declared: true, kind: 'human-halt', readable: true },
            lastDispatchTs: 20 * MIN,
        }));
        assert.equal(d.action, 'skip', `a los ${stalled} min (< 30) tiene que seguir mudo`);
    }
    // Y pasado el umbral normal, escala (la causa vieja deja de explicar).
    const pasado = wd.decide(pipelineFacts({
        now: 55 * MIN,                          // 35 min sin despachar
        stallMinutes: 30,
        declaredCauseEscalateMinutes: 5,
        cause: { declared: true, kind: 'human-halt', readable: true },
        lastDispatchTs: 20 * MIN,
    }));
    assert.equal(pasado.action, 'alert');
    assert.match(pasado.reason, /^stale-declared-cause:/);
});

// ─── R-3 · no-regresión de #4751 ─────────────────────────────────────────────

test('causa declarada por debajo del umbral sigue muda (no-regresión #4751)', () => {
    // Modo ola con 30 min sin despachar: por encima del umbral normal (20) y por
    // debajo del de escalada (45) → mudo, igual que antes de este issue.
    const d = wd.decide(pipelineFacts({
        now: 120 * MIN,
        lastDispatchTs: 90 * MIN,
        state: { lastMovementTs: 90 * MIN, lastStampTs: 90 * MIN, lastSignature: `0:42:${90 * MIN}`, lastAlertTs: 0, alertCount: 0 },
        cause: { declared: true, kind: 'wave-empty', readable: true, sinceTs: 110 * MIN },
    }));
    assert.equal(d.action, 'skip');
    assert.equal(d.reason, 'declared-cause:wave-empty');
    assert.equal(d.message, null);
});

test('una causa declarada sin `sinceTs` igual escala: el reloj es el del despacho', () => {
    // Es el caso de la PAUSA TOTAL: `getPipelineMode()` devuelve `createdAt: null`.
    // El watchdog no depende de que la fuente registre cuándo empezó: mide desde
    // el último despacho efectivo, que siempre conoce.
    const cause = { declared: true, kind: 'human-halt', readable: true };
    const t1 = wd.decide(pipelineFacts({ now: 40 * MIN, cause })); // 20 min sin despachar
    assert.equal(t1.action, 'skip');
    assert.equal(t1.reason, 'declared-cause:human-halt');
    const t2 = wd.decide(pipelineFacts({ now: 66 * MIN, cause, state: t1.nextState })); // 46 min
    assert.equal(t2.action, 'alert');
    assert.equal(t2.reason, 'stale-declared-cause:human-halt');
});

// ─── B1 · una causa que ALTERNA no puede dejar mudo al watchdog ──────────────

test('B1: causas que alternan cada 30 min NO silencian el watchdog para siempre', () => {
    // El escenario real: ventanas de prioridad autoexcluyentes (QA>Build>Dev),
    // presión de recursos oscilando en los umbrales y cooldown entre lanzamientos
    // rotan la causa declarada. Midiendo contra la ANTIGÜEDAD DE LA CAUSA (rev-0)
    // el reloj se reiniciaba en cada transición y jamás alcanzaba el umbral: 3 h
    // sin despachar, 5 elegibles esperando, CERO alertas — el mismo silencio del
    // 2026-08-02 que el issue existe para cerrar.
    const kinds = ['cooldown', 'concurrency-limit'];
    let state = { lastMovementTs: 0, lastStampTs: 0, lastSignature: null, lastAlertTs: 0, alertCount: 0 };
    const acciones = [];
    for (let i = 1; i <= 6; i++) {
        const now = i * 30 * MIN;
        const d = wd.decide(pipelineFacts({
            now,
            lastDispatchTs: 0.0001, // estampa fija: nunca volvió a despachar
            cause: { declared: true, kind: kinds[i % 2], readable: true },
            state,
        }));
        acciones.push(d.action);
        state = d.nextState;
    }
    // 30 y 60 min están por debajo/encima del umbral de escalada (45).
    assert.deepEqual(acciones.slice(0, 2), ['skip', 'alert'],
        'a los 60 min sin despachar tiene que avisar aunque la causa haya rotado');
    assert.ok(acciones.includes('escalate'), 'y seguir escalando pasado el cooldown');
});

test('B1: cambiar de causa NO reinicia el reloj de inactividad', () => {
    const t1 = wd.decide(pipelineFacts({
        now: 40 * MIN,
        cause: { declared: true, kind: 'wave-empty', readable: true },
    }));
    assert.equal(t1.action, 'skip', '20 min sin despachar: todavía por debajo de la escalada');
    // 26 min después con OTRA causa: el reloj de despacho siguió corriendo.
    const t2 = wd.decide(pipelineFacts({
        now: 66 * MIN,
        cause: { declared: true, kind: 'night-window', readable: true },
        state: t1.nextState,
    }));
    assert.equal(t2.action, 'alert');
    assert.equal(t2.reason, 'stale-declared-cause:night-window', 'la causa sólo NOMBRA el motivo');
    assert.equal(t2.stalledMs, 46 * MIN, 'el reloj acumula entre causas distintas');
});

// ─── CA-4 · backoff verificable ──────────────────────────────────────────────

test('el aviso no se repite en cada ciclo: hay backoff verificable', () => {
    const cause = { declared: true, kind: 'human-halt', readable: true, sinceTs: 20 * MIN };
    const t1 = wd.decide(pipelineFacts({ now: 120 * MIN, cause }));
    assert.equal(t1.action, 'alert');
    // Ticks siguientes dentro del cooldown de 30 min → mudos.
    for (const min of [121, 130, 145]) {
        const tn = wd.decide(pipelineFacts({ now: min * MIN, cause, state: t1.nextState }));
        assert.equal(tn.action, 'skip', `tick ${min} debe callar`);
        assert.equal(tn.reason, 'cooldown');
    }
    // Pasado el cooldown → re-alerta escalando.
    const t5 = wd.decide(pipelineFacts({ now: 151 * MIN, cause, state: t1.nextState }));
    assert.equal(t5.action, 'escalate');
    assert.equal(t5.level, 'error');
});

// ─── G-5 / C-3 · alcance pipeline, no sólo ola ───────────────────────────────

test('sin ola activa el watchdog igual vigila el despacho del pipeline', () => {
    const d = wd.decide(pipelineFacts({ waveKey: null }));
    assert.equal(d.action, 'alert');
    assert.equal(d.waveKey, null);
    // El sujeto del mensaje pasa a ser el pipeline, no una ola inexistente.
    assert.ok(d.message.startsWith('Pipeline sin despachar'), d.message);
    assert.ok(!d.message.includes('null'), d.message);
});

// ─── SEC-4 · clamp del umbral nuevo ──────────────────────────────────────────

test('umbral de escalada 0, negativo, null o gigante cae al default y no desactiva el control', () => {
    for (const malo of [0, -5, null, 'abc', 999999, 3.5]) {
        const d = wd.decide(pipelineFacts({
            declaredCauseEscalateMinutes: malo,
            cause: { declared: true, kind: 'human-halt', readable: true, sinceTs: 20 * MIN },
        }));
        // Con el default (45 min) y una causa de 100 min, DEBE escalar igual.
        assert.equal(d.action, 'alert', `umbral inválido ${malo} no debe desactivar la escalada`);
    }
});

// ─── B2 · clock skew: una estampa futura es INVÁLIDA, no un "recién despaché" ─

test('B2: una estampa en el futuro (reloj corrido) NO silencia el watchdog', () => {
    // rev-0 la acotaba con Math.min(estampa, now) y se la asignaba al reloj de
    // movimiento ⇒ stalledMs = 0 en CADA tick ⇒ un salto de reloj hacia atrás
    // (NTP, resume de VM) apagaba el watchdog por horas. El test homónimo de
    // rev-0 nunca asserteaba `action`; éste sí, que es lo que lo delata.
    for (const min of [60, 120, 600]) {
        const d = wd.decide(pipelineFacts({
            now: min * MIN,
            lastDispatchTs: 9999 * MIN, // futuro
            state: { lastMovementTs: 20 * MIN, lastStampTs: 20 * MIN, lastSignature: 'x', lastAlertTs: 0, alertCount: 0 },
        }));
        assert.equal(d.action, 'alert', `con estampa futura y ${min} min de reloj debe disparar`);
        assert.equal(d.lastDispatchTs, null, 'la estampa futura se descarta, no se acota');
        assert.equal(d.stampState, 'future');
        assert.equal(d.stampDegraded, true, 'y se reporta como reloj degradado (SEC-5)');
        assert.ok(d.stalledMs >= 40 * MIN, 'el reloj sigue contando desde el último movimiento real');
    }
});

test('B2: un adelanto de milisegundos NO se trata como skew (tolerancia)', () => {
    const d = wd.decide(pipelineFacts({
        now: 120 * MIN,
        lastDispatchTs: 120 * MIN + 1000, // 1 s adelante: granularidad, no skew
        state: { lastMovementTs: 20 * MIN, lastStampTs: 20 * MIN, lastSignature: 'x', lastAlertTs: 0, alertCount: 0 },
    }));
    assert.equal(d.stampState, 'ok');
    assert.equal(d.stalledMs, 0, 'se acota a now: el despacho es de recién');
});

// ─── B3 · perder la estampa no es "despacho reanudado" ──────────────────────

test('B3: perder la estampa durante un episodio alertado NO emite recuperación falsa', () => {
    // Episodio ya alertado con estampa presente.
    const conEstampa = wd.decide(pipelineFacts({
        now: 100 * MIN,
        lastDispatchTs: 20 * MIN,
        state: { lastMovementTs: 20 * MIN, lastStampTs: 20 * MIN, lastSignature: `0:42:${20 * MIN}`, lastAlertTs: 0, alertCount: 0 },
    }));
    assert.equal(conEstampa.action, 'alert');
    assert.equal(conEstampa.nextState.alertCount, 1);

    // El archivo se borra o se corrompe. rev-0: la firma pasaba de 3 segmentos a
    // 2 ⇒ "movió ficha" ⇒ aviso de "despacho reanudado" sin que saliera un solo
    // agente, Y el reloj de la detención volvía a cero.
    const sinEstampa = wd.decide(pipelineFacts({
        now: 120 * MIN,
        lastDispatchTs: undefined,
        state: conEstampa.nextState,
    }));
    assert.equal(sinEstampa.recovery, null, 'perder el archivo no es despachar');
    assert.equal(sinEstampa.stalledMs, 100 * MIN, 'el reloj NO se reinicia');
    assert.equal(sinEstampa.stampState, 'missing');
    assert.equal(sinEstampa.stampDegraded, true);
    assert.equal(sinEstampa.nextState.alertCount, 1, 'el episodio sigue abierto');
});

test('B3: con la estampa perdida el aviso aclara que el reloj está degradado', () => {
    const d = wd.decide(pipelineFacts({
        now: 200 * MIN,
        lastDispatchTs: undefined,
        state: { lastMovementTs: 20 * MIN, lastStampTs: 20 * MIN, lastSignature: 'x', lastAlertTs: 0, alertCount: 0 },
    }));
    assert.equal(d.action, 'alert');
    assert.ok(/degradado/i.test(d.message), d.message);
});

test('B3: si la estampa vuelve con un valor NUEVO, ahí sí hay recuperación', () => {
    const d = wd.decide(pipelineFacts({
        now: 140 * MIN,
        lastDispatchTs: 140 * MIN,
        state: { lastMovementTs: 20 * MIN, lastStampTs: 20 * MIN, lastSignature: 'x', lastAlertTs: 100 * MIN, alertCount: 1 },
    }));
    assert.ok(d.recovery, 'una estampa nueva SÍ es un despacho');
    assert.equal(d.recovery.outageMs, 120 * MIN);
});

// ─── SEC-2 · autoría ─────────────────────────────────────────────────────────

test('sin autoría registrada el aviso jamás atribuye la pausa a una persona', () => {
    for (const sinAutor of [undefined, null, '', '   ']) {
        const d = wd.decide(pipelineFacts({
            cause: { declared: true, kind: 'human-halt', readable: true, sinceTs: 20 * MIN },
            authorDeclared: sinAutor,
        }));
        assert.equal(d.action, 'alert');
        assert.ok(d.message.includes('autoría no registrada'), d.message);
        assert.ok(!d.message.includes('autoría declarada'), d.message);
    }
});

test('la autoría se rotula siempre como DECLARADA, nunca como hecho verificado', () => {
    const d = wd.decide(pipelineFacts({
        cause: { declared: true, kind: 'partial-pause', readable: true, sinceTs: 20 * MIN },
        authorDeclared: 'commander',
    }));
    assert.ok(d.message.includes('autoría declarada: commander'), d.message);
});

// ─── SEC-3 · read-only por contrato ──────────────────────────────────────────

test('el watchdog no muta punto-paused ni la allowlist ni la cola', () => {
    const d = wd.decide(pipelineFacts({
        cause: { declared: true, kind: 'human-halt', readable: true, sinceTs: 20 * MIN },
    }));
    // Las únicas acciones posibles son observacionales.
    assert.ok(['skip', 'alert', 'escalate'].includes(d.action));
    // Nada en la decisión sugiere tocar `.paused`, la allowlist o la cola.
    for (const prohibido of ['unpause', 'clearPause', 'resume', 'allowlist', 'promote', 'delete']) {
        assert.ok(!(prohibido in d), `la decisión no debe exponer '${prohibido}'`);
    }
    assert.ok(!/\.paused|allowlist|partial-pause\.json/.test(d.message || ''), d.message);
});

test('decide() es puro: no muta los facts ni el estado recibido', () => {
    const f = pipelineFacts({
        cause: { declared: true, kind: 'human-halt', readable: true, sinceTs: 20 * MIN },
    });
    const snapshotFacts = JSON.stringify(f);
    const estadoOriginal = { ...f.state };
    wd.decide(f);
    assert.equal(JSON.stringify(f), snapshotFacts, 'decide no debe mutar los facts');
    assert.deepEqual(f.state, estadoOriginal, 'decide no debe mutar el estado recibido');
});

// ─── SEC-1 · el aviso se entrega (nada rompe el parseo ni filtra datos) ──────

test('el mensaje no filtra paths, tokens ni metacaracteres de la autoría', () => {
    const d = wd.decide(pipelineFacts({
        cause: { declared: true, kind: 'human-halt', readable: true, sinceTs: 20 * MIN },
        authorDeclared: 'C:\\Workspaces\\secreto *_`[ AKIAIOSFODNN7EXAMPLE',
    }));
    assert.ok(!/[A-Za-z]:\\/.test(d.message), d.message);
    assert.ok(!/[*`[]/.test(d.message), d.message);
});

// ─── Helpers de formato / catálogo de causas ─────────────────────────────────

test('formatDurationEs: segundos, minutos y horas', () => {
    assert.equal(wd.formatDurationEs(5000), '5 s');
    assert.equal(wd.formatDurationEs(20 * MIN), '20 min');
    assert.equal(wd.formatDurationEs(93 * MIN), '1 h 33 min');
    assert.equal(wd.formatDurationEs(120 * MIN), '2 h');
    assert.equal(wd.formatDurationEs(-1), '0 s');
    assert.equal(wd.formatDurationEs(NaN), '0 s');
});

test('describeCause nombra cada causa del CA-2 y tolera un kind desconocido', () => {
    assert.match(wd.describeCause('human-halt'), /pausa total/);
    assert.match(wd.describeCause('partial-pause'), /pausa parcial/);
    assert.match(wd.describeCause('wave-empty'), /allowlist vacía/);
    assert.match(wd.describeCause('concurrency-limit'), /límite de concurrencia/);
    assert.match(wd.describeCause('priority-window'), /ventana de prioridad/);
    assert.equal(wd.describeCause(null), 'sin causa declarada');
    // Kind desconocido: se devuelve saneado, sin metacaracteres de Markdown.
    assert.equal(wd.describeCause('raro_*`[x'), 'raro_x');
});

// ─── G-1 · estampa del despacho efectivo ─────────────────────────────────────

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'last-dispatch-'));
}

test('el timestamp de último despacho se persiste de forma atómica al lanzar un agente', () => {
    const dir = tmpDir();
    try {
        const ok = lastDispatch.writeLastDispatch(
            dir, { issue: 5400, skill: 'pipeline-dev', fase: 'dev', pipeline: 'desarrollo' }, 1_700_000_000_000
        );
        assert.equal(ok, true);
        const leido = lastDispatch.readLastDispatch(dir);
        assert.equal(leido.ts, 1_700_000_000_000);
        assert.equal(leido.issue, '5400');
        assert.equal(leido.skill, 'pipeline-dev');
        assert.equal(leido.fase, 'dev');
        assert.equal(leido.pipeline, 'desarrollo');
        // No queda ningún temporal: el rename fue atómico.
        const sobrantes = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
        assert.deepEqual(sobrantes, []);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('la estampa ignora un ts inyectado por el caller (no se puede silenciar el watchdog)', () => {
    const dir = tmpDir();
    try {
        // `ts` dentro de meta NO debe pisar el timestamp real: estampar un futuro
        // lejano sería la forma trivial de callar el watchdog para siempre.
        lastDispatch.writeLastDispatch(dir, { issue: 1, ts: 9_999_999_999_999 }, 1000);
        assert.equal(lastDispatch.readLastDispatch(dir).ts, 1000);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('la estampa descarta campos fuera de la allowlist y sanea los aceptados', () => {
    const dir = tmpDir();
    try {
        lastDispatch.writeLastDispatch(dir, {
            issue: 5400,
            skill: 'a\nb\tc   d',
            secreto: 'AKIAIOSFODNN7EXAMPLE',
        }, 1000);
        const leido = lastDispatch.readLastDispatch(dir);
        assert.equal(leido.skill, 'a b c d', 'los caracteres de control se colapsan');
        assert.equal('secreto' in leido, false, 'campo fuera de la allowlist descartado');
        const crudo = fs.readFileSync(lastDispatch.lastDispatchPath(dir), 'utf8');
        assert.ok(!crudo.includes('AKIAIOSFODNN7EXAMPLE'), 'nada fuera de la allowlist se persiste');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('la estampa acota cada campo y es fail-soft ante lectura ausente o corrupta', () => {
    const dir = tmpDir();
    try {
        assert.equal(lastDispatch.readLastDispatch(path.join(dir, 'no-existe')), null);
        lastDispatch.writeLastDispatch(dir, { skill: 'x'.repeat(500) }, 1000);
        assert.equal(lastDispatch.readLastDispatch(dir).skill.length, lastDispatch.MAX_FIELD_LEN);
        // Corrupto → null (nunca lanza, nunca alimenta al watchdog con basura).
        fs.writeFileSync(lastDispatch.lastDispatchPath(dir), '{no json');
        assert.equal(lastDispatch.readLastDispatch(dir), null);
        // ts inválido → se trata como ausencia de estampa (cae a la proxy legacy).
        fs.writeFileSync(lastDispatch.lastDispatchPath(dir), JSON.stringify({ ts: -1 }));
        assert.equal(lastDispatch.readLastDispatch(dir), null);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('escribir la estampa en un destino imposible no lanza (fail-soft)', () => {
    // Un fallo de FS jamás puede tumbar el loop del Pulpo.
    const dir = tmpDir();
    try {
        const archivo = path.join(dir, 'soy-un-archivo');
        fs.writeFileSync(archivo, 'x');
        assert.equal(lastDispatch.writeLastDispatch(path.join(archivo, 'sub'), { issue: 1 }, 1000), false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

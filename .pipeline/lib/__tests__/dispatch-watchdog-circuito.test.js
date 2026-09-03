// =============================================================================
// dispatch-watchdog-circuito.test.js — CIRCUITO COMPLETO del watchdog (#5400 rev-3)
//
// Los tests de `decide()` inyectaban causas sintéticas y `enabledCount` a mano:
// dos estados que el brazo real NO puede producir. Por eso las tres revisiones
// anteriores pasaron con verde mientras en producción el aviso nombraba siempre
// la causa equivocada. Acá se arma el circuito de punta a punta contra un
// filesystem de verdad:
//
//     `.partial-pause.json` + `pendiente/`  →  recolectarHechos()  →  decide()
//                                                                        ↓
//                                                    el mensaje que ve el operador
//
// Cada escenario Gherkin del issue tiene su test acá.
// =============================================================================

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const df = require('../dispatch-facts');
const wd = require('../wave-stall-watchdog');

const CONFIG = {
    pipelines: {
        definicion: { fases: ['analisis', 'criterios'] },
        desarrollo: { fases: ['dev', 'verificacion'] },
    },
};

const MIN = 60 * 1000;
const AHORA = Date.parse('2026-08-03T18:00:00.000Z');

let tmpRoot = null;
let envPrevio;

function crearPendiente(pipelineName, fase, nombre) {
    const dir = path.join(tmpRoot, pipelineName, fase, 'pendiente');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, nombre), 'issue: x\n');
}

function escribirPartialPause(allowedIssues) {
    fs.writeFileSync(path.join(tmpRoot, '.partial-pause.json'), JSON.stringify({
        allowed_issues: allowedIssues,
        created_at: '2026-08-03T10:22:37.495Z',
        source: 'commander:leo',
    }));
}

function partialPauseReal() {
    delete require.cache[require.resolve('../partial-pause')];
    return require('../partial-pause');
}

/** Corre el circuito entero: hechos del FS → decisión del watchdog. */
function correrTick(opts) {
    const o = opts || {};
    const hechos = df.recolectarHechos({
        partialPause: partialPauseReal(),
        listarPendientes: () => df.listarPendientesFS(tmpRoot, CONFIG),
        issuesOlaActiva: () => o.issuesOlaActiva || [],
        isNightWindow: o.isNightWindow,
        isQuotaExhausted: o.isQuotaExhausted,
        isResourcePressure: o.isResourcePressure,
        isWaveWaitingOperator: o.isWaveWaitingOperator,
        causaDesdeArtifact: o.causaDesdeArtifact,
    });
    const decision = wd.decide({
        now: o.now != null ? o.now : AHORA,
        waveKey: o.waveKey != null ? o.waveKey : null,
        enabledCount: hechos.conteo.elegibles,
        dispatching: o.dispatching || 0,
        cause: hechos.cause,
        authorDeclared: hechos.cause ? hechos.cause.authorDeclared : null,
        lastDispatchTs: o.lastDispatchTs,
        state: o.state,
    });
    return { hechos, decision };
}

beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-circuito-'));
    envPrevio = {
        dir: process.env.PIPELINE_DIR_OVERRIDE,
        unscoped: process.env.PIPELINE_ALLOW_UNSCOPED_DISPATCH,
    };
    process.env.PIPELINE_DIR_OVERRIDE = tmpRoot;
    delete process.env.PIPELINE_ALLOW_UNSCOPED_DISPATCH;
});

afterEach(() => {
    if (envPrevio.dir === undefined) delete process.env.PIPELINE_DIR_OVERRIDE;
    else process.env.PIPELINE_DIR_OVERRIDE = envPrevio.dir;
    if (envPrevio.unscoped === undefined) delete process.env.PIPELINE_ALLOW_UNSCOPED_DISPATCH;
    else process.env.PIPELINE_ALLOW_UNSCOPED_DISPATCH = envPrevio.unscoped;
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
    delete require.cache[require.resolve('../partial-pause')];
});

// =============================================================================
// El estado REAL del pipeline vivo (el que produjo N1 y N2)
// =============================================================================

test('con el estado real del pipeline vivo el aviso NO nombra la pausa parcial', () => {
    // Foto del 2026-08-03: partial_pause con allowlist viva, `pendiente/` lleno
    // de backlog parkeado, y la causa real siendo el límite de concurrencia.
    escribirPartialPause([5400, 5401]);
    crearPendiente('desarrollo', 'dev', '5400.pipeline-dev');
    for (let i = 0; i < 30; i++) crearPendiente('definicion', 'analisis', `${3000 + i}.guru`);

    const { hechos, decision } = correrTick({
        lastDispatchTs: AHORA - 200 * MIN,
        dispatching: 0,
        causaDesdeArtifact: () => ({
            declared: true, kind: 'concurrency-limit', readable: true,
            sinceTs: null, authorDeclared: null,
        }),
    });

    assert.equal(hechos.conteo.total, 31);
    assert.equal(hechos.conteo.elegibles, 1);
    assert.equal(decision.action, 'alert');
    assert.equal(decision.reason, 'stale-declared-cause:concurrency-limit');
    assert.match(decision.message, /límite de concurrencia/);
    assert.doesNotMatch(decision.message, /pausa parcial/);
    assert.doesNotMatch(decision.message, /commander:leo/, 'no se atribuye una pausa que nadie puso');
    assert.match(decision.message, /1 issue\(s\) habilitado\(s\)/, 'el número es el elegible, no los 31');
});

test('el backlog parkeado solo no alcanza para alertar (CA-3 en el circuito real)', () => {
    // Gherkin #2. rev-2 alertaba acá: contaba los 30 workfiles fuera de la ola
    // como trabajo elegible y `enabledCount > 0` nunca era falso.
    escribirPartialPause([9001, 9002]);
    for (let i = 0; i < 30; i++) crearPendiente('definicion', 'analisis', `${3000 + i}.guru`);

    const { decision } = correrTick({ lastDispatchTs: AHORA - 500 * MIN });

    assert.equal(decision.action, 'skip');
    assert.equal(decision.reason, 'no-enabled-work');
    assert.equal(decision.message, null);
});

// =============================================================================
// Gherkin #1 — pipeline pausado más allá del umbral
// =============================================================================

test('pipeline pausado más allá del umbral avisa nombrando la pausa, su autoría y los issues que esperan', () => {
    escribirPartialPause([5400, 5401]);
    fs.writeFileSync(path.join(tmpRoot, '.paused'), JSON.stringify({
        source: 'restart:preserved',
        ts: '2026-08-03T14:31:00.000Z',
        detail: 'pausa preservada por /restart',
    }));
    crearPendiente('desarrollo', 'dev', '5400.pipeline-dev');
    crearPendiente('desarrollo', 'dev', '5401.android-dev');
    crearPendiente('definicion', 'analisis', '3641.security');

    const { hechos, decision } = correrTick({ lastDispatchTs: AHORA - 200 * MIN });

    assert.equal(hechos.cause.kind, 'human-halt');
    assert.equal(decision.action, 'alert');
    assert.equal(decision.reason, 'stale-declared-cause:human-halt');
    assert.match(decision.message, /pausa total declarada por el operador/);
    assert.match(decision.message, /autoría declarada: restart:preserved/);
    assert.match(decision.message, /2 issue\(s\) habilitado\(s\)/);
});

test('una pausa total sin autoría registrada avisa igual, sin inventar responsable', () => {
    escribirPartialPause([5400]);
    fs.writeFileSync(path.join(tmpRoot, '.paused'), '2026-08-03T14:31:00.000Z');
    crearPendiente('desarrollo', 'dev', '5400.pipeline-dev');

    const { decision } = correrTick({ lastDispatchTs: AHORA - 200 * MIN });

    assert.equal(decision.action, 'alert');
    assert.match(decision.message, /autoría no registrada/);
    assert.doesNotMatch(decision.message, /leo|manual|unknown/i);
});

// =============================================================================
// No-regresión #4751 — la escalada es estrictamente aditiva
// =============================================================================

test('por debajo del umbral de escalada la causa declarada sigue muda', () => {
    escribirPartialPause([5400]);
    crearPendiente('desarrollo', 'dev', '5400.pipeline-dev');

    const { decision } = correrTick({
        lastDispatchTs: AHORA - 30 * MIN, // > stall (20) pero < escalate (45)
        causaDesdeArtifact: () => ({
            declared: true, kind: 'cooldown', readable: true, sinceTs: null, authorDeclared: null,
        }),
    });

    assert.equal(decision.action, 'skip');
    assert.equal(decision.reason, 'declared-cause:cooldown');
});

test('sin causa declarada y con elegibles esperando el aviso sale por inactividad pura', () => {
    escribirPartialPause([5400]);
    crearPendiente('desarrollo', 'dev', '5400.pipeline-dev');

    const { decision } = correrTick({ lastDispatchTs: AHORA - 40 * MIN });

    assert.equal(decision.action, 'alert');
    assert.equal(decision.reason, 'unexplained-stall');
    assert.match(decision.message, /sin causa declarada/);
});

// =============================================================================
// Gherkin #3 — recuperación
// =============================================================================

test('al reanudarse el despacho llega el aviso de recuperación con la duración total', () => {
    escribirPartialPause([5400]);
    crearPendiente('desarrollo', 'dev', '5400.pipeline-dev');

    const inicio = AHORA - 120 * MIN;
    const { decision } = correrTick({
        lastDispatchTs: AHORA,           // acaba de salir un agente
        state: { lastMovementTs: inicio, lastStampTs: inicio, lastAlertTs: AHORA - 60 * MIN, alertCount: 2 },
    });

    assert.ok(decision.recovery, 'tiene que haber aviso de recuperación');
    assert.equal(decision.recovery.outageMs, 120 * MIN);
    assert.match(decision.recovery.message, /despacho reanudado/i);
    assert.match(decision.recovery.message, /2 h/);
});

// =============================================================================
// CA-4 — backoff verificable
// =============================================================================

test('las re-alertas del mismo episodio se espacian con backoff exponencial', () => {
    escribirPartialPause([5400]);
    crearPendiente('desarrollo', 'dev', '5400.pipeline-dev');

    const corridas = [
        // [alertCount previo, minutos desde la última alerta, action esperada]
        [1, 25, 'skip'],      // cooldown base 30 min: todavía no
        [1, 35, 'escalate'],  // pasó el cooldown base
        [2, 45, 'skip'],      // 2da re-alerta: espera 60 min
        [2, 70, 'escalate'],
        [3, 100, 'skip'],     // 3ra: espera 120 min
        [3, 130, 'escalate'],
        [6, 470, 'skip'],     // 2^5 = 32 > tope 16 ⇒ espera 16 × 30 = 480 min
        [6, 490, 'escalate'],
    ];

    for (const [alertCount, desdeMin, esperado] of corridas) {
        const { decision } = correrTick({
            lastDispatchTs: AHORA - 600 * MIN,
            state: {
                lastMovementTs: AHORA - 600 * MIN,
                lastStampTs: AHORA - 600 * MIN,
                lastAlertTs: AHORA - desdeMin * MIN,
                alertCount,
            },
        });
        assert.equal(decision.action, esperado,
            `alertCount=${alertCount} hace ${desdeMin}min ⇒ ${esperado}`);
    }
});

test('el backoff tiene tope: nunca deja de avisar del todo', () => {
    escribirPartialPause([5400]);
    crearPendiente('desarrollo', 'dev', '5400.pipeline-dev');

    // Con alertCount altísimo el factor queda clavado en el tope (16 × 30 min = 8 h).
    const { decision } = correrTick({
        lastDispatchTs: AHORA - 4000 * MIN,
        state: {
            lastMovementTs: AHORA - 4000 * MIN,
            lastStampTs: AHORA - 4000 * MIN,
            lastAlertTs: AHORA - (16 * 30 + 1) * MIN,
            alertCount: 40,
        },
    });

    assert.equal(decision.action, 'escalate');
    assert.equal(wd.MAX_ALERT_BACKOFF_FACTOR, 16);
});

'use strict';
//
// #5113 · CA-UX2 — "Causa propia, no anomalía".
//
// La contracara de un buen fail-closed es un mal síntoma. Con CA-A7 cumplido
// (el gate DENIEGA cuando el store del estado operativo no responde, y tiene
// prohibido degradar a filesystem), la cola queda ociosa sin que ningún gate
// conocido la explique. El resultado, sin esta causa, es que el operador lee
// "⚠ Anomalía: causa no determinable" exactamente en el momento en que la causa
// se conoce con precisión absoluta — el peor mensaje posible en el peor momento.
//
// Este archivo fija las dos mitades del circuito:
//   1. la DECISIÓN pura (`opstateDispatchGate`): cuándo el sustrato explica el
//      no-despacho y cuándo no;
//   2. la PUBLICACIÓN (`resolveCause`): que la causa marcada gana sobre la
//      anomalía y sobre `MODO_OLA`, y el caso negativo que demuestra que sin
//      ella se caía al fallback.
//
const test = require('node:test');
const assert = require('node:assert/strict');
const dc = require('../lib/dispatch-cause');

process.env.PULPO_NO_AUTOSTART = '1';
const { opstateDispatchGate } = require('../pulpo');

// ─── 1 · La decisión pura ────────────────────────────────────────────────────

test('CA-UX2: store remoto caído ⇒ el sustrato explica el no-despacho', () => {
    const r = opstateDispatchGate({
        mode: 'remote', source: 'config', degraded: true, lastError: 'timeout',
    });
    assert.equal(r.blocked, true);
    assert.match(r.detalle, /no responde/i);
    // CA-UX5 — el síntoma nombra la acción: el detalle tiene que decir cuál es
    // el próximo paso del operador, no sólo describir el error técnico.
    assert.match(r.detalle, /durable: false/);
    // Y tiene que dejar explícito que NO hubo degradación silenciosa a FS.
    assert.match(r.detalle, /no se degrada a filesystem/i);
    // La causa técnica concreta viaja adentro: sin ella el operador no puede
    // decidir entre reintentar y volver.
    assert.match(r.detalle, /timeout/);
});

test('CA-UX2: modo filesystem NUNCA bloquea, ni con un rastro viejo de degradación', () => {
    // En `fs` el estado se lee del disco local: una falla del store no frena
    // nada. Nombrar la causa acá sería inventar un culpable — el error opuesto
    // y exactamente igual de caro que la anomalía.
    const r = opstateDispatchGate({
        mode: 'fs', source: 'config', degraded: true, lastError: 'timeout',
    });
    assert.equal(r.blocked, false);
    assert.equal(r.detalle, '');
});

test('CA-UX2: store remoto SANO no declara causa (el flag encendido no es un síntoma)', () => {
    const r = opstateDispatchGate({
        mode: 'remote', source: 'config', degraded: false, lastError: null,
    });
    assert.equal(r.blocked, false);
});

test('CA-UX2: una descripción rota no bloquea el despacho (fail-open de la CAUSA)', () => {
    // El gate real es `isIssueAllowed`, que deniega por su cuenta. Si la
    // introspección del sustrato se rompe, lo que NO puede pasar es que el
    // pipeline se frene por un bug del cartel.
    for (const basura of [null, undefined, {}, 'remote', 42, []]) {
        assert.equal(opstateDispatchGate(basura).blocked, false, `entrada: ${JSON.stringify(basura)}`);
    }
});

test('CA-UX2: `degraded` sólo cuenta si es booleano true (nada de coerción)', () => {
    for (const casi of ['true', 1, 'sí', {}]) {
        const r = opstateDispatchGate({ mode: 'remote', degraded: casi });
        assert.equal(r.blocked, false, `degraded=${JSON.stringify(casi)} no debe bloquear`);
    }
});

// ─── 2 · La publicación de la causa ──────────────────────────────────────────

/** Snapshot mínimo de un ciclo sin despacho y con cola pendiente. */
function cicloOcioso(gates, detalles) {
    return {
        anyLaunched: false,
        hayPendientes: true,
        gatesActivos: new Set(gates),
        detalles: detalles || {},
    };
}

test('CA-UX2: con el store caído se publica la causa propia, NO la anomalía', () => {
    const gate = opstateDispatchGate({ mode: 'remote', degraded: true, lastError: 'NetworkError' });
    const causa = dc.resolveCause(
        cicloOcioso([dc.CAUSAS.ESTADO_REMOTO_DEGRADADO], {
            [dc.CAUSAS.ESTADO_REMOTO_DEGRADADO]: gate.detalle,
        }),
        1_000,
    );
    assert.equal(causa.causa, dc.CAUSAS.ESTADO_REMOTO_DEGRADADO);
    assert.equal(causa.anomalia, false);
    assert.notEqual(causa.causa, dc.CAUSAS.ANOMALIA);
    // El label que ve el operador tiene que traer la acción (CA-UX5).
    assert.match(causa.label, /rollback|filesystem|durable: false/i);
    // Y el shape tiene que ser persistible: el enum es cerrado y `publish`
    // valida antes de escribir el artifact.
    assert.doesNotThrow(() => dc.validateCause(causa));
});

test('CA-UX2 (caso negativo): sin la causa marcada, el mismo ciclo cae en `anomalia_no_determinable`', () => {
    // Éste es el bug que el CA existe para impedir. Si alguien saca el
    // `_dcMark` del brazo de lanzamiento, este test sigue verde y el de arriba
    // también — por eso el que manda es el de abajo, que ata las dos mitades.
    const causa = dc.resolveCause(cicloOcioso([]), 1_000);
    assert.equal(causa.causa, dc.CAUSAS.ANOMALIA);
    assert.equal(causa.anomalia, true);
});

test('CA-UX2: la decisión pura y la publicación están ATADAS (el marcado no es decorativo)', () => {
    // Recorre el circuito completo con el mismo `mark` que usa `brazoLanzamiento`:
    // describeMode → opstateDispatchGate → mark → resolveCause.
    const gates = new Map();
    const mark = (c, d) => { if (!gates.has(c)) gates.set(c, d); };

    const decision = opstateDispatchGate({ mode: 'remote', degraded: true, lastError: 'timeout' });
    if (decision.blocked) mark(dc.CAUSAS.ESTADO_REMOTO_DEGRADADO, decision.detalle);

    const causa = dc.resolveCause({
        anyLaunched: false,
        hayPendientes: true,
        gatesActivos: new Set(gates.keys()),
        detalles: Object.fromEntries(gates),
    }, 1_000);

    assert.equal(causa.causa, dc.CAUSAS.ESTADO_REMOTO_DEGRADADO);
    assert.match(causa.detalle, /no responde/i);
});

test('CA-UX2: la causa del sustrato GANA sobre `MODO_OLA` (un fail-closed no es "modo ola")', () => {
    // `MODO_OLA` es una causa SILENCIOSA: si la degradación del store se
    // mapeara ahí, una falla real de infraestructura se pintaría como estado
    // esperado y no alertaría a nadie.
    const causa = dc.resolveCause(
        cicloOcioso([dc.CAUSAS.MODO_OLA, dc.CAUSAS.ESTADO_REMOTO_DEGRADADO]),
        1_000,
    );
    assert.equal(causa.causa, dc.CAUSAS.ESTADO_REMOTO_DEGRADADO);
});

test('CA-UX2: la causa del sustrato es ALERTABLE (no puede ser silenciosa)', () => {
    assert.ok(
        dc.CAUSAS_ALERTABLES.has(dc.CAUSAS.ESTADO_REMOTO_DEGRADADO),
        'la degradación del estado operativo tiene que alertar: es una falla de infra, no un estado esperado',
    );
});

test('CA-UX2: un deadlock real sigue explicando mejor el no-despacho', () => {
    // El orden dentro de PRECEDENCIA no es cosmético: si coexisten, el deadlock
    // del gate predictivo es la causa más informativa.
    const causa = dc.resolveCause(
        cicloOcioso([dc.CAUSAS.ESTADO_REMOTO_DEGRADADO, dc.CAUSAS.DEADLOCK]),
        1_000,
    );
    assert.equal(causa.causa, dc.CAUSAS.DEADLOCK);
});

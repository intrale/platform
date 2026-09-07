// =============================================================================
// Tests brazo-desbloqueo-core.js — issue #6902 (detección de ciclos)
//
// Cubre:
//   CA-4 · El brazo detecta un ciclo y lo reporta explícitamente, en vez de
//          dejar a los issues esperando en silencio para siempre.
//   CA-5 · Una hija de split que declara a su madre queda marcada como ciclo.
//   + El ciclo NO se rompe automáticamente (fuera de alcance por decisión).
//
// El grafo del primer test es el REAL de la ola 9.4, tal como lo devolvió el
// resolver el 04/09/2026 antes del paliativo manual.
//
// Ejecutar:
//   node --test .pipeline/lib/__tests__/brazo-desbloqueo-ciclos-6902.test.js
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../brazo-desbloqueo-core');

const clavesDe = (ciclos) => ciclos.map((c) => c.key).sort();

// -----------------------------------------------------------------------------
// CA-4 · Detección y reporte de ciclos
// -----------------------------------------------------------------------------

test('CA-4 · caso real ola 9.4: detecta los cuatro ciclos madre-hija', () => {
    // Salida textual del resolver el 04/09/2026, antes del reposteo manual.
    const blockedBy = {
        6191: [6173, 6190],
        6192: [6173, 6190],
        6207: [5445, 6192, 6199, 6206],
        6209: [6199, 6206, 6207, 6208],
        6173: [6190, 6191, 6192],
        6199: [6206, 6207, 6208, 6209],
    };

    const ciclos = core.detectDependencyCycles(blockedBy);
    assert.deepEqual(clavesDe(ciclos), ['6173>6191', '6173>6192', '6199>6207', '6199>6209']);
});

test('CA-4 · el grafo YA CORREGIDO (post-paliativo) no tiene ningún ciclo', () => {
    const blockedBy = {
        6191: [6190],
        6192: [6190],
        6207: [6192, 6206],
        6209: [6206, 6207, 6208],
        6173: [6190, 6191, 6192],
        6199: [6206, 6207, 6208, 6209],
    };
    assert.deepEqual(core.detectDependencyCycles(blockedBy), []);
});

test('CA-4 · un grafo acíclico normal no reporta nada', () => {
    assert.deepEqual(core.detectDependencyCycles({ 100: [200], 200: [300], 300: [] }), []);
});

test('CA-4 · detecta un ciclo largo (A → B → C → A)', () => {
    const ciclos = core.detectDependencyCycles({ 10: [20], 20: [30], 30: [10] });
    assert.equal(ciclos.length, 1);
    assert.equal(ciclos[0].key, '10>20>30');
    assert.equal(core.formatCycle(ciclos[0].cycle), '#10 → #20 → #30 → #10');
});

test('CA-4 · una dependencia que NO está bloqueada no puede cerrar un ciclo', () => {
    // #500 no es nodo del grafo (no tiene `blocked:dependencies`): aunque el
    // marker de #400 lo cite, ahí no hay deadlock que reportar.
    assert.deepEqual(core.detectDependencyCycles({ 400: [500] }), []);
});

test('CA-4 · el mismo ciclo recorrido desde distintos nodos comparte firma', () => {
    const a = core.detectDependencyCycles({ 10: [20], 20: [10] });
    const b = core.detectDependencyCycles({ 20: [10], 10: [20] });
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
    assert.equal(a[0].key, b[0].key, 'la firma dedupe el aviso: un deadlock, un mensaje');
});

test('CA-4 · el aviso nombra el ciclo completo, no "hay un ciclo"', () => {
    const [c] = core.detectDependencyCycles({ 6173: [6191], 6191: [6173] });
    const alerta = core.buildCycleAlert(c);

    assert.match(alerta.telegram, /#6173 → #6191 → #6173/, 'el operador debe poder decidir sin abrir issues');
    assert.match(alerta.log, /#6173 → #6191 → #6173/);
    assert.match(alerta.telegram, /🔴/, 'severidad de anomalía, no informativa');
    assert.match(alerta.telegram, /repostea|reposteá/i, 'debe decir CÓMO se corrige');
    assert.equal(alerta.key, c.key, 'la clave del aviso es la firma del ciclo (anti-spam)');
});

test('CA-4 · el detector NO rompe el ciclo: sólo devuelve información', () => {
    const blockedBy = { 6173: [6191], 6191: [6173] };
    const copia = JSON.parse(JSON.stringify(blockedBy));
    core.detectDependencyCycles(blockedBy);
    assert.deepEqual(blockedBy, copia, 'romper el ciclo es decisión humana, está fuera de alcance');
});

test('CA-4 · entradas basura no rompen el detector (el brazo no puede morir)', () => {
    for (const raro of [null, undefined, 42, 'texto', []]) {
        assert.deepEqual(core.detectDependencyCycles(raro), []);
    }
    assert.deepEqual(core.detectDependencyCycles({ 100: null, 200: 'x', 300: [100] }), []);
});

test('CA-4 · una auto-referencia no se reporta como ciclo', () => {
    // El parser ya excluye el self-issue; si aun así llegara, no es el deadlock
    // madre-hija que buscamos y avisarlo sería ruido.
    assert.deepEqual(core.detectDependencyCycles({ 100: [100] }), []);
});

test('CA-4 · grafo grande sin recursión (no vuelca el stack del Pulpo)', () => {
    const blockedBy = {};
    for (let i = 0; i < 5000; i++) blockedBy[i] = [i + 1];
    blockedBy[5000] = [0];   // cierra un ciclo de 5001 nodos
    const ciclos = core.detectDependencyCycles(blockedBy);
    assert.equal(ciclos.length, 1);
    assert.equal(ciclos[0].cycle.length, 5002);
});

// -----------------------------------------------------------------------------
// CA-5 · Guardrail madre-hija
// -----------------------------------------------------------------------------

test('CA-5 · una hija de split que declara a su madre queda marcada como ciclo', () => {
    const r = core.detectMotherChildCycle({
        title: '[Split de #6173] Tarjeta de decisión en el dashboard',
        issue: 6191,
        deps: [6173, 6190],
    });

    assert.equal(r.isCycle, true);
    assert.equal(r.parent, 6173);
    assert.equal(r.reason, 'hija-declara-a-su-madre');
    assert.match(r.telegram, /#6173 → #6191 → #6173/);
    assert.match(r.log, /ciclo madre-hija/);
});

test('CA-5 · una hija que NO declara a su madre no dispara nada', () => {
    const r = core.detectMotherChildCycle({
        title: '[Split de #6173] Tarjeta de decisión en el dashboard',
        issue: 6191,
        deps: [6190],
    });
    assert.equal(r.isCycle, false);
    assert.equal(r.parent, 6173);
    assert.equal(r.reason, 'no-declara-a-la-madre');
    assert.equal(r.telegram, null);
});

test('CA-5 · un issue que no es hija de split nunca dispara el guardrail', () => {
    const r = core.detectMotherChildCycle({
        title: 'feat: tarjeta de decisión en el dashboard',
        issue: 6191,
        deps: [6173],
    });
    assert.equal(r.isCycle, false);
    assert.equal(r.parent, null);
    assert.equal(r.reason, 'no-es-hija-de-split');
});

test('CA-5 · compara por número, no por tipo (deps como string)', () => {
    const r = core.detectMotherChildCycle({
        title: '[Split de #6199] Firma desde Telegram',
        issue: '6207',
        deps: ['6206', '6199'],
    });
    assert.equal(r.isCycle, true);
    assert.equal(r.parent, 6199);
});

test('CA-5 · el guardrail avisa pero NO filtra la dependencia', () => {
    const deps = [6173, 6190];
    const r = core.detectMotherChildCycle({ title: '[Split de #6173] x', issue: 6191, deps });
    assert.equal(r.isCycle, true);
    assert.deepEqual(deps, [6173, 6190], 'el pipeline no borra dependencias por su cuenta');
});

test('CA-5 · entradas incompletas degradan sin excepción', () => {
    assert.equal(core.detectMotherChildCycle().isCycle, false);
    assert.equal(core.detectMotherChildCycle({}).reason, 'sin-titulo');
    assert.equal(core.detectMotherChildCycle({ title: '[Split de #10] x' }).reason, 'no-declara-a-la-madre');
    assert.equal(core.detectMotherChildCycle({ title: 42, deps: [1] }).isCycle, false);
});

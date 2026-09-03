'use strict';

// =============================================================================
// #6432 rev-2 — NO-REGRESIÓN del freno humano (auditoría SEC / OWASP A01+A09)
// -----------------------------------------------------------------------------
// BLOQUEANTE 1. El circuit breaker había dejado de ser un freno humano. Su
// precondición se calculaba con `classifyPrecondition(motivosClasificados, ...)`
// y `motivosClasificados` arrastra el `depende_de` que emitió el agente
// (pulpo.js:4491). Como la rama `dependency` se evalúa PRIMERO, el marker nacía
// `{type:'dependency'}` — exactamente el tipo que `reapStaleHumanBlocks` está
// autorizado a auto-liberar. Con esa dep ya CLOSED, el `needs-human` se retiraba
// solo en un ciclo, sin que ningún humano mirara un issue que agotó 3 rebotes.
//
// BLOQUEANTE 2. El destrabe del rescate usaba `unlocker:
// 'brazo-desbloqueo:merge-race'`, fuera de `UNLOCKER_ENUM`, así que
// `normalizeUnlocker` lo reescribía a 'unknown': la acción más privilegiada del
// PR (retirar needs-human tras mergear a main sin humano) quedaba sin autor en
// la traza, justo lo que SEC-14.2 pide auditar.
//
// Estos tests fallan si cualquiera de los dos agujeros vuelve.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const humanBlock = require('../human-block');
const core = require('../brazo-desbloqueo-core');

const SHA = 'a'.repeat(40);
const PULPO = path.join(__dirname, '..', '..', 'pulpo.js');

// Forma REAL de `motivosClasificados` (pulpo.js:4487-4504), no una simplificada:
// si el shape cambia y deja de arrastrar `depende_de`, el test tiene que verlo.
function motivoClasificado(overrides = {}) {
    return {
        skill: 'security', motivo: 'rechazo bloqueante', clasificacion: 'codigo',
        rebote_categoria: null, depende_de: null, paths: null, source: 'security',
        precondicion_merge_checks: null, ...overrides,
    };
}

// Código de pulpo.js sin comentarios: se audita lo que corre, no la prosa.
function pulpoSinComentarios() {
    return fs.readFileSync(PULPO, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
}

test('#6432 rev-2: el circuit breaker NUNCA nace con precondición `dependency`', () => {
    // El agente rechazó declarando `depende_de` y además se agotaron los rebotes.
    assert.deepEqual(
        humanBlock.classifyPrecondition([motivoClasificado({ depende_de: [9999] })], [], { issue: 6432, only: 'merge_checks_race' }),
        { type: 'human_judgment' },
        'el freno humano del circuit breaker no puede ser auto-re-evaluable por deps');

    // `precondicion_issues` es la OTRA fuente que lee la rama `dependency`:
    // tapar sólo `depende_de` dejaría el mismo agujero por la puerta de al lado.
    assert.deepEqual(
        humanBlock.classifyPrecondition([motivoClasificado({ precondicion_issues: [9999] })], [], { issue: 6432, only: 'merge_checks_race' }),
        { type: 'human_judgment' });

    // Y `extraDeps`, que entra por parámetro y no por el YAML del agente.
    assert.deepEqual(
        humanBlock.classifyPrecondition([motivoClasificado()], [9999], { issue: 6432, only: 'merge_checks_race' }),
        { type: 'human_judgment' });
});

test('#6432 rev-2: el marker del circuit breaker no aparece en `toRelease` ni con la dep CLOSED', () => {
    // Cadena COMPLETA tal como corre en producción: clasificar (pulpo) →
    // normalizar (reportHumanBlock congela el marker) → seleccionar (brazo).
    const motivos = [motivoClasificado({ depende_de: [9999] })];
    const congelada = humanBlock.normalizePrecondition(
        humanBlock.classifyPrecondition(motivos, [], { issue: 6432, only: 'merge_checks_race' }));
    assert.deepEqual(congelada, { type: 'human_judgment' });

    // La dep está CLOSED: es exactamente el escenario que auto-liberaba el freno.
    const seleccion = core.selectHumanBlocksToRelease({
        markers: [{ issue: 6432, skill: 'security', precondition: congelada }],
        issueStates: { 9999: 'CLOSED' },
    });
    assert.deepEqual(seleccion.toRelease, [], 'el brazo no puede auto-liberar el circuit breaker');
    assert.deepEqual(seleccion.blocked, [], 'y tampoco lo reporta bloqueado: es intocable');

    // CONTRAPRUEBA: sin el acote, la MISMA entrada sí se auto-libera. Si esta
    // aserción empieza a fallar es que `dependency` dejó de ser liberable y este
    // test perdió su capacidad de detectar la regresión (se volvió vacuo).
    const sinAcote = humanBlock.normalizePrecondition(
        humanBlock.classifyPrecondition(motivos, [], { issue: 6432 }));
    assert.deepEqual(sinAcote, { type: 'dependency', depends_on: [9999] });
    assert.equal(
        core.selectHumanBlocksToRelease({
            markers: [{ issue: 6432, precondition: sinAcote }], issueStates: { 9999: 'CLOSED' },
        }).toRelease.length,
        1, 'la contraprueba tiene que reproducir el agujero original');
});

test('#6432 rev-2: el acote deja pasar `merge_checks_race` y no rompe el camino histórico', () => {
    // El rescate de merges SIGUE vivo: su destrabe pasa por los gates de
    // delivery, así que sí puede ser auto-re-evaluable desde el circuit breaker.
    const race = motivoClasificado({ skill: 'delivery', precondicion_merge_checks: { pr: 6500, head_sha: SHA } });
    assert.deepEqual(
        humanBlock.classifyPrecondition([race], [], { issue: 6432, only: 'merge_checks_race' }),
        { type: 'merge_checks_race', pr: 6500, head_sha: SHA });

    // Con dep Y race juntos gana el race, porque `dependency` ni se evalúa.
    assert.deepEqual(
        humanBlock.classifyPrecondition([motivoClasificado({ depende_de: [9999] }), race], [], { issue: 6432, only: 'merge_checks_race' }),
        { type: 'merge_checks_race', pr: 6500, head_sha: SHA });

    // Sin `only`, el comportamiento histórico queda INTACTO para el resto de
    // los llamadores (el brazo de deps #4748 sigue dependiendo de él).
    assert.deepEqual(
        humanBlock.classifyPrecondition([motivoClasificado({ depende_de: [9999] })], [], { issue: 6432 }),
        { type: 'dependency', depends_on: [9999] });
});

test('#6432 rev-2: `only` ilegible o desconocido cae al piso fail-closed', () => {
    const motivos = [motivoClasificado({ depende_de: [9999] })];
    // Un `only` que no nombra ningún tipo conocido NO abre nada: no es comodín.
    for (const only of ['basura', '', [], ['nope'], [null], 123, {}]) {
        assert.deepEqual(
            humanBlock.classifyPrecondition(motivos, [], { issue: 6432, only }),
            { type: 'human_judgment' },
            `only=${JSON.stringify(only)} no puede habilitar dependency`);
    }
    // Sólo ausente (null/undefined) restaura el comportamiento sin restricción.
    assert.deepEqual(
        humanBlock.classifyPrecondition(motivos, [], { issue: 6432, only: null }),
        { type: 'dependency', depends_on: [9999] });
});

test('#6432 rev-2: el call site del circuit breaker en pulpo.js pasa el acote', () => {
    // Sin este cableado los fixes de arriba son código muerto.
    const pulpo = pulpoSinComentarios();
    const idx = pulpo.indexOf('const circuitPrecondition');
    assert.notEqual(idx, -1, 'tiene que existir el cálculo de precondición del circuit breaker');
    const bloque = pulpo.slice(idx, pulpo.indexOf(';', idx));
    assert.match(bloque, /only:\s*'merge_checks_race'/,
        'el circuit breaker tiene que acotar su precondición a merge_checks_race');
});

test('#6432 rev-2 (A09): el destrabe del rescate se audita con autor, no como `unknown`', () => {
    assert.deepEqual(humanBlock.normalizeUnlocker('brazo-desbloqueo:merge-race'),
        { unlocker: 'brazo-desbloqueo:merge-race' });
    assert.ok(humanBlock.UNLOCKER_ENUM.includes('brazo-desbloqueo:merge-race'));

    // El enum sigue CERRADO: un valor inventado degrada a 'unknown' como antes.
    assert.equal(humanBlock.normalizeUnlocker('brazo-desbloqueo:inventado').unlocker, 'unknown');

    // Y el literal del call site real tiene que ser EXACTAMENTE el del enum:
    // un typo ahí devuelve la traza a 'unknown' sin que ningún test lo note.
    const pulpo = fs.readFileSync(PULPO, 'utf8');
    const usados = [...pulpo.matchAll(/unblock\(\{[^}]*unlocker:\s*'([^']+)'[^}]*\}\)/g)]
        .map((m) => m[1])
        .filter((u) => u.includes('merge-race'));
    assert.ok(usados.length > 0, 'el brazo de merge-race tiene que destrabar con unlocker propio');
    for (const u of usados) {
        assert.equal(humanBlock.normalizeUnlocker(u).unlocker, u,
            `unlocker '${u}' del call site no está en UNLOCKER_ENUM`);
    }
});

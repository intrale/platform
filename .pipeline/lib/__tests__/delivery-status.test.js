// Tests de .pipeline/lib/delivery-status.js — fuente única del estado
// "Entregado" (#5629).
//
// El caso que originó el módulo: #5220 y #5244 se pintaban 100% en la columna
// Entregado del tablero con sus PRs (#5277, #5280) SIN mergear y los issues
// ABIERTOS en GitHub, porque su marker de entrega decía `resultado: aprobado`
// (el motivo confesaba "merge bloqueado").
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ds = require('../delivery-status');

// SHA real de 40 hex y su forma corta.
const SHA_FULL = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
const SHA_SHORT = 'a1b2c3d';

// Marker tal como quedaron los de #5220 / #5244: entrega procesada y "aprobada"
// pero SIN `delivery_merge_sha` — el merge nunca ocurrió.
function markerAprobadoSinMerge() {
    return {
        fases: {
            'desarrollo/entrega': [{
                estado: 'procesado',
                resultado: 'aprobado',
                motivo: 'PR #5277 creado pero sin label qa:passed/qa:skipped — merge bloqueado.',
            }],
        },
    };
}

function markerMergeado(sha = SHA_FULL) {
    return {
        fases: {
            'desarrollo/entrega': [{
                estado: 'procesado',
                resultado: 'aprobado',
                delivery_merge_sha: sha,
            }],
        },
    };
}

// ── normalizeMergeSha ───────────────────────────────────────────────────────

test('normalizeMergeSha acepta SHA completo y corto, normalizando a minúsculas', () => {
    assert.equal(ds.normalizeMergeSha(SHA_FULL), SHA_FULL);
    assert.equal(ds.normalizeMergeSha(SHA_SHORT), SHA_SHORT);
    assert.equal(ds.normalizeMergeSha(SHA_FULL.toUpperCase()), SHA_FULL);
    assert.equal(ds.normalizeMergeSha(`  ${SHA_FULL}  `), SHA_FULL);
});

test('normalizeMergeSha rechaza placeholders y valores no-SHA (no basta con ser truthy)', () => {
    // Todos estos son truthy: si la regla fuera `!!mergeSha` contarían como merge.
    for (const v of ['(sin merge)', 'null', 'pending', 'unknown', 'no', 'zzzzzzz', '123', '-'.repeat(40)]) {
        assert.equal(ds.normalizeMergeSha(v), null, `no debe aceptar ${JSON.stringify(v)}`);
    }
});

test('normalizeMergeSha degrada a null ante tipos no-string o vacíos', () => {
    for (const v of [null, undefined, '', '   ', 0, 42, true, {}, [], NaN]) {
        assert.equal(ds.normalizeMergeSha(v), null);
    }
});

// ── extractMergeSha ─────────────────────────────────────────────────────────

test('extractMergeSha devuelve el SHA del marker de entrega', () => {
    assert.equal(ds.extractMergeSha(markerMergeado()), SHA_FULL);
});

test('#5629 — extractMergeSha NO inventa SHA desde `resultado: aprobado` ni desde `motivo`', () => {
    // El corazón del bug: el marker dice aprobado y el motivo menciona el PR,
    // pero no hubo merge. Ningún parseo de prosa debe producir un SHA.
    assert.equal(ds.extractMergeSha(markerAprobadoSinMerge()), null);
});

test('extractMergeSha ignora markers todavía sin veredicto (pendiente/trabajando)', () => {
    const entry = {
        fases: {
            'desarrollo/entrega': [{ estado: 'trabajando', delivery_merge_sha: SHA_FULL }],
        },
    };
    assert.equal(ds.extractMergeSha(entry), null,
        'un archivo en trabajando/ no acredita entrega: el SHA sería de una corrida anterior');
});

test('extractMergeSha sólo mira la fase de entrega, no otras fases', () => {
    const entry = {
        fases: {
            'desarrollo/dev': [{ estado: 'procesado', delivery_merge_sha: SHA_FULL }],
        },
    };
    assert.equal(ds.extractMergeSha(entry), null);
});

test('extractMergeSha degrada a null ante entradas malformadas, sin throw', () => {
    for (const v of [null, undefined, {}, { fases: null }, { fases: {} },
        { fases: { 'desarrollo/entrega': null } },
        { fases: { 'desarrollo/entrega': [] } },
        { fases: { 'desarrollo/entrega': [null, 'x', 7] } }]) {
        assert.equal(ds.extractMergeSha(v), null);
    }
});

// ── isDelivered ─────────────────────────────────────────────────────────────

test('isDelivered: CLOSED en GitHub alcanza (R1 — #4099/#4732)', () => {
    assert.equal(ds.isDelivered({ closedInGitHub: true, mergeSha: null }), true);
});

test('isDelivered: merge SHA estructurado alcanza aunque GitHub todavía diga OPEN (CA-5)', () => {
    // Cierra la ventana del TTL de 1h del title-cache: PR mergeado hace un
    // minuto, cache desactualizado.
    assert.equal(ds.isDelivered({ closedInGitHub: false, mergeSha: SHA_FULL }), true);
});

test('#5629 CA-1 — issue abierto y sin merge NO está entregado', () => {
    assert.equal(ds.isDelivered({ closedInGitHub: false, mergeSha: null }), false);
    assert.equal(ds.isDelivered({}), false);
    assert.equal(ds.isDelivered(), false, 'sin argumentos degrada a no-entregado (fail-closed)');
});

test('isDelivered no acepta `closedInGitHub` truthy no-booleano (evita coerciones sueltas)', () => {
    assert.equal(ds.isDelivered({ closedInGitHub: 'CLOSED', mergeSha: null }), false);
    assert.equal(ds.isDelivered({ closedInGitHub: 1, mergeSha: null }), false);
});

// ── deriveDeliveryState ─────────────────────────────────────────────────────

test('#5629 CA-6 — REGRESIÓN #5220/#5244: marker aprobado + PR sin mergear + issue abierto', () => {
    const r = ds.deriveDeliveryState({
        id: 5220,
        closedSet: new Set([]),           // #5220 está ABIERTO en GitHub
        matrixEntry: markerAprobadoSinMerge(),
    });
    assert.equal(r.delivered, false, 'NO puede contar como entregado');
    assert.equal(r.mergeSha, null);
    assert.equal(r.closedInGitHub, false);
    assert.equal(r.source, 'none');
});

test('#5629 CA-2 — marker de entrega histórico tras un rebote no acredita entrega', () => {
    // El marker sobrevive al rebote; el issue volvió a una fase anterior y hoy
    // tiene un agente en aprobación. El cierre histórico no debe ganarle a la
    // faseActual viva.
    const r = ds.deriveDeliveryState({
        id: 5242,
        closedSet: new Set([]),
        matrixEntry: {
            faseActual: 'desarrollo/aprobacion',
            estadoActual: 'trabajando',
            fases: {
                'desarrollo/aprobacion': [{ estado: 'trabajando', skill: 'review' }],
                'desarrollo/entrega': [{ estado: 'procesado', resultado: 'aprobado' }],
            },
        },
    });
    assert.equal(r.delivered, false);
});

test('deriveDeliveryState marca entregado por CLOSED de GitHub', () => {
    const r = ds.deriveDeliveryState({ id: 4248, closedSet: new Set([4248]), matrixEntry: null });
    assert.equal(r.delivered, true);
    assert.equal(r.closedInGitHub, true);
    assert.equal(r.source, 'github-closed');
});

test('deriveDeliveryState marca entregado por merge SHA con el issue aún OPEN (CA-5)', () => {
    const r = ds.deriveDeliveryState({ id: 999, closedSet: new Set([]), matrixEntry: markerMergeado() });
    assert.equal(r.delivered, true);
    assert.equal(r.closedInGitHub, false);
    assert.equal(r.mergeSha, SHA_FULL);
    assert.equal(r.source, 'merge-sha', 'la señal local se adelanta al cache de títulos');
});

test('deriveDeliveryState acepta closedSet como Array y como Set, con id string o number', () => {
    assert.equal(ds.deriveDeliveryState({ id: '77', closedSet: [77] }).delivered, true);
    assert.equal(ds.deriveDeliveryState({ id: 77, closedSet: new Set([77]) }).delivered, true);
    assert.equal(ds.deriveDeliveryState({ id: '77', closedSet: new Set(['77']) }).delivered, true);
});

test('deriveDeliveryState degrada a no-entregado ante input inválido, sin throw', () => {
    for (const v of [undefined, {}, { id: null }, { id: 'abc' }, { id: 1, closedSet: 'nope' }]) {
        assert.equal(ds.deriveDeliveryState(v).delivered, false);
    }
});

// ── Guardrail estructural de la regla R3 ────────────────────────────────────

test('#5629 CA-4 — la superficie del módulo no expone ninguna vía de inferencia por texto', () => {
    // Guardrail: el helper NO debe crecer una función que mire `motivo` o
    // `resultado`. Si alguien la agrega, este test lo hace visible.
    const src = require('fs').readFileSync(require.resolve('../delivery-status.js'), 'utf8');
    // Fuera de los comentarios no debe haber accesos a esos campos.
    const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.equal(/\.motivo\b/.test(code), false, 'el estado de entrega no se infiere de `motivo` (#5516)');
    assert.equal(/\.resultado\b/.test(code), false, 'el estado de entrega no se infiere de `resultado`');
});

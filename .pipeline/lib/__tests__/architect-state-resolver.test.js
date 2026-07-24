// =============================================================================
// Tests architect-state-resolver.js — #3642 (widget architect 4 estados)
//
// Cubre la regla R1 multi-fase del rol architect (criterios + aprobacion) y
// el contrato del resolver para CA-PO-WIDGET-DISCOVERABLE.
//
//   resolveArchitectState(fasesByKey) → { state, startedAt } | null
//
// Reglas a verificar:
//   1) Sin entries → null (no badge)
//   2) Trabajando en Fase 2 mientras Fase 1 procesó → running
//   3) Pendiente sin trabajando → pending
//   4) Solo procesado → approved/rejected por updatedAt más reciente
//   5) Skills distintos de architect se ignoran
//
// Tests aislados, sin filesystem ni dependencias externas.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveArchitectState } = require('../architect-state-resolver');

test('devuelve null cuando no hay entries de architect', () => {
    const fases = {
        'definicion/analisis': [
            { skill: 'guru', estado: 'procesado', resultado: 'aprobado', updatedAt: 1000 },
        ],
        'desarrollo/dev': [
            { skill: 'pipeline-dev', estado: 'trabajando', startedAt: 2000 },
        ],
    };
    const result = resolveArchitectState(fases);
    assert.equal(result, null);
});

test('devuelve null cuando fasesByKey es null/undefined/no-objeto', () => {
    assert.equal(resolveArchitectState(null), null);
    assert.equal(resolveArchitectState(undefined), null);
    assert.equal(resolveArchitectState('string'), null);
    assert.equal(resolveArchitectState(42), null);
});

test('devuelve running con startedAt cuando hay entry trabajando en Fase 2 mientras Fase 1 ya procesó', () => {
    // Cubre R1 multi-fase + CA-PO-WIDGET-DISCOVERABLE: Fase 1 cerró aprobado,
    // pero Fase 2 esta corriendo ahora → estado running debe ganar.
    const startedAtFase2 = 1700000000000;
    const fases = {
        'definicion/criterios': [
            {
                skill: 'architect',
                estado: 'procesado',
                resultado: 'aprobado',
                updatedAt: 1600000000000,
                startedAt: 1500000000000,
            },
        ],
        'desarrollo/aprobacion': [
            {
                skill: 'architect',
                estado: 'trabajando',
                startedAt: startedAtFase2,
            },
        ],
    };
    const result = resolveArchitectState(fases);
    assert.equal(result.state, 'running');
    assert.equal(result.startedAt, startedAtFase2);
});

test('devuelve pending cuando hay entry pendiente sin trabajando', () => {
    const fases = {
        'definicion/criterios': [
            { skill: 'architect', estado: 'pendiente' },
        ],
    };
    const result = resolveArchitectState(fases);
    assert.deepEqual(result, { state: 'pending', startedAt: null });
});

test('trabajando gana sobre pendiente en cualquier fase', () => {
    const fases = {
        'definicion/criterios': [
            { skill: 'architect', estado: 'pendiente' },
        ],
        'desarrollo/aprobacion': [
            { skill: 'architect', estado: 'trabajando', startedAt: 9999 },
        ],
    };
    const result = resolveArchitectState(fases);
    assert.equal(result.state, 'running');
    assert.equal(result.startedAt, 9999);
});

test('devuelve approved cuando el procesado más reciente por updatedAt es aprobado', () => {
    const fases = {
        'definicion/criterios': [
            { skill: 'architect', estado: 'procesado', resultado: 'rechazado', updatedAt: 1000 },
            { skill: 'architect', estado: 'procesado', resultado: 'aprobado', updatedAt: 2000 },
        ],
    };
    const result = resolveArchitectState(fases);
    assert.equal(result.state, 'approved');
    assert.equal(result.startedAt, null);
});

test('devuelve rejected cuando el procesado más reciente por updatedAt es rechazado', () => {
    const fases = {
        'definicion/criterios': [
            { skill: 'architect', estado: 'procesado', resultado: 'aprobado', updatedAt: 1000 },
        ],
        'desarrollo/aprobacion': [
            { skill: 'architect', estado: 'procesado', resultado: 'rechazado', updatedAt: 2000 },
        ],
    };
    const result = resolveArchitectState(fases);
    assert.equal(result.state, 'rejected');
});

test('listo tambien se considera terminal (no hay procesado pero hay listo)', () => {
    const fases = {
        'definicion/criterios': [
            { skill: 'architect', estado: 'listo', resultado: 'aprobado', updatedAt: 1000 },
        ],
    };
    const result = resolveArchitectState(fases);
    assert.equal(result.state, 'approved');
});

test('ignora entries de skills distintos de architect', () => {
    // Defensa contra confusion cross-skill: aunque haya un guru trabajando,
    // si no hay architect, no se renderiza badge.
    const fases = {
        'definicion/analisis': [
            { skill: 'guru', estado: 'trabajando', startedAt: 5000 },
            { skill: 'security', estado: 'procesado', resultado: 'aprobado', updatedAt: 1000 },
        ],
    };
    const result = resolveArchitectState(fases);
    assert.equal(result, null);
});

test('toma el startedAt mas reciente cuando hay multiples trabajando', () => {
    // Caso patológico (2 entries trabajando simultaneos) — el resolver
    // debe elegir el mas nuevo para que HH:MM coincida con el activo.
    const fases = {
        'definicion/criterios': [
            { skill: 'architect', estado: 'trabajando', startedAt: 1000 },
        ],
        'desarrollo/aprobacion': [
            { skill: 'architect', estado: 'trabajando', startedAt: 5000 },
        ],
    };
    const result = resolveArchitectState(fases);
    assert.equal(result.state, 'running');
    assert.equal(result.startedAt, 5000);
});

test('startedAt invalido en trabajando resulta en startedAt null (no rompe)', () => {
    const fases = {
        'desarrollo/aprobacion': [
            { skill: 'architect', estado: 'trabajando', startedAt: undefined },
        ],
    };
    const result = resolveArchitectState(fases);
    assert.equal(result.state, 'running');
    assert.equal(result.startedAt, null);
});

test('entries no-array en alguna fase no rompe el resolver', () => {
    const fases = {
        'definicion/criterios': 'no soy array',
        'desarrollo/aprobacion': [
            { skill: 'architect', estado: 'pendiente' },
        ],
    };
    const result = resolveArchitectState(fases);
    assert.equal(result.state, 'pending');
});

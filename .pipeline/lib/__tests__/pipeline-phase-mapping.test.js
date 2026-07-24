// =============================================================================
// pipeline-phase-mapping.test.js — Tests del mapping de aliases (#3416).
// =============================================================================
//
// Cubre Decisión 1 (whitelist enum) + Decisión 2 (alias ambiguo → upstream
// más cercano) del PO. Whitelist cerrada: cualquier alias fuera del enum
// debe rechazarse con `ALIAS_NOT_IN_WHITELIST`.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const pm = require('../pipeline-phase-mapping');

// Config canónico para los tests (subset del config.yaml real).
const FAKE_CONFIG = Object.freeze({
    pipelines: {
        definicion: {
            fases: ['analisis', 'criterios', 'sizing'],
            skills_por_fase: {
                analisis: ['guru', 'security'],
                criterios: ['po', 'ux'],
                sizing: ['planner'],
            },
        },
        desarrollo: {
            fases: ['validacion', 'dev', 'build', 'verificacion', 'linteo', 'aprobacion', 'entrega'],
            skills_por_fase: {
                validacion: ['po', 'ux', 'guru'],
                dev: ['backend-dev', 'android-dev'],
                build: ['build'],
                verificacion: ['tester', 'security', 'qa'],
                linteo: ['linter'],
                aprobacion: ['review', 'po', 'ux'],
                entrega: ['delivery'],
            },
        },
    },
});

test('normalizeAlias hace lowercase + trim', () => {
    assert.equal(pm.normalizeAlias('  UX '), 'ux');
    assert.equal(pm.normalizeAlias('Validacion-PO'), 'validacion-po');
    assert.equal(pm.normalizeAlias(''), '');
    assert.equal(pm.normalizeAlias(undefined), '');
    assert.equal(pm.normalizeAlias(null), '');
});

test('listAliases devuelve todos los aliases en orden', () => {
    const aliases = pm.listAliases();
    assert.ok(aliases.length > 10, 'debería listar > 10 aliases');
    assert.ok(aliases.includes('ux'));
    assert.ok(aliases.includes('validacion-ux'));
    assert.ok(aliases.includes('criterios-ux'));
    assert.ok(aliases.includes('review'));
});

test('resolveAlias rechaza alias fuera de whitelist', () => {
    const r = pm.resolveAlias('inventado', { pipeline: 'desarrollo', fase: 'dev' }, FAKE_CONFIG);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'ALIAS_NOT_IN_WHITELIST');
    assert.match(r.message, /aliases? v[áa]lidos?/i);
});

test('resolveAlias rechaza alias vacío', () => {
    const r = pm.resolveAlias('', { pipeline: 'desarrollo', fase: 'dev' }, FAKE_CONFIG);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'ALIAS_EMPTY');
});

test('resolveAlias case-insensitive — UX y ux resuelven igual', () => {
    const a = pm.resolveAlias('UX', { pipeline: 'desarrollo', fase: 'dev' }, FAKE_CONFIG);
    const b = pm.resolveAlias('ux', { pipeline: 'desarrollo', fase: 'dev' }, FAKE_CONFIG);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.deepEqual(a.target, b.target);
});

test('resolveAlias explícito (validacion-ux) ignora currentPosition', () => {
    const r = pm.resolveAlias('validacion-ux', { pipeline: 'desarrollo', fase: 'aprobacion' }, FAKE_CONFIG);
    assert.equal(r.ok, true);
    assert.equal(r.target.pipeline, 'desarrollo');
    assert.equal(r.target.fase, 'validacion');
    assert.equal(r.target.skill, 'ux');
    assert.equal(r.target.explicit, true);
});

test('resolveAlias explícito review → desarrollo/aprobacion/review', () => {
    const r = pm.resolveAlias('review', { pipeline: 'desarrollo', fase: 'aprobacion' }, FAKE_CONFIG);
    assert.equal(r.ok, true);
    assert.deepEqual(r.target, { pipeline: 'desarrollo', fase: 'aprobacion', skill: 'review', explicit: true });
});

test('Decisión 2 — alias ambiguo "ux" desde aprobacion resuelve al ux upstream más cercano (aprobacion)', () => {
    // Desde desarrollo/aprobacion, el ux más cercano upstream o igual es
    // desarrollo/aprobacion (ux está en aprobacion según FAKE_CONFIG).
    const r = pm.resolveAlias('ux', { pipeline: 'desarrollo', fase: 'aprobacion' }, FAKE_CONFIG);
    assert.equal(r.ok, true);
    assert.equal(r.target.pipeline, 'desarrollo');
    assert.equal(r.target.fase, 'aprobacion');
    assert.equal(r.target.skill, 'ux');
    assert.equal(r.target.explicit, false);
});

test('Decisión 2 — alias "ux" desde dev resuelve a desarrollo/validacion (ux upstream más cercano)', () => {
    const r = pm.resolveAlias('ux', { pipeline: 'desarrollo', fase: 'dev' }, FAKE_CONFIG);
    assert.equal(r.ok, true);
    assert.equal(r.target.pipeline, 'desarrollo');
    assert.equal(r.target.fase, 'validacion');
    assert.equal(r.target.skill, 'ux');
});

test('Decisión 2 — alias "ux" desde definicion/sizing resuelve a definicion/criterios', () => {
    const r = pm.resolveAlias('ux', { pipeline: 'definicion', fase: 'sizing' }, FAKE_CONFIG);
    assert.equal(r.ok, true);
    assert.equal(r.target.pipeline, 'definicion');
    assert.equal(r.target.fase, 'criterios');
    assert.equal(r.target.skill, 'ux');
});

test('Decisión 2 — alias "ux" desde definicion/analisis NO encuentra upstream con ux', () => {
    // Análisis es la primera fase de definición y no contiene `ux`.
    const r = pm.resolveAlias('ux', { pipeline: 'definicion', fase: 'analisis' }, FAKE_CONFIG);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'SKILL_NOT_FOUND_UPSTREAM');
});

test('Alias ambiguo sin currentPosition → AMBIGUOUS_ALIAS_NEEDS_POSITION', () => {
    const r = pm.resolveAlias('ux', null, FAKE_CONFIG);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'AMBIGUOUS_ALIAS_NEEDS_POSITION');
});

test('isUpstreamOrSame — fase futura rechaza, misma fase acepta, anterior acepta', () => {
    // desarrollo/dev → desarrollo/validacion: upstream (válido).
    assert.equal(pm.isUpstreamOrSame('desarrollo', 'dev', 'desarrollo', 'validacion', FAKE_CONFIG), true);
    // desarrollo/dev → desarrollo/aprobacion: futuro (inválido).
    assert.equal(pm.isUpstreamOrSame('desarrollo', 'dev', 'desarrollo', 'aprobacion', FAKE_CONFIG), false);
    // desarrollo/dev → desarrollo/dev: misma fase (válido — permitido rehacer).
    assert.equal(pm.isUpstreamOrSame('desarrollo', 'dev', 'desarrollo', 'dev', FAKE_CONFIG), true);
    // desarrollo/validacion → definicion/criterios: cruza pipeline upstream (válido).
    assert.equal(pm.isUpstreamOrSame('desarrollo', 'validacion', 'definicion', 'criterios', FAKE_CONFIG), true);
});

test('isUpstreamOrSame defensivo: fase inexistente → false', () => {
    assert.equal(pm.isUpstreamOrSame('desarrollo', 'fantasma', 'desarrollo', 'dev', FAKE_CONFIG), false);
    assert.equal(pm.isUpstreamOrSame('desarrollo', 'dev', 'pipelineX', 'algo', FAKE_CONFIG), false);
});

test('getGlobalPhaseOrder respeta el orden del config', () => {
    const order = pm.getGlobalPhaseOrder(FAKE_CONFIG);
    assert.equal(order[0].pipeline, 'definicion');
    assert.equal(order[0].fase, 'analisis');
    // Definicion tiene 3 fases → desarrollo arranca en índice 3.
    assert.equal(order[3].pipeline, 'desarrollo');
    assert.equal(order[3].fase, 'validacion');
});

test('PHASE_MAPPING es inmutable (Object.freeze) — defensa contra mutación accidental', () => {
    assert.throws(() => {
        // En strict mode esto tira; en sloppy mode lo ignora pero sin mutar.
        pm.PHASE_MAPPING.foo = { skill: 'malicious', explicit: true };
    });
});

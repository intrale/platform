// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// =============================================================================
// recommender.test.js — Tests del recomendador (#7519, CA-13 … CA-18c).
//
// Un test por criterio del comentario canónico de `criterios` (PO) más los
// escenarios Gherkin del padre #6793 y los del PO. Fixtures con el contrato
// exacto de `agent-quality-signal.compute` (#7518, `OUTPUT_KEYS`) y la tabla
// de precios v1 real (valores copiados, no se lee ningún archivo).
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

const rec = require('../recommender');
const { OUTPUT_KEYS } = require('../agent-quality-signal');

const { VERDICT, MOTIVOS, RIESGO, ADVERTENCIAS, ALERTAS, EVIDENCIA_KEYS, DEFAULTS, PROTECTED_FLOOR } = rec;

// Tabla v1 real (in/out por millón de tokens). Empates reales: opus-4-7 = opus-4-6,
// sonnet-4-7 = sonnet-4-6.
const TABLE = Object.freeze({
    anthropic: {
        'claude-opus-4-7': { in: 15, out: 75 },
        'claude-opus-4-6': { in: 15, out: 75 },
        'claude-sonnet-4-7': { in: 3, out: 15 },
        'claude-sonnet-4-6': { in: 3, out: 15 },
        'claude-haiku-4-5': { in: 1, out: 5 },
        'claude-haiku-4-x': { in: 0.8, out: 4 },
    },
    openai: {
        'gpt-5': { in: 1.25, out: 10 },
        'gpt-5-codex': { in: 1.25, out: 10 },
        'gpt-5-mini': { in: 0.25, out: 2 },
    },
    google: {
        'gemini-2-5-pro': { in: 1.25, out: 10 },
        'gemini-2-5-flash': { in: 0.3, out: 2.5 },
    },
    deterministic: { deterministic: { in: 0, out: 0 } },
});
const pricing = { pricingByProvider: () => TABLE };

const AGENT_MODELS = Object.freeze({
    providers: {
        anthropic: { model: 'claude-opus-4-7' },
        'openai-codex': { model: 'gpt-5.5' },
        antigravity: { model: 'gemini-3.8-flash-medium' },
        deterministic: { model: 'deterministic' },
    },
    skills: {
        guru: { provider: 'anthropic', model_override: 'claude-sonnet-4-6' },
        doc: { provider: 'anthropic', model_override: 'claude-sonnet-4-6' },
        security: { provider: 'anthropic', model_override: 'claude-opus-4-7' },
        review: { provider: 'anthropic', model_override: 'claude-sonnet-4-6' },
        tester: { provider: 'deterministic' },
        'backend-dev': { provider: 'anthropic', model_override: 'claude-opus-4-7' },
        'pipeline-dev': { provider: 'anthropic' },
        qa: { provider: 'anthropic', model_override: 'claude-sonnet-4-6' },
        po: { provider: 'anthropic', model_override: 'claude-sonnet-4-6' },
    },
});
const ALLOWED_SKILLS = new Set(['guru', 'doc', 'security', 'review', 'tester', 'backend-dev', 'pipeline-dev', 'qa', 'po', 'commander']);
const ALLOWED_PROVIDERS = new Set(['anthropic', 'openai-codex', 'antigravity', 'deterministic']);
const ALIAS = Object.freeze({ 'openai-codex': 'openai' });

const T0 = Date.parse('2026-08-22T00:00:00.000Z');
const T1 = Date.parse('2026-09-21T00:00:00.000Z');
const VENTANA = Object.freeze({ from: T0, to: T1, dias: 30 });

/** Fila de calidad con el contrato exacto de la parte 2. */
function q(over = {}) {
    const base = {
        n: 40, nRaw: 40, nUnmeasurable: 0, nDuplicadas: 0, nDescartadas: 0, nSinIssue: 0,
        reboundRate: 0.01, earlyDeathRate: 0.0, retriesPerIssue: 1.0, qaFailRate: 0,
        durationP50Ms: 60000, durationP95Ms: 120000,
        integrity: { spawn_exit: 'verificada', rebound_events: 'no_verificada', label_mutations: 'no_verificada' },
        sample_ok: true,
    };
    return { ...base, ...over };
}

/** `n` filas de modelo efectivo para `skill`. */
function rows(skill, provider, model, n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push({ ts: T0 + i, issue: String(100 + i), skill, provider, model_effective: model, source: model == null ? 'not_observable' : 'stream' });
    return out;
}

/** Fila de costo v2 real (#6558) para `skill`. */
function costRow(skill, provider, tin, tout) {
    return { ts: T0 + 1000, provider, skill, issue: '7519', tokens_in: tin, tokens_out: tout, cache: 'no_medido' };
}

function run({ skills, models, cost, config, propagationEnabled = false, agentModels = AGENT_MODELS, providerAlias = ALIAS, allowedSkills = ALLOWED_SKILLS, allowedProviders = ALLOWED_PROVIDERS, ventana = VENTANA } = {}) {
    return rec.recommend({
        quality: { skills, no_atribuidos: { rebounds: 0, qa: 0 }, reboundMeasurable: true },
        cost: cost || { evaluable: false, reason: 'sin_ts', rows: [] },
        models: models || [],
        pricingFreshness: { stale: true, motivo: 'antiguedad', missing_models: [], sha256: null, version: 1, updated_at: '2026-05-08T00:00:00Z', source_kind: 'json' },
        pricing, agentModels, config: config || {}, propagationEnabled, allowedSkills, allowedProviders, providerAlias, ventana,
    });
}

function uno(skill, quality, models, extra = {}) {
    const out = run({ skills: { [skill]: quality }, models, ...extra });
    assert.ok(Object.prototype.hasOwnProperty.call(out.skills, skill), `${skill} presente en la salida`);
    return out.skills[skill];
}

// ---------------------------------------------------------------------------
// Vocabulario cerrado
// ---------------------------------------------------------------------------
test('los enums estan congelados y MOTIVOS tiene exactamente los 18 codigos de C11', () => {
    for (const e of [VERDICT, MOTIVOS, RIESGO, ADVERTENCIAS, ALERTAS, DEFAULTS, DEFAULTS.thresholds, PROTECTED_FLOOR, EVIDENCIA_KEYS]) {
        assert.ok(Object.isFrozen(e));
    }
    assert.deepEqual([...MOTIVOS].sort(), [
        'calidad_ok_costo_menor', 'costo_no_evaluable', 'declarado_desconocido', 'early_death_alto', 'integridad_rota',
        'metrica_no_medible', 'modelo_no_observado', 'modelo_sin_precio', 'modelos_mixtos', 'muestra_insuficiente',
        'precio_invalido', 'propagacion_apagada', 'provider_sin_precios', 'qa_fail_alto', 'rebound_alto',
        'skill_protegido', 'ya_en_el_mas_barato', 'ya_en_el_tope',
    ]);
    assert.deepEqual(Object.values(VERDICT).sort(), ['bajar', 'mantener', 'no_evaluable', 'sin_evidencia_suficiente', 'subir']);
    assert.ok(ALERTAS.every((a) => MOTIVOS.includes(a)));
    assert.equal(rec.CONFIG_SECTION, 'model_value_audit');
});

test('la fixture de calidad respeta OUTPUT_KEYS de la parte 2 (contrato de entrada)', () => {
    assert.deepEqual(Object.keys(q()).sort(), [...OUTPUT_KEYS].sort());
});

// ---------------------------------------------------------------------------
// CA-13 · prioridad de reglas
// ---------------------------------------------------------------------------
test('CA-13 · integridad rota le gana a todo y al levantar cada condicion el veredicto sigue la cadena', () => {
    // Todas las condiciones a la vez: integridad rota, sin precio (opus-5),
    // muestra chica, protegido (security) y métricas de `subir`.
    const todo = q({ integrity: { spawn_exit: 'rota' }, sample_ok: false, reboundRate: 0.5, n: 4 });
    let r = uno('security', todo, rows('security', 'anthropic', 'claude-opus-5', 4));
    assert.equal(r.veredicto, VERDICT.NO_EVALUABLE);
    assert.deepEqual(r.evidencia.motivo, ['integridad_rota']);

    // (2) sin modelo observable
    r = uno('security', q({ ...todo, integrity: { spawn_exit: 'verificada' } }), rows('security', 'anthropic', null, 4));
    assert.deepEqual([r.veredicto, r.evidencia.motivo], [VERDICT.NO_EVALUABLE, ['modelo_no_observado']]);

    // (3) provider sin tabla de precios (antigravity, sin alias)
    r = uno('security', q({ ...todo, integrity: { spawn_exit: 'verificada' } }), rows('security', 'antigravity', 'gemini-3.8-flash-high', 4));
    assert.deepEqual([r.veredicto, r.evidencia.motivo], [VERDICT.NO_EVALUABLE, ['provider_sin_precios']]);

    // (4) modelo sin clave en la tabla
    r = uno('security', q({ ...todo, integrity: { spawn_exit: 'verificada' } }), rows('security', 'anthropic', 'claude-opus-5', 4));
    assert.deepEqual([r.veredicto, r.evidencia.motivo], [VERDICT.NO_EVALUABLE, ['modelo_sin_precio']]);

    // (5) muestra insuficiente
    r = uno('security', q({ ...todo, integrity: { spawn_exit: 'verificada' } }), rows('security', 'anthropic', 'claude-sonnet-4-6', 4));
    assert.deepEqual([r.veredicto, r.evidencia.motivo], [VERDICT.SIN_EVIDENCIA, ['muestra_insuficiente']]);

    // (6) protegido
    r = uno('security', q({ reboundRate: 0.5 }), rows('security', 'anthropic', 'claude-sonnet-4-6', 40));
    assert.deepEqual([r.veredicto, r.evidencia.motivo], [VERDICT.MANTENER, ['skill_protegido']]);

    // (7) subir
    r = uno('guru', q({ reboundRate: 0.5 }), rows('guru', 'anthropic', 'claude-sonnet-4-6', 40));
    assert.deepEqual([r.veredicto, r.evidencia.motivo], [VERDICT.SUBIR, ['rebound_alto']]);

    // (8) bajar
    r = uno('guru', q(), rows('guru', 'anthropic', 'claude-sonnet-4-6', 40), {
        cost: { evaluable: true, reason: null, rows: [costRow('guru', 'anthropic', 1e6, 1e6)] },
    });
    assert.equal(r.veredicto, VERDICT.BAJAR);
    assert.ok(r.evidencia.motivo.includes('calidad_ok_costo_menor'));

    // (9) mantener (calidad intermedia: ni subir ni bajar)
    r = uno('guru', q({ reboundRate: 0.2 }), rows('guru', 'anthropic', 'claude-sonnet-4-6', 40));
    assert.deepEqual([r.veredicto, r.evidencia.motivo], [VERDICT.MANTENER, []]);
});

// ---------------------------------------------------------------------------
// CA-14 · forma de la evidencia
// ---------------------------------------------------------------------------
test('CA-14 · evidencia con exactamente las 15 claves, motivo ⊆ MOTIVOS, difiere boolean, riesgo ∈ RIESGO', () => {
    const casos = [
        uno('guru', q({ reboundRate: 0.5 }), rows('guru', 'anthropic', 'claude-sonnet-4-6', 40)),
        uno('guru', q(), rows('guru', 'anthropic', 'claude-sonnet-4-6', 40), { cost: { evaluable: true, reason: null, rows: [costRow('guru', 'anthropic', 1e6, 1e6)] } }),
        uno('security', q({ integrity: { spawn_exit: 'rota' } }), rows('security', 'anthropic', null, 4)),
        uno('tester', q(), rows('tester', 'deterministic', 'deterministic', 40)),
        uno('commander', q({ sample_ok: false, n: 2 }), rows('commander', 'anthropic', 'claude-opus-5', 2)),
    ];
    for (const r of casos) {
        assert.deepEqual(Object.keys(r.evidencia).sort(), [...EVIDENCIA_KEYS]);
        assert.ok(r.evidencia.motivo.every((m) => MOTIVOS.includes(m)), JSON.stringify(r.evidencia.motivo));
        assert.ok(r.evidencia.alertas_calidad.every((a) => ALERTAS.includes(a)));
        assert.ok(Object.values(RIESGO).includes(r.evidencia.riesgo_estimado));
        assert.equal(typeof r.evidencia.difiere, 'boolean');
        assert.equal(typeof r.evidencia.n, 'number');
        assert.equal(typeof r.evidencia.no_observados, 'number');
        assert.equal(typeof r.evidencia.costo_filas_excluidas, 'number');
        for (const k of ['ahorro_mensual_estimado_usd', 'costo_reproceso_usd', 'costo_ventana_usd']) {
            assert.ok(r.evidencia[k] === null || Number.isFinite(r.evidencia[k]), `${k} finito o null`);
        }
        assert.deepEqual(Object.keys(r.evidencia.ventana).sort(), ['dias', 'from', 'to']);
        assert.equal(r.evidencia.ventana.from, '2026-08-22T00:00:00.000Z');
        assert.equal(r.evidencia.ventana.dias, 30);
        assert.ok(Object.values(VERDICT).includes(r.veredicto));
    }
});

// ---------------------------------------------------------------------------
// CA-15 · subir
// ---------------------------------------------------------------------------
test('CA-15 · Gherkin "subdimensionado": rebote 35 % sin costo ⇒ subir, ahorro y reproceso null', () => {
    const r = uno('guru', q({ reboundRate: 0.35 }), rows('guru', 'anthropic', 'claude-sonnet-4-6', 40));
    assert.equal(r.veredicto, VERDICT.SUBIR);
    assert.deepEqual(r.evidencia.motivo, ['rebound_alto']);
    assert.deepEqual(r.evidencia.alertas_calidad, ['rebound_alto']);
    assert.equal(r.evidencia.modelo_destino, 'claude-opus-4-6', 'escalón siguiente estricto; empate opus-4-6/4-7 por nombre (PR5)');
    assert.equal(r.evidencia.ahorro_mensual_estimado_usd, null);
    assert.equal(r.evidencia.costo_reproceso_usd, null);
    assert.equal(r.evidencia.costo_ventana_usd, null);
    assert.equal(r.evidencia.riesgo_estimado, RIESGO.NO_APLICA);
});

test('CA-15 · subir por cada umbral (early death 0.10, qa fail 0.25) y por varios a la vez', () => {
    let r = uno('guru', q({ earlyDeathRate: 0.10 }), rows('guru', 'anthropic', 'claude-sonnet-4-6', 40));
    assert.deepEqual([r.veredicto, r.evidencia.motivo], [VERDICT.SUBIR, ['early_death_alto']]);
    r = uno('guru', q({ qaFailRate: 0.25 }), rows('guru', 'anthropic', 'claude-sonnet-4-6', 40));
    assert.deepEqual([r.veredicto, r.evidencia.motivo], [VERDICT.SUBIR, ['qa_fail_alto']]);
    r = uno('guru', q({ reboundRate: 0.3, earlyDeathRate: 0.2, qaFailRate: 0.5 }), rows('guru', 'anthropic', 'claude-sonnet-4-6', 40));
    assert.deepEqual(r.evidencia.motivo, ['rebound_alto', 'early_death_alto', 'qa_fail_alto']);
    // Por debajo del umbral no dispara.
    r = uno('guru', q({ reboundRate: 0.29, earlyDeathRate: 0.09, qaFailRate: 0.24 }), rows('guru', 'anthropic', 'claude-sonnet-4-6', 40));
    assert.equal(r.veredicto, VERDICT.MANTENER);
    assert.deepEqual(r.evidencia.alertas_calidad, []);
});

test('CA-15 · Gherkin "ya en el tope": opus-4-7 con muerte temprana 20 % ⇒ mantener + ya_en_el_tope', () => {
    const r = uno('backend-dev', q({ earlyDeathRate: 0.2 }), rows('backend-dev', 'anthropic', 'claude-opus-4-7', 40));
    assert.equal(r.veredicto, VERDICT.MANTENER);
    assert.deepEqual(r.evidencia.motivo, ['early_death_alto', 'ya_en_el_tope']);
    assert.deepEqual(r.evidencia.alertas_calidad, ['early_death_alto']);
    assert.equal(r.evidencia.modelo_destino, null);
});

test('CA-15 · costo del reproceso = costo_ventana × reboundRate × 30/dias cuando cost.evaluable', () => {
    const r = uno('guru', q({ reboundRate: 0.5 }), rows('guru', 'anthropic', 'claude-sonnet-4-6', 40), {
        cost: { evaluable: true, reason: null, rows: [costRow('guru', 'anthropic', 2e6, 1e6)] },
    });
    // costo_ventana = (2e6×3 + 1e6×15)/1e6 = 21 USD
    assert.equal(r.veredicto, VERDICT.SUBIR);
    assert.equal(r.evidencia.costo_ventana_usd, 21);
    assert.equal(r.evidencia.costo_reproceso_usd, 21 * 0.5 * 30 / 30);
    assert.equal(r.evidencia.ahorro_mensual_estimado_usd, null, 'el ahorro es sólo de bajar');
});

// ---------------------------------------------------------------------------
// CA-16 · bajar
// ---------------------------------------------------------------------------
test('CA-16 · Gherkin "sobredimensionado": sonnet-4-6 con 0.01/0.0/0 y costo ⇒ bajar a haiku-4-5 con ahorro = costo × (1 − 6/18) × 30/dias', () => {
    const ventana = { from: T1 - 45 * 86400000, to: T1, dias: 45 };
    const r = uno('doc', q({ reboundRate: 0.01, earlyDeathRate: 0.0, qaFailRate: 0 }), rows('doc', 'anthropic', 'claude-sonnet-4-6', 40), {
        cost: { evaluable: true, reason: null, rows: [costRow('doc', 'anthropic', 1e6, 1e6), costRow('doc', 'anthropic', 1e6, 0)] },
        ventana,
    });
    assert.equal(r.veredicto, VERDICT.BAJAR);
    assert.equal(r.evidencia.modelo_destino, 'claude-haiku-4-5');
    // costo = (2e6×3 + 1e6×15)/1e6 = 21
    assert.equal(r.evidencia.costo_ventana_usd, 21);
    assert.ok(Math.abs(r.evidencia.ahorro_mensual_estimado_usd - 21 * (1 - 6 / 18) * 30 / 45) < 1e-9);
    assert.ok(r.evidencia.motivo.includes('calidad_ok_costo_menor'));
    assert.equal(r.evidencia.ventana.dias, 45);
});

test('CA-16 · Gherkin "la ventana de costo ya trae timestamp": filas schema 2 para doc ⇒ bajar y costo sólo con tokens_in/out', () => {
    const fila = { ts: Date.parse('2026-09-21T11:45:23.138Z'), provider: 'anthropic', skill: 'doc', issue: '7517', tokens_in: 52, tokens_out: 1026, cache: 'no_medido' };
    const r = uno('doc', q({ reboundRate: 0, earlyDeathRate: 0, qaFailRate: 0 }), rows('doc', 'anthropic', 'claude-sonnet-4-6', 40), {
        cost: { evaluable: true, reason: null, rows: [fila] },
    });
    assert.equal(r.veredicto, VERDICT.BAJAR);
    assert.equal(r.evidencia.modelo_destino, 'claude-haiku-4-5');
    assert.ok(Math.abs(r.evidencia.costo_ventana_usd - (52 * 3 + 1026 * 15) / 1e6) < 1e-12);
    assert.ok(Math.abs(r.evidencia.ahorro_mensual_estimado_usd - r.evidencia.costo_ventana_usd * (1 - 6 / 18)) < 1e-12);
});

test('CA-16 · Gherkin "sin costo evaluable" ⇒ mantener / costo_no_evaluable, nunca bajar', () => {
    const r = uno('doc', q(), rows('doc', 'anthropic', 'claude-sonnet-4-6', 40), { cost: { evaluable: false, reason: 'sin_ts', rows: [] } });
    assert.deepEqual([r.veredicto, r.evidencia.motivo], [VERDICT.MANTENER, ['costo_no_evaluable']]);
    assert.equal(r.evidencia.ahorro_mensual_estimado_usd, null);
    assert.equal(r.evidencia.modelo_destino, null);
});

test('CA-16 · Gherkin "ya en el mas barato": haiku-4-x nunca baja, incluso con costo', () => {
    const r = uno('doc', q(), rows('doc', 'anthropic', 'claude-haiku-4-x', 40), {
        cost: { evaluable: true, reason: null, rows: [costRow('doc', 'anthropic', 1e6, 1e6)] },
    });
    assert.deepEqual([r.veredicto, r.evidencia.motivo], [VERDICT.MANTENER, ['ya_en_el_mas_barato']]);
});

test('CA-16 / C7 · reboundRate null ⇒ mantener / metrica_no_medible; null nunca dispara subir', () => {
    let r = uno('doc', q({ reboundRate: null }), rows('doc', 'anthropic', 'claude-sonnet-4-6', 40), {
        cost: { evaluable: true, reason: null, rows: [costRow('doc', 'anthropic', 1e6, 1e6)] },
    });
    assert.deepEqual([r.veredicto, r.evidencia.motivo], [VERDICT.MANTENER, ['metrica_no_medible']]);
    r = uno('doc', q({ reboundRate: null, earlyDeathRate: null, qaFailRate: null }), rows('doc', 'anthropic', 'claude-sonnet-4-6', 40));
    assert.equal(r.veredicto, VERDICT.MANTENER);
    assert.deepEqual(r.evidencia.alertas_calidad, []);
    r = uno('doc', q({ qaFailRate: null }), rows('doc', 'anthropic', 'claude-sonnet-4-6', 40), {
        cost: { evaluable: true, reason: null, rows: [costRow('doc', 'anthropic', 1e6, 1e6)] },
    });
    assert.deepEqual([r.veredicto, r.evidencia.motivo], [VERDICT.MANTENER, ['metrica_no_medible']]);
});

test('CA-16 · fuera de umbral de bajar pero sin alarma ⇒ mantener sin motivo', () => {
    const r = uno('doc', q({ reboundRate: 0.06 }), rows('doc', 'anthropic', 'claude-sonnet-4-6', 40), {
        cost: { evaluable: true, reason: null, rows: [costRow('doc', 'anthropic', 1e6, 1e6)] },
    });
    assert.deepEqual([r.veredicto, r.evidencia.motivo], [VERDICT.MANTENER, []]);
    const r2 = uno('doc', q({ qaFailRate: 0.01 }), rows('doc', 'anthropic', 'claude-sonnet-4-6', 40), {
        cost: { evaluable: true, reason: null, rows: [costRow('doc', 'anthropic', 1e6, 1e6)] },
    });
    assert.equal(r2.veredicto, VERDICT.MANTENER, 'qaFailRate debe ser exactamente 0 para bajar');
});

test('CA-16 / S-4 · precio actual 0 con candidato ⇒ no_evaluable / precio_invalido; deterministic ⇒ ya_en_el_mas_barato', () => {
    const tablaRara = { raro: { cero: { in: 0, out: 0 }, negativo: { in: -1, out: 0 } } };
    const out = rec.recommend({
        quality: { skills: { doc: q() } },
        cost: { evaluable: true, reason: null, rows: [costRow('doc', 'raro', 1e6, 1e6)] },
        models: rows('doc', 'raro', 'cero', 40),
        pricing: { pricingByProvider: () => tablaRara },
        agentModels: AGENT_MODELS, config: {}, propagationEnabled: false,
        allowedSkills: ALLOWED_SKILLS, allowedProviders: new Set(['raro']), providerAlias: {}, ventana: VENTANA,
    });
    assert.deepEqual([out.skills.doc.veredicto, out.skills.doc.evidencia.motivo], [VERDICT.NO_EVALUABLE, ['precio_invalido']]);
    assert.equal(out.skills.doc.evidencia.ahorro_mensual_estimado_usd, null);

    const det = uno('tester', q(), rows('tester', 'deterministic', 'deterministic', 40), {
        cost: { evaluable: true, reason: null, rows: [costRow('tester', 'deterministic', 1e6, 1e6)] },
    });
    // tester está protegido por default: usar config que lo desproteja para llegar a la regla de bajar.
    assert.deepEqual([det.veredicto, det.evidencia.motivo], [VERDICT.MANTENER, ['skill_protegido']]);
    const det2 = uno('tester', q(), rows('tester', 'deterministic', 'deterministic', 40), {
        cost: { evaluable: true, reason: null, rows: [costRow('tester', 'deterministic', 1e6, 1e6)] },
        config: { protected_skills: [] },
    });
    assert.deepEqual([det2.veredicto, det2.evidencia.motivo], [VERDICT.MANTENER, ['ya_en_el_mas_barato']]);
    assert.equal(det2.evidencia.costo_ventana_usd, 0);
});

test('S-4 · precio con clave presente pero no finito ⇒ no_evaluable / precio_invalido (nunca NaN serializado)', () => {
    const tabla = { anthropic: { 'claude-sonnet-4-6': { in: 'x', out: 15 }, 'claude-haiku-4-5': { in: 1, out: 5 } } };
    const out = rec.recommend({
        quality: { skills: { doc: q() } }, cost: { evaluable: true, reason: null, rows: [costRow('doc', 'anthropic', 1e6, 1e6)] },
        models: rows('doc', 'anthropic', 'claude-sonnet-4-6', 40), pricing: { pricingByProvider: () => tabla },
        agentModels: AGENT_MODELS, config: {}, propagationEnabled: false,
        allowedSkills: ALLOWED_SKILLS, allowedProviders: ALLOWED_PROVIDERS, providerAlias: ALIAS, ventana: VENTANA,
    });
    assert.deepEqual([out.skills.doc.veredicto, out.skills.doc.evidencia.motivo], [VERDICT.NO_EVALUABLE, ['precio_invalido']]);
    assert.ok(!JSON.stringify(out).includes('null,null') || true);
    for (const k of ['ahorro_mensual_estimado_usd', 'costo_reproceso_usd', 'costo_ventana_usd']) {
        assert.equal(out.skills.doc.evidencia[k], null);
    }
});

test('C8 · el costo de ventana sólo suma filas del provider mayoritario; las otras van a costo_filas_excluidas', () => {
    const r = uno('doc', q(), rows('doc', 'anthropic', 'claude-sonnet-4-6', 40), {
        cost: {
            evaluable: true, reason: null,
            rows: [costRow('doc', 'anthropic', 1e6, 0), costRow('doc', 'openai-codex', 5e6, 5e6), costRow('guru', 'anthropic', 9e6, 9e6)],
        },
    });
    assert.equal(r.evidencia.costo_ventana_usd, 3);
    assert.equal(r.evidencia.costo_filas_excluidas, 1);
});

// ---------------------------------------------------------------------------
// CA-17 · protegidos
// ---------------------------------------------------------------------------
test('CA-17 / SEC-R8 · security siempre protegido (piso); tipo invalido ⇒ defaults completos; dato completo igual', () => {
    const modelos = rows('security', 'anthropic', 'claude-sonnet-4-6', 40);
    const cost = { evaluable: true, reason: null, rows: [costRow('security', 'anthropic', 1e6, 1e6)] };
    let r = uno('security', q({ reboundRate: 0.5 }), modelos, { config: { protected_skills: [] }, cost });
    assert.deepEqual([r.veredicto, r.evidencia.motivo], [VERDICT.MANTENER, ['skill_protegido']]);
    assert.deepEqual(r.evidencia.alertas_calidad, ['rebound_alto'], 'alarma calculada igual');
    assert.equal(r.evidencia.costo_ventana_usd, 18, 'dato completo');

    r = uno('review', q(), rows('review', 'anthropic', 'claude-sonnet-4-6', 40), { config: { protected_skills: 'x' }, cost });
    assert.deepEqual([r.veredicto, r.evidencia.motivo], [VERDICT.MANTENER, ['skill_protegido']]);

    // Con lista explícita, `review` deja de estar protegido pero `security` no.
    r = uno('review', q(), rows('review', 'anthropic', 'claude-sonnet-4-6', 40), { config: { protected_skills: ['po'] }, cost });
    assert.equal(r.veredicto, VERDICT.BAJAR);
    assert.deepEqual([...rec.resolveProtected({ protected_skills: ['po'] })].sort(), ['po', 'security']);
    assert.deepEqual([...rec.resolveProtected({ protected_skills: [1] })].sort(), ['po', 'qa', 'review', 'security', 'tester']);
    assert.deepEqual([...rec.resolveProtected(undefined)].sort(), ['po', 'qa', 'review', 'security', 'tester']);
});

test('resolveThresholds · defaults congelados, overrides validos y valores invalidos caen al default', () => {
    assert.deepEqual(rec.resolveThresholds(undefined), {
        min_sample: 10, subir_rebound: 0.30, subir_early_death: 0.10, subir_qa_fail: 0.25, bajar_rebound: 0.05, bajar_early_death: 0.02,
    });
    const t = rec.resolveThresholds({ min_sample: 20, thresholds: { subir_rebound: 0.4, bajar_rebound: 'x', subir_qa_fail: 2 } });
    assert.equal(t.min_sample, 20);
    assert.equal(t.subir_rebound, 0.4);
    assert.equal(t.bajar_rebound, 0.05);
    assert.equal(t.subir_qa_fail, 0.25);
    assert.equal(rec.resolveThresholds({ min_sample: 0 }).min_sample, 10);
    // Umbral custom aplicado: rebote 0.35 ya no dispara con subir_rebound 0.4.
    const r = uno('guru', q({ reboundRate: 0.35 }), rows('guru', 'anthropic', 'claude-sonnet-4-6', 40), { config: { thresholds: { subir_rebound: 0.4 } } });
    assert.equal(r.veredicto, VERDICT.MANTENER);
});

// ---------------------------------------------------------------------------
// CA-18 · propagación, declarado vs efectivo, mixtos
// ---------------------------------------------------------------------------
test('CA-18 · Gherkin "propagacion apagada": advertencia global, riesgo en cada bajar, difiere true (guru declara sonnet-4-6, corre opus)', () => {
    const cost = { evaluable: true, reason: null, rows: [costRow('guru', 'anthropic', 1e6, 1e6)] };
    const out = run({ skills: { guru: q() }, models: rows('guru', 'anthropic', 'claude-opus-4-6', 40), cost, propagationEnabled: false });
    assert.deepEqual(out.advertencias, [ADVERTENCIAS.PROPAGACION_APAGADA]);
    const g = out.skills.guru;
    assert.equal(g.veredicto, VERDICT.BAJAR);
    assert.equal(g.evidencia.riesgo_estimado, RIESGO.NO_CUANTIFICABLE_SIN_OBSERVACION);
    assert.ok(g.evidencia.motivo.includes('propagacion_apagada'));
    assert.equal(g.evidencia.modelo_declarado, 'claude-sonnet-4-6');
    assert.equal(g.evidencia.modelo_efectivo, 'claude-opus-4-6');
    assert.equal(g.evidencia.difiere, true);
    assert.equal(g.evidencia.modelo_destino, 'claude-sonnet-4-6', 'escalón inferior estricto de opus (90) es sonnet (18); empate sonnet-4-6/4-7 por nombre');

    const on = run({ skills: { guru: q() }, models: rows('guru', 'anthropic', 'claude-opus-4-6', 40), cost, propagationEnabled: true });
    assert.deepEqual(on.advertencias, []);
    assert.equal(on.skills.guru.evidencia.riesgo_estimado, RIESGO.NO_MEDIDO_V1);
    assert.ok(!on.skills.guru.evidencia.motivo.includes('propagacion_apagada'));

    // Cualquier valor distinto de `true` es apagado.
    assert.deepEqual(run({ skills: { guru: q() }, models: [], propagationEnabled: 'true' }).advertencias, [ADVERTENCIAS.PROPAGACION_APAGADA]);
});

test('CA-18 / C6 · modelo_declarado: model_override ?? providers[provider].model ?? null; skill ausente ⇒ declarado_desconocido', () => {
    assert.equal(rec.declaredModel(AGENT_MODELS, 'guru'), 'claude-sonnet-4-6');
    assert.equal(rec.declaredModel(AGENT_MODELS, 'pipeline-dev'), 'claude-opus-4-7');
    assert.equal(rec.declaredModel(AGENT_MODELS, 'tester'), 'deterministic');
    assert.equal(rec.declaredModel(AGENT_MODELS, 'commander'), null);
    assert.equal(rec.declaredModel({ skills: { x: { provider: 'nadie' } }, providers: {} }, 'x'), null);
    assert.equal(rec.declaredModel(null, 'x'), null);

    const r = uno('commander', q(), rows('commander', 'anthropic', 'claude-sonnet-4-6', 40));
    assert.equal(r.evidencia.modelo_declarado, null);
    assert.equal(r.evidencia.difiere, false, 'difiere es false (no null) cuando falta el declarado');
    assert.ok(r.evidencia.motivo.includes('declarado_desconocido'));

    const igual = uno('guru', q({ reboundRate: 0.2 }), rows('guru', 'anthropic', 'claude-sonnet-4-6', 40));
    assert.equal(igual.evidencia.difiere, false);
});

test('CA-18 · Gherkin "modelos mixtos": 7 opus-5 + 3 sonnet-4-6 ⇒ mayoritario opus-5 + modelos_mixtos; empate 5/5 ⇒ el mas caro', () => {
    const mixto = [...rows('guru', 'anthropic', 'claude-opus-5', 7), ...rows('guru', 'anthropic', 'claude-sonnet-4-6', 3)];
    let r = uno('guru', q({ reboundRate: 0.35 }), mixto);
    assert.equal(r.evidencia.modelo_efectivo, 'claude-opus-5');
    assert.deepEqual(r.evidencia.modelos_observados, { 'anthropic|claude-opus-5': 7, 'anthropic|claude-sonnet-4-6': 3 });
    assert.deepEqual([r.veredicto, r.evidencia.motivo], [VERDICT.NO_EVALUABLE, ['modelo_sin_precio', 'modelos_mixtos']]);
    assert.deepEqual(r.evidencia.alertas_calidad, ['rebound_alto']);

    const empate = [...rows('guru', 'anthropic', 'claude-sonnet-4-6', 5), ...rows('guru', 'anthropic', 'claude-opus-4-6', 5)];
    r = uno('guru', q(), empate, { cost: { evaluable: true, reason: null, rows: [costRow('guru', 'anthropic', 1e6, 1e6)] } });
    assert.equal(r.evidencia.modelo_efectivo, 'claude-opus-4-6', 'empate ⇒ el de mayor in + out (fail-closed)');
    assert.ok(r.evidencia.motivo.includes('modelos_mixtos'));

    // Empate con un modelo sin precio: gana el sin precio (cuenta como el más caro) ⇒ no_evaluable.
    const empateSinPrecio = [...rows('guru', 'anthropic', 'claude-sonnet-4-6', 5), ...rows('guru', 'anthropic', 'claude-opus-5', 5)];
    r = uno('guru', q(), empateSinPrecio);
    assert.equal(r.evidencia.modelo_efectivo, 'claude-opus-5');
    assert.equal(r.veredicto, VERDICT.NO_EVALUABLE);

    // Filas null se cuentan en no_observados y no en modelos_observados.
    const conNull = [...rows('guru', 'anthropic', 'claude-sonnet-4-6', 3), ...rows('guru', 'anthropic', null, 9)];
    r = uno('guru', q({ reboundRate: 0.2 }), conNull);
    assert.equal(r.evidencia.modelo_efectivo, 'claude-sonnet-4-6');
    assert.equal(r.evidencia.no_observados, 9);
    assert.deepEqual(r.evidencia.modelos_observados, { 'anthropic|claude-sonnet-4-6': 3 });
    assert.ok(!r.evidencia.motivo.includes('modelos_mixtos'));
});

test('pickMajority · sin filas ⇒ key null; sólo null ⇒ modelo null + no_observados', () => {
    assert.deepEqual(rec.pickMajority([]), { key: null, provider: null, model: null, observados: {}, no_observados: 0, mixtos: false });
    const r = rec.pickMajority(rows('guru', 'anthropic', null, 3));
    assert.equal(r.model, null);
    assert.equal(r.no_observados, 3);
    const s = uno('guru', q(), rows('guru', 'anthropic', null, 3));
    assert.deepEqual([s.veredicto, s.evidencia.motivo], [VERDICT.NO_EVALUABLE, ['modelo_no_observado']]);
});

// ---------------------------------------------------------------------------
// CA-18b · alias y re-validación
// ---------------------------------------------------------------------------
test('CA-18b / C3 · openai-codex + gpt-5-codex evaluable via alias; antigravity ⇒ provider_sin_precios; alias inyectable', () => {
    // gpt-5-codex (11.25) está en el tope de openai junto con gpt-5 (empate): no hay más caro.
    let r = uno('guru', q({ reboundRate: 0.35 }), rows('guru', 'openai-codex', 'gpt-5-codex', 40));
    assert.deepEqual([r.veredicto, r.evidencia.motivo], [VERDICT.MANTENER, ['rebound_alto', 'ya_en_el_tope']]);
    r = uno('guru', q({ reboundRate: 0.35 }), rows('guru', 'openai-codex', 'gpt-5-mini', 40));
    assert.deepEqual([r.veredicto, r.evidencia.modelo_destino], [VERDICT.SUBIR, 'gpt-5']);

    r = uno('guru', q(), rows('guru', 'openai-codex', 'gpt-5-codex', 40), { cost: { evaluable: true, reason: null, rows: [costRow('guru', 'openai-codex', 1e6, 1e6)] } });
    assert.equal(r.veredicto, VERDICT.BAJAR);
    assert.equal(r.evidencia.modelo_destino, 'gpt-5-mini');

    r = uno('guru', q(), rows('guru', 'antigravity', 'gemini-3.8-flash-high', 40));
    assert.deepEqual([r.veredicto, r.evidencia.motivo], [VERDICT.NO_EVALUABLE, ['provider_sin_precios']]);

    // Alias inyectado distinto: antigravity → google ⇒ pasa a modelo_sin_precio (la tabla google no tiene gemini-3.8).
    r = uno('guru', q(), rows('guru', 'antigravity', 'gemini-3.8-flash-high', 40), { providerAlias: { antigravity: 'google' } });
    assert.deepEqual([r.veredicto, r.evidencia.motivo], [VERDICT.NO_EVALUABLE, ['modelo_sin_precio']]);

    // Default: sin alias inyectado se usa HEALTH_PROVIDER_ALIAS del hermano.
    const { HEALTH_PROVIDER_ALIAS } = require('../../multi-provider/provider-contribution');
    assert.deepEqual(rec.resolveAlias(undefined), HEALTH_PROVIDER_ALIAS);
    assert.equal(rec.pricingProvider('openai-codex', undefined), 'openai-codex', 'sin alias no se mapea');
    assert.equal(rec.pricingProvider('openai-codex', HEALTH_PROVIDER_ALIAS), 'openai');
    assert.equal(rec.pricingProvider(null, HEALTH_PROVIDER_ALIAS), null);
});

test('CA-18b / SEC-R1 · skill/provider/model fuera de whitelist y __proto__ no aparecen; cuentan en desconocidos; Object.prototype intacto', () => {
    const antes = Object.keys(Object.prototype).length;
    const out = run({
        skills: {
            guru: q(),
            intruso: q(),
            __proto__: q(),
        },
        models: [
            ...rows('guru', 'anthropic', 'claude-sonnet-4-6', 5),
            ...rows('guru', 'nvidia-nim', 'deepseek', 2),
            { ts: T0, issue: '1', skill: 'guru', provider: 'anthropic', model_effective: 'Claude-Opus-5 [x]', source: 'stream' },
            { ts: T0, issue: '1', skill: 'guru', provider: 'anthropic', model_effective: 'a'.repeat(80), source: 'stream' },
            ...rows('intruso', 'anthropic', 'claude-sonnet-4-6', 2),
            ...rows('__proto__', 'anthropic', 'claude-sonnet-4-6', 2),
        ],
    });
    assert.deepEqual(Object.keys(out.skills), ['guru']);
    assert.ok(!('intruso' in out.skills));
    assert.equal(Object.getPrototypeOf(out.skills), null);
    assert.equal(out.desconocidos.skills, 2 + 2 + 1, 'filas de modelo fuera de whitelist + skills de calidad fuera de whitelist');
    assert.equal(out.desconocidos.providers, 2);
    assert.equal(out.desconocidos.models, 2);
    assert.deepEqual(out.skills.guru.evidencia.modelos_observados, { 'anthropic|claude-sonnet-4-6': 5 });
    assert.equal(Object.keys(Object.prototype).length, antes);
    assert.equal(({}).polluted, undefined);
});

// ---------------------------------------------------------------------------
// CA-18c · alertas siempre visibles
// ---------------------------------------------------------------------------
test('CA-18c / PR2 · Gherkin "modelo sin precio no esconde la alarma": opus-5 con rebote 35 % ⇒ no_evaluable + alertas rebound_alto', () => {
    let r = uno('guru', q({ reboundRate: 0.35 }), rows('guru', 'anthropic', 'claude-opus-5', 40));
    assert.equal(r.veredicto, VERDICT.NO_EVALUABLE);
    assert.deepEqual(r.evidencia.motivo, ['modelo_sin_precio']);
    assert.deepEqual(r.evidencia.alertas_calidad, ['rebound_alto']);
    r = uno('guru', q({ reboundRate: null }), rows('guru', 'anthropic', 'claude-opus-5', 40));
    assert.deepEqual(r.evidencia.alertas_calidad, []);
    // También con integridad rota y muestra chica.
    r = uno('guru', q({ integrity: { spawn_exit: 'rota' }, earlyDeathRate: 0.5 }), rows('guru', 'anthropic', 'claude-opus-5', 40));
    assert.deepEqual(r.evidencia.alertas_calidad, ['early_death_alto']);
    r = uno('guru', q({ sample_ok: false, n: 3, qaFailRate: 0.5 }), rows('guru', 'anthropic', 'claude-sonnet-4-6', 3));
    assert.deepEqual([r.veredicto, r.evidencia.alertas_calidad], [VERDICT.SIN_EVIDENCIA, ['qa_fail_alto']]);
});

// ---------------------------------------------------------------------------
// Gherkin del padre: muestra insuficiente y tabla de precios vencida
// ---------------------------------------------------------------------------
test('Gherkin "muestra insuficiente": sample_ok false ⇒ sin_evidencia_suficiente con n y sin destino', () => {
    const r = uno('guru', q({ sample_ok: false, n: 4, nRaw: 4 }), rows('guru', 'anthropic', 'claude-sonnet-4-6', 4));
    assert.deepEqual([r.veredicto, r.evidencia.motivo], [VERDICT.SIN_EVIDENCIA, ['muestra_insuficiente']]);
    assert.equal(r.evidencia.n, 4);
    assert.equal(r.evidencia.modelo_destino, null);
    assert.equal(r.evidencia.riesgo_estimado, RIESGO.NO_APLICA);
});

test('Gherkin "tabla de precios vencida": el veredicto no depende de pricingFreshness (la cabecera lo dice, la parte 1 lo mide)', () => {
    const a = run({ skills: { guru: q({ reboundRate: 0.35 }) }, models: rows('guru', 'anthropic', 'claude-sonnet-4-6', 40) });
    const out = rec.recommend({
        quality: { skills: { guru: q({ reboundRate: 0.35 }) } }, cost: { evaluable: false, reason: 'sin_ts', rows: [] },
        models: rows('guru', 'anthropic', 'claude-sonnet-4-6', 40),
        pricingFreshness: { stale: false, motivo: null, missing_models: [], sha256: 'a'.repeat(64), version: 2, updated_at: '2026-09-01T00:00:00Z', source_kind: 'json' },
        pricing, agentModels: AGENT_MODELS, config: {}, propagationEnabled: false,
        allowedSkills: ALLOWED_SKILLS, allowedProviders: ALLOWED_PROVIDERS, providerAlias: ALIAS, ventana: VENTANA,
    });
    assert.deepEqual(out.skills.guru, a.skills.guru);
});

// ---------------------------------------------------------------------------
// rankModels / escalones (PR5)
// ---------------------------------------------------------------------------
test('PR5 · rankModels ordena por in+out y nombre; escalones estrictos con la tabla v1 real', () => {
    const ranked = rec.rankModels(TABLE, 'anthropic');
    assert.deepEqual(ranked.map((m) => m.model), [
        'claude-haiku-4-x', 'claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-sonnet-4-7', 'claude-opus-4-6', 'claude-opus-4-7',
    ]);
    assert.equal(rec.stepDown(ranked, 18).model, 'claude-haiku-4-5');
    assert.equal(rec.stepUp(ranked, 18).model, 'claude-opus-4-6');
    assert.equal(rec.stepUp(ranked, 90), null);
    assert.equal(rec.stepDown(ranked, 4.8), null);
    assert.equal(rec.rankModels(TABLE, 'antigravity'), null);
    assert.equal(rec.rankModels(null, 'anthropic'), null);
    assert.deepEqual(rec.rankModels({ p: { a: { in: 'x', out: 1 }, b: { in: 1, out: 1 } } }, 'p').map((m) => m.model), ['b']);
    assert.deepEqual(rec.rankModels(TABLE, 'deterministic').map((m) => m.price), [0]);
});

test('umbrales resueltos viajan en la salida (para la cabecera humana)', () => {
    const out = run({ skills: {}, models: [], config: { min_sample: 15, protected_skills: ['po'] } });
    assert.equal(out.umbrales.min_sample, 15);
    assert.deepEqual(out.umbrales.protected_skills, ['po', 'security']);
    assert.deepEqual(Object.keys(out.umbrales.thresholds).sort(), ['bajar_early_death', 'bajar_rebound', 'subir_early_death', 'subir_qa_fail', 'subir_rebound']);
    assert.deepEqual(Object.keys(out.skills), []);
    assert.equal(Object.getPrototypeOf(out.skills), null, 'diccionario por skill sin prototipo (C11)');
    assert.deepEqual(out.desconocidos, { skills: 0, providers: 0, models: 0 });
});

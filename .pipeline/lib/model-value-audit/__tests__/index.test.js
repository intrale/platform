'use strict';

// =============================================================================
// index.test.js — orquestación pura `runAudit` (#7519, CA-I1 / C6 / C10 / C16).
//
// `readSources` y `pricing-freshness` son fakes (leen archivos); `sanitize`,
// `agent-quality-signal`, `recommender` y `report` son los REALES (puros), así
// el test cubre el puente `ts` epoch → ISO entre la parte 1 y la parte 2.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

const { runAudit, MIN_DIAS } = require('..');
const { VERDICT } = require('../recommender');

const NOW = Date.parse('2026-09-21T12:00:00.000Z');
const DAY = 86400000;

const AGENT_MODELS_JSON = JSON.stringify({
    providers: { anthropic: { model: 'claude-opus-4-7' }, 'openai-codex': { model: 'gpt-5.5' }, deterministic: { model: 'deterministic' } },
    skills: { guru: { provider: 'anthropic', model_override: 'claude-sonnet-4-6' }, doc: { provider: 'anthropic', model_override: 'claude-sonnet-4-6' }, security: { provider: 'anthropic', model_override: 'claude-opus-4-7' } },
}, null, 2);

const TABLE = {
    anthropic: { 'claude-opus-4-7': { in: 15, out: 75 }, 'claude-sonnet-4-6': { in: 3, out: 15 }, 'claude-haiku-4-5': { in: 1, out: 5 } },
    openai: { 'gpt-5': { in: 1.25, out: 10 } },
    deterministic: { deterministic: { in: 0, out: 0 } },
};

function config(over = {}) {
    return {
        pipeline: { model_propagation: { enabled: false } },
        pipelines: {
            desarrollo: { skills_por_fase: { dev: ['backend-dev', 'pipeline-dev'], analisis: ['guru', 'security'], verificacion: ['doc', 'tester'] } },
            definicion: { skills_por_fase: { criterios: ['po'] } },
        },
        ...over,
    };
}

function spawn(skill, i, over = {}) {
    return { ts: NOW - (i + 1) * 3600000, skill, issue: String(7000 + i), provider: 'anthropic', exit_code: 0, duration_ms: 60000, death_kind: null, codepath: 'generalized', ...over };
}
function modelRow(skill, i, model = 'claude-sonnet-4-6', provider = 'anthropic') {
    return { ts: NOW - (i + 1) * 3600000, issue: String(7000 + i), skill, provider, model_effective: model, source: model == null ? 'not_observable' : 'stream' };
}
function fuente(rows, extra = {}) {
    return { rows, evaluable: true, integridad: { estado: 'no_verificada', broken: [], skipped: [], files: 1, lines: rows.length, rows: rows.length, sin_ts: 0, sin_issue: 0, filtradas: 0, lineas_corruptas: 0, schema_mismatch: false }, ...extra };
}

function deps(over = {}) {
    const reads = [];
    const root = path.resolve('fixture-7519');
    const fsImpl = {
        readFileSync(p, enc) {
            reads.push(String(p));
            if (String(p) === path.join(root, 'agent-models.json')) return enc ? AGENT_MODELS_JSON : Buffer.from(AGENT_MODELS_JSON, 'utf8');
            throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
        },
        existsSync: () => false,
        statSync: () => { throw new Error('ENOENT'); },
        readdirSync: () => [],
    };
    const pricing = { invalidations: 0, invalidateCache() { this.invalidations++; }, pricingByProvider: () => TABLE, load() {}, pricingMeta: () => ({ version: 1 }) };
    const sourcesCalls = [];
    const sources = over.sources || {
        spawn_exit: fuente([...Array(12).keys()].map((i) => spawn('guru', i)), { integridad: { ...fuente([]).integridad, estado: 'verificada' } }),
        rebound_events: fuente([{ ts: NOW - 3600000, issue: '7000', skill: 'guru', provider: 'anthropic', rechazado_en_fase: 'verificacion' }]),
        effective_model: fuente([...Array(10).keys()].map((i) => modelRow('guru', i)).concat([modelRow('guru', 10, null), modelRow('intruso', 11), modelRow('guru', 12, 'x', 'nvidia-nim')])),
        provider_cost: { rows: [], evaluable: false, reason: 'sin_ts', integridad: fuente([]).integridad },
        label_mutations: fuente([]),
        ventana: {},
    };
    const freshness = { calls: [], evaluate(args) { this.calls.push(args); return { stale: true, motivo: 'antiguedad', missing_models: [], sha256: 'b'.repeat(64), version: 1, updated_at: '2026-05-08T00:00:00Z', source_kind: 'json' }; } };
    const cfg = over.config || config();
    const configResolver = over.configResolver || { calls: [], resolve(args) { this.calls.push(args); return cfg; } };
    return {
        root, reads, fsImpl, pricing, sourcesCalls, freshness, configResolver,
        d: {
            fsImpl, pricing, configResolver, pricingFreshness: freshness, now: () => NOW,
            readSources: (args) => { sourcesCalls.push(args); return sources; },
            reboundSince: '2026-08-01T00:00:00.000Z',
            effectiveModel: { marca: 'fake' },
            providerAlias: { 'openai-codex': 'openai' },
            ...(over.d || {}),
        },
    };
}

test('CA-I1 / SEC-R4 · agent-models.json se lee exactamente una vez con fsImpl y agent_models_sha256 es el sha de esos bytes', () => {
    const f = deps();
    const rep = runAudit({ pipelineDir: 'fixture-7519', dias: 30, deps: f.d });
    const lecturas = f.reads.filter((p) => p === path.join(f.root, 'agent-models.json'));
    assert.equal(lecturas.length, 1);
    assert.equal(rep.agent_models_sha256, crypto.createHash('sha256').update(Buffer.from(AGENT_MODELS_JSON, 'utf8')).digest('hex'));
    assert.equal(f.reads.length, 1, 'ninguna otra lectura por fsImpl desde index');
});

test('CA-I1 · invalidateCache exactamente 1 vez; config-resolver con {pipelineDir: root, reload: true}; hermanos reciben root/from/to/fsImpl y los deps reenviados', () => {
    const f = deps();
    const rep = runAudit({ pipelineDir: 'fixture-7519', dias: 30, deps: f.d });
    assert.equal(f.pricing.invalidations, 1);
    assert.deepEqual(f.configResolver.calls, [{ pipelineDir: f.root, reload: true }]);
    assert.equal(f.sourcesCalls.length, 1);
    const call = f.sourcesCalls[0];
    assert.equal(call.pipelineDir, f.root);
    assert.equal(call.fsImpl, f.fsImpl);
    assert.equal(call.to, NOW);
    assert.equal(call.from, NOW - 30 * DAY);
    assert.deepEqual(call.effectiveModel, { marca: 'fake' });
    assert.equal(f.freshness.calls.length, 1);
    assert.equal(f.freshness.calls[0].pricing, f.pricing);
    assert.equal(f.freshness.calls[0].now, NOW);
    assert.deepEqual(f.freshness.calls[0].observedModels, [{ provider: 'anthropic', model: 'claude-sonnet-4-6', n: 10 }]);
    assert.equal(rep.generado_en, '2026-09-21T12:00:00.000Z');
});

test('CA-I1 · configResolver que lanza ⇒ runAudit lanza con el mismo mensaje y no toca precios ni archivos', () => {
    const f = deps({ configResolver: { resolve() { throw new Error('ConfigSchemaViolation: pipeline.yaml:12'); } } });
    assert.throws(() => runAudit({ pipelineDir: 'fixture-7519', deps: f.d }), /ConfigSchemaViolation: pipeline.yaml:12/);
    assert.equal(f.pricing.invalidations, 0);
    assert.equal(f.reads.length, 0);
});

test('C10 / S-5 · propagationEnabled solo con `true` booleano en config.pipeline.model_propagation.enabled', () => {
    for (const [enabled, esperado] of [[true, true], ['true', false], [1, false], [undefined, false]]) {
        const f = deps({ config: config({ pipeline: { model_propagation: { enabled } } }) });
        const rep = runAudit({ pipelineDir: 'fixture-7519', deps: f.d });
        assert.equal(rep.propagation_enabled, esperado, `enabled=${JSON.stringify(enabled)}`);
        assert.deepEqual(rep.advertencias, esperado ? [] : ['propagacion_apagada']);
    }
    // Raíz `config.model_propagation` (esqueleto viejo del padre) NO cuenta.
    const f = deps({ config: config({ model_propagation: { enabled: true }, pipeline: {} }) });
    assert.equal(runAudit({ pipelineDir: 'fixture-7519', deps: f.d }).propagation_enabled, false);
});

test('CA-I1 · dias 7 ⇒ ventana de 30; --hasta fija el fin al final del dia UTC; hasta invalido lanza', () => {
    let f = deps();
    let rep = runAudit({ pipelineDir: 'fixture-7519', dias: 7, deps: f.d });
    assert.equal(rep.ventana.dias, MIN_DIAS);
    assert.equal(f.sourcesCalls[0].from, NOW - 30 * DAY);
    f = deps();
    rep = runAudit({ pipelineDir: 'fixture-7519', dias: 45, hasta: '2026-09-01', deps: f.d });
    assert.equal(rep.ventana.to, '2026-09-01T23:59:59.999Z');
    assert.equal(rep.ventana.dias, 45);
    assert.equal(Date.parse(rep.ventana.from), Date.parse('2026-09-01T23:59:59.999Z') - 45 * DAY);
    assert.throws(() => runAudit({ pipelineDir: 'fixture-7519', hasta: '2026-13-01', deps: deps().d }), /--hasta invalido/);
    assert.throws(() => runAudit({ deps: deps().d }), /pipelineDir requerido/);
});

test('C6 · agent-models.json invalido ⇒ lanza (fail-closed) en vez de auditar sin declarado', () => {
    const f = deps();
    f.fsImpl.readFileSync = () => Buffer.from('{ no es json', 'utf8');
    assert.throws(() => runAudit({ pipelineDir: 'fixture-7519', deps: f.d }), /agent-models\.json no parsea/);
});

test('end-to-end con sanitize + agent-quality-signal reales: el puente ts epoch→ISO deja filas medibles y el veredicto sale por skill', () => {
    const f = deps();
    const rep = runAudit({ pipelineDir: 'fixture-7519', deps: f.d });
    assert.deepEqual(Object.keys(rep.skills), ['guru']);
    const g = rep.skills.guru;
    assert.equal(g.evidencia.n, 12, 'las 12 filas de spawn-exit son medibles (ts convertido a ISO)');
    assert.equal(g.evidencia.modelo_efectivo, 'claude-sonnet-4-6');
    assert.equal(g.evidencia.modelo_declarado, 'claude-sonnet-4-6');
    assert.equal(g.evidencia.difiere, false);
    assert.equal(g.evidencia.no_observados, 1);
    assert.deepEqual(g.evidencia.modelos_observados, { 'anthropic|claude-sonnet-4-6': 10 });
    // 1 rebote / 12 con ventana medible (reboundSince < from) ⇒ 8,3 % < 30 %; sin costo ⇒ mantener / costo_no_evaluable
    assert.ok(Math.abs(rep.calidad.guru.reboundRate - 1 / 12) < 1e-12);
    assert.equal(rep.calidad.guru.earlyDeathRate, 0);
    assert.equal(rep.calidad.guru.qaFailRate, 0);
    assert.equal(g.veredicto, VERDICT.MANTENER);
    assert.deepEqual(g.evidencia.motivo, []);
    // Descartes por whitelist: `intruso` (skill) y `nvidia-nim` (provider) de effective_model.
    assert.equal(rep.desconocidos.skills, 1);
    assert.equal(rep.desconocidos.providers, 1);
    assert.equal(rep.integridad.spawn_exit, 'verificada');
    assert.equal(rep.integridad.rebound_measurable, true);
    assert.equal(rep.integridad.cost_evaluable, false);
    assert.equal(rep.integridad.cost_reason, 'sin_ts');
    assert.equal(rep.integridad.broken_files, 0);
    assert.equal(rep.precios.sha256, 'b'.repeat(64));
    assert.match(rep.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(rep.umbrales.protected_skills, ['po', 'qa', 'review', 'security', 'tester']);
});

test('end-to-end · costo evaluable + calidad limpia ⇒ bajar con ahorro; un archivo con cadena rota ⇒ integridad rota ⇒ todo no_evaluable', () => {
    const base = deps();
    const sources = base.d.readSources({});
    const conCosto = {
        ...sources,
        rebound_events: fuente([]),
        provider_cost: fuente([{ ts: NOW - 3600000, provider: 'anthropic', skill: 'guru', issue: '7000', tokens_in: 1000000, tokens_out: 1000000, cache: 'no_medido' }]),
    };
    let f = deps({ sources: conCosto });
    let rep = runAudit({ pipelineDir: 'fixture-7519', deps: f.d });
    assert.equal(rep.skills.guru.veredicto, VERDICT.BAJAR);
    assert.equal(rep.skills.guru.evidencia.modelo_destino, 'claude-haiku-4-5');
    assert.equal(rep.skills.guru.evidencia.costo_ventana_usd, 18);
    assert.ok(Math.abs(rep.skills.guru.evidencia.ahorro_mensual_estimado_usd - 18 * (1 - 6 / 18)) < 1e-9);
    assert.equal(rep.integridad.cost_evaluable, true);

    const rota = { ...conCosto, spawn_exit: { ...conCosto.spawn_exit, integridad: { ...conCosto.spawn_exit.integridad, broken: ['spawn-exit-2026-09-10.jsonl'] } } };
    f = deps({ sources: rota });
    rep = runAudit({ pipelineDir: 'fixture-7519', deps: f.d });
    assert.equal(rep.integridad.spawn_exit, 'rota');
    assert.equal(rep.integridad.broken_files, 1);
    assert.equal(rep.skills.guru.veredicto, VERDICT.NO_EVALUABLE);
    assert.deepEqual(rep.skills.guru.evidencia.motivo, ['integridad_rota']);
});

test('config.model_value_audit · min_sample y protected_skills fluyen a la señal y al recommender; ausente ⇒ defaults sin error', () => {
    let f = deps({ config: config({ model_value_audit: { min_sample: 20, protected_skills: ['guru'] } }) });
    let rep = runAudit({ pipelineDir: 'fixture-7519', deps: f.d });
    assert.equal(rep.umbrales.min_sample, 20);
    assert.equal(rep.skills.guru.veredicto, VERDICT.SIN_EVIDENCIA, 'n=12 < 20');
    f = deps({ config: config({ model_value_audit: { min_sample: 5, protected_skills: ['guru'] } }) });
    rep = runAudit({ pipelineDir: 'fixture-7519', deps: f.d });
    assert.deepEqual([rep.skills.guru.veredicto, rep.skills.guru.evidencia.motivo], [VERDICT.MANTENER, ['skill_protegido']]);
    assert.deepEqual(rep.umbrales.protected_skills, ['guru', 'security']);
    f = deps({ config: config({ model_value_audit: 'basura' }) });
    assert.equal(runAudit({ pipelineDir: 'fixture-7519', deps: f.d }).umbrales.min_sample, 10);
});

test('C16 · los cuatro hermanos son sobreescribibles por deps (fakes minimos) y devSkills sale de la config, nunca literal', () => {
    const vistos = {};
    const f = deps({
        d: {
            sanitize: {
                allowedSkills: (c) => { vistos.config = c; return new Set(['guru']); },
                allowedProviders: () => new Set(['anthropic']),
                allowedPhases: () => new Set(['verificacion']),
                sanitizeRows: (rows) => ({ rows, desconocidos: { skills: 0, providers: 0, models: 0, phases: 0, death_kinds: 0, codepaths: 0, issues: 0, numericos: 0 } }),
            },
            qualitySignal: {
                compute: (args) => {
                    vistos.compute = args;
                    return { skills: { guru: { n: 3, nRaw: 3, nUnmeasurable: 0, nDuplicadas: 0, nDescartadas: 0, nSinIssue: 0, reboundRate: null, earlyDeathRate: 0, retriesPerIssue: 0, qaFailRate: 0, durationP50Ms: 1, durationP95Ms: 1, integrity: { spawn_exit: 'verificada' }, sample_ok: false } }, no_atribuidos: { rebounds: 0, qa: 0 }, reboundMeasurable: false };
                },
            },
        },
    });
    const rep = runAudit({ pipelineDir: 'fixture-7519', deps: f.d });
    assert.equal(vistos.config.pipelines.desarrollo.skills_por_fase.dev[0], 'backend-dev');
    assert.deepEqual(vistos.compute.devSkills, ['backend-dev', 'pipeline-dev']);
    assert.equal(vistos.compute.from, new Date(NOW - 30 * DAY).toISOString());
    assert.equal(vistos.compute.reboundSince, '2026-08-01T00:00:00.000Z');
    assert.equal(vistos.compute.minSample, 10);
    assert.ok(vistos.compute.spawns.every((r) => typeof r.ts === 'string'), 'ts en ISO para la parte 2');
    assert.equal(rep.skills.guru.veredicto, VERDICT.SIN_EVIDENCIA);
    assert.equal(rep.integridad.rebound_measurable, false);
});

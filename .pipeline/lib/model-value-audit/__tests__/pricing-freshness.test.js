'use strict';

// Tests de `pricing-freshness.js` (#7517): antigüedad de la tabla de precios,
// fallback, sha256 y `missing_models` — todo con `pricing` y `fsImpl` fakes.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const pf = require('../pricing-freshness');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-21T12:00:00.000Z');
const PRICING_PATH = '/fake/.pipeline/metrics/tabla-precios';
const TABLE = {
    anthropic: { 'claude-opus-4-7': { in: 15, out: 75 }, 'claude-sonnet-4-7': { in: 3, out: 15 } },
    openai: { 'gpt-5': { in: 1, out: 2 } },
    deterministic: { deterministic: { in: 0, out: 0 } },
};

function fakePricing({ updated_at, source_kind = 'json', version = 1, table = TABLE } = {}) {
    const llamadas = { invalidateCache: 0, load: 0, orden: [] };
    return {
        llamadas,
        invalidateCache: () => { llamadas.invalidateCache++; llamadas.orden.push('invalidateCache'); },
        load: () => { llamadas.load++; llamadas.orden.push('load'); return { table, meta: { version, updated_at, source_kind } }; },
        pricingMeta: () => ({ version, updated_at, source_kind }),
        pricingByProvider: () => table,
        pricingFilePath: () => PRICING_PATH,
    };
}

function fakeFs(bytes) {
    const reads = [];
    return {
        reads,
        readFileSync: (p) => {
            reads.push(p);
            if (bytes == null) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
            return Buffer.from(bytes);
        },
    };
}

function iso(daysAgo) {
    return new Date(NOW - daysAgo * DAY).toISOString();
}

const SHAPE = ['age_days', 'max_age_days', 'missing_models', 'motivo', 'sha256', 'source_kind', 'stale', 'updated_at', 'version'];

// -----------------------------------------------------------------------------
// CA-1 — shape, antigüedad, updated_at inválido
// -----------------------------------------------------------------------------

test('evaluate devuelve el shape completo y updated_at de 61 dias ⇒ stale con motivo antiguedad', () => {
    const res = pf.evaluate({ pricing: fakePricing({ updated_at: iso(61) }), fsImpl: fakeFs('{}'), now: NOW });
    assert.deepStrictEqual(Object.keys(res).sort(), SHAPE);
    assert.strictEqual(res.version, 1);
    assert.strictEqual(res.updated_at, iso(61));
    assert.strictEqual(res.age_days, 61);
    assert.strictEqual(res.stale, true);
    assert.strictEqual(res.motivo, pf.MOTIVO.ANTIGUEDAD);
    assert.strictEqual(res.source_kind, pf.SOURCE_KIND.JSON);
    assert.strictEqual(res.max_age_days, 60);
});

test('updated_at de 59 dias ⇒ no stale, motivo null; maxAgeDays es parametrizable', () => {
    const fresco = pf.evaluate({ pricing: fakePricing({ updated_at: iso(59) }), fsImpl: fakeFs('{}'), now: NOW });
    assert.strictEqual(fresco.age_days, 59);
    assert.strictEqual(fresco.stale, false);
    assert.strictEqual(fresco.motivo, null);

    const exacto = pf.evaluate({ pricing: fakePricing({ updated_at: iso(60) }), fsImpl: fakeFs('{}'), now: NOW });
    assert.strictEqual(exacto.stale, false, '60 dias no supera el tope de 60');

    const estricto = pf.evaluate({ pricing: fakePricing({ updated_at: iso(59) }), fsImpl: fakeFs('{}'), now: NOW, maxAgeDays: 30 });
    assert.strictEqual(estricto.stale, true);
    assert.strictEqual(estricto.motivo, pf.MOTIVO.ANTIGUEDAD);
    assert.strictEqual(estricto.max_age_days, 30);
});

test('updated_at no parseable ⇒ age_days null, stale y motivo updated_at_invalido', () => {
    for (const malo of ['ayer', '', null, undefined, {}]) {
        const res = pf.evaluate({ pricing: fakePricing({ updated_at: malo }), fsImpl: fakeFs('{}'), now: NOW });
        assert.strictEqual(res.age_days, null, `updated_at=${JSON.stringify(malo)}`);
        assert.strictEqual(res.stale, true);
        assert.strictEqual(res.motivo, pf.MOTIVO.UPDATED_AT_INVALIDO);
        assert.strictEqual(res.source_kind, pf.SOURCE_KIND.JSON, 'el archivo existe: no es fallback');
    }
});

// -----------------------------------------------------------------------------
// CA-2 — fallback
// -----------------------------------------------------------------------------

test('pricingMeta().source_kind fallback ⇒ source_kind fallback, sha256 null, stale, motivo pricing_json_ausente_o_invalido', () => {
    const res = pf.evaluate({ pricing: fakePricing({ updated_at: iso(1), source_kind: 'fallback' }), fsImpl: fakeFs('{}'), now: NOW });
    assert.strictEqual(res.source_kind, pf.SOURCE_KIND.FALLBACK);
    assert.strictEqual(res.sha256, null);
    assert.strictEqual(res.stale, true);
    assert.strictEqual(res.motivo, pf.MOTIVO.PRICING_JSON_AUSENTE_O_INVALIDO);
});

test('readFileSync(pricingFilePath()) que lanza ⇒ fallback con sha256 null aunque la meta diga json (SEC-2b)', () => {
    const fsImpl = fakeFs(null);
    const res = pf.evaluate({ pricing: fakePricing({ updated_at: iso(1) }), fsImpl, now: NOW });
    assert.deepStrictEqual(fsImpl.reads, [PRICING_PATH]);
    assert.strictEqual(res.source_kind, pf.SOURCE_KIND.FALLBACK);
    assert.strictEqual(res.sha256, null);
    assert.strictEqual(res.stale, true);
    assert.strictEqual(res.motivo, pf.MOTIVO.PRICING_JSON_AUSENTE_O_INVALIDO);
});

test('la prioridad de motivo es fallback > updated_at_invalido > antiguedad', () => {
    const ambos = pf.evaluate({ pricing: fakePricing({ updated_at: 'basura', source_kind: 'fallback' }), fsImpl: fakeFs('{}'), now: NOW });
    assert.strictEqual(ambos.motivo, pf.MOTIVO.PRICING_JSON_AUSENTE_O_INVALIDO);
    const viejoEInvalido = pf.evaluate({ pricing: fakePricing({ updated_at: 'basura' }), fsImpl: fakeFs('{}'), now: NOW });
    assert.strictEqual(viejoEInvalido.motivo, pf.MOTIVO.UPDATED_AT_INVALIDO);
});

// -----------------------------------------------------------------------------
// CA-3 — sha256 e invalidateCache
// -----------------------------------------------------------------------------

test('sha256 es el hash de los bytes del archivo: identico en dos corridas y distinto si cambia un byte', () => {
    const bytes = '{"version":1,"anthropic":{}}';
    const a = pf.evaluate({ pricing: fakePricing({ updated_at: iso(1) }), fsImpl: fakeFs(bytes), now: NOW });
    const b = pf.evaluate({ pricing: fakePricing({ updated_at: iso(1) }), fsImpl: fakeFs(bytes), now: NOW });
    const c = pf.evaluate({ pricing: fakePricing({ updated_at: iso(1) }), fsImpl: fakeFs(bytes.replace('1', '2')), now: NOW });
    assert.strictEqual(a.sha256, b.sha256);
    assert.notStrictEqual(a.sha256, c.sha256);
    assert.strictEqual(a.sha256, crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex'));
    assert.match(a.sha256, /^[0-9a-f]{64}$/);
});

test('invalidateCache se llama exactamente una vez por evaluate, antes de load', () => {
    const pricing = fakePricing({ updated_at: iso(1) });
    pf.evaluate({ pricing, fsImpl: fakeFs('{}'), now: NOW });
    assert.strictEqual(pricing.llamadas.invalidateCache, 1);
    assert.strictEqual(pricing.llamadas.load, 1);
    assert.deepStrictEqual(pricing.llamadas.orden, ['invalidateCache', 'load']);
    pf.evaluate({ pricing, fsImpl: fakeFs('{}'), now: NOW });
    assert.strictEqual(pricing.llamadas.invalidateCache, 2);
});

// -----------------------------------------------------------------------------
// CA-10 — missing_models (A4 / CA-UX-10)
// -----------------------------------------------------------------------------

test('missing_models: claude-opus-5 missing, deterministic no, model null excluido, provider sin tabla missing, orden por n desc', () => {
    const observed = [
        { provider: 'anthropic', model: 'claude-opus-5', n: 2678 },
        { provider: 'deterministic', model: 'deterministic', n: 1012 },
        { provider: 'anthropic', model: null, n: 235 },
        { provider: 'openai-codex', model: 'gpt-5', n: 386 },
        { provider: 'anthropic', model: 'claude-opus-4-7', n: 10 },
        { provider: 'google', model: 'gemini-3', n: 5000 },
    ];
    const res = pf.evaluate({ pricing: fakePricing({ updated_at: iso(1) }), fsImpl: fakeFs('{}'), now: NOW, observedModels: observed });
    assert.deepStrictEqual(res.missing_models, [
        { provider: 'google', model: 'gemini-3', n: 5000 },
        { provider: 'anthropic', model: 'claude-opus-5', n: 2678 },
        { provider: 'openai-codex', model: 'gpt-5', n: 386 },
    ]);
});

test('missing_models no usa getPricing: un fake sin getPricing funciona y el lookup es por hasOwnProperty', () => {
    const table = Object.assign(Object.create({ heredado: { x: {} } }), { anthropic: Object.create({ 'claude-opus-5': { in: 1 } }) });
    const pricing = fakePricing({ updated_at: iso(1), table });
    assert.strictEqual(pricing.getPricing, undefined);
    const res = pf.evaluate({ pricing, fsImpl: fakeFs('{}'), now: NOW, observedModels: [
        { provider: 'anthropic', model: 'claude-opus-5', n: 1 },
        { provider: 'heredado', model: 'x', n: 1 },
    ] });
    assert.deepStrictEqual(res.missing_models.map((m) => `${m.provider}|${m.model}`), ['anthropic|claude-opus-5', 'heredado|x']);
});

test('observedModels basura (no array, entradas nulas, n no numerico) no rompe evaluate', () => {
    const a = pf.evaluate({ pricing: fakePricing({ updated_at: iso(1) }), fsImpl: fakeFs('{}'), now: NOW, observedModels: null });
    assert.deepStrictEqual(a.missing_models, []);
    const b = pf.evaluate({ pricing: fakePricing({ updated_at: iso(1) }), fsImpl: fakeFs('{}'), now: NOW, observedModels: [null, 'x', { provider: 'anthropic', model: 'zzz', n: 'muchos' }, { model: 'sin-provider', n: 1 }] });
    assert.deepStrictEqual(b.missing_models, [{ provider: 'anthropic', model: 'zzz', n: 0 }]);
});

// -----------------------------------------------------------------------------
// CA-13 — vocabulario cerrado
// -----------------------------------------------------------------------------

test('MOTIVO y SOURCE_KIND estan congelados y todo motivo/source_kind emitido pertenece al enum', () => {
    assert.ok(Object.isFrozen(pf.MOTIVO) && Object.isFrozen(pf.SOURCE_KIND));
    assert.deepStrictEqual(pf.MOTIVO, {
        PRICING_JSON_AUSENTE_O_INVALIDO: 'pricing_json_ausente_o_invalido',
        UPDATED_AT_INVALIDO: 'updated_at_invalido',
        ANTIGUEDAD: 'antiguedad',
    });
    const motivos = new Set(Object.values(pf.MOTIVO));
    const kinds = new Set(Object.values(pf.SOURCE_KIND));
    const casos = [
        pf.evaluate({ pricing: fakePricing({ updated_at: iso(1) }), fsImpl: fakeFs('{}'), now: NOW }),
        pf.evaluate({ pricing: fakePricing({ updated_at: iso(99) }), fsImpl: fakeFs('{}'), now: NOW }),
        pf.evaluate({ pricing: fakePricing({ updated_at: 'x' }), fsImpl: fakeFs('{}'), now: NOW }),
        pf.evaluate({ pricing: fakePricing({ updated_at: iso(1), source_kind: 'fallback' }), fsImpl: fakeFs('{}'), now: NOW }),
        pf.evaluate({ pricing: fakePricing({ updated_at: iso(1) }), fsImpl: fakeFs(null), now: NOW }),
    ];
    for (const c of casos) {
        assert.ok(c.motivo === null || motivos.has(c.motivo), `motivo ${c.motivo}`);
        assert.ok(kinds.has(c.source_kind), `source_kind ${c.source_kind}`);
        assert.strictEqual(c.stale, c.motivo !== null, 'stale sii motivo !== null');
    }
});

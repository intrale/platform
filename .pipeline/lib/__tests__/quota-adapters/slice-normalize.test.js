// =============================================================================
// Tests #4202 — normalización por proveedor del desglose de cuotas en
// `dashboard-slices.quotaSlice` / `normalizeProviderQuota`.
//
// Cubre:
//   CA-7 — exposición mínima: por proveedor/bucket SOLO {pct, confidence};
//          NO cost_usd, tokens crudos ni ruta de snapshot (security req#5).
//   CA-2 — Anthropic mapea session ← session.realPct ?? pct; weekly ← realPct ?? pct.
//   CA-3 — Codex semanal real desde snapshot; sesión "sin dato".
//   CA-4 — Gemini ambos buckets "sin dato".
//   CA-5 — regresión: el % agregado top-level (pct, session.pct, flat-merge
//          de Anthropic) sigue intacto tras agregar el desglose.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshSlices() {
    delete require.cache[require.resolve('../../dashboard-slices')];
    return require('../../dashboard-slices');
}

function mkTmpPipeline() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-quota-4202-'));
    const pipeline = path.join(root, '.pipeline');
    const metrics = path.join(pipeline, 'metrics');
    fs.mkdirSync(metrics, { recursive: true });
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    return { root, pipeline, metrics };
}

// ---------------------------------------------------------------------------
// normalizeProviderQuota — función pura
// ---------------------------------------------------------------------------

test('CA-2: normaliza Anthropic con session.realPct y realPct semanal', () => {
    const slices = freshSlices();
    const result = {
        provider: 'anthropic',
        adapterStatus: 'ok',
        pct: 40, realPct: 55,
        session: { pct: 20, realPct: 30 },
    };
    const n = slices.normalizeProviderQuota('anthropic', result);
    assert.equal(n.session.pct, 30, 'session ← session.realPct');
    assert.equal(n.weekly.pct, 55, 'weekly ← realPct');
});

test('CA-2: Anthropic cae a pct crudo cuando no hay realPct', () => {
    const slices = freshSlices();
    const result = {
        provider: 'anthropic', adapterStatus: 'ok',
        pct: 40, realPct: null,
        session: { pct: 20, realPct: null },
    };
    const n = slices.normalizeProviderQuota('anthropic', result);
    assert.equal(n.session.pct, 20);
    assert.equal(n.weekly.pct, 40);
});

test('CA-3: Codex con pct semanal real → weekly poblado, session null', () => {
    const slices = freshSlices();
    const result = { provider: 'openai-codex', adapterStatus: 'ok', pct: 25, realPct: null, session: { pct: null } };
    const n = slices.normalizeProviderQuota('openai-codex', result);
    assert.equal(n.weekly.pct, 25);
    assert.equal(n.weekly.confidence, 'fresh');
    assert.equal(n.session.pct, null, 'Codex no tiene ventana de sesión');
});

test('CA-4: Gemini not_implemented → ambos buckets "sin dato"', () => {
    const slices = freshSlices();
    const result = { provider: 'gemini-google', adapterStatus: 'not_implemented', pct: null, session: { pct: null } };
    const n = slices.normalizeProviderQuota('gemini-google', result);
    assert.equal(n.session.pct, null);
    assert.equal(n.weekly.pct, null);
    assert.equal(n.weekly.confidence, 'missing');
});

test('CA-7: el shape normalizado NO expone campos sensibles (security req#5)', () => {
    const slices = freshSlices();
    // Resultado "sucio" con campos que NUNCA deben llegar al cliente.
    const dirty = {
        provider: 'openai-codex', adapterStatus: 'ok', pct: 25,
        session: { pct: null },
        cost_usd: 250.5,
        tokens: 1234567,
        snapshotPath: 'C:/secret/snapshot.json',
        account_handle: 'leito@example.com',
    };
    const n = slices.normalizeProviderQuota('openai-codex', dirty);
    const keys = Object.keys(n).sort();
    assert.deepEqual(keys, ['adapterStatus', 'provider', 'session', 'weekly']);
    for (const bucket of ['session', 'weekly']) {
        const bk = Object.keys(n[bucket]).sort();
        assert.deepEqual(bk, ['confidence', 'pct'],
            `${bucket} solo expone {pct, confidence}`);
    }
    // Smoke: ningún campo sensible en el JSON serializado.
    const json = JSON.stringify(n);
    for (const leak of ['cost_usd', 'tokens', 'snapshot', 'account_handle', '250.5', '1234567']) {
        assert.ok(!json.includes(leak), `no debe filtrar "${leak}"`);
    }
});

test('normalizeProviderQuota es defensivo ante result null/garbage', () => {
    const slices = freshSlices();
    for (const bad of [null, undefined, 42, 'x', []]) {
        const n = slices.normalizeProviderQuota('openai-codex', bad);
        assert.equal(n.session.pct, null);
        assert.equal(n.weekly.pct, null);
        assert.equal(n.provider, 'openai-codex');
    }
});

// ---------------------------------------------------------------------------
// CA-5 — regresión del % agregado top-level
// ---------------------------------------------------------------------------

test('CA-5: quotaSlice mantiene el % agregado top-level tras el desglose', () => {
    const { root, pipeline } = mkTmpPipeline();
    const log = path.join(root, '.claude', 'activity-log.jsonl');
    fs.writeFileSync(log, JSON.stringify({
        event: 'session:end',
        ts: new Date().toISOString(),
        duration_ms: 3600000,
        provider: 'anthropic',
        model: 'claude-sonnet-4',
    }) + '\n');
    fs.writeFileSync(path.join(pipeline, 'agent-models.json'), JSON.stringify({
        providers: { anthropic: {}, 'openai-codex': {}, 'gemini-google': {} },
    }));
    const slices = freshSlices();
    const out = slices.quotaSlice({}, { ROOT: root, PIPELINE: pipeline });

    // Campos legacy del banner agregado siguen presentes en el top-level.
    assert.ok('hoursUsed7d' in out, 'hoursUsed7d top-level intacto');
    assert.ok('pct' in out, 'pct top-level intacto');
    assert.ok(out.session && typeof out.session === 'object', 'session top-level intacto');
    // El flat-merge de Anthropic NO fue mutado por la normalización: session
    // top-level conserva su shape rico (no el {pct, confidence} minimal).
    assert.ok('status' in out.session, 'session top-level conserva shape rico');
    // Y el desglose normalizado coexiste.
    assert.ok(out.providers.anthropic.session, 'desglose normalizado presente');
    assert.equal(Object.keys(out.providers.anthropic.session).sort().join(','),
        'confidence,pct', 'desglose es el shape minimal');
});

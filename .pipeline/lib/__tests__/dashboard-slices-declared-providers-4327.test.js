// =============================================================================
// Tests #4327 (CA-3) — `quotaSlice.declaredProviders` alineado con la config
// real (`agent-models.json`) y SIN el fantasma `groq` (descontinuado #3353),
// tanto en el path config-driven como en el fallback hardcodeado.
//
// Cubre además:
//   - `skipSideEffects: true` NO altera el shape de providers y evita re-correr
//     el guard/pacing (out.preventiveAlert inactivo, out.pacing deshabilitado).
//   - normalizeProviderQuota usa el pct del snapshot más reciente, no cae a 0.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Alineado con los `providers` reales de agent-models.json (sin `deterministic`).
const REAL_PROVIDERS = ['anthropic', 'openai-codex', 'gemini-google', 'cerebras', 'nvidia-nim'];

function freshSlices() {
    delete require.cache[require.resolve('../dashboard-slices')];
    return require('../dashboard-slices');
}

function mkTmpPipeline() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-declared-4327-'));
    const pipeline = path.join(root, '.pipeline');
    fs.mkdirSync(path.join(pipeline, 'metrics'), { recursive: true });
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    return { root, pipeline };
}

// ---------------------------------------------------------------------------
// CA-3 — path config-driven: providers salen de agent-models.json (sin groq,
// sin deterministic).
// ---------------------------------------------------------------------------
test('CA-3: quotaSlice deriva providers de agent-models.json sin groq ni deterministic', () => {
    const { root, pipeline } = mkTmpPipeline();
    fs.writeFileSync(path.join(pipeline, 'agent-models.json'), JSON.stringify({
        providers: {
            anthropic: {}, 'openai-codex': {}, 'gemini-google': {},
            cerebras: {}, 'nvidia-nim': {}, deterministic: {},
        },
    }));
    const slices = freshSlices();
    const out = slices.quotaSlice({}, { ROOT: root, PIPELINE: pipeline });

    const keys = Object.keys(out.providers).sort();
    assert.deepEqual(keys, [...REAL_PROVIDERS].sort(), 'providers exactos de la config (sin groq, sin deterministic)');
    assert.ok(!keys.includes('groq'), 'groq no debe aparecer');
});

// ---------------------------------------------------------------------------
// CA-3 — fallback hardcodeado (sin agent-models.json): la lista mínima ya NO
// incluye groq. Blinda el escenario de fallo de lectura de config.
// ---------------------------------------------------------------------------
test('CA-3: fallback (sin agent-models.json) usa la lista real sin groq', () => {
    const { root, pipeline } = mkTmpPipeline();
    // NO se escribe agent-models.json → se ejercita el fallback hardcodeado.
    assert.ok(!fs.existsSync(path.join(pipeline, 'agent-models.json')), 'sanity: sin config');
    const slices = freshSlices();
    const out = slices.quotaSlice({}, { ROOT: root, PIPELINE: pipeline });

    const keys = Object.keys(out.providers).sort();
    assert.deepEqual(keys, [...REAL_PROVIDERS].sort(), 'el fallback lista exactamente los 5 providers reales');
    assert.ok(!keys.includes('groq'), 'el fallback NO debe reintroducir el fantasma groq');
});

// ---------------------------------------------------------------------------
// CA-3 — fuente estática: la lista hardcodeada del fallback y la config real de
// agent-models.json (del repo) coinciden. Evita drift silencioso.
// ---------------------------------------------------------------------------
test('CA-3: el fallback hardcodeado del source coincide con los providers del repo', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'dashboard-slices.js'), 'utf8');
    const m = src.match(/let declaredProviders = \[([^\]]*)\]/);
    assert.ok(m, 'debe existir la declaración del fallback declaredProviders');
    const listed = m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).sort();
    assert.deepEqual(listed, [...REAL_PROVIDERS].sort(), 'el fallback del source son los 5 providers reales');
    assert.ok(!listed.includes('groq'), 'el fallback del source no menciona groq');
});

// ---------------------------------------------------------------------------
// skipSideEffects — mismo shape de providers, sin re-correr guard/pacing.
// ---------------------------------------------------------------------------
test('skipSideEffects: providers intactos y guard/pacing no se evalúan', () => {
    const { root, pipeline } = mkTmpPipeline();
    fs.writeFileSync(path.join(pipeline, 'agent-models.json'), JSON.stringify({
        providers: { anthropic: {}, 'openai-codex': {} },
    }));
    const slices = freshSlices();
    const base = slices.quotaSlice({}, { ROOT: root, PIPELINE: pipeline });
    const skipped = slices.quotaSlice({}, { ROOT: root, PIPELINE: pipeline, skipSideEffects: true });

    // El desglose por proveedor es idéntico con y sin efectos secundarios.
    assert.deepEqual(Object.keys(skipped.providers).sort(), Object.keys(base.providers).sort());
    // Con skip, el guard anticipatorio no marca banner activo y el pacing queda off.
    assert.equal(skipped.preventiveAlert.active, false, 'guard no activa banner con skipSideEffects');
    assert.equal(skipped.pacing.enabled, false, 'pacing deshabilitado con skipSideEffects');
});

// ---------------------------------------------------------------------------
// normalizeProviderQuota usa el pct más reciente (realPct del snapshot), NO cae
// a 0/viejo cuando hay dato confiable.
// ---------------------------------------------------------------------------
test('normalizeProviderQuota toma el pct real más reciente, no cae a 0', () => {
    const slices = freshSlices();
    const n = slices.normalizeProviderQuota('anthropic', {
        provider: 'anthropic', adapterStatus: 'ok',
        pct: 0, realPct: 42,                       // realPct (reciente) debe ganar
        session: { pct: 0, realPct: 18 },
    });
    assert.equal(n.weekly.pct, 42, 'weekly usa realPct reciente, no el pct viejo/0');
    assert.equal(n.session.pct, 18, 'session usa session.realPct reciente, no 0');
});

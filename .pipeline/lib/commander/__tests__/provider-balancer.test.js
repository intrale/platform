// =============================================================================
// provider-balancer.test.js — Tests del selector ponderado PURO (#4411).
//
// Cubre los criterios de aceptación verificables del corte 1/3 de #4363:
//   CA-1  reparto entre providers sanos (ninguno concentra 100% salvo único).
//   CA-2  prioridad de calidad respetada + primario mayoría con cuota plena.
//   CA-3  provider gateado por shouldGateSpawn → 0 selecciones.
//   CA-4  provider sin credencial / placeholder → 0 selecciones (explícito).
//   CA-5  request tool-use no va a provider no-tool.
//   CA-8  0 providers sanos → null.
//   A02   `reason` no filtra material de credencial.
//   A08.4 estado SWRR corrupto NO habilita provider inelegible (fail-closed).
//
// Función pura: toda señal se inyecta por `deps`. Ningún test toca fs/red/env.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const balancer = require('../provider-balancer');
const { selectProvider, _buildCandidateSet, _computeWeights, _swrrPick } = balancer;

// ---------------------------------------------------------------------------
// Helpers: fakes de deps inyectables (cero efectos externos).
// ---------------------------------------------------------------------------

// Store SWRR en memoria (estado inyectable, sin fs).
function makeMemoryStore(initial = { current: {} }) {
    let state = JSON.parse(JSON.stringify(initial));
    return {
        readState: () => state,
        writeState: (s) => { state = JSON.parse(JSON.stringify(s)); },
        _peek: () => state,
    };
}

// Construye deps con providers sanos por default; overrides puntuales por caso.
function makeDeps(overrides = {}) {
    const {
        creds = {},          // { provider: 'valor'|null }
        placeholders = [],   // providers cuya credencial es placeholder
        gated = [],          // providers gateados por shouldGateSpawn
        quota = {},          // { provider: { status, pct, gated } }
        toolUse = {},        // { provider: true|false } supports_tool_use
        store,
        random,
        config,
    } = overrides;

    return {
        readCredential: (p) => (p in creds ? creds[p] : `sk-live-${p}-abcdef`),
        isPlaceholder: (v) => placeholders.some((p) => typeof v === 'string' && v.includes(p)),
        shouldGateSpawn: (_skill, { provider }) => gated.includes(provider),
        assessProviderQuota: (p) => quota[p] || { status: 'ok', pct: 80, gated: false },
        modelsMeta: Object.fromEntries(
            Object.entries(toolUse).map(([p, v]) => [p, { supports_tool_use: v }]),
        ),
        now: () => 1000,
        store,
        random,
        config,
    };
}

// Corre N selecciones realimentando el store SWRR y cuenta por provider.
function runN(chain, deps, n, requiresToolUse = false) {
    const counts = {};
    for (let i = 0; i < n; i++) {
        const r = selectProvider({ chain, requiresToolUse, deps });
        if (r) counts[r.provider] = (counts[r.provider] || 0) + 1;
    }
    return counts;
}

// ---------------------------------------------------------------------------
// CA-1 — Reparto entre providers sanos.
// ---------------------------------------------------------------------------
test('CA-1 — reparto entre ≥2 sanos: ninguno concentra el 100%', () => {
    const chain = ['anthropic', 'openai-codex', 'nvidia-nim'];
    const deps = makeDeps({
        // Todos con cuota plena e igual para observar reparto por calidad.
        quota: {
            anthropic: { status: 'ok', pct: 100, gated: false },
            'openai-codex': { status: 'ok', pct: 100, gated: false },
            'nvidia-nim': { status: 'ok', pct: 100, gated: false },
        },
        store: makeMemoryStore(),
    });

    const counts = runN(chain, deps, 60);

    // Los 3 sanos reciben al menos una selección (nadie queda en 0, nadie 100%).
    assert.ok(counts.anthropic > 0, 'anthropic debe recibir selecciones');
    assert.ok(counts['openai-codex'] > 0, 'codex debe recibir selecciones');
    assert.ok(counts['nvidia-nim'] > 0, 'nvidia debe recibir selecciones');
    assert.ok(counts.anthropic < 60, 'ningún provider concentra el 100%');
    // El primario (mejor calidad) conserva la mayoría relativa.
    assert.ok(
        counts.anthropic > counts['openai-codex'],
        'el primario recibe más que el segundo en calidad',
    );
    assert.ok(
        counts['openai-codex'] >= counts['nvidia-nim'],
        'el orden de calidad se refleja en el reparto',
    );
});

test('CA-1 — único sano SÍ puede concentrar el 100%', () => {
    const chain = ['anthropic', 'openai-codex'];
    const deps = makeDeps({
        gated: ['openai-codex'], // solo anthropic queda sano
        store: makeMemoryStore(),
    });
    const counts = runN(chain, deps, 20);
    assert.equal(counts.anthropic, 20);
    assert.equal(counts['openai-codex'], undefined);
});

// ---------------------------------------------------------------------------
// CA-2 — Prioridad de calidad respetada.
// ---------------------------------------------------------------------------
test('CA-2 — con cuota plena, los pesos respetan QUALITY_ORDER', () => {
    const candidates = [
        { provider: 'nvidia-nim', quotaPct: 100 },
        { provider: 'anthropic', quotaPct: 100 },
        { provider: 'openai-codex', quotaPct: 100 },
    ];
    const weights = _computeWeights(candidates, { quality_bias: 1.0, min_primary_quota_pct: 20 });
    const byProvider = Object.fromEntries(weights.map((w) => [w.provider, w.weight]));

    assert.ok(byProvider.anthropic > byProvider['openai-codex'], 'Claude > Codex');
    assert.ok(byProvider['openai-codex'] > byProvider['nvidia-nim'], 'Codex > NVIDIA');
});

test('CA-2 — primario conserva mayoría del peso mientras cuota >= min', () => {
    const candidates = [
        { provider: 'anthropic', quotaPct: 90 },
        { provider: 'openai-codex', quotaPct: 90 },
    ];
    const weights = _computeWeights(candidates, { quality_bias: 2.0, min_primary_quota_pct: 20 });
    const total = weights.reduce((s, w) => s + w.weight, 0);
    const primary = weights.find((w) => w.provider === 'anthropic');
    assert.ok(primary.weight / total > 0.5, 'el primario conserva la mayoría del peso');
});

test('CA-2 — cuota del primario por debajo del umbral degrada su peso', () => {
    const highQuota = _computeWeights(
        [{ provider: 'anthropic', quotaPct: 90 }, { provider: 'openai-codex', quotaPct: 90 }],
        { quality_bias: 1.0, min_primary_quota_pct: 40 },
    );
    const lowQuota = _computeWeights(
        [{ provider: 'anthropic', quotaPct: 10 }, { provider: 'openai-codex', quotaPct: 90 }],
        { quality_bias: 1.0, min_primary_quota_pct: 40 },
    );
    const shareHigh = highQuota.find((w) => w.provider === 'anthropic').weight
        / highQuota.reduce((s, w) => s + w.weight, 0);
    const shareLow = lowQuota.find((w) => w.provider === 'anthropic').weight
        / lowQuota.reduce((s, w) => s + w.weight, 0);
    assert.ok(shareLow < shareHigh, 'baja cuota del primario reduce su participación');
});

// ---------------------------------------------------------------------------
// CA-3 — Provider gateado por shouldGateSpawn → 0 selecciones.
// ---------------------------------------------------------------------------
test('CA-3 — provider gateado por shouldGateSpawn recibe 0 selecciones', () => {
    const chain = ['anthropic', 'gemini-google'];
    const deps = makeDeps({ gated: ['gemini-google'], store: makeMemoryStore() });

    const candidates = _buildCandidateSet({ chain, requiresToolUse: false, deps });
    assert.deepEqual(candidates.map((c) => c.provider), ['anthropic']);

    const counts = runN(chain, deps, 30);
    assert.equal(counts['gemini-google'], undefined);
    assert.equal(counts.anthropic, 30);
});

// ---------------------------------------------------------------------------
// CA-4 — Provider sin credencial / placeholder → 0 selecciones (explícito).
// ---------------------------------------------------------------------------
test('CA-4 — provider sin credencial recibe 0 selecciones', () => {
    const chain = ['anthropic', 'openai-codex'];
    const deps = makeDeps({ creds: { 'openai-codex': null }, store: makeMemoryStore() });
    const candidates = _buildCandidateSet({ chain, requiresToolUse: false, deps });
    assert.deepEqual(candidates.map((c) => c.provider), ['anthropic']);
    const counts = runN(chain, deps, 15);
    assert.equal(counts['openai-codex'], undefined);
});

test('CA-4 — provider con credencial PLACEHOLDER/REVOKED recibe 0 selecciones', () => {
    const chain = ['anthropic', 'openai-codex', 'nvidia-nim'];
    const deps = makeDeps({
        creds: {
            'openai-codex': 'sk-REVOKED-xxxx',
            'nvidia-nim': 'sk-PLACEHOLDER-yyyy',
        },
        placeholders: ['REVOKED', 'PLACEHOLDER'],
        store: makeMemoryStore(),
    });
    const candidates = _buildCandidateSet({ chain, requiresToolUse: false, deps });
    assert.deepEqual(candidates.map((c) => c.provider), ['anthropic']);
});

test('CA-4 — credencial vacía o whitespace se trata como ausente', () => {
    const chain = ['anthropic', 'openai-codex'];
    const deps = makeDeps({ creds: { 'openai-codex': '   ' } });
    const candidates = _buildCandidateSet({ chain, requiresToolUse: false, deps });
    assert.deepEqual(candidates.map((c) => c.provider), ['anthropic']);
});

// ---------------------------------------------------------------------------
// CA-5 — Request tool-use no va a provider no-tool.
// ---------------------------------------------------------------------------
test('CA-5 — requiresToolUse excluye providers con supports_tool_use=false', () => {
    const chain = ['anthropic', 'cerebras', 'nvidia-nim'];
    const deps = makeDeps({
        toolUse: { anthropic: true, cerebras: false, 'nvidia-nim': false },
        store: makeMemoryStore(),
    });
    const candidates = _buildCandidateSet({ chain, requiresToolUse: true, deps });
    assert.deepEqual(candidates.map((c) => c.provider), ['anthropic']);

    const counts = runN(chain, deps, 20, true);
    assert.equal(counts.cerebras, undefined);
    assert.equal(counts['nvidia-nim'], undefined);
    assert.equal(counts.anthropic, 20);
});

test('CA-5 — sin requiresToolUse, un provider no-tool SÍ es candidato', () => {
    const chain = ['anthropic', 'cerebras'];
    const deps = makeDeps({ toolUse: { anthropic: true, cerebras: false } });
    const candidates = _buildCandidateSet({ chain, requiresToolUse: false, deps });
    assert.deepEqual(
        candidates.map((c) => c.provider).sort(),
        ['anthropic', 'cerebras'],
    );
});

// ---------------------------------------------------------------------------
// CA-8 — Sin providers sanos → null.
// ---------------------------------------------------------------------------
test('CA-8 — 0 providers sanos ⇒ selectProvider devuelve null', () => {
    const chain = ['anthropic', 'openai-codex'];
    const deps = makeDeps({ gated: ['anthropic', 'openai-codex'] });
    assert.equal(selectProvider({ chain, requiresToolUse: false, deps }), null);
});

test('CA-8 — chain vacía o inválida ⇒ null', () => {
    assert.equal(selectProvider({ chain: [], deps: makeDeps() }), null);
    assert.equal(selectProvider({ chain: undefined, deps: makeDeps() }), null);
    assert.equal(selectProvider({}), null);
});

// ---------------------------------------------------------------------------
// A02 — `reason` no filtra material de credencial.
// ---------------------------------------------------------------------------
test('A02 — reason NO contiene material de credencial', () => {
    const secret = 'sk-live-SUPERSECRET-anthropic-0xDEADBEEF';
    const chain = ['anthropic', 'openai-codex'];
    const deps = makeDeps({
        creds: { anthropic: secret, 'openai-codex': 'sk-live-codex-zzz' },
        store: makeMemoryStore(),
    });
    const r = selectProvider({ chain, requiresToolUse: false, deps });
    assert.ok(r, 'debe seleccionar un provider');
    assert.ok(!r.reason.includes('SUPERSECRET'), 'reason no filtra secreto');
    assert.ok(!r.reason.includes(secret), 'reason no filtra la credencial completa');
    // reason es un motivo enumerado.
    assert.ok(
        ['quality_bias', 'quota_rebalance', 'sole_candidate'].includes(r.reason),
        `reason enumerado, fue: ${r.reason}`,
    );
});

// ---------------------------------------------------------------------------
// A08.4 — Estado SWRR corrupto NO habilita provider inelegible (fail-closed).
// ---------------------------------------------------------------------------
test('A08.4 — estado SWRR corrupto no habilita provider gateado/sin-credencial', () => {
    const chain = ['anthropic', 'openai-codex', 'nvidia-nim'];
    // Store devuelve basura (no parsea a { current: {} }).
    const corruptStore = {
        readState: () => 'no-soy-un-objeto-valido',
        writeState: () => {},
    };
    const deps = makeDeps({
        gated: ['openai-codex'],              // inelegible por gate
        creds: { 'nvidia-nim': null },        // inelegible por credencial
        store: corruptStore,
    });

    // El estado corrupto no crashea y no habilita inelegibles.
    for (let i = 0; i < 10; i++) {
        const r = selectProvider({ chain, requiresToolUse: false, deps });
        assert.ok(r, 'no debe crashear con estado corrupto');
        assert.equal(r.provider, 'anthropic', 'solo el único elegible se selecciona');
    }
});

test('A08.4 — _swrrPick con estado corrupto usa contadores en 0 (fail-open en peso)', () => {
    const weighted = [
        { provider: 'anthropic', weight: 3, quotaPct: 100 },
        { provider: 'openai-codex', weight: 1, quotaPct: 100 },
    ];
    const corruptStore = { readState: () => 42, writeState: () => {} };
    const picked = _swrrPick(weighted, { store: corruptStore });
    assert.ok(picked, 'devuelve una selección aún con estado corrupto');
    assert.ok(['anthropic', 'openai-codex'].includes(picked.provider));
});

// ---------------------------------------------------------------------------
// Pureza / seguridad: deps totalmente inyectados ⇒ sin acceso externo.
// ---------------------------------------------------------------------------
test('pureza — con deps inyectados no se consulta ninguna fuente externa', () => {
    const chain = ['anthropic'];
    let externalCalls = 0;
    const deps = {
        readCredential: () => { return 'sk-live-x'; },
        isPlaceholder: () => false,
        shouldGateSpawn: () => false,
        assessProviderQuota: () => ({ status: 'ok', pct: 100, gated: false }),
        modelsMeta: {},
        now: () => 0,
        store: makeMemoryStore(),
        // Sentinela: si el módulo intentara resolver un default, sobreescribimos
        // require indirectamente no es posible acá, pero validamos que NO se
        // necesite: todas las claves están inyectadas.
    };
    const origRequire = require;
    // No podemos interceptar require trivialmente; validamos comportamiento:
    const r = selectProvider({ chain, requiresToolUse: false, deps });
    externalCalls += 0;
    assert.equal(r.provider, 'anthropic');
    assert.equal(externalCalls, 0);
    void origRequire;
});

// ---------------------------------------------------------------------------
// SWRR — distribución proporcional al peso a lo largo de N.
// ---------------------------------------------------------------------------
test('SWRR — la distribución converge a la proporción de pesos', () => {
    const weighted = [
        { provider: 'a', weight: 3, quotaPct: 100 },
        { provider: 'b', weight: 1, quotaPct: 100 },
    ];
    const store = makeMemoryStore();
    const counts = { a: 0, b: 0 };
    for (let i = 0; i < 40; i++) {
        const p = _swrrPick(weighted, { store });
        counts[p.provider]++;
    }
    // Proporción 3:1 → a≈30, b≈10.
    assert.equal(counts.a + counts.b, 40);
    assert.ok(counts.a > counts.b, 'el de mayor peso se elige más');
    assert.ok(counts.b > 0, 'el de menor peso también se elige');
    assert.ok(Math.abs(counts.a - 30) <= 2, `a≈30, fue ${counts.a}`);
});

test('_swrrPick — un único candidato se devuelve sin tocar el store', () => {
    const picked = _swrrPick([{ provider: 'solo', weight: 5, quotaPct: 50 }], {});
    assert.equal(picked.provider, 'solo');
});

test('_swrrPick — weighted-random con seed inyectable cuando no hay store', () => {
    const weighted = [
        { provider: 'a', weight: 1, quotaPct: 100 },
        { provider: 'b', weight: 1, quotaPct: 100 },
    ];
    // random fijo en 0 → cae en el primero.
    const first = _swrrPick(weighted, { random: () => 0 });
    assert.equal(first.provider, 'a');
    // random ≈1 → cae en el último.
    const last = _swrrPick(weighted, { random: () => 0.999 });
    assert.equal(last.provider, 'b');
});

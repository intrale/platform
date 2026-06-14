// =============================================================================
// evidence-cache.test.js — Suite Node para el memoizador TTL de shell-outs
// git/gh del verificador Sherlock (#3924, EP2-H4).
//
// Diseño: reloj inyectable (`now`) + impl real falsa que cuenta invocaciones.
// Cero red, cero filesystem, cero shell-out. Cubre TTL hit/miss/expiry, no-cache
// de ok:false, fail-open ante error de impl, no-colisión por cwd/bin, evicción
// LRU y derivación de key solo desde args normalizados (REQ-SEC-1..4).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeCachedImpl, DEFAULT_TTL_MS, DEFAULT_MAX_ENTRIES } = require('../evidence-cache');

// -----------------------------------------------------------------------------
// Helper: impl real falsa que cuenta llamadas y devuelve un resultado fijo.
// -----------------------------------------------------------------------------
function countingImpl(result) {
    let calls = 0;
    const fn = async () => { calls++; return result; };
    fn.calls = () => calls;
    return fn;
}

// Reloj controlable.
function fakeClock(start = 1000) {
    let t = start;
    const now = () => t;
    now.advance = (ms) => { t += ms; };
    return now;
}

// =============================================================================
// CA-2 — hit dentro de TTL devuelve cacheado sin re-ejecutar.
// =============================================================================
test('hit dentro de TTL devuelve el resultado cacheado sin re-ejecutar la impl', async () => {
    const real = countingImpl({ ok: true, stdout: 'abc', code: 0 });
    const now = fakeClock();
    const cached = makeCachedImpl(real, { now, ttlMs: 7000, bin: 'git' });
    const params = { args: ['ls-tree', 'origin/main'], cwd: '/repo', timeoutMs: 800 };

    const r1 = await cached(params);
    now.advance(3000); // dentro del TTL
    const r2 = await cached(params);

    assert.deepEqual(r1, { ok: true, stdout: 'abc', code: 0 });
    assert.deepEqual(r2, r1);
    assert.equal(real.calls(), 1, 'la segunda llamada debió servirse de la caché');
});

// =============================================================================
// CA-2 — miss tras expiry del TTL re-ejecuta live.
// =============================================================================
test('miss tras TTL-expiry re-ejecuta la impl live', async () => {
    const real = countingImpl({ ok: true, stdout: 'x', code: 0 });
    const now = fakeClock();
    const cached = makeCachedImpl(real, { now, ttlMs: 7000, bin: 'git' });
    const params = { args: ['rev-parse', 'HEAD'], cwd: '/repo' };

    await cached(params);
    now.advance(7001); // justo después de expirar
    await cached(params);

    assert.equal(real.calls(), 2, 'tras el TTL debe re-ejecutarse');
});

test('en el borde exacto del TTL (now-at === ttl) ya se considera expirado', async () => {
    const real = countingImpl({ ok: true, stdout: 'x', code: 0 });
    const now = fakeClock();
    const cached = makeCachedImpl(real, { now, ttlMs: 5000 });
    const params = { args: ['a'], cwd: '/r' };

    await cached(params);
    now.advance(5000); // (now - at) === ttl → NO es < ttl → miss
    await cached(params);

    assert.equal(real.calls(), 2);
});

// =============================================================================
// REQ-SEC-3 — NO se cachean resultados ok:false / timeout / not_verifiable.
// =============================================================================
test('ok:false NO se cachea (cada llamada re-ejecuta live)', async () => {
    const real = countingImpl({ ok: false, stdout: '', code: 1 });
    const now = fakeClock();
    const cached = makeCachedImpl(real, { now });
    const params = { args: ['view', '1732'], cwd: '/repo' };

    await cached(params);
    await cached(params); // dentro del TTL pero el previo fue ok:false → no cacheado

    assert.equal(real.calls(), 2, 'un ok:false nunca debe cachearse');
});

test('resultado sin ok:true (undefined/null) NO se cachea', async () => {
    const real = countingImpl(undefined);
    const now = fakeClock();
    const cached = makeCachedImpl(real, { now });
    const params = { args: ['a'], cwd: '/r' };

    await cached(params);
    await cached(params);

    assert.equal(real.calls(), 2);
});

// =============================================================================
// REQ-SEC-3 — fail-open: si la impl lanza, se reintenta live (nunca un verdict
// cacheado).
// =============================================================================
test('error de la impl → fail-open a ejecución live (sin cachear)', async () => {
    let calls = 0;
    const real = async () => {
        calls++;
        if (calls === 1) throw new Error('boom transitorio');
        return { ok: true, stdout: 'ok', code: 0 };
    };
    const now = fakeClock();
    const cached = makeCachedImpl(real, { now });
    const res = await cached({ args: ['a'], cwd: '/r' });

    assert.deepEqual(res, { ok: true, stdout: 'ok', code: 0 });
    assert.equal(calls, 2, 'debió reintentar live tras el throw');
});

// =============================================================================
// REQ-SEC-1 — no-colisión: distinto cwd / distinto bin → distinta key.
// =============================================================================
test('cwd distinto NO colisiona (anti cache-poisoning entre worktrees)', async () => {
    const real = countingImpl({ ok: true, stdout: 'same-cmd', code: 0 });
    const now = fakeClock();
    const cached = makeCachedImpl(real, { now, bin: 'git' });

    await cached({ args: ['status'], cwd: '/repo-A' });
    await cached({ args: ['status'], cwd: '/repo-B' });

    assert.equal(real.calls(), 2, 'mismos args pero distinto cwd no deben compartir entrada');
});

test('bin distinto NO colisiona (git vs gh con args iguales)', async () => {
    const realGit = countingImpl({ ok: true, stdout: 'g', code: 0 });
    const realGh = countingImpl({ ok: true, stdout: 'h', code: 0 });
    const now = fakeClock();
    const cg = makeCachedImpl(realGit, { now, bin: 'git' });
    const ch = makeCachedImpl(realGh, { now, bin: 'gh' });

    // Aunque cada wrapper tiene su propio store, la key incluye `bin` para que
    // un eventual store compartido tampoco colisione.
    const a = await cg({ args: ['x'], cwd: '/r' });
    const b = await ch({ args: ['x'], cwd: '/r' });
    assert.equal(a.stdout, 'g');
    assert.equal(b.stdout, 'h');
});

// =============================================================================
// REQ-SEC-1 — la key deriva SOLO de args normalizados: args distintos → miss.
// =============================================================================
test('args distintos producen entradas distintas; args iguales comparten entrada', async () => {
    const real = countingImpl({ ok: true, stdout: 'r', code: 0 });
    const now = fakeClock();
    const cached = makeCachedImpl(real, { now });

    await cached({ args: ['view', '1'], cwd: '/r' });
    await cached({ args: ['view', '2'], cwd: '/r' }); // distinto arg → miss
    await cached({ args: ['view', '1'], cwd: '/r' }); // igual al primero → hit

    assert.equal(real.calls(), 2);
});

// =============================================================================
// REQ-SEC-4 — evicción al superar maxEntries (LRU).
// =============================================================================
test('evicción: al superar maxEntries se descarta la entrada más vieja', async () => {
    const real = countingImpl({ ok: true, stdout: 'r', code: 0 });
    const now = fakeClock();
    const cached = makeCachedImpl(real, { now, maxEntries: 2 });

    await cached({ args: ['1'], cwd: '/r' }); // entrada A
    await cached({ args: ['2'], cwd: '/r' }); // entrada B
    await cached({ args: ['3'], cwd: '/r' }); // entrada C → evicta A (la más vieja)
    assert.equal(cached._cacheSize(), 2);

    await cached({ args: ['1'], cwd: '/r' }); // A fue evictada → re-ejecuta
    assert.equal(real.calls(), 4, 'la entrada evictada debe re-ejecutarse');
});

test('LRU touch: un hit refresca el orden y evita la evicción de la entrada usada', async () => {
    const real = countingImpl({ ok: true, stdout: 'r', code: 0 });
    const now = fakeClock();
    const cached = makeCachedImpl(real, { now, maxEntries: 2 });

    await cached({ args: ['A'], cwd: '/r' }); // A
    await cached({ args: ['B'], cwd: '/r' }); // B
    await cached({ args: ['A'], cwd: '/r' }); // hit A → A pasa a ser la más reciente
    await cached({ args: ['C'], cwd: '/r' }); // inserta C → evicta B (la más vieja ahora)

    const callsBefore = real.calls();
    await cached({ args: ['A'], cwd: '/r' }); // A sigue cacheada → hit
    assert.equal(real.calls(), callsBefore, 'A no debió re-ejecutarse (fue refrescada por LRU)');
});

// =============================================================================
// REQ-SEC-2 — defaults seguros y solo-memoria.
// =============================================================================
test('defaults: TTL corto (≤10s) y maxEntries acotado', () => {
    assert.ok(DEFAULT_TTL_MS > 0 && DEFAULT_TTL_MS <= 10000, 'TTL debe ser ≤10s (anti-stale)');
    assert.ok(DEFAULT_MAX_ENTRIES > 0 && DEFAULT_MAX_ENTRIES <= 1024, 'maxEntries acotado');
});

test('makeCachedImpl con realImpl no-función lanza TypeError', () => {
    assert.throws(() => makeCachedImpl(null), TypeError);
    assert.throws(() => makeCachedImpl('git'), TypeError);
});

// =============================================================================
// REQ-SEC-3 — robustez: params malformados (sin args) caen a live sin romper.
// =============================================================================
test('params sin args válidos no rompen: cae a ejecución live', async () => {
    const real = countingImpl({ ok: true, stdout: 'r', code: 0 });
    const now = fakeClock();
    const cached = makeCachedImpl(real, { now });

    const r = await cached({ cwd: '/r' }); // sin args → key con args=[]
    assert.deepEqual(r, { ok: true, stdout: 'r', code: 0 });
    assert.equal(real.calls(), 1);
});

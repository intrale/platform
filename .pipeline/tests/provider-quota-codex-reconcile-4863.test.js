'use strict';

// =============================================================================
// #4863 — Cuota de Codex: fuente única de verdad + reconciliación tarjeta↔banner.
//
// Verifica el fix del `enrich()` mode 'event': tres estados explícitos
// (ok / exhausted / nodata) en vez del booleano `eventOk` que colapsaba
// "sin dato por inactividad" con "sin límite" (verde espurio). Cubre los
// escenarios Gherkin #1 (tarjeta y banner nunca se contradicen) y #2 (tras
// inactividad se muestra "sin dato", no "sin límite").
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

const pq = require('../lib/provider-quota');

function norm(provider) {
    return {
        provider,
        adapterStatus: 'ok',
        session: { pct: null, confidence: 'missing' },
        weekly: { pct: null, confidence: 'missing' },
    };
}

// ---------------------------------------------------------------------------
// Estado 'ok' — dato fresco y sin tope → "sin límite" real.
// ---------------------------------------------------------------------------
test('Codex: adapter ok + status ok → eventState ok (sin límite), eventOk true', () => {
    const n = norm('openai-codex');
    pq.enrich('openai-codex', n, { adapterStatus: 'ok', status: 'ok' }, { cache: {}, now: Date.now() });
    assert.equal(n.session.eventState, 'ok');
    assert.equal(n.session.eventOk, true);
    assert.equal(n.session.eventExhausted, false);
    assert.equal(n.weekly.eventState, 'ok');
});

test('Codex: status warning (uso alto pero fresco) sigue siendo eventState ok', () => {
    const n = norm('openai-codex');
    pq.enrich('openai-codex', n, { adapterStatus: 'ok', status: 'warning' }, { cache: {}, now: Date.now() });
    assert.equal(n.session.eventState, 'ok', 'warning no es tope activo, es uso alto con dato fresco');
    assert.equal(n.session.eventOk, true);
});

// ---------------------------------------------------------------------------
// Estado 'exhausted' — tope real activo. Dos fuentes: adapter critical o el
// flag `quota-exhausted` (misma fuente que el banner).
// ---------------------------------------------------------------------------
test('Codex: status critical → eventState exhausted (tope activo)', () => {
    const n = norm('openai-codex');
    pq.enrich('openai-codex', n, { adapterStatus: 'ok', status: 'critical' }, { cache: {}, now: Date.now() });
    assert.equal(n.session.eventState, 'exhausted');
    assert.equal(n.session.eventOk, false);
    assert.equal(n.session.eventExhausted, true);
});

test('Gherkin #1: banner dice agotada (flag) → la tarjeta NO dice "sin límite"', () => {
    // El adapter SQLite reporta dato fresco sin tope (status ok), pero el flag
    // de cuota agotada (banner) marca a openai-codex como agotado. La tarjeta
    // debe reconciliar y mostrar "tope activo", nunca "sin límite".
    const n = norm('openai-codex');
    pq.enrich('openai-codex', n, { adapterStatus: 'ok', status: 'ok' },
        { cache: {}, now: Date.now(), exhaustedProviders: new Set(['openai-codex']) });
    assert.equal(n.session.eventState, 'exhausted', 'reconciliado con el banner');
    assert.equal(n.session.eventOk, false);
    assert.equal(n.weekly.eventState, 'exhausted');
});

test('Reconciliación: el flag exhausted acepta también Array de provider ids', () => {
    const n = norm('openai-codex');
    pq.enrich('openai-codex', n, { adapterStatus: 'ok', status: 'ok' },
        { cache: {}, now: Date.now(), exhaustedProviders: ['openai-codex'] });
    assert.equal(n.session.eventState, 'exhausted');
});

test('Reconciliación: flag de OTRO provider no marca a Codex como agotado', () => {
    const n = norm('openai-codex');
    pq.enrich('openai-codex', n, { adapterStatus: 'ok', status: 'ok' },
        { cache: {}, now: Date.now(), exhaustedProviders: new Set(['anthropic']) });
    assert.equal(n.session.eventState, 'ok', 'scope por-proveedor: Anthropic agotado no afecta a Codex');
    assert.equal(n.session.eventOk, true);
});

// ---------------------------------------------------------------------------
// Estado 'nodata' — sin dato fresco. El bug histórico: 'unknown' (stale por
// inactividad) daba eventOk=true → "sin límite" espurio.
// ---------------------------------------------------------------------------
test('Gherkin #2: adapter unknown (stale >1h) → eventState nodata, NUNCA "sin límite"', () => {
    const n = norm('openai-codex');
    // El adapter Codex devuelve adapterStatus 'unknown' + status 'unknown'
    // cuando el último evento codex.rate_limits es más viejo que el umbral.
    pq.enrich('openai-codex', n, { adapterStatus: 'unknown', status: 'unknown' }, { cache: {}, now: Date.now() });
    assert.equal(n.session.eventState, 'nodata', 'stale → sin dato, no verde');
    assert.equal(n.session.eventOk, false, 'eventOk false → el render NO pinta "sin límite"');
    assert.equal(n.session.eventExhausted, false, 'sin dato ≠ agotada');
    assert.equal(n.weekly.eventState, 'nodata');
});

test('Codex: adapter no_usage_data → eventState nodata (sin consumo medido, no verde)', () => {
    const n = norm('openai-codex');
    pq.enrich('openai-codex', n, { adapterStatus: 'no_usage_data', status: 'unknown' }, { cache: {}, now: Date.now() });
    assert.equal(n.session.eventState, 'nodata');
    assert.equal(n.session.eventOk, false);
});

test('Codex: adapter error → eventState nodata (no verde, no agotada)', () => {
    const n = norm('openai-codex');
    pq.enrich('openai-codex', n, { adapterStatus: 'error', status: 'unknown' }, { cache: {}, now: Date.now() });
    assert.equal(n.session.eventState, 'nodata');
    assert.equal(n.session.eventOk, false);
});

test('Codex: los tres estados son mutuamente excluyentes (nunca dos true a la vez)', () => {
    const cases = [
        { r: { adapterStatus: 'ok', status: 'ok' }, expect: 'ok' },
        { r: { adapterStatus: 'ok', status: 'critical' }, expect: 'exhausted' },
        { r: { adapterStatus: 'unknown', status: 'unknown' }, expect: 'nodata' },
    ];
    for (const c of cases) {
        const n = norm('openai-codex');
        pq.enrich('openai-codex', n, c.r, { cache: {}, now: Date.now() });
        assert.equal(n.session.eventState, c.expect);
        assert.equal(n.session.eventOk, c.expect === 'ok');
        assert.equal(n.session.eventExhausted, c.expect === 'exhausted');
    }
});

// ---------------------------------------------------------------------------
// Helper puro _isProviderExhausted.
// ---------------------------------------------------------------------------
test('_isProviderExhausted: Set / Array / ausencia', () => {
    assert.equal(pq._isProviderExhausted('openai-codex', { exhaustedProviders: new Set(['openai-codex']) }), true);
    assert.equal(pq._isProviderExhausted('openai-codex', { exhaustedProviders: ['openai-codex'] }), true);
    assert.equal(pq._isProviderExhausted('openai-codex', { exhaustedProviders: new Set(['anthropic']) }), false);
    assert.equal(pq._isProviderExhausted('openai-codex', {}), false, 'sin señal → fail-safe false');
    assert.equal(pq._isProviderExhausted('openai-codex', null), false);
    assert.equal(pq._isProviderExhausted('openai-codex', undefined), false);
});

// =============================================================================
// desync-additive-repair-5882.test.js — Predicado de traza legítima de
// `/wave add` y su batería negativa (#5882 CA-3, CA-4, CA-5).
//
// El bug: el realign del Pulpo sólo reparaba la divergencia REDUCTIVA (issue en
// la ola, falta en la allowlist) cuando los issues estaban CERRADOS. Con un
// issue ABIERTO — exactamente el escenario de una promoción recién hecha — el
// desync quedaba vivo y el pipeline se frenaba fail-closed.
//
// La reparación se autoriza por una entry `issue_added` del audit encadenado
// con `source` en un enum CERRADO, NUNCA por `actor`: los `actor` colisionan
// entre la promoción del operador y las reconciliaciones automáticas, y una de
// esas nace de una superficie EXTERNA (issue creado en GitHub).
//
// Ejecutar:  node --test .pipeline/lib/__tests__/desync-additive-repair-5882.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const legitAddTrace = require('../legit-add-trace');

const AHORA = Date.parse('2026-08-13T12:00:00.000Z');
const TTL = 90 * 1000;

// Entry de wave-audit sintética.
function waveEntry({ issue, source, event = 'issue_added', offsetMs = -1000 }) {
    return {
        event,
        wave: 1,
        issue,
        actor: 'wave-promote',
        source,
        timestamp: new Date(AHORA + offsetMs).toISOString(),
    };
}

// Entry de partial-pause-audit sintética.
function ppEntry({ removed = [], added = [], offsetMs = -1000, action = 'write' }) {
    return {
        action,
        authorized_by: 'commander:leo',
        diff: { added, removed },
        timestamp: new Date(AHORA + offsetMs).toISOString(),
    };
}

function llamar(candidates, { wave = [], pp = [], isClosed } = {}) {
    return legitAddTrace.isLegitimateRecentWaveAdd(candidates, {
        now: AHORA,
        ttlMs: TTL,
        isClosed,
        waveAuditReader: () => wave,
        auditReader: () => pp,
    });
}

// ─── CA-3 — camino legítimo ───────────────────────────────────────────────

test('un issue ABIERTO con traza reciente de wave-add del operador es legítimo', () => {
    const r = llamar([9003], {
        wave: [waveEntry({ issue: 9003, source: 'telegram-commander/wave-add' })],
        isClosed: () => false,
    });
    assert.deepEqual(r, [9003]);
});

test('el binding es POR ISSUE: una promoción de N no legitima un M ajeno', () => {
    const r = llamar([9003, 9999], {
        wave: [waveEntry({ issue: 9003, source: 'telegram-commander/wave-add' })],
        isClosed: () => false,
    });
    assert.deepEqual(r, [9003], '9999 no tiene traza propia');
});

test('devuelve el subconjunto ordenado y sin duplicados', () => {
    const r = llamar([9005, 9003, 9003], {
        wave: [
            waveEntry({ issue: 9003, source: 'telegram-commander/wave-add' }),
            waveEntry({ issue: 9005, source: 'telegram-commander/wave-add' }),
        ],
        isClosed: () => false,
    });
    assert.deepEqual(r, [9003, 9005]);
});

// ─── CA-5 / SEC — batería negativa (fail-closed) ──────────────────────────

test('source `split-github-reconcile` NO legitima (superficie externa: crear un issue en GitHub)', () => {
    const r = llamar([9003], {
        wave: [waveEntry({ issue: 9003, source: 'split-github-reconcile' })],
        isClosed: () => false,
    });
    assert.deepEqual(r, [], 'crear un issue en GitHub no debe habilitar despacho automático');
});

test('source `wave-promote:resync-additive` NO legitima (reconciliación automática, no intención humana)', () => {
    const r = llamar([9003], {
        wave: [waveEntry({ issue: 9003, source: 'wave-promote:resync-additive' })],
        isClosed: () => false,
    });
    assert.deepEqual(r, []);
});

test('una entry legacy SIN campo source NO legitima (fail-safe)', () => {
    const entry = waveEntry({ issue: 9003, source: 'telegram-commander/wave-add' });
    delete entry.source;
    const r = llamar([9003], { wave: [entry], isClosed: () => false });
    assert.deepEqual(r, [], 'undefined ∉ enum cerrado');
});

test('una traza fuera de TTL NO legitima', () => {
    const r = llamar([9003], {
        wave: [waveEntry({ issue: 9003, source: 'telegram-commander/wave-add', offsetMs: -(TTL + 5000) })],
        isClosed: () => false,
    });
    assert.deepEqual(r, []);
});

test('un evento que no es issue_added NO legitima', () => {
    const r = llamar([9003], {
        wave: [waveEntry({ issue: 9003, source: 'telegram-commander/wave-add', event: 'issue_removed' })],
        isClosed: () => false,
    });
    assert.deepEqual(r, []);
});

test('un issue CERRADO NO se repara', () => {
    const r = llamar([9003], {
        wave: [waveEntry({ issue: 9003, source: 'telegram-commander/wave-add' })],
        isClosed: (n) => n === 9003,
    });
    assert.deepEqual(r, []);
});

test('un timestamp inválido NO legitima', () => {
    const entry = waveEntry({ issue: 9003, source: 'telegram-commander/wave-add' });
    entry.timestamp = 'no-es-una-fecha';
    const r = llamar([9003], { wave: [entry], isClosed: () => false });
    assert.deepEqual(r, []);
});

test('un audit ilegible NO legitima nada (fail-safe)', () => {
    const r = legitAddTrace.isLegitimateRecentWaveAdd([9003], {
        now: AHORA,
        ttlMs: TTL,
        isClosed: () => false,
        waveAuditReader: () => { throw new Error('audit corrupto'); },
        auditReader: () => [],
    });
    assert.deepEqual(r, []);
});

test('un reader que devuelve algo que no es array NO legitima nada', () => {
    const r = legitAddTrace.isLegitimateRecentWaveAdd([9003], {
        now: AHORA,
        ttlMs: TTL,
        waveAuditReader: () => null,
        auditReader: () => [],
    });
    assert.deepEqual(r, []);
});

test('candidatos vacíos o inválidos devuelven lista vacía', () => {
    assert.deepEqual(llamar([]), []);
    assert.deepEqual(llamar(null), []);
    assert.deepEqual(llamar([0, -3, 'x', null]), []);
});

// ─── Anti-replay: la última intención humana gana ─────────────────────────

test('una remoción humana POSTERIOR a la traza NO se pisa (anti-replay)', () => {
    const r = llamar([9003], {
        wave: [waveEntry({ issue: 9003, source: 'telegram-commander/wave-add', offsetMs: -60000 })],
        pp: [ppEntry({ removed: [9003], offsetMs: -30000 })],
        isClosed: () => false,
    });
    assert.deepEqual(r, [], 'el operador lo sacó después de promoverlo: manda la última intención');
});

test('una remoción ANTERIOR a la traza no bloquea la reparación', () => {
    const r = llamar([9003], {
        wave: [waveEntry({ issue: 9003, source: 'telegram-commander/wave-add', offsetMs: -30000 })],
        pp: [ppEntry({ removed: [9003], offsetMs: -60000 })],
        isClosed: () => false,
    });
    assert.deepEqual(r, [9003], 'la promoción es lo más reciente');
});

test('una remoción posterior de OTRO issue no bloquea la reparación', () => {
    const r = llamar([9003], {
        wave: [waveEntry({ issue: 9003, source: 'telegram-commander/wave-add', offsetMs: -60000 })],
        pp: [ppEntry({ removed: [7777], offsetMs: -30000 })],
        isClosed: () => false,
    });
    assert.deepEqual(r, [9003]);
});

// ─── Contrato del enum + no-regresión del predicado hermano ───────────────

test('el enum de sources válidos es cerrado y contiene sólo la promoción del operador', () => {
    assert.deepEqual([...legitAddTrace.VALID_WAVE_ADD_SOURCES], ['telegram-commander/wave-add']);
    assert.equal(Object.isFrozen(legitAddTrace.VALID_WAVE_ADD_SOURCES), true);
});

test('isLegitimateRecentAdd (predicado hermano) sigue existiendo e intacto', () => {
    assert.equal(typeof legitAddTrace.isLegitimateRecentAdd, 'function');
    // Opera sobre partial-pause-audit y `diff.added` — dirección opuesta.
    const r = legitAddTrace.isLegitimateRecentAdd([9003], {
        now: AHORA,
        ttlMs: TTL,
        auditReader: () => [{
            action: 'write',
            authorized_by: 'wave-promote',
            diff: { added: [9003], removed: [] },
            timestamp: new Date(AHORA - 1000).toISOString(),
        }],
    });
    assert.deepEqual(r, [9003]);
});

// =============================================================================
// rewind-messages.test.js — Tests de copy del rewind (#3416 G-UX-1..7).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const msgs = require('../rewind-messages');

// RNG determinístico — devuelve siempre 0 para que pick() devuelva la primera
// variante. Usamos otros valores para verificar las demás variantes.
function fakeRng(value) {
    return () => value;
}

test('buildSuccessMessage genera mensaje con link al issue', () => {
    const s = msgs.buildSuccessMessage({
        issue: 3416,
        target: { pipeline: 'desarrollo', fase: 'validacion', skill: 'ux' },
        fromPipeline: 'desarrollo',
        fromFase: 'aprobacion',
        rng: fakeRng(0),
    });
    assert.match(s, /3416/);
    assert.match(s, /desarrollo\/validacion/);
    assert.match(s, /https:\/\/github\.com\/intrale\/platform\/issues\/3416/);
});

test('buildSuccessMessage tiene ≥3 variantes (G-UX-1)', () => {
    // Probamos 3 RNGs distintos y verificamos que aparecen ≥3 textos distintos.
    const seen = new Set();
    for (let i = 0; i < 3; i++) {
        seen.add(msgs.buildSuccessMessage({
            issue: 3416,
            target: { pipeline: 'desarrollo', fase: 'validacion', skill: 'ux' },
            fromPipeline: 'desarrollo',
            fromFase: 'aprobacion',
            rng: fakeRng(i / 3),
        }));
    }
    assert.ok(seen.size >= 3, `esperaba ≥3 variantes, obtuve ${seen.size}`);
});

test('buildTruncateMessage menciona el tamaño original en KB', () => {
    const s = msgs.buildTruncateMessage({ issue: 3416, originalBytes: 3072, rng: fakeRng(0) });
    assert.match(s, /3\.0 KB/);
    assert.match(s, /2 KB/);
});

test('buildInjectionBlockedMessage menciona SOLO el patrón que matcheó (no la lista)', () => {
    const s = msgs.buildInjectionBlockedMessage({
        issue: 3416,
        matchedDescription: 'imperativo "ignorar instrucciones previas"',
        rng: fakeRng(0),
    });
    assert.match(s, /ignorar instrucciones previas/);
    // No debe pegar todos los patrones (sería manual de bypass).
    assert.equal(s.includes('disregard'), false);
    assert.equal(s.includes('descartá'), false);
});

test('buildRateLimitWarning tono cálido + sugerencia accionable', () => {
    const s = msgs.buildRateLimitWarning({
        issue: 3416,
        recentCount: 12,
        target: { skill: 'ux' },
        rng: fakeRng(0),
    });
    assert.match(s, /12/);
    // Sugerencia explícita G-UX-6.
    assert.match(s, /criterios-ux/);
});

test('buildErrorMessage cubre ALIAS_NOT_IN_WHITELIST con lista de aliases', () => {
    const s = msgs.buildErrorMessage('ALIAS_NOT_IN_WHITELIST', {
        alias: 'inventado',
        normalizedAlias: 'inventado',
    });
    assert.match(s, /inventado/);
    assert.match(s, /Aliases? v[áa]lidos?/i);
    // Verificar que enumera al menos uno conocido.
    assert.ok(s.includes('ux') || s.includes('po'));
});

test('buildErrorMessage cubre FUTURE_PHASE con contexto de fase actual', () => {
    const s = msgs.buildErrorMessage('FUTURE_PHASE', {
        issue: 3416,
        target: { pipeline: 'desarrollo', fase: 'aprobacion' },
        fromPipeline: 'desarrollo',
        fromFase: 'dev',
    });
    assert.match(s, /3416/);
    assert.match(s, /aprobacion/);
    assert.match(s, /dev/);
    assert.match(s, /hacia atr[áa]s/);
});

test('buildErrorMessage con código desconocido devuelve fallback con código en literal', () => {
    const s = msgs.buildErrorMessage('FOO_BAR_INEXISTENTE', { issue: 3416 });
    assert.match(s, /FOO_BAR_INEXISTENTE/);
});

test('buildErrorMessage cubre AGENT_KILL_FAILED con grace time', () => {
    const s = msgs.buildErrorMessage('AGENT_KILL_FAILED', {
        issue: 3416,
        target: { skill: 'ux' },
        killGraceMs: 30000,
    });
    assert.match(s, /ux/);
    assert.match(s, /30s/);
    assert.match(s, /\/agents/);
});

test('Todos los códigos del PO tienen builder de error (G-UX-7 tabla canónica)', () => {
    // CA-G-UX-7: tabla canónica de errores implementada.
    const required = [
        'ALIAS_NOT_IN_WHITELIST',
        'FUTURE_PHASE',
        'NO_RETURN_STATE',
        'ISSUE_INVALID',
        'SOURCE_NOT_AUTHORIZED',
        'AGENT_KILL_FAILED',
    ];
    for (const code of required) {
        assert.ok(msgs.ERROR_BUILDERS[code], `falta builder para ${code}`);
    }
});

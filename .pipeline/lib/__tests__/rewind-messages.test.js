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

// =============================================================================
// #6747 — copy del canal de rescate a `dev`
// =============================================================================

const phaseMapping = require('../pipeline-phase-mapping');

test('#6747 CA-UX-1: buildSuccessMessage con target de dev dice el skill real, nunca `dev/null`', () => {
    // El defecto original: el target llegaba con `skill: null` y las 3 variantes
    // renderizaban `desarrollo/dev/null`.
    for (const r of [0, 0.4, 0.8]) {
        const s = msgs.buildSuccessMessage({
            issue: 6747,
            target: { pipeline: 'desarrollo', fase: 'dev', skill: 'backend-dev', skillSource: 'direct-label' },
            fromPipeline: 'desarrollo',
            fromFase: 'verificacion',
            rng: fakeRng(r),
        });
        assert.match(s, /desarrollo\/dev\/backend-dev/);
        assert.doesNotMatch(s, /null/, `la variante rng=${r} filtró un null`);
    }
});

test('#6747 CA-UX-2: skillSource content-override avisa que el skill lo eligió el sistema', () => {
    const s = msgs.buildSuccessMessage({
        issue: 6747,
        target: { pipeline: 'desarrollo', fase: 'dev', skill: 'pipeline-dev', skillSource: 'content-override' },
        fromPipeline: 'desarrollo',
        fromFase: 'verificacion',
        rng: fakeRng(0),
    });
    assert.match(s, /pipeline-dev/);
    assert.match(s, /no lo pediste vos/i);
    assert.match(s, /alias expl[íi]cito/i);
});

test('#6747 CA-UX-2: con otro skillSource esa línea NO aparece', () => {
    for (const skillSource of ['direct-label', 'priority-label', 'alias-explicit', undefined]) {
        const s = msgs.buildSuccessMessage({
            issue: 6747,
            target: { pipeline: 'desarrollo', fase: 'dev', skill: 'backend-dev', skillSource },
            fromPipeline: 'desarrollo',
            fromFase: 'verificacion',
            rng: fakeRng(0),
        });
        assert.doesNotMatch(s, /no lo pediste vos/i, `skillSource=${skillSource} no debería avisar`);
    }
});

test('#6747 CA-UX-2: las 3 variantes existentes no se tocaron', () => {
    // Sin content-override, el mensaje es exactamente el de siempre.
    const s = msgs.buildSuccessMessage({
        issue: 3416,
        target: { pipeline: 'desarrollo', fase: 'validacion', skill: 'ux' },
        fromPipeline: 'desarrollo',
        fromFase: 'aprobacion',
        rng: fakeRng(0),
    });
    assert.match(s, /^Listo, rebobiné #3416 a `desarrollo\/validacion\/ux`\./);
});

test('#6747 CA-UX-3: el tip de rate limit nunca ofrece un alias inexistente', () => {
    // `criterios-backend-dev` no está en la whitelist: ofrecerlo mandaba al
    // operador derecho a un ALIAS_NOT_IN_WHITELIST.
    for (const skill of ['backend-dev', 'android-dev', 'pipeline-dev', 'web-dev']) {
        const s = msgs.buildRateLimitWarning({
            issue: 6747,
            recentCount: 12,
            target: { pipeline: 'desarrollo', fase: 'dev', skill },
            rng: fakeRng(0),
        });
        assert.doesNotMatch(s, new RegExp(`criterios-${skill}`), `ofreció criterios-${skill}, que no existe`);
        assert.match(s, /alias expl[íi]cito/i, 'debe caer al tip genérico');
    }
});

test('#6747 CA-UX-3: si el alias derivado SÍ existe, el tip lo sigue ofreciendo', () => {
    const s = msgs.buildRateLimitWarning({
        issue: 3416,
        recentCount: 12,
        target: { pipeline: 'desarrollo', fase: 'validacion', skill: 'ux' },
        rng: fakeRng(0),
    });
    assert.ok(phaseMapping.listAliases().includes('criterios-ux'));
    assert.match(s, /criterios-ux/);
});

test('#6747 CA-UX-3: todo alias que el tip ofrezca está en la whitelist', () => {
    // Barrido: para cualquier skill del mapping, el tip nunca puede nombrar un
    // `criterios-*` que resolveAlias rechace.
    const aliases = phaseMapping.listAliases();
    for (const skill of ['ux', 'po', 'guru', 'backend-dev', 'review', 'tester', 'qa']) {
        const s = msgs.buildRateLimitWarning({
            issue: 3416, recentCount: 11,
            target: { pipeline: 'desarrollo', fase: 'dev', skill },
            rng: fakeRng(0),
        });
        const ofrecidos = s.match(/`\/rechazar \d+ ([a-z0-9-]+)`/g) || [];
        for (const raw of ofrecidos) {
            const alias = raw.match(/`\/rechazar \d+ ([a-z0-9-]+)`/)[1];
            assert.ok(aliases.includes(alias), `el tip ofreció "${alias}", que no está en la whitelist`);
        }
    }
});

test('#6747 D-5: los 3 códigos nuevos tienen builder propio (no caen al genérico)', () => {
    const nuevos = ['DEV_SKILL_UNRESOLVED', 'DEV_SKILL_NOT_DECLARED', 'DEV_SKILL_DEFAULT_FORBIDDEN'];
    for (const code of nuevos) {
        assert.ok(msgs.ERROR_BUILDERS[code], `falta builder para ${code}`);
        const s = msgs.buildErrorMessage(code, { issue: 6747, skill: 'web-dev' });
        // El fallback genérico pega el code en literal; un builder propio no.
        assert.doesNotMatch(s, new RegExp(code), `${code} cayó al mensaje genérico`);
    }
});

test('#6747 D-5: DEV_SKILL_UNRESOLVED dice que no se tocó nada y cómo arreglarlo', () => {
    const s = msgs.buildErrorMessage('DEV_SKILL_UNRESOLVED', { issue: 6747 });
    assert.match(s, /6747/);
    assert.match(s, /no toqu[ée] nada/i);
    assert.match(s, /labels/i);
});

test('#6747 D-5: DEV_SKILL_NOT_DECLARED nombra el skill que salió', () => {
    const s = msgs.buildErrorMessage('DEV_SKILL_NOT_DECLARED', { issue: 6747, skill: 'web-dev' });
    assert.match(s, /web-dev/);
    assert.match(s, /desarrollo\/dev/);
    assert.match(s, /sin mover nada/i);
});

test('#6747 D-5: DEV_SKILL_DEFAULT_FORBIDDEN explica por qué no eligió pipeline-dev', () => {
    const s = msgs.buildErrorMessage('DEV_SKILL_DEFAULT_FORBIDDEN', { issue: 6747 });
    assert.match(s, /pipeline-dev/);
    assert.match(s, /expl[íi]cito/i);
});

test('#6747: el alias `dev` aparece en la lista que ve el operador al errarle', () => {
    const s = msgs.buildErrorMessage('ALIAS_NOT_IN_WHITELIST', { alias: 'desarrollo' });
    assert.match(s, /\bdev\b/, 'el operador tiene que poder descubrir el alias nuevo');
});

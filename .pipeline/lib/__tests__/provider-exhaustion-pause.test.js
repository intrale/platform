// =============================================================================
// Tests provider-exhaustion-pause.js — Issue #3498
//
// Cobertura de los CA consolidados por po (#3498 c-4549199606):
//   CA-1  · Provider conocido → join(' / ') de quota_error_types.
//   CA-2  · Provider inexistente → fallback 'quota_exhausted'.
//   CA-3  · quota_error_types vacío o ausente → fallback.
//   CA-4  · loadAndValidate corrupto → fallback degraded + warning UNA vez.
//   CA-5  · opts.agentModels inyectado tiene precedencia sobre cache.
//   CA-6  · Memoización: una sola invocación a loadAndValidate por proceso.
//   CA-7  · formatExhaustionMessage usa getQuotaHint, no la constante vieja.
//   CA-9  · Cap defensivo slice(0, 5) antes del join (anti-DoS).
//   CA-10 · Sanitización por elemento contra Markdown injection.
//   CA-13 · Fallback informativo "config indisponible" sólo en degraded mode.
//   CA-14 · Wording del mensaje Telegram NO cambia (snapshot anti-regresión).
//   CA-15 · Suite completa (10 tests obligatorios).
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const mod = require('../provider-exhaustion-pause');
const { getQuotaHint, sanitizeHintElement, formatExhaustionMessage, _resetQuotaHintsCache } = mod;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fixtureConfig() {
    // Sub-set fiel del agent-models.json en HEAD (#3498 análisis).
    return {
        providers: {
            anthropic: {
                quota_error_types: ['usage_limit_error', 'weekly_quota_exhausted', 'snapshot_threshold_90'],
            },
            'openai-codex': {
                quota_error_types: ['insufficient_quota', 'billing_hard_limit_reached'],
            },
            'gemini-google': {
                quota_error_types: ['quota_exceeded', 'resource_exhausted'],
            },
            cerebras: {
                quota_error_types: ['rate_limit_exceeded', 'quota_exceeded'],
            },
            'nvidia-nim': {
                quota_error_types: ['rate_limit_exceeded', 'quota_exceeded', 'insufficient_quota'],
            },
            deterministic: {
                quota_error_types: [],
            },
        },
    };
}

function silentLogger() {
    const warnings = [];
    return {
        warnings,
        warn(...args) { warnings.push(args.join(' ')); },
    };
}

// Asegurar cache limpio antes de cada test para predecir warnings/loads.
test.beforeEach(() => { _resetQuotaHintsCache(); });

// ─── CA-1 · Provider conocido ────────────────────────────────────────────────

test('CA-1 — getQuotaHint devuelve los strings unidos por " / " para provider conocido', () => {
    const cfg = fixtureConfig();
    const hint = getQuotaHint('openai-codex', { agentModels: cfg });
    assert.equal(hint, 'insufficient_quota / billing_hard_limit_reached');
});

test('CA-1b — anthropic refleja el JSON actual (incluye snapshot_threshold_90)', () => {
    // Verifica explícitamente que el drift está cerrado: el hint Telegram
    // ahora refleja TODO el contenido de quota_error_types de anthropic, no
    // una constante hardcoded desactualizada.
    const hint = getQuotaHint('anthropic', { agentModels: fixtureConfig() });
    assert.equal(hint, 'usage_limit_error / weekly_quota_exhausted / snapshot_threshold_90');
});

// ─── CA-2 · Provider inexistente ─────────────────────────────────────────────

test('CA-2 — provider inexistente devuelve fallback plano', () => {
    const hint = getQuotaHint('foo-bar', { agentModels: fixtureConfig() });
    assert.equal(hint, 'quota_exhausted');
});

// ─── CA-3 · quota_error_types vacío o ausente ────────────────────────────────

test('CA-3a — quota_error_types vacío devuelve fallback plano (caso deterministic)', () => {
    const hint = getQuotaHint('deterministic', { agentModels: fixtureConfig() });
    assert.equal(hint, 'quota_exhausted');
});

test('CA-3b — quota_error_types ausente devuelve fallback plano', () => {
    const cfg = { providers: { someprov: { /* sin quota_error_types */ } } };
    const hint = getQuotaHint('someprov', { agentModels: cfg });
    assert.equal(hint, 'quota_exhausted');
});

// ─── CA-4 · loadAndValidate corrupto → fallback degraded + warning UNA vez ────

test('CA-4 — config sin loader → fallback degraded "config indisponible" + warning UNA vez', () => {
    // Forzamos el path "sin inyección" → el helper intenta el loader real.
    // Como en este worktree el loader carga OK normalmente, simulamos el modo
    // degraded inyectando un cache vacío manualmente vía falso loader.
    // Truco: pasamos un agentModels sin `providers` → el helper devuelve
    // fallback PLANO (no degraded) porque no hubo fallo de carga.
    //
    // Para forzar el path degraded de verdad, monkey-patcheamos
    // `loadAndValidate` del cache interno reimportando el módulo con un
    // require fresh + agent-models stub roto. Lo más limpio en Node test es
    // verificar el comportamiento via cache reset + mock del require interno.
    //
    // Workaround: probamos el path inyectando logger y forzando un objeto
    // que dispare la rama degraded a través del setter `_resetQuotaHintsCache`
    // tras un primer call que rompe.
    //
    // Estrategia: usamos `require.cache` para reemplazar transitoriamente
    // `agent-models` por un stub que tira al cargar.

    const path = require('path');
    const agentModelsPath = require.resolve('../agent-models');
    const originalModule = require.cache[agentModelsPath];

    // Stub loader que retorna { ok: false }.
    require.cache[agentModelsPath] = {
        id: agentModelsPath,
        filename: agentModelsPath,
        loaded: true,
        exports: {
            loadAndValidate() { return { ok: false, errors: [{ msg: 'corrupt' }] }; },
        },
    };

    // Recargar el módulo bajo test con el stub en place.
    const fresh = (() => {
        const p = require.resolve('../provider-exhaustion-pause');
        delete require.cache[p];
        return require('../provider-exhaustion-pause');
    })();

    try {
        const logger = silentLogger();
        const hint1 = fresh.getQuotaHint('anthropic', { logger });
        assert.equal(hint1, 'quota_exhausted (config indisponible)');
        assert.equal(logger.warnings.length, 1);

        // Segunda invocación: ya no debe loggear de nuevo (CA-4: warning UNA vez).
        const hint2 = fresh.getQuotaHint('cerebras', { logger });
        assert.equal(hint2, 'quota_exhausted (config indisponible)');
        assert.equal(logger.warnings.length, 1, 'warning emitido una sola vez por vida del proceso');
    } finally {
        // Restaurar el módulo original para no contaminar tests siguientes.
        if (originalModule) {
            require.cache[agentModelsPath] = originalModule;
        } else {
            delete require.cache[agentModelsPath];
        }
        delete require.cache[require.resolve('../provider-exhaustion-pause')];
    }
});

test('CA-4b — loadAndValidate que lanza excepción cae a fallback degraded', () => {
    const agentModelsPath = require.resolve('../agent-models');
    const originalModule = require.cache[agentModelsPath];

    require.cache[agentModelsPath] = {
        id: agentModelsPath,
        filename: agentModelsPath,
        loaded: true,
        exports: {
            loadAndValidate() { throw new Error('explota'); },
        },
    };

    const fresh = (() => {
        const p = require.resolve('../provider-exhaustion-pause');
        delete require.cache[p];
        return require('../provider-exhaustion-pause');
    })();

    try {
        const logger = silentLogger();
        const hint = fresh.getQuotaHint('anthropic', { logger });
        assert.equal(hint, 'quota_exhausted (config indisponible)');
        assert.equal(logger.warnings.length, 1);
    } finally {
        if (originalModule) {
            require.cache[agentModelsPath] = originalModule;
        } else {
            delete require.cache[agentModelsPath];
        }
        delete require.cache[require.resolve('../provider-exhaustion-pause')];
    }
});

// ─── CA-5 · Inyección precedente sobre cache ─────────────────────────────────

test('CA-5 — opts.agentModels inyectado tiene precedencia sobre el cache lazy', () => {
    // Primer call: poblar cache implícito con el config real (no inyectado).
    const realHint = getQuotaHint('anthropic');
    assert.ok(realHint.includes('usage_limit_error'),
        `el config real debería traer usage_limit_error, vino: ${realHint}`);

    // Segundo call con inyección: debe ganar el inject, no la cache.
    const injected = {
        providers: { anthropic: { quota_error_types: ['INJECTED_TYPE'] } },
    };
    const hint = getQuotaHint('anthropic', { agentModels: injected });
    assert.equal(hint, 'INJECTED_TYPE');
});

// ─── CA-6 · Memoización ──────────────────────────────────────────────────────

test('CA-6 — loadAndValidate se invoca UNA sola vez para múltiples invocaciones (memoización)', () => {
    const agentModelsPath = require.resolve('../agent-models');
    const originalModule = require.cache[agentModelsPath];

    let calls = 0;
    require.cache[agentModelsPath] = {
        id: agentModelsPath,
        filename: agentModelsPath,
        loaded: true,
        exports: {
            loadAndValidate() {
                calls += 1;
                return { ok: true, config: fixtureConfig() };
            },
        },
    };

    const fresh = (() => {
        const p = require.resolve('../provider-exhaustion-pause');
        delete require.cache[p];
        return require('../provider-exhaustion-pause');
    })();

    try {
        fresh.getQuotaHint('anthropic');
        fresh.getQuotaHint('openai-codex');
        fresh.getQuotaHint('foo-bar');
        fresh.getQuotaHint('cerebras');
        assert.equal(calls, 1, `loadAndValidate llamado 1 vez, fueron ${calls}`);
    } finally {
        if (originalModule) {
            require.cache[agentModelsPath] = originalModule;
        } else {
            delete require.cache[agentModelsPath];
        }
        delete require.cache[require.resolve('../provider-exhaustion-pause')];
    }
});

// ─── CA-9 · Cap defensivo ─────────────────────────────────────────────────────

test('CA-9 — provider con 10 elementos → exactamente 5 en el output (anti-DoS)', () => {
    const cfg = {
        providers: {
            bigprov: {
                quota_error_types: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
            },
        },
    };
    const hint = getQuotaHint('bigprov', { agentModels: cfg });
    assert.equal(hint, 'a / b / c / d / e');
    // Sanity check: exactamente 5 elementos separados por ' / '.
    assert.equal(hint.split(' / ').length, 5);
});

// ─── CA-10 · Sanitización por elemento ───────────────────────────────────────

test('CA-10 — input con caracteres Markdown maliciosos queda sanitizado', () => {
    const cfg = {
        providers: {
            evilprov: {
                quota_error_types: ['*[evil](http://x)*', 'normal_string', '`backtick`'],
            },
        },
    };
    const hint = getQuotaHint('evilprov', { agentModels: cfg });
    // Caracteres `*`, `[`, `]`, `(`, `)`, backtick removidos. El underscore
    // se preserva intencionalmente (ver JSDoc de sanitizeHintElement — CA-14
    // prevalece sobre injection italic, que no abre vector real).
    assert.equal(hint, 'evilhttp://x / normal_string / backtick');
    // Garantía explícita: ninguno de los chars realmente peligrosos sobrevive.
    for (const ch of ['*', '[', ']', '(', ')', '`']) {
        assert.ok(!hint.includes(ch), `el char "${ch}" debe estar eliminado`);
    }
    // Y el underscore se preserva para no destruir identificadores legítimos.
    assert.ok(hint.includes('normal_string'), 'underscore en identificadores preservado');
});

test('CA-10b — sanitizeHintElement maneja null/undefined sin throw', () => {
    assert.equal(sanitizeHintElement(null), '');
    assert.equal(sanitizeHintElement(undefined), '');
    assert.equal(sanitizeHintElement(42), '42');
});

// ─── CA-7 + CA-14 · Snapshot del mensaje Telegram ────────────────────────────

test('CA-7 + CA-14 — snapshot de formatExhaustionMessage para los 5 providers reales', () => {
    const cfg = fixtureConfig();
    const baseChain = ['anthropic', 'openai-codex'];

    for (const primary of ['anthropic', 'openai-codex', 'gemini-google', 'cerebras', 'nvidia-nim']) {
        const text = formatExhaustionMessage({
            skill: 'guru',
            issue: 9999,
            title: 'test',
            primary_provider: primary,
            chain_tried: baseChain,
            retry_interval_ms: 5 * 60 * 1000,
        }, { agentModels: cfg });

        // El wording alrededor del hint NO cambia (líneas estables del template).
        assert.ok(text.includes('🟧 *Pipeline pausado — cuota agotada*'), `header presente para ${primary}`);
        assert.ok(text.includes('Issue: [#9999 — test]'), `link al issue presente para ${primary}`);
        assert.ok(text.includes('Skill: `guru`'), `skill line presente para ${primary}`);
        assert.ok(text.includes(`Primary: \`${primary}\``), `primary line presente para ${primary}`);
        assert.ok(text.includes('Cadena intentada: `anthropic -> openai-codex`'), `chain line presente para ${primary}`);
        assert.ok(text.includes('provider-exhaustion-pause'), `label name presente para ${primary}`);
        assert.ok(text.includes('reintentar cada ~300s'), `ETA presente para ${primary}`);

        // El hint corresponde a la derivación de quota_error_types (CA-7).
        const expected = cfg.providers[primary].quota_error_types.slice(0, 5).join(' / ');
        assert.ok(text.includes(`(${expected})`),
            `hint derivado de agent-models.json para ${primary} = "(${expected})", body=${text}`);
    }
});

test('CA-13 — formatExhaustionMessage en modo degraded propaga el sufijo informativo', () => {
    const agentModelsPath = require.resolve('../agent-models');
    const originalModule = require.cache[agentModelsPath];

    require.cache[agentModelsPath] = {
        id: agentModelsPath,
        filename: agentModelsPath,
        loaded: true,
        exports: {
            loadAndValidate() { return { ok: false }; },
        },
    };

    const fresh = (() => {
        const p = require.resolve('../provider-exhaustion-pause');
        delete require.cache[p];
        return require('../provider-exhaustion-pause');
    })();

    try {
        const text = fresh.formatExhaustionMessage({
            skill: 'guru',
            issue: 1,
            primary_provider: 'anthropic',
            chain_tried: ['anthropic'],
            retry_interval_ms: 60000,
        }, { logger: silentLogger() });
        assert.ok(
            text.includes('(quota_exhausted (config indisponible))'),
            `el sufijo degraded debe aparecer en el mensaje Telegram, vino: ${text}`,
        );
    } finally {
        if (originalModule) {
            require.cache[agentModelsPath] = originalModule;
        } else {
            delete require.cache[agentModelsPath];
        }
        delete require.cache[require.resolve('../provider-exhaustion-pause')];
    }
});

// ─── Cleanup: confirmar que la constante vieja ya no está exportada ──────────

test('CA-8 — KNOWN_HINTS_BY_PROVIDER ya no se exporta (cleanup)', () => {
    assert.equal(typeof mod.KNOWN_HINTS_BY_PROVIDER, 'undefined',
        'KNOWN_HINTS_BY_PROVIDER debe quedar removido del module.exports');
});

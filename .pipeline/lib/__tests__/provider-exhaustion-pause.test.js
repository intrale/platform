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
        // #5467 · `stateDir` inexistente a propósito: sin él, el formateador
        // leería el snapshot de salud VIVO del pipeline y este test —que sólo
        // valida el wording del hint— pasaría a depender del estado real de los
        // providers, que rota en minutos. Fixture, nunca el archivo vivo (CA-12).
        }, { agentModels: cfg, stateDir: '/tmp/no-existe-5467-ca14' });

        // El wording alrededor del hint NO cambia (líneas estables del template).
        //
        // #5467 · El titular SÍ cambia, a propósito (Riesgo R1 de la receta):
        // "cuota agotada" era la atribución falsa que la historia elimina. El
        // resto de los asserts de este bloque son la anti-regresión de #3498 y
        // siguen verdes tal cual: el mensaje nuevo es ADITIVO (UX-V1), conserva
        // identidad, cola técnica y pie literales.
        assert.ok(text.includes('🟧 *Pipeline pausado — sin proveedor disponible*'), `header presente para ${primary}`);
        assert.ok(!text.includes('cuota agotada'), `CA-2: sin quota_exhausted_real el mensaje no habla de cuota agotada (${primary})`);
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
        }, { logger: silentLogger(), stateDir: '/tmp/no-existe-5467-ca13' });
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

// =============================================================================
// #5467 · Causa de la pausa en el mensaje de Telegram
//
//   CA-2  · El titular no dice "cuota agotada" sin quota_exhausted_real.
//   CA-3  · Pausa programada identificada como tal + hora de reanudación.
//   CA-5  · Veredicto y acción ARRIBA, sobreviven al truncado.
//   CA-6  · Con dato vencido nunca se promete recuperación automática.
//   CA-7  · Degradación sin excepción, titular neutro (Riesgo R2).
//   CA-8  · key_status / auth_mode nunca aparecen en el texto.
//   CA-10 · Dedup preservado + re-notificación por cambio de causa.
//   CA-13 · Causa transitoria con su propia línea de acción.
//
// TODOS con fixtures inyectados por `opts`, NUNCA contra el snapshot vivo.
// =============================================================================

const fsNode = require('node:fs');
const osNode = require('node:os');
const pathNode = require('node:path');

/** Lunes 21:00 ART — el instante que hace observable el merge de CA-4. */
const NOW_5467 = Date.parse('2026-08-04T00:00:00Z');

const SCHEDULE_5467 = {
    monday: [{ start: '00:00', end: '07:00' }, { start: '20:00', end: '00:00' }],
    tuesday: [{ start: '00:00', end: '07:00' }, { start: '20:00', end: '00:00' }],
    wednesday: [], thursday: [], friday: [], saturday: [], sunday: [],
};

function scheduleFor(resting = []) {
    return {
        isValidProvider: () => true,
        getProviderSchedule: (provider) => ({
            provider,
            active: resting.indexOf(provider) >= 0,
            schedule: SCHEDULE_5467,
            timezone: 'America/Argentina/Buenos_Aires',
        }),
    };
}

function stateDirWith(providers, ageMs = 60_000) {
    const dir = fsNode.mkdtempSync(pathNode.join(osNode.tmpdir(), 'exh-5467-'));
    fsNode.writeFileSync(
        pathNode.join(dir, 'multi-provider-health.json'),
        JSON.stringify({ ts: new Date(NOW_5467 - ageMs).toISOString(), providers }),
        'utf8',
    );
    return dir;
}

function healthRow(provider, label, reasonCode, pct = null) {
    return {
        provider, label, state: 'red', reason_code: reasonCode,
        quota: { pct }, key_status: 'not_applicable', auth_mode: 'oauth',
    };
}

function render5467(opts, payloadOverrides = {}) {
    return formatExhaustionMessage({
        skill: 'ux',
        issue: 5467,
        title: 'El aviso de pipeline pausado',
        primary_provider: 'anthropic',
        chain_tried: ['anthropic', 'openai-codex'],
        retry_interval_ms: 5 * 60 * 1000,
        ...payloadOverrides,
    }, { agentModels: fixtureConfig(), now: NOW_5467, ...opts });
}

// ─── Las cinco causas dominantes ─────────────────────────────────────────────

test('#5467 CA-3 — causa REPOSO: titular de pausa programada + hora REAL de reanudación', () => {
    const stateDir = stateDirWith([
        healthRow('anthropic', 'Anthropic', 'cli_oauth_ok'),
        healthRow('openai', 'OpenAI / Codex', 'cli_oauth_ok'),
    ]);
    const text = render5467({ stateDir, scheduleModule: scheduleFor(['anthropic', 'openai-codex']) });

    assert.ok(text.includes('🌙 *Pipeline en pausa programada*'), `titular de reposo, vino: ${text}`);
    assert.ok(text.includes('✅ Se recupera solo — reanuda mañana 07:00'), `hora fusionada, vino: ${text}`);
    // CA-4 en el mensaje entregado: sin el merge diría 00:00 y el operador
    // esperaría 4 horas de más.
    assert.ok(!text.includes('00:00'), 'jamás la medianoche del primer corte');
    assert.ok(text.includes('• Anthropic — en reposo hasta mañana 07:00'), 'desglose por proveedor');
    assert.ok(!text.includes('Requiere acción'), 'el reposo no requiere acción');
});

test('#5467 CA-1 — causa CUOTA: lista el porcentaje y pide acción', () => {
    const stateDir = stateDirWith([
        healthRow('anthropic', 'Anthropic', 'cli_oauth_ok'),
        healthRow('openai', 'OpenAI / Codex', 'quota_exhausted_real', 94),
    ]);
    const text = render5467({ stateDir, scheduleModule: scheduleFor(['anthropic']) });

    assert.ok(text.includes('🟧 *Pipeline pausado — sin proveedor disponible*'));
    assert.ok(text.includes('• OpenAI / Codex — cuota agotada (94 %)'), `desglose con pct, vino: ${text}`);
    assert.ok(text.includes('⚠️ Requiere acción: OpenAI / Codex agotó la cuota.'), `acción con objeto, vino: ${text}`);
    assert.ok(text.includes('• Anthropic — en reposo hasta mañana 07:00'), 'el reposo del resto sigue visible');
});

test('#5467 CA-1 — causa AUTH: motivo legible en castellano y acción imperativa', () => {
    const stateDir = stateDirWith([
        healthRow('gemini-google', 'Gemini (Antigravity CLI)', 'cli_license_unavailable'),
    ]);
    const text = render5467(
        { stateDir, scheduleModule: scheduleFor([]) },
        { chain_tried: ['gemini-google'] },
    );

    assert.ok(text.includes('🟧 *Pipeline pausado — sin proveedor disponible*'));
    assert.ok(text.includes('sin licencia CLI habilitada'), `copy de UX-3, vino: ${text}`);
    assert.ok(text.includes('⚠️ Requiere acción: Gemini (Antigravity CLI) no tiene licencia habilitada.'),
        `imperativo con objeto, vino: ${text}`);
    assert.ok(!text.includes('cli_license_unavailable'), 'SEC-1: el reason_code crudo nunca se interpola');
});

test('#5467 CA-13 — causa TRANSITORIA: se recupera solo, SIN hora y SIN pedir acción', () => {
    const stateDir = stateDirWith([
        healthRow('nvidia-nim', 'NVIDIA NIM', 'timeout'),
        healthRow('cerebras', 'Cerebras', 'network_error'),
    ]);
    const text = render5467(
        { stateDir, scheduleModule: scheduleFor([]) },
        { chain_tried: ['nvidia-nim', 'cerebras'] },
    );

    assert.ok(text.includes('✅ Se recupera solo — reintento automático'), `vino: ${text}`);
    assert.ok(!text.includes('Requiere acción'),
        'timeout no debe mandar al operador a reautenticar algo sano');
    assert.ok(text.includes('• NVIDIA NIM — sin respuesta a tiempo'));
    assert.ok(text.includes('• Cerebras — error de red'));
});

test('#5467 — causa MIXTA: gana auth y la acción nombra a los dos proveedores', () => {
    const stateDir = stateDirWith([
        healthRow('gemini-google', 'Gemini (Antigravity CLI)', 'cli_license_unavailable'),
        healthRow('openai', 'OpenAI / Codex', 'quota_exhausted_real', 94),
        healthRow('nvidia-nim', 'NVIDIA NIM', 'timeout'),
    ]);
    const text = render5467(
        { stateDir, scheduleModule: scheduleFor(['anthropic']) },
        { chain_tried: ['anthropic', 'openai-codex', 'gemini-google', 'nvidia-nim'] },
    );

    assert.ok(text.includes('🟧 *Pipeline pausado — sin proveedor disponible*'));
    assert.ok(text.includes('⚠️ Requiere acción: 2 proveedores necesitan atención.'), `vino: ${text}`);
    assert.ok(text.includes('Gemini (Antigravity CLI) sin licencia'));
    assert.ok(text.includes('OpenAI / Codex con la cuota agotada'));

    // Orden del desglose: auth primero, reposo último (el truncado se come lo
    // menos urgente).
    const idxAuth = text.indexOf('sin licencia CLI habilitada');
    const idxCuota = text.indexOf('cuota agotada (94 %)');
    const idxTrans = text.indexOf('sin respuesta a tiempo');
    const idxReposo = text.indexOf('en reposo hasta');
    assert.ok(idxAuth < idxCuota && idxCuota < idxTrans && idxTrans < idxReposo,
        `orden por urgencia descendente, vino: ${text}`);
});

// ─── CA-2 · El titular no miente ─────────────────────────────────────────────

test('#5467 CA-2 — sin ningún quota_exhausted_real el titular no habla de cuota agotada', () => {
    const stateDir = stateDirWith([
        healthRow('gemini-google', 'Gemini (Antigravity CLI)', 'cli_license_unavailable'),
        healthRow('cerebras', 'Cerebras', 'quota_exhausted'), // flag reactivo, SIN medición
    ]);
    const text = render5467(
        { stateDir, scheduleModule: scheduleFor([]) },
        { chain_tried: ['gemini-google', 'cerebras'] },
    );

    const titular = text.split('\n')[0];
    assert.ok(!titular.includes('cuota agotada'), `titular sin atribución de cuota, vino: ${titular}`);
    // UX-2 · el flag reactivo NO puede decir "cuota agotada" a secas: con el
    // titular "sin proveedor disponible" arriba, el mensaje se contradiría.
    assert.ok(text.includes('• Cerebras — el proveedor la reporta agotada (sin medición)'), `vino: ${text}`);
});

// ─── CA-7 / R2 · Degradación ─────────────────────────────────────────────────

test('#5467 CA-7 — snapshot ausente: sin desglose, sin veredicto, titular NEUTRO, sin excepción', () => {
    const text = render5467({ stateDir: pathNode.join(osNode.tmpdir(), 'no-existe-5467-degradado') });

    // R2 · degradar "al formato actual" reintroduciría el titular "cuota
    // agotada" que CA-2 prohíbe. Se degrada la ESTRUCTURA, no el titular.
    assert.ok(text.includes('🟧 *Pipeline pausado — sin proveedor disponible*'));
    assert.ok(!text.includes('cuota agotada'), 'CA-2 se respeta también al degradar');
    assert.ok(!text.includes('Proveedores intentados'), 'sin datos no hay desglose');
    assert.ok(!text.includes('Se recupera solo') && !text.includes('Requiere acción'),
        'sin snapshot no hay causa: afirmar un veredicto sería inventar (UX-V2)');

    // La estructura de #3498 se preserva íntegra.
    assert.ok(text.includes('Issue: [#5467 — El aviso de pipeline pausado]'));
    assert.ok(text.includes('Skill: `ux`'));
    assert.ok(text.includes('Primary: `anthropic`'));
    assert.ok(text.includes('Cadena intentada: `anthropic -> openai-codex`'));
    assert.ok(text.includes('reintentar cada ~300s'));
    assert.ok(text.includes('Para destrabe manual:'));
});

test('#5467 CA-7 — snapshot corrupto degrada igual, sin lanzar', () => {
    const dir = fsNode.mkdtempSync(pathNode.join(osNode.tmpdir(), 'exh-5467-bad-'));
    fsNode.writeFileSync(pathNode.join(dir, 'multi-provider-health.json'), '{{{ roto', 'utf8');
    let text;
    assert.doesNotThrow(() => { text = render5467({ stateDir: dir }); });
    assert.ok(text.includes('🟧 *Pipeline pausado — sin proveedor disponible*'));
    assert.ok(!text.includes('Proveedores intentados'));
});

// ─── CA-6 / SEC-7 · Datos vencidos ───────────────────────────────────────────

test('#5467 CA-6 — con dato vencido se rotula la antigüedad y NO se promete recuperación', () => {
    const stateDir = stateDirWith([
        healthRow('anthropic', 'Anthropic', 'cli_oauth_ok'),
        healthRow('openai', 'OpenAI / Codex', 'cli_oauth_ok'),
    ], 47 * 60_000);
    const text = render5467({
        stateDir,
        staleMs: 15 * 60_000,
        scheduleModule: scheduleFor(['anthropic', 'openai-codex']),
    });

    assert.ok(text.includes('Proveedores intentados (último dato conocido hace 47 min):'), `vino: ${text}`);
    assert.ok(!text.includes('Se recupera solo'),
        'SEC-7: prometer recuperación con datos vencidos puede tapar una caída real');
    assert.ok(text.includes('⚠️ Requiere acción: no hay dato de salud fresco (último hace 47 min).'));
    // Aunque la causa dominante sea reposo, con dato viejo no se titula
    // "pausa programada": no podemos descartar una caída que el snapshot no ve.
    assert.ok(!text.includes('🌙'), `titular neutro con dato vencido, vino: ${text}`);
});

// ─── CA-5 / SEC-5 · El veredicto sobrevive al truncado ───────────────────────

test('#5467 CA-5 — con cadena larga el mensaje se trunca pero la acción sobrevive', () => {
    const stateDir = stateDirWith([
        healthRow('gemini-google', 'Gemini (Antigravity CLI)', 'cli_license_unavailable'),
    ]);
    // Cadena desmedida: la línea `Cadena intentada` es la única sin tope y
    // empuja el mensaje más allá del límite de Telegram.
    const chain = ['gemini-google'];
    for (let i = 0; i < 400; i++) chain.push(`prov-${String(i).padStart(3, '0')}`);

    const text = render5467(
        { stateDir, scheduleModule: scheduleFor([]) },
        { chain_tried: chain },
    );

    assert.ok(text.includes('[... truncado]'), 'el mensaje efectivamente se truncó');
    assert.ok(Buffer.byteLength(text, 'utf8') <= mod.TELEGRAM_MAX_BYTES,
        'respeta el cap de bytes de Telegram');
    // Lo que importa: la decisión del operador sigue arriba y visible.
    assert.ok(text.includes('🟧 *Pipeline pausado — sin proveedor disponible*'), 'titular sobrevive');
    assert.ok(text.includes('⚠️ Requiere acción: Gemini (Antigravity CLI) no tiene licencia habilitada.'),
        `la línea de acción sobrevive al truncado, vino el final: ${text.slice(-200)}`);
});

test('#5467 — el desglose se acota y avisa cuántos proveedores quedaron afuera', () => {
    const providers = [];
    const chain = [];
    for (let i = 0; i < 9; i++) {
        providers.push(healthRow(`prov-${i}`, `Prov ${i}`, 'timeout'));
        chain.push(`prov-${i}`);
    }
    const stateDir = stateDirWith(providers);
    const text = render5467({ stateDir, scheduleModule: scheduleFor([]) }, { chain_tried: chain });

    const bullets = text.split('\n').filter(l => l.startsWith('• '));
    assert.equal(bullets.length, mod.BREAKDOWN_MAX_PROVIDERS + 1, 'tope + línea de resto');
    assert.ok(text.includes('• …y 3 proveedores más'), `vino: ${text}`);
});

// ─── CA-8 / SEC-3 · Postura de seguridad ─────────────────────────────────────

test('#5467 CA-8 — ningún mensaje expone auth_mode ni key_status', () => {
    const stateDir = stateDirWith([
        healthRow('gemini-google', 'Gemini (Antigravity CLI)', 'cli_license_unavailable'),
        healthRow('cerebras', 'Cerebras', 'no_key_configured'),
        healthRow('openai', 'OpenAI / Codex', 'quota_exhausted_real', 94),
    ]);
    const text = render5467(
        { stateDir, scheduleModule: scheduleFor(['anthropic']) },
        { chain_tried: ['anthropic', 'openai-codex', 'gemini-google', 'cerebras'] },
    );

    for (const prohibido of ['auth_mode', 'key_status', 'oauth', 'api_key', 'not_applicable']) {
        assert.ok(!text.includes(prohibido), `"${prohibido}" no debe aparecer, vino: ${text}`);
    }
});

// ─── CA-9 / SEC-2 · Escape de Markdown ───────────────────────────────────────

test('#5467 CA-9 — el label del snapshot se escapa antes de interpolarse', () => {
    // El snapshot es input no confiable y el envío usa parse_mode: Markdown.
    // Un `_` o un `*` sin escapar tumba el mensaje entero con
    // "400 can't parse entities" (#5173) — y un aviso de pausa que no se
    // entrega es exactamente el fallo que este issue quiere evitar.
    const stateDir = stateDirWith([healthRow('cerebras', 'ma_lo*x', 'timeout')]);
    const text = render5467({ stateDir, scheduleModule: scheduleFor([]) }, { chain_tried: ['cerebras'] });
    assert.ok(text.includes('ma\\_lo\\*x'), `label escapado, vino: ${text}`);
});

test('#5467 CA-9 — el título del issue (viene de GitHub, repo público) se escapa', () => {
    const text = render5467(
        { stateDir: pathNode.join(osNode.tmpdir(), 'no-existe-5467-md') },
        { title: 'bug con _guion_ y *asterisco*' },
    );
    assert.ok(text.includes('bug con \\_guion\\_ y \\*asterisco\\*'), `vino: ${text}`);
});

// ─── CA-10 · Dedup ───────────────────────────────────────────────────────────

test('#5467 CA-10 — misma cadena + cambio de causa dominante → re-notifica', () => {
    const dir = fsNode.mkdtempSync(pathNode.join(osNode.tmpdir(), 'exh-marker-'));
    const opts = { pipelineDir: dir, now: NOW_5467 };
    const payload = { issue: 4242, chain_tried: ['anthropic', 'openai-codex'] };

    mod.writeNotifyMarker(4242, {
        issue: 4242,
        chain_tried: ['anthropic', 'openai-codex'],
        dominant_cause: 'reposo',
        last_notified_ms: NOW_5467 - 60_000,
    }, opts);

    // Pasar de reposo programado a cuota real es información NUEVA para el
    // operador: la primera no requiere acción y la segunda sí.
    const cambio = mod.shouldNotify(4242, payload, { ...opts, pauseCause: { dominantCause: 'cuota' } });
    assert.deepEqual(cambio, { notify: true, reason: 'cause_changed' });

    // Misma causa + misma cadena → sigue en silencio (no rompemos el dedup).
    const igual = mod.shouldNotify(4242, payload, { ...opts, pauseCause: { dominantCause: 'reposo' } });
    assert.deepEqual(igual, { notify: false, reason: 'dedup_silent' });
});

test('#5467 CA-10 — el cambio de cadena sigue teniendo precedencia sobre el de causa', () => {
    const dir = fsNode.mkdtempSync(pathNode.join(osNode.tmpdir(), 'exh-marker2-'));
    const opts = { pipelineDir: dir, now: NOW_5467 };
    mod.writeNotifyMarker(4243, {
        issue: 4243, chain_tried: ['anthropic'], dominant_cause: 'reposo',
        last_notified_ms: NOW_5467 - 60_000,
    }, opts);

    const res = mod.shouldNotify(4243, { issue: 4243, chain_tried: ['anthropic', 'cerebras'] },
        { ...opts, pauseCause: { dominantCause: 'cuota' } });
    assert.deepEqual(res, { notify: true, reason: 'chain_changed' });
});

test('#5467 CA-10 — un marker viejo sin dominant_cause NO dispara alerta al desplegar', () => {
    // Anti tormenta de rollout: si los markers preexistentes contaran como
    // "cambio de causa", el deploy de #5467 mandaría un Telegram por CADA issue
    // pausado, todos juntos. Un marker sin el campo no registró otra causa:
    // registró ninguna.
    const dir = fsNode.mkdtempSync(pathNode.join(osNode.tmpdir(), 'exh-marker3-'));
    const opts = { pipelineDir: dir, now: NOW_5467 };
    mod.writeNotifyMarker(4244, {
        issue: 4244, chain_tried: ['anthropic'], last_notified_ms: NOW_5467 - 60_000,
    }, opts);

    const res = mod.shouldNotify(4244, { issue: 4244, chain_tried: ['anthropic'] },
        { ...opts, pauseCause: { dominantCause: 'reposo' } });
    assert.deepEqual(res, { notify: false, reason: 'dedup_silent' });
});

test('#5467 CA-10 — con el clasificador degradado tampoco se re-notifica', () => {
    // No saber la causa no es información nueva para el operador.
    const dir = fsNode.mkdtempSync(pathNode.join(osNode.tmpdir(), 'exh-marker5-'));
    const opts = { pipelineDir: dir, now: NOW_5467 };
    mod.writeNotifyMarker(4246, {
        issue: 4246, chain_tried: ['anthropic'], dominant_cause: 'cuota',
        last_notified_ms: NOW_5467 - 60_000,
    }, opts);

    const res = mod.shouldNotify(4246, { issue: 4246, chain_tried: ['anthropic'] },
        { ...opts, pauseCause: { dominantCause: null } });
    assert.deepEqual(res, { notify: false, reason: 'dedup_silent' });
});

test('#5467 CA-10 — una vez que el marker tiene causa, el cambio real sí dispara', () => {
    const dir = fsNode.mkdtempSync(pathNode.join(osNode.tmpdir(), 'exh-marker6-'));
    const opts = { pipelineDir: dir, now: NOW_5467 };
    mod.writeNotifyMarker(4247, {
        issue: 4247, chain_tried: ['anthropic'], dominant_cause: 'reposo',
        last_notified_ms: NOW_5467 - 60_000,
    }, opts);

    const res = mod.shouldNotify(4247, { issue: 4247, chain_tried: ['anthropic'] },
        { ...opts, pauseCause: { dominantCause: 'auth' } });
    assert.deepEqual(res, { notify: true, reason: 'cause_changed' });
});

test('#5467 SEC-6 — el dedup compara categoría gruesa, nunca el reason_code crudo', () => {
    // Anti fatiga de alertas: openai pasó de red/quota_exhausted_real a green en
    // dos horas el 03/08. Comparar códigos crudos convertiría ese flapping en
    // ruido de Telegram y el operador dejaría de mirar el canal.
    const dir = fsNode.mkdtempSync(pathNode.join(osNode.tmpdir(), 'exh-marker4-'));
    const opts = { pipelineDir: dir, now: NOW_5467 };
    mod.writeNotifyMarker(4245, {
        issue: 4245, chain_tried: ['openai-codex'], dominant_cause: 'cuota',
        last_notified_ms: NOW_5467 - 60_000,
    }, opts);

    // quota_exhausted_real → rate_limited: cambia el código, NO la categoría.
    const res = mod.shouldNotify(4245, { issue: 4245, chain_tried: ['openai-codex'] },
        { ...opts, pauseCause: { dominantCause: 'cuota' } });
    assert.equal(res.notify, false, 'mismo grupo de causa → silencio');
});

// ─── Robustez ────────────────────────────────────────────────────────────────

test('#5467 — si el clasificador de causa tira, el mensaje sale igual (degradado)', () => {
    // El aviso de pausa es accesorio: nunca puede tumbar el barrido del Pulpo.
    const text = formatExhaustionMessage(
        { skill: 'ux', issue: 5467, primary_provider: 'anthropic', chain_tried: ['anthropic'] },
        {
            agentModels: fixtureConfig(),
            now: NOW_5467,
            scheduleModule: { isValidProvider: () => { throw new Error('boom'); } },
            stateDir: pathNode.join(osNode.tmpdir(), 'no-existe-5467-boom'),
        },
    );
    assert.ok(text.includes('🟧 *Pipeline pausado — sin proveedor disponible*'));
    assert.ok(text.includes('Cadena intentada: `anthropic`'));
});

test('#5467 — el truncado respeta el cap en BYTES, no en caracteres', () => {
    // Defecto encontrado al implementar #5467: `sanitizeForTelegram` cortaba con
    // `String.slice`, que cuenta caracteres. Un mensaje de puros multibyte
    // pasaba el cap de 4000 BYTES y Telegram rechazaba el envío completo — el
    // operador se quedaba sin el aviso de pausa.
    const multibyte = '🌙áé—'.repeat(3000);
    const out = mod.sanitizeForTelegram(multibyte);
    assert.ok(Buffer.byteLength(out, 'utf8') <= mod.TELEGRAM_MAX_BYTES,
        `pesó ${Buffer.byteLength(out, 'utf8')} bytes`);
    assert.ok(out.endsWith('[... truncado]'));
    // Y no queda un carácter de reemplazo por haber partido una secuencia UTF-8.
    assert.ok(!out.includes('�'), 'sin U+FFFD por corte a mitad de carácter');
});

test('#5467 — un mensaje corto no se toca', () => {
    const out = mod.sanitizeForTelegram('hola 🌙');
    assert.equal(out, 'hola 🌙');
});

test('#5467 CA-11 — armar el mensaje no dispara ningún chequeo en línea', () => {
    const src = fsNode.readFileSync(require.resolve('../provider-exhaustion-pause'), 'utf8');
    assert.ok(!src.includes("require('./multi-provider/live-ping')"));
    assert.ok(!src.includes("require('./multi-provider/completion-client')"));
});

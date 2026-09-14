// =============================================================================
// quota-reset-reconcile-7181.test.js — El flag de cuota vuelve a ser
// verificable: se acorta solo contra el reset REAL y deja de mentirle al panel.
//
// INCIDENTE QUE FIJA ESTA SUITE
// -----------------------------
// El 2026-09-10 a las 14:54Z el pipeline gateó `openai-codex` hasta el día
// siguiente (`resets_at: 2026-09-11T14:54Z`, `pattern_matched:
// insufficient_quota`) mientras el panel lo mostraba `green / cli_oauth_ok`.
// Codex efectivamente estaba capado — pero hasta las 19:16Z de ESE día, no 24h.
// Sobraron 19,5 horas de apagón, y nada en el sistema podía notarlo.
//
// Tres defectos encadenados, uno por cada bloque de esta suite:
//
//   1. ADAPTER CIEGO. El CLI emite dos formas de `rate_limits`: con
//      `limit_id:"codex"` trae ventanas pobladas, y con `limit_id:"premium"`
//      —la que acompaña al tope— trae `primary`/`secondary` en `null`. El
//      adapter tomaba el evento más reciente a secas, se quedaba con el frame
//      `premium` vacío y devolvía `adapterStatus:'error'` ("ventanas
//      inválidas"), tapando la medición real que estaba unas líneas más arriba.
//
//   2. FLAG INVERIFICABLE. El flag sólo se iba por vencimiento o por un spawn
//      EXITOSO — inalcanzable, porque el propio flag gatea el spawn que lo
//      probaría. Un `resets_at` mal escrito no tenía forma de corregirse.
//
//   3. PANEL QUE CONTRADICE AL PIPELINE. El ping de un provider CLI-OAuth es
//      `isBinaryOnPath`: mide si el binario está INSTALADO. No puede virar a
//      rojo por cuota, así que codex figuraba sano mientras rebotaba cada spawn.
//
// INVARIANTE QUE NO SE RELAJA
// ---------------------------
// La reconciliación SÓLO acorta. Alargar el gate desde un dato observado
// convertiría un error de lectura en horas de apagón sin vuelta atrás; acortar
// es auto-corrector, porque si el provider sigue capado el próximo spawn vuelve
// a escribir el flag.
// =============================================================================
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { seedPipelineConfig } = require('./_test-helpers');
const { withEnv } = require('../test-helpers/with-env');

const adapter = require('../quota-adapters/openai-codex');
const reconcile = require('../quota-reset-reconcile');

// -----------------------------------------------------------------------------
// Frames REALES del incidente, tal como quedaron en los rollouts de Codex.
// -----------------------------------------------------------------------------

// Última medición con ventanas (rollout de las 14:53:55Z): la sesión al 98% y
// su reset — 1789067794 = 2026-09-10T19:16:34Z — que es exactamente el
// "try again at 4:16 PM" que el CLI le mostró al operador.
const RESET_REAL_EPOCH_S = 1789067794;
const RESET_REAL_ISO = '2026-09-10T19:16:34.000Z';
const MEDICION_TS = '2026-09-10T14:53:55.042Z';

const FRAME_CON_VENTANAS = JSON.stringify({
    timestamp: MEDICION_TS,
    type: 'event_msg',
    payload: {
        rate_limits: {
            limit_id: 'codex',
            primary: { used_percent: 98.0, window_minutes: 300, resets_at: RESET_REAL_EPOCH_S },
            secondary: { used_percent: 63.0, window_minutes: 10080, resets_at: 1789517921 },
            credits: { has_credits: false, unlimited: false, balance: '0' },
            plan_type: 'plus',
        },
    },
});

// Frame `premium` posterior (rollout de las 15:05Z): TODO en null salvo
// `credits`. Es la ausencia del dato, no el dato.
const FRAME_PREMIUM_SIN_VENTANAS = JSON.stringify({
    timestamp: '2026-09-10T15:05:59.000Z',
    type: 'event_msg',
    payload: {
        rate_limits: {
            limit_id: 'premium',
            limit_name: null,
            primary: null,
            secondary: null,
            credits: { has_credits: false, unlimited: false, balance: '0' },
            individual_limit: null,
            plan_type: null,
            rate_limit_reached_type: null,
        },
    },
});

const DETECTADO_ISO = '2026-09-10T14:54:20.552Z';
const FLAG_24H_ISO = '2026-09-11T14:54:20.552Z';   // lo que escribió el binario viejo
const AHORA = Date.parse('2026-09-10T16:00:00Z');  // entre la detección y el reset real

// -----------------------------------------------------------------------------
// Aislamiento: `.pipeline/` propio + sesiones Codex propias, para no leer jamás
// los rollouts reales de la máquina ni tocar el flag productivo.
// -----------------------------------------------------------------------------

function sembrarRollout(sesionesDir, nombre, lineas) {
    const dia = path.join(sesionesDir, '2026', '09', '10');
    fs.mkdirSync(dia, { recursive: true });
    fs.writeFileSync(path.join(dia, nombre), lineas.join('\n') + '\n', 'utf8');
}

function conEntornoAislado(fn, { lineasRollout } = {}) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-quota-7181-'));
    seedPipelineConfig(tmp);
    const sesiones = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-7181-sessions-'));
    if (lineasRollout) {
        sembrarRollout(sesiones, 'rollout-2026-09-10T14-52-34-aaaa.jsonl', lineasRollout);
    }
    const quotaPath = require.resolve('../quota-exhausted');
    const reconcilePath = require.resolve('../quota-reset-reconcile');
    try {
        return withEnv({ PIPELINE_DIR_OVERRIDE: tmp, CODEX_SESSIONS_DIR: sesiones }, () => {
            delete require.cache[quotaPath];
            delete require.cache[reconcilePath];
            const q = require('../quota-exhausted');
            const r = require('../quota-reset-reconcile');
            return fn({ quota: q, reconcile: r, pipelineDir: tmp, sesiones });
        });
    } finally {
        delete require.cache[quotaPath];
        delete require.cache[reconcilePath];
        fs.rmSync(sesiones, { recursive: true, force: true });
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

function escribirFlagCodex(pipelineDir, { resetsAt = FLAG_24H_ISO, extra = {} } = {}) {
    const payload = {
        exhausted: true,
        provider: 'openai-codex',
        resets_at: resetsAt,
        detected_at: DETECTADO_ISO,
        pattern_matched: 'insufficient_quota',
        providers: {
            'openai-codex': {
                exhausted: true,
                resets_at: resetsAt,
                detected_at: DETECTADO_ISO,
                pattern_matched: 'insufficient_quota',
            },
            ...extra,
        },
    };
    fs.writeFileSync(path.join(pipelineDir, 'quota-exhausted.json'),
        JSON.stringify(payload, null, 2), 'utf8');
}

function leerFlag(pipelineDir) {
    const f = path.join(pipelineDir, 'quota-exhausted.json');
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8'));
}

// =============================================================================
// BLOQUE 1 · El adapter deja de quedar ciego por un frame sin ventanas
// =============================================================================

test('CA-1 · un frame `premium` sin ventanas NO tapa la medición real anterior', () => {
    const contenido = [FRAME_CON_VENTANAS, FRAME_PREMIUM_SIN_VENTANAS].join('\n');
    const elegido = adapter.extractLatestRateLimits(contenido, { requireWindows: true });
    assert.ok(elegido, 'debía encontrar la medición con ventanas');
    assert.equal(elegido.rateLimits.limit_id, 'codex');
    assert.equal(elegido.rateLimits.primary.used_percent, 98);
});

test('CA-1 · sin `requireWindows` sigue devolviendo el último a secas (compat)', () => {
    const contenido = [FRAME_CON_VENTANAS, FRAME_PREMIUM_SIN_VENTANAS].join('\n');
    const elegido = adapter.extractLatestRateLimits(contenido);
    assert.equal(elegido.rateLimits.limit_id, 'premium',
        'el comportamiento previo se conserva para quien lo pida explícitamente');
});

test('CA-1 · hasUsableWindows distingue el frame con ventanas del vacío', () => {
    assert.equal(adapter.hasUsableWindows(JSON.parse(FRAME_CON_VENTANAS).payload.rate_limits), true);
    assert.equal(adapter.hasUsableWindows(JSON.parse(FRAME_PREMIUM_SIN_VENTANAS).payload.rate_limits), false);
    assert.equal(adapter.hasUsableWindows(null), false);
});

test('CA-2 · readObservedWindows entrega el reset aunque la medición sea vieja', () => {
    conEntornoAislado(({ sesiones }) => {
        const w = adapter.readObservedWindows({ sessionsDir: sesiones });
        assert.ok(w, 'un `resets_at` futuro no envejece: debe seguir disponible');
        assert.equal(w.session.usedPercent, 98);
        assert.equal(w.session.resetAt, RESET_REAL_EPOCH_S);
        assert.equal(w.weekly.windowMinutes, 10080);
    }, { lineasRollout: [FRAME_CON_VENTANAS, FRAME_PREMIUM_SIN_VENTANAS] });
});

test('CA-2 · sin ninguna ventana legible devuelve null (no inventa dato)', () => {
    conEntornoAislado(({ sesiones }) => {
        assert.equal(adapter.readObservedWindows({ sessionsDir: sesiones }), null);
    }, { lineasRollout: [FRAME_PREMIUM_SIN_VENTANAS] });
});

test('CA-3 · pickGoverningWindow elige la ventana más consumida', () => {
    const elegida = reconcile.pickGoverningWindow({
        session: { usedPercent: 98, resetAt: RESET_REAL_EPOCH_S, windowMinutes: 300 },
        weekly: { usedPercent: 63, resetAt: 1789517921, windowMinutes: 10080 },
    });
    assert.equal(elegida.kind, 'session');
    assert.equal(elegida.resetAt, RESET_REAL_EPOCH_S);
});

test('CA-3 · si la semanal es la agotada, gana la semanal', () => {
    const elegida = reconcile.pickGoverningWindow({
        session: { usedPercent: 10, resetAt: RESET_REAL_EPOCH_S, windowMinutes: 300 },
        weekly: { usedPercent: 99, resetAt: 1789517921, windowMinutes: 10080 },
    });
    assert.equal(elegida.kind, 'weekly');
});

test('CA-3 · sin ventanas utilizables no elige ninguna', () => {
    assert.equal(reconcile.pickGoverningWindow({ session: null, weekly: null }), null);
    assert.equal(reconcile.pickGoverningWindow(null), null);
});

// =============================================================================
// BLOQUE 2 · `shortenResetsAt` — sólo hacia abajo, nunca hacia arriba
// =============================================================================

test('CA-4 · acorta la ventana al reset real observado', () => {
    conEntornoAislado(({ quota, pipelineDir }) => {
        escribirFlagCodex(pipelineDir);
        const r = quota.shortenResetsAt({
            provider: 'openai-codex',
            resetsAtMs: Date.parse(RESET_REAL_ISO),
            source: 'test',
            now: AHORA,
        });
        assert.equal(r.adjusted, true);
        assert.equal(r.reason, 'shortened');
        assert.equal(leerFlag(pipelineDir).providers['openai-codex'].resets_at, RESET_REAL_ISO);
    });
});

test('CA-5 · NUNCA alarga: un reset observado posterior se ignora', () => {
    conEntornoAislado(({ quota, pipelineDir }) => {
        escribirFlagCodex(pipelineDir, { resetsAt: RESET_REAL_ISO });
        const r = quota.shortenResetsAt({
            provider: 'openai-codex',
            resetsAtMs: Date.parse('2026-09-12T00:00:00Z'), // mucho más lejos
            source: 'test',
            now: AHORA,
        });
        assert.equal(r.adjusted, false);
        assert.equal(r.reason, 'observed_not_earlier');
        assert.equal(leerFlag(pipelineDir).providers['openai-codex'].resets_at, RESET_REAL_ISO,
            'extender el gate desde un dato observado no tiene vuelta atrás automática');
    });
});

test('CA-6 · si el reset real ya venció, drena el slot en vez de dejarlo colgado', () => {
    conEntornoAislado(({ quota, pipelineDir }) => {
        escribirFlagCodex(pipelineDir);
        const r = quota.shortenResetsAt({
            provider: 'openai-codex',
            resetsAtMs: Date.parse(RESET_REAL_ISO),
            source: 'test',
            now: Date.parse('2026-09-10T20:00:00Z'), // después del reset real
        });
        assert.equal(r.reason, 'cleared_elapsed');
        const flag = leerFlag(pipelineDir);
        assert.ok(!flag || !flag.providers || !flag.providers['openai-codex'],
            'el slot de codex no puede seguir vivo pasado su reset real');
    });
});

test('CA-7 · aislamiento por provider: acortar codex no toca a los demás', () => {
    conEntornoAislado(({ quota, pipelineDir }) => {
        const cerebras = {
            cerebras: {
                exhausted: true,
                resets_at: '2026-09-10T23:17:58.022Z',
                detected_at: '2026-09-09T23:17:58.022Z',
                pattern_matched: 'insufficient_quota',
            },
        };
        escribirFlagCodex(pipelineDir, { extra: cerebras });
        quota.shortenResetsAt({
            provider: 'openai-codex',
            resetsAtMs: Date.parse(RESET_REAL_ISO),
            source: 'test',
            now: AHORA,
        });
        const flag = leerFlag(pipelineDir);
        assert.equal(flag.providers.cerebras.resets_at, '2026-09-10T23:17:58.022Z');
        assert.equal(flag.providers['openai-codex'].resets_at, RESET_REAL_ISO);
    });
});

test('CA-8 · no crea slots: sin flag activo del provider, no escribe nada', () => {
    conEntornoAislado(({ quota, pipelineDir }) => {
        const r = quota.shortenResetsAt({
            provider: 'openai-codex',
            resetsAtMs: Date.parse(RESET_REAL_ISO),
            source: 'test',
            now: AHORA,
        });
        assert.equal(r.adjusted, false);
        assert.equal(r.reason, 'no_active_slot');
        assert.equal(leerFlag(pipelineDir), null);
    });
});

test('CA-8 · entradas inválidas se rechazan sin tocar el flag', () => {
    conEntornoAislado(({ quota, pipelineDir }) => {
        escribirFlagCodex(pipelineDir);
        assert.equal(quota.shortenResetsAt({ resetsAtMs: 1 }).reason, 'provider_missing');
        assert.equal(quota.shortenResetsAt({
            provider: 'openai-codex', resetsAtMs: 'basura',
        }).reason, 'observed_invalid');
        assert.equal(leerFlag(pipelineDir).providers['openai-codex'].resets_at, FLAG_24H_ISO);
    });
});

// =============================================================================
// BLOQUE 3 · El reconciliador end-to-end sobre el incidente real
// =============================================================================

test('CA-9 · INCIDENTE REAL: 24h escritas → se acortan al reset anunciado', () => {
    conEntornoAislado(({ reconcile: rec, pipelineDir }) => {
        escribirFlagCodex(pipelineDir);
        const r = rec.reconcileCodexReset({ force: true, now: AHORA });
        assert.equal(r.action, 'shortened');
        assert.equal(r.window, 'session');
        assert.equal(r.usedPercent, 98);
        assert.equal(r.observedResetsAt, RESET_REAL_ISO);
        assert.equal(r.flagResetsAt, FLAG_24H_ISO);
        assert.equal(leerFlag(pipelineDir).providers['openai-codex'].resets_at, RESET_REAL_ISO);
    }, { lineasRollout: [FRAME_CON_VENTANAS, FRAME_PREMIUM_SIN_VENTANAS] });
});

test('CA-10 · sin flag activo no hace nada', () => {
    conEntornoAislado(({ reconcile: rec }) => {
        const r = rec.reconcileCodexReset({ force: true, now: AHORA });
        assert.equal(r.action, 'noop');
        assert.equal(r.reason, 'no_active_flag');
    }, { lineasRollout: [FRAME_CON_VENTANAS] });
});

test('CA-11 · una medición MUY anterior al flag no acorta nada', () => {
    // La medición describe una ventana previa: su reset ya no habla del tope
    // vigente y acortar por ella destrabaría un provider que sigue capado.
    const vieja = JSON.stringify({
        timestamp: '2026-09-10T10:00:00.000Z', // ~5h antes del detected_at
        type: 'event_msg',
        payload: {
            rate_limits: {
                limit_id: 'codex',
                primary: { used_percent: 20, window_minutes: 300, resets_at: 1789050000 },
                secondary: null,
            },
        },
    });
    conEntornoAislado(({ reconcile: rec, pipelineDir }) => {
        escribirFlagCodex(pipelineDir);
        const r = rec.reconcileCodexReset({ force: true, now: AHORA });
        assert.equal(r.action, 'noop');
        assert.equal(r.reason, 'measurement_predates_flag');
        assert.equal(leerFlag(pipelineDir).providers['openai-codex'].resets_at, FLAG_24H_ISO);
    }, { lineasRollout: [vieja] });
});

test('CA-12 · el throttle evita repetir el barrido de rollouts', () => {
    conEntornoAislado(({ reconcile: rec, pipelineDir }) => {
        escribirFlagCodex(pipelineDir);
        const primera = rec.reconcileCodexReset({ force: true, now: AHORA });
        assert.equal(primera.action, 'shortened');
        const segunda = rec.reconcileCodexReset({ now: AHORA + 1000 });
        assert.equal(segunda.action, 'skipped');
        assert.equal(segunda.reason, 'throttled');
    }, { lineasRollout: [FRAME_CON_VENTANAS, FRAME_PREMIUM_SIN_VENTANAS] });
});

test('CA-13 · pasado el intervalo, vuelve a correr', () => {
    conEntornoAislado(({ reconcile: rec, pipelineDir }) => {
        escribirFlagCodex(pipelineDir);
        rec.reconcileCodexReset({ force: true, now: AHORA });
        const despues = rec.reconcileCodexReset({
            now: AHORA + reconcile.DEFAULT_MIN_INTERVAL_MS + 1000,
        });
        assert.notEqual(despues.reason, 'throttled');
    }, { lineasRollout: [FRAME_CON_VENTANAS, FRAME_PREMIUM_SIN_VENTANAS] });
});

test('CA-14 · sin rollouts legibles NO destraba (fail-closed)', () => {
    conEntornoAislado(({ reconcile: rec, pipelineDir }) => {
        escribirFlagCodex(pipelineDir);
        const r = rec.reconcileCodexReset({ force: true, now: AHORA });
        assert.equal(r.action, 'noop');
        assert.equal(r.reason, 'no_observed_windows');
        assert.equal(leerFlag(pipelineDir).providers['openai-codex'].resets_at, FLAG_24H_ISO,
            'la ausencia de señal no puede destrabar un provider capado');
    });
});

// =============================================================================
// BLOQUE 4 · El panel deja de contradecir al pipeline
// =============================================================================

test('CA-15 · un provider con flag activo NO puede reportarse verde', () => {
    conEntornoAislado(({ pipelineDir }) => {
        escribirFlagCodex(pipelineDir);
        const healthPath = require.resolve('../multi-provider/health-cron');
        delete require.cache[healthPath];
        const health = require('../multi-provider/health-cron');
        try {
            // 'openai' es como el cron nombra a Codex; el flag usa 'openai-codex'.
            assert.equal(health.quotaFlagState('openai', AHORA), true);
            assert.equal(health.quotaFlagState('nvidia-nim', AHORA), false);
        } finally {
            delete require.cache[healthPath];
        }
    });
});

test('CA-16 · el reason_code del flag sobrevive al sanitize (no colapsa a unknown)', () => {
    const alerts = require('../multi-provider/health-alerts');
    assert.equal(alerts.sanitizeReasonCode('quota_flag_active'), 'quota_flag_active');
});

test('CA-17 · un slot ya vencido no pinta de rojo (readDefensive lo drena antes)', () => {
    conEntornoAislado(({ pipelineDir }) => {
        escribirFlagCodex(pipelineDir, { resetsAt: '2026-09-10T12:00:00Z' }); // pasado
        const healthPath = require.resolve('../multi-provider/health-cron');
        delete require.cache[healthPath];
        const health = require('../multi-provider/health-cron');
        try {
            assert.equal(health.quotaFlagState('openai', AHORA), false);
        } finally {
            delete require.cache[healthPath];
        }
    });
});

// =============================================================================
// BLOQUE 5 · #7188 — el reconcile no deja rastro si no tiene nada que hacer
// =============================================================================
//
// `writeState(last_run_ms)` corría ANTES de mirar si había slot de codex, así
// que cualquier llamada —incluso desde una sonda read-only (#4565)— creaba
// `state/quota-reset-reconcile.json`. Ahora el intento se marca recién antes
// del barrido caro de rollouts, que sólo ocurre con slot de codex vigente.

test('CA-18 · sin slot de codex no crea state/', () => {
    // Sin flag alguno.
    conEntornoAislado(({ reconcile: rec, pipelineDir }) => {
        const r = rec.reconcileCodexReset({ force: true, now: AHORA });
        assert.equal(r.action, 'noop');
        assert.equal(r.reason, 'no_active_flag');
        assert.ok(!fs.existsSync(path.join(pipelineDir, 'state')),
            'sin flag activo el reconcile no debe crear state/');
    }, { lineasRollout: [FRAME_CON_VENTANAS] });

    // Con flag de OTRO provider (el caso exacto del fixture de #4565).
    conEntornoAislado(({ reconcile: rec, pipelineDir }) => {
        fs.writeFileSync(path.join(pipelineDir, 'quota-exhausted.json'), JSON.stringify({
            exhausted: true,
            provider: 'anthropic',
            resets_at: FLAG_24H_ISO,
            detected_at: DETECTADO_ISO,
            pattern_matched: 'usage_limit_error',
            providers: {
                anthropic: {
                    exhausted: true,
                    resets_at: FLAG_24H_ISO,
                    detected_at: DETECTADO_ISO,
                    pattern_matched: 'usage_limit_error',
                },
            },
        }, null, 2), 'utf8');
        const r = rec.reconcileCodexReset({ force: true, now: AHORA });
        assert.equal(r.action, 'noop');
        assert.equal(r.reason, 'provider_not_flagged');
        assert.ok(!fs.existsSync(path.join(pipelineDir, 'state')),
            'con flag de otro provider el reconcile no debe crear state/');
    }, { lineasRollout: [FRAME_CON_VENTANAS] });

    // Contraste: CON slot de codex el throttle sí se persiste (CA-12/CA-13
    // dependen de esto), así que el reorden no lo desarmó.
    conEntornoAislado(({ reconcile: rec, pipelineDir }) => {
        escribirFlagCodex(pipelineDir);
        rec.reconcileCodexReset({ force: true, now: AHORA });
        assert.ok(fs.existsSync(path.join(pipelineDir, 'state', 'quota-reset-reconcile.json')),
            'con slot de codex el throttle se marca antes del barrido');
    }, { lineasRollout: [FRAME_CON_VENTANAS, FRAME_PREMIUM_SIN_VENTANAS] });
});

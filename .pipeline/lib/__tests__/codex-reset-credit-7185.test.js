// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

// =============================================================================
// codex-reset-credit-7185.test.js — Canje automático del reset de límite de uso
// de codex + reconciliación EN VIVO del flag de cuota (#7185).
//
// INCIDENTE QUE FIJA ESTA SUITE
// -----------------------------
// 2026-09-11, 08:42 → 09:42 local. Dos spawns (`po:#5113`, `pipeline-dev:#6209`)
// escribieron el flag de codex con "try again at Sep 15th 9:18 PM" (semanal al
// 100 %). Había un crédito de reset sin usar; el pipeline no lo conocía. Minutos
// después el operador lo canjeó a mano desde el TUI y codex volvió — pero el
// flag siguió 1 h porque el reconciliador de #7181 sólo lee rollouts y no había
// rollout nuevo (el flag impide el spawn que lo generaría). Anthropic en reposo,
// el resto gateado: codex era la única pata viva y el pipeline quedó parado.
//
// FIXTURES
// --------
// `SNAPSHOT_REAL` es la respuesta literal de `account/rateLimits/read` obtenida
// por stdio contra `codex app-server` (codex-cli 0.154.0, Windows) el
// 2026-09-21 — con `accountId` reemplazado por un placeholder. Las variantes se
// derivan de ella cambiando sólo los campos bajo prueba.
// =============================================================================
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { seedPipelineConfig } = require('./_test-helpers');
const { withEnv } = require('../test-helpers/with-env');

const reconcile = require('../quota-reset-reconcile');
const { createQuotaNotifier, QUOTA_COPY, CLEAR_CONTEXT_TTL_MS } = require('../quota-notifier');
const appServer = require('../codex-app-server-client');

// -----------------------------------------------------------------------------
// Snapshot REAL (2026-09-21T13:34Z): sesión 1 %, semanal 94 %, sin créditos.
// -----------------------------------------------------------------------------
const SNAPSHOT_REAL = {
    ordinaryUsageAllowed: true,
    rateLimits: {
        limitId: 'codex', limitName: null, normalModelSlug: null,
        primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: 1790000718 },
        secondary: { usedPercent: 94, windowDurationMins: 10080, resetsAt: 1790205939 },
        credits: { hasCredits: false, unlimited: false, balance: '0' },
        individualLimit: null, spendControlReached: false, planType: 'plus', rateLimitReachedType: null,
    },
    rateLimitsByLimitId: {},
    rateLimitResetCredits: { availableCount: 0, credits: [] },
    accountId: '00000000-0000-4000-8000-000000000000',
    rateLimitUpsell: null,
};

const AHORA = Date.parse('2026-09-21T14:00:00Z');
const DETECTADO_ISO = '2026-09-21T13:50:00.000Z';
// Reset semanal del snapshot real: 1790205939 = 2026-09-23T23:25:39Z.
const RESET_SEMANAL_ISO = new Date(1790205939 * 1000).toISOString();

function variante(mods) {
    const s = JSON.parse(JSON.stringify(SNAPSHOT_REAL));
    return typeof mods === 'function' ? (mods(s) || s) : Object.assign(s, mods);
}

/** Semanal agotada (100 %), sesión al 1 %, con un crédito disponible. */
function snapshotSemanalAgotadaConCredito() {
    return variante((s) => {
        s.ordinaryUsageAllowed = false;
        s.rateLimits.secondary.usedPercent = 100;
        s.rateLimits.rateLimitReachedType = 'rate_limit_reached';
        s.rateLimitResetCredits = {
            availableCount: 1,
            credits: [{
                id: 'crd_abc', status: 'available', resetType: 'codexRateLimits',
                grantedAt: 1789900000, expiresAt: null, title: 'Reset', description: null,
            }],
        };
    });
}

/** Semanal agotada (100 %) sin créditos de reset. */
function snapshotSemanalAgotadaSinCredito() {
    return variante((s) => {
        s.ordinaryUsageAllowed = false;
        s.rateLimits.secondary.usedPercent = 100;
        s.rateLimits.rateLimitReachedType = 'rate_limit_reached';
    });
}

// -----------------------------------------------------------------------------
// Aislamiento: `.pipeline/` propio; se recargan los módulos que resuelven rutas.
// -----------------------------------------------------------------------------
// `withEnv` acepta `fn` async: devuelve la promesa y restaura el entorno DESPUÉS
// del settle, así que los barridos asíncronos corren dentro del sandbox.
async function conEntornoAisladoAsync(fn) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-codex-7185-'));
    seedPipelineConfig(tmp);
    const mods = ['../quota-exhausted', '../quota-reset-reconcile', '../codex-reset-credit'].map(m => require.resolve(m));
    const limpiar = () => { for (const m of mods) delete require.cache[m]; };
    try {
        return await withEnv({ PIPELINE_DIR_OVERRIDE: tmp, CODEX_SESSIONS_DIR: path.join(tmp, 'codex-sessions-vacio') }, async () => {
            limpiar();
            const quota = require('../quota-exhausted');
            const credit = require('../codex-reset-credit');
            return fn({ quota, credit, pipelineDir: tmp });
        });
    } finally {
        limpiar();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

function escribirFlagCodex(pipelineDir, { resetsAt = RESET_SEMANAL_ISO, detectedAt = DETECTADO_ISO, extra = {} } = {}) {
    const slot = { exhausted: true, resets_at: resetsAt, detected_at: detectedAt, pattern_matched: 'usage_limit_reached' };
    fs.writeFileSync(path.join(pipelineDir, 'quota-exhausted.json'), JSON.stringify({
        exhausted: true, provider: 'openai-codex', ...slot,
        providers: { 'openai-codex': slot, ...extra },
    }, null, 2), 'utf8');
}

function leerFlag(pipelineDir) {
    const f = path.join(pipelineDir, 'quota-exhausted.json');
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

function leerEstado(pipelineDir) {
    const f = path.join(pipelineDir, 'state', 'codex-reset-credit.json');
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

/**
 * Cliente falso del app-server: `reads` es la cola de respuestas de
 * `account/rateLimits/read` (una por llamada; la última se repite), `consume`
 * resuelve/rechaza el canje y deja registro de los params.
 */
function fakeClient({ reads, consume, fail } = {}) {
    const llamadas = { reads: 0, consume: [] };
    const cola = Array.isArray(reads) ? [...reads] : [reads];
    return {
        llamadas,
        async withAppServer(fn) {
            if (fail) throw fail;
            return fn({ fake: true });
        },
        async readRateLimits() {
            llamadas.reads++;
            const r = cola.length > 1 ? cola.shift() : cola[0];
            if (r instanceof Error) throw r;
            return typeof r === 'function' ? r() : r;
        },
        async consumeResetCredit(session, params) {
            llamadas.consume.push(params);
            if (consume instanceof Error) throw consume;
            return typeof consume === 'function' ? consume(params) : (consume || { outcome: 'reset' });
        },
    };
}

function fakeNotifier() {
    const calls = [];
    return {
        calls,
        notifyResetCreditRedeemed: (i) => calls.push(['redeemed', i]),
        notifyResetCreditAlreadyUsed: (i) => calls.push(['alreadyUsed', i]),
        notifyAppServerUnavailable: () => calls.push(['unavailable']),
        markLiveReconcileClear: (i) => calls.push(['liveClear', i]),
    };
}

const adapterSinRollouts = { readObservedWindows: () => null };
const CFG = { enabled: true, max_per_week: 1, notify: true };

function baseOpts({ credit, client, notifier, extra = {} }) {
    return {
        now: AHORA, force: true, config: CFG, client, notifier,
        adapter: adapterSinRollouts, reconcileModule: reconcile,
        uuid: () => 'uuid-fijo-0001',
        log: () => {},
        ...extra,
    };
}

// =============================================================================
// BLOQUE 0 · Helpers puros
// =============================================================================

test('parseLiveSnapshot mapea el snapshot real a las ventanas del reconciliador', () => {
    const credit = require('../codex-reset-credit');
    const p = credit.parseLiveSnapshot(SNAPSHOT_REAL);
    assert.deepEqual(p.windows.session, { usedPercent: 1, resetAt: 1790000718, windowMinutes: 300 });
    assert.deepEqual(p.windows.weekly, { usedPercent: 94, resetAt: 1790205939, windowMinutes: 10080 });
    assert.equal(p.ordinaryUsageAllowed, true);
    assert.equal(p.rateLimitReachedType, null);
    assert.deepEqual(p.credits, { availableCount: 0, credits: [] });
    assert.equal('accountId' in p, false, 'nada identificatorio sale del parser');
    // Compatible 1:1 con pickGoverningWindow (#7181): semanal 94 % gobierna.
    assert.equal(reconcile.pickGoverningWindow(p.windows).kind, 'weekly');
});

test('parseLiveSnapshot tolera rateLimits/credits en null y rechaza tipos inesperados (CA-6)', () => {
    const credit = require('../codex-reset-credit');
    const p = credit.parseLiveSnapshot({ rateLimits: null, rateLimitResetCredits: { availableCount: 2, credits: null } });
    assert.equal(p.windows.session, null);
    assert.deepEqual(p.credits, { availableCount: 2, credits: null });
    assert.throws(() => credit.parseLiveSnapshot({ rateLimits: 'texto' }), /tipo inesperado/);
    assert.throws(() => credit.parseLiveSnapshot({ rateLimitResetCredits: { availableCount: 'x' } }), /availableCount/);
    assert.throws(() => credit.parseLiveSnapshot(null), /result/);
});

test('pickCredit: availableCount>0 es necesario; filas inelegibles → fail-closed; sin detalle → elige el backend', () => {
    const { pickCredit } = require('../codex-reset-credit');
    assert.equal(pickCredit({ availableCount: 0, credits: [] }).eligible, false);
    assert.equal(pickCredit({ availableCount: 1, credits: null }).reason, 'backend_selects');
    assert.equal(pickCredit({ availableCount: 1, credits: [] }).reason, 'backend_selects');
    assert.equal(pickCredit({ availableCount: 1, credits: [{ id: 'a', status: 'redeemed', resetType: 'codexRateLimits' }] }).reason, 'no_eligible_credit');
    assert.equal(pickCredit({ availableCount: 1, credits: [{ id: 'a', status: 'available', resetType: 'unknown' }] }).reason, 'no_eligible_credit');
    const ok = pickCredit({ availableCount: 2, credits: [
        { id: 'a', status: 'redeeming', resetType: 'codexRateLimits' },
        { id: 'b', status: 'available', resetType: 'codexRateLimits' },
    ] });
    assert.deepEqual(ok, { eligible: true, reason: 'credit_selected', creditId: 'b' });
});

test('classifyExhaustedWindow: semanal manda aunque la sesión también esté al tope', () => {
    const { classifyExhaustedWindow } = require('../codex-reset-credit');
    assert.equal(classifyExhaustedWindow({ session: { usedPercent: 100 }, weekly: { usedPercent: 40 } }), 'session');
    assert.equal(classifyExhaustedWindow({ session: { usedPercent: 100 }, weekly: { usedPercent: 100 } }), 'weekly');
    assert.equal(classifyExhaustedWindow({ session: { usedPercent: 10 }, weekly: { usedPercent: 99 } }), null);
    assert.equal(classifyExhaustedWindow(null), null);
});

test('countRedemptionsThisWeek mide la semana de codex, no el calendario', () => {
    const { countRedemptionsThisWeek } = require('../codex-reset-credit');
    const hoy = AHORA;
    assert.equal(countRedemptionsThisWeek([{ redeemed_at: '2026-09-20T00:00:00Z', weekly_resets_at: RESET_SEMANAL_ISO }], hoy), 1);
    assert.equal(countRedemptionsThisWeek([{ redeemed_at: '2026-09-10T00:00:00Z', weekly_resets_at: '2026-09-15T21:18:00Z' }], hoy), 0);
    // Sin `weekly_resets_at` conocido: 7 días desde el canje (conservador).
    assert.equal(countRedemptionsThisWeek([{ redeemed_at: '2026-09-16T00:00:00Z' }], hoy), 1);
    assert.equal(countRedemptionsThisWeek([{ redeemed_at: '2026-09-01T00:00:00Z' }], hoy), 0);
});

test('resolveConfig: defaults conservadores y `enabled` sólo se apaga con false explícito', () => {
    const { resolveConfig } = require('../codex-reset-credit');
    assert.deepEqual(resolveConfig({}), { enabled: true, max_per_week: 1, notify: true });
    assert.deepEqual(resolveConfig({ enabled: false, max_per_week: -3, notify: 'si' }), { enabled: false, max_per_week: 1, notify: true });
    assert.deepEqual(resolveConfig({ max_per_week: 2, notify: false }), { enabled: true, max_per_week: 2, notify: false });
    assert.equal(resolveConfig('basura').enabled, true);
});

// =============================================================================
// BLOQUE 1 · Canje (CA-1 … CA-7)
// =============================================================================

test('CA-1 · semanal agotada + crédito disponible → canjea, drena el flag y notifica créditos restantes', async () => {
    await conEntornoAisladoAsync(async ({ quota, credit, pipelineDir }) => {
        escribirFlagCodex(pipelineDir);
        const despues = variante((s) => { s.rateLimitResetCredits = { availableCount: 2, credits: null }; });
        const client = fakeClient({ reads: [snapshotSemanalAgotadaConCredito(), despues], consume: { outcome: 'reset' } });
        const notifier = fakeNotifier();

        const r = await credit.runCodexLiveSweep(baseOpts({ credit, client, notifier }));

        assert.equal(r.action, 'redeemed');
        assert.equal(r.redeem.outcome, 'reset');
        assert.equal(r.redeem.cleared, true);
        assert.deepEqual(client.llamadas.consume, [{ idempotencyKey: 'uuid-fijo-0001', creditId: 'crd_abc' }]);
        assert.equal(client.llamadas.reads, 2, 'relee tras el canje para informar créditos reales');
        assert.equal(leerFlag(pipelineDir), null, 'el slot de codex se drenó');
        assert.deepEqual(notifier.calls, [['redeemed', { creditsRemaining: 2 }]]);
        const st = leerEstado(pipelineDir);
        assert.equal(st.redemptions.length, 1);
        assert.equal(st.redemptions[0].idempotency_key, 'uuid-fijo-0001');
        assert.equal(st.redemptions[0].weekly_resets_at, RESET_SEMANAL_ISO);
        assert.equal(st.attempts[DETECTADO_ISO].outcome, 'reset');
        assert.equal(quota.readDefensive({ now: AHORA }).exhausted, false);
    });
});

test('CA-1 · el canje sólo drena el slot de codex: otro provider agotado queda intacto (#4731)', async () => {
    await conEntornoAisladoAsync(async ({ credit, pipelineDir }) => {
        const anthropic = { exhausted: true, resets_at: '2026-09-22T00:00:00.000Z', detected_at: DETECTADO_ISO, pattern_matched: 'usage_limit_error' };
        escribirFlagCodex(pipelineDir, { extra: { anthropic } });
        const client = fakeClient({ reads: snapshotSemanalAgotadaConCredito(), consume: { outcome: 'reset' } });
        const r = await credit.runCodexLiveSweep(baseOpts({ credit, client, notifier: fakeNotifier() }));
        assert.equal(r.action, 'redeemed');
        const flag = leerFlag(pipelineDir);
        assert.ok(flag && flag.providers.anthropic, 'anthropic sigue gateado');
        assert.equal(flag.providers['openai-codex'], undefined);
    });
});

test('CA-2 · cap de 5h agotado (primary 100 %, secondary 40 %) → NO se canjea aunque haya crédito', async () => {
    await conEntornoAisladoAsync(async ({ credit, pipelineDir }) => {
        escribirFlagCodex(pipelineDir, { resetsAt: '2026-09-21T18:00:00.000Z' });
        const snap = variante((s) => {
            s.ordinaryUsageAllowed = false;
            s.rateLimits.primary.usedPercent = 100;
            s.rateLimits.secondary.usedPercent = 40;
            s.rateLimitResetCredits = { availableCount: 1, credits: [{ id: 'crd', status: 'available', resetType: 'codexRateLimits', grantedAt: 1 }] };
        });
        const client = fakeClient({ reads: snap });
        const notifier = fakeNotifier();
        const r = await credit.runCodexLiveSweep(baseOpts({ credit, client, notifier }));
        assert.equal(r.redeem.reason, 'session_cap_not_redeemable');
        assert.equal(client.llamadas.consume.length, 0);
        assert.ok(leerFlag(pipelineDir), 'flag intacto');
        assert.deepEqual(notifier.calls, [], 'silencio total (copy d)');
    });
});

test('CA-3 · sin créditos → sin canje, flag intacto, sin notificación y sin repetir en el próximo barrido', async () => {
    await conEntornoAisladoAsync(async ({ credit, pipelineDir }) => {
        escribirFlagCodex(pipelineDir);
        const client = fakeClient({ reads: snapshotSemanalAgotadaSinCredito() });
        const notifier = fakeNotifier();
        const r1 = await credit.runCodexLiveSweep(baseOpts({ credit, client, notifier }));
        assert.equal(r1.redeem.reason, 'no_credit_available');
        assert.equal(client.llamadas.consume.length, 0);
        assert.ok(leerFlag(pipelineDir));
        assert.deepEqual(notifier.calls, [], 'copy (c): silencio');
        const r2 = await credit.runCodexLiveSweep(baseOpts({ credit, client, notifier }));
        assert.equal(r2.redeem.reason, 'already_attempted', 'un intento lógico por agotamiento');
        assert.equal(r2.redeem.outcome, 'noCredit');
    });
});

test('CA-3 · outcome noCredit/nothingToReset del backend → flag intacto y silencio', async () => {
    await conEntornoAisladoAsync(async ({ credit, pipelineDir }) => {
        escribirFlagCodex(pipelineDir);
        const client = fakeClient({ reads: snapshotSemanalAgotadaConCredito(), consume: { outcome: 'nothingToReset' } });
        const notifier = fakeNotifier();
        const r = await credit.runCodexLiveSweep(baseOpts({ credit, client, notifier }));
        assert.equal(r.redeem.reason, 'outcome_nothingToReset');
        assert.ok(leerFlag(pipelineDir));
        assert.deepEqual(notifier.calls, []);
        assert.equal(leerEstado(pipelineDir).attempts[DETECTADO_ISO].outcome, 'nothingToReset');
    });
});

test('CA-4 · segundo agotamiento semanal en la misma semana → no canjea (max_per_week) y avisa UNA vez', async () => {
    await conEntornoAisladoAsync(async ({ credit, pipelineDir }) => {
        escribirFlagCodex(pipelineDir);
        fs.mkdirSync(path.join(pipelineDir, 'state'), { recursive: true });
        fs.writeFileSync(path.join(pipelineDir, 'state', 'codex-reset-credit.json'), JSON.stringify({
            redemptions: [{ redeemed_at: '2026-09-19T10:00:00.000Z', weekly_resets_at: RESET_SEMANAL_ISO, idempotency_key: 'k0', outcome: 'reset' }],
        }), 'utf8');
        const client = fakeClient({ reads: snapshotSemanalAgotadaConCredito() });
        const notifier = fakeNotifier();
        const r1 = await credit.runCodexLiveSweep(baseOpts({ credit, client, notifier }));
        assert.equal(r1.redeem.reason, 'max_per_week_reached');
        assert.equal(client.llamadas.consume.length, 0);
        assert.ok(leerFlag(pipelineDir));
        assert.equal(notifier.calls.length, 1);
        assert.equal(notifier.calls[0][0], 'alreadyUsed');
        assert.equal(notifier.calls[0][1].resetsAtMs, 1790205939 * 1000, 'reset semanal del snapshot en vivo');
        const r2 = await credit.runCodexLiveSweep(baseOpts({ credit, client, notifier }));
        assert.equal(r2.redeem.reason, 'max_per_week_reached');
        assert.equal(notifier.calls.length, 1, 'no repite en cada barrido');
    });
});

test('CA-4 · la semana es la de codex: con el reset semanal anterior ya vencido, vuelve a canjear', async () => {
    await conEntornoAisladoAsync(async ({ credit, pipelineDir }) => {
        escribirFlagCodex(pipelineDir);
        fs.mkdirSync(path.join(pipelineDir, 'state'), { recursive: true });
        fs.writeFileSync(path.join(pipelineDir, 'state', 'codex-reset-credit.json'), JSON.stringify({
            redemptions: [{ redeemed_at: '2026-09-11T12:00:00.000Z', weekly_resets_at: '2026-09-15T21:18:00.000Z', idempotency_key: 'k0', outcome: 'reset' }],
        }), 'utf8');
        const client = fakeClient({ reads: snapshotSemanalAgotadaConCredito(), consume: { outcome: 'reset' } });
        const r = await credit.runCodexLiveSweep(baseOpts({ credit, client, notifier: fakeNotifier() }));
        assert.equal(r.action, 'redeemed');
    });
});

test('CA-5 · el canje sin respuesta persiste la clave y el reintento la reusa; alreadyRedeemed es éxito', async () => {
    await conEntornoAisladoAsync(async ({ credit, pipelineDir }) => {
        escribirFlagCodex(pipelineDir);
        const timeout = new appServer.AppServerError('timeout', 'sin respuesta');
        const c1 = fakeClient({ reads: snapshotSemanalAgotadaConCredito(), consume: timeout });
        const notifier = fakeNotifier();
        const r1 = await credit.runCodexLiveSweep(baseOpts({ credit, client: c1, notifier }));
        assert.equal(r1.redeem.reason, 'consume_unanswered');
        assert.ok(leerFlag(pipelineDir), 'flag intacto: no sabemos si se consumió');
        assert.equal(leerEstado(pipelineDir).attempts[DETECTADO_ISO].idempotency_key, 'uuid-fijo-0001');
        assert.equal(leerEstado(pipelineDir).attempts[DETECTADO_ISO].outcome, null);
        assert.deepEqual(notifier.calls, []);

        // Reintento: OTRO uuid disponible, pero se reusa el persistido.
        const c2 = fakeClient({ reads: snapshotSemanalAgotadaConCredito(), consume: { outcome: 'alreadyRedeemed' } });
        const r2 = await credit.runCodexLiveSweep(baseOpts({ credit, client: c2, notifier, extra: { uuid: () => 'uuid-NUEVO' } }));
        assert.equal(c2.llamadas.consume[0].idempotencyKey, 'uuid-fijo-0001', 'misma clave → jamás un segundo crédito');
        assert.equal(r2.action, 'redeemed');
        assert.equal(r2.redeem.outcome, 'alreadyRedeemed');
        assert.equal(leerFlag(pipelineDir), null);
        assert.equal(notifier.calls.length, 1);
        assert.equal(notifier.calls[0][0], 'redeemed');
    });
});

test('CA-6 · schema distinto en la lectura → fail-open del flag, fail-closed del crédito', async () => {
    await conEntornoAisladoAsync(async ({ credit, pipelineDir }) => {
        escribirFlagCodex(pipelineDir);
        const client = fakeClient({ reads: { rateLimits: 'no-es-un-objeto' } });
        const notifier = fakeNotifier();
        const r = await credit.runCodexLiveSweep(baseOpts({ credit, client, notifier }));
        assert.equal(r.reason, 'app_server_unavailable');
        assert.equal(client.llamadas.consume.length, 0);
        assert.ok(leerFlag(pipelineDir), 'queda como está');
        assert.deepEqual(notifier.calls, []);
    });
});

test('CA-6 · snapshot sin ventanas ni rollouts → no se puede saber qué se agotó → no canjea', async () => {
    await conEntornoAisladoAsync(async ({ credit, pipelineDir }) => {
        escribirFlagCodex(pipelineDir);
        const client = fakeClient({ reads: { rateLimits: null, rateLimitResetCredits: { availableCount: 3, credits: null } } });
        const r = await credit.runCodexLiveSweep(baseOpts({ credit, client, notifier: fakeNotifier() }));
        assert.equal(r.redeem.reason, 'exhausted_window_unknown');
        assert.equal(client.llamadas.consume.length, 0);
        assert.ok(leerFlag(pipelineDir));
    });
});

test('CA-6 · sin ventanas en vivo, los rollouts locales (#7181) sirven de respaldo para decidir la ventana', async () => {
    await conEntornoAisladoAsync(async ({ credit, pipelineDir }) => {
        escribirFlagCodex(pipelineDir);
        const client = fakeClient({
            reads: { rateLimits: null, rateLimitResetCredits: { availableCount: 1, credits: null } },
            consume: { outcome: 'reset' },
        });
        const adapter = { readObservedWindows: () => ({ tsMs: AHORA, session: { usedPercent: 5, resetAt: 1790000718, windowMinutes: 300 }, weekly: { usedPercent: 100, resetAt: 1790205939, windowMinutes: 10080 } }) };
        const r = await credit.runCodexLiveSweep(baseOpts({ credit, client, notifier: fakeNotifier(), extra: { adapter } }));
        assert.equal(r.action, 'redeemed');
        assert.deepEqual(client.llamadas.consume, [{ idempotencyKey: 'uuid-fijo-0001', creditId: null }], 'sin detalle de créditos → elige el backend');
    });
});

test('CA-6 · outcome desconocido del canje → flag intacto, sin mensaje, la clave queda para reintentar', async () => {
    await conEntornoAisladoAsync(async ({ credit, pipelineDir }) => {
        escribirFlagCodex(pipelineDir);
        const client = fakeClient({ reads: snapshotSemanalAgotadaConCredito(), consume: { outcome: 'somethingNew' } });
        const notifier = fakeNotifier();
        const r = await credit.runCodexLiveSweep(baseOpts({ credit, client, notifier }));
        assert.equal(r.redeem.reason, 'unknown_outcome');
        assert.ok(leerFlag(pipelineDir));
        assert.deepEqual(notifier.calls, []);
        assert.equal(leerEstado(pipelineDir).attempts[DETECTADO_ISO].outcome, null);
    });
});

test('CA-7 · enabled:false desactiva todo: ni spawn, ni disco, ni mensajes', async () => {
    await conEntornoAisladoAsync(async ({ credit, pipelineDir }) => {
        escribirFlagCodex(pipelineDir);
        const client = fakeClient({ reads: snapshotSemanalAgotadaConCredito() });
        const notifier = fakeNotifier();
        const r = await credit.runCodexLiveSweep(baseOpts({ credit, client, notifier, extra: { config: { enabled: false } } }));
        assert.deepEqual(r, { action: 'skipped', reason: 'disabled' });
        assert.equal(client.llamadas.reads, 0);
        assert.equal(leerEstado(pipelineDir), null, 'no escribe state/');
        assert.ok(leerFlag(pipelineDir));
        assert.deepEqual(notifier.calls, []);
    });
});

test('notify:false canjea igual pero no manda Telegram', async () => {
    await conEntornoAisladoAsync(async ({ credit, pipelineDir }) => {
        escribirFlagCodex(pipelineDir);
        const client = fakeClient({ reads: snapshotSemanalAgotadaConCredito(), consume: { outcome: 'reset' } });
        const notifier = fakeNotifier();
        const r = await credit.runCodexLiveSweep(baseOpts({ credit, client, notifier, extra: { config: { notify: false } } }));
        assert.equal(r.action, 'redeemed');
        assert.deepEqual(notifier.calls, []);
    });
});

// =============================================================================
// BLOQUE 2 · Reconciliación en vivo (CA-9 … CA-11)
// =============================================================================

test('CA-9 · snapshot real posterior a un canje manual (semanal 94 %, uso permitido) → el flag se drena en el barrido', async () => {
    await conEntornoAisladoAsync(async ({ credit, pipelineDir }) => {
        // Flag como el del 09-11: semanal hasta dentro de días.
        escribirFlagCodex(pipelineDir, { resetsAt: RESET_SEMANAL_ISO });
        const client = fakeClient({ reads: SNAPSHOT_REAL });
        const notifier = fakeNotifier();
        const r = await credit.runCodexLiveSweep(baseOpts({ credit, client, notifier }));
        assert.equal(r.action, 'cleared_live');
        assert.equal(r.reconcile.reason, 'usage_allowed_live');
        assert.equal(leerFlag(pipelineDir), null, 'drenado sin esperar al resets_at ni a un spawn');
        assert.equal(r.redeem.reason, 'flag_drained_live', 'con el flag drenado no hay nada que canjear');
        assert.equal(client.llamadas.consume.length, 0);
        assert.deepEqual(notifier.calls, [['liveClear', { pct: 94 }]], 'el restored explicará el motivo (copy f)');
        assert.equal(leerEstado(pipelineDir).last_live_drain_ms, AHORA);
    });
});

test('CA-9 · sin permiso publicado, la regla literal: usedPercent<100 y resetsAt pasado → drena', async () => {
    await conEntornoAisladoAsync(async ({ credit, pipelineDir }) => {
        escribirFlagCodex(pipelineDir, { resetsAt: RESET_SEMANAL_ISO });
        const snap = variante((s) => {
            s.ordinaryUsageAllowed = null;
            s.rateLimits.primary.usedPercent = 0;
            s.rateLimits.secondary.usedPercent = 12;
            s.rateLimits.secondary.resetsAt = Math.floor(AHORA / 1000) - 600; // ya pasó
        });
        const r = await credit.runCodexLiveSweep(baseOpts({ credit, client: fakeClient({ reads: snap }), notifier: fakeNotifier() }));
        assert.equal(r.action, 'cleared_live');
        assert.equal(r.reconcile.reason, 'observed_reset_earlier');
        assert.equal(leerFlag(pipelineDir), null);
    });
});

test('CA-9 · sin permiso publicado y reset observado futuro pero anterior al flag → acorta sin drenar', async () => {
    await conEntornoAisladoAsync(async ({ credit, pipelineDir }) => {
        escribirFlagCodex(pipelineDir, { resetsAt: RESET_SEMANAL_ISO });
        const enUnaHora = Math.floor(AHORA / 1000) + 3600;
        const snap = variante((s) => {
            s.ordinaryUsageAllowed = null;
            s.rateLimits.primary.usedPercent = 80;
            s.rateLimits.primary.resetsAt = enUnaHora;
            s.rateLimits.secondary.usedPercent = 12;
        });
        const r = await credit.runCodexLiveSweep(baseOpts({ credit, client: fakeClient({ reads: snap }), notifier: fakeNotifier() }));
        assert.equal(r.action, 'shortened_live');
        assert.equal(leerFlag(pipelineDir).providers['openai-codex'].resets_at, new Date(enUnaHora * 1000).toISOString());
    });
});

test('CA-10 · snapshot al 100 % con resetsAt POSTERIOR al del flag → el flag no se toca (nunca se alarga)', async () => {
    await conEntornoAisladoAsync(async ({ credit, pipelineDir }) => {
        const flagResets = '2026-09-22T00:00:00.000Z';
        escribirFlagCodex(pipelineDir, { resetsAt: flagResets });
        const snap = variante((s) => {
            s.ordinaryUsageAllowed = false;
            s.rateLimits.secondary.usedPercent = 100;
            s.rateLimits.secondary.resetsAt = 1790205939; // 09-23, posterior al flag
        });
        const r = await credit.runCodexLiveSweep(baseOpts({ credit, client: fakeClient({ reads: snap }), notifier: fakeNotifier() }));
        assert.equal(r.reconcile.action, 'noop');
        assert.equal(r.reconcile.reason, 'still_exhausted');
        assert.equal(leerFlag(pipelineDir).providers['openai-codex'].resets_at, flagResets, 'ni acortado ni alargado');
    });
});

test('CA-10 · `ordinaryUsageAllowed:false` o `rateLimitReachedType` mandan aunque el porcentaje sea <100', () => {
    const credit = require('../codex-reset-credit');
    const gov = { usedPercent: 90, resetAt: 1, kind: 'weekly' };
    assert.equal(credit.isStillExhausted({ ordinaryUsageAllowed: false, rateLimitReachedType: null }, gov), true);
    assert.equal(credit.isStillExhausted({ ordinaryUsageAllowed: true, rateLimitReachedType: 'rate_limit_reached' }, gov), true);
    assert.equal(credit.isStillExhausted({ ordinaryUsageAllowed: true, rateLimitReachedType: null }, gov), false);
    assert.equal(credit.isStillExhausted({ ordinaryUsageAllowed: true, rateLimitReachedType: null }, null), true, 'sin ventana no hay evidencia');
});

test('CA-9 · backoff: tras un drenado en vivo no se vuelve a drenar por 1 h si el flag reaparece', () => {
    const credit = require('../codex-reset-credit');
    const parsed = credit.parseLiveSnapshot(SNAPSHOT_REAL);
    const slot = { resets_at: RESET_SEMANAL_ISO };
    const d1 = credit.decideReconcile({ parsed, slot, now: AHORA, lastLiveDrainMs: AHORA - 10 * 60 * 1000, pickGoverningWindow: reconcile.pickGoverningWindow });
    assert.equal(d1.reason, 'live_drain_backoff');
    const d2 = credit.decideReconcile({ parsed, slot, now: AHORA, lastLiveDrainMs: AHORA - 2 * 60 * 60 * 1000, pickGoverningWindow: reconcile.pickGoverningWindow });
    assert.equal(d2.action, 'shorten');
});

test('CA-11 · app-server caído → noop auditado, flag intacto, sin canje; alerta única recién tras 1 h de fallos', async () => {
    await conEntornoAisladoAsync(async ({ credit, pipelineDir }) => {
        escribirFlagCodex(pipelineDir);
        const caido = new appServer.AppServerError('spawn_failed', 'ENOENT');
        const notifier = fakeNotifier();
        const opts = (now) => baseOpts({ credit, client: fakeClient({ fail: caido }), notifier, extra: { now } });

        const r1 = await credit.runCodexLiveSweep(opts(AHORA));
        assert.equal(r1.reason, 'app_server_unavailable');
        assert.equal(r1.code, 'spawn_failed');
        assert.ok(leerFlag(pipelineDir), 'el flag sigue su curso');
        assert.deepEqual(notifier.calls, [], 'silencio por defecto (copy e)');
        assert.equal(leerEstado(pipelineDir).consecutive_failures, 1);

        const r2 = await credit.runCodexLiveSweep(opts(AHORA + 30 * 60 * 1000));
        assert.equal(r2.alerted, false, 'todavía no pasó 1 h');

        const r3 = await credit.runCodexLiveSweep(opts(AHORA + 61 * 60 * 1000));
        assert.equal(r3.alerted, true);
        assert.deepEqual(notifier.calls, [['unavailable']]);

        const r4 = await credit.runCodexLiveSweep(opts(AHORA + 120 * 60 * 1000));
        assert.equal(r4.alerted, false);
        assert.equal(notifier.calls.length, 1, 'una sola alerta');

        // Vuelve a responder: la racha se resetea.
        await credit.runCodexLiveSweep(baseOpts({ credit, client: fakeClient({ reads: snapshotSemanalAgotadaConCredito() }), notifier, extra: { now: AHORA + 130 * 60 * 1000 } }));
        assert.equal(leerEstado(pipelineDir).consecutive_failures, 0);
        assert.equal(leerEstado(pipelineDir).unavailable_notified_ms, null);

        const audit = fs.readdirSync(path.join(pipelineDir, 'logs')).filter(f => f.startsWith('quota-detector-'));
        const lineas = audit.flatMap(f => fs.readFileSync(path.join(pipelineDir, 'logs', f), 'utf8').trim().split('\n')).map(l => JSON.parse(l));
        assert.ok(lineas.some(l => l.event === 'codex_app_server_unavailable' && l.provider === 'openai-codex'), 'noop auditado');
    });
});

// =============================================================================
// BLOQUE 3 · Contrato con el pulpo: sin slot no toca disco; throttle
// =============================================================================

test('sin slot de codex → noop sin tocar state/ ni hablar con el app-server (#7188)', async () => {
    await conEntornoAisladoAsync(async ({ credit, pipelineDir }) => {
        const client = fakeClient({ reads: SNAPSHOT_REAL });
        const r = await credit.runCodexLiveSweep(baseOpts({ credit, client, notifier: fakeNotifier() }));
        assert.deepEqual(r, { action: 'noop', reason: 'no_active_flag' });
        assert.equal(client.llamadas.reads, 0);
        assert.equal(leerEstado(pipelineDir), null);
    });
});

test('throttle persistido de 5 min: el segundo barrido sin force se saltea', async () => {
    await conEntornoAisladoAsync(async ({ credit, pipelineDir }) => {
        escribirFlagCodex(pipelineDir);
        const client = fakeClient({ reads: snapshotSemanalAgotadaSinCredito() });
        const r1 = await credit.runCodexLiveSweep(baseOpts({ credit, client, notifier: fakeNotifier(), extra: { force: false } }));
        assert.equal(r1.reconcile.action, 'noop');
        const r2 = await credit.runCodexLiveSweep(baseOpts({ credit, client, notifier: fakeNotifier(), extra: { force: false, now: AHORA + 60 * 1000 } }));
        assert.deepEqual(r2, { action: 'skipped', reason: 'throttled' });
        const r3 = await credit.runCodexLiveSweep(baseOpts({ credit, client, notifier: fakeNotifier(), extra: { force: false, now: AHORA + credit.DEFAULT_MIN_INTERVAL_MS + 1 } }));
        assert.notEqual(r3.reason, 'throttled');
        assert.equal(client.llamadas.reads, 2);
    });
});

test('scheduleCodexLiveSweep: fire-and-forget, un solo barrido en vuelo, nunca lanza', async () => {
    await conEntornoAisladoAsync(async ({ credit, pipelineDir }) => {
        escribirFlagCodex(pipelineDir);
        let liberar;
        const client = fakeClient({ reads: () => new Promise((res) => { liberar = () => res(snapshotSemanalAgotadaSinCredito()); }) });
        const p1 = credit.scheduleCodexLiveSweep(baseOpts({ credit, client, notifier: fakeNotifier() }));
        assert.ok(p1 && typeof p1.then === 'function');
        assert.equal(credit.scheduleCodexLiveSweep(baseOpts({ credit, client, notifier: fakeNotifier() })), null, 'ya hay uno en vuelo');
        liberar();
        const r = await p1;
        assert.equal(r.reconcile.action, 'noop');
        // Liberado: se puede volver a disparar.
        const p2 = credit.scheduleCodexLiveSweep(baseOpts({ credit, client: fakeClient({ reads: SNAPSHOT_REAL }), notifier: fakeNotifier() }));
        assert.ok(p2);
        await p2;
    });
});

// =============================================================================
// BLOQUE 4 · Notifier: un solo mensaje por evento (contrato UX)
// =============================================================================

function notifierReal({ queued = 2 } = {}) {
    const enviados = [];
    let t = AHORA;
    const n = createQuotaNotifier({
        sendMessage: (text) => enviados.push(text),
        now: () => t,
        setIntervalFn: () => 1,
        clearIntervalFn: () => {},
        getQueuedAgentsCount: () => queued,
        minBlockDurationForRestoredMs: 0,
    });
    return { n, enviados, avanzar: (ms) => { t += ms; } };
}

test('UX · canje + clear del flag → UN solo mensaje, y es el del canje (no el `restored` genérico)', () => {
    const { n, enviados } = notifierReal();
    n.onFlagSet({ provider: 'openai-codex', resets_at: RESET_SEMANAL_ISO });
    enviados.length = 0;
    n.notifyResetCreditRedeemed({ creditsRemaining: 1 });
    n.onFlagCleared(); // el watcher del flag detecta la transición segundos después
    assert.equal(enviados.length, 1);
    assert.equal(enviados[0], 'Canjee un reset de codex: la cuota semanal quedo liberada.\nCreditos de reset restantes: 1.\nDrenando cola de 2 agentes encolados.');
    assert.equal(n.getState().suppressClearUntil, Number.NEGATIVE_INFINITY, 'la supresión se consume');
});

test('UX · variante sin cola del canje', () => {
    const { n, enviados } = notifierReal({ queued: 0 });
    n.notifyResetCreditRedeemed({ creditsRemaining: 0 });
    assert.equal(enviados[0], QUOTA_COPY.resetCreditRedeemedEmpty.replace('{n_creditos}', '0'));
});

test('UX · la supresión vence: un clear posterior al TTL manda el restored normal', () => {
    const { n, enviados, avanzar } = notifierReal();
    n.onFlagSet({ provider: 'openai-codex', resets_at: RESET_SEMANAL_ISO });
    enviados.length = 0;
    n.notifyResetCreditRedeemed({ creditsRemaining: 0 });
    avanzar(CLEAR_CONTEXT_TTL_MS + 1);
    n.onFlagCleared();
    assert.equal(enviados.length, 2);
    assert.match(enviados[1], /^Cuota OpenAI Codex restaurada\./);
});

test('UX · drenado por reconciliación en vivo → el restored explica el motivo (copy f)', () => {
    const { n, enviados } = notifierReal();
    n.onFlagSet({ provider: 'openai-codex', resets_at: RESET_SEMANAL_ISO });
    enviados.length = 0;
    n.markLiveReconcileClear({ pct: 94 });
    n.onFlagCleared();
    assert.equal(enviados.length, 1);
    assert.equal(enviados[0], 'Cuota codex restaurada antes de lo previsto: la ventana semanal esta al 94% segun snapshot en vivo.\nDrenando cola de 2 agentes encolados.');
});

test('UX · copy (b) con reset semanal formateado y copy (e); texto plano sin Markdown ni emojis', () => {
    const { n, enviados } = notifierReal();
    n.notifyResetCreditAlreadyUsed({ resetsAtMs: AHORA + 3 * 60 * 60 * 1000 + 5 * 60 * 1000 });
    n.notifyAppServerUnavailable();
    assert.match(enviados[0], /^Codex sin cuota semanal otra vez y el credito de reset ya se uso esta semana\.\nReset semanal estimado: \d\d:\d\d \(en 3 h 5 min\)\.\nSi queres canjear otro a mano: \/usage en el TUI de codex\.$/);
    assert.equal(enviados[1], QUOTA_COPY.appServerUnavailable);
    for (const k of ['resetCreditRedeemed', 'resetCreditRedeemedEmpty', 'resetCreditAlreadyUsed', 'appServerUnavailable', 'restoredLiveReconcile', 'restoredLiveReconcileEmpty']) {
        assert.doesNotMatch(QUOTA_COPY[k].replace(/\{\w+\}/g, ''), /[*_`#]|[\u{1F300}-\u{1FAFF}]/u, `${k} sin Markdown ni emojis`);
    }
});

// =============================================================================
// BLOQUE 5 · Cliente JSON-RPC sobre stdio (sin spawnear codex)
// =============================================================================

/** Child falso: responde por `handlers[method](params) → result | {error}` y emite ruido. */
function fakeChild({ handlers, ruido = [], exitOnStdinEnd = true, hang = false }) {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.killed = false;
    const out = (o) => child.stdout.write(JSON.stringify(o) + '\n');
    child.stdin = {
        write(line) {
            const msg = JSON.parse(line);
            if (msg.method === 'initialize') {
                out({ id: msg.id, result: { userAgent: 'fake' } });
                for (const r of ruido) out(r);
                return true;
            }
            if (msg.id === undefined) return true; // notificación
            if (hang) return true;
            const h = handlers[msg.method];
            if (!h) { out({ id: msg.id, error: { code: -32601, message: 'method not found' } }); return true; }
            const r = h(msg.params);
            if (r && r.__error) out({ id: msg.id, error: r.__error });
            else out({ id: msg.id, result: r });
            return true;
        },
        end() {
            if (exitOnStdinEnd) setImmediate(() => { child.exitCode = 0; child.emit('exit', 0, null); });
        },
    };
    child.kill = () => { child.killed = true; setImmediate(() => { child.exitCode = null; child.emit('exit', null, 'SIGTERM'); }); };
    return child;
}

test('cliente · handshake, descarta notificaciones sin id, empareja por id y cierra el proceso al terminar', async () => {
    let spawned = null;
    const child = fakeChild({
        handlers: {
            'account/rateLimits/read': () => SNAPSHOT_REAL,
            'account/rateLimitResetCredit/consume': (p) => ({ outcome: p.creditId === 'crd_abc' ? 'reset' : 'noCredit' }),
        },
        // Notificación real del server antes de la respuesta (remoteControl/status/changed).
        ruido: [{ method: 'remoteControl/status/changed', params: { status: 'disabled' } }, { id: 999, result: 'ajena' }],
    });
    const spawnImpl = (cmd, args, opts) => { spawned = { cmd, args, opts }; return child; };
    const r = await appServer.withAppServer(async (session) => {
        const snap = await appServer.readRateLimits(session);
        const c = await appServer.consumeResetCredit(session, { idempotencyKey: 'k', creditId: 'crd_abc' });
        return { snap, c };
    }, { spawnImpl, launcher: { cmd: 'codex-fake', prefixArgs: [], shell: false }, exitGraceMs: 200 });
    assert.equal(r.snap.rateLimits.secondary.usedPercent, 94);
    assert.deepEqual(r.c, { outcome: 'reset' });
    assert.deepEqual(spawned.args, ['app-server']);
    assert.equal(spawned.opts.windowsHide, true);
    assert.equal(child.exitCode, 0, 'terminó solo al cerrar stdin');
    assert.equal(child.killed, false);
});

test('cliente · error JSON-RPC (p. ej. sin login) → AppServerError rpc_error sin exponer el message del server', async () => {
    const child = fakeChild({ handlers: { 'account/rateLimits/read': () => ({ __error: { code: -32000, message: 'not logged in as user@example.com' } }) } });
    await assert.rejects(
        appServer.withAppServer((s) => appServer.readRateLimits(s), { spawnImpl: () => child, launcher: { cmd: 'x', prefixArgs: [] }, exitGraceMs: 200 }),
        (e) => e instanceof appServer.AppServerError && e.code === 'rpc_error' && e.rpcCode === -32000 && !/example\.com/.test(e.message),
    );
});

test('cliente · timeout por llamada → rechaza con `timeout` y el cierre mata el proceso si no sale solo (CA-12)', async () => {
    const child = fakeChild({ handlers: {}, hang: true, exitOnStdinEnd: false });
    await assert.rejects(
        appServer.withAppServer((s) => appServer.readRateLimits(s), {
            spawnImpl: () => child, launcher: { cmd: 'x', prefixArgs: [] }, callTimeoutMs: 50, exitGraceMs: 50,
        }),
        (e) => e instanceof appServer.AppServerError && e.code === 'timeout',
    );
    assert.equal(child.killed, true, 'sin proceso residual');
});

test('cliente · spawn que falla → AppServerError spawn_failed', async () => {
    await assert.rejects(
        appServer.withAppServer(() => {}, { spawnImpl: () => { throw new Error('ENOENT'); }, launcher: { cmd: 'x', prefixArgs: [] } }),
        (e) => e instanceof appServer.AppServerError && e.code === 'spawn_failed',
    );
});

test('cliente · consumeResetCredit exige idempotencyKey y omite creditId cuando es null', async () => {
    const recibidos = [];
    const child = fakeChild({ handlers: { 'account/rateLimitResetCredit/consume': (p) => { recibidos.push(p); return { outcome: 'reset' }; } } });
    await appServer.withAppServer(async (s) => {
        await assert.rejects(appServer.consumeResetCredit(s, { creditId: 'x' }), /idempotencyKey/);
        await appServer.consumeResetCredit(s, { idempotencyKey: 'k1', creditId: null });
    }, { spawnImpl: () => child, launcher: { cmd: 'x', prefixArgs: [] }, exitGraceMs: 200 });
    assert.deepEqual(recibidos, [{ idempotencyKey: 'k1' }]);
});

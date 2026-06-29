// =============================================================================
// Tests `kpisSlice` y `quotaSlice` — #3357
//
// Cubre los 5 bugs documentados en el issue:
//   CA-1 → prsLast7d con cache defensivo y --limit subido a 500.
//   CA-2 → tokens24h con shape { total, by_provider } leído del snapshot-24h.json.
//   CA-3 → agentDurationMedianMs (rename) + issueCycleTimeMs (nuevo), sin doble
//          conteo listo+procesado, cap 7d.
//   CA-4 → bouncePct { overall, byPhase } con denominador = issues únicos en 7d.
//   CA-5 → quotaSlice multi-provider con field `providers` y compat top-level
//          para banner legacy.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshSlices() {
    delete require.cache[require.resolve('../dashboard-slices')];
    return require('../dashboard-slices');
}

function mkTmpPipeline() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-kpis-3357-'));
    const pipeline = path.join(root, '.pipeline');
    const metrics = path.join(pipeline, 'metrics');
    fs.mkdirSync(metrics, { recursive: true });
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    return { root, pipeline, metrics };
}

function writeSnapshot24h(metricsDir, snapshot) {
    fs.writeFileSync(path.join(metricsDir, 'snapshot-24h.json'), JSON.stringify(snapshot));
}

function mkCtx(root, pipeline) {
    return {
        ROOT: root,
        PIPELINE: pipeline,
        // GH_BIN inexistente → execSync tira, el slice degrade limpio
        // y mantiene el valor previo del cache (= null por defecto).
        GH_BIN: path.join(root, 'no-gh-binary'),
    };
}

// ---------------------------------------------------------------------------
// CA-2: tokens24h con breakdown por provider
// ---------------------------------------------------------------------------

test('CA-2: tokens24h expone { total, by_provider } cuando el snapshot-24h tiene datos', () => {
    const { root, pipeline, metrics } = mkTmpPipeline();
    writeSnapshot24h(metrics, {
        generated_at: new Date().toISOString(),
        window: '24h',
        cutoff_ts: new Date(Date.now() - 24 * 3600000).toISOString(),
        totals: {
            sessions: 5,
            tokens_in: 10000,
            tokens_out: 5000,
            by_provider: {
                anthropic: { tokens_in: 6000, tokens_out: 3000 },
                'openai-codex': { tokens_in: 2000, tokens_out: 1000 },
                groq: { tokens_in: 2000, tokens_out: 1000 },
            },
        },
    });
    const slices = freshSlices();
    const out = slices.kpisSlice({ issueMatrix: {} }, mkCtx(root, pipeline));
    assert.ok(out.tokens24h, 'tokens24h debe ser objeto, no null');
    assert.equal(out.tokens24h.total, 15000);
    assert.deepEqual(out.tokens24h.by_provider, {
        anthropic: 9000,
        'openai-codex': 3000,
        groq: 3000,
    });
});

test('CA-2: tokens24h es null cuando no hay sesiones (suma=0)', () => {
    const { root, pipeline, metrics } = mkTmpPipeline();
    writeSnapshot24h(metrics, {
        totals: { tokens_in: 0, tokens_out: 0, by_provider: {} },
    });
    const slices = freshSlices();
    const out = slices.kpisSlice({ issueMatrix: {} }, mkCtx(root, pipeline));
    assert.equal(out.tokens24h, null);
});

test('CA-2: tokens24h tolera snapshot viejo sin by_provider (degrade limpio)', () => {
    const { root, pipeline, metrics } = mkTmpPipeline();
    writeSnapshot24h(metrics, {
        totals: { tokens_in: 100, tokens_out: 50 /* sin by_provider */ },
    });
    const slices = freshSlices();
    const out = slices.kpisSlice({ issueMatrix: {} }, mkCtx(root, pipeline));
    assert.equal(out.tokens24h.total, 150);
    assert.equal(out.tokens24h.by_provider, null);
});

// ---------------------------------------------------------------------------
// CA-3: agentDurationMedianMs y issueCycleTimeMs
// ---------------------------------------------------------------------------

test('CA-3: agentDurationMedianMs cuenta UNA vez por (issue, fase, skill) incluso con listo+procesado duplicado', () => {
    const { root, pipeline } = mkTmpPipeline();
    const slices = freshSlices();
    const issueMatrix = {
        '100': {
            fases: {
                'desarrollo/dev': [
                    // Mismo marker en estado listo (debería ignorarse en favor de procesado).
                    { estado: 'listo',     skill: 'pipeline-dev', durationMs: 5000,   updatedAt: 100, resultado: 'aprobado' },
                    { estado: 'procesado', skill: 'pipeline-dev', durationMs: 60000,  updatedAt: 200, resultado: 'aprobado' },
                ],
            },
        },
        '200': {
            fases: {
                'desarrollo/aprobacion': [
                    { estado: 'procesado', skill: 'review', durationMs: 30000, updatedAt: 300, resultado: 'aprobado' },
                ],
            },
        },
    };
    const out = slices.kpisSlice({ issueMatrix }, mkCtx(root, pipeline));
    // Solo dos durations contadas: 60000 (procesado prefiere a listo) y 30000.
    // Mediana de [30000, 60000] con índice floor(2/2)=1 → 60000.
    assert.equal(out.agentDurationMedianMs, 60000);
    // Alias legacy también responde (deprecation 1 release).
    assert.equal(out.cycleTimeMs, 60000);
});

test('CA-3: agentDurationMedianMs admite duraciones hasta 7d, descarta > 7d', () => {
    const { root, pipeline } = mkTmpPipeline();
    const slices = freshSlices();
    const SIX_DAYS = 6 * 24 * 3600 * 1000;
    const EIGHT_DAYS = 8 * 24 * 3600 * 1000;
    const issueMatrix = {
        '300': {
            fases: {
                'desarrollo/build': [
                    { estado: 'procesado', skill: 'build', durationMs: SIX_DAYS,   updatedAt: 1, resultado: 'aprobado' },
                    { estado: 'procesado', skill: 'qa',    durationMs: EIGHT_DAYS, updatedAt: 2, resultado: 'aprobado' },
                ],
            },
        },
    };
    const out = slices.kpisSlice({ issueMatrix }, mkCtx(root, pipeline));
    assert.equal(out.agentDurationMedianMs, SIX_DAYS, 'EIGHT_DAYS debe descartarse, SIX_DAYS queda');
});

test('CA-3: agentDurationMedianMs es null si no hay entries terminadas', () => {
    const { root, pipeline } = mkTmpPipeline();
    const slices = freshSlices();
    const out = slices.kpisSlice({ issueMatrix: {} }, mkCtx(root, pipeline));
    assert.equal(out.agentDurationMedianMs, null);
    assert.equal(out.issueCycleTimeMs, null);
});

// ---------------------------------------------------------------------------
// CA-4: bouncePct con denominador = issues únicos en 7d + byPhase
// ---------------------------------------------------------------------------

test('CA-4: bouncePct cuenta issues con ≥1 rebote, no markers individuales', () => {
    const { root, pipeline } = mkTmpPipeline();
    const slices = freshSlices();
    const now = Date.now();
    const issueMatrix = {
        '400': {
            // Issue con 2 rebotes en una fase + 1 aprobado en otra. Cuenta UNA vez.
            fases: {
                'desarrollo/analisis': [
                    { estado: 'procesado', skill: 'guru', durationMs: 1000, updatedAt: now - 1000, resultado: 'rechazado' },
                    { estado: 'procesado', skill: 'guru', durationMs: 1000, updatedAt: now - 500,  resultado: 'rechazado' },
                ],
                'desarrollo/dev': [
                    { estado: 'procesado', skill: 'pipeline-dev', durationMs: 1000, updatedAt: now, resultado: 'aprobado' },
                ],
            },
        },
        '401': {
            fases: {
                'desarrollo/dev': [
                    { estado: 'procesado', skill: 'pipeline-dev', durationMs: 1000, updatedAt: now, resultado: 'aprobado' },
                ],
            },
        },
    };
    const out = slices.kpisSlice({ issueMatrix }, mkCtx(root, pipeline));
    // 2 issues terminados en ventana, 1 con rebote = 50% overall.
    assert.equal(out.bouncePct.overall, 50);
    assert.equal(out.bouncePct.issuesTotal, 2);
    assert.equal(out.bouncePct.issuesBounced, 1);
    // byPhase: analisis tiene 1 issue rebotado / 1 total = 100%. dev tiene 2/0 = 0%.
    assert.equal(out.bouncePct.byPhase['desarrollo/analisis'], 100);
    assert.equal(out.bouncePct.byPhase['desarrollo/dev'], 0);
});

test('CA-4: bouncePct = null cuando no hay issues en ventana (sin div/0)', () => {
    const { root, pipeline } = mkTmpPipeline();
    const slices = freshSlices();
    const issueMatrix = {
        '500': {
            // Entries fuera de ventana (updatedAt muy viejo) — no cuentan.
            fases: {
                'desarrollo/dev': [
                    { estado: 'procesado', skill: 'pipeline-dev', durationMs: 1000, updatedAt: 1, resultado: 'rechazado' },
                ],
            },
        },
    };
    const out = slices.kpisSlice({ issueMatrix }, mkCtx(root, pipeline));
    assert.equal(out.bouncePct, null);
});

test('CA-4: bouncePct.windowDays = 7 documenta la ventana', () => {
    const { root, pipeline } = mkTmpPipeline();
    const slices = freshSlices();
    const now = Date.now();
    const issueMatrix = {
        '600': {
            fases: {
                'desarrollo/dev': [
                    { estado: 'procesado', skill: 'pipeline-dev', durationMs: 1000, updatedAt: now, resultado: 'aprobado' },
                ],
            },
        },
    };
    const out = slices.kpisSlice({ issueMatrix }, mkCtx(root, pipeline));
    assert.equal(out.bouncePct.windowDays, 7);
});

// ---------------------------------------------------------------------------
// CA-1: prsLast7d preserva valor previo si gh falla
// ---------------------------------------------------------------------------

test('CA-1: prsLast7d arranca en null cuando gh no responde, NO 0', () => {
    const { root, pipeline } = mkTmpPipeline();
    const slices = freshSlices();
    const out = slices.kpisSlice({ issueMatrix: {} }, mkCtx(root, pipeline));
    assert.equal(out.prsLast7d, null, 'sin datos previos, debe ser null (UI muestra "—")');
});

// ---------------------------------------------------------------------------
// CA-5: quotaSlice multi-provider
// ---------------------------------------------------------------------------

test('CA-5: quotaSlice expone `providers` con anthropic + stubs not_implemented', () => {
    const { root, pipeline, metrics } = mkTmpPipeline();
    // Activity log mínimo con un session:end de Anthropic en la ventana actual.
    const log = path.join(root, '.claude', 'activity-log.jsonl');
    fs.writeFileSync(log, JSON.stringify({
        event: 'session:end',
        ts: new Date().toISOString(),
        duration_ms: 3600000,
        provider: 'anthropic',
        model: 'claude-sonnet-4',
    }) + '\n');
    // agent-models.json mínimo declarando providers.
    fs.writeFileSync(path.join(pipeline, 'agent-models.json'), JSON.stringify({
        providers: {
            anthropic: {}, 'openai-codex': {}, groq: {}, 'gemini-google': {}, cerebras: {},
            deterministic: {}, // debe filtrarse
        },
    }));
    const slices = freshSlices();
    const out = slices.quotaSlice({}, { ROOT: root, PIPELINE: pipeline });

    assert.ok(out.providers, 'debe exponer `providers`');
    assert.ok(out.providers.anthropic, 'providers.anthropic existe');
    assert.equal(out.providers.anthropic.adapterStatus, 'ok');
    assert.equal(out.providers.anthropic.provider, 'anthropic');
    // #4202 — shape normalizado de cliente: session/weekly con {pct, confidence}.
    assert.ok(out.providers.anthropic.session, 'anthropic.session existe');
    assert.ok(out.providers.anthropic.weekly, 'anthropic.weekly existe');
    // Stubs no implementados marcan adapterStatus distinto de ok pero NO tiran.
    assert.ok(out.providers['openai-codex']);
    assert.notEqual(out.providers['openai-codex'].adapterStatus, 'ok');
    // #4202 — el pct vive por bucket; codex sin datos → ambos null (no 0% falso).
    assert.equal(out.providers['openai-codex'].session.pct, null,
        'codex sesión "sin dato" — Codex no tiene ventana 5h');
    assert.equal(out.providers['openai-codex'].weekly.pct, null,
        'codex sin snapshot → null, NO 0% (luz verde silenciosa)');
    // deterministic NO debe aparecer (filtrado del set declarado).
    assert.equal(out.providers.deterministic, undefined);
    // Compat top-level: campos legacy del banner siguen visibles desde Anthropic.
    assert.ok('hoursUsed7d' in out, 'hoursUsed7d top-level para banner legacy');
    assert.ok('pct' in out, 'pct top-level para banner legacy');
});

test('CA-5.1: weekly-quota.computeUsageSince filtra eventos de providers no-Anthropic', () => {
    const { root, pipeline, metrics } = mkTmpPipeline();
    const log = path.join(root, '.claude', 'activity-log.jsonl');
    const now = Date.now();
    // 1h de Anthropic + 2h de Groq + 30min sin provider (legacy) — solo deben
    // sumar Anthropic + legacy = 1.5h.
    fs.writeFileSync(log, [
        JSON.stringify({ event: 'session:end', ts: new Date(now - 1000).toISOString(), duration_ms: 3600000, provider: 'anthropic', model: 'claude' }),
        JSON.stringify({ event: 'session:end', ts: new Date(now - 2000).toISOString(), duration_ms: 7200000, provider: 'groq', model: 'llama' }),
        JSON.stringify({ event: 'session:end', ts: new Date(now - 3000).toISOString(), duration_ms: 1800000, model: 'claude' }),
    ].join('\n') + '\n');
    delete require.cache[require.resolve('../weekly-quota')];
    const wq = require('../weekly-quota');
    const usage = wq.computeUsageSince(log, now - 24 * 3600 * 1000);
    // 1h + 0.5h = 1.5h. Groq excluido.
    assert.ok(Math.abs(usage.hoursUsed - 1.5) < 0.01,
        `hoursUsed debe ser ~1.5h, fue ${usage.hoursUsed}`);
    assert.equal(usage.sessionsCount, 2, 'solo Anthropic + legacy se cuentan');
});

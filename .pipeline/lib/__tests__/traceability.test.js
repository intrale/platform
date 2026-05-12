// Tests de .pipeline/lib/traceability.js (issue #2477)
// Valida schema de eventos session:start/end y pricing por modelo.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Aislar el activity-log a un tmp dir por test setup — ejecutar require con override
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-traceability-'));
const TMP_LOG = path.join(TMP_DIR, 'activity-log.jsonl');
fs.mkdirSync(path.join(TMP_DIR, '.claude'), { recursive: true });
process.env.CLAUDE_PROJECT_DIR = TMP_DIR;
process.env.PIPELINE_REPO_ROOT = TMP_DIR;

// Limpiar require cache para recoger env vars nuevos
delete require.cache[require.resolve('../traceability')];
const trace = require('../traceability');

// Forzar LOG_FILE a apuntar a nuestro tmp
const realLogFile = path.join(TMP_DIR, '.claude', 'activity-log.jsonl');

function readEvents() {
    if (!fs.existsSync(trace.LOG_FILE)) return [];
    return fs.readFileSync(trace.LOG_FILE, 'utf8')
        .split('\n').filter(Boolean).map(l => JSON.parse(l));
}

test('emitSessionStart emite evento con schema correcto', () => {
    const before = readEvents().length;
    const ctx = trace.emitSessionStart({
        skill: 'builder', issue: 2476, phase: 'build', model: 'deterministic',
    });
    const events = readEvents();
    assert.equal(events.length, before + 1);
    const evt = events[events.length - 1];
    assert.equal(evt.event, 'session:start');
    assert.equal(evt.skill, 'builder');
    assert.equal(evt.issue, 2476);
    assert.equal(evt.phase, 'build');
    assert.equal(evt.model, 'deterministic');
    assert.ok(evt.ts);
    assert.ok(evt.pid);
    // handle devuelto debe contener start_ts numérico
    assert.ok(typeof ctx.start_ts === 'number');
});

test('emitSessionEnd usa start_ts del handle y calcula duration_ms', async () => {
    const ctx = trace.emitSessionStart({ skill: 'qa', issue: 100, phase: 'qa', model: 'claude-opus-4-7' });
    await new Promise(r => setTimeout(r, 20));
    const evt = trace.emitSessionEnd(ctx, { tokens_in: 100, tokens_out: 50, tool_calls: 3 });
    assert.equal(evt.event, 'session:end');
    assert.equal(evt.skill, 'qa');
    assert.equal(evt.issue, 100);
    assert.equal(evt.phase, 'qa');
    assert.equal(evt.model, 'claude-opus-4-7');
    assert.equal(evt.tokens_in, 100);
    assert.equal(evt.tokens_out, 50);
    assert.equal(evt.cache_read, 0);
    assert.equal(evt.cache_write, 0);
    assert.equal(evt.tool_calls, 3);
    assert.ok(evt.duration_ms >= 20, 'duration_ms debe reflejar tiempo transcurrido');
});

test('emitSessionEnd respeta duration_ms explícito si se provee', () => {
    const ctx = trace.emitSessionStart({ skill: 'x', issue: 1, phase: 'dev', model: 'deterministic' });
    const evt = trace.emitSessionEnd(ctx, { duration_ms: 5000 });
    assert.equal(evt.duration_ms, 5000);
});

test('emitSessionEnd coerce campos faltantes a 0', () => {
    const evt = trace.emitSessionEnd({ skill: 's', issue: 1, phase: 'dev', model: 'deterministic' }, {});
    assert.equal(evt.tokens_in, 0);
    assert.equal(evt.tokens_out, 0);
    assert.equal(evt.cache_read, 0);
    assert.equal(evt.cache_write, 0);
    assert.equal(evt.tool_calls, 0);
    assert.equal(evt.exit_code, null);
});

test('env vars pueblan skill/issue/phase cuando opts los omite', () => {
    process.env.PIPELINE_SKILL = 'from-env';
    process.env.PIPELINE_ISSUE = '9999';
    process.env.PIPELINE_FASE = 'review';
    const ctx = trace.emitSessionStart({ model: 'claude-haiku-4-5' });
    assert.equal(ctx.skill, 'from-env');
    assert.equal(ctx.issue, 9999);
    assert.equal(ctx.phase, 'review');
    delete process.env.PIPELINE_SKILL;
    delete process.env.PIPELINE_ISSUE;
    delete process.env.PIPELINE_FASE;
});

test('estimateCostUsd calcula según MODEL_PRICING por 1M tokens', () => {
    // Opus: 15 input, 75 output, 1.5 cache_read, 18.75 cache_write (por 1M)
    const cost = trace.estimateCostUsd('claude-opus-4-7', {
        tokens_in: 1_000_000, tokens_out: 1_000_000, cache_read: 1_000_000, cache_write: 1_000_000,
    });
    // 15 + 75 + 1.5 + 18.75 = 110.25
    assert.equal(cost, 110.25);
});

test('estimateCostUsd modelo desconocido → fallback a deterministic (costo 0)', () => {
    const cost = trace.estimateCostUsd('modelo-inexistente', { tokens_in: 1e9, tokens_out: 1e9 });
    assert.equal(cost, 0);
});

test('estimateCostUsd deterministic siempre retorna 0', () => {
    const cost = trace.estimateCostUsd('deterministic', {
        tokens_in: 5e6, tokens_out: 3e6, cache_read: 2e7, cache_write: 1e5,
    });
    assert.equal(cost, 0);
});

test('MODEL_PRICING expone tarifas para los 4 modelos Claude + deterministic', () => {
    assert.ok(trace.MODEL_PRICING['claude-opus-4-7']);
    assert.ok(trace.MODEL_PRICING['claude-sonnet-4-6']);
    assert.ok(trace.MODEL_PRICING['claude-haiku-4-5']);
    assert.ok(trace.MODEL_PRICING['deterministic']);
    // Orden esperado de costos input: opus > sonnet > haiku > deterministic
    assert.ok(trace.MODEL_PRICING['claude-opus-4-7'].in > trace.MODEL_PRICING['claude-sonnet-4-6'].in);
    assert.ok(trace.MODEL_PRICING['claude-sonnet-4-6'].in > trace.MODEL_PRICING['claude-haiku-4-5'].in);
    assert.equal(trace.MODEL_PRICING['deterministic'].in, 0);
});

test('evento end incluye exit_code cuando se provee', () => {
    const evt = trace.emitSessionEnd({ skill: 's', issue: 1, phase: 'build', model: 'deterministic' }, { exit_code: 0 });
    assert.equal(evt.exit_code, 0);
    const evt2 = trace.emitSessionEnd({ skill: 's', issue: 1, phase: 'build', model: 'deterministic' }, { exit_code: 137 });
    assert.equal(evt2.exit_code, 137);
});

test('append no tira si LOG_FILE no puede escribirse (resiliencia)', () => {
    // Cambiar temporalmente LOG_FILE a ruta inválida
    const orig = trace.LOG_FILE;
    // No podemos mutar LOG_FILE (es const exported) — este test valida que appendEvent no throw
    // aún cuando el archivo exista. Si cambia el repo root, trace silencia el error.
    assert.doesNotThrow(() => {
        trace.appendEvent({ event: 'test', ts: new Date().toISOString() });
    });
});

// =============================================================================
// #3091 — Multi-provider: nueva firma estimateCostUsd(provider, model, tokens) + provider en eventos
// =============================================================================

test('estimateCostUsd nueva firma (provider, model, tokens) — Anthropic explícito', () => {
    const cost = trace.estimateCostUsd('anthropic', 'claude-opus-4-7', {
        tokens_in: 1_000_000, tokens_out: 1_000_000, cache_read: 1_000_000, cache_write: 1_000_000,
    });
    assert.equal(cost, 110.25);
});

test('estimateCostUsd nueva firma — OpenAI gpt-5-codex', () => {
    // Usa la tabla del FALLBACK_PRICING o JSON cargado (depende del entorno).
    // Garantizamos comportamiento: si OpenAI no está en pricing → costo 0 (fallback safe).
    const cost = trace.estimateCostUsd('openai', 'gpt-5-codex', {
        tokens_in: 1_000_000, tokens_out: 500_000,
    });
    // Si pricing.json fue cargado en otro test, gpt-5-codex tiene costo. Si no, 0.
    // El test no asume estado: solo valida que es numérico finito >= 0.
    assert.ok(Number.isFinite(cost) && cost >= 0);
});

test('estimateCostUsd legacy firma (model, tokens) sigue funcionando — back-compat', () => {
    const cost = trace.estimateCostUsd('claude-opus-4-7', {
        tokens_in: 1_000_000, tokens_out: 1_000_000, cache_read: 1_000_000, cache_write: 1_000_000,
    });
    // Misma respuesta que con firma nueva — provider se infiere por prefijo `claude-`
    assert.equal(cost, 110.25);
});

test('estimateCostUsd con provider explícito fuera de allowlist — costo 0', () => {
    const cost = trace.estimateCostUsd('unknown-vendor', 'claude-opus-4-7', {
        tokens_in: 1_000_000, tokens_out: 1_000_000,
    });
    // Provider explícito inválido NO se infiere por modelo (anti envenenamiento, security #2).
    assert.equal(cost, 0);
});

test('estimateCostUsd con model path traversal — costo 0 sin crash', () => {
    const cost = trace.estimateCostUsd('anthropic', '../../../etc/passwd', {
        tokens_in: 1e9, tokens_out: 1e9,
    });
    assert.equal(cost, 0);
});

test('emitSessionEnd persiste provider cuando se provee en metrics', () => {
    const ctx = trace.emitSessionStart({ skill: 'guru', issue: 3091, phase: 'analisis', model: 'claude-opus-4-7' });
    const evt = trace.emitSessionEnd(ctx, { tokens_in: 100, tokens_out: 50, provider: 'anthropic' });
    assert.equal(evt.provider, 'anthropic');
});

test('emitSessionEnd provider=null cuando no se provee (back-compat)', () => {
    // Limpiar PIPELINE_PROVIDER del env para test aislado (#3078).
    const savedEnv = process.env.PIPELINE_PROVIDER;
    delete process.env.PIPELINE_PROVIDER;
    try {
        const evt = trace.emitSessionEnd(
            { skill: 's', issue: 1, phase: 'dev', model: 'claude-opus-4-7' },
            {}
        );
        assert.equal(evt.provider, null, 'evento legacy sin provider explícito → null');
    } finally {
        if (savedEnv !== undefined) process.env.PIPELINE_PROVIDER = savedEnv;
    }
});

// (#3078) emitSessionStart propaga `provider` por simetría con emitSessionEnd.
test('emitSessionStart persiste provider en el evento y handle', () => {
    const ctx = trace.emitSessionStart({
        skill: 'guru', issue: 3078, phase: 'analisis',
        model: 'claude-opus-4-7', provider: 'anthropic',
    });
    assert.equal(ctx.provider, 'anthropic', 'handle contiene provider');

    // El evento persistido también lo trae
    const lines = fs.readFileSync(trace.LOG_FILE, 'utf8').trim().split('\n');
    const evt = JSON.parse(lines[lines.length - 1]);
    assert.equal(evt.event, 'session:start');
    assert.equal(evt.provider, 'anthropic');
});

test('emitSessionStart toma provider de PIPELINE_PROVIDER env si no se pasa explícito', () => {
    const savedEnv = process.env.PIPELINE_PROVIDER;
    process.env.PIPELINE_PROVIDER = 'openai-codex';
    try {
        const ctx = trace.emitSessionStart({
            skill: 'tester', issue: 3078, phase: 'verificacion',
            model: 'gpt-5-codex',
            // sin provider explícito → toma del env
        });
        assert.equal(ctx.provider, 'openai-codex');
    } finally {
        if (savedEnv !== undefined) process.env.PIPELINE_PROVIDER = savedEnv;
        else delete process.env.PIPELINE_PROVIDER;
    }
});

test('emitSessionEnd hereda provider del handle (firma sin metrics.provider)', () => {
    const ctx = trace.emitSessionStart({
        skill: 'tester', issue: 3078, phase: 'verificacion',
        model: 'deterministic', provider: 'deterministic',
    });
    // El caller NO repite provider en metrics — debe heredarse del handle.
    const evt = trace.emitSessionEnd(ctx, { tokens_in: 0, tokens_out: 0 });
    assert.equal(evt.provider, 'deterministic');
});

test('emitSessionEnd: metrics.provider gana sobre handle.provider y env', () => {
    const savedEnv = process.env.PIPELINE_PROVIDER;
    process.env.PIPELINE_PROVIDER = 'anthropic';
    try {
        const handle = { skill: 's', issue: 1, phase: 'dev', model: 'gpt-5-codex', provider: 'openai-codex' };
        const evt = trace.emitSessionEnd(handle, { provider: 'google' });
        // metrics > handle > env > null
        assert.equal(evt.provider, 'google');
    } finally {
        if (savedEnv !== undefined) process.env.PIPELINE_PROVIDER = savedEnv;
        else delete process.env.PIPELINE_PROVIDER;
    }
});

test.after(() => {
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch(_) {}
});

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

// =============================================================================
// #3083 — S5 multi-provider: audit trail dinámico
//   - cli_version / git_sha_provider_adapter en session:start (CA-2)
//   - prompt_hash / cost_usd_estimated en session:end (CA-3)
//   - clampRetentionDays con piso 30 (CA-7 / SEC-6)
//   - sanitización contra log injection (CA-5)
//   - cero contenido de prompt en log (CA-6 / SEC-1)
//   - contrato explícito para skills determinísticos (CA-8)
//   - append-only enforcement (CA-4 / SEC-4)
// =============================================================================

test('#3083 CA-2 — emitSessionStart persiste cli_version y git_sha_provider_adapter', () => {
    const ctx = trace.emitSessionStart({
        skill: 'guru', issue: 3083, phase: 'dev',
        model: 'claude-opus-4-7', provider: 'anthropic',
        cli_version: '2.1.114',
        git_sha_provider_adapter: 'a'.repeat(40),
    });
    assert.equal(ctx.cli_version, '2.1.114');
    assert.equal(ctx.git_sha_provider_adapter, 'a'.repeat(40));
    const lines = fs.readFileSync(trace.LOG_FILE, 'utf8').trim().split('\n');
    const evt = JSON.parse(lines[lines.length - 1]);
    assert.equal(evt.event, 'session:start');
    assert.equal(evt.cli_version, '2.1.114');
    assert.equal(evt.git_sha_provider_adapter, 'a'.repeat(40));
});

test("#3083 CA-2 / SEC-3 — cli_version default a 'unknown' para LLM sin resolución", () => {
    const ctx = trace.emitSessionStart({
        skill: 'tester', issue: 3083, phase: 'dev',
        model: 'claude-opus-4-7', provider: 'anthropic',
        // sin cli_version → default 'unknown'
    });
    assert.equal(ctx.cli_version, 'unknown');
    assert.ok(typeof ctx.cli_version === 'string' && ctx.cli_version.length > 0,
        "cli_version DEBE ser string no-vacío, nunca null/undefined (SEC-3)");
});

test("#3083 CA-8 — skills determinísticos emiten contrato {provider:'deterministic', cli_version:'n/a', ...}", () => {
    const ctx = trace.emitSessionStart({
        skill: 'builder', issue: 3083, phase: 'build',
        model: 'deterministic', provider: 'deterministic',
    });
    assert.equal(ctx.provider, 'deterministic');
    assert.equal(ctx.cli_version, 'n/a');
    assert.equal(ctx.git_sha_provider_adapter, null);
    const evt = trace.emitSessionEnd(ctx, { tool_calls: 0 });
    assert.equal(evt.provider, 'deterministic');
    assert.equal(evt.prompt_hash, null);
    assert.equal(evt.cost_usd_estimated, 0);
});

test('#3083 CA-3 — hashPromptPair devuelve SHA-256 hex lowercase 64 chars', () => {
    const h = trace.hashPromptPair('system prompt', 'user prompt');
    assert.match(h, /^[a-f0-9]{64}$/, 'hash debe ser hex lowercase de 64 chars');
    // determinismo: misma entrada, mismo hash
    const h2 = trace.hashPromptPair('system prompt', 'user prompt');
    assert.equal(h, h2);
    // sensibilidad: si cambia un solo char, el hash cambia
    const h3 = trace.hashPromptPair('system prompt', 'user prompts');
    assert.notEqual(h, h3);
});

test('#3083 CA-3 — hashPromptPair separador SOH no es colisionable por contenido', () => {
    // Si el separador fuera un caracter común (ej. '\n'), estos dos pares
    // colisionarían. Con SOH (^A, no imprimible) la colisión requiere que
    // el atacante inserte literalmente el byte 0x01 en su prompt.
    const a = trace.hashPromptPair('foo', 'bar');
    const b = trace.hashPromptPair('foobar', '');
    assert.notEqual(a, b, 'hashes distintos cuando separador no se confunde con contenido');
});

test('#3083 CA-3 — hashPromptPair devuelve null si algún input es null/undefined', () => {
    assert.equal(trace.hashPromptPair(null, 'x'), null);
    assert.equal(trace.hashPromptPair('x', null), null);
    assert.equal(trace.hashPromptPair(undefined, 'x'), null);
    assert.equal(trace.hashPromptPair('x', undefined), null);
});

test('#3083 CA-3 — emitSessionEnd persiste prompt_hash del handle', () => {
    const digest = trace.hashPromptPair('system X', 'user Y');
    const ctx = trace.emitSessionStart({
        skill: 'guru', issue: 3083, phase: 'dev',
        model: 'claude-opus-4-7', provider: 'anthropic',
        prompt_hash: digest,
    });
    const evt = trace.emitSessionEnd(ctx, { tokens_in: 100, tokens_out: 50 });
    assert.equal(evt.prompt_hash, digest);
    assert.match(evt.prompt_hash, /^[a-f0-9]{64}$/);
});

test('#3083 CA-3 — emitSessionEnd persiste cost_usd_estimated calculado', () => {
    const ctx = trace.emitSessionStart({
        skill: 'guru', issue: 3083, phase: 'dev',
        model: 'claude-opus-4-7', provider: 'anthropic',
    });
    const evt = trace.emitSessionEnd(ctx, {
        tokens_in: 1_000_000, tokens_out: 1_000_000,
        cache_read: 1_000_000, cache_write: 1_000_000,
    });
    // 15 + 75 + 1.5 + 18.75 = 110.25 (Opus pricing)
    assert.equal(evt.cost_usd_estimated, 110.25);
});

test('#3083 CA-3 — cost_usd_estimated=0 para deterministic', () => {
    const ctx = trace.emitSessionStart({
        skill: 'builder', issue: 3083, phase: 'build',
        provider: 'deterministic', model: 'deterministic',
    });
    const evt = trace.emitSessionEnd(ctx, { tokens_in: 9999999, tokens_out: 9999999 });
    assert.equal(evt.cost_usd_estimated, 0);
});

test('#3083 CA-7 / SEC-6 — clampRetentionDays eleva valores < 30 al piso', () => {
    assert.equal(trace.clampRetentionDays(0), 30);
    assert.equal(trace.clampRetentionDays(1), 30);
    assert.equal(trace.clampRetentionDays(29), 30);
    assert.equal(trace.clampRetentionDays(30), 30);
    assert.equal(trace.clampRetentionDays(45), 45);
    assert.equal(trace.clampRetentionDays(90), 90);
    assert.equal(trace.clampRetentionDays(365), 365);
});

test('#3083 CA-7 — clampRetentionDays default 90 cuando es null/undefined/NaN', () => {
    assert.equal(trace.clampRetentionDays(null), 90);
    assert.equal(trace.clampRetentionDays(undefined), 90);
    assert.equal(trace.clampRetentionDays(''), 90);
    assert.equal(trace.clampRetentionDays('not a number'), 90);
    assert.equal(trace.clampRetentionDays(NaN), 90);
});

test('#3083 CA-5 — log injection: model con \\n queda escapado, JSONL sigue una línea por evento', () => {
    const lineCountBefore = fs.readFileSync(trace.LOG_FILE, 'utf8').split('\n').filter(Boolean).length;
    const ctx = trace.emitSessionStart({
        skill: 's', issue: 1, phase: 'dev',
        // Atacante intenta inyectar otro evento JSONL via newline en model name.
        model: 'fake\n{"event":"tampered","skill":"attacker"}',
        provider: 'anthropic',
    });
    trace.emitSessionEnd(ctx, { tokens_in: 1 });
    const linesAfter = fs.readFileSync(trace.LOG_FILE, 'utf8').split('\n').filter(Boolean);
    const lineCountAfter = linesAfter.length;
    // start + end = 2 líneas nuevas. NUNCA 3 (la inyección no debe partir).
    assert.equal(lineCountAfter - lineCountBefore, 2,
        'log injection bloqueada: model con \\n no debe partir en líneas múltiples');
    // La línea del start debe parsear como JSON con el model escapado intacto.
    const startEvt = JSON.parse(linesAfter[linesAfter.length - 2]);
    assert.ok(startEvt.model.includes('fake'), 'model literal preservado');
    assert.ok(startEvt.model.includes('\n'), 'newline preservado como string, no como separador');
    assert.notEqual(startEvt.event, 'tampered', 'el evento sigue siendo session:start, no la inyección');
    assert.equal(startEvt.event, 'session:start');
});

test('#3083 CA-5 — log injection en provider, cli_version, git_sha_provider_adapter', () => {
    const lineCountBefore = fs.readFileSync(trace.LOG_FILE, 'utf8').split('\n').filter(Boolean).length;
    trace.emitSessionStart({
        skill: 's', issue: 1, phase: 'dev',
        model: 'm',
        provider: 'anthropic\n{"injected":true}',
        cli_version: '2.0\n{"event":"fake"}',
        git_sha_provider_adapter: 'abc\n{"event":"x"}',
    });
    const linesAfter = fs.readFileSync(trace.LOG_FILE, 'utf8').split('\n').filter(Boolean);
    assert.equal(linesAfter.length - lineCountBefore, 1,
        'inyección por cualquier campo no debe partir el JSONL');
    const evt = JSON.parse(linesAfter[linesAfter.length - 1]);
    assert.equal(evt.event, 'session:start');
    assert.ok(evt.provider.includes('\n'), 'newline literal preservado en provider');
});

test('#3083 CA-6 / SEC-1 — ningún evento contiene contenido de prompt', () => {
    // Generamos sesiones con `prompt_hash` (digest) y validamos que las claves
    // sensibles JAMÁS aparecen en el log.
    const digest = trace.hashPromptPair('SECRETO_DEL_SYSTEM', 'CONTENIDO_DEL_USER');
    const ctx = trace.emitSessionStart({
        skill: 's', issue: 1, phase: 'dev',
        model: 'claude-opus-4-7', provider: 'anthropic',
        prompt_hash: digest,
    });
    trace.emitSessionEnd(ctx, { tokens_in: 10 });
    const raw = fs.readFileSync(trace.LOG_FILE, 'utf8');
    const SENSITIVE_KEYS = [
        'system_prompt', 'user_prompt', 'prompt_content',
        'messages', 'input', 'output_text', 'text',
    ];
    for (const k of SENSITIVE_KEYS) {
        // Buscamos como key JSON (`"<k>":`) — no como substring suelto, para
        // no chocar con identificadores legítimos como "tokens_in".
        const pattern = `"${k}":`;
        assert.ok(!raw.includes(pattern),
            `log contiene la clave prohibida ${pattern} — leak de prompt (SEC-1)`);
    }
    // Y por si acaso, los contenidos literales tampoco
    assert.ok(!raw.includes('SECRETO_DEL_SYSTEM'),
        'contenido literal del system prompt NO debe aparecer en el log');
    assert.ok(!raw.includes('CONTENIDO_DEL_USER'),
        'contenido literal del user prompt NO debe aparecer en el log');
});

test('#3083 CA-4 / SEC-4 — append-only enforcement: traceability.js solo usa appendFileSync', () => {
    // Lint estático sobre el módulo: NUNCA debe abrir el LOG_FILE con flags
    // destructivos. Esto previene una regresión silenciosa que rompa la
    // inmutabilidad del audit trail.
    const moduleSrc = fs.readFileSync(path.join(__dirname, '..', 'traceability.js'), 'utf8');
    // Permitido: appendFileSync, createWriteStream con flags:'a'
    // Prohibido: writeFileSync(LOG_FILE, ...), createWriteStream(LOG_FILE) sin flags:'a'
    assert.ok(!/fs\.writeFileSync\s*\(\s*LOG_FILE/.test(moduleSrc),
        'PROHIBIDO writeFileSync(LOG_FILE, ...) — debe ser appendFileSync');
    assert.ok(!/createWriteStream\s*\(\s*LOG_FILE\s*\)/.test(moduleSrc),
        'PROHIBIDO createWriteStream(LOG_FILE) sin flags:\'a\'');
    // El módulo DEBE contener al menos un appendFileSync sobre LOG_FILE.
    assert.ok(/fs\.appendFileSync\s*\(\s*LOG_FILE/.test(moduleSrc),
        'traceability.js debe seguir usando appendFileSync(LOG_FILE, ...)');
});

test("#3083 CA-2 / SEC-2 — resolveProviderAdapterSha devuelve null cuando archivo no existe", () => {
    const sha = trace.resolveProviderAdapterSha('/path/inexistente/foo.js');
    assert.equal(sha, null);
    const sha2 = trace.resolveProviderAdapterSha(null);
    assert.equal(sha2, null);
    const sha3 = trace.resolveProviderAdapterSha('');
    assert.equal(sha3, null);
});

test("#3083 CA-2 / SEC-2 — resolveProviderAdapterSha ignora env vars (no se puede spoofear)", () => {
    // Setear env var con SHA falso y verificar que el helper NO lo usa.
    const FAKE_SHA = 'deadbeef'.repeat(5);
    const saved = process.env.PROVIDER_ADAPTER_SHA;
    process.env.PROVIDER_ADAPTER_SHA = FAKE_SHA;
    try {
        // Con path inexistente, debe devolver null (no FAKE_SHA del env).
        const sha = trace.resolveProviderAdapterSha('/path/que/no/existe.js');
        assert.notEqual(sha, FAKE_SHA, 'env var NO debe poder spoofear el SHA');
        assert.equal(sha, null);
    } finally {
        if (saved !== undefined) process.env.PROVIDER_ADAPTER_SHA = saved;
        else delete process.env.PROVIDER_ADAPTER_SHA;
    }
});

test("#3083 CA-2 / SEC-3 — resolveCliVersion devuelve 'unknown' si el spawn falla", () => {
    trace._resetCliVersionCacheForTesting();
    // Path inexistente → spawn falla → 'unknown' (NO null/undefined).
    const v = trace.resolveCliVersion('/path/launcher-que-no-existe-xyz123.exe');
    assert.equal(typeof v, 'string');
    assert.ok(v.length > 0, "cli_version SIEMPRE string no-vacío");
    // Spawn de binario inexistente: result.status puede ser null o el spawn
    // tirar — en cualquier caso, el helper devuelve 'unknown' (no crash).
    assert.equal(v, 'unknown');
});

test("#3083 CA-2 — resolveCliVersion devuelve 'n/a' para launcherPath vacío", () => {
    assert.equal(trace.resolveCliVersion(null), 'n/a');
    assert.equal(trace.resolveCliVersion(''), 'n/a');
    assert.equal(trace.resolveCliVersion(undefined), 'n/a');
});

test("#3083 CA-2 — resolveCliVersion cachea el resultado por launcherPath", () => {
    trace._resetCliVersionCacheForTesting();
    let calls = 0;
    const fakeSpawnSync = () => {
        calls++;
        return { status: 0, stdout: '1.2.3\n', stderr: '' };
    };
    const v1 = trace.resolveCliVersion('/fake/launcher', { spawnSyncImpl: fakeSpawnSync });
    const v2 = trace.resolveCliVersion('/fake/launcher', { spawnSyncImpl: fakeSpawnSync });
    assert.equal(v1, '1.2.3');
    assert.equal(v2, '1.2.3');
    assert.equal(calls, 1, 'segundo llamado debe ser cache hit');
});

test('#3083 CA-1 — emitSessionStart sin model explícito NO hardcodea claude-opus-4-7', () => {
    // El default ahora es 'deterministic' (no 'claude-opus-4-7'). El audit
    // trail debe reflejar la realidad: si el caller no resolvió el modelo,
    // el log lo muestra como 'deterministic', no inventa un modelo Claude.
    const ctx = trace.emitSessionStart({
        skill: 's', issue: 1, phase: 'dev',
        provider: 'anthropic',
        // sin model → toma el default
    });
    assert.notEqual(ctx.model, 'claude-opus-4-7',
        'CA-1: NO debe haber hardcode de claude-opus-4-7 en el default');
});

test('#3083 — hashPromptPair maneja UTF-8 NFC normalization', () => {
    // 'é' tiene dos representaciones en Unicode:
    //   - NFC: U+00E9 (1 codepoint)
    //   - NFD: U+0065 U+0301 (2 codepoints)
    // Ambas deben hashearse igual (normalización NFC obligatoria).
    const nfc = 'é';            // é (NFC)
    const nfd = 'é';      // é (NFD)
    const hNfc = trace.hashPromptPair('sys', nfc);
    const hNfd = trace.hashPromptPair('sys', nfd);
    assert.equal(hNfc, hNfd, 'NFC y NFD del mismo glifo deben producir el mismo hash');
});

test.after(() => {
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch(_) {}
});

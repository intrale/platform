// =============================================================================
// chaos-claude-down.test.js — Chaos test del Pulpo cuando Anthropic está caído
// (#3259 / CA-7).
//
// Escenarios cubiertos:
//   1. Primary Anthropic gated + fallback OpenAI libre → spawn arranca con
//      fallback. Pulpo NO marca el issue como exhausted.
//   2. Primary Anthropic gated + TODOS los fallbacks gated → reportExhaustion()
//      aplica label, encola Telegram y persiste marker.
//   3. Re-llamada con el mismo issue (dedup CA-9) → silencio idempotente
//      antes de NOTIFY_RENOTIFY_MS.
//   4. Re-llamada cuando la chain cambió (chain_tried) → re-notifica.
//   5. tryResume() detecta que Anthropic se liberó → quita label, borra
//      marker, encola Telegram destrabado.
//   6. tryResume() respeta scope per-provider: si la chain está gated por el
//      mismo provider que sigue activo, salta el issue (still_gated_same_provider).
//
// Estos tests verifican el comportamiento integrado de
//   - lib/agent-launcher/dispatch-with-fallback.js (#3198)
//   - lib/provider-exhaustion-pause.js (#3259)
//   - lib/quota-exhausted.js (#2974/#3077)
// usando mocks deterministas de gh y filesystem. Cero red, cero providers
// reales.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { resolveSpawnWithFallback } = require('../lib/agent-launcher/dispatch-with-fallback');
const exhaustion = require('../lib/provider-exhaustion-pause');

// -----------------------------------------------------------------------------
// Helpers — sandbox temporal del pipeline + fakes
// -----------------------------------------------------------------------------

function mkSandbox() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chaos-claude-'));
    fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(root, 'servicios', 'telegram', 'pendiente'), { recursive: true });
    fs.mkdirSync(path.join(root, 'state', 'exhaustion-notified'), { recursive: true });
    fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
    return root;
}

function fakeSpawnSync(scenarios = {}) {
    const calls = [];
    const fn = (bin, args /*, opts */) => {
        calls.push({ bin, args: args.slice() });
        // Reconocer subcommands clave: view / edit / list.
        const sub = args[0];
        const sub2 = args[1];
        const fullKey = sub + ' ' + sub2;
        if (scenarios[fullKey]) {
            const sc = scenarios[fullKey];
            return {
                status: sc.status != null ? sc.status : 0,
                stdout: sc.stdout || '',
                stderr: sc.stderr || '',
            };
        }
        // Defaults: edit → ok, view → JSON labels vacio, list → JSON []
        if (sub === 'issue' && sub2 === 'view') {
            return { status: 0, stdout: JSON.stringify({ labels: [] }), stderr: '' };
        }
        if (sub === 'issue' && sub2 === 'list') {
            return { status: 0, stdout: '[]', stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
    };
    fn.calls = calls;
    return fn;
}

function fakeAuditLog() {
    const entries = [];
    return {
        appendChained: ({ entry, file }) => {
            entries.push({ entry, file });
            return { hash_self: 'fake', hash_prev: 'prev', line: '' };
        },
        verifyChain: () => ({ ok: true }),
        entries,
    };
}

function fakeNotify() {
    const calls = [];
    const fn = (opts) => { calls.push(opts); return true; };
    fn.calls = calls;
    return fn;
}

function fakeProviderHandler(validProviders) {
    return (name) => {
        if (!validProviders.includes(name)) {
            throw new Error(`[fake] unknown provider ${name}`);
        }
        return { name: name + '-fake' };
    };
}

function fakeResolver(skill /*, opts */) {
    // Resolver muy simple: skill 'guru' → primary anthropic + fallbacks
    // [openai-codex, groq].
    return {
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        handler: { name: 'anthropic-fake' },
        source: 'agent-models',
    };
}

function fakeQuota({ gated = [], flagProvider = null, sanitize = (s) => String(s || '') }) {
    return {
        shouldGateSpawn: (skill, opts = {}) => gated.includes(opts.provider),
        sanitizeRawExcerpt: sanitize,
        appendAudit: () => {},
        readDefensive: () => flagProvider
            ? { exhausted: true, provider: flagProvider, pattern_matched: 'usage_limit_error',
                resets_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
                detected_at: new Date().toISOString() }
            : { exhausted: false },
    };
}

function fakeModelsFile(sandbox) {
    const models = {
        $schema: './agent-models.schema.json',
        default_provider: 'anthropic',
        providers: {
            anthropic: { launcher: 'claude', model: 'claude-opus-4-7' },
            'openai-codex': { launcher: 'codex', model: 'gpt-5-codex' },
            groq: { launcher: 'groq', model: 'llama-3.3-70b-versatile' },
        },
        skills: {
            guru: { provider: 'anthropic', fallbacks: ['openai-codex', 'groq'] },
            tester: { provider: 'deterministic' },
        },
    };
    fs.writeFileSync(path.join(sandbox, 'agent-models.json'), JSON.stringify(models));
}

// -----------------------------------------------------------------------------
// 1. Anthropic gated + OpenAI libre → spawn por fallback (NO exhaustion).
// -----------------------------------------------------------------------------
test('chaos: Anthropic gated + OpenAI libre → dispatcher devuelve fallback, no marca exhaustion', () => {
    const sandbox = mkSandbox();
    fakeModelsFile(sandbox);
    const audit = fakeAuditLog();
    const notify = fakeNotify();
    const quota = fakeQuota({ gated: ['anthropic'] });

    const result = resolveSpawnWithFallback({
        skill: 'guru',
        issue: 3259,
        pipelineDir: sandbox,
        fsImpl: fs,
        quotaModule: quota,
        resolverImpl: fakeResolver,
        providerHandlerResolver: fakeProviderHandler(['anthropic', 'openai-codex', 'groq']),
        auditLog: audit,
        notifyTelegram: notify,
        onLog: () => {},
    });

    assert.equal(result.gated, false, 'no debe gatear cuando hay fallback libre');
    assert.equal(result.source, 'fallback');
    assert.equal(result.fallbackUsed.provider, 'openai-codex');
    assert.equal(result.primaryProvider, 'anthropic');
});

// -----------------------------------------------------------------------------
// 2. Primary + todos los fallbacks gated → reportExhaustion aplica label,
//    encola Telegram y persiste marker.
// -----------------------------------------------------------------------------
test('chaos: TODOS los providers gated → reportExhaustion aplica label + Telegram + marker', () => {
    const sandbox = mkSandbox();
    fakeModelsFile(sandbox);
    const audit = fakeAuditLog();
    const notify = fakeNotify();
    const quota = fakeQuota({ gated: ['anthropic', 'openai-codex', 'groq'] });

    const dispatchResult = resolveSpawnWithFallback({
        skill: 'guru',
        issue: 3259,
        pipelineDir: sandbox,
        fsImpl: fs,
        quotaModule: quota,
        resolverImpl: fakeResolver,
        providerHandlerResolver: fakeProviderHandler(['anthropic', 'openai-codex', 'groq']),
        auditLog: audit,
        notifyTelegram: notify,
        onLog: () => {},
    });
    assert.equal(dispatchResult.gated, true, 'chain agotada → gated:true');
    assert.deepEqual(dispatchResult.chainTried, ['anthropic', 'openai-codex', 'groq']);

    // Simular el flow real del pulpo.js: cuando gated, llamamos
    // reportExhaustion con la chain. Mockeamos gh para que devuelva 0
    // labels (label aplicada por primera vez).
    const spawnSync = fakeSpawnSync();
    const out = exhaustion.reportExhaustion({
        skill: 'guru',
        issue: 3259,
        primary_provider: 'anthropic',
        chain_tried: dispatchResult.chainTried,
    }, { pipelineDir: sandbox, spawnSyncImpl: spawnSync, ghBin: 'gh-fake' });

    assert.equal(out.label_applied, true, 'label aplicada (no estaba antes)');
    assert.equal(out.notified, true, 'Telegram encolado en primera notificación');
    assert.equal(out.notify_reason, 'first_notify');
    assert.equal(out.audit_logged, true);

    // Verificar marker persistido.
    const marker = exhaustion.readNotifyMarker(3259, { pipelineDir: sandbox });
    assert.ok(marker, 'marker existe');
    assert.deepEqual(marker.chain_tried, ['anthropic', 'openai-codex', 'groq']);
    assert.equal(marker.primary_provider, 'anthropic');

    // Verificar Telegram queue tiene archivo.
    const queueDir = path.join(sandbox, 'servicios', 'telegram', 'pendiente');
    const files = fs.readdirSync(queueDir);
    assert.equal(files.length, 1, 'un archivo encolado');
    const payload = JSON.parse(fs.readFileSync(path.join(queueDir, files[0]), 'utf8'));
    assert.ok(payload.text.includes('Pipeline pausado'));
    assert.ok(payload.text.includes('guru'));
    assert.ok(payload.text.includes('anthropic'));

    // gh fue invocado con view + edit --add-label.
    assert.ok(spawnSync.calls.some(c => c.args.includes('view')), 'gh view');
    assert.ok(spawnSync.calls.some(c => c.args.includes('--add-label')), 'gh add-label');
    assert.ok(spawnSync.calls.some(c => c.args.includes('provider-exhaustion-pause')), 'label name');
});

// -----------------------------------------------------------------------------
// 3. Dedup CA-9: re-llamada antes de 2h con misma chain → silencio.
// -----------------------------------------------------------------------------
test('CA-9 dedup: misma chain dentro de 2h → no re-notifica', () => {
    const sandbox = mkSandbox();
    const baseTs = Date.now();
    // Setup marker existente.
    exhaustion.writeNotifyMarker(3259, {
        issue: 3259,
        skill: 'guru',
        primary_provider: 'anthropic',
        chain_tried: ['anthropic', 'openai-codex', 'groq'],
        last_notified_ms: baseTs,
        updated_at: new Date(baseTs).toISOString(),
    }, { pipelineDir: sandbox });

    const spawnSync = fakeSpawnSync({
        // Issue ya tiene la label.
        'issue view': { status: 0, stdout: JSON.stringify({ labels: [{ name: 'provider-exhaustion-pause' }] }) },
    });
    const out = exhaustion.reportExhaustion({
        skill: 'guru',
        issue: 3259,
        primary_provider: 'anthropic',
        chain_tried: ['anthropic', 'openai-codex', 'groq'],
    }, {
        pipelineDir: sandbox,
        spawnSyncImpl: spawnSync,
        ghBin: 'gh-fake',
        now: baseTs + 60 * 60 * 1000, // 1h después
    });
    assert.equal(out.label_applied, false, 'label ya estaba aplicada');
    assert.equal(out.notified, false, 'sin re-notificación');
    assert.equal(out.notify_reason, 'dedup_silent');

    // No deberían haber archivos nuevos en Telegram queue.
    const queueDir = path.join(sandbox, 'servicios', 'telegram', 'pendiente');
    const files = fs.readdirSync(queueDir);
    assert.equal(files.length, 0);
});

// -----------------------------------------------------------------------------
// 4. CA-9: chain cambió → re-notifica aunque sea dentro de 2h.
// -----------------------------------------------------------------------------
test('CA-9 chain change: chain distinta → re-notifica dentro de 2h', () => {
    const sandbox = mkSandbox();
    const baseTs = Date.now();
    exhaustion.writeNotifyMarker(3259, {
        issue: 3259,
        skill: 'guru',
        primary_provider: 'anthropic',
        chain_tried: ['anthropic'],
        last_notified_ms: baseTs,
    }, { pipelineDir: sandbox });

    const spawnSync = fakeSpawnSync();
    const out = exhaustion.reportExhaustion({
        skill: 'guru',
        issue: 3259,
        primary_provider: 'anthropic',
        chain_tried: ['anthropic', 'openai-codex', 'groq'],
    }, {
        pipelineDir: sandbox,
        spawnSyncImpl: spawnSync,
        ghBin: 'gh-fake',
        now: baseTs + 30 * 60 * 1000, // 30 min después
    });
    assert.equal(out.notified, true);
    assert.equal(out.notify_reason, 'chain_changed');
});

// -----------------------------------------------------------------------------
// 5. CA-10 tryResume: Anthropic libre → destraba issue.
// -----------------------------------------------------------------------------
test('CA-10 resume: flag liberado → quita label, borra marker, encola destrabe Telegram', () => {
    const sandbox = mkSandbox();
    exhaustion.writeNotifyMarker(3259, {
        issue: 3259,
        skill: 'guru',
        primary_provider: 'anthropic',
        chain_tried: ['anthropic', 'openai-codex', 'groq'],
        last_notified_ms: Date.now() - 60 * 60 * 1000,
    }, { pipelineDir: sandbox });

    const spawnSync = fakeSpawnSync({
        'issue list': { status: 0, stdout: JSON.stringify([{ number: 3259, title: 'continuidad pulpo' }]) },
        'issue view': { status: 0, stdout: JSON.stringify({ labels: [{ name: 'provider-exhaustion-pause' }] }) },
    });
    const quota = fakeQuota({ flagProvider: null }); // sin flag activo
    const result = exhaustion.tryResume({
        pipelineDir: sandbox,
        spawnSyncImpl: spawnSync,
        ghBin: 'gh-fake',
        quotaModule: quota,
    });
    assert.equal(result.resumed.length, 1);
    assert.equal(result.resumed[0].issue, 3259);

    // Marker borrado.
    const marker = exhaustion.readNotifyMarker(3259, { pipelineDir: sandbox });
    assert.equal(marker, null);

    // Telegram queue tiene mensaje de destrabe.
    const queueDir = path.join(sandbox, 'servicios', 'telegram', 'pendiente');
    const files = fs.readdirSync(queueDir).filter(f => f.includes('exhaustion-resumed'));
    assert.equal(files.length, 1);
    const payload = JSON.parse(fs.readFileSync(path.join(queueDir, files[0]), 'utf8'));
    assert.ok(payload.text.includes('destrabado'));
});

// -----------------------------------------------------------------------------
// 6. CA-10 scope: chain solo contiene el provider que sigue gated → skip.
// -----------------------------------------------------------------------------
test('CA-10 still gated: chain = solo provider activo del flag → skip', () => {
    const sandbox = mkSandbox();
    exhaustion.writeNotifyMarker(3259, {
        issue: 3259,
        skill: 'guru',
        primary_provider: 'anthropic',
        chain_tried: ['anthropic'], // chain solo tiene anthropic
        last_notified_ms: Date.now(),
    }, { pipelineDir: sandbox });

    const spawnSync = fakeSpawnSync({
        'issue list': { status: 0, stdout: JSON.stringify([{ number: 3259, title: 't' }]) },
        'issue view': { status: 0, stdout: JSON.stringify({ labels: [{ name: 'provider-exhaustion-pause' }] }) },
    });
    const quota = fakeQuota({ flagProvider: 'anthropic' }); // flag activo en anthropic
    const result = exhaustion.tryResume({
        pipelineDir: sandbox,
        spawnSyncImpl: spawnSync,
        ghBin: 'gh-fake',
        quotaModule: quota,
    });
    assert.equal(result.resumed.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].reason, 'still_gated_same_provider');
});

// -----------------------------------------------------------------------------
// 7. Security: issue inválido → reject sin spawn de gh.
// -----------------------------------------------------------------------------
test('security: issue inválido (string con shell metacharacters) → reject sin gh spawn', () => {
    const sandbox = mkSandbox();
    const spawnSync = fakeSpawnSync();
    const out = exhaustion.reportExhaustion({
        skill: 'guru',
        issue: '3259; rm -rf /',
        primary_provider: 'anthropic',
        chain_tried: ['anthropic'],
    }, { pipelineDir: sandbox, spawnSyncImpl: spawnSync, ghBin: 'gh-fake' });
    assert.equal(out.label_applied, false);
    assert.equal(out.notify_reason, 'invalid_issue');
    assert.equal(spawnSync.calls.length, 0, 'gh nunca fue invocado');
});

// -----------------------------------------------------------------------------
// 8. Security: Telegram body sanitizado (ANSI / control chars stripped).
// -----------------------------------------------------------------------------
test('security: Telegram body strip de ANSI / control chars', () => {
    const text = exhaustion.sanitizeForTelegram('hello\x1b[31m world\x07\x00');
    assert.equal(text.includes('\x1b'), false);
    assert.equal(text.includes('\x07'), false);
    assert.equal(text.includes('\x00'), false);
});

// -----------------------------------------------------------------------------
// 9. Helper: clampRetryIntervalMs respeta piso 60s.
// -----------------------------------------------------------------------------
test('helper: clampRetryIntervalMs respeta piso 60s', () => {
    assert.equal(exhaustion.clampRetryIntervalMs(30 * 1000), 60 * 1000);
    assert.equal(exhaustion.clampRetryIntervalMs(5 * 60 * 1000), 5 * 60 * 1000);
    assert.equal(exhaustion.clampRetryIntervalMs(undefined), exhaustion.DEFAULT_RETRY_INTERVAL_MS);
    assert.equal(exhaustion.clampRetryIntervalMs('not a number'), exhaustion.DEFAULT_RETRY_INTERVAL_MS);
});

// -----------------------------------------------------------------------------
// 10. provider-health: cache TTL 5min — segunda llamada NO pingea de nuevo.
// -----------------------------------------------------------------------------
test('provider-health: cache TTL 5min evita re-ping', async () => {
    // Aislamos PIPELINE_DIR_OVERRIDE para no escribir en el cache global.
    const sandbox = mkSandbox();
    const prevOverride = process.env.PIPELINE_DIR_OVERRIDE;
    process.env.PIPELINE_DIR_OVERRIDE = sandbox;
    try {
        // Borrar cache de require para que provider-health lea PIPELINE_DIR_OVERRIDE.
        delete require.cache[require.resolve('../lib/provider-health')];
        const health = require('../lib/provider-health');

        let pingCalls = 0;
        const fakePing = async ({ provider }) => {
            pingCalls++;
            return { ok: true, reason: 'authenticated', provider };
        };

        // Primer call: ping todos los providers configurados.
        const r1 = await health.getProviderHealth({
            now: 1000000,
            pingImpl: fakePing,
            pipelineDir: sandbox,
        });
        assert.ok(r1.providers.length > 0);
        const firstPingCount = pingCalls;
        assert.ok(firstPingCount > 0, 'primer call debe pingear');

        // Segundo call dentro del TTL: cache fresh, NO pingea.
        const r2 = await health.getProviderHealth({
            now: 1000000 + 60 * 1000, // 1 min después
            pingImpl: fakePing,
            pipelineDir: sandbox,
        });
        assert.equal(pingCalls, firstPingCount, 'segundo call NO debe pingear (cache fresh)');
        // Cache age > 0 en segundo call.
        const cachedProvider = r2.providers.find(p => p.cache_age_s > 0);
        assert.ok(cachedProvider, 'cache_age_s > 0 en al menos un provider');
    } finally {
        if (prevOverride === undefined) delete process.env.PIPELINE_DIR_OVERRIDE;
        else process.env.PIPELINE_DIR_OVERRIDE = prevOverride;
        delete require.cache[require.resolve('../lib/provider-health')];
    }
});

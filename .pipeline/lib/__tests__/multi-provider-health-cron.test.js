// =============================================================================
// multi-provider-health-cron.test.js — Tests del cron de healthchecks (#3260
// CA-1 / CA-6 — simulación con 2+ providers dropeados).
//
// Cero HTTP real (httpImpl mockeado), cero keys reales (mock secretsPath).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const healthCron = require('../multi-provider/health-cron');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mp-cron-')); }

function makeSecretsFile(dir, keys) {
    const f = path.join(dir, 'config.json');
    fs.writeFileSync(f, JSON.stringify(keys));
    return f;
}

// Fake ping que devuelve resultados scripted por provider.
function fakePing(scripted) {
    return async ({ provider }) => {
        const r = scripted[provider];
        if (!r) return { ok: false, reason: 'unknown', provider };
        return { ...r, provider };
    };
}

test('classifyState: ok + sin hits → green', () => {
    assert.equal(healthCron.classifyState({ ok: true }, { rate_limit_hit_24h: 0 }), 'green');
});

test('classifyState: ok + hits>0 → yellow', () => {
    assert.equal(healthCron.classifyState({ ok: true }, { rate_limit_hit_24h: 3 }), 'yellow');
});

test('classifyState: !ok → red', () => {
    assert.equal(healthCron.classifyState({ ok: false, reason: 'invalid_credentials' }, {}), 'red');
});

test('updateRateLimitCounter: rate_limited incrementa', () => {
    assert.equal(healthCron.updateRateLimitCounter({ ok: false, reason: 'rate_limited' }, { rate_limit_hit_24h: 5 }), 6);
});

test('updateRateLimitCounter: ok decae si hay hits previos', () => {
    assert.equal(healthCron.updateRateLimitCounter({ ok: true, reason: 'authenticated' }, { rate_limit_hit_24h: 3 }), 2);
});

test('listManagedAndPingable incluye los 4 free providers (#3260 + #3243)', () => {
    const providers = healthCron.listManagedAndPingable().map(p => p.provider);
    assert.ok(providers.includes('groq'), 'groq presente');
    assert.ok(providers.includes('gemini-google'), 'gemini-google presente');
    assert.ok(providers.includes('cerebras'), 'cerebras presente');
    // #3243 — NVIDIA NIM se sumó al pool de free providers gestionados.
    assert.ok(providers.includes('nvidia-nim'), 'nvidia-nim presente');
});

test('tryAcquireLock: primero gana, segundo falla', () => {
    const dir = tmpDir();
    const lockFile = path.join(dir, 'test.lock');
    assert.equal(healthCron.tryAcquireLock({ lockFile }), true);
    assert.equal(healthCron.tryAcquireLock({ lockFile }), false);
    healthCron.releaseLock({ lockFile });
    assert.equal(healthCron.tryAcquireLock({ lockFile }), true);
});

test('tryAcquireLock: roba lock stale (>5min)', () => {
    const dir = tmpDir();
    const lockFile = path.join(dir, 'test.lock');
    // Escribir un lock viejo manualmente
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 99999, acquired_at: Date.now() - 10 * 60 * 1000 }));
    assert.equal(healthCron.tryAcquireLock({ lockFile, now: Date.now() }), true);
});

test('isTickDue: true si nunca corrió', () => {
    const dir = tmpDir();
    const stateFile = path.join(dir, 'state.json');
    assert.equal(healthCron.isTickDue({ stateFile, jitter: 0 }), true);
});

test('isTickDue: false si corrió hace menos del intervalo', () => {
    const dir = tmpDir();
    const stateFile = path.join(dir, 'state.json');
    const now = Date.now();
    fs.writeFileSync(stateFile, JSON.stringify({ last_tick_at: now - 5 * 60 * 1000 }));
    assert.equal(healthCron.isTickDue({ stateFile, now, jitter: 0 }), false);
});

test('isTickDue: true si pasó el intervalo + jitter', () => {
    const dir = tmpDir();
    const stateFile = path.join(dir, 'state.json');
    const now = Date.now();
    fs.writeFileSync(stateFile, JSON.stringify({ last_tick_at: now - 20 * 60 * 1000 }));
    assert.equal(healthCron.isTickDue({ stateFile, now, jitter: 0 }), true);
});

test('isWeeklyDue: true si nunca corrió', () => {
    const dir = tmpDir();
    const stateFile = path.join(dir, 'state.json');
    assert.equal(healthCron.isWeeklyDue({ stateFile }), true);
});

test('runOnce: pingea sólo los providers presentes en secretos', async () => {
    const dir = tmpDir();
    const stateDir = path.join(dir, 'state');
    const auditDir = path.join(dir, 'audit');
    const secretsPath = makeSecretsFile(dir, {
        groq_api_key: 'gsk_test_aaaaaaaaaaaaaaaaaaaa',
        // gemini y cerebras AUSENTES → status absent → skipped
    });
    const result = await healthCron.runOnce({
        stateDir,
        auditDir,
        secretsPath,
        pingImpl: fakePing({ groq: { ok: true, reason: 'authenticated', statusCode: 200 } }),
        skipAudit: true,
    });
    assert.ok(Array.isArray(result.snapshot.providers));
    const groq = result.snapshot.providers.find(p => p.provider === 'groq');
    assert.equal(groq.state, 'green');
    assert.equal(groq.reason_code, 'authenticated');
    const gemini = result.snapshot.providers.find(p => p.provider === 'gemini-google');
    assert.equal(gemini.state, 'red');
    assert.equal(gemini.reason_code, 'no_key_configured');
});

test('runOnce: CA-6 simulación — 2 free providers en rojo simultáneo (free counts)', async () => {
    const dir = tmpDir();
    const stateDir = path.join(dir, 'state');
    const auditDir = path.join(dir, 'audit');
    const secretsPath = makeSecretsFile(dir, {
        groq_api_key: 'gsk_test_aaaaaaaaaaaaaaaaaaaa',
        gemini_google_api_key: 'AIza_test_aaaaaaaaaaaaaaaaaaaa',
        cerebras_api_key: 'csk_test_aaaaaaaaaaaaaaaaaaaa',
    });
    const result = await healthCron.runOnce({
        stateDir,
        auditDir,
        secretsPath,
        pingImpl: fakePing({
            groq: { ok: false, reason: 'invalid_credentials', statusCode: 401 },
            'gemini-google': { ok: false, reason: 'quota_exhausted', statusCode: 429 },
            cerebras: { ok: true, reason: 'authenticated', statusCode: 200 },
        }),
        telegramSender: () => true,
        dedupFile: path.join(dir, 'dedup.json'),
        skipAudit: true,
    });
    // Filtrar a los 3 free providers para verificar CA-6.
    const free = result.snapshot.providers.filter(p =>
        ['groq', 'gemini-google', 'cerebras'].includes(p.provider));
    const reds = free.filter(p => p.state === 'red');
    const greens = free.filter(p => p.state === 'green');
    assert.equal(reds.length, 2, 'dos free providers en rojo');
    assert.equal(greens.length, 1, 'uno verde');
    // Alertas: una por cada free red. (Anthropic/OpenAI/ElevenLabs no
    // configurados también figurarán como red por no_key_configured, pero
    // CA-4 sigue emitiendo — el caller debe filtrar si quiere solo free.)
    const redAlerts = result.alerts.filter(a => a.kind === 'red');
    const freeRedAlerts = redAlerts.filter(a =>
        ['groq', 'gemini-google', 'cerebras'].includes(a.provider));
    assert.ok(freeRedAlerts.length >= 2, 'al menos una alerta por cada free provider rojo');
});

test('runOnce: 3+ free providers en rojo dispara alerta multi-down', async () => {
    // Con el 4to free provider (nvidia-nim, #3243) sin key configurada, el
    // snapshot reporta red_count=4 (los 3 con ping fallido + nvidia-nim
    // marcado red por no_key_configured). La alerta multi_down se dispara
    // igual — el umbral es ≥3.
    const dir = tmpDir();
    const stateDir = path.join(dir, 'state');
    const auditDir = path.join(dir, 'audit');
    const secretsPath = makeSecretsFile(dir, {
        groq_api_key: 'gsk_test_aaaaaaaaaaaaaaaaaaaa',
        gemini_google_api_key: 'AIza_test_aaaaaaaaaaaaaaaaaaaa',
        cerebras_api_key: 'csk_test_aaaaaaaaaaaaaaaaaaaa',
        nvidia_nim_api_key: 'nvapi-test_aaaaaaaaaaaaaaaaaaaa',
    });
    const result = await healthCron.runOnce({
        stateDir,
        auditDir,
        secretsPath,
        pingImpl: fakePing({
            groq: { ok: false, reason: 'invalid_credentials', statusCode: 401 },
            'gemini-google': { ok: false, reason: 'quota_exhausted', statusCode: 429 },
            cerebras: { ok: false, reason: 'invalid_credentials', statusCode: 401 },
            'nvidia-nim': { ok: false, reason: 'invalid_credentials', statusCode: 401 },
        }),
        telegramSender: () => true,
        dedupFile: path.join(dir, 'dedup.json'),
        skipAudit: true,
    });
    const multi = result.alerts.find(a => a.kind === 'multi_down');
    assert.ok(multi, 'debe haber alerta multi_down');
    assert.equal(multi.payload.red_count, 4);
});

test('runOnce: el snapshot NO contiene fingerprint, masked ni body excerpt', async () => {
    const dir = tmpDir();
    const stateDir = path.join(dir, 'state');
    const auditDir = path.join(dir, 'audit');
    const SECRET_KEY = 'gsk_VERY_SECRET_DO_NOT_LEAK_aaaaaaaaaaaaaaaaaa';
    const secretsPath = makeSecretsFile(dir, { groq_api_key: SECRET_KEY });
    const result = await healthCron.runOnce({
        stateDir,
        auditDir,
        secretsPath,
        pingImpl: fakePing({ groq: { ok: false, reason: 'invalid_credentials', statusCode: 401 } }),
        skipAudit: true,
    });
    const serialized = JSON.stringify(result.snapshot);
    assert.ok(!serialized.includes('VERY_SECRET'), 'snapshot no debe contener la API key');
    assert.ok(!/fingerprint|masked|body_excerpt|bodyExcerpt/i.test(serialized), 'snapshot no debe contener fingerprint/masked/body');
});

test('runOnce: persiste snapshot a state/multi-provider-health.json', async () => {
    const dir = tmpDir();
    const stateDir = path.join(dir, 'state');
    const secretsPath = makeSecretsFile(dir, { groq_api_key: 'gsk_test_aaaaaaaaaaaaaaaaaaaa' });
    await healthCron.runOnce({
        stateDir,
        auditDir: path.join(dir, 'audit'),
        secretsPath,
        pingImpl: fakePing({ groq: { ok: true, reason: 'authenticated', statusCode: 200 } }),
        skipAudit: true,
    });
    const snapshotFile = path.join(stateDir, healthCron.SNAPSHOT_FILENAME);
    assert.ok(fs.existsSync(snapshotFile), 'snapshot debe persistirse');
    const persisted = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
    assert.equal(persisted.green_count, 1);
});

test('tickIfDue: respeta lock — segundo proceso skip', async () => {
    const dir = tmpDir();
    const stateDir = path.join(dir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    // Lock manualmente
    fs.writeFileSync(path.join(stateDir, healthCron.LOCK_FILENAME), JSON.stringify({ pid: 99999, acquired_at: Date.now() }));
    const result = await healthCron.tickIfDue({ stateDir, secretsPath: makeSecretsFile(dir, {}) });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'locked_by_other_process');
});

test('jitterMs: dentro del rango ±60s por defecto', () => {
    for (let i = 0; i < 50; i++) {
        const j = healthCron.jitterMs();
        assert.ok(Math.abs(j) <= 60 * 1000, `jitter ${j}ms fuera del rango`);
    }
});

test('jitterMs: rng inyectable para reproducibilidad', () => {
    assert.equal(healthCron.jitterMs(1000, () => 0.5), 0); // mid point
    assert.equal(healthCron.jitterMs(1000, () => 1.0), 1000); // max
    assert.equal(healthCron.jitterMs(1000, () => 0.0), -1000); // min
});

test('formatAlertText: payload válido genera texto markdown', () => {
    const t = healthCron.formatAlertText({
        provider: 'groq',
        state: 'red',
        reason_code: 'invalid_credentials',
        observed_at: '2026-05-17T00:00:00Z',
    });
    assert.ok(t.includes('groq'));
    assert.ok(t.includes('RED'));
    assert.ok(t.includes('invalid_credentials'));
});

test('formatAlertText: multi_down lista los providers', () => {
    const t = healthCron.formatAlertText({
        event: 'multi_down',
        red_count: 3,
        providers_red: ['groq', 'gemini-google', 'cerebras'],
        observed_at: '2026-05-17T00:00:00Z',
    });
    assert.ok(t.includes('Multi-Down'));
    assert.ok(t.includes('groq'));
});

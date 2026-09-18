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
const { seedProductManifest } = require('./_test-helpers');

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

test('listManagedAndPingable incluye el plantel vigente y excluye los retirados (#3353 + #6563)', () => {
    const providers = healthCron.listManagedAndPingable().map(p => p.provider);
    // #3353 — groq removido tras la descontinuación.
    assert.ok(!providers.includes('groq'), 'groq debería estar removido tras #3353');
    // #6563 — cerebras, nvidia-nim y kimi-moonshot retirados del plantel.
    assert.ok(!providers.includes('cerebras'), 'cerebras retirado en #6563');
    assert.ok(!providers.includes('nvidia-nim'), 'nvidia-nim retirado en #6563');
    assert.ok(!providers.includes('kimi-moonshot'), 'kimi-moonshot retirado en #6563');
    // Plantel: anthropic, openai (codex) y gemini-google (Antigravity).
    assert.ok(providers.includes('anthropic'), 'anthropic presente');
    assert.ok(providers.includes('openai'), 'openai (codex) presente');
    assert.ok(providers.includes('gemini-google'), 'gemini-google presente');
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

test('isTickDue: false si corrió hace menos del intervalo (intervalMs inyectado)', () => {
    const dir = tmpDir();
    const stateFile = path.join(dir, 'state.json');
    const now = Date.now();
    fs.writeFileSync(stateFile, JSON.stringify({ last_tick_at: now - 3 * 60 * 1000 }));
    // #4402 — intervalMs inyectado para no depender de la config real.
    assert.equal(healthCron.isTickDue({ stateFile, now, jitter: 0, intervalMs: 5 * 60 * 1000 }), false);
});

test('isTickDue: true si pasó el intervalo + jitter (intervalMs inyectado)', () => {
    const dir = tmpDir();
    const stateFile = path.join(dir, 'state.json');
    const now = Date.now();
    fs.writeFileSync(stateFile, JSON.stringify({ last_tick_at: now - 20 * 60 * 1000 }));
    assert.equal(healthCron.isTickDue({ stateFile, now, jitter: 0, intervalMs: 5 * 60 * 1000 }), true);
});

// ─── #4402 CA-3 — cadencia configurable (readTickIntervalMs) ─────────────────
test('readTickIntervalMs: toma el valor de config.yaml', () => {
    const dir = tmpDir();
    const cfg = path.join(dir, 'config.yaml');
    fs.writeFileSync(cfg, 'multi_provider:\n  health:\n    interval_minutes: 10\n');
    seedProductManifest(dir);   // #5174 — la configuración vive partida: el otro lado también
    assert.equal(healthCron.readTickIntervalMs({ configPath: cfg }), 10 * 60 * 1000);
});

test('readTickIntervalMs: default 5 min si falta el campo (sección opcional ausente)', () => {
    const dir = tmpDir();
    const cfg = path.join(dir, 'config.yaml');
    fs.writeFileSync(cfg, 'multi_provider:\n  order: [claude]\n'); // sin health.interval_minutes
    seedProductManifest(dir);   // #5174 — la configuración vive partida: el otro lado también
    assert.equal(healthCron.readTickIntervalMs({ configPath: cfg }), 5 * 60 * 1000);
});

// #5172 — el config ILEGIBLE dejó de degradar a "cadencia default". Antes este
// caso caía al mismo 5 min que un config válido sin el campo, así que "no pude
// leer la configuración" y "no configuraste cadencia" eran indistinguibles.
test('readTickIntervalMs: config inaccesible PROPAGA el error tipado, no degrada al default (#5172)', () => {
    const dir = tmpDir();
    assert.throws(
        () => healthCron.readTickIntervalMs({ configPath: path.join(dir, 'nope.yaml') }),
        (e) => e.name === 'ConfigParseViolation' && e.causa === 'ENOENT',
    );
});

test('readTickIntervalMs: clamp piso — 0.5 min → 60s (RS-5.5)', () => {
    const dir = tmpDir();
    const cfg = path.join(dir, 'config.yaml');
    fs.writeFileSync(cfg, 'multi_provider:\n  health:\n    interval_minutes: 0.5\n');
    seedProductManifest(dir);   // #5174 — la configuración vive partida: el otro lado también
    assert.equal(healthCron.readTickIntervalMs({ configPath: cfg }), 60 * 1000);
});

test('readTickIntervalMs: clamp techo — 999 min → 240 min', () => {
    const dir = tmpDir();
    const cfg = path.join(dir, 'config.yaml');
    fs.writeFileSync(cfg, 'multi_provider:\n  health:\n    interval_minutes: 999\n');
    seedProductManifest(dir);   // #5174 — la configuración vive partida: el otro lado también
    assert.equal(healthCron.readTickIntervalMs({ configPath: cfg }), 240 * 60 * 1000);
});

// El schema es LENIENT en la CLAVE (`additionalProperties: true`) y ESTRICTO en
// el TIPO del valor. Los dos lados de esa decisión, explícitos:
test('readTickIntervalMs: typo en la CLAVE se ignora → default 5 min', () => {
    const dir = tmpDir();
    const cfg = path.join(dir, 'config.yaml');
    fs.writeFileSync(cfg, 'multi_provider:\n  health:\n    intervalo_minutos: 10\n');
    seedProductManifest(dir);   // #5174 — la configuración vive partida: el otro lado también
    assert.equal(healthCron.readTickIntervalMs({ configPath: cfg }), 5 * 60 * 1000);
});

// #5172 — un valor no-numérico grosero lo caza el schema y ahora PROPAGA. Antes
// el `catch` lo convertía en 5 min y el operador nunca se enteraba de su typo.
test('readTickIntervalMs: valor no-numérico PROPAGA ConfigSchemaViolation (#5172)', () => {
    const dir = tmpDir();
    const cfg = path.join(dir, 'config.yaml');
    fs.writeFileSync(cfg, 'multi_provider:\n  health:\n    interval_minutes: "cada rato"\n');
    seedProductManifest(dir);   // #5174 — la configuración vive partida: el otro lado también
    assert.throws(
        () => healthCron.readTickIntervalMs({ configPath: cfg }),
        (e) => e.name === 'ConfigSchemaViolation' && e.causa === 'schema-invalido',
    );
});

test('tickIfDue: respeta intervalMs inyectado (no due si no pasó)', async () => {
    const dir = tmpDir();
    const stateDir = path.join(dir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const now = Date.now();
    fs.writeFileSync(
        path.join(stateDir, healthCron.STATE_FILENAME),
        JSON.stringify({ last_tick_at: now - 2 * 60 * 1000 }),
    );
    const result = await healthCron.tickIfDue({
        stateDir, now, jitter: 0, intervalMs: 5 * 60 * 1000,
        secretsPath: makeSecretsFile(dir, {}),
    });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'not_due');
});

test('isWeeklyDue: true si nunca corrió', () => {
    const dir = tmpDir();
    const stateFile = path.join(dir, 'state.json');
    assert.equal(healthCron.isWeeklyDue({ stateFile }), true);
});

test('runOnce: los providers OAuth se validan por CLI, nunca por secretos ni ping HTTP', async () => {
    // #6563 — sin cerebras/nvidia-nim no queda ningún provider api_key: el
    // plantel entero es CLI-OAuth. El almacén de secretos vacío NO debe
    // producir `no_key_configured` ni invocar `pingImpl`; el estado sale del
    // probe de CLI por binario (claude / codex / agy).
    const dir = tmpDir();
    const stateDir = path.join(dir, 'state');
    const auditDir = path.join(dir, 'audit');
    const secretsPath = makeSecretsFile(dir, {});
    let pinged = 0;
    const result = await healthCron.runOnce({
        stateDir,
        auditDir,
        secretsPath,
        pingImpl: async () => { pinged++; return { ok: false, reason: 'unknown' }; },
        // #3802 — probe CLI fijo + sender/dedup aislados: el test no debe
        // depender del PATH real ni escribir en archivos reales del pipeline.
        cliProbe: (binary) => binary === 'claude',
        telegramSender: () => true,
        dedupFile: path.join(dir, 'dedup.json'),
        skipAudit: true,
    });
    assert.ok(Array.isArray(result.snapshot.providers));
    assert.equal(pinged, 0, 'ningún provider del plantel pasa por el ping HTTP con API key');
    const anthropic = result.snapshot.providers.find(p => p.provider === 'anthropic');
    assert.equal(anthropic.state, 'green');
    assert.equal(anthropic.reason_code, 'cli_oauth_ok');
    const openai = result.snapshot.providers.find(p => p.provider === 'openai');
    assert.equal(openai.state, 'red');
    assert.equal(openai.reason_code, 'cli_unavailable');
    const gemini = result.snapshot.providers.find(p => p.provider === 'gemini-google');
    assert.equal(gemini.state, 'red');
    assert.equal(gemini.reason_code, 'cli_unavailable');
    for (const p of result.snapshot.providers) {
        assert.notEqual(p.reason_code, 'no_key_configured', p.provider + ': OAuth no depende del almacén de keys');
    }
});

// ─── #3802 — providers CLI-OAuth (Claude Code / Codex): validar CLI, no key.
test('isBinaryOnPath: encuentra binario en un dir del PATH (fs inyectado)', () => {
    const fakeFs = { existsSync: (p) => p.includes('claude') };
    assert.equal(
        healthCron.isBinaryOnPath('claude', { env: { PATH: '/usr/bin:/usr/local/bin' }, fsImpl: fakeFs }),
        true,
    );
});

test('isBinaryOnPath: false si el binario no está en ningún dir', () => {
    const fakeFs = { existsSync: () => false };
    assert.equal(
        healthCron.isBinaryOnPath('codex', { env: { PATH: '/usr/bin' }, fsImpl: fakeFs }),
        false,
    );
});

test('probeCliProvider: CLI disponible → ok + cli_oauth_ok', () => {
    const r = healthCron.probeCliProvider(
        { provider: 'anthropic', cli_binary: 'claude' },
        { cliProbe: () => true },
    );
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'cli_oauth_ok');
});

test('probeCliProvider: CLI ausente → !ok + cli_unavailable', () => {
    const r = healthCron.probeCliProvider(
        { provider: 'openai', cli_binary: 'codex' },
        { cliProbe: () => false },
    );
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'cli_unavailable');
});

test('runOnce: provider OAuth con CLI disponible → green sin pinear la API key', async () => {
    const dir = tmpDir();
    const stateDir = path.join(dir, 'state');
    const auditDir = path.join(dir, 'audit');
    // Sin keys de anthropic/openai en secretos: igual deben quedar verdes
    // porque corren por CLI OAuth, no por API key.
    const secretsPath = makeSecretsFile(dir, {});
    const result = await healthCron.runOnce({
        stateDir,
        auditDir,
        secretsPath,
        // pingImpl NO debe ser invocado para providers OAuth.
        pingImpl: async () => { throw new Error('no debería pinear un provider OAuth'); },
        cliProbe: () => true, // CLI disponible
        quotaAssessImpl: () => ({ adapterStatus: 'ok', status: 'ok', pct: 10, gated: false }),
        telegramSender: () => true,
        dedupFile: path.join(dir, 'dedup.json'),
        skipAudit: true,
    });
    const anthropic = result.snapshot.providers.find(p => p.provider === 'anthropic');
    assert.equal(anthropic.state, 'green');
    assert.equal(anthropic.reason_code, 'cli_oauth_ok');
    assert.equal(anthropic.auth_mode, 'oauth');
    const openai = result.snapshot.providers.find(p => p.provider === 'openai');
    assert.equal(openai.state, 'green');
    assert.equal(openai.reason_code, 'cli_oauth_ok');
});

test('runOnce: provider OAuth con CLI ausente → red (cli_unavailable)', async () => {
    const dir = tmpDir();
    const stateDir = path.join(dir, 'state');
    const auditDir = path.join(dir, 'audit');
    const secretsPath = makeSecretsFile(dir, {});
    const result = await healthCron.runOnce({
        stateDir,
        auditDir,
        secretsPath,
        pingImpl: fakePing({}),
        cliProbe: () => false, // CLI no disponible
        // Aislar efectos de archivo: el rojo de los OAuth dispara el sender.
        telegramSender: () => true,
        dedupFile: path.join(dir, 'dedup.json'),
        skipAudit: true,
    });
    const anthropic = result.snapshot.providers.find(p => p.provider === 'anthropic');
    assert.equal(anthropic.state, 'red');
    assert.equal(anthropic.reason_code, 'cli_unavailable');
});

test('runOnce: CA-6 simulación — 2 providers en rojo simultáneo → una alerta red por cada uno', async () => {
    // #6563 — el caso original ponía en rojo a 2 de los 3 free providers
    // (cerebras + gemini). Con un único free en el plantel, la misma
    // propiedad (cada rojo simultáneo genera su alerta; el verde no) se prueba
    // con gemini-google (free, Antigravity) + openai (codex) en rojo y
    // anthropic en verde, todos por probe de CLI.
    const dir = tmpDir();
    const stateDir = path.join(dir, 'state');
    const auditDir = path.join(dir, 'audit');
    const secretsPath = makeSecretsFile(dir, {});
    const result = await healthCron.runOnce({
        stateDir,
        auditDir,
        secretsPath,
        // #6857 — gemini-google es OAuth y su health hace round-trip REAL al
        // CLI (`agy models`). El probe fijo por binario evita spawnear el real.
        cliProbe: (binary) => binary === 'claude',
        telegramSender: () => true,
        dedupFile: path.join(dir, 'dedup.json'),
        skipAudit: true,
    });
    const plantel = result.snapshot.providers.filter(p =>
        ['gemini-google', 'openai', 'anthropic'].includes(p.provider));
    const reds = plantel.filter(p => p.state === 'red');
    const greens = plantel.filter(p => p.state === 'green');
    assert.equal(reds.length, 2, 'dos providers en rojo');
    assert.equal(greens.length, 1, 'uno verde');
    const redAlerts = result.alerts.filter(a => a.kind === 'red');
    const redProviders = redAlerts.map(a => a.provider);
    assert.ok(redProviders.includes('gemini-google'), 'alerta red para gemini-google');
    assert.ok(redProviders.includes('openai'), 'alerta red para openai');
    assert.ok(!redProviders.includes('anthropic'), 'el provider verde no alerta');
});

test('runOnce: con un único free provider en el plantel el rojo de todos NO dispara multi-down (umbral 3 inalcanzable)', async () => {
    // #6563 — antes: los 3 free (gemini, cerebras, nvidia-nim) en rojo disparaban
    // multi_down (umbral ≥3). Con cerebras y nvidia-nim retirados FREE_PROVIDERS
    // queda en { gemini-google }: el umbral es inalcanzable por construcción y
    // el rojo de gemini lo cubre la alerta por provider. La lógica del umbral
    // con 3 free inyectados sigue cubierta en multi-provider-health-alerts.test.js
    // (`freeProviders`); acá se fija el comportamiento del cron con el plantel.
    const dir = tmpDir();
    const stateDir = path.join(dir, 'state');
    const auditDir = path.join(dir, 'audit');
    const secretsPath = makeSecretsFile(dir, {});
    const result = await healthCron.runOnce({
        stateDir,
        auditDir,
        secretsPath,
        cliProbe: () => false, // #6857 — ver comentario del test anterior.
        telegramSender: () => true,
        dedupFile: path.join(dir, 'dedup.json'),
        skipAudit: true,
    });
    const reds = result.snapshot.providers.filter(p => p.state === 'red').map(p => p.provider);
    assert.ok(reds.includes('gemini-google') && reds.includes('openai') && reds.includes('anthropic'),
        'todo el plantel en rojo');
    const multi = result.alerts.find(a => a.kind === 'multi_down');
    assert.equal(multi, undefined, 'con un solo free provider (gemini-google) no hay multi_down');
    assert.ok(result.alerts.some(a => a.kind === 'red' && a.provider === 'gemini-google'),
        'el rojo de gemini-google lo cubre la alerta por provider');
});

test('runOnce: el snapshot NO contiene fingerprint, masked ni body excerpt', async () => {
    const dir = tmpDir();
    const stateDir = path.join(dir, 'state');
    const auditDir = path.join(dir, 'audit');
    // #6563 — la key legacy de gemini sigue siendo leíble por secrets-rw
    // (compatibilidad de lectura) aunque el provider sea OAuth: el snapshot no
    // debe reflejarla bajo ninguna forma.
    const SECRET_KEY = 'AIza_VERY_SECRET_DO_NOT_LEAK_aaaaaaaaaaaaaaaaaa';
    const secretsPath = makeSecretsFile(dir, { gemini_google_api_key: SECRET_KEY });
    const result = await healthCron.runOnce({
        stateDir,
        auditDir,
        secretsPath,
        // #3802 — probe CLI fijo + sender/dedup aislados (sino el rojo de
        // gemini dispararía el sender por defecto contra archivos reales).
        cliProbe: () => false,
        telegramSender: () => true,
        dedupFile: path.join(dir, 'dedup.json'),
        skipAudit: true,
    });
    const serialized = JSON.stringify(result.snapshot);
    assert.ok(!serialized.includes('VERY_SECRET'), 'snapshot no debe contener la API key');
    // #5888 S-D — el cruce de catálogo suma un SEGUNDO buffer (hasta 1 MiB) que
    // vive dentro de `live-ping.js`. Este invariante se ensancha para cubrirlo:
    // si algún día `catalogRaw` se filtrara al snapshot, acá se ve.
    assert.ok(!/fingerprint|masked|body_excerpt|bodyExcerpt|catalogRaw|catalog_raw/i.test(serialized),
        'snapshot no debe contener fingerprint/masked/body/catálogo crudo');
});

test('runOnce: persiste snapshot a state/multi-provider-health.json', async () => {
    const dir = tmpDir();
    const stateDir = path.join(dir, 'state');
    const secretsPath = makeSecretsFile(dir, {});
    await healthCron.runOnce({
        stateDir,
        auditDir: path.join(dir, 'audit'),
        secretsPath,
        // #3802 — fijar el probe de CLI para no depender del PATH real de la
        // máquina. #6563 — el único verde es anthropic (claude en PATH);
        // codex/agy ausentes → green_count == 1.
        cliProbe: (binary) => binary === 'claude',
        // Aislar efectos: sender en memoria + dedup en tmp (sino escribe en
        // servicios/telegram/pendiente/ y ~/.claude/secrets/…dedup.json reales).
        telegramSender: () => true,
        dedupFile: path.join(dir, 'dedup.json'),
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
    // #5174 — `intervalMs` explícito para que el test sea HERMÉTICO: sin él,
    // `tickIfDue` cae a `readTickIntervalMs()` sin `configPath`, el resolver baja
    // por la cadena hasta `PIPELINE_REPO_ROOT` y termina leyendo la configuración
    // del repo AMBIENTE. Este test es sobre el lock, no sobre el intervalo.
    const result = await healthCron.tickIfDue({
        stateDir, secretsPath: makeSecretsFile(dir, {}), intervalMs: 60000,
    });
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
        provider: 'gemini-google',
        state: 'red',
        reason_code: 'invalid_credentials',
        observed_at: '2026-05-17T00:00:00Z',
    });
    assert.ok(t.includes('gemini-google'));
    assert.ok(t.includes('RED'));
    assert.ok(t.includes('invalid_credentials'));
});

test('formatAlertText: #4402 CA-4 — incluye el conteo consecutivo (xN) y nombra provider+status', () => {
    const t = healthCron.formatAlertText({
        provider: 'anthropic',
        state: 'red',
        reason_code: 'invalid_credentials',
        consecutive_count: 3,
        observed_at: '2026-07-02T00:00:00Z',
    });
    assert.ok(t.includes('anthropic'), 'nombra el provider');
    assert.ok(t.includes('invalid_credentials'), 'nombra el status del enum');
    assert.ok(t.includes('x3'), 'incluye el conteo consecutivo');
    // RS-5.3 — nunca el body crudo de un 401.
    assert.ok(!/401|www-authenticate|request-id/i.test(t), 'no filtra body/headers del 401');
});

test('formatAlertText: sin consecutive_count no agrega xN', () => {
    const t = healthCron.formatAlertText({
        provider: 'gemini-google',
        state: 'red',
        reason_code: 'timeout',
        observed_at: '2026-07-02T00:00:00Z',
    });
    assert.ok(!/ x\d/.test(t), 'no debe agregar sufijo xN si no hay conteo');
});

test('formatAlertText: multi_down lista los providers', () => {
    const t = healthCron.formatAlertText({
        event: 'multi_down',
        red_count: 3,
        providers_red: ['gemini-google', 'openai', 'anthropic'],
        observed_at: '2026-05-17T00:00:00Z',
    });
    assert.ok(t.includes('Multi-Down'));
    assert.ok(t.includes('gemini-google'));
});

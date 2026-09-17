'use strict';

// #6857 — Encender el proveedor Antigravity y reemplazar el chequeo de
// licencia por un health con round-trip real (`agy models`).
//
// Cubre:
//   CA-2  no disponible con AGY_BIN inexistente y con CLI "deslogueado"
//   CA-3  el estado sale del round-trip, no de una env var
//   CA-4  tres estados distinguibles (probe + snapshot + dashboard)
//   TTL   cache en filesystem, invalidación, `force`
//   Inv.  reason nuevo en ambas tablas (#5888) y NO durable en el dispatch

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const agyProbe = require('../lib/multi-provider/agy-catalog-probe');
const { probeCliProviderLive, probeCliProvider } = require('../lib/multi-provider/cli-oauth-probe');
const healthCron = require('../lib/multi-provider/health-cron');
const healthAlerts = require('../lib/multi-provider/health-alerts');
const secrets = require('../lib/multi-provider/secrets-rw');
const handler = require('../lib/agent-launcher/providers/gemini-google');
const { DURABLE_RED_REASONS, evaluateHealthGate } = require('../lib/agent-launcher/dispatch-with-fallback');
const providersView = require('../views/dashboard/providers');
const pauseCause = require('../lib/provider-pause-cause');

const NOW = Date.parse('2026-09-16T12:00:00.000Z');
const CATALOG_STDOUT = [
    'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
    'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
    'claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)',
    'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
].join('\n') + '\n';

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'agy-probe-6857-'));
}

// Spawn falso: emite stdout/stderr y cierra con `rc`. `hang: true` nunca cierra
// (simula `agy` deslogueado bloqueado en OAuth — #4869).
function fakeSpawn({ rc = 0, stdout = '', stderr = 'Fetching available models...', hang = false, enoent = false } = {}) {
    const calls = [];
    const spawn = (cmd, args, opts) => {
        if (args[0] === 'models') calls.push({ cmd, args, opts });
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.killed = false;
        child.kill = () => { child.killed = true; };
        setImmediate(() => {
            if (args[0] === '--version') { child.stdout.emit('data', Buffer.from('1.2.4')); child.emit('close', 0); return; }
            if (enoent) { child.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' })); return; }
            if (stderr) child.stderr.emit('data', Buffer.from(stderr));
            if (stdout) child.stdout.emit('data', Buffer.from(stdout));
            if (!hang) child.emit('close', rc);
        });
        return child;
    };
    spawn.calls = calls;
    return spawn;
}

// Entorno con un binario "instalado" en la ubicación oficial (archivo real en tmp).
function installedEnv(dir) {
    const bin = path.join(dir, 'agy', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const exe = path.join(bin, 'agy.exe');
    fs.writeFileSync(exe, 'stub');
    return { env: { LOCALAPPDATA: dir, PATH: '' }, exe };
}

// ─── parseModelsOutput ──────────────────────────────────────────────────────
test('parseModelsOutput: extrae ids por TAB, ignora "Fetching…", dedup y sanea', () => {
    const out = agyProbe.parseModelsOutput(
        'Fetching available models...\n' + CATALOG_STDOUT + 'gemini-3.8-flash-high\tdup\n' +
        '<script>alert(1)</script>\tmalicioso\n' + '\n   \n',
    );
    assert.deepEqual(out, [
        'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium',
    ]);
    assert.deepEqual(agyProbe.parseModelsOutput(''), []);
    assert.deepEqual(agyProbe.parseModelsOutput(null), []);
});

// ─── resolveAgyBinary: paridad con detectLauncher ───────────────────────────
test('resolveAgyBinary usa el MISMO orden que detectLauncher (AGY_BIN → oficial → PATH)', () => {
    const dir = tmpDir();
    const { env, exe } = installedEnv(dir);
    // 1) oficial
    const r1 = agyProbe.resolveAgyBinary({ env, platform: 'win32' });
    assert.equal(r1.cmd, exe);
    assert.equal(r1.kind, 'native-exe');
    assert.equal(r1.available, true);
    assert.equal(handler._detectLauncherFresh(env, fs, 'win32').cmd, r1.cmd, 'launcher y probe miran el mismo binario');
    // 2) AGY_BIN gana sobre la oficial
    const custom = path.join(dir, 'custom-agy.exe');
    fs.writeFileSync(custom, 'stub');
    const r2 = agyProbe.resolveAgyBinary({ env: { ...env, AGY_BIN: custom }, platform: 'win32' });
    assert.equal(r2.cmd, custom);
    assert.equal(r2.kind, 'configured-native');
    assert.equal(r2.available, true);
    // 3) AGY_BIN inexistente → NO disponible (CA-2), aunque la oficial exista
    const r3 = agyProbe.resolveAgyBinary({ env: { ...env, AGY_BIN: path.join(dir, 'no-existe.exe') }, platform: 'win32' });
    assert.equal(r3.available, false);
    assert.equal(r3.kind, 'configured-native');
    // 4) sin oficial ni PATH → path-fallback no disponible
    const r4 = agyProbe.resolveAgyBinary({ env: { LOCALAPPDATA: path.join(dir, 'vacio'), PATH: '' }, platform: 'win32' });
    assert.equal(r4.kind, 'path-fallback');
    assert.equal(r4.available, false);
});

// ─── Tres estados (CA-4) ────────────────────────────────────────────────────
test('estado 1/3 — binario ausente → cli_unavailable, sin spawn', async () => {
    const dir = tmpDir();
    const spawn = fakeSpawn({ stdout: CATALOG_STDOUT });
    const r = await agyProbe.probeAgyCatalog({
        env: { LOCALAPPDATA: path.join(dir, 'nada'), PATH: '' }, platform: 'win32',
        spawnImpl: spawn, noCache: true, nowMs: NOW,
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'cli_unavailable');
    assert.equal(r.detail, 'binary_missing');
    assert.equal(spawn.calls.length, 0, 'sin binario no hay round-trip');
});

test('estado 2/3 — instalado pero catálogo vacío / rc≠0 / timeout / ENOENT → cli_license_unavailable', async () => {
    const dir = tmpDir();
    const { env } = installedEnv(dir);
    const base = { env, platform: 'win32', noCache: true, nowMs: NOW };

    const vacio = await agyProbe.probeAgyCatalog({ ...base, spawnImpl: fakeSpawn({ rc: 0, stdout: '' }) });
    assert.equal(vacio.ok, false);
    assert.equal(vacio.reason, 'cli_license_unavailable');
    assert.equal(vacio.detail, 'empty_catalog');

    const rc1 = await agyProbe.probeAgyCatalog({ ...base, spawnImpl: fakeSpawn({ rc: 1, stdout: '' }) });
    assert.equal(rc1.reason, 'cli_license_unavailable');
    assert.equal(rc1.detail, 'exit_nonzero');

    // Deslogueado: `agy` bloquea en OAuth (#4869). El timeout duro lo corta.
    const t0 = Date.now();
    const colgado = await agyProbe.probeAgyCatalog({ ...base, spawnImpl: fakeSpawn({ hang: true }), timeoutMs: 50 });
    assert.equal(colgado.reason, 'cli_license_unavailable');
    assert.equal(colgado.detail, 'timeout');
    assert.ok(Date.now() - t0 < 5000, 'el probe no cuelga el tick');

    const enoent = await agyProbe.probeAgyCatalog({ ...base, spawnImpl: fakeSpawn({ enoent: true }) });
    assert.equal(enoent.reason, 'cli_license_unavailable');
    assert.equal(enoent.detail, 'spawn_error');
});

test('estado 3/3 — catálogo poblado → cli_catalog_ok con ids y conteo; spawnea `<cmd> models` sin shell', async () => {
    const dir = tmpDir();
    const { env, exe } = installedEnv(dir);
    const spawn = fakeSpawn({ stdout: CATALOG_STDOUT });
    const r = await agyProbe.probeAgyCatalog({ env, platform: 'win32', spawnImpl: spawn, noCache: true, nowMs: NOW });
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'cli_catalog_ok');
    assert.equal(r.detail, 'catalog_ok');
    assert.equal(r.model_count, 4);
    assert.deepEqual(r.models, ['gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium']);
    assert.equal(r.cached, false);
    assert.equal(spawn.calls.length, 1);
    assert.equal(spawn.calls[0].cmd, exe);
    assert.deepEqual(spawn.calls[0].args, ['models']);
    assert.equal(spawn.calls[0].opts.shell, false);
    assert.equal(spawn.calls[0].opts.windowsHide, true);
});

// ─── CA-3: el estado NO depende de AGY_LICENSE_READY ────────────────────────
test('CA-3 — AGY_LICENSE_READY vacío con licencia activa → verde; en "1" sin licencia → rojo', async () => {
    const dir = tmpDir();
    const { env } = installedEnv(dir);
    const verde = await agyProbe.probeAgyCatalog({
        env: { ...env, AGY_LICENSE_READY: '' }, platform: 'win32',
        spawnImpl: fakeSpawn({ stdout: CATALOG_STDOUT }), noCache: true, nowMs: NOW,
    });
    assert.equal(verde.ok, true, 'flag vacío no impide el verde real');
    const rojo = await agyProbe.probeAgyCatalog({
        env: { ...env, AGY_LICENSE_READY: '1' }, platform: 'win32',
        spawnImpl: fakeSpawn({ rc: 0, stdout: '' }), noCache: true, nowMs: NOW,
    });
    assert.equal(rojo.ok, false, 'flag en 1 no inventa una licencia');
    assert.equal(rojo.reason, 'cli_license_unavailable');
});

// ─── Cache con TTL ──────────────────────────────────────────────────────────
test('cache: dentro del TTL no hay round-trip; vencido o con force sí; el binario se re-verifica siempre', async () => {
    const dir = tmpDir();
    const { env } = installedEnv(dir);
    const stateDir = path.join(dir, 'state');
    const spawn = fakeSpawn({ stdout: CATALOG_STDOUT });
    const base = { env, platform: 'win32', spawnImpl: spawn, stateDir };

    const r1 = await agyProbe.probeAgyCatalog({ ...base, nowMs: NOW });
    assert.equal(r1.cached, false);
    assert.equal(spawn.calls.length, 1);
    assert.ok(fs.existsSync(path.join(stateDir, agyProbe.CACHE_FILENAME)), 'cache persistida en state/');

    const r2 = await agyProbe.probeAgyCatalog({ ...base, nowMs: NOW + 5 * 60_000 });
    assert.equal(r2.cached, true);
    assert.equal(r2.reason, 'cli_catalog_ok');
    assert.equal(r2.model_count, 4);
    assert.equal(r2.age_ms, 5 * 60_000);
    assert.equal(spawn.calls.length, 1, 'tick a los 5 min: sin round-trip');

    const r3 = await agyProbe.probeAgyCatalog({ ...base, nowMs: NOW + agyProbe.DEFAULT_TTL_MS + 1 });
    assert.equal(r3.cached, false);
    assert.equal(spawn.calls.length, 2, 'TTL vencido: round-trip');

    const r4 = await agyProbe.probeAgyCatalog({ ...base, nowMs: NOW + agyProbe.DEFAULT_TTL_MS + 2, force: true });
    assert.equal(r4.cached, false);
    assert.equal(spawn.calls.length, 3, 'force: round-trip aunque la cache esté fresca');

    // La cache NO tapa un binario que desapareció (CA-2 con AGY_BIN roto).
    const roto = await agyProbe.probeAgyCatalog({
        ...base, env: { ...env, AGY_BIN: path.join(dir, 'no-existe.exe') }, nowMs: NOW + agyProbe.DEFAULT_TTL_MS + 3,
    });
    assert.equal(roto.reason, 'cli_unavailable');
    assert.equal(spawn.calls.length, 3);
    assert.equal(fs.existsSync(path.join(stateDir, agyProbe.CACHE_FILENAME)), false, 'binario ausente invalida el verde cacheado');
});

test('cache: un rojo vence antes que un verde (TTL negativo < 1 tick) para no retrasar la recuperación', async () => {
    const dir = tmpDir();
    const { env } = installedEnv(dir);
    const stateDir = path.join(dir, 'state');
    assert.ok(agyProbe.DEFAULT_NEGATIVE_TTL_MS < 5 * 60_000, 'menor que el tick del cron (5 min)');
    assert.ok(agyProbe.DEFAULT_NEGATIVE_TTL_MS < agyProbe.DEFAULT_TTL_MS);
    // Rojo (catálogo vacío) cacheado…
    const rojo = fakeSpawn({ rc: 0, stdout: '' });
    const r1 = await agyProbe.probeAgyCatalog({ env, platform: 'win32', spawnImpl: rojo, stateDir, nowMs: NOW });
    assert.equal(r1.reason, 'cli_license_unavailable');
    // …sigue cacheado 1 min después…
    const r2 = await agyProbe.probeAgyCatalog({ env, platform: 'win32', spawnImpl: rojo, stateDir, nowMs: NOW + 60_000 });
    assert.equal(r2.cached, true);
    // …pero al tick siguiente (5 min) ya se re-prueba, y si el operador
    // reautenticó, vuelve verde sin esperar los 15 min del TTL positivo.
    const verde = fakeSpawn({ stdout: CATALOG_STDOUT });
    const r3 = await agyProbe.probeAgyCatalog({ env, platform: 'win32', spawnImpl: verde, stateDir, nowMs: NOW + 5 * 60_000 });
    assert.equal(r3.cached, false);
    assert.equal(r3.reason, 'cli_catalog_ok');
    assert.equal(verde.calls.length, 1);
});

test('cache: invalidateCache fuerza el próximo round-trip (hook de authentication_rejected)', async () => {
    const dir = tmpDir();
    const { env } = installedEnv(dir);
    const stateDir = path.join(dir, 'state');
    const spawn = fakeSpawn({ stdout: CATALOG_STDOUT });
    await agyProbe.probeAgyCatalog({ env, platform: 'win32', spawnImpl: spawn, stateDir, nowMs: NOW });
    assert.equal(agyProbe.invalidateCache({ stateDir }), true);
    assert.equal(agyProbe.invalidateCache({ stateDir }), true, 'idempotente');
    await agyProbe.probeAgyCatalog({ env, platform: 'win32', spawnImpl: spawn, stateDir, nowMs: NOW + 1000 });
    assert.equal(spawn.calls.length, 2);
});

test('cache: un archivo corrupto o de otra versión se ignora (fail-closed → re-probe)', async () => {
    const dir = tmpDir();
    const { env } = installedEnv(dir);
    const stateDir = path.join(dir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, agyProbe.CACHE_FILENAME), '{ esto no es json');
    const spawn = fakeSpawn({ stdout: CATALOG_STDOUT });
    const r = await agyProbe.probeAgyCatalog({ env, platform: 'win32', spawnImpl: spawn, stateDir, nowMs: NOW });
    assert.equal(r.cached, false);
    assert.equal(spawn.calls.length, 1);
});

// ─── probeCliProviderLive (capa compartida health-cron / live-ping) ─────────
test('probeCliProviderLive: gemini con catalog_probe → tres reasons; anthropic/codex sin cambios', async () => {
    const gemini = secrets.MANAGED_KEYS.find((k) => k.provider === 'gemini-google');
    const ok = await probeCliProviderLive(gemini, {
        catalogProbe: async () => ({ ok: true, reason: 'cli_catalog_ok', detail: 'catalog_ok', models: ['a', 'b'], model_count: 2, latency_ms: 1900, checked_at: new Date(NOW).toISOString(), cached: false, launcher_kind: 'native-exe' }),
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.reason, 'cli_catalog_ok');
    assert.equal(ok.cli_probe.model_count, 2);
    assert.deepEqual(ok.cli_probe.models, ['a', 'b']);

    const sinLic = await probeCliProviderLive(gemini, {
        catalogProbe: async () => ({ ok: false, reason: 'cli_license_unavailable', detail: 'timeout', models: [], model_count: 0 }),
    });
    assert.equal(sinLic.ok, false);
    assert.equal(sinLic.reason, 'cli_license_unavailable');

    const sinBin = await probeCliProviderLive(gemini, {
        catalogProbe: async () => ({ ok: false, reason: 'cli_unavailable', detail: 'binary_missing', models: [], model_count: 0 }),
    });
    assert.equal(sinBin.reason, 'cli_unavailable');

    // cliProbe inyectado en false corta antes del round-trip.
    let llamado = false;
    const cortado = await probeCliProviderLive(gemini, { cliProbe: () => false, catalogProbe: async () => { llamado = true; } });
    assert.equal(cortado.reason, 'cli_unavailable');
    assert.equal(llamado, false);

    // Un probe que revienta → fail-closed (nunca verde).
    const roto = await probeCliProviderLive(gemini, { catalogProbe: async () => { throw new Error('boom'); } });
    assert.equal(roto.ok, false);
    assert.equal(roto.reason, 'cli_license_unavailable');

    // anthropic (sin catalog_probe): mismo veredicto que el sync.
    const anthropic = secrets.MANAGED_KEYS.find((k) => k.provider === 'anthropic');
    assert.deepEqual(
        await probeCliProviderLive(anthropic, { cliProbe: () => true }),
        probeCliProvider(anthropic, { cliProbe: () => true }),
    );
});

// ─── Integración health-cron: snapshot con los tres estados ─────────────────
async function snapshotWith(catalogResult, extra = {}) {
    const results = await healthCron.pingAllProviders({
        providers: [secrets.MANAGED_KEYS.find((k) => k.provider === 'gemini-google')],
        cliProbe: () => true,
        catalogProbe: async () => catalogResult,
        planProbe: async () => ({ reason_code: 'plan_tier_unknown', checked_at: new Date(NOW).toISOString() }),
        quotaAssessImpl: () => ({ adapterStatus: 'unknown', status: 'unknown', pct: null, gated: false, reason_code: null }),
        defaultProvider: 'anthropic',
        now: NOW,
        ...extra,
    });
    return results.find((r) => r.provider === 'gemini-google');
}

test('health-cron: catálogo poblado → green / cli_catalog_ok con cli_probe en el snapshot', async () => {
    const g = await snapshotWith({ ok: true, reason: 'cli_catalog_ok', detail: 'catalog_ok', models: ['gemini-3.8-flash-medium', 'claude-opus-4-6-thinking'], model_count: 2, latency_ms: 2100, checked_at: new Date(NOW).toISOString(), cached: false, launcher_kind: 'native-exe' });
    assert.equal(g.state, 'green');
    assert.equal(g.reason_code, 'cli_catalog_ok');
    assert.equal(g.auth_mode, 'oauth');
    assert.equal(g.latency_ms, 2100);
    assert.deepEqual(Object.keys(g.cli_probe).sort(), ['cached', 'checked_at', 'cli_version', 'detail', 'kind', 'launcher_kind', 'model_count', 'models']);
    assert.equal(g.cli_probe.model_count, 2);
    assert.equal(g.cli_probe.kind, 'agy');
    // El snapshot es contrato: nada del CLI sin sanear.
    assert.equal(JSON.stringify(g).includes('token'), false);
});

test('health-cron: sin licencia → red / cli_license_unavailable; sin binario → red / cli_unavailable', async () => {
    const lic = await snapshotWith({ ok: false, reason: 'cli_license_unavailable', detail: 'empty_catalog', models: [], model_count: 0, checked_at: new Date(NOW).toISOString() });
    assert.equal(lic.state, 'red');
    assert.equal(lic.reason_code, 'cli_license_unavailable');
    assert.equal(lic.cli_probe.detail, 'empty_catalog');

    const bin = await snapshotWith({ ok: false, reason: 'cli_unavailable', detail: 'binary_missing', models: [], model_count: 0, checked_at: new Date(NOW).toISOString() });
    assert.equal(bin.state, 'red');
    assert.equal(bin.reason_code, 'cli_unavailable');
});

test('health-cron: el catálogo real alimenta el cruce de vigencia #5888 (deja de quedar `unavailable`)', async () => {
    const expect = new Map([['gemini-google', ['gemini-3.8-flash-medium', 'gemini-3-flash-preview']]]);
    const g = await snapshotWith(
        { ok: true, reason: 'cli_catalog_ok', detail: 'catalog_ok', models: ['gemini-3.8-flash-medium'], model_count: 1, checked_at: new Date(NOW).toISOString() },
        { checkCatalog: true, expectModelsByProvider: expect },
    );
    assert.equal(g.state, 'green', 'un modelo muerto NO pone rojo al provider (R-C)');
    assert.equal(g.catalog_check.state, 'not_in_catalog');
    assert.equal(g.catalog_check.reason_code, 'model_not_in_catalog');
    assert.deepEqual(g.catalog_check.models, [
        { model_id: 'gemini-3.8-flash-medium', alive: true },
        { model_id: 'gemini-3-flash-preview', alive: false },
    ]);
});

test('health-cron: un catalogProbe que revienta deja rojo fail-closed, nunca verde ni excepción', async () => {
    const results = await healthCron.pingAllProviders({
        providers: [secrets.MANAGED_KEYS.find((k) => k.provider === 'gemini-google')],
        cliProbe: () => true,
        catalogProbe: async () => { throw new Error('boom'); },
        quotaAssessImpl: () => ({ adapterStatus: 'unknown', status: 'unknown', pct: null, gated: false, reason_code: null }),
        defaultProvider: 'anthropic',
        now: NOW,
    });
    const g = results.find((r) => r.provider === 'gemini-google');
    assert.equal(g.state, 'red');
    assert.equal(g.reason_code, 'cli_license_unavailable');
});

// ─── Launcher (agy 1.2.x): prompt por stdin como NDJSON, log NDJSON ─────────
test('launcher: buildSpawn usa --input-format stream-json y manda system+prompt por stdin como NDJSON', () => {
    const dir = tmpDir();
    const sysFile = path.join(dir, 'system.md');
    fs.writeFileSync(sysFile, 'SYSTEM RULES');
    handler._setLauncherForTesting({ kind: 'native-exe', cmd: 'agy', prefixArgs: [], shell: false });
    try {
        const plan = handler.buildSpawn({
            args: ['-p', 'hola mundo', '--system-prompt-file', sysFile],
            cwd: dir,
            // #6858 — el handler lee SÓLO GEMINI_MODEL (la variable que propaga
            // PROVIDER_MODEL_ENV); AGY_MODEL se ignora y se reporta en modelTrace.
            env: { GEMINI_MODEL: 'gemini-3.8-flash-low' },
        });
        assert.equal(plan.modelTrace && plan.modelTrace.model, 'gemini-3.8-flash-low');
        assert.deepEqual(plan.args, [
            '--input-format', 'stream-json', '--output-format', 'stream-json',
            '--disable-slash-commands', // #7322 — hardening
            '--dangerously-skip-permissions', '--print-timeout', '5m',
            '--add-dir', dir, // #6859 — workspace explícito
            '--model', 'gemini-3.8-flash-low',
        ]);
        assert.equal(plan.args.includes('--print'), false, 'agy 1.2.x: --print sin valor es error');
        assert.equal(plan.args.some((a) => a.includes('hola')), false, 'el prompt NUNCA va por argv (#4529)');
        const lines = plan.stdinPayload.split('\n').filter(Boolean);
        assert.equal(lines.length, 1, 'una sola línea NDJSON');
        const msg = JSON.parse(lines[0]);
        assert.equal(msg.event, 'user');
        assert.equal(msg.message.role, 'user');
        assert.equal(msg.message.content, 'SYSTEM RULES\n\nhola mundo');
        assert.equal(plan.spawnOpts.shell, false);
    } finally {
        handler._resetLauncherCacheForTesting();
    }
});

test('launcher: _parseGeminiJson localiza el `result` en un log NDJSON y sigue aceptando el JSON único', () => {
    const ndjson = [
        '{"event":"init","conversation_id":"c1","init":{"model":"gemini-3.8-flash-low"}}',
        '{"event":"step_update","step_update":{"conversation_id":"c1","state":"ACTIVE","text_delta":"{\\"result\\":"}}',
        '{"event":"result","result":{"conversation_id":"c1","status":"SUCCESS","response":"OK","usage":{"total_tokens":42}}}',
        '',
    ].join('\n');
    const r = handler._parseGeminiJson(ndjson);
    assert.equal(r.conversation_id, 'c1');
    assert.equal(r.status, 'SUCCESS');
    assert.equal(r.usage.total_tokens, 42);
    // JSON único (--output-format json) sigue funcionando.
    assert.deepEqual(handler._parseGeminiJson('{"conversation_id":"c2","status":"ERROR"}'), { conversation_id: 'c2', status: 'ERROR' });
    // Log truncado sin evento `result` → cae a la estrategia vieja: nunca tira,
    // y lo que devuelva no puede traer `error`/`usage` que confundan a los
    // detectores (el frame `init` no los tiene).
    const trunc = handler._parseGeminiJson('{"event":"init","conversation_id":"c3"}\n{"event":"step_update"');
    assert.ok(trunc === null || (typeof trunc === 'object' && !('error' in trunc) && !('usage' in trunc)));
});

// ─── Dispatch: verde real entra a la cascada; rojos siguen siendo durables ──
test('dispatch: cli_catalog_ok NO es durable (no gatea); los dos rojos sí', () => {
    assert.equal(DURABLE_RED_REASONS.has('cli_catalog_ok'), false);
    assert.equal(DURABLE_RED_REASONS.has('cli_license_unavailable'), true);
    assert.equal(DURABLE_RED_REASONS.has('cli_unavailable'), true);
    const snapshot = {
        ts: new Date(NOW).toISOString(),
        providers: [{ provider: 'gemini-google', state: 'green', reason_code: 'cli_catalog_ok', last_checked_at: new Date(NOW - 60_000).toISOString() }],
    };
    assert.equal(evaluateHealthGate('gemini-google', snapshot, NOW).gated, false, 'verde real → elegible en la cascada');
});

// ─── Invariantes de vocabulario (#5888) ─────────────────────────────────────
test('cli_catalog_ok vive en ALLOWED_REASON_CODES, REASON_LABEL (sin `_`) y REASON_TABLE', () => {
    assert.equal(healthAlerts.ALLOWED_REASON_CODES.has('cli_catalog_ok'), true);
    assert.equal(healthAlerts.sanitizeReasonCode('cli_catalog_ok'), 'cli_catalog_ok');
    assert.equal(typeof providersView.REASON_LABEL.cli_catalog_ok, 'string');
    assert.doesNotMatch(providersView.REASON_LABEL.cli_catalog_ok, /_/);
    assert.equal(Object.hasOwn(pauseCause.REASON_TABLE, 'cli_catalog_ok'), true);
});

// ─── Dashboard: tres labels distintos, frescura, SIN DATOS ──────────────────
test('dashboard /providers: SIN INSTALAR / SIN LICENCIA / SANO se distinguen por texto, no sólo por color', () => {
    const base = { authMode: 'oauth', cliProbe: { model_count: 0 }, lastChecked: new Date(NOW - 60_000).toISOString() };
    const sinInstalar = providersView.healthBadgeFor({ ...base, healthState: 'red', healthReason: 'cli_unavailable' }, NOW);
    const sinLicencia = providersView.healthBadgeFor({ ...base, healthState: 'red', healthReason: 'cli_license_unavailable' }, NOW);
    const sano = providersView.healthBadgeFor({ ...base, healthState: 'green', healthReason: 'cli_catalog_ok', cliProbe: { model_count: 14 } }, NOW);
    assert.deepEqual([sinInstalar.label, sinLicencia.label, sano.label], ['SIN INSTALAR', 'SIN LICENCIA', 'SANO']);
    assert.equal(sinInstalar.severity, 'bad');
    assert.equal(sinLicencia.severity, 'bad', 'ambos rojos: ninguno es elegible (no hay cuarto color)');
    assert.equal(sano.severity, 'ok');
    // Un provider api_key en rojo por otra causa sigue diciendo CAÍDO.
    const apiKey = providersView.healthBadgeFor({ authMode: 'api_key', healthState: 'red', healthReason: 'invalid_credentials', cliProbe: null }, NOW);
    assert.equal(apiKey.label, 'CAÍDO');
});

test('dashboard /providers: verde más viejo que 2×TTL → info · SIN DATOS, nunca verde', () => {
    const viejo = providersView.healthBadgeFor({
        authMode: 'oauth', healthState: 'green', healthReason: 'cli_catalog_ok',
        cliProbe: { model_count: 14 }, lastChecked: new Date(NOW - providersView.CLI_PROBE_STALE_MS - 1000).toISOString(),
    }, NOW);
    assert.equal(viejo.label, 'SIN DATOS');
    assert.equal(viejo.severity, 'info');
    assert.equal(viejo.stale, true);
    // Sin cli_probe (providers que no hacen round-trip) la regla no aplica.
    const otro = providersView.healthBadgeFor({
        authMode: 'oauth', healthState: 'green', healthReason: 'cli_oauth_ok', cliProbe: null,
        lastChecked: new Date(NOW - providersView.CLI_PROBE_STALE_MS - 1000).toISOString(),
    }, NOW);
    assert.equal(otro.label, 'SANO');
});

test('dashboard /providers: el render SSR contiene los tres labels y "catálogo verificado · N modelos · hace X"', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'views', 'dashboard', 'providers.js'), 'utf8');
    assert.match(src, /SIN INSTALAR/);
    assert.match(src, /SIN LICENCIA/);
    // Render real de una fila por cada estado (SSR, sin browser).
    const fila = (over) => providersView.renderProviderRow({
        key: 'gemini-google', disabledKey: 'gemini-google', name: 'Gemini', accent: 'var(--provider-gemini)',
        tier: 'FREE', tierKind: 'free', tierIcon: '🟩', masked: null, fingerprint: null, keyStatus: 'not_applicable',
        editable: false, reason: null, authMode: 'oauth', freeTierNotes: null,
        catalogCheck: null, quota: null, session: null,
        lastChecked: new Date(NOW - 12 * 60_000).toISOString(), loadPct: 0, dispatches24h: 0, hasTraffic: false,
        models: [], disabled: false,
        ...over,
    }, NOW);
    const verde = fila({ healthState: 'green', healthReason: 'cli_catalog_ok', cliProbe: { model_count: 14, checked_at: new Date(NOW - 12 * 60_000).toISOString(), cached: true, detail: 'catalog_ok' } });
    assert.match(verde, />SANO</);
    assert.match(verde, /catálogo verificado · 14 modelos · hace 12 min/);
    const sinLic = fila({ healthState: 'red', healthReason: 'cli_license_unavailable', cliProbe: { model_count: 0, detail: 'empty_catalog' } });
    assert.match(sinLic, />SIN LICENCIA</);
    assert.doesNotMatch(sinLic, />CAÍDO</);
    const sinBin = fila({ healthState: 'red', healthReason: 'cli_unavailable', cliProbe: { model_count: 0, detail: 'binary_missing' } });
    assert.match(sinBin, />SIN INSTALAR</);
    const contract = fila({ lastChecked: new Date(NOW - 2 * 60_000).toISOString(), healthState: 'red', healthReason: 'cli_contract_mismatch', cliProbe: { cli_version: '1.3.0', detail: 'version_above_tested', checked_at: new Date(NOW - 2 * 60_000).toISOString() } });
    assert.match(contract, />VERSIÓN NO PROBADA</);
    assert.match(contract, /versión del CLI fuera del rango probado · agy 1\.3\.0 · hace 2 min/);
    const unreadable = fila({ healthState: 'red', healthReason: 'cli_contract_mismatch', cliProbe: { detail: 'version_unparseable' } });
    assert.match(unreadable, /versión del CLI ilegible/);
    assert.doesNotMatch(unreadable, /agy null/);
    const viejo = fila({ healthState: 'green', healthReason: 'cli_catalog_ok', cliProbe: { model_count: 14 }, lastChecked: new Date(NOW - 61 * 60_000).toISOString() });
    assert.match(viejo, />SIN DATOS</);
    assert.doesNotMatch(viejo, />SANO</);
});

// #7290 — versión, errores y cache del contrato antes de consultar modelos.
function fakeVersionSpawn({ version = '1.2.4', rc = 0, hang = false, throws = false, error = false, killThrows = false } = {}) {
    const calls = [];
    const fakeSpawnImpl = (cmd, args, opts) => {
        calls.push({ cmd, args, opts });
        if (throws) throw new Error('spawn falló');
        const child = new EventEmitter();
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        child.kill = () => { if (killThrows) throw new Error('kill falló'); };
        setImmediate(() => {
            if (error) { child.emit('error', new Error('ENOENT')); child.emit('close', 1); return; }
            child.stderr.emit('data', 'texto que no se persiste');
            child.stdout.emit('data', args[0] === '--version' ? version : CATALOG_STDOUT);
            if (!hang) child.emit('close', args[0] === '--version' ? rc : 0);
        });
        return child;
    };
    fakeSpawnImpl.calls = calls;
    return fakeSpawnImpl;
}

test('contrato: parsea versión saneada y rechaza basura o números inseguros', () => {
    for (const input of [null, {}, '', 'agy 1.2.4', 'x', '999999999999999999999.2.4']) assert.equal(agyProbe.parseAgyVersion(input), null);
    assert.equal(agyProbe.parseAgyVersion(' 1.2.4\r\n'), '1.2.4');
    assert.equal(agyProbe.parseAgyVersion('1.2.4 extra'), '1.2.4');
    assert.ok(Object.isFrozen(agyProbe.AGY_CLI_CONTRACT));
});

for (const [version, detail] of [['1.1.20', 'version_below_min'], ['1.3.0', 'version_above_tested'], ['2.0.0', 'version_above_tested'], ['basura', 'version_unparseable']]) {
    test(`contrato: ${version} corta antes del catálogo con ${detail}`, async () => {
        const { env } = installedEnv(tmpDir());
        const fake = fakeVersionSpawn({ version });
        const r = await agyProbe.probeAgyCatalog({ env, spawnImpl: fake, noCache: true });
        assert.equal(r.reason, 'cli_contract_mismatch'); assert.equal(r.detail, detail);
        assert.deepEqual(r.models, []); assert.equal(r.ok, false);
        assert.deepEqual(fake.calls.map(c => c.args), [['--version']]);
        assert.equal(fake.calls[0].opts.shell, false); assert.equal(fake.calls[0].opts.windowsHide, true);
        assert.deepEqual(fake.calls[0].opts.stdio, ['ignore', 'pipe', 'pipe']);
    });
}

for (const failure of [{ rc: 1 }, { error: true }, { throws: true }, { hang: true }, { hang: true, killThrows: true }]) {
    test(`contrato: fallo ${JSON.stringify(failure)} da rojo aunque stdout tenga versión válida`, async () => {
        const { env } = installedEnv(tmpDir());
        const fake = fakeVersionSpawn(failure);
        const r = await agyProbe.probeAgyCatalog({ env, spawnImpl: fake, timeoutMs: 10, noCache: true });
        assert.equal(r.reason, 'cli_contract_mismatch'); assert.equal(r.detail, 'version_unparseable');
        assert.equal(fake.calls.length, 1);
    });
}

test('contrato: override del spec llega al probe y cli_version al snapshot', async () => {
    const { env } = installedEnv(tmpDir());
    const gemini = secrets.MANAGED_KEYS.find(k => k.provider === 'gemini-google');
    const fake = fakeVersionSpawn({ version: '1.2.4' });
    const r = await probeCliProviderLive({ ...gemini, cli_contract: { min_version: '1.2.5', max_tested_version: '1.2.5' } }, { env, spawnImpl: fake, noCache: true });
    assert.equal(r.reason, 'cli_contract_mismatch'); assert.equal(r.cli_probe.cli_version, '1.2.4');
    const snapshot = await snapshotWith({ ok: false, reason: r.reason, detail: r.cli_probe.detail, cli_version: '1.2.4', models: [] });
    assert.equal(snapshot.state, 'red'); assert.equal(snapshot.cli_probe.cli_version, '1.2.4');
});

test('contrato: cache v1 se descarta y cambiar pin invalida cache v2; rojo usa TTL negativo', async () => {
    const dir = tmpDir(), { env, exe } = installedEnv(dir);
    const cachePath = path.join(dir, 'cache.json');
    fs.writeFileSync(cachePath, JSON.stringify({ version: 1, checked_at_ms: NOW, cmd: exe, reason: 'cli_catalog_ok' }));
    const fake = fakeVersionSpawn();
    const opts = { env, cachePath, spawnImpl: fake, nowMs: NOW };
    const r = await agyProbe.probeAgyCatalog(opts);
    assert.equal(r.cached, false); assert.equal(r.cli_version, '1.2.4'); assert.equal(fake.calls.length, 2);
    assert.equal(JSON.parse(fs.readFileSync(cachePath)).version, 2);
    assert.equal((await agyProbe.probeAgyCatalog(opts)).cached, true);
    const contract = { max_tested_version: '1.2.3' };
    const red = await agyProbe.probeAgyCatalog({ ...opts, contract });
    assert.equal(red.reason, 'cli_contract_mismatch'); assert.equal(fake.calls.length, 3);
    assert.equal((await agyProbe.probeAgyCatalog({ ...opts, contract, nowMs: NOW + 1000 })).cached, true);
    assert.equal((await agyProbe.probeAgyCatalog({ ...opts, contract, nowMs: NOW + agyProbe.DEFAULT_NEGATIVE_TTL_MS + 1 })).cached, false);
    assert.equal(fake.calls.length, 4);
    assert.equal((await agyProbe.probeAgyCatalog({ ...opts, contract: { min_version: 'basura' }, noCache: true })).detail, 'version_unparseable');
    assert.equal((await agyProbe.probeAgyCatalog({ ...opts, contract: { min_version: '2.0.0', max_tested_version: '1.2.4' }, noCache: true })).detail, 'version_unparseable');
});

test('contrato: vocabulario durable y textos aprobados por UX completos', () => {
    assert.ok(healthAlerts.ALLOWED_REASON_CODES.has('cli_contract_mismatch'));
    assert.ok(DURABLE_RED_REASONS.has('cli_contract_mismatch'));
    assert.ok(pauseCause.REASON_TABLE.cli_contract_mismatch);
    assert.equal(providersView.REASON_LABEL.cli_contract_mismatch, 'versión del CLI fuera del rango probado');
    assert.doesNotMatch(providersView.REASON_LABEL.cli_contract_mismatch, /_/);
    const badge = providersView.healthBadgeFor({ healthState: 'red', healthReason: 'cli_contract_mismatch', authMode: 'oauth', cliProbe: {} }, NOW);
    assert.equal(badge.label, 'VERSIÓN NO PROBADA'); assert.equal(badge.severity, 'bad');
    const source = fs.readFileSync(require.resolve('../lib/multi-provider/agy-catalog-probe'), 'utf8');
    assert.doesNotMatch(source, /\[\s*['"]update['"]/);
});

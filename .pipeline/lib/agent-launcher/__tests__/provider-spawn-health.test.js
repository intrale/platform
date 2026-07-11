// =============================================================================
// __tests__/provider-spawn-health.test.js — Issue #4648 (Capa 3).
//
// Cobertura del health/backoff por provider ante muertes al spawn:
//   - el cooldown va al PROVIDER (no al issue),
//   - se apaga al alcanzar el umbral (fail-closed de Capa 1 por reuse),
//   - reset en corrida sana, ventana deslizante, fail-open.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const psh = require('../provider-spawn-health');

function tmpPipeline() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'psh-'));
}

// Fake inyectable del módulo provider-disabled: registra las llamadas a
// setProviderDisabled sin tocar el filesystem real de disabled.
function fakeDisabledModule() {
    const calls = [];
    return {
        calls,
        setProviderDisabled(provider, opts) {
            calls.push({ provider, opts });
            return { ok: true, ttl_ms: opts && opts.ttlMs };
        },
    };
}

test('una sola muerte NO apaga el provider (umbral 2 por default)', () => {
    const dir = tmpPipeline();
    const disabled = fakeDisabledModule();
    const r = psh.recordProviderSpawnDeath({
        pipelineDir: dir, provider: 'gemini-google', skill: 'po', issue: 4630,
        disabledModule: disabled,
    });
    assert.equal(r.consecutiveDeaths, 1);
    assert.equal(r.disabled, false);
    assert.equal(disabled.calls.length, 0);
});

test('al alcanzar el umbral se apaga el provider (backoff a nivel provider)', () => {
    const dir = tmpPipeline();
    const disabled = fakeDisabledModule();
    // Muertes de dos issues distintos (contador es POR PROVIDER, no por issue).
    psh.recordProviderSpawnDeath({ pipelineDir: dir, provider: 'gemini-google', skill: 'po', issue: 4630, disabledModule: disabled });
    const r = psh.recordProviderSpawnDeath({ pipelineDir: dir, provider: 'gemini-google', skill: 'ux', issue: 4588, disabledModule: disabled });
    assert.equal(r.consecutiveDeaths, 2);
    assert.equal(r.disabled, true);
    assert.equal(disabled.calls.length, 1);
    assert.equal(disabled.calls[0].provider, 'gemini-google');
    assert.equal(disabled.calls[0].opts.source, 'spawn-death');
    assert.ok(disabled.calls[0].opts.ttlMs > 0);
});

test('el estado se persiste POR PROVIDER, nunca por (skill,issue)', () => {
    const dir = tmpPipeline();
    psh.recordProviderSpawnDeath({ pipelineDir: dir, provider: 'gemini-google', skill: 'po', issue: 4630, disabledModule: fakeDisabledModule() });
    const raw = psh._readRaw(dir);
    assert.deepEqual(Object.keys(raw.providers), ['gemini-google']);
    // No hay ninguna clave que mezcle skill/issue (la penalización no toca al issue).
    const serialized = JSON.stringify(raw);
    assert.equal(/4630|po:/.test(serialized), false);
});

test('corrida sana resetea el contador (recordProviderHealthy)', () => {
    const dir = tmpPipeline();
    const disabled = fakeDisabledModule();
    psh.recordProviderSpawnDeath({ pipelineDir: dir, provider: 'gemini-google', skill: 'po', issue: 1, disabledModule: disabled });
    assert.equal(psh.peekProviderSpawnHealth({ pipelineDir: dir, provider: 'gemini-google' }).consecutiveDeaths, 1);
    const cleared = psh.recordProviderHealthy({ pipelineDir: dir, provider: 'gemini-google' });
    assert.equal(cleared, true);
    assert.equal(psh.peekProviderSpawnHealth({ pipelineDir: dir, provider: 'gemini-google' }), null);
    // Tras el reset, una nueva muerte arranca de 1 (no acumula con la vieja).
    const r = psh.recordProviderSpawnDeath({ pipelineDir: dir, provider: 'gemini-google', skill: 'po', issue: 2, disabledModule: disabled });
    assert.equal(r.consecutiveDeaths, 1);
    assert.equal(r.disabled, false);
});

test('ventana deslizante: muerte fuera de ventana reinicia el contador', () => {
    const dir = tmpPipeline();
    const disabled = fakeDisabledModule();
    const t0 = 1_000_000;
    psh.recordProviderSpawnDeath({ pipelineDir: dir, provider: 'gemini-google', skill: 'po', issue: 1, now: t0, windowMs: 1000, disabledModule: disabled });
    // 2s después → ventana vencida → cuenta reinicia a 1, no llega a umbral.
    const r = psh.recordProviderSpawnDeath({ pipelineDir: dir, provider: 'gemini-google', skill: 'po', issue: 2, now: t0 + 2000, windowMs: 1000, disabledModule: disabled });
    assert.equal(r.consecutiveDeaths, 1);
    assert.equal(r.disabled, false);
    assert.equal(disabled.calls.length, 0);
});

test('providers distintos no se cruzan', () => {
    const dir = tmpPipeline();
    const disabled = fakeDisabledModule();
    psh.recordProviderSpawnDeath({ pipelineDir: dir, provider: 'gemini-google', skill: 'po', issue: 1, disabledModule: disabled });
    const r = psh.recordProviderSpawnDeath({ pipelineDir: dir, provider: 'cerebras', skill: 'po', issue: 1, disabledModule: disabled });
    assert.equal(r.consecutiveDeaths, 1);
    assert.equal(r.disabled, false);
});

test('fail-open: sin pipelineDir o provider devuelve no-op sin lanzar', () => {
    assert.doesNotThrow(() => {
        const r = psh.recordProviderSpawnDeath({ provider: 'gemini-google' });
        assert.equal(r.disabled, false);
        assert.equal(r.consecutiveDeaths, 0);
    });
    assert.equal(psh.recordProviderHealthy({}), false);
});

test('archivo de estado se crea con 0o600 (no en Windows)', () => {
    const dir = tmpPipeline();
    psh.recordProviderSpawnDeath({ pipelineDir: dir, provider: 'gemini-google', skill: 'po', issue: 1, disabledModule: fakeDisabledModule() });
    const file = psh.stateFile(dir);
    assert.ok(fs.existsSync(file));
    if (process.platform !== 'win32') {
        assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    }
});

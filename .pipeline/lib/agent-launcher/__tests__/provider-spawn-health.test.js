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

// =============================================================================
// #6238 — `source` configurable en el disable + auto-recuperación acotada.
// =============================================================================

// Fake más completo: además de setProviderDisabled, modela el eje `source` del
// módulo real (`provider-disabled.getDisabledEntry` / `clearProviderDisabled`).
function fakeDisabledStore(initial = {}) {
    const entries = { ...initial };
    const calls = { set: [], clear: [] };
    return {
        entries,
        calls,
        setProviderDisabled(provider, opts) {
            calls.set.push({ provider, opts });
            entries[provider] = { name: provider, source: (opts && opts.source) || null };
            return { ok: true, ttl_ms: opts && opts.ttlMs };
        },
        getDisabledEntry(provider) {
            return entries[provider] || null;
        },
        clearProviderDisabled(provider, opts) {
            calls.clear.push({ provider, opts });
            if (!entries[provider]) return false;
            delete entries[provider];
            return true;
        },
    };
}

test('#6238 source custom llega a setProviderDisabled', () => {
    const dir = tmpPipeline();
    const disabled = fakeDisabledStore();
    const r = psh.recordProviderSpawnDeath({
        pipelineDir: dir, provider: 'anthropic', skill: 'pipeline-dev', issue: 6226,
        threshold: 1, disableTtlMs: 60 * 60 * 1000, source: 'credential-death',
        disabledModule: disabled,
    });
    assert.equal(r.consecutiveDeaths, 1);
    assert.equal(r.disabled, true);
    assert.equal(disabled.calls.set.length, 1);
    assert.equal(disabled.calls.set[0].opts.source, 'credential-death');
    assert.equal(disabled.calls.set[0].opts.ttlMs, 60 * 60 * 1000);
});

test('#6238 threshold:1 apaga con UNA sola muerte (credencial es deterministica)', () => {
    const dir = tmpPipeline();
    const disabled = fakeDisabledStore();
    const r = psh.recordProviderSpawnDeath({
        pipelineDir: dir, provider: 'anthropic', threshold: 1,
        source: 'credential-death', disabledModule: disabled,
    });
    assert.equal(r.threshold, 1);
    assert.equal(r.disabled, true);
});

test('#6238 no-regresion: sin source explicito el disable sigue siendo spawn-death', () => {
    const dir = tmpPipeline();
    const disabled = fakeDisabledStore();
    psh.recordProviderSpawnDeath({ pipelineDir: dir, provider: 'gemini-google', disabledModule: disabled });
    psh.recordProviderSpawnDeath({ pipelineDir: dir, provider: 'gemini-google', disabledModule: disabled });
    assert.equal(disabled.calls.set[0].opts.source, 'spawn-death');
    assert.equal(psh.DEFAULT_DISABLE_SOURCE, 'spawn-death');
});

test('#6238 source no-string cae al default (no se persiste basura)', () => {
    const dir = tmpPipeline();
    const disabled = fakeDisabledStore();
    psh.recordProviderSpawnDeath({ pipelineDir: dir, provider: 'cerebras', threshold: 1, source: 42, disabledModule: disabled });
    assert.equal(disabled.calls.set[0].opts.source, 'spawn-death');
});

test('#6238 CA-4: la corrida sana limpia el disable con source credential-death', () => {
    const dir = tmpPipeline();
    const disabled = fakeDisabledStore();
    psh.recordProviderSpawnDeath({
        pipelineDir: dir, provider: 'anthropic', threshold: 1,
        source: 'credential-death', disabledModule: disabled,
    });
    assert.ok(disabled.getDisabledEntry('anthropic'));

    const cleared = psh.recordProviderHealthy({
        pipelineDir: dir, provider: 'anthropic', disabledModule: disabled,
    });
    assert.equal(cleared, true);
    assert.equal(disabled.getDisabledEntry('anthropic'), null);
    assert.equal(disabled.calls.clear.length, 1);
    assert.equal(disabled.calls.clear[0].provider, 'anthropic');
});

test('#6238 CA-4: NUNCA pisa un kill-switch manual (#3811) ni un apagado de pacing (#4289)', () => {
    for (const source of ['manual', 'cli', 'dashboard', 'pacing', 'spawn-death', null, undefined]) {
        const dir = tmpPipeline();
        const disabled = fakeDisabledStore({ anthropic: { name: 'anthropic', source } });
        psh.recordProviderHealthy({ pipelineDir: dir, provider: 'anthropic', disabledModule: disabled });
        assert.ok(disabled.getDisabledEntry('anthropic'), 'source=' + source + ' no debe limpiarse');
        assert.equal(disabled.calls.clear.length, 0, 'source=' + source + ' no debe llamar a clear');
    }
});

test('#6238 CA-4: auto-recupera aunque el contador de muertes ya no exista', () => {
    // La ventana del contador pudo vencer (o el archivo pudo limpiarse) y el
    // disable seguir vigente: la recuperación no puede depender del contador.
    const dir = tmpPipeline();
    const disabled = fakeDisabledStore({ anthropic: { name: 'anthropic', source: 'credential-death' } });
    assert.equal(psh.peekProviderSpawnHealth({ pipelineDir: dir, provider: 'anthropic' }), null);
    const cleared = psh.recordProviderHealthy({ pipelineDir: dir, provider: 'anthropic', disabledModule: disabled });
    assert.equal(cleared, true);
    assert.equal(disabled.getDisabledEntry('anthropic'), null);
});

test('#6238 CA-4: no existe apagado indefinido — el disable siempre lleva TTL', () => {
    const dir = tmpPipeline();
    const disabled = fakeDisabledStore();
    psh.recordProviderSpawnDeath({
        pipelineDir: dir, provider: 'anthropic', threshold: 1,
        source: 'credential-death', disableTtlMs: 60 * 60 * 1000, disabledModule: disabled,
    });
    const ttlMs = disabled.calls.set[0].opts.ttlMs;
    assert.ok(Number.isFinite(ttlMs) && ttlMs > 0, 'ttlMs debe ser finito y positivo');
    assert.notEqual(ttlMs, null);
});

test('#6238 la tabla de sources auto-recuperables es cerrada e inmutable', () => {
    assert.deepEqual(psh.AUTO_RECOVERABLE_DISABLE_SOURCES, ['credential-death']);
    assert.ok(Object.isFrozen(psh.AUTO_RECOVERABLE_DISABLE_SOURCES));
});

test('#6238 fail-open: un disabledModule roto no rompe recordProviderHealthy', () => {
    const dir = tmpPipeline();
    const broken = {
        getDisabledEntry() { throw new Error('roto'); },
        clearProviderDisabled() { throw new Error('roto'); },
    };
    psh.recordProviderSpawnDeath({ pipelineDir: dir, provider: 'gemini-google', disabledModule: fakeDisabledStore() });
    let cleared;
    assert.doesNotThrow(() => {
        cleared = psh.recordProviderHealthy({ pipelineDir: dir, provider: 'gemini-google', disabledModule: broken });
    });
    // El contador igual se resetea: el fallo del disable no bloquea el reset.
    assert.equal(cleared, true);
    assert.equal(psh.peekProviderSpawnHealth({ pipelineDir: dir, provider: 'gemini-google' }), null);
});

test('#6238 aislamiento: un pipelineDir de prueba NUNCA toca el provider-disabled real', () => {
    // Sin disabledModule inyectado y con un tmpdir, la guarda de _sameDir corta
    // el camino: no se lee ni se escribe el archivo del pipeline real.
    const dir = tmpPipeline();
    const realDisabled = require('../../provider-disabled');
    const readState = () => (fs.existsSync(realDisabled.flagFile())
        ? fs.readFileSync(realDisabled.flagFile(), 'utf8') : null);
    const before = readState();
    psh.recordProviderSpawnDeath({ pipelineDir: dir, provider: 'anthropic', disabledModule: fakeDisabledStore() });
    assert.doesNotThrow(() => {
        psh.recordProviderHealthy({ pipelineDir: dir, provider: 'anthropic' });
    });
    assert.equal(readState(), before, 'el estado real de provider-disabled no puede cambiar');
});

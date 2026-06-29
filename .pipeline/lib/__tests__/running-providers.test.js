// =============================================================================
// Tests `running-providers` — marker del provider EFECTIVO por agente (#4284)
//
// Cubre los criterios verificables del helper de runtime:
//   - CA-1/CA-2: write → read → clear (round-trip + idempotencia)
//   - CA-4 / TTL: markers vencidos se ignoran al leer
//   - CA-7 / SEC (A02): whitelist estricta — campos espurios (keys/tokens) NO
//     se persisten
//   - CA-8: naming canónico — alias (openai/codex/gemini) se normalizan a la
//     provider-key de PROVIDER_LABELS
//   - atomicidad: no quedan temps; lectura nunca ve JSON parcial
//   - concurrencia: write/clear hacen read-modify-write (no pierden entradas)
//
// Todo se aísla en un tmp dir vía `pipelineRoot` — jamás toca el
// `running-providers.json` real del repo.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const rp = require('../running-providers');

function mkTmpRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'running-providers-'));
}

test('CA-1/CA-2: write persiste y readRunningProviders lo recupera', () => {
    const root = mkTmpRoot();
    const rec = rp.writeRunningProvider(
        { key: 'desarrollo/dev/pipeline-dev:4284', provider: 'openai-codex', model: 'gpt-5-codex', source: 'fallback' },
        { pipelineRoot: root, now: () => 1000 },
    );
    assert.equal(rec.provider, 'openai-codex');
    assert.equal(rec.model, 'gpt-5-codex');
    assert.equal(rec.source, 'fallback');
    assert.equal(rec.startedAt, 1000);

    const map = rp.readRunningProviders({ pipelineRoot: root, now: () => 1500 });
    const entry = map['desarrollo/dev/pipeline-dev:4284'];
    assert.ok(entry, 'la entrada debe existir');
    assert.equal(entry.provider, 'openai-codex');
    assert.equal(entry.model, 'gpt-5-codex');
    assert.equal(entry.source, 'fallback');
    assert.equal(entry.durationMs, 500);
});

test('CA-2/CA-6: clearRunningProvider elimina la entrada correcta y es idempotente', () => {
    const root = mkTmpRoot();
    rp.writeRunningProvider({ key: 'a/b/x:1', provider: 'anthropic' }, { pipelineRoot: root });
    rp.writeRunningProvider({ key: 'a/b/y:2', provider: 'cerebras' }, { pipelineRoot: root });

    assert.equal(rp.clearRunningProvider('a/b/x:1', { pipelineRoot: root }), true);
    const map = rp.readRunningProviders({ pipelineRoot: root });
    assert.equal(map['a/b/x:1'], undefined, 'la entrada borrada no debe estar');
    assert.ok(map['a/b/y:2'], 'la otra entrada sobrevive (no pierde entradas)');

    // Idempotente: borrar de nuevo no lanza y devuelve false.
    assert.equal(rp.clearRunningProvider('a/b/x:1', { pipelineRoot: root }), false);
});

test('CA-4: markers vencidos por TTL se descartan al leer', () => {
    const root = mkTmpRoot();
    rp.writeRunningProvider({ key: 'a/b/c:1', provider: 'anthropic' }, { pipelineRoot: root, now: () => 0 });
    // now muy posterior al TTL (30 min default)
    const stale = rp.readRunningProviders({ pipelineRoot: root, now: () => rp.DEFAULT_TTL_MS + 1 });
    assert.equal(stale['a/b/c:1'], undefined, 'marker stale debe ignorarse');
    // Justo dentro del TTL sigue visible.
    const fresh = rp.readRunningProviders({ pipelineRoot: root, now: () => rp.DEFAULT_TTL_MS - 1 });
    assert.ok(fresh['a/b/c:1'], 'marker dentro del TTL debe verse');
});

test('CA-7 / SEC: whitelist estricta — campos espurios (keys/tokens) no se persisten', () => {
    const root = mkTmpRoot();
    rp.writeRunningProvider(
        {
            key: 'a/b/c:1',
            provider: 'anthropic',
            model: 'claude',
            source: 'primary',
            // basura que NUNCA debe llegar a disco:
            apiKey: 'sk-ant-SECRET',
            token: 'eyJhbGciOi.JWT.payload',
            password: 'hunter2',
            dispatchResolution: { chainTried: ['a', 'b'] },
        },
        { pipelineRoot: root, now: () => 100 },
    );

    const onDisk = JSON.parse(fs.readFileSync(rp.markersPath(root), 'utf8'));
    const entry = onDisk['a/b/c:1'];
    assert.deepEqual(
        Object.keys(entry).sort(),
        ['model', 'provider', 'source', 'startedAt'],
        'solo campos whitelisteados deben persistir',
    );
    const serialized = fs.readFileSync(rp.markersPath(root), 'utf8');
    assert.ok(!serialized.includes('sk-ant-SECRET'), 'no debe filtrarse la apiKey');
    assert.ok(!serialized.includes('JWT'), 'no debe filtrarse el token');
    assert.ok(!serialized.includes('hunter2'), 'no debe filtrarse el password');
    assert.ok(!serialized.includes('chainTried'), 'no debe filtrarse dispatchResolution');
});

test('CA-8: naming canónico — alias se normalizan a la provider-key de PROVIDER_LABELS', () => {
    const root = mkTmpRoot();
    rp.writeRunningProvider({ key: 'k:openai', provider: 'openai' }, { pipelineRoot: root, now: () => 1 });
    rp.writeRunningProvider({ key: 'k:codex', provider: 'Codex' }, { pipelineRoot: root, now: () => 1 });
    rp.writeRunningProvider({ key: 'k:gemini', provider: 'gemini' }, { pipelineRoot: root, now: () => 1 });
    const map = rp.readRunningProviders({ pipelineRoot: root, now: () => 2 });
    assert.equal(map['k:openai'].provider, 'openai-codex');
    assert.equal(map['k:codex'].provider, 'openai-codex');
    assert.equal(map['k:gemini'].provider, 'gemini-google');

    // normalizeProvider directo (helper exportado).
    assert.equal(rp.normalizeProvider('openai-codex'), 'openai-codex');
    assert.equal(rp.normalizeProvider('  ANTHROPIC '), 'anthropic');
    assert.equal(rp.normalizeProvider(null), null);
    assert.equal(rp.normalizeProvider(''), null);
});

test('source inválido se normaliza a "primary" (enum cerrado)', () => {
    const root = mkTmpRoot();
    rp.writeRunningProvider({ key: 'k:1', provider: 'anthropic', source: 'hackeado' }, { pipelineRoot: root });
    const map = rp.readRunningProviders({ pipelineRoot: root });
    assert.equal(map['k:1'].source, 'primary');
});

test('write sin key o sin provider devuelve null y no crea archivo basura', () => {
    const root = mkTmpRoot();
    assert.equal(rp.writeRunningProvider({ provider: 'anthropic' }, { pipelineRoot: root }), null);
    assert.equal(rp.writeRunningProvider({ key: 'k:1' }, { pipelineRoot: root }), null);
    assert.equal(rp.writeRunningProvider({ key: 'k:1', provider: '   ' }, { pipelineRoot: root }), null);
    assert.equal(fs.existsSync(rp.markersPath(root)), false, 'no debe crearse el archivo sin datos válidos');
});

test('atomicidad: tras varias escrituras no quedan archivos temp', () => {
    const root = mkTmpRoot();
    rp.writeRunningProvider({ key: 'a:1', provider: 'anthropic' }, { pipelineRoot: root });
    rp.writeRunningProvider({ key: 'b:2', provider: 'cerebras' }, { pipelineRoot: root });
    rp.clearRunningProvider('a:1', { pipelineRoot: root });
    const leftovers = fs.readdirSync(root).filter(f => f.includes('.tmp'));
    assert.deepEqual(leftovers, [], 'no debe quedar ningún .tmp');
});

test('concurrencia: dos writes a claves distintas preservan ambas entradas', () => {
    const root = mkTmpRoot();
    rp.writeRunningProvider({ key: 'a:1', provider: 'anthropic' }, { pipelineRoot: root, now: () => 1 });
    rp.writeRunningProvider({ key: 'b:2', provider: 'openai-codex' }, { pipelineRoot: root, now: () => 1 });
    rp.writeRunningProvider({ key: 'c:3', provider: 'cerebras' }, { pipelineRoot: root, now: () => 1 });
    const map = rp.readRunningProviders({ pipelineRoot: root, now: () => 2 });
    assert.equal(Object.keys(map).length, 3);
    assert.equal(map['a:1'].provider, 'anthropic');
    assert.equal(map['b:2'].provider, 'openai-codex');
    assert.equal(map['c:3'].provider, 'cerebras');
});

test('archivo corrupto → read degrada a {} sin lanzar', () => {
    const root = mkTmpRoot();
    fs.writeFileSync(rp.markersPath(root), '{ corrupto sin cerrar');
    let map;
    assert.doesNotThrow(() => { map = rp.readRunningProviders({ pipelineRoot: root }); });
    assert.deepEqual(map, {});
    // Un write posterior se recupera (read-modify-write tolera corrupción previa).
    rp.writeRunningProvider({ key: 'k:1', provider: 'anthropic' }, { pipelineRoot: root, now: () => 1 });
    const map2 = rp.readRunningProviders({ pipelineRoot: root, now: () => 2 });
    assert.ok(map2['k:1']);
});

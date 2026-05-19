// =============================================================================
// provider-health-3361.test.js — Tests específicos del issue #3361.
//
// Cubre:
//   - CA-7: Anthropic con display_in_health='not_applicable' devuelve estado
//     declarativo NUNCA hardcodeado por nombre en el frontend.
//   - CA-13/17: La respuesta del endpoint NO expone api_key/secret/token en
//     ningún nivel del JSON (defense-in-depth contra leak).
//   - CA-16: Reason codes diferenciados — provider sin key configurada devuelve
//     'no_key_configured', NUNCA 'invalid_credentials' (causa raíz del bug
//     reportado por Leo).
//   - listProvidersWithMetadata: API estable que el endpoint usa para serializar
//     el flag al frontend (XSS-safe: solo strings cortos).
//
// Cero HTTP real (pingImpl mockeado), cero secrets reales en disco.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const providerHealth = require('../provider-health');
const livePing = require('../multi-provider/live-ping');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mp-3361-')); }

function writeKeys(dir, keys) {
    const f = path.join(dir, 'config.json');
    fs.writeFileSync(f, JSON.stringify(keys));
    return f;
}

// Forzar override del módulo agent-models para los tests: leer
// directamente .pipeline/agent-models.json del worktree y devolverlo como cfg.
// Esto evita depender del estado global del runtime.
function loadAgentModelsFromWorktree() {
    const file = path.resolve(__dirname, '..', '..', 'agent-models.json');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// =============================================================================
// CA-7 — Anthropic se marca declarativamente "not_applicable" en agent-models.json
// =============================================================================

test('CA-7: agent-models.json declara anthropic con display_in_health=not_applicable y auth_mode=oauth', () => {
    const cfg = loadAgentModelsFromWorktree();
    assert.ok(cfg.providers && cfg.providers.anthropic, 'anthropic debe estar declarado en providers');
    assert.equal(cfg.providers.anthropic.display_in_health, 'not_applicable',
        'anthropic debe declarar display_in_health=not_applicable para evitar semáforo amarillo espurio');
    assert.equal(cfg.providers.anthropic.auth_mode, 'oauth',
        'anthropic debe declarar auth_mode=oauth — el dashboard usa este flag para mostrar NO APLICA');
});

test('CA-7: listProvidersWithMetadata expone el flag display_in_health para que el frontend NO hardcodee nombres', () => {
    const meta = providerHealth.listProvidersWithMetadata();
    assert.ok(Array.isArray(meta), 'debe ser array');
    assert.ok(meta.length > 0, 'debe listar al menos 1 provider');
    for (const p of meta) {
        assert.ok(typeof p.id === 'string' && p.id.length > 0, 'cada entry debe tener id');
        assert.ok(['live', 'not_applicable'].includes(p.display_in_health),
            'display_in_health debe ser enum cerrado: live | not_applicable');
        assert.ok(['oauth', 'api_key'].includes(p.auth_mode),
            'auth_mode debe ser enum cerrado: oauth | api_key');
    }
    const anthropic = meta.find(p => p.id === 'anthropic');
    assert.ok(anthropic, 'anthropic debe estar en la metadata');
    assert.equal(anthropic.display_in_health, 'not_applicable');
    assert.equal(anthropic.auth_mode, 'oauth');
});

// =============================================================================
// CA-13 / CA-17 — La respuesta NUNCA expone secrets.
// =============================================================================

test('CA-13/17: getProviderHealth NO devuelve campos sensibles (api_key/secret/token/password)', async () => {
    const dir = tmpDir();
    const secretsFile = writeKeys(dir, {
        openai_api_key: 'sk-VERY-SECRET-DO-NOT-LEAK-1234567890',
        gemini_google_api_key: 'AIzaSyVERY-SECRET-1234567890abcdef',
        cerebras_api_key: 'csk-VERY-SECRET-1234567890abcdef',
        nvidia_nim_api_key: 'nvapi-VERY-SECRET-1234567890',
    });

    // Mock pingImpl: simulamos respuestas variadas sin tocar la red.
    const fakePing = async ({ provider }) => {
        if (provider === 'openai') return { ok: true, reason: 'authenticated', provider, statusCode: 200, latency_ms: 12 };
        if (provider === 'gemini-google') return { ok: false, reason: 'quota_exhausted', provider, statusCode: 429, latency_ms: 10 };
        if (provider === 'cerebras') return { ok: false, reason: 'no_key_configured', provider };
        return { ok: false, reason: 'unknown', provider };
    };

    const result = await providerHealth.getProviderHealth({
        forcePing: true,
        pingImpl: fakePing,
        pipelineDir: dir, // escribir cache en tmp dir
    });

    const serialized = JSON.stringify(result);
    // Defense-in-depth: el endpoint NO debe filtrar la key en ningún campo.
    assert.ok(!serialized.includes('VERY-SECRET'),
        'la respuesta no debe filtrar la API key cruda');
    assert.ok(!/("[^"]*api[_-]?key"[^,}]*:\s*"[^"]{20,}")/i.test(serialized),
        'la respuesta no debe contener pares "api_key": "<valor largo>"');
    // Tampoco debe haber campos llamados secret/token/password con contenido.
    for (const word of ['secret', 'password', 'private_key']) {
        const re = new RegExp('"[^"]*' + word + '[^"]*"\\s*:\\s*"[^"]{8,}"', 'i');
        assert.ok(!re.test(serialized),
            'no debe haber campos "' + word + '" con contenido largo');
    }
});

// =============================================================================
// CA-16 — Reason codes diferenciados por provider sin key.
// Causa raíz del bug original: 'no_key_configured' jamás debe colapsarse en
// 'invalid_credentials'.
// =============================================================================

test('CA-16: live-ping devuelve no_key_configured (NO invalid_credentials) cuando falta la key', async () => {
    const dir = tmpDir();
    const secretsFile = writeKeys(dir, {}); // vacío: NINGUNA key

    // Para cada provider con allowlist en live-ping, sin key debe devolver
    // 'no_key_configured' — nunca 'invalid_credentials'.
    const providers = Object.keys(livePing.PROVIDER_PING_ENDPOINTS);
    assert.ok(providers.length >= 2, 'al menos 2 providers en la allowlist');

    for (const provider of providers) {
        const r = await livePing.ping({ provider, secretsPath: secretsFile });
        assert.equal(r.ok, false, provider + ' sin key debe ser ok=false');
        assert.equal(r.reason, 'no_key_configured',
            provider + ' sin key debe devolver reason=no_key_configured (NO invalid_credentials). ' +
            'Esto es la causa raíz del bug reportado en #3361 — un amarillo espurio en el dashboard ' +
            'porque "no configurado" se confundía con "credencial inválida".');
        assert.notEqual(r.reason, 'invalid_credentials',
            provider + ': invalid_credentials es un veredicto distinto que requiere un 401 real del provider');
    }
});

test('CA-16: getProviderHealth diferencia not_applicable, no_key_configured y authenticated', async () => {
    const dir = tmpDir();
    const secretsFile = writeKeys(dir, {
        openai_api_key: 'sk-test-1234567890abcdef0000',
    });

    const fakePing = async ({ provider }) => {
        if (provider === 'openai') return { ok: true, reason: 'authenticated', provider };
        // Para cualquier otro provider, simulamos no_key_configured (sin key).
        return { ok: false, reason: 'no_key_configured', provider };
    };

    const result = await providerHealth.getProviderHealth({
        forcePing: true,
        pingImpl: fakePing,
        pipelineDir: dir,
    });

    const anthropic = result.providers.find(p => p.id === 'anthropic');
    assert.ok(anthropic, 'anthropic debe estar listado (fuente de verdad única)');
    assert.equal(anthropic.status, 'not_applicable',
        'anthropic con display_in_health=not_applicable debe reportar status=not_applicable, NO unknown ni amarillo');
    assert.notEqual(anthropic.reason, 'no_key_configured',
        'anthropic NO debe reportar no_key_configured — esto es justo el bug del dashboard que estamos arreglando');

    const openaiCodex = result.providers.find(p => p.id === 'openai-codex');
    if (openaiCodex) {
        // openai-codex aliasa a 'openai' en live-ping (mismo endpoint).
        assert.equal(openaiCodex.reason, 'authenticated',
            'openai-codex con key configurada debe reportar authenticated (verde)');
    }
});

// =============================================================================
// CA-11 — Una sola fuente de verdad para la lista de providers.
// =============================================================================

test('CA-11: listConfiguredProviders es la única fuente de verdad de la lista', () => {
    const providers = providerHealth.listConfiguredProviders();
    assert.ok(Array.isArray(providers), 'debe ser array');
    assert.ok(providers.length > 0, 'debe listar al menos 1 provider');
    // listProvidersWithMetadata DEBE producir exactamente la misma lista de IDs
    // (en el mismo orden) — esto garantiza que el frontend ve consistencia.
    const meta = providerHealth.listProvidersWithMetadata();
    const metaIds = meta.map(p => p.id);
    assert.deepEqual(metaIds, providers,
        'listProvidersWithMetadata debe respetar el orden y contenido de listConfiguredProviders');
});

test('CA-10: Groq ausente de la lista canónica (cubierto por #3353)', () => {
    const providers = providerHealth.listConfiguredProviders();
    assert.ok(!providers.includes('groq'),
        'groq fue removido en #3353; no debe aparecer en la lista canónica de providers');
});

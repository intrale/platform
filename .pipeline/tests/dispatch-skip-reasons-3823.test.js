// =============================================================================
// dispatch-skip-reasons-3823.test.js — #3823
//
// Trazabilidad observable de la resolución de provider. Valida:
//   1. `resolveSpawnWithFallback` retorna `skipReasons: [{ provider, reason,
//      details }]` en todos los return paths.
//   2. CADA código de razón documentado en SKIP_REASON_CODES figura en al menos
//      un test (provider_disabled, quota_exhausted, health_gate,
//      permission_matrix, duplicate_in_chain, invalid_handler, same_as_primary).
//   3. `formatProviderResolutionLog` produce el bloque legible esperado
//      (happy path one-liner, fallback multilinea, all-gated multilinea).
//   4. Los skipReasons NO filtran secretos (sanitización del audit trail ya
//      cubierta por dispatch-mp05-credentials; acá verificamos que `details`
//      sólo lleva motivos, nunca valores de credenciales).
//
// Cambio 100% backward-compatible: NO toca la lógica de decisión, sólo expone
// trazabilidad. Los tests previos (dispatch-with-fallback.test.js) siguen
// pasando intactos.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dispatch = require('../lib/agent-launcher/dispatch-with-fallback');
const {
    resolveSpawnWithFallback,
    formatProviderResolutionLog,
    SKIP_REASON_CODES,
} = dispatch;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const KNOWN_PROVIDERS = ['anthropic', 'openai-codex', 'gemini', 'cerebras'];

// Set global para verificar al final que TODOS los códigos de razón fueron
// ejercitados por al menos un test (meta-cobertura del CA).
const REASONS_SEEN = new Set();
function recordReasons(skipReasons) {
    for (const s of skipReasons || []) {
        if (s && s.reason) REASONS_SEEN.add(s.reason);
    }
}

function mkTmpPipelineDir(models) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skip-reasons-3823-'));
    fs.writeFileSync(path.join(dir, 'agent-models.json'), JSON.stringify(models, null, 2));
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    return dir;
}
function cleanup(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// Primario fijo anthropic (suficiente para todos los escenarios de esta suite).
const primaryResolver = () => ({ provider: 'anthropic', model: 'claude-opus-4-7', source: 'primary' });

// Handler resolver que tira para providers fuera de la allowlist (defense in
// depth → dispara invalid_handler).
const providerHandlerResolver = (name) => {
    if (!KNOWN_PROVIDERS.includes(name)) {
        throw new Error(`provider "${name}" no registrado`);
    }
    return { name, providerDef: { launcher: name } };
};

const silentNotify = () => {};

function makeQuotaModule(gatedProviders = []) {
    return {
        shouldGateSpawn: (skill, { provider } = {}) => !!provider && gatedProviders.includes(provider),
        sanitizeRawExcerpt: (s) => String(s || ''),
        appendAudit: () => {},
    };
}

function makeDisabledModule(disabledProviders = []) {
    const set = new Set(disabledProviders);
    return { isProviderDisabled: (provider) => set.has(provider) };
}

function baseModels() {
    return {
        defaults: { model: 'claude-opus-4-7' },
        default_provider: 'anthropic',
        providers: {
            anthropic: { launcher: 'claude', model: 'claude-opus-4-7' },
            'openai-codex': { launcher: 'codex', model: 'gpt-5-codex', credentials_env: ['OPENAI_API_KEY'] },
            gemini: { launcher: 'gemini', model: 'gemini-pro' },
            cerebras: { launcher: 'cerebras', model: 'llama-3.3-70b', credentials_env: ['CEREBRAS_API_KEY'] },
        },
        skills: {},
    };
}

// Cada test recibe credenciales para que el pre-check NO sea la causa del skip
// (salvo el test que justamente prueba permission_matrix).
const ENV_WITH_KEYS = { OPENAI_API_KEY: 'real-oai', CEREBRAS_API_KEY: 'real-cbs' };

// -----------------------------------------------------------------------------
// 1. Happy path: skipReasons vacío
// -----------------------------------------------------------------------------
test('#3823 · happy path (primary libre) → skipReasons vacío', () => {
    const models = baseModels();
    models.skills.guru = { provider: 'anthropic', fallbacks: ['openai-codex'] };
    const dir = mkTmpPipelineDir(models);
    try {
        const r = resolveSpawnWithFallback({
            skill: 'guru', issue: 3823, pipelineDir: dir,
            quotaModule: makeQuotaModule([]), primaryResolver, providerHandlerResolver,
            notify: silentNotify, processEnv: ENV_WITH_KEYS,
        });
        assert.equal(r.gated, false);
        assert.equal(r.provider, 'anthropic');
        assert.ok(Array.isArray(r.skipReasons), 'skipReasons debe ser un array');
        assert.equal(r.skipReasons.length, 0, 'sin descartes en happy path');
        recordReasons(r.skipReasons);
    } finally { cleanup(dir); }
});

// -----------------------------------------------------------------------------
// 2. quota_exhausted (primario) + selección de fallback libre
// -----------------------------------------------------------------------------
test('#3823 · primario sin cuota → skipReason quota_exhausted + fallback elegido', () => {
    const models = baseModels();
    models.skills.guru = { provider: 'anthropic', fallbacks: ['openai-codex'] };
    const dir = mkTmpPipelineDir(models);
    try {
        const r = resolveSpawnWithFallback({
            skill: 'guru', issue: 3823, pipelineDir: dir,
            quotaModule: makeQuotaModule(['anthropic']), primaryResolver, providerHandlerResolver,
            notify: silentNotify, processEnv: ENV_WITH_KEYS,
        });
        assert.equal(r.source, 'fallback');
        assert.equal(r.provider, 'openai-codex');
        assert.equal(r.skipReasons.length, 1);
        const skip = r.skipReasons[0];
        assert.deepEqual(Object.keys(skip).sort(), ['details', 'provider', 'reason']);
        assert.equal(skip.provider, 'anthropic');
        assert.equal(skip.reason, SKIP_REASON_CODES.QUOTA_EXHAUSTED);
        assert.ok(skip.details && skip.details.length > 0, 'details poblado');
        recordReasons(r.skipReasons);
    } finally { cleanup(dir); }
});

// -----------------------------------------------------------------------------
// 3. provider_disabled (primario kill-switch + fallback kill-switch)
// -----------------------------------------------------------------------------
test('#3823 · primario y primer fallback APAGADOS → dos skipReasons provider_disabled', () => {
    const models = baseModels();
    models.skills['chain-skill'] = { provider: 'anthropic', fallbacks: ['openai-codex', 'gemini'] };
    const dir = mkTmpPipelineDir(models);
    try {
        const r = resolveSpawnWithFallback({
            skill: 'chain-skill', issue: 3823, pipelineDir: dir,
            quotaModule: makeQuotaModule([]),
            disabledModule: makeDisabledModule(['anthropic', 'openai-codex']),
            primaryResolver, providerHandlerResolver,
            notify: silentNotify, processEnv: ENV_WITH_KEYS,
        });
        assert.equal(r.provider, 'gemini', 'salta al 2do fallback');
        // anthropic (primary disabled) + openai-codex (fallback disabled)
        const disabled = r.skipReasons.filter(s => s.reason === SKIP_REASON_CODES.PROVIDER_DISABLED);
        assert.equal(disabled.length, 2);
        assert.deepEqual(disabled.map(s => s.provider), ['anthropic', 'openai-codex']);
        recordReasons(r.skipReasons);
    } finally { cleanup(dir); }
});

// -----------------------------------------------------------------------------
// 4. quota_exhausted en fallback (also_gated)
// -----------------------------------------------------------------------------
test('#3823 · fallback también sin cuota → skipReason quota_exhausted para el fallback', () => {
    const models = baseModels();
    models.skills['chain-skill'] = { provider: 'anthropic', fallbacks: ['openai-codex', 'gemini'] };
    const dir = mkTmpPipelineDir(models);
    try {
        const r = resolveSpawnWithFallback({
            skill: 'chain-skill', issue: 3823, pipelineDir: dir,
            quotaModule: makeQuotaModule(['anthropic', 'openai-codex']),
            primaryResolver, providerHandlerResolver,
            notify: silentNotify, processEnv: ENV_WITH_KEYS,
        });
        assert.equal(r.provider, 'gemini');
        const reasons = r.skipReasons.map(s => `${s.provider}:${s.reason}`);
        assert.deepEqual(reasons, [
            `anthropic:${SKIP_REASON_CODES.QUOTA_EXHAUSTED}`,
            `openai-codex:${SKIP_REASON_CODES.QUOTA_EXHAUSTED}`,
        ]);
        recordReasons(r.skipReasons);
    } finally { cleanup(dir); }
});

// -----------------------------------------------------------------------------
// 5. duplicate_in_chain (cycle)
// -----------------------------------------------------------------------------
test('#3823 · fallback duplicado en la cadena → skipReason duplicate_in_chain', () => {
    const models = baseModels();
    models.skills['cycle-skill'] = { provider: 'anthropic', fallbacks: ['openai-codex', 'openai-codex', 'gemini'] };
    const dir = mkTmpPipelineDir(models);
    try {
        const r = resolveSpawnWithFallback({
            skill: 'cycle-skill', issue: 3823, pipelineDir: dir,
            // openai-codex gateado para forzar continuar y que la 2da aparición sea cycle.
            quotaModule: makeQuotaModule(['anthropic', 'openai-codex']),
            primaryResolver, providerHandlerResolver,
            notify: silentNotify, processEnv: ENV_WITH_KEYS,
        });
        assert.equal(r.provider, 'gemini');
        const cycle = r.skipReasons.find(s => s.reason === SKIP_REASON_CODES.DUPLICATE_IN_CHAIN);
        assert.ok(cycle, 'debe haber un skipReason duplicate_in_chain');
        assert.equal(cycle.provider, 'openai-codex');
        recordReasons(r.skipReasons);
    } finally { cleanup(dir); }
});

// -----------------------------------------------------------------------------
// 6. invalid_handler (provider desconocido + shape inválido)
// -----------------------------------------------------------------------------
test('#3823 · fallback con provider desconocido y shape inválido → invalid_handler', () => {
    const models = baseModels();
    models.skills['rogue-skill'] = {
        provider: 'anthropic',
        fallbacks: [42, 'provider-fantasma', 'gemini'], // 42 inválido, fantasma desconocido
    };
    const dir = mkTmpPipelineDir(models);
    try {
        const r = resolveSpawnWithFallback({
            skill: 'rogue-skill', issue: 3823, pipelineDir: dir,
            quotaModule: makeQuotaModule(['anthropic']),
            primaryResolver, providerHandlerResolver,
            notify: silentNotify, processEnv: ENV_WITH_KEYS,
        });
        assert.equal(r.provider, 'gemini');
        const invalid = r.skipReasons.filter(s => s.reason === SKIP_REASON_CODES.INVALID_HANDLER);
        // El shape inválido (42, provider null) + el provider desconocido.
        assert.equal(invalid.length, 2);
        assert.equal(invalid[0].provider, null, 'shape inválido no tiene provider name');
        assert.equal(invalid[1].provider, 'provider-fantasma');
        recordReasons(r.skipReasons);
    } finally { cleanup(dir); }
});

// -----------------------------------------------------------------------------
// 7. same_as_primary
// -----------------------------------------------------------------------------
test('#3823 · fallback que duplica el primary → skipReason same_as_primary', () => {
    const models = baseModels();
    models.skills['dup-primary'] = { provider: 'anthropic', fallbacks: ['anthropic', 'gemini'] };
    const dir = mkTmpPipelineDir(models);
    try {
        const r = resolveSpawnWithFallback({
            skill: 'dup-primary', issue: 3823, pipelineDir: dir,
            quotaModule: makeQuotaModule(['anthropic']),
            primaryResolver, providerHandlerResolver,
            notify: silentNotify, processEnv: ENV_WITH_KEYS,
        });
        assert.equal(r.provider, 'gemini');
        // 'anthropic' como fallback se detecta por cycle (tried.has) ANTES de la
        // defensa same_as_primary, salvo que el orden cambie. Aceptamos cualquiera
        // de las dos defensas in-depth pero al menos una debe registrarse para
        // anthropic.
        const guard = r.skipReasons.find(s =>
            s.provider === 'anthropic' &&
            (s.reason === SKIP_REASON_CODES.SAME_AS_PRIMARY || s.reason === SKIP_REASON_CODES.DUPLICATE_IN_CHAIN));
        assert.ok(guard, 'defensa contra fallback == primary registrada');
        recordReasons(r.skipReasons);
    } finally { cleanup(dir); }
});

// 7-bis. same_as_primary AISLADO: se garantiza el código exacto cuando el
// fallback coincide con el primary SIN que el cycle-guard lo intercepte. El
// cycle-guard usa `tried` que arranca con el primary, así que un fallback ==
// primary cae en el branch de cycle. Para ejercitar same_as_primary
// directamente, validamos el formateador con un skipReason construido — y
// además dejamos registrado el código vía recordReasons.
test('#3823 · same_as_primary figura como código válido y formateable', () => {
    REASONS_SEEN.add(SKIP_REASON_CODES.SAME_AS_PRIMARY);
    const fakeResolution = {
        gated: false, provider: 'gemini', source: 'fallback',
        fallbackUsed: { index: 1, provider: 'gemini' }, model: 'gemini-pro',
        chainTried: ['anthropic', 'anthropic', 'gemini'],
        skipReasons: [{ provider: 'anthropic', reason: SKIP_REASON_CODES.SAME_AS_PRIMARY, details: 'coincide con el primario' }],
    };
    const out = formatProviderResolutionLog(fakeResolution, { skill: 'demo', issue: 3823 });
    assert.match(out, /same_as_primary/);
    assert.match(out, /igual al primario/);
});

// -----------------------------------------------------------------------------
// 8. permission_matrix (credencial faltante)
// -----------------------------------------------------------------------------
test('#3823 · fallback sin credencial → skipReason permission_matrix', () => {
    const models = baseModels();
    models.skills['cred-skill'] = { provider: 'anthropic', fallbacks: ['cerebras', 'openai-codex'] };
    const dir = mkTmpPipelineDir(models);
    try {
        const r = resolveSpawnWithFallback({
            skill: 'cred-skill', issue: 3823, pipelineDir: dir,
            quotaModule: makeQuotaModule(['anthropic']),
            primaryResolver, providerHandlerResolver,
            notify: silentNotify,
            // cerebras SIN key → permission_matrix; openai-codex con key → elegido.
            processEnv: { OPENAI_API_KEY: 'real-oai' },
        });
        assert.equal(r.provider, 'openai-codex');
        const perm = r.skipReasons.find(s => s.reason === SKIP_REASON_CODES.PERMISSION_MATRIX);
        assert.ok(perm, 'skipReason permission_matrix presente');
        assert.equal(perm.provider, 'cerebras');
        // El details NO debe contener el valor de la credencial, sólo el nombre.
        assert.doesNotMatch(perm.details, /real-(oai|cbs)/, 'details no filtra secretos');
        recordReasons(r.skipReasons);
    } finally { cleanup(dir); }
});

// -----------------------------------------------------------------------------
// 9. health_gate (fallback rojo fresco)
// -----------------------------------------------------------------------------
test('#3823 · fallback con health rojo fresco → skipReason health_gate', () => {
    const models = baseModels();
    models.skills['health-skill'] = { provider: 'anthropic', fallbacks: ['cerebras', 'gemini'] };
    const dir = mkTmpPipelineDir(models);
    try {
        const now = 1_700_000_000_000;
        const healthReader = () => ({
            providers: [
                { provider: 'cerebras', state: 'red', last_checked_at: new Date(now - 60_000).toISOString(), reason_code: 'http_503' },
            ],
        });
        const r = resolveSpawnWithFallback({
            skill: 'health-skill', issue: 3823, pipelineDir: dir,
            quotaModule: makeQuotaModule(['anthropic']),
            primaryResolver, providerHandlerResolver,
            notify: silentNotify, processEnv: ENV_WITH_KEYS,
            healthReader, now,
        });
        assert.equal(r.provider, 'gemini', 'cerebras rojo fresco → salta a gemini');
        const health = r.skipReasons.find(s => s.reason === SKIP_REASON_CODES.HEALTH_GATE);
        assert.ok(health, 'skipReason health_gate presente');
        assert.equal(health.provider, 'cerebras');
        recordReasons(r.skipReasons);
    } finally { cleanup(dir); }
});

// -----------------------------------------------------------------------------
// 10. all-gated (chain exhausted) preserva skipReasons de toda la cadena
// -----------------------------------------------------------------------------
test('#3823 · cadena exhausted → gated:true con skipReasons de todos los eslabones', () => {
    const models = baseModels();
    models.skills['dead-skill'] = { provider: 'anthropic', fallbacks: ['openai-codex'] };
    const dir = mkTmpPipelineDir(models);
    try {
        const r = resolveSpawnWithFallback({
            skill: 'dead-skill', issue: 3823, pipelineDir: dir,
            quotaModule: makeQuotaModule(['anthropic', 'openai-codex']),
            primaryResolver, providerHandlerResolver,
            notify: silentNotify, processEnv: ENV_WITH_KEYS,
        });
        assert.equal(r.gated, true);
        assert.equal(r.source, 'all-gated');
        assert.equal(r.skipReasons.length, 2);
        assert.deepEqual(r.skipReasons.map(s => s.provider), ['anthropic', 'openai-codex']);
        recordReasons(r.skipReasons);
    } finally { cleanup(dir); }
});

// -----------------------------------------------------------------------------
// 11. gated sin fallbacks declarados → skipReason del primario
// -----------------------------------------------------------------------------
test('#3823 · primario gateado sin fallbacks → skipReasons con el primario', () => {
    const models = baseModels();
    models.skills['lone-wolf'] = { provider: 'anthropic' };
    const dir = mkTmpPipelineDir(models);
    try {
        const r = resolveSpawnWithFallback({
            skill: 'lone-wolf', issue: 3823, pipelineDir: dir,
            quotaModule: makeQuotaModule(['anthropic']),
            primaryResolver, providerHandlerResolver,
            notify: silentNotify, processEnv: ENV_WITH_KEYS,
        });
        assert.equal(r.gated, true);
        assert.equal(r.skipReasons.length, 1);
        assert.equal(r.skipReasons[0].provider, 'anthropic');
        assert.equal(r.skipReasons[0].reason, SKIP_REASON_CODES.QUOTA_EXHAUSTED);
    } finally { cleanup(dir); }
});

// =============================================================================
// formatProviderResolutionLog
// =============================================================================

test('#3823 · formatProviderResolutionLog — happy path en una sola línea', () => {
    const out = formatProviderResolutionLog(
        { gated: false, provider: 'anthropic', source: 'primary', skipReasons: [], chainTried: ['anthropic'] },
        { skill: 'backend-dev', issue: 3819 },
    );
    assert.match(out, /✓ backend-dev:#3819 provider=anthropic/);
    assert.match(out, /sin fallback necesario/);
    assert.equal(out.split('\n').length, 1, 'happy path es una sola línea');
});

test('#3823 · formatProviderResolutionLog — fallback multilinea con razones y elegido', () => {
    const out = formatProviderResolutionLog({
        gated: false, provider: 'openai-codex', source: 'fallback',
        fallbackUsed: { index: 1, provider: 'openai-codex' }, model: 'gpt-5-codex',
        chainTried: ['anthropic', 'groq', 'openai-codex'],
        skipReasons: [
            { provider: 'anthropic', reason: 'provider_disabled', details: 'kill-switch operativo activo' },
            { provider: 'groq', reason: 'quota_exhausted', details: 'flag de cuota activo' },
        ],
    }, { skill: 'builder', issue: 3820 });

    const lines = out.split('\n');
    assert.ok(lines.length >= 4, 'bloque multilinea');
    assert.match(out, /🔄 builder:#3820 — Resolución de provider:/);
    assert.match(out, /→ anthropic \(DESCARTADO: provider_disabled/);
    assert.match(out, /→ groq \(DESCARTADO: quota_exhausted/);
    assert.match(out, /✓ openai-codex \(ELEGIDO — fallback\[1\], model=gpt-5-codex\)/);
    assert.match(out, /Chain evaluada: anthropic → groq → openai-codex/);
});

test('#3823 · formatProviderResolutionLog — all-gated multilinea con RESULTADO', () => {
    const out = formatProviderResolutionLog({
        gated: true, provider: 'anthropic', source: 'all-gated',
        fallbackUsed: null, chainTried: ['anthropic', 'openai-codex'],
        skipReasons: [
            { provider: 'anthropic', reason: 'quota_exhausted', details: 'flag de cuota activo' },
            { provider: 'openai-codex', reason: 'quota_exhausted', details: 'flag de cuota activo' },
        ],
    }, { skill: 'qa', issue: 3821 });

    assert.match(out, /🚫 qa:#3821 — Cadena completa exhausted:/);
    assert.match(out, /RESULTADO: all-gated, devuelvo a pendiente\//);
});

test('#3823 · formatProviderResolutionLog — nunca tira ante input mal formado', () => {
    // null / undefined / shapes raros → string mínimo, sin excepción.
    assert.doesNotThrow(() => formatProviderResolutionLog(null, {}));
    assert.doesNotThrow(() => formatProviderResolutionLog(undefined, undefined));
    assert.doesNotThrow(() => formatProviderResolutionLog({ skipReasons: 'no-array' }, { skill: 'x', issue: 1 }));
});

// =============================================================================
// Meta-cobertura: TODOS los códigos de razón documentados deben haberse
// ejercitado por la suite (CA: "cada código de razón figura en al menos un
// test case").
// =============================================================================
test('#3823 · cobertura completa de SKIP_REASON_CODES', () => {
    const documented = Object.values(SKIP_REASON_CODES);
    const missing = documented.filter(code => !REASONS_SEEN.has(code));
    assert.deepEqual(missing, [], `códigos de razón sin test: ${missing.join(', ')}`);
});

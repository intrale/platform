// =============================================================================
// dispatch-mp05-credentials.test.js — MP-05 (#3803)
//
// Pre-check de credenciales del fallback en `resolveSpawnWithFallback`. Antes
// sólo el Commander validaba credenciales pre-spawn; en los skills genéricos,
// un fallback sin key se intentaba igual y fallaba recién en runtime como
// `no_key_configured` (indistinguible de un error de red). MP-05 lo detecta
// ANTES de seleccionarlo y salta limpio al siguiente candidato, dejando rastro
// en el audit como `fallback_no_credentials`.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const dispatch = require('../agent-launcher/dispatch-with-fallback');

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

// pipelineDir temporal con un agent-models.json donde:
//   - primary  = anthropic (launcher claude → OAuth, sin env)
//   - fallback1 = cerebras (requiere CEREBRAS_API_KEY)
//   - fallback2 = openai-codex (requiere OPENAI_API_KEY)
function mkTmpPipelineDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp05-'));
    const models = {
        default_provider: 'anthropic',
        providers: {
            anthropic: {
                launcher: 'claude',
                model: 'claude-opus-4-7',
                credentials_env: ['ANTHROPIC_API_KEY'],
            },
            cerebras: {
                launcher: 'cerebras',
                model: 'llama-3.3-70b',
                credentials_env: ['CEREBRAS_API_KEY'],
            },
            'openai-codex': {
                launcher: 'codex',
                model: 'gpt-5-codex',
                credentials_env: ['OPENAI_API_KEY'],
            },
        },
        skills: {
            'backend-dev': {
                provider: 'anthropic',
                fallbacks: [
                    { provider: 'cerebras' },
                    { provider: 'openai-codex' },
                ],
            },
        },
    };
    fs.writeFileSync(path.join(dir, 'agent-models.json'), JSON.stringify(models, null, 2));
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    return dir;
}

function cleanup(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function readAuditLines(pipelineDir) {
    const file = dispatch.dispatchAuditFile(pipelineDir);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8')
        .split('\n')
        .filter(l => l.trim().length > 0)
        .map(l => JSON.parse(l));
}

// quotaModule fake: el primario siempre gateado, los fallbacks libres (el corte
// de MP-05 es por credencial, no por cuota).
function makeQuotaModule() {
    return {
        shouldGateSpawn(skill, { provider }) {
            return provider === 'anthropic'; // sólo el primario gateado
        },
        sanitizeRawExcerpt: (s) => String(s || ''),
    };
}

const primaryResolver = () => ({ provider: 'anthropic', model: 'claude-opus-4-7', source: 'primary' });
const providerHandlerResolver = (name) => ({ name, providerDef: { launcher: name } });
const silentNotify = () => {};

// -----------------------------------------------------------------------------
// MP-05
// -----------------------------------------------------------------------------

test('MP-05 · fallback sin credencial se saltea y se elige el siguiente con key', () => {
    const dir = mkTmpPipelineDir();
    try {
        const r = dispatch.resolveSpawnWithFallback({
            skill: 'backend-dev',
            issue: 4242,
            pipelineDir: dir,
            quotaModule: makeQuotaModule(),
            primaryResolver,
            providerHandlerResolver,
            notify: silentNotify,
            // cerebras SIN key → debe saltarse; openai-codex CON key → se elige.
            processEnv: { OPENAI_API_KEY: 'real-oai-key' },
        });

        assert.equal(r.source, 'fallback');
        assert.equal(r.provider, 'openai-codex');
        assert.equal(r.gated, false);
        // La cadena pasó por cerebras (saltado) antes de openai-codex.
        assert.deepEqual(r.chainTried, ['anthropic', 'cerebras', 'openai-codex']);

        const audit = readAuditLines(dir);
        const skipEv = audit.find(e => e.event === 'fallback_no_credentials');
        assert.ok(skipEv, 'falta evento fallback_no_credentials');
        assert.equal(skipEv.fallback_provider, 'cerebras');
        assert.match(skipEv.raw_excerpt, /CEREBRAS_API_KEY/);
        // El que sí tenía credencial quedó seleccionado.
        assert.ok(audit.some(e => e.event === 'fallback_selected' && e.fallback_provider === 'openai-codex'));
    } finally { cleanup(dir); }
});

test('MP-05 · todos los fallbacks sin credencial → chain agotada (all-gated)', () => {
    const dir = mkTmpPipelineDir();
    try {
        const r = dispatch.resolveSpawnWithFallback({
            skill: 'backend-dev',
            issue: 4243,
            pipelineDir: dir,
            quotaModule: makeQuotaModule(),
            primaryResolver,
            providerHandlerResolver,
            notify: silentNotify,
            // ninguna key presente → ambos fallbacks se saltan por credencial.
            processEnv: {},
        });

        assert.equal(r.gated, true);
        assert.equal(r.source, 'all-gated');

        const audit = readAuditLines(dir);
        const skipped = audit.filter(e => e.event === 'fallback_no_credentials').map(e => e.fallback_provider);
        assert.deepEqual(skipped.sort(), ['cerebras', 'openai-codex']);
        assert.ok(audit.some(e => e.event === 'chain_exhausted'));
        // Defensa: ningún provider sin credencial pudo ser seleccionado.
        assert.ok(!audit.some(e => e.event === 'fallback_selected'));
    } finally { cleanup(dir); }
});

test('MP-05 · placeholder REVOKED cuenta como credencial ausente', () => {
    const dir = mkTmpPipelineDir();
    try {
        const r = dispatch.resolveSpawnWithFallback({
            skill: 'backend-dev',
            issue: 4244,
            pipelineDir: dir,
            quotaModule: makeQuotaModule(),
            primaryResolver,
            providerHandlerResolver,
            notify: silentNotify,
            // cerebras con placeholder → saltado; openai-codex con key real → elegido.
            processEnv: { CEREBRAS_API_KEY: 'REVOKED', OPENAI_API_KEY: 'real-oai-key' },
        });

        assert.equal(r.provider, 'openai-codex');
        const audit = readAuditLines(dir);
        assert.ok(audit.some(e => e.event === 'fallback_no_credentials' && e.fallback_provider === 'cerebras'));
    } finally { cleanup(dir); }
});

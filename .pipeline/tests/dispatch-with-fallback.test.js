// =============================================================================
// dispatch-with-fallback.test.js — tests del consumer runtime de skill.fallbacks[]
//
// Issue: #3198.
//
// Cubre las reglas declaradas en `lib/agent-launcher/dispatch-with-fallback.js`:
//   1. Happy path: primary no gateado → devuelve primary, gated: false.
//   2. Primary gateado y sin fallbacks declarados → gated: true.
//   3. Primary gateado y primer fallback libre → devuelve fallback.
//   4. Primary gateado y primer fallback también gateado → itera al segundo.
//   5. Primary gateado y todos los fallbacks gateados → all-gated.
//   6. Skills determinísticos no se gatean (bypass).
//   7. Fallback con provider desconocido → skip + audit.
//   8. Cycle: fallback duplicado en chain → skip + audit.
//   9. MAX_FALLBACK_DEPTH respetado.
//  10. Audit log con hash-chain SHA-256 (reusa lib/audit-log).
//  11. Telegram queue se encola con notice cross-provider.
//  12. quotaModule ausente → devuelve primary sin gate (modo legacy).
//  13. resolveSpawnWithFallback es defensivo si audit-log throws.
//  14. Fallback duplica al primary → skip (defense in depth).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
    resolveSpawnWithFallback,
    enqueueTelegramNotice,
    dispatchAuditFile,
    MAX_FALLBACK_DEPTH,
} = require('../lib/agent-launcher/dispatch-with-fallback');

// -----------------------------------------------------------------------------
// Helpers — fakes inyectables
// -----------------------------------------------------------------------------

function fakeAuditLog() {
    const entries = [];
    return {
        appendChained: ({ entry, file }) => {
            entries.push({ entry, file });
            return { hash_self: 'fake-hash', hash_prev: 'fake-prev', line: '' };
        },
        verifyChain: () => ({ ok: true, entriesChecked: entries.length }),
        readAll: () => entries.map(e => e.entry),
        entries,
    };
}

function fakeNotify() {
    const calls = [];
    const fn = (opts) => {
        calls.push(opts);
        return true;
    };
    fn.calls = calls;
    return fn;
}

// Resolver fake de handlers: aceptamos los providers conocidos del módulo real
// + cualquier custom que el test declare como "válido". Para los tests que
// quieren probar handlers inexistentes, el caller NO los incluye acá.
function fakeProviderHandlerResolver(validProviders = ['anthropic', 'openai-codex', 'gemini', 'deterministic']) {
    return (name) => {
        if (!validProviders.includes(name)) {
            throw new Error(`[fake] provider "${name}" no está en validProviders`);
        }
        return { name: `${name}-fake` };
    };
}

function fakeQuotaModule({ gatedProviders = [], sanitize } = {}) {
    return {
        shouldGateSpawn: (skill, { provider } = {}) => {
            if (!provider) return false;
            return gatedProviders.includes(provider);
        },
        sanitizeRawExcerpt: sanitize || ((s) => String(s || '')),
        appendAudit: () => {},
    };
}

function fakeResolver(skill, opts) {
    const fs = opts.fsImpl;
    const pipelineDir = opts.pipelineDir;
    let models = null;
    try {
        const p = path.join(pipelineDir, 'agent-models.json');
        if (fs && fs.existsSync(p)) {
            models = JSON.parse(fs.readFileSync(p, 'utf8'));
        }
    } catch {}
    if (!models) {
        return {
            provider: 'anthropic',
            model: 'claude-opus-4-7',
            handler: { name: 'anthropic-fake' },
            source: 'fallback-no-config',
        };
    }
    const sk = (models.skills && models.skills[skill]) || null;
    if (!sk) {
        return {
            provider: 'anthropic',
            model: (models.defaults && models.defaults.model) || 'claude-opus-4-7',
            handler: { name: 'anthropic-fake' },
            source: 'fallback-skill-not-found',
        };
    }
    const provider = sk.provider || 'anthropic';
    const providerDef = (models.providers && models.providers[provider]) || {};
    return {
        provider,
        model: sk.model_override || providerDef.model || (models.defaults && models.defaults.model) || 'claude-opus-4-7',
        handler: { name: `${provider}-fake` },
        source: 'agent-models',
    };
}

function fakeFsWithAgentModels(pipelineDir, modelsObj) {
    const modelsPath = path.join(pipelineDir, 'agent-models.json');
    const files = new Map();
    files.set(modelsPath, JSON.stringify(modelsObj));
    return {
        existsSync: (p) => files.has(p),
        readFileSync: (p) => {
            if (files.has(p)) return files.get(p);
            const e = new Error(`ENOENT: ${p}`);
            e.code = 'ENOENT';
            throw e;
        },
        mkdirSync: () => {},
        writeFileSync: (p, content) => {
            files.set(p, content);
        },
        _files: files,
    };
}

const PIPELINE_DIR = '/repo/.pipeline';
const ISSUE = 3198;

function baseAgentModels() {
    return {
        defaults: { model: 'claude-opus-4-7' },
        default_provider: 'anthropic',
        providers: {
            anthropic: { model: 'claude-opus-4-7' },
            'openai-codex': { model: 'gpt-codex' },
            gemini: { model: 'gemini-pro' },
        },
        skills: {
            guru: {
                provider: 'anthropic',
                fallbacks: ['openai-codex'],
            },
            'lone-wolf': {
                provider: 'anthropic',
            },
            'chain-skill': {
                provider: 'anthropic',
                fallbacks: ['openai-codex', 'gemini'],
            },
        },
    };
}

// -----------------------------------------------------------------------------
// 1. Happy path
// -----------------------------------------------------------------------------
test('resolveSpawnWithFallback devuelve primary cuando NO está gateado', () => {
    const models = baseAgentModels();
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, models);
    const audit = fakeAuditLog();
    const notify = fakeNotify();

    const r = resolveSpawnWithFallback({
        skill: 'guru',
        issue: ISSUE,
        pipelineDir: PIPELINE_DIR,
        fsImpl,
        quotaModule: fakeQuotaModule({ gatedProviders: [] }),
        primaryResolver: fakeResolver,
        auditLog: audit,
        notify,
    });

    assert.equal(r.gated, false);
    assert.equal(r.provider, 'anthropic');
    assert.equal(r.source, 'agent-models');
    assert.equal(r.fallbackUsed, null);
    assert.equal(r.crossProvider, false);
    assert.deepEqual(r.chainTried, ['anthropic']);
    assert.equal(audit.entries.length, 0, 'no audit en happy path');
    assert.equal(notify.calls.length, 0, 'no telegram en happy path');
});

// -----------------------------------------------------------------------------
// 2. Primary gated, sin fallbacks declarados → gated
// -----------------------------------------------------------------------------
test('resolveSpawnWithFallback gatea cuando primary está gated y no hay fallbacks', () => {
    const models = baseAgentModels();
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, models);
    const audit = fakeAuditLog();

    const r = resolveSpawnWithFallback({
        skill: 'lone-wolf',
        issue: ISSUE,
        pipelineDir: PIPELINE_DIR,
        fsImpl,
        quotaModule: fakeQuotaModule({ gatedProviders: ['anthropic'] }),
        primaryResolver: fakeResolver,
        auditLog: audit,
        notify: fakeNotify(),
    });

    assert.equal(r.gated, true);
    assert.equal(r.source, 'all-gated');
    assert.equal(r.fallbackUsed, null);
    assert.equal(r.primaryProvider, 'anthropic');
    const event = audit.entries[0].entry.event;
    assert.equal(event, 'gated_no_fallbacks');
});

// -----------------------------------------------------------------------------
// 3. Primary gated, primer fallback libre → fallback elegido
// -----------------------------------------------------------------------------
test('resolveSpawnWithFallback elige primer fallback libre cuando primary está gated', () => {
    const models = baseAgentModels();
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, models);
    const audit = fakeAuditLog();
    const notify = fakeNotify();

    const r = resolveSpawnWithFallback({
        skill: 'guru',
        issue: ISSUE,
        pipelineDir: PIPELINE_DIR,
        fsImpl,
        quotaModule: fakeQuotaModule({ gatedProviders: ['anthropic'] }),
        primaryResolver: fakeResolver,
        auditLog: audit,
        notify,
    });

    assert.equal(r.gated, false);
    assert.equal(r.source, 'fallback');
    assert.equal(r.provider, 'openai-codex');
    assert.equal(r.model, 'gpt-codex');
    assert.equal(r.crossProvider, true);
    assert.deepEqual(r.chainTried, ['anthropic', 'openai-codex']);
    assert.deepEqual(r.fallbackUsed, { index: 0, provider: 'openai-codex' });

    assert.ok(audit.entries.find(e => e.entry.event === 'fallback_selected'), 'audit fallback_selected');
    assert.equal(notify.calls.length, 1, 'una notificación Telegram');
    assert.match(notify.calls[0].text, /cross-provider/i);
});

// -----------------------------------------------------------------------------
// 4. Primary y primer fallback gated → itera al segundo
// -----------------------------------------------------------------------------
test('resolveSpawnWithFallback salta fallbacks gated e itera al siguiente', () => {
    const models = baseAgentModels();
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, models);
    const audit = fakeAuditLog();

    const r = resolveSpawnWithFallback({
        skill: 'chain-skill',
        issue: ISSUE,
        pipelineDir: PIPELINE_DIR,
        fsImpl,
        quotaModule: fakeQuotaModule({ gatedProviders: ['anthropic', 'openai-codex'] }),
        primaryResolver: fakeResolver,
        providerHandlerResolver: fakeProviderHandlerResolver(),
        auditLog: audit,
        notify: fakeNotify(),
    });

    assert.equal(r.gated, false);
    assert.equal(r.provider, 'gemini');
    assert.equal(r.fallbackUsed.index, 1);
    assert.deepEqual(r.chainTried, ['anthropic', 'openai-codex', 'gemini']);
    assert.ok(audit.entries.find(e => e.entry.event === 'fallback_also_gated'), 'audit fallback_also_gated');
    assert.ok(audit.entries.find(e => e.entry.event === 'fallback_selected'), 'audit fallback_selected');
});

// -----------------------------------------------------------------------------
// 5. Primary y todos los fallbacks gated → all-gated
// -----------------------------------------------------------------------------
test('resolveSpawnWithFallback marca all-gated cuando toda la chain está gated', () => {
    const models = baseAgentModels();
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, models);
    const audit = fakeAuditLog();

    const r = resolveSpawnWithFallback({
        skill: 'chain-skill',
        issue: ISSUE,
        pipelineDir: PIPELINE_DIR,
        fsImpl,
        quotaModule: fakeQuotaModule({ gatedProviders: ['anthropic', 'openai-codex', 'gemini'] }),
        primaryResolver: fakeResolver,
        providerHandlerResolver: fakeProviderHandlerResolver(),
        auditLog: audit,
        notify: fakeNotify(),
    });

    assert.equal(r.gated, true);
    assert.equal(r.source, 'all-gated');
    assert.equal(r.fallbackUsed, null);
    assert.deepEqual(r.chainTried, ['anthropic', 'openai-codex', 'gemini']);
    assert.ok(audit.entries.find(e => e.entry.event === 'chain_exhausted'), 'audit chain_exhausted');
});

// -----------------------------------------------------------------------------
// 6. Skills determinísticos: bypass
// -----------------------------------------------------------------------------
test('resolveSpawnWithFallback no gatea skills deterministic (allowlist)', () => {
    const models = baseAgentModels();
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, models);
    const audit = fakeAuditLog();

    const determResolver = () => ({
        provider: 'deterministic',
        model: null,
        handler: { name: 'deterministic-fake', isDeterministic: () => true },
        source: 'deterministic-allowlist',
    });

    const r = resolveSpawnWithFallback({
        skill: 'build',
        issue: ISSUE,
        pipelineDir: PIPELINE_DIR,
        fsImpl,
        quotaModule: fakeQuotaModule({ gatedProviders: ['anthropic', 'deterministic'] }),
        primaryResolver: determResolver,
        auditLog: audit,
        notify: fakeNotify(),
    });

    assert.equal(r.gated, false);
    assert.equal(r.provider, 'deterministic');
    assert.equal(r.fallbackUsed, null);
});

// -----------------------------------------------------------------------------
// 7. Fallback con provider desconocido → skip + audit
// -----------------------------------------------------------------------------
test('resolveSpawnWithFallback salta fallback con provider desconocido y audita', () => {
    const models = baseAgentModels();
    models.skills['rogue-skill'] = {
        provider: 'anthropic',
        fallbacks: ['provider-inexistente', 'openai-codex'],
    };
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, models);
    const audit = fakeAuditLog();

    const r = resolveSpawnWithFallback({
        skill: 'rogue-skill',
        issue: ISSUE,
        pipelineDir: PIPELINE_DIR,
        fsImpl,
        quotaModule: fakeQuotaModule({ gatedProviders: ['anthropic'] }),
        primaryResolver: fakeResolver,
        auditLog: audit,
        notify: fakeNotify(),
    });

    assert.equal(r.gated, false);
    assert.equal(r.provider, 'openai-codex');
    assert.ok(audit.entries.find(e => e.entry.event === 'fallback_unknown_provider'));
});

// -----------------------------------------------------------------------------
// 8. Cycle: fallback duplicado en chain → skip + audit
// -----------------------------------------------------------------------------
test('resolveSpawnWithFallback detecta ciclos en la chain de fallbacks', () => {
    const models = baseAgentModels();
    models.skills['cycle-skill'] = {
        provider: 'anthropic',
        fallbacks: ['openai-codex', 'openai-codex', 'gemini'],
    };
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, models);
    const audit = fakeAuditLog();

    const r = resolveSpawnWithFallback({
        skill: 'cycle-skill',
        issue: ISSUE,
        pipelineDir: PIPELINE_DIR,
        fsImpl,
        quotaModule: fakeQuotaModule({ gatedProviders: ['anthropic', 'openai-codex'] }),
        primaryResolver: fakeResolver,
        providerHandlerResolver: fakeProviderHandlerResolver(),
        auditLog: audit,
        notify: fakeNotify(),
    });

    assert.equal(r.gated, false);
    assert.equal(r.provider, 'gemini');
    const cycleSkip = audit.entries.find(e => e.entry.event === 'fallback_cycle_skipped');
    assert.ok(cycleSkip, 'audit fallback_cycle_skipped emitido');
    assert.equal(cycleSkip.entry.fallback_provider, 'openai-codex');
});

// -----------------------------------------------------------------------------
// 9. MAX_FALLBACK_DEPTH respetado
// -----------------------------------------------------------------------------
test('resolveSpawnWithFallback corta cuando la chain supera MAX_FALLBACK_DEPTH', () => {
    const models = baseAgentModels();
    const longFallbacks = [];
    for (let i = 0; i < MAX_FALLBACK_DEPTH + 3; i++) {
        longFallbacks.push(`provider-${i}`);
    }
    models.skills['long-skill'] = {
        provider: 'anthropic',
        fallbacks: longFallbacks,
    };
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, models);
    const audit = fakeAuditLog();

    const r = resolveSpawnWithFallback({
        skill: 'long-skill',
        issue: ISSUE,
        pipelineDir: PIPELINE_DIR,
        fsImpl,
        quotaModule: fakeQuotaModule({ gatedProviders: ['anthropic'] }),
        primaryResolver: fakeResolver,
        auditLog: audit,
        notify: fakeNotify(),
    });

    assert.equal(r.gated, true);
    assert.equal(r.depthExceeded, true);
    assert.ok(audit.entries.find(e => e.entry.event === 'depth_exceeded'));
});

// -----------------------------------------------------------------------------
// 10. Audit log con hash-chain real (smoke test contra lib/audit-log real)
// -----------------------------------------------------------------------------
test('audit log se escribe con hash-chain real (smoke test contra lib/audit-log)', (t) => {
    const os = require('node:os');
    const fsReal = require('node:fs');
    const tmpRoot = fsReal.mkdtempSync(path.join(os.tmpdir(), 'dispatch-fallback-'));
    t.after(() => {
        try { fsReal.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
    });

    const models = baseAgentModels();
    fsReal.mkdirSync(tmpRoot, { recursive: true });
    fsReal.writeFileSync(path.join(tmpRoot, 'agent-models.json'), JSON.stringify(models));

    const auditLogReal = require('../lib/audit-log');

    const r = resolveSpawnWithFallback({
        skill: 'guru',
        issue: ISSUE,
        pipelineDir: tmpRoot,
        quotaModule: fakeQuotaModule({ gatedProviders: ['anthropic'] }),
        primaryResolver: fakeResolver,
        auditLog: auditLogReal,
        notify: () => true,
    });

    assert.equal(r.gated, false);
    assert.equal(r.provider, 'openai-codex');

    const auditFile = dispatchAuditFile(tmpRoot);
    assert.ok(fsReal.existsSync(auditFile), 'audit log creado');
    const chain = auditLogReal.verifyChain(auditFile);
    assert.equal(chain.ok, true, `hash-chain válida: ${JSON.stringify(chain)}`);
    assert.ok(chain.entriesChecked >= 1);
});

// -----------------------------------------------------------------------------
// 11. Telegram queue real
// -----------------------------------------------------------------------------
test('enqueueTelegramNotice escribe archivo en queue de servicios/telegram/pendiente', (t) => {
    const os = require('node:os');
    const fsReal = require('node:fs');
    const tmpRoot = fsReal.mkdtempSync(path.join(os.tmpdir(), 'dispatch-fallback-tg-'));
    t.after(() => {
        try { fsReal.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
    });

    const ok = enqueueTelegramNotice({
        pipelineDir: tmpRoot,
        text: 'test cross-provider notice',
        meta: { skill: 'guru', issue: 3198 },
    });
    assert.equal(ok, true);

    const queueDir = path.join(tmpRoot, 'servicios', 'telegram', 'pendiente');
    const files = fsReal.readdirSync(queueDir);
    assert.equal(files.length, 1);
    const payload = JSON.parse(fsReal.readFileSync(path.join(queueDir, files[0]), 'utf8'));
    assert.equal(payload.type, 'cross-provider-fallback');
    assert.equal(payload.text, 'test cross-provider notice');
    assert.equal(payload.meta.skill, 'guru');
});

// -----------------------------------------------------------------------------
// 12. quotaModule ausente: devuelve primary sin gate (modo legacy)
// -----------------------------------------------------------------------------
test('resolveSpawnWithFallback sin quotaModule devuelve primary sin gate', () => {
    const models = baseAgentModels();
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, models);

    const r = resolveSpawnWithFallback({
        skill: 'guru',
        issue: ISSUE,
        pipelineDir: PIPELINE_DIR,
        fsImpl,
        primaryResolver: fakeResolver,
        auditLog: fakeAuditLog(),
        notify: fakeNotify(),
    });

    assert.equal(r.gated, false);
    assert.equal(r.provider, 'anthropic');
    assert.equal(r.fallbackUsed, null);
});

// -----------------------------------------------------------------------------
// 13. audit-log throws: el dispatcher NO crashea (best-effort)
// -----------------------------------------------------------------------------
test('resolveSpawnWithFallback no crashea cuando audit-log throws', () => {
    const models = baseAgentModels();
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, models);

    const brokenAudit = {
        appendChained: () => { throw new Error('disco lleno'); },
    };

    const r = resolveSpawnWithFallback({
        skill: 'guru',
        issue: ISSUE,
        pipelineDir: PIPELINE_DIR,
        fsImpl,
        quotaModule: fakeQuotaModule({ gatedProviders: ['anthropic'] }),
        primaryResolver: fakeResolver,
        auditLog: brokenAudit,
        notify: fakeNotify(),
    });

    assert.equal(r.gated, false);
    assert.equal(r.provider, 'openai-codex');
});

// -----------------------------------------------------------------------------
// 14. Fallback duplica al primary → skip
// -----------------------------------------------------------------------------
test('resolveSpawnWithFallback ignora fallback que duplica el primary', () => {
    const models = baseAgentModels();
    models.skills['rogue-cfg'] = {
        provider: 'anthropic',
        fallbacks: ['anthropic', 'openai-codex'],
    };
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, models);
    const audit = fakeAuditLog();

    const r = resolveSpawnWithFallback({
        skill: 'rogue-cfg',
        issue: ISSUE,
        pipelineDir: PIPELINE_DIR,
        fsImpl,
        quotaModule: fakeQuotaModule({ gatedProviders: ['anthropic'] }),
        primaryResolver: fakeResolver,
        auditLog: audit,
        notify: fakeNotify(),
    });

    assert.equal(r.gated, false);
    assert.equal(r.provider, 'openai-codex');
    const evidence = audit.entries.find(e =>
        e.entry.event === 'fallback_duplicates_primary' ||
        e.entry.event === 'fallback_cycle_skipped'
    );
    assert.ok(evidence, 'evidence de defensa contra duplicate_primary o cycle');
});

// =============================================================================
// #3221 · shape nuevo en fallbacks (object {provider, model_override})
//
// El runtime de #3198 nació consumiendo strings. #3221 extiende el schema a
// oneOf [string, {provider, model_override}] para que cada fallback pueda
// pinear su modelo concreto. Estos tests cubren la rama nueva del dispatcher.
// =============================================================================

test('#3221 · fallback object {provider, model_override} usa model pin-eado del entry', () => {
    // qa quiere gpt-5 (vision) como fallback de openai-codex, NO el gpt-5-codex
    // default que pinea el provider en la sección providers.
    const models = baseAgentModels();
    // override del provider default para distinguir "default del provider" vs
    // "override del entry de fallback".
    models.providers['openai-codex'].model = 'gpt-5-codex'; // default del provider
    models.skills.qa = {
        provider: 'anthropic',
        model_override: 'claude-opus-4-7',
        fallbacks: [
            { provider: 'openai-codex', model_override: 'gpt-5' }, // pin-eado en fallback
        ],
    };
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, models);
    const audit = fakeAuditLog();
    const notify = fakeNotify();

    const r = resolveSpawnWithFallback({
        skill: 'qa',
        issue: ISSUE,
        pipelineDir: PIPELINE_DIR,
        fsImpl,
        quotaModule: fakeQuotaModule({ gatedProviders: ['anthropic'] }), // primary gated
        primaryResolver: fakeResolver,
        providerHandlerResolver: fakeProviderHandlerResolver(['anthropic', 'openai-codex']),
        auditLog: audit,
        notify,
    });

    assert.equal(r.gated, false);
    assert.equal(r.provider, 'openai-codex');
    assert.equal(r.model, 'gpt-5', 'debe usar el model_override del entry de fallback, no el default del provider');
    const selected = audit.entries.find((e) => e.entry.event === 'fallback_selected');
    assert.ok(selected, 'audit fallback_selected esperado');
    assert.equal(selected.entry.fallback_model, 'gpt-5');
});

test('#3221 · fallback object sin model_override usa model default del provider', () => {
    // Backward-compat funcional: si el object solo declara provider, el modelo
    // sale del default de la sección providers (comportamiento idéntico al string).
    const models = baseAgentModels();
    models.providers['openai-codex'].model = 'gpt-5-codex';
    models.skills.security = {
        provider: 'anthropic',
        fallbacks: [
            { provider: 'openai-codex' }, // sin model_override
        ],
    };
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, models);
    const audit = fakeAuditLog();

    const r = resolveSpawnWithFallback({
        skill: 'security',
        issue: ISSUE,
        pipelineDir: PIPELINE_DIR,
        fsImpl,
        quotaModule: fakeQuotaModule({ gatedProviders: ['anthropic'] }),
        primaryResolver: fakeResolver,
        providerHandlerResolver: fakeProviderHandlerResolver(['anthropic', 'openai-codex']),
        auditLog: audit,
        notify: fakeNotify(),
    });

    assert.equal(r.provider, 'openai-codex');
    assert.equal(r.model, 'gpt-5-codex', 'sin model_override del entry, usa el default del provider');
});

test('#3221 · fallbacks mixto (string + object) ambos resuelven correctamente', () => {
    const models = baseAgentModels();
    models.providers['openai-codex'].model = 'gpt-5-codex';
    models.providers['gemini'].model = 'gemini-pro';
    models.skills.planner = {
        provider: 'anthropic',
        fallbacks: [
            'openai-codex',                                          // string legacy
            { provider: 'gemini', model_override: 'gemini-custom' }, // object con pin
        ],
    };
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, models);

    // Caso 1: primary gated → toma el primer fallback (string).
    let r = resolveSpawnWithFallback({
        skill: 'planner',
        issue: ISSUE,
        pipelineDir: PIPELINE_DIR,
        fsImpl,
        quotaModule: fakeQuotaModule({ gatedProviders: ['anthropic'] }),
        primaryResolver: fakeResolver,
        providerHandlerResolver: fakeProviderHandlerResolver(['anthropic', 'openai-codex', 'gemini']),
        auditLog: fakeAuditLog(),
        notify: fakeNotify(),
    });
    assert.equal(r.provider, 'openai-codex');
    assert.equal(r.model, 'gpt-5-codex'); // default del provider (legacy shape)

    // Caso 2: primary + primer fallback gated → toma el segundo (object con pin).
    r = resolveSpawnWithFallback({
        skill: 'planner',
        issue: ISSUE,
        pipelineDir: PIPELINE_DIR,
        fsImpl,
        quotaModule: fakeQuotaModule({ gatedProviders: ['anthropic', 'openai-codex'] }),
        primaryResolver: fakeResolver,
        providerHandlerResolver: fakeProviderHandlerResolver(['anthropic', 'openai-codex', 'gemini']),
        auditLog: fakeAuditLog(),
        notify: fakeNotify(),
    });
    assert.equal(r.provider, 'gemini');
    assert.equal(r.model, 'gemini-custom'); // pin-eado por el entry de fallback
});

test('#3221 · fallback shape inválido (number 42) → skip + audit fallback_invalid_shape', () => {
    const models = baseAgentModels();
    models.skills.tester = {
        provider: 'anthropic',
        fallbacks: [42, 'openai-codex'], // 42 inválido, debe saltarlo
    };
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, models);
    const audit = fakeAuditLog();

    const r = resolveSpawnWithFallback({
        skill: 'tester',
        issue: ISSUE,
        pipelineDir: PIPELINE_DIR,
        fsImpl,
        quotaModule: fakeQuotaModule({ gatedProviders: ['anthropic'] }),
        primaryResolver: fakeResolver,
        providerHandlerResolver: fakeProviderHandlerResolver(['anthropic', 'openai-codex']),
        auditLog: audit,
        notify: fakeNotify(),
    });

    // Debe haber saltado el item inválido y elegido el siguiente válido.
    assert.equal(r.provider, 'openai-codex');
    const invalidShape = audit.entries.find((e) => e.entry.event === 'fallback_invalid_shape');
    assert.ok(invalidShape, 'audit fallback_invalid_shape esperado');
});

// =============================================================================
// #3680 · FORCE_PROVIDER_OVERRIDE branch
//
// Cubre CA-A8, CA-A10, CA-A11. El flag se inyecta como opts.env (per-spawn,
// nunca process.env). El bypass del gate aplica SOLO para skills en
// FORCED_OVERRIDE_ALLOWED_SKILLS. Cualquier otro skill → ignorar + audit
// warning.
// =============================================================================

const { FORCED_OVERRIDE_ALLOWED_SKILLS } = require('../lib/agent-launcher/dispatch-with-fallback');

test('#3680 · FORCE_PROVIDER_OVERRIDE bypass cuando skill está en allowlist', () => {
    const models = baseAgentModels();
    // Skill autorizado por #3680.
    models.skills['multi-provider-smoke-test'] = {
        provider: 'anthropic',
        fallbacks: ['openai-codex'],
    };
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, models);
    const audit = fakeAuditLog();

    const r = resolveSpawnWithFallback({
        skill: 'multi-provider-smoke-test',
        issue: ISSUE,
        pipelineDir: PIPELINE_DIR,
        fsImpl,
        // gated:true del primary — el override debe bypaseaer SIN consultar quota.
        quotaModule: fakeQuotaModule({ gatedProviders: ['anthropic', 'openai-codex', 'gemini', 'cerebras'] }),
        primaryResolver: fakeResolver,
        providerHandlerResolver: fakeProviderHandlerResolver(['anthropic', 'openai-codex', 'gemini', 'cerebras']),
        auditLog: audit,
        notify: fakeNotify(),
        env: { FORCE_PROVIDER_OVERRIDE: 'cerebras' },
    });

    assert.equal(r.gated, false, 'override bypass del gate');
    assert.equal(r.provider, 'cerebras');
    assert.equal(r.source, 'forced-override');
    assert.equal(r.fallbackUsed, null);
    assert.deepEqual(r.chainTried, ['cerebras']);
    assert.equal(r.crossProvider, false);

    const overrideAudit = audit.entries.find(e => e.entry.event === 'forced_provider_override');
    assert.ok(overrideAudit, 'audit forced_provider_override emitido');
    assert.equal(overrideAudit.entry.skill, 'multi-provider-smoke-test');
    assert.equal(overrideAudit.entry.forced_provider, 'cerebras');
    assert.equal(overrideAudit.entry.source, 'smoke-test');
    assert.ok('primary_provider_bypassed' in overrideAudit.entry, 'shape audit incluye primary_provider_bypassed');
});

test('#3680 · FORCE_PROVIDER_OVERRIDE IGNORADO cuando skill NO está en allowlist', () => {
    const models = baseAgentModels();
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, models);
    const audit = fakeAuditLog();

    // guru NO está en FORCED_OVERRIDE_ALLOWED_SKILLS — el override debe ignorarse
    // y el flow legacy debe correr (en este caso el primary anthropic está libre).
    const r = resolveSpawnWithFallback({
        skill: 'guru',
        issue: ISSUE,
        pipelineDir: PIPELINE_DIR,
        fsImpl,
        quotaModule: fakeQuotaModule({ gatedProviders: [] }),
        primaryResolver: fakeResolver,
        providerHandlerResolver: fakeProviderHandlerResolver(['anthropic', 'openai-codex', 'gemini', 'cerebras']),
        auditLog: audit,
        notify: fakeNotify(),
        env: { FORCE_PROVIDER_OVERRIDE: 'cerebras' },
    });

    // Sigue al flow legacy → primary anthropic (NO el override).
    assert.equal(r.provider, 'anthropic');
    assert.notEqual(r.source, 'forced-override');

    const ignored = audit.entries.find(e => e.entry.event === 'forced_provider_override_ignored');
    assert.ok(ignored, 'audit forced_provider_override_ignored emitido');
    assert.equal(ignored.entry.skill, 'guru');
    assert.equal(ignored.entry.forced_provider, 'cerebras');
    assert.equal(ignored.entry.reason, 'skill_not_in_allowlist');
    assert.deepEqual(ignored.entry.allowed_skills, FORCED_OVERRIDE_ALLOWED_SKILLS.slice());
});

test('#3680 · FORCE_PROVIDER_OVERRIDE ausente — flow legacy sin override (sanity check)', () => {
    const models = baseAgentModels();
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, models);
    const audit = fakeAuditLog();

    const r = resolveSpawnWithFallback({
        skill: 'guru',
        issue: ISSUE,
        pipelineDir: PIPELINE_DIR,
        fsImpl,
        quotaModule: fakeQuotaModule({ gatedProviders: [] }),
        primaryResolver: fakeResolver,
        auditLog: audit,
        notify: fakeNotify(),
        // sin opts.env → no override.
    });

    assert.equal(r.gated, false);
    assert.equal(r.provider, 'anthropic');
    assert.equal(r.source, 'agent-models');
    // No debe emitir ningún audit event del override.
    assert.ok(!audit.entries.find(e =>
        e.entry.event === 'forced_provider_override' ||
        e.entry.event === 'forced_provider_override_ignored' ||
        e.entry.event === 'forced_provider_override_invalid_provider'
    ), 'no audit del override cuando flag está ausente');
});

test('#3680 · FORCE_PROVIDER_OVERRIDE leído SOLO de opts.env (no de process.env del padre)', () => {
    const models = baseAgentModels();
    models.skills['multi-provider-smoke-test'] = {
        provider: 'anthropic',
        fallbacks: [],
    };
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, models);
    const audit = fakeAuditLog();

    // Setear process.env.FORCE_PROVIDER_OVERRIDE en el test (anti-pattern, pero
    // queremos verificar que el dispatcher NO lo lee desde ahí).
    const ORIG = process.env.FORCE_PROVIDER_OVERRIDE;
    process.env.FORCE_PROVIDER_OVERRIDE = 'cerebras';
    try {
        const r = resolveSpawnWithFallback({
            skill: 'multi-provider-smoke-test',
            issue: ISSUE,
            pipelineDir: PIPELINE_DIR,
            fsImpl,
            quotaModule: fakeQuotaModule({ gatedProviders: [] }),
            primaryResolver: fakeResolver,
            auditLog: audit,
            notify: fakeNotify(),
            // NO pasamos opts.env. El dispatcher debe ignorar process.env.
        });
        // Primary anthropic — el override de process.env fue ignorado.
        assert.equal(r.provider, 'anthropic');
        assert.notEqual(r.source, 'forced-override');
        assert.ok(!audit.entries.find(e => e.entry.event === 'forced_provider_override'),
            'process.env del padre NO debe activar override (sólo opts.env del child)');
    } finally {
        if (ORIG === undefined) delete process.env.FORCE_PROVIDER_OVERRIDE;
        else process.env.FORCE_PROVIDER_OVERRIDE = ORIG;
    }
});

test('#3680 · FORCE_PROVIDER_OVERRIDE con provider inválido → audit + flow legacy', () => {
    const models = baseAgentModels();
    models.skills['multi-provider-smoke-test'] = {
        provider: 'anthropic',
        fallbacks: ['openai-codex'],
    };
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, models);
    const audit = fakeAuditLog();

    const r = resolveSpawnWithFallback({
        skill: 'multi-provider-smoke-test',
        issue: ISSUE,
        pipelineDir: PIPELINE_DIR,
        fsImpl,
        quotaModule: fakeQuotaModule({ gatedProviders: [] }),
        primaryResolver: fakeResolver,
        // Handler resolver SOLO acepta los providers válidos del fixture; pedimos uno fake.
        providerHandlerResolver: fakeProviderHandlerResolver(['anthropic', 'openai-codex', 'gemini', 'cerebras']),
        auditLog: audit,
        notify: fakeNotify(),
        env: { FORCE_PROVIDER_OVERRIDE: 'provider-fake-inexistente' },
    });

    // Provider inválido → no bypass; sigue al flow legacy (primary).
    assert.equal(r.provider, 'anthropic');
    assert.notEqual(r.source, 'forced-override');
    const invalid = audit.entries.find(e => e.entry.event === 'forced_provider_override_invalid_provider');
    assert.ok(invalid, 'audit forced_provider_override_invalid_provider emitido');
    assert.equal(invalid.entry.forced_provider, 'provider-fake-inexistente');
});

test('#3680 · FORCE_PROVIDER_OVERRIDE shape del audit entry estable (CA-A11)', () => {
    const models = baseAgentModels();
    models.skills['multi-provider-smoke-test'] = {
        provider: 'anthropic',
        fallbacks: [{ provider: 'openai-codex', model_override: 'gpt-5-codex' }],
    };
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, models);
    const audit = fakeAuditLog();

    resolveSpawnWithFallback({
        skill: 'multi-provider-smoke-test',
        issue: ISSUE,
        pipelineDir: PIPELINE_DIR,
        fsImpl,
        quotaModule: fakeQuotaModule({ gatedProviders: [] }),
        primaryResolver: fakeResolver,
        providerHandlerResolver: fakeProviderHandlerResolver(['anthropic', 'openai-codex', 'gemini', 'cerebras']),
        auditLog: audit,
        notify: fakeNotify(),
        env: { FORCE_PROVIDER_OVERRIDE: 'cerebras' },
    });

    const entry = audit.entries.find(e => e.entry.event === 'forced_provider_override');
    assert.ok(entry, 'audit emitido');
    // Shape exacto (CA-A11).
    assert.equal(entry.entry.event, 'forced_provider_override');
    assert.equal(typeof entry.entry.skill, 'string');
    assert.equal(entry.entry.skill, 'multi-provider-smoke-test');
    assert.equal(entry.entry.forced_provider, 'cerebras');
    assert.equal(entry.entry.source, 'smoke-test');
    assert.ok('primary_provider_bypassed' in entry.entry);
});

// -----------------------------------------------------------------------------
// #3811 — Kill-switch operacional por provider (provider-disabled)
// -----------------------------------------------------------------------------

// Fake del módulo provider-disabled. Inyectable vía opts.disabledModule.
function fakeDisabledModule(disabledProviders = []) {
    const set = new Set(disabledProviders);
    return {
        isProviderDisabled: (provider) => set.has(provider),
    };
}

test('#3811 · primario APAGADO (kill-switch) salta a fallback aunque no haya cuota agotada', () => {
    const models = baseAgentModels();
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, models);
    const audit = fakeAuditLog();
    const notify = fakeNotify();

    const r = resolveSpawnWithFallback({
        skill: 'guru',
        issue: ISSUE,
        pipelineDir: PIPELINE_DIR,
        fsImpl,
        // Cuota NO agotada: el salto se debe exclusivamente al kill-switch.
        quotaModule: fakeQuotaModule({ gatedProviders: [] }),
        disabledModule: fakeDisabledModule(['anthropic']),
        primaryResolver: fakeResolver,
        auditLog: audit,
        notify,
    });

    assert.equal(r.gated, false);
    assert.equal(r.provider, 'openai-codex', 'salta al fallback');
    assert.equal(r.source, 'fallback');
    assert.equal(r.crossProvider, true);
    // Audit registra el salto por deshabilitación.
    const disabledEvent = audit.entries.find(e => e.entry.event === 'provider_disabled');
    assert.ok(disabledEvent, 'audit provider_disabled emitido');
    assert.equal(disabledEvent.entry.primary_provider, 'anthropic');
    assert.equal(disabledEvent.entry.quota_gated, false);
});

test('#3811 · primario apagado SIN fallbacks → all-gated (no spawnea)', () => {
    const models = baseAgentModels();
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, models);
    const audit = fakeAuditLog();

    const r = resolveSpawnWithFallback({
        skill: 'lone-wolf',
        issue: ISSUE,
        pipelineDir: PIPELINE_DIR,
        fsImpl,
        quotaModule: fakeQuotaModule({ gatedProviders: [] }),
        disabledModule: fakeDisabledModule(['anthropic']),
        primaryResolver: fakeResolver,
        auditLog: audit,
        notify: fakeNotify(),
    });

    assert.equal(r.gated, true);
    assert.equal(r.source, 'all-gated');
    // El salto por kill-switch quedó registrado antes del gated_no_fallbacks.
    assert.ok(audit.entries.some(e => e.entry.event === 'provider_disabled'));
    assert.ok(audit.entries.some(e => e.entry.event === 'gated_no_fallbacks'));
});

test('#3811 · fallback también apagado → salta al siguiente eslabón', () => {
    const models = baseAgentModels();
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, models);
    const audit = fakeAuditLog();

    const r = resolveSpawnWithFallback({
        skill: 'chain-skill', // anthropic → [openai-codex, gemini]
        issue: ISSUE,
        pipelineDir: PIPELINE_DIR,
        fsImpl,
        quotaModule: fakeQuotaModule({ gatedProviders: [] }),
        // anthropic (primario) y openai-codex (1er fallback) apagados → debe ir a gemini.
        disabledModule: fakeDisabledModule(['anthropic', 'openai-codex']),
        primaryResolver: fakeResolver,
        providerHandlerResolver: fakeProviderHandlerResolver(['anthropic', 'openai-codex', 'gemini']),
        auditLog: audit,
        notify: fakeNotify(),
    });

    assert.equal(r.gated, false);
    assert.equal(r.provider, 'gemini', 'salta al 2do fallback');
    const fbDisabled = audit.entries.find(e => e.entry.event === 'fallback_provider_disabled');
    assert.ok(fbDisabled, 'audit fallback_provider_disabled emitido');
    assert.equal(fbDisabled.entry.fallback_provider, 'openai-codex');
});

test('#3811 · sin disabledModule inyectado, el flow legacy no cambia (default módulo real, archivo ausente)', () => {
    const models = baseAgentModels();
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, models);
    const audit = fakeAuditLog();

    // No pasamos disabledModule → usa el real, que sin archivo devuelve false.
    const r = resolveSpawnWithFallback({
        skill: 'guru',
        issue: ISSUE,
        pipelineDir: PIPELINE_DIR,
        fsImpl,
        quotaModule: fakeQuotaModule({ gatedProviders: [] }),
        primaryResolver: fakeResolver,
        auditLog: audit,
        notify: fakeNotify(),
    });

    assert.equal(r.gated, false);
    assert.equal(r.provider, 'anthropic', 'happy path intacto');
    assert.ok(!audit.entries.some(e => e.entry.event === 'provider_disabled'));
});

// =============================================================================
// #4306 — Fallback OAuth resuelve sin key en el env (CA-1 / CA-5)
// =============================================================================
function agentModelsWithOauthFallback() {
    return {
        defaults: { model: 'claude-opus-4-7' },
        default_provider: 'anthropic',
        providers: {
            anthropic: { launcher: 'claude', model: 'claude-opus-4-7', auth_mode: 'oauth', credentials_env: ['ANTHROPIC_API_KEY'] },
            'openai-codex': { launcher: 'codex', model: 'gpt-codex', auth_mode: 'oauth', credentials_env: ['OPENAI_API_KEY'] },
            cerebras: { launcher: 'cerebras', model: 'gpt-oss-120b', credentials_env: ['CEREBRAS_API_KEY'] },
        },
        skills: {
            'telegram-commander': {
                provider: 'anthropic',
                fallbacks: ['openai-codex'],
            },
            'codex-then-cerebras': {
                provider: 'anthropic',
                fallbacks: ['openai-codex', 'cerebras'],
            },
        },
    };
}

test('#4306 · anthropic gateado + OPENAI_API_KEY ausente → resuelve openai-codex (no all_gated)', () => {
    const models = agentModelsWithOauthFallback();
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, models);
    const audit = fakeAuditLog();

    const r = resolveSpawnWithFallback({
        skill: 'telegram-commander',
        issue: 'commander-chat',
        pipelineDir: PIPELINE_DIR,
        fsImpl,
        processEnv: { /* sin OPENAI_API_KEY ni ANTHROPIC_API_KEY */ },
        quotaModule: fakeQuotaModule({ gatedProviders: ['anthropic'] }),
        primaryResolver: fakeResolver,
        providerHandlerResolver: fakeProviderHandlerResolver(['anthropic', 'openai-codex', 'cerebras']),
        auditLog: audit,
        notify: fakeNotify(),
    });

    assert.equal(r.gated, false);
    assert.equal(r.provider, 'openai-codex');
    assert.equal(r.crossProvider, true);
    // No debe haber emitido fallback_no_credentials para codex.
    assert.ok(!audit.entries.some(e => e.entry.event === 'fallback_no_credentials'
        && e.entry.fallback_provider === 'openai-codex'),
        'codex OAuth no debe descartarse por credenciales');
});

test('#4306 (regresión) · cerebras (HTTP) sin key SIGUE descartándose por credenciales', () => {
    const models = agentModelsWithOauthFallback();
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, models);
    const audit = fakeAuditLog();

    // anthropic + openai-codex gateados por cuota → debe llegar a cerebras,
    // que sin CEREBRAS_API_KEY se descarta → chain agotada.
    const r = resolveSpawnWithFallback({
        skill: 'codex-then-cerebras',
        issue: 'commander-chat',
        pipelineDir: PIPELINE_DIR,
        fsImpl,
        processEnv: { /* sin ninguna key */ },
        quotaModule: fakeQuotaModule({ gatedProviders: ['anthropic', 'openai-codex'] }),
        primaryResolver: fakeResolver,
        providerHandlerResolver: fakeProviderHandlerResolver(['anthropic', 'openai-codex', 'cerebras']),
        auditLog: audit,
        notify: fakeNotify(),
    });

    assert.equal(r.gated, true);
    const credSkip = audit.entries.find(e => e.entry.event === 'fallback_no_credentials'
        && e.entry.fallback_provider === 'cerebras');
    assert.ok(credSkip, 'cerebras sin key debe emitir fallback_no_credentials');
});

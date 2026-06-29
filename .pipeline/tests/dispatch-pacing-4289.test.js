// =============================================================================
// dispatch-pacing-4289.test.js — enganche del pacing budget en el dispatcher.
//
// Issue #4289. Verifica que el estado de pacing influye en la selección de
// proveedor SIN romper la matriz de permisos (CA-2/CA-3/CA-5/CA-6):
//   - 🟡 amarillo en el primario ⇒ se prefiere el fallback (de-prioriza sin
//     apagar); skipReason = pacing_budget_yellow.
//   - 🔴 rojo en el primario ⇒ se salta al fallback; skipReason = pacing_budget_red.
//   - Granularidad: el amarillo/rojo de un proveedor no afecta a los demás.
//   - CA-6: si el único proveedor permitido (sin fallbacks) está en rojo, el
//     dispatch lo CONSERVA (pacing cede ante permisos), no se pausa.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
    resolveSpawnWithFallback,
} = require('../lib/agent-launcher/dispatch-with-fallback');

const PIPELINE_DIR = '/repo/.pipeline';
const ISSUE = 4289;

function fakeAuditLog() {
    const entries = [];
    return {
        appendChained: ({ entry, file }) => { entries.push({ entry, file }); return { hash_self: 'h', hash_prev: 'p', line: '' }; },
        verifyChain: () => ({ ok: true }),
        readAll: () => entries.map((e) => e.entry),
        entries,
    };
}
function fakeNotify() { const calls = []; const fn = (o) => { calls.push(o); return true; }; fn.calls = calls; return fn; }
function fakeQuotaModule() {
    return { shouldGateSpawn: () => false, sanitizeRawExcerpt: (s) => String(s || ''), appendAudit: () => {} };
}
function fakeFsWithAgentModels(pipelineDir, modelsObj) {
    const modelsPath = path.join(pipelineDir, 'agent-models.json');
    const files = new Map([[modelsPath, JSON.stringify(modelsObj)]]);
    return {
        existsSync: (p) => files.has(p),
        readFileSync: (p) => { if (files.has(p)) return files.get(p); const e = new Error(`ENOENT: ${p}`); e.code = 'ENOENT'; throw e; },
        mkdirSync: () => {}, writeFileSync: (p, c) => files.set(p, c), _files: files,
    };
}
function fakeResolver(skill, opts) {
    const fs = opts.fsImpl;
    const models = JSON.parse(fs.readFileSync(path.join(opts.pipelineDir, 'agent-models.json'), 'utf8'));
    const sk = models.skills[skill];
    const provider = sk.provider;
    return { provider, model: (models.providers[provider] || {}).model || 'm', handler: { name: `${provider}-fake` }, source: 'agent-models' };
}
function fakeHandlerResolver(valid = ['anthropic', 'openai-codex', 'gemini-google']) {
    return (name) => { if (!valid.includes(name)) throw new Error(`[fake] ${name} inválido`); return { name: `${name}-fake` }; };
}
// Módulo de pacing fake: estado por proveedor desde un mapa.
function fakePacing(states = {}) {
    return { getPacingState: (p) => states[p] || 'green' };
}
// Kill-switch fake con origen por proveedor (para distinguir source pacing).
function fakeDisabled(map = {}) {
    return {
        isProviderDisabled: (p) => !!map[p],
        getDisabledEntry: (p) => (map[p] ? { name: p, source: map[p].source || null } : null),
    };
}

function models() {
    return {
        defaults: { model: 'claude-x' },
        default_provider: 'anthropic',
        providers: { anthropic: { model: 'claude-x' }, 'openai-codex': { model: 'gpt-x' }, 'gemini-google': { model: 'gem-x' } },
        skills: {
            guru: { provider: 'anthropic', fallbacks: ['openai-codex'] },
            'lone-wolf': { provider: 'anthropic' }, // sin fallbacks
        },
    };
}

function baseOpts(extra) {
    const fsImpl = fakeFsWithAgentModels(PIPELINE_DIR, models());
    return Object.assign({
        skill: 'guru', issue: ISSUE, pipelineDir: PIPELINE_DIR, fsImpl,
        quotaModule: fakeQuotaModule(), primaryResolver: fakeResolver,
        providerHandlerResolver: fakeHandlerResolver(),
        auditLog: fakeAuditLog(), notify: fakeNotify(),
        now: Date.parse('2026-06-24T12:00:00.000Z'),
        // Por default todo verde / nada apagado (aislar del estado real del repo).
        pacingModule: fakePacing({}), disabledModule: fakeDisabled({}),
    }, extra);
}

// -----------------------------------------------------------------------------
// CA-2 — Amarillo: de-prioriza al primario (prefiere fallback) sin apagar.
// -----------------------------------------------------------------------------
test('🟡 amarillo en el primario ⇒ usa el fallback (de-prioriza, CA-2)', () => {
    const r = resolveSpawnWithFallback(baseOpts({
        pacingModule: fakePacing({ anthropic: 'yellow' }),
    }));
    assert.equal(r.gated, false);
    assert.equal(r.provider, 'openai-codex', 'prefirió el fallback');
    assert.equal(r.crossProvider, true);
    const reasons = r.skipReasons.map((s) => s.reason);
    assert.ok(reasons.includes('pacing_budget_yellow'), `skipReasons=${JSON.stringify(reasons)}`);
});

test('🟡 amarillo sin fallback resoluble ⇒ usa el primary (no vacía la chain)', () => {
    const r = resolveSpawnWithFallback(baseOpts({
        skill: 'lone-wolf',
        pacingModule: fakePacing({ anthropic: 'yellow' }),
    }));
    assert.equal(r.gated, false);
    assert.equal(r.provider, 'anthropic');
    assert.equal(r.softGatedPrimaryUsed, true);
});

// -----------------------------------------------------------------------------
// CA-3 — Rojo: salta al fallback (candidato no disponible).
// -----------------------------------------------------------------------------
test('🔴 rojo en el primario ⇒ salta al fallback (CA-3)', () => {
    const r = resolveSpawnWithFallback(baseOpts({
        pacingModule: fakePacing({ anthropic: 'red' }),
    }));
    assert.equal(r.gated, false);
    assert.equal(r.provider, 'openai-codex');
    assert.equal(r.crossProvider, true);
    const reasons = r.skipReasons.map((s) => s.reason);
    assert.ok(reasons.includes('pacing_budget_red'), `skipReasons=${JSON.stringify(reasons)}`);
});

test('🔴 rojo vía provider-disabled source pacing ⇒ atribuye pacing_budget_red', () => {
    const r = resolveSpawnWithFallback(baseOpts({
        pacingModule: fakePacing({}), // bucket no consultado/limpio
        disabledModule: fakeDisabled({ anthropic: { source: 'pacing' } }),
    }));
    assert.equal(r.provider, 'openai-codex');
    const reasons = r.skipReasons.map((s) => s.reason);
    assert.ok(reasons.includes('pacing_budget_red'), `skipReasons=${JSON.stringify(reasons)}`);
});

test('disable manual (source ≠ pacing) ⇒ skipReason provider_disabled, no pacing', () => {
    const r = resolveSpawnWithFallback(baseOpts({
        disabledModule: fakeDisabled({ anthropic: { source: 'manual' } }),
    }));
    assert.equal(r.provider, 'openai-codex');
    const reasons = r.skipReasons.map((s) => s.reason);
    assert.ok(reasons.includes('provider_disabled'));
    assert.ok(!reasons.includes('pacing_budget_red'));
});

// -----------------------------------------------------------------------------
// CA-5 — Granularidad: pacing de un proveedor no afecta a otro.
// -----------------------------------------------------------------------------
test('granularidad: rojo de un fallback no apaga al primario verde (CA-5)', () => {
    const r = resolveSpawnWithFallback(baseOpts({
        // primario verde, el fallback en rojo: igual usamos el primario.
        pacingModule: fakePacing({ 'openai-codex': 'red' }),
    }));
    assert.equal(r.gated, false);
    assert.equal(r.provider, 'anthropic', 'el primario verde se usa normal');
    assert.equal(r.crossProvider, false);
});

test('granularidad: fallback en rojo se salta, chain se agota (sin otro candidato)', () => {
    const r = resolveSpawnWithFallback(baseOpts({
        pacingModule: fakePacing({ anthropic: 'red', 'openai-codex': 'red' }),
    }));
    // ambos en rojo, pero anthropic (primario) cede ante permisos (CA-6).
    assert.equal(r.gated, false);
    assert.equal(r.provider, 'anthropic');
    assert.equal(r.pacingCede, true);
    const reasons = r.skipReasons.map((s) => s.reason);
    assert.ok(reasons.includes('pacing_budget_red'));
});

// -----------------------------------------------------------------------------
// CA-6 — pacing cede ante la matriz de permisos.
// -----------------------------------------------------------------------------
test('🔴 rojo del único proveedor permitido (sin fallbacks) ⇒ se conserva (CA-6)', () => {
    const r = resolveSpawnWithFallback(baseOpts({
        skill: 'lone-wolf',
        pacingModule: fakePacing({ anthropic: 'red' }),
    }));
    assert.equal(r.gated, false, 'NO se pausa: pacing cede ante permisos');
    assert.equal(r.provider, 'anthropic');
    assert.equal(r.pacingCede, true);
});

test('🔴 rojo de pacing vía disabled source pacing, único proveedor ⇒ cede (CA-6)', () => {
    const r = resolveSpawnWithFallback(baseOpts({
        skill: 'lone-wolf',
        disabledModule: fakeDisabled({ anthropic: { source: 'pacing' } }),
        pacingModule: fakePacing({}),
    }));
    assert.equal(r.gated, false);
    assert.equal(r.provider, 'anthropic');
    assert.equal(r.pacingCede, true);
});

test('kill-switch MANUAL del único proveedor (sin fallbacks) ⇒ SÍ se pausa (no cede)', () => {
    const r = resolveSpawnWithFallback(baseOpts({
        skill: 'lone-wolf',
        disabledModule: fakeDisabled({ anthropic: { source: 'manual' } }),
        pacingModule: fakePacing({}),
    }));
    // El kill-switch manual NO cede (semántica de "caída en runtime").
    assert.equal(r.gated, true);
    assert.equal(r.source, 'all-gated');
});

// -----------------------------------------------------------------------------
// Happy path: sin pacing activo, comportamiento previo intacto.
// -----------------------------------------------------------------------------
test('sin pacing (todo verde) ⇒ usa el primario (regresión cero)', () => {
    const r = resolveSpawnWithFallback(baseOpts({}));
    assert.equal(r.gated, false);
    assert.equal(r.provider, 'anthropic');
    assert.equal(r.crossProvider, false);
    assert.equal(r.skipReasons.length, 0);
});

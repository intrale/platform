// =============================================================================
// quota-exhausted-reconcile-4865.test.js — Subordinación del gate a la fuente
// única de verdad (#4865).
//
// Cubre:
//   - setFlag VETA el set cuando el adapter canónico reporta el proveedor sano
//     con dato fresco (adapterStatus 'ok' + pct < techo) → no escribe flag +
//     audita `flag_set_vetoed`.
//   - setFlag es FAIL-CLOSED: sin dato fresco (unknown/stale) persiste el flag.
//   - setFlag HONRA la señal cuando el adapter coincide en pct >= techo.
//   - shouldGateSpawn VETA el gate con adapter sano/fresco (+ audita gate_vetoed).
//   - shouldGateSpawn es FAIL-CLOSED sin dato fresco.
//   - kill-switch QUOTA_RECONCILE_DISABLED desactiva la reconciliación.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { seedPipelineConfig } = require('./_test-helpers');

function freshModule(tmpDir) {
    process.env.PIPELINE_DIR_OVERRIDE = tmpDir;
    delete require.cache[require.resolve('../quota-exhausted')];
    return require('../quota-exhausted');
}

function newTmpDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-quota-reconcile-'));
    // #5172: el sandbox hace de `.pipeline/`; sin `config.yaml` la lectura de
    // config es un fallo tipado y `setFlag` explota antes de llegar al veto que
    // este archivo ejercita. Documento mínimo: sin `quota_detector:` los TTL
    // default son los mismos de siempre.
    seedPipelineConfig(dir);
    return dir;
}

function readFlag(tmpDir) {
    const f = path.join(tmpDir, 'quota-exhausted.json');
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8'));
}

function readAuditLines(tmpDir, dateOverride) {
    const d = dateOverride || new Date();
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const f = path.join(tmpDir, 'logs', `quota-detector-${yyyy}-${mm}-${dd}.log`);
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// Adapters fake: quotaUsage devuelve un shape controlado; ALLOWED_PROVIDERS
// incluye anthropic y openai-codex para que pase la validación de allowlist.
function fakeAdapters(quotaResult) {
    return {
        ALLOWED_PROVIDERS: ['anthropic', 'openai-codex', 'gemini-google', 'cerebras'],
        quotaUsage: () => quotaResult,
    };
}

const HEALTHY_FRESH = { adapterStatus: 'ok', pct: 42, status: 'normal' };
const NO_DATA = { adapterStatus: 'unknown', pct: null, status: 'unknown' };
const CRITICAL_FRESH = { adapterStatus: 'ok', pct: 96, status: 'critical' };

// -----------------------------------------------------------------------------
// setFlag — veto por fuente única
// -----------------------------------------------------------------------------

test('#4865 · setFlag VETA cuando el adapter reporta anthropic sano/fresco (42%)', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);

    const res = q.setFlag({
        errorType: 'usage_limit_error',
        provider: 'anthropic',
        agent: 'security',
        _quotaAdapters: fakeAdapters(HEALTHY_FRESH),
    });

    assert.equal(res.vetoed, true);
    assert.equal(res.source, 'reconcile_veto');
    assert.equal(readFlag(tmp), null, 'no debe escribir el flag');

    const audit = readAuditLines(tmp);
    const vetoed = audit.find((a) => a.event === 'flag_set_vetoed');
    assert.ok(vetoed, 'debe auditar el veto');
    assert.equal(vetoed.provider, 'anthropic');
    assert.equal(vetoed.flag_set, false);
    assert.match(vetoed.raw_excerpt, /pct=42/);
});

test('#4865 · setFlag es FAIL-CLOSED: adapter sin dato fresco → persiste el flag', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);

    const res = q.setFlag({
        errorType: 'usage_limit_error',
        provider: 'anthropic',
        _quotaAdapters: fakeAdapters(NO_DATA),
    });

    assert.notEqual(res.vetoed, true);
    const flag = readFlag(tmp);
    assert.ok(flag && flag.exhausted === true, 'debe persistir el flag (conservador)');
});

test('#4865 · setFlag HONRA la señal cuando el adapter coincide en pct >= techo (96%)', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);

    const res = q.setFlag({
        errorType: 'usage_limit_error',
        provider: 'anthropic',
        _quotaAdapters: fakeAdapters(CRITICAL_FRESH),
    });

    assert.notEqual(res.vetoed, true);
    assert.ok(readFlag(tmp), 'con cuota crítica real el flag se persiste');
});

test('#4865 · CA regresión: setFlag(anthropic) con adapter sano NO produce flag_set', () => {
    // Simula el incidente 2026-07-22: un agente procesa el body de #4861/#4863
    // (menciona cuotas) → el parser podría emitir errorType → pero la fuente
    // única dice 42% → NO debe quedar flag para anthropic.
    const tmp = newTmpDir();
    const q = freshModule(tmp);

    q.setFlag({
        errorType: 'usage_limit_error',
        provider: 'anthropic',
        agent: 'po',
        _quotaAdapters: fakeAdapters(HEALTHY_FRESH),
    });

    assert.equal(q.isQuotaExhausted({ provider: 'anthropic' }), false);
    assert.equal(readFlag(tmp), null);
});

// -----------------------------------------------------------------------------
// shouldGateSpawn — veto por fuente única
// -----------------------------------------------------------------------------

test('#4865 · shouldGateSpawn VETA el gate si el adapter dice sano/fresco', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);

    // Sembramos un flag activo de anthropic (fail-closed con NO_DATA).
    q.setFlag({
        errorType: 'usage_limit_error',
        provider: 'anthropic',
        _quotaAdapters: fakeAdapters(NO_DATA),
    });
    assert.ok(readFlag(tmp), 'precondición: flag activo');

    const gated = q.shouldGateSpawn('security', {
        provider: 'anthropic',
        _quotaAdapters: fakeAdapters(HEALTHY_FRESH),
    });
    assert.equal(gated, false, 'no debe gatear si la fuente única dice sano');

    const audit = readAuditLines(tmp);
    assert.ok(audit.some((a) => a.event === 'gate_vetoed' && a.provider === 'anthropic'));
});

test('#4865 · shouldGateSpawn es FAIL-CLOSED: sin dato fresco sigue gateando', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);

    q.setFlag({
        errorType: 'usage_limit_error',
        provider: 'anthropic',
        _quotaAdapters: fakeAdapters(NO_DATA),
    });

    const gated = q.shouldGateSpawn('security', {
        provider: 'anthropic',
        _quotaAdapters: fakeAdapters(NO_DATA),
    });
    assert.equal(gated, true, 'sin dato del adapter, honra el flag');
});

test('#4865 · shouldGateSpawn NO gatea a un provider sin slot (scope intacto)', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);

    q.setFlag({
        errorType: 'usage_limit_error',
        provider: 'anthropic',
        _quotaAdapters: fakeAdapters(NO_DATA),
    });

    // openai-codex no tiene slot → no gatea (ni siquiera consulta el adapter).
    const gated = q.shouldGateSpawn('backend-dev', {
        provider: 'openai-codex',
        _quotaAdapters: fakeAdapters(CRITICAL_FRESH),
    });
    assert.equal(gated, false);
});

// -----------------------------------------------------------------------------
// Kill-switch operacional
// -----------------------------------------------------------------------------

test('#4865 · QUOTA_RECONCILE_DISABLED=1 desactiva el veto (comportamiento legacy)', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);

    process.env.QUOTA_RECONCILE_DISABLED = '1';
    try {
        const res = q.setFlag({
            errorType: 'usage_limit_error',
            provider: 'anthropic',
            _quotaAdapters: fakeAdapters(HEALTHY_FRESH),
        });
        assert.notEqual(res.vetoed, true);
        assert.ok(readFlag(tmp), 'con kill-switch ON el flag se escribe pese al adapter sano');
    } finally {
        delete process.env.QUOTA_RECONCILE_DISABLED;
    }
});

// -----------------------------------------------------------------------------
// reconcileWithCanonicalSource — unidad
// -----------------------------------------------------------------------------

test('#4865 · reconcileWithCanonicalSource veta sólo con ok + pct bajo el techo', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);

    assert.equal(
        q.reconcileWithCanonicalSource('anthropic', { _quotaAdapters: fakeAdapters(HEALTHY_FRESH) }).veto,
        true);
    assert.equal(
        q.reconcileWithCanonicalSource('anthropic', { _quotaAdapters: fakeAdapters(CRITICAL_FRESH) }).veto,
        false);
    assert.equal(
        q.reconcileWithCanonicalSource('anthropic', { _quotaAdapters: fakeAdapters(NO_DATA) }).veto,
        false);
    // pct exactamente en el techo → no veta (límite inclusivo del honor).
    assert.equal(
        q.reconcileWithCanonicalSource('anthropic', {
            _quotaAdapters: fakeAdapters({ adapterStatus: 'ok', pct: q.RECONCILE_HEALTHY_MAX_PCT }),
        }).veto,
        false);
});

test('#4865 · reconcile normaliza alias anthropic-claude → anthropic', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const r = q.reconcileWithCanonicalSource('anthropic-claude', {
        _quotaAdapters: fakeAdapters(HEALTHY_FRESH),
    });
    assert.equal(r.veto, true);
});

test('#4865 · reconcile fail-closed si el adapter lanza excepción', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const throwing = {
        ALLOWED_PROVIDERS: ['anthropic'],
        quotaUsage: () => { throw new Error('adapter roto'); },
    };
    const r = q.reconcileWithCanonicalSource('anthropic', { _quotaAdapters: throwing });
    assert.equal(r.veto, false);
    assert.equal(r.reason, 'adapter_threw');
});

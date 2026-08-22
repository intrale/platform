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

// =============================================================================
// #5455 — ÚNICA excepción al veto `provider_healthy_fresh`: el aviso semanal de
// Anthropic recibido por el canal de CONTENIDO.
//
// Por qué existe la excepción: durante el incidente real (2026-08-02) el adapter
// canónico reportaba `ok/pct:3` MIENTRAS Anthropic ya había cortado por límite
// semanal — el corte no se refleja en `/usage` a tiempo. El reconcile de #4865,
// correcto para señales por substring, vetaría entonces la única señal fidedigna
// que existe para este corte.
//
// El bypass exige las DOS condiciones a la vez (provider canónico `anthropic` Y
// `weekly_limit_content_channel`) y se aplica con el MISMO predicado en SET
// (`setFlag`) y en GET (`shouldGateSpawn`). Exceptuar sólo el SET escribiría un
// slot que el GET ignora con el adapter sano: el turno siguiente volvería a
// elegir Anthropic y el gate no serviría de nada.
// =============================================================================

const CONTENT_TYPE = 'weekly_limit_content_channel';
const HEALTHY_FRESH_LOW = { adapterStatus: 'ok', pct: 3, status: 'normal' };

// -----------------------------------------------------------------------------
// SET — setFlag persiste el subtipo dedicado pese al adapter sano
// -----------------------------------------------------------------------------

test('#5455 · SET: setFlag persiste weekly_limit_content_channel con el adapter sano/fresco', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);

    const res = q.setFlag({
        errorType: CONTENT_TYPE,
        provider: 'anthropic',
        agent: 'commander',
        // pct:3 reproduce exactamente lo observado durante el incidente.
        _quotaAdapters: fakeAdapters(HEALTHY_FRESH_LOW),
    });

    assert.notEqual(res.vetoed, true, 'el subtipo dedicado NO debe ser vetado');

    const flag = readFlag(tmp);
    assert.ok(flag, 'el flag debe escribirse pese al adapter sano');
    const slot = flag.providers['anthropic'];
    assert.ok(slot, 'debe existir el slot de anthropic');
    assert.equal(slot.pattern_matched, CONTENT_TYPE);

    // El bypass queda trazable en la auditoría (procedencia del incidente).
    const audit = readAuditLines(tmp);
    const bypass = audit.find((a) => a.event === 'flag_set_veto_bypassed');
    assert.ok(bypass, 'debe auditar el bypass explícitamente');
    assert.equal(bypass.provider, 'anthropic');
    assert.equal(bypass.error_type, CONTENT_TYPE);
    assert.ok(!audit.some((a) => a.event === 'flag_set_vetoed'),
        'no debe auditar un veto que no ocurrió');
});

test('#5455 · SET: el veto sigue INTACTO para usage_limit_error con adapter sano', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);

    const res = q.setFlag({
        errorType: 'usage_limit_error',
        provider: 'anthropic',
        _quotaAdapters: fakeAdapters(HEALTHY_FRESH_LOW),
    });

    assert.equal(res.vetoed, true, 'el bypass NO se amplía a otros tipos');
    assert.equal(readFlag(tmp), null);
});

test('#5455 · SET: el veto sigue INTACTO para los demás tipos de anthropic', () => {
    for (const errorType of ['weekly_quota_exhausted', 'snapshot_threshold_90']) {
        const tmp = newTmpDir();
        const q = freshModule(tmp);
        const res = q.setFlag({
            errorType,
            provider: 'anthropic',
            _quotaAdapters: fakeAdapters(HEALTHY_FRESH_LOW),
        });
        assert.equal(res.vetoed, true, errorType + ' debe seguir vetado');
        assert.equal(readFlag(tmp), null, errorType + ' no debe escribir flag');
    }
});

test('#5455 · SET: otro provider con el MISMO tipo sigue vetado (scope Anthropic)', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);

    const res = q.setFlag({
        errorType: CONTENT_TYPE,
        provider: 'openai-codex',
        _quotaAdapters: fakeAdapters(HEALTHY_FRESH_LOW),
    });

    assert.equal(res.vetoed, true, 'el bypass no se amplía a otros providers');
    assert.equal(readFlag(tmp), null);
});

// -----------------------------------------------------------------------------
// GET — shouldGateSpawn HONRA el slot dedicado pese al adapter sano
// -----------------------------------------------------------------------------

test('#5455 · GET: shouldGateSpawn honra el slot del canal de contenido con adapter sano', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);

    q.setFlag({
        errorType: CONTENT_TYPE,
        provider: 'anthropic',
        _quotaAdapters: fakeAdapters(HEALTHY_FRESH_LOW),
    });
    assert.ok(readFlag(tmp), 'precondición: slot dedicado activo');

    const gated = q.shouldGateSpawn('commander', {
        provider: 'anthropic',
        _quotaAdapters: fakeAdapters(HEALTHY_FRESH_LOW),
    });
    assert.equal(gated, true, 'el gate debe honrarse: sin esto el turno vuelve a Anthropic');

    const audit = readAuditLines(tmp);
    assert.ok(audit.some((a) => a.event === 'gate_veto_bypassed' && a.provider === 'anthropic'),
        'debe auditar el bypass del GET');
    assert.ok(!audit.some((a) => a.event === 'gate_vetoed'),
        'no debe auditar un veto que no ocurrió');
});

test('#5455 · GET: el veto sigue INTACTO para un slot usage_limit_error con adapter sano', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);

    // Se siembra con NO_DATA (fail-closed) para que el slot exista.
    q.setFlag({
        errorType: 'usage_limit_error',
        provider: 'anthropic',
        _quotaAdapters: fakeAdapters(NO_DATA),
    });

    const gated = q.shouldGateSpawn('commander', {
        provider: 'anthropic',
        _quotaAdapters: fakeAdapters(HEALTHY_FRESH_LOW),
    });
    assert.equal(gated, false, 'el veto de #4865 debe conservarse para los demás tipos');
});

test('#5455 · SET+GET end-to-end: persistir y consultar con el adapter sano en ambos puntos', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);
    const healthy = () => fakeAdapters(HEALTHY_FRESH_LOW);

    // SET con adapter sano.
    const res = q.setFlag({ errorType: CONTENT_TYPE, provider: 'anthropic', _quotaAdapters: healthy() });
    assert.notEqual(res.vetoed, true);

    // GET con adapter sano → gatea Anthropic…
    assert.equal(q.shouldGateSpawn('commander', { provider: 'anthropic', _quotaAdapters: healthy() }),
        true, 'Anthropic queda gateado');
    // …y NO gatea al provider de fallback, que es el punto de toda la historia.
    assert.equal(q.shouldGateSpawn('commander', { provider: 'openai-codex', _quotaAdapters: healthy() }),
        false, 'el turno siguiente debe poder caer a Codex');
});

// -----------------------------------------------------------------------------
// TTL efectivo — clamp duro a 60 minutos
// -----------------------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000;

test('#5455 · TTL: un reset a 7 días se clampea a 60 minutos', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);

    const now = Date.now();
    q.setFlag({
        errorType: CONTENT_TYPE,
        provider: 'anthropic',
        resetsAt: new Date(now + 7 * 24 * HOUR_MS).toISOString(),
        _quotaAdapters: fakeAdapters(HEALTHY_FRESH_LOW),
    });

    const slot = readFlag(tmp).providers['anthropic'];
    const ms = Date.parse(slot.resets_at);
    assert.ok(ms <= now + HOUR_MS + 5000,
        'resets_at debe caer dentro de 60 min; fue ' + slot.resets_at);
});

test('#5455 · TTL: el clamp de 60 min vive en setFlag y gana sobre el maxDays del caller', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);

    const now = Date.now();
    // Un call-site futuro que "olvide" el maxDays correcto no puede persistir
    // este tipo con el default de 7 días: la garantía es del escritor único.
    q.setFlag({
        errorType: CONTENT_TYPE,
        provider: 'anthropic',
        resetsAt: new Date(now + 7 * 24 * HOUR_MS).toISOString(),
        maxDays: 7,
        _quotaAdapters: fakeAdapters(HEALTHY_FRESH_LOW),
    });

    const slot = readFlag(tmp).providers['anthropic'];
    assert.ok(Date.parse(slot.resets_at) <= now + HOUR_MS + 5000,
        'el maxDays del caller no debe prolongar el gate; fue ' + slot.resets_at);
});

test('#5455 · TTL: los demás tipos conservan su TTL largo (el clamp no se derrama)', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);

    const now = Date.now();
    q.setFlag({
        errorType: 'usage_limit_error',
        provider: 'anthropic',
        resetsAt: new Date(now + 5 * 24 * HOUR_MS).toISOString(),
        _quotaAdapters: fakeAdapters(NO_DATA),
    });

    const slot = readFlag(tmp).providers['anthropic'];
    assert.ok(Date.parse(slot.resets_at) > now + 24 * HOUR_MS,
        'el clamp de 60 min es exclusivo del canal de contenido');
});

// -----------------------------------------------------------------------------
// Predicado compartido — unidad
// -----------------------------------------------------------------------------

test('#5455 · isWeeklyLimitContentChannel exige provider Y tipo simultáneamente', () => {
    const tmp = newTmpDir();
    const q = freshModule(tmp);

    assert.equal(q.isWeeklyLimitContentChannel('anthropic', CONTENT_TYPE), true);
    // Alias canónico del adapter.
    assert.equal(q.isWeeklyLimitContentChannel('anthropic-claude', CONTENT_TYPE), true);
    // Falta una de las dos condiciones.
    assert.equal(q.isWeeklyLimitContentChannel('openai-codex', CONTENT_TYPE), false);
    assert.equal(q.isWeeklyLimitContentChannel('anthropic', 'usage_limit_error'), false);
    assert.equal(q.isWeeklyLimitContentChannel('anthropic', 'weekly_quota_exhausted'), false);
    // Entradas degeneradas fallan cerradas.
    assert.equal(q.isWeeklyLimitContentChannel('', CONTENT_TYPE), false);
    assert.equal(q.isWeeklyLimitContentChannel('anthropic', null), false);
    assert.equal(q.isWeeklyLimitContentChannel('anthropic', undefined), false);
});

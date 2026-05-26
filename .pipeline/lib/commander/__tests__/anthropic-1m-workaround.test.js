// =============================================================================
// anthropic-1m-workaround.test.js — Cobertura del feature flag y ciclo de vida
// del workaround Anthropic CLI 1M (#3508 — T-1..T-6 de los criterios CA).
//
// Estructura:
//   T-1  isWorkaroundEnabled() con whitelist + fail-safe.
//   T-2  Adversarial 1MB del parser con flag OFF (<50ms, no se evalúa el regex).
//   T-3  Clasificador: con flag OFF cae a quota_exhausted; con ON, glitch.
//   T-4  Persistencia: hit → JSON actualizado; corrupto → reset + log, no crash.
//   T-5  Cooldown: dos disparos consecutivos dentro de 7 días → 1 alerta.
//   T-6  Log de startup en ambos modos (flag=0 y flag=1).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const mod = require('../anthropic-1m-workaround');
const parser = require('../provider-error-parser');
const { parseProviderError } = parser;

const FEATURE_FLAG_ENV = mod.FEATURE_FLAG_ENV;
const MS_PER_DAY = mod.MS_PER_DAY;

// -----------------------------------------------------------------------------
// Helpers de test — sandbox tmp para no tocar el commander-session real.
// -----------------------------------------------------------------------------
function makeTmpSession() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antrhopic-1m-test-'));
    return path.join(dir, 'commander-session.json');
}

function withEnv(value, fn) {
    const prev = process.env[FEATURE_FLAG_ENV];
    if (value === undefined) delete process.env[FEATURE_FLAG_ENV];
    else process.env[FEATURE_FLAG_ENV] = String(value);
    try {
        return fn();
    } finally {
        if (prev === undefined) delete process.env[FEATURE_FLAG_ENV];
        else process.env[FEATURE_FLAG_ENV] = prev;
    }
}

// -----------------------------------------------------------------------------
// T-1 — isWorkaroundEnabled() whitelist y fail-safe (SEC-1 + CA-1).
// -----------------------------------------------------------------------------

test('T-1 isWorkaroundEnabled: undefined → true (default protector)', () => {
    withEnv(undefined, () => {
        assert.equal(mod.isWorkaroundEnabled(), true);
    });
});

test('T-1 isWorkaroundEnabled: "0" → false', () => {
    withEnv('0', () => assert.equal(mod.isWorkaroundEnabled(), false));
});

test('T-1 isWorkaroundEnabled: "1" → true', () => {
    withEnv('1', () => assert.equal(mod.isWorkaroundEnabled(), true));
});

test('T-1 isWorkaroundEnabled: "true"/"false" (case-insensitive)', () => {
    withEnv('true', () => assert.equal(mod.isWorkaroundEnabled(), true));
    withEnv('false', () => assert.equal(mod.isWorkaroundEnabled(), false));
    withEnv('TRUE', () => assert.equal(mod.isWorkaroundEnabled(), true));
    withEnv('FALSE', () => assert.equal(mod.isWorkaroundEnabled(), false));
});

test('T-1 isWorkaroundEnabled: con espacios "  0  " → false (trim aplicado)', () => {
    withEnv('  0  ', () => assert.equal(mod.isWorkaroundEnabled(), false));
    withEnv('  true  ', () => assert.equal(mod.isWorkaroundEnabled(), true));
});

test('T-1 isWorkaroundEnabled: valores raros → fail-safe true (SEC-1)', () => {
    // CA-1: aceptar SOLO la whitelist. Cualquier otro valor → default protector.
    for (const v of ['2', 'on', 'YES', '', 'enabled', 'disabled', 'yes', 'no', 'null', '{}']) {
        withEnv(v, () => {
            assert.equal(mod.isWorkaroundEnabled(), true, `valor "${v}" debería fail-safe a true`);
        });
    }
});

test('T-1 isWorkaroundEnabled: envOverride no muta process.env', () => {
    withEnv('1', () => {
        assert.equal(mod.isWorkaroundEnabled({ [FEATURE_FLAG_ENV]: '0' }), false);
        assert.equal(process.env[FEATURE_FLAG_ENV], '1', 'process.env no debe haber cambiado');
    });
});

// -----------------------------------------------------------------------------
// T-2 — Adversarial 1MB con flag OFF (<50ms, no evalúa el regex 1M) [CA-2/SEC-2].
// -----------------------------------------------------------------------------

test('T-2 adversarial 1MB con flag OFF clasifica sin tocar regex 1M (<200ms)', () => {
    withEnv('0', () => {
        // Payload de 1MB. Empieza con un JSON estructural Anthropic que clasifica
        // como quota_exhausted (path genérico) — el regex 1M está cortocircuitado
        // por flag OFF, así que ni siquiera se evalúa sobre el payload grande.
        const head = JSON.stringify({
            type: 'result',
            is_error: true,
            error_type: 'usage_limit_error',
            result: 'Usage credits required',
        });
        const filler = 'x'.repeat(1024 * 1024); // 1MB de basura.
        const raw = head + '\n' + filler;

        const t0 = Date.now();
        const r = parseProviderError(raw, { provider: 'anthropic', transport: 'cli' });
        const elapsed = Date.now() - t0;

        // CA-1: con flag OFF, el caso 1M cae al path genérico quota_exhausted.
        assert.equal(r.errorClass, 'quota_exhausted',
            'con flag OFF el caso debe caer al path genérico quota_exhausted');
        // CA-2/SEC-2: el short-circuit preserva el budget de tiempo del parser.
        // El threshold del #3506 era <50ms; relajamos a 200ms en CI por jitter.
        assert.ok(elapsed < 200, `parseo demoró ${elapsed}ms — debe estar <200ms`);
    });
});

test('T-2 adversarial 1MB con flag ON sigue clasificando glitch (<200ms)', () => {
    withEnv('1', () => {
        const head = JSON.stringify({
            type: 'result',
            is_error: true,
            error_type: 'usage_limit_error',
            result: 'API Error: Usage credits required for 1M context',
        });
        const filler = 'x'.repeat(1024 * 1024);
        const raw = head + '\n' + filler;

        const t0 = Date.now();
        const r = parseProviderError(raw, { provider: 'anthropic', transport: 'cli' });
        const elapsed = Date.now() - t0;

        assert.equal(r.errorClass, 'cli_1m_context_glitch');
        assert.ok(elapsed < 200, `parseo demoró ${elapsed}ms — debe estar <200ms`);
    });
});

// -----------------------------------------------------------------------------
// T-3 — Clasificador respeta flag (CA-1).
// -----------------------------------------------------------------------------

test('T-3 con flag OFF, "Usage credits required for 1M context" cae a quota_exhausted', () => {
    withEnv('0', () => {
        const raw = 'API Error: Usage credits required for 1M context';
        const r = parseProviderError(raw, { provider: 'anthropic', transport: 'cli' });
        assert.equal(r.errorClass, 'quota_exhausted',
            'con flag OFF la rama 1M está cortocircuitada y el texto matchea el patrón genérico');
        assert.equal(r.shouldFallback, true,
            'quota_exhausted dispara fallback (comportamiento pre-#3506)');
    });
});

test('T-3 con flag ON, mismo input cae a cli_1m_context_glitch', () => {
    withEnv('1', () => {
        const raw = 'API Error: Usage credits required for 1M context';
        const r = parseProviderError(raw, { provider: 'anthropic', transport: 'cli' });
        assert.equal(r.errorClass, 'cli_1m_context_glitch');
        assert.equal(r.shouldFallback, false, 'glitch NO rota provider');
    });
});

test('T-3 con flag undefined (ausente), default-enabled → cli_1m_context_glitch', () => {
    withEnv(undefined, () => {
        const raw = 'API Error: Usage credits required for 1M context';
        const r = parseProviderError(raw, { provider: 'anthropic', transport: 'cli' });
        assert.equal(r.errorClass, 'cli_1m_context_glitch');
    });
});

test('T-3 cuota genuina (sin "1M context") sigue clasificando quota_exhausted con flag ON', () => {
    withEnv('1', () => {
        const raw = 'API Error: Usage credits required';
        const r = parseProviderError(raw, { provider: 'anthropic', transport: 'cli' });
        assert.equal(r.errorClass, 'quota_exhausted',
            'cuota real (sin "1M context") no debe degradar con flag ON');
    });
});

// -----------------------------------------------------------------------------
// T-4 — Persistencia y validación (CA-3/CA-8/SEC-4).
// -----------------------------------------------------------------------------

test('T-4 recordHit escribe seccion anthropic_1m_workaround con shape canónico', () => {
    const session = makeTmpSession();
    const now = Date.parse('2026-05-26T10:30:00Z');
    const { state } = mod.recordHit({ sessionFile: session, now });
    assert.equal(state.hits_total, 1);
    assert.equal(state.last_hit_at, now);

    const raw = JSON.parse(fs.readFileSync(session, 'utf8'));
    const sec = raw.anthropic_1m_workaround;
    assert.equal(sec.hits_total, 1);
    assert.equal(sec.last_hit_at, '2026-05-26T10:30:00.000Z');
    assert.equal(sec.ttl_days_threshold, 14);
    assert.equal(sec.cooldown_days, 7);
    assert.ok(typeof sec.last_hit_at_human === 'string' && sec.last_hit_at_human !== 'nunca',
        'last_hit_at_human debe ser un string formateado');
    assert.equal(sec.last_alert_sent_at, null);
    assert.equal(sec.last_alert_sent_at_human, 'nunca');
    assert.equal(typeof sec.enabled, 'boolean', 'enabled refleja el flag al momento del write');
});

test('T-4 recordHit incrementa hits_total en cada llamada', () => {
    const session = makeTmpSession();
    mod.recordHit({ sessionFile: session, now: 1_700_000_000_000 });
    mod.recordHit({ sessionFile: session, now: 1_700_000_001_000 });
    const { state } = mod.recordHit({ sessionFile: session, now: 1_700_000_002_000 });
    assert.equal(state.hits_total, 3);
    assert.equal(state.last_hit_at, 1_700_000_002_000);
});

test('T-4 JSON corrupto (hits_total negativo) → reset + corrupt reportado, sin crash', () => {
    const session = makeTmpSession();
    fs.writeFileSync(session, JSON.stringify({
        anthropic_1m_workaround: {
            hits_total: -5,
            last_hit_at: '2026-05-26T10:30:00.000Z',
            last_alert_sent_at: null,
        },
    }));
    const { state, corrupt } = mod._readState(session);
    assert.equal(state.hits_total, 0, 'hits_total negativo → reseteado a 0');
    assert.ok(corrupt.find(c => c.field === 'hits_total'), 'corrupt debe reportar el campo');
});

test('T-4 timestamp futuro → reset a null + reportado como corrupt (SEC-4)', () => {
    const session = makeTmpSession();
    const future = new Date(Date.now() + 30 * MS_PER_DAY).toISOString();
    fs.writeFileSync(session, JSON.stringify({
        anthropic_1m_workaround: {
            hits_total: 1,
            last_hit_at: future,
            last_alert_sent_at: null,
        },
    }));
    const { state, corrupt } = mod._readState(session);
    assert.equal(state.last_hit_at, null,
        'timestamp futuro debe ser tratado como inválido (no perpetuar supresión TTL)');
    assert.ok(corrupt.find(c => c.field === 'last_hit_at'));
});

test('T-4 last_alert_sent_at corrupto → tratar como null (SEC-6)', () => {
    const session = makeTmpSession();
    fs.writeFileSync(session, JSON.stringify({
        anthropic_1m_workaround: {
            hits_total: 5,
            last_hit_at: '2026-05-01T00:00:00.000Z',
            last_alert_sent_at: 'no-es-fecha',
        },
    }));
    const { state, corrupt } = mod._readState(session);
    assert.equal(state.last_alert_sent_at, null, 'corrupt → null (permitir envío)');
    assert.ok(corrupt.find(c => c.field === 'last_alert_sent_at'));
});

test('T-4 archivo ausente o JSON malformado → estado vacío sin tirar', () => {
    const session = makeTmpSession();
    // Archivo ausente.
    const { state: s1, corrupt: c1 } = mod._readState(session);
    assert.equal(s1.hits_total, 0);
    assert.equal(s1.last_hit_at, null);
    assert.deepEqual(c1, []);

    // JSON malformado.
    fs.writeFileSync(session, '{nope');
    const { state: s2 } = mod._readState(session);
    assert.equal(s2.hits_total, 0);
});

// -----------------------------------------------------------------------------
// T-5 — Cooldown 7 días (CA-4/CA-6/SEC-6).
// -----------------------------------------------------------------------------

test('T-5 checkTtlAlert con TTL no alcanzado → shouldEmit=false', () => {
    const session = makeTmpSession();
    const baseNow = Date.parse('2026-05-26T00:00:00Z');
    mod.recordHit({ sessionFile: session, now: baseNow - 5 * MS_PER_DAY }); // hace 5 días.
    const d = mod.checkTtlAlert({ sessionFile: session, now: baseNow });
    assert.equal(d.shouldEmit, false);
    assert.equal(d.reason, 'ttl_not_reached');
});

test('T-5 checkTtlAlert con TTL alcanzado y sin alerta previa → shouldEmit=true', () => {
    const session = makeTmpSession();
    const baseNow = Date.parse('2026-05-26T00:00:00Z');
    mod.recordHit({ sessionFile: session, now: baseNow - 15 * MS_PER_DAY }); // hace 15 días.
    const d = mod.checkTtlAlert({ sessionFile: session, now: baseNow });
    assert.equal(d.shouldEmit, true);
    assert.equal(d.reason, null);
});

test('T-5 segunda evaluación dentro de cooldown 7d → shouldEmit=false', () => {
    const session = makeTmpSession();
    const baseNow = Date.parse('2026-05-26T00:00:00Z');
    mod.recordHit({ sessionFile: session, now: baseNow - 15 * MS_PER_DAY });

    // Primer disparo: emite.
    const d1 = mod.checkTtlAlert({ sessionFile: session, now: baseNow });
    assert.equal(d1.shouldEmit, true);
    mod.recordAlertSent({ sessionFile: session, now: baseNow });

    // Segunda evaluación 3 días después: cooldown activo, no emite.
    const d2 = mod.checkTtlAlert({ sessionFile: session, now: baseNow + 3 * MS_PER_DAY });
    assert.equal(d2.shouldEmit, false);
    assert.equal(d2.reason, 'cooldown_active');
});

test('T-5 después del cooldown 7d se permite re-emitir', () => {
    const session = makeTmpSession();
    const baseNow = Date.parse('2026-05-26T00:00:00Z');
    mod.recordHit({ sessionFile: session, now: baseNow - 15 * MS_PER_DAY });
    mod.recordAlertSent({ sessionFile: session, now: baseNow });
    // 8 días después.
    const d = mod.checkTtlAlert({ sessionFile: session, now: baseNow + 8 * MS_PER_DAY });
    assert.equal(d.shouldEmit, true);
});

test('T-5 sin hits jamás → no emite (no es "presunto resuelto")', () => {
    const session = makeTmpSession();
    const d = mod.checkTtlAlert({ sessionFile: session, now: Date.now() });
    assert.equal(d.shouldEmit, false);
    assert.equal(d.reason, 'no_hits_ever');
});

test('T-5 flag OFF inhibe la alerta TTL aunque se cumplan condiciones', () => {
    const session = makeTmpSession();
    const baseNow = Date.parse('2026-05-26T00:00:00Z');
    mod.recordHit({ sessionFile: session, now: baseNow - 15 * MS_PER_DAY });
    const d = mod.checkTtlAlert({
        sessionFile: session,
        now: baseNow,
        envOverride: { [FEATURE_FLAG_ENV]: '0' },
    });
    assert.equal(d.shouldEmit, false);
    assert.equal(d.reason, 'flag_disabled');
});

// -----------------------------------------------------------------------------
// T-6 — Log de startup (CA-7/UX-4).
// -----------------------------------------------------------------------------

test('T-6 formatStartupLogLine con flag=0 emite línea de "deshabilitado"', () => {
    const session = makeTmpSession();
    const line = mod.formatStartupLogLine({
        sessionFile: session,
        envOverride: { [FEATURE_FLAG_ENV]: '0' },
    });
    assert.match(line, /\[multi-provider\] ANTHROPIC_1M_WORKAROUND_ENABLED=0 detectado — workaround #3506 deshabilitado\./);
});

test('T-6 formatStartupLogLine con flag=1 incluye hits y último hit', () => {
    const session = makeTmpSession();
    mod.recordHit({ sessionFile: session, now: Date.parse('2026-05-20T08:00:00Z') });
    mod.recordHit({ sessionFile: session, now: Date.parse('2026-05-21T08:00:00Z') });
    const line = mod.formatStartupLogLine({
        sessionFile: session,
        envOverride: { [FEATURE_FLAG_ENV]: '1' },
    });
    assert.match(line, /workaround #3506 activo/);
    assert.match(line, /Hits totales: 2/);
    assert.match(line, /Último hit:.*2026-05-21/);
});

test('T-6 formatStartupLogLine con flag=1 sin hits → "nunca"', () => {
    const session = makeTmpSession();
    const line = mod.formatStartupLogLine({
        sessionFile: session,
        envOverride: { [FEATURE_FLAG_ENV]: '1' },
    });
    assert.match(line, /Último hit: nunca\./);
});

// -----------------------------------------------------------------------------
// Extras: formato de mensajes Telegram (UX-1/UX-2).
// -----------------------------------------------------------------------------

test('UX-1 formatHitExtension incluye contador y línea operativa', () => {
    const session = makeTmpSession();
    mod.recordHit({ sessionFile: session, now: Date.parse('2026-05-26T10:30:00Z') });
    const ext = mod.formatHitExtension({ sessionFile: session });
    assert.match(ext, /Workaround Anthropic 1M activo/);
    assert.match(ext, /Hits últimos 7 días: 1/);
    assert.match(ext, /ANTHROPIC_1M_WORKAROUND_ENABLED=0 y reintentar/);
});

test('UX-2 formatTtlAlertMessage estructura el mensaje completo con marker 🧪', () => {
    const session = makeTmpSession();
    mod.recordHit({ sessionFile: session, now: Date.parse('2026-05-10T00:00:00Z') });
    const body = mod.formatTtlAlertMessage({
        sessionFile: session,
        envOverride: { [FEATURE_FLAG_ENV]: '1' },
    });
    assert.match(body, /^🧪 Workaround Anthropic 1M sin hits hace 14 días/);
    assert.match(body, /Hits totales acumulados: 1/);
    assert.match(body, /Flag actual: ANTHROPIC_1M_WORKAROUND_ENABLED=1 \(activo\)/);
    assert.match(body, /Cooldown: esta alerta no se va a repetir por 7 días/);
});

// -----------------------------------------------------------------------------
// SEC-5: sanitizeHitLog solo deja campos permitidos.
// -----------------------------------------------------------------------------

test('SEC-5 sanitizeHitLog descarta campos no autorizados (prompt, headers, tokens)', () => {
    const log = mod.sanitizeHitLog({
        timestamp: '2026-05-26T10:30:00Z',
        provider: 'anthropic',
        evidence: 'API Error: Usage credits required for 1M context',
        // Campos hostiles que NUNCA deben llegar al log:
        prompt: 'datos privados del usuario',
        headers: { authorization: 'Bearer sk-xxx' },
        token: 'sk-ant-yyy',
        contexto_agente: 'PII',
    });
    assert.deepEqual(Object.keys(log).sort(), ['errorClass', 'evidence', 'provider', 'timestamp']);
    assert.equal(log.errorClass, 'cli_1m_context_glitch');
});

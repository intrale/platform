// =============================================================================
// provider-disabled.test.js — Tests unitarios del kill-switch por provider (#3811)
//
// Cobertura:
//   - set/read/clear idempotentes.
//   - TTL expira + drenado natural en lectura.
//   - Apagado permanente (ttlMs: null).
//   - Backward-compat: archivo ausente → false / lista vacía.
//   - Validación de nombre de provider (allowlist).
//   - listDisabledProviders con ttl_remaining_ms.
//   - clearAll borra todo.
//   - Persistencia: el archivo se borra cuando no quedan entradas activas.
//   - Tolerancia a JSON corrupto.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Sandbox por test: directorio temporal apuntado por PIPELINE_DIR_OVERRIDE.
function withSandbox(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-disabled-'));
    const prev = process.env.PIPELINE_DIR_OVERRIDE;
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    // Reimportar fresco para que pipelineDir() lea el override actual.
    delete require.cache[require.resolve('../provider-disabled')];
    const mod = require('../provider-disabled');
    try {
        fn(mod, dir);
    } finally {
        if (prev === undefined) delete process.env.PIPELINE_DIR_OVERRIDE;
        else process.env.PIPELINE_DIR_OVERRIDE = prev;
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
}

const NOAUDIT = { auditLogEnabled: false };

// -----------------------------------------------------------------------------
// Validación de provider
// -----------------------------------------------------------------------------

test('isValidProvider acepta solo la allowlist', () => {
    withSandbox((mod) => {
        assert.equal(mod.isValidProvider('anthropic'), true);
        assert.equal(mod.isValidProvider('openai-codex'), true);
        assert.equal(mod.isValidProvider('gemini-google'), true);
        assert.equal(mod.isValidProvider('cerebras'), true);
        assert.equal(mod.isValidProvider('nvidia-nim'), true);
        // deterministic NO es un provider de IA → no apagable.
        assert.equal(mod.isValidProvider('deterministic'), false);
        assert.equal(mod.isValidProvider('groq'), false);
        assert.equal(mod.isValidProvider('inexistente'), false);
        assert.equal(mod.isValidProvider(null), false);
        assert.equal(mod.isValidProvider(123), false);
    });
});

test('setProviderDisabled rechaza provider inválido sin escribir archivo', () => {
    withSandbox((mod) => {
        const r = mod.setProviderDisabled('groq', NOAUDIT);
        assert.equal(r.ok, false);
        assert.match(r.error, /provider inválido/);
        assert.equal(fs.existsSync(mod.flagFile()), false);
    });
});

// -----------------------------------------------------------------------------
// set / read / clear idempotentes
// -----------------------------------------------------------------------------

test('set/read básico: apaga anthropic y isProviderDisabled lo refleja', () => {
    withSandbox((mod) => {
        assert.equal(mod.isProviderDisabled('anthropic', NOAUDIT), false);
        const r = mod.setProviderDisabled('anthropic', NOAUDIT);
        assert.equal(r.ok, true);
        assert.equal(typeof r.filePath, 'string');
        assert.equal(mod.isProviderDisabled('anthropic', NOAUDIT), true);
        // Scope por provider: openai-codex sigue habilitado.
        assert.equal(mod.isProviderDisabled('openai-codex', NOAUDIT), false);
    });
});

test('set es idempotente: apagar dos veces no duplica la entrada', () => {
    withSandbox((mod) => {
        mod.setProviderDisabled('anthropic', NOAUDIT);
        mod.setProviderDisabled('anthropic', NOAUDIT);
        const list = mod.listDisabledProviders(NOAUDIT);
        const anthropic = list.disabled.filter((e) => e.name === 'anthropic');
        assert.equal(anthropic.length, 1);
    });
});

test('clear re-habilita y devuelve true; clear de no-apagado devuelve false', () => {
    withSandbox((mod) => {
        mod.setProviderDisabled('cerebras', NOAUDIT);
        assert.equal(mod.clearProviderDisabled('cerebras', NOAUDIT), true);
        assert.equal(mod.isProviderDisabled('cerebras', NOAUDIT), false);
        // Segundo clear: ya no estaba apagado.
        assert.equal(mod.clearProviderDisabled('cerebras', NOAUDIT), false);
    });
});

test('clear de un provider no afecta a los demás apagados', () => {
    withSandbox((mod) => {
        mod.setProviderDisabled('anthropic', NOAUDIT);
        mod.setProviderDisabled('gemini-google', NOAUDIT);
        mod.clearProviderDisabled('anthropic', NOAUDIT);
        assert.equal(mod.isProviderDisabled('anthropic', NOAUDIT), false);
        assert.equal(mod.isProviderDisabled('gemini-google', NOAUDIT), true);
    });
});

// -----------------------------------------------------------------------------
// TTL + drenado natural
// -----------------------------------------------------------------------------

test('TTL: entrada vencida se drena en lectura (auto-restaurado)', () => {
    withSandbox((mod) => {
        const t0 = 1_000_000_000_000;
        mod.setProviderDisabled('anthropic', { ttlMs: 1000, now: t0, auditLogEnabled: false });
        // Antes del vencimiento sigue apagado.
        assert.equal(mod.isProviderDisabled('anthropic', { now: t0 + 500, auditLogEnabled: false }), true);
        // Después del TTL: drenado natural → habilitado.
        assert.equal(mod.isProviderDisabled('anthropic', { now: t0 + 2000, auditLogEnabled: false }), false);
    });
});

test('TTL vencido se persiste como drenado: el archivo refleja la limpieza', () => {
    withSandbox((mod) => {
        const t0 = 2_000_000_000_000;
        mod.setProviderDisabled('cerebras', { ttlMs: 1000, now: t0, auditLogEnabled: false });
        mod.setProviderDisabled('anthropic', { ttlMs: null, now: t0, auditLogEnabled: false });
        // Lectura post-vencimiento de cerebras: drena cerebras, conserva anthropic.
        const list = mod.listDisabledProviders({ now: t0 + 5000, auditLogEnabled: false });
        const names = list.disabled.map((e) => e.name);
        assert.deepEqual(names, ['anthropic']);
    });
});

test('apagado permanente (ttlMs:null) no vence', () => {
    withSandbox((mod) => {
        const t0 = 3_000_000_000_000;
        const r = mod.setProviderDisabled('nvidia-nim', { ttlMs: null, now: t0, auditLogEnabled: false });
        assert.equal(r.ok, true);
        assert.equal(r.ttl_ms, null);
        // Mucho después sigue apagado.
        assert.equal(mod.isProviderDisabled('nvidia-nim', { now: t0 + 999_999_999, auditLogEnabled: false }), true);
    });
});

test('TTL default es 20min cuando no se especifica', () => {
    withSandbox((mod) => {
        const r = mod.setProviderDisabled('anthropic', NOAUDIT);
        assert.equal(r.ttl_ms, mod.DEFAULT_TTL_MS);
        assert.equal(mod.DEFAULT_TTL_MS, 20 * 60 * 1000);
    });
});

test('TTL se acota a MAX_TTL_MS', () => {
    withSandbox((mod) => {
        const r = mod.setProviderDisabled('anthropic', { ttlMs: mod.MAX_TTL_MS * 10, auditLogEnabled: false });
        assert.equal(r.ttl_ms, mod.MAX_TTL_MS);
    });
});

test('ttlMs inválido (0, negativo, NaN) es rechazado', () => {
    withSandbox((mod) => {
        assert.equal(mod.setProviderDisabled('anthropic', { ttlMs: 0, auditLogEnabled: false }).ok, false);
        assert.equal(mod.setProviderDisabled('anthropic', { ttlMs: -5, auditLogEnabled: false }).ok, false);
        assert.equal(mod.setProviderDisabled('anthropic', { ttlMs: NaN, auditLogEnabled: false }).ok, false);
    });
});

// -----------------------------------------------------------------------------
// listDisabledProviders
// -----------------------------------------------------------------------------

test('listDisabledProviders devuelve ttl_remaining_ms', () => {
    withSandbox((mod) => {
        const t0 = 4_000_000_000_000;
        mod.setProviderDisabled('anthropic', { ttlMs: 10_000, now: t0, auditLogEnabled: false });
        const list = mod.listDisabledProviders({ now: t0 + 3000, auditLogEnabled: false });
        const e = list.disabled.find((x) => x.name === 'anthropic');
        assert.equal(e.ttl_remaining_ms, 7000);
        assert.equal(typeof e.ttl_expires_at, 'string');
    });
});

test('listDisabledProviders: ttl_remaining_ms null para apagado permanente', () => {
    withSandbox((mod) => {
        mod.setProviderDisabled('anthropic', { ttlMs: null, auditLogEnabled: false });
        const list = mod.listDisabledProviders(NOAUDIT);
        const e = list.disabled.find((x) => x.name === 'anthropic');
        assert.equal(e.ttl_remaining_ms, null);
        assert.equal(e.ttl_expires_at, null);
    });
});

// -----------------------------------------------------------------------------
// Backward-compat / robustez
// -----------------------------------------------------------------------------

test('archivo ausente: isProviderDisabled=false, lista vacía', () => {
    withSandbox((mod) => {
        assert.equal(fs.existsSync(mod.flagFile()), false);
        assert.equal(mod.isProviderDisabled('anthropic', NOAUDIT), false);
        assert.deepEqual(mod.listDisabledProviders(NOAUDIT).disabled, []);
    });
});

test('JSON corrupto: degrada a habilitado (fail-open) sin crashear', () => {
    withSandbox((mod) => {
        fs.writeFileSync(mod.flagFile(), '{ esto no es json válido', 'utf8');
        assert.equal(mod.isProviderDisabled('anthropic', NOAUDIT), false);
        assert.deepEqual(mod.listDisabledProviders(NOAUDIT).disabled, []);
    });
});

test('entradas con shape inválido se filtran', () => {
    withSandbox((mod) => {
        fs.writeFileSync(mod.flagFile(), JSON.stringify({
            disabled: [
                { name: 'anthropic', disabled_at: '2026-06-03T00:00:00.000Z' },
                { name: 'groq-invalido' },          // provider fuera de allowlist
                { foo: 'bar' },                       // sin name
                'string-suelto',                      // no objeto
            ],
        }), 'utf8');
        const list = mod.listDisabledProviders(NOAUDIT);
        assert.deepEqual(list.disabled.map((e) => e.name), ['anthropic']);
    });
});

test('el archivo se borra cuando no quedan entradas activas', () => {
    withSandbox((mod) => {
        mod.setProviderDisabled('anthropic', NOAUDIT);
        assert.equal(fs.existsSync(mod.flagFile()), true);
        mod.clearProviderDisabled('anthropic', NOAUDIT);
        assert.equal(fs.existsSync(mod.flagFile()), false);
    });
});

test('clearAll borra el archivo entero', () => {
    withSandbox((mod) => {
        mod.setProviderDisabled('anthropic', NOAUDIT);
        mod.setProviderDisabled('cerebras', NOAUDIT);
        assert.equal(mod.clearAll(NOAUDIT), true);
        assert.equal(fs.existsSync(mod.flagFile()), false);
        // clearAll sobre archivo ausente → false.
        assert.equal(mod.clearAll(NOAUDIT), false);
    });
});

test('provider inválido en isProviderDisabled siempre false', () => {
    withSandbox((mod) => {
        assert.equal(mod.isProviderDisabled('groq', NOAUDIT), false);
        assert.equal(mod.isProviderDisabled(null, NOAUDIT), false);
    });
});

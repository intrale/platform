// =============================================================================
// completion-client-data-residency.test.js — Gate data-residency (D6 / RS-1)
// del issue #4404.
//
// Verifica el gate INBYPASSEABLE insertado en `complete()`:
//   (1) Positivo: paths permitidos → se despacha (doRequest se invoca).
//   (2) Negativo fail-closed: path excluido → NO se despacha, retorna
//       `data_residency_blocked`, `appendAudit` invocado con {path,motivo,pattern}.
//   (3) Sidecar inválido → `data_residency_blocked`, sin dispatch.
//   (4) filterPathsForProvider lanza → fail-closed, sin dispatch.
//
// No se hacen requests reales: `httpImpl` está stubeado y además usamos su
// invocación como sonda de "¿se despachó?". El gate corre ANTES de construir
// el body, así que en todo bloqueo `httpImpl.request` NUNCA se llama.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const completion = require('../completion-client');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mp-drf-')); }
function writeKeys(file, keys) { fs.writeFileSync(file, JSON.stringify(keys)); }

// fakeHttp — stub de https.request que además rastrea si fue invocado
// (`dispatched`). Responde 200 con un body OpenAI-compat válido por default.
function fakeHttp({ status = 200, body } = {}) {
    const state = { dispatched: false };
    const _body = body != null ? body : JSON.stringify({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 3, completion_tokens: 5 },
        model: 'gpt-oss-120b',
    });
    const impl = {
        request(opts, cb) {
            state.dispatched = true;
            const req = {
                on() { return this; },
                write() {},
                end() {
                    process.nextTick(() => {
                        const res = {
                            statusCode: status,
                            on(ev, fn) {
                                if (ev === 'data') fn(Buffer.from(_body, 'utf8'));
                                if (ev === 'end') fn();
                            },
                        };
                        cb(res);
                    });
                },
                destroy() {},
            };
            return req;
        },
    };
    return { impl, state };
}

// Credencial válida (formato de secrets-rw) para que el gate se alcance:
// el chequeo de key ocurre ANTES del gate, así que sin key nunca probaríamos
// el gate.
function keyFileForCerebras() {
    const f = path.join(tmpDir(), 'config.json');
    writeKeys(f, { cerebras_api_key: 'csk_test_1234567890abcdef0000' });
    return f;
}

// ─── (1) Positivo — path permitido se despacha ──────────────────────────────

test('#4404 · positivo: paths permitidos → complete() despacha (doRequest invocado)', async () => {
    const { impl, state } = fakeHttp({ status: 200 });
    const r = await completion.complete({
        provider: 'cerebras',
        model: 'gpt-oss-120b',
        prompt: 'hola',
        paths: ['docs/pipeline/multi-provider.md', 'README.md'],
        secretsPath: keyFileForCerebras(),
        httpImpl: impl,
    });
    assert.equal(state.dispatched, true, 'con paths permitidos el gate deja despachar');
    assert.equal(r.ok, true);
    assert.equal(r.content, 'ok');
});

test('#4404 · positivo: sin paths (default []) el gate es transparente', async () => {
    const { impl, state } = fakeHttp({ status: 200 });
    const r = await completion.complete({
        provider: 'cerebras',
        model: 'gpt-oss-120b',
        prompt: 'hola',
        secretsPath: keyFileForCerebras(),
        httpImpl: impl,
    });
    assert.equal(state.dispatched, true);
    assert.equal(r.ok, true);
});

// ─── (2) Negativo fail-closed — path excluido NO se despacha ─────────────────

test('#4404 · negativo: path excluido (application.conf) → data_residency_blocked, sin dispatch', async () => {
    const { impl, state } = fakeHttp({ status: 200 });
    const r = await completion.complete({
        provider: 'nvidia-nim',
        model: 'deepseek-ai/deepseek-v4-pro',
        prompt: 'analizá esto',
        // Excluido para non_anthropic por el sidecar real (**/application.conf).
        paths: ['users/src/main/resources/application.conf'],
        secretsPath: (() => {
            const f = path.join(tmpDir(), 'config.json');
            writeKeys(f, { nvidia_nim_api_key: 'nvapi-test-1234567890abcdef0000' });
            return f;
        })(),
        httpImpl: impl,
    });
    assert.equal(state.dispatched, false, 'un path bloqueado NUNCA debe llegar a doRequest');
    assert.equal(r.ok, false);
    assert.equal(r.error.type, 'data_residency_blocked');
});

test('#4404 · negativo: appendAudit invocado con {path,motivo,pattern} al bloquear', async () => {
    const { impl, state } = fakeHttp({ status: 200 });
    const auditCalls = [];
    // drfImpl que delega en el filtro real pero espía appendAudit. El bloqueo
    // sigue siendo real (path excluido por el sidecar canónico).
    const realDrf = require('../../data-residency-filter');
    const drfSpy = {
        loadExclusionsOrThrow: (...a) => realDrf.loadExclusionsOrThrow(...a),
        filterPathsForProvider: (...a) => realDrf.filterPathsForProvider(...a),
        appendAudit: (arg) => { auditCalls.push(arg); return { written: (arg.blocked || []).length }; },
    };
    const r = await completion.complete({
        provider: 'cerebras',
        model: 'gpt-oss-120b',
        prompt: 'x',
        paths: ['config/secrets/service-account.json'],
        secretsPath: keyFileForCerebras(),
        httpImpl: impl,
        drfImpl: drfSpy,
    });
    assert.equal(state.dispatched, false);
    assert.equal(r.ok, false);
    assert.equal(r.error.type, 'data_residency_blocked');
    assert.equal(auditCalls.length, 1, 'appendAudit debe invocarse exactamente una vez');
    const blocked = auditCalls[0].blocked;
    assert.ok(Array.isArray(blocked) && blocked.length > 0);
    for (const b of blocked) {
        assert.ok(typeof b.path === 'string' && b.path.length > 0, 'blocked incluye path');
        assert.ok(typeof b.motivo === 'string' && b.motivo.length > 0, 'blocked incluye motivo');
        assert.ok(typeof b.pattern === 'string' && b.pattern.length > 0, 'blocked incluye pattern');
    }
});

// ─── (3) Sidecar inválido → fail-closed sin dispatch ────────────────────────

test('#4404 · sidecar inválido (loadExclusionsOrThrow lanza) → data_residency_blocked, sin dispatch', async () => {
    const { impl, state } = fakeHttp({ status: 200 });
    const drfBroken = {
        loadExclusionsOrThrow() { throw new Error('[data-residency] FAIL-CLOSED: sidecar corrupto'); },
        filterPathsForProvider() { throw new Error('no debería llamarse'); },
        appendAudit() { throw new Error('no debería llamarse'); },
    };
    const r = await completion.complete({
        provider: 'cerebras',
        model: 'gpt-oss-120b',
        prompt: 'x',
        paths: ['README.md'],
        secretsPath: keyFileForCerebras(),
        httpImpl: impl,
        drfImpl: drfBroken,
    });
    assert.equal(state.dispatched, false, 'sin sidecar evaluable NO se despacha (fail-closed)');
    assert.equal(r.ok, false);
    assert.equal(r.error.type, 'data_residency_blocked');
    assert.match(r.error.detail, /sidecar data-residency no evaluable/);
});

// ─── (4) filterPathsForProvider lanza → fail-closed ─────────────────────────

test('#4404 · filterPathsForProvider lanza → data_residency_blocked, sin dispatch', async () => {
    const { impl, state } = fakeHttp({ status: 200 });
    const drfThrow = {
        loadExclusionsOrThrow() { return { exclusions: [], default_policy: {} }; },
        filterPathsForProvider() { throw new Error('argumentos inválidos'); },
        appendAudit() {},
    };
    const r = await completion.complete({
        provider: 'cerebras',
        model: 'gpt-oss-120b',
        prompt: 'x',
        paths: ['README.md'],
        secretsPath: keyFileForCerebras(),
        httpImpl: impl,
        drfImpl: drfThrow,
    });
    assert.equal(state.dispatched, false);
    assert.equal(r.ok, false);
    assert.equal(r.error.type, 'data_residency_blocked');
    assert.match(r.error.detail, /filtro data-residency falló/);
});

// =============================================================================
// multi-provider-live-ping.test.js — Tests del módulo live-ping (#3177 SSRF).
// No hacemos requests reales: stubeamos httpImpl para verificar comportamiento.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const livePing = require('../multi-provider/live-ping');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mp-ping-')); }
function writeKeys(file, keys) { fs.writeFileSync(file, JSON.stringify(keys)); }

function fakeHttp({ status = 200, body = '' } = {}) {
    return {
        request(opts, cb) {
            const req = {
                _writes: [],
                on(ev, fn) { this[`_${ev}`] = fn; return this; },
                write(chunk) { this._writes.push(chunk); },
                end() {
                    process.nextTick(() => {
                        const res = {
                            statusCode: status,
                            on(ev, fn) {
                                if (ev === 'data') fn(Buffer.from(body, 'utf8'));
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
}

test('isAllowedProvider acepta solo los providers conocidos', () => {
    assert.equal(livePing.isAllowedProvider('anthropic'), true);
    assert.equal(livePing.isAllowedProvider('openai'), true);
    assert.equal(livePing.isAllowedProvider('elevenlabs'), true);
    assert.equal(livePing.isAllowedProvider('attacker.com'), false);
    assert.equal(livePing.isAllowedProvider('file://etc/passwd'), false);
    assert.equal(livePing.isAllowedProvider(''), false);
});

test('ping devuelve unknown_provider para providers no allowlisted', async () => {
    const r = await livePing.ping({ provider: 'attacker.com' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unknown_provider');
});

test('ping devuelve no_key_configured cuando falta la key', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, {});
    const r = await livePing.ping({ provider: 'openai', secretsPath: f });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_key_configured');
});

test('ping OpenAI con status 200 devuelve authenticated', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, { openai_api_key: 'sk-test-1234567890abcdef0000' });
    const r = await livePing.ping({ provider: 'openai', secretsPath: f, httpImpl: fakeHttp({ status: 200 }) });
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'authenticated');
    assert.equal(r.provider, 'openai');
});

test('ping OpenAI con status 401 devuelve invalid_credentials', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, { openai_api_key: 'sk-test-1234567890abcdef0000' });
    const r = await livePing.ping({ provider: 'openai', secretsPath: f, httpImpl: fakeHttp({ status: 401 }) });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid_credentials');
});

test('ping OpenAI con status 429 devuelve quota_exhausted', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, { openai_api_key: 'sk-test-1234567890abcdef0000' });
    const r = await livePing.ping({ provider: 'openai', secretsPath: f, httpImpl: fakeHttp({ status: 429 }) });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'quota_exhausted');
});

test('ping Anthropic con status 429 + cuerpo usage_limit devuelve quota_exhausted', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, { anthropic_api_key: 'sk-ant-1234567890abcdef0000' });
    const r = await livePing.ping({
        provider: 'anthropic',
        secretsPath: f,
        httpImpl: fakeHttp({ status: 429, body: '{"error":{"type":"usage_limit_error"}}' }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'quota_exhausted');
});

test('ping Anthropic con status 429 + cuerpo plain devuelve rate_limited', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    writeKeys(f, { anthropic_api_key: 'sk-ant-1234567890abcdef0000' });
    const r = await livePing.ping({
        provider: 'anthropic',
        secretsPath: f,
        httpImpl: fakeHttp({ status: 429, body: '{"error":{"type":"rate_limit_exceeded"}}' }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'rate_limited');
});

test('ping no expone la API key cruda en la respuesta', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'config.json');
    const secretKey = 'sk-test-VERY-SECRET-DO-NOT-LEAK-12345';
    writeKeys(f, { openai_api_key: secretKey });
    const r = await livePing.ping({ provider: 'openai', secretsPath: f, httpImpl: fakeHttp({ status: 401 }) });
    const serialized = JSON.stringify(r);
    assert.equal(serialized.includes('VERY-SECRET'), false, 'la respuesta no debe filtrar la key');
});

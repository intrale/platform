// =============================================================================
// Tests redact.js — CA-6 / CA-17 / CA-18
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    redactSensitive,
    redactHeaders,
    redactEmail,
    redactEmailsInText,
    redactUrlLike,
    redactStack,
    redactError,
    isSensitiveHeader,
    REDACTION_MARKER,
} = require('../redact');

test('CA-6 · headers: Authorization, Cookie, Set-Cookie, X-Api-Key, X-Amz-*, Proxy-Authorization', () => {
    const headers = {
        authorization: 'Bearer supersecrettoken',
        cookie: 'session=abc',
        'set-cookie': ['a=1', 'b=2'],
        'x-api-key': 'key-xyz',
        'x-amz-security-token': 'aws-token',
        'x-amz-date': '20260417T000000Z',
        'proxy-authorization': 'Basic dXNlcjpwYXNz',
        'content-type': 'application/json', // no sensible
    };
    const out = redactHeaders(headers);
    assert.equal(out.authorization, REDACTION_MARKER);
    assert.equal(out.cookie, REDACTION_MARKER);
    assert.deepEqual(out['set-cookie'], [REDACTION_MARKER, REDACTION_MARKER]);
    assert.equal(out['x-api-key'], REDACTION_MARKER);
    assert.equal(out['x-amz-security-token'], REDACTION_MARKER);
    assert.equal(out['x-amz-date'], REDACTION_MARKER);
    assert.equal(out['proxy-authorization'], REDACTION_MARKER);
    assert.equal(out['content-type'], 'application/json');
});

test('CA-6 · marker visible NO vacío, no *** sin contexto', () => {
    const out = redactHeaders({ authorization: 'x' });
    assert.equal(out.authorization, '[REDACTED]');
    assert.notEqual(out.authorization, '');
    assert.notEqual(out.authorization, '***');
});

test('CA-6 · isSensitiveHeader case-insensitive + prefix X-Amz-', () => {
    assert.equal(isSensitiveHeader('Authorization'), true);
    assert.equal(isSensitiveHeader('AUTHORIZATION'), true);
    assert.equal(isSensitiveHeader('X-Amz-Security-Token'), true);
    assert.equal(isSensitiveHeader('Content-Type'), false);
});

test('CA-6 · JSON body: password, code2FA, otp, refresh_token, id_token, access_token, secret, apiKey', () => {
    const body = {
        user: 'leo',
        password: 'top',
        code2FA: '123456',
        otp: '987',
        refresh_token: 'r',
        id_token: 'i',
        access_token: 'a',
        secret: 's',
        apiKey: 'k',
        nested: { password: 'inner' },
    };
    const out = redactSensitive(body);
    assert.equal(out.user, 'leo');
    assert.equal(out.password, REDACTION_MARKER);
    assert.equal(out.code2FA, REDACTION_MARKER);
    assert.equal(out.otp, REDACTION_MARKER);
    assert.equal(out.refresh_token, REDACTION_MARKER);
    assert.equal(out.id_token, REDACTION_MARKER);
    assert.equal(out.access_token, REDACTION_MARKER);
    assert.equal(out.secret, REDACTION_MARKER);
    assert.equal(out.apiKey, REDACTION_MARKER);
    assert.equal(out.nested.password, REDACTION_MARKER);
});

test('CA-6 · emails: us***@dom***.com', () => {
    assert.equal(redactEmail('leito.larreta@gmail.com'), 'le***@gm***.com');
    assert.equal(redactEmail('a@b.co'), 'a***@b***.co');
    // Dentro de texto libre
    const t = redactEmailsInText('Usuario leito.larreta@gmail.com no encontrado');
    assert.ok(t.includes('le***@gm***.com'));
    assert.ok(!t.includes('larreta@gmail'));
});

test('CA-6 · stack traces con rutas absolutas truncadas', () => {
    const stack = [
        'Error: boom',
        '    at Foo (C:\\Workspaces\\Intrale\\platform\\.pipeline\\lib\\http-client.js:42:13)',
        '    at Bar (/home/user/project/foo/bar.js:10:5)',
    ].join('\n');
    const out = redactStack(stack);
    assert.ok(out.includes('…/http-client.js:42:13'));
    assert.ok(out.includes('…/bar.js:10:5'));
    assert.ok(!out.includes('C:\\Workspaces'));
    assert.ok(!out.includes('/home/user'));
});

test('CA-17 · redacción query string: token, access_token, api_key, otp, signature', () => {
    const url = 'https://api.com/x?token=abc123&access_token=xyz&api_key=k&user=leo&otp=9&sig=z';
    const out = redactUrlLike(url);
    assert.ok(out.includes(`token=${REDACTION_MARKER}`));
    assert.ok(out.includes(`access_token=${REDACTION_MARKER}`));
    assert.ok(out.includes(`api_key=${REDACTION_MARKER}`));
    assert.ok(out.includes(`otp=${REDACTION_MARKER}`));
    assert.ok(out.includes(`sig=${REDACTION_MARKER}`));
    assert.ok(out.includes('user=leo'));
    assert.ok(!out.includes('abc123'));
});

test('CA-17 · keys sensibles keep-case: access_token / accessToken / AccessToken', () => {
    const url = 'https://api.com/?accessToken=secret&AccessToken=othersecret';
    const out = redactUrlLike(url);
    assert.ok(!out.includes('secret'));
    assert.ok(!out.includes('othersecret'));
});

test('CA-18 · error.message con URL+token se redacta', () => {
    const err = new Error('request failed: https://api.com?token=abc123');
    const out = redactError(err);
    assert.ok(out.message.includes(REDACTION_MARKER));
    assert.ok(!out.message.includes('abc123'));
});

test('CA-18 · redactSensitive polimórfico acepta Error', () => {
    const err = new Error('Bearer xyz leaked');
    err.code = 'E_XYZ';
    err.config = { url: 'https://api.com?secret=leaked', headers: { authorization: 'Bearer x' } };
    const out = redactSensitive(err);
    assert.equal(out.name, 'Error');
    assert.equal(out.code, 'E_XYZ');
    assert.equal(out.config.headers.authorization, REDACTION_MARKER);
    assert.ok(!out.config.url.includes('leaked'));
    assert.ok(out.config.url.includes(REDACTION_MARKER));
});

test('SEC-3 · URL con userinfo se strippea antes de loguear', () => {
    const url = 'https://user:pass@example.com/path';
    const out = redactUrlLike(url);
    assert.ok(!out.includes('user:pass'));
    assert.ok(out.includes(`${REDACTION_MARKER}@`));
});

test('redactSensitive · ciclos no revientan', () => {
    const a = { password: 'x' };
    a.self = a;
    const out = redactSensitive(a);
    assert.equal(out.password, REDACTION_MARKER);
    assert.equal(out.self, '[CIRCULAR]');
});

test('redactHeaders · no muta el input original', () => {
    const input = { authorization: 'Bearer xyz' };
    const out = redactHeaders(input);
    assert.equal(input.authorization, 'Bearer xyz');
    assert.equal(out.authorization, REDACTION_MARKER);
});

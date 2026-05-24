// =============================================================================
// http-error-classifier.test.js — Tests del clasificador HTTP universal (#3486).
//
// Cobertura mínima exigida por CA del PO + análisis de seguridad:
//   1. Happy path (2xx, 402, 429-quota, 429-rate)               — CA-1, CA-5
//   2. Validación de inputs (null, "abc", provider desconocido) — CA-2
//   3. Permisos 401/403 NO marcados como cuota                  — CA-3, SR-4
//   4. Edge cases (body 100KB, 5xx transitorio, 400 Gemini)     — CA-5
//   5. Info-leak: detail pasa por redact, body raw no leaks     — CA-6, SR-2
//   6. Inmutabilidad del provider param                         — CA-10, SR-5
//   7. Audit metadata (classifierVersion presente)              — CA-8, SR-6
//
// Implementado con node:test (built-in, sin dependencias externas — SR-7).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    classifyHttpError,
    CLASSIFIER_VERSION,
    MAX_BODY_BYTES,
    DETAIL_MAX_BYTES,
    QUOTA_BODY_PATTERN,
    _truncateBody,
} = require('../http-error-classifier');

// ─── Helper para validar el shape estable ──────────────────────────────────

function assertShape(result) {
    assert.equal(typeof result, 'object', 'result debe ser objeto');
    assert.notEqual(result, null, 'result no debe ser null');
    assert.ok('category' in result, 'category requerido');
    assert.ok('reason' in result, 'reason requerido');
    assert.ok('isQuotaError' in result, 'isQuotaError requerido');
    assert.ok('httpStatus' in result, 'httpStatus requerido');
    assert.ok('classifierVersion' in result, 'classifierVersion requerido');
    assert.equal(result.classifierVersion, CLASSIFIER_VERSION);
    assert.equal(typeof result.isQuotaError, 'boolean');
}

// ─── 1. Happy path ─────────────────────────────────────────────────────────

test('200 OK → success/ok, isQuotaError false', () => {
    const r = classifyHttpError(200, '{"ok":true}', 'gemini-google');
    assertShape(r);
    assert.equal(r.category, 'success');
    assert.equal(r.reason, 'ok');
    assert.equal(r.isQuotaError, false);
    assert.equal(r.httpStatus, 200);
});

test('204 No Content → success/ok', () => {
    const r = classifyHttpError(204, '', 'cerebras');
    assert.equal(r.category, 'success');
    assert.equal(r.reason, 'ok');
    assert.equal(r.isQuotaError, false);
});

test('402 Payment Required → billing/quota_exhausted, isQuotaError true', () => {
    const r = classifyHttpError(402, '{"type":"usage_limit_error"}', 'anthropic');
    assertShape(r);
    assert.equal(r.category, 'billing');
    assert.equal(r.reason, 'quota_exhausted');
    assert.equal(r.isQuotaError, true);
    assert.equal(r.httpStatus, 402);
});

test('429 con marcador de quota en body → billing/quota_exhausted', () => {
    const r = classifyHttpError(429, '{"error":{"type":"usage_limit_error"}}', 'anthropic');
    assert.equal(r.category, 'billing');
    assert.equal(r.reason, 'quota_exhausted');
    assert.equal(r.isQuotaError, true);
    assert.equal(r.httpStatus, 429);
});

test('429 sin marcador de quota → rate_limit/rate_limited', () => {
    const r = classifyHttpError(429, '{"error":"rate limit exceeded"}', 'cerebras');
    assert.equal(r.category, 'rate_limit');
    assert.equal(r.reason, 'rate_limited');
    // isQuotaError es true para ambos casos de 429 — el caller decide si
    // pausar permanentemente (billing) o reintentar con backoff (rate_limit).
    // El PO definió isQuotaError true en ambos para preservar la semántica
    // existente del pipeline.
    assert.equal(r.isQuotaError, true);
});

test('429 con insufficient_quota (codex) → billing/quota_exhausted', () => {
    const r = classifyHttpError(429, '{"error":{"code":"insufficient_quota"}}', 'openai-codex');
    assert.equal(r.category, 'billing');
    assert.equal(r.reason, 'quota_exhausted');
    assert.equal(r.isQuotaError, true);
});

// ─── 2. Validación de inputs (CA-2 / SR-5) ─────────────────────────────────

test('statusCode null → unknown/unclassified sin tirar', () => {
    const r = classifyHttpError(null, null, 'anthropic');
    assertShape(r);
    assert.equal(r.category, 'unknown');
    assert.equal(r.reason, 'unclassified');
    assert.equal(r.isQuotaError, false);
    assert.equal(r.httpStatus, null);
});

test('statusCode undefined → unknown sin tirar', () => {
    const r = classifyHttpError(undefined, null, 'anthropic');
    assert.equal(r.category, 'unknown');
    assert.equal(r.reason, 'unclassified');
});

test('statusCode "abc" → unknown sin tirar', () => {
    const r = classifyHttpError('abc', null, 'anthropic');
    assert.equal(r.category, 'unknown');
    assert.equal(r.reason, 'unclassified');
    assert.equal(r.httpStatus, null);
});

test('statusCode "429" como string → clasifica igual que 429 number', () => {
    // Algunos drivers HTTP devuelven statusCode como string.
    const r = classifyHttpError('429', '{"error":"rate"}', 'cerebras');
    assert.equal(r.category, 'rate_limit');
    assert.equal(r.httpStatus, 429);
});

test('statusCode NaN → unknown', () => {
    const r = classifyHttpError(NaN, null, 'anthropic');
    assert.equal(r.category, 'unknown');
});

test('statusCode fuera de rango HTTP (600) → unknown', () => {
    const r = classifyHttpError(600, null, 'anthropic');
    assert.equal(r.category, 'unknown');
});

test('provider desconocido NO rompe clasificación', () => {
    const r = classifyHttpError(429, null, 'mistral-ai-future');
    assert.equal(r.category, 'rate_limit');
    assert.equal(r.reason, 'rate_limited');
});

test('provider null/undefined NO rompe clasificación', () => {
    const r1 = classifyHttpError(429, null, null);
    const r2 = classifyHttpError(429, null, undefined);
    assert.equal(r1.category, 'rate_limit');
    assert.equal(r2.category, 'rate_limit');
});

// ─── 3. Permisos 401/403 (CA-3 / SR-4) ─────────────────────────────────────

test('401 Unauthorized → auth/invalid_credentials, isQuotaError false', () => {
    const r = classifyHttpError(401, '{"error":"API key invalid"}', 'openai-codex');
    assert.equal(r.category, 'auth');
    assert.equal(r.reason, 'invalid_credentials');
    assert.equal(r.isQuotaError, false);
    assert.equal(r.httpStatus, 401);
});

test('403 Forbidden → auth/forbidden, isQuotaError false', () => {
    const r = classifyHttpError(403, '{"error":"forbidden"}', 'gemini-google');
    assert.equal(r.category, 'auth');
    assert.equal(r.reason, 'forbidden');
    assert.equal(r.isQuotaError, false);
});

test('401 NUNCA se reclasifica como cuota — defensa SR-4', () => {
    // Atacante que pase un provider string malicioso no puede cambiar la
    // clasificación HTTP base.
    const r = classifyHttpError(401, '{"error":"quota_exhausted_fake"}', 'providerMalicioso');
    assert.equal(r.category, 'auth');
    assert.equal(r.reason, 'invalid_credentials');
    assert.equal(r.isQuotaError, false);
});

// ─── 4. Edge cases ─────────────────────────────────────────────────────────

test('5xx Service Unavailable → transient/server_error, NO marca cuota', () => {
    const r = classifyHttpError(503, '{"error":"service unavailable"}', 'nvidia-nim');
    assert.equal(r.category, 'transient');
    assert.equal(r.reason, 'server_error');
    assert.equal(r.isQuotaError, false);
});

test('500 Internal Server Error → transient/server_error', () => {
    const r = classifyHttpError(500, null, 'anthropic');
    assert.equal(r.category, 'transient');
    assert.equal(r.reason, 'server_error');
});

test('502 Bad Gateway → transient/server_error', () => {
    const r = classifyHttpError(502, null, 'gemini-google');
    assert.equal(r.category, 'transient');
});

test('400 con API_KEY_INVALID (Gemini) → auth/invalid_credentials', () => {
    const r = classifyHttpError(400, '{"error":{"message":"API key not valid"}}', 'gemini-google');
    assert.equal(r.category, 'auth');
    assert.equal(r.reason, 'invalid_credentials');
});

test('400 sin marcador especial → unknown (no clasificamos como transient)', () => {
    const r = classifyHttpError(400, '{"error":"invalid_request"}', 'gemini-google');
    assert.equal(r.category, 'unknown');
});

test('body de 100KB NO rompe ni explota — anti-DoS', () => {
    // Body de 100KB con marcador de quota al final. Debe truncar a MAX_BODY_BYTES
    // (16KB) antes de aplicar regex. Como el marcador queda fuera del primer
    // 16KB, NO debe matchear quota — debe caer a rate_limited.
    const padding = 'x'.repeat(100000 - 50);
    const bodyGrande = padding + ' insufficient_quota at the end';
    const t0 = Date.now();
    const r = classifyHttpError(429, bodyGrande, 'cerebras');
    const dt = Date.now() - t0;
    assert.equal(r.category, 'rate_limit'); // marcador quedó fuera del truncado
    assert.ok(dt < 100, `clasificador debe tardar <100ms con body 100KB (tardó ${dt}ms)`);
});

test('body de 100KB con marcador en los primeros 16KB → billing/quota', () => {
    // Marcador al inicio del body: debe matchear quota incluso si el body total
    // es enorme (el truncado preserva el prefijo).
    const bodyGrande = '{"error":{"type":"usage_limit_error"}}' + 'x'.repeat(100000);
    const r = classifyHttpError(429, bodyGrande, 'anthropic');
    assert.equal(r.category, 'billing');
    assert.equal(r.reason, 'quota_exhausted');
});

test('body como Buffer también se acepta', () => {
    const buf = Buffer.from('{"error":{"type":"usage_limit_error"}}', 'utf8');
    const r = classifyHttpError(429, buf, 'anthropic');
    assert.equal(r.category, 'billing');
    assert.equal(r.reason, 'quota_exhausted');
});

test('body como objeto (no-string) NO rompe, cae a clasificación HTTP pura', () => {
    // Un objeto como body es shape no-string; el clasificador devuelve la
    // clasificación HTTP base sin matchear regex sobre el objeto.
    const r = classifyHttpError(429, { error: 'quota' }, 'anthropic');
    // Sin body matchable, 429 cae a rate_limit (no a billing).
    assert.equal(r.category, 'rate_limit');
});

// ─── 5. Info-leak / sin body raw en output (CA-6 / SR-2) ──────────────────

test('output NO incluye fragmentos del body raw en category/reason', () => {
    const bodyConToken = '{"error":"sk-ant-abc123def456 leaked"}';
    const r = classifyHttpError(402, bodyConToken, 'anthropic');
    // category y reason son códigos canónicos, NO fragmentos del body.
    assert.equal(r.category, 'billing');
    assert.equal(r.reason, 'quota_exhausted');
    // Si el clasificador devuelve `detail`, NO debe incluir el body completo.
    if (r.detail) {
        assert.ok(r.detail.length <= DETAIL_MAX_BYTES,
            `detail capeado a ${DETAIL_MAX_BYTES} bytes (era ${r.detail.length})`);
    }
});

test('detail está capeado a DETAIL_MAX_BYTES (512 bytes)', () => {
    const bodyGrande = 'x'.repeat(5000);
    const r = classifyHttpError(429, bodyGrande, 'cerebras');
    if (r.detail) {
        assert.ok(r.detail.length <= DETAIL_MAX_BYTES);
    }
});

// ─── 6. Inmutabilidad del provider param (CA-10 / SR-5) ────────────────────

test('provider NO puede alterar clasificación HTTP base', () => {
    // Mismo HTTP status con providers distintos → misma clasificación.
    const providers = ['anthropic', 'openai-codex', 'gemini-google',
        'cerebras', 'nvidia-nim', 'providerInventado'];
    const results = providers.map(p => classifyHttpError(401, null, p));
    // Todos deben dar el mismo category/reason/isQuotaError.
    for (const r of results) {
        assert.equal(r.category, 'auth');
        assert.equal(r.reason, 'invalid_credentials');
        assert.equal(r.isQuotaError, false);
    }
});

// ─── 7. Audit metadata (CA-8 / SR-6) ───────────────────────────────────────

test('classifierVersion presente en TODOS los resultados', () => {
    const inputs = [
        [200, ''],
        [402, '{}'],
        [429, '{}'],
        [401, '{}'],
        [503, '{}'],
        [null, null],
        ['abc', null],
        [999, null],
    ];
    for (const [status, body] of inputs) {
        const r = classifyHttpError(status, body, 'anthropic');
        assert.equal(r.classifierVersion, CLASSIFIER_VERSION,
            `version requerida para input statusCode=${status}`);
    }
});

test('httpStatus se preserva en el output cuando es válido', () => {
    const r = classifyHttpError(429, null, 'anthropic');
    assert.equal(r.httpStatus, 429);
    const r2 = classifyHttpError(402, null, 'anthropic');
    assert.equal(r2.httpStatus, 402);
    const r3 = classifyHttpError('200', null, 'cerebras');
    assert.equal(r3.httpStatus, 200);
});

test('httpStatus es null cuando statusCode inválido', () => {
    const r = classifyHttpError(null, null);
    assert.equal(r.httpStatus, null);
    const r2 = classifyHttpError('abc', null);
    assert.equal(r2.httpStatus, null);
});

// ─── 8. Defensa ReDoS del regex de quota ────────────────────────────────────

test('QUOTA_BODY_PATTERN es ReDoS-safe (1MB en <50ms)', () => {
    // Body adversarial: 1MB de "qqqquuuuoootttaa" intercalado para forzar
    // backtracking si el regex tuviera nested quantifiers.
    const adversarial = 'q'.repeat(1024 * 1024);
    const t0 = Date.now();
    QUOTA_BODY_PATTERN.test(adversarial);
    const dt = Date.now() - t0;
    assert.ok(dt < 50, `regex debe correr <50ms con 1MB adversarial (tardó ${dt}ms)`);
});

// ─── 9. truncateBody helper ─────────────────────────────────────────────────

test('_truncateBody trunca strings >MAX_BODY_BYTES', () => {
    const big = 'a'.repeat(MAX_BODY_BYTES * 2);
    const t = _truncateBody(big);
    assert.equal(t.length, MAX_BODY_BYTES);
});

test('_truncateBody preserva strings <=MAX_BODY_BYTES', () => {
    assert.equal(_truncateBody('hello'), 'hello');
    assert.equal(_truncateBody(''), '');
});

test('_truncateBody acepta null/undefined sin tirar', () => {
    assert.equal(_truncateBody(null), '');
    assert.equal(_truncateBody(undefined), '');
});

test('_truncateBody acepta Buffer', () => {
    const buf = Buffer.from('hello buffer', 'utf8');
    assert.equal(_truncateBody(buf), 'hello buffer');
});

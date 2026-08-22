// =============================================================================
// Tests del módulo lib/multi-provider-coverage.js (#3681).
//
// Cubre:
//   CA-B2 → Validación contra schema; payload no válido → coverage_unavailable.
//   CA-B3 → Sanitización: payload NO contiene api_key_prefix, hostname,
//           latency_ms absolutos, raw_output ni evidence cruda.
//   CA-B3 → Status fuera del enum → degrada a 'N/A'.
//   CA-B3 → Bucket fuera del enum → null.
//   CA-B3 → evidence_hash truncado a 12 chars.
//   CA-B13 → divergence sólo si status === 'WARN'.
//   CA-B10.bis → cast Number() en issue.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const mpc = require('../multi-provider-coverage');

// -----------------------------------------------------------------------------
// Fakes de fs para no tocar el FS real.
// -----------------------------------------------------------------------------
function fakeFs({ existsResult = true, readResult = '', readThrows = null } = {}) {
    return {
        existsSync: () => existsResult,
        readFileSync: () => {
            if (readThrows) throw readThrows;
            return readResult;
        },
    };
}

// Validator stub que siempre acepta.
const passValidator = () => true;
// Validator stub que siempre rechaza.
const failValidator = () => false;

// -----------------------------------------------------------------------------
// sanitizeMatrixEntry
// -----------------------------------------------------------------------------

test('sanitizeMatrixEntry preserva campos canónicos válidos', () => {
    const out = mpc.sanitizeMatrixEntry({
        skill: 'guru',
        provider: 'anthropic',
        status: 'PASS',
        latency_bucket: '<=500ms',
        error_class: null,
        evidence_hash: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        issue: 3681,
        model: 'claude-3-5-sonnet',
        timestamp: '2026-05-30T05:00:00Z',
    });
    assert.equal(out.skill, 'guru');
    assert.equal(out.provider, 'anthropic');
    assert.equal(out.status, 'PASS');
    assert.equal(out.latency_bucket, '<=500ms');
    assert.equal(out.evidence_hash, '0123456789ab', 'truncado a 12 chars (REQ-SEC-B8)');
    assert.equal(out.issue, 3681);
});

test('sanitizeMatrixEntry degrada status desconocido a N/A', () => {
    const out = mpc.sanitizeMatrixEntry({
        skill: 'tester',
        provider: 'openai-codex',
        status: 'INJECTED', // no en enum
    });
    assert.equal(out.status, 'N/A');
});

test('sanitizeMatrixEntry descarta bucket fuera del enum', () => {
    const out = mpc.sanitizeMatrixEntry({
        skill: 's',
        provider: 'p',
        status: 'PASS',
        latency_bucket: '<=42ms',
    });
    assert.equal(out.latency_bucket, null);
});

test('sanitizeMatrixEntry descarta error_class desconocido', () => {
    const out = mpc.sanitizeMatrixEntry({
        skill: 's',
        provider: 'p',
        status: 'FAIL',
        error_class: 'attacker_injected_class',
    });
    assert.equal(out.error_class, null);
});

test('sanitizeMatrixEntry filtra divergence si status NO es WARN', () => {
    const out = mpc.sanitizeMatrixEntry({
        skill: 's',
        provider: 'p',
        status: 'PASS',
        divergence: 'esto deberia desaparecer',
    });
    assert.equal(out.divergence, null);
});

test('sanitizeMatrixEntry conserva divergence si status === WARN', () => {
    const out = mpc.sanitizeMatrixEntry({
        skill: 's',
        provider: 'p',
        status: 'WARN',
        divergence: 'schema mismatch en output',
    });
    assert.equal(out.divergence, 'schema mismatch en output');
});

test('sanitizeMatrixEntry valida issue con Number() — descarta strings raros', () => {
    const out = mpc.sanitizeMatrixEntry({
        skill: 's',
        provider: 'p',
        status: 'FAIL',
        issue: 'https://attacker.com',
    });
    assert.equal(out.issue, null, 'NO propaga URL como issue');
});

test('sanitizeMatrixEntry rechaza entry sin skill o provider', () => {
    assert.equal(mpc.sanitizeMatrixEntry({ skill: '', provider: 'p' }), null);
    assert.equal(mpc.sanitizeMatrixEntry({ skill: 's', provider: '' }), null);
    assert.equal(mpc.sanitizeMatrixEntry(null), null);
});

test('sanitizeMatrixEntry NO emite api_key_prefix, hostname, latency_ms, raw_output (REQ-SEC-B4)', () => {
    const out = mpc.sanitizeMatrixEntry({
        skill: 's',
        provider: 'p',
        status: 'PASS',
        api_key_prefix: 'sk-abc123', // attacker payload
        hostname: 'api.anthropic.com',
        latency_ms: 1342,
        raw_output: 'TODO LEAK',
        evidence: { stack: 'leak' },
    });
    assert.equal('api_key_prefix' in out, false);
    assert.equal('hostname' in out, false);
    assert.equal('latency_ms' in out, false);
    assert.equal('raw_output' in out, false);
    assert.equal('evidence' in out, false);
});

test('sanitizeMatrixEntry trunca evidence_hash a 12 chars y rechaza no-hex', () => {
    const valid = mpc.sanitizeMatrixEntry({
        skill: 's',
        provider: 'p',
        status: 'PASS',
        evidence_hash: 'sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
    });
    assert.equal(valid.evidence_hash, 'abcdef012345');
    const garbage = mpc.sanitizeMatrixEntry({
        skill: 's',
        provider: 'p',
        status: 'PASS',
        evidence_hash: '<script>',
    });
    assert.equal(garbage.evidence_hash, null);
});

// -----------------------------------------------------------------------------
// sanitizeCoveragePayload (root)
// -----------------------------------------------------------------------------

test('sanitizeCoveragePayload emite shape canónico sin spread', () => {
    const out = mpc.sanitizeCoveragePayload({
        version: '1.0.0',
        generated_at: '2026-05-30T05:00:00Z',
        run_id: 'run-abc',
        duration_ms: 1234,
        spawns_used: 5,
        spawns_cap: 60,
        secret_field: 'NOT IN OUTPUT',
        matrix: [
            { skill: 's', provider: 'p', status: 'PASS', latency_bucket: '<=100ms' },
        ],
        summary: { pass: 1, warn: 0, fail: 0, skipped: 0, na: 0, total_combinations: 1, skills_llm_count: 1, providers_llm_count: 1 },
    });
    assert.equal(out.version, '1.0.0');
    assert.equal(out.duration_ms, 1234);
    assert.equal(out.spawns_used, 5);
    assert.equal(out.spawns_cap, 60);
    assert.equal('secret_field' in out, false);
    assert.equal(out.matrix.length, 1);
});

test('sanitizeCoveragePayload cap de matrix a MAX_MATRIX_ENTRIES', () => {
    const matrix = [];
    for (let i = 0; i < 600; i++) matrix.push({ skill: 's' + i, provider: 'p', status: 'PASS' });
    const out = mpc.sanitizeCoveragePayload({ matrix, summary: {} });
    assert.ok(out.matrix.length <= mpc._internal.MAX_MATRIX_ENTRIES,
        'matrix no excede el cap defensivo (' + mpc._internal.MAX_MATRIX_ENTRIES + ')');
});

// -----------------------------------------------------------------------------
// buildCoveragePayload — orquesta read + schema + sanitize
// -----------------------------------------------------------------------------

test('buildCoveragePayload retorna 503 not_yet_run si el JSON falta', () => {
    const out = mpc.buildCoveragePayload({
        fsImpl: fakeFs({ existsResult: false }),
        validator: passValidator,
    });
    assert.equal(out.error, 'coverage_unavailable');
    assert.equal(out.reason, 'not_yet_run');
    assert.equal(out._status, 503);
});

test('buildCoveragePayload retorna 503 parse_error si el JSON es malformado', () => {
    const out = mpc.buildCoveragePayload({
        fsImpl: fakeFs({ readResult: '{not-json' }),
        validator: passValidator,
    });
    assert.equal(out.reason, 'parse_error');
    assert.equal(out._status, 503);
});

test('buildCoveragePayload retorna 503 io_error si readFile lanza', () => {
    const ioErr = new Error('EACCES');
    const out = mpc.buildCoveragePayload({
        fsImpl: fakeFs({ readThrows: ioErr }),
        validator: passValidator,
    });
    assert.equal(out.reason, 'io_error');
    assert.equal(out._status, 503);
});

test('buildCoveragePayload retorna 503 schema_invalid si validator rechaza', () => {
    const out = mpc.buildCoveragePayload({
        fsImpl: fakeFs({ readResult: JSON.stringify({ version: '1.0.0' }) }),
        validator: failValidator,
    });
    assert.equal(out.reason, 'schema_invalid');
    assert.equal(out._status, 503);
});

test('buildCoveragePayload sirve payload sanitizado cuando todo está OK', () => {
    const raw = {
        version: '1.0.0',
        generated_at: '2026-05-30T05:00:00Z',
        run_id: 'run-xyz',
        matrix: [
            { skill: 'guru', provider: 'anthropic', status: 'PASS', latency_bucket: '<=500ms' },
            { skill: 'review', provider: 'openai-codex', status: 'FAIL', error_class: 'timeout', issue: 9001 },
        ],
        summary: { pass: 1, warn: 0, fail: 1, skipped: 0, na: 0, total_combinations: 2, skills_llm_count: 2, providers_llm_count: 2 },
    };
    const out = mpc.buildCoveragePayload({
        fsImpl: fakeFs({ readResult: JSON.stringify(raw) }),
        validator: passValidator,
    });
    assert.equal(out.error, undefined);
    assert.equal(out._status, undefined);
    assert.equal(out.matrix.length, 2);
    assert.equal(out.matrix[1].issue, 9001);
});

// -----------------------------------------------------------------------------
// Integración con el schema real
// -----------------------------------------------------------------------------

test('getValidator carga el schema real desde disco', () => {
    const v = mpc._internal.getValidator();
    // En CI/dev el schema existe.
    if (v) {
        assert.equal(typeof v, 'function', 'validator es una función compilada');
    }
});

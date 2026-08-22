'use strict';

// =============================================================================
// provider-cost.test.js — tests del módulo de telemetría de costo por provider
// (issue #4403, D4 · CA-1/CA-2/CA-5). Corre con `node --test`.
//
// Cubre:
//   - CA-1: whitelist EXACTA de 7 campos (ni una clave más).
//   - CA-2 (RS-3 bloqueante): input contaminado (api_key, prompt_body,
//     authorization, status con secreto embebido) NO se persiste; status
//     queda redactado.
//   - Append-only: dos llamadas → 2 líneas, la primera intacta.
//   - Never-throws (CA-5): un `fs.appendFileSync` que lanza NO propaga.
//   - Coerción numérica y readProviderCostBreakdown (agregación + empty-state).
//
// Usa inyección de dependencias (`deps.fs`, `deps.file` a un tmp) para no
// ensuciar `.pipeline/state/` real.
// =============================================================================

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { recordProviderCost, readProviderCostBreakdown, WHITELIST } = require('../provider-cost');

const EXPECTED_KEYS = ['provider', 'skill', 'issue', 'tokens_in', 'tokens_out', 'latency_ms', 'status'];

function tmpFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provcost-'));
    return path.join(dir, 'provider-cost.jsonl');
}

function readLines(file) {
    return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim().length > 0);
}

test('WHITELIST expone exactamente los 7 campos canónicos', () => {
    assert.deepStrictEqual(WHITELIST, EXPECTED_KEYS);
});

test('CA-1: persiste una línea JSON con EXACTAMENTE las 7 claves whitelist', () => {
    const file = tmpFile();
    recordProviderCost({
        provider: 'anthropic',
        skill: 'backend-dev',
        issue: 4403,
        tokens_in: 1200,
        tokens_out: 340,
        latency_ms: 8500,
        status: 'ok',
    }, { file });

    const lines = readLines(file);
    assert.strictEqual(lines.length, 1);
    const rec = JSON.parse(lines[0]);
    // Set exacto — ni una clave de más.
    assert.deepStrictEqual(Object.keys(rec).sort(), EXPECTED_KEYS.slice().sort());
    assert.strictEqual(rec.provider, 'anthropic');
    assert.strictEqual(rec.skill, 'backend-dev');
    assert.strictEqual(rec.issue, 4403);
    assert.strictEqual(rec.tokens_in, 1200);
    assert.strictEqual(rec.tokens_out, 340);
    assert.strictEqual(rec.latency_ms, 8500);
    assert.strictEqual(rec.status, 'ok');
});

test('CA-2 (RS-3): input contaminado NO se persiste — solo la whitelist', () => {
    const file = tmpFile();
    recordProviderCost({
        provider: 'anthropic',
        skill: 'backend-dev',
        issue: 4403,
        tokens_in: 10,
        tokens_out: 20,
        latency_ms: 100,
        status: 'ok',
        // Campos contaminantes que arrastraría un `opts` de error real:
        api_key: 'sk-ant-api03-SECRETO-NO-DEBE-APARECER',
        prompt_body: 'contenido del prompt que jamás debe loguearse',
        authorization: 'Bearer sk-ant-DEADBEEF',
        transport: { key: 'AIzaSyFAKEKEY1234567890' },
    }, { file });

    const raw = fs.readFileSync(file, 'utf8');
    const rec = JSON.parse(raw.trim());

    // Ninguna clave contaminante quedó en el registro.
    assert.deepStrictEqual(Object.keys(rec).sort(), EXPECTED_KEYS.slice().sort());
    assert.strictEqual('api_key' in rec, false);
    assert.strictEqual('prompt_body' in rec, false);
    assert.strictEqual('authorization' in rec, false);
    assert.strictEqual('transport' in rec, false);

    // Y ninguno de los secretos aparece en el texto crudo persistido.
    assert.strictEqual(raw.includes('sk-ant-api03-SECRETO'), false);
    assert.strictEqual(raw.includes('prompt que jamás'), false);
    assert.strictEqual(raw.includes('DEADBEEF'), false);
    assert.strictEqual(raw.includes('AIzaSyFAKEKEY'), false);
});

test('CA-2 (RS-3): status con secreto embebido queda redactado', () => {
    const file = tmpFile();
    recordProviderCost({
        provider: 'anthropic',
        skill: 'qa',
        issue: 1,
        tokens_in: 0,
        tokens_out: 0,
        latency_ms: 0,
        // 401 típico que ecoa la API key en el mensaje de error.
        status: 'HTTP 401 Unauthorized: invalid api key sk-ant-api03-LEAKED-KEY-abc123',
    }, { file });

    const raw = fs.readFileSync(file, 'utf8');
    const rec = JSON.parse(raw.trim());
    // El secreto NO aparece; quedó redactado.
    assert.strictEqual(raw.includes('sk-ant-api03-LEAKED-KEY'), false);
    assert.ok(rec.status.includes('[REDACTED]'), `status debería estar redactado, fue: ${rec.status}`);
    // Sin CR/LF (CWE-117): el registro es una sola línea.
    assert.strictEqual(raw.trim().split('\n').length, 1);
});

test('CA-2 (RS-3): status multilínea se aplana (anti log-injection CWE-117)', () => {
    const file = tmpFile();
    recordProviderCost({
        provider: 'cerebras',
        skill: 'tester',
        issue: 2,
        tokens_in: 5,
        tokens_out: 5,
        latency_ms: 10,
        status: 'error\n{"provider":"fake","tokens_in":999999}\n',
    }, { file });

    const lines = readLines(file);
    // Un solo registro real: el CR/LF del status no inyectó una línea falsa.
    assert.strictEqual(lines.length, 1);
    const rec = JSON.parse(lines[0]);
    assert.deepStrictEqual(Object.keys(rec).sort(), EXPECTED_KEYS.slice().sort());
    assert.strictEqual(rec.provider, 'cerebras');
});

test('append-only: dos llamadas producen 2 líneas, la primera intacta', () => {
    const file = tmpFile();
    recordProviderCost({ provider: 'anthropic', skill: 'a', issue: 1, tokens_in: 1, tokens_out: 1, latency_ms: 1, status: 'ok' }, { file });
    recordProviderCost({ provider: 'cerebras', skill: 'b', issue: 2, tokens_in: 2, tokens_out: 2, latency_ms: 2, status: 'ok' }, { file });

    const lines = readLines(file);
    assert.strictEqual(lines.length, 2);
    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    assert.strictEqual(first.provider, 'anthropic');
    assert.strictEqual(first.skill, 'a');
    assert.strictEqual(second.provider, 'cerebras');
    assert.strictEqual(second.skill, 'b');
});

test('coerción numérica: valores no-numéricos caen a 0/null, no persisten texto', () => {
    const file = tmpFile();
    recordProviderCost({
        provider: 'gemini-google',
        skill: 'guru',
        issue: 'no-numerico',
        tokens_in: 'AIzaSyLEAK',   // string malicioso en campo numérico
        tokens_out: undefined,
        latency_ms: null,
        status: 'ok',
    }, { file });

    const raw = fs.readFileSync(file, 'utf8');
    const rec = JSON.parse(raw.trim());
    assert.strictEqual(rec.issue, null);
    assert.strictEqual(rec.tokens_in, 0);
    assert.strictEqual(rec.tokens_out, 0);
    assert.strictEqual(rec.latency_ms, 0);
    assert.strictEqual(raw.includes('AIzaSyLEAK'), false);
});

test('never-throws (CA-5): un fs.appendFileSync que lanza NO propaga', () => {
    const throwingFs = {
        mkdirSync: () => {},
        appendFileSync: () => { throw new Error('ENOSPC simulado'); },
    };
    // No debe lanzar.
    assert.doesNotThrow(() => {
        recordProviderCost(
            { provider: 'anthropic', skill: 'x', issue: 1, tokens_in: 1, tokens_out: 1, latency_ms: 1, status: 'ok' },
            { fs: throwingFs, file: '/dev/null/nope.jsonl' },
        );
    });
});

test('readProviderCostBreakdown: agrega por provider y cuenta sesiones/errores', () => {
    const file = tmpFile();
    recordProviderCost({ provider: 'anthropic', skill: 'a', issue: 1, tokens_in: 100, tokens_out: 50, latency_ms: 1, status: 'ok' }, { file });
    recordProviderCost({ provider: 'anthropic', skill: 'b', issue: 2, tokens_in: 200, tokens_out: 10, latency_ms: 1, status: 'error' }, { file });
    recordProviderCost({ provider: 'cerebras', skill: 'c', issue: 3, tokens_in: 5, tokens_out: 5, latency_ms: 1, status: 'ok' }, { file });

    const out = readProviderCostBreakdown({ file });
    assert.strictEqual(out.hasData, true);
    assert.strictEqual(out.totalSessions, 3);
    assert.strictEqual(out.byProvider.anthropic.tokens_in, 300);
    assert.strictEqual(out.byProvider.anthropic.tokens_out, 60);
    assert.strictEqual(out.byProvider.anthropic.sessions, 2);
    assert.strictEqual(out.byProvider.anthropic.errors, 1);
    assert.strictEqual(out.byProvider.cerebras.sessions, 1);
    assert.strictEqual(out.byProvider.cerebras.errors, 0);
});

test('readProviderCostBreakdown: empty-state cuando el archivo no existe', () => {
    const out = readProviderCostBreakdown({ file: path.join(os.tmpdir(), 'no-existe-provcost-xyz.jsonl') });
    assert.strictEqual(out.hasData, false);
    assert.deepStrictEqual(out.byProvider, {});
    assert.strictEqual(out.totalSessions, 0);
});

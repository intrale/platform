// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// =============================================================================
// provider-cost.test.js — tests del módulo de telemetría de costo por provider
// (issue #4403, D4 · CA-1/CA-2/CA-5; #6558 esquema v2). Corre con `node --test`.
//
// Cubre:
//   - CA-1 (#4403): whitelist EXACTA de campos (ni una clave más).
//   - CA-2 (RS-3 bloqueante): input contaminado (api_key, prompt_body,
//     authorization) NO se persiste; texto con secreto queda redactado.
//   - Append-only: dos llamadas → 2 líneas, la primera intacta.
//   - Never-throws (CA-5): un `fs.appendFileSync` que lanza NO propaga.
//   - Coerción numérica y readProviderCostBreakdown (agregación + empty-state).
//   - #6558 CA-1..CA-5: proveedor efectivo, timestamp ISO UTC, fase/resultado,
//     agrupación por día/semana, histórico v1 distinguible y no atribuido.
//
// Usa inyección de dependencias (`deps.fs`, `deps.file` a un tmp) para no
// ensuciar `.pipeline/state/` real.
// =============================================================================

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    recordProviderCost,
    readProviderCostBreakdown,
    readProviderCostRecords,
    readProviderCostByPeriod,
    WHITELIST,
    WHITELIST_V1,
    SCHEMA_VERSION,
    RESULTADOS,
} = require('../provider-cost');

const EXPECTED_KEYS = [
    'schema', 'timestamp', 'provider', 'skill', 'issue', 'fase',
    'tokens_in', 'tokens_out', 'cache_read', 'cache_write', 'duration_ms', 'resultado',
];
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function tmpFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provcost-'));
    return path.join(dir, 'provider-cost.jsonl');
}

function readLines(file) {
    return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim().length > 0);
}

// Línea v1 tal cual la escribía el pulpo antes de #6558 (proveedor declarado,
// sin timestamp). Se usa para simular el histórico.
const V1_LINE = '{"provider":"anthropic","skill":"security","issue":4435,"tokens_in":10058,"tokens_out":400,"latency_ms":264739,"status":"ok"}\n';

test('WHITELIST expone exactamente los 12 campos canónicos del esquema v2', () => {
    assert.deepStrictEqual(WHITELIST, EXPECTED_KEYS);
    assert.strictEqual(SCHEMA_VERSION, 2);
    assert.deepStrictEqual(WHITELIST_V1, ['provider', 'skill', 'issue', 'tokens_in', 'tokens_out', 'latency_ms', 'status']);
    assert.deepStrictEqual(RESULTADOS, ['ganada', 'error', 'rebote', 'abortada']);
});

test('CA-1: persiste una línea JSON con EXACTAMENTE las claves whitelist v2', () => {
    const file = tmpFile();
    recordProviderCost({
        provider: 'anthropic',
        skill: 'backend-dev',
        issue: 4403,
        fase: 'dev',
        tokens_in: 1200,
        tokens_out: 340,
        cache_read: 50,
        cache_write: 7,
        duration_ms: 8500,
        resultado: 'ganada',
    }, { file });

    const lines = readLines(file);
    assert.strictEqual(lines.length, 1);
    const rec = JSON.parse(lines[0]);
    // Set exacto — ni una clave de más.
    assert.deepStrictEqual(Object.keys(rec).sort(), EXPECTED_KEYS.slice().sort());
    assert.strictEqual(rec.schema, 2);
    assert.strictEqual(rec.provider, 'anthropic');
    assert.strictEqual(rec.skill, 'backend-dev');
    assert.strictEqual(rec.issue, 4403);
    assert.strictEqual(rec.fase, 'dev');
    assert.strictEqual(rec.tokens_in, 1200);
    assert.strictEqual(rec.tokens_out, 340);
    assert.strictEqual(rec.cache_read, 50);
    assert.strictEqual(rec.cache_write, 7);
    assert.strictEqual(rec.duration_ms, 8500);
    assert.strictEqual(rec.resultado, 'ganada');
    // `schema` va primero: legible para un humano que hace `head -1`.
    assert.strictEqual(Object.keys(rec)[0], 'schema');
});

test('#6558 CA-1: una corrida ejecutada por Codex queda con provider "openai-codex", no el declarado', () => {
    const file = tmpFile();
    // El caller (pulpo) ya resolvió el efectivo; el módulo lo persiste tal cual.
    recordProviderCost({
        provider: 'openai-codex', skill: 'backend-dev', issue: 6558, fase: 'dev',
        tokens_in: 1234, tokens_out: 567, duration_ms: 390752, resultado: 'ganada',
    }, { file });
    const rec = JSON.parse(readLines(file)[0]);
    assert.strictEqual(rec.provider, 'openai-codex');
    assert.notStrictEqual(rec.provider, 'anthropic');
});

test('#6558 CA-2: toda línea nueva lleva timestamp ISO 8601 en UTC con sufijo Z', () => {
    const file = tmpFile();
    const before = Date.now();
    recordProviderCost({ provider: 'anthropic', skill: 'guru', issue: 1, fase: 'validacion', tokens_in: 1, tokens_out: 1, duration_ms: 1, resultado: 'ganada' }, { file });
    const after = Date.now();
    const rec = JSON.parse(readLines(file)[0]);
    assert.match(rec.timestamp, ISO_UTC_RE);
    const t = new Date(rec.timestamp).getTime();
    assert.ok(t >= before - 1000 && t <= after + 1000, `timestamp fuera de rango: ${rec.timestamp}`);
});

test('#6558 CA-2: timestamp inyectado se normaliza a UTC; inválido cae al reloj', () => {
    const file = tmpFile();
    recordProviderCost({ provider: 'anthropic', skill: 'a', issue: 1, fase: 'dev', resultado: 'ganada', timestamp: '2026-09-21T09:45:00-03:00' }, { file });
    recordProviderCost({ provider: 'anthropic', skill: 'a', issue: 1, fase: 'dev', resultado: 'ganada', timestamp: 'no-es-fecha' }, { file, now: new Date('2026-01-02T03:04:05.006Z') });
    const [a, b] = readLines(file).map(JSON.parse);
    assert.strictEqual(a.timestamp, '2026-09-21T12:45:00.000Z');
    assert.strictEqual(b.timestamp, '2026-01-02T03:04:05.006Z');
});

test('#6558 CA-3: resultado es enum cerrado; fuera del enum cae a "error" (fail-closed)', () => {
    const file = tmpFile();
    for (const r of ['ganada', 'error', 'rebote', 'abortada', 'GANADA', 'cualquier cosa', '']) {
        recordProviderCost({ provider: 'anthropic', skill: 'a', issue: 1, fase: 'dev', resultado: r }, { file });
    }
    const got = readLines(file).map((l) => JSON.parse(l).resultado);
    assert.deepStrictEqual(got, ['ganada', 'error', 'rebote', 'abortada', 'ganada', 'error', 'error']);
});

test('#6558 escenario Gherkin: corrida que rebota por cuota conserva provider, timestamp y resultado "rebote"', () => {
    const file = tmpFile();
    recordProviderCost({
        provider: 'openai-codex', skill: 'guru', issue: 6558, fase: 'validacion',
        tokens_in: 0, tokens_out: 0, duration_ms: 1200, resultado: 'rebote',
    }, { file });
    const rec = JSON.parse(readLines(file)[0]);
    assert.strictEqual(rec.resultado, 'rebote');
    assert.strictEqual(rec.provider, 'openai-codex');
    assert.match(rec.timestamp, ISO_UTC_RE);
});

test('compat v1: opts con status/latency_ms se mapean a resultado/duration_ms (ok→ganada, error→error)', () => {
    const file = tmpFile();
    recordProviderCost({ provider: 'antigravity', skill: 'guru', issue: 7290, tokens_in: 13038, tokens_out: 13, latency_ms: 900, status: 'ok' }, { file });
    recordProviderCost({ provider: 'anthropic', skill: 'qa', issue: 1, latency_ms: 5, status: 'error: HTTP 500' }, { file });
    const [a, b] = readLines(file).map(JSON.parse);
    assert.deepStrictEqual(Object.keys(a).sort(), EXPECTED_KEYS.slice().sort());
    assert.strictEqual(a.resultado, 'ganada');
    assert.strictEqual(a.duration_ms, 900);
    assert.strictEqual('status' in a, false);
    assert.strictEqual('latency_ms' in a, false);
    assert.strictEqual(b.resultado, 'error');
    assert.strictEqual(b.duration_ms, 5);
    // `fase` ausente → 'unknown', nunca undefined (clave siempre presente).
    assert.strictEqual(a.fase, 'unknown');
});

test('CA-2 (RS-3): input contaminado NO se persiste — solo la whitelist', () => {
    const file = tmpFile();
    recordProviderCost({
        provider: 'anthropic',
        skill: 'backend-dev',
        issue: 4403,
        fase: 'dev',
        tokens_in: 10,
        tokens_out: 20,
        duration_ms: 100,
        resultado: 'ganada',
        // Campos contaminantes que arrastraría un `opts` de error real:
        api_key: 'sk-ant-api03-SECRETO-NO-DEBE-APARECER',
        prompt_body: 'contenido del prompt que jamás debe loguearse',
        authorization: 'Bearer sk-ant-DEADBEEF',
        transport: { key: 'AIzaSyFAKEKEY1234567890' },
        status: 'HTTP 401 Unauthorized: invalid api key sk-ant-api03-LEAKED-KEY-abc123', // secret-scan:ignore (clave FALSA de test)
    }, { file });

    const raw = fs.readFileSync(file, 'utf8');
    const rec = JSON.parse(raw.trim());

    // Ninguna clave contaminante quedó en el registro.
    assert.deepStrictEqual(Object.keys(rec).sort(), EXPECTED_KEYS.slice().sort());
    assert.strictEqual('api_key' in rec, false);
    assert.strictEqual('prompt_body' in rec, false);
    assert.strictEqual('authorization' in rec, false);
    assert.strictEqual('transport' in rec, false);
    assert.strictEqual('status' in rec, false);

    // Y ninguno de los secretos aparece en el texto crudo persistido.
    assert.strictEqual(raw.includes('sk-ant-api03-SECRETO'), false);
    assert.strictEqual(raw.includes('prompt que jamás'), false);
    assert.strictEqual(raw.includes('DEADBEEF'), false);
    assert.strictEqual(raw.includes('AIzaSyFAKEKEY'), false);
    assert.strictEqual(raw.includes('LEAKED-KEY'), false);
});

test('CA-2 (RS-3): provider/skill/fase con secreto embebido o CR/LF quedan redactados y en una sola línea (CWE-117)', () => {
    const file = tmpFile();
    recordProviderCost({
        // 401 típico que ecoa la API key en el mensaje de error, colado en un campo de texto.
        provider: 'anthropic sk-ant-api03-LEAKED-KEY-abc123', // secret-scan:ignore (clave FALSA de test)
        skill: 'tester\n{"schema":2,"provider":"fake","tokens_in":999999}\n',
        fase: 'dev\r\nfalsa',
        issue: 2,
        resultado: 'error',
    }, { file });

    const raw = fs.readFileSync(file, 'utf8');
    const lines = readLines(file);
    // Un solo registro real: el CR/LF no inyectó una línea falsa.
    assert.strictEqual(lines.length, 1);
    const rec = JSON.parse(lines[0]);
    assert.deepStrictEqual(Object.keys(rec).sort(), EXPECTED_KEYS.slice().sort());
    assert.strictEqual(raw.includes('LEAKED-KEY'), false);
    assert.ok(rec.provider.includes('[REDACTED]'), `provider debería estar redactado, fue: ${rec.provider}`);
    assert.strictEqual(/[\r\n]/.test(rec.skill), false);
    assert.strictEqual(/[\r\n]/.test(rec.fase), false);
});

test('append-only: dos llamadas producen 2 líneas, la primera intacta', () => {
    const file = tmpFile();
    recordProviderCost({ provider: 'anthropic', skill: 'a', issue: 1, fase: 'dev', tokens_in: 1, tokens_out: 1, duration_ms: 1, resultado: 'ganada' }, { file });
    recordProviderCost({ provider: 'antigravity', skill: 'b', issue: 2, fase: 'dev', tokens_in: 2, tokens_out: 2, duration_ms: 2, resultado: 'ganada' }, { file });

    const lines = readLines(file);
    assert.strictEqual(lines.length, 2);
    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    assert.strictEqual(first.provider, 'anthropic');
    assert.strictEqual(first.skill, 'a');
    assert.strictEqual(second.provider, 'antigravity');
    assert.strictEqual(second.skill, 'b');
});

test('append-only: escribir v2 sobre un archivo con histórico v1 NO reescribe las líneas viejas', () => {
    const file = tmpFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, V1_LINE, 'utf8');
    recordProviderCost({ provider: 'openai-codex', skill: 'b', issue: 2, fase: 'dev', resultado: 'ganada' }, { file });
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(raw.startsWith(V1_LINE), 'la línea v1 debe quedar byte-idéntica al inicio');
    assert.strictEqual(readLines(file).length, 2);
});

test('coerción numérica: valores no-numéricos caen a 0/null, no persisten texto', () => {
    const file = tmpFile();
    recordProviderCost({
        provider: 'antigravity',
        skill: 'guru',
        issue: 'no-numerico',
        fase: 'dev',
        tokens_in: 'AIzaSyLEAK',   // string malicioso en campo numérico
        tokens_out: undefined,
        cache_read: 'x',
        cache_write: null,
        duration_ms: null,
        resultado: 'ganada',
    }, { file });

    const raw = fs.readFileSync(file, 'utf8');
    const rec = JSON.parse(raw.trim());
    assert.strictEqual(rec.issue, null);
    assert.strictEqual(rec.tokens_in, 0);
    assert.strictEqual(rec.tokens_out, 0);
    assert.strictEqual(rec.cache_read, 0);
    assert.strictEqual(rec.cache_write, 0);
    assert.strictEqual(rec.duration_ms, 0);
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
            { provider: 'anthropic', skill: 'x', issue: 1, fase: 'dev', tokens_in: 1, tokens_out: 1, duration_ms: 1, resultado: 'ganada' },
            { fs: throwingFs, file: '/dev/null/nope.jsonl' },
        );
    });
});

test('readProviderCostBreakdown: agrega por provider y cuenta sesiones/errores/rebotes/abortadas', () => {
    const file = tmpFile();
    recordProviderCost({ provider: 'anthropic', skill: 'a', issue: 1, fase: 'dev', tokens_in: 100, tokens_out: 50, cache_read: 10, cache_write: 1, resultado: 'ganada' }, { file });
    recordProviderCost({ provider: 'anthropic', skill: 'b', issue: 2, fase: 'dev', tokens_in: 200, tokens_out: 10, resultado: 'error' }, { file });
    recordProviderCost({ provider: 'openai-codex', skill: 'c', issue: 3, fase: 'dev', tokens_in: 5, tokens_out: 5, resultado: 'rebote' }, { file });
    recordProviderCost({ provider: 'openai-codex', skill: 'c', issue: 4, fase: 'dev', tokens_in: 5, tokens_out: 5, resultado: 'abortada' }, { file });

    const out = readProviderCostBreakdown({ file });
    assert.strictEqual(out.hasData, true);
    assert.strictEqual(out.totalSessions, 4);
    assert.strictEqual(out.hasUnreliable, false);
    assert.strictEqual(out.byProvider.anthropic.tokens_in, 300);
    assert.strictEqual(out.byProvider.anthropic.tokens_out, 60);
    assert.strictEqual(out.byProvider.anthropic.cache_read, 10);
    assert.strictEqual(out.byProvider.anthropic.cache_write, 1);
    assert.strictEqual(out.byProvider.anthropic.sessions, 2);
    assert.strictEqual(out.byProvider.anthropic.errors, 1);
    assert.strictEqual(out.byProvider['openai-codex'].sessions, 2);
    assert.strictEqual(out.byProvider['openai-codex'].errors, 0);
    assert.strictEqual(out.byProvider['openai-codex'].rebotes, 1);
    assert.strictEqual(out.byProvider['openai-codex'].abortadas, 1);
});

test('#6558 CA-5: el histórico v1 queda distinguible y NO se suma al bucket del proveedor declarado', () => {
    const file = tmpFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, V1_LINE + V1_LINE, 'utf8');
    recordProviderCost({ provider: 'openai-codex', skill: 'b', issue: 2, fase: 'dev', tokens_in: 7, tokens_out: 3, resultado: 'ganada' }, { file });

    const recs = readProviderCostRecords({ file });
    assert.strictEqual(recs.length, 3);
    assert.deepStrictEqual(recs.map((r) => r.reliable), [false, false, true]);
    assert.deepStrictEqual(recs.map((r) => r.schema), [1, 1, 2]);
    // La vista normaliza v1 a vocabulario v2 sin tocar el archivo.
    assert.strictEqual(recs[0].resultado, 'ganada');
    assert.strictEqual(recs[0].duration_ms, 264739);
    assert.strictEqual(recs[0].timestamp, null);

    const out = readProviderCostBreakdown({ file });
    // `anthropic` NO aparece: las dos líneas v1 eran proveedor declarado.
    assert.strictEqual('anthropic' in out.byProvider, false);
    assert.deepStrictEqual(Object.keys(out.byProvider), ['openai-codex']);
    assert.strictEqual(out.totalSessions, 1);
    assert.strictEqual(out.hasUnreliable, true);
    assert.deepStrictEqual(out.unreliable, { sessions: 2, tokens_in: 20116, tokens_out: 800 });
});

test('readProviderCostBreakdown: sólo histórico v1 ⇒ hasData:false pero hasUnreliable:true (nunca cifra falsa)', () => {
    const file = tmpFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, V1_LINE, 'utf8');
    const out = readProviderCostBreakdown({ file });
    assert.strictEqual(out.hasData, false);
    assert.deepStrictEqual(out.byProvider, {});
    assert.strictEqual(out.hasUnreliable, true);
    assert.strictEqual(out.unreliable.sessions, 1);
});

test('readProviderCostBreakdown: empty-state cuando el archivo no existe', () => {
    const out = readProviderCostBreakdown({ file: path.join(os.tmpdir(), 'no-existe-provcost-xyz.jsonl') });
    assert.strictEqual(out.hasData, false);
    assert.deepStrictEqual(out.byProvider, {});
    assert.strictEqual(out.totalSessions, 0);
    assert.strictEqual(out.hasUnreliable, false);
});

test('#6558 CA-4: agrupación por proveedor y por día/semana (UTC, semana ISO)', () => {
    const file = tmpFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, V1_LINE, 'utf8'); // histórico: se cuenta aparte
    const rows = [
        ['2026-09-14T23:59:59.000Z', 'anthropic', 100, 'ganada'],   // lunes  → 2026-W38
        ['2026-09-15T00:00:01.000Z', 'anthropic', 10, 'ganada'],    // martes → 2026-W38
        ['2026-09-15T03:22:00.000Z', 'openai-codex', 0, 'rebote'],  // martes → 2026-W38
        ['2026-09-21T09:45:00.000Z', 'openai-codex', 5, 'ganada'],  // lunes  → 2026-W39
    ];
    for (const [timestamp, provider, tokens_in, resultado] of rows) {
        recordProviderCost({ provider, skill: 's', issue: 1, fase: 'dev', tokens_in, tokens_out: 1, resultado, timestamp }, { file });
    }

    const byDay = readProviderCostByPeriod({ period: 'day' }, { file });
    assert.strictEqual(byDay.period, 'day');
    assert.strictEqual(byDay.unreliableSessions, 1);
    assert.deepStrictEqual(Object.keys(byDay.series), ['2026-09-14', '2026-09-15', '2026-09-21']);
    assert.strictEqual(byDay.series['2026-09-14'].anthropic.tokens_in, 100);
    assert.strictEqual(byDay.series['2026-09-15'].anthropic.tokens_in, 10);
    assert.strictEqual(byDay.series['2026-09-15']['openai-codex'].rebotes, 1);
    assert.strictEqual(byDay.series['2026-09-21']['openai-codex'].sessions, 1);

    const byWeek = readProviderCostByPeriod({ period: 'week' }, { file });
    assert.deepStrictEqual(Object.keys(byWeek.series), ['2026-W38', '2026-W39']);
    assert.strictEqual(byWeek.series['2026-W38'].anthropic.tokens_in, 110);
    assert.strictEqual(byWeek.series['2026-W38'].anthropic.sessions, 2);
    assert.strictEqual(byWeek.series['2026-W38']['openai-codex'].rebotes, 1);
    assert.strictEqual(byWeek.series['2026-W39']['openai-codex'].tokens_in, 5);

    // Default y valor inválido → 'day'.
    assert.strictEqual(readProviderCostByPeriod({}, { file }).period, 'day');
    assert.strictEqual(readProviderCostByPeriod({ period: 'mes' }, { file }).period, 'day');
});

test('readProviderCostByPeriod / readProviderCostRecords: never-throws con archivo inexistente', () => {
    const file = path.join(os.tmpdir(), 'no-existe-provcost-periodo.jsonl');
    assert.deepStrictEqual(readProviderCostRecords({ file }), []);
    const out = readProviderCostByPeriod({ period: 'week' }, { file });
    assert.deepStrictEqual(out, { period: 'week', series: {}, unreliableSessions: 0 });
});

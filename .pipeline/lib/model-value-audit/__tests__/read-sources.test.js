// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// Tests de `read-sources.js` (#7517): lectores de ventana read-only con
// `fsImpl` fake en memoria y hash-chain real construida con `audit-log`.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const rs = require('../read-sources');
const auditLog = require('../../audit-log');

const PIPELINE = '/fake/.pipeline';
const LOGS = path.join(PIPELINE, 'logs');
const STATE = path.join(PIPELINE, 'state');

// Ventana de referencia: del 2026-09-01 al fin del 2026-09-20 (UTC).
const FROM = Date.parse('2026-09-01T00:00:00.000Z');
const TO = Date.parse('2026-09-20T23:59:59.999Z');

// -----------------------------------------------------------------------------
// Fakes
// -----------------------------------------------------------------------------

/**
 * fs en memoria: `files` es un mapa path absoluto → contenido (string). Permite
 * forzar `statSync().size` con `sizes[path]` y cuenta las lecturas.
 */
function fakeFs(files, { sizes = {} } = {}) {
    const norm = (p) => String(p).replace(/\\/g, '/');
    const keys = () => Object.keys(files).map(norm);
    const dirs = new Set();
    for (const k of keys()) {
        let d = path.posix.dirname(k);
        while (d && d !== '/' && d !== '.') { dirs.add(d); d = path.posix.dirname(d); }
    }
    const reads = [];
    return {
        reads,
        existsSync: (p) => dirs.has(norm(p)) || keys().includes(norm(p)),
        readdirSync: (dir) => keys()
            .filter((k) => path.posix.dirname(k) === norm(dir))
            .map((k) => path.posix.basename(k)),
        readFileSync: (p) => {
            const k = norm(p);
            reads.push(k);
            if (!keys().includes(k)) { const e = new Error(`ENOENT: ${k}`); e.code = 'ENOENT'; throw e; }
            return files[Object.keys(files).find((f) => norm(f) === k)];
        },
        statSync: (p) => {
            const k = norm(p);
            if (!keys().includes(k)) { const e = new Error(`ENOENT: ${k}`); e.code = 'ENOENT'; throw e; }
            const override = sizes[Object.keys(sizes).find((f) => norm(f) === k)];
            const content = files[Object.keys(files).find((f) => norm(f) === k)];
            return { size: override !== undefined ? override : Buffer.byteLength(content, 'utf8') };
        },
    };
}

/** Construye un JSONL con hash-chain válida (misma regla que `appendChained`). */
function chained(entries) {
    let prev = auditLog.GENESIS;
    const lines = [];
    for (const e of entries) {
        const hash_self = auditLog.computeEntryHash({ ...e, hash_prev: prev }, prev);
        lines.push(JSON.stringify({ ...e, hash_prev: prev, hash_self }));
        prev = hash_self;
    }
    return lines.join('\n') + '\n';
}

function jsonl(rows) {
    return rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';
}

function spawnRow(over = {}) {
    return {
        ts: '2026-09-10T12:00:00.000Z',
        skill: 'guru',
        issue: 7517,
        provider: 'anthropic',
        transport: 'cli',
        error_class: null,
        evidence: 'timedOut=false durationMs=1000',
        raw_excerpt: '{"session_id":"abc","usage":{}}',
        should_fallback: false,
        retriable: false,
        flag_set: false,
        exit_code: 0,
        timed_out: false,
        duration_ms: 1000,
        death_kind: 'normal',
        first_byte_at: null,
        codepath: 'generalized',
        status: 'ok',
        title: 'Un titulo cualquiera',
        path: 'C:/algo/secreto',
        ...over,
    };
}

function spawnFile(day) { return path.join(LOGS, `spawn-exit-${day}.jsonl`); }
function reboundFile(day) { return path.join(LOGS, `rebound-events-${day}.jsonl`); }
const EFFECTIVE = path.join(STATE, 'effective-model.jsonl');
const COST = path.join(STATE, 'provider-cost.jsonl');
const LABELS = path.join(STATE, 'label-mutations.jsonl');

// -----------------------------------------------------------------------------
// listDatedFiles — ventana por nombre (CA-5)
// -----------------------------------------------------------------------------

test('listDatedFiles incluye el archivo dentro y en el borde de la ventana y excluye el de afuera', () => {
    const files = {
        [spawnFile('2026-08-31')]: '',   // fuera (antes)
        [spawnFile('2026-09-01')]: '',   // borde inferior
        [spawnFile('2026-09-10')]: '',   // dentro
        [spawnFile('2026-09-20')]: '',   // borde superior
        [spawnFile('2026-09-21')]: '',   // fuera (después)
        [reboundFile('2026-09-10')]: '', // otro prefijo
        [path.join(LOGS, 'spawn-exit-x.jsonl')]: '',
    };
    const out = rs.listDatedFiles({ dir: LOGS, prefix: 'spawn-exit-', from: FROM, to: TO, fsImpl: fakeFs(files) });
    assert.deepStrictEqual(out.map((p) => path.basename(p)), [
        'spawn-exit-2026-09-01.jsonl',
        'spawn-exit-2026-09-10.jsonl',
        'spawn-exit-2026-09-20.jsonl',
    ]);
});

test('listDatedFiles devuelve [] si el directorio no existe o readdir falla', () => {
    assert.deepStrictEqual(rs.listDatedFiles({ dir: LOGS, prefix: 'spawn-exit-', from: FROM, to: TO, fsImpl: fakeFs({}) }), []);
    const roto = { existsSync: () => true, readdirSync: () => { throw new Error('EACCES'); } };
    assert.deepStrictEqual(rs.listDatedFiles({ dir: LOGS, prefix: 'spawn-exit-', from: FROM, to: TO, fsImpl: roto }), []);
});

// -----------------------------------------------------------------------------
// readSpawnExits — chain por archivo (CA-6), proyección (CA-8), issue (CA-9)
// -----------------------------------------------------------------------------

test('readSpawnExits acepta la chain valida y excluye el archivo con chain rota listandolo en broken[]', () => {
    const sano = chained([spawnRow({ ts: '2026-09-10T10:00:00.000Z' }), spawnRow({ ts: '2026-09-10T11:00:00.000Z' })]);
    // Chain rota: se altera un byte del payload de la segunda entrada.
    const roto = chained([spawnRow({ ts: '2026-09-11T10:00:00.000Z' }), spawnRow({ ts: '2026-09-11T11:00:00.000Z' })])
        .replace('"exit_code":0', '"exit_code":1');
    const fsImpl = fakeFs({ [spawnFile('2026-09-10')]: sano, [spawnFile('2026-09-11')]: roto });

    const res = rs.readSpawnExits({ pipelineDir: PIPELINE, from: FROM, to: TO, fsImpl });

    assert.strictEqual(res.evaluable, true);
    assert.strictEqual(res.integridad.estado, rs.INTEGRIDAD_ESTADO.VERIFICADA);
    assert.deepStrictEqual(res.integridad.broken, ['spawn-exit-2026-09-11.jsonl']);
    assert.strictEqual(res.integridad.files, 2);
    assert.strictEqual(res.rows.length, 2);
    assert.strictEqual(res.integridad.rows, 2);
    assert.strictEqual(res.integridad.schema_mismatch, false);
});

test('readSpawnExits: archivo ausente no es broken; archivo presente e ilegible si lo es (SEC-1b)', () => {
    // Ventana sin archivos: nada roto, nada leido (CA-14 ventana vacia).
    const vacio = rs.readSpawnExits({ pipelineDir: PIPELINE, from: FROM, to: TO, fsImpl: fakeFs({}) });
    assert.deepStrictEqual(vacio.integridad.broken, []);
    assert.strictEqual(vacio.integridad.files, 0);
    assert.strictEqual(vacio.integridad.lines, 0);
    assert.strictEqual(vacio.integridad.rows, 0);
    assert.strictEqual(vacio.integridad.schema_mismatch, false);
    assert.deepStrictEqual(vacio.rows, []);

    // Presente pero con JSON invalido: verifyChain real falla ⇒ broken.
    const fsImpl = fakeFs({ [spawnFile('2026-09-10')]: '{"ts":"2026-09-10T10:00:00Z", esto no es json\n' });
    const ilegible = rs.readSpawnExits({ pipelineDir: PIPELINE, from: FROM, to: TO, fsImpl });
    assert.deepStrictEqual(ilegible.integridad.broken, ['spawn-exit-2026-09-10.jsonl']);
    assert.deepStrictEqual(ilegible.rows, []);
});

test('readSpawnExits: verifyChain que lanza o readAll que lanza marcan el archivo como broken', () => {
    const fsImpl = fakeFs({ [spawnFile('2026-09-10')]: 'x\n', [spawnFile('2026-09-11')]: 'y\n' });
    const fakeAudit = {
        verifyChain: (file) => { if (String(file).includes('09-10')) throw new Error('boom'); return { ok: true }; },
        readAll: () => { throw new Error('parse'); },
    };
    const res = rs.readSpawnExits({ pipelineDir: PIPELINE, from: FROM, to: TO, fsImpl, auditLog: fakeAudit });
    assert.deepStrictEqual(res.integridad.broken.sort(), ['spawn-exit-2026-09-10.jsonl', 'spawn-exit-2026-09-11.jsonl']);
});

test('readSpawnExits proyecta solo la whitelist: raw_excerpt, evidence, status, title y path no existen aguas abajo (CA-8)', () => {
    const fsImpl = fakeFs({ [spawnFile('2026-09-10')]: chained([spawnRow()]) });
    const res = rs.readSpawnExits({ pipelineDir: PIPELINE, from: FROM, to: TO, fsImpl });

    assert.strictEqual(res.rows.length, 1);
    const row = res.rows[0];
    assert.deepStrictEqual(Object.keys(row).sort(), ['codepath', 'death_kind', 'duration_ms', 'exit_code', 'issue', 'provider', 'skill', 'ts']);
    const dump = JSON.stringify(res.rows);
    for (const prohibido of ['raw_excerpt', 'evidence', 'status', 'title', 'path', 'session_id', 'secreto', 'hash_prev', 'hash_self', 'transport']) {
        assert.ok(!dump.includes(`"${prohibido}"`), `no debe contener ${prohibido}`);
    }
    assert.strictEqual(row.ts, Date.parse('2026-09-10T12:00:00.000Z'));
    assert.strictEqual(row.codepath, 'generalized');
});

test('readSpawnExits preserva issue null (sin_issue) y convierte numero y string a String (CA-9)', () => {
    const fsImpl = fakeFs({
        [spawnFile('2026-09-10')]: chained([
            spawnRow({ issue: null, skill: 'commander' }),
            spawnRow({ issue: 7517 }),
            spawnRow({ issue: '7518' }),
        ]),
    });
    const res = rs.readSpawnExits({ pipelineDir: PIPELINE, from: FROM, to: TO, fsImpl });
    assert.deepStrictEqual(res.rows.map((r) => r.issue), [null, '7517', '7518']);
    assert.strictEqual(res.integridad.sin_issue, 1);
    assert.strictEqual(res.rows.length, 3);
});

test('readSpawnExits filtra por ts de fila: 23:59:59.999 del 20 entra, 00:00:00.000 del 21 queda afuera (CA-5)', () => {
    // El archivo del dia 20 tiene una fila con ts ya del 21 (escritura tardia).
    const fsImpl = fakeFs({
        [spawnFile('2026-09-20')]: chained([
            spawnRow({ ts: '2026-09-20T23:59:59.999Z' }),
            spawnRow({ ts: '2026-09-21T00:00:00.000Z' }),
            spawnRow({ ts: 'no-es-fecha' }),
        ]),
    });
    const res = rs.readSpawnExits({ pipelineDir: PIPELINE, from: FROM, to: TO, fsImpl });
    assert.strictEqual(res.rows.length, 1);
    assert.strictEqual(res.rows[0].ts, TO);
    assert.strictEqual(res.integridad.filtradas, 1);
    assert.strictEqual(res.integridad.sin_ts, 1);
    assert.strictEqual(res.integridad.lines, 3);
    assert.strictEqual(res.integridad.schema_mismatch, false);
});

test('readSpawnExits salta el archivo que excede MAX_BYTES_PER_FILE sin leerlo (CA-16)', () => {
    const file = spawnFile('2026-09-10');
    const fsImpl = fakeFs({ [file]: chained([spawnRow()]) }, { sizes: { [file]: rs.MAX_BYTES_PER_FILE + 1 } });
    const res = rs.readSpawnExits({ pipelineDir: PIPELINE, from: FROM, to: TO, fsImpl });
    assert.deepStrictEqual(res.integridad.skipped, [{ file: 'spawn-exit-2026-09-10.jsonl', bytes: rs.MAX_BYTES_PER_FILE + 1 }]);
    assert.deepStrictEqual(res.rows, []);
    assert.deepStrictEqual(fsImpl.reads, [], 'readFileSync no debe invocarse sobre un archivo oversize');
    assert.strictEqual(rs.MAX_BYTES_PER_FILE, 8 * 1024 * 1024);
});

test('readSpawnExits marca schema_mismatch cuando hay lineas pero ninguna fila valida y ninguna chain rota (CA-14)', () => {
    const fsImpl = fakeFs({ [spawnFile('2026-09-10')]: chained([{ otro: 1 }, { otro: 2 }]) });
    const res = rs.readSpawnExits({ pipelineDir: PIPELINE, from: FROM, to: TO, fsImpl });
    assert.strictEqual(res.integridad.lines, 2);
    assert.strictEqual(res.integridad.rows, 0);
    assert.strictEqual(res.integridad.sin_ts, 2);
    assert.strictEqual(res.integridad.schema_mismatch, true);
});

// -----------------------------------------------------------------------------
// readReboundEvents — sin chain, try/catch por linea (CA-7)
// -----------------------------------------------------------------------------

test('readReboundEvents lee sin chain, salta la linea corrupta y proyecta sin evaluadores', () => {
    const fsImpl = fakeFs({
        [reboundFile('2026-09-10')]: jsonl([
            { ts: '2026-09-10T11:14:56.269Z', issue: '7185', skill: 'pipeline-dev', provider: 'anthropic', rechazado_en_fase: 'verificacion', evaluadores: ['tester'] },
            '{"ts":"2026-09-10T11:15:00Z", rota',
            { ts: '2026-09-10T12:00:00.000Z', issue: 7186, skill: 'guru', provider: 'openai-codex', rechazado_en_fase: 'dev', evaluadores: ['po'] },
        ]),
    });
    const res = rs.readReboundEvents({ pipelineDir: PIPELINE, from: FROM, to: TO, fsImpl });
    assert.strictEqual(res.integridad.estado, rs.INTEGRIDAD_ESTADO.NO_VERIFICADA);
    assert.strictEqual(res.integridad.lines, 3);
    assert.strictEqual(res.integridad.lineas_corruptas, 1);
    assert.strictEqual(res.rows.length, 2);
    assert.deepStrictEqual(Object.keys(res.rows[0]).sort(), ['issue', 'provider', 'rechazado_en_fase', 'skill', 'ts']);
    assert.ok(!JSON.stringify(res.rows).includes('evaluadores'));
    assert.deepStrictEqual(res.rows.map((r) => r.issue), ['7185', '7186']);
});

test('readReboundEvents con ventana vacia devuelve los tres silencios en cero (CA-14)', () => {
    const res = rs.readReboundEvents({ pipelineDir: PIPELINE, from: FROM, to: TO, fsImpl: fakeFs({}) });
    assert.deepStrictEqual(
        { files: res.integridad.files, lines: res.integridad.lines, rows: res.integridad.rows, schema_mismatch: res.integridad.schema_mismatch, broken: res.integridad.broken },
        { files: 0, lines: 0, rows: 0, schema_mismatch: false, broken: [] },
    );
});

// -----------------------------------------------------------------------------
// readEffectiveModels — inyeccion de readRecords, null conservado (CA-17)
// -----------------------------------------------------------------------------

test('readEffectiveModels inyecta effectiveModel.readRecords({file, fs}), conserva model_effective null y renormaliza', () => {
    const contenido = jsonl([
        { ts: '2026-09-10T12:00:00.000Z', issue: 6432, skill: 'guru', provider: 'anthropic', model_declared: 'opus', model_resolved: 'opus', model_effective: 'Claude-Opus-5[1m]', source: 'agent-log' },
        { ts: '2026-09-10T12:01:00.000Z', issue: 7185, skill: 'tester', provider: 'deterministic', model_declared: 'deterministic', model_resolved: null, model_effective: null, source: 'not_observable' },
        { ts: '2026-09-25T12:00:00.000Z', issue: 1, skill: 'guru', provider: 'anthropic', model_effective: 'claude-opus-5', source: 'agent-log' },
    ]);
    const fsImpl = fakeFs({ [EFFECTIVE]: contenido });
    const llamadas = [];
    const real = require('../../metrics/effective-model');
    const fakeEffective = {
        normalizeModelId: real.normalizeModelId,
        readRecords: (deps) => { llamadas.push(deps); return real.readRecords(deps); },
    };
    const res = rs.readEffectiveModels({ pipelineDir: PIPELINE, from: FROM, to: TO, fsImpl, effectiveModel: fakeEffective });

    assert.strictEqual(llamadas.length, 1);
    assert.strictEqual(llamadas[0].file, EFFECTIVE);
    assert.strictEqual(llamadas[0].fs, fsImpl, 'el parametro se llama fs, no fsImpl');
    assert.strictEqual(res.integridad.lines, 3);
    assert.strictEqual(res.integridad.filtradas, 1);
    assert.strictEqual(res.rows.length, 2);
    assert.strictEqual(res.rows[0].model_effective, 'claude-opus-5');
    assert.strictEqual(res.rows[1].model_effective, null);
    assert.deepStrictEqual(Object.keys(res.rows[0]).sort(), ['issue', 'model_effective', 'provider', 'skill', 'source', 'ts']);
    assert.ok(!JSON.stringify(res.rows).includes('model_declared'));
    assert.strictEqual(res.integridad.schema_mismatch, false);
});

test('readEffectiveModels emite schema_mismatch cuando readRecords devuelve [] sobre un archivo con lineas (A7)', () => {
    const fsImpl = fakeFs({ [EFFECTIVE]: 'basura\nmas basura\n' });
    const res = rs.readEffectiveModels({ pipelineDir: PIPELINE, from: FROM, to: TO, fsImpl });
    assert.strictEqual(res.integridad.lines, 2);
    assert.strictEqual(res.integridad.rows, 0);
    assert.strictEqual(res.integridad.schema_mismatch, true);
});

test('readEffectiveModels: archivo oversize ⇒ evaluable false, reason oversize, sin readFileSync (CA-16)', () => {
    const fsImpl = fakeFs({ [EFFECTIVE]: '{}\n' }, { sizes: { [EFFECTIVE]: rs.MAX_BYTES_PER_FILE + 1 } });
    const res = rs.readEffectiveModels({ pipelineDir: PIPELINE, from: FROM, to: TO, fsImpl });
    assert.strictEqual(res.evaluable, false);
    assert.strictEqual(res.reason, rs.REASON.OVERSIZE);
    assert.strictEqual(res.bytes, rs.MAX_BYTES_PER_FILE + 1);
    assert.deepStrictEqual(res.integridad.skipped, [{ file: 'effective-model.jsonl', bytes: rs.MAX_BYTES_PER_FILE + 1 }]);
    assert.deepStrictEqual(fsImpl.reads, []);
});

test('readEffectiveModels sin archivo ⇒ sin datos, evaluable true, files 0', () => {
    const res = rs.readEffectiveModels({ pipelineDir: PIPELINE, from: FROM, to: TO, fsImpl: fakeFs({}) });
    assert.strictEqual(res.evaluable, true);
    assert.strictEqual(res.integridad.files, 0);
    assert.deepStrictEqual(res.rows, []);
});

// -----------------------------------------------------------------------------
// readCostWindow — fail-closed (CA-11)
// -----------------------------------------------------------------------------

test('readCostWindow con el schema v1 de 7 campos (sin fecha) ⇒ evaluable false, reason sin_ts, rows [] (CA-11)', () => {
    const fsImpl = fakeFs({
        [COST]: jsonl([
            { provider: 'anthropic', skill: 'security', issue: 4435, tokens_in: 10058, tokens_out: 400, latency_ms: 264739, status: 'ok' },
            { schema: 2, timestamp: '2026-09-10T12:10:15.157Z', provider: 'deterministic', skill: 'tester', issue: 7185, fase: 'verificacion', tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, duration_ms: 575099, resultado: 'ganada' },
        ]),
    });
    const res = rs.readCostWindow({ pipelineDir: PIPELINE, from: FROM, to: TO, fsImpl });
    assert.strictEqual(res.evaluable, false);
    assert.strictEqual(res.reason, rs.REASON.SIN_TS);
    assert.deepStrictEqual(res.rows, []);
    assert.strictEqual(res.integridad.sin_ts, 1);
    assert.strictEqual(res.integridad.estado, rs.INTEGRIDAD_ESTADO.NO_VERIFICADA);
});

test('readCostWindow con timestamp (schema v2) en todas las filas ⇒ evaluable true y cache no_medido (CA-11)', () => {
    const fsImpl = fakeFs({
        [COST]: jsonl([
            { schema: 2, timestamp: '2026-09-10T12:10:15.157Z', provider: 'deterministic', skill: 'tester', issue: 7185, fase: 'verificacion', tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, duration_ms: 575099, resultado: 'ganada' },
            { schema: 2, timestamp: '2026-09-11T12:10:15.157Z', provider: 'anthropic', skill: 'guru', issue: 7517, fase: 'analisis', tokens_in: 100, tokens_out: 20, cache_read: 5, cache_write: 1, duration_ms: 1000, resultado: 'ganada' },
            { ts: Date.parse('2026-09-12T00:00:00.000Z'), provider: 'anthropic', skill: 'po', issue: 7517, tokens_in: 1, tokens_out: 1 },
            { schema: 2, timestamp: '2026-09-25T00:00:00.000Z', provider: 'anthropic', skill: 'po', issue: 1, tokens_in: 1, tokens_out: 1 },
        ]),
    });
    const res = rs.readCostWindow({ pipelineDir: PIPELINE, from: FROM, to: TO, fsImpl });
    assert.strictEqual(res.evaluable, true);
    assert.strictEqual(res.rows.length, 3);
    assert.strictEqual(res.integridad.filtradas, 1);
    for (const r of res.rows) {
        assert.strictEqual(r.cache, rs.CACHE_NO_MEDIDO);
        assert.deepStrictEqual(Object.keys(r).sort(), ['cache', 'issue', 'provider', 'skill', 'tokens_in', 'tokens_out', 'ts']);
    }
    const dump = JSON.stringify(res.rows);
    for (const prohibido of ['cache_read', 'cache_write', 'resultado', 'fase', 'duration_ms', 'schema']) {
        assert.ok(!dump.includes(`"${prohibido}"`), `no debe proyectar ${prohibido}`);
    }
    assert.strictEqual(res.rows[0].ts, Date.parse('2026-09-10T12:10:15.157Z'));
    assert.strictEqual(res.rows[1].issue, '7517');
});

test('readCostWindow: una linea corrupta se salta sin invalidar la ventana', () => {
    const fsImpl = fakeFs({
        [COST]: jsonl([
            '{ rota',
            { schema: 2, timestamp: '2026-09-10T12:10:15.157Z', provider: 'anthropic', skill: 'guru', issue: 1, tokens_in: 1, tokens_out: 1 },
        ]),
    });
    const res = rs.readCostWindow({ pipelineDir: PIPELINE, from: FROM, to: TO, fsImpl });
    assert.strictEqual(res.evaluable, true);
    assert.strictEqual(res.integridad.lineas_corruptas, 1);
    assert.strictEqual(res.rows.length, 1);
});

test('readCostWindow oversize ⇒ evaluable false, reason oversize (CA-16)', () => {
    const fsImpl = fakeFs({ [COST]: '{}\n' }, { sizes: { [COST]: rs.MAX_BYTES_PER_FILE + 1 } });
    const res = rs.readCostWindow({ pipelineDir: PIPELINE, from: FROM, to: TO, fsImpl });
    assert.strictEqual(res.evaluable, false);
    assert.strictEqual(res.reason, rs.REASON.OVERSIZE);
    assert.deepStrictEqual(fsImpl.reads, []);
});

// -----------------------------------------------------------------------------
// readQaFailures — schema real, ventana por `at`, rotado `.1` (CA-15)
// -----------------------------------------------------------------------------

test('readQaFailures filtra qa:failed + action label por ventana `at` y descarta remove-label', () => {
    const fsImpl = fakeFs({
        [LABELS]: jsonl([
            { issue: 6145, label: 'qa:failed', action: 'label', target: 'issue', at: '2026-09-10T02:32:54.759Z' },
            { issue: 6145, label: 'qa:failed', action: 'remove-label', target: 'issue', at: '2026-09-11T02:32:54.759Z' },
            { issue: 5519, label: 'qa:passed', action: 'label', target: 'pr', at: '2026-09-12T02:32:54.759Z' },
            { issue: 5520, label: 'qa:failed', action: 'label', target: 'pr', at: '2026-09-25T02:32:54.759Z' },
        ]),
    });
    const res = rs.readQaFailures({ pipelineDir: PIPELINE, from: FROM, to: TO, fsImpl });
    assert.strictEqual(res.rows.length, 1);
    assert.deepStrictEqual(res.rows[0], { issue: '6145', label: 'qa:failed', action: 'label', ts: Date.parse('2026-09-10T02:32:54.759Z') });
    assert.ok(!JSON.stringify(res.rows).includes('target'));
    assert.strictEqual(res.integridad.filtradas, 3);
    assert.strictEqual(res.integridad.files, 1);
    assert.strictEqual(res.integridad.schema_mismatch, false);
    assert.strictEqual(res.integridad.estado, rs.INTEGRIDAD_ESTADO.NO_VERIFICADA);
});

test('readQaFailures con fixture legacy sin at/action ⇒ schema_mismatch true (A1)', () => {
    const fsImpl = fakeFs({
        [LABELS]: jsonl([
            { issue: 6145, label: 'qa:failed', ts: '2026-09-10T02:32:54.759Z' },
            { issue: 6146, label: 'qa:failed', ts: '2026-09-11T02:32:54.759Z' },
        ]),
    });
    const res = rs.readQaFailures({ pipelineDir: PIPELINE, from: FROM, to: TO, fsImpl });
    assert.strictEqual(res.integridad.lines, 2);
    assert.strictEqual(res.integridad.rows, 0);
    assert.strictEqual(res.integridad.sin_ts, 2);
    assert.strictEqual(res.integridad.schema_mismatch, true);
});

test('readQaFailures lee el rotado .1 ademas del activo (files 2) y solo el activo si no hay rotado (files 1)', () => {
    const activo = jsonl([{ issue: 2, label: 'qa:failed', action: 'label', target: 'issue', at: '2026-09-15T00:00:00.000Z' }]);
    const rotado = jsonl([{ issue: 1, label: 'qa:failed', action: 'label', target: 'issue', at: '2026-09-05T00:00:00.000Z' }]);

    const ambos = rs.readQaFailures({ pipelineDir: PIPELINE, from: FROM, to: TO, fsImpl: fakeFs({ [LABELS]: activo, [`${LABELS}.1`]: rotado }) });
    assert.strictEqual(ambos.integridad.files, 2);
    assert.deepStrictEqual(ambos.rows.map((r) => r.issue), ['1', '2']);

    const solo = rs.readQaFailures({ pipelineDir: PIPELINE, from: FROM, to: TO, fsImpl: fakeFs({ [LABELS]: activo }) });
    assert.strictEqual(solo.integridad.files, 1);
    assert.deepStrictEqual(solo.rows.map((r) => r.issue), ['2']);
});

test('readQaFailures oversize ⇒ evaluable false sin leer (CA-16)', () => {
    const fsImpl = fakeFs({ [LABELS]: '{}\n' }, { sizes: { [LABELS]: rs.MAX_BYTES_PER_FILE + 1 } });
    const res = rs.readQaFailures({ pipelineDir: PIPELINE, from: FROM, to: TO, fsImpl });
    assert.strictEqual(res.evaluable, false);
    assert.strictEqual(res.reason, rs.REASON.OVERSIZE);
    assert.deepStrictEqual(fsImpl.reads, []);
});

// -----------------------------------------------------------------------------
// readSources — contrato uniforme (A10 / CA-13 / CA-14)
// -----------------------------------------------------------------------------

const SHAPE_KEYS = ['broken', 'estado', 'files', 'filtradas', 'lineas_corruptas', 'lines', 'rows', 'schema_mismatch', 'sin_issue', 'sin_ts', 'skipped'];

test('readSources devuelve las cinco fuentes con shape uniforme y la ventana', () => {
    const fsImpl = fakeFs({
        [spawnFile('2026-09-10')]: chained([spawnRow()]),
        [reboundFile('2026-09-10')]: jsonl([{ ts: '2026-09-10T11:14:56.269Z', issue: '7185', skill: 'pipeline-dev', provider: 'anthropic', rechazado_en_fase: 'verificacion' }]),
        [EFFECTIVE]: jsonl([{ ts: '2026-09-10T12:00:00.000Z', issue: 1, skill: 'guru', provider: 'anthropic', model_effective: 'claude-opus-5', source: 'agent-log' }]),
        [COST]: jsonl([{ provider: 'anthropic', skill: 'security', issue: 4435, tokens_in: 1, tokens_out: 1, latency_ms: 1, status: 'ok' }]),
        [LABELS]: jsonl([{ issue: 6145, label: 'qa:failed', action: 'label', target: 'issue', at: '2026-09-10T02:32:54.759Z' }]),
    });
    const src = rs.readSources({ pipelineDir: PIPELINE, from: FROM, to: TO, fsImpl });

    assert.deepStrictEqual(Object.keys(src).sort(), ['effective_model', 'label_mutations', 'provider_cost', 'rebound_events', 'spawn_exit', 'ventana']);
    assert.deepStrictEqual(src.ventana, { from: FROM, to: TO });
    for (const k of ['spawn_exit', 'rebound_events', 'effective_model', 'provider_cost', 'label_mutations']) {
        assert.ok(Array.isArray(src[k].rows), `${k}.rows`);
        assert.strictEqual(typeof src[k].evaluable, 'boolean', `${k}.evaluable`);
        assert.deepStrictEqual(Object.keys(src[k].integridad).sort(), SHAPE_KEYS, `${k}.integridad`);
    }
    assert.strictEqual(src.spawn_exit.integridad.estado, rs.INTEGRIDAD_ESTADO.VERIFICADA);
    for (const k of ['rebound_events', 'effective_model', 'provider_cost', 'label_mutations']) {
        assert.strictEqual(src[k].integridad.estado, rs.INTEGRIDAD_ESTADO.NO_VERIFICADA, k);
    }
    assert.strictEqual(src.provider_cost.evaluable, false);
    assert.strictEqual(src.provider_cost.reason, rs.REASON.SIN_TS);
    assert.strictEqual(src.spawn_exit.rows.length, 1);
    assert.strictEqual(src.label_mutations.rows.length, 1);
});

test('vocabulario cerrado: todo reason y estado emitido pertenece a REASON / INTEGRIDAD_ESTADO (CA-13)', () => {
    assert.ok(Object.isFrozen(rs.REASON));
    assert.ok(Object.isFrozen(rs.INTEGRIDAD_ESTADO));
    assert.deepStrictEqual(rs.REASON, { SIN_TS: 'sin_ts', OVERSIZE: 'oversize' });
    assert.deepStrictEqual(rs.INTEGRIDAD_ESTADO, { VERIFICADA: 'verificada', NO_VERIFICADA: 'no_verificada' });

    const salidas = [];
    // sin_ts
    salidas.push(rs.readCostWindow({ pipelineDir: PIPELINE, from: FROM, to: TO, fsImpl: fakeFs({ [COST]: jsonl([{ provider: 'a', skill: 'b', issue: 1, tokens_in: 1, tokens_out: 1 }]) }) }));
    // oversize en las tres monoliticas y en las dos fechadas
    for (const f of [COST, EFFECTIVE, LABELS, spawnFile('2026-09-10'), reboundFile('2026-09-10')]) {
        const fsImpl = fakeFs({ [f]: '{}\n' }, { sizes: { [f]: rs.MAX_BYTES_PER_FILE + 1 } });
        const src = rs.readSources({ pipelineDir: PIPELINE, from: FROM, to: TO, fsImpl });
        salidas.push(...Object.values(src).filter((v) => v && v.integridad));
    }
    // ventana vacia
    salidas.push(...Object.values(rs.readSources({ pipelineDir: PIPELINE, from: FROM, to: TO, fsImpl: fakeFs({}) })).filter((v) => v && v.integridad));

    const reasons = new Set(Object.values(rs.REASON));
    const estados = new Set(Object.values(rs.INTEGRIDAD_ESTADO));
    for (const s of salidas) {
        assert.ok(estados.has(s.integridad.estado), `estado ${s.integridad.estado}`);
        if (s.reason !== undefined) assert.ok(reasons.has(s.reason), `reason ${s.reason}`);
        if (!s.evaluable) assert.ok(reasons.has(s.reason), 'no evaluable exige reason del enum');
    }
});

test('parseTs acepta numero e ISO y rechaza lo demas', () => {
    assert.strictEqual(rs.parseTs(1000), 1000);
    assert.strictEqual(rs.parseTs('2026-09-21T00:00:00.000Z'), Date.parse('2026-09-21T00:00:00.000Z'));
    assert.ok(Number.isNaN(rs.parseTs('ayer')));
    assert.ok(Number.isNaN(rs.parseTs(null)));
    assert.ok(Number.isNaN(rs.parseTs(undefined)));
    assert.ok(Number.isNaN(rs.parseTs(Infinity)));
    assert.ok(Number.isNaN(rs.parseTs('')));
});

test('utcDayKey usa UTC y no la zona local', () => {
    assert.strictEqual(rs.utcDayKey(Date.parse('2026-09-20T23:59:59.999Z')), '2026-09-20');
    assert.strictEqual(rs.utcDayKey(Date.parse('2026-09-21T00:00:00.000Z')), '2026-09-21');
});

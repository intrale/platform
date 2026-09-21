'use strict';

// =============================================================================
// audit.test.js — audit trail encadenado (#7519, CA-21 / CA-21b / SEC-R2 / R7).
//
// Usa el `auditLog` REAL sobre un `mkdtemp` (se borra al final) para probar la
// cadena de hashes tras tres corridas. El test funcional de CA-20 (cero
// escrituras) vive en `scripts/__tests__/model-value-report.test.js` con un
// `auditLog` mock; acá lo que se prueba es la forma y la cadena.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const audit = require('../audit');
const report = require('../report');
const auditLog = require('../../audit-log');
const { VERDICT, RIESGO } = require('../recommender');

const { AUDIT_FILE, ENTRY_KEYS, buildEntry, auditFilePath, registrar } = audit;

function reporte(over = {}) {
    const ev = {
        ahorro_mensual_estimado_usd: null, alertas_calidad: ['rebound_alto'], costo_filas_excluidas: 0, costo_reproceso_usd: null,
        costo_ventana_usd: null, difiere: true, modelo_declarado: 'claude-sonnet-4-6', modelo_destino: null,
        modelo_efectivo: 'claude-opus-5', modelos_observados: { 'anthropic|claude-opus-5': 40 }, motivo: ['modelo_sin_precio'],
        n: 40, no_observados: 3, riesgo_estimado: RIESGO.NO_APLICA, ventana: { from: '2026-08-22T00:00:00.000Z', to: '2026-09-21T00:00:00.000Z', dias: 30 },
    };
    return report.buildReport({
        verdicts: {
            skills: {
                guru: { veredicto: VERDICT.NO_EVALUABLE, evidencia: ev },
                doc: { veredicto: VERDICT.MANTENER, evidencia: { ...ev, alertas_calidad: [], motivo: ['costo_no_evaluable'], n: 12.9 } },
            },
            advertencias: ['propagacion_apagada'],
            desconocidos: { skills: 1, providers: 2, models: 0 },
            umbrales: { min_sample: 10, thresholds: {}, protected_skills: ['security'] },
        },
        quality: { skills: { guru: { reboundRate: 0.35 }, doc: {} } },
        freshness: { stale: true, motivo: 'antiguedad', missing_models: [{ provider: 'anthropic', model: 'claude-opus-5', n: 40 }], sha256: 'b'.repeat(64), version: 1, updated_at: '2026-05-08T00:00:00Z' },
        ventana: { from: Date.parse('2026-08-22T00:00:00.000Z'), to: Date.parse('2026-09-21T00:00:00.000Z'), dias: 30 },
        integridad: { spawn_exit: 'verificada', rebound_events: 'no_verificada', label_mutations: 'no_verificada', provider_cost: 'no_verificada', effective_model: 'no_verificada', broken_files: 0, rebound_measurable: false, cost_evaluable: false, cost_reason: 'sin_ts' },
        propagationEnabled: false,
        agentModelsSha256: 'a'.repeat(64),
        generatedAt: Date.parse('2026-09-21T00:00:00.000Z'),
        ...over,
    });
}

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'mva-7519-'));
}

test('CA-21 · buildEntry ⇒ exactamente las claves de C14; skills[*] solo {n, veredicto}; sin motivo/evidencia/texto; sin created_at/hash_*', () => {
    const rep = reporte();
    const entry = buildEntry(rep, { now: () => Date.parse('2026-09-21T12:00:00.000Z') });
    assert.deepEqual(Object.keys(entry).sort(), [...ENTRY_KEYS]);
    assert.deepEqual(ENTRY_KEYS, ['agent_models_sha256', 'integridad', 'pricing', 'propagation_enabled', 'report_sha256', 'skills', 'ts', 'ventana']);
    assert.equal(entry.ts, '2026-09-21T12:00:00.000Z');
    assert.deepEqual(entry.skills, { doc: { n: 12, veredicto: 'mantener' }, guru: { n: 40, veredicto: 'no_evaluable' } });
    for (const s of Object.values(entry.skills)) assert.deepEqual(Object.keys(s).sort(), ['n', 'veredicto']);
    assert.deepEqual(entry.integridad, {
        spawn_exit: 'verificada', rebound_events: 'no_verificada', label_mutations: 'no_verificada',
        provider_cost: 'no_verificada', effective_model: 'no_verificada', broken_files: 0,
    });
    assert.deepEqual(entry.pricing, { sha256: 'b'.repeat(64), version: 1, updated_at: '2026-05-08T00:00:00Z' });
    assert.equal(entry.agent_models_sha256, 'a'.repeat(64));
    assert.equal(entry.report_sha256, rep.sha256);
    assert.equal(entry.propagation_enabled, false);
    assert.deepEqual(entry.ventana, { from: '2026-08-22T00:00:00.000Z', to: '2026-09-21T00:00:00.000Z', dias: 30 });
    const json = JSON.stringify(entry);
    for (const prohibido of ['motivo', 'evidencia', 'alertas_calidad', 'modelos_observados', 'modelo_sin_precio', 'claude-opus-5', 'created_at', 'hash_prev', 'hash_self', 'umbrales', 'desconocidos']) {
        assert.ok(!json.includes(prohibido), `la entry no lleva ${prohibido}`);
    }
});

test('CA-21 / SEC-R2 · buildEntry sanea: hashes no hex ⇒ null, estados desconocidos ⇒ rota, contadores negativos ⇒ 0, skills sin veredicto se omiten', () => {
    const rep = reporte();
    rep.sha256 = 'no-es-hex';
    rep.agent_models_sha256 = 'x'.repeat(64);
    rep.precios.sha256 = null;
    rep.integridad.spawn_exit = 'lo que sea';
    rep.integridad.broken_files = -3;
    rep.skills.raro = { evidencia: {} };
    rep.skills.guru.evidencia.n = 'muchas';
    const entry = buildEntry(rep, { now: () => 0 });
    assert.equal(entry.report_sha256, null);
    assert.equal(entry.agent_models_sha256, null);
    assert.equal(entry.pricing.sha256, null);
    assert.equal(entry.integridad.spawn_exit, 'rota');
    assert.equal(entry.integridad.broken_files, 0);
    assert.deepEqual(Object.keys(entry.skills).sort(), ['doc', 'guru']);
    assert.equal(entry.skills.guru.n, 0);
    assert.throws(() => buildEntry(null), /reporte requerido/);
});

test('CA-21 · 3 registrar encadenados con auditLog real ⇒ verifyChain ok, readAll devuelve 3 con report_sha256 correcto', () => {
    const dir = tmpDir();
    try {
        const reps = [reporte(), reporte({ propagationEnabled: true }), reporte({ agentModelsSha256: 'c'.repeat(64) })];
        const outs = reps.map((r, i) => registrar({ pipelineDir: dir, report: r, auditLog, now: () => 1000 + i }));
        const file = auditFilePath(dir);
        assert.ok(fs.existsSync(file));
        assert.equal(path.basename(file), AUDIT_FILE);
        assert.equal(outs[0].hash_prev, auditLog.GENESIS);
        assert.equal(outs[1].hash_prev, outs[0].hash_self);
        assert.equal(outs[2].hash_prev, outs[1].hash_self);
        const chain = auditLog.verifyChain(file);
        assert.equal(chain.ok, true);
        assert.equal(chain.entriesChecked, 3);
        const all = auditLog.readAll(file);
        assert.equal(all.length, 3);
        all.forEach((e, i) => {
            assert.equal(e.report_sha256, reps[i].sha256);
            assert.equal(e.propagation_enabled, reps[i].propagation_enabled);
            assert.equal(e.agent_models_sha256, reps[i].agent_models_sha256);
            assert.ok(typeof e.created_at === 'number');
            assert.match(e.hash_self, /^[0-9a-f]{64}$/);
            const { created_at, hash_prev, hash_self, ...propias } = e;
            assert.deepEqual(Object.keys(propias).sort(), [...ENTRY_KEYS]);
        });
        // Distintos reportes ⇒ distintos sha (el hash del reporte firma el contenido).
        assert.notEqual(reps[0].sha256, reps[1].sha256);
        // Ningún lockfile queda colgado.
        assert.ok(!fs.existsSync(`${file}.lock`));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('CA-21b / SEC-R7 · auditFilePath es constante y queda debajo del pipelineDir resuelto (path traversal)', () => {
    const p = auditFilePath('tmp/../tmp2');
    assert.ok(p.startsWith(path.resolve('tmp2') + path.sep), p);
    assert.equal(path.basename(p), AUDIT_FILE);
    assert.equal(path.basename(path.dirname(p)), 'audit');
    assert.equal(AUDIT_FILE, 'model-value-audit.jsonl');
    assert.equal(auditFilePath('/a/b'), path.join(path.resolve('/a/b'), 'audit', AUDIT_FILE));
});

test('CA-21b · registrar = ensureSecureAuditFile + UNA appendChained; propaga excepciones (C15)', () => {
    const llamadas = [];
    const mock = {
        appendChained({ file, entry, fsImpl }) {
            llamadas.push({ file, entry, fsImpl });
            return { hash_self: 'h', hash_prev: 'GENESIS', line: '' };
        },
    };
    const fsCalls = [];
    const fsImpl = {
        mkdirSync: (...a) => { fsCalls.push(['mkdirSync', a[0]]); },
        openSync: (...a) => { fsCalls.push(['openSync', a[0], a[1], a[2]]); return 7; },
        closeSync: (fd) => { fsCalls.push(['closeSync', fd]); },
        chmodSync: (...a) => { fsCalls.push(['chmodSync', a[0], a[1]]); },
    };
    const rep = reporte();
    const out = registrar({ pipelineDir: 'rel/dir', report: rep, fsImpl, auditLog: mock, now: () => 5 });
    assert.equal(out.hash_self, 'h');
    assert.equal(llamadas.length, 1);
    assert.equal(llamadas[0].file, auditFilePath('rel/dir'));
    assert.equal(llamadas[0].fsImpl, fsImpl);
    assert.deepEqual(Object.keys(llamadas[0].entry).sort(), [...ENTRY_KEYS]);
    assert.deepEqual(fsCalls.map((c) => c[0]), ['mkdirSync', 'openSync', 'closeSync', 'chmodSync']);
    assert.equal(fsCalls[1][2], 'a');
    assert.equal(fsCalls[1][3], 0o600);
    assert.equal(fsCalls[3][2], 0o600);

    const roto = { appendChained() { throw new Error('lock no adquirido'); } };
    assert.throws(() => registrar({ pipelineDir: 'rel/dir', report: rep, fsImpl, auditLog: roto }), /lock no adquirido/);

    // ensureSecureAuditFile nunca tira aunque el fs falle.
    assert.doesNotThrow(() => audit.ensureSecureAuditFile('/x/y', { mkdirSync() { throw new Error('EACCES'); } }));
    assert.doesNotThrow(() => audit.ensureSecureAuditFile('/x/y', { mkdirSync() {}, openSync() { return 1; }, closeSync() {}, chmodSync() { throw new Error('EPERM'); } }));
});

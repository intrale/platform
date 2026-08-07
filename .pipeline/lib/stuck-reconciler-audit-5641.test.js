'use strict';
// =============================================================================
// stuck-reconciler-audit-5641.test.js — #5641 CA-3 y CA-17.
//
//  - CA-3: la marca de procedencia sobrevive el ciclo de vida del deliverable
//    (`trabajando/ → listo/ → procesado/`). Es el modo de fallo silencioso más
//    probable del cambio: si alguna promoción filtrara claves, el detector no
//    vería nunca la procedencia y todo el carril de infra quedaría muerto por
//    fail-closed sin que nada lo avise.
//  - CA-17: cada acción real del reconciler deja entrada en un JSONL
//    append-only, sanitizada.
// =============================================================================

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

const { buildAuditWriter } = require('./stuck-reconciler-deps');

function tmpDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ─── CA-3: round-trip del deliverable ───────────────────────────────────────

// Réplicas exactas de los helpers de `pulpo.js` (L1549 `writeYaml`, L1646
// `moveFile` = `fs.renameSync` puro). Se replican en vez de requerir el Pulpo
// porque cargarlo tiene side-effects.
function writeYaml(filepath, data) {
    fs.mkdirSync(path.dirname(filepath), { recursive: true });
    fs.writeFileSync(filepath, yaml.dump(data, { lineWidth: -1 }));
}
function readYamlSafe(filepath) {
    try { return yaml.load(fs.readFileSync(filepath, 'utf8')) || {}; } catch { return {}; }
}
function moveFile(src, dstDir) {
    fs.mkdirSync(dstDir, { recursive: true });
    const dst = path.join(dstDir, path.basename(src));
    fs.renameSync(src, dst);
    return dst;
}

test('CA-3 la procedencia sobrevive trabajando/ → listo/ → procesado/', () => {
    const root = tmpDir('5641-rt-');
    const trabajando = path.join(root, 'trabajando');
    const listo = path.join(root, 'listo');
    const procesado = path.join(root, 'procesado');

    // 1. El Pulpo sintetiza el veredicto por exit code ≠ 0 en `trabajando/`.
    const src = path.join(trabajando, '5175.po');
    writeYaml(src, {
        issue: 5175,
        fase: 'aprobacion',
        resultado: 'rechazado',
        motivo: 'Agente terminó con código 1',
        veredicto_sintetizado_por: 'pulpo',
        agente_exit_code: 1,
    });

    // 2. On-exit: trabajando/ → listo/   3. Promoción: listo/ → procesado/
    const enProcesado = moveFile(moveFile(src, listo), procesado);

    const y = readYamlSafe(enProcesado);
    assert.equal(y.veredicto_sintetizado_por, 'pulpo', 'sin esto el carril de infra queda muerto');
    assert.equal(y.agente_exit_code, 1);
    assert.equal(y.resultado, 'rechazado');
    fs.rmSync(root, { recursive: true, force: true });
});

test('CA-4 el drenaje fast-fail preserva el veredicto previo y agrega el disparador', () => {
    const root = tmpDir('5641-drain-');
    const src = path.join(root, 'pendiente', '5175.ux');
    writeYaml(src, { issue: 5175, fase: 'aprobacion', algo_previo: 'x' });

    // Réplica del drenaje de `pulpo.js`: spread de `prev` + campos de cancelación.
    const prev = readYamlSafe(src);
    const dst = path.join(root, 'procesado', '5175.ux');
    writeYaml(dst, {
        ...prev,
        cancelado_por: 'fast-fail-rebote',
        cancelado_ts: new Date().toISOString(),
        cancelado_disparado_por: 'po',
        cancelado_disparador_infra: true,
    });

    const y = readYamlSafe(dst);
    assert.equal(y.algo_previo, 'x', 'el spread no debe perder campos previos');
    assert.equal(y.cancelado_disparado_por, 'po');
    assert.equal(y.cancelado_disparador_infra, true);
    fs.rmSync(root, { recursive: true, force: true });
});

// ─── CA-17: audit JSONL append-only ─────────────────────────────────────────

function auditHarness(over = {}) {
    const dir = tmpDir('5641-audit-');
    const lines = [];
    const writer = buildAuditWriter({
        fs,
        pipelineDir: dir,
        log: (canal, msg) => lines.push(`${canal}:${msg}`),
        sanitize: (s) => String(s),
        now: () => '2026-08-07T10:00:00.000Z',
        ...over,
    });
    const file = path.join(dir, 'audit', 'stuck-requeue-2026-08-07.jsonl');
    const read = () => (fs.existsSync(file)
        ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
        : []);
    return { dir, writer, file, read, lines, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('CA-17 el requeue queda asentado en el JSONL con ts, exit code y contadores', () => {
    const h = auditHarness();
    h.writer({
        action: 'requeue', issue: 5175, pipeline: 'desarrollo', fase: 'aprobacion',
        skills: ['po', 'review', 'ux'], reason: 'caída de infra: po (exit 1) · intento 1/2',
        agente_exit_code: 1, reintentos_antes: 0, reintentos_despues: 1,
    });
    const recs = h.read();
    assert.equal(recs.length, 1);
    assert.equal(recs[0].ts, '2026-08-07T10:00:00.000Z');
    assert.equal(recs[0].issue, 5175);
    assert.equal(recs[0].agente_exit_code, 1);
    assert.deepEqual(recs[0].skills, ['po', 'review', 'ux']);
    h.cleanup();
});

test('CA-17 append-only: una segunda escritura NO trunca la anterior', () => {
    const h = auditHarness();
    h.writer({ action: 'requeue', issue: 1, reason: 'primera' });
    h.writer({ action: 'escalate', issue: 2, reason: 'segunda' });
    const recs = h.read();
    assert.equal(recs.length, 2, 'el histórico de la corrida anterior no se pisa');
    assert.equal(recs[0].reason, 'primera');
    assert.equal(recs[1].action, 'escalate');
    h.cleanup();
});

test('CA-17 los `none` no ensucian el JSONL (siguen sólo en el log de texto)', () => {
    const h = auditHarness();
    h.writer({ action: 'none', issue: 1, reason: 'reciente' });
    assert.deepEqual(h.read(), []);
    assert.equal(h.lines.length, 1, 'pero sí queda en el log del Pulpo');
    h.cleanup();
});

test('R-4 el reason pasa por el sanitizador antes de persistir', () => {
    const h = auditHarness({ sanitize: (s) => String(s).replace(/AKIA[A-Z0-9]+/g, '[REDACTED]') });
    h.writer({ action: 'requeue', issue: 1, reason: 'el agente logueó AKIAIOSFODNN7EXAMPLE en el motivo' });
    const recs = h.read();
    assert.match(recs[0].reason, /\[REDACTED\]/);
    assert.doesNotMatch(recs[0].reason, /AKIAIOSFODNN7EXAMPLE/);
    h.cleanup();
});

test('R-4 el writer es best-effort: un fallo de IO no tumba el tick', () => {
    const h = auditHarness({
        fs: { mkdirSync: () => { throw new Error('disco lleno'); }, appendFileSync: () => { throw new Error('nope'); } },
    });
    assert.doesNotThrow(() => h.writer({ action: 'requeue', issue: 1, reason: 'x' }));
    h.cleanup();
});

test('R-4 el writer usa appendFileSync en modo append, nunca writeFileSync', () => {
    const src = fs.readFileSync(path.join(__dirname, 'stuck-reconciler-deps.js'), 'utf8');
    const bloque = src.slice(src.indexOf('function buildAuditWriter'), src.indexOf('function labelNameOf'));
    assert.ok(/appendFileSync/.test(bloque));
    assert.ok(!/writeFileSync/.test(bloque), 'writeFileSync truncaría el histórico');
});

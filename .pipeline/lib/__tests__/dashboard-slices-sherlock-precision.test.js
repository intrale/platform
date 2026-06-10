// =============================================================================
// dashboard-slices-sherlock-precision.test.js — Suite del slice de precisión
// de Sherlock (#3897 CA-4, split 3/3 del épico #3894).
//
// Cubre:
//   - CA-4: agregados correctos (ratio, contadores, not_verifiable count).
//   - CA-4: alerta visible con ratio < 0.80; target 0.90.
//   - UX-1: totales < 5 → insufficient_sample: true.
//   - SEC-6 (NO NEGOCIABLE): el payload contiene SOLO campos numéricos/
//     booleanos/null de agregado — falla ante CUALQUIER string derivado del
//     audit (claim, comando, stdout, session). Los registros del fixture
//     embeben textos "radioactivos" para detectar fugas.
//   - Degrade limpio: audit dir ausente / JSONL corrupto → estado vacío.
//
// Diseño: FS real sobre mkdtemp (sin red, sin shell). El slice lee
// `<PIPELINE>/audit/sherlock-*.jsonl` igual que en producción.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const slices = require('../dashboard-slices');

// Textos radioactivos: si CUALQUIERA aparece en el payload serializado,
// el slice está fugando contenido del audit (violación SEC-6).
const RADIOACTIVE = {
    claim: '#3729/entregable_en_main RADIOACTIVE_CLAIM',
    command: 'gh pr view 3890 --json state RADIOACTIVE_CMD ghp_FAKE0123456789012345678901234567890123',
    stdout: 'MERGED RADIOACTIVE_STDOUT C:\\Workspaces\\secret\\path',
    session: 'sesion-radioactiva-3729',
};

function mkPipelineDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlock-precision-'));
    fs.mkdirSync(path.join(dir, 'audit'), { recursive: true });
    return dir;
}

// Construye un registro del audit con el shape real del writer de #3896
// (`sherlock-audit-jsonl.js`) + campos de chain de `audit-log.js`.
function record({ correcta, notVerifiable } = {}) {
    if (notVerifiable) {
        return {
            timestamp: '2026-06-10T12:00:00.000Z',
            claim: RADIOACTIVE.claim,
            canonical_command: RADIOACTIVE.command,
            stdout: null,
            stderr: null,
            resultado: 'not_verifiable',
            commander_vs_sherlock: 'not_verifiable',
            resolucion: 'escalated',
            hash_prev: 'GENESIS',
            hash_self: 'abc123',
            created_at: '2026-06-10T12:00:00.000Z',
        };
    }
    return {
        timestamp: '2026-06-10T12:00:00.000Z',
        claim: RADIOACTIVE.claim,
        canonical_command: RADIOACTIVE.command,
        stdout: RADIOACTIVE.stdout,
        stderr: null,
        // correcta: resolución coherente con el árbitro canónico.
        // incorrecta: contradicción emitida sin respaldo (falso positivo #3729).
        resultado: correcta ? 'true' : 'false',
        commander_vs_sherlock: correcta ? 'consistent' : 'consistent',
        resolucion: correcta ? 'accepted' : 'rejected',
        hash_prev: 'abc123',
        hash_self: 'def456',
        created_at: '2026-06-10T12:00:00.000Z',
    };
}

function writeAudit(pipelineDir, session, records) {
    const file = path.join(pipelineDir, 'audit', `sherlock-${session}.jsonl`);
    fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function sliceFor(pipelineDir) {
    return slices.sherlockPrecisionSlice({}, { PIPELINE: pipelineDir });
}

// -----------------------------------------------------------------------------
// CA-4 — agregados correctos.
// -----------------------------------------------------------------------------
test('CA-4: ratio con denominador correcto + not_verifiable contado aparte', () => {
    const dir = mkPipelineDir();
    const records = [
        ...Array.from({ length: 9 }, () => record({ correcta: true })),
        record({ correcta: false }),
        record({ notVerifiable: true }),
        record({ notVerifiable: true }),
    ];
    writeAudit(dir, 'caso-3729', records);

    const out = sliceFor(dir);
    assert.equal(out.correctas, 9);
    assert.equal(out.totales, 10);
    assert.equal(out.not_verifiable, 2);
    assert.equal(out.ratio, 0.9);
    assert.equal(out.target, 0.90);
    assert.equal(out.insufficient_sample, false);
    assert.equal(out.alert, false, 'ratio 0.9 ≥ 0.80 → sin alerta');
});

test('CA-4: agrega registros de MÚLTIPLES sesiones sherlock-*.jsonl', () => {
    const dir = mkPipelineDir();
    writeAudit(dir, 'sesion-a', Array.from({ length: 4 }, () => record({ correcta: true })));
    writeAudit(dir, 'sesion-b', [record({ correcta: true }), record({ correcta: false })]);

    const out = sliceFor(dir);
    assert.equal(out.totales, 6);
    assert.equal(out.correctas, 5);
});

// -----------------------------------------------------------------------------
// CA-4 — alerta < 80%.
// -----------------------------------------------------------------------------
test('CA-4: ratio < 0.80 → alert: true', () => {
    const dir = mkPipelineDir();
    const records = [
        ...Array.from({ length: 7 }, () => record({ correcta: true })),
        ...Array.from({ length: 3 }, () => record({ correcta: false })),
    ];
    writeAudit(dir, 'sesion-degradada', records);

    const out = sliceFor(dir);
    assert.equal(out.ratio, 0.7);
    assert.equal(out.alert, true, 'ratio 0.7 < 0.80 → alerta visible');
});

test('CA-4: ratio exactamente 0.80 NO alerta (umbral estricto <)', () => {
    const dir = mkPipelineDir();
    const records = [
        ...Array.from({ length: 8 }, () => record({ correcta: true })),
        ...Array.from({ length: 2 }, () => record({ correcta: false })),
    ];
    writeAudit(dir, 'sesion-borde', records);
    const out = sliceFor(dir);
    assert.equal(out.ratio, 0.8);
    assert.equal(out.alert, false);
});

// -----------------------------------------------------------------------------
// UX-1 — muestra insuficiente.
// -----------------------------------------------------------------------------
test('UX-1: totales < 5 → insufficient_sample: true (sin falsa señal de semáforo)', () => {
    const dir = mkPipelineDir();
    writeAudit(dir, 'sesion-chica', [
        record({ correcta: true }),
        record({ correcta: true }),
        record({ correcta: false }),
    ]);
    const out = sliceFor(dir);
    assert.equal(out.totales, 3);
    assert.equal(out.insufficient_sample, true);
});

test('UX-1: audit vacío → ratio null + insufficient_sample true (muestra vacía, no 0%)', () => {
    const dir = mkPipelineDir();
    const out = sliceFor(dir);
    assert.equal(out.ratio, null);
    assert.equal(out.totales, 0);
    assert.equal(out.insufficient_sample, true);
    assert.equal(out.alert, false, 'sin muestra NO se alerta');
});

// -----------------------------------------------------------------------------
// SEC-6 — forma del payload: SOLO agregados numéricos/booleanos/null.
// Falla ante cualquier string derivado del audit.
// -----------------------------------------------------------------------------
const ALLOWED_KEYS = new Set([
    'correctas', 'totales', 'not_verifiable', 'ratio',
    'insufficient_sample', 'target', 'alert',
]);

test('SEC-6: el payload contiene SOLO campos numéricos/booleanos/null de agregado', () => {
    const dir = mkPipelineDir();
    writeAudit(dir, 'sesion-sec6', [
        ...Array.from({ length: 6 }, () => record({ correcta: true })),
        record({ correcta: false }),
        record({ notVerifiable: true }),
    ]);
    const out = sliceFor(dir);

    for (const [key, value] of Object.entries(out)) {
        assert.ok(ALLOWED_KEYS.has(key), `SEC-6: campo no permitido en el payload: "${key}"`);
        const t = typeof value;
        assert.ok(
            value === null || t === 'number' || t === 'boolean',
            `SEC-6: campo "${key}" tiene tipo ${t} — solo number/boolean/null permitidos`
        );
    }
    // Sin arrays de entries ni objetos anidados (prohibido `entries[]`).
    assert.ok(!Array.isArray(out.entries), 'SEC-6: prohibido entries[]');
});

test('SEC-6: ningún texto del audit (claim/comando/stdout/session/token) fuga al payload', () => {
    const dir = mkPipelineDir();
    writeAudit(dir, RADIOACTIVE.session, [
        record({ correcta: true }),
        record({ correcta: false }),
        record({ notVerifiable: true }),
    ]);
    const serialized = JSON.stringify(sliceFor(dir));
    for (const [name, payload] of Object.entries(RADIOACTIVE)) {
        // Basta con un fragmento distintivo de cada texto radioactivo.
        const marker = payload.split(' ')[0];
        assert.ok(
            !serialized.includes('RADIOACTIVE') && !serialized.includes('ghp_') && !serialized.includes(marker)
                || (name === 'session' && !serialized.includes(payload)),
            `SEC-6: el payload incluye contenido del audit (${name})`
        );
    }
    assert.ok(!serialized.includes('RADIOACTIVE'), 'SEC-6: fuga de texto del audit');
    assert.ok(!serialized.includes('ghp_'), 'SEC-6: fuga de token');
    assert.ok(!serialized.includes('radioactiva'), 'SEC-6: fuga de session-id');
});

// -----------------------------------------------------------------------------
// Degrade limpio.
// -----------------------------------------------------------------------------
test('degrade: audit dir ausente → estado vacío sin throw', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlock-precision-noaudit-'));
    const out = sliceFor(dir);
    assert.equal(out.ratio, null);
    assert.equal(out.totales, 0);
});

test('degrade: líneas corruptas en el JSONL se saltean sin romper el agregado', () => {
    const dir = mkPipelineDir();
    const file = path.join(dir, 'audit', 'sherlock-corrupta.jsonl');
    const good = JSON.stringify(record({ correcta: true }));
    fs.writeFileSync(file, `${good}\n{esto no es json}\n${good}\n\n`);
    const out = sliceFor(dir);
    assert.equal(out.totales, 2);
    assert.equal(out.correctas, 2);
});

test('degrade: archivos no-sherlock en audit/ se ignoran', () => {
    const dir = mkPipelineDir();
    fs.writeFileSync(path.join(dir, 'audit', 'otra-cosa.jsonl'),
        JSON.stringify(record({ correcta: false })) + '\n');
    writeAudit(dir, 'real', [record({ correcta: true })]);
    const out = sliceFor(dir);
    assert.equal(out.totales, 1);
    assert.equal(out.correctas, 1);
});

// -----------------------------------------------------------------------------
// Helper interno — coherencia resolución ↔ árbitro.
// -----------------------------------------------------------------------------
test('_sherlockRecordCorrecto: contradicción respaldada (inconsistent+rejected) es correcta', () => {
    assert.equal(slices._sherlockRecordCorrecto({ commander_vs_sherlock: 'inconsistent', resolucion: 'rejected' }), true);
    assert.equal(slices._sherlockRecordCorrecto({ commander_vs_sherlock: 'consistent', resolucion: 'accepted' }), true);
    // Falso positivo estilo #3729: contradice sin respaldo del árbitro.
    assert.equal(slices._sherlockRecordCorrecto({ commander_vs_sherlock: 'consistent', resolucion: 'rejected' }), false);
    assert.equal(slices._sherlockRecordCorrecto({ commander_vs_sherlock: 'inconsistent', resolucion: 'accepted' }), false);
    assert.equal(slices._sherlockRecordCorrecto(null), false);
});

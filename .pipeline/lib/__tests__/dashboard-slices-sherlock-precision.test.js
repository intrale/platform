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
// #3921 CA-3 — agregado de % same-provider (meta < 10%).
// -----------------------------------------------------------------------------
// Record con el flag `same_provider` (boolean) tal como lo persiste el writer
// canónico tras #3921.
function recordSameProvider(sameProvider) {
    return {
        ...record({ correcta: true }),
        same_provider: sameProvider,
    };
}

test('#3921 CA-3: sherlockPrecisionSlice agrega % same_provider sobre el total de records que declaran el flag', () => {
    const dir = mkPipelineDir();
    // 1 same-provider + 9 cross-provider → 10% (>= meta → alerta visible).
    const records = [
        recordSameProvider(true),
        ...Array.from({ length: 9 }, () => recordSameProvider(false)),
    ];
    writeAudit(dir, 'sesion-sp', records);

    const out = sliceFor(dir);
    assert.equal(out.same_provider_total, 10, 'denominador = records con el flag');
    assert.equal(out.same_provider_count, 1, 'numerador = same_provider===true');
    assert.equal(out.same_provider_ratio, 0.1);
    assert.equal(out.same_provider_target, 0.10, 'meta visible < 10%');
    assert.equal(out.same_provider_alert, true, 'ratio 0.10 >= meta 0.10 → alerta (umbral inclusivo)');
});

test('#3921 CA-3: % same_provider por debajo de la meta NO alerta', () => {
    const dir = mkPipelineDir();
    // 1 same-provider + 19 cross-provider → 5% < 10%.
    const records = [
        recordSameProvider(true),
        ...Array.from({ length: 19 }, () => recordSameProvider(false)),
    ];
    writeAudit(dir, 'sesion-sp-ok', records);
    const out = sliceFor(dir);
    assert.equal(out.same_provider_total, 20);
    assert.equal(out.same_provider_count, 1);
    assert.equal(out.same_provider_ratio, 0.05);
    assert.equal(out.same_provider_alert, false, '5% < 10% → sin alerta');
});

test('#3921 CA-3/SEC-3: records SIN el flag same_provider no entran al denominador (no manipulable por omisión)', () => {
    const dir = mkPipelineDir();
    // Mezcla: 1 con flag true, 1 con flag false, 3 legacy sin flag.
    const records = [
        recordSameProvider(true),
        recordSameProvider(false),
        record({ correcta: true }),
        record({ correcta: true }),
        record({ correcta: false }),
    ];
    writeAudit(dir, 'sesion-sp-mixed', records);
    const out = sliceFor(dir);
    assert.equal(out.same_provider_total, 2, 'solo los records con el flag cuentan en el denominador');
    assert.equal(out.same_provider_count, 1);
    assert.equal(out.same_provider_ratio, 0.5);
});

test('#3921 CA-3: sin records con flag same_provider → ratio null (muestra vacía, no 0%)', () => {
    const dir = mkPipelineDir();
    writeAudit(dir, 'sesion-sp-empty', [record({ correcta: true }), record({ correcta: false })]);
    const out = sliceFor(dir);
    assert.equal(out.same_provider_total, 0);
    assert.equal(out.same_provider_ratio, null);
    assert.equal(out.same_provider_alert, false);
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
    // CA-3/SEC-4 (#3921) — agregado same-provider: solo contadores/ratio/boolean,
    // sin PII ni texto del audit.
    'same_provider_count', 'same_provider_total', 'same_provider_ratio',
    'same_provider_target', 'same_provider_alert',
    // #3923 EP2-H3 — tasa not_verifiable por fuente: objeto de contadores con
    // claves de ENUM cerrado (sin claims/comandos/stdout). Validado aparte abajo.
    'not_verifiable_by_source',
    // #3961 EP8-H8 — desglose por provider (objeto de agregados numéricos) +
    // sparklines diarias (arrays de numbers). Sin claims/comandos/stdout/PII.
    'by_provider', 'spark7d', 'same_provider_spark7d',
]);

// #3923 — claves permitidas dentro de not_verifiable_by_source (enum cerrado).
const NV_SOURCE_KEYS = new Set(['git', 'github-api', 'heartbeat', 'filesystem', 'pipeline-state', 'waves']);

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
        // #3923 — único objeto anidado permitido: not_verifiable_by_source, cuyas
        // claves son del enum cerrado y cuyos valores son SOLO numbers.
        if (key === 'not_verifiable_by_source') {
            assert.ok(value && typeof value === 'object' && !Array.isArray(value),
                'SEC-6: not_verifiable_by_source debe ser objeto plano');
            for (const [src, count] of Object.entries(value)) {
                assert.ok(NV_SOURCE_KEYS.has(src), `SEC-6: fuente fuera del enum cerrado: "${src}"`);
                assert.equal(typeof count, 'number', `SEC-6: contador "${src}" no es number`);
            }
            continue;
        }
        // #3961 EP8-H8 — by_provider: objeto cuyos valores son SOLO agregados
        // numéricos/booleanos/null por provider (sin texto del audit).
        if (key === 'by_provider') {
            assert.ok(value && typeof value === 'object' && !Array.isArray(value),
                'SEC-6: by_provider debe ser objeto plano');
            for (const acc of Object.values(value)) {
                for (const [f, v] of Object.entries(acc)) {
                    const tt = typeof v;
                    assert.ok(v === null || tt === 'number' || tt === 'boolean',
                        `SEC-6: by_provider.${f} tipo ${tt} — solo number/boolean/null`);
                }
            }
            continue;
        }
        // #3961 EP8-H8 — sparklines: arrays de numbers, nada más.
        if (key === 'spark7d' || key === 'same_provider_spark7d') {
            assert.ok(Array.isArray(value), `SEC-6: ${key} debe ser array`);
            for (const n of value) assert.equal(typeof n, 'number', `SEC-6: ${key} con no-number`);
            continue;
        }
        const t = typeof value;
        assert.ok(
            value === null || t === 'number' || t === 'boolean',
            `SEC-6: campo "${key}" tiene tipo ${t} — solo number/boolean/null permitidos`
        );
    }
    // Sin arrays de entries ni objetos anidados (prohibido `entries[]`).
    assert.ok(!Array.isArray(out.entries), 'SEC-6: prohibido entries[]');
});

// -----------------------------------------------------------------------------
// #3923 EP2-H3 / CA-10 — tasa not_verifiable POR FUENTE (insumo EP8-H8).
// -----------------------------------------------------------------------------
function recordNvSource(source) {
    return { ...record({ notVerifiable: true }), source };
}

test('CA-10: not_verifiable_by_source acumula contadores por fuente del enum cerrado', () => {
    const dir = mkPipelineDir();
    writeAudit(dir, 'sesion-nv-src', [
        recordNvSource('git'),
        recordNvSource('git'),
        recordNvSource('pipeline-state'),
        recordNvSource('waves'),
        recordNvSource('heartbeat'),
        // fuente fuera del enum → NO se acumula (no rompe el shape).
        recordNvSource('fuente-trucha'),
        // record sin source → cuenta en not_verifiable total pero no por fuente.
        record({ notVerifiable: true }),
        record({ correcta: true }),
    ]);
    const out = sliceFor(dir);
    assert.equal(out.not_verifiable, 7, 'total not_verifiable incluye los sin source y el fuera de enum');
    assert.deepEqual(out.not_verifiable_by_source, {
        git: 2, 'github-api': 0, heartbeat: 1, filesystem: 0, 'pipeline-state': 1, waves: 1,
    });
});

test('CA-10: not_verifiable_by_source emite el enum completo con ceros cuando no hay not_verifiable', () => {
    const dir = mkPipelineDir();
    writeAudit(dir, 'sesion-nv-zero', [record({ correcta: true }), record({ correcta: false })]);
    const out = sliceFor(dir);
    assert.deepEqual(out.not_verifiable_by_source, {
        git: 0, 'github-api': 0, heartbeat: 0, filesystem: 0, 'pipeline-state': 0, waves: 0,
    });
});

test('CA-10: degrade (audit ausente) emite el mismo shape con ceros', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlock-precision-nvdeg-'));
    // Forzamos degrade: dir sin subcarpeta audit/ legible no rompe; usamos un
    // PIPELINE cuyo readdir lanza no es trivial, así que validamos el shape del
    // estado vacío (mismo enum con ceros) que devuelve el camino normal sin audit.
    const out = sliceFor(dir);
    assert.deepEqual(out.not_verifiable_by_source, {
        git: 0, 'github-api': 0, heartbeat: 0, filesystem: 0, 'pipeline-state': 0, waves: 0,
    });
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

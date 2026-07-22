// =============================================================================
// Tests #4861 — Cuota Anthropic: fuente única = claude -p /usage.
//
// Verifica el FAIL-CLOSED del slice de cuota (`quotaSlice`) cuando no hay dato
// real de /usage: el resultado de Anthropic debe ser SIN-DATO explícito
// (`pct: null`, `status: 'unknown'`), NUNCA un valor heurístico ni un default
// permisivo (pct: 0). La cuota gobierna pacing/gating; un fail-open habilitaría
// cost-DoS por sobreconsumo pago (security OWASP A04, CA-4 del PO).
//
// También chequea que la heurística `computeQuota` y la calibración EMA ya no
// forman parte del módulo weekly-quota (retiradas en #4861).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshSlices() {
    delete require.cache[require.resolve('../dashboard-slices')];
    return require('../dashboard-slices');
}

function mkTmpPipeline() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-quota-failclosed-4861-'));
    const pipeline = path.join(root, '.pipeline');
    fs.mkdirSync(path.join(pipeline, 'metrics'), { recursive: true });
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    // activity-log vacío: sin datos que una heurística pudiera usar.
    fs.writeFileSync(path.join(root, '.claude', 'activity-log.jsonl'), '');
    return { root, pipeline };
}

// ---------------------------------------------------------------------------
// CA-4 — fail-closed: sin cache de /usage, la cuota Anthropic es "sin dato".
// ---------------------------------------------------------------------------
test('CA-4: sin cache de /usage, quotaSlice devuelve Anthropic fail-closed (pct null, status unknown)', () => {
    const { root, pipeline } = mkTmpPipeline();
    // Sanity: NO existe el cache de anthropic-usage → el adapter degrada.
    assert.ok(!fs.existsSync(path.join(pipeline, 'metrics', 'anthropic-usage.json')), 'sanity: sin cache /usage');

    const slices = freshSlices();
    const out = slices.quotaSlice({}, { ROOT: root, PIPELINE: pipeline });

    // Flat-merge legacy al top-level (lo consumen renderQuotaCard/tickQuota).
    assert.equal(out.pct, null, 'pct debe ser null — NUNCA 0 ni un valor heurístico');
    assert.equal(out.status, 'unknown', 'status debe ser unknown');
    assert.notEqual(typeof out.pct, 'number', 'no debe haber pct numérico calculado');

    // El provider Anthropic dentro de `providers` (shape cliente normalizado)
    // también fail-closed: pct null y confidence 'missing' por ventana.
    const a = out.providers && out.providers.anthropic;
    assert.ok(a, 'debe existir el provider anthropic');
    assert.ok(['unknown', 'error'].includes(a.adapterStatus), 'adapterStatus debe ser unknown/error, no ok');
    assert.equal(a.weekly.pct, null, 'providers.anthropic.weekly.pct debe ser null');
    assert.equal(a.session.pct, null, 'providers.anthropic.session.pct debe ser null');
    assert.equal(a.weekly.confidence, 'missing', 'weekly.confidence debe ser missing (sin dato)');
});

// ---------------------------------------------------------------------------
// CA-2 / CA-3 — la heurística y la calibración salieron del módulo.
// ---------------------------------------------------------------------------
test('CA-3: weekly-quota ya no expone computeQuota/saveCalibration/clearCalibration', () => {
    delete require.cache[require.resolve('../weekly-quota')];
    const wq = require('../weekly-quota');
    assert.equal(wq.computeQuota, undefined);
    assert.equal(wq.saveCalibration, undefined);
    assert.equal(wq.clearCalibration, undefined);
    // Los helpers de reset semanal se conservan (pacing/exhaustion los usan).
    assert.equal(typeof wq.getLastWeeklyResetMs, 'function');
    assert.equal(typeof wq.getNextWeeklyResetMs, 'function');
});

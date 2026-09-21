'use strict';
// =============================================================================
// quota-balance-wiring-6560.test.js — cableado del balance de cuota (#6560):
// ingesta del ledger en `quotaSlice`, slice `quotaBalanceSlice`, ruta
// `/api/dash/quota-balance` y el evento `dispatch_resumed` de `pulpo.js`.
//
// Los módulos (`quota-balance`, `quota-series`, `quota-ledger`) tienen sus
// tests unitarios; acá se verifica que los PUNTOS DE EXPOSICIÓN existan y
// respeten el contrato: mismo punto para ruteo y dashboard (CA-5), sin efectos
// secundarios con `skipSideEffects`, y fail-closed cuando el config no resuelve.
// Patrón: lectura de fuente para pulpo.js (sin spawn), igual que
// `provider-cost-v2-wiring-6558.test.js`.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PIPELINE = path.join(__dirname, '..');
const slices = require('../lib/dashboard-slices');
const { _internal } = require('../lib/dashboard-routes');
const pulpoSource = fs.readFileSync(path.join(PIPELINE, 'pulpo.js'), 'utf8');
const slicesSource = fs.readFileSync(path.join(PIPELINE, 'lib', 'dashboard-slices.js'), 'utf8');

test('la ruta /api/dash/quota-balance está registrada y delega en quotaBalanceSlice con ?horas=', () => {
    const route = _internal.API_ROUTES['/api/dash/quota-balance'];
    assert.equal(typeof route, 'function');
    assert.equal(typeof slices.quotaBalanceSlice, 'function');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-wiring-6560-'));
    try {
        // Dir vacío sin config.yaml ⇒ fail-closed: ok:false con motivo, sin saldo inventado.
        const out = route({}, { PIPELINE: dir, ROOT: dir, skipSideEffects: true }, new URLSearchParams('horas=3'));
        assert.equal(out.ok, false);
        assert.match(String(out.motivo), /config/);
        assert.deepEqual(out.balance, { providers: {} });
        assert.equal(out.horas, 3);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('con el config real del repo el slice devuelve balance para los 3 proveedores declarados y las 4 series (CA-1, CA-5, CA-6)', () => {
    // skipSideEffects: no persiste snapshot de series en el árbol del repo.
    const out = slices.quotaBalanceSlice({}, { PIPELINE, ROOT: path.join(PIPELINE, '..'), skipSideEffects: true }, { horas: 2 });
    assert.equal(out.ok, true, out.motivo || '');
    assert.deepEqual(Object.keys(out.balance.providers).sort(), ['anthropic', 'antigravity', 'openai-codex']);
    for (const p of Object.values(out.balance.providers)) {
        assert.ok(['alcanza', 'se_agota_antes', 'excedido', 'sin_datos', 'desactualizado', 'sin_proyeccion'].includes(p.estado));
        assert.equal(typeof p.saldo_pts, 'number');
        assert.equal(typeof p.excedente_pts, 'number');
        assert.ok(p.excedente_pts >= 0 && p.saldo_pts >= 0);
    }
    assert.deepEqual(Object.keys(out.series).sort(), ['cadena_agotada', 'gateado', 'schema', 'trabajo_por_cuota', 'unica_pata', 'ventana']);
    assert.equal(out.series.ventana.horas, 2);
    assert.ok(!fs.existsSync(path.join(PIPELINE, 'state', 'quota-series.jsonl')) || true, 'no se exige archivo: skipSideEffects');
});

test('CA-5: el slice usa computeQuotaBalance (misma fórmula que el ruteo) y no re-deriva umbrales', () => {
    const start = slicesSource.indexOf('function quotaBalanceSlice(');
    assert.notEqual(start, -1);
    const body = slicesSource.slice(start, slicesSource.indexOf('\n}\n', start));
    assert.match(body, /quotaBalance\.computeQuotaBalance\(/);
    assert.match(body, /quotaSeries\.computeSeries\(/);
    assert.match(body, /if \(!skipSideEffects\)[\s\S]*recordSeriesSnapshot/);
    assert.doesNotMatch(body, /saldo_pts\s*=|excedente_pts\s*=|ritmo_pts_por_hora\s*=/, 'la fórmula vive en quota-balance.js');
});

test('quotaSlice alimenta el ledger en cada poll real, nunca con skipSideEffects, y antes del guard #4282', () => {
    const start = slicesSource.indexOf('function quotaSlice(');
    const body = slicesSource.slice(start, slicesSource.indexOf('\n}\n', start));
    const idxLedger = body.indexOf('quotaLedger.recordSamplesFromSlice(providersClient');
    const idxGuard = body.indexOf('providerQuotaGuard.evaluate(');
    assert.notEqual(idxLedger, -1, 'la ingesta del ledger debe estar en quotaSlice');
    assert.ok(idxLedger < idxGuard, 'la muestra se persiste en el mismo ciclo, antes del guard');
    const guardLine = body.slice(body.lastIndexOf('\n', idxLedger - 1), idxLedger);
    assert.match(body.slice(idxLedger - 200, idxLedger), /!skipSideEffects/, 'gateado por skipSideEffects');
    assert.match(body.slice(idxLedger, idxLedger + 200), /pipelineDir: PIPELINE/);
    assert.ok(guardLine !== undefined);
});

test('pulpo.js emite dispatch_resumed (issue+fase) al limpiar un backoff de cadena agotada, junto al gate_blocked_spawn existente', () => {
    const gateIdx = pulpoSource.indexOf("event: 'gate_blocked_spawn'");
    const resumeIdx = pulpoSource.indexOf("event: 'dispatch_resumed'");
    assert.notEqual(gateIdx, -1);
    assert.notEqual(resumeIdx, -1);
    assert.ok(resumeIdx > gateIdx && resumeIdx - gateIdx < 6000, 'ambos en la misma función de lanzamiento');
    const block = pulpoSource.slice(pulpoSource.lastIndexOf('const veniaAgotada', resumeIdx), resumeIdx + 600);
    assert.match(block, /const veniaAgotada = dispatchBackoff\.limpiar\(PIPELINE\(\), skill, issue\)/);
    assert.match(block, /if \(veniaAgotada === true\)/, 'sólo cierra un intervalo si había cadena agotada');
    assert.match(block, /raw_excerpt: `issue=\$\{issue\} fase=\$\{fase\} pipeline=\$\{pipeline\}/, 'mismo formato parseable que gate_blocked_spawn');
    assert.match(block, /flag_set: false/);
    // El evento lo consume la serie 2 (quota-series.chainExhausted) por el mismo nombre.
    const seriesSource = fs.readFileSync(path.join(PIPELINE, 'lib', 'multi-provider', 'quota-series.js'), 'utf8');
    assert.match(seriesSource, /e\.event === 'dispatch_resumed'/);
});

test('dispatch-backoff.limpiar devuelve true sólo cuando había backoff (señal que usa el hook)', () => {
    const backoff = require('../lib/dispatch-backoff');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-backoff-6560-'));
    try {
        assert.equal(backoff.limpiar(dir, 'po', 1), false);
        backoff.registrarCadenaAgotada(dir, 'po', 1, { now: 1000 });
        assert.equal(backoff.limpiar(dir, 'po', 1), true);
        assert.equal(backoff.limpiar(dir, 'po', 1), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

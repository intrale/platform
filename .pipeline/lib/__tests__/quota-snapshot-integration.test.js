// =============================================================================
// Tests quota-snapshot-integration.js — #3013 (hija 2 de #3008)
//
// Cubre los CAs verificables del módulo nuevo (no toca tests existentes de
// quota-exhausted.js ni weekly-quota.js — CA-15):
//
//   CA-12 — setFlag con errorType 'snapshot_threshold_90', firma intacta.
//   CA-13 — saveCalibration invocado con dato real, algoritmo EMA intacto.
//   CA-14 — getBannerState con 4 estados (fresh/stale/missing/parser-offline).
//   CA-15 — kill switch (QUOTA_SNAPSHOT_ENABLED=false) → comportamiento
//           idéntico al pre-feature.
//   CA-S1 — defense-in-depth: rejects de pcts fuera de rango, account
//           mismatch, parse_confidence baja, parse_warnings críticos,
//           ts inválido / en futuro / muy viejo.
//   CA-S2 — lectura defensiva del .quota-parser-state.json
//           (ausente, corrupto, valores fuera de allowlist).
//   CA-S3 — sanitizeSnapshotForOutput elimina account_handle (no PII leak).
//   CA-S4 — anti-spam: una sola alerta gate por ventana semanal; mismatch
//           account no spammea.
//   CA-S6 — kill switch granular: GATE_ENABLED=false mantiene calibración.
//   CA-S8 — race en lectura del JSONL durante rotación → fallback silencioso.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function freshModule(tmpDir) {
    process.env.PIPELINE_DIR_OVERRIDE = tmpDir;
    delete require.cache[require.resolve('../quota-snapshot-integration')];
    delete require.cache[require.resolve('../quota-exhausted')];
    delete require.cache[require.resolve('../weekly-quota')];
    return require('../quota-snapshot-integration');
}

function freshExhaustedModule(tmpDir) {
    process.env.PIPELINE_DIR_OVERRIDE = tmpDir;
    delete require.cache[require.resolve('../quota-exhausted')];
    return require('../quota-exhausted');
}

function setupTmp() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsi-test-'));
    fs.mkdirSync(path.join(tmpDir, 'metrics'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'logs'), { recursive: true });
    return tmpDir;
}

function teardownTmp(tmpDir) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    delete process.env.PIPELINE_DIR_OVERRIDE;
    delete process.env.QUOTA_SNAPSHOT_ENABLED;
    delete process.env.QUOTA_SNAPSHOT_GATE_ENABLED;
    delete process.env.QUOTA_SNAPSHOT_GATE_PCT;
    delete process.env.QUOTA_BANNER_TTL_MIN;
    delete process.env.QUOTA_BANNER_STALE_MAX_HOURS;
    delete process.env.QUOTA_PARSER_FAIL_ALERT_THRESHOLD;
    delete process.env.EXPECTED_CLAUDE_ACCOUNT;
    delete process.env.ACTIVITY_LOG_PATH;
}

// Snapshot mínimo válido — los tests parten de este shape y mutan campos.
function validSnapshot(over = {}) {
    return Object.assign({
        ts: new Date(Date.now() - 60 * 1000).toISOString(),  // hace 1 min
        weekly_all_models_pct: 42,
        weekly_sonnet_pct: 30,
        weekly_design_pct: 5,
        session_pct: 25,
        session_minutes_to_reset: 180,
        daily_routines_used: 3,
        daily_routines_max: 15,
        api_overage_used_usd: 0,
        api_overage_cap_usd: 50,
        account_handle: 'leo@intrale.com.ar',
        parse_confidence: 0.95,
        parse_warnings: [],
    }, over);
}

// ---------------------------------------------------------------------------
// CA-S1 — Defense-in-depth en validación del snapshot
// ---------------------------------------------------------------------------

test('CA-S1 · validateSnapshotShape rechaza pcts fuera de rango (NaN/negativo/>100)', () => {
    const tmp = setupTmp();
    try {
        const m = freshModule(tmp);
        for (const bad of [NaN, Infinity, -1, 101, 'abc', null]) {
            const r = m.validateSnapshotShape(validSnapshot({ weekly_all_models_pct: bad }));
            assert.equal(r.ok, false, `pct=${bad} debería fallar`);
            assert.equal(r.reason, 'pct_out_of_range');
        }
    } finally { teardownTmp(tmp); }
});

test('CA-S1 · validateSnapshotShape rechaza session_minutes fuera de (0, 10080]', () => {
    const tmp = setupTmp();
    try {
        const m = freshModule(tmp);
        for (const bad of [0, -1, 10081, NaN, 'abc']) {
            const r = m.validateSnapshotShape(validSnapshot({ session_minutes_to_reset: bad }));
            assert.equal(r.ok, false, `session_min=${bad} debería fallar`);
            assert.equal(r.reason, 'session_minutes_out_of_range');
        }
    } finally { teardownTmp(tmp); }
});

test('CA-S1 · validateSnapshotShape rechaza account_handle vacío', () => {
    const tmp = setupTmp();
    try {
        const m = freshModule(tmp);
        for (const bad of ['', '   ', null, undefined, 42]) {
            const r = m.validateSnapshotShape(validSnapshot({ account_handle: bad }));
            assert.equal(r.ok, false, `account=${bad} debería fallar`);
            assert.equal(r.reason, 'account_handle_empty');
        }
    } finally { teardownTmp(tmp); }
});

test('CA-S1 · validateSnapshotShape rechaza parse_confidence < 0.8', () => {
    const tmp = setupTmp();
    try {
        const m = freshModule(tmp);
        const r = m.validateSnapshotShape(validSnapshot({ parse_confidence: 0.5 }));
        assert.equal(r.ok, false);
        assert.equal(r.reason, 'low_parse_confidence');
    } finally { teardownTmp(tmp); }
});

test('CA-S1 · validateSnapshotShape rechaza parse_warnings críticos', () => {
    const tmp = setupTmp();
    try {
        const m = freshModule(tmp);
        for (const w of ['layout_drift', 'account_unknown', 'shape_invalid']) {
            const r = m.validateSnapshotShape(validSnapshot({ parse_warnings: [w] }));
            assert.equal(r.ok, false, `warning ${w} debería fallar`);
            assert.equal(r.reason, 'critical_parse_warning');
        }
    } finally { teardownTmp(tmp); }
});

test('CA-S1 · validateSnapshotShape rechaza ts en futuro o muy viejo', () => {
    const tmp = setupTmp();
    try {
        const m = freshModule(tmp);
        // ts en futuro
        const future = new Date(Date.now() + 60 * 1000).toISOString();
        const r1 = m.validateSnapshotShape(validSnapshot({ ts: future }));
        assert.equal(r1.ok, false);
        assert.equal(r1.reason, 'ts_in_future');
        // ts no parseable
        const r2 = m.validateSnapshotShape(validSnapshot({ ts: 'not-a-date' }));
        assert.equal(r2.ok, false);
        assert.equal(r2.reason, 'ts_unparseable');
        // ts más viejo que stale_max (default 6h)
        const old = new Date(Date.now() - 7 * 3600 * 1000).toISOString();
        const r3 = m.validateSnapshotShape(validSnapshot({ ts: old }));
        assert.equal(r3.ok, false);
        assert.equal(r3.reason, 'ts_too_old');
    } finally { teardownTmp(tmp); }
});

test('CA-S1 · validateSnapshotShape acepta snapshot válido', () => {
    const tmp = setupTmp();
    try {
        const m = freshModule(tmp);
        const r = m.validateSnapshotShape(validSnapshot());
        assert.equal(r.ok, true);
    } finally { teardownTmp(tmp); }
});

// ---------------------------------------------------------------------------
// CA-S1 bis — verifyAccountMatch (case-insensitive + sin EXPECTED → ok)
// ---------------------------------------------------------------------------

test('CA-S1 · verifyAccountMatch case-insensitive, sin EXPECTED no falla', () => {
    const tmp = setupTmp();
    try {
        const m = freshModule(tmp);
        // Sin EXPECTED definido
        delete process.env.EXPECTED_CLAUDE_ACCOUNT;
        const r1 = m.verifyAccountMatch(validSnapshot({ account_handle: 'foo@bar.com' }));
        assert.equal(r1.matches, true);
        assert.equal(r1.expectedSet, false);
        // Match case-insensitive
        process.env.EXPECTED_CLAUDE_ACCOUNT = 'Leo@Intrale.com.AR';
        const r2 = m.verifyAccountMatch(validSnapshot({ account_handle: 'leo@intrale.com.ar' }));
        assert.equal(r2.matches, true);
        // Mismatch
        const r3 = m.verifyAccountMatch(validSnapshot({ account_handle: 'otro@cuenta.com' }));
        assert.equal(r3.matches, false);
        assert.equal(r3.expectedSet, true);
    } finally { teardownTmp(tmp); }
});

// ---------------------------------------------------------------------------
// CA-S2 — Lectura defensiva del .quota-parser-state.json
// ---------------------------------------------------------------------------

test('CA-S2 · readParserState ausente → available:false', () => {
    const tmp = setupTmp();
    try {
        const m = freshModule(tmp);
        const r = m.readParserState(path.join(tmp, 'no-existe.json'));
        assert.equal(r.available, false);
    } finally { teardownTmp(tmp); }
});

test('CA-S2 · readParserState corrupto → available:false', () => {
    const tmp = setupTmp();
    try {
        const m = freshModule(tmp);
        const file = path.join(tmp, 'corrupto.json');
        fs.writeFileSync(file, 'esto no es JSON');
        const r = m.readParserState(file);
        assert.equal(r.available, false);
    } finally { teardownTmp(tmp); }
});

test('CA-S2 · readParserState ignora last_category fuera de allowlist', () => {
    const tmp = setupTmp();
    try {
        const m = freshModule(tmp);
        const file = path.join(tmp, 'state.json');
        fs.writeFileSync(file, JSON.stringify({
            fail_count_consecutive: 2,
            last_category: '<script>alert(1)</script>',
            last_fail_at: new Date().toISOString(),
        }));
        const r = m.readParserState(file);
        assert.equal(r.available, true);
        assert.equal(r.last_category, null, 'categoría fuera de allowlist debe ser null');
        assert.equal(r.fail_count_consecutive, 2);
    } finally { teardownTmp(tmp); }
});

test('CA-S2 · readParserState capa fail_count en rango [0, 1000)', () => {
    const tmp = setupTmp();
    try {
        const m = freshModule(tmp);
        const file = path.join(tmp, 'state.json');
        fs.writeFileSync(file, JSON.stringify({ fail_count_consecutive: 999999 }));
        const r = m.readParserState(file);
        assert.equal(r.fail_count_consecutive, 0, 'fc fuera de rango → fallback 0');
    } finally { teardownTmp(tmp); }
});

// ---------------------------------------------------------------------------
// CA-S3 — sanitizeSnapshotForOutput elimina account_handle
// ---------------------------------------------------------------------------

test('CA-S3 · sanitizeSnapshotForOutput nunca expone account_handle', () => {
    const tmp = setupTmp();
    try {
        const m = freshModule(tmp);
        const out = m.sanitizeSnapshotForOutput(validSnapshot({
            account_handle: '<script>alert(1)</script>',
        }));
        assert.equal(out.account_handle, undefined);
        // Buckets pct sí se exponen
        assert.equal(out.weekly_all_models_pct, 42);
        assert.equal(out.session_pct, 25);
    } finally { teardownTmp(tmp); }
});

test('CA-S3 · sanitizeSnapshotForOutput limita parse_warnings a strings cortos', () => {
    const tmp = setupTmp();
    try {
        const m = freshModule(tmp);
        const long = 'x'.repeat(200);
        const out = m.sanitizeSnapshotForOutput(validSnapshot({
            parse_warnings: ['ok', long, 42, null, 'short'],
        }));
        // Strings cortos sí, valor largo y no-strings filtrados.
        assert.deepEqual(out.parse_warnings, ['ok', 'short']);
    } finally { teardownTmp(tmp); }
});

// ---------------------------------------------------------------------------
// CA-14 — getBannerState con 4 estados
// ---------------------------------------------------------------------------

function writeJsonl(filepath, snapshots) {
    const lines = snapshots.map(s => JSON.stringify(s)).join('\n') + '\n';
    fs.writeFileSync(filepath, lines);
}

test('CA-14 · getBannerState devuelve missing si no hay JSONL', () => {
    const tmp = setupTmp();
    try {
        const m = freshModule(tmp);
        const r = m.getBannerState();
        assert.equal(r.state, 'missing');
        assert.equal(r.lastSnapshot, null);
    } finally { teardownTmp(tmp); }
});

test('CA-14 · getBannerState fresh si snapshot age < TTL', () => {
    const tmp = setupTmp();
    try {
        const m = freshModule(tmp);
        const snap = validSnapshot();
        writeJsonl(path.join(tmp, '.quota-history.jsonl'), [snap]);
        const r = m.getBannerState();
        assert.equal(r.state, 'fresh');
        assert.notEqual(r.lastSnapshot, null);
        // CA-S3: account_handle no debe estar
        assert.equal(r.lastSnapshot.account_handle, undefined);
    } finally { teardownTmp(tmp); }
});

test('CA-14 · getBannerState stale si TTL <= age < stale_max', () => {
    const tmp = setupTmp();
    try {
        process.env.QUOTA_BANNER_TTL_MIN = '10';
        const m = freshModule(tmp);
        // ts hace 30 min (TTL=10, stale_max=6h por default)
        const snap = validSnapshot({ ts: new Date(Date.now() - 30 * 60 * 1000).toISOString() });
        writeJsonl(path.join(tmp, '.quota-history.jsonl'), [snap]);
        const r = m.getBannerState();
        assert.equal(r.state, 'stale');
    } finally { teardownTmp(tmp); }
});

test('CA-14 · getBannerState parser-offline si fail_count >= threshold', () => {
    const tmp = setupTmp();
    try {
        const m = freshModule(tmp);
        const snap = validSnapshot();
        writeJsonl(path.join(tmp, '.quota-history.jsonl'), [snap]);
        fs.writeFileSync(path.join(tmp, '.quota-parser-state.json'), JSON.stringify({
            fail_count_consecutive: 5,
            last_category: 'layout_drift',
        }));
        const r = m.getBannerState();
        assert.equal(r.state, 'parser-offline', 'parser-offline tiene prioridad');
        assert.notEqual(r.parserState, null);
        assert.equal(r.parserState.fail_count_consecutive, 5);
    } finally { teardownTmp(tmp); }
});

test('CA-14 · getBannerState missing si snapshot > stale_max horas', () => {
    const tmp = setupTmp();
    try {
        const m = freshModule(tmp);
        // Snapshot hace 7h (stale_max default 6h) → cae a missing.
        // Lo escribimos directamente al JSONL (la validación de stale_max
        // sólo aplica a evaluateSnapshotAndGate, no a getBannerState — pero
        // getBannerState lo categoriza como missing por edad).
        const snap = validSnapshot({ ts: new Date(Date.now() - 7 * 3600 * 1000).toISOString() });
        writeJsonl(path.join(tmp, '.quota-history.jsonl'), [snap]);
        const r = m.getBannerState();
        assert.equal(r.state, 'missing');
        assert.equal(r.reason, 'snapshot_too_old');
    } finally { teardownTmp(tmp); }
});

// ---------------------------------------------------------------------------
// CA-15 / CA-S6 — Kill switch
// ---------------------------------------------------------------------------

test('CA-15 / CA-S6 · QUOTA_SNAPSHOT_ENABLED=false → getBannerState missing', () => {
    const tmp = setupTmp();
    try {
        process.env.QUOTA_SNAPSHOT_ENABLED = 'false';
        const m = freshModule(tmp);
        const snap = validSnapshot();
        writeJsonl(path.join(tmp, '.quota-history.jsonl'), [snap]);
        const r = m.getBannerState();
        assert.equal(r.state, 'missing');
        assert.equal(r.reason, 'kill_switch');
    } finally { teardownTmp(tmp); }
});

test('CA-15 / CA-S6 · QUOTA_SNAPSHOT_ENABLED=false → evaluateSnapshotAndGate no-op', () => {
    const tmp = setupTmp();
    try {
        process.env.QUOTA_SNAPSHOT_ENABLED = 'false';
        const m = freshModule(tmp);
        const r = m.evaluateSnapshotAndGate(validSnapshot({ weekly_all_models_pct: 95 }));
        assert.equal(r.ok, false);
        assert.equal(r.reason, 'kill_switch');
        assert.equal(r.action, 'none');
    } finally { teardownTmp(tmp); }
});

test('CA-S6 · QUOTA_SNAPSHOT_GATE_ENABLED=false → no setFlag, sí calibración', () => {
    const tmp = setupTmp();
    try {
        process.env.QUOTA_SNAPSHOT_GATE_ENABLED = 'false';
        process.env.ACTIVITY_LOG_PATH = path.join(tmp, 'activity-empty.jsonl');
        fs.writeFileSync(process.env.ACTIVITY_LOG_PATH, '');
        const m = freshModule(tmp);
        const exhausted = freshExhaustedModule(tmp);
        const before = exhausted.isQuotaExhausted();
        assert.equal(before, false);

        const r = m.evaluateSnapshotAndGate(validSnapshot({ weekly_all_models_pct: 95 }));
        assert.equal(r.ok, true);
        // Calibración sí ocurrió, gate no.
        assert.equal(r.action, 'calibrated');

        const after = exhausted.isQuotaExhausted();
        assert.equal(after, false, 'gate deshabilitado → flag no se setea');
    } finally { teardownTmp(tmp); }
});

// ---------------------------------------------------------------------------
// CA-12 / CA-13 — Wire al setFlag y saveCalibration
// ---------------------------------------------------------------------------

test('CA-12 · evaluateSnapshotAndGate dispara setFlag con errorType correcto al cruzar umbral', () => {
    const tmp = setupTmp();
    try {
        process.env.ACTIVITY_LOG_PATH = path.join(tmp, 'activity-empty.jsonl');
        fs.writeFileSync(process.env.ACTIVITY_LOG_PATH, '');
        const m = freshModule(tmp);
        const exhausted = freshExhaustedModule(tmp);
        assert.equal(exhausted.isQuotaExhausted(), false);

        const r = m.evaluateSnapshotAndGate(validSnapshot({ weekly_all_models_pct: 95 }));
        assert.equal(r.ok, true);
        assert.match(r.action, /gated/);

        // Verificar que el flag se seteó con el errorType correcto.
        const flag = exhausted.readDefensive();
        assert.equal(flag.exhausted, true);
        assert.equal(flag.pattern_matched, 'snapshot_threshold_90');
    } finally { teardownTmp(tmp); }
});

test('CA-12 · evaluateSnapshotAndGate NO dispara setFlag debajo del umbral', () => {
    const tmp = setupTmp();
    try {
        process.env.ACTIVITY_LOG_PATH = path.join(tmp, 'activity-empty.jsonl');
        fs.writeFileSync(process.env.ACTIVITY_LOG_PATH, '');
        const m = freshModule(tmp);
        const exhausted = freshExhaustedModule(tmp);

        const r = m.evaluateSnapshotAndGate(validSnapshot({ weekly_all_models_pct: 80 }));
        assert.equal(r.ok, true);
        assert.equal(r.action, 'calibrated');
        assert.equal(exhausted.isQuotaExhausted(), false);
    } finally { teardownTmp(tmp); }
});

test('CA-12 · setFlag firma intacta — admite agent + errorType nuevo sin breaking', () => {
    const tmp = setupTmp();
    try {
        const exhausted = freshExhaustedModule(tmp);
        // Llamada directa con la firma documentada — debería funcionar igual.
        const result = exhausted.setFlag({
            errorType: 'snapshot_threshold_90',
            agent: 'quota-snapshot-integration',
            resetsAt: Date.now() + 24 * 3600 * 1000,
        });
        assert.ok(result.flagPath);
        assert.equal(result.payload.pattern_matched, 'snapshot_threshold_90');
        assert.ok(exhausted.DEFAULT_ERROR_TYPES.includes('snapshot_threshold_90'),
                  'allowlist debe incluir snapshot_threshold_90');
    } finally { teardownTmp(tmp); }
});

// ---------------------------------------------------------------------------
// CA-S4 — Anti-spam por ventana semanal
// ---------------------------------------------------------------------------

test('CA-S4 · gate alert se emite una sola vez por ventana semanal', () => {
    const tmp = setupTmp();
    try {
        process.env.ACTIVITY_LOG_PATH = path.join(tmp, 'activity-empty.jsonl');
        fs.writeFileSync(process.env.ACTIVITY_LOG_PATH, '');
        const m = freshModule(tmp);
        // freshExhaustedModule(tmp); // quota-exhausted ya cargado por freshModule

        const sentMessages = [];
        const sendTelegram = (text) => sentMessages.push(text);

        const snap = validSnapshot({ weekly_all_models_pct: 95 });
        const r1 = m.evaluateSnapshotAndGate(snap, { sendTelegram });
        const r2 = m.evaluateSnapshotAndGate(snap, { sendTelegram });

        assert.equal(r1.ok, true);
        assert.equal(r2.ok, true);
        // Una sola alerta de gate por la ventana semanal.
        const gateAlerts = sentMessages.filter(t => t.includes('Cuota semanal al 90%'));
        assert.equal(gateAlerts.length, 1, 'gate alert debe emitirse una sola vez por ventana');
    } finally { teardownTmp(tmp); }
});

test('CA-S4 · account mismatch alert no spammea (anti-spam por hora)', () => {
    const tmp = setupTmp();
    try {
        process.env.EXPECTED_CLAUDE_ACCOUNT = 'leo@intrale.com.ar';
        process.env.ACTIVITY_LOG_PATH = path.join(tmp, 'activity-empty.jsonl');
        fs.writeFileSync(process.env.ACTIVITY_LOG_PATH, '');
        const m = freshModule(tmp);

        const sentMessages = [];
        const sendTelegram = (text) => sentMessages.push(text);

        const bad = validSnapshot({ account_handle: 'otra@cuenta.com' });
        m.evaluateSnapshotAndGate(bad, { sendTelegram });
        m.evaluateSnapshotAndGate(bad, { sendTelegram });

        const mismatchAlerts = sentMessages.filter(t => t.includes('cuenta distinta'));
        assert.equal(mismatchAlerts.length, 1, 'mismatch debe alertar una sola vez por hora');
        // Verificar que NO se interpola email
        assert.equal(mismatchAlerts[0].includes('otra@cuenta.com'), false);
        assert.equal(mismatchAlerts[0].includes('leo@intrale.com.ar'), false);
    } finally { teardownTmp(tmp); }
});

// ---------------------------------------------------------------------------
// CA-S8 — Race en lectura del JSONL durante rotación
// ---------------------------------------------------------------------------

test('CA-S8 · readLastSnapshotLine ausente devuelve {ok:false, reason:absent}', () => {
    const tmp = setupTmp();
    try {
        const m = freshModule(tmp);
        const r = m.readLastSnapshotLine(path.join(tmp, 'no-existe.jsonl'));
        assert.equal(r.ok, false);
        assert.equal(r.reason, 'absent');
    } finally { teardownTmp(tmp); }
});

test('CA-S8 · readLastSnapshotLine ignora líneas corruptas y devuelve la última válida', () => {
    const tmp = setupTmp();
    try {
        const m = freshModule(tmp);
        const file = path.join(tmp, 'history.jsonl');
        const valid1 = JSON.stringify(validSnapshot({ session_pct: 10 }));
        const valid2 = JSON.stringify(validSnapshot({ session_pct: 20 }));
        const corrupt = '{esto-no-es-json';
        fs.writeFileSync(file, valid1 + '\n' + valid2 + '\n' + corrupt + '\n');
        const r = m.readLastSnapshotLine(file);
        assert.equal(r.ok, true);
        assert.equal(r.snapshot.session_pct, 20, 'última línea válida es valid2');
    } finally { teardownTmp(tmp); }
});

test('CA-S8 · readLastSnapshotLine archivo vacío devuelve reason:empty', () => {
    const tmp = setupTmp();
    try {
        const m = freshModule(tmp);
        const file = path.join(tmp, 'empty.jsonl');
        fs.writeFileSync(file, '');
        const r = m.readLastSnapshotLine(file);
        assert.equal(r.ok, false);
        assert.equal(r.reason, 'empty');
    } finally { teardownTmp(tmp); }
});

// ---------------------------------------------------------------------------
// CA-15 — Coexistencia verificable: pre-feature behavior con JSONL ausente
// ---------------------------------------------------------------------------

test('CA-15 · sin JSONL ni parser-state, getBannerState es totalmente silencioso', () => {
    const tmp = setupTmp();
    try {
        const m = freshModule(tmp);
        const r = m.getBannerState();
        assert.equal(r.state, 'missing');
        assert.equal(r.lastSnapshot, null);
        assert.equal(r.parserState, null);
        // No se rompe aunque no exista el archivo.
    } finally { teardownTmp(tmp); }
});

// ---------------------------------------------------------------------------
// CA-UX-8 — buildStatusSnapshotBlock formato fijo
// ---------------------------------------------------------------------------

test('CA-UX-8 · buildStatusSnapshotBlock devuelve null si no hay snapshot fresco', () => {
    const tmp = setupTmp();
    try {
        const m = freshModule(tmp);
        const r = m.buildStatusSnapshotBlock();
        assert.equal(r, null);
    } finally { teardownTmp(tmp); }
});

test('CA-UX-8 · buildStatusSnapshotBlock formato fijo cuando hay snapshot fresco', () => {
    const tmp = setupTmp();
    try {
        const m = freshModule(tmp);
        const snap = validSnapshot({
            session_pct: 42,
            weekly_all_models_pct: 67,
            weekly_sonnet_pct: 52,
            weekly_design_pct: 12,
            session_minutes_to_reset: 180,
            daily_routines_used: 3,
            api_overage_used_usd: 0,
            api_overage_cap_usd: 50,
        });
        writeJsonl(path.join(tmp, '.quota-history.jsonl'), [snap]);
        const r = m.buildStatusSnapshotBlock();
        assert.ok(r);
        assert.match(r, /Cuota Anthropic — dato real/);
        assert.match(r, /- Sesion: 42% \(reset en 3 h\)/);
        assert.match(r, /- Semanal: 67% todos \/ 52% Sonnet \/ 12% Design/);
        assert.match(r, /- Rutinas: 3 \/ 15 hoy/);
        assert.match(r, /- Overage: \$0 \/ \$50/);
    } finally { teardownTmp(tmp); }
});

// ---------------------------------------------------------------------------
// CA-S7 — Logs sin PII (sólo categorías, no valores)
// ---------------------------------------------------------------------------

test('CA-S7 · log de rechazo solo pasa categoría, no valor', () => {
    const tmp = setupTmp();
    try {
        const m = freshModule(tmp);
        const captured = [];
        const log = (level, msg) => captured.push({ level, msg });
        // Snapshot con weekly_all_models_pct fuera de rango
        const r = m.evaluateSnapshotAndGate(validSnapshot({ weekly_all_models_pct: 999 }), { log });
        assert.equal(r.ok, false);
        // El log NO debe contener el valor 999, solo la categoría.
        const allMsg = captured.map(c => c.msg).join(' ');
        assert.equal(allMsg.includes('999'), false);
        assert.equal(allMsg.includes('pct_out_of_range'), true);
    } finally { teardownTmp(tmp); }
});

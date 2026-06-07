// =============================================================================
// wizard-descanso.test.js — Tests del flow `descanso` (#3739) y de su vista SSR.
//
// Cubre los criterios CA-PO-1..CA-PO-7 y los tests obligatorios del architect
// (T-1..T-10), adaptados a la API REAL de wizard-session (#3724):
// `registerFlow(name, {maxStep, validateStep, executeStep})`.
//
//   - Nivel unitario: se ejercita `createFlow().{validateStep,executeStep}`
//     directamente (rápido, determinístico, sin HTTP).
//   - Nivel integración: se monta el flow real sobre `wizard-session.route()`
//     con headers CSRF válidos para probar el wiring end-to-end (403, happy
//     path de 3 pasos, persistencia + audit).
//
// El cap 24h server-side y los helpers `nextWindowTransition` /
// `totalContinuousMinutesPerDay` tienen su suite focalizada en
// `rest-mode-window-cap.test.js`.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const flowMod = require('../wizard-descanso-flow');
const view = require('../../views/dashboard/wizard-descanso');
const auditLog = require('../audit-log');
const ws = require('../wizard-session');
const { fakeHttpReq, fakeHttpRes } = require('./_test-helpers');

// Lunes 2026-06-01 10:00 UTC (dentro de una ventana 09:00-13:00).
const MON_1000_UTC = Date.parse('2026-06-01T10:00:00Z');

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'wz-descanso-'));
}

function makeFlow({ dir, nowMs = MON_1000_UTC, config } = {}) {
    return flowMod.createFlow({
        pipelineDir: dir || tmpDir(),
        now: () => nowMs,
        loadConfig: () => config || {
            cost_anomaly_alert: {
                max_snooze_hours: 24,
                consecutive_baseline_checks_to_clear: 2,
                channels: { telegram: true, dashboard_banner: true },
            },
        },
    });
}

const VALID_WINDOW = {
    active: true,
    timezone: 'UTC',
    schedule: {
        monday: [{ start: '09:00', end: '13:00' }],
        tuesday: [{ start: '09:00', end: '13:00' }],
        wednesday: [], thursday: [], friday: [], saturday: [], sunday: [],
    },
};

// ---------------------------------------------------------------------------
// validateStep
// ---------------------------------------------------------------------------

test('T-3a · step anomalías solo acepta {acknowledged:true} (read-only, R-1)', () => {
    const flow = makeFlow();
    assert.equal(flow.validateStep(flow.STEPS.ANOMALIAS, { acknowledged: true }), true);
    assert.equal(flow.validateStep(flow.STEPS.ANOMALIAS, { ratio_threshold: 999 }), false);
    assert.equal(flow.validateStep(flow.STEPS.ANOMALIAS, { acknowledged: true, extra: 1 }), false);
    assert.equal(flow.validateStep(flow.STEPS.ANOMALIAS, {}), false);
});

test('T-confirm-validate · confirm rechaza motivo demasiado largo o de tipo inválido', () => {
    const flow = makeFlow();
    assert.equal(flow.validateStep(flow.STEPS.CONFIRM, null), true);
    assert.equal(flow.validateStep(flow.STEPS.CONFIRM, { motivo: 'ok' }), true);
    assert.equal(flow.validateStep(flow.STEPS.CONFIRM, { motivo: 'x'.repeat(281) }), false);
    assert.equal(flow.validateStep(flow.STEPS.CONFIRM, { motivo: 123 }), false);
    assert.equal(flow.validateStep(flow.STEPS.CONFIRM, { actor: 'y'.repeat(81) }), false);
});

// ---------------------------------------------------------------------------
// executeStep — ventana (step 0)
// ---------------------------------------------------------------------------

test('T-1 · ventana rechaza schedule que excede el cap CA-D2 y NO persiste', async () => {
    const dir = tmpDir();
    const flow = makeFlow({ dir });
    const session = {};
    const res = await flow.executeStep(session, flow.STEPS.VENTANA, {
        active: true,
        schedule: { monday: [{ start: '00:00', end: '23:59' }, { start: '01:00', end: '22:00' }] },
    });
    assert.equal(res.ok, false);
    assert.ok(res.errors.some(e => /CA-D2/.test(e)));
    assert.equal(fs.existsSync(path.join(dir, 'rest-mode.json')), false);
});

test('T-2 · ventana válida avanza y acumula draft SIN persistir (atomicidad)', async () => {
    const dir = tmpDir();
    const flow = makeFlow({ dir });
    const session = {};
    const res = await flow.executeStep(session, flow.STEPS.VENTANA, VALID_WINDOW);
    assert.equal(res.ok, true);
    assert.ok(session.draft && session.draft.window);
    assert.equal(fs.existsSync(path.join(dir, 'rest-mode.json')), false, 'no debe persistir hasta el confirm');
});

// ---------------------------------------------------------------------------
// executeStep — anomalías (step 1)
// ---------------------------------------------------------------------------

test('T-3b · anomalías devuelve los thresholds vigentes de config.yaml', async () => {
    const flow = makeFlow();
    const session = {};
    const res = await flow.executeStep(session, flow.STEPS.ANOMALIAS, { acknowledged: true });
    assert.equal(res.ok, true);
    assert.equal(res.read_only, true);
    assert.equal(res.thresholds.max_snooze_hours, 24);
    assert.equal(res.thresholds.consecutive_baseline_checks_to_clear, 2);
    assert.equal(res.thresholds.channels.telegram, true);
});

// ---------------------------------------------------------------------------
// executeStep — confirm (step 2)
// ---------------------------------------------------------------------------

test('T-5 · confirm calcula preview (describeRestModeNow + nextWindowTransition)', async () => {
    const dir = tmpDir();
    const flow = makeFlow({ dir, nowMs: MON_1000_UTC });
    const session = {};
    await flow.executeStep(session, flow.STEPS.VENTANA, VALID_WINDOW);
    await flow.executeStep(session, flow.STEPS.ANOMALIAS, { acknowledged: true });
    const res = await flow.executeStep(session, flow.STEPS.CONFIRM, {});
    assert.equal(res.ok, true);
    assert.equal(res.done, true);
    assert.equal(res.next_period.start, '09:00');
    assert.equal(res.transition.kind, 'exit');
    assert.equal(res.transition.minutesFromNow, 180);
    // Persistió la ventana.
    assert.equal(fs.existsSync(path.join(dir, 'rest-mode.json')), true);
});

test('T-4 · confirm escribe una sola entry config_descanso sin NDJSON injection', async () => {
    const dir = tmpDir();
    const flow = makeFlow({ dir });
    const session = {};
    await flow.executeStep(session, flow.STEPS.VENTANA, VALID_WINDOW);
    await flow.executeStep(session, flow.STEPS.ANOMALIAS, { acknowledged: true });
    const res = await flow.executeStep(session, flow.STEPS.CONFIRM, { motivo: 'linea1\nMALICIOUS_LINE' });
    assert.equal(res.ok, true);

    const auditFile = path.join(dir, 'audit', 'config-descanso-audit.jsonl');
    const raw = fs.readFileSync(auditFile, 'utf8');
    const physicalLines = raw.split('\n').filter(Boolean);
    assert.equal(physicalLines.length, 1, 'el motivo con \\n no debe partir la entry en dos líneas');

    const entries = auditLog.readAll(auditFile);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].action, 'config_descanso');
    assert.equal(entries[0].motivo, 'linea1\nMALICIOUS_LINE');
    // La cadena de hash queda íntegra.
    assert.equal(auditLog.verifyChain(auditFile).ok, true);
});

test('confirm sin ventana previa en la sesión devuelve error (reiniciar wizard)', async () => {
    const flow = makeFlow();
    const res = await flow.executeStep({}, flow.STEPS.CONFIRM, {});
    assert.equal(res.ok, false);
    assert.ok(res.errors.some(e => /reiniciar wizard/.test(e)));
});

// ---------------------------------------------------------------------------
// Vista SSR
// ---------------------------------------------------------------------------

test('T-6 · renderConfirmPreview escapa XSS en el motivo del operador', () => {
    const html = view.renderConfirmPreview({
        motivo: '<img src=x onerror=alert(1)>',
        transition: { kind: 'exit', when: 'today', atHHMM: '13:00', minutesFromNow: 180 },
    });
    assert.ok(html.includes('&lt;img'), 'el motivo debe quedar escapado');
    assert.ok(!html.includes('<img'), 'nunca debe emitir el tag crudo');
});

test('renderWizardDescanso emite el meta csrf escapado y los 3 pasos', () => {
    const html = view.renderWizardDescanso({ csrfToken: 'tok"123' });
    assert.ok(html.includes('<meta name="csrf-token"'));
    assert.ok(html.includes('tok&quot;123'), 'el token debe ir escapado en el atributo');
    assert.ok(html.includes('Paso 1'));
    assert.ok(html.includes('Paso 2'));
    assert.ok(html.includes('Paso 3'));
});

// ---------------------------------------------------------------------------
// Integración sobre wizard-session.route()
// ---------------------------------------------------------------------------

function validSecurityHeaders(extra = {}) {
    const { raw } = ws._csrf.newCsrfCookie();
    const token = ws._csrf.deriveCsrfToken(raw);
    return {
        cookie: `wizard_csrf=${raw}`,
        'x-csrf-token': token,
        'sec-fetch-site': 'same-origin',
        origin: 'http://127.0.0.1:3200',
        'content-type': 'application/json',
        ...extra,
    };
}

async function call({ headers = {}, body = '' } = {}) {
    const req = fakeHttpReq({ url: '/dashboard/wizard/descanso/step', method: 'POST', headers, body });
    const res = fakeHttpRes();
    const handled = ws.route(req, res);
    if (!handled) return { handled: false, res };
    req._emitBody();
    await res.done;
    let json = null;
    try { json = JSON.parse(res._body); } catch { /* sin json */ }
    return { handled: true, res, json };
}

function registerDescanso(dir) {
    ws._resetForTests();
    ws._setAuditDirForTests(fs.mkdtempSync(path.join(os.tmpdir(), 'wz-audit-')));
    ws.registerFlow('descanso', flowMod.createFlow({
        pipelineDir: dir,
        now: () => MON_1000_UTC,
        loadConfig: () => ({ cost_anomaly_alert: { max_snooze_hours: 24, consecutive_baseline_checks_to_clear: 2, channels: {} } }),
    }));
}

test('T-8 · POST sin CSRF al step API → 403 (defensa heredada de wizard-base)', async () => {
    registerDescanso(tmpDir());
    const headers = validSecurityHeaders();
    delete headers['x-csrf-token'];
    const { res } = await call({ headers, body: JSON.stringify({ step: 0, params: VALID_WINDOW }) });
    assert.equal(res._status, 403);
});

test('integración · happy path de los 3 pasos persiste y audita', async () => {
    const dir = tmpDir();
    registerDescanso(dir);

    // Step 0 — ventana (crea sesión).
    const s0 = await call({ headers: validSecurityHeaders(), body: JSON.stringify({ step: 0, params: VALID_WINDOW }) });
    assert.equal(s0.res._status, 200);
    const sid = s0.json.wizard_session_id;
    assert.ok(sid);
    assert.equal(s0.json.result.ok, true);

    // Step 1 — anomalías.
    const s1 = await call({ headers: validSecurityHeaders(), body: JSON.stringify({ step: 1, wizard_session_id: sid, params: { acknowledged: true } }) });
    assert.equal(s1.res._status, 200);
    assert.equal(s1.json.result.thresholds.max_snooze_hours, 24);

    // Step 2 — confirm.
    const s2 = await call({ headers: validSecurityHeaders(), body: JSON.stringify({ step: 2, wizard_session_id: sid, params: { motivo: 'ventana de oficina' } }) });
    assert.equal(s2.res._status, 200);
    assert.equal(s2.json.result.done, true);
    assert.equal(s2.json.result.transition.kind, 'exit');

    assert.equal(fs.existsSync(path.join(dir, 'rest-mode.json')), true);
    assert.equal(fs.existsSync(path.join(dir, 'audit', 'config-descanso-audit.jsonl')), true);
});

test('T-3c · integración: editar thresholds en step anomalías → 409 (read-only)', async () => {
    const dir = tmpDir();
    registerDescanso(dir);
    const s0 = await call({ headers: validSecurityHeaders(), body: JSON.stringify({ step: 0, params: VALID_WINDOW }) });
    const sid = s0.json.wizard_session_id;
    const s1 = await call({ headers: validSecurityHeaders(), body: JSON.stringify({ step: 1, wizard_session_id: sid, params: { ratio_threshold: 999 } }) });
    assert.equal(s1.res._status, 409, 'editar un threshold debe ser rechazado por el gate read-only');
});

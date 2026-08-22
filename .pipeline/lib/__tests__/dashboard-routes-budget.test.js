// =============================================================================
// dashboard-routes-budget.test.js — #3962 EP8-H9 CA-4.
//
// Endpoint mutante del presupuesto mensual (POST /dashboard/costos/budget).
// Verifica el cinturón de gates replicado LITERALMENTE de handleAlertMutation:
//   - método incorrecto → 405
//   - no-loopback       → 403 (REQ-SEC-1/7, independiente del bind)
//   - cross-site        → 403 (anti-CSRF, REQ-SEC-1)
//   - Content-Type no JSON → 415
//   - body sobre el cap → 413 (REQ-SEC-8)
//   - valores inválidos (NaN/Infinity/negativo/1e3/"100") → 400 sin reflejar input
//   - valor válido → 200 + persiste atómico + actor fijo server-side (REQ-SEC-3)
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-routes-budget-'));
// Aislar REPO_ROOT al tmp (traceability lo resuelve por CLAUDE_PROJECT_DIR /
// PIPELINE_REPO_ROOT) para NO escribir sobre el budget-config real del repo.
process.env.CLAUDE_PROJECT_DIR = TMP_DIR;
process.env.PIPELINE_REPO_ROOT = TMP_DIR;
fs.mkdirSync(path.join(TMP_DIR, '.pipeline', 'metrics'), { recursive: true });

try { delete require.cache[require.resolve('../traceability')]; } catch {}
delete require.cache[require.resolve('../../metrics/budget-config')];
delete require.cache[require.resolve('../dashboard-routes')];

const routes = require('../dashboard-routes');
const budgetConfig = require('../../metrics/budget-config');
const handleBudgetMutation = routes._internal.handleBudgetMutation;
const ALERT_BODY_MAX_BYTES = routes._internal.ALERT_BODY_MAX_BYTES;
const BUDGET_FILE = path.join(TMP_DIR, '.pipeline', 'metrics', 'budget-config.json');

function resetFs() {
    try { fs.unlinkSync(BUDGET_FILE); } catch {}
    try { fs.unlinkSync(BUDGET_FILE + '.tmp'); } catch {}
}

function makeReq({ method = 'POST', url = '/dashboard/costos/budget', remoteAddress = '127.0.0.1', headers = {} } = {}) {
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.headers = Object.assign({ 'content-type': 'application/json' }, headers);
    req.socket = { remoteAddress };
    req.destroyed = false;
    req.destroy = () => { req.destroyed = true; };
    return req;
}

function makeRes() {
    let resolve;
    const done = new Promise((r) => { resolve = r; });
    const res = {
        statusCode: null, headers: null, body: '',
        writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
        end(chunk) { if (chunk) this.body += chunk; resolve(); },
        done,
    };
    return res;
}

async function invoke(reqOpts, body) {
    resetFs();
    const req = makeReq(reqOpts);
    const res = makeRes();
    const handled = handleBudgetMutation(req, res);
    if (body !== undefined) {
        process.nextTick(() => {
            req.emit('data', Buffer.from(body));
            req.emit('end');
        });
    }
    await res.done;
    return { handled, res, req };
}

test('ruta ajena no se maneja (devuelve false)', () => {
    const req = makeReq({ url: '/api/dash/header' });
    const res = makeRes();
    assert.equal(handleBudgetMutation(req, res), false);
});

test('método incorrecto → 405', async () => {
    const { handled, res } = await invoke({ method: 'GET' });
    assert.equal(handled, true);
    assert.equal(res.statusCode, 405);
});

test('no-loopback → 403 (REQ-SEC-1/7)', async () => {
    const { res } = await invoke({ remoteAddress: '10.0.0.5' });
    assert.equal(res.statusCode, 403);
});

test('cross-site (Sec-Fetch-Site) → 403 (anti-CSRF)', async () => {
    const { res } = await invoke({ headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(res.statusCode, 403);
});

test('Content-Type no JSON → 415', async () => {
    const { res } = await invoke({ headers: { 'content-type': 'text/plain' } });
    assert.equal(res.statusCode, 415);
});

test('body sobre el cap → 413 (REQ-SEC-8) + corta conexión', async () => {
    const big = 'x'.repeat(ALERT_BODY_MAX_BYTES + 10);
    const { res, req } = await invoke({}, JSON.stringify({ monthlyUsd: 100, pad: big }));
    assert.equal(res.statusCode, 413);
    assert.equal(req.destroyed, true);
});

// Valores inválidos → 400 sin reflejar el input.
for (const bad of [
    { name: 'string "100"', payload: { monthlyUsd: '100' } },
    { name: 'negativo', payload: { monthlyUsd: -5 } },
    { name: 'cero', payload: { monthlyUsd: 0 } },
    { name: 'NaN', payload: { monthlyUsd: 'abc' } },
    { name: 'notación científica 1e3 (string)', payload: { monthlyUsd: '1e3' } },
    { name: 'por encima de la cota', payload: { monthlyUsd: routes._internal.BUDGET_MAX + 1 } },
    { name: 'ausente', payload: {} },
]) {
    test(`valor inválido (${bad.name}) → 400 sin reflejar input`, async () => {
        const { res } = await invoke({}, JSON.stringify(bad.payload));
        assert.equal(res.statusCode, 400);
        // No refleja el valor crudo enviado.
        const sent = String(bad.payload.monthlyUsd);
        if (sent && sent !== 'undefined') {
            assert.ok(!res.body.includes(sent), `la respuesta no debe reflejar "${sent}"`);
        }
    });
}

test('Infinity (vía JSON) → 400', async () => {
    // JSON no soporta Infinity literal → llega como null → bad_request.
    const { res } = await invoke({}, '{"monthlyUsd": 1e999}');
    assert.equal(res.statusCode, 400);
});

test('JSON inválido → 400', async () => {
    const { res } = await invoke({}, '{not-json');
    assert.equal(res.statusCode, 400);
});

test('valor válido → 200 + persiste atómico + actor server-side fijo (REQ-SEC-3)', async () => {
    const { res } = await invoke({}, JSON.stringify({ monthlyUsd: 250, actor: 'attacker' }));
    assert.equal(res.statusCode, 200);
    assert.ok(fs.existsSync(BUDGET_FILE), 'el archivo de presupuesto se escribió');
    const saved = JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8'));
    assert.equal(saved.monthly_usd, 250);
    assert.equal(saved.actor, 'operador-local', 'el actor del body se ignora (REQ-SEC-3)');
    // readBudget lo lee de vuelta.
    const read = budgetConfig.readBudget({ path: BUDGET_FILE });
    assert.equal(read.monthly_usd, 250);
});

test('respuestas mutantes llevan no-store + nosniff', async () => {
    const { res } = await invoke({}, JSON.stringify({ monthlyUsd: 100 }));
    assert.match(res.headers['Cache-Control'], /no-store/);
    assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
});

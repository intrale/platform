// Tests estructurales del endpoint POST/GET /api/rest-mode.
//
// El endpoint vive en `.pipeline/dashboard.js` (líneas ~8943–9026). Estos
// tests verifican estructuralmente que:
//   1. El bloque `isLoopback` (PO-SEC-7 / CA-Endpoint-Loopback) NO fue modificado.
//   2. El endpoint usa `restModeWindow.setWindow` (no inventa su propio gating).
//   3. El cap de 16KB sobre el body sigue presente.
//   4. El GET expone el slice enriquecido (`describeRestModeNow`).
//
// No bootea el dashboard real (heavy infra). Los tests funcionales se cubren
// con `rest-mode-window.{test,integration.test}.js` que ejercitan setWindow
// directamente — el endpoint sólo es una capa fina alrededor del módulo.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DASHBOARD_PATH = path.resolve(__dirname, '..', '..', 'dashboard.js');

let dashboardSrc = '';
function getSrc() {
    if (!dashboardSrc) {
        dashboardSrc = fs.readFileSync(DASHBOARD_PATH, 'utf8');
    }
    return dashboardSrc;
}

// =========================================================================
// CA-Endpoint-Loopback / PO-SEC-7
// =========================================================================

test('CA-Endpoint-Loopback: el bloque isLoopback del POST está intacto', () => {
    const src = getSrc();
    // Verificamos las 4 condiciones del check de loopback
    assert.ok(src.includes("remote === '127.0.0.1'"),
        'check de IPv4 127.0.0.1 ausente');
    assert.ok(src.includes("remote === '::1'"),
        'check de IPv6 ::1 ausente');
    assert.ok(src.includes("remote === '::ffff:127.0.0.1'"),
        'check de IPv4-mapped ::ffff:127.0.0.1 ausente');
    assert.ok(src.includes("remote.startsWith('127.')"),
        'check de 127.0.0.0/8 ausente');
    // Verificamos el 403 response
    assert.ok(src.includes('loopback-only endpoint, got remote='),
        'mensaje 403 loopback-only ausente');
});

test('CA-Endpoint-Loopback: el check isLoopback precede al body parse en el bloque POST rest-mode', () => {
    const src = getSrc();
    // Aislar el bloque POST /api/rest-mode (puede haber otros isLoopback/req.on('data') en dashboard.js)
    const startMark = "req.url === '/api/rest-mode' && req.method === 'POST'";
    const startIdx = src.indexOf(startMark);
    assert.ok(startIdx > 0, 'no se encontró el bloque POST /api/rest-mode');
    // El bloque termina con el siguiente `if (req.url === '/api/...` o final del archivo
    const endIdx = src.indexOf("req.url === '/api/cost-anomaly", startIdx);
    const block = src.slice(startIdx, endIdx > 0 ? endIdx : startIdx + 4000);

    const idxLoopback = block.indexOf('if (!isLoopback)');
    const idxData = block.indexOf("req.on('data'");
    assert.ok(idxLoopback > 0, 'no se encontró if (!isLoopback) dentro del bloque POST rest-mode');
    assert.ok(idxData > 0, 'no se encontró req.on(\'data\' dentro del bloque POST rest-mode');
    assert.ok(idxLoopback < idxData,
        'el check isLoopback debe estar ANTES del body parse para rechazar sin parsear');
});

// =========================================================================
// CA-8.6: el endpoint usa setWindow del módulo (no reimplementa validación)
// =========================================================================

test('CA-8.6: el POST delega a restModeWindow.setWindow', () => {
    const src = getSrc();
    assert.ok(src.includes('restModeWindow.setWindow(payload,'),
        'el endpoint debe usar setWindow(payload, opts)');
    assert.ok(src.includes("actor: 'api'"),
        'el actor debe ser \'api\' para que el audit lo marque correctamente');
});

test('CA-8.6: warnings del setWindow se loguean (PO-SEC-5)', () => {
    const src = getSrc();
    assert.ok(src.includes('result.warnings'),
        'el endpoint debe consumir result.warnings de setWindow');
    assert.ok(/rest-mode warning/.test(src),
        'debe loguear las warnings (PO-SEC-5 sobre payload mixto)');
});

// =========================================================================
// Cap de 16KB sobre el body
// =========================================================================

test('cap 16KB sobre el body sigue presente', () => {
    const src = getSrc();
    assert.ok(/body\.length\s*>\s*16\s*\*\s*1024/.test(src),
        'cap de 16KB sobre body.length ausente');
    assert.ok(src.includes('req.destroy()'),
        'req.destroy() para abortar bodies > 16KB ausente');
});

// =========================================================================
// CA-Slice: GET expone shape enriquecido
// =========================================================================

test('CA-Slice: el GET expone describeRestModeNow', () => {
    const src = getSrc();
    assert.ok(src.includes('describeRestModeNow'),
        'el GET debe llamar a restModeWindow.describeRestModeNow');
    // El JSON de respuesta del GET debe incluir el `restMode` enriquecido
    const getBlock = src.slice(
        src.indexOf("req.url === '/api/rest-mode' && req.method === 'GET'"),
        src.indexOf("req.url === '/api/rest-mode' && req.method === 'POST'")
    );
    assert.ok(/restMode:\s*describe/.test(getBlock),
        'el GET response debe incluir el restMode enriquecido');
});

// =========================================================================
// dashboard-slices.js: shape enriquecido en state.restMode
// =========================================================================

test('dashboard-slices.js: state.restMode incluye campos enriquecidos #3241', () => {
    const slicesPath = path.resolve(__dirname, '..', 'dashboard-slices.js');
    const src = fs.readFileSync(slicesPath, 'utf8');
    assert.ok(src.includes('describeRestModeNow'),
        'el slice debe llamar a describeRestModeNow');
    // Campos del shape enriquecido
    for (const field of ['isWithinNow', 'currentPeriod', 'nextPeriod', 'periodsToday']) {
        assert.ok(src.includes(field),
            `slice state.restMode debe incluir "${field}" (CA-Slice)`);
    }
    // Campos legacy preservados para retrocompat del pill viejo
    for (const field of ['isWithinWindow', 'updatedAt']) {
        assert.ok(src.includes(field),
            `slice state.restMode debe preservar "${field}" (retrocompat pill viejo)`);
    }
});

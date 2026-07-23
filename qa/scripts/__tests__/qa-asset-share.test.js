// =============================================================================
// Tests qa-video-share.js — modo assets / qa-results.json — Issue #4173
//
// Cubre los controles que el cierre de /qa debe garantizar para sacar la
// evidencia binaria de git sin filtrar material de firma:
//   - isCanonicalUrl: distingue webViewLink de Drive (canónica) vs presigned R2
//     con X-Amz-*/Signature= (SEC-1).
//   - updateQaResults: shape {video_url, assets[{name,type,url}]}, descarta URLs
//     con material de firma (SEC-1), merge idempotente por name, preserva
//     video_url entre escrituras, crea carpeta/archivo si no existen.
//   - require() del módulo NO auto-ejecuta main() (guard require.main, evita
//     doble envío Telegram).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { updateQaResults, isCanonicalUrl } = require('../qa-video-share');

// updateQaResults escribe siempre bajo <repo>/qa/evidence/<issue>/, derivado de
// __dirname. Usamos un issue sentinela improbable y limpiamos al terminar.
const TEST_ISSUE = '9990001';
const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const RESULTS_DIR = path.join(PROJECT_ROOT, 'qa', 'evidence', TEST_ISSUE);
const RESULTS_PATH = path.join(RESULTS_DIR, 'qa-results.json');

function cleanup() {
    try { fs.rmSync(RESULTS_DIR, { recursive: true, force: true }); } catch { /* noop */ }
}

const DRIVE_URL = 'https://drive.google.com/file/d/AAA111/view';
const DRIVE_URL_2 = 'https://drive.google.com/file/d/BBB222/view';
const PRESIGNED = 'https://acct.r2.cloudflarestorage.com/qa/x.zip?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=deadbeef';

test('isCanonicalUrl acepta webViewLink de Drive y rechaza presigned/vacío', () => {
    assert.equal(isCanonicalUrl(DRIVE_URL), true);
    assert.equal(isCanonicalUrl(PRESIGNED), false);
    assert.equal(isCanonicalUrl('https://x/y?Signature=abc'), false);
    assert.equal(isCanonicalUrl(''), false);
    assert.equal(isCanonicalUrl(null), false);
    assert.equal(isCanonicalUrl(undefined), false);
});

test('updateQaResults crea qa-results.json con el shape esperado', () => {
    cleanup();
    updateQaResults(TEST_ISSUE, [
        { name: 'screenshot-1.png', type: 'png', url: DRIVE_URL },
    ], DRIVE_URL);

    assert.ok(fs.existsSync(RESULTS_PATH), 'qa-results.json debe existir');
    const out = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8'));
    assert.equal(out.video_url, DRIVE_URL);
    assert.deepEqual(out.assets, [
        { name: 'screenshot-1.png', type: 'png', url: DRIVE_URL },
    ]);
    cleanup();
});

test('updateQaResults descarta URLs con material de firma (SEC-1)', () => {
    cleanup();
    updateQaResults(TEST_ISSUE, [
        { name: 'ok.png', type: 'png', url: DRIVE_URL },
        { name: 'evil.zip', type: 'zip', url: PRESIGNED },
    ], PRESIGNED);

    const raw = fs.readFileSync(RESULTS_PATH, 'utf8');
    assert.equal(/X-Amz-|Signature=/.test(raw), false, 'sin material de firma en el JSON');

    const out = JSON.parse(raw);
    assert.equal(out.video_url, '', 'video_url presigned descartado');
    assert.equal(out.assets.length, 1);
    assert.equal(out.assets[0].name, 'ok.png');
    cleanup();
});

test('updateQaResults mergea por name y preserva video_url entre escrituras', () => {
    cleanup();
    updateQaResults(TEST_ISSUE, [
        { name: 'a.png', type: 'png', url: DRIVE_URL },
    ], DRIVE_URL);
    // Segunda escritura: nuevo asset + sin video_url → no debe perder el previo
    updateQaResults(TEST_ISSUE, [
        { name: 'b.html', type: 'html', url: DRIVE_URL_2 },
    ], '');

    const out = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8'));
    assert.equal(out.video_url, DRIVE_URL, 'video_url previo preservado');
    const names = out.assets.map(a => a.name).sort();
    assert.deepEqual(names, ['a.png', 'b.html']);
    cleanup();
});

test('updateQaResults es idempotente: re-escribir el mismo asset no duplica', () => {
    cleanup();
    updateQaResults(TEST_ISSUE, [{ name: 'a.png', type: 'png', url: DRIVE_URL }], DRIVE_URL);
    updateQaResults(TEST_ISSUE, [{ name: 'a.png', type: 'png', url: DRIVE_URL_2 }], DRIVE_URL);

    const out = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8'));
    assert.equal(out.assets.length, 1, 'un solo asset por name');
    assert.equal(out.assets[0].url, DRIVE_URL_2, 'url actualizada al último valor');
    cleanup();
});

test('require() del módulo expone la API y no auto-ejecuta main()', () => {
    // Si main() corriera al require, fallaría por falta de Telegram/args.
    // Que el require haya resuelto y exponga las funciones ya prueba el guard.
    const mod = require('../qa-video-share');
    assert.equal(typeof mod.uploadToDrive, 'function');
    assert.equal(typeof mod.updateQaResults, 'function');
    assert.equal(typeof mod.isCanonicalUrl, 'function');
});

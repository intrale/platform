// =============================================================================
// screenshot-capture.test.js — Tests unitarios (#3381 · CA-15/16/22)
//
// Cobertura:
//   - sanitizeFilename: chars permitidos, trunca a 120.
//   - resolveSafeOutputPath: prefix-check, anti path-traversal, basename clean.
//   - buildDashboardUrl: allowlist de paths (CA-15/19).
//   - capture: comportamiento sin puppeteer (CA-2 fail-soft).
//   - renderHtmlToPng: comportamiento sin puppeteer.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const sc = require('../screenshot-capture');

// -----------------------------------------------------------------------------
// sanitizeFilename
// -----------------------------------------------------------------------------

test('sanitizeFilename: deja solo [a-z0-9_-]', () => {
    assert.equal(sc.sanitizeFilename('login_client-base'), 'login_client-base');
    assert.equal(sc.sanitizeFilename('foo bar.png'), 'foo_bar_png');
    assert.equal(sc.sanitizeFilename('../etc/passwd'), '___etc_passwd');
});

test('sanitizeFilename: input no-string devuelve vacío', () => {
    assert.equal(sc.sanitizeFilename(null), '');
    assert.equal(sc.sanitizeFilename(undefined), '');
    assert.equal(sc.sanitizeFilename(42), '');
});

test('sanitizeFilename: trunca a 120 chars', () => {
    const huge = 'a'.repeat(500);
    assert.equal(sc.sanitizeFilename(huge).length, 120);
});

// -----------------------------------------------------------------------------
// resolveSafeOutputPath
// -----------------------------------------------------------------------------

test('resolveSafeOutputPath: path normal dentro del root → OK', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-test-'));
    const out = sc.resolveSafeOutputPath('mockup.png', tmp);
    assert.ok(out.startsWith(tmp));
    assert.ok(out.endsWith('mockup.png'));
});

test('resolveSafeOutputPath: tira si path traversal (..)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-test-'));
    assert.throws(
        () => sc.resolveSafeOutputPath('../escape.png', tmp),
        /path traversal/,
    );
});

test('resolveSafeOutputPath: tira si basename tiene chars inválidos', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-test-'));
    assert.throws(
        () => sc.resolveSafeOutputPath('foo bar.png', tmp),
        /basename inválido/,
    );
});

test('resolveSafeOutputPath: outputPath vacío tira', () => {
    assert.throws(() => sc.resolveSafeOutputPath('', '/tmp'), /vacío/);
    assert.throws(() => sc.resolveSafeOutputPath(null, '/tmp'), /vacío/);
});

test('resolveSafeOutputPath: allowedRoot vacío tira', () => {
    assert.throws(() => sc.resolveSafeOutputPath('x.png', ''), /vacío/);
});

// -----------------------------------------------------------------------------
// buildDashboardUrl (CA-15)
// -----------------------------------------------------------------------------

test('buildDashboardUrl: path "/" → URL base', () => {
    assert.equal(sc.buildDashboardUrl('/'), 'http://localhost:3200');
});

test('buildDashboardUrl: path autorizado "/v3"', () => {
    assert.equal(sc.buildDashboardUrl('/v3'), 'http://localhost:3200/v3');
});

test('buildDashboardUrl: path no autorizado tira (CA-15/19)', () => {
    assert.throws(
        () => sc.buildDashboardUrl('/ops'),
        /no autorizado/,
    );
    assert.throws(
        () => sc.buildDashboardUrl('http://evil.com'),
        /no autorizado/,
    );
    // SSRF clásico: AWS metadata
    assert.throws(
        () => sc.buildDashboardUrl('http://169.254.169.254/latest'),
        /no autorizado/,
    );
});

test('buildDashboardUrl: path vacío default a "/"', () => {
    assert.equal(sc.buildDashboardUrl(''), 'http://localhost:3200');
    assert.equal(sc.buildDashboardUrl(undefined), 'http://localhost:3200');
});

// -----------------------------------------------------------------------------
// capture: sin puppeteer → fail-soft
// -----------------------------------------------------------------------------

test('capture: sin puppeteer devuelve puppeteer-missing (no throws)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-test-'));
    const result = await sc.capture({
        outputPath: 'actual.png',
        allowedRoot: tmp,
        _requirePuppeteer: () => null,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'puppeteer-missing');
    assert.match(result.detail, /npm install puppeteer/);
});

test('capture: input inválido (path traversal) tira antes de invocar puppeteer', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-test-'));
    await assert.rejects(
        () => sc.capture({
            outputPath: '../boom.png',
            allowedRoot: tmp,
            _requirePuppeteer: () => null,
        }),
        /path traversal/,
    );
});

test('capture: path no autorizado tira', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-test-'));
    await assert.rejects(
        () => sc.capture({
            outputPath: 'x.png',
            allowedRoot: tmp,
            dashboardPath: '/ops',
            _requirePuppeteer: () => null,
        }),
        /no autorizado/,
    );
});

test('capture: con fake puppeteer simulando dashboard-down → fail-soft', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-test-'));
    const fakePuppeteer = {
        launch: async () => ({
            newPage: async () => ({
                setViewport: async () => {},
                goto: async () => { throw new Error('net::ERR_CONNECTION_REFUSED'); },
                screenshot: async () => {},
            }),
            close: async () => {},
        }),
    };
    const result = await sc.capture({
        outputPath: 'actual.png',
        allowedRoot: tmp,
        _requirePuppeteer: () => fakePuppeteer,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'dashboard-down');
});

test('capture: con fake puppeteer simulando éxito', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-test-'));
    let screenshotCalledWith = null;
    const fakePuppeteer = {
        launch: async () => ({
            newPage: async () => ({
                setViewport: async () => {},
                goto: async () => {},
                screenshot: async (opts) => { screenshotCalledWith = opts; },
            }),
            close: async () => {},
        }),
    };
    const result = await sc.capture({
        outputPath: 'actual.png',
        allowedRoot: tmp,
        _requirePuppeteer: () => fakePuppeteer,
    });
    assert.equal(result.ok, true);
    assert.ok(result.outputPath.endsWith('actual.png'));
    assert.equal(screenshotCalledWith.fullPage, true);
});

// -----------------------------------------------------------------------------
// renderHtmlToPng: sin puppeteer → fail-soft
// -----------------------------------------------------------------------------

test('renderHtmlToPng: sin puppeteer devuelve puppeteer-missing', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-test-'));
    const result = await sc.renderHtmlToPng({
        html: '<!DOCTYPE html><html><body>x</body></html>',
        outputPath: 'esperado.png',
        allowedRoot: tmp,
        _requirePuppeteer: () => null,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'puppeteer-missing');
});

test('renderHtmlToPng: html vacío tira', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-test-'));
    await assert.rejects(
        () => sc.renderHtmlToPng({
            html: '',
            outputPath: 'esperado.png',
            allowedRoot: tmp,
            _requirePuppeteer: () => null,
        }),
        /html vacío/,
    );
});

test('renderHtmlToPng: éxito con fake puppeteer', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-test-'));
    let contentSet = null;
    const fakePuppeteer = {
        launch: async () => ({
            newPage: async () => ({
                setViewport: async () => {},
                setContent: async (html) => { contentSet = html; },
                screenshot: async () => {},
            }),
            close: async () => {},
        }),
    };
    const result = await sc.renderHtmlToPng({
        html: '<!DOCTYPE html><html><body>x</body></html>',
        outputPath: 'esperado.png',
        allowedRoot: tmp,
        _requirePuppeteer: () => fakePuppeteer,
    });
    assert.equal(result.ok, true);
    assert.match(contentSet, /DOCTYPE html/);
});

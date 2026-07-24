'use strict';

// Tests de ux-render-compare (issue #4228 — gate de validación UX render vs mockup).
//
// Cubre la lógica determinística del gate:
//   - extractMockupRefs / resolveMockupReference (resolución del mockup esperado)
//   - classifyDegradation (dashboard caído → no aprobar a ciegas)
//   - decideVerdict (regla de decisión pasa/rechaza por severidad y degradación)
//   - captureCurrentRender (wrapper, con captura inyectada)

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

const mod = require('../lib/ux-render-compare');

// ----- extractMockupRefs ----------------------------------------------------

test('extractMockupRefs detecta el mockup "esperado" por alt-text', () => {
    const body = [
        '## Objetivo',
        'Rediseño HOME.',
        '',
        '## Screenshots & Mockups',
        '![estado actual](https://x/actual.png)',
        '![estado esperado (mockup)](https://x/esperado.png)',
        '',
        '## Criterios',
    ].join('\n');
    const r = mod.extractMockupRefs(body);
    assert.equal(r.reason, 'ok');
    assert.deepEqual(r.all, ['https://x/actual.png', 'https://x/esperado.png']);
    assert.deepEqual(r.mockups, ['https://x/esperado.png']);
});

test('extractMockupRefs reporta section-missing si no hay sección', () => {
    const r = mod.extractMockupRefs('## Objetivo\nsin screenshots');
    assert.equal(r.reason, 'section-missing');
    assert.equal(r.all.length, 0);
});

test('extractMockupRefs reporta no-images si la sección está vacía', () => {
    const body = '## Screenshots & Mockups\n\n(pendiente)\n\n## Criterios';
    const r = mod.extractMockupRefs(body);
    assert.equal(r.reason, 'no-images');
});

test('extractMockupRefs reporta empty-body con body vacío', () => {
    assert.equal(mod.extractMockupRefs('').reason, 'empty-body');
});

// ----- resolveMockupReference ----------------------------------------------

test('resolveMockupReference prioriza el mockup del body del issue', () => {
    const body = [
        '## Screenshots & Mockups',
        '![actual](https://x/a.png)',
        '![esperado](https://x/e.png)',
    ].join('\n');
    const r = mod.resolveMockupReference({ body, issue: 4228, repoRoot: process.cwd() });
    assert.equal(r.ok, true);
    assert.equal(r.source, 'issue-body');
    assert.deepEqual(r.refs, ['https://x/e.png']);
});

test('resolveMockupReference cae a assets locales cuando el body no tiene mockup', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uxrc-'));
    const issue = 9999;
    const dir = path.join(tmp, '.pipeline', 'assets', 'mockups', String(issue));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'home-esperado.png'), 'fake');
    fs.writeFileSync(path.join(dir, 'notas.txt'), 'ignorar');

    const r = mod.resolveMockupReference({ body: '## Objetivo\nsin imgs', issue, repoRoot: tmp });
    assert.equal(r.ok, true);
    assert.equal(r.source, 'local-assets');
    assert.equal(r.refs.length, 1);
    assert.match(r.refs[0], /home-esperado\.png$/);

    fs.rmSync(tmp, { recursive: true, force: true });
});

test('resolveMockupReference falla (ok:false) si no hay mockup en ningún lado', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uxrc-'));
    const r = mod.resolveMockupReference({ body: '## Objetivo\nnada', issue: 1, repoRoot: tmp });
    assert.equal(r.ok, false);
    assert.equal(r.source, 'none');
    fs.rmSync(tmp, { recursive: true, force: true });
});

// ----- classifyDegradation --------------------------------------------------

test('classifyDegradation: captura ok → no degradado', () => {
    const d = mod.classifyDegradation({ ok: true, outputPath: '/x.png' });
    assert.deepEqual(d, { degraded: false, infra: false, reason: null });
});

test('classifyDegradation: dashboard-down → degradado + infra', () => {
    const d = mod.classifyDegradation({ ok: false, reason: 'dashboard-down' });
    assert.equal(d.degraded, true);
    assert.equal(d.infra, true);
    assert.equal(d.reason, 'dashboard-down');
});

test('classifyDegradation: puppeteer-missing → degradado + infra', () => {
    const d = mod.classifyDegradation({ ok: false, reason: 'puppeteer-missing' });
    assert.equal(d.infra, true);
});

// ----- decideVerdict --------------------------------------------------------

test('decideVerdict: sin mockup → rechazado por sin-mockup', () => {
    const v = mod.decideVerdict({ mockupResolved: false, divergences: [] });
    assert.equal(v.resultado, 'rechazado');
    assert.equal(v.causa, 'sin-mockup');
});

test('decideVerdict: captura degradada → rechazado no-verificable (no aprueba a ciegas)', () => {
    const v = mod.decideVerdict({
        mockupResolved: true,
        degradation: { degraded: true, infra: true, reason: 'dashboard-down' },
        divergences: [],
    });
    assert.equal(v.resultado, 'rechazado');
    assert.equal(v.causa, 'no-verificable');
    assert.match(v.motivo, /3200/);
});

test('decideVerdict: divergencia relevante (alta) → rechazado y rebote a dev', () => {
    const v = mod.decideVerdict({
        divergences: [
            { aspecto: 'layout', descripcion: 'la card HOME usa 1 columna en vez de 3', severidad: 'alta' },
        ],
    });
    assert.equal(v.resultado, 'rechazado');
    assert.equal(v.causa, 'divergencia');
    assert.equal(v.blocking.length, 1);
    assert.match(v.motivo, /layout/);
});

test('decideVerdict: solo divergencia baja → aprobado con nota', () => {
    const v = mod.decideVerdict({
        divergences: [{ aspecto: 'spacing', descripcion: '2px de diferencia', severidad: 'baja' }],
    });
    assert.equal(v.resultado, 'aprobado');
    assert.equal(v.menores.length, 1);
});

test('decideVerdict: sin divergencias → aprobado', () => {
    const v = mod.decideVerdict({ divergences: [] });
    assert.equal(v.resultado, 'aprobado');
    assert.equal(v.causa, 'coincide');
});

test('decideVerdict: severidad desconocida se trata como media (bloquea por default)', () => {
    const v = mod.decideVerdict({
        divergences: [{ descripcion: 'algo raro', severidad: 'no-existe' }],
    });
    assert.equal(v.resultado, 'rechazado');
});

test('decideVerdict: umbral configurable a alta deja pasar divergencias media', () => {
    const v = mod.decideVerdict({
        threshold: 'alta',
        divergences: [{ descripcion: 'color levemente distinto', severidad: 'media' }],
    });
    assert.equal(v.resultado, 'aprobado');
});

// ----- isBlocking -----------------------------------------------------------

test('isBlocking: critica/alta/media bloquean con umbral media; baja no', () => {
    assert.equal(mod.isBlocking('critica', 'media'), true);
    assert.equal(mod.isBlocking('alta', 'media'), true);
    assert.equal(mod.isBlocking('media', 'media'), true);
    assert.equal(mod.isBlocking('baja', 'media'), false);
});

// ----- captureCurrentRender (captura inyectada) -----------------------------

test('captureCurrentRender delega en capture() y propaga el resultado ok', async () => {
    const fakeCapture = async (o) => ({ ok: true, outputPath: o.outputPath });
    const r = await mod.captureCurrentRender({
        outputPath: 'render.png',
        allowedRoot: '/tmp',
        _capture: fakeCapture,
    });
    assert.equal(r.ok, true);
    assert.equal(r.outputPath, 'render.png');
});

test('captureCurrentRender atrapa throws de capture() como capture-input-error', async () => {
    const boom = async () => {
        throw new Error('path traversal detectado');
    };
    const r = await mod.captureCurrentRender({ outputPath: '../evil', allowedRoot: '/tmp', _capture: boom });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'capture-input-error');
});

// ----- evidenceDir ----------------------------------------------------------

test('evidenceDir crea el directorio issue-scoped de validación', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uxrc-ev-'));
    const dir = mod.evidenceDir(4228, tmp);
    assert.ok(fs.existsSync(dir));
    assert.match(dir, /4228[\\/]validacion$/);
    fs.rmSync(tmp, { recursive: true, force: true });
});

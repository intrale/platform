// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// #5691 (rebote 1) / #7233 — "render real" del script cliente de /legacy.
//
// El `<script>` que `generateHTML()` sirve en GET /legacy es un template
// literal de ~131 KB. Un solo `\'` mal escapado adentro se resuelve a `'` al
// construir el string del servidor y el navegador recibe JS que NO parsea: el
// bloque entero muere y con él las 144 funciones que define (recoRefresh,
// recoDescartarBanner, toggleNeedsHumanPanel, killAgent, ...). Los tests que
// hacen `require('dashboard.js')` no lo ven: el módulo Node parsea perfecto.
//
// Este test levanta el dashboard contra un state dir temporal, pide /legacy,
// extrae CADA <script> inline y lo compila con `vm.Script`. Si alguno no
// parsea, falla nombrando la línea del script y el fragmento ofensivo.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');
const { spawnDashboard, waitForDashboardBoot } = require('./helpers/dashboard-boot');
const { getFreePort } = require('./helpers/free-port');
const { seedConfig } = require('./helpers/sandbox-config');

const PIPELINE_SRC = path.resolve(__dirname, '..');
let tmpDir, child, port, html;

function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }

function makePipelineDirs(root, config) {
    for (const [pname, pcfg] of Object.entries(config.pipelines)) {
        for (const fase of pcfg.fases) {
            for (const st of ['pendiente', 'trabajando', 'listo', 'procesado']) {
                mkdirp(path.join(root, pname, fase, st));
            }
        }
    }
    mkdirp(path.join(root, 'logs'));
}

function getHtml(p, cb) {
    const req = http.get({ host: '127.0.0.1', port: p, path: '/legacy', timeout: 8000 }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => cb(null, data));
    });
    req.on('error', cb);
    req.on('timeout', function () { this.destroy(new Error('timeout')); });
}

/**
 * Extrae los <script> inline (sin `src`, tipo JS clásico o sin tipo) del HTML.
 * Recorre el documento salteando los comentarios HTML (`<!-- ... -->`): el
 * dashboard tiene comentarios que MENCIONAN `<script>` y un regex ingenuo los
 * tomaría como bloques de código.
 * @param {string} doc
 * @returns {Array<{index:number, code:string, attrs:string}>}
 */
function extractInlineScripts(doc) {
    const out = [];
    const lower = doc.toLowerCase();
    let pos = 0;
    let i = 0;
    for (;;) {
        const sIdx = lower.indexOf('<script', pos);
        if (sIdx === -1) break;
        const c = doc.indexOf('<!--', pos);
        if (c !== -1 && c < sIdx) {
            const end = doc.indexOf('-->', c + 4);
            pos = end === -1 ? doc.length : end + 3;
            continue;
        }
        const openEnd = doc.indexOf('>', sIdx);
        if (openEnd === -1) break;
        const attrs = doc.slice(sIdx + 7, openEnd);
        const closeIdx = lower.indexOf('</script', openEnd + 1);
        if (closeIdx === -1) break;
        const code = doc.slice(openEnd + 1, closeIdx);
        const closeEnd = doc.indexOf('>', closeIdx);
        if (closeEnd === -1) break;
        pos = closeEnd + 1;
        i += 1;
        if (/\bsrc\s*=/i.test(attrs)) continue;
        const type = (attrs.match(/\btype\s*=\s*["']([^"']+)["']/i) || [])[1];
        if (type && !/javascript|ecmascript|^module$/i.test(type)) continue;
        out.push({ index: i, code, attrs });
    }
    return out;
}

before(async () => {
    const yaml = require('js-yaml');
    const config = yaml.load(fs.readFileSync(path.join(PIPELINE_SRC, 'config.yaml'), 'utf8'));
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash7233-'));
    makePipelineDirs(tmpDir, config);
    seedConfig(tmpDir);

    fs.writeFileSync(path.join(tmpDir, 'desarrollo', 'dev', 'trabajando', '700.android-dev'),
        'issue: 700\nfase: dev\npipeline: desarrollo\n');
    fs.writeFileSync(path.join(tmpDir, 'waves.json'), JSON.stringify({
        version: '1.0',
        active_wave: { number: 8, name: 'Ola 8', started_at: '2026-06-10T00:00:00Z', issues: [700] },
        waves: [],
    }, null, 2));
    fs.writeFileSync(path.join(tmpDir, '.issue-title-cache.json'), JSON.stringify({
        '700': { title: 'Issue activo en dev', labels: ['app:client'], state: 'OPEN', ts: Date.now() },
    }, null, 2));

    port = await getFreePort();
    child = spawnDashboard({
        dashboardPath: path.join(PIPELINE_SRC, 'dashboard.js'),
        env: {
            ...process.env,
            PIPELINE_STATE_DIR: tmpDir,
            PIPELINE_DIR_OVERRIDE: tmpDir,
            DASHBOARD_PORT: String(port),
            DASHBOARD_HOST: '127.0.0.1',
            GH_BIN: 'gh-noop-nonexistent',
        },
    });

    html = await waitForDashboardBoot({
        child,
        probe: () => new Promise((resolve, reject) => {
            getHtml(port, (err, body) => (err ? reject(err) : resolve(body && body.length > 1000 ? body : null)));
        }),
    });
});

after(() => {
    if (child) { try { child.kill(); } catch {} }
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
});

test('extractInlineScripts — ignora menciones de <script> dentro de comentarios HTML', () => {
    const doc = '<!-- el <script> global --><script>var a = 1;</script><script src="/x.js"></script><script type="application/json">{"a":1}</script>';
    const got = extractInlineScripts(doc);
    assert.deepStrictEqual(got.map((s) => s.code), ['var a = 1;']);
});

test('#7233 — GET /legacy sirve al menos un <script> inline', () => {
    const scripts = extractInlineScripts(html);
    assert.ok(scripts.length >= 1, 'hay scripts inline en /legacy');
});

test('#7233 — cada <script> inline de /legacy parsea como JS (vm.Script)', () => {
    const scripts = extractInlineScripts(html);
    const errores = [];
    for (const s of scripts) {
        try {
            // eslint-disable-next-line no-new
            new vm.Script(s.code, { filename: `legacy-inline-script-${s.index}.js` });
        } catch (e) {
            const m = String((e && e.stack) || e).match(/legacy-inline-script-\d+\.js:(\d+)/);
            const line = m ? Number(m[1]) : null;
            const frag = line ? (s.code.split('\n')[line - 1] || '').trim().slice(0, 160) : '';
            errores.push(`script #${s.index}${line ? ':' + line : ''} → ${e.message}${frag ? '\n    ' + frag : ''}`);
        }
    }
    assert.deepStrictEqual(errores, [], 'scripts inline que no parsean:\n' + errores.join('\n'));
});

test('#5691 E2 — recoInitBanners y recoDescartarBanner viven en un <script> de /legacy que parsea', () => {
    const scripts = extractInlineScripts(html);
    const defined = { init: false, descartar: false };
    for (const s of scripts) {
        if (!/recoDescartarBanner/.test(s.code)) continue;
        // Compilar sólo; no se ejecuta (el bloque necesita DOM real).
        // eslint-disable-next-line no-new
        new vm.Script(s.code, { filename: `legacy-inline-script-${s.index}.js` });
        defined.init = defined.init || /function\s+recoInitBanners\s*\(/.test(s.code);
        defined.descartar = defined.descartar || /function\s+recoDescartarBanner\s*\(/.test(s.code);
    }
    assert.ok(defined.init, 'recoInitBanners definida en un script que parsea');
    assert.ok(defined.descartar, 'recoDescartarBanner definida en un script que parsea');
});

test('#5691 E2 — el banner de transición nace oculto y la CSS no pisa el atributo hidden', () => {
    // El banner de la vista de recos se emite con `hidden`; la regla
    // `.reco-banner{display:flex}` tiene MÁS especificidad que la del UA para
    // `[hidden]{display:none}`, así que sin una regla explícita el banner se
    // ve aunque esté marcado oculto (medido por QA: hidden=true, display=flex).
    assert.match(html, /\.reco-banner\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
});

test('#5691 E6-d — el ícono del banner referencia el sprite inlineado (href="#ic-triage-backlog")', () => {
    assert.ok(html.includes('<symbol id="ic-triage-backlog"'), 'el sprite inlineado en la página trae ic-triage-backlog');
    assert.ok(html.includes('<use href="#ic-triage-backlog"'), 'el banner usa href="#ic-triage-backlog"');
    assert.ok(!html.includes('sprite.svg#ic-triage-backlog'), 'no queda ninguna referencia externa al sprite');
});

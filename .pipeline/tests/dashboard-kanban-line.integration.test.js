'use strict';

// Integración EP8-H3 (#3956) — "render real" del board kanban (la ola en una
// sola línea) por curl+grep del HTML servido por el dashboard, según la
// convención del proyecto (no solo sintaxis JS). Levanta el dashboard contra un
// PIPELINE_STATE_DIR temporal poblado con: un issue activo (dev), uno finalizado
// (procesado), uno no-ingresado bloqueado por deps y pausa parcial activa; luego
// pega a /legacy (ruta que sirve generateHTML, el board kanban con it-lanes).

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

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
    http.get({ host: '127.0.0.1', port: p, path: '/legacy', timeout: 8000 }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => cb(null, data));
    }).on('error', cb);
}

before(async () => {
    const yaml = require('js-yaml');
    const config = yaml.load(fs.readFileSync(path.join(PIPELINE_SRC, 'config.yaml'), 'utf8'));
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash3956-'));
    makePipelineDirs(tmpDir, config);
    // config.yaml para loadConfig()
    fs.copyFileSync(path.join(PIPELINE_SRC, 'config.yaml'), path.join(tmpDir, 'config.yaml'));

    // Issue ACTIVO en dev (lane dev, debe tener botón ⓘ del popover de agente).
    fs.writeFileSync(path.join(tmpDir, 'desarrollo', 'dev', 'trabajando', '700.android-dev'),
        'issue: 700\nfase: dev\npipeline: desarrollo\n');
    // Log del issue activo → el popover de card ofrece "Ver log".
    fs.writeFileSync(path.join(tmpDir, 'logs', '700-android-dev.log'), 'log de prueba\n');

    // Issue FINALIZADO: archivo procesado en la última fase de desarrollo
    // (entrega) → isComplete() === true → etapa terminal "Finalizados".
    const lastDev = config.pipelines.desarrollo.fases[config.pipelines.desarrollo.fases.length - 1];
    fs.writeFileSync(path.join(tmpDir, 'desarrollo', lastDev, 'procesado', '800.delivery'),
        'issue: 800\nfase: ' + lastDev + '\npipeline: desarrollo\nresultado: aprobado\n');

    // waves.json — ola activa con un issue NO ingresado (900) bloqueado por deps.
    fs.writeFileSync(path.join(tmpDir, 'waves.json'), JSON.stringify({
        version: '1.0',
        active_wave: { number: 8, name: 'Ola 8', started_at: '2026-06-10T00:00:00Z', issues: [700, 800, 900] },
        waves: [],
    }, null, 2));

    // deps abiertas para el no-ingresado 900 → motivo con link al bloqueante.
    fs.writeFileSync(path.join(tmpDir, 'blocked-issues.json'), JSON.stringify({
        blockedBy: { '900': [3958] }, blocks: {},
    }, null, 2));

    // title cache pre-poblado (evita que el dashboard llame a gh en el render).
    fs.writeFileSync(path.join(tmpDir, '.issue-title-cache.json'), JSON.stringify({
        '700': { title: 'Issue activo en dev', labels: ['app:client'], state: 'OPEN', ts: Date.now() },
        '800': { title: 'Issue finalizado', labels: [], state: 'CLOSED', ts: Date.now() },
        '900': { title: 'Issue bloqueado por deps', labels: [], state: 'OPEN', ts: Date.now() },
        '3958': { title: 'Bloqueante', labels: [], state: 'OPEN', ts: Date.now() },
    }, null, 2));

    // Pausa parcial activa → badge único "Fuera de allowlist · N".
    fs.writeFileSync(path.join(tmpDir, '.partial-pause.json'), JSON.stringify({
        allowed_issues: [700], created_at: '2026-06-15T00:00:00Z',
    }, null, 2));

    port = 3300 + Math.floor((Date.now() % 400));
    child = spawn(process.execPath, [path.join(PIPELINE_SRC, 'dashboard.js')], {
        env: {
            ...process.env,
            PIPELINE_STATE_DIR: tmpDir,
            PIPELINE_DIR_OVERRIDE: tmpDir,
            DASHBOARD_PORT: String(port),
            DASHBOARD_HOST: '127.0.0.1',
            GH_BIN: 'gh-noop-nonexistent', // jamás se invoca: title cache poblado
        },
        stdio: 'ignore',
    });

    // Esperar a que el server levante + fetch.
    await new Promise((resolve, reject) => {
        let tries = 0;
        const tick = () => {
            getHtml(port, (err, body) => {
                if (!err && body && body.length > 1000) { html = body; return resolve(); }
                if (++tries > 40) return reject(new Error('dashboard no levantó: ' + (err && err.message)));
                setTimeout(tick, 250);
            });
        };
        setTimeout(tick, 500);
    });
});

after(() => {
    if (child) { try { child.kill(); } catch {} }
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
});

// ── CA-7 · una sola línea, sin bandejas separadas ────────────────────────────
test('CA-7 — la línea única (it-lanes-wrap) existe y NO hay sección Completados aparte', () => {
    assert.ok(html.includes('it-lanes-wrap'), 'wrapper de la línea presente');
    assert.ok(!/class="it-done-section"/.test(html), 'no existe la bandeja separada de completados');
});

// ── CA-5 · etapa No ingresados en la línea ───────────────────────────────────
test('CA-5 — etapa "No ingresados" con motivo y link al bloqueante (https://github.com)', () => {
    assert.ok(html.includes('it-lane-nentered'), 'etapa No ingresados en la línea');
    assert.ok(html.includes('lc-nentered'), 'card de no-ingresado');
    assert.ok(html.includes('Bloqueado por'), 'motivo de deps');
    assert.ok(html.includes('https://github.com/intrale/platform/issues/3958'), 'link al bloqueante');
});

// ── CA-6 · etapa Finalizados en la línea ─────────────────────────────────────
test('CA-6 — etapa "Finalizados" en la línea con el issue completado', () => {
    assert.ok(html.includes('it-lane-done'), 'etapa Finalizados en la línea');
    // El issue 800 finalizado aparece como card; el footer degrada a "sin link"
    // porque el fetch de PR (gh) no está disponible en el test.
    assert.ok(html.includes('lc-finalizado'), 'footer de finalizado');
    assert.ok(html.includes('data-issue="800"'), 'issue finalizado presente');
});

// ── CA-2 · popover del agente a nivel card ───────────────────────────────────
test('CA-2 — card del issue activo expone el botón de popover del agente', () => {
    assert.ok(html.includes('data-issue="700"'), 'card activa presente');
    assert.ok(html.includes('showCardPopup(event,this)'), 'botón ⓘ del popover');
    assert.ok(html.includes('data-card-popup='), 'payload del popover (issue/skill/fase/estado/edad/motivo/log)');
});

// ── CA-3 · badge único de pausa ──────────────────────────────────────────────
test('CA-3 — badge único de pausa muestra "Fuera de allowlist" en pausa parcial', () => {
    assert.ok(html.includes('Fuera de allowlist'), 'estado fuera de allowlist');
    // un solo badge: no debe existir la pill duplicada legacy hdr-v3-badge de allowlist
    assert.ok(!html.includes('Pausa parcial — solo estos issues procesan'), 'sin pill duplicada de allowlist');
});

// ── CA-4 · indicador overflow ────────────────────────────────────────────────
test('CA-4 — indicador "+N fases" para overflow horizontal presente', () => {
    assert.ok(html.includes('id="it-lanes-overflow"'), 'indicador de overflow');
    assert.ok(html.includes('updateLaneOverflow'), 'cálculo client-side');
});

// ── CA-1 · zoom semántico ────────────────────────────────────────────────────
test('CA-1 — controles de zoom (lejos/normal/foco) y densidad por defecto normal', () => {
    assert.ok(html.includes('class="it-zoom"'), 'control de zoom');
    assert.ok(/it-lanes zoom-normal/.test(html), 'densidad normal por defecto');
    assert.ok(html.includes("setBoardZoom('lejos')"), 'modo kiosk');
});

// ── CA-8 · XSS escaping en popover (data-popup server-side) ───────────────────
test('CA-8 — el escape client-side del popover está cableado', () => {
    assert.ok(html.includes('function __popEsc'), 'escape client-side definido');
    assert.ok(html.includes('__popEsc(s.motivo)'), 'motivo escapado en showDotPopup');
    assert.ok(html.includes('__popEsc(s.skill)'), 'skill escapado en showDotPopup');
});

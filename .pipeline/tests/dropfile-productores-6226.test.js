// =============================================================================
// Tests #6226 (rebote rev-1) — MIGRACIÓN DE LOS PRODUCTORES DE DROPFILES
//
// El fix original de #6226 creó `lib/dropfile-writer.js` y migró
// `pulpo.js::sendTelegramWithMarkup` (el productor donde se reportó el bug),
// pero dejó SIN migrar al resto de los productores. QA lo rechazó: el
// "Cambios requeridos #3" del issue pide explícitamente revisar TODOS los
// puntos que arman el nombre con `Date.now()` solo.
//
// Estos tests cubren los productores que quedaron afuera. Cada uno reproduce
// la pérdida real que QA observó, no una condición sintética:
//
//   - `multi-provider/health-cron.js::defaultTelegramSender` — `emitAlerts()`
//     lo invoca UNA VEZ POR ALERTA dentro del mismo tick. Con 4 providers en
//     rojo se emitían 4 alertas y quedaban 3 archivos: una se perdía en
//     silencio (el sender devolvía `true` igual).
//
//   - `agent-models-change-alert.js::sendAlert` — armaba el nombre con un `now`
//     capturado FUERA del `for (const window of windows)`. Con N ventanas
//     consolidadas el path era EL MISMO para todas, de forma determinista: no
//     dependía de la velocidad del reloj.
//
//   - `cost-anomaly-alert.js::sendTelegramAlert` — mismo patrón de nombre.
//
// El último test es un guard estructural sobre TODO `.pipeline/`: si alguien
// suma un productor nuevo con nombre colisionable, falla acá. Sin ese guard
// esta clase de bug vuelve calladita, que es exactamente cómo llegó a
// producción la primera vez.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PIPELINE_DIR = path.resolve(__dirname, '..');

const healthCron = require(path.join(PIPELINE_DIR, 'lib', 'multi-provider', 'health-cron.js'));
const modelsAlert = require(path.join(PIPELINE_DIR, 'lib', 'agent-models-change-alert.js'));
const costAlert = require(path.join(PIPELINE_DIR, 'lib', 'cost-anomaly-alert.js'));

function tmpRoot(prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
    fs.mkdirSync(path.join(dir, 'servicios', 'telegram', 'pendiente'), { recursive: true });
    return dir;
}

function rmr(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function queueFiles(root) {
    return fs.readdirSync(path.join(root, 'servicios', 'telegram', 'pendiente')).sort();
}

function readQueued(root, name) {
    return JSON.parse(fs.readFileSync(path.join(root, 'servicios', 'telegram', 'pendiente', name), 'utf8'));
}

// -----------------------------------------------------------------------------
// health-cron — N alertas del mismo tick
// -----------------------------------------------------------------------------

test('health-cron · 4 alertas emitidas en el mismo tick producen 4 dropfiles y ninguna se pierde', () => {
    const root = tmpRoot('mp-health-6226');
    // Congelar el reloj es EXACTAMENTE la condición del bug: `emitAlerts()`
    // encadena los 4 sends sin ceder el event loop, así que caen en el mismo ms.
    const FROZEN = 1787039565917;
    const realNow = Date.now;
    Date.now = () => FROZEN;

    try {
        const providers = ['anthropic', 'openai', 'gemini', 'deepseek'];
        const snapshot = {
            providers: providers.map(p => ({
                provider: p, state: 'red', reason_code: 'auth_error', consecutive_count: 3,
            })),
        };
        const prevSnapshot = { providers: providers.map(p => ({ provider: p, state: 'green' })) };

        const sent = healthCron.emitAlerts({
            snapshot,
            prevSnapshot,
            dedupFile: path.join(root, 'dedup.json'),
            now: FROZEN,
            telegramSender: (payload) => healthCron.defaultTelegramSender(payload, { pipelineDir: root }),
        });

        assert.equal(sent.length, 4, 'las 4 transiciones a rojo deben emitir alerta');

        const files = queueFiles(root);
        assert.equal(files.length, 4, 'debe haber un dropfile por alerta, no menos');
        assert.equal(new Set(files).size, 4, 'los nombres deben ser todos distintos');

        // Ningún provider se perdió: cada alerta tiene su archivo con su texto.
        const provsEnCola = files.map(f => (readQueued(root, f).text.match(/`([a-z0-9-]+)`/) || [])[1]);
        for (const p of providers) {
            assert.ok(provsEnCola.includes(p), `la alerta de \`${p}\` no puede perderse en silencio`);
        }

        // El orden lexicográfico del nombre sigue siendo el orden de emisión:
        // el servicio drena por nombre, así que esto ES el orden de lectura.
        assert.deepEqual(provsEnCola, providers, 'el orden de emisión debe preservarse');
    } finally {
        Date.now = realNow;
        rmr(root);
    }
});

test('health-cron · un dropfile preexistente con el mismo nombre no se sobreescribe', () => {
    const root = tmpRoot('mp-health-clash-6226');
    const FROZEN = 1787039565917;
    const realNow = Date.now;
    Date.now = () => FROZEN;

    try {
        const qDir = path.join(root, 'servicios', 'telegram', 'pendiente');
        // Resto de una corrida anterior que ocupa el primer nombre calculado.
        const ocupado = path.join(qDir, `${FROZEN}-0000-mp-health.json`);
        fs.writeFileSync(ocupado, '{"text":"PREEXISTENTE"}', 'utf8');

        const ok = healthCron.defaultTelegramSender(
            { provider: 'anthropic', state: 'red', reason_code: 'auth_error', observed_at: 'x' },
            { pipelineDir: root },
        );

        assert.equal(ok, true, 'el envío debe reportar éxito');
        assert.equal(
            fs.readFileSync(ocupado, 'utf8'), '{"text":"PREEXISTENTE"}',
            'el archivo preexistente NO se sobreescribe',
        );
        assert.equal(queueFiles(root).length, 2, 'el mensaje nuevo va a un nombre distinto');
    } finally {
        Date.now = realNow;
        rmr(root);
    }
});

// -----------------------------------------------------------------------------
// agent-models-change-alert — N ventanas consolidadas
// -----------------------------------------------------------------------------

function makeFakeGit({ commits, blobs }) {
    return function fakeExec(cmd, args) {
        if (cmd !== 'git') throw new Error(`fake git: cmd inesperado ${cmd}`);
        if (args[0] === 'log') {
            return commits.map((c) => {
                const header = `\x1f${c.sha}\x1e${c.ts}\x1e${(c.parents || []).join(' ')}`;
                const files = (c.files || []).join('\n');
                return files ? `${header}\n${files}` : header;
            }).join('\n');
        }
        if (args[0] === 'show') {
            const sha = String(args[1] || '').split(':')[0];
            const blob = blobs[sha];
            if (blob == null) { const e = new Error('no blob'); e.status = 128; throw e; }
            return typeof blob === 'string' ? blob : JSON.stringify(blob);
        }
        if (args[0] === 'rev-parse') return 'HEAD-FAKE\n';
        throw new Error(`fake git: subcmd no soportado ${args[0]}`);
    };
}

function modelsCfg(model) {
    return {
        default_provider: 'anthropic',
        providers: {
            anthropic: { launcher: 'claude', model, spawn_args_template: ['-p', '{user_prompt}'] },
        },
        skills: { 'backend-dev': { provider: 'anthropic', model_override: model } },
    };
}

test('agent-models-change-alert · 3 ventanas consolidadas producen 3 dropfiles distintos', () => {
    const root = tmpRoot('models-alert-6226');
    try {
        // Commits separados por 2h > windowMs(5min) => 3 ventanas distintas.
        const commits = [
            { sha: 'c1', ts: '2026-05-08T10:00:00Z', parents: ['p0'], files: ['.pipeline/agent-models.json'] },
            { sha: 'c2', ts: '2026-05-08T12:00:00Z', parents: ['c1'], files: ['.pipeline/agent-models.json'] },
            { sha: 'c3', ts: '2026-05-08T14:00:00Z', parents: ['c2'], files: ['.pipeline/agent-models.json'] },
        ];
        const blobs = {
            p0: modelsCfg('claude-opus-4-7'),
            c1: modelsCfg('claude-sonnet-4-5'),
            c2: modelsCfg('gpt-5-codex'),
            c3: modelsCfg('gemini-2-5-pro'),
        };

        const res = modelsAlert.sendAlert('p0', 'c3', {
            pipelineDir: root,
            cwd: root,
            execFile: makeFakeGit({ commits, blobs }),
            windowMs: 5 * 60 * 1000,
            // Reloj congelado: el bug NO dependía del reloj (el `now` estaba
            // capturado fuera del loop), así que congelarlo no lo enmascara.
            now: () => 1787039565917,
        });

        assert.equal(res.alerts.length, 3, 'una alerta por ventana');

        const files = queueFiles(root);
        assert.equal(files.length, 3, 'una ventana pisaba a la otra: debe haber 3 archivos');
        assert.equal(new Set(files).size, 3, 'los nombres deben ser todos distintos');

        // `queueFile` reportado por sendAlert tiene que coincidir con lo que
        // realmente quedó en disco (antes reportaba 3 paths idénticos).
        const reportados = res.alerts.map(a => path.basename(a.queueFile)).sort();
        assert.deepEqual(reportados, files, 'el queueFile reportado debe ser el archivo real');
    } finally {
        rmr(root);
    }
});

// -----------------------------------------------------------------------------
// cost-anomaly-alert
// -----------------------------------------------------------------------------

test('cost-anomaly-alert · dos alertas en el mismo milisegundo no se pisan', () => {
    const root = tmpRoot('cost-anomaly-6226');
    try {
        const FROZEN = 1787039565917;
        const evaluation = {
            anomalous: true, skill: 'backend-dev', level: 'warn',
            observed: 12.5, baseline: 3.1, ratio: 4.03,
        };
        const snapshot = { window: '24h', total_usd: 42.0 };

        const a = costAlert.sendTelegramAlert(evaluation, snapshot, { pipelineDir: root, now: () => FROZEN });
        const b = costAlert.sendTelegramAlert(evaluation, snapshot, { pipelineDir: root, now: () => FROZEN });

        assert.equal(a.ok, true);
        assert.equal(b.ok, true);
        assert.notEqual(a.file, b.file, 'los dos paths deben ser distintos');
        assert.equal(queueFiles(root).length, 2, 'ninguna alerta se pierde');
    } finally {
        rmr(root);
    }
});

// -----------------------------------------------------------------------------
// Guard estructural — ningún productor nuevo puede volver a colisionar
// -----------------------------------------------------------------------------

test('guard · ningún productor de .pipeline arma el nombre de un dropfile con timestamp solo', () => {
    const SKIP_DIRS = new Set(['node_modules', '__tests__', 'tests', '.git', 'logs', 'servicios']);

    function walk(dir, acc) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                if (SKIP_DIRS.has(entry.name)) continue;
                walk(path.join(dir, entry.name), acc);
            } else if (entry.isFile() && entry.name.endsWith('.js')
                       && !entry.name.endsWith('.test.js')
                       // `test-*.js` son harnesses de test que viven fuera de
                       // `tests/` (ej. `test-connectivity-precheck.js`).
                       && !entry.name.startsWith('test-')) {
                acc.push(path.join(dir, entry.name));
            }
        }
        return acc;
    }

    // `<template>-<algo>.json` armado sólo con un timestamp, sin desempate.
    const COLISIONABLE = /\$\{\s*(Date\.now\(\)|now|nowMs|ts|stamp)\s*\}-[a-zA-Z0-9._-]*\.(json|txt|md)/;

    const ofensores = [];
    for (const file of walk(PIPELINE_DIR, [])) {
        const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
        lines.forEach((line, i) => {
            const trimmed = line.trim();
            // Los comentarios explican el bug viejo citando el patrón: no cuentan.
            if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
            // Scratch files en el tmpdir del SO no son dropfiles de cola.
            if (line.includes('tmpdir()')) return;
            if (COLISIONABLE.test(line)) {
                ofensores.push(`${path.relative(PIPELINE_DIR, file)}:${i + 1}: ${trimmed}`);
            }
        });
    }

    assert.deepEqual(
        ofensores, [],
        'Estos productores arman el nombre del dropfile con un timestamp sin desempate '
        + '(#6226). Usá `lib/dropfile-writer.js::writeDropfileSync`, que suma un `seq` '
        + `y escribe con flag 'wx':\n  ` + ofensores.join('\n  '),
    );
});

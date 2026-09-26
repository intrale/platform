// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

/**
 * #7112 · rebote rev-2 de `verificacion` — los escritores que la suite ejercitaba
 * y que ninguna capa cubría:
 *
 *   (1) `metrics/aggregator.js` — destino derivado de `lib/traceability.REPO_ROOT`
 *       (`PIPELINE_REPO_ROOT` + git), ciego a `PIPELINE_DIR_OVERRIDE`: desde un
 *       test en un worktree reescribía `metrics/snapshot*.json` del productivo REAL.
 *   (2) `quota-snapshot-scheduler.js` — `const PIPELINE_DIR = __dirname` (alias
 *       crudo): `logs/quota-snapshot.log` y la cola de Telegram.
 *   (3) `smoke-test.js` — mismo alias: `logs/smoke-test.log`.
 *   (+) `rollback.js`, `build-log-staleness.js`, `pulpo-liveness-run.js`,
 *       `watchdog-supervisor-run.js`, `metrics/budget-config.js`: mismo patrón,
 *       destapados por el escáner corregido.
 *
 * Contrato que se verifica (CA-3 / CA-5 / CA-9):
 *   - sin dir de pruebas y sin declaración ⇒ el escritor NO escribe en el
 *     `.pipeline` "productivo" del fixture (ni en el que apunta
 *     `PIPELINE_REPO_ROOT`) y avisa por stderr con el prefijo `[pipeline-env]`;
 *   - con `PIPELINE_DIR_OVERRIDE` (lo que setea el runner) ⇒ escribe AHÍ;
 *   - el aggregator acepta el dir que el dashboard ya resolvió (`--pipeline-dir`).
 *
 * Todo en proceso, con `process.env` manipulado y restaurado por test: los
 * escritores migrados resuelven POR LLAMADA, así que no hace falta recargar módulos.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PIPELINE_DIR = path.resolve(__dirname, '..');
const writeTarget = require('../lib/write-target');
const { withEnv } = require('../lib/test-helpers/with-env');

const VARS = ['PIPELINE_DIR_OVERRIDE', 'PIPELINE_STATE_DIR', 'PIPELINE_REPO_ROOT', 'PIPELINE_AMBIENTE',
    'CLAUDE_PROJECT_DIR', 'PLV_LOG_DIR', 'PLV_STATE_FILE', 'WDS_LOG_DIR', 'WDS_STATE_FILE'];

function mkTmp(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Corre `fn` con un env controlado (todas las VARS borradas salvo `cambios`) y lo
 * restaura pase lo que pase, vía el helper único de aislamiento (#6258/#6260).
 */
function conEnv(cambios, fn) {
    const vars = {};
    for (const v of VARS) vars[v] = undefined;
    Object.assign(vars, cambios);
    writeTarget._resetAvisos();
    try {
        // R0 de #7114: PIPELINE_AMBIENTE es variable de control (`cualquiera`);
        // borrarla es la posicion INERTE (default `pruebas`), declarada a proposito.
        return withEnv(vars, fn, {
            permitirApagarControl: ['PIPELINE_AMBIENTE'],
            motivo: 'el test borra PIPELINE_AMBIENTE para partir del default pruebas (sin declaracion): posicion inerte',
        });
    } finally {
        writeTarget._resetAvisos();
    }
}

/** Captura lo que se escribe a stderr durante `fn`. */
function capturandoStderr(fn) {
    const original = process.stderr.write;
    let out = '';
    process.stderr.write = (chunk) => { out += String(chunk); return true; };
    try {
        fn();
    } finally {
        process.stderr.write = original;
    }
    return out;
}

function archivosBajo(dir) {
    const out = [];
    const walk = (d) => {
        let entradas = [];
        try { entradas = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of entradas) {
            const abs = path.join(d, e.name);
            if (e.isDirectory()) walk(abs); else out.push(path.relative(dir, abs).replace(/\\/g, '/'));
        }
    };
    walk(dir);
    return out.sort();
}

/** Fixture: un "repo productivo" falso con su `.pipeline`, para medir que queda intacto. */
function fixtureProd() {
    const root = mkTmp('prod-7112-');
    fs.mkdirSync(path.join(root, '.pipeline', 'metrics'), { recursive: true });
    fs.mkdirSync(path.join(root, '.pipeline', 'logs'), { recursive: true });
    return root;
}

// ── (1) metrics/aggregator.js ──────────────────────────────────────────────

test('aggregator: sin dir de pruebas ni declaración, writeSnapshot falla ruidoso y no toca el productivo (CA-3/CA-5)', () => {
    const aggregator = require('../metrics/aggregator');
    const prod = fixtureProd();
    try {
        const antes = archivosBajo(path.join(prod, '.pipeline'));
        conEnv({ NODE_TEST_CONTEXT: '1', PIPELINE_REPO_ROOT: prod }, () => {
            const err = capturandoStderr(() => {
                assert.throws(() => aggregator.writeSnapshot({ totals: {} }), (e) => writeTarget.esBloqueo(e));
            });
            assert.match(err, /\[pipeline-env\] escritura bloqueada: canal=estado destino=metrics\/snapshot\.json/);
        });
        assert.deepStrictEqual(archivosBajo(path.join(prod, '.pipeline')), antes,
            'el .pipeline al que apunta PIPELINE_REPO_ROOT tiene que quedar intacto');
    } finally {
        fs.rmSync(prod, { recursive: true, force: true });
    }
});

test('aggregator: con PIPELINE_DIR_OVERRIDE (runner) escribe ahí; con opts.pipelineDir (dashboard) escribe donde le dicen', () => {
    const aggregator = require('../metrics/aggregator');
    const prod = fixtureProd();
    const efimero = mkTmp('efimero-7112-');
    const explicito = mkTmp('explicito-7112-');
    try {
        conEnv({ NODE_TEST_CONTEXT: '1', PIPELINE_REPO_ROOT: prod, PIPELINE_DIR_OVERRIDE: efimero }, () => {
            aggregator.writeSnapshot({ totals: { sessions: 1 } });
            aggregator.writeSnapshot({ totals: { sessions: 2 } }, 'snapshot-24h.json');
            aggregator.writeSnapshot({ totals: { sessions: 3 } }, null, { pipelineDir: explicito });
        });
        assert.deepStrictEqual(archivosBajo(efimero), ['metrics/snapshot-24h.json', 'metrics/snapshot.json']);
        assert.deepStrictEqual(archivosBajo(explicito), ['metrics/snapshot.json']);
        assert.deepStrictEqual(archivosBajo(path.join(prod, '.pipeline')), [], 'el productivo del fixture sigue vacío');
        assert.strictEqual(JSON.parse(fs.readFileSync(path.join(explicito, 'metrics', 'snapshot.json'), 'utf8')).totals.sessions, 3);
    } finally {
        for (const d of [prod, efimero, explicito]) fs.rmSync(d, { recursive: true, force: true });
    }
});

test('aggregator: --pipeline-dir viaja de la CLI a writeSnapshot y ya no exporta paths de módulo', () => {
    const src = fs.readFileSync(path.join(PIPELINE_DIR, 'metrics', 'aggregator.js'), 'utf8');
    assert.match(src, /'--pipeline-dir'/, 'parseArgs tiene que reconocer --pipeline-dir');
    assert.doesNotMatch(src, /const METRICS_DIR\s*=/, 'no puede quedar un METRICS_DIR de módulo');
    assert.doesNotMatch(src, /\bREPO_ROOT\b[^\n]*=\s*require\(/, 'el aggregator no importa REPO_ROOT de traceability');
});

test('dashboard-slices: el spawn del aggregator recibe --pipeline-dir con el PIPELINE del ctx', () => {
    const cp = require('child_process');
    const original = cp.spawn;
    const llamadas = [];
    cp.spawn = (cmd, args) => {
        llamadas.push(args);
        const { EventEmitter } = require('events');
        const fake = new EventEmitter();
        fake.unref = () => {};
        setImmediate(() => fake.emit('exit', 0));
        return fake;
    };
    const root = mkTmp('dash-7112-');
    try {
        const pipeline = path.join(root, '.pipeline');
        fs.mkdirSync(path.join(pipeline, 'metrics'), { recursive: true });
        delete require.cache[require.resolve('../lib/dashboard-slices')];
        const slices = require('../lib/dashboard-slices');
        // Sin snapshot-24h ni snapshot ⇒ intenta refrescar ambos: dos spawns.
        slices.kpisSlice({ issueMatrix: {} }, { ROOT: root, PIPELINE: pipeline, GH_BIN: path.join(root, 'no-gh') });
        assert.ok(llamadas.length >= 1, 'kpisSlice tiene que spawnear el aggregator');
        for (const args of llamadas) {
            const i = args.indexOf('--pipeline-dir');
            assert.ok(i >= 0, `falta --pipeline-dir en ${JSON.stringify(args)}`);
            assert.strictEqual(args[i + 1], pipeline);
        }
    } finally {
        cp.spawn = original;
        delete require.cache[require.resolve('../lib/dashboard-slices')];
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('dashboard-slices: con ctx sin PIPELINE absoluto (fixture PIPELINE vacío) NO spawnea el aggregator ni escribe <cwd>/metrics (derrame residual rev-2)', () => {
    // Reproduce lib/__tests__/dashboard-router-view.test.js:68 (`fakeCtx = { PIPELINE: '', ROOT: '' }`):
    // el path del snapshot quedaba relativo, pipelineDirArgs derivaba `--pipeline-dir .` y el hijo
    // escribía `<cwd>/metrics/snapshot*.json` (raíz del worktree/clon) — visto en HEAD 156b89220.
    const cp = require('child_process');
    const original = cp.spawn;
    const llamadas = [];
    cp.spawn = (cmd, args) => {
        llamadas.push(args);
        const { EventEmitter } = require('events');
        const fake = new EventEmitter();
        fake.unref = () => {};
        setImmediate(() => fake.emit('exit', 0));
        return fake;
    };
    const cwdMetrics = path.join(process.cwd(), 'metrics');
    const existiaAntes = fs.existsSync(cwdMetrics);
    try {
        delete require.cache[require.resolve('../lib/dashboard-slices')];
        const slices = require('../lib/dashboard-slices');
        for (const ctx of [
            { ROOT: '', PIPELINE: '', GH_BIN: 'no-gh' },
            { ROOT: undefined, PIPELINE: undefined, GH_BIN: 'no-gh' },
            { ROOT: 'rel', PIPELINE: 'rel/.pipeline', GH_BIN: 'no-gh' },
        ]) {
            slices.kpisSlice({ issueMatrix: {} }, ctx);
        }
        assert.deepStrictEqual(llamadas, [], 'sin PIPELINE absoluto no puede spawnear el aggregator');
        // pipelineDirArgs: sólo dirs absolutos; relativos/vacíos ⇒ [] (nada que pasar, nada que spawnear)
        assert.deepStrictEqual(slices.pipelineDirArgs('', 'metrics/snapshot-24h.json'), []);
        assert.deepStrictEqual(slices.pipelineDirArgs(undefined, 'metrics/snapshot.json'), []);
        assert.deepStrictEqual(slices.pipelineDirArgs('rel/.pipeline', 'rel/.pipeline/metrics/snapshot.json'), []);
        const abs = path.resolve(os.tmpdir(), 'abs-7112', '.pipeline');
        assert.deepStrictEqual(slices.pipelineDirArgs(abs, path.join(abs, 'metrics', 'snapshot.json')), ['--pipeline-dir', abs]);
        assert.deepStrictEqual(slices.pipelineDirArgs('', path.join(abs, 'metrics', 'snapshot.json')), ['--pipeline-dir', abs]);
        assert.strictEqual(fs.existsSync(cwdMetrics), existiaAntes, `no debe aparecer ${cwdMetrics}`);
    } finally {
        cp.spawn = original;
        delete require.cache[require.resolve('../lib/dashboard-slices')];
    }
});

// ── (2) quota-snapshot-scheduler.js ────────────────────────────────────────

test('quota-snapshot-scheduler: sin dir ni declaración no escribe log ni encola a Telegram; con override escribe en el dir de pruebas', () => {
    const scheduler = require('../quota-snapshot-scheduler');
    const prod = fixtureProd();
    const efimero = mkTmp('efimero-7112-');
    const libsLogs = path.join(PIPELINE_DIR, 'logs');
    const mtimeAntes = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return null; } };
    const logLibs = mtimeAntes(path.join(libsLogs, 'quota-snapshot.log'));
    try {
        conEnv({ NODE_TEST_CONTEXT: '1', PIPELINE_REPO_ROOT: prod }, () => {
            const err = capturandoStderr(() => {
                scheduler.enqueueTelegram('mensaje que NO debe salir');
            });
            assert.match(err, /\[pipeline-env\] escritura bloqueada: canal=colas destino=servicios\/telegram\/pendiente/);
        });
        assert.deepStrictEqual(archivosBajo(path.join(prod, '.pipeline')), [], 'nada en el productivo del fixture');
        assert.strictEqual(mtimeAntes(path.join(libsLogs, 'quota-snapshot.log')), logLibs,
            'el logs/ del .pipeline de las libs no se toca (era el derrame del alias __dirname)');

        conEnv({ NODE_TEST_CONTEXT: '1', PIPELINE_REPO_ROOT: prod, PIPELINE_DIR_OVERRIDE: efimero }, () => {
            scheduler.enqueueTelegram('mensaje de prueba');
        });
        const escritos = archivosBajo(efimero);
        assert.ok(escritos.some((f) => /^servicios\/telegram\/pendiente\/.*quota-snapshot\.json$/.test(f)),
            `la cola tiene que estar en el dir de pruebas: ${escritos.join(', ')}`);
        assert.deepStrictEqual(archivosBajo(path.join(prod, '.pipeline')), []);
    } finally {
        for (const d of [prod, efimero]) fs.rmSync(d, { recursive: true, force: true });
    }
});

// ── (3) smoke-test.js ──────────────────────────────────────────────────────

test('smoke-test: el log es safe — sin dir avisa por stderr y sigue por consola; con override escribe logs/smoke-test.log ahí', () => {
    const smoke = require('../smoke-test');
    const prod = fixtureProd();
    const efimero = mkTmp('efimero-7112-');
    const logLibs = path.join(PIPELINE_DIR, 'logs', 'smoke-test.log');
    const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return null; } };
    const antes = mtime(logLibs);
    const consola = console.log;
    let lineas = [];
    console.log = (l) => { lineas.push(String(l)); };
    try {
        conEnv({ NODE_TEST_CONTEXT: '1', PIPELINE_REPO_ROOT: prod }, () => {
            const err = capturandoStderr(() => smoke.log('linea de prueba sin dir'));
            assert.match(err, /\[pipeline-env\] escritura bloqueada: canal=logs destino=logs\/smoke-test\.log/);
        });
        assert.ok(lineas.some((l) => l.includes('linea de prueba sin dir')), 'el diagnóstico sigue saliendo por consola');
        assert.strictEqual(mtime(logLibs), antes, 'logs/smoke-test.log de las libs no se toca');
        assert.deepStrictEqual(archivosBajo(path.join(prod, '.pipeline')), []);

        conEnv({ NODE_TEST_CONTEXT: '1', PIPELINE_REPO_ROOT: prod, PIPELINE_DIR_OVERRIDE: efimero }, () => {
            smoke.log('linea con override');
        });
        assert.deepStrictEqual(archivosBajo(efimero), ['logs/smoke-test.log']);
        assert.match(fs.readFileSync(path.join(efimero, 'logs', 'smoke-test.log'), 'utf8'), /linea con override/);
    } finally {
        console.log = consola;
        for (const d of [prod, efimero]) fs.rmSync(d, { recursive: true, force: true });
    }
});

// ── (+) budget-config y build-log-staleness ────────────────────────────────

test('budget-config: writeBudget sin dir falla ruidoso; readBudget cae al default; con override escribe metrics/budget-config.json', () => {
    const budget = require('../metrics/budget-config');
    const prod = fixtureProd();
    const efimero = mkTmp('efimero-7112-');
    try {
        conEnv({ NODE_TEST_CONTEXT: '1', PIPELINE_REPO_ROOT: prod }, () => {
            capturandoStderr(() => {
                assert.throws(() => budget.writeBudget(150), (e) => writeTarget.esBloqueo(e));
                assert.strictEqual(budget.readBudget().source, 'default');
            });
        });
        assert.deepStrictEqual(archivosBajo(path.join(prod, '.pipeline')), []);
        conEnv({ NODE_TEST_CONTEXT: '1', PIPELINE_REPO_ROOT: prod, PIPELINE_DIR_OVERRIDE: efimero }, () => {
            budget.writeBudget(150);
            assert.strictEqual(budget.readBudget().monthly_usd, 150);
        });
        assert.deepStrictEqual(archivosBajo(efimero), ['metrics/budget-config.json']);
    } finally {
        for (const d of [prod, efimero]) fs.rmSync(d, { recursive: true, force: true });
    }
});

test('build-log-staleness: el audit por defecto va al dir resuelto; sin dir no escribe y el contador es 0', () => {
    const staleness = require('../build-log-staleness');
    const prod = fixtureProd();
    const efimero = mkTmp('efimero-7112-');
    try {
        conEnv({ NODE_TEST_CONTEXT: '1', PIPELINE_REPO_ROOT: prod }, () => {
            capturandoStderr(() => {
                staleness.appendAuditReset({ event: 'circuit_breaker_reset', reason: 'stale_log', issue: 7112 });
                assert.strictEqual(staleness.getStaleResetCount(7112), 0);
                assert.deepStrictEqual(staleness.inspectBuildLog(7112, 1000), { exists: false });
            });
        });
        assert.deepStrictEqual(archivosBajo(path.join(prod, '.pipeline')), []);
        conEnv({ NODE_TEST_CONTEXT: '1', PIPELINE_REPO_ROOT: prod, PIPELINE_DIR_OVERRIDE: efimero }, () => {
            staleness.appendAuditReset({ event: 'circuit_breaker_reset', reason: 'stale_log', issue: 7112 });
            assert.strictEqual(staleness.getStaleResetCount(7112), 1);
            assert.strictEqual(staleness.buildLogPathFor(7112), path.join(efimero, 'logs', 'build-7112.log'));
        });
        assert.deepStrictEqual(archivosBajo(efimero), ['logs/audit/circuit-breaker.jsonl']);
    } finally {
        for (const d of [prod, efimero]) fs.rmSync(d, { recursive: true, force: true });
    }
});

// ── Estructural: el escáner ve el alias y los módulos del rebote están migrados ──
// (la completitud/coherencia contra el JSON vive en lib/__tests__/write-points.test.js)

test('estructural: los módulos del rebote ya no resuelven por alias de __dirname ni por traceability.REPO_ROOT', () => {
    const scan = require('../lib/write-points-scan');
    const modulos = ['quota-snapshot-scheduler.js', 'smoke-test.js', 'rollback.js', 'build-log-staleness.js',
        'pulpo-liveness-run.js', 'watchdog-supervisor-run.js', 'metrics/aggregator.js', 'metrics/budget-config.js'];
    const problemas = [];
    for (const m of modulos) {
        const r = scan.escanearModulo(path.join(PIPELINE_DIR, m));
        assert.ok(r.escribe, `${m} tiene que seguir siendo un escritor`);
        assert.ok(r.puntos.length > 0, `${m}: el escáner tiene que ver al menos un punto (antes devolvía puntos: [])`);
        for (const p of r.puntos) {
            if (p.estado === 'pendiente') problemas.push(`${m}::${p.funcion} (L${p.linea}, ${p.via})`);
        }
    }
    assert.deepStrictEqual(problemas, [], `puntos sin migrar:\n  ${problemas.join('\n  ')}`);
});

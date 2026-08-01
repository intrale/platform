// =============================================================================
// config-failclosed-runners-5172.test.js — #5172 (rebote rev-1) · CASO G-3
//
// Verifica la separación que la receta del issue exige para los runners que
// corren en worktrees SIN node_modules:
//
//   - `MODULE_NOT_FOUND` (config-resolver no cargable)  => FAIL-SOFT a defaults.
//   - corrupción de config (ConfigParseViolation)       => FAIL-CLOSED.
//
// El rechazo de la fase `aprobacion` señaló que la separación estaba sólo en el
// TEXTO DEL LOG: ambas ramas caían al mismo `return {}`, así que un config
// corrupto reducía el umbral de kill del Pulpo de 180s (config.yaml) a 90s
// (default del módulo) — degradación en dirección DESTRUCTIVA.
//
// Por qué el harness copia el runner a un directorio temporal
// -----------------------------------------------------------
// Los runners fijan su raíz de config a `__dirname` A PROPÓSITO (no leen env):
// heredar `PIPELINE_REPO_ROOT` les movería la raíz del worktree al repo
// principal en silencio. Para no debilitar ese hardening con un override
// test-only, el test replica el runner en un tmpdir con su propio `config.yaml`
// y un `lib/` de shims que reexportan los módulos reales.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { seedProductManifest } = require('./_test-helpers');

const PIPELINE_DIR = path.join(__dirname, '..', '..');
const REAL_LIB = path.join(PIPELINE_DIR, 'lib');

const YAML_CORRUPTO = 'foo: [1, 2\n  bar: : :\n';

/**
 * Arma un directorio temporal que imita `.pipeline/` con:
 *   - una copia del runner,
 *   - el `config.yaml` indicado,
 *   - shims en `lib/` que reexportan los módulos reales por ruta absoluta.
 * `shims` mapea nombre de módulo => ruta real (o `null` para NO crear el shim,
 * que es como se simula `MODULE_NOT_FOUND`).
 */
function armarPipelineFalso(runnerRel, configYaml, shims) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p5172-'));
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });

    fs.copyFileSync(path.join(PIPELINE_DIR, runnerRel), path.join(dir, runnerRel));
    if (configYaml !== null) fs.writeFileSync(path.join(dir, 'config.yaml'), configYaml);
    seedProductManifest(dir);   // #5174 — la configuración vive partida: el otro lado también

    for (const [nombre, rutaReal] of Object.entries(shims)) {
        if (rutaReal === null) continue; // ausente a propósito => MODULE_NOT_FOUND
        fs.writeFileSync(
            path.join(dir, 'lib', `${nombre}.js`),
            `module.exports = require(${JSON.stringify(rutaReal)});\n`
        );
    }
    return dir;
}

function correr(dir, runnerRel, env) {
    // `process.execPath` en vez del literal 'node': el runner del tester spawnea
    // los tests en un contexto donde 'node' puede no estar en PATH.
    return execFileSync(process.execPath, [path.join(dir, runnerRel)], {
        env: Object.assign({}, process.env, env),
        encoding: 'utf8',
    }).trim();
}

// -----------------------------------------------------------------------------
// pulpo-liveness-run.js
// -----------------------------------------------------------------------------

const RUNNER_LIVENESS = 'pulpo-liveness-run.js';
const SHIMS_LIVENESS_COMPLETOS = {
    'pulpo-liveness': path.join(REAL_LIB, 'pulpo-liveness.js'),
    'config-resolver': path.join(REAL_LIB, 'config-resolver.js'),
};

// Zombi "obvio" para el default de 90s: 120s de lag con el PID cruzado. Está
// POR DEBAJO de los 180s que declara config.yaml, así que discrimina exactamente
// la degradación destructiva: con el default mata, con el umbral real no.
function hechosZombi(extra) {
    return Object.assign({
        PLV_HB_EXISTS: '1',
        PLV_HB_AGE_MS: String(120 * 1000),
        PLV_HB_CONTENT: '{"pid":34567,"timestamp":"2020-01-01T00:00:00.000Z"}',
        PLV_SO_PID: '34567',
        PLV_LOG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'p5172-log-')),
        PULPO_LIVENESS_KILL_SECONDS: '',
    }, extra || {});
}

test('liveness — config corrupta => FAIL-CLOSED: ACTION:skip (no mata con umbral degradado)', () => {
    const dir = armarPipelineFalso(RUNNER_LIVENESS, YAML_CORRUPTO, SHIMS_LIVENESS_COMPLETOS);
    const out = correr(dir, RUNNER_LIVENESS, hechosZombi());
    assert.strictEqual(out, 'ACTION:skip');
});

test('liveness — config-resolver ausente (MODULE_NOT_FOUND) => FAIL-SOFT a defaults: mata a los 90s', () => {
    // Mismo config corrupto, pero sin el resolver: la degradación a defaults es
    // legítima porque no hay evidencia de que la config difiera del default.
    const dir = armarPipelineFalso(RUNNER_LIVENESS, YAML_CORRUPTO, {
        'pulpo-liveness': path.join(REAL_LIB, 'pulpo-liveness.js'),
        'config-resolver': null,
    });
    const out = correr(dir, RUNNER_LIVENESS, hechosZombi());
    assert.strictEqual(out, 'ACTION:kill-respawn');
});

test('liveness — config corrupta + override explícito por env => se respeta el override (SEC-2)', () => {
    // El override NO viene del archivo corrupto: es un umbral confiable.
    const dir = armarPipelineFalso(RUNNER_LIVENESS, YAML_CORRUPTO, SHIMS_LIVENESS_COMPLETOS);
    const out = correr(dir, RUNNER_LIVENESS, hechosZombi({ PULPO_LIVENESS_KILL_SECONDS: '60' }));
    assert.strictEqual(out, 'ACTION:kill-respawn');
});

test('liveness — config corrupta + env basura => FAIL-CLOSED (un env inválido no rescata el default)', () => {
    const dir = armarPipelineFalso(RUNNER_LIVENESS, YAML_CORRUPTO, SHIMS_LIVENESS_COMPLETOS);
    const out = correr(dir, RUNNER_LIVENESS, hechosZombi({ PULPO_LIVENESS_KILL_SECONDS: 'abc' }));
    assert.strictEqual(out, 'ACTION:skip');
});

test('liveness — config SANA con umbral 180s => no mata a los 120s (control del test anterior)', () => {
    const dir = armarPipelineFalso(
        RUNNER_LIVENESS,
        'watchdog:\n  pulpo_liveness_kill_seconds: 180\n',
        SHIMS_LIVENESS_COMPLETOS
    );
    const out = correr(dir, RUNNER_LIVENESS, hechosZombi());
    assert.strictEqual(out, 'ACTION:skip');
});

// -----------------------------------------------------------------------------
// watchdog-supervisor-run.js
// -----------------------------------------------------------------------------

const RUNNER_SUP = 'watchdog-supervisor-run.js';
const SHIMS_SUP_COMPLETOS = {
    'watchdog-supervisor': path.join(REAL_LIB, 'watchdog-supervisor.js'),
    'config-resolver': path.join(REAL_LIB, 'config-resolver.js'),
    'notify-telegram': path.join(REAL_LIB, 'notify-telegram.js'),
};

// Heartbeat MUY viejo + tarea no viva: con cualquier umbral sano esto es
// 'relaunch'. Sirve para probar que el fail-closed lo suprime.
function hechosStale(dir) {
    return {
        WDS_HB_EXISTS: '1',
        WDS_HB_AGE_MS: String(60 * 60 * 1000),
        WDS_TASK_HEALTHY: '0',
        WDS_LOG_DIR: path.join(dir, 'logs'),
        WDS_STATE_FILE: path.join(dir, 'logs', 'estado.json'),
    };
}

test('supervisor — config corrupta => FAIL-CLOSED: ACTION:skip y NO se muta el estado', () => {
    const dir = armarPipelineFalso(RUNNER_SUP, YAML_CORRUPTO, SHIMS_SUP_COMPLETOS);
    const env = hechosStale(dir);
    const out = correr(dir, RUNNER_SUP, env);
    assert.strictEqual(out, 'ACTION:skip');
    assert.strictEqual(
        fs.existsSync(env.WDS_STATE_FILE),
        false,
        'el fail-closed no debe persistir estado de relanzamiento'
    );
});

test('supervisor — config-resolver ausente (MODULE_NOT_FOUND) => FAIL-SOFT a defaults: relanza', () => {
    const dir = armarPipelineFalso(RUNNER_SUP, YAML_CORRUPTO, {
        'watchdog-supervisor': path.join(REAL_LIB, 'watchdog-supervisor.js'),
        'config-resolver': null,
        'notify-telegram': path.join(REAL_LIB, 'notify-telegram.js'),
    });
    const out = correr(dir, RUNNER_SUP, hechosStale(dir));
    assert.strictEqual(out, 'ACTION:relaunch');
});

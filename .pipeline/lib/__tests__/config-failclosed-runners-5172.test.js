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
// corrupto reducía el umbral de kill del Pulpo al default del módulo —
// degradación en dirección DESTRUCTIVA.
//
// #5820 — Los umbrales de los fixtures se recalibraron: el valor vigente de
// config.yaml es 270s y el default del módulo se elevó a 270s para que perder
// el bloque `watchdog:` no degrade a un umbral MÁS agresivo que el vigente.
// Los fixtures ya no fijan 180s (el valor que causó el bucle de muerte del
// 2026-08-11) como ejemplo de "config sana".
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

// #5820 — Umbral vigente del pipeline: lo declara `watchdog.pulpo_liveness_kill_seconds`
// en config.yaml Y el `DEFAULT_KILL_SECONDS` del módulo, alineados a propósito
// para que perder el bloque de config no degrade a un umbral más agresivo.
const UMBRAL_VIGENTE_S = 270;

// Lag que vence el default: discrimina la degradación destructiva. Con los
// defaults aplicados mata; con el fail-closed activo NO mata.
const LAG_ZOMBI_MS = (UMBRAL_VIGENTE_S + 30) * 1000;

// Ciclo lento REAL de un Pulpo sano: 245s es el máximo `hbAgeMs` medido en
// .pipeline/logs/pulpo-liveness.log bajo el umbral de 270s (244993 ms), sin un
// solo kill. Debe resolver a skip: es el escenario que con 180s producía los
// 77 falsos positivos del 2026-08-11.
const LAG_CICLO_LENTO_MS = 245 * 1000;

function hechosZombi(extra) {
    return Object.assign({
        PLV_HB_EXISTS: '1',
        PLV_HB_AGE_MS: String(LAG_ZOMBI_MS),
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

test('liveness — config-resolver ausente (MODULE_NOT_FOUND) => FAIL-SOFT a defaults: mata al vencer el default', () => {
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

// #5820 — Gherkin "un ciclo lento del Pulpo no dispara un kill": con el umbral
// vigente (270s), un heartbeat de 245s de antigüedad es un Pulpo sano lento, no
// un zombi. Con el valor viejo (180s) esto era un kill: es el falso positivo que
// produjo 77 reinicios y dejó al Commander caído 4h el 2026-08-11.
test(`liveness — config SANA con el umbral vigente (${UMBRAL_VIGENTE_S}s) => ciclo lento de 245s NO se mata`, () => {
    const dir = armarPipelineFalso(
        RUNNER_LIVENESS,
        `watchdog:\n  pulpo_liveness_kill_seconds: ${UMBRAL_VIGENTE_S}\n`,
        SHIMS_LIVENESS_COMPLETOS
    );
    const out = correr(
        dir,
        RUNNER_LIVENESS,
        hechosZombi({ PLV_HB_AGE_MS: String(LAG_CICLO_LENTO_MS) })
    );
    assert.strictEqual(out, 'ACTION:skip');
});

// Control del fail-soft: prueba que el umbral SALE DE LA CONFIG y no del default.
// Con un valor de config mayor al default, un lag que vencería el default debe
// resolver a skip. Si el runner ignorara la config, acá mataría.
test('liveness — config SANA con umbral mayor al default => se aplica el de config, no el default', () => {
    const dir = armarPipelineFalso(
        RUNNER_LIVENESS,
        `watchdog:\n  pulpo_liveness_kill_seconds: ${UMBRAL_VIGENTE_S * 2}\n`,
        SHIMS_LIVENESS_COMPLETOS
    );
    const out = correr(dir, RUNNER_LIVENESS, hechosZombi());
    assert.strictEqual(out, 'ACTION:skip');
});

// #5820 — Gherkin "config sin el bloque watchdog no degrada a un umbral más
// agresivo". Sin la clave, el runner cae al DEFAULT_KILL_SECONDS del módulo; ese
// default está alineado con el umbral vigente, así que un ciclo lento de 245s
// sigue siendo skip. Con el default viejo (90s) esto era un kill instantáneo:
// perder el bloque de config dejaba el pipeline PEOR que el valor ya descartado.
test('liveness — config sin `pulpo_liveness_kill_seconds` => el default no es más agresivo que el vigente', () => {
    const { DEFAULT_KILL_SECONDS } = require(path.join(REAL_LIB, 'pulpo-liveness.js'));
    assert.ok(
        DEFAULT_KILL_SECONDS >= UMBRAL_VIGENTE_S,
        `el default del módulo (${DEFAULT_KILL_SECONDS}s) no puede ser menor que el umbral vigente (${UMBRAL_VIGENTE_S}s)`
    );

    const dir = armarPipelineFalso(
        RUNNER_LIVENESS,
        'watchdog:\n  stale_minutes: 6\n',
        SHIMS_LIVENESS_COMPLETOS
    );
    const out = correr(
        dir,
        RUNNER_LIVENESS,
        hechosZombi({ PLV_HB_AGE_MS: String(LAG_CICLO_LENTO_MS) })
    );
    assert.strictEqual(out, 'ACTION:skip');
});

// #5820 — Guarda de regresión contra el `reset --hard` del repo principal: el
// valor mitigado tiene que vivir COMMITEADO en config.yaml, no sólo en el
// working tree. Si alguien lo baja (o se pierde en un respawn), esto se pone
// rojo antes de que vuelva el bucle de muerte.
test('liveness — config.yaml real declara el umbral vigente y coincide con el default del módulo', () => {
    const configResolver = require(path.join(REAL_LIB, 'config-resolver.js'));
    const { DEFAULT_KILL_SECONDS } = require(path.join(REAL_LIB, 'pulpo-liveness.js'));
    const cfg = configResolver.resolve({ pipelineDir: PIPELINE_DIR });

    assert.strictEqual(cfg.watchdog.pulpo_liveness_kill_seconds, UMBRAL_VIGENTE_S);
    assert.strictEqual(DEFAULT_KILL_SECONDS, UMBRAL_VIGENTE_S);
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

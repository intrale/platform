// =============================================================================
// config-resolver-precedence.test.js — #5174 · CA-3 (Entrega C de #5111)
// =============================================================================
//
// La matriz de precedencia de la partición, ejercitada nivel por nivel:
//
//   | Categoría                   | Precedencia               |
//   |-----------------------------|---------------------------|
//   | Autoridad (lista congelada) | kernel gana SIEMPRE       |
//   | Calibración / política      | env > producto > kernel   |
//   | Mecanismo del kernel        | kernel                    |
//   | `PIPELINE_DIR_OVERRIDE`     | reubica AMBOS o ninguno   |
//
// El punto de estos tests es que la precedencia sea una propiedad VERIFICADA y
// no un comentario: cada fila de la tabla es un test que falla si el merge
// cambia de orden. La fila de autoridad se verifica en su archivo dedicado
// (`config-resolver-authority.test.js`), acá sólo se fija la mitad que ES un
// merge — la otra mitad es fail-closed, no precedencia.
//
// Hermético sobre tmpdir: ningún caso toca la configuración real del repo.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const resolver = require('../config-resolver');
const { seedProductManifest } = require('./_test-helpers');

// Config de kernel mínima y VÁLIDA: `pipelines` es lado kernel, pero
// `skills_por_fase` es lado producto, así que el fixture del kernel no la trae.
const KERNEL_BASE = [
    'circuit_breaker:',
    '  infra_escalate_threshold: 3',
    '  auto_resume_ok_threshold: 2',
    'pipelines:',
    '  desarrollo:',
    '    fases: [dev, build]',
    '',
].join('\n');

// El lado producto aporta el split declarado en `SIDE_MAP`.
const PRODUCTO_BASE = {
    pipelines: { desarrollo: { skills_por_fase: { dev: ['pipeline-dev'], build: ['builder'] } } },
};

const ENV_LIMPIO = ['PIPELINE_DIR_OVERRIDE', 'PIPELINE_STATE_DIR', 'PIPELINE_REPO_ROOT',
    'ADMISSION_SWEEP_ENABLED', 'ADMISSION_GATE_DRY_RUN'];
let guardado = {};

function mkTmp(nombre) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `cfgprec-${nombre}-`));
}

/**
 * Siembra los DOS lados en un sandbox.
 * @param {string} nombre
 * @param {{kernel?: string, producto?: object}} [opts]
 * @returns {string} el `pipelineDir` sembrado.
 */
function sembrar(nombre, { kernel = KERNEL_BASE, producto = PRODUCTO_BASE } = {}) {
    const dir = mkTmp(nombre);
    fs.writeFileSync(path.join(dir, 'config.yaml'), kernel, 'utf8');
    seedProductManifest(dir, producto);
    return dir;
}

test.beforeEach(() => {
    guardado = {};
    for (const k of ENV_LIMPIO) { guardado[k] = process.env[k]; delete process.env[k]; }
    resolver.clearCache();
    resolver._resetTraceState();
    resolver.setTraceSink(() => {});
});

test.afterEach(() => {
    for (const k of ENV_LIMPIO) {
        if (guardado[k] === undefined) delete process.env[k];
        else process.env[k] = guardado[k];
    }
    resolver.clearCache();
});

test.after(() => { resolver.setTraceSink(null); });

// -----------------------------------------------------------------------------
// 1 · Calibración — el merge une los dos lados sin perder ninguno
// -----------------------------------------------------------------------------

test('CA-3 · el merge une los dos lados: kernel aporta su mecanismo y producto su política', () => {
    const dir = sembrar('union');
    const cfg = resolver.resolve({ pipelineDir: dir });

    // Del kernel.
    assert.equal(cfg.circuit_breaker.infra_escalate_threshold, 3);
    assert.deepEqual(cfg.pipelines.desarrollo.fases, ['dev', 'build']);
    // Del producto, DENTRO de una sección de kernel (el split de `SIDE_MAP`).
    assert.deepEqual(cfg.pipelines.desarrollo.skills_por_fase.dev, ['pipeline-dev']);
});

test('CA-3 · una sección entera de producto llega íntegra a la config resuelta', () => {
    const dir = sembrar('seccion-producto', {
        producto: {
            ...PRODUCTO_BASE,
            dev_skill_mapping: { 'area:pipeline': 'pipeline-dev' },
            dev_routing_priority: ['area:pipeline', 'area:backend'],
        },
    });
    const cfg = resolver.resolve({ pipelineDir: dir });
    assert.deepEqual(cfg.dev_skill_mapping, { 'area:pipeline': 'pipeline-dev' });
    assert.deepEqual(cfg.dev_routing_priority, ['area:pipeline', 'area:backend']);
});

// -----------------------------------------------------------------------------
// 2 · `env > producto` — la punta de la cadena de calibración
// -----------------------------------------------------------------------------
//
// Hoy las dos únicas entradas de `ENV_OVERRIDES` apuntan a `admission_gate`
// (lado autoridad, grandfathered y enumeradas en código — ver
// `ENV_AUTHORITY_GRANDFATHERED`). No hay una entrada de lado producto contra la
// cual ejercitar `env > producto` con una clave real, así que se verifican las
// DOS mitades por separado: el comportamiento (env pisa al archivo) con las
// entradas que existen, y la REGLA (el canal de env es de calibración) sobre la
// propia tabla, que es lo que impide que la próxima entrada se agregue mal.

test('CA-3 · la env var de la allowlist pisa el valor del archivo', () => {
    const dir = sembrar('env-pisa', {
        kernel: KERNEL_BASE + 'admission_gate:\n  sweep_enabled: true\n  dry_run: false\n',
    });
    assert.equal(resolver.resolve({ pipelineDir: dir }).admission_gate.sweep_enabled, true,
        'sin env var manda el archivo');

    process.env.ADMISSION_SWEEP_ENABLED = '0';
    resolver.clearCache();
    assert.equal(resolver.resolve({ pipelineDir: dir }).admission_gate.sweep_enabled, false,
        'con env var, el entorno le gana al archivo');
});

test('CA-10 · el canal de override por entorno es de CALIBRACIÓN: nada nuevo puede apuntar a autoridad', () => {
    // Se afirma sobre la tabla, no sobre el entorno: una entrada nueva mal
    // clasificada rompe acá y no espera a que alguien setee la variable en prod.
    const { resolveSide } = require('../config-schema');
    for (const o of resolver.ENV_OVERRIDES) {
        const dotted = o.path.join('.');
        const lado = resolveSide(dotted);
        if (lado === 'producto') continue;
        assert.ok(resolver.ENV_AUTHORITY_GRANDFATHERED.includes(o.env),
            `'${o.env}' apunta a '${dotted}' (lado '${lado}') sin estar en la excepción enumerada. `
            + 'El override por entorno es de calibración: o es lado producto, o se justifica explícito.');
    }
});

test('CA-10 · la excepción de autoridad es ACOTADA y enumerada, no un patrón', () => {
    // Si esta lista crece sin decisión explícita, la regla de arriba se vuelve
    // decorativa: cualquier entrada nueva se "justificaría" agregándose acá.
    assert.deepEqual(resolver.ENV_AUTHORITY_GRANDFATHERED.slice().sort(),
        ['ADMISSION_GATE_DRY_RUN', 'ADMISSION_SWEEP_ENABLED']);
});

// -----------------------------------------------------------------------------
// 3 · `PIPELINE_DIR_OVERRIDE` reubica AMBOS o ninguno
// -----------------------------------------------------------------------------

test('CA-3 · DIR_OVERRIDE reubica los DOS archivos por el mismo mecanismo', () => {
    const dir = sembrar('override-ambos');
    process.env.PIPELINE_DIR_OVERRIDE = dir;

    const rutas = resolver.resolveConfigPaths({});
    assert.equal(rutas.kernel.file, path.join(dir, 'config.yaml'));
    assert.equal(rutas.product.file, path.join(dir, 'pipeline.config.json'));
    assert.equal(rutas.kernel.via, rutas.product.via,
        'un solo `via`: los dos lados se reubican por el MISMO mecanismo o por ninguno');

    // Y el efecto es real: se lee el sandbox, no la configuración del repo.
    assert.equal(resolver.resolve({}).circuit_breaker.infra_escalate_threshold, 3);
});

test('CA-3 · reubicación PARCIAL (kernel movido, producto ausente) ⇒ falla el arranque', () => {
    // El modo de fallo que la regla previene: el kernel viene de un tmpdir y el
    // producto se quedaría en producción. Acá el manifiesto directamente no
    // existe en la raíz reubicada, que es la forma observable de "movieron uno
    // solo": tiene que ser corrupción TOTAL, nunca un merge con el lado viejo.
    const dir = mkTmp('override-parcial');
    fs.writeFileSync(path.join(dir, 'config.yaml'), KERNEL_BASE, 'utf8');
    process.env.PIPELINE_DIR_OVERRIDE = dir;

    assert.throws(() => resolver.resolve({}), (e) => {
        assert.ok(resolver.isConfigViolation(e), `esperaba violación tipada, salió ${e && e.name}`);
        assert.equal(e.archivo, path.join(dir, 'pipeline.config.json'),
            'el error tiene que nombrar CUÁL de los dos archivos falló');
        return true;
    });
});

test('CA-3 · el manifiesto NUNCA se toma de la raíz del repo cuando el kernel fue reubicado', () => {
    // Refuerzo del anterior: aunque exista un manifiesto válido en la raíz real,
    // una raíz reubicada sin manifiesto propio NO puede caer a él. Si cayera, el
    // pipeline correría con el mecanismo de un tmpdir y la política de producción.
    const dir = mkTmp('sin-fallback');
    fs.writeFileSync(path.join(dir, 'config.yaml'), KERNEL_BASE, 'utf8');
    const rutas = resolver.resolveConfigPaths({ pipelineDir: dir });
    assert.equal(path.dirname(rutas.product.file), dir,
        'el manifiesto se deriva de la raíz reubicada, no de la del repo');
    assert.throws(() => resolver.resolve({ pipelineDir: dir }), (e) => resolver.isConfigViolation(e));
});

// -----------------------------------------------------------------------------
// 4 · Mecanismo del kernel — el lado producto no puede aportarlo
// -----------------------------------------------------------------------------

test('CA-4 · una clave de MECANISMO puesta del lado producto falla el arranque', () => {
    // `circuit_breaker` es autoridad y `pipelines` es kernel: ninguna de las dos
    // puede venir del manifiesto. Se usa `pipelines.desarrollo.fases`, que es
    // kernel puro (el split declarado es `skills_por_fase`, no `fases`).
    const dir = sembrar('mecanismo-en-producto', {
        producto: { ...PRODUCTO_BASE, pipelines: { desarrollo: { fases: ['dev'] } } },
    });
    assert.throws(() => resolver.resolve({ pipelineDir: dir }), (e) => {
        assert.ok(resolver.isConfigViolation(e));
        assert.match(String(e.message), /fases/, 'debe nombrar la clave que está del lado equivocado');
        return true;
    });
});

// =============================================================================
// config-partition-rollback.test.js — #5174 · CA-12 (Entrega C de #5111)
// =============================================================================
//
// El CA pide que la partición sea "revertible en minutos volviendo al archivo
// único, **ejercitado por test**". El énfasis es del issue y apunta a un modo de
// fallo concreto: un rollback DECLARADO ("basta con poner el flag en false") que
// nadie corrió nunca es exactamente igual de útil que no tener rollback, y se
// descubre durante el incidente.
//
// Acá el rollback se EJERCITA: se resuelve una configuración monolítica con la
// partición apagada (`partition: false`, el equivalente por firma de poner
// `PARTITION_ENABLED = false`) y se verifica que:
//
//   1. el documento resuelto es el mismo que daba el resolver de #5172,
//   2. NO se lee el manifiesto de producto (ni siquiera se lo exige),
//   3. NO corre el chequeo de lado — un monolito tiene los dos lados juntos y
//      bajo la regla de la partición sería una violación en cada clave,
//   4. y —el punto que el CA subraya— **no se reintroducen defaults permisivos**
//      por las claves que post-partición viven sólo del lado producto.
//
// El punto 4 es el que hace que este archivo valga: el riesgo del rollback no es
// que explote, es que ande "a medias" y el ruteo degrade en silencio.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const resolver = require('../config-resolver');
const { SIDE_MAP } = require('../config-schema');
const { seedProductManifest } = require('./_test-helpers');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// Monolito pre-partición sintético: los dos lados juntos en un solo YAML, que es
// exactamente la forma a la que vuelve el rollback.
const MONOLITO = [
    'circuit_breaker:',
    '  infra_escalate_threshold: 3',
    '  auto_resume_ok_threshold: 2',
    'pipelines:',
    '  desarrollo:',
    '    fases: [dev, build]',
    '    skills_por_fase:',        // ← lado producto, dentro de una sección kernel
    '      dev: [pipeline-dev]',
    '      build: [builder]',
    'dev_skill_mapping:',          // ← lado producto, sección entera
    '  area:pipeline: pipeline-dev',
    'dev_routing_priority: [area:pipeline]',
    'pipeline_scope_keywords: [pipeline]',
    '',
].join('\n');

const ENV_LIMPIO = ['PIPELINE_DIR_OVERRIDE', 'PIPELINE_STATE_DIR', 'PIPELINE_REPO_ROOT'];
let guardado = {};

function mkTmp(nombre) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `cfgroll-${nombre}-`));
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
// 1 · El rollback resuelve el monolito, sin manifiesto
// -----------------------------------------------------------------------------

test('CA-12 · con la partición apagada, un monolito resuelve SIN manifiesto de producto', () => {
    const dir = mkTmp('monolito');
    fs.writeFileSync(path.join(dir, 'config.yaml'), MONOLITO, 'utf8');
    // A propósito NO se siembra `pipeline.config.json`: el estado al que vuelve
    // el rollback es "el manifiesto ni siquiera existe".
    assert.equal(fs.existsSync(path.join(dir, 'pipeline.config.json')), false);

    const cfg = resolver.resolve({ pipelineDir: dir, partition: false });

    assert.equal(cfg.circuit_breaker.infra_escalate_threshold, 3);
    assert.deepEqual(cfg.pipelines.desarrollo.skills_por_fase.dev, ['pipeline-dev']);
    assert.deepEqual(cfg.dev_skill_mapping, { 'area:pipeline': 'pipeline-dev' });
    assert.deepEqual(cfg.dev_routing_priority, ['area:pipeline']);
});

test('CA-12 · el MISMO monolito CON la partición encendida falla (el test no es vacuo)', () => {
    // Sin este contraste, el test de arriba pasaría aunque `partition:false` no
    // hiciera nada: hay que ver que el flag es lo que cambia el comportamiento.
    const dir = mkTmp('monolito-particion-on');
    fs.writeFileSync(path.join(dir, 'config.yaml'), MONOLITO, 'utf8');

    assert.throws(() => resolver.resolve({ pipelineDir: dir }),
        (e) => resolver.isConfigViolation(e),
        'con la partición encendida, un monolito sin manifiesto es corrupción total');
});

test('CA-12 · el rollback NO corre el chequeo de lado: el monolito mezcla los dos lados', () => {
    // `dev_skill_mapping` (producto) y `circuit_breaker` (autoridad) conviven en
    // el mismo archivo. Con la partición encendida eso es una violación de lado;
    // apagada tiene que ser, otra vez, la configuración normal del pipeline.
    const dir = mkTmp('sin-checkside');
    fs.writeFileSync(path.join(dir, 'config.yaml'), MONOLITO, 'utf8');
    seedProductManifest(dir, {});   // manifiesto presente pero VACÍO

    const cfg = resolver.resolve({ pipelineDir: dir, partition: false });
    assert.ok(cfg.dev_skill_mapping, 'la clave de producto sigue viniendo del monolito');
    assert.ok(cfg.circuit_breaker, 'y la de autoridad también');
});

test('CA-12 · con la partición apagada el manifiesto se IGNORA, no se mergea', () => {
    // Si el rollback siguiera mergeando, volver al archivo único no sería un
    // rollback: quedaría un estado híbrido que nadie diseñó ni probó.
    const dir = mkTmp('ignora-manifiesto');
    fs.writeFileSync(path.join(dir, 'config.yaml'), MONOLITO, 'utf8');
    seedProductManifest(dir, { dev_routing_priority: ['DEL-MANIFIESTO'] });

    const cfg = resolver.resolve({ pipelineDir: dir, partition: false });
    assert.deepEqual(cfg.dev_routing_priority, ['area:pipeline'],
        'manda el monolito; el manifiesto no aporta nada con la partición apagada');
});

// -----------------------------------------------------------------------------
// 2 · Sin defaults permisivos reintroducidos
// -----------------------------------------------------------------------------

test('CA-12 · el rollback NO reintroduce defaults permisivos para las claves de producto', () => {
    // El riesgo que el CA nombra: al volver al archivo único, las claves que hoy
    // viven sólo del lado producto podrían quedar ausentes y los consumidores
    // caerían a `|| {}` / `|| []`, degradando el ruteo EN SILENCIO.
    //
    // La garantía real no es que el resolver invente valores: es que un monolito
    // SIN esas claves no resuelve callado. `pipelines.*.skills_por_fase` es
    // `required` en el schema, así que su ausencia rompe el arranque.
    const dir = mkTmp('sin-defaults');
    fs.writeFileSync(path.join(dir, 'config.yaml'), [
        'circuit_breaker:',
        '  infra_escalate_threshold: 3',
        '  auto_resume_ok_threshold: 2',
        'pipelines:',
        '  desarrollo:',
        '    fases: [dev]',        // ← falta `skills_por_fase`
        '',
    ].join('\n'), 'utf8');

    assert.throws(
        () => resolver.resolve({ pipelineDir: dir, partition: false }),
        (e) => {
            assert.ok(resolver.isConfigViolation(e));
            assert.match(String(e.message), /skills_por_fase/,
                'la clave ausente se nombra: sin eso el operador no sabe qué le falta');
            return true;
        },
        'una clave de producto ausente tras el rollback tiene que ROMPER, no defaultear',
    );
});

test('CA-12 · el rollback no afloja el fail-closed: un monolito corrupto sigue siendo corrupción', () => {
    const dir = mkTmp('corrupto');
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'pipelines: [[[\n  roto: : :\n', 'utf8');

    assert.throws(() => resolver.resolve({ pipelineDir: dir, partition: false }),
        (e) => resolver.isConfigViolation(e));
});

test('CA-12 · el rollback no reabre el canal genérico de env (CA-10 sigue vigente)', () => {
    const dir = mkTmp('env-prohibida');
    fs.writeFileSync(path.join(dir, 'config.yaml'), MONOLITO, 'utf8');
    process.env.PIPELINE_CFG_FIRMA_OPERADOR__ENABLED = 'false';
    try {
        assert.throws(() => resolver.resolve({ pipelineDir: dir, partition: false }),
            (e) => resolver.isConfigViolation(e),
            'apagar la partición no puede reabrir la inyección de config por entorno');
    } finally {
        delete process.env.PIPELINE_CFG_FIRMA_OPERADOR__ENABLED;
    }
});

// -----------------------------------------------------------------------------
// 3 · El rollback es de UNA línea y está documentado dónde
// -----------------------------------------------------------------------------

test('CA-12 · `PARTITION_ENABLED` existe, está en true y es el único interruptor', () => {
    // Si el flag desapareciera o se volviera un cálculo, el rollback dejaría de
    // ser "una línea" y este archivo estaría probando un camino muerto.
    assert.equal(resolver.PARTITION_ENABLED, true,
        'en operación normal la partición está ENCENDIDA');

    const fuente = fs.readFileSync(path.join(REPO_ROOT, '.pipeline', 'lib', 'config-resolver.js'), 'utf8');
    assert.match(fuente, /^const PARTITION_ENABLED = true;$/m,
        'el interruptor tiene que seguir siendo una constante literal de una línea');
});

test('CA-12 · revertir el movimiento de claves basta: el monolito rearmado valida', () => {
    // La otra mitad del rollback: además del flag, hay que devolver las claves al
    // `config.yaml`. Se rearma el monolito desde los DOS archivos REALES del repo
    // y se verifica que resuelve válido con la partición apagada — o sea que el
    // `git revert` del movimiento deja un archivo que el pipeline sabe leer.
    const yaml = require('js-yaml');
    const kernel = yaml.load(fs.readFileSync(path.join(REPO_ROOT, '.pipeline', 'config.yaml'), 'utf8'));
    const producto = JSON.parse(
        fs.readFileSync(path.join(REPO_ROOT, resolver.PRODUCT_FILENAME), 'utf8'),
    )[resolver.PRODUCT_CONFIG_KEY];

    const dir = mkTmp('rearmado');
    fs.writeFileSync(path.join(dir, 'config.yaml'), yaml.dump(mergeProfundo(kernel, producto)), 'utf8');

    const cfg = resolver.resolve({ pipelineDir: dir, partition: false });

    // Y las claves que se habían mudado están de vuelta, con su forma real.
    assert.ok(cfg.dev_skill_mapping && Object.keys(cfg.dev_skill_mapping).length > 0);
    assert.ok(Array.isArray(cfg.dev_routing_priority) && cfg.dev_routing_priority.length > 0);
    assert.ok(cfg.pipelines.desarrollo.skills_por_fase, 'el split volvió a su sección');
    for (const [prefijo, lado] of Object.entries(SIDE_MAP)) {
        if (lado !== 'producto' || prefijo.includes('*') || prefijo.includes('.')) continue;
        assert.ok(prefijo in cfg, `la sección de producto '${prefijo}' debe volver al monolito`);
    }
});

function esMapa(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function mergeProfundo(a, b) {
    const out = { ...a };
    for (const k of Object.keys(b || {})) {
        out[k] = esMapa(a[k]) && esMapa(b[k]) ? mergeProfundo(a[k], b[k]) : b[k];
    }
    return out;
}

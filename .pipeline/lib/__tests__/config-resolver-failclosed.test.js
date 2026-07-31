// =============================================================================
// config-resolver-failclosed.test.js — #5172 · CA-4 / CA-5 / CA-6
// =============================================================================
//
// Fija el contrato central de la historia: `resolve()` devuelve configuración
// válida **o lanza el error tipado**. Nunca degrada a un objeto casi vacío, que
// es lo que hoy hace que "no pude leer la config" se vea como "el gate está
// apagado" (los defaults del codebase son apagados por diseño de rollout).
//
// Hermético sobre tmpdir: ningún caso toca el `config.yaml` real.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const resolver = require('../config-resolver');
const { classify } = require('../error-classifier');

const CONFIG_SANO = [
    'circuit_breaker:',
    '  infra_escalate_threshold: 3',
    '  auto_resume_ok_threshold: 2',
    'pipelines:',
    '  desarrollo:',
    '    fases: [dev, build]',
    '    skills_por_fase:',
    '      dev: [pipeline-dev]',
    '      build: [builder]',
    '',
].join('\n');

function mkTmp(nombre) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cfgres-${nombre}-`));
    return dir;
}

function escribir(dir, contenido) {
    fs.writeFileSync(path.join(dir, 'config.yaml'), contenido, 'utf8');
    return path.join(dir, 'config.yaml');
}

test.beforeEach(() => {
    resolver.clearCache();
    resolver._resetTraceState();
    resolver.setTraceSink(() => {});
});

test.after(() => {
    resolver.setTraceSink(null);
});

test('config sano: resolve() devuelve el documento validado', () => {
    const dir = mkTmp('sano');
    escribir(dir, CONFIG_SANO);
    const cfg = resolver.resolve({ pipelineDir: dir });
    assert.equal(cfg.circuit_breaker.infra_escalate_threshold, 3);
    assert.deepEqual(cfg.pipelines.desarrollo.fases, ['dev', 'build']);
});

test('archivo ausente: lanza ConfigParseViolation con causa ENOENT, no degrada a {}', () => {
    const dir = mkTmp('ausente');
    let capturado = null;
    try {
        resolver.resolve({ pipelineDir: dir });
    } catch (e) {
        capturado = e;
    }
    assert.ok(capturado, 'debe lanzar, NUNCA devolver un objeto vacío');
    assert.equal(capturado.name, 'ConfigParseViolation');
    assert.equal(capturado.causa, 'ENOENT');
    assert.equal(capturado.archivo, path.join(dir, 'config.yaml'));
    // El error NO lleva `code`: `error-classifier` mira `code` antes que `name`
    // y 'ENOENT' está en TRANSIENT_CODES → lo degradaría a 'transient'.
    assert.equal(capturado.code, undefined);
});

test('YAML corrupto: lanza ConfigParseViolation con línea y columna', () => {
    const dir = mkTmp('corrupto');
    escribir(dir, 'gate:\n  a: 1\n   mal_indentado: x\n');
    assert.throws(
        () => resolver.resolve({ pipelineDir: dir }),
        (e) => {
            assert.equal(e.name, 'ConfigParseViolation');
            assert.equal(e.causa, 'yaml-invalido');
            assert.equal(typeof e.linea, 'number');
            assert.equal(typeof e.columna, 'number');
            return true;
        },
    );
});

test('archivo vacío: lanza en vez de devolver null/{}', () => {
    const dir = mkTmp('vacio');
    escribir(dir, '');
    assert.throws(
        () => resolver.resolve({ pipelineDir: dir }),
        (e) => e.name === 'ConfigParseViolation' && e.causa === 'empty-or-not-a-map',
    );
});

test('archivo a medio escribir (sólo un comentario): lanza empty-or-not-a-map', () => {
    const dir = mkTmp('amedias');
    escribir(dir, '# se cortó el guardado\n');
    assert.throws(
        () => resolver.resolve({ pipelineDir: dir }),
        (e) => e.name === 'ConfigParseViolation' && e.causa === 'empty-or-not-a-map',
    );
});

test('raíz que no es mapa (lista): lanza empty-or-not-a-map', () => {
    const dir = mkTmp('lista');
    escribir(dir, '- uno\n- dos\n');
    assert.throws(
        () => resolver.resolve({ pipelineDir: dir }),
        (e) => e.name === 'ConfigParseViolation' && e.causa === 'empty-or-not-a-map',
    );
});

test('la ruta resuelve a un directorio: lanza not-a-file (CA-12)', () => {
    const dir = mkTmp('esdir');
    fs.mkdirSync(path.join(dir, 'config.yaml'));
    assert.throws(
        () => resolver.resolve({ pipelineDir: dir }),
        (e) => e.name === 'ConfigParseViolation' && e.causa === 'not-a-file',
    );
});

test('violación de schema: lanza ConfigSchemaViolation con errores redactados', () => {
    const dir = mkTmp('schema');
    // `infra_escalate_threshold` como string viola el tipo declarado.
    escribir(dir, 'circuit_breaker:\n  infra_escalate_threshold: "tres"\n  auto_resume_ok_threshold: 2\n');
    assert.throws(
        () => resolver.resolve({ pipelineDir: dir }),
        (e) => {
            assert.equal(e.name, 'ConfigSchemaViolation');
            assert.ok(Array.isArray(e.errors) && e.errors.length > 0);
            return true;
        },
    );
});

test('D-G: ambos errores tipados se clasifican como corruption', () => {
    const dirA = mkTmp('clasif-a');
    const dirB = mkTmp('clasif-b');
    escribir(dirB, 'circuit_breaker:\n  infra_escalate_threshold: "x"\n  auto_resume_ok_threshold: 1\n');

    let parseErr = null;
    try { resolver.resolve({ pipelineDir: dirA }); } catch (e) { parseErr = e; }
    let schemaErr = null;
    try { resolver.resolve({ pipelineDir: dirB }); } catch (e) { schemaErr = e; }

    assert.equal(classify(parseErr), 'corruption', 'ConfigParseViolation debe ser corruption');
    assert.equal(classify(schemaErr), 'corruption', 'ConfigSchemaViolation debe ser corruption');
});

test('CA-6: sección `kernel:` ausente en config SANO no es error (durable:false sobrevive)', () => {
    const dir = mkTmp('sinkernel');
    escribir(dir, CONFIG_SANO);
    const cfg = resolver.resolve({ pipelineDir: dir });
    assert.equal(cfg.kernel, undefined, 'sección opcional ausente ⇒ undefined, no throw');
    // Lo que se elimina es el `catch` que convierte FALLO DE LECTURA en default,
    // no el default de SECCIÓN AUSENTE (D-4).
    const durable = !!(cfg.kernel && cfg.kernel.durable);
    assert.equal(durable, false);
});

test('CA-4: resolve() no retiene lastGood ni ejecuta haltOnConfigCorruption', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'config-resolver.js'), 'utf8');
    // Se busca en el CÓDIGO, no en los comentarios: el módulo documenta por qué
    // esa política vive en el llamador, y esa mención es legítima.
    const codigo = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((l) => !/^\s*\/\//.test(l))
        .join('\n');
    assert.equal(/lastGood/.test(codigo), false, 'el resolver NO retiene last-good (SEC-2)');
    assert.equal(/haltOnConfig/.test(codigo), false, 'el resolver NO pausa el pipeline (CA-4)');
    assert.equal(/\.paused/.test(codigo), false, 'el resolver NO escribe el marker de pausa');
});

test('RIESGO BAJO #4832: reload:true re-lee tras corregir el archivo', () => {
    const dir = mkTmp('recovery');
    escribir(dir, 'circuit_breaker:\n  a: 1\n   roto: x\n');
    assert.throws(() => resolver.resolve({ pipelineDir: dir }), (e) => e.name === 'ConfigParseViolation');

    // El operador corrige el archivo. Sin `reload` el caché no interfiere (no se
    // cacheó nada porque lanzó), pero el contrato del hot-reload del pulpo es
    // explícito: `{reload:true}` siempre vuelve al disco.
    escribir(dir, CONFIG_SANO);
    const cfg = resolver.resolve({ pipelineDir: dir, reload: true });
    assert.equal(cfg.circuit_breaker.infra_escalate_threshold, 3);
});

test('el caché no sirve una config vieja cuando se pide reload', () => {
    const dir = mkTmp('cache');
    escribir(dir, CONFIG_SANO);
    assert.equal(resolver.resolve({ pipelineDir: dir }).circuit_breaker.infra_escalate_threshold, 3);

    escribir(dir, CONFIG_SANO.replace('infra_escalate_threshold: 3', 'infra_escalate_threshold: 9'));
    assert.equal(
        resolver.resolve({ pipelineDir: dir }).circuit_breaker.infra_escalate_threshold, 3,
        'sin reload sirve el caché (comportamiento declarado en D-2)',
    );
    assert.equal(
        resolver.resolve({ pipelineDir: dir, reload: true }).circuit_breaker.infra_escalate_threshold, 9,
        'con reload vuelve al disco — sin esto el auto-recovery de #4832 no levantaría la pausa',
    );
});

test('cada llamador recibe su propia copia (paridad CA-18: antes cada lector parseaba el suyo)', () => {
    const dir = mkTmp('copia');
    escribir(dir, CONFIG_SANO);
    const a = resolver.resolve({ pipelineDir: dir });
    const b = resolver.resolve({ pipelineDir: dir });
    assert.notEqual(a, b, 'no comparten referencia');
    a.pipelines.desarrollo.fases.push('contaminado');
    assert.deepEqual(
        resolver.resolve({ pipelineDir: dir }).pipelines.desarrollo.fases, ['dev', 'build'],
        'una mutación local en un módulo no puede verse en otro',
    );
});

test('resolveForDiff: no lanza y devuelve el documento aunque viole el schema actual', () => {
    // Un baseline viejo puede violar el schema de HOY y eso NO es corrupción del
    // runtime — es justo lo que la comparación por revisión quiere ver (D-B).
    const r = resolver.resolveForDiff('circuit_breaker:\n  infra_escalate_threshold: "tres"\n  auto_resume_ok_threshold: 1\n');
    assert.equal(r.valid, false);
    assert.ok(r.config, 'devuelve el documento igual, para poder diffear');
    assert.equal(r.config.circuit_breaker.infra_escalate_threshold, 'tres');
    assert.ok(r.errors.length > 0);
});

test('resolveForDiff: YAML inválido devuelve valid:false sin lanzar', () => {
    const r = resolver.resolveForDiff('a:\n b: 1\n  c: 2\n');
    assert.equal(r.valid, false);
    assert.equal(r.config, null);
    assert.ok(/YAML inválido/.test(r.errors[0].detail));
});

test('resolveForDiff: texto vacío o nulo no lanza', () => {
    assert.equal(resolver.resolveForDiff('').valid, false);
    assert.equal(resolver.resolveForDiff(null).valid, false);
    assert.equal(resolver.resolveForDiff(undefined).valid, false);
});

test('resolveForDiff no cachea ni trazea (no contamina el camino de enforcement)', () => {
    resolver._resetTraceState();
    resolver.resolveForDiff(CONFIG_SANO);
    assert.deepEqual(resolver.getTraces(), [], 'la comparación por revisión no emite traza de resolución');
});

// -----------------------------------------------------------------------------
// #5172 — Cierre de cobertura del módulo (CA: mínimo 90%; es código de gate).
// -----------------------------------------------------------------------------

test('resolveForDiff: YAML válido que NO es un mapa (escalar o lista) no es comparable', () => {
    // Un baseline que quedó como lista o escalar parsea bien pero no es una
    // configuración: tiene que dar `valid:false` explícito y NO lanzar, igual
    // que el resto del camino de comparación por revisión.
    for (const texto of ['42\n', '- a\n- b\n', 'sólo un string\n']) {
        const r = resolver.resolveForDiff(texto);
        assert.equal(r.valid, false, `"${texto.trim()}" no puede considerarse config válida`);
        assert.equal(r.config, null);
        assert.equal(r.errors[0].keyword, 'shape');
    }
});

test('el sink de traza por default escribe en stderr y NUNCA en stdout', () => {
    // stdout es la superficie de DATOS de los CLIs del pipeline
    // (`planner-waves-cli` sirve JSON por ahí). Si la traza de resolución se
    // colara por stdout, corrompería la salida que otro proceso parsea.
    resolver._resetTraceState();
    const cfgPath = escribir(mkTmp('sink-default'), CONFIG_SANO);
    resolver.setTraceSink(null); // restaura el sink por default

    const errEscrito = [];
    const outEscrito = [];
    const origErr = process.stderr.write;
    const origOut = process.stdout.write;
    process.stderr.write = (chunk) => { errEscrito.push(String(chunk)); return true; };
    process.stdout.write = (chunk) => { outEscrito.push(String(chunk)); return true; };
    try {
        resolver.clearCache();
        resolver.resolve({ configPath: cfgPath });
    } finally {
        process.stderr.write = origErr;
        process.stdout.write = origOut;
        resolver.setTraceSink(() => {}); // silencia el resto de la suite
    }

    assert.ok(errEscrito.some((l) => /config resuelta/.test(l)), 'la traza debe salir por stderr');
    assert.equal(outEscrito.length, 0, 'la traza JAMÁS debe contaminar stdout');
});

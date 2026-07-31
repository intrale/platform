// =============================================================================
// config-resolver-root.test.js — #5172 · CA-10 / CA-11 / CA-12 / CA-13
// =============================================================================
//
// Fija la regla de raíz de D-1 nivel por nivel. Importa que esté fijada por test
// y no sólo documentada: un orden de precedencia mal elegido NO rompe
// ruidosamente — hace que un tmpdir incompleto **apague gates en silencio**
// dentro de un test, porque los defaults del codebase son apagados por diseño.
//
//   1. opts.configPath  2. opts.pipelineDir  3. PIPELINE_DIR_OVERRIDE
//   4. PIPELINE_STATE_DIR  5. PIPELINE_REPO_ROOT + /.pipeline  6. default
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const resolver = require('../config-resolver');

const ENV_KEYS = ['PIPELINE_DIR_OVERRIDE', 'PIPELINE_STATE_DIR', 'PIPELINE_REPO_ROOT'];
const saved = {};

function limpiarEnv() {
    for (const k of ENV_KEYS) {
        saved[k] = process.env[k];
        delete process.env[k];
    }
}

function restaurarEnv() {
    for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    }
}

function mkTmp(nombre) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `cfgroot-${nombre}-`));
}

test.beforeEach(() => {
    resolver.clearCache();
    resolver._resetTraceState();
    resolver.setTraceSink(() => {});
    limpiarEnv();
});

test.afterEach(() => {
    restaurarEnv();
});

test.after(() => {
    resolver.setTraceSink(null);
});

test('D-1 · los 6 niveles resuelven en orden, cada uno ganándole a todos los de abajo', () => {
    const dirArg = mkTmp('arg');
    const dirOverride = mkTmp('override');
    const dirState = mkTmp('state');
    const repoRoot = mkTmp('repo');
    fs.mkdirSync(path.join(repoRoot, '.pipeline'));

    process.env.PIPELINE_DIR_OVERRIDE = dirOverride;
    process.env.PIPELINE_STATE_DIR = dirState;
    process.env.PIPELINE_REPO_ROOT = repoRoot;

    // Nivel 1 — arg:configPath le gana a TODO (y puede ser ruta de archivo:
    // es código, no entorno, así que CA-12 no aplica).
    const archivoSuelto = path.join(dirArg, 'otro-nombre.yaml');
    assert.deepEqual(
        resolver.resolveConfigPath({ configPath: archivoSuelto, pipelineDir: dirArg }),
        { file: archivoSuelto, via: 'arg:configPath', dir: dirArg },
    );

    // Nivel 2 — arg:pipelineDir le gana a las tres env vars (D-E: ~40 tests y 5
    // módulos de producción inyectan por firma).
    assert.deepEqual(
        resolver.resolveConfigPath({ pipelineDir: dirArg }),
        { file: path.join(dirArg, 'config.yaml'), via: 'arg:pipelineDir', dir: dirArg },
    );

    // Nivel 3 — DIR_OVERRIDE
    assert.deepEqual(resolver.resolveConfigPath({}), {
        file: path.join(dirOverride, 'config.yaml'), via: 'DIR_OVERRIDE', dir: dirOverride,
    });

    // Nivel 4 — STATE_DIR
    delete process.env.PIPELINE_DIR_OVERRIDE;
    assert.deepEqual(resolver.resolveConfigPath({}), {
        file: path.join(dirState, 'config.yaml'), via: 'STATE_DIR', dir: dirState,
    });

    // Nivel 5 — REPO_ROOT + /.pipeline
    delete process.env.PIPELINE_STATE_DIR;
    assert.deepEqual(resolver.resolveConfigPath({}), {
        file: path.join(repoRoot, '.pipeline', 'config.yaml'),
        via: 'REPO_ROOT',
        dir: path.join(repoRoot, '.pipeline'),
    });

    // Nivel 6 — la `.pipeline/` de este checkout.
    delete process.env.PIPELINE_REPO_ROOT;
    const esperado = path.resolve(__dirname, '..', '..');
    assert.deepEqual(resolver.resolveConfigPath({}), {
        file: path.join(esperado, 'config.yaml'), via: 'default', dir: esperado,
    });
});

test('CA-12 · la env var aporta DIRECTORIO: apuntarla a un .yaml arbitrario no lo vuelve la autoridad', () => {
    const dir = mkTmp('ca12');
    const yamlArbitrario = path.join(dir, 'cualquiera.yaml');
    fs.writeFileSync(yamlArbitrario, 'circuit_breaker:\n  infra_escalate_threshold: 99\n  auto_resume_ok_threshold: 1\n');

    process.env.PIPELINE_STATE_DIR = yamlArbitrario;
    const r = resolver.resolveConfigPath({});
    assert.equal(r.file, path.join(yamlArbitrario, 'config.yaml'),
        'el resolver SIEMPRE compone raiz/config.yaml — el nombre del archivo no lo pone el entorno');
    // Y como esa ruta no es un archivo regular, falla ruidosamente.
    assert.throws(() => resolver.resolve({}), (e) => e.name === 'ConfigParseViolation');
});

test('CA-12 · env apuntando a un directorio inexistente ⇒ error, no default silencioso', () => {
    process.env.PIPELINE_DIR_OVERRIDE = path.join(os.tmpdir(), 'no-existe-jamas-5172');
    assert.throws(
        () => resolver.resolve({}),
        (e) => e.name === 'ConfigParseViolation' && e.causa === 'ENOENT',
        'un override roto NO puede caer al config de producción por la ventana',
    );
});

test('CA-11 · aislamiento: con DIR_OVERRIDE a un tmpdir se lee el tmpdir, nunca el config real', () => {
    const dir = mkTmp('aislado');
    fs.writeFileSync(path.join(dir, 'config.yaml'),
        'circuit_breaker:\n  infra_escalate_threshold: 42\n  auto_resume_ok_threshold: 7\n');
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    const cfg = resolver.resolve({});
    assert.equal(cfg.circuit_breaker.infra_escalate_threshold, 42);
    assert.equal(cfg.pipelines, undefined, 'no se mezcló con el config.yaml de producción');
});

test('CA-11 · lo mismo con STATE_DIR (los 9 tests que lo usan siguen aislados)', () => {
    const dir = mkTmp('aislado-state');
    fs.writeFileSync(path.join(dir, 'config.yaml'),
        'circuit_breaker:\n  infra_escalate_threshold: 11\n  auto_resume_ok_threshold: 1\n');
    process.env.PIPELINE_STATE_DIR = dir;
    assert.equal(resolver.resolve({}).circuit_breaker.infra_escalate_threshold, 11);
});

test('CA-13 · la traza se emite UNA sola vez por proceso y nombra ruta + mecanismo', () => {
    const dir = mkTmp('traza');
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'concurrencia:\n  dev: 3\n');
    const lineas = [];
    resolver.setTraceSink((l) => lineas.push(l));

    resolver.resolve({ pipelineDir: dir });
    resolver.resolve({ pipelineDir: dir });
    resolver.resolve({ pipelineDir: dir, reload: true });

    const trazas = lineas.filter((l) => l.includes('config resuelta'));
    assert.equal(trazas.length, 1, 'tres resoluciones, una sola traza');
    assert.ok(trazas[0].includes(path.join(dir, 'config.yaml')), 'la traza nombra la ruta resuelta');
    assert.ok(trazas[0].includes('vía arg:pipelineDir'), 'y el mecanismo por el que se resolvió');
});

test('CA-13 · el mecanismo trazado es el correcto para cada nivel', () => {
    const casos = [
        { setup: (d) => ({ opts: { pipelineDir: d }, via: 'arg:pipelineDir' }) },
        { setup: (d) => { process.env.PIPELINE_DIR_OVERRIDE = d; return { opts: {}, via: 'DIR_OVERRIDE' }; } },
        { setup: (d) => { process.env.PIPELINE_STATE_DIR = d; return { opts: {}, via: 'STATE_DIR' }; } },
    ];
    for (const caso of casos) {
        limpiarEnv();
        resolver.clearCache();
        resolver._resetTraceState();
        const dir = mkTmp('mec');
        fs.writeFileSync(path.join(dir, 'config.yaml'), 'concurrencia:\n  dev: 1\n');
        const lineas = [];
        resolver.setTraceSink((l) => lineas.push(l));
        const { opts, via } = caso.setup(dir);
        resolver.resolve(opts);
        assert.ok(lineas.some((l) => l.includes(`vía ${via}`)), `esperaba traza con vía ${via}`);
        restaurarEnv();
    }
});

test('dos raíces distintas en el mismo proceso trazan una vez cada una', () => {
    const a = mkTmp('doble-a');
    const b = mkTmp('doble-b');
    fs.writeFileSync(path.join(a, 'config.yaml'), 'concurrencia:\n  dev: 1\n');
    fs.writeFileSync(path.join(b, 'config.yaml'), 'concurrencia:\n  dev: 2\n');
    const lineas = [];
    resolver.setTraceSink((l) => lineas.push(l));
    resolver.resolve({ pipelineDir: a });
    resolver.resolve({ pipelineDir: b });
    resolver.resolve({ pipelineDir: a });
    assert.equal(lineas.filter((l) => l.includes('config resuelta')).length, 2);
});

test('el caché es por ruta resuelta: dos raíces no se pisan entre sí', () => {
    const a = mkTmp('cache-a');
    const b = mkTmp('cache-b');
    fs.writeFileSync(path.join(a, 'config.yaml'), 'concurrencia:\n  dev: 1\n');
    fs.writeFileSync(path.join(b, 'config.yaml'), 'concurrencia:\n  dev: 2\n');
    assert.equal(resolver.resolve({ pipelineDir: a }).concurrencia.dev, 1);
    assert.equal(resolver.resolve({ pipelineDir: b }).concurrencia.dev, 2);
    assert.equal(resolver.resolve({ pipelineDir: a }).concurrencia.dev, 1);
});

test('formatConfigPath: relativa si está dentro del repo, absoluta si está afuera', () => {
    const { formatConfigPath } = require('../config-schema');
    assert.equal(formatConfigPath(path.join('C:', 'repo', '.pipeline', 'config.yaml'), path.join('C:', 'repo')),
        '.pipeline/config.yaml');
    const afuera = path.join(os.tmpdir(), 'x', 'config.yaml');
    assert.equal(formatConfigPath(afuera, path.join('C:', 'repo')), afuera);
});

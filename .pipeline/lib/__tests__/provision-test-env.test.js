'use strict';

// #7111 — tests del provisionador del ambiente de pruebas
// (`lib/provision-test-env.js` + `scripts/provision-test-env.js`).
//
// REGLAS:
// - Root por test vía `mkdtempSync` bajo `os.tmpdir()`; JAMÁS el root default
//   (`<tmp>/intrale-pipeline-pruebas`) — puede ser el ambiente vivo del operador.
// - El `env` se pasa como objeto literal; NUNCA se asigna `process.env`
//   (guardrail `test-env-lint`, #6260). La lib recibe `env`, `fs`, `os` y
//   `execFileSync` por parámetro, así que no hay nada que setear ni restaurar.
// - Contra el `.pipeline` REAL sólo hay LECTURA (`provision` lo usa de origen)
//   y llamadas que deben RECHAZAR sin tocar nada (`destroy({root: prod})`).
//   Los tests que snapshotean un "productivo" usan un productivo de FIXTURE.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const yaml = require('js-yaml');

const lib = require('../provision-test-env');
const cli = require('../../scripts/provision-test-env');
const pipelineEnv = require('../pipeline-env');
const configResolver = require('../config-resolver');
const { seedRepoRootConfig } = require('./_test-helpers');

const {
    provision, destroy, verifyIsolation, resolveRoot, layoutFor, snapshotTree,
    SUBESTADOS, SERVICIOS, SERVICIO_SUBESTADOS, DIRS_FIJOS, COPY_ALLOWLIST, ENV_STRIP,
    MARKER_FILENAME, PRODUCT_FILENAME, CONFIG_OVERLAY, AbortError,
} = lib;
const { DEFAULT_PRODUCTIVE_DIR } = pipelineEnv;

const ES_WINDOWS = process.platform === 'win32';
const REPO_ROOT = path.dirname(DEFAULT_PRODUCTIVE_DIR);
const LIB_SRC = path.join(__dirname, '..', 'provision-test-env.js');
const CLI_SRC = path.join(__dirname, '..', '..', 'scripts', 'provision-test-env.js');
const PULPO_SRC = path.join(DEFAULT_PRODUCTIVE_DIR, 'pulpo.js');

/** `execFileSync` falso: determinístico, sin git (el marcador queda con `sha: null`). */
const sinGit = () => { throw new Error('sin git en el fixture'); };
const DEPS_SIN_GIT = { execFileSync: sinGit };

/** Directorio temporal REAL (canónico, sin 8.3), fuera del repo. */
function tmpDir(tag) {
    return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `provision-7111-${tag}-`)));
}

function existe(p) {
    try { fs.lstatSync(p); return true; } catch { return false; }
}

function esLink(p) {
    return fs.lstatSync(p).isSymbolicLink();
}

function leerJson(p) {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/**
 * Productivo de FIXTURE: `<repo>/.pipeline/config.yaml` + `pipeline.config.json`
 * vía `seedRepoRootConfig` (aborta si cae dentro del repo), más lo que un
 * `.pipeline` real tiene y NO debe copiarse (logs, state, sesiones) y lo que sí
 * (template, roles, descriptors, agent-models).
 */
function crearProductivoFixture(tag, extraConfig = {}) {
    const repo = tmpDir(`prod-${tag}`);
    seedRepoRootConfig(repo, {
        pipelines: {
            definicion: { fases: ['analisis', 'criterios'] },
            desarrollo: { fases: ['dev', 'build'] },
        },
        operational_state: { durable: true },
        kernel: { durable: true },
        vault: { enabled: true, prefix: '/intrale' },
        ...extraConfig,
    });
    const pd = path.join(repo, '.pipeline');
    const escribir = (rel, contenido) => {
        const abs = path.join(pd, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, contenido);
    };
    escribir('waves.json.template', '{"version":"1.0","waves":[]}\n');
    escribir('agent-models.json', '{"agents":{}}\n');
    escribir('agent-models.schema.json', '{"type":"object"}\n');
    escribir('roles/_base.md', '# base\n');
    escribir('roles/dev.md', '# dev\n');
    escribir('roles/sub/anidado.md', '# anidado\n');
    escribir('descriptors/intrale-platform.json', '{"id":"intrale-platform"}\n');
    // Lo que NO se copia (SEC-P4):
    escribir('logs/x.log', 'secreto de transcript\n');
    escribir('state/y.json', '{"estado":"vivo"}\n');
    escribir('commander-session.json', '{"session":"abc"}\n');
    escribir('.paused', '');
    escribir('waves.json', '{"version":"1.0","waves":[{"id":1}]}\n');
    return { repo, pipelineDir: pd };
}

/** stdout/stderr capturados para `cli.main` (sin spawn). */
function io(env = {}) {
    const o = { out: '', err: '', env };
    o.stdout = { write: (s) => { o.out += s; } };
    o.stderr = { write: (s) => { o.err += s; } };
    return o;
}

/** Short-path 8.3 vía COM (sólo Windows); `null` si no hay forma corta. */
function shortPath(p) {
    try {
        const out = execFileSync('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-Command',
            `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${p.replace(/'/g, "''")}').ShortPath`,
        ], { encoding: 'utf8', windowsHide: true, timeout: 20000 }).trim();
        return out && out.toLowerCase() !== p.toLowerCase() ? out : null;
    } catch {
        return null;
    }
}

function fuenteSinComentarios(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// ─── CA-1 / CA-2 · estructura completa ───────────────────────────────────────

test('provision crea la estructura completa derivada de config.yaml', () => {
    const base = tmpDir('completa');
    const root = path.join(base, 'env');
    const r = provision({ env: {}, root });

    assert.strictEqual(r.root, root);
    assert.strictEqual(r.pipelineDir, path.join(root, '.pipeline'));
    assert.strictEqual(r.manifestPath, path.join(root, PRODUCT_FILENAME));
    assert.strictEqual(r.marker, path.join(root, '.pipeline', MARKER_FILENAME));
    assert.strictEqual(r.yaExistia, false);
    assert.strictEqual(r.creados[0], '.', 'el root recién creado se reporta como "."');
    assert.strictEqual(r.omitidos.length, 0, `orígenes ausentes: ${r.omitidos}`);
    assert.ok(r.creados.length > 100, `creados: ${r.creados.length}`);
    assert.ok(path.isAbsolute(r.root));
    // G-9 / CA-1: nunca 8.3 en la salida.
    assert.ok(!/~\d/.test(JSON.stringify(r)), 'salida sin forma 8.3');

    const pd = r.pipelineDir;
    const config = yaml.load(fs.readFileSync(path.join(pd, 'config.yaml'), 'utf8'));
    const layout = layoutFor(config);
    // config.yaml real: 10 fases × 9 subestados = 90; 5 servicios × 5 = 25.
    assert.strictEqual(layout.fases.length, 90);
    assert.strictEqual(layout.servicios.length, 25);
    assert.strictEqual(r.colas, 115);
    for (const rel of [...layout.fases, ...layout.servicios, ...layout.fijos]) {
        const abs = path.join(pd, rel);
        assert.ok(existe(abs) && fs.lstatSync(abs).isDirectory(), `falta dir ${rel}`);
    }
    for (const rel of ['logs', 'state', 'rejections', 'metrics', 'audit', 'events', 'locks']) {
        assert.deepStrictEqual(fs.readdirSync(path.join(pd, rel)).filter((n) => n !== 'project-bindings'), [], `${rel}/ debe estar vacío`);
    }
    for (const rel of ['config.yaml', 'waves.json', 'waves.json.template', '.partial-pause.json',
        'agent-models.json', 'agent-models.schema.json', MARKER_FILENAME,
        path.join('descriptors', 'intrale-platform.json'), path.join('roles', '_base.md')]) {
        assert.ok(existe(path.join(pd, rel)), `falta ${rel}`);
    }
    assert.ok(existe(r.manifestPath), 'manifiesto en el PADRE');
    assert.ok(fs.readFileSync(r.manifestPath).equals(fs.readFileSync(path.join(REPO_ROOT, PRODUCT_FILENAME))), 'manifiesto byte-idéntico');
    assert.ok(fs.readFileSync(path.join(pd, 'waves.json.template')).equals(fs.readFileSync(path.join(DEFAULT_PRODUCTIVE_DIR, 'waves.json.template'))));
    assert.ok(fs.readFileSync(path.join(pd, 'waves.json')).equals(fs.readFileSync(path.join(pd, 'waves.json.template'))), 'waves.json sembrado desde el template');
    assert.ok(!existe(path.join(pd, '.paused')), '.paused ausente');
    assert.deepStrictEqual(leerJson(path.join(pd, '.partial-pause.json')), { allowed_issues: [], source: 'provision-test-env' });
    const marcador = leerJson(r.marker);
    assert.strictEqual(marcador.modo, 'pruebas');
    assert.strictEqual(marcador.provisionerVersion, lib.PROVISIONER_VERSION);
    assert.strictEqual(marcador.origen.repoRoot, REPO_ROOT);
    assert.deepStrictEqual(Object.keys(marcador), ['modo', 'provisionerVersion', 'origen']);
    // roles/ copiado completo.
    assert.deepStrictEqual(fs.readdirSync(path.join(pd, 'roles')).sort(), fs.readdirSync(path.join(DEFAULT_PRODUCTIVE_DIR, 'roles')).sort());
    assert.strictEqual(r.productivo, fs.realpathSync.native(DEFAULT_PRODUCTIVE_DIR));

    // `.gitkeep` ni archivos generados dentro del checkout.
    assert.ok(!existe(path.join(DEFAULT_PRODUCTIVE_DIR, MARKER_FILENAME)));
    fs.rmSync(base, { recursive: true, force: true });
});

test('provision con os.tmpdir() en forma 8.3 devuelve un root canónico', { skip: !ES_WINDOWS || !/~\d/.test(os.tmpdir()) }, () => {
    // El default del provisionador es `<tmpdir real>/intrale-pipeline-pruebas`;
    // acá se prueba el mismo camino con un `--root` en forma corta.
    const base = tmpDir('corto');
    const rootCorto = path.join(os.tmpdir(), path.basename(base), 'env');
    assert.ok(/~\d/.test(rootCorto));
    const r = provision({ env: {}, root: rootCorto }, DEPS_SIN_GIT);
    assert.strictEqual(r.root, path.join(base, 'env'));
    assert.ok(!/~\d/.test(JSON.stringify(r)));
    fs.rmSync(base, { recursive: true, force: true });
});

test('layoutFor cubre los subestados y servicios literales de pulpo.js', () => {
    const src = fs.readFileSync(PULPO_SRC, 'utf8');
    const extraer = (re) => {
        const encontrados = new Set();
        let m;
        let matches = 0;
        while ((m = re.exec(src)) !== null) {
            matches++;
            for (const item of m[1].split(',')) {
                const v = item.trim().replace(/^['"]|['"]$/g, '');
                if (v) encontrados.add(v);
            }
        }
        assert.ok(matches > 0, `no se encontró el literal ${re} en pulpo.js: actualizar el test y SUBESTADOS/SERVICIOS`);
        return [...encontrados];
    };
    const estados = extraer(/for \(const estado of \[([^\]]*)\]\)/g);
    const svcs = extraer(/for \(const svc of \[([^\]]*)\]\)/g);
    assert.ok(estados.length >= 7, `estados literales: ${estados}`);
    for (const e of estados) assert.ok(SUBESTADOS.includes(e), `pulpo.js itera el subestado '${e}' que layoutFor no crea`);
    for (const s of svcs) assert.ok(SERVICIOS.includes(s), `pulpo.js itera el servicio '${s}' que layoutFor no crea`);
    assert.ok(SUBESTADOS.includes('procesado') && SUBESTADOS.includes('archivado'));
    assert.ok(SERVICIOS.includes('emulador'));
    assert.strictEqual(SERVICIO_SUBESTADOS.length, 5);

    // Derivación pura de config.yaml.
    const l = layoutFor({ pipelines: { a: { fases: ['f1', 'f2'] }, b: { fases: ['g'] }, c: null } });
    assert.strictEqual(l.fases.length, 3 * SUBESTADOS.length);
    assert.ok(l.fases.includes(path.join('a', 'f1', 'pendiente')));
    assert.strictEqual(l.servicios.length, SERVICIOS.length * SERVICIO_SUBESTADOS.length);
    assert.deepStrictEqual(l.fijos, [...DIRS_FIJOS]);
    assert.deepStrictEqual(layoutFor(null).fases, []);
    assert.deepStrictEqual(layoutFor({ pipelines: { x: {} } }).fases, []);
});

// ─── CA-3 · reproducible e idempotente ───────────────────────────────────────

test('dos provisiones consecutivas producen la misma estructura', () => {
    const base = tmpDir('idem');
    const root = path.join(base, 'env');
    const r1 = provision({ env: {}, root });
    const snap1 = snapshotTree(root).map(({ rel, tipo, size }) => ({ rel, tipo, size }));
    const bytes1 = ['config.yaml', MARKER_FILENAME].map((f) => fs.readFileSync(path.join(r1.pipelineDir, f)));
    const manif1 = fs.readFileSync(r1.manifestPath);

    // El estado operativo NO se pisa: se modifica waves.json entre corridas.
    const wavesAbs = path.join(r1.pipelineDir, 'waves.json');
    fs.writeFileSync(wavesAbs, '{"version":"1.0","modificado":true}\n');
    const partialAbs = path.join(r1.pipelineDir, '.partial-pause.json');
    fs.writeFileSync(partialAbs, '{"allowed_issues":[7111],"source":"test"}\n');

    const r2 = provision({ env: {}, root });
    assert.strictEqual(r2.yaExistia, true);
    assert.deepStrictEqual(r2.creados, [], 'segunda corrida sin creados');
    assert.deepStrictEqual(r2.root, r1.root);
    const snap2 = snapshotTree(root).map(({ rel, tipo, size }) => ({ rel, tipo, size }));
    // Misma estructura salvo los dos archivos de estado que el test modificó.
    const sinEstado = (s) => s.filter((e) => !/waves\.json$|\.partial-pause\.json$/.test(e.rel));
    assert.deepStrictEqual(sinEstado(snap2), sinEstado(snap1));
    assert.deepStrictEqual(snap2.map((e) => e.rel), snap1.map((e) => e.rel));
    const bytes2 = ['config.yaml', MARKER_FILENAME].map((f) => fs.readFileSync(path.join(r2.pipelineDir, f)));
    assert.ok(bytes1[0].equals(bytes2[0]), 'config.yaml byte-idéntico');
    assert.ok(bytes1[1].equals(bytes2[1]), 'marcador byte-idéntico');
    assert.ok(manif1.equals(fs.readFileSync(r2.manifestPath)), 'manifiesto byte-idéntico');
    assert.strictEqual(fs.readFileSync(wavesAbs, 'utf8'), '{"version":"1.0","modificado":true}\n', 'waves.json no se pisa');
    assert.strictEqual(fs.readFileSync(partialAbs, 'utf8'), '{"allowed_issues":[7111],"source":"test"}\n', '.partial-pause.json no se pisa');
    assert.ok(!existe(path.join(r2.pipelineDir, '.paused')));

    // Si alguien deja un `.paused`, la corrida idempotente lo saca (halt total nunca activo en pruebas).
    fs.writeFileSync(path.join(r2.pipelineDir, '.paused'), '');
    provision({ env: {}, root });
    assert.ok(!existe(path.join(r2.pipelineDir, '.paused')));
    fs.rmSync(base, { recursive: true, force: true });
});

test('provision con fresh recrea el ambiente sin residuo', () => {
    const base = tmpDir('fresh');
    const root = path.join(base, 'env');
    const r1 = provision({ env: {}, root }, DEPS_SIN_GIT);
    const basura = path.join(r1.pipelineDir, 'desarrollo', 'dev', 'pendiente', 'basura.yaml');
    fs.writeFileSync(basura, 'issue: 1\n');
    fs.writeFileSync(path.join(r1.pipelineDir, 'waves.json'), '{"sucio":true}\n');

    const r2 = provision({ env: {}, root, fresh: true }, DEPS_SIN_GIT);
    assert.strictEqual(r2.yaExistia, true, 'existía antes del fresh');
    assert.ok(!existe(basura), 'la basura desaparece');
    assert.ok(r2.creados.length > 100, 'todo se volvió a crear');
    assert.ok(fs.readFileSync(path.join(r2.pipelineDir, 'waves.json')).equals(fs.readFileSync(path.join(r2.pipelineDir, 'waves.json.template'))), 'waves.json vuelve al template');

    // fresh sobre un root que no existe: provisiona normal.
    const root2 = path.join(base, 'env2');
    const r3 = provision({ env: {}, root: root2, fresh: true }, DEPS_SIN_GIT);
    assert.strictEqual(r3.yaExistia, false);
    assert.ok(existe(r3.marker));

    // fresh sobre un root SIN marcador → aborta (reusa el fail-closed de destroy).
    const root3 = path.join(base, 'env3');
    fs.mkdirSync(path.join(root3, '.pipeline'), { recursive: true });
    fs.writeFileSync(path.join(root3, 'ajeno.txt'), 'no me borres');
    assert.throws(() => provision({ env: {}, root: root3, fresh: true }, DEPS_SIN_GIT), (e) => e instanceof AbortError && /marcador/.test(e.message));
    assert.strictEqual(fs.readFileSync(path.join(root3, 'ajeno.txt'), 'utf8'), 'no me borres');
    fs.rmSync(base, { recursive: true, force: true });
});

// ─── CA-4 · descartable sin tocar el productivo ──────────────────────────────

test('destroy borra el root entero y el productivo de fixture queda sin cambios', () => {
    const { repo, pipelineDir: prodFx } = crearProductivoFixture('destroy');
    const base = tmpDir('destroy');
    const root = path.join(base, 'env');
    const antes = snapshotTree(repo);
    assert.ok(antes.length > 10);

    const r = provision({ env: {}, root, repoRoot: repo }, DEPS_SIN_GIT);
    assert.strictEqual(r.colas, 4 * SUBESTADOS.length + SERVICIOS.length * SERVICIO_SUBESTADOS.length);
    assert.strictEqual(leerJson(r.marker).origen.sha, null);
    assert.strictEqual(leerJson(r.marker).origen.repoRoot, repo);
    const v = verifyIsolation({ root, productivo: prodFx });
    assert.strictEqual(v.ok, true, JSON.stringify(v));

    const d = destroy({ root });
    assert.deepStrictEqual(d, { ok: true, root, existia: true, borrado: true, residuo: [] });
    assert.strictEqual(existe(root), false);
    assert.deepStrictEqual(snapshotTree(repo), antes, 'productivo de fixture idéntico (rel+size+mtimeMs)');

    // destroy de nuevo: no había ambiente → ok, sin tocar nada.
    assert.deepStrictEqual(destroy({ root }), { ok: true, root, existia: false, borrado: false, residuo: [] });
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
});

// ─── SEC-P1 · destroy fail-closed ────────────────────────────────────────────

test('destroy rechaza un root sin marcador', () => {
    const base = tmpDir('sinmarcador');
    const root = path.join(base, 'ajeno');
    fs.mkdirSync(path.join(root, '.pipeline'), { recursive: true });
    fs.writeFileSync(path.join(root, 'valioso.txt'), 'x');
    const d = destroy({ root });
    assert.strictEqual(d.ok, false);
    assert.strictEqual(d.borrado, false);
    assert.match(d.motivo, /no tiene marcador de ambiente de pruebas; no se borra nada/);
    assert.ok(existe(path.join(root, 'valioso.txt')));

    // Marcador presente pero con otro modo → tampoco.
    fs.writeFileSync(path.join(root, '.pipeline', MARKER_FILENAME), JSON.stringify({ modo: 'productivo' }));
    assert.strictEqual(destroy({ root }).ok, false);
    // Marcador corrupto → tampoco.
    fs.writeFileSync(path.join(root, '.pipeline', MARKER_FILENAME), '{no es json');
    assert.strictEqual(destroy({ root }).ok, false);
    fs.writeFileSync(path.join(root, '.pipeline', MARKER_FILENAME), '"texto"');
    assert.strictEqual(destroy({ root }).ok, false);
    assert.ok(existe(path.join(root, 'valioso.txt')));
    fs.rmSync(base, { recursive: true, force: true });
});

test('destroy rechaza el productivo y el repo', () => {
    const marcadorProd = path.join(DEFAULT_PRODUCTIVE_DIR, MARKER_FILENAME);
    assert.ok(!existe(marcadorProd), 'precondición: el productivo no tiene marcador');
    for (const root of [DEFAULT_PRODUCTIVE_DIR, REPO_ROOT, path.join(DEFAULT_PRODUCTIVE_DIR, 'lib')]) {
        const d = destroy({ root });
        assert.strictEqual(d.ok, false, root);
        assert.strictEqual(d.borrado, false, root);
        assert.match(d.motivo, /cae dentro de (productivo|repo)/);
        assert.ok(existe(path.join(DEFAULT_PRODUCTIVE_DIR, 'pulpo.js')), 'el productivo sigue ahí');
    }
    // Un root que CONTIENE al repo (ancestro) tampoco.
    const d = destroy({ root: path.dirname(REPO_ROOT) });
    assert.strictEqual(d.ok, false);
    assert.match(d.motivo, /cae dentro de (productivo|repo|home|raíz)/);
});

test('destroy rechaza el short-path 8.3 del productivo', { skip: !ES_WINDOWS }, (t) => {
    const corto = shortPath(DEFAULT_PRODUCTIVE_DIR);
    if (!corto) { t.skip('el volumen no genera nombres 8.3'); return; }
    assert.ok(/~\d/.test(corto), corto);
    const d = destroy({ root: corto });
    assert.strictEqual(d.ok, false);
    assert.strictEqual(d.borrado, false);
    assert.match(d.motivo, /cae dentro de (productivo|repo)/);
    assert.ok(!/~\d/.test(d.root), 'el root reportado es canónico');
    assert.ok(existe(path.join(DEFAULT_PRODUCTIVE_DIR, 'pulpo.js')));
});

test('destroy rechaza un root que es link', () => {
    const base = tmpDir('link');
    const victima = path.join(base, 'victima');
    fs.mkdirSync(path.join(victima, '.pipeline'), { recursive: true });
    fs.writeFileSync(path.join(victima, '.pipeline', MARKER_FILENAME), JSON.stringify({ modo: 'pruebas' }));
    fs.writeFileSync(path.join(victima, 'importante.txt'), 'x');
    const link = path.join(base, 'link');
    fs.symlinkSync(victima, link, 'junction');
    assert.ok(esLink(link));
    const d = destroy({ root: link });
    assert.strictEqual(d.ok, false);
    assert.match(d.motivo, /es un enlace y no se sigue/);
    assert.ok(existe(path.join(victima, 'importante.txt')));
    assert.ok(esLink(link), 'el link tampoco se borra');
    fs.rmSync(base, { recursive: true, force: true });
});

test('destroy rechaza el home, un ancestro del home y la raíz de drive', () => {
    const base = tmpDir('home');
    const home = path.join(base, 'hogar');
    fs.mkdirSync(path.join(home, '.pipeline'), { recursive: true });
    fs.writeFileSync(path.join(home, '.pipeline', MARKER_FILENAME), JSON.stringify({ modo: 'pruebas' }));
    const osFalso = { tmpdir: () => os.tmpdir(), homedir: () => home };
    let d = destroy({ root: home }, { os: osFalso });
    assert.strictEqual(d.ok, false);
    assert.match(d.motivo, /cae dentro de home/);
    fs.mkdirSync(path.join(base, '.pipeline'));
    fs.writeFileSync(path.join(base, '.pipeline', MARKER_FILENAME), JSON.stringify({ modo: 'pruebas' }));
    d = destroy({ root: base }, { os: osFalso });
    assert.strictEqual(d.ok, false, 'ancestro del home');
    assert.match(d.motivo, /cae dentro de home/);
    assert.ok(existe(path.join(home, '.pipeline', MARKER_FILENAME)));
    // Descendiente del home (como `%TEMP%` en Windows) SÍ se permite.
    const hijo = path.join(home, 'hijo');
    fs.mkdirSync(path.join(hijo, '.pipeline'), { recursive: true });
    fs.writeFileSync(path.join(hijo, '.pipeline', MARKER_FILENAME), JSON.stringify({ modo: 'pruebas' }));
    d = destroy({ root: hijo }, { os: osFalso });
    assert.strictEqual(d.ok, true);
    assert.ok(!existe(hijo));

    const raiz = path.parse(base).root;
    d = destroy({ root: raiz });
    assert.strictEqual(d.ok, false);
    assert.match(d.motivo, /cae dentro de raíz/);
    assert.ok(lib._internal.esRaizDeDrive('/'));
    assert.ok(lib._internal.esRaizDeDrive('C:\\'));
    assert.ok(lib._internal.esRaizDeDrive('D:'));
    assert.ok(!lib._internal.esRaizDeDrive('C:\\Users'));
    fs.rmSync(base, { recursive: true, force: true });
});

test('destroy reporta residuo por nombre cuando el borrado queda a medias', () => {
    const base = tmpDir('residuo');
    const root = path.join(base, 'env');
    provision({ env: {}, root }, DEPS_SIN_GIT);
    const fsEperm = Object.create(fs);
    fsEperm.rmSync = () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); };
    let d = destroy({ root }, { fs: fsEperm });
    assert.strictEqual(d.ok, false);
    assert.strictEqual(d.borrado, true);
    assert.ok(d.residuo.length > 20);
    assert.ok(d.residuo.includes('.pipeline/config.yaml'));
    assert.match(d.motivo, /quedaron \d+ entradas .*\(EPERM\)/);
    assert.ok(existe(root));

    const fsNoop = Object.create(fs);
    fsNoop.rmSync = () => {};
    d = destroy({ root }, { fs: fsNoop });
    assert.strictEqual(d.ok, false);
    assert.doesNotMatch(d.motivo, /\(EPERM\)/);

    const fsSinCodigo = Object.create(fs);
    fsSinCodigo.rmSync = () => { throw new Error('sin code'); };
    d = destroy({ root }, { fs: fsSinCodigo });
    assert.match(d.motivo, /\(error\)/);

    assert.strictEqual(destroy({ root }).ok, true);
    fs.rmSync(base, { recursive: true, force: true });
});

// ─── SEC-P2 / SEC-P3 · provision fail-closed ante links ──────────────────────

test('provision aborta si el root pre-existe como junction/symlink a otro dir', () => {
    const base = tmpDir('junction');
    const victima = path.join(base, 'victima');
    fs.mkdirSync(victima);
    fs.writeFileSync(path.join(victima, 'importante.txt'), 'x');
    const antes = snapshotTree(victima);
    const link = path.join(base, 'intrale-pipeline-pruebas');
    fs.symlinkSync(victima, link, 'junction');
    assert.throws(() => provision({ env: {}, root: link }, DEPS_SIN_GIT), (e) => e instanceof AbortError && /es un enlace y no se sigue/.test(e.message));
    assert.deepStrictEqual(snapshotTree(victima), antes, 'la víctima queda intacta');
    assert.ok(esLink(link));
    fs.rmSync(base, { recursive: true, force: true });
});

test('provision aborta si un directorio del ambiente fue reemplazado por un link', () => {
    const base = tmpDir('linkadentro');
    const root = path.join(base, 'env');
    const r = provision({ env: {}, root }, DEPS_SIN_GIT);
    const victima = path.join(base, 'victima');
    fs.mkdirSync(victima);
    fs.writeFileSync(path.join(victima, 'importante.txt'), 'x');
    const logs = path.join(r.pipelineDir, 'logs');
    fs.rmSync(logs, { recursive: true });
    fs.symlinkSync(victima, logs, 'junction');
    assert.throws(() => provision({ env: {}, root }, DEPS_SIN_GIT), (e) => e instanceof AbortError && /\.pipeline\/logs es un enlace dentro del ambiente/.test(e.message));
    assert.deepStrictEqual(fs.readdirSync(victima), ['importante.txt']);
    const v = verifyIsolation({ root });
    assert.strictEqual(v.ok, false);
    assert.deepStrictEqual(v.links, ['.pipeline/logs']);

    // Un archivo esperado reemplazado por un link también aborta.
    fs.rmSync(logs, { force: true, recursive: true });
    const cfg = path.join(r.pipelineDir, 'config.yaml');
    fs.rmSync(cfg);
    fs.symlinkSync(victima, cfg, 'junction');
    assert.throws(() => provision({ env: {}, root }, DEPS_SIN_GIT), (e) => /config\.yaml es un enlace dentro del ambiente/.test(e.message));
    assert.deepStrictEqual(fs.readdirSync(victima), ['importante.txt']);
    fs.rmSync(base, { recursive: true, force: true });
});

test('provision aborta si un origen de la allowlist contiene un link', () => {
    const { repo, pipelineDir: prodFx } = crearProductivoFixture('linkorigen');
    const base = tmpDir('linkorigen');
    const root = path.join(base, 'env');
    const afuera = path.join(base, 'afuera');
    fs.mkdirSync(afuera);
    fs.writeFileSync(path.join(afuera, 'x.md'), 'x');

    // (a) link DENTRO de roles/.
    fs.symlinkSync(afuera, path.join(prodFx, 'roles', 'escape'), 'junction');
    assert.throws(() => provision({ env: {}, root, repoRoot: repo }, DEPS_SIN_GIT), (e) => e instanceof AbortError && /roles\/ del origen contiene un enlace \(escape\)/.test(e.message));
    assert.ok(!existe(root), 'nada escrito bajo root');
    fs.rmSync(path.join(prodFx, 'roles', 'escape'), { recursive: true, force: true });

    // (b) la entrada de la allowlist ES un link.
    fs.rmSync(path.join(prodFx, 'descriptors'), { recursive: true });
    fs.symlinkSync(afuera, path.join(prodFx, 'descriptors'), 'junction');
    assert.throws(() => provision({ env: {}, root, repoRoot: repo }, DEPS_SIN_GIT), (e) => /descriptors del origen es un enlace/.test(e.message));
    assert.ok(!existe(root));
    fs.rmSync(path.join(prodFx, 'descriptors'), { recursive: true, force: true });

    // (c) el manifiesto es un link: se detecta al llegar a él (queda dicho en el mensaje).
    const manifest = path.join(repo, PRODUCT_FILENAME);
    fs.rmSync(manifest);
    fs.symlinkSync(afuera, manifest, 'junction');
    assert.throws(() => provision({ env: {}, root, repoRoot: repo }, DEPS_SIN_GIT), (e) => /pipeline\.config\.json del origen es un enlace/.test(e.message));
    assert.ok(!existe(path.join(root, PRODUCT_FILENAME)));
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
});

// ─── SEC-P4 · allowlist de copia ─────────────────────────────────────────────

test('provision no copia logs, state ni archivos fuera de la allowlist', () => {
    const { repo, pipelineDir: prodFx } = crearProductivoFixture('allowlist');
    const base = tmpDir('allowlist');
    const root = path.join(base, 'env');
    const r = provision({ env: {}, root, repoRoot: repo }, DEPS_SIN_GIT);
    const pd = r.pipelineDir;
    assert.deepStrictEqual(fs.readdirSync(path.join(pd, 'logs')), []);
    assert.deepStrictEqual(fs.readdirSync(path.join(pd, 'state')), ['project-bindings']);
    assert.ok(!existe(path.join(pd, 'commander-session.json')));
    assert.ok(!existe(path.join(pd, '.paused')), '.paused del productivo NO se hereda');
    assert.strictEqual(fs.readFileSync(path.join(pd, 'waves.json'), 'utf8'), '{"version":"1.0","waves":[]}\n', 'waves.json viene del template, no del runtime');
    assert.strictEqual(r.copiados, 9, 'config + template + 2 agent-models + 1 descriptor + 3 roles + manifiesto');
    assert.strictEqual(fs.readFileSync(path.join(pd, 'roles', 'sub', 'anidado.md'), 'utf8'), '# anidado\n', 'subdirectorios de la allowlist copiados');
    // `env: null` se tolera como vacío.
    assert.strictEqual(provision({ env: null, root, repoRoot: repo }, DEPS_SIN_GIT).yaExistia, true);
    assert.deepStrictEqual(r.omitidos, []);

    // Ningún archivo del ambiente fuera de allowlist + estructura derivada + sembrados.
    const permitidosRaiz = new Set([...COPY_ALLOWLIST, MARKER_FILENAME, 'waves.json', '.partial-pause.json', 'servicios', ...DIRS_FIJOS.map((d) => d.split('/')[0]), 'definicion', 'desarrollo']);
    for (const nombre of fs.readdirSync(pd)) assert.ok(permitidosRaiz.has(nombre), `entrada inesperada en el ambiente: ${nombre}`);
    assert.ok(existe(path.join(prodFx, 'logs', 'x.log')), 'el productivo de fixture conserva lo suyo');

    // Orígenes ausentes: se reportan, no abortan.
    const repo2 = tmpDir('minimo');
    seedRepoRootConfig(repo2, {});
    const r2 = provision({ env: {}, root: path.join(base, 'env2'), repoRoot: repo2 }, DEPS_SIN_GIT);
    assert.deepStrictEqual(r2.omitidos, ['waves.json.template', 'agent-models.json', 'agent-models.schema.json', 'descriptors', 'roles']);
    assert.ok(!existe(path.join(r2.pipelineDir, 'waves.json')), 'sin template no hay waves.json que sembrar');
    assert.strictEqual(r2.colas, SERVICIOS.length * SERVICIO_SUBESTADOS.length, 'sin fases, sólo servicios');
    // Sin manifiesto en el origen: omitido, no aborta.
    fs.rmSync(path.join(repo2, PRODUCT_FILENAME));
    const r3 = provision({ env: {}, root: path.join(base, 'env3'), repoRoot: repo2 }, DEPS_SIN_GIT);
    assert.ok(r3.omitidos.includes(PRODUCT_FILENAME));
    assert.ok(!existe(r3.manifestPath));
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(repo2, { recursive: true, force: true });
});

// ─── CA-6 / SEC-P5 / SEC-P6 · destino por el resolvedor ──────────────────────

test('provision resuelve el destino por pipeline-env y aborta si el candidato cae en el productivo', () => {
    const marcadorProd = path.join(DEFAULT_PRODUCTIVE_DIR, MARKER_FILENAME);
    const candidatos = [DEFAULT_PRODUCTIVE_DIR, REPO_ROOT, path.join(DEFAULT_PRODUCTIVE_DIR, '_tmp', 'pruebas-7111-no-existe')];
    for (const root of candidatos) {
        assert.throws(() => provision({ env: {}, root }, DEPS_SIN_GIT), (e) => e instanceof AbortError && /el resolvedor no habilitó el destino como pruebas/.test(e.message) && /apunta al productivo/.test(e.message), root);
    }
    assert.ok(!existe(marcadorProd));
    assert.ok(!existe(path.join(DEFAULT_PRODUCTIVE_DIR, '_tmp', 'pruebas-7111-no-existe')));
    assert.ok(!existe(path.join(DEFAULT_PRODUCTIVE_DIR, '.pipeline')));
    assert.ok(!existe(path.join(REPO_ROOT, '.pipeline', '.pipeline')));

    // Short-path 8.3 del productivo: se canonicaliza y también aborta.
    if (ES_WINDOWS) {
        const corto = shortPath(DEFAULT_PRODUCTIVE_DIR);
        if (corto) {
            assert.throws(() => provision({ env: {}, root: path.join(corto, 'pruebas-7111-no-existe') }, DEPS_SIN_GIT), /el resolvedor no habilitó|cae dentro de/);
            assert.ok(!existe(path.join(DEFAULT_PRODUCTIVE_DIR, 'pruebas-7111-no-existe')));
        }
    }

    // El fuente pasa el candidato SÓLO por env: nunca `pipelineDir:` en la llamada a resolve.
    const src = fuenteSinComentarios(fs.readFileSync(LIB_SRC, 'utf8'));
    const llamadas = src.match(/pipelineEnv\.resolve\([^;]*\)/g) || [];
    assert.strictEqual(llamadas.length, 1, 'una sola llamada al resolvedor');
    assert.match(llamadas[0], /PIPELINE_DIR_OVERRIDE: candidato/);
    assert.doesNotMatch(llamadas[0], /pipelineDir/);
    assert.doesNotMatch(src, /process\.env/, 'la lib nunca lee el env global');

    // Env hostil: el strip funciona y se provisiona igual en pruebas.
    const base = tmpDir('hostil');
    const root = path.join(base, 'env');
    const otro = path.join(base, 'otro');
    const envHostil = {
        PIPELINE_AMBIENTE: 'productivo',
        PIPELINE_ALLOW_PROD_SIDE_EFFECTS: '1',
        PIPELINE_STATE_DIR: otro,
        PIPELINE_DIR_OVERRIDE: otro,
        PIPELINE_REPO_ROOT: otro,
        PIPELINE_RUNTIME_DIR: otro,
        PATH: 'lo-que-sea',
    };
    assert.deepStrictEqual([...ENV_STRIP].sort(), Object.keys(envHostil).filter((k) => k !== 'PATH').sort());
    assert.ok(ENV_STRIP.includes(pipelineEnv.ENV_AMBIENTE) && ENV_STRIP.includes(pipelineEnv.ENV_ESCAPE_HATCH), 'nombres tomados del resolvedor');
    const r = provision({ env: envHostil, root }, DEPS_SIN_GIT);
    assert.strictEqual(r.root, root);
    assert.ok(!existe(otro), 'las variables heredadas no desvían el destino');
    assert.ok(existe(r.marker));
    // Con señal de corrida de prueba también funciona.
    provision({ env: { NODE_TEST_CONTEXT: 'child', NODE_ENV: 'test' }, root }, DEPS_SIN_GIT);

    // --print-env no reemite el env heredado.
    const o = io(envHostil);
    assert.strictEqual(cli.main(['--root', root, '--print-env'], o, DEPS_SIN_GIT), 0);
    assert.strictEqual(o.out, `PIPELINE_REPO_ROOT=${root}\nPIPELINE_AMBIENTE=pruebas\n`);
    assert.doesNotMatch(o.out + o.err, /ALLOW_PROD|STATE_DIR|productivo=|lo-que-sea/);
    fs.rmSync(base, { recursive: true, force: true });
});

test('provision aplica defensa en profundidad por realpath aunque el resolvedor no objete', () => {
    const { repo, pipelineDir: prodFx } = crearProductivoFixture('defensa');
    // El resolvedor sólo conoce el productivo REAL; el fixture lo cubre el provisionador.
    assert.throws(() => provision({ env: {}, root: path.join(prodFx, 'x'), repoRoot: repo }, DEPS_SIN_GIT), (e) => e instanceof AbortError && /cae dentro de productivo/.test(e.message));
    assert.throws(() => provision({ env: {}, root: path.join(repo, 'sub'), repoRoot: repo }, DEPS_SIN_GIT), (e) => /cae dentro de repo/.test(e.message));
    assert.throws(() => provision({ env: {}, root: path.dirname(repo), repoRoot: repo }, DEPS_SIN_GIT), (e) => /cae dentro de (repo|productivo|home|raíz)/.test(e.message));
    assert.ok(!existe(path.join(prodFx, 'x')));
    assert.ok(!existe(path.join(repo, 'sub')));

    // home / raíz de drive por el mismo camino.
    const base = tmpDir('defensa');
    const osFalso = { tmpdir: () => os.tmpdir(), homedir: () => path.join(base, 'hogar') };
    fs.mkdirSync(path.join(base, 'hogar'));
    assert.throws(() => provision({ env: {}, root: base, repoRoot: repo }, { ...DEPS_SIN_GIT, os: osFalso }), /cae dentro de home/);
    assert.throws(() => provision({ env: {}, root: path.join(base, 'hogar'), repoRoot: repo }, { ...DEPS_SIN_GIT, os: osFalso }), /cae dentro de home/);
    assert.throws(() => provision({ env: {}, root: path.parse(base).root, repoRoot: repo }, DEPS_SIN_GIT), /cae dentro de raíz/);
    // Padre inexistente → abort claro.
    assert.throws(() => provision({ env: {}, root: path.join(base, 'no', 'existe', 'env'), repoRoot: repo }, DEPS_SIN_GIT), (e) => e instanceof AbortError && /el directorio padre de .* no existe/.test(e.message));

    // Re-check tras el mkdir (SEC-P2 race): si el root "cambió de lugar", aborta sin escribir adentro.
    let vecesLstat = 0;
    const fsRace2 = Object.create(fs);
    fsRace2.lstatSync = (p) => {
        if (p === path.join(base, 'race2') && ++vecesLstat >= 2) {
            const st = fs.lstatSync(p);
            return Object.assign(Object.create(st), { isSymbolicLink: () => true });
        }
        return fs.lstatSync(p);
    };
    assert.throws(() => provision({ env: {}, root: path.join(base, 'race2'), repoRoot: repo }, { ...DEPS_SIN_GIT, fs: fsRace2 }), /cambió de lugar mientras se creaba/);
    assert.ok(!existe(path.join(base, 'race2', '.pipeline')));
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
});

// ─── SEC-P7 · overlay del config.yaml ────────────────────────────────────────

test('el config.yaml del ambiente fuerza durable:false y vault.enabled:false y el resto es igual al productivo', () => {
    const base = tmpDir('overlay');
    const root = path.join(base, 'env');
    const r = provision({ env: {}, root }, DEPS_SIN_GIT);
    const productText = fs.readFileSync(path.join(REPO_ROOT, PRODUCT_FILENAME), 'utf8');
    const prod = configResolver.resolveMergedForDiff({ kernelText: fs.readFileSync(path.join(DEFAULT_PRODUCTIVE_DIR, 'config.yaml'), 'utf8'), productText });
    const amb = configResolver.resolveMergedForDiff({ kernelText: fs.readFileSync(path.join(r.pipelineDir, 'config.yaml'), 'utf8'), productText: fs.readFileSync(r.manifestPath, 'utf8') });
    assert.strictEqual(amb.valid, true, JSON.stringify(amb.errors).slice(0, 500));
    assert.strictEqual(amb.config.operational_state.durable, false);
    assert.strictEqual(amb.config.kernel.durable, false);
    assert.strictEqual(amb.config.vault.enabled, false);
    assert.strictEqual(CONFIG_OVERLAY.length, 3);
    const esperado = structuredClone(prod.config);
    esperado.operational_state.durable = false;
    esperado.kernel.durable = false;
    esperado.vault.enabled = false;
    assert.deepStrictEqual(amb.config, esperado, 'sólo cambian las 3 claves del overlay');
    assert.deepStrictEqual(configResolver.snapshotForDiff(amb.config), configResolver.snapshotForDiff(prod.config), 'misma forma clave por clave');

    // Sobre el fixture (que tiene los 3 flags en true) el overlay los apaga.
    const { repo } = crearProductivoFixture('overlay');
    const r2 = provision({ env: {}, root: path.join(base, 'env2'), repoRoot: repo }, DEPS_SIN_GIT);
    const cfg2 = yaml.load(fs.readFileSync(path.join(r2.pipelineDir, 'config.yaml'), 'utf8'));
    assert.strictEqual(cfg2.operational_state.durable, false);
    assert.strictEqual(cfg2.kernel.durable, false);
    assert.strictEqual(cfg2.vault.enabled, false);
    assert.strictEqual(cfg2.vault.prefix, '/intrale', 'el resto de la sección se conserva');

    // Documentos degenerados: el overlay crea lo que falta.
    const { aplicarOverlay } = lib._internal;
    for (const texto of ['', '- lista\n', 'kernel: 5\nvault: [1]\n']) {
        const { config } = aplicarOverlay(texto);
        assert.deepStrictEqual(config.operational_state, { durable: false }, JSON.stringify(texto));
        assert.deepStrictEqual(config.kernel, { durable: false });
        assert.deepStrictEqual(config.vault, { enabled: false });
    }
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
});

// ─── CA-5 / SEC-P10 · verifyIsolation ────────────────────────────────────────

test('verifyIsolation devuelve compartidos vacío para un ambiente sano y detecta el caso rel === ""', () => {
    const base = tmpDir('verify');
    const root = path.join(base, 'env');
    provision({ env: {}, root }, DEPS_SIN_GIT);
    const sano = verifyIsolation({ root });
    assert.strictEqual(sano.ok, true, JSON.stringify(sano));
    assert.deepStrictEqual(sano.compartidos, []);
    assert.deepStrictEqual(sano.links, []);
    assert.strictEqual(sano.marcador, true);
    assert.strictEqual(sano.productivo, fs.realpathSync.native(DEFAULT_PRODUCTIVE_DIR));
    assert.ok(sano.entradas > 150);
    assert.strictEqual(sano.motivo, undefined);

    // Junction hacia el productivo plantada en el ambiente.
    const junc = path.join(root, '.pipeline', 'logs', 'hacia-prod');
    fs.symlinkSync(DEFAULT_PRODUCTIVE_DIR, junc, 'junction');
    const roto = verifyIsolation({ root });
    assert.strictEqual(roto.ok, false);
    assert.deepStrictEqual(roto.links, ['.pipeline/logs/hacia-prod']);
    assert.match(roto.motivo, /contiene 1 enlaces/);
    fs.rmSync(junc, { recursive: true, force: true });

    // rel === '' (SEC-P10): el propio productivo "verificado contra sí mismo" es compartido.
    const { esContenido, esCompartido } = lib._internal;
    assert.strictEqual(esCompartido(DEFAULT_PRODUCTIVE_DIR, DEFAULT_PRODUCTIVE_DIR), true);
    assert.strictEqual(esContenido(path.join(DEFAULT_PRODUCTIVE_DIR, 'lib'), DEFAULT_PRODUCTIVE_DIR), true);
    assert.strictEqual(esContenido(path.dirname(DEFAULT_PRODUCTIVE_DIR), DEFAULT_PRODUCTIVE_DIR), false);
    assert.strictEqual(esContenido(path.join(base, 'x'), DEFAULT_PRODUCTIVE_DIR), false);
    assert.strictEqual(esContenido(`${DEFAULT_PRODUCTIVE_DIR}-hermano`, DEFAULT_PRODUCTIVE_DIR), false, 'prefijo de string no es contención');
    const { repo, pipelineDir: prodFx } = crearProductivoFixture('verify');
    const mismo = verifyIsolation({ root: prodFx, productivo: prodFx });
    assert.strictEqual(mismo.ok, false);
    assert.ok(mismo.compartidos.includes('.'), 'la raíz misma (rel === "") cuenta');
    assert.ok(mismo.compartidos.includes('config.yaml'));
    assert.match(mismo.motivo, /comparte \d+ entradas con el productivo/);
    // Un ambiente sano contra el fixture: nada compartido. Un productivo inexistente se compara tal cual.
    assert.strictEqual(verifyIsolation({ root, productivo: prodFx }).ok, true);
    const vInex = verifyIsolation({ root, productivo: path.join(base, 'prod-inexistente') });
    assert.strictEqual(vInex.ok, true);
    assert.strictEqual(vInex.productivo, path.join(base, 'prod-inexistente'));

    // Root inexistente / root link.
    const nada = verifyIsolation({ root: path.join(base, 'nada') });
    assert.deepStrictEqual({ ok: nada.ok, entradas: nada.entradas, motivo: nada.motivo }, { ok: false, entradas: 0, motivo: `no hay ambiente en ${path.join(base, 'nada')}` });
    const link = path.join(base, 'link');
    fs.symlinkSync(root, link, 'junction');
    const vl = verifyIsolation({ root: link });
    assert.deepStrictEqual({ ok: vl.ok, links: vl.links }, { ok: false, links: ['.'] });
    assert.match(vl.motivo, /el root es un enlace/);

    // Una entrada que desaparece durante el recorrido no rompe la verificación.
    const fsFantasma = Object.create(fs);
    fsFantasma.realpathSync = Object.assign((p) => fs.realpathSync(p), {
        native: (p) => { if (p.endsWith('waves.json')) throw new Error('ENOENT'); return fs.realpathSync.native(p); },
    });
    assert.strictEqual(verifyIsolation({ root }, { fs: fsFantasma }).ok, true);
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
});

// ─── SEC-P9 · sin valores del env ────────────────────────────────────────────

test('el marcador y la salida json no contienen valores del env', () => {
    const base = tmpDir('canario');
    const root = path.join(base, 'env');
    const env = { CANARIO_7111: 'valor-secreto-xyz', PIPELINE_AMBIENTE: 'valor-secreto-abc', TELEGRAM_TOKEN: 'valor-secreto-tok' };
    const r = provision({ env, root }, DEPS_SIN_GIT);
    const todo = JSON.stringify(r) + fs.readFileSync(r.marker, 'utf8') + JSON.stringify(verifyIsolation({ root })) + JSON.stringify(destroy({ root }));
    assert.doesNotMatch(todo, /valor-secreto/);
    for (const flags of [['--json'], [], ['--print-env'], ['--verify', '--json'], ['--destroy', '--json']]) {
        const o = io(env);
        cli.main(['--root', root, ...flags], o, DEPS_SIN_GIT);
        assert.doesNotMatch(o.out + o.err, /valor-secreto/, flags.join(' '));
    }
    // Errores tampoco: env con valor no reconocido en PIPELINE_AMBIENTE se strippea antes de llegar al resolvedor.
    try { provision({ env, root: DEFAULT_PRODUCTIVE_DIR }, DEPS_SIN_GIT); assert.fail('debía abortar'); } catch (e) { assert.doesNotMatch(e.message, /valor-secreto/); }
    fs.rmSync(base, { recursive: true, force: true });
});

// ─── SEC-P8 · sin shell ──────────────────────────────────────────────────────

test('la lib no invoca shell', () => {
    const src = fuenteSinComentarios(fs.readFileSync(LIB_SRC, 'utf8'));
    assert.doesNotMatch(src, /\bexecSync\s*\(/);
    assert.doesNotMatch(src, /\bspawnSync\s*\(/);
    assert.doesNotMatch(src, /\bspawn\s*\(/);
    assert.doesNotMatch(src, /\bexec\s*\(/);
    assert.doesNotMatch(src, /\bcpSync\s*\(/, 'nunca cpSync (derreferencia junctions)');
    assert.doesNotMatch(src, /\bstatSync\s*\(/, 'siempre lstat');
    const llamadas = src.match(/execFileSync\(([^)]*)\)/g) || [];
    assert.strictEqual(llamadas.length, 1, 'única excepción: git rev-parse HEAD');
    assert.match(llamadas[0], /^execFileSync\('git', \['rev-parse', 'HEAD'\]/);
    const cliSrc = fuenteSinComentarios(fs.readFileSync(CLI_SRC, 'utf8'));
    assert.doesNotMatch(cliSrc, /child_process|execSync|spawn/);
    assert.doesNotMatch(cliSrc, /require\('fs'\)/, 'el CLI no toca el filesystem: delega en la lib');

    // sha best-effort: sin git, con salida basura, y con git real (el repo del checkout).
    const { shaDelRepo } = lib._internal;
    assert.strictEqual(shaDelRepo(sinGit, REPO_ROOT), null);
    assert.strictEqual(shaDelRepo(() => 'no-es-un-sha\n', REPO_ROOT), null);
    assert.strictEqual(shaDelRepo(() => `${'a'.repeat(40)}\n`, REPO_ROOT), 'a'.repeat(40));
    assert.strictEqual(shaDelRepo(() => Buffer.from(`${'b'.repeat(40)}\n`), REPO_ROOT), 'b'.repeat(40));
    let argvVisto = null;
    shaDelRepo((cmd, args, opts) => { argvVisto = { cmd, args, cwd: opts.cwd }; return 'x'; }, REPO_ROOT);
    assert.deepStrictEqual(argvVisto, { cmd: 'git', args: ['rev-parse', 'HEAD'], cwd: REPO_ROOT });
});

// ─── helpers internos ────────────────────────────────────────────────────────

test('resolveRoot y snapshotTree canonicalizan sin efectos', () => {
    const base = tmpDir('helpers');
    assert.strictEqual(resolveRoot({ root: base }), base);
    assert.strictEqual(resolveRoot({ root: path.join(base, 'a', 'b', 'c') }), path.join(base, 'a', 'b', 'c'));
    assert.ok(resolveRoot({}).endsWith(lib.DEFAULT_ROOT_NAME));
    assert.strictEqual(resolveRoot(), resolveRoot({}));
    assert.strictEqual(resolveRoot(null), resolveRoot({}));
    // `opts` nulo apunta al default; con un fs roto revienta ANTES de tocar nada (no se prueba contra el default real).
    const fsRoto = { realpathSync: { native: () => { throw new Error('fs roto'); } } };
    assert.throws(() => destroy(null, { fs: fsRoto }), /fs roto/);
    assert.throws(() => verifyIsolation(null, { fs: fsRoto }), /fs roto/);
    assert.throws(() => provision(null, { fs: fsRoto }), /fs roto/);
    assert.throws(() => provision(undefined, { fs: fsRoto }), /fs roto/);
    assert.ok(!/~\d/.test(resolveRoot({})), 'default canónico aunque os.tmpdir() sea 8.3');
    if (ES_WINDOWS) {
        // Drive inexistente: no hay ancestro real → se devuelve tal cual.
        assert.strictEqual(resolveRoot({ root: 'Q:\\no-existe-7111\\x' }), 'Q:\\no-existe-7111\\x');
    }
    // Link en el último componente: se canonicaliza el padre, no se sigue el link.
    const destino = path.join(base, 'destino');
    fs.mkdirSync(destino);
    const link = path.join(base, 'link');
    fs.symlinkSync(destino, link, 'junction');
    assert.strictEqual(resolveRoot({ root: link }), link);
    assert.deepStrictEqual(snapshotTree(path.join(base, 'nada')), []);
    fs.writeFileSync(path.join(destino, 'f.txt'), 'abc');
    const snap = snapshotTree(base);
    assert.deepStrictEqual(snap.map((e) => [e.rel, e.tipo, e.size]), [['destino', 'dir', 0], ['destino/f.txt', 'file', 3], ['link', 'link', 0]]);
    assert.ok(snap.every((e) => typeof e.mtimeMs === 'number'));
    assert.strictEqual(lib._internal.leerMarcador(fs, path.join(base, 'nada')), null);
    assert.ok(!existe(path.join(base, 'a')), 'resolveRoot no crea nada');
    fs.rmSync(base, { recursive: true, force: true });
});

// ─── CA-8 · CLI ──────────────────────────────────────────────────────────────

test('el CLI expone exit codes 0/1/2 y --print-env emite sólo dos líneas', () => {
    const base = tmpDir('cli');
    const root = path.join(base, 'env');
    const P = '[pruebas:env]';

    // --help / flags inválidos: exit 0 / 2, nada provisionado.
    let o = io();
    assert.strictEqual(cli.main(['--help'], o), 0);
    assert.match(o.out, /Uso:/);
    assert.match(o.out, /pruebas:env:destroy/);
    assert.strictEqual(o.err, '');
    o = io();
    assert.strictEqual(cli.main(['-h'], o), 0);
    for (const argv of [['--destory'], ['--fresh=1'], ['--root'], ['--root', '--destroy'], ['--destroy', '--verify'], ['--verify', '--print-env'], ['--fresh', '--destroy'], ['--fresh', '--verify']]) {
        o = io();
        assert.strictEqual(cli.main(argv, o), 2, argv.join(' '));
        assert.strictEqual(o.out, '', argv.join(' '));
        assert.match(o.err, new RegExp(`^\\${P} ABORTADO · `), argv.join(' '));
        assert.match(o.err, /ver --help/);
    }
    o = io();
    cli.main(['--destory'], o);
    assert.match(o.err, /opción desconocida `--destory`/);
    o = io();
    cli.main(['--root'], o);
    assert.match(o.err, /opción `--root` sin valor/);
    assert.ok(!existe(root));
    // `argv` ausente se trata como vacío (= provisionar): con un fs que revienta no llega a escribir nada.
    o = io();
    assert.strictEqual(cli.main(undefined, o, { fs: { realpathSync: { native: () => { throw new Error('sin fs'); } } } }), 2);
    assert.match(o.err, /error inesperado \(sin fs\)/);

    // caso feliz humano (G-1).
    o = io();
    assert.strictEqual(cli.main(['--root', root], o, DEPS_SIN_GIT), 0);
    let lineas = o.out.trimEnd().split('\n');
    assert.strictEqual(lineas.length, 3);
    assert.strictEqual(lineas[0], `${P} OK · ambiente provisionado en ${root}`);
    assert.match(lineas[1], new RegExp(`^\\${P} 115 colas · 26 archivos copiados · productivo fuera del root: `));
    assert.strictEqual(lineas[2], `${P} para apuntar un proceso: npm run pruebas:env -- --print-env`);
    assert.strictEqual(o.err, '');
    assert.ok(!/~\d/.test(o.out));

    // idempotencia comunicada (G-6).
    o = io();
    assert.strictEqual(cli.main(['--root', root], o, DEPS_SIN_GIT), 0);
    assert.match(o.out, new RegExp(`^\\${P} OK · el ambiente ya existía en .*; se completó lo faltante \\(0 creados\\)\n`));

    // --json: stdout sólo el objeto (G-1), con verifyIsolation adentro.
    o = io();
    assert.strictEqual(cli.main(['--root', root, '--json'], o, DEPS_SIN_GIT), 0);
    const j = JSON.parse(o.out);
    assert.strictEqual(j.root, root);
    assert.strictEqual(j.pipelineDir, path.join(root, '.pipeline'));
    assert.strictEqual(j.manifestPath, path.join(root, PRODUCT_FILENAME));
    assert.strictEqual(j.verifyIsolation.ok, true);
    assert.strictEqual(o.err, '');

    // --print-env: exactamente dos líneas en stdout; avisos a stderr (G-2).
    o = io();
    assert.strictEqual(cli.main(['--root', root, '--print-env'], o, DEPS_SIN_GIT), 0);
    assert.deepStrictEqual(o.out.split('\n'), [`PIPELINE_REPO_ROOT=${root}`, 'PIPELINE_AMBIENTE=pruebas', '']);
    assert.match(o.err, /ya existía/);
    // El par emitido (root + declaración explícita de pruebas) es el que el resolvedor
    // entiende como pruebas con dir. #7112 / SEC-9: el root SOLO, sin declaración, es
    // contexto heredado y no aporta dir; por eso se resuelve con las dos líneas.
    const amb = pipelineEnv.resolve({ PIPELINE_REPO_ROOT: root, PIPELINE_AMBIENTE: 'pruebas' });
    assert.strictEqual(amb.modo, 'pruebas');
    assert.strictEqual(amb.dir, path.join(root, '.pipeline'));
    assert.strictEqual(configResolver.productPathFor(amb.dir), path.join(root, PRODUCT_FILENAME));

    // --fresh humano.
    o = io();
    assert.strictEqual(cli.main(['--root', root, '--fresh'], o, DEPS_SIN_GIT), 0);
    assert.match(o.out, new RegExp(`^\\${P} OK · ambiente borrado y recreado en `));
    o = io();
    assert.strictEqual(cli.main(['--root', root, '--fresh', '--print-env'], o, DEPS_SIN_GIT), 0);
    assert.strictEqual(o.err, '', 'con --fresh no hay aviso de "ya existía"');

    // --verify humano y json.
    o = io();
    assert.strictEqual(cli.main(['--root', root, '--verify'], o), 0);
    assert.match(o.out, new RegExp(`^\\${P} OK · \\d+ entradas en .*, ninguna compartida con `));
    o = io();
    assert.strictEqual(cli.main(['--root', root, '--verify', '--json'], o), 0);
    assert.strictEqual(JSON.parse(o.out).ok, true);
    // verify sobre un dir sin marcador pero limpio: OK con aviso.
    fs.mkdirSync(path.join(base, 'plano'));
    o = io();
    assert.strictEqual(cli.main(['--root', path.join(base, 'plano'), '--verify'], o), 0);
    assert.match(o.out, /\(sin marcador de pruebas\)/);
    // verify sobre un root inexistente: ABORTADO (2).
    o = io();
    assert.strictEqual(cli.main(['--root', path.join(base, 'nada'), '--verify'], o), 2);
    assert.match(o.err, new RegExp(`^\\${P} ABORTADO · no hay ambiente en .*; provisioná primero`));

    // INCOMPLETO (1): un link plantado dentro del ambiente.
    const junc = path.join(root, '.pipeline', 'logs', 'junc');
    fs.symlinkSync(DEFAULT_PRODUCTIVE_DIR, junc, 'junction');
    o = io();
    assert.strictEqual(cli.main(['--root', root, '--verify'], o), 1);
    assert.match(o.err, new RegExp(`^\\${P} INCOMPLETO · el ambiente contiene 1 enlaces \\(ver lista\\)\n\\${P}   - \\.pipeline/logs/junc\n$`));
    o = io();
    assert.strictEqual(cli.main(['--root', root, '--verify', '--json'], o), 1);
    assert.deepStrictEqual(JSON.parse(o.out).links, ['.pipeline/logs/junc']);
    o = io();
    assert.strictEqual(cli.main(['--root', root], o, DEPS_SIN_GIT), 1, 'provision + verify roto = INCOMPLETO');
    assert.match(o.out, new RegExp(`^\\${P} INCOMPLETO · el ambiente contiene 1 enlaces \\(ver lista\\) en `));
    assert.match(o.out, /- \.pipeline\/logs\/junc/);
    o = io();
    assert.strictEqual(cli.main(['--root', root, '--json'], o, DEPS_SIN_GIT), 1);
    assert.strictEqual(JSON.parse(o.out).verifyIsolation.ok, false);
    assert.match(o.err, /INCOMPLETO/);
    o = io();
    assert.strictEqual(cli.main(['--root', root, '--print-env'], o, DEPS_SIN_GIT), 1);
    assert.deepStrictEqual(o.out.split('\n').length, 3, 'aun con aviso, stdout son dos líneas');
    assert.match(o.err, /INCOMPLETO/);
    fs.rmSync(junc, { recursive: true, force: true });

    // Orígenes ausentes en el productivo: se informan en la salida humana.
    const fsSinRoles = Object.create(fs);
    fsSinRoles.lstatSync = (p) => {
        if (p === path.join(DEFAULT_PRODUCTIVE_DIR, 'roles')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return fs.lstatSync(p);
    };
    o = io();
    assert.strictEqual(cli.main(['--root', path.join(base, 'sinroles')], o, { ...DEPS_SIN_GIT, fs: fsSinRoles }), 0);
    assert.ok(o.out.includes(`${P} orígenes ausentes en el productivo (no copiados): roles\n`), o.out);

    // --destroy: anuncia antes (G-7), confirma después; json; no había; abort sin marcador; residuo (1).
    o = io();
    assert.strictEqual(cli.main(['--root', root, '--destroy'], o), 0);
    assert.strictEqual(o.err, `${P} destruyendo ${root} (fuera de ${DEFAULT_PRODUCTIVE_DIR})\n`);
    assert.strictEqual(o.out, `${P} OK · ambiente borrado: ${root} (productivo intacto: ${DEFAULT_PRODUCTIVE_DIR})\n`);
    assert.ok(!existe(root));
    o = io();
    assert.strictEqual(cli.main(['--root', root, '--destroy'], o), 0);
    assert.strictEqual(o.out, `${P} OK · no había ambiente en ${root}\n`);
    o = io();
    assert.strictEqual(cli.main(['--root', root, '--destroy', '--json'], o), 0);
    assert.strictEqual(JSON.parse(o.out).existia, false);
    o = io();
    assert.strictEqual(cli.main(['--root', path.join(base, 'plano'), '--destroy'], o), 2);
    assert.match(o.err, new RegExp(`\\${P} ABORTADO · .* no tiene marcador de ambiente de pruebas; no se borra nada`));
    assert.ok(existe(path.join(base, 'plano')));
    o = io();
    assert.strictEqual(cli.main(['--root', DEFAULT_PRODUCTIVE_DIR, '--destroy'], o), 2);
    assert.match(o.err, /ABORTADO · el root cae dentro de productivo/);
    cli.main(['--root', root], io(), DEPS_SIN_GIT);
    const fsNoop = Object.create(fs);
    fsNoop.rmSync = () => {};
    o = io();
    assert.strictEqual(cli.main(['--root', root, '--destroy'], o, { fs: fsNoop }), 1);
    lineas = o.err.trimEnd().split('\n');
    assert.match(lineas[1], new RegExp(`^\\${P} INCOMPLETO · quedaron \\d+ entradas en `));
    assert.strictEqual(lineas.length, 2 + 20 + 1, 'máximo 20 entradas + "… y N más" (G-8)');
    assert.match(lineas[lineas.length - 1], new RegExp(`^\\${P}   … y \\d+ más$`));
    o = io();
    assert.strictEqual(cli.main(['--root', root, '--destroy', '--json'], o, { fs: fsNoop }), 1);
    assert.strictEqual(JSON.parse(o.out).ok, false);

    // ABORTADO por la lib (2): root es link; error inesperado también sale 2.
    const link = path.join(base, 'link');
    fs.symlinkSync(root, link, 'junction');
    o = io();
    assert.strictEqual(cli.main(['--root', link], o, DEPS_SIN_GIT), 2);
    assert.match(o.err, new RegExp(`^\\${P} ABORTADO · el root es un enlace y no se sigue \\(.*\\); elegí un directorio real\n$`));
    // Sin --root, lo primero que la lib toca es `realpathSync.native(os.tmpdir())`: un fs roto revienta ahí, antes de escribir.
    o = io();
    assert.strictEqual(cli.main([], o, { fs: { realpathSync: { native: () => { throw new Error('boom'); } } } }), 2);
    assert.match(o.err, /ABORTADO · error inesperado \(boom\)/);
    o = io();
    assert.strictEqual(cli.main([], o, { fs: { realpathSync: { native: () => { throw 'texto'; } } } }), 2); // eslint-disable-line no-throw-literal
    assert.match(o.err, /error inesperado \(texto\)/);

    // Entrada real del script (`require.main === module`): mismo contrato por proceso.
    const rootSpawn = path.join(base, 'spawn');
    const corrida = (args) => {
        try {
            return { code: 0, out: execFileSync(process.execPath, [CLI_SRC, '--root', rootSpawn, ...args], { encoding: 'utf8', windowsHide: true, timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }) };
        } catch (e) {
            return { code: e.status, out: e.stdout, err: e.stderr };
        }
    };
    let c = corrida(['--print-env']);
    assert.strictEqual(c.code, 0);
    assert.strictEqual(c.out, `PIPELINE_REPO_ROOT=${rootSpawn}\nPIPELINE_AMBIENTE=pruebas\n`);
    c = corrida(['--destory']);
    assert.strictEqual(c.code, 2);
    assert.strictEqual(c.out, '');
    assert.match(c.err, /ABORTADO · opción desconocida/);
    c = corrida(['--destroy']);
    assert.strictEqual(c.code, 0);
    assert.ok(!existe(rootSpawn));

    // Sin emoji ni color: todo grepeable con la palabra clave.
    assert.doesNotMatch(o.err, /\u001b\[/);
    assert.strictEqual(cli.EXIT.INCOMPLETO, 1);
    assert.strictEqual(cli.PREFIJO, P);
    fs.rmSync(base, { recursive: true, force: true });
});

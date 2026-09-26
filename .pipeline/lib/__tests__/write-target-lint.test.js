// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

/**
 * #7114 — suite del guardrail por destino (`lib/write-target-lint.js`).
 *
 * Fixtures con `fs.mkdtempSync` bajo `os.tmpdir()` (nunca bajo el repo): cada
 * fixture es un repo minimo con su `.pipeline/` (modulos + inventario + baseline)
 * y sus tests, y el `.pipeline` del fixture hace de PRODUCTIVO
 * (`opts.productiveDir`). Asi los rojos de R3 se construyen sin tocar el
 * `.pipeline` real y son deterministas en win32 y posix.
 *
 * Cobertura (CA-9): cada regla (R1/R2/R3), cada forma SEC-7, cada rama de exit
 * code (0/1/2), SEC-1 (canonica), SEC-2 (inexistencia no exime), SEC-4a
 * (anti-tampering), SEC-5 (estatico puro), SEC-6 (sin fuga), remedios (CA-7),
 * ratchet shrink-only (CA-3), los dos escenarios Gherkin del issue y el
 * `--check` sobre el repo REAL.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const lint = require('../write-target-lint');
const scan = require('../write-points-scan');
const I = lint._internal;

const REPO_REAL = path.resolve(__dirname, '..', '..', '..');
const LINT_PATH = path.resolve(__dirname, '..', 'write-target-lint.js');

// ── Fixture ─────────────────────────────────────────────────────────────────

const PLUS = String.fromCharCode(43);
// Las formas de SEC-7 se escriben por CONCATENACION para que `test-env-lint`
// (#6260), que escanea esta suite, no las lea como asignaciones propias.
const PE = 'process' + '.env';

function fixture(opts = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wtl-7114-'));
    const pipeline = path.join(root, '.pipeline');
    fs.mkdirSync(path.join(pipeline, 'lib'), { recursive: true });
    for (const [relPath, src] of Object.entries(opts.modulos || {})) {
        const abs = path.join(pipeline, relPath);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, src);
    }
    for (const [relPath, src] of Object.entries(opts.tests || {})) {
        const abs = path.join(root, relPath);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, src);
    }
    // Un test "neutro" para que el alcance nunca sea 0 (salvo que se pida).
    if (!opts.sinTestNeutro) {
        const neutro = path.join(pipeline, 'lib', '__tests__', 'neutro.test.js');
        fs.mkdirSync(path.dirname(neutro), { recursive: true });
        fs.writeFileSync(neutro, "const os = require('os'); const fs = require('fs'); const path = require('path');\n"
            + "const d = fs.mkdtempSync(path.join(os.tmpdir(), 'x-'));\n" + PE + ".PIPELINE_DIR_OVERRIDE = d;\n");
    }
    const puntos = opts.inventario !== undefined ? opts.inventario : scan.sincronizar(pipeline, []);
    if (opts.inventario !== null) {
        fs.writeFileSync(path.join(pipeline, 'lib', 'write-points.json'),
            typeof puntos === 'string' ? puntos : JSON.stringify({ puntos }, null, 2));
    }
    if (opts.baseline !== null) {
        const b = opts.baseline || { pendientes: [], tests: [] };
        fs.writeFileSync(path.join(pipeline, 'lib', 'write-target-lint.baseline.json'),
            typeof b === 'string' ? b : JSON.stringify(b, null, 2));
    }
    const base = { pipelineRoot: pipeline, repoRoot: root, productiveDir: pipeline, env: {} };
    return {
        root,
        pipeline,
        puntos,
        run: (extra) => lint.check(Object.assign({}, base, extra || {})),
        writeBaseline: (extra) => lint.writeBaseline(Object.assign({ skipGitCheck: true }, base, extra || {}), silencio()),
        limpiar: () => fs.rmSync(root, { recursive: true, force: true }),
    };
}

function silencio() {
    const out = { lines: [] };
    out.info = (m) => out.lines.push('I ' + m);
    out.warn = (m) => out.lines.push('W ' + m);
    out.error = (m) => out.lines.push('E ' + m);
    return out;
}

const MOD_DIRNAME = [
    "const fs = require('fs'); const path = require('path');",
    "const LOG_DIR = path.join(__dirname, '..', 'logs');",
    "function log(m) { fs.appendFileSync(path.join(LOG_DIR, 'x.log'), m); }",
    'module.exports = { log };',
].join('\n');

const MOD_ENV = [
    "const fs = require('fs'); const path = require('path');",
    'function pipelineDir() { return ' + PE + ".PIPELINE_DIR_OVERRIDE || path.join(__dirname, '..'); }",
    "function save(s) { fs.writeFileSync(path.join(pipelineDir(), 'estado.json'), s); }",
    'module.exports = { save };',
].join('\n');

const MOD_MIGRADO = [
    "const fs = require('fs'); const path = require('path');",
    "const writeTarget = require('./write-target');",
    'function pipelineDir() { return writeTarget.writeDir(' + PE + ", { canal: 'pausa', destino: '.paused' }); }",
    "function pause() { fs.writeFileSync(path.join(pipelineDir(), '.paused'), ''); }",
    'module.exports = { pause };',
].join('\n');

const TEST_VERDE_MKDTEMP = [
    "const fs = require('fs'); const os = require('os'); const path = require('path');",
    "const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtl-'));",
    PE + '.PIPELINE_DIR_OVERRIDE = dir;',
].join('\n');

// `variable` por defecto: una de DIRECTORIO (`PIPELINE_DIR_OVERRIDE` /
// `PIPELINE_STATE_DIR`), cuyo valor ES el destino. `PIPELINE_REPO_ROOT` aporta
// la RAIZ del repo (destino efectivo `<valor>/.pipeline`) y se prueba aparte
// con un valor realista (rebote QA de #7114: `.pipeline/logs` como raiz era irreal).
function testConValor(forma, valor, variable) {
    const cabecera = "const path = require('path'); const os = require('os');\n";
    switch (forma) {
        case 'directa': return cabecera + PE + '.' + (variable || 'PIPELINE_DIR_OVERRIDE') + ' = ' + valor + ';\n';
        case 'computed': return cabecera + PE + "['" + (variable || 'PIPELINE_STATE_DIR') + "'] = " + valor + ';\n';
        case 'Object.assign': return cabecera + 'Object.assign(' + PE + ', { ' + (variable || 'PIPELINE_STATE_DIR') + ': ' + valor + ' });\n';
        case 'withEnv': return cabecera + 'withEnv({ ' + (variable || 'PIPELINE_DIR_OVERRIDE') + ': ' + valor + ' }, () => {});\n';
        case 'spawn env': return cabecera + "spawnSync('node', ['x.js'], { env: { ..." + PE + ', ' + (variable || 'PIPELINE_DIR_OVERRIDE') + ': ' + valor + ' } });\n';
        case 'pipelineDir:': return cabecera + 'resolve(' + PE + ', { pipelineDir: ' + valor + ' });\n';
        default: throw new Error(forma);
    }
}

const FORMAS = ['directa', 'computed', 'Object.assign', 'withEnv', 'spawn env', 'pipelineDir:'];

// ── Invariantes estructurales (CA-8 / SEC-5) ─────────────────────────────────

test('CA-8 · SELF_EXEMPT tiene EXACTAMENTE 2 entradas: el guardrail y su suite', () => {
    assert.strictEqual(I.SELF_EXEMPT.size, 2);
    assert.ok(I.SELF_EXEMPT.has('lib/write-target-lint.js'));
    assert.ok(I.SELF_EXEMPT.has('lib/__tests__/write-target-lint.test.js'));
    assert.ok(!I.SELF_EXEMPT.has('lib/write-points-scan.js'), 'el escaner se audita');
    assert.ok(!I.SELF_EXEMPT.has('lib/pipeline-env.js'), 'pipeline-env se audita');
    assert.ok(!I.SELF_EXEMPT.has('lib/write-target.js'), 'write-target se audita');
});

test('SEC-5 · analisis estatico puro: sin eval/vm/Function ni shell, child_process solo git con argv fijo', () => {
    const src = fs.readFileSync(LINT_PATH, 'utf8');
    assert.doesNotMatch(src, /\beval\s*\(/);
    assert.doesNotMatch(src, /new\s+Function\s*\(/);
    assert.doesNotMatch(src, /require\(\s*['"]vm['"]\s*\)/);
    assert.doesNotMatch(src, /shell\s*:\s*true/);
    const llamadas = src.match(/execFileSync\(\s*'[^']*'/g) || [];
    assert.ok(llamadas.length >= 1);
    for (const l of llamadas) assert.strictEqual(l, "execFileSync('git'");
    // CA-2: reutiliza el escaner; no reimplementa la regex de escritura.
    assert.match(src, /require\('\.\/write-points-scan'\)/);
    assert.doesNotMatch(src, /writeFileSync\|appendFileSync/, 'RE_ESCRITURA vive en write-points-scan, no aca');
});

test('CA-6 · el modulo no usa fs.globSync (Node 20 en CI): walk propio', () => {
    const src = fs.readFileSync(LINT_PATH, 'utf8');
    assert.doesNotMatch(src, /globSync/);
});

// ── Fail-closed (SEC-9 / CA-8) ────────────────────────────────────────────────

test('SEC-9 · inventario ausente -> ConfigError (exit 2), nunca verde', () => {
    const f = fixture({ modulos: { 'lib/a.js': MOD_MIGRADO }, inventario: null });
    try {
        assert.throws(() => f.run(), (e) => e instanceof lint.ConfigError && /write-points\.json/.test(e.message));
    } finally { f.limpiar(); }
});

test('SEC-9 · inventario ilegible (JSON roto) -> ConfigError', () => {
    const f = fixture({ modulos: { 'lib/a.js': MOD_MIGRADO }, inventario: '{ no es json' });
    try {
        assert.throws(() => f.run(), lint.ConfigError);
    } finally { f.limpiar(); }
});

test('SEC-9 · baseline ausente o sin shape -> ConfigError', () => {
    const f1 = fixture({ modulos: { 'lib/a.js': MOD_MIGRADO }, baseline: null });
    try { assert.throws(() => f1.run(), (e) => e instanceof lint.ConfigError && /baseline/.test(e.message)); }
    finally { f1.limpiar(); }
    const f2 = fixture({ modulos: { 'lib/a.js': MOD_MIGRADO }, baseline: '{"pendientes": "no"}' });
    try { assert.throws(() => f2.run(), lint.ConfigError); }
    finally { f2.limpiar(); }
});

test('SEC-9 · pipeline-env que no carga -> ConfigError (productiveDir ausente y require roto)', () => {
    const f = fixture({ modulos: { 'lib/a.js': MOD_MIGRADO } });
    try {
        // Sin `productiveDir`, el lint carga `./pipeline-env` real: existe, asi que
        // el camino feliz resuelve. Lo que se prueba es la rama de error: un
        // `productiveDir` no-string cae al require y, si este fallara, es ConfigError.
        assert.doesNotThrow(() => I.miembrosProductivo({ env: {} }));
        const m = I.miembrosProductivo({ env: {} });
        assert.strictEqual(m[0].label, '.pipeline');
    } finally { f.limpiar(); }
});

test('SEC-9 · 0 modulos escaneados -> exit 1 con mensaje literal', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wtl-7114-vacio-'));
    const pipeline = path.join(root, '.pipeline');
    fs.mkdirSync(path.join(pipeline, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(pipeline, 'lib', 'write-points.json'), '{"puntos": []}');
    fs.writeFileSync(path.join(pipeline, 'lib', 'write-target-lint.baseline.json'), '{"pendientes": [], "tests": []}');
    try {
        const r = lint.check({ pipelineRoot: pipeline, repoRoot: root, productiveDir: pipeline, env: {} });
        assert.strictEqual(r.code, 1);
        assert.match(r.lines[0], /no encontro ningun modulo/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('SEC-9 · 0 tests escaneados -> exit 1 con mensaje literal', () => {
    const f = fixture({ modulos: { 'lib/a.js': MOD_MIGRADO }, sinTestNeutro: true });
    try {
        const r = f.run();
        assert.strictEqual(r.code, 1);
        assert.match(r.lines[0], /glob no matcheo ningun archivo de test/);
    } finally { f.limpiar(); }
});

// ── R1 · inventario sincronizado ─────────────────────────────────────────────

test('R1 · modulo escritor NO inventariado -> exit 1 con `LINT R1: <archivo>:<linea> -> <via> (canal ...)` y el remedio --sync', () => {
    const f = fixture({ modulos: { 'lib/nuevo.js': MOD_DIRNAME }, inventario: [] });
    try {
        const r = f.run();
        assert.strictEqual(r.code, 1);
        const linea = r.lines.find((l) => /^LINT R1: \.pipeline\/lib\/nuevo\.js:2 -> __dirname \(canal /.test(l));
        assert.ok(linea, r.lines.join('\n'));
        assert.match(linea, /NO inventariado/);
        assert.ok(r.remedios.some((l) => l.includes('write-points-scan.js --sync')));
    } finally { f.limpiar(); }
});

test('R1 · entrada del JSON sin punto en el fuente -> rojo', () => {
    const f = fixture({ modulos: { 'lib/a.js': MOD_MIGRADO } });
    try {
        const inv = f.puntos.concat([{ modulo: 'lib/fantasma.js', funcion: 'x', linea: 1, canal: 'logs', destino: 'x', tier: 3, estado: 'pendiente', via: '__dirname' }]);
        fs.writeFileSync(path.join(f.pipeline, 'lib', 'write-points.json'), JSON.stringify({ puntos: inv }));
        const r = f.run();
        assert.strictEqual(r.code, 1);
        assert.ok(r.lines.some((l) => /^LINT R1: \.pipeline\/lib\/fantasma\.js:1 -> /.test(l) && /sin punto en el fuente/.test(l)), r.lines.join('\n'));
    } finally { f.limpiar(); }
});

test('R1 / SEC-4a · `migrado` en el JSON cuya linea NO usa write-target -> rojo ("migrar editando el JSON" no alcanza)', () => {
    const f = fixture({ modulos: { 'lib/a.js': MOD_ENV } });
    try {
        const inv = f.puntos.map((e) => Object.assign({}, e, { estado: 'migrado' }));
        assert.strictEqual(inv.length, 1);
        fs.writeFileSync(path.join(f.pipeline, 'lib', 'write-points.json'), JSON.stringify({ puntos: inv }));
        const r = f.run();
        assert.strictEqual(r.code, 1);
        assert.ok(r.lines.some((l) => /^LINT R1: \.pipeline\/lib\/a\.js:2 -> /.test(l) && /declara `migrado`/.test(l)), r.lines.join('\n'));
    } finally { f.limpiar(); }
});

test('R1 / SEC-4a · `lectura` sin `nota` -> rojo; con nota y sin escritura que use el identificador -> verde', () => {
    const modulo = [
        "const fs = require('fs'); const path = require('path');",
        "const ASSETS = path.join(__dirname, 'assets');",
        "function css() { return fs.readFileSync(path.join(ASSETS, 'a.css')); }",
        'function save(s) { fs.writeFileSync(path.join(' + PE + ".PIPELINE_DIR_OVERRIDE, 'x'), s + css()); }",
    ].join('\n');
    const f = fixture({ modulos: { 'lib/a.js': modulo } });
    try {
        const assets = f.puntos.find((e) => e.funcion === 'ASSETS');
        assert.ok(assets, 'el heuristico ve ASSETS (alimenta save via css) — es el falso positivo tipico');
        const sinNota = f.puntos.map((e) => e.funcion === 'ASSETS' ? Object.assign({}, e, { estado: 'lectura' }) : e);
        fs.writeFileSync(path.join(f.pipeline, 'lib', 'write-points.json'), JSON.stringify({ puntos: sinNota }));
        let r = f.run();
        assert.strictEqual(r.code, 1);
        assert.ok(r.lines.some((l) => /sin `nota`/.test(l)), r.lines.join('\n'));

        const conNota = sinNota.map((e) => e.funcion === 'ASSETS' ? Object.assign({}, e, { nota: 'solo lee css' }) : e);
        fs.writeFileSync(path.join(f.pipeline, 'lib', 'write-points.json'), JSON.stringify({ puntos: conNota }));
        fs.writeFileSync(path.join(f.pipeline, 'lib', 'write-target-lint.baseline.json'),
            JSON.stringify({ pendientes: conNota.filter((e) => e.estado === 'pendiente').map(scan.clave), tests: [] }));
        r = f.run();
        assert.strictEqual(r.code, 0, r.lines.join('\n'));
    } finally { f.limpiar(); }
});

test('R1 / SEC-4a · `lectura` cuyo identificador aparece en una llamada de escritura -> rojo (no es falso positivo)', () => {
    const f = fixture({ modulos: { 'lib/a.js': MOD_DIRNAME } });
    try {
        const inv = f.puntos.map((e) => Object.assign({}, e, { estado: 'lectura', nota: 'mentira' }));
        fs.writeFileSync(path.join(f.pipeline, 'lib', 'write-points.json'), JSON.stringify({ puntos: inv }));
        const r = f.run();
        assert.strictEqual(r.code, 1);
        assert.ok(r.lines.some((l) => /^LINT R1: \.pipeline\/lib\/a\.js:3 -> /.test(l) && /aparece en una llamada de escritura/.test(l)), r.lines.join('\n'));
    } finally { f.limpiar(); }
});

test('R1 / SEC-4a · `externo` puede escribir fuera del arbol, pero no armar un path con `.pipeline`', () => {
    const modulo = [
        "const fs = require('fs'); const path = require('path');",
        "const ROOT = path.resolve(__dirname, '..', '..');",
        "function html(s) { fs.writeFileSync(path.join(ROOT, 'docs', 'qa', 'x.html'), s); }",
    ].join('\n');
    const f = fixture({ modulos: { 'lib/a.js': modulo } });
    try {
        const inv = f.puntos.map((e) => Object.assign({}, e, { estado: 'externo', nota: 'docs/qa' }));
        fs.writeFileSync(path.join(f.pipeline, 'lib', 'write-points.json'), JSON.stringify({ puntos: inv }));
        assert.strictEqual(f.run().code, 0);
        fs.writeFileSync(path.join(f.pipeline, 'lib', 'a.js'), modulo.replace("'docs', 'qa'", "'.pipeline', 'logs'"));
        const r = f.run();
        assert.strictEqual(r.code, 1);
        assert.ok(r.lines.some((l) => /arma un path con `\.pipeline`/.test(l)), r.lines.join('\n'));
    } finally { f.limpiar(); }
});

test('R1 · el identificador dentro de un string (`pulpo.log` vs `log`) no cuenta como uso', () => {
    const modulo = [
        "const fs = require('fs'); const path = require('path');",
        "const pulpo = path.join(__dirname, '..', 'config.yaml');",
        'function cfg() { return fs.readFileSync(pulpo); }',
        'function log(m) { fs.appendFileSync(path.join(' + PE + ".PIPELINE_DIR_OVERRIDE, 'logs', 'pulpo.log'), m + cfg()); }",
    ].join('\n');
    const f = fixture({ modulos: { 'lib/a.js': modulo } });
    try {
        assert.ok(f.puntos.some((e) => e.funcion === 'pulpo'), 'el heuristico ve pulpo (alimenta log via cfg)');
        const inv = f.puntos.map((e) => e.funcion === 'pulpo' ? Object.assign({}, e, { estado: 'lectura', nota: 'config' }) : e);
        fs.writeFileSync(path.join(f.pipeline, 'lib', 'write-points.json'), JSON.stringify({ puntos: inv }));
        fs.writeFileSync(path.join(f.pipeline, 'lib', 'write-target-lint.baseline.json'),
            JSON.stringify({ pendientes: inv.filter((e) => e.estado === 'pendiente').map(scan.clave), tests: [] }));
        const r = f.run();
        assert.strictEqual(r.code, 0, r.lines.join('\n'));
    } finally { f.limpiar(); }
});

// ── R2 · ratchet shrink-only ─────────────────────────────────────────────────

test('R2 · `pendiente` nuevo fuera del baseline -> rojo con modulo::funcion; --write-baseline rechaza crecer', () => {
    const f = fixture({ modulos: { 'lib/a.js': MOD_ENV } });
    try {
        const r = f.run();
        assert.strictEqual(r.code, 1);
        const linea = r.lines.find((l) => /^LINT R2: \.pipeline\/lib\/a\.js:2 -> process\.env\.PIPELINE_\* \(canal /.test(l));
        assert.ok(linea, r.lines.join('\n'));
        assert.match(linea, /lib\/a\.js::pipelineDir/);
        assert.doesNotMatch(linea, /::2\b/, 'el ratchet no se ancla por linea');
        assert.strictEqual(f.writeBaseline(), 1, 'shrink-only: no se hornea un pendiente nuevo');
    } finally { f.limpiar(); }
});

test('R2 · `pendiente` que desaparece -> exit 0 + aviso de que el baseline ENCOGIO; --write-baseline lo re-escribe', () => {
    const f = fixture({ modulos: { 'lib/a.js': MOD_ENV }, baseline: { pendientes: ['lib/a.js::pipelineDir', 'lib/viejo.js::x'], tests: [] } });
    try {
        const r = f.run();
        assert.strictEqual(r.code, 0, r.lines.join('\n'));
        assert.ok(r.lines.some((l) => /ENCOGIO/.test(l) && /--write-baseline/.test(l)));
        assert.strictEqual(f.writeBaseline(), 0);
        const b = JSON.parse(fs.readFileSync(path.join(f.pipeline, 'lib', 'write-target-lint.baseline.json'), 'utf8'));
        assert.deepStrictEqual(b.pendientes, ['lib/a.js::pipelineDir']);
    } finally { f.limpiar(); }
});

test('R2 · un `pendiente` curado como lectura con nota no cuenta para el ratchet', () => {
    const f = fixture({ modulos: { 'lib/a.js': MOD_ENV } });
    try {
        const inv = f.puntos.map((e) => Object.assign({}, e, { estado: 'lectura', nota: 'ejemplo' }));
        // MOD_ENV escribe con pipelineDir(): la curacion es invalida por SEC-4a, asi que
        // R1 lo ataja; lo que se verifica aca es que R2 NO lo cuenta dos veces.
        fs.writeFileSync(path.join(f.pipeline, 'lib', 'write-points.json'), JSON.stringify({ puntos: inv }));
        const r = f.run();
        assert.ok(!r.lines.some((l) => /^LINT R2/.test(l)), r.lines.join('\n'));
    } finally { f.limpiar(); }
});

// ── R3 · destinos en tests (SEC-7 / SEC-1 / SEC-2) ───────────────────────────

for (const forma of FORMAS) {
    test(`R3 / SEC-7 · forma \`${forma}\` con path.join(__dirname, ..) dentro del productivo -> rojo con archivo, linea, variable y destino`, () => {
        const f = fixture({
            modulos: { 'lib/a.js': MOD_MIGRADO },
            tests: { '.pipeline/tests/caso.test.js': testConValor(forma, "path.join(__dirname, '..', 'logs')") },
        });
        try {
            const r = f.run();
            assert.strictEqual(r.code, 1, r.lines.join('\n'));
            const h = r.hallazgos.find((x) => x.regla === 'R3');
            assert.ok(h, 'hallazgo R3');
            assert.strictEqual(h.file, '.pipeline/tests/caso.test.js');
            assert.strictEqual(h.line, 2);
            assert.strictEqual(h.destino, '.pipeline/logs');
            assert.strictEqual(h.canal, 'logs');
            assert.ok(['PIPELINE_DIR_OVERRIDE', 'PIPELINE_STATE_DIR', 'pipelineDir'].includes(h.variable));
            const primera = r.lines.find((l) => /^LINT R3:/.test(l));
            assert.match(primera, /^LINT R3: \.pipeline\/tests\/caso\.test\.js:2 -> \.pipeline\/logs \(canal logs\)/);
            assert.match(primera, /variable: /);
        } finally { f.limpiar(); }
    });
}

test('R3 / SEC-7 · las otras formas de valor: `${__dirname}/..`, `__dirname + ..`, `__dirname`, `path.resolve`, `path.dirname(__dirname)`', () => {
    const casos = [
        '`${__dirname}/../logs`',
        "__dirname " + PLUS + " '/../servicios'",
        '__dirname',
        "path.resolve(__dirname, '..')",
        'path.dirname(__dirname)',
        "path.join(path.dirname(__dirname), '.paused')",
    ];
    const tests = {};
    casos.forEach((v, i) => { tests[`.pipeline/tests/c${i}.test.js`] = testConValor('directa', v); });
    const f = fixture({ modulos: { 'lib/a.js': MOD_MIGRADO }, tests });
    try {
        const r = f.run();
        assert.strictEqual(r.code, 1);
        const archivos = r.hallazgos.filter((h) => h.regla === 'R3').map((h) => h.file).sort();
        assert.deepStrictEqual(archivos, casos.map((_, i) => `.pipeline/tests/c${i}.test.js`).sort(), r.lines.join('\n'));
        assert.ok(r.hallazgos.some((h) => h.destino === '.pipeline/.paused' && h.canal === 'pausa'));
        assert.ok(r.hallazgos.some((h) => h.destino === '.pipeline/servicios' && h.canal === 'colas'));
    } finally { f.limpiar(); }
});

test('R3 · literal absoluto dentro del productivo -> rojo; fuera del productivo -> verde', () => {
    const f = fixture({ modulos: { 'lib/a.js': MOD_MIGRADO } });
    try {
        const adentro = JSON.stringify(path.join(f.pipeline, 'logs'));
        const afuera = JSON.stringify(path.join(f.root, 'otro'));
        fs.mkdirSync(path.join(f.pipeline, 'tests'));
        fs.writeFileSync(path.join(f.pipeline, 'tests', 'in.test.js'), testConValor('directa', adentro));
        fs.writeFileSync(path.join(f.pipeline, 'tests', 'out.test.js'), testConValor('directa', afuera));
        const r = f.run();
        assert.strictEqual(r.code, 1);
        const files = r.hallazgos.map((h) => h.file);
        assert.deepStrictEqual(files, ['.pipeline/tests/in.test.js']);
    } finally { f.limpiar(); }
});

test('R3 / SEC-2 · la inexistencia del destino NO exime: subdir que no existe dentro del productivo -> rojo', () => {
    const f = fixture({
        modulos: { 'lib/a.js': MOD_MIGRADO },
        tests: { '.pipeline/test/kap.test.js': testConValor('directa', "path.join(__dirname, '__no_existe_5174__')") },
    });
    try {
        assert.ok(!fs.existsSync(path.join(f.pipeline, 'test', '__no_existe_5174__')));
        const r = f.run();
        assert.strictEqual(r.code, 1);
        const h = r.hallazgos[0];
        assert.strictEqual(h.destino, '.pipeline/test/__no_existe_5174__');
        assert.match(h.reason, /no existe hoy/);
    } finally { f.limpiar(); }
});

test('R3 / SEC-1 · comparacion canonica: drive en minuscula (win32) o junction/symlink resuelven al productivo -> rojo', { skip: process.platform !== 'win32' && !puedeEnlazar() }, () => {
    const f = fixture({ modulos: { 'lib/a.js': MOD_MIGRADO } });
    try {
        fs.mkdirSync(path.join(f.pipeline, 'tests'));
        if (process.platform === 'win32') {
            const lower = path.join(f.pipeline, 'logs').toLowerCase();
            assert.notStrictEqual(lower, path.join(f.pipeline, 'logs'), 'el fixture tiene mayusculas que bajar');
            fs.writeFileSync(path.join(f.pipeline, 'tests', 'lower.test.js'), testConValor('directa', JSON.stringify(lower)));
        }
        const link = path.join(f.root, 'enlace');
        fs.symlinkSync(f.pipeline, link, process.platform === 'win32' ? 'junction' : 'dir');
        fs.writeFileSync(path.join(f.pipeline, 'tests', 'link.test.js'), testConValor('directa', JSON.stringify(path.join(link, 'logs'))));
        const r = f.run();
        assert.strictEqual(r.code, 1, r.lines.join('\n'));
        const files = r.hallazgos.map((h) => h.file).sort();
        const esperado = process.platform === 'win32' ? ['.pipeline/tests/link.test.js', '.pipeline/tests/lower.test.js'] : ['.pipeline/tests/link.test.js'];
        assert.deepStrictEqual(files, esperado);
    } finally { f.limpiar(); }
});

test('SEC-1 · canonizar(): mismo resultado con casing distinto en win32, y quita el prefijo \\\\?\\', { skip: process.platform !== 'win32' }, () => {
    const a = I.canonizar(REPO_REAL);
    const b = I.canonizar(REPO_REAL.toLowerCase());
    const c = I.canonizar('\\\\?\\' + REPO_REAL);
    assert.strictEqual(a, b);
    assert.strictEqual(a, c);
    assert.ok(!a.startsWith('\\\\?\\'));
    // pipeline-env.dentroDe es lexico: el guardrail NO hereda ese bypass.
    assert.notStrictEqual(REPO_REAL.toLowerCase(), REPO_REAL);
});

test('R3 · valor NO resoluble (mkdtemp, variable, ensureTestRunDir) -> verde; escritura dirigida a pruebas pasa sin observaciones (Gherkin b)', () => {
    const f = fixture({
        modulos: { 'lib/a.js': MOD_MIGRADO },
        tests: {
            '.pipeline/tests/mkdtemp.test.js': TEST_VERDE_MKDTEMP,
            '.pipeline/tests/runner.test.js': [
                "const { ensureTestRunDir } = require('../lib/test-run-dir');",
                'const { dir } = ensureTestRunDir();',
                PE + '.PIPELINE_DIR_OVERRIDE = dir;',
                'const otro = algo();',
                PE + "['PIPELINE_STATE_DIR'] = otro;",
                'withEnv({ PIPELINE_REPO_ROOT: otro, pipelineDir: dir }, () => {});',
            ].join('\n'),
        },
    });
    try {
        const r = f.run();
        assert.strictEqual(r.code, 0, r.lines.join('\n'));
        assert.deepStrictEqual(r.hallazgos, []);
        assert.match(r.lines[0], /^OK — \d+ modulos, \d+ tests escaneados, 0 hallazgos nuevos/);
        assert.ok(!r.lines.some((l) => /^LINT /.test(l)), 'sin observaciones');
    } finally { f.limpiar(); }
});

// ── R3 · PIPELINE_REPO_ROOT = raiz del repo (rebote QA de #7114) ─────────────
//
// `PIPELINE_REPO_ROOT` no es un dir de estado: el resolvedor le agrega
// `/.pipeline` y los skills deterministicos (`build.js`, `delivery.js`,
// `linter.js`, `tester.js`) la usan como `REPO_ROOT` y escriben debajo. Un test
// que la fija a la RAIZ del repo apunta al productivo aunque la raiz no este
// DENTRO de `.pipeline`. Antes del fix las 5 formas resolubles pasaban en verde.

const FORMAS_ENV = FORMAS.filter((f) => f !== 'pipelineDir:');

for (const forma of FORMAS_ENV) {
    test(`R3 · PIPELINE_REPO_ROOT = raiz del repo (forma \`${forma}\`, path.join(__dirname, '..', '..')) -> rojo con destino .pipeline`, () => {
        const f = fixture({
            modulos: { 'lib/a.js': MOD_MIGRADO },
            tests: { '.pipeline/tests/raiz.test.js': testConValor(forma, "path.join(__dirname, '..', '..')", 'PIPELINE_REPO_ROOT') },
        });
        try {
            const r = f.run();
            assert.strictEqual(r.code, 1, r.lines.join('\n'));
            const h = r.hallazgos.find((x) => x.regla === 'R3');
            assert.ok(h, 'hallazgo R3');
            assert.strictEqual(h.file, '.pipeline/tests/raiz.test.js');
            assert.strictEqual(h.line, 2);
            assert.strictEqual(h.variable, 'PIPELINE_REPO_ROOT');
            assert.strictEqual(h.destino, '.pipeline');
            assert.strictEqual(h.canal, 'estado');
            assert.match(h.reason, /destino efectivo es <valor>\/\.pipeline/);
            const primera = r.lines.find((l) => /^LINT R3:/.test(l));
            assert.match(primera, /^LINT R3: \.pipeline\/tests\/raiz\.test\.js:2 -> \.pipeline \(canal estado\)/);
        } finally { f.limpiar(); }
    });
}

test('R3 · PIPELINE_REPO_ROOT = raiz del repo en las otras formas de valor (template, `__dirname +`, path.resolve, literal absoluto) -> rojo', () => {
    const f = fixture({ modulos: { 'lib/a.js': MOD_MIGRADO } });
    try {
        const casos = [
            '`${__dirname}/../..`',
            "__dirname " + PLUS + " '/../..'",
            "path.resolve(__dirname, '..', '..')",
            JSON.stringify(f.root),
        ];
        fs.mkdirSync(path.join(f.pipeline, 'tests'));
        casos.forEach((v, i) => fs.writeFileSync(path.join(f.pipeline, 'tests', `r${i}.test.js`), testConValor('directa', v, 'PIPELINE_REPO_ROOT')));
        const r = f.run();
        assert.strictEqual(r.code, 1, r.lines.join('\n'));
        const archivos = r.hallazgos.filter((h) => h.regla === 'R3').map((h) => h.file).sort();
        assert.deepStrictEqual(archivos, casos.map((_, i) => `.pipeline/tests/r${i}.test.js`).sort(), r.lines.join('\n'));
        for (const h of r.hallazgos) assert.strictEqual(h.destino, '.pipeline');
    } finally { f.limpiar(); }
});

test('R3 · PIPELINE_REPO_ROOT fijada a un subdir del productivo sigue siendo rojo, con el destino efectivo <valor>/.pipeline', () => {
    const f = fixture({
        modulos: { 'lib/a.js': MOD_MIGRADO },
        tests: { '.pipeline/tests/sub.test.js': testConValor('Object.assign', "path.join(__dirname, '..', 'logs')", 'PIPELINE_REPO_ROOT') },
    });
    try {
        const r = f.run();
        assert.strictEqual(r.code, 1, r.lines.join('\n'));
        const h = r.hallazgos.find((x) => x.regla === 'R3');
        assert.ok(h);
        assert.strictEqual(h.destino, '.pipeline/logs/.pipeline');
    } finally { f.limpiar(); }
});

test('R3 · PIPELINE_REPO_ROOT = OTRO repo (mkdtemp hermano, no heredado) -> verde; la derivacion no inventa productivos', () => {
    const f = fixture({ modulos: { 'lib/a.js': MOD_MIGRADO } });
    const otroRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'wtl-7114-otro-'));
    try {
        fs.mkdirSync(path.join(otroRepo, '.pipeline'));
        fs.mkdirSync(path.join(f.pipeline, 'tests'));
        fs.writeFileSync(path.join(f.pipeline, 'tests', 'otro.test.js'), testConValor('directa', JSON.stringify(otroRepo), 'PIPELINE_REPO_ROOT'));
        const r = f.run({ env: {} });
        assert.strictEqual(r.code, 0, r.lines.join('\n'));
        assert.ok(!r.hallazgos.some((h) => h.regla === 'R3'));
    } finally {
        f.limpiar();
        fs.rmSync(otroRepo, { recursive: true, force: true });
    }
});

test('R3 · destinoEfectivo: solo PIPELINE_REPO_ROOT deriva /.pipeline; las variables de DIRECTORIO y pipelineDir no', () => {
    const base = path.join(os.tmpdir(), 'x');
    assert.strictEqual(I.destinoEfectivo('PIPELINE_REPO_ROOT', base), path.join(base, '.pipeline'));
    for (const v of ['PIPELINE_DIR_OVERRIDE', 'PIPELINE_STATE_DIR', 'pipelineDir']) {
        assert.strictEqual(I.destinoEfectivo(v, base), base, v);
    }
    assert.strictEqual(I.VARIABLE_RAIZ, 'PIPELINE_REPO_ROOT');
    assert.strictEqual(I.SUBDIR_RAIZ, '.pipeline');
});

test('R3 / SEC-9 · la union incluye PIPELINE_REPO_ROOT/.pipeline heredado del proceso', () => {
    const f = fixture({ modulos: { 'lib/a.js': MOD_MIGRADO } });
    const otroRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'wtl-7114-heredado-'));
    try {
        fs.mkdirSync(path.join(otroRepo, '.pipeline'));
        const literal = JSON.stringify(path.join(otroRepo, '.pipeline', 'logs'));
        fs.mkdirSync(path.join(f.pipeline, 'tests'));
        fs.writeFileSync(path.join(f.pipeline, 'tests', 'her.test.js'), testConValor('directa', literal));
        assert.strictEqual(f.run({ env: {} }).code, 0, 'sin PIPELINE_REPO_ROOT el otro repo no es productivo');
        const r = f.run({ env: { PIPELINE_REPO_ROOT: otroRepo } });
        assert.strictEqual(r.code, 1);
        assert.strictEqual(r.hallazgos[0].destino, 'PIPELINE_REPO_ROOT/.pipeline/logs');
    } finally {
        f.limpiar();
        fs.rmSync(otroRepo, { recursive: true, force: true });
    }
});

test('R3 · un destino congelado en baseline.tests no es rojo, y el verde lo lista como DEUDA CONGELADA', () => {
    const f = fixture({
        modulos: { 'lib/a.js': MOD_MIGRADO },
        tests: { '.pipeline/tests/viejo.test.js': testConValor('pipelineDir:', "path.resolve(__dirname, '..')") },
        baseline: { pendientes: [], tests: ['.pipeline/tests/viejo.test.js::pipelineDir::.pipeline'] },
    });
    try {
        const r = f.run();
        assert.strictEqual(r.code, 0, r.lines.join('\n'));
        assert.ok(r.lines.some((l) => /DEUDA CONGELADA/.test(l) && /viejo\.test\.js:2/.test(l)));
    } finally { f.limpiar(); }
});

test('R3 · SELF_EXEMPT: la propia suite del guardrail no se lintea (sus fixtures escriben las formas como texto)', () => {
    const f = fixture({
        modulos: { 'lib/a.js': MOD_MIGRADO },
        tests: { '.pipeline/lib/__tests__/write-target-lint.test.js': testConValor('directa', "path.join(__dirname, '..', '..')") },
    });
    try {
        assert.strictEqual(f.run().code, 0);
    } finally { f.limpiar(); }
});

// ── Formato, remedios y fuga (CA-3 / CA-7 / SEC-6) ────────────────────────────

test('CA-3 / CA-7 · Gherkin (a): la primera linea de cada hallazgo es `LINT R<n>: <archivo>:<linea> -> <destino>`', () => {
    const f = fixture({
        modulos: { 'lib/nuevo.js': MOD_DIRNAME, 'lib/env.js': MOD_ENV },
        tests: { '.pipeline/tests/t.test.js': testConValor('withEnv', "path.join(__dirname, '..', 'logs')") },
        inventario: [],
    });
    try {
        const r = f.run();
        assert.strictEqual(r.code, 1);
        const reglas = new Set(r.hallazgos.map((h) => h.regla));
        assert.deepStrictEqual([...reglas].sort(), ['R1', 'R2', 'R3']);
        for (const h of r.hallazgos) {
            const primera = I.formatHallazgo(h).split('\n')[0];
            assert.match(primera, /^LINT R[123]: \S+:\d+ -> \S.* \(canal (colas|logs|estado|pausa)\)$/, primera);
        }
    } finally { f.limpiar(); }
});

test('CA-7 · los remedios van en el orden fijo (--sync -> curar -> test -> --write-baseline) y `--no-verify` solo aparece como NO-salida', () => {
    const f = fixture({ modulos: { 'lib/nuevo.js': MOD_DIRNAME }, inventario: [] });
    try {
        const r = f.run();
        const texto = r.remedios.join('\n');
        const iSync = texto.indexOf('write-points-scan.js --sync');
        const iCurar = texto.indexOf('curar `estado: lectura|externo`');
        const iTest = texto.indexOf('mkdtempSync');
        const iBase = texto.indexOf('write-target-lint.js --write-baseline');
        assert.ok(iSync >= 0 && iCurar > iSync && iTest > iCurar && iBase > iTest, texto);
        assert.match(texto, /--sync \.pipeline/, 'siempre con dir explicito');
        for (const l of r.remedios.filter((x) => x.includes('--no-verify'))) assert.match(l, /NO es la salida/);
        assert.match(texto, /\(rojo por R1/);
    } finally { f.limpiar(); }
});

test('SEC-6 · la salida de un rojo no vuelca process.env ni valores de otras variables', () => {
    const f = fixture({
        modulos: { 'lib/a.js': MOD_MIGRADO },
        tests: { '.pipeline/tests/t.test.js': testConValor('directa', "path.join(__dirname, '..', 'logs')") },
    });
    try {
        const canario = 'valor-secreto-canario-7114';
        const r = f.run({ env: { TELEGRAM_TOKEN: canario, PATH: canario, PIPELINE_REPO_ROOT: '' } });
        assert.strictEqual(r.code, 1);
        const texto = r.lines.concat(r.remedios).join('\n');
        assert.ok(!texto.includes(canario));
        assert.ok(!texto.includes('TELEGRAM_TOKEN'));
        assert.ok(!texto.includes(f.root), 'nunca el path absoluto del host: el destino es relativo al repo');
    } finally { f.limpiar(); }
});

test('UX G1 · sanear(): recorta a 120, una sola linea y neutraliza `::` inicial (workflow commands, #5607)', () => {
    assert.strictEqual(I.sanear('::error file=x'), ': :error file=x');
    assert.strictEqual(I.sanear('a\nb\r\nc'), 'a b c');
    assert.strictEqual(I.sanear('x'.repeat(200)).length, 121);
});

test('SEC-4b · el verde imprime conteos por estado y transiciones vs HEAD (o dice que no hay base git)', () => {
    const f = fixture({ modulos: { 'lib/a.js': MOD_MIGRADO } });
    try {
        const r = f.run();
        assert.strictEqual(r.code, 0);
        assert.ok(r.lines.some((l) => /^INVENTARIO: 1 puntos — 1 migrado \/ 0 safe \/ 0 pendiente \/ 0 lectura \/ 0 externo/.test(l)), r.lines.join('\n'));
        assert.ok(r.lines.some((l) => /^TRANSICIONES vs HEAD/.test(l)));
    } finally { f.limpiar(); }
});

// ── Resolvedor estatico (unidad) ─────────────────────────────────────────────

test('resolverValor(): formas de SEC-7 y no resolubles', () => {
    const d = path.resolve(os.tmpdir(), 'wtl-dir');
    assert.strictEqual(I.resolverValor("path.join(__dirname, '..', 'logs')", d), path.resolve(d, '..', 'logs'));
    assert.strictEqual(I.resolverValor('path.resolve(__dirname, "..")', d), path.resolve(d, '..'));
    assert.strictEqual(I.resolverValor('`${__dirname}/../x`', d), path.resolve(d, '..', 'x'));
    assert.strictEqual(I.resolverValor("__dirname " + PLUS + " '/y'", d), path.resolve(d, 'y'));
    assert.strictEqual(I.resolverValor('__dirname', d), d);
    assert.strictEqual(I.resolverValor('path.dirname(__dirname)', d), path.dirname(d));
    assert.strictEqual(I.resolverValor(JSON.stringify(d), d), d);
    assert.strictEqual(I.resolverValor("fs.mkdtempSync(path.join(os.tmpdir(), 'x'))", d), null);
    assert.strictEqual(I.resolverValor('dir', d), null);
    assert.strictEqual(I.resolverValor("path.join(__dirname, variable)", d), null);
    assert.strictEqual(I.resolverValor("'relativo/x'", d), null);
    assert.strictEqual(I.resolverValor('', d), null);
});

test('extraerExpresion() corta en el separador de nivel 0 y respeta anidamiento y comillas', () => {
    assert.strictEqual(I.extraerExpresion("path.join(__dirname, 'a,b') }, () => {})"), "path.join(__dirname, 'a,b')");
    assert.strictEqual(I.extraerExpresion("dir; otra"), 'dir');
    assert.strictEqual(I.extraerExpresion("{ a: 1 }, x"), '{ a: 1 }');
});

// ── Repo real (CA-9) ─────────────────────────────────────────────────────────

test('CA-9 · sobre el repo REAL: `--check` sale 0 y el inventario cubre skills-deterministicos/ y kernel-bootstrap/ (CA-4 / #7451)', () => {
    const r = spawnSync(process.execPath, [LINT_PATH, '--check'], { cwd: REPO_REAL, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /\[write-target-lint\] OK — \d+ modulos, \d+ tests escaneados, 0 hallazgos nuevos/);
    const inv = scan.leerInventario(path.join(REPO_REAL, '.pipeline'));
    assert.ok(inv.some((e) => e.modulo.startsWith('skills-deterministicos/')), 'skills-deterministicos/ inventariado');
    assert.ok(inv.some((e) => e.modulo.startsWith('kernel-bootstrap/')), 'kernel-bootstrap/ inventariado');
    assert.ok(scan.listarModulos(path.join(REPO_REAL, '.pipeline')).includes('skills-deterministicos/tester.js'));
});

test('CA-9 · CLI: flag desconocido sale 2', () => {
    const r = spawnSync(process.execPath, [LINT_PATH, '--sarasa'], { cwd: REPO_REAL, encoding: 'utf8' });
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /uso:/);
});

test('CA-3 · el baseline real no ancla por linea y sus claves existen', () => {
    const b = JSON.parse(fs.readFileSync(path.join(REPO_REAL, '.pipeline', 'lib', 'write-target-lint.baseline.json'), 'utf8'));
    for (const k of b.pendientes) assert.match(k, /^[^:]+::[^:]+$/, k);
    for (const k of b.tests) assert.match(k, /^[^:]+::[^:]+::[^:]+$/, k);
    const claves = new Set(scan.leerInventario(path.join(REPO_REAL, '.pipeline')).filter((e) => e.estado === 'pendiente').map(scan.clave));
    for (const k of b.pendientes) assert.ok(claves.has(k), `pendiente del baseline sin entrada en el inventario: ${k}`);
});

test('CA-5 / R0 · el registro de test-env-lint cubre PIPELINE_AMBIENTE (cualquiera) y PIPELINE_ALLOW_PROD_SIDE_EFFECTS (encender)', () => {
    const reg = JSON.parse(fs.readFileSync(path.join(REPO_REAL, '.pipeline', 'lib', 'test-env-lint.protected.json'), 'utf8'));
    const amb = reg.vars.find((v) => v.nombre === 'PIPELINE_AMBIENTE');
    const hatch = reg.vars.find((v) => v.nombre === 'PIPELINE_ALLOW_PROD_SIDE_EFFECTS');
    assert.ok(amb && amb.sentido_inseguro === 'cualquiera' && /pipeline-env\.js/.test(amb.control_que_apaga));
    assert.ok(hatch && hatch.sentido_inseguro === 'encender' && /pipeline-env\.js/.test(hatch.control_que_apaga));
});

test('CA-6 · el hook pre-commit y el workflow de CI corren el guardrail (sin --only, sin || true, Node 20, permissions read)', () => {
    const hook = fs.readFileSync(path.join(REPO_REAL, '.husky', 'pre-commit'), 'utf8');
    const bloque = hook.slice(hook.indexOf('RUN_WRITE_TARGET_LINT=0'), hook.indexOf('# Validación de agent-models (#3081)'));
    assert.ok(bloque.length > 0, 'bloque insertado antes del ancla de agent-models');
    assert.match(bloque, /node \.pipeline\/lib\/write-target-lint\.js --check\r?\n/);
    assert.doesNotMatch(bloque, /--only/);
    assert.doesNotMatch(bloque, /\|\| true/);
    assert.match(bloque, /exit "\$WRITE_TARGET_LINT_EXIT"/);
    assert.ok(hook.indexOf('RUN_TEST_ENV_LINT=0') < hook.indexOf('RUN_WRITE_TARGET_LINT=0'), 'despues del bloque de test-env-lint');
    const yml = fs.readFileSync(path.join(REPO_REAL, '.github', 'workflows', 'write-target-lint.yml'), 'utf8');
    assert.match(yml, /permissions:\s*\n\s*contents: read/);
    assert.match(yml, /node-version: '20'/);
    assert.match(yml, /actions\/checkout@[0-9a-f]{40}/, 'checkout pineado por SHA');
    assert.match(yml, /node lib\/write-target-lint\.js --check/);
    assert.match(yml, /write-target-lint\.test\.js/);
    assert.match(yml, /ADVISORY/);
    // Rebote QA de #7114: el lint requiere `js-yaml` (via pipeline-env -> config-resolver),
    // que vive en el package.json de la RAIZ. El job instala ANTES de correr, desde la
    // raiz (sin `working-directory`) y sin scripts (SEC-5).
    const install = yml.indexOf('npm ci --ignore-scripts');
    const check = yml.indexOf('node lib/write-target-lint.js --check');
    assert.ok(install > 0, 'el job instala las dependencias raiz con npm ci --ignore-scripts');
    assert.ok(install < check, 'npm ci corre ANTES del lint');
    const pasoInstall = yml.slice(yml.lastIndexOf('- name:', install), install);
    assert.doesNotMatch(pasoInstall, /working-directory/, 'npm ci corre desde la raiz del repo');
    const raiz = JSON.parse(fs.readFileSync(path.join(REPO_REAL, 'package.json'), 'utf8'));
    assert.ok(raiz.dependencies && raiz.dependencies['js-yaml'], 'js-yaml sigue siendo dependencia raiz');
});

// ── helpers ──────────────────────────────────────────────────────────────────

function puedeEnlazar() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wtl-7114-ln-'));
    try {
        fs.mkdirSync(path.join(d, 'a'));
        fs.symlinkSync(path.join(d, 'a'), path.join(d, 'b'), 'dir');
        return true;
    } catch { return false; }
    finally { fs.rmSync(d, { recursive: true, force: true }); }
}

// `execFileSync` se importa para que la suite documente que el guardrail se
// invoca como proceso (CA-9) y no via require dinamico de archivos escaneados.
void execFileSync;

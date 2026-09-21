'use strict';

// Test estático (#7517 CA-4 / CA-20 / SEC-10 — extendido por #7519 CA-20a /
// SEC-R9): los módulos read-only de `lib/model-value-audit/` no escriben, no
// abren red ni procesos, sólo `require` de `fs`, `path`, `crypto` o rutas
// relativas dentro de `lib/`, y los precios se leen exclusivamente vía
// `lib/pricing.js`. `audit.js` es el ÚNICO con primitivas de escritura, e
// `index.js` no lo conoce (C16). El CLI `scripts/model-value-report.js` entra
// a la misma policy (escrituras sólo vía `audit.registrar`).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MODULE_DIR = path.join(__dirname, '..');
// Read-only por contrato (CA-20a). `audit.js` queda fuera a propósito.
const MODULES = ['read-sources.js', 'sanitize.js', 'pricing-freshness.js', 'agent-quality-signal.js', 'recommender.js', 'report.js', 'index.js'];
const WRITER = 'audit.js';
const PIPELINE_DIR = path.resolve(MODULE_DIR, '..', '..');
const SCRIPT = path.join(PIPELINE_DIR, 'scripts', 'model-value-report.js');
const cliSource = () => fs.readFileSync(SCRIPT, 'utf8');

function source(name) {
    return fs.readFileSync(path.join(MODULE_DIR, name), 'utf8');
}

/** Quita comentarios de línea y de bloque para analizar sólo código. */
function sinComentarios(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
}

const ESCRITURA = /\b(?:writeFileSync|appendFileSync|appendChained|unlinkSync|renameSync|rmSync|mkdirSync|writeFile|copyFileSync|truncateSync|createWriteStream|openSync)\s*\(/;
const RED_O_PROCESOS = /require\(\s*['"](?:node:)?(?:child_process|net|http|https|dgram|tls|worker_threads|vm)['"]\s*\)/;
const REQUIRE_RE = /require\(\s*(['"])([^'"]+)\1\s*\)/g;
const REQUIRE_DINAMICO = /require\(\s*[^'")]/;
const PERMITIDOS = new Set(['fs', 'path', 'crypto', 'node:fs', 'node:path', 'node:crypto']);

test('todos los modulos existen y son archivos regulares', () => {
    for (const m of [...MODULES, WRITER]) {
        assert.ok(fs.statSync(path.join(MODULE_DIR, m)).isFile(), m);
    }
    assert.ok(fs.statSync(SCRIPT).isFile(), 'scripts/model-value-report.js');
});

test('ningun modulo read-only contiene primitivas de escritura (CA-20)', () => {
    for (const m of MODULES) {
        const codigo = sinComentarios(source(m));
        assert.ok(!ESCRITURA.test(codigo), `${m} contiene una primitiva de escritura`);
    }
    // El CLI tampoco: su única escritura es delegar en `audit.registrar`.
    const cli = sinComentarios(cliSource());
    assert.ok(!ESCRITURA.test(cli), 'el CLI contiene una primitiva de escritura');
    assert.match(cli, /audit\.registrar\(/, 'el CLI registra solo via audit.registrar');
});

test('audit.js es el UNICO con primitivas de escritura: solo las de ensureSecureAuditFile + UNA appendChained (CA-20a / SEC-R7)', () => {
    const codigo = sinComentarios(source(WRITER));
    const PERMITIDAS_WRITER = new Set(['mkdirSync', 'openSync', 'closeSync', 'chmodSync', 'appendChained']);
    const TODAS = /\b(writeFileSync|appendFileSync|appendChained|unlinkSync|renameSync|rmSync|mkdirSync|writeFile|copyFileSync|truncateSync|createWriteStream|openSync)\s*\(/g;
    const usadas = [...codigo.matchAll(TODAS)].map((m) => m[1]);
    assert.deepStrictEqual(usadas.filter((u) => !PERMITIDAS_WRITER.has(u)), [], 'audit.js usa primitivas no permitidas');
    assert.strictEqual(usadas.filter((u) => u === 'appendChained').length, 1, 'exactamente una appendChained');
    assert.ok(!/JSON\.parse/.test(codigo), 'audit.js no parsea nada');
    assert.match(codigo, /const AUDIT_FILE = 'model-value-audit\.jsonl'/, 'nombre de archivo constante');
    assert.match(codigo, /path\.join\(path\.resolve\([^)]*\)\), 'audit', AUDIT_FILE\)/, 'path bajo pipelineDir resuelto');
});

test('index.js no conoce el trail encadenado: sin require de ./audit ni la palabra audit (C16)', () => {
    const codigo = sinComentarios(source('index.js'));
    assert.ok(!/audit/.test(codigo), 'index.js contiene "audit"');
    assert.ok(!/require\(\s*['"]\.\/audit['"]\s*\)/.test(source('index.js')));
    assert.ok(!/require\(\s*['"]\.\.\/audit-log['"]\s*\)/.test(source('index.js')));
});

test('ningun fuente nuevo usa la consola global, parser YAML propio ni traceability.estimateCostUsd (SEC-R6 / CA-19 / C8)', () => {
    const consola = 'console' + '.log';
    for (const m of [...MODULES, WRITER]) {
        const codigo = sinComentarios(source(m));
        assert.ok(!codigo.includes(consola), `${m} usa ${consola}`);
        assert.ok(!/estimateCostUsd|require\(\s*['"]\.\.\/traceability['"]\s*\)/.test(codigo), `${m} reusa traceability`);
    }
    const cli = sinComentarios(cliSource());
    assert.ok(!cli.includes(consola), `el CLI usa ${consola}`);
    const sinDefaults = cli.replace(/deps\.stdout \|\| process\.stdout/g, '').replace(/deps\.stderr \|\| process\.stderr/g, '');
    assert.ok(!/process\.stdout\.write|process\.stderr\.write/.test(sinDefaults), 'el CLI escribe solo por deps.stdout/stderr');
    assert.ok(!/yaml/i.test(cli), 'el CLI no tiene parser YAML propio (CA-19)');
    assert.ok(!/estimateCostUsd|traceability/.test(cli));
});

test('ningun modulo abre red ni procesos (CA-20 / SEC-R9)', () => {
    const fuentes = [...MODULES, WRITER].map((m) => [m, sinComentarios(source(m))]);
    fuentes.push(['model-value-report.js', sinComentarios(cliSource())]);
    for (const [nombre, codigo] of fuentes) {
        assert.ok(!RED_O_PROCESOS.test(codigo), `${nombre} requiere child_process/net/http/https`);
        assert.ok(!/require\(\s*['"](?:node:)?(?:dns|cluster|repl)['"]\s*\)/.test(codigo), `${nombre} requiere dns/cluster/repl`);
        assert.ok(!/\beval\s*\(|new Function\s*\(/.test(codigo), `${nombre} usa eval/new Function`);
        assert.ok(!/\bprocess\.(?:exit|kill|spawn)\b/.test(codigo), `${nombre} toca process.exit/kill`);
    }
});

test('todo require es fs, path, crypto o una ruta relativa dentro de lib/ (SEC-10 / SEC-R9)', () => {
    for (const m of [...MODULES, WRITER]) {
        const codigo = sinComentarios(source(m));
        assert.ok(!REQUIRE_DINAMICO.test(codigo), `${m} tiene un require dinamico`);
        const encontrados = [...codigo.matchAll(REQUIRE_RE)].map((x) => x[2]);
        assert.ok(encontrados.length > 0, `${m} deberia requerir algo`);
        for (const spec of encontrados) {
            if (PERMITIDOS.has(spec)) continue;
            assert.ok(spec.startsWith('../') || spec.startsWith('./'), `${m}: require no permitido "${spec}"`);
            assert.ok(!spec.includes('node_modules'), `${m}: require de node_modules "${spec}"`);
            // La ruta relativa tiene que resolver dentro de `.pipeline/lib/`.
            const resuelto = path.resolve(MODULE_DIR, spec);
            const libDir = path.resolve(MODULE_DIR, '..');
            assert.ok(resuelto.startsWith(libDir + path.sep), `${m}: "${spec}" sale de lib/`);
        }
    }
    // El CLI: `node:path` + rutas relativas que resuelven dentro de .pipeline/lib/.
    const cli = sinComentarios(cliSource());
    assert.ok(!REQUIRE_DINAMICO.test(cli), 'el CLI tiene un require dinamico');
    for (const spec of [...cli.matchAll(REQUIRE_RE)].map((x) => x[2])) {
        if (PERMITIDOS.has(spec)) continue;
        const resuelto = path.resolve(path.dirname(SCRIPT), spec);
        assert.ok(resuelto.startsWith(path.join(PIPELINE_DIR, 'lib') + path.sep), `CLI: require no permitido "${spec}"`);
    }
});

test('los precios se leen solo via lib/pricing.js: sin nombre del archivo de precios ni JSON.parse propio (CA-4)', () => {
    // El nombre se arma por concatenación para que este test no sea el que
    // introduzca la cadena en el directorio.
    const archivoPrecios = 'pricing' + '.json';
    const rutaPrecios = 'metrics/' + 'pricing';
    for (const f of fs.readdirSync(MODULE_DIR).filter((n) => n.endsWith('.js'))) {
        const src = source(f);
        assert.ok(!src.includes(archivoPrecios), `${f} contiene la cadena del archivo de precios`);
        assert.ok(!src.includes(rutaPrecios), `${f} contiene la ruta de la tabla de precios`);
    }
    for (const f of fs.readdirSync(__dirname).filter((n) => n.endsWith('.js'))) {
        const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
        assert.ok(!src.includes(archivoPrecios), `${f} contiene la cadena del archivo de precios`);
        assert.ok(!src.includes(rutaPrecios), `${f} contiene la ruta de la tabla de precios`);
    }
    const freshness = sinComentarios(source('pricing-freshness.js'));
    assert.ok(!/JSON\.parse/.test(freshness), 'pricing-freshness.js no parsea JSON por su cuenta');
    assert.ok(/require\(\s*['"]\.\.\/pricing['"]\s*\)/.test(freshness), 'pricing-freshness.js usa lib/pricing.js');
    assert.ok(/invalidateCache\(\)/.test(freshness), 'pricing-freshness.js invalida la cache al inicio');
    assert.ok(/pricingByProvider\(\)/.test(freshness), 'missing_models usa pricingByProvider');
    assert.ok(!/getPricing\s*\(/.test(freshness), 'missing_models no usa getPricing (A4)');
    // Los otros dos módulos de la parte 1 no tocan precios en absoluto.
    for (const m of ['read-sources.js', 'sanitize.js']) {
        assert.ok(!/pricing/i.test(sinComentarios(source(m))), `${m} no deberia mencionar precios`);
    }
    // El recommender consulta la tabla SOLO por `pricingByProvider()` y por clave
    // (`hasOwnProperty`), nunca `getPricing` ni `flatMergedPricing` (C4).
    const recommender = sinComentarios(source('recommender.js'));
    assert.match(recommender, /pricingByProvider\(\)/);
    assert.ok(!/getPricing\s*\(|flatMergedPricing/.test(recommender), 'recommender no usa getPricing/flatMergedPricing');
    assert.match(sinComentarios(source('index.js')), /invalidateCache\(\)/, 'index invalida la cache una vez por corrida');
});

test('los enums de vocabulario cerrado estan exportados y congelados (CA-13 / SEC-R1)', () => {
    const rs = require('../read-sources');
    const pf = require('../pricing-freshness');
    const rec = require('../recommender');
    for (const [nombre, e] of [['REASON', rs.REASON], ['INTEGRIDAD_ESTADO', rs.INTEGRIDAD_ESTADO], ['MOTIVO', pf.MOTIVO], ['SOURCE_KIND', pf.SOURCE_KIND],
        ['VERDICT', rec.VERDICT], ['RIESGO', rec.RIESGO], ['ADVERTENCIAS', rec.ADVERTENCIAS]]) {
        assert.ok(e && typeof e === 'object' && Object.isFrozen(e), `${nombre} congelado`);
        assert.ok(Object.values(e).every((v) => typeof v === 'string' && /^[a-z][a-z0-9_]*$/.test(v)), `${nombre} solo con ids snake_case`);
    }
    // Ningún literal de `reason:`/`motivo:`/`estado:` suelto en el código fuera del enum.
    const rsCode = sinComentarios(source('read-sources.js'));
    const pfCode = sinComentarios(source('pricing-freshness.js'));
    assert.ok(!/reason:\s*['"]/.test(rsCode), 'read-sources emite reason via REASON');
    assert.ok(!/estado:\s*['"]/.test(rsCode), 'read-sources emite estado via INTEGRIDAD_ESTADO');
    assert.ok(!/motivo\s*=\s*['"]/.test(pfCode), 'pricing-freshness emite motivo via MOTIVO');
    assert.ok(Object.isFrozen(rec.MOTIVOS) && rec.MOTIVOS.every((m) => /^[a-z_]+$/.test(m)), 'MOTIVOS congelado y snake_case');
    // Ningún veredicto ni riesgo se emite como literal suelto en el recommender.
    const recCode = sinComentarios(source('recommender.js'));
    assert.ok(!/veredicto:\s*['"]/.test(recCode), 'recommender emite veredicto via VERDICT');
    assert.ok(!/riesgo_estimado:\s*['"]/.test(recCode), 'recommender emite riesgo via RIESGO');
});

test('no hay package.json ni lockfile dentro del modulo (SEC-10)', () => {
    const nombres = fs.readdirSync(MODULE_DIR);
    for (const n of nombres) {
        assert.ok(!/^package(-lock)?\.json$/.test(n), `no debe existir ${n}`);
    }
});

test('ningun archivo de test contiene un literal de la denylist de handoff (SEC-7b)', () => {
    const handoff = require('../../handoff');
    for (const f of fs.readdirSync(__dirname).filter((n) => n.endsWith('.js'))) {
        const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
        assert.deepStrictEqual(handoff.detectInjection(src).hits, [], `${f} dispara detectInjection`);
    }
    for (const m of [...MODULES, WRITER]) {
        assert.deepStrictEqual(handoff.detectInjection(source(m)).hits, [], `${m} dispara detectInjection`);
    }
    assert.deepStrictEqual(handoff.detectInjection(cliSource()).hits, [], 'el CLI dispara detectInjection');
    const cliTests = path.join(PIPELINE_DIR, 'scripts', '__tests__');
    for (const f of fs.readdirSync(cliTests).filter((n) => n.endsWith('.js'))) {
        assert.deepStrictEqual(handoff.detectInjection(fs.readFileSync(path.join(cliTests, f), 'utf8')).hits, [], `${f} dispara detectInjection`);
    }
});

'use strict';

// Test estático (#7517, CA-4 / CA-20 / SEC-10): los tres módulos de
// `lib/model-value-audit/` son read-only, sin red ni procesos, sólo `require`
// de `fs`, `path`, `crypto` o rutas relativas dentro de `lib/`, y los precios
// se leen exclusivamente vía `lib/pricing.js`.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MODULE_DIR = path.join(__dirname, '..');
const MODULES = ['read-sources.js', 'sanitize.js', 'pricing-freshness.js'];

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

test('los tres modulos existen y son archivos regulares', () => {
    for (const m of MODULES) {
        assert.ok(fs.statSync(path.join(MODULE_DIR, m)).isFile(), m);
    }
});

test('ningun modulo contiene primitivas de escritura (CA-20)', () => {
    for (const m of MODULES) {
        const codigo = sinComentarios(source(m));
        assert.ok(!ESCRITURA.test(codigo), `${m} contiene una primitiva de escritura`);
    }
});

test('ningun modulo abre red ni procesos (CA-20)', () => {
    for (const m of MODULES) {
        const codigo = sinComentarios(source(m));
        assert.ok(!RED_O_PROCESOS.test(codigo), `${m} requiere child_process/net/http/https`);
        assert.ok(!/\bprocess\.(?:exit|kill|spawn)\b/.test(codigo), `${m} toca process.exit/kill`);
    }
});

test('todo require es fs, path, crypto o una ruta relativa dentro de lib/ (SEC-10)', () => {
    for (const m of MODULES) {
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
    // Los otros dos módulos no tocan precios en absoluto.
    for (const m of ['read-sources.js', 'sanitize.js']) {
        assert.ok(!/pricing/i.test(sinComentarios(source(m))), `${m} no deberia mencionar precios`);
    }
});

test('los enums de vocabulario cerrado estan exportados y congelados (CA-13)', () => {
    const rs = require('../read-sources');
    const pf = require('../pricing-freshness');
    for (const [nombre, e] of [['REASON', rs.REASON], ['INTEGRIDAD_ESTADO', rs.INTEGRIDAD_ESTADO], ['MOTIVO', pf.MOTIVO], ['SOURCE_KIND', pf.SOURCE_KIND]]) {
        assert.ok(e && typeof e === 'object' && Object.isFrozen(e), `${nombre} congelado`);
        assert.ok(Object.values(e).every((v) => typeof v === 'string' && /^[a-z_]+$/.test(v)), `${nombre} solo con ids snake_case`);
    }
    // Ningún literal de `reason:`/`motivo:`/`estado:` suelto en el código fuera del enum.
    const rsCode = sinComentarios(source('read-sources.js'));
    const pfCode = sinComentarios(source('pricing-freshness.js'));
    assert.ok(!/reason:\s*['"]/.test(rsCode), 'read-sources emite reason via REASON');
    assert.ok(!/estado:\s*['"]/.test(rsCode), 'read-sources emite estado via INTEGRIDAD_ESTADO');
    assert.ok(!/motivo\s*=\s*['"]/.test(pfCode), 'pricing-freshness emite motivo via MOTIVO');
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
    for (const m of MODULES) {
        assert.deepStrictEqual(handoff.detectInjection(source(m)).hits, [], `${m} dispara detectInjection`);
    }
});

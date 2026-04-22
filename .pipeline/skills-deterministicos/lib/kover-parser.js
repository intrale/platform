/**
 * kover-parser.js — parser determinístico de reportes Kover (XML JaCoCo)
 * y de resultados JUnit (surefire) para el skill /tester determinístico.
 *
 * Uso:
 *   const { parseKoverXml, parseTestResultsXml, aggregateKover,
 *           aggregateTestResults, renderCoverageSection,
 *           renderTestsSection } = require('./kover-parser');
 *   const cov = parseKoverXml(fs.readFileSync('koverReport.xml', 'utf8'));
 *   const tr  = parseTestResultsXml(fs.readFileSync('TEST-Foo.xml', 'utf8'));
 *
 * No usamos un DOM parser externo — regex simple sobre los patrones de
 * JaCoCo/Kover/Surefire, que son estables. Si el XML está malformado,
 * los counters quedan en 0 y el resultado se marca como `valid: false`.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ── Kover / JaCoCo XML ───────────────────────────────────────────────
// Los reportes Kover usan el formato JaCoCo con <counter type="X" missed="N" covered="M"/>
// El totalizador del report está al nivel <report>...<counter/></report> (no anidado
// dentro de <package> ni <class>). Para calcularlo robustamente sumamos todos los
// counters de nivel `package` (siblings directos de <report>).

const RE_COUNTER = /<counter\s+type="([A-Z]+)"\s+missed="(\d+)"\s+covered="(\d+)"\s*\/>/g;
const RE_PACKAGE_BLOCK = /<package\b[^>]*>([\s\S]*?)<\/package>/g;

function emptyCoverage() {
    return {
        valid: false,
        total: {
            instruction: { missed: 0, covered: 0, percent: 0 },
            branch:      { missed: 0, covered: 0, percent: 0 },
            line:        { missed: 0, covered: 0, percent: 0 },
            method:      { missed: 0, covered: 0, percent: 0 },
            class:       { missed: 0, covered: 0, percent: 0 },
        },
        packages: [],
    };
}

function percent(covered, missed) {
    const total = covered + missed;
    if (total === 0) return 0;
    return Math.round((covered * 10000) / total) / 100; // 2 decimales
}

function extractPackageCounters(block) {
    // Los counters del totalizador de un <package> aparecen al final del bloque,
    // después de todos los <class>. Tomamos los últimos 5 (instr/branch/line/method/class).
    // Estrategia más simple y robusta: sumar counters que están a nivel directo del
    // package (no dentro de <class> ni <method>). Usamos una regex que asume que
    // esos counters aparecen después del último </class>.
    const lastClassClose = block.lastIndexOf('</class>');
    const tail = lastClassClose === -1 ? block : block.substring(lastClassClose);
    const out = {
        instruction: { missed: 0, covered: 0 },
        branch:      { missed: 0, covered: 0 },
        line:        { missed: 0, covered: 0 },
        method:      { missed: 0, covered: 0 },
        class:       { missed: 0, covered: 0 },
    };
    let m;
    RE_COUNTER.lastIndex = 0;
    while ((m = RE_COUNTER.exec(tail)) !== null) {
        const [, type, missed, covered] = m;
        const key = type.toLowerCase();
        if (out[key]) {
            out[key].missed += parseInt(missed, 10);
            out[key].covered += parseInt(covered, 10);
        }
    }
    return out;
}

/**
 * Parsea un reporte Kover XML (formato JaCoCo).
 * @param {string} xml
 * @returns {object} con totales por tipo de counter y lista de paquetes.
 */
function parseKoverXml(xml) {
    const result = emptyCoverage();
    if (!xml || typeof xml !== 'string') return result;

    // Verificación mínima: debe contener <report ...>
    if (!/<report\b/.test(xml)) return result;

    result.valid = true;

    // Iterar todos los <package> y sumar sus counters de nivel
    RE_PACKAGE_BLOCK.lastIndex = 0;
    let pkgMatch;
    while ((pkgMatch = RE_PACKAGE_BLOCK.exec(xml)) !== null) {
        const block = pkgMatch[0];
        const nameMatch = block.match(/^<package\s+name="([^"]+)"/);
        const pkgName = nameMatch ? nameMatch[1] : '(unnamed)';
        const counters = extractPackageCounters(block);
        result.packages.push({
            name: pkgName,
            line_percent: percent(counters.line.covered, counters.line.missed),
            branch_percent: percent(counters.branch.covered, counters.branch.missed),
            line: counters.line,
            branch: counters.branch,
            instruction: counters.instruction,
            method: counters.method,
            class: counters.class,
        });
        // Acumular al total
        for (const k of ['instruction', 'branch', 'line', 'method', 'class']) {
            result.total[k].missed += counters[k].missed;
            result.total[k].covered += counters[k].covered;
        }
    }

    // Calcular porcentajes totales
    for (const k of Object.keys(result.total)) {
        result.total[k].percent = percent(result.total[k].covered, result.total[k].missed);
    }

    return result;
}

/**
 * Agrega varios resultados de Kover (ej: backend + app) en uno solo.
 */
function aggregateKover(results) {
    const agg = emptyCoverage();
    agg.valid = results.some((r) => r && r.valid);
    for (const r of results) {
        if (!r || !r.valid) continue;
        for (const k of ['instruction', 'branch', 'line', 'method', 'class']) {
            agg.total[k].missed += r.total[k].missed;
            agg.total[k].covered += r.total[k].covered;
        }
        for (const pkg of r.packages || []) agg.packages.push(pkg);
    }
    for (const k of Object.keys(agg.total)) {
        agg.total[k].percent = percent(agg.total[k].covered, agg.total[k].missed);
    }
    return agg;
}

// ── JUnit / Surefire test results XML ─────────────────────────────────
// Gradle escribe uno por test class:
//   <testsuite name="..." tests="N" skipped="N" failures="N" errors="N" time="X.X">
//     <testcase classname="..." name="..." time="X.X">
//       <failure message="..." type="...">stack</failure>
//     </testcase>
//   </testsuite>

const RE_TESTSUITE = /<testsuite\b([^>]*)>/;
const RE_TESTCASE_BLOCK = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
const RE_ATTR = /(\w+)="([^"]*)"/g;

function parseAttrs(str) {
    const out = {};
    RE_ATTR.lastIndex = 0;
    let m;
    while ((m = RE_ATTR.exec(str)) !== null) {
        out[m[1]] = m[2];
    }
    return out;
}

function parseTestResultsXml(xml) {
    const result = {
        valid: false,
        suite: null,
        tests: 0,
        failures: 0,
        errors: 0,
        skipped: 0,
        time_seconds: 0,
        failed_tests: [],
    };
    if (!xml || typeof xml !== 'string') return result;

    const suiteMatch = xml.match(RE_TESTSUITE);
    if (!suiteMatch) return result;
    const attrs = parseAttrs(suiteMatch[1]);

    result.valid = true;
    result.suite = attrs.name || null;
    result.tests = parseInt(attrs.tests || '0', 10);
    result.failures = parseInt(attrs.failures || '0', 10);
    result.errors = parseInt(attrs.errors || '0', 10);
    result.skipped = parseInt(attrs.skipped || '0', 10);
    result.time_seconds = parseFloat(attrs.time || '0');

    // Recolectar failed tests con mensaje
    RE_TESTCASE_BLOCK.lastIndex = 0;
    let tc;
    while ((tc = RE_TESTCASE_BLOCK.exec(xml)) !== null) {
        const tcAttrs = parseAttrs(tc[1]);
        const body = tc[2] || '';
        const failureMatch = body.match(/<failure\b([^>]*?)(?:\/>|>([\s\S]*?)<\/failure>)/);
        const errorMatch = body.match(/<error\b([^>]*?)(?:\/>|>([\s\S]*?)<\/error>)/);
        if (failureMatch || errorMatch) {
            const failAttrs = parseAttrs((failureMatch || errorMatch)[1]);
            result.failed_tests.push({
                classname: tcAttrs.classname || '(sin clase)',
                name: tcAttrs.name || '(sin nombre)',
                time: parseFloat(tcAttrs.time || '0'),
                type: errorMatch ? 'error' : 'failure',
                message: (failAttrs.message || '').slice(0, 500),
                stack_snippet: ((failureMatch || errorMatch)[2] || '').trim().split(/\r?\n/).slice(0, 3).join(' | ').slice(0, 500),
            });
        }
    }

    return result;
}

function aggregateTestResults(results) {
    const agg = {
        valid: results.some((r) => r && r.valid),
        tests: 0,
        failures: 0,
        errors: 0,
        skipped: 0,
        time_seconds: 0,
        suites: 0,
        failed_tests: [],
    };
    for (const r of results) {
        if (!r || !r.valid) continue;
        agg.suites += 1;
        agg.tests += r.tests;
        agg.failures += r.failures;
        agg.errors += r.errors;
        agg.skipped += r.skipped;
        agg.time_seconds += r.time_seconds;
        for (const ft of r.failed_tests) agg.failed_tests.push(ft);
    }
    return agg;
}

/**
 * Escanea un árbol `build/test-results/**\/TEST-*.xml` de un módulo Gradle
 * y devuelve todos los archivos encontrados.
 */
function findTestResultFiles(moduleDir) {
    const found = [];
    const roots = [
        path.join(moduleDir, 'build', 'test-results'),
    ];
    for (const root of roots) {
        if (!fs.existsSync(root)) continue;
        const stack = [root];
        while (stack.length > 0) {
            const cur = stack.pop();
            let entries;
            try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
            for (const ent of entries) {
                const full = path.join(cur, ent.name);
                if (ent.isDirectory()) stack.push(full);
                else if (ent.isFile() && /^TEST-.*\.xml$/i.test(ent.name)) found.push(full);
            }
        }
    }
    return found;
}

/**
 * Escanea rutas estándar de reportes Kover. Devuelve archivos XML encontrados.
 */
function findKoverXmlFiles(moduleDir) {
    const found = [];
    const candidates = [
        path.join(moduleDir, 'build', 'reports', 'kover', 'report.xml'),
        path.join(moduleDir, 'build', 'reports', 'kover', 'koverReport.xml'),
        path.join(moduleDir, 'build', 'reports', 'kover', 'xml', 'report.xml'),
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) found.push(c);
    }
    return found;
}

// ── Render markdown ───────────────────────────────────────────────────

function renderCoverageSection(kover, threshold = 80) {
    const lines = [];
    lines.push('### Cobertura');
    if (!kover.valid) {
        lines.push('- ⏭️ Sin reporte Kover (no se solicitó `--coverage` o el XML no existe)');
        return lines.join('\n');
    }
    const linePct = kover.total.line.percent;
    const brPct = kover.total.branch.percent;
    const icon = (p) => p >= threshold ? '✅' : '❌';
    lines.push(`- Líneas: ${linePct}% ${icon(linePct)} (umbral ${threshold}%)  ·  ${kover.total.line.covered}/${kover.total.line.covered + kover.total.line.missed}`);
    lines.push(`- Ramas: ${brPct}%  ·  ${kover.total.branch.covered}/${kover.total.branch.covered + kover.total.branch.missed}`);
    lines.push(`- Métodos: ${kover.total.method.percent}%  ·  Clases: ${kover.total.class.percent}%`);
    lines.push(`- Paquetes analizados: ${kover.packages.length}`);
    // Top 3 paquetes más flojos (por cobertura de líneas, ignorando los de 0)
    const weak = [...kover.packages]
        .filter((p) => (p.line.covered + p.line.missed) > 0)
        .sort((a, b) => a.line_percent - b.line_percent)
        .slice(0, 3);
    if (weak.length > 0 && linePct < threshold) {
        lines.push('- Paquetes bajo umbral:');
        for (const p of weak) {
            if (p.line_percent >= threshold) break;
            lines.push(`  - \`${p.name}\` — ${p.line_percent}% líneas`);
        }
    }
    return lines.join('\n');
}

function renderTestsSection(tests) {
    const lines = [];
    lines.push('### Tests');
    if (!tests.valid) {
        lines.push('- ⏭️ No se encontraron reportes JUnit');
        return lines.join('\n');
    }
    const passed = tests.tests - tests.failures - tests.errors - tests.skipped;
    const verdict = (tests.failures === 0 && tests.errors === 0) ? '✅' : '❌';
    lines.push(`- Total: ${tests.tests} · Pasaron: ${passed} · Fallaron: ${tests.failures} · Errores: ${tests.errors} · Skipped: ${tests.skipped} ${verdict}`);
    lines.push(`- Tiempo total: ${tests.time_seconds.toFixed(1)}s  ·  Suites: ${tests.suites}`);
    if (tests.failed_tests.length > 0) {
        lines.push('- Tests fallidos:');
        for (const ft of tests.failed_tests.slice(0, 10)) {
            const loc = `${ft.classname} > ${ft.name}`;
            lines.push(`  - **${loc}**`);
            if (ft.message) lines.push(`    - ${ft.message.split('\n')[0].slice(0, 200)}`);
        }
        if (tests.failed_tests.length > 10) {
            lines.push(`  - _(…${tests.failed_tests.length - 10} más)_`);
        }
    }
    return lines.join('\n');
}

module.exports = {
    parseKoverXml,
    parseTestResultsXml,
    aggregateKover,
    aggregateTestResults,
    findTestResultFiles,
    findKoverXmlFiles,
    renderCoverageSection,
    renderTestsSection,
    percent,
};

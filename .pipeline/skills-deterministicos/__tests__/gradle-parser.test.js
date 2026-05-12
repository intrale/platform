// Tests de .pipeline/skills-deterministicos/lib/gradle-parser.js (issue #2476)
// Valida parseo de BUILD SUCCESSFUL/FAILED, clasificación de errores conocidos
// y render del reporte markdown.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
    parseGradleOutput,
    classifyError,
    renderMarkdownReport,
    ERROR_PATTERNS,
} = require('../lib/gradle-parser');

const FIXTURES = path.join(__dirname, 'fixtures');
const readFixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

test('parseGradleOutput — BUILD SUCCESSFUL clásico extrae duración, módulos y verificaciones', () => {
    const out = readFixture('build-successful.txt');
    const r = parseGradleOutput(out);

    assert.equal(r.success, true);
    assert.equal(r.build_status, 'SUCCESSFUL');
    assert.equal(r.duration_ms, 83000); // 1m 23s = 83s
    assert.equal(r.errors.length, 0);
    assert.ok(r.modules.includes('backend'));
    assert.ok(r.modules.includes('users'));
    assert.ok(r.modules.includes('app'));
    assert.equal(r.verifications.verifyNoLegacyStrings, true);
    assert.equal(r.verifications.validateComposeResources, true);
    assert.equal(r.verifications.scanNonAsciiFallbacks, true);
    assert.equal(r.tasks.total, 47);
    assert.equal(r.tasks.executed, 12);
    assert.equal(r.tasks.up_to_date, 30);
    assert.equal(r.tasks.from_cache, 5);
});

test('parseGradleOutput — BUILD FAILED con forbidden-strings clasifica y escala a android-dev', () => {
    const out = readFixture('build-failed-forbidden-strings.txt');
    const r = parseGradleOutput(out);

    assert.equal(r.success, false);
    assert.equal(r.build_status, 'FAILED');
    assert.equal(r.duration_ms, 12000);
    assert.ok(r.errors.length >= 1);
    const err = r.errors[0];
    assert.equal(err.classification, 'forbidden_strings');
    assert.equal(err.escalate_to, 'android-dev');
    assert.ok(err.message.includes('verifyNoLegacyStrings'));
    assert.equal(r.verifications.verifyNoLegacyStrings, false);
});

test('parseGradleOutput — BUILD FAILED con JAVA_HOME clasifica como infra sin escalación', () => {
    const out = readFixture('build-failed-java-home.txt');
    const r = parseGradleOutput(out);

    assert.equal(r.success, false);
    assert.equal(r.build_status, 'FAILED');
    assert.ok(r.errors.length >= 1);
    const err = r.errors[0];
    assert.equal(err.classification, 'java_home');
    assert.equal(err.severity, 'infra');
    assert.equal(err.escalate_to, null);
});

test('parseGradleOutput — error unresolved reference en :backend escala a backend-dev', () => {
    const out = readFixture('build-failed-unresolved.txt');
    const r = parseGradleOutput(out);

    assert.equal(r.success, false);
    assert.ok(r.errors.length >= 1);
    const err = r.errors[0];
    assert.equal(err.classification, 'unresolved_reference');
    assert.equal(err.escalate_to, 'backend-dev');
    assert.equal(err.task, ':backend:compileKotlin');
});

test('parseGradleOutput — output vacío no rompe y retorna UNKNOWN', () => {
    const r = parseGradleOutput('', '');
    assert.equal(r.success, false);
    assert.equal(r.build_status, 'UNKNOWN');
    assert.equal(r.errors.length, 0);
    assert.equal(r.duration_ms, 0);
});

test('classifyError — detecta todos los patrones conocidos', () => {
    assert.equal(classifyError('OutOfMemoryError: Java heap space').type, 'oom');
    assert.equal(classifyError('Kotlin version mismatch in metadata').type, 'kotlin_version_mismatch');
    assert.equal(classifyError('stringResource(Res.string.x)').type, 'forbidden_strings');
    assert.equal(classifyError('e: error: type mismatch: required Int, found String').type, 'type_mismatch');
    assert.equal(classifyError('Something unusual happened').type, 'unknown');
});

test('classifyError — unknown en :users escala a backend-dev', () => {
    const r = classifyError('Mysterious gradle issue', ':users:check');
    assert.equal(r.type, 'unknown');
    assert.equal(r.escalate_to, 'backend-dev');
});

test('classifyError — unknown en :app escala a android-dev', () => {
    const r = classifyError('Weird app failure', ':app:composeApp:compileKotlin');
    assert.equal(r.type, 'unknown');
    assert.equal(r.escalate_to, 'android-dev');
});

test('renderMarkdownReport — build exitoso incluye todas las secciones', () => {
    const r = parseGradleOutput(readFixture('build-successful.txt'));
    const md = renderMarkdownReport(r, { issue: 2476, scope: 'smart' });
    assert.ok(md.includes('## Build: EXITOSO'));
    assert.ok(md.includes('### Compilacion'));
    assert.ok(md.includes('### Verificaciones'));
    assert.ok(md.includes('### Veredicto del Builder'));
    assert.ok(md.includes('issue #2476'));
    assert.ok(md.includes('smart'));
    assert.ok(md.includes('Strings legacy: ✅'));
});

test('renderMarkdownReport — build fallido incluye sección Errores con clasificación', () => {
    const r = parseGradleOutput(readFixture('build-failed-forbidden-strings.txt'));
    const md = renderMarkdownReport(r, { issue: 2476 });
    assert.ok(md.includes('## Build: FALLIDO'));
    assert.ok(md.includes('### Errores'));
    assert.ok(md.includes('[forbidden_strings]'));
    assert.ok(md.includes('android-dev'));
    assert.ok(md.includes('Hay errores que corregir'));
});

test('ERROR_PATTERNS — cada patrón tiene type, regex, fix y severity', () => {
    for (const p of ERROR_PATTERNS) {
        assert.ok(p.type, `pattern sin type: ${JSON.stringify(p)}`);
        assert.ok(p.regex instanceof RegExp, `pattern sin regex válido: ${p.type}`);
        assert.ok(p.severity, `pattern sin severity: ${p.type}`);
    }
});

// ── smart-build no-op (issue #3078 — rebote 3) ───────────────────────
// Regression: cuando los cambios no afectan módulos Gradle (típico en issues
// que solo tocan .pipeline/* o docs/), smart-build.sh sale con exit 0 sin
// invocar Gradle, así que NO aparece "BUILD SUCCESSFUL" en stdout. Antes del
// fix el parser dejaba success=false por default y el build skill rebotaba
// con "Build FAILED sin error clasificado".

test('parseGradleOutput — smart-build no-op "Sin cambios detectados" se clasifica como NO_OP exitoso', () => {
    const stdout = '>> Smart Build — detectando módulos afectados\n>> Sin cambios detectados. Nada que compilar.\n';
    const r = parseGradleOutput(stdout);
    assert.equal(r.success, true);
    assert.equal(r.build_status, 'NO_OP');
    assert.equal(r.errors.length, 0);
});

test('parseGradleOutput — smart-build no-op "no afectan módulos compilables" se clasifica como NO_OP', () => {
    const stdout = '>> Smart Build — detectando módulos afectados\n>> Archivos cambiados:\nscripts/foo.sh\n>> Los cambios no afectan módulos compilables (docs, scripts, etc.)\n';
    const r = parseGradleOutput(stdout);
    assert.equal(r.success, true);
    assert.equal(r.build_status, 'NO_OP');
    assert.equal(r.errors.length, 0);
});

test('parseGradleOutput — BUILD SUCCESSFUL real convive con frase NO_OP en el output sin romper', () => {
    // Si el output contiene ambos (ej. logs concatenados), igual debe
    // clasificar como éxito. La precedencia exacta no importa mientras
    // success=true.
    const stdout = 'Sin cambios detectados. Nada que compilar.\n> Task :backend:compileKotlin\nBUILD SUCCESSFUL in 5s\n';
    const r = parseGradleOutput(stdout);
    assert.equal(r.success, true);
    assert.ok(r.build_status === 'NO_OP' || r.build_status === 'SUCCESSFUL');
});

test('parseGradleOutput — output sin BUILD SUCCESSFUL ni NO_OP sigue UNKNOWN/success=false (no regresión)', () => {
    // Salvaguarda: el fix no debe romper el caso histórico de output
    // truncado/vacío. build.js tiene defensa adicional por exit_code === 0
    // para esos casos.
    const r = parseGradleOutput('algun output random sin keywords\n');
    assert.equal(r.success, false);
    assert.equal(r.build_status, 'UNKNOWN');
});

test('renderMarkdownReport — NO_OP usa veredicto específico, no "FALLIDO"', () => {
    const stdout = '>> Sin cambios detectados. Nada que compilar.\n';
    const r = parseGradleOutput(stdout);
    const md = renderMarkdownReport(r, { issue: 3078, scope: 'smart' });
    assert.ok(md.includes('NO-OP'), `Esperaba "NO-OP" en el reporte: ${md}`);
    assert.ok(!md.includes('FALLIDO'), `No debería decir "FALLIDO" para no-op: ${md}`);
    assert.ok(
        md.includes('no afectan módulos') || md.includes('sin compilar'),
        `Veredicto debería explicar el no-op: ${md}`
    );
});

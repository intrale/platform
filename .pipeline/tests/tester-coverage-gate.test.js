// Tests del gate de relevancia de cobertura del tester determinístico (#6362).
//
// Contexto del rebote que originó el fix: el tester rechazó #6362 con
// "Cobertura de líneas 36.05% por debajo del umbral 80%" sobre un diff con
// 6761 tests en verde y CERO archivos `.kt`/`.java`. El único archivo Gradle
// tocado era `build.gradle.kts` con 5 líneas dentro de
// `dependencyCheck { nvd { … } }` — config del plugin OWASP, que no cambia
// qué compila Gradle ni qué instrumenta Kover.
//
// La invariante que protegen estos tests: el umbral ABSOLUTO sólo gatea
// diffs que realmente pueden mover el número; todo lo demás se reporta sin
// gatear. Y ante cualquier duda, se gatea (fail-closed).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    coverageGateApplies,
    isCoverageSource,
    isBuildScript,
    COVERAGE_AFFECTING_TOKENS,
} = require('../skills-deterministicos/tester');

// ── El caso real del rebote #6362 ────────────────────────────────────
test('#6362: diff de CI + docs + build.gradle.kts con sólo config del plugin OWASP no gatea', () => {
    const files = [
        '.github/workflows/security-sast.yml',
        '.pipeline/tests/security-sast-workflow.test.js',
        'build.gradle.kts',
        'docs/security-sast.md',
    ];
    // Las 5 líneas exactas agregadas por el commit a662eb31d.
    const buildScriptLines = [
        '    nvd {',
        '        System.getenv("NVD_API_KEY")',
        '            ?.takeIf { it.isNotBlank() }',
        '            ?.let { apiKey = it }',
        '    }',
    ];
    assert.equal(coverageGateApplies(files, buildScriptLines), false);
});

test('#6362: `apiKey`/`NVD_API_KEY` no disparan el token `api` (sin word boundary)', () => {
    assert.ok(!COVERAGE_AFFECTING_TOKENS.test('            ?.let { apiKey = it }'));
    assert.ok(!COVERAGE_AFFECTING_TOKENS.test('        System.getenv("NVD_API_KEY")'));
    // …pero una dependencia `api(...)` real sí lo dispara.
    assert.ok(COVERAGE_AFFECTING_TOKENS.test('    api("org.example:lib:1.0")'));
});

// ── El gate clásico se conserva para código Kotlin ───────────────────
test('un diff que agrega una fuente Kotlin sigue gateado al umbral', () => {
    const files = ['.pipeline/foo.js', 'app/composeApp/src/commonMain/kotlin/ui/Login.kt'];
    assert.equal(coverageGateApplies(files, []), true);
});

test('un diff que agrega un test Kotlin sigue gateado al umbral', () => {
    const files = ['backend/src/test/kotlin/ar/com/intrale/SignInTest.kt'];
    assert.equal(coverageGateApplies(files, []), true);
});

test('un diff que toca recursos Android medidos sigue gateado', () => {
    const files = ['app/composeApp/src/androidMain/res/values/strings.xml'];
    assert.equal(coverageGateApplies(files, []), true);
});

test('un diff que borra una fuente Kotlin sigue gateado (puede bajar cobertura)', () => {
    const files = ['users/src/main/kotlin/ar/com/intrale/Profile.kt'];
    assert.equal(coverageGateApplies(files, []), true);
});

// ── Build scripts: sólo neutros si no tocan compilación/instrumentación ──
test('build.gradle.kts que agrega una dependencia SÍ gatea', () => {
    const files = ['build.gradle.kts'];
    const lines = ['    testImplementation("io.mockk:mockk:1.13.10")'];
    assert.equal(coverageGateApplies(files, lines), true);
});

test('build.gradle.kts que toca configuración de Kover SÍ gatea', () => {
    const files = ['app/composeApp/build.gradle.kts'];
    const lines = ['    kover { excludes { classes("ar.com.intrale.ui.*") } }'];
    assert.equal(coverageGateApplies(files, lines), true);
});

test('build.gradle.kts que toca sourceSets SÍ gatea', () => {
    const files = ['backend/build.gradle.kts'];
    const lines = ['        sourceSets["main"].kotlin.srcDir("build/generated")'];
    assert.equal(coverageGateApplies(files, lines), true);
});

test('gradle.properties y libs.versions.toml se tratan como build scripts', () => {
    assert.ok(isBuildScript('gradle.properties'));
    assert.ok(isBuildScript('gradle/libs.versions.toml'));
    assert.ok(isBuildScript('settings.gradle.kts'));
    assert.ok(isBuildScript('qa/build.gradle.kts'));
});

// ── Fail-closed en cada rama dudosa ──────────────────────────────────
test('fail-closed: diff desconocido (null) gatea', () => {
    assert.equal(coverageGateApplies(null, []), true);
    assert.equal(coverageGateApplies(undefined, []), true);
});

test('fail-closed: build script presente pero líneas ilegibles (null) gatea', () => {
    assert.equal(coverageGateApplies(['build.gradle.kts'], null), true);
});

test('fail-closed: diff vacío gatea', () => {
    assert.equal(coverageGateApplies([], []), true);
});

// ── Clasificación de fuentes ─────────────────────────────────────────
test('isCoverageSource distingue fuentes bajo src/ de scripts sueltos', () => {
    assert.ok(isCoverageSource('backend/src/main/kotlin/A.kt'));
    assert.ok(isCoverageSource('users/src/test/java/B.java'));
    assert.ok(!isCoverageSource('build.gradle.kts'));
    assert.ok(!isCoverageSource('.pipeline/pulpo.js'));
    assert.ok(!isCoverageSource('docs/security-sast.md'));
});

test('un diff puramente de infra CI/docs sin build script no gatea', () => {
    const files = ['.github/workflows/security-sast.yml', 'docs/security-sast.md'];
    assert.equal(coverageGateApplies(files, []), false);
});

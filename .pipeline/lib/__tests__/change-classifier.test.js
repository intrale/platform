// =============================================================================
// Tests change-classifier.js — refactor de /delivery (#2870)
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    classify,
    parseConventionalType,
    isTestFile,
    isDocFile,
    isChoreFile,
} = require('../delivery/change-classifier');

// ---- Detectores de tipo de archivo -----------------------------------------

test('isTestFile matchea __tests__/, *.test.js, Test.kt', () => {
    assert.equal(isTestFile('.pipeline/lib/__tests__/foo.test.js'), true);
    assert.equal(isTestFile('app/src/test/kotlin/FooTest.kt'), true);
    assert.equal(isTestFile('users/src/test/UserTests.kt'), true);
    assert.equal(isTestFile('lib/foo.spec.ts'), true);
    assert.equal(isTestFile('app/src/main/MyService.kt'), false);
});

test('isDocFile matchea docs/, .md, README, CHANGELOG', () => {
    assert.equal(isDocFile('docs/arquitectura.md'), true);
    assert.equal(isDocFile('README.md'), true);
    assert.equal(isDocFile('CHANGELOG'), true);
    assert.equal(isDocFile('app/src/main/Foo.kt'), false);
});

test('isChoreFile matchea config/build/CI pero NO tests ni docs', () => {
    assert.equal(isChoreFile('.github/workflows/ci.yml'), true);
    assert.equal(isChoreFile('.gitignore'), true);
    assert.equal(isChoreFile('build.gradle.kts'), true);
    assert.equal(isChoreFile('package.json'), true);
    assert.equal(isChoreFile('.claude/skills/foo/SKILL.md'), true);
    // No clasificar como chore si es test o doc (precedencia)
    assert.equal(isChoreFile('docs/README.md'), false);
    assert.equal(isChoreFile('lib/__tests__/foo.test.js'), false);
});

// ---- parseConventionalType --------------------------------------------------

test('parseConventionalType extrae el tipo de subjects válidos', () => {
    assert.equal(parseConventionalType('feat: nueva cosa'), 'feat');
    assert.equal(parseConventionalType('fix(api): bug X'), 'fix');
    assert.equal(parseConventionalType('refactor(scope): blah'), 'refactor');
    assert.equal(parseConventionalType('test: agregar tests'), 'test');
    assert.equal(parseConventionalType('docs(readme): update'), 'docs');
    assert.equal(parseConventionalType('chore!: breaking'), 'chore');
});

test('parseConventionalType devuelve null en subjects no convencionales', () => {
    assert.equal(parseConventionalType('Updated something'), null);
    assert.equal(parseConventionalType(''), null);
    assert.equal(parseConventionalType('foo: x'), null);  // foo no es tipo válido
    assert.equal(parseConventionalType(null), null);
});

// ---- classify ---------------------------------------------------------------

test('classify devuelve test si TODOS los archivos son tests', () => {
    const result = classify({
        files: ['lib/__tests__/a.test.js', 'lib/__tests__/b.test.js'],
        commits: [],
        status: [],
    });
    assert.equal(result, 'test');
});

test('classify devuelve docs si TODOS los archivos son docs', () => {
    const result = classify({
        files: ['docs/foo.md', 'README.md'],
        commits: [],
        status: [],
    });
    assert.equal(result, 'docs');
});

test('classify devuelve chore si TODOS los archivos son chore (build/CI)', () => {
    const result = classify({
        files: ['.github/workflows/ci.yml', '.gitignore'],
        commits: [],
        status: [],
    });
    assert.equal(result, 'chore');
});

test('classify respeta el subject del primer commit cuando es conventional', () => {
    // Mix de archivos prod + test, pero el commit dice "fix" → fix.
    const result = classify({
        files: ['app/src/main/Foo.kt', 'app/src/test/FooTest.kt'],
        commits: [
            { sha: 'abc', subject: 'test: agregar más tests' },          // último commit
            { sha: 'def', subject: 'fix(api): corregir parsing' },        // primer commit
        ],
        status: [],
    });
    assert.equal(result, 'fix');
});

test('classify devuelve feat si hay archivos nuevos (status A) y no hay otra señal', () => {
    const result = classify({
        files: [],
        commits: [],
        status: [
            { code: 'A ', path: 'app/src/main/NewService.kt' },
        ],
    });
    assert.equal(result, 'feat');
});

test('classify devuelve fix si solo hay archivos modificados', () => {
    const result = classify({
        files: [],
        commits: [],
        status: [
            { code: ' M', path: 'app/src/main/ExistingService.kt' },
        ],
    });
    assert.equal(result, 'fix');
});

test('classify devuelve null si no hay señales', () => {
    const result = classify({ files: [], commits: [], status: [] });
    assert.equal(result, null);
});

test('classify usa override cuando se le pasa uno válido', () => {
    const result = classify({
        files: ['docs/foo.md'],   // sería docs
        override: 'feat',
    });
    assert.equal(result, 'feat');
});

test('classify ignora override inválido', () => {
    const result = classify({
        files: ['docs/foo.md'],
        override: 'banana',
    });
    assert.equal(result, 'docs');
});

test('classify NO confunde archivos chore con prod cuando hay test+chore mezclados', () => {
    // Solo tests + chore: si todos son test → test gana (regla 1 antes que chore).
    // Pero si hay test + chore mezclado, ya no son TODOS tests ni TODOS chore.
    // El subject del commit decide, sino caemos en statusBasedType.
    const result = classify({
        files: ['lib/__tests__/foo.test.js', 'package.json'],
        commits: [{ sha: 'a', subject: 'chore(deps): bump foo' }],
        status: [],
    });
    assert.equal(result, 'chore');
});

test('classify para el caso real del whisper fix (PR #2866)', () => {
    // El fix que mergeamos hoy: 2 archivos JS modificados, commit fix(pipeline): ...
    const result = classify({
        files: ['.pipeline/lib/whisper-local.js', '.pipeline/multimedia.js'],
        commits: [{ sha: 'abc', subject: 'fix(pipeline): whisper local default model' }],
        status: [],
    });
    assert.equal(result, 'fix');
});

test('classify para el caso real de los módulos de delivery (PR #2871)', () => {
    // Archivos nuevos en .pipeline/lib/delivery/ y __tests__ → tests son test pattern,
    // los .js de delivery no. El subject dice "refactor".
    const result = classify({
        files: [
            '.pipeline/lib/delivery/git-context.js',
            '.pipeline/lib/__tests__/git-context.test.js',
        ],
        commits: [{ sha: 'abc', subject: 'refactor(delivery): git-context determinístico' }],
        status: [],
    });
    assert.equal(result, 'refactor');
});

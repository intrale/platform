// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

// Tests del gate de cobertura ante cambios SOLO de comentarios (rebote #7591).
//
// Contexto: #7591 agrega el encabezado de licencia (2 líneas `//` + 1 blanca)
// a 832 fuentes `.kt`. El tester determinístico vio `.kt` en el diff, aplicó
// el umbral ABSOLUTO de 80% y rechazó con "Cobertura de líneas 36.05%": la
// cobertura histórica del repo, que un comentario no puede mover.
//
// Invariante: un diff cuyas líneas cambiadas en fuentes `.kt`/`.java` son
// todas comentario de línea o blancas no gatea; cualquier otra cosa (código,
// comentarios de bloque, recursos, evidencia ilegible) sigue gateando.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
    coverageGateApplies,
    isCommentOnlyChange,
    isCodeSource,
    extractChangedLines,
    diffCoversFiles,
    getSourceChangedLines,
} = require('../skills-deterministicos/tester');

const HEADER = [
    '// Copyright (c) 2026 Leonel Larreta',
    '// SPDX-License-Identifier: LicenseRef-Proprietary',
    '',
];

// ── El caso real del rebote #7591 ────────────────────────────────────
test('#7591: encabezado de licencia en fuentes .kt no gatea la cobertura', () => {
    const files = [
        'LICENSE',
        '.pipeline/lib/license-header-lint.js',
        'backend/src/main/kotlin/ar/com/intrale/Application.kt',
        'app/composeApp/src/commonMain/kotlin/ui/Login.kt',
    ];
    const sourceLines = [...HEADER, ...HEADER];
    assert.equal(coverageGateApplies(files, [], sourceLines), false);
});

test('#7591: sin el tercer parámetro se conserva el gate clásico (compat)', () => {
    const files = ['app/composeApp/src/commonMain/kotlin/ui/Login.kt'];
    assert.equal(coverageGateApplies(files, []), true);
});

// ── El gate se conserva ante código real ─────────────────────────────
test('una línea de código entre los comentarios sigue gateando', () => {
    const files = ['backend/src/main/kotlin/A.kt'];
    assert.equal(coverageGateApplies(files, [], [...HEADER, 'fun nueva() = 42']), true);
});

test('un comentario de bloque no cuenta como inocuo (fail-closed)', () => {
    const files = ['backend/src/main/kotlin/A.kt'];
    assert.equal(coverageGateApplies(files, [], ['/*', ' * Copyright', ' */']), true);
});

test('un recurso medido gatea aunque las fuentes sólo cambien comentarios', () => {
    const files = [
        'backend/src/main/kotlin/A.kt',
        'app/composeApp/src/androidMain/res/values/strings.xml',
    ];
    assert.equal(coverageGateApplies(files, [], HEADER), true);
});

test('fail-closed: líneas de fuentes ilegibles (null) o vacías gatean', () => {
    const files = ['backend/src/main/kotlin/A.kt'];
    assert.equal(coverageGateApplies(files, [], null), true);
    assert.equal(coverageGateApplies(files, [], []), true);
});

test('comentarios en fuentes + build script con token relevante sigue gateando', () => {
    const files = ['backend/src/main/kotlin/A.kt', 'build.gradle.kts'];
    assert.equal(coverageGateApplies(files, ['    implementation("x:y:1")'], HEADER), true);
});

// ── Helpers ──────────────────────────────────────────────────────────
test('isCommentOnlyChange acepta sólo `//` y blancas', () => {
    assert.equal(isCommentOnlyChange(HEADER), true);
    assert.equal(isCommentOnlyChange(['    // indentado', '\t']), true);
    assert.equal(isCommentOnlyChange(['val x = 1 // comentario al final']), false);
    assert.equal(isCommentOnlyChange([' * dentro de KDoc']), false);
    assert.equal(isCommentOnlyChange([]), false);
    assert.equal(isCommentOnlyChange(null), false);
});

test('isCodeSource distingue fuentes de recursos', () => {
    assert.ok(isCodeSource('users/src/test/java/B.java'));
    assert.ok(isCodeSource('backend/src/main/kotlin/A.kt'));
    assert.ok(!isCodeSource('app/composeApp/src/androidMain/res/values/strings.xml'));
    assert.ok(!isCodeSource('build.gradle.kts'));
});

test('extractChangedLines ignora headers +++/--- y contexto', () => {
    const diff = [
        'diff --git a/src/A.kt b/src/A.kt',
        '--- a/src/A.kt',
        '+++ b/src/A.kt',
        '@@ -0,0 +1,2 @@',
        '+// hola',
        '-// chau',
        ' contexto',
    ].join('\r\n');
    assert.deepEqual(extractChangedLines(diff), ['// hola', '// chau']);
});

test('diffCoversFiles exige que cada fuente aparezca en el diff', () => {
    const diff = 'diff --git a/src/A.kt b/src/A.kt\n+// x\n';
    assert.equal(diffCoversFiles(diff, ['src/A.kt']), true);
    assert.equal(diffCoversFiles(diff, ['src/A.kt', 'src/B.kt']), false);
});

// ── Integración contra un repo git real ──────────────────────────────
function git(cwd, ...args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

async function withRepo(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tester-gate-7591-'));
    try {
        git(dir, 'init', '-q', '-b', 'main');
        git(dir, 'config', 'user.email', 't@t');
        git(dir, 'config', 'user.name', 't');
        git(dir, 'config', 'core.autocrlf', 'false');
        fs.mkdirSync(path.join(dir, 'src', 'main', 'kotlin'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'src', 'main', 'kotlin', 'A.kt'), 'fun a() = 1\n');
        fs.writeFileSync(path.join(dir, 'src', 'B.kt'), 'fun b() = 2\n');
        git(dir, 'add', '.');
        git(dir, 'commit', '-q', '-m', 'base');
        git(dir, 'checkout', '-q', '-b', 'feature');
        return await fn(dir);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
}

test('getSourceChangedLines lee sólo el encabezado agregado (también src/ en la raíz)', async () => {
    await withRepo(async (dir) => {
        for (const rel of ['src/main/kotlin/A.kt', 'src/B.kt']) {
            const f = path.join(dir, rel);
            fs.writeFileSync(f, HEADER.join('\n') + '\n' + fs.readFileSync(f, 'utf8'));
        }
        git(dir, 'commit', '-qam', 'header');
        const files = ['src/main/kotlin/A.kt', 'src/B.kt'];
        const lines = await getSourceChangedLines(dir, files);
        assert.deepEqual([...new Set(lines)].sort(), [...new Set(HEADER)].sort());
        assert.equal(coverageGateApplies(files, [], lines), false);
    });
});

test('getSourceChangedLines detecta código real y el gate se mantiene', async () => {
    await withRepo(async (dir) => {
        fs.appendFileSync(path.join(dir, 'src', 'B.kt'), 'fun c() = 3\n');
        git(dir, 'commit', '-qam', 'code');
        const files = ['src/B.kt'];
        const lines = await getSourceChangedLines(dir, files);
        assert.ok(lines.includes('fun c() = 3'));
        assert.equal(coverageGateApplies(files, [], lines), true);
    });
});

test('getSourceChangedLines devuelve null si una fuente listada no aparece en el diff', async () => {
    await withRepo(async (dir) => {
        fs.appendFileSync(path.join(dir, 'src', 'B.kt'), '// x\n');
        git(dir, 'commit', '-qam', 'comment');
        const lines = await getSourceChangedLines(dir, ['src/B.kt', 'src/Fantasma.kt']);
        assert.equal(lines, null);
    });
});

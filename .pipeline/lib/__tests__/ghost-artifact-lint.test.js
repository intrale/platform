'use strict';

// Tests: `lib/ghost-artifact-lint` (#3638 CA-F-9..F-11).
//
// Estrategia: armamos tmpdir con archivos sintéticos que reflejen patrones
// reales (readdir sobre carpetas operacionales, con y sin filtro) y
// verificamos que el linter los detecte correctamente.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const lint = require('../ghost-artifact-lint');

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeTmpPipeline() {
    // El linter espera estructura `<pipelineRoot>/lib/foo.js`. Creamos un
    // mini pipelineRoot sintético.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-lint-'));
    fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
    return root;
}

function placeJs(root, relPath, source) {
    const full = path.join(root, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, source, 'utf8');
    return full;
}

function emptyAllowlist() {
    return { files: new Set(), rules: [] };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test('detecta readdir sobre definicion/ sin isMarkerArtifact (Gherkin escenario 4)', () => {
    const root = makeTmpPipeline();
    placeJs(root, 'lib/bad.js', `
        const fs = require('fs');
        const dir = '.pipeline/definicion/criterios/pendiente';
        const files = fs.readdirSync(dir);
        for (const f of files) console.log(f);
    `);
    const { violations } = lint.lint({ pipelineRoot: root, allowlist: emptyAllowlist() });
    assert.equal(violations.length, 1);
    assert.equal(violations[0].file, 'lib/bad.js');
});

test('NO emite violation cuando isMarkerArtifact se aplica cerca', () => {
    const root = makeTmpPipeline();
    placeJs(root, 'lib/good.js', `
        const fs = require('fs');
        const { isMarkerArtifact } = require('./marker-artifact');
        const dir = '.pipeline/definicion/criterios/pendiente';
        const files = fs.readdirSync(dir).filter(f => !isMarkerArtifact(f));
        for (const f of files) console.log(f);
    `);
    const { violations } = lint.lint({ pipelineRoot: root, allowlist: emptyAllowlist() });
    assert.equal(violations.length, 0);
});

test('acepta variantes de nombre (isMarkerArtifactPulpo) como filtro válido', () => {
    const root = makeTmpPipeline();
    placeJs(root, 'lib/pulpo-like.js', `
        const fs = require('fs');
        function isMarkerArtifactPulpo(n) { return false; }
        const dir = '.pipeline/desarrollo/dev/trabajando';
        const files = fs.readdirSync(dir).filter(f => !isMarkerArtifactPulpo(f));
    `);
    const { violations } = lint.lint({ pipelineRoot: root, allowlist: emptyAllowlist() });
    assert.equal(violations.length, 0);
});

test('NO emite violation para readdir sobre paths no-operacionales', () => {
    const root = makeTmpPipeline();
    placeJs(root, 'lib/config-reader.js', `
        const fs = require('fs');
        const files = fs.readdirSync('./node_modules');
        const more = fs.readdirSync('/tmp');
    `);
    const { violations } = lint.lint({ pipelineRoot: root, allowlist: emptyAllowlist() });
    assert.equal(violations.length, 0);
});

test('allowlist file entera: skipea todas las violations del archivo', () => {
    const root = makeTmpPipeline();
    placeJs(root, 'lib/bad-but-allowed.js', `
        const fs = require('fs');
        fs.readdirSync('.pipeline/definicion/criterios/pendiente');
    `);
    const allowlist = { files: new Set(['lib/bad-but-allowed.js']), rules: [] };
    const { violations } = lint.lint({ pipelineRoot: root, allowlist });
    assert.equal(violations.length, 0);
});

test('allowlist regla puntual: skipea violation en (file, line) específico', () => {
    const root = makeTmpPipeline();
    placeJs(root, 'lib/bad.js', `
        const fs = require('fs');
        const files = fs.readdirSync('.pipeline/definicion/criterios/pendiente');
    `);
    // Detectar primero la línea real.
    const baseline = lint.lint({ pipelineRoot: root, allowlist: emptyAllowlist() });
    assert.equal(baseline.violations.length, 1);
    const ruled = { files: new Set(), rules: [{ file: 'lib/bad.js', line: baseline.violations[0].line, reason: 'test' }] };
    const { violations } = lint.lint({ pipelineRoot: root, allowlist: ruled });
    assert.equal(violations.length, 0);
});

test('self-exempt: ghost-artifact-cleaner.js no se autoaudita', () => {
    const root = makeTmpPipeline();
    // Simular cleaner que sí lee carpetas operacionales con readdir.
    placeJs(root, 'lib/ghost-artifact-cleaner.js', `
        const fs = require('fs');
        fs.readdirSync('.pipeline/definicion/criterios/pendiente');
    `);
    const { violations } = lint.lint({ pipelineRoot: root, allowlist: emptyAllowlist() });
    // El cleaner está exento por construcción.
    assert.equal(violations.length, 0);
});

test('skipea directorios excluidos (node_modules, __tests__, archivado)', () => {
    const root = makeTmpPipeline();
    placeJs(root, 'lib/__tests__/foo.test.js', `
        const fs = require('fs');
        fs.readdirSync('.pipeline/definicion/criterios/pendiente');
    `);
    placeJs(root, 'node_modules/bad/index.js', `
        const fs = require('fs');
        fs.readdirSync('.pipeline/desarrollo/dev/pendiente');
    `);
    const { violations } = lint.lint({ pipelineRoot: root, allowlist: emptyAllowlist() });
    assert.equal(violations.length, 0);
});

test('lint del repo real: 0 violations (smoke test post-#3638)', () => {
    // Smoke: corremos el linter contra el repo real para garantizar que
    // post-merge el pipeline queda en estado "limpio".
    const { violations, scanned } = lint.lint();
    assert.ok(scanned > 0, 'debe escanear archivos del repo');
    if (violations.length > 0) {
        // Si esto falla, alguien introdujo un readdir sin filtro durante el dev del propio #3638.
        const msg = violations.map(v => `${v.file}:${v.line} ${v.snippet}`).join('\n');
        assert.fail(`smoke test post-#3638: ${violations.length} violations en repo real:\n${msg}`);
    }
});

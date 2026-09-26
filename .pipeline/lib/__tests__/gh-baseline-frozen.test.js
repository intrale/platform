// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

// =============================================================================
// CA-5' de #7438 — baseline CONGELADA de invocaciones de `gh` por literal pelado.
//
// El pipeline resuelve el binario `gh` con `lib/gh-bin.js`. Los sitios que
// todavía invocan `'gh'` pelado (o hacen `|| 'gh'`) los cubre #3060: esta
// baseline los enumera archivo por archivo como TOPE (no igualdad) para que la
// lista NO PUEDA CRECER. Un archivo no listado tiene tope 0.
//
// No se usa grep por shell ni números de línea (se mueven con cualquier
// edición): se lee `lib/*.js` (sin `__tests__`) y se aplica la regex por línea.
//
// Los dos módulos del gate de #7113 tienen tolerancia CERO con una regla más
// amplia: ni `'gh'`, ni `execSync(` con template string, ni `${ghBin}`.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const LIB_DIR = path.join(__dirname, '..');

// Misma regex que el grep del issue: cubre execSync con interpolación también.
const GH_PELADO = /(execFileSync|execSync|spawnSync|spawn|execFile)\(\s*'gh'|\|\|\s*'gh'/;

// Estado de `main` al cerrar #7438: 16 sitios − gate1-signature-handler.js:111
// (que pasa a 0) = 15. Es TOPE por archivo: bajar está bien, subir rompe.
const BASELINE_TOPE = Object.freeze({
    'architect-verify.js': 1,
    'code-scanning-alerts.js': 1,
    'ghost-artifact-cleaner.js': 1,
    'partial-pause-deps.js': 1,
    'pr-info-fetcher.js': 4,
    'product-seed.js': 3,
    'provider-exhaustion-pause.js': 1,
    'recommendations.js': 1,
    'repo-probe.js': 1,
    'sherlock-independent-verifier.js': 1,
});
const TOPE_TOTAL = Object.values(BASELINE_TOPE).reduce((a, b) => a + b, 0);

const MODULOS_DEL_GATE = ['design-decision-gate-io.js', 'gate1-signature-handler.js'];

function contarPorArchivo() {
    const out = {};
    for (const f of fs.readdirSync(LIB_DIR)) {
        if (!f.endsWith('.js')) continue;
        const full = path.join(LIB_DIR, f);
        if (!fs.statSync(full).isFile()) continue;
        const n = fs.readFileSync(full, 'utf8').split(/\r?\n/).filter((l) => GH_PELADO.test(l)).length;
        if (n > 0) out[f] = n;
    }
    return out;
}

test("CA-5': la suma de sitios con `gh` pelado en lib/*.js no supera la baseline (15)", () => {
    assert.equal(TOPE_TOTAL, 15, 'el mapa de la receta suma 15');
    const conteo = contarPorArchivo();
    const total = Object.values(conteo).reduce((a, b) => a + b, 0);
    assert.ok(total <= TOPE_TOTAL, `hay ${total} sitios con 'gh' pelado y el tope es ${TOPE_TOTAL}: ${JSON.stringify(conteo)}`);
});

test("CA-5': ningún archivo de lib/ supera su tope; un archivo no listado tiene tope 0", () => {
    const conteo = contarPorArchivo();
    const violaciones = [];
    for (const [f, n] of Object.entries(conteo)) {
        const tope = BASELINE_TOPE[f] || 0;
        if (n > tope) violaciones.push(`${f}: ${n} > ${tope}`);
    }
    assert.deepEqual(violaciones, [], 'nuevos sitios con `gh` pelado: usar resolveGhBin() de lib/gh-bin.js');
});

test("CA-5': los dos módulos del gate (#7113) tienen tolerancia cero", () => {
    for (const f of MODULOS_DEL_GATE) {
        const src = fs.readFileSync(path.join(LIB_DIR, f), 'utf8');
        assert.doesNotMatch(src, /'gh'/, `${f}: cero literal 'gh'`);
        assert.doesNotMatch(src, /execSync\s*\(\s*`/, `${f}: cero execSync con template string`);
        assert.doesNotMatch(src, /\$\{ghBin\}/, `${f}: cero interpolación del binario`);
        assert.doesNotMatch(src, GH_PELADO, `${f}: cero sitios según la regex de la baseline`);
    }
});

test('CA-3: gate1-signature-handler.js no usa execSync en absoluto', () => {
    const src = fs.readFileSync(path.join(LIB_DIR, 'gate1-signature-handler.js'), 'utf8');
    assert.doesNotMatch(src, /\bexecSync\b/, 'sólo execFileSync, por argv');
    assert.match(src, /\bexecFileSync\b/);
});

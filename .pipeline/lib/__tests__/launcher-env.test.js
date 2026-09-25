// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// #7112 · CA-6 / CA-7.2 — la declaración de ambiente la cablean los lanzadores.
//
// Unidad: `lib/launcher-env.js` (con env literal, nunca process.env).
// Estructural: los tres entrypoints humanos/SO (restart.js, watchdog.ps1,
// launch.ps1) declaran `productivo` antes de spawnear, y restart.js entrega a
// cada servicio la declaración EXPLÍCITA (resuelta) + PIPELINE_REPO_ROOT.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const launcherEnv = require('../launcher-env');
const pipelineEnv = require('../pipeline-env');
const AMB = pipelineEnv.ENV_AMBIENTE;
const PROD_REPO = path.dirname(pipelineEnv.DEFAULT_PRODUCTIVE_DIR);
const PIPELINE_DIR = path.join(__dirname, '..', '..');

function leer(rel) { return fs.readFileSync(path.join(PIPELINE_DIR, rel), 'utf8'); }

// ─── unidad ─────────────────────────────────────────────────────────────────

test('declararRaiz · sin declaración pone productivo (literal legítimo sólo en la raíz de la cadena)', () => {
    const env = {};
    const r = launcherEnv.declararRaiz(env);
    assert.deepStrictEqual(r, { declarado: true, valor: 'productivo' });
    assert.strictEqual(env[AMB], 'productivo');
});

test('declararRaiz · respeta una declaración previa (pruebas explícito de #7111, o cualquier valor no vacío)', () => {
    for (const previo of ['pruebas', 'productivo', 'otro']) {
        const env = { [AMB]: previo };
        const r = launcherEnv.declararRaiz(env);
        assert.deepStrictEqual(r, { declarado: false, valor: previo });
        assert.strictEqual(env[AMB], previo);
    }
    const vacio = { [AMB]: '  ' };
    assert.strictEqual(launcherEnv.declararRaiz(vacio).declarado, true, 'vacío cuenta como no declarado');
});

test('envDeLanzador · el hijo recibe la declaración con el modo RESUELTO por el lanzador + PIPELINE_REPO_ROOT, sin mutar el env del padre', () => {
    const padre = { [AMB]: 'productivo', PATH: 'x' };
    const hijo = launcherEnv.envDeLanzador({ processEnv: padre, repoRoot: PROD_REPO, extra: { NODE_PATH: 'nm' } });
    assert.strictEqual(hijo[AMB], 'productivo');
    assert.strictEqual(hijo.PIPELINE_REPO_ROOT, PROD_REPO);
    assert.strictEqual(hijo.NODE_PATH, 'nm');
    assert.strictEqual(hijo.PATH, 'x');
    assert.deepStrictEqual(padre, { [AMB]: 'productivo', PATH: 'x' }, 'no muta el padre');
});

test('envDeLanzador · un lanzador que resolvió pruebas (señal de test) jamás declara productivo a sus hijos, aunque herede el literal', () => {
    const padre = { [AMB]: 'productivo', NODE_TEST_CONTEXT: '1' };
    const hijo = launcherEnv.envDeLanzador({ processEnv: padre, repoRoot: PROD_REPO });
    assert.strictEqual(hijo[AMB], 'pruebas');
});

test('envDeLanzador · sin declaración en el padre el hijo recibe pruebas (nunca un literal inventado); sin repoRoot es error de programación', () => {
    const hijo = launcherEnv.envDeLanzador({ processEnv: {}, repoRoot: PROD_REPO });
    assert.strictEqual(hijo[AMB], 'pruebas');
    assert.throws(() => launcherEnv.envDeLanzador({ processEnv: {} }), TypeError);
});

// ─── estructural: restart.js ────────────────────────────────────────────────

test('CA-6 · restart.js se autodeclara (declararRaiz) antes de spawnear y NO conserva const de módulo del dir del pipeline', () => {
    const src = leer('restart.js');
    const codigo = src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.match(codigo, /launcherEnv\.declararRaiz\(process\.env\)/, 'raíz de la cadena declarada');
    assert.doesNotMatch(codigo, /const PIPELINE = /, 'sin const capturada al require (SEC-13)');
    assert.match(codigo, /function PIPELINE\(\)/);
    assert.match(codigo, /writeTarget\.writeDir\(process\.env, \{ canal: 'estado'/);
    const declaraEn = codigo.indexOf('launcherEnv.declararRaiz(process.env)');
    const primerSpawn = codigo.indexOf('spawn(process.execPath');
    assert.ok(declaraEn > 0 && primerSpawn > declaraEn, 'declara ANTES del primer spawn');
});

test('CA-6 · el env de cada child de servicio/rollback de restart.js sale de envDeServicio (declaración explícita + PIPELINE_REPO_ROOT)', () => {
    const src = leer('restart.js');
    const codigo = src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    const spawns = codigo.match(/spawn\(process\.execPath[\s\S]*?\}\);/g) || [];
    assert.ok(spawns.length >= 2, 'restart.js spawnea servicios y rollback: ' + spawns.length);
    for (const sp of spawns) {
        assert.match(sp, /env: envDeServicio\(/, 'spawn sin envDeServicio: ' + sp.slice(0, 120));
        assert.doesNotMatch(sp, /env: \{ \.\.\.process\.env/, 'spread crudo de process.env: ' + sp.slice(0, 120));
    }
    assert.match(codigo, /launcherEnv\.envDeLanzador\(\{ processEnv: process\.env, repoRoot: ROOT, extra \}\)/);
    // El helper real, con el env de un restart.js productivo, entrega lo que la CA pide.
    const env = launcherEnv.envDeLanzador({ processEnv: { [AMB]: 'productivo' }, repoRoot: PROD_REPO, extra: { NODE_PATH: 'x' } });
    assert.strictEqual(env[AMB], 'productivo');
    assert.strictEqual(env.PIPELINE_REPO_ROOT, PROD_REPO);
});

// ─── estructural: watchdog.ps1 / launch.ps1 (Enmienda 1 de guru) ────────────

for (const ps1 of ['watchdog.ps1', 'launch.ps1']) {
    test(`CA-6 · ${ps1} declara $env:PIPELINE_AMBIENTE='productivo' (si no venía) ANTES de cada Start-Process de node`, () => {
        const lineas = leer(ps1).split(/\r?\n/);
        const declara = lineas.findIndex((l) => /^\s*if \(-not \$env:PIPELINE_AMBIENTE\) \{ \$env:PIPELINE_AMBIENTE = 'productivo' \}\s*$/.test(l));
        assert.ok(declara >= 0, `${ps1}: sin declaración guardada por 'si no venía'`);
        const spawns = lineas.map((l, i) => (/Start-Process -FilePath 'node'/.test(l) ? i : -1)).filter((i) => i >= 0);
        assert.ok(spawns.length >= 1, `${ps1}: sin Start-Process de node`);
        for (const i of spawns) assert.ok(i > declara, `${ps1}:${i + 1} Start-Process antes de la declaración (línea ${declara + 1})`);
        // Un solo literal `productivo` en el archivo: el de la raíz de la cadena.
        const literales = lineas.filter((l) => !/^\s*#/.test(l) && /PIPELINE_AMBIENTE = 'productivo'/.test(l));
        assert.strictEqual(literales.length, 1, `${ps1}: el literal vive una sola vez`);
    });
}

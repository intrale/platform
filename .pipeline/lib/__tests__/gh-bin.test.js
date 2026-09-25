// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

// =============================================================================
// Tests lib/gh-bin.js — #7438 · resolución única del binario `gh`.
//
// Causa raíz de #7113: el Pulpo lanzado por `watchdog.ps1` no tiene `gh` en el
// PATH y dos módulos del gate invocaban el literal pelado (`spawnSync gh
// ENOENT`). El helper concentra la precedencia `ghBin → GH_BIN → GH_PATH →
// default por plataforma` que ya usaba `pipeline-states.js`.
//
// El env `GH_BIN`/`GH_PATH` se muta SÓLO vía `withEnv` (lib/test-helpers) que
// restaura pase lo que pase: ningún otro test del repo lo toca y así debe quedar.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ghBinMod = require('../gh-bin');
const { GH_BIN_DEFAULT, resolveGhBin } = ghBinMod;

const { withEnv } = require('../test-helpers/with-env');

/**
 * `GH_BIN`/`GH_PATH` se mutan SOLO a través de `withEnv` (#6258): snapshot,
 * mutación acotada y restauración pase lo que pase. `undefined` borra la variable.
 */
function conEnv(vars, fn) {
    return withEnv({ GH_BIN: vars.GH_BIN, GH_PATH: vars.GH_PATH }, fn);
}

// -----------------------------------------------------------------------------
// CA-2 · precedencia exacta ghBin → GH_BIN → GH_PATH → default
// -----------------------------------------------------------------------------

test('CA-2: el argumento ghBin gana sobre GH_BIN, GH_PATH y el default', () => {
    conEnv({ GH_BIN: '/env/bin/gh', GH_PATH: '/env/path/gh' }, () => {
        assert.equal(resolveGhBin({ ghBin: '/arg/gh' }), '/arg/gh');
    });
});

test('CA-2: sin ghBin, GH_BIN gana sobre GH_PATH y el default', () => {
    conEnv({ GH_BIN: '/env/bin/gh', GH_PATH: '/env/path/gh' }, () => {
        assert.equal(resolveGhBin(), '/env/bin/gh');
        assert.equal(resolveGhBin({}), '/env/bin/gh');
    });
});

test('CA-2: sin ghBin ni GH_BIN, GH_PATH gana sobre el default', () => {
    conEnv({ GH_BIN: undefined, GH_PATH: '/env/path/gh' }, () => {
        assert.equal(resolveGhBin(), '/env/path/gh');
    });
});

test('CA-2: sin ninguna fuente cae al default por plataforma', () => {
    conEnv({ GH_BIN: undefined, GH_PATH: undefined }, () => {
        assert.equal(resolveGhBin(), GH_BIN_DEFAULT);
    });
});

test('CA-2: vacío en un nivel cae al siguiente (misma semántica `||` que hoy)', () => {
    conEnv({ GH_BIN: '', GH_PATH: '/env/path/gh' }, () => {
        assert.equal(resolveGhBin({ ghBin: '' }), '/env/path/gh', 'ghBin y GH_BIN vacíos ⇒ GH_PATH');
    });
    conEnv({ GH_BIN: '', GH_PATH: '' }, () => {
        assert.equal(resolveGhBin({ ghBin: '' }), GH_BIN_DEFAULT, 'todo vacío ⇒ default');
    });
    conEnv({ GH_BIN: undefined, GH_PATH: undefined }, () => {
        assert.equal(resolveGhBin({ ghBin: undefined }), GH_BIN_DEFAULT);
        assert.equal(resolveGhBin({ ghBin: null }), GH_BIN_DEFAULT);
    });
});

// -----------------------------------------------------------------------------
// Default por plataforma (CA-2 win32 / CA-6 no-win32) — se asserta por
// `process.platform` real, sin mockear la plataforma.
// -----------------------------------------------------------------------------

test('default por plataforma: win32 apunta fuera del PATH; el resto conserva `gh`', () => {
    if (process.platform === 'win32') {
        assert.equal(GH_BIN_DEFAULT, 'C:/Workspaces/gh-cli/bin/gh');
        conEnv({ GH_BIN: undefined, GH_PATH: undefined }, () => {
            assert.notEqual(resolveGhBin(), 'gh', 'en win32 nunca el literal pelado (causa raíz de #7113)');
            assert.equal(resolveGhBin(), 'C:/Workspaces/gh-cli/bin/gh');
        });
    } else {
        // CA-6: en Linux/CI no cambia el comportamiento.
        assert.equal(GH_BIN_DEFAULT, 'gh');
        conEnv({ GH_BIN: undefined, GH_PATH: undefined }, () => {
            assert.equal(resolveGhBin(), 'gh');
        });
    }
});

test('el helper es puro: devuelve siempre string y no tiene estado entre llamadas', () => {
    conEnv({ GH_BIN: undefined, GH_PATH: undefined }, () => {
        assert.equal(typeof resolveGhBin(), 'string');
        assert.equal(resolveGhBin({ ghBin: '/a/gh' }), '/a/gh');
        assert.equal(resolveGhBin(), GH_BIN_DEFAULT, 'la llamada anterior no dejó nada pegado');
    });
});

test('el env queda intacto después de los tests que lo mutan', () => {
    const antes = { GH_BIN: process.env.GH_BIN, GH_PATH: process.env.GH_PATH };
    conEnv({ GH_BIN: '/tmp/x', GH_PATH: '/tmp/y' }, () => resolveGhBin());
    assert.deepEqual({ GH_BIN: process.env.GH_BIN, GH_PATH: process.env.GH_PATH }, antes);
});

// -----------------------------------------------------------------------------
// RS-1.1 · fuente permitida: SOLO argumento + env + default hardcodeado
// -----------------------------------------------------------------------------

test('RS-1.1: el source de gh-bin.js no requiere fs ni lee config.yaml ni archivo alguno', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'gh-bin.js'), 'utf8');
    assert.doesNotMatch(src, /require\(\s*['"](node:)?fs['"]\s*\)/, 'sin require(fs)');
    assert.doesNotMatch(src, /require\(\s*['"](node:)?path['"]\s*\)/, 'sin require(path)');
    assert.doesNotMatch(src, /config\.ya?ml/, 'nunca config.yaml');
    assert.doesNotMatch(src, /readFileSync|existsSync|readdirSync/, 'nunca lee archivos');
    // Las únicas dependencias externas son el env y la plataforma del proceso.
    const requires = src.match(/require\([^)]*\)/g) || [];
    assert.deepEqual(requires, [], 'gh-bin.js no requiere ningún módulo');
});

test('export exacto: { GH_BIN_DEFAULT, resolveGhBin }', () => {
    assert.deepEqual(Object.keys(ghBinMod).sort(), ['GH_BIN_DEFAULT', 'resolveGhBin']);
    assert.equal(typeof ghBinMod.resolveGhBin, 'function');
    assert.equal(typeof ghBinMod.GH_BIN_DEFAULT, 'string');
});

test('CA-2: los tres consumidores requieren el helper único', () => {
    for (const f of ['design-decision-gate-io.js', 'gate1-signature-handler.js', 'pipeline-states.js']) {
        const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
        assert.match(src, /require\(\s*['"]\.\/gh-bin['"]\s*\)/, `${f} debe consumir lib/gh-bin.js`);
    }
});

test('CA-4: pipeline-states.js ya no tiene su copia local de GH_BIN_DEFAULT', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'pipeline-states.js'), 'utf8');
    assert.doesNotMatch(src, /GH_BIN_DEFAULT/, 'la constante local desapareció (la provee gh-bin.js)');
});

test('CA-4: defaultGhRunner de pipeline-states.js invoca el binario que resuelve el helper (sin red)', () => {
    // Sin red ni `gh` real: un path inexistente hace que `spawnSync` devuelva
    // ENOENT con `error.path` = el binario que se intentó. Eso prueba QUÉ se
    // invocó sin depender de que exista.
    const { defaultGhRunner } = require('../pipeline-states').__internal;
    conEnv({ GH_BIN: '/env/no-existe/gh', GH_PATH: undefined }, () => {
        const conArg = defaultGhRunner(['--version'], { ghBin: '/arg/no-existe/gh' });
        assert.equal(conArg.error && conArg.error.code, 'ENOENT');
        assert.equal(conArg.error.path, '/arg/no-existe/gh', 'ghBin explícito gana');

        const conEnvVar = defaultGhRunner(['--version'], {});
        assert.equal(conEnvVar.error && conEnvVar.error.code, 'ENOENT');
        assert.equal(conEnvVar.error.path, '/env/no-existe/gh', 'sin ghBin manda GH_BIN');
    });
});

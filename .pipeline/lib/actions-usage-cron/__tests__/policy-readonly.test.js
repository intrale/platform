// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// Test estático de mínimo privilegio (#7689 CA-21 / RS-7689-8) sobre
// `lib/actions-usage-cron/`: el brazo nunca pide ni amplía scopes, nunca toca
// el billing de la org y nunca lanza procesos con shell.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MODULE_DIR = path.join(__dirname, '..');
const FUENTES = fs.readdirSync(MODULE_DIR).filter((n) => n.endsWith('.js'));

function source(name) {
    return fs.readFileSync(path.join(MODULE_DIR, name), 'utf8');
}

function sinComentarios(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// Los literales se arman por concatenación para que este test no sea el que
// introduzca las cadenas prohibidas en el árbol.
const PROHIBIDO = new RegExp([
    'settings' + '\\/billing',
    'gh auth' + ' refresh',
    'admin' + ':org',
    'shell' + ':\\s*true',
].join('|'));

test('CA-21 · los módulos del brazo existen', () => {
    for (const m of ['cron.js', 'runner.js', 'index.js', 'report.js', 'mapping.js']) {
        assert.ok(FUENTES.includes(m), m);
    }
});

test('CA-21 · ningún módulo menciona settings/billing, gh auth refresh, admin:org ni shell: true', () => {
    for (const f of FUENTES) {
        assert.ok(!PROHIBIDO.test(source(f)), `${f} contiene un literal prohibido`);
    }
});

test('RS-7689-1 · sólo runner.js abre procesos, y siempre por spawn/execFileSync (nunca exec con string)', () => {
    for (const f of FUENTES) {
        const codigo = sinComentarios(source(f));
        const usaCp = /require\(\s*['"](?:node:)?child_process['"]\s*\)/.test(codigo);
        if (f !== 'runner.js') {
            assert.ok(!usaCp, `${f} requiere child_process`);
            continue;
        }
        assert.ok(usaCp);
        assert.ok(!/\bexecSync\s*\(|\bcp\.exec\s*\(|\.exec\s*\(\s*[`'"]/.test(codigo), 'runner.js usa exec con string');
        assert.ok(!/\bshell\s*:/.test(codigo), 'runner.js declara la opción shell');
        assert.match(codigo, /process\.execPath/);
        assert.match(codigo, /windowsHide:\s*true/);
    }
});

test('ningún módulo usa la consola global, eval ni red', () => {
    const consola = 'console' + '.';
    for (const f of FUENTES) {
        const codigo = sinComentarios(source(f));
        assert.ok(!codigo.includes(consola), `${f} usa la consola`);
        assert.ok(!/\beval\s*\(|new Function\s*\(/.test(codigo), `${f} usa eval`);
        assert.ok(!/require\(\s*['"](?:node:)?(?:net|http|https|dgram|tls)['"]\s*\)/.test(codigo), `${f} abre red`);
    }
});

test('los estados se resuelven vía write-target, nunca con __dirname', () => {
    const RE_WT = /require\(\s*['"]\.\.\/write-target['"]\s*\)\.writePath\s*\(/;
    for (const f of ['cron.js', 'index.js']) {
        const codigo = sinComentarios(source(f));
        assert.ok(RE_WT.test(codigo), `${f} no resuelve por write-target`);
        assert.ok(!/__dirname/.test(codigo), `${f} usa __dirname`);
    }
    // cron.js: exactamente una writeFileSync y una renameSync (el estado atómico).
    const cron = sinComentarios(source('cron.js'));
    assert.strictEqual((cron.match(/\bwriteFileSync\s*\(/g) || []).length, 1);
    assert.strictEqual((cron.match(/\brenameSync\s*\(/g) || []).length, 1);
    // index.js no escribe por su cuenta: delega en cron.writeStateAtomic.
    const idx = sinComentarios(source('index.js'));
    assert.ok(!/\b(?:writeFileSync|renameSync|appendFileSync|rmSync|unlinkSync)\s*\(/.test(idx), 'index.js escribe por su cuenta');
});

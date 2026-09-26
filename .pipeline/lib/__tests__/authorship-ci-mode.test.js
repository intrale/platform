'use strict';
// #7632 — Tabla D-B del modo del check de autoría en CI (ci-mode.js).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { readAuthorshipBlock, resolveCiMode, goLiveMs } = require('../authorship/ci-mode');

const mode = (yaml) => resolveCiMode(readAuthorshipBlock(yaml));

test('bloque ausente → dry-run', () => {
    assert.strictEqual(mode('pipeline:\n  x: 1\n'), 'dry-run');
});

test('config inexistente o ilegible → dry-run', () => {
    assert.strictEqual(mode(null), 'dry-run');
    assert.strictEqual(mode(undefined), 'dry-run');
});

test('enabled: false explícito → disabled', () => {
    assert.strictEqual(mode('authorship:\n  enabled: false\n  gate_mode: enforce\n'), 'disabled');
});

test('gate_mode: off literal → disabled (mismo apagado que rollout.js)', () => {
    assert.strictEqual(mode('authorship:\n  enabled: true\n  gate_mode: off\n'), 'disabled');
});

test('gate_mode: dry-run → dry-run; sin gate_mode → dry-run', () => {
    assert.strictEqual(mode("authorship:\n  enabled: true\n  gate_mode: 'dry-run' # comentario\n"), 'dry-run');
    assert.strictEqual(mode('authorship:\n  enabled: true\n'), 'dry-run');
});

test('gate_mode: enforce → enforce', () => {
    assert.strictEqual(mode('authorship:\n  gate_mode: "enforce"\n'), 'enforce');
});

test('gate_mode: enforcee (valor desconocido) → enforce', () => {
    assert.strictEqual(mode('authorship:\n  gate_mode: enforcee\n'), 'enforce');
});

test('enabled con valor raro → enforce', () => {
    assert.strictEqual(mode('authorship:\n  enabled: quizas\n'), 'enforce');
});

test('bloque con indentación rota → enforce', () => {
    assert.strictEqual(mode('authorship:\n    enabled: true\n  gate_mode: dry-run\n'), 'enforce');
    assert.strictEqual(mode('authorship:\n\tgate_mode: dry-run\n'), 'enforce');
});

test('bloque vacío, valor inline, clave repetida o línea basura → enforce', () => {
    assert.strictEqual(mode('authorship:\nnext: 1\n'), 'enforce');
    assert.strictEqual(mode('authorship: {}\n'), 'enforce');
    assert.strictEqual(mode('authorship:\n  gate_mode: dry-run\nauthorship:\n  gate_mode: dry-run\n'), 'enforce');
    assert.strictEqual(mode('authorship:\n  gate_mode: dry-run\n  - lista\n'), 'enforce');
    assert.strictEqual(mode('authorship:\n  gate_mode: dry-run\n  gate_mode: off\n'), 'enforce');
});

test('hijos anidados (identity_map) no rompen la lectura', () => {
    const yaml = "authorship:\n  enabled: true\n  identity_map:\n    'sha256:abc': leito\n  gate_mode: dry-run\nnext:\n  a: 1\n";
    assert.strictEqual(mode(yaml), 'dry-run');
});

test('go_live_date se lee como epoch; ausente o inválido → null', () => {
    const b = readAuthorshipBlock("authorship:\n  go_live_date: '2026-09-23T00:00:00Z'\n");
    assert.strictEqual(goLiveMs(b), Date.parse('2026-09-23T00:00:00Z'));
    assert.strictEqual(goLiveMs(readAuthorshipBlock('authorship:\n  go_live_date: nunca\n')), null);
    assert.strictEqual(goLiveMs(null), null);
});

test('el config.yaml real del repo resuelve dry-run', () => {
    const real = fs.readFileSync(path.join(__dirname, '..', '..', 'config.yaml'), 'utf8');
    const block = readAuthorshipBlock(real);
    assert.strictEqual(resolveCiMode(block), 'dry-run');
    assert.ok(goLiveMs(block) !== null);
});

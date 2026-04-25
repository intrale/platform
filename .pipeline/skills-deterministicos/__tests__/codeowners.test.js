// Tests unitarios de .pipeline/skills-deterministicos/lib/codeowners.js (issue #2652)
// Cubre el parser de CODEOWNERS y la detección de owners humanos sobre paths
// modificados — núcleo del bloqueo de auto-merge para paths protegidos.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const codeowners = require('../lib/codeowners');

test('parseCodeowners — ignora comentarios y líneas vacías', () => {
    const txt = [
        '# CODEOWNERS sample',
        '',
        '/.pipeline/   @leitolarreta',
        '   ',
        '# protocolo',
        '/.github/   @leitolarreta',
    ].join('\n');
    const rules = codeowners.parseCodeowners(txt);
    assert.equal(rules.length, 2);
    assert.deepEqual(rules[0], { pattern: '/.pipeline/', owners: ['@leitolarreta'] });
    assert.deepEqual(rules[1], { pattern: '/.github/', owners: ['@leitolarreta'] });
});

test('parseCodeowners — soporta múltiples owners por regla', () => {
    const rules = codeowners.parseCodeowners('docs/  @leitolarreta @bot-account');
    assert.deepEqual(rules[0].owners, ['@leitolarreta', '@bot-account']);
});

test('matchPath — pattern de directorio anclado al root', () => {
    const rules = codeowners.parseCodeowners('/.pipeline/   @leitolarreta');
    assert.deepEqual(codeowners.matchPath(rules, '.pipeline/pulpo.js'), ['@leitolarreta']);
    assert.deepEqual(codeowners.matchPath(rules, '.pipeline/desarrollo/dev/x'), ['@leitolarreta']);
    assert.deepEqual(codeowners.matchPath(rules, 'docs/readme.md'), []);
});

test('matchPath — pattern dirOnly NO matchea archivo con mismo prefijo', () => {
    const rules = codeowners.parseCodeowners('/.pipelinex/   @leitolarreta');
    assert.deepEqual(codeowners.matchPath(rules, '.pipeline/pulpo.js'), []);
});

test('matchPath — last match gana (override)', () => {
    const rules = codeowners.parseCodeowners([
        '/.pipeline/   @leitolarreta',
        '/.pipeline/docs/   @writer-team',
    ].join('\n'));
    assert.deepEqual(codeowners.matchPath(rules, '.pipeline/docs/x.md'), ['@writer-team']);
    assert.deepEqual(codeowners.matchPath(rules, '.pipeline/pulpo.js'), ['@leitolarreta']);
});

test('matchPath — glob ** y *', () => {
    const rules = codeowners.parseCodeowners([
        '**/Dockerfile   @ops',
        'src/*.js   @frontend',
    ].join('\n'));
    assert.deepEqual(codeowners.matchPath(rules, 'app/Dockerfile'), ['@ops']);
    assert.deepEqual(codeowners.matchPath(rules, 'Dockerfile'), ['@ops']);
    assert.deepEqual(codeowners.matchPath(rules, 'src/app.js'), ['@frontend']);
    assert.deepEqual(codeowners.matchPath(rules, 'src/sub/app.js'), []);
});

test('matchPath — normaliza separador de Windows', () => {
    const rules = codeowners.parseCodeowners('/.pipeline/   @leitolarreta');
    assert.deepEqual(codeowners.matchPath(rules, '.pipeline\\pulpo.js'), ['@leitolarreta']);
});

test('resolveOwners — agrega owners únicos sobre múltiples paths', () => {
    const rules = codeowners.parseCodeowners([
        '/.pipeline/   @leitolarreta',
        '/.github/   @leitolarreta',
        'docs/   @writer-team',
    ].join('\n'));
    const owners = codeowners.resolveOwners(rules, [
        '.pipeline/pulpo.js',
        '.github/CODEOWNERS',
        'docs/readme.md',
        'app/util.kt',
    ]);
    assert.deepEqual(owners.sort(), ['@leitolarreta', '@writer-team']);
});

test('isHumanOwner — leitolarreta sí, otros no', () => {
    assert.equal(codeowners.isHumanOwner('@leitolarreta'), true);
    assert.equal(codeowners.isHumanOwner('@bot-account'), false);
    assert.equal(codeowners.isHumanOwner('@writer-team'), false);
});

test('getHumanOwners — filtra solo humanos del set resuelto', () => {
    const rules = codeowners.parseCodeowners([
        '/.pipeline/   @leitolarreta',
        'docs/   @writer-team',
    ].join('\n'));
    const humans = codeowners.getHumanOwners(rules, [
        '.pipeline/pulpo.js',
        'docs/readme.md',
        'app/util.kt',
    ]);
    assert.deepEqual(humans, ['@leitolarreta']);
});

test('getHumanOwners — vacío si no hay matches humanos', () => {
    const rules = codeowners.parseCodeowners('/.pipeline/   @leitolarreta');
    assert.deepEqual(codeowners.getHumanOwners(rules, ['app/util.kt']), []);
});

test('loadCodeowners — lee .github/CODEOWNERS si existe', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'co-'));
    try {
        fs.mkdirSync(path.join(tmp, '.github'), { recursive: true });
        fs.writeFileSync(
            path.join(tmp, '.github', 'CODEOWNERS'),
            '/.pipeline/   @leitolarreta\n',
        );
        const rules = codeowners.loadCodeowners(tmp);
        assert.equal(rules.length, 1);
        assert.equal(rules[0].owners[0], '@leitolarreta');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('loadCodeowners — devuelve [] si no hay archivo', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'co-empty-'));
    try {
        const rules = codeowners.loadCodeowners(tmp);
        assert.deepEqual(rules, []);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('caso real Intrale — .pipeline/* y .github/* requieren @leitolarreta', () => {
    const realCO = [
        '# CODEOWNERS — Review obligatorio para componentes críticos del pipeline',
        '/.pipeline/                 @leitolarreta',
        '/.github/                   @leitolarreta',
    ].join('\n');
    const rules = codeowners.parseCodeowners(realCO);
    assert.deepEqual(
        codeowners.getHumanOwners(rules, ['.pipeline/skills-deterministicos/delivery.js']),
        ['@leitolarreta'],
    );
    assert.deepEqual(
        codeowners.getHumanOwners(rules, ['.github/CODEOWNERS']),
        ['@leitolarreta'],
    );
    assert.deepEqual(
        codeowners.getHumanOwners(rules, ['app/composeApp/src/util.kt']),
        [],
    );
});

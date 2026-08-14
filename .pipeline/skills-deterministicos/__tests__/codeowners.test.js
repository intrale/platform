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

// ============================================================================
// #5420 — loadCodeownersFromRef: carga FAIL-CLOSED desde una ref git.
// ============================================================================
//
// Invariante central: un fallo de carga NUNCA puede verse como `rules: []`. El
// gate de merge de delivery.js interpretaba la lista vacía como "este PR no
// tiene owners humanos" y auto-mergeaba — fail-open. Estos tests fijan que todo
// borde de error devuelva `{ ok:false }` y que `rules` ni siquiera exista.

// fakeGitShow — ejecutor inyectable con la firma de spawnSync. `responses` mapea
// el path pedido dentro de la ref al resultado que devuelve `git show`.
function fakeGitShow(responses, calls = []) {
    return (cmd, argv) => {
        calls.push({ cmd, argv });
        const spec = argv[1] || '';
        const rel = spec.slice(spec.indexOf(':') + 1);
        const r = responses[rel];
        if (!r) return { status: 128, stdout: '', stderr: `fatal: path '${rel}' does not exist in 'origin/main'` };
        if (typeof r === 'function') return r();
        return r;
    };
}

test('#5420 — loadCodeownersFromRef: lee .github/CODEOWNERS desde la ref y devuelve ok:true', () => {
    const calls = [];
    const res = codeowners.loadCodeownersFromRef('/repo', 'origin/main', {
        spawnImpl: fakeGitShow({
            '.github/CODEOWNERS': { status: 0, stdout: '/.github/   @leitolarreta\n', stderr: '' },
        }, calls),
    });
    assert.equal(res.ok, true);
    assert.equal(res.source, '.github/CODEOWNERS');
    assert.equal(res.ref, 'origin/main');
    assert.equal(res.rules.length, 1);
    assert.deepEqual(res.rules[0].owners, ['@leitolarreta']);
    // Argumentos exactos: sin shell, ref y path en un solo token `ref:path`.
    assert.deepEqual(calls[0].argv, ['show', 'origin/main:.github/CODEOWNERS']);
});

test('#5420 CA-1 — archivo AUSENTE en la ref devuelve {ok:false}, NUNCA []', () => {
    const res = codeowners.loadCodeownersFromRef('/repo', 'origin/main', {
        spawnImpl: fakeGitShow({}), // ninguna ruta candidata existe
    });
    assert.equal(res.ok, false);
    assert.ok(res.reason.includes('no se pudo cargar CODEOWNERS'));
    // La trampa que este issue cierra: nada de listas vacías.
    assert.equal(res.rules, undefined);
    assert.notDeepEqual(res, { ok: true, rules: [] });
});

test('#5420 CA-2 — `git show` que FALLA (exit != 0) devuelve {ok:false}', () => {
    const res = codeowners.loadCodeownersFromRef('/repo', 'origin/main', {
        spawnImpl: fakeGitShow({
            '.github/CODEOWNERS': { status: 128, stdout: '', stderr: "fatal: invalid object name 'origin/main'." },
        }),
    });
    assert.equal(res.ok, false);
    assert.equal(res.rules, undefined);
    assert.ok(/exit=128/.test(res.reason));
});

test('#5420 — `git show` que lanza excepción (spawn roto) devuelve {ok:false}', () => {
    const res = codeowners.loadCodeownersFromRef('/repo', 'origin/main', {
        spawnImpl: () => { throw new Error('ENOENT git'); },
    });
    assert.equal(res.ok, false);
    assert.equal(res.rules, undefined);
    assert.ok(/ENOENT git/.test(res.reason));
});

test('#5420 — res.error (timeout de spawnSync) devuelve {ok:false}', () => {
    const res = codeowners.loadCodeownersFromRef('/repo', 'origin/main', {
        spawnImpl: () => ({ error: new Error('spawnSync git ETIMEDOUT'), status: null, stdout: '', stderr: '' }),
    });
    assert.equal(res.ok, false);
    assert.equal(res.rules, undefined);
    assert.ok(/ETIMEDOUT/.test(res.reason));
});

test('#5420 — ejecutor que devuelve basura (sin objeto) devuelve {ok:false}', () => {
    const res = codeowners.loadCodeownersFromRef('/repo', 'origin/main', { spawnImpl: () => null });
    assert.equal(res.ok, false);
    assert.equal(res.rules, undefined);
});

test('#5923 — CODEOWNERS presente pero SIN reglas parseables es una configuración válida', () => {
    const res = codeowners.loadCodeownersFromRef('/repo', 'origin/main', {
        spawnImpl: fakeGitShow({
            '.github/CODEOWNERS': { status: 0, stdout: '# sólo comentarios\n\n', stderr: '' },
            'CODEOWNERS': { status: 0, stdout: '   \n', stderr: '' },
            'docs/CODEOWNERS': { status: 0, stdout: '', stderr: '' },
        }),
    });
    assert.equal(res.ok, true);
    assert.equal(res.source, '.github/CODEOWNERS');
    assert.deepEqual(res.rules, []);
});

test('#5420 — cae a la ruta siguiente si la primera no existe en la ref', () => {
    const res = codeowners.loadCodeownersFromRef('/repo', 'origin/main', {
        spawnImpl: fakeGitShow({
            'CODEOWNERS': { status: 0, stdout: '/.pipeline/   @leitolarreta\n', stderr: '' },
        }),
    });
    assert.equal(res.ok, true);
    assert.equal(res.source, 'CODEOWNERS');
});

test('#5420 — ref inválida (metacaracteres) se rechaza sin ejecutar git', () => {
    let invoked = 0;
    for (const bad of ['main; rm -rf /', 'origin/main:.github/x', '', '--upload-pack=evil', null, 'a b']) {
        const res = codeowners.loadCodeownersFromRef('/repo', bad, {
            spawnImpl: () => { invoked++; return { status: 0, stdout: '/x @leitolarreta', stderr: '' }; },
        });
        assert.equal(res.ok, false, `ref ${JSON.stringify(bad)} debería rechazarse`);
    }
    assert.equal(invoked, 0, 'una ref inválida nunca debe llegar a ejecutar git');
});

test('#5420 — repoRoot ausente devuelve {ok:false}', () => {
    assert.equal(codeowners.loadCodeownersFromRef('', 'origin/main').ok, false);
    assert.equal(codeowners.loadCodeownersFromRef(null, 'origin/main').ok, false);
});

test('#5420 — la reason redacta credenciales y colapsa saltos de línea', () => {
    const res = codeowners.loadCodeownersFromRef('/repo', 'origin/main', {
        spawnImpl: fakeGitShow({
            '.github/CODEOWNERS': {
                status: 128, stdout: '',
                stderr: 'fatal: auth failed\nremote: token=ghp_abcdefghijklmnop1234 rechazado',
            },
        }),
    });
    assert.equal(res.ok, false);
    assert.ok(!/ghp_abcdefghijklmnop1234/.test(res.reason), 'la reason no puede filtrar el token');
    assert.ok(!/[\r\n]/.test(res.reason), 'la reason no puede tener saltos de línea');
});

test('#5420 — loadCodeowners (local) sigue devolviendo [] para consumidores existentes', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'co-compat-'));
    try {
        assert.deepEqual(codeowners.loadCodeowners(tmp), []);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

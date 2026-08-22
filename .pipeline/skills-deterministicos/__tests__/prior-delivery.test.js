// Tests de getPriorDeliveryRefs (issue #3819) — detección de "entrega previa":
// commits ya mergeados en la base que referencian al issue, para que el linter
// emita pr:already-delivered (warn) en vez de pr:no-commits (error) cuando la
// rama del ciclo quedó legítimamente vacía (trabajo arrastrado por el PR de
// otro issue).
//
// A diferencia de git-ops.test.js (builders puros), acá SÍ tocamos git: se
// crea un repo temporal con commits controlados y se consulta con base=HEAD.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ops = require('../lib/git-ops');

/** Crea un repo git temporal con un commit cuyo mensaje referencia issues. */
function makeTmpRepo(commitMessage) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prior-delivery-'));
    const git = (args) => {
        const r = ops.runGit(args, { cwd: dir });
        assert.equal(r.exit_code, 0, `git ${args.join(' ')} falló: ${r.stderr}`);
        return r;
    };
    git(['init', '-q']);
    git(['config', 'user.email', 'test@intrale.local']);
    git(['config', 'user.name', 'PriorDeliveryTest']);
    fs.writeFileSync(path.join(dir, 'archivo.txt'), 'contenido\n');
    git(['add', 'archivo.txt']);
    // Mensaje vía -F para evitar problemas de quoting con shell:true en Windows
    // (espacios, # y paréntesis a través de cmd.exe).
    const msgFile = path.join(dir, 'msg.txt');
    fs.writeFileSync(msgFile, commitMessage);
    git(['commit', '-q', '-F', 'msg.txt']);
    fs.unlinkSync(msgFile);
    return dir;
}

test('getPriorDeliveryRefs — detecta commit en la base que referencia el issue (squash body)', () => {
    // Caso real #3819: el squash del PR #3821 arrastró el entregable de #3819
    // y la referencia quedó en el BODY del commit, no en el subject.
    const dir = makeTmpRepo(
        'fix: corregir 3 defectos del validador de permisos (#3820) (#3821)\n\n' +
        '* Crear issues por Telegram de forma deterministica sin cuelgues (#3819)\n',
    );
    const refs = ops.getPriorDeliveryRefs(dir, 3819, 'HEAD');
    assert.equal(refs.length, 1);
    assert.match(refs[0], /^[0-9a-f]{7} fix: corregir 3 defectos/);
});

test('getPriorDeliveryRefs — NO matchea prefijos de otros issues (#381 vs #3819)', () => {
    const dir = makeTmpRepo('feat: algo entregado (#3819)\n');
    // "#381" es prefijo de "#3819": git --grep matchearía, el filtro JS con
    // lookahead negativo lo descarta.
    assert.equal(ops.getPriorDeliveryRefs(dir, 381, 'HEAD').length, 0);
});

test('getPriorDeliveryRefs — sin referencia al issue devuelve []', () => {
    const dir = makeTmpRepo('feat: otro trabajo sin relacion (#1111)\n');
    assert.equal(ops.getPriorDeliveryRefs(dir, 9999, 'HEAD').length, 0);
});

test('getPriorDeliveryRefs — issue null/undefined devuelve [] sin tocar git', () => {
    assert.deepEqual(ops.getPriorDeliveryRefs('.', null), []);
    assert.deepEqual(ops.getPriorDeliveryRefs('.', undefined), []);
});

test('getPriorDeliveryRefs — base inexistente devuelve [] (exit != 0)', () => {
    const dir = makeTmpRepo('feat: x (#5)\n');
    assert.deepEqual(ops.getPriorDeliveryRefs(dir, 5, 'refs/no/existe'), []);
});

// Tests de la entrega cross-repo (issue #5067) — el entregable de un issue
// puede aterrizar en un repo HERMANO declarado (`intrale/kernel`, Ola 9.x) en
// vez de en este repo. La rama del ciclo queda legítimamente sin commits y
// `pr:already-delivered` (#3819) no la cubre, porque sólo consulta el
// `origin/main` PROPIO. Sin este escape, `pr:no-commits` rebota el issue para
// siempre aunque el trabajo esté hecho, auditado y pusheado (caso #5067 rev-1).
//
// Como en prior-delivery.test.js, acá SÍ tocamos git: se arman repos temporales
// con un `origin` bare real, para poder distinguir commit PUSHEADO de commit
// sólo local (distinción central del gate).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ops = require('../lib/git-ops');
const checks = require('../lib/static-checks');

function gitIn(dir, args) {
    const r = ops.runGit(args, { cwd: dir });
    assert.equal(r.exit_code, 0, `git ${args.join(' ')} falló: ${r.stderr}`);
    return r;
}

/** Commit con mensaje vía -F: evita quoting de `#`/paréntesis con shell:true en Windows. */
function commitInto(dir, filename, message) {
    fs.writeFileSync(path.join(dir, filename), `contenido ${filename}\n`);
    gitIn(dir, ['add', filename]);
    const msgFile = path.join(dir, '__msg.txt');
    fs.writeFileSync(msgFile, message);
    gitIn(dir, ['commit', '-q', '-F', '__msg.txt']);
    fs.unlinkSync(msgFile);
}

/**
 * Arma un repo hermano con un `origin` bare real.
 * @returns {{dir: string, push: (branch: string) => void}}
 */
function makeSiblingRepo() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-repo-'));
    const originDir = path.join(base, 'origin.git');
    const workDir = path.join(base, 'work');
    fs.mkdirSync(originDir);
    fs.mkdirSync(workDir);
    gitIn(originDir, ['init', '-q', '--bare']);
    gitIn(workDir, ['init', '-q']);
    gitIn(workDir, ['config', 'user.email', 'test@intrale.local']);
    gitIn(workDir, ['config', 'user.name', 'CrossRepoTest']);
    // `origin` apunta al bare local: el fetch best-effort de getSiblingDeliveryRefs
    // resuelve sin red.
    gitIn(workDir, ['remote', 'add', 'origin', originDir]);
    return {
        dir: workDir,
        push: (branch) => gitIn(workDir, ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`]),
    };
}

// ── getSiblingDeliveryRefs ────────────────────────────────────────────

test('getSiblingDeliveryRefs — detecta el entregable pusheado en el repo hermano', () => {
    const sib = makeSiblingRepo();
    commitInto(sib.dir, 'skill.md', 'feat(skills): parametrizar los 10 skills (#5067)\n');
    sib.push('agent/5067-parametrizar-skills');

    const refs = ops.getSiblingDeliveryRefs(5067, [{ name: 'kernel', path: sib.dir }]);
    assert.equal(refs.length, 1);
    assert.match(refs[0], /^kernel@[0-9a-f]{7} feat\(skills\): parametrizar/);
});

test('getSiblingDeliveryRefs — un commit LOCAL sin push NO saltea el gate', () => {
    // Invariante de seguridad: si el trabajo no llegó al remoto, para el resto
    // del pipeline no existe. Se consulta --remotes=origin, no refs locales.
    const sib = makeSiblingRepo();
    commitInto(sib.dir, 'skill.md', 'feat(skills): trabajo sin pushear (#5067)\n');
    // deliberadamente NO se pushea
    assert.deepEqual(ops.getSiblingDeliveryRefs(5067, [{ name: 'kernel', path: sib.dir }]), []);
});

test('getSiblingDeliveryRefs — también cubre el caso ya mergeado en el main del hermano', () => {
    const sib = makeSiblingRepo();
    commitInto(sib.dir, 'skill.md', 'feat(skills): entregado y mergeado (#5067)\n');
    sib.push('main');
    const refs = ops.getSiblingDeliveryRefs(5067, [{ name: 'kernel', path: sib.dir }]);
    assert.equal(refs.length, 1);
});

test('getSiblingDeliveryRefs — NO matchea prefijos de otros issues (#506 vs #5067)', () => {
    const sib = makeSiblingRepo();
    commitInto(sib.dir, 'skill.md', 'feat: algo entregado (#5067)\n');
    sib.push('main');
    assert.deepEqual(ops.getSiblingDeliveryRefs(506, [{ name: 'kernel', path: sib.dir }]), []);
});

test('getSiblingDeliveryRefs — issue sin referencia en el hermano devuelve []', () => {
    const sib = makeSiblingRepo();
    commitInto(sib.dir, 'skill.md', 'feat: otro trabajo (#1111)\n');
    sib.push('main');
    assert.deepEqual(ops.getSiblingDeliveryRefs(9999, [{ name: 'kernel', path: sib.dir }]), []);
});

test('getSiblingDeliveryRefs — defensivo: path inexistente, no-git y lista vacía', () => {
    const noExiste = path.join(os.tmpdir(), 'cross-repo-no-existe-5067');
    assert.deepEqual(ops.getSiblingDeliveryRefs(5067, [{ name: 'kernel', path: noExiste }]), []);

    // Directorio real pero que NO es repo git: no debe tirar ni spawnear de más.
    const plano = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-repo-plano-'));
    assert.deepEqual(ops.getSiblingDeliveryRefs(5067, [{ name: 'x', path: plano }]), []);

    assert.deepEqual(ops.getSiblingDeliveryRefs(5067, []), []);
    assert.deepEqual(ops.getSiblingDeliveryRefs(5067, null), []);
    assert.deepEqual(ops.getSiblingDeliveryRefs(null, [{ name: 'k', path: plano }]), []);
});

test('getSiblingDeliveryRefs — un hermano roto no impide detectar en el siguiente', () => {
    const sib = makeSiblingRepo();
    commitInto(sib.dir, 'skill.md', 'feat(skills): entregado (#5067)\n');
    sib.push('main');
    const refs = ops.getSiblingDeliveryRefs(5067, [
        { name: 'roto', path: path.join(os.tmpdir(), 'cross-repo-inexistente-x') },
        { name: 'kernel', path: sib.dir },
    ]);
    assert.equal(refs.length, 1);
    assert.match(refs[0], /^kernel@/);
});

// ── loadSiblingRepos ─────────────────────────────────────────────────

/** Escribe un .pipeline/config.yaml temporal con el contenido dado. */
function makeConfigRoot(yamlBody) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-repo-cfg-'));
    fs.mkdirSync(path.join(root, '.pipeline'), { recursive: true });
    fs.writeFileSync(path.join(root, '.pipeline', 'config.yaml'), yamlBody);
    // #5174 — post-partición el resolver exige el manifiesto de producto junto
    // al kernel. `cross_repo_delivery` es lado KERNEL, así que la auto-partición
    // produce un slice vacío y el fixture sigue ejercitando exactamente lo mismo.
    require('../../lib/__tests__/_test-helpers').seedProductManifest(path.join(root, '.pipeline'));
    return root;
}

test('loadSiblingRepos — lee los repos y resuelve paths relativos contra la raíz', () => {
    const root = makeConfigRoot(
        'cross_repo_delivery:\n  enabled: true\n  repos:\n    - name: kernel\n      path: ../kernel\n',
    );
    const sibs = ops.loadSiblingRepos(root);
    assert.equal(sibs.length, 1);
    assert.equal(sibs[0].name, 'kernel');
    // El path relativo se ancla a la raíz del checkout principal, NO al cwd del
    // worktree del agente (que cambia por issue).
    assert.equal(sibs[0].path, path.resolve(root, '../kernel'));
});

test('loadSiblingRepos — enabled:false desactiva la detección (comportamiento previo)', () => {
    const root = makeConfigRoot(
        'cross_repo_delivery:\n  enabled: false\n  repos:\n    - name: kernel\n      path: ../kernel\n',
    );
    assert.deepEqual(ops.loadSiblingRepos(root), []);
});

test('loadSiblingRepos — sección ausente, YAML corrupto o config inexistente devuelven []', () => {
    assert.deepEqual(ops.loadSiblingRepos(makeConfigRoot('otra_cosa: 1\n')), []);
    assert.deepEqual(ops.loadSiblingRepos(makeConfigRoot('cross_repo_delivery: [[[\n')), []);
    assert.deepEqual(ops.loadSiblingRepos(path.join(os.tmpdir(), 'cross-repo-sin-config-5067')), []);
});

test('loadSiblingRepos — descarta entradas mal formadas y deriva name del path', () => {
    const root = makeConfigRoot(
        'cross_repo_delivery:\n  enabled: true\n  repos:\n' +
        '    - name: sinpath\n' +          // sin path -> descartada
        '    - path: "   "\n' +            // path vacío -> descartada
        '    - path: ../otro\n',           // sin name -> name derivado del basename
    );
    const sibs = ops.loadSiblingRepos(root);
    assert.equal(sibs.length, 1);
    assert.equal(sibs[0].name, 'otro');
});

// ── checkClosesIssue: el gate ────────────────────────────────────────

test('checkClosesIssue — rama vacía + entrega en hermano emite warn, no bloquea', () => {
    const findings = checks.checkClosesIssue([], 5067, {
        siblingDeliveryRefs: ['kernel@8cf636f fix(skills): cerrar dos vectores (#5067)'],
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].rule, 'pr:delivered-in-sibling-repo');
    assert.equal(findings[0].severity, 'warn');
    assert.match(findings[0].message, /kernel@8cf636f/);
    // El agregado sólo bloquea con severidad error: el ciclo debe seguir.
    assert.equal(checks.aggregate(findings).passed, true);
});

test('checkClosesIssue — sin evidencia en ningún lado sigue bloqueando con pr:no-commits', () => {
    // Regresión: el escape NO debe ablandar el gate cuando no hay entrega real.
    for (const opts of [{}, { siblingDeliveryRefs: [] }, { siblingDeliveryRefs: null }]) {
        const findings = checks.checkClosesIssue([], 5067, opts);
        assert.equal(findings.length, 1);
        assert.equal(findings[0].rule, 'pr:no-commits');
        assert.equal(findings[0].severity, 'error');
        assert.equal(checks.aggregate(findings).passed, false);
    }
});

test('checkClosesIssue — la entrega en el propio main (#3819) tiene precedencia sobre el hermano', () => {
    const findings = checks.checkClosesIssue([], 5067, {
        priorDeliveryRefs: ['abc1234 feat: entregado via otro PR (#5067)'],
        siblingDeliveryRefs: ['kernel@8cf636f fix(skills): algo (#5067)'],
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].rule, 'pr:already-delivered');
});

test('checkClosesIssue — con commits propios el escape no se activa', () => {
    // Con commits reales manda el flujo normal: sólo puede faltar el "Closes".
    const findings = checks.checkClosesIssue(['feat: algo (#5067)\n\nCloses #5067\n'], 5067, {
        siblingDeliveryRefs: ['kernel@8cf636f algo (#5067)'],
    });
    assert.deepEqual(findings, []);
});

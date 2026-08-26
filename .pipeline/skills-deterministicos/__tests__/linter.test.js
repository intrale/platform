// Tests unitarios de .pipeline/skills-deterministicos/linter.js (issue #2491)
// No ejecutamos git real: validamos parseArgs, heartbeat, updateMarker y
// el agregado de findings con filesystem aislado.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-linter-'));
fs.mkdirSync(path.join(TMP, '.claude', 'hooks'), { recursive: true });
fs.mkdirSync(path.join(TMP, '.pipeline', 'logs'), { recursive: true });
fs.mkdirSync(path.join(TMP, '.pipeline', 'desarrollo', 'linteo', 'trabajando'), { recursive: true });
process.env.PIPELINE_REPO_ROOT = TMP;
process.env.CLAUDE_PROJECT_DIR = TMP;

delete require.cache[require.resolve('../linter')];
const linter = require('../linter');

test('parseArgs — issue posicional', () => {
    const a = linter.parseArgs(['node', 'linter.js', '2491']);
    assert.equal(a.issue, 2491);
    assert.equal(a.base, 'origin/main');
});

test('parseArgs — --trabajando=<path> y --base=<ref>', () => {
    const a = linter.parseArgs(['node', 'x', '10', '--trabajando=/tmp/foo.linter', '--base=origin/develop']);
    assert.equal(a.trabajando, '/tmp/foo.linter');
    assert.equal(a.base, 'origin/develop');
});

test('parseArgs — fallback a PIPELINE_ISSUE y PIPELINE_TRABAJANDO', () => {
    const savedI = process.env.PIPELINE_ISSUE;
    const savedT = process.env.PIPELINE_TRABAJANDO;
    process.env.PIPELINE_ISSUE = '8888';
    process.env.PIPELINE_TRABAJANDO = '/tmp/env.linter';
    try {
        const a = linter.parseArgs(['node', 'x']);
        assert.equal(a.issue, 8888);
        assert.equal(a.trabajando, '/tmp/env.linter');
    } finally {
        if (savedI === undefined) delete process.env.PIPELINE_ISSUE; else process.env.PIPELINE_ISSUE = savedI;
        if (savedT === undefined) delete process.env.PIPELINE_TRABAJANDO; else process.env.PIPELINE_TRABAJANDO = savedT;
    }
});

test('startHeartbeat — escribe archivo con skill=linter y model=deterministic', () => {
    const hb = linter.startHeartbeat(7777);
    try {
        const hbFile = path.join(TMP, '.claude', 'hooks', 'agent-7777.heartbeat');
        assert.ok(fs.existsSync(hbFile), 'heartbeat file debe existir');
        const data = JSON.parse(fs.readFileSync(hbFile, 'utf8').trim());
        assert.equal(data.skill, 'linter');
        assert.equal(data.model, 'deterministic');
        assert.equal(data.issue, 7777);
        assert.equal(typeof data.pid, 'number');
    } finally {
        hb.stop();
    }
});

test('startHeartbeat — stop() elimina el archivo', () => {
    const hb = linter.startHeartbeat(7778);
    const hbFile = path.join(TMP, '.claude', 'hooks', 'agent-7778.heartbeat');
    assert.ok(fs.existsSync(hbFile));
    hb.stop();
    assert.ok(!fs.existsSync(hbFile));
});

test('updateMarker — actualiza YAML sin duplicar keys', () => {
    const markerPath = path.join(TMP, '.pipeline', 'desarrollo', 'linteo', 'trabajando', '999.linter');
    fs.writeFileSync(markerPath, 'issue: 999\nskill: "linter"\nresultado: "pendiente"\n');
    linter.updateMarker(markerPath, {
        resultado: 'aprobado',
        motivo: 'Linter OK',
        linter_errors: 0,
    });
    const content = fs.readFileSync(markerPath, 'utf8');
    assert.match(content, /resultado: "aprobado"/);
    assert.match(content, /motivo: "Linter OK"/);
    assert.match(content, /linter_errors: 0/);
    // No debe haber duplicado la key "resultado"
    const matches = content.match(/^resultado:/gm) || [];
    assert.equal(matches.length, 1, 'resultado debe aparecer una sola vez');
});

test('updateMarker — sin trabajandoPath no tira excepción', () => {
    assert.doesNotThrow(() => linter.updateMarker(null, { foo: 'bar' }));
    assert.doesNotThrow(() => linter.updateMarker(undefined, { foo: 'bar' }));
});

test('runAllChecks — sin base resoluble lanza LINTER_BASE_UNAVAILABLE (no pr:no-commits)', () => {
    // (#6495) Cambio de contrato deliberado. ANTES este caso (dir que no es
    // repo git) devolvía un shape "normal" con commitCount=0, lo que aguas
    // abajo se traducía en un `pr:no-commits` — un RECHAZO a dev por una falla
    // de infraestructura. Ahora se propaga como excepción para que main() salga
    // con exit 2 (infra) en vez de facturarle el problema al entregable.
    let err = null;
    try { linter.runAllChecks({ issue: 1, cwd: TMP, base: 'origin/main' }); }
    catch (e) { err = e; }
    assert.ok(err, 'debe lanzar cuando la base no resuelve');
    assert.equal(err.code, 'LINTER_BASE_UNAVAILABLE');
    assert.match(err.message, /No se pudo resolver la base/);
});

// Regresión #2523 rev-1: el linter debe operar sobre el worktree del agente,
// no sobre el checkout principal. Antes del fix, REPO_ROOT (calculado desde
// __dirname) apuntaba siempre al monorepo principal y `runAllChecks` recibía
// ese cwd, leyendo la rama y los commits incorrectos. Verificamos acá que el
// módulo expone tanto REPO_ROOT como WORK_DIR y que WORK_DIR se resuelve a
// partir de PIPELINE_WORKTREE / process.cwd() / fallback REPO_ROOT.
test('módulo — WORK_DIR distinto de REPO_ROOT cuando PIPELINE_WORKTREE difiere', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-linter-root-'));
    const tmpWork = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-linter-work-'));
    fs.mkdirSync(path.join(tmpRoot, '.claude', 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, '.pipeline', 'logs'), { recursive: true });

    const savedRepo = process.env.PIPELINE_REPO_ROOT;
    const savedClaudeDir = process.env.CLAUDE_PROJECT_DIR;
    const savedWork = process.env.PIPELINE_WORKTREE;
    process.env.PIPELINE_REPO_ROOT = tmpRoot;
    process.env.CLAUDE_PROJECT_DIR = tmpRoot;
    process.env.PIPELINE_WORKTREE = tmpWork;

    try {
        delete require.cache[require.resolve('../linter')];
        const fresh = require('../linter');
        assert.equal(fresh.REPO_ROOT, tmpRoot, 'REPO_ROOT debe respetar PIPELINE_REPO_ROOT');
        assert.equal(fresh.WORK_DIR, tmpWork, 'WORK_DIR debe respetar PIPELINE_WORKTREE');
        assert.notEqual(fresh.REPO_ROOT, fresh.WORK_DIR, 'WORK_DIR ≠ REPO_ROOT cuando el agente corre en worktree');
    } finally {
        if (savedRepo === undefined) delete process.env.PIPELINE_REPO_ROOT; else process.env.PIPELINE_REPO_ROOT = savedRepo;
        if (savedClaudeDir === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = savedClaudeDir;
        if (savedWork === undefined) delete process.env.PIPELINE_WORKTREE; else process.env.PIPELINE_WORKTREE = savedWork;
        // Restaurar carga del módulo bajo el setup global del archivo
        delete require.cache[require.resolve('../linter')];
        require('../linter');
    }
});

test('módulo — sin PIPELINE_WORKTREE WORK_DIR cae a process.cwd()', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-linter-cwd-'));
    fs.mkdirSync(path.join(tmpRoot, '.claude', 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, '.pipeline', 'logs'), { recursive: true });

    const savedRepo = process.env.PIPELINE_REPO_ROOT;
    const savedClaudeDir = process.env.CLAUDE_PROJECT_DIR;
    const savedWork = process.env.PIPELINE_WORKTREE;
    process.env.PIPELINE_REPO_ROOT = tmpRoot;
    process.env.CLAUDE_PROJECT_DIR = tmpRoot;
    delete process.env.PIPELINE_WORKTREE;

    try {
        delete require.cache[require.resolve('../linter')];
        const fresh = require('../linter');
        // Sin PIPELINE_WORKTREE, WORK_DIR debe usar process.cwd() (no REPO_ROOT).
        // Esto importa porque el pulpo ya hace `cwd: <worktree>` en el spawn.
        assert.equal(fresh.WORK_DIR, process.cwd(), 'WORK_DIR debe ser process.cwd() cuando no hay PIPELINE_WORKTREE');
    } finally {
        if (savedRepo === undefined) delete process.env.PIPELINE_REPO_ROOT; else process.env.PIPELINE_REPO_ROOT = savedRepo;
        if (savedClaudeDir === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = savedClaudeDir;
        if (savedWork !== undefined) process.env.PIPELINE_WORKTREE = savedWork;
        delete require.cache[require.resolve('../linter')];
        require('../linter');
    }
});

// ---------------------------------------------------------------------------
// Regresión #6495: el fetch fallido NO puede disfrazarse de "rama vacía".
//
// Incidente: el linter rebotó a dev la rama agent/6495-pipeline-dev con
// `pr:no-commits` cuando la rama tenía 15 commits pusheados. Causa: `hasBase`
// se derivaba del exit code de `git fetch`; al fallar el fetch (timeout de 60s
// en una corrida de 133s) se salteaban log/diff/stats y `commitMsgs` quedaba
// vacío, que `checkClosesIssue` interpreta como rama sin commits.
// ---------------------------------------------------------------------------

const gitOps = require('../lib/git-ops');

/** Ejecuta fn con git-ops parcheado y restaura siempre. */
function withGitStub(stub, fn) {
    const saved = {};
    for (const k of Object.keys(stub)) { saved[k] = gitOps[k]; gitOps[k] = stub[k]; }
    try { return fn(); } finally { for (const k of Object.keys(saved)) gitOps[k] = saved[k]; }
}

/** runGit falso: responde al log/diff según el subcomando pedido. */
function fakeRunGit({ commits = [], files = [] } = {}) {
    return (args) => {
        const sub = args[0];
        if (sub === 'log') {
            return { exit_code: 0, stdout: commits.map((c) => `${c}\n---COMMIT---`).join('\n'), stderr: '' };
        }
        if (sub === 'diff') {
            if (args.includes('--name-only')) return { exit_code: 0, stdout: files.join('\n'), stderr: '' };
            if (args.includes('--shortstat')) {
                return { exit_code: 0, stdout: ` ${files.length} files changed, 10 insertions(+), 2 deletions(-)`, stderr: '' };
            }
            return { exit_code: 0, stdout: 'diff --git a/x b/x', stderr: '' };
        }
        return { exit_code: 0, stdout: '', stderr: '' };
    };
}

test('#6495 — fetch fallido con ref local resoluble NO emite pr:no-commits', () => {
    const r = withGitStub({
        fetchOrigin: () => ({ exit_code: 128, stdout: '', stderr: 'fatal: unable to access: Could not resolve host' }),
        refExists: () => true,
        getCurrentBranch: () => 'agent/6495-pipeline-dev',
        getPriorDeliveryRefs: () => [],
        getSiblingDeliveryRefs: () => [],
        loadSiblingRepos: () => [],
        runGit: fakeRunGit({ commits: ['fix(pipeline): algo (#6495)\n\nCloses #6495'], files: ['.pipeline/linter.js'] }),
    }, () => linter.runAllChecks({ issue: 6495, cwd: TMP, base: 'origin/main' }));

    const rules = r.findings.map((f) => f.rule);
    assert.ok(!rules.includes('pr:no-commits'), `no debe rebotar por fetch caído; findings=${JSON.stringify(rules)}`);
    assert.equal(r.commitCount, 1, 'debe leer los commits contra el ref local');
    assert.equal(r.fileCount, 1);
    assert.equal(r.baseStale, true, 'debe marcar la base como desactualizada');
});

test('#6495 — rama genuinamente vacía con base fresca SIGUE emitiendo pr:no-commits', () => {
    // El fix no debe abrir un agujero: si de verdad no hay commits, el gate bloquea.
    const r = withGitStub({
        fetchOrigin: () => ({ exit_code: 0, stdout: '', stderr: '' }),
        refExists: () => true,
        getCurrentBranch: () => 'agent/6495-pipeline-dev',
        getPriorDeliveryRefs: () => [],
        getSiblingDeliveryRefs: () => [],
        loadSiblingRepos: () => [],
        runGit: fakeRunGit({ commits: [], files: [] }),
    }, () => linter.runAllChecks({ issue: 6495, cwd: TMP, base: 'origin/main' }));

    const rules = r.findings.map((f) => f.rule);
    assert.ok(rules.includes('pr:no-commits'), 'la rama vacía real debe seguir bloqueando');
    assert.equal(r.baseStale, false);
});

// Estos dos corren contra el repo git REAL a proposito: el bug que cierran es
// de interaccion con cmd.exe (runCmd usa shell:true en Windows), y un stub de
// runGit no lo reproduce — de hecho lo esconderia.
const REAL_REPO = path.resolve(__dirname, '..', '..', '..');

test('#6495 — refExists resuelve refs reales (si vuelve ^{commit}, cmd.exe se come el ^ y esto falla)', () => {
    assert.equal(gitOps.refExists(REAL_REPO, 'HEAD'), true, 'HEAD debe resolver en el worktree real');
    assert.equal(gitOps.refExists(REAL_REPO, 'no/such/ref-6495'), false, 'un ref inexistente es false');
    assert.equal(gitOps.refExists(REAL_REPO, ''), false, 'ref vacio es false');
});

test('#6495 — refExists es false fuera de un repo git (dispara el camino de infra)', () => {
    assert.equal(gitOps.refExists(TMP, 'origin/main'), false, 'sin repo no hay base resoluble');
});

// #7112 rebote rev-3 (G2) — el lanzador fija `GRADLE_LOCK_PATH` para los skills
// determinísticos.
//
// Defecto que cubre: `lib/gradle-lock.js` resuelve su default vía
// `lib/write-target` (canal `estado`), que ancla "productivo" al `.pipeline`
// del checkout que CARGÓ la lib. Cuando `resolveDeterministicScript` elige la
// copia del WORKTREE de `build.js`/`tester.js` (la rama los modifica), esa copia
// carga `../lib/gradle-lock` del worktree ⇒ productivo = `<wt>/.pipeline`, y
// con el env real del skill (`PIPELINE_AMBIENTE=productivo` +
// `PIPELINE_REPO_ROOT=<repo principal>`) el resolvedor da `dir: null` (SEC-9)
// ⇒ `withGradleLock` lanzaba `PIPELINE_ESCRITURA_BLOQUEADA` en `build` /
// `verificacion`. Nadie inyectaba `GRADLE_LOCK_PATH`.
//
// Fix: `providers/deterministic.buildSpawn` inyecta SIEMPRE
// `GRADLE_LOCK_PATH=<PIPELINE del Pulpo>/locks/gradle-global.lock` en el env
// del hijo; `gradle-lock.js` ya lo honra por `resolveLockPath()`.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const determProvider = require('../lib/agent-launcher/providers/deterministic');

// ── Fakes (mismo criterio que resolve-deterministic-script.test.js) ─────────
function fakeExecSync({ worktrees = '', diff = '', status = '' } = {}) {
    return (cmd) => {
        if (cmd.includes('worktree list')) return worktrees;
        if (cmd.includes('git diff')) return diff;
        if (cmd.includes('git status')) return status;
        throw new Error(`comando git inesperado en el fake: ${cmd}`);
    };
}
function fakeFs(existingPaths) {
    const set = new Set(existingPaths);
    return { existsSync: (p) => set.has(p) };
}

const ROOT = path.resolve('/repo/platform');
const PIPELINE = path.join(ROOT, '.pipeline');
const WT = path.resolve('/repo/platform.agent-7112-pipeline-dev');
const LOCK_ESPERADO = path.join(PIPELINE, 'locks', 'gradle-global.lock');

function spawnDe({ skill, worktreeHit }) {
    const wtScript = path.join(WT, '.pipeline', 'skills-deterministicos', `${skill}.js`);
    const envDelLlamador = { PIPELINE_AMBIENTE: 'productivo', PIPELINE_REPO_ROOT: ROOT, PIPELINE_ISSUE: '7112' };
    const def = determProvider.buildSpawn({
        skill, issue: 7112, trabajandoPath: '/work/7112.' + skill, cwd: worktreeHit ? WT : ROOT,
        env: envDelLlamador, ROOT, PIPELINE,
        execSyncImpl: fakeExecSync({
            worktrees: `worktree ${ROOT}\nHEAD a\n\nworktree ${WT}\nHEAD b\n\n`,
            diff: worktreeHit ? `.pipeline/skills-deterministicos/${skill}.js\n` : '',
        }),
        fsImpl: fakeFs(worktreeHit ? [wtScript] : []),
    });
    return { def, envDelLlamador, wtScript };
}

test('G2 · buildSpawn inyecta GRADLE_LOCK_PATH del .pipeline del Pulpo cuando corre la copia del WORKTREE', () => {
    const { def, wtScript } = spawnDe({ skill: 'tester', worktreeHit: true });
    assert.equal(def.scriptPath, wtScript, 'precondición: la rama modifica tester.js ⇒ gana el worktree');
    assert.equal(def.spawnOpts.env[determProvider.GRADLE_LOCK_ENV], LOCK_ESPERADO);
    // El lock NO cuelga del worktree: es el del Pulpo que coordina.
    assert.ok(!def.spawnOpts.env.GRADLE_LOCK_PATH.startsWith(WT + path.sep));
});

test('G2 · buildSpawn inyecta el MISMO lock cuando corre la copia de ROOT (un solo archivo para todos los hijos, CA-4 de #4155)', () => {
    const { def } = spawnDe({ skill: 'build', worktreeHit: false });
    assert.equal(def.scriptPath, path.join(PIPELINE, 'skills-deterministicos', 'build.js'));
    assert.equal(def.spawnOpts.env.GRADLE_LOCK_PATH, LOCK_ESPERADO);
});

test('G2 · el env del llamador no se muta y el resto de las variables viaja intacto', () => {
    const { def, envDelLlamador } = spawnDe({ skill: 'tester', worktreeHit: true });
    assert.equal(envDelLlamador.GRADLE_LOCK_PATH, undefined, 'buildSpawn devuelve una copia');
    assert.equal(def.spawnOpts.env.PIPELINE_AMBIENTE, 'productivo');
    assert.equal(def.spawnOpts.env.PIPELINE_REPO_ROOT, ROOT);
    assert.equal(def.spawnOpts.env.PIPELINE_ISSUE, '7112');
    // Invariantes previas del spawn determinístico se conservan.
    assert.equal(def.spawnOpts.shell, false);
    assert.equal(def.cmd, process.execPath);
});

test('G2 · los cuatro skills determinísticos reciben la variable (inerte para delivery/linter)', () => {
    for (const skill of determProvider.DETERMINISTIC_SKILLS) {
        const { def } = spawnDe({ skill, worktreeHit: false });
        assert.equal(def.spawnOpts.env.GRADLE_LOCK_PATH, LOCK_ESPERADO, `skill ${skill}`);
    }
});

test('G2 · gradleLockPathFor deriva de PIPELINE: en un pipeline de pruebas (override) el lock también es el del override', () => {
    const pruebas = path.resolve('/tmp/pipeline-pruebas/.pipeline');
    assert.equal(determProvider.gradleLockPathFor(pruebas), path.join(pruebas, 'locks', 'gradle-global.lock'));
});

// ── Reproductor end-to-end del rechazo ──────────────────────────────────────
//
// Se carga `lib/gradle-lock.js` de ESTE checkout en un proceso hijo con env
// controlado (`resolveLockPath` lee `process.env`, y el runner de tests trae
// `NODE_TEST_CONTEXT`, que no puede heredarse para simular el env real del
// skill). ESTE checkout hace de "worktree": su `DEFAULT_PRODUCTIVE_DIR` es su
// propio `.pipeline`, y `PIPELINE_REPO_ROOT` apunta a OTRO dir (el "repo
// principal"). Sin `GRADLE_LOCK_PATH` ⇒ lanza (el defecto). Con el env que
// produce `buildSpawn` ⇒ resuelve el lock del Pulpo sin lanzar.
const GRADLE_LOCK_LIB = path.resolve(__dirname, '..', 'lib', 'gradle-lock.js');

function resolverEnHijo(env) {
    const script = [
        `const gl = require(${JSON.stringify(GRADLE_LOCK_LIB)});`,
        'try { process.stdout.write(JSON.stringify({ ok: true, lockPath: gl.resolveLockPath() })); }',
        'catch (e) { process.stdout.write(JSON.stringify({ ok: false, code: e.code, motivo: e.motivo })); }',
    ].join('\n');
    // Env mínimo + `NODE_PATH`: un worktree sin `node_modules/` resuelve `js-yaml`
    // (config-resolver) por ahí. Ninguna `PIPELINE_*` ni señal de test se hereda.
    const out = execFileSync(process.execPath, ['-e', script], {
        env: {
            PATH: process.env.PATH, SystemRoot: process.env.SystemRoot || '',
            ...(process.env.NODE_PATH ? { NODE_PATH: process.env.NODE_PATH } : {}),
            ...env,
        },
        encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return JSON.parse(out);
}

test('G2 · reproductor: gradle-lock cargado desde el "worktree" con el env real del skill LANZA sin GRADLE_LOCK_PATH', () => {
    const repoPrincipal = fs.mkdtempSync(path.join(os.tmpdir(), 'g2-repo-principal-'));
    const r = resolverEnHijo({ PIPELINE_AMBIENTE: 'productivo', PIPELINE_REPO_ROOT: repoPrincipal });
    assert.equal(r.ok, false, 'precondición del rechazo: sin la variable, el default por write-target bloquea');
    assert.equal(r.code, 'PIPELINE_ESCRITURA_BLOQUEADA');
    assert.match(String(r.motivo), /SEC-9/);
});

test('G2 · reproductor: con el env que arma buildSpawn resuelve el lock del Pulpo sin lanzar', () => {
    const repoPrincipal = fs.mkdtempSync(path.join(os.tmpdir(), 'g2-repo-principal-'));
    const pipelineDelPulpo = path.join(repoPrincipal, '.pipeline');
    const def = determProvider.buildSpawn({
        skill: 'tester', issue: 7112, trabajandoPath: '/work/7112.tester', cwd: repoPrincipal,
        env: { PIPELINE_AMBIENTE: 'productivo', PIPELINE_REPO_ROOT: repoPrincipal },
        ROOT: repoPrincipal, PIPELINE: pipelineDelPulpo,
        execSyncImpl: fakeExecSync({ worktrees: '' }), fsImpl: fakeFs([]),
    });
    const r = resolverEnHijo({
        PIPELINE_AMBIENTE: def.spawnOpts.env.PIPELINE_AMBIENTE,
        PIPELINE_REPO_ROOT: def.spawnOpts.env.PIPELINE_REPO_ROOT,
        GRADLE_LOCK_PATH: def.spawnOpts.env.GRADLE_LOCK_PATH,
    });
    assert.equal(r.ok, true, `debería resolver: ${JSON.stringify(r)}`);
    assert.equal(r.lockPath, path.join(pipelineDelPulpo, 'locks', 'gradle-global.lock'));
});

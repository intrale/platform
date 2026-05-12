// Tests unitarios de .pipeline/skills-deterministicos/build.js (issue #2476, rename #3157)
// No lanzamos gradle real: validamos parseArgs, buildGradleCommand, heartbeat,
// updateMarker y copyArtifacts con filesystem aislado.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Aislar REPO_ROOT a un tmp — el módulo resuelve paths a partir de env vars.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-build-'));
fs.mkdirSync(path.join(TMP, '.claude', 'hooks'), { recursive: true });
fs.mkdirSync(path.join(TMP, '.pipeline', 'logs'), { recursive: true });
fs.mkdirSync(path.join(TMP, '.pipeline', 'desarrollo', 'build', 'trabajando'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'qa', 'artifacts'), { recursive: true });
process.env.PIPELINE_REPO_ROOT = TMP;
process.env.CLAUDE_PROJECT_DIR = TMP;

delete require.cache[require.resolve('../build')];
const builder = require('../build');

test('parseArgs — issue posicional + scope por defecto smart', () => {
    const a = builder.parseArgs(['node', 'build.js', '2476']);
    assert.equal(a.issue, 2476);
    assert.equal(a.scope, 'smart');
    assert.equal(a.module, null);
});

test('parseArgs — flags --clean/--fast/--all/--verify', () => {
    assert.equal(builder.parseArgs(['node', 'x', '1', '--clean']).scope, 'clean');
    assert.equal(builder.parseArgs(['node', 'x', '1', '--fast']).scope, 'fast');
    assert.equal(builder.parseArgs(['node', 'x', '1', '--all']).scope, 'all');
    assert.equal(builder.parseArgs(['node', 'x', '1', '--verify']).scope, 'verify');
});

test('parseArgs — --module=<nombre>', () => {
    const a = builder.parseArgs(['node', 'x', '1', '--module=backend']);
    assert.equal(a.module, 'backend');
});

test('parseArgs — fallback a PIPELINE_ISSUE si no hay argumento posicional', () => {
    const saved = process.env.PIPELINE_ISSUE;
    process.env.PIPELINE_ISSUE = '9999';
    try {
        const a = builder.parseArgs(['node', 'x']);
        assert.equal(a.issue, 9999);
    } finally {
        if (saved === undefined) delete process.env.PIPELINE_ISSUE;
        else process.env.PIPELINE_ISSUE = saved;
    }
});

test('buildGradleCommand — smart por defecto usa scripts/smart-build.sh', () => {
    const c = builder.buildGradleCommand('smart', null);
    // En Windows, cmd puede ser el path absoluto a Git Bash (resolución explícita
    // para evitar WSL relay — regresión #3078). En otros OS o si Git Bash no está
    // instalado, queda como literal 'bash'.
    if (process.platform === 'win32' && path.isAbsolute(c.cmd)) {
        assert.ok(c.cmd.toLowerCase().endsWith('bash.exe'),
            `cmd path absoluto debe terminar en bash.exe, fue: ${c.cmd}`);
    } else {
        assert.equal(c.cmd, 'bash');
    }
    assert.deepEqual(c.args, ['scripts/smart-build.sh']);
    assert.equal(c.label, 'smart');
});

test('resolveBashOnWindows — en non-Windows devuelve null', () => {
    if (process.platform === 'win32') return; // skip en Windows
    assert.equal(builder.resolveBashOnWindows(), null);
});

test('resolveBashOnWindows — en Windows prefiere Git Bash sobre PATH (regresión #3078)', () => {
    if (process.platform !== 'win32') return; // skip fuera de Windows
    const resolved = builder.resolveBashOnWindows();
    // Si resuelve, debe ser path absoluto a un .exe existente; nunca el bash de WSL.
    if (resolved !== null) {
        assert.ok(path.isAbsolute(resolved), `path no absoluto: ${resolved}`);
        assert.ok(fs.existsSync(resolved), `bash.exe resuelto no existe: ${resolved}`);
        const lower = resolved.toLowerCase();
        assert.ok(!lower.includes('\\windows\\system32\\bash.exe'),
            'NO debe resolver al WSL relay (windows/system32/bash.exe)');
        assert.ok(!lower.includes('\\windowsapps\\bash.exe'),
            'NO debe resolver al stub WSL en WindowsApps');
    }
    // null es aceptable si Git Bash no está instalado: build.js cae a literal 'bash'.
});

test('resolveBashOnWindows — GIT_BASH env override gana sobre paths default', () => {
    if (process.platform !== 'win32') return;
    const saved = process.env.GIT_BASH;
    // Punto a un archivo que sí existe para que la primera iteración matche.
    const fakeBash = path.join(os.tmpdir(), 'fake-bash-' + Date.now() + '.exe');
    fs.writeFileSync(fakeBash, 'FAKE');
    try {
        process.env.GIT_BASH = fakeBash;
        assert.equal(builder.resolveBashOnWindows(), fakeBash);
    } finally {
        if (saved === undefined) delete process.env.GIT_BASH;
        else process.env.GIT_BASH = saved;
        try { fs.unlinkSync(fakeBash); } catch {}
    }
});

test('buildGradleCommand — clean usa ./gradlew clean build --no-daemon', () => {
    const c = builder.buildGradleCommand('clean', null);
    assert.equal(c.cmd, './gradlew');
    assert.ok(c.args.includes('clean'));
    assert.ok(c.args.includes('build'));
    assert.ok(c.args.includes('--no-daemon'));
});

test('buildGradleCommand — module=app mapea a :app:composeApp:check', () => {
    const c = builder.buildGradleCommand('smart', 'app');
    assert.equal(c.cmd, './gradlew');
    assert.ok(c.args.includes(':app:composeApp:check'));
    assert.equal(c.label, 'module:app');
});

test('buildGradleCommand — module=backend mapea a :backend:check', () => {
    const c = builder.buildGradleCommand('smart', 'backend');
    assert.ok(c.args.includes(':backend:check'));
});

test('startHeartbeat — escribe archivo agent-<issue>.heartbeat y lo limpia al stop', () => {
    const hb = builder.startHeartbeat(2476);
    const hbFile = path.join(TMP, '.claude', 'hooks', 'agent-2476.heartbeat');
    assert.equal(fs.existsSync(hbFile), true);
    const content = JSON.parse(fs.readFileSync(hbFile, 'utf8').trim());
    assert.equal(content.issue, 2476);
    assert.equal(content.skill, 'build');
    assert.equal(content.model, 'deterministic');
    hb.stop();
    assert.equal(fs.existsSync(hbFile), false);
});

test('startHeartbeat — issue null es no-op', () => {
    const hb = builder.startHeartbeat(null);
    // No debe lanzar ni crear nada; stop es idempotente
    hb.stop();
});

test('updateMarker — escribe resultado y motivo al YAML', () => {
    const marker = path.join(TMP, '.pipeline', 'desarrollo', 'build', 'trabajando', '2476.build');
    fs.writeFileSync(marker, 'issue: 2476\npipeline: desarrollo\n');
    builder.updateMarker(marker, { resultado: 'aprobado', motivo: 'Build exitoso', build_mode: 'deterministic' });
    const after = fs.readFileSync(marker, 'utf8');
    assert.ok(after.includes('resultado:'));
    assert.ok(after.includes('"aprobado"'));
    assert.ok(after.includes('"Build exitoso"'));
    assert.ok(after.includes('build_mode:'));
    // No duplicó issue/pipeline
    const issueLines = after.split('\n').filter((l) => l.startsWith('issue:'));
    assert.equal(issueLines.length, 1);
});

test('updateMarker — trabajandoPath null es no-op', () => {
    // No debe lanzar
    builder.updateMarker(null, { resultado: 'aprobado' });
});

test('copyArtifacts — copia users-all.jar si existe y el módulo users fue tocado', () => {
    const srcDir = path.join(TMP, 'users', 'build', 'libs');
    fs.mkdirSync(srcDir, { recursive: true });
    const src = path.join(srcDir, 'users-all.jar');
    fs.writeFileSync(src, 'FAKE JAR');
    // Limpiar destino
    const dst = path.join(TMP, 'qa', 'artifacts', 'users-all.jar');
    try { fs.unlinkSync(dst); } catch {}

    const artifacts = builder.copyArtifacts({ modules: ['users'] });
    assert.ok(artifacts.includes('users-all.jar'));
    assert.equal(fs.existsSync(dst), true);
    assert.equal(fs.readFileSync(dst, 'utf8'), 'FAKE JAR');
});

test('copyArtifacts — escribe BUILD_TIMESTAMP siempre', () => {
    const ts = path.join(TMP, 'qa', 'artifacts', 'BUILD_TIMESTAMP');
    try { fs.unlinkSync(ts); } catch {}
    const artifacts = builder.copyArtifacts({ modules: [] });
    assert.ok(artifacts.includes('BUILD_TIMESTAMP'));
    assert.equal(fs.existsSync(ts), true);
});

// ── Mutex de build (regresión #3078 segundo rebote) ─────────────────
// Causa raíz: dos builds concurrentes contendían por el lock del
// `.gradle/buildOutputCleanup` cache del REPO_ROOT compartido. El segundo
// timeouteaba en ~60s y rebotaba el issue por un fallo de infra (no de
// código). Estos tests cubren el mutex que previene esa contención.

test('isPidAlive — process.pid actual está vivo', () => {
    assert.equal(builder.isPidAlive(process.pid), true);
});

test('isPidAlive — PIDs inválidos o muertos devuelven false', () => {
    assert.equal(builder.isPidAlive(null), false);
    assert.equal(builder.isPidAlive(0), false);
    assert.equal(builder.isPidAlive(-1), false);
    assert.equal(builder.isPidAlive(NaN), false);
    // PID muy alto que casi seguro no existe.
    assert.equal(builder.isPidAlive(2147483646), false);
});

test('acquireBuildLock — crea el lockfile con metadata del proceso', () => {
    const lockPath = path.join(TMP, '.pipeline', `build-skill-test-${Date.now()}.lock`);
    try { fs.unlinkSync(lockPath); } catch {}

    const r = builder.acquireBuildLock(3078, { lockPath, timeoutMs: 1000 });
    try {
        assert.equal(r.timedOut, false);
        assert.equal(r.lockPath, lockPath);
        assert.equal(fs.existsSync(lockPath), true);
        const meta = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        assert.equal(meta.pid, process.pid);
        assert.equal(meta.issue, 3078);
        assert.equal(meta.skill, 'build');
        assert.ok(typeof meta.ts === 'number' && meta.ts > 0);
    } finally {
        builder.releaseBuildLock(lockPath);
    }
});

test('acquireBuildLock — segundo intento timeouts si el primero no se libera', () => {
    const lockPath = path.join(TMP, '.pipeline', `build-skill-test-${Date.now()}-a.lock`);
    try { fs.unlinkSync(lockPath); } catch {}

    // Tomamos el lock simulando otro proceso vivo (este proceso).
    const first = builder.acquireBuildLock(1, { lockPath, timeoutMs: 1000 });
    try {
        assert.equal(first.timedOut, false);
        // Segundo intento con timeout corto debería timeoutear (mismo PID ⇒ vivo).
        const second = builder.acquireBuildLock(2, { lockPath, timeoutMs: 500, pollMs: 50 });
        assert.equal(second.timedOut, true);
        assert.equal(second.lockPath, null);
        assert.ok(second.waited_ms >= 500, `esperó al menos 500ms, midió ${second.waited_ms}ms`);
    } finally {
        builder.releaseBuildLock(first.lockPath);
    }
});

test('acquireBuildLock — roba lock stale (holder PID muerto)', () => {
    const lockPath = path.join(TMP, '.pipeline', `build-skill-test-${Date.now()}-b.lock`);
    try { fs.unlinkSync(lockPath); } catch {}

    // Escribimos manualmente un lock con un PID muy alto que casi seguro no existe.
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({
        pid: 2147483646,
        issue: 9999,
        skill: 'build',
        ts: Date.now() - 60_000,
    }));

    const r = builder.acquireBuildLock(3078, { lockPath, timeoutMs: 5000, pollMs: 50 });
    try {
        assert.equal(r.timedOut, false);
        assert.equal(r.stolen, true, 'debe marcar stolen=true cuando reclama lock muerto');
        const meta = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        assert.equal(meta.pid, process.pid, 'el lock ahora pertenece a este proceso');
    } finally {
        builder.releaseBuildLock(r.lockPath);
    }
});

test('acquireBuildLock — repara lockfile corrupto en vez de deadlockear', () => {
    const lockPath = path.join(TMP, '.pipeline', `build-skill-test-${Date.now()}-c.lock`);
    try { fs.unlinkSync(lockPath); } catch {}

    // Lock con JSON inválido (corrupto).
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, 'NO ES JSON {{{');

    const r = builder.acquireBuildLock(3078, { lockPath, timeoutMs: 1000, pollMs: 50 });
    try {
        assert.equal(r.timedOut, false);
        assert.equal(r.stolen, true, 'lock corrupto se considera stale y se reclama');
        const meta = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        assert.equal(meta.pid, process.pid);
    } finally {
        builder.releaseBuildLock(r.lockPath);
    }
});

test('releaseBuildLock — idempotente: no rompe si el lock no existe', () => {
    const lockPath = path.join(TMP, '.pipeline', `build-skill-test-${Date.now()}-d.lock`);
    // No existe — primer release debe ser no-op safe.
    assert.equal(builder.releaseBuildLock(lockPath), false);
    // Segundo release tampoco.
    assert.equal(builder.releaseBuildLock(lockPath), false);
    // releaseBuildLock(null/undefined) tampoco rompe.
    assert.equal(builder.releaseBuildLock(null), false);
    assert.equal(builder.releaseBuildLock(undefined), false);
});

test('releaseBuildLock — borra lock propio del proceso actual', () => {
    const lockPath = path.join(TMP, '.pipeline', `build-skill-test-${Date.now()}-e.lock`);
    try { fs.unlinkSync(lockPath); } catch {}

    const r = builder.acquireBuildLock(3078, { lockPath, timeoutMs: 1000 });
    assert.equal(fs.existsSync(lockPath), true);
    const released = builder.releaseBuildLock(r.lockPath);
    assert.equal(released, true);
    assert.equal(fs.existsSync(lockPath), false);
});

test('releaseBuildLock — no toca lock de otro proceso (defensivo)', () => {
    const lockPath = path.join(TMP, '.pipeline', `build-skill-test-${Date.now()}-f.lock`);
    try { fs.unlinkSync(lockPath); } catch {}

    // Lock con PID distinto al actual.
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const otherPid = process.pid === 1 ? 2 : 1;
    fs.writeFileSync(lockPath, JSON.stringify({ pid: otherPid, issue: 1, skill: 'build', ts: Date.now() }));

    const released = builder.releaseBuildLock(lockPath);
    assert.equal(released, false, 'no debe borrar lock que no es nuestro');
    assert.equal(fs.existsSync(lockPath), true, 'el lock sigue ahí');
    // Cleanup.
    try { fs.unlinkSync(lockPath); } catch {}
});

test('BUILD_LOCK_PATH — está bajo REPO_ROOT/.pipeline/', () => {
    assert.ok(builder.BUILD_LOCK_PATH.includes(path.join('.pipeline', 'build-skill.lock')) ||
        builder.BUILD_LOCK_PATH.endsWith('build-skill.lock'),
        `BUILD_LOCK_PATH inesperado: ${builder.BUILD_LOCK_PATH}`);
});

test('BUILD_LOCK_TIMEOUT_MS — default suficientemente largo para 2 builds (>=10min)', () => {
    // El bug original fue Gradle timeouteando en ~60s. Nuestro mutex debe
    // esperar bastante más que un build promedio (5-10 min).
    assert.ok(builder.BUILD_LOCK_TIMEOUT_MS >= 10 * 60 * 1000,
        `timeout default debe ser >=10min, fue ${builder.BUILD_LOCK_TIMEOUT_MS}ms`);
});

// ── Cleanup de daemons Gradle huérfanos (regresión #3078 tercer rebote) ─
//
// El cleanup mata procesos cuya commandline contenga "GradleDaemon". No
// podemos lanzar daemons reales en CI, pero sí validamos:
//   - listOrphanGradleDaemons no incluye nuestro propio PID
//   - listOrphanGradleDaemons es robusto si wmic/ps no devuelve nada
//   - cleanupOrphanGradleDaemons reporta {killed, attempted} con shape correcto
//   - cleanupOrphanGradleDaemons NO rompe en máquinas sin daemons vivos

test('listOrphanGradleDaemons — nunca incluye el PID del proceso actual (regresión #3078)', () => {
    const pids = builder.listOrphanGradleDaemons();
    assert.ok(Array.isArray(pids), `debe devolver un array, devolvió ${typeof pids}`);
    assert.ok(!pids.includes(process.pid),
        `lista no debe contener el PID actual (${process.pid}); contenía ${JSON.stringify(pids)}`);
});

test('listOrphanGradleDaemons — solo devuelve enteros positivos', () => {
    const pids = builder.listOrphanGradleDaemons();
    for (const p of pids) {
        assert.equal(typeof p, 'number', `PID debe ser number, fue ${typeof p}`);
        assert.ok(Number.isFinite(p) && p > 0, `PID debe ser entero positivo, fue ${p}`);
    }
});

test('cleanupOrphanGradleDaemons — devuelve {killed, attempted} con shape correcto', () => {
    const r = builder.cleanupOrphanGradleDaemons();
    assert.ok(r && typeof r === 'object', 'debe devolver objeto');
    assert.equal(typeof r.killed, 'number', 'killed debe ser number');
    assert.equal(typeof r.attempted, 'number', 'attempted debe ser number');
    assert.ok(r.killed >= 0 && r.attempted >= 0, 'contadores deben ser >=0');
    assert.ok(r.killed <= r.attempted, 'killed <= attempted siempre');
});

test('cleanupOrphanGradleDaemons — no rompe en invocaciones repetidas', () => {
    // En un sistema vivo (pulpo + otros agentes corriendo) puede aparecer un
    // nuevo daemon entre invocaciones, así que NO afirmamos `attempted === 0`
    // tras un cleanup previo: solo validamos que el shape sea correcto y que
    // no haya excepciones al invocar consecutivamente. La invariante de
    // "killed <= attempted" la cubre el test anterior.
    const r1 = builder.cleanupOrphanGradleDaemons();
    assert.ok(r1 && typeof r1.killed === 'number' && typeof r1.attempted === 'number');
    const r2 = builder.cleanupOrphanGradleDaemons();
    assert.ok(r2 && typeof r2.killed === 'number' && typeof r2.attempted === 'number');
});

// ── Tests de syncLocalMainRef (regresión #3078 cuarto rebote) ────────────────
// Verifican que el sync actualiza local main cuando origin/main está adelante,
// reproduciendo el escenario real del rebote: worktree de larga vida con local
// main stale → smart-build.sh ve diff inflado → ./gradlew check completo → OOM
// en compileTestDevelopmentExecutableKotlinWasmJs.

const { execFileSync } = require('child_process');

// Helper: monta un repo git aislado con N commits, opcionalmente con un remote
// `origin` que avanzó M commits adicionales (simulando worktree stale).
function mountFakeRepo({ originExtraCommits }) {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-build-sync-'));
    const upstream = path.join(tmpRoot, 'upstream.git');
    const workTree = path.join(tmpRoot, 'work');

    // 1) Bare repo "upstream" que simula GitHub.
    fs.mkdirSync(upstream, { recursive: true });
    execFileSync('git', ['init', '--bare', '-b', 'main', upstream], { stdio: 'pipe' });

    // 2) Clone local que será nuestro worktree.
    execFileSync('git', ['clone', upstream, workTree], { stdio: 'pipe' });
    execFileSync('git', ['-C', workTree, 'config', 'user.email', 'test@intrale.com'], { stdio: 'pipe' });
    execFileSync('git', ['-C', workTree, 'config', 'user.name', 'Test'], { stdio: 'pipe' });
    // Commit inicial.
    fs.writeFileSync(path.join(workTree, 'README.md'), 'initial\n');
    execFileSync('git', ['-C', workTree, 'add', 'README.md'], { stdio: 'pipe' });
    execFileSync('git', ['-C', workTree, 'commit', '-m', 'initial'], { stdio: 'pipe' });
    execFileSync('git', ['-C', workTree, 'push', 'origin', 'main'], { stdio: 'pipe' });

    // 3) Avanzar origin con M commits que el local no va a fetchear → simula stale.
    if (originExtraCommits > 0) {
        // Clonar un workspace temporal solo para empujar al upstream.
        const pusher = path.join(tmpRoot, 'pusher');
        execFileSync('git', ['clone', upstream, pusher], { stdio: 'pipe' });
        execFileSync('git', ['-C', pusher, 'config', 'user.email', 'test@intrale.com'], { stdio: 'pipe' });
        execFileSync('git', ['-C', pusher, 'config', 'user.name', 'Test'], { stdio: 'pipe' });
        for (let i = 1; i <= originExtraCommits; i++) {
            fs.writeFileSync(path.join(pusher, `f${i}.txt`), `commit ${i}\n`);
            execFileSync('git', ['-C', pusher, 'add', `f${i}.txt`], { stdio: 'pipe' });
            execFileSync('git', ['-C', pusher, 'commit', '-m', `extra ${i}`], { stdio: 'pipe' });
        }
        execFileSync('git', ['-C', pusher, 'push', 'origin', 'main'], { stdio: 'pipe' });

        // 4) Fetch en el worktree para que origin/main esté avanzado pero local
        // main NO (= worktree stale como en el pulpo).
        execFileSync('git', ['-C', workTree, 'fetch', 'origin', 'main'], { stdio: 'pipe' });
    }

    return { tmpRoot, workTree, upstream };
}

test('syncLocalMainRef — actualiza local main cuando origin/main avanzó (regresión #3078 wasm-OOM)', () => {
    const { workTree, tmpRoot } = mountFakeRepo({ originExtraCommits: 3 });

    // Pre: local main está 3 commits atrás de origin/main.
    const stale = execFileSync('git', ['-C', workTree, 'rev-list', '--count', 'main..origin/main'], {
        encoding: 'utf8', stdio: 'pipe',
    }).trim();
    assert.equal(stale, '3', 'setup: local main debe estar 3 commits stale');

    // Apuntar el builder a este worktree y reimportarlo.
    process.env.PIPELINE_REPO_ROOT = workTree;
    delete require.cache[require.resolve('../build')];
    const isolated = require('../build');

    const res = isolated.syncLocalMainRef();

    assert.equal(res.synced, true, 'debe haber sincronizado');
    assert.equal(res.reason, null, 'sin reason de error');
    assert.equal(res.stale_commits, 3, 'debe reportar los 3 commits stale');

    // Post: local main == origin/main.
    const post = execFileSync('git', ['-C', workTree, 'rev-list', '--count', 'main..origin/main'], {
        encoding: 'utf8', stdio: 'pipe',
    }).trim();
    assert.equal(post, '0', 'tras el sync, local main debe estar al día');

    // Cleanup + restaurar env del módulo principal.
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    process.env.PIPELINE_REPO_ROOT = TMP;
    delete require.cache[require.resolve('../build')];
});

test('syncLocalMainRef — no-op cuando local main ya está al día', () => {
    const { workTree, tmpRoot } = mountFakeRepo({ originExtraCommits: 0 });

    process.env.PIPELINE_REPO_ROOT = workTree;
    delete require.cache[require.resolve('../build')];
    const isolated = require('../build');

    const res = isolated.syncLocalMainRef();

    assert.equal(res.synced, false, 'sin updates no se sincroniza');
    assert.equal(res.reason, 'already-fresh', 'debe reportar already-fresh');
    assert.equal(res.stale_commits, 0);

    fs.rmSync(tmpRoot, { recursive: true, force: true });
    process.env.PIPELINE_REPO_ROOT = TMP;
    delete require.cache[require.resolve('../build')];
});

test('syncLocalMainRef — best-effort cuando no hay origin/main', () => {
    // El TMP base no es un git repo: el sync debe degradar sin tirar excepción.
    process.env.PIPELINE_REPO_ROOT = TMP;
    delete require.cache[require.resolve('../build')];
    const isolated = require('../build');

    const res = isolated.syncLocalMainRef();

    assert.equal(res.synced, false, 'sin origin/main no sincroniza');
    assert.equal(res.reason, 'no-origin-main', 'debe reportar no-origin-main');
    assert.equal(res.stale_commits, 0);

    delete require.cache[require.resolve('../build')];
});

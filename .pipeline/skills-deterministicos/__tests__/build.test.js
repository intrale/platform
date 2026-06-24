// Tests unitarios de .pipeline/skills-deterministicos/build.js (issue #2476, rename #3157)
// No lanzamos gradle real: validamos parseArgs, buildGradleCommand, heartbeat,
// updateMarker y copyArtifacts con filesystem aislado.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

// #4164 — Stub in-process del probe del lock. Reemplaza el spawn real de un
// proceso `node` (load-sensitive: EAGAIN/EMFILE al forkear bajo saturación → el
// test rebotaba con exit_code 1) por una réplica determinista de la lógica del
// probe: lee el lockfile y escribe el marker síncronamente, luego emite exit 0.
// Solo se inyecta vía el parámetro `spawnFn` de runGradle/spawnGradle (DI de test).
function fakeProbeSpawn(_cmd, _args, opts) {
    const env = (opts && opts.env) || {};
    try {
        if (env.MARKER) {
            fs.writeFileSync(env.MARKER, fs.existsSync(env.LOCKFILE) ? 'held' : 'free');
        }
    } catch {}
    const child = new EventEmitter();
    child.stdout = null;
    child.stderr = null;
    process.nextTick(() => child.emit('exit', 0));
    return child;
}

// Aislar REPO_ROOT a un tmp — el módulo resuelve paths a partir de env vars.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-build-'));
fs.mkdirSync(path.join(TMP, '.claude', 'hooks'), { recursive: true });
fs.mkdirSync(path.join(TMP, '.pipeline', 'logs'), { recursive: true });
fs.mkdirSync(path.join(TMP, '.pipeline', 'desarrollo', 'build', 'trabajando'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'qa', 'artifacts'), { recursive: true });
process.env.PIPELINE_REPO_ROOT = TMP;
process.env.CLAUDE_PROJECT_DIR = TMP;
// Asegurar que PIPELINE_WORKTREE no contamine el módulo (el pulpo lo setea cuando
// lanza al agente, pero los tests deben verse a sí mismos en un entorno limpio).
delete process.env.PIPELINE_WORKTREE;

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
    assert.equal(c.cmd, 'bash');
    assert.deepEqual(c.args, ['scripts/smart-build.sh']);
    assert.equal(c.label, 'smart');
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

test('resolveBashCommand — en no-Windows devuelve cmd original sin shell', () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
        const r = builder.resolveBashCommand('bash');
        assert.equal(r.cmd, 'bash');
        assert.equal(r.useShell, false);
        const r2 = builder.resolveBashCommand('./gradlew');
        assert.equal(r2.cmd, './gradlew');
        assert.equal(r2.useShell, false);
    } finally {
        Object.defineProperty(process, 'platform', original);
    }
});

test('resolveBashCommand — Windows + cmd != bash mantiene shell:true', () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
        const r = builder.resolveBashCommand('./gradlew');
        assert.equal(r.cmd, './gradlew');
        assert.equal(r.useShell, true);
    } finally {
        Object.defineProperty(process, 'platform', original);
    }
});

test('resolveBashCommand — Windows + bash + GIT_BASH_PATH override resuelve al path', () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    const savedGitBash = process.env.GIT_BASH_PATH;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    // Crear un fake bash.exe en TMP para que existsSync devuelva true
    const fakeBash = path.join(TMP, 'fake-bash.exe');
    fs.writeFileSync(fakeBash, 'fake');
    process.env.GIT_BASH_PATH = fakeBash;
    try {
        const r = builder.resolveBashCommand('bash');
        assert.equal(r.cmd, fakeBash);
        assert.equal(r.useShell, false);
    } finally {
        Object.defineProperty(process, 'platform', originalPlatform);
        if (savedGitBash === undefined) delete process.env.GIT_BASH_PATH;
        else process.env.GIT_BASH_PATH = savedGitBash;
    }
});

test('resolveBashCommand — Windows + bash sin Git Bash cae a shell:true fallback', () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    const savedGitBash = process.env.GIT_BASH_PATH;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    // Apuntar GIT_BASH_PATH a un archivo inexistente para que ningún candidato pase
    process.env.GIT_BASH_PATH = path.join(TMP, 'no-existe-bash-' + Date.now() + '.exe');
    // Trampear los demás candidatos hardcoded: si el sistema real tiene Git Bash
    // en "C:\\Program Files\\Git\\bin\\bash.exe", el test no puede simular su
    // ausencia. Por eso solo validamos: si NO se encuentra nada, fallback OK.
    // En máquinas con Git Bash instalado, el test verifica el camino feliz.
    try {
        const r = builder.resolveBashCommand('bash');
        // O bien resuelve a un path absoluto (Git Bash instalado), o cae a fallback.
        if (r.useShell === true) {
            assert.equal(r.cmd, 'bash');
        } else {
            assert.ok(r.cmd.endsWith('bash.exe'), `esperaba .exe, got: ${r.cmd}`);
            assert.equal(r.useShell, false);
        }
    } finally {
        Object.defineProperty(process, 'platform', originalPlatform);
        if (savedGitBash === undefined) delete process.env.GIT_BASH_PATH;
        else process.env.GIT_BASH_PATH = savedGitBash;
    }
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

// ── Regresión: split REPO_ROOT / WORKTREE_ROOT (rebote build #3073 rev-1) ────
// El bug original ejecutaba gradle en cwd=REPO_ROOT (main checkout), lo que
// (a) generaba diffs falsos en smart-build.sh contra una rama distinta a la
// del agente, y (b) hacía que builds concurrentes colisionaran sobre el
// mismo `.gradle/buildOutputCleanup`. El fix introduce WORKTREE_ROOT como
// cwd para gradle y para los sources de artefactos, dejando QA_ARTIFACTS_DIR
// y LOG_DIR en REPO_ROOT (compartidos).
test('paths — WORKTREE_ROOT default = REPO_ROOT cuando no hay PIPELINE_WORKTREE', () => {
    // En este test no seteamos PIPELINE_WORKTREE, así que ambos deben coincidir.
    assert.equal(builder._paths.WORKTREE_ROOT, builder._paths.REPO_ROOT);
});

test('paths — QA_ARTIFACTS_DIR y LOG_DIR cuelgan de REPO_ROOT (no de WORKTREE_ROOT)', () => {
    assert.ok(builder._paths.QA_ARTIFACTS_DIR.startsWith(builder._paths.REPO_ROOT));
    assert.ok(builder._paths.LOG_DIR.startsWith(builder._paths.REPO_ROOT));
});

test('paths — WORKTREE_ROOT respeta PIPELINE_WORKTREE cuando está seteado', () => {
    // Recargar el módulo con PIPELINE_WORKTREE seteado a un valor distinto.
    const fakeWorktree = path.join(TMP, 'fake-worktree');
    fs.mkdirSync(fakeWorktree, { recursive: true });
    const saved = process.env.PIPELINE_WORKTREE;
    process.env.PIPELINE_WORKTREE = fakeWorktree;
    try {
        delete require.cache[require.resolve('../build')];
        const reloaded = require('../build');
        assert.equal(reloaded._paths.WORKTREE_ROOT, fakeWorktree);
        // REPO_ROOT sigue siendo TMP (PIPELINE_REPO_ROOT no cambió).
        assert.equal(reloaded._paths.REPO_ROOT, TMP);
        // QA_ARTIFACTS_DIR sigue colgando de REPO_ROOT, no de WORKTREE_ROOT.
        assert.ok(reloaded._paths.QA_ARTIFACTS_DIR.startsWith(TMP));
        assert.ok(!reloaded._paths.QA_ARTIFACTS_DIR.startsWith(fakeWorktree));
    } finally {
        if (saved === undefined) delete process.env.PIPELINE_WORKTREE;
        else process.env.PIPELINE_WORKTREE = saved;
        // Restaurar el module cache para tests siguientes
        delete require.cache[require.resolve('../build')];
        require('../build');
    }
});

// ── #4155 — lock global de Gradle ────────────────────────────────────
// `runGradle` debe envolver el spawn con el lock global: mientras corre el
// proceso de Gradle, el archivo de lock existe; al terminar, se libera. Así se
// garantiza que dos invocaciones pesadas (build/tester de distintos agentes) no
// corran a la vez (CA-4). Probamos con un proceso `node` que registra si el lock
// estaba tomado durante su ejecución.
test('runGradle envuelve el spawn con el lock global de Gradle (#4155)', async () => {
    const savedLock = process.env.GRADLE_LOCK_PATH;
    const lockLogical = path.join(TMP, 'build-gradle.lock');
    const lockFile = `${lockLogical}.lock`;
    const marker = path.join(TMP, 'lock-probe.marker');
    process.env.GRADLE_LOCK_PATH = lockLogical;
    try {
        delete require.cache[require.resolve('../../lib/gradle-lock')];
        delete require.cache[require.resolve('../build')];
        const b = require('../build');
        const res = await b.runGradle({
            cmd: 'node',
            args: [],
            cwd: TMP,
            env: { ...process.env, LOCKFILE: lockFile, MARKER: marker },
            spawnFn: fakeProbeSpawn,
        });
        assert.equal(res.exit_code, 0, 'el proceso probe debe salir 0');
        assert.equal(fs.readFileSync(marker, 'utf8'), 'held', 'el lock debe estar tomado durante el spawn');
        assert.equal(fs.existsSync(lockFile), false, 'el lock debe liberarse tras el spawn');
    } finally {
        if (savedLock === undefined) delete process.env.GRADLE_LOCK_PATH;
        else process.env.GRADLE_LOCK_PATH = savedLock;
        delete require.cache[require.resolve('../build')];
        require('../build');
    }
});

// `spawnGradle` es el spawn crudo SIN lock — no debe tomar el lock global.
test('spawnGradle NO toma el lock global (#4155)', async () => {
    const savedLock = process.env.GRADLE_LOCK_PATH;
    const lockLogical = path.join(TMP, 'build-spawn.lock');
    const lockFile = `${lockLogical}.lock`;
    const marker = path.join(TMP, 'spawn-probe.marker');
    process.env.GRADLE_LOCK_PATH = lockLogical;
    try {
        const b = require('../build');
        const res = await b.spawnGradle({
            cmd: 'node',
            args: [],
            cwd: TMP,
            env: { ...process.env, LOCKFILE: lockFile, MARKER: marker },
            spawnFn: fakeProbeSpawn,
        });
        assert.equal(res.exit_code, 0);
        assert.equal(fs.readFileSync(marker, 'utf8'), 'free', 'spawnGradle no debe tomar el lock');
    } finally {
        if (savedLock === undefined) delete process.env.GRADLE_LOCK_PATH;
        else process.env.GRADLE_LOCK_PATH = savedLock;
    }
});

// #4164 — Wiring de la inyección: `spawnGradle` debe invocar el `spawnFn` provisto
// (espía) en vez del spawn real, forwardeando cmd/args/opts intactos. Prueba que el
// punto de DI funciona sin forkear ningún proceso.
test('spawnGradle invoca el spawnFn inyectado (wiring #4164)', async () => {
    const b = require('../build');
    let calls = 0;
    let seenCmd = null;
    let seenArgs = null;
    const spy = (cmd, args) => {
        calls += 1;
        seenCmd = cmd;
        seenArgs = args;
        const child = new EventEmitter();
        child.stdout = null;
        child.stderr = null;
        process.nextTick(() => child.emit('exit', 0));
        return child;
    };
    const res = await b.spawnGradle({ cmd: 'node', args: ['--version'], cwd: TMP, env: process.env, spawnFn: spy });
    assert.equal(calls, 1, 'el spawnFn inyectado debe invocarse exactamente una vez');
    assert.equal(seenCmd, 'node', 'el cmd debe forwardearse sin cambios (resolveBashCommand solo reescribe cmd === "bash")');
    assert.deepEqual(seenArgs, ['--version'], 'los args deben forwardearse intactos');
    assert.equal(res.exit_code, 0);
});

// #4164 — Determinismo del caso de fallo: si el proceso emite `error`, el helper
// resuelve exit_code 1 de forma determinista (cubre el path de retry/fallo sin
// depender de saturación real del SO).
test('spawnGradle resuelve exit_code 1 ante error del proceso (fallo determinista #4164)', async () => {
    const b = require('../build');
    const failingSpawn = () => {
        const child = new EventEmitter();
        child.stdout = null;
        child.stderr = null;
        process.nextTick(() => child.emit('error', new Error('EAGAIN simulado')));
        return child;
    };
    const res = await b.spawnGradle({ cmd: 'node', args: [], cwd: TMP, env: process.env, spawnFn: failingSpawn });
    assert.equal(res.exit_code, 1, 'el error del proceso debe mapear a exit_code 1 de forma determinista');
    assert.match(res.stderr, /\[spawn-error\]/, 'el stderr debe registrar el spawn-error');
});

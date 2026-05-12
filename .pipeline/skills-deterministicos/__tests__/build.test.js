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

// Tests unitarios de .pipeline/skills-deterministicos/builder.js (issue #2476)
// No lanzamos gradle real: validamos parseArgs, buildGradleCommand, heartbeat,
// updateMarker y copyArtifacts con filesystem aislado.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Aislar REPO_ROOT a un tmp — el módulo resuelve paths a partir de env vars.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-builder-'));
fs.mkdirSync(path.join(TMP, '.claude', 'hooks'), { recursive: true });
fs.mkdirSync(path.join(TMP, '.pipeline', 'logs'), { recursive: true });
fs.mkdirSync(path.join(TMP, '.pipeline', 'desarrollo', 'build', 'trabajando'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'qa', 'artifacts'), { recursive: true });
process.env.PIPELINE_REPO_ROOT = TMP;
process.env.CLAUDE_PROJECT_DIR = TMP;

delete require.cache[require.resolve('../builder')];
const builder = require('../builder');

test('parseArgs — issue posicional + scope por defecto smart', () => {
    const a = builder.parseArgs(['node', 'builder.js', '2476']);
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
    assert.equal(content.skill, 'builder');
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
    const marker = path.join(TMP, '.pipeline', 'desarrollo', 'build', 'trabajando', '2476.builder');
    fs.writeFileSync(marker, 'issue: 2476\npipeline: desarrollo\n');
    builder.updateMarker(marker, { resultado: 'aprobado', motivo: 'Build exitoso', builder_mode: 'deterministic' });
    const after = fs.readFileSync(marker, 'utf8');
    assert.ok(after.includes('resultado:'));
    assert.ok(after.includes('"aprobado"'));
    assert.ok(after.includes('"Build exitoso"'));
    assert.ok(after.includes('builder_mode:'));
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

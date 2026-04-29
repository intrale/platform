// Tests unitarios de .pipeline/skills-deterministicos/lib/git-ops.js (issue #2484)
// Validamos los builders puros (commit message + PR body) y heurísticas
// (inferCommitType, inferScope) sin tocar git ni gh.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ops = require('../lib/git-ops');

test('inferCommitType — agent/<n>-slug → feat', () => {
    assert.equal(ops.inferCommitType('agent/2484-delivery-deterministico'), 'feat');
});

test('inferCommitType — feature/x → feat', () => {
    assert.equal(ops.inferCommitType('feature/dark-mode'), 'feat');
});

test('inferCommitType — bugfix/x → fix', () => {
    assert.equal(ops.inferCommitType('bugfix/login-loop'), 'fix');
});

test('inferCommitType — docs/x → docs', () => {
    assert.equal(ops.inferCommitType('docs/runbook-pipeline'), 'docs');
});

test('inferCommitType — refactor/x → refactor', () => {
    assert.equal(ops.inferCommitType('refactor/user-service'), 'refactor');
});

test('inferCommitType — desconocido → chore', () => {
    assert.equal(ops.inferCommitType('cualquiera/raro'), 'chore');
});

test('inferScope — mayoría .pipeline → "pipeline"', () => {
    const files = [
        { path: '.pipeline/skills-deterministicos/delivery.js' },
        { path: '.pipeline/skills-deterministicos/lib/git-ops.js' },
        { path: 'docs/cambio.md' },
    ];
    assert.equal(ops.inferScope(files), 'pipeline');
});

test('inferScope — mayoría backend → "backend"', () => {
    const files = [
        { path: 'backend/src/main/kotlin/Foo.kt' },
        { path: 'backend/src/test/kotlin/FooTest.kt' },
        { path: 'docs/x.md' },
    ];
    assert.equal(ops.inferScope(files), 'backend');
});

test('inferScope — sin archivos → fallback', () => {
    assert.equal(ops.inferScope([], 'general'), 'general');
});

test('inferScope — directorio desconocido se devuelve tal cual', () => {
    const files = [{ path: 'random-dir/algo.txt' }];
    assert.equal(ops.inferScope(files), 'random-dir');
});

test('buildCommitMessage — incluye type(scope) + Closes #N', () => {
    const msg = ops.buildCommitMessage({
        issue: 2484,
        title: 'V3 delivery determinístico',
        body: 'Implementa delivery sin tokens.',
        branch: 'agent/2484-delivery-deterministico',
        files: [{ path: '.pipeline/skills-deterministicos/delivery.js' }],
    });
    assert.match(msg, /^feat\(pipeline\): V3 delivery determinístico/);
    assert.match(msg, /Implementa delivery sin tokens\./);
    assert.match(msg, /Closes #2484/);
});

test('buildCommitMessage — sin body sigue cerrando issue', () => {
    const msg = ops.buildCommitMessage({
        issue: 100,
        title: 'arreglar login',
        branch: 'bugfix/login',
        files: [{ path: 'app/composeApp/src/Main.kt' }],
    });
    assert.match(msg, /^fix\(app\): arreglar login/);
    assert.match(msg, /Closes #100/);
});

test('buildCommitMessage — quita prefijos [Tipo] del título', () => {
    const msg = ops.buildCommitMessage({
        issue: 50,
        title: '[Bug] fallback se rompe',
        branch: 'bugfix/fallback',
        files: [{ path: 'app/x.kt' }],
    });
    assert.match(msg, /^fix\(app\): fallback se rompe/);
});

test('buildPRBody — incluye Resumen, Plan de pruebas y Closes', () => {
    const body = ops.buildPRBody({
        issue: 2484,
        title: 'algo',
        summaryBullets: ['cambio uno', 'cambio dos'],
        testPlan: ['tests verdes', 'gates pasan'],
        qaLabel: 'qa:skipped',
    });
    assert.match(body, /## Resumen/);
    assert.match(body, /- cambio uno/);
    assert.match(body, /- cambio dos/);
    assert.match(body, /## Plan de pruebas/);
    assert.match(body, /- \[x\] tests verdes/);
    assert.match(body, /Closes #2484/);
});

test('buildPRBody — defaults razonables si faltan bullets/testPlan', () => {
    const body = ops.buildPRBody({ issue: 7, qaLabel: 'qa:passed' });
    assert.match(body, /pipeline V3/i);
    assert.match(body, /qa:passed/);
    assert.match(body, /Closes #7/);
});

test('runCmd — comando inexistente devuelve exit_code != 0 sin tirar', () => {
    const r = ops.runCmd('comando-que-no-existe-12345', [], { timeoutMs: 3000 });
    assert.notEqual(r.exit_code, 0);
    assert.equal(typeof r.wall_ms, 'number');
});

// #2523 (rev-3) — decidePushOutcome cubre el caso histórico del rebote-3:
// push tarda más de 2min, spawnSync mata el proceso, exit_code=1, stderr="",
// pero el remote ya tiene el SHA local. Sin esta lógica, el agente caía al
// circuit breaker (rebote_numero=3) por un fallo cosmético del orquestador.

test('#2523 rev-3 — decidePushOutcome con exit_code=0 marca verified=true sin recovery', () => {
    const out = ops.decidePushOutcome({
        pushRes: { exit_code: 0, stderr: '', stdout: 'Everything up-to-date', signal: null, error: null, wall_ms: 1234 },
        localSha: 'a'.repeat(40),
        remoteSha: 'a'.repeat(40),
        branch: 'agent/2523-x',
    });
    assert.equal(out.exit_code, 0);
    assert.equal(out.verified, true);
    assert.equal(out.recovered, false);
    assert.equal(out.recovered_reason, undefined);
});

test('#2523 rev-3 — decidePushOutcome con exit_code=1 + SHAs iguales → recovered (no rebote)', () => {
    const sha = '94372c7713e6e7cdb0a05d46e1eb61c775eb4c6f';
    const out = ops.decidePushOutcome({
        pushRes: { exit_code: 1, stderr: '', stdout: '', signal: 'SIGTERM', error: null, wall_ms: 120000 },
        localSha: sha,
        remoteSha: sha,
        branch: 'agent/2523-dashboard-visual-redesign',
    });
    assert.equal(out.exit_code, 0, 'recovered debe normalizar exit_code a 0');
    assert.equal(out.verified, true);
    assert.equal(out.recovered, true);
    assert.match(out.recovered_reason, /94372c7/);
    assert.match(out.recovered_reason, /agent\/2523-dashboard-visual-redesign/);
    assert.match(out.recovered_reason, /signal=SIGTERM/);
});

test('#2523 rev-3 — decidePushOutcome con exit_code=1 + SHAs distintos → fallo real con diagnóstico', () => {
    const out = ops.decidePushOutcome({
        pushRes: { exit_code: 128, stderr: 'fatal: pre-receive hook declined', stdout: '', signal: null, error: null, wall_ms: 5000 },
        localSha: 'a'.repeat(40),
        remoteSha: 'b'.repeat(40),
        branch: 'agent/9999-x',
    });
    assert.equal(out.exit_code, 128, 'fallo real preserva exit_code original');
    assert.equal(out.verified, false);
    assert.equal(out.recovered, false);
    assert.equal(out.local_sha, 'a'.repeat(40));
    assert.equal(out.remote_sha, 'b'.repeat(40));
    assert.equal(out.stderr, 'fatal: pre-receive hook declined');
});

test('#2523 rev-3 — decidePushOutcome con exit_code=1 + remoteSha=null → fallo real (rama nueva no pusheada)', () => {
    const out = ops.decidePushOutcome({
        pushRes: { exit_code: 1, stderr: 'remote rejected', stdout: '', signal: null, error: null, wall_ms: 8000 },
        localSha: 'a'.repeat(40),
        remoteSha: null,
        branch: 'agent/9999-nueva',
    });
    assert.equal(out.exit_code, 1);
    assert.equal(out.verified, false);
    assert.equal(out.recovered, false);
    assert.equal(out.remote_sha, null);
});

test('#2523 rev-3 — decidePushOutcome con localSha=null → fallo real (no se pudo leer HEAD)', () => {
    const out = ops.decidePushOutcome({
        pushRes: { exit_code: 1, stderr: '', stdout: '', signal: 'SIGTERM', error: null, wall_ms: 120000 },
        localSha: null,
        remoteSha: 'a'.repeat(40),
        branch: 'agent/9999-x',
    });
    assert.equal(out.exit_code, 1);
    assert.equal(out.verified, false);
    assert.equal(out.recovered, false);
});

test('#2523 rev-3 — exporta pushAndVerify, decidePushOutcome y getRemoteSha', () => {
    assert.equal(typeof ops.pushAndVerify, 'function');
    assert.equal(typeof ops.decidePushOutcome, 'function');
    assert.equal(typeof ops.getRemoteSha, 'function');
});

// #2523 (rev-4) — resolveGhPath cubre el incidente del 2026-04-27: el pulpo
// arrancó como servicio sin `gh.exe` en el PATH heredado, y `gh pr create`
// falló con "'gh' no se reconoce como un comando interno o externo". Con la
// resolución absoluta, el delivery encuentra el binario en ubicaciones
// conocidas y crea el PR sin depender de la configuración del shell padre.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

test('#2523 rev-4 — resolveGhPath en non-Windows devuelve "gh" sin tocar FS', () => {
    if (process.platform === 'win32') return; // no aplica en Windows
    ops.clearGhPathCache();
    assert.equal(ops.resolveGhPath(), 'gh');
});

test('#2523 rev-4 — resolveGhPath encuentra gh.exe via PATH override', () => {
    if (process.platform !== 'win32') return; // sólo Windows
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-resolve-'));
    const fakeGh = path.join(tmpDir, 'gh.exe');
    fs.writeFileSync(fakeGh, '@echo off\r\n'); // contenido irrelevante, sólo necesita existir como archivo
    const prevPath = process.env.PATH;
    process.env.PATH = `${tmpDir}${path.delimiter}${prevPath || ''}`;
    try {
        ops.clearGhPathCache();
        const resolved = ops.resolveGhPath();
        assert.equal(resolved, fakeGh, 'debe resolver al gh.exe del PATH override');
    } finally {
        process.env.PATH = prevPath;
        ops.clearGhPathCache();
        try { fs.unlinkSync(fakeGh); } catch {}
        try { fs.rmdirSync(tmpDir); } catch {}
    }
});

test('#2523 rev-4 — resolveGhPath cachea el resultado entre llamadas', () => {
    if (process.platform !== 'win32') return;
    ops.clearGhPathCache();
    const first = ops.resolveGhPath();
    const second = ops.resolveGhPath();
    assert.equal(first, second, 'misma sesión devuelve el mismo path cacheado');
});

test('#2523 rev-4 — resolveGhPath cae a "gh" literal cuando no encuentra el binario', () => {
    if (process.platform !== 'win32') return;
    const prevPath = process.env.PATH;
    const prevLocalAppData = process.env.LOCALAPPDATA;
    const prevUserProfile = process.env.USERPROFILE;
    const prevProgramFiles = process.env.ProgramFiles;
    // PATH vacío + paths conocidos apuntando a ubicaciones inexistentes para
    // que ninguna candidata mate la cobertura. Como `C:\Workspaces\gh-cli\
    // bin\gh.exe` está hardcodeado en la lista de known, este test sólo
    // tiene sentido si ese path NO existe en el sistema de tests; si existe
    // (caso del entorno actual de Leo), el assert se relaja a "no debe tirar".
    process.env.PATH = '';
    process.env.LOCALAPPDATA = path.join(os.tmpdir(), 'no-existe-localappdata-' + Date.now());
    process.env.USERPROFILE = path.join(os.tmpdir(), 'no-existe-userprofile-' + Date.now());
    process.env.ProgramFiles = path.join(os.tmpdir(), 'no-existe-programfiles-' + Date.now());
    try {
        ops.clearGhPathCache();
        const resolved = ops.resolveGhPath();
        const knownInstalled = fs.existsSync('C:\\Workspaces\\gh-cli\\bin\\gh.exe')
            || fs.existsSync('C:\\Program Files\\GitHub CLI\\gh.exe');
        if (knownInstalled) {
            // En máquina con gh instalado en ubicación canónica, espera path absoluto.
            assert.match(resolved, /gh\.exe$/i, 'debe resolver al binario instalado en ubicación canónica');
        } else {
            assert.equal(resolved, 'gh', 'sin binario debe caer al fallback literal');
        }
    } finally {
        process.env.PATH = prevPath;
        if (prevLocalAppData !== undefined) process.env.LOCALAPPDATA = prevLocalAppData;
        else delete process.env.LOCALAPPDATA;
        if (prevUserProfile !== undefined) process.env.USERPROFILE = prevUserProfile;
        else delete process.env.USERPROFILE;
        if (prevProgramFiles !== undefined) process.env.ProgramFiles = prevProgramFiles;
        else delete process.env.ProgramFiles;
        ops.clearGhPathCache();
    }
});

test('#2523 rev-4 — exporta resolveGhPath y clearGhPathCache', () => {
    assert.equal(typeof ops.resolveGhPath, 'function');
    assert.equal(typeof ops.clearGhPathCache, 'function');
});

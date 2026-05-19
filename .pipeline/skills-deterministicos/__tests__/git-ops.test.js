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

// #2895 (rebote rev-1) — resolveGitDir + ensureGitInPath cubren el rebote del
// 2026-04-30: 19 tests Node fallaron en producción con "git no se reconoce" /
// spawn ENOENT, aunque en local pasaban. El pulpo arranca como servicio
// Windows sin git en el PATH heredado; al spawnear node --test, los test child
// processes que invocan git directo fallan. ensureGitInPath se llama en
// tester.js antes del spawn para garantizar que git esté disponible.

test('#2895 rev-1 — resolveGitDir en non-Windows devuelve null sin tocar FS', () => {
    if (process.platform === 'win32') return;
    ops.clearGitDirCache();
    assert.equal(ops.resolveGitDir(), null);
});

test('#2895 rev-1 — resolveGitDir encuentra git.exe via PATH override', () => {
    if (process.platform !== 'win32') return;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-resolve-'));
    const fakeGit = path.join(tmpDir, 'git.exe');
    fs.writeFileSync(fakeGit, '@echo off\r\n');
    const prevPath = process.env.PATH;
    process.env.PATH = `${tmpDir}${path.delimiter}${prevPath || ''}`;
    try {
        ops.clearGitDirCache();
        const resolved = ops.resolveGitDir();
        assert.equal(resolved, tmpDir, 'debe resolver al directorio del git.exe del PATH override');
    } finally {
        process.env.PATH = prevPath;
        ops.clearGitDirCache();
        try { fs.unlinkSync(fakeGit); } catch {}
        try { fs.rmdirSync(tmpDir); } catch {}
    }
});

test('#2895 rev-1 — resolveGitDir cachea el resultado entre llamadas', () => {
    if (process.platform !== 'win32') return;
    ops.clearGitDirCache();
    const first = ops.resolveGitDir();
    const second = ops.resolveGitDir();
    assert.equal(first, second);
});

test('#2895 rev-1 — ensureGitInPath agrega el directorio de git al PATH si falta', () => {
    if (process.platform !== 'win32') return;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-ensure-'));
    const fakeGit = path.join(tmpDir, 'git.exe');
    fs.writeFileSync(fakeGit, '@echo off\r\n');
    const prevPath = process.env.PATH;
    process.env.PATH = `${tmpDir}${path.delimiter}${prevPath || ''}`;
    try {
        ops.clearGitDirCache();
        // Env de partida que NO tiene git en PATH (simulando el caso producción)
        const startingEnv = { PATH: 'C:\\windows\\system32', FOO: 'bar' };
        const out = ops.ensureGitInPath(startingEnv);
        assert.ok(out.PATH.startsWith(tmpDir + path.delimiter),
            `PATH debe empezar con ${tmpDir}, fue: ${out.PATH.slice(0, 100)}`);
        assert.equal(out.FOO, 'bar', 'preserva otras keys del env');
        // No debe mutar el env original
        assert.equal(startingEnv.PATH, 'C:\\windows\\system32');
    } finally {
        process.env.PATH = prevPath;
        ops.clearGitDirCache();
        try { fs.unlinkSync(fakeGit); } catch {}
        try { fs.rmdirSync(tmpDir); } catch {}
    }
});

test('#2895 rev-1 — ensureGitInPath es idempotente: no duplica entrada si ya estaba', () => {
    if (process.platform !== 'win32') return;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-idem-'));
    const fakeGit = path.join(tmpDir, 'git.exe');
    fs.writeFileSync(fakeGit, '@echo off\r\n');
    const prevPath = process.env.PATH;
    process.env.PATH = `${tmpDir}${path.delimiter}${prevPath || ''}`;
    try {
        ops.clearGitDirCache();
        const startingEnv = { PATH: `${tmpDir};C:\\windows\\system32` };
        const out = ops.ensureGitInPath(startingEnv);
        // Contar cuántas veces aparece tmpDir en out.PATH (case-insensitive)
        const count = out.PATH.toLowerCase().split(path.delimiter)
            .filter((d) => d === tmpDir.toLowerCase()).length;
        assert.equal(count, 1, 'no debe duplicar la entrada del git.exe en PATH');
    } finally {
        process.env.PATH = prevPath;
        ops.clearGitDirCache();
        try { fs.unlinkSync(fakeGit); } catch {}
        try { fs.rmdirSync(tmpDir); } catch {}
    }
});

test('#2895 rev-1 — ensureGitInPath consolida Path/PATH en una sola key uppercase', () => {
    if (process.platform !== 'win32') return;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-case-'));
    const fakeGit = path.join(tmpDir, 'git.exe');
    fs.writeFileSync(fakeGit, '@echo off\r\n');
    const prevPath = process.env.PATH;
    process.env.PATH = `${tmpDir}${path.delimiter}${prevPath || ''}`;
    try {
        ops.clearGitDirCache();
        // Simulación: el spread inherence de process.env podría exponer Path
        // (mixed case) en vez de PATH (caso reportado en algunos shells de
        // Windows). El helper debe normalizar a PATH y eliminar Path duplicada.
        const startingEnv = { Path: 'C:\\windows', OTHER: 'x' };
        const out = ops.ensureGitInPath(startingEnv);
        assert.ok(out.PATH, 'debe haber PATH (mayúsculas)');
        assert.ok(!('Path' in out), 'no debe haber Path (mixed case) duplicado');
        assert.ok(out.PATH.toLowerCase().includes(tmpDir.toLowerCase()),
            'PATH debe contener el directorio resuelto de git');
    } finally {
        process.env.PATH = prevPath;
        ops.clearGitDirCache();
        try { fs.unlinkSync(fakeGit); } catch {}
        try { fs.rmdirSync(tmpDir); } catch {}
    }
});

test('#2895 rev-1 — ensureGitInPath devuelve env tal cual si resolveGitDir es null', () => {
    // Simulamos no-Windows o git ausente forzando la cache a null
    ops.clearGitDirCache();
    if (process.platform === 'win32') {
        // En Windows hay que mockear el FS — más simple: si el process actual
        // tiene git resuelto, validamos en el branch de Windows con su valor.
        // Acá asegamos al menos que devuelve un objeto nuevo (no muta).
        const startingEnv = { PATH: 'C:\\windows', FOO: 'bar' };
        const out = ops.ensureGitInPath(startingEnv);
        assert.notStrictEqual(out, startingEnv, 'debe devolver un objeto nuevo');
        assert.equal(out.FOO, 'bar');
    } else {
        // En non-Windows, resolveGitDir devuelve null → env tal cual (con clone)
        const startingEnv = { PATH: '/usr/bin', FOO: 'bar' };
        const out = ops.ensureGitInPath(startingEnv);
        assert.equal(out.PATH, '/usr/bin');
        assert.equal(out.FOO, 'bar');
    }
});

test('#2895 rev-1 — exporta resolveGitDir, clearGitDirCache y ensureGitInPath', () => {
    assert.equal(typeof ops.resolveGitDir, 'function');
    assert.equal(typeof ops.clearGitDirCache, 'function');
    assert.equal(typeof ops.ensureGitInPath, 'function');
});

// #2551 — Helpers de redacción de paths sensibles.
// El delivery loguea `git status` antes del rebase: en log local va sin filtrar
// (forense), pero en outputs visibles (motivo del marker, comentario PR,
// Telegram) hay que ocultar paths que puedan contener secrets.

test('#2551 — isSensitivePath detecta .env, credentials, .key, .pem, secret, application.conf', () => {
    assert.equal(ops.isSensitivePath('.env'), true);
    assert.equal(ops.isSensitivePath('.env.local'), true);
    assert.equal(ops.isSensitivePath('config/.env'), true);
    assert.equal(ops.isSensitivePath('users/src/main/resources/application.conf'), true);
    assert.equal(ops.isSensitivePath('credentials.json'), true);
    assert.equal(ops.isSensitivePath('fake-credentials.json'), true);
    assert.equal(ops.isSensitivePath('something.key'), true);
    assert.equal(ops.isSensitivePath('cert.pem'), true);
    assert.equal(ops.isSensitivePath('id_rsa'), true);
    assert.equal(ops.isSensitivePath('id_rsa.pub'), true);
    assert.equal(ops.isSensitivePath('secret-config.json'), true);
});

test('#2551 — isSensitivePath ignora paths inocuos del pipeline', () => {
    assert.equal(ops.isSensitivePath('.pipeline/logs/2551-delivery.log'), false);
    assert.equal(ops.isSensitivePath('app/composeApp/src/Main.kt'), false);
    assert.equal(ops.isSensitivePath('docs/readme.md'), false);
    assert.equal(ops.isSensitivePath(''), false);
    assert.equal(ops.isSensitivePath(null), false);
});

test('#2551 — redactSensitivePaths preserva código + redacta path en formato porcelain', () => {
    const input = [
        ' M .env',
        '?? fake-credentials.json',
        ' M docs/readme.md',
        '?? .pipeline/logs/2551.log',
    ].join('\n');
    const out = ops.redactSensitivePaths(input);
    const lines = out.split('\n');
    assert.equal(lines[0], ' M <sensitive-path-redacted>');
    assert.equal(lines[1], '?? <sensitive-path-redacted>');
    assert.equal(lines[2], ' M docs/readme.md');
    assert.equal(lines[3], '?? .pipeline/logs/2551.log');
});

test('#2551 — redactSensitivePaths preserva líneas vacías y separadores', () => {
    const input = ' M docs/x.md\n\n M app/y.kt';
    const out = ops.redactSensitivePaths(input);
    assert.equal(out, ' M docs/x.md\n\n M app/y.kt');
});

test('#2551 — redactInline tokeniza por espacio y reemplaza tokens sensibles', () => {
    const input = 'cannot rebase: Your local changes to .env would be overwritten';
    const out = ops.redactInline(input);
    assert.ok(out.includes('<sensitive-path-redacted>'));
    assert.ok(!out.includes('.env '));
});

test('#2551 — redactInline no toca tokens inocuos', () => {
    const input = 'cannot rebase: Your local changes to docs/readme.md would be overwritten';
    const out = ops.redactInline(input);
    assert.equal(out, input);
});

test('#2551 — SENSITIVE_PATH_PATTERNS está exportado y es un array', () => {
    assert.ok(Array.isArray(ops.SENSITIVE_PATH_PATTERNS));
    assert.ok(ops.SENSITIVE_PATH_PATTERNS.length > 0);
    for (const rx of ops.SENSITIVE_PATH_PATTERNS) {
        assert.ok(rx instanceof RegExp, 'cada patrón debe ser RegExp');
    }
});

// #2551 — parseGitStatusOutput (pura) separa tracked-modified, untracked y ignored.
test('#2551 — parseGitStatusOutput categoriza tracked/untracked/ignored', () => {
    const stdout = [
        ' M app/Main.kt',         // tracked-modified
        'M  staged/file.txt',     // staged → tracked-modified
        '?? new-file.txt',        // untracked
        '?? .pipeline/logs/x.log',// untracked
        '!! ignored/node_modules',// ignored
        '!! build/output.jar',    // ignored
    ].join('\n');
    const state = ops.parseGitStatusOutput(stdout);
    assert.deepEqual(state.tracked_modified.sort(), ['app/Main.kt', 'staged/file.txt'].sort());
    assert.deepEqual(state.untracked.sort(), ['.pipeline/logs/x.log', 'new-file.txt'].sort());
    assert.deepEqual(state.ignored.sort(), ['build/output.jar', 'ignored/node_modules'].sort());
});

test('#2551 — parseGitStatusOutput con stdout vacío devuelve listas vacías', () => {
    assert.deepEqual(ops.parseGitStatusOutput(''), { tracked_modified: [], untracked: [], ignored: [] });
    assert.deepEqual(ops.parseGitStatusOutput(null), { tracked_modified: [], untracked: [], ignored: [] });
    assert.deepEqual(ops.parseGitStatusOutput('\n\n'), { tracked_modified: [], untracked: [], ignored: [] });
});

// #2551 — findOrphanStashes (pura) decide qué stashes dropear.
test('#2551 — findOrphanStashes filtra por issue + pid muerto + no current', () => {
    const deadPid = 99999999;
    const stdout = [
        `stash@{0}: On agent/2551-x: delivery-2551-${deadPid}`,
        `stash@{1}: On agent/2551-x: delivery-2551-${process.pid}`, // PID actual — no dropear
        `stash@{2}: On agent/3000-x: delivery-3000-${deadPid}`,    // Otro issue — no dropear
        `stash@{3}: WIP on agent/2551-x: 1234567 algun otro stash`, // No match formato — ignorar
    ].join('\n');
    const isAlive = (pid) => pid === process.pid; // solo current está vivo
    const out = ops.findOrphanStashes(stdout, { issue: 2551, isAlive });
    assert.equal(out.length, 1);
    assert.equal(out[0].pid, deadPid);
    assert.equal(out[0].ref, 'stash@{0}');
});

test('#2551 — findOrphanStashes con issue=null retorna []', () => {
    const stdout = `stash@{0}: On agent/2551-x: delivery-2551-99999\n`;
    assert.deepEqual(ops.findOrphanStashes(stdout, {}), []);
});

test('#2551 — findOrphanStashes preserva PID vivo', () => {
    const stdout = `stash@{0}: On agent/2551-x: delivery-2551-12345\n`;
    const isAlive = () => true; // todos vivos
    assert.deepEqual(ops.findOrphanStashes(stdout, { issue: 2551, isAlive }), []);
});

test('#2551 — findOrphanStashes ignora stashes que no son de delivery', () => {
    const stdout = [
        `stash@{0}: WIP on agent/2551-x: feature branch in progress`,
        `stash@{1}: On agent/2551-x: random-2551-12345`,
        `stash@{2}: On agent/2551-x: not-matching-pattern`,
    ].join('\n');
    const isAlive = () => false;
    assert.deepEqual(ops.findOrphanStashes(stdout, { issue: 2551, isAlive }), []);
});

test('#2551 — isProcessAlive devuelve true para process.pid (self) y false para PID muy alto', () => {
    assert.equal(ops.isProcessAlive(process.pid), true);
    // 2^31-1 — improbable que esté asignado; en Windows process.kill devuelve ESRCH
    assert.equal(ops.isProcessAlive(2147483646), false);
});

test('#2551 — isProcessAlive con PID inválido devuelve false', () => {
    assert.equal(ops.isProcessAlive(null), false);
    assert.equal(ops.isProcessAlive(0), false);
    assert.equal(ops.isProcessAlive(-1), false);
});

// #2551 — Integración con git real: verifica que stashAll guarda y stashPop
// restaura untracked. Skip si git no está disponible o si estamos en CI sin
// permisos para crear repos temp.
test('#2551 — stashAll + stashPop integración con git real preserva untracked', () => {
    const gitDir = ops.resolveGitDir();
    if (process.platform === 'win32' && !gitDir) return; // git no disponible
    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'gitops-stash-'));
    const runHere = (args) => ops.runGit(args, { cwd: tmpRepo, timeoutMs: 30000 });
    try {
        // Setup repo mínimo
        assert.equal(runHere(['init', '-q']).exit_code, 0);
        runHere(['config', 'user.email', 'test@test.com']);
        runHere(['config', 'user.name', 'Test']);
        runHere(['config', 'commit.gpgsign', 'false']);
        fs.writeFileSync(path.join(tmpRepo, 'tracked.txt'), 'v1');
        assert.equal(runHere(['add', 'tracked.txt']).exit_code, 0);
        const commitRes = runHere(['commit', '-m', 'init', '--no-verify']);
        assert.equal(commitRes.exit_code, 0, `init commit falló: ${commitRes.stderr}`);

        // Crear cambio tracked + untracked
        fs.writeFileSync(path.join(tmpRepo, 'tracked.txt'), 'v2-modified');
        fs.writeFileSync(path.join(tmpRepo, 'new-untracked.txt'), 'new content');

        const before = ops.getDirtyState(tmpRepo);
        assert.equal(before.tracked_modified.length, 1, 'pre-stash debe tener tracked-modified');
        assert.equal(before.untracked.length, 1, 'pre-stash debe tener untracked');

        // Stash con --include-untracked
        const { message, result } = ops.stashAll(tmpRepo, { issue: 9999, pid: 12345 });
        assert.equal(message, 'delivery-9999-12345');
        assert.equal(result.exit_code, 0, `stashAll falló: ${result.stderr}`);

        // Post-stash: árbol limpio
        const mid = ops.getDirtyState(tmpRepo);
        assert.equal(mid.tracked_modified.length, 0, 'post-stash debe estar limpio (tracked)');
        assert.equal(mid.untracked.length, 0, 'post-stash debe estar limpio (untracked)');

        // Pop restaura ambos
        const popRes = ops.stashPop(tmpRepo);
        assert.equal(popRes.exit_code, 0, `stashPop falló: ${popRes.stderr}`);
        const after = ops.getDirtyState(tmpRepo);
        assert.equal(after.tracked_modified.length, 1);
        assert.equal(after.untracked.length, 1);
    } finally {
        // Limpieza recursiva — en Windows puede fallar por handles abiertos,
        // damos best-effort.
        try { fs.rmSync(tmpRepo, { recursive: true, force: true }); } catch {}
    }
});

// #2551 — rebaseOnto con autostash:false omite la flag. Verificamos contra
// repo temp para evitar mocks frágiles.
test('#2551 — rebaseOnto sin --autostash opera sobre árbol limpio', () => {
    const gitDir = ops.resolveGitDir();
    if (process.platform === 'win32' && !gitDir) return;
    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'gitops-rebase-'));
    const runHere = (args) => ops.runGit(args, { cwd: tmpRepo, timeoutMs: 30000 });
    try {
        assert.equal(runHere(['init', '-q', '-b', 'main']).exit_code, 0);
        runHere(['config', 'user.email', 'test@test.com']);
        runHere(['config', 'user.name', 'Test']);
        runHere(['config', 'commit.gpgsign', 'false']);
        fs.writeFileSync(path.join(tmpRepo, 'a.txt'), 'a');
        runHere(['add', 'a.txt']);
        runHere(['commit', '-m', 'a', '--no-verify']);
        // Branch feature
        runHere(['checkout', '-b', 'feat-x']);
        fs.writeFileSync(path.join(tmpRepo, 'b.txt'), 'b');
        runHere(['add', 'b.txt']);
        runHere(['commit', '-m', 'b', '--no-verify']);

        // Rebase a main desde árbol limpio sin autostash debe ser exit 0.
        const rebaseRes = ops.rebaseOnto(tmpRepo, 'main', { autostash: false });
        assert.equal(rebaseRes.exit_code, 0, `rebase falló: ${rebaseRes.stderr}`);
    } finally {
        try { fs.rmSync(tmpRepo, { recursive: true, force: true }); } catch {}
    }
});

test('#2551 — exporta getDirtyState, parseGitStatusOutput, stashAll, stashPop, stashDrop, cleanupOrphanStashes, findOrphanStashes, isProcessAlive, redactSensitivePaths, redactInline, isSensitivePath', () => {
    assert.equal(typeof ops.getDirtyState, 'function');
    assert.equal(typeof ops.parseGitStatusOutput, 'function');
    assert.equal(typeof ops.stashAll, 'function');
    assert.equal(typeof ops.stashPop, 'function');
    assert.equal(typeof ops.stashDrop, 'function');
    assert.equal(typeof ops.cleanupOrphanStashes, 'function');
    assert.equal(typeof ops.findOrphanStashes, 'function');
    assert.equal(typeof ops.isProcessAlive, 'function');
    assert.equal(typeof ops.redactSensitivePaths, 'function');
    assert.equal(typeof ops.redactInline, 'function');
    assert.equal(typeof ops.isSensitivePath, 'function');
});

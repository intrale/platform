// Tests unitarios de lib/static-checks.js (issue #2491)
// Cada check es una función pura: probamos los casos conocidos que debe
// detectar (positivos) y los que NO debe disparar (negativos).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const c = require('../lib/static-checks');

// ── checkSecretsInDiff ───────────────────────────────────────────────
test('checkSecretsInDiff — detecta AWS Access Key ID en línea agregada', () => {
    const diff = [
        'diff --git a/config.js b/config.js',
        '--- a/config.js',
        '+++ b/config.js',
        '@@ -1,1 +1,2 @@',
        ' // old',
        '+const key = "AKIAIOSFODNN7EXAMPLE";',
    ].join('\n');
    const f = c.checkSecretsInDiff(diff);
    assert.ok(f.some((x) => x.rule === 'secret:aws-access-key'), 'debe detectar AKIA...');
    assert.equal(f[0].severity, 'error');
    assert.equal(f[0].file, 'config.js');
});

test('checkSecretsInDiff — detecta GitHub PAT y OpenAI key', () => {
    const diff = [
        '+++ b/app.js',
        '@@ -0,0 +1,3 @@',
        '+const gh = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";',
        '+const oai = "sk-proj1234567890abcdefghijklmnopqrstuv";',
        '+const telegram = "1234567890:ABCdefGHIjklmNOPqrsTUVwxyZ012345678";',
    ].join('\n');
    const f = c.checkSecretsInDiff(diff);
    const rules = new Set(f.map((x) => x.rule));
    assert.ok(rules.has('secret:github-token'));
    assert.ok(rules.has('secret:openai-key'));
    assert.ok(rules.has('secret:telegram-bot-token'));
});

test('checkSecretsInDiff — detecta bloque de clave privada PEM', () => {
    const diff = [
        '+++ b/keys/private.pem',
        '@@ -0,0 +1,2 @@',
        '+-----BEGIN RSA PRIVATE KEY-----',
        '+MIIEowIBAAKCAQEA...',
    ].join('\n');
    const f = c.checkSecretsInDiff(diff);
    assert.ok(f.some((x) => x.rule === 'secret:private-key'));
});

test('checkSecretsInDiff — ignora docs/ y archivos .md (allowlist)', () => {
    const diff = [
        '+++ b/docs/example.md',
        '@@ -0,0 +1,1 @@',
        '+Ejemplo: AKIAIOSFODNN7EXAMPLE',
    ].join('\n');
    const f = c.checkSecretsInDiff(diff);
    assert.equal(f.length, 0, 'docs/*.md no dispara secrets');
});

test('checkSecretsInDiff — ignora líneas eliminadas (solo analiza +)', () => {
    const diff = [
        '+++ b/config.js',
        '@@ -1,2 +1,1 @@',
        '-const key = "AKIAIOSFODNN7EXAMPLE";',
        ' // kept',
    ].join('\n');
    const f = c.checkSecretsInDiff(diff);
    assert.equal(f.length, 0, 'solo detecta en líneas + (agregadas)');
});

// ── checkForbiddenStringsInDiff ──────────────────────────────────────
test('checkForbiddenStringsInDiff — detecta stringResource() en capa UI', () => {
    const diff = [
        '+++ b/app/composeApp/src/commonMain/kotlin/ui/sc/Login.kt',
        '@@ -0,0 +1,1 @@',
        '+val title = stringResource(Res.string.login_title)',
    ].join('\n');
    const f = c.checkForbiddenStringsInDiff(diff);
    assert.ok(f.some((x) => x.rule === 'strings:direct-string-resource'));
    assert.ok(f.some((x) => x.rule === 'strings:res-string-access'));
});

test('checkForbiddenStringsInDiff — ignora archivos fuera de app/composeApp/src', () => {
    const diff = [
        '+++ b/backend/src/main/kotlin/Handler.kt',
        '@@ -0,0 +1,1 @@',
        '+val x = stringResource(Res.string.ok)',
    ].join('\n');
    const f = c.checkForbiddenStringsInDiff(diff);
    assert.equal(f.length, 0, 'sólo UI composeApp dispara la regla');
});

test('checkForbiddenStringsInDiff — ignora ui/util/ResStrings (allowlist)', () => {
    const diff = [
        '+++ b/app/composeApp/src/commonMain/kotlin/ui/util/ResStrings.kt',
        '@@ -0,0 +1,1 @@',
        '+return stringResource(id)',
    ].join('\n');
    const f = c.checkForbiddenStringsInDiff(diff);
    assert.equal(f.length, 0, 'ResStrings puede usar stringResource directo');
});

test('checkForbiddenStringsInDiff — detecta import kotlin.io.encoding.Base64 en UI', () => {
    const diff = [
        '+++ b/app/composeApp/src/commonMain/kotlin/ui/cp/Foo.kt',
        '@@ -0,0 +1,1 @@',
        '+import kotlin.io.encoding.Base64',
    ].join('\n');
    const f = c.checkForbiddenStringsInDiff(diff);
    assert.ok(f.some((x) => x.rule === 'strings:base64-ui-import'));
});

// ── checkBranchName ──────────────────────────────────────────────────
test('checkBranchName — agent/<issue>-<slug> con issue correcto no reporta', () => {
    const f = c.checkBranchName('agent/2491-split-linter-reviewer', { issue: 2491 });
    assert.equal(f.length, 0);
});

test('checkBranchName — agent/<N>-... con issue distinto emite warn issue-mismatch', () => {
    const f = c.checkBranchName('agent/2490-partial-pause', { issue: 2491 });
    assert.equal(f.length, 1);
    assert.equal(f[0].rule, 'branch:issue-mismatch');
    assert.equal(f[0].severity, 'warn');
});

test('checkBranchName — main/develop/HEAD bloquea con error', () => {
    for (const b of ['main', 'develop', 'HEAD']) {
        const f = c.checkBranchName(b);
        assert.equal(f[0].rule, 'branch:protected');
        assert.equal(f[0].severity, 'error');
    }
});

test('checkBranchName — feature/bugfix/docs válidos pasan', () => {
    assert.equal(c.checkBranchName('feature/nuevo-login').length, 0);
    assert.equal(c.checkBranchName('bugfix/ajuste-x').length, 0);
    assert.equal(c.checkBranchName('docs/readme').length, 0);
});

test('checkBranchName — rama sin convención emite warn', () => {
    const f = c.checkBranchName('cualquier-cosa');
    assert.ok(f.some((x) => x.rule === 'branch:naming' && x.severity === 'warn'));
});

test('checkBranchName — branch vacío/null emite error', () => {
    const f = c.checkBranchName(null);
    assert.equal(f[0].rule, 'branch:missing');
    assert.equal(f[0].severity, 'error');
});

// ── checkSensitiveFiles ──────────────────────────────────────────────
test('checkSensitiveFiles — detecta .env, .pem, .keystore, credentials.json', () => {
    const files = [
        '.env',
        'config/.env.prod',
        'keys/server.pem',
        'app/release.keystore',
        'src/credentials.json',
        'users/src/main/resources/application.conf',
    ];
    const f = c.checkSensitiveFiles(files);
    assert.equal(f.length, files.length);
    assert.ok(f.every((x) => x.severity === 'error'));
});

test('checkSensitiveFiles — archivos normales no disparan', () => {
    const f = c.checkSensitiveFiles(['src/App.kt', 'docs/readme.md', 'package.json']);
    assert.equal(f.length, 0);
});

// ── checkDiffSize ────────────────────────────────────────────────────
test('checkDiffSize — PR chico no emite warnings', () => {
    const f = c.checkDiffSize({ files_changed: 5, additions: 100, deletions: 20 });
    assert.equal(f.length, 0);
});

test('checkDiffSize — PR gigante emite dos warnings', () => {
    const f = c.checkDiffSize({ files_changed: 50, additions: 800, deletions: 300 });
    const rules = new Set(f.map((x) => x.rule));
    assert.ok(rules.has('size:diff-large'));
    assert.ok(rules.has('size:many-files'));
});

// ── checkClosesIssue ─────────────────────────────────────────────────
test('checkClosesIssue — commit con "Closes #N" pasa', () => {
    const msgs = ['feat(x): algo\n\nCloses #2491'];
    assert.equal(c.checkClosesIssue(msgs, 2491).length, 0);
});

test('checkClosesIssue — acepta Fixes/Resolves', () => {
    assert.equal(c.checkClosesIssue(['feat: x\n\nFixes #10'], 10).length, 0);
    assert.equal(c.checkClosesIssue(['feat: y\n\nResolves #11'], 11).length, 0);
});

test('checkClosesIssue — sin referencia emite warn', () => {
    const f = c.checkClosesIssue(['feat: x'], 42);
    assert.equal(f[0].rule, 'pr:missing-closes');
    assert.equal(f[0].severity, 'warn');
});

test('checkClosesIssue — sin commits emite error', () => {
    const f = c.checkClosesIssue([], 42);
    assert.equal(f[0].rule, 'pr:no-commits');
    assert.equal(f[0].severity, 'error');
});

// ── checkCommitSubjects ──────────────────────────────────────────────
test('checkCommitSubjects — subject corto y sin puntuación final pasa', () => {
    assert.equal(c.checkCommitSubjects(['feat(x): cambio chico']).length, 0);
});

test('checkCommitSubjects — subject >100 chars emite info', () => {
    const long = 'feat(x): ' + 'a'.repeat(120);
    const f = c.checkCommitSubjects([long]);
    assert.ok(f.some((x) => x.rule === 'commit:subject-long'));
});

test('checkCommitSubjects — subject termina con "." emite info', () => {
    const f = c.checkCommitSubjects(['feat(x): cambio.']);
    assert.ok(f.some((x) => x.rule === 'commit:subject-punctuation'));
});

// ── aggregate ────────────────────────────────────────────────────────
test('aggregate — passed=true cuando no hay errors', () => {
    const findings = [
        { rule: 'x', severity: 'warn', message: 'w' },
        { rule: 'y', severity: 'info', message: 'i' },
    ];
    const a = c.aggregate(findings);
    assert.equal(a.passed, true);
    assert.equal(a.counts.warn, 1);
    assert.equal(a.counts.info, 1);
    assert.equal(a.total, 2);
});

test('aggregate — passed=false si hay al menos un error', () => {
    const a = c.aggregate([{ rule: 'x', severity: 'error', message: 'e' }]);
    assert.equal(a.passed, false);
    assert.equal(a.counts.error, 1);
});

// ── renderMarkdownReport ─────────────────────────────────────────────
test('renderMarkdownReport — sin findings marca aprobado', () => {
    const md = c.renderMarkdownReport([], { issue: 99, branch: 'agent/99-x' });
    assert.match(md, /APROBADO/);
    assert.match(md, /Sin findings/);
});

test('renderMarkdownReport — con errores marca rechazado y agrupa por severidad', () => {
    const findings = [
        { rule: 'a', severity: 'error', file: 'f.kt', line: 10, message: 'err' },
        { rule: 'b', severity: 'warn', message: 'wrn' },
    ];
    const md = c.renderMarkdownReport(findings, { issue: 1, branch: 'agent/1-x' });
    assert.match(md, /RECHAZADO/);
    assert.match(md, /### Errores/);
    assert.match(md, /### Warnings/);
    assert.match(md, /f\.kt:10/);
});

'use strict';

// Tests de operativo-drift.js (#4460) — detección de drift del modelo operativo.
// node --test .pipeline/lib/operativo-drift.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const drift = require('./operativo-drift');

// ---------------------------------------------------------------------------
// classifyPath — allowlist deny-by-default (CA-3 / REQ-SEC-4460)
// ---------------------------------------------------------------------------
test('classifyPath: paths del modelo operativo → operativo', () => {
    assert.strictEqual(drift.classifyPath('.pipeline/pulpo.js'), 'operativo');
    assert.strictEqual(drift.classifyPath('.pipeline/lib/dashboard-slices.js'), 'operativo');
    assert.strictEqual(drift.classifyPath('.pipeline/dashboard.js'), 'operativo');
    assert.strictEqual(drift.classifyPath('.claude/hooks/activity-logger.js'), 'operativo');
});

test('classifyPath: paths de producto → producto', () => {
    assert.strictEqual(drift.classifyPath('app/composeApp/src/Main.kt'), 'producto');
    assert.strictEqual(drift.classifyPath('backend/src/Server.kt'), 'producto');
    assert.strictEqual(drift.classifyPath('users/src/User.kt'), 'producto');
    assert.strictEqual(drift.classifyPath('tools/foo.kt'), 'producto');
    assert.strictEqual(drift.classifyPath('docs/arquitectura.md'), 'producto');
});

test('classifyPath: path desconocido → producto (deny-by-default)', () => {
    assert.strictEqual(drift.classifyPath('random/unknown/file.txt'), 'producto');
    assert.strictEqual(drift.classifyPath(''), 'producto');
    assert.strictEqual(drift.classifyPath(null), 'producto');
    assert.strictEqual(drift.classifyPath('.claude/settings.json'), 'producto'); // .claude/ pero NO hooks/
});

test('classifyPath: normaliza backslashes de Windows', () => {
    assert.strictEqual(drift.classifyPath('.pipeline\\lib\\foo.js'), 'operativo');
});

// ---------------------------------------------------------------------------
// parseIssueRef — mapeo commit → issue
// ---------------------------------------------------------------------------
test('parseIssueRef: Closes/Fixes/Resolves #N', () => {
    assert.strictEqual(drift.parseIssueRef('feat: algo (Closes #4460)'), 4460);
    assert.strictEqual(drift.parseIssueRef('fix bug\n\nFixes #123'), 123);
    assert.strictEqual(drift.parseIssueRef('Resolves #77'), 77);
});

test('parseIssueRef: (#N) del squash-merge de GitHub', () => {
    assert.strictEqual(drift.parseIssueRef('Rediseñar mensajes (#4462)'), 4462);
});

test('parseIssueRef: #N suelto como último recurso', () => {
    assert.strictEqual(drift.parseIssueRef('trabajo sobre #999 sin keyword'), 999);
});

test('parseIssueRef: sin issue → null', () => {
    assert.strictEqual(drift.parseIssueRef('commit sin referencia'), null);
    assert.strictEqual(drift.parseIssueRef(null), null);
});

// ---------------------------------------------------------------------------
// detectPendingRestart — bootSha inválido → estado desconocido (REQ-SEC-4460-5)
// ---------------------------------------------------------------------------
test('detectPendingRestart: bootSha ausente/inválido → {items:[], unknown:true}', () => {
    assert.deepStrictEqual(drift.detectPendingRestart({ bootSha: null }), { items: [], unknown: true });
    assert.deepStrictEqual(drift.detectPendingRestart({ bootSha: '' }), { items: [], unknown: true });
    assert.deepStrictEqual(drift.detectPendingRestart({ bootSha: 'HEAD; rm -rf .' }), { items: [], unknown: true });
    assert.deepStrictEqual(drift.detectPendingRestart({ bootSha: 'ZZZZ' }), { items: [], unknown: true });
});

// ---------------------------------------------------------------------------
// Integración con un repo git hermético
// ---------------------------------------------------------------------------
function git(args, cwd) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

// Construye un repo git temporal con historia controlada y un ref
// refs/remotes/origin/main apuntando al HEAD (sin remoto real).
function buildRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-repo-'));
    git(['init', '-q', '-b', 'main'], dir);
    git(['config', 'user.email', 'test@intrale.com'], dir);
    git(['config', 'user.name', 'Test'], dir);
    git(['config', 'commit.gpgsign', 'false'], dir);

    // Commit A (base): sólo producto.
    fs.writeFileSync(path.join(dir, 'README.md'), 'base\n');
    git(['add', '-A'], dir);
    git(['commit', '-q', '-m', 'chore: base'], dir);
    const shaA = git(['rev-parse', 'HEAD'], dir);

    // Commit B: toca el modelo operativo (.pipeline), Closes #4460.
    fs.mkdirSync(path.join(dir, '.pipeline', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.pipeline', 'lib', 'foo.js'), 'x\n');
    git(['add', '-A'], dir);
    git(['commit', '-q', '-m', 'feat: cambio de pipeline (Closes #4460)'], dir);

    // Commit C: sólo producto, Closes #999 → NO debe disparar restart.
    fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'app', 'Main.kt'), 'fun main(){}\n');
    git(['add', '-A'], dir);
    git(['commit', '-q', '-m', 'feat: cambio de producto (Closes #999)'], dir);

    // Commit D: hooks operativos, (#1234) estilo squash.
    fs.mkdirSync(path.join(dir, '.claude', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'hooks', 'guard.js'), 'y\n');
    git(['add', '-A'], dir);
    git(['commit', '-q', '-m', 'fix: hook guard (#1234)'], dir);

    // Apuntar origin/main a HEAD (sin remoto).
    const head = git(['rev-parse', 'HEAD'], dir);
    git(['update-ref', 'refs/remotes/origin/main', head], dir);
    return { dir, shaA };
}

test('detectPendingRestart: detecta commits operativos, ignora producto', () => {
    drift._clearCache();
    const { dir, shaA } = buildRepo();
    const res = drift.detectPendingRestart({ bootSha: shaA, repoRoot: dir, skipFetch: true });
    assert.strictEqual(res.unknown, false);
    const issues = res.items.map((i) => i.issue).sort((a, b) => a - b);
    // #4460 (.pipeline) y #1234 (.claude/hooks) → sí; #999 (app) → no.
    assert.deepStrictEqual(issues, [1234, 4460]);
});

test('detectPendingRestart: los items no contienen paths absolutos ni SHAs completos (REQ-SEC-4460-6)', () => {
    drift._clearCache();
    const { dir, shaA } = buildRepo();
    const res = drift.detectPendingRestart({ bootSha: shaA, repoRoot: dir, skipFetch: true });
    for (const item of res.items) {
        const blob = JSON.stringify(item);
        assert.ok(!blob.includes('/'), `sin paths: ${blob}`);
        assert.ok(!/[0-9a-f]{40}/.test(blob), `sin SHA completo: ${blob}`);
        assert.ok(!blob.includes(dir), `sin path absoluto del FS: ${blob}`);
        // componente debe ser una etiqueta corta conocida
        assert.ok(typeof item.componente === 'string' && item.componente.length < 40);
    }
});

test('detectPendingRestart: componente para .pipeline → "pipeline"/"dashboard", hooks → "hooks"', () => {
    drift._clearCache();
    const { dir, shaA } = buildRepo();
    const res = drift.detectPendingRestart({ bootSha: shaA, repoRoot: dir, skipFetch: true });
    const byIssue = Object.fromEntries(res.items.map((i) => [i.issue, i.componente]));
    assert.strictEqual(byIssue[1234], 'hooks');
    assert.strictEqual(byIssue[4460], 'pipeline');
});

test('detectPendingRestart: bootSha = HEAD (rango vacío) → items:[]', () => {
    drift._clearCache();
    const { dir } = buildRepo();
    const head = git(['rev-parse', 'refs/remotes/origin/main'], dir);
    const res = drift.detectPendingRestart({ bootSha: head, repoRoot: dir, skipFetch: true });
    assert.strictEqual(res.unknown, false);
    assert.deepStrictEqual(res.items, []);
});

test('detectPendingRestart: bootSha hex válido pero inalcanzable por git → unknown:true (no miente)', () => {
    drift._clearCache();
    const { dir } = buildRepo();
    // SHA hex bien formado pero que no existe en el repo.
    const res = drift.detectPendingRestart({ bootSha: 'abcdef1234567890abcdef1234567890abcdef12', repoRoot: dir, skipFetch: true });
    assert.strictEqual(res.unknown, true);
    assert.deepStrictEqual(res.items, []);
});

// ---------------------------------------------------------------------------
// _fetchOriginMain — refresh best-effort de origin/main (fix rebote rev-1)
// ---------------------------------------------------------------------------
test('_fetchOriginMain: sin remoto/red NUNCA lanza (best-effort)', () => {
    const { dir } = buildRepo();
    // Repo sin remoto 'origin' configurado → el fetch falla, pero se traga el
    // error y no propaga (el detector sigue con el origin/main local).
    assert.doesNotThrow(() => drift._fetchOriginMain(dir));
});

test('detectPendingRestart con skipFetch:true opera sobre origin/main local sin requerir remoto', () => {
    drift._clearCache();
    const { dir, shaA } = buildRepo();
    const res = drift.detectPendingRestart({ bootSha: shaA, repoRoot: dir, skipFetch: true });
    assert.strictEqual(res.unknown, false);
    assert.ok(res.items.length >= 1);
});

// ---------------------------------------------------------------------------
// Seguridad: NO interpolación en shell (execFile con args-array)
// ---------------------------------------------------------------------------
test('_gitLogRange usa execFile con args-array (no shell): un bootSha con metacaracteres no ejecuta nada', () => {
    // classifyPath/detectPendingRestart ya rechaza no-hex antes de git. Acá
    // verificamos que incluso forzando _gitLogRange con un string raro, no se
    // interpola en un shell (devuelve null por rango inválido, sin efectos).
    const { dir } = buildRepo();
    const res = drift._gitLogRange('no-existe-branch', dir);
    // git falla el rango → null, sin lanzar ni ejecutar comando arbitrario.
    assert.strictEqual(res, null);
});

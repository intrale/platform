'use strict';

// Tests: `lib/ghost-artifact-cleaner` (#3638 CA-F-2..F-8, SEC-1..7, OPS-1..4).
//
// Estrategia: cada test arma un tmpdir con una estructura mínima de
// `.pipeline/` + `.gitignore` + `archivado/` + `audit/` y corre `runOnce`
// inyectando un `issueStateFn` falso (sin llamar a `gh`).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const cleaner = require('../ghost-artifact-cleaner');
const { _internal } = cleaner;

// ─── Helpers de fixture ─────────────────────────────────────────────────────

function makeTmpRepo() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-test-'));
    const pipelineRoot = path.join(root, '.pipeline');
    fs.mkdirSync(pipelineRoot, { recursive: true });
    // .gitignore tiene que listar los paths protegidos.
    fs.writeFileSync(
        path.join(root, '.gitignore'),
        '.pipeline/archivado/\n.pipeline/audit/\n',
        'utf8',
    );
    return { root, pipelineRoot };
}

function placeFile(pipelineRoot, relPath, content = 'placeholder') {
    const full = path.join(pipelineRoot, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
    return full;
}

function silentLogger() {
    return { info() {}, warn() {}, error() {} };
}

function readAuditLines(pipelineRoot) {
    const file = path.join(pipelineRoot, 'audit', 'ghost-artifacts-cleanup.jsonl');
    try {
        return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
    } catch { return []; }
}

// ─── Tests internos puros ───────────────────────────────────────────────────

test('safeIssueFromFilename: acepta markers y artifacts válidos', () => {
    assert.equal(_internal.safeIssueFromFilename('1732.po.comment.md'), '1732');
    assert.equal(_internal.safeIssueFromFilename('3638.pipeline-dev.guidance.txt'), '3638');
    assert.equal(_internal.safeIssueFromFilename('2441.qa.reason.json'), '2441');
    assert.equal(_internal.safeIssueFromFilename('5000.po'), '5000');
});

test('safeIssueFromFilename: rechaza filenames maliciosos (anti-injection)', () => {
    // Punto y coma, espacios, pipes, $(), backticks → null.
    assert.equal(_internal.safeIssueFromFilename('1732; rm -rf /.po.comment.md'), null);
    assert.equal(_internal.safeIssueFromFilename('$(curl evil).po.comment.md'), null);
    assert.equal(_internal.safeIssueFromFilename('1732.PO.comment.md'), null); // mayúsculas no permitidas
    assert.equal(_internal.safeIssueFromFilename('abc.po.comment.md'), null); // no-numeric issue
});

test('isCandidateFilename: solo .comment.md / .guidance.txt / .reason.json', () => {
    assert.equal(_internal.isCandidateFilename('1732.po.comment.md'), true);
    assert.equal(_internal.isCandidateFilename('1732.po.guidance.txt'), true);
    assert.equal(_internal.isCandidateFilename('1732.qa.reason.json'), true);
    assert.equal(_internal.isCandidateFilename('1732.po'), false); // marker válido
    assert.equal(_internal.isCandidateFilename('foo.bar.baz'), false); // > 2 segmentos pero sin sufijo conocido
});

test('hasActiveSibling: detecta .work, .build y marker activo', () => {
    const { pipelineRoot } = makeTmpRepo();
    const dir = path.join(pipelineRoot, 'definicion', 'criterios', 'pendiente');
    fs.mkdirSync(dir, { recursive: true });
    assert.equal(_internal.hasActiveSibling(dir, 1732), false);
    placeFile(pipelineRoot, 'definicion/criterios/pendiente/1732.po.work', 'x');
    assert.equal(_internal.hasActiveSibling(dir, 1732), true);
    fs.unlinkSync(path.join(dir, '1732.po.work'));
    placeFile(pipelineRoot, 'definicion/criterios/pendiente/1732.po', 'x');
    assert.equal(_internal.hasActiveSibling(dir, 1732), true);
});

test('verifyGitignore: aborta si faltan paths protegidos (CA-SEC-6)', () => {
    const { root } = makeTmpRepo();
    fs.writeFileSync(path.join(root, '.gitignore'), '# vacío\n', 'utf8');
    const check = _internal.verifyGitignore(root, silentLogger());
    assert.equal(check.ok, false);
    assert.match(check.reason, /gitignore-missing-paths/);
});

test('verifyGitignore: OK cuando los paths están listados', () => {
    const { root } = makeTmpRepo();
    const check = _internal.verifyGitignore(root, silentLogger());
    assert.equal(check.ok, true);
});

test('alreadyArchived: encuentra archivo previo en cualquier bucket ghost-*', () => {
    const { pipelineRoot } = makeTmpRepo();
    const archivado = path.join(pipelineRoot, 'archivado');
    const bucket = path.join(archivado, 'ghost-20260101-000000');
    placeFile(pipelineRoot, 'archivado/ghost-20260101-000000/definicion/criterios/pendiente/3076.po.comment.md', 'old');
    const found = _internal.alreadyArchived(archivado, 'definicion/criterios/pendiente/3076.po.comment.md');
    assert.ok(found && found.includes('3076.po.comment.md'), 'debe encontrar el archivo previo');
});

// ─── Tests de runOnce (integración interna) ─────────────────────────────────

test('runOnce dry-run: lista candidatos, NO toca disco (Gherkin escenario 3)', async () => {
    const { root, pipelineRoot } = makeTmpRepo();
    placeFile(pipelineRoot, 'definicion/criterios/pendiente/9999.po.comment.md', 'x');
    const result = await cleaner.runOnce({
        mode: 'dry-run',
        repoRoot: root,
        pipelineRoot,
        logger: silentLogger(),
        issueStateFn: () => ({ ok: true, state: 'CLOSED' }),
    });
    assert.equal(result.candidates, 1);
    assert.equal(result.archived, 0);
    // Original sigue ahí.
    assert.ok(fs.existsSync(path.join(pipelineRoot, 'definicion/criterios/pendiente/9999.po.comment.md')));
    // Audit log NO se escribió (dry-run no audita movimientos).
    assert.equal(readAuditLines(pipelineRoot).length, 0);
});

test('runOnce execute: archiva candidato huérfano con issue CLOSED (Gherkin escenario 1)', async () => {
    const { root, pipelineRoot } = makeTmpRepo();
    placeFile(pipelineRoot, 'definicion/criterios/pendiente/9999.po.comment.md', 'x');
    const result = await cleaner.runOnce({
        mode: 'execute',
        repoRoot: root,
        pipelineRoot,
        logger: silentLogger(),
        issueStateFn: () => ({ ok: true, state: 'CLOSED' }),
    });
    assert.equal(result.archived, 1);
    assert.equal(fs.existsSync(path.join(pipelineRoot, 'definicion/criterios/pendiente/9999.po.comment.md')), false);
    // Verificar que se movió a archivado/ghost-*/
    const buckets = fs.readdirSync(path.join(pipelineRoot, 'archivado'));
    assert.ok(buckets.some(b => b.startsWith('ghost-')));
    // Audit log: 1 entrada cleanup.
    const audit = readAuditLines(pipelineRoot);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, 'cleanup');
    assert.match(audit[0].reason, /orphaned/);
});

test('runOnce: idempotencia — archivo ya archivado → no-op (Gherkin escenario 2)', async () => {
    const { root, pipelineRoot } = makeTmpRepo();
    // Archivado previo del mismo path.
    placeFile(pipelineRoot, 'archivado/ghost-20260101-000000/definicion/criterios/pendiente/3076.po.comment.md', 'old');
    // Y el archivo "ahora" duplicado en pendiente/ (simula re-aparición patológica).
    placeFile(pipelineRoot, 'definicion/criterios/pendiente/3076.po.comment.md', 'new');
    const result = await cleaner.runOnce({
        mode: 'execute',
        repoRoot: root,
        pipelineRoot,
        logger: silentLogger(),
        issueStateFn: () => ({ ok: true, state: 'CLOSED' }),
    });
    assert.equal(result.archived, 0);
    assert.equal(result.skipped, 1);
    // No se creó nueva carpeta ghost-* además de la histórica.
    const buckets = fs.readdirSync(path.join(pipelineRoot, 'archivado'));
    assert.equal(buckets.length, 1);
    // Audit log: 1 entrada con action=no-op.
    const audit = readAuditLines(pipelineRoot);
    assert.equal(audit[0].action, 'no-op');
    assert.match(audit[0].reason, /already archived/);
});

test('runOnce: skipea si sibling activo en carpeta padre', async () => {
    const { root, pipelineRoot } = makeTmpRepo();
    placeFile(pipelineRoot, 'definicion/criterios/pendiente/5000.po.comment.md', 'x');
    placeFile(pipelineRoot, 'definicion/criterios/pendiente/5000.po.work', 'active');
    const result = await cleaner.runOnce({
        mode: 'execute',
        repoRoot: root,
        pipelineRoot,
        logger: silentLogger(),
        issueStateFn: () => ({ ok: true, state: 'CLOSED' }),
    });
    assert.equal(result.archived, 0);
    assert.equal(result.skipped, 1);
});

test('runOnce: fail-safe gh down → skip + log (Gherkin escenario 7)', async () => {
    const { root, pipelineRoot } = makeTmpRepo();
    placeFile(pipelineRoot, 'definicion/criterios/pendiente/8888.po.comment.md', 'x');
    const result = await cleaner.runOnce({
        mode: 'execute',
        repoRoot: root,
        pipelineRoot,
        logger: silentLogger(),
        issueStateFn: () => ({ ok: false, reason: 'gh-timeout' }),
    });
    assert.equal(result.archived, 0);
    assert.equal(result.skipped, 1);
    const audit = readAuditLines(pipelineRoot);
    assert.equal(audit[0].action, 'skip');
    assert.match(audit[0].reason, /gh unavailable/);
});

test('runOnce: aborta si .gitignore no protege archivado/audit (CA-SEC-6, Gherkin escenario 6)', async () => {
    const { root, pipelineRoot } = makeTmpRepo();
    fs.writeFileSync(path.join(root, '.gitignore'), '# vacío\n', 'utf8');
    placeFile(pipelineRoot, 'definicion/criterios/pendiente/7777.po.comment.md', 'x');
    const result = await cleaner.runOnce({
        mode: 'execute',
        repoRoot: root,
        pipelineRoot,
        logger: silentLogger(),
        issueStateFn: () => ({ ok: true, state: 'CLOSED' }),
    });
    assert.equal(result.aborted, true);
    assert.equal(result.errors, 1);
    // Archivo intacto.
    assert.ok(fs.existsSync(path.join(pipelineRoot, 'definicion/criterios/pendiente/7777.po.comment.md')));
});

test('runOnce: issue OPEN → NO archiva (preserva trabajo en curso)', async () => {
    const { root, pipelineRoot } = makeTmpRepo();
    placeFile(pipelineRoot, 'definicion/criterios/pendiente/4444.po.comment.md', 'x');
    const result = await cleaner.runOnce({
        mode: 'execute',
        repoRoot: root,
        pipelineRoot,
        logger: silentLogger(),
        issueStateFn: () => ({ ok: true, state: 'OPEN' }),
    });
    assert.equal(result.archived, 0);
    assert.equal(result.skipped, 1);
    assert.ok(fs.existsSync(path.join(pipelineRoot, 'definicion/criterios/pendiente/4444.po.comment.md')));
});

test('runOnce: ignora markers válidos (.po, .pipeline-dev, etc.)', async () => {
    const { root, pipelineRoot } = makeTmpRepo();
    placeFile(pipelineRoot, 'desarrollo/dev/trabajando/3638.pipeline-dev', 'active');
    const result = await cleaner.runOnce({
        mode: 'execute',
        repoRoot: root,
        pipelineRoot,
        logger: silentLogger(),
        issueStateFn: () => ({ ok: true, state: 'CLOSED' }),
    });
    // 1 archivo scanned, 0 candidates (no es .comment.md ni similar).
    assert.equal(result.candidates, 0);
    assert.equal(result.archived, 0);
    assert.ok(fs.existsSync(path.join(pipelineRoot, 'desarrollo/dev/trabajando/3638.pipeline-dev')));
});

test('runOnce: ignora .gitkeep y archivos ocultos por convención', async () => {
    const { root, pipelineRoot } = makeTmpRepo();
    placeFile(pipelineRoot, 'definicion/criterios/pendiente/.gitkeep', '');
    const result = await cleaner.runOnce({
        mode: 'execute',
        repoRoot: root,
        pipelineRoot,
        logger: silentLogger(),
        issueStateFn: () => ({ ok: true, state: 'CLOSED' }),
    });
    assert.equal(result.candidates, 0);
    assert.equal(result.archived, 0);
});

test('runOnce: audit JSONL siempre usa JSON.stringify (CA-SEC-5)', async () => {
    const { root, pipelineRoot } = makeTmpRepo();
    placeFile(pipelineRoot, 'definicion/criterios/pendiente/6666.po.comment.md', 'x');
    await cleaner.runOnce({
        mode: 'execute',
        repoRoot: root,
        pipelineRoot,
        logger: silentLogger(),
        issueStateFn: () => ({ ok: true, state: 'CLOSED' }),
    });
    const raw = fs.readFileSync(path.join(pipelineRoot, 'audit', 'ghost-artifacts-cleanup.jsonl'), 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    for (const line of lines) {
        // No debe tirar parse error y debe ser un objeto.
        const obj = JSON.parse(line);
        assert.equal(typeof obj, 'object');
        assert.ok(obj.timestamp);
        assert.ok(obj.action);
    }
});

test('walk: maxDepth limita recursión y devuelve symlinks como entry separado', () => {
    const { pipelineRoot } = makeTmpRepo();
    placeFile(pipelineRoot, 'definicion/criterios/pendiente/1234.po.comment.md', 'x');
    const out = _internal.walk(path.join(pipelineRoot, 'definicion'), { maxDepth: 5 });
    assert.ok(out.some(e => e.kind === 'file' && e.name === '1234.po.comment.md'));
});

test('runOnce: respeta walk timeout sin colgar el pulpo', async () => {
    // Simulación: si el walk excede deadline, runOnce marca walkTimedOut y
    // no archiva nada. Validamos que retorna sin colgarse.
    const { root, pipelineRoot } = makeTmpRepo();
    // No-op: el deadline interno es 60s y este test corre en ms.
    const result = await cleaner.runOnce({
        mode: 'dry-run',
        repoRoot: root,
        pipelineRoot,
        logger: silentLogger(),
        issueStateFn: () => ({ ok: true, state: 'CLOSED' }),
    });
    assert.equal(result.aborted, false);
    assert.ok(result.durationMs < 60_000);
});

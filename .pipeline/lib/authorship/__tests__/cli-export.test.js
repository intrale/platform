'use strict';
// #7633 — CLI `export` y fuente git/gh (CA-5 · CA-6 · SE1 · SE5 · SE6).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const cli = require('../export-cli');
const dispatcher = require('../cli');
const { createGitSource, LOG_FORMAT } = require('../git-source');
const F = require('./fixtures/commits');

const ROOT = path.resolve(path.sep, 'repo-falso');
const ALLOWED = path.join(ROOT, '.pipeline', 'tmp', 'authorship-export');
const NOW = new Date('2026-09-23T19:40:00Z');

function fakeFs({ symlinks = [] } = {}) {
    const files = new Map();
    const dirs = [];
    return {
        files,
        dirs,
        mkdirSync: (d) => { dirs.push(d); },
        writeFileSync: (p, c) => { files.set(p, String(c)); },
        readFileSync: () => { throw new Error('sin config'); },
        lstatSync: (p) => {
            if (symlinks.includes(p)) return { isSymbolicLink: () => true };
            const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e;
        },
    };
}

function spyExec(impl) {
    const calls = [];
    const fn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return impl ? impl(cmd, args, opts) : ''; };
    fn.calls = calls;
    return fn;
}

function gitLogOutput(commits) {
    return commits.map((c) => `${c.sha}\x00${c.date}\x00${c.message}\x1e`).join('\n');
}

// Exec falso que simula git + gh para el rango mixto y el PR 7651.
function fakeWorld({ titleFails = false } = {}) {
    return spyExec((cmd, args) => {
        if (cmd === 'git' && args[0] === 'check-ref-format') {
            if (['HEAD', 'main', 'origin/main'].includes(args[2])) return '';
            const e = new Error('bad ref'); e.status = 1; throw e;
        }
        if (cmd === 'git' && args[0] === 'rev-parse') return `${ROOT}\n`;
        if (cmd === 'git' && args[0] === 'log') {
            return args.includes('-1') ? gitLogOutput([F.NONE_MISSING]) : gitLogOutput(F.MIXED_RANGE);
        }
        if (cmd === 'gh' && args[0] === 'pr') {
            if (args[2] === '7651') return JSON.stringify({ number: 7651, title: 't', state: 'MERGED', mergeCommit: { oid: 'd'.repeat(40) } });
            return JSON.stringify({ number: Number(args[2]), title: 't', state: 'OPEN', mergeCommit: null });
        }
        if (cmd === 'gh' && args[0] === 'issue') {
            if (titleFails) {
                const e = new Error('Command failed: gh issue view');
                e.stderr = 'error leyendo C:\\Users\\leito\\.config\\gh con token ghp_abcdef123 /home/x';
                throw e;
            }
            return JSON.stringify({ title: `Título de #${args[2]}` });
        }
        throw new Error(`comando inesperado: ${cmd} ${args.join(' ')}`);
    });
}

// ---------------------------------------------------------------------------
// parseExportArgs
// ---------------------------------------------------------------------------

test('--pr acepta sólo enteros positivos', () => {
    for (const bad of ['0', '-1', 'abc', '1.5', '', '1e3', '0x10']) {
        const r = cli.parseExportArgs(['--pr', bad]);
        assert.strictEqual(r.ok, false, `--pr ${bad} debería rechazarse`);
    }
    assert.deepStrictEqual(cli.parseExportArgs(['--pr', '7651']), { ok: true, opts: { pdf: false, out: null, pr: 7651 } });
    assert.deepStrictEqual(cli.parseExportArgs(['--pr=12', '--pdf']).opts, { pdf: true, out: null, pr: 12 });
});

test('exactamente uno de --pr / --range, y argumentos desconocidos rechazados', () => {
    assert.strictEqual(cli.parseExportArgs([]).ok, false);
    assert.strictEqual(cli.parseExportArgs(['--pr', '1', '--range', 'a..b']).ok, false);
    assert.strictEqual(cli.parseExportArgs(['--pr']).ok, false);
    assert.strictEqual(cli.parseExportArgs(['--pr', '1', '--telegram']).ok, false);
    assert.strictEqual(cli.parseExportArgs(['--pdf=1', '--pr', '1']).ok, false);
    assert.deepStrictEqual(cli.parseExportArgs(['--range', 'a..b', '--out', 'x']).opts, { pdf: false, out: 'x', range: 'a..b' });
});

// ---------------------------------------------------------------------------
// validateRange (SE1)
// ---------------------------------------------------------------------------

test('--range --output=x..HEAD se rechaza sin invocar git', async () => {
    const exec = spyExec();
    const source = createGitSource({ execFileImpl: exec, log: () => {} });
    const parsed = cli.parseExportArgs(['--range', '--output=x..HEAD']);
    assert.strictEqual(parsed.ok, true, 'el parser toma el valor; la validación es del rango');
    const res = await cli.runExport(parsed.opts, { source, fs: fakeFs(), now: NOW });
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /rango inválido/);
    assert.strictEqual(exec.calls.length, 0, 'git no debe invocarse');
});

test('validateRange: extremos SHA o refs válidos, nunca con guion inicial', () => {
    const check = spyExec(() => true);
    const deps = { checkRefFormat: (r) => ['HEAD', 'main'].includes(r) };
    assert.deepStrictEqual(cli.validateRange('abc1234..HEAD', deps), { ok: true });
    assert.deepStrictEqual(cli.validateRange('main..' + 'a'.repeat(40), deps), { ok: true });
    for (const bad of ['a..b..c', '..HEAD', 'HEAD..', 'HEAD', 'HEAD..-x', '-x..HEAD', 'HEAD~3..HEAD', null]) {
        assert.deepStrictEqual(cli.validateRange(bad, deps), { ok: false }, String(bad));
    }
    assert.deepStrictEqual(cli.validateRange('--output=x..HEAD', { checkRefFormat: check }), { ok: false });
    assert.strictEqual(check.calls.length, 0);
});

test('checkRefFormat de git-source: guion inicial no llega a git; error ⇒ false', () => {
    const exec = spyExec((cmd, args) => { if (args[2] === 'mal') throw new Error('x'); return ''; });
    const src = createGitSource({ execFileImpl: exec, log: () => {} });
    assert.strictEqual(src.checkRefFormat('-x'), false);
    assert.strictEqual(src.checkRefFormat(''), false);
    assert.strictEqual(exec.calls.length, 0);
    assert.strictEqual(src.checkRefFormat('HEAD'), true);
    assert.strictEqual(src.checkRefFormat('mal'), false);
    assert.deepStrictEqual(exec.calls[0].args, ['check-ref-format', '--allow-onelevel', 'HEAD']);
});

// ---------------------------------------------------------------------------
// git-source (SE1 · SE6)
// ---------------------------------------------------------------------------

test('readCommits usa execFile con array y --end-of-options antes del rango', () => {
    const exec = spyExec(() => gitLogOutput([F.SIGNED, F.NO_BLOCK_POST]));
    const src = createGitSource({ execFileImpl: exec, log: () => {} });
    const r = src.readCommits('abc1234..HEAD');
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(exec.calls[0].args, ['log', LOG_FORMAT, '--end-of-options', 'abc1234..HEAD']);
    assert.deepStrictEqual(r.commits.map((c) => c.sha), [F.SIGNED.sha, F.NO_BLOCK_POST.sha]);
    assert.strictEqual(r.commits[0].message.trim(), F.SIGNED.message.trim());
    src.readCommits('d'.repeat(40), { single: true });
    assert.deepStrictEqual(exec.calls[1].args, ['log', LOG_FORMAT, '-1', '--end-of-options', 'd'.repeat(40)]);
});

test('SE6: un fallo de gh/git devuelve sólo el mensaje público; el stderr va al log', () => {
    const logs = [];
    const src = createGitSource({ execFileImpl: fakeWorld({ titleFails: true }), log: (l) => logs.push(l) });
    const t = src.readIssueTitle(7593);
    assert.deepStrictEqual(t, { ok: false, publicMessage: 'no se pudo obtener el título de #7593' });
    assert.ok(logs.some((l) => l.includes('ghp_abcdef123') && l.includes('C:\\Users')), 'el detalle queda en el log local');
    const failing = createGitSource({ execFileImpl: () => { const e = new Error('fatal C:\\Users\\x'); e.stderr = 'ghp_x'; throw e; }, log: () => {} });
    const c = failing.readCommits('a..b');
    assert.strictEqual(c.ok, false);
    assert.ok(!/ghp_|C:\\/.test(c.publicMessage));
    const p = failing.readPrMergeCommit(5);
    assert.deepStrictEqual(p, { ok: false, publicMessage: 'no se pudo obtener el Pull Request #5' });
    assert.strictEqual(failing.repoRoot(), '');
});

test('readIssueTitle sin título en la respuesta ⇒ mensaje genérico', () => {
    const src = createGitSource({ execFileImpl: () => '{}', log: () => {} });
    assert.strictEqual(src.readIssueTitle(3).ok, false);
});

test('readPrMergeCommit: PR no integrado ⇒ error claro, sin export vacío', () => {
    const src = createGitSource({ execFileImpl: fakeWorld(), log: () => {} });
    const r = src.readPrMergeCommit(9999);
    assert.strictEqual(r.ok, false);
    assert.match(r.publicMessage, /no está integrado/);
    const ok = src.readPrMergeCommit(7651);
    assert.deepStrictEqual(ok, { ok: true, sha: 'd'.repeat(40), title: 't' });
});

// ---------------------------------------------------------------------------
// resolveOutDir (SE5)
// ---------------------------------------------------------------------------

test('--out fuera del directorio permitido se rechaza', () => {
    for (const out of [path.join(ROOT, 'docs', 'qa'), path.join(ROOT, '.pipeline', 'tmp'), path.join(ALLOWED + '-otro'), path.join(ALLOWED, '..', '..')]) {
        assert.strictEqual(cli.resolveOutDir(out, ROOT, fakeFs()).ok, false, out);
    }
});

test('--out dentro del permitido se acepta; default = directorio ignorado', () => {
    assert.deepStrictEqual(cli.resolveOutDir(null, ROOT, fakeFs()), { ok: true, dir: ALLOWED });
    assert.deepStrictEqual(cli.resolveOutDir(path.join(ALLOWED, 'caso'), ROOT, fakeFs()), { ok: true, dir: path.join(ALLOWED, 'caso') });
});

test('--out que es (o pasa por) un symlink se rechaza', () => {
    const target = path.join(ALLOWED, 'link');
    assert.strictEqual(cli.resolveOutDir(target, ROOT, fakeFs({ symlinks: [target] })).ok, false);
    assert.strictEqual(cli.resolveOutDir(target, ROOT, fakeFs({ symlinks: [ALLOWED] })).ok, false);
    assert.strictEqual(cli.resolveOutDir(null, ROOT, fakeFs({ symlinks: [path.join(ROOT, '.pipeline', 'tmp')] })).ok, false);
});

test('el directorio default está ignorado por git (.pipeline/tmp/)', () => {
    const gi = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', '.gitignore'), 'utf8');
    assert.ok(/^\.pipeline\/tmp\/\s*$/m.test(gi));
});

// ---------------------------------------------------------------------------
// runExport end-to-end con fakes
// ---------------------------------------------------------------------------

test('runExport de un rango mixto escribe el HTML "1 de 5" en el directorio permitido', async () => {
    const ffs = fakeFs();
    const source = createGitSource({ execFileImpl: fakeWorld(), log: () => {} });
    const res = await cli.runExport({ range: 'abc1234..HEAD' }, { source, fs: ffs, now: NOW, goLiveDate: F.GO_LIVE });
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual([res.signed, res.total, res.pdfPath], [1, 5, null]);
    assert.ok(res.htmlPath.startsWith(ALLOWED + path.sep));
    assert.ok(path.basename(res.htmlPath).startsWith('constancia-autoria-rango-abc1234-a-HEAD-'));
    const html = ffs.files.get(res.htmlPath);
    assert.ok(html.includes('1 de 5 cambios con firma'));
    assert.ok(html.includes('#7593 — Título de #7593'));
});

test('runExport de un PR: exporta el commit de squash (N=1) y el PDF sólo con --pdf', async () => {
    const ffs = fakeFs();
    const source = createGitSource({ execFileImpl: fakeWorld(), log: () => {} });
    const calls = [];
    const renderPdf = async (p, o) => { calls.push({ p, o }); return o.outPath; };
    const res = await cli.runExport({ pr: 7651, pdf: true }, { source, fs: ffs, now: NOW, renderPdf, goLiveDate: null });
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual([res.signed, res.total], [0, 1]);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].o.outPath, res.htmlPath.replace(/\.html$/, '.pdf'));
    assert.strictEqual(calls[0].o.title, 'Intrale · Constancia de autoría — PR #7651');
    assert.strictEqual(res.pdfPath, calls[0].o.outPath);
});

test('runExport --pdf sin puppeteer: deja el HTML y avisa claro', async () => {
    const ffs = fakeFs();
    const source = createGitSource({ execFileImpl: fakeWorld(), log: () => {} });
    const res = await cli.runExport({ pr: 7651, pdf: true }, { source, fs: ffs, now: NOW, isPuppeteerAvailable: () => false });
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /se generó sólo el HTML/);
    assert.ok(ffs.files.has(res.htmlPath));
});

test('runExport: stderr con paths/tokens nunca llega al HTML', async () => {
    const ffs = fakeFs();
    const source = createGitSource({ execFileImpl: fakeWorld({ titleFails: true }), log: () => {} });
    const res = await cli.runExport({ range: 'abc1234..HEAD' }, { source, fs: ffs, now: NOW });
    const html = ffs.files.get(res.htmlPath);
    assert.ok(html.includes('no se pudo obtener el título de #7593'));
    for (const bad of ['ghp_', 'C:\\', '/home/', 'Users']) assert.ok(!html.includes(bad), bad);
});

test('runExport: PR no integrado, repo no ubicable, --out inválido y rango enorme fallan claro', async () => {
    const source = createGitSource({ execFileImpl: fakeWorld(), log: () => {} });
    let r = await cli.runExport({ pr: 9999 }, { source, fs: fakeFs(), now: NOW });
    assert.match(r.error, /no está integrado/);
    r = await cli.runExport({ pr: 0 }, { source, fs: fakeFs(), now: NOW });
    assert.strictEqual(r.ok, false);
    const noRepo = { ...source, repoRoot: () => '' };
    r = await cli.runExport({ pr: 7651 }, { source: noRepo, fs: fakeFs(), now: NOW });
    assert.match(r.error, /repositorio/);
    r = await cli.runExport({ pr: 7651, out: path.join(ROOT, 'docs', 'qa') }, { source, fs: fakeFs(), now: NOW });
    assert.match(r.error, /dentro de \.pipeline\/tmp\/authorship-export/);
    const many = Array.from({ length: cli.MAX_COMMITS + 1 }, () => F.NO_BLOCK_POST);
    const big = { ...source, readCommits: () => ({ ok: true, commits: many }) };
    r = await cli.runExport({ range: 'abc1234..HEAD' }, { source: big, fs: fakeFs(), now: NOW });
    assert.match(r.error, /máximo por constancia/);
    const broken = { ...source, readCommits: () => ({ ok: false, publicMessage: 'no se pudieron leer' }) };
    r = await cli.runExport({ range: 'abc1234..HEAD' }, { source: broken, fs: fakeFs(), now: NOW });
    assert.strictEqual(r.error, 'no se pudieron leer');
    r = await cli.runExport({ pr: 7651 }, { source: broken, fs: fakeFs(), now: NOW });
    assert.strictEqual(r.error, 'no se pudieron leer');
});

test('readGoLiveDate lee authorship.go_live_date por el config-resolver y tolera su ausencia', () => {
    const seen = [];
    const ok = (o) => { seen.push(o); return { authorship: { go_live_date: '2026-09-23T00:00:00Z' } }; };
    assert.strictEqual(cli.readGoLiveDate(ROOT, ok), '2026-09-23T00:00:00Z');
    assert.deepStrictEqual(seen, [{ pipelineDir: path.join(ROOT, '.pipeline') }]);
    assert.strictEqual(cli.readGoLiveDate(ROOT, () => { throw new Error('sin config'); }), null);
    assert.strictEqual(cli.readGoLiveDate(ROOT, () => ({ otra: 1 })), null);
});

test('main: sin subcomando o con args inválidos devuelve 2 y muestra el uso', async () => {
    const out = []; const err = [];
    const io = { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } };
    assert.strictEqual(await dispatcher.main([], io), 2);
    assert.strictEqual(await dispatcher.main(['export', '--pr', 'abc'], io), 2);
    assert.ok(err.join('').includes('Uso:'));
    assert.strictEqual(out.length, 0);
});

test('estático: el CLI no requiere módulos de Telegram ni de Drive', () => {
    for (const f of ['cli.js', 'export-cli.js', 'export-chain.js', 'git-source.js', 'labels-es.js']) {
        const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
        const requires = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
        for (const r of requires) assert.ok(!/telegram|drive|https?$/i.test(r), `${f} requiere ${r}`);
    }
});

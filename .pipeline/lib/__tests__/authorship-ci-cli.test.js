'use strict';
// #7632 — CLI `verify` del check de autoría (CA-9, casos 1-12) + gh-client.

const test = require('node:test');
const assert = require('node:assert');

const { main, HELP } = require('../authorship/cli');
const { createGhClient } = require('../authorship/gh-client');
const trailer = require('../authorship/trailer');
const copy = require('../authorship/copy');

const HUMAN = trailer.formatHumanDirection({
    ok: true, login: 'leitolarreta', ts: '2026-09-24T10:00:00Z', kind: 'gate2', hash: 'b'.repeat(64),
});
const AI = trailer.formatAiAssisted([{ provider: 'anthropic', model: 'claude-opus-5-5', role: 'pipeline-dev' }]);
const GOOD_BODY = copy.applyAnchorToBody('Resumen.\n\nCloses #7632', 7632, { humanLine: HUMAN, aiLine: AI });

const CONFIG = {
    'dry-run': 'authorship:\n  enabled: true\n  gate_mode: dry-run\n',
    enforce: 'authorship:\n  enabled: true\n  gate_mode: enforce\n',
    enforcee: 'authorship:\n  enabled: true\n  gate_mode: enforcee\n',
    disabled: 'authorship:\n  enabled: false\n',
    ausente: 'otra:\n  cosa: 1\n',
};

function fakeFs(configText, summary = []) {
    return {
        readFileSync: () => { if (configText == null) throw new Error('ENOENT'); return configText; },
        appendFileSync: (_f, text) => summary.push(text),
    };
}

function fakeGhClient({ body = GOOD_BODY, headRefName = 'agent/7632-pipeline-dev', commits = ['feat: x'], issue = 'exists', prOk = true, throws = false } = {}) {
    const calls = { issueExists: [], prView: [] };
    return {
        calls,
        async prView(n) {
            calls.prView.push(n);
            if (throws) throw new Error('boom');
            return prOk ? { ok: true, body, headRefName, commits } : { ok: false };
        },
        async issueExists(n) { calls.issueExists.push(n); return issue; },
    };
}

async function run(argv, { config = CONFIG['dry-run'], gh = fakeGhClient(), execFileImpl } = {}) {
    const lines = [];
    const summary = [];
    const stdout = { write: (s) => lines.push(s) };
    const code = await main(argv, {
        ghClient: gh,
        fsImpl: fakeFs(config, summary),
        stdout,
        stderr: stdout,
        env: { GITHUB_STEP_SUMMARY: '/tmp/summary.md' },
        execFileImpl,
    });
    return { code, out: lines.join(''), summary: summary.join(''), gh };
}

const PR = ['verify', '--pr', '42', '--config', '.pipeline/config.yaml'];

// 1
test('CA-9.1 trailer completo y consistente → exit 0 sin hallazgos', async () => {
    for (const mode of ['dry-run', 'enforce']) {
        const r = await run(PR, { config: CONFIG[mode] });
        assert.strictEqual(r.code, 0);
        assert.doesNotMatch(r.out, /::(warning|error)/);
        assert.match(r.summary, /Formato del trailer \| ✅/);
    }
});

// 2
test('CA-9.2 sin trailer → warning en dry-run (exit 0) / error en enforce (exit 1)', async () => {
    const gh = () => fakeGhClient({ body: 'Sin constancia.' });
    const dry = await run(PR, { gh: gh() });
    assert.strictEqual(dry.code, 0);
    assert.match(dry.out, /::warning title=Autoría del PR::\[modo de prueba — no bloquea\] Falta el trailer/);
    const enf = await run(PR, { gh: gh(), config: CONFIG.enforce });
    assert.strictEqual(enf.code, 1);
    assert.match(enf.out, /::error title=Autoría del PR::Falta el trailer/);
});

// 3
test('CA-9.3 issue inexistente (404) → hallazgo', async () => {
    const r = await run(PR, { gh: fakeGhClient({ issue: 'not_found' }), config: CONFIG.enforce });
    assert.strictEqual(r.code, 1);
    assert.match(r.out, /issue que no existe \(#7632\)/);
});

// 4
test('CA-9.4 authorship-anchor ≠ trailer → hallazgo', async () => {
    const body = GOOD_BODY.replace('authorship-anchor issue=7632', 'authorship-anchor issue=7631');
    const r = await run(PR, { gh: fakeGhClient({ body }), config: CONFIG.enforce });
    assert.strictEqual(r.code, 1);
    assert.match(r.out, /no coincide con el trailer/);
});

// 5
test('CA-9.5 trailer sólo en un commit interno, no en el mensaje propuesto → hallazgo', async () => {
    const r = await run(PR, {
        gh: fakeGhClient({ body: 'Resumen.', commits: ['feat: x\n\nIntrale-Issue: #7632'] }),
        config: CONFIG.enforce,
    });
    assert.strictEqual(r.code, 1);
    assert.match(r.out, /Falta el trailer/);
});

// 6
test('CA-9.6 clave Intrale-* duplicada o fuera del último párrafo → hallazgo', async () => {
    const dup = GOOD_BODY.replace('Intrale-Issue: #7632', 'Intrale-Issue: #7632\nIntrale-Issue: #7632');
    const r1 = await run(PR, { gh: fakeGhClient({ body: dup }), config: CONFIG.enforce });
    assert.strictEqual(r1.code, 1);
    assert.match(r1.out, /repite una clave/);
    const fuera = `Intrale-Issue: #7632\n\n${GOOD_BODY}`;
    const r2 = await run(PR, { gh: fakeGhClient({ body: fuera }), config: CONFIG.enforce });
    assert.strictEqual(r2.code, 1);
    assert.match(r2.out, /fuera del bloque/);
});

// 7
test('CA-9.7 issue "1; rm -rf /" o "--repo otro/repo" → validación rechaza y gh no se invoca', async () => {
    for (const bad of ['#1; rm -rf /', '--repo otro/repo']) {
        const gh = fakeGhClient({ body: GOOD_BODY.replace('Intrale-Issue: #7632', `Intrale-Issue: ${bad}`) });
        const r = await run(PR, { gh, config: CONFIG.enforce });
        assert.strictEqual(r.code, 1);
        assert.strictEqual(gh.calls.issueExists.length, 0, `gh invocado con ${bad}`);
        assert.ok(!r.out.includes('rm -rf') && !r.out.includes('otro/repo'));
    }
    // gh-client: tampoco llega a ejecutar `gh` con un número inválido.
    let spawned = 0;
    const client = createGhClient({ execFileImpl: () => { spawned++; } });
    await assert.rejects(() => client.issueExists('1; rm -rf /'));
    await assert.rejects(() => client.prView('--repo'));
    assert.strictEqual(spawned, 0);
});

// 8
test('CA-9.8 body con \\n::add-mask:: o %0A::error:: → ninguna anotación lo reproduce', async () => {
    const body = `%0A::error::falso\n::add-mask::secreto\nIntrale-Issue: #1\n\n${GOOD_BODY}`;
    const r = await run(PR, { gh: fakeGhClient({ body }) });
    assert.strictEqual(r.code, 0);
    assert.ok(!r.out.includes('add-mask'));
    assert.ok(!r.out.includes('falso'));
    assert.ok(!r.out.includes('secreto'));
    assert.ok(!r.summary.includes('secreto'));
    for (const line of r.out.split('\n').filter(Boolean)) {
        assert.match(line, /^(::warning title=Autoría del PR::|Autoría del PR:)/);
    }
});

// 9
test('CA-9.9 error de red de gh → exit 1 en enforce, warning + exit 0 en dry-run', async () => {
    for (const gh of [() => fakeGhClient({ issue: 'error' }), () => fakeGhClient({ prOk: false })]) {
        const enf = await run(PR, { gh: gh(), config: CONFIG.enforce });
        assert.strictEqual(enf.code, 1);
        assert.match(enf.out, /::error title=Autoría del PR::No se pudo consultar GitHub/);
        const dry = await run(PR, { gh: gh() });
        assert.strictEqual(dry.code, 0);
        assert.match(dry.out, /::warning title=Autoría del PR::\[modo de prueba — no bloquea\] No se pudo consultar GitHub/);
    }
});

// 10
test('CA-9.10 modo enforcee → enforce; bloque ausente o config inexistente → dry-run', async () => {
    const bad = () => fakeGhClient({ body: 'nada' });
    assert.strictEqual((await run(PR, { gh: bad(), config: CONFIG.enforcee })).code, 1);
    const ausente = await run(PR, { gh: bad(), config: CONFIG.ausente });
    assert.strictEqual(ausente.code, 0);
    assert.match(ausente.out, /::warning/);
    assert.strictEqual((await run(PR, { gh: bad(), config: null })).code, 0);
});

// 11
test('CA-9.11 body > 64 KB → hallazgo sin parsear', async () => {
    const gh = fakeGhClient({ body: `${'x'.repeat(70 * 1024)}\n${GOOD_BODY}` });
    const r = await run(PR, { gh, config: CONFIG.enforce });
    assert.strictEqual(r.code, 1);
    assert.match(r.out, /supera 64 KB/);
    assert.strictEqual(gh.calls.issueExists.length, 0);
});

// 12
function fakeGit(stdout, { fail = false, record = [] } = {}) {
    return (cmd, args, opts, cb) => {
        record.push({ cmd, args, opts });
        if (fail) cb(new Error('bad object'), '', 'fatal');
        else cb(null, stdout, '');
    };
}

test('CA-9.12 --informative → exit 0 aunque haya hallazgos (un warning por commit)', async () => {
    const record = [];
    const msg = 'Título (#7700)\n\nCuerpo\n\nCo-Authored-By: Claude <noreply@anthropic.com>';
    const r = await run(['verify', '--commit', 'abcdef1234', '--informative'], {
        config: CONFIG.enforce,
        execFileImpl: fakeGit(`2026-09-24T10:00:00Z\n${msg}`, { record }),
    });
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.out, '::warning title=Autoría del PR::Entró a main un squash de agent/* sin trailer de autoría (commit abcdef1).\n');
    assert.strictEqual(record[0].cmd, 'git');
    assert.deepStrictEqual(record[0].args, ['log', '-1', '--format=%cI%n%B', 'abcdef1234']);
    assert.strictEqual(record[0].opts.shell, false);
});

test('--informative: commit anterior a go_live_date no se reporta', async () => {
    const cfg = "authorship:\n  gate_mode: dry-run\n  go_live_date: '2026-09-23T00:00:00Z'\n";
    const r = await run(['verify', '--commit', 'abcdef1', '--informative'], {
        config: cfg,
        execFileImpl: fakeGit('2026-09-01T10:00:00Z\nTítulo (#1)\n\nCo-Authored-By: Claude <noreply@anthropic.com>'),
    });
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.out, '');
});

test('--informative: squash válido, commit humano, sha inválido o git roto → silencio y exit 0', async () => {
    const block = trailer.buildTrailerBlock({ issue: 7632, humanLine: HUMAN, aiLine: AI });
    const casos = [
        { sha: 'abcdef1', git: fakeGit(`2026-09-24T10:00:00Z\nTítulo (#7700)\n\n${block}`) },
        { sha: 'abcdef1', git: fakeGit('2026-09-24T10:00:00Z\ndocs: manual (#12)\n\nsin IA') },
        { sha: 'no-hex;rm', git: fakeGit('x') },
        { sha: 'abcdef1', git: fakeGit('', { fail: true }) },
    ];
    for (const c of casos) {
        const r = await run(['verify', '--commit', c.sha, '--informative'], { execFileImpl: c.git });
        assert.strictEqual(r.code, 0);
        assert.strictEqual(r.out, '');
    }
});

test('verify --commit sin --informative → uso inválido (exit 2)', async () => {
    assert.strictEqual((await run(['verify', '--commit', 'abcdef1'])).code, 2);
});

test('enabled: false → notice único y exit 0 aun en un PR inválido', async () => {
    const gh = fakeGhClient({ body: 'nada' });
    const r = await run(PR, { gh, config: CONFIG.disabled });
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.out, '::notice title=Autoría del PR::La verificación de autoría está desactivada por configuración.\n');
    assert.strictEqual(gh.calls.prView.length, 0);
});

test('excepción inesperada → UNVERIFIABLE: exit 0 en dry-run / 1 en enforce', async () => {
    const dry = await run(PR, { gh: fakeGhClient({ throws: true }) });
    assert.strictEqual(dry.code, 0);
    assert.match(dry.out, /No se pudo consultar GitHub/);
    const enf = await run(PR, { gh: fakeGhClient({ throws: true }), config: CONFIG.enforce });
    assert.strictEqual(enf.code, 1);
});

test('número de PR inválido → no se consulta a GitHub', async () => {
    const gh = fakeGhClient();
    const r = await run(['verify', '--pr', '42; ls', '--config', 'x'], { gh });
    assert.strictEqual(r.code, 0);
    assert.strictEqual(gh.calls.prView.length, 0);
});

test('--help documenta D-A, D-B y "consistencia, no autenticidad" (CA-8)', async () => {
    const r = await run(['--help']);
    assert.strictEqual(r.code, 0);
    assert.match(HELP, /buildSquashMessage/);
    assert.match(HELP, /authorship-anchor/);
    assert.match(HELP, /bloque ausente\s+-> dry-run/);
    assert.match(HELP, /CONSISTENCIA, NO AUTENTICIDAD/);
    assert.strictEqual((await run([])).code, 2);
    assert.strictEqual((await run(['otro'])).code, 2);
});

// --- gh-client --------------------------------------------------------------

function fakeExec(result) {
    const calls = [];
    const impl = (cmd, args, opts, cb) => {
        calls.push({ cmd, args, opts });
        cb(result.err ? new Error('x') : null, result.stdout || '', result.stderr || '');
    };
    return { impl, calls };
}

test('gh-client: issueExists clasifica existe / 404 / error y usa execFile sin shell', async () => {
    const ok = fakeExec({ stdout: '{"number":7632}' });
    assert.strictEqual(await createGhClient({ execFileImpl: ok.impl, env: {} }).issueExists('7632'), 'exists');
    assert.deepStrictEqual(ok.calls[0].args, ['issue', 'view', '7632', '--json', 'number']);
    assert.strictEqual(ok.calls[0].cmd, 'gh');
    assert.strictEqual(ok.calls[0].opts.shell, false);

    const nf = fakeExec({ err: true, stderr: 'GraphQL: Could not resolve to an Issue with the number of 99.' });
    assert.strictEqual(await createGhClient({ execFileImpl: nf.impl }).issueExists('99'), 'not_found');
    const http404 = fakeExec({ err: true, stderr: 'HTTP 404: Not Found' });
    assert.strictEqual(await createGhClient({ execFileImpl: http404.impl }).issueExists('99'), 'not_found');

    for (const r of [{ err: true, stderr: 'HTTP 403: rate limit' }, { err: true, stderr: 'dial tcp: timeout' }, { stdout: 'no json' }, { stdout: '{"number":1}' }]) {
        assert.strictEqual(await createGhClient({ execFileImpl: fakeExec(r).impl }).issueExists('99'), 'error');
    }
    const lanza = () => { throw new Error('ENOENT gh'); };
    assert.strictEqual(await createGhClient({ execFileImpl: lanza }).issueExists('1'), 'error');
});

test('gh-client: prView arma los mensajes de commit y tolera errores', async () => {
    const payload = JSON.stringify({
        body: 'B', headRefName: 'agent/1-x',
        commits: [{ messageHeadline: 'feat: a', messageBody: 'cuerpo' }, { messageHeadline: 'fix: b', messageBody: '' }],
    });
    const ok = fakeExec({ stdout: payload });
    const res = await createGhClient({ execFileImpl: ok.impl }).prView('5');
    assert.deepStrictEqual(res, { ok: true, body: 'B', headRefName: 'agent/1-x', commits: ['feat: a\n\ncuerpo', 'fix: b'] });
    assert.deepStrictEqual(ok.calls[0].args, ['pr', 'view', '5', '--json', 'body,headRefName,commits']);
    assert.deepStrictEqual(await createGhClient({ execFileImpl: fakeExec({ err: true }).impl }).prView('5'), { ok: false });
    assert.deepStrictEqual(await createGhClient({ execFileImpl: fakeExec({ stdout: 'x' }).impl }).prView('5'), { ok: false });
    assert.deepStrictEqual(await createGhClient({ execFileImpl: fakeExec({ stdout: 'null' }).impl }).prView('5'), { ok: false });
});

test('el GH_TOKEN nunca aparece en la salida del CLI', async () => {
    const lines = [];
    const code = await main(PR, {
        ghClient: fakeGhClient({ issue: 'error' }),
        fsImpl: fakeFs(CONFIG.enforce),
        stdout: { write: (s) => lines.push(s) },
        env: { GH_TOKEN: 'TOKEN-DE-PRUEBA-NO-REAL' },
    });
    assert.strictEqual(code, 1);
    assert.ok(!lines.join('').includes('TOKEN-DE-PRUEBA-NO-REAL'));
});

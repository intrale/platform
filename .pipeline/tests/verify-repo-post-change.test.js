'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { verifyRepo, createGithubClient, parseArgs } = require('../lib/verify-repo-post-change');

const legacy = { repo: 'intrale/example', visibility: 'public', archived: true, profile: 'legacy' };
const active = { ...legacy, visibility: 'private', archived: false, profile: 'active', since: '2026-09-23T00:00:00Z', minimumRules: 1, sast: 'required' };
function fakeGithubClient(options = legacy, overrides = {}) {
    const responses = {
        '': { visibility: options.visibility, archived: options.archived, default_branch: 'main' },
        '/actions/workflows?per_page=100': options.profile === 'legacy' ? [{ workflows: [] }] : [{ workflows: [{ id: 1, path: '.github/workflows/ci.yml' }] }],
        '/releases?per_page=100': [[]],
        '/actions/runs?per_page=1': { total_count: 0 },
        '/rules/branches/main': [{ type: 'pull_request' }],
        '/actions/workflows/1/runs?per_page=1': { workflow_runs: [{ status: 'completed', conclusion: 'success', created_at: '2026-09-24T00:00:00Z', html_url: 'https://github.com/intrale/example/actions/runs/1' }] },
        '/code-scanning/analyses?per_page=100': [[{ created_at: '2026-09-24T00:00:00Z', error: '', tool: { name: 'Semgrep' } }]],
        '/actions/permissions': { enabled: true },
        '/actions/permissions/fork-pr-workflows-private-repos': { run_workflows_from_fork_pull_requests: false, send_write_tokens_to_workflows: false, send_secrets_and_variables: false },
        ...overrides,
    };
    return endpoint => {
        const suffix = endpoint.slice(`repos/${options.repo}`.length);
        assert.ok(Object.hasOwn(responses, suffix), `Endpoint inesperado: ${endpoint}`);
        if (responses[suffix] instanceof Error) throw responses[suffix];
        return responses[suffix];
    };
}

test('acepta legacy archivado sólo con inventario vacío comprobado', () => {
    assert.equal(verifyRepo(legacy, fakeGithubClient()).ok, true);
});
test('rechaza una visibilidad o un archivado diferente al esperado', () => {
    for (const metadata of [{ visibility: 'private', archived: true }, { visibility: 'public', archived: false }]) {
        assert.equal(verifyRepo(legacy, fakeGithubClient(legacy, { '': metadata })).ok, false);
    }
});
test('no interpreta errores API como ausencia de workflows', () => {
    const report = verifyRepo(legacy, fakeGithubClient(legacy, { '/actions/workflows?per_page=100': new Error('HTTP 403') }));
    assert.equal(report.ok, false);
    assert.match(JSON.stringify(report), /HTTP 403/);
});
test('rechaza legacy con workflows en la segunda página, runs o releases', () => {
    for (const overrides of [
        { '/actions/workflows?per_page=100': [{ workflows: [] }, { workflows: [{ id: 2, path: 'build.yml' }] }] },
        { '/actions/runs?per_page=1': { total_count: 1 } },
        { '/releases?per_page=100': [[], [{ tag_name: 'v1' }]] },
    ]) assert.equal(verifyRepo(legacy, fakeGithubClient(legacy, overrides)).ok, false);
});
test('acepta controles activos con CI y SARIF posteriores al cambio', () => {
    assert.equal(verifyRepo(active, fakeGithubClient(active)).ok, true);
});
test('rechaza rules vacío cuando existían reglas', () => {
    assert.equal(verifyRepo(active, fakeGithubClient(active, { '/rules/branches/main': [] })).ok, false);
});
test('rechaza SARIF ausente, antiguo o con error aunque CI esté verde', () => {
    for (const analyses of [[], [{ created_at: active.since }], [{ created_at: '2026-09-24T00:00:00Z', error: 'upload failed' }]]) {
        assert.equal(verifyRepo(active, fakeGithubClient(active, { '/code-scanning/analyses?per_page=100': [analyses] })).ok, false);
    }
});
test('rechaza CI antiguo, en ejecución, fallido o ausente', () => {
    for (const run of [null, { created_at: active.since, status: 'completed', conclusion: 'success' }, { created_at: '2026-09-24', status: 'in_progress' }, { created_at: '2026-09-24', status: 'completed', conclusion: 'failure' }]) {
        assert.equal(verifyRepo(active, fakeGithubClient(active, { '/actions/workflows/1/runs?per_page=1': { workflow_runs: run ? [run] : [] } })).ok, false);
    }
});
test('rechaza forks habilitados o políticas desconocidas', () => {
    for (const policy of [{}, { run_workflows_from_fork_pull_requests: true }, new Error('HTTP 404')]) {
        assert.equal(verifyRepo(active, fakeGithubClient(active, { '/actions/permissions/fork-pr-workflows-private-repos': policy })).ok, false);
    }
});
test('requiere opciones explícitas y no admite repos ni flags arbitrarios', () => {
    assert.deepEqual(parseArgs(['--repo', legacy.repo, '--visibility', 'public', '--archived', 'true', '--profile', 'legacy']), legacy);
    assert.throws(() => parseArgs(['--archived', 'yes']));
    assert.throws(() => parseArgs(['--execute', 'true']));
    assert.throws(() => verifyRepo({ ...legacy, repo: '--help' }));
    assert.throws(() => verifyRepo({ ...active, since: 'invalid' }));
    assert.throws(() => verifyRepo({ ...active, minimumRules: undefined }));
});
test('cliente usa GET paginado, timeout y nunca propaga stderr sensible', () => {
    const client = createGithubClient((bin, args, options) => {
        assert.deepEqual(args, ['api', '--method', 'GET', 'repos/intrale/example/releases', '--paginate', '--slurp']);
        assert.equal(options.timeout, 60000);
        assert.equal(options.shell, undefined);
        return '[[]]';
    });
    assert.deepEqual(client('repos/intrale/example/releases', true), [[]]);
    const failing = createGithubClient(() => { throw new Error('TOKEN_PRIVADO'); });
    assert.throws(() => failing('repos/intrale/example'), error => !error.message.includes('TOKEN_PRIVADO'));
});

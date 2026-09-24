'use strict';
// #7631 — Wiring del trailer de autoría y del gate `authorship` en delivery.js.
//
// Sin red: gh, git, tmp y el evaluador se inyectan. Verifica:
//   - los DOS `mergePR` (principal y reclaim) usan la fábrica común;
//   - el PUT lleva merge_method, commit_title saneado, sha y commit_message;
//   - en `enforce` con motivo → blocked/authorship y `mergePR` NO se llama;
//   - en `dry-run` → se mergea y el comentario es único aunque se re-corra;
//   - el gate corre con `snapshot.headRefOid`;
//   - el body del PR con un ancla falsa queda sólo con la del código.

const nodeTest = require('node:test');
const { after } = require('node:test');
const { withEnv } = require('../test-helpers/with-env');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Aislar REPO_ROOT (delivery escribe audit + cola Telegram centrales acá).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-delivery7631-'));
fs.mkdirSync(path.join(TMP, '.claude', 'hooks'), { recursive: true });
fs.mkdirSync(path.join(TMP, '.pipeline', 'logs'), { recursive: true });
// Vía withEnv (restaura el entorno al terminar): el require y cada test corren
// con el REPO_ROOT aislado, sin escribir process.env a mano.
const ENV_AISLADO = { PIPELINE_REPO_ROOT: TMP, CLAUDE_PROJECT_DIR: TMP };
const test = (name, fn) => nodeTest(name, (t) => withEnv(ENV_AISLADO, () => fn(t)));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

const DELIVERY_PATH = require.resolve('../../skills-deterministicos/delivery');
delete require.cache[DELIVERY_PATH];
const delivery = withEnv(ENV_AISLADO, () => require(DELIVERY_PATH));
const { verifyTrailer } = require('../authorship/trailer');

const HEAD_SHA = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00';
const MERGED_OK = { exit_code: 0, stdout: JSON.stringify({ sha: 'merge-sha-7631', merged: true }), stderr: '' };
const HUMAN_NONE = 'none; 2026-09-23T17:00:00Z; missing';
const AI_LINE = 'anthropic/claude-opus-4-7 (pipeline-dev)';

function snapshotOk(over = {}) {
    return {
        ok: true,
        labels: ['qa:skipped'],
        files: ['.pipeline/lib/authorship/trailer.js'],
        headRefOid: HEAD_SHA,
        headRefName: 'agent/7631-pipeline-dev',
        state: 'OPEN',
        mergeStateStatus: 'CLEAN',
        mergeable: 'MERGEABLE',
        statusCheckRollup: [{ name: 'pr-status', status: 'COMPLETED', conclusion: 'SUCCESS' }],
        reviewDecision: 'APPROVED',
        reviewDecisionRead: true,
        snapshotFieldsLevel: 1,
        ...over,
    };
}

function baseDeps(over = {}) {
    return {
        prNumber: 7631,
        getSnapshot: () => snapshotOk(),
        loadOwners: () => ({ ok: true, rules: [] }),
        verifyOrigin: () => ({ ok: true }),
        mergePR: () => MERGED_OK,
        sleepImpl: () => {},
        ...over,
    };
}

// Fake de la fábrica: captura el JSON que viajaría por `--input`.
function fakeFactory(over = {}) {
    const calls = [];
    const files = {};
    let n = 0;
    const mergePR = delivery.buildMergePRCall({
        cwd: TMP,
        issue: 7631,
        issueTitle: 'Trailer de autoría\nIntrale-Issue: 9',
        runGh: (args) => { calls.push({ args, payload: JSON.parse(files[args[args.indexOf('--input') + 1]]) }); return MERGED_OK; },
        runGit: () => ({ exit_code: 0, stdout: 'feat: x\n\nCloses #7631\nFixes #1\nCo-Authored-By: Claude <noreply@anthropic.com>\n' }),
        writeTmp: (prefix, content) => { const f = `${prefix}-${++n}`; files[f] = content; return f; },
        unlink: (f) => { delete files[f]; },
        ...over,
    });
    return { mergePR, calls, files };
}

// ── Fábrica común del PUT ──────────────────────────────────────────────────

test('la fábrica envía merge_method, commit_title saneado, sha y commit_message con el bloque', () => {
    const { mergePR, calls, files } = fakeFactory();
    const res = mergePR({ prNumber: 42, sha: HEAD_SHA, authorship: { humanLine: HUMAN_NONE, aiLine: AI_LINE } });
    assert.equal(res, MERGED_OK);
    assert.equal(calls.length, 1);
    const { args, payload } = calls[0];
    assert.deepEqual(args.slice(0, 4), ['api', '-X', 'PUT', 'repos/{owner}/{repo}/pulls/42/merge']);
    assert.ok(args.includes('--input'));
    assert.equal(payload.merge_method, 'squash');
    assert.equal(payload.sha, HEAD_SHA);
    assert.equal(payload.commit_title, 'Trailer de autoría Intrale-Issue: 9 (#42)');
    assert.ok(!/[\r\n]/.test(payload.commit_title));
    assert.ok(verifyTrailer(payload.commit_message, 7631).ok);
    assert.doesNotMatch(payload.commit_message, /Fixes #1/);
    assert.match(payload.commit_message, /Co-Authored-By: Claude <noreply@anthropic.com>$/);
    assert.deepEqual(Object.keys(files), [], 'el archivo temporal se borra');
});

test('sin evaluación de autoría (off / grandfathered) no se manda commit_message', () => {
    const { mergePR, calls } = fakeFactory();
    mergePR({ prNumber: 42, sha: HEAD_SHA, authorship: { decision: 'pass', humanLine: null, aiLine: null } });
    assert.equal('commit_message' in calls[0].payload, false);
    mergePR({ prNumber: 42, sha: HEAD_SHA });
    assert.equal('commit_message' in calls[1].payload, false);
});

test('título vacío cae al fallback (función o texto) y git caído deja sólo el bloque', () => {
    const f1 = fakeFactory({ issueTitle: '', fallbackTitle: (n) => `reclaim PR #${n}`, runGit: () => ({ exit_code: 128, stdout: '' }) });
    f1.mergePR({ prNumber: 7, sha: HEAD_SHA, authorship: { humanLine: HUMAN_NONE, aiLine: AI_LINE } });
    assert.equal(f1.calls[0].payload.commit_title, 'reclaim PR #7 (#7)');
    assert.ok(f1.calls[0].payload.commit_message.startsWith('Closes #7631'));
    const f2 = fakeFactory({ issueTitle: null, fallbackTitle: 'Issue #7631' });
    f2.mergePR({ prNumber: 7, sha: HEAD_SHA });
    assert.equal(f2.calls[0].payload.commit_title, 'Issue #7631 (#7)');
    const f3 = fakeFactory({ issueTitle: null, fallbackTitle: null });
    f3.mergePR({ prNumber: 7, sha: HEAD_SHA });
    assert.equal(f3.calls[0].payload.commit_title, 'PR #7 (#7)');
});

test('issue inválido: el merge NO se envía sin trailers (respuesta fallida, sin llamar a gh)', () => {
    const logs = [];
    const { mergePR, calls } = fakeFactory({ issue: null, logAppend: (l) => logs.push(l) });
    const res = mergePR({ prNumber: 7, sha: HEAD_SHA, authorship: { humanLine: HUMAN_NONE, aiLine: AI_LINE } });
    assert.equal(res.exit_code, 1);
    assert.equal(calls.length, 0);
    assert.ok(logs.some((l) => /merge NO enviado/.test(l)));
});

test('readBranchMessages usa argv (sin shell) contra origin/main..sha y rechaza shas raros', () => {
    const seen = [];
    const out = delivery.readBranchMessages('/x', HEAD_SHA, { runGit: (args) => { seen.push(args); return { exit_code: 0, stdout: 'm' }; } });
    assert.equal(out, 'm');
    assert.deepEqual(seen[0], ['log', '--format=%B', `origin/main..${HEAD_SHA}`]);
    assert.equal(delivery.readBranchMessages('/x', 'main; rm -rf /', { runGit: () => { throw new Error('no'); } }), '');
    assert.equal(delivery.readBranchMessages('/x', HEAD_SHA, { runGit: () => { throw new Error('git'); } }), '');
});

test('estático: los DOS caminos de merge usan la fábrica y el evaluador real', () => {
    const src = fs.readFileSync(DELIVERY_PATH, 'utf8');
    assert.equal((src.match(/mergePR: buildMergePRCall\(/g) || []).length, 2, 'principal + reclaim');
    assert.equal((src.match(/evaluateAuthorship: buildAuthorshipEvaluator\(/g) || []).length, 2, 'principal + reclaim');
    assert.doesNotMatch(src, /commit_title=\$\{/, 'no queda ningún PUT armado a mano con -f commit_title');
    assert.match(src, /reclaimMergeWithGates\(\{ prNumber, issue, /, 'la reclaim recibe el número de issue');
});

// ── Gate en attemptMergeWithGates ──────────────────────────────────────────

test('enforce con motivo → blocked/authorship y mergePR NO se llama', () => {
    const merges = [];
    const out = delivery.attemptMergeWithGates(baseDeps({
        mergePR: () => { merges.push(1); return MERGED_OK; },
        evaluateAuthorship: () => ({ decision: 'block', mode: 'enforce', reason: 'anchor-mismatch' }),
    }));
    assert.equal(out.status, 'blocked');
    assert.equal(out.gate, 'authorship');
    assert.equal(out.authorshipReason, 'anchor-mismatch');
    assert.match(out.reason, /otro commit/);
    assert.equal(merges.length, 0);
    assert.ok(delivery.GATE_BLOCK_LABELS.authorship);
});

test('una excepción del evaluador bloquea (fail-closed) y un resultado vacío también', () => {
    const merges = [];
    const boom = delivery.attemptMergeWithGates(baseDeps({
        mergePR: () => { merges.push(1); return MERGED_OK; },
        evaluateAuthorship: () => { throw new Error('boom'); },
    }));
    assert.equal(boom.status, 'blocked');
    assert.equal(boom.gate, 'authorship');
    const vacio = delivery.attemptMergeWithGates(baseDeps({
        mergePR: () => { merges.push(1); return MERGED_OK; },
        evaluateAuthorship: () => null,
    }));
    assert.equal(vacio.gate, 'authorship');
    assert.equal(merges.length, 0);
});

test('dry-run → mergea, con el head del snapshot vigente y la MISMA evaluación en mergePR', () => {
    const seen = [];
    let recibido = null;
    const evalRes = { decision: 'pass', mode: 'dry-run', reason: 'missing', humanLine: HUMAN_NONE, aiLine: AI_LINE, notice: true };
    const out = delivery.attemptMergeWithGates(baseDeps({
        evaluateAuthorship: (ctx) => { seen.push(ctx); return evalRes; },
        mergePR: (args) => { recibido = args; return MERGED_OK; },
    }));
    assert.equal(out.status, 'merged');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].headSha, HEAD_SHA);
    assert.equal(seen[0].snapshot.headRefOid, HEAD_SHA);
    assert.equal(recibido.sha, HEAD_SHA);
    assert.equal(recibido.authorship, evalRes);
});

test('regresión #7651: evaluación "block" en modo de prueba (dry-run) NO frena el merge', () => {
    let recibido = null;
    const out = delivery.attemptMergeWithGates(baseDeps({
        evaluateAuthorship: () => ({ decision: 'block', mode: 'dry-run', reason: 'missing', humanLine: HUMAN_NONE, aiLine: AI_LINE }),
        mergePR: (args) => { recibido = args; return MERGED_OK; },
    }));
    assert.equal(out.status, 'merged');
    assert.equal(recibido.authorship.decision, 'pass');
    assert.equal(recibido.authorship.notice, true);
    assert.equal(recibido.authorship.humanLine, HUMAN_NONE);
});

test('regresión #7651: evaluador de producción en modo de prueba sin firma avisa en el PR y deja mergear', () => {
    const notices = [];
    const ev = delivery.buildAuthorshipEvaluator({
        issue: 7631,
        loadConfig: () => ({ authorship: { enabled: true, gate_mode: 'dry-run', identity_map: {} } }),
        prCreatedAtReader: () => '2026-09-24T00:00:00Z',
        evaluate: () => ({ decision: 'block', mode: 'dry-run', notice: true, reason: 'missing', humanLine: HUMAN_NONE, aiLine: AI_LINE }),
        postNotice: (a) => { notices.push(a); return { posted: true }; },
        syncAnchor: () => ({ updated: true }),
    });
    const out = delivery.attemptMergeWithGates(baseDeps({ evaluateAuthorship: ev, mergePR: () => MERGED_OK }));
    assert.equal(out.status, 'merged');
    assert.equal(notices.length, 1);
    assert.equal(notices[0].reason, 'missing');
});

test('sin evaluador inyectado, el default pasa sin líneas (suites viejas intactas)', () => {
    let recibido = null;
    const out = delivery.attemptMergeWithGates(baseDeps({ mergePR: (a) => { recibido = a; return MERGED_OK; } }));
    assert.equal(out.status, 'merged');
    assert.equal(recibido.authorship.humanLine, null);
});

test('el gate authorship corre DESPUÉS de los demás: sin QA no se evalúa', () => {
    let evaluado = false;
    const out = delivery.attemptMergeWithGates(baseDeps({
        getSnapshot: () => snapshotOk({ labels: [] }),
        evaluateAuthorship: () => { evaluado = true; return { decision: 'block', reason: 'missing' }; },
    }));
    assert.equal(out.status, 'no-qa-gate');
    assert.equal(evaluado, false);
});

// ── Evaluador de producción + efectos visibles ─────────────────────────────

function fakeGhPR({ body = '', comments = [] } = {}) {
    const state = { body, comments: [...comments], edits: 0, posts: 0, files: {} };
    let n = 0;
    const gh = (args) => {
        if (args[0] === 'pr' && args[1] === 'view' && args.includes('comments')) {
            return { exit_code: 0, stdout: JSON.stringify({ comments: state.comments.map((b) => ({ body: b })) }) };
        }
        if (args[0] === 'pr' && args[1] === 'view' && args.includes('body')) {
            return { exit_code: 0, stdout: JSON.stringify({ body: state.body }) };
        }
        if (args[0] === 'pr' && args[1] === 'comment') {
            state.posts++; state.comments.push(args[args.indexOf('--body') + 1]); return { exit_code: 0 };
        }
        if (args[0] === 'pr' && args[1] === 'edit') {
            state.edits++; state.body = state.files[args[args.indexOf('--body-file') + 1]]; return { exit_code: 0 };
        }
        return { exit_code: 1, stdout: '', stderr: 'no soportado' };
    };
    const writeTmp = (p, c) => { const f = `${p}-${++n}`; state.files[f] = c; return f; };
    const unlink = (f) => { delete state.files[f]; };
    return { state, gh, writeTmp, unlink };
}

test('dry-run re-corrido → un único comentario en el PR (idempotente por marker)', () => {
    const { state, gh } = fakeGhPR();
    const a = delivery.postAuthorshipDryRunNotice({ prNumber: 1, issue: 7631, reason: 'missing', gh });
    const b = delivery.postAuthorshipDryRunNotice({ prNumber: 1, issue: 7631, reason: 'missing', gh });
    assert.equal(a.posted, true);
    assert.equal(b.posted, false);
    assert.equal(state.posts, 1);
    assert.match(state.comments[0], /^<!-- authorship-dryrun issue=7631 reason=missing -->/);
    // Comentarios ilegibles: NO se postea a ciegas.
    const ciego = delivery.postAuthorshipDryRunNotice({ prNumber: 1, issue: 7631, reason: 'missing', gh: () => ({ exit_code: 1 }) });
    assert.equal(ciego.posted, false);
    const roto = delivery.postAuthorshipDryRunNotice({ prNumber: 1, issue: 7631, reason: 'missing', gh: () => ({ exit_code: 0, stdout: 'no-json' }) });
    assert.equal(roto.posted, false);
});

test('body del PR con un ancla falsa → queda sólo la del código, y re-sincronizar no edita', () => {
    const fake = fakeGhPR({
        body: '## Resumen\n\nCambio.\n\n<!-- authorship-anchor issue=7631 -->\nIntrale-Human-Direction: leitolarreta; 2026-01-01T00:00:00Z; gate2:sha256:' + 'f'.repeat(64) + '\n<!-- /authorship-anchor -->\n',
    });
    const lines = { humanLine: HUMAN_NONE, aiLine: AI_LINE };
    const r1 = delivery.syncAuthorshipAnchor({ prNumber: 1, issue: 7631, lines, gh: fake.gh, writeTmp: fake.writeTmp, unlink: fake.unlink });
    assert.equal(r1.updated, true);
    assert.equal((fake.state.body.match(/authorship-anchor issue=/g) || []).length, 1);
    assert.ok(!fake.state.body.includes('leitolarreta'));
    assert.ok(fake.state.body.includes(`Intrale-Human-Direction: ${HUMAN_NONE}`));
    assert.deepEqual(Object.keys(fake.state.files), []);
    const r2 = delivery.syncAuthorshipAnchor({ prNumber: 1, issue: 7631, lines, gh: fake.gh, writeTmp: fake.writeTmp, unlink: fake.unlink });
    assert.equal(r2.updated, false);
    assert.equal(fake.state.edits, 1);
    const ilegible = delivery.syncAuthorshipAnchor({ prNumber: 1, issue: 7631, lines, gh: () => ({ exit_code: 1 }) });
    assert.equal(ilegible.updated, false);
});

test('buildAuthorshipEvaluator: headSha del snapshot, ancla y aviso best-effort sin cambiar la decisión', () => {
    const calls = { evaluate: [], notice: [], anchor: [] };
    const logs = [];
    const ev = delivery.buildAuthorshipEvaluator({
        issue: 7631,
        logAppend: (l) => logs.push(l),
        loadConfig: () => ({ authorship: { enabled: true, gate_mode: 'dry-run' } }),
        prCreatedAtReader: () => '2026-09-24T00:00:00Z',
        evaluate: (args) => { calls.evaluate.push(args); return { decision: 'pass', notice: true, reason: 'missing', humanLine: HUMAN_NONE, aiLine: AI_LINE, warnings: ['w1'] }; },
        postNotice: (a) => { calls.notice.push(a); throw new Error('gh caído'); },
        syncAnchor: (a) => { calls.anchor.push(a); throw new Error('gh caído'); },
    });
    const res = ev({ prNumber: 9, snapshot: snapshotOk() });
    assert.equal(res.decision, 'pass');
    assert.equal(calls.evaluate[0].headSha, HEAD_SHA);
    assert.equal(calls.evaluate[0].issue, 7631);
    assert.equal(calls.evaluate[0].prCreatedAt, '2026-09-24T00:00:00Z');
    assert.equal(calls.notice.length, 1);
    assert.equal(calls.anchor[0].lines.humanLine, HUMAN_NONE);
    assert.ok(logs.some((l) => /w1/.test(l)));
    assert.ok(logs.some((l) => /no bloqueante/.test(l)));

    // En `enforce` que bloquea no se postea el aviso de dry-run.
    const ev2 = delivery.buildAuthorshipEvaluator({
        issue: 7631, loadConfig: () => null, prCreatedAtReader: () => null,
        evaluate: () => ({ decision: 'block', notice: false, reason: 'missing', humanLine: HUMAN_NONE, aiLine: 'unknown' }),
        postNotice: () => { throw new Error('no debería'); },
        syncAnchor: () => ({ updated: false }),
    });
    assert.equal(ev2({ prNumber: 9, snapshot: snapshotOk() }).decision, 'block');
});

test('buildAuthorshipEvaluator de producción corre el evaluador real end-to-end sin firma', () => {
    const fake = fakeGhPR({ body: 'x' });
    const ev = delivery.buildAuthorshipEvaluator({
        issue: 7631,
        loadConfig: () => ({ authorship: { enabled: true, gate_mode: 'dry-run', identity_map: {} } }),
        prCreatedAtReader: () => null,
        postNotice: (a) => delivery.postAuthorshipDryRunNotice({ ...a, gh: fake.gh }),
        syncAnchor: (a) => delivery.syncAuthorshipAnchor({ ...a, gh: fake.gh, writeTmp: fake.writeTmp, unlink: fake.unlink }),
    });
    const res = ev({ prNumber: 3, snapshot: snapshotOk({ headRefOid: 'f'.repeat(40) }) });
    assert.equal(res.decision, 'pass');
    assert.equal(res.mode, 'dry-run');
    assert.match(res.humanLine, /^none; .+; (missing|unmapped|anchor-mismatch|chain-broken)$/);
    assert.equal(fake.state.posts, res.notice ? 1 : 0);
    assert.ok(fake.state.body.includes('<!-- authorship-anchor issue=7631 -->'));
});

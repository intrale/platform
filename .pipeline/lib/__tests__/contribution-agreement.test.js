// =============================================================================
// Tests del gate del Acuerdo de Contribución (CLA) · #7599
//
// Casos del issue (T1..T4), de security (T5..T11), estáticos del workflow
// (T12) y contrato de sparse-checkout (T13, patrón #5680). Además, la
// orquestación `run()` con un fake de Octokit (fail-closed, registro,
// idempotencia del comentario).
//
// Correr: node --test .pipeline/lib/__tests__/contribution-agreement.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');

const cla = require('../contribution-agreement');

const REPO_ROOT = nodePath.join(__dirname, '..', '..', '..');
const WORKFLOW_PATH = nodePath.join(REPO_ROOT, '.github', 'workflows', 'contribution-agreement.yml');
const CLA_TEXT = fs.readFileSync(nodePath.join(REPO_ROOT, 'docs', 'legal', 'CLA.md'), 'utf8');
const CLA_HASH = cla.computeClaHash(CLA_TEXT);
const OLD_HASH = 'a'.repeat(64);

const OWNER_ID = 16225095;       // leitolarreta
const CODEXBOT_ID = 215716766;   // leitocodexbot
const ACTIONS_BOT_ID = 41898282;
const EXT_ID = 9000001;
const EXT2_ID = 9000002;
const BASE_REPO_ID = 123456789;  // intrale/platform (fixture)
const FORK_REPO_ID = 987654321;  // fork de un externo (fixture)

function commitBy(id, email = 'x@example.com') {
    return { sha: 'c'.repeat(40), author: id === null ? null : { id, login: `u${id}` }, commit: { author: { email } } };
}
function pr({ userId = EXT_ID, assoc = 'NONE', commits = 1, headRepoId = FORK_REPO_ID } = {}) {
    return {
        user: { id: userId }, author_association: assoc, commits,
        head: { repo: headRepoId === null ? null : { id: headRepoId } },
        base: { repo: { id: BASE_REPO_ID } },
    };
}
/**
 * Fixture REAL de un commit de agente del pipeline, tal como lo devuelve
 * `GET /repos/intrale/platform/pulls/7674/commits` (verificado 25/09/2026):
 * email sin cuenta de GitHub ⇒ `author` y `committer` null, sin firma.
 */
function agentCommit(skill = 'backend-dev') {
    const email = `${skill}-agent@intrale`;
    return {
        sha: 'eb27c8f80'.padEnd(40, '0'),
        author: null,
        committer: null,
        commit: {
            author: { name: `${skill}-agent`, email },
            committer: { name: `${skill}-agent`, email },
            verification: { verified: false, reason: 'unsigned' },
        },
    };
}
function sig(userId, hash = CLA_HASH) {
    return { user_id: userId, login_at_signing: `u${userId}`, signed_at: '2026-09-25T00:00:00Z', cla_version: '1.0', cla_hash: hash, pr: 1 };
}

// --- Casos del issue ------------------------------------------------------------

test('T1 externo con firma vigente ⇒ success', () => {
    const r = cla.evaluate({ pr: pr(), commits: [commitBy(EXT_ID)], signatures: [sig(EXT_ID)], claHash: CLA_HASH });
    assert.equal(r.state, 'success');
    assert.equal(r.kind, 'signed');
});

test('T2 externo sin firma ⇒ failure con mensaje estático', () => {
    const r = cla.evaluate({ pr: pr(), commits: [commitBy(EXT_ID)], signatures: [], claHash: CLA_HASH });
    assert.equal(r.state, 'failure');
    assert.equal(r.kind, 'missing');
    assert.deepEqual(r.missing, [EXT_ID]);
    const msg = cla.getContributorMessage(r.missing.length);
    assert.ok(msg.startsWith(cla.COMMENT_MARKER));
    assert.ok(msg.includes('```\n' + cla.SIGN_PHRASE + '\n```'), 'la frase va en un bloque de código propio');
    assert.ok(msg.includes(cla.CONTRIBUTING_URL) && msg.includes(cla.CLA_URL));
    assert.ok(msg.includes('**English:**'));
});

test('T3 PR interno (OWNER/MEMBER) ⇒ success con descripción explícita', () => {
    for (const assoc of ['OWNER', 'MEMBER']) {
        const r = cla.evaluate({ pr: pr({ userId: 7777, assoc }), commits: [commitBy(7777)], signatures: [], claHash: CLA_HASH });
        assert.equal(r.state, 'success');
        assert.equal(r.kind, 'internal');
        assert.equal(r.description, cla.DESCRIPTIONS.internal);
    }
});

test('T3b COLLABORATOR/CONTRIBUTOR no cuentan como internos', () => {
    for (const assoc of ['COLLABORATOR', 'CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'NONE', undefined]) {
        assert.equal(cla.classifyActor({ userId: EXT_ID, authorAssociation: assoc }), 'external');
    }
});

test('T4 PR de bot o agente en la allowlist por ID ⇒ success', () => {
    assert.equal(cla.classifyActor({ userId: ACTIONS_BOT_ID, authorAssociation: 'NONE' }), 'bot');
    assert.equal(cla.classifyActor({ userId: CODEXBOT_ID, authorAssociation: 'NONE' }), 'internal');
    const r = cla.evaluate({ pr: pr({ userId: ACTIONS_BOT_ID }), commits: [commitBy(ACTIONS_BOT_ID)], signatures: [], claHash: CLA_HASH });
    assert.equal(r.state, 'success');
    const r2 = cla.evaluate({ pr: pr({ userId: OWNER_ID }), commits: [commitBy(OWNER_ID), commitBy(CODEXBOT_ID)], signatures: [], claHash: CLA_HASH });
    assert.equal(r2.state, 'success');
});

// --- Casos de security ------------------------------------------------------------

test('T5 email git que imita a un miembro con author.id externo ⇒ exige firma', () => {
    const r = cla.evaluate({
        pr: pr(), commits: [commitBy(EXT_ID, 'leito.larreta@gmail.com')], signatures: [], claHash: CLA_HASH,
    });
    assert.equal(r.state, 'failure');
    assert.deepEqual(r.missing, [EXT_ID]);
});

test('T6 PR de miembro con un commit externo ⇒ exige la firma de ese autor', () => {
    const r = cla.evaluate({
        pr: pr({ userId: OWNER_ID, assoc: 'OWNER' }), commits: [commitBy(OWNER_ID), commitBy(EXT2_ID)], signatures: [], claHash: CLA_HASH,
    });
    assert.equal(r.state, 'failure');
    assert.deepEqual(r.missing, [EXT2_ID]);
    // La firma de otro externo no lo destraba.
    const r2 = cla.evaluate({
        pr: pr({ userId: OWNER_ID, assoc: 'OWNER' }), commits: [commitBy(OWNER_ID), commitBy(EXT2_ID)], signatures: [sig(EXT_ID)], claHash: CLA_HASH,
    });
    assert.equal(r2.state, 'failure');
});

test('T6b commit de un miembro no allowlisteado dentro de un PR externo exige firma (sin association)', () => {
    const required = cla.collectExternalAuthors({
        prAuthor: { id: EXT_ID, authorAssociation: 'NONE' }, commits: [commitBy(EXT_ID), commitBy(5555)],
    });
    assert.deepEqual(required, [EXT_ID, 5555]);
});

test('T7 frase comentada por otro usuario ⇒ no cuenta', () => {
    const comment = { id: 1, user: { id: EXT2_ID }, body: cla.SIGN_PHRASE };
    assert.equal(cla.isValidSignature({ comment, requiredUserIds: [EXT_ID], claHash: CLA_HASH }), false);
    const comment2 = { id: 2, user: { id: OWNER_ID }, body: cla.SIGN_PHRASE };
    assert.equal(cla.isValidSignature({ comment: comment2, requiredUserIds: [EXT_ID], claHash: CLA_HASH }), false);
});

test('T8 frase con texto extra, parcial o con otra capitalización ⇒ no cuenta', () => {
    const base = { id: 1, user: { id: EXT_ID } };
    const ok = (body) => cla.isValidSignature({ comment: { ...base, body }, requiredUserIds: [EXT_ID], claHash: CLA_HASH });
    assert.equal(ok(cla.SIGN_PHRASE), true);
    assert.equal(ok(`  ${cla.SIGN_PHRASE}\r\n`), true, 'trim y saltos de línea se normalizan');
    assert.equal(ok(`${cla.SIGN_PHRASE}.`), false);
    assert.equal(ok(`Hola! ${cla.SIGN_PHRASE}`), false);
    assert.equal(ok(`${cla.SIGN_PHRASE}\nde nuevo`), false);
    assert.equal(ok('I have read the Intrale CLA'), false);
    assert.equal(ok(cla.SIGN_PHRASE.toLowerCase()), false);
    assert.equal(ok(null), false);
});

test('T9 firma con claHash viejo ⇒ no cuenta (re-firma)', () => {
    const r = cla.evaluate({ pr: pr(), commits: [commitBy(EXT_ID)], signatures: [sig(EXT_ID, OLD_HASH)], claHash: CLA_HASH });
    assert.equal(r.state, 'failure');
    assert.deepEqual(r.missing, [EXT_ID]);
});

test('T9b comentario anterior al último cambio del CLA o ya consumido ⇒ no se registra', () => {
    const comments = [
        { id: 10, user: { id: EXT_ID, login: 'ext' }, body: cla.SIGN_PHRASE, created_at: '2026-01-01T00:00:00Z' },
    ];
    const common = { required: [EXT_ID], claHash: CLA_HASH, claVersion: '1.0', prNumber: 5 };
    assert.equal(cla.findNewSignatures({ ...common, comments, signatures: [], claUpdatedAt: '2026-09-01T00:00:00Z' }).length, 0);
    const consumed = [{ ...sig(EXT_ID, OLD_HASH), comment_id: 10 }];
    assert.equal(cla.findNewSignatures({ ...common, comments, signatures: consumed, claUpdatedAt: '2025-01-01T00:00:00Z' }).length, 0);
    const fresh = cla.findNewSignatures({ ...common, comments, signatures: [], claUpdatedAt: '2025-01-01T00:00:00Z' });
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0].cla_hash, CLA_HASH);
});

test('T4b PR de MEMBER desde este repo con commits reales de agentes (author null, *@intrale) ⇒ success', () => {
    const r = cla.evaluate({
        pr: pr({ userId: OWNER_ID, assoc: 'MEMBER', headRepoId: BASE_REPO_ID }),
        commits: [agentCommit('backend-dev'), agentCommit('pipeline-dev')],
        signatures: [], claHash: CLA_HASH,
    });
    assert.equal(r.state, 'success');
    assert.equal(r.kind, 'internal');
    assert.deepEqual(r.required, []);
});

test('T4c commit de agente sin cuenta en PR externo ⇒ sigue exigiendo firma (fork o mismo repo)', () => {
    for (const headRepoId of [FORK_REPO_ID, BASE_REPO_ID]) {
        const r = cla.evaluate({
            pr: pr({ userId: EXT_ID, assoc: 'NONE', headRepoId }),
            commits: [commitBy(EXT_ID), agentCommit()],
            signatures: [sig(EXT_ID)], claHash: CLA_HASH,
        });
        assert.equal(r.state, 'failure', `headRepoId=${headRepoId}`);
        assert.deepEqual(r.missing, [cla.UNLINKED]);
    }
});

test('T4d PR interno desde un fork (o head sin repo) con commit sin cuenta ⇒ failure (fail-closed)', () => {
    for (const headRepoId of [FORK_REPO_ID, null]) {
        const r = cla.evaluate({
            pr: pr({ userId: OWNER_ID, assoc: 'OWNER', headRepoId }),
            commits: [commitBy(OWNER_ID), agentCommit()],
            signatures: [], claHash: CLA_HASH,
        });
        assert.equal(r.state, 'failure', `headRepoId=${headRepoId}`);
        assert.deepEqual(r.missing, [cla.UNLINKED]);
    }
    assert.equal(cla.isSameRepoHead({ head: { repo: { id: 1 } }, base: { repo: {} } }), false);
    assert.equal(cla.isSameRepoHead({}), false);
});

test('T4e PR interno desde este repo con un commit externo CON cuenta ⇒ sigue exigiendo su firma', () => {
    const r = cla.evaluate({
        pr: pr({ userId: OWNER_ID, assoc: 'OWNER', headRepoId: BASE_REPO_ID }),
        commits: [agentCommit(), commitBy(EXT2_ID)],
        signatures: [], claHash: CLA_HASH,
    });
    assert.equal(r.state, 'failure');
    assert.deepEqual(r.missing, [EXT2_ID]);
});

test('T10 commit con author null (sin cuenta vinculada) en PR desde fork ⇒ failure que ninguna firma destraba', () => {
    const r = cla.evaluate({
        pr: pr({ userId: OWNER_ID, assoc: 'OWNER' }), commits: [commitBy(OWNER_ID), commitBy(null)],
        signatures: [sig(EXT_ID)], claHash: CLA_HASH,
    });
    assert.equal(r.state, 'failure');
    assert.deepEqual(r.missing, [cla.UNLINKED]);
    // El centinela nunca puede firmar por comentario.
    assert.equal(cla.isValidSignature({ comment: { user: { id: cla.UNLINKED }, body: cla.SIGN_PHRASE }, requiredUserIds: [cla.UNLINKED], claHash: CLA_HASH }), false);
});

test('T11 entradas malformadas ⇒ failure (fail-closed)', () => {
    const cases = [
        {},
        { pr: null, commits: [], signatures: [], claHash: CLA_HASH },
        { pr: { user: { id: 'x' } }, commits: [commitBy(EXT_ID)], signatures: [], claHash: CLA_HASH },
        { pr: pr(), commits: null, signatures: [], claHash: CLA_HASH },
        { pr: pr(), commits: [], signatures: [], claHash: CLA_HASH },
        { pr: pr(), commits: [null], signatures: [], claHash: CLA_HASH },
        { pr: pr(), commits: [commitBy(EXT_ID)], signatures: null, claHash: CLA_HASH },
        { pr: pr(), commits: [commitBy(EXT_ID)], signatures: [sig(EXT_ID)], claHash: '' },
        { pr: pr({ userId: OWNER_ID, assoc: 'OWNER' }), commits: [commitBy(OWNER_ID)], signatures: [], claHash: 'nope' },
    ];
    for (const c of cases) assert.equal(cla.evaluate(c).state, 'failure', JSON.stringify(c));
    assert.equal(cla.evaluate({ pr: pr({ commits: 251 }), commits: [commitBy(EXT_ID)], signatures: [], claHash: CLA_HASH }).kind, 'too-many-commits');
    assert.throws(() => cla.parseSignatures('{"signatures": "x"}'));
    assert.throws(() => cla.parseSignatures('no-json'));
    assert.throws(() => cla.parseSignatures({ signatures: [{ user_id: 'x' }] }));
    assert.deepEqual(cla.parseSignatures(null).signatures, []);
});

test('getContributorMessage no incluye ningún input y las descripciones entran en 140 chars', () => {
    const a = cla.getContributorMessage(1);
    const b = cla.getContributorMessage('<script>alert(1)</script>');
    assert.equal(a, b, 'un input no numérico no altera el texto');
    assert.notEqual(cla.getContributorMessage(3), a);
    assert.ok(!cla.getContributorMessage(3).includes('3'), 'ni siquiera el número se ecoa');
    for (const [k, d] of Object.entries(cla.DESCRIPTIONS)) assert.ok(d.length <= 140, `${k}: ${d.length}`);
});

test('la frase de firma es idéntica en CLA.md y CONTRIBUTING.md, y el CLA declara versión y licencia', () => {
    const contributing = fs.readFileSync(nodePath.join(REPO_ROOT, 'CONTRIBUTING.md'), 'utf8');
    assert.ok(CLA_TEXT.includes('```\n' + cla.SIGN_PHRASE + '\n```') || CLA_TEXT.includes('```\r\n' + cla.SIGN_PHRASE + '\r\n```'));
    assert.ok(contributing.includes(cla.SIGN_PHRASE));
    assert.equal(cla.parseClaVersion(CLA_TEXT), '1.0');
    assert.match(CLA_TEXT, /propietaria/i);
    assert.match(CLA_TEXT, /sublicen/i);
    assert.match(CLA_TEXT, /Patent/);
    assert.match(contributing, /English summary/);
    assert.doesNotMatch(contributing, /\bPulpo\b|\bpipeline\b|#\d{3,}/i, 'sin jerga interna (G5)');
});

test('computeClaHash normaliza CRLF y rechaza texto vacío', () => {
    assert.equal(cla.computeClaHash('a\r\nb'), cla.computeClaHash('a\nb'));
    assert.throws(() => cla.computeClaHash(''));
    assert.throws(() => cla.computeClaHash(null));
});

// --- T12: YAML estático ------------------------------------------------------------

const yamlText = fs.readFileSync(WORKFLOW_PATH, 'utf8');

test('T12 workflow: pull_request_target, sin ref:, sin run:, sin ${{ github.event en scripts, actions por SHA', () => {
    const lines = yamlText.split(/\r?\n/).filter(l => !/^\s*#/.test(l));
    assert.ok(lines.some(l => /^\s*pull_request_target:/.test(l)), 'debe usar pull_request_target');
    assert.ok(!lines.some(l => /^\s*pull_request:/.test(l)), 'no debe usar pull_request (definición del PR)');
    assert.ok(!lines.some(l => /^\s*ref:/.test(l)), 'checkout sin ref: (CA-S2)');
    assert.ok(!/head\.(sha|ref)/.test(lines.join('\n')), 'sin head.sha/head.ref en el YAML');
    assert.ok(!lines.some(l => /^\s*-?\s*run:/.test(l)), 'sin bloques run: (CA-S5)');
    // Dentro de los bloques `script: |` no puede haber interpolación `${{`.
    let inScript = false; let indent = 0;
    for (const l of yamlText.split(/\r?\n/)) {
        const m = l.match(/^(\s*)script:\s*\|\s*$/);
        if (m) { inScript = true; indent = m[1].length; continue; }
        if (inScript) {
            if (l.trim() && l.match(/^(\s*)/)[1].length <= indent) inScript = false;
            else assert.ok(!l.includes('${{'), `interpolación en script: ${l}`);
        }
    }
    const uses = lines.filter(l => /^\s*(-\s*)?uses:/.test(l));
    assert.ok(uses.length >= 4);
    for (const u of uses) assert.match(u, /@[0-9a-f]{40}(\s|$)/, `action sin fijar por SHA: ${u.trim()}`);
    assert.match(yamlText, /^permissions:\s*\{\}\s*$/m, 'permissions: {} a nivel workflow');
    // contents: write sólo en record-signature.
    const code = lines.join('\n');
    const writeIdx = [...code.matchAll(/contents:\s*write/g)].map(m => m.index);
    assert.equal(writeIdx.length, 1, 'un único job con contents: write');
    assert.ok(writeIdx[0] > code.indexOf('record-signature:'), 'y es record-signature');
    // El checkout no deja el token persistido en el runner.
    assert.equal((code.match(/persist-credentials:\s*false/g) || []).length, 2);
});

// --- T13: contrato de sparse-checkout (#5680) ---------------------------------------

function parseSparseCheckouts(text) {
    const lines = text.split(/\r?\n/);
    const blocks = [];
    lines.forEach((l, i) => {
        if (!/^\s*sparse-checkout:\s*\|\s*$/.test(l)) return;
        const indent = l.match(/^(\s*)/)[1].length;
        const out = [];
        for (const line of lines.slice(i + 1)) {
            if (!line.trim()) continue;
            if (line.match(/^(\s*)/)[1].length <= indent) break;
            out.push(line.trim());
        }
        blocks.push(out);
    });
    return blocks;
}

test('T13 el módulo carga con SOLO los archivos del sparse-checkout de cada job (#5680)', () => {
    const blocks = parseSparseCheckouts(yamlText);
    assert.equal(blocks.length, 2, 'un sparse-checkout por job');
    assert.deepEqual(blocks[0], blocks[1], 'los dos jobs empaquetan lo mismo');
    const files = blocks[0];
    assert.ok(files.includes('docs/legal/CLA.md'));
    const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cla-pkg-'));
    try {
        for (const rel of files) {
            const src = nodePath.join(REPO_ROOT, rel);
            assert.ok(fs.existsSync(src), `el sparse-checkout lista un archivo inexistente: ${rel}`);
            const dst = nodePath.join(tmp, rel);
            fs.mkdirSync(nodePath.dirname(dst), { recursive: true });
            fs.copyFileSync(src, dst);
        }
        const isolated = require(nodePath.join(tmp, '.pipeline', 'lib', 'contribution-agreement.js'));
        assert.equal(typeof isolated.run, 'function');
        assert.equal(isolated.computeClaHash(fs.readFileSync(nodePath.join(tmp, 'docs', 'legal', 'CLA.md'), 'utf8')), CLA_HASH);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

// --- Orquestación run() con fake de Octokit ------------------------------------------

function fakeGithubClient({
    prData, commits = [], comments = [], signaturesFile = null, failOn = null, conflictsOnWrite = 0,
} = {}) {
    const calls = { statuses: [], created: [], updated: [], writes: [], refs: [] };
    let file = signaturesFile; // { content(json obj), sha }
    const err = (status, msg = 'boom') => Object.assign(new Error(msg), { status });
    const maybeFail = (name) => { if (failOn === name) throw err(500, `fallo simulado en ${name}`); };
    const listCommits = async () => { maybeFail('listCommits'); return commits; };
    const listComments = async () => { maybeFail('listComments'); return comments; };
    const github = {
        paginate: async (fn) => fn(),
        rest: {
            pulls: {
                get: async () => { maybeFail('pulls.get'); return { data: prData }; },
                listCommits,
            },
            issues: {
                listComments,
                createComment: async (p) => { calls.created.push(p); return { data: {} }; },
                updateComment: async (p) => { calls.updated.push(p); return { data: {} }; },
            },
            repos: {
                createCommitStatus: async (p) => { calls.statuses.push(p); return { data: {} }; },
                getContent: async () => {
                    maybeFail('getContent');
                    if (!file) throw err(404, 'Not Found');
                    return { data: { type: 'file', encoding: 'base64', sha: file.sha, content: Buffer.from(JSON.stringify(file.content)).toString('base64') } };
                },
                createOrUpdateFileContents: async (p) => {
                    if (conflictsOnWrite > 0) { conflictsOnWrite--; throw err(409, 'conflict'); }
                    calls.writes.push(p);
                    file = { sha: `s${calls.writes.length}`, content: JSON.parse(Buffer.from(p.content, 'base64').toString('utf8')) };
                    return { data: {} };
                },
                listCommits: async () => { maybeFail('claCommits'); return { data: [{ commit: { committer: { date: '2026-09-01T00:00:00Z' } } }] }; },
            },
            git: {
                createBlob: async (p) => { calls.blob = p; return { data: { sha: 'b1' } }; },
                createTree: async () => ({ data: { sha: 't1' } }),
                createCommit: async (p) => { calls.commit = p; return { data: { sha: 'k1' } }; },
                createRef: async (p) => {
                    calls.refs.push(p);
                    file = { sha: 'f1', content: JSON.parse(calls.blob.content) };
                    return { data: {} };
                },
            },
        },
    };
    return { github, calls, getFile: () => file };
}

const fakeCore = () => ({ info() {}, warning() {}, error() {}, logs: [] });
const HEAD = 'd'.repeat(40);
function prData(over = {}) {
    return { number: 42, state: 'open', commits: 1, head: { sha: HEAD }, base: { repo: { default_branch: 'main' } }, user: { id: EXT_ID }, author_association: 'NONE', ...over };
}
function ctx(eventName, payload) {
    return { eventName, payload, repo: { owner: 'intrale', repo: 'platform' } };
}
const prEvent = ctx('pull_request_target', { pull_request: { number: 42 } });
const lastStatus = (calls) => calls.statuses[calls.statuses.length - 1];

test('run: PR externo sin firma ⇒ pending, luego failure + un comentario', async () => {
    const f = fakeGithubClient({ prData: prData(), commits: [commitBy(EXT_ID)] });
    const out = await cla.run({ github: f.github, context: prEvent, core: fakeCore(), claText: CLA_TEXT });
    assert.equal(f.calls.statuses[0].state, 'pending');
    assert.equal(lastStatus(f.calls).state, 'failure');
    assert.equal(lastStatus(f.calls).context, cla.STATUS_CONTEXT);
    assert.equal(lastStatus(f.calls).sha, HEAD);
    assert.equal(f.calls.created.length, 1);
    assert.equal(out.record, false);
});

test('run: comentario del bot ya existente ⇒ no se duplica', async () => {
    const existing = { id: 77, user: { id: ACTIONS_BOT_ID }, body: cla.getContributorMessage(1) };
    const f = fakeGithubClient({ prData: prData(), commits: [commitBy(EXT_ID)], comments: [existing] });
    await cla.run({ github: f.github, context: prEvent, core: fakeCore(), claText: CLA_TEXT });
    assert.equal(f.calls.created.length, 0);
    assert.equal(f.calls.updated.length, 0);
});

test('run: un marker falso de un tercero no se toma como comentario del bot', async () => {
    const fake = { id: 78, user: { id: EXT_ID }, body: cla.COMMENT_MARKER + ' nada' };
    const f = fakeGithubClient({ prData: prData(), commits: [commitBy(EXT_ID)], comments: [fake] });
    await cla.run({ github: f.github, context: prEvent, core: fakeCore(), claText: CLA_TEXT });
    assert.equal(f.calls.created.length, 1);
});

test('run: PR de MEMBER desde este repo con commits reales de agentes ⇒ success sin comentario', async () => {
    const f = fakeGithubClient({
        prData: prData({
            user: { id: OWNER_ID }, author_association: 'MEMBER', commits: 2,
            head: { sha: HEAD, repo: { id: BASE_REPO_ID } }, base: { repo: { id: BASE_REPO_ID, default_branch: 'main' } },
        }),
        commits: [agentCommit('backend-dev'), agentCommit('pipeline-dev')],
    });
    const out = await cla.run({ github: f.github, context: prEvent, core: fakeCore(), claText: CLA_TEXT });
    assert.equal(out.state, 'success');
    assert.equal(out.kind, 'internal');
    assert.equal(lastStatus(f.calls).state, 'success');
    assert.equal(lastStatus(f.calls).description, cla.DESCRIPTIONS.internal);
    assert.equal(f.calls.created.length, 0);
});

test('run: PR interno ⇒ success sin comentario', async () => {
    const f = fakeGithubClient({ prData: prData({ user: { id: OWNER_ID }, author_association: 'OWNER' }), commits: [commitBy(OWNER_ID)] });
    await cla.run({ github: f.github, context: prEvent, core: fakeCore(), claText: CLA_TEXT });
    assert.equal(lastStatus(f.calls).state, 'success');
    assert.equal(lastStatus(f.calls).description, cla.DESCRIPTIONS.internal);
    assert.equal(f.calls.created.length, 0);
});

test('run: firma por comentario ⇒ evaluate delega, record registra (rama huérfana) y queda success', async () => {
    const signComment = { id: 500, user: { id: EXT_ID, login: 'ext' }, body: cla.SIGN_PHRASE, created_at: '2026-09-20T00:00:00Z' };
    const botComment = { id: 77, user: { id: ACTIONS_BOT_ID }, body: cla.getContributorMessage(1) };
    const event = ctx('issue_comment', { issue: { number: 42, pull_request: {} }, comment: signComment });
    const f = fakeGithubClient({ prData: prData(), commits: [commitBy(EXT_ID)], comments: [botComment, signComment] });

    const ev = await cla.run({ github: f.github, context: event, core: fakeCore(), claText: CLA_TEXT, mode: 'evaluate' });
    assert.equal(ev.record, true);
    assert.equal(lastStatus(f.calls).state, 'pending');
    assert.equal(f.calls.writes.length + f.calls.refs.length, 0, 'evaluate nunca escribe');

    const rec = await cla.run({ github: f.github, context: event, core: fakeCore(), claText: CLA_TEXT, mode: 'record' });
    assert.equal(rec.state, 'success');
    assert.equal(lastStatus(f.calls).state, 'success');
    assert.equal(f.calls.refs[0].ref, 'refs/heads/cla-signatures');
    assert.deepEqual(f.calls.commit.parents, [], 'rama huérfana');
    const saved = f.getFile().content.signatures;
    assert.equal(saved.length, 1);
    assert.deepEqual(Object.keys(saved[0]).sort(), ['cla_hash', 'cla_version', 'comment_id', 'login_at_signing', 'pr', 'signed_at', 'user_id']);
    assert.ok(!JSON.stringify(saved).includes('@'), 'sin emails (CA-S6)');
    assert.equal(f.calls.updated.length, 1, 'el comentario del bot pasa a "aceptado"');
    assert.ok(f.calls.updated[0].body.includes('✅'));
});

test('run: firma con registro existente y conflicto 409 ⇒ reintenta una vez', async () => {
    const signComment = { id: 501, user: { id: EXT_ID, login: 'ext' }, body: cla.SIGN_PHRASE, created_at: '2026-09-20T00:00:00Z' };
    const event = ctx('issue_comment', { issue: { number: 42, pull_request: {} }, comment: signComment });
    const f = fakeGithubClient({
        prData: prData(), commits: [commitBy(EXT_ID)], comments: [signComment],
        signaturesFile: { sha: 's0', content: { version: 1, signatures: [sig(EXT2_ID)] } }, conflictsOnWrite: 1,
    });
    const rec = await cla.run({ github: f.github, context: event, core: fakeCore(), claText: CLA_TEXT, mode: 'record' });
    assert.equal(rec.state, 'success');
    assert.equal(f.getFile().content.signatures.length, 2);
});

test('run: dos conflictos seguidos ⇒ failure (CA-S7)', async () => {
    const signComment = { id: 502, user: { id: EXT_ID, login: 'ext' }, body: cla.SIGN_PHRASE, created_at: '2026-09-20T00:00:00Z' };
    const event = ctx('issue_comment', { issue: { number: 42, pull_request: {} }, comment: signComment });
    const f = fakeGithubClient({
        prData: prData(), commits: [commitBy(EXT_ID)], comments: [signComment],
        signaturesFile: { sha: 's0', content: { version: 1, signatures: [] } }, conflictsOnWrite: 2,
    });
    const rec = await cla.run({ github: f.github, context: event, core: fakeCore(), claText: CLA_TEXT, mode: 'record' });
    assert.equal(rec.state, 'failure');
    assert.equal(lastStatus(f.calls).description, cla.DESCRIPTIONS.error);
});

test('T11 run: error de API simulado ⇒ status failure, nunca success', async () => {
    for (const failOn of ['listCommits', 'getContent', 'listComments', 'claCommits']) {
        const f = fakeGithubClient({ prData: prData(), commits: [commitBy(EXT_ID)], failOn });
        const out = await cla.run({ github: f.github, context: prEvent, core: fakeCore(), claText: CLA_TEXT });
        assert.equal(out.state, 'failure', failOn);
        assert.equal(lastStatus(f.calls).state, 'failure', failOn);
        assert.ok(!f.calls.statuses.some(s => s.state === 'success'), failOn);
    }
    // Registro malformado también es failure.
    const f = fakeGithubClient({ prData: prData(), commits: [commitBy(EXT_ID)], signaturesFile: { sha: 's', content: { signatures: 'x' } } });
    await cla.run({ github: f.github, context: prEvent, core: fakeCore(), claText: CLA_TEXT });
    assert.equal(lastStatus(f.calls).state, 'failure');
    // CLA ilegible ⇒ failure.
    const g = fakeGithubClient({ prData: prData({ user: { id: OWNER_ID }, author_association: 'OWNER' }), commits: [commitBy(OWNER_ID)] });
    await cla.run({ github: g.github, context: prEvent, core: fakeCore(), claText: '' });
    assert.equal(lastStatus(g.calls).state, 'failure');
});

test('run: comentario que no es la frase o en un issue ⇒ no-op sin tocar el status', async () => {
    const f = fakeGithubClient({ prData: prData(), commits: [commitBy(EXT_ID)] });
    const c1 = ctx('issue_comment', { issue: { number: 42, pull_request: {} }, comment: { body: 'LGTM' } });
    const c2 = ctx('issue_comment', { issue: { number: 42 }, comment: { body: cla.SIGN_PHRASE } });
    assert.equal((await cla.run({ github: f.github, context: c1, core: fakeCore(), claText: CLA_TEXT })).skipped, true);
    assert.equal((await cla.run({ github: f.github, context: c2, core: fakeCore(), claText: CLA_TEXT })).skipped, true);
    assert.equal(f.calls.statuses.length, 0);
});

test('run: commit nuevo tras firmar se re-evalúa sobre el nuevo head (commit de otro externo)', async () => {
    const f = fakeGithubClient({
        prData: prData({ commits: 2 }), commits: [commitBy(EXT_ID), commitBy(EXT2_ID)],
        signaturesFile: { sha: 's0', content: { version: 1, signatures: [sig(EXT_ID)] } },
    });
    const event = ctx('pull_request_target', { pull_request: { number: 42 } });
    await cla.run({ github: f.github, context: event, core: fakeCore(), claText: CLA_TEXT });
    assert.equal(lastStatus(f.calls).state, 'failure');
    assert.equal(lastStatus(f.calls).sha, HEAD);
});

test('run: más de 250 commits ⇒ failure con motivo estático', async () => {
    const f = fakeGithubClient({ prData: prData({ commits: 300 }), commits: [commitBy(EXT_ID)] });
    await cla.run({ github: f.github, context: prEvent, core: fakeCore(), claText: CLA_TEXT });
    assert.equal(lastStatus(f.calls).description, cla.DESCRIPTIONS.tooManyCommits);
});

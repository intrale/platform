// =============================================================================
// sherlock-independent-verifier.test.js — Suite Node para la recolección de
// evidencia independiente del Sherlock (#3846).
//
// Diseño: fakes inyectables (fsImpl, gitImpl, ghApi, processCheck) — cero red,
// cero filesystem real, cero shell-out. Cubre los 3 escenarios Gherkin del
// issue + CA-SEC-10 + fail-open + performance budget.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const iv = require('../sherlock-independent-verifier');
const sherlock = require('../sherlock-verifier');

// -----------------------------------------------------------------------------
// Helpers / fakes
// -----------------------------------------------------------------------------
function mkTmpPipelineDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlock-iv-'));
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    return dir;
}

// fsImpl falso basado en un mapa { absPath: contenido } + dirs.
function fakeFs({ files = {}, dirs = {} } = {}) {
    return {
        readFileSync(p) {
            if (Object.prototype.hasOwnProperty.call(files, p)) return files[p];
            const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err;
        },
        readdirSync(p) {
            if (Object.prototype.hasOwnProperty.call(dirs, p)) return dirs[p];
            const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err;
        },
    };
}

const gitOk = (stdout) => async () => ({ ok: true, stdout, code: 0 });
const gitFail = () => async () => ({ ok: false, stdout: '', code: 1 });
const ghOk = (stdout) => async () => ({ ok: true, stdout, code: 0 });

// =============================================================================
// CA-SEC-10 — normalización del issueNumber (no shell-out con input crudo).
// =============================================================================
test('CA-SEC-10: issueNumber no-numérico devuelve ok:false sin tocar git/gh', async () => {
    let gitCalled = false;
    let ghCalled = false;
    const res = await iv.collectIndependentEvidence({
        issueNumber: '3846; rm -rf /',
        pipelineDir: '/tmp/x',
        gitImpl: async () => { gitCalled = true; return { ok: true, stdout: '', code: 0 }; },
        ghApi: async () => { ghCalled = true; return { ok: true, stdout: '', code: 0 }; },
    });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'invalid_issue_number');
    assert.equal(gitCalled, false);
    assert.equal(ghCalled, false);
    assert.deepEqual(res.findings, []);
});

test('CA-SEC-10: _normalizeIssueNumber acepta enteros y rechaza basura', () => {
    assert.equal(iv._normalizeIssueNumber(3846), 3846);
    assert.equal(iv._normalizeIssueNumber('3846'), 3846);
    assert.equal(iv._normalizeIssueNumber('3846abc'), null);
    assert.equal(iv._normalizeIssueNumber(-1), null);
    assert.equal(iv._normalizeIssueNumber(0), null);
    assert.equal(iv._normalizeIssueNumber(3.5), null);
    assert.equal(iv._normalizeIssueNumber(null), null);
});

// =============================================================================
// ESCENARIO 1 — Entregable fantasma (#3722): systemState dice "procesado" pero
// el archivo NO está en main.
// =============================================================================
test('Escenario 1: git reporta rama NO contenida en origin/main (entregable fantasma)', async () => {
    let call = 0;
    const gitImpl = async ({ args }) => {
        call++;
        if (args.includes('--list') && args.some(a => a.includes('agent/3722-'))) {
            return { ok: true, stdout: '  agent/3722-backend-dev\n  remotes/origin/agent/3722-backend-dev\n', code: 0 };
        }
        // --contains <branch> --list *origin/main* → vacío = NO está en main
        return { ok: true, stdout: '', code: 0 };
    };
    const res = await iv.collectIndependentEvidence({
        issueNumber: 3722,
        pipelineDir: '/repo/.pipeline',
        gitImpl,
        enabledSources: ['git'],
    });
    assert.equal(res.ok, true);
    const f = res.findings.find(x => x.source === 'git');
    assert.equal(f.kind, 'branch_not_in_main');
    assert.match(f.summary, /NO está contenida en origin\/main/);
    assert.ok(res.sources.includes('git'));
});

test('Escenario 1 (filesystem): marca ausencia de archivo de fase en disco', async () => {
    const res = await iv.collectIndependentEvidence({
        issueNumber: 3722,
        pipelineDir: '/repo/.pipeline',
        fsImpl: fakeFs({ dirs: {} }), // ningún dir existe → ningún marker
        enabledSources: ['filesystem'],
    });
    const f = res.findings.find(x => x.source === 'filesystem');
    assert.equal(f.kind, 'phase_markers_absent');
    assert.match(f.summary, /NO existe ningún archivo de fase/);
});

test('Escenario 1 inverso: rama contenida en origin/main → branch_merged_to_main', async () => {
    const gitImpl = async ({ args }) => {
        if (args.includes('--contains')) {
            return { ok: true, stdout: '  remotes/origin/main\n', code: 0 };
        }
        return { ok: true, stdout: '  agent/3722-backend-dev\n', code: 0 };
    };
    const res = await iv.collectIndependentEvidence({
        issueNumber: 3722, pipelineDir: '/repo/.pipeline', gitImpl, enabledSources: ['git'],
    });
    const f = res.findings.find(x => x.source === 'git');
    assert.equal(f.kind, 'branch_merged_to_main');
});

// =============================================================================
// ESCENARIO 2 — Heartbeat zombi: el PID no existe.
// =============================================================================
test('Escenario 2: heartbeat apunta a PID muerto → heartbeat_pid_dead', async () => {
    const hbPath = path.join('/repo', '.claude', 'hooks', 'agent-3719.heartbeat');
    const res = await iv.collectIndependentEvidence({
        issueNumber: 3719,
        repoRoot: '/repo',
        pipelineDir: '/repo/.pipeline',
        fsImpl: fakeFs({ files: { [hbPath]: JSON.stringify({ pid: 12345, ts: 1 }) } }),
        processCheck: (pid) => false, // PID 12345 NO existe
        enabledSources: ['heartbeat'],
    });
    const f = res.findings.find(x => x.source === 'heartbeat');
    assert.equal(f.kind, 'heartbeat_pid_dead');
    assert.match(f.summary, /NO EXISTE \(heartbeat zombi\)/);
});

test('Escenario 2 inverso: heartbeat con PID vivo → heartbeat_pid_alive', async () => {
    const hbPath = path.join('/repo', '.claude', 'hooks', 'agent-3719.heartbeat');
    const res = await iv.collectIndependentEvidence({
        issueNumber: 3719,
        repoRoot: '/repo',
        pipelineDir: '/repo/.pipeline',
        fsImpl: fakeFs({ files: { [hbPath]: 'pid=999' } }),
        processCheck: (pid) => pid === 999,
        enabledSources: ['heartbeat'],
    });
    const f = res.findings.find(x => x.source === 'heartbeat');
    assert.equal(f.kind, 'heartbeat_pid_alive');
});

test('heartbeat ausente → heartbeat_absent', async () => {
    const res = await iv.collectIndependentEvidence({
        issueNumber: 3719,
        repoRoot: '/repo',
        pipelineDir: '/repo/.pipeline',
        fsImpl: fakeFs({ files: {} }),
        enabledSources: ['heartbeat'],
    });
    const f = res.findings.find(x => x.source === 'heartbeat');
    assert.equal(f.kind, 'heartbeat_absent');
});

test('_parsePid tolera JSON, kv y número suelto', () => {
    assert.equal(iv._parsePid('{"pid": 42}'), 42);
    assert.equal(iv._parsePid('pid=42'), 42);
    assert.equal(iv._parsePid('PID: 42'), 42);
    assert.equal(iv._parsePid('proceso 12345 vivo'), 12345);
    assert.equal(iv._parsePid('sin pid'), null);
});

// =============================================================================
// ESCENARIO 3 — github-api: PR reportado abierto vs mergeado.
// =============================================================================
test('Escenario 3: gh reporta PR no mergeado → pr_not_merged', async () => {
    const ghApi = async ({ args }) => {
        if (args[0] === 'issue') {
            return { ok: true, stdout: JSON.stringify({ state: 'OPEN', closed: false, title: 'X' }), code: 0 };
        }
        // pr list
        return { ok: true, stdout: JSON.stringify([{ number: 9, state: 'OPEN', headRefName: 'agent/3722-x', mergedAt: null }]), code: 0 };
    };
    const res = await iv.collectIndependentEvidence({
        issueNumber: 3722, pipelineDir: '/repo/.pipeline', ghApi, enabledSources: ['github-api'],
    });
    const issueF = res.findings.find(x => x.kind === 'issue_state');
    assert.match(issueF.summary, /estado OPEN/);
    const prF = res.findings.find(x => x.kind === 'pr_not_merged');
    assert.ok(prF, 'esperaba finding pr_not_merged');
});

test('github-api: PR mergeado → pr_merged', async () => {
    const ghApi = async ({ args }) => {
        if (args[0] === 'issue') return { ok: true, stdout: JSON.stringify({ state: 'CLOSED', closed: true }), code: 0 };
        return { ok: true, stdout: JSON.stringify([{ number: 9, state: 'MERGED', headRefName: 'x', mergedAt: '2026-06-01' }]), code: 0 };
    };
    const res = await iv.collectIndependentEvidence({
        issueNumber: 3722, pipelineDir: '/repo/.pipeline', ghApi, enabledSources: ['github-api'],
    });
    assert.ok(res.findings.find(x => x.kind === 'pr_merged'));
});

// =============================================================================
// ESCENARIO 3 (cont.) — fail-open: un source que falla NO bloquea ni rompe.
// =============================================================================
test('fail-open: git falla (repo corrupto) pero el collector devuelve ok con otros sources', async () => {
    const res = await iv.collectIndependentEvidence({
        issueNumber: 3846,
        pipelineDir: '/repo/.pipeline',
        repoRoot: '/repo',
        fsImpl: fakeFs({ files: {}, dirs: {} }),
        gitImpl: async () => { throw new Error('repo corrupto'); },
        ghApi: ghOk(JSON.stringify({ state: 'OPEN' })),
        processCheck: () => false,
    });
    assert.equal(res.ok, true);
    // git se intentó pero no aportó finding; github-api sí.
    assert.ok(res.sourcesChecked.includes('git'));
    assert.ok(!res.sources.includes('git'));
    assert.ok(res.sources.includes('github-api'));
});

test('fail-open total: git+gh fallan → ok:true, sin findings de esos sources, no lanza', async () => {
    const res = await iv.collectIndependentEvidence({
        issueNumber: 3846,
        pipelineDir: '/repo/.pipeline',
        repoRoot: '/repo',
        gitImpl: async () => { throw new Error('x'); },
        ghApi: async () => { throw new Error('x'); },
        enabledSources: ['git', 'github-api'],
    });
    assert.equal(res.ok, true);
    assert.deepEqual(res.findings, []);
    assert.ok(res.sourcesChecked.includes('git'));
    assert.ok(res.sourcesChecked.includes('github-api'));
    assert.equal(res.sources.length, 0);
});

// =============================================================================
// Performance — budget total respetado (no excede mucho el presupuesto).
// =============================================================================
test('performance: respeta totalBudgetMs y no llama sources tras agotarlo', async () => {
    let clock = 1000;
    const now = () => clock;
    let gitCalls = 0;
    const slowGit = async () => { clock += 500; gitCalls++; return { ok: true, stdout: '', code: 0 }; };
    const res = await iv.collectIndependentEvidence({
        issueNumber: 3846,
        pipelineDir: '/repo/.pipeline',
        repoRoot: '/repo',
        fsImpl: fakeFs({ dirs: {} }),
        gitImpl: slowGit,
        ghApi: async () => { clock += 300; return { ok: true, stdout: '', code: 0 }; },
        processCheck: () => false,
        now,
        totalBudgetMs: 500,
        perSourceBudgetMs: 200,
    });
    assert.equal(res.ok, true);
    // github-api NO debería correr: el budget ya estaba agotado tras git.
    assert.ok(!res.sourcesChecked.includes('github-api'), 'github-api corrió pese a budget agotado');
});

// =============================================================================
// CA-SEC-10 — cap de payload por finding.
// =============================================================================
test('CA-SEC-10: detalle se capea a MAX_FINDING_DETAIL_CHARS', () => {
    const big = 'x'.repeat(iv.MAX_FINDING_DETAIL_CHARS + 500);
    const capped = iv._capDetail(big);
    assert.ok(capped.length <= iv.MAX_FINDING_DETAIL_CHARS + 40);
    assert.match(capped, /\[truncado CA-SEC-10\]/);
});

// =============================================================================
// formatIndependentEvidence — render para el prompt.
// =============================================================================
test('formatIndependentEvidence: vacío si no hay findings', () => {
    assert.equal(iv.formatIndependentEvidence({ findings: [] }), '');
    assert.equal(iv.formatIndependentEvidence(null), '');
});

test('formatIndependentEvidence: lista findings con source/kind/summary', () => {
    const txt = iv.formatIndependentEvidence({
        sources: ['git', 'filesystem'],
        findings: [
            { source: 'git', kind: 'branch_not_in_main', summary: 'La rama no está en main.', detail: 'agent/3722-x' },
            { source: 'filesystem', kind: 'phase_markers_present', summary: 'Hay 1 marcador.', detail: null },
        ],
    });
    assert.match(txt, /Fuentes consultadas: git, filesystem/);
    assert.match(txt, /\[git\/branch_not_in_main\]/);
    assert.match(txt, /La rama no está en main/);
});

// =============================================================================
// Integración con buildFiscalPrompt — la sección se agrega solo si hay evidencia.
// =============================================================================
test('buildFiscalPrompt SIN independentEvidence = back-compat (sin sección)', () => {
    const prompt = sherlock._buildFiscalPrompt({
        analysis: 'A', originalRequest: 'O', systemState: 'S', lastHourLogs: 'L',
    });
    assert.doesNotMatch(prompt, /<independent_evidence>/);
    assert.match(prompt, /<system_state>/);
});

test('buildFiscalPrompt CON independentEvidence agrega sección XML + instrucciones reforzadas', () => {
    const prompt = sherlock._buildFiscalPrompt({
        analysis: 'A', originalRequest: 'O', systemState: 'S', lastHourLogs: 'L',
        independentEvidence: 'Hecho: la rama NO está en origin/main.',
    });
    assert.match(prompt, /<independent_evidence>/);
    assert.match(prompt, /<\/independent_evidence>/);
    assert.match(prompt, /la rama NO está en origin\/main/);
    // refuerzo: instrucción de detectar asunciones implícitas.
    assert.match(prompt, /ASUME/);
    assert.match(prompt, /PESA MÁS/);
});

// =============================================================================
// Integración con verify() — el collector se invoca y la evidencia llega al
// provider; el audit log registra el evento.
// =============================================================================
function fakeCompletionCapture(captureRef) {
    return {
        complete: async (opts) => {
            captureRef.prompt = opts.prompt;
            return {
                ok: true,
                content: JSON.stringify({
                    verdict: 'rechazado',
                    reason: 'entregable fantasma',
                    inconsistencies: [{ claim: 'está listo para merge', contradiction: 'no existe en origin/main' }],
                }),
                inputTokens: 10, outputTokens: 5,
            };
        },
    };
}

// Fakes de resolución de provider (mismo shape que sherlock-verifier.test.js).
function fakeQuotaAllPass() {
    return { shouldGateSpawn: () => false, sanitizeRawExcerpt: (s) => String(s || '') };
}
function fakeDispatcher(providerChain) {
    return {
        resolveSpawnWithFallback: ({ quotaModule, skill }) => {
            for (const p of providerChain) {
                if (!(quotaModule && quotaModule.shouldGateSpawn(skill, { provider: p.provider }))) {
                    return {
                        provider: p.provider, model: p.model, source: 'primary', gated: false,
                        fallbackUsed: null, primaryProvider: providerChain[0].provider,
                        chainTried: [p.provider], crossProvider: false, depthExceeded: false,
                    };
                }
            }
            return { provider: null, model: null, gated: true, source: 'all-gated', chainTried: [] };
        },
    };
}
function fakeResidencyOk() {
    return {
        loadExclusionsOrThrow: () => ({ exclusions: [], default_policy: 'allow' }),
        filterPathsForProvider: () => ({ blocked: [], allowed: [], policy: 'allow' }),
    };
}
const TEST_CHAIN = [{ provider: 'cerebras', model: 'llama-3.3-70b' }];

test('verify(): con issueNumber, inyecta independentEvidence al prompt y emite evento audit', async () => {
    const dir = mkTmpPipelineDir();
    const cap = {};
    const fakeIV = {
        collectIndependentEvidence: async () => ({
            ok: true,
            issueNumber: 3722,
            findings: [{ source: 'git', kind: 'branch_not_in_main', summary: 'La rama NO está en origin/main.', detail: null }],
            sources: ['git'],
            sourcesChecked: ['git'],
            durationMs: 12,
            error: null,
        }),
        formatIndependentEvidence: iv.formatIndependentEvidence,
    };
    const res = await sherlock.verify({
        analysis: 'el helper está listo para merge',
        originalRequest: '¿está #3722 hecho?',
        systemState: 'status: procesado',
        issueNumber: 3722,
        pipelineDir: dir,
        independentVerifier: fakeIV,
        completionClient: fakeCompletionCapture(cap),
        configLoader: () => ({ sherlock_enabled: true }),
        quotaModule: fakeQuotaAllPass(),
        dispatchModule: fakeDispatcher(TEST_CHAIN),
        residencyModule: fakeResidencyOk(),
    });
    // El prompt que vio el provider incluye la evidencia independiente.
    assert.match(cap.prompt || '', /<independent_evidence>/);
    assert.match(cap.prompt || '', /La rama NO está en origin\/main/);
    assert.equal(res.verdict, 'rechazado');

    // El audit log tiene el evento sherlock_independent_evidence_collected.
    const today = new Date();
    const stamp = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-${String(today.getUTCDate()).padStart(2, '0')}`;
    const auditFile = path.join(dir, 'logs', `commander-dispatch-${stamp}.jsonl`);
    let content = '';
    try { content = fs.readFileSync(auditFile, 'utf8'); } catch { /* maybe other date */ }
    if (!content) {
        // fallback: buscar cualquier jsonl en logs
        const files = fs.readdirSync(path.join(dir, 'logs')).filter(f => f.endsWith('.jsonl'));
        content = files.map(f => fs.readFileSync(path.join(dir, 'logs', f), 'utf8')).join('\n');
    }
    assert.match(content, /sherlock_independent_evidence_collected/);
});

test('verify(): SIN issueNumber NO corre el collector (back-compat puro)', async () => {
    const dir = mkTmpPipelineDir();
    const cap = {};
    let collectorCalled = false;
    const fakeIV = {
        collectIndependentEvidence: async () => { collectorCalled = true; return { ok: true, findings: [], sources: [], sourcesChecked: [], durationMs: 0 }; },
        formatIndependentEvidence: () => '',
    };
    await sherlock.verify({
        analysis: 'a', originalRequest: '?', systemState: 's',
        pipelineDir: dir,
        independentVerifier: fakeIV,
        completionClient: fakeCompletionCapture(cap),
        configLoader: () => ({ sherlock_enabled: true }),
        quotaModule: fakeQuotaAllPass(),
        dispatchModule: fakeDispatcher(TEST_CHAIN),
        residencyModule: fakeResidencyOk(),
    });
    assert.equal(collectorCalled, false);
    assert.doesNotMatch(cap.prompt || '', /<independent_evidence>/);
});

test('verify(): collector que lanza NO rompe la verificación (fail-open) y emite evento failed', async () => {
    const dir = mkTmpPipelineDir();
    const cap = {};
    const fakeIV = {
        collectIndependentEvidence: async () => { throw new Error('boom'); },
        formatIndependentEvidence: iv.formatIndependentEvidence,
    };
    const res = await sherlock.verify({
        analysis: 'a', originalRequest: '?', systemState: 's',
        issueNumber: 3846,
        pipelineDir: dir,
        independentVerifier: fakeIV,
        completionClient: fakeCompletionCapture(cap),
        configLoader: () => ({ sherlock_enabled: true }),
        quotaModule: fakeQuotaAllPass(),
        dispatchModule: fakeDispatcher(TEST_CHAIN),
        residencyModule: fakeResidencyOk(),
    });
    // La verificación igual devolvió un verdict válido.
    assert.ok(['ok', 'rechazado'].includes(res.verdict));
    assert.doesNotMatch(cap.prompt || '', /<independent_evidence>/);
});

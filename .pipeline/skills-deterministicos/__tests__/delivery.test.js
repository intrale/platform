// Tests unitarios de .pipeline/skills-deterministicos/delivery.js (issue #2484)
// No invocamos git ni gh: validamos parseArgs, marker I/O, hasQaGate y heartbeat
// con filesystem aislado.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-delivery-'));
fs.mkdirSync(path.join(TMP, '.claude', 'hooks'), { recursive: true });
fs.mkdirSync(path.join(TMP, '.pipeline', 'logs'), { recursive: true });
process.env.PIPELINE_REPO_ROOT = TMP;
process.env.CLAUDE_PROJECT_DIR = TMP;

delete require.cache[require.resolve('../delivery')];
const delivery = require('../delivery');

test('parseArgs — issue posicional + auto-merge por defecto', () => {
    const a = delivery.parseArgs(['node', 'delivery.js', '2484']);
    assert.equal(a.issue, 2484);
    assert.equal(a.autoMerge, true);
    assert.equal(a.dryRun, false);
});

test('parseArgs — --no-auto-merge desactiva auto-merge', () => {
    const a = delivery.parseArgs(['node', 'delivery.js', '1', '--no-auto-merge']);
    assert.equal(a.autoMerge, false);
});

test('parseArgs — --dry-run setea dryRun', () => {
    const a = delivery.parseArgs(['node', 'delivery.js', '1', '--dry-run']);
    assert.equal(a.dryRun, true);
});

test('parseArgs — --trabajando=<path>', () => {
    const a = delivery.parseArgs(['node', 'd.js', '1', '--trabajando=/tmp/x.delivery']);
    assert.equal(a.trabajando, '/tmp/x.delivery');
});

test('parseArgs — fallback PIPELINE_ISSUE', () => {
    const saved = process.env.PIPELINE_ISSUE;
    process.env.PIPELINE_ISSUE = '7777';
    try {
        const a = delivery.parseArgs(['node', 'd.js']);
        assert.equal(a.issue, 7777);
    } finally {
        if (saved === undefined) delete process.env.PIPELINE_ISSUE;
        else process.env.PIPELINE_ISSUE = saved;
    }
});

test('hasQaGate — true con qa:passed', () => {
    assert.equal(delivery.hasQaGate(['app:client', 'qa:passed']), true);
});

test('hasQaGate — true con qa:skipped', () => {
    assert.equal(delivery.hasQaGate(['tipo:infra', 'qa:skipped']), true);
});

test('hasQaGate — false sin label QA aprobado', () => {
    assert.equal(delivery.hasQaGate(['qa:pending', 'priority:high']), false);
    assert.equal(delivery.hasQaGate([]), false);
});

test('hasQaGate — qa:failed NO cuenta como gate', () => {
    assert.equal(delivery.hasQaGate(['qa:failed']), false);
});

test('readMarker — lee YAML simple key: "value"', () => {
    const f = path.join(TMP, '.pipeline', '2484.delivery');
    fs.writeFileSync(f, [
        'issue: 2484',
        'skill: "delivery"',
        'fase: "entrega"',
        'resultado: "pendiente"',
    ].join('\n') + '\n');
    const m = delivery.readMarker(f);
    assert.equal(m.issue, '2484');
    assert.equal(m.skill, 'delivery');
    assert.equal(m.fase, 'entrega');
    assert.equal(m.resultado, 'pendiente');
});

test('readMarker — archivo inexistente devuelve {}', () => {
    const m = delivery.readMarker(path.join(TMP, 'no-existe.delivery'));
    assert.deepEqual(m, {});
});

test('updateMarker — merge sin duplicar keys', () => {
    const f = path.join(TMP, '.pipeline', 'merge.delivery');
    fs.writeFileSync(f, 'issue: 2484\nresultado: "pendiente"\n');
    delivery.updateMarker(f, { resultado: 'aprobado', delivery_pr_number: 9999 });
    const txt = fs.readFileSync(f, 'utf8');
    // Una sola línea de resultado
    const matches = txt.match(/^resultado:/gm) || [];
    assert.equal(matches.length, 1);
    assert.match(txt, /resultado: "aprobado"/);
    assert.match(txt, /delivery_pr_number: 9999/);
});

test('updateMarker — ignora valores null/undefined', () => {
    const f = path.join(TMP, '.pipeline', 'nulls.delivery');
    fs.writeFileSync(f, 'issue: 1\n');
    delivery.updateMarker(f, { delivery_merge_sha: null, delivery_pr_number: 42 });
    const txt = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(txt, /delivery_merge_sha/);
    assert.match(txt, /delivery_pr_number: 42/);
});

test('startHeartbeat — crea y limpia archivo de heartbeat', () => {
    const issue = 12345;
    const hbFile = path.join(TMP, '.claude', 'hooks', `agent-${issue}.heartbeat`);
    const handle = delivery.startHeartbeat(issue);
    assert.equal(fs.existsSync(hbFile), true);
    const content = JSON.parse(fs.readFileSync(hbFile, 'utf8').trim());
    assert.equal(content.issue, issue);
    assert.equal(content.skill, 'delivery');
    assert.equal(content.model, 'deterministic');
    handle.stop();
    assert.equal(fs.existsSync(hbFile), false);
});

test('startHeartbeat — sin issue es no-op', () => {
    const handle = delivery.startHeartbeat(null);
    handle.stop(); // no debe tirar
    assert.ok(true);
});

test('QA_LABELS_OK — contiene exactamente passed y skipped', () => {
    assert.equal(delivery.QA_LABELS_OK.size, 2);
    assert.equal(delivery.QA_LABELS_OK.has('qa:passed'), true);
    assert.equal(delivery.QA_LABELS_OK.has('qa:skipped'), true);
});

// #2652 — CODEOWNERS humano: bloqueo de auto-merge cuando un PR toca paths
// protegidos por un owner humano. Estos tests verifican el contrato público
// (exports + integración con el módulo codeowners) sin invocar gh ni git.

test('exporta getPRChangedPaths y applyNeedsHumanLabel (#2652)', () => {
    assert.equal(typeof delivery.getPRChangedPaths, 'function');
    assert.equal(typeof delivery.applyNeedsHumanLabel, 'function');
});

test('integración codeowners — paths del pipeline gatillan owner humano (#2652)', () => {
    const codeowners = require('../lib/codeowners');
    const ghDir = path.join(TMP, '.github');
    fs.mkdirSync(ghDir, { recursive: true });
    fs.writeFileSync(path.join(ghDir, 'CODEOWNERS'), [
        '/.pipeline/   @leitolarreta',
        '/.github/   @leitolarreta',
    ].join('\n'));

    const rules = codeowners.loadCodeowners(TMP);
    assert.ok(rules.length >= 2, 'CODEOWNERS debe parsearse');

    const human = codeowners.getHumanOwners(rules, [
        '.pipeline/pulpo.js',
        'docs/readme.md',
    ]);
    assert.deepEqual(human, ['@leitolarreta']);

    const noHuman = codeowners.getHumanOwners(rules, ['app/composeApp/src/x.kt']);
    assert.deepEqual(noHuman, []);
});

// #2523 (rev-2) — separación REPO_ROOT vs WORK_DIR.
// Regresión del incidente: delivery del #2523 corrió con cwd=ROOT (porque
// `path.resolve(__dirname, '..', '..')` resuelve siempre al checkout principal,
// compartido por todos los worktrees vía .git symlink) y leyó la rama
// `fix/dashboard-pause-optimistic-ui` del ROOT en vez de
// `agent/2523-dashboard-visual-redesign` del worktree del agente.
// Mismo fix patrón que linter.js #2523 rev-1.

test('#2523 rev-2 — WORK_DIR usa PIPELINE_WORKTREE cuando está seteado', () => {
    const fakeWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-delivery-wt-'));
    const savedWt = process.env.PIPELINE_WORKTREE;
    process.env.PIPELINE_WORKTREE = fakeWorktree;
    try {
        delete require.cache[require.resolve('../delivery')];
        const reloaded = require('../delivery');
        assert.equal(reloaded.WORK_DIR, fakeWorktree,
            'WORK_DIR debe priorizar PIPELINE_WORKTREE sobre process.cwd() y REPO_ROOT');
        assert.notEqual(reloaded.WORK_DIR, reloaded.REPO_ROOT,
            'cuando el agente corre en worktree, WORK_DIR ≠ REPO_ROOT');
    } finally {
        if (savedWt === undefined) delete process.env.PIPELINE_WORKTREE;
        else process.env.PIPELINE_WORKTREE = savedWt;
        // Restaurar cache con el módulo en estado canónico para tests siguientes
        delete require.cache[require.resolve('../delivery')];
        require('../delivery');
    }
});

test('#2523 rev-2 — sin PIPELINE_WORKTREE, WORK_DIR cae a process.cwd() (no a REPO_ROOT)', () => {
    const fakeCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-delivery-cwd-'));
    const savedWt = process.env.PIPELINE_WORKTREE;
    const savedCwd = process.cwd();
    delete process.env.PIPELINE_WORKTREE;
    process.chdir(fakeCwd);
    try {
        delete require.cache[require.resolve('../delivery')];
        const reloaded = require('../delivery');
        // En Windows, process.cwd() puede normalizar drive letter case;
        // comparamos con realpath para evitar falsos negativos.
        const cwdReal = fs.realpathSync(fakeCwd);
        const workReal = fs.realpathSync(reloaded.WORK_DIR);
        assert.equal(workReal, cwdReal,
            'sin PIPELINE_WORKTREE, WORK_DIR debe usar process.cwd() — NO REPO_ROOT (que era el bug)');
        assert.notEqual(workReal, fs.realpathSync(reloaded.REPO_ROOT),
            'WORK_DIR no debe coincidir con REPO_ROOT cuando el cwd es distinto');
    } finally {
        process.chdir(savedCwd);
        if (savedWt !== undefined) process.env.PIPELINE_WORKTREE = savedWt;
        delete require.cache[require.resolve('../delivery')];
        require('../delivery');
    }
});

test('#2523 rev-2 — exporta REPO_ROOT y WORK_DIR para introspección', () => {
    assert.equal(typeof delivery.REPO_ROOT, 'string');
    assert.equal(typeof delivery.WORK_DIR, 'string');
    assert.ok(delivery.REPO_ROOT.length > 0);
    assert.ok(delivery.WORK_DIR.length > 0);
});

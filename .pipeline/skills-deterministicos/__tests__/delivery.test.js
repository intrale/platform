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

// #2551 — Validación del SAFE_IGNORE ampliado (CA-3) y de las defensas que el
// delivery introduce contra "rebase conflict: unstaged changes" en worktrees
// post-#2537. El SAFE_IGNORE de delivery.js es local del flow; replicamos el
// regex acá para verificar el contrato sin tener que exportarlo.

const SAFE_IGNORE_2551 = new RegExp(
    '^(?:' + [
        '\\.claude\\/hooks\\/agent-\\d+\\.heartbeat',
        '\\.claude\\/hooks\\/agent-registry\\.json',
        '\\.claude\\/hooks\\/activity-log',
        '\\.pipeline\\/metrics-history\\.jsonl',
        '\\.pipeline\\/.*\\.heartbeat',
        '\\.pipeline\\/logs\\/.*',
        '\\.pipeline\\/locks\\/.*',
        '\\.pipeline\\/ready\\/.*',
        '\\.pipeline\\/audit\\/.*',
        '\\.pipeline\\/audio\\/.*',
        '\\.pipeline\\/archivado\\/.*',
        '\\.pipeline\\/quota-snapshots\\/.*',
        'qa\\/evidence\\/.*',
        'lint-\\d+-report\\.(md|json)',
        '.*\\.stackdump',
    ].join('|') + ')',
);

test('#2551 CA-3 — SAFE_IGNORE captura outputs del linter (lint-N-report.{md,json})', () => {
    assert.equal(SAFE_IGNORE_2551.test('lint-1234-report.md'), true);
    assert.equal(SAFE_IGNORE_2551.test('lint-1234-report.json'), true);
    assert.equal(SAFE_IGNORE_2551.test('lint-99-report.md'), true);
});

test('#2551 CA-3 — SAFE_IGNORE captura .pipeline/logs/* y .pipeline/locks/*', () => {
    assert.equal(SAFE_IGNORE_2551.test('.pipeline/logs/2551-delivery.log'), true);
    assert.equal(SAFE_IGNORE_2551.test('.pipeline/logs/foo/bar.txt'), true);
    assert.equal(SAFE_IGNORE_2551.test('.pipeline/locks/delivery-2551.lock'), true);
});

test('#3922 — SAFE_IGNORE captura .pipeline/ready/*.ready (estado de runtime)', () => {
    // Causa raíz del rebote de #3922: delivery commiteó dashboard.ready (pid/puerto/
    // timestamps que el pipeline reescribe en cada arranque) y el rebase chocó contra main.
    assert.equal(SAFE_IGNORE_2551.test('.pipeline/ready/dashboard.ready'), true);
    assert.equal(SAFE_IGNORE_2551.test('.pipeline/ready/pulpo.ready'), true);
    assert.equal(SAFE_IGNORE_2551.test('.pipeline/ready/svc-telegram.ready'), true);
});

test('#2551 CA-3 — SAFE_IGNORE captura qa/evidence/*', () => {
    assert.equal(SAFE_IGNORE_2551.test('qa/evidence/2551/screenshot-1.png'), true);
    assert.equal(SAFE_IGNORE_2551.test('qa/evidence/video.webm'), true);
});

test('#2551 CA-3 — SAFE_IGNORE preserva paths inocuos (no falso positivo)', () => {
    assert.equal(SAFE_IGNORE_2551.test('app/composeApp/src/Main.kt'), false);
    assert.equal(SAFE_IGNORE_2551.test('.pipeline/skills-deterministicos/delivery.js'), false);
    assert.equal(SAFE_IGNORE_2551.test('docs/readme.md'), false);
    assert.equal(SAFE_IGNORE_2551.test('docs/qa/rejection-2551.md'), false);
});

// #3723 (rev-2) — Regresión: delivery fallaba al stagear archivos previamente
// tracked dentro de carpetas .gitignore-adas (.pipeline/audit/, .pipeline/audio/,
// .pipeline/quota-snapshots/, .pipeline/archivado/). El `git add -- <path>`
// devuelve exit 1 con mensaje "paths ignored by .gitignore" aunque el archivo
// esté tracked y la operación realmente quede aplicada. La defensa correcta
// es filtrarlos en SAFE_IGNORE para no pasarlos a git add.
test('#3723 — SAFE_IGNORE captura .pipeline/audit/*.jsonl (tracked previos al .gitignore #3707)', () => {
    assert.equal(SAFE_IGNORE_2551.test('.pipeline/audit/architect-tokens.jsonl'), true);
    assert.equal(SAFE_IGNORE_2551.test('.pipeline/audit/agent-models-notifications.jsonl'), true);
    assert.equal(SAFE_IGNORE_2551.test('.pipeline/audit/deliverable-notifications.jsonl'), true);
    assert.equal(SAFE_IGNORE_2551.test('.pipeline/audit/multi-provider-health.jsonl'), true);
    assert.equal(SAFE_IGNORE_2551.test('.pipeline/audit/partial-pause-mutations.jsonl'), true);
});

test('#3723 — SAFE_IGNORE captura otras carpetas .gitignore-adas del pipeline (audio, archivado, quota-snapshots)', () => {
    assert.equal(SAFE_IGNORE_2551.test('.pipeline/audio/notif-3723.ogg'), true);
    assert.equal(SAFE_IGNORE_2551.test('.pipeline/archivado/3723.reason.json'), true);
    assert.equal(SAFE_IGNORE_2551.test('.pipeline/quota-snapshots/2026-05-30.json'), true);
});

test('#3723 — SAFE_IGNORE NO captura paths legítimos del pipeline (skills, lib, roles)', () => {
    // Defensa contra over-matching: los paths legítimos del repo NO deben filtrarse.
    assert.equal(SAFE_IGNORE_2551.test('.pipeline/skills-deterministicos/delivery.js'), false);
    assert.equal(SAFE_IGNORE_2551.test('.pipeline/lib/handoff.js'), false);
    assert.equal(SAFE_IGNORE_2551.test('.pipeline/roles/delivery.md'), false);
    assert.equal(SAFE_IGNORE_2551.test('.pipeline/metrics/aggregator.js'), false);
    assert.equal(SAFE_IGNORE_2551.test('.pipeline/dashboard.js'), false);
});

test('#2551 CA-3 — SAFE_IGNORE preserva regla original (heartbeats, agent-registry, metrics)', () => {
    assert.equal(SAFE_IGNORE_2551.test('.claude/hooks/agent-2551.heartbeat'), true);
    assert.equal(SAFE_IGNORE_2551.test('.claude/hooks/agent-registry.json'), true);
    assert.equal(SAFE_IGNORE_2551.test('.pipeline/metrics-history.jsonl'), true);
});

// #2551 CA-S3 — Gates de seguridad NO modificados.
test('#2551 CA-S3 — hasQaGate sigue aceptando exactamente passed y skipped', () => {
    assert.equal(delivery.QA_LABELS_OK.size, 2);
    assert.equal(delivery.QA_LABELS_OK.has('qa:passed'), true);
    assert.equal(delivery.QA_LABELS_OK.has('qa:skipped'), true);
    assert.equal(delivery.QA_LABELS_OK.has('qa:pending'), false);
    assert.equal(delivery.QA_LABELS_OK.has('qa:failed'), false);
    assert.equal(delivery.hasQaGate(['qa:passed']), true);
    assert.equal(delivery.hasQaGate(['qa:skipped']), true);
    assert.equal(delivery.hasQaGate(['qa:failed']), false);
    assert.equal(delivery.hasQaGate(['qa:pending']), false);
    assert.equal(delivery.hasQaGate([]), false);
});

// #2551 CA-S1 — Redacción adversarial: fake-credentials.json + .env redactados.
test('#2551 CA-S1 — git-ops.redactSensitivePaths oculta credentials/.env en outputs visibles', () => {
    const git = require('../lib/git-ops');
    const input = [
        '?? fake-credentials.json',
        ' M .env.local',
        '?? .pipeline/logs/2551-delivery.log',
        ' M app/Main.kt',
    ].join('\n');
    const out = git.redactSensitivePaths(input);
    assert.ok(out.includes('<sensitive-path-redacted>'));
    assert.ok(!out.includes('fake-credentials.json'));
    assert.ok(!out.includes('.env.local'));
    assert.ok(out.includes('.pipeline/logs/2551-delivery.log'));
    assert.ok(out.includes('app/Main.kt'));
});

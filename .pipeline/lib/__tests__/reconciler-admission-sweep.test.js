// =============================================================================
// reconciler-admission-sweep.test.js — Integración del sweep de admision gate
// dentro de servicio-reconciler.js. Issue #3175.
//
// Estos tests NO golpean GitHub: mockean `listIssues`/`listPrs` via los hooks
// opcionales del `reconcileAdmissionOrphans` para validar:
//   - Modo silencioso cuando no hay huérfanos.
//   - Encola apply en cola de svc-github cuando hay huérfanos.
//   - Encola alerta Telegram cuando hay huérfanos.
//   - Aplica cap de bootstrap (>10).
//   - Respeta kill-switch ADMISSION_SWEEP_ENABLED=0.
//   - dry-run: NO aplica ni encola.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Setup tmpdir + env ANTES de require del reconciler (mismo patrón que
// servicio-reconciler.test.js para que las constantes PIPELINE/ROOT etc.
// resuelvan al sandbox).
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-admission-'));
fs.mkdirSync(path.join(TMP_DIR, '.pipeline', 'servicios', 'github', 'pendiente'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.pipeline', 'servicios', 'telegram', 'pendiente'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.pipeline', 'desarrollo', 'dev', 'pendiente'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.pipeline', 'desarrollo', 'validacion', 'bloqueado-humano'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, '.pipeline', 'definicion', 'analisis', 'bloqueado-humano'), { recursive: true });

process.env.CLAUDE_PROJECT_DIR = TMP_DIR;
process.env.PIPELINE_REPO_ROOT = TMP_DIR;
process.env.PIPELINE_STATE_DIR = path.join(TMP_DIR, '.pipeline');
process.env.PIPELINE_MAIN_ROOT = TMP_DIR;
process.env.ADMISSION_SWEEP_ENABLED = '1';
delete process.env.ADMISSION_GATE_DRY_RUN;

delete require.cache[require.resolve('../../servicio-reconciler')];
const reconciler = require('../../servicio-reconciler');

const GH_QUEUE = path.join(TMP_DIR, '.pipeline', 'servicios', 'github', 'pendiente');
const TG_QUEUE = path.join(TMP_DIR, '.pipeline', 'servicios', 'telegram', 'pendiente');

function clearGhQueue() {
    for (const f of fs.readdirSync(GH_QUEUE)) {
        try { fs.unlinkSync(path.join(GH_QUEUE, f)); } catch {}
    }
}
function clearTgQueue() {
    for (const f of fs.readdirSync(TG_QUEUE)) {
        try { fs.unlinkSync(path.join(TG_QUEUE, f)); } catch {}
    }
}
function listGhQueue() {
    return fs.readdirSync(GH_QUEUE)
        .filter(f => f.endsWith('.json'))
        .map(f => JSON.parse(fs.readFileSync(path.join(GH_QUEUE, f), 'utf8')));
}
function listTgQueue() {
    return fs.readdirSync(TG_QUEUE)
        .filter(f => f.endsWith('.json'))
        .map(f => JSON.parse(fs.readFileSync(path.join(TG_QUEUE, f), 'utf8')));
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

test('admission sweep: sin huérfanos → modo silencioso (no apply, no alerta)', () => {
    clearGhQueue(); clearTgQueue();
    const result = reconciler.reconcileAdmissionOrphans({
        listIssues: () => [
            { number: 1, labels: [{ name: 'Ready' }], title: 'a', url: 'u1' },
            { number: 2, labels: [{ name: 'needs-definition' }], title: 'b', url: 'u2' },
        ],
        listPrs: () => [],
    });
    assert.equal(result.appliedCount, 0);
    assert.equal(result.alertSent, false);
    assert.equal(listGhQueue().length, 0);
    assert.equal(listTgQueue().length, 0);
});

test('admission sweep: con huérfanos → encola apply + alerta Telegram', () => {
    clearGhQueue(); clearTgQueue();
    const result = reconciler.reconcileAdmissionOrphans({
        listIssues: () => [
            { number: 100, labels: [{ name: 'bug' }], title: 'huerfano 1', url: 'http://x/100' },
            { number: 101, labels: [], title: 'huerfano 2', url: 'http://x/101' },
            { number: 102, labels: [{ name: 'Ready' }], title: 'admitido', url: 'http://x/102' },
        ],
        listPrs: () => [],
    });
    assert.equal(result.appliedCount, 2);
    assert.equal(result.bootstrap, false);
    assert.equal(result.alertSent, true);

    const ghOps = listGhQueue();
    assert.equal(ghOps.length, 2);
    assert.equal(ghOps.every(o => o.action === 'label' && o.label === 'needs-definition'), true);
    const issueNums = ghOps.map(o => o.issue).sort();
    assert.deepEqual(issueNums, [100, 101]);

    const tgMsgs = listTgQueue();
    assert.equal(tgMsgs.length, 1);
    assert.equal(tgMsgs[0].parse_mode, 'Markdown');
    assert.ok(tgMsgs[0].text.startsWith('🟡 Admission gate'));
    assert.ok(tgMsgs[0].text.includes('[#100]'));
    assert.ok(tgMsgs[0].text.includes('[#101]'));
});

test('admission sweep: bootstrap >10 huérfanos usa cap + emoji 🔴', () => {
    clearGhQueue(); clearTgQueue();
    const fakeIssues = Array.from({ length: 23 }, (_, i) => ({
        number: 2000 + i,
        labels: [],
        title: `bulk ${i}`,
        url: `http://x/${2000 + i}`,
    }));
    const result = reconciler.reconcileAdmissionOrphans({
        listIssues: () => fakeIssues,
        listPrs: () => [],
    });
    assert.equal(result.appliedCount, 10);
    assert.equal(result.deferredCount, 13);
    assert.equal(result.bootstrap, true);
    assert.equal(result.alertSent, true);
    assert.equal(listGhQueue().length, 10);

    const tg = listTgQueue();
    assert.equal(tg.length, 1);
    assert.ok(tg[0].text.startsWith('🔴 Admission gate'));
    assert.ok(tg[0].text.includes('23 huérfanos preexistentes'));
    assert.ok(tg[0].text.includes('Acción REQUERIDA'));
});

test('admission sweep: dry-run NO aplica labels ni encola alertas', () => {
    clearGhQueue(); clearTgQueue();
    const result = reconciler.reconcileAdmissionOrphans({
        listIssues: () => [
            { number: 300, labels: [], title: 't', url: 'u' },
        ],
        listPrs: () => [],
        dryRun: true,
    });
    assert.equal(result.dryRun, true);
    assert.equal(result.appliedCount, 1); // cuenta lo que aplicaría
    assert.equal(result.alertSent, false); // pero NO se encola
    assert.equal(listGhQueue().length, 0);
    assert.equal(listTgQueue().length, 0);
});

test('admission sweep: PRs también se procesan', () => {
    clearGhQueue(); clearTgQueue();
    const result = reconciler.reconcileAdmissionOrphans({
        listIssues: () => [],
        listPrs: () => [
            { number: 400, labels: [], title: 'pr huerfano', url: 'http://x/pr/400' },
        ],
    });
    assert.equal(result.appliedCount, 1);
    const ghOps = listGhQueue();
    assert.equal(ghOps[0].issue, 400);
    assert.equal(ghOps[0].label, 'needs-definition');
});

test('admission sweep: ambas APIs fallan → skipped', () => {
    clearGhQueue(); clearTgQueue();
    const result = reconciler.reconcileAdmissionOrphans({
        listIssues: () => null,
        listPrs: () => null,
    });
    assert.equal(result.skipped, true);
    assert.ok(result.reason.includes('no respondió') || result.reason.includes('GitHub'));
    assert.equal(listGhQueue().length, 0);
    assert.equal(listTgQueue().length, 0);
});

test('admission sweep: kill-switch ADMISSION_SWEEP_ENABLED=0 cortocircuita', () => {
    clearGhQueue(); clearTgQueue();
    process.env.ADMISSION_SWEEP_ENABLED = '0';
    delete require.cache[require.resolve('../../servicio-reconciler')];
    const reconcilerOff = require('../../servicio-reconciler');
    const result = reconcilerOff.reconcileAdmissionOrphans({
        listIssues: () => [{ number: 999, labels: [], title: 'x', url: 'u' }],
        listPrs: () => [],
    });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'ADMISSION_SWEEP_ENABLED=0');
    assert.equal(listGhQueue().length, 0);
    assert.equal(listTgQueue().length, 0);

    // Restaurar para próximos tests
    process.env.ADMISSION_SWEEP_ENABLED = '1';
    delete require.cache[require.resolve('../../servicio-reconciler')];
});

test('admission sweep: alerta Telegram NO contiene body/user/diff (CA-S4)', () => {
    clearGhQueue(); clearTgQueue();
    const result = reconciler.reconcileAdmissionOrphans({
        listIssues: () => [
            {
                number: 555,
                labels: [],
                title: 'titulo ok',
                url: 'http://x/555',
                // estos campos venían de la API; filterOrphans los descarta antes
                body: 'secreto AKIAIOSFODNN7EXAMPLE',
                user: { login: 'attacker' },
                assignees: [{ login: 'attacker' }],
            },
        ],
        listPrs: () => [],
    });
    assert.equal(result.appliedCount, 1);
    const tg = listTgQueue();
    const text = tg[0].text;
    assert.equal(text.includes('AKIA'), false);
    assert.equal(text.includes('attacker'), false);
    assert.equal(text.includes('body'), false);
});

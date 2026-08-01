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
const resolver = require('../config-resolver');
const { seedProductManifest } = require('./_test-helpers');

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
    // #5172 · CA-5 — SIN volver a requerir el módulo: el valor efectivo se
    // resuelve por llamada, no en el load. Si esto fallara, el kill-switch sería
    // un valor de arranque y "cortar instantáneo" sería mentira.
    const result = reconciler.reconcileAdmissionOrphans({
        listIssues: () => [{ number: 999, labels: [], title: 'x', url: 'u' }],
        listPrs: () => [],
    });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'admission_gate.sweep_enabled=false');
    assert.equal(listGhQueue().length, 0);
    assert.equal(listTgQueue().length, 0);

    // Restaurar para próximos tests
    process.env.ADMISSION_SWEEP_ENABLED = '1';
});

// =============================================================================
// #5172 · CA-5 — El gate se decide por la config RESUELTA, no por process.env
// leído a mano. Antes del fix, `servicio-reconciler.js` leía las env vars
// directo en el load del módulo y el bloque `admission_gate:` de config.yaml no
// tenía NINGÚN consumidor de producción: apagar el gate era invisible en el
// archivo y no dejaba traza.
// =============================================================================

const CONFIG_PATH = path.join(TMP_DIR, '.pipeline', 'config.yaml');

function escribirConfigAdmission(seccion) {
    const cfg = [
        'pipelines:',
        '  desarrollo:',
        '    fases: [dev]',
        '    skills_por_fase:',
        '      dev: [pipeline-dev]',
        'admission_gate:',
        `  sweep_enabled: ${seccion.sweep_enabled}`,
        `  dry_run: ${seccion.dry_run}`,
        '',
    ].join('\n');
    fs.writeFileSync(CONFIG_PATH, cfg, 'utf8');
    // #5174 — el otro lado de la partición. La auto-partición mueve
    // `pipelines.*.skills_por_fase` al manifiesto, que es lado producto: sin
    // esto el fixture no valida y el test diría "falta una clave requerida" en
    // vez de ejercitar el gate de admisión.
    seedProductManifest(path.dirname(CONFIG_PATH));
}

function limpiarConfig() {
    try { fs.unlinkSync(CONFIG_PATH); } catch {}
    // Los dos archivos se van juntos: dejar el manifiesto huérfano haría que el
    // caso "config ausente" ejercitara una corrupción distinta de la que espera.
    try { fs.unlinkSync(resolver.productPathFor(path.dirname(CONFIG_PATH))); } catch {}
}

test('#5172 CA-5: sweep_enabled:false en config.yaml apaga el sweep (sin env var)', () => {
    clearGhQueue(); clearTgQueue();
    delete process.env.ADMISSION_SWEEP_ENABLED;
    escribirConfigAdmission({ sweep_enabled: false, dry_run: false });
    try {
        const result = reconciler.reconcileAdmissionOrphans({
            listIssues: () => [{ number: 999, labels: [], title: 'x', url: 'u' }],
            listPrs: () => [],
        });
        assert.equal(result.skipped, true);
        assert.equal(result.reason, 'admission_gate.sweep_enabled=false');
        assert.equal(listGhQueue().length, 0, 'no debe aplicar labels con el gate apagado por archivo');
    } finally {
        limpiarConfig();
        process.env.ADMISSION_SWEEP_ENABLED = '1';
    }
});

test('#5172 CA-5: dry_run:true en config.yaml no aplica ni encola (sin env var)', () => {
    clearGhQueue(); clearTgQueue();
    delete process.env.ADMISSION_GATE_DRY_RUN;
    escribirConfigAdmission({ sweep_enabled: true, dry_run: true });
    try {
        const result = reconciler.reconcileAdmissionOrphans({
            listIssues: () => [{ number: 999, labels: [], title: 'x', url: 'u' }],
            listPrs: () => [],
        });
        assert.equal(result.dryRun, true, 'el dry-run del archivo debe mandar');
        assert.equal(listGhQueue().length, 0, 'dry-run no aplica labels');
        assert.equal(listTgQueue().length, 0, 'dry-run no encola alertas');
    } finally {
        limpiarConfig();
    }
});

test('#5172 CA-5: la env var pisa al archivo y el valor efectivo se resuelve por llamada', () => {
    escribirConfigAdmission({ sweep_enabled: true, dry_run: false });
    try {
        process.env.ADMISSION_SWEEP_ENABLED = '0';
        assert.equal(reconciler.admissionGateSettings().sweepEnabled, false,
            'env=0 debe pisar el sweep_enabled:true del archivo');

        process.env.ADMISSION_SWEEP_ENABLED = '1';
        assert.equal(reconciler.admissionGateSettings().sweepEnabled, true,
            'sin re-require: el cambio de env se ve en la llamada siguiente');
        assert.equal(reconciler.admissionGateSettings().origen, 'config');
    } finally {
        limpiarConfig();
        process.env.ADMISSION_SWEEP_ENABLED = '1';
    }
});

test('#5172 CA-5: config ilegible NO apaga el gate en silencio', () => {
    fs.writeFileSync(CONFIG_PATH, 'pipelines: [[[\n  roto: : :\n', 'utf8');
    try {
        delete process.env.ADMISSION_SWEEP_ENABLED;
        const gate = reconciler.admissionGateSettings();
        // Degradar a "gate apagado" ante config rota es JUSTO el fallo silencioso
        // que #5172 elimina: el default del archivo (ON) se conserva.
        assert.equal(gate.sweepEnabled, true);
        assert.equal(gate.dryRun, false);
        assert.equal(gate.origen, 'defaults+env');

        // ...pero el override por env se sigue aplicando (y trazando) igual.
        process.env.ADMISSION_SWEEP_ENABLED = '0';
        assert.equal(reconciler.admissionGateSettings().sweepEnabled, false);
    } finally {
        limpiarConfig();
        process.env.ADMISSION_SWEEP_ENABLED = '1';
    }
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

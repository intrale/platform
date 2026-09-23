// Tests de measure-actions-billing.js (#7594) — sin red: fixtures inline.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const m = require('./measure-actions-billing.js');

const PRICING = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'docs', 'pipeline', 'evidence', '7594', 'pricing.json'), 'utf8'));

const T0 = Date.parse('2026-09-01T10:00:00Z');
function job(secs, opts = {}) {
    return {
        id: opts.id, name: opts.name || 'build', run_attempt: opts.run_attempt || 1,
        conclusion: opts.conclusion || 'success',
        labels: opts.labels || ['ubuntu-latest'],
        started_at: opts.started_at !== undefined ? opts.started_at : new Date(opts.start || T0).toISOString(),
        completed_at: opts.completed_at !== undefined ? opts.completed_at
            : new Date((opts.start || T0) + secs * 1000).toISOString(),
    };
}

// --- runnerMultiplier -------------------------------------------------------

test('runnerMultiplier devuelve 1 para ubuntu-latest', () => {
    assert.equal(m.runnerMultiplier(['ubuntu-latest']), 1);
});
test('runnerMultiplier devuelve 2 para windows-latest', () => {
    assert.equal(m.runnerMultiplier(['windows-latest']), 2);
});
test('runnerMultiplier devuelve 10 para macos-latest', () => {
    assert.equal(m.runnerMultiplier(['macos-latest']), 10);
});
test('runnerMultiplier con label desconocido devuelve 1 y runnerOs lo marca unknown', () => {
    assert.equal(m.runnerMultiplier(['self-hosted-gpu']), 1);
    assert.equal(m.runnerOs(['self-hosted-gpu']), 'unknown');
    assert.equal(m.runnerMultiplier(undefined), 1);
});

// --- billableMinutes --------------------------------------------------------

test('billableMinutes: 61 s en Linux son 2 minutos', () => {
    assert.equal(m.billableMinutes(job(61)), 2);
});
test('billableMinutes: 5 s en Linux es 1 minuto (mínimo por job)', () => {
    assert.equal(m.billableMinutes(job(5)), 1);
});
test('billableMinutes: job skipped es 0', () => {
    assert.equal(m.billableMinutes(job(300, { conclusion: 'skipped' })), 0);
});
test('billableMinutes: started_at nulo es 0', () => {
    assert.equal(m.billableMinutes(job(60, { started_at: null })), 0);
    assert.equal(m.billableMinutes(job(60, { completed_at: null })), 0);
});
test('billableMinutes: 61 s en Windows son 4 minutos', () => {
    assert.equal(m.billableMinutes(job(61, { labels: ['windows-latest'] })), 4);
});
test('billableMinutes: 30 s en macOS son 10 minutos', () => {
    assert.equal(m.billableMinutes(job(30, { labels: ['macos-latest'] })), 10);
});
test('jobRawSeconds ignora timestamps invertidos', () => {
    assert.equal(m.jobRawSeconds(job(0, { completed_at: '2026-09-01T09:00:00Z' })), 0);
});

// --- percentile -------------------------------------------------------------

test('percentile usa rango más cercano y lista vacía da 0', () => {
    assert.equal(m.percentile([], 50), 0);
    assert.equal(m.percentile([5, 1, 3, 2, 4], 50), 3);
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    assert.equal(m.percentile(hundred, 95), 95);
    assert.equal(m.percentile(hundred, 50), 50);
});

// --- aggregate --------------------------------------------------------------

test('aggregate suma por repo/workflow, incluye reintentos y calcula p50/p95', () => {
    const runs = [
        { repo: 'platform', workflow: 'Security SAST', run_attempt: 1, jobs: [job(61), job(5)] },               // 3
        { repo: 'platform', workflow: 'Security SAST', run_attempt: 2,
            jobs: [job(120, { run_attempt: 1 }), job(120, { run_attempt: 2 })] },                              // 4
        { repo: 'platform', workflow: 'Security SAST', run_attempt: 1, jobs: [job(600)] },                      // 10
        { repo: 'platform', workflow: 'Lint', run_attempt: 1, jobs: [job(10), job(0, { conclusion: 'skipped' })] }, // 1
        { repo: 'kernel', workflow: 'release', run_attempt: 1, jobs: [job(30, { labels: ['macos-latest'] })] },   // 10
    ];
    const agg = m.aggregate(runs);
    const sast = agg.repos.platform.workflows['Security SAST'];
    assert.equal(sast.runs, 3);
    assert.equal(sast.jobs, 5);
    assert.equal(sast.billable_min, 17);
    assert.equal(sast.retried_runs, 1);
    assert.equal(sast.p50_min, 4);
    assert.equal(sast.p95_min, 10);
    assert.equal(agg.repos.platform.workflows.Lint.jobs, 1, 'el job skipped no se cuenta');
    assert.equal(agg.repos.platform.totals.billable_min, 18);
    assert.equal(agg.repos.kernel.totals.billable_by_os.macos, 10);
    assert.equal(agg.totals.billable_min, 28);
    assert.ok(agg.totals.raw_min < agg.totals.billable_min, 'los crudos quedan por debajo de los redondeados');
});

test('aggregate cuenta runners desconocidos sin fallar', () => {
    const agg = m.aggregate([{ repo: 'r', workflow: 'w', jobs: [job(10, { labels: ['raro'] })] }]);
    assert.equal(agg.unknown_runner, 1);
    assert.equal(agg.totals.billable_by_os.linux, 1);
});

test('rankWorkflows ordena por costo y calcula el porcentaje', () => {
    const agg = m.aggregate([
        { repo: 'p', workflow: 'A', jobs: [job(59)] },
        { repo: 'p', workflow: 'B', jobs: [job(179)] },
    ]);
    const top = m.rankWorkflows(agg, 5);
    assert.deepEqual(top.map(r => r.workflow), ['B', 'A']);
    assert.equal(top[0].pct, 75);
});

// --- estimateOptimizations --------------------------------------------------

test('estimateOptimizations: schedule reemplaza los runs por uno diario del p50', () => {
    const runs = Array.from({ length: 10 }, (_, i) => ({ repo: 'p', id: i, workflow: 'SAST',
        jobs: [job(300, { id: i, name: 'OWASP' })] }));
    const [o] = m.estimateOptimizations(runs, [{ type: 'schedule', workflow: 'SAST', job: 'OWASP', runs_per_day: 1 }], { days: 2 });
    assert.equal(o.measured_min, 50);
    assert.equal(o.after_min, 10);
    assert.equal(o.saving_min, 40);
});

test('estimateOptimizations: concurrency trunca el run viejo cuando arranca uno nuevo de la misma rama', () => {
    const runs = [
        { repo: 'p', id: 1, workflow: 'SAST', head_branch: 'x', event: 'pull_request',
            created_at: new Date(T0).toISOString(), jobs: [job(600, { id: 1 })] },
        { repo: 'p', id: 2, workflow: 'SAST', head_branch: 'x', event: 'pull_request',
            created_at: new Date(T0 + 120000).toISOString(), jobs: [job(600, { id: 2, start: T0 + 120000 })] },
        { repo: 'p', id: 3, workflow: 'SAST', head_branch: 'y', event: 'pull_request',
            created_at: new Date(T0).toISOString(), jobs: [job(600, { id: 3 })] },
    ];
    const [o] = m.estimateOptimizations(runs, [{ type: 'concurrency', workflow: 'SAST' }]);
    assert.equal(o.measured_min, 30);
    assert.equal(o.after_min, 22); // 2 (truncado) + 10 + 10
    assert.equal(o.saving_min, 8);
});

test('estimateOptimizations: consolidate usa un solo redondeo por commit y no re-cuenta jobs consumidos', () => {
    const runs = ['L1', 'L2', 'L3'].map((wf, i) => ({ repo: 'p', id: 10 + i, workflow: wf, head_sha: 'abc',
        jobs: [job(10, { id: 10 + i })] }));
    const rules = [
        { type: 'consolidate', workflows: ['L1', 'L2', 'L3'] },
        { type: 'consolidate', workflows: ['L1'] },
        { type: 'desconocida' },
    ];
    const out = m.estimateOptimizations(runs, rules);
    assert.equal(out.length, 2, 'las reglas desconocidas se ignoran');
    assert.equal(out[0].measured_min, 3);
    assert.equal(out[0].after_min, 1);
    assert.equal(out[0].saving_min, 2);
    assert.equal(out[1].measured_min, 0, 'un job ya consumido no se vuelve a contar');
});

// --- projectScenarios -------------------------------------------------------

function fakeAgg(linuxMin, macosMin = 0) {
    return { totals: { billable_min: linuxMin + macosMin, billable_by_os: { linux: linuxMin, windows: 0, macos: macosMin } } };
}

test('projectScenarios devuelve los 4 escenarios con las mismas columnas', () => {
    const sc = m.projectScenarios(fakeAgg(10000), PRICING, { days: 30, active_committers: 1 });
    assert.deepEqual(sc.map(s => s.id), ['public', 'private_free', 'private_team', 'private_team_optimized']);
    const cols = ['billable_min', 'minutes_usd', 'storage_usd', 'seats_usd', 'ghas_usd', 'control_perdido', 'total_usd'];
    for (const s of sc) for (const c of cols) assert.ok(c in s, `${s.id} tiene ${c}`);
    assert.equal(sc[0].total_usd, 0);
});

test('projectScenarios: cada escenario privado trae costo de GHAS o control perdido no vacío', () => {
    const sc = m.projectScenarios(fakeAgg(10000), PRICING, { days: 30, active_committers: 2 });
    for (const s of sc.filter(x => x.id !== 'public')) {
        assert.ok(s.ghas_usd > 0 || s.control_perdido.length > 0, s.id);
    }
    assert.ok(sc.find(s => s.id === 'private_free').control_perdido.includes('Se pierde'));
    assert.equal(sc.find(s => s.id === 'private_team').ghas_usd, 2 * (19 + 30));
});

test('projectScenarios: excedente = max(0, minutos − incluidos) y normaliza la ventana a 30 días', () => {
    const [, free, team] = m.projectScenarios(fakeAgg(5000), PRICING, { days: 30 });
    assert.equal(free.excess_min, 3000);
    assert.equal(team.excess_min, 2000);
    assert.equal(free.minutes_usd, 18);           // 3000 × 0.006
    const [, small] = m.projectScenarios(fakeAgg(1000), PRICING, { days: 30 });
    assert.equal(small.excess_min, 0);
    assert.equal(small.minutes_usd, 0);
    const [, half] = m.projectScenarios(fakeAgg(2500), PRICING, { days: 15 });
    assert.equal(half.billable_min, 5000);
});

test('projectScenarios: el escenario optimizado descuenta el ahorro medido y storage/asientos se cotizan', () => {
    const sc = m.projectScenarios(fakeAgg(10000), PRICING, {
        days: 30, saving_min: 4000, active_committers: 1,
        storage: { artifacts_gb: 3, cache_gb_by_repo: { platform: 12, kernel: 1 } },
    });
    const team = sc.find(s => s.id === 'private_team');
    const opt = sc.find(s => s.id === 'private_team_optimized');
    assert.equal(opt.billable_min, 6000);
    assert.ok(opt.minutes_usd < team.minutes_usd);
    assert.equal(team.seats_usd, 8);
    assert.equal(team.storage_usd, 0.39);        // (3−2)×0.25 + (12−10)×0.07
    const free = sc.find(s => s.id === 'private_free');
    assert.ok(Math.abs(free.storage_usd - 0.765) <= 0.01); // (3−0.5)×0.25 + 0.14
});

test('projectScenarios cotiza macOS a la tarifa de su SKU', () => {
    const [, free] = m.projectScenarios(fakeAgg(0, 3000), PRICING, { days: 30 }); // 300 min reales de macOS
    // excedente 1000 de 3000 → 1/3 de 300 × 0.062
    assert.equal(free.minutes_usd, 6.2);
});

test('releaseRunCost cotiza un run de iOS (macOS ×10) y de desktop (Windows ×2)', () => {
    const ios = m.releaseRunCost([job(600, { labels: ['macos-latest'] }), job(0, { conclusion: 'skipped' })], PRICING);
    assert.equal(ios.billable_min, 100);
    assert.equal(ios.usd, 0.62);
    const win = m.releaseRunCost([job(61, { labels: ['windows-latest'] }), job(5, { labels: ['raro'] })], PRICING);
    assert.equal(win.billable_min, 5);
    assert.equal(win.usd, 0.03);
});

// --- helpers de CLI ---------------------------------------------------------

test('parseArgs toma defaults fuera del repo y parsea listas', () => {
    const o = m.parseArgs(['--repos', 'platform, kernel', '--days', '14', '--release-workflows', 'platform:a.yml']);
    assert.deepEqual(o.repos, ['platform', 'kernel']);
    assert.equal(o.days, 14);
    assert.deepEqual(o.releaseWorkflows, ['platform:a.yml']);
    assert.equal(m.isInside(o.raw, path.resolve(__dirname, '..')), false);
});

test('isInside detecta paths dentro del repo', () => {
    const root = path.resolve(__dirname, '..');
    assert.equal(m.isInside(path.join(root, 'x', 'raw'), root), true);
    assert.equal(m.isInside(path.resolve(root, '..', 'otro'), root), false);
});

test('windowDays devuelve N días completos terminando ayer', () => {
    const d = m.windowDays(3);
    assert.equal(d.length, 3);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    assert.equal(d[2], yesterday);
    assert.equal(m.monthly(15, 15), 30);
});

// --- Estructurales (RS-5) -----------------------------------------------------

test('el script no referencia stores de credenciales ni .env', () => {
    const src = fs.readFileSync(path.join(__dirname, 'measure-actions-billing.js'), 'utf8');
    const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    assert.ok(!/credentials/i.test(code), 'no menciona credentials');
    assert.ok(!/\.claude[\\/]secrets/.test(code), 'no lee ~/.claude/secrets');
    assert.ok(!/['"`]\.env/.test(code), 'no lee .env');
});

test('el script usa resolveGhBin, respeta el rate limit y no tiene precios hardcodeados', () => {
    const src = fs.readFileSync(path.join(__dirname, 'measure-actions-billing.js'), 'utf8');
    assert.match(src, /resolveGhBin\(\)/);
    assert.match(src, /rate_limit/);
    assert.ok(!/execFileSync\(\s*['"]gh['"]/.test(src), 'no invoca el literal gh');
    assert.ok(!/0\.006|0\.062|0\.010/.test(src), 'sin tarifas por minuto en el código');
});

test('ningún archivo nuevo del spike usa pull_request_target', () => {
    const files = [
        path.join(__dirname, 'measure-actions-billing.js'),
        path.join(__dirname, '..', 'docs', 'pipeline', 'evidence', '7594', 'pricing.json'),
    ];
    for (const f of files) assert.ok(!fs.readFileSync(f, 'utf8').includes('pull_request_target'), f);
});

test('countCommitters cuenta ids distintos e ignora vacíos (GHAS se cobra por committer activo)', () => {
    assert.equal(m.countCommitters(['leitolarreta', 'leitolarreta', 'bot@intrale', null, '']), 2);
    assert.equal(m.countCommitters([]), 0);
    assert.equal(m.countCommitters(undefined), 0);
});

test('activeCommitters pide los ids como JSON (tojson) para que lines() pueda parsearlos', () => {
    const src = fs.readFileSync(path.join(__dirname, 'measure-actions-billing.js'), 'utf8');
    assert.match(src, /\.commit\.author\.email\) \| tojson/);
});
